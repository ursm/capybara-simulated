// The caret of an editing host as the driver's keys and clicks move it (form-fields.js): a step over one character —
// across the host's text leaves where it crosses a node's edge, never out of the host — a move to the edge of the block
// holding it, and a double click's word, which runs on across inline leaves of one block. A caret stops at a text leaf
// or at a void element (an image, a `<br>`): the atoms a browser places it beside.

use crate::dom::{nid_arg, NodeData, NodeId, NodeKind, RealmArena};

const CARET_VOID_TAGS: [&str; 11] = ["audio", "br", "canvas", "embed", "hr", "iframe", "img", "input", "object", "svg", "video"];

fn is_text(n: &NodeData) -> bool {
    n.kind == NodeKind::Text
}

impl RealmArena {
    // The first (last, with `from_end`) caret stop under `root`, searching its children inward from that edge: a text
    // leaf, or a void element — an EMPTY non-void one passed over (ProseMirror parks empty cursor `<span>`s at mark
    // boundaries, where a plain deepest-child walk read "no text here" and stopped).
    fn caret_leaf(&self, root: NodeId, from_end: bool) -> Option<NodeId> {
        let n = self.get(root)?;
        if is_text(n) {
            return Some(root);
        }
        if n.kind != NodeKind::Element {
            return None;
        }
        if n.children.is_empty() {
            return CARET_VOID_TAGS.contains(&&*n.local_name).then_some(root);
        }
        let mut kids: Box<dyn Iterator<Item = &NodeId>> = if from_end { Box::new(n.children.iter().rev()) } else { Box::new(n.children.iter()) };
        kids.find_map(|&c| self.caret_leaf(c, from_end))
    }

    // The text leaf before (after, with `forward`) `start` in its editing host — none past the host's edge: the caret
    // never leaves it (ArrowLeft at the start of an editor stays put).
    fn adjacent_text_leaf(&self, start: NodeId, forward: bool) -> Option<NodeId> {
        let element = match self.get(start)? {
            n if n.kind == NodeKind::Element => Some(start),
            n => n.parent,
        };
        let host = element.and_then(|e| self.editing_host(e));
        let mut at = start;
        while Some(at) != host {
            let n = self.get(at)?;
            let parent = n.parent?;
            let siblings = &self.get(parent)?.children;
            let i = self.child_index(at);
            let next = if forward { siblings.get(i + 1).copied() } else { i.checked_sub(1).map(|j| siblings[j]) };
            match next {
                Some(sibling) => {
                    if let Some(leaf) = self.caret_leaf(sibling, !forward).filter(|&l| self.get(l).is_some_and(is_text)) {
                        return Some(leaf);
                    }
                    at = sibling;
                }
                None => at = parent,
            }
        }
        None
    }

    // The nearest inclusive ancestor of `node` that is a block, by its tag (`rendered::is_block_tag`).
    fn block_of(&self, node: NodeId) -> Option<NodeId> {
        let mut at = Some(node);
        while let Some(id) = at {
            let n = self.get(id)?;
            if n.kind == NodeKind::Element && crate::rendered::is_block_tag(&n.local_name) {
                return Some(id);
            }
            at = n.parent;
        }
        None
    }

    // ArrowLeft / ArrowRight: the caret at (`node`, `offset`) one character back (on, with `forward`) — across to the
    // adjacent text leaf at a text node's edge, or from an element boundary.
    pub(crate) fn caret_step(&self, node: NodeId, offset: u32, forward: bool) -> Option<(NodeId, u32)> {
        let n = self.get(node)?;
        let len = if is_text(n) { n.data.len() as u32 } else { 0 };
        if is_text(n) && if forward { offset < len } else { offset > 0 } {
            return Some((node, if forward { offset + 1 } else { offset - 1 }));
        }
        let leaf = self.adjacent_text_leaf(node, forward)?;
        Some((leaf, if forward { 0 } else { self.get(leaf)?.data.len() as u32 }))
    }

    // Home / End: the caret at the start (end, with `end`) of the block holding `node` — its first (last) caret stop, or
    // the block itself where it has none (an empty paragraph).
    pub(crate) fn caret_block_edge(&self, node: NodeId, end: bool) -> Option<(NodeId, u32)> {
        let block = self.block_of(node)?;
        let leaf = self.caret_leaf(block, end).unwrap_or(block);
        let n = self.get(leaf)?;
        let offset = if !end { 0 } else if is_text(n) { n.data.len() } else { n.children.len() };
        Some((leaf, offset as u32))
    }

    // A double click's word: from (`node`, `offset`) — or, where `node` is no text, its first non-empty text leaf's
    // start — the run of word characters (letters, numbers, `_`) either side, running on across the inline text leaves
    // of the one block (`<code>code</code><b>bold</b>` is one word, an empty leaf no boundary). None for no word there.
    pub(crate) fn caret_word(&self, node: NodeId, offset: u32) -> Option<(NodeId, u32, NodeId, u32)> {
        let (text, offset) = if self.get(node).is_some_and(is_text) { (node, offset) } else { (self.first_nonempty_text(node)?, 0) };
        let data = &self.get(text)?.data;
        let mut start = (offset as usize).min(data.len());
        let mut end = start;
        while start > 0 && word_unit(data[start - 1]) {
            start -= 1;
        }
        while end < data.len() && word_unit(data[end]) {
            end += 1;
        }
        let block = self.block_of(text);
        let (mut from, mut to) = ((text, start as u32), (text, end as u32));
        if start == 0 {
            from = self.extend_word(text, false, block);
        }
        if end == data.len() {
            to = self.extend_word(text, true, block);
        }
        (from != to).then_some((from.0, from.1, to.0, to.1))
    }
    // …the word's edge past `leaf`'s, back (on, with `forward`): leaf by leaf while the next leaf in the block starts
    // (ends) with a word character, to where its word ends.
    fn extend_word(&self, leaf: NodeId, forward: bool, block: Option<NodeId>) -> (NodeId, u32) {
        let mut edge = (leaf, if forward { self.get(leaf).map_or(0, |n| n.data.len() as u32) } else { 0 });
        let mut cur = self.adjacent_text_leaf(leaf, forward);
        while let Some(c) = cur.filter(|&c| self.block_of(c) == block) {
            let Some(d) = self.get(c).map(|n| &n.data) else { break };
            if d.is_empty() {
                cur = self.adjacent_text_leaf(c, forward);
                continue;
            }
            if !word_unit(if forward { d[0] } else { d[d.len() - 1] }) {
                break;
            }
            if forward {
                let off = d.iter().position(|&u| !word_unit(u)).unwrap_or(d.len());
                edge = (c, off as u32);
                if off < d.len() {
                    break;
                }
            } else {
                let off = d.iter().rposition(|&u| !word_unit(u)).map_or(0, |i| i + 1);
                edge = (c, off as u32);
                if off > 0 {
                    break;
                }
            }
            cur = self.adjacent_text_leaf(c, forward);
        }
        edge
    }
    // The first text leaf under `root` with any text, in tree order.
    fn first_nonempty_text(&self, root: NodeId) -> Option<NodeId> {
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let n = self.get(id)?;
            if is_text(n) && !n.data.is_empty() {
                return Some(id);
            }
            stack.extend(n.children.iter().rev());
        }
        None
    }
}

// A word character, as a UTF-16 unit is one (`/[\p{L}\p{N}_]/u` tests the string's units): a letter, a number or `_`;
// a surrogate half none.
fn word_unit(u: u16) -> bool {
    u == u16::from(b'_') || (!(0xD800..=0xDFFF).contains(&u) && (crate::unicode::is_letter(u32::from(u)) || crate::unicode::is_number(u32::from(u))))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "caretStep", caret_step, context_id);
    crate::dom::register(scope, ns, "caretBlockEdge", caret_block_edge, context_id);
    crate::dom::register(scope, ns, "caretWord", caret_word, context_id);
}

// [nodes, offsets…] for points of `nodes` — the nodes as `nodes_value` answers them.
fn points<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, nodes: &[NodeId], offsets: &[u32]) -> v8::Local<'s, v8::Value> {
    let mut values = vec![crate::dom::nodes_value(scope, cid, nodes)];
    values.extend(offsets.iter().map(|&o| -> v8::Local<'_, v8::Value> { v8::Integer::new_from_unsigned(scope, o).into() }));
    v8::Array::new_with_elements(scope, &values).into()
}

// __dom.caretStep(nid, offset, forward) -> [[node], offset] (`caret_step`), or undefined where the caret stays.
fn caret_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let forward = args.get(2).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((to, at)) = crate::dom::realm(scope, cid).caret_step(node, offset, forward) {
        rv.set(points(scope, cid, &[to], &[at]));
    }
}

// __dom.caretBlockEdge(nid, end) -> [[node], offset] (`caret_block_edge`), or undefined for no block.
fn caret_block_edge(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let end = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((to, at)) = crate::dom::realm(scope, cid).caret_block_edge(node, end) {
        rv.set(points(scope, cid, &[to], &[at]));
    }
}

// __dom.caretWord(nid, offset) -> [[startNode, endNode], startOffset, endOffset] (`caret_word`), or undefined.
fn caret_word(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((s, so, e, eo)) = crate::dom::realm(scope, cid).caret_word(node, offset) {
        rv.set(points(scope, cid, &[s, e], &[so, eo]));
    }
}
