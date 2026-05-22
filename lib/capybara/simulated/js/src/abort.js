// AbortSignal / AbortController — spec-compliant enough that
// `signal.aborted`, `addEventListener('abort', …)`, and
// `AbortSignal.any([a, b])` all work. We don't honour cancellation
// (`__rackFetch` is synchronous), but listener propagation is
// required for `AbortSignal.any` composition.

import { Event, EventTarget, DOMException } from './events.js';

function defaultAbortReason() { return new DOMException('signal is aborted without reason', 'AbortError'); }

export class AbortSignal extends EventTarget {
  constructor() {
    super();
    this.aborted = false;
    this.reason  = undefined;
  }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  _markAborted(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason  = reason === undefined ? defaultAbortReason() : reason;
    this.dispatchEvent(new Event('abort'));
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
    globalThis.setTimeout(() => s._markAborted(new DOMException('signal timed out', 'TimeoutError')), Number(ms) || 0);
    return s;
  }
  // Spec: returns a signal that aborts when any input signal aborts.
  // If any input is already aborted, the returned signal is born
  // aborted with that signal's reason.
  static any(signals) {
    const combined = new AbortSignal();
    for (const s of signals || []) {
      if (s && s.aborted) {
        combined.aborted = true;
        combined.reason  = s.reason;
        return combined;
      }
    }
    for (const s of signals || []) {
      if (!s || typeof s.addEventListener !== 'function') continue;
      s.addEventListener('abort', () => combined._markAborted(s.reason));
    }
    return combined;
  }
}

export class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) { this.signal._markAborted(reason); }
}

globalThis.AbortSignal     = AbortSignal;
globalThis.AbortController = AbortController;
