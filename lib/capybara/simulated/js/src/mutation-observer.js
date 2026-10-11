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
import { isScriptElement } from './walk.js';
import { convertMutationObserverArguments, installMutationObserver, installMutationRecord } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { nodeList } from './dom-collections.js';
import {
  foreignRealmOf, relativeOf, RELATIVE_ROOT, RELATIVE_PREVIOUS, RELATIVE_NEXT, RELATIVE_LAST_CHILD, REALM as NATIVE_REALM
} from './native-query-shadow.js';
import { scheduleCascadeRefresh, bumpCascadeVersion, bumpStructureGen } from './cascade.js';
import { setEdgeWrittenSteps } from './tree.js';

// MutationObserverInit's options, as the engine takes them (mutation_observers.rs).
const CHILD_LIST = 1, ATTRIBUTES = 2, CHARACTER_DATA = 4, SUBTREE = 8, ATTRIBUTE_OLD_VALUE = 16, CHARACTER_DATA_OLD_VALUE = 32;

// A stylesheet change under a SHADOW ROOT is invisible to the document cascade's content key
// (`rebuildCascade` early-returns unchanged), while the per-root scoped rules and every memo key
// on the cascade VERSION — so move that directly. A document-tree change goes through the
// scheduled rebuild, which moves the version itself when the key differs.
function stylesheetChanged(node) {
  if (relativeOf(node, RELATIVE_ROOT)?._isShadowRoot === true) bumpCascadeVersion();
  else scheduleCascadeRefresh();
}

// A sheet owner obtains a new sheet (sheet_owners.rs: its count of them, which its engine sheet is made again for, and
// the faces it declares are keyed by: cascade.js `engineSheetOf`, `faceSource`) where HTML says — a `<style>`'s block
// updated, even to the same text, and an owner inserted or removed, however deep in the subtree that moved, a shadow tree
// included, which the engine counts as it writes the tree — or one of its attributes says (`sheetAttrChanged`); what a
// script edited of the one before is gone with it. How many changes of the tree did (the engine's count): a mutation
// takes it as it begins, and hands it to its record, which sees whether the mutation's own changes moved it.
export const sheetRenewals = () => globalThis.__dom.sheetRenewals[0];
// A `<link>`'s or `<style>`'s attribute that selects or obtains its sheet — HTML's attribute change steps, so here, where
// every write arrives (`setAttribute` / `setAttributeNS`, an `Attr`'s value, `attributes.setNamedItem`, a removal),
// rather than in `setAttribute` alone: the others left `<style media=print>` switched to `screen` applying nothing.
// A `<style>`'s `type` decides whether it has a sheet at all (`styleElementIsCss`). `media` / `title` only re-select
// the sheet (which set it is in, whether its query holds), and the sheet's media list
// follows the attribute on the same sheet object, as Chrome's `sheet.media.mediaText` does. A `<link>`'s `disabled`
// disassociates its sheet, and removing it sets "explicitly enabled" and obtains the sheet again, as a `rel` or `href`
// change does (`maybeFireLinkLoad`: the resource may newly be a stylesheet, or another one — fetched, its `load` fired);
// a `type` change obtains it again too (Chrome 155: a new sheet). A shadow tree's sheet re-selects through the route its
// text edits take (`stylesheetChanged`), which the document's refresh alone never reached.
const LINK_SHEET_ATTRS = new Set(['rel', 'href', 'type', 'media', 'title', 'disabled']);
const STYLE_SHEET_ATTRS = new Set(['media', 'title', 'type']);
function sheetAttrChanged(el, name, value, oldValue) {
  if (el._tag === 'link') {
    // (…an `href` or a `rel` set to the value it had changes nothing: the same resource — Chrome 155 keeps the sheet)
    if (!LINK_SHEET_ATTRS.has(name) || ((name === 'href' || name === 'rel') && value === oldValue)) return;
    // (…`disabled` disassociates its sheet and removing it obtains one again, as `rel` does: a new sheet either way)
    if (name === 'disabled' && value == null) el._explicitlyEnabled = true;
    if (name === 'disabled' || name === 'rel' || name === 'href' || name === 'type') globalThis.__dom.renewSheet(el._nid);
  } else if (el._tag !== 'style' || !STYLE_SHEET_ATTRS.has(name)) {
    return;
  }
  // (…its sheet's `media` and `title` follow the attribute on the same sheet object, while the owner has it)
  const sheet = el._sheet;
  if (sheet && name === 'media') sheet.media.mediaText = value == null ? '' : value;
  else if (sheet && name === 'title') slotsOf(sheet, 'CSSStyleSheet').title = value || null;
  // (…a `<style>`'s `type` re-runs "update a style block": a sheet again is a new one)
  if (name === 'type') globalThis.__dom.renewSheet(el._nid);
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
// microtask is queued and observers being notified, and whether anything is pending. Its pending observers and signal
// slots are the engine's to list, by realm (`moTakePending`); one notification takes them all.
const ANY_REGISTERED = 0, MICROTASK_QUEUED = 1, NOTIFYING = 2, PENDING = 3, STATE_CHANGED = 4;

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
}
function fireSignaledSlots(slots) {
  if (!slotChangeFirer) return;
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
      const last = relativeOf(p, RELATIVE_LAST_CHILD);
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

// DOM "queue a mutation record": a record of the change for each interested observer — the engine's to tell, and to
// queue (`moRecord`), whichever realm made the observer.
const RECORD_TYPE = { childList: 0, attributes: 1, characterData: 2 };
function queueRecord(type, target, fields) {
  const queued = globalThis.__dom.moRecord(target._nid, target, RECORD_TYPE[type], fields.addedNodes, fields.removedNodes,
    fields.previousSibling, fields.nextSibling, fields.attributeName, fields.attributeNamespace, fields.oldValue);
  // (…the notification scheduled at the microtask checkpoint, so MO callbacks fire for direct DOM mutations
  // (insertBefore / removeChild / data= setter) too, not just for mutations queued inside a dispatchEvent chain: PM's
  // domchange observer sees `set()`-driven edits to its contenteditable)
  if (queued) scheduleMutationDelivery();
}

// …and a write to the tree's edges (tree.js), which may have made an observer pending — given a transient registered
// observer as a node was removed or moved — or signaled a slot, the engine's either way.
setEdgeWrittenSteps(engineWritten);

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
  if (lkey === 'src' && oldValue == null && isScriptElement(target)) globalThis.__csimPrepareScript(target);
  const m = meta !== undefined ? meta : (target._attrNS && target._attrNS[key]);
  if (!(m && m.ns)) sheetAttrChanged(target, lkey, target._attrs[key], oldValue);
  // The writer's box and its subtree — its own box may read the attribute however the selectors fall, the ancestor walk
  // is what re-derives the flow around it, and its descendants inherit from it. What else the write restyles — a
  // `body.os-pc .os-host` under it, the `.c` of a `.c:has(.flag)` above it — is the style engine's to say, and it marks
  // those as it restyles them (layout.js `markRestyles`).
  markLayoutDirty(target, true);
  bumpSettleGen();
  engineWritten();
  if (!hasObservers()) return;
  queueRecord('attributes', target, {
    attributeName:      m ? m.localName : key,
    attributeNamespace: m ? m.ns : null,
    oldValue
  });
}
// (…`renewals` the count of sheet renewals as the mutation began — `sheetRenewals` — none for a parse's record, whose
// sheets the parse hands the cascade itself)
export function recordChildList(target, added, removed, prevSibling, nextSibling, renewals) {
  // The target's box and, for an element or a shadow root, its subtree, as an attribute write marks the writer's: what
  // the selectors read of a child list — positions, `:empty`, a `:has()` above — the style engine marks as it restyles.
  markLayoutDirty(target, !!target && (target._nodeType === 1 || !!target._isShadowRoot));
  // …and each ADDED node itself, with its subtree: a node that MOVED is measured where it is now.
  for (const node of added) markLayoutDirty(node, true);
  bumpSettleGen();
  // …and the structure generation: an insertion or removal stales every enclosing-root memo.
  bumpStructureGen();
  // A sheet owner inserted or removed, however deep, changes the cascade; so does a change to a `<style>`'s own children
  // (`style.textContent = …`), which updates its block — the sheet re-parsed from the text, any CSSOM edit discarded, even
  // of the same text (an empty text node appended).
  // (…and on a page with shadow trees, theirs too — an owner renewed in one inside what moved: their sheets are handed to
  // the style engine per cascade version, which no document refresh moves when the document's own sheets are the same)
  if (renewals !== undefined && sheetRenewals() !== renewals) {
    stylesheetChanged(target);
    if (globalThis.__csimShadowHostCount) bumpCascadeVersion();
  }
  if (!hasObservers()) return;
  // Per DOM spec a childList record carries the siblings adjacent to
  // the change. Explicit prev/next args win when a call site threads
  // them through (e.g. removals, where the removed node is detached by
  // record time so its own pointers are gone). Otherwise, for inserts
  // we derive from the added nodes still in the tree: the node before
  // the first added node and the node after the last added node, where
  // each is still the target's child.
  let previousSibling = prevSibling !== undefined ? prevSibling : null;
  let next            = nextSibling !== undefined ? nextSibling : null;
  if (prevSibling === undefined && nextSibling === undefined && added.length && target) {
    const first = added[0], last = added[added.length - 1];
    if (first._parent === target) previousSibling = relativeOf(first, RELATIVE_PREVIOUS);
    if (last._parent === target) next = relativeOf(last, RELATIVE_NEXT);
  }
  queueRecord('childList', target, {
    addedNodes:   added.slice(),
    removedNodes: removed.slice(),
    previousSibling,
    nextSibling:  next
  });
}
export function recordCharacterData(target, oldValue) {
  // (…data replaced by the same — a framework writing what is there — changes nothing a layout or a memo reads)
  const parent = target._parent;
  if (oldValue !== target._data) {
    markLayoutDirty(target);
    bumpSettleGen(true);
    // …and its element's subtree where `:empty` can have flipped, as a child-list change marks it.
    if (parent && parent._nodeType === 1 && !oldValue !== !target._data) markLayoutDirty(parent, true);
  }
  // Editing a `<style>`'s text — to the same, too — updates its block: a new sheet (sheet_owners.rs), its rules parsed
  // again and any CSSOM edit discarded, as a childList change does; the sheets `styleSheets` lists are found again.
  if (parent && parent._tag === 'style') {
    bumpTreeGen();
    stylesheetChanged(parent);
  }
  if (!hasObservers()) return;
  queueRecord('characterData', target, { oldValue });
}

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

