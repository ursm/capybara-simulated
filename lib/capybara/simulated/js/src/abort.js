// AbortSignal / AbortController — minimum shapes for feature
// detection + `signal.aborted` polling. Real-browser `fetch` passes
// a signal so handlers can cancel; we don't honor cancellation
// (`__rackFetch` is synchronous), but Uppy's `AbortSignal.any([a, b])`
// needs working `addEventListener('abort', …)` + propagation.

export class AbortSignal {
  constructor() {
    this.aborted = false;
    this.reason  = undefined;
    this._listeners = [];
  }
  addEventListener(type, handler) {
    if (type !== 'abort' || typeof handler !== 'function') return;
    this._listeners.push(handler);
  }
  removeEventListener(type, handler) {
    if (type !== 'abort') return;
    this._listeners = this._listeners.filter(h => h !== handler);
  }
  dispatchEvent() {}
  _fireAbort() {
    for (const h of this._listeners.slice()) {
      try { h.call(this, {type: 'abort', target: this}); } catch (_) {}
    }
  }
  throwIfAborted() { if (this.aborted) throw this.reason || new Error('AbortError'); }
  static abort(reason) {
    const s = new AbortSignal();
    s.aborted = true;
    s.reason  = reason;
    return s;
  }
  static timeout() { return new AbortSignal(); }
  // Spec: signal that aborts when any input signal aborts. If any
  // input is already aborted, the returned signal is born aborted
  // with that signal's reason. Uppy's XHRUpload composes per-file
  // and per-bundle abort signals through this.
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
      s.addEventListener('abort', () => {
        if (combined.aborted) return;
        combined.aborted = true;
        combined.reason  = s.reason;
        combined._fireAbort();
      });
    }
    return combined;
  }
}

export class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason  = reason;
    this.signal._fireAbort();
  }
}

globalThis.AbortSignal     = AbortSignal;
globalThis.AbortController = AbortController;
