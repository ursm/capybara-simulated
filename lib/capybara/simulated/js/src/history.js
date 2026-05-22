// History API — pushState / replaceState mirror the URL + state onto
// Ruby's `@history` so back/forward traversal can fire the spec's
// same-document `popstate` (within a chain of pushState entries) or
// fall through to a real navigation (when crossing a visit boundary).
// `history.back()` / `forward()` / `go(delta)` route through
// `__historyGo`; the Ruby side decides traversal kind, updates the
// URL on same-document, and asks us to dispatch `popstate` here.

import { PopStateEvent } from './events.js';

let _state = null;
// Approximate: real browsers trim the forward tail on push-after-back,
// which we'd need a Ruby round-trip to mirror. Increment on push is
// correct on the common forward-only path and overcounts only in the
// niche back+push pattern; apps rarely read this.
let _length = 1;

function applyHistoryUrl(state, url, push) {
  _state = state === undefined ? null : state;
  const target = url == null ? (globalThis.location && globalThis.location.href) : String(url);
  if (push) {
    if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(target, _state);
    _length += 1;
  } else if (typeof globalThis.__setCurrentUrl === 'function') {
    globalThis.__setCurrentUrl(target, _state);
  }
  if (url != null && typeof globalThis.__csimUpdateLocation === 'function') {
    globalThis.__csimUpdateLocation(target);
  }
}

export const history = {
  get length() { return _length; },
  get state()  { return _state;  },
  scrollRestoration: 'auto',
  pushState(state, _title, url)    { applyHistoryUrl(state, url, true); },
  replaceState(state, _title, url) { applyHistoryUrl(state, url, false); },
  back()         { if (typeof globalThis.__historyGo === 'function') globalThis.__historyGo(-1); },
  forward()      { if (typeof globalThis.__historyGo === 'function') globalThis.__historyGo(+1); },
  go(delta = 0)  {
    const d = Number(delta) | 0;
    if (d === 0) {
      if (typeof globalThis.__locationReload === 'function') globalThis.__locationReload();
      return;
    }
    if (typeof globalThis.__historyGo === 'function') globalThis.__historyGo(d);
  }
};

// Called by Ruby after a same-document traversal. Updates the JS-side
// state slot to match the popped entry, then fires `popstate` on the
// global per HTML spec.
globalThis.__csimDispatchPopState = function (state) {
  _state = state === undefined ? null : state;
  try {
    globalThis.dispatchEvent(new PopStateEvent('popstate', { state: _state }));
  } catch (_) {}
};

globalThis.history = history;
