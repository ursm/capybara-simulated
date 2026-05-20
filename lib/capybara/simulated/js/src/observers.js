// Layout-driven observer stubs.
//
// `CsimStubObserver` — apps construct ResizeObserver / PerformanceObserver
// at module init time (Turbo's FrameController is the canonical case);
// they expect the constructor to succeed and `observe()` to be a no-op
// when there's no layout. `takeRecords()` returns empty so dirty-tracking
// code doesn't loop.
//
// `IntersectionObserver` — eager: fires `isIntersecting: true` for any
// observed element the visibility check ("true unless something says
// hidden") accepts. No layout engine means anything not explicitly
// hidden is treated as in-viewport. Turbo's lazy `<turbo-frame>`s and
// Stimulus's lazy-load patterns rely on the observer firing to start
// their fetches — with a no-op stub, lazy turbo-frames never load
// their `src` and `has_many` / `has_and_belongs_to_many` /
// `comments_frame` assertions all see the "Loading…" placeholder
// forever.
//
// `__activeIOs` tracks IOs whose `_observed` set still has targets
// that haven't fired yet, so `__recheckIntersectionObservers` can
// retry on visibility transitions (Avo tabs reveal hidden panes by
// removing the `.hidden` class — the IO observe()'d the frame while
// hidden, and without a re-check the lazy frame would never load).

class CsimStubObserver {
  constructor(cb) { this._cb = cb; }
  observe()       {}
  unobserve()     {}
  disconnect()    {}
  takeRecords()   { return []; }
}

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
    if (typeof globalThis.__isVisibleNode === 'function' && !globalThis.__isVisibleNode(target)) return;
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
      try { console.error('[csim] IntersectionObserver cb threw:', e && e.message); } catch (_) {}
    }
  }
}

// Re-fire pending IO targets whose visibility may have changed.
// Called after each mutation batch (deliverMutations) so a `.hidden`
// class removal on a tab pane triggers the lazy `<turbo-frame>`
// inside it without us having to re-observe.
function recheckIntersectionObservers() {
  if (activeIOs.size === 0) return;
  for (const io of Array.from(activeIOs)) {
    for (const target of Array.from(io._observed)) {
      io._maybeFire(target);
    }
  }
}

globalThis.IntersectionObserver           = IntersectionObserver;
globalThis.ResizeObserver                 = class extends CsimStubObserver {};
globalThis.PerformanceObserver            = class extends CsimStubObserver {};
globalThis.__recheckIntersectionObservers = recheckIntersectionObservers;
