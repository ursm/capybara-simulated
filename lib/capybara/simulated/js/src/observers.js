import { logThrew }                    from './console.js';
import { observeIntersections, observedSizes, layoutGeneration, observedVisibility } from './layout.js';
import { NODE_ELEMENT }                from './constants.js';
import { flatTreeParent }              from './walk.js';
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
const activeIOs = new Set();

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
  if (activeIOs.size === 0 || ioNeedsUpdate) return;
  ioNeedsUpdate = true;
  // The idle→active transition a newly scheduled timer makes: the driver's
  // settle/wait loops keep stepping while work is pending, and the render phase
  // of the next step is what delivers. ONE flag, raised only on the false→true
  // edge — a second "already woke the loop" latch drifted from this one and a
  // stuck latch silenced every later wake (review-caught: observe → disconnect →
  // clearTimeout left the page event-loop-dead).
  wakeLoop();
}

// Its slots: the callback, root, margins, thresholds (a frozen list, ascending), delay and trackVisibility, each
// observed target's registration — its previous threshold index (-1 at first, which differs from every computed one, so
// the first update always reports), whether it was intersecting and visible, and when it was last updated — and the
// entries queued for the callback, which `takeRecords()` takes.
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
      targets: new Map(), queue: []
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
    if (s.targets.has(target)) return;
    s.targets.set(target, { previousThresholdIndex: -1, previousIsIntersecting: false, previousIsVisible: false, lastUpdateTime: -Infinity });
    activeIOs.add(o);
    // (…the initial notification at the NEXT rendering update, never inside observe(): the pending flag raised is what
    // makes that update run)
    requestIntersectionUpdate();
  },
  unobserve(o, target) {
    const s = ioOf(o);
    s.targets.delete(target);
    if (s.targets.size === 0) activeIOs.delete(o);
    // (…the pending flag outliving the observers it was raised for would keep the driver stepping, and with nothing to
    // deliver no update pass would ever clear it)
    if (activeIOs.size === 0) ioNeedsUpdate = false;
  },
  disconnect(o) {
    ioOf(o).targets.clear();
    activeIOs.delete(o);
    if (activeIOs.size === 0) ioNeedsUpdate = false;
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

// "Run the update intersection observations steps" for one observer at `time`: for each target not updated within the
// observer's delay, its geometry — the engine's (intersection.rs: the root rectangle, the target's box clipped by every
// box between it and the root, the ratio, the threshold index) — for `queueEntries` to compare with its registration
// once the visibility of every observer's targets is known; and whether any target was skipped for its delay, which the
// next update must see again.
function measureObserver(o, time, out) {
  const s = ioOf(o);
  let skipped = false;
  const due = [];
  for (const [target, registration] of s.targets) {
    if (time - registration.lastUpdateTime < s.delay) { skipped = true; continue; }
    registration.lastUpdateTime = time;
    due.push([target, registration]);
  }
  if (!due.length) return skipped;
  const root = s.root && s.root._nodeType === NODE_ELEMENT ? s.root : null;
  const g = observeIntersections(root, s.margins, s.thresholds, due.map(([target]) => target));
  const rect = (k) => (Number.isNaN(g[k]) ? null : { x: g[k], y: g[k + 1], width: g[k + 2], height: g[k + 3] });
  const rootRect = rect(0);
  for (let i = 0; i < due.length; i++) {
    const k = 4 + i * 10, [target, registration] = due[i];
    const inter = rect(k + 4);
    out.push({
      o, s, target, registration, rootRect, targetRect: rect(k), inter, isIntersecting: inter !== null,
      ratio: g[k + 8], thresholdIndex: g[k + 9], tracked: inter !== null && s.trackVisibility
    });
  }
  return skipped;
}
// …and the entry queued for each where its threshold index, its intersecting or its visible state moved.
function queueEntries(m, time, isVisible) {
  const { o, s, target, registration } = m;
  if (m.thresholdIndex !== registration.previousThresholdIndex || m.isIntersecting !== registration.previousIsIntersecting ||
      isVisible !== registration.previousIsVisible) {
    queuedIOs.add(o);
    s.queue.push(new IntersectionObserverEntry({
      time,
      rootBounds: m.rootRect,
      boundingClientRect: m.targetRect || ZERO_RECT,
      intersectionRect: m.inter || ZERO_RECT,
      isIntersecting: m.isIntersecting,
      isVisible,
      intersectionRatio: m.ratio,
      target
    }));
    queueNotifyTask();
  }
  registration.previousThresholdIndex = m.thresholdIndex;
  registration.previousIsIntersecting = m.isIntersecting;
  registration.previousIsVisible = isVisible;
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
  if (activeIOs.size === 0) { ioNeedsUpdate = false; return; }
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
  let skipped = false;
  const measured = [];
  for (const io of Array.from(activeIOs)) skipped = measureObserver(io, time, measured) || skipped;
  // (…the visibility of every tracked intersecting target in one painting of the page)
  const visible = observedVisibility(measured.filter((m) => m.tracked).map((m) => m.target));
  for (const m of measured) queueEntries(m, time, m.tracked && visible.get(m.target) === true);
  // (…a target its delay skipped is owed an update once the delay is over, whatever moves by then)
  if (skipped) requestIntersectionUpdate();
}

// A scroll asks for a rendering update, the way it does in a browser: raise the pending flag; the render phase of the
// next step delivers.
export function scheduleIntersectionUpdate() {
  if (activeIOs.size === 0) return;
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
// The ResizeObservers observing anything, which are all the document's `[[resizeObservers]]` the steps can find any
// observation of — in creation order (`seq`), as the steps visit them. One observing nothing is not held here, so it
// lives no longer than its references (§3.5).
const observingROs = new Set();
let roSeq = 0;
// The pending flag, as the intersection observations' (above): raised by an observe() — the first observation is owed
// whatever the geometry — and by whatever can change a size (a DOM mutation, a viewport change); the update clears it.
let roNeedsUpdate = false;
function requestResizeUpdate() {
  if (observingROs.size === 0 || roNeedsUpdate) return;
  roNeedsUpdate = true;
  wakeLoop();
}

// Its slots: the callback, its place in creation order, its observations — `{target, box, last}`, `last` the
// [inline, block] size it last reported of the observed box, (-1, -1) before the first, which differs from every size so
// the first update reports — and the ones the current round found active, or skipped.
const roOf = (o) => slotsOf(o, 'ResizeObserver');
registerInterface('ResizeObserver', (o) => roOf(o) !== undefined);
export class ResizeObserver {
  constructor(callback) {
    [callback] = convertResizeObserverArguments(arguments);
    makeSlots(this, 'ResizeObserver', { callback, seq: roSeq++, observations: [], active: [], skipped: [] });
  }
}
installResizeObserver(ResizeObserver, {
  // (…a target observed again is observed anew, with the box it is given now, at the end of the list)
  observe(o, target, options) {
    const s = roOf(o);
    s.observations = s.observations.filter((ob) => ob.target !== target);
    s.observations.push({ target, box: options.box, last: [-1, -1] });
    observingROs.add(o);
    requestResizeUpdate();
  },
  unobserve(o, target) {
    const s = roOf(o);
    s.observations = s.observations.filter((ob) => ob.target !== target);
    if (s.observations.length === 0) observingROs.delete(o);
  },
  disconnect(o) {
    const s = roOf(o);
    s.observations = [];
    s.active = [];
    observingROs.delete(o);
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

// "Calculate box size" of `target`'s observed `box`, as [inline, block]: its border area, its content area, or that in
// integral device pixels — all 0 where it has no box measured. (An SVG graphics element with no CSS box — a `<rect>` —
// is measured by its bounding box, which nothing here computes yet: 0 as well.)
const NO_SIZES = { border: [0, 0], content: [0, 0], contentRect: { x: 0, y: 0, width: 0, height: 0 } };
function boxSize(sizes, box) {
  if (box === 'border-box') return sizes.border;
  if (box === 'content-box') return sizes.content;
  const ratio = globalThis.devicePixelRatio || 1;
  return sizes.content.map((v) => Math.round(v * ratio));
}
function isActive(ob) {
  const [inline, block] = boxSize(observedSizes(ob.target) || NO_SIZES, ob.box);
  return inline !== ob.last[0] || block !== ob.last[1];
}
// "Calculate depth for node": the nodes on its flat-tree path to the root.
function depthOf(node) {
  let depth = 0;
  for (let n = node; n; n = flatTreeParent(n)) depth++;
  return depth;
}
function gatherAt(depth, observers) {
  for (const o of observers) {
    const s = roOf(o);
    s.active = [];
    s.skipped = [];
    for (const ob of s.observations) {
      if (!isActive(ob)) continue;
      (depthOf(ob.target) > depth ? s.active : s.skipped).push(ob);
    }
  }
}
// "Broadcast active resize observations": each observer's entries — every size of the target, its content rect at its
// padding edge in physical axes — to its callback, `this` the observer, an exception reported; the shallowest depth
// broadcast returned.
function broadcast(observers) {
  let shallowest = Infinity;
  for (const o of observers) {
    const s = roOf(o);
    if (s.active.length === 0) continue;
    const entries = s.active.map((ob) => {
      const sizes = observedSizes(ob.target) || NO_SIZES;
      const frozen = (box) => Object.freeze([new ResizeObserverSize(PLATFORM, ...boxSize(sizes, box))]);
      const { x, y, width, height } = sizes.contentRect;
      const entry = new ResizeObserverEntry(PLATFORM, {
        target: ob.target,
        contentRect: new DOMRectReadOnly(x, y, width, height),
        borderBoxSize: frozen('border-box'),
        contentBoxSize: frozen('content-box'),
        devicePixelContentBoxSize: frozen('device-pixel-content-box')
      });
      ob.last = boxSize(sizes, ob.box);
      shallowest = Math.min(shallowest, depthOf(ob.target));
      return entry;
    });
    s.active = [];
    try { s.callback.call(o, entries, o); }
    catch (e) {
      try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('ResizeObserver callback', e); }
    }
  }
  return shallowest;
}

// The rendering update's resize observation loop. A pass whose geometry generation has not moved since the last, with
// nothing observed since, has nothing active, so it returns at once.
let roLastGeneration = null;
export function updateResizeObservations() {
  if (observingROs.size === 0) { roNeedsUpdate = false; return; }
  const gen = layoutGeneration();
  if (gen === roLastGeneration && !roNeedsUpdate) return;
  roNeedsUpdate = false;
  const observers = Array.from(observingROs).sort((a, b) => roOf(a).seq - roOf(b).seq);
  let depth = 0;
  gatherAt(depth, observers);
  while (observers.some((o) => roOf(o).active.length)) {
    depth = broadcast(observers);
    gatherAt(depth, observers);
  }
  // (…one left skipped is reported, and still active: the next update reports it — a pending update keeps it coming)
  if (observers.some((o) => roOf(o).skipped.length)) {
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
  if (activeIOs.size) requestIntersectionUpdate();
  if (observingROs.size) requestResizeUpdate();
};

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
