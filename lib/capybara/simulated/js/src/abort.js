// AbortSignal / AbortController — minimum shapes for feature
// detection + `signal.aborted` polling. Real-browser `fetch`s pass a
// signal so handlers can cancel; we don't honor cancellation
// (`__rackFetch` is synchronous) but apps construct AbortControllers
// at startup and the constructor needs to succeed.

export function AbortSignal() {
  this.aborted = false;
}
AbortSignal.abort = function (reason) {
  const s = new AbortSignal();
  s.aborted = true; s.reason = reason;
  return s;
};
AbortSignal.timeout = function () {
  return new AbortSignal();
};

export function AbortController() {
  this.signal = {aborted: false, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}};
}
AbortController.prototype.abort = function () { this.signal.aborted = true; };
