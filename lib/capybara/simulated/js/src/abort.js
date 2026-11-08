// AbortController / AbortSignal (DOM §3.1–3.2), generated from their IDL: a signal's aborted state and reason, the
// algorithms and the `abort` event its abort runs, and the signals a composite one (`AbortSignal.any`) follows. Nothing
// here cancels a request itself — `__rackFetch` is synchronous — but what follows a signal (a fetch's body, a
// listener's removal) adds its algorithm to it (events.js `addAbortAlgorithm`).

import { Event, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { defineAbortController, defineAbortSignal } from './generated/bindings.js';
import { queueTask } from './timers.js';
import { PLATFORM, slotsOf } from './webidl.js';
import { DOMException } from './dom-exception.js';
import { dom, listMap, reflectApply } from './engine.js';

// (…the Set's `delete` the snapshot had: a page's replaced one runs on no abort)
const setDelete = Set.prototype.delete;

function defaultAbortReason() { return new DOMException('signal is aborted without reason', 'AbortError'); }

// No page constructs a signal: a controller makes one, and the static operations do. Whether it is aborted, and the
// signals a composite one (`AbortSignal.any`) follows, are the engine's (abort_signal.rs), by its number; its reason, its
// abort algorithms and the dependents it keeps alive are values and calls, its internal slots here (`signalOf`), any
// realm's code's to read.
// A signal's slots — any realm's — or undefined for anything else.
export const signalOf = (o) => slotsOf(o, 'AbortSignal');
// …whether it is aborted, and the reason it was.
export const signalAborted = (signal) => dom.abortSignalAborted(signalOf(signal).id);
export const signalReason = (signal) => signalOf(signal).reason;
// …and the root signals a composite one follows: none of a root one.
export const signalRoots = (signal) => dom.abortSignalRoots(signalOf(signal).id);

export function newAbortSignal() { return new AbortSignal(PLATFORM); }
function abortedSignal(reason) {
  const signal = newAbortSignal();
  dom.abortSignalAbort(signalOf(signal).id);
  signalOf(signal).reason = reason;
  return signal;
}

// "Signal abort": the signal AND every signal depending on it aborted with the SAME reason FIRST — so a listener sees
// each of them aborted already — THEN each one's abort steps, the signal's and then its dependents' in the order they
// were added (the engine's order): its algorithms, then `abort` fired at it. The event is the UA's, so trusted:
// dispatchWithOnHandler, not the public dispatchEvent.
export function signalAbort(signal, reason) {
  const dependents = dom.abortSignalAbort(signalOf(signal).id);
  if (dependents === null) return;
  const r = reason === undefined ? defaultAbortReason() : reason;
  // (…each read by index: no iterator of a page's walks them)
  const count = dependents.length + 1;
  const signalAt = (i) => (i === 0 ? signal : dependents[i - 1]);
  for (let i = 0; i < count; i++) {
    const s = signalOf(signalAt(i));
    s.reason = r;
    s.pinnedDependents = null;
  }
  // (…an aborted dependent no root's to keep alive any more: one it follows that did not abort let go of it too)
  for (let i = 0; i < dependents.length; i++) {
    const roots = dom.abortSignalRoots(signalOf(dependents[i]).id);
    for (let j = 0; j < roots.length; j++) {
      const pinned = signalOf(roots[j]).pinnedDependents;
      if (pinned) reflectApply(setDelete, pinned, [dependents[i]]);
    }
  }
  for (let i = 0; i < count; i++) {
    const aborted = signalAt(i);
    const s = signalOf(aborted);
    const algorithms = s.abortAlgorithms;
    s.abortAlgorithms = null;
    // (…one that throws reported, the rest run all the same: a throw is no algorithm's to stop the abort with)
    if (algorithms) {
      for (let i = 0; i < algorithms.length; i++) {
        try { algorithms[i](); } catch (e) { globalThis.__csimReportError(e); }
      }
    }
    dispatchWithOnHandler(aborted, new Event('abort'));
  }
}

// "Create a dependent abort signal": aborted already where a source is — with its reason — else following the ROOT
// signals of the sources (abort_signal.rs), so a composite of a composite aborts in the spec's order.
export function anySignal(signals) {
  const ids = listMap(signals, (source) => signalOf(source).id);
  const aborted = dom.abortSignalFirstAborted(ids);
  return aborted < 0 ? new AbortSignal(PLATFORM, ids) : abortedSignal(signalReason(signals[aborted]));
}

// Whether `signal` may yet abort: one aborted already, or one that follows no signal — a Request's of no signal given,
// AbortSignal.any([]) — never will (what a fetch() adds no abort steps to).
export function signalMayAbort(signal) {
  const s = signalOf(signal);
  return !s.followsNone && !dom.abortSignalAborted(s.id);
}

export const AbortSignal = defineAbortSignal(EventTarget, {
  init(s, sources) {
    s.id = sources === undefined ? dom.abortSignalNew(s.owner) : dom.abortSignalAny(s.owner, sources);
    s.followsNone = sources !== undefined && sources.length === 0;
    // (…a root, which no signal follows — its controller's, `abort()`'s, `timeout()`'s — pins no dependent of its own)
    s.root = sources === undefined;
    s.reason = undefined;
    // (…what its abort runs before the event: a listener's removal, a fetch body's cancelling)
    s.abortAlgorithms = null;
    // …and, of a root signal, the composite ones depending on it that have an abort listener or algorithm, held
    // strongly till it aborts (events.js `pinDependentSignal`): the engine holds every signal weakly.
    s.pinnedDependents = null;
  },
  get_aborted: signalAborted,
  get_reason: signalReason,
  throwIfAborted(signal) {
    if (signalAborted(signal)) throw signalReason(signal);
  },
  abort: (self, reason) => abortedSignal(reason === undefined ? defaultAbortReason() : reason),
  // (…a TimeoutError DOMException after `ms` of the virtual clock — however many: an unsigned long long, no timer's
  // `long` — fetch's `{signal: AbortSignal.timeout(ms)}`)
  timeout(self, ms) {
    const signal = newAbortSignal();
    queueTask(() => signalAbort(signal, new DOMException('signal timed out', 'TimeoutError')), ms);
    return signal;
  },
  any: (self, signals) => anySignal(signals),
  installEventHandlers: installEventHandlerAttrs
});

const controllerOf = (o) => slotsOf(o, 'AbortController');
export const AbortController = defineAbortController({
  construct(slots) {
    slots.signal = newAbortSignal();
  },
  abort: (controller, reason) => signalAbort(controllerOf(controller).signal, reason)
});

globalThis.AbortSignal     = AbortSignal;
globalThis.AbortController = AbortController;
