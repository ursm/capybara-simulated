// History API — pushState / replaceState record the URL + state in the
// page's joint session history (session_history.rs, the page's and its
// frames') so back/forward traversal can fire the spec's same-document
// `popstate` (within a chain of pushState entries) or fall through to a
// real navigation (when crossing a visit boundary). `history.back()` /
// `forward()` / `go(delta)` route through `__historyGo` — a frame's as
// the page's: they traverse the one history; the host decides each
// navigable's traversal kind, updates its URL on same-document, and asks
// us to dispatch `popstate` here.

import { PopStateEvent } from './events.js';
import { fireEvent } from './dispatch.js';
import { installHistory } from './generated/bindings.js';
import { apiBaseURL, cloneFor } from './platform-globals.js';
import { parseURL } from './url-parse.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import { queueTask } from './timers.js';
import { DOMException } from './dom-exception.js';

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

// The realm whose `history` it is — of the page (0), of a frame of it, or of another traversable's document.
const realmId = () => (typeof globalThis.__csimRealmId === 'function' ? globalThis.__csimRealmId() : 0);

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
  if (push) {
    if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(target, state, realmId());
  } else if (typeof globalThis.__setCurrentUrl === 'function') {
    globalThis.__setCurrentUrl(target, state, realmId());
  }
  if (url !== null && typeof globalThis.__csimUpdateLocation === 'function') {
    globalThis.__csimUpdateLocation(target, true);
  }
}

// …and its traversals: `go(0)` a reload of the browsing context (HTML) — through location.reload(), which reloads THIS
// context (the owning frame in a nested realm, so a controlling SW sees isReloadNavigation) — any other delta a
// traversal of its session history, a task of its own (HTML "traverse the history by a delta" appends it to the
// traversable's session history traversal queue, which runs in parallel and queues the step's application back): a
// same-document one's `popstate` after the script that asked, its microtasks and every task due as it ends — a timer
// it set after too (Chrome and Firefox, measured 2026-10-24 in real time: after, micro, t0, pop; Chrome under virtual
// time runs it before the timer).
function traverse(delta) {
  if (delta === 0) {
    if (globalThis.location && typeof globalThis.location.reload === 'function') globalThis.location.reload();
    else if (typeof globalThis.__locationReload === 'function') globalThis.__locationReload();
    return;
  }
  if (typeof globalThis.__historyGo !== 'function') return;
  // (…the host's queue, which the driver applies ahead of a navigation planned with it, should it take what the page
  // planned before the task runs)
  // (…its task's delay the host's to say: none where it makes a document again, a turn where it moves within them)
  const [token, delay] = globalThis.__historyGo(delta, realmId());
  if (token) queueTask(() => globalThis.__csimApplyTraversal(token), delay);
}
installHistory(History, {
  // (…the steps of the page's session history, its frames' included: a push after a back drops the forward ones)
  get_length: () => (typeof globalThis.__historyLength === 'function' ? globalThis.__historyLength(realmId()) : 1),
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

