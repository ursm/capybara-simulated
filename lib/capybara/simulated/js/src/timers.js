// Virtual clock + timer queue.
//
// Tests don't sleep; Ruby calls `__drainTimers(N)` (`tick_real_time`)
// before each find / has_? so the virtual clock advances by however
// much wall-clock has actually elapsed between Capybara polls.
// `__setTimersActive` (Ruby host fn) flips the side flag so
// `Driver#wait?` returns true while work is pending.

import { agentGlobal, forgetLastRecord, isCallable, platformMicrotask, runningCallbacks } from './webidl.js';
import { hasObservers, hasQueuedRecords, deliverMutations, currentSettleGen } from './mutation-observer.js';
import { updateIntersectionObservations, updateResizeObservations } from './observers.js';
import { logThrew }                                        from './console.js';
import { animationNow, flushAnimationFrame } from './animation.js';

// Cache host-fn property loads at module top — `setTimersActive` is
// the per-empty-transition `globalThis` access on every setTimeout /
// clearTimeout / drain end; this turns it into a closure-bound call.
// (…and mirrored, so a source that only needs it ON asks the host only when it is off — on the isolate's MAIN realm,
// since every realm of it sets the one flag, its frames' and the windows it opened alike: a frame, or a popup, that
// cleared it left another window's own copy saying it was still on, and that window then woke nothing.)
// (…whether this realm is the main one asked once: a realm's number is its own for good — the main realm's global
// asked each time, which a new page's context replaces under the windows it opened)
let mainRealm = null;
const flagHolder = function () {
  const NS = globalThis.RustyRacer;
  if (!NS) return globalThis;
  mainRealm ??= NS.contextOf(globalThis) === 0;
  return mainRealm ? globalThis : NS.contextGlobal(0);
};
globalThis.__csimTimersActive = false;
// The window's clock — the main realm's — is followed by its workers (`Browser#run_worker`), which the host tells of it as
// a step leaves it. Once the tab has a worker to follow it, a step also tells the host as it moves the clock (`moveClock`):
// a task in the middle of a step that posts to a worker posts at its own time, and the worker must not read the time
// the step began at. Set from any realm of the tab, as it makes its first worker, service worker or remote port.
// (A worker's own realm follows nothing: its workers are the window's to follow too.)
export const followWindowClock = function () { if (globalThis.__csim_isWorker !== true) flagHolder().__csimClockFollowed = true; };
// A task of the tab's asked a worker something it answers on its own event loop — a fetch its service worker handles —
// which the window's step ends at (`runLoopStepBody`), for the host to run the worker up to that time before the window
// goes on (V8Runtime#run_loop_step, Browser#worker_due_at's `:asked`): the event dispatched at the time it was asked,
// whatever the worker's thread made of the race, and a timer its answer waits on due on the window's clock from then.
// (…none on a page that never had a worker to follow it: `followWindowClock` — a BroadcastChannel among its frames alone
// ends no step)
export const askedWorker = function () {
  if (globalThis.__csim_isWorker === true) return;
  const holder = flagHolder();
  if (holder.__csimClockFollowed === true) holder.__csimWorkerAsked = true;
};
const takeAsked = function () {
  const holder = flagHolder();
  if (holder.__csimWorkerAsked !== true) return false;
  holder.__csimWorkerAsked = false;
  return true;
};
// (…and by the host, for a page whose workers outlived the page before it: a service worker it may talk to without a
// ServiceWorker of its own — over a BroadcastChannel)
globalThis.__csimFollowWindowClock = followWindowClock;
// (…the host told, where it still hears this realm: a disposed frame's window, whose functions a page kept — its
// `requestAnimationFrame`, its `setTimeout` — has no host to tell, and those take nothing: timers.rs `takes_timers`)
const setTimersActive = function (flag) {
  try { globalThis.__setTimersActive(flag); } catch (_) { return; }
  flagHolder().__csimTimersActive = flag;
};
const timersActiveNow = function () { return flagHolder().__csimTimersActive === true; };
// The one sanctioned way for ANOTHER module's pending-work source (observers.js's
// pending intersections) to make the driver keep stepping: the same
// idle→active transition a newly scheduled timer makes. Exported so the flag
// access stays on this cached path rather than growing second, differently
// guarded `globalThis` loads elsewhere.
export function wakeLoop() { if (!timersActiveNow()) setTimersActive(true); }
// …and one owed a rendering update of its own — the focus fixup's (dom-nodes.js `wakeForFocusFixup`): the loop kept
// stepping until a frame has run, whatever else a step leaves pending.
let frameOwed = false;
export function oweFrame() {
  frameOwed = true;
  wakeLoop();
}

// The timers, and the tasks the platform queues on their list, are the engine's (timers.rs): what each runs, when it
// falls due and the period it repeats at, in the order they run — and the virtual clock they fall due on (`clockNow`),
// the event loop's, which its steps move (`moveClock`): the agent's, one for every window realm of it. (None before the
// engine is: a snapshot's build.)
const virtualNow = () => (globalThis.__dom ? globalThis.__dom.clockNow() : 0);

// The realm of a timer's callback — a string handler's, evaluated here, this one's.
function callbackRealm(handler) {
  if (!isCallable(handler)) return globalThis.__csimRealmId();
  try { return globalThis.RustyRacer.contextOf(handler); } catch (_) { return globalThis.__csimRealmId(); }
}

// Event-loop state. The requestAnimationFrame callbacks are the engine's (timers.rs `frames`), run in the render phase
// of `__runLoopStep`. The active-flag (`__setTimersActive`) is a host fn, so it's only toggled on the idle⇄active
// transition of the whole pending set — `pendingEmpty` keeps that host call off the per-schedule path.
// Pending IntersectionObserver observations are runnable work exactly like a
// queued rAF: they run in the render phase of the next step, so they must keep
// the pending-set non-empty or the driver would stop stepping before delivery.
// …and so is an animation the style engine runs that needs frames: one waiting on one to start (its `ready`), or
// running to an end its events and its finished state fall at. Time passes for it as it would in a browser, though
// nothing else on the page waits: a transition a script started on an idle page never started, and its `ready`,
// `transitionend` and `finished` never came. (One with no end — a spinner — does not keep the page busy alone: frames
// for it would be rendered for as long as the page is open.)
// …and an autofocus candidate the next rendering update flushes (autofocus.js), on the realm's top-level document — the
// engine's to say, of this realm or, with `subtree`, of its frames too (timers.rs `realmPending`).
function pendingEmpty() {
  return !globalThis.__dom.realmPending(null, false);
}
function engineAnimationsDue() {
  return globalThis.__csimStylo === true && globalThis.__dom != null && globalThis.__dom.animNextFrameDelay() >= 0;
}
// What starts such an animation — a style flush, a Web Animations call — wakes the loop if it is idle: `wakeLoop` for
// the modules that cannot import this one (the style engine's bindings, which the animation modules this imports
// import in turn). So does a flush that left CSS images owed their fetch (rendered.rs `cssImagesWaiting`): a read's
// restyle of a page with nothing else to run, which the next rendering update fetches.
globalThis.__csimWakeForRendering = function () {
  if (!timersActiveNow() && (engineAnimationsDue() || globalThis.__dom?.cssImagesWaiting())) setTimersActive(true);
};
// A task the driver ran — a script, a user action — has ended, and what it changed in style is a style change a browser
// answers with a rendering update. An idle page has none coming, so the change is applied here, in this realm and its
// frames': which starts the transitions and animations it declares, and those keep the page stepping (above). A class
// change from `execute_script`, or in a frame a click on its parent restyled, started nothing until something else did.
// (A frame is applied whatever the flag says: an active window renders itself, not necessarily its frames before the
// next read. The window sets the flag when any of them is due now.)
globalThis.__csimSettleIdleStyle = function (asFrame) {
  if (globalThis.__csimStylo !== true) return;
  if ((asFrame || !timersActiveNow()) && typeof globalThis.__csimUpdateStyle === 'function') globalThis.__csimUpdateStyle();
  if (globalThis.__dom.childFrames[0] !== 0) {
    for (const id of globalThis.__dom.steppedRealms()) {
      try {
        const g = globalThis.RustyRacer.contextGlobal(id);
        if (g && typeof g.__csimSettleIdleStyle === 'function') g.__csimSettleIdleStyle(true);
      } catch (_) {}
    }
  }
  if (!asFrame && !timersActiveNow() && subtreePending()) setTimersActive(true);
};
// Any pending work in this realm's SUBTREE (self + child realms, recursively)?
function subtreePending() {
  return globalThis.__dom.realmPending(null, true);
}
// Clear the PROCESS-WIDE "timers active" flag (`Driver#wait?`) — but only when
// nothing in the WHOLE realm tree (from the main realm down: its frames, the windows it opened, theirs) is pending. A FRAME
// realm's step sees only its own queue, and the callback it just ran may have
// queued work in the PARENT realm — a cross-realm postMessage delivery task — so
// a child-side "my queue is empty → flag off" stops the driver before that task
// ever runs (navigation-redirect-to-http: the helper frame's statechange-time
// `parent.postMessage` was stranded exactly this way). Any realm may still clear
// when the whole tree is idle, so an idle page's flag drops as eagerly as before.
// The tree walk runs only when a step/clear finds this realm's own queue empty —
// never on the hot non-empty path. (A worker's flag host fn is a no-op; a window the page opened in this isolate is
// its opener's to step — `steppedRealms` — though it is its own top: a popup idle while its opener has a timer due cleared
// the flag the opener's timer needed.)
function maybeClearTimersActive() {
  if (frameOwed || !pendingEmpty()) return;   // own queue non-empty (or a frame owed) ⇒ tree pending ⇒ nothing to clear
  if (!globalThis.__dom.realmPending(0, true)) setTimersActive(false);
}
// One microtask checkpoint (HTML "perform a microtask checkpoint") — the native, in-isolate
// `RustyRacer.drainMicrotasks`, so it's ~sub-µs, not a cross-thread round-trip: it drains Promise
// continuations + the microtask-scheduled MutationObserver delivery (which itself rechecks
// IntersectionObservers) — then the steps HTML runs after the drain, "cleanup Indexed Database
// transactions" (`afterMicrotaskCheckpoint`). `__csim_yield` is it: the dispatch paths call it between
// listeners, each task of a loop step is followed by it and the step begins with it, and a script the
// host runs (`__csimEvalScript`) ends with it — the drain rusty performs after every host call does not
// run the steps.
// The steps are the agent's, as the checkpoint is — it drains every realm's microtasks — so every realm
// keeps them in one list, its main realm's: an iframe's IDBDatabase makes a transaction in a task of its
// parent, whose checkpoint is the one that ends it.
let checkpointSteps = null;
const agentSteps = () => (checkpointSteps ??= (agentGlobal().__csimCheckpointSteps ??= []));
export function afterMicrotaskCheckpoint(step) { agentSteps().push(step); }
function microcheck() {
  const NS = globalThis.RustyRacer;
  if (!NS) return;   // (…none while the snapshot is made)
  NS.drainMicrotasks();
  // (…and the custom element reactions' backup element queue, where its microtask was lost with the realm that queued it)
  const ce = globalThis.__dom?.ceStack;
  if (ce !== undefined && ce[2] !== 0) {
    globalThis.__csimRunBackupReactions();
    NS.drainMicrotasks();
  }
  const list = agentSteps();
  if (list.length === 0) return;
  for (const step of list.splice(0)) step();
}
globalThis.__csim_yield = microcheck;
// A host call that is a task of its own — an event the host delivers from off the event loop (a worker's message, a
// socket's frame), one per call — ending as a task does, with a checkpoint: the drain rusty performs after the call
// does not run the steps after it. Only an entry the host never reaches from inside running script: a checkpoint there
// would drain the script's microtasks before it finishes (the window's `load`, which a frame built under a parent's
// script fires, and `popstate`, which `history.back()` fires, are not ones). A service worker's streamed response
// frames are left plain too: wrapped, a page's cancel of the stream stopped reaching the worker
// (fetch-event-respond-with-readable-stream's cancel / abort subtests) — not yet understood. (A function declaration:
// an import cycle sees it before this module runs.)
export function hostTask(deliver) {
  return function (...args) {
    try { return deliver.apply(this, args); } finally { microcheck(); }
  };
}

// The clock `Date` and `performance.now()` read: the realm's high resolution time (agent_clock.rs) — its virtual clock,
// which its event loop's steps move (`moveClock`) and the host moves as real time passes between its polls, and beside
// it the real time the agent's scripts have run for, inside their turns, which no step moves (a script spinning until
// `Date.now()` has gone on by 50 ms sees it go on). Read LIVE, so a read inside a timer callback sees the instant it
// fired at, and `Date.now()` and `performance.now()` agree with what `setTimeout` saw: Backburner (Ember's runloop)
// stores its deadlines as `Date.now() + wait` and checks them on each `setTimeout`-driven tick, and a `Date` on the
// wall clock alone never caught up with a virtual one. Not the wall clock beside the virtual one, which counted the
// time between the host's polls twice: a page at rest ran its `Date` at twice its timers' pace.
// Never back: the engine's reads are monotonic, and this holds them so across a time origin taken again.
let lastHr = 0;
const agentHr = function () {
  const t = globalThis.__dom ? globalThis.__dom.hrNow() : 0;
  if (t > lastHr) lastHr = t;
  return lastHr;
};
// A worker's clock is its window's (Browser#run_worker): the window's time as it last caught up with it — its `Date`,
// virtual clock and scripts' time together — and the worker's own time since, its virtual moves and its scripts' (`agent`
// for the agent's high resolution time, agent_clock.rs), from its creation until it first catches up. Not its own scripts'
// time from before then on top: that the window's clock went on through as well, as the host stepped it — a worker
// spinning 20 ms of every 50 read its page's `Date` 1.2 s ahead after 6 s, and one whose start took 25 ms of real time
// read that far ahead for good. Never back: where the worker's own time since ran ahead of the window's (its scripts
// longer than the window's step), it holds there until the window's passes it. The window's own time, that is, its
// virtual clock's and its scripts': where the window's clock is held (`clockAtLeast`) the worker's is held with it,
// `windowHeld`, its own time beneath running on with the window's virtual clock as the window's does — a worker caught
// up with a held window's time ran on from there by every step of the window's virtual clock beneath it, its `Date`
// 30 ms ahead of the page's after a busy answer.
let caughtUpDate = null, caughtUpHr = 0, caughtUpVirtual = 0, lastWindowTime = 0, windowHeld = 0;
// (…whether this realm is a worker's, which its scope's install says — a module flag, as every read of the clock asks it:
// workers.js `__csim_installWorkerScope`)
let inWorker = false;
export const markWorkerRealm = () => { inWorker = true; };
// (…`workerOwn` the worker's time beneath the window's hold)
const workerOwn = function () {
  const raw = caughtUpDate === null ? epochNow() + agentHr() : caughtUpDate + (agentHr() - caughtUpHr);
  if (raw > lastWindowTime) lastWindowTime = raw;
  return lastWindowTime;
};
const workerTime = function () {
  const own = workerOwn();
  return own > windowHeld ? own : windowHeld;
};
// …caught up with the window's own time `date`, `ahead` the virtual time the worker's step is still to move it by, which
// `date` already stands for; and with where the window's clock is held, `held`.
// Both on the agent's `Date` scale — the time every message's wire carries (agent_clock.rs `agentShift`) — which the
// worker's own `Date` stands `anchorShift` behind: its maker's document's, as the worker began (`__csimSetClockEpoch`),
// whatever documents come after it. A next page's `Date` begins again at the wall clock; on the agent's scale, a
// service worker's tick count after a 20 s page landed at the next page's own time, not 18.8 s on — and a pop-up's
// worker, whose opener navigated, read its pop-up's messages at their own time, not that much ahead.
let anchorShift = 0;
function caughtUp(date, ahead, held) {
  if (held > 0 && held - anchorShift > windowHeld) windowHeld = held - anchorShift;
  if (!(date > 0)) return;
  workerOwn();
  caughtUpDate = date - anchorShift;
  caughtUpHr = agentHr() + ahead;
  caughtUpVirtual = virtualNow() + ahead;
}
// How long a worker has been on its own: the time it reads — its scripts' among it, and where its timers held it, not its
// window's hold — past the window's time it stands at, the time it caught up with and the virtual time since, none of
// its scripts' (`spentSince`). A length of time, on no window's `Date`: what a service worker's answer took, from when
// its request was due to be taken — its scripts' time on an earlier event among it — which lands on its client's
// clock from the client's own ask, whichever window's clock the worker runs on (sw-client.js).
export const windowTimeHere = () => (caughtUpDate === null ? epochNow() + virtualNow() : caughtUpDate + (virtualNow() - caughtUpVirtual));
export const spentSince = (base) => {
  const own = workerOwn();
  return (own > heldUntil ? own : heldUntil) - base;
};
// The realm's own time, in milliseconds since the epoch before any offset: its agent's (agent_clock.rs), a worker's on its
// window's clock (`workerTime`) — what a message's time is judged against (`atItsTime`), no lift of a message's in it.
export const ownNow = () => (inWorker ? workerTime() : epochNow() + agentHr());
// …and held where a message or a timer brought it on (`clockAtLeast`): the realm's high resolution time.
let heldUntil = 0;
export const hrNow = function () {
  const own = ownNow();
  return (own > heldUntil ? own : heldUntil) - epochNow();
};
// How far the time another agent's message brought the realm to stands ahead of its own (`clockAtLeast`; a worker's,
// where it brought its window's: `windowHeld`) — which a timer set now falls due that much later on the virtual clock
// (`scheduleTimer`), its timeout counted from the time its `Date` reads. Due on the virtual clock alone, it ran with its
// clock lifted to that time (`notEarly`), and so did every timer set from it: a page that took a service worker's 1 s
// answer read its `Date` 1 s ahead of its own time for good, and of its workers'. In whole milliseconds, the virtual
// clock's steps. Not a worker's own scripts' lead over its window, nor a window's message's lift of a worker: the
// script time of the driver's own work — a `fetch` event's construction, the turn a message was posted in — would move
// its timers by however fast the machine ran (a service worker's 100 ms timer fell due at 152 against 112); those run
// lifted.
function clockLead() {
  const own = inWorker ? workerOwn() : epochNow() + agentHr();
  const held = inWorker ? windowHeld : heldUntil;
  return held > own ? Math.floor(held - own) : 0;
}
// The time origin, in milliseconds since the epoch — the realm's, taken as its document booted or its worker began
// (`__csimSetClockEpoch`), else as it is first read (none before the engine is: a snapshot's build).
let clockEpoch = null;
const _origDateNow = Date.now;
const epochNow = () => clockEpoch ?? (globalThis.__dom ? (clockEpoch = globalThis.__dom.clockEpoch()) : _origDateNow());
// (…`shift`, a worker's: how far the agent's `Date` scale stood ahead of its maker's `Date` — `anchorShift`)
globalThis.__csimSetClockEpoch = function (ms, since = 0, shift = 0) {
  globalThis.__dom.clockEpochSet(ms, since);
  clockEpoch = null;
  lastHr = 0;
  caughtUpDate = null;
  lastWindowTime = 0;
  windowHeld = 0;
  heldUntil = 0;
  anchorShift = shift;
};
export const timeOriginNow = () => epochNow() + timeTravelOffsetMs;
// …and the time now on it, in milliseconds since the epoch, before the offset below: a worker's time origin as this realm
// makes it (workers.js).
export const clockNow = () => epochNow() + hrNow();
// How far the agent's `Date` scale stands ahead of this realm's `Date`: a window's document's (agent_clock.rs
// `agentShift`), a worker's maker's (`anchorShift`).
export const agentShift = () => (inWorker ? anchorShift : globalThis.__dom.agentShift());
globalThis.__csimAgentShift = agentShift;
// The time a message this realm posts carries, which it lands no earlier than (workers.js `encodeMessage`): its `Date`'s,
// before any offset — a worker's on its window's clock, as its `Date` is (`workerTime`) — on the agent's scale.
export const windowTimeNow = () => clockNow() + agentShift();
// …and on to `ms` at least, where it stands before it — the time a message from another agent was sent at, which it
// arrives no earlier than; the time a timer was set at and its timeout, which it runs no earlier than (`notEarly`) —
// HELD there, its virtual clock and its timers as they stand, until its own time passes it: the virtual clock's moves
// take up the lead, which is no lasting offset of its `Date` — the time a busy worker's answer brought was not then
// added to every later timer's reading.
export function clockAtLeast(ms) {
  if (ms > heldUntil) heldUntil = ms;
}
// Time-travel offset. Ruby specs that `freeze_time(...)` /
// `travel_to(...)` shift `Time.now` server-side; the in-process app's
// rendering, model factories, and trend computations all observe the
// frozen value. The JS-side runs in the same process but its time origin
// is the real wall clock's, so client-side date math (Discourse's
// `moment()` calls in admin-dashboard-tab.js → `last 30 days` window,
// freshly-typed `created_at`, etc.) diverges from what the server
// just sent and trend / range UIs render against the wrong period.
// Ruby pushes `Time.now - real_wall_clock_now` here on each VM
// rebuild, which `Date` (and the time origin `performance.timeOrigin` reads) adds.
let timeTravelOffsetMs = 0;
// (…the driver's own read of it — an event's timeStamp's, a File's lastModified — which no page's replacement of
// `Date.now` (a fake-timer library's) reaches: a time value, an integer, as ECMA-262's `Date.now()` is)
export const platformDateNow = function now() { return Math.floor(timeOriginNow() + hrNow()); };
// (…`Date.now` itself bound, as the constructor below is: a native function's source to `Function.prototype.toString`)
const dateNow = platformDateNow.bind(null);
Object.defineProperty(dateNow, 'name', { value: 'now' });
Date.now = dateNow;
globalThis.__csimSetTimeTravelOffsetMs = function (ms) {
  timeTravelOffsetMs = Number.isFinite(ms) ? ms : 0;
};
// The `Date` constructor of the same clock — the native one reads the wall clock, which this one does not follow. A Date
// as ECMA-262 has it, of the virtual clock: called as a function, the string of now; constructed with no argument, now —
// one value, the common case, made as the native constructor makes it, no array between — and its `name`, `length`,
// statics, prototype and `prototype.constructor` a native Date's. Bound, so `Function.prototype.toString` reads it as
// the native function it stands for, which feature detection asks (a Proxy of the native constructor reads so too, at
// two and a half times the cost of a `new Date(x)`).
const _OrigDate = globalThis.Date;
{
  // (…each arity the native constructor's own call, where nothing subclasses it: a `new Date(y, m, d)` — moment's — as
  // cheap as a native one, no array between)
  const make = function (a, b, c, d, e, f, g) {
    if (new.target === undefined) return new _OrigDate(platformDateNow()).toString();
    if (new.target !== make) return Reflect.construct(_OrigDate, arguments.length === 0 ? [platformDateNow()] : arguments, new.target);
    switch (arguments.length) {
      case 0: return new _OrigDate(platformDateNow());
      case 1: return new _OrigDate(a);
      case 2: return new _OrigDate(a, b);
      case 3: return new _OrigDate(a, b, c);
      case 4: return new _OrigDate(a, b, c, d);
      case 5: return new _OrigDate(a, b, c, d, e);
      case 6: return new _OrigDate(a, b, c, d, e, f);
      default: return new _OrigDate(a, b, c, d, e, f, g);
    }
  };
  make.prototype = _OrigDate.prototype;
  const Date = make.bind(null);
  Object.defineProperty(Date, 'name', { value: 'Date' });
  Object.defineProperty(Date, 'length', { value: 7 });
  Object.defineProperty(Date, 'prototype', { value: _OrigDate.prototype, writable: false });
  Object.defineProperty(_OrigDate.prototype, 'constructor', { value: Date, writable: true, configurable: true });
  for (const name of ['now', 'parse', 'UTC']) {
    Object.defineProperty(Date, name, { value: name === 'now' ? dateNow : _OrigDate[name], writable: true, configurable: true });
  }
  globalThis.Date = Date;
}

// HTML timer "timeout" is a WebIDL `long` (int32): ToInt32 the argument, then
// "if timeout is less than 0, set timeout to 0". So `setTimeout(f, 2**32)` wraps
// to 0 and fires promptly (matching browsers), and a negative delay becomes 0.
// `ms | 0` is exactly ToInt32 (NaN/undefined → 0, 2**32 → 0, 2**31 → -2**31).
function toTimerDelay(ms) {
  const n = ms | 0;
  return n < 0 ? 0 : n;
}

// A timer of `delay` ms of the virtual clock, repeating where `repeats` — nested in the timer task running and clamped
// by its nesting level, the engine's (timers.rs `timerAdd`: HTML timer initialization steps 5-7).
function scheduleTimer(handler, delay, args, repeats) {
  // `TimerHandler` is `(Function or DOMString)`: a non-callable handler is
  // coerced to a string NOW — so a `toString` side effect (the WebIDL "evil"
  // example) runs at call time — and eval'd at global scope when it fires. This
  // also means a non-function handler still returns a valid (non-zero) id.
  const h = isCallable(handler) ? handler : String(handler);
  const wasIdle = pendingEmpty();
  const id = globalThis.__dom.timerAdd(delay > 0 ? notEarly(h, delay, repeats) : h, args ?? null, delay, repeats, false, false, clockLead());
  if (wasIdle) setTimersActive(true);
  return id;
}

// A timer handler, run no earlier on its realm's clock than its timeout after it was set (HTML timer initialization): the
// timer falls due on the virtual clock, which the realm's clock may stand ahead of while it is held (`clockAtLeast`) —
// a worker's whose scripts ran longer than its window's step, a page a busy worker's answer brought on — a
// `setTimeout(…, 50)` set then due as the virtual clock reaches it, 50 ms behind. Its clock is on to it as it runs, its
// virtual clock and its due times as they stand. (…an interval's from each run's start)
// (…where another agent's time held it, due that much later on the virtual clock instead: `clockLead`. Where a worker's
// own scripts did, not: a service worker's `setTimeout(…, 2000)` set as its 1 s computation ended falls due 2 s later on
// the virtual clock and runs with its `Date` 3 s on — its answer, which carries that time, landing on the page 3 s on
// all the same: sw-client.js)
// (…the handler it stands for kept, whose realm the callback's is and whose exception is reported: `handlerOf`)
const notEarlyOf = new WeakMap();
function notEarly(handler, delay, repeats) {
  let at = clockNow() + delay;
  const run = function (...args) {
    clockAtLeast(at);
    if (repeats) at = clockNow() + delay;
    return typeof handler === 'string' ? (0, eval)(handler) : Reflect.apply(handler, this, args);
  };
  notEarlyOf.set(run, handler);
  return run;
}
const handlerOf = (h) => (typeof h === 'function' && notEarlyOf.get(h)) || h;

// WindowOrWorkerGlobalScope's timers (the Window's bindings, window.js, and a worker's scope): `handler` and `timeout`
// converted, `args` the rest. One list of timers, so clearTimeout clears an interval too (HTML: one map of active
// timers).
export function setTimeout(handler, timeout, args) { return scheduleTimer(handler, toTimerDelay(timeout), args, false); }
export function setInterval(handler, timeout, args) { return scheduleTimer(handler, toTimerDelay(timeout), args, true); }
// (…a page's id, positive: no page clears a task of the platform's)
export function clearTimer(id) {
  if (id > 0 && globalThis.__dom.timerClear(id)) maybeClearTimersActive();
}
// A task the PLATFORM queues — a timeout signal's, an observer's notification, a network delivery — on the same list as
// the page's timers, so it runs in their order, but under a key that is no page timer's id (a negative one): a page
// clearing every id it can count to (teardown code does) clears none of the platform's work, and none of the ids it is
// given skips a number. The key cancels it (`cancelTask`). (…`ahead`: ahead of those due with it, timers.rs `AHEAD`)
export function queueTask(handler, delay = 0, ahead = false) {
  // (…a task of a timeout — an XHR's `timeout`, an AbortSignal's — counted as a timer's is, and no earlier on its clock
  // than that either)
  return delay > 0 ? addTask(notEarly(handler, delay, false), delay, ahead, clockLead()) : addTask(handler, 0, ahead, 0);
}
// …and one `delay` ms on the virtual clock, whatever the realm's own reads: the crossing queue's turn, due with a timer —
// not on to `delay` past a clock held ahead as it runs (`notEarly`), which moved the realm's time on by the wait.
// (…`source` one the engine treats apart: TURN a crossing queue's turn — `runCrossings` — NETWORK a request's,
// `queueNetworkTask`; timers.rs `Source`)
const TURN = 1, NETWORK = 2;
function addTask(handler, delay, ahead, lead, source = 0) {
  const wasIdle = pendingEmpty();
  const key = globalThis.__dom.timerAdd(handler, null, delay, false, true, ahead, lead, source);
  if (wasIdle) setTimersActive(true);
  return key;
}
// (…a task's key, negative — of whichever realm queued it, which a task cancelled from another realm's code is: a toggle
// task a frame's prototype cancels)
export function cancelTask(key) {
  if (key < 0 && globalThis.__dom.timerClear(key)) maybeClearTimersActive();
}
// …and the driver's own tasks and microtasks, which a page's replaced `setTimeout` (a fake-timer library's) never
// reaches: hooks, as the modules that queue them are in import cycles with this one's.
globalThis.__csimSetTimeout = (handler, timeout) => queueTask(handler, toTimerDelay(timeout));
// …and a request's (xhr.js), on the networking task source: what a frame's own script removing the frame still lets run
// to the end of the step (timers.rs `keep_network_tasks`), where its other tasks go.
globalThis.__csimQueueNetworkTask = (handler, timeout) => {
  const delay = toTimerDelay(timeout);
  return delay > 0 ? addTask(notEarly(handler, delay, false), delay, false, clockLead(), NETWORK) : addTask(handler, 0, false, 0, NETWORK);
};
globalThis.__csimClearTimeout = cancelTask;

// `requestAnimationFrame` — real browsers fire callbacks in the rendering steps
// of the event loop, after the current task + its microtask checkpoint. The engine
// keeps them (timers.rs `frames`) and the render phase of `__runLoopStep` runs them
// (with a microtask checkpoint after each, per spec). Because Ruby drives one
// `__runLoopStep` per Capybara poll = one virtual frame, Turbo's
// `await new Promise(r => requestAnimationFrame(r))` still resolves within the
// step the click triggered (the feedback_raf_as_microtask invariant), now via an
// ordered render phase rather than the microtask hack. A pending rAF keeps the
// active flag set so polling continues until the render phase runs.
export function requestAnimationFrame(cb) {
  const wasIdle = pendingEmpty();
  const id = globalThis.__dom.frameAdd(cb);
  if (wasIdle) setTimersActive(true);
  return id;
}
export function cancelAnimationFrame(id) {
  globalThis.__dom.frameCancel(id);
}
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
// (…`cb` a VoidFunction its binding converted: a non-callable one a TypeError there, not a string handler)
export function queueMicrotask(cb) {
  // Two subtleties in the routing:
  //   - `() => cb()` (not `.then(cb)`): a VoidFunction takes no arguments, so
  //     the Promise's resolution value must not leak through as cb's first arg —
  //     queued by the intrinsics (`platformMicrotask`), whatever a page made of `Promise`.
  //   - try/reportError: per HTML "report the exception", a throwing microtask
  //     surfaces through `reportError` (a global `error` event), NOT an unhandled
  //     promise rejection. Letting the throw reject this Promise would mis-route
  //     it through the PromiseRejectionEvent channel and fire apps'
  //     `unhandledrejection` listeners (Sentry et al.) where a real browser
  //     fires an `error` event instead.
  platformMicrotask(() => {
    try { cb(); } catch (e) { globalThis.__csimReportCallbackError(cb, e); }
  });
}
globalThis.__csimQueueMicrotask = queueMicrotask;

globalThis.__virtualNow    = virtualNow;
// Whether the event loop has work to run now: an animation frame callback requested of any of its documents (it runs in
// the step's rendering update), or a task due — the Worker run-loop gates its drain on this (workers no-op
// __setTimersActive), and without the first a worker requestAnimationFrame with no co-pending timer would never fire.
globalThis.__hasReadyTimer = function () {
  if (globalThis.__dom.agentFramesOwed(false)) return true;
  const due = globalThis.__dom.agentNextDue();
  return due !== undefined && due <= virtualNow();
};

// The time, on the virtual clock, to the next work this realm's event loop has due — a requested animation frame 0, its
// earliest timer, a frame an animation the style engine runs is due — and its frames', whose tasks its steps run, or -1
// for none: the engine's (timers.rs `nextTimerDelay`). The Ruby horizon gate
// (tick_real_time) uses it to decide whether the next timer is close enough to fast-forward to, vs a far-future
// session / analytics timer to leave parked.
globalThis.__nextTimerDelay = () => globalThis.__dom.nextTimerDelay();

// The rendering update — run ONCE per rendering opportunity of the event loop's (`__runLoopStep`), after the tasks due
// before it. Mirrors the HTML "update the rendering" steps we can model, for every document of the event loop (`docs`, in
// tree order — each after its container's document, those of one document in the tree order of their containers: the
// engine's `agentRealms`), each step for all of them before the next: rAF callbacks (each followed by a microtask
// checkpoint, the spec ordering invariant) — the page's, then its frames', then theirs, where each frame had run its own
// a step behind its parent's — then an IntersectionObserver recheck, then any still-queued MutationObserver delivery,
// then a final checkpoint. (Per-task `microcheck()` already drains the microtask-scheduled MO delivery + its IO recheck
// mid-step; these are the once-per-frame backstop.)
// The document's "pending scroll event targets" (CSSOM-View): `scroll` first, then `scrollend`,
// each coalesced to one per scroller. Also kicked from a microtask when a scroll happens on a page
// with nothing else pending — see `scheduleScrollFlush` in dom-nodes.js.
function flushScrollEvents() {
  if (typeof globalThis.__csimFlushScroll    === 'function') globalThis.__csimFlushScroll();
  if (typeof globalThis.__csimFlushScrollEnd === 'function') globalThis.__csimFlushScrollEnd();
}

// (Defined from the start: the rendering update reads them every frame, and a global it never finds is a property miss.)
if (globalThis.__csimUpdateStyle === undefined) globalThis.__csimUpdateStyle = null;
if (globalThis.__csimResizeSteps === undefined) globalThis.__csimResizeSteps = null;
if (globalThis.__csimFlushAutofocus === undefined) globalThis.__csimFlushAutofocus = null;
if (globalThis.__csimFocusFixup === undefined) globalThis.__csimFocusFixup = null;
if (globalThis.__csimAnimationSignals === undefined) globalThis.__csimAnimationSignals = null;

// The instant a rendering update is owed at, ahead of the next task, which falls due later than it (within `limit`) —
// an animation frame callback queued, or an animation needing a frame now (pending, or with events queued to send), in
// any document of the event loop: a frame's interval after the last one ran (`lastRenderedAt`), now at the earliest —
// or null for none.
const FRAME_INTERVAL = 1000 / 60;
let lastRenderedAt = -Infinity;
function renderingOwedBefore(limit) {
  const due = globalThis.__dom.agentNextDue();
  const now = virtualNow();
  const at = Math.max(now, lastRenderedAt + FRAME_INTERVAL);
  if (due === undefined || due <= at || due > limit) return null;
  return globalThis.__dom.agentFramesOwed(globalThis.__csimStylo === true) ? at : null;
}

// This realm's document's part of each step of the rendering update, in order (`runRenderPhase`).
const renderSteps = [
  // "Flush autofocus candidates" of a top-level document comes before the resize steps.
  function () { if (typeof globalThis.__csimFlushAutofocus === 'function') globalThis.__csimFlushAutofocus(); },
  // "Run the resize steps" comes first of the rest: a window that changed size fires `resize`, and a frame whose
  // container changed size gets its new viewport.
  function () { if (typeof globalThis.__csimResizeSteps === 'function') globalThis.__csimResizeSteps(); },
  // "Run the scroll steps" comes next in the HTML rendering update — before this frame's animation callbacks and before
  // the intersection observations (Chrome, measured on a page that scrolls with an rAF pending: `scroll`, `scrollend`,
  // then the rAFs, then the IO callback). Running them after rAF instead handed a sticky header or a virtual scroller the
  // frame's animation callback before the scroll event that frame was about.
  flushScrollEvents,
  // An animated element's box follows its animation: the clock has moved since the last update, so whatever reported an
  // interpolated value then needs its layout again now.
  flushAnimationFrame,
  // (…the callbacks requested so far, taken as the frame begins — one these request runs in the next — each as its turn
  // comes, one an earlier cancelled passed by — each passed the frame's time on the document's timeline, its time origin's
  // as `performance.now()`'s is: HTML "run the animation frame callbacks" with the update's `now`, a frame's made 2 s
  // into the page's read 2,000 ms ahead of its own clock on the event loop's)
  function () {
    if (globalThis.__dom.frameBegin() === 0) return;
    const now = animationNow();
    try {
      for (let cb; (cb = globalThis.__dom.frameNext()) !== undefined;) {
        try { cb(now); } catch (e) { logThrew('requestAnimationFrame cb', e); }
        microcheck();
      }
    } finally {
      globalThis.__dom.frameEnd();
    }
  },
  function () {
    // The rendering update's style update, after the animation frame callbacks (HTML "update the rendering"): what they
    // changed starts its transitions and animations in this frame, and their events are the next frame's to send.
    if (typeof globalThis.__csimUpdateStyle === 'function') globalThis.__csimUpdateStyle();
    // …and the animations made since this update moved the timeline — by its animation frame callbacks, or the style it
    // updated — started with it: their pending tasks run at its time, as a browser commits them with the frame it renders
    // (WPT web-animations start-time-compat: an animation started in an animation frame callback starts at that frame's
    // timeline time, which Chrome, Firefox and Safari agree on — webkit.org/b/290993). Their start times alone: the
    // events they owe are the next update's "update animations and send events" to generate and sort with the rest (Web
    // Animations §4.2), not this one's (animations.rs `commit_pending`).
    if (globalThis.__csimStylo === true && globalThis.__dom.animNextFrameDelay() === 0) {
      globalThis.__dom.styleCommitPending();
      if (typeof globalThis.__csimAnimationSignals === 'function') globalThis.__csimAnimationSignals();
    }
    // …and the CSS-embedded image resources the content it styled needs (background / cursor / list-style / content
    // url()s), which a browser fetches at the rendering update: the ones the restyles since the last left owed (none on a
    // settled page).
    if (typeof globalThis.__csimFlushCssResources === 'function') globalThis.__csimFlushCssResources();
  },
  // …the resize observations' loop on the layout it gives, then the intersection observations, on the layout THEIR
  // callbacks left.
  updateResizeObservations,
  // …the focus fixup: a focused element no longer focusable — hidden, display:none, inert — loses focus (dom-nodes.js),
  // before the intersection observations, which see the layout its listeners leave.
  function () {
    frameOwed = false;
    if (typeof globalThis.__csimFocusFixup === 'function') globalThis.__csimFocusFixup();
  },
  updateIntersectionObservations,
  // …and again for anything the rAFs and the observations scrolled, so it does not wait a frame.
  flushScrollEvents,
  function () { if (hasObservers() && hasQueuedRecords()) deliverMutations(); }
];
// (…each step of it run here for this realm's document by the event loop's rendering update, run in its main realm — and,
// as the update ends, a task boundary: the legacy `window.event` an event-loop-driven dispatch may have left set for its
// continuations cleared (see runTask / maybeFireFrameLoad), so it doesn't leak past the frame into a later task or a
// Ruby-side evaluate_script)
globalThis.__csimRenderStep = (step) => renderSteps[step]();
globalThis.__csimRenderEnd = () => { globalThis.__csimCurrentEvent = undefined; };

function runRenderPhase() {
  lastRenderedAt = virtualNow();
  // Microtask checkpoint precedes the rendering steps: a pending microtask may
  // be what SCHEDULES an rAF (Turbo's `await new Promise(r => rAF(r))` — the
  // Promise.then runs here and queues the rAF), so drain microtasks before the
  // rAF queue, not after.
  microcheck();
  if (globalThis.__dom.childFrames[0] === 0) {
    for (const step of renderSteps) step();
    microcheck();
    globalThis.__csimCurrentEvent = undefined;
    return;
  }
  const docs = eventLoopGlobals(globalThis.__dom.agentRealms());
  for (let step = 0; step < renderSteps.length; step++) {
    for (const g of docs) {
      try { g.__csimRenderStep(step); } catch (e) { logThrew('rendering update', e); }
    }
  }
  microcheck();
  for (const g of docs) {
    try { g.__csimRenderEnd(); } catch (_) {}
  }
}
// The globals of realms `ids`, those still there — this one's its own.
function eventLoopGlobals(ids) {
  const found = [];
  for (const id of ids) {
    const g = id === 0 ? globalThis : realmGlobal(id);
    if (g) found.push(g);
  }
  return found;
}
function realmGlobal(id) {
  try {
    const g = globalThis.RustyRacer.contextGlobal(id);
    return g && typeof g.__csimRunTask === 'function' ? g : null;
  } catch (_) {
    return null;
  }
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
// (…the agent's, told to the host where its workers follow it: `followWindowClock` — from whichever of its realms moves it)
const moveClock = function (to) {
  globalThis.__dom.clockTo(to);
  const holder = flagHolder();
  if (holder.__csimClockFollowed === true) holder.__csim_windowClockAt(to);
};
// …and moved on to `to` with no task run, where it stands before it: the virtual time a worker's answer took while the
// window waited on it in place (Browser#await_worker_reply), which passed for the window too.
globalThis.__csimClockAtLeast = (to) => { if (to > virtualNow()) moveClock(to); };
// …and on by `ms`, its own scale whatever another clock's is — a script's that waited that long inside a sync XHR, for
// a worker's answer or a server's modeled delay — which `Date` and `performance.now()` show as they advance by `ms`, the
// real time the wait took none of their script time (`hostWait`).
globalThis.__csimClockMovedBy = (ms) => { if (ms > 0) moveClock(virtualNow() + ms); };
// …and a worker's catching up `ms` with its window's clock, which its next step moves it by — moved now where it has
// nothing to run (`idle`) — to the window's time `date` (its `Date`, before any offset: `__runLoopStep`'s `date`) where the
// host has it: the time its own clock reads from there (`hrNow`). Caught up before the move, which `date` stands for:
// moved first, the move ran on from the last catch-up's time, and a worker whose scripts had run past its window's held
// there a step further on for good — every answer of a service worker's after its 1 s one 100 ms late.
globalThis.__csimCaughtUp = (ms, idle, date, held = 0) => {
  caughtUp(date, ms, held);
  if (idle && ms > 0) moveClock(virtualNow() + ms);
};
// What another agent sent this realm — a message on any channel, a service worker's answer — run at the time it was sent
// at, `at` (its sender's clock as it sent it, before any offset), among this realm's own work, in ONE queue of the
// realm's, by `at`: each runs once no task of its event loop falls due on its virtual clock before it — any realm's of
// the agent: the message's task is queued on the receiver's event loop (HTML "queue a global task" on the posted message
// task source of the target's global), which runs the tasks of the page and its frames in the order they fall due, a
// frame's 40 ms timer before the page's message from a worker sent at 45 — judged against
// the realm's own time (`ownNow`), no lift an earlier message put on its clock — those running first, at their own
// times, the queue waiting behind them one timer's due at a time; then at once, its clock held at `at` (`clockAtLeast`)
// until its virtual clock passes it. A worker's 1 s computation answered the page ahead of the page's `setTimeout(…,
// 300)` and `(…, 600)`, its `Date` lifted by it for good; and with two senders waiting, each saw the other's turn in the
// queue as a timer of the page's, or the clock the other had lifted, and ran ahead of the page's timers. The virtual
// clock moves only to the realm's own due times, the same every run: what the senders' scripts took, real time, moves
// no task of the realm's. Per `key` (a worker's, a port's, a channel's, a request's) in the order they came: one is run
// no earlier than one of its key before it.
// (…the queue an array read from `head`, in order of `when` then arrival: one is put at its tail — they come in order,
// mostly — else where a binary search puts it; and taken from its head, the array let go of as it empties. Each key's
// last time and how many of it wait, which a key's next one is run no earlier than. A storm of 40,000 messages sorted
// the whole queue at each arrival and scanned it at each run: 8.9 s.)
let crossings = [], head = 0;
const keyLast = new Map(), keyWaiting = new Map();
let crossingSeq = 0, crossingTurn = false;
const before = (a, b) => a.when < b.when || (a.when === b.when && a.seq < b.seq);
export function atItsTime(key, at, run) {
  if (at > 0) at -= agentShift();
  const last = keyWaiting.get(key) ? keyLast.get(key) : 0;
  const entry = { when: at > last ? at : last, seq: crossingSeq++, key, run };
  keyLast.set(key, entry.when);
  keyWaiting.set(key, (keyWaiting.get(key) ?? 0) + 1);
  const n = crossings.length;
  if (n === head || !before(entry, crossings[n - 1])) {
    crossings.push(entry);
  } else {
    let lo = head, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(entry, crossings[mid])) hi = mid; else lo = mid + 1;
    }
    crossings.splice(lo, 0, entry);
  }
  if (!crossingTurn) runCrossings();
}
function runCrossings() {
  while (head < crossings.length) {
    const first = crossings[head];
    const ahead = first.when > 0 ? first.when - ownNow() : 0;
    if (ahead > 0) {
      const next = globalThis.__dom.agentNextDue(false);
      const now = virtualNow();
      if (next !== undefined && next <= now + ahead) {
        // (…one turn of the queue's, due with the event loop's next task, after those due with it — the agent's own
        // tasks the only ones it waits for: none of this queue's turns is on the list as it looks, and another realm's
        // queue's, itself waiting, is none of them — `agentNextDue`)
        crossingTurn = true;
        addTask(() => {
          crossingTurn = false;
          runCrossings();
        }, next - now, false, 0, TURN);
        return;
      }
    }
    crossings[head++] = undefined;
    if (head === crossings.length) {
      crossings = [];
      head = 0;
    }
    const waiting = keyWaiting.get(first.key) - 1;
    if (waiting > 0) {
      keyWaiting.set(first.key, waiting);
    } else {
      keyWaiting.delete(first.key);
      keyLast.delete(first.key);
    }
    if (first.when > 0) clockAtLeast(first.when);
    first.run();
  }
}
// A host call a script waits inside — a synchronous request's, a server's or a worker's to answer — whose real time is the
// script's only as far as the virtual clock does not show it (agent_clock.rs `agentWait`): a server's sleep the host moved
// the clock by, a worker's answer, counted on both ran a parser-blocking script's clock at twice its fetch's time.
// (…`whole`, none of it at all: a wait on another agent, whose answer brings the model time it took — sw-client.js)
export function hostWait(call, whole = false) {
  const began = virtualNow();
  globalThis.__dom.agentWait(true);
  try {
    return call();
  } finally {
    globalThis.__dom.agentWait(false, whole ? Number.MAX_VALUE : virtualNow() - began);
  }
}
// One step of the event loop, which the engine is told of: a step goes on with what is due in it in a realm whose context
// a task of its own disposed during it (a frame's script removing its own iframe), the engine's list going as it ends
// (timers.rs `agentStep`) — the globals of the realms whose tasks it ran kept for it, as their contexts may be gone by
// the time their next task comes up (`stepGlobals`).
let stepGlobals = null;
const runLoopStepLocal = function (maxMs, maxIter, yieldOnGen, mark = null) {
  globalThis.__dom.agentStep(true);
  const outer = stepGlobals;
  stepGlobals = null;
  try {
    return runLoopStepBody(maxMs, maxIter, yieldOnGen, mark);
  } finally {
    stepGlobals = outer;
    globalThis.__dom.agentStep(false);
  }
};
// A worker that closed itself (`self.close()`) runs no task after the one that closed it: they are discarded (HTML
// "close a worker" — its closing flag set, the event loop's queued tasks dropped).
let closed = false;
export const closeEventLoop = () => { closed = true; };
// What the engine's shared registries owe this realm for another realm's or a worker's call (engine-notices.js
// `deliver`), taken as each step begins — none until the realm first uses one.
let agentPoll = null;
export const setAgentPoll = (poll) => { agentPoll = poll; };
// requestIdleCallback §5.3-5.5: as a step has nothing due — its rendering update run — an idle period, its runnable
// callbacks run, each a task of its own, until its deadline (the engine's: timers.rs `idleBegin` / `idleNext`); idle.js
// invokes each with its IdleDeadline. One period a step: a callback requested by one waits for the next.
let idleInvoke = null;
export const setIdleInvoke = (invoke) => { idleInvoke = invoke; };
// …a callback requested — waking the loop as an animation frame's does, where nothing else was pending — or cancelled.
export function idleRequest(callback, timeout, timedOut) {
  const wasIdle = pendingEmpty();
  const handle = globalThis.__dom.idleAdd(callback, timeout, timedOut);
  if (wasIdle) setTimersActive(true);
  return handle;
}
export function idleCancel(handle) {
  globalThis.__dom.idleTake(handle);
  maybeClearTimersActive();
}
function runIdlePeriod() {
  if (idleInvoke === null || !globalThis.__dom.idleBegin()) return;
  for (let next; (next = globalThis.__dom.idleNext()) !== undefined;) {
    idleInvoke(next[1], false);
    microcheck();
    globalThis.__csimCurrentEvent = undefined;
  }
}
// This realm's part of each step of the event loop's, run by it in its main realm: as it begins, what the engine's shared
// registries owe it (`agentPoll`); as it has nothing due, its idle period (requestIdleCallback §5.3: "start an idle
// period" is the event loop's, for each Window of it); as it ends, the last object a brand check read let go of, as
// nothing of the step needs it now.
globalThis.__csimStepBegin = () => { if (agentPoll !== null && !closed) agentPoll(); };
globalThis.__csimIdlePeriod = runIdlePeriod;
globalThis.__csimStepEnd = forgetLastRecord;
// …each run for every realm of the event loop's, in tree order (`agentRealms`) — this one's alone, a page with no frame.
function eachRealm(hook) {
  if (globalThis.__dom.childFrames[0] === 0) return globalThis[hook]();
  for (const g of eventLoopGlobals(globalThis.__dom.agentRealms())) {
    try { g[hook](); } catch (e) { logThrew(hook, e); }
  }
}
// The settle generation of the event loop's documents, whatever realm a task of it changed one of from: a frame's
// listener reaching into its parent, a parent's task into a frame (timers.rs `agentSettleGen`) — this realm's alone, a
// page with no frame.
const agentSettleGen = () => (globalThis.__dom.childFrames[0] === 0 ? currentSettleGen() : globalThis.__dom.agentSettleGen());

// One task of this realm's — its next, due by `limit`, the one the event loop's step picked (`agentNext`) — run, the
// clock moved to when it falls due, and its microtask checkpoint after it. Whether there was one.
const runTask = function (limit) {
  // The next timer due within the budget — the lowest due, and of those due at once the first scheduled — taken (one
  // that repeats, due again a period after it runs): `[due, handler, args, page]`.
  const next = globalThis.__dom.timerNext(limit);
  if (next === undefined) return false;
  const [nextDue, handler, args, page] = next;
  if (nextDue > virtualNow()) moveClock(nextDue);

  try {
    // (…a page's callback on the stack while it runs, whatever it is — a bound built-in's too: webidl.js
    // `scriptOnStack` — a platform task's none, the driver's own code)
    const running = page ? runningCallbacks() : null;
    if (running !== null) running.count++;
    // (…and its realm — the callback's, a string's this one's — the entry realm while it runs, on a page of several:
    // HTML "invoke a callback" prepares to run script in it — navigables.rs `entryRealm`)
    const entry = running !== null && globalThis.__dom.childFrames[0] !== 0
      ? globalThis.__dom.enterRealm(callbackRealm(handlerOf(handler)))
      : null;
    try {
      if (isCallable(handler)) Reflect.apply(handler, null, args || []);
      else (0, eval)(handler);   // string TimerHandler: eval at global scope
    } finally {
      if (running !== null) running.count--;
      if (entry !== null) globalThis.__dom.exitRealm(entry);
    }
  } catch (e) {
    // Per HTML "run the active timers", a throwing timer callback surfaces via
    // "report the exception" — a global `error` event (→ window.onerror), same
    // as queueMicrotask above — NOT a silently-swallowed log. The report fires
    // on the CALLBACK's realm (`frames[0].setTimeout(frames[1]-fn)` reports on
    // frame1), so route through `__csimReportCallbackError`. A string handler
    // (eval'd in this realm) has no callback realm → reported locally.
    try { globalThis.__csimReportCallbackError(isCallable(handlerOf(handler)) ? handlerOf(handler) : null, e); } catch (_) {}
  }
  // (…the timer task over: its microtasks, each the running task of its own, nest in no timer — HTML "perform a
  // microtask checkpoint")
  globalThis.__dom.timerTaskEnd();
  microcheck();   // per-task microtask checkpoint (Promise continuations, MO delivery)
  // Per-task boundary: clear any `window.event` this task's event-loop-driven
  // dispatch left set for its (now-drained) continuations, so the NEXT task in
  // this step doesn't observe a stale current event (browsers clear per task).
  globalThis.__csimCurrentEvent = undefined;
  return true;
};
globalThis.__csimRunTask = runTask;
// …and one of realm `realm`'s, of the event loop's — in that realm, whose module's state its run is (its clock's hold,
// its current event): this one's own, or another's through its global, the one the step began with where its context is
// disposed since.
// (…its global kept from its first task in the step on)
function runTaskIn(realm, limit) {
  if (realm === 0) return runTask(limit);
  // (…the clock moved to its time here, in the main realm, where the move is told to the host at no cost of finding it)
  const due = globalThis.__dom.agentNextDue();
  if (due > virtualNow()) moveClock(due);
  let g = stepGlobals !== null ? stepGlobals.get(realm) : undefined;
  if (g === undefined) {
    g = realmGlobal(realm);
    if (!g) return false;
    (stepGlobals ??= new Map([[0, globalThis]])).set(realm, g);
  }
  try {
    return g.__csimRunTask(limit);
  } catch (e) {
    logThrew('task', e);
    return true;
  }
}

const runLoopStepBody = function (maxMs, maxIter, yieldOnGen, mark = null) {
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
  const startNow = virtualNow();
  const limit    = startNow + maxMs;
  const startGen = currentSettleGen();
  const startAgentGen = agentSettleGen();
  let iter = 0, fired = 0;
  const result = (extra) => {
    const g = currentSettleGen();
    const r = { fired, gen: g, dirtied: g !== startGen || agentSettleGen() !== startAgentGen, raf: globalThis.__dom.agentFramesOwed(false) };
    if (extra) r.yielded = true;
    return r;
  };
  // (…a worker asked before the step began — by a script the host ran, a user action — the host's to have run already,
  // `worker_due_at`'s `:asked`: only this step's asking ends it, its first checkpoint's among it)
  if (mark === null && flagHolder() === globalThis) globalThis.__csimWorkerAsked = false;
  microcheck();   // (…what ran since the last checkpoint — a script the host ran — cleaned up after first)
  eachRealm('__csimStepBegin');

  while (!closed) {
    // (…a rendering update below counted against the step's cap, as a task is — and a step run for the tasks queued by a
    // mark over, as one at its cap is, once its next task is none of them: `__csimRunQueued`)
    if (iter++ >= maxIter || (mark !== null && !globalThis.__dom.timerNextQueuedBy(mark))) return result();
    // HTML's event loop: a task, its microtask checkpoint, then a rendering opportunity — one this step takes before it
    // moves the clock on to a later task where a rendering update is owed (`renderingOwedBefore`), a frame's interval
    // after the last: what a task — or a rendering update's own callbacks — queued for the next frame, an animation
    // frame callback, the events of an animation it cancelled, is never put off behind a timer due later than that
    // frame.
    const owedFrame = renderingOwedBefore(limit);
    if (owedFrame !== null) {
      if (owedFrame > virtualNow()) moveClock(owedFrame);
      runRenderPhase();
      continue;
    }
    // The task due first within the budget of every realm of the event loop's — HTML's event loop takes "the first
    // runnable task" of a task queue it chooses, and the task queues are the agent's, its frames' tasks among the page's:
    // the lowest due, and of those due at once the first queued, whichever realm queued it (timers.rs `agentNext`) — run
    // in its realm, or none → render phase. A frame's tasks ran in a batch after the page's whole step, up to a step
    // late, out of their order with the page's and with each other's.
    // (…a page of no frame, nor window, nor one whose task the step ran, its own: `runTask` takes none where none is due)
    const realm = globalThis.__dom.childFrames[0] === 0 && stepGlobals === null ? 0 : globalThis.__dom.agentNext(limit);
    if (realm < 0 || !runTaskIn(realm, limit)) {
      // (…none due within the budget: the step's rendering update, its last work — at most one a frame's interval,
      // across steps: none where the budget ends before a frame's interval after the last one (a step that yielded, one
      // of no budget, one its clock was pinned short of the next frame below) — a rAF loop queuing a 1 ms timer every
      // frame ran its frames 1 ms apart and starved every later timer. What it queued is the next step's to run — a
      // lazy frame its intersection observations started fetching answered after the read that follows, as a
      // network's answer would be — the clock pinned no later than the first of it: below.)
      const frameAt = Math.max(virtualNow(), lastRenderedAt + FRAME_INTERVAL);
      if (frameAt > limit) break;
      if (frameAt > virtualNow()) moveClock(frameAt);
      runRenderPhase();
      break;
    }
    fired++;
    // (…the step over at a task that asked a worker something, as the host runs that worker to now — no rendering update
    // of its own, which comes at its frame's time in the step that goes on. Not a run of a mark's tasks, which goes on to
    // their end.)
    if (mark === null && flagHolder() === globalThis && globalThis.__csimWorkerAsked === true) {
      maybeClearTimersActive();
      return result(true);
    }
    if (yieldOnGen && agentSettleGen() !== startAgentGen) {
      // Run this frame's render phase BEFORE yielding — an rAF scheduled this
      // step is part of the current frame and must not be deferred past the
      // gen-bail (else `setTimeout(()=>'B',50); rAF(()=>'R')` would yield after a
      // sibling timer fires, putting 'B' before 'R' vs the real-browser 'R' first). (…none where one ran at this
      // instant already: `lastRenderedAt`)
      if (lastRenderedAt !== virtualNow()) runRenderPhase();
      maybeClearTimersActive();   // last work drained by this task → clear flag (don't strand polling)
      return result();
    }
  }

  // …and one more frame at the moment an animation the style engine runs needs one, where that falls within the step:
  // the frame at which a transition reaches its end is the one that sends its `transitionend` and settles its
  // `finished`, and a step that rendered only at its start and then moved the clock past the end never rendered it.
  // Not on a page that is drawing frames of its own (a queued animation frame callback): its next frame comes anyway,
  // and one between its frames would run its callbacks off their cadence.
  if (globalThis.__csimStylo === true && globalThis.__dom != null && !globalThis.__dom.agentFramesOwed(false)) {
    const now = virtualNow(), due = globalThis.__dom.agentAnimDelay();
    if (due > 0 && now + due <= limit) {
      moveClock(now + due);
      runRenderPhase();
    }
  }
  eachRealm('__csimIdlePeriod');
  // Pin the clock at `limit` even if idle, so a follow-up step reflects
  // cumulative elapsed virtual time — told to the host like any move.
  // (…but no later than a task the step's last rendering update queued within it — an animation frame callback's
  // `setTimeout(…, 50)` — which the next step then runs at its time, not late; nor than the frame owed before it — the
  // events of an animation that callback cancelled — which the next step renders first: `renderingOwedBefore`)
  const queuedDue = globalThis.__dom.agentNextDue();
  let pinTo = limit;
  if (queuedDue !== undefined && queuedDue > virtualNow() && queuedDue < limit) {
    pinTo = queuedDue;
    if (globalThis.__dom.agentFramesOwed(globalThis.__csimStylo === true)) pinTo = Math.max(virtualNow(), Math.min(pinTo, lastRenderedAt + FRAME_INTERVAL));
  }
  if (virtualNow() < pinTo) moveClock(pinTo);
  maybeClearTimersActive();
  return result();
};

// …and the tasks queued on the event loop by `mark` (timers.rs `task_mark`), run now — those a reload's history step
// waits on (browser.rb `run_queued_before_reload`) — as a step runs them: after the agents' notices (`runLoopStepLocal`),
// with no clock advance, as many at most as are left of them (`timersQueuedBy`), and only while the next task is one of
// them (`timerNextQueuedBy`): a task queued since that takes its turn ahead of them — a port's message one of them posted
// is none, being in turn — ends the run, the reload then waiting for the event loop's own steps. (…the agent's, run in
// its main realm, whichever realm's document reloads)
globalThis.__csimRunQueued = function (mark) {
  const agent = flagHolder();
  if (agent !== globalThis) return agent.__csimRunQueued(mark);
  return runLoopStepLocal(0, globalThis.__dom.timersQueuedBy(mark), false, mark);
};
// A step of the event loop — the agent's, run in its main realm whichever realm's script asks for one (a frame's
// `__drainTimers`). Its `maxIter` is the agent's budget: the tasks of every realm of it count against it, a frame's
// among the page's, where each realm's step had a budget of its own.
globalThis.__runLoopStep = function (maxMs, maxIter, yieldOnGen) {
  const agent = flagHolder();
  if (agent !== globalThis) return agent.__runLoopStep(maxMs, maxIter, yieldOnGen);
  const r = runLoopStepLocal(maxMs, maxIter, yieldOnGen);
  // (…and the clock it left: the time a worker's own clock catches up to — Browser#run_worker — and whether a task of it
  // asked a worker something, which the host runs to that time first: `askedWorker`)
  // (…its `Date`'s own time, and where it is held, apart: what the time a worker reads runs on from, and what it is held
  // at with it — `workerTime`; read without opening a script turn: agent_clock.rs `hrPeek`)
  r.now = virtualNow();
  // (…on the agent's `Date` scale, as a message's time is: `agentShift`)
  const own = epochNow() + Math.max(lastHr, globalThis.__dom.hrPeek()), shift = agentShift();
  r.date = own + shift;
  r.held = heldUntil > own ? heldUntil + shift : 0;
  r.asked = takeAsked();
  eachRealm('__csimStepEnd');
  // (…and the agent's script turn over with the step: agent_clock.rs `agentIdle`)
  globalThis.__dom.agentIdle();
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
globalThis.__csimHasPendingRAF = function () { return globalThis.__dom.frameCount() > 0; };

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
// multi-window test (the cross-partition.https flakiness). A child's raf and async are its own
// `__csimEventLoopActivity`'s, which recurses, so grandchildren are covered; the next timer is the subtree's already,
// the engine's walk (`__nextTimerDelay`).
globalThis.__csimEventLoopActivity = function () {
  let raf   = typeof __csimHasPendingRAF === 'function'   ? !!__csimHasPendingRAF()   : false;
  let async = typeof __csim_asyncIoPending === 'function' ? !!__csim_asyncIoPending() : false;
  if (typeof globalThis.__csimEachChildRealm === 'function') {
    globalThis.__csimEachChildRealm(g => {
      if (typeof g.__csimEventLoopActivity !== 'function') return undefined;
      const c = g.__csimEventLoopActivity();
      if (c.raf)   raf   = true;
      if (c.async) async = true;
      return undefined;   // visit every child (aggregate)
    });
  }
  return { raf, async };
};
globalThis.__csimEventLoopProbe = () => ({ ...globalThis.__csimEventLoopActivity(), nextTimer: __nextTimerDelay() });
