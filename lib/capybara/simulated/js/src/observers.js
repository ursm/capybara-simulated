import { logThrew }                    from './console.js';
import { observedRect, viewportSize, layoutGeneration } from './layout.js';
import { NODE_ELEMENT }                from './constants.js';

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
    // The initial notification is a task of its own, so a callback never runs inside `observe()`.
    const self = this;
    Promise.resolve().then(() => self._update([target]));
  }
  unobserve(target) {
    this._state.delete(target);
    if (this._state.size === 0) activeIOs.delete(this);
  }
  disconnect() {
    this._state.clear();
    activeIOs.delete(this);
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
  scheduled = false;
  if (activeIOs.size === 0) return;
  const gen = layoutGeneration();
  if (gen === lastGeneration) return;
  lastGeneration = gen;
  for (const io of Array.from(activeIOs)) io._update(null);
}

// A scroll asks for a rendering update, the way it does in a browser. The driver's settle loop only
// runs a loop step when something is pending, so a scroll with no timers behind it would otherwise
// never reach the update above — and a sentinel scrolled into view would never fire. Queued as a
// microtask (once per turn) rather than run inside the scroll setter: the callback then runs after
// the script that scrolled, not re-entrantly in the middle of it.
let scheduled = false;
export function scheduleIntersectionUpdate() {
  if (scheduled || activeIOs.size === 0) return;
  scheduled = true;
  Promise.resolve().then(updateIntersectionObservations);
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
    if (opts && Array.isArray(opts.entryTypes)) {
      for (const t of opts.entryTypes) this._entryTypes.add(String(t));
    } else if (opts && typeof opts.type === 'string') {
      this._entryTypes.add(opts.type);
    }
    _perfObservers.add(this);
  }
  disconnect()  { _perfObservers.delete(this); this._records = []; }
  takeRecords() { const r = this._records; this._records = []; return r; }
}
PerformanceObserverImpl.supportedEntryTypes = ['mark', 'measure'];
globalThis.PerformanceObserver = PerformanceObserverImpl;

// Called by performance.mark / measure when a new entry lands.
globalThis.__csimDeliverPerfEntry = function (entry) {
  if (_perfObservers.size === 0) return;
  for (const obs of Array.from(_perfObservers)) {
    if (!obs._entryTypes.has(entry.entryType)) continue;
    obs._records.push(entry);
    const taken = obs._records;
    obs._records = [];
    Promise.resolve().then(() => {
      try { obs._cb({ getEntries: () => taken, getEntriesByName: () => taken, getEntriesByType: () => taken }, obs); }
      catch (_) {}
    });
  }
};

