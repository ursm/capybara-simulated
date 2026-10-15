// History API — pushState / replaceState mirror the URL + state onto
// Ruby's `@history` so back/forward traversal can fire the spec's
// same-document `popstate` (within a chain of pushState entries) or
// fall through to a real navigation (when crossing a visit boundary).
// `history.back()` / `forward()` / `go(delta)` route through
// `__historyGo`; the Ruby side decides traversal kind, updates the
// URL on same-document, and asks us to dispatch `popstate` here.

import { PopStateEvent } from './events.js';
import { fireEvent } from './dispatch.js';
import { installHistory } from './generated/bindings.js';
import { apiBaseURL, cloneFor } from './platform-globals.js';
import { parseURL } from './url-parse.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// History (HTML §7.4.2), generated from its IDL — made by the platform alone, the window's `history`. Its slots: the
// classic history API state of its document's current entry (a copy of what pushState / replaceState was given, or
// what a traversal restored) and its scroll restoration mode.
const historyOf = (o) => slotsOf(o, 'History');
registerInterface('History', (o) => historyOf(o) !== undefined);
class History {
  constructor(token) {
    constructedBy(PLATFORM, token, 'History');
    makeSlots(this, 'History', { state: null, scrollRestoration: 'auto' });
  }
}

// HTML "shared history push/replace state steps": the state serialized — a copy, a DataCloneError for what cannot be
// (StructuredSerializeForStorage) — and the URL, given one (not null, nor the empty string, which keep the document's
// own, its fragment too), parsed against the document's base URL and one it can have
// its own rewritten to (url_ops.rs `can_rewrite`: of its origin, and on a non-HTTP(S) one differing in its fragment
// alone) — a SecurityError otherwise; then the entry pushed, or the current one replaced, with them.
function pushOrReplaceState(history, data, url, push) {
  const method = push ? 'pushState' : 'replaceState';
  const state = cloneFor(`Failed to execute '${method}' on 'History': `, data);
  const here = (globalThis.location && globalThis.location.href) || '';
  let target = here;
  if (url !== null && url !== '') {
    const parsed = parseURL(url, apiBaseURL())?.href ?? null;
    if (parsed === null || !globalThis.__dom.urlCanRewrite(here, parsed)) {
      throw new DOMException(
        `Failed to execute '${method}' on 'History': A history state object with URL '${parsed ?? url}' cannot be created in a document with origin '${globalThis.location.origin}' and URL '${here}'.`,
        'SecurityError'
      );
    }
    target = parsed;
  }
  historyOf(history).state = state;
  // Which browsing context is pushing — a frame's session history is its own, and mirroring
  // its pushState onto the TOP document's would make `current_url` report a URL no window
  // is at (an iframe'd SPA is exactly this shape).
  const realmId = typeof globalThis.__csimRealmId === 'function' ? globalThis.__csimRealmId() : 0;
  if (push) {
    if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(target, state, realmId);
  } else if (typeof globalThis.__setCurrentUrl === 'function') {
    globalThis.__setCurrentUrl(target, state, realmId);
  }
  if (url !== null && typeof globalThis.__csimUpdateLocation === 'function') {
    globalThis.__csimUpdateLocation(target, true);
  }
}

// A nested browsing context (iframe) traverses its OWN session history, not the
// top document's. Route back/forward/go(±n) to the frame-aware host fn, keyed by
// this realm's id; returns false when not in a frame so the caller falls back to
// the top-document `__historyGo`.
function frameHistoryGo(delta) {
  if (!(globalThis.__csimTop && globalThis.__csimTop !== globalThis &&
        typeof globalThis.__csimFrameHistoryGo === 'function')) {
    return false;
  }
  let realmId = 0;
  try { realmId = globalThis.RustyRacer.contextOf(globalThis) || 0; } catch (_) { return false; }
  if (!realmId) return false;
  globalThis.__csimFrameHistoryGo(realmId, delta);
  return true;
}

// …and its traversals: `go(0)` a reload of the browsing context (HTML) — through location.reload(), which reloads THIS
// context (the owning frame in a nested realm, so a controlling SW sees isReloadNavigation) — any other delta a
// traversal of its session history.
function traverse(delta) {
  if (delta === 0) {
    if (globalThis.location && typeof globalThis.location.reload === 'function') globalThis.location.reload();
    else if (typeof globalThis.__locationReload === 'function') globalThis.__locationReload();
    return;
  }
  if (!frameHistoryGo(delta) && typeof globalThis.__historyGo === 'function') globalThis.__historyGo(delta);
}
installHistory(History, {
  // (…sourced from Ruby's `@history`, so it reflects the forward-tail truncation a push-after-back does)
  get_length: () => (typeof globalThis.__historyLength === 'function' ? globalThis.__historyLength() : 1),
  get_scrollRestoration: (history) => historyOf(history).scrollRestoration,
  set_scrollRestoration: (history, mode) => { historyOf(history).scrollRestoration = mode; },
  get_state: (history) => historyOf(history).state,
  go: (_history, delta) => traverse(delta),
  back: () => traverse(-1),
  forward: () => traverse(+1),
  pushState: (history, data, _unused, url) => pushOrReplaceState(history, data, url, true),
  replaceState: (history, data, _unused, url) => pushOrReplaceState(history, data, url, false)
});
globalThis.History = History;

export const history = new History(PLATFORM);
// …and its classic history API state made `state`: a fragment navigation's new entry has none (HTML "navigate to a
// fragment"), a traversal restores its entry's.
export function setHistoryState(state) {
  historyOf(history).state = state === undefined ? null : state;
}
globalThis.__csimSetHistoryState = setHistoryState;

// Called by Ruby after a same-document traversal. Updates the JS-side
// state slot to match the popped entry, then fires `popstate` on the
// global per HTML spec.
globalThis.__csimDispatchPopState = function (state) {
  setHistoryState(state);
  try {
    fireEvent(globalThis, new PopStateEvent('popstate', { state: historyOf(history).state }));
  } catch (_) {}
};

