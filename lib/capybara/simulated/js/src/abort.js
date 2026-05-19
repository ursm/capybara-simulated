// AbortSignal / AbortController — minimum shapes for feature
// detection + `signal.aborted` polling. Real-browser `fetch` passes
// a signal so handlers can cancel; we don't honor cancellation
// (`__rackFetch` is synchronous), but apps construct
// AbortControllers at startup and the constructors need to succeed.

export class AbortSignal {
  constructor() { this.aborted = false; }
  static abort(reason) {
    const s = new AbortSignal();
    s.aborted = true; s.reason = reason;
    return s;
  }
  static timeout() { return new AbortSignal(); }
}

export class AbortController {
  constructor() {
    this.signal = {aborted: false, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}};
  }
  abort() { this.signal.aborted = true; }
}
