import { logThrew } from './console.js';

// Layout-driven observer stubs. ResizeObserver / PerformanceObserver
// are no-ops (the `StubObserver` shape). IntersectionObserver is
// eager: fires `isIntersecting: true` for any observed element that
// the visibility check accepts. Turbo lazy `<turbo-frame>`s and
// Stimulus's lazy-load patterns rely on the observer firing to start
// their fetches — with a pure no-op, lazy turbo-frames never load
// their `src` and `has_many` / `has_and_belongs_to_many` /
// `comments_frame` assertions all see the "Loading…" placeholder.

class StubObserver {
  constructor(cb) { this._cb = cb; }
  observe()       {}
  unobserve()     {}
  disconnect()    {}
  takeRecords()   { return []; }
}

// Every active IO keeps its observed targets in `_observed` for its
// whole lifetime — real browsers don't auto-remove on first fire.
// Each target tracks the last `recheckVersion` it fired at; the
// global version bumps whenever a recheck trigger fires (scroll,
// post-mutation drain, etc.), so a previously-fired target re-fires
// when its viewport-equivalent has plausibly changed. Without this
// behavior, Discourse's `DLoadMore` (scroll-bottom triggers more
// rows) would fire exactly once at first observe and then stay
// silent forever — there is no "viewport changed" signal to re-fire
// because the scroll didn't trigger a DOM mutation.
const activeIOs = new Set();
let recheckVersion = 0;

class IntersectionObserver {
  constructor(cb) {
    this._cb           = cb;
    this._observed     = new Set();
    this._lastFireVer  = new Map();
  }
  observe(target) {
    if (!target || this._observed.has(target)) return;
    this._observed.add(target);
    activeIOs.add(this);
    const self = this;
    Promise.resolve().then(() => self._maybeFire(target));
  }
  unobserve(target) {
    this._observed.delete(target);
    this._lastFireVer.delete(target);
    if (this._observed.size === 0) activeIOs.delete(this);
  }
  disconnect() {
    this._observed.clear();
    this._lastFireVer.clear();
    activeIOs.delete(this);
  }
  takeRecords() { return []; }
  _maybeFire(target) {
    if (!this._observed.has(target)) return;
    if (!globalThis.__isLaidOutNode(target)) return;
    if (this._lastFireVer.get(target) === recheckVersion) return;
    this._lastFireVer.set(target, recheckVersion);
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    try {
      this._cb([{
        target,
        isIntersecting:     true,
        intersectionRatio:  1,
        boundingClientRect: rect,
        intersectionRect:   rect,
        rootBounds:         rect,
        time:               0
      }], this);
    } catch (e) {
      logThrew('IntersectionObserver cb', e);
    }
  }
}

// Re-fire IO targets when the viewport-equivalent state could have
// changed: post-mutation drain, scroll events, etc. Bumps the
// recheck version so each currently-observed target gets one fresh
// fire even if it had already fired at the previous version.
export function recheckIntersectionObservers() {
  recheckVersion = (recheckVersion + 1) | 0;
  if (activeIOs.size === 0) return;
  for (const io of Array.from(activeIOs)) {
    for (const target of Array.from(io._observed)) {
      io._maybeFire(target);
    }
  }
}

globalThis.IntersectionObserver = IntersectionObserver;
// Test-only probe: count of currently-observed targets across all IOs.
globalThis.__csim_io_observed_count = () => {
  let n = 0;
  for (const io of activeIOs) n += io._observed.size;
  return n;
};
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
// Mutation-batch hook so visibility transitions (a hidden tab pane
// becoming visible) retrigger pending IO targets without re-observe.
// Without this slot the `typeof === 'function'` gate in
// mutation-observer.js / bridge.entry.js falls false and IO recheck
// only fires on timer drains, missing Promise-paced reveal chains.
globalThis.__recheckIntersectionObservers = recheckIntersectionObservers;
