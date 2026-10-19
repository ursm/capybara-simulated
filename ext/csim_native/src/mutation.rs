// The DOM's tree mutation algorithms (DOM §4.2.3): what makes an insertion or a replacement valid — the "ensure
// pre-insertion validity" steps and the replace algorithm's checks — over the arena's trees, and the change of a parent's
// children each of them makes (`change_children`; DOM "move", `moveBefore`'s, `move_child`): the engine's edges, steps
// and record in the order the algorithms write and run them (`record_child_list`), the bindings' steps in its course (a
// frame's discarding, a select's reset) called back where they fall, and those it ends with — the custom element
// reactions, the connection walk — the bindings' to take as it returns.

use crate::dom::{nid_arg, node_value, nodes_value, realm, realm_id, NodeId, NodeKind, RealmArena, GEN_DIRTY, GEN_NODES, GEN_SETTLE, GEN_STRUCTURE, GEN_SUBTREE_MARKS, GEN_TREE};
use crate::mutation_observers::OBSERVATIONS;

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
    crate::dom::register(scope, ns, "changeChildren", change_children_op, context_id);
    crate::dom::register(scope, ns, "moveChild", move_child_op, context_id);
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
// change ends with past its record — the removed nodes' disconnection, the inserted ones' insertion, connection and
// post-connection steps — the bindings take as it returns (`changeFlags`).
const STEP_ADOPT: u32 = 0;
const STEP_SHADOW_HOSTED: u32 = 1;
const STEP_DISCARD_FRAMES: u32 = 2;
const STEP_REMOVED_FROM: u32 = 3;
const STEP_SOURCE_INSERTED: u32 = 4;

// What a change of children says of itself as it returns, in the flags every realm's bindings read with no call
// (`changeFlags`): whether the parent was connected as it began, whether it was refused — a replacement whose reference
// child the removal's own steps took out (a frame's unload): its removal stands, and it throws — and whether what it
// inserted asks a select for a reset (validity.rs `affects_selectedness`), which the bindings do once its connection steps ran.
// An engine algorithm's changes say the first and the last of each (`changes_value`).
const CHANGE_CONNECTED: u32 = 1;
const CHANGE_REFUSED: u32 = 1 << 1;
const CHANGE_ASKS_RESET: u32 = 1 << 2;

// What `removing` names: no child (an insertion), every child (replace all), or the one.
#[derive(Clone, Copy)]
enum Removing {
    None,
    All,
    Child(NodeId),
}

// Why a change of children throws before it begins (a NotFoundError): the child to remove is none of the parent's.
const REMOVED_NOT_A_CHILD: u32 = 1;

// One step called — undefined as its `this` — or None where it threw, whose exception goes on to the caller, or where
// a node factory threw making its arguments.
fn step(scope: &mut v8::PinScope<'_, '_>, steps: v8::Local<'_, v8::Array>, which: u32, args: &[v8::Local<'_, v8::Value>]) -> Option<()> {
    // (…none with the answers it is handed cut short by a node factory that threw: its exception is what the op ends with)
    if crate::dom::factory_threw(scope) {
        return None;
    }
    let f = v8::Local::<v8::Function>::try_from(steps.get_index(scope, which)?).ok()?;
    let undefined = v8::undefined(scope).into();
    f.call(scope, undefined, args).map(|_| ())
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
    caller: i32,
    parent: NodeId,
    removing: Removing,
    nodes: &[NodeId],
    node_list: v8::Local<'_, v8::Array>,
    child: Option<NodeId>,
    adopt_all: bool,
    steps: v8::Local<'_, v8::Array>,
) -> Option<Result<Vec<NodeId>, u32>> {
    let renewals = crate::dom::dom(scope).arena.sheet_renewals;
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
    // (…the select the removal asked for a reset, where any, and the options it changed — the bindings tell them)
    if let Some((select, changed)) = realm(scope, cid).ask_for_reset(parent, &removed, false) {
        let select = node_value(scope, Some(select));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let changed = nodes_value(scope, cid, &changed);
        step(scope, steps, STEP_REMOVED_FROM, &[select, changed])?;
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
            let node = node_value(scope, Some(n));
            if crate::dom::factory_threw(scope) {
                return None;
            }
            let parent_object = node_value(scope, Some(parent));
            step(scope, steps, STEP_SOURCE_INSERTED, &[node, parent_object])?;
        }
    }
    if (!removed.is_empty() || !added.is_empty()) && !record_child_list(scope, caller, parent, added, &removed, siblings, Some(renewals)) {
        return None;
    }
    let asks = realm(scope, cid).affects_selectedness(parent, added);
    let flags = (if connected { CHANGE_CONNECTED } else { 0 }) | (if refused { CHANGE_REFUSED } else { 0 }) | (if asks { CHANGE_ASKS_RESET } else { 0 });
    crate::dom::dom(scope).arena.change_flags.set(flags);
    Some(Ok(removed))
}

// A change of children one of the engine's own algorithms made (range_contents.rs, `normalize`), which the bindings
// finish as its op returns, in order (`changeFinished`): the parent, the nodes it added and removed, and whether the
// parent was connected as it began.
pub(crate) type Change = (NodeId, Vec<NodeId>, Vec<NodeId>, bool);
// …`nodes` inserted into `parent` before `child` (none: last)…
pub(crate) fn insert(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, parent: NodeId, nodes: &[NodeId], child: Option<NodeId>, steps: v8::Local<'_, v8::Array>) -> Option<Change> {
    let connected = realm(scope, cid).is_connected(parent);
    let empty = v8::Array::new(scope, 0);
    change_children(scope, cid, caller, parent, Removing::None, nodes, empty, child, false, steps)?.ok()?;
    Some((parent, nodes.to_vec(), Vec::new(), connected))
}
// …`node` taken out of its parent…
pub(crate) fn remove(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, node: NodeId, steps: v8::Local<'_, v8::Array>) -> Option<Change> {
    let parent = realm(scope, cid).parent_of(node)?;
    let connected = realm(scope, cid).is_connected(parent);
    let empty = v8::Array::new(scope, 0);
    let removed = change_children(scope, cid, caller, parent, Removing::Child(node), &[], empty, None, false, steps)?.ok()?;
    Some((parent, Vec::new(), removed, connected))
}
// …`old` replaced by `new`, nodes in no tree, in one change…
pub(crate) fn replace(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, old: NodeId, new: &[NodeId], steps: v8::Local<'_, v8::Array>) -> Option<Change> {
    let arena = realm(scope, cid);
    let (parent, next) = (arena.parent_of(old)?, arena.sibling(old, 1));
    let connected = arena.is_connected(parent);
    let empty = v8::Array::new(scope, 0);
    let removed = change_children(scope, cid, caller, parent, Removing::Child(old), new, empty, next, false, steps)?.ok()?;
    Some((parent, new.to_vec(), removed, connected))
}
// …every child of `parent` taken out…
pub(crate) fn remove_all(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, parent: NodeId, steps: v8::Local<'_, v8::Array>) -> Option<Change> {
    let connected = realm(scope, cid).is_connected(parent);
    let empty = v8::Array::new(scope, 0);
    let removed = change_children(scope, cid, caller, parent, Removing::All, &[], empty, None, false, steps)?.ok()?;
    Some((parent, Vec::new(), removed, connected))
}
// …and every child of `parent` replaced by `nodes`, nodes in no tree of its node document (DOM "replace all")…
pub(crate) fn replace_all(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, parent: NodeId, nodes: &[NodeId], steps: v8::Local<'_, v8::Array>) -> Option<Change> {
    let connected = realm(scope, cid).is_connected(parent);
    let empty = v8::Array::new(scope, 0);
    let removed = change_children(scope, cid, caller, parent, Removing::All, nodes, empty, None, false, steps)?.ok()?;
    Some((parent, nodes.to_vec(), removed, connected))
}
// …and the changes as the page has them: their count, then each `[parent, added, removed, flags]` (`CHANGE_*`) — cut short where
// a node factory threw (`factory_threw`, which the caller asks).
pub(crate) fn changes_value<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, changes: &[Change]) -> Vec<v8::Local<'s, v8::Value>> {
    let mut out: Vec<v8::Local<'s, v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, changes.len() as u32).into()];
    for (parent, added, removed, connected) in changes {
        out.push(node_value(scope, Some(*parent)));
        for nodes in [added, removed] {
            if crate::dom::factory_threw(scope) {
                return out;
            }
            out.push(nodes_value(scope, cid, nodes));
        }
        if crate::dom::factory_threw(scope) {
            return out;
        }
        let asks = realm(scope, cid).affects_selectedness(*parent, added);
        let flags = (if *connected { CHANGE_CONNECTED } else { 0 }) | (if asks { CHANGE_ASKS_RESET } else { 0 });
        out.push(v8::Integer::new_from_unsigned(scope, flags).into());
    }
    out
}

// __dom.changeChildren(parentNid, removing, nodes, childNid, adoptAll, steps, callerRealm) -> the removed nodes (as
// `nodes_value` answers; undefined for none), or `REMOVED_NOT_A_CHILD`: `change_children`, `removing` -1 for no child,
// -2 for every child, else the child's nid; `nodes` the nodes to insert; `childNid` -1 for none; `adoptAll` whether
// replace all's nodes are to be adopted (the bindings know where none is: each already a parentless node of the parent's
// document); `steps` the bindings' steps, by index (`STEP_*`); `callerRealm` the realm whose code made the change, whose
// generations its record moves. Whether the parent was connected, and whether the change was refused, in `changeFlags` —
// cleared first, where the change throws before it begins.
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
    let caller = args.get(6).int32_value(scope).unwrap_or(cid);
    match change_children(scope, cid, caller, parent, removing, &nodes, node_list, child, adopt_all, steps) {
        Some(Ok(removed)) => {
            if !removed.is_empty() {
                let list = nodes_value(scope, cid, &removed);
                rv.set(list);
            }
        }
        Some(Err(refusal)) => rv.set_uint32(refusal),
        None => {}
    }
}

// DOM "move" (`moveBefore`) of `node` into `parent` before `child` (none: last) — the checks passed — as its edges and
// the engine's moving steps go: out of its old parent and into the new one with the live ranges' and NodeIterators'
// steps of each (it stays connected: none of the bindings' removing or insertion steps — the engine's radio group and
// registry steps of an insertion run, as Chrome's do: a checked radio moved into another group unchecks the rest of it),
// recorded as a removal from the old parent and an insertion into the new one; a form the parser gave a control in it
// no longer its owner where they are no longer in the same tree (HTML's moving steps); and the focused or hovered
// element moved with it — the old ancestors' `:focus-within` / `:hover` ending and the new ones' beginning, a flip of
// state no setter sees (`note_state_changed`). The parent it left — None where a node factory threw making its records.
fn move_child(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, parent: NodeId, node: NodeId, child: Option<NodeId>) -> Option<Option<NodeId>> {
    let renewals = crate::dom::dom(scope).arena.sheet_renewals;
    let arena = realm(scope, cid);
    // (…"if child is node, set child to node's next sibling": a move before itself is none)
    let child = if child == Some(node) { arena.sibling(node, 1) } else { child };
    let old = arena.parent_of(node);
    let (previous, next) = (arena.sibling(node, -1), arena.sibling(node, 1));
    if old.is_some() {
        crate::dom::take_out(scope, cid, node);
    }
    crate::dom::insert_nodes(scope, cid, parent, &[node], child);
    // (…a removal from the old parent and an insertion into the new one, to an observer)
    if old.is_some_and(|old| !record_child_list(scope, caller, old, &[], &[node], Some((previous, next)), None)) {
        return None;
    }
    if !record_child_list(scope, caller, parent, &[node], &[], None, Some(renewals)) {
        return None;
    }
    let arena = realm(scope, cid);
    arena.parser_form_owners_removed(node);
    let carried = |id: Option<NodeId>| id.is_some_and(|f| arena.shadow_including_ancestor(node, f));
    if old != Some(parent) && (carried(arena.focus) || carried(arena.hover)) {
        arena.observers.note_state_changed();
    }
    Some(old)
}

// __dom.moveChild(nodeNid, nodeType, parentNid, parentType, childNid, callerRealm) -> the parent the node left (`move_child`;
// null for none), or why the move is refused (`Refusal`, the checks of "move": `move_refusal`); `childNid` -1 for none,
// `callerRealm` the realm whose code moved it, whose generations its records move.
fn move_child_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(node), Some(parent)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return rv.set_uint32(Refusal::MoveTree as u32) };
    let node_type = args.get(1).uint32_value(scope).unwrap_or(0);
    let parent_type = args.get(3).uint32_value(scope).unwrap_or(0);
    let child = (args.get(4).number_value(scope) != Some(-1.0)).then(|| nid_arg(scope, &args, 4));
    let cid = realm_id(scope, &args);
    if let Some(refusal) = move_refusal(realm(scope, cid), node, node_type, parent, parent_type, child) {
        return rv.set_uint32(refusal as u32);
    }
    let caller = args.get(5).int32_value(scope).unwrap_or(cid);
    // (…nothing past a node factory that threw making its records: its exception is what the op ends with)
    let Some(old) = move_child(scope, cid, caller, parent, node, child.flatten()) else { return };
    rv.set(node_value(scope, old));
}

// DOM "queue a tree mutation record" for a change of `target`'s children — `added` put in, `removed` taken out, the
// siblings either side (`siblings`; for an insertion alone, those of the nodes it put in where they still are) — and what
// moves with it: the target realm's layout marks (the target, its subtree where it is an element or a shadow root — what
// the selectors read of a child list, positions, `:empty`, a `:has()` above — and each node put in with its subtree,
// measured where it is now); the calling realm's settle, tree, nodes and structure generations and the observations a
// change schedules; and, where the change gave a sheet owner a new sheet (the count `renewals` was at as it began), the
// cascade — the version too on a page with shadow trees, whose sheets are handed to the style engine by it. False where
// a node factory threw making the record's answers (none queued): the caller goes no further, its exception what the op
// ends with.
pub(crate) fn record_child_list(
    scope: &mut v8::PinScope<'_, '_>,
    caller: i32,
    target: NodeId,
    added: &[NodeId],
    removed: &[NodeId],
    siblings: Option<(Option<NodeId>, Option<NodeId>)>,
    renewals: Option<u32>,
) -> bool {
    let Some(cid) = crate::dom::dom(scope).arena.get(target).map(|n| n.realm) else { return true };
    let arena = realm(scope, cid);
    let generations = &arena.generations;
    generations.bump(GEN_DIRTY);
    if arena.get(target).is_some_and(|n| n.kind == NodeKind::Element || n.host.is_some()) {
        generations.bump(GEN_SUBTREE_MARKS);
    }
    for _ in added {
        generations.bump(GEN_SUBTREE_MARKS);
        generations.bump(GEN_DIRTY);
    }
    let in_shadow = arena.get(arena.root_of(target)).is_some_and(|r| r.host.is_some());
    let shadow_hosts = arena.shadow_hosts;
    // (…the calling realm's generations, and the target's, where its code is another's: what a memo of the tree's realm
    // keys on moves with the tree)
    for moved in [caller, cid].into_iter().take(if caller == cid { 1 } else { 2 }) {
        let generations = &realm(scope, moved).generations;
        for which in [GEN_SETTLE, GEN_TREE, GEN_NODES, GEN_STRUCTURE] {
            generations.bump(which);
        }
    }
    let dom = crate::dom::dom(scope);
    dom.arena.observers.note(OBSERVATIONS);
    if renewals.is_some_and(|r| r != dom.arena.sheet_renewals) {
        dom.arena.observers.note_cascade(cid, in_shadow);
        if shadow_hosts {
            dom.arena.observers.note_cascade(cid, true);
        }
    }
    // (…the record's arrays made only where an observer is to have it)
    if !crate::mutation_observers::observed(realm(scope, cid), target, &crate::mutation_observers::Change::ChildList) {
        return true;
    }
    let (previous, next) = siblings.unwrap_or_else(|| {
        let arena = realm(scope, cid);
        let still = |n: &NodeId| arena.parent_of(*n) == Some(target);
        (added.first().filter(|n| still(n)).and_then(|&n| arena.sibling(n, -1)), added.last().filter(|n| still(n)).and_then(|&n| arena.sibling(n, 1)))
    });
    // (…each answer made, and no record past a node factory that threw: its exception is what the op ends with)
    let target_object = node_value(scope, Some(target));
    let mut answers = [target_object; 4];
    for (k, nodes) in [added, removed].into_iter().enumerate() {
        if crate::dom::factory_threw(scope) {
            return false;
        }
        answers[k] = nodes_value(scope, cid, nodes);
    }
    for (k, node) in [previous, next].into_iter().enumerate() {
        if crate::dom::factory_threw(scope) {
            return false;
        }
        answers[2 + k] = node_value(scope, node);
    }
    if crate::dom::factory_threw(scope) {
        return false;
    }
    let [added, removed, previous, next] = answers;
    let kind = v8::Integer::new(scope, 0).into();
    let null: v8::Local<'_, v8::Value> = v8::null(scope).into();
    let fields = [kind, target_object, added, removed, previous, next, null, null, null];
    crate::mutation_observers::queue_record(scope, cid, target, &fields);
    true
}

