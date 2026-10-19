// AbortSignal's state (DOM §3.2): each signal's aborted flag, and the graph a composite one (`AbortSignal.any`) is
// part of: the ROOT signals a dependent one follows — a composite source contributing its own roots — and, of a root
// one, the dependent signals that follow it. "Signal abort" asks it for the signals that abort together, in the order
// their abort steps run. One registry for the isolate, every realm of it: a frame's signal may be another's source.
//
// Each signal's object is held weakly — the spec's dependent signals are a WEAK set — so a collected one is a number
// naming nothing, which an abort skips and the registry lets go of as it grows. What stays with the bindings
// (abort.js) is what is a JS value or a call: a signal's reason, its abort algorithms and the `abort` event.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::dom::register;

#[derive(Default)]
struct Signal {
    aborted: bool,
    // A dependent signal's root signals; none for a root one.
    roots: Vec<u32>,
    // A root signal's dependents, in the order they were made.
    dependents: Vec<u32>,
}

#[derive(Default)]
struct Signals {
    next: u32,
    of: HashMap<u32, Signal>,
}

impl Signals {
    // (…`live` says which numbers still name an object: those that do not are let go of as the registry doubles)
    fn sweep(&mut self, live: impl Fn(u32) -> bool) {
        self.of.retain(|id, _| live(*id));
    }
    fn make(&mut self) -> u32 {
        self.next += 1;
        self.of.insert(self.next, Signal::default());
        self.next
    }
    // "Create a dependent abort signal": the first source aborted already, where one is — the caller makes an aborted
    // signal of its reason instead —
    fn first_aborted(&self, sources: &[u32]) -> Option<usize> {
        sources.iter().position(|id| self.of.get(id).is_some_and(|s| s.aborted))
    }
    // …else a new signal following each source's roots (a root source itself), once each.
    fn any(&mut self, sources: &[u32]) -> u32 {
        let combined = self.make();
        let mut roots = Vec::new();
        for source in sources {
            let Some(s) = self.of.get(source) else { continue };
            let own = if s.roots.is_empty() { vec![*source] } else { s.roots.clone() };
            for root in own {
                if roots.contains(&root) {
                    continue;
                }
                roots.push(root);
                let of = &self.of;
                let Some(r) = self.of.get(&root) else { continue };
                // (…the dropped ones let go of as the list doubles: a signal every fetch of a page follows would
                // otherwise keep a number for each, and walk them all at its abort)
                let len = r.dependents.len();
                let live: Option<Vec<u32>> = (len >= 16 && len.is_power_of_two())
                    .then(|| r.dependents.iter().copied().filter(|d| of.contains_key(d)).collect());
                let r = self.of.get_mut(&root).expect("a root looked up above");
                if let Some(live) = live {
                    r.dependents = live;
                }
                r.dependents.push(combined);
            }
        }
        self.of.get_mut(&combined).expect("the signal just made").roots = roots;
        combined
    }
    // "Signal abort"'s marking: the signal and every signal depending on it aborted FIRST, so a listener sees each of
    // them aborted already — the order their abort steps then run in. None where it is aborted already.
    fn abort(&mut self, id: u32) -> Vec<u32> {
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
        order
    }
}

thread_local! {
    static SIGNALS: RefCell<Signals> = RefCell::new(Signals::default());
    static OBJECTS: RefCell<HashMap<u32, v8::Weak<v8::Value>>> = RefCell::new(HashMap::new());
}

// A new signal of `object`: its number, the registry swept of the collected ones as it doubles.
fn make(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Value>, made: impl FnOnce(&mut Signals) -> u32) -> u32 {
    let weak = v8::Weak::new(scope, object);
    OBJECTS.with_borrow_mut(|objects| {
        SIGNALS.with_borrow_mut(|signals| {
            let len = objects.len();
            if len >= 64 && len.is_power_of_two() {
                objects.retain(|_, w| !w.is_empty());
                signals.sweep(|id| objects.contains_key(&id));
            }
            let id = made(signals);
            objects.insert(id, weak);
            id
        })
    })
}
// The objects of `ids` still alive, in order.
fn objects_of<'s>(scope: &mut v8::PinScope<'s, '_>, ids: &[u32]) -> v8::Local<'s, v8::Array> {
    let live: Vec<v8::Local<'s, v8::Value>> = OBJECTS.with_borrow(|objects| ids.iter().filter_map(|id| objects.get(id)?.to_local(scope)).collect());
    v8::Array::new_with_elements(scope, &live)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "abortSignalNew", new_op, context_id);
    register(scope, ns, "abortSignalFirstAborted", first_aborted_op, context_id);
    register(scope, ns, "abortSignalAny", any_op, context_id);
    register(scope, ns, "abortSignalAbort", abort_op, context_id);
    register(scope, ns, "abortSignalAborted", aborted_op, context_id);
    register(scope, ns, "abortSignalRoots", roots_op, context_id);
}

fn id_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> u32 {
    v.uint32_value(scope).unwrap_or(0)
}

// __dom.abortSignalNew(signal) -> the number of `signal`, a new one not aborted and of no source.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(make(scope, args.get(0), Signals::make));
}
fn ids_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Vec<u32> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(v) else { return Vec::new() };
    (0..list.length()).map(|i| list.get_index(scope, i).map_or(0, |v| id_arg(scope, v))).collect()
}
// __dom.abortSignalFirstAborted(sources) -> the index of the first of the sources (their numbers) aborted already, or
// -1 for none.
fn first_aborted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let sources = ids_arg(scope, args.get(0));
    rv.set_int32(SIGNALS.with_borrow(|s| s.first_aborted(&sources)).map_or(-1, |at| at as i32));
}
// __dom.abortSignalAny(signal, sources) -> the number of `signal`, the dependent signal of the sources (their numbers),
// none of them aborted.
fn any_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let sources = ids_arg(scope, args.get(1));
    rv.set_uint32(make(scope, args.get(0), |s| s.any(&sources)));
}
// __dom.abortSignalAbort(id) -> the signals it aborts, in the order their abort steps run: none where it is aborted
// already.
fn abort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let order = SIGNALS.with_borrow_mut(|s| s.abort(id));
    rv.set(objects_of(scope, &order).into());
}
// __dom.abortSignalAborted(id) -> whether it is aborted.
fn aborted_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    rv.set_bool(SIGNALS.with_borrow(|s| s.of.get(&id).is_some_and(|s| s.aborted)));
}
// __dom.abortSignalRoots(id) -> the root signals a dependent one follows (what keeps it alive while it has a listener
// or an algorithm of its own); none of a root one.
fn roots_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let roots = SIGNALS.with_borrow(|s| s.of.get(&id).map_or_else(Vec::new, |s| s.roots.clone()));
    rv.set(objects_of(scope, &roots).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aborts_a_root_then_its_dependents_in_their_order_once() {
        let mut s = Signals::default();
        let (a, b) = (s.make(), s.make());
        let ab = s.any(&[a, b]);
        let only_a = s.any(&[a]);
        // (…a composite of a composite follows the roots)
        let nested = s.any(&[ab]);
        assert_eq!(s.of[&nested].roots, vec![a, b]);
        assert_eq!(s.abort(a), vec![a, ab, only_a, nested]);
        assert_eq!(s.abort(a), Vec::<u32>::new());
        assert_eq!(s.abort(b), vec![b]);
        assert_eq!(s.first_aborted(&[b, a]), Some(0));
    }

    #[test]
    fn skips_a_dropped_dependent_and_lets_go_of_it_as_the_list_doubles() {
        let mut s = Signals::default();
        let root = s.make();
        let made: Vec<u32> = (0..16).map(|_| s.any(&[root])).collect();
        for d in &made[..15] {
            s.of.remove(d);
        }
        let last = s.any(&[root]);
        assert_eq!(s.of[&root].dependents, vec![made[15], last]);
        assert_eq!(s.abort(root), vec![root, made[15], last]);
    }
}
