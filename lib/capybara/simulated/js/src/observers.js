import { logThrew }                    from './console.js';
import { observedRect, viewportSize, layoutGeneration } from './layout.js';
import { NODE_ELEMENT }                from './constants.js';
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
function parseRootMargin(text) {
  const parts = String(text == null || text === '' ? '0px' : text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) throw new SyntaxError(`Failed to construct 'IntersectionObserver': rootMargin must be specified in pixels or percent.`);
  const vals = parts.map((part) => {
    const m = ROOT_MARGIN_RE.exec(part);
    if (!m) throw new SyntaxError(`Failed to construct 'IntersectionObserver': rootMargin must be specified in pixels or percent.`);
    return { value: parseFloat(m[1]), pct: m[2] === '%' };
  });
  const [top, right = top, bottom = top, left = right] = vals;
  return [top, right, bottom, left];
}
function serializeRootMargin(margins) {
  return margins.map((m) => `${m.value}${m.pct ? '%' : 'px'}`).join(' ');
}

function normalizeThresholds(input) {
  const list = (input == null ? [0] : (Array.isArray(input) ? input : [input])).map(Number);
  for (const t of list) {
    if (!(t >= 0 && t <= 1)) throw new RangeError(`Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1`);
  }
  return (list.length ? list : [0]).slice().sort((a, b) => a - b);
}

function rectOrNull(r) {
  return r ? new globalThis.DOMRectReadOnly(r.x, r.y, r.width, r.height) : null;
}

// The root's rect, expanded by rootMargin. Per spec the root is an Element OR a Document — and a
// Document root (which Discourse's post stream passes, and the implicit root when none is given)
// means the document's VIEWPORT, not a box in the layout. An Element root with no box has no
// intersection rect at all, which is correct: nothing inside an unrendered scroller is visible.
function rootRectOf(observer) {
  const root = observer.root;
  const base = (root && root.nodeType === NODE_ELEMENT) ? observedRect(root) : (() => {
    const vp = viewportSize();
    return { x: 0, y: 0, width: vp.width, height: vp.height };
  })();
  if (!base) return null;
  const [t, r, b, l] = observer._margins.map((m, i) => (
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

class IntersectionObserver {
  constructor(cb, options = {}) {
    if (typeof cb !== 'function') throw new TypeError(`Failed to construct 'IntersectionObserver': parameter 1 is not of type 'Function'.`);
    const opts = options || {};
    this._cb      = cb;
    this._root    = opts.root != null ? opts.root : null;
    this._margins = parseRootMargin(opts.rootMargin);
    this._thresholds = Object.freeze(normalizeThresholds(opts.threshold));
    // target → the last threshold index we notified for it. -1 is "never observed", which differs
    // from every computed index, so the first update always delivers an initial entry (spec).
    this._state = new Map();
  }
  get root()       { return this._root; }
  get rootMargin() { return serializeRootMargin(this._margins); }
  get thresholds() { return this._thresholds; }

  observe(target) {
    if (!target || this._state.has(target)) return;
    this._state.set(target, -1);
    activeIOs.add(this);
    // The initial notification arrives at the NEXT rendering update (spec: the
    // first "update intersection observations" pass after observe), never inside
    // `observe()` — raising the pending flag is what guarantees that update runs.
    requestIntersectionUpdate();
  }
  unobserve(target) {
    this._state.delete(target);
    if (this._state.size === 0) activeIOs.delete(this);
    // The pending flag must not outlive the observers it was raised for: it is
    // what keeps the driver stepping, and with nothing left to deliver the next
    // update pass would never run to clear it.
    if (activeIOs.size === 0) ioNeedsUpdate = false;
  }
  disconnect() {
    this._state.clear();
    activeIOs.delete(this);
    if (activeIOs.size === 0) ioNeedsUpdate = false;
  }
  takeRecords() { return []; }   // we deliver synchronously, so nothing is ever queued

  _update(targets) {
    if (this._state.size === 0) return;
    const rootRect = rootRectOf(this);
    const entries = [];
    for (const target of (targets || Array.from(this._state.keys()))) {
      if (!this._state.has(target)) continue;
      const targetRect = observedRect(target);
      const inter      = intersectRects(targetRect, rootRect);
      const targetArea = targetRect ? targetRect.width * targetRect.height : 0;
      const isIntersecting = !!inter;
      // A zero-area target that IS inside the root counts as fully intersecting (ratio 1), which is
      // how a collapsed sentinel `<div>` — the load-more pattern — reports.
      const ratio = !isIntersecting ? 0 : (targetArea > 0 ? (inter.width * inter.height) / targetArea : 1);
      const index = isIntersecting ? this._thresholds.filter((t) => t <= ratio).length : 0;
      if (index === this._state.get(target)) continue;   // no threshold crossed → no notification
      this._state.set(target, index);
      entries.push({
        target,
        time:               (globalThis.performance && globalThis.performance.now()) || 0,
        rootBounds:         rectOrNull(rootRect),
        boundingClientRect: rectOrNull(targetRect) || new globalThis.DOMRectReadOnly(0, 0, 0, 0),
        intersectionRect:   rectOrNull(inter) || new globalThis.DOMRectReadOnly(0, 0, 0, 0),
        isIntersecting,
        intersectionRatio:  ratio
      });
    }
    if (!entries.length) return;
    try { this._cb(entries, this); } catch (e) { logThrew('IntersectionObserver cb', e); }
  }
}

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
  for (const io of Array.from(activeIOs)) io._update(null);
}

// A scroll / DOM mutation asks for a rendering update, the way it does in a
// browser: raise the pending flag; the render phase of the next step delivers.
export function scheduleIntersectionUpdate() {
  if (activeIOs.size === 0) return;
  requestIntersectionUpdate();
}
globalThis.__csimScheduleIntersectionUpdate = scheduleIntersectionUpdate;
globalThis.__recheckIntersectionObservers = updateIntersectionObservations;

globalThis.IntersectionObserver = IntersectionObserver;
globalThis.ResizeObserver       = class extends StubObserver {};

// PerformanceObserver — apps subscribe to performance entries.
// `observe({entryTypes:['measure']})` / `disconnect()` / `takeRecords()`
// shapes match spec. The bridge fires entries through
// `__csimDeliverPerfEntries` whenever performance.mark / measure
// records new entries; without observers nothing is recorded.
const _perfObservers = new Set();
class PerformanceObserverImpl {
  constructor(cb) {
    this._cb        = cb;
    this._entryTypes = new Set();
    this._records    = [];
  }
  observe(opts) {
    const supported = PerformanceObserverImpl.supportedEntryTypes;
    if (opts && Array.isArray(opts.entryTypes)) {
      if (opts.type !== undefined) throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and type arguments.");
      for (const t of opts.entryTypes) if (supported.includes(String(t))) this._entryTypes.add(String(t));
      if (this._entryTypes.size === 0) return;              // nothing supported: a no-op (spec)
    } else if (opts && typeof opts.type === 'string') {
      if (!supported.includes(opts.type)) return;
      this._entryTypes.add(opts.type);
      // `buffered`: the entries already in the performance entry buffer of that type are
      // delivered too — how a page observes the resources it loaded before it subscribed.
      if (opts.buffered && typeof globalThis.__csimBufferedPerfEntries === 'function') {
        for (const e of globalThis.__csimBufferedPerfEntries(opts.type)) this._records.push(e);
        if (this._records.length) this._schedule();
      }
    } else {
      throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and type arguments.");
    }
    _perfObservers.add(this);
  }
  disconnect()  { _perfObservers.delete(this); this._records = []; }
  takeRecords() { const r = this._records; this._records = []; return r; }
  // One callback per turn for everything queued — a TASK on the performance timeline task
  // source (Chrome: a `Promise.then` queued after `mark()` runs before the observer).
  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    globalThis.setTimeout(() => {
      this._scheduled = false;
      const taken = this._records;
      this._records = [];
      if (!taken.length) return;
      try { this._cb(new PerformanceObserverEntryList(taken), this); } catch (_) {}
    }, 0);
  }
}
PerformanceObserverImpl.supportedEntryTypes = ['mark', 'measure', 'resource'];
globalThis.PerformanceObserver = PerformanceObserverImpl;
class PerformanceObserverEntryList {
  constructor(entries) { this._entries = entries; }
  getEntries()                 { return this._entries.slice(); }
  getEntriesByType(type)       { return this._entries.filter((e) => e.entryType === type); }
  getEntriesByName(name, type) { return this._entries.filter((e) => e.name === String(name) && (type === undefined || e.entryType === type)); }
}
globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;

// Called by performance.mark / measure / a resource load when a new entry lands.
globalThis.__csimDeliverPerfEntry = function (entry) {
  if (_perfObservers.size === 0) return;
  for (const obs of Array.from(_perfObservers)) {
    if (!obs._entryTypes.has(entry.entryType)) continue;
    obs._records.push(entry);
    obs._schedule();
  }
};

