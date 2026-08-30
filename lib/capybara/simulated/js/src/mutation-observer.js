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
import { flatTreeParent } from './walk.js';
import { scheduleCascadeRefresh, bumpCascadeVersion, classWriteLayoutEffect, ctxAttrEffect, ctxChildListEffect, ctxCharDataEffect, bumpCtxInserted } from './cascade.js';

// A childList add/remove whose direct nodes include a `<style>` / `<link>` (or a
// characterData edit to a `<style>`'s text) changes the resolved cascade with no
// per-element attr mutation; schedule a coalesced rebuild so the cascade-keyed
// memos invalidate. Shallow (direct-node) check to stay cheap on the hot path —
// the dominant dynamic-stylesheet pattern is `head.appendChild(styleEl)`.
function touchesStylesheet(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i] && nodes[i]._tag;
    if (t === 'style' || t === 'link') return true;
  }
  return false;
}
// A stylesheet change under a SHADOW ROOT is invisible to the document cascade's content key
// (`rebuildCascade` early-returns unchanged), while the per-root scoped rules and every memo key
// on the cascade VERSION — so move that directly. A document-tree change goes through the
// scheduled rebuild, which moves the version itself when the key differs.
function stylesheetChanged(node) {
  for (let n = node; n; n = n._parent) {
    if (n._isShadowRoot) { bumpCascadeVersion(); return; }
  }
  scheduleCascadeRefresh();
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

// Every element whose own layout inputs may have changed carries the sequence number of the
// mutation that last touched it — itself, or anything inside it, because a box is measured from
// its whole subtree. The layout's per-element memos (text widths, intrinsic widths, edge insets,
// a table's columns) key on it instead of on the layout PASS, so a pass that follows one mutation
// keeps every measurement it made for the rest of the page. Measured on a 300-row table: a
// mutate-then-read pair costs 34 ms when every memo dies with the pass and 8 ms when it does not.
let dirtySeq = 0;
export function currentDirtySeq() { return dirtySeq; }
// …and WHEN the page last changed anything, on the driver's own clock. A CSS transition starts at
// the style change that provoked it, not at the moment something first looks — and since the value
// model is lazy, those are different times whenever the clock has stepped in between (measured: a
// transition reversed by a `style` write reported the pre-reversal value for as long as the driver
// took to read it). This is the best proxy available for the style change event: every mutation
// that can move a box comes through here, and a `style` write is one.
let mutatedAt = 0;
export function lastMutationAt() { return mutatedAt; }
function stampMutation() { mutatedAt = globalThis.__virtualNow ? globalThis.__virtualNow() : 0; }
globalThis.__csimDirtySeq = () => dirtySeq;
// Walking to the root is O(depth) per mutation, which is nothing beside the pass it saves.
//
// A change that can alter INHERITED style — a `class` or `style` write, or an attribute some
// selector reads — invalidates what is measured INSIDE the element too (its text, in its font).
// Walking down to say so is O(subtree), and a component framework rewrites a container's class on
// every render: measured on Discourse, that walk alone cost 4.1s of a 40.6s spec file. So the
// element records the sequence at which its subtree was last invalidated (`_lbSubDirty`) and a
// descendant compares against the deepest such mark above it — the walk becomes O(depth), on the
// read side, where it is shared by everything under that element.
let subtreeMarks = 0;
// Diagnostic: how many SUBTREE-scoped layout invalidations have happened — the expensive kind
// (every descendant's box memo dies). Specs assert a paint-only or no-op class write does NOT
// increment it; geometry alone cannot distinguish "memo survived" from "recomputed equal".
globalThis.__csimSubtreeMarks = () => subtreeMarks;
// …and the marker itself, for the one caller that cannot IMPORT it: layout.js needs to dirty the
// tree before a paint (see `recordingRuns`), and an import edge from layout to this module
// reorders initialisation enough to break the slot hooks dom-nodes installs here.
globalThis.__csimMarkLayoutDirty = (node, alsoSubtree, structural) => markLayoutDirty(node, alsoSubtree, structural);
export function markLayoutDirty(node, alsoSubtree, structural) {
  if (!node) return;
  stampMutation();
  if (alsoSubtree) subtreeMarks++;
  const seq = ++dirtySeq;
  // Up the FLAT tree, which is the chain of boxes that actually lays this node out — a slotted
  // node's parent box is the SLOT, and a shadow-tree box's is the HOST. Walking `_parent` marked
  // the light-DOM ancestors of a slotted node and skipped every shadow-side box between the slot
  // and the host, so those kept their memos and `reuseSubtree` handed the same stale boxes back
  // for good: writing `height: 200px` on slotted content moved nothing at all until something on
  // the shadow side happened to be touched. The read side (`inheritedDirty`) always walked the
  // flat tree; this is the write side agreeing with it.
  //
  // The node ITSELF is stamped first — `flatTreeParent` answers for elements, and a text node's
  // box lives in its parent's line either way.
  //
  // A STRUCTURAL change — a child added or removed — is the only kind that can change what a
  // table's grid is made of, so the grid survives every attribute write under it.
  node._lbDirty = seq;
  if (structural) node._lbStruct = seq;
  for (let n = flatTreeParent(node); n; n = flatTreeParent(n)) {
    n._lbDirty = seq;
    if (structural) n._lbStruct = seq;
  }
  if (alsoSubtree) node._lbSubDirty = seq;
}

// A node that MOVED: its own box, and its descendants', can depend on where it now is. Its new
// ancestors were stamped by the caller's own `markLayoutDirty(target, …)`, so this stamps the
// arriving node and its subtree and skips the walk that would repeat.
export function markMovedSubtree(node) {
  if (!node) return;
  stampMutation();
  subtreeMarks++;
  const seq = ++dirtySeq;
  node._lbDirty = seq;
  node._lbStruct = seq;
  node._lbSubDirty = seq;
}

// Attributes a box is built from directly, whatever the page's stylesheets say. Anything else has
// to be asked about — `__csimAttrIsStyled`, which the cascade publishes from the selectors it
// parsed.
const STYLE_ATTRS = new globalThis.Set([
  'style', 'class', 'id', 'hidden', 'width', 'height', 'size', 'rows', 'cols', 'span', 'colspan',
  'rowspan', 'src', 'srcset', 'sizes', 'type', 'align', 'valign', 'dir', 'lang', 'open', 'multiple',
  'selected', 'checked', 'value', 'disabled', 'readonly', 'placeholder', 'start', 'reversed',
  'wrap', 'nowrap', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'face', 'color', 'controls',
  'poster', 'media', 'slot', 'is', 'popover', 'inert', 'contenteditable', 'translate', 'label',
  // …and the shadow-part names, which decide which `::part()` rules from the outer tree apply.
  'part', 'exportparts'
]);
function attrChangesStyle(name) {
  if (STYLE_ATTRS.has(name)) return true;
  const styled = globalThis.__csimAttrIsStyled;
  return styled ? styled(name) : true;
}

let settleGen = 0;
export function bumpSettleGen() {
  settleGen = (settleGen + 1) | 0;
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

// ── style-state generation ──────────────────────────────────────────────────
// The cascade matches selectors LIVE on every read, which is how a DYNAMIC pseudo-class takes
// effect at all — `:state()`, `:focus`, `:defined`. Most of what those read already moves
// `settleGen` (an attribute, the tree, a form control's checkedness, the location) or
// `cascadeVersion` (a stylesheet), but a few kinds of state move neither. This counter carries
// exactly those: `cascadeGeneration` keys the flow-sides memo on the union, and the layout epoch
// listens to it while a dynamic rule can move a box. The declared-value / hide memos deliberately
// do NOT key on it — a read that considered a dynamic pseudo-class is never cached (the taint
// bracket), so the counter would only cold-start them per keystroke (`cascadeStyleEpoch`).
//
// It is deliberately NOT `settleGen`: that one also drives the settle loop and the
// IntersectionObserver scheduler, and a focus change is not a reason to keep settling.
let styleStateGen = 0;
// What flipped, for the scoped layout dirtying in cascade.js (`__csimApplyScopedStateDirty`): a
// writer that KNOWS — the focus / hover diff — passes `{ kinds, elements }` (the dynamic pseudo
// names that can have changed and the elements they changed on); a writer that doesn't passes
// nothing, and the next sweep is a full one over every dynamic rule's subjects. Hints only ever
// NARROW a sweep, so an unhinted writer costs time, never correctness. Capped: a page with no
// dynamic layout rule never sweeps, and the list must not grow across a long SPA session.
let pendingStateHints = [], pendingStateFull = false;
// The hint vocabularies the writers share with the sweep.
export const FOCUS_KINDS = new Set(['focus', 'focus-within', 'focus-visible']);
export const HOVER_KINDS = new Set(['hover']);
// What checkedness / selectedness feed: `:checked`, and the validity of the control (a required
// checkbox, a required select with no value) and of the form / fieldsets above it.
export const CHECKED_KINDS = new Set(['checked', 'valid', 'invalid', 'user-valid', 'user-invalid']);
export const TARGET_KINDS = new Set(['target']);
// What a control's live value feeds: its own placeholder / validity / range pseudos (and `:dir()`,
// which resolves `dir=auto` through the value), and the validity of the form and fieldsets above it
// (`form:valid` holds while every control does).
export const VALUE_KINDS = new Set(['placeholder-shown', 'valid', 'invalid', 'user-valid', 'user-invalid', 'in-range', 'out-of-range', 'dir']);
export function bumpStyleState(hint) {
  styleStateGen = (styleStateGen + 1) | 0;
  if (hint && pendingStateHints.length < 32) pendingStateHints.push(hint);
  else pendingStateFull = true;
}
export function takeStyleStateHints() {
  const taken = { full: pendingStateFull, hints: pendingStateHints };
  pendingStateHints = []; pendingStateFull = false;
  return taken;
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
  const lkey = String(key).toLowerCase();
  // A class write asks the TOKEN gate instead of the attribute-name one: only a flipped token
  // that some box-moving rule mentions can dirty anything beyond the element itself, and a
  // token mentioned only in NON-subject position dirties exactly the matching subjects in
  // scope — `body.os-pc .os-host { … }` no longer costs the whole page its layout memos when
  // OverlayScrollbars stamps a class on `<body>`.
  if (lkey === 'class') {
    const effect = classWriteLayoutEffect(oldValue, target._attrs['class']);
    if (effect === true) {
      markLayoutDirty(target, true);
    } else {
      // The element itself always takes the plain mark: its own box may read `[class]` however
      // the tokens fall, and the ancestor walk it performs is what re-derives the flow around it.
      markLayoutDirty(target, false);
      if (effect) {
        for (const [subjectKey, sibling] of effect.desc) {
          // Sibling combinators reach the writer's later siblings; the parent's subtree covers
          // them (and, for a `<html>`-level write, the document does).
          const scope = sibling ? (target._parent || target) : target;
          if (scope.querySelectorAll) {
            for (const el of scope.querySelectorAll(subjectKey)) markLayoutDirty(el, true);
          } else {
            markLayoutDirty(target, true);         // scope isn't queryable: stay conservative
          }
        }
      }
    }
  } else {
    markLayoutDirty(target, attrChangesStyle(lkey));
  }
  bumpSettleGen();
  // Element-local context epochs for the declaredValue memo (cascade.js `ctxEpochOf`): the
  // element's own always; its subtree / its siblings' subtrees only as far as the stylesheet's
  // selectors read this attribute there (`ctxAttrEffect` — the structural-context gate).
  ctxAttrEffect(target, lkey, oldValue, target._attrs[key]);
  if (slotAttrHook && (key === 'slot' || key === 'name')) slotAttrHook(target, key);
  if (observers.size === 0) return;
  const m = meta !== undefined ? meta : (target._attrNS && target._attrNS[key]);
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
  markLayoutDirty(target, false, true);
  // …and each ADDED node itself, with its subtree. `markLayoutDirty` stamps the target and its
  // ANCESTORS — never the arriving node — so a node that MOVED kept the box memo it built at its
  // old position for good. That only became reachable once a UA value could depend on where an
  // element IS rather than on its own cascade: move a measured `<ul>` into another list and it
  // kept its 16px block margins, with `marginTop` and `marginBlockStart` then disagreeing on the
  // same element. The cascade side already re-keys an inserted node (`bumpCtxInserted` below);
  // this is the layout side agreeing with it.
  for (const node of added) markMovedSubtree(node);
  bumpSettleGen();
  // Context epochs (see recordAttrMutation): a child-list change moves structural pseudo-classes
  // (`:nth-child`, `:empty`) of `target` and its children — and of everything under them only when
  // a rule reads a position in a non-subject compound (`ctxChildListEffect`). Each ADDED node is
  // re-keyed with its subtree: a moved element's new chain must never hash-collide with the one
  // its memo entry was keyed under.
  ctxChildListEffect(target);
  for (const n of added) bumpCtxInserted(n);
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
    target._styleTextDirty = true;
    stylesheetChanged(target);
  } else if ((added.length && touchesStylesheet(added)) ||
             (removed.length && touchesStylesheet(removed))) stylesheetChanged(target);
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
  // Context epoch: `:empty` (via the css-select adapter's getText) reads text DATA, so a
  // character-data edit can flip a structural match on the parent.
  const parent = target._parent;
  if (parent) ctxCharDataEffect(parent);
  // Editing a connected `<style>`'s text changes its rules — re-parse the block (discarding
  // CSSOM edits), same as a childList change.
  if (target && target._parent && target._parent._tag === 'style') {
    target._parent._styleTextDirty = true;
    stylesheetChanged(target._parent);
  }
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

