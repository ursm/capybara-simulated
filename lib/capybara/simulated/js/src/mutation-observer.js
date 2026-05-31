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
    // Spec: attributeOldValue / characterDataOldValue imply
    // attributes / characterData respectively.
    const opts = Object.assign({}, options || {});
    if (opts.attributeOldValue)     opts.attributes    = true;
    if (opts.characterDataOldValue) opts.characterData = true;
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
          obs._records.push(Object.assign({}, rec, {oldValue: null}));
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

export function recordAttrMutation(target, name, oldValue) {
  bumpSettleGen();
  if (observers.size === 0) return;
  queueRecord({
    type:           'attributes',
    target,
    attributeName:  name,
    attributeNamespace: null,
    oldValue,
    addedNodes:    [],
    removedNodes:  [],
    previousSibling: null,
    nextSibling:    null
  });
}
export function recordChildList(target, added, removed, prevSibling, nextSibling) {
  bumpSettleGen();
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
  if (observers.size === 0) return;
  queueRecord({
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
        logThrew('MO callback', e);
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

