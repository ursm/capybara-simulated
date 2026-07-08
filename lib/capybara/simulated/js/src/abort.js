// AbortSignal / AbortController — spec-compliant enough that
// `signal.aborted`, `addEventListener('abort', …)`, and
// `AbortSignal.any([a, b])` all work. We don't honour cancellation
// (`__rackFetch` is synchronous), but listener propagation is
// required for `AbortSignal.any` composition.

import { Event, EventTarget, DOMException, defineEventHandlers, dispatchWithOnHandler } from './events.js';

function defaultAbortReason() { return new DOMException('signal is aborted without reason', 'AbortError'); }

export class AbortSignal extends EventTarget {
  constructor() {
    super();
    this.aborted = false;
    this.reason  = undefined;
    // Set on a composite signal (AbortSignal.any) to the flat list of ROOT source signals it
    // follows; a root/controller/timeout signal leaves it undefined and instead accumulates the
    // composite signals that depend on it in `_dependents`.
  }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  // "Signal abort" (https://dom.spec.whatwg.org/#abortsignal-signal-abort): set the signal AND
  // all its dependents to aborted with the SAME reason FIRST (so a listener sees every dependent
  // already aborted), THEN fire 'abort' on the signal followed by each dependent, in the order
  // the dependents were added. This ordering + before-fire state is what the spec (and
  // AbortSignal.any composition, e.g. Request.clone's signal) relies on.
  _signalAbort(reason) {
    if (this.aborted) return;
    const r = reason === undefined ? defaultAbortReason() : reason;
    const toFire = [];
    const mark = (sig) => {
      if (sig.aborted) return;
      sig.aborted = true;
      sig.reason  = r;
      toFire.push(sig);
      const deps = sig._dependents;
      if (deps) { sig._dependents = null; for (const d of deps) mark(d); }
    };
    mark(this);
    // "Signal abort" is a UA "fire an event" step → the `abort` event is trusted (like every
    // other UA-fired event on a plain EventTarget), so route it through dispatchWithOnHandler
    // rather than the public dispatchEvent (which would untrust it).
    for (const sig of toFire) dispatchWithOnHandler(sig, new Event('abort'));
  }
  static abort(reason) {
    const s = new AbortSignal();
    s.aborted = true;
    s.reason  = reason === undefined ? defaultAbortReason() : reason;
    return s;
  }
  // Spec: aborts the returned signal with a TimeoutError DOMException
  // after `ms` virtual-clock milliseconds. fetch() with `{signal:
  // AbortSignal.timeout(ms)}` is the canonical timeout idiom.
  static timeout(ms) {
    const s = new AbortSignal();
    globalThis.setTimeout(() => s._signalAbort(new DOMException('signal timed out', 'TimeoutError')), Number(ms) || 0);
    return s;
  }
  // Spec: returns a signal that aborts when any input signal aborts. If any input is already
  // aborted, the returned signal is born aborted with that reason. Dependency is FLATTENED onto
  // root signals (a composite source contributes ITS roots), so propagation order matches the
  // spec even for a composite-of-a-composite.
  static any(signals) {
    const combined = new AbortSignal();
    for (const s of signals || []) {
      if (s && s.aborted) { combined.aborted = true; combined.reason = s.reason; return combined; }
    }
    combined._sourceSignals = [];
    for (const s of signals || []) {
      if (s instanceof AbortSignal) {
        const roots = (s._sourceSignals && s._sourceSignals.length) ? s._sourceSignals : [s];
        for (const root of roots) {
          (root._dependents || (root._dependents = [])).push(combined);
          combined._sourceSignals.push(root);
        }
      } else if (s && typeof s.addEventListener === 'function') {
        // A non-AbortSignal (cross-realm / duck-typed) source can't join the dependent graph;
        // fall back to a plain listener.
        s.addEventListener('abort', () => combined._signalAbort(s.reason));
      }
    }
    return combined;
  }
}

export class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) { this.signal._signalAbort(reason); }
}

defineEventHandlers(AbortSignal.prototype, ['abort']);
globalThis.AbortSignal     = AbortSignal;
globalThis.AbortController = AbortController;
