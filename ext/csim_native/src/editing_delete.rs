// Deleting in an editing host — what Backspace and Delete do, by a character or (with Control) a word — the engine's:
// the range the selection is, or, where it is collapsed, the one from the caret to the place a step takes it (caret.rs
// `caret_step`, `caret_word_step`: past an atom, a `<br>`, across a block's edge); its contents deleted (range_contents.rs
// `delete`); a range across blocks joining them — the end's block's content moved into the start's, a lone `<br>`
// holding an empty line open dropped, the end's block removed with the ancestors it leaves empty; the inline elements a
// deletion emptied at the caret removed, and a block it emptied held open by a `<br>` (Chrome). Every change of
// children the engine's change; the bindings finish them as the op returns and put the caret where it says.

use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena};
use crate::mutation::Change;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editDelete", edit_delete, context_id);
}

// The block a place in `node` is in: its nearest inclusive ancestor that is block-level — or `host`, at most.
fn block_of(arena: &RealmArena, node: NodeId, host: NodeId) -> NodeId {
    let mut at = if arena.is_element(node) { node } else { arena.parent_of(node).unwrap_or(node) };
    while at != host && !crate::rendered::is_block_level(arena, at) {
        match arena.parent_of(at) {
            Some(p) => at = p,
            None => break,
        }
    }
    at
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
// or a word's — the place the caret goes, and the changes of children it made (mutation.rs `changes_value`).
fn edit_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec), Some(host)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2), crate::dom::nid_arg(scope, &args, 6)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    let (forward, word) = (args.get(4).is_true(), args.get(5).is_true());
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(8)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    // (…the range: the selection's, or the caret's to where a step takes it — none past the host's edge)
    let range = if sc == ec && so == eo {
        crate::rendered::with_engine(scope, &args, 7, |engine, arena, now| {
            let to = if word { arena.caret_word_step(engine, now, sc, so, forward) } else { arena.caret_step(engine, now, sc, so, forward) }?;
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
    let steps = v8::Local::new(scope, steps);
    let Some(mut changes) = crate::range_contents::delete(scope, cid, caller, steps, sc, so, ec, eo) else { return };
    // (…a range across blocks joins them: the end's block's content after the start's)
    let arena = realm(scope, cid);
    let joins = start_block != end_block
        && within(arena, host, start_block)
        && within(arena, host, end_block)
        && !within(arena, start_block, end_block)
        && !within(arena, end_block, start_block);
    if joins && join(scope, cid, caller, steps, host, start_block, end_block, &mut changes).is_none() {
        return;
    }
    // (…the inline elements and the text the deletion emptied at the caret removed, and a block it emptied held open)
    let Some(caret) = tidy(scope, cid, caller, steps, start_block, (sc, so), &mut changes) else { return };
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

// The end's block's content moved to the end of the start's — a `<br>` that was all of it, holding an empty line open,
// dropped — and the end's block removed, with the ancestors that leaves empty, up to the host.
#[allow(clippy::too_many_arguments)]
fn join<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    host: NodeId,
    start_block: NodeId,
    end_block: NodeId,
    changes: &mut Vec<Change>,
) -> Option<()> {
    let arena = realm(scope, cid);
    let kids = arena.get(end_block)?.children.clone();
    let lone_br = matches!(kids.as_slice(), [only] if arena.get(*only).is_some_and(|n| n.is_html_named("br")));
    if !kids.is_empty() {
        let last = realm(scope, cid).get(start_block)?.children.last().copied();
        changes.push(crate::mutation::remove_all(scope, cid, caller, end_block, steps)?);
        if !lone_br {
            changes.push(crate::mutation::insert(scope, cid, caller, start_block, &kids, None, steps)?);
            // (…the text either side of the joint one text, as Chrome joins it: the moved one's data the end of the one
            // before, and it gone)
            let arena = realm(scope, cid);
            let text = |n: Option<NodeId>| n.filter(|&n| arena.get(n).is_some_and(|d| d.kind == NodeKind::Text));
            if let (Some(before), Some(moved)) = (text(last), text(kids.first().copied())) {
                let (at, data) = (arena.get(before)?.data.len(), arena.get(moved)?.data.clone());
                let object = crate::dom::node_value(scope, Some(before));
                if crate::dom::factory_threw(scope) {
                    return None;
                }
                let joined = v8::String::new_from_two_byte(scope, &data, v8::NewStringType::Normal)?;
                crate::character_data::replace_data(scope, caller, before, object, at, 0, joined).ok()?;
                changes.push(crate::mutation::remove(scope, cid, caller, moved, steps)?);
            }
        }
    }
    let mut gone = end_block;
    loop {
        let parent = realm(scope, cid).parent_of(gone)?;
        changes.push(crate::mutation::remove(scope, cid, caller, gone, steps)?);
        let empty = realm(scope, cid).get(parent).is_some_and(|n| n.children.is_empty());
        if parent == host || !empty || within(realm(scope, cid), parent, start_block) {
            break;
        }
        gone = parent;
    }
    Some(())
}

// At the caret — the start of what was deleted — the empty text and the inline elements left empty removed (Chrome:
// `x<b>y</b>z`, the `y` deleted, is `xz`), the caret before what went; and the start's block, left empty, held open by a
// `<br>` the caret is before. Where the caret lands: at the end of the text before it, where there is one.
fn tidy<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    block: NodeId,
    start: (NodeId, u32),
    changes: &mut Vec<Change>,
) -> Option<(NodeId, u32)> {
    let mut caret = start;
    let mut at = start.0;
    loop {
        let arena = realm(scope, cid);
        let Some(n) = arena.get(at) else { break };
        let empty = match n.kind {
            NodeKind::Text => n.data.is_empty(),
            NodeKind::Element => n.children.is_empty() && !crate::caret::CARET_VOID_TAGS.contains(&&*n.local_name) && !crate::rendered::is_block_level(arena, at),
            _ => false,
        };
        let Some(parent) = arena.parent_of(at).filter(|_| empty && at != block) else { break };
        caret = (parent, arena.child_index(at) as u32);
        changes.push(crate::mutation::remove(scope, cid, caller, at, steps)?);
        at = parent;
    }
    let arena = realm(scope, cid);
    if arena.get(block).is_some_and(|n| n.children.is_empty()) && block_takes_br(arena, block) {
        // (…held until the insertion holds it in the tree)
        let (br, held) = make_br(scope, cid, caller, block);
        changes.push(crate::mutation::insert(scope, cid, caller, block, &[br], None, steps)?);
        drop(held);
        return Some((block, 0));
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
// Whether an emptied block is held open by a `<br>`: one that is not the editing host itself (Chrome leaves an emptied
// host empty).
fn block_takes_br(arena: &RealmArena, block: NodeId) -> bool {
    arena.editing_host(block) != Some(block)
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
