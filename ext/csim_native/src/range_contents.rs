// DOM §5.5's "clone the contents" and "extract" of a range, and its deletion — the engine's whole: the character data
// at its ends sliced (a copy of the part inside, the data cut), the partially contained children copied shallow and
// filled with what of them it holds, the contained children copied deep, moved into the fragment or removed. Every
// change of children is the engine's change (mutation.rs `change_children`: its record, the live ranges' steps, the
// bindings' steps in its course), every cut its "replace data" (character_data.rs), every copy its clone
// (cloning.rs). What each change ends with — the bindings' disconnections, insertion steps, connections — they take as
// the op returns, in order, with the copies' own cloning steps; the range's new point is theirs to set.

use crate::cloning::{clone_into, BindingsSteps};
use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena};
use crate::mutation::Change;
use crate::node_handle::NodeHandle;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "processRangeContents", process_range_contents, context_id);
}

// What is made of the contents: a copy (`CLONE`), the contents moved into a fragment (`EXTRACT`), or nothing (`DELETE`).
const CLONE: u32 = 0;
const DELETE: u32 = 2;

// Why it throws, before anything changed: a doctype among the contents a clone or an extraction would take (a
// HierarchyRequestError).
const DOCTYPE_CONTAINED: u32 = 1;

// One run of the algorithm: the realm it runs in and the one whose code asked, what it makes, the node document of
// what it makes, the bindings' steps of a change of children, and what it hands back — the changes made, in order, for
// the bindings to finish, and the copies whose cloning steps are the bindings' too.
struct Run<'s> {
    cid: i32,
    caller: i32,
    mode: u32,
    doc: Option<v8::Local<'s, v8::Object>>,
    steps: v8::Local<'s, v8::Array>,
    held: Vec<v8::cppgc::Persistent<NodeHandle>>,
    changes: Vec<Change>,
    bindings: BindingsSteps,
    // Whether it cut any data (a change of children is in `changes`).
    cut_any: bool,
}

// DOM's length of a node (§4.2): its data's for character data, its children's count for any other — a doctype's, none.
pub(crate) fn node_length(arena: &RealmArena, n: NodeId) -> u32 {
    arena.get(n).map_or(0, |d| if is_character_data(arena, n) { d.data.len() } else { d.children.len() }) as u32
}
// What a boundary point no range may have is (DOM §5.5 "set the start or end", and the Selection API's collapse, extend and setBaseAndExtent): a doctype's
// (InvalidNodeTypeError), or one past its node's length (IndexSizeError) — None for a point it may.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PointError {
    Doctype,
    PastLength,
}
pub(crate) fn point_error(arena: &RealmArena, nid: NodeId, offset: u32) -> Option<PointError> {
    if arena.get(nid).is_some_and(|n| n.node_type() == 10) {
        return Some(PointError::Doctype);
    }
    (offset > node_length(arena, nid)).then_some(PointError::PastLength)
}
fn is_character_data(arena: &RealmArena, n: NodeId) -> bool {
    arena.get(n).is_some_and(|d| matches!(d.kind, NodeKind::Text | NodeKind::Comment | NodeKind::ProcessingInstruction))
}

impl<'s> Run<'s> {
    // A new fragment, in the node document of what the run makes.
    fn fragment(&mut self, scope: &mut v8::PinScope<'s, '_>) -> NodeId {
        let id = realm(scope, self.cid).create(NodeData::of_kind(NodeKind::Fragment, Vec::new()), None);
        self.held.push(crate::node_handle::bare(scope, id, self.doc, self.caller));
        id
    }
    // `nodes` appended to `parent`, each taken out of the parent it has first (DOM "insert" step 6's adoption: a
    // removal of its own).
    fn append(&mut self, scope: &mut v8::PinScope<'s, '_>, parent: NodeId, nodes: &[NodeId]) -> Option<()> {
        for &n in nodes {
            if realm(scope, self.cid).parent_of(n).is_some() {
                self.remove(scope, n)?;
            }
        }
        let change = crate::mutation::insert(scope, self.cid, self.caller, parent, nodes, None, self.steps)?;
        self.changes.push(change);
        Some(())
    }
    // `node` taken out of its parent — none where something before took it out already (a frame's unload among the
    // removals: removing a node with no parent does nothing).
    fn remove(&mut self, scope: &mut v8::PinScope<'s, '_>, node: NodeId) -> Option<()> {
        if realm(scope, self.cid).parent_of(node).is_none() {
            return Some(());
        }
        let change = crate::mutation::remove(scope, self.cid, self.caller, node, self.steps)?;
        self.changes.push(change);
        Some(())
    }
    // A copy of `src` (its descendants with it, `deep`).
    fn copy(&mut self, scope: &mut v8::PinScope<'s, '_>, src: NodeId, deep: bool) -> Option<NodeId> {
        clone_into(scope, self.cid, self.caller, src, None, deep, self.doc, &mut self.held, &mut self.bindings)
    }
    // A copy of the character data `node` holding its data from `from` to `to`.
    fn slice(&mut self, scope: &mut v8::PinScope<'s, '_>, node: NodeId, from: u32, to: u32) -> Option<NodeId> {
        let copy = self.copy(scope, node, false)?;
        let arena = realm(scope, self.cid);
        let data = arena.get(node)?.data.get(from as usize..to as usize)?.to_vec();
        arena.get_mut_quietly(copy)?.data = data;
        Some(copy)
    }
    // `count` units of `node`'s data from `offset` cut.
    fn cut(&mut self, scope: &mut v8::PinScope<'s, '_>, node: NodeId, offset: u32, count: u32) -> Option<()> {
        let object = crate::dom::node_value(scope, Some(node));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let none = v8::String::empty(scope);
        self.cut_any |= count > 0;
        crate::character_data::replace_data(scope, self.caller, node, object, offset as usize, count as usize, none).ok()
    }

    // The contents from (`sc`, `so`) to (`ec`, `eo`), copied or moved into `frag` (none for a deletion) or deleted — and
    // where a range over them collapses to where not to its start, its first partially contained child's after.
    fn process(&mut self, scope: &mut v8::PinScope<'s, '_>, sc: NodeId, so: u32, ec: NodeId, eo: u32, frag: Option<NodeId>) -> Option<Option<(NodeId, u32)>> {
        if sc == ec && so == eo {
            return Some(None);
        }
        let len = |scope: &mut v8::PinScope<'s, '_>, n: NodeId| node_length(realm(scope, self.cid), n);
        // (…the one character data node it is inside: its slice)
        if sc == ec && is_character_data(realm(scope, self.cid), sc) {
            if let Some(frag) = frag {
                let slice = self.slice(scope, sc, so, eo)?;
                self.append(scope, frag, &[slice])?;
            }
            if self.mode != CLONE {
                self.cut(scope, sc, so, eo - so)?;
            }
            return Some(None);
        }
        let (common, first, last, contained, _) = crate::ranges::contents_plan(realm(scope, self.cid), sc, so, ec, eo);
        let kids = realm(scope, self.cid).get(common)?.children.clone();
        let (first_pc, last_pc) = (first.and_then(|i| kids.get(i).copied()), last.and_then(|i| kids.get(i).copied()));
        let collapse = first.map(|i| (common, i as u32 + 1));
        // (…the first partially contained child: the start node's slice from its offset, or a copy holding what of it
        // the range holds)
        match first_pc {
            Some(pc) if is_character_data(realm(scope, self.cid), pc) => {
                let end = len(scope, sc);
                if let Some(frag) = frag {
                    let slice = self.slice(scope, sc, so, end)?;
                    self.append(scope, frag, &[slice])?;
                }
                if self.mode != CLONE {
                    self.cut(scope, sc, so, end - so)?;
                }
            }
            Some(pc) => {
                let end = len(scope, pc);
                self.partial(scope, pc, sc, so, pc, end, frag)?;
            }
            None => {}
        }
        // (…the contained children: copied, moved, or removed)
        for &child in kids.get(contained).unwrap_or(&[]) {
            match frag {
                Some(frag) if self.mode == CLONE => {
                    let copy = self.copy(scope, child, true)?;
                    self.append(scope, frag, &[copy])?;
                }
                Some(frag) => self.append(scope, frag, &[child])?,
                None => self.remove(scope, child)?,
            }
        }
        // (…the last partially contained child: the end node's slice to its offset, or a copy holding what of it the
        // range holds)
        match last_pc {
            Some(pc) if is_character_data(realm(scope, self.cid), pc) => {
                if let Some(frag) = frag {
                    let slice = self.slice(scope, ec, 0, eo)?;
                    self.append(scope, frag, &[slice])?;
                }
                if self.mode != CLONE {
                    self.cut(scope, ec, 0, eo)?;
                }
            }
            Some(pc) => self.partial(scope, pc, pc, 0, ec, eo, frag)?,
            None => {}
        }
        Some(collapse)
    }
    // A partially contained child `child`: a shallow copy of it in `frag`, holding what of it the range holds (from
    // (`sc`, `so`) to (`ec`, `eo`)) — or, for a deletion, that deleted.
    #[allow(clippy::too_many_arguments)]
    fn partial(&mut self, scope: &mut v8::PinScope<'s, '_>, child: NodeId, sc: NodeId, so: u32, ec: NodeId, eo: u32, frag: Option<NodeId>) -> Option<()> {
        let Some(frag) = frag else {
            self.process(scope, sc, so, ec, eo, None)?;
            return Some(());
        };
        let copy = self.copy(scope, child, false)?;
        self.append(scope, frag, &[copy])?;
        let sub = self.fragment(scope);
        self.process(scope, sc, so, ec, eo, Some(sub))?;
        // (…the sub-fragment's children into the copy: DOM "insert" of a fragment, its children taken out of it first)
        let kids = realm(scope, self.cid).get(sub)?.children.clone();
        if !kids.is_empty() {
            let out = crate::mutation::remove_all(scope, self.cid, self.caller, sub, self.steps)?;
            let into = crate::mutation::insert(scope, self.cid, self.caller, copy, &kids, None, self.steps)?;
            self.changes.extend([out, into]);
        }
        Some(())
    }
}

// __dom.processRangeContents(startNode, startOffset, endNode, endOffset, mode, steps) -> [fragment, collapseNode,
// collapseOffset, changes, …], `DOCTYPE_CONTAINED`, or undefined where making the answer threw: the contents cloned
// (`mode` 0), extracted (1) or deleted (2) — the fragment null for a deletion, the collapse point null where the range
// collapses to its start; then the count of changes and each one as `[parent, added, removed, connected]`, for the
// bindings to finish in order; then the copies whose cloning steps are the bindings' too, as `cloneTree` answers them.
fn process_range_contents(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    let mode = args.get(4).uint32_value(scope).unwrap_or(DELETE);
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(5)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(sc).map(|n| n.realm) else { return };
    crate::cloning::begin_clone(scope);
    let arena = realm(scope, cid);
    if mode != DELETE && !(sc == ec && (so == eo || is_character_data(arena, sc))) && crate::ranges::contents_plan(arena, sc, so, ec, eo).4 {
        return rv.set_uint32(DOCTYPE_CONTAINED);
    }
    // (…what it makes, in the start node's node document — or the start node's, a document)
    let start = crate::dom::node_value(scope, Some(sc));
    if crate::dom::factory_threw(scope) {
        return;
    }
    let doc = match crate::dom::dom(scope).arena.get(sc).map(|n| n.kind) {
        Some(NodeKind::Document) => v8::Local::<v8::Object>::try_from(start).ok(),
        _ => crate::editing::document_of(scope, sc),
    };
    // (…the steps re-rooted in this scope, as the run's other handles are)
    let steps = v8::Local::new(scope, steps);
    let mut run = Run { cid, caller, mode, doc, steps, held: Vec::new(), changes: Vec::new(), bindings: Vec::new(), cut_any: false };
    let frag = (mode != DELETE).then(|| run.fragment(scope));
    // (…what changed handed back whatever stopped it — a cut a script's steps had made impossible: the changes made are
    // the bindings' to finish, and the range collapses to its start)
    let collapse = run.process(scope, sc, so, ec, eo, frag).flatten();
    // (…each answer made, and none past a node factory that threw: its exception is what the op ends with)
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![crate::dom::node_value(scope, frag)];
    if crate::dom::factory_threw(scope) {
        return;
    }
    match collapse {
        Some((node, offset)) => {
            out.push(crate::dom::node_value(scope, Some(node)));
            if crate::dom::factory_threw(scope) {
                return;
            }
            out.push(v8::Integer::new_from_unsigned(scope, offset).into());
        }
        None => {
            let null: v8::Local<'_, v8::Value> = v8::null(scope).into();
            out.extend([null, null]);
        }
    }
    let changes = crate::mutation::changes_value(scope, cid, &run.changes);
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.extend(changes);
    let triples = crate::cloning::bindings_value(scope, cid, &run.bindings);
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.extend(triples);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// A deletion of the contents from (`sc`, `so`) to (`ec`, `eo`) — an editing command's (editing_delete.rs) — by realm
// `caller`'s code: the changes it made, for the bindings to finish, and whether it deleted anything at all (data cut or
// a node removed); None where something stopped it (a node factory that threw, a step that threw), the changes it made
// before then lost with the op's exception.
#[allow(clippy::too_many_arguments)]
pub(crate) fn delete<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    sc: NodeId,
    so: u32,
    ec: NodeId,
    eo: u32,
) -> Option<(Vec<Change>, bool)> {
    let mut run = Run { cid, caller, mode: DELETE, doc: None, steps, held: Vec::new(), changes: Vec::new(), bindings: Vec::new(), cut_any: false };
    run.process(scope, sc, so, ec, eo, None)?;
    let any = run.cut_any || !run.changes.is_empty();
    Some((run.changes, any))
}
