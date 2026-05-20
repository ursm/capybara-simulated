// Virtual clock + timer queue.
//
// Tests don't sleep; Ruby calls `__drainTimers(N)` (`tick_real_time`)
// before each find / has_? so the virtual clock advances by however
// much wall-clock has actually elapsed between Capybara polls.
// `__setTimersActive` (Ruby host fn) flips the side flag so
// `Driver#wait?` returns true while work is pending.

import { hasObservers, hasQueuedRecords, deliverMutations } from './mutation-observer.js';

const timers = new Map();        // id → {handler, args, due, period?}
let   nextTimerId = 1;
let   virtualNow  = 0;

export function scheduleTimer(handler, ms, args, period) {
  if (typeof handler !== 'function') return 0;
  const id = nextTimerId++;
  const delay = Math.max(0, +ms || 0);
  const wasEmpty = timers.size === 0;
  timers.set(id, { handler, args, due: virtualNow + delay, period });
  if (wasEmpty) globalThis.__setTimersActive(true);
  return id;
}

globalThis.setTimeout    = function (h, ms, ...a) { return scheduleTimer(h, ms, a, null); };
globalThis.setInterval   = function (h, ms, ...a) { return scheduleTimer(h, ms, a, Math.max(1, +ms || 0)); };
globalThis.clearTimeout  = function (id) {
  if (timers.delete(id) && timers.size === 0) globalThis.__setTimersActive(false);
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
      try { console.error('[csim] requestAnimationFrame cb threw:', e && (e.message || e)); } catch (_) {}
    }
  });
  return id;
};
globalThis.cancelAnimationFrame = function (id) {
  if (id != null) rafCancelled.add(id);
};
// queueMicrotask: collapse to setTimeout(0). True microtasks run
// before the next macrotask, but on a virtual clock the difference
// is unobservable for the workloads we care about.
globalThis.queueMicrotask = function (cb) { scheduleTimer(cb, 0, [], null); };

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
    try { t.handler.apply(null, t.args || []); }
    catch (e) {
      try {
        const where = (t.handler && t.handler.toString && t.handler.toString().slice(0, 200)) || '(no source)';
        console.error('[csim] timer threw:', e && (e.stack || e.message), '\n  handler:', where);
      } catch (_) {}
    }
    if (hasObservers() && hasQueuedRecords()) deliverMutations();
    if (typeof globalThis.__recheckIntersectionObservers === 'function') globalThis.__recheckIntersectionObservers();
    fired++;
  }
  // Pin clock at limit even when nothing fired, so a follow-up
  // drain reflects cumulative elapsed time.
  if (virtualNow < limit) virtualNow = limit;
  if (timers.size === 0) globalThis.__setTimersActive(false);
  return fired;
};

export function timerStats() {
  return { size: timers.size, virtualNow };
}

export function resetTimers() {
  const had = timers.size > 0;
  timers.clear();
  virtualNow = 0;
  if (had) globalThis.__setTimersActive(false);
}
globalThis.__resetTimers = resetTimers;
