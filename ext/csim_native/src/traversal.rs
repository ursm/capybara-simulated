// The DOM's questions of tree order over the arena's trees: where one node is against another (`compareDocumentPosition`,
// DOM §4.4) — a node's place in its node tree, which a shadow root is the root of.

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena, Relation};

const DISCONNECTED: u32 = 0x01;
const PRECEDING: u32 = 0x02;
const FOLLOWING: u32 = 0x04;
const CONTAINS: u32 = 0x08;
const CONTAINED_BY: u32 = 0x10;
const IMPLEMENTATION_SPECIFIC: u32 = 0x20;

// One side of the comparison: the node, or an Attr's element (None for an Attr with none), and the Attr's place in that
// element's attribute list; and what tells it apart from the other side where the two are in no one tree (its slot).
struct Side {
    node: Option<NodeId>,
    attr: Option<usize>,
    tie: f64,
}

// DOM `compareDocumentPosition`: where `other` (node1) is against `this` (node2) — two different nodes.
fn position(arena: &RealmArena, other: &Side, this: &Side) -> u32 {
    // (…two attributes of one element: their order in its attribute list)
    if let (Some(a1), Some(a2)) = (other.attr, this.attr) {
        if other.node.is_some() && other.node == this.node {
            return IMPLEMENTATION_SPECIFIC | if a1 < a2 { PRECEDING } else { FOLLOWING };
        }
    }
    // (…in no one tree: a consistent answer either way)
    let disconnected = || DISCONNECTED | IMPLEMENTATION_SPECIFIC | if other.tie < this.tie { PRECEDING } else { FOLLOWING };
    let (Some(n1), Some(n2)) = (other.node, this.node) else { return disconnected() };
    if n1 == n2 {
        // (…an element and an attribute of it: the element contains it)
        return if this.attr.is_some() { CONTAINS | PRECEDING } else { CONTAINED_BY | FOLLOWING };
    }
    // (…an attribute of an ancestor is no ancestor: it precedes)
    match arena.relation(n1, n2) {
        None => disconnected(),
        Some(Relation::Ancestor) if other.attr.is_none() => CONTAINS | PRECEDING,
        Some(Relation::Descendant) if this.attr.is_none() => CONTAINED_BY | FOLLOWING,
        Some(Relation::Ancestor | Relation::Before) => PRECEDING,
        Some(_) => FOLLOWING,
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "comparePosition", compare_position, context_id);
}

// __dom.comparePosition(node1, attr1, tie1, node2, attr2, tie2) -> `node2.compareDocumentPosition(node1)` of two
// different nodes, each given as its slot — an Attr's as its element's (null for none) and its store key there (null for
// a node that is no Attr) — and a number telling it from the other (an Attr's own slot).
fn compare_position(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let side = |scope: &mut v8::PinScope<'_, '_>, i: i32| {
        let node = nid_arg(scope, &args, i);
        let key = args.get(i + 1);
        let key = (!key.is_null_or_undefined()).then(|| key.to_rust_string_lossy(scope));
        let tie = args.get(i + 2).number_value(scope).unwrap_or(0.0);
        let arena = crate::dom::realm(scope, cid);
        // (…an Attr's place in its element's attribute list, which the arena keeps in order — an Attr no longer in it is
        // in no tree)
        let Some(key) = key else { return Side { node, attr: None, tie } };
        let attr = node.and_then(|n| arena.get(n)?.attributes.iter().position(|(name, _)| *name == key));
        Side { node: node.filter(|_| attr.is_some()), attr, tie }
    };
    let (other, this) = (side(scope, 0), side(scope, 3));
    rv.set_uint32(position(crate::dom::realm(scope, cid), &other, &this));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{NodeData, NodeKind};

    fn element(arena: &mut RealmArena, parent: Option<NodeId>) -> NodeId {
        arena.create(NodeData::of_kind(NodeKind::Element, Vec::new()), parent)
    }
    fn side(node: Option<NodeId>, attr: Option<usize>, tie: f64) -> Side {
        Side { node, attr, tie }
    }

    #[test]
    fn positions() {
        let mut arena = RealmArena::default();
        let root = element(&mut arena, None);
        let (a, b) = (element(&mut arena, Some(root)), element(&mut arena, Some(root)));
        let lone = element(&mut arena, None);
        let at = |n: NodeId| side(Some(n), None, 0.0);
        // (…`other` against `this`)
        assert_eq!(position(&arena, &at(a), &at(b)), PRECEDING);
        assert_eq!(position(&arena, &at(b), &at(a)), FOLLOWING);
        assert_eq!(position(&arena, &at(root), &at(a)), CONTAINS | PRECEDING);
        assert_eq!(position(&arena, &at(a), &at(root)), CONTAINED_BY | FOLLOWING);
        // …two attributes of one element, by their place in its list; an element and an attribute of it
        assert_eq!(position(&arena, &side(Some(a), Some(0), 1.0), &side(Some(a), Some(1), 2.0)), IMPLEMENTATION_SPECIFIC | PRECEDING);
        assert_eq!(position(&arena, &side(Some(a), Some(1), 1.0), &side(Some(a), Some(0), 2.0)), IMPLEMENTATION_SPECIFIC | FOLLOWING);
        assert_eq!(position(&arena, &at(a), &side(Some(a), Some(0), 1.0)), CONTAINS | PRECEDING);
        assert_eq!(position(&arena, &side(Some(a), Some(0), 1.0), &at(a)), CONTAINED_BY | FOLLOWING);
        // …an attribute of an ancestor precedes (no ancestor itself); one of a descendant is contained
        assert_eq!(position(&arena, &side(Some(root), Some(0), 1.0), &at(a)), PRECEDING);
        assert_eq!(position(&arena, &side(Some(a), Some(0), 1.0), &at(root)), CONTAINED_BY | FOLLOWING);
        // …in no one tree, or an Attr with no element: disconnected, one direction each way
        let apart = position(&arena, &side(Some(lone), None, 1.0), &side(Some(a), None, 2.0));
        assert_eq!(apart, DISCONNECTED | IMPLEMENTATION_SPECIFIC | PRECEDING);
        assert_eq!(position(&arena, &side(Some(a), None, 2.0), &side(Some(lone), None, 1.0)), DISCONNECTED | IMPLEMENTATION_SPECIFIC | FOLLOWING);
        assert_eq!(position(&arena, &side(None, None, 3.0), &at(a)) & !(PRECEDING | FOLLOWING), DISCONNECTED | IMPLEMENTATION_SPECIFIC);
    }
}
