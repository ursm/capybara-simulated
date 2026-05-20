// Selection API — `window.getSelection()`. Real apps reading
// `selection.toString()` for partial-quote / copy-on-select flows
// fall through to the "no selection" branch (length === 0) without
// crashing; PM / Tiptap / Trix drive the cursor through
// `collapse` / `extend` / `setBaseAndExtent` and read back via
// `anchorNode` / `focusNode`. A single shared Selection lives on
// `globalThis.getSelection()` — real browsers do too (per-window).
//
// `__notifySelectionChange()` fires `selectionchange` on document
// synchronously after every mutation. Libraries that update their
// internal cursor on selectionchange (PM/Tiptap) need a valid view
// state before the next `beforeinput` reads `view.state.selection`.

import { Event }              from './events.js';
import { dispatchEvent }      from './dispatch.js';
import {
  DocumentOrderRange,
  cloneRangeContents,
  rangeIntersectsNode,
  nodeContains
}                              from './dom-nodes.js';

function notifySelectionChange() {
  const doc = globalThis.document;
  if (!doc) return;
  try { dispatchEvent(doc, new Event('selectionchange', { bubbles: false, cancelable: false })); } catch (_) {}
}

class Selection {
  constructor() { this._ranges = []; }
  get rangeCount()  { return this._ranges.length; }
  get isCollapsed() {
    if (!this._ranges.length) return true;
    return this._ranges[0].collapsed;
  }
  get anchorNode()   { return this._ranges.length ? this._ranges[0].startContainer : null; }
  get focusNode()    { return this._ranges.length ? this._ranges[0].endContainer   : null; }
  get anchorOffset() { return this._ranges.length ? this._ranges[0].startOffset    : 0; }
  get focusOffset()  { return this._ranges.length ? this._ranges[0].endOffset      : 0; }
  get type()         { return this._ranges.length ? (this.isCollapsed ? 'Caret' : 'Range') : 'None'; }
  toString() {
    if (!this._ranges.length) return '';
    // Best-effort: emit the textContent of cloneContents() for the
    // first range. Not the spec algorithm (which walks the range
    // with whitespace collapsing) but matches what quote-reply and
    // the partial-quote tests inspect.
    const frag = cloneRangeContents(this._ranges[0]);
    return frag.textContent || '';
  }
  getRangeAt(i)     { return this._ranges[i] || null; }
  addRange(r)       { this._ranges = [r]; notifySelectionChange(); }
  removeRange(r)    { const i = this._ranges.indexOf(r); if (i >= 0) { this._ranges.splice(i, 1); notifySelectionChange(); } }
  removeAllRanges() { if (this._ranges.length) { this._ranges.length = 0; notifySelectionChange(); } }
  empty()           { this.removeAllRanges(); }
  // Per spec: `collapse(node, offset)` clears ranges and inserts a
  // single collapsed range at (node, offset). PM's editor uses this
  // (via `Selection.collapse(domNode, offset)`) to drive its cursor
  // position; rich-text libraries that drive their own focus call
  // it from selectionchange handlers.
  collapse(node, offset) {
    if (node == null) { this.removeAllRanges(); return; }
    const r = new DocumentOrderRange();
    r.setStart(node, offset || 0);
    r.setEnd(node, offset || 0);
    this._ranges = [r];
    notifySelectionChange();
  }
  collapseToStart() {
    if (!this._ranges.length) throw new Error('InvalidStateError: no range');
    const r = this._ranges[0];
    r.endContainer = r.startContainer;
    r.endOffset    = r.startOffset;
    notifySelectionChange();
  }
  collapseToEnd() {
    if (!this._ranges.length) throw new Error('InvalidStateError: no range');
    const r = this._ranges[0];
    r.startContainer = r.endContainer;
    r.startOffset    = r.endOffset;
    notifySelectionChange();
  }
  selectAllChildren(node) {
    if (!node) return;
    const r = new DocumentOrderRange();
    r.setStart(node, 0);
    const count = node._children ? node._children.length : 0;
    r.setEnd(node, count);
    this._ranges = [r];
    notifySelectionChange();
  }
  // Spec: extend the current range's focus to (node, offset). Anchor
  // stays; focus moves. We don't track direction separately, so just
  // update end to the new focus point. PM uses this to expand a
  // selection from a known anchor.
  extend(node, offset) {
    if (!this._ranges.length) throw new Error('InvalidStateError: no range');
    const r = this._ranges[0];
    r.endContainer = node;
    r.endOffset    = offset | 0;
    notifySelectionChange();
  }
  setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    const r = new DocumentOrderRange();
    r.setStart(anchorNode, anchorOffset | 0);
    r.setEnd(focusNode,    focusOffset  | 0);
    this._ranges = [r];
    notifySelectionChange();
  }
  setPosition(node, offset) { this.collapse(node, offset); }
  // True if `node` is contained (fully if `partial` is false, or
  // even partially if `partial` is true) within any range of the
  // selection. quote-reply gates `isSelected` on this for the
  // "selection partially covers target element" check before
  // walking the range.
  containsNode(node, partial) {
    for (const r of this._ranges) {
      if (rangeIntersectsNode(r, node)) {
        if (partial) return true;
        // Strict full containment: range start at-or-before node,
        // end at-or-after.
        if (nodeContains(r.startContainer, node) === false &&
            nodeContains(r.endContainer, node) === false &&
            nodeContains(node, r.startContainer) === true &&
            nodeContains(node, r.endContainer) === true) {
          return true;
        }
      }
    }
    return false;
  }
  deleteFromDocument() {}
}

const sharedSelection = new Selection();

globalThis.Selection                 = Selection;
globalThis.getSelection              = function () { return sharedSelection; };
globalThis.__notifySelectionChange   = notifySelectionChange;
