// History API — pushState / replaceState record the URL + state in the session history of the document's top-level
// traversable (session_history.rs): the page's joint one, its frames' with it, or that of a window `window.open` made in
// this isolate — so back/forward traversal can fire the spec's same-document `popstate` (within a chain of pushState
// entries) or fall through to a real navigation (when crossing a visit boundary). `history.back()` / `forward()` /
// `go(delta)` append to that traversable's traversal queue (`historyTraverse`) — a frame's as the page's: they traverse
// the one history — whose task applies it: a window's here (`applyWindowTraversal`), the page's by the host, which
// decides each navigable's traversal kind, updates its URL on same-document, and asks us to dispatch `popstate` here.

import { PopStateEvent } from './events.js';
import { fireEvent } from './dispatch.js';
import { installHistory } from './generated/bindings.js';
import { apiBaseURL, deserializeFromStorage, serializeForStorage } from './platform-globals.js';
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

// HTML "shared history push/replace state steps": the state serialized — a DataCloneError for what cannot be
// (StructuredSerializeForStorage), the bytes the entry keeps, `history.state` a copy read back of them — and the URL,
// given one (not null, nor the empty string, which keep the document's own, its fragment too), parsed against the
// document's base URL and one it can have its own rewritten to (url_ops.rs `can_rewrite`: of its origin, and on a
// non-HTTP(S) one differing in its fragment alone) — a SecurityError otherwise; then the entry pushed, or the current
// one replaced, with them.
function pushOrReplaceState(history, data, url, push) {
  const method = push ? 'pushState' : 'replaceState';
  const serialized = serializeForStorage(data, `Failed to execute '${method}' on 'History': `);
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
  historyOf(history).state = deserializeFromStorage(serialized);
  // Which browsing context is pushing — a window of this isolate's its own traversable's (`windowHistoryUpdate`), a
  // frame's session history is its own, and mirroring its pushState onto the TOP document's would make `current_url`
  // report a URL no window is at (an iframe'd SPA is exactly this shape).
  if (globalThis.__dom.windowHistoryUpdate(target, serialized, push)) {
    // (…recorded)
  } else if (push) {
    if (typeof globalThis.__pushHistoryEntry === 'function') globalThis.__pushHistoryEntry(target, serialized, realmId());
  } else if (typeof globalThis.__setCurrentUrl === 'function') {
    globalThis.__setCurrentUrl(target, serialized, realmId());
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
    globalThis.location?.reload();
    return;
  }
  // (…the engine's queue, which the driver applies ahead of a navigation planned with it, should it take what the page
  // planned before the task runs)
  // (…its task's delay the engine's to say: none where it makes a document again, a turn where it moves within them)
  const [token, delay] = globalThis.__dom.historyTraverse(delta);
  if (token) queueTask(() => applyTraversal(token), delay);
}
// …its task: a window's traversal applied by the engine, each step that moves it within its document updating it here —
// one that makes it again the host's, as the task ends (navigation_plan.rs `Traversal`) — the page's by the host.
// (…the window's document's, whichever realm of its tree asked: a frame's `history` traverses its window's)
function applyTraversal(token) {
  const moves = globalThis.__dom.applyWindowTraversal(token);
  if (moves === null) {
    globalThis.__csimApplyTraversal(token);
    return;
  }
  const window = moves[0] === realmId() ? globalThis : globalThis.RustyRacer.contextGlobal(moves[0]);
  for (let i = 1; i < moves.length; i += 2) {
    const before = window.__csimLocationHref();
    window.__csimUpdateLocation(moves[i]);
    window.__csimDispatchPopState(moves[i + 1]);
    if (fragmentOf(before) !== fragmentOf(moves[i])) window.__csimQueueHashChange(before, moves[i]);
  }
}
// A URL's fragment — null where it has none, which an empty one is not.
const fragmentOf = (url) => {
  const at = url.indexOf('#');
  return at < 0 ? null : url.slice(at + 1);
};
// Every member of a History whose document is not fully active (a frame's removed, or navigated away from): a
// SecurityError, in the words of the member it is (HTML; the `length` getter's is the engine's: session_history.rs
// `historyLength`).
function fullyActive(words) {
  if (!globalThis.__dom.documentFullyActive()) {
    throw new DOMException(`${words}: May not use a History object associated with a Document that is not fully active`, 'SecurityError');
  }
}
const reading = (name) => `Failed to read the '${name}' property from 'History'`;
const running = (name) => `Failed to execute '${name}' on 'History'`;
installHistory(History, {
  // (…the steps of the page's session history, its frames' included: a push after a back drops the forward ones)
  get_length: () => globalThis.__dom.historyLength(),
  get_scrollRestoration: (history) => { fullyActive(reading('scrollRestoration')); return historyOf(history).scrollRestoration; },
  set_scrollRestoration: (history, mode) => {
    fullyActive("Failed to set the 'scrollRestoration' property on 'History'");
    historyOf(history).scrollRestoration = mode;
  },
  get_state: (history) => { fullyActive(reading('state')); return historyOf(history).state; },
  go: (_history, delta) => { fullyActive(running('go')); traverse(delta); },
  back: () => { fullyActive(running('back')); traverse(-1); },
  forward: () => { fullyActive(running('forward')); traverse(+1); },
  pushState: (history, data, _unused, url) => { fullyActive(running('pushState')); pushOrReplaceState(history, data, url, true); },
  replaceState: (history, data, _unused, url) => { fullyActive(running('replaceState')); pushOrReplaceState(history, data, url, false); }
});
globalThis.History = History;

export const history = new History(PLATFORM);
// …and its classic history API state made the one `serialized` holds (null for none): a fragment navigation's new entry
// has none (HTML "navigate to a fragment"), a traversal restores its entry's — null where it cannot be read back here
// (HTML "restore the history object state": StructuredDeserialize throwing).
export function setHistoryState(serialized) {
  let state = null;
  try {
    if (serialized != null) state = deserializeFromStorage(serialized);
  } catch (_) {}
  historyOf(history).state = state;
}
globalThis.__csimSetHistoryState = setHistoryState;
// …and a document a navigation of a window of this isolate made (v8_runtime.rb `create_window_realm`), `how` that
// navigation's entry (session_history.rs `commitWindowEntry`): its classic history API state its entry's, and the
// traversals queued on its window that the document it replaced had yet to run queued as tasks of this one.
globalThis.__csimCommitWindowEntry = function (url, how, step, referrer) {
  const state = globalThis.__dom.commitWindowEntry(String(url), String(how), step ?? 0, referrer ?? null);
  if (state !== undefined) setHistoryState(state);
  for (const token of globalThis.__dom.queuedWindowTraversals()) queueTask(() => applyTraversal(token), 0);
};
// (…whether realm `realm`'s `history` is the window's session history: session_history.rs `historyOfPage`)
globalThis.__csimHistoryOfPage = (realm) => globalThis.__dom.historyOfPage(realm);

// …a same-document traversal's (HTML "update document for history step application"): the state the entry it is at
// keeps, then `popstate` with it.
globalThis.__csimDispatchPopState = function (serialized) {
  setHistoryState(serialized);
  try {
    // (…its `state` the history's as it is, `undefined` too, which the event's init would make null)
    const event = new PopStateEvent('popstate');
    slotsOf(event, 'PopStateEvent').state = historyOf(history).state;
    fireEvent(globalThis, event);
  } catch (_) {}
};

