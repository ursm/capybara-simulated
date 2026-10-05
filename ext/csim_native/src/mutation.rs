// The DOM's tree mutation algorithms (DOM §4.2.3), as far as the engine runs them: what makes an insertion or a
// replacement valid — the "ensure pre-insertion validity" steps and the replace algorithm's checks — over the arena's
// trees. The insertion itself, and the callbacks it runs (mutation records, custom element reactions, the removing and
// insertion steps), stay with the page side for now.

use crate::dom::{nid_arg, realm_id, NodeId, NodeKind, RealmArena};

// DOM node types, as the page side names them.
const ELEMENT: u32 = 1;
const TEXT: u32 = 3;
const CDATA: u32 = 4;
const PI: u32 = 7;
const COMMENT: u32 = 8;
const DOCUMENT: u32 = 9;
const DOCTYPE: u32 = 10;
const FRAGMENT: u32 = 11;

// Why an insertion is refused — the page side's exception and message for each.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
enum Refusal {
    // HierarchyRequestError: the parent is no Document, DocumentFragment or Element…
    ParentKind = 1,
    // …the node is a host-including inclusive ancestor of the parent…
    Ancestor = 2,
    // NotFoundError: the reference child is no child of the parent.
    NotAChild = 3,
    // HierarchyRequestError: the node is no DocumentFragment, DocumentType, Element or CharacterData…
    NodeKind = 4,
    // …a Text node into a Document, a doctype into anything else…
    Placement = 5,
    // …a fragment with more than one element, or a Text node, into a Document…
    FragmentContent = 6,
    // …an element (alone, or a fragment's) where the Document has one, or before its doctype…
    ElementPlacement = 7,
    // …a doctype where the Document has one, or after its element.
    DoctypePlacement = 8,
    // `moveBefore`: HierarchyRequestError — node and parent in different shadow-including trees…
    MoveTree = 9,
    // …a node no Element or CharacterData…
    MoveKind = 10,
    // …a Text node into a Document…
    MoveText = 11,
    // …an element where the Document has another.
    MoveElement = 12,
}

// Whether `node` is a host-including inclusive ancestor of `of`: its inclusive ancestor, or one of the host of the
// fragment its root is — a shadow root's host, a template's contents' template — and so on up.
fn host_including_ancestor(arena: &RealmArena, node: NodeId, of: NodeId) -> bool {
    let mut cur = Some(of);
    while let Some(n) = cur {
        if n == node {
            return true;
        }
        let data = arena.get(n);
        cur = arena.parent_of(n).or_else(|| data.and_then(|d| d.host.or(d.template_host)));
    }
    false
}

// The children of `parent` before (`after` false) or after `child`.
fn siblings(arena: &RealmArena, parent: NodeId, child: NodeId, after: bool) -> Vec<NodeId> {
    let Some(p) = arena.get(parent) else { return Vec::new() };
    let Some(i) = p.children.iter().position(|&c| c == child) else { return Vec::new() };
    if after { p.children[i + 1..].to_vec() } else { p.children[..i].to_vec() }
}

fn kind(arena: &RealmArena, id: NodeId) -> Option<NodeKind> {
    arena.get(id).map(|n| n.kind)
}

// DOM "ensure pre-insertion validity" of `node` (of node type `node_type`) into `parent` (of `parent_type`) before
// `child` — or, `replace`, the replace algorithm's checks of `node` for `child`. A node with no slot (an Attr) is in no
// tree: no ancestor of anything, refused for its kind, in the steps' order.
fn refusal(
    arena: &RealmArena,
    node: Option<NodeId>,
    node_type: u32,
    parent: NodeId,
    parent_type: u32,
    child: Option<Option<NodeId>>,
    replace: bool,
) -> Option<Refusal> {
    if !matches!(parent_type, DOCUMENT | FRAGMENT | ELEMENT) {
        return Some(Refusal::ParentKind);
    }
    if node.is_some_and(|node| host_including_ancestor(arena, node, parent)) {
        return Some(Refusal::Ancestor);
    }
    // (…a child given that is no node of the arena — an Attr — is no child of anything)
    if child.is_some_and(|c| c.is_none_or(|c| arena.parent_of(c) != Some(parent))) {
        return Some(Refusal::NotAChild);
    }
    let child = child.flatten();
    if !matches!(node_type, FRAGMENT | DOCTYPE | ELEMENT | TEXT | CDATA | COMMENT | PI) {
        return Some(Refusal::NodeKind);
    }
    if (matches!(node_type, TEXT | CDATA) && parent_type == DOCUMENT) || (node_type == DOCTYPE && parent_type != DOCUMENT) {
        return Some(Refusal::Placement);
    }
    if parent_type != DOCUMENT {
        return None;
    }
    // (…a Document holds at most one element and one doctype, the doctype first; a replacement's old child counts not)
    let kids: &[NodeId] = arena.get(parent).map_or(&[], |p| &p.children);
    let except = if replace { child } else { None };
    let has = |k: NodeKind| kids.iter().any(|&c| Some(c) != except && kind(arena, c) == Some(k));
    // (…a document's children of kind Other are its doctype)
    let (has_element, has_doctype) = (has(NodeKind::Element), has(NodeKind::Other));
    let child_is_doctype = !replace && child.is_some_and(|c| kind(arena, c) == Some(NodeKind::Other));
    let doctype_after = child.is_some_and(|c| siblings(arena, parent, c, true).iter().any(|&s| kind(arena, s) == Some(NodeKind::Other)));
    let element_placement = |has_element: bool| has_element || child_is_doctype || doctype_after;
    match node_type {
        FRAGMENT => {
            let content: Vec<NodeKind> = node.and_then(|n| arena.get(n)).map_or(Vec::new(), |n| n.children.iter().filter_map(|&c| kind(arena, c)).collect());
            let elements = content.iter().filter(|&&k| k == NodeKind::Element).count();
            if elements > 1 || content.contains(&NodeKind::Text) {
                return Some(Refusal::FragmentContent);
            }
            (elements == 1 && element_placement(has_element)).then_some(Refusal::ElementPlacement)
        }
        ELEMENT => element_placement(has_element).then_some(Refusal::ElementPlacement),
        DOCTYPE => {
            let element_before = match child {
                Some(c) => siblings(arena, parent, c, false).iter().any(|&s| kind(arena, s) == Some(NodeKind::Element)),
                None => has(NodeKind::Element),
            };
            (has_doctype || element_before).then_some(Refusal::DoctypePlacement)
        }
        _ => None,
    }
}

// The checks of DOM "move" (https://dom.spec.whatwg.org/#move, `moveBefore`) of `node` into `parent` before `child` —
// a Document's element child refuses even the node itself.
fn move_refusal(arena: &RealmArena, node: NodeId, node_type: u32, parent: NodeId, parent_type: u32, child: Option<Option<NodeId>>) -> Option<Refusal> {
    if arena.shadow_including_root(node) != arena.shadow_including_root(parent) {
        return Some(Refusal::MoveTree);
    }
    if host_including_ancestor(arena, node, parent) {
        return Some(Refusal::Ancestor);
    }
    if child.is_some_and(|c| c.is_none_or(|c| arena.parent_of(c) != Some(parent))) {
        return Some(Refusal::NotAChild);
    }
    if !matches!(node_type, ELEMENT | TEXT | CDATA | COMMENT | PI) {
        return Some(Refusal::MoveKind);
    }
    if parent_type != DOCUMENT {
        return None;
    }
    if matches!(node_type, TEXT | CDATA) {
        return Some(Refusal::MoveText);
    }
    let another = arena.get(parent).is_some_and(|p| p.children.iter().any(|&c| kind(arena, c) == Some(NodeKind::Element)));
    (node_type == ELEMENT && another).then_some(Refusal::MoveElement)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "insertionRefusal", insertion_refusal, context_id);
    crate::dom::register(scope, ns, "moveRefusal", move_refusal_op, context_id);
}

// __dom.moveRefusal(nodeNid, nodeType, parentNid, parentType, childNid) -> 0 where `moveBefore` of the node into the
// parent before `childNid` (-1 for none) is valid, else why not (`Refusal`).
fn move_refusal_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(node), Some(parent)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return rv.set_uint32(Refusal::MoveTree as u32) };
    let node_type = args.get(1).uint32_value(scope).unwrap_or(0);
    let parent_type = args.get(3).uint32_value(scope).unwrap_or(0);
    let child = (args.get(4).number_value(scope) != Some(-1.0)).then(|| nid_arg(scope, &args, 4));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_uint32(move_refusal(arena, node, node_type, parent, parent_type, child).map_or(0, |r| r as u32));
}

// __dom.insertionRefusal(nodeNid, nodeType, parentNid, parentType, childNid, replace) -> 0 where the insertion of the
// node into the parent before `childNid` (-1 for none; null for a child with no slot) — or its replacing of `childNid`,
// `replace` — is valid, else why not (`Refusal`).
fn insertion_refusal(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let node = nid_arg(scope, &args, 0);
    let Some(parent) = nid_arg(scope, &args, 2) else { return rv.set_uint32(Refusal::ParentKind as u32) };
    let node_type = args.get(1).uint32_value(scope).unwrap_or(0);
    let parent_type = args.get(3).uint32_value(scope).unwrap_or(0);
    let child = (args.get(4).number_value(scope) != Some(-1.0)).then(|| nid_arg(scope, &args, 4));
    let replace = args.get(5).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_uint32(refusal(arena, node, node_type, parent, parent_type, child, replace).map_or(0, |r| r as u32));
}
