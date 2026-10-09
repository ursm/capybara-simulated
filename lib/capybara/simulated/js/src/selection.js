// The Selection API, generated from its IDL: a document's selection, the one range a script or the user selected in it
// (or none) and the direction it was selected in. Every Document with a browsing context has one, and here that is
// this realm's document alone — a document a DOMParser or `createHTMLDocument` made has none (its `getSelection` null),
// and `document.open()` keeps it. The range is held by reference: a script's changes to it are the selection's, and so
// are the DOM's, which update it as the live range it is.
//
// A change to it schedules a `selectionchange` at the document — a task, one at a time (Selection API §"Scheduling
// selectionchange event") — as a text control's own selection does at the control.

import { Event } from './events.js';
import { dispatchEvent } from './dispatch.js';
import { controlLiveValue } from './form-helpers.js';
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

const NODE_TEXT = 3, NODE_DOCTYPE = 10;

// ── Scheduling selectionchange ──────────────────────────────────────────────────────────────────────────────────────────
// The targets — a document, a text control — with an event scheduled and not yet fired ("has scheduled selectionchange
// event").
const scheduled = new WeakSet();
export function scheduleSelectionChange(target) {
  if (scheduled.has(target)) return;
  scheduled.add(target);
  queueTask(() => {
    scheduled.delete(target);
    // (…an element's bubbles, a document's does not)
    dispatchEvent(target, new Event('selectionchange', { bubbles: target.nodeType === 1, cancelable: false }));
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

// The selection's range is `range` now, selected in `direction`: a change, a selectionchange.
function setRange(s, range, direction) {
  s.range = range;
  s.direction = direction;
  scheduleSelectionChange(s.document);
}
// …and none.
function setEmpty(s) {
  if (s.range === null) return;
  s.range = null;
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
  if (node.nodeType === NODE_DOCTYPE) {
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
        node = host.parentNode;
        if (node === null) return [host, 0];
        offset = Array.prototype.indexOf.call(node.childNodes, host) + (after ? 1 : 0);
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
    checkPoint('setBaseAndExtent', anchorNode, anchorOffset);
    checkPoint('setBaseAndExtent', focusNode, focusOffset);
    if (!inDocument(s, anchorNode) || !inDocument(s, focusNode)) return;
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
    if (node.nodeType === NODE_DOCTYPE) {
      throw new DOMException("Failed to execute 'selectAllChildren' on 'Selection': the node is a doctype.", 'InvalidNodeTypeError');
    }
    if (node._getRootNode() !== s.document) return;
    setRange(s, rangeFrom(s, node, 0, node, node.childNodes.length), 'forward');
  },
  // The selection moved, or extended, by `granularity` in `direction` — by a character within the focus's text node
  // here: word, line and paragraph motion need line layout, and move nothing yet.
  modify(selection, alter, direction, granularity) {
    const s = selectionOf(selection);
    alter = alter?.toLowerCase();
    direction = direction?.toLowerCase();
    granularity = granularity?.toLowerCase();
    if ((alter !== 'extend' && alter !== 'move') || !MODIFY_DIRECTIONS.has(direction) || !MODIFY_GRANULARITIES.has(granularity)) return;
    if (s.range === null) return;
    // (…'left' and 'right' as at a left-to-right focus)
    const forward = direction === 'forward' || direction === 'right';
    s.direction = forward ? 'forward' : 'backward';
    if (granularity !== 'character') return;
    const [focus, focusOffset] = focusOf(s);
    const next = focus.nodeType !== NODE_TEXT ? focusOffset
      : forward ? Math.min(nodeLength(focus), focusOffset + 1) : Math.max(0, focusOffset - 1);
    if (alter === 'move') setRange(s, rangeAt(s, focus, next), s.direction);
    else extend(s, focus, next);
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
    if (active && (active._tag === 'textarea' || active._tag === 'input') &&
        active._selectionStart != null && active._selectionEnd != null && active._selectionEnd > active._selectionStart) {
      return String(controlLiveValue(active)).slice(active._selectionStart, active._selectionEnd);
    }
    return s.range === null ? '' : s.range.toString();
  }
});

globalThis.Selection = Selection;

// This realm's document's selection — its Window's `getSelection` (window.js) and its Document's: a document with no
// browsing context has none.
let documentSelection = null;
export function getSelection(doc = globalThis.document) {
  if (doc !== globalThis.document || !doc.defaultView) return null;
  return documentSelection ??= new Selection(PLATFORM, doc);
}
// …and its range, or null — what the driver's editing reads (dom-nodes.js, form-fields.js) — and the scheduling: hooks,
// as the modules that ask are this one's imports.
globalThis.__csimGetSelection = getSelection;
globalThis.__csimSelectionRange = () => {
  const selection = getSelection();
  return selection && selectionOf(selection).range;
};
globalThis.__csimScheduleSelectionChange = scheduleSelectionChange;
