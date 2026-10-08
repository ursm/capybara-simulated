import { logThrew }                    from './console.js';
import { observedRect, viewportSize, layoutGeneration, isObscured } from './layout.js';
import { NODE_ELEMENT }                from './constants.js';
import { engineValue }                 from './cascade.js';
import { flatTreeParent }              from './walk.js';
import { DOMRectReadOnly }             from './geometry.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import {
  convertIntersectionObserverArguments,
  convertIntersectionObserverEntryArguments,
  convertPerformanceObserverArguments,
  installIntersectionObserver,
  installIntersectionObserverEntry,
  installPerformanceObserver,
  installPerformanceObserverEntryList
} from './generated/bindings.js';
// Cycle with timers.js (it imports our update/pending fns) — safe: both edges
// are function declarations called only at runtime, never at module init.
import { wakeLoop }                    from './timers.js';

// Observers. `IntersectionObserver` is real (see below, it reads the layout engine);
// `ResizeObserver` is still a no-op (the `StubObserver` shape) and `PerformanceObserver` is
// entry-driven.

class StubObserver {
  constructor(cb) { this._cb = cb; }
  observe()       {}
  unobserve()     {}
  disconnect()    {}
  takeRecords()   { return []; }
}

// ── IntersectionObserver ─────────────────────────────────────────────────────────────────────
// A real one, computed against the layout engine: the target's rendered box versus the root's
// (the viewport, or an element's box), expanded by `rootMargin` and clipped by any ancestor
// scroll container. It reports LEAVING as well as entering — the whole point of the API and the
// half a "fires true once" stub can never do (Discourse's header swaps the auth buttons for the
// topic title when the title scrolls OUT of view).
//
// Delivery follows the spec's shape but our clock: the update runs at the rendering update
// (timers.js), after a mutation batch, and after a scroll — each of those is a moment the geometry
// can have changed — and notifies only targets whose threshold index actually moved.
const activeIOs = new Set();

// `rootMargin`: 1–4 CSS lengths in the usual top/right/bottom/left mirroring. Percentages resolve
// against the ROOT's own width (left/right) or height (top/bottom), per spec.
const ROOT_MARGIN_RE = /^(-?\d+(?:\.\d+)?)(px|%)?$/;
function parseRootMargin(text, name) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const error = () => new SyntaxError(`Failed to construct 'IntersectionObserver': ${name} must be specified in pixels or percent.`);
  if (!parts.length || parts.length > 4) throw error();
  const vals = parts.map((part) => {
    const m = ROOT_MARGIN_RE.exec(part);
    if (!m) throw error();
    return { value: parseFloat(m[1]), pct: m[2] === '%' };
  });
  const [top, right = top, bottom = top, left = right] = vals;
  return [top, right, bottom, left];
}
function serializeRootMargin(margins) {
  return margins.map((m) => `${m.value}${m.pct ? '%' : 'px'}`).join(' ');
}

// The root's rect, expanded by rootMargin. Per spec the root is an Element OR a Document — and a
// Document root (which Discourse's post stream passes, and the implicit root when none is given)
// means the document's VIEWPORT, not a box in the layout. An Element root with no box has no
// intersection rect at all, which is correct: nothing inside an unrendered scroller is visible.
function rootRectOf(s) {
  const root = s.root;
  const base = (root && root._nodeType === NODE_ELEMENT) ? observedRect(root) : (() => {
    const vp = viewportSize();
    return { x: 0, y: 0, width: vp.width, height: vp.height };
  })();
  if (!base) return null;
  const [t, r, b, l] = s.margins.map((m, i) => (
    m.pct ? (m.value / 100) * (i % 2 ? base.width : base.height) : m.value
  ));
  return { x: base.x - l, y: base.y - t, width: base.width + l + r, height: base.height + t + b };
}

// Edge-adjacent counts as intersecting (a zero-area intersection is still one), which is why the
// comparison is `<` and not `<=`.
function intersectRects(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right  = Math.min(a.x + a.width,  b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right < x || bottom < y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// IntersectionObserver delivery is FRAME-PACED, exactly as in a browser: every
// producer — `observe()`'s spec-mandated initial notification, a scroll, a DOM
// mutation — only RAISES the pending flag here, and the one delivery site is the
// render phase's `updateIntersectionObservations` (once per `__runLoopStep`).
// The flag participates in the event loop's pending-work contract
// (`hasPendingIntersections` folds into `pendingEmpty`, and raising it flips the
// driver's timers-active flag), so an otherwise idle page still gets a step and
// its entries — the reason the old model delivered on an eager microtask.
//
// The eager microtask was also a livelock: an app whose IO callback re-renders
// and re-observes its target (Discourse's composer-image-node) looped
// callback → mutate → observe → initial-callback unboundedly inside ONE
// microtask checkpoint, each round forcing a fresh layout pass — the ProseMirror
// composer spun thousands of passes inside a single `__runLoopStep`. With
// delivery once per step, that app loop advances one round per frame, which is
// what a browser's cadence imposes on it.
let ioNeedsUpdate = false;
export function hasPendingIntersections() {
  return ioNeedsUpdate;
}
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
// observed target's previous threshold index — -1 "never observed", which differs from every computed one, so the
// first update always reports (spec) — and the entries queued for the callback, which `takeRecords()` takes.
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
    s.targets.set(target, -1);
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
      rootBounds: init.rootBounds === null ? null : DOMRectReadOnly.fromRect(init.rootBounds),
      boundingClientRect: DOMRectReadOnly.fromRect(init.boundingClientRect),
      intersectionRect: DOMRectReadOnly.fromRect(init.intersectionRect),
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

// "Compute visibility" (Intersection Observer v2) of an intersecting target: false where the observer does not track
// visibility; otherwise where the target, or an ancestor, is transformed beyond a translation, translucent, or
// filtered, or where something covers it.
const PLAIN_TRANSFORM = /^(none|matrix\(1, 0, 0, 1, [^,]+, [^)]+\))$/;
function computeVisibility(s, target) {
  if (!s.trackVisibility) return false;
  for (let el = target; el && el._nodeType === NODE_ELEMENT; el = flatTreeParent(el)) {
    if (Number(engineValue(el, 'opacity') ?? '1') < 1) return false;
    if ((engineValue(el, 'filter') ?? 'none') !== 'none') return false;
    if (!PLAIN_TRANSFORM.test(engineValue(el, 'transform') ?? 'none')) return false;
  }
  return !isObscured(target);
}

// "Run the update intersection observations steps" for one observer: an entry queued for each target whose threshold
// index moved, then the callback invoked with the queue — `this` the observer — an exception it throws reported.
function updateObserver(o) {
  const s = ioOf(o);
  if (s.targets.size === 0) return;
  const rootRect = rootRectOf(s);
  for (const [target, previous] of s.targets) {
    const targetRect = observedRect(target);
    const inter = intersectRects(targetRect, rootRect);
    const targetArea = targetRect ? targetRect.width * targetRect.height : 0;
    const isIntersecting = inter !== null;
    // (…a zero-area target inside the root fully intersecting, ratio 1: how a collapsed sentinel `<div>` — the
    // load-more pattern — reports)
    const ratio = !isIntersecting ? 0 : targetArea > 0 ? (inter.width * inter.height) / targetArea : 1;
    const index = isIntersecting ? s.thresholds.filter((t) => t <= ratio).length : 0;
    if (index === previous) continue;
    s.targets.set(target, index);
    s.queue.push(new IntersectionObserverEntry({
      time: (globalThis.__csimPerformance && globalThis.__csimPerformance.now()) || 0,
      rootBounds: rootRect,
      boundingClientRect: targetRect || ZERO_RECT,
      intersectionRect: inter || ZERO_RECT,
      isIntersecting,
      isVisible: isIntersecting && computeVisibility(s, target),
      intersectionRatio: ratio,
      target
    }));
  }
  if (s.queue.length === 0) return;
  const entries = s.queue;
  s.queue = [];
  try { s.callback.call(o, entries, o); }
  catch (e) {
    try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('IntersectionObserver callback', e); }
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
  for (const io of Array.from(activeIOs)) updateObserver(io);
}

// A scroll / DOM mutation asks for a rendering update, the way it does in a
// browser: raise the pending flag; the render phase of the next step delivers.
export function scheduleIntersectionUpdate() {
  if (activeIOs.size === 0) return;
  requestIntersectionUpdate();
}
globalThis.__csimScheduleIntersectionUpdate = scheduleIntersectionUpdate;
globalThis.__recheckIntersectionObservers = updateIntersectionObservations;

globalThis.ResizeObserver = class extends StubObserver {};

// PerformanceObserver (Performance Timeline §6), generated from its IDL: performance.mark / measure and a resource load
// hand each new entry to `__csimDeliverPerfEntry`, which queues it on every observer of its type; the callback runs as a
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
      callback, observerType: null, types: new Set(), queue: [], scheduled: false, requiresDroppedEntries: false
    });
  }
}
const PO_OBSERVE = "Failed to execute 'observe' on 'PerformanceObserver': ";
const MODIFIED = {
  multiple: 'This observer has performed observe({entryTypes:...}, therefore it cannot perform observe({type:...})',
  single: 'This PerformanceObserver has performed observe({type:...}, therefore it cannot perform observe({entryTypes:...})'
};
installPerformanceObserver(PerformanceObserver, {
  // The observe() steps: entryTypes or type, not both nor neither (TypeError); the observer's type fixed by its first
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
        if (s.queue.length) schedule(o, s);
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
function schedule(o, s) {
  if (s.scheduled) return;
  s.scheduled = true;
  globalThis.__csimSetTimeout(() => {
    s.scheduled = false;
    const entries = s.queue;
    s.queue = [];
    if (entries.length === 0) return;
    // (…the options of the first callback since an observe() counting the entries dropped from a full buffer — none,
    // ours never fill)
    const callbackOptions = s.requiresDroppedEntries ? { droppedEntriesCount: 0 } : {};
    s.requiresDroppedEntries = false;
    try { s.callback.call(o, new PerformanceObserverEntryList(PLATFORM, entries), o, callbackOptions); }
    catch (e) {
      try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('PerformanceObserver callback', e); }
    }
  }, 0);
}

// A PerformanceObserverEntryList: the entries a callback was given, filtered by type / name.
const listOf = (o) => slotsOf(o, 'PerformanceObserverEntryList');
registerInterface('PerformanceObserverEntryList', (o) => listOf(o) !== undefined);
export class PerformanceObserverEntryList {
  constructor(token, entries) {
    constructedBy(PLATFORM, token, 'PerformanceObserverEntryList');
    makeSlots(this, 'PerformanceObserverEntryList', { entries });
  }
}
installPerformanceObserverEntryList(PerformanceObserverEntryList, {
  getEntries: (l) => listOf(l).entries.slice(),
  getEntriesByType: (l, type) => listOf(l).entries.filter((e) => e.entryType === type),
  getEntriesByName: (l, name, type) => listOf(l).entries.filter((e) => e.name === name && (type === undefined || e.entryType === type))
});
globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;

// A new entry, from performance.mark / measure / a resource load: queued on every observer of its type.
globalThis.__csimDeliverPerfEntry = function (entry) {
  for (const o of perfObservers) {
    const s = poOf(o);
    if (!s.types.has(entry.entryType)) continue;
    s.queue.push(entry);
    schedule(o, s);
  }
};
