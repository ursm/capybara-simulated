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
// summary, below). A `<dialog>` among them — rendered only while open — is the UA's to decide (HTML: "if the user agent
// decided that dialog elements were not generally focusable"), and Chrome and Firefox both focus one, by `focus()` and
// by the dialog focusing steps where it holds nothing else that can take focus; Chrome leaves it out of the sequential
// order (its `tabIndex` -1), as `classify` does.
const FOCUSABLE_TAGS: [&str; 10] = ["input", "textarea", "select", "button", "iframe", "embed", "object", "audio", "video", "dialog"];

// Is `id` a focusable area: an element not actually disabled, with a valid `tabindex` — else focusable by its kind, a
// hyperlink, or editable — in no `inert` subtree, and being rendered or the fallback content of a rendered `<canvas>`,
// which generates no box of its own yet stays focusable. Nothing is rendered in a document that is not fully active —
// one a navigation replaced, or its frame's removal discarded, its realm's script still running (Chrome and Firefox,
// measured: its `focus()` focuses nothing). Rendered as a box that can take focus: not skipped (a closed
// `<details>`'s content) and not `visibility: hidden`, whose boxes "cannot receive focus" (CSS Display 3 §4; Chrome and
// Firefox, measured).
pub(crate) fn focusable(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> bool {
    let Some(n) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { return false };
    if arena.is_actually_disabled(id) || !candidate(arena, id, n) || arena.is_inert(id) {
        return false;
    }
    if !arena.document_fully_active(arena.shadow_including_root(id)) {
        return false;
    }
    let rendered = |engine: &mut StyleEngine, id| crate::rendered::rendered(engine, arena, id, false, true, None, now);
    if n.is_html_named("area") {
        return area_image(arena, id).is_some_and(|img| rendered(engine, img) && !arena.is_inert(img));
    }
    rendered(engine, id) || element_ancestors(arena, id).find(|&p| arena.get(p).is_some_and(|p| p.is_html_named("canvas"))).is_some_and(|c| rendered(engine, c))
}
// The `<img>` the image map an `<area>` is in is associated with — the first of its tree whose `usemap` is a hash-name
// reference to its nearest `<map>` ancestor (by the map's `name`, else its `id`) — whose being rendered makes the area's
// shape a focusable area ("the shapes of area elements in an image map associated with an img element that is being
// rendered"), the area itself what `document.activeElement` reads (Chrome and Firefox; WPT autofocus-area).
fn area_image(arena: &RealmArena, area: NodeId) -> Option<NodeId> {
    let map = element_ancestors(arena, area).find(|&p| arena.get(p).is_some_and(|p| p.is_html_named("map")))?;
    let m = arena.get(map)?;
    let name = m.plain_attr("name").or_else(|| m.plain_attr("id")).filter(|n| !n.is_empty())?;
    descendants(arena, arena.root_of(map)).into_iter().find(|&img| {
        arena.get(img).is_some_and(|i| i.is_html_named("img") && i.plain_attr("usemap").and_then(|u| u.strip_prefix('#')) == Some(name))
    })
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
// Whether a focusable element is left out of the sequential order: a negative `tabindex`, or a `<dialog>` with none.
fn out_of_sequence(n: &NodeData) -> bool {
    tabindex(n).map_or(n.is_html_named("dialog"), |t| t < 0)
}
// An editing host itself (element_state.rs `editing_host`): one its own attribute makes one, or a design-mode
// document's document element.
fn editing_host(arena: &RealmArena, id: NodeId) -> bool {
    let Some(n) = arena.get(id) else { return false };
    match n.contenteditable_state() {
        Some(own) => own,
        None => n.is_html() && arena.parent_of(id).and_then(|p| arena.get(p)).is_some_and(|p| p.kind == NodeKind::Document && p.state & crate::dom::STATE_DESIGN_MODE != 0),
    }
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
    // The showing popovers with a popover trigger, by trigger, in tree order, and each one's trigger: HTML makes such a
    // popover's "associated focus navigation owner" its trigger, so its contents follow the trigger in the order, out of
    // their place in the tree.
    triggered: HashMap<NodeId, Vec<NodeId>>,
    owned: HashMap<NodeId, NodeId>,
}

impl Navigator<'_> {
    fn focusable(&mut self, id: NodeId) -> bool {
        focusable(self.engine, self.arena, id, self.now)
    }

    fn classify(&mut self, el: NodeId) -> Option<Item> {
        let n = self.arena.get(el)?;
        let tabindex = tabindex(n);
        let negative = out_of_sequence(n);
        let group = if negative { 0 } else { tabindex.unwrap_or(0) };
        let owner = |kind, sub| Some(Item { el, kind, sub: Some(sub), included: !negative, group, tree_pos: 0 });
        // (…a slot or a host that is a popover trigger too: its popovers in its scope, after the rest)
        let popovers = self.triggered.get(&el).cloned().unwrap_or_default();
        if n.is_html_named("slot") {
            let mut nodes = if n.assigned.is_empty() { n.children.clone() } else { n.assigned.clone() };
            nodes.extend(popovers);
            let sub = self.scope(Some(el), &nodes);
            return owner(Kind::Owner, sub);
        }
        if let Some(root) = n.shadow_root {
            let delegates = self.arena.get(root).is_some_and(|r| r.shadow_is(crate::dom::SHADOW_DELEGATES_FOCUS));
            let mut children = self.arena.get(root).map(|r| r.children.clone()).unwrap_or_default();
            children.extend(popovers);
            let sub = self.scope(Some(el), &children);
            let stop = !delegates && !negative && self.focusable(el);
            return owner(if stop { Kind::Both } else { Kind::Owner }, sub);
        }
        // (…the popover trigger of a showing popover: an owner, its popovers its scope — a stop besides where it can take
        // focus)
        if !popovers.is_empty() {
            let sub = self.scope(Some(el), &popovers);
            let stop = !negative && self.focusable(el);
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
            // (…a showing popover its trigger owns is in the trigger's scope, not where the tree has it)
            if self.owned.get(&el).is_some_and(|&trigger| owner != Some(trigger)) {
                continue;
            }
            let editable = editing_host(self.arena, el);
            let item = self.classify(el);
            // (…a slot's and a host's children are theirs; a popover trigger's are its own owner's, as the trigger's are)
            let descend = !editable && !item.as_ref().is_some_and(|x| x.owner() && !self.triggered.contains_key(&x.el));
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
// the order goes on while that order IS tree order. None past its end: the user agent's own controls take focus (HTML
// §6.6.5 "sequential focus navigation": "the user agent should transfer focus to its own controls"; Chrome leaves the
// document, its body the active element — Firefox, with no controls in a headless window, keeps it). With nothing focused
// (focus came back from them), its first (last) element; none where nothing is focusable.
pub(crate) fn next(engine: &mut StyleEngine, arena: &RealmArena, doc: NodeId, current: Option<NodeId>, reverse: bool, now: f64) -> Option<NodeId> {
    let children = arena.get(doc)?.children.clone();
    let mut triggered = arena.popovers.triggered();
    for popovers in triggered.values_mut() {
        popovers.sort_by(|&a, &b| tree_order(arena, a, b));
    }
    let owned = triggered.iter().flat_map(|(&trigger, popovers)| popovers.iter().map(move |&p| (p, trigger))).collect();
    let root = Navigator { engine, arena, now, radio_stops: HashMap::new(), triggered, owned }.scope(None, &children);
    if let Some(cur) = current {
        let mut chain = Vec::new();
        return match root.locate(cur, &mut chain) {
            Some(k) => step_out(&chain, k, reverse),
            None => step_from_position(arena, &root, cur, reverse),
        };
    }
    root.edge(reverse).or_else(|| {
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

// What HTML's focusing steps focus for `id` (`focus()`, the driver's focusing): a shadow host that delegates focus its
// focusable area (`focusable_area`), a label that is no focusable area itself its labeled control — each focused in
// turn as `id` would be — else `id`, where it is a focusable area; None for nothing.
pub(crate) fn focus_target(engine: &mut StyleEngine, arena: &RealmArena, mut id: NodeId, now: f64) -> Option<NodeId> {
    // (…a chain of them bounded: each step goes down a shadow tree or across to a control)
    for _ in 0..64 {
        if delegating_root(arena, id).is_some() {
            id = focusable_area(engine, arena, id, now)?;
        } else if arena.get(id).is_some_and(|n| n.is_html_named("label")) && !focusable(engine, arena, id, now) {
            id = arena.labeled_control(id)?;
        } else {
            return focusable(engine, arena, id, now).then_some(id);
        }
    }
    None
}

// What a press on `id` focuses (HTML: a click focuses the nearest element up from its target that can take it): the
// first of its flat-tree inclusive ancestors that is a focusable area or a shadow host delegating focus (pressing it moves
// focus into its shadow tree, shadow-dom/focus/click-focus-delegatesFocus-click.html) — the focusable element around a
// pressed icon; None where none can, the viewport's.
pub(crate) fn press_target(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> Option<NodeId> {
    std::iter::successors(Some(id), |&n| crate::geometry::flat_parent(arena, n))
        .take_while(|&n| arena.is_element(n))
        .find(|&n| focusable(engine, arena, n, now) || delegating_root(arena, n).is_some())
}

// HTML "get the focusable area" for a shadow host whose shadow root delegates focus — what its focusing steps focus,
// being no focusable area itself: the focused element, where it is under the host (a slotted node's, or one in a nested
// tree, keeps focus), else the host's focus delegate. (The other focusable areas an element stands for — an image map's
// shape, a scrollable region, a navigable's document — are not asked here.) None for any other element.
pub(crate) fn focusable_area(engine: &mut StyleEngine, arena: &RealmArena, host: NodeId, now: f64) -> Option<NodeId> {
    delegating_root(arena, host)?;
    match arena.focus.filter(|&f| arena.shadow_including_ancestor(host, f)) {
        Some(focused) => Some(focused),
        None => focus_delegate(engine, arena, host, now),
    }
}
// HTML's "focus delegate" of `target` — a shadow host's in its shadow tree, none where that does not delegate focus; any
// other element's among its own descendants (what the dialog focusing steps focus, a dialog's from those in the
// sequential order — whatwg/html#8199): the autofocus delegate — the first
// descendant carrying `autofocus` that is a focusable area or stands for one — else the first descendant that is one or
// stands for one, in tree order: the tree's own descendants, a nested shadow host standing for its own focusable area
// (so the path to what is found delegates focus at every shadow boundary), a slotted node none of the tree's.
pub(crate) fn focus_delegate(engine: &mut StyleEngine, arena: &RealmArena, target: NodeId, now: f64) -> Option<NodeId> {
    let root = match arena.get(target)?.shadow_root {
        Some(_) => delegating_root(arena, target)?,
        None => target,
    };
    if let Some(found) = autofocus_delegate(engine, arena, root, now) {
        return Some(found);
    }
    let area = |engine: &mut StyleEngine, id: NodeId| {
        if focusable(engine, arena, id, now) { Some(id) } else { focusable_area(engine, arena, id, now) }
    };
    // (…a dialog's only among those in the sequential order: a `tabindex=-1` button is passed over for the next)
    let dialog = arena.get(target)?.is_html_named("dialog");
    descendants(arena, root).into_iter().find_map(|d| match area(engine, d) {
        Some(found) if dialog && found == d && arena.get(d).is_some_and(out_of_sequence) => None,
        other => other,
    })
}
// HTML's "autofocus delegate" of `root`'s descendants (a focus trigger of "other"): the first carrying `autofocus` that is
// a focusable area or stands for one — that area.
fn autofocus_delegate(engine: &mut StyleEngine, arena: &RealmArena, root: NodeId, now: f64) -> Option<NodeId> {
    descendants(arena, root)
        .into_iter()
        .filter(|&d| arena.get(d).is_some_and(|n| n.plain_attr("autofocus").is_some()))
        .find_map(|d| if focusable(engine, arena, d, now) { Some(d) } else { focusable_area(engine, arena, d, now) })
}
fn delegating_root(arena: &RealmArena, host: NodeId) -> Option<NodeId> {
    arena.get(host)?.shadow_root.filter(|&r| arena.get(r).is_some_and(|r| r.shadow_is(crate::dom::SHADOW_DELEGATES_FOCUS)))
}
// The elements under `root` in tree order — not into a shadow tree.
fn descendants(arena: &RealmArena, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack: Vec<NodeId> = arena.get(root).map_or_else(Vec::new, |n| n.children.iter().rev().copied().collect());
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id).filter(|n| n.kind == NodeKind::Element) else { continue };
        out.push(id);
        stack.extend(n.children.iter().rev());
    }
    out
}

// ── the ops ──────────────────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "documentFocus", document_focus_op, context_id);
    crate::dom::register(scope, ns, "activeElement", active_element_op, context_id);
}

// __dom.documentFocus(docNid, hover) -> the element the realm of the document has focused (or, `hover`, hovered) — its
// state (`RealmState::focus` / `hover`, which STATE_FOCUSED / STATE_HOVERED written there name — and which a removal's
// steps take off the elements that leave: dialogs.rs `removing_steps`), whichever realm asks — as `node_value` answers
// it, or null.
fn document_focus_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_null() };
    let hover = args.get(1).is_true();
    let arena = &crate::dom::dom(scope).arena;
    let found = arena
        .get(doc)
        .filter(|d| d.kind == NodeKind::Document)
        .and_then(|d| arena.realm_state(d.realm))
        .and_then(|st| if hover { st.hover } else { st.focus });
    rv.set(crate::dom::node_value(scope, found));
}

// DocumentOrShadowRoot's `activeElement` (HTML §6.6.4) of `root`, a document or a shadow root whose node document is
// `doc`: the DOM anchor of that document's focused area — the element its realm has focused where it is in the document,
// else the document itself (its viewport: nothing focused, or a document no window shows, which focuses nothing) —
// retargeted against the root; none where that is in another tree; for the document, its body element, else its
// document element, else none.
fn active_element(arena: &RealmArena, root: NodeId, doc: NodeId) -> Option<NodeId> {
    let d = arena.get(doc).filter(|d| d.kind == NodeKind::Document)?;
    let focus = arena.realm_state(d.realm).and_then(|st| st.focus);
    let focused = focus.filter(|&f| arena.get(f).is_some() && arena.shadow_including_root(f) == doc);
    let candidate = crate::event_path::retarget_node(arena, focused.unwrap_or(doc), root);
    if arena.root_of(candidate) != root {
        return None;
    }
    if candidate != doc {
        return Some(candidate);
    }
    arena.relative(doc, crate::dom::RELATIVE_BODY).or_else(|| arena.first_element_child(doc))
}
// __dom.activeElement(rootNid, docNid) -> `active_element`, as `node_value` answers it, or null.
fn active_element_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(root), Some(doc)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else { return rv.set_null() };
    let found = active_element(&crate::dom::dom(scope).arena, root, doc);
    rv.set(crate::dom::node_value(scope, found));
}

// What HTML's "dialog focusing steps" focus for a dialog opening: the dialog where it carries `autofocus`, else its focus
// delegate, else the dialog itself.
pub(crate) fn dialog_focus_control(engine: &mut StyleEngine, arena: &RealmArena, dialog: NodeId, now: f64) -> NodeId {
    if arena.get(dialog).is_some_and(|n| n.plain_attr("autofocus").is_some()) {
        return dialog;
    }
    focus_delegate(engine, arena, dialog, now).unwrap_or(dialog)
}
// …and the "popover focusing steps" for a popover shown (no dialog): the popover where it carries `autofocus`, else its
// autofocus delegate, else none.
fn popover_control(engine: &mut StyleEngine, arena: &RealmArena, popover: NodeId, now: f64) -> Option<NodeId> {
    if arena.get(popover).is_some_and(|n| n.plain_attr("autofocus").is_some()) {
        return Some(popover);
    }
    autofocus_delegate(engine, arena, popover, now)
}
// …each asked of the style engine of the element's realm, the sheets its bindings hold fed to it first (None: a script
// was terminated).
fn ask_engine<R>(scope: &mut v8::PinScope<'_, '_>, el: NodeId, ask: impl FnOnce(&mut StyleEngine, &RealmArena, f64) -> R) -> Option<Option<R>> {
    let target = crate::dom::node_value(scope, Some(el));
    crate::dom::call_host_step(scope, "feedStyleEngineSheetsOf", &[target])?;
    let cid = crate::dom::dom(scope).arena.get(el).map(|n| n.realm)?;
    Some(crate::rendered::with_engine_in(scope, cid, ask))
}
// …and whether `el` is a focusable area (`focusable`), what focusing it focuses (`focus_target`), what a press on it
// focuses (`press_target`).
pub(crate) fn focusable_of(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<Option<bool>> {
    ask_engine(scope, el, |engine, arena, now| focusable(engine, arena, el, now))
}
pub(crate) fn focus_target_of(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<Option<NodeId>> {
    Some(ask_engine(scope, el, |engine, arena, now| focus_target(engine, arena, el, now))?.flatten())
}
// …and HTML "get the focusable area" for `el` where it is none itself: itself where it is one, else a delegating shadow
// host's focusable area.
pub(crate) fn focusable_area_of(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<Option<NodeId>> {
    Some(ask_engine(scope, el, |engine, arena, now| if focusable(engine, arena, el, now) { Some(el) } else { focusable_area(engine, arena, el, now) })?.flatten())
}
pub(crate) fn press_target_of(scope: &mut v8::PinScope<'_, '_>, n: NodeId) -> Option<Option<NodeId>> {
    Some(ask_engine(scope, n, |engine, arena, now| press_target(engine, arena, n, now))?.flatten())
}
pub(crate) fn dialog_focus_control_of(scope: &mut v8::PinScope<'_, '_>, dialog: NodeId) -> Option<NodeId> {
    Some(ask_engine(scope, dialog, |engine, arena, now| dialog_focus_control(engine, arena, dialog, now))?.unwrap_or(dialog))
}
pub(crate) fn popover_focus_control(scope: &mut v8::PinScope<'_, '_>, popover: NodeId) -> Option<Option<NodeId>> {
    Some(ask_engine(scope, popover, |engine, arena, now| popover_control(engine, arena, popover, now))?.flatten())
}
// HTML's "allow focus steps" for the document of realm `realm`: allowed to use the "focus-without-user-activation"
// feature (default allowlist 'self': a cross-origin frame its container's `allow` does not grant it to is not), or its
// window transiently activated. What the dialog and popover focusing steps ask first; HTML asks it of `focus()`,
// `window.focus()` and autofocus too, which do not ask it here yet.
pub(crate) fn allow_focus_steps(arena: &mut RealmArena, realm: i32) -> bool {
    crate::permissions_policy::allowed_to_use(arena, realm, "focus-without-user-activation") || arena.transiently_activated(realm)
}
// HTML's "focusing steps" for `el` (focus_update.rs) — the viewport not scrolled, as the dialogs' and popovers' steps ask
// (None: a script was terminated).
pub(crate) fn run_focusing_steps(scope: &mut v8::PinScope<'_, '_>, el: NodeId) -> Option<()> {
    crate::focus_update::focusing_steps(scope, crate::focus_update::Target::Element(el)).map(drop)
}
// The element the document `node` is in has focused — its realm's, whichever realm asks; none for a document the
// realm made that is not the one it shows (a DOMParser's), which has no focus of its own.
pub(crate) fn document_focus(arena: &RealmArena, node: NodeId) -> Option<NodeId> {
    let root = arena.shadow_including_root(node);
    let doc = arena.get(root).filter(|d| d.kind == NodeKind::Document)?;
    arena.realm_state(doc.realm)?.focus.filter(|&f| arena.shadow_including_root(f) == root)
}
// A dialog's "previously focused element", kept as it opens: what its document has focused…
pub(crate) fn dialog_opening(arena: &mut RealmArena, dialog: NodeId) {
    match document_focus(arena, dialog) {
        Some(focused) => arena.previously_focused.insert(dialog, focused),
        None => arena.previously_focused.remove(&dialog),
    };
}
// …and, closing it, that element — taken — where focus goes back to it: still in a document, and the dialog was modal
// or holds the focus — HTML "close the dialog": "If subject's node document's focused area of the document's DOM anchor
// is a shadow-including inclusive descendant of subject, or wasModal is true, then run the focusing steps for element".
// An element SLOTTED into a dialog in a shadow tree is no shadow-including descendant of it, so a non-modal one keeps
// the focus there: WPT dialog-focus-previous-outside asks for the flat tree (Chrome), against that explicit test.
pub(crate) fn dialog_focus_restore(arena: &mut RealmArena, dialog: NodeId, was_modal: bool) -> Option<NodeId> {
    let previous = arena.previously_focused.remove(&dialog)?;
    let in_document = arena.get(arena.shadow_including_root(previous)).is_some_and(|r| r.kind == NodeKind::Document);
    let holds = document_focus(arena, dialog).is_some_and(|f| arena.shadow_including_ancestor(dialog, f));
    (in_document && (was_modal || holds)).then_some(previous)
}

// HTML §6.6.5 "sequential focus navigation" across navigables: from `current` in realm `cid`'s document (None: from its
// starting point, else its start) forwards or `reverse` — a navigable container the order comes to entered, the focus
// going to the first (last) element of its document's order, the container passed where that has none; past the end of
// a child navigable's document on from its container in its parent's ("Otherwise, starting point is a focusable area in
// a child navigable. Set starting point to that child navigable's parent and return to the step labeled loop"; Chrome and
// Firefox) — the realm of the element focus goes to, and the element. None past the end of the top-level document's: the
// user agent's own controls take focus (`next`).
pub(crate) fn focus_navigation(scope: &mut v8::PinScope<'_, '_>, mut cid: i32, mut current: Option<NodeId>, reverse: bool) -> Option<(i32, NodeId)> {
    let now = crate::dom::dom(scope).arena.timeline_time(cid);
    let mut from_start = current.is_none();
    loop {
        let mut next = sequential_next(scope, now, cid, current, from_start, reverse);
        while let Some(el) = next {
            match child_document_realm(&crate::dom::dom(scope).arena, el) {
                Some(child) => {
                    if let Some(found) = navigate_into(scope, now, child, reverse) {
                        return Some(found);
                    }
                    next = sequential_next(scope, now, cid, Some(el), false, reverse);
                },
                None => return Some((cid, el)),
            }
        }
        let arena = &crate::dom::dom(scope).arena;
        let container = arena.live_container(cid).filter(|&c| arena.frame_realm(c) == Some(cid))?;
        cid = arena.get(container)?.realm;
        current = Some(container);
        from_start = false;
    }
}
// …into the document of realm `cid`, a container's: its first (last) element, a container in it entered in turn — none
// where it has none.
fn navigate_into(scope: &mut v8::PinScope<'_, '_>, now: f64, cid: i32, reverse: bool) -> Option<(i32, NodeId)> {
    let mut next = sequential_next(scope, now, cid, None, false, reverse);
    while let Some(el) = next {
        match child_document_realm(&crate::dom::dom(scope).arena, el) {
            Some(child) => match navigate_into(scope, now, child, reverse) {
                Some(found) => return Some(found),
                None => next = sequential_next(scope, now, cid, Some(el), false, reverse),
            },
            None => return Some((cid, el)),
        }
    }
    None
}
// The realm of the document of the navigable `el` contains, where it is a container whose document is live.
pub(crate) fn child_document_realm(arena: &RealmArena, el: NodeId) -> Option<i32> {
    arena.frame_realm(el).filter(|&c| !arena.is_dropped(c) && arena.realm_document(c).is_some())
}
// `next` in realm `cid`'s document by its own style engine — from `current`, or, with none, from its starting point where
// `from_start` and it is in the document yet, else from its start.
fn sequential_next(scope: &mut v8::PinScope<'_, '_>, now: f64, cid: i32, current: Option<NodeId>, from_start: bool, reverse: bool) -> Option<NodeId> {
    let mut found = None;
    crate::dom::style_op(scope, cid, |scope| {
        let d = crate::dom::dom(scope);
        let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
        let Some(doc) = arena.realm_document(cid) else { return };
        let start = from_start.then(|| arena.focus_start.filter(|&s| arena.shadow_including_root(s) == doc)).flatten();
        found = next(engine, arena, doc, current.or(start), reverse, now);
        engine.take_verify_failures();
    });
    found
}
