// The sheet an owner has — an HTML or SVG `<style>`, an HTML `<link>`, an `<?xml-stylesheet?>` — is a new one each time
// HTML says it obtains one: its style block updated (its children or their text changed, "update a style block"), the
// owner inserted or removed (it is then in another document, or none), and the attribute changes that select its
// resource. Each owner counts the sheets it has had (`NodeData::sheet_gen`); the bindings make the CSSOM sheet of the one
// it counts now, and one of a count before has no owner node (CSSOM: the old sheet is removed from the document), and
// its `@font-face` rules are new FontFaces. The tree changes are counted here, as the edges are written, by whatever path
// writes them; the attribute changes by the bindings' change steps (`renewSheet`).

use web_atoms::ns;

use crate::dom::{nid_arg, NodeData, NodeId, NodeKind, RealmArena};
use crate::token_list::{link_types, LINK_ALTERNATE, LINK_STYLESHEET};

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

// Whether `id` is an `<?xml-stylesheet?>` that associates a style sheet with its document (CSSOM §6.3.2, the
// xml-stylesheet processing instruction): one in the document's PROLOG — a child of it before its document element
// (Firefox; Chrome takes one after it too) — whose data is a list of pseudo-attributes (`pi_attributes`) with an `href`,
// no `type` or a CSS one, and a `title` where it says `alternate="yes"`.
pub(crate) fn associates_sheet(arena: &RealmArena, id: NodeId) -> bool {
    let Some(n) = arena.get(id).filter(|n| n.kind == NodeKind::ProcessingInstruction && is_sheet_owner(n)) else { return false };
    let Some(doc) = n.parent.and_then(|p| arena.get(p)).filter(|p| p.kind == NodeKind::Document) else { return false };
    let in_prolog = doc.children.iter().take_while(|&&c| arena.get(c).is_none_or(|c| c.kind != NodeKind::Element)).any(|&c| c == id);
    let Some(attrs) = pi_attributes(n).filter(|_| in_prolog) else { return false };
    let get = |name: &str| attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    get("type").is_none_or(|t| t.is_empty() || t.eq_ignore_ascii_case("text/css"))
        && get("href").is_some_and(|h| !h.is_empty())
        && (get("alternate") != Some("yes") || get("title").is_some_and(|t| !t.is_empty()))
}
// …its pseudo-attributes, by name.
fn pi_attributes(n: &NodeData) -> Option<Vec<(String, String)>> {
    let attrs = crate::character_data::pseudo_attributes(&n.data)?;
    Some(attrs.into_iter().map(|(k, v)| (String::from_utf16_lossy(&k), String::from_utf16_lossy(&v))).collect())
}

impl RealmArena {
    // The owner obtains a new sheet. (Quietly: which sheet it has is no input to a layout, nor to the memos `mutations`
    // keys — the style sheet sets', which it is, move on `sheet_epoch`.)
    // A `<style>`'s new sheet owes its `load` (HTML "update a style block": the critical subresources obtained, a load
    // task queued — for every update that makes one): a connected one is listed for the bindings to queue it.
    pub(crate) fn renew_sheet(&mut self, id: NodeId) -> bool {
        let Some(n) = self.get_mut_quietly(id).filter(|n| is_sheet_owner(n)) else { return false };
        n.sheet_gen = n.sheet_gen.wrapping_add(1);
        let style = &*n.local_name == "style";
        if style {
            n.element_flags &= !crate::element_flags::STYLE_LOAD_FIRED;
        }
        self.sheet_epoch += 1;
        self.note_sheet_added(id);
        if style && self.is_connected(id) && !self.style_loads_owed.contains(&id) {
            self.style_loads_owed.push(id);
            self.observers.note(crate::mutation_observers::STYLE_LOADS);
        }
        true
    }

    // The owner `id`'s new sheet is added to its document's (CSSOM "add a CSS style sheet"): one with a title that is no
    // alternate names the document's preferred set where it has none yet — the first such added, whatever its place.
    fn note_sheet_added(&mut self, id: NodeId) {
        let doc = self.root_of(id);
        if !self.is_connected(id) || self.get(doc).is_none_or(|d| d.kind != NodeKind::Document) || self.preferred_set(doc).is_some() {
            return;
        }
        if let Some((title, false)) = self.set_member(id).filter(|(title, _)| !title.is_empty()) {
            self.prefer_set(doc, &title);
        }
    }
    // The title and alternate flag the owner `id`'s sheet has where it is one a style sheet set can take: a `<style>` of
    // a CSS type, a `<link>` to a style sheet, an `<?xml-stylesheet?>` that associates one (by its pseudo-attributes).
    fn set_member(&self, id: NodeId) -> Option<(String, bool)> {
        let n = self.get(id)?;
        if n.kind == NodeKind::ProcessingInstruction {
            if !associates_sheet(self, id) {
                return None;
            }
            let attrs = pi_attributes(n)?;
            let get = |name: &str| attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
            return Some((get("title").unwrap_or_default(), get("alternate").as_deref() == Some("yes")));
        }
        let title = n.plain_attr("title").unwrap_or("").to_string();
        if &*n.local_name == "link" {
            let rel = link_types(n.plain_attr("rel").unwrap_or(""));
            let sheet = rel & LINK_STYLESHEET != 0 && n.plain_attr("href").is_some_and(|h| !h.is_empty()) && n.plain_attr("disabled").is_none();
            return sheet.then(|| (title, rel & LINK_ALTERNATE != 0));
        }
        style_is_css(n).then_some((title, false))
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

// The sheet the bindings made an owner (`ownerSheet`, dom.rs), in the store of the realm that made it (`realm`): its `id`,
// `rev`, which moves each time it is made again, whether a CSSStyleSheet shows it (`shown`, which makes the next one
// anew under another id: the object a script holds keeps the rules it had), and what it was made of — the string it
// was given (none for a `<style>`'s block, whose every change is a new count), its base URL, media list and the
// document's mode, at the owner's count of sheets (`NodeData::sheet_gen`). One per owner, whichever realm last made it;
// let go of with the owner, or as another realm makes its own.
#[derive(Clone)]
pub(crate) struct MadeSheet {
    pub(crate) realm: i32,
    pub(crate) id: u32,
    pub(crate) rev: u32,
    pub(crate) shown: bool,
    pub(crate) text: Option<v8::Global<v8::String>>,
    pub(crate) base: String,
    pub(crate) media: String,
    pub(crate) quirks: bool,
    pub(crate) count: u32,
}

impl RealmArena {
    // The owner `id`'s record let go of — the owner freed, or another realm making its own — and its sheet, in the store
    // of the realm that made it, unless a CSSStyleSheet still shows it: then with that (cssom.js `SHEET_DROPS`).
    pub(crate) fn forget_made_sheet(&mut self, id: NodeId) {
        let Some(made) = self.made_sheets.remove(&id) else { return };
        if !made.shown {
            if let Some(state) = self.realm_state_mut(made.realm) {
                state.sheets.drop_sheet(made.id);
            }
        }
    }
    // …those of owners freed with their realm, and those a realm made whose context began anew or went (its store with
    // it).
    pub(crate) fn forget_freed_made_sheets(&mut self) {
        let freed: Vec<NodeId> = self.made_sheets.keys().copied().filter(|&o| self.get(o).is_none()).collect();
        for owner in freed {
            self.forget_made_sheet(owner);
        }
    }
    pub(crate) fn forget_made_sheets_of(&mut self, cid: i32) {
        self.made_sheets.retain(|_, m| m.realm != cid);
    }
}

// Whether a fetched style sheet is one (HTML "process the linked resource" for `rel=stylesheet`, and CSS Cascade's
// `@import`): one whose Content-Type is `text/css` — or names no MIME type at all, which Chrome and Firefox both apply
// (Blink's `CanUseSheet` takes an empty type and `application/x-unknown-content-type`, what a missing header is
// sniffed as) — and in a quirks-mode document, whatever its type, one `same_origin` with the document. Any other is
// none: both refuse one ("not a supported stylesheet MIME type"), and applied, a page's `@import` answered with an
// HTML page cascaded that page's text as thousands of rules. With `X-Content-Type-Options: nosniff` (`nosniff`, the
// header's value) none but `text/css` is one, the quirks exception included (Fetch "should response to request be
// blocked due to nosniff?", destination `style`).
pub(crate) fn sheet_response_accepted(content_type: &str, nosniff: &str, quirks: bool, same_origin: impl FnOnce() -> bool) -> bool {
    if crate::fetch_rules::determine_nosniff(nosniff) {
        return !crate::fetch_rules::blocked_by_nosniff("style", content_type, nosniff);
    }
    let essence = crate::mime::extract(content_type).map(|m| m.essence).unwrap_or_default();
    matches!(essence.as_str(), "" | "text/css" | "application/x-unknown-content-type") || (quirks && same_origin())
}

// Whether a `<style>` holds a style sheet at all (HTML "update a style block"): its `type` absent, empty or an ASCII
// case-insensitive `text/css` — Chrome and Firefox both drop the sheet's rules on a switch to `text/plain`.
pub(crate) fn style_is_css(n: &NodeData) -> bool {
    n.plain_attr("type").is_none_or(|t| t.is_empty() || t.eq_ignore_ascii_case("text/css"))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "associatesSheet", associates_sheet_op, context_id);
    crate::dom::register(scope, ns, "styleIsCss", style_is_css_op, context_id);
    crate::dom::register(scope, ns, "sheetResponseAccepted", sheet_response_accepted_op, context_id);
    crate::dom::register(scope, ns, "sheetGen", sheet_gen_op, context_id);
    crate::dom::register(scope, ns, "takeStyleLoads", take_style_loads_op, context_id);
    crate::dom::register(scope, ns, "ownerSheetShown", owner_sheet_shown_op, context_id);
    crate::dom::register(scope, ns, "sheetSet", sheet_set_op, context_id);
    crate::dom::register(scope, ns, "cascadeRekey", cascade_rekey_op, context_id);
    crate::dom::register(scope, ns, "forgetCascadeKey", forget_cascade_key_op, context_id);
}


// What a document's cascade is made of, as the realm last handed it to its style engine (cascade.js `rebuildCascade`):
// the document, its style sheet sets (`SheetSet::key`), the viewport, its mode and its base URL (a sheet is made again
// under another base), and its adopted sheets — each one's id and version (a `replaceSync` makes it another sheet to the
// engine, of another version), a marker for one that contributes nothing (disabled, its media not matching). (…the
// viewport by its bits: a NaN is the same key again, not one that never matches itself)
#[derive(PartialEq)]
pub(crate) struct CascadeKey {
    doc: NodeId,
    sets: u64,
    viewport: [u64; 2],
    quirks: bool,
    base: String,
    adopted: Vec<u64>,
}

// __dom.cascadeRekey(docNid) -> where the document's cascade is made of other sheets than the realm last
// handed its style engine (`CascadeKey`, its adopted sheets the store's — dom.rs `AdoptedSheets`): the `<style>` / `<link>`
// elements whose sheets take part, in tree order (`sheetSet`'s), the realm's rule-set generation moved (`GEN_CASCADE`) —
// else null, nothing to hand it.
fn cascade_rekey_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let size = crate::viewport::here(scope, &args);
    let viewport = size.map(f64::to_bits);
    let cid = crate::dom::realm_id(scope, &args);
    // (…its adopted sheets: each that applies by its id and version — a `replace` makes it another sheet to the engine —
    // one that does not as a marker, so toggling `disabled` or a media change re-keys too)
    let adopted = {
        let d = crate::dom::dom(scope);
        let screen = crate::style::Screen { viewport: (size[0] as f32, size[1] as f32), touch: d.touch_input };
        let engine = d.styles.get(&cid);
        let arena: &crate::dom::RealmArena = d.arena.enter(cid);
        let mut key = Vec::new();
        for &id in arena.adopted_of(doc, cid) {
            match arena.sheets.get(id).filter(|_| crate::dom::sheet_applies_at(engine, arena, screen, id)) {
                Some(stored) => key.extend([u64::from(id), u64::from(stored.version)]),
                None => key.push(u64::MAX),
            }
        }
        key
    };
    let arena = crate::dom::realm(scope, cid);
    let set = arena.sheet_set(doc);
    let key = CascadeKey { doc, sets: set.key, viewport, quirks: arena.document_mode(Some(doc)).0, base: arena.document_base_url(doc), adopted };
    if arena.cascade_key.as_ref() == Some(&key) {
        return;
    }
    arena.cascade_key = Some(key);
    arena.generations.bump(crate::dom::GEN_CASCADE);
    rv.set(crate::dom::nodes_value(scope, cid, &set.taking_part));
}

// __dom.forgetCascadeKey() — what the realm's style engine was last handed forgotten: a new page's cascade is handed it
// whatever it is made of.
fn forget_cascade_key_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    crate::dom::realm(scope, cid).cascade_key = None;
}

// __dom.takeStyleLoads() -> the `<style>` elements owed a `load` since their sheets were made (`renew_sheet`), as
// `nodes_value` answers them — none any more.
fn take_style_loads_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let owed = std::mem::take(&mut crate::dom::dom(scope).arena.style_loads_owed);
    rv.set(crate::dom::nodes_value(scope, cid, &owed));
}

// __dom.sheetGen(nid) -> how many sheets the owner has had (`NodeData::sheet_gen`): its sheet is the one of this count.
fn sheet_gen_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(crate::dom::dom(scope).arena.get(id).map_or(0, |n| n.sheet_gen));
}

// __dom.associatesSheet(nid) -> whether the `<?xml-stylesheet?>` associates a style sheet with its document
// (`associates_sheet`).
fn associates_sheet_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(associates_sheet(&crate::dom::dom(scope).arena, id));
}

// __dom.styleIsCss(nid) -> `style_is_css` of the `<style>`.
fn style_is_css_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::dom(scope).arena.get(id).is_some_and(style_is_css));
}

// __dom.ownerSheetShown(nid): a CSSStyleSheet shows the owner's sheet (`MadeSheet::shown`).
fn owner_sheet_shown_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    if let Some(made) = crate::dom::realm(scope, cid).made_sheets.get_mut(&id).filter(|m| m.realm == cid) {
        made.shown = true;
    }
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
    // The owners that take part, in tree order — and those whose sheet the sets leave out.
    taking_part: Vec<NodeId>,
    left_out: Vec<NodeId>,
}

impl RealmArena {
    // Whether the sheet `owner` has is disabled: the one the bindings last made of it, where that is its sheet still.
    fn owner_sheet_disabled(&self, owner: NodeId) -> bool {
        let Some(&(sheet, count)) = self.owner_sheets.get(&owner) else { return false };
        self.get(owner).is_some_and(|n| n.sheet_gen == count) && self.sheets.disabled(sheet)
    }

    // The owner whose sheet the sheet `id` is, while it is — none for a constructed or an imported one, nor once the
    // owner obtained another.
    pub(crate) fn owner_of_sheet(&self, id: u32) -> Option<NodeId> {
        let owner = self.sheets.get(id).and_then(|s| s.owner)?;
        let &(sheet, count) = self.owner_sheets.get(&owner)?;
        (sheet == id && self.get(owner).is_some_and(|n| n.sheet_gen == count)).then_some(owner)
    }
    // …and whether a script unset the disabled flag of the sheet `owner` has (`StoredSheet::enabled`).
    fn owner_sheet_enabled(&self, owner: NodeId) -> bool {
        let Some(&(sheet, count)) = self.owner_sheets.get(&owner) else { return false };
        self.get(owner).is_some_and(|n| n.sheet_gen == count) && self.sheets.get(sheet).is_some_and(|s| s.enabled)
    }
    // …and whether `owner`'s sheet takes part in its document's style sheet sets (CSSOM's disabled flag, which "add a CSS
    // style sheet" sets for one outside the selected set and a script's `disabled` writes) — none where it is in no
    // document's tree (a shadow tree's sheets have no sets).
    pub(crate) fn owner_sheet_takes_part(&mut self, owner: NodeId) -> Option<bool> {
        let root = self.root_of(owner);
        if self.get(root).is_none_or(|r| r.kind != NodeKind::Document) {
            return None;
        }
        self.sheet_set(root);
        let &(sheet, _) = self.owner_sheets.get(&owner)?;
        self.sheets.get(sheet).map(|s| !s.set_excluded && !s.disabled)
    }

    // …kept until the tree or what else they turn on changes (the trees asked about bounded: a page's shadow roots).
    fn sheet_set(&mut self, root: NodeId) -> std::rc::Rc<SheetSet> {
        if let Some((mutations, epoch, set)) = self.sheet_sets.get(&root) {
            if *mutations == self.mutations && *epoch == self.sheet_epoch {
                return set.clone();
            }
        }
        let set = std::rc::Rc::new(self.make_sheet_set(root));
        // (…each owner's sheet told whether the sets take it — the disabled flag "add a CSS style sheet" sets, which the
        // sheet keeps once its owner lets it go, read or not while it had one)
        for (owners, excluded) in [(&set.taking_part, false), (&set.left_out, true)] {
            for &owner in owners {
                let Some(&(sheet, count)) = self.owner_sheets.get(&owner) else { continue };
                if self.get(owner).is_some_and(|n| n.sheet_gen == count) {
                    if let Some(stored) = self.sheets.stored_mut(sheet) {
                        stored.set_excluded = excluded;
                    }
                }
            }
        }
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
                if associates_sheet(self, id) {
                    owners.push(id);
                }
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
            if n.kind == NodeKind::ProcessingInstruction {
                // (…an `<?xml-stylesheet?>`'s by its pseudo-attributes, as a `<link>`'s by its attributes: a CSS `type`,
                // an `href`, `alternate="yes"`)
                let Some(attrs) = pi_attributes(n) else { continue };
                let get = |name: &str| attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
                let Some(href) = get("href") else { continue };
                let (title, media, alternate) = (title(get("title").as_deref()), get("media"), get("alternate").as_deref() == Some("yes"));
                if self.owner_sheet_disabled(owner) {
                    continue;
                }
                let enabled = self.explicitly_enabled.contains(&owner) || self.owner_sheet_enabled(owner);
                (2u8, owner, n.sheet_gen, &title, &href, &media, alternate, enabled).hash(&mut hasher);
                any_titled_or_alternate |= !title.is_empty() || alternate;
                if !title.is_empty() && !alternate && preferred.is_none() {
                    preferred = Some(title.clone());
                }
                sheets.push((owner, title, alternate, enabled));
            } else if link {
                let rel = link_types(n.plain_attr("rel").unwrap_or(""));
                if rel & LINK_STYLESHEET == 0 || n.plain_attr("href").is_none_or(str::is_empty) || n.plain_attr("disabled").is_some() {
                    continue;
                }
                let alternate = rel & LINK_ALTERNATE != 0;
                if shadow && alternate {
                    continue;
                }
                let (title, href, media) = (title(n.plain_attr("title")), n.plain_attr("href").unwrap_or("").to_string(), n.plain_attr("media").map(str::to_string));
                let count = n.sheet_gen;
                if self.owner_sheet_disabled(owner) {
                    continue;
                }
                let enabled = self.explicitly_enabled.contains(&owner) || self.owner_sheet_enabled(owner);
                (1u8, owner, count, &title, &href, &media, alternate, enabled).hash(&mut hasher);
                any_titled_or_alternate |= !title.is_empty() || alternate;
                if !title.is_empty() && !alternate && preferred.is_none() {
                    preferred = Some(title.clone());
                }
                sheets.push((owner, title, alternate, enabled));
            } else {
                if !style_is_css(n) {
                    continue;
                }
                let (title, media, count) = (title(n.plain_attr("title")), n.plain_attr("media").map(str::to_string), n.sheet_gen);
                if self.owner_sheet_disabled(owner) {
                    continue;
                }
                let enabled = self.explicitly_enabled.contains(&owner) || self.owner_sheet_enabled(owner);
                (0u8, owner, count, &title, &media, enabled).hash(&mut hasher);
                if !title.is_empty() {
                    any_titled_or_alternate = true;
                    preferred.get_or_insert_with(|| title.clone());
                }
                sheets.push((owner, title, false, enabled));
            }
        }
        // (…the selected set only where a titled or alternate sheet makes it matter: none decides nothing)
        // (…the preferred set the document's sheets named as they were added, before the first titled one in tree order: a
        // set inserted ahead of another is still the one preferred)
        let preferred = self.preferred_set(doc).map(str::to_owned).or(preferred);
        let selected = (any_titled_or_alternate && !shadow).then(|| default_style.or(preferred).unwrap_or_default());
        selected.hash(&mut hasher);
        let set = selected.as_deref().unwrap_or("");
        let (taking_part, left_out): (Vec<_>, Vec<_>) =
            sheets.into_iter().partition(|(_, title, alternate, enabled)| shadow || *enabled || if title.is_empty() { !alternate } else { title == set });
        let owners = |list: Vec<(NodeId, String, bool, bool)>| list.into_iter().map(|(owner, ..)| owner).collect();
        SheetSet { key: hasher.finish(), selected, taking_part: owners(taking_part), left_out: owners(left_out) }
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
// __dom.sheetResponseAccepted(contentType, nosniff, url, quirks) -> `sheet_response_accepted` of a response from `url` — of the
// calling realm's document's origin where it is same origin.
fn sheet_response_accepted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [content_type, nosniff, url] = [0, 1, 2].map(|i| args.get(i).to_rust_string_lossy(scope));
    let quirks = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let origin = crate::dom::realm(scope, cid).location.origin().to_owned();
    let accepted = sheet_response_accepted(&content_type, &nosniff, quirks, || ada_url::Url::parse(&url, None).is_ok_and(|u| u.origin() == origin));
    rv.set_bool(accepted);
}

#[cfg(test)]
mod tests {
    use super::sheet_response_accepted;

    // A fetched sheet is `text/css`, no type, the type a missing header is sniffed as, or a quirks document's
    // same-origin one — and under `nosniff`, `text/css` alone.
    #[test]
    fn a_style_sheet_is_one_by_its_type_and_nosniff_takes_text_css_alone() {
        assert!(sheet_response_accepted("text/css; charset=utf-8", "", false, || false));
        assert!(sheet_response_accepted("", "", false, || false) && sheet_response_accepted("text/plain", "", true, || true));
        assert!(!sheet_response_accepted("text/plain", "", false, || true));
        assert!(sheet_response_accepted("text/css", "nosniff", false, || false));
        assert!(!sheet_response_accepted("", "NoSniff", false, || false) && !sheet_response_accepted("text/plain", "nosniff, x", true, || true));
    }
}
