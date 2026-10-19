// AbortController / AbortSignal (DOM §3.1–3.2), generated from their IDL: a signal's aborted state and reason, the
// algorithms and the `abort` event its abort runs, and the signals a composite one (`AbortSignal.any`) follows. Nothing
// here cancels a request itself — `__rackFetch` is synchronous — but what follows a signal (a fetch's body, a
// listener's removal) adds its algorithm to it (events.js `addAbortAlgorithm`).

import { Event, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { installAbortController, installAbortSignal } from './generated/bindings.js';
import { queueTask } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import { DOMException } from './dom-exception.js';

function defaultAbortReason() { return new DOMException('signal is aborted without reason', 'AbortError'); }

// No page constructs a signal: a controller makes one, and the static operations do. Whether it is aborted, and the
// signals a composite one (`AbortSignal.any`) follows, are the engine's (abort_signal.rs), by its number; its reason, its
// abort algorithms and the dependents it keeps alive are values and calls, its internal slots here (`signalOf`), any
// realm's code's to read.
export class AbortSignal extends EventTarget {
  constructor(token, sources) {
    constructedBy(PLATFORM, token, 'AbortSignal');
    super();
    makeSlots(this, 'AbortSignal', {
      id: sources === undefined ? globalThis.__dom.abortSignalNew(this) : globalThis.__dom.abortSignalAny(this, sources),
      reason: undefined,
      // (…what its abort runs before the event: a listener's removal, a fetch body's cancelling)
      abortAlgorithms: null,
      // …and, of a root signal, the composite ones depending on it that have an abort listener or algorithm, held
      // strongly till it aborts (events.js `pinDependentSignal`): the engine holds every signal weakly.
      pinnedDependents: null
    });
  }
}
// A signal's slots — any realm's — or undefined for anything else.
export const signalOf = (o) => slotsOf(o, 'AbortSignal');
registerInterface('AbortSignal', (o) => signalOf(o) !== undefined);
// …whether it is aborted, and the reason it was.
export const signalAborted = (signal) => globalThis.__dom.abortSignalAborted(signalOf(signal).id);
export const signalReason = (signal) => signalOf(signal).reason;
// …and the root signals a composite one follows: none of a root one.
export const signalRoots = (signal) => globalThis.__dom.abortSignalRoots(signalOf(signal).id);

export function newAbortSignal() { return new AbortSignal(PLATFORM); }
function abortedSignal(reason) {
  const signal = newAbortSignal();
  globalThis.__dom.abortSignalAbort(signalOf(signal).id);
  signalOf(signal).reason = reason;
  return signal;
}

// "Signal abort": the signal AND every signal depending on it aborted with the SAME reason FIRST — so a listener sees
// each of them aborted already — THEN each one's abort steps, the signal's and then its dependents' in the order they
// were added (the engine's order): its algorithms, then `abort` fired at it. The event is the UA's, so trusted:
// dispatchWithOnHandler, not the public dispatchEvent.
export function signalAbort(signal, reason) {
  const dependents = globalThis.__dom.abortSignalAbort(signalOf(signal).id);
  if (dependents === null) return;
  const r = reason === undefined ? defaultAbortReason() : reason;
  const signals = [signal, ...dependents];
  for (const aborted of signals) {
    const s = signalOf(aborted);
    s.reason = r;
    s.pinnedDependents = null;
  }
  // (…an aborted dependent no root's to keep alive any more: one it follows that did not abort let go of it too)
  for (const aborted of dependents) {
    for (const root of globalThis.__dom.abortSignalRoots(signalOf(aborted).id)) signalOf(root).pinnedDependents?.delete(aborted);
  }
  for (const aborted of signals) {
    const s = signalOf(aborted);
    const algorithms = s.abortAlgorithms;
    s.abortAlgorithms = null;
    // (…one that throws reported, the rest run all the same: a throw is no algorithm's to stop the abort with)
    if (algorithms) {
      for (const algorithm of algorithms) {
        try { algorithm(); } catch (e) { globalThis.__csimReportError(e); }
      }
    }
    dispatchWithOnHandler(aborted, new Event('abort'));
  }
}

// "Create a dependent abort signal": aborted already where a source is — with its reason — else following the ROOT
// signals of the sources (abort_signal.rs), so a composite of a composite aborts in the spec's order.
export function anySignal(signals) {
  const ids = signals.map((source) => signalOf(source).id);
  const aborted = globalThis.__dom.abortSignalFirstAborted(ids);
  return aborted < 0 ? new AbortSignal(PLATFORM, ids) : abortedSignal(signalReason(signals[aborted]));
}

installAbortSignal(AbortSignal, {
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
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

export class AbortController {
  constructor() { makeSlots(this, 'AbortController', { signal: newAbortSignal() }); }
}
const controllerOf = (o) => slotsOf(o, 'AbortController');
registerInterface('AbortController', (o) => controllerOf(o) !== undefined);
installAbortController(AbortController, {
  get_signal: (controller) => controllerOf(controller).signal,
  abort: (controller, reason) => signalAbort(controllerOf(controller).signal, reason)
});

globalThis.AbortSignal     = AbortSignal;
globalThis.AbortController = AbortController;
