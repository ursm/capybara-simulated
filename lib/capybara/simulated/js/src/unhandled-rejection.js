// Surface otherwise-silent Promise rejections. The V8 embedding's
// microtask drain doesn't expose unhandled rejections to JS (no
// DevTools to route them to), so a `Promise.resolve().then(() =>
// undef.foo)` chain inside an app's lazy module init disappears
// without trace. We wrap `.then(onF)` (no onR) to insert a logging
// onR; calls that already pass an `onR` — including `.catch(h)` —
// bypass us. Each error is tagged the first time we observe it so
// cascading no-onR `.then`s in the same chain don't re-log.
//
// We also fire `unhandledrejection` on `globalThis` with a
// `PromiseRejectionEvent` so listeners attached via
// `addEventListener('unhandledrejection', …)` get notified per WHATWG
// HTML. `PromiseRejectionEvent` is also exposed as a global so
// `event instanceof PromiseRejectionEvent` works for app code.

import { PromiseRejectionEvent } from './events.js';

const LOGGED = '__csimRejectionLogged';

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

function logErr(err, kind, promise) {
  if (err == null) return;
  // Dedup on the reason object so a no-onR `.then` cascade re-throwing the same
  // error logs once. A PRIMITIVE reason (`Promise.reject('x')`) can't carry the
  // tag — and writing a property to a primitive throws in strict-mode ESM — so
  // only tag objects; primitives fall through (rare, at worst logged twice).
  if (typeof err === 'object') {
    if (err[LOGGED]) return;
    err[LOGGED] = true;
  }
  const prevented = fireUnhandledRejection(promise || null, err);
  if (prevented) return;
  try {
    const ctor = err.constructor && err.constructor.name;
    const msg  = err.message ? (ctor ? ctor + ': ' : '') + err.message : String(err);
    const stk  = err.stack ? '\n' + err.stack.slice(0, 600) : '';
    console.error('unhandled rejection (' + kind + '):', msg, stk);
  } catch (_) {}
}

// ── Native channel ──────────────────────────────────────────────────
// The `.then`-wrap below only observes promises somebody calls `.then` on.
// A rejection with NO handler ever attached — a fire-and-forget async
// function (`el.onclick = async () => { await save(); }` where save
// throws), a bare `Promise.reject(...)` in module init — never flows
// through it; `await` chains use V8's internal PerformPromiseThen and
// bypass the patch entirely. Those are exactly what V8's
// SetPromiseRejectCallback reports. rusty_racer forwards it via
// `RustyRacer.setPromiseRejectHandler` as raw (event, contextId, promise,
// reason) at reject time, leaving HTML's checkpoint-timing bookkeeping to
// us: collect no-handler rejections (event 0), drop ones that gain a
// handler before the flush (event 1), and flush survivors from a queued
// microtask — an approximation of "fire `unhandledrejection` when the
// microtask queue empties". Registration happens from Ruby post-snapshot
// (`V8Runtime.attach_host_fns`) because the host namespace doesn't exist
// while the snapshot is built. The recorder is isolate-wide and lives in
// the MAIN realm; `__csimLogUnhandledRejection` (defined per realm — every
// realm replays this module from the snapshot) lets it route each event to
// the rejecting promise's own realm via `RustyRacer.contextGlobal`, like
// the native callback used to.

globalThis.__csimLogUnhandledRejection = function (reason, promise) {
  try { logErr(reason, 'unhandled', promise); } catch (_) {}
};

const pendingRejections   = new Map();
let   rejectionFlushQueued = false;

function flushRejections() {
  rejectionFlushQueued = false;
  const entries = [...pendingRejections.entries()];
  pendingRejections.clear();
  for (const [promise, rec] of entries) {
    let log = globalThis.__csimLogUnhandledRejection;
    try {
      const NS = globalThis.RustyRacer;
      if (NS && rec.contextId != null && typeof NS.contextGlobal === 'function') {
        const g = NS.contextGlobal(rec.contextId);
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
      // origThen, not the patched `.then`: the flush never rejects, and the
      // wrapper would just add a useless propagation handler.
      origThen.call(Promise.resolve(), flushRejections);
    }
  } else if (event === 1) {     // handler added after reject
    pendingRejections.delete(promise);
  }
  // events 2/3 (reject/resolve after resolved) carry no unhandled state.
};

const origThen = Promise.prototype.then;
const alreadyWrapped = new WeakSet();

function propagateAndLog(self) {
  return function (err) {
    logErr(err, 'propagated', self);
    throw err;
  };
}

function wrapOnF(self, onF) {
  if (typeof onF !== 'function') return onF;
  return function (v) {
    try { return onF.call(this, v); }
    catch (e) { logErr(e, 'onF threw', self); throw e; }
  };
}

Promise.prototype.then = function (onF, onR) {
  if (typeof onR === 'function') return origThen.call(this, onF, onR);
  if (alreadyWrapped.has(this))   return origThen.call(this, onF);
  const next = origThen.call(this, wrapOnF(this, onF), propagateAndLog(this));
  alreadyWrapped.add(next);
  return next;
};
