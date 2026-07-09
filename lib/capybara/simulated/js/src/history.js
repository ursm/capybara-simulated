// History API — pushState / replaceState mirror the URL + state onto
// Ruby's `@history` so back/forward traversal can fire the spec's
// same-document `popstate` (within a chain of pushState entries) or
// fall through to a real navigation (when crossing a visit boundary).
// `history.back()` / `forward()` / `go(delta)` route through
// `__historyGo`; the Ruby side decides traversal kind, updates the
// URL on same-document, and asks us to dispatch `popstate` here.

import { PopStateEvent } from './events.js';

let _state = null;
// `history.length` is sourced from Ruby's `@history` (via the host fn)
// so it reflects the forward-tail truncation a push-after-back does.

function applyHistoryUrl(state, url, push) {
  _state = state === undefined ? null : state;
  const target = url == null ? (globalThis.location && globalThis.location.href) : String(url);
  if (push) {
    if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(target, _state);
  } else if (typeof globalThis.__setCurrentUrl === 'function') {
    globalThis.__setCurrentUrl(target, _state);
  }
  if (url != null && typeof globalThis.__csimUpdateLocation === 'function') {
    globalThis.__csimUpdateLocation(target);
  }
}

// A nested browsing context (iframe) traverses its OWN session history, not the
// top document's. Route back/forward/go(±n) to the frame-aware host fn, keyed by
// this realm's id; returns false when not in a frame so the caller falls back to
// the top-document `__historyGo`.
function frameHistoryGo(delta) {
  if (!(globalThis.top && globalThis.top !== globalThis &&
        globalThis.RustyRacer && typeof globalThis.RustyRacer.contextOf === 'function' &&
        typeof globalThis.__csimFrameHistoryGo === 'function')) {
    return false;
  }
  let realmId = 0;
  try { realmId = globalThis.RustyRacer.contextOf(globalThis) || 0; } catch (_) { return false; }
  if (!realmId) return false;
  globalThis.__csimFrameHistoryGo(realmId, delta);
  return true;
}

export const history = {
  get length() {
    return typeof globalThis.__historyLength === 'function' ? globalThis.__historyLength() : 1;
  },
  get state()  { return _state;  },
  scrollRestoration: 'auto',
  pushState(state, _title, url)    { applyHistoryUrl(state, url, true); },
  replaceState(state, _title, url) { applyHistoryUrl(state, url, false); },
  back()         { if (!frameHistoryGo(-1) && typeof globalThis.__historyGo === 'function') globalThis.__historyGo(-1); },
  forward()      { if (!frameHistoryGo(+1) && typeof globalThis.__historyGo === 'function') globalThis.__historyGo(+1); },
  go(delta = 0)  {
    const d = Math.trunc(Number(delta)) || 0;
    if (d === 0) {
      // `history.go(0)` is a RELOAD of the current browsing context (HTML). Delegate to
      // location.reload(), which reloads THIS context — the owning frame in a nested realm
      // (so a controlling SW sees isReloadNavigation), the top page otherwise.
      if (globalThis.location && typeof globalThis.location.reload === 'function') globalThis.location.reload();
      else if (typeof globalThis.__locationReload === 'function') globalThis.__locationReload();
      return;
    }
    if (!frameHistoryGo(d) && typeof globalThis.__historyGo === 'function') globalThis.__historyGo(d);
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
