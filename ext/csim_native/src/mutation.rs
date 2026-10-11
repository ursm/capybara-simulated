// The DOM's tree mutation algorithms (DOM §4.2.3): what makes an insertion or a replacement valid — the "ensure
// pre-insertion validity" steps and the replace algorithm's checks — over the arena's trees, and the change of a parent's
// children each of them makes (`change_children`): the engine's edges and steps in the order the algorithms write and
// run them, the bindings' steps in its course (a frame's discarding, a select's reset) called back where they fall, and
// those it ends with — the mutation record, the custom element reactions, the connection walk — the bindings' to take as
// it returns.

use crate::dom::{nid_arg, node_value, nodes_value, realm, realm_id, NodeId, NodeKind, RealmArena};

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
    crate::dom::register(scope, ns, "changeChildren", change_children_op, context_id);
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

// The steps of a change of a parent's children the bindings take in its course, by their index in the `steps` it is
// handed — each called only where there is something for it to do, the commonest change calling none: replace all's
// adopting of its nodes into the parent's node document, after it removed the children (`adopt(parent, nodes)`; the
// other algorithms adopt theirs before the change, the bindings' own first step), a shadow host joining the trees of the
// parent's realm (`shadowHosted(parent)`), the browsing contexts of a removed subtree's frames discarded — their unload
// runs script, which may take more out (`discardFrames(frames)`) — the select a removal asks for a reset
// (`removedFrom(parent, removed, all)`), and a `<source>`'s insertion step (`sourceInserted(node, parent)`). What the
// change ends with — the mutation record, the removed nodes' disconnection, the inserted ones' insertion, connection and
// post-connection steps — the bindings take as it returns (`changeFlags`).
const STEP_ADOPT: u32 = 0;
const STEP_SHADOW_HOSTED: u32 = 1;
const STEP_DISCARD_FRAMES: u32 = 2;
const STEP_REMOVED_FROM: u32 = 3;
const STEP_SOURCE_INSERTED: u32 = 4;

// What a change of children says of itself as it returns, in the flags every realm's bindings read with no call
// (`changeFlags`): whether the parent was connected as it began, and whether it was refused — a replacement whose
// reference child the removal's own steps took out (a frame's unload): its removal stands, and it throws.
const CHANGE_CONNECTED: u32 = 1;
const CHANGE_REFUSED: u32 = 1 << 1;

// What `removing` names: no child (an insertion), every child (replace all), or the one.
#[derive(Clone, Copy)]
enum Removing {
    None,
    All,
    Child(NodeId),
}

// Why a change of children throws before it begins (a NotFoundError): the child to remove is none of the parent's.
const REMOVED_NOT_A_CHILD: u32 = 1;

// One step called — undefined as its `this` — or None where it threw, whose exception goes on to the caller.
fn step(scope: &mut v8::PinScope<'_, '_>, steps: v8::Local<'_, v8::Array>, which: u32, args: &[v8::Local<'_, v8::Value>]) -> Option<()> {
    let f = v8::Local::<v8::Function>::try_from(steps.get_index(scope, which)?).ok()?;
    let undefined = v8::undefined(scope).into();
    f.call(scope, undefined, args).map(|_| ())
}

// Does a change of `nodes` under `parent` touch a select's options — an option or an optgroup among them, or a select or
// an optgroup the parent — so that its select is asked for a reset? (A gate: no other change calls the step.)
fn affects_selectedness(arena: &RealmArena, parent: NodeId, nodes: &[NodeId]) -> bool {
    let named = |id: NodeId, names: &[&str]| arena.get(id).is_some_and(|n| names.iter().any(|&name| n.is_html_named(name)));
    named(parent, &["select", "optgroup"]) || nodes.iter().any(|&n| named(n, &["option", "optgroup"]))
}

// A removed subtree's removing steps: its frames' browsing contexts discarded (the bindings'), then the engine's — a
// popover hidden, a dialog modal no more, focus and hover gone with it (dialogs.rs `removing_steps`), in the realm whose
// tree it left — whose change of an element's state the bindings hear of with the change's end (`note_state_changed`).
fn removing_steps(scope: &mut v8::PinScope<'_, '_>, steps: v8::Local<'_, v8::Array>, node: NodeId) -> Option<()> {
    let frames = crate::dom::dom(scope).arena.leaving_elements(node, true);
    let cid = crate::dom::dom(scope).arena.get(node).map(|n| n.realm);
    if !frames.is_empty() {
        let cid = cid.unwrap_or_default();
        let list = nodes_value(scope, cid, &frames);
        step(scope, steps, STEP_DISCARD_FRAMES, &[list])?;
    }
    if let Some(cid) = cid {
        let arena = realm(scope, cid);
        if arena.removing_steps(node) {
            arena.observers.note_state_changed();
        }
    }
    Some(())
}

// DOM §4.2.3's mutation algorithms — "insert", "remove", "replace", "replace all" — are one change of a parent's
// children, made here: the children `removing` names taken out, and `nodes` (out of any fragment, and adopted into the
// parent's node document — but replace all's, adopted here once the children are out: its insertion's step 6.1)
// inserted before `child` (none: last). One childList record says what it took out and put in. What follows is the
// change's steps: the removed subtrees' removing steps and disconnections, then the inserted ones' insertion steps, the
// parent's children changed steps, and their connection and post-connection steps (a script among them runs there, after
// every insertion step: DOM "insert" steps 7, 9 and 11). The steps of one removal may take `child` out too (a frame's
// unload): an insertion then goes last, a replacement is refused — its removal standing — with the NotFoundError Chrome
// throws (`CHANGE_REFUSED`). The removed nodes, `REMOVED_NOT_A_CHILD`, or None where a step threw.
fn change_children(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    parent: NodeId,
    removing: Removing,
    nodes: &[NodeId],
    node_list: v8::Local<'_, v8::Array>,
    child: Option<NodeId>,
    adopt_all: bool,
    steps: v8::Local<'_, v8::Array>,
) -> Option<Result<Changed, u32>> {
    let connected = realm(scope, cid).is_connected(parent);
    let (removed, siblings) = match removing {
        Removing::None => (Vec::new(), None),
        Removing::All => (crate::dom::take_all(scope, cid, parent), None),
        Removing::Child(r) => {
            let arena = realm(scope, cid);
            if arena.parent_of(r) != Some(parent) {
                return Some(Err(REMOVED_NOT_A_CHILD));
            }
            let siblings = (arena.sibling(r, -1), arena.sibling(r, 1));
            crate::dom::take_out(scope, cid, r);
            (vec![r], Some(siblings))
        }
    };
    for &r in &removed {
        realm(scope, cid).parser_form_owners_removed(r);
        removing_steps(scope, steps, r)?;
    }
    if !removed.is_empty() && affects_selectedness(realm(scope, cid), parent, &removed) {
        let parent_object = node_value(scope, Some(parent));
        let list = nodes_value(scope, cid, &removed);
        let all = v8::Boolean::new(scope, matches!(removing, Removing::All)).into();
        step(scope, steps, STEP_REMOVED_FROM, &[parent_object, list, all])?;
    }
    if adopt_all {
        let parent_object = node_value(scope, Some(parent));
        step(scope, steps, STEP_ADOPT, &[parent_object, node_list.into()])?;
    }
    // (…the child the nodes go before taken out by the removal's steps: an insertion goes last, a replacement is refused)
    let gone = child.is_some_and(|c| realm(scope, cid).parent_of(c) != Some(parent));
    let refused = gone && !matches!(removing, Removing::None);
    let added: &[NodeId] = if refused { &[] } else { nodes };
    if !added.is_empty() {
        // (…each a node of the parent's realm's trees from now on — one another realm made, with all it holds; and the
        // parent itself, kept in this realm where the realm it was in is gone)
        for n in std::iter::once(parent).chain(added.iter().copied()) {
            let arena = realm(scope, cid);
            if arena.get(n).is_some_and(|d| d.realm != cid) && arena.adopt(n) {
                let parent_object = node_value(scope, Some(parent));
                step(scope, steps, STEP_SHADOW_HOSTED, &[parent_object])?;
            }
        }
        crate::dom::insert_nodes(scope, cid, parent, added, if gone { None } else { child });
        let arena = realm(scope, cid);
        let sources: Vec<NodeId> = added.iter().copied().filter(|&n| arena.get(n).is_some_and(|d| d.is_html_named("source"))).collect();
        for n in sources {
            let (node, parent_object) = (node_value(scope, Some(n)), node_value(scope, Some(parent)));
            step(scope, steps, STEP_SOURCE_INSERTED, &[node, parent_object])?;
        }
    }
    let flags = (if connected { CHANGE_CONNECTED } else { 0 }) | (if refused { CHANGE_REFUSED } else { 0 });
    crate::dom::dom(scope).arena.change_flags.set(flags);
    Some(Ok(Changed { removed, siblings }))
}

// What a change of children took out: the nodes, and — one child's — the siblings it had, which its record carries.
struct Changed {
    removed: Vec<NodeId>,
    siblings: Option<(Option<NodeId>, Option<NodeId>)>,
}

// __dom.changeChildren(parentNid, removing, nodes, childNid, adoptAll, steps) -> what it took out — the removed nodes
// (as `nodes_value` answers), or, one child's, `[child, previousSibling, nextSibling]`; undefined for none — or
// `REMOVED_NOT_A_CHILD`: `change_children`, `removing` -1 for no child, -2 for every child, else the child's nid; `nodes`
// the nodes to insert; `childNid` -1 for none; `adoptAll` whether replace all's nodes are to be adopted (the bindings
// know where none is: each already a parentless node of the parent's document); `steps` the bindings' steps, by index
// (`STEP_*`). Whether the parent was connected, and whether the change was refused, in `changeFlags` — cleared first,
// where the change throws before it begins.
fn change_children_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    crate::dom::dom(scope).arena.change_flags.set(0);
    let Some(parent) = nid_arg(scope, &args, 0) else { return };
    let removing = match args.get(1).integer_value(scope) {
        Some(-1) => Removing::None,
        Some(-2) => Removing::All,
        _ => match nid_arg(scope, &args, 1) {
            Some(r) => Removing::Child(r),
            None => return,
        },
    };
    let (Ok(node_list), Ok(steps)) = (v8::Local::<v8::Array>::try_from(args.get(2)), v8::Local::<v8::Array>::try_from(args.get(5))) else { return };
    let mut nodes = Vec::with_capacity(node_list.length() as usize);
    for i in 0..node_list.length() {
        let Some(node) = node_list.get_index(scope, i) else { return };
        // (…a node with no slot is none the engine holds: nothing to insert)
        let Some(nid) = crate::node_handle::nid_of(scope, node) else { return };
        nodes.push(nid);
    }
    let child = nid_arg(scope, &args, 3);
    let adopt_all = matches!(removing, Removing::All) && !nodes.is_empty() && args.get(4).is_true();
    let cid = realm_id(scope, &args);
    match change_children(scope, cid, parent, removing, &nodes, node_list, child, adopt_all, steps) {
        Some(Ok(Changed { removed, siblings: Some((previous, next)) })) => {
            let items = [node_value(scope, removed.first().copied()), node_value(scope, previous), node_value(scope, next)];
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        Some(Ok(Changed { removed, siblings: None })) => {
            if !removed.is_empty() {
                let list = nodes_value(scope, cid, &removed);
                rv.set(list);
            }
        }
        Some(Err(refusal)) => rv.set_uint32(refusal),
        None => {}
    }
}
