// AbortSignal's state (DOM §3.2): each signal's aborted flag, and the graph a dependent one (`AbortSignal.any`'s) is
// part of: the ROOT signals it follows — a dependent source contributing its own sources — and, of a root one, the
// dependent signals that follow it. "Signal abort" asks it for the signals that abort together, in the order their abort
// steps run. The isolate's (its `Dom`), every realm of it: a frame's signal may be another's source.
//
// Each signal's object is held weakly — the spec's dependent signals are a WEAK set — so a collected one is a number
// naming nothing, which an abort skips and the registry lets go of as it grows. What stays with the bindings
// (abort.js) is what is a JS value or a call: a signal's reason, its abort algorithms and the `abort` event.

use std::collections::HashMap;

use crate::dom::{dom, register, register_fast};

#[derive(Default)]
struct Signal {
    aborted: bool,
    // Whether it is a dependent one, and the root signals it follows: none for `any([])`, a dependent of nothing.
    dependent: bool,
    roots: Vec<u64>,
    // A root signal's dependents, in the order they were made.
    dependents: Vec<u64>,
}

#[derive(Default)]
struct Graph {
    next: u64,
    of: HashMap<u64, Signal>,
}

impl Graph {
    fn make(&mut self) -> u64 {
        self.next += 1;
        self.of.insert(self.next, Signal::default());
        self.next
    }
    // "Create a dependent abort signal": the first source aborted already, where one is — the caller makes an aborted
    // signal of its reason instead —
    fn first_aborted(&self, sources: &[u64]) -> Option<usize> {
        sources.iter().position(|id| self.of.get(id).is_some_and(|s| s.aborted))
    }
    // …else a new dependent signal following each source — a dependent source's own sources in its place — once each.
    fn any(&mut self, sources: &[u64]) -> u64 {
        let combined = self.make();
        let mut roots = Vec::new();
        for source in sources {
            let Some(s) = self.of.get(source) else { continue };
            let own = if s.dependent { s.roots.clone() } else { vec![*source] };
            for root in own {
                if roots.contains(&root) {
                    continue;
                }
                roots.push(root);
                if let Some(r) = self.of.get_mut(&root) {
                    r.dependents.push(combined);
                }
            }
        }
        let c = self.of.get_mut(&combined).expect("the signal just made");
        c.dependent = true;
        c.roots = roots;
        combined
    }
    // "Signal abort"'s marking: the signal and every signal depending on it aborted FIRST, so a listener sees each of
    // them aborted already — the order their abort steps then run in. None where it is aborted already. A dependent
    // aborted is no other root's to follow any more.
    fn abort(&mut self, id: u64) -> Vec<u64> {
        let mut order = Vec::new();
        let mut pending = vec![id];
        while let Some(at) = pending.pop() {
            let Some(s) = self.of.get_mut(&at) else { continue };
            if s.aborted {
                continue;
            }
            s.aborted = true;
            order.push(at);
            // (…its dependents marked in the order they were added, depth first, as a recursion would)
            pending.extend(std::mem::take(&mut s.dependents).into_iter().rev());
        }
        for &aborted in &order {
            let roots = self.of.get(&aborted).map_or_else(Vec::new, |s| s.roots.clone());
            for root in roots {
                if let Some(r) = self.of.get_mut(&root) {
                    r.dependents.retain(|d| *d != aborted);
                }
            }
        }
        order
    }
    // (…the signals `live` says nothing names any more let go of, and the dependents a root lists of them)
    fn sweep(&mut self, live: impl Fn(u64) -> bool) {
        self.of.retain(|id, _| live(*id));
        let of = &self.of;
        let kept: Vec<(u64, Vec<u64>)> = of
            .iter()
            .filter(|(_, s)| !s.dependents.is_empty())
            .map(|(id, s)| (*id, s.dependents.iter().copied().filter(|d| of.contains_key(d)).collect()))
            .collect();
        for (id, dependents) in kept {
            self.of.get_mut(&id).expect("a signal just listed").dependents = dependents;
        }
    }
}

#[derive(Default)]
pub(crate) struct AbortSignals {
    graph: Graph,
    objects: HashMap<u64, v8::Weak<v8::Value>>,
    // The size at which the next sweep lets go of the collected signals: twice what the last one left.
    sweep_at: usize,
}

impl AbortSignals {
    fn make(&mut self, scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Value>, made: impl FnOnce(&mut Graph) -> u64) -> u64 {
        if self.objects.len() >= self.sweep_at.max(64) {
            self.objects.retain(|_, w| !w.is_empty());
            let objects = &self.objects;
            self.graph.sweep(|id| objects.contains_key(&id));
            self.sweep_at = self.objects.len() * 2;
        }
        let id = made(&mut self.graph);
        self.objects.insert(id, v8::Weak::new(scope, object));
        id
    }
    // The isolate's slots go after V8 has disposed it, and a weak handle's drop resets its node, freed memory by then:
    // let go of whole (as the Dom's other weak handles are).
    pub(crate) fn leak_weak_handles(&mut self) {
        std::mem::forget(std::mem::take(&mut self.objects));
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "abortSignalNew", new_op, context_id);
    register(scope, ns, "abortSignalFirstAborted", first_aborted_op, context_id);
    register(scope, ns, "abortSignalAny", any_op, context_id);
    register(scope, ns, "abortSignalAbort", abort_op, context_id);
    register_fast(scope, ns, "abortSignalAborted", aborted_op, ABORTED_FAST, context_id);
    register(scope, ns, "abortSignalRoots", roots_op, context_id);
}

fn id_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> u64 {
    v.number_value(scope).map_or(0, |n| n as u64)
}
fn ids_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Vec<u64> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(v) else { return Vec::new() };
    (0..list.length()).map(|i| list.get_index(scope, i).map_or(0, |v| id_arg(scope, v))).collect()
}
// The objects of `ids` still alive, in order.
fn objects_of<'s>(scope: &mut v8::PinScope<'s, '_>, ids: &[u64]) -> v8::Local<'s, v8::Array> {
    let weak: Vec<v8::Weak<v8::Value>> = ids.iter().filter_map(|id| dom(scope).abort_signals.objects.get(id).cloned()).collect();
    let live: Vec<v8::Local<'s, v8::Value>> = weak.iter().filter_map(|w| w.to_local(scope)).collect();
    v8::Array::new_with_elements(scope, &live)
}
// A new signal of `object`, made in the graph by `made`.
fn make_signal(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Value>, made: impl FnOnce(&mut Graph) -> u64) -> u64 {
    // (…the registry out of the Dom for the weak handle's making, which needs the scope)
    let mut signals = std::mem::take(&mut dom(scope).abort_signals);
    let id = signals.make(scope, object, made);
    dom(scope).abort_signals = signals;
    id
}

// __dom.abortSignalNew(signal) -> the number of `signal`, a new one not aborted and of no source.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(make_signal(scope, args.get(0), Graph::make) as f64);
}
// __dom.abortSignalFirstAborted(sources) -> the index of the first of the sources (their numbers) aborted already, or
// -1 for none.
fn first_aborted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let sources = ids_arg(scope, args.get(0));
    rv.set_int32(dom(scope).abort_signals.graph.first_aborted(&sources).map_or(-1, |at| at as i32));
}
// __dom.abortSignalAny(signal, sources) -> the number of `signal`, the dependent signal of the sources (their numbers),
// none of them aborted.
fn any_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let sources = ids_arg(scope, args.get(1));
    rv.set_double(make_signal(scope, args.get(0), |graph| graph.any(&sources)) as f64);
}
// __dom.abortSignalAbort(id) -> the signals depending on it that abort with it, in the order their abort steps run after
// its own — or null where it is aborted already and nothing aborts.
fn abort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let order = dom(scope).abort_signals.graph.abort(id);
    if order.is_empty() {
        return rv.set_null();
    }
    rv.set(objects_of(scope, &order[1..]).into());
}
// __dom.abortSignalAborted(id) -> whether it is aborted. (…a fast call: every fetch step and listener addition asks)
fn aborted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    rv.set_bool(dom(scope).abort_signals.graph.of.get(&id).is_some_and(|s| s.aborted));
}
fn aborted_fast(_receiver: v8::Local<v8::Value>, id: f64, options: *mut v8::fast_api::FastApiCallbackOptions) -> bool {
    crate::dom::fast_dom(options).is_some_and(|d| d.abort_signals.graph.of.get(&(id as u64)).is_some_and(|s| s.aborted))
}
const ABORTED_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(
    aborted_fast as _,
    &v8::fast_api::CFunctionInfo::new(
        v8::fast_api::Type::Bool.as_info(),
        &[
            v8::fast_api::Type::V8Value.as_info(),
            v8::fast_api::Type::Float64.as_info(),
            v8::fast_api::Type::CallbackOptions.as_info(),
        ],
        v8::fast_api::Int64Representation::Number,
    ),
)];
// __dom.abortSignalRoots(id) -> the root signals a dependent one follows (what keeps it alive while it has a listener
// or an algorithm of its own); none of a root one, nor of `any([])`.
fn roots_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let roots = dom(scope).abort_signals.graph.of.get(&id).map_or_else(Vec::new, |s| s.roots.clone());
    rv.set(objects_of(scope, &roots).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aborts_a_root_then_its_dependents_in_their_order_once() {
        let mut g = Graph::default();
        let (a, b) = (g.make(), g.make());
        let ab = g.any(&[a, b]);
        let only_a = g.any(&[a]);
        // (…a dependent of a dependent follows its roots)
        let nested = g.any(&[ab]);
        assert_eq!(g.of[&nested].roots, vec![a, b]);
        assert_eq!(g.abort(a), vec![a, ab, only_a, nested]);
        assert_eq!(g.abort(a), Vec::<u64>::new());
        // (…and those aborted with `a` are no longer `b`'s)
        assert_eq!(g.of[&b].dependents, Vec::<u64>::new());
        assert_eq!(g.abort(b), vec![b]);
        assert_eq!(g.first_aborted(&[b, a]), Some(0));
    }

    #[test]
    fn follows_nothing_through_a_dependent_of_nothing() {
        let mut g = Graph::default();
        let empty = g.any(&[]);
        let d = g.any(&[empty]);
        assert!(g.of[&d].dependent && g.of[&d].roots.is_empty());
        assert!(g.of[&empty].dependents.is_empty());
    }

    #[test]
    fn lets_go_of_the_dependents_that_name_nothing() {
        let mut g = Graph::default();
        let root = g.make();
        let (gone, kept) = (g.any(&[root]), g.any(&[root]));
        g.sweep(|id| id != gone);
        assert_eq!(g.of[&root].dependents, vec![kept]);
        assert_eq!(g.abort(root), vec![root, kept]);
    }
}
