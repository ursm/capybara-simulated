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

// IOs whose `_observed` set still has targets that haven't fired
// yet, so `recheckIntersectionObservers` can retry on visibility
// transitions (Avo tabs reveal hidden panes by removing the `.hidden`
// class — the IO observe()'d the frame while hidden, and without a
// re-check the lazy frame would never load).
const activeIOs = new Set();

class IntersectionObserver {
  constructor(cb) {
    this._cb       = cb;
    this._observed = new Set();
    // Tracking which observed targets have already fired
    // isIntersecting=true. Real browsers re-fire whenever intersection
    // state changes; we approximate by holding targets in `_observed`
    // and gating per-target on `_fired` so mutation-driven rechecks
    // don't spuriously re-fire the same target, but explicit user-
    // scroll signals (`forceRefire`) can clear it.
    this._fired    = new Set();
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
    this._fired.delete(target);
    if (this._observed.size === 0) activeIOs.delete(this);
  }
  disconnect() {
    this._observed.clear();
    this._fired.clear();
    activeIOs.delete(this);
  }
  takeRecords() { return []; }
  _maybeFire(target) {
    if (!this._observed.has(target)) return;
    if (this._fired.has(target)) return;
    if (!globalThis.__isLaidOutNode(target)) return;
    this._fired.add(target);
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

// Re-fire pending IO targets whose visibility may have changed.
// Called after each mutation batch (deliverMutations) so a `.hidden`
// class removal on a tab pane triggers the lazy `<turbo-frame>`
// inside it without us having to re-observe.
export function recheckIntersectionObservers() {
  if (activeIOs.size === 0) return;
  for (const io of Array.from(activeIOs)) {
    for (const target of Array.from(io._observed)) {
      io._maybeFire(target);
    }
  }
}

// Force re-fire of all observed targets across active IOs. Called by
// `scrollIntoView` (and similar explicit-scroll APIs) — without a real
// viewport we can't observe "the sentinel just scrolled into view",
// but the user-initiated scroll signal is itself the cue that
// pagination patterns rely on. Without this, DLoadMore's sentinel
// fires once on observe and never again, so `scroll_to_last_item`
// helpers in Discourse tests don't trigger a second fetch.
export function forceRefireIntersectionObservers() {
  if (activeIOs.size === 0) return;
  for (const io of Array.from(activeIOs)) {
    io._fired.clear();
    for (const target of Array.from(io._observed)) {
      io._maybeFire(target);
    }
  }
}
globalThis.__forceRefireIntersectionObservers = forceRefireIntersectionObservers;

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
// Mutation-batch hook so visibility transitions (a hidden tab pane
// becoming visible) retrigger pending IO targets without re-observe.
// Without this slot the `typeof === 'function'` gate in
// mutation-observer.js / bridge.entry.js falls false and IO recheck
// only fires on timer drains, missing Promise-paced reveal chains.
globalThis.__recheckIntersectionObservers = recheckIntersectionObservers;
