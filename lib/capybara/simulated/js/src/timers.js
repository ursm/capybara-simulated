// Virtual clock + timer queue.
//
// Tests don't sleep; Ruby calls `__drainTimers(N)` (`tick_real_time`)
// before each find / has_? so the virtual clock advances by however
// much wall-clock has actually elapsed between Capybara polls.
// `__setTimersActive` (Ruby host fn) flips the side flag so
// `Driver#wait?` returns true while work is pending.

import { hasObservers, hasQueuedRecords, deliverMutations, currentSettleGen } from './mutation-observer.js';
import { updateIntersectionObservations }                  from './observers.js';
import { logThrew }                                        from './console.js';

// Cache host-fn property loads at module top — `setTimersActive` is
// the per-empty-transition `globalThis` access on every setTimeout /
// clearTimeout / drain end; this turns it into a closure-bound call.
const setTimersActive = function (flag) { globalThis.__setTimersActive(flag); };

const timers = new Map();        // id → {handler, args, due, period?, nesting}
let   nextTimerId = 1;
let   virtualNow  = 0;

// Event-loop state. `rafCallbacks` is the requestAnimationFrame queue, drained
// in the render phase of `__runLoopStep` (rAF moved off the microtask queue).
// The active-flag (`__setTimersActive`) is a host fn, so it's only toggled on
// the idle⇄active transition of the whole pending set — `pendingEmpty` is a
// pure-JS check that keeps that host call off the per-schedule path.
const rafCallbacks = [];
const rafCancelled = new Set();
let   rafIdSeq = 1;
function pendingEmpty() { return timers.size === 0 && rafCallbacks.length === 0; }
// One microtask checkpoint — the native, in-isolate `RustyRacer.drainMicrotasks`
// (aliased to `__csim_yield` by v8_runtime.rb), so it's ~sub-µs, not a
// cross-thread round-trip. Drains Promise continuations + the microtask-scheduled
// MutationObserver delivery (which itself rechecks IntersectionObservers).
function microcheck() { const f = globalThis.__csim_yield; if (f) f(); }

// Backburner (Ember's runloop scheduler) stores debounce/run-later
// deadlines as `executeAt = Date.now() + wait`, then on each
// `setTimeout`-driven tick checks `Date.now() >= executeAt`. With
// `Date.now()` pinned to real wall clock while `setTimeout` advances
// virtual time, `executeAt` never catches up and Backburner reschedules
// itself forever. So `Date.now()` adds the live virtual-clock advance
// (`virtualNow`) on top of real wall time, so wall-clock deadline checks
// observe the same elapsed time `setTimeout` saw. Real wall-clock
// pass-through preserves explicit `sleep`-driven gaps (e.g. the `click
// delay` between mousedown / mouseup, Capybara's own polling spans).
//
// `virtualNow` is added LIVE — it tracks the current instant continuously,
// not folded in at each `__runLoopStep` boundary — so a `Date.now()` /
// `performance.now()` read inside a timer callback sees the exact virtual
// instant it fired at. (Folding only at the per-step boundary made the clock
// jump in whole-frame chunks, so two reads straddling a step boundary differed
// by a frame even when the timers between them were 1 ms apart — the
// timer-nesting-not-inherited regression.) There is no cross-page base to
// carry: each navigation rebuilds the realm fresh, so `virtualNow` starts at 0
// per page and the timer module re-initialises with it.
// Time-travel offset. Ruby specs that `freeze_time(...)` /
// `travel_to(...)` shift `Time.now` server-side; the in-process app's
// rendering, model factories, and trend computations all observe the
// frozen value. The JS-side runs in the same process but `Date.now`
// returns real wall clock, so client-side date math (Discourse's
// `moment()` calls in admin-dashboard-tab.js → `last 30 days` window,
// freshly-typed `created_at`, etc.) diverges from what the server
// just sent and trend / range UIs render against the wrong period.
// Ruby pushes `Time.now - real_wall_clock_now` here on each VM
// rebuild; JS adds it alongside `virtualNow` so Backburner debounce
// checks still see virtual-clock advance during the test.
let timeTravelOffsetMs = 0;
const _origDateNow = Date.now;
Date.now = function () { return _origDateNow() + virtualNow + timeTravelOffsetMs; };
globalThis.__csimSetTimeTravelOffsetMs = function (ms) {
  timeTravelOffsetMs = Number.isFinite(ms) ? ms : 0;
  installVirtualDate();
};
// Wrap the `Date` constructor only after the first virtual-clock drain,
// so the common case (no offset) keeps the native `new Date()` fast path.
function installVirtualDate() {
  if (globalThis.Date !== _OrigDate) return;
  function VirtualDate(...args) {
    if (args.length === 0) return new _OrigDate(Date.now());
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
  // NOTE: the HTML 4ms nesting clamp is deliberately NOT implemented yet — it
  // flips no in-scope WPT test (timer-nesting-not-inherited passes without it
  // because an unclamped sub-4ms timer keeps its delay) and a half-correct
  // version (interval nesting escalation, queueMicrotask non-inheritance) is
  // easy to get subtly wrong. Add it WITH a vendored interval-throttling oracle.
  const wasIdle = pendingEmpty();
  timers.set(id, { handler: h, args, due: virtualNow + delay, period });
  if (wasIdle) setTimersActive(true);
  return id;
}

globalThis.setTimeout    = function (h, ms, ...a) { return scheduleTimer(h, ms, a, null); };
globalThis.setInterval   = function (h, ms, ...a) { return scheduleTimer(h, ms, a, Math.max(1, toTimerDelay(ms))); };
globalThis.clearTimeout  = function (id) {
  if (timers.delete(id) && pendingEmpty()) setTimersActive(false);
};
globalThis.clearInterval = globalThis.clearTimeout;

// `requestAnimationFrame` — real browsers fire callbacks in the rendering steps
// of the event loop, after the current task + its microtask checkpoint. We queue
// them on `rafCallbacks` and drain them in the render phase of `__runLoopStep`
// (with a microtask checkpoint after each, per spec). Because Ruby drives one
// `__runLoopStep` per Capybara poll = one virtual frame, Turbo's
// `await new Promise(r => requestAnimationFrame(r))` still resolves within the
// step the click triggered (the feedback_raf_as_microtask invariant), now via an
// ordered render phase rather than the microtask hack. A pending rAF keeps the
// active flag set so polling continues until the render phase runs.
// `cancelAnimationFrame` flags the id; honoured in the render-phase loop.
globalThis.requestAnimationFrame = function (cb) {
  const id = rafIdSeq++;
  const wasIdle = pendingEmpty();
  rafCallbacks.push({ id, cb });
  if (wasIdle) setTimersActive(true);
  return id;
};
globalThis.cancelAnimationFrame = function (id) {
  if (id != null) rafCancelled.add(id);
};
// queueMicrotask — spec says "queue a microtask": schedule the callback on the
// agent's microtask queue, which runs at the next checkpoint before the next
// macrotask. We route it onto V8's own job queue, which `microcheck()` (the
// native `RustyRacer.drainMicrotasks` checkpoint, run on every `__runLoopStep`
// task + render phase, and implicitly at every eval boundary under V8's kAuto
// policy) drains to exhaustion — so a `queueMicrotask -> DOM -> queueMicrotask`
// chain fully settles within the step that triggered it. settle stays live
// across such chains because `settleGen` bumps synchronously in-isolate on each
// DOM/URL mutation regardless of which job queue is running, so it does NOT
// need this to register as a pending macrotask.
globalThis.queueMicrotask = function (cb) {
  // WebIDL: the callback is a `VoidFunction` — a non-callable arg is a TypeError
  // at the binding layer (NOT coerced to a string handler the way the general
  // `TimerHandler` union is). Must throw before scheduling.
  if (typeof cb !== 'function') {
    throw new TypeError("Failed to execute 'queueMicrotask': parameter 1 is not of type 'Function'.");
  }
  // Two subtleties in the routing:
  //   - `() => cb()` (not `.then(cb)`): a VoidFunction takes no arguments, so
  //     the Promise's resolution value must not leak through as cb's first arg.
  //   - try/reportError: per HTML "report the exception", a throwing microtask
  //     surfaces through `reportError` (a global `error` event), NOT an unhandled
  //     promise rejection. Letting the throw reject this Promise would mis-route
  //     it through the PromiseRejectionEvent channel and fire apps'
  //     `unhandledrejection` listeners (Sentry et al.) where a real browser
  //     fires an `error` event instead.
  Promise.resolve().then(() => {
    try { cb(); } catch (e) { globalThis.__csimReportCallbackError(cb, e); }
  });
};

globalThis.__virtualNow    = () => virtualNow;
globalThis.__hasReadyTimer = function () {
  // A pending rAF is runnable work (it runs in __runLoopStep's render phase),
  // so it must count here — the Worker run-loop gates its drain on this (workers
  // no-op __setTimersActive), and without it a worker requestAnimationFrame with
  // no co-pending timer would never fire now that rAF is off the microtask queue.
  if (rafCallbacks.length) return true;
  for (const t of timers.values()) if (t.due <= virtualNow) return true;
  return false;
};
// Like __hasReadyTimer but TIMERS ONLY (ignores a pending rAF). The cross-realm
// budget-0 interleave flush (drainChildRealms) gates on this so it interleaves a
// child's due-now timer with the parent's tasks, yet leaves a child's rAF to fire
// on its normal once-per-step cadence in the full-budget drain.
globalThis.__hasDueTimer = function () {
  for (const t of timers.values()) if (t.due <= virtualNow) return true;
  return false;
};

// Smallest scheduled-timer `due` RELATIVE to virtualNow (ms), or -1 if none.
// A pending rAF is runnable in the next render phase → reports 0 (mirrors
// __hasReadyTimer counting rAF). The Ruby horizon gate (tick_real_time) uses
// this to decide whether the next timer is close enough to fast-forward to, vs
// a far-future session/analytics/ahoy timer to leave parked. Pure scan of the
// same Map __hasReadyTimer walks — no new state.
globalThis.__nextTimerDelay = function () {
  if (rafCallbacks.length) return 0;
  let min = Infinity;
  for (const t of timers.values()) { const d = t.due - virtualNow; if (d < min) min = d; }
  if (min === Infinity) return -1;
  return min < 0 ? 0 : min;
};

// Once the virtual clock has advanced this step, swap in `VirtualDate` so
// `new Date()` (no args) also observes virtual time. The live advance lives in
// `Date.now` (via `virtualNow`), so this only needs to flip the constructor the
// first time the clock diverges — no per-step accumulation (that lag was the
// timer-nesting regression).
function installVirtualDateIfAdvanced(startNow) {
  if (virtualNow > startNow) installVirtualDate();
}
// The render phase — run ONCE per `__runLoopStep`, after the currently-due task
// batch drains (not per-fire). Mirrors the HTML "update the rendering" steps we
// can model: rAF callbacks (each followed by a microtask checkpoint, the spec
// ordering invariant), then an IntersectionObserver recheck, then any
// still-queued MutationObserver delivery, then a final checkpoint. (Per-task
// `microcheck()` already drains the microtask-scheduled MO delivery + its IO
// recheck mid-step; these are the once-per-frame backstop.)
function runRenderPhase() {
  // Microtask checkpoint precedes the rendering steps: a pending microtask may
  // be what SCHEDULES an rAF (Turbo's `await new Promise(r => rAF(r))` — the
  // Promise.then runs here and queues the rAF), so drain microtasks before the
  // rAF queue, not after.
  microcheck();
  if (rafCallbacks.length) {
    const frame = rafCallbacks.splice(0, rafCallbacks.length);  // rAFs queued by these cbs run NEXT step
    for (const { id, cb } of frame) {
      if (rafCancelled.has(id)) { rafCancelled.delete(id); continue; }
      try { cb(virtualNow); } catch (e) { logThrew('requestAnimationFrame cb', e); }
      microcheck();
    }
  }
  updateIntersectionObservations();
  // Dispatch any "pending scroll event targets" (CSSOM-View): scrollend fires
  // here, in the rendering update — not synchronously at scroll time — so a
  // scroller removed before this step has its pending scrollend dropped.
  if (typeof globalThis.__csimFlushScrollEnd === 'function') globalThis.__csimFlushScrollEnd();
  if (hasObservers() && hasQueuedRecords()) deliverMutations();
  microcheck();
  // End of this frame's checkpoints == a task boundary: clear the legacy
  // `window.event` an event-loop-driven dispatch may have left set for its
  // continuations (see runLoopStepLocal / maybeFireFrameLoad), so it doesn't
  // leak past the frame into a later task or a Ruby-side evaluate_script.
  globalThis.event = undefined;
}

// One run of the event loop's task→microtask-checkpoint→render sequence, bounded
// by `maxMs` of virtual time and `maxIter` tasks. ONE host call: pick/run/
// checkpoint/render all happen JS-side (no per-task Ruby boundary). Returns
// `{ fired, gen, dirtied, raf }` — `fired` = tasks run (the find-cache-invalidation
// count that `__drainTimers` callers want), `gen` = the settleGen after the step
// (Ruby dirties the find cache on a gen delta), `dirtied` = gen changed this step,
// `raf` = an animation frame is still queued AFTER the render phase (a continuing
// rAF chain — lets a frame-cadence caller tell "more frames to render" from idle
// even when the rAF mutated nothing). When `yieldOnGen`, returns to Ruby the
// instant settleGen bumps (one observable boundary per poll — the settle
// gen-yield contract).
const runLoopStepLocal = function (maxMs, maxIter, yieldOnGen) {
  if (typeof maxMs   !== 'number') maxMs   = 2000;
  if (typeof maxIter !== 'number') maxIter = 10000;
  yieldOnGen = !!yieldOnGen;
  // The legacy `window.event` (current event) is cleared at each task boundary
  // below (after every per-task microtask checkpoint, and at the end of the
  // render phase): an event-loop-driven dispatch (e.g. frame `load`,
  // maybeFireFrameLoad) LEAVES it set so its same-checkpoint promise
  // continuations observe it (DOM "inner invoke": the checkpoint in "clean up
  // after running script" precedes the per-listener current-event restore), then
  // the boundary clear ensures the NEXT task / a later-resumed continuation sees
  // `undefined`, matching real browsers. A synchronous dispatch restores
  // `window.event` itself, so these clears are no-ops for the common case.
  const startNow = virtualNow;
  const limit    = virtualNow + maxMs;
  const startGen = currentSettleGen();
  let iter = 0, fired = 0;
  // A same-origin child iframe shares this realm's event loop (HTML "agent"), so a
  // child task already due when this step begins must run BEFORE this realm's task
  // chain — not after the whole chain drains (the wrapper's full-budget
  // drainChildRealms ran only once, at the end). Flush those due-now child tasks
  // up front (budget 0 — no clock advance), the way a single merged task queue
  // would have ordered a child's queued 0 ms callback ahead of a parent task only
  // scheduled mid-chain. `child` folds the fired / dirtied counts into the return.
  //
  // This interleaves only tasks ALREADY due at step start; a child timer due later
  // this step (or one a parent task schedules mid-chain) still fires in the
  // wrapper's full-budget drain, i.e. ordered after the parent chain. That residual
  // is the bounded cost of each realm keeping its own virtual clock (no shared
  // clock to express true lockstep cross-realm ordering); no app/test depends on
  // cross-realm ordering of non-zero-delay timers. The gate is a single `.size`
  // check, so the common no-iframe page pays nothing.
  // (html/webappapis/timers/settimeout-detached-iframe: the attached frame's 0 ms
  // callback must run before the parent's nested step_timeout chain completes.)
  const child = { fired: 0, dirtied: false };
  if (globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.size > 0) {
    drainChildRealms(0, maxIter, child);
  }

  while (true) {
    if (iter++ >= maxIter) { installVirtualDateIfAdvanced(startNow); const g = currentSettleGen(); return { fired: fired + child.fired, gen: g, dirtied: g !== startGen || child.dirtied, raf: rafCallbacks.length > 0 }; }
    // Pick the lowest-due timer; Map iteration is insertion order, so a strict
    // `<` keeps same-due timers in FIFO (scheduling) order.
    let nextId = null, nextDue = Infinity;
    for (const [id, t] of timers) {
      if (t.due < nextDue) { nextDue = t.due; nextId = id; }
    }
    if (nextId === null || nextDue > limit) break;   // nothing due within budget → render phase
    if (nextDue > virtualNow) virtualNow = nextDue;
    const t = timers.get(nextId);
    if (t.period != null) t.due = virtualNow + t.period;
    else timers.delete(nextId);

    try {
      if (typeof t.handler === 'function') t.handler.apply(null, t.args || []);
      else (0, eval)(t.handler);   // string TimerHandler: eval at global scope
    } catch (e) {
      // Per HTML "run the active timers", a throwing timer callback surfaces via
      // "report the exception" — a global `error` event (→ window.onerror), same
      // as queueMicrotask above — NOT a silently-swallowed log. The report fires
      // on the CALLBACK's realm (`frames[0].setTimeout(frames[1]-fn)` reports on
      // frame1), so route through `__csimReportCallbackError`. A string handler
      // (eval'd in this realm) has no callback realm → reported locally.
      try { globalThis.__csimReportCallbackError(typeof t.handler === 'function' ? t.handler : null, e); } catch (_) {}
    }
    fired++;
    microcheck();   // per-task microtask checkpoint (Promise continuations, MO delivery)
    // Per-task boundary: clear any `window.event` this task's event-loop-driven
    // dispatch left set for its (now-drained) continuations, so the NEXT task in
    // this step doesn't observe a stale current event (browsers clear per task).
    globalThis.event = undefined;
    if (yieldOnGen && currentSettleGen() !== startGen) {
      // Run this frame's render phase BEFORE yielding — an rAF scheduled this
      // step is part of the current frame and must not be deferred past the
      // gen-bail (else `setTimeout(()=>'B',50); rAF(()=>'R')` would yield after a
      // sibling timer fires, putting 'B' before 'R' vs the real-browser 'R' first).
      runRenderPhase();
      installVirtualDateIfAdvanced(startNow);      // yielded early — do NOT over-advance virtualNow to `limit`
      if (pendingEmpty()) setTimersActive(false);   // last work drained by this task → clear flag (don't strand polling)
      { const g = currentSettleGen(); return { fired: fired + child.fired, gen: g, dirtied: g !== startGen || child.dirtied, raf: rafCallbacks.length > 0 }; }
    }
  }

  runRenderPhase();
  // Pin the clock at `limit` even if idle, so a follow-up step reflects
  // cumulative elapsed virtual time.
  if (virtualNow < limit) virtualNow = limit;
  installVirtualDateIfAdvanced(startNow);
  if (pendingEmpty()) setTimersActive(false);
  const g = currentSettleGen();
  return { fired: fired + child.fired, gen: g, dirtied: g !== startGen || child.dirtied, raf: rafCallbacks.length > 0 };
};

// Each iframe realm runs its own event loop (own `timers` Map) on the shared
// clock. They're a separate V8 realm, so this realm's `__runLoopStep` must also
// step theirs — otherwise `frames[0].setTimeout(…)` never fires when timers are
// driven directly through JS (`evaluate_script('__drainTimers')`) rather than the
// Ruby runtime. `__csimChildRealmIds` is this realm's set of child realm ids
// (added in `__csimFrameWindow`, removed on re-navigation); empty/absent for the
// common no-iframe page, so the gate is a single cheap `.size` check. The child's
// own `__runLoopStep` is this same wrapper, so grandchildren step recursively.
function drainChildRealms(maxMs, maxIter, r) {
  const ids = globalThis.__csimChildRealmIds;
  if (!ids || !ids.size || !globalThis.RustyRacer || typeof globalThis.RustyRacer.contextGlobal !== 'function') return;
  // The budget-0 interleave flush (maxMs 0, from runLoopStepLocal) only needs to
  // run a child task ALREADY DUE — skip a child with no due-now TIMER so an idle or
  // merely-animating frame doesn't pay a step + render phase here. Gating on a
  // due-now timer (not __hasReadyTimer, which also counts a pending rAF) keeps a
  // child's rAF on its once-per-step cadence via the full-budget final drain rather
  // than firing it ahead of the parent's tasks. The full-budget drain (maxMs > 0)
  // always steps every child — a child timer due LATER this step must still fire.
  const dueNowOnly = maxMs === 0;
  for (const id of ids) {
    try {
      const g = globalThis.RustyRacer.contextGlobal(id);
      if (!g || typeof g.__runLoopStep !== 'function') continue;
      if (dueNowOnly && !(typeof g.__hasDueTimer === 'function' && g.__hasDueTimer())) continue;
      const cr = g.__runLoopStep(maxMs, maxIter, false);
      if (cr) { r.fired += cr.fired || 0; if (cr.dirtied) r.dirtied = true; }
    } catch (_) {}
  }
}
globalThis.__runLoopStep = function (maxMs, maxIter, yieldOnGen) {
  const r = runLoopStepLocal(maxMs, maxIter, yieldOnGen);
  drainChildRealms(maxMs, maxIter, r);
  return r;
};

// Back-compat alias: the wpt_runner harness + any fired-count caller drive
// `__drainTimers` and want the number fired (never the gen-yield bail).
globalThis.__drainTimers = function (maxMs, maxIter) {
  return globalThis.__runLoopStep(
    typeof maxMs   === 'number' ? maxMs   : 2000,
    typeof maxIter === 'number' ? maxIter : 10000,
    false
  ).fired;
};
// Is there a pending requestAnimationFrame callback? The wpt_runner uses this as
// a "an animation-frame chain is still running" progress signal: unlike
// `pendingEmpty()`, it EXCLUDES the timer set (so it isn't held true by a
// far-future timer such as testharness's own 10 s timeout), so the runner can
// keep pumping render phases while an rAF-gated async test (e.g. focus-navigation
// `await waitForRender()` per hop) progresses, yet still bail to the force-timeout
// once the page idles. A self-rescheduling animation loop keeps this true and is
// bounded by the runner's frame cap.
globalThis.__csimHasPendingRAF = function () { return rafCallbacks.length > 0; };

// Single clock-FREE probe of event-loop state, read once per `run_event_loop_frame`
// via a direct dom_call (NOT evaluate_script — so it never advances the virtual
// clock): a queued animation frame, a non-timer async channel in flight, and
// `nextTimer` = ms until the nearest scheduled timer (-1 = none). `nextTimer` lets
// a caller distinguish a page PARKED on a near-future `setTimeout` (e.g. a
// `step_timeout`-style 500 ms wait — a `scrollend` non-firing confirmation) from a
// genuinely idle one (only a far-future timer such as testharness's 10 s harness
// timeout left): without it the parked-timer case looks idle (no rAF, no async, no
// due-now work) and a caller would abandon the still-pending wait too early.
//
// Folds in CHILD realms: an iframe executor (the WPT dispatcher) polls on its OWN
// realm's timers, so a child-realm-only parked timer / rAF / async channel must keep
// the page non-idle — else the runner's idle-bail fires DURING a poll's randomDelay
// (≤100 ms, longer than a couple of frames) and force-timeouts a still-progressing
// multi-window test (the cross-partition.https flakiness). The child's own
// __csimEventLoopProbe recurses, so grandchildren are covered.
globalThis.__csimEventLoopProbe = function () {
  let raf       = typeof __csimHasPendingRAF === 'function'   ? !!__csimHasPendingRAF()   : false;
  let async     = typeof __csim_asyncIoPending === 'function' ? !!__csim_asyncIoPending() : false;
  let nextTimer = typeof __nextTimerDelay === 'function'      ? __nextTimerDelay()         : -1;
  if (typeof globalThis.__csimEachChildRealm === 'function') {
    globalThis.__csimEachChildRealm(g => {
      if (typeof g.__csimEventLoopProbe !== 'function') return undefined;
      const c = g.__csimEventLoopProbe();
      if (c) {
        if (c.raf)   raf   = true;
        if (c.async) async = true;
        if (c.nextTimer >= 0 && (nextTimer < 0 || c.nextTimer < nextTimer)) nextTimer = c.nextTimer;
      }
      return undefined;   // visit every child (aggregate)
    });
  }
  return { raf, async, nextTimer };
};

export function timerStats() {
  return { size: timers.size, virtualNow };
}

export function resetTimers() {
  const had = !pendingEmpty();
  timers.clear();
  rafCallbacks.length = 0;
  rafCancelled.clear();
  virtualNow = 0;
  if (had) setTimersActive(false);
}
globalThis.__resetTimers = resetTimers;
