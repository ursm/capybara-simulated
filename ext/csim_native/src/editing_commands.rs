// `document.execCommand`'s editing commands in an editing host — the engine's edit of each: a list toggled, retagged
// or wrapped around the selection's block; the selected text wrapped innermost in a formatting element (superscript and
// subscript exclusive), a link or a span; the block wrapped in a blockquote, or out of one; the host's inline content
// wrapped in a block to align; a horizontal rule at the caret; the links the selection touches unwrapped. Each a plain
// shape of the edit — the shapes editors and the exec-command tests take — not the Editing spec's styling algorithm
// (merging runs, `<font>`, lists inside blocks), which is in-scope backlog. Every change of children the engine's; the
// bindings finish them, set the CSS a command gives the elements it answers (a colour, a font, an alignment, a cleared
// style), put the selection where it says, and fire `input`.

use crate::dom::{realm, NodeId, NodeKind, RealmArena};
use crate::editing_insert::Edit;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editCommand", edit_command, context_id);
}

// (…an element of the local name `tag`, ASCII case-insensitively, in any namespace: the tags the commands compare)
fn tag_is(arena: &RealmArena, id: NodeId, tag: &str) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && (*n.local_name).eq_ignore_ascii_case(tag))
}

// Where the selection goes after a command: left where it is, collapsed at a place, or around a node.
enum Caret {
    Keep,
    At(NodeId, u32),
    Around(NodeId, u32, NodeId, u32),
}

// __dom.editCommand(hostNid, anchorNid, anchorOffset, focusNid, focusOffset, command, value, steps) -> [fire, caret…,
// styled, nodes…, copies, changes…], or undefined for a command it does not know or a selection out of the host: the
// edit of `command` (its name ASCII lowercased, `value` its argument: a link's URL, a span's `style`) in the editing
// host `host` over the selection's range — whether the bindings fire `input` for it; where the selection goes (0 left,
// 1 collapsed: node, offset, 2 around: node, offset, node, offset); the elements whose CSS the bindings set (the block
// to align, the block whose style is cleared); then, as `editInsert` answers them, the elements it copied (none) and
// the changes of children it made.
fn edit_command(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(host), Some(anchor), Some(focus)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 3)) else { return };
    let (ao, fo) = (args.get(2).uint32_value(scope).unwrap_or(0), args.get(4).uint32_value(scope).unwrap_or(0));
    let command = args.get(5).to_rust_string_lossy(scope);
    let value = crate::dom::utf16_arg(scope, args.get(6));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(7)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    crate::cloning::begin_clone(scope);
    let steps = v8::Local::new(scope, steps);
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    let mut edit = Edit { cid, caller, steps, host, changes: &mut changes, copies: &mut copies, held: &mut held };
    // (…its range as the selection's in the host it edits — its anchor's, the focus clamped to it, nothing selected in a
    // comment: editing.rs `selection_host` — where that is this host; a selection of another host's, or none, edits
    // nothing: Chrome)
    let Some((_, range)) = crate::editing::selection_host(realm(scope, cid), (anchor, ao), (focus, fo)).filter(|&(h, _)| h == host) else { return };
    let done = match command.as_str() {
        "insertorderedlist" => list(scope, &mut edit, range.0, "ol"),
        "insertunorderedlist" => list(scope, &mut edit, range.0, "ul"),
        "bold" => wrap(scope, &mut edit, range, "b", None, None),
        "italic" => wrap(scope, &mut edit, range, "i", None, None),
        "underline" => wrap(scope, &mut edit, range, "u", None, None),
        "strikethrough" => wrap(scope, &mut edit, range, "strike", None, None),
        "superscript" => wrap(scope, &mut edit, range, "sup", Some("sub"), None),
        "subscript" => wrap(scope, &mut edit, range, "sub", Some("sup"), None),
        "createlink" => wrap(scope, &mut edit, range, "a", None, Some(("href", &value[..]))),
        "span" => wrap(scope, &mut edit, range, "span", None, Some(("style", &value[..])).filter(|_| !value.is_empty())),
        "justify" => justify(scope, &mut edit, range.0),
        "removeformat" => {
            let block = selection_block(realm(scope, cid), host, range.0, true);
            Some((true, Caret::Keep, block.filter(|&b| b != host).into_iter().collect()))
        }
        "indent" => indent(scope, &mut edit, range.0),
        "outdent" => outdent(scope, &mut edit, range.0),
        "unlink" => unlink(scope, &mut edit, range),
        "inserthorizontalrule" => horizontal_rule(scope, &mut edit, range),
        _ => return,
    };
    // (…where a copy's shadow root threw, what it changed answered all the same, the selection kept, for the bindings to
    // finish before they throw it: `takeCloneException`)
    let (fire, caret, styled) = match done {
        Some(done) => done,
        None if crate::dom::dom(scope).clone_exception.is_some() => (false, Caret::Keep, Vec::new()),
        None => return,
    };
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![v8::Boolean::new(scope, fire).into()];
    let places: Vec<(NodeId, u32)> = match caret {
        Caret::Keep => {
            out.push(v8::Integer::new(scope, 0).into());
            Vec::new()
        }
        Caret::At(node, offset) => {
            out.push(v8::Integer::new(scope, 1).into());
            vec![(node, offset)]
        }
        Caret::Around(a, ao, b, bo) => {
            out.push(v8::Integer::new(scope, 2).into());
            vec![(a, ao), (b, bo)]
        }
    };
    for (node, offset) in places {
        out.push(crate::dom::node_value(scope, Some(node)));
        if crate::dom::factory_threw(scope) {
            return;
        }
        out.push(v8::Integer::new_from_unsigned(scope, offset).into());
    }
    out.push(v8::Integer::new_from_unsigned(scope, styled.len() as u32).into());
    let styled = crate::dom::nodes_value(scope, cid, &styled);
    let Ok(styled) = v8::Local::<v8::Array>::try_from(styled) else { return };
    for k in 0..styled.length() {
        out.push(styled.get_index(scope, k).unwrap_or_else(|| v8::null(scope).into()));
    }
    out.push(v8::Integer::new_from_unsigned(scope, copies.len() as u32).into());
    out.extend(crate::cloning::bindings_value(scope, cid, &copies));
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// A command's result: whether `input` fires for it, where the selection goes, and the elements whose CSS the bindings
// set. None where a change could not be made (a node factory's exception, the page's).
type Done = Option<(bool, Caret, Vec<NodeId>)>;

// The block container holding the selection's start (editing.rs `edit_ancestor`), entering an element start's child at
// its offset with `descend`.
fn selection_block(arena: &RealmArena, host: NodeId, (node, offset): (NodeId, u32), descend: bool) -> Option<NodeId> {
    crate::editing::block_container_of(arena, host, node, offset, descend)
}

// insertOrderedList / insertUnorderedList: in a list item of a list of `tag`, the list toggled off — each item's
// children lifted out in its place; of the other kind, the list retagged; in none, the block holding the caret (the
// host's inline content where it has none) wrapped in a list of one item, the caret at its end.
fn list(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, (node, offset): (NodeId, u32), tag: &str) -> Done {
    let arena = realm(scope, edit.cid);
    let item = crate::editing::list_item_of(arena, edit.host, node, offset);
    if let Some(item) = item {
        let list = arena.parent_of(item)?;
        let parent = arena.parent_of(list)?;
        if tag_is(arena, list, tag) {
            let items = arena.get(list)?.children.clone();
            for i in items {
                let kids = realm(scope, edit.cid).get(i).map_or_else(Vec::new, |n| n.children.clone());
                edit.move_before(scope, parent, &kids, Some(list))?;
            }
            edit.remove(scope, list)?;
            return Some((true, Caret::Keep, Vec::new()));
        }
        let kids = arena.get(list)?.children.clone();
        let retagged = edit.element(scope, list, tag);
        edit.move_into(scope, retagged, &kids)?;
        edit.replace(scope, list, retagged)?;
        let first = realm(scope, edit.cid).get(retagged)?.children.first().copied().unwrap_or(retagged);
        return Some((true, Caret::At(first, 0), Vec::new()));
    }
    let block = selection_block(arena, edit.host, (node, offset), false).unwrap_or(edit.host);
    let (item, list) = (edit.element(scope, block, "li"), edit.element(scope, block, tag));
    edit.insert(scope, list, &[item], None)?;
    let kids = realm(scope, edit.cid).get(block)?.children.clone();
    edit.move_into(scope, item, &kids)?;
    if block == edit.host {
        edit.insert(scope, block, &[list], None)?;
    } else {
        edit.replace(scope, block, list)?;
    }
    let end = realm(scope, edit.cid).get(item)?.children.len() as u32;
    Some((true, Caret::At(item, end), Vec::new()))
}

// The selected text wrapped innermost — each text node the range covers split at the slice's edges, the slice moved
// into a new `tag` element (with `attribute` set: a link's `href`, a span's `style`) where it was, so chained commands nest — `exclusive` (superscript and
// subscript) first unwrapping a conflicting element that wraps the selected text alone; the selection around a single
// wrapped run. `input` only where it wrapped any, as Chrome.
fn wrap(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, (start, end): ((NodeId, u32), (NodeId, u32)), tag: &str, exclusive: Option<&str>, attribute: Option<(&str, &[u16])>) -> Done {
    if start == end {
        return Some((false, Caret::Keep, Vec::new()));
    }
    let runs = realm(scope, edit.cid).covered_text(start, end);
    let mut targets = Vec::with_capacity(runs.len());
    for (node, from, to) in runs {
        let len = realm(scope, edit.cid).get(node).map_or(0, |n| n.data.len() as u32);
        if to < len {
            edit.split_at(scope, (node, to))?;
        }
        let target = if from > 0 { edit.split_at(scope, (node, from))?.1? } else { node };
        targets.push(target);
    }
    let selected: std::collections::HashSet<NodeId> = if exclusive.is_some() { targets.iter().copied().collect() } else { Default::default() };
    let mut wrappers = Vec::with_capacity(targets.len());
    for &t in &targets {
        if let Some(other) = exclusive {
            unwrap_exclusive(scope, edit, t, other, &selected)?;
        }
        let parent = realm(scope, edit.cid).parent_of(t)?;
        let wrapper = edit.element(scope, parent, tag);
        if let Some((name, units)) = attribute {
            let lossy = String::from_utf16_lossy(units);
            let exact = if lossy.encode_utf16().eq(units.iter().copied()) { Vec::new() } else { vec![(name.to_owned(), units.to_vec())] };
            crate::dom::replace_attributes(scope, edit.cid, wrapper, vec![(name.to_owned(), lossy)], exact, None);
        }
        edit.insert(scope, parent, &[wrapper], Some(t))?;
        edit.move_into(scope, wrapper, &[t])?;
        wrappers.push(wrapper);
    }
    let caret = match wrappers.as_slice() {
        [only] => {
            let arena = realm(scope, edit.cid);
            let parent = arena.parent_of(*only)?;
            let at = arena.child_index(*only) as u32;
            Caret::Around(parent, at, parent, at + 1)
        }
        _ => Caret::Keep,
    };
    Some((!wrappers.is_empty(), caret, Vec::new()))
}
// …the element of `other` immediately around `text` — not the host — unwrapped where every text it holds that shows any
// is selected (`targets`); one that also formats unselected text is left (a slice-scoped unwrap is editing backlog).
fn unwrap_exclusive(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, text: NodeId, other: &str, targets: &std::collections::HashSet<NodeId>) -> Option<()> {
    let arena = realm(scope, edit.cid);
    let Some(conflict) = arena.parent_of(text).filter(|&p| p != edit.host && tag_is(arena, p, other)) else { return Some(()) };
    let mut stack = vec![conflict];
    while let Some(n) = stack.pop() {
        let d = arena.get(n)?;
        if d.kind == NodeKind::Text && !d.data.is_empty() && !targets.contains(&n) {
            return Some(());
        }
        stack.extend(d.children.iter());
    }
    let (parent, kids) = (arena.parent_of(conflict)?, arena.get(conflict)?.children.clone());
    edit.move_before(scope, parent, &kids, Some(conflict))?;
    edit.remove(scope, conflict)
}

// The justify commands' block — the block holding the selection, or, the host's inline content where it has none, a
// `<div>` wrapped around that, the caret at its start — answered for its `text-align`.
fn justify(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, start: (NodeId, u32)) -> Done {
    let arena = realm(scope, edit.cid);
    if let Some(block) = selection_block(arena, edit.host, start, true).filter(|&b| b != edit.host) {
        return Some((true, Caret::Keep, vec![block]));
    }
    let kids = arena.get(edit.host)?.children.clone();
    let div = edit.element(scope, edit.host, "div");
    edit.move_into(scope, div, &kids)?;
    edit.insert(scope, edit.host, &[div], None)?;
    Some((true, Caret::At(div, 0), vec![div]))
}

// indent: the block holding the selection wrapped in a `<blockquote>` — the host's content where it is the host.
fn indent(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, start: (NodeId, u32)) -> Done {
    let arena = realm(scope, edit.cid);
    let block = selection_block(arena, edit.host, start, true).filter(|&b| b != edit.host);
    let quote = edit.element(scope, edit.host, "blockquote");
    match block {
        Some(block) => {
            let parent = realm(scope, edit.cid).parent_of(block)?;
            edit.insert(scope, parent, &[quote], Some(block))?;
            edit.move_into(scope, quote, &[block])?;
        }
        None => {
            let kids = realm(scope, edit.cid).get(edit.host)?.children.clone();
            edit.move_into(scope, quote, &kids)?;
            edit.insert(scope, edit.host, &[quote], None)?;
        }
    }
    Some((true, Caret::Keep, Vec::new()))
}
// outdent: the nearest `<blockquote>` at or above the block holding the selection unwrapped — its children lifted out
// in its place — so an indent and an outdent give the tree back.
fn outdent(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, start: (NodeId, u32)) -> Done {
    let arena = realm(scope, edit.cid);
    let quote = selection_block(arena, edit.host, start, true).and_then(|b| crate::editing::blockquote_of(arena, edit.host, b));
    if let Some(quote) = quote {
        let (parent, kids) = (arena.parent_of(quote)?, arena.get(quote)?.children.clone());
        edit.move_before(scope, parent, &kids, Some(quote))?;
        edit.remove(scope, quote)?;
    }
    Some((true, Caret::Keep, Vec::new()))
}

// unlink: every `<a>` the selection touches — those in the range, and those it starts in, short of the host — unwrapped,
// its children lifted out in its place.
fn unlink(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, (start, end): ((NodeId, u32), (NodeId, u32))) -> Done {
    let arena = realm(scope, edit.cid);
    let common = crate::ranges::common_ancestor(arena, start.0, end.0);
    let root = if arena.is_element(common) { common } else { arena.parent_of(common).unwrap_or(common) };
    let intersects = |n: NodeId| {
        let Some(parent) = arena.parent_of(n) else { return true };
        let at = arena.child_index(n) as u32;
        crate::ranges::compare_points(arena, start, (parent, at + 1)) == Some(std::cmp::Ordering::Less)
            && crate::ranges::compare_points(arena, end, (parent, at)) == Some(std::cmp::Ordering::Greater)
    };
    let mut anchors = Vec::new();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        let Some(d) = arena.get(n) else { continue };
        if tag_is(arena, n, "a") && intersects(n) {
            anchors.push(n);
        }
        stack.extend(d.children.iter().rev());
    }
    let mut at = Some(start.0);
    while let Some(n) = at.filter(|&n| n != edit.host) {
        if tag_is(arena, n, "a") && !anchors.contains(&n) {
            anchors.push(n);
        }
        at = arena.parent_of(n);
    }
    for a in anchors {
        let arena = realm(scope, edit.cid);
        let (Some(parent), Some(kids)) = (arena.parent_of(a), arena.get(a).map(|n| n.children.clone())) else { continue };
        edit.move_before(scope, parent, &kids, Some(a))?;
        edit.remove(scope, a)?;
    }
    Some((true, Caret::Keep, Vec::new()))
}

// insertHorizontalRule: the selection's contents deleted, an `<hr>` where that left the range — inside a text there, the
// text split at it — and the caret after it.
fn horizontal_rule<'s>(scope: &mut v8::PinScope<'s, '_>, edit: &mut Edit<'s, '_>, (start, end): ((NodeId, u32), (NodeId, u32))) -> Done {
    let arena = realm(scope, edit.cid);
    let place = if start != end {
        // (…where DOM "delete the contents" leaves the range: after the start's highest ancestor the end is not in)
        let mut reference = None;
        if !crate::editing::within(arena, start.0, end.0) {
            let mut at = start.0;
            while let Some(p) = arena.parent_of(at).filter(|&p| !crate::editing::within(arena, p, end.0)) {
                at = p;
            }
            reference = Some(at);
        }
        let (made, _) = crate::range_contents::delete(scope, edit.cid, edit.caller, edit.steps, start.0, start.1, end.0, end.1)?;
        edit.changes.extend(made);
        match reference {
            Some(r) => {
                let arena = realm(scope, edit.cid);
                (arena.parent_of(r)?, arena.child_index(r) as u32 + 1)
            }
            None => start,
        }
    } else {
        start
    };
    let (parent, before) = edit.split_at(scope, place)?;
    let rule = edit.element(scope, parent, "hr");
    edit.insert(scope, parent, &[rule], before)?;
    let at = realm(scope, edit.cid).child_index(rule) as u32 + 1;
    Some((true, Caret::At(parent, at), Vec::new()))
}
