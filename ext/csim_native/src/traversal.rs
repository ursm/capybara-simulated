// The DOM's questions of tree order over the arena's trees: where one node is against another (`compareDocumentPosition`,
// DOM §4.4), and the traversals of a TreeWalker and a NodeIterator (DOM §6) — over node trees, which a shadow root is the
// root of.
//
// A traversal's filter is the page's: the engine calls it on each node `whatToShow` shows, and it may change the tree
// as it runs, which the traversal then goes on over. Where a node is, the page side is told as the steps the traversal
// took from where it last was — up to the parent, down to the first or last child, across to the next or previous
// sibling — which it takes in its own tree to have the object it hands the filter (and the node it answers with).

use crate::dom::{nid_arg, realm_id, NodeId, NodeKind, RealmArena, Relation};

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

// ── traversal (DOM §6) ──────────────────────────────────────────────────────────────────────────────────────────

// What the page side is told of where a traversal is: a status (0 for none; else 1, or 2 where a NodeIterator is before
// the node) and the steps to the node — one number where they fit, the status under base-5 digits of the steps from the
// first up, under a leading 1; else an array, the status and the steps.
fn answer_value<'s>(scope: &mut v8::PinScope<'s, '_>, status: u8, steps: &[u8]) -> v8::Local<'s, v8::Value> {
    // (…5^21 · 3 < 2^53)
    if steps.len() <= 21 {
        let code = steps.iter().rev().fold(1.0, |code, &s| code * 5.0 + s as f64);
        return v8::Number::new(scope, code * 3.0 + status as f64).into();
    }
    let all: Vec<f64> = std::iter::once(status as f64).chain(steps.iter().map(|&s| s as f64)).collect();
    crate::dom::f64_array(scope, &all).into()
}

// A step from one node to the next, as the page side takes it.
#[derive(Clone, Copy)]
enum Step {
    Parent = 0,
    FirstChild = 1,
    LastChild = 2,
    NextSibling = 3,
    PreviousSibling = 4,
}

const FILTER_ACCEPT: u32 = 1;
const FILTER_REJECT: u32 = 2;
const FILTER_SKIP: u32 = 3;

fn neighbour(arena: &RealmArena, id: NodeId, step: Step) -> Option<NodeId> {
    let sibling = |by: isize| {
        let parent = arena.parent_of(id)?;
        let i = arena.child_index(id).checked_add_signed(by)?;
        arena.get(parent)?.children.get(i).copied()
    };
    match step {
        Step::Parent => arena.parent_of(id),
        Step::FirstChild => arena.get(id)?.children.first().copied(),
        Step::LastChild => arena.get(id)?.children.last().copied(),
        Step::NextSibling => sibling(1),
        Step::PreviousSibling => sibling(-1),
    }
}

// Where a traversal is: its node, and the steps to it the page side has not taken yet.
struct Walk<'s> {
    cid: i32,
    root: NodeId,
    what_to_show: u32,
    // The page's filter (None for none): handed the steps, it takes them and answers for the node it reaches.
    filter: Option<v8::Local<'s, v8::Function>>,
    node: NodeId,
    steps: Vec<u8>,
    // Whether a NodeIterator is before the node, where its filter moved it.
    moved_before: Option<bool>,
    // A TreeWalker's current node — the filter may set it as it runs.
    current: NodeId,
}

// The filter threw: the traversal stops, and its exception is the caller's.
struct Thrown;

thread_local! {
    // Where a NodeIterator's filter moved the node it was handed (`__dom.traverseFrom`): a removal while it ran took the
    // node with it, and the iterator's pre-removing steps moved the node it is at — and whether it is now before it.
    static MOVED: std::cell::Cell<Option<(NodeId, bool)>> = const { std::cell::Cell::new(None) };
    // …and where a TreeWalker's filter set the walker's current node (`__dom.traverseCurrent`).
    static CURRENT: std::cell::Cell<Option<NodeId>> = const { std::cell::Cell::new(None) };
}

impl<'s> Walk<'s> {
    fn arena<'a>(&self, scope: &'a mut v8::PinScope<'s, '_>) -> &'a RealmArena {
        crate::dom::realm(scope, self.cid)
    }
    // The node a step from `from` reaches, if any — not taken.
    fn peek(&self, scope: &mut v8::PinScope<'s, '_>, from: NodeId, step: Step) -> Option<NodeId> {
        neighbour(self.arena(scope), from, step)
    }
    // Take a step from the current node, if there is one to take.
    fn go(&mut self, scope: &mut v8::PinScope<'s, '_>, step: Step) -> bool {
        match self.peek(scope, self.node, step) {
            Some(next) => {
                self.node = next;
                self.steps.push(step as u8);
                true
            }
            None => false,
        }
    }
    // DOM "filter" the current node: FILTER_SKIP where `whatToShow` hides it, else the filter's answer — FILTER_ACCEPT
    // with none.
    fn filter(&mut self, scope: &mut v8::PinScope<'s, '_>) -> Result<u32, Thrown> {
        let shown = self.arena(scope).get(self.node).is_some_and(|n| self.what_to_show & (1 << (n.node_type() - 1)) != 0);
        if !shown {
            return Ok(FILTER_SKIP);
        }
        let Some(filter) = self.filter else { return Ok(FILTER_ACCEPT) };
        let steps = answer_value(scope, 0, &self.steps);
        self.steps.clear();
        let undefined = v8::undefined(scope).into();
        let answer = filter.call(scope, undefined, &[steps]);
        if let Some((node, before)) = MOVED.take() {
            self.node = node;
            self.moved_before = Some(before);
        }
        if let Some(current) = CURRENT.take() {
            self.current = current;
        }
        Ok(answer.ok_or(Thrown)?.uint32_value(scope).unwrap_or(0))
    }
    // What the traversal answers: the node it ended on (`found`), with a status, or none.
    fn answer<'v>(&self, scope: &mut v8::PinScope<'v, '_>, found: bool, status: u8) -> v8::Local<'v, v8::Value> {
        answer_value(scope, if found { status } else { 0 }, if found { &self.steps } else { &[] })
    }

    // TreeWalker `parentNode()`.
    fn parent_node(&mut self, scope: &mut v8::PinScope<'s, '_>) -> Result<bool, Thrown> {
        while self.node != self.root {
            if !self.go(scope, Step::Parent) {
                return Ok(false);
            }
            if self.filter(scope)? == FILTER_ACCEPT {
                return Ok(true);
            }
        }
        Ok(false)
    }
    // TreeWalker "traverse children": `firstChild()` (`first`) or `lastChild()`.
    fn children(&mut self, scope: &mut v8::PinScope<'s, '_>, first: bool) -> Result<bool, Thrown> {
        let (into, across) = if first { (Step::FirstChild, Step::NextSibling) } else { (Step::LastChild, Step::PreviousSibling) };
        if !self.go(scope, into) {
            return Ok(false);
        }
        loop {
            let result = self.filter(scope)?;
            if result == FILTER_ACCEPT {
                return Ok(true);
            }
            // (…a skipped node's children are its own place to look)
            if result == FILTER_SKIP && self.go(scope, into) {
                continue;
            }
            loop {
                if self.go(scope, across) {
                    break;
                }
                let parent = self.peek(scope, self.node, Step::Parent);
                if parent.is_none() || parent == Some(self.root) || parent == Some(self.current) {
                    return Ok(false);
                }
                self.go(scope, Step::Parent);
            }
        }
    }
    // TreeWalker "traverse siblings": `nextSibling()` (`next`) or `previousSibling()`.
    fn siblings(&mut self, scope: &mut v8::PinScope<'s, '_>, next: bool) -> Result<bool, Thrown> {
        let (across, into) = if next { (Step::NextSibling, Step::FirstChild) } else { (Step::PreviousSibling, Step::LastChild) };
        if self.node == self.root {
            return Ok(false);
        }
        loop {
            if self.go(scope, across) {
                loop {
                    let result = self.filter(scope)?;
                    if result == FILTER_ACCEPT {
                        return Ok(true);
                    }
                    if !(result != FILTER_REJECT && self.go(scope, into)) && !self.go(scope, across) {
                        break;
                    }
                }
            }
            if !self.go(scope, Step::Parent) || self.node == self.root {
                return Ok(false);
            }
            if self.filter(scope)? == FILTER_ACCEPT {
                return Ok(false);
            }
        }
    }
    // TreeWalker `nextNode()`.
    fn next_node(&mut self, scope: &mut v8::PinScope<'s, '_>) -> Result<bool, Thrown> {
        let mut result = FILTER_ACCEPT;
        loop {
            while result != FILTER_REJECT && self.go(scope, Step::FirstChild) {
                result = self.filter(scope)?;
                if result == FILTER_ACCEPT {
                    return Ok(true);
                }
            }
            // (…the next sibling of the node or of the nearest ancestor below the root that has one)
            loop {
                if self.node == self.root {
                    return Ok(false);
                }
                if self.go(scope, Step::NextSibling) {
                    break;
                }
                if !self.go(scope, Step::Parent) {
                    return Ok(false);
                }
            }
            result = self.filter(scope)?;
            if result == FILTER_ACCEPT {
                return Ok(true);
            }
        }
    }
    // TreeWalker `previousNode()`.
    fn previous_node(&mut self, scope: &mut v8::PinScope<'s, '_>) -> Result<bool, Thrown> {
        while self.node != self.root {
            while self.go(scope, Step::PreviousSibling) {
                let mut result = self.filter(scope)?;
                while result != FILTER_REJECT && self.go(scope, Step::LastChild) {
                    result = self.filter(scope)?;
                }
                if result == FILTER_ACCEPT {
                    return Ok(true);
                }
            }
            if self.node == self.root || !self.go(scope, Step::Parent) {
                return Ok(false);
            }
            if self.filter(scope)? == FILTER_ACCEPT {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // The node after the current one in tree order within the root — into its children first, or not (`skip`) — taken.
    fn following(&mut self, scope: &mut v8::PinScope<'s, '_>, within: Option<NodeId>, skip: bool) -> bool {
        if !skip && self.go(scope, Step::FirstChild) {
            return true;
        }
        let (from, steps) = (self.node, self.steps.len());
        while Some(self.node) != within {
            if self.go(scope, Step::NextSibling) {
                return true;
            }
            if !self.go(scope, Step::Parent) {
                break;
            }
        }
        self.node = from;
        self.steps.truncate(steps);
        false
    }
    // The node before the current one in tree order within the root (the root itself included), taken.
    fn preceding(&mut self, scope: &mut v8::PinScope<'s, '_>) -> bool {
        if self.node == self.root {
            return false;
        }
        if self.go(scope, Step::PreviousSibling) {
            while self.go(scope, Step::LastChild) {}
            return true;
        }
        self.go(scope, Step::Parent)
    }
    // NodeIterator "traverse": `nextNode()` (`next`) or `previousNode()` from the reference (the current node), before
    // it or not — and where the iterator is then, before its new reference or not.
    fn iterate(&mut self, scope: &mut v8::PinScope<'s, '_>, next: bool, mut before: bool) -> Result<Option<bool>, Thrown> {
        loop {
            if next {
                if !before {
                    if !self.following(scope, Some(self.root), false) {
                        return Ok(None);
                    }
                } else {
                    before = false;
                }
            } else if before {
                if !self.preceding(scope) {
                    return Ok(None);
                }
            } else {
                before = true;
            }
            let result = self.filter(scope)?;
            if let Some(moved) = self.moved_before.take() {
                before = moved;
            }
            if result == FILTER_ACCEPT {
                return Ok(Some(before));
            }
        }
    }
}

// The traversals `__dom.traverse` runs, by number.
const PARENT_NODE: u32 = 0;
const FIRST_CHILD: u32 = 1;
const LAST_CHILD: u32 = 2;
const NEXT_SIBLING: u32 = 3;
const PREVIOUS_SIBLING: u32 = 4;
const NEXT_NODE: u32 = 5;
const PREVIOUS_NODE: u32 = 6;
const ITERATOR_NEXT: u32 = 7;
const ITERATOR_PREVIOUS: u32 = 8;

// __dom.traverse(kind, rootNid, currentNid, whatToShow, filter, before) -> a TreeWalker's (`kind` 0-6: parentNode,
// firstChild, lastChild, nextSibling, previousSibling, nextNode, previousNode) or a NodeIterator's (7 nextNode, 8
// previousNode; `before` its pointer) traversal from the current node (the iterator's reference): where it ends, as
// `answer_value` says — a status 1, or for an iterator 1 + whether it is before its new reference, and the steps from
// where `filter` last took them. `filter(steps)` takes the steps to the node it answers for (FILTER_ACCEPT / REJECT /
// SKIP) — and tells where it moved that node to, for an iterator (`traverseFrom`), or where it set the walker's current
// node (`traverseCurrent`); null for no filter. Nothing, where
// the filter threw.
fn traverse<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(root), Some(node)) = (nid_arg(scope, &args, 1), nid_arg(scope, &args, 2)) else { return };
    let kind = args.get(0).uint32_value(scope).unwrap_or(u32::MAX);
    let what_to_show = args.get(3).uint32_value(scope).unwrap_or(0);
    let filter = v8::Local::<v8::Function>::try_from(args.get(4)).ok();
    let before = args.get(5).is_true();
    let mut walk = Walk { cid: realm_id(scope, &args), root, what_to_show, filter, node, steps: Vec::new(), moved_before: None, current: node };
    let found = match kind {
        PARENT_NODE => walk.parent_node(scope).map(|f| f.then_some(1)),
        FIRST_CHILD | LAST_CHILD => walk.children(scope, kind == FIRST_CHILD).map(|f| f.then_some(1)),
        NEXT_SIBLING | PREVIOUS_SIBLING => walk.siblings(scope, kind == NEXT_SIBLING).map(|f| f.then_some(1)),
        NEXT_NODE => walk.next_node(scope).map(|f| f.then_some(1)),
        PREVIOUS_NODE => walk.previous_node(scope).map(|f| f.then_some(1)),
        ITERATOR_NEXT | ITERATOR_PREVIOUS => walk.iterate(scope, kind == ITERATOR_NEXT, before).map(|b| b.map(|before| 1 + before as u8)),
        _ => return,
    };
    if let Ok(found) = found {
        let answer = walk.answer(scope, found.is_some(), found.unwrap_or(0));
        rv.set(answer);
    }
}

// __dom.traverseFrom(nid, before): a NodeIterator's filter, which the traversal handed a node, moved it to `nid` (before
// it or not) — the traversal goes on from there.
fn traverse_from(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(node) = nid_arg(scope, &args, 0) {
        MOVED.set(Some((node, args.get(1).is_true())));
    }
}

// __dom.traverseCurrent(nid): a TreeWalker's filter set the walker's current node to `nid` — which the traversal reads
// as it goes on ("traverse children" stops at it).
fn traverse_current(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(node) = nid_arg(scope, &args, 0) {
        CURRENT.set(Some(node));
    }
}

// __dom.iteratorPreRemove(removedNid, rootNid, referenceNid, before) -> the NodeIterator "pre-removing steps" for the
// removal of `removedNid`: null where the iterator stays as it is, else where its reference is then, as `answer_value`
// says — 1, or 2 where it is before it, and the steps to it from the removed node.
fn iterator_pre_remove(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let (Some(removed), Some(root), Some(reference)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1), nid_arg(scope, &args, 2)) else { return };
    let mut before = args.get(3).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    // (…a removal of the root, or of an ancestor of it, takes the iterator's whole tree with it; one of no ancestor of the
    // reference leaves it where it is)
    let contains = |a: NodeId, b: NodeId| matches!(arena.relation(a, b), Some(Relation::Same | Relation::Ancestor));
    if contains(removed, root) || !contains(removed, reference) {
        return;
    }
    let mut walk = Walk { cid, root, what_to_show: 0, filter: None, node: removed, steps: Vec::new(), moved_before: None, current: removed };
    // (…before it: the first node following the removed one and not in it, under the root)
    if before {
        if walk.following(scope, Some(root), true) {
            let answer = walk.answer(scope, true, 2);
            return rv.set(answer);
        }
        before = false;
    }
    // …else the last node of the removed one's previous sibling, or its parent
    if walk.go(scope, Step::PreviousSibling) {
        while walk.go(scope, Step::LastChild) {}
    } else {
        walk.go(scope, Step::Parent);
    }
    let answer = walk.answer(scope, true, 1 + before as u8);
    rv.set(answer);
}

// __dom.iteratorPreRemoveAll(parentNid, rootNid, referenceNid, before) -> the NodeIterator pre-removing steps for the
// removal of every child of `parentNid`, one after another, at once: null where the iterator stays as it is, else where
// its reference is then, as `iteratorPreRemove` answers, from the parent. A reference under the parent goes — the
// children before its own gone first, and each following one in turn the reference while it is before it — to what
// follows the last child under the root, before it; else to the parent, after it.
fn iterator_pre_remove_all(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let (Some(parent), Some(root), Some(reference)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1), nid_arg(scope, &args, 2)) else { return };
    let before = args.get(3).is_true();
    let cid = realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    // (…the child the reference is in; one that holds the root takes the iterator's whole tree with it)
    if arena.relation(parent, reference) != Some(Relation::Ancestor) {
        return;
    }
    let child = arena.chain(reference).into_iter().skip_while(|&n| n != parent).nth(1);
    if child.is_none_or(|c| matches!(arena.relation(c, root), Some(Relation::Same | Relation::Ancestor))) {
        return;
    }
    let mut walk = Walk { cid, root, what_to_show: 0, filter: None, node: parent, steps: Vec::new(), moved_before: None, current: parent };
    if before && walk.go(scope, Step::LastChild) && walk.following(scope, Some(root), true) {
        let answer = walk.answer(scope, true, 2);
        return rv.set(answer);
    }
    let answer = answer_value(scope, 1, &[]);
    rv.set(answer);
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "iteratorPreRemoveAll", iterator_pre_remove_all, context_id);
    crate::dom::register(scope, ns, "comparePosition", compare_position, context_id);
    crate::dom::register(scope, ns, "traverse", traverse, context_id);
    crate::dom::register(scope, ns, "traverseFrom", traverse_from, context_id);
    crate::dom::register(scope, ns, "traverseCurrent", traverse_current, context_id);
    crate::dom::register(scope, ns, "iteratorPreRemove", iterator_pre_remove, context_id);
    crate::dom::register(scope, ns, "isEqualNode", is_equal_node, context_id);
    crate::dom::register(scope, ns, "textContent", text_content, context_id);
}

impl RealmArena {
    // DOM §4.4 "equals": two nodes of one type — a doctype by its name and identifiers, an element by its namespace,
    // prefix, local name and attributes (each of one in the other, by namespace, local name and value, in any order), a
    // processing instruction by its target and data, character data by its data — with as many children, each equal.
    pub(crate) fn is_equal_node(&self, a: NodeId, b: NodeId) -> bool {
        let (Some(x), Some(y)) = (self.get(a), self.get(b)) else { return false };
        if x.node_type() != y.node_type() {
            return false;
        }
        let same = match x.kind {
            NodeKind::Element => {
                let (xs, ys) = (x.attribute_list(), y.attribute_list());
                x.ns == y.ns
                    && x.prefix == y.prefix
                    && x.name_u16 == y.name_u16
                    && x.local_name == y.local_name
                    && xs.len() == ys.len()
                    && xs.iter().all(|p| ys.iter().any(|q| p.ns == q.ns && p.local == q.local && p.value == q.value))
            }
            NodeKind::ProcessingInstruction => x.local_name == y.local_name && x.data == y.data,
            NodeKind::Text | NodeKind::Comment => x.data == y.data,
            NodeKind::Other => x.data == y.data && x.doctype_ids == y.doctype_ids,
            NodeKind::Document | NodeKind::Fragment => true,
        };
        same && x.children.len() == y.children.len()
            && x.children.iter().zip(&y.children).all(|(&c, &d)| self.is_equal_node(c, d))
    }
    // DOM's "descendant text content": the data of the node's Text descendants (CDATA sections included), in tree order.
    pub(crate) fn text_content(&self, id: NodeId) -> Vec<u16> {
        let mut out = Vec::new();
        let mut stack = vec![id];
        while let Some(c) = stack.pop() {
            let Some(n) = self.get(c) else { continue };
            if n.kind == NodeKind::Text {
                out.extend_from_slice(&n.data);
            } else {
                stack.extend(n.children.iter().rev());
            }
        }
        out
    }
}

// __dom.isEqualNode(a, b) -> whether the two nodes are equal (`is_equal_node`).
fn is_equal_node(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let (Some(a), Some(b)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).is_equal_node(a, b));
}

// __dom.textContent(nid) -> the node's descendant text content (`text_content`).
fn text_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let text = crate::dom::realm(scope, cid).text_content(id);
    if let Some(string) = v8::String::new_from_two_byte(scope, &text, v8::NewStringType::Normal) {
        rv.set(string.into());
    }
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
