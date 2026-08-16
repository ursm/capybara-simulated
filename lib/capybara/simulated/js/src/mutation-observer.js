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
import { scheduleCascadeRefresh } from './cascade.js';

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
// `cascadeVersion` (a stylesheet), but a few kinds of state move neither, and anything that CACHES
// a cascade result has to see them. This counter carries exactly those, so `cascadeGeneration`
// can key a cache on the union.
//
// It is deliberately NOT `settleGen`: that one also drives the settle loop and the
// IntersectionObserver scheduler, and a focus change is not a reason to keep settling.
let styleStateGen = 0;
export function bumpStyleState() { styleStateGen = (styleStateGen + 1) | 0; }
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
  bumpSettleGen();
  // Element-local context epochs for the declaredValue memo (cascade.js `ctxEpochOf`): an
  // attribute change can alter which selectors match this element's SUBTREE (descendant
  // combinators read ancestor attributes) and its SIBLINGS' subtrees (`~` / `+` read preceding
  // siblings), so bump the element and its parent — every element whose ancestor chain contains
  // either recomputes. Deliberately NOT the whole document: that global cold is exactly what the
  // memo's old settleGen key cost.
  target._selEpoch = (target._selEpoch || 0) + 1;
  const parent = target._parent;
  if (parent) parent._selEpoch = (parent._selEpoch || 0) + 1;
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
  bumpSettleGen();
  // Context epochs (see recordAttrMutation): a child-list change moves structural pseudo-classes
  // (`:nth-child`, `:empty`) and the descendant/sibling context of everything under `target`, so
  // bump it — the chain hash of its whole subtree changes. Each ADDED node is bumped too: a moved
  // element's new chain must never hash-collide with the one its memo entry was keyed under.
  target._selEpoch = (target._selEpoch || 0) + 1;
  for (const n of added) n._selEpoch = (n._selEpoch || 0) + 1;
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
    scheduleCascadeRefresh();
  } else if ((added.length && touchesStylesheet(added)) ||
             (removed.length && touchesStylesheet(removed))) scheduleCascadeRefresh();
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
  bumpSettleGen();
  // Context epoch: `:empty` (via the css-select adapter's getText) reads text DATA, so a
  // character-data edit can flip a structural match on the parent.
  const parent = target._parent;
  if (parent) parent._selEpoch = (parent._selEpoch || 0) + 1;
  // Editing a connected `<style>`'s text changes its rules — re-parse the block (discarding
  // CSSOM edits), same as a childList change.
  if (target && target._parent && target._parent._tag === 'style') {
    target._parent._styleTextDirty = true;
    scheduleCascadeRefresh();
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

