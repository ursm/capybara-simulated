// AbortController / AbortSignal (DOM §3.1–3.2), generated from their IDL: a signal's aborted state and reason, the
// algorithms and the `abort` event its abort runs, and the signals a composite one (`AbortSignal.any`) follows. Nothing
// here cancels a request itself — `__rackFetch` is synchronous — but what follows a signal (a fetch's body, a
// listener's removal) adds its algorithm to it (events.js `addAbortAlgorithm`).

import { Event, EventTarget, DOMException, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { installAbortController, installAbortSignal } from './generated/bindings.js';
import { scheduleTimer } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

function defaultAbortReason() { return new DOMException('signal is aborted without reason', 'AbortError'); }

// No page constructs a signal: a controller makes one, and the static operations do. Its state is its internal slots
// (`signalOf`), any realm's code's to read.
export class AbortSignal extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'AbortSignal');
    super();
    makeSlots(this, 'AbortSignal', {
      aborted: false,
      reason: undefined,
      // (…what its abort runs before the event: a listener's removal, a fetch body's cancelling)
      abortAlgorithms: null,
      // A composite signal's (AbortSignal.any) flat list of the ROOT signals it follows; a root one — a controller's, a
      // timeout's — has none, and holds the composite signals that depend on it in `dependents` instead: weakly, as
      // the spec's weak set does, so a long-lived controller's signal does not keep every Request made with it…
      sourceSignals: null,
      dependents: null,
      // …and those of them with an abort listener or algorithm, strongly till it aborts (events.js
      // `pinDependentSignal`).
      pinnedDependents: null
    });
  }
}
// A signal's slots — any realm's — or undefined for anything else.
export const signalOf = (o) => slotsOf(o, 'AbortSignal');
registerInterface('AbortSignal', (o) => signalOf(o) !== undefined);

export function newAbortSignal() { return new AbortSignal(PLATFORM); }
function abortedSignal(reason) {
  const signal = newAbortSignal(), s = signalOf(signal);
  s.aborted = true;
  s.reason = reason;
  return signal;
}

// "Signal abort": the signal AND every signal depending on it aborted with the SAME reason FIRST — so a listener sees
// each of them aborted already — THEN each one's abort steps, the signal's and then its dependents' in the order they
// were added: its algorithms, then `abort` fired at it. The event is the UA's, so trusted: dispatchWithOnHandler, not
// the public dispatchEvent.
export function signalAbort(signal, reason) {
  if (signalOf(signal).aborted) return;
  const r = reason === undefined ? defaultAbortReason() : reason;
  const toAbort = [];
  const mark = (s) => {
    if (s.aborted) return;
    s.aborted = true;
    s.reason = r;
    toAbort.push(s);
    const deps = s.dependents;
    s.pinnedDependents = null;
    if (deps) {
      s.dependents = null;
      for (const ref of deps) {
        const d = ref.deref();
        if (d) mark(signalOf(d));
      }
    }
  };
  mark(signalOf(signal));
  for (const s of toAbort) {
    const algorithms = s.abortAlgorithms;
    s.abortAlgorithms = null;
    // (…one that throws reported, the rest run all the same: a throw is no algorithm's to stop the abort with)
    if (algorithms) {
      for (const algorithm of algorithms) {
        try { algorithm(); } catch (e) { globalThis.__csimReportError(e); }
      }
    }
    dispatchWithOnHandler(s.owner, new Event('abort'));
  }
}

// "Create a dependent abort signal": aborted already where a source is — with its reason — else following the ROOT
// signals of the sources, a composite source contributing its own roots, so a composite of a composite aborts in the
// spec's order.
export function anySignal(signals) {
  for (const source of signals) {
    const s = signalOf(source);
    if (s.aborted) return abortedSignal(s.reason);
  }
  const combined = newAbortSignal(), c = signalOf(combined);
  c.sourceSignals = [];
  const ref = new WeakRef(combined);
  for (const source of signals) {
    for (const root of signalOf(source).sourceSignals || [source]) {
      if (c.sourceSignals.includes(root)) continue;
      const deps = signalOf(root).dependents ??= [];
      // (…its collected ones dropped as the list doubles — a signal every fetch of a page follows would keep a WeakRef
      // of each, and walk them all at its abort)
      if (deps.length >= 16 && (deps.length & (deps.length - 1)) === 0) {
        let live = 0;
        for (const d of deps) if (d.deref() !== undefined) deps[live++] = d;
        deps.length = live;
      }
      deps.push(ref);
      c.sourceSignals.push(root);
    }
  }
  return combined;
}

installAbortSignal(AbortSignal, {
  get_aborted: (signal) => signalOf(signal).aborted,
  get_reason: (signal) => signalOf(signal).reason,
  throwIfAborted(signal) {
    const s = signalOf(signal);
    if (s.aborted) throw s.reason;
  },
  abort: (self, reason) => abortedSignal(reason === undefined ? defaultAbortReason() : reason),
  // (…a TimeoutError DOMException after `ms` of the virtual clock — however many: an unsigned long long, no timer's
  // `long` — fetch's `{signal: AbortSignal.timeout(ms)}`)
  timeout(self, ms) {
    const signal = newAbortSignal();
    scheduleTimer(() => signalAbort(signal, new DOMException('signal timed out', 'TimeoutError')), ms, [], null);
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
