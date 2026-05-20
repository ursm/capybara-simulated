// Surface otherwise-silent Promise rejections. mini_racer + V8's
// microtask drain doesn't print unhandled rejections (no DevTools to
// route them to), so a `Promise.resolve().then(() => undef.foo)`
// chain inside an app's lazy module init disappears without trace.
// We wrap `.then(onF)` (no onR) to insert a logging onR; calls that
// already pass an `onR` — including `.catch(h)` — bypass us. Each
// error is tagged the first time we log it so cascading no-onR
// `.then`s in the same chain don't re-log.

const origThen = Promise.prototype.then;
const LOGGED   = '__csimRejectionLogged';

function logErr(err, kind) {
  if (!err || err[LOGGED]) return;
  try {
    err[LOGGED] = true;
    const ctor = err.constructor && err.constructor.name;
    const msg  = err.message ? (ctor ? ctor + ': ' : '') + err.message : String(err);
    const stk  = err.stack ? '\n' + err.stack.slice(0, 600) : '';
    console.error('unhandled rejection (' + kind + '):', msg, stk);
  } catch (_) {}
}

Promise.prototype.then = function (onF, onR) {
  if (typeof onR === 'function') return origThen.call(this, onF, onR);
  // Wrap onF to catch sync throws — `.then(cb)` with no onR loses
  // `cb`'s thrown error to the next microtask without any visible
  // log otherwise (a single-step `.then(callback)` chain has no
  // downstream .catch to pick it up).
  const wrappedOnF = typeof onF === 'function' ? function (v) {
    try { return onF.call(this, v); }
    catch (e) { logErr(e, 'onF threw'); throw e; }
  } : onF;
  // Also wrap the onR position so rejections propagating through a
  // multi-step chain (`.then(a).then(b)`) get logged at the first
  // downstream `.then` that doesn't supply its own onR.
  return origThen.call(this, wrappedOnF, function (err) {
    logErr(err, 'propagated');
    throw err;
  });
};
