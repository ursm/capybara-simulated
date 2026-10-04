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
import { arenaChildListChanged, foreignRealmOf, REALM as NATIVE_REALM } from './native-query-shadow.js';
import { scheduleCascadeRefresh, bumpCascadeVersion, bumpStructureGen } from './cascade.js';

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
    if (!n || n.nodeType !== 1) continue;
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
  if (owner._sheet) { owner._sheet._ownerNode = null; owner._sheet = null; }
}

// A `<link>`'s or `<style>`'s attribute that selects or obtains its sheet — HTML's attribute change steps, so here, where
// every write arrives (`setAttribute` / `setAttributeNS`, an `Attr`'s value, `attributes.setNamedItem`, a removal),
// rather than in `setAttribute` alone: the others left `<style media=print>` switched to `screen` applying nothing.
// A `<style>`'s `type` decides whether it has a sheet at all (`styleElementIsCss`). `media` / `title` only re-select
// the sheet (which set it is in, whether its query holds), and the sheet's media list
// follows the attribute on the same sheet object, as Chrome's `sheet.media.mediaText` does. A `<link>`'s `disabled`
// disassociates its sheet, and removing it sets "explicitly enabled" and obtains the sheet again, as a `rel` change does
// (`maybeFireLinkLoad`: the resource may newly be a stylesheet). (`href` has its own IDL setter and image path.) A
// shadow tree's sheet re-selects through the route its text edits take (`stylesheetChanged`), which the document's
// refresh alone never reached.
const LINK_SHEET_ATTRS = new Set(['rel', 'media', 'title', 'disabled']);
const STYLE_SHEET_ATTRS = new Set(['media', 'title', 'type']);
function sheetAttrChanged(el, name, value) {
  if (el._tag === 'link') {
    if (!LINK_SHEET_ATTRS.has(name)) return;
    // (…`disabled` disassociates its sheet and removing it obtains one again, as `rel` does: a new sheet either way)
    if (name === 'disabled' && value == null) el._explicitlyEnabled = true;
    if (name === 'disabled' || name === 'rel') sheetOwnerRenewed(el);
  } else if (el._tag !== 'style' || !STYLE_SHEET_ATTRS.has(name)) {
    return;
  }
  if (name === 'media' && el._sheet) el._sheet.media.mediaText = value == null ? '' : value;
  // (…a `<style>`'s `type` re-runs "update a style block": a sheet again is a new one)
  if (name === 'type') sheetOwnerRenewed(el);
  stylesheetChanged(el);
  if ((name === 'rel' || (name === 'disabled' && value == null)) && globalThis.__csim_onLinkHrefAssigned) globalThis.__csim_onLinkHrefAssigned(el);
}

// Per DOM §4.3.2, the records handed to an observer callback are
// `MutationRecord` platform objects. We build them as plain object literals
// (own data properties for every IDL attribute) whose prototype is set to
// `MutationRecord.prototype` AT CONSTRUCTION (the `__proto__:` literal key, so
// `record instanceof MutationRecord` holds) — rather than `Object.setPrototypeOf`
// after the fact, which would re-shape each record on this hot path. No
// accessor-only getters, so the literal / spread construction paths stay
// simple. The interface object is exposed globally for the `instanceof`
// checks pages and WPT rely on.
export class MutationRecord {}
globalThis.MutationRecord = MutationRecord;
const RECORD_PROTO = MutationRecord.prototype;

const observers = new Set();

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
      markLayoutDirty(p, p.nodeType === 1 && (rec.children || (rec.text && !!last && last.nodeType === 3)));
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
export function bumpSettleGen() {
  settleGen = (settleGen + 1) | 0;
  treeGen = (treeGen + 1) | 0;
  // An observable DOM change asks for a rendering update, as it does in a browser: this is the one
  // place every mutation funnels through, and IntersectionObserver targets can only have changed
  // when something changed. The scheduler queues ONE microtask per turn and the update itself
  // returns immediately unless the geometry generation actually moved, so this is not a per-mutation
  // cost — but without it a target revealed by a class change (Avo's tabs unhide a lazy
  // `<turbo-frame>`) never fires, because the settle loop only steps when something is pending.
  const schedule = globalThis.__csimScheduleIntersectionUpdate;
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
export function bumpTreeGen() { treeGen = (treeGen + 1) | 0; }
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

export class MutationObserver {
  constructor(callback) {
    this._cb       = callback;
    this._observed = [];
    this._records  = [];
  }
  observe(target, options) {
    if (!target) return;
    const raw  = options || {};
    const opts = Object.assign({}, raw);
    // Spec: attributeOldValue / attributeFilter imply `attributes`, and
    // characterDataOldValue implies `characterData` — but ONLY when the
    // base type is ABSENT. An explicitly-`false` base is a conflict, not
    // something to coerce (see the validation throws below).
    if (('attributeOldValue' in raw || 'attributeFilter' in raw) && !('attributes' in raw))     opts.attributes    = true;
    if (('characterDataOldValue' in raw)                          && !('characterData' in raw)) opts.characterData = true;
    // Spec validation: at least one type must be observed, and the
    // *OldValue / attributeFilter opt-ins can't contradict a false base.
    if (!opts.childList && !opts.attributes && !opts.characterData) {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    }
    if (opts.attributeOldValue && !opts.attributes) {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.");
    }
    if (opts.attributeFilter && !opts.attributes) {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object may only set 'attributeFilter' when 'attributes' is true or not present.");
    }
    if (opts.characterDataOldValue && !opts.characterData) {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.");
    }
    // Spec "observe": if a registration for this target already exists
    // for this observer, REPLACE its options in place rather than
    // appending a second registration.
    for (const entry of this._observed) {
      if (entry.target === target) {
        entry.options = opts;
        observers.add(this);
        return;
      }
    }
    this._observed.push({target, options: opts});
    observers.add(this);
  }
  disconnect() {
    this._observed = [];
    this._records  = [];
    observers.delete(this);
  }
  takeRecords() {
    const out = this._records;
    this._records = [];
    return out;
  }
}

// Returns the matching registration (so callers can honour its
// per-observer opt-ins), or null when this entry doesn't observe `rec`.
function matchEntry(entry, rec) {
  const opts = entry.options;
  if (rec.type === 'childList'     && !opts.childList)                          return null;
  if (rec.type === 'attributes'    && !opts.attributes && !opts.attributeFilter) return null;
  if (rec.type === 'characterData' && !opts.characterData)                       return null;
  if (rec.type === 'attributes' && opts.attributeFilter &&
      opts.attributeFilter.indexOf(rec.attributeName) === -1) return null;
  if (rec.target === entry.target) return entry;
  if (!opts.subtree) return null;
  for (let cur = rec.target; cur; cur = cur._parent) {
    if (cur === entry.target) return entry;
  }
  return null;
}

function queueRecord(rec) {
  if (observers.size === 0) return;
  let queued = false;
  for (const obs of observers) {
    for (const entry of obs._observed) {
      const matched = matchEntry(entry, rec);
      if (matched) {
        // Spec: an observer only receives `oldValue` when it opted in
        // via attributeOldValue / characterDataOldValue. Deliver a
        // per-observer copy with oldValue nulled out otherwise. Keep
        // the shared record (and the primitive fast path) when the
        // observer DID opt in.
        if (rec.oldValue == null ||
            (rec.type === 'attributes'    && matched.options.attributeOldValue) ||
            (rec.type === 'characterData' && matched.options.characterDataOldValue)) {
          obs._records.push(rec);
        } else {
          obs._records.push({__proto__: RECORD_PROTO, ...rec, oldValue: null});
        }
        queued = true;
        break;
      }
    }
  }
  // Schedule a microtask-time delivery so MO callbacks fire for
  // direct DOM mutations (insertBefore / removeChild / data= setter)
  // too — not just for mutations queued inside a dispatchEvent chain.
  // Without this, PM's domchange observer never sees `set()`-driven
  // edits to its contenteditable.
  if (queued) scheduleMutationDelivery();
}

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
  if (!(m && m.ns)) sheetAttrChanged(target, lkey, target._attrs[key]);
  // The writer's box and its subtree — its own box may read the attribute however the selectors fall, the ancestor walk
  // is what re-derives the flow around it, and its descendants inherit from it. What else the write restyles — a
  // `body.os-pc .os-host` under it, the `.c` of a `.c:has(.flag)` above it — is the style engine's to say, and it marks
  // those as it restyles them (layout.js `markRestyles`).
  markLayoutDirty(target, true);
  bumpSettleGen();
  if (slotAttrHook && (key === 'slot' || key === 'name')) slotAttrHook(target, key);
  if (observers.size === 0) return;
  queueRecord({
    __proto__:      RECORD_PROTO,
    type:           'attributes',
    target,
    attributeName:  m ? m.localName : key,
    attributeNamespace: m ? m.ns : null,
    oldValue,
    addedNodes:    [],
    removedNodes:  [],
    previousSibling: null,
    nextSibling:    null
  });
}
export function recordChildList(target, added, removed, prevSibling, nextSibling) {
  arenaChildListChanged(target, added, removed, nextSibling);
  // The target's box and, for an element or a shadow root, its subtree, as an attribute write marks the writer's: what
  // the selectors read of a child list — positions, `:empty`, a `:has()` above — the style engine marks as it restyles.
  markLayoutDirty(target, !!target && (target.nodeType === 1 || !!target._isShadowRoot));
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
  if (observers.size === 0) return;
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
  queueRecord({
    __proto__:      RECORD_PROTO,
    type:           'childList',
    target,
    addedNodes:    added.slice(),
    removedNodes:  removed.slice(),
    attributeName: null,
    attributeNamespace: null,
    oldValue:      null,
    previousSibling,
    nextSibling:    next
  });
}
export function recordCharacterData(target, oldValue) {
  markLayoutDirty(target);
  bumpSettleGen();
  // …and its element's subtree where `:empty` can have flipped, as a child-list change marks it.
  const parent = target._parent;
  if (parent && parent.nodeType === 1 && !oldValue !== !target._data) markLayoutDirty(parent, true);
  // Editing a connected `<style>`'s text changes its rules — re-parse the block (discarding
  // CSSOM edits), same as a childList change.
  if (target && target._parent && target._parent._tag === 'style') styleBlockChanged(target._parent);
  if (observers.size === 0) return;
  queueRecord({
    __proto__:      RECORD_PROTO,
    type:           'characterData',
    target,
    addedNodes:    [],
    removedNodes:  [],
    attributeName: null,
    attributeNamespace: null,
    oldValue,
    previousSibling: null,
    nextSibling:    null
  });
}

let deliveringMutations = false;
// Per spec, MutationObserver delivery is "one pass per microtask
// checkpoint" — records queued during the cb are NOT delivered in
// the same pass; they wait for the next checkpoint.
export function deliverMutations() {
  if (deliveringMutations) return;
  deliveringMutations = true;
  try {
    const slotsToFire = takeSignaledSlots();
    // Snapshot the notify set and TAKE each observer's records BEFORE invoking
    // any callback (DOM "notify mutation observers"). A record queued during a
    // callback lands in the observer's now-empty list and is delivered at the
    // NEXT checkpoint — even if that observer hasn't been visited yet this pass
    // (iterating `observers` live would mis-deliver it in the same pass, firing
    // its callback before this pass's slotchange and breaking the compound-
    // microtask ordering).
    const batch = [];
    for (const obs of observers) {
      if (!obs._records.length) continue;
      batch.push([obs, obs._records]);
      obs._records = [];
    }
    for (const [obs, mine] of batch) {
      try { obs._cb(mine, obs); }
      catch (e) {
        // Per WebIDL, a throwing observer callback "reports the exception" on the
        // CALLBACK's realm global (a cross-realm observer reports on its own
        // frame's onerror), not here. `__csimReportCallbackError` routes via the
        // callback's [[Realm]]; same-realm falls back to a local report.
        try { globalThis.__csimReportCallbackError(obs._cb, e); } catch (_) { logThrew('MO callback', e); }
      }
    }
    // Slot changes captured at the top fire after the MO callbacks, per DOM
    // "notify mutation observers" (slots signaled during the callbacks above
    // were re-queued and fire next checkpoint).
    fireSignaledSlots(slotsToFire);
  } finally {
    deliveringMutations = false;
  }
}

export function hasQueuedRecords() {
  for (const obs of observers) {
    if (obs._records.length) return true;
  }
  return false;
}

// Synchronously run the pending MutationObserver / slotchange delivery (the
// compound microtask), the same one `scheduleMutationDelivery` defers. Lets a
// caller flush this specific microtask at a known checkpoint (HTML "clean up
// after running a script" between parser-run scripts) without draining the
// whole agent job queue — keeping cross-realm Promise timing untouched. Clears
// the pending flag so the already-scheduled microtask becomes a cheap no-op.
export function flushMutationDelivery() {
  if ((observers.size && hasQueuedRecords()) || signalSlots.size) {
    deliveryPending = false;
    deliverMutations();
  }
}

// Exposed so timer-drain (after firing each timer) and event dispatch
// can poll without importing the module.
export function hasObservers() { return observers.size > 0; }

let deliveryPending = false;
function scheduleMutationDelivery() {
  if (deliveryPending) return;
  deliveryPending = true;
  Promise.resolve().then(() => {
    deliveryPending = false;
    if ((observers.size && hasQueuedRecords()) || signalSlots.size) deliverMutations();
  });
}

globalThis.MutationObserver = MutationObserver;

