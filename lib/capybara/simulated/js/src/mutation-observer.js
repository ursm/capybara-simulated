// MutationObserver — per-observer record queues populated at mutation
// time. `disconnect()` cleanly drops that observer's pending queue,
// which Trix's render path relies on via
// `editorWillSyncDocumentView` / `…DidSyncDocumentView` — a
// global-queue-and-filter-at-delivery model violates that and loops
// Trix's reparse.
//
// An attribute write, a change of children and a `Text`'s data write are
// recorded by the engine (attributes.rs, mutation.rs, character_data.rs), the
// parser's as its build inserts (html_parse.rs). Delivery is
// scheduled as a microtask via `scheduleMutationDelivery` so MO
// callbacks fire after the current macrotask completes.
//
// The `settleGen` counter bumps on every observable DOM/URL change
// (regardless of whether an MO is watching). The Ruby side compares
// it across a `settle` call to yield on the first observable change,
// matching the "1 paint = 1 observable moment" semantics real
// browsers offer to polling helpers.

import { logThrew } from './console.js';
import { convertMutationObserverArguments, installMutationObserver, installMutationRecord } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { nodeList } from './dom-collections.js';
import {
  foreignRealmOf, relativeOf, RELATIVE_ROOT, REALM as NATIVE_REALM
} from './native-query-shadow.js';
import { setEdgeWrittenSteps } from './tree.js';

// MutationObserverInit's options, as the engine takes them (mutation_observers.rs).
const CHILD_LIST = 1, ATTRIBUTES = 2, CHARACTER_DATA = 4, SUBTREE = 8, ATTRIBUTE_OLD_VALUE = 16, CHARACTER_DATA_OLD_VALUE = 32;

// A stylesheet change under a SHADOW ROOT is invisible to the document cascade's content key
// (`rebuildCascade` early-returns unchanged), while the per-root scoped rules and every memo key
// on the cascade VERSION — so move that directly. A document-tree change goes through the
// scheduled rebuild, which moves the version itself when the key differs. Either is the realm's whose tree the node is
// in, whichever realm's code changed it (`REALM.refreshCascade`): a `<style>` a frame made, in the page, had its
// `media` switched by the frame's setter for the frame's cascade.
function stylesheetChanged(node) {
  (foreignRealmOf(node) ?? NATIVE_REALM).refreshCascade(relativeOf(node, RELATIVE_ROOT)?._isShadowRoot === true);
}

// A sheet owner obtains a new sheet (sheet_owners.rs: its count of them, which its engine sheet is made again for, and
// the faces it declares are keyed by: cascade.js `engineSheetOf`, `faceSource`) where HTML says — a `<style>`'s block
// updated, even to the same text, and an owner inserted or removed, however deep in the subtree that moved, a shadow tree
// included, which the engine counts as it writes the tree — or one of its attributes says (`sheetAttrChanged`); what a
// script edited of the one before is gone with it. A change of the tree that renewed one asks for the cascade with its
// record (mutation.rs `record_child_list`).
// A `<link>`'s or `<style>`'s attribute that selects or obtains its sheet — HTML's attribute change steps, so here, where
// every write arrives (`setAttribute` / `setAttributeNS`, an `Attr`'s value, `attributes.setNamedItem`, a removal),
// rather than in `setAttribute` alone: the others left `<style media=print>` switched to `screen` applying nothing.
// Which attributes those are, and which of them obtain the owner a new sheet — a `<link>`'s `disabled` (its removal
// making it explicitly enabled), `rel`, `href` or `type`, a `<style>`'s `type` — is the engine's, as it stores the
// attribute (attributes.rs `STEP_SHEET`); `media` / `title` only re-select the sheet (which set it is in, whether its
// query holds), and the sheet's media list follows the attribute on the same sheet object, as Chrome's
// `sheet.media.mediaText` does. A `<link>` whose resource may be another (or newly a stylesheet: `linkResource`) is
// fetched again, its `load` fired (`maybeFireLinkLoad`). A shadow tree's sheet re-selects through the route its text
// edits take (`stylesheetChanged`), which the document's refresh alone never reached.
export function sheetAttrChanged(el, name, value, linkResource) {
  // (…its sheet's `media` and `title` follow the attribute on the same sheet object, while the owner has it)
  const sheet = el._sheet;
  if (sheet && name === 'media') sheet.media.mediaText = value == null ? '' : value;
  else if (sheet && name === 'title') slotsOf(sheet, 'CSSStyleSheet').title = value || null;
  stylesheetChanged(el);
  if (linkResource && globalThis.__csim_linkResourceChanged) globalThis.__csim_linkResourceChanged(el);
}

// A MutationRecord (DOM §4.3.5), generated from its IDL: no page constructs one; the records an observer is handed are
// objects of its prototype whose state is their internal slots (`recordState`) — the nodes added and removed arrays,
// each a static NodeList the first time it is asked for ([SameObject]).
export class MutationRecord {
  constructor() { throw new TypeError('Illegal constructor'); }
}
const recordState = (rec) => slotsOf(rec, 'MutationRecord');
registerInterface('MutationRecord', (o) => recordState(o) !== undefined);
installMutationRecord(MutationRecord, {
  get_type: (rec) => recordState(rec).type,
  get_target: (rec) => recordState(rec).target,
  get_addedNodes(rec) {
    const state = recordState(rec);
    return state.addedList || (state.addedList = nodeList(state.addedNodes));
  },
  get_removedNodes(rec) {
    const state = recordState(rec);
    return state.removedList || (state.removedList = nodeList(state.removedNodes));
  },
  get_previousSibling: (rec) => recordState(rec).previousSibling,
  get_nextSibling: (rec) => recordState(rec).nextSibling,
  get_attributeName: (rec) => recordState(rec).attributeName,
  get_attributeNamespace: (rec) => recordState(rec).attributeNamespace,
  get_oldValue: (rec) => recordState(rec).oldValue
});
const RECORD_PROTO = MutationRecord.prototype;
const NONE = Object.freeze([]);
// (…of a record as the engine queued it — `[type, target, addedNodes, removedNodes, previousSibling, nextSibling,
// attributeName, attributeNamespace, oldValue]` — its old value where the observer asked for it)
const RECORD_TYPES = ['childList', 'attributes', 'characterData'];
function mutationRecord(r, withOldValue) {
  const rec = Object.create(RECORD_PROTO);
  makeSlots(rec, 'MutationRecord', {
    type:               RECORD_TYPES[r[0]],
    target:             r[1],
    addedNodes:         r[2] || NONE,
    removedNodes:       r[3] || NONE,
    previousSibling:    r[4] || null,
    nextSibling:        r[5] || null,
    attributeName:      r[6] ?? null,
    attributeNamespace: r[7] ?? null,
    oldValue:           withOldValue ? r[8] ?? null : null,
    addedList:          null,
    removedList:        null
  });
  return rec;
}
// …and the records the engine handed over (`moTakeRecords`: `[record, takesOldValue, …]`).
function mutationRecords(taken) {
  const out = [];
  for (let i = 0; i < taken.length; i += 2) out.push(mutationRecord(taken[i], taken[i + 1]));
  return out;
}

// The observers observing, by their number (the engine's — mutation_observers.rs, which keeps every node's registered
// observer list, each observer's record queue and which are pending): an observer is here from its first `observe` to
// its `disconnect`.
const observers = new Map();
// The agent's own state, which every realm's bindings share (mutation_observers.rs `moFlags`): whether any node has a
// registered observer — any realm's, whichever realm's script makes the change — whether the agent's mutation observer
// microtask is queued and observers being notified, whether anything is pending, and what a change the engine made asks
// of the bindings (`engineWritten`). Its pending observers and signal slots are the engine's to list, by realm
// (`moTakePending`); one notification takes them all.
const ANY_REGISTERED = 0, MICROTASK_QUEUED = 1, NOTIFYING = 2, PENDING = 3, STATE_CHANGED = 4, OBSERVATIONS = 5,
  CASCADE_REFRESH = 6, CASCADE_VERSION = 7, STYLE_LOADS = 8;

// ── Slot change signaling (DOM §"signaling slot change") ───────────
// The engine assigns slottables where the tree and the attributes change, and keeps the signal slots — a slot once per
// notification, set semantics — handing each realm its own as its notification takes them (`moTakeBatch`), to fire
// after the observers' callbacks. dom-nodes.js installs the firer, which dispatches a `slotchange`.
let slotChangeFirer = null;   // (slot) => dispatch a slotchange event at slot
export function setSlotChangeFirer(fn) { slotChangeFirer = fn; }
// What an engine write's own steps did that the bindings have to hear of, read off the shared flags with no call: an
// element's state changed (a radio group unchecked by an insertion), which the style-state and settle generations
// follow; and something made pending — a slot signaled as a change of the tree or an attribute assigned it anew, an
// observer given a transient registration — for which the agent's mutation observer microtask is queued.
export function engineWritten() {
  const flags = globalThis.__dom?.moFlags;
  if (flags === undefined) return;
  if (flags[STATE_CHANGED]) {
    flags[STATE_CHANGED] = 0;
    bumpStyleState();
    bumpSettleGen();
  }
  if (flags[PENDING] && !flags[MICROTASK_QUEUED]) scheduleMutationDelivery();
  // (…and what a change the engine made asks of the bindings: a rendering update's observations, the document's cascade
  // refreshed, or the cascade version moved — a shadow tree's sheet — each of the realm whose tree changed, which another
  // realm's code may have changed: its own to do, `REALM.refreshCascade`)
  if (flags[OBSERVATIONS]) {
    flags[OBSERVATIONS] = 0;
    const schedule = globalThis.__csimScheduleObservations;
    if (schedule) schedule();
  }
  if (flags[CASCADE_REFRESH] || flags[CASCADE_VERSION]) {
    flags[CASCADE_REFRESH] = 0;
    flags[CASCADE_VERSION] = 0;
    const d = globalThis.__dom, asked = d.moTakeCascade();
    for (let i = 0; i + 1 < asked.length; i += 2) {
      const realm = asked[i] === d.realmId ? NATIVE_REALM : d.arenaOf(asked[i])?.realm;
      if (realm) realm.refreshCascade(asked[i + 1] === 1);
    }
  }
  // (…and the `<style>` elements whose new sheets owe their `load`, queued by the bindings that queue a load task)
  if (flags[STYLE_LOADS]) {
    flags[STYLE_LOADS] = 0;
    // (…each queued by its own realm — its node document's, whose tasks and Event it is — where that is not this one:
    // the realm its code moved it into, or whose code changed it; a document with no window, this one's; one whose
    // window's realm is gone, none)
    for (const style of globalThis.__dom.takeStyleLoads()) {
      let queue = null;
      try {
        const view = style._ownerDocument._window;
        queue = view ? view.__csimStyleBlockUpdated : globalThis.__csimStyleBlockUpdated;
      } catch (_) {}
      if (typeof queue === 'function') queue(style);
    }
  }
}
function fireSignaledSlots(slots) {
  if (!slotChangeFirer) return;
  for (const slot of slots) slotChangeFirer(slot);
}

// The realm's generations, which its memos key on: the engine's buffer (dom.rs `Generations`, `__dom.generations`), the
// realm's own, which the engine moves with the changes it makes and the bindings with theirs — by index.
const GEN_DIRTY = 0, GEN_SUBTREE_MARKS = 1, GEN_SETTLE = 2, GEN_TREE = 3, GEN_NODES = 4, GEN_STRUCTURE = 5, GEN_STYLE_STATE = 6;
const GEN_CASCADE = 7;
// …and beside them a word of flags: the observations the realm owes at its next rendering update (`owesObservations`).
const GEN_OBSERVATIONS = 9;
const generations = () => globalThis.__dom.generations;
function bump(which) {
  const g = generations();
  g[which] = g[which] + 1;
}

// What a batch of the live document's parse changed under `node` — its document's element — which a childList record
// would have marked for the next layout pass, from the first pass on: the engine's to keep and mark
// (mutation_observers.rs `ParsedMarks`) as the next pass starts (`ensureLayout` → `__csimFlushPendingMarks`). Only the
// LIVE document's parse calls this: `innerHTML`'s and DOMParser's detached trees mark nothing.
export function noteParsedChange(node) {
  globalThis.__dom.noteParsed(node._nid);
}
globalThis.__csimFlushPendingMarks = () => {
  // (…as the childList record would have: the cascade's structural memos move with it)
  if (globalThis.__dom.flushParsedMarks()) bumpSettleGen();
};
// A change that can alter INHERITED style — a `class` or `style` write, or an attribute some selector reads — reaches
// what is measured INSIDE the element too: a SUBTREE mark, the expensive kind.
// Diagnostic: how many SUBTREE-scoped layout invalidations have happened — the elements a write marked with their
// subtrees, and those the style engine's restyle reached (`__csimMarkRestyled`). Specs assert a paint-only or no-op
// class write does NOT increment it; geometry alone cannot distinguish "kept" from "recomputed equal".
globalThis.__csimSubtreeMarks = () => generations()[GEN_SUBTREE_MARKS];
// …and the marker itself, for the callers that cannot IMPORT it: native-query-shadow.js, which this module imports
// (`markShownText`).
globalThis.__csimMarkLayoutDirty = (node, alsoSubtree) => markLayoutDirty(node, alsoSubtree);
// A change to `node` — and with `alsoSubtree`, to everything under it — for the realm whose arena it is in: a node
// adopted from another realm's document is laid out by its document's realm, whose gate has to hear of it whichever
// realm's setter made the change.
export function markLayoutDirty(node, alsoSubtree) {
  if (!node) return;
  const realm = foreignRealmOf(node);
  if (realm !== null) {
    realm.markLayoutDirty(node, alsoSubtree);
    return;
  }
  if (alsoSubtree) bump(GEN_SUBTREE_MARKS);
  bump(GEN_DIRTY);
}
NATIVE_REALM.markLayoutDirty = markLayoutDirty;
// …and the `count` elements the style engine's restyle reached (`markRestyles`, layout.js — through the global, as
// layout.js imports nothing from here), each with its subtree.
globalThis.__csimMarkRestyled = (count) => {
  const g = generations();
  g[GEN_SUBTREE_MARKS] = g[GEN_SUBTREE_MARKS] + count;
  bump(GEN_DIRTY);
};

// (`dataOnly`: a text's data changed, and nothing else — which moves no collection of elements: the nodes' generation)
export function bumpSettleGen(dataOnly = false) {
  bump(GEN_SETTLE);
  bump(GEN_TREE);
  if (!dataOnly) bump(GEN_NODES);
  // An observable DOM change asks for a rendering update, as it does in a browser: this is the one
  // place every mutation funnels through, and IntersectionObserver / ResizeObserver targets can only
  // have changed when something changed. The scheduler raises ONE pending flag per frame and the update
  // itself returns immediately unless the geometry generation actually moved, so this is not a per-mutation
  // cost — but without it a target revealed by a class change (Avo's tabs unhide a lazy
  // `<turbo-frame>`) never fires, because the settle loop only steps when something is pending.
  const schedule = globalThis.__csimScheduleObservations;
  if (schedule) schedule();
}
// Read-only accessor for hot host-fn paths that want to memoise a
// derived value (e.g. a <select>'s implicit-default option) and
// invalidate it on the next observable DOM change.
export function currentSettleGen() { return generations()[GEN_SETTLE]; }
// The generation a memo of the TREE keys on: it moves with `settleGen` — every observable mutation — and with every
// change the streaming parser makes to the tree, which moves no settleGen (parser mutations are deliberately silent).
// Keyed on settleGen alone, a memo read by a parse-time script answered from the tree as it stood before the parse went
// on: `document.body.children` kept the length of the first read, and a sibling index missing every child parsed after
// it sent `nextElementSibling` round in a circle. ONE counter for the whole class, where each memo that met it had grown
// a parser key of its own. (The one memo that must NOT follow attribute writes keeps a counter of its own —
// the structure generation — `GEN_STRUCTURE` — which no attribute can move.)
export function currentTreeGen() { return generations()[GEN_TREE]; }
export function bumpTreeGen() {
  bump(GEN_TREE);
  bump(GEN_NODES);
}
// …and the generation a live collection of nodes keys on (dom-collections.js): the tree generation, but for a change
// of a text's data, which can change no collection's members — writing the text of 2,000 spans read through
// `children[i]` re-walked the children at every write.
export function currentNodesGen() { return generations()[GEN_NODES]; }
export function noteParserTreeChange() { bumpTreeGen(); }
globalThis.__csimTreeGen = currentTreeGen;

// ── style-state generation ──────────────────────────────────────────────────
// The cascade matches selectors LIVE on every read, which is how a DYNAMIC pseudo-class takes
// effect at all — `:state()`, `:focus`, `:defined`. Most of what those read already moves
// `settleGen` (an attribute, the tree, a form control's checkedness, the location) or
// `cascadeVersion` (a stylesheet, `GEN_CASCADE`), but a few kinds of state move neither. This counter carries
// exactly those: the rendered-ness the engine keeps keys on it with the others (rendered.rs `Answered`).
//
// It is deliberately NOT `settleGen`: that one also drives the settle loop and the
// IntersectionObserver scheduler, and a focus change is not a reason to keep settling.
export function bumpStyleState() {
  bump(GEN_STYLE_STATE);
}
// …and the rule set's (`cascadeVersion`): moved where the cascade the realm's sheets make changed — the engine's to see
// for the document's (sheet_owners.rs `cascadeRekey`) — and where a change the document's cascade key cannot see does:
// a shadow root's own `<style>` / `adoptedStyleSheets`, a custom-element definition that flips what a STATIC
// pseudo-class matches (`:disabled` reads form-associatedness off the registry), an animation of a custom property.
// That hands the shadow trees' sheets to the engine again and re-keys every rule-set-keyed memo, without marking the
// document cascade stale, which would only walk every `<style>`/`<link>` to find its key unchanged.
export function bumpCascadeVersion() {
  bump(GEN_CASCADE);
}
export function currentCascadeVersion() { return generations()[GEN_CASCADE]; }
// The observations (`bit`: observers.js `OBSERVATIONS_*`) the realm owes at its next rendering update — a word the engine
// reads too, which keeps the realm's event loop stepping (timers.rs `realmPending`).
export function owesObservations(bit) {
  return (generations()[GEN_OBSERVATIONS] & bit) !== 0;
}
export function oweObservations(bit, on) {
  const g = generations();
  g[GEN_OBSERVATIONS] = on ? g[GEN_OBSERVATIONS] | bit : g[GEN_OBSERVATIONS] & ~bit;
}
// …and the structure's: it moves on every insertion or removal — the parser's too — and on nothing else, an attribute
// write moving the tree generation and not this one. Each realm counts its own from 1.
export function bumpStructureGen() {
  bump(GEN_STRUCTURE);
}
// Ruby side polls this via Context#call('__settleGenGet') to yield
// from `settle` on the first observable change.
globalThis.__settleGenGet = currentSettleGen;

// A MutationObserver (DOM §4.3.1), generated from its IDL: its callback, and its number — in the order observers are
// made, which is the order they are notified in. The nodes it observes, with their options, and the records queued for
// it are the engine's.
export class MutationObserver {
  constructor(callback) {
    [callback] = convertMutationObserverArguments(arguments);
    makeSlots(this, 'MutationObserver', { callback, id: globalThis.__dom.moCreate() });
  }
}
const observerState = (obs) => slotsOf(obs, 'MutationObserver');
registerInterface('MutationObserver', (o) => observerState(o) !== undefined);
const OBSERVE = "Failed to execute 'observe' on 'MutationObserver': ";
installMutationObserver(MutationObserver, {
  // "observe": `attributes` implied by an attribute option and `characterData` by its old value where they are
  // omitted — not where they are false, which contradicts them — at least one kind of change asked for, and a
  // registration for `target` already there given the options anew.
  observe(obs, target, options) {
    if ((options.attributeOldValue !== undefined || options.attributeFilter !== undefined) && options.attributes === undefined) options.attributes = true;
    if (options.characterDataOldValue !== undefined && options.characterData === undefined) options.characterData = true;
    if (!options.childList && !options.attributes && !options.characterData) {
      throw new TypeError(OBSERVE + "The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    }
    if (options.attributeOldValue && !options.attributes) {
      throw new TypeError(OBSERVE + "The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
    }
    if (options.attributeFilter !== undefined && !options.attributes) {
      throw new TypeError(OBSERVE + "The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
    }
    if (options.characterDataOldValue && !options.characterData) {
      throw new TypeError(OBSERVE + "The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
    }
    const { id } = observerState(obs);
    const flags = (options.childList ? CHILD_LIST : 0) | (options.attributes ? ATTRIBUTES : 0) |
      (options.characterData ? CHARACTER_DATA : 0) | (options.subtree ? SUBTREE : 0) |
      (options.attributeOldValue ? ATTRIBUTE_OLD_VALUE : 0) | (options.characterDataOldValue ? CHARACTER_DATA_OLD_VALUE : 0);
    globalThis.__dom.moObserve(id, target._nid, flags, options.attributeFilter ?? null);
    observers.set(id, obs);
  },
  disconnect(obs) {
    const { id } = observerState(obs);
    globalThis.__dom.moDisconnect(id);
    observers.delete(id);
  },
  takeRecords(obs) {
    return mutationRecords(globalThis.__dom.moTakeRecords(observerState(obs).id));
  }
});

// …and a write to the tree's edges (tree.js), which may have made an observer pending — given a transient registered
// observer as a node was removed or moved — or signaled a slot, the engine's either way.
setEdgeWrittenSteps(engineWritten);


// DOM "notify mutation observers", the agent's: every realm's pending observers, in the order they were made, and the
// slots signaled — both taken before any callback runs (a slot signaled during one fires at the next notification) —
// each observer's records taken as its turn comes, with its transient registered observers: a record an earlier
// callback queued is in them, and an observer an earlier callback took the records of, or disconnected, has none and is
// not called back. Then the slots, each realm's.
export function deliverMutations() {
  const d = globalThis.__dom, flags = d.moFlags;
  // (…a call while a notification runs — a parser script's checkpoint in a callback — leaves the queued microtask to
  // notify what the callbacks queue)
  if (flags[NOTIFYING]) return;
  flags[MICROTASK_QUEUED] = 0;
  flags[NOTIFYING] = 1;
  try {
    const turns = [], slots = [];
    for (const realm of d.moTakePending()) realmGlobal(realm)?.__csimTakeMutationBatch(turns, slots);
    turns.sort((a, b) => a.id - b.id);
    for (const { id, notify } of turns) notify(id);
    for (const fire of slots) fire();
  } finally {
    flags[NOTIFYING] = 0;
    // (…and the microtask a callback's change queued, which ran — and did nothing — during the notification, again)
    if (flags[MICROTASK_QUEUED]) Promise.resolve().then(runQueuedDelivery);
  }
}
// …this realm's part of it: its pending observers, each to be notified in its turn (`moTakeBatch`), and its signaled
// slots' firing.
globalThis.__csimTakeMutationBatch = (turns, slots) => {
  const [pending, signaled] = globalThis.__dom.moTakeBatch();
  for (let i = 0; i < pending.length; i++) turns.push({ id: pending[i], notify: notifyObserver });
  if (signaled.length) slots.push(() => fireSignaledSlots(signaled));
};
// An observer's turn: its records taken, its transient registered observers removed, and its callback called with the
// records where there are any.
function notifyObserver(id) {
  const d = globalThis.__dom;
  const records = mutationRecords(d.moTakeRecords(id));
  d.moRemoveTransients(id);
  const obs = observers.get(id);
  if (obs === undefined || !records.length) return;
  const { callback } = observerState(obs);
  try { callback.call(obs, records, obs); }
  catch (e) {
    // Per WebIDL, a throwing observer callback "reports the exception" on the CALLBACK's realm global (a cross-realm
    // observer reports on its own frame's onerror), not here. `__csimReportCallbackError` routes via the callback's
    // [[Realm]]; same-realm falls back to a local report.
    try { globalThis.__csimReportCallbackError(callback, e); } catch (_) { logThrew('MO callback', e); }
  }
}
// (…the global of a realm, this one's too — none for one disposed)
function realmGlobal(realm) {
  try { return globalThis.RustyRacer.contextGlobal(realm); } catch (_) { return null; }
}

// Whether any realm has observers to notify or slots signaled.
export function hasQueuedRecords() {
  return globalThis.__dom.moHasPending();
}

// Synchronously run the pending MutationObserver / slotchange delivery (the
// compound microtask), the same one `scheduleMutationDelivery` defers. Lets a
// caller flush this specific microtask at a known checkpoint (HTML "clean up
// after running a script" between parser-run scripts) without draining the
// whole agent job queue — keeping cross-realm Promise timing untouched. Clears
// the queued flag so the already-scheduled microtask becomes a cheap no-op.
export function flushMutationDelivery() {
  if (hasQueuedRecords()) deliverMutations();
}

// Exposed so timer-drain (after firing each timer) and event dispatch
// can poll without importing the module: whether any node has a registered observer, whichever realm's.
export function hasObservers() {
  const d = globalThis.__dom;
  return d !== undefined && d.moFlags[ANY_REGISTERED] !== 0;
}

// The agent's mutation observer microtask, queued once — in the realm whose change queued it, as the agent's one
// microtask queue would run it there.
function scheduleMutationDelivery() {
  const flags = globalThis.__dom?.moFlags;
  if (flags === undefined || flags[MICROTASK_QUEUED]) return;
  globalThis.__dom.moQueue();
  Promise.resolve().then(runQueuedDelivery);
}
function runQueuedDelivery() {
  if (globalThis.__dom.moFlags[MICROTASK_QUEUED]) deliverMutations();
}

globalThis.MutationObserver = MutationObserver;
globalThis.MutationRecord   = MutationRecord;

