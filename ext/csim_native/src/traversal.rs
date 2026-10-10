// The DOM's questions of tree order over the arena's trees: where one node is against another (`compareDocumentPosition`,
// DOM §4.4), and the traversals of a TreeWalker and a NodeIterator (DOM §6) — over node trees, which a shadow root is the
// root of.
//
// A traversal's filter is the page's: the engine calls it on each node `whatToShow` shows, handing it the node's
// object, and it may change the tree as it runs, which the traversal then goes on over.

use crate::dom::{nid_arg, realm_id, NodeData, NodeId, NodeKind, RealmArena, Relation};
use crate::node_iterators::Pointer;

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

// The object of the node `id` — which its handle holds — or undefined for one whose object V8 dropped.
fn node_object<'s>(scope: &mut v8::PinScope<'s, '_>, id: NodeId) -> v8::Local<'s, v8::Value> {
    let held = crate::dom::dom(scope).arena.get(id).and_then(|n| crate::node_handle::held(&n.link));
    match held.and_then(|h| h.get(scope)) {
        Some(object) => object.into(),
        None => v8::undefined(scope).into(),
    }
}
// What the page side is told of where a traversal is: 0 for nowhere, else `[status, node]` — a status 1, or 2 where a
// NodeIterator is before the node.
fn answer_value<'s>(scope: &mut v8::PinScope<'s, '_>, status: u8, node: Option<NodeId>) -> v8::Local<'s, v8::Value> {
    let Some(node) = node.filter(|_| status != 0) else { return v8::Integer::new(scope, 0).into() };
    let status = v8::Integer::new(scope, i32::from(status)).into();
    let object = node_object(scope, node);
    v8::Array::new_with_elements(scope, &[status, object]).into()
}

// A step from one node to the next.
#[derive(Clone, Copy)]
enum Step {
    Parent,
    FirstChild,
    LastChild,
    NextSibling,
    PreviousSibling,
}

const FILTER_ACCEPT: u32 = 1;
const FILTER_REJECT: u32 = 2;
const FILTER_SKIP: u32 = 3;

// …the node a step from `id` reaches: the tree's accessors' answer (`RealmArena::relative`), so a traversal sees the
// tree they do.
fn neighbour(arena: &RealmArena, id: NodeId, step: Step) -> Option<NodeId> {
    use crate::dom::{RELATIVE_FIRST_CHILD, RELATIVE_LAST_CHILD, RELATIVE_NEXT, RELATIVE_PARENT, RELATIVE_PREVIOUS};
    arena.relative(id, match step {
        Step::Parent => RELATIVE_PARENT,
        Step::FirstChild => RELATIVE_FIRST_CHILD,
        Step::LastChild => RELATIVE_LAST_CHILD,
        Step::NextSibling => RELATIVE_NEXT,
        Step::PreviousSibling => RELATIVE_PREVIOUS,
    })
}

// Where a traversal is: its node.
struct Walk<'s> {
    cid: i32,
    root: NodeId,
    what_to_show: u32,
    // The page's filter (None for none): handed a node's object, it answers for it.
    filter: Option<v8::Local<'s, v8::Function>>,
    node: NodeId,
    // Whether a NodeIterator is before the node, where its filter moved it.
    moved_before: Option<bool>,
    // A TreeWalker's current node — the filter may set it as it runs.
    current: NodeId,
    // A NodeIterator's entry (node_iterators.rs), whose working pointer the node handed its filter is — and whether
    // that pointer is before the node.
    iterator: Option<(u32, bool)>,
}

// The filter threw: the traversal stops, and its exception is the caller's.
struct Thrown;

thread_local! {
    // Where a TreeWalker's filter set the walker's current node (`__dom.traverseCurrent`).
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
        let node = node_object(scope, self.node);
        let undefined = v8::undefined(scope).into();
        // (…a NodeIterator's working pointer at the node, which a removal while the filter runs moves — the traversal
        // goes on from where it is then)
        if let Some((id, before)) = self.iterator {
            crate::node_iterators::push_working(scope, id, Pointer { node: self.node, before });
        }
        let answer = filter.call(scope, undefined, &[node]);
        if let Some((id, _)) = self.iterator {
            if let Some(w) = crate::node_iterators::pop_working(scope, id).filter(|w| w.node != self.node) {
                self.node = w.node;
                self.moved_before = Some(w.before);
            }
        }
        if let Some(current) = CURRENT.take() {
            self.current = current;
        }
        Ok(answer.ok_or(Thrown)?.uint32_value(scope).unwrap_or(0))
    }
    // What the traversal answers: the node it ended on (`found`), with a status, or none.
    fn answer<'v>(&self, scope: &mut v8::PinScope<'v, '_>, found: bool, status: u8) -> v8::Local<'v, v8::Value> {
        answer_value(scope, if found { status } else { 0 }, Some(self.node))
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
        let from = self.node;
        while Some(self.node) != within {
            if self.go(scope, Step::NextSibling) {
                return true;
            }
            if !self.go(scope, Step::Parent) {
                break;
            }
        }
        self.node = from;
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

// __dom.traverse(kind, rootNid, currentNid, whatToShow, filter) -> a TreeWalker's traversal (`kind` 0-6: parentNode,
// firstChild, lastChild, nextSibling, previousSibling, nextNode, previousNode) from the current node: where it ends, as
// `answer_value` says — a status 1, and the node. `filter(node)` answers for the node it is handed (FILTER_ACCEPT /
// REJECT / SKIP) — and tells where it set the walker's current node (`traverseCurrent`); null for no filter. Nothing,
// where the filter threw.
fn traverse<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(root), Some(node)) = (nid_arg(scope, &args, 1), nid_arg(scope, &args, 2)) else { return };
    let kind = args.get(0).uint32_value(scope).unwrap_or(u32::MAX);
    let what_to_show = args.get(3).uint32_value(scope).unwrap_or(0);
    let filter = v8::Local::<v8::Function>::try_from(args.get(4)).ok();
    let mut walk = Walk { cid: realm_id(scope, &args), root, what_to_show, filter, node, moved_before: None, current: node, iterator: None };
    let found = match kind {
        PARENT_NODE => walk.parent_node(scope),
        FIRST_CHILD | LAST_CHILD => walk.children(scope, kind == FIRST_CHILD),
        NEXT_SIBLING | PREVIOUS_SIBLING => walk.siblings(scope, kind == NEXT_SIBLING),
        NEXT_NODE => walk.next_node(scope),
        PREVIOUS_NODE => walk.previous_node(scope),
        _ => return,
    };
    if let Ok(found) = found {
        let answer = walk.answer(scope, found, 1);
        rv.set(answer);
    }
}

// __dom.iteratorTraverse(handle, next, whatToShow, filter) -> a NodeIterator's `nextNode()` (`next`) or `previousNode()`
// from its reference (node_iterators.rs): the node it lands on, which is its reference then, or null; `filter` as
// `traverse` takes it. Nothing, where the filter threw.
fn iterator_traverse<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some((id, root, at)) = crate::node_iterators::traversal_start(scope, args.get(0)) else { return };
    let next = args.get(1).is_true();
    let what_to_show = args.get(2).uint32_value(scope).unwrap_or(0);
    let filter = v8::Local::<v8::Function>::try_from(args.get(3)).ok();
    let cid = realm_id(scope, &args);
    let iterator = Some((id, !next));
    let mut walk = Walk { cid, root, what_to_show, filter, node: at.node, moved_before: None, current: at.node, iterator };
    let Ok(found) = walk.iterate(scope, next, at.before) else { return };
    match found {
        Some(before) => {
            crate::node_iterators::traversal_end(scope, id, Pointer { node: walk.node, before });
            rv.set(crate::dom::node_value(scope, Some(walk.node)));
        }
        None => rv.set_null(),
    }
}

// __dom.traverseCurrent(nid): a TreeWalker's filter set the walker's current node to `nid` — which the traversal reads
// as it goes on ("traverse children" stops at it).
fn traverse_current(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(node) = nid_arg(scope, &args, 0) {
        CURRENT.set(Some(node));
    }
}

// The node after `from` in tree order within `root` — into its children first unless `skip`.
fn following(arena: &RealmArena, from: NodeId, root: NodeId, skip: bool) -> Option<NodeId> {
    if !skip {
        if let Some(c) = neighbour(arena, from, Step::FirstChild) {
            return Some(c);
        }
    }
    let mut cur = from;
    while cur != root {
        if let Some(n) = neighbour(arena, cur, Step::NextSibling) {
            return Some(n);
        }
        cur = neighbour(arena, cur, Step::Parent)?;
    }
    None
}

// The NodeIterator "pre-removing steps" for the removal of `removed`, of one of an iterator's pointers (its root `root`):
// None where it stays as it is, else where it is then.
pub(crate) fn pre_remove(arena: &RealmArena, removed: NodeId, root: NodeId, at: Pointer) -> Option<Pointer> {
    // (…a removal of the root, or of an ancestor of it, takes the iterator's whole tree with it; one of no ancestor of the
    // reference leaves it where it is)
    let contains = |a: NodeId, b: NodeId| matches!(arena.relation(a, b), Some(Relation::Same | Relation::Ancestor));
    if contains(removed, root) || !contains(removed, at.node) {
        return None;
    }
    // (…before it: the first node following the removed one and not in it, under the root)
    if at.before {
        if let Some(n) = following(arena, removed, root, true) {
            return Some(Pointer { node: n, before: true });
        }
    }
    // …else the last node of the removed one's previous sibling, or its parent
    let node = match neighbour(arena, removed, Step::PreviousSibling) {
        Some(mut n) => {
            while let Some(last) = neighbour(arena, n, Step::LastChild) {
                n = last;
            }
            n
        }
        None => neighbour(arena, removed, Step::Parent)?,
    };
    Some(Pointer { node, before: false })
}

// …for the removal of every child of `parent`, one after another, at once: a pointer under the parent goes — the children
// before its own gone first, and each following one in turn the pointer while it is before it — to what follows the
// last child under the root, before it; else to the parent, after it.
pub(crate) fn pre_remove_all(arena: &RealmArena, parent: NodeId, root: NodeId, at: Pointer) -> Option<Pointer> {
    // (…the child the pointer is in; one that holds the root takes the iterator's whole tree with it)
    if arena.relation(parent, at.node) != Some(Relation::Ancestor) {
        return None;
    }
    let child = arena.chain(at.node).into_iter().skip_while(|&n| n != parent).nth(1);
    if child.is_none_or(|c| matches!(arena.relation(c, root), Some(Relation::Same | Relation::Ancestor))) {
        return None;
    }
    if at.before {
        let last = neighbour(arena, parent, Step::LastChild);
        if let Some(n) = last.and_then(|l| following(arena, l, root, true)) {
            return Some(Pointer { node: n, before: true });
        }
    }
    Some(Pointer { node: parent, before: false })
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "comparePosition", compare_position, context_id);
    crate::dom::register(scope, ns, "traverse", traverse, context_id);
    crate::dom::register(scope, ns, "iteratorTraverse", iterator_traverse, context_id);
    crate::dom::register(scope, ns, "traverseCurrent", traverse_current, context_id);
    crate::dom::register(scope, ns, "isEqualNode", is_equal_node, context_id);
    crate::dom::register(scope, ns, "textContent", text_content, context_id);
}

impl RealmArena {
    // DOM §4.4 "equals": two nodes of one type — a doctype by its name and identifiers, an element by its namespace,
    // prefix, local name and attributes (each of one in the other, by namespace, local name and value, in any order), a
    // processing instruction by its target and data, character data by its data — with as many children, each equal:
    // pair by pair, in tree order, the names compared exactly (a lone surrogate is no U+FFFD).
    pub(crate) fn is_equal_node(&self, a: NodeId, b: NodeId) -> bool {
        let mut pairs = vec![(a, b)];
        while let Some((a, b)) = pairs.pop() {
            let (Some(x), Some(y)) = (self.get(a), self.get(b)) else { return false };
            if x.node_type() != y.node_type() || x.children.len() != y.children.len() {
                return false;
            }
            let same = match x.kind {
                NodeKind::Element => {
                    let (xs, ys) = (exact_attributes(x), exact_attributes(y));
                    x.same_name(y) && xs.len() == ys.len() && xs.iter().all(|p| ys.contains(p))
                }
                NodeKind::ProcessingInstruction => x.local_name == y.local_name && x.data == y.data,
                NodeKind::Text | NodeKind::Comment => x.data == y.data,
                NodeKind::Other => x.data == y.data && x.doctype_ids == y.doctype_ids,
                NodeKind::Document | NodeKind::Fragment => true,
            };
            if !same {
                return false;
            }
            pairs.extend(x.children.iter().copied().zip(y.children.iter().copied()).rev());
        }
        true
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

// An element's attributes as `is_equal_node` compares them: each one's namespace (empty for none), local name and value,
// exactly.
fn exact_attributes(n: &NodeData) -> Vec<(Vec<u16>, Vec<u16>, Vec<u16>)> {
    let namespaced: Vec<_> = n.namespaced_attributes().map(|(key, ns, local)| (key, ns.into_owned(), local.into_owned())).collect();
    n.attributes
        .iter()
        .map(|(key, _)| {
            let value = n.attr_units(key).map(std::borrow::Cow::into_owned).unwrap_or_default();
            match namespaced.iter().find(|(k, _, _)| *k == key) {
                Some((_, ns, local)) => (ns.clone(), local.clone(), value),
                None => (Vec::new(), key.encode_utf16().collect(), value),
            }
        })
        .collect()
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
