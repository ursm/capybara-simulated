// MutationObserver — per-observer record queues populated at mutation
// time. `disconnect()` cleanly drops that observer's pending queue,
// which Trix's render path relies on via
// `editorWillSyncDocumentView` / `…DidSyncDocumentView` — a
// global-queue-and-filter-at-delivery model violates that and loops
// Trix's reparse.
//
// Bridge mutation paths (`Element#setAttribute`, child-list edits,
// `Text` data writes) call the `recordAttrMutation` / `recordChildList`
// / `recordCharacterData` helpers exported here directly. Delivery is
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
import { foreignRealmOf, REALM as NATIVE_REALM } from './native-query-shadow.js';
import { scheduleCascadeRefresh, bumpCascadeVersion, bumpStructureGen } from './cascade.js';
import { setTransientObserverSteps } from './tree.js';

// MutationObserverInit's options, as the engine takes them (mutation_observers.rs).
const CHILD_LIST = 1, ATTRIBUTES = 2, CHARACTER_DATA = 4, SUBTREE = 8, ATTRIBUTE_OLD_VALUE = 16, CHARACTER_DATA_OLD_VALUE = 32;

// A childList add/remove whose nodes include a `<style>` / `<link>` (or a characterData edit to a
// `<style>`'s text) changes the resolved cascade with no per-element attr mutation; schedule a
// coalesced rebuild so the cascade-keyed memos invalidate. Shallow (direct-node) check to stay cheap
// on the hot path — the dominant dynamic-stylesheet pattern is `head.appendChild(styleEl)`.
//
// …except inside a SHADOW TREE, where it is `sr.appendChild(wrap)` with the `<style>` one level in:
// a component builds its markup in a fragment and attaches it whole. A shadow tree is component-sized
// and a shadow page is rare, so the deep scan is bounded and off the document's hot path — while
// missing it leaves the tree's whole stylesheet unapplied for as long as nothing else bumps the
// cascade (its sheets are handed to the style engine per version: cascade.js `feedShadowStyleSheets`).
function touchesStylesheet(nodes, deep) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    if (n._tag === 'style' || n._tag === 'link') return true;
    if (deep && n._children && n._children.length && touchesStylesheet(n._children, true)) return true;
  }
  return false;
}
// Whether `node` lives in a shadow tree — the same walk `stylesheetChanged` makes, done once.
function inShadowTree(node) {
  if (!globalThis.__csimShadowHostCount) return false;
  for (let n = node; n; n = n._parent) if (n._isShadowRoot) return true;
  return false;
}
// Did this childList change touch a stylesheet? The SHALLOW scan runs first and answers for the
// dominant case without walking anywhere; only when it comes up empty on a page that has a shadow
// tree at all is the root-ward walk worth making, and only then does the deep scan run. Written as a
// named function rather than a closure in the caller so the hot path allocates nothing per record.
function stylesheetTouch(target, added, removed) {
  if (touchesStylesheet(added, false) || touchesStylesheet(removed, false)) return true;
  if (!globalThis.__csimShadowHostCount || !inShadowTree(target)) return false;
  return touchesStylesheet(added, true) || touchesStylesheet(removed, true);
}
// A stylesheet change under a SHADOW ROOT is invisible to the document cascade's content key
// (`rebuildCascade` early-returns unchanged), while the per-root scoped rules and every memo key
// on the cascade VERSION — so move that directly. A document-tree change goes through the
// scheduled rebuild, which moves the version itself when the key differs.
function stylesheetChanged(node) {
  for (let n = node; n; n = n._parent) {
    if (n._isShadowRoot) {
      bumpCascadeVersion();
      return;
    }
  }
  scheduleCascadeRefresh();
}

// A `<style>`'s text changed: HTML's "update a style block" — a new sheet, made of the text (`_sheetGen`, which the
// engine's sheet of it is made again for, and the faces it declares are keyed by: cascade.js `engineSheet`,
// `faceSource`) — even of the same text.
function styleBlockChanged(style) {
  sheetOwnerRenewed(style);
  stylesheetChanged(style);
}
// …and a `<style>` / `<link>` inserted or removed obtains a new sheet when it is next in a document (HTML "update a
// style block", the link's "obtain the resource"): what a script edited of the one before is gone with it. Walked into
// an inserted or removed subtree only once a script has held such a sheet at all (`__csimOwnedSheets`, cssom.js) — a
// sheet nobody edited is the same sheet again. Whether it renewed any.
function sheetOwnersMoved(nodes) {
  let renewed = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || n._nodeType !== 1) continue;
    if (n._tag === 'style' || n._tag === 'link') { sheetOwnerRenewed(n); renewed = true; }
    else if (globalThis.__csimOwnedSheets && n._children && n._children.length && sheetOwnersMoved(n._children)) renewed = true;
  }
  return renewed;
}
// The owner's sheet is a new one from here (`_sheetGen`, which its engine sheet is made again for: cascade.js
// `engineSheetOf`), and the one it had no longer its own — its CSSStyleSheet is let go of at once (no owner node, no
// `disabled` of its own the new sheet would answer with).
function sheetOwnerRenewed(owner) {
  owner._sheetGen = (owner._sheetGen | 0) + 1;
  if (owner._sheet) { slotsOf(owner._sheet, 'CSSStyleSheet').ownerNode = null; owner._sheet = null; }
}

// A `<link>`'s or `<style>`'s attribute that selects or obtains its sheet — HTML's attribute change steps, so here, where
// every write arrives (`setAttribute` / `setAttributeNS`, an `Attr`'s value, `attributes.setNamedItem`, a removal),
// rather than in `setAttribute` alone: the others left `<style media=print>` switched to `screen` applying nothing.
// A `<style>`'s `type` decides whether it has a sheet at all (`styleElementIsCss`). `media` / `title` only re-select
// the sheet (which set it is in, whether its query holds), and the sheet's media list
// follows the attribute on the same sheet object, as Chrome's `sheet.media.mediaText` does. A `<link>`'s `disabled`
// disassociates its sheet, and removing it sets "explicitly enabled" and obtains the sheet again, as a `rel` or `href`
// change does (`maybeFireLinkLoad`: the resource may newly be a stylesheet, or another one — fetched, its `load` fired).
// A shadow tree's sheet re-selects through the route its text edits take (`stylesheetChanged`), which the document's
// refresh alone never reached.
const LINK_SHEET_ATTRS = new Set(['rel', 'href', 'media', 'title', 'disabled']);
const STYLE_SHEET_ATTRS = new Set(['media', 'title', 'type']);
function sheetAttrChanged(el, name, value, oldValue) {
  if (el._tag === 'link') {
    // (…an `href` set to the value it had changes nothing: the same resource)
    if (!LINK_SHEET_ATTRS.has(name) || (name === 'href' && value === oldValue)) return;
    // (…`disabled` disassociates its sheet and removing it obtains one again, as `rel` does: a new sheet either way)
    if (name === 'disabled' && value == null) el._explicitlyEnabled = true;
    if (name === 'disabled' || name === 'rel' || name === 'href') sheetOwnerRenewed(el);
  } else if (el._tag !== 'style' || !STYLE_SHEET_ATTRS.has(name)) {
    return;
  }
  if (name === 'media' && el._sheet) el._sheet.media.mediaText = value == null ? '' : value;
  // (…a `<style>`'s `type` re-runs "update a style block": a sheet again is a new one)
  if (name === 'type') sheetOwnerRenewed(el);
  stylesheetChanged(el);
  if ((name === 'rel' || name === 'href' || (name === 'disabled' && value == null)) && globalThis.__csim_linkResourceChanged) globalThis.__csim_linkResourceChanged(el);
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
// (…one of `type` about `target`, the rest as the change has them — its old value where the observer asked for it)
function mutationRecord(type, target, fields, withOldValue) {
  const rec = Object.create(RECORD_PROTO);
  makeSlots(rec, 'MutationRecord', {
    type,
    target,
    addedNodes:         fields.addedNodes || NONE,
    removedNodes:       fields.removedNodes || NONE,
    previousSibling:    fields.previousSibling || null,
    nextSibling:        fields.nextSibling || null,
    attributeName:      fields.attributeName === undefined ? null : fields.attributeName,
    attributeNamespace: fields.attributeNamespace === undefined ? null : fields.attributeNamespace,
    oldValue:           withOldValue && fields.oldValue !== undefined ? fields.oldValue : null,
    addedList:          null,
    removedList:        null
  });
  return rec;
}

// The observers observing, by their number (the engine's — mutation_observers.rs, which keeps every node's registered
// observer list): an observer is here from its first `observe` to its `disconnect`.
const observers = new Map();
// …and those a removal gave a transient registered observer since they were last notified: pending, if no record is.
const transientsPending = new Set();
// The agent's own state, which every realm's bindings share (mutation_observers.rs `moFlags`): whether any node has a
// registered observer — any realm's, whichever realm's script makes the change — and whether the agent's mutation
// observer microtask is queued and observers being notified. Its pending observers are the engine's to list, by realm
// (`moPend`); one notification takes them all, in the order they were made.
const ANY_REGISTERED = 0, MICROTASK_QUEUED = 1, NOTIFYING = 2;
// (…this realm has something to notify)
function pend() { globalThis.__dom?.moPend(); }

// ── Slot change signaling (DOM §"signaling slot change") ───────────
// The slot-assignment model lives in dom-nodes.js (it walks _children /
// _shadowRoot), but the trigger points are the two universal mutation
// chokepoints below (recordChildList / recordAttrMutation, called for
// every childList / attribute change before the observer-count gate). So
// dom-nodes.js registers its reassignment hooks + slotchange firer here,
// and recordChildList / recordAttrMutation call them. `signalSlotChange`
// queues a slot for a coalesced `slotchange` at the next microtask
// checkpoint (set semantics → one event per checkpoint even if a slot's
// assignment changed several times). All three are no-ops until
// dom-nodes.js installs them, and the hooks self-gate on whether any
// shadow root exists, so a shadow-free page pays a single null check.
const signalSlots     = new Set();
let slotChangeFirer   = null;   // (slot) => dispatch a slotchange event at slot
let slotChildListHook = null;   // (target) => reassign slottables for the affected shadow root
let slotAttrHook      = null;   // (target, key) => reassign on a slot/name attribute change
export function setSlotChangeFirer(fn) { slotChangeFirer = fn; }
export function setSlotMutationHooks(childList, attr) { slotChildListHook = childList; slotAttrHook = attr; }
// The slot side of a childList mutation, WITHOUT the observer bookkeeping — for
// paths that bypass `recordChildList` when nothing is observing (the streaming
// parser's insert hook). slotchange is independent of MutationObserver, so the
// signal must fire either way; the hook itself self-gates on shadowHostCount.
export function signalSlotChildList(target, added, removed) {
  if (slotChildListHook) slotChildListHook(target, added, removed);
}
export function signalSlotChange(slot) {
  signalSlots.add(slot);
  pend();
  scheduleMutationDelivery();
  // …and the FLAT tree changed shape under the slot: what it lays out is its new assigned set, inheriting from it — a
  // change no DOM mutation marks (the light node that moved is under the HOST, not under the slot).
  markLayoutDirty(slot, true);
  // …and the text memos (`innerText`, Capybara's text) key on the settle generation, which an `assign()` moves nothing
  // else of: `h.innerText` kept "N" after `s1.assign(m)` (Chrome: "M").
  bumpSettleGen();
}
// Capture + empty the signal-slot set at the START of a notify pass (DOM
// "notify mutation observers" step 1), returning the slots to fire once the MO
// callbacks have run. A slot signaled DURING those callbacks re-populates the
// now-empty set and fires at the NEXT checkpoint — never coalesced into this
// one (a distinct slotchange per compound microtask).
function takeSignaledSlots() {
  if (!signalSlots.size) return null;
  const slots = [...signalSlots];
  signalSlots.clear();
  return slots;
}
function fireSignaledSlots(slots) {
  if (!slots || !slotChangeFirer) return;
  for (const slot of slots) slotChangeFirer(slot);
}

// The sequence of the last change a layout has to see — a mutation, a restyle, a control's shown text — which no
// generation moves: the third key of `ensureLayout`'s gate (layout.js), and of every memo that reads a box. What changed
// is the arena's to know: the walk keeps every subtree no change reached (walk_ops.rs).
let dirtySeq = 0;
export function currentDirtySeq() { return dirtySeq; }
globalThis.__csimDirtySeq = () => dirtySeq;
// The streaming parser records nothing with nothing observing (`recordChildList` is the observer path, and a
// coalesced text run records nothing at all) — which is only right until a layout pass has run. A parser-blocking
// script that reads geometry lays the PARTIAL tree out, and the boxes it laid out then kept their answers while the
// parse went on under them: `#c`, parsed after such a read, had no box at all (Chrome: y 68, and the body 86 tall).
// So from the first pass on, the parents the parser touches are collected (one Set entry per parent, not a walk per
// node) and marked where the next pass starts (`ensureLayout` → `__csimFlushPendingMarks`), as a childList record
// would have marked them. Only the LIVE document's parse calls this — `innerHTML` and DOMParser share the adapter,
// and noting their detached fragments held them alive until the next pass, to mark nothing. (A `dir=auto` scope the
// parse writes text into is noted from the start, pass or no pass: getComputedStyle reads direction too.)
let layoutHasRun = false;
// …with whether its CHILDREN changed or only text was appended to its last one, which is what a childList record
// would mark of it: the element's subtree either way, as a write's (`recordChildList`) — `li:last-of-type` stayed on the
// old last `<li>`, and a parsed `.flag` never reached `.c:has(.flag)`.
const parsedParents = new Map();
export function noteParsedChange(parent, inserted, removed) {
  if (layoutHasRun) {
    let rec = parsedParents.get(parent);
    if (rec === undefined) parsedParents.set(parent, rec = { children: false, text: false });
    if (inserted || removed) rec.children = true;
    else rec.text = true;
  }
}
globalThis.__csimFlushPendingMarks = () => {
  layoutHasRun = true;
  if (parsedParents.size) {
    for (const [p, rec] of parsedParents) {
      const last = p._children[p._children.length - 1];
      markLayoutDirty(p, p._nodeType === 1 && (rec.children || (rec.text && !!last && last._nodeType === 3)));
    }
    parsedParents.clear();
    bumpSettleGen();   // …as the childList record would have: the cascade's structural memos move with it
  }
};
// A change that can alter INHERITED style — a `class` or `style` write, or an attribute some selector reads — reaches
// what is measured INSIDE the element too: a SUBTREE mark, the expensive kind.
let subtreeMarks = 0;
// Diagnostic: how many SUBTREE-scoped layout invalidations have happened — the elements a write marked with their
// subtrees, and those the style engine's restyle reached (`__csimMarkRestyled`). Specs assert a paint-only or no-op
// class write does NOT increment it; geometry alone cannot distinguish "kept" from "recomputed equal".
globalThis.__csimSubtreeMarks = () => subtreeMarks;
// …and the marker itself, for the callers that cannot IMPORT it: layout.js needs to dirty the tree before a paint (see
// `recordingRuns`), and an import edge from layout to this module reorders initialisation enough to break the slot
// hooks dom-nodes installs here.
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
  if (alsoSubtree) subtreeMarks++;
  dirtySeq++;
}
NATIVE_REALM.markLayoutDirty = markLayoutDirty;
// …and the `count` elements the style engine's restyle reached (`markRestyles`, layout.js — through the global, as
// layout.js imports nothing from here), each with its subtree.
globalThis.__csimMarkRestyled = (count) => {
  subtreeMarks += count;
  dirtySeq++;
};

let settleGen = 0;
// (`dataOnly`: a text's data changed, and nothing else — which moves no collection of elements: `nodesGen`)
export function bumpSettleGen(dataOnly = false) {
  settleGen = (settleGen + 1) | 0;
  treeGen = (treeGen + 1) | 0;
  if (!dataOnly) nodesGen = (nodesGen + 1) | 0;
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
export function currentSettleGen() { return settleGen; }
// The generation a memo of the TREE keys on: it moves with `settleGen` — every observable mutation — and with every
// change the streaming parser makes to the tree, which moves no settleGen (parser mutations are deliberately silent).
// Keyed on settleGen alone, a memo read by a parse-time script answered from the tree as it stood before the parse went
// on: `document.body.children` kept the length of the first read, and a sibling index missing every child parsed after
// it sent `nextElementSibling` round in a circle. ONE counter for the whole class, where each memo that met it had grown
// a parser key of its own. (The one memo that must NOT follow attribute writes keeps a counter of its own —
// cascade.js `structureGen`, which no attribute can move.)
let treeGen = 0;
export function currentTreeGen() { return treeGen; }
export function bumpTreeGen() {
  treeGen = (treeGen + 1) | 0;
  nodesGen = (nodesGen + 1) | 0;
}
// …and the generation a live collection of nodes keys on (dom-collections.js): the tree generation, but for a change
// of a text's data, which can change no collection's members — writing the text of 2,000 spans read through
// `children[i]` re-walked the children at every write.
let nodesGen = 0;
export function currentNodesGen() { return nodesGen; }
export function noteParserTreeChange() { bumpTreeGen(); }
globalThis.__csimTreeGen = () => treeGen;

// ── style-state generation ──────────────────────────────────────────────────
// The cascade matches selectors LIVE on every read, which is how a DYNAMIC pseudo-class takes
// effect at all — `:state()`, `:focus`, `:defined`. Most of what those read already moves
// `settleGen` (an attribute, the tree, a form control's checkedness, the location) or
// `cascadeVersion` (a stylesheet), but a few kinds of state move neither. This counter carries
// exactly those: `cascadeGeneration` keys the rendered-ness memo on the union.
//
// It is deliberately NOT `settleGen`: that one also drives the settle loop and the
// IntersectionObserver scheduler, and a focus change is not a reason to keep settling.
let styleStateGen = 0;
export function bumpStyleState() {
  styleStateGen = (styleStateGen + 1) | 0;
}
export function currentStyleStateGen() { return styleStateGen; }
// Ruby side polls this via Context#call('__settleGenGet') to yield
// from `settle` on the first observable change.
globalThis.__settleGenGet = () => settleGen;

// A MutationObserver (DOM §4.3.1), generated from its IDL: its callback, its number — in the order observers are made,
// which is the order they are notified in — and the records queued for it. The nodes it observes, with their options,
// are the engine's.
export class MutationObserver {
  constructor(callback) {
    [callback] = convertMutationObserverArguments(arguments);
    makeSlots(this, 'MutationObserver', { callback, id: globalThis.__dom.moCreate(), records: [] });
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
    const state = observerState(obs);
    globalThis.__dom.moDisconnect(state.id);
    state.records = [];
    observers.delete(state.id);
    transientsPending.delete(obs);
  },
  takeRecords(obs) {
    const state = observerState(obs);
    const out = state.records;
    state.records = [];
    return out;
  }
});

// DOM "queue a mutation record": a record of the change for each interested observer — the engine's to tell
// (`moInterested`: each `observer * 2 + 1` where a registration it is interested by asks for the old value, else
// `observer * 2`; a number for one, an array for more) — each its own record.
const RECORD_TYPES = { childList: 0, attributes: 1, characterData: 2 };
function queueRecord(type, target, fields) {
  const found = globalThis.__dom.moInterested(target._nid, RECORD_TYPES[type], fields.attributeName, fields.attributeNamespace != null);
  if (found === undefined) return;
  const many = typeof found !== 'number';
  for (let i = 0, n = many ? found.length : 1; i < n; i++) {
    const packed = many ? found[i] : found;
    const id = packed >> 1, withOldValue = (packed & 1) === 1;
    if (observers.has(id)) queueRecordFor(id, type, target, fields, withOldValue);
    else otherRealmOf(id)?.__csimQueueMutationRecord(id, type, target, fields, withOldValue);
  }
  // (…the notification scheduled at the microtask checkpoint, so MO callbacks fire for direct DOM mutations
  // (insertBefore / removeChild / data= setter) too, not just for mutations queued inside a dispatchEvent chain: PM's
  // domchange observer sees `set()`-driven edits to its contenteditable)
  scheduleMutationDelivery();
}
// …the record for observer `id`, one of this realm's — made of its MutationRecord, and queued.
function queueRecordFor(id, type, target, fields, withOldValue) {
  const obs = observers.get(id);
  if (obs === undefined) return;
  observerState(obs).records.push(mutationRecord(type, target, fields, withOldValue));
  pend();
}
globalThis.__csimQueueMutationRecord = queueRecordFor;
// The global of the realm that made observer `id` where that is another realm — a change this realm's script makes to a
// node that realm's observer observes (an iframe's observer on the page's nodes, or the page's on the iframe's), whose
// records and notification are that realm's.
function otherRealmOf(id) {
  const realm = globalThis.__dom.moRealm(id);
  if (realm === undefined) return null;
  try { return globalThis.RustyRacer.contextGlobal(realm); } catch (_) { return null; }
}

// DOM "add transient registered observers", as a node is removed from its parent or moved out of it (tree.js hands over
// those the arena gave one): pending, to be notified — and lose them — at the next checkpoint; another realm's observer
// in its realm.
function transientsGiven(given) {
  for (let i = 0; i < given.length; i++) {
    if (observers.has(given[i])) transientPendingFor(given[i]);
    else otherRealmOf(given[i])?.__csimTransientPending(given[i]);
  }
  scheduleMutationDelivery();
}
function transientPendingFor(id) {
  const obs = observers.get(id);
  if (obs === undefined) return;
  transientsPending.add(obs);
  pend();
}
globalThis.__csimTransientPending = transientPendingFor;
setTransientObserverSteps(transientsGiven);

// `key` is the element's store key; the MutationRecord must expose the
// attribute's LOCAL NAME (not the prefixed qualified name) plus its namespace
// (DOM §4.3.1 "queue a mutation record"). The namespaced metadata lives in
// `target._attrNS[key]`; a caller that has already removed that entry (the
// removal path deletes it) passes `meta` explicitly so it isn't lost.
export function recordAttrMutation(target, key, oldValue, meta) {
  // STORE FLIP (Stage A): no attr-mirror hook — a mirrored element's `_attrs` IS the arena (attrsView),
  // so the write that triggered this already landed in the arena. Nothing to sync.
  const lkey = String(key).toLowerCase();
  // A `src` set on a <script> that had none prepares it (an empty one inserted first, its source assigned after — the
  // after-parse pass used to run it by accident, and after the parse nothing did).
  if (lkey === 'src' && oldValue == null && target._tag === 'script') globalThis.__csimPrepareScript(target);
  const m = meta !== undefined ? meta : (target._attrNS && target._attrNS[key]);
  if (!(m && m.ns)) sheetAttrChanged(target, lkey, target._attrs[key], oldValue);
  // The writer's box and its subtree — its own box may read the attribute however the selectors fall, the ancestor walk
  // is what re-derives the flow around it, and its descendants inherit from it. What else the write restyles — a
  // `body.os-pc .os-host` under it, the `.c` of a `.c:has(.flag)` above it — is the style engine's to say, and it marks
  // those as it restyles them (layout.js `markRestyles`).
  markLayoutDirty(target, true);
  bumpSettleGen();
  if (slotAttrHook && (key === 'slot' || key === 'name')) slotAttrHook(target, key);
  if (!hasObservers()) return;
  queueRecord('attributes', target, {
    attributeName:      m ? m.localName : key,
    attributeNamespace: m ? m.ns : null,
    oldValue
  });
}
export function recordChildList(target, added, removed, prevSibling, nextSibling) {
  // The target's box and, for an element or a shadow root, its subtree, as an attribute write marks the writer's: what
  // the selectors read of a child list — positions, `:empty`, a `:has()` above — the style engine marks as it restyles.
  markLayoutDirty(target, !!target && (target._nodeType === 1 || !!target._isShadowRoot));
  // …and each ADDED node itself, with its subtree: a node that MOVED is measured where it is now.
  for (const node of added) markLayoutDirty(node, true);
  const renewed = sheetOwnersMoved(added) | sheetOwnersMoved(removed);
  bumpSettleGen();
  // …and the structure generation: an insertion or removal stales every enclosing-root memo.
  bumpStructureGen();
  // A stylesheet <style>/<link> inserted or removed changes the cascade; so does a
  // change to a connected <style>'s OWN children (`style.textContent = …`, which
  // replaces the child text node — added/removed are text nodes, but the rules
  // changed), hence the `target._tag === 'style'` arm.
  if (target && target._tag === 'style') {
    // A `<style>`'s children changing re-runs "update a style block": the sheet must be
    // re-parsed FROM the element text, discarding any CSSOM insertRule/deleteRule edits —
    // even when the concatenated text is byte-identical (e.g. appending/removing an EMPTY
    // text node). A text-string compare can't see that, so mark the block dirty on the
    // actual child mutation. (recordChildList is only called for a real change — a no-op
    // `textContent = ""` on an already-empty `<style>` queues nothing, so nothing dirties.)
    styleBlockChanged(target);
  } else if (renewed || ((added.length || removed.length) && stylesheetTouch(target, added, removed))) {
    // (…a sheet owner renewed deep inside a moved subtree re-keys the cascade as one moved itself does)
    stylesheetChanged(target);
  }
  if (slotChildListHook) slotChildListHook(target, added, removed);
  if (!hasObservers()) return;
  // Per DOM spec a childList record carries the siblings adjacent to
  // the change. Explicit prev/next args win when a call site threads
  // them through (e.g. removals, where the removed node is detached by
  // record time so its own pointers are gone). Otherwise, for inserts
  // we derive from the added nodes still in the tree: the node before
  // the first added node and the node after the last added node, by
  // their position in target._children.
  let previousSibling = prevSibling !== undefined ? prevSibling : null;
  let next            = nextSibling !== undefined ? nextSibling : null;
  if (prevSibling === undefined && nextSibling === undefined &&
      added.length && target && target._children) {
    const kids  = target._children;
    const first = kids.indexOf(added[0]);
    const last  = kids.indexOf(added[added.length - 1]);
    if (first !== -1) previousSibling = first > 0 ? kids[first - 1] : null;
    if (last  !== -1) next            = last + 1 < kids.length ? kids[last + 1] : null;
  }
  queueRecord('childList', target, {
    addedNodes:   added.slice(),
    removedNodes: removed.slice(),
    previousSibling,
    nextSibling:  next
  });
}
export function recordCharacterData(target, oldValue) {
  markLayoutDirty(target);
  bumpSettleGen(true);
  // …and its element's subtree where `:empty` can have flipped, as a child-list change marks it.
  const parent = target._parent;
  if (parent && parent._nodeType === 1 && !oldValue !== !target._data) markLayoutDirty(parent, true);
  // Editing a connected `<style>`'s text changes its rules — re-parse the block (discarding
  // CSSOM edits), same as a childList change.
  if (target && target._parent && target._parent._tag === 'style') styleBlockChanged(target._parent);
  if (!hasObservers()) return;
  queueRecord('characterData', target, { oldValue });
}

// DOM "notify mutation observers", the agent's: every realm's pending observers — their records TAKEN before any
// callback runs (a record queued during one waits for the next notification, as the slot it signals does), in the
// order the observers were made, each losing its transient registered observers as its turn comes, one with no record
// called back for none — and then the slots signaled, each realm's.
export function deliverMutations() {
  const d = globalThis.__dom, flags = d.moFlags;
  // (…a call while a notification runs — a parser script's checkpoint in a callback — leaves the queued microtask to
  // notify what the callbacks queue)
  if (flags[NOTIFYING]) return;
  flags[MICROTASK_QUEUED] = 0;
  flags[NOTIFYING] = 1;
  try {
    const batch = [], slots = [];
    for (const realm of d.moTakePending()) realmGlobal(realm)?.__csimTakeMutationBatch(batch, slots);
    batch.sort((a, b) => a.id - b.id);
    for (const { id, obs, records, callback, report } of batch) {
      d.moRemoveTransients(id);
      if (!records.length) continue;
      try { callback.call(obs, records, obs); }
      catch (e) {
        // Per WebIDL, a throwing observer callback "reports the exception" on the
        // CALLBACK's realm global (a cross-realm observer reports on its own
        // frame's onerror), not here. `__csimReportCallbackError` routes via the
        // callback's [[Realm]]; same-realm falls back to a local report.
        try { report(callback, e); } catch (_) { logThrew('MO callback', e); }
      }
    }
    for (const fire of slots) fire();
  } finally {
    flags[NOTIFYING] = 0;
    // (…and the microtask a callback's change queued, which ran — and did nothing — during the notification, again)
    if (flags[MICROTASK_QUEUED]) Promise.resolve().then(runQueuedDelivery);
  }
}
// …this realm's part of it: its pending observers' records, taken, and its signaled slots' firing.
globalThis.__csimTakeMutationBatch = (batch, slots) => {
  for (const obs of observers.values()) {
    const state = observerState(obs);
    if (!state.records.length && !transientsPending.has(obs)) continue;
    batch.push({ id: state.id, obs, records: state.records, callback: state.callback, report: globalThis.__csimReportCallbackError });
    state.records = [];
  }
  transientsPending.clear();
  const signaled = takeSignaledSlots();
  if (signaled) slots.push(() => fireSignaledSlots(signaled));
};
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

