// AbortController / AbortSignal (DOM §3.1–3.2), generated from their IDL: a signal's aborted state and reason, the
// algorithms and the `abort` event its abort runs, and the signals a composite one (`AbortSignal.any`) follows. Nothing
// here cancels a request itself — `__rackFetch` is synchronous — but what follows a signal (a fetch's body, a
// listener's removal) adds its algorithm to it.

import { Event, EventTarget, DOMException, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { installAbortController, installAbortSignal } from './generated/bindings.js';
import { scheduleTimer } from './timers.js';
import { PLATFORM, brandPrototype, constructedBy, defineInternalSlots, registerInterface } from './webidl.js';

function defaultAbortReason() { return new DOMException('signal is aborted without reason', 'AbortError'); }

// No page constructs a signal: a controller makes one, and the static operations do. Its state is internal slots, so no
// enumeration of it sees them.
export class AbortSignal extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'AbortSignal');
    super();
    defineInternalSlots(this, {
      _aborted: false,
      _reason: undefined,
      // (…what its abort runs before the event: a listener's removal, a fetch body's cancelling)
      _abortAlgorithms: null,
      // A composite signal's (AbortSignal.any) flat list of the ROOT signals it follows; a root one — a controller's, a
      // timeout's — has none, and holds the composite signals that depend on it in `_dependents` instead: weakly, as
      // the spec's weak set does, so a long-lived controller's signal does not keep every Request made with it.
      _sourceSignals: null,
      _dependents: null
    });
  }
}
// (…any realm's, by the brand its prototype carries: a frame's signal is one)
const ABORT_SIGNAL = brandPrototype(AbortSignal, 'AbortSignal');
registerInterface('AbortSignal', (o) => o !== null && typeof o === 'object' && o[ABORT_SIGNAL] === true && o._aborted !== undefined);

export function newAbortSignal() { return new AbortSignal(PLATFORM); }
function abortedSignal(reason) {
  const s = newAbortSignal();
  s._aborted = true;
  s._reason  = reason;
  return s;
}

// "Signal abort": the signal AND every signal depending on it aborted with the SAME reason FIRST — so a listener sees
// each of them aborted already — THEN each one's abort steps, the signal's and then its dependents' in the order they
// were added: its algorithms, then `abort` fired at it. The event is the UA's, so trusted: dispatchWithOnHandler, not
// the public dispatchEvent.
export function signalAbort(signal, reason) {
  if (signal._aborted) return;
  const r = reason === undefined ? defaultAbortReason() : reason;
  const toAbort = [];
  const mark = (sig) => {
    if (sig._aborted) return;
    sig._aborted = true;
    sig._reason  = r;
    toAbort.push(sig);
    const deps = sig._dependents;
    if (deps) {
      sig._dependents = null;
      for (const ref of deps) {
        const d = ref.deref();
        if (d) mark(d);
      }
    }
  };
  mark(signal);
  for (const sig of toAbort) {
    const algorithms = sig._abortAlgorithms;
    sig._abortAlgorithms = null;
    if (algorithms) for (const algorithm of algorithms) algorithm();
    dispatchWithOnHandler(sig, new Event('abort'));
  }
}

// "Create a dependent abort signal": aborted already where a source is — with its reason — else following the ROOT
// signals of the sources, a composite source contributing its own roots, so a composite of a composite aborts in the
// spec's order.
export function anySignal(signals) {
  for (const s of signals) {
    if (s._aborted) return abortedSignal(s._reason);
  }
  const combined = newAbortSignal();
  combined._sourceSignals = [];
  const ref = new WeakRef(combined);
  for (const s of signals) {
    for (const root of s._sourceSignals || [s]) {
      if (combined._sourceSignals.includes(root)) continue;
      (root._dependents || (root._dependents = [])).push(ref);
      combined._sourceSignals.push(root);
    }
  }
  return combined;
}

installAbortSignal(AbortSignal, {
  get_aborted: (signal) => signal._aborted,
  get_reason: (signal) => signal._reason,
  throwIfAborted(signal) { if (signal._aborted) throw signal._reason; },
  abort: (self, reason) => abortedSignal(reason === undefined ? defaultAbortReason() : reason),
  // (…a TimeoutError DOMException after `ms` of the virtual clock — however many: an unsigned long long, no timer's
  // `long` — fetch's `{signal: AbortSignal.timeout(ms)}`)
  timeout(self, ms) {
    const s = newAbortSignal();
    scheduleTimer(() => signalAbort(s, new DOMException('signal timed out', 'TimeoutError')), ms, [], null);
    return s;
  },
  any: (self, signals) => anySignal(signals),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});

export class AbortController {
  constructor() { defineInternalSlots(this, { _signal: newAbortSignal() }); }
}
const ABORT_CONTROLLER = brandPrototype(AbortController, 'AbortController');
registerInterface('AbortController', (o) => o !== null && typeof o === 'object' && o[ABORT_CONTROLLER] === true && o._signal !== undefined);
installAbortController(AbortController, {
  get_signal: (controller) => controller._signal,
  abort: (controller, reason) => signalAbort(controller._signal, reason)
});

globalThis.AbortSignal     = AbortSignal;
globalThis.AbortController = AbortController;
