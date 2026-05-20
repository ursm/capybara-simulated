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
    if (this._observed.size === 0) activeIOs.delete(this);
  }
  disconnect() {
    this._observed.clear();
    activeIOs.delete(this);
  }
  takeRecords() { return []; }
  _maybeFire(target) {
    if (!this._observed.has(target)) return;
    if (!globalThis.__isVisibleNode(target)) return;
    this._observed.delete(target);
    if (this._observed.size === 0) activeIOs.delete(this);
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

globalThis.IntersectionObserver = IntersectionObserver;
globalThis.ResizeObserver       = class extends StubObserver {};
globalThis.PerformanceObserver  = class extends StubObserver {};
