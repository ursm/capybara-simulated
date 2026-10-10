// The Selection API, generated from its IDL: a document's selection, the one range a script or the user selected in it
// (or none) and the direction it was selected in. Every Document with a browsing context has one, and here that is
// this realm's document alone — a document a DOMParser or `createHTMLDocument` made has none (its `getSelection` null),
// and `document.open()` keeps it. The range is held by reference: a script's changes to it are the selection's, and so
// are the DOM's, which update it as the live range it is.
//
// A change to it schedules a `selectionchange` at the document — a task, one at a time (Selection API §"Scheduling
// selectionchange event") — as a text control's own selection does at the control.

import { Event } from './events.js';
import { asciiLower } from './ascii.js';
import { fireEvent } from './dispatch.js';
import { controlLiveValue, isContenteditable, textSelectionOf } from './form-helpers.js';
import { installSelection } from './generated/bindings.js';
import { queueTask } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import {
  RANGE_BOTH,
  RANGE_END,
  StaticRange,
  compareBoundaryPoint,
  deleteRangeContents,
  newRange,
  nodeLength,
  setRangePoint
} from './dom-nodes.js';

const NODE_ELEMENT = 1, NODE_TEXT = 3, NODE_DOCTYPE = 10;

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
// A selection's slots: its document, its range (or null: empty) and its direction — 'forward', 'backward' or 'none'.
const selectionOf = (o) => slotsOf(o, 'Selection');
registerInterface('Selection', (o) => selectionOf(o) !== undefined);
class Selection {
  constructor(token, document) {
    constructedBy(PLATFORM, token, 'Selection');
    makeSlots(this, 'Selection', { document, range: null, direction: 'none' });
  }
}

// The selection's range is `range` now, selected in `direction`: a change, a selectionchange. (The realm's one
// selection's range is kept beside it too, `selectedRange`: what every Range write asks of it, `__csimSelectionRange`.)
let selectedRange = null;
function setRange(s, range, direction) {
  s.range = selectedRange = range;
  s.direction = direction;
  scheduleSelectionChange(s.document);
}
// …and none.
function setEmpty(s) {
  if (s.range === null) return;
  s.range = selectedRange = null;
  scheduleSelectionChange(s.document);
}
// A new range, collapsed at (node, offset) — or from one point to another, the two in one tree and in order.
function rangeAt(s, node, offset) {
  const range = newRange(s.document);
  setRangePoint(range, RANGE_BOTH, node, offset);
  return range;
}
function rangeFrom(s, startNode, startOffset, endNode, endOffset) {
  const range = rangeAt(s, startNode, startOffset);
  setRangePoint(range, RANGE_END, endNode, endOffset);
  return range;
}

// Whether the selection's range is in its document's tree — not empty, and not in a shadow tree or out of the document
// (its two points are in one tree, so its start says): what rangeCount, getRangeAt, the anchor and focus, and
// deleteFromDocument answer for.
const inDocumentTree = (s) => s.range !== null && s.range.startContainer._getRootNode() === s.document;
// Whether the document is a shadow-including inclusive ancestor of `node` — where collapse, extend and setBaseAndExtent
// take a point at all.
const inDocument = (s, node) => node._getRootNode({ composed: true }) === s.document;
// The anchor and focus: the range's start and end, the other way round where it was selected backwards.
const anchorIsEnd = (s) => s.direction === 'backward';
const anchorOf = (s) => (anchorIsEnd(s) ? [s.range.endContainer, s.range.endOffset] : [s.range.startContainer, s.range.startOffset]);
const focusOf = (s) => (anchorIsEnd(s) ? [s.range.startContainer, s.range.startOffset] : [s.range.endContainer, s.range.endOffset]);

// (…a point a range cannot have — a doctype's, or one past its node's length — an error of `member`'s)
function checkPoint(member, node, offset) {
  if (node._nodeType === NODE_DOCTYPE) {
    throw new DOMException(`Failed to execute '${member}' on 'Selection': the node is a doctype.`, 'InvalidNodeTypeError');
  }
  if (offset > nodeLength(node)) {
    throw new DOMException(`Failed to execute '${member}' on 'Selection': the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
  }
}
const emptyError = (member) => new DOMException(`Failed to execute '${member}' on 'Selection': there is no selection.`, 'InvalidStateError');

function collapse(s, node, offset) {
  if (node === null) { setEmpty(s); return; }
  checkPoint('collapse', node, offset);
  if (!inDocument(s, node)) return;
  setRange(s, rangeAt(s, node, offset), 'none');
}
// The focus moves to (node, offset), the anchor stays: the range from whichever comes first — or collapsed at the new
// focus where that is in another tree than the range.
function extend(s, node, offset) {
  if (!inDocument(s, node)) return;
  if (s.range === null) throw emptyError('extend');
  checkPoint('extend', node, offset);
  const [anchorNode, anchorOffset] = anchorOf(s);
  if (node._getRootNode() !== s.range.startContainer._getRootNode()) {
    setRange(s, rangeAt(s, node, offset), 'forward');
  } else if (compareBoundaryPoint(anchorNode, anchorOffset, node, offset) <= 0) {
    setRange(s, rangeFrom(s, anchorNode, anchorOffset, node, offset), 'forward');
  } else {
    setRange(s, rangeFrom(s, node, offset, anchorNode, anchorOffset), 'backward');
  }
}

const MODIFY_DIRECTIONS = new Set([
  'forward',
  'backward',
  'left',
  'right'
]);
const MODIFY_GRANULARITIES = new Set([
  'character',
  'word',
  'sentence',
  'line',
  'paragraph',
  'lineboundary',
  'sentenceboundary',
  'paragraphboundary',
  'documentboundary'
]);

// Where `modify` moves a focus at (node, offset) by each granularity it moves by here, forward or backward.
// …by a character, or to the end of the next word or the start of the previous one (Intl.Segmenter's words), within a
// text node — its edge where there is none;
// (…the segmenter made at first use: an Intl object has no place in the snapshot)
let words = null;
function wordEdge(text, offset, forward) {
  let edge = forward ? text.length : 0;
  words ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  for (const { index, segment, isWordLike } of words.segment(text)) {
    if (!forward && index >= offset) break;
    if (!isWordLike) continue;
    if (forward && index + segment.length > offset) return index + segment.length;
    if (!forward) edge = index;
  }
  return edge;
}
// …and to the start or end of the editing host the focus is in — its outermost editable ancestor — or the body.
function boundaryRoot(node) {
  let root = null;
  for (let n = node; n; n = n._parent) if (n._nodeType === NODE_ELEMENT && isContenteditable(n)) root = n;
  return root ?? node._ownerDocument?.body ?? node._getRootNode();
}
const MOTIONS = {
  character: (node, offset, forward) => [node, node._nodeType !== NODE_TEXT ? offset
    : forward ? Math.min(nodeLength(node), offset + 1) : Math.max(0, offset - 1)],
  word: (node, offset, forward) => [node, node._nodeType !== NODE_TEXT ? offset : wordEdge(node._data, offset, forward)],
  documentboundary(node, _, forward) {
    const root = boundaryRoot(node);
    return [root, forward ? nodeLength(root) : 0];
  }
};

installSelection(Selection, {
  get_anchorNode(selection) {
    const s = selectionOf(selection);
    return inDocumentTree(s) ? anchorOf(s)[0] : null;
  },
  get_anchorOffset(selection) {
    const s = selectionOf(selection);
    return inDocumentTree(s) ? anchorOf(s)[1] : 0;
  },
  get_focusNode(selection) {
    const s = selectionOf(selection);
    return inDocumentTree(s) ? focusOf(s)[0] : null;
  },
  get_focusOffset(selection) {
    const s = selectionOf(selection);
    return inDocumentTree(s) ? focusOf(s)[1] : 0;
  },
  // (…the anchor and the focus the same point, both null included — wherever they are)
  get_isCollapsed(selection) {
    const s = selectionOf(selection);
    return s.range === null || s.range.collapsed;
  },
  get_rangeCount: (selection) => (inDocumentTree(selectionOf(selection)) ? 1 : 0),
  get_type(selection) {
    const s = selectionOf(selection);
    if (!inDocumentTree(s)) return 'None';
    return s.range.collapsed ? 'Caret' : 'Range';
  },
  get_direction(selection) {
    const s = selectionOf(selection);
    return s.range === null ? 'none' : s.direction;
  },
  getRangeAt(selection, index) {
    const s = selectionOf(selection);
    if (index !== 0 || !inDocumentTree(s)) {
      throw new DOMException(`Failed to execute 'getRangeAt' on 'Selection': ${index} is not a valid index.`, 'IndexSizeError');
    }
    return s.range;
  },
  // (…a range of the document's own tree, and none where the selection has one already — by reference: the script's
  // changes to it are the selection's)
  addRange(selection, range) {
    const s = selectionOf(selection);
    if (range.startContainer._getRootNode() !== s.document || inDocumentTree(s)) return;
    setRange(s, range, 'forward');
  },
  removeRange(selection, range) {
    const s = selectionOf(selection);
    if (s.range !== range) {
      throw new DOMException("Failed to execute 'removeRange' on 'Selection': the given range isn't in the selection.", 'NotFoundError');
    }
    setEmpty(s);
  },
  removeAllRanges: (selection) => setEmpty(selectionOf(selection)),
  empty: (selection) => setEmpty(selectionOf(selection)),
  // The range, as far out of shadow trees as it must go to be in the document or under one of `shadowRoots`: a point
  // in a shadow tree no given root is a shadow-including inclusive ancestor of moves to its host — before it for the
  // start, after it for the end.
  getComposedRanges(selection, options) {
    const s = selectionOf(selection);
    if (s.range === null) return [];
    const given = (root) => options.shadowRoots.some((shadowRoot) => {
      for (let r = shadowRoot; r._isShadowRoot; r = r._host._getRootNode()) {
        if (r === root) return true;
      }
      return false;
    });
    const rescope = (node, offset, after) => {
      for (let root = node._getRootNode(); root._isShadowRoot && !given(root); root = node._getRootNode()) {
        const host = root._host;
        node = host._parent;
        offset = node._children.indexOf(host) + (after ? 1 : 0);
      }
      return [node, offset];
    };
    const [startContainer, startOffset] = rescope(s.range.startContainer, s.range.startOffset, false);
    const [endContainer, endOffset] = rescope(s.range.endContainer, s.range.endOffset, true);
    return [new StaticRange({ startContainer, startOffset, endContainer, endOffset })];
  },
  collapse: (selection, node, offset) => collapse(selectionOf(selection), node, offset),
  setPosition: (selection, node, offset) => collapse(selectionOf(selection), node, offset),
  // (…each a new range, the old one a script may hold left as it was)
  collapseToStart(selection) {
    const s = selectionOf(selection);
    if (s.range === null) throw emptyError('collapseToStart');
    setRange(s, rangeAt(s, s.range.startContainer, s.range.startOffset), 'none');
  },
  collapseToEnd(selection) {
    const s = selectionOf(selection);
    if (s.range === null) throw emptyError('collapseToEnd');
    setRange(s, rangeAt(s, s.range.endContainer, s.range.endOffset), 'none');
  },
  extend: (selection, node, offset) => extend(selectionOf(selection), node, offset),
  setBaseAndExtent(selection, anchorNode, anchorOffset, focusNode, focusOffset) {
    const s = selectionOf(selection);
    // (…the offsets checked first, then where the nodes are, and only then a doctype, as setting the range's points
    // would refuse it)
    if (anchorOffset > nodeLength(anchorNode) || focusOffset > nodeLength(focusNode)) {
      throw new DOMException("Failed to execute 'setBaseAndExtent' on 'Selection': The offset is larger than the node's length.", 'IndexSizeError');
    }
    if (!inDocument(s, anchorNode) || !inDocument(s, focusNode)) return;
    checkPoint('setBaseAndExtent', anchorNode, anchorOffset);
    checkPoint('setBaseAndExtent', focusNode, focusOffset);
    // (…two points in different trees are in no order: the range is collapsed at the anchor — its start set at the
    // focus, then its end at the anchor, in the other tree)
    if (anchorNode._getRootNode() !== focusNode._getRootNode()) {
      setRange(s, rangeAt(s, anchorNode, anchorOffset), 'forward');
    } else if (compareBoundaryPoint(focusNode, focusOffset, anchorNode, anchorOffset) < 0) {
      setRange(s, rangeFrom(s, focusNode, focusOffset, anchorNode, anchorOffset), 'backward');
    } else {
      setRange(s, rangeFrom(s, anchorNode, anchorOffset, focusNode, focusOffset), 'forward');
    }
  },
  selectAllChildren(selection, node) {
    const s = selectionOf(selection);
    if (node._nodeType === NODE_DOCTYPE) {
      throw new DOMException("Failed to execute 'selectAllChildren' on 'Selection': the node is a doctype.", 'InvalidNodeTypeError');
    }
    if (node._getRootNode() !== s.document) return;
    // (…its children: a text node's are none, whatever its length)
    setRange(s, rangeFrom(s, node, 0, node, node._children ? node._children.length : 0), 'forward');
  },
  // The selection moved, or extended, by `granularity` in `direction`: by a character or a word within the focus's
  // text node, and to the start or end of its editing host (or the body) by `documentboundary`. Sentence, line and
  // paragraph motion move nothing yet.
  modify(selection, alter, direction, granularity) {
    const s = selectionOf(selection);
    alter = asciiLower(alter);
    direction = asciiLower(direction);
    granularity = asciiLower(granularity);
    if ((alter !== 'extend' && alter !== 'move') || !MODIFY_DIRECTIONS.has(direction) || !MODIFY_GRANULARITIES.has(granularity)) return;
    if (s.range === null) return;
    // (…'left' and 'right' as at a left-to-right focus)
    const forward = direction === 'forward' || direction === 'right';
    s.direction = forward ? 'forward' : 'backward';
    const next = MOTIONS[granularity]?.(...focusOf(s), forward);
    if (next === undefined) return;
    if (alter === 'move') setRange(s, rangeAt(s, ...next), s.direction);
    else extend(s, ...next);
  },
  // (…the one member that changes the range rather than replacing it)
  deleteFromDocument(selection) {
    const s = selectionOf(selection);
    if (inDocumentTree(s)) deleteRangeContents(s.range);
  },
  // Whether the range holds all of `node` — starts at or before its first boundary point, (node, 0), and ends at or
  // after its last, (node, length) — or, allowing partial containment, any of it.
  containsNode(selection, node, allowPartialContainment) {
    const s = selectionOf(selection);
    if (!inDocumentTree(s) || node._getRootNode() !== s.document) return false;
    const { startContainer, startOffset, endContainer, endOffset } = s.range;
    const length = nodeLength(node);
    if (allowPartialContainment) {
      return compareBoundaryPoint(startContainer, startOffset, node, length) <= 0 &&
        compareBoundaryPoint(endContainer, endOffset, node, 0) >= 0;
    }
    return compareBoundaryPoint(startContainer, startOffset, node, 0) <= 0 &&
      compareBoundaryPoint(endContainer, endOffset, node, length) >= 0;
  },
  // The selected text — a focused text control's own selection, the slice of its raw (visible) value, which real
  // browsers report here though it is no range of the document's (an email field's unsanitized " foo@bar ", a number
  // field's raw digits) — or the range's.
  stringify(selection) {
    const s = selectionOf(selection);
    const active = s.document.activeElement;
    const sel = active && (active._tag === 'textarea' || active._tag === 'input') ? textSelectionOf(active) : null;
    if (sel && sel.end > sel.start) return String(controlLiveValue(active)).slice(sel.start, sel.end);
    return s.range === null ? '' : s.range.toString();
  }
});

globalThis.Selection = Selection;

// This realm's document's selection — its Window's `getSelection` (window.js) and its Document's: a document with no
// browsing context has none.
// (…another realm's document — `Document.prototype.getSelection.call(frame.contentDocument)` — its own realm's, asked
// through its hook rather than its window's replaceable `getSelection`)
let documentSelection = null;
export function getSelection(doc = globalThis.document) {
  const window = doc.defaultView;
  if (!window) return null;
  if (doc !== globalThis.document) return window.__csimGetSelection(doc);
  return documentSelection ??= new Selection(PLATFORM, doc);
}
// …and what the driver does as the user does (dom-nodes.js, form-fields.js): reads its range, or null, and selects —
// where the user may, a shadow tree too, as a script may not (`selectAllChildren`, `addRange`) — and schedules the
// selectionchange of a change it made itself; hooks, as the modules that ask are this one's imports.
globalThis.__csimGetSelection = getSelection;
globalThis.__csimSelectionRange = () => selectedRange;
globalThis.__csimSelect = (startNode, startOffset, endNode, endOffset) => {
  const s = selectionOf(getSelection());
  setRange(s, rangeFrom(s, startNode, startOffset, endNode, endOffset), 'forward');
};
globalThis.__csimScheduleSelectionChange = scheduleSelectionChange;
