// The DOM's questions of tree order over the arena's trees: where one node is against another (`compareDocumentPosition`,
// DOM §4.4) — a node's place in its node tree, which a shadow root is the root of.

use std::cmp::Ordering;

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena};

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
    attr: Option<u32>,
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
    let Some(order) = arena.tree_order(n1, n2) else { return disconnected() };
    let ancestor = |a: NodeId, of: NodeId| arena.chain(of).contains(&a);
    match order {
        Ordering::Less if other.attr.is_none() && ancestor(n1, n2) => CONTAINS | PRECEDING,
        Ordering::Greater if this.attr.is_none() && ancestor(n2, n1) => CONTAINED_BY | FOLLOWING,
        Ordering::Less => PRECEDING,
        _ => FOLLOWING,
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "comparePosition", compare_position, context_id);
}

// __dom.comparePosition(node1, attr1, tie1, node2, attr2, tie2) -> `node2.compareDocumentPosition(node1)` of two
// different nodes, each given as its slot — an Attr's as its element's (null for none) and its index in that element's
// attribute list (-1 for a node that is no Attr) — and a number telling it from the other (an Attr's own slot).
fn compare_position(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let side = |scope: &mut v8::PinScope<'_, '_>, i: i32| Side {
        node: nid_arg(scope, &args, i),
        attr: args.get(i + 1).int32_value(scope).and_then(|a| u32::try_from(a).ok()),
        tie: args.get(i + 2).number_value(scope).unwrap_or(0.0),
    };
    let (other, this) = (side(scope, 0), side(scope, 3));
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_uint32(position(arena, &other, &this));
}
