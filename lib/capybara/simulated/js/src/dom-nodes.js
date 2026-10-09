// DOM node classes — Node + Text + Comment + Element +
// DocumentFragment + ShadowRoot + Document + Range +
// the inline `makeAttr` helper.
//
// Every node carries an integer `_id` (handle), a `_parent`, a
// `_children` array (Element + Text + Comment), and a lazy
// `_listeners` map (built on first addEventListener). Element adds
// `_attrs` (lower-cased attribute name → string value) and the
// usual IDL surface plus `dispatchEvent` / `addEventListener` from
// the bridge's capture/target/bubble walker.
//
// Mutual references between classes resolve through shared module
// scope. External-to-module refs (`globalThis.__csim*` host fns,
// `globalThis.document`, etc.) are spelled explicitly through
// `globalThis` — bare identifiers don't resolve inside ESM strict
// mode.

import { NODE_ELEMENT, NODE_ATTRIBUTE, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, NODE_PI, HTML_NS, SVG_NS, MATHML_NS, XML_NS, XMLNS_NS } from './constants.js';
import { WeakRegistry } from './weak-registry.js';
import { clearTimer, hostTask, queueTask } from './timers.js';
import {
  WINDOW_EVENT_HANDLERS, convertCommentArguments, convertProcessingInstructionArguments, convertStaticRangeArguments,
  convertTextArguments, defineDOMTokenList, defineNodeFilter, defineNodeIterator, defineSVGAnimatedString,
  defineTreeWalker, defineValidityState, installAbstractRange, installAttr, installCDATASection, installCharacterData,
  installComment, installCustomStateSet, installDocument, installDOMStringMap, installElementInternals,
  installDocumentFragment, installDocumentType, installDOMImplementation, installElement, installNode,
  installProcessingInstruction, installRange, installShadowRoot, installStaticRange, installText, installXMLDocument
} from './generated/bindings.js';
import {
  PLATFORM, brandPrototype, constructedBy, interfaceCheck, makeSlots, registerInterface,
  resolvedPromise, slotsOf, toDOMString, toLong
} from './webidl.js';
import { appendEdge, insertEdge, insertEdges, removeEdge, removeEdgeAt, clearEdges, hostEdge, childIndexOf, setIteratorSteps } from './tree.js';
import { registerSubtree, unregisterSubtree, setRemovingSteps } from './handles.js';
import { dispatchEvent, dispatchEventForUserAction, fireCheckableActivation, fireEvent, retarget } from './dispatch.js';
import { recordAttrMutation, recordChildList, recordCharacterData, bumpSettleGen, bumpStyleState, currentNodesGen, currentTreeGen, signalSlotChange, setSlotChangeFirer, setSlotMutationHooks, markLayoutDirty } from './mutation-observer.js';
import { hrefAttr } from './link-href.js';
import { createFileList, filesOf } from './file-list.js';
import { currentViewport } from './media-query.js';
import {
  syncArenaData, appendArenaData, registerNativeElement, registerNativeNode,
  setAttrMeta, arenaAttachShadow, registerBeside, REALM as NATIVE_REALM, setElementState, setElementValue, setElementNaturalSize, hasState, setStateBit, setFocusVisible, setParserFormOwner, syncCustomStates, assignSlots, assignedSlotOf, assignedNodesOf, syncManualAssigned, STATE_FOCUSED, STATE_HOVERED, STATE_CHECKED_DIRTY,
  STATE_CHECKED, STATE_SELECTED, STATE_INDETERMINATE, STATE_POPOVER_OPEN, STATE_MODAL, STATE_FILTERED,
  STATE_IS_VALUE, STATE_DIRTY_BY_USER, STATE_CUSTOM_ERROR, STATE_HAS_FILES, scrollOffsetOf, settledScrollOffsetOf, setScrollOffset,
  validityFlagsOf, willValidateOf, isRtl, sanitizedValueOf, steppedValueOf, imageSourceOf, setIsValueOf, linkTemplateContent,
  serializedXml, nodesAtPaths
} from './native-query-shadow.js';
import { walk, walkFind, walkSubtree, walkInclShadow, isConnected, findById, setTemplateDocResolver, setSlotResolver, flatTreeParent } from './walk.js';
// The `<source>` attributes a sibling `<img>` in the same `<picture>` depends on: which resource it
// loads (srcset / src), which source is even selected (media / type), and the box it reserves
// (width / height).
const PICTURE_SOURCE_ATTRS = new Set(['srcset', 'src', 'media', 'type', 'width', 'height']);

import { parseHtmlInteger, parseHtmlNonneg }        from './html-integers.js';
import { setURLResolver } from './reflect.js';
import { fetchTransfer, latin1ToBytes }                               from './bytes.js';
import { selectAll, selectFirst, matchesSelector, closestSelector }   from './selectors.js';
import { isLaidOutNode, isUnskippedNode, styleEngineFocusable, sequentialFocusPath, visibilityHidden, scheduleCascadeRefresh, bumpCascadeVersion, bumpStructureGen, styleElementIsCss, engineSheetOf, ownerSheet } from './cascade.js';
import { ceState, customElements as globalCERegistry, isRegistry, isScopedRegistry, shadowRootRegistry, getCustomElementCtor, registryForElement, documentRegistry, windowRegistryOf, TRACKING_NULL, lookupCEDefinitionCtor, customElementLocalName, ctorHasAnyDefinition, customElementIsValueForCtor, isValidCustomElementName, isFormAssociatedCustomElement, becomeCustom, hasFormAssociatedCustomElements, setFormAssociatedReset, ceUpgradeTree, hasAnyCEDefinitions, fireCEDisconnect, fireCEMoveReactions, fireCEAdopted, fireAttrChangedCallback, askForReset, askForResetBatch, askForResetAfterRemoval, runSelectednessAlgorithm, finalizeSelectOptions, ensureOptionSelInit, updateSelectedContent, scheduleSelectedContentUpdate } from './custom-elements.js';
import { isContenteditable, toggleChecked, setRadio, checkedRadioInGroup, uncheckOtherRadios, getCheckedness, setCheckedness, setSelectedness, controlLiveValue, setControlLiveValue, clearControlLiveValue, clearControlCheckedness, moveTextEntryCursor, textareaRawValue, isSubmitButton, inputTypeState, markUserValidity, faceWillValidate, isListedFormControl, formControlElements, isClickActivatable, formForControl, isActuallyDisabled, isSummaryForItsDetails, activationTargetOf, fireBeforeToggle, queueToggleTask, labeledControlFor, isLabelableControl, isHtmlLabel, labelToActivateFor, LABELABLE, READONLY_INPUT_TYPES } from './form-helpers.js';
import { inlineStyleOf, isReplacedOrControl, propagatedOverflow, usedDisplay, declaredValue, displayAsLaidOut, renderingTag } from './style-proxy.js';
import { logThrew }                                                   from './console.js';
import { liveHTMLCollection, liveOptionsCollection, liveFormControlsCollection, liveNodeList, liveRadioNodeList, nodeList, childNodeList, newChildList, liveNamedNodeMap }   from './dom-collections.js';
import { legacyFormEncode }                                           from './encoding.js';
import { isHtmlDocument }                                             from './mime.js';
import { closeDialog, dialogClosed, dialogOpened } from './dialog.js';
import { ensureInView, rectOf, clientRectsOf, clientBox, viewportSize, contentExtent, offsetsOf, applyScrollIntoView, clampScrollOffset, hitTest, hitTestAll, bumpScrollEpoch } from './layout.js';

// The scrollable range only clamps for the document scroller — see the `scrollTop` setter.
// Where a scroll offset can live at all. The document scroller keeps one whatever the root's own
// overflow says — the root's overflow PROPAGATES to the viewport, so the root element is where the
// document's offset is held — and so does any rendered SCROLL CONTAINER. Everything else refuses
// the write and goes on reporting 0, which is what a browser does: measured in Chrome 137,
// `overflow: visible` and `overflow: clip` both stay 0, `document.body` stays 0 even when the body
// itself declares `overflow: auto` (that propagates too), and a `display: none` box has no scroll
// box to hold anything.
function holdsScrollOffset(el) {
  const doc = el && el.ownerDocument;
  // The document scroller, whichever element that is in this mode.
  if (doc && doc.scrollingElement === el) return true;
  // The overflow question FIRST: it is two style reads, where the rendered-ness test walks to the
  // root (rule 3) — so a write to something that was never going to hold an offset pays only the
  // cheap half.
  //
  // Asked of the CASCADE (`scrollsInAnyAxis`), not of the clip flags the layout pass left on the box
  // (walk.rs `clip_flags`): those only move when a pass actually runs, so a box made scrollable and then written to in
  // the same tick — a panel that gains a class and restores its saved offset — answered from
  // BEFORE the class, and the write was silently dropped.
  if (isTextControlScroller(el)) return isLaidOutNode(el);
  if (!scrollsInAnyAxis(el)) return false;
  // A non-replaced INLINE box has no scroll box to hold one, whatever its overflow computes to:
  // Chrome leaves `getComputedStyle(span).overflowY` at `auto` and still refuses the write
  // (measured — and the same for a replaced inline, an `<img>`).
  if (displayAsLaidOut(usedDisplay(el), renderingTag(el)) === 'inline') return false;
  return isLaidOutNode(el);
}

// Move `el`'s scroll offset to (x, y) — an axis given as `undefined` stays — on the box that keeps it
// (`scrollOffsetHolder`), then fire the events and move the epoch. Clamped to the scrollable range, as a browser
// clamps: `scrollTo(0, scrollHeight)` — the everyday "scroll to the bottom" — lands at `scrollHeight - clientHeight`
// and not past it, which is what puts a list's sentinel INSIDE the viewport where an IntersectionObserver can see it.
// The events are queued BEFORE the epoch bump: both are delivered by a microtask on a page with nothing else pending,
// and the rendering update runs the scroll steps before the intersection observations — so the scroll flush has to
// be the microtask that was queued first.
function moveScrollOffset(el, x, y) {
  const box = scrollOffsetHolder(el);
  let changed = false;
  const nx = typeof x === 'number' ? clampScrollOffset(el, 'x', x) : undefined;
  const ny = typeof y === 'number' ? clampScrollOffset(el, 'y', y) : undefined;
  const moved = (nx !== undefined && nx !== scrollOffsetOf(box, 0)) || (ny !== undefined && ny !== scrollOffsetOf(box, 1));
  if (!moved) return;
  setScrollOffset(box, nx, ny);
  __notifyScroll(box); __notifyScrollEnd(box); bumpScrollEpoch();
}

// Where an element's scroll offset is KEPT: the viewport's on the root element, whichever element is the document
// scroller — the root in standards mode, the BODY in quirks mode, whose `scrollTop` is the viewport's there (Chrome:
// 1350 on both `scrollY` and `body.scrollTop` after a `scrollIntoView`, `documentElement.scrollTop` 0) — and every
// other element's on itself. Null for the root when it is NOT the document scroller: it reads 0.
function scrollOffsetHolder(el) {
  const doc = el.ownerDocument;
  const root = doc && documentElementOf(doc);
  if (doc && doc.scrollingElement === el) return root || el;
  return el === root && doc.scrollingElement ? null : el;
}

// A SCROLL CONTAINER by its own overflow, in either axis. `clip` is not one (it forbids scrolling
// outright), which is the whole reason this is not the same question as clipping.
const SCROLLING_OVERFLOW = new Set(['scroll', 'auto', 'hidden']);
function scrollsInAnyAxis(el) {
  return SCROLLING_OVERFLOW.has(propagatedOverflow(el, 'x')) ||
         SCROLLING_OVERFLOW.has(propagatedOverflow(el, 'y'));
}

// …and a TEXT CONTROL scrolls whatever its own `overflow` computes to, because the box that
// scrolls is the inner editor and the CSSOM puts its offset on the control. Chrome reports
// `overflow: clip` for an `<input>` — not a scroll container by the overflow rule — and still
// honours `input.scrollLeft = 30` (measured). A `<textarea>` computes to `auto` and a listbox
// `<select>` to `hidden/scroll`, so both are scroll containers on their own and need no entry
// here. `contenteditable` is NOT one: Chrome computes `overflow: visible` on a plain editable div
// and refuses the write (measured).
function isTextControlScroller(el) {
  return el._tag === 'input' && isTextLikeInputType(el);
}


import { fileName, isFile, serializeMultipart }                       from './blob.js';
import { formDataEntries, isFormData, submissionFormData }             from './form-data.js';
import { getHeader }                                                   from './headers.js';
import { runSourceInsertionStep }                                    from './media.js';
import { tryFragmentNavigate }                                        from './location.js';

import {
  BeforeUnloadEvent, ClipboardEvent, CompositionEvent, CustomEvent, DeviceMotionEvent, DeviceOrientationEvent, DragEvent,
  Event, EventTarget, FocusEvent, HashChangeEvent, InputEvent, KeyboardEvent, MessageEvent, MouseEvent, PointerEvent,
  StorageEvent, SubmitEvent, TextEvent, ToggleEvent, UIEvent, createBeforeUnloadEvent, createTextEvent,
  installEventHandlerAttrs, setScopeFormOwnerResolver, syncInlineEventHandler
} from './events.js';
import { DataTransfer, setDataTransferMode } from './data-transfer.js';
import { serializeChildren, serializeChildrenWithShadow, serializeElement } from './html-parser.js';
import { fetchStyleSheetText } from './css-utils.js';
import { asciiLower, asciiUpper, ASCII_WHITESPACE } from './ascii.js';
import { KNOWN_HTML_TAGS } from './html-element-names.js';
export { asciiLower };
import { newStyleSheetList, ownedStyleSheet } from './cssom.js';
import { xpathEvaluatorBase } from './xpath.js';
import { bodyOf, documentElementOf, headOf } from './document-tree.js';
import { installHtmlTreeBuilder } from './html-tree-builder.js';
import { installXmlParser } from './xml-parser.js';
import { collectBodyStream, navigationFetch, responseBytes, responseOf } from './fetch.js';
import { buildSwRequest } from './sw-client.js';
import { animateElement, animationsForElement, animationsForRoot, documentTimeline } from './web-animations.js';
import { rectList } from './geometry.js';

// Block-level containers execCommand's list algorithm treats as the "block"
// holding the selection — the caret's nearest such ancestor (within the editing
// host) is the unit that gets wrapped into / lifted out of a list item.
const BLOCK_CONTAINER_TAGS = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'blockquote', 'pre', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'
]);

// Normalize a color value the way Chrome reports it in the `data` of a format*Color execCommand `input` event: a
// colour written in a legacy sRGB form (a keyword, a hex, `rgb()` / `hsl()` / `hwb()`) as its computed serialization
// (opaque → `rgb()`, with alpha → `rgba(…, 0.533)`, transparent → `rgba(0, 0, 0, 0)`); `currentcolor` and bare all-letter
// CSS-wide keywords (inherit / initial / …) lowercased; anything else — another colour space, no colour at all —
// verbatim.
function normalizeExecColor(value) {
  const v       = value == null ? '' : String(value);
  const trimmed = v.trim();
  const low     = trimmed.toLowerCase();
  if (low === 'currentcolor') return 'currentcolor';
  const c = globalThis.__dom.cssColor(trimmed, '');
  if (c !== null && c[4]) return c[5];
  return /^[a-zA-Z]+$/.test(trimmed) ? low : trimmed;
}

let __nextId = 1;
// How far apart realms' handle ids are (`Node`): 2³² ids a realm, 2²¹ realms an isolate within a double's integers.
const REALM_ID_SPAN = 2 ** 32;
// Carry the registered tag through `new SomeCustomElement()` so the
// Element base ctor can populate `_tag` even when the subclass
// doesn't call super(tag). Browsers do this via a per-construction
// queue; the single-threaded JS engine lets us collapse to a slot.
let __currentTag = null;
let __currentCreationRegistry;   // the explicit registry a createElement in progress carries into the constructor

// User-initiated scroll signal (scrollIntoView / scrollTo / scrollBy
// on any node). Scroll position is kept per element in its arena (`scrollOffsetOf`); for the document scrolling
// element (documentElement)
// `window.scrollY` reads through. The SIGNAL is what DLoadMore-shaped
// sentinels (and scroll-driven UI swaps) gate on. Fire a `scroll`
// event on the target (defaulting to document) and force-refire any
// observed IntersectionObserver targets so a paginated list advances
// past its first page.
const pendingScroll = new Set();
function __notifyScroll(target) {
  pendingScroll.add(scrollEventTarget(target));
  scheduleScrollFlush();
}
// The VIEWPORT's three names — `document`, `documentElement`, `scrollingElement` — are one
// scrolling box, so they must be one entry in the pending set: two of them in it would fire the
// viewport's scroll twice in a frame.
function scrollEventTarget(target) {
  const doc = globalThis.document;
  if (!doc) return target;
  if (!target || target === doc || target === documentElementOf(doc) ||
      (doc.scrollingElement && target === doc.scrollingElement)) return doc;
  return target;
}
globalThis.__csimFlushScroll = function () {
  if (!pendingScroll.size) return;
  const targets = Array.from(pendingScroll);
  pendingScroll.clear();
  const doc = globalThis.document;
  for (const target of targets) {
    try {
      // A `scroll` event does not bubble out of an ELEMENT scroller, so an inner pane's reaches
      // that pane and nothing else (Chrome, measured: a listener on document or window counts ZERO
      // for it). The VIEWPORT's fires at the DOCUMENT and bubbles from there — that is how it
      // reaches window listeners (Discourse's site-header debouncer, Turbo's scroll observer), and
      // reaching them by a second explicit dispatch instead made a window CAPTURE listener fire
      // twice and reported `e.target` as the window where Chrome says the document.
      if (target === doc) {
        fireEvent(doc, new Event('scroll', { bubbles: true }));
      } else {
        // A scroller REMOVED between the scroll and this update still gets its event — CSSOM-View's
        // "run the scroll steps" has no connectedness test and Chrome 151 fires both `scroll` and
        // `scrollend` for a box scrolled and removed in the same task.
        fireEvent(target, new Event('scroll', { bubbles: false }));
      }
    } catch (_) {}
  }
};
// A scroll asks for a rendering update, the way it does in a browser — and the driver's settle loop
// only runs a loop step when a timer, a fetch or a message is pending. A page that just scrolls has
// none of those, so without this kick the pending events would sit in the set until something else
// happened to run a frame: a scroll handler that appends to the DOM never ran at all, and
// `assert_selector` on what it appends failed on a page a browser handles. Queued as a MICROTASK
// (the same answer `observers.js` gives for the intersection recheck) so the events still land
// after the script that scrolled rather than re-entrantly inside it. The render phase flushes the
// same set, so whichever comes first delivers and the other finds it empty.
let scrollFlushScheduled = false;
function scheduleScrollFlush() {
  if (scrollFlushScheduled) return;
  scrollFlushScheduled = true;
  Promise.resolve().then(() => {
    scrollFlushScheduled = false;
    try { globalThis.__csimFlushScroll(); } catch (_) {}
    try { globalThis.__csimFlushScrollEnd(); } catch (_) {}
  });
}

// `scroll` is a PENDING SCROLL EVENT TARGET, exactly as `scrollend` below is
// (CSSOM-View "Scrolling events"): scrolling a box adds it to the document's
// pending set and the event fires at the next "update the rendering" step,
// COALESCED — one event per scroller per frame, however many times its offset
// moved. Firing it synchronously from the setter instead made two things wrong
// that an SPA notices: a scroller nudged twice in one task delivered two events,
// and an event delivered mid-task reached listeners the browser would only have
// run after that task finished. Turbo's `ScrollObserver` records
// `window.pageYOffset` into the CURRENT history entry's restoration data on
// every `scroll`; with synchronous delivery, the `scrollTo(0, 0)` its own visit
// performs raced the identifier swap and overwrote the OUTGOING page's saved
// position with 0 — so `page.go_back` restored the top of the page, and a lazy
// `<turbo-frame>` below the fold was never scrolled into view to load.
//
// `scrollend` (CSSOM-View; Baseline 2025 — shipped in Chromium/Firefox, not
// tentative): fires once a scroll settles. Per spec, a scrolled target is added
// to the document's "pending scroll event targets" and scrollend is dispatched
// at the next "update the rendering" step — NOT synchronously. We model that:
// `__notifyScrollEnd` QUEUES the target (on an actual position change only — a
// no-op scroll queues nothing), and the render phase (__csimFlushScrollEnd, run
// from timers.js runRenderPhase) dispatches it. A scroller REMOVED before that
// step keeps its event: "run the scroll steps" has no connectedness test, and
// Chrome 151 fires both `scroll` and `scrollend` for a box scrolled and removed
// in the same task (we used to drop it, on a claim that turned out to be untrue).
// Fan-out is narrower than `scroll` and always cancelable:false. An ELEMENT
// scroller dispatches on the element only, bubbles:false (it must NOT reach
// document/window — a non-scrolled target asserts it never arrives). The ROOT
// scroller (documentElement / scrollingElement / body / document) dispatches at
// the document (bubbles:true) AND window (our model doesn't propagate
// document→window, so window listeners need an explicit dispatch).
const pendingScrollEnd = new Set();
function __notifyScrollEnd(target) {
  pendingScrollEnd.add(scrollEventTarget(target));
  scheduleScrollFlush();
}
globalThis.__csimFlushScrollEnd = function () {
  if (!pendingScrollEnd.size) return;
  const targets = Array.from(pendingScrollEnd);
  pendingScrollEnd.clear();
  const doc = globalThis.document;
  for (const target of targets) {
    try {
      // The viewport scroller is documentElement (== scrollingElement in standards
      // mode, which is all we model); `document.body` is a normal element scroller,
      // NOT the root (unlike quirks mode), so it falls to the element branch.
      if (target === doc) {
        // The viewport scroller's scrollend fires at the document and bubbles to
        // window — dispatch.js already fires window listeners during the document
        // event's bubble phase, so a single bubbling document dispatch covers both
        // (an explicit window dispatch would double-fire window listeners).
        fireEvent(doc, new Event('scrollend', { bubbles: true, cancelable: false }));
      } else {
        fireEvent(target, new Event('scrollend', { bubbles: false, cancelable: false }));
      }
    } catch (_) {}
  }
};

// Used by `ChildNode.before/after/replaceWith` + `ParentNode.append
// /prepend` to accept strings (auto-wrap as Text) alongside nodes.
// WebIDL `(Node or DOMString)` coercion used by the ChildNode/ParentNode
// variadic methods: an actual Node passes through (any node type — a doctype
// must reach insertion so the validity check can throw, not be stringified);
// everything else becomes a Text node of its string value (null → "null",
// undefined → "undefined", per the IDL DOMString conversion).
function toNode(v, doc) {
  if (isNodeObject(v)) return v;   // (…an object inheriting from a node is no node: a string to be)
  const t = new Text(String(v));
  t._ownerDoc = doc;
  return t;
}
// https://dom.spec.whatwg.org/#converting-nodes-into-a-node — collect the
// variadic args into a single node: one item stays as-is, several are wrapped
// in a DocumentFragment so the caller inserts them in one operation. Both the
// fragment and a string's Text are `node`'s document's: made in the main one,
// another document's nodes were adopted into it and back on their way in.
function convertNodesIntoNode(nodes, node) {
  const doc = node._nodeType === NODE_DOC ? node : node.ownerDocument;
  if (nodes.length === 1) return toNode(nodes[0], doc);
  const frag = new DocumentFragment();
  frag._ownerDoc = doc;
  for (const n of nodes) frag._appendChild(toNode(n, doc));
  return frag;
}
// …for a variadic method, whose insertion follows at once: the adoptedCallback reactions the conversion's own inserts
// hold are carried to that insertion, which runs them once the nodes are in place — the node's parent is the one the
// method put it under by then (Chrome), not the conversion's fragment.
function convertNodesHolding(nodes, node) {
  const outer = holdAdoptions();
  let converted = null;
  try {
    converted = convertNodesIntoNode(nodes, node);
  } finally {
    // (A conversion that threw carries nothing: its call is over, and Chrome runs none of them.)
    const held = releaseAdoptions(outer);
    if (outer === null && converted !== null && held.length) carriedAdoptions = held;
  }
  return converted;
}

// The element lists named by a filter (collections.rs): the scope's descendant elements in tree order that the engine's
// filter takes — `getElementsByClassName` (an ordered set of classes, ASCII case-insensitive in a quirks-mode document),
// `getElementsByTagNameNS` (namespace "*" any, "" / null none, else exact; local name "*" any, else exact) and
// `getElementsByTagName` ("*" any; in an HTML document the search ASCII-lowercased for an HTML element and compared
// with its actual qualified name), the document's legacy collections and `getElementsByName`. Plain Arrays; the live
// collections wrap them.
const BY_CLASSES = 0, BY_TAG_NS = 1, BY_TAG = 2, BY_FORMS = 3, BY_IMAGES = 4, BY_LINKS = 5, BY_SCRIPTS = 6, BY_ANCHORS = 7, BY_EMBEDS = 8, BY_NAME = 9;
function collectBy(scope, kind, a, b) {
  return nodesAtPaths(scope, globalThis.__dom.elementsBy(scope._nid, kind, a, b));
}
function collectByClassName(scope, classNames) {
  const doc = scope._nodeType === NODE_DOC ? scope : scope.ownerDocument;
  return collectBy(scope, BY_CLASSES, String(classNames), !!(doc && doc._quirks));
}
export function collectByTagNameNS(scope, namespace, localName) {
  const ns = namespace === '*' ? '*' : (namespace == null || namespace === '' ? null : String(namespace));
  const local = String(localName);
  const found = collectBy(scope, BY_TAG_NS, ns, local);
  // (…a lone surrogate or U+FFFD, which the arena's names hold lossily, compared again exactly)
  if (!LOSSY_NAME.test(local) && !(ns && LOSSY_NAME.test(ns))) return found;
  return found.filter((el) => (local === '*' || el._localName === local) && (ns === '*' || (el._ns ?? null) === ns));
}
// `htmlDoc` (whether to ASCII-lowercase the search for HTML-namespaced elements) is bound by the LIVE collection at
// CREATION time per WHATWG "list of elements with qualified name" — moving the root into a differently-HTML document
// must NOT change an existing list. Non-live callers omit it and get the scope's current document.
function collectByTagName(scope, tag, htmlDoc) {
  if (htmlDoc === undefined) htmlDoc = isHtmlDocument(scope.ownerDocument);
  const name = String(tag);
  const found = collectBy(scope, BY_TAG, name, htmlDoc);
  if (!LOSSY_NAME.test(name)) return found;
  const lower = htmlDoc ? asciiLower(name) : name;
  return found.filter((el) => (el._prefix ? el._prefix + ':' + el._localName : el._localName) === (el._ns === HTML_NS ? lower : name));
}
// A lone surrogate or U+FFFD: what the arena's names, UTF-8, hold lossily.
const LOSSY_NAME = /[\ud800-\udfff\ufffd]/;

// ── document.title helpers ──────────────────────────────────────────
// The "title element" is the first HTML-namespace `title` in tree order across
// the whole document; for a document whose root is an SVG `svg` element it is
// instead the first SVG-namespace `title` that is a DIRECT child of the root.
const isSvgRootEl = (el) => !!el && el._ns === SVG_NS && el._localName === 'svg';
function firstHtmlTitleInTreeOrder(documentEl) {
  // Pre-order (tree-order) DFS, iterative so it's deep-DOM safe.
  const stack = [documentEl];
  while (stack.length) {
    const n = stack.pop();
    if (n !== documentEl && n._ns === HTML_NS && n._localName === 'title') return n;
    const kids = n._children;
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i]._nodeType === NODE_ELEMENT) stack.push(kids[i]);
  }
  return null;
}
function firstSvgTitleChild(documentEl) {
  for (const c of documentEl._children) if (c._ns === SVG_NS && c._localName === 'title') return c;
  return null;
}
export function childTextContent(el) {
  // Concatenate the data of child Text nodes (CDATASection is a Text subtype),
  // matching the codebase's textContent convention.
  let s = '';
  for (const c of el._children) {
    const t = c._nodeType;
    if (t === NODE_TEXT || t === NODE_CDATA) s += c._data;
  }
  return s;
}

// Collect the Text-node data under an <option> in tree order for `option.text`,
// skipping HTML and SVG <script> subtrees (MathML script is collected) per the
// spec.
function collectOptionText(node, out) {
  for (const c of node._children) {
    const t = c._nodeType;
    if (t === NODE_TEXT || t === NODE_CDATA) out.push(c._data);
    else if (t === NODE_ELEMENT) {
      if (c._localName === 'script' && (c._ns === HTML_NS || c._ns === SVG_NS)) continue;
      collectOptionText(c, out);
    }
  }
}

// DOM node-type names for HierarchyRequestError messages.
const NODE_TYPE_NAMES = {
  [NODE_ELEMENT]:   'Element',
  [NODE_ATTRIBUTE]: 'Attr',
  [NODE_TEXT]:      'Text',
  [NODE_COMMENT]:   'Comment',
  [NODE_DOC]:       'Document',
  [NODE_DOCTYPE]:   'DocumentType',
  [NODE_FRAGMENT]:  'DocumentFragment'
};
function nodeTypeName(node) {
  return NODE_TYPE_NAMES[node && node._nodeType] || 'node';
}

function hierarchyError(msg) { return new globalThis.DOMException(msg, 'HierarchyRequestError'); }

// Shared pre-insertion / replace validity
// (https://dom.spec.whatwg.org/#concept-node-ensure-pre-insertion-validity and #concept-node-replace), the engine's
// (mutation.rs): `child` is the reference (pre-insert) or replaced (replace) node; `isReplace` switches the
// document-child constraints to exclude the node being replaced. Each refusal its exception.
function validateInsertion(node, parent, child, isReplace) {
  const why = globalThis.__dom.insertionRefusal(node._nid, node._nodeType, parent._nid, parent._nodeType,
    child == null ? -1 : child._nid, isReplace);
  switch (why) {
    case 0: return;
    case 1: throw hierarchyError(`Cannot add a child to a ${nodeTypeName(parent)} node`);
    case 2: throw hierarchyError('The new child is an ancestor of the parent');
    case 3: throw new globalThis.DOMException('The reference child is not a child of this node', 'NotFoundError');
    case 4: throw hierarchyError(`Cannot insert a ${nodeTypeName(node)} node`);
    case 5: throw hierarchyError(`A ${nodeTypeName(node)} node cannot be a child of a ${nodeTypeName(parent)} node`);
    case 6: throw hierarchyError('Document can contain only one element');
    case 7: throw hierarchyError(node._nodeType === NODE_FRAGMENT ? 'Invalid placement of an element in a Document' : 'Document can contain only one element child');
    default: throw hierarchyError('Invalid placement of a doctype in a Document');
  }
}
// (An insertion refused here still runs the adoptedCallback reactions its conversion carried: they happened.)
function ensurePreInsertionValidity(node, parent, child) {
  try {
    validateInsertion(node, parent, child, false);
  } catch (e) {
    const carried = carriedAdoptions;
    carriedAdoptions = null;
    if (carried) fireAdoptions(carried);
    throw e;
  }
}

// Pre-insertion "adopt" step (https://dom.spec.whatwg.org/#concept-node-pre-insert
// step 2): a node inserted into `parent` is first adopted into `parent`'s
// node document, which re-tags the subtree's `ownerDocument` AND detaches it
// from any previous parent. A same-document insert is just a detach (no
// subtree walk). Shared by appendChild / insertBefore / replaceChild so all
// three honour the adoption that the WPT Node-appendChild "Adopting an orphan
// / non-orphan" cases (and real cross-document grafting) depend on.
// One document, possibly two views (the raw Document and its makeDocProxy
// wrapper): normalize to a single identity before any cross-document decision.
function docIdentity(d) { return (d && d.__csimSelf) || d; }
function adoptIntoParent(parent, node) {
  // HTML "reset the form owner": a script insertion/move voids a parser-assigned
  // form-owner pointer (set for a mis-nested control — e.g. an <input> a `<table>`
  // foster-parented out of its `<form>`). After a move the owner re-derives purely
  // from ancestry / the `form` attribute. The parser builds its tree directly (not
  // via this path), so its pointer survives parsing and is reset only by a later
  // script move.
  if (node._formOwner != null) setParserFormOwner(node, null);
  // Use the `ownerDocument` accessor, not the raw `_ownerDoc` field: a node
  // attached to the main document carries `_ownerDoc === null` and relies on
  // the getter's `|| globalThis.document` fallback, so reading `_ownerDoc`
  // here would see null and skip the (cross-document) adoption entirely.
  const destDoc = parent._nodeType === NODE_DOC ? parent : parent.ownerDocument;
  if (destDoc && docIdentity(node.ownerDocument) !== docIdentity(destDoc) && destDoc._nodeType === NODE_DOC) {
    destDoc._adoptNode(node);
  } else if (node._parent) {
    node._parent._removeChild(node);
  }
  registryOnInsert(parent, node);
}

// DOM "associated inert template document": the node document of every
// `template.content` (adopted-callback's "the document of the template
// elements"). Lazy — most pages never observe the identity; ONE per document,
// no browsing context; its own associated inert template document is ITSELF,
// so a template nested in template content stays in the same inert document
// (the `d._inertTemplateDoc = d` self-link is also the O(1) "is this an inert
// template document" test the parser's owner propagation keys on).
export function inertTemplateDocFor(doc) {
  let d = doc._inertTemplateDoc;
  if (!d) {
    d = new Document();
    // Mirror the creating document's HTML-ness: an HTML document's template
    // content keeps HTML parsing / serialization / casing semantics.
    if (isHtmlDocument(doc)) d._contentType = 'text/html';
    d._inertTemplateDoc  = d;   // (Document's constructor already sets _noBrowsingContext)
    doc._inertTemplateDoc = d;
  }
  return d;
}
// walk.js's assignOwnerDoc (the XML-parse adoption path) resolves template
// content owners through this — it can't import Document itself.
setTemplateDocResolver(inertTemplateDocFor);

// DOM adopting steps for `<template>`: when a template element changes
// documents its CONTENT adopts into the NEW document's associated inert
// template document — custom elements inside it get adoptedCallback like any
// adopted subtree. Recurses for templates nested in the content (whose target
// inert document is the same one — an inert document is its own).
function adoptTemplateContentInto(tc, dest, oldDocFallback) {
  const tdest = inertTemplateDocFor(dest);
  const told  = tc._ownerDoc || oldDocFallback;
  if (told === tdest) return;
  tc._ownerDoc = tdest;
  walkSubtree(tc, x => {
    x._ownerDoc = tdest;
    if (x._attrNodes) for (const k in x._attrNodes) x._attrNodes[k]._ownerDoc = tdest;
    if (x._tag === 'template' && x._templateContent) adoptTemplateContentInto(x._templateContent, tdest, told);
  });
  fireCEAdopted(tc, told, tdest);
}

// Template content also carries a tracking-null registry association:
// a tracking-null node inserted anywhere OUTSIDE template content is thereby
// "adopted" and re-points to the unset window-tracking state (a sticky null —
// the customelementregistry attribute — never re-points); insertion INTO
// template content converts non-scoped associations to the tracking sentinel.
// Two slot compares on the hot insert path; the subtree walks only run for
// actual template-content traffic. Runs on BOTH insert paths via
// adoptIntoParent — the single-node pre-insert and _insertFragmentChildren's
// per-child adopt. A cloned CONTENT FRAGMENT has no slot of its
// own, so a fragment node scans its (small) child list for the sentinel.
// The adoptedCallback reactions an insertion holds back until what it inserts is in place (`adoptNode` pushes node, old
// document, new document), or null when an adoption fires its own. The insertion is one API call (CEReactions), so a
// callback that moves the node finds it where the insertion put it — not half-inserted, in two parents' lists at once.
let deferredAdoptions = null;
// …and what a converting step held for the insertion right after it (`convertNodesHolding`): the variadic methods'
// nodes are adopted as they are converted, but placed only by the insertion that follows.
let carriedAdoptions = null;
function holdAdoptions() {
  const outer = deferredAdoptions;
  deferredAdoptions = carriedAdoptions || [];
  carriedAdoptions = null;
  return outer;
}
// …stop holding (`outer`: what `holdAdoptions` returned), handing back what was held — to the outer hold when there is
// one, as the reactions of a nested step belong to the outermost call…
function releaseAdoptions(outer) {
  const held = deferredAdoptions;
  deferredAdoptions = outer;
  if (outer === null) return held;
  for (let i = 0; i < held.length; i++) outer.push(held[i]);
  return NO_ADOPTIONS;
}
const NO_ADOPTIONS = [];
// …and run it.
function fireAdoptions(held) {
  for (let i = 0; i < held.length; i += 3) fireCEAdopted(held[i], held[i + 1], held[i + 2]);
}
function registryOnInsert(parent, node) {
  const nodeTracking = node._ceRegistry === TRACKING_NULL ||
    (node._nodeType === 11 && node._children != null && node._children.some(c => c._ceRegistry === TRACKING_NULL));
  if (nodeTracking && parent._ceRegistry !== TRACKING_NULL) {
    walkSubtree(node, n => { if (n._ceRegistry === TRACKING_NULL) n._ceRegistry = undefined; });
  } else if (parent._ceRegistry === TRACKING_NULL && node._ceRegistry !== TRACKING_NULL) {
    walkSubtree(node, n => { const r = n._ceRegistry; if (r === undefined || (r && !isScopedRegistry(r))) n._ceRegistry = TRACKING_NULL; });
  }
}

// WebIDL: appendChild/insertBefore/replaceChild take non-nullable Node
// arguments, so a non-Node (null, undefined, a plain object) is a TypeError
// *before* the algorithm runs. Realm-safe: a duck-typed numeric nodeType is
// enough (avoids cross-document `instanceof` pitfalls).
function assertNodeArg(value) {
  if (value == null || typeof value._nodeType !== 'number') {
    throw new TypeError("Argument is not an object that implements Node");
  }
}

// HTML "to get the list of options" for a `<select>` — the engine's (validity.rs `list_of_options`): its option
// descendants in tree order past transparent wrappers (a customizable select's `<div>`) and one level of `<optgroup>`,
// none under an `<hr>`, a `<datalist>`, a nested `<optgroup>` or a nested `<select>`.
function listOfOptions(select) {
  return nodesAtPaths(select, globalThis.__dom.listOfOptions(select._nid));
}

// Tentative customizable-combobox filtering (open-ui combobox): `<input filter=ID>`
// filters the `<select id=ID>`'s options, and `<input list=ID>` the `<datalist id=ID>`'s,
// against the typed value. Setting input.value fires a cancelable `beforefilter` on the
// input; unless prevented, every option whose text doesn't start with the value
// (case-insensitive, trimmed) is marked `_filtered` — the `:filtered` pseudo + the UA
// `option:filtered { display:none }` hide it.
// The `<datalist>` (or `<select>`) a combobox `<input>` points at via `list` / `filter`.
function comboboxListFor(input) {
  const id = input._attrs.filter != null ? input._attrs.filter : input._attrs.list;
  if (id == null) return null;
  const root = input.getRootNode();
  return (root && root.getElementById) ? root.getElementById(id) : null;
}

// The `<input>` types the `list` attribute (datalist suggestions) applies to.
const LIST_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'number', 'range', 'color',
  'date', 'month', 'week', 'time', 'datetime-local'
]);
export function inputSupportsList(input) {
  return input && input._tag === 'input' && input._attrs.list != null &&
    LIST_INPUT_TYPES.has((input._attrs.type || 'text').toLowerCase());
}

// open-ui customizable combobox: focusing (or ArrowDown on) an `<input list>` whose
// computed `appearance` is `base` shows the associated `<datalist>` as a popover.
// Fires a cancelable `beforetoggle` first; a listener that cancels it, throws, or
// disconnects the datalist suppresses the show (customizable-combobox-popover-
// exception). Otherwise the datalist's `_popoverOpen` flips (→ `:popover-open`) and a
// `toggle` event fires. The `appearance:base` gate keeps an ordinary `<input list>`
// (native dropdown) from ever opening its datalist into the light DOM.
export function showComboboxDatalist(input) {
  if (!inputSupportsList(input)) return;
  const dl = comboboxListFor(input);
  if (!dl || dl._tag !== 'datalist' || hasState(dl, STATE_POPOVER_OPEN)) return;
  if (declaredValue(input, 'appearance') !== 'base') return;
  // Cancelled, or the listener detached the datalist (showing a disconnected popover
  // throws per spec) → the popover does not open.
  if (!fireBeforeToggle(dl, true) || hasState(dl, STATE_POPOVER_OPEN) || !isConnected(dl)) return;
  setStateBit(dl, STATE_POPOVER_OPEN, true);
  bumpStyleState();
  queueToggleTask(dl, 'closed', 'open');
}

// Close the combobox datalist popover when its `<input>` loses focus (the light-
// dismiss counterpart of showComboboxDatalist) — fires beforetoggle/toggle closed.
export function hideComboboxDatalist(input) {
  if (!input || input._tag !== 'input' || input._attrs.list == null) return;
  const dl = comboboxListFor(input);
  if (!dl || dl._tag !== 'datalist' || !hasState(dl, STATE_POPOVER_OPEN)) return;
  fireBeforeToggle(dl, false);
  setStateBit(dl, STATE_POPOVER_OPEN, false);
  bumpStyleState();
  queueToggleTask(dl, 'open', 'closed');
}

function runComboboxFilter(input) {
  const ctrl = comboboxListFor(input);
  if (ctrl == null) return;
  let opts;
  if (ctrl && ctrl._tag === 'select') opts = listOfOptions(ctrl);
  else if (ctrl && ctrl._tag === 'datalist') opts = ctrl.options ? Array.from(ctrl.options) : [];
  else return;
  const ev = new Event('beforefilter', { bubbles: false, cancelable: true });
  dispatchEvent(input, ev);
  if (ev._canceled) return;                    // page kept the previous filtering
  const needle = String(input.value || '').toLowerCase();
  for (const opt of opts) {
    const hay = (opt.textContent || '').trim().toLowerCase();
    const wasFiltered = hasState(opt, STATE_FILTERED);     // `undefined` on the first pass is not "filtered"
    setStateBit(opt, STATE_FILTERED, needle !== '' && !hay.startsWith(needle));
    // `:filtered` is a cascade input with no attribute behind it. NOT redundant with the value
    // setter's own signal: that one fires only when the value actually CHANGED, and the filter can
    // also be re-run by a `filter=` attribute change or a re-entrant set.
    if (hasState(opt, STATE_FILTERED) !== wasFiltered) bumpStyleState();
  }
}


// ── DOMTokenList ─────────────────────────────────────────────────
// https://dom.spec.whatwg.org/#interface-domtokenlist — the live token
// list behind classList / relList / sandbox / etc. Backed by (element,
// attribute local name): the engine reads the token set from the arena's
// attribute and answers what an edit writes (token_list.rs); the write
// round-trips through setAttribute so MutationObserver / cascade / CE
// callbacks see it.

// The supported-token sets a real browser's DOMTokenList.supports() reflects.
// These are the keywords the ENGINE actually registers (observed in Chromium
// 148), a strict subset of the keywords merely *valid* on the attribute — a
// feature-detect must see the same answer it would in the browser. `class`
// defines no supported tokens (so classList.supports() throws); the
// load-bearing case is Vite's boot-time `link.relList.supports('modulepreload')`.
// https://html.spec.whatwg.org/#concept-supported-tokens
const REL_LINK = new Set([
  'alternate', 'canonical', 'dns-prefetch', 'icon', 'manifest', 'modulepreload',
  'next', 'preconnect', 'prefetch', 'preload', 'stylesheet', 'apple-touch-icon'
]);
// a / area / form relLists all reflect the same three hyperlink keywords.
const REL_HYPERLINK = new Set(['noopener', 'noreferrer', 'opener']);
const SANDBOX_TOKENS = new Set([
  'allow-downloads', 'allow-forms', 'allow-modals', 'allow-orientation-lock',
  'allow-pointer-lock', 'allow-popups', 'allow-popups-to-escape-sandbox',
  'allow-presentation', 'allow-same-origin', 'allow-scripts',
  'allow-storage-access-by-user-activation', 'allow-top-navigation',
  'allow-top-navigation-by-user-activation'
]);
// The `blocking` content attribute (link / script / style) reflects a
// DOMTokenList whose only supported token is `render` (HTML render-blocking).
const BLOCKING_TOKENS = new Set(['render']);

// The supported-token set for an (element, attribute) pair, or null when the
// attribute defines none (e.g. class) — in which case supports() throws.
function supportedTokensFor(el, attr) {
  const tag = (el && el.tagName ? String(el.tagName) : '').toLowerCase();
  if (attr === 'rel') {
    if (tag === 'link') return REL_LINK;
    if (tag === 'a' || tag === 'area' || tag === 'form') return REL_HYPERLINK;
    return null;
  }
  if (attr === 'sandbox' && tag === 'iframe') return SANDBOX_TOKENS;
  if (attr === 'blocking' && (tag === 'link' || tag === 'script' || tag === 'style')) return BLOCKING_TOKENS;
  return null;
}

function validateToken(token, method) {
  if (token === '') {
    throw new globalThis.DOMException(
      `Failed to execute '${method}' on 'DOMTokenList': The token provided must not be empty.`,
      'SyntaxError');
  }
  if (ASCII_WHITESPACE.test(token)) {
    throw new globalThis.DOMException(
      `Failed to execute '${method}' on 'DOMTokenList': ` +
      `The token provided ('${token}') contains HTML space characters, which are not valid in tokens.`,
      'InvalidCharacterError');
  }
}

const TOKEN_ADD = 0, TOKEN_REMOVE = 1, TOKEN_TOGGLE = 2, TOKEN_REPLACE = 3;
// DOMTokenList (DOM §7.1): its binding generated from its IDL (generated/bindings.js); what each member does, here —
// over the element's attribute, whose token set the engine keeps (token_list.rs). Its state, in its slots: the element
// and the attribute's name.
const tokenListImpl = {
  init(list, el, attr) {
    list.el   = el;
    list.attr = attr;
  },
  get_length(list) { return globalThis.__dom.tokenListLength(list.el._nid, list.attr); },
  item(list, index) { return globalThis.__dom.tokenListItem(list.el._nid, list.attr, index); },
  contains(list, token) { return globalThis.__dom.tokenListContains(list.el._nid, list.attr, token); },
  add(list, tokens) {
    for (const t of tokens) validateToken(t, 'add');
    tokenListEdit(list, TOKEN_ADD, tokens);
  },
  remove(list, tokens) {
    for (const t of tokens) validateToken(t, 'remove');
    tokenListEdit(list, TOKEN_REMOVE, tokens);
  },
  toggle(list, token, force) {
    validateToken(token, 'toggle');
    return tokenListEdit(list, TOKEN_TOGGLE, [token], force);
  },
  replace(list, token, newToken) {
    // replace validates differently from add/remove: BOTH tokens are checked
    // for emptiness (SyntaxError) before EITHER is checked for whitespace
    // (InvalidCharacterError) — so replace(" ", "") is a SyntaxError, not an
    // InvalidCharacterError.
    if (token === '' || newToken === '') {
      throw new globalThis.DOMException(
        "Failed to execute 'replace' on 'DOMTokenList': The token provided must not be empty.",
        'SyntaxError');
    }
    if (ASCII_WHITESPACE.test(token) || ASCII_WHITESPACE.test(newToken)) {
      throw new globalThis.DOMException(
        "Failed to execute 'replace' on 'DOMTokenList': The token provided contains HTML space characters.",
        'InvalidCharacterError');
    }
    return tokenListEdit(list, TOKEN_REPLACE, [token, newToken]);
  },
  // Per spec, supports(token) throws only when the associated attribute
  // defines no supported tokens (e.g. class); for rel / sandbox it returns
  // whether the ASCII-lowercased token is in the supported set.
  supports(list, token) {
    const supported = supportedTokensFor(list.el, list.attr);
    if (!supported) {
      throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.");
    }
    return supported.has(asciiLower(token));
  },
  get_value(list) { return list.el._attrs[list.attr] || ''; },
  set_value(list, v) { list.el._setAttributeNS(null, list.attr, v); }
};
// An edit of the set (`TOKEN_ADD` …), its tokens checked already: the update steps' write, where they write, and the
// method's result.
function tokenListEdit(list, op, tokens, force) {
  const [result, value] = globalThis.__dom.tokenListEdit(list.el._nid, list.attr, op, tokens, force);
  if (value !== undefined) list.el._setAttributeNS(null, list.attr, value);   // (…the attribute in no namespace)
  return result;
}
const DOMTokenListBinding = defineDOMTokenList(tokenListImpl);
globalThis.DOMTokenList = DOMTokenListBinding.interface;

// An element's token list for an attribute — one per (element, attribute), so the IDL `[SameObject]` identity holds.
export function tokenListFor(el, attr) {
  const cache = el._tokenLists || (el._tokenLists = {});
  return cache[attr] || (cache[attr] = DOMTokenListBinding.create(el, attr));
}

// ── Namespaces + createElementNS validation ────────────
// HTML_NS / SVG_NS imported from constants.js (shared with form-helpers /
// dom-class-aliases); the XML / XMLNS namespaces are local to this module.

// SVGAnimatedString (SVG 2 §4.6.6), generated from its IDL: an attribute reflected as a base value and an animated one
// — which, with no SMIL animation modelled, is the base value. Made by the platform alone.
const svgBaseVal = (s) => s.el._getAttributeNS(null, s.attr) ?? '';
const svgAnimatedString = defineSVGAnimatedString({
  init(s, el, attr) { s.el = el; s.attr = attr; },
  get_baseVal: svgBaseVal,
  set_baseVal(s, v) { s.el._setAttributeNS(null, s.attr, v); },
  get_animVal: svgBaseVal
});
globalThis.SVGAnimatedString = svgAnimatedString.interface;

// DOMStringMap (HTML §3.2.6.6), generated from its IDL: an element's `dataset`, a legacy platform object with named
// properties — a Proxy over an object of this prototype (`datasetOf`), whose traps answer them and whose slots hold
// its element. (…made by the platform alone: the interface has no constructor)
registerInterface('DOMStringMap', (o) => slotsOf(o, 'DOMStringMap') !== undefined);
class DOMStringMap {
  constructor(token) { constructedBy(PLATFORM, token, 'DOMStringMap'); }
}
installDOMStringMap(DOMStringMap, {});
globalThis.DOMStringMap = DOMStringMap;

// ASCII-whitespace / NUL / "/" / ">" — the chars a prefix may not contain.
const PREFIX_FORBIDDEN = /[\t\n\f\r \0/>]/;
function isAsciiAlpha(c)  { return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A); }
function isAsciiDigit(c)  { return c >= 0x30 && c <= 0x39; }
// A valid namespace prefix: length >= 1 and none of the forbidden chars.
function isValidNamespacePrefix(s) { return s.length >= 1 && !PREFIX_FORBIDDEN.test(s); }
// https://dom.spec.whatwg.org/#valid-element-local-name (algorithmic form,
// to avoid a fragile literal-codepoint regex in source).
function isValidElementLocalName(name) {
  if (name.length === 0) return false;
  const c0 = name.codePointAt(0);
  if (isAsciiAlpha(c0)) return !PREFIX_FORBIDDEN.test(name);
  // otherwise the first code point must be ":", "_", or >= U+0080
  if (!(c0 === 0x3A || c0 === 0x5F || c0 >= 0x80)) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0);
    const ok = isAsciiAlpha(c) || isAsciiDigit(c) ||
               c === 0x2D || c === 0x2E || c === 0x3A || c === 0x5F || c >= 0x80;
    if (!ok) return false;
  }
  return true;
}

// IDL USVString coercion: replace unpaired UTF-16 surrogates with U+FFFD. URL-
// valued reflected attributes (href / src / ping / cite / …) are USVString, so
// their setters run the input through this before storing; the URL serializer
// then percent-encodes U+FFFD as %EF%BF%BD. A well-formed string is returned
// unchanged, so normal URLs are unaffected. (usvstring-reflection.)
function toUSVString(v) {
  return String(v).toWellFormed();
}
// Exposed for the other modules (Location, EventSource, StorageEvent,
// window.open, navigator URL methods) that take USVString arguments.
globalThis.__csimToUSVString = toUSVString;

// https://dom.spec.whatwg.org/#valid-doctype-name — no ASCII whitespace, NUL,
// or ">". (createDocumentType validates only the name; it does no namespace or
// QName checks, and an empty name is valid.)
const DOCTYPE_NAME_FORBIDDEN = /[\t\n\f\r \0>]/;
function isValidDoctypeName(name) { return !DOCTYPE_NAME_FORBIDDEN.test(name); }

// The node a namespace lookup starts from in the engine (namespaces.rs): an Attr's element, any other node itself.
function namespaceLookupNid(node) {
  const n = node._nodeType === NODE_ATTRIBUTE ? node._ownerElement : node;
  return n ? n._nid : null;
}

// https://dom.spec.whatwg.org/#dom-document-createevent — the legacy
// createEvent table: ASCII-lowercased interface name → the event interface's
// global constructor name. Anything not here is a NotSupportedError.
const CREATE_EVENT_INTERFACES = {
  beforeunloadevent:      BeforeUnloadEvent,
  compositionevent:       CompositionEvent,
  customevent:            CustomEvent,
  devicemotionevent:      DeviceMotionEvent,
  deviceorientationevent: DeviceOrientationEvent,
  dragevent:              DragEvent,
  event:                  Event,
  events:                 Event,
  focusevent:             FocusEvent,
  hashchangeevent:        HashChangeEvent,
  htmlevents:             Event,
  keyboardevent:          KeyboardEvent,
  messageevent:           MessageEvent,
  mouseevent:             MouseEvent,
  mouseevents:            MouseEvent,
  storageevent:           StorageEvent,
  svgevents:              Event,
  textevent:              TextEvent,
  // (…but touchevent, which the Touch Events spec adds only where it exposes its legacy APIs — no touch screen here,
  // no `ontouchstart`, as on a desktop Chrome; and wheelevent, a non-legacy interface: both NotSupportedError)
  uievent:                UIEvent,
  uievents:               UIEvent
};

// https://dom.spec.whatwg.org/#valid-attribute-local-name — like a namespace
// prefix but also forbidding "=".
const ATTR_NAME_FORBIDDEN = /[\t\n\f\r \0/=>]/;
function isValidAttributeLocalName(name) { return name.length >= 1 && !ATTR_NAME_FORBIDDEN.test(name); }

// The store key / localName for setAttribute/getAttribute by qualified name.
// ASCII-lowercased (NOT Unicode toLowerCase, which folds U+212A etc.) — the
// flat `_attrs` store, the CSS matcher, the cascade, and the serializer all key
// off this lowercased form, so it must stay consistent across them. (Case-
// sensitive namespaced attributes go through setAttributeNS, which keys on the
// qualified name directly and records the real case in `_attrNS`.)
// Attribute-name → store key. A name given an HTML-namespace element in an HTML
// document is ASCII-lowercased (DOM: HTML attributes are case-insensitive there);
// names on a non-HTML element (SVG / MathML / createElementNS), or on any element
// of an XML document, are CASE-SENSITIVE, so they key as-is — matching the
// case-preserving keys the parser/setAttributeNS store for foreign content
// (without this, an SVG `viewBox` stored case-preserved is unreadable via the
// lowercased lookup). The document is asked only of a name with an uppercase letter.
const ASCII_UPPER_RE = /[A-Z]/;
const lookupName = (el, s) => el && el._ns === HTML_NS && ASCII_UPPER_RE.test(s) && isHtmlDocument(el.ownerDocument) ? asciiLower(s) : s;
function attrKey(el, name) { return lookupName(el, String(name)); }
// The qualified name an attribute store key exposes (getAttributeNames /
// serialization). For the common case the key IS the qualified name; a
// collision-keyed namespaced attribute (see `freshAttrKey`) carries a synthetic
// key, so its real qualified name comes from `_attrNS`.
function attrQName(el, key) {
  const m = el._attrNS && el._attrNS[key];
  return m ? (m.prefix ? m.prefix + ':' + m.localName : m.localName) : key;
}
// A free `_attrs` store key for a NEW attribute whose qualified name is `qn`. Two
// attributes can share a qualified name in different namespaces (e.g. a null-ns
// `x` and a foo-ns `x`), but the value map can't share a key — so when `qn` is
// already taken by a different attribute, mint a unique synthetic key. The
// qualified name is recovered from `_attrNS` (attrQName); the synthetic key is
// never exposed. The NUL separator can't appear in a real qualified name.
// An attribute IN a namespace with no prefix (`setAttributeNS('urn:x', 'type', …)`) never takes the bare key even when
// it is free: every reflected IDL attribute reads its content attribute by that key (`_attrs.type`), and it names the
// attribute in NO namespace — Chrome's `input.type` stays "text" beside a `urn:x` `type`. (`namespaced`)
function freshAttrKey(el, qn, namespaced = false) {
  if (!namespaced && !Object.prototype.hasOwnProperty.call(el._attrs, qn)) return qn;
  let i = 1, k;
  do { k = qn + '\x00' + (i++); } while (Object.prototype.hasOwnProperty.call(el._attrs, k));
  return k;
}
// The store key of the FIRST attribute, in attribute-list order, whose qualified name is `name` — or null (DOM "get an
// attribute by name"). With no namespaced attribute every key IS its qualified name and one lookup answers; with one,
// the list decides: a namespaced `align` set before a plain one is the one `getAttribute('align')` reads.
function qnameKey(el, name) {
  if (!el._attrNS) {
    const k = attrKey(el, name);
    return Object.prototype.hasOwnProperty.call(el._attrs, k) ? k : null;
  }
  return firstAttrKeyByQName(el, name);
}
// First store key whose qualified name === `name` (HTML lowercases the lookup),
// in attribute (insertion) order, or null. Gated by the caller on `_attrNS`
// existing — with no namespaced attribute every key IS its qualified name, so a
// direct `_attrs[attrKey]` hit/miss is authoritative and this scan never runs.
function firstAttrKeyByQName(el, name) {
  const want = lookupName(el, String(name));
  for (const k in el._attrs) if (attrQName(el, k) === want) return k;
  return null;
}

// https://dom.spec.whatwg.org/#validate-and-extract. `context` is 'element' or
// 'attribute' (which validates the local name more permissively, allowing ":").
function validateAndExtract(namespace, qualifiedName, context) {
  if (namespace === "") namespace = null;
  let prefix = null, localName = qualifiedName;
  const ci = qualifiedName.indexOf(":");
  if (ci !== -1) {
    prefix = qualifiedName.slice(0, ci);
    localName = qualifiedName.slice(ci + 1);
  }
  if (prefix !== null && !isValidNamespacePrefix(prefix)) {
    throw new globalThis.DOMException(
      `The qualified name  contains an invalid prefix.`, "InvalidCharacterError");
  }
  const localNameOk = context === 'attribute'
    ? isValidAttributeLocalName(localName)
    : isValidElementLocalName(localName);
  if (!localNameOk) {
    throw new globalThis.DOMException(
      `The local name is not a valid name.`, "InvalidCharacterError");
  }
  if (prefix !== null && namespace === null) {
    throw new globalThis.DOMException("A namespace prefix was given but no namespace.", "NamespaceError");
  }
  if (prefix === "xml" && namespace !== XML_NS) {
    throw new globalThis.DOMException("The \"xml\" prefix requires the XML namespace.", "NamespaceError");
  }
  if ((qualifiedName === "xmlns" || prefix === "xmlns") && namespace !== XMLNS_NS) {
    throw new globalThis.DOMException("The \"xmlns\" name requires the XMLNS namespace.", "NamespaceError");
  }
  if (namespace === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
    throw new globalThis.DOMException("The XMLNS namespace is reserved for the xmlns name.", "NamespaceError");
  }
  return { namespace, prefix, localName };
}

// ChildNode (DOM §4.2.8) and NonDocumentTypeChildNode's members, for the node they are called on: CharacterData's
// (generated) and Element's and DocumentType's. `nodes` are nodes or strings, a string a Text node to be.
function childNodeBefore(child, nodes) {
  const parent = child._parent;
  if (!parent) return;
  // viable previous sibling: first preceding sibling not itself being inserted.
  let ref = child.previousSibling;
  while (ref && nodes.indexOf(ref) !== -1) ref = ref.previousSibling;
  const node = convertNodesHolding(nodes, child);
  parent._insertBefore(node, ref ? ref.nextSibling : parent.firstChild);
}
function childNodeAfter(child, nodes) {
  const parent = child._parent;
  if (!parent) return;
  // viable next sibling: first following sibling not itself being inserted.
  let ref = child.nextSibling;
  while (ref && nodes.indexOf(ref) !== -1) ref = ref.nextSibling;
  parent._insertBefore(convertNodesHolding(nodes, child), ref);
}
function childNodeReplaceWith(child, nodes) {
  const parent = child._parent;
  if (!parent) return;
  let ref = child.nextSibling;
  while (ref && nodes.indexOf(ref) !== -1) ref = ref.nextSibling;
  const node = convertNodesHolding(nodes, child);
  // Replace the child with the node (DOM "replace": the child removed, then the node — a fragment's children —
  // inserted, one record). If it was detached while converting (a node arg adopted it), fall back to the viable next
  // sibling.
  if (child._parent === parent) parent._replaceChild(node, child);
  else parent._insertBefore(node, ref);
}
function childNodeRemove(child) {
  if (child._parent) child._parent._removeChild(child);
}
// …the element siblings before and after it (a text or comment sibling skipped).
function previousElementSiblingOf(child) {
  if (!child._parent) return null;
  const sibs = child._parent._children;
  for (let i = siblingIndexOf(child._parent, child) - 1; i >= 0; i--) {
    if (sibs[i]._nodeType === NODE_ELEMENT) return sibs[i];
  }
  return null;
}
function nextElementSiblingOf(child) {
  if (!child._parent) return null;
  const sibs = child._parent._children;
  for (let i = siblingIndexOf(child._parent, child) + 1; i < sibs.length; i++) {
    if (sibs[i]._nodeType === NODE_ELEMENT) return sibs[i];
  }
  return null;
}

// ParentNode (DOM §4.2.6)'s members, for the parent they are called on: DocumentFragment's (generated), Element's and
// Document's. `nodes` are nodes or strings, a string a Text node to be.
function parentNodePrepend(parent, nodes) {
  parent._insertBefore(convertNodesHolding(nodes, parent), parent._children[0] || null);
}
function parentNodeAppend(parent, nodes) {
  parent._appendChild(convertNodesHolding(nodes, parent));
}
// …"replace all": 1. convert nodes (moving any from their old parents, which fires removal records THERE); 2. validate
// the result against the parent (a Document with an existing element child rejects another element, etc.) BEFORE
// touching its children; 3. detach its current children and insert the new ones, queueing a SINGLE childList record
// (removed = all old, added = all new) — not one per child.
function parentNodeReplaceChildren(parent, nodes) {
  const node = convertNodesHolding(nodes, parent);
  ensurePreInsertionValidity(node, parent, null);
  parent._replaceAll(node);
}
// …its children that are elements, a LIVE HTMLCollection (`item` / `namedItem`, the named getter): one per parent, so
// `el.children === el.children` and a hot traversal reads it in O(1); its Proxy re-runs the filter per settle
// generation, so it tracks the tree.
function childrenOf(parent) {
  return parent._childrenColl ||
    (parent._childrenColl = liveHTMLCollection(() => parent._children.filter(c => c._nodeType === NODE_ELEMENT)));
}
// …and the first, the last, and how many — walks of their own rather than `children`'s, so a hot traversal allocates
// no array to read one.
function firstElementChildOf(parent) {
  for (const c of parent._children) if (c._nodeType === NODE_ELEMENT) return c;
  return null;
}
function lastElementChildOf(parent) {
  for (let i = parent._children.length - 1; i >= 0; i--) {
    if (parent._children[i]._nodeType === NODE_ELEMENT) return parent._children[i];
  }
  return null;
}
function childElementCountOf(parent) {
  let n = 0;
  for (const c of parent._children) if (c._nodeType === NODE_ELEMENT) n++;
  return n;
}

// A Node is an EventTarget (DOM §4.4), but its object is the engine's: made by `__dom.NodeBase` (node_handle.rs), a
// wrapper of a handle on V8's C++ heap that frees the node's slot when V8 collects it — for the class being constructed,
// so it is allocated once, reading `new.target.prototype` once (custom-elements/HTMLElement-constructor), and returned
// in place of the one `super()` would make. NodeBase exists from a realm on, not in the snapshot that defines `Node`,
// where a node no realm's page ever sees (the warm-up's) is a plain object.
// Its type is given by the class constructing it (`super(NODE_TEXT)`; an element's, by default) and fixed: `nodeType`
// is Node.prototype's read-only accessor over it, so the type its members' brand checks read is the one it was made
// with (`x.nodeType = 1` had made a text node no CharacterData).
let realmNodeIds = false;
class Node extends EventTarget {
  constructor(type = NODE_ELEMENT) {
    // (…an interface with no constructor of its own: only its subclasses' are)
    if (new.target === Node) throw new TypeError("Failed to construct 'Node': Illegal constructor");
    const d = globalThis.__dom, base = d && d.NodeBase;
    if (base && !realmNodeIds) {
      // (…from the first node made with it, the handle ids are this realm's own: a node a frame made, adopted into the
      // parent's document, keeps its id there, which must name no node of the parent's)
      realmNodeIds = true;
      __nextId += d.realmId * REALM_ID_SPAN;
    }
    const self = base ? Reflect.construct(base, [], new.target) : Object.create(new.target.prototype);
    self._id        = __nextId++;
    self._parent    = null;
    self._children  = newChildList();  // ordered child nodes (`childNodes` the NodeList over them)
    self._childNodes = null;   // …that NodeList, made when first asked for ([SameObject])
    self._listeners = null;    // type → [{handler, capture}]; lazy
    self._nodeType  = type;
    self.__csimSelf = self;
    self._ownerDoc  = null;    // set by createElement/adopt; pre-init keeps the hidden class STABLE so the
                               // per-element hot readers (find/visible_text/cascade) hit monomorphic ICs.
    return self;
  }
  _getRootNode(options) {
    // DOM "get the root": the topmost node reached by following `_parent`.
    // `composed: false` (the default) stops at a shadow boundary — a
    // ShadowRoot's `_parent` IS its host, so without the break we'd cross into
    // the light tree and wrongly report the document. `composed: true` returns
    // the shadow-INCLUDING root and keeps climbing across the boundary.
    const composed = !!(options && options.composed);
    let cur = this;
    while (cur._parent) {
      if (!composed && cur._isShadowRoot) break;
      cur = cur._parent;
    }
    return cur;
  }
  // Per DOM, `nodeValue` is null for every node type except Attr (its value)
  // and CharacterData (its data), and its setter is a no-op on the others.
  // CharacterData / Attr override both; this base covers Document,
  // DocumentFragment, DocumentType, and Element (which otherwise inherited an
  // `undefined` nodeValue here).
  get _nodeValue()    { return null; }
  set _nodeValue(_v)  { /* no-op for non-Attr / non-CharacterData nodes */ }
  // `Node.isEqualNode(other)` per DOM spec — structural equality
  // ignoring node identity. Turbo Drive's `PageRenderer.
  // mergeProvisionalElements` walks the old/new head's provisional
  // elements and calls `newElement.isEqualNode(element)` to decide
  // which to keep; without this the render chain throws "isEqualNode
  // is not a function" inside `await prepareToRenderSnapshot`,
  // never fires `turbo:before-render`, and the body swap that should
  // turn `/edit` into the `/show` page silently aborts (the URL
  // updates via history.pushState earlier in the chain but the DOM
  // stays on the edit form).
  _isEqualNode(other) {
    if (other == null || this._nodeType !== other._nodeType) return false;
    if (this._nodeType === NODE_ELEMENT) {
      // Elements compare on namespace + prefix + local name (NOT the lowercased
      // `_tag`, which would miss case / namespace differences), then on their
      // attribute lists matched by (namespace, local name, value), order-
      // independently.
      if (this._ns !== other._ns || this._prefix !== other._prefix || this._localName !== other._localName) return false;
      const ak = Object.keys(this._attrs), bk = Object.keys(other._attrs);
      if (ak.length !== bk.length) return false;
      const bMap = new Map();
      for (const k of bk) {
        const m = other._attrNS && other._attrNS[k];
        bMap.set((m ? m.ns || '' : '') + '\x00' + (m ? m.localName : k), other._attrs[k]);
      }
      for (const k of ak) {
        const m = this._attrNS && this._attrNS[k];
        const key = (m ? m.ns || '' : '') + '\x00' + (m ? m.localName : k);
        if (!bMap.has(key) || bMap.get(key) !== this._attrs[k]) return false;
      }
    } else if (this._nodeType === NODE_ATTRIBUTE) {
      if (this._ns !== other._ns || this._localName !== other._localName || this._attrValue !== other._attrValue) return false;
    } else if (this._nodeType === NODE_DOCTYPE) {
      if (this._name !== other._name || this._publicId !== other._publicId || this._systemId !== other._systemId) return false;
    } else if (this._nodeType === NODE_PI) {
      if (this._target !== other._target || (this._data || '') !== (other._data || '')) return false;
    } else if (this._nodeType === NODE_TEXT || this._nodeType === NODE_COMMENT) {
      if ((this._data || '') !== (other._data || '')) return false;
    }
    const ac = this._children || [], bc = other._children || [];
    if (ac.length !== bc.length) return false;
    for (let i = 0; i < ac.length; i++) {
      if (!ac[i].isEqualNode(bc[i])) return false;
    }
    return true;
  }



  // Where `other` is against this node in tree order (DOM §4.4), the engine's (traversal.rs): an Attr goes as its
  // element and its place in that element's attribute list. (Sizzle / Stimulus sort by it; idiomorph reads its
  // CONTAINS / CONTAINED_BY bits.)
  _compareDocumentPosition(other) {
    if (other === this) return 0;
    return globalThis.__dom.comparePosition(
      positionNode(other),
      positionAttrKey(other),
      boundaryNid(other),
      positionNode(this),
      positionAttrKey(this),
      boundaryNid(this)
    );
  }

  // Shallow / deep node cloning. jQuery probes feature support
  // via `document.createElement('div').cloneNode(true).attachEvent`
  // etc. before initialising, so this needs to work even on
  // detached nodes. Cloned nodes copy attrs and (deep) clone
  // children; listeners + custom-element state are intentionally
  // *not* copied (matches HTML spec).
  _cloneNode(deep, _skipUpgrade) {
    // DOM: cloning a shadow root directly is not allowed (a shadow root is
    // cloned only as part of cloning its clonable host) — throw NotSupportedError.
    if (this._isShadowRoot) {
      throw new globalThis.DOMException("Failed to execute 'cloneNode' on 'Node': ShadowRoot nodes are not clonable.", 'NotSupportedError');
    }
    const copy = this._cloneShell();
    // DOM "clone a node": the copy's node document is the source's — a document's own clone is its own.
    if (copy._nodeType !== NODE_DOC) copy._ownerDoc = this._ownerDoc;
    // …and an element's attributes are appended to it, their change steps run: an open details element's toggle, an
    // open dialog's opening.
    if (copy._nodeType === NODE_ELEMENT && copy._attrs.open != null) appendedAttributeSteps(copy, 'open');
    if (deep && this._children) {
      // (…each subtree upgraded ONCE at the top call, below, not per node)
      insertEdges(copy, Array.from(this._children, (c) => c._cloneNode(true, true)), -1);
      // A deep-cloned Document must re-own its cloned subtree — the copied
      // nodes' _ownerDoc still points at the original, but a document clone's
      // descendants belong to the clone (like createDocument / createHTMLDocument
      // re-tag). ownerDocument drives tag-name casing, createAttribute, the
      // FrameController cross-document check, etc. (documentElement is derived
      // from _children, so the cloned tree above already establishes it.)
      if (copy._nodeType === NODE_DOC) {
        for (const c of copy._children) walkSubtree(c, n => { n._ownerDoc = copy; });
      }
    }
    // `<template>.content` carries the inert children; mirror them
    // onto the clone so `template.content.cloneNode(true)` (Avo's
    // belongs_to polymorphic pattern, Turbo's StreamMessage parsing)
    // lands on a real DocumentFragment.
    if (deep && this._nodeType === NODE_ELEMENT && this._tag === 'template' && this._templateContent) {
      const frag = new DocumentFragment();
      frag._ceRegistry = TRACKING_NULL;   // a template clone's content is template content too
      // The clone's content stays in the SOURCE's inert template document (its
      // children cloned owners agree); a later cross-document adopt of the
      // clone re-homes it via adoptTemplateContentInto.
      frag._ownerDoc = this._templateContent._ownerDoc;
      // (…inert: nothing in it is upgraded)
      for (const c of this._templateContent._children) appendEdge(frag, c._cloneNode(true, true));
      frag._host = copy;   // (…a template's contents, as `content` makes them: its host the template)
      copy._templateContent = frag;
    }
    // A clonable shadow root is duplicated onto the clone, deep-cloning its
    // tree — independent of `deep` (cloneNode(false) of the host still clones
    // the shadow). `_shadowRoot` is unset on virtually every element, so this
    // is a cheap short-circuit on the hot clone path (rule 3).
    if (this._nodeType === NODE_ELEMENT && this._shadowRoot && this._shadowRoot.clonable) {
      const src = this._shadowRoot;
      const sr  = copy._attachShadow({ mode: src.mode, slotAssignment: src.slotAssignment, clonable: true,
                                      delegatesFocus: src.delegatesFocus, serializable: src.serializable });
      // Carry the parse-time authored shadowrootadoptedstylesheets value so a
      // cloned serializable shadow root round-trips it via getHTML().
      sr._adoptedStyleSheetsAttr = src._adoptedStyleSheetsAttr;
      if (src._ceRegistry !== undefined) sr._ceRegistry = src._ceRegistry;   // declarative null / scoped travels with the clone
      if (src._keepNullRegistry) sr._keepNullRegistry = true;
      // (…upgraded as the clone is: the top call's upgrade walks the light tree, so each shadow child is a top call of
      // its own — but none where the clone is not upgraded at all, importNode's)
      for (const c of src._children) appendEdge(sr, c._cloneNode(true, _skipUpgrade));
    }
    // DOM "clone a node" creates each cloned element with the synchronous custom-element flag, so a
    // clone that matches a definition in this document's registry is UPGRADED — its constructor runs
    // (a `constructed` reaction) and attributeChanged fires for each observed attribute copied onto it,
    // but NOT connectedCallback (the clone is detached). Done ONCE over the whole clone tree at the
    // top-level call (the recursive child clones pass _skipUpgrade). "clone a node" preserves the
    // source's node document, and a subtree is uniformly one document, so gate on the SOURCE's
    // document: only the live document has a registry to upgrade against. (The clone's own
    // `ownerDocument` getter falls back to the live document when detached — it can't be trusted here;
    // an element cloned out of an inert DOMParser / window-less document must NOT upgrade. importNode
    // passes _skipUpgrade and runs its own upgrade after re-owning the clone to the target document.)
    if (!_skipUpgrade && this.ownerDocument === globalThis.document) ceUpgradeTree(copy);
    return copy;
  }
  get _parentNode()    { return this._parent; }
  get _parentElement() { return this._parent && this._parent._nodeType === NODE_ELEMENT ? this._parent : null; }
  // `Node.isConnected` — true iff this node's root is its owner
  // document (i.e. it's attached to the live tree). Turbo's
  // `dispatch` helper checks `target.isConnected` before
  // `target.dispatchEvent(event)` and falls back to
  // `document.documentElement.dispatchEvent(event)` when false — so
  // a missing `isConnected` getter makes every dispatched event's
  // `target` resolve to `<html>`, which breaks `clickEventIsSignificant`
  // (`element.closest("turbo-frame, html") == this.element` is no
  // longer the link's html-ancestor relationship). Frame-redirect
  // for link clicks with `data-turbo-frame` stops working.
  // `Node.normalize()` per DOM spec — merge adjacent exclusive-Text
  // children (concatenating their data), drop empty Text nodes, then
  // recurse into element children. Sanitizers / contenteditable
  // reconcilers call it to coalesce text runs after repeated edits.
  _normalize() {
    const kids = this._children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (node._nodeType === NODE_TEXT) {
        if ((node._data || '').length === 0) {
          // Removing an empty Text node — mirror removeChild's
          // observable contract: queue a childList removedNodes record,
          // drop connectivity, and null the parent. Capture siblings first.
          const ep = i > 0 ? kids[i - 1] : null;
          const en = i + 1 < kids.length ? kids[i + 1] : null;
          removeEdgeAt(this, i);
          unregisterSubtree(node);
          recordChildList(this, [], [node], ep, en);
          i--;
          continue;
        }
        let next = kids[i + 1];
        while (next && next._nodeType === NODE_TEXT) {
          // Concatenate the sibling into the survivor; fire a
          // characterData record carrying the survivor's pre-merge value.
          const prev = node._data || '';
          node._appendData(next._data || '');
          recordCharacterData(node, prev);
          // (…the live ranges in it, or in this at its index, moved into the survivor: DOM normalize steps 6.4-6.5)
          globalThis.__dom.rangesMerge(node._nid, node, next._nid, this._nid, i + 1, prev.length);
          // The removed node's previousSibling is the survivor `node`; its
          // nextSibling is whatever follows it (captured before the splice).
          const removedNext = kids[i + 2] || null;
          removeEdgeAt(this, i + 1);
          unregisterSubtree(next);
          recordChildList(this, [], [next], node, removedNext);
          next = kids[i + 1];
        }
      } else if (node._nodeType === NODE_ELEMENT) {
        node.normalize();
      }
    }
  }
  // https://dom.spec.whatwg.org/#dom-node-lookupnamespaceuri
  // Namespace lookups (DOM §4.4) are the engine's (namespaces.rs).
  _lookupNamespaceURI(prefix) {
    return globalThis.__dom.locateNamespace(namespaceLookupNid(this), (prefix == null || prefix === '') ? null : String(prefix));
  }
  // https://dom.spec.whatwg.org/#dom-node-isdefaultnamespace
  _isDefaultNamespace(namespace) {
    const want = (namespace == null || namespace === '') ? null : String(namespace);
    return globalThis.__dom.locateNamespace(namespaceLookupNid(this), null) === want;
  }
  // https://dom.spec.whatwg.org/#dom-node-lookupprefix
  _lookupPrefix(namespace) {
    if (namespace == null || namespace === '') return null;
    return globalThis.__dom.locatePrefix(namespaceLookupNid(this), String(namespace));
  }
  // `Node.baseURI` — the node document's document base URL, honouring the
  // first `<base href>` element (falling back to the document URL). Document
  // overrides to resolve against itself.
  get _baseURI() {
    const d = this.ownerDocument;
    if (d && d !== this) return documentBaseURL(d);
    return (globalThis.location && globalThis.location.href) || 'about:blank';
  }
  // `Node.contains(other)` — true if other is inclusively `this` or
  // descendant. Per DOM spec lives on Node (Document inherits).
  // jQuery 3.x's `isAttached(elem)` calls
  // `jQuery.contains(elem.ownerDocument, elem)`, and jQuery.contains
  // internally calls `document.contains(elem)`; without the method
  // on Document the isHidden path threw and `.toggle()` mis-decided
  // its direction (always hide).
  _contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur._parent;
    }
    return false;
  }
  // DOM "replace all" with `node` (a fragment's children, or none for null) — replaceChildren's and the textContent
  // setter's.
  _replaceAll(node) {
    const isFrag  = node && node._nodeType === NODE_FRAGMENT;
    const added   = isFrag ? clearEdges(node) : (node ? [node] : []);
    const wasConnected = isConnected(this);
    const outer = holdAdoptions();
    let adoptions, removed;
    try {
      removed = clearEdges(this);
      for (const c of removed) unregisterSubtree(c);
      // (…a select reset at the removal, before the new nodes are there to be picked)
      askForResetAfterReplaceAll(removed, this);
      // A node from anywhere else (the single-node case) is adopted into this document and taken from its old parent —
      // firing its own record there. Fragment children were on `node` (moved there by convertNodesIntoNode, in this
      // document), which is emptied above; they are just re-homed.
      if (!isFrag) for (const c of added) adoptIntoParent(this, c);
      insertEdges(this, added, -1);
      for (const c of added) registerSubtree(c);
    } finally {
      adoptions = releaseAdoptions(outer);
    }
    if (removed.length || added.length) recordChildList(this, added, removed);
    fireAdoptions(adoptions);
    if (wasConnected) {
      for (const c of removed) fireCEDisconnect(c);
      for (const c of added)   globalThis.__csimFireCEConnect(c);
    }
    // Reconcile selectedness over the WHOLE batch (the last inserted selected
    // option wins, not the first — a per-child loop here would let the first
    // win, same bug as `_insertFragmentChildren`). For a `<select>` target,
    // `finalizeSelectOptions` below is the authoritative reconcile (it also
    // initialises a multiple-select's options); `askForResetBatch` is what
    // covers replaceChildren onto an `<optgroup>` inside a select, where the
    // finalize doesn't fire.
    askForResetBatch(added);
    groupInsertionSteps(added);
    // Rebuilding a `<select>`'s options wholesale (`select.innerHTML = …`,
    // a common Stimulus/jQuery refresh) bypasses the connect-walk's
    // per-select finalize because the select itself isn't in the walked
    // subtree — initialise + reconcile selectedness here so the implicit
    // default lands even on a detached or multiple select.
    if (this._tag === 'select') finalizeSelectOptions(this);
    // …and a <script>'s children changed steps, as `appendChild` of a child runs them: an empty connected script whose
    // `text` / `textContent` is set afterwards runs now (Chrome).
    if (this._tag === 'script' && (removed.length || added.length)) globalThis.__csimPrepareScript(this);
    // A non-dirty <textarea>'s value is its child text; "replace all" clears the children (value → "") before
    // inserting, which clamps the text entry cursor to 0 — and the re-insert does not restore it. A dirty textarea's
    // value is its own `_value`, so its children (the default) don't affect the selection.
    if (this._tag === 'textarea' && this._value == null) {
      this._selectionStart = 0;
      this._selectionEnd   = 0;
    }
  }
  get _nextSibling() {
    if (!this._parent) return null;
    const sibs = this._parent._children;
    const i = siblingIndexOf(this._parent, this);
    return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
  }
  get _previousSibling() {
    if (!this._parent) return null;
    const sibs = this._parent._children;
    const i = siblingIndexOf(this._parent, this);
    return i > 0 ? sibs[i - 1] : null;
  }
  // Move every child of `frag` into this before `ref` (null = append), per the
  // DOM "insert"/"remove" steps: the fragment's children are first removed (ONE
  // childList record on the fragment) then inserted (ONE record on this with all
  // of them as addedNodes) — not one record per child.
  _insertFragmentChildren(frag, ref) {
    const moved = frag._children.slice();
    if (!moved.length) return frag;                 // empty fragment: no-op, no records
    // A ShadowRoot source's children are connected THROUGH its host
    // (sr._parent = host) — moving them out is a disconnect, and the CE
    // sequence must read disconnected → adopted → connected. A plain or
    // template-content fragment is never connected, so this stays false there.
    const srcConnected = isConnected(frag);
    clearEdges(frag);
    recordChildList(frag, [], moved, null, null);   // fragment emptied: one removal record
    if (srcConnected) for (const c of moved) fireCEDisconnect(c);
    let idx = ref == null ? this._children.length : childIndexOf(this, ref);
    if (idx < 0) idx = this._children.length;
    const prevSib = idx > 0 ? this._children[idx - 1] : null;
    const nextSib = idx < this._children.length ? this._children[idx] : null;
    const connected = isConnected(this);
    // Parent every child, running each <source>'s insertion step (media
    // networkState) as we go. This is an INSERTION step, so it must precede the
    // post-insertion connect walk below — an earlier-inserted <script> running
    // there must already observe a later <source>'s networkState change
    // (Node-appendChild-script-and-source-from-fragment).
    // adoptIntoParent (not bare registryOnInsert): the children change node
    // documents when the destination's differs — a ShadowRoot / template-content
    // source, or a fragment built in another document — and DOM "insert" adopts
    // each into the parent's document (adoptedCallback between the disconnect
    // above and the connect walk below). Same-document moves skip the adopt and
    // reach registryOnInsert exactly as before.
    // (Their adoptedCallback reactions wait until every child is in place — `holdAdoptions`.)
    // (…each adopted while it has no parent, then linked: adopting a node that has one takes it out of it)
    const outer = holdAdoptions();
    let adoptions;
    try {
      for (const c of moved) adoptIntoParent(this, c);
      insertEdges(this, moved, idx);
      for (const c of moved) { registerSubtree(c); runSourceInsertionStep(c, this); }
    } finally {
      adoptions = releaseAdoptions(outer);
    }
    recordChildList(this, moved.slice(), [], prevSib, nextSib);  // one addition record
    fireAdoptions(adoptions);
    if (this._tag === 'script') globalThis.__csimPrepareScript(this);   // outer <script> runs before the inserted children's insertion steps
    if (connected) for (const c of moved) globalThis.__csimFireCEConnect(c);
    askForResetBatch(moved);   // one reconcile: the LAST inserted selected option wins, not the first
    groupInsertionSteps(moved);
    return frag;
  }
  // Replace `old` (a child of this) with `nodes` (already-detached nodes, e.g.
  // a parsed fragment's children) as a single DOM "replace": ONE childList
  // record on this with removedNodes = [old] and addedNodes = nodes — not a
  // remove plus separate inserts. Shared by the `outerHTML` setter and
  // replaceChild's DocumentFragment branch.
  _replaceChildWithNodes(old, nodes) {
    const i = childIndexOf(this, old);
    if (i < 0) return;
    const wasConnected = isConnected(this);
    const prevSib = i > 0 ? this._children[i - 1] : null;
    const nextSib = i + 1 < this._children.length ? this._children[i + 1] : null;
    const outer = holdAdoptions();
    let adoptions, refused = null;
    try {
      for (const c of nodes) adoptIntoParent(this, c);
      // DOM "replace": `old` removed — a select reset there, its default pick among what is left — then the nodes
      // inserted before what followed it (the removal's steps — a frame's unload — may have moved the children).
      const ref = old.nextSibling;
      removeEdgeAt(this, childIndexOf(this, old));
      unregisterSubtree(old);
      askForResetAfterRemoval(old, this);
      const at = insertionAfterRemoval(this, ref);
      if (typeof at === 'number') {
        insertEdges(this, nodes, at);
        for (const c of nodes) registerSubtree(c);
      } else {
        refused = at;
      }
    } finally {
      adoptions = releaseAdoptions(outer);
    }
    if (refused) return refusedAfterRemoval(this, old, prevSib, nextSib, adoptions, wasConnected, refused);
    recordChildList(this, nodes.slice(), [old], prevSib, nextSib);
    fireAdoptions(adoptions);
    if (wasConnected) {
      fireCEDisconnect(old);
      for (const c of nodes) globalThis.__csimFireCEConnect(c);
    }
    askForResetBatch(nodes);   // one reconcile over the replacement list (last selected option wins)
    groupInsertionSteps(nodes);
  }
  _appendChild(child) {
    assertNodeArg(child);
    ensurePreInsertionValidity(child, this, null);
    return this._appendValid(child);
  }
  // Append `child`, its pre-insertion validity ensured.
  _appendValid(child) {
    // DocumentFragment splice: spec says appendChild(fragment) moves
    // each child of the fragment to the new parent and leaves the
    // fragment empty. The fragment itself is not inserted. Real-DOM
    // libraries (jQuery's `.html(fragment)`, Stimulus's element
    // templating) rely on this — without unwrapping we'd graft a
    // bare DocumentFragment into the tree, breaking ancestor walks
    // and Capybara's visibility / find_xpath paths.
    if (child && child._nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, null);
    const outer = holdAdoptions();
    let adoptions;
    try {
      adoptIntoParent(this, child);
      const insertIndex = this._children.length;
      appendEdge(this, child);
      registerSubtree(child);
    } finally {
      adoptions = releaseAdoptions(outer);
    }
    runSourceInsertionStep(child, this);   // <source> insertion step (media networkState) — connectedness-independent
    recordChildList(this, [child], []);
    fireAdoptions(adoptions);
    if (this._tag === 'script') globalThis.__csimPrepareScript(this);   // outer <script> runs before the inserted child's insertion steps
    if (isConnected(this)) globalThis.__csimFireCEConnect(child);
    askForReset(child);
    groupInsertionSteps([child]);
    return child;
  }
  _removeChild(child) {
    assertNodeArg(child);
    // Spec: removeChild throws NotFoundError if `child` is not a child of this.
    if (child._parent !== this) {
      throw new globalThis.DOMException(
        'The node to be removed is not a child of this node.', 'NotFoundError');
    }
    const i = childIndexOf(this, child);
    if (i < 0) return null;
    // Capture the removed node's adjacent siblings BEFORE the splice — by
    // record-delivery time `child` is detached, so its own pointers are gone
    // and recordChildList can't derive them (it only derives from added nodes).
    const prevSib = i > 0 ? this._children[i - 1] : null;
    const nextSib = i + 1 < this._children.length ? this._children[i + 1] : null;
    const wasConnected = isConnected(this);
    removeEdgeAt(this, i);
    unregisterSubtree(child);
    // Focus fixup: removing the currently-focused element (or an ancestor of
    // it) resets the document's focus. `removeChild` is the "remove" half of a
    // regular move, so a focused element relocated via appendChild/insertBefore
    // loses focus — unlike `moveBefore`, which splices directly and preserves
    // it. activeElement falls back to <body> once cleared (see the getter).
    // Silent reset (no blur/focusout) matches Chromium's observable behavior on
    // DOM removal. Cheap: short-circuits unless something is focused. (The document the parent is in, which code
    // another realm made it with removes from too.)
    const doc = this._nodeType === NODE_DOC ? this : this.ownerDocument;
    const ae  = doc && doc._activeElement;
    const he  = doc && doc._hoverElement;
    // The hovered element leaves with its subtree, like the focused one below — a state flip, announced HERE.
    if (he && (he === child || nodeContains(child, he))) {
      doc._hoverElement = null;
      bumpStyleState();
    }
    if (ae && (ae === child || nodeContains(child, ae))) {
      doc._activeElement = null;
      bumpStyleState();
      // The detached control loses focus silently (no blur) → drop its pending
      // change-on-blur state so it doesn't carry focus-cycle state while detached.
      ae._changeBaseline = undefined;
      ae._editedSinceFocus = false;
    }
    recordChildList(this, [], [child], prevSib, nextSib);
    // An option (or a subtree containing options) leaving a select can
    // drop its selection to zero — re-run the owning select's algorithm.
    askForResetAfterRemoval(child, this);
    if (wasConnected) fireCEDisconnect(child);
    return child;
  }
  _insertBefore(child, ref) {
    assertNodeArg(child);
    if (ref != null) assertNodeArg(ref);
    ensurePreInsertionValidity(child, this, ref);
    // DOM pre-insert step 3: if the reference child IS the node being inserted,
    // advance it to the node's next sibling so "insert before itself" returns the
    // node to its own slot (a no-op move) instead of detaching it and appending
    // at the end (adoptIntoParent below would invalidate a ref === child).
    if (ref === child) ref = child.nextSibling;
    if (ref == null) return this._appendValid(child);
    // DocumentFragment splice — same unwrap as appendChild, but
    // inserting before `ref` rather than at the end (one record each on the
    // fragment and on this, via the shared helper).
    if (child && child._nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, ref);
    const outer = holdAdoptions();
    let adoptions;
    try {
      adoptIntoParent(this, child);
      const i = childIndexOf(this, ref);
      if (i < 0) {
        fireAdoptions(releaseAdoptions(outer));
        return this._appendValid(child);
      }
      insertEdge(this, child, i);
      registerSubtree(child);
    } finally {
      if (deferredAdoptions !== outer) adoptions = releaseAdoptions(outer);
    }
    runSourceInsertionStep(child, this);   // <source> insertion step (media networkState) — connectedness-independent
    recordChildList(this, [child], []);
    fireAdoptions(adoptions);
    if (this._tag === 'script') globalThis.__csimPrepareScript(this);   // outer <script> runs before the inserted child's insertion steps
    if (isConnected(this)) globalThis.__csimFireCEConnect(child);
    askForReset(child);
    groupInsertionSteps([child]);
    return child;
  }
  _replaceChild(neu, old) {
    // https://dom.spec.whatwg.org/#concept-node-replace — same validity as
    // pre-insertion but the document-child constraints exclude `old` (the node
    // being replaced), and `old` must itself be a child (NotFoundError).
    assertNodeArg(neu);
    assertNodeArg(old);
    validateInsertion(neu, this, old, true);
    const i = childIndexOf(this, old);
    if (i < 0) return null;
    // Replacing a node with itself: per spec `old` is removed and `node`
    // (=== old) is then inserted before old's former next sibling, so it
    // lands back in its own slot. The position is unchanged, but it is two
    // observable mutations — a removal then an addition — which observers see
    // (DOM "replace" steps 7/11/13 with node === child).
    if (neu === old) {
      const ref = old.nextSibling;
      this._removeChild(old);
      this._insertBefore(neu, ref);
      return old;
    }
    // A DocumentFragment is inserted as its CHILDREN, never as itself. Per the
    // DOM "replace" steps this is ONE childList record (removedNodes [old],
    // addedNodes the fragment's children) plus the fragment's own emptying
    // record — not a separate remove + insert. Covers
    // `document.replaceChild(frag, documentElement)`.
    if (neu._nodeType === NODE_FRAGMENT) {
      const moved = clearEdges(neu);
      if (moved.length) recordChildList(neu, [], moved, null, null);
      this._replaceChildWithNodes(old, moved);
      return old;
    }
    const wasConnected = isConnected(this);
    // Cross-document `neu` is adopted into this node's document (the insert
    // steps adopt); a same-document replace is just a detach. See adoptIntoParent.
    const outer = holdAdoptions();
    let adoptions, refused = null, prevSib = null, nextSib = null;
    try {
      adoptIntoParent(this, neu);
      // Re-find old's index: detaching `neu` above can shift it when `neu` was an
      // earlier sibling of `old` under this same parent.
      const j = childIndexOf(this, old);
      // Spec "replace" = remove `old` then insert `neu` at the same index, so
      // boundaries inside `old` collapse to (this, j) while boundaries past it
      // net out unchanged (the remove's −1 and the insert's +1 cancel) — and a
      // select resets at the removal, before `neu` is there to be picked.
      const ref = nextSib = old.nextSibling;
      prevSib = old.previousSibling;
      removeEdgeAt(this, j);
      unregisterSubtree(old);
      askForResetAfterRemoval(old, this);
      const at = insertionAfterRemoval(this, ref);
      if (typeof at === 'number') {
        insertEdge(this, neu, at);
        registerSubtree(neu);
      } else {
        refused = at;
      }
    } finally {
      adoptions = releaseAdoptions(outer);
    }
    if (refused) return refusedAfterRemoval(this, old, prevSib, nextSib, adoptions, wasConnected, refused);
    recordChildList(this, [neu], [old]);
    fireAdoptions(adoptions);
    if (wasConnected) { fireCEDisconnect(old); globalThis.__csimFireCEConnect(neu); }
    askForReset(neu);
    groupInsertionSteps([neu]);
    return old;
  }
  // textContent collects descendant text; setter replaces children
  // with a single text node.
  get _textContent() {
    // Descendant text content: concatenate the data of all Text node
    // descendants in tree order. CDATASection is a Text subclass so its data
    // counts too; comments and processing instructions are not Text nodes and
    // contribute nothing.
    let s = '';
    for (const c of this._children) {
      if (c._nodeType === NODE_TEXT || c._nodeType === NODE_CDATA) s += c.data;
      else if (c._nodeType === NODE_ELEMENT) s += c.textContent;
    }
    return s;
  }
  set _textContent(v) {
    // DOM "string replace all": the children replaced by one Text node (none for the empty string) — one childList
    // record (PM/Tiptap's domchange observer reads it), the removed subtree's removing steps and disconnections.
    const text = String(v == null ? '' : v);
    let node = null;
    if (text.length > 0) {
      // (…made in this node's document, which adopts nothing then — and not through `createTextNode`, which a page may
      // have replaced)
      node = new Text(text);
      node._ownerDoc = this.ownerDocument || globalThis.document;
    }
    this._replaceAll(node);
  }
}

// Cross-realm Node brand. Each iframe realm has its OWN Node class (separate
// identity), so `x instanceof Node` is false for a node that belongs to another
// realm — but WebIDL `Node` parameters accept a node from ANY realm. Every
// realm's bridge defines this same string-keyed marker on Node.prototype, so a
// cross-realm read of `x.__csimIsNode` resolves through that realm's prototype
// and is true for any csim node. Non-enumerable so it can't leak into `for..in`
// / `Object.keys` over a node.
Object.defineProperty(Node.prototype, '__csimIsNode', { value: true });
// WebIDL `Node` type guard that, unlike `instanceof Node`, also accepts nodes
// from another realm (e.g. an iframe's document passed to the top realm's
// `createTreeWalker` / `createNodeIterator` / `Range`).
export function isNodeArg(x) { return x != null && x.__csimIsNode === true; }
// …and one that IS a node, not an object inheriting from one (`Object.create(textNode)`): what an IDL brand check and a
// conversion to an interface type take — its type is its own.
// The node holds itself in a field every realm's nodes have (an inheriting object holds its prototype's, a form's or a
// document's Proxy is held by its target): one named property load — `Object.hasOwn` cost every member's brand check
// 8 ns, and a symbol key's keyed load a third of a mixed tree's walk.
function isNodeObject(x) { return x != null && x.__csimSelf === x; }
registerInterface('Node', isNodeObject);
// Node's members (generated/bindings.js): each node class's own steps where its kind answers for itself (`_nodeName`,
// `_ownerDocument`, `_textContent`, … — a Document's ownerDocument is null, a shadow root has no parentNode), Node's
// where one answers for all.
installNode(Node, {
  get_nodeType: (node) => node._nodeType,
  get_nodeName: (node) => node._nodeName,
  get_baseURI: (node) => node._baseURI,
  get_isConnected: isConnected,
  get_ownerDocument: (node) => node._ownerDocument,
  getRootNode: (node, options) => node._getRootNode(options),
  get_parentNode: (node) => node._parentNode,
  get_parentElement: (node) => node._parentElement,
  hasChildNodes: (node) => node._children.length > 0,
  get_childNodes: (node) => (node._childNodes ??= childNodeList(node)),
  get_firstChild: (node) => node._children[0] || null,
  get_lastChild: (node) => node._children[node._children.length - 1] || null,
  get_previousSibling: (node) => node._previousSibling,
  get_nextSibling: (node) => node._nextSibling,
  // (…`DOMString?`: null is the empty string to a node whose value can be set)
  get_nodeValue: (node) => node._nodeValue,
  set_nodeValue(node, value) { node._nodeValue = value === null ? '' : value; },
  get_textContent: (node) => node._textContent,
  set_textContent(node, value) { node._textContent = value === null ? '' : value; },
  normalize: (node) => node._normalize(),
  cloneNode: (node, deep) => node._cloneNode(deep),
  isEqualNode: (node, other) => node._isEqualNode(other),
  isSameNode: (node, other) => node === other,
  compareDocumentPosition: (node, other) => node._compareDocumentPosition(other),
  contains: (node, other) => node._contains(other),
  lookupPrefix: (node, namespace) => node._lookupPrefix(namespace),
  lookupNamespaceURI: (node, prefix) => node._lookupNamespaceURI(prefix),
  isDefaultNamespace: (node, namespace) => node._isDefaultNamespace(namespace),
  insertBefore: (parent, node, child) => parent._insertBefore(node, child),
  appendChild: (parent, node) => parent._appendChild(node),
  replaceChild: (parent, node, child) => parent._replaceChild(node, child),
  removeChild: (parent, child) => parent._removeChild(child)
});

// CharacterData (https://dom.spec.whatwg.org/#interface-characterdata) — the
// shared base of Text / Comment / CDATASection / ProcessingInstruction. Real
// class (not a Text alias) so the prototype chain is `Text`/`Comment` →
// `CharacterData` → `Node`, which `instanceof` and the WPT constructor tests
// require. Subclasses set their own `nodeType` + `nodeName`.
class CharacterData extends Node {
  constructor(data, type) {
    // (…an interface with no constructor of its own: only its subclasses' are)
    if (new.target === CharacterData) throw new TypeError("Failed to construct 'CharacterData': Illegal constructor");
    super(type);
    // The constructor's `data` arg is `optional DOMString = ""` — undefined (no argument) "", anything else its
    // subclass's constructor converted.
    this._data = data === undefined ? '' : data;
  }
  // The character data, mirrored into the node's arena node on every write — this setter and `_appendData` are the
  // two doors all of them pass (the parser coalescing text, splitText, replaceData, a range extraction's clones…).
  get _data()       { return this.__data; }
  set _data(v)      { this.__data = v; syncArenaData(this, v); }
  // …an append sends only what it appends: the parser coalescing a long text and an `appendData` loop append chunk by
  // chunk, and re-sending the whole string each time made both quadratic.
  _appendData(s)    { this.__data += s; appendArenaData(this, s); }
  // nodeValue / textContent are nullable, so both null AND undefined → "".
  get _nodeValue()   { return this._data; }
  set _nodeValue(v)  { this._setData(v == null ? '' : String(v)); }
  get _textContent() { return this._data; }
  set _textContent(v){ this._setData(v == null ? '' : String(v)); }
  // Spec: every write to a Text node's `data` (or `nodeValue` /
  // `textContent`, which proxy through here) queues a
  // `characterData` mutation record. ProseMirror/Tiptap's
  // `domchange` reconciler reads these to map browser-side text
  // edits back into a transaction; without the record, our
  // `set("text")` on contenteditable updates the DOM but PM
  // silently skips the model update and `onUpdate` never fires.
  _setData(next) {
    const prev = this._data;
    // Setting data is "replace data" over the whole node (offset 0, count =
    // old length), so live-range boundaries inside the old data collapse to 0.
    // Per spec this runs unconditionally — even setting `.data` to its current
    // value still clamps the ranges — so it precedes the no-op short-circuit.
    liveRangesOnReplaceData(this, 0, prev.length, next.length);
    if (prev !== next) {
      this._data = next;
      recordCharacterData(this, prev);
    }
    this._dataReplaced();
  }
  // What replacing the data runs after it — a processing instruction's attributes updated from it — nothing for others.
  _dataReplaced() {}
  // prefix/namespaceURI/localName are NOT exposed on CharacterData: per DOM they
  // are IDL members of Element and Attr only, so `'localName' in textNode` must
  // be false (dom/historical.html).
  get _ownerDocument(){ return this._ownerDoc || globalThis.document; }
  // DOM "replace data": `count` UTF-16 code units from `offset` replaced with `str` — the count clamped to the data,
  // an offset past it an IndexSizeError.
  _replaceData(offset, count, str) {
    const prev = this._data;
    const len  = prev.length;
    if (offset > len) throw new globalThis.DOMException('The offset is greater than the data length.', 'IndexSizeError');
    if (offset + count > len) count = len - offset;
    // Live-range fix-up (DOM "replace data"): boundaries inside the replaced
    // span clamp to `offset`; boundaries after it shift by the length delta.
    liveRangesOnReplaceData(this, offset, count, str.length);
    // Per the "replace data" algorithm this ALWAYS queues a characterData
    // record — even for a no-op like appendData("") — so MutationObserver
    // tests waiting on the empty-mutation record don't hang.
    if (offset === len) this._appendData(str);
    else this._data = prev.slice(0, offset) + str + prev.slice(offset + count);
    recordCharacterData(this, prev);
    this._dataReplaced();
  }
}
globalThis.CharacterData = CharacterData;

// Text node (CharacterData subclass).
class Text extends CharacterData {
  // (…a string as it is — the parser's and the factories' — anything else converted as its IDL says: `new Text(Symbol())`
  // a TypeError)
  constructor(data) {
    if (data !== undefined && typeof data !== 'string') [data] = convertTextArguments(arguments);
    // (…a CDATASection comes through here too: to the arena it is text, which XML serializes as a CDATA section)
    super(data, new.target === CDATASection || new.target.prototype instanceof CDATASection ? NODE_CDATA : NODE_TEXT);
    registerNativeNode(this);
  }
  get _nodeName()    { return '#text'; }
  // A node of its own type holding `data` — a clone's, splitText's second half (a CDATASection's a CDATASection, as
  // Chrome and Firefox make it).
  _withData(data)   { return new Text(data); }
  _cloneShell()     { return this._withData(this._data); }
}

// Comment node. Created via `document.createComment(data)` and
// serialised as `<!--data-->`. Trix uses `<!--block-->` markers
// inside its rendered editor DOM, then strips them with a regex
// on `innerHTML` before storing in the form's hidden input — if
// we represented comments as text the marker leaked through as
// the literal string "block". Extends CharacterData directly (NOT Text)
// per spec — a Comment is not a Text node.
class Comment extends CharacterData {
  constructor(data) {
    if (data !== undefined && typeof data !== 'string') [data] = convertCommentArguments(arguments);
    super(data, NODE_COMMENT);
    registerNativeNode(this);
  }
  get _nodeName() { return '#comment'; }
  _cloneShell()  { return new Comment(this._data); }
}
globalThis.Comment = Comment;

// CharacterData, Text and Comment's members: generated from their IDL onto these classes (generated/bindings.js), what
// each does here. A node of each is told by its type.
const CHARACTER_DATA_TYPES = new Set([NODE_TEXT, NODE_CDATA, NODE_PI, NODE_COMMENT]);
registerInterface('CharacterData', (o) => isNodeObject(o) && CHARACTER_DATA_TYPES.has(o._nodeType));
registerInterface('Text', (o) => isNodeObject(o) && (o._nodeType === NODE_TEXT || o._nodeType === NODE_CDATA));
registerInterface('Comment', (o) => isNodeObject(o) && o._nodeType === NODE_COMMENT);
installCharacterData(CharacterData, {
  get_data(node) { return node._data; },
  set_data(node, data) { node._setData(data); },
  get_length(node) { return node._data.length; },
  // (…offsets and counts are UTF-16 code units, JS string indexing)
  substringData(node, offset, count) {
    if (offset > node._data.length) throw new globalThis.DOMException('The offset is greater than the data length.', 'IndexSizeError');
    return node._data.slice(offset, offset + count);   // slice clamps the end to the length
  },
  appendData(node, data) { node._replaceData(node._data.length, 0, data); },
  insertData(node, offset, data) { node._replaceData(offset, 0, data); },
  deleteData(node, offset, count) { node._replaceData(offset, count, ''); },
  replaceData(node, offset, count, data) { node._replaceData(offset, count, data); },
  get_previousElementSibling: previousElementSiblingOf,
  get_nextElementSibling: nextElementSiblingOf,
  before: childNodeBefore,
  after: childNodeAfter,
  replaceWith: childNodeReplaceWith,
  remove: childNodeRemove
});
installText(Text, {
  // Per DOM spec: split this text node into two at `offset`, keep the
  // prefix in `this`, return a new Text sibling holding the suffix
  // and inserted into the parent right after `this`. Discourse's
  // `HighlightedSearch` modifier calls splitText to wrap matched
  // substrings in `<span class="d-highlighted">`.
  splitText(node, offset) {
    const len = node._data.length;
    if (offset > len) {
      throw new globalThis.DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
    }
    const count   = len - offset;
    const newNode = node._withData(node._data.substring(offset));
    newNode._ownerDoc = node._ownerDoc;
    const parent = node._parent;
    if (parent) {
      const idx = childIndexOf(parent, node);
      insertEdge(parent, newNode, idx + 1);
      registerSubtree(newNode);
      recordChildList(parent, [newNode], []);   // the inserted half is an observable childList mutation
      // Live-range "split" fix-up: boundaries past the split point move to the
      // new node; a boundary at the new node's slot in the parent shifts right.
      liveRangesOnSplit(node, offset, newNode, parent, idx);
    }
    // Spec step: replace this node's data from `offset` (count chars) with "".
    // Runs BEFORE-moved boundaries are already on newNode, so this is a no-op
    // for them; remaining boundaries (≤ offset) stay put.
    node._replaceData(offset, count, '');
    return newNode;
  },
  // DOM `Text.wholeText`: the concatenated data of this node and its contiguous
  // Text-node siblings (the run of adjacent Text / CDATASection nodes), in tree
  // order. A non-Text sibling — or no parent — bounds the run.
  get_wholeText(node) {
    const parent = node._parent;
    if (!parent || !parent._children) return node._data;
    const kids = parent._children;
    const isTextLike = (n) => n && (n._nodeType === NODE_TEXT || n._nodeType === NODE_CDATA);
    let start = kids.indexOf(node);
    if (start < 0) return node._data;
    while (start > 0 && isTextLike(kids[start - 1])) start--;
    let s = '';
    for (let j = start; j < kids.length && isTextLike(kids[j]); j++) s += kids[j]._data;
    return s;
  },
  // Slottable (Text and Element alone): the slot this text node is assigned to in an open shadow tree.
  get_assignedSlot(node) { return findSlotForSlottable(node, true); }
});
installComment(Comment, {});

// CDATASection (XML only) — a Text subclass carrying literal character data.
// Created via `document.createCDATASection(data)` on an XML document.
class CDATASection extends Text {
  constructor(token, data) {
    constructedBy(PLATFORM, token, 'CDATASection');
    super(data);
  }
  get _nodeName() { return '#cdata-section'; }
  _withData(data) { return new CDATASection(PLATFORM, data); }
}
globalThis.CDATASection = CDATASection;
registerInterface('CDATASection', (o) => isNodeObject(o) && o._nodeType === NODE_CDATA);
installCDATASection(CDATASection, {});

// XML "Name" production (https://www.w3.org/TR/xml/#NT-Name) — stricter than the
// HTML-lenient element/attribute local-name checks: e.g. U+00B7 (·) is a
// NameChar but NOT a NameStartChar, and U+00D7 (×) is neither. Used by
// createProcessingInstruction's target validation.
function isXMLNameStartChar(c) {
  return c === 0x3A || (c >= 0x41 && c <= 0x5A) || c === 0x5F || (c >= 0x61 && c <= 0x7A) ||
    (c >= 0xC0 && c <= 0xD6) || (c >= 0xD8 && c <= 0xF6) || (c >= 0xF8 && c <= 0x2FF) ||
    (c >= 0x370 && c <= 0x37D) || (c >= 0x37F && c <= 0x1FFF) || (c >= 0x200C && c <= 0x200D) ||
    (c >= 0x2070 && c <= 0x218F) || (c >= 0x2C00 && c <= 0x2FEF) || (c >= 0x3001 && c <= 0xD7FF) ||
    (c >= 0xF900 && c <= 0xFDCF) || (c >= 0xFDF0 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0xEFFFF);
}
function isXMLNameChar(c) {
  return isXMLNameStartChar(c) || c === 0x2D || c === 0x2E || (c >= 0x30 && c <= 0x39) ||
    c === 0xB7 || (c >= 0x300 && c <= 0x36F) || (c >= 0x203F && c <= 0x2040);
}
function isXMLName(s) {
  if (s.length === 0) return false;
  let first = true;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (first) { if (!isXMLNameStartChar(c)) return false; first = false; }
    else if (!isXMLNameChar(c)) return false;
  }
  return true;
}

// ProcessingInstruction node (nodeType 7) — a CharacterData leaf carrying a read-only `target` plus `data`, and an
// attribute map (DOM §4.13): the pseudo-attributes of its data, parsed by the xml-stylesheet rules, which its data
// changes update and its attribute members write back as data. Made by `new ProcessingInstruction(target, data)` (its
// global's document's), `document.createProcessingInstruction`, and the XML parser.
class ProcessingInstruction extends CharacterData {
  // (…the platform's `(PLATFORM, target, data, ownerDoc)`, its arguments as they are)
  constructor(target, data) {
    let ownerDoc;
    if (target === PLATFORM) {
      [target, data, ownerDoc] = [arguments[1], arguments[2], arguments[3]];
    } else {
      [target, data] = convertProcessingInstructionArguments(arguments);
      checkProcessingInstruction("Failed to construct 'ProcessingInstruction': ", target, data);
      ownerDoc = globalThis.document;
    }
    super(data == null ? '' : String(data), NODE_PI);
    this._target    = String(target);
    this._ownerDoc  = ownerDoc || null;
    // (…the map, and the data it was read from or written as: a write of the data since leaves them apart)
    this._piAttrs     = null;
    this._piAttrsData = null;
    registerNativeNode(this);
  }
  get _nodeName()      { return this._target; }
  get _ownerDocument() { return this._ownerDoc || globalThis.document; }
  _cloneShell()       { return new ProcessingInstruction(PLATFORM, this._target, this._data, this._ownerDoc); }
  // (…its data replaced: its attributes read from it again when next asked for, and an `<?xml-stylesheet?>`'s sheet
  // obtained again — its href or type may have changed)
  _dataReplaced() {
    this._piAttrsData = null;
    this._sheet = null;
  }
  // "Update attributes from data", where the data changed since: its pseudo-attributes, or none where it has no such
  // syntax.
  _attributeMap() {
    if (this._piAttrsData !== this._data) {
      this._piAttrs = parsePseudoAttributes(this._data) || new Map();
      this._piAttrsData = this._data;
    }
    return this._piAttrs;
  }
  // "Update data from attributes": each attribute `name="value"`, the value's `&` `<` `>` `"` escaped, written as the
  // whole of its data — the map kept as it is, not read back from it.
  _writeAttributes(map) {
    let data = '';
    for (const [name, value] of map) {
      if (data !== '') data += ' ';
      data += name + '="' + value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '"';
    }
    this._replaceData(0, this._data.length, data);
    this._piAttrs = map;
    this._piAttrsData = this._data;
  }
}
// "Initialize a ProcessingInstruction": its target an XML Name, its data no instruction's end.
function checkProcessingInstruction(fail, target, data) {
  if (!isXMLName(target)) throw new globalThis.DOMException(`${fail}The target provided ('${target}') is not a valid name.`, 'InvalidCharacterError');
  if (data.includes('?>')) throw new globalThis.DOMException(`${fail}The data provided ('${data}') contains '?>'.`, 'InvalidCharacterError');
}
// The rules for parsing pseudo-attributes from a string (xml-stylesheet §3): `PseudoAtt? (S PseudoAtt)* S?`, each
// `Name S? = S? PseudoAttValue`, a value quoted by `"` or `'`, holding no `<`, its `&` a character reference to a legal
// character or one of the five predefined entities — the map of names to the values decoded, in their order, or null
// (an error) where the string is no such list, or names one twice.
const XML_S = /[ \t\r\n]/;
function parsePseudoAttributes(s) {
  const map = new Map();
  let i = 0;
  for (let first = true; ; first = false) {
    const start = i;
    while (i < s.length && XML_S.test(s[i])) i++;
    if (i === s.length) return map;
    if (!first && i === start) return null;
    const nameStart = i;
    while (i < s.length && !XML_S.test(s[i]) && s[i] !== '=') i += s.codePointAt(i) > 0xFFFF ? 2 : 1;
    const name = s.slice(nameStart, i);
    if (!isXMLName(name) || map.has(name)) return null;
    while (i < s.length && XML_S.test(s[i])) i++;
    if (s[i] !== '=') return null;
    i++;
    while (i < s.length && XML_S.test(s[i])) i++;
    const quote = s[i];
    if (quote !== '"' && quote !== "'") return null;
    const end = s.indexOf(quote, i + 1);
    if (end < 0) return null;
    const value = decodePseudoAttributeValue(s.slice(i + 1, end));
    if (value === null) return null;
    map.set(name, value);
    i = end + 1;
  }
}
const PREDEFINED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodePseudoAttributeValue(raw) {
  if (raw.includes('<')) return null;
  let out = '';
  for (let i = 0; i < raw.length;) {
    if (raw[i] !== '&') { out += raw[i++]; continue; }
    const semi = raw.indexOf(';', i);
    if (semi < 0) return null;
    const ref = raw.slice(i + 1, semi);
    let ch;
    if (/^#[0-9]+$/.test(ref)) ch = Number(ref.slice(1));
    else if (/^#x[0-9a-fA-F]+$/.test(ref)) ch = parseInt(ref.slice(2), 16);
    else if (Object.hasOwn(PREDEFINED_ENTITIES, ref)) ch = PREDEFINED_ENTITIES[ref];
    else return null;
    if (typeof ch === 'number') {
      // (…a reference to a character XML's Char production allows)
      const legal = ch === 0x9 || ch === 0xA || ch === 0xD || (ch >= 0x20 && ch <= 0xD7FF) || (ch >= 0xE000 && ch <= 0xFFFD) ||
        (ch >= 0x10000 && ch <= 0x10FFFF);
      if (!legal) return null;
      ch = String.fromCodePoint(ch);
    }
    out += ch;
    i = semi + 1;
  }
  return out;
}
// ProcessingInstruction's members, and CSSOM's LinkStyle: generated from their IDL onto the class.
registerInterface('ProcessingInstruction', (o) => isNodeObject(o) && o._nodeType === NODE_PI);
// (…a name an attribute's local name may be, else an InvalidCharacterError)
function checkPIAttributeName(member, name) {
  if (!isValidAttributeLocalName(name)) {
    throw new globalThis.DOMException(`Failed to execute '${member}' on 'ProcessingInstruction': '${name}' is not a valid attribute name.`, 'InvalidCharacterError');
  }
}
installProcessingInstruction(ProcessingInstruction, {
  get_target(pi) { return pi._target; },
  hasAttributes: (pi) => pi._attributeMap().size > 0,
  getAttributeNames: (pi) => [...pi._attributeMap().keys()],
  getAttribute(pi, name) {
    const value = pi._attributeMap().get(name);
    return value === undefined ? null : value;
  },
  setAttribute(pi, name, value) {
    checkPIAttributeName('setAttribute', name);
    const map = pi._attributeMap();
    map.set(name, value);
    pi._writeAttributes(map);
  },
  removeAttribute(pi, name) {
    const map = pi._attributeMap();
    map.delete(name);
    pi._writeAttributes(map);
  },
  toggleAttribute(pi, name, force) {
    checkPIAttributeName('toggleAttribute', name);
    const map = pi._attributeMap();
    if (!map.has(name)) {
      if (force === false) return false;
      map.set(name, '');
      pi._writeAttributes(map);
      return true;
    }
    if (force === true) return true;
    map.delete(name);
    pi._writeAttributes(map);
    return false;
  },
  hasAttribute: (pi, name) => pi._attributeMap().has(name),
  // CSSOM LinkStyle: an `<?xml-stylesheet?>` PI exposes its associated CSSStyleSheet via `.sheet` (mirrors
  // `<link rel=stylesheet>`) — by its pseudo-attributes (`href="…" type="…"`), none where its data has no such syntax.
  // Only `text/css` (or no type) qualifies; any other PI has none. (dom/nodes/ProcessingInstruction-escapes-1.xhtml)
  get_sheet(pi) {
    if (pi._target !== 'xml-stylesheet' || !pi.isConnected) { pi._sheet = null; return null; }
    const attrs = pi._attributeMap();
    const type = (attrs.get('type') || '').toLowerCase();
    if (type && type !== 'text/css') return null;
    const href = attrs.get('href');
    if (!href) return null;
    if (!pi._sheet) {
      // Same document-base resolution as the `<link>.sheet` getter (SW memo key +
      // frame-relative hrefs). A failed fetch (null) still yields an (empty) sheet.
      let sheetAbs = href;
      try { sheetAbs = new globalThis.URL(String(href), pi.baseURI || undefined).href; } catch (_) {}
      const id = engineSheetOf(pi, fetchStyleSheetText(sheetAbs) || '', sheetAbs, '', pi.ownerDocument, 0).id;
      pi._sheet = ownedStyleSheet(id, pi, { href: sheetAbs });
    }
    return pi._sheet;
  }
});
globalThis.ProcessingInstruction = ProcessingInstruction;

// Real Attr node (nodeType 2). Bound to an owner element it is a *view* over
// that element's attribute store (`attr.value` tracks live changes and writes
// through), so the existing fast `_attrs` map stays the single source of truth
// for the hot read paths (cascade / serialization). Detached
// (createAttribute, removeAttributeNode) it carries its own value. Identity is
// stable per (element, stored-key) through the element's `_attrNodes` cache.
class Attr extends Node {
  constructor(token, localName, namespace, prefix, value, ownerDoc) {
    constructedBy(PLATFORM, token, 'Attr');
    super(NODE_ATTRIBUTE);
    this._localName = String(localName);
    this._ns        = namespace == null ? null : String(namespace);
    this._prefix    = prefix    == null ? null : String(prefix);
    this._value     = value     == null ? ''   : String(value);
    this._ownerElement = null;
    this._key       = null;     // element store key while bound; null when detached
    this._ownerDoc  = ownerDoc || null;
  }
  get _nodeName()     { return attrQualifiedName(this); }
  get _ownerDocument(){ return this._ownerDoc || globalThis.document; }
  // Its value: its element's attribute while it is one of its element's, its own while it is not.
  get _attrValue() {
    const el = this._ownerElement;
    if (el && this._key != null && Object.prototype.hasOwnProperty.call(el._attrs, this._key)) {
      return el._attrs[this._key];
    }
    return this._value;
  }
  set _attrValue(v) {
    const s = String(v);
    const el = this._ownerElement;
    if (el && this._key != null) el._setAttrNodeValue(this._key, s);
    this._value = s;
  }
  get _nodeValue()   { return this._attrValue; }
  set _nodeValue(v)  { this._attrValue = v; }
  get _textContent() { return this._attrValue; }
  set _textContent(v){ this._attrValue = v; }
  _cloneShell() { return new Attr(PLATFORM, this._localName, this._ns, this._prefix, this._attrValue, this._ownerDoc); }
}
// An attribute's qualified name: its prefix and local name.
function attrQualifiedName(attr) {
  return attr._prefix ? attr._prefix + ':' + attr._localName : attr._localName;
}
// Attr's members: generated from its IDL onto the class.
function isAttr(o) { return isNodeObject(o) && o._nodeType === NODE_ATTRIBUTE; }
registerInterface('Attr', isAttr);
installAttr(Attr, {
  get_namespaceURI: (attr) => attr._ns,
  get_prefix: (attr) => attr._prefix,
  get_localName: (attr) => attr._localName,
  get_name: attrQualifiedName,
  get_value: (attr) => attr._attrValue,
  set_value(attr, value) { attr._attrValue = value; },
  get_ownerElement: (attr) => attr._ownerElement,
  get_specified: () => true
});
globalThis.Attr = Attr;

// DocumentType node (e.g. `<!DOCTYPE html>`) — a leaf node carrying name /
// publicId / systemId. Created via document.implementation.createDocumentType.
class DocumentType extends Node {
  constructor(token, name, publicId, systemId, ownerDoc) {
    constructedBy(PLATFORM, token, 'DocumentType');
    super(NODE_DOCTYPE);
    this._name     = String(name);
    this._publicId = String(publicId == null ? '' : publicId);
    this._systemId = String(systemId == null ? '' : systemId);
    this._ownerDoc = ownerDoc || null;
    registerNativeNode(this);
  }
  get _nodeName()      { return this._name; }
  get _textContent()   { return null; }
  set _textContent(_)  { /* spec: no-op for DocumentType */ }
  get _ownerDocument() { return this._ownerDoc || globalThis.document; }
  _cloneShell()       { return new DocumentType(PLATFORM, this._name, this._publicId, this._systemId, this._ownerDoc); }
}
// DocumentType's members: generated from its IDL onto the class (generated/bindings.js).
registerInterface('DocumentType', (o) => isNodeObject(o) && o._nodeType === NODE_DOCTYPE);
installDocumentType(DocumentType, {
  get_name(dt) { return dt._name; },
  get_publicId(dt) { return dt._publicId; },
  get_systemId(dt) { return dt._systemId; },
  before: childNodeBefore,
  after: childNodeAfter,
  replaceWith: childNodeReplaceWith,
  remove: childNodeRemove
});
globalThis.DocumentType = DocumentType;

// Per HTML spec, the `href` / `src` IDL attributes return the URL
// resolved against the document base — not the raw attribute value.
const SRC_REFLECTING_TAGS  = new Set(['audio', 'video', 'input']);
// Other USVString-URL reflecting attributes (resolve against the document base
// URL on get; see reflectURLAttr): video.poster, input/button.formAction.
const FORMACTION_REFLECTING_TAGS = new Set(['input', 'button']);
const POSTER_REFLECTING_TAGS   = new Set(['video']);
// First `<base href>` element. The parser's "in head" insertion mode lifts a
// `<base>` into `<head>`, so scan head's direct children — O(head children),
// document-size-independent (vs. a full-tree DFS on every URL-attribute read).
function firstBaseWithHref(doc) {
  const head = doc.head;
  if (!head || !head._children) return null;
  for (const c of head._children) {
    if (c._nodeType === NODE_ELEMENT && c._tag === 'base' && c._attrs.href != null) return c;
  }
  return null;
}
// A form's `action` / a submitter's `formaction` value as a URL — what those IDL attributes return, and what a
// submission navigates to: the form document's ADDRESS where it is absent or empty, else the value resolved against
// the document's BASE URL (they differ under a <base>), a special URL's query in the document's encoding
// ("encoding-parse-and-serialize a URL"); a value that does not parse is returned as it is. A submission asks this, not
// the IDL attribute: a control named `action` shadows that on its form (named property access), as a page may.
export function submissionURL(el, value) {
  const doc = el.ownerDocument;
  if (value == null || value === '') {
    return (doc && typeof doc.URL === 'string' && doc.URL) || (globalThis.location && globalThis.location.href) || '';
  }
  try {
    const u = globalThis.__csim_parseUrl(String(value), documentBaseURL(doc), doc && doc.characterSet);
    return u && !u.error ? u.href : String(value);
  } catch (_) { return String(value); }
}
// HTML "fallback base URL": the document's URL — but an about:blank / about:srcdoc
// document resolves relative URLs against its INHERITED base URL (the creator's,
// stored on the document at frame build via __csimSetAboutBaseURL), not the opaque
// "about:…" URL, which can't serve as a base. The cheap `about:` prefix gate keeps
// the hot path (every relative resolution) untouched for real-URL documents.
export function fallbackBaseURL(doc) {
  const url = (doc && typeof doc.URL === 'string' && doc.URL) ||
              (globalThis.location && globalThis.location.href) || 'about:blank';
  if (url.charCodeAt(0) === 97 /* 'a' */ && /^about:/i.test(url) && doc && doc.__aboutBaseURL) return doc.__aboutBaseURL;
  return url;
}
// HTML "document base URL": the frozen base URL of the first `<base href>`
// element, resolved against the document's fallback base URL; absent any such
// `<base>`, the fallback URL itself. Cached per document, keyed on the nodes
// generation — which inserting / removing a `<base>` or editing its href moves.
function documentBaseURL(doc) {
  const fallback = fallbackBaseURL(doc);
  if (!doc || !documentElementOf(doc)) return fallback;
  const gen = currentNodesGen();   // (…the parser's `<base>` included, which moves no settle generation)
  const cache = doc.__baseUrlCache;
  // Key on the fallback URL too: a navigation can swap the document URL without
  // the generation having advanced past the cached value (the live document is
  // reused across visits), and the resolved base depends on that fallback.
  if (cache && cache.gen === gen && cache.fallback === fallback) return cache.href;
  let href = fallback;
  const baseEl = firstBaseWithHref(doc);
  if (baseEl) {
    try {
      const u = globalThis.__csim_parseUrl(baseEl._attrs.href, fallback);
      if (u && !u.error && u.href) href = u.href;
    } catch (_) {}
  }
  doc.__baseUrlCache = { gen, fallback, href };
  return href;
}
// Position of `node` among its parent's `_children`. The sibling getters
// (next/previousSibling, next/previousElementSibling) need this; a bare
// `_children.indexOf(this)` is O(n) per hop, so a forward chain walk
// (`for (c = el.firstElementChild; c; c = c.nextElementSibling)`) is O(n²) and
// bites at scale — a 3000-sibling walk measured ~70× slower than an O(n) array
// pass. Memoised under `currentNodesGen()`, which moves on every structural
// mutation, the parser's included (the live HTMLCollection / NodeList caches key
// on it too), so a walk with no intervening mutation builds the index map
// ONCE (O(n)) then does O(1) lookups — O(n) total. Stored in a WeakMap SIDE
// TABLE, not a node field, so parents that get sibling-walked don't grow an
// extra slot that would diverge the otherwise-uniform element hidden class.
// Below the threshold a native `indexOf` beats building + allocating a Map, and
// the O(n²) is bounded (< SIB_INDEX_MIN²), so only large lists pay for the map.
// Every answer is also CHECKED against the list it indexes, and a map that does not hold is built again, whatever
// moved it: keyed on the settle generation alone, a map built mid-parse missed every child parsed after it, and a miss
// read as -1 sent `nextElementSibling` back to the FIRST child — the 33rd `<option>` of a whitespace-separated list
// led round to the first, and anything walking the siblings (a page's own loop) never came back.
const __sibIndexCache = new WeakMap();
const SIB_INDEX_MIN = 64;
// How many index maps have been built — a COUNT for the spec, where a wall would not show one map per parsed child.
let sibIndexBuilds = 0;
globalThis.__csimSibIndexBuilds = () => sibIndexBuilds;
// The LAST child is answered before the map: it is what the parser asks after every insertion (`bumpKids` reads the
// new node's siblings), and each insertion moves the generation — through the map, a 12,000-item list parsed in 1.7 s
// where it takes 76 ms.
function siblingIndexOf(parent, node) {
  const kids = parent._children;
  if (kids.length < SIB_INDEX_MIN) return kids.indexOf(node);
  if (kids[kids.length - 1] === node) return kids.length - 1;
  const gen = currentNodesGen();
  const e = __sibIndexCache.get(parent);
  if (e !== undefined && e.gen === gen) {
    const i = e.idx.get(node);
    if (i !== undefined && kids[i] === node) return i;
  }
  const idx = new Map();
  for (let i = 0; i < kids.length; i++) idx.set(kids[i], i);
  __sibIndexCache.set(parent, { gen, idx });
  sibIndexBuilds++;
  const i = idx.get(node);
  return i === undefined ? -1 : i;
}
// A URL attribute's value parsed against the node document's base URL and serialized ("encoding-parse-and-serialize a
// URL": a special URL's query in the document's encoding), or null where it parses to no URL — what a generated
// [ReflectURL] attribute resolves its value by (reflect.js), and the hand-written ones below.
export function resolveURLValue(el, value) {
  try {
    const doc = el.ownerDocument;
    const u = globalThis.__csim_parseUrl(value, documentBaseURL(doc), doc && doc.characterSet);
    return u && !u.error ? u.href : null;
  } catch (_) { return null; }
}
setURLResolver(resolveURLValue);
function reflectURLAttr(el, name, tagSet) {
  if (!tagSet.has(el._tag)) return el._attrs[name];
  const v = el._attrs[name];
  return v == null ? '' : (resolveURLValue(el, v) ?? v);
}

// A text-entry control (textarea, contenteditable, or a text-like <input>) —
// real browsers always render `:focus-visible` on these regardless of whether
// focus arrived by pointer or keyboard. Used by the focus() :focus-visible latch.
const __NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden']);
function __isTextEntryFocusTarget(el) {
  if (!el || el._nodeType !== NODE_ELEMENT) return false;
  if (el._tag === 'textarea') return true;
  if (isContenteditable(el)) return true;   // canonical CE check (honours true/plaintext-only, ancestors)
  if (el._tag === 'input') return isTextLikeInputType(el);
  return false;
}
// Does this `<input>` hold TEXT the user can type into and scroll? (Shared with the scroll-offset
// gate, which asks the same question of the same list.)
function isTextLikeInputType(el) {
  return !__NON_TEXT_INPUT_TYPES.has((el._attrs.type || 'text').toLowerCase());
}
// HTML focusing steps: the focused area belongs to a BROWSING CONTEXT, and focusing an
// `<iframe>` hands focus to its NESTED context rather than keeping it on the container
// element — once that context exists; a frame whose realm hasn't been built has none to
// hand focus to, so the container's own context stays focused. Report the result to the
// host, which owns the cross-realm answer to "which context has focus" — a service
// worker's `WindowClient.focused` reads it, and a worker isolate can't ask the browser
// itself. The host no-ops a report of the context it already holds, so only a real focus
// MOVE costs anything beyond the crossing.
// `el` is the element gaining focus, or null to focus THIS realm's own context (an
// `<iframe>` losing focus hands it back to the document that contains the frame).
function noteFocusChain(el) {
  const note = globalThis.__csimNoteFocusedRealm;
  if (typeof note !== 'function') return;
  const rid = (el && el._frameRealmId != null) ? el._frameRealmId : globalThis.__csimRealmId();
  try { note(rid); } catch (_) {}
}

// HTML "focusable area" (focus.rs `focusable`): what `focus()` takes focus to (a `<span>` with no tabindex does not,
// whatever a library calls focus on), what the click resolver retargets to, and what sequential navigation stops at.
export function isFocusable(n) {
  return !!n && n._nodeType === NODE_ELEMENT && styleEngineFocusable(n);
}

// The "focus delegate" of a shadow host with delegatesFocus, per HTML
// "get the focus delegate": the AUTOFOCUS delegate — the first focusable shadow-
// tree descendant carrying the `autofocus` attribute, in tree (pre)order — if any,
// else the first focusable descendant. (focus-autofocus.html)
//
// Both passes walk the SHADOW TREE only: slotted light-DOM content is NOT a
// shadow-tree node, so it's naturally excluded — a `<slot>`'s own subtree (its
// fallback content) is walked, but nodes assigned INTO it are not (they live in
// the host's light children). tabindex priority is irrelevant: it's the first
// match in preorder (`isFocusable` counts tabindex=-1 + inherently-focusable and
// excludes a no-tabindex div). A nested shadow host that itself delegatesFocus is
// recursed into ITS OWN shadow tree (not its light children); in the fallback pass
// its already-focused descendant wins. A nested host that does NOT delegate is
// descended as an ordinary element — its node-tree children are walked, but its
// SHADOW content stays unreachable via delegation.
function firstFocusDelegate(root) {
  return focusDelegateScan(root, true) || focusDelegateScan(root, false);
}
function focusDelegateScan(root, autofocusOnly) {
  const kids = root && root._children;
  if (!kids) return null;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n._nodeType !== NODE_ELEMENT) continue;
    if ((!autofocusOnly || n._attrs.autofocus != null) && isFocusable(n)) return n;
    if (n._shadowRoot && n._shadowRoot._delegatesFocus) {
      const nested = autofocusOnly
        ? focusDelegateScan(n._shadowRoot, true)
        : (n._shadowRoot.activeElement || focusDelegateScan(n._shadowRoot, false));
      if (nested) return nested;
      continue;
    }
    const d = focusDelegateScan(n, autofocusOnly);
    if (d) return d;
  }
  return null;
}

// Neuter a frame realm's timer / async entry points just BEFORE its V8 context is
// disposed, so a reference still held to its Window (an `iframe.contentWindow`
// captured before the iframe was removed or navigated) stays SAFE to call. A detached
// Window's `setTimeout`/`setInterval` must return an inert id and never fire, and
// `clearTimeout`/etc. must no-op — NOT throw. The realm's own timer fns route through
// host calls that die with the context ("unknown host function"), so replace them with
// plain stubs created in THIS realm, which outlive the child's disposal.
// (html/webappapis/timers/settimeout-detached-iframe.html)
// Scoped to the timer/async surface + the DOM removal / src-nav teardown paths — a
// detached window's OTHER host-backed methods (fetch / postMessage / addEventListener)
// still throw on a retained handle, and Ruby-only disposal paths (cross-realm reload,
// within_frame pop) don't run this; neither is exercised by a test today (residual).
globalThis.__csimNeuterDetachedWindow = function (realmId, discarded) {
  if (realmId == null) return;
  let win;
  try { win = globalThis.RustyRacer.contextGlobal(realmId); } catch (_) { return; }
  if (!win) return;
  try {
    // (…its browsing context gone with it, where the frame was: `closed`. A frame navigated keeps its browsing context,
    // which its old window still reads — Chrome's WindowProxy goes on to the new one.)
    if (discarded) win.__csimBrowsingContextDiscarded = true;
    win.setTimeout   = win.setInterval  = function () { return 0; };
    win.clearTimeout = win.clearInterval = function () {};
    // (…and the platform's own tasks queued on it — a message to one of its ports, from a realm still live)
    win.__csimSetTimeout = function () { return 0; };
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame = function () { return 0; };
    if (typeof win.cancelAnimationFrame  === 'function') win.cancelAnimationFrame  = function () {};
    if (typeof win.queueMicrotask        === 'function') win.queueMicrotask        = function () {};
    // A disconnected / discarded browsing context is no longer a service-worker client, so a
    // reference retained to its `navigator.serviceWorker` (captured before removal) must report
    // `controller === null` (controller-on-disconnect). Runs while the realm is still alive, just
    // before disposal.
    if (typeof win.__csim_swClientDiscarded === 'function') win.__csim_swClientDiscarded();
  } catch (_) {}
};

// Tear down a frame realm being navigated away (src/srcdoc reassigned OR removed).
// Fires `beforeunload` on the OLD document FIRST — in its own realm, before
// disposal (HTML "prompt to unload"); __csimFireBeforeUnload self-gates on a
// handler being present, so the common handler-less src swap pays nothing beyond
// the realm lookup. Then drops the realm from the child-realm step set + disposes.
//
// Navigating a browsing context DISCARDS its descendant browsing contexts (HTML
// "navigate" → unload + discard of the document's nested contexts), so we
// recursively dispose the old realm's nested frame realms. Without this a
// reference held to a now-detached child frame (e.g. `iframe.contentWindow`
// after the iframe's containing document navigated away) would resolve to a
// stale live window instead of null — and the child isolates would leak per
// navigation. The child-id set is empty for the common leaf iframe, so a
// frame with no nested frames pays only the empty-Set check.
function disposeFrameRealmForNav(oldRealmId, discarded = false) {
  if (oldRealmId == null) return;
  try {
    const oldWin = globalThis.RustyRacer.contextGlobal(oldRealmId);
    if (oldWin && typeof oldWin.__csimFireBeforeUnload === 'function') oldWin.__csimFireBeforeUnload();
    // Then the teardown pair (HTML "unload a document"): pagehide + unload, in
    // the dying realm, BEFORE its window is neutered — a keepalive fetch issued
    // from these handlers must still reach a working host boundary.
    if (oldWin && typeof oldWin.__csimFireWindowUnload === 'function') oldWin.__csimFireWindowUnload();
    // …and its connections made to disappear (HTML "unloading document cleanup steps"): the host would otherwise go on
    // delivering into a realm being disposed, and the top window's maps would keep it alive.
    if (oldWin && typeof oldWin.__csimDropWebSockets === 'function') oldWin.__csimDropWebSockets();
    if (oldWin && typeof oldWin.__csimDropEventSources === 'function') oldWin.__csimDropEventSources();
    const kids = oldWin && oldWin.__csimChildRealmIds;
    if (kids && typeof kids.forEach === 'function') {
      // Snapshot before recursing (each child dispose mutates its own set).
      Array.from(kids).forEach((kid) => disposeFrameRealmForNav(kid, true));
    }
  } catch (_) {}
  if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(oldRealmId);
  // Drop this realm's cached WindowProxy for the disposed frame so it doesn't pin
  // the dead global / get handed back stale (memory hygiene across iframe churn).
  if (globalThis.__csimEvictWindowProxy) { try { globalThis.__csimEvictWindowProxy(oldRealmId); } catch (_) {} }
  __csimNeuterDetachedWindow(oldRealmId, discarded);   // a retained contentWindow stays inert, not throwing
  if (globalThis.__csim_disposeFrameRealm) {
    try { globalThis.__csim_disposeFrameRealm(oldRealmId); } catch (_) {}
  }
}

// A navigation initiated INSIDE a nested browsing context (a frame realm, whose
// `top` differs from its own global) must act on THAT frame — and the per-realm
// pending slot a top-page drain reads is never consulted for a child realm. So
// route self-targeted link navigations and form submits through realm-tagged
// host calls (the same deferred channel `location.href` uses in location.js):
// the host applies them against the initiating realm after the JS call returns.
function inNestedBrowsingContext() {
  return !!(globalThis.__csimTop && globalThis.__csimTop !== globalThis);
}
function routeChildRealmLinkNav(anchor, target) {
  const t = (target || '').toLowerCase();
  // A `_blank` / named-window target from a nested or window realm opens a NEW
  // auxiliary window (not a navigation of this context). Route through the host so
  // the frame's VM isn't rebuilt — a fresh window is. `_top`/`_parent` fall through
  // to the existing top/parent navigation handling.
  if (t && t !== '_self' && t !== '_top' && t !== '_parent') {
    if ((inNestedBrowsingContext() || globalThis.__csimIsWindowRealm) &&
        typeof globalThis.__csimOpenAuxFromRealm === 'function') {
      const opener = anchorHasRelOpener(anchor);   // target=_blank is noopener unless rel=opener
      let abs = String(hrefAttr(anchor));
      try { abs = new globalThis.URL(abs, anchor.baseURI).href; } catch (_) {}
      // Snapshot a blob this realm OWNS before a deferred revoke (a cross-partition
      // blob lives in another isolate → no snapshot; the host resolves it cross-VM).
      let blob = null;
      if (/^blob:/i.test(abs) && typeof globalThis.__csimReadBlobForWindow === 'function') {
        const snap = globalThis.__csimReadBlobForWindow(abs);
        if (snap) blob = snap;
      }
      globalThis.__csimOpenAuxFromRealm(abs, opener, blob);
      return true;
    }
    return false;
  }
  if (!(t === '' || t === '_self')) return false;   // _top/_parent from a frame: not routed (no in-scope need)
  // A same-origin WINDOW realm is its own top, so inNestedBrowsingContext() is false
  // and the fall-through would run the top-page path against the OPENER's Browser —
  // navigating the opener, not the popup. Route a self link through the same window-
  // realm channel location.href uses (__csimWindowRealmNavigate). Mirrors the
  // window-realm branch in location.js's dispatchNav.
  if (globalThis.__csimIsWindowRealm && typeof globalThis.__csimWindowRealmNavigate === 'function') {
    let abs = String(hrefAttr(anchor));
    try { abs = new globalThis.URL(abs, anchor.baseURI).href; } catch (_) {}
    globalThis.__csimWindowRealmNavigate(abs, globalThis.RustyRacer.contextOf(globalThis), false);
    return true;
  }
  if (!inNestedBrowsingContext() || typeof globalThis.__csimFrameNavigate !== 'function') return false;
  let abs = String(hrefAttr(anchor));
  // Resolve against the anchor's document base (honoring a light-tree <base
  // href>), matching the top-page link path (resolve_against_current use_base:
  // true) — the host re-navigates by reassigning src and does NOT re-resolve.
  try { abs = new globalThis.URL(abs, anchor.baseURI).href; } catch (_) {}
  globalThis.__csimFrameNavigate(abs, globalThis.RustyRacer.contextOf(globalThis), false);
  return true;
}
export function routeChildRealmFormSubmit() {
  if (!inNestedBrowsingContext() || typeof globalThis.__csimFrameSubmit !== 'function') return;
  globalThis.__csimFrameSubmit(globalThis.RustyRacer.contextOf(globalThis));
}

// Does this `<a>`/`<area>` keep its opener when opening a new window? A
// `target=_blank`/named link is noopener by default; `rel=opener` keeps it, but
// `rel=noopener` always wins (severs it). Shared by every click-activation path
// (Element.click / public dispatchEvent / the UA click resolver) so they agree.
export function anchorHasRelOpener(anchor) {
  const rel = String(anchor._attrs.rel || '').toLowerCase().split(/\s+/);
  return rel.indexOf('opener') !== -1 && rel.indexOf('noopener') === -1;
}

// The hyperlink-activation navigation behaviour, shared by every click path that
// follows an `<a>`/`<area>`: the IDL `Element.click()` (above) and the PUBLIC
// `el.dispatchEvent(new MouseEvent('click'))` path (dispatch.js). A same-document
// fragment hops in JS; a `_blank`/named target from a frame/window realm opens a
// new aux window via the host (routeChildRealmLinkNav); anything else queues the
// pending-navigation intent the Ruby user-action drain consumes. `opener` reflects
// rel=opener (a bare `target=_blank` is noopener); the Ruby side forces noopener
// for a cross-partition blob: target. The caller has already confirmed a non-empty,
// non-`javascript:` href on a non-editable anchor.
// (…`tgt` the browsing context it opens in: its own `target`, or a new window's where the user asked for one)
export function anchorActivateNavigate(anchor, tgt = anchor._attrs.target || '') {
  if (fragmentNavigate(anchor)) return;
  if (routeChildRealmLinkNav(anchor, tgt)) return;
  const pn = { url: String(hrefAttr(anchor)), target: tgt, opener: anchorHasRelOpener(anchor) };
  // A blob: link opening a NEW window takes its blob reference NOW (the navigation
  // is deferred and the page may revoke the URL first) — snapshot the bytes so the
  // aux window still loads after revoke. (A cross-partition blob lives in another
  // isolate → no local snapshot; the host resolves it cross-VM.)
  if (/^blob:/i.test(pn.url) && tgt &&
      ['_self', '_top', '_parent', ''].indexOf(tgt.toLowerCase()) === -1 &&
      typeof globalThis.__csimReadBlobForWindow === 'function') {
    const snap = globalThis.__csimReadBlobForWindow(pn.url);
    if (snap) pn.blob = snap;
  }
  globalThis.__csimPendingNavigation = pn;
}
// Exposed so dispatch.js (no import — avoids a cycle) can run hyperlink activation
// for the public `el.dispatchEvent(clickEvent)` path.
globalThis.__csimAnchorActivateNav = anchorActivateNavigate;

// HTML <summary>'s activation behaviour: the summary for its parent details — that details' first summary child —
// opens or closes it (toggleDetails); any other summary does nothing.
export function activateSummary(summary) {
  if (!isSummaryForItsDetails(summary)) return false;
  toggleDetails(summary._parent);
  return true;
}
// A details element's name group (HTML §4.11.1): the other details elements in its tree with the same non-empty
// `name` — none for one without.
function detailsNameGroup(details) {
  const name = details._attrs.name;
  if (!name) return [];
  return collectByTagNameNS(details._getRootNode(), HTML_NS, 'details').filter((d) => d !== details && d._attrs.name === name);
}
// "Ensure details exclusivity by closing other elements if needed": an open details element's group closed, each one.
function closeOtherDetailsIfNeeded(details) {
  for (const other of detailsNameGroup(details)) if (other._attrs.open != null) other._removeAttribute('open');
}
// …"by closing the given element if needed": an open details element closed where one of its group is open — its
// insertion steps and its `name` attribute's change steps.
function closeDetailsIfNeeded(details) {
  if (details._attrs.open != null && detailsNameGroup(details).some((d) => d._attrs.open != null)) details._removeAttribute('open');
}
// Whether a details element has ever had a `name` — none has a name group before, so an insertion looks for none.
let namedDetailsSeen = false;
const isDetails = (el) => el._tag === 'details' && el._ns === HTML_NS;
const isDialog = (el) => el._tag === 'dialog' && el._ns === HTML_NS;
// A parser's insertion steps for a node it inserts — before the nodes after it are there, so of the open details
// elements of a name group the first in tree order stays open.
function parserInsertionSteps(node) {
  if (isDetails(node) && node._attrs.open != null) closeDetailsIfNeeded(node);
}
// The details elements' insertion steps, for inserted nodes: each in tree order closed where its group has one open.
function detailsExclusivityOnInsert(nodes) {
  if (!namedDetailsSeen) return;
  for (const node of nodes) {
    if (node._nodeType !== NODE_ELEMENT) continue;
    if (isDetails(node)) closeDetailsIfNeeded(node);
    for (const details of collectByTagNameNS(node, HTML_NS, 'details')) closeDetailsIfNeeded(details);
  }
}
// A details element opened or closed: its `open` attribute, whose change queues its `toggle`.
export function toggleDetails(details) {
  if (details._attrs.open != null) details._removeAttribute('open');
  else details._setAttribute('open', '');
}
// The attribute change steps an attribute APPENDED to a new element runs where no setter's handleAttributeChanges did —
// the parser's and a clone's: a details element's `open` queues its toggle, closed → open (Chrome fires it for a parsed
// `<details open>` and an open one's clone), and its `name` gives it a name group.
function appendedAttributeSteps(el, name) {
  if (name === 'open' && isDialog(el)) dialogOpened(el);
  if (!isDetails(el)) return;
  if (name === 'open') queueToggleTask(el, 'closed', 'open');
  else if (name === 'name') namedDetailsSeen = true;
}

// Single entry point shared by every form-submission trigger — form.submit() /
// requestSubmit() / submit-button click activation / Enter + set("…\n") implicit
// submission. A submission whose `target` names a same-document frame is a
// navigation contained to that child browsing context, so it runs JS-side
// (fetch + load into the frame) and never becomes a top-page navigation; any
// other submission is queued as the pending intent the Ruby user-action drain
// consumes (and routed to a parent realm when we're in a nested context).
// Returns true iff it took the named-frame path. Centralising this keeps the
// named-frame check from being silently dropped at one of the triggers (it was,
// on the click + implicit-submit paths — they navigated the top frame instead of
// the target iframe).
//
// `entryList` is the already-constructed entry list (the FormData built by
// `__runFormSubmit`'s "construct the entry list" step, post-`formdata`). When
// present, the named-frame path submits THAT list rather than re-walking the form
// — so `formdata` fires exactly once and a handler's append/delete is honoured.
// Triggers that don't construct one (the Enter implicit-submit paths) pass nothing
// and the named-frame path falls back to serialising the form itself.
export function recordFormSubmission(form, submitter, entryList, fromSubmitMethod) {
  if (globalThis.__csimSubmitFormToNamedFrame && globalThis.__csimSubmitFormToNamedFrame(form, submitter || null, entryList, fromSubmitMethod)) return true;
  globalThis.__csimPendingFormSubmit = { form, submitter: submitter || null, entryList: entryList || null };
  routeChildRealmFormSubmit();
  return false;
}

// Drive a scripted cross-document navigation of a frame ELEMENT to an already-
// fetched response document (a form submit targeting a named frame): dispose the
// old realm, stash the response — its bytes, decoded as the frame's document loads —
// as the frame's pending nav content, and trigger the eager build + element `load` —
// all within the JS event loop.
function navigateFrameElementToContent(frameEl, url, bytes, contentType) {
  if (!frameEl || (frameEl._tag !== 'iframe' && frameEl._tag !== 'frame')) return;
  const oldRealmId = frameEl._frameRealmId;
  frameEl._frameWindow    = null;
  frameEl._frameRealmId   = null;
  frameEl._frameLoadFired = false;
  frameEl._frameNavPending = false;   // this nav is what fires the load now
  frameEl._frameNavContent = { url: url || '', bytes, contentType: contentType || 'text/html' };
  disposeFrameRealmForNav(oldRealmId);
  if (isConnected(frameEl) && globalThis.__csim_onFrameSrcAssigned) globalThis.__csim_onFrameSrcAssigned(frameEl);
}

// A form submission whose `target` names a frame in the CURRENT document is a
// navigation contained to that child browsing context, so we perform it JS-side
// (within the event loop) rather than routing through the Ruby top-page path.
// Returns true if handled (caller then skips the pending-submit fallback), false
// to fall through (no such named frame, or a non-frame target like _blank/_top).
globalThis.__csimSubmitFormToNamedFrame = function (form, submitter, entryList, fromSubmitMethod) {
  if (!form || form._tag !== 'form') return false;
  // CHEAP target pre-check FIRST (rule 3): only a named, same-document frame target is
  // handled here; ordinary top/self submits bail immediately, without the action-URL
  // parse or the O(N) entry-list walk this path would otherwise run.
  const rawTarget = (submitter && submitter._attrs && submitter._attrs.formtarget != null)
    ? submitter._attrs.formtarget
    : (form._attrs.target != null ? form._attrs.target : '');
  const target = String(rawTarget || '');
  if (!target || ['_self', '_top', '_parent', '_blank'].indexOf(target.toLowerCase()) !== -1) return false;
  const doc = globalThis.document;
  if (!doc || typeof doc.getElementsByName !== 'function') return false;
  let frameEl = null;
  const named = doc.getElementsByName(target);
  for (let i = 0; i < named.length; i++) {
    if (named[i] && (named[i]._tag === 'iframe' || named[i]._tag === 'frame')) { frameEl = named[i]; break; }
  }
  if (!frameEl) return false;   // not a same-document named frame → let the normal path handle it
  let spec;
  // Pass the form/submitter OBJECTS, not their handles: a submission triggered
  // during parse (an inline script's `button.click()`) runs before the element's
  // handle is registered in the lookup table, so a handle argument here
  // would miss and return null — bailing the named-frame path into a top-page
  // navigation that destroys the document. The object overload is registry-free
  // (same reason the cross-realm `new FormData(iframeForm)` path uses it).
  try { spec = globalThis.__csimFormSubmissionSpec(form, submitter || 0); } catch (_) { return false; }
  if (!spec) return false;
  const method = String(spec.method || 'get').toUpperCase();
  const base = (globalThis.location && globalThis.location.href) || 'http://localhost/';
  let actionUrl;
  try { actionUrl = new globalThis.URL(spec.action || '', base).href; } catch (_) { actionUrl = String(spec.action || base); }
  // HTML "plan to navigate" — a navigable has at most one pending navigation, a new
  // one replaces it (last wins). Tracked PER TARGET FRAME (frameEl._plannedNav): a
  // new submission of the SAME frame supersedes its pending one. An INTERACTIVE
  // submit (a submit button's default action / Enter implicit submit — NOT the
  // `form.submit()` method) ALSO supersedes the form's most recent planned navigation
  // even on a DIFFERENT frame: the button's default submit to frame2 cancels an
  // onclick `form.submit()` to frame1 (form-double-submit.html). The `form.submit()`
  // method does not, so one form targeting several frames in succession navigates all
  // of them (form-double-submit-multiple-targets). Superseding marks the prior plan
  // cancelled; the prior fetch's continuation then skips.
  const samePrev = frameEl._plannedNav;
  if (samePrev) samePrev.cancelled = true;
  if (!fromSubmitMethod && form._lastNavPlan && !form._lastNavPlan.cancelled) {
    form._lastNavPlan.cancelled = true;
    const pf = form._lastNavPlan.frameEl;
    if (pf && pf._plannedNav === form._lastNavPlan) { pf._plannedNav = null; pf._frameNavPending = false; }
  }
  const plan = { cancelled: false, frameEl, form };
  frameEl._plannedNav = plan;
  form._lastNavPlan = plan;
  const land = (url, bytes, contentType) => {
    if (plan.cancelled) return;            // superseded by a later navigation of this frame / form
    if (frameEl._plannedNav === plan) frameEl._plannedNav = null;
    if (form._lastNavPlan === plan) form._lastNavPlan = null;
    navigateFrameElementToContent(frameEl, url, bytes, contentType);
  };
  // GET and POST both fetch JS-side and load the response into the frame (a
  // unified content-load path, so the initial about:blank load is suppressed
  // exactly once and the nav load fires exactly once). The fetch + body build run
  // inside try/catch: a SYNCHRONOUS throw (e.g. serializeRequestBody) must still
  // clear `_frameNavPending` and fire a load, or the frame would hang forever.
  frameEl._frameNavPending = true;
  try {
    // The entry list to encode: the caller's already-built one when it constructed one
    // (so a `formdata` handler's append/delete is honoured), else construct it now —
    // `submissionFormData` IS HTML's "construct the entry list", `formdata` event
    // included, so the event fires exactly once per submission whatever the enctype.
    // Inside the try — a throw here (a re-entrant submit raises InvalidStateError)
    // must still clear `_frameNavPending` and fire load, or the frame hangs forever.
    const listFd  = entryList || submissionFormData(form, submitter);
    const entries = formDataEntries(listFd).slice();
    // The form's submission character encoding (accept-charset → document → UTF-8).
    // In a legacy one the name/value/filename bytes differ from UTF-8 (unrepresentable
    // code points → `&#N;`), so the query or body is built as RAW BYTES; UTF-8 keeps
    // the FormData / URLSearchParams / string route.
    const encoding = spec.encoding;
    let promise;
    if (method === 'GET') {
      // HTML "mutate action URL": a GET submission SETS the action URL's query to the
      // serialized entry list — always, so the `?` is present even when the list is
      // empty (`action` → `action?`) — and keeps its fragment.
      const qs = encoding === 'UTF-8'
        ? entryListParams(entries).toString()
        : legacyEncodedSubmissionBody('application/x-www-form-urlencoded', entries, encoding).bytes;
      const hashAt = actionUrl.indexOf('#');
      const fragment = hashAt < 0 ? '' : actionUrl.slice(hashAt);
      actionUrl = actionUrl.slice(0, hashAt < 0 ? actionUrl.length : hashAt).split('?')[0] + '?' + qs + fragment;
      // A form submission is a NAVIGATION, not a CORS fetch — mode 'navigate' so a
      // cross-origin form target isn't CORS-blocked (submit-file posts to www1.*). The
      // public fetch/Request API forbids constructing a navigate request (request-error),
      // but the navigation model needs that mode here: fetch.js `navigationFetch`.
      promise = navigationFetch(actionUrl, 'GET', undefined, null);
    } else {
      const enctype = String(spec.enctype || '').toLowerCase();
      // Encode the entry list by enctype (HTML "encode the entry list"): multipart wants
      // the FormData itself (File bytes + part escaping); text/plain is `name=value\r\n`
      // per entry; everything else is urlencoded. A body of raw bytes carries its
      // Content-Type as a header, verbatim — a Blob's `type` would lowercase a multipart
      // boundary out of step with the body's — and so do text/plain and urlencoded, whose
      // types HTML gives no charset (a string or URLSearchParams body would get `;charset=UTF-8`).
      let reqBody, contentType = null;
      if (encoding !== 'UTF-8') {
        const encoded = legacyEncodedSubmissionBody(enctype, entries, encoding);
        reqBody     = latin1ToBytes(encoded.bytes);
        contentType = encoded.contentType;
      } else if (enctype.indexOf('multipart/form-data') === 0) {
        reqBody = listFd;
      } else if (enctype === 'text/plain') {
        reqBody     = entryListTextPlain(entries);
        contentType = 'text/plain';
      } else {
        reqBody     = entryListParams(entries);
        contentType = 'application/x-www-form-urlencoded';
      }
      const headers = contentType ? { 'Content-Type': contentType } : undefined;
      promise = navigationFetch(actionUrl, 'POST', headers, reqBody);
    }
    promise
      .then((resp) => responseBytes(resp).then((bytes) => {
        const s = responseOf(resp);
        land(s.url || actionUrl, bytes, getHeader(s.headers, 'content-type') || 'text/html');
      }))
      .catch(() => land(actionUrl, new Uint8Array(0), 'text/html'));
  } catch (_) {
    land(actionUrl, new Uint8Array(0), 'text/html');
  }
  return true;
};

// The form's entry list as URLSearchParams (file inputs contribute filename only,
// matching urlencoded/GET submission).
// The form-submission ENCODERS normalize CR/LF → CRLF in each entry's name + value (and a
// file entry's filename, used as the value). The entry list / FormData itself stays raw —
// HTML's "constructing the entry list" does NOT normalize (newline-normalization.html /
// constructing-form-data-set.html), so normalization lives here, at the encoder, matching
// real browsers. `\r\n?|\n` matches CRLF / lone CR / lone LF, all → CRLF.
function normalizeNL(s) { return String(s).replace(/\r\n?|\n/g, '\r\n'); }
function entryFileName(file) { return normalizeNL(fileName(file)); }

// An entry list as URLSearchParams: each File value contributes its filename only,
// matching urlencoded/GET submission.
function entryListParams(entryList) {
  const params = new globalThis.URLSearchParams();
  for (const [name, value] of entryList) {
    params.append(normalizeNL(name), isFile(value) ? entryFileName(value) : normalizeNL(value));
  }
  return params;
}

// HTML "text/plain encoding algorithm": each entry as `name=value\r\n` (no percent
// -encoding), a file entry contributing its filename. Returned as a plain string so
// `fetch` posts it with Content-Type text/plain (text-plain.window.js).
function plainEntry(name, value) { return normalizeNL(name) + '=' + normalizeNL(value) + '\r\n'; }
function entryListTextPlain(entryList) {
  let out = '';
  for (const [name, value] of entryList) {
    out += plainEntry(name, isFile(value) ? entryFileName(value) : value);
  }
  return out;
}

// application/x-www-form-urlencoded byte serializer: a space → '+', the
// unreserved bytes (A–Z a–z 0–9 * - . _) verbatim, everything else %XX. Input is
// a byte string (each char code is one byte), so it composes with the charset
// encoders (UTF-8 or legacy).
function urlencodeBytes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i) & 0xFF;
    if (b === 0x20) out += '+';
    else if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) ||
             b === 0x2A || b === 0x2D || b === 0x2E || b === 0x5F) out += String.fromCharCode(b);
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// Encode a form submission into RAW BYTES for a NON-UTF-8 (legacy) output
// encoding — the branch HTML's "encode" takes when accept-charset selects e.g.
// windows-1252 or Shift_JIS: each name / value / filename is `legacyFormEncode`d (a code
// point the encoding can't represent becomes `&#N;`). The UTF-8 path is handled
// by the normal FormData / URLSearchParams / string body route, untouched.
// Returns `{ bytes, contentType }` with `bytes` a latin-1 byte string.
function legacyEncodedSubmissionBody(enctype, entries, encName) {
  const enc = (s) => legacyFormEncode(s, encName);
  if (enctype.indexOf('multipart/form-data') === 0) {
    const { body, boundary } = serializeMultipart(entries, enc);
    return { bytes: body, contentType: 'multipart/form-data; boundary=' + boundary };
  }
  const entryName = (v) => normalizeNL(isFile(v) ? entryFileName(v) : v);
  if (enctype === 'text/plain') {
    let out = '';
    for (const [name, value] of entries) out += enc(normalizeNL(name)) + '=' + enc(entryName(value)) + '\r\n';
    return { bytes: out, contentType: 'text/plain' };
  }
  const parts = [];
  for (const [name, value] of entries) parts.push(urlencodeBytes(enc(normalizeNL(name))) + '=' + urlencodeBytes(enc(entryName(value))));
  return { bytes: parts.join('&'), contentType: 'application/x-www-form-urlencoded' };
}

// The shared `@@iterator` factory for `<select>` (HTMLSelectElement values
// iterator). A stable function so `select[Symbol.iterator]` keeps identity;
// `this` is the select. Delegates to the options collection's iterator
// (HTMLOptionsCollection inherits HTMLCollection's `Symbol.iterator`, which
// walks the live collection). The only consumer — the `sequence<BlobPart>`
// conversion in `new Blob(select)` — copies eagerly, so liveness is moot.
function selectValuesIterator() {
  return (this.options || [])[Symbol.iterator]();
}

// ── Enumerated-attribute reflection ("limited to only known values") ──────────
// WHATWG: a reflected DOMString whose content attribute is an enumerated
// attribute limited to known values does ALL its canonicalization on GET — the
// SETTER just stores `ToString(value)` verbatim (see html/dom/reflection.js: the
// IDL-set test asserts `getAttribute() === String(value)`). On GET: an absent
// attribute → the missing-value default; a present value that ASCII
// case-insensitively matches a keyword (or a non-canonical synonym) → that
// keyword's canonical form; anything else → the invalid-value default. The map
// is built once per attribute (lowercased input → canonical keyword).
// Enumerated-attribute keyword matching is ASCII case-insensitive (NOT Unicode
// toLowerCase, which folds U+212A KELVIN → 'k' and U+017F ſ → 's' — the
// reflection tests probe exactly those, expecting "checʞbox"/"worʞer" to MISS).
function buildEnumMap(keywords, nonCanon) {
  const m = new Map();
  for (const k of keywords) m.set(asciiLower(k), k);
  if (nonCanon) for (const nc in nonCanon) m.set(asciiLower(nc), nonCanon[nc]);
  return m;
}
function enumReflectGet(raw, map, missingDefault, invalidDefault) {
  if (raw == null) return missingDefault;
  const c = map.get(asciiLower(String(raw)));
  return c !== undefined ? c : invalidDefault;
}
// Keyword tables (verbatim from html/dom/elements-*.js + reflection.js). Each
// here has missing-value default = invalid-value default = '' (no explicit
// defaultVal/invalidVal in the spec data).
const ENUM_DIR = buildEnumMap(['ltr', 'rtl', 'auto']);
const ENUM_ENTER_KEY_HINT = buildEnumMap(['enter', 'done', 'go', 'next', 'previous', 'search', 'send']);
const ENUM_INPUT_MODE = buildEnumMap(['none', 'text', 'tel', 'url', 'email', 'numeric', 'decimal', 'search']);
// (…and these two, whose readers name their defaults: `popover`'s and `contenteditable`'s, '' a keyword of each)
const ENUM_POPOVER = buildEnumMap(['auto', 'manual', 'hint'], { '': 'auto' });
const ENUM_CONTENT_EDITABLE = buildEnumMap(['true', 'false', 'plaintext-only'], { '': 'true' });
// HTML "textFieldSelection": the selection APIs (selectionStart/End/Direction,
// setSelectionRange, setRangeText, select) apply to <textarea> and to <input>
// whose COMPUTED type is one of these. For any other input type the getters
// return null and the setters / methods throw InvalidStateError.
const SELECTION_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'password']);
// `select()` (select-all) applies more broadly than the fine-grained selection
// APIs: it works on <input type=email> too (its selectionStart stays null, but the
// selection is observable via window.getSelection()), matching Chrome.
const SELECT_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'password', 'email']);
// Input types the `readonly` attribute applies to (text-ish + numeric/temporal).

// DOM "handle attribute changes": what EVERY path that sets or removes an attribute does once the store holds the new
// value — `setAttribute`, `setAttributeNS`, a dataset write, `Attr.value`, `setAttributeNode`, and each removal. The
// mutation record is queued, the attributeChanged reaction enqueued (whenever a value is SET, even to the one it
// held: `classList.remove(<absent>)` still calls back — custom-elements/reactions/DOMTokenList), and then the
// element's own attribute change steps run. One place, because each path had kept its own subset of the steps: a
// `type` set through `setAttributeNS` or an `Attr` never migrated the value (Chrome does).
// `next` is null for a removal, and `removedMeta` the removed attribute's namespace record (the store has lost it).
//
// The reaction RUNS when the API call that caused it returns ([CEReactions]), after every step — a callback sees the
// handler installed, the selectedness set, the value migrated — and runs even when a step throws. A write a step makes
// ITSELF (the type change's `value`, through `stepSetAttribute`) is no API call of its own: its reaction joins the
// queue of the change whose steps are running, behind the one that caused it (Chrome: type, then value, both seeing the
// migrated value). Any other write is an API call and runs its own on return — one from a callback, and one from page
// code a step calls into (a form-associated callback, a `blur` listener).
let runningReactionQueue = null;   // the queue of the change whose steps are running
let stepWrite = false;             // …and whether the write now arriving is one of those steps' own
function handleAttributeChanges(el, key, old, next, pre, removedMeta = undefined) {
  recordAttrMutation(el, key, old == null ? null : old, removedMeta);
  const meta = removedMeta === undefined ? (el._attrNS && el._attrNS[key]) || null : removedMeta;
  const own = !stepWrite;
  stepWrite = false;
  const queue = own ? [] : runningReactionQueue;
  queue.push(el, meta ? meta.localName : key, old == null ? null : old, next, meta ? meta.ns : null);
  const outer = runningReactionQueue;
  runningReactionQueue = queue;
  try { attributeChangeSteps(el, key, old, next, pre, meta); }
  finally {
    runningReactionQueue = outer;
    if (own) for (let i = 0; i < queue.length; i += 5) fireAttrChangedCallback(queue[i], queue[i + 1], queue[i + 2], queue[i + 3], queue[i + 4]);
  }
}
// A step's own attribute write (see above): the element's own steps, not a `setAttribute` a page may have replaced.
function stepSetAttribute(el, name, value) {
  stepWrite = true;
  try { el._setAttribute(name, value); }
  finally { stepWrite = false; }
}
// What must be read BEFORE the store changes for the steps to run after: an input's value mode and selectability
// under its OLD type (HTML "input type change" steps, which run for the IDL `type` setter and every attribute path
// alike — Glimmer sets the `value` property and then the `type` attribute).
function beforeAttributeChange(el, key) {
  if (el._tag !== 'input' || attrLocalNameInNoNamespace(el, key) !== 'type') return null;
  return { prevMode: inputValueMode(el.type), wasSelectable: el.__selectionApplies() };
}
// The attribute's local name when it is in no namespace, else null (every named step below is for one of those).
function attrLocalNameInNoNamespace(el, key, meta = (el._attrNS && el._attrNS[key]) || null) {
  if (!meta) return key;
  return meta.ns == null ? meta.localName : null;
}
function attributeChangeSteps(el, key, old, next, pre, meta) {
  // A change to the attribute that sources an image element's bitmap (an <img>'s src, an SVG <image>'s href /
  // xlink:href — namespaced) re-fetches + decodes the new resource; removing it discards the current request
  // (resets intrinsic size + bitmap), and for an SVG <image> lets a remaining xlink:href fallback take over. (The
  // IDL setters set `_attrs` and call `_loadImageResource` directly; its per-src idempotence keeps the two entry
  // points from double-decoding.)
  const qn = meta ? (meta.prefix ? meta.prefix + ':' + meta.localName : meta.localName) : key;
  if (old !== next && el._isImageResourceAttr(qn)) el._loadImageResource();
  const n = attrLocalNameInNoNamespace(el, key, meta);
  if (n === null) return;
  // Disabling a control or `<fieldset>` removes focus from any now-actually-
  // disabled element SYNCHRONOUSLY (HTML runs the focus fix-up during the disabled
  // change, not on a later task) — so `fieldset.disabled = true; activeElement` is
  // already reset (disabled-003). No-op unless the active element just became
  // unfocusable, so an ordinary setAttribute pays one `=== 'disabled'` compare.
  if (n === 'disabled' && next !== null) {
    const doc = el.ownerDocument || globalThis.document;
    const ae  = doc && doc._activeElement;
    if (ae && !isFocusable(ae)) {
      doc._activeElement = null;
      fireEvent(ae, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true, view: globalThis }));
      fireEvent(ae, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true, view: globalThis }));
    }
  }
  // ARIA element-reference attribute-change steps: changing the content
  // attribute detaches any explicitly-set attr-element(s) (the IDL slot), so
  // the getter recomputes from the content attribute. Gated on _attrElements
  // (undefined for virtually every element) so non-ARIA setAttribute pays one
  // truthy check. (The IDL setter sets the attr first, then stores the slot.)
  if (el._attrElements && ARIA_ATTR_TO_SLOT[n]) __ariaClearSlot(el, ARIA_ATTR_TO_SLOT[n]);
  // A direct content-attribute change supersedes a prior IDL-set-to-null on an
  // enumerated ARIA attribute (see the ARIA_ENUM reflectors): clear its marker so
  // the value tracks the attribute again. Gated on the (rare) marker existing.
  if (el._ariaNull) el._ariaNull.delete(n);
  // A name/id becomes a named property — gate the form / window / document
  // named-access lookups for this value (no-op for non-applicable tags; the
  // exotic objects resolve existence + value live; see registerNamedAccess).
  if ((n === 'id' || n === 'name') && next) registerNamedAccess(el, n, next);
  // HTML nonce attribute-change steps: setting the content attribute syncs the
  // internal slot the IDL getter reads (see the `nonce` accessor + the
  // connection-time hiding in fireCEConnect). Keeps `.nonce` correct after an
  // explicit `setAttribute('nonce', '')` once the value has been hidden.
  if (n === 'nonce') el._nonce = next === null ? '' : next;
  // HTML canvas: its `width` or `height` set — even to the value it had (the `canvas.width = canvas.width` clear idiom)
  // — resets its bitmap to transparent black, sized anew, and its 2D context's state (transform, clip, styles).
  if ((n === 'width' || n === 'height') && el._tag === 'canvas' && el._ns === HTML_NS) {
    el._pixels = null;
    if (el._ctx) el._ctx._resetState();
  }
  // HTML script: an `async` attribute added sets its "force async" false.
  if (n === 'async' && next !== null && el._tag === 'script') el._forceAsync = false;
  // HTML details: `open` coming or going queues the details toggle task (queueDetailsToggle), and opening one closes
  // the rest of its name group; a new `name` closes it where its new group has one open already.
  // …and a dialog's `open` coming or going puts it on or takes it off its document's open dialogs.
  if (n === 'open' && isDialog(el) && (old == null) !== (next === null)) {
    if (next !== null) dialogOpened(el);
    else dialogClosed(el);
  }
  if (isDetails(el)) {
    if (n === 'open' && (old == null) !== (next === null)) {
      queueToggleTask(el, old == null ? 'closed' : 'open', next === null ? 'closed' : 'open');
      if (next !== null) closeOtherDetailsIfNeeded(el);
    } else if (n === 'name') {
      namedDetailsSeen = true;
      closeDetailsIfNeeded(el);
    }
  }
  // HTML `selected` content-attribute change steps: adding the
  // attribute, when the option's selectedness is not dirty (never set
  // via the IDL setter / a user pick), sets selectedness to true. The
  // content attribute is `defaultSelected`; selectedness is the live
  // `.selected`. `_selInit` records that the connect-walk default has
  // been applied, so a programmatic `setAttribute('selected')` takes
  // effect immediately rather than waiting for the next connect.
  // …and removing it, when selectedness is not dirty, clears selectedness (then the owning select re-runs its
  // algorithm to restore a default).
  if (n === 'selected' && el._tag === 'option') {
    if (next !== null) el._selInit = true;
    if (el._dirtySel !== true) { setSelectedness(el, next !== null); askForReset(el); }
  }
  // HTML: removing `multiple` from a <select> re-runs the selectedness setting algorithm. The select is now
  // single-selection, so a prior multi-selection collapses to the last selected option in tree order
  // (crbug.com/1245443 / select-multiple.html).
  if (n === 'multiple' && next === null && el._tag === 'select') runSelectednessAlgorithm(el, null);
  // …and a frame's `marginwidth` / `marginheight` are its document body's margins: pushed into the frame's realm.
  if ((n === 'marginwidth' || n === 'marginheight') && (el._tag === 'iframe' || el._tag === 'frame') && el._frameRealmId != null) {
    try {
      const win = globalThis.RustyRacer.contextGlobal(el._frameRealmId);
      if (win) win.__csimFrameMarginsChanged(el._getAttribute('marginwidth'), el._getAttribute('marginheight'));
    } catch (e) {}
  }
  // A frame's src/srcdoc change reloads its nested document — drop the cached
  // contentWindow so the next access re-parses (matches real-browser reload).
  // …and setting `src` navigates even to the SAME value (HTML: the attribute's setter runs
  // "process the iframe attributes" whatever it held; Chrome fires a fresh `load`).
  // Removing either reloads it too: the realm is disposed (firing beforeunload on the old document) and the next
  // access rebuilds it.
  if ((n === 'src' || n === 'srcdoc') && next === null && (el._tag === 'iframe' || el._tag === 'frame')) {
    const oldRealmId = el._frameRealmId;
    el._frameWindow = null;
    el._frameRealmId = null;
    disposeFrameRealmForNav(oldRealmId);
  } else if ((n === 'src' || n === 'srcdoc') && (el._tag === 'iframe' || el._tag === 'frame') && (old !== next || (n === 'src' && el._attrs.srcdoc == null))) {
    // A REAL re-navigation of an already-loaded `src` frame (a realm exists) records a
    // session-history entry, snapshotting the OUTGOING document, so history.go(-1) can
    // traverse back to it (and a controlling SW sees isHistoryNavigation). Must run BEFORE
    // _renavigateFrameDocument disposes the outgoing realm. srcdoc / the initial load (no
    // realm yet) don't record. (location.href / link navs aren't recorded yet — as before.)
    if (n === 'src' && el._frameRealmId != null && globalThis.__csim_recordFrameNav) {
      try {
        const base = (globalThis.location && globalThis.location.href) || undefined;
        const abs = new URL(next, base);
        // Only http(s) entries — a data:/blob:/about:/javascript: document can't be
        // reconstructed by the traversal's HTTP refetch (reload_frame_to_entry).
        if (abs.protocol === 'http:' || abs.protocol === 'https:') {
          globalThis.__csim_recordFrameNav(el._frameRealmId, abs.href);
        }
      } catch (_) {}
    }
    // A src/srcdoc change re-navigates the frame to the NEW document: a pending
    // scripted-nav response (form-target content not yet consumed) is superseded
    // and dropped (navContent=null → rebuild from the new src/srcdoc). The
    // retained blob bytes are also stale now, so drop them.
    el._frameLoadedContent = null;
    el._renavigateFrameDocument(null);
  }
  if (old !== next && next !== null && n === 'src' && el._tag === 'audio') el._loadMediaResource();   // video has its own pipeline (media.js)
  // A `<source srcset>` change inside a `<picture>` re-runs each sibling
  // `<img>`'s "update the image data" — the img's own attributes are untouched,
  // so its hook above never fires (fetch-destination's picture case assigns
  // source.srcset after both are parented).
  if (old !== next && next !== null && el._tag === 'source' && PICTURE_SOURCE_ATTRS.has(n) &&
      el._parent && el._parent._tag === 'picture') {
    for (const sib of el._parent._children || []) {
      if (sib._nodeType !== 1 || sib._tag !== 'img') continue;
      if (n === 'srcset' || n === 'src') { try { sib._loadImageResource(); } catch (_) {} }
      // The img's BOX also comes from this source (its dimension attributes map onto the img —
      // cascade.js `presentationalHint`), and the write above dirtied the `<source>`, which has
      // no box. Nothing else would re-lay-out the img, so a responsive swap kept the old size.
      try { markLayoutDirty(sib, true); } catch (_) {}
    }
  }
  // An event-handler content attribute (`onclick="…"`) activates the element's
  // handler as a registered listener (and removing it clears the handler); on body/frameset the six window-reflecting
  // handlers drive the Window's handler instead (syncInlineEventHandler folds
  // both in, gating cheaply on the `on` prefix for every other attribute).
  syncInlineEventHandler(el, n, next);
  // Form-associated custom element reactions from an attribute change or removal: `form`
  // re-points the owner, `disabled` (on the element or on a <fieldset>) flips the
  // disabled state, `id` on a <form> re-points its references (see
  // resetFormAssociatedOwnersForAttr).
  if (old !== next && (n === 'form' || n === 'id' || n === 'disabled')) resetFormAssociatedOwnersForAttr(el, n);
  if (pre !== null && old !== next) applyInputTypeChange(el, pre.prevMode, pre.wasSelectable);
}

// Input types whose value maps to/from a number (valueAsNumber / step).
const NUMERIC_INPUT_TYPES = new Set(['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local']);
// HTML input "value IDL attribute mode" per type. "value" types carry a live
// value + dirty value flag (stored in `_value`); "default" / "default/on" types
// reflect the `value` content attribute directly (no dirty value); "filename" is
// the file input. Anything unlisted (text, search, url, email, password, the
// temporal/number/range/color types, an unknown type) is "value" mode.
const INPUT_VALUE_MODE = {
  hidden: 'default', submit: 'default', image: 'default', reset: 'default', button: 'default',
  checkbox: 'default/on', radio: 'default/on',
  file: 'filename',
};
function inputValueMode(type) { return INPUT_VALUE_MODE[(type || '').toLowerCase()] || 'value'; }
// HTML "input type change" steps for the live-value / content-attribute split:
// migrate the value between `_value` (live) and the `value` content attribute as
// the value mode changes, re-sanitize, and reset selection / radio-group state.
// `prevMode` / `wasSelectable` are captured BEFORE the `type` attribute changed.
// Runs from BOTH the `type` IDL setter and `setAttribute('type', …)` — frameworks
// (Glimmer/Ember) set the `value` PROPERTY then the `type` ATTRIBUTE, so without
// the setAttribute path a value written under the old (text) mode would strand in
// `_value` and never reach the new default-mode type's `value` attribute (the
// radio's `value={{@value}}` then has no value attribute — Discourse form-kit).
function applyInputTypeChange(el, prevMode, wasSelectable) {
  const newMode = inputValueMode(el.type);
  if (prevMode === 'value' && (newMode === 'default' || newMode === 'default/on')) {
    const lv = controlLiveValue(el);
    if (lv !== '') stepSetAttribute(el, 'value', lv);   // value → content attribute: a recorded write, the step's own
    clearControlLiveValue(el);
  } else if (prevMode !== 'value' && newMode === 'value') {
    clearControlLiveValue(el);   // value tracks the content attribute; dirty flag cleared
  } else if (prevMode !== 'filename' && newMode === 'filename') {
    clearControlLiveValue(el);   // value → "" (file value derives from `_files`)
    el._files = [];              // …which in filename mode empties the selected files (HTML: setting the value to '')
  }
  // Re-run value sanitization for the new type on a still-dirty value (text →
  // number drops a non-numeric value to ''); a clean value is sanitized on read.
  if (el._value !== undefined) setControlLiveValue(el, sanitizedValueOf(el, el.type, String(el._value)));
  // Becoming selectable from a non-selectable type starts selection at [0, 0].
  if (!wasSelectable && el.__selectionApplies()) {
    el._selectionStart     = 0;
    el._selectionEnd       = 0;
    el._selectionDirection = 'none';
  }
  // Now a checked radio: enforce the group's single-checked invariant.
  if (el.type === 'radio' && getCheckedness(el)) uncheckOtherRadios(el);
}
// Radio-group de-dup on INSERTION. When a CHECKED radio is inserted into a context
// where its group is well-defined — it is connected OR has a form owner — it
// unchecks the other members of its group (same name + form owner + root). A purely
// disconnected tree (no form owner) still forms a group for validity, but does NOT
// de-dup on insertion. The LAST checked radio of a group in tree order wins, so the
// inserted subtrees' checked radios are visited in REVERSE document order (one an
// earlier sibling's de-dup already unchecked is skipped). Allocation-free until a
// checked radio is actually present.
function collectCheckedRadios(node, out) {
  if (node._tag === 'input' && node._attrs.name != null &&
      (node._attrs.type || '').toLowerCase() === 'radio' && getCheckedness(node)) {
    (out || (out = [])).push(node);
  }
  const kids = node._children;
  if (kids) for (let i = 0; i < kids.length; i++) {
    if (kids[i]._nodeType === NODE_ELEMENT) out = collectCheckedRadios(kids[i], out);
  }
  return out;
}
// The insertion steps of the elements that close the rest of a group — a checked radio's, an open named details
// element's — for inserted nodes.
function groupInsertionSteps(nodes) {
  radioGroupDedupOnInsert(nodes);
  detailsExclusivityOnInsert(nodes);
}
function radioGroupDedupOnInsert(nodes) {
  let radios = null;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i] && nodes[i]._nodeType === NODE_ELEMENT) radios = collectCheckedRadios(nodes[i], radios);
  }
  if (!radios) return;
  for (let i = radios.length - 1; i >= 0; i--) {
    const r = radios[i];
    if (getCheckedness(r) && (isConnected(r) || formForControl(r))) uncheckOtherRadios(r);
  }
}
// Controls that fire `change` only when they LOSE FOCUS, iff the USER changed the
// value since they gained it (text-like inputs + <textarea>). checkbox/radio/select
// commit `change` on the interaction itself, not on blur. `focus()` records the
// baseline value + clears the user-edit flag; user input (markUserEdit) sets the
// flag; `commitChangeOnBlur` fires iff the flag is set AND the value differs. A
// purely PROGRAMMATIC value change (`.value=`, setRangeText, …) never sets the flag,
// so it cannot make the control fire `change` — even though it moves the value (and
// an input handler that programmatically restores-then-resets a user edit still
// reports change iff the net value differs from the focus value).
function isChangeOnBlurControl(el) {
  return el._tag === 'textarea' ||
    (el._tag === 'input' && inputValueMode((el._attrs.type || '').toLowerCase()) === 'value');
}
function commitChangeOnBlur(el) {
  if (!el || el._changeBaseline === undefined || !isChangeOnBlurControl(el)) return;
  const fire = el._editedSinceFocus === true && controlLiveValue(el) !== el._changeBaseline;
  el._changeBaseline = undefined;   // reset BEFORE dispatch so a re-entrant focus re-arms cleanly
  el._editedSinceFocus = false;
  if (fire) {
    markUserValidity(el);
    fireEvent(el, new Event('change', { bubbles: true, cancelable: false }));
  }
}
// Commit a pending `change` WITHOUT blurring — implicit form submission (Enter in a
// text field) fires `change` before `submit` while the field keeps focus (verified
// in Chrome). Re-baselines to the committed value so a later blur won't re-fire.
export function commitChangeKeepingFocus(el) {
  if (!el || el._changeBaseline === undefined || !isChangeOnBlurControl(el)) return;
  if (el._editedSinceFocus !== true || controlLiveValue(el) === el._changeBaseline) return;
  el._changeBaseline = controlLiveValue(el);   // re-baseline BEFORE dispatch (re-entrancy)
  el._editedSinceFocus = false;
  markUserValidity(el);
  fireEvent(el, new Event('change', { bubbles: true, cancelable: false }));
}
// Input types whose activation behaviour shows a picker — clicking one consumes
// transient user activation.
const PICKER_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'file', 'month', 'time', 'week']);
// HTML autofill "expectation mantle" processing model for the `autocomplete`
// IDL getter on input/select/textarea: parse the attribute's token list
// (section- / shipping|billing / home|work|mobile|fax|pager / field-name /
// webauthn) from the end, validate, and serialize the canonical form, or '' if
// it doesn't parse. A lone on/off is returned verbatim unless the control wears
// the autofill ANCHOR mantle (input type=hidden), where on/off → ''.
const AUTOFILL_FIELD_NAMES = new Set([
  'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name',
  'honorific-suffix', 'nickname', 'username', 'new-password', 'current-password',
  'one-time-code', 'organization-title', 'organization', 'street-address',
  'address-line1', 'address-line2', 'address-line3', 'address-level4',
  'address-level3', 'address-level2', 'address-level1', 'country', 'country-name',
  'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name',
  'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
  'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day',
  'bday-month', 'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code',
  'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix',
  'tel-local-suffix', 'tel-extension', 'email', 'impp', 'webauthn'
]);
// Fields that accept a contact token (home/work/mobile/fax/pager).
const AUTOFILL_CONTACT_FIELDS = new Set([
  'tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local',
  'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp'
]);
const AUTOFILL_CONTACT = new Set(['home', 'work', 'mobile', 'fax', 'pager']);
function serializeAutofill(rawValue, anchorMantle) {
  const tokens = String(rawValue == null ? '' : rawValue)
    .split(/[\t\n\f\r ]+/).filter((t) => t).map((t) => t.toLowerCase());
  if (tokens.length === 0) return '';
  if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off')) {
    return anchorMantle ? '' : tokens[0];
  }
  let idx = tokens.length - 1;
  let credential = '';
  if (tokens[idx] === 'webauthn' && idx > 0) { credential = 'webauthn'; idx--; }
  const field = tokens[idx];
  if (!AUTOFILL_FIELD_NAMES.has(field)) return '';
  idx--;
  let contact = '';
  if (idx >= 0 && AUTOFILL_CONTACT.has(tokens[idx]) && AUTOFILL_CONTACT_FIELDS.has(field)) { contact = tokens[idx]; idx--; }
  let mode = '';
  if (idx >= 0 && (tokens[idx] === 'shipping' || tokens[idx] === 'billing')) { mode = tokens[idx]; idx--; }
  let section = '';
  if (idx >= 0 && tokens[idx].indexOf('section-') === 0) { section = tokens[idx]; idx--; }
  if (idx >= 0) return '';   // leftover, un-consumed tokens → invalid
  return [section, mode, contact, field, credential].filter((x) => x).join(' ');
}

// Form-control enums. Defaults differ per attribute — note `*type` missing/invalid
// both default to the keyword default, but `formMethod`/`formEnctype` have an empty
// missing-value default yet a non-empty INVALID-value default (so they pass missing
// '' but invalid 'get'/urlencoded separately). `input.type` uses the full HTML
// keyword set (incl. month/week, a superset of the WPT data) to stay spec-correct.
const ENUM_INPUT_TYPE = buildEnumMap([
  'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month',
  'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio',
  'file', 'submit', 'image', 'reset', 'button'
]);
const ENUM_BUTTON_TYPE = buildEnumMap(['submit', 'reset', 'button']);
const ENUM_FORM_METHOD = buildEnumMap(['get', 'post', 'dialog']);   // form.method, button.formMethod
const ENUM_INPUT_FORM_METHOD = buildEnumMap(['get', 'post']);       // input.formMethod (no dialog)
const ENUM_ENCTYPE = buildEnumMap(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
// th/td.scope: missing + invalid default ''.
// input[type=color].colorSpace: missing + invalid default 'limited-srgb'.
const ENUM_COLORSPACE = buildEnumMap(['limited-srgb', 'display-p3']);
// media `loading`: missing + invalid 'eager'.
const ENUM_LOADING = buildEnumMap(['lazy', 'eager']);
const LOADING_TAGS = new Set(['video', 'audio']);
// crossOrigin (img/link/script/audio/video): NULLABLE — missing default null,
// invalid default 'anonymous', '' is a non-canonical synonym for 'anonymous'.
const ENUM_CROSSORIGIN = buildEnumMap(['anonymous', 'use-credentials'], {'': 'anonymous'});
// media.preload: keywords none/metadata/auto; '' is a synonym for 'auto'; the
// missing/invalid value default is UA-defined (the WPT test accepts any of the
// three) — we use 'auto'.
const ENUM_PRELOAD = buildEnumMap(['none', 'metadata', 'auto'], {'': 'auto'});

// ── Numeric-attribute reflection ─────────────────────────────────────────────
// HTML "rules for parsing (non-negative) integers" live in ./html-integers.js
// (shared with the selectedness algorithm's display-size check); the
// `reflect*Get` getters below layer the range fallback on top of them.
const REFLECT_MAX_INT = 2147483647;    // 2^31 - 1
const REFLECT_MIN_INT = -2147483648;   // -2^31
// Getters — `raw` is the stored attribute string (or null when absent).
function reflectUnsignedLongGet(raw, def) {
  if (raw == null) return def;
  const v = parseHtmlNonneg(raw);
  return (v === null || v > REFLECT_MAX_INT) ? def : v;
}
// "limited to only positive numbers [with fallback]" — the GET is identical for
// both (parse; in [1, maxInt] or fall back to default); they differ only on SET.
function reflectLimitedUnsignedLongGet(raw, def) {
  if (raw == null) return def;
  const v = parseHtmlNonneg(raw);
  return (v === null || v < 1 || v > REFLECT_MAX_INT) ? def : v;
}
// Setters — WebIDL conversion (ToUint32 `>>> 0`) then the shortest decimal
// string; per spec a value above 2147483647 reflects the attribute's DEFAULT —
// so pass `def` (width/height/hspace 0, canvas 300/150, …). `def` is omitted only
// when no overflow default is defined (then a >maxInt value is stringified
// verbatim). "with fallback" maps an out-of-[1,maxInt] value to default.
function reflectUnsignedLongSet(el, attr, v, def) {
  const u = v >>> 0;
  el._setAttribute(attr, String(def !== undefined && u > REFLECT_MAX_INT ? def : u));
}
function reflectLimitedUnsignedLongFallbackSet(el, attr, v, def) {
  const u = v >>> 0;
  el._setAttribute(attr, String(u >= 1 && u <= REFLECT_MAX_INT ? u : def));
}
// "limited to only non-negative numbers greater than zero" (no fallback): a zero
// value throws IndexSizeError; a value above 2147483647 reflects the default;
// otherwise store the ToUint32 value.
function reflectLimitedUnsignedLongSet(el, attr, v, def) {
  const u = v >>> 0;
  if (u === 0) throw new globalThis.DOMException(`Failed to set the '${attr}' property: The value provided (0) is invalid.`, 'IndexSizeError');
  el._setAttribute(attr, String(def !== undefined && u > REFLECT_MAX_INT ? def : u));
}
// "limited to only non-negative numbers" (signed long): a negative value throws
// IndexSizeError; otherwise store the ToInt32 value as a decimal string.
function reflectLimitedLongSet(el, attr, v) {
  const n = v >> 0;
  if (n < 0) throw new globalThis.DOMException(`Failed to set the '${attr}' property: The value provided is negative.`, 'IndexSizeError');
  el._setAttribute(attr, String(n));
}

// The elements whose `tabIndex` defaults to 0 (in the HTML namespace; `Element#tabIndex`).
const TABBABLE_BY_DEFAULT = new Set(['a', 'area', 'button', 'frame', 'iframe', 'input', 'object', 'select', 'textarea']);

// An `<iframe>`'s / a `<frame>`'s nested browsing context — a same-realm nested
// Document parsed from srcdoc / src (lazily, via the bridge frame loader).
// contentWindow.DOMException etc. resolve to the shared globals, so
// `instanceof` across the frame boundary works.
export function frameContentWindow(frame) {
  // A frame has no browsing context (contentWindow null) when it isn't
  // connected, or while a connect walk is in progress and the frame's OWN
  // post-insertion step (connectOneElement, which sets `_browsingContextReady`
  // in tree order) hasn't run yet. So a `<script>` inserted atomically BEFORE
  // an `<iframe>` in the same appendChild (div / DocumentFragment / append()
  // multi-arg) runs mid-walk and sees null, while a script AFTER it sees the
  // live window. OUTSIDE any connect walk a connected frame is always ready —
  // direct-splice inserts (innerHTML / DSD), which run no sibling scripts and
  // bypass the connect walk, are unaffected.
  // (dom/nodes/insertion-removing-steps/Node-appendChild-script-and-iframe.html)
  if (!isConnected(frame)) return null;
  if (globalThis.__csimConnectWalkDepth > 0 && !frame._browsingContextReady) return null;
  const w = globalThis.__csimFrameWindow ? globalThis.__csimFrameWindow(frame) : null;
  if (!w) return w;
  // Return THIS realm's WindowProxy for the frame, not the raw child global, so
  // `contentWindow === e.source` (from a message it sends) and cross-realm
  // postMessage attributes the sender. Falls back to raw if no proxy can be made.
  if (globalThis.__csimFrameWindowProxyFor) {
    try { return globalThis.__csimFrameWindowProxyFor(globalThis.RustyRacer.contextOf(w)) || w; } catch (_) {}
  }
  return w;
}
export function frameContentDocument(frame) {
  const w = frameContentWindow(frame);
  if (!w) return null;
  // Same-origin policy: a frame's document is only reachable when the frame is
  // same-origin with THIS (the accessing) realm; a cross-origin frame's
  // `contentDocument` is null (its WindowProxy stays accessible via
  // `contentWindow`). Compare the frame's document origin — read off the raw
  // child global, not the WindowProxy — against this realm's origin. A serialized
  // compare: distinct opaque origins both serialize to "null", but the only case
  // that yields "null" === "null" here is a child that INHERITED this realm's
  // opaque origin (about:blank / srcdoc under an opaque parent) — genuinely
  // same-origin. A sandboxed frame's opaque "null" differs from a real parent
  // origin and is correctly cross-origin. Fail CLOSED if the origin can't be read.
  const raw = globalThis.__csimFrameWindow ? globalThis.__csimFrameWindow(frame) : null;
  if (raw) {
    let frameOrigin, read = false;
    try { frameOrigin = raw.__csimOrigin(); read = true; } catch (_) {}
    if (!read || frameOrigin !== globalThis.__csimOrigin()) return null;
  }
  return w.document;
}

// A connected `<style>`'s CSSStyleSheet (CSSOM): a view of the style engine's sheet of its block (cascade.js
// `ownerSheet`), which follows the block's text — so an earlier-inserted script observes a later-inserted `<style>`
// already applied. Disconnected → null.
export function styleElementSheet(style) {
  if (!isConnected(style) || !styleElementIsCss(style)) return style._dropSheet();
  return style._sheetOf(ownerSheet(style), { media: style._attrs.media || '' });
}

// A connected `<link rel=stylesheet>`'s CSSStyleSheet (CSSOM `LinkStyle.sheet`): its loaded sheet — the resource
// fetch is synchronous, so the sheet is there as soon as the link is connected (an earlier script observes it). A
// `<link disabled>` obtains none (HTML): it is absent from document.styleSheets and contributes nothing to the cascade —
// the disabling `setAttribute` orphaned any sheet it had. Disconnected → null. One object for as long as the owner's
// engine sheet is the same one.
export function linkElementSheet(link) {
  const rel = asciiLower(link._attrs.rel || '').split(/\s+/);
  const href = link._attrs.href;
  if (!isConnected(link) || !rel.includes('stylesheet') || !href || link._attrs.disabled != null) return link._dropSheet();
  // Resolve against THIS document base first — the raw attribute would (a) miss the SW style memo (keyed on absolute
  // URLs) and hand `.sheet` a NETWORK body while the cascade applied the SW-served one, and (b) resolve against the MAIN
  // document Ruby-side (wrong directory for a subframe). A failed fetch (null) still yields an (empty) sheet.
  let sheetAbs = href;
  try { sheetAbs = new globalThis.URL(String(href), link.baseURI || undefined).href; } catch (_) {}
  const made = engineSheetOf(link, fetchStyleSheetText(sheetAbs) || '', sheetAbs, link._attrs.media || '', link.ownerDocument, link._sheetGen | 0);
  return link._sheetOf(made, { href: sheetAbs, media: link._attrs.media || '' });
}

// Constraint validation (HTML §4.10.20), the listed elements' members: the constraints a control suffers from are the
// arena's (validity.rs — valueMissing by the radio group, the placeholder label option, mutability; pattern compiled
// with `v`; the email and url grammars; tooLong / tooShort after a user edit; range and step, a reversed range
// included; badInput; customError), read through a live ValidityState, the same object every time.
export const constraintValidationMembers = {
  get_validity(control) {
    if (!control._validityState) control._validityState = validityStateOf(() => validityFlagsObject(validityFlagsOf(control)));
    return control._validityState;
  },
  // (…none for a control barred from validation (willValidate false))
  get_validationMessage(control) {
    if (!willValidateOf(control)) return '';
    if (control._validationMessage) return control._validationMessage;
    const v = constraintValidationMembers.get_validity(control);
    if (v.valid) return '';
    if (v.valueMissing)    return 'Please fill out this field.';
    if (v.typeMismatch)    return 'Please match the requested format.';
    if (v.patternMismatch) return 'Please match the requested format.';
    return '';
  },
  // (…a candidate for constraint validation, validity.rs `will_validate`: a submittable control of a validating kind,
  // not actually disabled, not readonly, not in a `<datalist>`)
  get_willValidate: (control) => willValidateOf(control),
  // (…an invalid candidate fires a cancelable, non-bubbling `invalid` — Discourse's form-template-validation listens for
  // it to populate its errors; the default action, the UA's error tooltip, is not rendered)
  checkValidity(control) {
    if (!willValidateOf(control) || constraintValidationMembers.get_validity(control).valid) return true;
    fireEvent(control, new Event('invalid', { bubbles: false, cancelable: true }));
    return false;
  },
  reportValidity: (control) => constraintValidationMembers.checkValidity(control),
  // (…its newlines normalized, every CRLF and lone CR a LF; a custom error flips `:valid` / `:invalid`, dynamic
  // pseudo-classes, which the style-state generation carries to the cascade and layout memos)
  setCustomValidity(control, message) {
    const next = message.replace(/\r\n?/g, '\n');
    if ((control._validationMessage || '') !== next) bumpStyleState();
    control._validationMessage = next;
    setStateBit(control, STATE_CUSTOM_ERROR, next !== '');
  }
};
// A form's checkValidity(): each of its controls checked — a form-associated custom element through its internals —
// valid where all are.
function formCheckValidity(form) {
  let allValid = true;
  for (const el of formControlElements(form)) {   // (not `form.elements`, which a control named so shadows)
    const valid = isFormAssociatedCustomElement(el)
      ? !el._internals || checkInternalsValidity(internalsOf(el._internals))
      : typeof el.checkValidity !== 'function' || el.checkValidity();
    if (!valid) allValid = false;
  }
  return allValid;
}

// A template's contents: an inert DocumentFragment, made on first use for one the parser did not fill — its node
// document the template's document's associated INERT TEMPLATE DOCUMENT, a real separate Document, so inserting a node
// into it is a cross-document adopt (adoptedCallback fires) and `content.ownerDocument !== document` as in browsers.
export function templateContent(template) {
  if (!template._templateContent) {
    const content = template._templateContent = new DocumentFragment();
    content._ceRegistry = TRACKING_NULL;
    content._ownerDoc = inertTemplateDocFor(template.ownerDocument);
    // DOM: template content is a fragment WITH A HOST (adoptNode no-ops on it).
    content._host = template;
    // …kept beside the template, in its tree's arena — another realm's, for one in a frame's document — and linked
    // there, so the template serializes its contents.
    registerBeside(content, template);
    linkTemplateContent(template, content);
  }
  return template._templateContent;
}

// A labelable control's `labels` (see `get labels` on Element).
export function labelsOf(control) {
  // [SameObject]: the same live NodeList instance is returned on every access.
  // Build it once and cache it on the element; it is live (re-walked on settle-
  // gen bump) so it tracks moves/removals and empties out when the control
  // stops being labelable (e.g. an input toggled to type=hidden).
  if (!control._labelsList) {
    control._labelsList = liveNodeList(() => {
      const out = [];
      walk(control._getRootNode(), (el) => { if (isHtmlLabel(el) && labeledControlFor(el) === control) out.push(el); });
      return out;
    });
  }
  // input[type=hidden] is not a labelable element → null. The cached list is
  // kept so a later type change returns the SAME NodeList object.
  if (!isLabelableControl(control)) return null;
  return control._labelsList;
}

class Element extends Node {
  // `ns` / `localName` / `prefix` default to an HTML element named `tagName` lowercased; the parser's foreign content,
  // `createElementNS`, the XML parser and a clone pass their own — through `createElementNode`, which also gives the
  // element its interface prototype from birth.
  constructor(tagName, ns = HTML_NS, localName = undefined, prefix = null) {
    // (…an upgrade's `super()` — not an element the constructor makes before calling it, which the driver constructs)
    if (ceState.pendingUpgrade && !isElementTarget(new.target)) {
      const target = ceState.pendingUpgrade;
      ceState.pendingUpgrade = null;
      try { Object.setPrototypeOf(target, new.target.prototype); } catch (_) {}
      return target;
    }
    super();
    // Pre-init the scoped-registry slots with every other element (ONE hidden
    // class — see the pre-init block below): a late-added `_ceRegistry` /
    // `_ceUpgraded` write would split the shape for every template-content /
    // upgraded element (the measured regression class the block documents).
    this._ceRegistry = undefined;
    this._ceUpgraded = false;
    this._csimState = 0;   // the element-state bits (native-query-shadow.js `STATE_*`), behind the state accessors below and `hasState`
    this.__value = undefined;   // a form control's live value once dirty, behind `_value`
    this.__isValue = undefined; // the `is` value it was created with, behind `_isValue`
    this.__templateContent = undefined; // a `<template>`'s contents, behind `_templateContent`
    this.__files = undefined;   // a file input's selected files, behind `_files`
    // Allow subclasses (custom elements) to call `super()` without
    // a tagName — `__currentTag` carries the registered tag through
    // the createElement('my-el') path. A DIRECT `new MyCustomElement()`
    // (no createElement, no pending upgrade) has neither, so fall back
    // to the local name the constructor was registered under (the HTML
    // HTMLElement-constructor "look up definition by NewTarget" step).
    let tag = tagName || __currentTag;
    // A createElement with an explicit registry must expose it on `this` DURING
    // the constructor (the registry is set before the constructor runs).
    if (__currentCreationRegistry !== undefined && __currentTag) this._ceRegistry = __currentCreationRegistry;
    if (!tag && new.target) {
      // DIRECT `new MyCustomElement()` (no createElement tag, no pending upgrade):
      // the registered local name — for a customized built-in, the extended built-in
      // tag, plus its is value (the definition name) so the element and any later
      // clone re-resolve the definition by local name + is value. The lookup is
      // GLOBAL-registry-only (HTML: "look up... in the current global object's
      // registry"): a constructor defined only in scoped registries fails here.
      tag = customElementLocalName(new.target);
      if (!tag && ctorHasAnyDefinition(new.target)) {
        throw new TypeError('Illegal constructor: the custom element constructor is not registered with the global custom element registry.');
      }
      if (tag) becomeCustom(this, new.target);   // direct `new MyCE()` constructs custom
      const iv = customElementIsValueForCtor(new.target);
      if (iv !== null) this._isValue = iv;
    }
    // ASCII-lowercased, as `createElement` and the parser lowercase a name (`<x-Ä>` stays `x-Ä`).
    this._tag    = asciiLower(String(tag || ''));
    this._attrs  = {};   // name(lower) → value(string)
    // Namespace slots. `_localName` is case-preserving (vs the always-lowercased `_tag` that the matcher / cascade
    // use).
    this._ns        = ns;
    this._prefix    = prefix;
    this._localName = localName === undefined ? this._tag : localName;
    // Pre-init the lazily-added per-element hot-read caches/memos so EVERY element
    // shares ONE V8 hidden class — the per-element readers in find / visible_text /
    // cascade then hit monomorphic property ICs instead of megamorphic ones
    // (measured: late-added fields tipped ~400 els into a 2nd shape past V8's
    // 4-shape IC threshold). Keep this list in sync with the fields written below.
    this._declKey = null; this._declCache = null;              // inline-style decl read cache (style-proxy.js)
    this._vt = ''; this._vtGen = -1; this._vtCV = -1;          // __csimVisibleText memo (bridge.entry.js)
    this._attrsColl = null;                                    // live NamedNodeMap cache (get attributes)
    this._labelsList = null;                                   // [SameObject] HTMLElement.labels live NodeList
    this._svgClassName = null;                                 // [SameObject] SVGElement.className (SVGAnimatedString)
    this._selectedOptionsColl = null;                          // [SameObject] HTMLSelectElement.selectedOptions
    this._optionsColl = null;                                  // [SameObject] HTMLSelectElement/datalist .options
    this._elementsColl = null;                                 // [SameObject] HTMLFormElement/fieldset .elements
    this._nid = -1;                                            // native arena node id (store flip; -1 = none)
    this._nidArena = null;                                     // …of which arena (native-query-shadow.js `newArena`)
    this._styled = false;                                      // its first style read declares its memos (cascade.js `declareStyledMemos`)
    // STORE FLIP: eager-create this element's native arena node NOW, so `_attrs` is the arena-backed
    // attrsView from construction — no JS `_attrs` object ever backs a rendered element. Placed after the
    // hot-read fields above so every element shares ONE hidden class (registerNativeElement only reassigns
    // the pre-declared `_nid` / `_attrs`, adding no shape). No-op before __dom, where `_attrs` stays the plain `{}` set
    // above.
    registerNativeElement(this);
    // A `<form>` is wrapped in its named/indexed-property Proxy (see FORM_HANDLER):
    // `form.<control>` / `form[i]` resolve controls, with own-property descriptors
    // for Object.getOwnPropertyDescriptor / defineProperty / delete. The Proxy IS
    // the form everywhere (returned here), so identity holds. MUST be the ctor's
    // last statement — the returned object replaces `this`. The target chains
    // through HTMLFormElement.prototype first, so the form's IDL members
    // (relocated there for per-tag existence) are visible through the proxy's
    // Reflect-based traps. A custom element SUBCLASS's (a customized built-in
    // extending `<form>`) keeps its own class prototype, and no proxy.
    if (this._localName === 'form' && this._ns === HTML_NS && isElementTarget(new.target)) {
      return makeFormProxy(this);
    }
  }
  // HTML's focusing steps — HTMLOrSVGElement's `focus()` (htmlElementMembers) and the driver's own focusing, which a
  // page's `focus` never replaces.
  // Focus tracking: record `document.activeElement` and emit
  // focus / focusin / blur / focusout events so listeners observing
  // either path (`onfocus="..."` attribute, addEventListener, or
  // jQuery's `.focus(handler)`) actually fire. `:focus` pseudo-
  // class matches via `_activeElement` comparison in matchPseudo.
  _focus() {
    // A shadow host with delegatesFocus delegates focus to its "focus delegate"
    // — the first focusable element in its shadow tree (tree order) — rather than
    // focusing the host itself. The delegate becomes the shadow tree's
    // activeElement, and document.activeElement retargets up to the host. With no
    // focusable delegate, focus() is a no-op. If the shadow tree already has a
    // focused descendant, focus() keeps it rather than re-delegating to the first
    // focusable. (shadow-dom/focus/focus-method-delegatesFocus.html)
    if (this._shadowRoot && this._shadowRoot._delegatesFocus) {
      const delegate = this._shadowRoot.activeElement || firstFocusDelegate(this._shadowRoot);
      if (delegate) delegate._focus();
      return;
    }
    // HTMLLabelElement.focus(): a label that is not itself focusable (no valid
    // `tabindex`, or not rendered) forwards focus to its labeled control — like
    // the click hop. A label MADE focusable by a valid tabindex focuses itself
    // (falls through to the normal path below).
    if (isHtmlLabel(this) && !isFocusable(this)) {
      const control = labeledControlFor(this);
      if (control) control._focus();
      return;
    }
    // Per HTML focusing-steps: `el.focus()` on a non-focusable element
    // is a no-op. Without this guard, Discourse's DMenu close path
    // (closes its toolbar then `.focus()`s the trigger SPAN — a
    // `<span class="composer-image-node">` with no tabindex/role) was
    // mutating `document.activeElement`, so PM's strict `hasFocus()`
    // (root.activeElement === view.dom) returned false on the next
    // dispatch and `selectionToDOM` bailed — leaving the caret behind
    // when Enter inserted a new paragraph after a selected image.
    if (!isFocusable(this)) return;
    // (…in the document it is in, which an element made in another realm's document and adopted here is too)
    const doc = this.ownerDocument;
    const prev = doc._activeElement;
    if (prev === this) {
      // Already focused: no blur/focus churn, but re-evaluate :focus-visible — a
      // keyboard re-interaction (send_keys/Tab onto the current element) flips the
      // ring back on. `__csimFocusModality` is the last DRIVER action (pointer/
      // keyboard set at the click/Tab/send_keys entry points), not a true
      // last-input bit, so it stays sticky until the next driver action.
      setFocusVisible((globalThis.__csimFocusModality !== 'pointer') || __isTextEntryFocusTarget(this));
      return;
    }
    // HTML focus update steps: while the OUTGOING element fires its blur /
    // focusout, no element is the "currently focused area" — `document.
    // activeElement` is <body> and `:focus` matches nothing (verified against
    // Chrome). So clear `_activeElement` (its getter falls back to <body>) for
    // the duration of those events, and commit `this` only just before its own
    // focus / focusin. This also makes focus() re-entrant-safe: a blur/focusout
    // handler that synchronously moves focus — Discourse's ProseMirror alt-text
    // `onBlur → saveAltText → onSave → view.focus()` — now finds no element to
    // re-blur, so the old unbounded focus↔blur loop (which overflowed the stack,
    // threw a RangeError, was caught, and retried forever) can't form; the
    // handler completes the transition itself and the re-check below bails so we
    // neither double-fire focus nor clobber the target it chose. (`blur()` below
    // likewise clears `_activeElement` before dispatching.)
    doc._activeElement = null;
    if (prev) loseFocus(prev, this);
    // A blur/focusout handler above may have already moved focus (to `this` or
    // elsewhere). If so it owns the result — don't re-fire focus or override it.
    if (doc._activeElement !== null) return;
    doc._activeElement = this;
    noteFocusChain(this);
    // Arm the change-on-blur baseline: a text control fires `change` when it later
    // loses focus iff its value differs from this captured value.
    if (isChangeOnBlurControl(this)) { this._changeBaseline = controlLiveValue(this); this._editedSinceFocus = false; }
    // `:focus-visible` latch: the focus ring shows unless this focus was driven
    // by a pointer (input handlers set `__csimFocusModality`), and ALWAYS shows
    // for text-entry controls (real browsers always render their focus ring,
    // regardless of how focus arrived). Latched at focus time; the matcher reads
    // it. (shadow-dom/focus/focus-click-on-shadow-host.html)
    setFocusVisible((globalThis.__csimFocusModality !== 'pointer') || __isTextEntryFocusTarget(this));
    // Focusing a contenteditable element should leave the cursor at
    // a valid position (real browsers collapse the selection to the
    // last known caret, or to start/end if none). PM/Tiptap's
    // beforeinput handler reads the current Selection to compute
    // edits; without an active range the handler bails out and
    // `onUpdate` never fires. Set a collapsed range at the end of
    // the contenteditable if no selection is currently inside it.
    if (typeof isContenteditable === 'function' && isContenteditable(this) && typeof globalThis.__csimSelectionRange === 'function') {
      try {
        const r0 = globalThis.__csimSelectionRange();
        const inside = r0 && nodeContains(this, r0.startContainer);
        if (!inside) {
          // Descend into the deepest leaf and place the caret at
          // the end of its text content. PM / Tiptap initialize
          // empty editors as `<p><br class="ProseMirror-
          // trailingBreak"></p>`; positioning the caret at the
          // contenteditable root (offset = children.length) puts
          // the cursor OUTSIDE the paragraph, and PM's beforeinput
          // handler sees a selection with no valid inline parent
          // and bails. Walking to the leaf gives `(p, 1)`
          // (after the <br>), which PM correctly maps to model
          // position 1.
          // Stop at "void" / inline-leaf elements (BR, IMG, HR, INPUT)
          // — the caret can't go INSIDE them, it must stay in the
          // parent block. Without this guard the walk descends into
          // PM's placeholder `<br class="ProseMirror-trailingBreak">`
          // and the cursor ends up at (BR, 0), which PM rejects as
          // an out-of-content position.
          const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link']);
          let leaf = this;
          while (leaf._children && leaf._children.length > 0) {
            const next = leaf._children.find(c =>
              c._nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
            );
            if (!next) break;
            leaf = next;
          }
          // If the leaf has a single text-node child, position at
          // its end; otherwise position at the leaf's children-
          // count (after any placeholder <br>).
          if (leaf._children && leaf._children.length === 1 &&
              leaf._children[0]._nodeType === NODE_TEXT) {
            globalThis.__csimGetSelection().collapse(leaf._children[0], leaf._children[0]._data.length);
          } else {
            globalThis.__csimGetSelection().collapse(leaf, leaf._children ? leaf._children.length : 0);
          }
        }
      } catch (_) {}
    }
    // focus/focusin on the element gaining focus carry relatedTarget = the
    // element that lost it (retargeted across shadow boundaries by dispatch).
    fireEvent(this, new FocusEvent('focus',    { bubbles: false, cancelable: false, composed: true, view: globalThis, relatedTarget: prev }));
    fireEvent(this, new FocusEvent('focusin',  { bubbles: true,  cancelable: false, composed: true, view: globalThis, relatedTarget: prev }));
    // A customizable `<input list>` opens its `<datalist>` popover on focus.
    showComboboxDatalist(this);
    // HTML focus-fixup: a `:focus`-conditioned style can make the just-focused
    // element non-rendered (`#host:focus { display: none }`). A real browser
    // commits the focus synchronously (so `getComputedStyle(host).display` reads
    // 'none' right after focus()), then in the next rendering update finds the
    // focused area is no longer focusable and resets focus to the viewport — which
    // fires blur/focusout and, because `:focus` no longer matches, reverts display
    // to its un-focused value. The shared async fixup does exactly this.
    resetFocusIfUnfocusableAfterMove(doc);
  }
  // Focus went into this container's frame (the frame document's `_activeElement` setter calls it): the element focused
  // here loses it as to any other — its pending change, blur, focusout — and the container is this document's.
  _takeFocusFromFrame() {
    const doc = globalThis.document;
    const prev = doc._activeElement;
    if (prev === this) return;
    doc._activeElement = null;
    if (prev) loseFocus(prev, null);
    if (doc._activeElement === null) doc._activeElement = this;   // (unless a blur handler moved it)
  }
  // HTML's unfocusing steps — HTMLOrSVGElement's `blur()`.
  _blur() {
    const doc = this.ownerDocument;
    let target = this;
    if (doc._activeElement !== this) {
      // A delegatesFocus host: the focused element lives in its shadow tree, but
      // document.activeElement retargets up to the host — so blur() on the host
      // unfocuses the delegated element. (A slotted light-DOM element that has
      // focus is NOT delegated: document.activeElement is the slotted element,
      // not the host, so this branch is skipped and blur() no-ops.)
      const sr = this._shadowRoot;
      if (sr && sr._delegatesFocus && doc.activeElement === this) {
        target = doc._activeElement;
      } else {
        return;
      }
    }
    doc._activeElement = null;
    // Blurring an `<iframe>` takes focus out of its nested context, so the focus chain
    // falls back to the document that owns the container — the mirror image of focus()
    // handing it down. (Blurring any other element leaves the browsing context alone.)
    if (this._frameRealmId != null) noteFocusChain(null);
    // A text control commits a pending `change` first (before blur), iff its value
    // changed since it gained focus.
    commitChangeOnBlur(target);
    fireEvent(target, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true, view: globalThis }));
    fireEvent(target, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true, view: globalThis }));
  }

  // Geometry comes from the box-layout engine (layout.js) — ONE geometry, the same boxes that
  // back `obscured?` / `Node#rect` / `drag_to`, so a synthetic pointer and the page's own math
  // agree the way they do in a real browser. It is coarse in places (no glyph shaping, no
  // flex/grid track sizing, no baseline alignment), but it is real: text is measured with the
  // font's own advances, inline content flows and breaks into lines, and a non-rendered element
  // measures 0×0 at the origin like it should.
  //
  // Load-bearing properties this has to keep: jQuery `:visible` / Stimulus / IntersectionObserver
  // probes must not read a rendered element as hidden (a rendered block has a non-zero width, and
  // `getClientRects()` is non-empty for anything with a box), and Discourse's `_moveSelection` (J/K)
  // does `articles.find(rect.top >= headerOffset())`, which needs tops that increase down the page.
  // The element that answers for the VIEWPORT's client and scroll sizes (CSSOM View `clientHeight` / `scrollHeight`):
  // the document's scrolling element — the root in standards mode, the BODY in quirks mode, whose `scrollTop` is the
  // viewport's there too (`scrollOffsetHolder`), so `scrollHeight - clientHeight - scrollTop` stays one question. A
  // quirks body that scrolls ITSELF is no such element (Chrome: its own 3000, not the viewport's).
  _isViewportElement() {
    const doc = this.ownerDocument;
    return !!doc && this === doc.scrollingElement;
  }
  // NOT an alias for `scrollIntoView`: the "IfNeeded" variant does nothing when the box is already
  // fully shown, and CENTRES it when it is not — the alignment Blink's `ScrollAlignment::
  // CenterIfNeeded` gives and the one CDP's `DOM.scrollIntoViewIfNeeded` (so Cuprite's and
  // Playwright's click) rides on. Measured in Chrome 151, 937-tall viewport: a 34px target at
  // document y 2000 lands the page at 1549 from anywhere out of view — the centre — and stays put
  // when it is already showing, where aligning its top would say 2000 every time. The legacy
  // boolean argument selects the alignment: `false` asks for the nearest edge instead.
  scrollIntoViewIfNeeded(centerIfNeeded) {
    // ensureInView scrolls through the scrollLeft/scrollTop setters, which notify per scroller.
    ensureInView(this, centerIfNeeded === false ? 'nearest' : 'center');
  }
  // `form.submit()` — programmatic form submission. Per HTML's "submit a form"
  // algorithm with the *from `submit()` method* flag set: it skips the submit
  // event and constraint validation, but it STILL constructs the entry list
  // (firing `formdata`) and honours the cannot-navigate / constructing-entry-list
  // guards (memory `feedback_form_submit_spec_compliance`). We can't return out
  // through the synchronous JS call stack here, so `recordFormSubmission` stashes
  // the intent on a global slot the outer click-resolver picks up (Rails-UJS
  // data-method/data-confirm chain ends in form.submit inside the click handler;
  // the Ruby side reads the intent after dispatch and routes through the normal
  // POST/GET form-submit path). Direct callers (Capybara `Node#submit`) hit the
  // host fn instead.
  submit() {
    if (this._tag !== 'form') return;
    this.__runFormSubmit(null, true);
  }
  requestSubmit(submitter) {
    // `form.requestSubmit([submitter])` (HTML): validate the submitter argument,
    // then submit the form INTERACTIVELY — unlike submit(), it runs constraint
    // validation and fires the submit event.
    if (this._tag !== 'form') return;
    if (submitter != null) {
      // The submitter must be a submit button (button[type=submit] /
      // input[type=submit|image]) owned by THIS form.
      if (!isSubmitButton(submitter)) {
        throw new globalThis.TypeError(
          "Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not a submit button.");
      }
      if (formForControl(submitter) !== this) {
        throw new globalThis.DOMException(
          "Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not owned by this form element.",
          'NotFoundError');
      }
    } else {
      submitter = null;
    }
    this._submitForm(submitter, true);
  }
  // HTML "submit a form" — the interactive entry shared by requestSubmit() and a
  // submit-button activation: it runs constraint validation and fires the submit
  // event before constructing the entry list.
  _submitForm(submitter, interactive) {
    return this.__runFormSubmit(submitter, !interactive);
  }
  // The interactive submission's validation (HTML "submit a form" step 6): every control's user validity is set —
  // `:user-invalid` shows on the ones that stop it — and, unless the form or its submitter says `novalidate`, the
  // constraints are interactively validated (`invalid` fired at each control that fails). False when the submission
  // must stop. Every interactive entry asks it: requestSubmit, a submit button's activation — Capybara's
  // click_button included — and implicit submission.
  _validatesForSubmission(submitter) {
    const controls = formControlElements(this);
    for (const el of controls) markUserValidity(el);
    if (this._attrs.novalidate != null || (submitter != null && submitter._attrs.formnovalidate != null)) return true;
    // HTML "interactively validate the constraints": `invalid` at each control that fails, and the first whose event
    // is not canceled is where the problem is reported — it takes focus (Chrome).
    let valid = true, unhandled = null;
    for (const el of controls) {
      if (!suffersConstraintFailure(el)) continue;
      valid = false;
      if (fireEvent(el, new Event('invalid', { bubbles: false, cancelable: true })) && unhandled === null) unhandled = el;
    }
    if (unhandled !== null) unhandled._focus();
    return valid;
  }
  // HTML "submit a form" (4.10.22.3), the steps we model, in spec order.
  // `fromSubmitMethod` true ⇒ the caller is form.submit() (skips firing the
  // submit event and constraint validation; steps 5a–5h). The two re-entrancy
  // flags are kept distinct, matching the spec:
  //   _firingSubmissionEvents  — set while validating / firing `submit`; a nested
  //                              interactive submit (requestSubmit / button click
  //                              inside an `invalid` / `submit` handler) bails.
  //   _constructingEntryList   — set while building the entry list / firing
  //                              `formdata`; a nested submit of ANY kind, INCLUDING
  //                              form.submit(), bails (step 2).
  // Connectedness is re-checked after the submit event and again after `formdata`,
  // so a handler that removes the form from the document aborts the navigation.
  __runFormSubmit(submitter, fromSubmitMethod) {
    if (this._tag !== 'form') return false;
    if (!isConnected(this)) return false;          // step 1: cannot navigate
    if (this._constructingEntryList) return false; // step 2
    if (!fromSubmitMethod) {
      if (this._firingSubmissionEvents) return false;   // step 5: nested interactive submit
      this._firingSubmissionEvents = true;
      try {
        if (!this._validatesForSubmission(submitter)) return false;
        const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null });
        if (!fireEvent(this, ev)) return false;
      } finally { this._firingSubmissionEvents = false; }
    }
    // Then re-check the form can still navigate (a handler may have removed it), construct the entry list (`new
    // FormData` fires `formdata` exactly once and toggles the constructing-entry-list flag), re-check again (a
    // `formdata` handler may have removed it).
    if (!isConnected(this)) return false;
    const entryList = submissionFormData(this, submitter);
    if (!isConnected(this)) return false;
    // A `dialog` method closes the form's nearest ancestor dialog, its result the submitter's value — an image
    // button's the selected coordinate, which the driver's is the origin — rather than navigating.
    const method = submitter != null && submitter._attrs.formmethod != null ? submitter._attrs.formmethod : this._attrs.method;
    if (asciiLower(String(method || '')) === 'dialog') {
      let dialog = this._parent;
      while (dialog && dialog._tag !== 'dialog') dialog = dialog._parent;
      const result = submitter == null ? null
        : submitter._tag === 'input' && asciiLower(submitter._attrs.type || '') === 'image' ? '0,0'
        : submitter._attrs.value != null ? submitter._attrs.value : null;
      closeDialog(dialog, result);
      return true;
    }
    // Plan the navigation with that list, so a handler's mutations are honoured. `fromSubmitMethod` (the
    // form.submit() method, vs an interactive button/requestSubmit submit) drives the planned-navigation supersede
    // model in __csimSubmitFormToNamedFrame.
    recordFormSubmission(this, submitter || null, entryList, fromSubmitMethod);
    return true;
  }
  // HTMLElement's `click()` (htmlElementMembers) — and the driver's, which a page's `click` never replaces: a
  // programmatic synthetic click. jstoolbar dispatches
  // its keyboard-shortcut handlers via
  // `this.toolbar.querySelector('.jstb_strong').click()`, jQuery
  // form submission triggers `form[0].click()` on hidden submit
  // buttons, and Rails-UJS uses it to retrigger confirmed actions.
  // Per HTML spec the synthetic click is the same shape as a real
  // primary-button mouse click; we fire `click` directly (skipping
  // mousedown / mouseup because those are pointer-only). When the
  // synthetic click lands on a submit-shaped input/button inside a
  // form, we also fire the form's submit event and record the
  // submit intent so the outer click resolver can route the
  // navigation through Ruby's form-submit path — Rails-UJS's
  // data-method handler builds a hidden form, then calls
  // `form.querySelector('[type="submit"]').click()` to trigger
  // navigation, so without this step the form sits attached but
  // never submits.
  // `user`: the keys held by the user whose action clicks it without a
  // pointer — a keyboard's activation, an implicit submission's default
  // button, a trusted click's label hop — its click then trusted, theirs,
  // carrying those keys (Chrome's), and a link it activates with Control
  // or Meta held opened in a new window; none for a script's `click()`.
  _click(user = null) {
    // HTML "fire a synthetic pointer event": a disabled form control's
    // synthetic click is a no-op — no click event, no activation. (An
    // untrusted event dispatched directly via dispatchEvent still fires;
    // only this synthetic-click path is gated.)
    if (isActuallyDisabled(this)) return;
    try {
      // HTML spec activation behaviour for `<input type=checkbox>` /
      // `<input type=radio>` toggles the checked state *before* the
      // click event fires (the "pre-click activation steps"), then
      // fires `input` + `change` after the click if the event wasn't
      // canceled. Avo's item-select-all controller relies on this:
      // its `toggle` handler does `checkbox.click()` per item and
      // expects each one to flip its checked state — without the
      // toggle here those clicks bubble out as no-ops.
      let isInputControl = false;
      let inputType = '';
      if (this._tag === 'input') {
        inputType = (this._attrs.type || '').toLowerCase();
        isInputControl = inputType === 'checkbox' || inputType === 'radio';
      }
      const wasChecked = isInputControl ? getCheckedness(this) : null;
      // For radio, remember the group's prior selection so a canceled click
      // restores it (not just this control's own prior state).
      const prevCheckedRadio = inputType === 'radio' ? checkedRadioInGroup(this) : null;
      // Pre-activation steps for a checkbox also clear `indeterminate` (kept for the
      // canceled-activation undo).
      const wasIndeterminate = inputType === 'checkbox' ? hasState(this, STATE_INDETERMINATE) : undefined;
      if (isInputControl) {
        if (inputType === 'checkbox') { setStateBit(this, STATE_INDETERMINATE, false); toggleChecked(this); }
        else                          setRadio(this);
      }
      // HTML "fire a synthetic pointer event": a PointerEvent of no pointer (-1, no type), composed (it crosses shadow
      // boundaries to the host), its view the window — Chrome's and Firefox's.
      const ev = new PointerEvent('click', Object.assign({ bubbles: true, cancelable: true, composed: true, view: globalThis, pointerId: -1 }, user));
      // We performed the checkbox/radio pre-toggle above, so the dispatch
      // algorithm must NOT run its own activation (would double-toggle).
      ev._csimActivationHandled = true;
      // The activatable button for this click, captured BEFORE dispatch (a
      // listener may detach the clicked descendant — button-submit-remove-children).
      // Per single-activation, only the NEAREST activatable element in the path
      // activates: walk up to the FIRST element with click activation behaviour and
      // use it iff it is a button/input. So a click on a plain descendant
      // (<button><span>) activates the button, but a click on a closer activatable
      // (<input type=submit><a href>, a <summary>, a <label>) activates THAT, not
      // the button (Event-dispatch-single-activation-behavior).
      const nearest = activationTargetOf(this);
      const actBtn = (nearest && nearest._nodeType === NODE_ELEMENT &&
                      (nearest._tag === 'button' || nearest._tag === 'input')) ? nearest : null;
      if (user) dispatchEventForUserAction(this, ev);
      else      dispatchEvent(this, ev);
      if (ev._canceled && isInputControl) {
        // Roll back the state change if the click was cancelled.
        if (inputType === 'radio') {
          setCheckedness(this, false);
          if (prevCheckedRadio) setCheckedness(prevCheckedRadio, true);
        } else { setCheckedness(this, wasChecked); setStateBit(this, STATE_INDETERMINATE, wasIndeterminate); }
      } else if (isInputControl && isConnected(this) && getCheckedness(this) !== wasChecked) {
        // Per HTML, a DETACHED control's activation mutates state but fires no
        // input/change — only a connected control dispatches them (shared helper
        // brands them trusted/composed/non-cancelable; see dispatch.js).
        fireCheckableActivation(this);
      }
      // Clicking an input whose activation behaviour shows a picker (color /
      // date-family / file) consumes transient user activation.
      if (!ev._canceled && this._tag === 'input' && PICKER_INPUT_TYPES.has(inputType)) {
        globalThis.__csimTransientActivation = false;
      }
      // `selfActivated` tracks whether `this` (the clicked element) ran its
      // OWN activation behaviour — checkbox/radio toggle, form submit,
      // reset, `<summary>` toggle, or a `<label>` hop. Per the single-
      // activation-behaviour spec only ONE activation runs per click, so
      // once `this` self-activates we must NOT also walk up and activate an
      // ANCESTOR hyperlink (the anchor block below). A non-prevented click
      // on a checkbox/radio is itself the activation.
      let selfActivated = isInputControl && !ev._canceled;
      let didSubmit = false;
      // Re-check the control AFTER dispatch: a listener may have morphed its
      // type or disabled it. A disconnected control's form never submits, and
      // a (now) disabled submit button has no activation behavior.
      if (!ev._canceled && actBtn && actBtn._nodeType === NODE_ELEMENT &&
          isSubmitButton(actBtn) && isConnected(actBtn) && !isActuallyDisabled(actBtn)) {
        const form = formForControl(actBtn);
        if (form && typeof form._submitForm === 'function') {
          // A submit button's activation behaviour is to submit its form owner
          // INTERACTIVELY (run constraint validation + fire submit), same as
          // requestSubmit(submitter) — route both through one algorithm.
          didSubmit = form._submitForm(actBtn, true);
          selfActivated = true;   // the button activated even if validation/preventDefault blocked the submit
        }
      }
      // HTML-spec activation behaviour for a reset control (`<input
      // type=reset>` / `<button type=reset>`): reset the control's form
      // owner. `form.reset()` runs the "reset the form" steps (restore
      // every control's default + fire `reset`). Programmatic
      // `resetButton.click()` must do this just like a real click, and
      // — per the single-activation-behaviour spec — only the clicked
      // control activates, so nesting it inside another activatable
      // parent never double-fires.
      if (!ev._canceled && actBtn && actBtn._nodeType === NODE_ELEMENT &&
          isConnected(actBtn) && !isActuallyDisabled(actBtn) &&
          (actBtn._tag === 'input' || actBtn._tag === 'button') &&
          (actBtn._attrs.type || '').toLowerCase() === 'reset') {
        const form = formForControl(actBtn);
        if (form && typeof form.reset === 'function') { form.reset(); selfActivated = true; }
      }
      // `<summary>` activation toggles its `<details>` parent (open
      // flag flip + non-bubbling `toggle` event). Mirrors the UA-click
      // path so a programmatic `summary.click()` behaves the same.
      if (!ev._canceled && nearest && nearest._tag === 'summary' && activateSummary(nearest)) selfActivated = true;
      // `<label>` activation: a click on the `<label>` ITSELF, or on a
      // non-interactive descendant of it, runs a synthetic click on the label's
      // labeled control (HTML "click in a label" → activation of the labeled
      // control). `labelToActivateFor` encodes the single-activation rule shared
      // with the dispatchEvent and UA-click paths — the label does nothing when
      // the click targets interactive content (that element's own activation
      // runs instead). Runs BEFORE the anchor hop so a wrapping label takes
      // precedence over a still-further-out ancestor `<a>` (single activation).
      // No recursion: the forwarded `labeled.click()` targets interactive
      // content, so it does not re-enter this hop.
      if (!ev._canceled && !selfActivated) {
        const label = labelToActivateFor(this);
        if (label) {
          const labeled = labeledControlFor(label);
          if (labeled && labeled !== this) { labeled._click(user); selfActivated = true; }
        }
      }
      // A hyperlink's activation behaviour, where the activation target is one: the nearest activatable element on
      // the click's path — `this`, or the `<a>` / `<area>` around it (a `span.click()` inside a link navigates, as in
      // Chrome) — but not one in an editing host, which a click edits instead. (A `javascript:` link and a download
      // are the dispatch's, dispatch.js, for every click.) Avo's filter controllers call
      // `this.urlRedirectTarget.click()` on a hidden `<a>` element itself. Same-document fragment links navigate in
      // JS (and fire `hashchange`); everything else DEFERS the document fetch to a Ruby drain slot rather than
      // navigating in-call (navigating from inside a V8 callback rebuilds the Context mid-eval; see
      // `feedback_visit_always_rebuilds`). The `!didSubmit`/`!selfActivated` gates are belt-and-suspenders for the
      // single-activation contract.
      const link = nearest && (nearest._tag === 'a' || nearest._tag === 'area') ? nearest : null;
      if (!ev._canceled && !didSubmit && !selfActivated && link && !isContenteditable(link) &&
          (hrefAttr(link) || '').trim() !== '' && !(hrefAttr(link) || '').toLowerCase().startsWith('javascript:')) {
        anchorActivateNavigate(link, user && (user.ctrlKey || user.metaKey) ? '_blank' : link._attrs.target || '');
      }
    } catch (_) {}
  }
  _cloneShell() {
    const e = createElementNode(this._tag, this._ns, this._localName, this._prefix);
    // Copy the source's attributes INTO the clone's eager attrsView (its arena node), rather than
    // replacing `_attrs` with a fresh JS object — that would strand the eager node empty while the attrs
    // lived off-arena. `this._attrs` (source) enumerates via attrsView; `e._attrs` (clone) is attrsView
    // too, so each assignment writes straight into the clone's arena node. (Before __dom: both are plain `{}`.)
    Object.assign(e._attrs, this._attrs);
    if (this._attrNS) for (const k in this._attrNS) setAttrMeta(e, k, Object.assign({}, this._attrNS[k]));
    // HTML "cloning steps" copy the element's is value (a customized built-in stays
    // one after clone — Node-cloneNode-customized-builtins). It's an internal slot,
    // separate from any `is` content attribute (already carried in the copied _attrs).
    if (this._isValue != null) e._isValue = this._isValue;
    // DOM "clone a node" copies the custom-element-registry association: a sticky
    // null (customelementregistry attribute) and a pinned scoped registry both
    // travel; the unset document-tracking state stays unset.
    if (this._ceRegistry !== undefined) e._ceRegistry = this._ceRegistry;

    // A cloned <script> inherits the original's "already started" flag (HTML
    // "the cloning steps for script elements"). So a clone of a script that has
    // already run does NOT execute again when inserted. Without this, deep-
    // cloning a subtree that contains an already-run inline <script> and
    // inserting the clone re-runs it — and when that script is the page's own
    // code (`new Document().appendChild(documentElement.cloneNode(true))`), it
    // re-runs unboundedly (stack overflow → OOM).
    if (this._tag === 'script' && this._csimRan) e._csimRan = true;
    // HTML input/textarea "cloning steps": carry the live value (set iff the
    // dirty value flag is set), the dirty checkedness, and indeterminateness.
    // NOT the selection — the cloning steps don't copy it, and a fresh clone must
    // start with the default selection (textfieldselection/select-event relies on this).
    if (this._tag === 'input' || this._tag === 'textarea') {
      if (this._value !== undefined)            e._value = this._value;
      if (this._checkedness !== undefined)      e._checkedness = this._checkedness;
      if (hasState(this, STATE_INDETERMINATE))                  setStateBit(e, STATE_INDETERMINATE, hasState(this, STATE_INDETERMINATE));
    }
    // The copied `_attrs` carry any inline `on…="…"` source, but a handler's
    // registered listener + slot are instance-specific — re-activate them on the
    // clone so its inline handlers fire. The `on` prefix is checked inline so a
    // non-handler attribute skips the call entirely; `fromClone` keeps a cloned
    // <body>/<frameset> from overwriting the live window handler.
    for (const k in e._attrs) {
      if (k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110) syncInlineEventHandler(e, k, e._attrs[k], true);
    }
    return e;
  }
  // The element states no attribute records live in the `_csimState` bits, and every write mirrors into the arena
  // (setElementState) — so however many places assign one, the native matcher sees it. The flags are read and set
  // through `hasState` / `setStateBit` (no property a component's own `_modal` or `_filtered` could collide with);
  // checkedness and selectedness keep their accessors, and so does the live value, which is a string. Checkedness is
  // `undefined` while clean (the `checked` attribute stands for it) and a boolean once dirty.
  get _checkedness() {
    const s = this._csimState;
    return s & STATE_CHECKED_DIRTY ? (s & STATE_CHECKED) !== 0 : undefined;
  }
  set _checkedness(v) {
    setElementState(this, STATE_CHECKED_DIRTY | STATE_CHECKED, v === undefined ? 0 : v ? STATE_CHECKED_DIRTY | STATE_CHECKED : STATE_CHECKED_DIRTY);
  }
  get _selectedness()   { return (this._csimState & STATE_SELECTED) !== 0; }
  set _selectedness(v)  { setElementState(this, STATE_SELECTED, v ? STATE_SELECTED : 0); }
  // …the `is` value it was created with (createElement's option, a parsed or cloned customized built-in's)…
  get _isValue()  { return this.__isValue; }
  set _isValue(v) {
    this.__isValue = v;
    setElementState(this, STATE_IS_VALUE, v != null ? STATE_IS_VALUE : 0);
    setIsValueOf(this, v);
  }
  // …a `<template>`'s contents (the fragment `content` is), which serializing it writes…
  get _templateContent()  { return this.__templateContent; }
  set _templateContent(v) {
    this.__templateContent = v;
    linkTemplateContent(this, v);
  }
  // …a file input's selected files (whether it has any is constraint validation's)…
  get _files()  { return this.__files; }
  set _files(v) {
    this.__files = v;
    setStateBit(this, STATE_HAS_FILES, v != null && v.length > 0);
  }
  // …and a form control's live value, `undefined` while clean (form-helpers.js `controlLiveValue`).
  get _value()  { return this.__value; }
  set _value(v) {
    if (v === this.__value) return;
    this.__value = v;
    setElementValue(this, v);
  }

  // tagName / nodeName: the qualified name, ASCII-uppercased only for an
  // HTML-namespace element whose node document is an HTML document (so an
  // element in an XML/XHTML iframe document keeps its case).
  get _nodeName() {
    const qn = this._prefix ? this._prefix + ':' + this._localName : this._localName;
    return (this._ns === HTML_NS && isHtmlDocument(this.ownerDocument)) ? asciiUpper(qn) : qn;
  }
  // `shadowRootAdoptedStyleSheets` is a plain DOMString reflection of the
  // `shadowrootadoptedstylesheets` content attribute (a space-separated list of
  // import-map specifiers the parser resolves into the declarative shadow root's
  // adoptedStyleSheets). [Reflect] for DOMString: no whitespace normalization, no
  // lazy attribute creation, '' when absent — so present-empty vs absent is told
  // apart via getAttribute()/hasAttribute(), not the IDL getter.
  get shadowRootAdoptedStyleSheets() {
    if (this._tag !== 'template') return undefined;
    const v = this._attrs.shadowrootadoptedstylesheets;
    return v == null ? '' : String(v);
  }
  set shadowRootAdoptedStyleSheets(v) {
    if (this._tag !== 'template') return;
    this._setAttribute('shadowrootadoptedstylesheets', String(v));
  }
  // The CSSStyleSheet of the engine sheet `made` (cascade.js `engineSheetOf`): the one this owner has while that is the
  // same sheet, a new one once it was made again — a new block, the owner inserted again — whose predecessor no longer
  // has an owner (CSSOM: the old sheet is removed from the document).
  _sheetOf(made, fields) {
    if (this._sheet && slotsOf(this._sheet, 'CSSStyleSheet').id === made.id && this._sheetRev === made.rev) return this._sheet;
    this._dropSheet();
    this._sheet = ownedStyleSheet(made.id, this, fields);
    this._sheetRev = made.rev;
    made.shown = true;
    globalThis.__csimOwnedSheets = (globalThis.__csimOwnedSheets | 0) + 1;
    globalThis.__csimStampFaceKeys?.(this, this._sheet);
    return this._sheet;
  }
  _dropSheet() {
    if (this._sheet) slotsOf(this._sheet, 'CSSStyleSheet').ownerNode = null;
    this._sheet = null;
    return null;
  }
  // Tear down this frame's current browsing context and re-navigate it: drop the
  // cached realm/window, dispose the old realm (fires beforeunload), clear the
  // load once-guard, and re-fire the nested document's `load` (the new content
  // loads lazily on next access). Shared by the src/srcdoc-reassignment path and
  // `_reloadFrame()`. `navContent` (a {url, bytes, contentType}) preloads the
  // document — used by reload to reuse a blob:'s retained bytes; null means
  // rebuild from the current src/srcdoc.
  _renavigateFrameDocument(navContent, isReload = false) {
    const oldRealmId = this._frameRealmId;
    this._frameWindow      = null;
    this._frameRealmId     = null;   // re-navigation rebuilds the realm
    this._frameNavContent  = navContent || null;
    this._frameNavPending  = false;
    // Set the reload-navigation intent atomically with the re-navigation, so a FRESH nav
    // (a src/srcdoc change) resets it to false and a reload superseded before its build can't
    // leak isReloadNavigation=true onto the superseding navigation.
    this._frameReloadNav   = isReload;
    disposeFrameRealmForNav(oldRealmId);
    this._frameLoadFired   = false;
    if (!isConnected(this) || !globalThis.__csim_onFrameSrcAssigned) return;
    // Navigating from inside this frame's own `load` dispatch: the build waits for a task
    // (HTML navigates asynchronously; see `maybeFireFrameLoad`). One task per element — a
    // handler that reassigns twice gets one build of the LAST value, as the setter already
    // superseded the earlier one. The task sits a nested-timer clamp (4 ms of virtual time)
    // away, not 0: a handler that re-navigates on EVERY load is a self-rescheduling loop,
    // and at 0 ms the virtual clock would run it to the per-frame iteration cap.
    if (this._frameLoadDispatching) {
      if (this._frameNavTask) return;
      this._frameNavTask = true;
      queueTask(() => {
        this._frameNavTask = false;
        if (isConnected(this) && !this._frameLoadFired && globalThis.__csim_onFrameSrcAssigned) globalThis.__csim_onFrameSrcAssigned(this);
      }, 4);
      return;
    }
    globalThis.__csim_onFrameSrcAssigned(this);
  }
  // HTML "reload": re-navigate this nested browsing context to its CURRENT
  // document (same URL — unlike a src change). `location.reload()` in a frame
  // realm routes here (via __csimReloadFrameByRealm) so it runs in the owning
  // realm, never disposing the child realm while its own reload() is on the
  // stack. A blob: frame reuses the bytes retained at build (`_frameLoadedContent`)
  // so reload still works after the blob URL was revoked (HTML keeps the blob
  // alive for the loaded document's lifetime); other sources re-resolve from src.
  _reloadFrame() {
    if (this._tag !== 'iframe' && this._tag !== 'frame') return;
    // Mark the imminent rebuild as a RELOAD navigation (isReload=true) so a controlling
    // service worker's fetch event sees `request.isReloadNavigation === true` (consumed +
    // cleared in __csimFrameWindow). Both location.reload() and history.go(0) route here.
    this._renavigateFrameDocument(this._frameLoadedContent || null, true);
  }
  get _ownerDocument(){ return this._ownerDoc || globalThis.document; }
  // Element's attribute steps (DOM §4.9), what its members and the driver's own code call: names and values strings.
  _getAttribute(name) {
    if (!this._attrNS) { const v = this._attrs[attrKey(this, name)]; return v != null ? v : null; }   // key === qualified name
    const k = firstAttrKeyByQName(this, name);
    return k != null ? this._attrs[k] : null;
  }
  // (…a value of any type its string: the driver's own callers pass numbers)
  _setAttribute(name, value) {
    if (!isValidAttributeLocalName(name)) {
      throw new globalThis.DOMException("'" + name + "' is not a valid attribute name.", "InvalidCharacterError");
    }
    // setAttribute targets the FIRST attribute with this qualified name — a namespaced one under its qualified name or a
    // synthetic key included, whose value alone changes (its namespace stays) — and appends a new one otherwise.
    const n = qnameKey(this, name) ?? attrKey(this, name);
    const old = this._attrs[n];
    const next = String(value);
    const pre = beforeAttributeChange(this, n);
    this._attrs[n] = next;
    handleAttributeChanges(this, n, old, next, pre);
  }
  // Namespaced attributes: validate-and-extract the (namespace, prefix,
  // localName), key the flat store on the qualified name, and remember the
  // namespace metadata in `_attrNS` (sparse — only namespaced/prefixed attrs).
  // getAttributeNS / hasAttributeNS / removeAttributeNS match on
  // (namespace, localName), case-sensitively, per spec.
  _setAttributeNS(namespace, qualifiedName, value) {
    const { namespace: rns, prefix, localName } = validateAndExtract(namespace, qualifiedName, 'attribute');
    const qn  = prefix ? prefix + ':' + localName : localName;
    // Replace an existing (ns, localName); otherwise a fresh key — the qualified
    // name when free, else a synthetic collision key so a same-qualified-name
    // attribute in a different namespace coexists instead of overwriting.
    const existing = this._attrKeyByNS(rns, localName);
    const key = existing != null ? existing : freshAttrKey(this, qn, rns !== null && prefix === null);
    const old = this._attrs[key];
    const next = String(value);
    const pre = beforeAttributeChange(this, key);
    this._attrs[key] = next;
    // A NEW attribute records its namespace / prefix when it has either, or when its key is a synthetic collision
    // key (key !== qn) — a null-namespace attribute parked under one still needs _attrNS so attrQName /
    // _attrKeyByNS can recover its qualified name. An EXISTING one changes its value only (DOM "set an attribute
    // value"): `setAttributeNS(XLINK, 'xlink:href', …)` over an unprefixed XLink `href` leaves it named `href`.
    if (existing == null) setAttrMeta(this, key, rns !== null || prefix !== null || key !== qn ? { ns: rns, prefix, localName } : null);
    // A null-namespace attribute set here takes the same steps as one set by `setAttribute` (form named access, an
    // `on…` handler, an input's type change); a namespaced one only the steps that name it (an SVG <image>'s
    // `xlink:href`).
    handleAttributeChanges(this, key, old, next, pre);
  }
  // "set an attribute value" (DOM) with a null namespace and verbatim local name
  // — distinct from setAttribute, which matches the first attribute by QUALIFIED
  // name (so it would update a same-named attribute in ANOTHER namespace). The
  // dataset setter uses this so `el.dataset.x = …` sets the null-namespace
  // `data-x`, leaving a `setAttributeNS(ns, 'data-x')` attribute untouched. The
  // local name is NOT colon-split (a `data-a:b` name is a valid attribute, not a
  // prefix:local pair). Only reached when `_attrNS` exists (a namespaced
  // attribute is present); the common dataset path stays on setAttribute.
  _setAttrValueNullNS(localName, value) {
    const ln = String(localName);
    if (!isValidAttributeLocalName(ln)) {
      throw new globalThis.DOMException("'" + ln + "' is not a valid attribute name.", "InvalidCharacterError");
    }
    const existing = this._attrKeyByNS(null, ln);
    const key = existing != null ? existing : freshAttrKey(this, ln);
    const old = this._attrs[key];
    const next = String(value);
    this._attrs[key] = next;
    // A fresh attribute parked under a synthetic collision key needs an `_attrNS`
    // entry so attrQName / _attrKeyByNS recover its (null) namespace + name.
    if (key !== ln) setAttrMeta(this, key, { ns: null, prefix: null, localName: ln });
    handleAttributeChanges(this, key, old, next, null);
  }
  // The stored key of the attribute matching (namespace, localName), or null.
  _attrKeyByNS(ns, localName) {
    const wantNs = ns === '' ? null : ns;
    // Fast path: with no namespaced attributes, an attribute matches only when
    // the wanted namespace is null and the localName is a plain store key.
    if (!this._attrNS) {
      return (wantNs === null && Object.prototype.hasOwnProperty.call(this._attrs, localName)) ? localName : null;
    }
    for (const key in this._attrs) {
      const meta = this._attrNS && this._attrNS[key];
      const aNs  = meta ? meta.ns : null;
      const aLn  = meta ? meta.localName : key;
      if (aNs === wantNs && aLn === localName) return key;
    }
    return null;
  }
  _getAttributeNS(namespace, localName) {
    const key = this._attrKeyByNS(namespace, localName);
    return key == null ? null : this._attrs[key];
  }
  _removeAttributeNS(namespace, localName) {
    const key = this._attrKeyByNS(namespace, localName);
    if (key != null) this._removeAttrKey(key);
  }
  _removeAttribute(name) {
    // The first attribute with this qualified name, whatever its namespace.
    const k = qnameKey(this, name);
    if (k != null) { this._removeAttrKey(k); return; }
    const key = attrKey(this, name);
    // No such attribute — and still an "unset" of the ARIA element reference and of an enumerated ARIA
    // IDL-set-to-null marker (the removal steps do both when there was one): the getters fall back to the
    // missing-value default. The IDL null setter re-adds the marker AFTER this.
    if (this._attrElements && ARIA_ATTR_TO_SLOT[key]) __ariaClearSlot(this, ARIA_ATTR_TO_SLOT[key]);
    if (this._ariaNull) this._ariaNull.delete(key);
  }
  // Stable, live Attr node for the attribute stored under `key`. Cached on
  // the element so `getAttributeNode` returns the same identity each call.
  _attrNodeFor(key) {
    const cache = this._attrNodes || (this._attrNodes = {});
    let a = cache[key];
    if (!a) {
      const meta = this._attrNS && this._attrNS[key];
      a = new Attr(PLATFORM, meta ? meta.localName : key, meta ? meta.ns : null,
                   meta ? meta.prefix : null, this._attrs[key], this.ownerDocument);
      a._ownerElement = this;
      a._key = key;
      cache[key] = a;
    }
    return a;
  }
  // Low-level store write used by a bound Attr's `value` setter (keeps the
  // mutation-record / attributeChangedCallback side effects of setAttribute).
  _setAttrNodeValue(key, value) {
    const old = this._attrs[key];
    const pre = beforeAttributeChange(this, key);
    this._attrs[key] = value;
    handleAttributeChanges(this, key, old, value, pre);
  }
  // Detach the cached Attr node (if any) at `key`: snapshot its value and
  // sever the owner link so a held reference reads its last value and a null
  // owner, per the DOM "remove an attribute" steps.
  _detachAttrNode(key) {
    const a = this._attrNodes && this._attrNodes[key];
    if (!a) return;
    a._value = this._attrs[key];
    a._ownerElement = null;
    a._key = null;
    delete this._attrNodes[key];
  }
  // Bind a detached Attr into this element's store (setAttributeNode).
  _bindAttrNode(attr) {
    const hasNs = attr._ns != null || attr._prefix != null;
    const qn = attrQualifiedName(attr);
    // Same collision-safe keying as setAttributeNS: replace a matching (ns,
    // localName), else a fresh (possibly synthetic) key. A non-namespaced attr
    // keys by its name as it is — DOM's setAttributeNode lowercases nothing
    // (createAttribute already did, in an HTML document): same name = same attr.
    const key = hasNs ? (this._attrKeyByNS(attr._ns, attr._localName) || freshAttrKey(this, qn, attr._ns != null && attr._prefix == null)) : qn;
    const old = this._attrs[key];
    const pre = hasNs ? null : beforeAttributeChange(this, key);
    this._attrs[key] = attr._value;
    setAttrMeta(this, key, hasNs ? { ns: attr._ns, prefix: attr._prefix, localName: attr._localName } : null);
    attr._ownerElement = this;
    attr._key = key;
    (this._attrNodes || (this._attrNodes = {}))[key] = attr;
    handleAttributeChanges(this, key, old, attr._value, pre);
  }
  // Remove the attribute stored under the exact key `n` (no re-keying).
  _removeAttrKey(n) {
    if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
    const old = this._attrs[n];
    // Capture the namespaced metadata before it's deleted below — the removal
    // MutationRecord and the steps need the attribute's localName + namespace.
    const meta = (this._attrNS && this._attrNS[n]) || null;
    const pre = beforeAttributeChange(this, n);
    this._detachAttrNode(n);
    delete this._attrs[n];
    if (this._attrNS) delete this._attrNS[n];
    handleAttributeChanges(this, n, old, null, pre, meta);
  }
  _hasAttribute(name) {
    return qnameKey(this, name) != null;
  }


  // HTML "the directionality" of this element → 'ltr' | 'rtl' — the arena's (element_state.rs `is_rtl`), what `:dir()`
  // matches: its own `dir` (`auto`, and a bare `<bdi>`, by the first strong character of its text or a text
  // control's value), else its shadow-including parent's, ltr at the root. (`dirname` submits it.)
  _directionality() {
    return isRtl(this) ? 'rtl' : 'ltr';
  }
  // Common HTMLElement / form-control IDL attributes that mirror to
  // their named attributes. jQuery 3.x's `.serialize()` filter keys
  // on `this.name` / `this.type`; without these getters the filter
  // rejects every form element (`.name` undefined → falsy → skip).
  // Mirrors HTML spec's reflection rules: read returns the attribute
  // value (or '' if absent), write goes through setAttribute so
  // MutationObserver / attributeChangedCallback see the change.
  // `name` reflects only on the name-bearing elements (form controls, iframe, img,
  // object, a, map, meta, param, slot, …) — handled by the data-driven reflection
  // installer (REFLECT_STRING_TABLE), which tag-gates it and falls back to a plain
  // expando on other elements (so `div.name = x` doesn't touch the content attribute,
  // per html/dom/elements/name-content-attribute-and-property.html).
  get type()  {
    // `<input>.type` is an enumerated attribute limited to known values; an
    // absent or invalid value canonicalizes to 'text' (spec).
    if (this._tag === 'input') {
      return enumReflectGet(this._attrs.type, ENUM_INPUT_TYPE, 'text', 'text');
    }
    // `<button>.type` likewise canonicalizes to 'submit'.
    if (this._tag === 'button') {
      return enumReflectGet(this._attrs.type, ENUM_BUTTON_TYPE, 'submit', 'submit');
    }
    // `<select>.type` is `'select-multiple'` when the multiple attr
    // is set, otherwise `'select-one'`. jQuery's `.val()` for a
    // select branches on this string; without the override it read
    // `''`, which doesn't equal `'select-one'`, so jQuery walked
    // every option as if multi-select and tripped over `null.value`.
    if (this._tag === 'select') {
      return this._attrs.multiple != null ? 'select-multiple' : 'select-one';
    }
    // Constant-type elements: fieldset / output / textarea reflect their tag name.
    if (this._tag === 'fieldset') return 'fieldset';
    if (this._tag === 'output')   return 'output';
    if (this._tag === 'textarea') return 'textarea';
    // Everything else (link/style/script/object/a/…) reflects
    // `type` as a plain DOMString.
    return this._attrs.type != null ? this._attrs.type : '';
  }
  set type(v) {
    // Reflect to the `type` content attribute; the HTML "input type change" steps
    // (value-mode migration, re-sanitize, selection/radio-group reset) run from
    // setAttribute so this IDL path and a framework's setAttribute('type', …) path
    // behave identically. See `applyInputTypeChange`.
    this._setAttribute('type', String(v));
  }
  // `<select>.options` — a live, [SameObject] HTMLOptionsCollection: indexed
  // get AND set (`opts[i] = option|null`), `length` get/set, `add` / `remove` /
  // `item` / `namedItem` / `selectedIndex`, iterable. jQuery's `.val()` reads it
  // by index; Avo's `city-in-country` does `options.remove(0)` to rebuild after a
  // country change.
  get options() {
    if (this._tag === 'select') {
      return this._optionsColl ||
        (this._optionsColl = liveOptionsCollection(this, () => listOfOptions(this)));
    }
    return undefined;
  }
  // HTMLSelectElement.add(option, before?) / HTMLOptionsCollection.add —
  // `before` may be a numeric index into the list of options or the reference
  // element itself. Per the HTMLOptionsCollection.add steps, the element is
  // pre-inserted into the REFERENCE node's parent before the reference (the
  // <optgroup> when the reference option is nested), not unconditionally into
  // the <select>; a null / out-of-range `before` appends to the select.
  add(element, before) {
    if (this._tag !== 'select') return;
    let reference = null;
    if (typeof before === 'number') {
      reference = listOfOptions(this)[before] || null;
    } else if (before != null) {
      // A non-null node `before` must be a descendant of this select, else
      // NotFoundError (HTMLOptionsCollection.add step 2). Without this guard the
      // `reference._parent` insert below would silently graft `element` into a
      // FOREIGN select/optgroup that the reference happens to live in.
      if (!nodeContains(this, before) || before === this) {
        throw new globalThis.DOMException(
          'The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
      }
      reference = before;
    }
    // reference._parent is the <optgroup> for a nested option, the <select> for
    // a direct child — so the common (no-optgroup) case is unchanged.
    const parent = reference != null ? reference._parent : this;
    (parent || this)._insertBefore(element, reference);
  }
  // HTMLSelectElement supports indexed properties (its options), so per WebIDL
  // it is iterable: `@@iterator` is the values iterator over the options. The
  // `sequence<BlobPart>` conversion in `new Blob(select)` walks this. A non-
  // select element has NO `@@iterator` (`new Blob(div)` must throw TypeError),
  // so this is a tag-aware getter returning the shared factory only for
  // `<select>` — never an unconditional prototype method. Indexed access
  // (`select[0]`) is deliberately NOT synthesised: it would force a Proxy on
  // every element (rule 3 — the hottest object), and nothing here needs it.
  get [Symbol.iterator]() {
    return this._tag === 'select' ? selectValuesIterator : undefined;
  }

  // HTMLFormElement.elements (a live [SameObject] HTMLFormControlsCollection) /
  // HTMLFieldSetElement.elements (a live HTMLCollection). jQuery's `.serialize()`
  // reads form.elements (Redmine's context-menu AJAX depends on it). The list is
  // the LISTED elements (button/fieldset/input/object/output/select/textarea),
  // EXCLUDING input[type=image] — for a form, the controls whose form owner is
  // this form (so `form=`-associated controls outside the subtree count, same
  // shadow tree); for a fieldset, its listed-element descendants. The collection
  // is cached so `form.elements === form.elements` ([SameObject]).
  get elements() {
    if (this._tag === 'form') {
      return this._elementsColl ||
        (this._elementsColl = liveFormControlsCollection(() => formControlElements(this)));
    }
    if (this._tag === 'fieldset') {
      return this._elementsColl ||
        (this._elementsColl = liveHTMLCollection(() => fieldsetControlElements(this)));
    }
    return undefined;
  }
  // `HTMLButtonElement.form` (and the IDL for all form-associated
  // controls) — returns the owning form. Per spec the `form="<id>"`
  // attribute takes precedence over the ancestor `<form>`; we
  // mirror that. Redmine's settings page uses
  // `onclick="moveOptions(this.form.selected_..., this.form.
  // available_...)"` to wire up its column-mover buttons — without
  // `this.form` the onclick threw and the columns never moved.
  get form() {
    // HTMLOptionElement.form: the form owner of the <select> the option belongs to
    // (option is NOT itself form-associated), else null. The option belongs to a
    // select only when it is in that select's "list of options" — reachable up the
    // ancestor chain through transparent wrappers (a customizable-select <div>) and
    // at most one <optgroup>, but NOT across an <option> / <datalist> / <hr> / a
    // nested <optgroup> (those break the association → null).
    if (this._tag === 'option') {
      let cur = this._parent, crossedOptgroup = false, sel = null;
      while (cur) {
        const t = cur._tag;
        if (t === 'select') { sel = cur; break; }
        if (t === 'option' || t === 'datalist' || t === 'hr') break;
        if (t === 'optgroup') { if (crossedOptgroup) break; crossedOptgroup = true; }
        cur = cur._parent;
      }
      return sel ? (formForControl(sel) || null) : null;
    }
    if (!FORM_ASSOCIATED_TAGS.has(this._tag)) return undefined;
    // formForControl returns the form's Proxy (the canonical form, see
    // FORM_HANDLER) — so `el.form === form` holds and `el.form.<control-name>`
    // resolves through the Proxy's named getter.
    return formForControl(this) || null;
  }
  // Form-control IDL attributes — expose the pair-of-attr-and-IDL
  // shape so JS like `input.value = 'x'` / `input.checked = true`
  // works and reads back via `globalThis.__csimValue` / serialised attrs alike.
  get value() {
    // `<input type=file>.value` is, for historical reasons, the first file's
    // name prefixed with the fake path `C:\fakepath\` (or '' when empty) — the
    // real filename is exposed through `.files[0].name`.
    if (this._tag === 'input' && (this._attrs.type || '').toLowerCase() === 'file') {
      const f = (this._files || [])[0];
      return f && f.name != null ? 'C:\\fakepath\\' + f.name : '';
    }
    // `<select>.value` is the value of the first selected option. Library handlers
    // (Redmine's `updateIssueFrom` posts `$('#issue-form').serialize()` which reads
    // the IDL value, jQuery's `.val()` falls through to this getter for selects) all
    // expect this resolution rather than `_attrs.value`.
    if (this._tag === 'select') {
      const opts = listOfOptions(this);
      // HTMLSelectElement.value is ALWAYS a DOMString — the first selected option's
      // value (or '' when none), even for a `multiple` select (an array would be a
      // jQuery-ism, not the IDL; Capybara's multi-select read uses __csimValue,
      // which keeps its own array form).
      // The value is the first selected option's value, or '' when none is
      // selected (e.g. after selectedIndex = -1). The single-select "first
      // option selected by default" rule is materialised into selectedness by
      // runSelectednessAlgorithm, so a default select still finds it here.
      for (const o of opts) {
        if (o._selectedness === true) return o.value;
      }
      return '';
    }
    if (this._tag === 'textarea') {
      // HTML spec: `<textarea>.value` returns the "raw value". When the dirty
      // value flag is set (`_value` defined — a `set`/typing/setRangeText edit)
      // it's the live value; otherwise it's the element's child text content (the
      // default). The "first newline removal" rule (dropping one leading line
      // terminator) is a PARSE-time operation, so the DOM text node already lacks
      // it — both the main-document parser and the fragment parser
      // (`stripFirstNewline`) strip it at build time. Reading textContent verbatim
      // here is therefore correct; re-stripping would double-strip a parsed
      // textarea (`\n\nx` → `x` instead of `\nx`). Avo's KeyValueField stores a
      // JSON blob in a hidden <textarea> and parses it on Stimulus connect — its
      // value has no leading newline, so textContent is exactly the stored blob.
      return controlLiveValue(this);
    }
    // `<option>.value` (HTMLOptionElement): the NULL-NAMESPACE `value` content
    // attribute if present, else the option's `text` IDL (its collapsed/trimmed
    // descendant text). getAttributeNS(null,…) — not `_attrs.value` — so a
    // `setAttributeNS(ns,'value',…)` (a different attribute) is ignored, matching
    // `option.label`. namedItem / option-list reads depend on the text fallback.
    if (this._tag === 'option') {
      const v = this._getAttributeNS(null, 'value');
      return v != null ? v : this.text;
    }
    // checkbox / radio are in the "default/on" value mode: the IDL value is the
    // `value` content attribute (NOT a dirty live value — those types aren't
    // value-dirtied), or 'on' when the attribute is absent or empty.
    if (this._tag === 'input') {
      const t = this.type;
      if (t === 'checkbox' || t === 'radio') {
        return this._attrs.value != null && this._attrs.value !== '' ? this._attrs.value : 'on';
      }
      // The IDL value is the SANITIZED live value run through the per-type
      // value-sanitization algorithm. The live value is `_value` when the dirty
      // value flag is set, else the `value` content attribute (the default). The
      // raw content attribute stays in `_attrs.value` / `getAttribute('value')` —
      // only the IDL `.value` is sanitized. So a parse-time `value="2013-13"` on a
      // month input, or whitespace on a range, reads back '' / the default just
      // like an IDL set would: the parser writes `_attrs` directly (clean), so
      // this is where a parsed value gets cleaned on read.
      // For a number field that the USER has typed into: a VALID floating-point
      // number is returned verbatim (Chrome preserves the typed text — "001.50",
      // "1e2", "1.0", "-0" are NOT canonicalised). An editing intermediate that is
      // not itself valid but still converts ("1." → 1) shows its number; text that
      // doesn't convert ("1.e") shows "" (with badInput set in the validity getter).
      // A clean / programmatically-set value uses the strict sanitizer below.
      if (t === 'number' && hasState(this, STATE_DIRTY_BY_USER)) return globalThis.__dom.inputTypedNumber(controlLiveValue(this));
      return sanitizedValueOf(this, t, controlLiveValue(this));
    }
    // `<output>.value` is its descendant text content (the getter doesn't depend on
    // the value-mode flag — only `defaultValue` does). Setting it switches to value
    // mode (see the setter).
    if (this._tag === 'output') return this.textContent;
    return this._attrs.value != null ? this._attrs.value : '';
  }
  set value(v)   {
    if (this._tag === 'input' && (this._attrs.type || '').toLowerCase() === 'file') {
      // HTML: a file input's value can only be set to the empty string (which
      // clears the selected files); any other value throws InvalidStateError.
      // [LegacyNullToEmptyString] maps only `null` → '' — `undefined` becomes the
      // string "undefined" (so it throws), hence `=== null`, not `== null`.
      if ((v === null ? '' : String(v)) !== '') {
        throw new globalThis.DOMException(
          "Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename, which may only be programmatically set to the empty string.",
          'InvalidStateError'
        );
      }
      this._files = [];
      return;
    }
    if (this._tag === 'select') {
      const target = String(v == null ? '' : v);
      const opts = listOfOptions(this);
      // HTML: setting `select.value` sets the selectedness of the first
      // option whose value matches and clears every other, mirroring a
      // user pick rather than touching the `selected` content attribute.
      let matched = false;
      for (const o of opts) {
        ensureOptionSelInit(o);
        if (!matched && o.value === target) { matched = true; setSelectedness(o, true); o._dirtySel = true; }
        else setSelectedness(o, false);
      }
      // No matching option ⇒ every option ends up deselected (HTML: value reads
      // back as '' / selectedIndex -1). NOT re-defaulted to the first option —
      // that matches Chrome and keeps `value` consistent with `selectedIndex =
      // -1`.
      bumpSettleGen();   // selectedness changed: invalidate :checked/:selected memos + settle key
      // Unconditional (not flag-gated): a value change is a user/script action,
      // not a hot path, and must update even a DETACHED select whose
      // <selectedcontent> was appended without a connect/finalize pass.
      updateSelectedContent(this);
      return;
    }
    // `<output>.value` setter: set the value mode flag to "value" and replace the
    // descendant text content. The default value (stored separately) is untouched,
    // so a later form reset restores it.
    if (this._tag === 'output') {
      // Flipping default → value freezes the current default value (the descendant
      // text the element had) so defaultValue / reset can restore it.
      if (this._outputValueMode !== 'value') this._outputDefault = this.textContent;
      this._outputValueMode = 'value';
      this.textContent = v == null ? '' : String(v);
      return;
    }
    // The `value` IDL setter behaves by the type's value mode: a "value"-mode
    // control (every text-like input + <textarea>) stores a live value and sets
    // the dirty value flag; a "default" / "default/on" control (hidden, submit,
    // reset, button, image, checkbox, radio) reflects the `value` content
    // attribute; <option> etc. likewise reflect the attribute.
    const usesLiveValue = this._tag === 'textarea' ||
      (this._tag === 'input' && inputValueMode(this.type) === 'value');
    if (usesLiveValue) {
      // Snapshot the live value before the write — the cursor only moves to the
      // end when the value actually CHANGES (see below).
      const oldSelVal = this.value;
      // [LegacyNullToEmptyString]: null → "". Set the dirty value flag by
      // storing the live value in `_value` — the `value` content attribute (the
      // default) is left untouched, so `getAttribute('value')`/`defaultValue`
      // keep reporting it and `<form>.reset()` restores it. Value sanitization /
      // normalization on set: input runs the per-type algorithm; textarea
      // normalizes newlines (CRLF / CR → LF).
      let sv = v === null ? '' : String(v);
      sv = this._tag === 'input' ? sanitizedValueOf(this, this.type, sv) : sv.replace(/\r\n?/g, '\n');
      const valueChanged = setControlLiveValue(this, sv);
      // A programmatic value set is NOT a user edit — clear the flag so
      // tooLong/tooShort (which apply only to user edits) stop suffering.
      setStateBit(this, STATE_DIRTY_BY_USER, false);
      // A programmatic set is NOT a user edit, so it does NOT set _editedSinceFocus
      // — the control therefore won't fire `change` on the next blur (only a user
      // edit since focus does). The baseline is left at the focus value on purpose.
      // HTML "set the value": only when the new value DIFFERS from the old does
      // the text entry cursor move to the end (selectionStart = selectionEnd =
      // length, direction 'none') — setting the same value leaves the selection
      // untouched, no `select` event. This runs for every text control (the
      // internal caret matters even for non-selectable types, e.g. the typing
      // position in a number field); a stale offset surfacing once the type
      // becomes selectable is handled by the reset in `set type`.
      if (sv !== oldSelVal) moveTextEntryCursor(this, sv.length);
    } else {
      // "default" / "default/on" input modes (checkbox / radio / hidden / submit
      // / …), <button>, <option>, and the like: `value` is a reflected
      // `[CEReactions] DOMString` — so route through setAttribute (not a raw
      // `_attrs.value` write) so it records a MutationObserver `attributes` entry
      // and enqueues the attributeChanged reaction for a customized built-in
      // (`<button is>`). Plain DOMString (null → "null", undefined → "undefined").
      this._setAttribute('value', String(v));
    }
    // A filter combobox re-filters its associated <select>/<datalist> on every value
    // change (programmatic or typed) — `filter=` / `list=` are the tentative opt-in.
    if (this._tag === 'input' && (this._attrs.filter != null || this._attrs.list != null)) runComboboxFilter(this);
  }
  // `<option>.selected` IDL — reads/writes the internal *selectedness*
  // (`_selectedness`), NOT the `selected` content attribute (that is
  // `defaultSelected`). jQuery's `.val()` over a `<select>` walks the
  // options checking each `.selected`; Redmine's onchange handlers
  // probe selection after manual `select` calls.
  get selected() {
    if (this._tag !== 'option') return false;
    // Lazy-init so a parsed `<option selected>` read before it is ever
    // connected to a select (DOMParser / detached fragment) still reports
    // its authored default, matching real browsers. O(1) after first read.
    ensureOptionSelInit(this);
    return this._selectedness === true;
  }
  set selected(v) {
    if (this._tag !== 'option') return;
    const next = !!v;
    const changed = (this._selectedness === true) !== next;
    // IDL setter sets the dirtiness flag so later content-attribute
    // changes no longer drive selectedness (HTML spec).
    this._dirtySel = true;
    setSelectedness(this, next);
    // Setting `selected = true` on an option in a single-select clears
    // selectedness from the others; setting false can drop the select
    // to zero selected, so re-run the algorithm (picks a new default).
    // Redmine's `selectTracker` sets `prop('selected', true)` and
    // expects the previously-selected option to lose `.value`.
    askForReset(this);
    // Selectedness drives `:checked`/`:selected`/visible_text; bump the
    // settle generation those memos + settle key on (see `set checked`).
    if (changed) bumpSettleGen();
  }
  // `<option>.defaultSelected` IDL — reflects the `selected` content
  // attribute (the authored default, restored by `<form>.reset()`).
  get defaultSelected() {
    if (this._tag !== 'option') return false;
    return this._attrs.selected != null;
  }
  set defaultSelected(v) {
    if (this._tag !== 'option') return;
    if (v) this._setAttribute('selected', ''); else this._removeAttribute('selected');
  }
  // `<select>.selectedIndex` — the index of the first option whose selectedness
  // is true, or -1 if none. The single-select "first option is selected by
  // default" rule is materialised by runSelectednessAlgorithm (so a default
  // select has a real selectedness here); an explicit `selectedIndex = -1`
  // clears all selectedness and is NOT re-defaulted, so it reads back as -1.
  get selectedIndex() {
    if (this._tag !== 'select') return -1;
    const opts = listOfOptions(this);
    for (let i = 0; i < opts.length; i++) {
      if (opts[i]._selectedness === true) return i;
    }
    return -1;
  }
  set selectedIndex(v) {
    if (this._tag !== 'select') return;
    const idx = v | 0;   // WebIDL `long`: NaN / undefined / non-numeric → 0
    const opts = listOfOptions(this);
    // HTML: clear every option's selectedness, then select the one at the
    // given index (a dirty user-style pick). Mark `_selInit` so a later
    // ensureOptionSelInit can't re-derive the cleared state from the
    // content attribute.
    // HTML: deselect every option, then select the one at `idx` if it exists.
    // An out-of-range index (including -1) leaves everything deselected and is
    // NOT re-defaulted — selectedIndex then reads back as -1. `_selInit` is set
    // so a later ensureOptionSelInit can't re-derive from the content attribute.
    for (let i = 0; i < opts.length; i++) {
      opts[i]._selInit = true;
      if (i === idx) { setSelectedness(opts[i], true); opts[i]._dirtySel = true; }
      else setSelectedness(opts[i], false);
    }
    bumpSettleGen();
    updateSelectedContent(this);   // unconditional — see the value setter
  }
  // A select's "list of options" (HTML): the option elements this select owns,
  // in tree order — the single source of truth for value / selectedIndex /
  // selectedOptions / the selectedness algorithm. NOT every descendant option
  // (one nested in a child option / hr / nested select / nested optgroup is
  // excluded). Exposed as a method so custom-elements.js can reach it without a
  // back-import (which would cycle with dom-nodes' import of that module).
  _listOfOptions() { return this._tag === 'select' ? listOfOptions(this) : []; }
  // `<select>.selectedOptions` — live [SameObject] HTMLCollection of every
  // currently-selected `<option>` descendant, in tree order. Cached on the
  // element so every access returns the SAME object (per [SameObject]); it is
  // live (the query re-runs when a selectedness change bumps the settle gen).
  // Avo's `multiple-select-filter` controller reads
  // `Array.from(selectorTarget.selectedOptions).map(...)` to build the filter
  // query; without this accessor the filter button click throws silently and
  // the URL never gains the `encoded_filters` param.
  get selectedOptions() {
    if (this._tag !== 'select') return undefined;
    if (!this._selectedOptionsColl) {
      const self = this;
      this._selectedOptionsColl = liveHTMLCollection(() =>
        listOfOptions(self).filter(o => o._selectedness === true));
    }
    return this._selectedOptionsColl;
  }
  get src()  { return reflectURLAttr(this, 'src',  SRC_REFLECTING_TAGS); }
  // Other URL-reflecting attributes — resolve against the document base on get,
  // store the stringified value on set.
  get poster()  { return reflectURLAttr(this, 'poster', POSTER_REFLECTING_TAGS); }
  set poster(v) { if (this._tag === 'video') this._setAttribute('poster', toUSVString(v)); }
  set src(v) {
    const next = toUSVString(v);
    // A reflected `[CEReactions] USVString`: route every tag through setAttribute so
    // it records a MutationObserver entry and fires attributeChanged for a customized
    // built-in (`<img is>` / `<audio|video is>`).
    // setAttribute already carries the tag-specific side effects — an `iframe`
    // re-navigation (clearing the cached contentWindow / realm, re-firing `load`) and
    // an `img`'s bitmap re-fetch (`_isImageResourceAttr`) — so they need no repeat here.
    this._setAttribute('src', next);
    // A `<video>` src assignment kicks its own pipeline (media.js); the audio
    // media-load hook lives in setAttribute itself (_loadMediaResource).
    if (this._tag === 'video' && globalThis.__csim_onVideoSrcAssigned) {
      globalThis.__csim_onVideoSrcAssigned(this, next);
    }
  }

  // The resource URL an image element fetches: an <img>'s `src`, or an SVG <image>'s
  // `href` (SVG2) falling back to the legacy XLink one (SVG1.1) — link-href.js `hrefAttr`,
  // where an empty `href` still wins, as in Chrome and Firefox. Both feed the same load path
  // so createPattern / drawImage can tell a broken href (throw) from an unavailable /
  // zero-size one (null / no-op).
  _imageResourceSrc() {
    if (this._tag === 'img') {
      // (…its picture's selected `<source>`'s candidates or its own `srcset`'s over its `src`: image_source.rs)
      const v = currentViewport();
      return imageSourceOf(this, v.width, v.height);
    }
    if (this._tag === 'image') return hrefAttr(this);
    // `<input type=image>` is an image button: its `src` is fetched like an `<img>` (its Resource
    // Timing entry's initiator is 'input', which `recordImageTiming` already reports).
    if (this._tag === 'input' && String(this._attrs.type).toLowerCase() === 'image') return this._attrs.src;
    return undefined;
  }
  // Whether attribute `name` sources this image element's bitmap — so a set / remove of it
  // (setAttribute[NS] / removeAttribute[NS]) re-runs the "update the image data" algorithm.
  // `name` is the qualified name (`xlink:href`), which is how both `_attrs` and setAttribute
  // reflect it. `crossorigin` is in the list too: changing the CORS mode re-fetches (and
  // re-evaluates canvas taint) even for an unchanged src.
  _isImageResourceAttr(name) {
    if (this._tag === 'img')   return name === 'src' || name === 'srcset' || name === 'crossorigin';
    if (this._tag === 'image') return name === 'href' || name === 'xlink:href' || name === 'crossorigin';
    if (this._tag === 'input') return name === 'src' || name === 'type' || name === 'crossorigin';
    return false;
  }
  // A media element's resource selection, MINIMALLY: in a CONTROLLED document the
  // src fetches through the service worker (destination audio/video — the fetch
  // IS the observable; fetch-destination asserts it) and a usable response fires
  // the readiness ladder to loadeddata/canplaythrough, a refused one fires
  // `error`. An UNCONTROLLED document keeps the legacy inert model (no network
  // fetch, no events) — media playback isn't modeled, and fetching every app's
  // <video src> would be pure cost (rule 3).
  _loadMediaResource() {
    if (this._tag !== 'audio' && this._tag !== 'video') return;
    const src = this._attrs.src;
    if (src == null || src === '') return;
    if (this._mediaLoadKey === src) return;
    this._mediaLoadKey = src;
    let abs = src;
    const base = this.baseURI || (globalThis.document && globalThis.document.baseURI) ||
      (globalThis.location && globalThis.location.href) || undefined;
    try { abs = new globalThis.URL(src, base).href; } catch (_) {}
    const ctrl = /^https?:/i.test(abs) &&
      globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
    if (!ctrl || typeof globalThis.__csimSWInterceptFetch !== 'function') return;
    const dest  = this._tag === 'audio' ? 'audio' : 'video';
    // `crossorigin` maps exactly like the <img> path (_imageCorsRequest).
    const {mode, credentials} = this._imageCorsRequest();
    const swReq = buildSwRequest({ mode, credentials, destination: dest });
    globalThis.__csimSWInterceptFetch(ctrl, 'GET', abs, {}, null, swReq, (resp) => {
      const fire = (type) => fireEvent(this, new Event(type));
      // fall-through (resp == null) keeps the inert legacy model — the network
      // media pipeline isn't modeled; a respondWith decides success/error.
      if (resp == null) return;
      // A media request is mode no-cors / redirect follow: opaque is fine, but an
      // opaqueredirect respondWith is a network error (same gate as the <img> path).
      if (resp.__networkError || resp.type === 'opaqueredirect' || (resp.status | 0) >= 400) { fire('error'); return; }
      fire('loadstart'); fire('loadedmetadata'); fire('loadeddata'); fire('canplay'); fire('canplaythrough');
    });
  }

  _loadImageResource() {
    if (this._tag !== 'img' && this._tag !== 'image' &&
        !(this._tag === 'input' && String(this._attrs.type).toLowerCase() === 'image')) return;
    // A realm without the host decoder wired (an early-boot / stripped build) keeps
    // the pre-feature behavior: the element stays inert (no load, no error), rather than
    // reporting every image as broken.
    if (typeof globalThis.__csim_loadImage !== 'function') return;
    const src = this._imageResourceSrc();
    if (src == null || src === '') {
      // Clearing the src discards the current request: reset to the unloaded state
      // (no bitmap, no intrinsic size) and re-arm a later assignment of any src —
      // including one previously loaded, which the idempotence guard would else skip.
      this._pixels        = null;
      this._imgRequestSrc = null;
      this._setNaturalSize(null);
      this._imgLoadKey    = undefined;
      this._imgLoadGen    = (this._imgLoadGen | 0) + 1;   // supersede any pending load's event
      this._imgComplete   = true;
      this._imgBroken     = false;   // no request → unavailable, not broken
      this._tainted       = false;   // no request → not a taint source
      return;
    }
    // A load's identity is its URL AND its CORS mode (`crossorigin`): setting `crossorigin` AFTER
    // `src` in the same task (the browser coalesces both into one deferred "update the image data"
    // run) must re-fetch under the new mode and re-evaluate taint, not be skipped as a same-src
    // no-op. The bumped `_imgLoadGen` supersedes the first (mode-stale) load's queued event, so only
    // the final load fires `load` — matching the single load a real browser dispatches.
    const loadKey = src + ' ' + (this._attrs.crossorigin == null ? '' : this._attrs.crossorigin);
    if (this._imgLoadKey === loadKey) return;   // already handled this (src, mode) — idempotent
    this._imgLoadKey = loadKey;
    this._imgLoadGen = (this._imgLoadGen | 0) + 1;
    // A controlled client's image load is a fetch (destination 'image') that reaches the
    // controlling SW's `fetch` handler first: a `respondWith` supplies the bytes, a fall-through
    // drops to the network. Only ALREADY-ABSOLUTE http(s) srcs route through the SW: a relative src
    // would need this path to also handle the redirect / `srcset` / `<picture>` cases a browser
    // pulls in there, which it doesn't yet — so those stay on the synchronous network decode rather
    // than risk a hang (a documented coverage gap, not a quirk; see the image-CORS backlog). data:
    // / blob: are read host-side. Gating on an active controller keeps the SW-less path synchronous,
    // so canvas-heavy pages take no async detour.
    // Resolve against THIS element's base first (frame documents — the raw
    // attribute resolved Ruby-side against the MAIN document, the recurring
    // wrong-base class), which also lets RELATIVE srcs route through the SW: the
    // old absolute-only gate existed because relative srcs hung on the then-
    // missing srcset model, not because of the SW path itself.
    let abs = src;
    const imgBase = this.baseURI || (globalThis.document && globalThis.document.baseURI) ||
      (globalThis.location && globalThis.location.href) || undefined;
    try { abs = new globalThis.URL(src, imgBase).href; } catch (_) {}
    const ctrl = /^https?:/i.test(abs) &&
      globalThis.__csimSWControllerHandle && globalThis.__csimSWControllerHandle();
    if (ctrl) { this._loadImageViaServiceWorker(ctrl, abs); return; }
    this._finishImageLoadFromNetwork(abs);
  }

  // This image element's request shape, set by `crossorigin` per HTML "fetch the image": absent
  // → mode 'no-cors' + credentials 'include' (a cross-origin image still loads, merely
  // canvas-tainting); 'use-credentials' → mode 'cors' + credentials 'include'; anything else
  // ('anonymous' / invalid / empty) → mode 'cors' + credentials 'same-origin'. Shared by the SW
  // request (event.request.mode) and the network fetch (CORS enforcement) so the two can't drift.
  _imageCorsRequest() {
    const co   = this._attrs.crossorigin;
    const cors = co != null;
    const useCredentials = cors && String(co).toLowerCase() === 'use-credentials';
    return {
      cors,
      mode:        cors ? 'cors' : 'no-cors',
      credentials: (!cors || useCredentials) ? 'include' : 'same-origin'
    };
  }

  // Route this image's request through the controlling SW, then apply its respondWith bytes (or
  // fall through to the network / report a network error). `src` is the raw (absolute) attribute,
  // kept for the network fall-through and the supersede guard. The request mirrors what a browser
  // hands its fetch handler for an <img>: destination 'image', and the `crossorigin`-derived
  // mode/credentials (_imageCorsRequest).
  _loadImageViaServiceWorker(ctrl, src) {
    let swUrl = src;
    const base = (globalThis.document && globalThis.document.baseURI) ||
      (globalThis.location && globalThis.location.href) || undefined;
    try { swUrl = new globalThis.URL(src, base).href; } catch (_) {}
    // The request is now pending: a browser flips `complete` to false and drops the current bitmap
    // until it resolves. The synchronous network path needs no such reset (it applies within the
    // same tick), but the SW round-trip has an observable in-flight window.
    this._pixels        = null;
    this._setNaturalSize(null);
    this._imgComplete   = false;
    this._imgBroken     = false;
    const {mode, credentials} = this._imageCorsRequest();
    const swReq = buildSwRequest({ mode, credentials, destination: 'image' });
    // Response tainting (Fetch "HTTP fetch"): only a no-cors request may use an opaque response — a
    // `crossorigin` (cors-mode) image handed an opaque (or opaque-redirect) response is a network
    // error, not a tainted render. `redirect` is always 'follow' here, so opaqueredirect is disallowed.
    const disallowedType = t => (mode !== 'no-cors' && t === 'opaque') || t === 'opaqueredirect';
    // The load generation this fetch belongs to: a `src` / `crossorigin` reassignment while it's in
    // flight bumps `_imgLoadGen`, so a stale response can't overwrite the newer request's bitmap or
    // fire a spurious event (more general than a URL compare — it also catches a crossorigin change).
    const gen = this._imgLoadGen | 0;
    globalThis.__csimSWInterceptFetch(ctrl, 'GET', swUrl, {Accept: 'image/*,*/*;q=0.8'}, null, swReq, swResp => {
      if ((this._imgLoadGen | 0) !== gen) return;                                     // superseded in flight
      if (swResp == null)        { this._finishImageLoadFromNetwork(src); return; }   // fall-through → network
      if (swResp.__networkError) { this._applyImageResult(null); return; }            // network error → broken
      if (disallowedType(swResp.type || 'default')) { this._applyImageResult(null); return; }   // tainting → broken
      this._applyImageResponse(swResp, gen);                                          // respondWith bytes
    });
  }

  // Decode a SW respondWith Response's body (buffered `body_bytes` or a streamed body) into the
  // bitmap, applying it via the shared result path. Re-checks the supersede guard after the (extra)
  // async drain a streamed body adds, so a late reassignment still wins. An OPAQUE (no-cors
  // cross-origin) response has no script-visible body, but its bytes ride `opaque_render` so the
  // image still renders — canvas-tainting, exactly as a browser paints an opaque cross-origin image.
  _applyImageResponse(swResp, gen) {
    const tainted = swResp.type === 'opaque';
    const apply   = r   => {
      if (r) r.tainted = tainted;   // the host decode carries no origin; the response type decides
      if ((this._imgLoadGen | 0) === gen) this._applyImageResult(r);
    };
    const decode  = bytes => {
      let r = null;
      if (bytes.length > 0) r = globalThis.__dom.decodeImage(bytes, 0, 0);
      apply(r);
    };
    if (swResp.bodyStream) {
      collectBodyStream(swResp.bodyStream)
        .then(latin1 => decode(latin1ToBytes(latin1)))
        .catch(() => apply(null));
      return;
    }
    decode(swResp.opaque_render || swResp.body_bytes || new globalThis.Uint8Array(0));
  }

  // Fetch + decode `src` host-side (the decode memoized by content) and apply the result — the
  // synchronous fast path for an uncontrolled document. A `crossorigin` image is a CORS request:
  // the host fetch enforces Access-Control, so a cross-origin response without a matching ACAO
  // fails the load. Absent crossorigin is a no-cors load that still reads the bytes — a
  // cross-origin image displays, merely canvas-tainting.
  _finishImageLoadFromNetwork(src) {
    const {cors, credentials} = this._imageCorsRequest();
    // An http(s) image is fetched + decoded on a HOST THREAD and applied when the result is
    // delivered through the settle loop — a real browser never blocks the parser on an image,
    // and the in-process Rails request behind an ActiveStorage URL (~21 ms each, measured 20 s
    // across the Avo suite) now overlaps JS execution instead of serializing with the parse.
    // Until delivery the element models the spec's PENDING request: `complete` false and the
    // image data DISCARDED (a reload draws nothing until the new data arrives). data: URLs
    // (host-local decode, no fetch) and start failures keep the synchronous path.
    if (/^https?:/i.test(src) && typeof globalThis.__csim_imageLoadStart === 'function') {
      let id = -1;
      try { id = globalThis.__csim_imageLoadStart(src, cors, credentials) | 0; } catch (_) {}
      if (id > 0) {
        // "Update the image data" resets the element to the UNAVAILABLE state the moment a
        // relevant mutation restarts the load — the previous image's data is discarded, not
        // shown through the pending request (2d.drawImage.incomplete.reload draws nothing).
        // `currentSrc` reflects the selected source from THIS point (Chrome sets it at source
        // selection, before the response arrives) — the pending window is observable now.
        this._imgRequestSrc = src;
        this._pixels        = null;
        this._pixelsP3      = null;
        this._setNaturalSize(null);
        this._imgComplete   = false;
        this._imgBroken     = false;
        (globalThis.__csimPendingImages || (globalThis.__csimPendingImages = new Map()))
          .set(id, { el: this, gen: this._imgLoadGen | 0, src, timingStart: globalThis.__csimPerformanceNow() });
        return;
      }
    }
    const timingStart = globalThis.__csimPerformanceNow();
    let r = null;
    try { r = globalThis.__csim_loadImage(src, cors, credentials); } catch (_) { /* host fault → broken */ }
    recordImageTiming(this, src, timingStart, r);
    this._applyImageResult(takeHostBitmaps(r));
  }

  // Apply a decoded-image result: `{width, height, pixels[, pixelsP3, colorSpace]}` on success (`__dom.decodeImage`'s
  // shape), `{unsupported}` / `{noPixels}` for the special cases, null/falsy for a broken load. Populates
  // the pixel bitmap + intrinsic size + `complete`, and fires `load` (or `error`). `_pixels` is
  // what drawImage / createPattern read. The decode is synchronous but the event is async — HTML
  // fires it from a queued task, approximated by a microtask — so an `onload`/`onerror` set after
  // `src=` still receives it.
  _applyImageResult(r) {
    // A scheme the host can't read yet (blob:, …): leave the element inert instead of firing a
    // spurious `error` — the resource may well be loadable.
    if (r && r.unsupported) return;
    if (r && r.broken) r = null;                 // fetched, but no image in it
    if (r && r.noPixels) {
      // An image with no pixels — no area (an SVG whose width|height is 0), or data corrupt past the
      // header that gave its size: the request SUCCEEDED, so the element is complete and NOT broken.
      // Fire `load` and report its size; createPattern / drawImage then treat it as an available
      // source that is not fully decodable (null / no-op), never a broken one.
      this._pixels        = null;
      this._setNaturalSize(r);
      this._imgComplete   = true;
      this._imgBroken     = false;
      // Canvas-tainting: a cross-origin non-CORS-approved image taints any canvas it's drawn into.
      this._tainted       = !!r.tainted;
      this._fireImgEvent('load');
      return;
    }
    if (r && r.pixels) {
      this._pixels        = r.pixels;
      this._colorSpace    = r.colorSpace || 'srgb';   // 'srgb' | 'display-p3' — drawImage converts into the dest space
      // A wide-gamut (Adobe/CMYK) source also carries a Display-P3 rendering, used when drawn into a
      // P3 canvas (the sRGB `_pixels` above is the clipped one) — and an image without one keeps none of the last.
      this._pixelsP3      = r.pixelsP3 || null;
      this._setNaturalSize(r);
      this._imgComplete   = true;
      this._imgBroken     = false;
      // Canvas-tainting: a cross-origin non-CORS-approved image taints any canvas it's drawn into.
      this._tainted       = !!r.tainted;
      this._fireImgEvent('load');
    } else {
      this._pixels = null; this._setNaturalSize(null);
      this._imgComplete = true;
      this._imgBroken   = true;    // a load was attempted and failed → broken
      this._tainted     = false;   // no pixels → not a taint source
      this._fireImgEvent('error');
    }
  }

  // Fire `load`/`error` from a queued task (approximated by a microtask), tagged with the load
  // (async-image delivery lands just above, via the realm-global below)
  // generation it belongs to: a newer load (a `src` / `crossorigin` reassignment in the same task)
  // supersedes this one, so its already-queued event is dropped and only the final load dispatches.
  _fireImgEvent(type) {
    const gen = this._imgLoadGen | 0;
    globalThis.__csimQueueMicrotask(() => {
      if ((this._imgLoadGen | 0) !== gen) return;   // superseded by a newer load
      fireEvent(this, new Event(type));
    });
  }

  // Applies a host-thread image result delivered by Ruby's `deliver_image_loads`. Realm-local
  // by construction (each realm evaluates its own bridge, so its own pending map); `true` tells
  // the deliverer the id was consumed here. A superseded load (src / crossorigin reassigned
  // while in flight — the generation moved) consumes the id but applies nothing, exactly like
  // the sync path's supersede guard. The arrival is an observable change the settle machinery
  // must see: the find cache keys on settleGen, and the element's box (natural size) moved.
  static __applyAsyncImage(id, r) {
    const m = globalThis.__csimPendingImages;
    const p = m && m.get(id);
    if (!p) return false;
    m.delete(id);
    const el = p.el;
    if ((el._imgLoadGen | 0) !== p.gen) {
      // Superseded while in flight: consume the id but not the bitmap — fetch-and-drop the
      // stashed transfer so the host registry doesn't pin it until teardown.
      if (r && r.refId) { try { fetchTransfer(r.refId); } catch (_) {} }
      if (r && r.refIdP3) { try { fetchTransfer(r.refIdP3); } catch (_) {} }
      return true;
    }
    recordImageTiming(el, p.src, p.timingStart, r);
    el._applyImageResult(takeHostBitmaps(r));
    markLayoutDirty(el, true);
    bumpSettleGen();
    return true;
  }

  // The decoded image's size — `r` a decode result, or null for none (no source, still loading, broken): what
  // `naturalWidth` / `naturalHeight` report, (its `natural`, as `__dom.decodeImage` gives it) what the layout sizes
  // the element from, and the EXIF orientation the decode turned it by.
  _setNaturalSize(r) {
    this._naturalWidth  = r ? r.width | 0 : 0;
    this._naturalHeight = r ? r.height | 0 : 0;
    this._natural       = (r && r.natural) || null;
    this._orientation   = r ? r.orientation | 0 : 0;   // the EXIF turn the decode applied, which flipY disregards

    setElementNaturalSize(this, this._natural);
  }
  // An SVG `<a>`'s `rel` (HTML's elements' are their interfaces'), on the shared
  // prototype: the driver gives SVG elements no interface of their own.
  get rel() { return this._attrs.rel == null ? '' : String(this._attrs.rel); }
  set rel(v) { this._setAttribute('rel', String(v)); }
  // HTMLFormElement IDL — `method` / `action` / `enctype` /
  // `target` are reflections of the corresponding attributes.
  // Rails-UJS's `handleMethod` builds a synthetic form via
  // `form.method = 'post'` / `form.action = href`; without
  // these setters those land as plain JS properties (not
  // attributes), and our form serialiser reads the attrs as
  // null → default GET → submits with the wrong method and a
  // query-string instead of a POST body.
  get method() {
    if (this._tag !== 'form') return this._attrs.method;
    // form.method: enumerated get/post/dialog, missing + invalid default 'get'.
    return enumReflectGet(this._attrs.method, ENUM_FORM_METHOD, 'get', 'get');
  }
  set method(v) {
    if (this._tag === 'form') this._setAttribute('method', String(v));
    else                       this._attrs.method = String(v);
  }
  get action() {
    if (this._tag !== 'form') return this._attrs.action;
    return submissionURL(this, this._attrs.action);
  }
  set action(v)  { this._setAttribute('action', toUSVString(v)); }
  get enctype()  { return enumReflectGet(this._attrs.enctype, ENUM_ENCTYPE, 'application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'); }
  set enctype(v) { this._setAttribute('enctype', String(v)); }
  get target()   { return this._attrs.target != null ? this._attrs.target : ''; }
  set target(v)  { this._setAttribute('target', String(v)); }
  // HTMLScriptElement / HTMLTitleElement / etc. expose `.text` as
  // an alias for `textContent`. stimulus-rails' `parseImportmapJson`
  // reads `script.text` to get the JSON; without this alias it
  // gets `undefined`.
  // `<body>.text` is the legacy text-color attribute (DOMString, treatNullAsEmptyString);
  // on option, `.text` is its collapsed text.
  get text()     {
    if (this._tag === 'body') return this._attrs.text == null ? '' : String(this._attrs.text);
    // `HTMLOptionElement.text`: the descendant Text data (in tree order, but
    // NOT descending into HTML/SVG <script> elements — MathML script DOES
    // recurse), with ASCII whitespace stripped and collapsed (runs → one space,
    // then trim).
    if (this._tag === 'option') {
      const parts = [];
      collectOptionText(this, parts);
      return parts.join('').replace(/[ \t\n\f\r]+/g, ' ').replace(/^ | $/g, '');
    }
    return this.textContent;
  }
  set text(v)    { if (this._tag === 'body') this._setAttribute('text', v === null ? '' : String(v)); else this.textContent = v; }
  // `<option>.label`: the null-namespace `label` content attribute when present,
  // else the option's `text` IDL (collapsed/trimmed). `<track>`
  // reflects `label` as a plain string. A `label` attribute set in a FOREIGN
  // namespace is NOT the content attribute, so option falls back to text.
  get label() {
    if (this._tag === 'track') return this._attrs.label == null ? '' : String(this._attrs.label);
    if (this._tag === 'option') {
      const v = this._getAttributeNS(null, 'label');
      return v != null ? v : this.text;
    }
    return undefined;
  }
  set label(v) {
    if (this._tag === 'track' || this._tag === 'option') {
      this._setAttribute('label', String(v));
    } else reflectExpandoFallback(this, 'label', v);
  }
  // HTMLOptionElement.index — the option's position in its owning <select>'s
  // list of options, or 0 when it has no <select> container: a <datalist>
  // option, an option whose parent isn't a select/optgroup-in-select, or a
  // detached option. The list of options is exactly `select.options` (children
  // of the select plus children of its optgroups), so index within that.
  get index() {
    if (this._tag !== 'option') return undefined;
    const par = this.parentNode;
    let select = null;
    if (par && par._tag === 'select') select = par;
    else if (par && par._tag === 'optgroup' && par.parentNode && par.parentNode._tag === 'select') select = par.parentNode;
    if (!select) return 0;
    const opts = select.options;
    for (let i = 0; i < opts.length; i++) if (opts[i] === this) return i;
    return 0;
  }
  // `index` is a readonly IDL attribute on <option>, so assignment there is a
  // no-op; on any other element it's a plain expando (the getter above lives on
  // the shared Element prototype, so without this setter `el.index = …` would
  // throw under the bundle's strict mode for every element).
  set index(v) { if (this._tag !== 'option') reflectExpandoFallback(this, 'index', v); }
  // `<input list="<id>">` exposes the associated <datalist> via
  // `input.list`. Capybara's `select` for datalist inputs reads
  // `this.list.options` to enumerate choices.
  get list() {
    if (this._tag !== 'input') return null;
    const id = this._attrs.list;
    if (!id) return null;
    // `list` resolves the <datalist> by id within the input's own tree (its
    // shadow root, else the document) — not across the shadow boundary.
    const root = this.getRootNode();
    const hit  = root && root.getElementById ? root.getElementById(id) : null;
    return (hit && hit._tag === 'datalist') ? hit : null;
  }
  // `checked` IDL reflects the live *checkedness* — the internal state, NOT the
  // `checked` content attribute (that is `defaultChecked`). While the dirty
  // checkedness flag is unset, checkedness tracks the attribute; the IDL setter
  // (and the click activation paths) set the flag via setCheckedness.
  get checked()  { return getCheckedness(this); }
  set checked(v) {
    const was = getCheckedness(this);
    setCheckedness(this, v);
    // HTML radio-button-group invariant: setting a radio's checkedness to true
    // sets every OTHER radio in its group to false. Runs on the IDL setter (as
    // well as the click / parser paths), so `radio.checked = true` deselects the
    // group's prior selection — only one radio per group can be checked. Gated on
    // the false→true transition: an already-checked radio is the group's selected
    // one (others already false), so re-asserting `checked = true` skips the
    // group scan — and the settle-gen bump below (which fires on the transition)
    // covers every sibling unchecked here.
    if (v && !was && this._tag === 'input' && (this._attrs.type || '').toLowerCase() === 'radio') {
      uncheckOtherRadios(this);
    }
    // (…the style-state and settle generations moved inside `setCheckedness`, the funnel every checkedness writer
    // shares; NOT a content-attribute mutation — checkedness is separate from the `checked` attribute per HTML — so no
    // MutationObserver record and no input/change event, those being user-action only)
  }
  // Boolean IDL reflections — `el.disabled = true` mirrors to the `disabled`
  // content attribute (HTML IDL contract), so route through setAttribute /
  // removeAttribute (like `hidden` / `open`) rather than writing `_attrs`
  // directly: that fires the MutationObserver attributes record + settle-gen bump
  // real browsers produce for a reflected change (and re-resolves any cascade
  // memo keyed on the settle generation). A direct `_attrs` write was silent to
  // both — e.g. `el.disabled = true` under `input[disabled]{display:none}` left
  // the element wrongly reported visible.
  get disabled() { return this._attrs.disabled != null; }
  set disabled(v){ if (v) this._setAttribute('disabled', ''); else this._removeAttribute('disabled'); }
  get readOnly() { return this._attrs.readonly != null; }
  set readOnly(v){ if (v) this._setAttribute('readonly', ''); else this._removeAttribute('readonly'); }
  get required() { return this._attrs.required != null; }
  set required(v){ if (v) this._setAttribute('required', ''); else this._removeAttribute('required'); }
  // Integer-reflecting IDL: `<input minlength="10">` → input.minLength === 10
  // (real browsers return -1 when unset). Discourse's
  // form-template-validation passes `count: field.minLength` into the
  // tooShort i18n string; an undefined here renders the literal
  // `count=undefined` placeholder instead of the translated count.
  // maxLength / minLength — "limited long" (non-negative, default -1): parse a
  // non-negative integer (else -1); negative IDL set throws IndexSizeError.
  get minLength() { return reflectUnsignedLongGet(this._attrs.minlength, -1); }
  set minLength(v){ reflectLimitedLongSet(this, 'minlength', v); }
  get maxLength() { return reflectUnsignedLongGet(this._attrs.maxlength, -1); }
  set maxLength(v){ reflectLimitedLongSet(this, 'maxlength', v); }
  // ── HTMLInputElement reflected string IDL ─────────────────────────
  // Each reflects its same-named (lowercased) content attribute as a
  // string. Only meaningful on `<input>`; mirror the existing
  // reflected-string idiom and default to '' off-input.
  get accept()      { return this._tag === 'input' ? (this._attrs.accept      == null ? '' : String(this._attrs.accept))      : ''; }
  set accept(v)     { this._setAttribute('accept', String(v)); }
  get pattern()     { return this._tag === 'input' ? (this._attrs.pattern     == null ? '' : String(this._attrs.pattern))     : ''; }
  set pattern(v)    { this._setAttribute('pattern', String(v)); }
  get step()        { return this._tag === 'input' ? (this._attrs.step        == null ? '' : String(this._attrs.step))        : ''; }
  set step(v)       { this._setAttribute('step', String(v)); }
  get min()         { return this._tag === 'input' ? (this._attrs.min         == null ? '' : String(this._attrs.min))         : ''; }
  set min(v)        { this._setAttribute('min', String(v)); }
  get max()         { return this._tag === 'input' ? (this._attrs.max         == null ? '' : String(this._attrs.max))         : ''; }
  set max(v)        { this._setAttribute('max', String(v)); }
  get capture()     { return this._tag === 'input' ? (this._attrs.capture     == null ? '' : String(this._attrs.capture))     : ''; }
  set capture(v)    { this._setAttribute('capture', String(v)); }
  // formaction / formenctype / formmethod / formtarget — submit-button
  // overrides; plain reflected strings.
  get formAction()  {
    if (!FORMACTION_REFLECTING_TAGS.has(this._tag)) return '';
    // HTML: when `formaction` is missing or empty, getting returns the node
    // document's URL (not a base-relative resolution of "").
    return submissionURL(this, this._attrs.formaction);
  }
  set formAction(v) { this._setAttribute('formaction', toUSVString(v)); }
  // formEnctype / formMethod are enumerated (on both <input> and <button>);
  // missing-value default '' but a non-empty INVALID-value default. formMethod's
  // keyword set differs: <input> is get/post, <button> adds dialog.
  get formEnctype() {
    return (this._tag === 'input' || this._tag === 'button')
      ? enumReflectGet(this._attrs.formenctype, ENUM_ENCTYPE, '', 'application/x-www-form-urlencoded') : '';
  }
  set formEnctype(v){ this._setAttribute('formenctype', String(v)); }
  get formMethod()  {
    if (this._tag === 'input')  return enumReflectGet(this._attrs.formmethod, ENUM_INPUT_FORM_METHOD, '', 'get');
    if (this._tag === 'button') return enumReflectGet(this._attrs.formmethod, ENUM_FORM_METHOD, '', 'get');
    return '';
  }
  set formMethod(v) { this._setAttribute('formmethod', String(v)); }
  // popovertargetaction — enumerated string, default ''.
  get popoverTargetAction()  { return this._tag === 'input' ? (this._attrs.popovertargetaction == null ? '' : String(this._attrs.popovertargetaction)) : ''; }
  set popoverTargetAction(v) { this._setAttribute('popovertargetaction', String(v)); }
  // ── HTMLInputElement boolean IDL reflections ──────────────────────
  get multiple()        { return (this._tag === 'input' || this._tag === 'select') ? this._hasAttribute('multiple') : false; }
  set multiple(v)       { if (v) this._setAttribute('multiple', ''); else this._removeAttribute('multiple'); }
  get webkitdirectory()  { return this._tag === 'input' ? this._hasAttribute('webkitdirectory') : false; }
  set webkitdirectory(v) { if (v) this._setAttribute('webkitdirectory', ''); else this._removeAttribute('webkitdirectory'); }
  // ── HTMLInputElement unsigned-long IDL reflections ────────────────
  // size defaults to 20; non-positive / NaN falls back to the default.
  // size: input → "limited unsigned long" (default 20, set 0 throws); select →
  // unsigned long (default 0).
  get size()  {
    return this._tag === 'input' ? reflectLimitedUnsignedLongGet(this._attrs.size, 20) : reflectUnsignedLongGet(this._attrs.size, 0);
  }
  set size(v) {
    if (this._tag === 'input') reflectLimitedUnsignedLongSet(this, 'size', v, 20);
    else reflectUnsignedLongSet(this, 'size', v, 0);
  }
  // height/width: unsigned long on video / input (the attribute, or 0).
  get height()  { return reflectUnsignedLongGet(this._attrs.height, 0); }
  set height(v) { reflectUnsignedLongSet(this, 'height', v, 0); }
  get width()   { return reflectUnsignedLongGet(this._attrs.width, 0); }
  set width(v)  { reflectUnsignedLongSet(this, 'width', v, 0); }
  // ── HTMLInputElement default* IDL ─────────────────────────────────
  // `defaultChecked` / `defaultValue` reflect the default — the `checked` /
  // `value` content attribute (`<textarea>`'s default is its child text). The
  // live state is separate: checkedness in `_checkedness`, value in `_value`,
  // each set once its dirty flag is.
  get defaultChecked()  { return this._hasAttribute('checked'); }
  set defaultChecked(v) { if (v) this._setAttribute('checked', ''); else this._removeAttribute('checked'); }
  // `defaultValue` reflects the DEFAULT value — the element's CHILD TEXT CONTENT
  // for <textarea>, the `value` content attribute for <input> — independent of
  // the live value (which lives in `_value` once dirtied). Setting it updates the
  // default: a clean control's live value tracks it; a dirtied control keeps its
  // `_value`. `<form>.reset()` reverts the live value to this default.
  get defaultValue()  {
    // `<output>.defaultValue`: in "default" value mode it tracks the descendant
    // text content; once in "value" mode (value was set) it returns the separately
    // stored default.
    if (this._tag === 'output') {
      return this._outputValueMode === 'value' ? (this._outputDefault || '') : this.textContent;
    }
    return this._tag === 'textarea' ? textareaRawValue(this) : (this._getAttribute('value') || '');
  }
  set defaultValue(v) {
    const s = String(v);   // plain DOMString reflection: null → "null", undefined → "undefined"
    // `<output>.defaultValue` setter: store the default; in "default" mode it also
    // updates the descendant text content (and thus the value), in "value" mode it
    // updates only the stored default.
    if (this._tag === 'output') {
      this._outputDefault = s;
      if (this._outputValueMode !== 'value') this.textContent = s;
      return;
    }
    if (this._tag === 'textarea') this.textContent = s;
    else this._setAttribute('value', s);
  }
  // `HTMLTextAreaElement.textLength` — the UTF-16 code-unit length of the API value
  // (JS string `.length` is already UTF-16 code units, so "你好，世界!" is 6).
  get textLength() { return this._tag === 'textarea' ? String(this.value == null ? '' : this.value).length : undefined; }
  // `indeterminate` is an IDL boolean stored on the instance — it has
  // no content attribute. Backed by a field, default false.
  get indeterminate()  { return hasState(this, STATE_INDETERMINATE); }
  set indeterminate(v) {
    const was = hasState(this, STATE_INDETERMINATE);
    setStateBit(this, STATE_INDETERMINATE, !!v);
    if (hasState(this, STATE_INDETERMINATE) !== was) bumpStyleState();   // `:indeterminate`, backed by no attribute
  }
  // `<input>.labels` — every `<label for=this.id>` in the document
  // plus any ancestor `<label>`. Deduped, in document order. When the
  // id is empty, only ancestor labels participate.
  // HTMLElement.labels — the live NodeList of `<label>`s associated with this
  // labelable control, in tree order. A label is associated with exactly its
  // *labeled control* (`labeledControlFor`), so the list is every label in the
  // control's own tree (shadow root else document) whose labeled control is
  // this element. That single rule subsumes explicit (`for`) and implicit
  // (first-labelable-descendant, incl. nested labels) association. The
  // attribute exists only on labelable element types; a labelable-tag-but-not-
  // a-control `<input type=hidden>` has it but reports null (it is not
  // labelable). Live: re-walked when a DOM mutation bumps the settle gen, so a
  // cached `el.labels` reflects later moves/removals.
  get labels() {
    return LABELABLE.has(this._tag) ? labelsOf(this) : undefined;
  }
  // ── HTMLInputElement value-as-number / value-as-date ──────────────
  // For number / range, parse `value` as a float (NaN when blank /
  // invalid). Other types report NaN (minimal — date parsing is heavy).
  get valueAsNumber() {
    if (this._tag !== 'input') return NaN;
    const type = (this._attrs.type || 'text').toLowerCase();
    if (!NUMERIC_INPUT_TYPES.has(type)) return NaN;
    return globalThis.__dom.inputNumber(type, this.value);   // a float for number / range, a temporal type's number
  }
  set valueAsNumber(v) {
    if (this._tag !== 'input') return;
    // HTML valueAsNumber setter: an INFINITE value is a TypeError, thrown before
    // the type-applicability prose (so it beats the InvalidStateError for a type
    // the attribute doesn't apply to). A NaN argument does NOT throw — it falls
    // through to the type check, then sets the value to the empty string. (This
    // matches real browsers; the IDL coercion itself is `unrestricted double`.)
    const num = Number(v);
    if (num === Infinity || num === -Infinity) {
      throw new TypeError("Failed to set the 'valueAsNumber' property on 'HTMLInputElement': The value provided is infinite.");
    }
    const type = (this._attrs.type || 'text').toLowerCase();
    // The setter only applies to numeric/temporal types; others throw.
    if (!NUMERIC_INPUT_TYPES.has(type)) {
      throw new globalThis.DOMException(
        "Failed to set the 'valueAsNumber' property: The input element's type ('" + type + "') does not support this property.",
        'InvalidStateError');
    }
    this.value = Number.isNaN(num) ? '' : globalThis.__dom.inputValue(type, num, false);
  }
  // Minimal `valueAsDate`: cheaply support type=date (`new Date(value)`,
  // null on invalid); other types / blank → null. Setter formats a
  // Date into `value` for date types.
  get valueAsDate() {
    if (this._tag !== 'input') return null;
    const type = (this._attrs.type || 'text').toLowerCase();
    // valueAsDate applies to date / month / week / time (NOT datetime-local).
    if (type !== 'date' && type !== 'month' && type !== 'week' && type !== 'time') return null;
    // (…a date's and a week's UTC midnight, a month's first day's, a time's ms past the epoch's midnight)
    const n = globalThis.__dom.inputDate(type, this.value);
    return Number.isNaN(n) ? null : new Date(n);
  }
  set valueAsDate(v) {
    if (this._tag !== 'input') return;
    // The IDL type is `object?`: a non-null argument that isn't a Date object is
    // a TypeError, thrown during argument coercion — BEFORE the type-applicability
    // prose (HTML valueAsDate setter step 1).
    if (v != null && !(v instanceof Date)) {
      throw new TypeError("Failed to set the 'valueAsDate' property on 'HTMLInputElement': The provided value is not a Date.");
    }
    const type = (this._attrs.type || 'text').toLowerCase();
    if (type !== 'date' && type !== 'month' && type !== 'week' && type !== 'time') {
      throw new globalThis.DOMException(
        "Failed to set the 'valueAsDate' property: The input element's type ('" + type + "') does not support this property.",
        'InvalidStateError');
    }
    if (v == null || Number.isNaN(v.getTime())) { this.value = ''; return; }
    this.value = globalThis.__dom.inputValue(type, v.getTime(), true);   // (…a month's: the Date's UTC year and month)
  }
  // `stepUp(n)` / `stepDown(n)` — adjust the value by `n` steps (in the type's
  // unit), clamped to min/max. Throws InvalidStateError on a type with no
  // allowed value step (non-numeric/temporal, or step="any").
  stepUp(n)   { this._stepBy(n == null ? 1 : n); }
  stepDown(n) { this._stepBy(-(n == null ? 1 : n)); }
  _stepBy(delta) {
    if (this._tag !== 'input') return;
    const type = (this._attrs.type || 'text').toLowerCase();
    // (…from the step base, onto the step grid, clamped within min and max: input_value.rs `step`)
    const next = steppedValueOf(this, type, this.value, delta);
    if (next === undefined) {
      throw new globalThis.DOMException(
        "Failed to execute 'stepUp' on 'HTMLInputElement': This form element does not have an allowed value step.",
        'InvalidStateError');
    }
    if (next !== null) this.value = next;
  }
  // `showPicker()` — we have no native picker UI, but the observable contract is
  // the precondition checks: InvalidStateError when the control isn't mutable
  // (disabled, or readonly on a type readonly applies to), then NotAllowedError
  // without transient user activation, which a successful call consumes.
  showPicker() {
    const tag = this._tag;
    if (tag !== 'input' && tag !== 'select') return;
    const iface = tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement';
    const type = (this._attrs.type || 'text').toLowerCase();
    if (isActuallyDisabled(this)) {
      throw new globalThis.DOMException(`Failed to execute 'showPicker' on '${iface}': The element is disabled.`, 'InvalidStateError');
    }
    if (tag === 'input' && READONLY_INPUT_TYPES.has(type) && this._attrs.readonly != null) {
      throw new globalThis.DOMException("Failed to execute 'showPicker' on 'HTMLInputElement': The input element is read-only.", 'InvalidStateError');
    }
    // SOP (HTML showPicker step): the document must be same-origin with the
    // top-level document — except for <input type=file|color>, which are exempt.
    // document.domain does NOT relax this — it's a pure origin compare. Runs
    // BEFORE the transient-activation check so a cross-origin call throws
    // SecurityError, not NotAllowedError. Compare via the RAW top global
    // (`__csimRawWindow` bypasses the cross-origin WindowProxy gate) and the
    // shared `__csimIsSameOriginWindow` helper, which fails CLOSED — reading
    // `top.origin` through the proxy directly would throw (origin is NOT a
    // cross-origin-readable property) and silently skip the check.
    const fileOrColor = tag === 'input' && (type === 'file' || type === 'color');
    if (!fileOrColor) {
      let crossOrigin = false;
      try {
        const t = globalThis.__csimTop;
        const rawTop = (t && t.__csimRawWindow) || t;
        if (rawTop && typeof globalThis.__csimIsSameOriginWindow === 'function') {
          crossOrigin = !globalThis.__csimIsSameOriginWindow(rawTop);
        }
      } catch (_) { crossOrigin = false; }
      if (crossOrigin) {
        throw new globalThis.DOMException(`Failed to execute 'showPicker' on '${iface}': ${iface}::showPicker() called from cross-origin iframe.`, 'SecurityError');
      }
    }
    if (!globalThis.__csimTransientActivation) {
      throw new globalThis.DOMException(`Failed to execute 'showPicker' on '${iface}': ${iface}::showPicker() requires a user gesture.`, 'NotAllowedError');
    }
    globalThis.__csimTransientActivation = false;   // consume transient activation
  }
  // Constraint validation (HTML §4.10.20): `constraintValidationMembers`, the listed elements' — each control's
  // interface takes them as its generated binding is installed.
  get validity()          { return constraintValidationMembers.get_validity(this); }
  get validationMessage() { return constraintValidationMembers.get_validationMessage(this); }
  get willValidate()      { return constraintValidationMembers.get_willValidate(this); }
  checkValidity()         { return this._tag === 'form' ? formCheckValidity(this) : constraintValidationMembers.checkValidity(this); }
  reportValidity()        { return this.checkValidity(); }
  setCustomValidity(msg)  { constraintValidationMembers.setCustomValidity(this, String(msg)); }

  // Text-field selection (HTMLInputElement / HTMLTextAreaElement), per HTML
  // "textFieldSelection". The APIs apply only to <textarea> and to <input>
  // whose computed type is in SELECTION_INPUT_TYPES; for any other input the
  // getters return null and the setters / methods throw InvalidStateError.
  // Every mutation routes through `__setSelectionRange`, the spec "set the
  // selection range" steps: clamp to the value length, collapse to the end
  // offset when end <= start, normalise direction, and — only when the extent
  // OR direction actually changed — queue an async element task that fires a
  // TRUSTED `select` event (bubbles, not cancelable), and a selectionchange. The offsets update
  // synchronously; only the event is deferred (so a caller reads the new
  // selection immediately, but `select` lands on the next task — see
  // textfieldselection/select-event.html, which asserts both).
  __selectionApplies() {
    if (this._tag === 'textarea') return true;
    if (this._tag !== 'input') return false;
    return SELECTION_INPUT_TYPES.has(this.type);
  }
  __requireSelectionApplies() {
    if (!this.__selectionApplies()) {
      throw new globalThis.DOMException(
        "The element's type ('" + (this._attrs.type || '') + "') does not support selection.",
        'InvalidStateError');
    }
  }
  // Shared "set the selection range" — the single point that mutates the
  // offsets and fires `select`. `direction` undefined → 'none'.
  __setSelectionRange(start, end, direction) {
    // Clamp to the RAW (visible) value length — controlLiveValue, not the sanitized
    // IDL `.value`: an email field's selection spans its unsanitized typed text
    // (" foo@bar "), and a clean <textarea>'s value is its child text (clamping to a
    // stale `_attrs.value` of 0 would collapse every offset to 0).
    const cv = controlLiveValue(this);
    const len = (cv != null ? String(cv) : '').length;
    // start/end arrive already coerced to unsigned long (>>> 0) by the public
    // entry points — do NOT re-truncate with `| 0` here (that would flip a
    // value above 2^31 negative). Just clamp to the value length.
    let s = start, e = end;
    if (s < 0) s = 0; else if (s > len) s = len;
    if (e < 0) e = 0; else if (e > len) e = len;
    if (e <= s) s = e;   // end <= start → both placed before offset `end`
    const dir = (direction === 'backward' || direction === 'forward') ? direction : 'none';
    const curS = this._selectionStart != null ? this._selectionStart : 0;
    const curE = this._selectionEnd   != null ? this._selectionEnd   : 0;
    const curD = this._selectionDirection || 'none';
    this._selectionStart     = s;
    this._selectionEnd       = e;
    this._selectionDirection = dir;
    if (s !== curS || e !== curE || dir !== curD) {
      // Queue an element task (user-interaction task source) to fire a trusted
      // select event — never synchronous — and schedule a selectionchange at the
      // control (Selection API: a text control's selection changed).
      const el = this;
      queueTask(() => {
        try {
          fireEvent(el, new Event('select', { bubbles: true, cancelable: false }));
        } catch (_) {}
      }, 0);
      globalThis.__csimScheduleSelectionChange(el);
    }
  }
  // Clamp the stored selection offsets to the current value length and persist
  // the result. The text entry cursor is corrected whenever the value shrinks by
  // a path OTHER than the value IDL setter (which moves the cursor to the end):
  // a `type` change that re-sanitizes to a shorter value, a form reset, or — for
  // a non-dirty <textarea> — a child-node mutation. Done lazily on read + written
  // back, so once clamped down it stays put even if the value later grows again
  // (matching the spec's mutate-at-change-time behaviour rather than reverting).
  __clampSelection() {
    // Clamp against the RAW (live) value — the same length __setSelectionRange /
    // setRangeText use — NOT the sanitized IDL `value` (which strips whitespace /
    // newlines for url/text/… and would clamp a valid raw-coordinate caret down).
    const len = controlLiveValue(this).length;
    if (this._selectionStart != null && this._selectionStart > len) this._selectionStart = len;
    if (this._selectionEnd   != null && this._selectionEnd   > len) this._selectionEnd   = len;
  }
  get selectionStart() {
    if (!this.__selectionApplies()) return null;
    this.__clampSelection();
    return this._selectionStart != null ? this._selectionStart : 0;
  }
  set selectionStart(v) {
    this.__requireSelectionApplies();
    const nv = v >>> 0;
    let end = this._selectionEnd != null ? this._selectionEnd : 0;
    if (end < nv) end = nv;
    this.__setSelectionRange(nv, end, this._selectionDirection || 'none');
  }
  get selectionEnd() {
    if (!this.__selectionApplies()) return null;
    this.__clampSelection();
    return this._selectionEnd != null ? this._selectionEnd : 0;
  }
  set selectionEnd(v) {
    this.__requireSelectionApplies();
    const start = this._selectionStart != null ? this._selectionStart : 0;
    this.__setSelectionRange(start, v >>> 0, this._selectionDirection || 'none');
  }
  get selectionDirection() {
    if (!this.__selectionApplies()) return null;
    return this._selectionDirection || 'none';
  }
  set selectionDirection(v) {
    this.__requireSelectionApplies();
    const start = this._selectionStart != null ? this._selectionStart : 0;
    const end   = this._selectionEnd   != null ? this._selectionEnd   : 0;
    this.__setSelectionRange(start, end, String(v == null ? 'none' : v));
  }
  setSelectionRange(start, end, direction) {
    this.__requireSelectionApplies();
    this.__setSelectionRange(start >>> 0, end >>> 0, direction);
  }
  // `setRangeText(replacement, start, end, selectMode)` — HTML spec. Replaces
  // the text between `start` and `end` with `replacement` and updates the
  // selection per `selectMode` ('select' / 'start' / 'end' / 'preserve';
  // default 'preserve'), routing the final selection through
  // `__setSelectionRange` so it fires `select` exactly when the selection
  // changed. Redmine's list-autofill controller calls it with `'start'` to
  // remove a list marker when Enter is pressed on an empty item.
  setRangeText(replacement, start, end, selectMode) {
    // WebIDL: `replacement` is required — a no-arg call is a TypeError (binding
    // layer, before the algorithm / applicability check).
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'setRangeText': 1 argument required, but only 0 present.");
    }
    this.__requireSelectionApplies();
    // Live value via the getter (a clean <textarea>'s value is its child text,
    // not `_attrs.value`).
    const cur = this.value != null ? String(this.value) : '';
    const len = cur.length;
    replacement = String(replacement);
    let s = start == null ? (this._selectionStart != null ? this._selectionStart : 0) : (start >>> 0);
    let e = end   == null ? (this._selectionEnd   != null ? this._selectionEnd   : s) : (end   >>> 0);
    // HTML: throw IndexSizeError when start > end (checked on the supplied
    // offsets, before clamping to the value length).
    if (s > e) throw new globalThis.DOMException('The index is not in the allowed range.', 'IndexSizeError');
    if (s < 0) s = 0; else if (s > len) s = len;
    if (e < 0) e = 0; else if (e > len) e = len;
    const before = cur.slice(0, s);
    const after  = cur.slice(e);
    const next = before + replacement + after;
    // setRangeText is a value mutation: store the live value (sets the dirty
    // value flag) so `defaultValue` keeps reporting the default (the `value`
    // attribute / child text, left untouched) and `<form>.reset()` restores it.
    // For a textarea the child text is the DEFAULT, so it is NOT rewritten here.
    setControlLiveValue(this, next);
    // setRangeText is a programmatic edit — it does NOT set _editedSinceFocus, so it
    // can't make a focused control fire `change` on blur.
    const mode = selectMode == null ? 'preserve' : String(selectMode);
    const replEnd = s + replacement.length;
    let ns, ne;
    if (mode === 'select') {
      ns = s; ne = replEnd;
    } else if (mode === 'start') {
      ns = s; ne = s;
    } else if (mode === 'end') {
      ns = replEnd; ne = replEnd;
    } else {
      // 'preserve': shift the existing selection by the length delta.
      const delta = replacement.length - (e - s);
      let ss = this._selectionStart != null ? this._selectionStart : 0;
      let se = this._selectionEnd   != null ? this._selectionEnd   : 0;
      if (ss > e) ss += delta; else if (ss > s) ss = replEnd;
      if (se > e) se += delta; else if (se > s) se = replEnd;
      ns = ss; ne = se;
    }
    this.__setSelectionRange(ns, ne, this._selectionDirection || 'none');
  }
  select() {
    // HTML "select()": select all the text. No-op when the control has no
    // selectable text (non-applicable type). Focuses as a side effect, matching
    // browsers + existing callers' "focus and select all" expectation. Applies to
    // the broader SELECT_INPUT_TYPES (incl. email) — wider than the selectionStart
    // APIs.
    if (!(this._tag === 'textarea' || (this._tag === 'input' && SELECT_INPUT_TYPES.has(this.type)))) return;
    this._focus();
    // Select over the RAW (visible) value, not the sanitized IDL `.value`: an email
    // field's typed " foo@bar " is selectable in full even though `.value` is the
    // trimmed "foo@bar". controlLiveValue is the raw live value (the child text for a
    // clean <textarea>, so select() still selects it).
    const len = String(controlLiveValue(this)).length;
    this.__setSelectionRange(0, len, 'none');
  }

  // File-input `.files` accessor. Set by `globalThis.__csimSetFiles` after
  // `attach_file`; each entry is a File-shaped object with name /
  // size / type / lastModified. Libraries that iterate input.files
  // (Redmine's `uploadAndAttachFiles`, drag-drop handlers reading
  // `dataTransfer.files`) see something usable. The actual byte
  // stream isn't carried here — the multipart serialiser pulls the
  // file contents from `@file_picks` on the Ruby side at form-submit
  // time.
  get files() {
    if (this._tag !== 'input') return null;
    if ((this._attrs.type || '').toLowerCase() !== 'file') return null;
    // `files` is [SameObject]: stabilise the backing array (a fresh `[]` per read
    // would defeat the cache) and rebuild the FileList only when the selection is
    // actually replaced (set files / __csimSetFiles reassign `_files`).
    if (this._files == null) this._files = [];
    if (!this._fileList || this._fileListArr !== this._files) {
      this._fileList    = createFileList(this._files);
      this._fileListArr = this._files;
    }
    return this._fileList;
  }
  // HTML lets you assign a `FileList` to a file input programmatically — the
  // canonical pattern is `input.files = dataTransfer.files` (drag-drop libraries,
  // and the kamalog `attach-images` Stimulus controller, do exactly this). Per the
  // IDL (`attribute FileList? files`) the value is converted to FileList? FIRST, so
  // a non-FileList (e.g. an array) is a TypeError regardless of input type; null is
  // a no-op (the selection can't be cleared this way); and a FileList is shared by
  // reference, not copied — `i1.files = i2.files` makes `i1.files === i2.files`.
  set files(value) {
    if (this._tag !== 'input') return;
    // WebIDL converts to FileList? first: a non-FileList (e.g. an array) is a
    // TypeError regardless of input type — a FileList of any realm (`filesOf`), so a
    // cross-frame `a.files = b.files` works.
    const files = value == null ? undefined : filesOf(value);
    if (value != null && files === undefined) {
      throw new globalThis.TypeError("Failed to set the 'files' property on 'HTMLInputElement': The provided value is not of type 'FileList'.");
    }
    if ((this._attrs.type || '').toLowerCase() !== 'file' || value == null) return;
    this._fileList    = value;
    this._files       = files;
    this._fileListArr = this._files;
  }

  // In an XML/XHTML document `innerHTML` getting is the XML serialization of the
  // children (require-well-formed), not the HTML serialization.
  get _innerHTML() {
    return isHtmlDocument(this.ownerDocument) ? serializeChildren(this) : xmlSerializeInner(this);
  }
  set _innerHTML(html) {
    // XML/XHTML document: replace the children with the XML-fragment parse
    // (well-formedness errors throw before anything is mutated). The HTML-only
    // <template>.content / <html> special cases below don't apply in XML.
    if (!isHtmlDocument(this.ownerDocument)) {
      const doc = this.ownerDocument;
      const parsed = parseXmlFragment(html, this);
      const removed = clearEdges(this);
      for (const c of removed) unregisterSubtree(c);
      // The parsed nodes are born owner-less; adopt them into this element's
      // document so `ownerDocument` resolves to the XML document (not the main
      // HTML page), matching the outerHTML / insertAdjacentHTML insert paths.
      for (const c of parsed) doc._adoptNode(c);
      insertEdges(this, parsed, -1);
      for (const c of parsed) registerSubtree(c);
      if (removed.length || parsed.length) recordChildList(this, parsed, removed);
      return;
    }
    // `<template>.innerHTML` setter populates the template's
    // `.content` fragment, not the template's own children (per
    // HTML spec — the inert subtree lives on the fragment).
    if (this._tag === 'template') {
      const frag = templateContent(this);
      for (const c of clearEdges(frag)) unregisterSubtree(c);
      const parsed = parseFragment(String(html === null ? '' : html), this);
      const tdoc = frag._ownerDoc;   // the inert template document (set at content creation)
      insertEdges(frag, parsed, -1);
      for (const c of parsed) {
        registerSubtree(c);
        // The parsed nodes live in the template content's INERT DOCUMENT: re-own
        // them (parseFragment built them against the outer document — a nested
        // template's own content already landed in the same inert doc via the
        // adapter) and stamp the tracking sentinel (same state the parser's
        // setTemplateContent path gives parse-time content) unless a stickier
        // association applies.
        walkSubtree(c, n => {
          if (tdoc && n._ownerDoc !== tdoc) {
            n._ownerDoc = tdoc;
            if (n._attrNodes) for (const k in n._attrNodes) n._attrNodes[k]._ownerDoc = tdoc;
          }
          if (n._nodeType === NODE_ELEMENT && n._ceRegistry === undefined) n._ceRegistry = TRACKING_NULL;
        });
      }
      bumpStructureGen();   // direct child-list edit: move the structure generation too
      bumpSettleGen();   // direct _children edit: refresh live collections (cached frag.children)
      return;
    }
    // Spec: replacing all children orphans the removed nodes
    // (parentNode → null). Tagify's `input.set('')` does
    // `DOM.input.innerHTML = ''` after committing a tag; if we
    // don't reset `_parent`, the previous text node still walks
    // up to a connected ancestor via `_parent`, and our caret-
    // recovery `isConnected(sc)` check passes when it shouldn't.
    // Subsequent character inserts then keep splicing into a
    // phantom text node that Tagify can't see → only the first
    // comma-separated tag commits.
    const connected = isConnected(this);
    // Detach every old child, then empty `this`, BEFORE running any removing steps:
    // per DOM "replace all" the element is already childless when the removed nodes'
    // disconnectedCallback runs, so a callback that reads `this.childNodes` sees none.
    const removedChildren = clearEdges(this);
    for (const c of removedChildren) unregisterSubtree(c);
    // Removing steps for the replaced subtree: when `this` is connected, the orphaned
    // nodes get disconnectedCallback (and a form-associated custom element resets its
    // owner to null) — symmetric with the connect walk below. The nodes are already
    // unlinked, so fireCEDisconnect sees them detached.
    if (connected) for (const c of removedChildren) fireCEDisconnect(c);
    askForResetAfterReplaceAll(removedChildren, this);
    // (…an `<html>`'s from a document parse — its `<head>` and `<body>` — whose nodes then belong to that other document)
    const fromDocument = this._tag === 'html';
    let frag;
    if (fromDocument) {
      const parsed = parseHtmlDocument(String(html === null ? '' : html));
      frag = documentElementOf(parsed) ? documentElementOf(parsed)._children.slice() : [];
    } else {
      frag = parseFragment(String(html === null ? '' : html), this);
    }
    // Parsed nodes are born owner-less; for the main document the ownerDocument
    // getter's fallback covers that, but when this element belongs to another
    // document (createHTMLDocument / XML) they must be adopted so their
    // ownerDocument resolves to it (mirrors the XML / insertAdjacentHTML paths) —
    // and so must an `<html>`'s, which belong to the document they were parsed in
    // (adopting takes them out of it, its tree and the arena's alike). Gated on
    // those cases to keep the hot main-document path allocation- and walk-free (rule 3).
    const ownerDoc = this.ownerDocument;
    const adopt = ownerDoc && (fromDocument || ownerDoc !== globalThis.document);
    if (adopt) for (const c of frag) ownerDoc._adoptNode(c);
    insertEdges(this, frag, -1);
    for (const c of frag) registerSubtree(c);
    // Per DOM spec ("replace all"), `innerHTML =` queues a single
    // childList mutation listing removed + added children. Stimulus'
    // ElementObserver wires event listeners off this — Avo's
    // `key_value` controller renders new rows via
    // `rowsTarget.innerHTML = ...`, and without the queueing the
    // freshly-rendered `data-action="input->…"` inputs never get
    // their listeners hooked up.
    if (removedChildren.length || frag.length) {
      recordChildList(this, frag, removedChildren);
    }
    // Insertion steps for the parsed subtree. When `this` is connected, run the
    // same connect walk as appendChild/insertBefore so the parsed nodes get their
    // post-insertion reactions: custom-element upgrade + connectedCallback (Turbo
    // Streams / Stimulus render markup this way), <link>/<style>/<iframe> resource
    // loads, and option selectedness for selects NESTED in the fragment. The
    // fragment parser marks its <script>s already-started (`_csimRan`), so the
    // walk's dynamic-<script> hook skips them — an innerHTML-inserted script must
    // not execute, matching the spec.
    if (connected) {
      for (const c of frag) globalThis.__csimFireCEConnect(c);
    } else {
      // A DISCONNECTED innerHTML still upgrades (custom element reactions drain
      // at the API boundary): the parsed elements construct against their
      // registry — the context's scoped one, or the document's — with no
      // connectedCallback. ceUpgradeTree short-circuits on zero definitions.
      for (const c of frag) ceUpgradeTree(c);
    }
    // Selectedness for a DIRECT `<select>` rebuild (`select.innerHTML = options`):
    // the connect walk reconciles selects NESTED in the fragment, but never `this`
    // itself (it isn't among the walked nodes), so the direct case still needs an
    // explicit pass — and it's also the only selectedness path when detached (no
    // connect walk ran). The nested-fragment fallback covers a detached container
    // whose markup contains a `<select>`; the `<select` pre-filter keeps the walk
    // off the hot path.
    if (this._tag === 'select') {
      finalizeSelectOptions(this);
    } else if (!connected && frag.length && /<select/i.test(html)) {
      for (const c of frag) {
        if (c._nodeType !== NODE_ELEMENT) continue;
        if (c._tag === 'select') finalizeSelectOptions(c);
        for (const sel of selectAll(c, 'select')) finalizeSelectOptions(sel);
      }
    }
    // Radio-group de-dup for the directly-attached parsed nodes — only when the
    // markup could contain a radio (the `radio` pre-filter keeps the walk off the
    // hot path, like the <select> case above).
    if (frag.length && /type\s*=\s*["']?radio/i.test(html)) radioGroupDedupOnInsert(frag);
    detailsExclusivityOnInsert(frag);
  }
  // In an XML/XHTML document `outerHTML` getting is the XML serialization of the
  // element itself (require-well-formed), mirroring the innerHTML getter.
  get _outerHTML() {
    return isHtmlDocument(this.ownerDocument) ? serializeElement(this) : xmlSerializeOuter(this);
  }
  // `el.outerHTML = html` (DOM Parsing spec): parse `html` as a fragment and
  // replace this element with the result, within this element's parent.
  set _outerHTML(html) {
    const parent = this._parent;
    // No parent → the parsed nodes would be unreferenceable; spec leaves this
    // a no-op. A Document parent can't have its child replaced this way.
    if (parent == null) return;
    if (parent._nodeType === NODE_DOC) {
      throw new globalThis.DOMException("Cannot set the 'outerHTML' property on an element whose parent is a Document.", 'NoModificationAllowedError');
    }
    // In an XML/XHTML document the replacement is parsed as an XML fragment (context = the parent element).
    const nodes = isHtmlDocument(this.ownerDocument) ? parseFragment(html, parent) : parseXmlFragment(html, parent);
    // Spec (DOM Parsing): "replace this with the new nodes within parent" — a
    // single DOM "replace", so observers see ONE childList record (removedNodes
    // = [this], addedNodes = the parsed nodes), not a remove + separate inserts.
    parent._replaceChildWithNodes(this, nodes);
  }
  // `insertAdjacentHTML(position, html)` — DOM spec method. Forem's
  // initializeBroadcast uses `el.insertAdjacentHTML('afterbegin', …)`
  // to inject the announcement banner. Positions: `beforebegin` /
  // `afterbegin` / `beforeend` / `afterend`.
  _insertAdjacentHTML(position, html) {
    const pos = asciiLower(position);
    // Resolve the context element per spec; an unknown position is a
    // SyntaxError, and beforebegin/afterend with no element parent (null or a
    // Document) is a NoModificationAllowedError.
    if (pos === 'beforebegin' || pos === 'afterend') {
      if (!this._parent || this._parent._nodeType === NODE_DOC) {
        throw new globalThis.DOMException("Failed to execute 'insertAdjacentHTML' on 'Element': The element has no parent.", 'NoModificationAllowedError');
      }
    } else if (pos !== 'afterbegin' && pos !== 'beforeend') {
      throw new globalThis.DOMException(adjacentPositionError('insertAdjacentHTML', position), 'SyntaxError');
    }
    // XML/XHTML document → XML fragment parsing (context per spec: the parent for
    // beforebegin/afterend, this element otherwise); malformed markup throws SyntaxError.
    const ctx = (pos === 'beforebegin' || pos === 'afterend') ? this._parent : this;
    const frag = isHtmlDocument(this.ownerDocument) ? parseFragment(html, ctx) : parseXmlFragment(html, ctx);
    if (pos === 'beforebegin')     { for (const c of frag) this._parent._insertBefore(c, this); }
    else if (pos === 'afterbegin') { const first = this._children[0] || null; for (const c of frag) this._insertBefore(c, first); }
    else if (pos === 'beforeend')  { for (const c of frag) this._appendChild(c); }
    else /* afterend */            { const next = this._nextSibling; for (const c of frag) this._parent._insertBefore(c, next); }
  }
  // Shared "insert adjacent" core for insertAdjacentElement / insertAdjacentText
  // (NOT insertAdjacentHTML, which has its own context algorithm). beforebegin /
  // afterend with no parent return null; an unknown position is a SyntaxError;
  // a Document parent surfaces as HierarchyRequestError from the pre-insertion
  // validity inside insertBefore (NOT the NoModificationAllowedError that
  // insertAdjacentHTML raises). `member` is which one's, for the error's message.
  _insertAdjacent(position, node, member) {
    const pos = asciiLower(position);
    if (pos === 'beforebegin')     { if (!this._parent) return null; this._parent._insertBefore(node, this); }
    else if (pos === 'afterbegin') { this._insertBefore(node, this._children[0] || null); }
    else if (pos === 'beforeend')  { this._appendChild(node); }
    else if (pos === 'afterend')   { if (!this._parent) return null; this._parent._insertBefore(node, this._nextSibling); }
    else throw new globalThis.DOMException(adjacentPositionError(member, position), 'SyntaxError');
    return node;
  }
  // DOM "attach a shadow root", of a ShadowRootInit (its members converted: `mode`, `slotAssignment`, `clonable`,
  // `delegatesFocus`, `serializable`, `customElementRegistry`).
  _attachShadow(init) {
    const { mode, slotAssignment } = init;
    if (!canAttachShadow(this)) {
      throw new globalThis.DOMException("Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow", 'NotSupportedError');
    }
    if (this._shadowRoot) {
      // HTML "attach a shadow root" reuse path (whatwg/dom#1246): a DECLARATIVE
      // shadow root (from `<template shadowrootmode>`) is reused when the new
      // mode MATCHES — the only parameter checked. The root is emptied and its
      // declarative flag cleared, then returned AS-IS: delegatesFocus /
      // slotAssignment / clonable / serializable keep their declarative-creation
      // values and are NOT overwritten by this init. A non-declarative existing
      // root, or a mode mismatch, throws.
      const ex = this._shadowRoot;
      if (!ex._declarative || ex.mode !== mode) {
        throw new globalThis.DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", 'NotSupportedError');
      }
      // "Replace all with null within shadow" — a TREE MUTATION, recorded like any other. Emptying it
      // silently left the host's old declarative boxes laid out (Chrome drops to height 0, we kept 50),
      // queued no MutationObserver record where Chrome queues a childList one, and left every memo keyed
      // on a child-list record — the cascade's structural-context epochs and the enclosing-shadow-root
      // stamp among them — describing a tree that no longer exists.
      const emptied = clearEdges(ex);
      for (const c of emptied) unregisterSubtree(c);
      if (emptied.length) {
        recordChildList(ex, [], emptied);
        markLayoutDirty(this, true);
      }
      ex._declarative    = false;
      return ex;
    }
    const sr = new ShadowRoot(this, mode, SHADOW_ROOT_INTERNAL);
    sr._slotAssignment = slotAssignment;
    sr._clonable       = init.clonable;   // cloneNode of the host clones a clonable shadow tree
    sr._delegatesFocus = init.delegatesFocus;
    sr._serializable   = init.serializable;
    // The shadow tree's custom element registry: elements parsed via the shadow's
    // innerHTML inherit it. Unset (undefined) → the global registry; a scoped registry
    // or the null-registry state is carried on the root.
    sr._ceRegistry = ceRegistryOption(init);
    this._shadowRoot = sr;
    arenaAttachShadow(this, sr);   // (…which counts the host: `noteShadowHost`)
    registerSubtree(sr);
    // The host now renders its (empty) shadow tree, and every light child left the flat tree until a slot takes it —
    // no DOM mutation says so. Chrome drops `<div id=h><div style="height:50px">` to 0 the moment the root is attached;
    // the boxes laid out before stayed where they were, the element after them 50px down.
    markLayoutDirty(this, true);
    for (const c of this._children) markLayoutDirty(c, true);
    bumpSettleGen();   // …and what the host's text is (Chrome: "" once the root is attached, where the memo kept "A")
    return sr;
  }

  // DOM "set an attribute" of an Attr — `setAttributeNode`, `setAttributeNodeNS` and NamedNodeMap's `setNamedItem(NS)`:
  // adopt it into this element's attribute list, replacing any existing attribute with the same (namespace, local
  // name), and return the replaced Attr (or null). An InUseAttributeError if it is another element's.
  _setAttributeNode(attr) {
    if (attr._ownerElement != null && attr._ownerElement !== this) {
      throw new globalThis.DOMException("The attribute is in use by another element.", "InUseAttributeError");
    }
    // (…an attribute of another document — another realm's too — is adopted into this element's)
    attr._ownerDoc = this.ownerDocument;
    const key = this._attrKeyByNS(attr._ns, attr._localName);
    const oldAttr = key != null ? this._attrNodeFor(key) : null;
    if (oldAttr === attr) return attr;
    if (oldAttr) this._detachAttrNode(oldAttr._key);
    this._bindAttrNode(attr);
    return oldAttr;
  }
  // `setHTMLUnsafe` parses like `innerHTML` but ADDITIONALLY processes
  // declarative shadow roots (`<template shadowrootmode>` → real shadow root).
  // `innerHTML` deliberately does not, so do the conversion after the parse.
  _setHTMLUnsafe(html) {
    this._innerHTML = html;
    // `<template>.innerHTML` routes the parse into the inert content fragment
    // (not `_children`), so scan there for declarative shadow roots; every
    // other element holds the parsed nodes as its own children. Pass `this` as
    // the context element so a top-level `<template shadowrootmode>` (its parent
    // being `this`) is NOT converted — the context element is never a DSD host.
    if (this._tag === 'template') {
      processDeclarativeShadowRoots(templateContent(this));
    } else {
      processDeclarativeShadowRoots(this, this);
    }
  }

  // media `.loading` (missing+invalid 'eager') — enumerated.
  get loading()  { return LOADING_TAGS.has(this._tag) ? enumReflectGet(this._attrs.loading, ENUM_LOADING, 'eager', 'eager') : undefined; }
  set loading(v) { if (LOADING_TAGS.has(this._tag)) this._setAttribute('loading', String(v)); }
  // media.preload (video/audio) — enumerated, missing/invalid default 'auto'.
  get preload()  { return (this._tag === 'video' || this._tag === 'audio') ? enumReflectGet(this._attrs.preload, ENUM_PRELOAD, 'auto', 'auto') : undefined; }
  set preload(v) { if (this._tag === 'video' || this._tag === 'audio') this._setAttribute('preload', String(v)); }
  // `crossOrigin` (audio/video) — NULLABLE enumerated: absent → null,
  // invalid → 'anonymous'; on set, null/undefined removes the attribute.
  get crossOrigin()  {
    return (this._tag === 'audio' || this._tag === 'video')
      ? enumReflectGet(this._attrs.crossorigin, ENUM_CROSSORIGIN, null, 'anonymous') : undefined;
  }
  set crossOrigin(v) {
    if (!(this._tag === 'audio' || this._tag === 'video')) return;
    if (v == null) this._removeAttribute('crossorigin');
    else           this._setAttribute('crossorigin', String(v));
  }
  // `<input type=color>`.alpha — boolean reflection (presence); .colorSpace —
  // enumerated, content attribute `colorspace`, missing + invalid default
  // 'limited-srgb'. Both reflect on any `<input>`; only type=color uses them.
  get alpha()  { return this._tag === 'input' ? this._hasAttribute('alpha') : false; }
  set alpha(v) { if (this._tag === 'input') { if (v) this._setAttribute('alpha', ''); else this._removeAttribute('alpha'); } }
  get colorSpace()  { return this._tag === 'input' ? enumReflectGet(this._attrs.colorspace, ENUM_COLORSPACE, 'limited-srgb', 'limited-srgb') : undefined; }
  set colorSpace(v) { if (this._tag === 'input') this._setAttribute('colorspace', String(v)); }
  // textarea.cols/rows → limited unsigned long (def 20/2); frameset.cols/rows → string.
  get cols()  {
    if (this._tag === 'textarea') return reflectLimitedUnsignedLongGet(this._attrs.cols, 20);
    if (this._tag === 'frameset') return this._attrs.cols == null ? '' : String(this._attrs.cols);
    return undefined;
  }
  set cols(v) {
    if (this._tag === 'textarea') reflectLimitedUnsignedLongFallbackSet(this, 'cols', v, 20);
    else if (this._tag === 'frameset') this._setAttribute('cols', String(v));
  }
  get rows()  {
    if (this._tag === 'textarea') return reflectLimitedUnsignedLongGet(this._attrs.rows, 2);
    if (this._tag === 'frameset') return this._attrs.rows == null ? '' : String(this._attrs.rows);
    return undefined;
  }
  set rows(v) {
    if (this._tag === 'textarea') reflectLimitedUnsignedLongFallbackSet(this, 'rows', v, 2);
    else if (this._tag === 'frameset') this._setAttribute('rows', String(v));
  }
  // `relList`, a [SameObject, PutForwards=value] DOMTokenList over `rel`: a form's
  // and an SVG `<a>`'s (a/area/link have their interfaces' own); `undefined` on an
  // element that has none, not a stray DOMTokenList.
  get relList() {
    const ns = this._ns, ln = this._localName;
    if ((ns === HTML_NS && ln === 'form') ||
        (ns === SVG_NS && ln === 'a')) return tokenListFor(this, 'rel');
    return undefined;
  }
  set relList(v) {
    const list = this.relList;
    if (list) list.value = v == null ? '' : String(v);
  }
  // `<output>.htmlFor`, a [PutForwards=value] DOMTokenList over the `for` attribute.
  get htmlFor() { return tokenListFor(this, 'for'); }
  set htmlFor(v) { this._setAttribute('for', String(v)); }

  // ── HTMLFormElement members (BATCH F) ───────────────────────────
  // `encoding` is the legacy alias of `enctype`.
  get encoding()  { return this.enctype; }
  set encoding(v) { this.enctype = v; }
  // `acceptCharset` reflects the hyphenated `accept-charset` attribute.
  get acceptCharset()  { return this._attrs['accept-charset'] || ''; }
  set acceptCharset(v) { this._setAttribute('accept-charset', String(v)); }
  get noValidate()  { return this._hasAttribute('novalidate'); }
  set noValidate(v) { if (v) this._setAttribute('novalidate', ''); else this._removeAttribute('novalidate'); }
  // `<form>.autocomplete` is enumerated 'on' / 'off' (default 'on'). On
  // input/select/textarea the IDL value runs the autofill processing model.
  get autocomplete() {
    if (this._tag === 'form') {
      return (this._attrs.autocomplete || '').toLowerCase() === 'off' ? 'off' : 'on';
    }
    if (this._tag === 'input' || this._tag === 'select' || this._tag === 'textarea') {
      const anchorMantle = this._tag === 'input' && (this._attrs.type || '').toLowerCase() === 'hidden';
      return serializeAutofill(this._attrs.autocomplete, anchorMantle);
    }
    return this._attrs.autocomplete || '';
  }
  set autocomplete(v) { this._setAttribute('autocomplete', String(v)); }
  // `<form>.length` is the number of listed form controls; `<select>.length`
  // is the number of option elements (HTMLSelectElement supports indexed
  // properties, so it exposes `length` alongside its `@@iterator`).
  get length() {
    if (this._tag === 'form') {
      const els = this.elements;
      return els ? els.length : 0;
    }
    if (this._tag === 'select') {
      const opts = this.options;
      return opts ? opts.length : 0;
    }
    return undefined;
  }
  // `<select>.length` setter (= HTMLOptionsCollection.length setter): grow by
  // appending blank `<option>` elements to the select, or shrink by removing
  // options from the end. `<form>.length` is read-only, so this is select-only.
  set length(v) {
    if (this._tag !== 'select') return;
    const n = v >>> 0;                       // WebIDL unsigned long
    const opts = this.options;
    const cur = opts.length;
    // Defensive cap: `v >>> 0` turns a negative / accidental value (e.g. -1) into
    // ~4 billion, which would hang appending options. A real grow is tiny; skip
    // an absurd one rather than spin.
    if (n > cur && n - cur <= 100000) {
      const doc = this.ownerDocument || globalThis.document;
      for (let i = cur; i < n; i++) this._appendChild(doc.createElement('option'));
    } else if (n < cur) {
      for (let i = cur - 1; i >= n; i--) {
        const o = opts[i];
        if (o && o._parent) o._parent._removeChild(o);
      }
    }
  }
  // `<form>.reset()` restores each control to its default value /
  // checkedness (the original content attribute) and dispatches a
  // cancelable `reset` event, per the HTML reset algorithm.
  reset() {
    if (this._tag !== 'form') return;
    // Form-associated custom elements owned by this form get a `formResetCallback`
    // reaction — collected during the built-in reset pass and fired AFTER it, so the
    // callback observes the reset built-in controls (a spec-ordering the test checks
    // against an <output>). `reset()` is [CEReactions], so the reactions run
    // synchronously before the method returns.
    const resetCustomElements = [];
    for (const el of this.elements || []) {
      const t = el._tag;
      if (isFormAssociatedCustomElement(el)) { resetCustomElements.push(el); continue; }
      // Resetting clears the dirty-value flag → the value is no longer a user
      // edit, so tooShort/tooLong stop suffering on the restored default.
      if (t === 'input' || t === 'textarea') setStateBit(el, STATE_DIRTY_BY_USER, false);
      if (t === 'input') {
        const type = (el._attrs.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          // Clear the dirty checkedness flag → checkedness reverts to the
          // `checked` content attribute (the default), which reset leaves
          // untouched.
          clearControlCheckedness(el);
        } else if (type === 'file') {
          // A file input's reset sets its value to '' — in filename mode,
          // emptying its selected files.
          el._files = [];
        } else {
          // Clear the dirty value flag → the value reverts to the `value`
          // content attribute (the default), which reset leaves untouched.
          clearControlLiveValue(el);
        }
      } else if (t === 'textarea') {
        // Clear the dirty value flag → the value reverts to the child text
        // content (the default).
        clearControlLiveValue(el);
      } else if (t === 'select') {
        // HTML reset: each option's selectedness reverts to its
        // `selected` content attribute (defaultSelected) and dirtiness
        // clears; then the select re-runs its selectedness algorithm.
        for (const o of listOfOptions(el)) {
          setSelectedness(o, o.getAttributeNode('selected') != null);
          o._dirtySel = false;
          o._selInit = true;
        }
        runSelectednessAlgorithm(el, null);
      } else if (t === 'output') {
        // HTML "reset" for <output>: value mode flag → default, descendant text
        // content → the default value (a no-op while already in default mode).
        if (el._outputValueMode === 'value') {
          el.textContent = el._outputDefault || '';
          el._outputValueMode = undefined;
        }
      }
    }
    // Reset changed control values / checkedness / selectedness — all observable
    // (value/`:checked`/`:selected` cascade memos, live `selectedOptions`, settle
    // key), and the direct `_attrs.value` / `_selectedness` writes above don't
    // record a mutation, so bump the settle generation once for the whole reset.
    bumpSettleGen();
    // Now that the built-in controls are reset, run each form-associated custom
    // element's `formResetCallback` reaction (in tree order — `elements` is ordered).
    for (const el of resetCustomElements) {
      const fn = el.formResetCallback;
      if (typeof fn === 'function') {
        try { fn.call(el); }
        catch (e) { logThrew('custom element formResetCallback', e); }
      }
    }
    try {
      fireEvent(this, new Event('reset', { bubbles: true, cancelable: true }));
    } catch (_) {}
  }
}
// WebIDL interface attributes are enumerable on the interface prototype (real
// browsers expose them as enumerable: true), but class `get`/`set` accessors
// default to non-enumerable. shadowrootadoptedstylesheets-idl-feature-detection
// asserts `shadowRootAdoptedStyleSheets` is enumerable on HTMLTemplateElement
// .prototype. This runs at MODULE LOAD, while the accessor is still hand-written
// on Element.prototype; installDomClassAliases later RELOCATES it (and its
// `<template>` siblings) onto the real HTMLTemplateElement.prototype, carrying
// this enumerable flag with it. Re-flag ONLY this accessor — its siblings stay
// non-enumerable (no test asserts otherwise), matching real browsers where these
// members live only on <template>.
{
  const __d = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRootAdoptedStyleSheets');
  if (__d) Object.defineProperty(Element.prototype, 'shadowRootAdoptedStyleSheets', { ...__d, enumerable: true });
}

// HTML "navigate to a fragment": when a hyperlink's resolved URL equals
// the current document URL except for the fragment, the activation is a
// same-document navigation — update the URL and fire `hashchange`, with
// NO document fetch. We run it entirely in JS (rather than handing the
// navigation to Ruby) for two reasons: it is genuinely same-document, and
// in a pure-JS run (the WPT harness) Ruby never drains the pending-
// navigation slot, so a fragment link would otherwise never fire
// `hashchange`. Shared by both click paths (IDL `Element.click()` and the
// UA/Capybara click resolver). Returns true when it handled the
// activation, so the caller skips the cross-document navigation path.
// `anchor` is the activating `<a>` / `<area>`; its `.href` getter has
// already resolved the attribute against the document base URL.
export function fragmentNavigate(anchor) {
  // A non-self browsing-context target (`_blank`, a named window, …)
  // opens elsewhere — never a same-document fragment hop.
  const target = String(anchor._attrs.target || '').toLowerCase();
  if (target && target !== '_self') return false;
  // Fast reject (avoid the URL parses in `tryFragmentNavigate` on the
  // common cross-document link): a same-document fragment hop needs EITHER
  // a fragment in the target OR one in the current URL to clear. Resolving
  // a ref against a base never inherits the base's fragment, so a `#`-free
  // raw href stays fragmentless.
  const rawHref = hrefAttr(anchor) || '';
  if (rawHref.indexOf('#') === -1 && (globalThis.location.href || '').indexOf('#') === -1) return false;
  return tryFragmentNavigate(anchor.href);
}

// ── ARIAMixin string reflection (BATCH B1) ───────────────────────
// Each ARIA IDL property reflects an `aria-*` content attribute (or
// bare `role`). Per spec these reflect as nullable strings: getter
// returns the attribute value or null; setter writes the attribute,
// or removes it when assigned null/undefined. Installed once on
// Element.prototype via a camelCase→attribute table.
const ARIA_REFLECTED_ATTRS = {
  role: 'role',
  ariaAtomic: 'aria-atomic',
  ariaAutoComplete: 'aria-autocomplete',
  ariaBusy: 'aria-busy',
  ariaChecked: 'aria-checked',
  ariaColCount: 'aria-colcount',
  ariaColIndex: 'aria-colindex',
  ariaColIndexText: 'aria-colindextext',
  ariaColSpan: 'aria-colspan',
  ariaCurrent: 'aria-current',
  ariaDescription: 'aria-description',
  ariaDisabled: 'aria-disabled',
  ariaExpanded: 'aria-expanded',
  ariaHasPopup: 'aria-haspopup',
  ariaHidden: 'aria-hidden',
  ariaInvalid: 'aria-invalid',
  ariaKeyShortcuts: 'aria-keyshortcuts',
  ariaLabel: 'aria-label',
  ariaLevel: 'aria-level',
  ariaLive: 'aria-live',
  ariaModal: 'aria-modal',
  ariaMultiLine: 'aria-multiline',
  ariaMultiSelectable: 'aria-multiselectable',
  ariaOrientation: 'aria-orientation',
  ariaPlaceholder: 'aria-placeholder',
  ariaPosInSet: 'aria-posinset',
  ariaPressed: 'aria-pressed',
  ariaReadOnly: 'aria-readonly',
  ariaRelevant: 'aria-relevant',
  ariaRequired: 'aria-required',
  ariaRoleDescription: 'aria-roledescription',
  ariaRowCount: 'aria-rowcount',
  ariaRowIndex: 'aria-rowindex',
  ariaRowIndexText: 'aria-rowindextext',
  ariaRowSpan: 'aria-rowspan',
  ariaSelected: 'aria-selected',
  ariaSetSize: 'aria-setsize',
  ariaSort: 'aria-sort',
  ariaValueMax: 'aria-valuemax',
  ariaValueMin: 'aria-valuemin',
  ariaValueNow: 'aria-valuenow',
  ariaValueText: 'aria-valuetext',
  ariaBrailleLabel: 'aria-braillelabel',
  ariaBrailleRoleDescription: 'aria-brailleroledescription'
};
// ARIA attributes converted from plain DOMString to ENUMERATED reflection (ARIA
// PR w3c/aria#2484): the IDL getter canonicalizes on GET — an absent attribute →
// the missing-value default, a value that ASCII case-insensitively matches a
// keyword → that keyword, anything else → the invalid-value default. The SETTER
// is unchanged (stores ToString(value) verbatim; null/undefined removes it). Maps
// are built from keywords only: the spec data's `nonCanon: {"": …}` is a no-op in
// the reflection algorithm (it keys on the matched result, which is never "").
const ARIA_ENUM = {
  ariaAtomic:          { map: buildEnumMap(['true', 'false']),                                              missing: null,    invalid: 'false' },
  ariaAutoComplete:    { map: buildEnumMap(['inline', 'list', 'both', 'none']),                             missing: 'none',  invalid: 'none' },
  ariaBusy:            { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaChecked:         { map: buildEnumMap(['true', 'false', 'mixed']),                                     missing: null,    invalid: null },
  ariaCurrent:         { map: buildEnumMap(['page', 'step', 'location', 'date', 'time', 'true', 'false']),  missing: 'false', invalid: 'true' },
  ariaDisabled:        { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaExpanded:        { map: buildEnumMap(['true', 'false']),                                              missing: null,    invalid: null },
  ariaHasPopup:        { map: buildEnumMap(['true', 'false', 'menu', 'dialog', 'listbox', 'tree', 'grid']), missing: null,    invalid: 'false' },
  ariaHidden:          { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaInvalid:         { map: buildEnumMap(['true', 'false', 'spelling', 'grammar']),                       missing: 'false', invalid: 'true' },
  ariaLive:            { map: buildEnumMap(['polite', 'assertive', 'off']),                                 missing: 'off',   invalid: 'off' },
  ariaModal:           { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaMultiLine:       { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaMultiSelectable: { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaOrientation:     { map: buildEnumMap(['horizontal', 'vertical']),                                     missing: null,    invalid: null },
  ariaPressed:         { map: buildEnumMap(['true', 'false', 'mixed']),                                     missing: null,    invalid: null },
  ariaReadOnly:        { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaRequired:        { map: buildEnumMap(['true', 'false']),                                              missing: 'false', invalid: 'false' },
  ariaSelected:        { map: buildEnumMap(['true', 'false']),                                              missing: null,    invalid: null },
  ariaSort:            { map: buildEnumMap(['ascending', 'descending', 'other', 'none']),                   missing: 'none',  invalid: 'none' }
};
// ARIAMixin's members on an element (`get_ariaX` / `set_ariaX`, Element's implementation below): each reflects its
// content attribute, a nullable string.
const ariaMembers = {};
for (const idl of Object.keys(ARIA_REFLECTED_ATTRS)) {
  const attr = ARIA_REFLECTED_ATTRS[idl];
  const en = ARIA_ENUM[idl];
  ariaMembers['get_' + idl] = (el) => {
    const v = el._attrs[attr];
    if (en) {
      if (v != null) return enumReflectGet(v, en.map, en.missing, en.invalid);
      // Absent attribute. A nullable enum EXPLICITLY set to null via the IDL
      // setter reads back null even when it has a non-null missing-value default;
      // a never-set one (or one whose content attribute was changed directly via
      // setAttribute / removeAttribute, which clear the marker) reads the missing
      // default — null is a distinct state from unset (browsers' AOM model). The
      // marker is keyed by content-attribute name so those paths clear it.
      return (el._ariaNull && el._ariaNull.has(attr)) ? null : en.missing;
    }
    return v == null ? null : v;
  };
  ariaMembers['set_' + idl] = (el, value) => {
    if (value === null) {
      el._removeAttribute(attr);   // its steps clear any stale marker first
      if (en) (el._ariaNull || (el._ariaNull = new Set())).add(attr);
    } else {
      el._setAttribute(attr, value);   // its steps clear the marker
    }
  };
}

// ARIAMixin element-reference reflection (ARIA 1.3): `ariaActiveDescendantElement`
// reflects a single IDREF; the seven `aria*Elements` reflect IDREF-list
// attributes as a frozen array. Per the spec's "attr-associated element(s)"
// model (verified against Chromium): a value SET through the IDL attribute is
// stored in an internal slot (`_attrElements`) and the content attribute is
// set to the empty string — so `hasAttribute()` is true but `getAttribute()`
// returns '' — and the getter returns the stored element(s). When only the
// content attribute is present (parsed HTML / setAttribute, no IDL assignment),
// the getter resolves its IDREF(s) by id against the document, dropping ids
// with no match. (Real browsers additionally drop stored elements that have
// left a valid scope; we return the stored set verbatim — a bounded
// simplification for an API a11y libraries rarely round-trip.)
const ARIA_ELEMENT_REF_ATTRS = {
  ariaActiveDescendantElement: 'aria-activedescendant'
};
const ARIA_ELEMENT_REFLIST_ATTRS = {
  ariaControlsElements:     'aria-controls',
  ariaDescribedByElements:  'aria-describedby',
  ariaDetailsElements:      'aria-details',
  ariaErrorMessageElements: 'aria-errormessage',
  ariaFlowToElements:       'aria-flowto',
  ariaLabelledByElements:   'aria-labelledby',
  ariaOwnsElements:         'aria-owns'
};
// Reverse map content-attribute → IDL slot key, so that setting/removing the
// content attribute can detach the explicitly-set element(s) per the HTML
// attribute-change steps (the slot is the "explicitly set attr-element(s)").
const ARIA_ATTR_TO_SLOT = Object.create(null);
for (const idl in ARIA_ELEMENT_REF_ATTRS)     ARIA_ATTR_TO_SLOT[ARIA_ELEMENT_REF_ATTRS[idl]] = idl;
for (const idl in ARIA_ELEMENT_REFLIST_ATTRS) ARIA_ATTR_TO_SLOT[ARIA_ELEMENT_REFLIST_ATTRS[idl]] = idl;
function __ariaRefDoc(el) {
  return (el && el.ownerDocument) || globalThis.document || null;
}
function __ariaClearSlot(el, idl) {
  if (el._attrElements) delete el._attrElements[idl];
  if (el._attrElementsCache) delete el._attrElementsCache[idl];
}
function __ariaStoreSlot(el, idl, value) {
  (el._attrElements || (el._attrElements = Object.create(null)))[idl] = value;
}
// Resolve an IDREF in the host's OWN tree scope (the spec resolves against the
// element's node tree, not globally — a `document.getElementById` skips shadow
// content, and `ShadowRoot.getElementById` is scoped to that shadow tree).
function __ariaScopedById(host, id) {
  const root = host && host.getRootNode ? host.getRootNode() : null;
  if (root && typeof root.getElementById === 'function') return root.getElementById(id) || null;
  // Host is in a DETACHED subtree whose root is a plain Element/fragment (no
  // getElementById) — resolve the IDREF within that subtree in tree order so a
  // reference stays functional while host + target are disconnected together.
  if (root) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n._nodeType === NODE_ELEMENT && n._attrs && n._attrs.id === id) return n;
      const kids = n._children;
      if (kids) for (let i = kids.length - 1; i >= 0; i--) { const c = kids[i]; if (c._nodeType === NODE_ELEMENT) stack.push(c); }
    }
    return null;
  }
  const doc = __ariaRefDoc(host);
  return (doc && doc.getElementById(id)) || null;
}
// An explicitly-set attr-element `candidate` is a VALID reference for `host` iff
// candidate's node tree is a shadow-including INCLUSIVE ANCESTOR of host: the
// same tree, or a "lighter" tree reachable by walking host up through parents
// and shadow-host boundaries. A reference into a descendant shadow tree, into a
// detached subtree (while host stays connected), or across documents is invalid;
// a reference within the same detached subtree as host stays valid.
function __ariaRefValid(host, candidate) {
  if (!candidate || !candidate.getRootNode) return false;
  const candRoot = candidate.getRootNode();
  let node = host;
  while (node && node.getRootNode) {
    const root = node.getRootNode();
    if (root === candRoot) return true;
    node = (root && root._isShadowRoot) ? root._host : null;
  }
  return false;
}
// Two element lists hold the same references in the same order (FrozenArray
// caching invariant — the getter returns the SAME object until the computed set
// changes).
function __ariaSameRefs(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
for (const idl of Object.keys(ARIA_ELEMENT_REF_ATTRS)) {
  const attr = ARIA_ELEMENT_REF_ATTRS[idl];
  ariaMembers['get_' + idl] = (el) => {
    const raw = el._attrs[attr];
    const slot = el._attrElements && el._attrElements[idl];
    // A slot is live only while the content attribute is "" (the IDL setter's
    // marker). A real IDREF or an absent attribute (setAttribute/remove) means
    // the explicit element was cleared — fall back to scoped IDREF resolution.
    if (slot !== undefined && raw === '') return __ariaRefValid(el, slot) ? slot : null;
    if (raw == null || raw === '') return null;
    return __ariaScopedById(el, String(raw));
  };
  ariaMembers['set_' + idl] = (el, value) => {
    if (value === null) { __ariaClearSlot(el, idl); el._removeAttribute(attr); return; }
    el._setAttribute(attr, '');
    __ariaStoreSlot(el, idl, value);
  };
}
for (const idl of Object.keys(ARIA_ELEMENT_REFLIST_ATTRS)) {
  const attr = ARIA_ELEMENT_REFLIST_ATTRS[idl];
  // The current valid element list, or null when neither the IDL slot nor a
  // content attribute is present.
  const compute = (host) => {
    const raw = host._attrs[attr];
    const slot = host._attrElements && host._attrElements[idl];
    if (slot !== undefined && raw === '') return slot.filter(e => __ariaRefValid(host, e));
    if (raw == null) return null;
    const out = [];
    for (const id of String(raw).split(/\s+/)) {
      if (!id) continue;
      const el = __ariaScopedById(host, id);
      if (el) out.push(el);
    }
    return out;
  };
  ariaMembers['get_' + idl] = (el) => {
    const computed = compute(el);
    if (computed === null) return null;
    // FrozenArray caching: return the same frozen object while the computed
    // references are unchanged; rebuild (and re-cache) when they differ.
    const cache = el._attrElementsCache && el._attrElementsCache[idl];
    if (cache && __ariaSameRefs(cache, computed)) return cache;
    const frozen = Object.freeze(computed);
    (el._attrElementsCache || (el._attrElementsCache = Object.create(null)))[idl] = frozen;
    return frozen;
  };
  ariaMembers['set_' + idl] = (el, value) => {
    if (value === null) { __ariaClearSlot(el, idl); el._removeAttribute(attr); return; }
    el._setAttribute(attr, '');
    __ariaStoreSlot(el, idl, value);
    if (el._attrElementsCache) delete el._attrElementsCache[idl];
  };
}

// The SyntaxError an insertAdjacent* member throws for a position that is none of the four (Chrome's message).
function adjacentPositionError(member, position) {
  return `Failed to execute '${member}' on 'Element': The value provided ('${position}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`;
}

// `getHTML(options)` — an element's or a shadow root's: its children serialized as innerHTML's, but with the shadow
// roots the options ask for (`serializableShadowRoots` and a root's `serializable`, or one listed in `shadowRoots`) as
// `<template shadowrootmode=…>` first children; in an XML document, innerHTML's.
function getHTMLOf(node, options) {
  return isHtmlDocument(node.ownerDocument) ? serializeChildrenWithShadow(node, options) : node._innerHTML;
}
// `styleSheets` — a document's or a shadow root's, the same list each time ([SameObject]): every `<style>` and
// `<link rel=stylesheet>` in it, each its own `.sheet` (so `styleElement.sheet === document.styleSheets[i]`; none while
// a root is disconnected), in tree order, as the tree is at each read.
// (…its sheets found again once the tree moved: a tree generation moves on an insertion or a removal, an attribute
// write — `rel`, `disabled`, `media`, `type` — a `<style>`'s text and a parser mutation, and a `<link>`'s sheet is there
// as it is inserted)
function styleSheetListOf(root) {
  if (root._styleSheetList) return root._styleSheetList;
  let gen = NaN, sheets = null;
  return (root._styleSheetList = newStyleSheetList(() => {
    if (currentTreeGen() !== gen) {
      gen = currentTreeGen();
      sheets = styleSheetsOf(root);
    }
    return sheets;
  }));
}
function styleSheetsOf(root) {
  const sheets = [];
  walkSubtree(root, (n) => {
    if (n._nodeType !== NODE_ELEMENT || (n._tag !== 'style' && n._tag !== 'link')) return;
    const sheet = n.sheet;
    if (sheet) sheets.push(sheet);
  });
  return sheets;
}

// CSSOM View's scroll of an element to a position, or by an offset (`scroll` / `scrollTo` / `scrollBy`): only where
// it keeps a scroll offset (`holdsScrollOffset`: every other element refuses the write and reads back 0), each axis
// given — a non-finite value 0 — clamped as the scrollTop / scrollLeft setters clamp (`moveScrollOffset`):
// `window.scrollTo(0, document.body.scrollHeight)` is how a page says "go to the bottom", and it must land AT the
// bottom, not past it. Discourse's RouteScrollManager restores `scrollingElement.scrollTop` with `scrollTo(left, top)`.
// A promise of the scroll's completion — an instant one, so resolved.
export function scrollElement(el, x, y, by) {
  if (!holdsScrollOffset(el)) return resolvedPromise();
  const finite = (v) => (v === undefined || Number.isFinite(v) ? v : 0);
  x = finite(x);
  y = finite(y);
  if (by) {
    const box = scrollOffsetHolder(el);
    x = x ? settledScrollOffsetOf(box, 0) + x : undefined;
    y = y ? settledScrollOffsetOf(box, 1) + y : undefined;
  }
  moveScrollOffset(el, x, y);
  return resolvedPromise();
}

// Element's members (generated/bindings.js), its steps and the driver's: what the class keeps (`_getAttribute`,
// `_innerHTML`, `_attachShadow`, …), what Node's other kinds share with it (ParentNode / ChildNode's), the arena's
// answers (geometry.rs, collections.rs) — and ARIAMixin's reflection (`ariaMembers`).
registerInterface('Element', (o) => isNodeObject(o) && o._nodeType === NODE_ELEMENT);
// An element's attribute steps — Element's members' and its NamedNodeMap's, which run them on its element (a frame's
// map on a frame's element: its realm's steps, in its slots).
const attributeSteps = {
  getAttributeNode(el, qualifiedName) {
    const k = qnameKey(el, qualifiedName);
    return k != null ? makeAttr(el, k) : null;
  },
  getAttributeNodeNS(el, namespace, localName) {
    const key = el._attrKeyByNS(namespace, localName);
    return key == null ? null : el._attrNodeFor(key);
  },
  // (…an attribute of the element's, removed: Element's "remove an attribute")
  removeAttr(el, attr) {
    el._removeAttrKey(attr._key);
    return attr;
  },
  // (…whether its NamedNodeMap's named properties leave out the names with an uppercase letter: an HTML element's in an
  // HTML document — asked as they are read, the element moving between documents — its indices and `getNamedItem`
  // still reaching every attribute)
  dropsUppercase: (el) => el._ns === HTML_NS && isHtmlDocument(el.ownerDocument)
};
installElement(Element, {
  ...ariaMembers,
  get_namespaceURI: (el) => el._ns,
  get_prefix: (el) => el._prefix,
  get_localName: (el) => el._localName,
  get_tagName: (el) => el._nodeName,
  // `id` / `className` / `slot` reflect their content attributes (an SVG element's `className` is SVGElement's).
  get_id: (el) => el._attrs.id || '',
  set_id(el, value) { el._setAttribute('id', value); },
  get_className: (el) => el._attrs['class'] || '',
  set_className(el, value) { el._setAttribute('class', value); },
  // [SameObject, PutForwards=value]: one token list per element, its writes the `class` attribute's (so MutationObserver,
  // the cascade and `attributeChangedCallback` see a `classList.remove('hidden')`); `part`'s the same of `part` — the
  // names by which an element in a shadow tree is exposed to `::part()` outside it.
  get_classList: (el) => tokenListFor(el, 'class'),
  get_part: (el) => tokenListFor(el, 'part'),
  get_slot: (el) => el._attrs.slot || '',
  set_slot(el, value) { el._setAttribute('slot', value); },
  hasAttributes: (el) => Object.keys(el._attrs).length > 0,
  // A LIVE NamedNodeMap, one per element.
  get_attributes: (el) => el._attrsColl ??= liveNamedNodeMap(el, attributeSteps),
  // (…qualified names in attribute order: a collision key mapped back to its name)
  getAttributeNames(el) {
    const keys = Object.keys(el._attrs);
    return el._attrNS ? keys.map((k) => attrQName(el, k)) : keys;
  },
  getAttribute: (el, qualifiedName) => el._getAttribute(qualifiedName),
  getAttributeNS: (el, namespace, localName) => el._getAttributeNS(namespace, localName),
  setAttribute(el, qualifiedName, value) { el._setAttribute(qualifiedName, value); },
  setAttributeNS(el, namespace, qualifiedName, value) { el._setAttributeNS(namespace, qualifiedName, value); },
  removeAttribute(el, qualifiedName) { el._removeAttribute(qualifiedName); },
  removeAttributeNS(el, namespace, localName) { el._removeAttributeNS(namespace, localName); },
  // (…without `force`, flipped; with it, as it says — the presence it leaves)
  toggleAttribute(el, qualifiedName, force) {
    if (!isValidAttributeLocalName(qualifiedName)) {
      throw new globalThis.DOMException("Failed to execute 'toggleAttribute' on 'Element': '" + qualifiedName + "' is not a valid attribute name.", 'InvalidCharacterError');
    }
    const has = el._hasAttribute(qualifiedName);
    const next = force === undefined ? !has : force;
    if (next === has) return next;
    if (next) el._setAttribute(qualifiedName, '');
    else el._removeAttribute(qualifiedName);
    return next;
  },
  hasAttribute: (el, qualifiedName) => el._hasAttribute(qualifiedName),
  hasAttributeNS: (el, namespace, localName) => el._attrKeyByNS(namespace, localName) != null,
  getAttributeNode: attributeSteps.getAttributeNode,
  getAttributeNodeNS: attributeSteps.getAttributeNodeNS,
  setAttributeNode: (el, attr) => el._setAttributeNode(attr),
  setAttributeNodeNS: (el, attr) => el._setAttributeNode(attr),
  removeAttributeNode(el, attr) {
    if (attr._ownerElement !== el) {
      throw new globalThis.DOMException("Failed to execute 'removeAttributeNode' on 'Element': The node provided is owned by another element.", 'NotFoundError');
    }
    return attributeSteps.removeAttr(el, attr);
  },
  attachShadow: (el, init) => el._attachShadow(init),
  get_shadowRoot: (el) => (el._shadowRoot && el._shadowRoot.mode === 'open' ? el._shadowRoot : null),
  // An element's custom element registry: unset (`_ceRegistry === undefined`) it TRACKS THE NODE DOCUMENT's (the
  // global one in the live document, null in an inert one); a scoped registry or the null-registry state as it is.
  get_customElementRegistry: registryForElement,
  closest: (el, selectors) => closestSelector(el, selectors),
  matches: (el, selectors) => matchesSelector(el, selectors),
  webkitMatchesSelector: (el, selectors) => matchesSelector(el, selectors),
  // (…an element's descendants; whether its document is HTML — which lowercases the search for its HTML elements —
  // bound as the live list is made, so moving the element into an XML document does not change the list)
  getElementsByTagName(el, qualifiedName) {
    const htmlDoc = isHtmlDocument(el.ownerDocument);
    return liveHTMLCollection(() => collectByTagName(el, qualifiedName, htmlDoc));
  },
  getElementsByTagNameNS: (el, namespace, localName) => liveHTMLCollection(() => collectByTagNameNS(el, namespace, localName)),
  getElementsByClassName: (el, classNames) => liveHTMLCollection(() => collectByClassName(el, classNames)),
  insertAdjacentElement: (el, where, element) => el._insertAdjacent(where, element, 'insertAdjacentElement'),
  insertAdjacentText(el, where, data) {
    const text = new Text(data);
    text._ownerDoc = el.ownerDocument;
    el._insertAdjacent(where, text, 'insertAdjacentText');
  },
  // CSSOM View's geometry: one rect per FRAGMENT (a link wrapping over two lines has two — Chrome); none for an
  // element not rendered, one for a rendered empty one (what keeps `:visible`-style probes answering true for it).
  getClientRects: (el) => rectList(clientRectsOf(el).map((r) => new globalThis.DOMRect(r.x, r.y, r.width, r.height))),
  getBoundingClientRect(el) {
    const r = rectOf(el);
    return new globalThis.DOMRect(r.x, r.y, r.width, r.height);
  },
  // `checkVisibility(options)`: false for an element with no box — and, only when ASKED, for one whose `visibility` is
  // hidden (`visibilityProperty`, or its older name `checkVisibilityCSS`) or that has, or sits under, an `opacity` of 0
  // (`opacityProperty` / `checkOpacity`). Chrome: a bare `checkVisibility()` is true for a `visibility: hidden`
  // element; and false for SKIPPED content, a closed `<details>`'s (`isUnskippedNode`). (Not modelled yet:
  // `content-visibility: hidden` / `auto` skipping theirs.)
  checkVisibility(el, options) {
    if (!isUnskippedNode(el) || !globalThis.__csimGeneratesBox(el)) return false;
    if ((options.visibilityProperty || options.checkVisibilityCSS) && visibilityHidden(el)) return false;
    if (options.opacityProperty || options.checkOpacity) {
      for (let e = el; e && e._nodeType === NODE_ELEMENT; e = flatTreeParent(e)) {
        if (parseFloat(globalThis.__csimGetComputedStyle(e).opacity) === 0) return false;
      }
    }
    return true;
  },
  // `scrollIntoView(arg)` (CSSOM View §12.4): aligned in every ancestor scrolling box (`applyScrollIntoView`), each one
  // that moves firing its own (coalesced) scroll events. The legacy boolean picks the block edge — true the start,
  // false the end — the inline axis then `nearest`. The scroll epoch bumped even when nothing moved: it is a
  // user-action signal, and a pagination sentinel already in view gates on the intersection recheck it asks for.
  scrollIntoView(el, arg) {
    const block = typeof arg === 'boolean' ? (arg ? 'start' : 'end') : arg.block;
    const inline = typeof arg === 'boolean' ? 'nearest' : arg.inline;
    applyScrollIntoView(el, block, inline);
    bumpScrollEpoch();
    return resolvedPromise();
  },
  scroll_options: (el, options) => scrollElement(el, options.left, options.top, false),
  scroll_x_y: (el, x, y) => scrollElement(el, x, y, false),
  scrollTo_options: (el, options) => scrollElement(el, options.left, options.top, false),
  scrollTo_x_y: (el, x, y) => scrollElement(el, x, y, false),
  scrollBy_options: (el, options) => scrollElement(el, options.left, options.top, true),
  scrollBy_x_y: (el, x, y) => scrollElement(el, x, y, true),
  // (…kept only where a browser keeps one, `scrollOffsetHolder`: elsewhere 0, and a write refused)
  get_scrollTop(el) { const box = scrollOffsetHolder(el); return box ? settledScrollOffsetOf(box, 1) : 0; },
  set_scrollTop(el, value) { scrollElement(el, undefined, value, false); },
  get_scrollLeft(el) { const box = scrollOffsetHolder(el); return box ? settledScrollOffsetOf(box, 0) : 0; },
  set_scrollLeft(el, value) { scrollElement(el, value, undefined, false); },
  // The scrollable content extent — the box unioned with its descendants' (Avo's Trix body shows a "More content"
  // expander above a threshold) — and the client box, the padding box inside the border (`clientLeft` / `clientTop`
  // the border widths: geometry.rs `client_box`). The viewport's for the document's scrolling element: the idiom a
  // page asks how big the window is by (`_isViewportElement`).
  get_scrollWidth: (el) => contentExtent(el._isViewportElement() ? documentElementOf(el.ownerDocument) : el).width,
  get_scrollHeight: (el) => contentExtent(el._isViewportElement() ? documentElementOf(el.ownerDocument) : el).height,
  get_clientTop: (el) => clientBox(el).top,
  get_clientLeft: (el) => clientBox(el).left,
  get_clientWidth: (el) => (el._isViewportElement() ? viewportSize().width : clientBox(el).width),
  get_clientHeight: (el) => (el._isViewportElement() ? viewportSize().height : clientBox(el).height),
  get_children: childrenOf,
  get_firstElementChild: firstElementChildOf,
  get_lastElementChild: lastElementChildOf,
  get_childElementCount: childElementCountOf,
  prepend: parentNodePrepend,
  append: parentNodeAppend,
  replaceChildren: parentNodeReplaceChildren,
  moveBefore: parentNodeMoveBefore,
  querySelector: (el, selectors) => selectFirst(el, selectors),
  querySelectorAll: (el, selectors) => nodeList(selectAll(el, selectors)),
  get_previousElementSibling: previousElementSiblingOf,
  get_nextElementSibling: nextElementSiblingOf,
  before: childNodeBefore,
  after: childNodeAfter,
  replaceWith: childNodeReplaceWith,
  remove: childNodeRemove,
  // (…the slot it is assigned to, of an open shadow tree only: one in a closed tree is not observable)
  get_assignedSlot: (el) => findSlotForSlottable(el, true),
  setHTMLUnsafe(el, html) { el._setHTMLUnsafe(html); },
  getHTML: getHTMLOf,
  get_innerHTML: (el) => el._innerHTML,
  set_innerHTML(el, value) { el._innerHTML = value; },
  get_outerHTML: (el) => el._outerHTML,
  set_outerHTML(el, value) { el._outerHTML = value; },
  insertAdjacentHTML(el, position, string) { el._insertAdjacentHTML(position, string); },
  // Pointer capture: with no real pointer device, none is ever held.
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture: () => false,
  // Web Animations: a real animation, whose value the same model reports as a CSS one's (web-animations.js).
  animate: (el, keyframes, options) => animateElement(el, keyframes, options),
  getAnimations: (el, options) => animationsForElement(el, options),
  // (…Fullscreen's, which are IDL attributes only: no content attribute is one)
  installEventHandlers(proto, names, isSelf) { installEventHandlerAttrs(proto, names, null, isSelf); }
});

// HTMLOrSVGElement's members (`dataset`, `nonce`, `autofocus`, `tabIndex`, `focus`, `blur`), ElementCSSInlineStyle's
// `style` and GlobalEventHandlers' `on*` — what HTMLElement, SVGElement and MathMLElement share (generated/bindings.js
// installs each onto its interface: an element in no such namespace has none of them, Chrome's `'onclick' in` false).
// (…GlobalEventHandlers' content attributes an element's of those namespaces alone)
const inHandlerNamespace = (el) => el._ns === HTML_NS || el._ns === SVG_NS || el._ns === MATHML_NS;
const htmlOrForeignElementMembers = {
  get_dataset: (el) => datasetOf(el),
  // `nonce` is the [[CryptographicNonce]] slot, not the content attribute: the setter writes only the slot (the
  // attribute stays as it was — html/dom reflection.js), which a `setAttribute('nonce', …)` keeps in sync and the
  // connection step fills when it hides the attribute (CSP nonce hiding); until written, the attribute is the value.
  get_nonce: (el) => el._nonce != null ? el._nonce : (el._attrs.nonce != null ? el._attrs.nonce : ''),
  set_nonce(el, value) { el._nonce = value; },
  // `tabIndex` reflects `tabindex` as a long; its default is 0 for an HTML a, area, button, frame, iframe, input,
  // object, select or textarea, an SVG a, and a summary that is its details' summary — -1 for anything else (HTML
  // "tabIndex"; an `<audio>` / `<video>` too, which Chrome and Firefox both answer 0 for, against the spec's list).
  // The value is parsed by the rules for parsing integers (-0 read as 0) and must be in a long's range.
  get_tabIndex(el) {
    const n = parseHtmlInteger(el._attrs.tabindex);
    if (n !== null && n >= REFLECT_MIN_INT && n <= REFLECT_MAX_INT) return n;
    const t = el._localName;   // (…case kept: `createElementNS(HTML_NS, 'BUTTON')` is no button)
    if (el._ns === SVG_NS) return t === 'a' ? 0 : -1;
    if (el._ns !== HTML_NS) return -1;
    if (TABBABLE_BY_DEFAULT.has(t)) return 0;
    if (t !== 'summary') return -1;
    const details = el._parent;
    return details && details._localName === 'details' && details._ns === HTML_NS &&
           details._children.find(c => c._nodeType === NODE_ELEMENT && c._localName === 'summary' && c._ns === HTML_NS) === el ? 0 : -1;
  },
  focus: (el) => el._focus(),
  blur: (el) => el._blur(),
  get_style: (el) => inlineStyleOf(el),
  installEventHandlers(proto, names, isSelf) { installEventHandlerAttrs(proto, names, inHandlerNamespace, isSelf); }
};

// HTMLElement's members (generated/bindings.js), which dom-class-aliases.js installs onto HTMLElement.
registerInterface('HTMLElement', (o) => isNodeObject(o) && o._nodeType === NODE_ELEMENT && o._ns === HTML_NS);
export const htmlElementMembers = {
  ...htmlOrForeignElementMembers,
  // `translate` is an INHERITED enumerated attribute: an element with no valid one of its own takes its nearest
  // ancestor's, yes at the root. ASCII case-insensitive ('yeſ' is no yes).
  get_translate(el) {
    for (let e = el; e && e._nodeType === NODE_ELEMENT; e = e._parent) {
      const v = e._attrs.translate;
      if (v == null) continue;
      const k = asciiLower(v);
      if (k === 'yes' || k === '') return true;
      if (k === 'no') return false;
    }
    return true;
  },
  set_translate(el, value) { el._setAttribute('translate', value ? 'yes' : 'no'); },
  get_dir: (el) => enumReflectGet(el._attrs.dir, ENUM_DIR, '', ''),
  set_dir(el, value) { el._setAttribute('dir', value); },
  // `hidden` is 'until-found' in the Hidden Until Found state, true in the Hidden state, false with no attribute; the
  // setter's falsy values — false, '', null, 0, NaN — remove it, and any other value but 'until-found' makes it ''.
  get_hidden(el) {
    const v = el._attrs.hidden;
    if (v == null) return false;
    return asciiLower(v) === 'until-found' ? 'until-found' : true;
  },
  set_hidden(el, value) {
    if (typeof value === 'string' && asciiLower(value) === 'until-found') el._setAttribute('hidden', 'until-found');
    else if (value === false || value === '' || value === null || value === 0 || Number.isNaN(value)) el._removeAttribute('hidden');
    else el._setAttribute('hidden', '');
  },
  click: (el) => el._click(),
  // The assigned access key's label, '' when none is: a key is assigned only for a single code point (a multi-token
  // `"s 0"` assigns none in browsers — access-key-label), and the modifier is the platform's, so `Alt+`.
  get_accessKeyLabel(el) {
    const ak = el._attrs.accesskey;
    return ak != null && [...ak].length === 1 ? 'Alt+' + ak : '';
  },
  get_draggable: (el) => isDraggable(el),
  set_draggable(el, value) { el._setAttribute('draggable', value ? 'true' : 'false'); },
  get_spellcheck: (el) => el._attrs.spellcheck !== 'false',
  set_spellcheck(el, value) { el._setAttribute('spellcheck', value ? 'true' : 'false'); },
  // 'false' when this element's writing suggestions are off — its own `writingsuggestions` false, or, with none (or
  // an invalid one), its nearest ancestor's that is true or false — 'true' otherwise.
  get_writingSuggestions(el) {
    for (let e = el; e && e._nodeType === NODE_ELEMENT; e = e._parent) {
      const v = e._attrs.writingsuggestions;
      if (v == null) continue;
      const k = asciiLower(v);
      if (k === 'false') return 'false';
      if (k === 'true' || k === '') return 'true';
    }
    return 'true';
  },
  get_autocapitalize: (el) => AUTOCAPITALIZE_KEYWORDS[ownAutocapitalizationHint(el)],
  get_autocorrect: (el) => usedAutocorrection(el),
  set_autocorrect(el, value) { el._setAttribute('autocorrect', value ? 'on' : 'off'); },
  // The text "as rendered" (rendered.rs: visible only, whitespace collapsed, line breaks from `<br>` and blocks) —
  // its descendant text content when it is not being rendered.
  get_innerText: (el) => globalThis.__csimInnerText(el),
  // (…a value with no line break one Text, or none: the fragment's one child, made without the fragment)
  set_innerText(el, value) {
    const doc = el.ownerDocument;
    el._replaceAll(/[\r\n]/.test(value) ? renderedTextFragment(value, doc) : value === '' ? null : textIn(value, doc));
  },
  get_outerText: (el) => globalThis.__csimInnerText(el),
  // HTML "set the outer text": the element itself replaced by the text's fragment (a lone empty Text when it has
  // none), which then merges with a Text on either side — only those two, not a full normalize.
  set_outerText(el, value) {
    const parent = el._parent;
    if (!parent) {
      throw new globalThis.DOMException("Failed to set the 'outerText' property on 'HTMLElement': The element has no parent.", 'NoModificationAllowedError');
    }
    const next = el._nextSibling, previous = el._previousSibling;
    const fragment = renderedTextFragment(value, el.ownerDocument);
    if (!fragment._children.length) fragment._appendChild(textIn('', el.ownerDocument));
    parent._replaceChild(fragment, el);
    if (next && next._previousSibling && next._previousSibling._nodeType === NODE_TEXT) mergeWithNextText(next._previousSibling);
    if (previous && previous._nodeType === NODE_TEXT) mergeWithNextText(previous);
  },
  // HTML `attachInternals()`: a DEFINED autonomous custom element's ElementInternals, once. A customized built-in
  // (`<h2 is="…">`) has no hyphen in its local name, so it finds no definition and is refused with the rest (its `is`
  // value — always null for an autonomous one — is never read).
  attachInternals(el) {
    const def = el._ns === HTML_NS ? getCustomElementCtor(el._localName) : null;
    if (!def) {
      throw new globalThis.DOMException("Failed to execute 'attachInternals' on 'HTMLElement': Unable to attach ElementInternals to non-custom elements.", 'NotSupportedError');
    }
    let df; try { df = def.disabledFeatures; } catch (_) { df = null; }
    if (df && typeof df.indexOf === 'function' && df.indexOf('internals') !== -1) {
      throw new globalThis.DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals is disabled by disabledFeatures static field.", 'NotSupportedError');
    }
    if (el._internals) {
      throw new globalThis.DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals for the specified element was already attached.", 'NotSupportedError');
    }
    return el._internals = new ElementInternals(PLATFORM, el);
  },
  // The Popover API: a UA `:popover-open` state (no attribute backs it), flipped with `beforetoggle` / `toggle`.
  showPopover(el) { showPopover(el, 'showPopover'); },
  hidePopover(el) { hidePopover(el, 'hidePopover'); },
  // (…the force a boolean's, or the options' `force`; with none, the other state)
  togglePopover(el, options) {
    const force = typeof options === 'boolean' ? options : options.force;
    if (hasState(el, STATE_POPOVER_OPEN) && force !== true) hidePopover(el, 'togglePopover');
    else if (force !== false) showPopover(el, 'togglePopover');
    else checkPopoverValidity(el, false, 'togglePopover');
    return hasState(el, STATE_POPOVER_OPEN);
  },
  // `popover` reflects its attribute limited to the known values: null with none, 'manual' for an invalid one.
  get_popover: (el) => enumReflectGet(el._attrs.popover, ENUM_POPOVER, null, 'manual'),
  set_popover(el, value) { if (value === null) el._removeAttribute('popover'); else el._setAttribute('popover', value); },
  // CSSOM View's offsets (geometry.rs `offsets`): the border-box size; the offsetParent — the nearest positioned
  // ancestor or the body, or a static element's nearest td / th / table, null for the body, the root and a fixed box —
  // and the position from its padding edge (a static body's: the document's), in layout space, which no scroll or
  // transform moves. An element with no box — not rendered, `display: contents`, a light child no slot takes — has
  // none of it: null and 0s.
  get_offsetParent: (el) => offsetsOf(el).parent,
  get_offsetTop: (el) => offsetsOf(el).top,
  get_offsetLeft: (el) => offsetsOf(el).left,
  get_offsetWidth: (el) => offsetsOf(el).width,
  get_offsetHeight: (el) => offsetsOf(el).height,
  // `contentEditable` is `contenteditable`'s state — 'inherit' with none or an invalid one — and the setter takes
  // only those four keywords, ASCII case-insensitively: 'inherit' removes it, anything else is a SyntaxError.
  get_contentEditable: (el) => enumReflectGet(el._attrs.contenteditable, ENUM_CONTENT_EDITABLE, 'inherit', 'inherit'),
  set_contentEditable(el, value) {
    const k = asciiLower(value);
    if (k === 'inherit') el._removeAttribute('contenteditable');
    else if (k === 'true' || k === 'false' || k === 'plaintext-only') el._setAttribute('contenteditable', k);
    else throw new globalThis.DOMException("Failed to set the 'contentEditable' property on 'HTMLElement': The value provided ('" + value + "') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.", 'SyntaxError');
  },
  get_enterKeyHint: (el) => enumReflectGet(el._attrs.enterkeyhint, ENUM_ENTER_KEY_HINT, '', ''),
  set_enterKeyHint(el, value) { el._setAttribute('enterkeyhint', value); },
  get_isContentEditable: (el) => isContenteditable(el),
  get_inputMode: (el) => enumReflectGet(el._attrs.inputmode, ENUM_INPUT_MODE, '', ''),
  set_inputMode(el, value) { el._setAttribute('inputmode', value); },
  get_virtualKeyboardPolicy: (el) => el._attrs.virtualkeyboardpolicy || '',
  set_virtualKeyboardPolicy(el, value) { el._setAttribute('virtualkeyboardpolicy', value); }
};

registerInterface('SVGElement', (o) => isNodeObject(o) && o._nodeType === NODE_ELEMENT && o._ns === SVG_NS);
// (…and SVG's `<image>`, which a conversion asks for — `createImageBitmap`'s source — though no SVG element has an
// interface of its own here)
registerInterface('SVGImageElement', (o) => isNodeObject(o) && o._nodeType === NODE_ELEMENT && o._ns === SVG_NS && o._localName === 'image');
// SVGElement's: an SVG element's `className` an SVGAnimatedString reflecting `class` ([SameObject]), and the nearest
// `<svg>` ancestor its owner and its viewport's element — null for the outermost one.
export const svgElementMembers = {
  ...htmlOrForeignElementMembers,
  get_className: (el) => el._svgClassName || (el._svgClassName = svgAnimatedString.create(el, 'class')),
  get_ownerSVGElement: (el) => nearestSvgAncestor(el),
  get_viewportElement: (el) => nearestSvgAncestor(el)
};

// MathMLElement's are only the ones it shares.
registerInterface('MathMLElement', (o) => isNodeObject(o) && o._nodeType === NODE_ELEMENT && o._ns === MATHML_NS);
export const mathMLElementMembers = htmlOrForeignElementMembers;

function nearestSvgAncestor(el) {
  for (let e = el._parent; e && e._nodeType === NODE_ELEMENT; e = e._parent) {
    if (e._ns === SVG_NS && e._localName === 'svg') return e;
  }
  return null;
}

// `draggable`'s value — an `<img>`'s, and an `<a>` / `<area>` with an href's, true when the attribute says neither.
// An HTML element's alone (HTMLElement's member): no other is ever dragged.
export function isDraggable(el) {
  if (el._ns !== HTML_NS) return false;
  const v = el._attrs.draggable;
  if (v != null) return v === 'true';
  const t = el._tag;
  return t === 'img' || ((t === 'a' || t === 'area') && hrefAttr(el) != null);
}

// HTML "check popover validity": false where the popover already is as asked (shown, or hidden); a NotSupportedError
// for an element with no `popover`, an InvalidStateError for one disconnected or an open `<dialog>`.
function checkPopoverValidity(el, expectedToBeShowing, method) {
  if (el._attrs.popover == null) {
    throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': Not supported on elements that do not have a valid value for the 'popover' attribute.`, 'NotSupportedError');
  }
  if (hasState(el, STATE_POPOVER_OPEN) !== expectedToBeShowing) return false;
  if (!isConnected(el) || (el._localName === 'dialog' && el._ns === HTML_NS && el._attrs.open != null)) {
    throw new globalThis.DOMException(`Failed to execute '${method}' on 'HTMLElement': Invalid on disconnected popover elements.`, 'InvalidStateError');
  }
  return true;
}
// HTML "show popover" / "hide popover": a cancelable `beforetoggle` before it shows — which a listener cancels, or
// leaves it no longer valid to show — and an uncancelable one before it hides, then `:popover-open` and a queued `toggle`.
function showPopover(el, method) {
  if (!checkPopoverValidity(el, false, method)) return;
  if (!fireBeforeToggle(el, true) || !checkPopoverValidity(el, false, method)) return;
  setPopoverState(el, true);
}
function hidePopover(el, method) {
  if (!checkPopoverValidity(el, true, method)) return;
  fireBeforeToggle(el, false);
  if (!checkPopoverValidity(el, true, method)) return;
  setPopoverState(el, false);
}
function setPopoverState(el, open) {
  setStateBit(el, STATE_POPOVER_OPEN, open);
  bumpStyleState();                                   // `:popover-open`, backed by no attribute
  queueToggleTask(el, open ? 'closed' : 'open', open ? 'open' : 'closed');
}

// HTML autocapitalization and autocorrection: an element's own state, else — for a button, fieldset, input, output,
// select or textarea with a form owner — that form's, else the default (autocorrection on). (An empty
// `autocapitalize` is no state of its own; any `autocorrect` is.)
const AUTOCAPITALIZE_INHERITING = new Set(['button', 'fieldset', 'input', 'output', 'select', 'textarea']);
const AUTOCAPITALIZE_STATES = { off: 'none', none: 'none', on: 'sentences', sentences: 'sentences', words: 'words', characters: 'characters' };
const AUTOCAPITALIZE_KEYWORDS = { default: '', none: 'none', sentences: 'sentences', words: 'words', characters: 'characters' };
function inheritingFormOwner(el) {
  return el._ns === HTML_NS && AUTOCAPITALIZE_INHERITING.has(el._localName) ? formForControl(el) : null;
}
function ownAutocapitalizationHint(el) {
  const v = el._attrs.autocapitalize;
  if (v != null && v !== '') return AUTOCAPITALIZE_STATES[asciiLower(v)] || 'sentences';
  const form = inheritingFormOwner(el);
  return form ? ownAutocapitalizationHint(form) : 'default';
}
const AUTOCORRECT_OFF_TYPES = new Set(['url', 'email', 'password']);
function usedAutocorrection(el) {
  if (el._tag === 'input' && AUTOCORRECT_OFF_TYPES.has(inputTypeState(el))) return false;
  // (…an attribute present its state — On but for `off`: its invalid value default is On, not the form's)
  const v = el._attrs.autocorrect;
  if (v != null) return asciiLower(v) !== 'off';
  const form = inheritingFormOwner(el);
  return form ? usedAutocorrection(form) : true;
}

// HTML "rendered text fragment": the text's runs as Text nodes, each LF, CR or CRLF a `<br>`, in `doc`.
function renderedTextFragment(input, doc) {
  const fragment = new DocumentFragment();
  fragment._ownerDoc = doc;
  const runs = input.split(/\r\n|\r|\n/);
  runs.forEach((run, i) => {
    if (i > 0) {
      const br = createElementNode('br');
      br._ownerDoc = doc;
      fragment._appendChild(br);
    }
    if (run !== '') fragment._appendChild(textIn(run, doc));
  });
  return fragment;
}
function textIn(data, doc) {
  const t = new Text(data);
  t._ownerDoc = doc;
  return t;
}
// HTML "merge with the next text node": a Text's following Text sibling appended to it and removed.
function mergeWithNextText(text) {
  const next = text._nextSibling;
  if (!next || next._nodeType !== NODE_TEXT) return;
  text._replaceData(text._data.length, 0, next._data);
  next._parent._removeChild(next);
}

// HTMLOrSVGElement's `dataset`: a DOMStringMap over the element's NULL-namespace `data-*` attributes, read through on
// every access — `dataset.fooBar` ↔ `data-foo-bar`. ([SameObject]: one per element.)
function datasetOf(el) {
  if (el._datasetProxy) return el._datasetProxy;
  // The spec conversions fold a U+002D HYPHEN-MINUS only before an ASCII
  // lower ALPHA (a-z) — NOT before a digit, so `data-a-1` ↔ name `a-1`.
  const toAttr   = (k) => 'data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const fromAttr = (n) => n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  // A property name is a supported one iff it round-trips through the
  // attribute conversion — equivalently, iff it has no U+002D HYPHEN-MINUS
  // followed by an ASCII lower alpha (those are exactly the names a `data-*`
  // attribute can never produce, since the kebab→camelCase step would have
  // folded them away). Names that don't round-trip (e.g. `-foo`) aren't
  // supported, so they read as undefined and delete is a no-op. This matches
  // `setNamed`'s SyntaxError gate and avoids a toAttr→fromAttr double
  // conversion on the hot read.
  const roundTrips = (k) => !/-[a-z]/.test(k);
  // The named setter (HTML's steps, its value converted first, Web IDL's): a name with U+002D before an ASCII lower
  // alpha is ambiguous with the camelCase→`data-*` conversion → SyntaxError; dataset writes the NULL-namespace
  // attribute — both paths validate the resulting name (InvalidCharacterError for e.g. an embedded space), the common
  // one setAttribute, and only where a namespaced attribute is present the null-namespace value setter (so a
  // same-named foreign-namespace attribute is not overwritten).
  const setNamed = (key, value) => {
    value = toDOMString(value, false, `Failed to set a named property '${key}' on 'DOMStringMap': `);
    if (/-[a-z]/.test(key)) {
      throw new globalThis.DOMException(
        `Failed to set a named property '${key}' on 'DOMStringMap': '${key}' is not a valid property name.`,
        'SyntaxError');
    }
    const attr = toAttr(key);
    if (el._attrNS) el._setAttrValueNullNS(attr, value);
    else el._setAttribute(attr, value);
  };
  const proxy = el._datasetProxy = new Proxy(Object.create(DOMStringMap.prototype), {
    get(t, key, recv) {
      // A `data-*` attribute wins over the prototype chain; otherwise fall
      // through so `toString` / page-set Object.prototype expandos show. Only
      // a supported property name (one that round-trips) maps to an attribute
      // — `dataset['-foo']` is undefined even when `data--foo` exists (that
      // attribute maps to the name `Foo`). dataset reads the NULL-namespace
      // attribute ("get an attribute value"): the bare store key is
      // authoritative only when no namespaced attribute exists, else it may
      // hold a same-named attribute in another namespace.
      if (typeof key === 'string' && roundTrips(key)) {
        const attr = toAttr(key);
        const v = el._attrNS ? el._getAttributeNS(null, attr) : el._attrs[attr];
        if (v != null) return v;
      }
      return Reflect.get(t, key, recv);
    },
    // [[Set]] (Web IDL §3.9.2): the named setter where the map itself is the receiver, any other — an object it is the
    // prototype of — the ordinary steps.
    set(t, key, value, recv) {
      if (typeof key !== 'string' || recv !== proxy) return Reflect.set(t, key, value, recv);
      setNamed(key, value);
      return true;
    },
    // [[DefineOwnProperty]] (§3.9.3, [LegacyOverrideBuiltIns] with a named setter): a data descriptor's value set
    // through the named setter, whatever else it says; an accessor or a generic descriptor refused. (A non-configurable
    // one is set too, but answered false: a Proxy may not report a non-configurable property its target lacks.)
    defineProperty(t, key, desc) {
      if (typeof key !== 'string') return Reflect.defineProperty(t, key, desc);
      if (!('value' in desc) && !('writable' in desc)) return false;
      setNamed(key, desc.value);
      return desc.configurable !== false;
    },
    deleteProperty(t, key) {
      // Only a supported property name (one that round-trips) maps to a
      // removable attribute; `delete dataset['-foo']` must leave `data--foo`
      // (which maps to the name `Foo`) untouched. (dataset-delete.html)
      // Removes the NULL-namespace attribute (gated like get/set).
      if (typeof key === 'string' && roundTrips(key)) {
        const attr = toAttr(key);
        if (el._attrNS) el._removeAttributeNS(null, attr);
        else el._removeAttribute(attr);
        return true;
      }
      return Reflect.deleteProperty(t, key);
    },
    has(t, key) {
      if (typeof key === 'string' && roundTrips(key)) {
        const attr = toAttr(key);
        if (el._attrNS ? el._attrKeyByNS(null, attr) != null
                       : Object.prototype.hasOwnProperty.call(el._attrs, attr)) return true;
      }
      return Reflect.has(t, key);   // prototype chain (toString, expandos)
    },
    ownKeys(t) {
      // Supported property names = the element's NULL-namespace `data-*`
      // attributes whose name has NO ASCII upper alpha after `data-` (a
      // `data-Foo` attribute is unreachable via the property mapping, so it is
      // not a supported property name and must not be enumerated). The fast
      // path's store keys ARE the qualified names; with namespaced attributes
      // present, skip non-null-ns ones and recover each null-ns attribute's
      // local name from `_attrNS`. (`data-` is all-lowercase, so testing the
      // whole name for an upper alpha is equivalent to testing the suffix.)
      // (…then its own symbol-keyed properties, a page's expandos: a string-keyed one is a named property)
      if (!el._attrNS) {
        const names = Object.keys(el._attrs).filter((n) => n.startsWith('data-') && !/[A-Z]/.test(n)).map(fromAttr);
        return [...names, ...Reflect.ownKeys(t)];
      }
      const out = [];
      for (const k in el._attrs) {
        const meta = el._attrNS[k];
        if (meta && meta.ns !== null) continue;
        const ln = meta ? meta.localName : k;
        if (ln.startsWith('data-') && !/[A-Z]/.test(ln)) out.push(fromAttr(ln));
      }
      return [...out, ...Reflect.ownKeys(t)];
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === 'string' && roundTrips(key)) {
        const attr = toAttr(key);
        const v = el._attrNS ? el._getAttributeNS(null, attr) : el._attrs[attr];
        if (v != null) return { writable: true, enumerable: true, configurable: true, value: v };
      }
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    // (…never made non-extensible: the named properties come and go, Web IDL §3.9.4)
    preventExtensions: () => false
  });
  makeSlots(proxy, 'DOMStringMap', { element: el });
  return proxy;
}

// An element's padding edge in the viewport (its border box, past its left and top borders) — a mouse event's offset
// is from it (events.js, which imports none of the layout, asks through this hook). An inline's the block it is laid out
// in: a non-replaced inline box has no padding edge of its own to measure from (Chrome's and Firefox's,
// MouseEvent-prototype-offsetX-offsetY: a span's offset from its container's; an `<img>`'s its own).
globalThis.__csimPaddingEdgeOrigin = (el) => {
  let box = el;
  while (displayAsLaidOut(usedDisplay(box), renderingTag(box)) === 'inline' && !isReplacedOrControl(renderingTag(box))) {
    const parent = flatTreeParent(box);
    if (!parent || parent._nodeType !== NODE_ELEMENT) break;
    box = parent;
  }
  const r = rectOf(box), b = clientBox(box);
  return { x: r.x + b.left, y: r.y + b.top };
};

// HTMLFormElement named/indexed-property exotic object. A `<form>` exposes its
// controls by `name`/`id` (`form.foo`, `el.form.foo` — Redmine's column-mover
// reads `this.form.selected_columns`) and by index (`form[i]`), per the WebIDL
// legacy platform object rules: [LegacyOverrideBuiltins] (a control named
// "submit" shadows `form.submit`), [LegacyUnenumerableNamedProperties], and a
// "past names map" (a control keeps resolving under an old name after a rename).
//
// `Object.getOwnPropertyDescriptor(form, name)` / `defineProperty` / `delete`
// must see the named props as the form's OWN properties — which only an exotic
// object on the form ITSELF can provide — so each <form> is wrapped in a Proxy
// at construction (the ctor returns it, so it is the single canonical reference:
// `el.form === form`, handles, `===`, formForControl all hold). MEASURED: forms
// are rare enough that the per-form Proxy adds no observable suite-wall cost
// (Redmine/Avo within noise); a form's own field reads (`_tag`/`_children`) do
// go through the trap, but forms are a tiny fraction of the elements find /
// cascade walk, so the div/span hot path is untouched (rule 3). This is the
// option the older shared-FormNamedProto comment rejected as "per-form Proxy …
// megamorphic" — but the form TARGET keeps ONE shape (the trap forwards), so
// there is no megamorphism, only the (measured-negligible) trap indirection.
const FORM_GATE_TAGS    = new Set(['input', 'button', 'fieldset', 'object', 'output', 'select', 'textarea', 'img']);
const FORM_NAMED_VALUES = new Set();   // name/id values seen on a form-associatable element — gates the O(document) candidate scan
const FORM_INDEX_RE     = /^(?:0|[1-9]\d*)$/;
const formProxyOf       = new WeakMap();   // form TARGET → its Proxy (the canonical form), for traps without a receiver
// Per-form internal state kept in WeakMaps (keyed by the Proxy), NOT as `_`-prefixed
// fields on the form — reading such a field through the Proxy would re-enter the
// named-getter trap (and a control named "ownerDocument"/"_x" could even recurse).
const formPastNames  = new WeakMap();   // form → Map(name → element): names persist after a control is renamed
const formNamedLists = new WeakMap();   // form → Map(name → live NodeList): [SameObject] for repeated `form.<radio>`
const formCandMemo   = new WeakMap();   // form → {gen, map: Map(name → element[])}: per-settle-gen memo of the named-candidate scan

// A "listed" form control for `form.elements` / `fieldset.elements` membership: one
// of the built-in listed elements (excluding input[type=image], which the callers
// reject separately) OR a form-associated custom element. The CE arm is gated by
// the module flag inside isFormAssociatedCustomElement, so a page with no
// form-associated element pays a single Set lookup here (rule 3).

// Is `el` an eligible named/indexed item of `form`: a listed element (NOT
// input[type=image]) whose form owner is `form`, or an <img> descendant of it.
function isFormNamedCandidate(form, el) {
  if (!el || el._nodeType !== NODE_ELEMENT) return false;
  const t = el._tag;
  if (t === 'img') {
    // Containment via the own `_parent` chain — NOT `nodeContains(form, el)`,
    // whose `form.contains(el)` would re-enter the proxy and could recurse if a
    // control were named "contains".
    if (el === form) return false;
    for (let p = el._parent; p; p = p._parent) if (p === form) return true;
    return false;
  }
  if (!isListedFormControl(el)) return false;
  if (t === 'input' && (el._attrs.type || '').toLowerCase() === 'image') return false;
  return formForControl(el) === form;
}

// `form.elements` membership: the LISTED elements (excl input[type=image]) whose
// form owner is `form`, in tree order. Owner-based (not subtree) so a control
// associated via `form="<id>"` from outside the subtree is included and a control
// in a different shadow tree is excluded (formForControl resolves `form=` within
// the control's own root). Backs the live HTMLFormControlsCollection (cached per
// settle generation by the collection, so the document walk is amortised).

// `fieldset.elements` membership: the listed-element DESCENDANTS of the fieldset
// (including nested fieldsets and their controls), in tree order — rooted at the
// fieldset, not by form owner (HTMLFieldSetElement.elements is a plain HTMLCollection).
function fieldsetControlElements(fieldset) {
  const out = [];
  walkSubtree(fieldset, el => {
    if (el === fieldset || el._nodeType !== NODE_ELEMENT) return;
    if (isListedFormControl(el)) out.push(el);
  });
  return out;
}

// The form's indexed-property list (form[i] / length / has / ownKeys / descriptors
// / delete). It is exactly `form.elements` (the cached, [SameObject]
// HTMLFormControlsCollection), read via Reflect so (a) a control named "elements"
// can't shadow it through the proxy, and (b) it is the SINGLE source of truth —
// form[i] === form.elements[i] and form.length === form.elements.length always
// agree (form-indexed-element). `t` is the form target.
function formIndexedElements(t) {
  // Receiver MUST be the form's Proxy, not the raw target: the `elements` getter
  // builds its collection with `formForControl(el) === this`, and a control's form
  // owner is the Proxy (the canonical form). Reading with the target as receiver
  // would match nothing.
  const form = formProxyOf.get(t) || t;
  return Reflect.get(t, 'elements', form) || EMPTY_NODES;
}

// The form's named candidates for `name` (listed-non-image by form owner + <img>
// descendants), in tree order. Gated by FORM_NAMED_VALUES so an unregistered name
// is O(1) (no document walk) — mirrors WindowNamedProps — and memoised per
// (form, tree generation) so a registered name that collides with a hot builtin
// (e.g. an `<input name=action>` somewhere makes `form.action` gated) costs ONE
// document scan per generation, not one per read (rule 3). Any DOM mutation, the
// parser's included, moves the tree generation, dropping the memo, so results stay live.
function formNamedCandidates(form, name) {
  if (!FORM_NAMED_VALUES.has(name)) return EMPTY_NODES;
  const gen = currentNodesGen();
  let memo = formCandMemo.get(form);
  if (!memo || memo.gen !== gen) { memo = { gen, map: new Map() }; formCandMemo.set(form, memo); }
  const cached = memo.map.get(name);
  if (cached) return cached;
  const out  = [];
  // The form's own root node (shadow root or document), not `_ownerDoc` — so a
  // shadow-resident form resolves its named controls (and `form=` controls share
  // the form's tree). Detached → the form's subtree.
  const root = isConnected(form) ? form.getRootNode() : form;
  walkSubtree(root, el => {
    if (el === root || el._nodeType !== NODE_ELEMENT) return;
    if ((el._attrs.name === name || el._attrs.id === name) && isFormNamedCandidate(form, el)) out.push(el);
  });
  memo.map.set(name, out);
  return out;
}

// HTML form named getter: one candidate → the element (recorded in the past
// names map); several → a cached [SameObject] live RadioNodeList; none → the past
// names map (an element keeps resolving under an old name while it stays an
// eligible control of the form), else undefined.
function formNamedItem(form, name) {
  const cands = formNamedCandidates(form, name);
  if (cands.length === 1) {
    let pm = formPastNames.get(form);
    if (!pm) formPastNames.set(form, pm = new Map());
    pm.set(name, cands[0]);
    return cands[0];
  }
  if (cands.length > 1) {
    let lm = formNamedLists.get(form);
    if (!lm) formNamedLists.set(form, lm = new Map());
    let nl = lm.get(name);
    if (!nl) { nl = liveRadioNodeList(() => formNamedCandidates(form, name)); lm.set(name, nl); }
    return nl;
  }
  const pm = formPastNames.get(form);
  const past = pm && pm.get(name);
  if (past !== undefined) {
    if (isFormNamedCandidate(form, past)) return past;
    pm.delete(name);
  }
  return undefined;
}

// Shared handler for every <form>'s Proxy. Each trap derives the canonical form
// from the receiver (get/set) or `formProxyOf` (the rest), so ONE handler object
// serves all forms (no per-form handler → no megamorphism on the handler).
const FORM_HANDLER = {
  get(t, prop, recv) {
    // OverrideBuiltins: a named control shadows a prototype builtin (form.submit →
    // <input name=submit>) and an index → the listed element. Per WebIDL only an
    // AUTHOR own property (an expando) blocks the named lookup — and the driver's
    // internal own fields (`_tag`/`_children`/`_ownerDoc`/`_nodeType`/…) are all
    // own, so the `hasOwnProperty` check below already fast-paths them to the
    // target (cheap and recursion-safe: the driver reads a form's type as `_nodeType`,
    // while `form.nodeType`, Node.prototype's, a named control overrides). NOTE: do NOT also skip on a
    // leading `_` — author control names may start with one (Rails `_method`,
    // `..._destroy`), and those must resolve via the named getter.
    if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(t, prop)) {
      if (FORM_INDEX_RE.test(prop)) {
        const els = formIndexedElements(t), i = +prop;
        if (i < els.length) return els[i];
      } else {
        const named = formNamedItem(recv, prop);
        if (named !== undefined) return named;
      }
    }
    return Reflect.get(t, prop, recv);
  },
  set(t, prop, val, recv) {
    // A current named property can't be overwritten by an expando (the named
    // getter wins); every other write (fields, expandos, id/name reflectors) is
    // an ordinary set.
    if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(t, prop) &&
        !FORM_INDEX_RE.test(prop) && formNamedItem(recv, prop) !== undefined) {
      return false;
    }
    return Reflect.set(t, prop, val, recv);
  },
  has(t, prop) {
    if (Reflect.has(t, prop)) return true;
    if (typeof prop === 'string') {
      if (FORM_INDEX_RE.test(prop)) return (+prop) < formIndexedElements(t).length;
      return formNamedItem(formProxyOf.get(t) || t, prop) !== undefined;
    }
    return false;
  },
  getOwnPropertyDescriptor(t, prop) {
    const own = Reflect.getOwnPropertyDescriptor(t, prop);
    if (own) return own;
    if (typeof prop === 'string') {
      if (FORM_INDEX_RE.test(prop)) {
        const els = formIndexedElements(t), i = +prop;
        if (i < els.length) return { value: els[i], writable: false, enumerable: true, configurable: true };
      } else {
        const named = formNamedItem(formProxyOf.get(t) || t, prop);
        // LegacyUnenumerableNamedProperties: named props are non-enumerable.
        if (named !== undefined) return { value: named, writable: false, enumerable: false, configurable: true };
      }
    }
    return undefined;
  },
  defineProperty(t, prop, desc) {
    if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(t, prop)) {
      // A supported index or a current named property can't be redefined by an
      // author descriptor (legacy platform object) → false, so a strict define throws.
      if (FORM_INDEX_RE.test(prop)) { if ((+prop) < formIndexedElements(t).length) return false; }
      else if (formNamedItem(formProxyOf.get(t) || t, prop) !== undefined) return false;
    }
    return Reflect.defineProperty(t, prop, desc);
  },
  deleteProperty(t, prop) {
    if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(t, prop)) {
      // A supported index (in range) or a current named property can't be deleted
      // (legacy platform object) → false, so a strict `delete` throws.
      if (FORM_INDEX_RE.test(prop)) { if ((+prop) < formIndexedElements(t).length) return false; }
      else if (formNamedItem(formProxyOf.get(t) || t, prop) !== undefined) return false;
    }
    return Reflect.deleteProperty(t, prop);
  },
  ownKeys(t) {
    const keys = [];
    const n = formIndexedElements(t).length;
    for (let i = 0; i < n; i++) keys.push(String(i));   // indexed props are enumerable own properties
    for (const k of Reflect.ownKeys(t)) if (keys.indexOf(k) === -1) keys.push(k);   // fields + expandos (named props stay unenumerable)
    return keys;
  }
};

// Wrap a freshly-constructed <form> target in its named-property Proxy and record
// the target→Proxy mapping. Called from the Element constructor.
function makeFormProxy(target) {
  const proxy = new Proxy(target, FORM_HANDLER);
  formProxyOf.set(target, proxy);
  target.__csimSelf = proxy;   // (…the node a script holds is the Proxy)
  return proxy;
}

// HTMLSelectElement-only methods live on a prototype shared by every <select>
// (inserted between the select and Element.prototype) rather than on
// Element.prototype, so they don't leak onto other elements — `'item' in form`
// / `'namedItem' in div` must be false (they're select-only per WebIDL).
// `item` / `namedItem` delegate to the select's HTMLOptionsCollection (one
// implementation of the index / id-then-name lookup + the empty-string guard).

// Per-interface element prototypes (HTMLButtonElement.prototype, …), so each
// tag-specific IDL member lives on the interface that owns it — `'readOnly' in
// button` is false and `getOwnPropertyDescriptor(HTMLTemplateElement.prototype,
// 'shadowRootMode')` is the descriptor (both spec). An element is BORN with its
// interface's prototype: `createElementNode` constructs it with a `new.target` whose
// `prototype` is the interface's (`Reflect.construct` reads nothing else of it), keyed
// on the tag here (installDomClassAliases fills it). Swapped in afterwards, the
// prototype cost every element a map transition V8 resolves in its runtime — a
// tenth of a page's DOMParser parse. The target is a function of its own, never the
// interface class: V8 caches the map it derives for a `new.target` only while that
// function's initial map is the allocating constructor's, and an interface a custom
// element's `super()` has constructed through holds one of its own — every element
// would then get a fresh map. Per-tag maps don't regress the hot read paths: they
// read OWN fields, whose offsets are identical across tags.
const ELEMENT_TARGETS = new Map();
const TARGETS = new Set([Element]);
export function registerTagTarget(tag, proto) {
  const target = function () {};
  target.prototype = proto;
  ELEMENT_TARGETS.set(tag, target);
  TARGETS.add(target);
}
// …and the interfaces an element with no tag interface of its own is made with, by namespace (dom-class-aliases.js
// registers them): HTMLElement for a known HTML name with none and for a valid custom element name not defined yet,
// HTMLUnknownElement for any other HTML name, SVGElement, MathMLElement.
const NAMESPACE_TARGETS = {};
export function registerNamespaceTargets(protos) {
  for (const [key, proto] of Object.entries(protos)) {
    const target = function () {};
    target.prototype = proto;
    TARGETS.add(target);
    NAMESPACE_TARGETS[key] = target;
  }
}
// Whether `newTarget` constructs a plain element of the driver's (any interface), not a custom element subclass.
function isElementTarget(newTarget) { return TARGETS.has(newTarget); }
// An element as `new Element(tagName, ns, localName, prefix)` makes one, with the prototype of its interface: an HTML
// element whose local name is its canonical (lowercase) tag takes its tag's, and any other its namespace's — an HTML
// one HTMLElement or HTMLUnknownElement (`createElementNS(HTML_NS, 'DIV')` is unknown), an SVG one SVGElement, a
// MathML one MathMLElement — and one in no namespace of those an Element.
export function createElementNode(tagName, ns = HTML_NS, localName = undefined, prefix = null) {
  let target;
  if (ns === HTML_NS) {
    // (…by its local name, case and all — an XML parse's `<h:form>` is a form, a `createElementNS(HTML_NS, 'DIV')` none)
    const name = localName === undefined ? asciiLower(String(tagName)) : localName;
    target = ELEMENT_TARGETS.get(name) ||
      (KNOWN_HTML_TAGS.has(name) || name.indexOf('-') !== -1 && isValidCustomElementName(name)
        ? NAMESPACE_TARGETS.html : NAMESPACE_TARGETS.htmlUnknown);
  } else if (ns === SVG_NS) {
    target = NAMESPACE_TARGETS.svg;
  } else if (ns === MATHML_NS) {
    target = NAMESPACE_TARGETS.mathml;
  }
  if (target === undefined) target = Element;
  return target === Element ? new Element(tagName, ns, localName, prefix) : Reflect.construct(Element, [tagName, ns, localName, prefix], target);
}
const SelectProtoTarget = Object.create(Element.prototype);
Object.defineProperty(SelectProtoTarget, 'item', {
  configurable: true, writable: true,
  value(index) { const o = this.options; return o ? o.item(index) : null; }
});
Object.defineProperty(SelectProtoTarget, 'namedItem', {
  configurable: true, writable: true,
  value(name) { const o = this.options; return o ? o.namedItem(name) : null; }
});
// HTMLSelectElement supports indexed properties (its options). The select stays
// a PLAIN object — identity is preserved (no per-element Proxy, no handle/`===`
// hazard) — and instead its SHARED prototype is a Proxy whose `get` trap maps an
// array-index to the receiver's `options[i]`. Crucially, instance field reads
// (`_tag` / `_children` / `_attrs` / …) are OWN properties, so they're found on
// the select directly and NEVER reach this trap; only `select[i]` and the (rare)
// method / getter lookups on a <select> traverse it. The div/span hot path and
// every element's field reads stay Proxy-free (rule 3).
const SELECT_INDEX_RE = /^(?:0|[1-9]\d*)$/;
const SelectProto = new Proxy(SelectProtoTarget, {
  get(t, prop, recv) {
    if (typeof prop === 'string' && SELECT_INDEX_RE.test(prop)) {
      const opts = recv.options, i = +prop;
      return (opts && i < opts.length) ? opts[i] : undefined;
    }
    return Reflect.get(t, prop, recv);
  },
  set(t, prop, val, recv) {
    // HTMLSelectElement indexed property setter (`select[i] = option | null`)
    // delegates to the options collection's setter. Without this trap the
    // default [[Set]] would plant a stray own data property `i` on the select
    // instance, shadowing the indexed getter.
    if (typeof prop === 'string' && SELECT_INDEX_RE.test(prop)) {
      const opts = recv.options;
      if (opts) opts[+prop] = val;
      return true;
    }
    return Reflect.set(t, prop, val, recv);
  }
});
// Chain the select prototype through HTMLSelectElement.prototype once the
// interface prototypes exist (installDomClassAliases), so relocated select IDL
// members (name, selectedIndex, add, …) are inherited: select → SelectProto →
// SelectProtoTarget → HTMLSelectElement.prototype → Element.prototype.
// item / namedItem stay own on SelectProtoTarget.
// A `<select>` is born with it (`createElementNode`).
// …and HTMLSelectElement's own `remove`, of its two overloads: `remove()` ChildNode's (the select itself detached),
// `remove(index)` its index-th option's (none out of range) — told apart by how many arguments are passed (Web IDL
// §3.7.7), so its `length` is 0.
export function reparentSelectProto(selectInterfaceProto) {
  Object.setPrototypeOf(SelectProtoTarget, selectInterfaceProto);
  Object.defineProperty(selectInterfaceProto, 'remove', {
    configurable: true, enumerable: true, writable: true,
    value: function remove() {
      if (this == null || this._tag !== 'select' || this._ns !== HTML_NS) throw new TypeError('Illegal invocation');
      if (arguments.length === 0) { childNodeRemove(this); return; }
      const options = listOfOptions(this), index = toLong(arguments[0], "Failed to execute 'remove' on 'HTMLSelectElement': ");
      if (index >= 0 && index < options.length) options[index]._parent._removeChild(options[index]);
    }
  });
  registerTagTarget('select', SelectProto);
}
// Gate the form named-property lookup: record any name/id value seen on a
// form-associatable element, so `form.<unregistered>` is O(1) (a Set miss) and
// never walks the document. The form Proxy's traps resolve existence + value
// live against the tree (FORM_HANDLER / formNamedItem) — never frozen into a
// getter — so the value is always current, a control associated via `form="…"`
// outside the form subtree is found, same-named controls yield a RadioNodeList,
// and a cross-realm-adopted control still resolves.
function registerFormName(el, value) {
  if (value && (FORM_GATE_TAGS.has(el._tag) || isFormAssociatedCustomElement(el))) FORM_NAMED_VALUES.add(value);
}

// HTML "reset the form owner" reaction for a form-associated custom element. It (a)
// registers the element's name/id for the form named getter — the parse-time
// registerFormName ran before the element was form-associated, so an element upgraded
// after parse would otherwise be missing from formNamedItem — and (b) recomputes the
// form owner, firing formAssociatedCallback(newOwner) only when it changed from the
// cached `_ceFormOwner` (undefined ≡ null ≡ "no owner"). The change guard makes the
// call idempotent, so the overlapping upgrade/connect seams don't double-fire.
function resetCustomElementFormOwner(el) {
  if (!isFormAssociatedCustomElement(el)) return;
  // Registering the name/id and/or changing the owner alters what the live
  // form.elements / fieldset.elements collections and the form named getter
  // return, but neither is a tree mutation — so bump the settle generation to drop
  // their per-generation caches. Needed for the explicit `customElements.upgrade()`
  // path (a parse or DOM insertion already bumps), where an element becomes a
  // member with no accompanying mutation.
  let membershipChanged = false;
  const nm = el._attrs.name, id = el._attrs.id;
  if (nm && !FORM_NAMED_VALUES.has(nm)) { FORM_NAMED_VALUES.add(nm); membershipChanged = true; }
  if (id && !FORM_NAMED_VALUES.has(id)) { FORM_NAMED_VALUES.add(id); membershipChanged = true; }
  const newOwner = formForControl(el) || null;
  const oldOwner = el._ceFormOwner || null;
  if (newOwner !== oldOwner) {
    el._ceFormOwner = newOwner;
    membershipChanged = true;
    const fn = el.formAssociatedCallback;
    if (typeof fn === 'function') {
      try { fn.call(el, newOwner); }
      catch (e) { logThrew('custom element formAssociatedCallback', e); }
    }
  }
  if (membershipChanged) bumpSettleGen();
}

// HTML "formDisabledCallback" reaction: recompute the element's "actually disabled"
// state (own `[disabled]` or a disabled `<fieldset>` ancestor, via isActuallyDisabled)
// and, when it flipped from the cached `_ceDisabled` (undefined ≡ enabled), fire
// formDisabledCallback(isDisabled). Driven from the same lifecycle seams as the owner
// reset plus the `disabled` attribute seams — so an element that becomes disabled on
// upgrade / connection / a fieldset toggle is notified exactly once per real change.
function resetCustomElementDisabledState(el) {
  if (!isFormAssociatedCustomElement(el)) return;
  const nowDisabled = isActuallyDisabled(el);
  if (nowDisabled === (el._ceDisabled === true)) return;
  el._ceDisabled = nowDisabled;
  const fn = el.formDisabledCallback;
  if (typeof fn === 'function') {
    try { fn.call(el, nowDisabled); }
    catch (e) { logThrew('custom element formDisabledCallback', e); }
  }
}

// The combined per-element reconciliation the lifecycle seams (upgrade / connect /
// disconnect, in custom-elements.js) drive through the injected hook.
function resetCustomElementFormState(el) {
  resetCustomElementFormOwner(el);
  resetCustomElementDisabledState(el);
}
setFormAssociatedReset(resetCustomElementFormState);

// A form-associated custom element's owner or disabled state can also change through
// an attribute mutation: its own `form` re-points its owner and its own `disabled`
// flips its state directly; a <form>'s `id` re-points every element referencing it via
// `form="…"`, and a <fieldset>'s `disabled` flips every form-associated element it
// contains. The fan-out cases are rare and gated on any form-associated element
// existing at all (rule 3).
function resetFormAssociatedOwnersForAttr(el, attrName) {
  if (!hasFormAssociatedCustomElements()) return;
  if (attrName === 'form') {
    resetCustomElementFormOwner(el);
  } else if (attrName === 'disabled' && isFormAssociatedCustomElement(el)) {
    resetCustomElementDisabledState(el);
  } else if (attrName === 'id' && el._tag === 'form') {
    const root = globalThis.document && documentElementOf(globalThis.document);
    if (root) walkSubtree(root, n => { if (n._nodeType === NODE_ELEMENT) resetCustomElementFormOwner(n); });
  } else if (attrName === 'disabled' && el._tag === 'fieldset') {
    // A <fieldset disabled> toggle flips the "actually disabled" state of every
    // form-associated element it contains (except within its first <legend>). Walk
    // the fieldset's own subtree rather than the document — a detached fieldset tree
    // is common (createElement('fieldset') + innerHTML).
    walkSubtree(el, n => { if (n._nodeType === NODE_ELEMENT) resetCustomElementDisabledState(n); });
  }
}

// Window named properties: `window.<id>` / bare `<id>` resolve to the element
// with that id, and `<name>` to a name-exposed element (a, area, embed, form,
// frame[set], iframe, img, object, applet). A single `WindowNamedProps` object
// is spliced into globalThis's prototype chain (once), so real globals
// (`document`, `location`, framework vars) — which are OWN properties of
// globalThis, or inherited members of the original Window prototype below us —
// always win, and only an unresolved bare identifier reaches the named lookup.
//
// It is a PROXY — the spec's named-properties exotic object — rather than a
// plain object with statically-defined getters, so existence (`'x' in window`)
// and value are computed LIVE from the current document tree. A static getter
// would make `'x' in window` true forever once any element ever carried id/name
// "x", even after it's removed, or when it lives in a shadow tree / another
// document (where the spec says it is NOT a supported named property) — exactly
// what shadow-dom's window-named-properties-00x assert against.
//
// Perf (rule 3): the traps only run the O(document) `windowNamedLookup` when the
// name was registered as an id/name AND isn't a real member of the prototype
// chain, so an undefined-global read (feature detection like `typeof Foo`) costs
// one Set.has — never a document walk. The cascade/find hot path reads element
// fields, not globals, so it never touches this chain.
const WINDOW_NAMED_PROPS  = new Set();
const WINDOW_NAME_VALUES  = new Set();   // values seen as a `name` on an exposed tag (gates the lookup scan)
const WINDOW_NAME_TAGS    = new Set(['a', 'area', 'embed', 'form', 'frameset', 'frame', 'iframe', 'img', 'object']);   // NOT applet (obsolete — window cannot find applet)

// A browsing-context container matched by its `name` exposes the WindowProxy of
// its nested browsing context as the named-property value, NOT the element —
// `window.<iframeName>` is the child realm's global, so e.g.
// `eventListenerGlobalObject.Object` reaches that realm's intrinsics. This is the
// NAME path only: an iframe matched by `id` resolves to the element (verified
// against Chrome — `window.<iframeId>.contentWindow` must work), so the byId path
// below returns the element unchanged.
function windowNamedValueByName(el) {
  if (el && (el._tag === 'iframe' || el._tag === 'frame')) {
    const cw = el.contentWindow;
    if (cw) return cw;
  }
  return el;
}

function windowNamedLookup(name) {
  const doc = globalThis.document;
  if (!doc) return undefined;
  // `id` matches any element; getElementById returns the first in tree order.
  const byId = doc.getElementById && doc.getElementById(name);
  if (byId) {
    // Per HTML "named access on the Window": a matching navigable — a nested
    // <iframe>/<frame> whose browsing-context NAME equals `name` — resolves to its
    // WindowProxy ahead of the id match (so `window.f` for `<iframe id=f name=f>`
    // is the frame's window, what `e.source === f` cross-window checks rely on).
    // An id-only frame (id but no matching name) still resolves to the ELEMENT.
    if ((byId._tag === 'iframe' || byId._tag === 'frame') && byId._attrs && byId._attrs.name === name) {
      const cw = byId.contentWindow;
      if (cw) return cw;
    }
    return byId;
  }
  // Otherwise only a name-exposed element can match. Skip the document scan
  // unless this value was actually registered as such a `name`, so a missed
  // or detached id resolves in O(1) instead of an O(document) walk per access.
  if (!WINDOW_NAME_VALUES.has(name)) return undefined;
  let found;
  walkSubtree(doc, el => {
    if (found || el._nodeType !== NODE_ELEMENT) return;
    if (WINDOW_NAME_TAGS.has(el._tag) && el._attrs && el._attrs.name === name) found = el;
  });
  return found ? windowNamedValueByName(found) : undefined;
}

const WindowNamedTarget = Object.getPrototypeOf(globalThis);
// The child browsing contexts (nested <iframe>/<frame>), in tree order — backs
// `window[n]` (indexed access) and `window.length`, mirroring `window.frames`.
function __windowFrameEls() {
  const d = globalThis.document;
  return d ? selectAll(d, 'iframe, frame') : EMPTY_NODES;
}
const WindowNamedProps  = new Proxy(WindowNamedTarget, {
  has(target, prop) {
    if (Reflect.has(target, prop)) return true;
    if (typeof prop === 'string') {
      if (prop === 'length') return true;                              // window.length = frame count (>=0)
      if (/^(0|[1-9][0-9]*)$/.test(prop)) return Number(prop) < __windowFrameEls().length;
      if (WINDOW_NAMED_PROPS.has(prop)) return windowNamedLookup(prop) !== undefined;
    }
    return false;
  },
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !Reflect.has(target, prop)) {
      // `window.length` / `window[n]` — the nested browsing contexts. Numeric
      // indexed access returns the n-th frame's contentWindow (== window.frames[n]).
      if (prop === 'length') return __windowFrameEls().length;
      if (/^(0|[1-9][0-9]*)$/.test(prop)) {
        const el = __windowFrameEls()[Number(prop)];
        if (el) return el.contentWindow;
      } else if (WINDOW_NAMED_PROPS.has(prop)) {
        const el = windowNamedLookup(prop);
        if (el !== undefined) return el;
      }
    }
    return Reflect.get(target, prop, receiver);
  },
  getOwnPropertyDescriptor(target, prop) {
    const own = Reflect.getOwnPropertyDescriptor(target, prop);
    if (own) return own;
    if (typeof prop === 'string' && WINDOW_NAMED_PROPS.has(prop)) {
      const el = windowNamedLookup(prop);
      if (el !== undefined) {
        // LegacyPlatformObject named property: configurable + writable (so a
        // later `window.x = y` creates an own global that shadows it), and
        // non-enumerable — left out of ownKeys (LegacyUnenumerableNamedProperties).
        return { value: el, writable: true, enumerable: false, configurable: true };
      }
    }
    return undefined;
  }
});
if (!globalThis.__csimWindowNamedProps) {
  globalThis.__csimWindowNamedProps = WindowNamedProps;
  Object.setPrototypeOf(globalThis, WindowNamedProps);
}

function registerWindowName(el, attrName, value) {
  if (!value) return;
  if (attrName === 'name') {
    if (!WINDOW_NAME_TAGS.has(el._tag)) return;   // name exposes only certain tags
    WINDOW_NAME_VALUES.add(value);
  }
  // Just gate the name; existence and value are resolved live by the Proxy
  // traps against the current document, never frozen into a getter.
  WINDOW_NAMED_PROPS.add(value);
}

// Single entry point for every name/id attribute-write path: a control's
// name/id gates its form's named access (FORM_NAMED_VALUES / FORM_HANDLER), the
// window named-properties object (WindowNamedProps), and the document
// named-properties object (DocumentNamedProps).
function registerNamedAccess(el, attrName, value) {
  registerFormName(el, value);
  registerWindowName(el, attrName, value);
  registerDocumentName(el, attrName, value);
}

// Document named properties: `document.<name>` / `document.<id>` resolve to a
// named element in the document tree, mirroring `window.<id>` but with the
// document-specific supported-name rules (HTML §dom-document-nameditem):
//
//   • by `name`:  embed (exposed), form, iframe, img, object (exposed)
//   • by `id`:    object (exposed); img that ALSO has a non-empty `name`
//
// "exposed" = the embed/object has no embed/object ancestor (a real browser
// keys this off whether the plugin/fallback is being rendered; with no layout
// engine we approximate it structurally, which is what the WPT nameditem cases
// exercise). Resolution: a single match → that element (a single iframe → its
// contentWindow); multiple matches → a live HTMLCollection in tree order.
//
// Like WindowNamedProps this is a PROXY, not static getters, so existence
// (`'x' in document`) and value are computed LIVE from the current tree — a name
// whose element is removed or renamed stops being a supported property
// immediately, which the nameditem dynamic-remove/-update cases assert against.
// The proxy is spliced into the shared Document.prototype chain (below
// Document.prototype, wrapping its Node.prototype parent) so it forwards every
// real Document/Node member to that parent first and named props are consulted
// last — never shadowing `firstChild` / `forms` / `constructor`
// (nameditem-no-shadowing). Only Document instances carry Document.prototype in
// their chain, so element property reads never reach these traps. See the
// splice site (DocumentNamedProps, below class XMLDocument) for the chain shape.
//
// This prototype-chain exotic is the GET / `in` half. Own-key ENUMERATION
// (`Object.getOwnPropertyNames(document)`) reads the document's own
// [[OwnPropertyKeys]], which a prototype can't supply, so the canonical document
// is additionally a thin Proxy (makeDocProxy) that adds ownKeys /
// getOwnPropertyDescriptor — see there.
//
// This GET / `in` half (the prototype-chain splice) applies to EVERY Document
// instance — incl. XML / createHTMLDocument — which matches the spec (named
// access is a Document, not HTMLDocument, surface). The ENUMERATION half (the
// makeDocProxy wrapper) is only on documents built by createHtmlPageDocument (the
// page document + parsed HTML documents), so `Object.getOwnPropertyNames` lists
// the named props there but not on a createHTMLDocument / createDocument result —
// a bounded gap, since own-key enumeration of a secondary document's named items
// is something no app does.
//
// Gaps vs a real browser's named-properties exotic (none hit by the app suites,
// all strictly rarer): `'x' in <non-main-document>` resolves against
// `globalThis.document` (the has trap has no receiver), so for a secondary
// same-realm document (DOMParser / createHTMLDocument result) the `in` check is
// approximate — `document.<x>` get is exact (it uses the receiver).
const DOC_NAMED_PROPS = new Set();   // names ever seen as a doc-supported name/id (gates the lookup scan)
const DOC_NAME_TAGS   = new Set(['embed', 'form', 'iframe', 'img', 'object']);

// Register only values that could actually be a supported name, so the
// DOC_NAMED_PROPS gate stays a tight O(1) disqualifier (rule 3): `name` on any
// doc-named tag, but `id` only on object / img (the sole id-exposed tags). A
// form / iframe / embed id is never a supported name, so it must not arm the
// gate (which would turn a `document.<thatId>` read into a wasted tree walk).
function registerDocumentName(el, attrName, value) {
  if (!value) return;
  const tag = el._tag;
  if (attrName === 'name') { if (DOC_NAME_TAGS.has(tag)) DOC_NAMED_PROPS.add(value); }
  else if (attrName === 'id' && (tag === 'object' || tag === 'img')) DOC_NAMED_PROPS.add(value);
}

// An embed/object is "exposed" only when no ancestor is itself an object/embed.
function isDocExposed(el) {
  let p = el._parent;
  while (p && p._nodeType === NODE_ELEMENT) {
    if (p._tag === 'object' || p._tag === 'embed') return false;
    p = p._parent;
  }
  return true;
}

function isDocNamedMatch(el, name) {
  const a = el._attrs; if (!a) return false;
  const tag = el._tag, nm = a.name, id = a.id;
  if (nm && nm === name) {
    if (tag === 'form' || tag === 'iframe' || tag === 'img') return true;
    if ((tag === 'embed' || tag === 'object') && isDocExposed(el)) return true;
  }
  if (id && id === name) {
    if (tag === 'object' && isDocExposed(el)) return true;
    if (tag === 'img' && nm) return true;   // an img's id is a supported name only when it also has a name
  }
  return false;
}

function docNamedElements(doc, name) {
  const out = [];
  walkSubtree(doc, el => {
    if (el._nodeType === NODE_ELEMENT && isDocNamedMatch(el, name)) out.push(el);
  });
  return out;
}

function documentNamedLookup(doc, name) {
  if (!doc || !DOC_NAMED_PROPS.has(name)) return undefined;
  const els = docNamedElements(doc, name);
  if (els.length === 0) return undefined;
  if (els.length === 1) {
    const el = els[0];
    if (el._tag === 'iframe') { const cw = el.contentWindow; if (cw) return cw; }
    return el;
  }
  return liveHTMLCollection(() => docNamedElements(doc, name));
}

// The document's supported property NAMES, in tree order, deduped (first
// occurrence wins) — same name/id rules as isDocNamedMatch. Backs the ownKeys
// trap. Side-effect-free (a plain tree walk; never touches contentWindow).
function docSupportedNames(doc) {
  const out = [], seen = new Set();
  const add = (k) => { if (k && !seen.has(k)) { seen.add(k); out.push(k); } };
  walkSubtree(doc, el => {
    if (el._nodeType !== NODE_ELEMENT) return;
    const a = el._attrs; if (!a) return;
    const tag = el._tag, nm = a.name, id = a.id;
    if (tag === 'form' || tag === 'iframe' || tag === 'img') { if (nm) add(nm); }
    else if ((tag === 'embed' || tag === 'object') && isDocExposed(el)) { if (nm) add(nm); }
    if (tag === 'object' && id && isDocExposed(el)) add(id);
    if (tag === 'img' && id && nm) add(id);
  });
  return out;
}

// The document named-properties exotic, ENUMERATION half. The prototype-chain
// DocumentNamedProps (above) gives `document.<name>` / `'x' in document` their
// live values; but `Object.getOwnPropertyNames(document)` reads the document's
// OWN [[OwnPropertyKeys]], which a prototype can't supply — and an ordinary
// object would also reorder an integer-like name such as "42" ahead of the
// string keys. So the canonical document is a thin Proxy whose ownKeys appends
// the supported names in TREE order (integer-like names kept in place — this is
// the WebIDL/WPT order; Chrome's V8 actually hoists "42" to the front, but no
// app depends on that and the WPT subtest asserts tree order) and whose
// getOwnPropertyDescriptor answers for them. Every other operation forwards to
// the raw target by default, so `document` keeps a plain-object hidden class for
// normal reads (measured: no bench regression).
//
// Both traps MUST stay side-effect-free: getOwnPropertyDescriptor resolves the
// named ELEMENT, never `iframe.contentWindow` — the contentWindow getter lazily
// builds the frame realm, and frame construction itself queries the parent
// document's descriptors, so resolving it here loops a frame's own name back
// into rebuilding itself (V8 OOM). The live `document.<name>` GET still returns
// the contentWindow via the prototype-chain exotic; only this descriptor's value
// (rarely read, and never during plain key enumeration) is the element.
function makeDocProxy(doc) {
  const proxy = new Proxy(doc, {
    ownKeys(t) {
      const keys = Reflect.ownKeys(t);
      // Fast out: no named props ever registered → plain key list, no tree walk
      // (rule 3 — `Object.keys(document)` / spread stay O(own-props)). Also when
      // the target is non-extensible (a page froze `document`): the proxy ownKeys
      // invariant then forbids reporting keys absent from the target, so the
      // named keys must be dropped rather than throw.
      if (DOC_NAMED_PROPS.size === 0 || !Reflect.isExtensible(t)) return keys;
      const seen = new Set(keys);
      // Gate on DOC_NAMED_PROPS so the key set matches exactly what the
      // descriptor / GET halves resolve (both gate on it) — no key can enumerate
      // that getOwnPropertyDescriptor would then report as absent.
      for (const n of docSupportedNames(t)) if (DOC_NAMED_PROPS.has(n) && !seen.has(n)) { keys.push(n); seen.add(n); }
      return keys;
    },
    getOwnPropertyDescriptor(t, p) {
      const own = Reflect.getOwnPropertyDescriptor(t, p);
      if (own) return own;
      if (typeof p === 'string' && DOC_NAMED_PROPS.has(p)) {
        const els = docNamedElements(t, p);
        if (els.length) {
          // Enumerable: Document (unlike Window) has no
          // [LegacyUnenumerableNamedProperties], so its named props appear in
          // Object.keys / for-in too — matches the spec and Chrome. (A walker that
          // then reads `document.<iframeName>` gets the live contentWindow; the
          // re-entrancy guard in __csimFrameWindow keeps that from looping a
          // frame's own name back into rebuilding its realm.)
          const value = els.length === 1 ? els[0] : liveHTMLCollection(() => docNamedElements(t, p));
          return { value, writable: true, enumerable: true, configurable: true };
        }
      }
      return undefined;
    }
  });
  doc.__csimSelf = proxy;   // (…the document a script holds is the Proxy — the one identity of its two views)
  return proxy;
}

// DocumentFragment: a Node-shaped subtree root that's *not* in the
// document tree. Standard appendChild / removeChild / etc. inherit
// from Node. nodeType=11 per spec. The unique twist: when a
// DocumentFragment is appended to a real parent, its children move
// and the fragment is left empty — Node.appendChild has to detect
// this and splice. We keep the simple form (a fragment can hold
// children; users typically iterate `.childNodes` themselves before
// splicing) so jQuery's "build then splice via firstChild" pattern
// works.
// ── Data-driven reflection: the long tail of plain string / boolean content
// attributes (mostly obsolete presentational — align, vAlign, bgColor, ch/chOff,
// frameBorder, marginWidth, compact, loop, controls, …). The element→attr→type
// table is taken verbatim from the WHATWG IDL (html/dom/elements-*.js). Each entry
// defines ONE tag-gated accessor on Element.prototype, but ONLY when no hand-written
// accessor already exists (the hand-written one wins — richer behavior is preserved).
// Accessors are non-enumerable (matching class getters; avoids for-in pollution).
// Ambiguous shared names (width/height/size/type/value/max/min/cols/rows/sizes/
// autocomplete/htmlFor) are NOT here — they have per-element types and stay
// hand-written with explicit dispatch.
// STRING: [idl, attr, tags, legacyNull?]
const REFLECT_STRING_TABLE = [
  ['bgColor','bgcolor',['body'],1],
  ['name','name',['form','fieldset','input','button','select','textarea','output']],
  ['align','align',['input']],
  ['alt','alt',['input']],
  // `srcset` is a hand-written accessor (USVString coercion the generic
  // DOMString registry can't express) — see `get/set srcset` above.
  ['useMap','usemap',['input']],
  // NOTE: `label` is hand-written (get/set label) — <option>.label has a text
  // fallback, so it can't be a plain string reflection (track/optgroup are
  // handled there too). installReflectedTail skips a hand-written accessor.
  ['target','target',['form']],
  ['acceptCharset','accept-charset',['form']],
  ['accept','accept',['input']],
  ['dirName','dirname',['input','textarea']],
  ['formTarget','formtarget',['input','button']],
  ['pattern','pattern',['input']],
  ['placeholder','placeholder',['input','textarea']],
  ['step','step',['input']],
  ['defaultValue','value',['input']],
  ['wrap','wrap',['textarea']],
  ['text','text',['body'],1],
  ['link','link',['body'],1],
  ['vLink','vlink',['body'],1],
  ['aLink','alink',['body'],1],
  ['background','background',['body']]
];
// BOOLEAN: [idl, attr, tags]
const REFLECT_BOOLEAN_TABLE = [
  ['noValidate','novalidate',['form']],
  ['disabled','disabled',['fieldset','input','button','select','option','textarea']],
  ['defaultChecked','checked',['input']],
  ['formNoValidate','formnovalidate',['input','button']],
  ['multiple','multiple',['input','select']],
  ['readOnly','readonly',['input','textarea']],
  ['required','required',['input','select','textarea']],
  ['defaultSelected','selected',['option']]
];
// On a tag that does NOT own this reflected attribute, a write must behave like a
// real browser — the IDL property doesn't exist there, so assignment just creates
// a plain own (expando) data property; it must NOT be a silent no-op. (e.g. the
// html/dom shadow-dom event-path helpers do `div.label = 'A1a'` to tag nodes — a
// no-op setter would break relatedTarget/composedPath retargeting.) The own data
// property then shadows this prototype accessor for that instance.
function reflectExpandoFallback(el, idl, v) {
  Object.defineProperty(el, idl, { value: v, writable: true, enumerable: true, configurable: true });
}
function installReflectedTail(table, makeGet, makeSet) {
  for (const row of table) {
    const idl = row[0];
    if (Object.getOwnPropertyDescriptor(Element.prototype, idl)) continue;  // hand-written wins
    // legacyNull (row[3]): truthy → [LegacyNullToEmptyString].
    const attr = row[1], tagSet = new Set(row[2]), legacyNull = row[3];
    Object.defineProperty(Element.prototype, idl, {
      configurable: true, enumerable: false,
      get: makeGet(attr, tagSet), set: makeSet(idl, attr, tagSet, legacyNull)
    });
  }
}
installReflectedTail(REFLECT_STRING_TABLE,
  // A table-reflected IDL attribute is `undefined` on an element whose
  // interface doesn't define it (e.g. applet.name, span.scrolling) — NOT "".
  // On an applicable element a missing content attribute reflects "". (Some
  // names with richer hand-written accessors above don't route through here.)
  (attr, tagSet) => function () { return tagSet.has(this._tag) ? (this._attrs[attr] == null ? '' : String(this._attrs[attr])) : undefined; },
  (idl, attr, tagSet, legacyNull) => function (v) {
    if (tagSet.has(this._tag)) {
      // [LegacyNullToEmptyString] maps strictly `null` (not `undefined`) to "";
      // `undefined` stringifies to "undefined" like any other value.
      this._setAttribute(attr, legacyNull && v === null ? '' : String(v));
    } else reflectExpandoFallback(this, idl, v);
  });
installReflectedTail(REFLECT_BOOLEAN_TABLE,
  (attr, tagSet) => function () { return tagSet.has(this._tag) ? this._hasAttribute(attr) : false; },
  (idl, attr, tagSet) => function (v) {
    if (tagSet.has(this._tag)) { if (v) this._setAttribute(attr, ''); else this._removeAttribute(attr); }
    else reflectExpandoFallback(this, idl, v);
  });


class DocumentFragment extends Node {
  constructor() {
    super(NODE_FRAGMENT);
    registerNativeNode(this);   // (a ShadowRoot too)
  }
  get _nodeName()     { return '#document-fragment'; }
  get _ownerDocument(){ return this._ownerDoc || globalThis.document; }
  // (…a DocumentFragment, not of the `constructor` a page may have replaced or subclassed)
  _cloneShell()       { return new DocumentFragment(); }
}
// DocumentFragment's members, and ParentNode / NonElementParentNode's: generated from their IDL onto the class.
registerInterface('DocumentFragment', (o) => isNodeObject(o) && o._nodeType === NODE_FRAGMENT);
installDocumentFragment(DocumentFragment, {
  getElementById(frag, id) { return findById(frag, id); },
  get_children: childrenOf,
  get_firstElementChild: firstElementChildOf,
  get_lastElementChild: lastElementChildOf,
  get_childElementCount: childElementCountOf,
  prepend: parentNodePrepend,
  append: parentNodeAppend,
  replaceChildren: parentNodeReplaceChildren,
  moveBefore: parentNodeMoveBefore,
  querySelector(frag, selectors) { return selectFirst(frag, selectors); },
  querySelectorAll(frag, selectors) { return nodeList(selectAll(frag, selectors)); }
});
globalThis.DocumentFragment = DocumentFragment;

// ShadowRoot: a DocumentFragment that lives as a sibling tree off
// a host Element. Same query API (`querySelector` / `getElementById`)
// as Element; queries from outside the shadow tree don't descend in.
// Internal token gating ShadowRoot construction — script-side `new ShadowRoot()`
// is illegal per WebIDL (the interface has no constructor); only attachShadow
// may build one, by passing this private token.
const SHADOW_ROOT_INTERNAL = {};
// CSSOM-View `elementFromPoint` on a document or a shadow root (`scope`): the topmost element at the viewport point,
// RETARGETED against the scope (DOM §retarget) — an element in a shadow tree the scope cannot see answers as its host,
// which is what Chrome reports for a click landing inside a web component. A point outside the VIEWPORT has none,
// however far a box reaches past it (Chrome: null at x = 900 over a 2000px-wide box in an 800px window).
function elementFromPointIn(scope, x, y) {
  if (!insideViewport(x, y)) return null;
  const hit = hitTest(x, y);
  return hit ? retarget(hit, scope) : null;
}
// …and `elementsFromPoint`: every element painted there, topmost first (`hitTestAll`) — each retargeted, once.
function elementsFromPointIn(scope, x, y) {
  const out = [];
  if (!insideViewport(x, y)) return out;
  for (const hit of hitTestAll(x, y)) {
    const el = retarget(hit, scope);
    if (!out.includes(el)) out.push(el);
  }
  return out;
}
function insideViewport(x, y) {
  const vp = viewportSize();
  return x >= 0 && y >= 0 && x < vp.width && y < vp.height;
}

class ShadowRoot extends DocumentFragment {
  constructor(host, mode, token) {
    if (token !== SHADOW_ROOT_INTERNAL) throw new TypeError('Illegal constructor');
    super();
    // (…read-only to a script, as `host` and `mode` are IDL readonly attributes: a write changed which root `shadowRoot`
    // exposed, which the engine's closed flag did not follow)
    this._host = host;
    this._mode = mode || 'open';
    // Cheap boundary marker the event dispatcher / composedPath test
    // for, so they can detect a shadow boundary without importing this
    // class (keeps the hot dispatch path free of a cross-module ref).
    this._isShadowRoot = true;
    // Shadow-tree descendants need an upward path so `isConnected`
    // and ancestor walks land back in the document. Use the host
    // as the "parent" of the shadow root itself; descendants
    // inside the shadow root have their _parent pointing inside
    // the shadow tree as usual.
    hostEdge(this, host);
  }
  // (…ShadowRoot's, from DOM Parsing: a DocumentFragment has none)
  get _innerHTML()    { return isHtmlDocument(this.ownerDocument) ? serializeChildren(this) : xmlSerializeInner(this); }
  set _innerHTML(html) {
    // Spec: replacing all children must orphan the removed nodes
    // (parentNode → null) — Tagify's `input.set('')` does
    // `DOM.input.innerHTML = ''` to clear after committing a tag,
    // and our typing pipeline checks `isConnected(textNode)` to
    // decide whether to re-anchor the caret. Without clearing
    // `_parent`, the removed text node is still "connected" via
    // its dangling parent pointer and subsequent inserts go into
    // a phantom node Tagify never reads from.
    const isHtml = isHtmlDocument(this.ownerDocument);
    const parsed = isHtml ? parseFragment(html, this) : parseXmlFragment(html, this);   // (…an XML one throws a SyntaxError before mutating)
    const doc = this.ownerDocument;
    const removed = clearEdges(this);
    for (const c of removed) unregisterSubtree(c);
    if (!isHtml) for (const c of parsed) doc._adoptNode(c);   // own the parsed XML nodes to the XML document
    const added = parsed.slice();
    insertEdges(this, added, -1);
    for (const c of added) registerSubtree(c);
    if (removed.length > 0 || added.length > 0) {
      recordChildList(this, added, removed);
    }
    // Same post-splice reactions as Element#innerHTML: connected (host in the
    // document) → the full connect walk (upgrade + connectedCallback + resource
    // loads); detached → upgrade only (reactions drain at the API boundary),
    // resolving each element's registry — the root's scoped one sticks.
    if (isConnected(this)) {
      for (const c of added) globalThis.__csimFireCEConnect(c);
    } else {
      for (const c of added) ceUpgradeTree(c);
    }
  }
  // A ShadowRoot is a DocumentFragment, so its nodeName is "#document-fragment"
  // (DOM: nodeName for a DOCUMENT_FRAGMENT_NODE), NOT "#shadow-root" — inherit
  // DocumentFragment's. (Kept explicit for clarity; matches WPT.)
  get _nodeName() { return '#document-fragment'; }
  // A shadow root has no parent in the node tree — `parentNode` / `parentElement`
  // are always null (its host is reached via `.host`, not as a parent). The
  // internal `_parent` slot still points at the host so the event-dispatch walk
  // and isConnected climb across the boundary; only the public accessors hide it.
  get _parentNode()    { return null; }
  get _parentElement() { return null; }
  // CSSOM-View `ShadowRoot.elementFromPoint(x, y)` / `elementsFromPoint`: the document's hit test, retargeted
  // against this root (`elementFromPointIn`) — so a hit inside a tree nested in this one answers as its host.
  elementFromPoint(x, y)  { return elementFromPointIn(this, x, y); }
  elementsFromPoint(x, y) { return elementsFromPointIn(this, x, y); }
  // Legacy `ShadowRoot.getSelection()` (non-standard, Chrome-supported): the
  // current selection scoped to this shadow tree. We model a single per-document
  // selection, so return the document's selection (its range may live in this
  // shadow tree) — its toString reflects the selected text. (shadow-dom
  // ranges-and-selections.)
  getSelection() { return globalThis.__csimGetSelection(this._ownerDocument); }
  // A shadow root's node document is its host's node document (DOM: the shadow
  // root is created in the host's document). This also drives adoption — a node
  // inserted into the shadow tree is adopted into the host's document, since
  // adoptIntoParent reads the parent's ownerDocument.
  get _ownerDocument() { return this._host ? this._host.ownerDocument : (this._ownerDoc || globalThis.document); }
}
globalThis.ShadowRoot = ShadowRoot;
// ShadowRoot's members (generated/bindings.js) — DocumentOrShadowRoot's among them, Document's alike where the two
// answer alike. (Chrome's legacy `elementFromPoint` / `elementsFromPoint` / `getSelection`, no IDL's, stay the
// class's.)
registerInterface('ShadowRoot', (o) => isNodeObject(o) && o._isShadowRoot === true);
installShadowRoot(ShadowRoot, {
  get_mode: (root) => root._mode,
  get_host: (root) => root._host,
  get_delegatesFocus: (root) => !!root._delegatesFocus,
  get_slotAssignment: (root) => root._slotAssignment || 'named',
  get_clonable: (root) => !!root._clonable,
  get_serializable: (root) => !!root._serializable,
  // (…set at attachShadow: unset, it tracks the node document, as an element's does; else the scoped or null registry
  // the tree was made with)
  get_customElementRegistry: shadowRootRegistry,
  get_styleSheets: styleSheetListOf,
  // (…a rule-set change the document cascade key can't see: the cascade version moves, which hands the tree's sheets
  // to the style engine again — cascade.js `feedShadowStyleSheets` — and re-keys every rule-set-keyed memo)
  get_adoptedStyleSheets: (root) => root._adoptedStyleSheets || (root._adoptedStyleSheets = makeAdoptedStyleSheetsArray(root, bumpCascadeVersion)),
  set_adoptedStyleSheets: setAdoptedStyleSheets,
  // The focused element retargeted against this tree (HTML "retarget"): one in it, or the host in it of the tree it is
  // in; none for one elsewhere — its host's document's focus (a root another realm made, adopted here, reads this
  // realm's).
  get_activeElement(root) {
    const doc = root.ownerDocument;
    const ae = doc && doc._activeElement;
    if (!ae || !isConnected(ae)) return null;
    for (let node = ae; node; ) {
      const tree = enclosingShadowRoot(node);
      if (tree === root) return node;
      if (!tree) return null;
      node = tree._host;
    }
    return null;
  },
  get_fullscreenElement: () => null,
  get_pictureInPictureElement: () => null,
  get_pointerLockElement: () => null,
  getAnimations: (root) => animationsForRoot(root),
  // `setHTMLUnsafe` parses as `innerHTML` does, and converts the declarative shadow roots it makes, as Element's.
  setHTMLUnsafe(root, html) {
    root._innerHTML = html;
    processDeclarativeShadowRoots(root);
  },
  getHTML: getHTMLOf,
  get_innerHTML: (root) => root._innerHTML,
  set_innerHTML(root, value) { root._innerHTML = value; },
  installEventHandlers(proto, names, isSelf) { installEventHandlerAttrs(proto, names, null, isSelf); }
});

// ── ElementInternals, its CustomStateSet and ValidityState ───────────
// CustomStateSet (HTML §4.13.6.8), generated from its IDL: a setlike<DOMString> the platform makes for an
// ElementInternals, its states a Set in its slots. A mutation that changed it signals the style-state generation —
// `:state(x)` is a cascade input that no attribute and no DOM change stands behind, so a cached cascade result would
// otherwise never learn that it moved — and mirrors the set into the element's arena node, where the native matcher
// answers `:state()`. (Reads are free.)
const statesOf = (o) => slotsOf(o, 'CustomStateSet');
registerInterface('CustomStateSet', (o) => statesOf(o) !== undefined);
class CustomStateSet {
  constructor(token, element) {
    constructedBy(PLATFORM, token, 'CustomStateSet');
    makeSlots(this, 'CustomStateSet', { set: new Set(), element });
  }
}
installCustomStateSet(CustomStateSet, {
  setOf: (states) => statesOf(states).set,
  setChanged(states) {
    const s = statesOf(states);
    bumpStyleState();
    syncCustomStates(s.element, s.set);
  }
});
globalThis.CustomStateSet = CustomStateSet;

// ValidityState's flags, in its IDL order, and a validity with none set.
const VALIDITY_FLAG_NAMES = [
  'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow',
  'stepMismatch', 'badInput', 'customError'
];
const NO_VALIDITY_FLAGS = Object.freeze(Object.fromEntries(VALIDITY_FLAG_NAMES.map((k) => [k, false])));
// …told by value, not by being this realm's NO_VALIDITY_FLAGS: a frame's ValidityState getter or ElementInternals method
// may be handed flags of this realm, and the other way round.
const noValidityFlags = (flags) => !VALIDITY_FLAG_NAMES.some((k) => flags[k]);
// The flags of a native validity (bit `i` the `i`th of VALIDITY_FLAG_NAMES), each set of them one frozen object —
// NO_VALIDITY_FLAGS for none.
const FLAGS_OBJECTS = new Map([[0, NO_VALIDITY_FLAGS]]);
function validityFlagsObject(bits) {
  let o = FLAGS_OBJECTS.get(bits);
  if (!o) {
    o = Object.freeze(Object.fromEntries(VALIDITY_FLAG_NAMES.map((k, i) => [k, (bits & (1 << i)) !== 0])));
    FLAGS_OBJECTS.set(bits, o);
  }
  return o;
}
// ValidityState (HTML §4.10.20.3), generated from its IDL: a live view of a control's validity — its slots hold
// `flagsOf`, every read asking the flags as they are now.
const ValidityState = defineValidityState({
  init(s, flagsOf) { s.flagsOf = flagsOf; },
  ...Object.fromEntries(VALIDITY_FLAG_NAMES.map((k) => [`get_${k}`, (s) => s.flagsOf()[k]])),
  get_valid: (s) => noValidityFlags(s.flagsOf())
});
const validityStateOf = (flagsOf) => ValidityState.create(flagsOf);
globalThis.ValidityState = ValidityState.interface;

// ElementInternals (HTML §4.13.7), generated from its IDL: made for a custom element by its attachInternals(), its
// state in its slots — the element, whether it is form-associated, its validity and validation message, its states,
// and its ARIAMixin's default semantics (`aria`, null until set). The form-associated members throw NotSupportedError
// unless the element's definition is `static formAssociated = true`; `shadowRoot` exposes the element's shadow root,
// a closed one too (though not yet only one "available to element internals": attachShadow's flag is unmodelled).
const internalsOf = (o) => slotsOf(o, 'ElementInternals');
registerInterface('ElementInternals', (o) => internalsOf(o) !== undefined);
class ElementInternals {
  constructor(token, target) {
    constructedBy(PLATFORM, token, 'ElementInternals');
    const ctor = target._ns === HTML_NS ? getCustomElementCtor(target._localName) : null;
    makeSlots(this, 'ElementInternals', {
      target,
      formAssociated: !!(ctor && ctor.formAssociated === true),
      validationMessage: '',
      validityFlags: NO_VALIDITY_FLAGS,
      validityState: null,   // [SameObject] `validity`, a live view of the flags
      states: new CustomStateSet(PLATFORM, target),
      aria: null
    });
  }
}
// (…the form-associated members' first step: a NotSupportedError for an element that is not one)
function formAssociatedSlots(internals, member) {
  const s = internalsOf(internals);
  if (!s.formAssociated) {
    throw new DOMException(`Failed to execute '${member}' on 'ElementInternals': The target element is not a form-associated custom element.`, 'NotSupportedError');
  }
  return s;
}
// Its validity as constraint validation reads it: whether its element is a candidate that fails (a validation message
// it was given), and checkValidity's steps — an invalid candidate fires a cancelable `invalid` at the element and
// answers false (reportValidity's UI is none).
const internalsSuffersFailure = (internals) => internalsOf(internals).validationMessage !== '';
function checkInternalsValidity(s) {
  if (!faceWillValidate(s.target) || noValidityFlags(s.validityFlags)) return true;
  fireEvent(s.target, new Event('invalid', { bubbles: false, cancelable: true }));
  return false;
}
// ARIAMixin on ElementInternals: UNLIKE Element's, these do NOT reflect content attributes — they are the custom
// element's DEFAULT semantics, stored in its slots (null until set; a list FrozenArray-converted once by the binding,
// so `i.prop === i.prop`). The element's own role / aria-* attributes override them in the accessibility computation
// (testdriver-vendor's get_computed_role/label read both sides in that order). Strings are kept VERBATIM.
const internalsAria = {};
for (const idl of [...Object.keys(ARIA_REFLECTED_ATTRS), ...Object.keys(ARIA_ELEMENT_REF_ATTRS), ...Object.keys(ARIA_ELEMENT_REFLIST_ATTRS)]) {
  internalsAria[`get_${idl}`] = (internals) => internalsOf(internals).aria?.[idl] ?? null;
  internalsAria[`set_${idl}`] = (internals, v) => { (internalsOf(internals).aria ??= Object.create(null))[idl] = v; };
}
installElementInternals(ElementInternals, {
  // DocumentOrShadowRoot exposure: the (open OR closed) shadow root the element hosts — `Element.shadowRoot` hides a
  // closed root; this does not.
  get_shadowRoot: (internals) => internalsOf(internals).target._shadowRoot || null,
  get_form: (internals) => formForControl(formAssociatedSlots(internals, 'form').target) || null,
  // Sets the target's submission value — what the form's entry list picks up for it (form-fields.js
  // `appendCustomElementEntries`). A FormData is stored as a SNAPSHOT of its entries, per spec: the element's value is
  // "a list of entries", so a later mutation of the caller's FormData must not reach the form. `state` (the second
  // argument) is the form-restore value; nothing restores state in-process yet, so it is accepted and ignored.
  setFormValue(internals, value) {
    const target = formAssociatedSlots(internals, 'setFormValue').target;
    target._ceSubmissionValue = isFormData(value) ? formDataEntries(value).slice() : value;
  },
  // HTML `setValidity(flags, message, anchor)`: the flags (a ValidityStateFlags dictionary) are the element's validity;
  // with any of them set, `message` is required and non-empty; an `anchor` must be within the target's
  // shadow-including subtree.
  setValidity(internals, flags, message, anchor) {
    const s = formAssociatedSlots(internals, 'setValidity');
    const invalid = VALIDITY_FLAG_NAMES.some((k) => flags[k]);
    if (invalid && !message) {
      throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': The second argument should not be empty if one or more flags in the first argument are true.");
    }
    // (…the flags and the message, its newlines normalized, set before the anchor is checked: HTML's steps 5–8, then 10)
    s.validityFlags = invalid ? Object.fromEntries(VALIDITY_FLAG_NAMES.map((k) => [k, flags[k]])) : NO_VALIDITY_FLAGS;
    s.validationMessage = invalid ? message.replace(/\r\n?/g, '\n') : '';
    // …which is the element's validity, as `:invalid` and its form read it (a custom error of its own).
    if (hasState(s.target, STATE_CUSTOM_ERROR) !== invalid) {
      setStateBit(s.target, STATE_CUSTOM_ERROR, invalid);
      bumpStyleState();
    }
    if (anchor !== undefined) {
      let n = anchor;
      while (n && n !== s.target) n = n._parent || (n._isShadowRoot ? n._host : null);
      if (!n) {
        throw new DOMException("Failed to execute 'setValidity' on 'ElementInternals': The validation anchor is not a shadow-including descendant of the element.", 'NotFoundError');
      }
    }
  },
  get_willValidate: (internals) => faceWillValidate(formAssociatedSlots(internals, 'willValidate').target),
  get_validationMessage: (internals) => formAssociatedSlots(internals, 'validationMessage').validationMessage,
  get_validity(internals) {
    const s = formAssociatedSlots(internals, 'validity');
    return (s.validityState ??= validityStateOf(() => s.validityFlags));
  },
  get_labels(internals) {
    formAssociatedSlots(internals, 'labels');
    return nodeList([]);
  },
  checkValidity: (internals) => checkInternalsValidity(formAssociatedSlots(internals, 'checkValidity')),
  reportValidity: (internals) => checkInternalsValidity(formAssociatedSlots(internals, 'reportValidity')),
  // (…[SameObject]: its CustomStateSet, which the `:state(ident)` pseudo-class reads)
  get_states: (internals) => internalsOf(internals).states,
  ...internalsAria
});
globalThis.ElementInternals = ElementInternals;
globalThis.__csimApplyAsyncImage = hostTask((id, r) => Element.__applyAsyncImage(id, r));

// ── Slot assignment (DOM §"assigning slottables and slots") ─────────
// The engine assigns (slots.rs): on the two mutation chokepoints (recordChildList / recordAttrMutation) the affected
// shadow root's slots are assigned anew there, and each one whose assigned nodes changed gets its slotchange here;
// assignedSlot / assignedNodes / assignedElements read what it stored.
//
// Performance (rule 3): every hook short-circuits on `shadowHostCount` — a
// page that never calls attachShadow pays one hook call that returns on a
// single integer check, and nothing else. When shadow roots DO exist, a
// light-DOM mutation costs one O(1) `target._shadowRoot` check plus a scan of
// the (small) added/removed sets for a <slot>; the ancestor walk to find an
// enclosing shadow root happens only when a slot was actually inserted /
// removed / moved. `shadowHostCount` only rises — a host removed mid-page
// keeps the hooks live — but `visit()` rebuilds the VM per page, so a
// shadow-free page starts (and stays) at zero.
let shadowHostCount = 0;
// …mirrored to the global AT BOOT, not only when a host appears. Every read site is
// `globalThis.__csimShadowHostCount`, and a global that has never been assigned costs a property MISS
// on the global proxy — proxy, then the global object, then `Object.prototype`, then fail — where an
// existing one is a monomorphic load. Seventeen of those sites sit on the engine's hottest paths, and
// on a page with no shadow DOM at all (nearly every page) the miss was measured at ~19% of a 400-row
// relayout: 53.1 ms against 43.5 ms with this line. The value is the same `0` the reads already
// treated `undefined` as; only its EXISTENCE changed.
globalThis.__csimShadowHostCount = shadowHostCount;
// A shadow tree come to be hosted in this realm's arena — attached, or adopted with its host from another realm's,
// whose count it was in (`nodeIn`), whichever realm's code did it: counted, and the count mirrored to a global so the
// cascade (a separate module, can't import this without a cycle) can cheaply skip its shadow-scope work on shadow-free
// pages (rule 3).
NATIVE_REALM.shadowHosted = () => {
  shadowHostCount++;
  globalThis.__csimShadowHostCount = shadowHostCount;
};

// Elements that may host a shadow tree (HTML "valid shadow host name"): the
// fixed safelist plus a custom-element name, approximated as an HTML-namespace
// tag containing a hyphen (a fuller PotentialCustomElementName check — reserved
// hyphenated names, leading digit — would only matter for adversarial names no
// app uses). attachShadow throws NotSupportedError for anything else.
const SHADOW_HOST_TAGS = new Set([
  'article', 'aside', 'blockquote', 'body', 'div', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span'
]);
// A custom-element definition whose `static disabledFeatures` includes "shadow"
// cannot host a shadow root (HTML attachShadow step). Both an imperative
// attachShadow and a declarative `<template shadowrootmode>` must respect it.
function ctorDisablesShadow(ctor) {
  if (!ctor) return false;
  let df; try { df = ctor.disabledFeatures; } catch (_) { df = null; }
  return !!(df && typeof df.indexOf === 'function' && df.indexOf('shadow') !== -1);
}
function canAttachShadow(el) {
  if (el._ns !== HTML_NS) return false;
  const ln = el._localName;
  if (ln.indexOf('-') !== -1) {
    // Autonomous custom element: keyed by its local name.
    if (ctorDisablesShadow(getCustomElementCtor(ln))) return false;
    return true;
  }
  // Customized built-in (`<h2 is="…">`): keyed by its is value's definition (`_isValue`, fixed at creation).
  const isValue = el._isValue;
  if (isValue && ctorDisablesShadow(getCustomElementCtor(isValue))) return false;
  return SHADOW_HOST_TAGS.has(ln);
}

// The steps a sheet adopted into a document or a shadow root passes — `adoptedStyleSheets = […]`'s and an index
// write's alike (CSSOM's "set an indexed value"): a constructed sheet, of the document the root is in (one an owned
// `<style>` / `<link>` has, or one built in another document — an iframe's — a NotAllowedError).
function checkAdoptable(sheet, root) {
  const constructorDocument = slotsOf(sheet, 'CSSStyleSheet').constructorDocument;
  if (constructorDocument === null) throw new DOMException("Can't adopt a non-constructed stylesheet", 'NotAllowedError');
  const doc = root._nodeType === NODE_DOC ? root : root.ownerDocument;
  if (constructorDocument !== doc) {
    throw new DOMException("Failed to set the 'adoptedStyleSheets' property: Sheet constructed in a different document", 'NotAllowedError');
  }
}
const IS_CSS_STYLE_SHEET = interfaceCheck('CSSStyleSheet');

// `adoptedStyleSheets` is a live ObservableArray<CSSStyleSheet>, not a plain array: an
// in-place mutation (push / splice / index or length assignment) must convert and check each
// new member and invalidate the cascade, exactly as reassigning the whole attribute does. A
// Proxy over a hidden backing array keeps `Array.isArray` true while trapping writes; index
// writes go through [[DefineOwnProperty]] (Object.defineProperty) rather than [[Set]], so an
// inherited `Array.prototype` accessor can never observe or hijack the backing store — per
// the ObservableArray spec, and asserted by css/cssom/adoptedstylesheets-observablearray.
function makeAdoptedStyleSheetsArray(root, onMutate) {
  const isIndex = (p) => typeof p === 'string' && p === String(p >>> 0) && p !== '4294967295';
  return new Proxy([], {
    set(target, prop, value) {
      if (isIndex(prop)) {
        if (!IS_CSS_STYLE_SHEET(value)) throw new TypeError("Failed to convert value to 'CSSStyleSheet'.");
        checkAdoptable(value, root);
        Object.defineProperty(target, prop, {value, writable: true, enumerable: true, configurable: true});
        onMutate();
      } else if (prop === 'length') {
        target.length = value;
        onMutate();
      } else {
        target[prop] = value;
      }
      return true;
    },
    deleteProperty(target, prop) {
      const wasIndex = isIndex(prop);
      delete target[prop];
      if (wasIndex) onMutate();
      return true;
    }
  });
}

// `adoptedStyleSheets = sheets` (converted: a sequence of CSSStyleSheets) — every one checked before the list changes,
// so a rejected assignment leaves it as it was.
function setAdoptedStyleSheets(root, sheets) {
  for (const sheet of sheets) checkAdoptable(sheet, root);
  const list = root.adoptedStyleSheets;   // lazily materializes the ObservableArray
  list.splice(0, list.length, ...sheets);
}

// Build a CSSStyleSheet from a `shadowrootadoptedstylesheets` specifier:
// resolve it via the import map (bare specifier → mapped URL) or as a URL,
// fetch the CSS text (inline data: URL decoded directly; otherwise a sync
// Rack fetch), and `replaceSync` it. Returns null on any failure so a bad
// specifier is skipped rather than throwing during parse.
function sheetFromSpecifier(specifier, baseURL) {
  try {
    const map = globalThis.__csim_importmap;
    let raw = (map && map.imports && map.imports[specifier]) || specifier;
    let css = null;
    // A data: URL is decoded from the RAW specifier (not the parser's
    // re-serialized href, which percent-encodes the inline body and would
    // corrupt base64 / break the decode). Percent-decode only well-formed
    // `%XX` escapes so a literal `%` (e.g. a CSS `50%`) stays intact instead
    // of throwing — matching how browsers decode data: bodies.
    const dm = /^data:[^,]*?(;base64)?,([\s\S]*)$/i.exec(raw);
    if (dm) {
      css = dm[1]
        ? globalThis.__csimAtob(dm[2].replace(/\s+/g, ''))
        : dm[2].replace(/%[0-9A-Fa-f]{2}/g, m => { try { return decodeURIComponent(m); } catch (_) { return m; } });
    } else if (typeof globalThis.__rackFetch === 'function') {
      // Otherwise resolve relative URLs against the document base and fetch.
      let url = raw;
      try {
        const base = baseURL || (globalThis.location && globalThis.location.href) || null;
        const u = globalThis.__csim_parseUrl(url, base);
        if (u && !u.error) url = u.href;
      } catch (_) { /* keep the raw specifier */ }
      const resp = globalThis.__rackFetch('GET', url, '', null, 'follow');
      css = resp && resp.body != null ? String(resp.body) : '';
    }
    if (css == null) return null;
    const sheet = new globalThis.CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet;
  } catch (_) { return null; }
}

// Declarative Shadow DOM: convert each `<template shadowrootmode=open|closed>`
// in `root`'s subtree into a real shadow root on its parent (the host),
// moving the template's content into the shadow tree and removing the
// template. Per the HTML parser's "attach a shadow root" steps this runs only
// for trusted parsing (main-document parse + `setHTMLUnsafe` / `parseHTMLUnsafe`)
// — NOT for `innerHTML` / `insertAdjacentHTML`, which leave the template intact.
// A template that doesn't convert (invalid mode, host already hosts a shadow
// tree, or a host that can't attach one) is left untouched, but its content is
// still scanned for nested declarative shadow roots. The walk runs before the
// tree is connected, so slot assignment happens later on connect as usual.
// `contextEl` is the fragment-parsing context element — the node a top-level
// `setHTMLUnsafe`/`innerHTML` was invoked on. Per HTML's DSD tree-construction
// (verified against Chrome), that element is NEVER a declarative shadow host for
// its own direct `<template shadowrootmode>` children: such a template parses as
// a child of the synthetic fragment root (discarded), not of the context, so it
// is moved over as a plain template. Only a *parsed descendant* element hosts a
// declarative shadow. This matters for void hosts: `el.setHTMLUnsafe('<br><template
// shadowrootmode=open>…')` leaves `<br>` childless, so the template lands directly
// under the context element and must stay a template — not become its shadow.
// The exemption is the top-level call's concern only; recursion passes no context
// (every descendant is a legitimate host).
// Convert ONE `<template shadowrootmode>` (the DSD opt-in) into a real shadow
// root on its host, moving the template's content into it. A no-op (leaving the
// template in place) when the host can't host a shadow — invalid host, already a
// host, mode mismatch, or moved off a valid parse-time parent. Shared by the
// post-parse walk below and the streaming parser's `onItemPop`, which calls this
// the instant a `</template>` closes so a following parse-time script sees
// `host.shadowRoot` already populated (declarative-shadow-dom-basic.html et al).
export function convertDeclarativeTemplate(node, contextEl = null) {
  const ma   = node._attrs.shadowrootmode;
  const mode = ma == null ? '' : asciiLower(String(ma));
  // Attach to the parent the template had WHEN PARSED. "Moving the template
  // doesn't change attachment point" (move-template-before-closing-tag.html): a
  // streaming parse-time script (or MutationObserver) can move the template off
  // its parent before conversion, but the shadow still attaches to the original
  // parent — and never attaches if that parent wasn't a valid host (video → div).
  // `_dsdOriginalParent` is pinned at parse time by the tree builder (html-tree-builder.js); absent
  // (non-streaming / innerHTML / setHTMLUnsafe fragment) → the current parent.
  const host = node._dsdOriginalParent || node._parent;
  let sr = null;
  if ((mode === 'open' || mode === 'closed') && host && host._nodeType === NODE_ELEMENT && host !== contextEl && !host._shadowRoot && canAttachShadow(host)) {
    try {
      sr = host._attachShadow({
        mode,
        delegatesFocus: node._attrs.shadowrootdelegatesfocus != null,
        clonable:       node._attrs.shadowrootclonable != null,
        serializable:   node._attrs.shadowrootserializable != null,
        // `shadowrootslotassignment="manual"` opts the declarative root into
        // manual slot assignment (default "named"); case-insensitive.
        slotAssignment: String(node._attrs.shadowrootslotassignment || '').toLowerCase() === 'manual' ? 'manual' : 'named',
        // `shadowrootcustomelementregistry` opts the declarative root into the
        // NULL registry: its content never upgrades until a registry claims it
        // via initialize() (the state is sticky through clone and adoption).
        ...(node._attrs.shadowrootcustomelementregistry != null ? { customElementRegistry: null } : {})
      });
    } catch (_) { sr = null; }   // unsupported host → leave the template as-is
    if (sr) sr._declarative = true;   // a re-attachShadow of the same mode reuses it
    // (…its "keep custom element registry null": an adopt leaves its null as it is)
    if (sr && node._attrs.shadowrootcustomelementregistry != null) sr._keepNullRegistry = true;
  }
  if (sr) {
    // Preserve the authored `shadowrootadoptedstylesheets` value (present-but-
    // empty vs absent) so getHTML() round-trips it. This is the PARSE-TIME
    // authored string, independent of the live adoptedStyleSheets list — script
    // mutations to that list never change the serialized attribute.
    sr._adoptedStyleSheetsAttr = node._attrs.shadowrootadoptedstylesheets != null
      ? String(node._attrs.shadowrootadoptedstylesheets)
      : null;
    // The shadow roots nested in the content, whose hosts took their light children while it was inert.
    const nested = [];
    const content = node._templateContent;
    if (content) {
      insertEdges(sr, clearEdges(content), -1);
      // The children were parsed under the template's ASSOCIATED INERT TEMPLATE
      // DOCUMENT; becoming the shadow tree moves them into the HOST's document.
      // In spec terms declarative shadow content is parsed straight into the
      // shadow root and never belongs to the template document, so this is an
      // owner rewrite, NOT an adopt — no adoptedCallback fires (and registry
      // resolution for the undefined-association default must find the host
      // window's registry, not the inert document's none).
      const dest = host._ownerDoc || globalThis.document;
      // Shadow-INCLUDING walk: a nested `<template shadowrootmode>` converted
      // while this content was still inert left its inner shadow tree owned by
      // the inert document — only a walk that descends `_shadowRoot` re-homes
      // it, and the upgrade gate (ownerDocument === document) depends on that
      // (Lit-SSR-style nested declarative shadow DOM).
      for (const c of sr._children) {
        walkInclShadow(c, n => {
          if (n._ownerDoc !== dest) {
            n._ownerDoc = dest;
            if (n._attrNodes) for (const k in n._attrNodes) n._attrNodes[k]._ownerDoc = dest;
          }
          // A nested host's shadow ROOT re-homes with it (its owner feeds the
          // adopt decision for later insertions into that shadow tree).
          if (n._shadowRoot) {
            if (n._shadowRoot._ownerDoc !== dest) n._shadowRoot._ownerDoc = dest;
            nested.push(n._shadowRoot);
          }
          // A template nested in the shadow content keeps ITS content inert —
          // re-homed to the destination document's inert template document.
          if (n._tag === 'template' && n._templateContent) adoptTemplateContentInto(n._templateContent, dest, null);
        });
      }
    }
    // The null-registry root marks its parsed content STICKY-null (an element
    // moved OUT of the root keeps it — element-mutation-null-registry-removal);
    // a PLAIN declarative root's content instead leaves the template-contents
    // "document" here, re-pointing the tracking sentinel to the unset state.
    if (node._attrs.shadowrootcustomelementregistry != null) {
      for (const c of sr._children) walkSubtree(c, n => { if (n._nodeType === NODE_ELEMENT && (n._ceRegistry === undefined || n._ceRegistry === TRACKING_NULL)) n._ceRegistry = null; });
    } else {
      for (const c of sr._children) walkSubtree(c, n => { if (n._ceRegistry === TRACKING_NULL) n._ceRegistry = undefined; });
    }
    // Remove the template from its CURRENT parent — a parse-time script may have
    // moved it off `host` (the original parent) before this conversion.
    removeEdge(node);
    // Drop the now-detached template's handle (the setHTMLUnsafe path
    // registered it via innerHTML; the main-doc path never did, so this
    // is a no-op there), then register the shadow tree so Ruby-side
    // find/lookup resolves nodes inside it — `registerSubtree` only descends
    // `_children`, never `_shadowRoot`, and attachShadow registered an empty
    // root. Upgrade any custom elements now in the shadow tree (the CE connect/
    // disconnect walks ARE shadow-aware via walkInclShadow, but those fire on a
    // later connect; this DSD-conversion path upgrades the freshly-built tree).
    unregisterSubtree(node);
    registerSubtree(sr);
    ceUpgradeTree(sr);
    // …and its slots take the host's children now: the content came over as a bare splice, which no slot hook sees, so
    // the assigned sets — and the style engine's flat tree built from them — would wait for the host's next child-list
    // change (an iframe's `document.write` of a declarative root left its slotted text out of `innerText`). So do the
    // slots of every root nested in it: the spec parses declarative content straight into the shadow tree, where each
    // child the parser gave a nested host was assigned as it came, but no slot hook sees a parse into inert content —
    // a `<slot>` re-slotted into a nested root's slot left everything slotted through it out of the flat tree.
    assignSlottablesForShadowRoot(sr);
    for (const r of nested) assignSlottablesForShadowRoot(r);
    // Declarative adoptedStyleSheets: resolve each space-separated
    // specifier in `shadowrootadoptedstylesheets` to a CSSStyleSheet.
    const adopt = node._attrs.shadowrootadoptedstylesheets;
    if (adopt != null && String(adopt).trim() !== '') {
      const base = host.ownerDocument && host.ownerDocument._url;
      const sheets = [];
      for (const spec of String(adopt).split(/\s+/)) {
        if (!spec) continue;
        const s = sheetFromSpecifier(spec, base);
        if (s) sheets.push(s);
      }
      if (sheets.length) sr.adoptedStyleSheets = sheets;
    }
    processDeclarativeShadowRoots(sr);   // nested declarative shadow roots
    return;
  }
  // Not converted: still scan the inert content for nested declarative roots.
  if (node._templateContent) processDeclarativeShadowRoots(node._templateContent);
}

export function processDeclarativeShadowRoots(root, contextEl = null) {
  if (!root || !root._children) return;
  for (const node of root._children.slice()) {
    if (node._nodeType !== NODE_ELEMENT) continue;
    if (node._tag === 'template' && node._ns === HTML_NS) {
      convertDeclarativeTemplate(node, contextEl);
      continue;
    }
    processDeclarativeShadowRoots(node);
    if (node._shadowRoot) processDeclarativeShadowRoots(node._shadowRoot);
  }
}

// The shadow root that `node` is a descendant of (or is), else null.
function enclosingShadowRoot(node) {
  for (let n = node; n; n = n._parent) {
    if (n._isShadowRoot) return n;
  }
  return null;
}
// True iff `el` is an HTML <slot>. A foreign-namespace element whose local
// name happens to be "slot" (SVG `createElementNS`) does NOT participate in
// slot assignment, so the namespace check is load-bearing, not cosmetic.
function isHtmlSlot(el) {
  return el._tag === 'slot' && el._ns === HTML_NS;
}
// The slot `node` is assigned to, per "find a slot". `openOnly` mirrors the
// `assignedSlot` getter's open flag (a slot in a closed shadow tree is hidden).
function findSlotForSlottable(node, openOnly) {
  const parent = node._parent;
  if (!parent) return null;
  const sr = parent._shadowRoot;
  if (!sr) return null;
  if (openOnly && sr.mode !== 'open') return null;
  return assignedSlotOf(node);
}
// Mode-agnostic slot lookup for the cascade's `::slotted` matching (the public
// `assignedSlot` is open-only; styling must not depend on shadow-root mode).
// Exposed as a global so cascade.js can call it without importing dom-nodes
// (which would create an import cycle).
globalThis.__csimSlotForStyling = function (node) { return findSlotForSlottable(node, false); };
// …and the same lookup for the FLAT-TREE parent (walk.js), which the layout pass descends and the
// mutation recorder walks back up. Installed rather than imported: walk.js is one of our imports.
setSlotResolver(node => findSlotForSlottable(node, false));

// Move focus to the next (Tab) / previous (Shift-Tab) sequential focus stop (focus.rs `next`: HTML's "sequential
// navigation search algorithm" over the document, shadow root and slot scopes), wrapping round at the document's ends.
// The answer is the stop's nid and the path to it from the document, followed here — and checked: a stop the path does
// not reach is found by its nid instead. A cold path (Capybara's send_keys, testdriver), never on find / dispatch /
// dom_op.
globalThis.__csimAdvanceFocus = function (reverse) {
  const doc = globalThis.document;
  if (!doc) return false;
  const cur = doc._activeElement;
  const path = sequentialFocusPath(doc, cur && isConnected(cur) ? cur : null, !!reverse);
  if (!path) return false;
  let next = doc;
  for (let i = 1; i < path.length; i++) next = next && (path[i] < 0 ? next._shadowRoot : next._children[path[i]]);
  if (!next || next._nid !== path[0]) {
    next = null;
    walkInclShadow(doc, (n) => { if (next === null && n._nid === path[0]) next = n; });
  }
  globalThis.__csimFocusModality = 'keyboard';   // Tab is keyboard-driven → :focus-visible applies
  if (next) { try { next._focus(); } catch (_) {} }
  return true;
};

// slot.assign(...nodes): set the slot's manually-assigned nodes (deduped,
// first-occurrence order), stealing each node from any slot that previously
// held it, and assign the slots of every shadow root whose assignments moved.
// The lists are kept here, on the nodes, and handed to the engine (`syncManualAssigned`).
export function assignManualSlottables(slot, nodes) {
  const seen = new Set();
  const deduped = [];
  for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (!seen.has(n)) { seen.add(n); deduped.push(n); } }
  const touched = new Set();
  const here = enclosingShadowRoot(slot);
  if (here) touched.add(here);
  const prev = slot._manualAssignedNodes || EMPTY_NODES;
  for (let i = 0; i < prev.length; i++) { if (prev[i]._manualSlot === slot) prev[i]._manualSlot = null; }
  for (let i = 0; i < deduped.length; i++) {
    const n = deduped[i], old = n._manualSlot;
    if (old && old !== slot) {
      old._manualAssignedNodes = (old._manualAssignedNodes || EMPTY_NODES).filter((x) => x !== n);
      syncManualAssigned(old);
      const osr = enclosingShadowRoot(old);
      if (osr) touched.add(osr);
    }
  }
  slot._manualAssignedNodes = deduped;
  for (let i = 0; i < deduped.length; i++) deduped[i]._manualSlot = slot;
  syncManualAssigned(slot);
  for (const sr of touched) assignSlottablesForShadowRoot(sr);
}
const EMPTY_NODES = [];
export function slotAssignedNodes(slot, options) {
  return assignedNodesOf(slot, !!(options && options.flatten === true));
}

// Whether any shadow root is attached: the gate dispatch.js's flattened-tree event path is behind, so a shadow-free page
// keeps the cheap `_parent`-only walk (rule 3).
export function hasShadowRoots() { return shadowHostCount > 0; }

// Assign the slots of `sr` — and `left`, slots that have left a shadow tree — anew (slots.rs), and for each slot whose
// assigned nodes changed: its slotchange, and the nodes that LEFT it marked as moved subtrees, which leave the flat tree
// (or move to another slot) with nothing above them that the change marks. A span whose `slot` attribute went away kept
// its box, its rect and its hit test (Chrome: none of them).
function assignSlottablesForShadowRoot(sr, left) {
  assignSlots(sr, left, slotAssignmentChanged);
}
function slotAssignmentChanged(slot, left) {
  for (let i = 0; i < left.length; i++) markLayoutDirty(left[i], true);
  signalSlotChange(slot);
}
function subtreeHasSlot(nodes) {
  if (!nodes || !nodes.length) return false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || n._nodeType !== NODE_ELEMENT) continue;
    if (isHtmlSlot(n) || walkFind(n, isHtmlSlot)) return true;
  }
  return false;
}
// The slots of the removed subtrees: each one pulled out of its shadow tree loses its assigned nodes, which is a
// slotchange on it where it had any (a shadow root's assignment revisits only the slots still in it).
function removedSlots(removed) {
  const out = [];
  for (let i = 0; i < removed.length; i++) {
    const n = removed[i];
    if (n && n._nodeType === NODE_ELEMENT) walk(n, (el) => { if (isHtmlSlot(el)) out.push(el); });
  }
  return out;
}
// Mutation hooks installed into mutation-observer.js. Both self-gate on
// shadowHostCount so a shadow-free page does no slot work at all.
setSlotMutationHooks(
  function onChildListMutation(target, added, removed) {
    if (!shadowHostCount || !target) return;
    // Light children of a shadow host changed → re-match against its slots.
    if (target._shadowRoot) assignSlottablesForShadowRoot(target._shadowRoot);
    // A <slot> entered/left/moved within a shadow tree → its slot set changed; and a slot removed from one loses its
    // assignments.
    const lost = subtreeHasSlot(removed);
    if (lost || subtreeHasSlot(added)) assignSlottablesForShadowRoot(enclosingShadowRoot(target), lost ? removedSlots(removed) : null);
    // Changing the children of a slot that is showing fallback content (empty
    // assigned nodes) changes the flattened tree → slotchange on that slot, and
    // up the nested-fallback chain (an enclosing slot also showing fallback).
    if (isHtmlSlot(target) && enclosingShadowRoot(target)) {
      for (let s = target; s && isHtmlSlot(s); s = s._parent) {
        if (assignedNodesOf(s, false).length) break;
        signalSlotChange(s);
      }
    }
  },
  function onAttrMutation(target, key) {
    if (!shadowHostCount || !target) return;
    if (key === 'slot') {
      const host = target._parent;
      if (host && host._shadowRoot) assignSlottablesForShadowRoot(host._shadowRoot);
    } else if (isHtmlSlot(target)) {   // key === 'name'
      const sr = enclosingShadowRoot(target);
      if (sr) assignSlottablesForShadowRoot(sr);
    }
  }
);
setSlotChangeFirer(function fireSlotChange(slot) {
  // `slotchange` bubbles within the shadow tree, is not composed, and carries
  // no relatedTarget (a plain Event).
  fireEvent(slot, new Event('slotchange', { bubbles: true }));
});

// WindowEventHandlers, which `<body>` / `<frameset>` reflect to their Window (`<body onpopstate>` → `window.onpopstate`,
// the FORWARDED_TYPE gate in installEventHandlerAttrs) — HTMLBodyElement's and HTMLFrameSetElement's, which
// dom-class-aliases.js installs them onto. (GlobalEventHandlers' blur / error / focus / load / resize / scroll they
// forward too.)
export function installWindowReflectedHandlers(proto) {
  installEventHandlerAttrs(proto, WINDOW_EVENT_HANDLERS, (el) => el._ns === HTML_NS && (el._localName === 'body' || el._localName === 'frameset'));
}

// The inline-handler scope chain includes an element's form owner only when the
// element is form-associated: the listed elements + <img> + a form-associated custom
// element (whose definition sets `static formAssociated = true`). A plain element —
// or <label>/<legend>/<option>, which expose `.form` but aren't form-associated —
// contributes no form scope.
const SCOPE_FORM_ASSOCIATED = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea', 'img']);
setScopeFormOwnerResolver((node) => {
  const associated = SCOPE_FORM_ASSOCIATED.has(node._tag) || isFormAssociatedCustomElement(node);
  return associated ? (formForControl(node) || null) : null;
});

// A document's DOMImplementation (DOM §4.5.1), generated from its IDL: `document.implementation`, one per document (the
// document's `_implementation`), no page's to construct.
class DOMImplementation {
  constructor(token, doc) {
    constructedBy(PLATFORM, token, 'DOMImplementation');
    makeSlots(this, 'DOMImplementation', { doc });
  }
}
const implementationOf = (o) => slotsOf(o, 'DOMImplementation');
registerInterface('DOMImplementation', (o) => implementationOf(o) !== undefined);
installDOMImplementation(DOMImplementation, {
  // (…a valid doctype name the only check: no namespace's)
  createDocumentType(impl, name, publicId, systemId) {
    if (!isValidDoctypeName(name)) {
      throw new globalThis.DOMException(`The qualified name '${name}' is not a valid doctype name.`, 'InvalidCharacterError');
    }
    return new DocumentType(PLATFORM, name, publicId, systemId, implementationOf(impl).doc);
  },
  // (…an XMLDocument: its doctype — appended, as a node is: taken from wherever it was, its old parent's observers told —
  // then a root element of the validated qualified name where one is given — none for "", which a null one is; its
  // content type by its namespace)
  createDocument(impl, namespace, qualifiedName, doctype) {
    const ns = namespace === '' ? null : namespace;
    let rns = null, prefix = null, localName = null;
    if (qualifiedName !== '') ({ namespace: rns, prefix, localName } = validateAndExtract(ns, qualifiedName, 'element'));
    const d = newXMLDocument();
    d._contentType = ns === HTML_NS ? 'application/xhtml+xml' : ns === SVG_NS ? 'image/svg+xml' : 'application/xml';
    clearEdges(d);                         // (the constructor yields an empty document)
    d._readyState = 'complete';            // fully constructed — no loading phase
    if (doctype !== null) d._appendChild(doctype);
    if (qualifiedName !== '') appendEdge(d, d._createElement(rns, prefix, localName));
    return d;
  },
  // (…an HTML document with no browsing context — URL about:blank, `location` null, as the constructor's — of a doctype
  // and an `html` holding a `head`, with a `title` where one is given, and a `body`)
  createHTMLDocument(impl, title) {
    const d = new Document();
    const html = createElementNode('html'), head = createElementNode('head');
    appendEdge(html, head);
    appendEdge(html, createElementNode('body'));
    appendEdge(d, new DocumentType(PLATFORM, 'html', '', '', d));
    appendEdge(d, html);
    if (title !== undefined) {
      const t = createElementNode('title');
      appendEdge(t, new Text(title));
      appendEdge(head, t);
    }
    d._contentType = 'text/html';
    walkSubtree(d, n => { n._ownerDoc = d; });
    return d;
  },
  // (…legacy: always true)
  hasFeature: () => true
});
globalThis.DOMImplementation = DOMImplementation;

// The `customElementRegistry` member of an ElementCreationOptions / ShadowRootInit:
// absent → undefined (the document's default registry), an explicit `null` → the
// null-registry state, or a CustomElementRegistry. A non-null, non-registry value is
// a WebIDL type error. Returns undefined when the member is absent so a plain
// `createElement('div')` allocates no per-element registry field.
function ceRegistryOption(options) {
  if (!options) return undefined;
  const reg = options.customElementRegistry;
  if (reg === undefined) return undefined;   // absent or explicit undefined → the document default
  if (reg !== null && !isRegistry(reg)) {   // (…any realm's, by its slots)
    throw new globalThis.TypeError("The 'customElementRegistry' option is not a CustomElementRegistry.");
  }
  return reg;
}

// HTML "create an element" post-construction checks (synchronous custom elements
// flag). After `new ctor()`, the constructor must have returned THIS element,
// untouched: an Element, still empty (no attributes / no children), unparented, in
// `doc`, HTML-namespaced, with the matching local name. Returns the error to REPORT
// (not throw to the caller) on the first deviation, or null when the element is well
// formed. A non-node / non-Element return is a TypeError; every other deviation is a
// NotSupportedError. `doc` is the createElement document; a freshly constructed
// element carries `_ownerDoc === null` (assigned later), which counts as `doc`.
function constructedElementError(el, doc, localName) {
  if (el == null || el.__csimIsNode !== true || el._nodeType !== NODE_ELEMENT) {
    return new globalThis.TypeError("Failed to construct custom element: the constructor did not return an element.");
  }
  const nse = (m) => new globalThis.DOMException(m, 'NotSupportedError');
  if (Object.keys(el._attrs).length !== 0)            return nse("The custom element constructor added an attribute.");
  if (el.firstChild != null)                          return nse("The custom element constructor added a child node.");
  if (el._parent != null)                             return nse("The custom element constructor inserted the element into a parent.");
  if (el._ownerDoc != null && el._ownerDoc !== doc)   return nse("The custom element constructor moved the element into another document.");
  if (el._ns !== HTML_NS)                              return nse("The custom element was constructed in the wrong namespace.");
  if (el._localName !== localName)                    return nse("The custom element's local name does not match its definition.");
  return null;
}

// HTML "create an element for the token" with the will-execute-script flag
// (a LIVE, non-fragment parse): a token whose local name has a definition
// constructs the custom element SYNCHRONOUSLY, right there in the parser,
// BEFORE its attributes are set and its children appended — so the
// constructor sees an empty element, and the returned value (which need not
// be the one `super()` made) is what lands in the tree. A constructor that
// throws, skips `super()`, or returns a non-element / malformed element
// yields a FALLBACK element implementing HTMLUnknownElement (marked here;
// see the HTMLUnknownElement brand check), with the failure reported.
// Returns null when the token has no definition — the parser then builds a
// plain element as before, and a later definition upgrades it.
export function constructParsedCustomElement(localName, doc, isValue) {
  // Rule 3: the parser calls this for EVERY element of every live parse. A page
  // with no definitions at all (the overwhelming majority) pays one boolean.
  if (!hasAnyCEDefinitions()) return null;
  const reg  = documentRegistry(doc);
  const ctor = reg ? lookupCEDefinitionCtor(reg, localName, isValue) : undefined;
  if (!ctor) return null;
  const el = constructCustomElementSync(ctor, doc, localName,
    doc && doc._ceRegistry !== undefined ? doc._ceRegistry : undefined);
  // A creation in an initialize()d document PINS the scoped association, like
  // _createElement's own construction path.
  if (doc && doc._ceRegistry !== undefined) el._ceRegistry = doc._ceRegistry;
  if (isValue != null) el._isValue = String(isValue);
  return el;
}

// HTML "create an element" with the synchronous custom elements flag: run the
// constructor and validate what it returned. On ANY failure (a throw, a missing
// `super()`, a non-element / malformed return) the exception is REPORTED — never
// propagated to the caller — and the result is a plain element in custom element
// state "FAILED" (`_unknownFallback`): it implements HTMLUnknownElement when its
// name is an autonomous custom element name, and it never upgrades later. Shared
// by `document.createElement` and the parser's create-an-element-for-the-token.
// `creationRegistry` is what the element being constructed should associate with
// (createElement's explicit `customElementRegistry` option, else the document's
// own association) — it is readable as `this.customElementRegistry` INSIDE the
// constructor, so it must be the caller's value, not re-derived here.
function constructCustomElementSync(ctor, doc, localName, creationRegistry) {
  const prev = __currentTag, prevReg = __currentCreationRegistry;
  __currentTag = localName;
  __currentCreationRegistry = creationRegistry;
  try {
    const el  = new ctor();
    const err = constructedElementError(el, doc, localName);
    if (err) throw err;
    becomeCustom(el, ctor);   // once custom, always custom
    return el;
  } catch (e) {
    try { globalThis.__csimReportError(e); } catch (_) {}
    // A failed element's interface is HTMLUnknownElement for an autonomous name — not the HTMLElement an undefined
    // custom element name is born as — and its built-in's for a customized built-in.
    const fb = isValidCustomElementName(localName) ? Reflect.construct(Element, [localName], NAMESPACE_TARGETS.htmlUnknown)
      : createElementNode(localName);
    fb._unknownFallback = true;
    return fb;
  } finally {
    __currentTag = prev;
    __currentCreationRegistry = prevReg;
  }
}

// A candidate for constraint validation that fails one (a form-associated custom element by its internals).
function suffersConstraintFailure(el) {
  if (isFormAssociatedCustomElement(el)) {
    const i = el._internals;
    return i != null && faceWillValidate(el) && internalsSuffersFailure(i);
  }
  return el.willValidate === true && !el.validity.valid;
}

// The document's focused and hovered element each carries the matching state bit, where the native `:focus` /
// `:focus-within` / `:hover` start: `prev` gives it up and `next` takes it.
// The unfocus steps of the element losing focus to `related` (null: to another document): a text control commits its
// pending `change` first, then blur and focusout — FocusEvents, so the dispatch retargets `related` across shadow
// boundaries (shadow-relatedTarget) — and a customizable `<input list>` closes its datalist popover.
function loseFocus(prev, related) {
  commitChangeOnBlur(prev);
  fireEvent(prev, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true, view: globalThis, relatedTarget: related }));
  fireEvent(prev, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true, view: globalThis, relatedTarget: related }));
  if (prev._tag === 'input' && prev._attrs.list != null) hideComboboxDatalist(prev);
}
// The document in `container`'s frame (its realm's, whatever its origin), or null.
function frameDocumentOf(container) {
  try {
    const w = globalThis.RustyRacer.contextGlobal(container._frameRealmId);
    return w ? w.document : null;
  } catch (_) {
    return null;
  }
}
function markStateOwner(prev, next, bit) {
  if (prev && prev._csimState !== undefined) setElementState(prev, bit, 0);
  if (next && next._csimState !== undefined) setElementState(next, bit, bit);
}

// HTML's removing steps for a showing popover and a dialog: a removed popover hides and a removed dialog is modal no
// more — quietly, with no toggle events — so neither is `:popover-open` / `:modal` when it comes back; and a removed
// dialog leaves its document's open dialogs, which no close request reaches until it opens again.
setRemovingSteps((el) => {
  if (isDialog(el)) dialogClosed(el);
  if (!(el._csimState & (STATE_POPOVER_OPEN | STATE_MODAL))) return;
  setElementState(el, STATE_POPOVER_OPEN | STATE_MODAL, 0);
  bumpStyleState();
});

class Document extends Node {
  // FOCUS and HOVER, signalled where they are written. The focused element is assigned from a dozen places (focus / blur
  // / removal / navigation / dialog / shadow retarget), and the hovered one by the driver and by specs alike — but every
  // one of them assigns THIS property, so its setter sees them all. (They were compared on every style read instead:
  // a poll that dereferenced two WeakRefs per call and was 3% of a layout pass.) The page's document only: another
  // document's focus moves no rule of this one.
  // A frame's document passes both up: what is focused or hovered in it makes its container — the `<iframe>` — the
  // parent document's (HTML: the parent's focused area is the navigable container; `iframe:focus-within` and the
  // parent's `:hover` chain match, and `document.activeElement` is the iframe — Chrome). The hover leaving the container
  // in the parent leaves the frame's document too.
  get _activeElement() { return this.__activeElement; }
  set _activeElement(v) {
    const prev = this.__activeElement;
    this.__activeElement = v;
    if (v !== prev && this === globalThis.document) {
      markStateOwner(prev, v, STATE_FOCUSED);
      bumpStyleState();
      const container = globalThis.__csimFrameContainer;
      if (v && container) container._takeFocusFromFrame();
    }
  }
  get _hoverElement() { return this.__hoverElement; }
  set _hoverElement(v) {
    const prev = this.__hoverElement;
    this.__hoverElement = v;
    if (v !== prev && this === globalThis.document) {
      markStateOwner(prev, v, STATE_HOVERED);
      bumpStyleState();
      const container = globalThis.__csimFrameContainer;
      if (v && container) container.ownerDocument._hoverElement = container;
      const left = prev && prev._frameRealmId != null ? frameDocumentOf(prev) : null;
      if (left && left.__hoverElement) left._hoverElement = null;
    }
  }
  constructor() {
    super(NODE_DOC);
    defineDocumentUnforgeables(this);
    registerNativeNode(this);
    this.__activeElement = null;   // behind `_activeElement` / `_hoverElement` (above)
    this.__hoverElement  = null;
    // The bare `new Document()` is a spec-empty document (DOM §4.5.1 "Document"
    // constructor): no children, no browsing context (so `location` is null and
    // `URL` / `documentURI` are "about:blank"), content type "application/xml"
    // (→ `isHtmlDocument` false → case-sensitive element / attribute handling),
    // and readyState "complete". The driver's actual page — an HTML document
    // with a browsing context, an html/head/body skeleton, and readyState
    // 'loading' (so library IIFEs that sniff `document.readyState` register a
    // DOMContentLoaded listener instead of self-scheduling onto the virtual
    // clock) — is built by `createHtmlPageDocument`; the HTML / XML parsers
    // reset these defaults to their parsed-document equivalents.
    this._readyState         = 'complete';
    this._contentType       = 'application/xml';
    this._url               = 'about:blank';
    this._noBrowsingContext = true;
    // (…an XMLDocument's brand, its own on every document: a miss would read on into the named properties — a
    // `<form name="_xmlDocument">` — through Document.prototype)
    this._xmlDocument       = false;
    // GlobalEventHandlers IDL attributes (`document.onclick` / `oninput` / …) are
    // installed as spec-faithful EventHandler accessors on Document.prototype below
    // (installEventHandlerAttrs) — assigning one registers a real listener, and the
    // `in` probe React-DOM's input-change polyfill relies on (`'oninput' in
    // document`) still answers true via the prototype accessor.
  }
  // Document node basics (BATCH H) — the Document node's own
  // nodeName / nodeValue / ownerDocument per DOM spec. (Document
  // inherits Node's ownerDocument, which would resolve to itself;
  // spec says a Document's ownerDocument is null.)
  get _nodeName()      { return '#document'; }
  get _textContent()   { return null; }
  set _textContent(_)  { /* spec: no-op for Document */ }
  get _ownerDocument() { return null; }
  // Cloning a Document yields a new EMPTY document of the same kind, carrying
  // its content type and URL but no browsing context (Chrome: no defaultView, no
  // location) — children are copied only on a deep clone (cloneNode handles that
  // + sets documentElement).
  _cloneShell() {
    // (…of its own interface, an XMLDocument's an XMLDocument — not of the `constructor` a page may have replaced)
    const d = this._xmlDocument ? newXMLDocument() : new Document();
    clearEdges(d);   // empty → documentElement derives as null
    d._contentType = this._contentType;
    d._noBrowsingContext = true;
    d._url = this.URL;   // the page's URL, resolved: the clone has no location to resolve it by
    d._readyState = 'complete';
    return d;
  }
  get _baseURI()       { return documentBaseURL(this); }
  // Shared "create an element" step for createElement / createElementNS: build
  // the element (custom-element upgrade only in the HTML namespace) and stamp
  // its namespace slots + owner document.
  _createElement(ns, prefix, localName, registry, isValue) {
    let el;
    // "Look up a custom element definition" (HTML) returns null for a document with
    // no browsing context, so createElement in an INERT document — a createHTMLDocument
    // / createDocument result, a cloned or DOMParser document — builds a plain
    // (undefined-state) element rather than constructing the custom element. It
    // upgrades later when connected into / adopted by a browsing-context document.
    // Only this realm's live `document` has a browsing context.
    //
    // `registry` is the element's custom element registry (createElement's
    // customElementRegistry option, or a scoped shadow tree's registry): a
    // CustomElementRegistry to associate + look up in, `null` for the explicit
    // null-registry state, or `undefined` for the document's default (the global
    // registry in the live document, null in an inert one). The default path stays
    // exactly as before — no `_ceRegistry` field, definitions from the global registry.
    // `isValue` (from createElement's `is` option) selects a customized built-in
    // definition when present.
    const explicit = registry !== undefined;
    // Default (unset) → the document's global registry; an explicit scoped registry →
    // its own definitions; explicit null → no definition. The lookup matches an
    // autonomous CE by local name or a customized built-in by (local name + is value).
    // Use the MODULE's registry binding, not `globalThis.customElements` — a page may
    // delete / overwrite the `window.customElements` property, yet its defined elements
    // must still construct (overwritten-customElements-global).
    // The document's ACTIVE registry (global in the live document, null in an
    // inert one, its scoped association after initialize()) unless overridden.
    const lookupReg = ns !== HTML_NS ? null : explicit ? registry : documentRegistry(this);
    // …by the local name as it is: `createElement` has already ASCII-lowercased it, and `createElementNS` keeps its
    // case (`x-Ö` is defined, and looked up, as `x-Ö`).
    const ctor = lookupReg ? lookupCEDefinitionCtor(lookupReg, localName, isValue) : undefined;
    if (ctor) {
      const prev = __currentTag, prevReg = __currentCreationRegistry;
      __currentTag = localName;
      __currentCreationRegistry = explicit ? registry : (this._ceRegistry !== undefined ? this._ceRegistry : undefined);
      // HTML "create an element" with the synchronous flag set — the shared
      // construct-and-validate (see constructCustomElementSync): a constructor
      // that throws or returns a malformed element REPORTS (never propagates to
      // the createElement caller) and yields a "failed" element with this local
      // name — a real `<div>` for a customized built-in, an
      // HTMLUnknownElement-implementing element for an autonomous name.
      try {
        el = constructCustomElementSync(ctor, this, localName,
          explicit ? registry : (this._ceRegistry !== undefined ? this._ceRegistry : undefined));
      } finally { __currentTag = prev; __currentCreationRegistry = prevReg; }
      // (…an HTML element of the local name it was looked up by: only its prefix is left to give it)
      el._prefix = prefix;
    } else {
      el = createElementNode(localName, ns, localName, prefix);
    }
    // The is value is an internal slot (NOT an `is` content attribute): it keeps a
    // customized built-in matchable after creation and drives `:defined`.
    if (isValue != null) el._isValue = String(isValue);
    el._ownerDoc  = this;
    // Record only a non-default (scoped or explicit-null) association; the default
    // leaves `_ceRegistry` unset so registryForElement resolves to the global registry.
    if (explicit) el._ceRegistry = registry;
    // A creation in an initialize()d document PINS the scoped association on the
    // element (adoption must not strip it); the common live/inert default stays
    // unstamped (one property read — rule 3).
    else if (this._ceRegistry !== undefined && ns === HTML_NS) el._ceRegistry = this._ceRegistry;
    return el;
  }
  // `document.write(...)` / `writeln` / `open` / `close` — the HTML document.write
  // entry point. We don't model a streaming parser with a live insertion point,
  // so write() parses its concatenated markup as a fragment in the <body> context
  // and APPENDS it (never implicitly open()/clears — a clear-and-rewrite of the
  // live page would wipe the running test; every write() use here is an append:
  // during-parse insertion, a fresh empty iframe, or a fresh createHTMLDocument).
  // Declarative shadow roots (`<template shadowrootmode>`) in the written markup
  // are converted only when the document HAS a browsing context — a
  // createHTMLDocument document (`_noBrowsingContext`) must NOT convert them, per
  // the HTML "document.write disallowed on fresh document" rule.
  // (shadow-dom/declarative/declarative-shadow-dom-{opt-in,write-to-iframe}.html)
  // HTML "throw-on-dynamic-markup-insertion counter": >0 while the parser is
  // synchronously running a custom element constructor / its reactions for THIS
  // document — document open/write/writeln/close must throw InvalidStateError
  // then (custom-elements/throw-on-dynamic-markup-insertion-counter-*).
  // Per-document, so another document's methods stay callable from the same
  // constructor. Modeled on the write() parse+append span only; the INITIAL
  // streaming page build does not hold it yet (a CE constructor in the first
  // parse calling document.write is a known gap — no vendored test exercises
  // it), and the span is deliberately WIDER than spec (held across the whole
  // parse+append+DSD walk, not just CE callback invocations) — revisit if
  // written <script> bodies ever start executing, since a reentrant
  // write-inside-written-script would then wrongly throw.
  _throwIfMarkupInsertionGuarded(op) {
    // The document open / write / close steps all begin with "If document is
    // an XML document, throw an InvalidStateError" — dynamic markup insertion
    // is an HTML-parser affordance (the -xml-parser counter tests hang their
    // expected throws on this rule, not on the counter).
    if (!isHtmlDocument(this)) {
      throw new globalThis.DOMException(
        "Failed to execute '" + op + "' on 'Document': Only HTML documents support " + op + "().",
        'InvalidStateError');
    }
    if (this._markupInsertionCounter > 0) {
      throw new globalThis.DOMException(
        "Failed to execute '" + op + "' on 'Document': Custom Element constructor should not use open(), close() or write().",
        'InvalidStateError');
    }
  }
  _write(html) {
    this._throwIfMarkupInsertionGuarded('write');
    if (html === '') return;
    // …from a script the live parse is running: into the input stream at the insertion point (html-tree-builder.js).
    if (globalThis.__csimWriteAtInsertionPoint && globalThis.__csimWriteAtInsertionPoint(this, html)) return;
    let body = this.body;
    if (!body) {
      // No <body> yet (e.g. write into an opened/empty doc) — build a skeleton.
      let de = documentElementOf(this);
      if (!de) { de = this._createElement(HTML_NS, null, 'html'); this._appendChild(de); }
      body = this._createElement(HTML_NS, null, 'body'); de._appendChild(body);
    }
    // The written markup is parsed and connected NOW — any custom element it
    // synchronously constructs runs with this document's markup-insertion
    // guard held ("create an element for a token" increments the counter).
    this._markupInsertionCounter = (this._markupInsertionCounter || 0) + 1;
    try {
      const nodes = parseFragment(html, body);
      // (A fragment parse marks its scripts already started — right for innerHTML, not for an opened document's parser,
      // whose scripts run as they are inserted.)
      // Only in the realm's own document: a DOMParser / createHTMLDocument document has no browsing context and runs
      // no script, opened or not (Chrome).
      if (this._scriptCreatedParser && this === globalThis.document) {
        for (const n of nodes) walk(n, (el) => { if (el._tag === 'script') el._csimRan = false; });
      }
      for (const n of nodes) body._appendChild(n);   // appendChild fires connect + CE upgrade
      // Convert declarative shadow roots in the appended subtrees — only when the
      // document has a browsing context, and only when the markup could contain one
      // (the cheap `/shadowrootmode/` gate keeps a no-DSD write off the walk, like
      // the streaming-parse path). A TOP-LEVEL `<template shadowrootmode>` becomes
      // the host = <body>, so convert it directly; otherwise scan its descendants.
      if (!this._noBrowsingContext && /shadowrootmode/i.test(html)) {
        for (const n of nodes) {
          if (n._nodeType !== NODE_ELEMENT) continue;
          if (n._tag === 'template' && n._ns === HTML_NS) {
            // parseFragment pins `_dsdOriginalParent` to the fragment context; after
            // append the real host is <body>, so clear it to convert against _parent.
            n._dsdOriginalParent = null;
            convertDeclarativeTemplate(n, null);
          } else {
            processDeclarativeShadowRoots(n);
          }
        }
      }
    } finally {
      this._markupInsertionCounter--;
    }
  }
  // open() resets the document for rewriting and returns it; we have no streaming
  // parser, so it just clears the body. NOT called implicitly by write() (see above).
  _open() {
    this._throwIfMarkupInsertionGuarded('open');
    if (globalThis.__csimParserScriptRunning && globalThis.__csimParserScriptRunning(this)) return this;
    const body = this.body;
    if (body) {
      for (const c of clearEdges(body)) unregisterSubtree(c);
      bumpStructureGen();   // direct child-list edit: move the structure generation too
      bumpSettleGen();
      // …and a focused or hovered element that went with the old content is neither any more, as a removal leaves it.
      if (this.__activeElement && !isConnected(this.__activeElement)) this._activeElement = null;
      if (this.__hoverElement && !isConnected(this.__hoverElement)) this._hoverElement = null;
    }
    // …and it has a SCRIPT-CREATED PARSER until `close()`: what `write` feeds it is parsed as the document's own markup,
    // so its scripts are parser-inserted and run (Chrome: an opened `about:blank` frame runs a written `<script>`).
    this._scriptCreatedParser = true;
    return this;
  }
  _close() {
    this._throwIfMarkupInsertionGuarded('close');
    this._scriptCreatedParser = false;
  }
  // `Document.importNode(node, options)` — a clone of `node` whose node document is
  // THIS document. Turbo Drive's `importStreamElements` does
  // `document.importNode(streamElement, true)` to graft turbo-stream fragments
  // (parsed in an inert DOMParser document) into the live tree.
  _importNode(node, options) {
    // (…a document or a shadow root is no node to import)
    if (node._nodeType === NODE_DOC || node._isShadowRoot) {
      throw new globalThis.DOMException(`Failed to execute 'importNode' on 'Document': The node provided is a ${node._isShadowRoot ? 'shadow root' : 'document'}, which may not be imported.`, 'NotSupportedError');
    }
    // `(boolean or ImportNodeOptions)`, converted: the legacy boolean says whether to clone deep (absent, false); an
    // ImportNodeOptions — null's too — clones deep unless `selfOnly`, and its `customElementRegistry`, where it gives
    // one, is the fallback registry ("use the importing document's" where it does not).
    const deep = typeof options === 'boolean' ? options : !options.selfOnly;
    const fallbackReg = typeof options === 'boolean' ? undefined : options.customElementRegistry;
    const out = node._cloneNode(deep, true);
    // Registry mapping (HTML "clone a node" with fallback registry = the option,
    // else the importing document's): a pinned SCOPED registry travels; a STICKY
    // null (customelementregistry attribute) stays null; a global-registry source
    // re-points to the importing document (the explicit option is IGNORED for
    // global sources); a NULL-resolving source (template contents, an inert
    // source document) takes the fallback. Nested template contents keep their
    // tracking-null — the fallback never reaches inside them.
    const dest       = this;
    const destWinReg = windowRegistryOf(dest);
    const srcDocNull = windowRegistryOf(node.ownerDocument) === null;
    const applyFallback = n => {
      if (fallbackReg !== undefined && fallbackReg !== destWinReg) n._ceRegistry = fallbackReg;
      else n._ceRegistry = undefined;   // track the importing document
    };
    const mapRegistry = n => {
      const r = n._ceRegistry;
      if (r === null || r === TRACKING_NULL || (r === undefined && srcDocNull)) applyFallback(n);
      else if (r && !isScopedRegistry(r)) n._ceRegistry = undefined;
      // scoped → keep; undefined from a live source → keep (tracks dest)
    };
    const importWalk = (n, shielded) => {
      n._ownerDoc = dest;
      if (!shielded && n._nodeType === NODE_ELEMENT) mapRegistry(n);
      const sr = n._shadowRoot;
      if (sr) {
        // A NULL-registry shadow root (shadowrootcustomelementregistry) keeps its
        // null and SHIELDS its contents from the fallback ("preserve null-ness");
        // any other root maps like an element.
        const srNull = sr._ceRegistry === null;
        if (!shielded && !srNull) mapRegistry(sr);
        importWalk(sr, shielded || srNull);
      }
      const ch = n._children;
      if (ch) for (const c of ch) importWalk(c, shielded);
    };
    importWalk(out, false);
    // Elements inert in `<template>.content` / a DOMParser doc aren't upgraded at
    // creation; upgrade them now iff this document has a browsing context — each
    // against ITS registry (ceUpgradeTree resolves per element), shadow trees
    // included.
    // ONE fused walk (upgrade + shadow descent), skipped outright when no
    // registry anywhere holds a definition — importNode is Turbo Streams'
    // hottest driver path (rule 3).
    if (hasAnyCEDefinitions()) {
      const upgradeWalk = n => {
        ceUpgradeTree(n);
        const visit = m => { if (m._shadowRoot) { upgradeWalk(m._shadowRoot); } };
        walkSubtree(n, visit);
      };
      upgradeWalk(out);
    }
    return out;
  }
  _adoptNode(node) {
    // DOM §4.5: adopting a document is not supported.
    if (node._nodeType === NODE_DOC) {
      throw new globalThis.DOMException("Failed to execute 'adoptNode' on 'Document': The node provided is of type '#document', which may not be adopted.", 'NotSupportedError');
    }
    // A shadow root cannot be adopted (it is owned by its host's tree).
    if (node._isShadowRoot) {
      throw new globalThis.DOMException("Failed to execute 'adoptNode' on 'Document': The node provided is a shadow root, which may not be adopted.", 'HierarchyRequestError');
    }
    // DOM "adopt": a DocumentFragment with a non-null HOST (template content —
    // the shadow-root case threw above) is returned unchanged; its tree stays
    // in its own document (adoption.window.js "adoptNode() and DocumentFragment
    // with host").
    if (node._nodeType === NODE_FRAGMENT && node._host) return node;
    if (node._parent) {
      try { node._parent._removeChild(node); } catch (_) {}
    }
    // (…an attribute is taken from its element first, as a node from its parent)
    if (node._nodeType === NODE_ATTRIBUTE && node._ownerElement) node._ownerElement._removeAttrKey(node._key);
    // Per HTML spec, adoptNode walks the subtree and reassigns
    // `ownerDocument` to the document on which the method was called.
    // Turbo Drive's `PageRenderer.activateNewBody()` calls
    // `document.adoptNode(this.newElement)` right before
    // `body.replaceWith(newElement)`, and FrameController.isActive
    // (= `this.element.ownerDocument === document && #connected`)
    // depends on it — without re-tagging, the new body's
    // `<turbo-frame>`s still report the DOMParser's parsed doc as
    // their owner, `isActive` stays false, and link-into-frame
    // clicks fall through to a full-page navigation.
    const dest = this;
    const oldDoc = node.ownerDocument;
    // DOM §adopt: for each inclusive descendant set its node document, and for an
    // element also set the node document of every attribute in its attribute list.
    // Attr nodes are cached per-element (`_attrNodes`) with a stable identity, so a
    // reference taken before the adopt must follow the element to `dest`.
    const crossDoc = docIdentity(oldDoc) !== docIdentity(dest);
    // Registry re-pointing keys on the WINDOW REGISTRY actually changing — a
    // same-browsing-context document swap (the frame's boot skeleton vs its
    // current document) is not a registry move, and must not strip a sticky
    // null or re-point a global association.
    const regChange = crossDoc && windowRegistryOf(oldDoc) !== windowRegistryOf(dest);
    // A cross-document adopt re-points a node's NON-SCOPED (global) registry to
    // the unset document-tracking state, so the node follows `dest`'s registry.
    // The unset state already tracks (an inert doc's element adopted into the
    // live document resolves global — the DOMParser→document upgrade path rides
    // this); an explicit null is STICKY (the customelementregistry attribute
    // survives clone AND adoption — element-mutation), as is a pinned scoped one.
    const destWinReg = windowRegistryOf(dest);
    const adoptRegistry = n => {
      const r = n._ceRegistry;
      // A stored NON-SCOPED pin re-points whenever it differs from the target's
      // window registry (an inert→inert adopt of an explicit-global pin → null);
      // the tracking state re-points only on a real registry change (regChange),
      // so a same-realm boot-skeleton doc swap can't strip it.
      if (r && !isScopedRegistry(r) && r !== destWinReg) { n._ceRegistry = undefined; return; }
      if (!regChange) return;
      if (r === TRACKING_NULL || (r && !isScopedRegistry(r))) n._ceRegistry = undefined;
      // …a shadow root's null the document's, unless it keeps it (a declarative shadowrootcustomelementregistry root's)
      else if (n._isShadowRoot) { if (r === null && !n._keepNullRegistry) n._ceRegistry = undefined; }
      // A null one (DOM "adopt"): the document's where the element is a root or a fragment's child, else its parent's —
      // already adopted, in tree order — so an element in a shadow root kept null stays null.
      else if (r === null) {
        const p = n._parent;
        const pr = !p || (p._nodeType === NODE_FRAGMENT && !p._isShadowRoot) ? undefined : p._ceRegistry;
        n._ceRegistry = pr === null || (pr && isScopedRegistry(pr)) ? pr : undefined;
      }
    };
    const adoptOne = n => {
      n._ownerDoc = dest;
      if (n._attrNodes) for (const k in n._attrNodes) n._attrNodes[k]._ownerDoc = dest;
      // An explicit adopt exits the template-contents "document" even when the
      // target is the same document object in our model.
      if (n._ceRegistry === TRACKING_NULL) n._ceRegistry = undefined;
      if (!crossDoc) return;
      adoptRegistry(n);
      if (n._tag === 'template' && n._templateContent) adoptTemplateContentInto(n._templateContent, dest, oldDoc);
      const sr = n._shadowRoot;
      if (sr) {
        // DOM "adopt" covers shadow-INCLUDING descendants: the shadow root and
        // its tree move documents (and re-point registries) with their host.
        walkSubtree(sr, adoptOne);
        // A cross-document adopt drops a shadow root's adopted stylesheets constructed in the
        // OLD document — they can't be used here (construct-stylesheets "adopting a shadow host
        // will empty adoptedStyleSheets").
        if (sr._adoptedStyleSheets) {
          const arr  = sr._adoptedStyleSheets;
          const keep = Array.prototype.filter.call(arr, (sheet) => slotsOf(sheet, 'CSSStyleSheet').constructorDocument === dest);
          if (keep.length !== arr.length) arr.splice(0, arr.length, ...keep);
        }
      }
    };
    walkSubtree(node, adoptOne);
    // (…and the live NodeIterators rooted in it, to the new document's registry: its removals are theirs now)
    const iterators = crossDoc && oldDoc && oldDoc._liveIterators;
    if (iterators && iterators.size) iterators.forEach(moveIterator, node, oldDoc, dest);
    // HTML "adopt": a cross-document adopt enqueues an `adoptedCallback(oldDoc, newDoc)`
    // reaction on every custom element in the moved subtree — the "adopted" step of a
    // cross-document move's disconnected → adopted → connected sequence, and of a bare
    // `document.adoptNode`. Same-document adopt is a no-op.
    if (crossDoc) {
      if (deferredAdoptions) deferredAdoptions.push(node, oldDoc, dest);
      else fireCEAdopted(node, oldDoc, dest);
    }
    return node;
  }
  // `document.execCommand(command, showUI, value)` — deprecated but
  // still in real browsers. Discourse's d-editor uses
  // `execCommand('insertText', false, str)` to insert upload
  // placeholders into the composer textarea while the upload is
  // running; without it, Uppy emits an `error` event and the upload
  // never completes. We implement only the commands the suite actually
  // exercises (`insertText`, `copy`); everything else is a tolerant
  // no-op returning false.
  _execCommand(command, value) {
    const cmd = asciiLower(command);
    const active = this._activeElement;
    if (cmd === 'copy') {
      // Selection-based copy works even without an activeElement, so this runs
      // before the `!active` gate below. copy is a read-only value slice, so it
      // tolerates any input (unlike cut / paste, which write selectionStart and
      // so need a selection-capable type).
      writeSelectionToClipboard(active, active && (active._tag === 'input' || active._tag === 'textarea'));
      return true;
    }
    if (!active) return false;
    // Text form controls (input / textarea) edit their VALUE around the selection
    // rather than the DOM: inserttext / cut / paste each splice the value and fire the
    // matching InputEvent, mirroring what Chrome does for a focused text control (the
    // contenteditable command dispatch below is for editing hosts only).
    const isTextControl = isSelectionTextControl(active);
    if (isTextControl && (cmd === 'inserttext' || cmd === 'cut' || cmd === 'paste')) {
      // execCommand is a SCRIPTED edit: splice the value and fire `input` with the
      // semantic inputType, but NOT the cancelable `beforeinput` the gesture path
      // fires (see performClipboardGesture). The value mutation is shared with that
      // path via spliceTextControlValue.
      const fireInput = (inputType, data) => {
        try {
          fireEvent(active, new InputEvent('input', {
            bubbles: true, cancelable: false, composed: true, data, inputType, dataTransfer: null
          }));
        } catch (_) {}
      };
      if (cmd === 'inserttext') {
        const s = value;
        spliceTextControlValue(active, s);
        fireInput('insertText', s);
      } else if (cmd === 'cut') {
        writeSelectionToClipboard(active, true);
        spliceTextControlValue(active, '');
        fireInput('deleteByCut', null);
      } else {   // paste
        // In a plain text control the insertFromPaste `input` event carries the
        // pasted text as `data` and a null dataTransfer (a rich contenteditable
        // reports null data + a DataTransfer instead — handled in the CE dispatch).
        const clip = globalThis.__csimClipboardGet ? (globalThis.__csimClipboardGet('text/plain') || '') : '';
        spliceTextControlValue(active, clip);
        fireInput('insertFromPaste', clip);
      }
      return true;
    }
    // contenteditable editing commands. execCommand is a SCRIPTED edit, not user
    // input: per input-events ("execCommand should only trigger input") it fires
    // `input` with the semantic inputType — but NOT the cancelable `beforeinput`.
    // Slice 1 = the insert family (text / line break / paragraph / horizontal rule);
    // the styling (bold/italic/…), list and color commands need the editing-styling
    // algorithm (exact nested DOM output) and are in-scope backlog.
    if (active._attrs.contenteditable != null && (active._attrs.contenteditable || '').toLowerCase() !== 'false') {
      const doc = globalThis.document;
      const str = value;
      const fireInput = (inputType, data) => {
        try { fireEvent(active, new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: data == null ? null : data, inputType })); } catch (_) {}
      };
      const insertNodeAtCaret = (node) => {
        const r = globalThis.__csimSelectionRange();
        if (r) {
          try {
            if (!r.collapsed) deleteRangeContents(r);   // replace a non-collapsed selection, like insertText
            r.insertNode(node);
            // Collapse the caret to AFTER the inserted node so sequential edits
            // accumulate — otherwise the range spans the node and the next
            // insertText's deleteRangeContents would clobber it.
            const parent = node._parent;
            const idx = parent && parent._children ? parent._children.indexOf(node) : -1;
            if (idx >= 0) globalThis.__csimGetSelection().collapse(parent, idx + 1);
          } catch (_) { active._appendChild(node); }
        } else active._appendChild(node);
      };
      // insertOrderedList / insertUnorderedList: wrap the block containing the
      // selection in <ol|ul><li>…</li></…>, and toggle an existing list's kind
      // (ol↔ul) when the caret already sits inside one. Matches the observable
      // Chrome/Firefox DOM for the common inline-content case; a full multi-block
      // list-editing algorithm is still backlog, but this is the shape editors
      // (Trix / ProseMirror) and the exec-command test exercise.
      // The selection's start node, clamped to the editing host — a selection outside
      // `active` falls back to `active` so the ancestor walks below can never escape
      // the host and mutate a block elsewhere.
      const hostAnchor = () => {
        const range = globalThis.__csimSelectionRange();
        const sc = range && range.startContainer;
        return (sc && (sc === active || nodeContains(active, sc))) ? sc : active;
      };
      // Nearest block-level ancestor of `node` within the host, or null when the
      // node's only block is the host itself (bare inline content).
      const blockAncestorInHost = (node) => {
        for (let n = node; n && n !== active; n = n._parent) {
          if (n._nodeType === NODE_ELEMENT && BLOCK_CONTAINER_TAGS.has(n._tag)) return n;
        }
        return null;
      };
      // The block-level element the selection sits in. An element-boundary start
      // (e.g. (host, 0) selecting the first child) descends into the child at the
      // offset first, so a selection that *contains* a block resolves to that block.
      const selectionBlock = () => {
        let node = hostAnchor();
        const range = globalThis.__csimSelectionRange();
        const off = range ? range.startOffset : 0;
        if (node._nodeType === NODE_ELEMENT && node._children.length) {
          node = node._children[Math.min(off, node._children.length - 1)] || node;
        }
        return blockAncestorInHost(node);
      };
      const applyList = (listTag, inputType) => {
        const sel = globalThis.__csimGetSelection();
        const anchor = hostAnchor();
        let li = null;
        for (let n = anchor; n && n !== active; n = n._parent) {
          if (n._nodeType === NODE_ELEMENT && n._tag === 'li' &&
              n._parent && (n._parent._tag === 'ol' || n._parent._tag === 'ul')) { li = n; break; }
        }
        if (li) {
          const list = li._parent;
          if (list._tag === listTag) {
            // Same kind → toggle the list off: lift each item's children out in
            // place, then drop the now-empty list.
            const parent = list._parent;
            for (const item of list._children.slice()) {
              while (item._children.length) parent._insertBefore(item._children[0], list);
            }
            parent._removeChild(list);
          } else {
            // ol ↔ ul → retag: DOM has no rename, so rebuild the list element and
            // move every item across, preserving order.
            const neu = doc.createElement(listTag);
            while (list._children.length) neu._appendChild(list._children[0]);
            list._parent._replaceChild(neu, list);
            if (sel) sel.collapse(neu._children[0] || neu, 0);
          }
        } else {
          // Not in a list → wrap the block holding the caret. With inline content
          // directly in the host (no block wrapper) the whole host becomes one item.
          const block = blockAncestorInHost(anchor) || active;
          const item = doc.createElement('li');
          const listEl = doc.createElement(listTag);
          listEl._appendChild(item);
          while (block._children.length) item._appendChild(block._children[0]);
          if (block === active) active._appendChild(listEl);
          else block._parent._replaceChild(listEl, block);
          if (sel) sel.collapse(item, item._children.length);
        }
        fireInput(inputType, null);
        return true;
      };
      // Inline styling (bold / italic / underline / strikeThrough / superscript /
      // subscript): wrap the selected text INNERMOST — descending into any existing
      // inline formatters — so repeated commands nest outside-in (<b><i><u>…</u></i></b>).
      // superscript/subscript are mutually exclusive: applying one strips the other.
      // Matches the Chrome/Firefox DOM for a whole-run selection; toggling a style
      // back OFF is the deeper editing-algorithm backlog.
      const collectStyleTargets = (range) => {
        const sc = range.startContainer, ec = range.endContainer;
        // A range within one text node → wrap exactly its selected slice.
        if (sc === ec && sc._nodeType === NODE_TEXT) {
          let node = sc;
          if (range.endOffset < (node.data || '').length) node.splitText(range.endOffset);
          if (range.startOffset > 0) node = node.splitText(range.startOffset);
          return [node];
        }
        // Element / multi-node range → gather the covered text nodes (recording each
        // covered slice), then split boundary nodes so only selected chars wrap.
        const hits = [];
        walkSubtree(range.commonAncestorContainer, (n) => {
          if (n._nodeType !== NODE_TEXT) return;
          const len = (n.data || '').length;
          if (!len) return;
          let a = 0, b = len;
          if (n === sc) a = range.startOffset;
          if (n === ec) b = range.endOffset;
          if (n !== sc && n !== ec) {
            const p0 = range.comparePoint(n, 0), p1 = range.comparePoint(n, len);
            if ((p0 < 0 && p1 <= 0) || (p0 >= 0 && p1 > 0)) return;   // wholly outside the range
          }
          if (a < b) hits.push({ n, a, b });
        });
        return hits.map(({ n, a, b }) => {
          let node = n;
          if (b < (node.data || '').length) node.splitText(b);
          if (a > 0) node = node.splitText(a);
          return node;
        });
      };
      // Wrap the selected run: for each covered text node, `makeWrapper()` produces a
      // fresh element the text is moved into (innermost, so chained commands nest);
      // `prepareTarget` gets a hook before wrapping (sup/sub exclusivity). A format
      // command fires `input` ONLY when it actually wraps something — a no-op / collapsed
      // selection dispatches nothing, matching Chrome.
      const wrapSelectionRun = (makeWrapper, inputType, data, prepareTarget) => {
        const sel = globalThis.__csimGetSelection();
        const range = globalThis.__csimSelectionRange();
        const targets = range && !range.collapsed ? collectStyleTargets(range) : [];
        const targetSet = new Set(targets);
        for (const t of targets) {
          if (prepareTarget) prepareTarget(t, targetSet);
          const wrapper = makeWrapper();
          t._parent._insertBefore(wrapper, t);
          wrapper._appendChild(t);
        }
        if (targets.length) {
          // Re-cover the wrapped run so a chained command nests one level deeper.
          if (sel && targets.length === 1) {
            const w = targets[0]._parent, wp = w._parent, wi = wp._children.indexOf(w);
            sel.setBaseAndExtent(wp, wi, wp, wi + 1);
          }
          fireInput(inputType, data);
        }
        return true;
      };
      const applyInlineStyle = (tag, inputType, exclusiveWith) =>
        wrapSelectionRun(() => doc.createElement(tag), inputType, null, !exclusiveWith ? null : (t, targetSet) => {
          // sup/sub exclusivity: strip a conflicting immediate wrapper first — but only
          // when it wraps EXACTLY the selected run. If it also covers unselected text,
          // stripping it wholesale would silently drop that text's formatting, so leave
          // it (the deeper slice-scoped unwrap is editing-algorithm backlog).
          if (t._parent && t._parent._tag === exclusiveWith && t._parent !== active) {
            const conflict = t._parent;
            let onlySelected = true;
            walkSubtree(conflict, (d) => {
              if (d._nodeType === NODE_TEXT && (d.data || '').length && !targetSet.has(d)) onlySelected = false;
            });
            if (onlySelected) {
              const cp = conflict._parent;
              while (conflict._children.length) cp._insertBefore(conflict._children[0], conflict);
              cp._removeChild(conflict);
            }
          }
        });
      // Color / font-name commands: wrap the run in a <span> carrying the inline style
      // and fire `input` with the format*Color / formatFontName inputType. The `data`
      // is the CSS-normalized color (culori-canonical rgb()/rgba(), currentcolor +
      // CSS-wide keywords lowercased, an unparseable value passed through) — the exact
      // string Chrome reports; the applied DOM isn't spec-fixed, so a plain styled span
      // is enough and keeps the color actually applied for real editors.
      const applyValueStyle = (styleProp, styleValue, inputType, data) =>
        wrapSelectionRun(() => {
          const span = doc.createElement('span');
          if (styleValue != null) { try { inlineStyleOf(span)[styleProp] = styleValue; } catch (_) {} }
          return span;
        }, inputType, data, null);
      // Justify commands set `text-align` on the block holding the selection, wrapping
      // bare inline host content in a <div> first (matching Chrome's block form).
      const applyJustify = (align, inputType) => {
        let block = selectionBlock();
        if (!block || block === active) {
          const div = doc.createElement('div');
          while (active._children.length) div._appendChild(active._children[0]);
          active._appendChild(div);
          globalThis.__csimGetSelection().collapse(div, 0);
          block = div;
        }
        inlineStyleOf(block).textAlign = align;
        fireInput(inputType, null);
        return true;
      };
      // removeFormat clears the inline style of the block holding the selection
      // (Chrome's "remove the style of current block"). Unwrapping inline formatting
      // elements across the range is the fuller algorithm — editing backlog.
      const applyRemoveFormat = () => {
        const block = selectionBlock();
        if (block && block !== active) block._setAttribute('style', '');
        fireInput('formatRemove', null);
        return true;
      };
      // indent wraps the block in a <blockquote>; outdent unwraps the nearest
      // blockquote at/above the block — so an indent/outdent pair round-trips to the
      // original tree. (Chrome's margin/blockquote nesting details aren't spec-fixed.)
      const applyIndent = () => {
        const block = selectionBlock();
        const target = block && block !== active ? block : null;
        const bq = doc.createElement('blockquote');
        if (target) { target._parent._insertBefore(bq, target); bq._appendChild(target); }
        else { while (active._children.length) bq._appendChild(active._children[0]); active._appendChild(bq); }
        fireInput('formatIndent', null);
        return true;
      };
      const applyOutdent = () => {
        let bq = null;
        for (let n = selectionBlock(); n && n !== active; n = n._parent) {
          if (n._nodeType === NODE_ELEMENT && n._tag === 'blockquote') { bq = n; break; }
        }
        if (bq) {
          const p = bq._parent;
          while (bq._children.length) p._insertBefore(bq._children[0], bq);
          p._removeChild(bq);
        }
        fireInput('formatOutdent', null);
        return true;
      };
      // createLink wraps the selected run (partial text nodes split via
      // collectStyleTargets) in an <a> with the href passed through verbatim — no URL
      // resolution, matching Chrome. `data` is that same raw href.
      const applyCreateLink = (href) =>
        wrapSelectionRun(() => {
          const a = doc.createElement('a');
          a._setAttribute('href', href);
          return a;
        }, 'insertLink', href, null);
      // unlink removes every <a> the selection touches — descendants within the range
      // and any <a> ancestor of it — lifting their children in place. inputType is the
      // empty string (Chrome reports no semantic inputType for unlink).
      const applyUnlink = () => {
        const range = globalThis.__csimSelectionRange();
        if (range) {
          const common = range.commonAncestorContainer;
          const root = common && common._nodeType === NODE_TEXT ? common._parent : common;
          const anchors = [];
          if (root) walkSubtree(root, (n) => {
            if (n._nodeType === NODE_ELEMENT && n._tag === 'a' && range.intersectsNode(n)) anchors.push(n);
          });
          for (let n = range.startContainer; n && n !== active; n = n._parent) {
            if (n._nodeType === NODE_ELEMENT && n._tag === 'a' && !anchors.includes(n)) anchors.push(n);
          }
          for (const a of anchors) {
            const p = a._parent;
            while (a._children.length) p._insertBefore(a._children[0], a);
            p._removeChild(a);
          }
        }
        fireInput('', null);
        return true;
      };
      switch (cmd) {
        case 'inserttext':
          globalThis.__csimInsertTextAtSelection(str); fireInput('insertText', str); return true;
        case 'insertlinebreak':
          insertNodeAtCaret(doc.createElement('br')); fireInput('insertLineBreak', null); return true;
        case 'insertparagraph': {
          const p = doc.createElement('div'); p._appendChild(doc.createElement('br'));
          insertNodeAtCaret(p); fireInput('insertParagraph', null); return true;
        }
        case 'inserthorizontalrule':
          insertNodeAtCaret(doc.createElement('hr')); fireInput('insertHorizontalRule', null); return true;
        case 'insertorderedlist':
          return applyList('ol', 'insertOrderedList');
        case 'insertunorderedlist':
          return applyList('ul', 'insertUnorderedList');
        case 'bold':          return applyInlineStyle('b',      'formatBold');
        case 'italic':        return applyInlineStyle('i',      'formatItalic');
        case 'underline':     return applyInlineStyle('u',      'formatUnderline');
        case 'strikethrough': return applyInlineStyle('strike', 'formatStrikeThrough');
        case 'superscript':   return applyInlineStyle('sup',    'formatSuperscript', 'sub');
        case 'subscript':     return applyInlineStyle('sub',    'formatSubscript',   'sup');
        case 'forecolor':     return applyValueStyle('color',           str, 'formatFontColor', normalizeExecColor(value));
        case 'backcolor':
        case 'hilitecolor':   return applyValueStyle('backgroundColor', str, 'formatBackColor', normalizeExecColor(value));
        case 'fontname':      return applyValueStyle('fontFamily',      str, 'formatFontName',  str);
        case 'justifycenter': return applyJustify('center',  'formatJustifyCenter');
        case 'justifyfull':   return applyJustify('justify', 'formatJustifyFull');
        case 'justifyright':  return applyJustify('right',   'formatJustifyRight');
        case 'justifyleft':   return applyJustify('left',    'formatJustifyLeft');
        case 'removeformat':  return applyRemoveFormat();
        case 'indent':        return applyIndent();
        case 'outdent':       return applyOutdent();
        case 'createlink':    return applyCreateLink(str);
        case 'unlink':        return applyUnlink();
        case 'cut': {
          // Copy the selection to the clipboard (text/plain + text/html), delete
          // it, and fire deleteByCut.
          const range = globalThis.__csimSelectionRange();
          writeSelectionToClipboard(active, false);
          if (range && !range.collapsed) deleteRangeContents(range);
          fireInput('deleteByCut', null);
          return true;
        }
        case 'paste': {
          // Insert the clipboard text at the caret and fire insertFromPaste. The event's
          // dataTransfer is a READ-ONLY DataTransfer carrying the pasted flavors — getData
          // reads them back; setData / clearData are no-ops (an input event's dataTransfer
          // is read-only), which the exec-command test asserts.
          const text = globalThis.__csimClipboardGet ? (globalThis.__csimClipboardGet('text/plain') || '') : '';
          const html = globalThis.__csimClipboardGet ? (globalThis.__csimClipboardGet('text/html')  || '') : '';
          const dt   = buildReadOnlyPasteDataTransfer(text, html);
          globalThis.__csimInsertTextAtSelection(text);
          try {
            fireEvent(active, new InputEvent('input', {
              bubbles: true, cancelable: false, composed: true, data: null, inputType: 'insertFromPaste', dataTransfer: dt
            }));
          } catch (_) {}
          return true;
        }
      }
      return false;   // remaining execCommand surface: editing-engine backlog
    }
    if (cmd === 'inserthtml' &&
        (active._tag === 'textarea' || (active._tag === 'input' && /^(text|search|email|url|tel|password)?$/i.test(active._attrs.type || '')))) {
      // Into a plain input / textarea, InsertHTML inserts the markup's TEXT content
      // (tags stripped), truncated to fit the `maxlength` attribute in UTF-16 code
      // units — so a multi-code-unit emoji is cut mid-grapheme (input-maxlength-emoji).
      const tmp = globalThis.document.createElement('div');
      tmp._innerHTML = value;
      let str = String(tmp.textContent || '');
      const cur = String(controlLiveValue(active));
      const ss  = (active.selectionStart == null ? cur.length : active.selectionStart);
      const se  = (active.selectionEnd   == null ? cur.length : active.selectionEnd);
      const maxlen = parseInt(active._attrs.maxlength, 10);
      if (maxlen >= 0) {
        let room = Math.max(0, maxlen - (cur.length - (se - ss)));
        if (str.length > room) {
          // Truncate to `room` UTF-16 code units, but never split a surrogate pair —
          // a lone leading surrogate at the boundary is dropped (input-maxlength-emoji).
          const c = room > 0 ? str.charCodeAt(room - 1) : 0;
          if (c >= 0xD800 && c <= 0xDBFF) room -= 1;
          str = str.slice(0, room);
        }
      }
      setControlLiveValue(active, cur.slice(0, ss) + str + cur.slice(se));
      active.selectionStart = active.selectionEnd = ss + str.length;
      try { fireEvent(active, new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: str, inputType: 'insertFromPaste' })); } catch (_) {}
      return true;
    }
    return false;
  }
}
// XMLDocument (DOM §4.5.1), generated from its IDL — the document `document.implementation.createDocument` returns
// (and a clone of one), made by the platform alone. It has no browsing context (so `location` is null) and is
// XML-typed (the `_contentType` its maker sets makes isHtmlDocument false → case-sensitive element/attribute handling,
// per spec). Its brand is its own flag: a document is a node, no slotted object.
registerInterface('XMLDocument', (o) => isNodeObject(o) && o._xmlDocument === true);
class XMLDocument extends Document {
  constructor(token) {
    constructedBy(PLATFORM, token, 'XMLDocument');
    super();
    this._xmlDocument = true;
  }
}
installXMLDocument(XMLDocument, {});
export const newXMLDocument = () => new XMLDocument(PLATFORM);
globalThis.XMLDocument = XMLDocument;

// The window of a document with a browsing context — the main document's the global, a frame's its own
// (`_defaultView`); none for one without (`new Document()`, createHTMLDocument, a DOMParser's: returning the global
// spliced the live window into a detached document's event path), nor for one whose frame was removed.
function defaultViewOf(doc) {
  if (doc._noBrowsingContext) return null;
  const win = doc._defaultView || globalThis;
  return win.__csimBrowsingContextDiscarded === true ? null : win;
}
// A frame's document, or a DOMParser's, carries its own URL (`_url`); the live top-level document has none and is
// at its window's location, so a pushState is tracked.
function documentURL(doc) {
  return doc._url || (globalThis.location && globalThis.location.href) || '';
}
// The legacy presentational colours: the body's attributes, reflected ([LegacyNullToEmptyString]).
function bodyColor(attr) {
  return [
    (doc) => { const b = bodyOf(doc); return b && b._attrs[attr] != null ? String(b._attrs[attr]) : ''; },
    (doc, value) => { const b = bodyOf(doc); if (b) b._setAttribute(attr, value); }
  ];
}
const [get_fgColor, set_fgColor] = bodyColor('text'), [get_bgColor, set_bgColor] = bodyColor('bgcolor'),
      [get_linkColor, set_linkColor] = bodyColor('link'), [get_vlinkColor, set_vlinkColor] = bodyColor('vlink'),
      [get_alinkColor, set_alinkColor] = bodyColor('alink');
const EXEC_COMMANDS = new Set(['inserttext', 'inserthtml', 'copy']);
const characterSetOf = (doc) => doc._encoding || 'UTF-8';
// A live collection of the document's, one per document (`document.embeds === document.embeds`): its HTML elements a
// filter takes (collections.rs) — an element of another namespace that shares a local name is none of them.
const documentCollection = (key, kind) => (doc) => doc[key] || (doc[key] = liveHTMLCollection(() => collectBy(doc, kind)));
const get_embeds = documentCollection('_collEmbeds', BY_EMBEDS);

// Document's members (generated/bindings.js): the class's steps where it keeps them (`_createElement`, `_write`,
// `_open`, `_importNode`, `_adoptNode`, `_execCommand`), ParentNode's shared with the other node kinds, and the rest here.
// `location` is [LegacyUnforgeable]: each document's own, defined by its constructor.
// (…the realm's own document answered first: it is the Proxy `makeDocProxy` makes, every read through which costs)
registerInterface('Document', (o) => (o != null && o === globalThis.document) || (isNodeObject(o) && o._nodeType === NODE_DOC));
const defineDocumentUnforgeables = installDocument(Document, {
  // ── DOM
  get_implementation: (doc) => doc._implementation || (doc._implementation = new DOMImplementation(PLATFORM, doc)),
  get_URL: documentURL,
  get_documentURI: documentURL,
  get_compatMode: (doc) => (doc._quirks ? 'BackCompat' : 'CSS1Compat'),
  // (…what its bytes were decoded as, natively — `__dom.decodeDocument` — and UTF-8 for a document made of a string:
  // DOMParser's, `srcdoc`, the initial about:blank, createHTMLDocument's; `charset` and `inputEncoding` legacy aliases)
  get_characterSet: characterSetOf,
  get_charset: characterSetOf,
  get_inputEncoding: characterSetOf,
  get_contentType: (doc) => doc._contentType || 'text/html',
  get_doctype(doc) {
    for (const c of doc._children) if (c._nodeType === NODE_DOCTYPE) return c;
    return null;
  },
  get_documentElement: documentElementOf,
  // (…whether the document is HTML — which lowercases the search for its HTML elements — bound as the live list is
  // made, so a later change of it does not change the list)
  getElementsByTagName(doc, qualifiedName) {
    const htmlDoc = isHtmlDocument(doc);
    return liveHTMLCollection(() => collectByTagName(doc, qualifiedName, htmlDoc));
  },
  getElementsByTagNameNS: (doc, namespace, localName) => liveHTMLCollection(() => collectByTagNameNS(doc, namespace, localName)),
  getElementsByClassName: (doc, classNames) => liveHTMLCollection(() => collectByClassName(doc, classNames)),
  // createElement: the name validated, then ASCII-lowercased in an HTML document only (an XML one keeps its case), never
  // split at a prefix; HTML's namespace in an HTML or XHTML document, none in an XML one. Its options a string (a
  // legacy form, which says nothing) or an ElementCreationOptions — `is`, a customized built-in's name (an internal
  // slot, not an `is` attribute), and the registry to look the definition up in.
  createElement(doc, localName, options) {
    if (!isValidElementLocalName(localName)) {
      throw new globalThis.DOMException(`Failed to execute 'createElement' on 'Document': The tag name provided ('${localName}') is not a valid name.`, 'InvalidCharacterError');
    }
    const html = isHtmlDocument(doc);
    const ns = html || doc._contentType === 'application/xhtml+xml' ? HTML_NS : null;
    const { is = null, customElementRegistry } = typeof options === 'object' ? options : {};
    return doc._createElement(ns, null, html ? asciiLower(localName) : localName, customElementRegistry, is);
  },
  createElementNS(doc, namespace, qualifiedName, options) {
    const { namespace: ns, prefix, localName } = validateAndExtract(namespace, qualifiedName);
    const { is = null, customElementRegistry } = typeof options === 'object' ? options : {};
    return doc._createElement(ns, prefix, localName, customElementRegistry, is);
  },
  createDocumentFragment(doc) {
    const f = new DocumentFragment();
    f._ownerDoc = doc;
    return f;
  },
  createTextNode(doc, data) {
    const t = new Text(data);
    t._ownerDoc = doc;
    return t;
  },
  // (…an XML document's only, its data no CDATA section's end)
  createCDATASection(doc, data) {
    if (isHtmlDocument(doc)) throw new globalThis.DOMException('This operation is not supported for HTML documents.', 'NotSupportedError');
    if (data.includes(']]>')) throw new globalThis.DOMException('String contains an invalid character.', 'InvalidCharacterError');
    const c = new CDATASection(PLATFORM, data);
    c._ownerDoc = doc;
    return c;
  },
  createComment(doc, data) {
    const c = new Comment(data);
    c._ownerDoc = doc;
    return c;
  },
  // (…its target an XML Name, its data no instruction's end)
  createProcessingInstruction(doc, target, data) {
    checkProcessingInstruction("Failed to execute 'createProcessingInstruction' on 'Document': ", target, data);
    return new ProcessingInstruction(PLATFORM, target, data, doc);
  },
  importNode: (doc, node, options) => doc._importNode(node, options),
  adoptNode: (doc, node) => doc._adoptNode(node),
  // (…a detached Attr: its name a Name, ASCII-lowercased in an HTML document)
  createAttribute(doc, localName) {
    if (!isValidAttributeLocalName(localName)) {
      throw new globalThis.DOMException("'" + localName + "' is not a valid attribute name.", 'InvalidCharacterError');
    }
    return new Attr(PLATFORM, isHtmlDocument(doc) ? asciiLower(localName) : localName, null, null, '', doc);
  },
  createAttributeNS(doc, namespace, qualifiedName) {
    const { namespace: ns, prefix, localName } = validateAndExtract(namespace, qualifiedName, 'attribute');
    return new Attr(PLATFORM, localName, ns, prefix, '', doc);
  },
  // createEvent (DOM §4.5): a legacy interface name — ASCII-lowercased, "UİEvent" no "uievent" — to an event of the
  // interface it names, its initialized flag unset (dispatching it before an init*Event is an InvalidStateError).
  createEvent(doc, interfaceName) {
    const Interface = CREATE_EVENT_INTERFACES[asciiLower(interfaceName)];
    if (!Interface) throw new globalThis.DOMException(`Failed to execute 'createEvent' on 'Document': The provided event type ('${interfaceName}') is invalid.`, 'NotSupportedError');
    // (…the interface itself, not a global a page may have replaced; TextEvent's and BeforeUnloadEvent's, which have no
    // constructor, their own)
    const ev = Interface === TextEvent ? createTextEvent() : Interface === BeforeUnloadEvent ? createBeforeUnloadEvent() : new Interface('');
    ev._initialized = false;
    return ev;
  },
  createRange: (doc) => newRange(doc),
  // A NodeIterator (DOM §6.1) — DOMPurify walks its sanitising fragment with one — and a TreeWalker (§6.2): the
  // engine's traversals (traversal.rs), which call back into `accept` for each node `whatToShow` shows.
  createNodeIterator: (doc, root, whatToShow, filter) => NodeIteratorBinding.create(root, whatToShow, filter),
  createTreeWalker: (doc, root, whatToShow, filter) => TreeWalkerBinding.create(root, whatToShow, filter),
  getElementById: (doc, elementId) => findById(documentElementOf(doc), elementId),
  get_children: childrenOf,
  get_firstElementChild: firstElementChildOf,
  get_lastElementChild: lastElementChildOf,
  get_childElementCount: childElementCountOf,
  prepend: parentNodePrepend,
  append: parentNodeAppend,
  replaceChildren: parentNodeReplaceChildren,
  moveBefore: parentNodeMoveBefore,
  querySelector: (doc, selectors) => selectFirst(doc, selectors),
  querySelectorAll: (doc, selectors) => nodeList(selectAll(doc, selectors)),
  createExpression: (doc, expression, resolver) => xpathEvaluatorBase.createExpression(expression, resolver),
  createNSResolver: (doc, nodeResolver) => nodeResolver,
  evaluate: (doc, expression, contextNode, resolver, type) => xpathEvaluatorBase.evaluate(expression, contextNode, resolver, type),
  // (…the live document's registry the global one, an inert document's none, until a scoped registry's
  // `initialize()` associates one)
  get_customElementRegistry: documentRegistry,

  // ── HTML
  // `location` — the window's, for a document that has one, else null; set, it navigates that window (a frame's
  // document its frame, not the top page).
  get_location: (doc) => (defaultViewOf(doc) === null ? null : globalThis.location),
  // (…stored so a write round-trips; the host by default)
  get_domain(doc) {
    if (doc._domain != null) return doc._domain;
    return defaultViewOf(doc) === null ? '' : (globalThis.location && globalThis.location.hostname) || '';
  },
  set_domain(doc, value) { doc._domain = value; },
  // (…the page that led here — a link's, a form's — and none for an address-bar visit: Discourse's /login sets its
  // `destination_url` by it)
  get_referrer: () => (typeof globalThis.__getDocumentReferrer === 'function' ? globalThis.__getDocumentReferrer() || '' : ''),
  // (…the jar the host keeps — which survives a realm rebuild — and none for a document without a browsing context;
  // a set-cookie-string with a control character leaves the jar as it is)
  get_cookie: (doc) => (doc._noBrowsingContext ? '' : globalThis.__getDocumentCookie() || ''),
  set_cookie(doc, value) {
    if (doc._noBrowsingContext || /[\u0000-\u001f\u007f]/.test(value)) return;
    globalThis.__setDocumentCookie(value);
  },
  // (…MM/DD/YYYY HH:MM:SS, local time: the response's Last-Modified, `_lastModified`, else now)
  get_lastModified(doc) {
    const d = doc._lastModified != null ? new Date(doc._lastModified) : new Date();
    const p = (n) => ('0' + n).slice(-2);
    return p(d.getMonth() + 1) + '/' + p(d.getDate()) + '/' + d.getFullYear() + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  },
  get_readyState: (doc) => doc._readyState,
  // (…an SVG root's first `title` child, else the first HTML `title` in tree order: its text, whitespace stripped and
  // collapsed)
  get_title(doc) {
    const docEl = documentElementOf(doc);
    if (!docEl) return '';
    const title = isSvgRootEl(docEl) ? firstSvgTitleChild(docEl) : firstHtmlTitleInTreeOrder(docEl);
    if (!title) return '';
    return childTextContent(title).replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
  },
  // (…that title's text set — one made where there is none: an SVG root's first child, an HTML document's head's last,
  // and with neither a title nor a head, nothing done)
  set_title(doc, value) {
    const docEl = documentElementOf(doc);
    if (!docEl) return;
    let title;
    if (isSvgRootEl(docEl)) {
      title = firstSvgTitleChild(docEl);
      if (!title) docEl._insertBefore(title = doc._createElement(SVG_NS, null, 'title'), docEl._children[0] || null);
    } else if (docEl._ns === HTML_NS) {
      title = firstHtmlTitleInTreeOrder(docEl);
      if (!title) {
        const head = headOf(doc);
        if (!head) return;
        head._appendChild(title = doc._createElement(HTML_NS, null, 'title'));
      }
    } else {
      return;
    }
    title._textContent = value;
  },
  get_dir(doc) {
    const de = documentElementOf(doc);
    return de ? enumReflectGet(de._attrs.dir, ENUM_DIR, '', '') : '';
  },
  set_dir(doc, value) {
    const de = documentElementOf(doc);
    if (de) de._setAttribute('dir', value);
  },
  get_body: bodyOf,
  // (…a `body` or `frameset` — anything else a HierarchyRequestError — in place of the one there, else appended to the
  // document element, which must be)
  set_body(doc, value) {
    if (!(value && value._ns === HTML_NS && (value._localName === 'body' || value._localName === 'frameset'))) {
      throw new globalThis.DOMException(
        "Failed to set the 'body' property on 'Document': The new body element is of type '" + (value ? value._nodeName : 'null') +
        "'. It must be either a 'BODY' or 'FRAMESET' element.", 'HierarchyRequestError');
    }
    const current = bodyOf(doc);
    if (current === value) return;
    if (current) { current._parent._replaceChild(value, current); return; }
    const docEl = documentElementOf(doc);
    if (!docEl) throw new globalThis.DOMException("Failed to set the 'body' property on 'Document': No document element exists.", 'HierarchyRequestError');
    docEl._appendChild(value);
  },
  get_head: headOf,
  get_images: documentCollection('_collImages', BY_IMAGES),
  get_embeds,
  get_plugins: get_embeds,
  get_links: documentCollection('_collLinks', BY_LINKS),
  get_forms: documentCollection('_collForms', BY_FORMS),
  get_scripts: documentCollection('_collScripts', BY_SCRIPTS),
  get_anchors: documentCollection('_collAnchors', BY_ANCHORS),
  get_applets: (doc) => doc._collApplets || (doc._collApplets = liveHTMLCollection(() => [])),
  // (…a LIVE NodeList, HTML §3.1.5, of the HTML elements whose `name` is the name, in tree order — the document element
  // among them — re-walked when the tree changes: a move into a shadow tree, a reorder, moveBefore-name-map)
  getElementsByName: (doc, elementName) => liveNodeList(() => collectBy(doc, BY_NAME, elementName)),
  // (…the `<script>` running, set around `__csim_runScript`: bundlers derive their public path from its `src`)
  get_currentScript: (doc) => doc._currentScript || null,
  // open(): the document emptied for rewriting; open(url, name, features), the window's open steps — on its window,
  // which a document with none lacks.
  open_unused1_unused2: (doc) => doc._open(),
  open_url_name_features(doc, url, name, features) {
    const win = defaultViewOf(doc);
    if (!win) throw new globalThis.DOMException("Failed to execute 'open' on 'Document': The document has no window associated.", 'InvalidStateError');
    return win.open(url, name, features);
  },
  close: (doc) => doc._close(),
  write(doc, text) { doc._write(text.join('')); },
  writeln(doc, text) { doc._write(text.join('') + '\n'); },
  get_defaultView: defaultViewOf,
  // (…no window manager: a document with a browsing context is focused and visible, one without hidden — Chrome)
  hasFocus: (doc) => defaultViewOf(doc) !== null,
  get_visibilityState: (doc) => (defaultViewOf(doc) === null ? 'hidden' : 'visible'),
  get_hidden: (doc) => defaultViewOf(doc) === null,
  // designMode: 'on' or 'off', set ASCII case-insensitively — any other value ignored.
  get_designMode: (doc) => doc._designMode || 'off',
  set_designMode(doc, value) {
    const mode = asciiLower(value);
    if (mode === 'on' || mode === 'off') doc._designMode = mode;
  },
  execCommand: (doc, commandId, showUI, value) => doc._execCommand(commandId, value),
  // (…the commands `execCommand` runs: inserting text or markup, copying; their state, value and indeterminacy the
  // inert defaults)
  queryCommandSupported: (doc, commandId) => EXEC_COMMANDS.has(asciiLower(commandId)),
  queryCommandEnabled: (doc, commandId) => EXEC_COMMANDS.has(asciiLower(commandId)),
  queryCommandState: () => false,
  queryCommandIndeterm: () => false,
  queryCommandValue: () => '',
  get_fgColor,
  set_fgColor,
  get_linkColor,
  set_linkColor,
  get_vlinkColor,
  set_vlinkColor,
  get_alinkColor,
  set_alinkColor,
  get_bgColor,
  set_bgColor,
  // (…the Netscape event model's, which do nothing)
  clear() {},
  captureEvents() {},
  releaseEvents() {},
  // The focused element (`_activeElement`), retargeted out of every shadow tree (the outermost host in the document:
  // `shadowRoot.activeElement` exposes the inner one) — only on a page that has a shadow host, so the common read is
  // O(1); one removed from the tree is focused no more (a ProseMirror NodeView rebuilt, a closed popup), and with none
  // the body (Chrome).
  get_activeElement(doc) {
    const ae = doc._activeElement;
    if (!ae || !isConnected(ae)) return bodyOf(doc);
    if (!globalThis.__csimShadowHostCount) return ae;
    let node = ae;
    for (let root = enclosingShadowRoot(node); root; root = enclosingShadowRoot(node)) node = root._host;
    return node;
  },
  get_styleSheets: styleSheetListOf,
  // `adoptedStyleSheets` — the constructed sheets adopted (Lit and Stencil push `new CSSStyleSheet()`s): only the
  // active document's feed its cascade.
  get_adoptedStyleSheets(doc) {
    return doc._adoptedStyleSheets || (doc._adoptedStyleSheets = makeAdoptedStyleSheetsArray(doc, () => {
      if (doc === globalThis.document) scheduleCascadeRefresh();
    }));
  },
  set_adoptedStyleSheets: setAdoptedStyleSheets,
  // ── CSSOM View: hit-testing through the layout (`elementFromPoint` the topmost box under the point — ProseMirror's
  // `posAtCoords` resolves a click by it), and the viewport's scroll root: the root element in standards mode, the body
  // in quirks mode unless it scrolls itself (CSSOM View §scrollingElement; Chrome: then none)
  elementFromPoint: (doc, x, y) => elementFromPointIn(doc, x, y),
  elementsFromPoint: (doc, x, y) => elementsFromPointIn(doc, x, y),
  get_scrollingElement(doc) {
    if (!doc._quirks) return documentElementOf(doc);
    const body = bodyOf(doc);
    return body && !scrollsInAnyAxis(body) ? body : null;
  },
  // ── The rest: Fonts (one FontFaceSet a document, always ready: fonts load on demand), Web Animations (the
  // document's animations, in composite order, and the driver's clock as its timeline), the Selection API's (its own,
  // where it has a browsing context), and what there is none of here — fullscreen, Picture-in-Picture, pointer lock — or nothing to ask —
  // the Storage Access API's, every access granted
  get_fonts: (doc) => doc._fontFaceSet || (doc._fontFaceSet = globalThis.__csimNewFontFaceSet(doc)),
  getAnimations: (doc) => animationsForRoot(doc),
  get_timeline: () => documentTimeline,
  getSelection: (doc) => globalThis.__csimGetSelection(doc),
  get_fullscreenElement: () => null,
  exitFullscreen: () => resolvedPromise(),
  get_pictureInPictureElement: () => null,
  exitPictureInPicture: () => resolvedPromise(),
  get_pointerLockElement: () => null,
  exitPointerLock() {},
  hasStorageAccess: () => resolvedPromise(true),
  requestStorageAccess: () => resolvedPromise(),
  hasUnpartitionedCookieAccess: () => resolvedPromise(true),
  // (…GlobalEventHandlers' and Document's own: IDL attributes only — no content attribute is one of a document's)
  installEventHandlers(proto, names, isSelf) { installEventHandlerAttrs(proto, names, null, isSelf); }
});

// The document named-properties exotic (see DOC_NAMED_PROPS above). It is
// spliced ONCE into the shared Document.prototype chain, between
// Document.prototype and its parent (Node.prototype), wrapping that parent: so a
// document's chain becomes  document → Document.prototype → DocumentNamedProps →
// Node.prototype → …  The traps forward every real Node member to the wrapped
// parent first and only fall through to the named lookup for an otherwise-
// unresolved string. Splicing below Document.prototype (rather than as the
// instance's own prototype) keeps `Object.getPrototypeOf(document) ===
// Document.prototype` intact, and only Document instances carry Document.prototype
// in their chain, so element reads never reach these traps. Document-level
// members (defined on Document.prototype) resolve before the proxy and never pay
// the trap cost.
//
// The proxy's target is a fresh empty object whose own prototype is the wrapped
// parent (Node.prototype). A Proxy is NOT its target, so `getPrototypeOf(proxy)`
// returns `getPrototypeOf(target)`: an empty shim (rather than wrapping
// Node.prototype directly) keeps the real Node.prototype IN the chain after the
// proxy, so `document instanceof Node` and Node-member resolution are unchanged.
const __docNamedTarget = Object.create(Object.getPrototypeOf(Document.prototype));
const DocumentNamedProps = new Proxy(__docNamedTarget, {
  get(target, prop, receiver) {
    // Gate on the O(1) Set FIRST: the overwhelmingly common case is an
    // unresolved read whose name was never a supported document name, so a
    // missed `DOC_NAMED_PROPS.has` skips the proto-chain `Reflect.has` walk
    // entirely (rule 3). Registered names still defer to a real member.
    if (typeof prop === 'string' && DOC_NAMED_PROPS.has(prop) && !Reflect.has(target, prop)) {
      const v = documentNamedLookup(receiver, prop);
      if (v !== undefined) return v;
    }
    return Reflect.get(target, prop, receiver);
  },
  has(target, prop) {
    if (Reflect.has(target, prop)) return true;
    // The has trap has no receiver; resolve `'x' in document` against the main
    // page document (the dominant — and tested — case).
    return typeof prop === 'string' && documentNamedLookup(globalThis.document, prop) !== undefined;
  }
});
Object.setPrototypeOf(Document.prototype, DocumentNamedProps);

// The driver's actual page document: an HTML document (text/html →
// case-insensitive tag / attribute handling) WITH a browsing context (location
// = the global window, URL via globalThis.location), starting in readyState
// 'loading' so library IIFEs that sniff `document.readyState` register a
// DOMContentLoaded listener instead of self-scheduling onto the virtual clock.
// These reset the spec-empty `new Document()` defaults (application/xml, no
// browsing context, 'complete').
//
// `withSkeleton` builds an html/head/body tree: the boot document needs it (the
// snapshot must present a valid `documentElement` — jQuery 3.x's feature
// detection captures it at IIFE-evaluation time and dereferences it later, e.g.
// `T.createElement('fieldset')` inside a `$.support` probe — and the per-visit
// graft reuses the live head/body identity). The HTML parser passes `false`: it
// builds its own html/head/body from the parsed source.
function createHtmlPageDocument(withSkeleton) {
  const doc = new Document();
  doc._contentType       = undefined;   // → isHtmlDocument() true (text/html)
  doc._url               = undefined;    // URL resolves via globalThis.location
  doc._noBrowsingContext = false;
  // THIS realm's global registry rides the document, so a cross-realm registry
  // resolution (windowRegistryOf) lands on the right object. Inert consumers
  // (DOMParser) flip _noBrowsingContext after construction, which windowRegistryOf
  // checks first — the stamp is then unread.
  doc._ceDefaultRegistry = globalCERegistry;
  doc._readyState         = 'loading';
  // The canonical document is a thin Proxy (named-property ENUMERATION exotic —
  // see makeDocProxy). It is returned everywhere a document is handed out, so
  // node identity (`node.ownerDocument === document`) propagates: methods called
  // on the proxy keep it as the receiver, and the skeleton's parent pointer below
  // is the proxy too.
  const proxy = makeDocProxy(doc);
  if (withSkeleton) {
    const html = createElementNode('html');
    const head = createElementNode('head');
    const body = createElementNode('body');
    appendEdge(proxy, html);   // documentElement derives from this
    appendEdge(html, head);
    appendEdge(html, body);
  }
  return proxy;
}

// Live ranges (DOM §5.5): their boundary points are the engine's (ranges.rs), every live range of the isolate's, wherever
// its tree — a range a script dropped goes with its object. The DOM's mutations run their steps on them there: an edge
// written runs the insert and remove steps (tree.js), and these hand over a character-data change and a split, whichever
// realm's code made it (the engine's steps return at once with no range).
export const RANGE_START = 0, RANGE_END = 1, RANGE_BOTH = 2;
// A range's start, end or both is (`node`, `offset`).
export function setRangePoint(range, which, node, offset) {
  globalThis.__dom.rangeSet(range, which, node, boundaryNid(node), offset);
  rangeMoved(range);
}
// …and where the range is the selection's, the selection changed with it: a selectionchange (Selection API: "the
// associated range's boundary point is mutated either by the user or the content script").
function rangeMoved(range) {
  if (range === globalThis.__csimSelectionRange?.()) globalThis.__csimScheduleSelectionChange(globalThis.document);
}
// `node`'s slot, as a boundary point names it: an Attr — no tree's — gets one the first time it is a boundary.
// Where a replacement goes into `parent` before `ref` (none: at the end), its node removed — or the NotFoundError where
// `ref` has left it (the removal's steps — a frame's unload — took the child that followed, as Chrome throws then).
function insertionAfterRemoval(parent, ref) {
  if (ref === null) return -1;
  if (ref._parent !== parent) return new globalThis.DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
  return childIndexOf(parent, ref);
}
// …the replacement refused there: its removal stands, recorded and its disconnections run, and the error thrown.
function refusedAfterRemoval(parent, old, prevSib, nextSib, adoptions, wasConnected, error) {
  recordChildList(parent, [], [old], prevSib, nextSib);
  fireAdoptions(adoptions);
  if (wasConnected) fireCEDisconnect(old);
  throw error;
}
// Options taken out of a select by "replace all" — an optgroup emptied, a select's options under it — run its selectedness
// algorithm once, as a removal of one does (`askForResetAfterRemoval`); a `<select>` itself is finalized by its caller.
function askForResetAfterReplaceAll(removed, parent) {
  if (removed.length === 0 || parent._tag === 'select') return;
  askForResetAfterRemoval(removed.find((c) => c._tag === 'option' || c._tag === 'optgroup') || removed[0], parent);
}
export function boundaryNid(node) {
  if (node._nid == null || node._nid < 0) registerNativeNode(node);
  return node._nid;
}
// "replace data" steps: `count` code units at `offset` in `node` were replaced by `dataLen` units.
function liveRangesOnReplaceData(node, offset, count, dataLen) {
  globalThis.__dom.rangesReplaceData(node._nid, offset, count, dataLen);
}
// "split" steps: `node` was split at `offset`; the tail moved to `newNode` (now at `nodeIndex + 1` in `parent`).
function liveRangesOnSplit(node, offset, newNode, parent, nodeIndex) {
  globalThis.__dom.rangesSplit(node._nid, offset, newNode, newNode._nid, parent ? parent._nid : -1, nodeIndex + 1);
}
// A node's parent in its node tree — none for a shadow root, whose `_parent` is its host.
function treeParent(node) {
  return node._isShadowRoot ? null : node._parent;
}
// Same-node-tree containment: like `contains` but does NOT cross a shadow
// boundary (a range inside a shadow tree is in its own node tree, so removing
// the light-tree host must not disturb it).
function sameTreeContains(ancestor, descendant) {
  for (let n = descendant; n; n = n._parent) {
    if (n === ancestor) return true;
    if (n._isShadowRoot) return false;   // stop at the shadow boundary
  }
  return false;
}
// Live NodeIterators (DOM §6.1). Registered at creation so `removeChild` can run
// the "NodeIterator pre-removing steps" — keeping `referenceNode` valid as the
// tree mutates. The registry hangs off the root's DOCUMENT, which every realm's
// code mutating it reaches (a module-level one was the realm's own, unseen by a
// frame's code removing a node); an adopt carries an iterator over to the new
// document with its root. Gated on an empty set so removeChild stays cheap.
function liveIteratorsOf(doc) {
  return doc._liveIterators || (doc._liveIterators = new WeakRegistry());
}
// NodeIterator and TreeWalker (DOM §6.1-2): their bindings generated from their IDL, the traversals each member runs
// the engine's (traversal.rs), which calls back into the filter for each node `whatToShow` shows. A traverser's state,
// in its slots: the root, `whatToShow`, the filter and its active flag, and where it is — a NodeIterator's reference
// and whether it is before it (moved by the pre-removing steps as the tree mutates; `working`, where a traversal is
// while the filter runs on a node, moved with it), a TreeWalker's current node. The live iterators registered are
// their slots.
const NodeFilterBinding = defineNodeFilter();
globalThis.NodeFilter = NodeFilterBinding.interface;
const NodeIteratorBinding = defineNodeIterator({
  init(it, root, whatToShow, filter) {
    Object.assign(it, { root, whatToShow, filter, active: false, node: root, before: true, working: null });
    liveIteratorsOf(root._nodeType === NODE_DOC ? root : root.ownerDocument).add(it);
  },
  get_root(it) { return it.root; },
  get_referenceNode(it) { return it.node; },
  get_pointerBeforeReferenceNode(it) { return it.before; },
  get_whatToShow(it) { return it.whatToShow; },
  get_filter(it) { return it.filter; },
  nextNode(it) { return nodeIteratorTraverse(it, true); },
  previousNode(it) { return nodeIteratorTraverse(it, false); },
  detach() {}
});
globalThis.NodeIterator = NodeIteratorBinding.interface;
const TreeWalkerBinding = defineTreeWalker({
  init(tw, root, whatToShow, filter) {
    Object.assign(tw, { root, whatToShow, filter, active: false, current: root });
  },
  get_root(tw) { return tw.root; },
  get_whatToShow(tw) { return tw.whatToShow; },
  get_filter(tw) { return tw.filter; },
  get_currentNode(tw) { return tw.current; },
  set_currentNode(tw, node) { tw.current = node; },
  parentNode(tw) { return treeWalkerTraverse(tw, TRAVERSE_PARENT_NODE, 'parentNode'); },
  firstChild(tw) { return treeWalkerTraverse(tw, TRAVERSE_FIRST_CHILD, 'firstChild'); },
  lastChild(tw) { return treeWalkerTraverse(tw, TRAVERSE_LAST_CHILD, 'lastChild'); },
  previousSibling(tw) { return treeWalkerTraverse(tw, TRAVERSE_PREVIOUS_SIBLING, 'previousSibling'); },
  nextSibling(tw) { return treeWalkerTraverse(tw, TRAVERSE_NEXT_SIBLING, 'nextSibling'); },
  previousNode(tw) { return treeWalkerTraverse(tw, TRAVERSE_PREVIOUS_NODE, 'previousNode'); },
  nextNode(tw) { return treeWalkerTraverse(tw, TRAVERSE_NEXT_NODE, 'nextNode'); }
});
globalThis.TreeWalker = TreeWalkerBinding.interface;
// The traversals the engine runs (traversal.rs `traverse`), by number: a TreeWalker's, and a NodeIterator's.
const TRAVERSE_PARENT_NODE = 0, TRAVERSE_FIRST_CHILD = 1, TRAVERSE_LAST_CHILD = 2, TRAVERSE_NEXT_SIBLING = 3,
      TRAVERSE_PREVIOUS_SIBLING = 4, TRAVERSE_NEXT_NODE = 5, TRAVERSE_PREVIOUS_NODE = 6, ITERATE_NEXT = 7,
      ITERATE_PREVIOUS = 8;
// Where the engine says a traversal is (traversal.rs `answer_value`): a status — 0 for nowhere, else 1, or 2 where a
// NodeIterator is before the node — and the steps to the node, in one number (the status, then base-5 digits under a
// leading 1) or, for many, an array.
function traversalStatus(answer) {
  return typeof answer === 'number' ? answer % 3 : answer[0];
}
// …the node the steps reach from `node`: 0 to the parent, 1 to the first child, 2 to the last child, 3 to the next
// sibling, 4 to the previous sibling.
function takeSteps(node, answer) {
  if (typeof answer !== 'number') {
    for (let i = 1; i < answer.length; i++) node = takeStep(node, answer[i]);
    return node;
  }
  for (let code = (answer - answer % 3) / 3; code > 1;) {
    const step = code % 5;
    code = (code - step) / 5;
    node = takeStep(node, step);
  }
  return node;
}
function takeStep(node, step) {
  switch (step) {
    case 0: return treeParent(node);
    case 1: return node._children[0];
    case 2: return node._children[node._children.length - 1];
    case 3: return node._parent._children[siblingIndexOf(node._parent, node) + 1];
    default: return node._parent._children[siblingIndexOf(node._parent, node) - 1];
  }
}
// A TreeWalker's traversal `kind` (`member`, by name) from its current node: the node it finds — the walker's current
// node then — or null.
function treeWalkerTraverse(tw, kind, member) {
  let at = tw.current;
  const filter = tw.filter && ((steps) => {
    at = takeSteps(at, steps);
    const was = tw.current;
    const result = filterNode(tw, at, member, 'TreeWalker');
    // (…a filter that sets the walker's current node: the traversal reads it as it goes on)
    if (tw.current !== was) globalThis.__dom.traverseCurrent(boundaryNid(tw.current));
    return result;
  });
  const answer = globalThis.__dom.traverse(kind, boundaryNid(tw.root), boundaryNid(tw.current), tw.whatToShow, filter, false);
  if (traversalStatus(answer) === 0) return null;
  return tw.current = takeSteps(at, answer);
}
// DOM NodeIterator "traverse" (forward = nextNode, else previousNode): the node the filter accepts, the iterator's
// reference moving to it — or to where a removal while the filter ran moved it (as Chrome and Firefox do: the spec has
// the reference land on the removed node).
function nodeIteratorTraverse(it, forward) {
  let at = it.node, found = null;
  const filter = it.filter && ((steps) => {
    found = at = takeSteps(at, steps);
    // (…a traversal the filter starts — refused, as the filter is running — has a working pointer of its own)
    const outer = it.working, w = it.working = { node: at, before: !forward };
    try {
      return filterNode(it, at, forward ? 'nextNode' : 'previousNode', 'NodeIterator');
    } finally {
      it.working = outer;
      if (w.node !== at) globalThis.__dom.traverseFrom(boundaryNid(at = w.node), w.before);
    }
  });
  const answer = globalThis.__dom.traverse(forward ? ITERATE_NEXT : ITERATE_PREVIOUS, boundaryNid(it.root), boundaryNid(it.node), it.whatToShow, filter, it.before);
  const status = traversalStatus(answer);
  if (status === 0) return null;
  it.node = takeSteps(at, answer);
  it.before = status === 2;
  return it.filter ? found : it.node;
}
// DOM "filter" (§6): the traverser's filter's answer for a node its `whatToShow` shows — FILTER_ACCEPT (1), FILTER_REJECT
// (2, its subtree as well) or FILTER_SKIP (3). Its active flag refuses a filter that traverses it again (thrown before
// the flag is set, so not made an error of the filter's realm); a filter whose browsing context is gone (its iframe
// removed) is no longer runnable (HTML "invoke a callback function"); what the filter throws is of the filter's realm,
// as the operation runs with its [[Realm]] current.
function filterNode(traverser, node, member, iface) {
  if (!globalThis.__csimCallbackRunnable(traverser.filter)) {
    throw new TypeError(`Failed to execute '${member}' on '${iface}': The provided callback is no longer runnable.`);
  }
  if (traverser.active) {
    throw new globalThis.DOMException(`Failed to execute '${member}' on '${iface}': The filter is already active.`, 'InvalidStateError');
  }
  traverser.active = true;
  try {
    return NodeFilterBinding.acceptNode(traverser.filter, node);
  } catch (e) {
    throw globalThis.__csimRealmizeCallbackError(traverser.filter, e);
  } finally {
    traverser.active = false;
  }
}
// DOM "NodeIterator pre-removing steps": run BEFORE `toBeRemoved` leaves the tree
// so the iterator's reference doesn't strand on a detached node — by every removal (tree.js).
function liveIteratorsOver(node) {
  const doc = node._nodeType === NODE_DOC ? node : node.ownerDocument;
  const reg = doc && doc._liveIterators;
  return reg && reg.size > 0 ? reg : null;
}
setIteratorSteps({ preRemove: nodeIteratorPreRemove, preRemoveAll: nodeIteratorPreRemoveAll });
function nodeIteratorPreRemove(toBeRemoved) {
  const reg = liveIteratorsOver(toBeRemoved);
  if (reg) reg.forEach(iteratorPreRemove, toBeRemoved);
}
// …for the removal of every child of `parent`, one after another.
function nodeIteratorPreRemoveAll(parent) {
  const reg = liveIteratorsOver(parent);
  if (reg) reg.forEach(iteratorPreRemoveAll, parent);
}
function moveIterator(it, node, oldDoc, dest) {
  if (!sameTreeContains(node, it.root)) return;
  oldDoc._liveIterators.delete(it);
  liveIteratorsOf(dest).add(it);
}
function iteratorPreRemove(it, toBeRemoved) {
  movePointerOnRemoval(it, it.root, toBeRemoved);
  if (it.working) movePointerOnRemoval(it.working, it.root, toBeRemoved);
}
function iteratorPreRemoveAll(it, parent) {
  movePointerOnRemovalAll(it, it.root, parent);
  if (it.working) movePointerOnRemovalAll(it.working, it.root, parent);
}
function movePointerOnRemovalAll(pointer, root, parent) {
  const answer = globalThis.__dom.iteratorPreRemoveAll(parent._nid, boundaryNid(root), boundaryNid(pointer.node), pointer.before);
  if (answer === null) return;
  pointer.node = takeSteps(parent, answer);
  pointer.before = traversalStatus(answer) === 2;
}
// The pre-removing steps (traversal.rs) of one of a NodeIterator's pointers — `{node, before}`.
function movePointerOnRemoval(pointer, root, toBeRemoved) {
  // (…a removed leaf moves only a pointer at itself)
  if (pointer.node !== toBeRemoved && !(toBeRemoved._children && toBeRemoved._children.length)) return;
  const answer = globalThis.__dom.iteratorPreRemove(toBeRemoved._nid, boundaryNid(root), boundaryNid(pointer.node), pointer.before);
  if (answer === null) return;
  pointer.node = takeSteps(toBeRemoved, answer);
  pointer.before = traversalStatus(answer) === 2;
}
// The "length of a node" (DOM §4.4): a DocumentType is 0, a CharacterData node
// is its data length, any other node is its child count.
export function nodeLength(node) {
  const t = node._nodeType;
  if (t === NODE_DOCTYPE) return 0;
  if (t === NODE_TEXT || t === NODE_CDATA || t === NODE_COMMENT || t === NODE_PI) {
    return (node.data || '').length;
  }
  return node._children ? node._children.length : 0;
}
// "Set the start/end of a range" (DOM §4.5): the boundary node + offset validated (a doctype has no boundary point, an
// offset past the node's length none in it), then the boundary set, the *other* boundary collapsed onto it where the new
// one would cross it or land in another tree.
function setRangeBoundary(range, node, offset, which) {
  checkRangePoint(which === 'start' ? 'setStart' : 'setEnd', node, offset);
  // (…and the other point with it where it would be in another tree, or on the wrong side: ranges.rs)
  globalThis.__dom.rangeSetPoint(range, which === 'start' ? RANGE_START : RANGE_END, node, boundaryNid(node), offset);
  rangeMoved(range);
}
// AbstractRange, Range and StaticRange (DOM §5.3-5.5), generated from their IDL. A Range's object is the engine's: made
// by `__dom.RangeBase` (ranges.rs), a wrapper of a handle holding its boundary points' containers, for the class being
// constructed — as a node's is by NodeBase — which exists from a realm on, not in the snapshot, where a range no realm's
// page ever sees is a plain object. A StaticRange's points are its own state, set as it is made and never moved.
class AbstractRange {
  constructor() {
    if (new.target === AbstractRange) throw new TypeError("Failed to construct 'AbstractRange': Illegal constructor");
  }
}
// (…the engine's range or a static one, whose points are its slots')
const staticRangeOf = (o) => slotsOf(o, 'StaticRange');
registerInterface('AbstractRange', (o) => IS_RANGE(o) || IS_STATIC_RANGE(o));
installAbstractRange(AbstractRange, {
  get_startContainer: (range) => staticRangeOf(range)?.startContainer ?? globalThis.__dom.rangeContainer(range, RANGE_START),
  get_startOffset: (range) => staticRangeOf(range)?.startOffset ?? globalThis.__dom.rangeOffset(range, RANGE_START),
  get_endContainer: (range) => staticRangeOf(range)?.endContainer ?? globalThis.__dom.rangeContainer(range, RANGE_END),
  get_endOffset: (range) => staticRangeOf(range)?.endOffset ?? globalThis.__dom.rangeOffset(range, RANGE_END),
  get_collapsed(range) {
    const s = staticRangeOf(range);
    return s ? s.startContainer === s.endContainer && s.startOffset === s.endOffset : globalThis.__dom.rangeCollapsed(range);
  }
});

// A Range is collapsed at (the relevant document, 0) as it is made — `new Range()`'s global's document, or the one
// `createRange()` was asked of (`newRange`).
export class Range extends AbstractRange {
  constructor(token, doc) {
    const base = globalThis.__dom && globalThis.__dom.RangeBase;
    const self = base ? Reflect.construct(base, [], new.target) : Object.create(new.target.prototype);
    setRangePoint(self, RANGE_BOTH, token === PLATFORM ? doc : globalThis.document, 0);
    return self;
  }
}
export function newRange(doc) { return new Range(PLATFORM, doc || globalThis.document); }
// (…any realm's, which the engine knows by its handle; in the snapshot, this realm's alone)
const IS_RANGE = (o) => { const d = globalThis.__dom; return d ? d.isRange(o) : o instanceof Range; };
registerInterface('Range', IS_RANGE);
// "Set the start/end before/after a node": the boundary (node's parent, node's index [+1]) — a parentless node has no
// valid boundary, an InvalidNodeTypeError.
function boundaryRelativeToNode(range, node, which, after) {
  const fn = (which === 'start' ? 'setStart' : 'setEnd') + (after ? 'After' : 'Before');
  const parent = treeParent(node);
  if (!parent) {
    throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the node has no parent.`, 'InvalidNodeTypeError');
  }
  setRangeBoundary(range, parent, childIndexOf(parent, node) + (after ? 1 : 0), which);
}
// (…a point's node a doctype, or its offset past the node's length, an error of `member`'s)
function checkRangePoint(member, node, offset) {
  if (node._nodeType === NODE_DOCTYPE) {
    throw new globalThis.DOMException(`Failed to execute '${member}' on 'Range': the node is a doctype.`, 'InvalidNodeTypeError');
  }
  if (offset > nodeLength(node)) {
    throw new globalThis.DOMException(`Failed to execute '${member}' on 'Range': the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
  }
}
installRange(Range, {
  // (…the engine's nid of it: one of the start container's inclusive ancestors)
  get_commonAncestorContainer(range) {
    const nid = globalThis.__dom.rangeCommonAncestor(range);
    const start = globalThis.__dom.rangeContainer(range, RANGE_START);
    let n = start;
    while (n && n._nid !== nid) n = n._parent;
    return n || start;
  },
  setStart: (range, node, offset) => setRangeBoundary(range, node, offset, 'start'),
  setEnd: (range, node, offset) => setRangeBoundary(range, node, offset, 'end'),
  setStartBefore: (range, node) => boundaryRelativeToNode(range, node, 'start', false),
  setStartAfter: (range, node) => boundaryRelativeToNode(range, node, 'start', true),
  setEndBefore: (range, node) => boundaryRelativeToNode(range, node, 'end', false),
  setEndAfter: (range, node) => boundaryRelativeToNode(range, node, 'end', true),
  collapse(range, toStart) {
    const from = toStart ? RANGE_START : RANGE_END;
    setRangePoint(range, toStart ? RANGE_END : RANGE_START, globalThis.__dom.rangeContainer(range, from), globalThis.__dom.rangeOffset(range, from));
  },
  // (…`node` within its parent: (parent, index) to (parent, index + 1); a parentless node an InvalidNodeTypeError)
  selectNode(range, node) {
    const parent = treeParent(node);
    if (!parent) {
      throw new globalThis.DOMException("Failed to execute 'selectNode' on 'Range': the node has no parent.", 'InvalidNodeTypeError');
    }
    const index = childIndexOf(parent, node);
    setRangePoint(range, RANGE_START, parent, index);
    setRangePoint(range, RANGE_END, parent, index + 1);
  },
  // (…the whole of `node`: (node, 0) to (node, length); a doctype has no contents to select)
  selectNodeContents(range, node) {
    if (node._nodeType === NODE_DOCTYPE) {
      throw new globalThis.DOMException("Failed to execute 'selectNodeContents' on 'Range': the node is a doctype.", 'InvalidNodeTypeError');
    }
    setRangePoint(range, RANGE_START, node, 0);
    setRangePoint(range, RANGE_END, node, nodeLength(node));
  },
  // (…`how` one of the four constants, else a NotSupportedError; ranges of two trees a WrongDocumentError)
  compareBoundaryPoints(range, how, other) {
    if (how > 3) {
      throw new globalThis.DOMException("Failed to execute 'compareBoundaryPoints' on 'Range': the comparison method must be 0, 1, 2 or 3.", 'NotSupportedError');
    }
    const order = globalThis.__dom.rangeCompareBoundaries(range, how, other);
    if (order === null) throw new globalThis.DOMException('The two Ranges are not in the same tree.', 'WrongDocumentError');
    return order;
  },
  deleteContents: (range) => deleteRangeContents(range),
  extractContents: (range) => extractRangeContents(range),
  cloneContents: (range) => cloneRangeContents(range),
  insertNode: (range, node) => insertNodeInRange(range, node),
  // (…the contents extracted, wrapped in `newParent`, put where they were, and selected — no non-Text node partially
  // selected, no Document, DocumentType or DocumentFragment the parent)
  surroundContents(range, newParent) {
    const partialNonText = globalThis.__dom.rangeContents(...rangeBounds(range))[6];
    if (partialNonText) {
      throw new globalThis.DOMException("Failed to execute 'surroundContents' on 'Range': the range partially selects a non-Text node.", 'InvalidStateError');
    }
    const nt = newParent._nodeType;
    if (nt === NODE_DOC || nt === NODE_DOCTYPE || nt === NODE_FRAGMENT) {
      throw new globalThis.DOMException("Failed to execute 'surroundContents' on 'Range': the new parent is a Document, DocumentType, or DocumentFragment node.", 'InvalidNodeTypeError');
    }
    const fragment = extractRangeContents(range);
    if (newParent._children) for (const c of newParent._children.slice()) newParent._removeChild(c);
    insertNodeInRange(range, newParent);
    newParent._appendChild(fragment);
    const parent = treeParent(newParent), index = childIndexOf(parent, newParent);
    setRangePoint(range, RANGE_START, parent, index);
    setRangePoint(range, RANGE_END, parent, index + 1);
  },
  cloneRange(range) {
    const d = globalThis.__dom, start = d.rangeContainer(range, RANGE_START);
    const r = newRange(start._nodeType === NODE_DOC ? start : start.ownerDocument);
    setRangePoint(r, RANGE_START, start, d.rangeOffset(range, RANGE_START));
    setRangePoint(r, RANGE_END, d.rangeContainer(range, RANGE_END), d.rangeOffset(range, RANGE_END));
    return r;
  },
  // (…a no-op in today's DOM)
  detach() {},
  // (…a point in another tree false, not an error, as comparePoint's is)
  isPointInRange(range, node, offset) {
    const where = globalThis.__dom.rangeComparePoint(range, boundaryNid(node), offset);
    if (where === null) return false;
    checkRangePoint('isPointInRange', node, offset);
    return where === 0;
  },
  comparePoint(range, node, offset) {
    const where = globalThis.__dom.rangeComparePoint(range, boundaryNid(node), offset);
    if (where === null) throw new globalThis.DOMException('The node provided is in a different tree than this Range.', 'WrongDocumentError');
    checkRangePoint('comparePoint', node, offset);
    return where;
  },
  intersectsNode: (range, node) => rangeIntersectsNode(range, node),
  // (…the text of the Text nodes it contains, the boundary ones sliced by their offsets: ranges.rs `rangeText`)
  stringify: (range) => globalThis.__dom.rangeText(range),
  // (…no geometry of a range yet: the rects of the fragments it covers are a layout read to come)
  getClientRects: () => rectList([]),
  getBoundingClientRect: () => new globalThis.DOMRect(0, 0, 0, 0),
  createContextualFragment: (range, html) => createContextualFragment(range, html)
});
// The range's boundary points as the engine's queries take them: (start nid, offset, end nid, offset).
function rangeBounds(range) {
  const d = globalThis.__dom;
  return [boundaryNid(d.rangeContainer(range, RANGE_START)), d.rangeOffset(range, RANGE_START),
          boundaryNid(d.rangeContainer(range, RANGE_END)), d.rangeOffset(range, RANGE_END)];
}
// `createContextualFragment(html)`: `html` parsed as a fragment in the context of the range's start node — an element,
// else none, which our body-context parse is — owned by its document, its scripts unmarked as already started (they run
// once the fragment is inserted, unlike innerHTML's).
function createContextualFragment(range, html) {
  const node = globalThis.__dom.rangeContainer(range, RANGE_START);
  const doc  = (node._nodeType === NODE_DOC ? node : node.ownerDocument) || globalThis.document;
  const frag = doc.createDocumentFragment();
  const ctx  = node._nodeType === NODE_ELEMENT ? node : null;
  for (const c of parseFragment(html, ctx)) frag._appendChild(c);
  // (…owned by the start node's document: parseFragment and createDocumentFragment fall back to the main one, so a
  // range in a createHTMLDocument / DOMParser document would hand back nodes of another)
  doc._adoptNode(frag);
  // A context INSIDE template content parses its fragment in the template-contents "document": the tracking sentinel
  // re-stamped (the hops above re-pointed it) — the start container may be the template content fragment itself.
  if ((ctx || node)._ceRegistry === TRACKING_NULL) {
    walkSubtree(frag, n => { if (n._nodeType === NODE_ELEMENT && n._ceRegistry === undefined) n._ceRegistry = TRACKING_NULL; });
  } else {
    // Reactions drain at the API boundary: parsed custom elements upgrade against their registry.
    ceUpgradeTree(frag);
  }
  walkSubtree(frag, n => { if (n._tag === 'script') n._csimRan = false; });
  return frag;
}
// `insertNode(node)`: `node` inserted at the range's start — a Text start node split at the offset, the node put
// before its second half; an element's, at child index `startOffset` — and a collapsed range's end after it.
function insertNodeInRange(range, node) {
  const sc = globalThis.__dom.rangeContainer(range, RANGE_START), so = globalThis.__dom.rangeOffset(range, RANGE_START);
  // (…a Text start node, for insertNode's purposes, a Text or CDATASection node: both split at the offset)
  const startIsText = sc._nodeType === NODE_TEXT || sc._nodeType === NODE_CDATA;
  // HierarchyRequestError: a PI/Comment start node, a parentless Text start node, or inserting an inclusive ancestor of
  // the start node.
  if (sc._nodeType === NODE_PI || sc._nodeType === NODE_COMMENT ||
      (startIsText && !sc._parent) || node === sc || nodeContains(node, sc)) {
    throw new globalThis.DOMException("Failed to execute 'insertNode' on 'Range': the node may not be inserted here.", 'HierarchyRequestError');
  }
  let referenceNode = startIsText ? sc : (sc._children ? (sc._children[so] || null) : null);
  const parent = referenceNode == null ? sc : referenceNode._parent;
  // (…the insertion validated BEFORE mutating, so an invalid node — a Document — throws without first splitting)
  ensurePreInsertionValidity(node, parent, referenceNode);
  if (startIsText) referenceNode = sc.splitText(so);
  if (node === referenceNode) referenceNode = node.nextSibling;
  if (node._parent) node._parent._removeChild(node);
  let newOffset = referenceNode == null ? nodeLength(parent) : parent._children.indexOf(referenceNode);
  newOffset += node._nodeType === NODE_FRAGMENT ? nodeLength(node) : 1;
  parent._insertBefore(node, referenceNode);
  if (globalThis.__dom.rangeCollapsed(range)) setRangePoint(range, RANGE_END, parent, newOffset);
}

// A StaticRange: its points as its init gives them — any offsets, checked against nothing — a DocumentType or Attr no
// container. Consumed by input-events libraries through getTargetRanges().
export class StaticRange extends AbstractRange {
  constructor(init) {
    [init] = convertStaticRangeArguments(arguments);
    super();
    const sc = init.startContainer, ec = init.endContainer;
    if (sc._nodeType === NODE_DOCTYPE || sc._nodeType === NODE_ATTRIBUTE || ec._nodeType === NODE_DOCTYPE || ec._nodeType === NODE_ATTRIBUTE) {
      throw new globalThis.DOMException("Failed to construct 'StaticRange': a DocumentType or Attr node may not be a container.", 'InvalidNodeTypeError');
    }
    makeSlots(this, 'StaticRange', {
      startContainer: sc,
      startOffset:    init.startOffset,
      endContainer:   ec,
      endOffset:      init.endOffset
    });
  }
}
const IS_STATIC_RANGE = (o) => staticRangeOf(o) !== undefined;
registerInterface('StaticRange', IS_STATIC_RANGE);
installStaticRange(StaticRange, {});
globalThis.AbstractRange = AbstractRange;
globalThis.Range         = Range;
globalThis.StaticRange   = StaticRange;

// Helper: is `descendant` either equal to or contained in `ancestor`?
export function nodeContains(ancestor, descendant) {
  return ancestor != null && ancestor._contains ? ancestor._contains(descendant) : false;
}
// Tags whose IDL exposes `.form` to point at the owning HTMLFormElement.
const FORM_ASSOCIATED_TAGS = new Set([
  'input', 'select', 'textarea', 'button', 'fieldset', 'object', 'output'
]);
// True if `range` overlaps with `node` (the node is partially or
// fully covered by the range). The DOM-spec algorithm is "node and
// range share at least one boundary point or one is inside the
// other"; we implement a conservative subset that handles the
// single-Text-node and within-an-element cases the partial-quote
// tests use.
// Position of boundary point (nodeA, offsetA) relative to (nodeB, offsetB): -1 before, 0 equal, +1 after (DOM §5.2
// "the position of a boundary point relative to another"; ranges.rs) — both in one tree.
export function compareBoundaryPoint(nodeA, offsetA, nodeB, offsetB) {
  return globalThis.__dom.comparePoints(boundaryNid(nodeA), offsetA, boundaryNid(nodeB), offsetB);
}
export function rangeIntersectsNode(range, node) {
  return globalThis.__dom.rangeIntersectsNode(range, boundaryNid(node));
}
function __csimInsertTextAtSelection(text) {
  let range = globalThis.__csimSelectionRange();
  if (!range) return false;
  let sc = range.startContainer;
  // The previous keystroke's commit-handler (Tagify on `,`, Trix on
  // <Enter>, etc.) may have detached the text node our cursor was
  // pointing at. Re-anchor to the active contenteditable when the
  // current container is no longer attached — without this the
  // subsequent chars splice into a phantom node that's no longer
  // in the DOM and the editor never sees the rest of the typing.
  if (sc && !isConnected(sc)) {
    const doc = globalThis.document;
    const active = doc && doc.activeElement;
    if (active && active._nodeType === NODE_ELEMENT && isContenteditable(active)) {
      // Walk into the deepest non-void leaf, position at end.
      const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link']);
      let leaf = active;
      while (leaf._children && leaf._children.length > 0) {
        const next = leaf._children.find(c =>
          c._nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
        );
        if (!next) break;
        leaf = next;
      }
      globalThis.__csimGetSelection().collapse(leaf, leaf._children ? leaf._children.length : 0);
      range = globalThis.__csimSelectionRange();
      sc = range.startContainer;
    } else {
      return false;
    }
  }
  if (!range.collapsed) deleteRangeContents(range);

  const so = range.startOffset | 0;
  if (!sc) return false;

  // Case 1: cursor is inside a Text node → splice the chars in.
  if (sc._nodeType === NODE_TEXT) {
    const before = sc._data.slice(0, so);
    const after  = sc._data.slice(so);
    sc.data = before + text + after;
    setRangePoint(range, RANGE_BOTH, sc, so + text.length);
    return true;
  }

  // Case 2: cursor is in an element. Try to extend a neighbour text
  // node (real browsers prefer this — they keep contiguous runs in
  // one text node); only create a new node when neither neighbour
  // is text.
  const children = sc._children || [];
  const prevNode = children[so - 1];
  const atNode   = children[so];
  if (prevNode && prevNode._nodeType === NODE_TEXT) {
    const oldLen = prevNode._data.length;
    prevNode.data = prevNode._data + text;
    setRangePoint(range, RANGE_BOTH, prevNode, oldLen + text.length);
  } else if (atNode && atNode._nodeType === NODE_TEXT) {
    atNode.data = text + atNode._data;
    setRangePoint(range, RANGE_BOTH, atNode, text.length);
  } else {
    const t = new Text(text);
    if (atNode) sc._insertBefore(t, atNode);
    else        sc._appendChild(t);
    setRangePoint(range, RANGE_BOTH, t, text.length);
  }
  return true;
}
globalThis.__csimInsertTextAtSelection = __csimInsertTextAtSelection;

// Serialize a Range's contents to an HTML string — the text/html flavor a rich
// cut / copy writes to the clipboard, so a subsequent paste's dataTransfer can
// expose the original markup. Round-tripping through a detached container's
// innerHTML gives correct element serialization and text escaping for free.
function serializeRangeHtml(range) {
  try {
    const div = globalThis.document.createElement('div');
    div._appendChild(range.cloneContents());
    return div._innerHTML;
  } catch (_) { return ''; }
}

// A text form control whose VALUE the selection-based editing commands splice —
// textarea, or an input of a type the text-selection API applies to. Types like
// email / number are excluded: their selectionStart/End getters return null and
// the setters throw InvalidStateError, so such a control falls through to a
// no-op rather than corrupting its value. Shared by execCommand and the
// clipboard-gesture path so the two never disagree on what counts as editable.
function isSelectionTextControl(el) {
  return el._tag === 'textarea' ||
    (el._tag === 'input' && SELECTION_INPUT_TYPES.has(el.type));
}

// Splice `insert` over a text control's current selection, collapse the caret
// after it, and mark the control edited (so a later blur fires `change`). The
// value mutation only — the caller fires the InputEvent(s), since the gesture
// path interleaves a cancelable `beforeinput` that scripted execCommand omits.
function spliceTextControlValue(el, insert) {
  const cur = String(controlLiveValue(el));
  const ss  = el.selectionStart == null ? cur.length : el.selectionStart;
  const se  = el.selectionEnd   == null ? cur.length : el.selectionEnd;
  setControlLiveValue(el, cur.slice(0, ss) + insert + cur.slice(se));
  el.selectionStart = el.selectionEnd = ss + insert.length;
  if (el._changeBaseline !== undefined) el._editedSinceFocus = true;
}

// The read-only DataTransfer an `insertFromPaste` InputEvent carries into a rich
// contenteditable: getData reads the pasted flavors back, setData / clearData
// are no-ops (an input event's dataTransfer is read-only). text/html is included
// only when the clipboard holds it, so a plain-text paste has no html flavor.
function buildReadOnlyPasteDataTransfer(plain, html) {
  const dt = new DataTransfer();
  dt.setData('text/plain', plain);
  if (html) dt.setData('text/html', html);
  setDataTransferMode(dt, 'read-only');
  return dt;
}

// Write the current selection to the clipboard: text/plain always, plus a
// text/html flavor for a rich (non-text-control) selection so a later paste can
// round-trip the markup. Shared by execCommand cut/copy and the gesture path,
// so which one performed the cut no longer decides whether html survives.
function writeSelectionToClipboard(target, isTextControl) {
  if (isTextControl) {
    const v = String(controlLiveValue(target) || '');
    globalThis.__csimClipboardSet(v.slice(target.selectionStart, target.selectionEnd));
    return;
  }
  const sel = globalThis.__csimGetSelection();
  const text = sel ? String(sel) : '';
  const range = globalThis.__csimSelectionRange();
  const html = range && !range.collapsed ? serializeRangeHtml(range) : '';
  globalThis.__csimClipboardSetData({ 'text/plain': text, 'text/html': html });
}

// The user-gesture clipboard algorithm (Ctrl/Cmd + X / C / V), driven by the
// testdriver accelerator path. Unlike scripted `document.execCommand` — which
// fires only `input` (verified against Chrome: `execCommand('cut')` logs
// `cut` + `input-deleteByCut`, no `beforeinput`) — a genuine accelerator fires
// the cancelable `beforeinput` before mutating, so a page can cancel the edit
// while the clipboard write still happens (input-events-cut-paste's
// preventDefault case). Sequence: cut/copy/paste ClipboardEvent → [beforeinput]
// → mutate → input. Returns true when the command applied.
//
// NOTE: a contenteditable paste inserts only text/plain into the DOM even when
// the clipboard carries text/html — the beforeinput dataTransfer still exposes
// the html (which the test asserts), but the default DOM insertion is plain
// text. Rich-fragment insertion is a bounded gap shared with execCommand's
// paste; no in-scope test checks the resulting markup.
export function performClipboardGesture(kind, target) {
  if (!target || target._nodeType !== NODE_ELEMENT) return false;
  const isTextControl = isSelectionTextControl(target);
  const editable = isTextControl || isContenteditable(target);

  // A paste event carries the clipboard as a read-only DataTransfer — each of
  // its flavors, and its files (`types` then includes "Files": Discourse's
  // `clipboardHelpers` gates an upload on it); cut / copy fire a bare event (a
  // page overriding the clipboard via clipboardData.setData on cut is not
  // modeled through this path — apps drive custom clipboard writes through
  // execCommand / navigator.clipboard, not a synthetic accelerator).
  const pasteClipboardData = () => {
    const dt = new DataTransfer();
    const files = globalThis.__csimClipboardFiles ? globalThis.__csimClipboardFiles() : [];
    for (const t of globalThis.__csimClipboardTypes ? globalThis.__csimClipboardTypes() : []) {
      if (!files.some((f) => f && f.type === t)) dt.items.add(globalThis.__csimClipboardGet(t) || '', t);
    }
    for (const f of files) if (f) dt.items.add(f);
    setDataTransferMode(dt, 'read-only');
    return dt;
  };
  const fireClipboard = (type) => {
    try {
      const clipboardData = type === 'paste' ? pasteClipboardData() : null;
      const ev = new ClipboardEvent(type, { bubbles: true, cancelable: true, composed: true, clipboardData });
      fireEvent(target, ev);
      // (…its clipboard view gone once dispatched, as Chrome's: a read that waited finds nothing)
      if (clipboardData) setDataTransferMode(clipboardData, null);
      return ev._canceled;
    } catch (_) { return false; }
  };
  const fireBeforeInput = (inputType, data, dataTransfer) => {
    try {
      const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data, inputType, dataTransfer: dataTransfer || null });
      fireEvent(target, ev);
      return !ev._canceled;
    } catch (_) { return true; }
  };
  const fireInput = (inputType, data, dataTransfer) => {
    try {
      fireEvent(target, new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data, inputType, dataTransfer: dataTransfer || null }));
    } catch (_) {}
  };

  if (kind === 'copy') {
    if (fireClipboard('copy')) return true;
    writeSelectionToClipboard(target, isTextControl);
    return true;
  }
  if (kind === 'cut') {
    if (fireClipboard('cut')) return true;
    // A non-editable cut fires the event but performs no clipboard write and no
    // delete (only copy writes from a non-editable selection) — bail before the
    // write so Ctrl+X over read-only content can't clobber the clipboard.
    if (!editable) return true;
    writeSelectionToClipboard(target, isTextControl);
    if (!fireBeforeInput('deleteByCut', null, null)) return true;   // canceled: clipboard kept, DOM untouched
    if (isTextControl) {
      spliceTextControlValue(target, '');
    } else {
      const range = globalThis.__csimSelectionRange();
      if (range && !range.collapsed) deleteRangeContents(range);
    }
    fireInput('deleteByCut', null, null);
    return true;
  }
  // paste
  const plain = globalThis.__csimClipboardGet ? (globalThis.__csimClipboardGet('text/plain') || '') : '';
  if (fireClipboard('paste')) return true;
  if (!editable) return true;
  // A plain text control's insertFromPaste carries the pasted text as `data` with
  // a null dataTransfer; a rich contenteditable reports null `data` and a
  // read-only DataTransfer carrying the clipboard flavors (input-events-cut-paste).
  let data, dt;
  if (isTextControl) {
    data = plain;
    dt   = null;
  } else {
    data = null;
    const html = globalThis.__csimClipboardGet ? (globalThis.__csimClipboardGet('text/html') || '') : '';
    dt = buildReadOnlyPasteDataTransfer(plain, html);
  }
  if (!fireBeforeInput('insertFromPaste', data, dt)) return true;   // canceled: DOM untouched
  if (isTextControl) spliceTextControlValue(target, plain);
  else globalThis.__csimInsertTextAtSelection(plain);
  fireInput('insertFromPaste', data, dt);
  return true;
}
globalThis.__csimClipboardGesture = performClipboardGesture;

// True for the CharacterData node types whose contents a range slices by offset.
function isCharacterData(n) {
  return n != null && (n._nodeType === NODE_TEXT || n._nodeType === NODE_CDATA ||
                       n._nodeType === NODE_COMMENT || n._nodeType === NODE_PI);
}
// The shared DOM algorithm for Range cloneContents / extractContents /
// deleteContents (DOM §5.5). `mode`:
//   'clone'   — copy contained nodes into a returned fragment; tree unchanged.
//   'extract' — move contained nodes into a returned fragment; tree mutated.
//   'delete'  — remove contained nodes; no fragment, tree mutated.
// What the range contains is the engine's (ranges.rs `rangeContents`): its common ancestor, the partially contained
// children of that, recursed into (their contained slice is cloned / moved / deleted), and the contained ones between.
// For the mutating modes the range collapses to its start, or to after its first partially contained child.
function processRangeContents(range, mode) {
  const sc = range.startContainer, so = range.startOffset;
  const ec = range.endContainer,   eo = range.endOffset;
  const ownerDoc = (sc && (sc._nodeType === NODE_DOC ? sc : sc.ownerDocument)) || globalThis.document;
  const frag = mode === 'delete' ? null : ownerDoc.createDocumentFragment();
  if (!sc || !ec) return frag;
  const collapse = processContents(sc, so, ec, eo, mode, frag, ownerDoc);
  if (mode !== 'clone') setRangePoint(range, RANGE_BOTH, collapse ? collapse[0] : sc, collapse ? collapse[1] : so);
  return frag;
}
// The contents between (sc, so) and (ec, eo) cloned or moved into `frag` (none for 'delete'), or deleted — and where a
// range over them collapses to, where not to its start: [node, offset].
function processContents(sc, so, ec, eo, mode, frag, ownerDoc) {
  // Collapsed: nothing contained.
  if (sc === ec && so === eo) return null;
  // Single CharacterData container: slice [so, eo) of the one node.
  if (sc === ec && isCharacterData(sc)) {
    if (mode !== 'delete') {
      const clone = sc._cloneNode(false);
      clone._data = (sc.data || '').slice(so, eo);
      frag._appendChild(clone);
    }
    if (mode !== 'clone') sc._replaceData(so, eo - so, '');
    return null;
  }
  const [up, first, last, from, to, doctype] = globalThis.__dom.rangeContents(boundaryNid(sc), so, boundaryNid(ec), eo);
  if (doctype && mode !== 'delete') throw hierarchyError('a range containing a doctype cannot be cloned or extracted');
  let common = sc;
  for (let i = 0; i < up; i++) common = treeParent(common);
  const kids = common._children;
  const firstPC = first < 0 ? null : kids[first], lastPC = last < 0 ? null : kids[last];
  const contained = kids.slice(from, to);
  const collapse = firstPC && [common, first + 1];

  // First partially-contained child.
  if (isCharacterData(firstPC)) {
    if (mode !== 'delete') {
      const clone = sc._cloneNode(false);
      clone._data = (sc.data || '').slice(so);
      frag._appendChild(clone);
    }
    if (mode !== 'clone') sc._replaceData(so, nodeLength(sc) - so, '');
  } else if (firstPC) {
    processPartial(firstPC, sc, so, firstPC, nodeLength(firstPC), mode, frag, ownerDoc);
  }

  // Fully-contained children: clone (deep), move, or remove.
  for (const child of contained) {
    if (mode === 'clone') frag._appendChild(child._cloneNode(true));
    else if (mode === 'extract') frag._appendChild(child);
    else if (child._parent) child._parent._removeChild(child);
  }

  // Last partially-contained child.
  if (isCharacterData(lastPC)) {
    if (mode !== 'delete') {
      const clone = ec._cloneNode(false);
      clone._data = (ec.data || '').slice(0, eo);
      frag._appendChild(clone);
    }
    if (mode !== 'clone') ec._replaceData(0, eo, '');
  } else if (lastPC) {
    processPartial(lastPC, lastPC, 0, ec, eo, mode, frag, ownerDoc);
  }
  return collapse;
}
// A partially contained child: a shallow clone of it in the fragment, holding what of it the range contains.
function processPartial(child, sc, so, ec, eo, mode, frag, ownerDoc) {
  const clone = mode === 'delete' ? null : frag._appendChild(child._cloneNode(false));
  const sub = clone && ownerDoc.createDocumentFragment();
  processContents(sc, so, ec, eo, mode, sub, ownerDoc);
  if (clone) clone._appendChild(sub);
}
export function deleteRangeContents (range) { processRangeContents(range, 'delete'); }
export function cloneRangeContents  (range) { return processRangeContents(range, 'clone'); }
export function extractRangeContents(range) { return processRangeContents(range, 'extract'); }
// A one-element list of StaticRanges snapshotting the current selection — the
// `getTargetRanges()` of a `beforeinput` for an editing action whose target IS
// the selection (insertText, formatBold, and the like; deletion instead targets
// the range it will remove). Empty when there is no selection. Shared by the
// engine send_keys path and the testdriver Actions path so both report the same
// ranges.
globalThis.__csimTargetRangesFromSelection = function () {
  const r = globalThis.__csimSelectionRange();
  if (!r) return [];
  // Normalize an element-level boundary onto the adjacent text node — real
  // browsers report a target range at the deepest text node, so a whole-node
  // selection like `selectAllChildren` (which yields (el, 0)-(el, childCount))
  // surfaces as (textNode, 0)-(textNode, length), which the test asserts.
  const toText = (container, offset) => {
    if (!container || container._nodeType === NODE_TEXT) return [container, offset];
    const kids = container._children || [];
    if (offset < kids.length && kids[offset] && kids[offset]._nodeType === NODE_TEXT) return [kids[offset], 0];
    if (offset > 0 && kids[offset - 1] && kids[offset - 1]._nodeType === NODE_TEXT) return [kids[offset - 1], (kids[offset - 1]._data || '').length];
    return [container, offset];
  };
  try {
    const s = toText(r.startContainer, r.startOffset);
    const e = toText(r.endContainer, r.endOffset);
    return [new StaticRange({
      startContainer: s[0], startOffset: s[1],
      endContainer:   e[0], endOffset:   e[1]
    })];
  } catch (_) { return []; }
};

// XML serialization (DOM Parsing §3.2) is the arena's (serialize.rs): `XMLSerializer.serializeToString(node)` (dom-parser.js), and
// `innerHTML` / `outerHTML` in an XML document — those requiring the node well-formed, an InvalidStateError where it
// has no well-formed serialization.
export function xmlSerialize(node, inner, wellFormed) {
  const r = serializedXml(node, inner, wellFormed);
  if (typeof r !== 'string') throw new globalThis.DOMException(r[0], 'InvalidStateError');
  return r;
}
function xmlSerializeInner(el) { return xmlSerialize(el, true, true); }
function xmlSerializeOuter(el) { return xmlSerialize(el, false, true); }

// HTML "check that the focused area is still focusable", which a real browser
// runs in its rendering update: if the currently-focused element has become
// non-focusable (moved into an inert / hidden / display:none subtree, or
// disconnected), the document loses focus — but ASYNCHRONOUSLY, so the element
// is still `document.activeElement` synchronously right after the mutation and
// blurs on a later task. `moveBefore` is the entry point that needs this
// because, unlike removeChild, it preserves focus across the relocation.
function resetFocusIfUnfocusableAfterMove(doc) {
  const ae  = doc && doc._activeElement;
  if (!ae) return;
  if (isFocusable(ae)) return;   // still focusable → keep (isFocusable now folds in inert)
  queueTask(() => {
    if (doc._activeElement !== ae) return;                       // focus moved meanwhile
    if (isFocusable(ae)) return;                                 // became focusable again
    doc._activeElement = null;                                   // → activeElement falls back to <body>
    fireEvent(ae, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true, view: globalThis }));
    fireEvent(ae, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true, view: globalThis }));
  }, 0);
}

// `ParentNode.moveBefore(node, child)` (DOM "atomic move") — relocates `node` to
// be before `child` in this parent WITHOUT removing-and-reinserting, so the
// node's connectedness never changes and no connected/disconnected reactions
// fire. It is stricter than insertBefore: only an Element or CharacterData node
// can move, and `node` and this parent must share a shadow-including root.
// The ParentNode interfaces' (Element / Document / DocumentFragment), never Node's — `"moveBefore" in textNode` must
// be false. Its arguments converted: `node` a Node, `child` a Node or null ("to the end").
function parentNodeMoveBefore(parent, node, child) {
  // The checks of "move" (https://dom.spec.whatwg.org/#move), the engine's
  // (mutation.rs): one shadow-including tree, no ancestor of the parent, a reference child of it, an Element or
  // CharacterData node, and a Document's one element.
  switch (globalThis.__dom.moveRefusal(node._nid, node._nodeType, parent._nid, parent._nodeType, child == null ? -1 : child._nid)) {
    case 0: break;
    case 2: throw hierarchyError('moveBefore: the moved node is an ancestor of the new parent');
    case 3: throw new globalThis.DOMException('The reference child is not a child of this node', 'NotFoundError');
    case 10: throw hierarchyError(`moveBefore: a ${nodeTypeName(node)} node cannot be moved`);
    case 11: throw hierarchyError('moveBefore: a Text node cannot be a child of a Document');
    case 12: throw hierarchyError('moveBefore: a Document can contain only one element child');
    default: throw hierarchyError('moveBefore: node and new parent are not in the same tree');
  }

  // Move. "If child is node, set child to node's next sibling" so moving a node
  // before itself is a no-op.
  let ref = child === node ? node.nextSibling : child;
  const oldParent = node._parent;
  let prevSib = null, nextSib = null;
  if (oldParent) {
    const oi = childIndexOf(oldParent, node);
    if (oi >= 0) {
      // Capture the removed node's adjacent siblings BEFORE the splice — by
      // record-delivery time `node` sits at its new position, so recordChildList
      // can't derive the removal record's siblings (matches removeChild).
      prevSib = oi > 0 ? oldParent._children[oi - 1] : null;
      nextSib = oi + 1 < oldParent._children.length ? oldParent._children[oi + 1] : null;
      // The NodeIterators' pre-removing steps and the live ranges' removing steps run
      // with the edge (tree.js): the atomic move "still" adjusts them like a remove
      // (dom/nodes/moveBefore/moveBefore-nodeiterator.html, live-range-updates.html),
      // and the insertion's below.
      removeEdgeAt(oldParent, oi);
    }
  }
  const ii = ref == null ? -1 : childIndexOf(parent, ref);
  insertEdge(parent, node, ii);
  // A single-select <select> keeps only the last selected <option>; moving an
  // option in or around can change that, so run the spec's selectedness
  // algorithm on both ends: the destination select (the moved option wins if
  // selected) and the source select (which may need a fresh default). This is
  // what makes the WPT moveBefore option/optgroup selectedness contract pass.
  // An atomic move DEFERS the selectedcontent update to a microtask (both ends),
  // unlike a fresh insertion which updates it synchronously — selectedcontent-
  // movebefore. The selectedness reconcile itself (value/selectedIndex) still runs
  // synchronously here.
  askForReset(node, true);
  if (oldParent && oldParent !== parent) askForResetAfterRemoval(node, oldParent);
  // Moving a <selectedcontent> (or a subtree containing one) into a <select>
  // re-mirrors the new owner's selected option — also deferred to a microtask. Gate
  // on the cheap ancestor-<select> walk (O(depth)) FIRST so an ordinary move (the
  // common morph-library case, never into a select) skips the O(subtree)
  // selectedcontent scan entirely (rule 3).
  let ownerSelect = null;
  for (let cur = parent; cur; cur = cur._parent) { if (cur._tag === 'select') { ownerSelect = cur; break; } }
  if (ownerSelect && (node._tag === 'selectedcontent' || (node.querySelector && node.querySelector('selectedcontent')))) {
    ownerSelect._hasSelectedContent = true;
    scheduleSelectedContentUpdate(ownerSelect);
  }

  // MutationObserver sees the relocation as a removal from the old parent and
  // an addition to the new one.
  if (oldParent) recordChildList(oldParent, [], [node], prevSib, nextSib);
  recordChildList(parent, [node], []);
  // The move keeps focus and hover, but the chains above the carrier changed: the old ancestors'
  // `:focus-within` / `:hover` matches end and the new ones' begin — a flip the setters cannot
  // see (same element before and after), announced here.
  if (oldParent !== parent) {
    const doc = globalThis.document;
    const ae = doc && doc._activeElement, he = doc && doc._hoverElement;
    if ((ae && (ae === node || nodeContains(node, ae))) || (he && (he === node || nodeContains(node, he)))) bumpStyleState();
  }
  // Connectedness is unchanged (same shadow-including root). A connected move
  // still runs custom-element reactions per moved element — connectedMoveCallback,
  // or the legacy disconnected/connected pair — with isConnected staying true.
  if (isConnected(node)) fireCEMoveReactions(node);
  // A move into an inert / hidden subtree makes a focused descendant lose focus
  // (asynchronously), per HTML's focus-fixup in the rendering update.
  resetFocusIfUnfocusableAfterMove(node.ownerDocument);
  return undefined;
}


// The node that stands for `node` in tree order: itself, or an Attr's element (null for none).
function positionNode(node) {
  if (node._nodeType !== NODE_ATTRIBUTE) return node._nid;
  const el = node._ownerElement;
  return el ? el._nid : null;
}
// An Attr's store key in its element; null for any other node, or an Attr with no element.
function positionAttrKey(node) {
  return node._nodeType === NODE_ATTRIBUTE ? node._key : null;
}



// The stable, live Attr node for the attribute stored under `key`. Returned
// from `attributes` / `getAttributeNode`. `key` must already exist in the
// element's store (callers guard with hasOwnProperty). Identity is cached on
// the element so repeated reads return the same Attr (an XPath result /
// Capybara's `native.attributes` read `value` / `name` / `namespaceURI` /
// `prefix` / `localName` / `ownerElement` off it).
function makeAttr(el, key) {
  return el._attrNodeFor(key);
}

// HTML parser closes over the DOM ctors. Install here so
const { parseXml } = installXmlParser({
  createElementNode, Text, Comment, ProcessingInstruction, CDATASection, DocumentType, DocumentFragment, syncInlineEventHandler,
  appendedAttributeSteps, parserInsertionSteps
});
// The HTML parser is html5ever, run natively (html_parse.rs); html-tree-builder.js takes the tree it builds onto our
// node ctors. `parseHtmlIntoLive` is the document load path (parse directly into the live document, reusing its
// skeleton); `parseHtmlDocument` is the one-shot fresh-document path (DOMParser, frame fallback, `<html>`-innerHTML);
// `parseHtmlFragment` backs `parseFragment` (innerHTML / outerHTML / insertAdjacentHTML / createContextualFragment),
// context-aware. html-parser.js keeps only the serializers.
const { parseHtmlIntoLive, parseHtmlFragment, parseHtmlDocument } = installHtmlTreeBuilder({
  Text, Comment, DocumentFragment, DocumentType,
  createHtmlPageDocument, registerSubtree, unregisterSubtree, registerNamedAccess,
  syncInlineEventHandler, createElementNode, inertTemplateDocFor, constructParsedCustomElement, appendedAttributeSteps,
  parserInsertionSteps
});
// `parseFragment(html, contextEl)` — HTML fragment parsing in the context element's insertion mode (table / select /
// raw-text / foreign content, …). Callers thread the spec fragment context.
const parseFragment = parseHtmlFragment;

// In an XML/XHTML document, `innerHTML` / `outerHTML` setting and
// `insertAdjacentHTML` parse markup with the XML fragment parsing algorithm (in
// `context`'s namespace scope) rather than the HTML parser. A not-well-formed
// fragment is a SyntaxError DOMException (and nothing is inserted), per spec.
function parseXmlFragment(html, context) {
  const nodes = parseXml(String(html === null ? '' : html), { context });
  if (nodes === null) {
    throw new globalThis.DOMException("The given markup is invalid XML, and therefore cannot be inserted into an XML document.", 'SyntaxError');
  }
  // Fragment-parsed elements inherit the CONTEXT's registry association (the
  // HTML path does this in the tree builder via curRegistry) — a scoped or
  // sticky-null context marks its parsed children.
  const ctxReg = context && context._ceRegistry;
  if (ctxReg !== undefined) {
    for (const n of nodes) walkSubtree(n, c => { if (c._nodeType === NODE_ELEMENT && c._ceRegistry === undefined) c._ceRegistry = ctxReg; });
  }
  return nodes;
}

export {
  Node,
  Text,
  Comment,
  Element,
  DocumentFragment,
  ShadowRoot,
  Document,
  makeAttr,
  createHtmlPageDocument,
  parseHtmlDocument,
  parseHtmlIntoLive,
  parseFragment,
  parseXml
};

// A host image result (`__csim_loadImage`'s, or an async load's), its bitmaps taken out of the transfer registry
// into `pixels` / `pixelsP3`: the shape `__dom.decodeImage` hands back, which is the one `_applyImageResult` reads.
function takeHostBitmaps(r) {
  if (!r || !r.refId) return r;
  const view = id => {
    const b = fetchTransfer(id);
    return b && new globalThis.Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength);
  };
  return {...r, pixels: view(r.refId), pixelsP3: r.refIdP3 ? view(r.refIdP3) : null};
}

// Resource Timing for an image load: an `img` entry (an `<input type=image>` reports `input`)
// sized by the encoded bytes the host decoded; a broken load is a network error.
// A URL the document already loaded comes from its memory cache — no fetch, no entry (Chrome:
// `cached-image-gets-single-entry`).
function recordImageTiming(el, src, timingStart, r) {
  if (typeof globalThis.__csimRecordResource !== 'function' || !src) return;
  const seen = globalThis.__csimImageEntries || (globalThis.__csimImageEntries = new Set());
  const fetched = !!(r && !r.unsupported);            // a response arrived — decodable or not
  if (fetched && !r.broken && seen.has(src)) return;
  if (fetched && !r.broken) seen.add(src);
  const meta = (fetched && r.meta) || null;
  const size = meta && meta.encoded != null ? meta.encoded | 0 : (fetched ? r.encoded | 0 : 0);
  globalThis.__csimRecordResource({ name: src, initiatorType: el._tag === 'input' ? 'input' : el._tag === 'image' ? 'image' : 'img', startTime: timingStart,
                                    encoded: size, decoded: size,
                                    status: fetched ? (meta && meta.status) || 200 : undefined, redirected: !!(meta && meta.redirected),
                                    headers: meta ? { 'content-type': meta.contentType || '', 'timing-allow-origin': meta.tao } : null,
                                    noCors: el._attrs.crossorigin == null });
}
