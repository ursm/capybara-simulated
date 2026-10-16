import { logThrew }                    from './console.js';
import { observeIntersections, layoutGeneration, observedVisibility, resizeObservations } from './layout.js';
import { NODE_ELEMENT }                from './constants.js';
import { DOMRectReadOnly, readOnlyRectFrom } from './geometry.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import {
  convertIntersectionObserverArguments,
  convertIntersectionObserverEntryArguments,
  convertPerformanceObserverArguments,
  installIntersectionObserver,
  installIntersectionObserverEntry,
  convertResizeObserverArguments,
  installPerformanceObserver,
  installPerformanceObserverEntryList,
  installResizeObserver,
  installResizeObserverEntry,
  installResizeObserverSize
} from './generated/bindings.js';
// Cycle with timers.js (it imports our update/pending fns) — safe: both edges
// are function declarations called only at runtime, never at module init.
import { wakeLoop }                    from './timers.js';

// Observers: IntersectionObserver and ResizeObserver, which the rendering update runs against the layout engine, and
// PerformanceObserver, which performance entries drive.

// ── IntersectionObserver ─────────────────────────────────────────────────────────────────────
// A real one, computed against the layout engine: the target's rendered box versus the root's
// (the viewport, or an element's box), expanded by `rootMargin` and clipped by any ancestor
// scroll container. It reports LEAVING as well as entering — the whole point of the API and the
// half a "fires true once" stub can never do (Discourse's header swaps the auth buttons for the
// topic title when the title scrolls OUT of view).
//
// Delivery follows the spec's shape but our clock: the update runs at the rendering update
// (timers.js), after a mutation batch, a scroll and a viewport change — each of those is a moment
// the geometry can have changed — and queues an entry for a target whose threshold index,
// intersecting or visible state moved; a task then notifies every observer with entries queued.
//
// The IntersectionObservers observing anything — the engine's (intersection_observers.rs: their targets'
// registrations, which are due past an observer's delay, which moved), each named by the number `ioCreate` gave it —
// and here, by that number, the objects an update measures and queues entries for: held for as long as the engine
// holds them.
const ioObservers = new Map();

// "Parse a margin" (rootMargin / scrollMargin) — the engine's (intersection.rs `parse_margin`): its four sides as
// `[value, percent, …]`, or a SyntaxError; serialized back as each side's number and unit.
function parseRootMargin(text, name) {
  const margin = globalThis.__dom.parseMargin(text);
  if (margin === null) throw new SyntaxError(`Failed to construct 'IntersectionObserver': ${name} must be specified in pixels or percent.`);
  return margin;
}
function serializeRootMargin(margin) {
  const sides = [];
  for (let i = 0; i < 8; i += 2) sides.push(`${margin[i]}${margin[i + 1] ? '%' : 'px'}`);
  return sides.join(' ');
}

// IntersectionObserver delivery is FRAME-PACED, exactly as in a browser: every
// producer — `observe()`'s spec-mandated initial notification, a scroll, a DOM
// mutation — only RAISES the pending flag here, and the one site entries are
// queued at is the render phase's `updateIntersectionObservations` (once per
// `__runLoopStep`), whose task notifies them.
// The flag participates in the event loop's pending-work contract
// (`hasPendingObservations` folds into `pendingEmpty`, and raising it flips the
// driver's timers-active flag), so an otherwise idle page still gets a step and
// its entries — the reason the old model delivered on an eager microtask.
//
// The eager microtask was also a livelock: an app whose IO callback re-renders
// and re-observes its target (Discourse's composer-image-node) looped
// callback → mutate → observe → initial-callback unboundedly inside ONE
// microtask checkpoint, each round forcing a fresh layout pass — the ProseMirror
// composer spun thousands of passes inside a single `__runLoopStep`. With
// entries queued once per step, that app loop advances one round per frame, which
// is what a browser's cadence imposes on it.
let ioNeedsUpdate = false;
function requestIntersectionUpdate() {
  if (ioObservers.size === 0 || ioNeedsUpdate) return;
  ioNeedsUpdate = true;
  // The idle→active transition a newly scheduled timer makes: the driver's
  // settle/wait loops keep stepping while work is pending, and the render phase
  // of the next step is what delivers. ONE flag, raised only on the false→true
  // edge — a second "already woke the loop" latch drifted from this one and a
  // stuck latch silenced every later wake (review-caught: observe → disconnect →
  // clearTimeout left the page event-loop-dead).
  wakeLoop();
}

// Its slots: the callback, root, margins, thresholds (a frozen list, ascending), delay and trackVisibility, its number
// among the engine's (which keeps its targets' registrations), and the entries queued for the callback, which
// `takeRecords()` takes.
const ioOf = (o) => slotsOf(o, 'IntersectionObserver');
registerInterface('IntersectionObserver', (o) => ioOf(o) !== undefined);
export class IntersectionObserver {
  constructor(callback, options) {
    [callback, options] = convertIntersectionObserverArguments(arguments);
    // (…a margin a SyntaxError where it is not 1-4 pixel or percent lengths; a threshold a RangeError outside 0-1;
    // trackVisibility's delay at least 100 — the spec clamps it, where Chrome throws)
    const margins = parseRootMargin(options.rootMargin, 'rootMargin');
    const scrollMargins = parseRootMargin(options.scrollMargin, 'scrollMargin');
    const thresholds = typeof options.threshold === 'number' ? [options.threshold] : options.threshold;
    for (const t of thresholds) {
      if (!(t >= 0 && t <= 1)) throw new RangeError("Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1");
    }
    const sorted = thresholds.slice().sort((a, b) => a - b);
    makeSlots(this, 'IntersectionObserver', {
      callback, root: options.root, margins, scrollMargins,
      thresholds: Object.freeze(sorted.length ? sorted : [0]),
      delay: options.trackVisibility && options.delay < 100 ? 100 : options.delay,
      trackVisibility: options.trackVisibility,
      id: globalThis.__dom.ioCreate(), queue: []
    });
  }
}
installIntersectionObserver(IntersectionObserver, {
  get_root: (o) => ioOf(o).root,
  get_rootMargin: (o) => serializeRootMargin(ioOf(o).margins),
  get_scrollMargin: (o) => serializeRootMargin(ioOf(o).scrollMargins),
  get_thresholds: (o) => ioOf(o).thresholds,
  get_delay: (o) => ioOf(o).delay,
  get_trackVisibility: (o) => ioOf(o).trackVisibility,
  observe(o, target) {
    const s = ioOf(o);
    if (!globalThis.__dom.ioObserve(s.id, s.delay, target._nid, target)) return;
    ioObservers.set(s.id, o);
    // (…the initial notification at the NEXT rendering update, never inside observe(): the pending flag raised is what
    // makes that update run)
    requestIntersectionUpdate();
  },
  unobserve(o, target) {
    const { id } = ioOf(o);
    if (!globalThis.__dom.ioUnobserve(id, target._nid)) ioObservers.delete(id);
    // (…the pending flag outliving the observers it was raised for would keep the driver stepping, and with nothing to
    // deliver no update pass would ever clear it)
    if (ioObservers.size === 0) ioNeedsUpdate = false;
  },
  disconnect(o) {
    const { id } = ioOf(o);
    globalThis.__dom.ioDisconnect(id);
    ioObservers.delete(id);
    if (ioObservers.size === 0) ioNeedsUpdate = false;
  },
  takeRecords(o) {
    const s = ioOf(o);
    const queue = s.queue;
    s.queue = [];
    return queue;
  }
});
globalThis.IntersectionObserver = IntersectionObserver;

// An entry: its slots the init's, its rects DOMRectReadOnly of the init's DOMRectInit.
const entryOf = (o) => slotsOf(o, 'IntersectionObserverEntry');
registerInterface('IntersectionObserverEntry', (o) => entryOf(o) !== undefined);
export class IntersectionObserverEntry {
  constructor(init) {
    [init] = convertIntersectionObserverEntryArguments(arguments);
    makeSlots(this, 'IntersectionObserverEntry', {
      time: init.time,
      rootBounds: init.rootBounds === null ? null : readOnlyRectFrom(init.rootBounds),
      boundingClientRect: readOnlyRectFrom(init.boundingClientRect),
      intersectionRect: readOnlyRectFrom(init.intersectionRect),
      isIntersecting: init.isIntersecting,
      isVisible: init.isVisible,
      intersectionRatio: init.intersectionRatio,
      target: init.target
    });
  }
}
installIntersectionObserverEntry(IntersectionObserverEntry, {
  get_time: (e) => entryOf(e).time,
  get_rootBounds: (e) => entryOf(e).rootBounds,
  get_boundingClientRect: (e) => entryOf(e).boundingClientRect,
  get_intersectionRect: (e) => entryOf(e).intersectionRect,
  get_isIntersecting: (e) => entryOf(e).isIntersecting,
  get_isVisible: (e) => entryOf(e).isVisible,
  get_intersectionRatio: (e) => entryOf(e).intersectionRatio,
  get_target: (e) => entryOf(e).target
});
globalThis.IntersectionObserverEntry = IntersectionObserverEntry;

// "Run the update intersection observations steps" for one observer at `time`, over the targets the engine found due
// (not updated within the observer's delay, now updated): their geometry — the engine's (intersection.rs: the root
// rectangle, the target's box clipped by every box between it and the root, the ratio, the threshold index) — for
// `queueEntries` to record once the visibility of every observer's targets is known.
function measureObserver(o, targets, out) {
  const s = ioOf(o);
  const g = observeIntersections(s.root, s.margins, s.thresholds, targets);
  const rect = (k) => (Number.isNaN(g[k]) ? null : { x: g[k], y: g[k + 1], width: g[k + 2], height: g[k + 3] });
  const rootRect = rect(0);
  const measured = [];
  for (let i = 0; i < targets.length; i++) {
    const k = 4 + i * 10;
    const inter = rect(k + 4);
    measured.push({
      target: targets[i], rootRect, targetRect: rect(k), inter, isIntersecting: inter !== null,
      ratio: g[k + 8], thresholdIndex: g[k + 9], tracked: inter !== null && s.trackVisibility
    });
  }
  out.push([o, measured]);
}
// …and the entry queued for each the engine finds moved — its threshold index, its intersecting or its visible state
// other than its registration's — which takes them as its previous ones.
function queueEntries(o, measured, time, visible) {
  const s = ioOf(o);
  const record = new Float64Array(measured.length * 4);
  measured.forEach((m, i) => {
    m.isVisible = m.tracked && visible.get(m.target) === true;
    record.set([m.target._nid, m.thresholdIndex, m.isIntersecting ? 1 : 0, m.isVisible ? 1 : 0], i * 4);
  });
  const moved = globalThis.__dom.ioRecord(s.id, record);
  measured.forEach((m, i) => {
    if (!moved[i]) return;
    queuedIOs.add(o);
    s.queue.push(new IntersectionObserverEntry({
      time,
      rootBounds: m.rootRect,
      boundingClientRect: m.targetRect || ZERO_RECT,
      intersectionRect: m.inter || ZERO_RECT,
      isIntersecting: m.isIntersecting,
      isVisible: m.isVisible,
      intersectionRatio: m.ratio,
      target: m.target
    }));
    queueNotifyTask();
  });
}
// "Queue an intersection observer task": one at a time, to "notify intersection observers" — every observer with
// entries queued, its callback invoked with them, `this` the observer, an exception it throws reported. The entries of
// every observer are queued before any callback runs, so one's callback can take another's records. The notify list is
// every observer that queued any, observing or not since: an unobserve() or a disconnect() between the update and the
// task clears no records (the spec; Chrome drops them), so they are delivered then, never later with another update's.
const queuedIOs = new Set();
let notifyQueued = false;
function queueNotifyTask() {
  if (notifyQueued) return;
  notifyQueued = true;
  globalThis.__csimSetTimeout(notifyIntersectionObservers, 0);
}
function notifyIntersectionObservers() {
  notifyQueued = false;
  const notifyList = Array.from(queuedIOs);
  queuedIOs.clear();
  for (const o of notifyList) {
    const s = ioOf(o);
    if (s.queue.length === 0) continue;
    const entries = s.queue;
    s.queue = [];
    try { s.callback.call(o, entries, o); }
    catch (e) {
      try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('IntersectionObserver callback', e); }
    }
  }
}
const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 };

// The spec's "update intersection observations" step, run from the RENDERING UPDATE — once per
// frame, not once per DOM mutation. That placement is both the spec's and the affordable one: each
// pass is real geometry now, and firing it from every mutation batch made an app-scale page
// unusable (a Discourse slice went from ~6 min to over 10 and tripped the script timeout) while
// amplifying the render → observe → render loop app headers have to latch against.
// A pass whose geometry generation hasn't moved has nothing to report, so it returns immediately.
let lastGeneration = null;
export function updateIntersectionObservations() {
  if (ioObservers.size === 0) { ioNeedsUpdate = false; return; }
  const gen = layoutGeneration();
  // The gen gate alone would swallow a fresh `observe()` on an unchanged page —
  // its initial notification is owed regardless of geometry movement — so the
  // pending flag bypasses it.
  if (gen === lastGeneration && !ioNeedsUpdate) return;
  lastGeneration = gen;
  // Cleared BEFORE the callbacks: an observer re-observed (or a mutation made)
  // inside a callback raises the flag again and is delivered at the NEXT step's
  // render phase — one round of the callback → mutate → observe loop per frame.
  ioNeedsUpdate = false;
  const time = globalThis.__csimPerformanceNow();
  const measured = [];
  for (const [id, targets] of globalThis.__dom.ioDue(time)) measureObserver(ioObservers.get(id), targets, measured);
  // (…the visibility of every tracked intersecting target in one painting of the page)
  const tracked = [];
  for (const [, ms] of measured) for (const m of ms) if (m.tracked) tracked.push(m.target);
  const visible = observedVisibility(tracked);
  for (const [o, ms] of measured) queueEntries(o, ms, time, visible);
  // (…a target its delay skipped is owed an update once the delay is over, whatever moves by then)
  if (globalThis.__dom.ioSkipped()) requestIntersectionUpdate();
}

// A scroll asks for a rendering update, the way it does in a browser: raise the pending flag; the render phase of the
// next step delivers.
export function scheduleIntersectionUpdate() {
  if (ioObservers.size === 0) return;
  requestIntersectionUpdate();
}
globalThis.__csimScheduleIntersectionUpdate = scheduleIntersectionUpdate;

// ── ResizeObserver ────────────────────────────────────────────────────────────────────────────
// A real one (Resize Observer §3), run at the rendering update after the style update and before the intersection
// observations (HTML "update the rendering"): each observation whose observed box's size differs from the one it last
// reported is gathered, deepest-first rounds broadcasting them until none deeper than the last round's shallowest is
// left — one still active there is skipped, and reported as the loop error. Its sizes are the layout's (geometry.rs
// `observed_sizes`), so a transform changes none.
//
// The ResizeObservers observing anything — the engine's (resize_observers.rs: their observations, in creation order,
// what each last reported, which a round found active or skipped), each named by the number `roCreate` gave it — and
// here, by that number, the objects whose callbacks a broadcast calls: held for as long as the engine holds them, so
// one observing nothing lives no longer than its references (§3.5).
const roObservers = new Map();
// The pending flag, as the intersection observations' (above): raised by an observe() — the first observation is owed
// whatever the geometry — and by whatever can change a size (a DOM mutation, a viewport change); the update clears it.
let roNeedsUpdate = false;
function requestResizeUpdate() {
  if (roObservers.size === 0 || roNeedsUpdate) return;
  roNeedsUpdate = true;
  wakeLoop();
}

// Its slots: the callback, and its number among the engine's.
const roOf = (o) => slotsOf(o, 'ResizeObserver');
registerInterface('ResizeObserver', (o) => roOf(o) !== undefined);
export class ResizeObserver {
  constructor(callback) {
    [callback] = convertResizeObserverArguments(arguments);
    makeSlots(this, 'ResizeObserver', { callback, id: globalThis.__dom.roCreate() });
  }
}
// Where an observed box's `[inline, block]` sits among a target's sizes (resize_observation.rs: border, content,
// device-pixel content, then the content rect).
const OBSERVED_BOX = { 'border-box': 0, 'content-box': 2, 'device-pixel-content-box': 4 };
installResizeObserver(ResizeObserver, {
  // (…a target observed again is observed anew, with the box it is given now, at the end of the list)
  observe(o, target, options) {
    const { id } = roOf(o);
    globalThis.__dom.roObserve(id, target._nid, OBSERVED_BOX[options.box], target);
    roObservers.set(id, o);
    requestResizeUpdate();
  },
  unobserve(o, target) {
    const { id } = roOf(o);
    if (!globalThis.__dom.roUnobserve(id, target._nid)) roObservers.delete(id);
  },
  disconnect(o) {
    const { id } = roOf(o);
    globalThis.__dom.roDisconnect(id);
    roObservers.delete(id);
  }
});
globalThis.ResizeObserver = ResizeObserver;

// An entry, and the sizes in it — made by the platform alone (no constructors).
const roEntryOf = (o) => slotsOf(o, 'ResizeObserverEntry');
registerInterface('ResizeObserverEntry', (o) => roEntryOf(o) !== undefined);
export class ResizeObserverEntry {
  constructor(token, slots) {
    constructedBy(PLATFORM, token, 'ResizeObserverEntry');
    makeSlots(this, 'ResizeObserverEntry', slots);
  }
}
installResizeObserverEntry(ResizeObserverEntry, {
  get_target: (e) => roEntryOf(e).target,
  get_contentRect: (e) => roEntryOf(e).contentRect,
  get_borderBoxSize: (e) => roEntryOf(e).borderBoxSize,
  get_contentBoxSize: (e) => roEntryOf(e).contentBoxSize,
  get_devicePixelContentBoxSize: (e) => roEntryOf(e).devicePixelContentBoxSize
});
globalThis.ResizeObserverEntry = ResizeObserverEntry;
const roSizeOf = (o) => slotsOf(o, 'ResizeObserverSize');
registerInterface('ResizeObserverSize', (o) => roSizeOf(o) !== undefined);
export class ResizeObserverSize {
  constructor(token, inlineSize, blockSize) {
    constructedBy(PLATFORM, token, 'ResizeObserverSize');
    makeSlots(this, 'ResizeObserverSize', { inlineSize, blockSize });
  }
}
installResizeObserverSize(ResizeObserverSize, {
  get_inlineSize: (z) => roSizeOf(z).inlineSize,
  get_blockSize: (z) => roSizeOf(z).blockSize
});
globalThis.ResizeObserverSize = ResizeObserverSize;

// "Gather active observations at depth" — the engine's, over the sizes of every observed box measured here, the
// layout's (`resizeObservations`, all 0 for a target with no box measured: an SVG graphics element with no CSS box, a
// `<rect>`, is measured by its bounding box, which nothing here computes yet) — the observers with any active returned.
function gatherAt(depth) {
  return globalThis.__dom.roGather(depth, resizeObservations(globalThis.__dom.roTargets(), globalThis.devicePixelRatio));
}
// "Broadcast active resize observations": each observer's entries — every size of the target, its content rect at its
// padding edge in physical axes, as the gather found them — to its callback, `this` the observer, an exception
// reported; the shallowest depth broadcast returned.
function broadcast(ids) {
  let shallowest = Infinity;
  for (const id of ids) {
    const o = roObservers.get(id);
    const active = o && globalThis.__dom.roTakeActive(id);
    if (!active) continue;
    const [targets, z] = active;
    shallowest = Math.min(shallowest, active[2]);
    const entries = targets.map((target, i) => {
      const frozen = (k) => Object.freeze([new ResizeObserverSize(PLATFORM, z[i * 10 + k], z[i * 10 + k + 1])]);
      return new ResizeObserverEntry(PLATFORM, {
        target,
        contentRect: new DOMRectReadOnly(z[i * 10 + 6], z[i * 10 + 7], z[i * 10 + 8], z[i * 10 + 9]),
        borderBoxSize: frozen(0),
        contentBoxSize: frozen(2),
        devicePixelContentBoxSize: frozen(4)
      });
    });
    if (!globalThis.__dom.roHolds(id)) roObservers.delete(id);
    const { callback } = roOf(o);
    try { callback.call(o, entries, o); }
    catch (e) {
      try { globalThis.__csimReportCallbackError(callback, e); } catch (_) { logThrew('ResizeObserver callback', e); }
    }
  }
  return shallowest;
}

// The rendering update's resize observation loop. A pass whose geometry generation has not moved since the last, with
// nothing observed since, has nothing active, so it returns at once.
let roLastGeneration = null;
export function updateResizeObservations() {
  if (roObservers.size === 0) { roNeedsUpdate = false; return; }
  const gen = layoutGeneration();
  if (gen === roLastGeneration && !roNeedsUpdate) return;
  roNeedsUpdate = false;
  let active = gatherAt(0);
  while (active.length) active = gatherAt(broadcast(active));
  // (…one left skipped is reported, and still active: the next update reports it — a pending update keeps it coming)
  if (globalThis.__dom.roSkipped()) {
    globalThis.__csimReportLoopError('ResizeObserver loop completed with undelivered notifications.');
    roNeedsUpdate = true;
  }
  roLastGeneration = layoutGeneration();
}

// A DOM mutation, or a viewport change, asks for a rendering update for both kinds of observation: the geometry either
// observes may have moved.
export function hasPendingObservations() {
  return ioNeedsUpdate || roNeedsUpdate;
}
globalThis.__csimScheduleObservations = function () {
  if (ioObservers.size) requestIntersectionUpdate();
  if (roObservers.size) requestResizeUpdate();
  // (…and the realm's above it, once some realm's observer has observed another realm's node — a page's of a frame's
  // element, whose layout moving moves none of the page's generations: the engine's word, read with no call)
  if (globalThis.__dom.foreignObserved[0] !== 0) scheduleParentObservations();
};
function scheduleParentObservations() {
  const parent = globalThis.__dom.parentRealm();
  if (parent < 0) return;
  try { globalThis.RustyRacer.contextGlobal(parent).__csimScheduleObservations(); } catch (_) {}
}

// PerformanceObserver (Performance Timeline §6), generated from its IDL: performance.mark / measure and a resource load
// hand each new entry to `__csimDeliverPerfEntry`, which queues it on every observer of its type; the callbacks run in a
// task (the performance timeline task source: a `Promise.then` queued after `mark()` runs before it, Chrome), once for
// everything queued. Its slots: the callback, its type — 'multiple' (observe({entryTypes})) or 'single'
// (observe({type})), fixed by the first observe() — the types it observes, the queued entries, and whether the next
// callback reports dropped entries (the first since an observe()).
const SUPPORTED_ENTRY_TYPES = Object.freeze(['mark', 'measure', 'resource']);
const perfObservers = new Set();
const poOf = (o) => slotsOf(o, 'PerformanceObserver');
registerInterface('PerformanceObserver', (o) => poOf(o) !== undefined);
export class PerformanceObserver {
  constructor(callback) {
    [callback] = convertPerformanceObserverArguments(arguments);
    makeSlots(this, 'PerformanceObserver', {
      callback, observerType: null, types: new Set(), queue: [], requiresDroppedEntries: false
    });
  }
}
const PO_OBSERVE = "Failed to execute 'observe' on 'PerformanceObserver': ";
const MODIFIED = {
  multiple: 'This observer has performed observe({entryTypes:...}, therefore it cannot perform observe({type:...})',
  single: 'This PerformanceObserver has performed observe({type:...}, therefore it cannot perform observe({entryTypes:...})'
};
installPerformanceObserver(PerformanceObserver, {
  // The observe() steps: entryTypes or type, not both nor neither, nor entryTypes with anything else (TypeError); the observer's type fixed by its first
  // call (InvalidModificationError to change it); unsupported types ignored — none left, no observation; `buffered`
  // (with `type`) delivering the entries already in the buffer of that type — how a page observes the resources it
  // loaded before it subscribed.
  observe(o, options) {
    const s = poOf(o);
    if (options.entryTypes === undefined && options.type === undefined) {
      throw new TypeError(PO_OBSERVE + 'An observe() call must include either entryTypes or type arguments.');
    }
    if (options.entryTypes !== undefined && options.type !== undefined) {
      throw new TypeError(PO_OBSERVE + 'An observe() call must not include both entryTypes and type arguments.');
    }
    // (…nor entryTypes with any other member — `buffered`, Event Timing's `durationThreshold` — the spec's step, where
    // Chrome and Firefox take them)
    if (options.entryTypes !== undefined && Object.keys(options).length > 1) {
      throw new TypeError(PO_OBSERVE + 'An observe() call must not include both entryTypes and other arguments.');
    }
    const observerType = options.entryTypes !== undefined ? 'multiple' : 'single';
    if (s.observerType !== null && s.observerType !== observerType) {
      throw new DOMException(PO_OBSERVE + MODIFIED[s.observerType], 'InvalidModificationError');
    }
    s.observerType = observerType;
    s.requiresDroppedEntries = true;
    if (observerType === 'multiple') {
      const types = options.entryTypes.filter((t) => SUPPORTED_ENTRY_TYPES.includes(t));
      if (types.length === 0) return;
      s.types = new Set(types);
    } else {
      if (!SUPPORTED_ENTRY_TYPES.includes(options.type)) return;
      s.types.add(options.type);
      if (options.buffered && typeof globalThis.__csimBufferedPerfEntries === 'function') {
        for (const e of globalThis.__csimBufferedPerfEntries(options.type)) s.queue.push(e);
        if (s.queue.length) queuePerformanceObserverTask();
      }
    }
    perfObservers.add(o);
  },
  disconnect(o) {
    const s = poOf(o);
    perfObservers.delete(o);
    s.queue = [];
    s.types = new Set();
  },
  takeRecords(o) {
    const s = poOf(o);
    const queue = s.queue;
    s.queue = [];
    return queue;
  },
  get_supportedEntryTypes: () => SUPPORTED_ENTRY_TYPES
});
globalThis.PerformanceObserver = PerformanceObserver;
// "Queue the PerformanceObserver task": one at a time, which calls back every registered observer with entries queued,
// in the order they registered — each with its entry list, the observer (and `this`) and, the first time since an
// observe(), the count of entries dropped from a full buffer: none, ours never fill.
let perfTaskQueued = false;
function queuePerformanceObserverTask() {
  if (perfTaskQueued) return;
  perfTaskQueued = true;
  globalThis.__csimSetTimeout(() => {
    perfTaskQueued = false;
    for (const o of Array.from(perfObservers)) {
      const s = poOf(o);
      if (s.queue.length === 0) continue;
      const entries = s.queue;
      s.queue = [];
      const callbackOptions = s.requiresDroppedEntries ? { droppedEntriesCount: 0 } : {};
      s.requiresDroppedEntries = false;
      try { s.callback.call(o, new PerformanceObserverEntryList(PLATFORM, entries), o, callbackOptions); }
      catch (e) {
        try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('PerformanceObserver callback', e); }
      }
    }
  }, 0);
}

// A PerformanceObserverEntryList: the entries a callback was given, filtered by type / name — in startTime order, as
// "filter buffer by name and type" sorts them.
const listOf = (o) => slotsOf(o, 'PerformanceObserverEntryList');
registerInterface('PerformanceObserverEntryList', (o) => listOf(o) !== undefined);
export class PerformanceObserverEntryList {
  constructor(token, entries) {
    constructedBy(PLATFORM, token, 'PerformanceObserverEntryList');
    makeSlots(this, 'PerformanceObserverEntryList', { entries });
  }
}
const byStartTime = (a, b) => a.startTime - b.startTime;
installPerformanceObserverEntryList(PerformanceObserverEntryList, {
  getEntries: (l) => listOf(l).entries.slice().sort(byStartTime),
  getEntriesByType: (l, type) => listOf(l).entries.filter((e) => e.entryType === type).sort(byStartTime),
  getEntriesByName: (l, name, type) => listOf(l).entries.filter((e) => e.name === name && (type === undefined || e.entryType === type)).sort(byStartTime)
});
globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;

// A new entry, from performance.mark / measure / a resource load: queued on every observer of its type.
globalThis.__csimDeliverPerfEntry = function (entry) {
  for (const o of perfObservers) {
    const s = poOf(o);
    if (!s.types.has(entry.entryType)) continue;
    s.queue.push(entry);
    queuePerformanceObserverTask();
  }
};
