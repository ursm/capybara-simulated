// What `document.execCommand`'s editing commands act on, in an editing host (dom-nodes.js `_execCommand` makes the
// edits): the block holding the selection — a block container's nearest element at or above where it starts, within
// the host — the list item it is in, an ancestor of a kind, and the text a selection covers, as runs of text nodes with
// the slices of them inside it. Each walk is the engine's; the DOM edits the bindings make from the answers run the
// page's reactions.

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

// The elements the list, indent and justify commands treat as the BLOCK holding the selection.
const BLOCK_CONTAINER_TAGS: [&str; 20] = [
    "p", "div", "section", "article", "aside", "header", "footer", "nav", "main", "blockquote", "pre", "figure", "figcaption", "h1", "h2",
    "h3", "h4", "h5", "h6", "li",
];

fn is_block_container(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && BLOCK_CONTAINER_TAGS.contains(&&*n.local_name))
}

impl RealmArena {
    // Where a command starts from: `node` where the host holds it (or is it), else the host — a selection outside the
    // host never sends a walk past it.
    fn edit_anchor(&self, host: NodeId, node: NodeId) -> NodeId {
        let inside = matches!(self.relation(host, node), Some(crate::dom::Relation::Same | crate::dom::Relation::Ancestor));
        if inside { node } else { host }
    }

    // The nearest element at or above `from` (the anchor of the selection's start, entering the child at `offset`
    // where it is an element with children, with `descend`) whose tag `pick` takes — the host itself never.
    fn edit_ancestor(&self, host: NodeId, from: NodeId, offset: u32, descend: bool, pick: &dyn Fn(NodeId) -> bool) -> Option<NodeId> {
        let mut at = self.edit_anchor(host, from);
        if descend {
            if let Some(n) = self.get(at).filter(|n| n.kind == NodeKind::Element && !n.children.is_empty()) {
                at = n.children[(offset as usize).min(n.children.len() - 1)];
            }
        }
        let mut cur = Some(at);
        while let Some(id) = cur.filter(|&c| c != host) {
            if pick(id) {
                return Some(id);
            }
            cur = self.parent_of(id);
        }
        None
    }

    // The text the range `start`..`end` covers: each text node it holds any of, in tree order, with the slice of it
    // inside — a single text node's own slice; one wholly inside, the whole of it; a boundary one, from or to its offset.
    // None empty.
    pub(crate) fn covered_text(&self, (sc, so): (NodeId, u32), (ec, eo): (NodeId, u32)) -> Vec<(NodeId, u32, u32)> {
        let len = |id: NodeId| self.get(id).map_or(0, |n| n.data.len() as u32);
        let is_text = |id: NodeId| self.get(id).is_some_and(|n| n.kind == NodeKind::Text);
        if sc == ec && is_text(sc) {
            return if so < eo { vec![(sc, so, eo)] } else { Vec::new() };
        }
        let Some(common) = self.common_ancestor(sc, ec) else { return Vec::new() };
        let before_or_at = |a: (NodeId, u32), b: (NodeId, u32)| crate::ranges::compare_points(self, a, b).is_some_and(|o| o != std::cmp::Ordering::Greater);
        let mut out = Vec::new();
        let mut stack = vec![common];
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            stack.extend(n.children.iter().rev());
            let l = len(id);
            if !is_text(id) || l == 0 {
                continue;
            }
            let (a, b) = (if id == sc { so } else { 0 }, if id == ec { eo } else { l });
            let inside = id == sc || id == ec || (before_or_at((sc, so), (id, 0)) && before_or_at((id, l), (ec, eo)));
            if inside && a < b {
                out.push((id, a, b));
            }
        }
        out
    }

    // The inclusive ancestor of `a` that is an ancestor of `b` too, nearest first.
    fn common_ancestor(&self, a: NodeId, b: NodeId) -> Option<NodeId> {
        let chain = self.chain(b);
        self.chain(a).into_iter().rev().find(|n| chain.contains(n))
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editAncestor", edit_ancestor_op, context_id);
    crate::dom::register(scope, ns, "editCoveredText", edit_covered_text_op, context_id);
}

// The kinds of ancestor `editAncestor` looks for.
const BLOCK: i32 = 0;
const LIST_ITEM: i32 = 1;
const BLOCKQUOTE: i32 = 2;
const ANCHOR: i32 = 3;

// __dom.editAncestor(hostNid, nodeNid, offset, descend, kind) -> [the element] or [] (`edit_ancestor`): of kind 0 a
// block container, 1 a list item in an `<ol>` / `<ul>`, 2 a `<blockquote>`, 3 an `<a>`, as `nodes_value` answers.
fn edit_ancestor_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(host), Some(node)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let offset = args.get(2).uint32_value(scope).unwrap_or(0);
    let descend = args.get(3).is_true();
    let kind = args.get(4).int32_value(scope).unwrap_or(BLOCK);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let named = |id: NodeId, tag: &str| arena.get(id).is_some_and(|n| n.is_html_named(tag));
    let found = arena.edit_ancestor(host, node, offset, descend, &|id| match kind {
        LIST_ITEM => named(id, "li") && arena.parent_of(id).is_some_and(|p| named(p, "ol") || named(p, "ul")),
        BLOCKQUOTE => named(id, "blockquote"),
        ANCHOR => named(id, "a"),
        _ => is_block_container(arena, id),
    });
    let root = arena.shadow_including_root(host);
    rv.set(crate::dom::nodes_value(scope, cid, root, found.as_slice()));
}

// __dom.editCoveredText(startNid, startOffset, endNid, endOffset) -> [nodes, slices] (`covered_text`): the text nodes,
// as `nodes_value` answers from the start's tree, and a Float64Array of their slices, `[from, to]` each.
fn edit_covered_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return };
    let so = args.get(1).uint32_value(scope).unwrap_or(0);
    let eo = args.get(3).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let runs = arena.covered_text((sc, so), (ec, eo));
    let root = arena.shadow_including_root(sc);
    let nodes: Vec<NodeId> = runs.iter().map(|r| r.0).collect();
    let slices: Vec<f64> = runs.iter().flat_map(|r| [f64::from(r.1), f64::from(r.2)]).collect();
    let nodes_value = crate::dom::nodes_value(scope, cid, root, &nodes);
    let slices_value = crate::dom::f64_array(scope, &slices).into();
    rv.set(v8::Array::new_with_elements(scope, &[nodes_value, slices_value]).into());
}

#[cfg(test)]
mod tests {
    use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};
    use web_atoms::ns;

    fn element(arena: &mut RealmArena, parent: Option<NodeId>, name: &str) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = name.into();
        n.ns = ns!(html);
        arena.create(n, parent)
    }
    fn text(arena: &mut RealmArena, parent: NodeId, data: &str) -> NodeId {
        arena.create(NodeData::of_kind(NodeKind::Text, data.encode_utf16().collect()), Some(parent))
    }

    #[test]
    fn covered_text_and_blocks() {
        let mut arena = RealmArena::default();
        let host = element(&mut arena, None, "div");
        let p = element(&mut arena, Some(host), "p");
        let a = text(&mut arena, p, "hello ");
        let b = element(&mut arena, Some(p), "b");
        let w = text(&mut arena, b, "world");
        let q = element(&mut arena, Some(host), "p");
        let t = text(&mut arena, q, "tail");
        assert_eq!(arena.covered_text((a, 2), (w, 3)), vec![(a, 2, 6), (w, 0, 3)]);
        assert_eq!(arena.covered_text((p, 0), (t, 2)), vec![(a, 0, 6), (w, 0, 5), (t, 0, 2)]);
        assert_eq!(arena.covered_text((a, 3), (a, 3)), vec![]);
        let block = |id| crate::editing::is_block_container(&arena, id);
        assert_eq!(arena.edit_ancestor(host, w, 0, false, &block), Some(p));
        assert_eq!(arena.edit_ancestor(host, host, 1, true, &block), Some(q));
        assert_eq!(arena.edit_ancestor(host, host, 0, false, &block), None);
    }
}
