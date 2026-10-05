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
import { controlLiveValue }   from './form-helpers.js';
import {
  DocumentOrderRange,
  compareBoundaryPoint,
  rangeIntersectsNode,
  nodeContains
}                              from './dom-nodes.js';

function notifySelectionChange() {
  const doc = globalThis.document;
  if (!doc) return;
  try { dispatchEvent(doc, new Event('selectionchange', { bubbles: false, cancelable: false })); } catch (_) {}
}

class Selection {
  constructor() {
    this._ranges    = [];
    this._direction = 'none';  // 'forward' | 'backward' | 'none'
  }
  get rangeCount()  { return this._ranges.length; }
  get direction()   { return this._direction; }
  get isCollapsed() {
    if (!this._ranges.length) return true;
    return this._ranges[0].collapsed;
  }
  // The anchor is the range's start and the focus its end — the other way round once a selection was made backwards
  // (Selection API: "anchor" and "focus" follow the direction).
  get anchorNode()   { const r = this._ranges[0]; return r ? (this._direction === 'backward' ? r.endContainer : r.startContainer) : null; }
  get anchorOffset() { const r = this._ranges[0]; return r ? (this._direction === 'backward' ? r.endOffset : r.startOffset) : 0; }
  get focusNode()    { const r = this._ranges[0]; return r ? (this._direction === 'backward' ? r.startContainer : r.endContainer) : null; }
  get focusOffset()  { const r = this._ranges[0]; return r ? (this._direction === 'backward' ? r.startOffset : r.endOffset) : 0; }
  get type()         { return this._ranges.length ? (this.isCollapsed ? 'Caret' : 'Range') : 'None'; }
  toString() {
    // A focused text form control's internal selection surfaces through
    // window.getSelection().toString() as the selected slice of its RAW (visible)
    // value — NOT the sanitized IDL `.value` (an email field shows the unsanitized
    // typed text " foo@bar ", a number field the raw digits). Real browsers reflect
    // the control's selection here even though it isn't a document Range.
    const ae = globalThis.document && globalThis.document.activeElement;
    if (ae && (ae._tag === 'textarea' || ae._tag === 'input') &&
        ae._selectionStart != null && ae._selectionEnd != null &&
        ae._selectionEnd > ae._selectionStart) {
      return String(controlLiveValue(ae)).slice(ae._selectionStart, ae._selectionEnd);
    }
    return this._ranges.length ? this._ranges[0].toString() : '';
  }
  getRangeAt(i)     { return this._ranges[i] || null; }
  // (…a Range of any realm, and nothing where the selection has one already: Selection API `addRange`)
  addRange(r) {
    if (!globalThis.__dom.isRange(r)) throw new TypeError("Failed to execute 'addRange' on 'Selection': parameter 1 is not of type 'Range'.");
    if (this._ranges.length) return;
    this._ranges = [r];
    notifySelectionChange();
  }
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
    this._direction = 'none';
    notifySelectionChange();
  }
  // (…each a new range, the old one a script may hold left as it was)
  collapseToStart() {
    if (!this._ranges.length) throw new Error('InvalidStateError: no range');
    const r = this._ranges[0];
    this.collapse(r.startContainer, r.startOffset);
  }
  collapseToEnd() {
    if (!this._ranges.length) throw new Error('InvalidStateError: no range');
    const r = this._ranges[0];
    this.collapse(r.endContainer, r.endOffset);
  }
  selectAllChildren(node) {
    if (!node) return;
    const r = new DocumentOrderRange();
    r.setStart(node, 0);
    const count = node._children ? node._children.length : 0;
    r.setEnd(node, count);
    this._ranges = [r];
    this._direction = 'none';
    notifySelectionChange();
  }
  // Selection API `extend`: the focus moves to (node, offset), the anchor stays — the range runs from whichever of the
  // two comes first, the direction saying which (a focus in another tree collapses it there). PM uses this to expand
  // a selection from a known anchor.
  extend(node, offset) {
    if (!this._ranges.length) throw new Error('InvalidStateError: no range');
    this._span(this.anchorNode, this.anchorOffset, node, offset | 0);
    notifySelectionChange();
  }
  setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
    this._span(anchorNode, anchorOffset | 0, focusNode, focusOffset | 0);
    notifySelectionChange();
  }
  // The selection's range is from (anchor, anchorOffset) to (focus, focusOffset), in whichever order they are in.
  _span(anchor, anchorOffset, focus, focusOffset) {
    const r = new DocumentOrderRange();   // (…a new range, the old one a script may hold left as it was)
    const order = compareBoundaryPoint(anchor, anchorOffset, focus, focusOffset);
    if (order === null) {
      r.setStart(focus, focusOffset);
      r.collapse(true);
      this._direction = 'none';
    } else if (order <= 0) {
      r.setStart(anchor, anchorOffset);
      r.setEnd(focus, focusOffset);
      this._direction = order === 0 ? 'none' : 'forward';
    } else {
      r.setStart(focus, focusOffset);
      r.setEnd(anchor, anchorOffset);
      this._direction = 'backward';
    }
    this._ranges = [r];
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
  // CSS Editing module: modify(alter, direction, granularity). We
  // don't model layout-aware motion (word/line), but spec-correct
  // single-character / per-element motion through the selection is
  // enough for Tiptap/ProseMirror's keyboard navigation polyfill.
  // `alter`: "move" (anchor follows) | "extend" (anchor stays)
  // `direction`: "forward" | "backward" | "left" | "right"
  // `granularity`: "character" | "word" | "line" | "lineboundary" | etc.
  modify(alter, direction, _granularity) {
    if (!this._ranges.length) return;
    const forward = direction === 'forward' || direction === 'right';
    // Move focus by ±1 within the current text node; no-op at boundaries.
    const focus = this.focusNode;
    if (focus && focus.nodeType === 3) {
      const len = (focus.data || '').length;
      const next = forward ? Math.min(len, this.focusOffset + 1) : Math.max(0, this.focusOffset - 1);
      if (alter === 'move') this.collapse(focus, next);
      else this.extend(focus, next);
    }
  }
}

const sharedSelection = new Selection();

globalThis.Selection                 = Selection;
globalThis.getSelection              = function () { return sharedSelection; };
globalThis.__notifySelectionChange   = notifySelectionChange;
