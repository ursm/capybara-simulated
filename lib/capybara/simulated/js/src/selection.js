// The Selection API, generated from its IDL: a document's selection, the one range a script or the user selected in it
// (or none) and the direction it was selected in — the engine's (selection.rs), which says what each member reads and
// which range a change selects, its points set on a new range the bindings make for it. Every Document with a browsing
// context has one, and here that is this realm's document alone — a document a DOMParser or `createHTMLDocument` made
// has none (its `getSelection` null), and `document.open()` keeps it. The range is held by reference: a script's changes
// to it are the selection's, and so are the DOM's, which update it as the live range it is.
//
// A change to it schedules a `selectionchange` at the document — a task, one at a time (Selection API §"Scheduling
// selectionchange event") — as a text control's own selection does at the control.

import { forgetCaretMove, rememberCaretMove, selectionModifyTarget } from './layout.js';
import { Event } from './events.js';
import { asciiLower } from './ascii.js';
import { isHtml } from './constants.js';
import { fireEvent } from './dispatch.js';
import { controlLiveValue, textSelectionOf } from './form-helpers.js';
import { installSelection } from './generated/bindings.js';
import { queueTask } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import {
  RANGE_BOTH,
  RANGE_END,
  StaticRange,
  boundaryNid,
  deleteRangeContents,
  newRange,
  setRangePoint
} from './dom-nodes.js';

const NODE_ELEMENT = 1;

// ── Scheduling selectionchange ──────────────────────────────────────────────────────────────────────────────────────────
// The targets — a document, a text control — with an event scheduled and not yet fired ("has scheduled selectionchange
// event").
const scheduled = new WeakSet();
export function scheduleSelectionChange(target) {
  if (scheduled.has(target)) return;
  scheduled.add(target);
  queueTask(() => {
    scheduled.delete(target);
    // (…an element's bubbles, a document's does not; the UA's, so trusted)
    fireEvent(target, new Event('selectionchange', { bubbles: target._nodeType === NODE_ELEMENT, cancelable: false }));
  });
}

// ── Selection ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// A selection's slots: its document, and its state, the engine's (`__dom.SelectionBase`).
const selectionOf = (o) => slotsOf(o, 'Selection');
registerInterface('Selection', (o) => selectionOf(o) !== undefined);
class Selection {
  constructor(token, document) {
    constructedBy(PLATFORM, token, 'Selection');
    makeSlots(this, 'Selection', { document, state: new globalThis.__dom.SelectionBase(document._nid) });
  }
}

// What a member reads (`selectionGet`), by the code the engine names it with.
const ANCHOR_NODE = 0, ANCHOR_OFFSET = 1, FOCUS_NODE = 2, FOCUS_OFFSET = 3, IS_COLLAPSED = 4, RANGE_COUNT = 5, TYPE = 6;
const DIRECTION = 7, RANGE = 8, COUNTED_RANGE = 9, FOCUS = 10, CONNECTED_RANGE = 11;
const read = (s, member) => globalThis.__dom.selectionGet(s.state, member);
// The directions a range is selected in.
const NONE = 0, FORWARD = 1, BACKWARD = 2;
// What a change came to (`selectionCollapse` …): nothing, a change — a selectionchange, and what a line-wise move left
// the caret with ended (layout.js `forgetCaretMove`) — or an error to throw, of `member`'s (`offset` the one it was
// given, where it names one).
const CHANGED = 1, EMPTY = 2, DOCTYPE = 3, OFFSET = 4, NOT_FOUND = 5;
// (…the realm's one selection's range kept beside it as each change leaves it — whether a Range write is to it, which
// every one asks, `__csimIsSelectionRange`, with no call into the engine)
let selectedRange = null;
function changed(s, outcome, member, offset) {
  if (outcome === CHANGED) {
    selectedRange = read(s, RANGE);
    forgetCaretMove();
    scheduleSelectionChange(s.document);
    return;
  }
  const fail = (message, name) => new DOMException(`Failed to execute '${member}' on 'Selection': ${message}`, name);
  if (outcome === EMPTY) throw fail('there is no selection.', 'InvalidStateError');
  if (outcome === DOCTYPE) throw fail('the node is a doctype.', 'InvalidNodeTypeError');
  if (outcome === OFFSET) {
    throw fail(offset === undefined ? "The offset is larger than the node's length." : `the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
  }
  if (outcome === NOT_FOUND) throw fail("the given range isn't in the selection.", 'NotFoundError');
}
// The range from (startNode, startOffset) to (endNode, endOffset) selected in `direction`, as it is — none of a
// script's checks: the driver's selecting, as the user does, wherever in the document (`__csimSelect`), and `modify`'s
// move, wherever the focus it moves from is.
function select(s, startNode, startOffset, endNode, endOffset, direction) {
  const range = fresh(s);
  setRangePoint(range, RANGE_BOTH, startNode, startOffset);
  if (endNode !== startNode || endOffset !== startOffset) setRangePoint(range, RANGE_END, endNode, endOffset);
  globalThis.__dom.selectionSet(s.state, range, direction);
  changed(s, CHANGED);
}
// (…a new range for a change to select, in the selection's document)
const fresh = (s) => newRange(s.document);

function collapse(s, node, offset, member = 'collapse') {
  if (node === null) {
    changed(s, globalThis.__dom.selectionCollapse(s.state, null), member);
    return;
  }
  changed(s, globalThis.__dom.selectionCollapse(s.state, fresh(s), node, boundaryNid(node), offset), member, offset);
}
function extend(s, node, offset) {
  changed(s, globalThis.__dom.selectionExtend(s.state, fresh(s), node, boundaryNid(node), offset), 'extend', offset);
}

installSelection(Selection, {
  get_anchorNode: (selection) => read(selectionOf(selection), ANCHOR_NODE),
  get_anchorOffset: (selection) => read(selectionOf(selection), ANCHOR_OFFSET),
  get_focusNode: (selection) => read(selectionOf(selection), FOCUS_NODE),
  get_focusOffset: (selection) => read(selectionOf(selection), FOCUS_OFFSET),
  get_isCollapsed: (selection) => read(selectionOf(selection), IS_COLLAPSED),
  get_rangeCount: (selection) => read(selectionOf(selection), RANGE_COUNT),
  get_type: (selection) => read(selectionOf(selection), TYPE),
  get_direction: (selection) => read(selectionOf(selection), DIRECTION),
  getRangeAt(selection, index) {
    const range = read(selectionOf(selection), COUNTED_RANGE);
    if (index !== 0 || range === null) {
      throw new DOMException(`Failed to execute 'getRangeAt' on 'Selection': ${index} is not a valid index.`, 'IndexSizeError');
    }
    return range;
  },
  addRange(selection, range) {
    const s = selectionOf(selection);
    changed(s, globalThis.__dom.selectionAddRange(s.state, range), 'addRange');
  },
  removeRange(selection, range) {
    const s = selectionOf(selection);
    changed(s, globalThis.__dom.selectionRemoveRange(s.state, range), 'removeRange');
  },
  removeAllRanges: (selection) => collapse(selectionOf(selection), null, 0),
  empty: (selection) => collapse(selectionOf(selection), null, 0),
  getComposedRanges(selection, options) {
    const s = selectionOf(selection);
    const composed = globalThis.__dom.selectionComposed(s.state, options.shadowRoots.map(boundaryNid));
    if (composed === null) return [];
    const [startContainer, startOffset, endContainer, endOffset] = composed;
    return [new StaticRange({ startContainer, startOffset, endContainer, endOffset })];
  },
  collapse: (selection, node, offset) => collapse(selectionOf(selection), node, offset),
  setPosition: (selection, node, offset) => collapse(selectionOf(selection), node, offset, 'setPosition'),
  collapseToStart(selection) {
    const s = selectionOf(selection);
    changed(s, globalThis.__dom.selectionCollapseTo(s.state, fresh(s), false), 'collapseToStart');
  },
  collapseToEnd(selection) {
    const s = selectionOf(selection);
    changed(s, globalThis.__dom.selectionCollapseTo(s.state, fresh(s), true), 'collapseToEnd');
  },
  extend: (selection, node, offset) => extend(selectionOf(selection), node, offset),
  setBaseAndExtent(selection, anchorNode, anchorOffset, focusNode, focusOffset) {
    const s = selectionOf(selection);
    changed(s, globalThis.__dom.selectionBaseAndExtent(s.state, fresh(s), anchorNode, boundaryNid(anchorNode), anchorOffset,
      focusNode, boundaryNid(focusNode), focusOffset), 'setBaseAndExtent');
  },
  selectAllChildren(selection, node) {
    const s = selectionOf(selection);
    changed(s, globalThis.__dom.selectionSelectChildren(s.state, fresh(s), node, boundaryNid(node)), 'selectAllChildren');
  },
  // The selection moved, or extended, by `granularity` in `direction` — where to, the engine's (`selectionModifyTarget`):
  // by a character or a word, a line or a paragraph, to the start or end of its line or of its editing host (or the
  // body). Sentence motion, and to a sentence's or paragraph's boundary, move nothing yet. (…'left' and 'right' by the
  // direction of the focus's text, from where the focus IS, before the move sets the direction; and the place kept for
  // the next line-wise move, as a key's is)
  modify(selection, alter, direction, granularity) {
    const s = selectionOf(selection);
    alter = asciiLower(alter);
    if (alter !== 'extend' && alter !== 'move') return;
    const focus = read(s, FOCUS);
    if (focus === null) return;
    const to = selectionModifyTarget(focus[0], focus[1], direction, granularity);
    if (to === undefined) return;
    const forward = to[0];
    globalThis.__dom.selectionDirect(s.state, forward);
    if (to.length === 1) return;
    const next = { node: to[1][0], offset: to[2], x: to[3], upstream: to[4] };
    if (alter === 'move') select(s, next.node, next.offset, next.node, next.offset, forward ? FORWARD : BACKWARD);
    else extend(s, next.node, next.offset);
    rememberCaretMove(next);
  },
  // (…the one member that changes the range rather than replacing it)
  deleteFromDocument(selection) {
    const range = read(selectionOf(selection), COUNTED_RANGE);
    if (range !== null) deleteRangeContents(range);
  },
  containsNode: (selection, node, allowPartialContainment) =>
    globalThis.__dom.selectionContains(selectionOf(selection).state, boundaryNid(node), allowPartialContainment),
  // The selected text — a focused text control's own selection, the slice of its raw (visible) value, which real
  // browsers report here though it is no range of the document's (an email field's unsanitized " foo@bar ", a number
  // field's raw digits) — or the range's.
  stringify: (selection) => selectionText(selectionOf(selection))
});

globalThis.Selection = Selection;
// (…the focused element its document's — a text control in a shadow tree too — and the range's text the engine's, through
// none of the members a page may replace)
function selectionText(s) {
  const active = s.document._activeElement;
  const sel = active && (isHtml(active, 'textarea') || isHtml(active, 'input')) ? textSelectionOf(active) : null;
  if (sel && sel.end > sel.start) return String(controlLiveValue(active)).slice(sel.start, sel.end);
  const range = read(s, RANGE);
  return range === null ? '' : globalThis.__dom.rangeText(range);
}

// This realm's document's selection — its Window's `getSelection` (window.js) and its Document's: a document with no
// browsing context has none.
// (…another realm's document — `Document.prototype.getSelection.call(frame.contentDocument)` — its own realm's, asked
// through its hook rather than its window's replaceable `getSelection`)
let documentSelection = null;
export function getSelection(doc = globalThis.document) {
  const window = doc._window;
  if (!window) return null;
  if (doc !== globalThis.document) return window.__csimGetSelection(doc);
  return documentSelection ??= new Selection(PLATFORM, doc);
}
// …and what the driver does as the user does (dom-nodes.js, form-fields.js): reads its range, or null, and selects —
// where the user may, a shadow tree too, as a script may not (`selectAllChildren`, `addRange`) — and schedules the
// selectionchange of a change it made itself; hooks, as the modules that ask are this one's imports.
globalThis.__csimGetSelection = getSelection;
globalThis.__csimIsSelectionRange = (range) => range === selectedRange;
// …and the range it holds where that is in the document, a shadow tree in it included — none in the tree of a shadow
// host taken out, or at a node out of every tree a page's `setStart` named: what an edit and a driver's gesture act on.
globalThis.__csimSelectionRange = () => read(selectionOf(getSelection()), CONNECTED_RANGE);
globalThis.__csimSelect = (startNode, startOffset, endNode, endOffset) => {
  select(selectionOf(getSelection()), startNode, startOffset, endNode, endOffset, FORWARD);
};
globalThis.__csimScheduleSelectionChange = scheduleSelectionChange;
// …its focus as it is — [node, offset], null for none — wherever it is (the members a script reads say it only of a
// selection in the document's tree), and the collapse to a point, or the extend of the focus to one, that its members
// make — a script's checks each, through none of the members a page may have replaced.
globalThis.__csimSelectionFocus = () => read(selectionOf(getSelection()), FOCUS);
globalThis.__csimSelectionText = () => selectionText(selectionOf(getSelection()));
globalThis.__csimSelectionBackward = () => read(selectionOf(getSelection()), DIRECTION) === 'backward';
globalThis.__csimCollapseSelection = (node, offset) => collapse(selectionOf(getSelection()), node, offset);
globalThis.__csimExtendSelection = (node, offset) => extend(selectionOf(getSelection()), node, offset);
