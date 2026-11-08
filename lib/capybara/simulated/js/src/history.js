// History API — pushState / replaceState record the URL + state in the session history of the document's top-level
// traversable (session_history.rs): the page's joint one, its frames' with it, or that of a window `window.open` made in
// this isolate — so back/forward traversal can fire the spec's same-document `popstate` (within a chain of pushState
// entries) or fall through to a real navigation (when crossing a visit boundary). `history.back()` / `forward()` /
// `go(delta)` append to that traversable's traversal queue (`historyTraverse`) — a frame's as the page's: they traverse
// the one history — whose task the engine applies (`applyTraversal`): a move within the top-level document updated here,
// a document made again — or a frame's — planned for the host.

import { PopStateEvent } from './events.js';
import { fireEvent } from './dispatch.js';
import { defineHistory } from './generated/bindings.js';
import { apiBaseURL, deserializeFromStorage, serializeForStorage } from './platform-globals.js';
import { parseURL } from './url-parse.js';
import { PLATFORM, slotsOf } from './webidl.js';
import { queueTask } from './timers.js';
import { DOMException } from './dom-exception.js';
import { documentOrigin, realmURL } from './document-origin.js';
import { reloadDocument } from './location.js';
import { dom, hostNamespace, listOf } from './engine.js';

// History (HTML §7.4.2), generated from its IDL — made by the platform alone, the window's `history`. Its slots: the
// classic history API state of its document's current entry (a copy of what pushState / replaceState was given, or
// what a traversal restored) and its scroll restoration mode.
const historyOf = (o) => slotsOf(o, 'History');

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
  const here = realmURL();
  let target = here;
  if (url !== null && url !== '') {
    const parsed = parseURL(url, apiBaseURL())?.href ?? null;
    if (parsed === null || !dom.urlCanRewrite(here, parsed)) {
      throw new DOMException(
        `Failed to execute '${method}' on 'History': A history state object with URL '${parsed ?? url}' cannot be created in a document with origin '${documentOrigin()}' and URL '${here}'.`,
        'SecurityError'
      );
    }
    target = parsed;
  }
  historyOf(history).state = deserializeFromStorage(serialized);
  // (…recorded in the session history of its document's traversable — a frame's as its own navigable's entries, which
  // the top-level document's URL is not: an iframe'd SPA's pushState moves no window's — none while the document is
  // being unloaded, its URL and state its own all the same: session_history.rs `historyUpdate`)
  dom.historyUpdate(target, serialized, push);
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
// (…`now`: none queued, the caller applying the queue at once — the driver's, with no script on the stack)
function traverse(delta, now = false) {
  if (delta === 0) {
    reloadDocument();
    return;
  }
  // (…the engine's queue, which the driver applies ahead of a navigation planned with it, should it take what the page
  // planned before the task runs)
  // (…its task's delay the engine's to say: none where it makes a document again, a turn where it moves within them —
  // on the event loop of the traversable's top-level document, a frame's asking or not, which may be gone by then)
  // (…`now` the driver's, the user's: its documents made by no document's request — session_history.rs `Queued::by_user`)
  const [token, delay, top] = dom.historyTraverse(delta, now);
  if (!token || now) return;
  const window = top === realmId() ? globalThis : hostNamespace.contextGlobal(top);
  window.__csimQueueTraversalTask(token, delay);
}
globalThis.__csimQueueTraversalTask = (token, delay) => queueTask(() => applyTraversal(token), delay);
// …its task: the traversal applied by the engine, each step that moves the top-level document within it updating it
// here — one that makes it again, or moves a frame, the host's, as the task ends (navigation_plan.rs `Traversal`,
// `FrameTraversal`).
// (…the top-level document's, whichever realm of its tree asked: a frame's `history` traverses its window's)
// (…`byHost`: applied by the host, which takes what it planned itself — no navigation turn to hand it over)
function applyTraversal(token, all = false, byHost = false) {
  const moves = dom.applyTraversal(token, all, byHost);
  if (moves === null) return;
  const window = moves[0] === realmId() ? globalThis : hostNamespace.contextGlobal(moves[0]);
  if (moves[1] && !byHost) globalThis.__csimQueueNavigationTurn();
  // (…each frame whose navigation it let go of finalized, its container's document's load delayed by it no more: as
  // frame-nav.js `frameNavigationFinalized`)
  for (const realm of moves[2]) {
    let g = null;
    try { g = hostNamespace.contextGlobal(realm); } catch (_) {}
    g?.__csimLoadBlockerSettled?.();
  }
  for (let i = 3; i < moves.length; i += 3) {
    const before = realmURL(window);
    window.__csimUpdateLocation(moves[i]);
    window.__csimDispatchPopState(moves[i + 1]);
    if (moves[i + 2]) window.__csimQueueHashChange(before, moves[i]);
  }
}
// …and the traversals of the windows of this isolate that make a document again, applied as the task that asked ends —
// each through its window's realm, every one it queued — as the host applies the page's (browser.rb
// `apply_planned_traversals_before_navigations`): the document each makes the host's then, its tasks finding none.
globalThis.__csimApplyWindowTraversals = () => {
  for (const w of listOf(dom.windowsTraversing())) hostNamespace.contextGlobal(w).__csimApplyOwnTraversals(false, false);
};
// (…`all` every one queued: the page's ahead of a navigation planned with them, and those after a traversal that waited,
// which the host applied first — browser.rb `traverse_navigables_of`)
// (…`byHost` false: one moving a frame handed over at the navigation turn, behind the tasks already due — the host's
// drain applying them ahead of the navigations planned with them, which waits for its turn as theirs do)
globalThis.__csimApplyOwnTraversals = (all = false, byHost = true) => applyTraversal(0, all, byHost);
// …and a task of their own again for those queued, whose tasks found them waiting on a traversal or a document since
// let go of — a flush's plan dropped (navigation_plan.rs `flushRestore`), a `javascript:` URL's document a location the
// flush planned replaced (browser.rb `commit_javascript_document`) — so none is left queued with no task to apply it.
globalThis.__csimRequeueTraversals = () => queueTask(() => applyTraversal(0, true));
// …and the page's planned for the host (navigation_plan.rs `takeTraversal`).
globalThis.__csimTakeTraversal = () => dom.takeTraversal();
// Every member of a History whose document is not fully active (a frame's removed, or navigated away from): a
// SecurityError, in the words of the member it is (HTML; the `length` getter's is the engine's: session_history.rs
// `historyLength`).
function fullyActive(words) {
  if (!dom.documentFullyActive()) {
    throw new DOMException(`${words}: May not use a History object associated with a Document that is not fully active`, 'SecurityError');
  }
}
const reading = (name) => `Failed to read the '${name}' property from 'History'`;
const running = (name) => `Failed to execute '${name}' on 'History'`;
const History = defineHistory({
  init(slots) {
    slots.state = null;
    slots.scrollRestoration = 'auto';
  },
  // (…the steps of the page's session history, its frames' included: a push after a back drops the forward ones)
  get_length: () => dom.historyLength(),
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
// …and the driver's traversal of the page or of a window of this isolate (Capybara's `go_back` / `go_forward` in it):
// its session history traversed by `delta` as its `history.go(delta)` would — the user's back button is that algorithm's
// too (HTML "traverse the history by a delta").
globalThis.__csimTraverseHistory = (delta, now = false) => traverse(delta, now);

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

