// The element lists the DOM names by a filter (DOM §4.2.6, HTML §3.1.3): `getElementsByClassName`, `getElementsByTagName`
// and its namespaced form, and the document's legacy collections (`forms`, `images`, `links`, `scripts`, `anchors`,
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
            Filter::Html(names, attr) => {
                n.ns == ns!(html) && names.contains(&&*n.local_name) && attr.is_none_or(|a| n.plain_attr(a).is_some())
            }
        }
    }
}

// The descendant elements of `scope` the filter takes, in tree order.
fn collect(arena: &RealmArena, scope: NodeId, filter: &Filter) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack: Vec<NodeId> = arena.get(scope).map_or(Vec::new(), |n| n.children.iter().rev().copied().collect());
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id) else { continue };
        if n.kind != NodeKind::Element {
            continue;
        }
        if filter.takes(n) {
            out.push(id);
        }
        stack.extend(n.children.iter().rev());
    }
    out
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "elementsBy", elements_by, context_id);
    crate::dom::register(scope, ns, "elementById", element_by_id, context_id);
}

// __dom.elementById(rootNid, id) -> `getElementById`: the first element in tree order, the root itself included, whose id
// is `id` (exactly, as UTF-16) — none or it, as `nodes_value` answers.
fn element_by_id(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let id = utf16_arg(scope, args.get(1));
    // (…the attribute as the arena holds it: UTF-16 where it has a lone surrogate, else its string — no copy per element)
    let matches = |node: &NodeData| match node.get_attr_u16("id") {
        Some(units) => units == &id[..],
        None => node.plain_attr("id").is_some_and(|v| v.encode_utf16().eq(id.iter().copied())),
    };
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let mut stack = vec![root];
    let mut found = None;
    while let Some(n) = stack.pop() {
        let Some(node) = arena.get(n) else { continue };
        if node.kind == NodeKind::Element && matches(node) {
            found = Some(n);
            break;
        }
        stack.extend(node.children.iter().rev());
    }
    let answer = crate::dom::nodes_value(scope, cid, root, found.as_slice());
    rv.set(answer);
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

// A string argument, or None for "*" (any).
fn name_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Option<String> {
    let s = v.to_rust_string_lossy(scope);
    (s != "*").then_some(s)
}

// __dom.elementsBy(scopeNid, kind, a, b) -> the scope's descendant elements a filter takes, as `nodes_value` answers: class names
// (`kind` 0: `a` the list, `b` quirks mode), a namespace and local name (1: `a` the namespace, null for none, `b` the
// local name; "*" any), a qualified name (2: `a`, "*" any; `b` an HTML document), or a legacy document collection
// (3 forms, 4 images, 5 links, 6 scripts, 7 anchors, 8 embeds).
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
        _ => return,
    };
    let cid = realm_id(scope, &args);
    let ids = collect(crate::dom::realm(scope, cid), root, &filter);
    let answer = crate::dom::nodes_value(scope, cid, root, &ids);
    rv.set(answer);
}
