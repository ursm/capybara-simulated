// Focus (HTML §6.6): which elements are FOCUSABLE AREAS, and the order SEQUENTIAL FOCUS NAVIGATION (Tab / Shift-Tab)
// visits them in — the "sequential navigation search algorithm", recursive over focus scopes: the document, a shadow
// root (entered at its host's position) and a slot's assigned nodes (at the slot's). Within a scope the candidates go by
// tabindex, positive values ascending (ties in tree order), then 0 and the elements with none, in tree order; a negative
// tabindex is focusable by click and script but no stop, and a negative host or slot takes its whole scope out of the
// order — it is entered only from inside.

use std::cmp::Ordering;


use std::collections::HashMap;

use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};
use crate::style::StyleEngine;

// The HTML elements focusable by what they are (an `<input type=hidden>` excepted; a `<summary>` only as its details'
// summary, below).
const FOCUSABLE_TAGS: [&str; 9] = ["input", "textarea", "select", "button", "iframe", "embed", "object", "audio", "video"];

// Is `id` a focusable area: an element not actually disabled, with a valid `tabindex` — else focusable by its kind, a
// hyperlink, or editable — in no `inert` subtree, and being rendered or the fallback content of a rendered `<canvas>`,
// which generates no box of its own yet stays focusable. Rendered as a box that can take focus: not skipped (a closed
// `<details>`'s content) and not `visibility: hidden`, whose boxes "cannot receive focus" (CSS Display 3 §4; Chrome and
// Firefox, measured).
pub(crate) fn focusable(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> bool {
    let Some(n) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { return false };
    if arena.is_actually_disabled(id) || !candidate(arena, id, n) || inert(arena, id) {
        return false;
    }
    let rendered = |engine: &mut StyleEngine, id| crate::rendered::rendered(engine, arena, id, false, true, None, now);
    rendered(engine, id) || element_ancestors(arena, id).find(|&p| arena.get(p).is_some_and(|p| p.is_html_named("canvas"))).is_some_and(|c| rendered(engine, c))
}
fn candidate(arena: &RealmArena, id: NodeId, n: &NodeData) -> bool {
    if tabindex(n).is_some() {
        return true;
    }
    if n.is_html() {
        let tag = &*n.local_name;
        if FOCUSABLE_TAGS.contains(&tag) {
            return !(tag == "input" && n.plain_attr("type").is_some_and(|t| t.eq_ignore_ascii_case("hidden")));
        }
        if tag == "summary" && arena.is_details_summary(id) {
            return true;
        }
    }
    n.is_hyperlink() || editing_host(arena, id)
}
// A valid `tabindex`: an integer by the HTML rules, in the range of the IDL attribute's `long` (Chrome and Firefox,
// measured, ignore one past it).
fn tabindex(n: &NodeData) -> Option<i64> {
    n.plain_attr("tabindex").and_then(crate::validity::parse_html_integer).filter(|t| i32::try_from(*t).is_ok())
}
// An editing host itself (element_state.rs `editing_host`).
fn editing_host(arena: &RealmArena, id: NodeId) -> bool {
    arena.editing_host(id) == Some(id)
}
// Inert: the element or an element it is a flat-tree descendant of carries `inert` — up through the slot a node is
// assigned to, and from a shadow root to its host (Chrome and Firefox, measured: an `inert` around the slot makes its
// assigned content inert).
fn inert(arena: &RealmArena, id: NodeId) -> bool {
    std::iter::successors(Some(id), |&c| arena.get(c).and_then(|n| n.assigned_slot.filter(|&s| arena.get(s).is_some()).or(n.parent).or(n.host)))
        .any(|e| arena.get(e).is_some_and(|n| n.kind == NodeKind::Element && n.plain_attr("inert").is_some()))
}
// The element ancestors of `id`, nearest first, up to the first node that is none (a shadow root, a document).
fn element_ancestors(arena: &RealmArena, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    std::iter::successors(arena.parent_of(id), |&p| arena.parent_of(p)).take_while(|&p| arena.is_element(p))
}

// ── sequential navigation ────────────────────────────────────────────────────────────────────────────────────────
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    // A focus stop of its own…
    Stop,
    // …a scope owner that is none (a slot, a host that delegates focus or is not focusable)…
    Owner,
    // …or both: a focusable host that does not delegate.
    Both,
}

struct Item {
    el: NodeId,
    kind: Kind,
    // An owner's scope — built even where it is left out of the order, so focus a script put inside it still moves.
    sub: Option<Scope>,
    // Whether that scope joins the order (not for a negative tabindex).
    included: bool,
    group: i64,
    // Its place in the scope's tree order.
    tree_pos: usize,
}

impl Item {
    fn stop(&self) -> bool {
        self.kind != Kind::Owner
    }
    fn owner(&self) -> bool {
        self.kind != Kind::Stop
    }
    fn entered(&self) -> Option<&Scope> {
        self.sub.as_ref().filter(|_| self.included)
    }
}

struct Scope {
    owner: Option<NodeId>,
    // The candidates in tree order, and their indices in navigation order.
    tree: Vec<Item>,
    order: Vec<usize>,
}

struct Navigator<'a> {
    engine: &'a mut StyleEngine,
    arena: &'a RealmArena,
    now: f64,
    // Each radio button group's stop, by its tree, name and form owner, found once a navigation.
    radio_stops: HashMap<(NodeId, String, Option<NodeId>), Option<NodeId>>,
}

impl Navigator<'_> {
    fn focusable(&mut self, id: NodeId) -> bool {
        focusable(self.engine, self.arena, id, self.now)
    }

    fn classify(&mut self, el: NodeId) -> Option<Item> {
        let n = self.arena.get(el)?;
        let tabindex = tabindex(n);
        let negative = tabindex.is_some_and(|t| t < 0);
        let group = if negative { 0 } else { tabindex.unwrap_or(0) };
        let owner = |kind, sub| Some(Item { el, kind, sub: Some(sub), included: !negative, group, tree_pos: 0 });
        if n.is_html_named("slot") {
            let sub = self.slot_scope(el);
            return owner(Kind::Owner, sub);
        }
        if let Some(root) = n.shadow_root {
            let delegates = self.arena.get(root).is_some_and(|r| r.delegates_focus);
            let children = self.arena.get(root).map(|r| r.children.clone()).unwrap_or_default();
            let sub = self.scope(Some(el), &children);
            let stop = !delegates && !negative && self.focusable(el);
            return owner(if stop { Kind::Both } else { Kind::Owner }, sub);
        }
        if negative || !self.focusable(el) || self.unrepresentative_radio(el) {
            return None;
        }
        Some(Item { el, kind: Kind::Stop, sub: None, included: true, group, tree_pos: 0 })
    }

    // A radio button group is ONE stop: its focusable checked member, else its first focusable one. A named radio button
    // that is not that is no stop at all (the arrow keys move within the group).
    fn unrepresentative_radio(&mut self, el: NodeId) -> bool {
        let arena = self.arena;
        let Some(n) = arena.get(el) else { return false };
        let Some(name) = n.plain_attr("name").filter(|s| !s.is_empty() && n.is_html_named("input") && n.input_type() == "radio") else { return false };
        let key = (arena.root_of(el), name.to_owned(), arena.form_owner(el));
        if let Some(&stop) = self.radio_stops.get(&key) {
            return stop.is_some_and(|s| s != el);
        }
        let mut first = None;
        let mut checked = None;
        let mut stack = vec![key.0];
        while let Some(c) = stack.pop() {
            let Some(o) = arena.get(c) else { continue };
            stack.extend(o.children.iter().rev().copied());
            let member = o.is_html_named("input")
                && o.input_type() == "radio"
                && o.plain_attr("name") == Some(name)
                && arena.form_owner(c) == key.2;
            if !member || !self.focusable(c) {
                continue;
            }
            first.get_or_insert(c);
            if arena.is_checked(c) {
                checked = Some(c);
                break;
            }
        }
        let stop = checked.or(first);
        self.radio_stops.insert(key, stop);
        stop.is_some_and(|s| s != el)
    }

    // The scope of `nodes` (a shadow root's children, a slot's assigned nodes, the document's): its candidates, an
    // owner's contents being a scope of their own, and an editable host's no candidates at all.
    fn scope(&mut self, owner: Option<NodeId>, nodes: &[NodeId]) -> Scope {
        let mut tree = Vec::new();
        let mut stack: Vec<NodeId> = nodes.iter().rev().copied().collect();
        while let Some(el) = stack.pop() {
            if self.arena.get(el).is_none_or(|n| n.kind != NodeKind::Element) {
                continue;
            }
            let editable = editing_host(self.arena, el);
            let item = self.classify(el);
            let descend = !item.as_ref().is_some_and(Item::owner) && !editable;
            if let Some(mut item) = item {
                item.tree_pos = tree.len();
                tree.push(item);
            }
            if descend {
                stack.extend(self.arena.get(el).map(|n| n.children.clone()).unwrap_or_default().into_iter().rev());
            }
        }
        let mut order: Vec<usize> = (0..tree.len()).filter(|&i| tree[i].group > 0).collect();
        order.sort_by_key(|&i| tree[i].group);
        order.extend((0..tree.len()).filter(|&i| tree[i].group <= 0));
        Scope { owner, tree, order }
    }
    fn slot_scope(&mut self, slot: NodeId) -> Scope {
        let n = self.arena.get(slot).expect("a slot");
        let nodes = if n.assigned.is_empty() { n.children.clone() } else { n.assigned.clone() };
        self.scope(Some(slot), &nodes)
    }
}

impl Scope {
    fn item(&self, k: usize) -> &Item {
        &self.tree[self.order[k]]
    }

    // The first (last, `reverse`) stop inside the scope, entering the scopes it includes.
    fn edge(&self, reverse: bool) -> Option<NodeId> {
        let mut ks: Box<dyn Iterator<Item = usize>> = if reverse { Box::new((0..self.order.len()).rev()) } else { Box::new(0..self.order.len()) };
        ks.find_map(|k| self.enter(self.item(k), reverse))
    }
    // What stepping onto `x` lands on: itself where it is a stop (after its scope, backwards), else the edge of its
    // scope.
    fn enter(&self, x: &Item, reverse: bool) -> Option<NodeId> {
        if !reverse && x.stop() {
            return Some(x.el);
        }
        if let Some(e) = x.entered().and_then(|s| s.edge(reverse)) {
            return Some(e);
        }
        (reverse && x.stop()).then_some(x.el)
    }

    // The step from the item at `k` in navigation order: `exiting` its scope (after it, so forward past it, backward
    // onto it where it is a stop), or having just landed on it (so forward into its scope first).
    fn step(&self, k: usize, reverse: bool, exiting: bool) -> Option<NodeId> {
        let at = self.item(k);
        if !reverse {
            if !exiting && at.kind == Kind::Both {
                if let Some(e) = at.entered().and_then(|s| s.edge(false)) {
                    return Some(e);
                }
            }
            return (k + 1..self.order.len()).find_map(|i| self.enter(self.item(i), false));
        }
        if exiting && at.kind == Kind::Both {
            return Some(at.el);
        }
        (0..k).rev().find_map(|i| self.enter(self.item(i), true))
    }
    // The step from a LEFT-OUT owner (a negative host or slot) at `pos` in tree order: the nearest stop after (before)
    // it in tree order.
    fn step_from_tree(&self, pos: usize, reverse: bool) -> Option<NodeId> {
        let near: Box<dyn Iterator<Item = &Item>> = if reverse { Box::new(self.tree[..pos].iter().rev()) } else { Box::new(self.tree[pos + 1..].iter()) };
        near.into_iter().find_map(|x| {
            if x.stop() && !reverse {
                return Some(x.el);
            }
            x.entered().and_then(|s| s.edge(reverse)).or_else(|| x.stop().then_some(x.el))
        })
    }

    // The scopes from this one down to the one that holds `el` as an item — left-out scopes included — and its index in
    // that one's navigation order.
    fn locate<'s>(&'s self, el: NodeId, chain: &mut Vec<&'s Scope>) -> Option<usize> {
        chain.push(self);
        for k in 0..self.order.len() {
            let it = self.item(k);
            if it.el == el {
                return Some(k);
            }
            if let Some(found) = it.sub.as_ref().and_then(|s| s.locate(el, chain)) {
                return Some(found);
            }
        }
        chain.pop();
        None
    }

    fn flatten(&self, out: &mut Vec<NodeId>) {
        for k in 0..self.order.len() {
            let it = self.item(k);
            if it.stop() {
                out.push(it.el);
            }
            if let Some(s) = it.entered() {
                s.flatten(out);
            }
        }
    }
}

// The element sequential navigation moves focus to from `current` (the focused element; None for none) in the document
// `doc`, forwards or `reverse`: stepping out scope by scope from where `current` is an item, else — focused but no item
// (not focusable, a negative tabindex, inside an editable host) — from its place in tree order, which only tells where
// the order goes on while that order IS tree order. At either end it wraps round. None where nothing is focusable.
pub(crate) fn next(engine: &mut StyleEngine, arena: &RealmArena, doc: NodeId, current: Option<NodeId>, reverse: bool, now: f64) -> Option<NodeId> {
    let children = arena.get(doc)?.children.clone();
    let root = Navigator { engine, arena, now, radio_stops: HashMap::new() }.scope(None, &children);
    let stepped = current.and_then(|cur| {
        let mut chain = Vec::new();
        match root.locate(cur, &mut chain) {
            Some(k) => step_out(&chain, k, reverse),
            None => step_from_position(arena, &root, cur, reverse),
        }
    });
    stepped.or_else(|| root.edge(reverse)).or_else(|| {
        let mut flat = Vec::new();
        root.flatten(&mut flat);
        if reverse { flat.last().copied() } else { flat.first().copied() }
    })
}
fn step_out(chain: &[&Scope], k: usize, reverse: bool) -> Option<NodeId> {
    let mut scope = *chain.last()?;
    let at = scope.item(k);
    // (…a left-out owner a script focused is no part of the order: it goes on from its place in tree order)
    let first = if at.kind == Kind::Owner && !at.included { scope.step_from_tree(at.tree_pos, reverse) } else { scope.step(k, reverse, false) };
    if first.is_some() {
        return first;
    }
    for parent in chain[..chain.len() - 1].iter().rev() {
        let owner = scope.owner?;
        if let Some(item) = parent.tree.iter().find(|x| x.el == owner) {
            let next = if item.included {
                let k = parent.order.iter().position(|&i| parent.tree[i].el == owner)?;
                parent.step(k, reverse, true)
            } else {
                parent.step_from_tree(item.tree_pos, reverse)
            };
            if next.is_some() {
                return next;
            }
        }
        scope = parent;
    }
    None
}
fn step_from_position(arena: &RealmArena, root: &Scope, cur: NodeId, reverse: bool) -> Option<NodeId> {
    let mut flat = Vec::new();
    root.flatten(&mut flat);
    if flat.windows(2).any(|w| tree_order(arena, w[0], w[1]) == Ordering::Greater) {
        return None;
    }
    if reverse {
        flat.into_iter().rev().find(|&s| tree_order(arena, s, cur) == Ordering::Less)
    } else {
        flat.into_iter().find(|&s| tree_order(arena, cur, s) == Ordering::Less)
    }
}
// Shadow-including tree order: a shadow root before its host's children. Nodes in no common tree compare equal.
fn tree_order(arena: &RealmArena, a: NodeId, b: NodeId) -> Ordering {
    let chain = |x: NodeId| {
        let mut c: Vec<NodeId> = std::iter::successors(Some(x), |&n| arena.get(n).and_then(|d| d.parent.or(d.host))).collect();
        c.reverse();
        c
    };
    let (ca, cb) = (chain(a), chain(b));
    let common = ca.iter().zip(&cb).take_while(|(x, y)| x == y).count();
    if common == 0 || a == b {
        return Ordering::Equal;
    }
    let (Some(&x), Some(&y)) = (ca.get(common), cb.get(common)) else { return ca.len().cmp(&cb.len()) };
    let place = |n: NodeId| arena.get(n).map_or(i64::MIN, |d| if d.host.is_some() { i64::MIN } else { d.position });
    place(x).cmp(&place(y))
}

// ── the ops ──────────────────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "focusable", focusable_op, context_id);
    crate::dom::register(scope, ns, "nextFocus", next_focus_op, context_id);
}

// __dom.focusable(nid, now) -> whether the element is a focusable area (`focusable`); undefined where the realm has no
// style engine.
fn focusable_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    if let Some(f) = crate::rendered::with_engine(scope, &args, 1, |engine, arena, now| focusable(engine, arena, id, now)) {
        rv.set_bool(f);
    }
}

// __dom.nextFocus(docNid, currentNid, reverse, now) -> the element Tab (Shift-Tab, with `reverse`) moves focus to from
// `currentNid` (-1: nothing focused), as its nid and then the path to it from the document — each step a child's index
// among the live ones, or -1 into the shadow root of the element before it — or null where nothing is focusable.
fn next_focus_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_null() };
    let current = crate::dom::nid_arg(scope, &args, 1);
    let reverse = args.get(2).is_true();
    let path = crate::rendered::with_engine(scope, &args, 3, |engine, arena, now| {
        let next = next(engine, arena, doc, current, reverse, now)?;
        let mut path = Vec::new();
        let mut cur = next;
        while cur != doc {
            let n = arena.get(cur)?;
            match (n.parent, n.host) {
                (Some(p), _) => {
                    let live = arena.get(p)?.children.iter().filter(|&&c| arena.get(c).is_some());
                    path.push(live.take_while(|&&c| c != cur).count() as f64);
                    cur = p;
                }
                (None, Some(host)) => {
                    path.push(-1.0);
                    cur = host;
                }
                (None, None) => return None,
            }
        }
        path.push(next.to_f64());
        path.reverse();
        Some(path)
    });
    match path.flatten() {
        Some(path) => {
            let array = crate::dom::f64_array(scope, &path);
            rv.set(array.into());
        }
        None => rv.set_null(),
    }
}
