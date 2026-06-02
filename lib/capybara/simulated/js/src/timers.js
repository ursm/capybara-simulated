// Virtual clock + timer queue.
//
// Tests don't sleep; Ruby calls `__drainTimers(N)` (`tick_real_time`)
// before each find / has_? so the virtual clock advances by however
// much wall-clock has actually elapsed between Capybara polls.
// `__setTimersActive` (Ruby host fn) flips the side flag so
// `Driver#wait?` returns true while work is pending.

import { hasObservers, hasQueuedRecords, deliverMutations } from './mutation-observer.js';
import { recheckIntersectionObservers }                    from './observers.js';
import { logThrew }                                        from './console.js';

// Cache host-fn property loads at module top — `setTimersActive` is
// the per-empty-transition `globalThis` access on every setTimeout /
// clearTimeout / drain end; this turns it into a closure-bound call.
const setTimersActive = function (flag) { globalThis.__setTimersActive(flag); };

const timers = new Map();        // id → {handler, args, due, period?}
let   nextTimerId = 1;
let   virtualNow  = 0;

// Backburner (Ember's runloop scheduler) stores debounce/run-later
// deadlines as `executeAt = Date.now() + wait`, then on each
// `setTimeout`-driven tick checks `Date.now() >= executeAt`. With
// `Date.now()` pinned to real wall clock while `setTimeout` advances
// virtual time, `executeAt` never catches up and Backburner reschedules
// itself forever. Offset `Date.now()` by cumulative virtual-clock
// advance so wall-clock deadline checks observe the same elapsed time
// `setTimeout` saw. Real wall-clock pass-through preserves explicit
// `sleep`-driven gaps (e.g. the `click delay` between mousedown /
// mouseup, Capybara's own polling spans).
let virtualOffsetMs = 0;
// Time-travel offset. Ruby specs that `freeze_time(...)` /
// `travel_to(...)` shift `Time.now` server-side; the in-process app's
// rendering, model factories, and trend computations all observe the
// frozen value. The JS-side runs in the same process but `Date.now`
// returns real wall clock, so client-side date math (Discourse's
// `moment()` calls in admin-dashboard-tab.js → `last 30 days` window,
// freshly-typed `created_at`, etc.) diverges from what the server
// just sent and trend / range UIs render against the wrong period.
// Ruby pushes `Time.now - real_wall_clock_now` here on each VM
// rebuild; JS adds it on top of `virtualOffsetMs` so Backburner
// debounce checks still see virtual-clock advance during the test.
let timeTravelOffsetMs = 0;
const _origDateNow = Date.now;
Date.now = function () { return _origDateNow() + virtualOffsetMs + timeTravelOffsetMs; };
globalThis.__csimSetTimeTravelOffsetMs = function (ms) {
  timeTravelOffsetMs = Number.isFinite(ms) ? ms : 0;
  installVirtualDate();
};
// Wrap the `Date` constructor only after the first virtual-clock drain,
// so the common case (no offset) keeps the native `new Date()` fast path.
function installVirtualDate() {
  if (globalThis.Date !== _OrigDate) return;
  function VirtualDate(...args) {
    if (args.length === 0) return new _OrigDate(_origDateNow() + virtualOffsetMs);
    return new _OrigDate(...args);
  }
  VirtualDate.prototype = _OrigDate.prototype;
  VirtualDate.now   = Date.now;
  VirtualDate.parse = _OrigDate.parse;
  VirtualDate.UTC   = _OrigDate.UTC;
  Object.setPrototypeOf(VirtualDate, _OrigDate);
  globalThis.Date = VirtualDate;
}
const _OrigDate = globalThis.Date;

// HTML timer "timeout" is a WebIDL `long` (int32): ToInt32 the argument, then
// "if timeout is less than 0, set timeout to 0". So `setTimeout(f, 2**32)` wraps
// to 0 and fires promptly (matching browsers), and a negative delay becomes 0.
// `ms | 0` is exactly ToInt32 (NaN/undefined → 0, 2**32 → 0, 2**31 → -2**31).
function toTimerDelay(ms) {
  const n = ms | 0;
  return n < 0 ? 0 : n;
}

export function scheduleTimer(handler, ms, args, period) {
  // `TimerHandler` is `(Function or DOMString)`: a non-callable handler is
  // coerced to a string NOW — so a `toString` side effect (the WebIDL "evil"
  // example) runs at call time — and eval'd at global scope when it fires. This
  // also means a non-function handler still returns a valid (non-zero) id.
  const h = typeof handler === 'function' ? handler : String(handler);
  const id = nextTimerId++;
  const delay = toTimerDelay(ms);
  const wasEmpty = timers.size === 0;
  timers.set(id, { handler: h, args, due: virtualNow + delay, period });
  if (wasEmpty) setTimersActive(true);
  return id;
}

globalThis.setTimeout    = function (h, ms, ...a) { return scheduleTimer(h, ms, a, null); };
globalThis.setInterval   = function (h, ms, ...a) { return scheduleTimer(h, ms, a, Math.max(1, toTimerDelay(ms))); };
globalThis.clearTimeout  = function (id) {
  if (timers.delete(id) && timers.size === 0) setTimersActive(false);
};
globalThis.clearInterval = globalThis.clearTimeout;

// `requestAnimationFrame` — real browsers fire callbacks before the
// next paint, which sits between current task and microtask drain.
// We have no paint pipeline, so the closest semantic match is
// "before the next macrotask but after currently-queued microtasks."
// Implementing as `Promise.resolve().then(cb)` collapses it into the
// microtask queue, which mini_racer drains fully at each eval
// boundary. That keeps Turbo's `Visit.render` (which awaits
// `new Promise((resolve) => requestAnimationFrame(resolve))`) moving
// in the same `settle` iter that triggered the click — without
// this, the Promise resolves only after a 16 ms virtual-clock
// advance, and settle's "yield on first observable change" bails on
// the click's pre-rAF mutations before `drain_timers` runs.
// Returns a synthetic id so `cancelAnimationFrame` can match — fall
// back to no-op cancel since microtasks aren't directly cancellable;
// callbacks check a flag, or guard inside the function. Avo / Turbo
// don't cancel rAF in any hot path that matters here.
let rafIdSeq = 1;
const rafCancelled = new Set();
globalThis.requestAnimationFrame = function (cb) {
  const id = rafIdSeq++;
  Promise.resolve().then(() => {
    if (rafCancelled.has(id)) { rafCancelled.delete(id); return; }
    try { cb(virtualNow); } catch (e) {
      logThrew('requestAnimationFrame cb', e);
    }
  });
  return id;
};
globalThis.cancelAnimationFrame = function (id) {
  if (id != null) rafCancelled.add(id);
};
// queueMicrotask — spec says "schedule for next microtask
// checkpoint" (the V8 job queue, drained at eval boundaries). We
// route it through `setTimeout(0)` instead, intentionally trading
// spec timing for control: the settle protocol (`__settleGen`
// yields on first observable change) was tuned for the pacing of a
// macrotask-backed scheduler. Routing queueMicrotask through V8's
// real microtask queue collapses Promise chains into a single
// observable boundary, and settle bails before downstream consumers
// (Avo's Turbo-frame render path, IntersectionObserver retries) see
// the intermediate states they expect. See bridge.entry.js's note
// on `PromiseRejectionEvent` for the same trade-off at the
// constructor-detection level.
globalThis.queueMicrotask = function (cb) {
  // WebIDL: the callback is a `VoidFunction` — a non-callable arg is a TypeError
  // at the binding layer (NOT coerced to a string handler the way the general
  // `TimerHandler` union is). Must throw before scheduling.
  if (typeof cb !== 'function') {
    throw new TypeError("Failed to execute 'queueMicrotask': parameter 1 is not of type 'Function'.");
  }
  scheduleTimer(cb, 0, [], null);
};

globalThis.__virtualNow    = () => virtualNow;
globalThis.__hasReadyTimer = function () {
  for (const t of timers.values()) if (t.due <= virtualNow) return true;
  return false;
};

// Returns the number of timers fired during this drain. Ruby uses
// the count to invalidate the find-result cache: any fired timer
// could have mutated the DOM, so cached find results from before
// the drain are no longer safe to reuse.
globalThis.__drainTimers = function (maxMs, maxIter) {
  if (typeof maxMs   !== 'number') maxMs   = 2000;
  if (typeof maxIter !== 'number') maxIter = 10000;
  const startNow = virtualNow;
  const limit = virtualNow + maxMs;
  let iter = 0;
  let fired = 0;
  while (iter++ < maxIter && timers.size > 0) {
    let nextId = null, nextDue = Infinity;
    for (const [id, t] of timers) {
      if (t.due < nextDue) { nextDue = t.due; nextId = id; }
    }
    if (nextId === null || nextDue > limit) break;
    virtualNow = nextDue;
    const t = timers.get(nextId);
    if (t.period != null) t.due = virtualNow + t.period;
    else timers.delete(nextId);
    try {
      if (typeof t.handler === 'function') t.handler.apply(null, t.args || []);
      else (0, eval)(t.handler);   // string TimerHandler: eval at global scope
    }
    catch (e) {
      try {
        const where = (t.handler && t.handler.toString && t.handler.toString().slice(0, 200)) || '(no source)';
        console.error('[csim] timer threw:', e && (e.stack || e.message), '\n  handler:', where);
      } catch (_) {}
    }
    if (hasObservers() && hasQueuedRecords()) deliverMutations();
    recheckIntersectionObservers();
    fired++;
  }
  // Pin clock at limit even when nothing fired, so a follow-up
  // drain reflects cumulative elapsed time.
  if (virtualNow < limit) virtualNow = limit;
  if (virtualNow > startNow) {
    virtualOffsetMs += virtualNow - startNow;
    installVirtualDate();
  }
  if (timers.size === 0) setTimersActive(false);
  return fired;
};

export function timerStats() {
  return { size: timers.size, virtualNow };
}

export function resetTimers() {
  const had = timers.size > 0;
  timers.clear();
  virtualNow = 0;
  if (had) setTimersActive(false);
}
globalThis.__resetTimers = resetTimers;
