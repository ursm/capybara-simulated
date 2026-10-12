// Deleting in an editing host — what Backspace and Delete do, by a character or (with Control) a word — the engine's:
// the range the selection is, or, where it is collapsed, the one from the caret to the place a step takes it (caret.rs
// `caret_step`, `caret_word_step`: past an atom, a `<br>`, across a block's edge); its contents deleted (range_contents.rs
// `delete`); a range across blocks joining them (`join`) — never across a table's cells; the inline elements a deletion
// emptied removed, and a block it emptied — the host too — held open by a `<br>` (Chrome). Every change of
// children the engine's change; the bindings finish them as the op returns and put the caret where it says.

use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena};
use crate::mutation::Change;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editDelete", edit_delete, context_id);
}

// The block a place in `node` is in: its nearest inclusive ancestor that is no inline — a block, a table's part, a list
// item — or `host`, at most.
fn block_of(arena: &RealmArena, node: NodeId, host: NodeId) -> NodeId {
    let mut at = if arena.is_element(node) { node } else { arena.parent_of(node).unwrap_or(node) };
    while at != host && crate::rendered::is_inline_level(arena, at) != Some(false) {
        match arena.parent_of(at) {
            Some(p) => at = p,
            None => break,
        }
    }
    at
}
// …the table cell (or caption) it is in, below `host` — or `host`: what a deletion never joins across.
fn cell_of(arena: &RealmArena, node: NodeId, host: NodeId) -> NodeId {
    let mut at = Some(node);
    while let Some(n) = at.filter(|&n| n != host) {
        if arena.get(n).is_some_and(|d| d.is_html_named("td") || d.is_html_named("th") || d.is_html_named("caption")) {
            return n;
        }
        at = arena.parent_of(n);
    }
    host
}
// …whether an element is a table's own — the table or a part of its structure — which no join moves content into or out
// of.
fn table_part(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| ["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"].iter().any(|t| n.is_html_named(t)))
}
// …and the outermost element `node` is in, below `host`, that its editing does not reach (`contenteditable=false`): an
// island a deletion takes whole.
fn island_of(arena: &RealmArena, node: NodeId, host: NodeId) -> Option<NodeId> {
    let mut island = None;
    let mut at = Some(node);
    while let Some(n) = at.filter(|&n| n != host) {
        if arena.is_element(n) && arena.editing_host(n).is_none() {
            island = Some(n);
        }
        at = arena.parent_of(n);
    }
    island
}
// Whether `node` is `root` or in it.
fn within(arena: &RealmArena, root: NodeId, node: NodeId) -> bool {
    let mut at = Some(node);
    while let Some(n) = at {
        if n == root {
            return true;
        }
        at = arena.parent_of(n);
    }
    false
}

// __dom.editDelete(startNode, startOffset, endNode, endOffset, forward, word, host, now, steps) -> [caretNode, caretOffset,
// changes…], or undefined where nothing is deleted: the deletion in the editing host `host` — of the selection's range
// from (startNode, startOffset) to (endNode, endOffset), or, collapsed, of a step back (forward) from it, a character's
// or a word's — the place the caret goes, and the changes of children it made (mutation.rs `changes_value`). A step
// into a non-editable island takes the island whole; one out of a table cell — or into one — deletes nothing (Chrome);
// a range across cells deletes what it holds of them but joins none.
fn edit_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec), Some(host)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2), crate::dom::nid_arg(scope, &args, 6)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    let (forward, word) = (args.get(4).is_true(), args.get(5).is_true());
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(8)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let collapsed = sc == ec && so == eo;
    // (…the range: the selection's, or the caret's to where a step takes it — none past the host's edge)
    let range = if collapsed {
        crate::rendered::with_engine(scope, &args, 7, |engine, arena, now| {
            let mut to = if word { arena.caret_word_step(engine, now, sc, so, forward) } else { arena.caret_step(engine, now, sc, so, forward) }?;
            // (…a step into an island to its far edge: the island whole)
            if let Some(island) = island_of(arena, to.0, host) {
                let (parent, at) = (arena.parent_of(island)?, arena.child_index(island) as u32);
                to = if forward { (parent, at + 1) } else { (parent, at) };
            }
            Some(if forward { ((sc, so), to) } else { (to, (sc, so)) })
        })
        .flatten()
    } else {
        Some(((sc, so), (ec, eo)))
    };
    let Some(((sc, so), (ec, eo))) = range else { return };
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    if !within(arena, host, sc) || !within(arena, host, ec) || (sc == ec && so == eo) {
        return;
    }
    let (start_block, end_block) = (block_of(arena, sc, host), block_of(arena, ec, host));
    let same_cell = cell_of(arena, sc, host) == cell_of(arena, ec, host);
    if collapsed && !same_cell {
        return;
    }
    let steps = v8::Local::new(scope, steps);
    let Some((mut changes, deleted)) = crate::range_contents::delete(scope, cid, caller, steps, sc, so, ec, eo) else { return };
    // (…a range across blocks joins them — not across cells, not a table's own parts)
    let arena = realm(scope, cid);
    // (…a start between children, after a block — an island's place gone — that block's end the join's start: Chrome)
    let start_block = match arena.get(sc).filter(|n| n.kind == NodeKind::Element).and_then(|n| (so as usize).checked_sub(1).and_then(|k| n.children.get(k).copied())) {
        Some(before) if crate::rendered::is_inline_level(arena, before) == Some(false) && !table_part(arena, before) => before,
        _ => start_block,
    };
    let joins = start_block != end_block
        && same_cell
        && !table_part(arena, start_block)
        && !table_part(arena, end_block)
        && within(arena, host, start_block)
        && within(arena, host, end_block);
    let joined = if joins {
        let Some(joined) = join(scope, cid, caller, steps, host, (start_block, end_block), (sc, so), &mut changes) else { return };
        joined
    } else {
        false
    };
    // (…nothing deleted, nothing joined: no change, the caret where it was)
    if !deleted && !joined {
        return;
    }
    // (…the inline elements and the text the deletion emptied at either end removed, and a block it emptied held open)
    let Some(caret) = tidy(scope, cid, caller, steps, (start_block, end_block), (sc, so), ec, &mut changes) else { return };
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

// The end's block joined to the start's, whether one holds the other or neither does — the content moving moved after
// the start's, the text either side of the joint one text (Chrome), a `<br>` that was all of it, holding an empty line
// open, dropped:
//   - neither: the end's block's content to the end of the start's, and the end's block removed, with the ancestors that
//     leaves empty, up to the host;
//   - the start's holds the end's (`aa<p>bb</p>`, a nested list's item): the end's block's content right after the
//     start, and the end's block removed with the ancestors that leaves empty, short of the start's;
//   - the end's holds the start's (`<p>aa</p>bb`): the inline content after the start's block, up to the next block or
//     `<br>`, to the end of the start's.
// Whether anything joined.
#[allow(clippy::too_many_arguments)]
fn join<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    host: NodeId,
    (start_block, end_block): (NodeId, NodeId),
    start: (NodeId, u32),
    changes: &mut Vec<Change>,
) -> Option<bool> {
    let arena = realm(scope, cid);
    if within(arena, end_block, start_block) {
        // (…the run after the start's block, at the end's block's level)
        let mut top = start_block;
        while arena.parent_of(top) != Some(end_block) {
            top = arena.parent_of(top)?;
        }
        let mut run = Vec::new();
        let mut next = arena.sibling(top, 1);
        while let Some(n) = next.filter(|&n| {
            arena.get(n).is_some_and(|d| d.kind == NodeKind::Text || (d.kind == NodeKind::Element && !d.is_html_named("br") && crate::rendered::is_inline_level(arena, n) != Some(false)))
        }) {
            run.push(n);
            next = arena.sibling(n, 1);
        }
        if run.is_empty() {
            return Some(false);
        }
        move_into(scope, cid, caller, steps, start_block, None, &run, changes)?;
        return Some(true);
    }
    let kids = arena.get(end_block)?.children.clone();
    let lone_br = matches!(kids.as_slice(), [only] if arena.get(*only).is_some_and(|n| n.is_html_named("br")));
    if within(arena, start_block, end_block) {
        // (…right after the start: after its text, or at its place between children)
        let (parent, before) = match arena.get(start.0) {
            Some(n) if n.kind == NodeKind::Text => (n.parent?, arena.sibling(start.0, 1)),
            Some(n) => (start.0, n.children.get(start.1 as usize).copied()),
            None => return Some(false),
        };
        if !kids.is_empty() && !lone_br {
            changes.push(crate::mutation::remove_all(scope, cid, caller, end_block, steps)?);
            move_into(scope, cid, caller, steps, parent, before, &kids, changes)?;
        }
        remove_emptied_up(scope, cid, caller, steps, end_block, start_block, changes)?;
        return Some(true);
    }
    if !kids.is_empty() {
        changes.push(crate::mutation::remove_all(scope, cid, caller, end_block, steps)?);
        if !lone_br {
            move_into(scope, cid, caller, steps, start_block, None, &kids, changes)?;
        }
    }
    let _ = host;
    remove_emptied_up(scope, cid, caller, steps, end_block, start_block, changes)?;
    Some(true)
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
// one text: the first moved one's data the end of the text before it, and it gone (Chrome).
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
) -> Option<()> {
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
    }
    Some(())
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
            NodeKind::Element => n.children.is_empty() && !crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name) && crate::rendered::is_inline_level(arena, at) != Some(false),
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
    canonicalize_space(scope, caller, caret)?;
    Some(caret)
}

// The white space the deletion brought together at the caret kept as the line shows it (the Editing spec's
// "canonicalize whitespace"): where white space collapses, a space before the caret that another space follows — or the
// text ends with — a no-break space, so neither collapses into the other (Chrome: `foo bar baz`, `bar` deleted by a word,
// is `foo&nbsp; baz`); one the text starts with, too.
fn canonicalize_space(scope: &mut v8::PinScope<'_, '_>, caller: i32, (node, offset): (NodeId, u32)) -> Option<()> {
    let arena = &crate::dom::dom(scope).arena;
    // (…none where the caret is between children)
    let Some(n) = arena.get(node).filter(|n| n.kind == NodeKind::Text) else { return Some(()) };
    if !crate::rendered::collapses_white_space(arena, n.parent) {
        return Some(());
    }
    let (data, at) = (&n.data, offset as usize);
    let space = |i: usize| data.get(i) == Some(&0x20);
    let target = if at > 0 && space(at - 1) && (at == data.len() || space(at)) {
        at - 1
    } else if at == 0 && space(0) {
        0
    } else {
        return Some(());
    };
    let object = crate::dom::node_value(scope, Some(node));
    if crate::dom::factory_threw(scope) {
        return None;
    }
    let nbsp = v8::String::new_from_two_byte(scope, &[0xA0], v8::NewStringType::Normal)?;
    crate::character_data::replace_data(scope, caller, node, object, target, 1, nbsp).ok()
}

// A `<br>` the engine makes, in `block`'s node document, by realm `caller`'s code — and what holds its handle until a
// tree does.
fn make_br(scope: &mut v8::PinScope<'_, '_>, cid: i32, caller: i32, block: NodeId) -> (NodeId, v8::cppgc::Persistent<crate::node_handle::NodeHandle>) {
    let doc = crate::dom::dom(scope).arena.get(block).and_then(|n| n.link.handle().map(|h| h as *const crate::node_handle::NodeHandle));
    // SAFETY: the block's handle lives while its node is in the arena, which this reads before anything allocates.
    let doc = doc.and_then(|h| unsafe { &*h }.document(scope));
    let br = realm(scope, cid).create(NodeData { local_name: web_atoms::LocalName::from("br"), ns: web_atoms::ns!(html), ..NodeData::of_kind(NodeKind::Element, Vec::new()) }, None);
    (br, crate::node_handle::bare(scope, br, doc, caller))
}
