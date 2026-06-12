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

let settleGen = 0;
export function bumpSettleGen() { settleGen = (settleGen + 1) | 0; }
// Read-only accessor for hot host-fn paths that want to memoise a
// derived value (e.g. a <select>'s implicit-default option) and
// invalidate it on the next observable DOM change.
export function currentSettleGen() { return settleGen; }
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
  if ((added.length && touchesStylesheet(added)) ||
      (removed.length && touchesStylesheet(removed))) scheduleCascadeRefresh();
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
  // Editing a connected `<style>`'s text changes its rules.
  if (target && target._parent && target._parent._tag === 'style') scheduleCascadeRefresh();
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
    for (const obs of observers) {
      if (!obs._records.length) continue;
      const mine = obs._records;
      obs._records = [];
      try { obs._cb(mine, obs); }
      catch (e) {
        // Per WebIDL, a throwing observer callback "reports the exception" on the
        // CALLBACK's realm global (a cross-realm observer reports on its own
        // frame's onerror), not here. `__csimReportCallbackError` routes via the
        // callback's [[Realm]]; same-realm falls back to a local report.
        try { globalThis.__csimReportCallbackError(obs._cb, e); } catch (_) { logThrew('MO callback', e); }
      }
    }
    // Visibility-tracking IOs piggyback on the same drain so a
    // class/attribute mutation that uncovers a previously hidden
    // ancestor (Avo tabs' `.hidden` class removal) fires the lazy
    // `<turbo-frame>` inside.
    if (typeof globalThis.__recheckIntersectionObservers === 'function') {
      globalThis.__recheckIntersectionObservers();
    }
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

// Exposed so timer-drain (after firing each timer) and event dispatch
// can poll without importing the module.
export function hasObservers() { return observers.size > 0; }

let deliveryPending = false;
function scheduleMutationDelivery() {
  if (deliveryPending) return;
  deliveryPending = true;
  Promise.resolve().then(() => {
    deliveryPending = false;
    if (observers.size && hasQueuedRecords()) deliverMutations();
  });
}

globalThis.MutationObserver = MutationObserver;

