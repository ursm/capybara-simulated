// Surface otherwise-silent Promise rejections. mini_racer + V8's
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

// mini_racer-csim's native unhandled-rejection callback (V8
// SetPromiseRejectCallback). It fires at the microtask-checkpoint end for a
// promise STILL unhandled then — the spec-accurate set, with handler-added-after-
// reject already excluded — and enters the rejecting promise's realm first, so
// `globalThis` here is that promise's global (correct event target, incl. an
// iframe realm's). Route through the same `logErr` path: the `LOGGED` tag dedups
// with the `.then` fallback below, so a rejection surfaces at most once.
globalThis.__mr_emitUnhandledRejection = function (reason, promise) {
  try { logErr(reason, 'unhandled', promise); } catch (_) {}
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
