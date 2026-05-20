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

function recordMatches(entry, rec) {
  const opts = entry.options;
  if (rec.type === 'childList'     && !opts.childList)                          return false;
  if (rec.type === 'attributes'    && !opts.attributes && !opts.attributeFilter) return false;
  if (rec.type === 'characterData' && !opts.characterData)                       return false;
  if (rec.type === 'attributes' && opts.attributeFilter &&
      opts.attributeFilter.indexOf(rec.attributeName) === -1) return false;
  if (rec.target === entry.target) return true;
  if (!opts.subtree) return false;
  for (let cur = rec.target; cur; cur = cur._parent) {
    if (cur === entry.target) return true;
  }
  return false;
}

function queueRecord(rec) {
  if (observers.size === 0) return;
  let queued = false;
  for (const obs of observers) {
    for (const entry of obs._observed) {
      if (recordMatches(entry, rec)) {
        obs._records.push(rec);
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
export function recordChildList(target, added, removed) {
  bumpSettleGen();
  if (observers.size === 0) return;
  queueRecord({
    type:           'childList',
    target,
    addedNodes:    added.slice(),
    removedNodes:  removed.slice(),
    attributeName: null,
    attributeNamespace: null,
    oldValue:      null,
    previousSibling: null,
    nextSibling:    null
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

