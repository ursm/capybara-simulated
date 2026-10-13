// The Selection API, generated from its IDL: a document's selection, the one range a script or the user selected in it
// (or none) and the direction it was selected in — the engine's (selection.rs), which says what each member reads and
// which range a change selects, its points set on a new range the bindings make for it. Every Document with a browsing
// context has one, and here that is this realm's document alone — a document a DOMParser or `createHTMLDocument` made
// has none (its `getSelection` null), and `document.open()` keeps it. The range is held by reference: a script's changes
// to it are the selection's, and so are the DOM's, which update it as the live range it is.
//
// A change to it schedules a `selectionchange` at the document — a task, one at a time (Selection API §"Scheduling
// selectionchange event") — as a text control's own selection does at the control.

import { styleEngineCaretEdge, styleEngineCaretStep, styleEngineValue } from './cascade.js';
import { caretALineOver, caretAtLineEdge, forgetCaretMove, lineWraps, rememberCaretMove } from './layout.js';
import { Event } from './events.js';
import { asciiLower } from './ascii.js';
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
  nodeLength,
  setRangePoint
} from './dom-nodes.js';

const NODE_ELEMENT = 1, NODE_TEXT = 3;

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
const DIRECTION = 7, RANGE = 8, COUNTED_RANGE = 9, FOCUS = 10;
const read = (s, member) => globalThis.__dom.selectionGet(s.state, member);
// The directions a range is selected in.
const NONE = 0, FORWARD = 1, BACKWARD = 2;
// What a change came to (`selectionCollapse` …): nothing, a change — a selectionchange, and what a line-wise move left
// the caret with ended (layout.js `forgetCaretMove`) — or an error to throw, of `member`'s (`offset` the one it was
// given, where it names one).
const CHANGED = 1, EMPTY = 2, DOCTYPE = 3, OFFSET = 4, NOT_FOUND = 5;
// (…the realm's one selection's range kept beside it as each change leaves it — what every Range write asks of it,
// `__csimSelectionRange`, with no call into the engine)
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

// Where `modify` moves a focus at (node, offset) by each granularity it moves by here, forward or backward: by a
// character or a word, the engine's steps (a character's ArrowLeft / ArrowRight takes), the focus staying where there
// is none to take…
const engineStep = (op) => (node, offset, forward) => movedTo(styleEngineCaretStep(op, node, offset, forward));
// (…a move each, as layout.js's are: { node, offset }, and for a line's the x it set out from and the line it is at
// the end of)
const movedTo = (at) => (at ? { node: at[0], offset: at[1] } : undefined);
// …and to the start or end of the editing host the focus is in — its outermost editable ancestor — or the body.
const boundaryRoot = (node) => globalThis.__dom.outermostEditable(node._nid)[0] ?? node._ownerDocument?.body ?? node._getRootNode();
// …and by a line, the caret a line over in its editing host (or the body), at the x the moves set out from (layout.js
// `caretALineOver`, ArrowUp / ArrowDown's), to its first or last caret position past its first or last line; by a
// paragraph — which a `<br>`, a preserved newline or a block's end ends, a soft wrap not (`lineWraps`) — a line at a
// time until the caret is on another's: the next one's first line, the previous one's last; and to the start or end of
// its line (`caretAtLineEdge`, Home / End's).
const lineStep = (node, offset, forward) => {
  const root = boundaryRoot(node);
  return caretALineOver(root, node, offset, !forward, styleEngineCaretEdge(root, forward)) ?? undefined;
};
const paragraphStep = (node, offset, forward) => {
  for (;;) {
    const wraps = forward && lineWraps(node, offset);
    const at = lineStep(node, offset, forward);
    if (!at || (at.node === node && at.offset === offset) || !(forward ? wraps : lineWraps(at.node, at.offset))) return at;
    // (…each line at the x the first set out from)
    rememberCaretMove(at);
    [node, offset] = [at.node, at.offset];
  }
};
// …and the direction 'left' and 'right' move by from a place, by `granularity`: by a character or a word, the strong
// direction of the character after it (before it, at its text's end) where it has one — a right-to-left script's
// letter, any other letter — else its element's `direction` (WPT bidi/modify-move-by-character, Firefox: `Hello World`
// in an rtl paragraph moves right forward); to a line's boundary, the paragraph's (Chrome and Firefox: 'right' to the
// start of an rtl line, whatever its text); by a line or more, none — 'right' is down (Chrome and Firefox, in rtl too).
// (…the text's own the engine's: `charDirection`)
const CHAR_DIRECTIONS = ['ltr', 'rtl'];
function visualDirectionAt(node, offset, granularity) {
  const byCharacter = granularity === 'character' || granularity === 'word';
  if (!byCharacter && granularity !== 'lineboundary') return 'ltr';
  if (byCharacter && node._nodeType === NODE_TEXT) {
    const strong = globalThis.__dom.charDirection(node._nid, offset);
    if (strong >= 0) return CHAR_DIRECTIONS[strong];
  }
  const el = node._nodeType === NODE_ELEMENT ? node : node._parent;
  return el && el._nodeType === NODE_ELEMENT ? styleEngineValue(el, 'direction') : 'ltr';
}
const MOTIONS = {
  character: engineStep('caretStep'),
  word: engineStep('caretWordStep'),
  line: lineStep,
  paragraph: paragraphStep,
  lineboundary: (node, offset, forward) => caretAtLineEdge(boundaryRoot(node), node, offset, forward) ?? undefined,
  documentboundary(node, _, forward) {
    const root = boundaryRoot(node);
    return { node: root, offset: forward ? nodeLength(root) : 0 };
  }
};

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
  // The selection moved, or extended, by `granularity` in `direction`: by a character or a word within the focus's
  // text node, by a line (or a paragraph) up or down, to the start or end of its line by `lineboundary`, and of its
  // editing host (or the body) by `documentboundary`. Sentence motion, and to a sentence's or paragraph's boundary, move
  // nothing yet.
  modify(selection, alter, direction, granularity) {
    const s = selectionOf(selection);
    alter = asciiLower(alter);
    direction = asciiLower(direction);
    granularity = asciiLower(granularity);
    if ((alter !== 'extend' && alter !== 'move') || !MODIFY_DIRECTIONS.has(direction) || !MODIFY_GRANULARITIES.has(granularity)) return;
    const focus = read(s, FOCUS);
    if (focus === null) return;
    // (…'left' and 'right' by the direction of the focus's text — 'right' backward in right-to-left text; from where
    // the focus IS, before the move sets the direction)
    const visual = direction === 'left' || direction === 'right';
    const forward = visual ? (direction === 'right') !== (visualDirectionAt(...focus, granularity) === 'rtl') : direction === 'forward';
    globalThis.__dom.selectionDirect(s.state, forward);
    const next = MOTIONS[granularity]?.(...focus, forward);
    if (next === undefined) return;
    if (alter === 'move') select(s, next.node, next.offset, next.node, next.offset, forward ? FORWARD : BACKWARD);
    else extend(s, next.node, next.offset);
    // (…kept for the next line-wise move, as a key's is)
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
  stringify(selection) {
    const s = selectionOf(selection);
    const active = s.document.activeElement;
    const sel = active && (active._tag === 'textarea' || active._tag === 'input') ? textSelectionOf(active) : null;
    if (sel && sel.end > sel.start) return String(controlLiveValue(active)).slice(sel.start, sel.end);
    const range = read(s, RANGE);
    return range === null ? '' : range.toString();
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
  select(selectionOf(getSelection()), startNode, startOffset, endNode, endOffset, FORWARD);
};
globalThis.__csimScheduleSelectionChange = scheduleSelectionChange;
