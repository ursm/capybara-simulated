// The sheet an owner has — an HTML or SVG `<style>`, an HTML `<link>`, an `<?xml-stylesheet?>` — is a new one each time
// HTML says it obtains one: its style block updated (its children or their text changed, "update a style block"), the
// owner inserted or removed (it is then in another document, or none), and the attribute changes that select its
// resource. Each owner counts the sheets it has had (`NodeData::sheet_gen`); the bindings make the CSSOM sheet of the one
// it counts now, and one of a count before has no owner node (CSSOM: the old sheet is removed from the document), and
// its `@font-face` rules are new FontFaces. The tree changes are counted here, as the edges are written, by whatever path
// writes them; the attribute changes by the bindings' change steps (`renewSheet`).

use web_atoms::ns;

use crate::dom::{nid_arg, NodeData, NodeId, NodeKind, RealmArena};

// A node that owns a style sheet: an HTML or SVG `<style>`, an HTML `<link>` (the elements of the cascade's list of them,
// collections.rs `SheetOwners`), an `<?xml-stylesheet?>`.
pub(crate) fn is_sheet_owner(n: &NodeData) -> bool {
    match n.kind {
        NodeKind::Element => match &*n.local_name {
            "style" => n.ns == ns!(html) || n.ns == ns!(svg),
            "link" => n.ns == ns!(html),
            _ => false,
        },
        NodeKind::ProcessingInstruction => &*n.local_name == "xml-stylesheet",
        _ => false,
    }
}

impl RealmArena {
    // The owner obtains a new sheet. (Quietly: which sheet it has is no input to a layout, nor to the memos `mutations`
    // keys — the style sheet sets', which it is, move on `sheet_epoch`.)
    pub(crate) fn renew_sheet(&mut self, id: NodeId) -> bool {
        let Some(n) = self.get_mut_quietly(id).filter(|n| is_sheet_owner(n)) else { return false };
        n.sheet_gen = n.sheet_gen.wrapping_add(1);
        self.sheet_epoch += 1;
        true
    }

    // `nodes` were inserted into `parent` or removed from it: every owner among their shadow-including inclusive
    // descendants obtains a new sheet, and so does `parent`, a style element whose block changed.
    pub(crate) fn sheet_owners_moved(&mut self, parent: NodeId, nodes: &[NodeId]) {
        let mut renewed = self.style_block_changed(parent);
        let mut stack: Vec<NodeId> = nodes.to_vec();
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            stack.extend(n.children.iter().copied());
            stack.extend(n.shadow_root);
            renewed |= self.renew_sheet(id);
        }
        if renewed {
            self.sheet_renewals = self.sheet_renewals.wrapping_add(1);
        }
    }

    // `parent`'s children or their text changed: a style element's block is updated.
    pub(crate) fn style_block_changed(&mut self, parent: NodeId) -> bool {
        self.get(parent).is_some_and(|n| &*n.local_name == "style") && self.renew_sheet(parent)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "sheetGen", sheet_gen_op, context_id);
    crate::dom::register(scope, ns, "renewSheet", renew_sheet_op, context_id);
    crate::dom::register(scope, ns, "sheetOwned", sheet_owned_op, context_id);
    crate::dom::register(scope, ns, "sheetSet", sheet_set_op, context_id);
}

// __dom.sheetGen(nid) -> how many sheets the owner has had (`NodeData::sheet_gen`): its sheet is the one of this count.
fn sheet_gen_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(crate::dom::dom(scope).arena.get(id).map_or(0, |n| n.sheet_gen));
}

// __dom.renewSheet(nid, enabled): an attribute change of the owner's obtains it a new sheet — `enabled`, a `<link>`'s
// `disabled` removed, makes it explicitly enabled too.
fn renew_sheet_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let enabled = args.get(1).is_true();
    let arena = &mut crate::dom::dom(scope).arena;
    if arena.renew_sheet(id) && enabled {
        arena.explicitly_enabled.insert(id);
    }
}

// __dom.sheetOwned(nid, sheetId): the bindings made the owner's sheet (cascade.js `engineSheetOf`) — its sheet while the
// owner's count of sheets is the one it has now.
fn sheet_owned_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(id), Some(sheet)) = (nid_arg(scope, &args, 0), args.get(1).uint32_value(scope)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let Some(count) = arena.get(id).map(|n| n.sheet_gen) else { return };
    arena.owner_sheets.insert(id, (sheet, count));
    arena.sheet_epoch += 1;
}

// HTML's style sheet sets, for a document's `<style>` / `<link>` sheets: a sheet with a `title` belongs to the set of
// that name, and a `<link rel="alternate stylesheet">` is an alternate one; the selected set is the content of the last
// `<meta http-equiv="default-style">` that has one, else the preferred set — the title of the first titled sheet that
// is no alternate. A sheet takes part where it has no title and is no alternate (persistent), or its set is the selected
// one — a titleless alternate never — and a `<link>` explicitly enabled (its `disabled` removed) whatever its set.
// Before all that, a sheet takes part only where it is one: a `<style>` whose `type` is CSS, a `<link>` whose `rel` says
// `stylesheet` with an `href`, no `disabled` attribute — and neither's sheet disabled (CSSOM).
pub(crate) struct SheetSet {
    // A hash of everything the sheets' taking part turns on: which sheets there are and what each was made of (its count
    // of sheets, which a new block or an attribute change moves), their titles, media, alternate-ness, explicit
    // enabling, and the selected set — what the cascade is rebuilt on a change of.
    key: u64,
    selected: Option<String>,
    // The owners that take part, in tree order.
    taking_part: Vec<NodeId>,
}

impl RealmArena {
    // Whether the sheet `owner` has is disabled: the one the bindings last made of it, where that is its sheet still.
    fn owner_sheet_disabled(&self, owner: NodeId) -> bool {
        let Some(&(sheet, count)) = self.owner_sheets.get(&owner) else { return false };
        self.get(owner).is_some_and(|n| n.sheet_gen == count) && self.sheets.disabled(sheet)
    }

    // …kept until the tree or what else they turn on changes (the trees asked about bounded: a page's shadow roots).
    fn sheet_set(&mut self, root: NodeId) -> std::rc::Rc<SheetSet> {
        if let Some((mutations, epoch, set)) = self.sheet_sets.get(&root) {
            if *mutations == self.mutations && *epoch == self.sheet_epoch {
                return set.clone();
            }
        }
        let set = std::rc::Rc::new(self.make_sheet_set(root));
        if self.sheet_sets.len() >= 256 {
            self.sheet_sets.clear();
        }
        self.sheet_sets.insert(root, (self.mutations, self.sheet_epoch, set.clone()));
        set
    }

    // A shadow root's sheets have no sets — no `<meta>` selects one, every sheet takes part — and an alternate `<link>`
    // is none there.
    fn make_sheet_set(&self, doc: NodeId) -> SheetSet {
        let shadow = self.get(doc).is_some_and(|n| n.host.is_some());
        use std::hash::{Hash, Hasher};
        // (…a sheet's title its owner's `title` as written: CSSOM, Chrome — no whitespace trimmed)
        let title = |v: Option<&str>| v.unwrap_or("").to_string();
        // (…the owners and the `<meta>`s of the document's tree, in tree order — not in a shadow tree, nor a template's
        // contents)
        let (mut owners, mut default_style) = (Vec::new(), None);
        let mut stack: Vec<NodeId> = self.get(doc).map_or(Vec::new(), |n| n.children.iter().rev().copied().collect());
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.kind != NodeKind::Element {
                continue;
            }
            if is_sheet_owner(n) {
                owners.push(id);
            } else if n.is_html_named("meta") && n.plain_attr("http-equiv").is_some_and(|v| v.eq_ignore_ascii_case("default-style")) {
                if let Some(content) = n.plain_attr("content").filter(|c| !c.is_empty()) {
                    default_style = Some(content.to_string());
                }
            }
            stack.extend(n.children.iter().rev());
        }
        // (…each sheet that is one: whether a `<link>`, its title, whether an alternate, explicitly enabled)
        let mut sheets = Vec::new();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let (mut any_titled_or_alternate, mut preferred) = (false, None);
        for owner in owners {
            let Some(n) = self.get(owner) else { continue };
            let link = &*n.local_name == "link";
            if link {
                let rel = n.plain_attr("rel").unwrap_or("").to_ascii_lowercase();
                let rel: Vec<&str> = rel.split(|c: char| c.is_ascii_whitespace()).filter(|t| !t.is_empty()).collect();
                if !rel.contains(&"stylesheet") || n.plain_attr("href").is_none_or(str::is_empty) || n.plain_attr("disabled").is_some() {
                    continue;
                }
                let alternate = rel.contains(&"alternate");
                if shadow && alternate {
                    continue;
                }
                let (title, href, media) = (title(n.plain_attr("title")), n.plain_attr("href").unwrap_or("").to_string(), n.plain_attr("media").map(str::to_string));
                let count = n.sheet_gen;
                if self.owner_sheet_disabled(owner) {
                    continue;
                }
                let enabled = self.explicitly_enabled.contains(&owner);
                (1u8, owner, count, &title, &href, &media, alternate, enabled).hash(&mut hasher);
                any_titled_or_alternate |= !title.is_empty() || alternate;
                if !title.is_empty() && !alternate && preferred.is_none() {
                    preferred = Some(title.clone());
                }
                sheets.push((owner, title, alternate, enabled));
            } else {
                let css = n.plain_attr("type").is_none_or(|t| t.is_empty() || t.eq_ignore_ascii_case("text/css"));
                if !css {
                    continue;
                }
                let (title, media, count) = (title(n.plain_attr("title")), n.plain_attr("media").map(str::to_string), n.sheet_gen);
                if self.owner_sheet_disabled(owner) {
                    continue;
                }
                (0u8, owner, count, &title, &media).hash(&mut hasher);
                if !title.is_empty() {
                    any_titled_or_alternate = true;
                    preferred.get_or_insert_with(|| title.clone());
                }
                sheets.push((owner, title, false, false));
            }
        }
        // (…the selected set only where a titled or alternate sheet makes it matter: none decides nothing)
        let selected = (any_titled_or_alternate && !shadow).then(|| default_style.or(preferred).unwrap_or_default());
        selected.hash(&mut hasher);
        let set = selected.as_deref().unwrap_or("");
        let taking_part = sheets
            .into_iter()
            .filter(|(_, title, alternate, enabled)| shadow || *enabled || if title.is_empty() { !alternate } else { title == set })
            .map(|(owner, ..)| owner)
            .collect();
        SheetSet { key: hasher.finish(), selected, taking_part }
    }
}

// __dom.sheetSet(rootNid) -> [key, selectedSet, [owner, …]]: a document's style sheet sets, or a shadow root's sheets
// (`RealmArena::sheet_set`) — a number keying what the sheets' taking part turns on, the selected set ('' where none
// matters), and the `<style>` / `<link>` elements whose sheets take part, in tree order.
fn sheet_set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let set = crate::dom::realm(scope, cid).sheet_set(doc);
    // (…the key cut to what a JS number holds exactly)
    let key: v8::Local<v8::Value> = v8::Number::new(scope, (set.key >> 11) as f64).into();
    let selected: v8::Local<v8::Value> = v8::String::new(scope, set.selected.as_deref().unwrap_or("")).map_or_else(|| v8::undefined(scope).into(), Into::into);
    let owners = crate::dom::nodes_value(scope, cid, &set.taking_part);
    let items = [key, selected, owners];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
