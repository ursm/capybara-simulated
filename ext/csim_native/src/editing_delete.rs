// Deleting in an editing host — what Backspace and Delete do, by a character or (with Control) a word — the engine's:
// the range the selection is, or, where it is collapsed, the one from the caret to the place a step takes it (caret.rs
// `caret_step`, `caret_word_step`: past an atom, a `<br>`, across a block's edge); its contents deleted (range_contents.rs
// `delete`); a range across blocks joining them (`join`) — never across a table's cells; the inline elements a deletion
// emptied removed, and a block it emptied — the host too — held open by a `<br>` (Chrome). Every change of
// children the engine's change; the bindings finish them as the op returns and put the caret where it says.

use crate::dom::{realm, NodeId, NodeKind, RealmArena};
use crate::editing::{inline_level, selection_host, blank, block_of, cell_of, inline_content, island_of, make_br, rebalance_space, table_part, within};
use crate::mutation::Change;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editDelete", edit_delete, context_id);
}

// Whether an island holds an editing host of its own — what no step deletes (Chrome).
fn holds_host(arena: &RealmArena, island: NodeId) -> bool {
    arena.get(island).is_some_and(|n| n.children.iter().any(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Element && (d.contenteditable_state() == Some(true) || holds_host(arena, c)))))
}
// Whether `id` is a void element laid out as a block (`<hr>`, a block `<img>`): a step past it takes it whole and joins
// nothing (Chrome).
fn block_atom(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && !n.is_html_named("br") && crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name))
        && inline_level(arena, id) == Some(false)
}
// Whether `id` is a block a join can move content into or out of: an editable one that holds content — no void element,
// no table's part.
fn joinable(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && !crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name))
        && inline_level(arena, id) == Some(false)
        && !table_part(arena, id)
        && arena.editing_host(id).is_some()
}
// The child of `parent` nearest the place before its `at`th child on one side — the one at it (forward) or before it —
// past text of white space alone.
fn nearest(arena: &RealmArena, parent: NodeId, at: u32, forward: bool) -> Option<NodeId> {
    let kids = &arena.get(parent)?.children;
    let mut k = at as usize;
    loop {
        let n = if forward { *kids.get(k)? } else { *kids.get(k.checked_sub(1)?)? };
        if !blank(arena, n) {
            return Some(n);
        }
        k = if forward { k + 1 } else { k - 1 };
    }
}
// The child a place between children has on the side a step goes: the one after it (forward) or before it.
fn beside(arena: &RealmArena, (node, offset): (NodeId, u32), forward: bool) -> Option<NodeId> {
    let n = arena.get(node).filter(|n| n.kind == NodeKind::Element)?;
    if forward { n.children.get(offset as usize).copied() } else { (offset as usize).checked_sub(1).and_then(|k| n.children.get(k).copied()) }
}

// What a collapsed step took besides what it crossed: an island laid out as a block — the place it was, in its parent,
// what the blocks either side join across (Chrome) — or a block atom, which joins nothing.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Took {
    Step,
    BlockIsland(NodeId, u32),
    Atom,
}

// __dom.editDelete(anchorNode, anchorOffset, focusNode, focusOffset, forward, word, steps) -> [caretNode,
// caretOffset, changes…], or undefined where nothing is deleted: the deletion in the editing host the selection from
// the anchor to the focus edits (editing.rs `selection_host`: its anchor's, the focus kept to it and out of its
// non-editable islands) — of the selection's range, or, collapsed, of a step back (forward) from it, a character's
// or a word's — the place the caret goes, and the changes of children it made (mutation.rs `changes_value`). A step
// into a non-editable island takes the island whole — none that holds an editing host; a step past a block atom takes
// it whole; one out of a table cell — or into one — deletes nothing (Chrome); a range across cells deletes what it
// holds of them but joins none.
fn edit_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    let (forward, word) = (args.get(4).is_true(), args.get(5).is_true());
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(6)) else { return };
    let collapsed = sc == ec && so == eo;
    let Some((host, ((sc, so), (ec, eo)))) = selection_host(&crate::dom::dom(scope).arena, (sc, so), (ec, eo)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    // (…the range: the selection's, or the caret's to where a step takes it — none past the host's edge)
    let range = if collapsed {
        crate::rendered::with_engine(scope, &args, |engine, arena, now| {
            let mut to = if word { arena.caret_word_step(engine, now, sc, so, forward) } else { arena.caret_step(engine, now, sc, so, forward) }?;
            let mut took = Took::Step;
            // (…a step into an island, or past a block atom, to its far edge: it whole)
            let whole = match island_of(arena, to.0, host) {
                Some(island) if holds_host(arena, island) => return None,
                Some(island) => Some(island),
                None => beside(arena, to, forward).filter(|&n| block_atom(arena, n)),
            };
            if let Some(whole) = whole {
                let (parent, at) = (arena.parent_of(whole)?, arena.child_index(whole) as u32);
                to = if forward { (parent, at + 1) } else { (parent, at) };
                took = if block_atom(arena, whole) {
                    Took::Atom
                } else if inline_level(arena, whole) == Some(false) {
                    // (…a block island only where an editable block or a line's content on its far side joins across it:
                    // Chrome)
                    if !nearest(arena, parent, if forward { at + 1 } else { at }, forward).is_some_and(|b| joinable(arena, b) || inline_content(arena, b)) {
                        return None;
                    }
                    Took::BlockIsland(parent, at)
                } else {
                    Took::Step
                };
            }
            Some((if forward { ((sc, so), to) } else { (to, (sc, so)) }, took))
        })
        .flatten()
    } else {
        Some((((sc, so), (ec, eo)), Took::Step))
    };
    let Some((range, took)) = range else { return };
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    let steps = v8::Local::new(scope, steps);
    let Some(Some((caret, changes))) = delete(scope, caller, steps, host, range, took, forward, collapsed) else { return };
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![crate::dom::node_value(scope, Some(caret.0))];
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.push(v8::Integer::new_from_unsigned(scope, caret.1).into());
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// The deletion of the range from `start` to `end` in the editing host `host` by realm `caller`'s code — a step's, back
// or `forward`, which `took` what it says, where the selection was `collapsed`; the selection's, any other — and what
// it tidied: where the caret goes and the changes of children it made, or none where nothing was deleted.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(crate) fn delete<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    host: NodeId,
    ((sc, so), (ec, eo)): ((NodeId, u32), (NodeId, u32)),
    took: Took,
    forward: bool,
    collapsed: bool,
) -> Option<Option<((NodeId, u32), Vec<Change>)>> {
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return Some(None) };
    let arena = realm(scope, cid);
    if !within(arena, host, sc) || !within(arena, host, ec) || (sc == ec && so == eo) {
        return Some(None);
    }
    let (start_block, end_block) = (block_of(arena, sc, host), block_of(arena, ec, host));
    let same_cell = cell_of(arena, sc, host) == cell_of(arena, ec, host);
    if collapsed && !same_cell {
        return Some(None);
    }
    let (mut changes, deleted) = crate::range_contents::delete(scope, cid, caller, steps, sc, so, ec, eo)?;
    // (…a range across blocks joins them — not across cells, not a table's own parts; a block island gone, the blocks
    // either side of its place)
    let arena = realm(scope, cid);
    let (start_block, end_block) = match took {
        Took::BlockIsland(parent, at) => {
            let side = nearest(arena, parent, at, forward).filter(|&b| joinable(arena, b));
            if forward { (start_block, side.unwrap_or(end_block)) } else { (side.unwrap_or(start_block), end_block) }
        }
        _ => (start_block, end_block),
    };
    let joins = took != Took::Atom
        && start_block != end_block
        && same_cell
        && !table_part(arena, start_block)
        && !table_part(arena, end_block)
        && within(arena, host, start_block)
        && within(arena, host, end_block);
    let joint = if joins { join(scope, cid, caller, steps, (start_block, end_block), (sc, so), &mut changes)? } else { None };
    // (…nothing deleted, nothing joined: no change, the caret where it was)
    if !deleted && joint.is_none() {
        return Some(None);
    }
    // (…the caret at the joint where the start is between children or in no block the join kept; where nothing
    // joined and the start is the place before the block that holds the end — a block atom taken back, a line's start
    // — at the end, at what the deletion left of it)
    let arena = realm(scope, cid);
    let start = match joint {
        Some(joint) if arena.is_element(sc) || !within(arena, start_block, sc) => joint,
        Some(_) => (sc, so),
        None if beside(arena, (sc, so), true).is_some_and(|n| within(arena, n, ec) && inline_level(arena, n) == Some(false)) => (ec, 0),
        None => (sc, so),
    };
    // (…the inline elements and the text the deletion emptied at either end removed, and a block it emptied held open)
    let caret = tidy(scope, cid, caller, steps, (start_block, end_block), start, ec, &mut changes)?;
    Some(Some((caret, changes)))
}

// The end's block joined to the start's, whether one holds the other or neither does — the content moving moved after
// the start's, the text either side of the joint one text (Chrome), a `<br>` that was all of it, holding an empty line
// open, dropped:
//   - neither: the end's block's content to the end of the start's, and the end's block removed, with the ancestors that
//     leaves empty, up to the host;
//   - the start's holds the end's (`aa<p>bb</p>`, a nested list's item): the end's block's content right after the
//     start — after the inline elements it is in, at the start's block's level — and the end's block removed with the
//     ancestors that leaves empty, short of the start's; a `<br>` after it where more of the line follows
//     (`aa<p>bb</p>cc` is `aabb<br>cc`, `aa<p>bb</p><br>cc` `aabb<br><br>cc`); none where the start is where the end's block's line starts;
//   - the end's holds the start's (`<p>aa</p>bb`): the inline content after the start's block, up to the next block or
//     `<br>`, to the end of the start's — and that `<br>`, its line gone, removed.
// The joint — the place the moved content starts at — where anything joined.
fn join<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    (start_block, end_block): (NodeId, NodeId),
    start: (NodeId, u32),
    changes: &mut Vec<Change>,
) -> Option<Option<(NodeId, u32)>> {
    let arena = realm(scope, cid);
    if within(arena, end_block, start_block) {
        // (…the run after the start's block, at the end's block's level)
        let mut top = start_block;
        while arena.parent_of(top) != Some(end_block) {
            top = arena.parent_of(top)?;
        }
        let mut run = Vec::new();
        let mut next = arena.sibling(top, 1);
        while let Some(n) = next.filter(|&n| inline_content(arena, n)) {
            run.push(n);
            next = arena.sibling(n, 1);
        }
        if run.is_empty() {
            return Some(None);
        }
        let br = next.filter(|&n| arena.get(n).is_some_and(|d| d.is_html_named("br")));
        let joint = move_into(scope, cid, caller, steps, start_block, None, &run, changes)?;
        if let Some(br) = br {
            changes.push(crate::mutation::remove(scope, cid, caller, br, steps)?);
        }
        return Some(Some(joint));
    }
    let kids = arena.get(end_block)?.children.clone();
    let lone_br = matches!(kids.as_slice(), [only] if arena.get(*only).is_some_and(|n| n.is_html_named("br")));
    if within(arena, start_block, end_block) {
        // (…right after the start: after its text, or at its place between children — out of the inline elements it is
        // in that do not hold the end's block)
        let (mut parent, mut before) = match arena.get(start.0) {
            Some(n) if n.kind == NodeKind::Text => (n.parent?, arena.sibling(start.0, 1)),
            Some(n) => (start.0, n.children.get(start.1 as usize).copied()),
            None => return Some(None),
        };
        while parent != start_block && inline_level(arena, parent) != Some(false) && !within(arena, parent, end_block) {
            before = arena.sibling(parent, 1);
            parent = arena.parent_of(parent)?;
        }
        // (…none where the start is where the end's block's line starts: before it, after a block or a `<br>` — Chrome)
        let prev = match before {
            Some(b) => arena.sibling(b, -1),
            None => arena.get(parent)?.children.last().copied(),
        };
        if before.is_some_and(|b| within(arena, b, end_block)) && !prev.is_some_and(|p| inline_content(arena, p)) {
            return Some(None);
        }
        // (…what follows the end's block on its line, where the removal leaves it after the moved content)
        let mut top = end_block;
        while let Some(p) = arena.parent_of(top).filter(|&p| p != parent && arena.get(p).is_some_and(|n| n.children.len() == 1)) {
            top = p;
        }
        let after = arena.sibling(top, 1).filter(|&n| {
            arena.parent_of(top) == Some(parent)
                && !blank(arena, n)
                && (inline_content(arena, n) || arena.get(n).is_some_and(|d| d.is_html_named("br")))
        });
        let joint = if !kids.is_empty() && !lone_br {
            changes.push(crate::mutation::remove_all(scope, cid, caller, end_block, steps)?);
            Some(move_into(scope, cid, caller, steps, parent, before, &kids, changes)?)
        } else {
            None
        };
        remove_emptied_up(scope, cid, caller, steps, end_block, start_block, changes)?;
        if let Some(after) = after {
            let (br, held) = make_br(scope, cid, caller, parent);
            changes.push(crate::mutation::insert(scope, cid, caller, parent, &[br], Some(after), steps)?);
            drop(held);
        }
        return Some(Some(joint.unwrap_or(start)));
    }
    let joint = if !kids.is_empty() {
        changes.push(crate::mutation::remove_all(scope, cid, caller, end_block, steps)?);
        if lone_br { None } else { Some(move_into(scope, cid, caller, steps, start_block, None, &kids, changes)?) }
    } else {
        None
    };
    let end = realm(scope, cid).get(start_block)?.children.len() as u32;
    remove_emptied_up(scope, cid, caller, steps, end_block, start_block, changes)?;
    Some(Some(joint.unwrap_or((start_block, end))))
}
// `gone` removed, and the ancestors that leaves empty — short of any that holds `keep`, the host at most.
fn remove_emptied_up<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    mut gone: NodeId,
    keep: NodeId,
    changes: &mut Vec<Change>,
) -> Option<()> {
    loop {
        let parent = realm(scope, cid).parent_of(gone)?;
        changes.push(crate::mutation::remove(scope, cid, caller, gone, steps)?);
        let arena = realm(scope, cid);
        let empty = arena.get(parent).is_some_and(|n| n.children.is_empty());
        if !empty || within(arena, parent, keep) || arena.editing_host(parent) == Some(parent) {
            return Some(());
        }
        gone = parent;
    }
}
// `nodes` into `parent` before `before` (none: last) — each out of where it was — and the text either side of the joint
// one text: the first moved one's data the end of the text before it, and it gone (Chrome). The joint.
#[allow(clippy::too_many_arguments)]
fn move_into<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    parent: NodeId,
    before: Option<NodeId>,
    nodes: &[NodeId],
    changes: &mut Vec<Change>,
) -> Option<(NodeId, u32)> {
    let arena = realm(scope, cid);
    let last = match before {
        Some(b) => arena.sibling(b, -1),
        None => arena.get(parent)?.children.last().copied(),
    };
    for &n in nodes {
        if realm(scope, cid).parent_of(n).is_some() {
            changes.push(crate::mutation::remove(scope, cid, caller, n, steps)?);
        }
    }
    changes.push(crate::mutation::insert(scope, cid, caller, parent, nodes, before, steps)?);
    let arena = realm(scope, cid);
    let text = |n: Option<NodeId>| n.filter(|&n| arena.get(n).is_some_and(|d| d.kind == NodeKind::Text));
    if let (Some(prev), Some(moved)) = (text(last), text(nodes.first().copied())) {
        let (at, data) = (arena.get(prev)?.data.len(), arena.get(moved)?.data.clone());
        let object = crate::dom::node_value(scope, Some(prev));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let joined = v8::String::new_from_two_byte(scope, &data, v8::NewStringType::Normal)?;
        crate::character_data::replace_data(scope, caller, prev, object, at, 0, joined).ok()?;
        changes.push(crate::mutation::remove(scope, cid, caller, moved, steps)?);
        return Some((prev, at as u32));
    }
    let first = *nodes.first()?;
    Some((parent, realm(scope, cid).child_index(first) as u32))
}

// From `node` up, the empty text and the inline elements a deletion left empty removed, short of `block` (Chrome:
// `x<b>y</b>z`, the `y` deleted, is `xz`): the place before the outermost one removed, where any was.
fn clear_emptied<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    block: NodeId,
    node: NodeId,
    changes: &mut Vec<Change>,
) -> Option<Option<(NodeId, u32)>> {
    let mut place = None;
    let mut at = node;
    loop {
        let arena = realm(scope, cid);
        let Some(n) = arena.get(at) else { break };
        let empty = match n.kind {
            NodeKind::Text => n.data.is_empty(),
            NodeKind::Element => n.children.is_empty() && !crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name) && inline_level(arena, at) != Some(false),
            _ => false,
        };
        let Some(parent) = arena.parent_of(at).filter(|_| empty && at != block && within(arena, block, at)) else { break };
        place = Some((parent, arena.child_index(at) as u32));
        changes.push(crate::mutation::remove(scope, cid, caller, at, steps)?);
        at = parent;
    }
    Some(place)
}

// What a deletion leaves tidied: the inline elements and the text it emptied at either end removed — the end's first —
// the caret before what went at the start; the start's block, left empty, held open by a `<br>` the caret is before; the
// caret, between children, at the end of the text before it, where there is one; and the white space brought together
// kept as the line shows it. Where the caret lands.
#[allow(clippy::too_many_arguments)]
fn tidy<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    (start_block, end_block): (NodeId, NodeId),
    start: (NodeId, u32),
    end: NodeId,
    changes: &mut Vec<Change>,
) -> Option<(NodeId, u32)> {
    let end_block = if within(realm(scope, cid), end_block, end) { end_block } else { start_block };
    let end_place = clear_emptied(scope, cid, caller, steps, end_block, end, changes)?;
    let mut caret = if within(realm(scope, cid), start_block, start.0) { start } else { end_place.unwrap_or(start) };
    if within(realm(scope, cid), start_block, caret.0) && caret.0 != start_block {
        if let Some(place) = clear_emptied(scope, cid, caller, steps, start_block, caret.0, changes)? {
            caret = place;
        }
    }
    let arena = realm(scope, cid);
    if arena.get(start_block).is_some_and(|n| n.children.is_empty()) {
        let (br, held) = make_br(scope, cid, caller, start_block);
        changes.push(crate::mutation::insert(scope, cid, caller, start_block, &[br], None, steps)?);
        drop(held);
        return Some((start_block, 0));
    }
    // (…between children: at the end of the text before, where there is one — the place the line shows the caret at)
    let arena = realm(scope, cid);
    if arena.is_element(caret.0) && caret.1 > 0 {
        let before = arena.get(caret.0).and_then(|n| n.children.get(caret.1 as usize - 1).copied());
        if let Some(t) = before.filter(|&t| arena.get(t).is_some_and(|n| n.kind == NodeKind::Text)) {
            caret = (t, arena.get(t).map_or(0, |n| n.data.len() as u32));
        }
    }
    rebalance_space(scope, caller, caret.0, caret.1, caret.1)?;
    Some(caret)
}
