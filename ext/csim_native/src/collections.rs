// The element lists the DOM names by a filter (DOM §4.2.6, HTML §3.1.3): `getElementsByClassName`, `getElementsByTagName`
// and its namespaced form, the document's `getElementsByName`, and its legacy collections (`forms`, `images`, `links`, `scripts`, `anchors`,
// `embeds`) — the scope's descendant elements in tree order (not into a shadow tree or a template's contents) that the
// filter takes, answered as `nodes_value` says (their objects, or their paths from the scope), which the live
// collections wrap.

use web_atoms::ns;

use crate::dom::{f64_array, nid_arg, realm_id, utf16_arg, NodeData, NodeId, NodeKind, RealmArena};

enum Filter {
    // Every class of the list (ASCII-lowercased, and so compared, in a quirks-mode document).
    Classes(Vec<Vec<u16>>, bool),
    // A namespace (None for any) and a local name (None for any), exactly.
    TagNs(Option<String>, Option<String>),
    // A qualified name (None for any) and, in an HTML document, its lowercase, which an HTML element's is compared with.
    Tag(Option<(String, Option<String>)>),
    // An HTML element whose `name` is this, exactly (as UTF-16).
    Name(Vec<u16>),
    // The legacy document collections: an HTML element of a local name, and an attribute it must hold.
    Html(&'static [&'static str], Option<&'static str>),
}

use crate::validity::is_ascii_ws_unit as ascii_whitespace;

fn ascii_lower(t: &[u16]) -> Vec<u16> {
    t.iter().map(|&u| if (0x41..=0x5a).contains(&u) { u + 0x20 } else { u }).collect()
}

impl Filter {
    fn takes(&self, n: &NodeData) -> bool {
        match self {
            Filter::Classes(wanted, quirks) => {
                let fold = |u: u16| if *quirks && (0x41..=0x5a).contains(&u) { u + 0x20 } else { u };
                let same = |token: &mut dyn Iterator<Item = u16>, w: &[u16]| token.map(fold).eq(w.iter().copied());
                // (…the attribute as the arena holds it: UTF-16 where it has a lone surrogate, else its string, unsplit
                // into copies)
                if let Some(units) = n.get_attr_u16("class") {
                    let tokens: Vec<&[u16]> = units.split(|&u| ascii_whitespace(u)).filter(|t| !t.is_empty()).collect();
                    return wanted.iter().all(|w| tokens.iter().any(|t| same(&mut t.iter().copied(), w)));
                }
                let Some(value) = n.plain_attr("class") else { return false };
                wanted.iter().all(|w| value.split_ascii_whitespace().any(|t| same(&mut t.encode_utf16(), w)))
            }
            Filter::TagNs(namespace, local) => {
                namespace.as_deref().is_none_or(|ns| &*n.ns == ns) && local.as_deref().is_none_or(|l| &*n.local_name == l)
            }
            Filter::Tag(name) => {
                let Some((name, lower)) = name else { return true };
                let want = match lower {
                    Some(l) if n.ns == ns!(html) => l,
                    _ => name,
                };
                match &n.prefix {
                    Some(p) => want.len() == p.len() + 1 + n.local_name.len() && want.starts_with(&**p) && want[p.len()..].starts_with(':') && want[p.len() + 1..] == *n.local_name,
                    None => *want == *n.local_name,
                }
            }
            Filter::Name(name) => n.ns == ns!(html) && n.plain_attr_is("name", name),
            Filter::Html(names, attr) => {
                n.ns == ns!(html) && names.contains(&&*n.local_name) && attr.is_none_or(|a| n.plain_attr(a).is_some())
            }
        }
    }
}

// The descendant elements of `scope` the filter takes, in tree order.
fn collect(arena: &RealmArena, scope: NodeId, filter: &Filter) -> Vec<NodeId> {
    let mut out = Vec::new();
    each_element(arena, scope, |id, n| {
        if filter.takes(n) {
            out.push(id);
        }
    });
    out
}

// Each descendant element of `scope` in tree order — not into a shadow tree or a template's contents.
fn each_element(arena: &RealmArena, scope: NodeId, mut visit: impl FnMut(NodeId, &NodeData)) {
    let mut stack: Vec<NodeId> = arena.get(scope).map_or(Vec::new(), |n| n.children.iter().rev().copied().collect());
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id) else { continue };
        if n.kind != NodeKind::Element {
            continue;
        }
        visit(id, n);
        stack.extend(n.children.iter().rev());
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "elementsBy", elements_by, context_id);
    crate::dom::register(scope, ns, "elementById", element_by_id, context_id);
    crate::dom::register(scope, ns, "documentNamed", document_named, context_id);
    crate::dom::register(scope, ns, "documentNames", document_names, context_id);
    crate::dom::register(scope, ns, "windowNamed", window_named, context_id);
}

// __dom.elementById(rootNid, id) -> `getElementById`: the first element in tree order, the root itself included, whose id
// is `id` (exactly, as UTF-16) — none or it, as `nodes_value` answers.
fn element_by_id(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let id = utf16_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let found = arena.element_by_id(root, &id);
    let answer = crate::dom::nodes_value(scope, cid, root, found.as_slice());
    rv.set(answer);
}

// __dom.documentNamed(docNid, name) -> the document's named elements with the name (`RealmArena::document_named`), as
// `nodes_value` answers.
fn document_named(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let name = utf16_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let found = crate::dom::realm(scope, cid).document_named(doc, &name);
    rv.set(crate::dom::nodes_value(scope, cid, doc, &found));
}

// __dom.documentNames(docNid) -> [name] — the document's supported property names (`RealmArena::document_names`).
fn document_names(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let names = crate::dom::realm(scope, cid).document_names(doc);
    let strings: Vec<v8::Local<'_, v8::Value>> = names
        .iter()
        .filter_map(|units| v8::String::new_from_two_byte(scope, units, v8::NewStringType::Normal).map(Into::into))
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &strings).into());
}

// __dom.windowNamed(docNid, name, kind) -> the named objects of the document's window with the name
// (`RealmArena::window_named`): kind 0 its navigables' containers, 1 its elements of the id alone, 2 all its elements.
fn window_named(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let name = utf16_arg(scope, args.get(1));
    let kind = args.get(2).int32_value(scope).unwrap_or(2);
    let cid = realm_id(scope, &args);
    let found = crate::dom::realm(scope, cid).window_named(doc, &name, kind);
    rv.set(crate::dom::nodes_value(scope, cid, doc, &found));
}

impl RealmArena {
    // The first element of `root`'s tree in tree order, `root` itself included, whose id is `id` (exactly, as UTF-16 —
    // a lone surrogate included).
    pub(crate) fn element_by_id(&self, root: NodeId, id: &[u16]) -> Option<NodeId> {
        self.elements_by_id(root, id).first().copied()
    }
    // …and every one, in tree order: from the tree's id map, made in one walk the first time it is asked after the arena
    // changed (`id_index`).
    pub(crate) fn elements_by_id(&self, root: NodeId, id: &[u16]) -> Vec<NodeId> {
        let mut memo = self.id_index.borrow_mut();
        if memo.0 != self.mutations {
            memo.1.clear();
            memo.0 = self.mutations;
        }
        let ids = memo.1.entry(root).or_insert_with(|| {
            let mut ids: std::collections::HashMap<Vec<u16>, Vec<NodeId>> = std::collections::HashMap::new();
            let mut stack = vec![root];
            while let Some(n) = stack.pop() {
                let Some(node) = self.get(n) else { continue };
                if node.kind == NodeKind::Element {
                    if let Some(units) = node.plain_attr_units("id") {
                        ids.entry(units).or_default().push(n);
                    }
                }
                stack.extend(node.children.iter().rev());
            }
            ids
        });
        ids.get(id).cloned().unwrap_or_default()
    }

    // HTML's named properties of a document (§3.1.6) and of its window (§7.2.2.3), over the document tree — not into a
    // shadow tree or a template's contents.
    //
    // An embed or object is "exposed" where no object or embed is its ancestor, as the structure tells it (which of a
    // plugin and the fallback content an object shows is not modelled).
    fn exposed(&self, id: NodeId) -> bool {
        let mut at = self.get(id).and_then(|n| n.parent);
        while let Some(n) = at.and_then(|p| self.get(p)).filter(|n| n.kind == NodeKind::Element) {
            if n.is_html_named("object") || n.is_html_named("embed") {
                return false;
            }
            at = n.parent;
        }
        true
    }
    // The names an element of a document is a named element with, its id's first: an embed, form, iframe, img or object
    // by its `name`, an object by its `id`, and an img by its `id` where it has a `name` too — an embed or object only
    // where it is exposed; none empty.
    fn document_names_of(&self, id: NodeId, n: &NodeData) -> [Option<Vec<u16>>; 2] {
        if n.ns != ns!(html) {
            return [None, None];
        }
        let nonempty = |v: Option<Vec<u16>>| v.filter(|v| !v.is_empty());
        let name = nonempty(n.plain_attr_units("name"));
        let (by_name, by_id) = match &*n.local_name {
            "form" | "iframe" => (true, false),
            "img" => (true, name.is_some()),
            "embed" => (self.exposed(id), false),
            "object" => {
                let exposed = self.exposed(id);
                (exposed, exposed)
            }
            _ => (false, false),
        };
        [nonempty(n.plain_attr_units("id")).filter(|_| by_id), name.filter(|_| by_name)]
    }
    // The document's named elements with the name `name`, in tree order.
    pub(crate) fn document_named(&self, doc: NodeId, name: &[u16]) -> Vec<NodeId> {
        let mut out = Vec::new();
        if name.is_empty() {
            return out;
        }
        each_element(self, doc, |id, n| {
            if self.document_names_of(id, n).iter().flatten().any(|v| v == name) {
                out.push(id);
            }
        });
        out
    }
    // The document's supported property names: each element's names in tree order, a later duplicate ignored.
    pub(crate) fn document_names(&self, doc: NodeId) -> Vec<Vec<u16>> {
        let (mut out, mut seen) = (Vec::new(), std::collections::HashSet::new());
        each_element(self, doc, |id, n| {
            for name in self.document_names_of(id, n).into_iter().flatten() {
                if seen.insert(name.clone()) {
                    out.push(name);
                }
            }
        });
        out
    }
    // The named objects of the document's window with the name `name`, in tree order — by `kind`: 0 the containers of
    // its child navigables whose target name it is (an iframe's or a frame's, the `name` its container gave it — one the
    // navigable gave itself is not modelled); 1 the elements whose id it is; 2 those and the embed, form, img and object
    // elements whose `name` it is.
    pub(crate) fn window_named(&self, doc: NodeId, name: &[u16], kind: i32) -> Vec<NodeId> {
        if name.is_empty() {
            return Vec::new();
        }
        if kind == 1 {
            return self.elements_by_id(doc, name);
        }
        let mut out = Vec::new();
        each_element(self, doc, |id, n| {
            let named = |tags: &[&str]| n.ns == ns!(html) && tags.contains(&&*n.local_name) && n.plain_attr_is("name", name);
            let takes = if kind == 0 {
                named(&["iframe", "frame"])
            } else {
                named(&["embed", "form", "img", "object"]) || n.plain_attr_is("id", name)
            };
            if takes {
                out.push(id);
            }
        });
        out
    }
}

const CLASSES: u32 = 0;
const TAG_NS: u32 = 1;
const TAG: u32 = 2;
const FORMS: u32 = 3;
const IMAGES: u32 = 4;
const LINKS: u32 = 5;
const SCRIPTS: u32 = 6;
const ANCHORS: u32 = 7;
const EMBEDS: u32 = 8;
const NAME: u32 = 9;

// A string argument, or None for "*" (any).
fn name_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Option<String> {
    let s = v.to_rust_string_lossy(scope);
    (s != "*").then_some(s)
}

// __dom.elementsBy(scopeNid, kind, a, b) -> the scope's descendant elements a filter takes, as `nodes_value` answers: class names
// (`kind` 0: `a` the list, `b` quirks mode), a namespace and local name (1: `a` the namespace, null for none, `b` the
// local name; "*" any), a qualified name (2: `a`, "*" any; `b` an HTML document), a legacy document collection
// (3 forms, 4 images, 5 links, 6 scripts, 7 anchors, 8 embeds), or a `name` (9: `a`).
fn elements_by(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let kind = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let (a, b) = (args.get(2), args.get(3));
    let filter = match kind {
        CLASSES => {
            let quirks = b.is_true();
            let list = utf16_arg(scope, a);
            let wanted: Vec<Vec<u16>> = list
                .split(|&u| ascii_whitespace(u))
                .filter(|t| !t.is_empty())
                .map(|t| if quirks { ascii_lower(t) } else { t.to_vec() })
                .collect();
            if wanted.is_empty() {
                return rv.set(f64_array(scope, &[]).into());
            }
            Filter::Classes(wanted, quirks)
        }
        TAG_NS => {
            let namespace = if a.is_null_or_undefined() { Some(String::new()) } else { name_arg(scope, a) };
            Filter::TagNs(namespace, name_arg(scope, b))
        }
        TAG => {
            let html_doc = b.is_true();
            Filter::Tag(name_arg(scope, a).map(|n| {
                let lower = html_doc.then(|| n.to_ascii_lowercase());
                (n, lower)
            }))
        }
        FORMS => Filter::Html(&["form"], None),
        IMAGES => Filter::Html(&["img"], None),
        LINKS => Filter::Html(&["a", "area"], Some("href")),
        SCRIPTS => Filter::Html(&["script"], None),
        ANCHORS => Filter::Html(&["a"], Some("name")),
        EMBEDS => Filter::Html(&["embed"], None),
        NAME => Filter::Name(utf16_arg(scope, a)),
        _ => return,
    };
    let cid = realm_id(scope, &args);
    let ids = collect(crate::dom::realm(scope, cid), root, &filter);
    let answer = crate::dom::nodes_value(scope, cid, root, &ids);
    rv.set(answer);
}
