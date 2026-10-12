// Inserting in an editing host — what typing, Enter and Shift+Enter do, and execCommand's `insertText`,
// `insertLineBreak` and `insertParagraph` — the engine's: the selection's contents deleted first (editing_delete.rs
// `delete`), then at the caret text (`Edit::text`), a `<br>` (`Edit::line_break`), or the caret's block split in two
// (`Edit::paragraph`); the white space the insertion brings together rebalanced as the line shows it (editing.rs
// `rebalance_space`). Every change of children the engine's change; the bindings finish them as the op returns, run the
// cloning steps of the elements a split copied, and put the caret where it says. Every expectation is Chrome's.

use crate::cloning::BindingsSteps;
use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena};
use crate::editing::{block_of, edge, has_content, line_edge, make, make_element, rebalance_space, within, Edge};
use crate::mutation::Change;
use crate::node_handle::NodeHandle;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editInsert", edit_insert, context_id);
}

// What an insertion inserts (`editInsert`'s `kind`): text, a line break, a paragraph's break.
const TEXT: u32 = 0;
const LINE_BREAK: u32 = 1;

// __dom.editInsert(startNode, startOffset, endNode, endOffset, kind, text, host, now, steps) -> [caretNode, caretOffset,
// copies, (source, copy, names)…, changes…], or undefined where nothing is inserted: the insertion in the editing host
// `host` at the selection's range from (startNode, startOffset) to (endNode, endOffset) — its contents deleted first, and
// nothing inserted where that deletes nothing (an end in a non-editable island) — of `text` (`TEXT`), a line break
// (`LINE_BREAK`) or a paragraph's break (any other): the place the caret goes, how many elements a split copied and each
// with its source and the names of the attributes whose cloning steps are the bindings' (cloning.rs `bindings_value`),
// and the changes of children it made (mutation.rs `changes_value`).
fn edit_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec), Some(host)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2), crate::dom::nid_arg(scope, &args, 6)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    let kind = args.get(4).uint32_value(scope).unwrap_or(TEXT);
    let text = args.get(5).to_string(scope).map_or_else(Vec::new, |s| {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        units
    });
    let now = crate::dom::clock_arg(scope, &args, 7);
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(8)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    let collapsed = (sc, so) == (ec, eo);
    {
        let arena = realm(scope, cid);
        if !within(arena, host, sc) || !within(arena, host, ec) || (kind == TEXT && text.is_empty() && collapsed) {
            return;
        }
    }
    let steps = v8::Local::new(scope, steps);
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    let mut edit = Edit { cid, caller, steps, host, now, changes: &mut changes, copies: &mut copies, held: &mut held };
    edit.restyle(scope);
    let mut caret = (sc, so);
    if !collapsed {
        let took = crate::editing_delete::Took::Step;
        let Some(Some((at, made))) = crate::editing_delete::delete(scope, caller, steps, host, ((sc, so), (ec, eo)), took, false, false) else { return };
        caret = at;
        edit.changes.extend(made);
        edit.restyle(scope);
    }
    let caret = match kind {
        TEXT => edit.text(scope, caret, &text),
        LINE_BREAK => edit.line_break(scope, caret),
        _ => edit.paragraph(scope, caret),
    };
    let Some(caret) = caret else { return };
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![crate::dom::node_value(scope, Some(caret.0))];
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.push(v8::Integer::new_from_unsigned(scope, caret.1).into());
    out.push(v8::Integer::new_from_unsigned(scope, copies.len() as u32).into());
    out.extend(crate::cloning::bindings_value(scope, cid, &copies));
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// Where text typed at a place goes: at the end of the text before it, or the start of the text after it, where there is
// one; and before a `<br>` that ends its block's last line — no line follows it — rather than after it (`ab<br>`, typed
// at its end, is `abx<br>`).
fn insertion_point(arena: &RealmArena, (node, offset): (NodeId, u32)) -> (NodeId, u32) {
    let Some(n) = arena.get(node).filter(|n| n.kind == NodeKind::Element) else { return (node, offset) };
    let mut k = (offset as usize).min(n.children.len());
    let br = |c: NodeId| arena.get(c).is_some_and(|d| d.is_html_named("br"));
    if k.checked_sub(1).and_then(|i| n.children.get(i).copied()).is_some_and(|b| br(b) && line_edge(arena, b, true) == Edge::Block) {
        k -= 1;
    }
    let text = |c: Option<NodeId>| c.filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Text));
    if let Some(t) = text(k.checked_sub(1).and_then(|i| n.children.get(i).copied())) {
        return (t, arena.get(t).map_or(0, |d| d.data.len() as u32));
    }
    if let Some(t) = text(n.children.get(k).copied()) {
        return (t, 0);
    }
    (node, k as u32)
}
// Whether `id` is a `<br>` that is all its block holds — the placeholder holding an empty line open, which the line's
// first text takes the place of (`<p><b><br></b></p>`, typed into, is `<p><b>x</b></p>`).
fn placeholder(arena: &RealmArena, id: NodeId) -> bool {
    if !arena.get(id).is_some_and(|n| n.is_html_named("br")) {
        return false;
    }
    let mut at = id;
    loop {
        let Some(parent) = arena.parent_of(at).filter(|&p| arena.get(p).is_some_and(|n| n.children.len() == 1)) else { return false };
        if crate::rendered::is_inline_level(arena, parent) != Some(true) || arena.editing_host(parent) == Some(parent) {
            return true;
        }
        at = parent;
    }
}
// Whether an element is a heading, whose split leaves a `<div>` after it where nothing follows the caret.
fn heading(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| ["h1", "h2", "h3", "h4", "h5", "h6"].iter().any(|t| n.is_html_named(t)))
}

// One insertion's state: the host's realm, the realm whose code inserts, the bindings' steps of a change of children,
// the host and the clock; the changes of children it makes, the elements it copies, and what holds the nodes it makes
// until a tree does.
struct Edit<'s, 'a> {
    cid: i32,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    host: NodeId,
    now: f64,
    changes: &'a mut Vec<Change>,
    copies: &'a mut BindingsSteps,
    held: &'a mut Vec<v8::cppgc::Persistent<NodeHandle>>,
}

impl<'s> Edit<'s, '_> {
    // The styles of the host's realm brought up to date — what the boxes of the nodes an edit made are read by.
    fn restyle(&self, scope: &mut v8::PinScope<'_, '_>) {
        crate::rendered::with_engine_of(scope, self.cid, self.now, |engine, arena, now| engine.flush(arena, now));
    }
    fn insert(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId], before: Option<NodeId>) -> Option<()> {
        self.changes.push(crate::mutation::insert(scope, self.cid, self.caller, parent, nodes, before, self.steps)?);
        Some(())
    }
    fn remove(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<()> {
        self.changes.push(crate::mutation::remove(scope, self.cid, self.caller, node, self.steps)?);
        Some(())
    }
    // `nodes` out of where they are, into `parent` at its end.
    fn move_into(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId]) -> Option<()> {
        for &n in nodes {
            if realm(scope, self.cid).parent_of(n).is_some() {
                self.remove(scope, n)?;
            }
        }
        if !nodes.is_empty() {
            self.insert(scope, parent, nodes, None)?;
        }
        Some(())
    }
    fn element(&mut self, scope: &mut v8::PinScope<'_, '_>, near: NodeId, name: &str) -> NodeId {
        let (id, held) = make_element(scope, self.cid, self.caller, near, name);
        self.held.push(held);
        id
    }
    // A copy of `src` alone — attributes, `id` too (Chrome) — its cloning steps the bindings' to run where it has them.
    fn copy(&mut self, scope: &mut v8::PinScope<'_, '_>, src: NodeId) -> Option<NodeId> {
        let doc = crate::editing::document_of(scope, src);
        crate::cloning::clone_into(scope, self.cid, self.caller, src, None, false, doc, self.held, self.copies)
    }

    // `text` at the caret: into the text there, or a text of its own — taking the place of a placeholder `<br>` — and the
    // white space around it rebalanced. Where the caret goes: after it.
    fn text(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32), text: &[u16]) -> Option<(NodeId, u32)> {
        let (node, offset) = insertion_point(realm(scope, self.cid), caret);
        let arena = realm(scope, self.cid);
        let (target, at) = if arena.get(node)?.kind == NodeKind::Text {
            let object = crate::dom::node_value(scope, Some(node));
            if crate::dom::factory_threw(scope) {
                return None;
            }
            let string = v8::String::new_from_two_byte(scope, text, v8::NewStringType::Normal)?;
            crate::character_data::replace_data(scope, self.caller, node, object, offset as usize, 0, string).ok()?;
            (node, offset)
        } else {
            let before = arena.get(node)?.children.get(offset as usize).copied();
            let placeholder = before.filter(|&b| placeholder(arena, b));
            let (made, held) = make(scope, self.cid, self.caller, node, NodeData::of_kind(NodeKind::Text, text.to_vec()));
            self.held.push(held);
            self.insert(scope, node, &[made], before)?;
            if let Some(br) = placeholder {
                self.remove(scope, br)?;
            }
            (made, 0)
        };
        let end = at + text.len() as u32;
        rebalance_space(scope, self.caller, target, at, end)?;
        Some((target, end))
    }

    // A `<br>` at the caret — a second after it where it ends its block, which the line it starts is — and the white
    // space either side rebalanced. Where the caret goes: after it, at the start of the text that follows it.
    fn line_break(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let place = insertion_point(realm(scope, self.cid), caret);
        let (parent, before) = self.split_at(scope, place)?;
        let br = self.element(scope, parent, "br");
        self.insert(scope, parent, &[br], before)?;
        if line_edge(realm(scope, self.cid), br, true) == Edge::Block {
            let second = self.element(scope, parent, "br");
            let after = realm(scope, self.cid).sibling(br, 1);
            self.insert(scope, parent, &[second], after)?;
        }
        self.rebalance_beside(scope, parent, Some(br))?;
        let after = realm(scope, self.cid).sibling(br, 1);
        self.rebalance_beside(scope, parent, after)?;
        let arena = realm(scope, self.cid);
        Some(match after.filter(|&t| arena.get(t).is_some_and(|n| n.kind == NodeKind::Text)) {
            Some(text) => (text, 0),
            None => (parent, arena.child_index(br) as u32 + 1),
        })
    }

    // The caret's block split in two at the caret — in a table's cell or a `<pre>` a line break; in an empty list item,
    // the item out of its list (`out_of_list`); in the host itself, the line (`host_line`): what follows the caret in it —
    // in the inline elements around the caret, copies of them — in a copy of it after it (a `<div>` after a heading
    // nothing follows the caret in), and either part that shows nothing held open by a `<br>`. Where the caret goes: the
    // start of the second.
    fn paragraph(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let place = insertion_point(arena, caret);
        let block = block_of(arena, place.0, self.host);
        let b = arena.get(block)?;
        if ["td", "th", "caption", "pre", "listing"].iter().any(|t| b.is_html_named(t)) {
            return self.line_break(scope, caret);
        }
        if b.is_html_named("li") && block != self.host && !has_content(arena, block) {
            return self.out_of_list(scope, block);
        }
        let (parent, before) = self.split_at(scope, place)?;
        if block == self.host {
            return self.host_line(scope, parent, before);
        }
        let (moved, before) = self.split_inlines(scope, parent, before, block)?;
        let arena = realm(scope, self.cid);
        let nodes: Vec<NodeId> = moved.into_iter().chain(std::iter::successors(before, |&n| arena.sibling(n, 1))).collect();
        let copy = if heading(arena, block) && !nodes.iter().any(|&n| has_content(arena, n)) { self.element(scope, block, "div") } else { self.copy(scope, block)? };
        self.move_into(scope, copy, &nodes)?;
        let arena = realm(scope, self.cid);
        let (outer, after) = (arena.parent_of(block)?, arena.sibling(block, 1));
        self.insert(scope, outer, &[copy], after)?;
        self.hold_open(scope, block, false)?;
        let caret = self.hold_open(scope, copy, true)?;
        self.restyle(scope);
        self.rebalance_leaf(scope, block, false)?;
        self.rebalance_leaf(scope, copy, true)?;
        Some(caret)
    }
    // The line the caret is on in the host itself split: at its start, an empty `<div>` before it, the caret where it
    // was (`ab`, broken at its start, is `<div><br></div>ab`); anywhere else, what follows the caret up to the host's next
    // block — its `<br>`s and the lines after them too — in a `<div>` after what precedes it (`a<div>b<br>cd</div>`).
    fn host_line(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, before: Option<NodeId>) -> Option<(NodeId, u32)> {
        let (cid, host) = (self.cid, self.host);
        let arena = realm(scope, cid);
        if edge(arena, parent, before, false) != Edge::Content {
            let mut top = before;
            let mut at = parent;
            while at != host {
                top = Some(at);
                at = arena.parent_of(at)?;
            }
            let caret = match before {
                Some(b) if arena.get(b).is_some_and(|n| n.kind == NodeKind::Text) => (b, 0),
                Some(b) => (parent, arena.child_index(b) as u32),
                None => (parent, arena.get(parent)?.children.len() as u32),
            };
            let div = self.element(scope, host, "div");
            let br = self.element(scope, host, "br");
            self.insert(scope, div, &[br], None)?;
            self.insert(scope, host, &[div], top)?;
            return Some(caret);
        }
        let (moved, before) = self.split_inlines(scope, parent, before, host)?;
        let arena = realm(scope, cid);
        let block = |n: NodeId| arena.is_element(n) && crate::rendered::is_inline_level(arena, n) == Some(false);
        let line: Vec<NodeId> = std::iter::successors(before, |&n| arena.sibling(n, 1)).take_while(|&n| !block(n)).collect();
        let next = line.last().map_or(before, |&n| arena.sibling(n, 1));
        let nodes: Vec<NodeId> = moved.into_iter().chain(line).collect();
        let div = self.element(scope, host, "div");
        self.move_into(scope, div, &nodes)?;
        self.insert(scope, host, &[div], next)?;
        let caret = self.hold_open(scope, div, true)?;
        self.restyle(scope);
        self.rebalance_beside(scope, host, Some(div))?;
        self.rebalance_leaf(scope, div, true)?;
        Some(caret)
    }
    // An empty list item out of its list: in a list in another's item, a new item of that list after it; else a `<div>`
    // after the list, the items after this one in a copy of the list after that — the list removed where that empties
    // it. Where the caret goes: in the new block, before its `<br>`.
    fn out_of_list(&mut self, scope: &mut v8::PinScope<'_, '_>, item: NodeId) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let list = arena.parent_of(item)?;
        let outer = arena.parent_of(list)?;
        let nested = outer != self.host && arena.get(outer).is_some_and(|n| n.is_html_named("li"));
        let following: Vec<NodeId> = std::iter::successors(arena.sibling(item, 1), |&n| arena.sibling(n, 1)).collect();
        self.remove(scope, item)?;
        let (block, into, after) = if nested {
            let arena = realm(scope, self.cid);
            let (into, after) = (arena.parent_of(outer)?, arena.sibling(outer, 1));
            (self.element(scope, outer, "li"), into, after)
        } else {
            (self.element(scope, list, "div"), outer, realm(scope, self.cid).sibling(list, 1))
        };
        let br = self.element(scope, block, "br");
        self.insert(scope, block, &[br], None)?;
        self.insert(scope, into, &[block], after)?;
        if !nested && !following.is_empty() {
            let rest = self.copy(scope, list)?;
            self.move_into(scope, rest, &following)?;
            let after = realm(scope, self.cid).sibling(block, 1);
            self.insert(scope, into, &[rest], after)?;
        }
        if realm(scope, self.cid).get(list).is_some_and(|n| n.children.is_empty()) {
            self.remove(scope, list)?;
        }
        Some((block, 0))
    }

    // A place made one between children: a text there split at it (character_data.rs `split_text`), where it is inside
    // one. The parent, and the child after the place.
    fn split_at(&mut self, scope: &mut v8::PinScope<'_, '_>, (node, offset): (NodeId, u32)) -> Option<(NodeId, Option<NodeId>)> {
        let arena = realm(scope, self.cid);
        let n = arena.get(node)?;
        if n.kind != NodeKind::Text {
            return Some((node, n.children.get(offset as usize).copied()));
        }
        let parent = n.parent?;
        if offset == 0 {
            return Some((parent, Some(node)));
        }
        if offset as usize >= n.data.len() {
            return Some((parent, arena.sibling(node, 1)));
        }
        let object = crate::dom::node_value(scope, Some(node));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let (new, made) = crate::character_data::split_text(scope, self.caller, node, object, offset as usize, self.steps)?;
        self.changes.extend(made);
        Some((parent, Some(new)))
    }
    // The inline elements from `parent` up to — not — `top` split at the place before `before`: what follows the place in
    // each moved into a copy of it, the copy of the one below first. The child of `top` the place is before then, and the
    // copy of the one it split, holding what followed the place in it.
    fn split_inlines(&mut self, scope: &mut v8::PinScope<'_, '_>, mut parent: NodeId, mut before: Option<NodeId>, top: NodeId) -> Option<(Option<NodeId>, Option<NodeId>)> {
        let mut moved = None;
        while parent != top {
            let arena = realm(scope, self.cid);
            let nodes: Vec<NodeId> = moved.into_iter().chain(std::iter::successors(before, |&n| arena.sibling(n, 1))).collect();
            let copy = self.copy(scope, parent)?;
            self.move_into(scope, copy, &nodes)?;
            let arena = realm(scope, self.cid);
            before = arena.sibling(parent, 1);
            parent = arena.parent_of(parent)?;
            moved = Some(copy);
        }
        Some((moved, before))
    }
    // `block`, where it shows nothing, held open by a `<br>` in its innermost element on one side — its first (`first`)
    // or last children's — and where the caret goes in it on that side: before that `<br>`, or at the start of its first
    // text.
    fn hold_open(&mut self, scope: &mut v8::PinScope<'_, '_>, block: NodeId, first: bool) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let side = |n: NodeId| arena.get(n).and_then(|d| if first { d.children.first() } else { d.children.last() }.copied());
        let mut at = block;
        while let Some(c) = side(at).filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Element && !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name))) {
            at = c;
        }
        if has_content(arena, block) {
            return Some(match side(at).filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Text)) {
                Some(text) if first => (text, 0),
                _ => (at, 0),
            });
        }
        if !arena.get(at)?.children.iter().any(|&c| arena.get(c).is_some_and(|d| d.is_html_named("br"))) {
            let br = self.element(scope, at, "br");
            self.insert(scope, at, &[br], None)?;
        }
        Some((at, 0))
    }
    // The white space at the start (`first`) or the end of what `root` holds — a line a split began or ended — rebalanced.
    fn rebalance_leaf(&mut self, scope: &mut v8::PinScope<'_, '_>, root: NodeId, first: bool) -> Option<()> {
        let arena = realm(scope, self.cid);
        let mut at = root;
        while let Some(c) = arena.get(at).and_then(|d| if first { d.children.first() } else { d.children.last() }.copied()) {
            at = c;
        }
        let Some(len) = arena.get(at).filter(|d| d.kind == NodeKind::Text).map(|d| d.data.len() as u32) else { return Some(()) };
        let offset = if first { 0 } else { len };
        rebalance_space(scope, self.caller, at, offset, offset)
    }
    // The white space of the texts either side of the place before `child` in `parent`.
    fn rebalance_beside(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, child: Option<NodeId>) -> Option<()> {
        let arena = realm(scope, self.cid);
        let before = child.map_or_else(|| arena.get(parent).and_then(|n| n.children.last().copied()), |c| arena.sibling(c, -1));
        let text = |n: Option<NodeId>| n.filter(|&n| arena.get(n).is_some_and(|d| d.kind == NodeKind::Text));
        let sides = [text(before).map(|t| (t, arena.get(t).map_or(0, |d| d.data.len() as u32))), text(child).map(|t| (t, 0))];
        for (t, at) in sides.into_iter().flatten() {
            rebalance_space(scope, self.caller, t, at, at)?;
        }
        Some(())
    }
}
