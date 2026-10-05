// Surface otherwise-silent Promise rejections. A rejection no handler ever sees — a fire-and-forget async function
// (`el.onclick = async () => { await save(); }` where save throws), a `Promise.resolve().then(() => undef.foo)` chain
// in an app's lazy module init, a bare `Promise.reject(...)` — would disappear without trace: the V8 embedding has no
// DevTools to route it to. V8's SetPromiseRejectCallback reports each one; rusty_racer forwards it via
// `RustyRacer.setPromiseRejectHandler` as raw (event, contextId, promise, reason) at reject time, leaving HTML's
// checkpoint-timing bookkeeping to us: collect no-handler rejections (event 0), drop ones that gain a handler before
// the flush (event 1), and flush survivors from a queued microtask — an approximation of "fire `unhandledrejection`
// when the microtask queue empties". So a chain handled further down (`p.then(f).catch(h)`, testharness's
// `promise_rejects_js`) is no unhandled rejection: its derived promise gains its handler before the flush.
// Registration happens from Ruby post-snapshot (`V8Runtime.attach_host_fns`, every isolate's: the page's and each
// worker's) because the host namespace doesn't exist while the snapshot is built. The recorder is isolate-wide and
// lives in the MAIN realm; `__csimLogUnhandledRejection` (defined per realm — every realm replays this module from the
// snapshot) lets it route each event to the rejecting promise's own realm via `RustyRacer.contextGlobal`.
//
// Each survivor fires `unhandledrejection` on its realm's global (a `PromiseRejectionEvent`, cancelable; also exposed
// as a global so `event instanceof PromiseRejectionEvent` works for app code), and is logged unless a listener
// `preventDefault()`s it.

import { PromiseRejectionEvent } from './events.js';

// Fire `unhandledrejection` on `globalThis` per WHATWG HTML spec.
// `globalThis.dispatchEvent` runs the same window-listener list that
// `window.addEventListener('unhandledrejection', …)` populates. The
// event is cancelable; if a listener `preventDefault()`s it, we
// suppress the console error per spec.
function fireUnhandledRejection(promise, reason) {
  const ev = new PromiseRejectionEvent('unhandledrejection', {
    promise, reason, cancelable: true
  });
  try { globalThis.dispatchEvent(ev); } catch (_) {}
  try {
    const handler = globalThis.onunhandledrejection;
    if (typeof handler === 'function' && !ev.defaultPrevented) handler.call(globalThis, ev);
  } catch (_) {}
  return !!ev.defaultPrevented;
}

function logUnhandled(err, promise) {
  if (fireUnhandledRejection(promise || null, err)) return;
  try {
    const ctor = err != null && err.constructor && err.constructor.name;
    const msg  = err != null && err.message ? (ctor ? ctor + ': ' : '') + err.message : String(err);
    const stk  = err != null && err.stack ? '\n' + err.stack.slice(0, 600) : '';
    console.error('unhandled rejection:', msg, stk);
  } catch (_) {}
}

globalThis.__csimLogUnhandledRejection = function (reason, promise) {
  try { logUnhandled(reason, promise); } catch (_) {}
};

const pendingRejections   = new Map();
let   rejectionFlushQueued = false;
// (…queued by the intrinsic `then`, captured here: a page's own `queueMicrotask` / `Promise.prototype.then` is not
// what the driver runs)
const then = Promise.prototype.then, settled = Promise.resolve();

function flushRejections() {
  rejectionFlushQueued = false;
  const entries = [...pendingRejections.entries()];
  pendingRejections.clear();
  for (const [promise, rec] of entries) {
    let log = globalThis.__csimLogUnhandledRejection;
    try {
      if (rec.contextId != null) {
        const g = globalThis.RustyRacer.contextGlobal(rec.contextId);
        if (g && typeof g.__csimLogUnhandledRejection === 'function') {
          log = g.__csimLogUnhandledRejection;
        }
      }
    } catch (_) {}
    try { log(rec.reason, promise); } catch (_) {}
  }
}

globalThis.__csimPromiseRejected = function (event, contextId, promise, reason) {
  if (event === 0) {            // rejected, no handler
    pendingRejections.set(promise, { contextId, reason });
    if (!rejectionFlushQueued) {
      rejectionFlushQueued = true;
      then.call(settled, flushRejections);
    }
  } else if (event === 1) {     // handler added after reject
    pendingRejections.delete(promise);
  }
  // events 2/3 (reject/resolve after resolved) carry no unhandled state.
};
