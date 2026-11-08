// DOM node classes — Node + Text + Comment + Element +
// DocumentFragment + ShadowRoot + Document + Range +
// their own steps.
//
// Every node is a slot in the engine's arena (`nidOf`, node-identity.js, which its handle is named
// by: handles.js); its parent and children are the engine's (`parentOrHostOf` / `childNodesOf` read them), and its listeners
// its handle's (events.js `listenersOf`). Element adds
// its attribute store (`attrsOf`: lower-cased attribute name → string value) and the
// usual IDL surface plus `dispatchEvent` / `addEventListener` from
// the bridge's capture/target/bubble walker.
//
// Mutual references between classes resolve through shared module
// scope. External-to-module refs (`globalThis.__csim*` host fns,
// `globalThis.document`, etc.) are spelled explicitly through
// `globalThis` — bare identifiers don't resolve inside ESM strict
// mode.

import { SANDBOXED_DOWNLOADS, SANDBOXED_FORMS, opaqueOriginRefusal, realmURL, sandboxed } from './document-origin.js';
import { parseURL, schemeRoute } from './url-parse.js';
import { resolveModuleSpecifier } from './esm-loader.js';
import {
  NODE_ELEMENT, NODE_ATTRIBUTE, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, NODE_PI, HTML_NS, SVG_NS, MATHML_NS, isHtml, isSvg,
  ROUTE_BLOB, ROUTE_NETWORK,
  IMAGE_FETCH_BROKEN, IMAGE_FETCH_PENDING
} from './constants.js';
import { obtainHost } from './obtain-host.js';
import { hostTask, oweFrame, platformDateNow, queueTask } from './timers.js';
import {
  convertCommentArguments,
  convertProcessingInstructionArguments,
  convertTextArguments,
  defineDOMTokenList,
  defineNodeFilter,
  defineNodeIterator,
  defineSVGAnimatedString,
  defineTreeWalker,
  defineValidityState,
  installAbstractRange,
  installAttr,
  installCDATASection,
  installCharacterData,
  defineCaretPosition,
  installComment,
  defineCustomStateSet,
  installDocument,
  defineDOMStringMap,
  defineElementInternals,
  installDocumentFragment,
  installDocumentType,
  defineDOMImplementation,
  installElement,
  defineHTMLAllCollection,
  installNode,
  installProcessingInstruction,
  installRange,
  installShadowRoot,
  defineStaticRange,
  installText,
  installXMLDocument,
  REFLECT_KEYWORDS_CONTENT_EDITABLE,
  REFLECT_KEYWORDS_DIR
} from './generated/bindings.js';
import {
  IntrinsicDate,
  PLATFORM,
  arrayIndex,
  ceEnter,
  ceLeave,
  constructedBy,
  interfaceCheck,
  makeSlots,
  platformMicrotask,
  registerInterface,
  resolvedPromise,
  slotsOf,
  toDOMString,
  NO_ARGUMENTS,
  reflectConstruct,
  objectCreate,
  definePropertyOwn,
  rootInterface,
  Stamp
} from './webidl.js';
import { appendEdge, insertEdges, clearEdges, childIndexOf, currentEdgeGen } from './tree.js';
import { inConnectWalk, subtreeRemoved, discardBrowsingContext, focusRealm, frameRealmOf } from './handles.js';
import {
  FN_COMMIT_PENDING, FN_CONTEXT_READY, FN_HISTORY_REPLACE, FN_LOAD_FIRED, FN_RELOAD_NAV, FN_SRC_REFUSED, FN_URL_HISTORY, frameNavigationFinalized,
  FN_URL_RELOAD, FN_URL_SRC, FC_LOADED, FC_NAV, copyFrameContent,
  frameContentUrl, frameNavHas, frameNavUrl, setFrameContent, setFrameNav, setFrameNavUrl, supersedeFrameNavigation,
  takeFrameNavUrl
} from './frame-nav.js';
import { dispatchEvent, dispatchEventForUserAction, fireCheckableActivation, fireEvent, retarget } from './dispatch.js';
import {
  bumpSettleGen, currentTreeGen, setSlotChangeFirer,
  markLayoutDirty, engineWritten
} from './mutation-observer.js';
import { hrefAttr } from './link-href.js';
import {
  registerNativeElement, registerNativeNode, doctypeField, arenaAttachShadow, shadowIs, setShadowIs,
  setShadowAdoptedSheets, SHADOW_DELEGATES_FOCUS, SHADOW_MANUAL_SLOTS, SHADOW_CLOSED, SHADOW_CLONABLE,
  SHADOW_SERIALIZABLE, SHADOW_DECLARATIVE, SHADOW_INTERNALS, registerBeside, REALM as NATIVE_REALM, foreignRealmOf,
  setElementState, setElementValue, hasState, stateOf, setStateBit, latchFocusRing, settleImageDecodes,
  syncCustomStates, assignSlots, assignedSlotOf, assignedNodesOf, assignManual, STATE_FOCUSED, STATE_HOVERED,
  STATE_XML_DOCUMENT, STATE_DESIGN_MODE, STATE_INITIAL_ABOUT_BLANK, STATE_HIDDEN, STATE_CHECKED_DIRTY,
  STATE_CHECKED, STATE_SELECTED, STATE_POPOVER_OPEN,
  STATE_IS_VALUE, STATE_DIRTY_BY_USER, STATE_HAS_FILES, STATE_SELECTED_DIRTY,
  settledScrollOffsetOf, validityFlagsOf, willValidateOf, validationMessageOf,
  setCustomValidityOf, isRtl, sanitizedValueOf, valueEdited,
  imageSourceOf, isValueOf, setIsValueOf, liveValueOf, rareDataOf, sameObject, relativeOf, childCountOf, childAtOf,
  childNodesOf, RELATIVE_PARENT, RELATIVE_PARENT_OR_HOST, RELATIVE_ROOT, RELATIVE_SHADOW_INCLUDING_ROOT,
  RELATIVE_PARENT_ELEMENT, RELATIVE_FIRST_CHILD, RELATIVE_LAST_CHILD, RELATIVE_PREVIOUS, RELATIVE_NEXT,
  RELATIVE_FIRST_ELEMENT, RELATIVE_LAST_ELEMENT, RELATIVE_PREVIOUS_ELEMENT, RELATIVE_NEXT_ELEMENT, RELATIVE_SHADOW_ROOT,
  RELATIVE_HOST, RELATIVE_TEMPLATE_CONTENT, RELATIVE_DOCTYPE, htmlAncestorOf, svgAncestorOf, nodeDocumentOf, setNodeDocumentOf, setSubtreeDocumentOf,
  elementsInState, scriptsIn, imageElementsIn, STATE_PRECUSTOMIZED, STATE_CUSTOM, STATE_FORM_ASSOCIATED, setTemplateContentOf, serializedXml,
  sheetOwnersIn, sheetOfOwner, childElementsOf, LINK_STYLESHEET, linkTypesOf,
  changeChildrenOf, moveChildOf, shadowHostJoined, makingObjectOf, makingEngineObject, parentNodeOf, nextSiblingOf, parentOrHostOf, hostOf, dataOf, previousSiblingOf, shadowRootOf, templateContentsOf, setIsValue, setSelectedFiles, setLiveValue, getAttribute, getAttributeNS, hasAttribute, attrKeyOf, BY_NS, makingRealmOf, documentRealmOf, inRealm
} from './native-query-shadow.js';
import { assignOwnerDoc, isConnected, isScriptElement, scriptFlag, setScriptFlag, SCRIPT_ALREADY_STARTED, SCRIPT_PARSER_INSERTED, SCRIPT_NOT_FORCE_ASYNC, SCRIPT_RUN, findById, setTemplateDocResolver } from './walk.js';

import { reflectEnum, setAttributeWriters } from './reflect.js';
import { documentBaseURL, documentEncoding, documentURL, parseDocumentURL, resolveURLValue } from './base-url.js';
import { logError } from './console.js';
import { takeHostBitmaps }                                            from './bytes.js';
import { selectAll, selectFirst, matchesSelector, closestSelector }   from './selectors.js';
import {
  isUnskippedNode, feedStyleEngineSheets, styleEngineFocusable, styleEngineFocusTarget, styleEngineTransparent,
  styleEngineHoldsScrollOffset, styleEnginePaddingEdgeBox, styleEngineScrollHolder, styleEngineScrollingElement, sequentialFocusNext,
  visibilityHidden, markCascadeStale, markRuleSetMoved, styleElementIsCss, fetchedSheet, ownerSheet, styleEngineRangeText
} from './cascade.js';
import { customElements as globalCERegistry, isRegistry, shadowRootRegistry, shadowDisabled, autonomousDefinitionOf, registryForElement, documentRegistry, windowRegistryOf, setWindowRegistryOf, TRACKING_NULL, lookupCEDefinition, globalDefinitionOf, ctorHasAnyDefinition, ceStackView, upgradeElement, registryCodeOf, isValidCustomElementName, isFormAssociatedCustomElement, becomeCustom, markFailed, hasFormAssociatedCustomElements, setFormAssociatedReset, ceEnqueueUpgradesIn, ceEnqueueUpgradesOf, hasAnyCEDefinitions, fireCEDisconnect, fireCEMoveReactions, fireCEAdopted, fireCEHook, FORM_RESET_CALLBACK, resetFormStateIn, resetCustomElementFormState, resetFormOwnersNamedIn, FACE_FORM_OWNER, FACE_DISABLED_STATE, queueBackupReactions, setSelectedContentUpdater, askForReset, askForResetBatch, askForResetAfterRemoval, resetAnswered, runSelectednessAlgorithm, finalizeSelectOptions, scheduleSelectedContentUpdate, syncSelectedContent, ceRegistryOf, setCeRegistryOf } from './custom-elements.js';
import { FORM_CONSTRUCTING_ENTRY_LIST, FORM_FIRING_SUBMISSION_EVENTS, FORM_LOCKED_FOR_RESET, SELECT_HAS_SELECTED_CONTENT, elementFlag, setElementFlag } from './element-flags.js';
import {
  isContenteditable, optionsChanged, controlLiveValue, setControlLiveValue,
  moveTextEntryCursor, controlEdited, selectCoordinate, inputTypeState, markUserValidity,
  formControlElements, formForControl, isActuallyDisabled, fireBeforeToggle, queueToggleTask, isLabelableControl,
  labelsFor, forgetSelectedCoordinate, inputHas, INPUT_LIST
} from './form-helpers.js';
import { inlineStyleOf, declaredValue, setInlineStyleProperty } from './style-proxy.js';
import { liveHTMLCollection, liveNodeList, liveRadioNodeList, nodeList, childNodeList, liveNamedNodeMap }   from './dom-collections.js';
import { isHtmlDocument, isXmlMimeType }                              from './mime.js';
import { resetBitmap } from './canvas.js';
import { isImageRequestElement } from './image-request.js';
import { closeDialog, dialogClosed, dialogCommandSteps, dialogOpened } from './dialog.js';
import { checkPopoverValidity, hidePopover, popoverAttributeChanged, showPopover } from './popover.js';
import { autofocusInsertionSteps, flushAutofocusCandidates, parserAutofocusStep } from './autofocus.js';
import { ensureInView, rectOf, clientRectsOf, clientBox, viewportSize, contentExtent, offsetsOf, applyScrollIntoView, scrollMoved, requestScrollUpdate, hitTest, hitTestAll, noteScrolled, caretFromPoint, caretRectOf, forgetCaretMove, rangeRectsOf, rangeBoundingRectOf } from './layout.js';

// Move the scroll offset `box` keeps — the viewport's on the root (`styleEngineScrollHolder`) — to (x, y), an axis given
// as `undefined` staying: clamped, its events queued and the scroll generation moved, the engine's (`scrollMoved`,
// scroll_boxes.rs `scroll_move`); then, where it moved, the scroll flush and the rendering update asked for. The flush is
// asked first: both are delivered by a microtask on a page with nothing else pending, and the rendering update runs the
// scroll steps before the intersection observations — so the scroll flush has to be the microtask queued first.
function moveScrollOffset(box, x, y) {
  if (!scrollMoved(box, x, y)) return;
  scheduleScrollFlush();
  requestScrollUpdate();
}

import { blobType }                                                    from './blob.js';
import { formDataEntries, isFormData, submissionFormData }             from './form-data.js';
import { mediaCreated, mediaSrcChanged, runSourceInsertionStep }     from './media.js';
import { planFrameNavigation, tryFragmentNavigate } from './location.js';

import {
  BeforeUnloadEvent, ClipboardEvent, CommandEvent, CompositionEvent, CustomEvent, DeviceMotionEvent,
  DeviceOrientationEvent, DragEvent, Event, EventTarget, FocusEvent, HashChangeEvent, InputEvent, KeyboardEvent,
  MessageEvent, MouseEvent, PointerEvent, StorageEvent, SubmitEvent, TextEvent, UIEvent, createBeforeUnloadEvent,
  createTextEvent, dispatchWithOnHandler, eraseListenersAndHandlers, eventState, installEventHandlerAttrs,
  setScopeFormOwnerResolver, syncInlineEventHandler
} from './events.js';
import { DataTransfer, dataTransferStore, setDataTransferMode, setEffectAllowed } from './data-transfer.js';
import { serializeChildren, serializeChildrenWithShadow, serializeElement } from './html-parser.js';
import { moduleStyleSheetText } from './css-utils.js';
import { asciiLower, asciiTokens, asciiUpper } from './ascii.js';
import { KNOWN_HTML_TAGS } from './html-element-names.js';
export { asciiLower };
import { constructedSheetOf, newStyleSheetList, ownedStyleSheet, sheetOwnerOf } from './cssom.js';
import { xpathEvaluatorBase } from './xpath.js';
import { bodyOf, documentElementOf, headOf } from './document-tree.js';
import { installHtmlTreeBuilder } from './html-tree-builder.js';
import { installXmlParser } from './xml-parser.js';
import { animateElement, animationsForElement, animationsForRoot, documentTimeline } from './web-animations.js';
import { DOMRect, rectList } from './geometry.js';
import { DOMException } from './dom-exception.js';
import { attrOwnerOf, attrOwnValueOf, attrStoreKeyOf, attrsOf, bindAttr, isNodeObject, localNameOf, markNodePrototype, piAttributesOf, piTargetOf, setAttrOwnValue, setPIAttributes, stampAttr, stampPI, stampShadowRoot, namespaceOf, nidOf, nodeArgOf, nodeObjectTypeOf, nodeTypeOf, prefixOf, selfOf, setPrefix, stampNamedNode, stampNode, stampNodeProxy, tagOf, isShadowRoot, pseudoOf, originOf, isRealmDocument } from './node-identity.js';
import { ceInitializedOf, compatModeOf, contentTypeOf, currentScriptOf, focusedElementOf, hasNoBrowsingContext, isQuirksDocument, isXMLDocumentObject, lastModifiedOf, readyStateOf, referrerOf, setCompatMode, setContentType, setNoBrowsingContext, setReadyState, setURL, setXMLDocumentObject, urlOf, defaultViewOf, hoveredElementOf } from './document-state.js';
import { dom, hooksOf, hostNamespace, hostSteps, isSameOriginDomainWindow, listOf, realmGlobalOf, realmHooks, realmOfGlobal, stepsOf } from './engine.js';

// How a command is carried out, who asks, and what goes round its edit (editing_commands.rs `STEP_*`, `ASKED_BY_SCRIPT` …,
// `PLAN_*`, by `commandPlan`); and where the selection goes after it (`Caret`, by `editCommand`).
const STEP_COPY = 1, STEP_CONTROL = 2, STEP_HOST = 3, STEP_SELECT_ALL = 4, STEP_CLIPBOARD_EVENT = 5;
const ASKED_BY_SCRIPT = 0, SCRIPT_AFTER_EVENT = 1, GESTURE_AFTER_EVENT = 2, GESTURE_EDIT = 3;
const PLAN_WRITE_SELECTION = 1, PLAN_BEFORE_INPUT = 2, PLAN_PASTE_TRANSFER = 4, PLAN_MARKUP_TEXT = 8, PLAN_MARKUP_FRAGMENT = 16, PLAN_PASTED_FRAGMENT = 32, PLAN_TARGET_RANGES = 64;
const CARET_AT = 1, CARET_AROUND = 2, CARET_MOVED = 3;

// The custom element a "create an element" constructs synchronously (`constructCustomElementSync`): the definition whose
// constructor it runs, the local name and the registry it is created with — taken by that constructor's `super()` alone, once, as it
// reaches the Element constructor (HTML's HTMLElement constructor looks the definition up by NewTarget; an element of
// another constructor made inside this one is made as any other — Chrome: its own local name, `:defined`).
let currentCreation = null;

// A scroll's events (scrollIntoView / scrollTo / scrollBy on any node, a driver's scroll — `moveScrollOffset`): the
// signal DLoadMore-shaped sentinels and scroll-driven UI swaps gate on. The box scrolled is one of its document's
// pending scroll and scrollend event targets — the engine's (scroll_events.rs, queued by scroll_boxes.rs `scroll_move`),
// the document's own, which the document's rendering update takes.
globalThis.__csimFlushScroll = function () {
  const doc = globalThis.document;
  if (!doc) return;
  for (const target of listOf(dom.takeScrollEvents(nidOf(doc), false))) {
    try {
      // A `scroll` event does not bubble out of an ELEMENT scroller, so an inner pane's reaches
      // that pane and nothing else (Chrome, measured: a listener on document or window counts ZERO
      // for it). The VIEWPORT's fires at the DOCUMENT and bubbles from there — that is how it
      // reaches window listeners (Discourse's site-header debouncer, Turbo's scroll observer), and
      // reaching them by a second explicit dispatch instead made a window CAPTURE listener fire
      // twice and reported `e.target` as the window where Chrome says the document.
      if (target === doc) {
        fireEvent(doc, new Event('scroll', { __proto__: null, bubbles: true }));
      } else {
        // A scroller REMOVED between the scroll and this update still gets its event — CSSOM-View's
        // "run the scroll steps" has no connectedness test and Chrome 151 fires both `scroll` and
        // `scrollend` for a box scrolled and removed in the same task.
        fireEvent(target, new Event('scroll', { __proto__: null, bubbles: false }));
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
  platformMicrotask(() => {
    scrollFlushScheduled = false;
    try { globalThis.__csimFlushScroll(); } catch (_) {}
    try { globalThis.__csimFlushScrollEnd(); } catch (_) {}
  });
}

// `scroll` is a PENDING SCROLL EVENT TARGET, exactly as `scrollend` below is
// (CSSOM-View "Scrolling events"): scrolling a box adds it to the document's
// pending list and the event fires at the next "update the rendering" step,
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
// `moveScrollOffset` QUEUES the target (on an actual position change only — a
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
globalThis.__csimFlushScrollEnd = function () {
  const doc = globalThis.document;
  if (!doc) return;
  for (const target of listOf(dom.takeScrollEvents(nidOf(doc), true))) {
    try {
      if (target === doc) {
        // The viewport scroller's scrollend fires at the document and bubbles to
        // window — dispatch.js already fires window listeners during the document
        // event's bubble phase, so a single bubbling document dispatch covers both
        // (an explicit window dispatch would double-fire window listeners).
        fireEvent(doc, new Event('scrollend', { __proto__: null, bubbles: true, cancelable: false }));
      } else {
        // (…any other scroller: the body in standards mode, which is no scrolling element, among them)
        fireEvent(target, new Event('scrollend', { __proto__: null, bubbles: false, cancelable: false }));
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
  return nodeMadeFor(doc, Text, String(v));
}
// https://dom.spec.whatwg.org/#converting-nodes-into-a-node — collect the
// variadic args into a single node: one item stays as-is, several are wrapped
// in a DocumentFragment so the caller inserts them in one operation. Both the
// fragment and a string's Text are `node`'s document's: made in the main one,
// another document's nodes were adopted into it and back on their way in.
function convertNodesIntoNode(nodes, node) {
  const doc = nodeTypeOf(node) === NODE_DOC ? node : nodeDocumentOf(node);
  if (nodes.length === 1) return toNode(nodes[0], doc);
  const frag = nodeMadeFor(doc, DocumentFragment);
  for (const n of nodes) appendChild(frag, toNode(n, doc));
  return frag;
}

// The element lists named by a filter (collections.rs): the scope's descendant elements in tree order that the engine's
// filter takes — `getElementsByClassName` (an ordered set of classes, ASCII case-insensitive in a quirks-mode document),
// `getElementsByTagNameNS` (namespace "*" any, "" / null none, else exact; local name "*" any, else exact) and
// `getElementsByTagName` ("*" any; in an HTML document the search ASCII-lowercased for an HTML element and compared
// with its actual qualified name), the document's legacy collections and `getElementsByName`. Plain Arrays; the live
// collections wrap them.
const BY_CLASSES = 0, BY_TAG_NS = 1, BY_TAG = 2, BY_FORMS = 3, BY_IMAGES = 4, BY_LINKS = 5, BY_SCRIPTS = 6, BY_ANCHORS = 7, BY_EMBEDS = 8, BY_NAME = 9;
function collectBy(scope, kind, a, b) {
  return dom.elementsBy(nidOf(scope), kind, a, b);
}
// (…the class names matched in the mode of the scope's document, which the engine reads: `document_mode`)
function collectByClassName(scope, classNames) {
  const doc = nodeTypeOf(scope) === NODE_DOC ? scope : nodeDocumentOf(scope);
  return collectBy(scope, BY_CLASSES, String(classNames), doc ? nidOf(doc) : -1);
}
export function collectByTagNameNS(scope, namespace, localName) {
  const ns = namespace === '*' ? '*' : (namespace == null || namespace === '' ? null : String(namespace));
  const local = String(localName);
  const found = collectBy(scope, BY_TAG_NS, ns, local);
  // (…a lone surrogate or U+FFFD, which the arena's names hold lossily, compared again exactly)
  if (!LOSSY_NAME.test(local) && !(ns && LOSSY_NAME.test(ns))) return found;
  return found.filter((el) => (local === '*' || localNameOf(el) === local) && (ns === '*' || (namespaceOf(el) ?? null) === ns));
}
// `htmlDoc` (whether to ASCII-lowercase the search for HTML-namespaced elements) is bound by the LIVE collection at
// CREATION time per WHATWG "list of elements with qualified name" — moving the root into a differently-HTML document
// must NOT change an existing list. Non-live callers omit it and get the scope's current document.
function collectByTagName(scope, tag, htmlDoc) {
  if (htmlDoc === undefined) htmlDoc = isHtmlDocument(nodeDocumentOf(scope));
  const name = String(tag);
  const found = collectBy(scope, BY_TAG, name, htmlDoc);
  if (!LOSSY_NAME.test(name)) return found;
  const lower = htmlDoc ? asciiLower(name) : name;
  return found.filter((el) => (prefixOf(el) ? prefixOf(el) + ':' + localNameOf(el) : localNameOf(el)) === (namespaceOf(el) === HTML_NS ? lower : name));
}
// A lone surrogate or U+FFFD: what the arena's names, UTF-8, hold lossily.
const LOSSY_NAME = /[\ud800-\udfff\ufffd]/;

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
  return NODE_TYPE_NAMES[node && nodeTypeOf(node)] || 'node';
}

function hierarchyError(msg) { return new DOMException(msg, 'HierarchyRequestError'); }

// Shared pre-insertion / replace validity
// (https://dom.spec.whatwg.org/#concept-node-ensure-pre-insertion-validity and #concept-node-replace), the engine's
// (mutation.rs): `child` is the reference (pre-insert) or replaced (replace) node; `isReplace` switches the
// document-child constraints to exclude the node being replaced. Each refusal its exception.
function validateInsertion(node, parent, child, isReplace) {
  const why = dom.insertionRefusal(node, parent, child, isReplace);
  switch (why) {
    case 0: return;
    case 1: throw hierarchyError(`Cannot add a child to a ${nodeTypeName(parent)} node`);
    case 2: throw hierarchyError('The new child is an ancestor of the parent');
    case 3: throw new DOMException('The reference child is not a child of this node', 'NotFoundError');
    case 4: throw hierarchyError(`Cannot insert a ${nodeTypeName(node)} node`);
    case 5: throw hierarchyError(`A ${nodeTypeName(node)} node cannot be a child of a ${nodeTypeName(parent)} node`);
    case 6: throw hierarchyError('Document can contain only one element');
    case 7: throw hierarchyError(nodeTypeOf(node) === NODE_FRAGMENT ? 'Invalid placement of an element in a Document' : 'Document can contain only one element child');
    default: throw hierarchyError('Invalid placement of a doctype in a Document');
  }
}
function ensurePreInsertionValidity(node, parent, child) {
  validateInsertion(node, parent, child, false);
}

// Pre-insertion "adopt" step (https://dom.spec.whatwg.org/#concept-node-pre-insert
// step 2): a node inserted into `parent` is first adopted into `parent`'s
// node document, which re-tags the subtree's `ownerDocument` AND detaches it
// from any previous parent. A same-document insert is just a detach (no
// subtree walk). Shared by appendChild / insertBefore / replaceChild so all
// three honour the adoption that the WPT Node-appendChild "Adopting an orphan
// / non-orphan" cases (and real cross-document grafting) depend on.
function adoptIntoParent(parent, node) {
  const destDoc = destinationDocument(parent);
  if (destDoc && nodeDocumentOf(node) !== destDoc && nodeTypeOf(destDoc) === NODE_DOC) {
    adoptNode(destDoc, node);
  } else {
    // (…its parent — a shadow root has none: its host is no parent to take it out of)
    const from = parentNodeOf(node);
    if (from) removeChild(from, node);
  }
}
// The document a node inserted into `parent` is adopted into.
function destinationDocument(parent) {
  return nodeTypeOf(parent) === NODE_DOC ? parent : nodeDocumentOf(parent);
}
// …and whether adopting `node` does anything: it has a parent to leave, or is another document's.
function needsAdopting(parent, node) {
  return parentNodeOf(node) != null || nodeDocumentOf(node) !== destinationDocument(parent);
}

// DOM "associated inert template document": the node document of every
// `template.content` (adopted-callback's "the document of the template
// elements"). Lazy — most pages never observe the identity; ONE per document,
// no browsing context; its own associated inert template document is ITSELF,
// so a template nested in template content stays in the same inert document
// (the self-link is also the O(1) "is this an inert template document" test the
// parser's owner propagation keys on: `isInertTemplateDocument`). Kept in the
// document's rare data.
export function inertTemplateDocFor(doc) {
  const rare = rareDataOf(doc, true);
  let d = rare.inertTemplateDoc;
  if (!d) {
    d = new Document();
    // Mirror the creating document's HTML-ness: an HTML document's template
    // content keeps HTML parsing / serialization / casing semantics.
    if (isHtmlDocument(doc)) setContentType(d, 'text/html');
    rareDataOf(d, true).inertTemplateDoc = d;   // (Document's constructor already set it no browsing context)
    rare.inertTemplateDoc = d;
  }
  return d;
}
export function isInertTemplateDocument(doc) {
  return rareDataOf(doc)?.inertTemplateDoc === doc;
}
// …and the document dropping the one it has: an in-place reload reuses the Document object.
export function forgetInertTemplateDocument(doc) {
  const rare = rareDataOf(doc);
  if (rare) rare.inertTemplateDoc = undefined;
}
// walk.js's assignOwnerDoc (adoption) resolves template content owners through this — it can't import Document
// itself.
setTemplateDocResolver(inertTemplateDocFor);

// The registry association `registry` given to `root` and each node of its tree under it (elements only where
// `elementsOnly`) whose association is one `match` names (`REGISTRY_UNSET`: none set, `REGISTRY_TRACKING`: the template
// contents' null) — the engine's walk (ce_reactions.rs `ceRestamp`).
const REGISTRY_UNSET = 1, REGISTRY_TRACKING = 2;
function restampRegistries(root, match, registry, elementsOnly) {
  dom.ceRestamp(nidOf(root), match, registryCodeOf(registry), registry ?? null, elementsOnly);
}
// What an adopt is, to the engine (adopt.rs): of template contents (their node documents alone), into the same document,
// into another, or into another of another window registry.
const ADOPT_CONTENTS = 0, ADOPT_SAME = 1, ADOPT_CROSS = 2, ADOPT_CROSS_REGISTRY = 3;
// DOM adopting steps for `<template>`: when a template element changes
// documents its CONTENT adopts into the NEW document's associated inert
// template document — custom elements inside it get adoptedCallback like any
// adopted subtree. Recurses for templates nested in the content (whose target
// inert document is the same one — an inert document is its own).
function adoptTemplateContentInto(tc, dest, oldDocFallback) {
  const tdest = inertTemplateDocFor(dest);
  const told  = nodeDocumentOf(tc) || oldDocFallback;
  if (told === tdest) return;
  // (…each node's node document the engine's to set, adopt.rs — its registry, the contents', as it is — and a template's
  // contents among them adopted the same way)
  for (const t of dom.adoptInto(nidOf(tc), tdest, ADOPT_CONTENTS, 0)) {
    const contents = templateContentsOf(t);
    if (contents) adoptTemplateContentInto(contents, tdest, told);
  }
  fireCEAdopted(tc, told, tdest);
}

// DOM §4.2.3's mutation algorithms — "insert", "remove", "replace", "replace all" — are one change of a parent's
// children, the engine's (mutation.rs `change_children`): the children `removing` names taken out — one (remove,
// replace), every one (`ALL_CHILDREN`: replace all) or none (null: insert) — and `nodes` (out of any fragment already:
// `nodesOf`) inserted before `child` (null: last), in the order the algorithms write them, the bindings' steps in its
// course called back where they fall (`CHANGE_STEPS`), and those it ends with taken as it returns (`changeFinished`).
// Each node is adopted into the parent's document first — a replacement's before the child is removed (DOM "replace"
// step 6, before 7); replace all's after the children are (its insertion's step 6.1), the engine's to call for. `parsed`
// — what a markup setter's fragment parse made — has its custom elements' upgrades enqueued before anything else, as its
// parse's "create an element" enqueued them: they run ahead of the removed children's disconnections. The removed nodes;
// a NotFoundError where the child to remove is none of the parent's, or the reference child of a replacement was taken
// out by the removal's own steps (a frame's unload; its removal standing).
const ALL_CHILDREN = {};
function changeChildren(parent, removing, nodes, child, parsed = false) {
  if (parsed) {
    for (let i = 0; i < nodes.length; i++) ceEnqueueUpgradesIn(nodes[i]);
  }
  const all = removing === ALL_CHILDREN;
  if (!all) adoptAllIntoParent(parent, nodes);
  const answer = changeChildrenOf(parent, removing === null ? -1 : all ? -2 : nidOf(removing), nodes,
    child === null ? -1 : nidOf(child), all && nodes.some((n) => needsAdopting(parent, n)), CHANGE_STEPS);
  if (answer === REMOVED_NOT_A_CHILD) {
    throw new DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
  }
  const flags = dom.changeFlags[0];
  const removed = answer ?? NO_NODES, added = (flags & CHANGE_REFUSED) !== 0 ? NO_NODES : nodes;
  if (removed.length !== 0 || added.length !== 0) changeFinished(parent, added, removed, flags, all);
  if ((flags & CHANGE_REFUSED) !== 0) {
    throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
  }
  return removed;
}
// (…mutation.rs: `REMOVED_NOT_A_CHILD`, and the flags a change returns with — `CHANGE_*`)
const REMOVED_NOT_A_CHILD = 1, CHANGE_CONNECTED = 1, CHANGE_REFUSED = 2, CHANGE_ASKS_RESET = 4, CHANGE_PICTURE_SOURCES = 8;
function adoptAllIntoParent(parent, nodes) {
  for (let i = 0; i < nodes.length; i++) adoptIntoParent(parent, nodes[i]);
}
// The bindings' steps in the course of a change of children, by the index the engine calls them by (mutation.rs
// `STEP_*`) — each only where it has something to do.
export const CHANGE_STEPS = [
  adoptAllIntoParent,
  shadowHostJoined,
  // (…a removed subtree's frames, their browsing contexts discarded)
  (frames) => { for (let i = 0; i < frames.length; i++) discardBrowsingContext(frames[i]); },
  // (…the select a removal asked for a reset, and the options it changed: its `<selectedcontent>` following at the next
  // microtask — it shows the removed option's content until then, selectedcontent-insertion-removal)
  (select, changed) => resetAnswered(select, changed, true),
  runSourceInsertionStep
];
// What a change of children ends with, the record made: what the engine's own steps did that the bindings hear of (a
// slot signaled, an observer given a transient registration, an element's state changed, the observations and the
// cascade a change asks for), the removed subtrees disconnected — or, out of no connected tree, a form-associated
// custom element's form state reconciled — and the inserted ones' insertion steps, an outer <script>'s children changed
// steps, their connection steps, and an option's post-connection steps, after the connection walk
// (selectedcontent-insertion-removal: a script inserted with it sees the old selection's content). A `<select>` rebuilt
// wholesale (`select.innerHTML = …`, a Stimulus / jQuery refresh) initialises and reconciles its options, the implicit
// default landing even on a detached or multiple one; any other insertion asks for a reset once over the batch — the
// last inserted selected option wins, not the first.
function changeFinished(parent, added, removed, flags, all) {
  const connected = (flags & CHANGE_CONNECTED) !== 0;
  engineWritten();
  if (connected) for (let i = 0; i < removed.length; i++) fireCEDisconnect(removed[i]);
  else for (let i = 0; i < removed.length; i++) resetFormStateIn(removed[i]);
  if (formNamingCustoms) idsChanged(parent);
  // (…a `<picture>`'s `<source>` inserted or removed: each of its images' source selected again)
  if ((flags & CHANGE_PICTURE_SOURCES) !== 0) {
    for (const img of childNodesOf(parent)) if (isHtml(img, 'img')) { try { loadImageResource(img); } catch (_) {} }
  }
  if (added.length === 0) return;
  insertionSteps(added);
  if (isScriptElement(parent)) globalThis.__csimPrepareScript(parent);
  if (connected) for (let i = 0; i < added.length; i++) globalThis.__csimFireCEConnect(added[i]);
  else for (let i = 0; i < added.length; i++) resetFormStateIn(added[i]);
  if (all && isHtml(parent, 'select')) finalizeSelectOptions(parent);
  else if ((flags & CHANGE_ASKS_RESET) !== 0) askForResetBatch(parent, added);
}
// The changes of children one of the engine's own algorithms made (mutation.rs `changes_value`) finished, in order —
// `made[at]` their count, each `[parent, added, removed, flags]` after it — and what else it wrote taken; the index
// past them.
export function finishChanges(made, at) {
  const end = at + 1 + 4 * made[at];
  for (let i = at + 1; i < end; i += 4) changeFinished(made[i], made[i + 1], made[i + 2], made[i + 3], false);
  engineWritten();
  return end;
}
// The selection's anchor and focus as the engine's edits take them — its range's ends, a shadow tree's as they are,
// ordered by its direction — or none where it has no range. `doc`'s, a document of this realm (selection.js
// `selectionIn`), where one is named.
function selectionEnds(doc) {
  const r = globalThis.__csimSelectionRange(doc);
  if (!r) return null;
  const [startNode, startOffset] = rangeStart(r), [endNode, endOffset] = rangeEnd(r);
  const start = [boundaryNid(startNode), startOffset], end = [boundaryNid(endNode), endOffset];
  return globalThis.__csimSelectionBackward(doc) ? [...end, ...start] : [...start, ...end];
}
// Backspace / Delete in the editing host the selection is in (editing_delete.rs `editDelete`): its range, or a step from
// its caret — a character's or a word's, back or `forward` — deleted, what that changed finished, and the caret where
// the engine says. Whether anything was deleted (none: no `input`).
export function deleteInEditingHost(forward, word, doc = globalThis.document) {
  const ends = selectionEnds(doc);
  if (!ends) return false;
  const made = dom.editDelete(...ends, forward, word, CHANGE_STEPS);
  if (made === undefined) return false;
  finishChanges(made, 2);
  globalThis.__csimCollapseSelection(made[0], made[1], doc);
  // (…a selectionchange however the caret came there: the engine's deletion moved the selection's range with it already)
  globalThis.__csimScheduleSelectionChange(doc);
  return true;
}
// What an insertion in an editing host inserts (editing_insert.rs `editInsert`): text, a line break, a paragraph's break.
export const EDIT_TEXT = 0, EDIT_LINE_BREAK = 1, EDIT_PARAGRAPH = 2;
// Typing, Enter and Shift+Enter in the editing host the selection is in, and execCommand's insertions
// (editing_insert.rs `editInsert`): the selection's contents deleted, `text` (`EDIT_TEXT`: its lines, a paragraph's
// break between them — nothing at all for none), a line break or a paragraph's break inserted at the caret, the cloning
// steps of the elements a split copied run, what that changed finished, and the caret where the engine says. Whether
// anything was inserted.
export function insertInEditingHost(kind, text = '', doc = globalThis.document) {
  const ends = selectionEnds(doc);
  if (!ends) return false;
  const made = dom.editInsert(...ends, kind, text, CHANGE_STEPS);
  if (made === undefined) return false;
  const copies = 3 + 3 * made[2];
  for (let i = 3; i < copies; i += 3) bindingsCloningSteps(made[i], made[i + 1], made[i + 2]);
  finishChanges(made, copies);
  throwCloneException();
  globalThis.__csimCollapseSelection(made[0], made[1], doc);
  globalThis.__csimScheduleSelectionChange(doc);
  return true;
}
// (…the WPT testdriver's key actions too, which type and press Enter as send_keys does)
hostSteps.insertInEditingHost = insertInEditingHost;
// DOM "replace" of `parent`'s child `old` with `nodes`: what followed it, past the nodes themselves.
function replaceNode(parent, old, nodes, parsed = false) {
  let ref = nextSiblingOf(old);
  while (ref !== null && nodes.includes(ref)) ref = nextSiblingOf(ref);
  changeChildren(parent, old, nodes, ref, parsed);
}
// The nodes inserting `node` inserts: a fragment's children — taken out of it, a change of its children with a record of
// its own (DOM "insert" step 3) — or itself; none for null.
function nodesOf(node) {
  if (node === null) return NO_NODES;
  if (nodeTypeOf(node) !== NODE_FRAGMENT) return [node];
  return changeChildren(node, ALL_CHILDREN, NO_NODES, null);
}
const NO_NODES = [];

// WebIDL: appendChild/insertBefore/replaceChild take non-nullable Node
// arguments, so a non-Node (null, undefined, a plain object) is a TypeError
// *before* the algorithm runs. Realm-safe: a duck-typed numeric nodeType is
// enough (avoids cross-document `instanceof` pitfalls).
function assertNodeArg(value) {
  if (value == null || typeof nodeTypeOf(value) !== 'number') {
    throw new TypeError("Argument is not an object that implements Node");
  }
}

// HTML "to get the list of options" for a `<select>` — the engine's (validity.rs `list_of_options`): its option
// descendants in tree order past transparent wrappers (a customizable select's `<div>`) and one level of `<optgroup>`,
// none under an `<hr>`, a `<datalist>`, a nested `<optgroup>` or a nested `<select>`.
export function listOfOptions(select) {
  return dom.listOfOptions(nidOf(select));
}

// The first element in `node`'s tree — its root's, a shadow root's, a disconnected subtree's — whose ID `id` is (none
// for '', which is no ID): what an `<input>`'s `list` and `filter` name.
export function elementInTreeById(node, id) {
  return findById(relativeOf(node, RELATIVE_ROOT), id);
}
// The `<datalist>` (or `<select>`) a combobox `<input>` points at via `filter` / `list` — the engine's (combobox.rs).
const comboboxListFor = (input) => dom.comboboxList(nidOf(input));

// Whether an `<input>`'s `list` attribute (datalist suggestions) applies: it has one, and its type takes one.
export function inputSupportsList(input) {
  return input && isHtml(input, 'input') && attrsOf(input).list != null && inputHas(input, INPUT_LIST);
}

// open-ui customizable combobox: focusing (or ArrowDown on) an `<input list>` whose
// computed `appearance` is `base` shows the associated `<datalist>` as a popover.
// Fires a cancelable `beforetoggle` first; a listener that cancels it, throws, or
// disconnects the datalist suppresses the show (customizable-combobox-popover-
// exception). Otherwise the datalist's popover-open state (STATE_POPOVER_OPEN) flips (→ `:popover-open`) and a
// `toggle` event fires. The `appearance:base` gate keeps an ordinary `<input list>`
// (native dropdown) from ever opening its datalist into the light DOM.
export function showComboboxDatalist(input) {
  if (!inputSupportsList(input)) return;
  const dl = comboboxListFor(input);
  if (!dl || !isHtml(dl, 'datalist') || hasState(dl, STATE_POPOVER_OPEN)) return;
  if (declaredValue(input, 'appearance') !== 'base') return;
  // Cancelled, or the listener detached the datalist (showing a disconnected popover
  // throws per spec) → the popover does not open.
  if (!fireBeforeToggle(dl, true) || hasState(dl, STATE_POPOVER_OPEN) || !isConnected(dl)) return;
  setStateBit(dl, STATE_POPOVER_OPEN, true);
  queueToggleTask(dl, 'closed', 'open');
}

// Close the combobox datalist popover when its `<input>` loses focus (the light-
// dismiss counterpart of showComboboxDatalist) — fires beforetoggle/toggle closed.
export function hideComboboxDatalist(input) {
  if (!input || !isHtml(input, 'input') || attrsOf(input).list == null) return;
  const dl = comboboxListFor(input);
  if (!dl || !isHtml(dl, 'datalist') || !hasState(dl, STATE_POPOVER_OPEN)) return;
  fireBeforeToggle(dl, false);
  setStateBit(dl, STATE_POPOVER_OPEN, false);
  queueToggleTask(dl, 'open', 'closed');
}

// open-ui customizable combobox filtering (tentative): the input's value set fires a cancelable `beforefilter` at it,
// and unless that is canceled — the page keeping the filtering it had — its list's options are filtered by the value
// (combobox.rs `filter_combobox`: `:filtered`, which the UA sheet hides).
export function runComboboxFilter(input) {
  const list = comboboxListFor(input);
  if (list === null) return;
  const ev = new Event('beforefilter', { __proto__: null, bubbles: false, cancelable: true });
  dispatchEvent(input, ev);
  if (!eventState(ev).canceled) dom.filterCombobox(nidOf(input), nidOf(list));
}

// ── DOMTokenList ─────────────────────────────────────────────────
// https://dom.spec.whatwg.org/#interface-domtokenlist — the live token
// list behind classList / relList / sandbox / etc. Backed by (element,
// attribute local name): the engine reads the token set from the arena's
// attribute and answers what an edit writes (token_list.rs); the write
// round-trips through setAttribute so MutationObserver / cascade / CE
// callbacks see it.

const TOKEN_ADD = 0, TOKEN_REMOVE = 1, TOKEN_TOGGLE = 2, TOKEN_REPLACE = 3;
// DOMTokenList (DOM §7.1): its binding generated from its IDL (generated/bindings.js); what each member does, here —
// over the element's attribute, whose token set the engine keeps (token_list.rs). Its state, in its slots: the element
// and the attribute's name.
const tokenListImpl = {
  init(list, el, attr) {
    list.el   = el;
    list.attr = attr;
  },
  get_length(list) { return dom.tokenListLength(nidOf(list.el), list.attr); },
  item(list, index) { return dom.tokenListItem(nidOf(list.el), list.attr, index); },
  contains(list, token) { return dom.tokenListContains(nidOf(list.el), list.attr, token); },
  add(list, tokens) { tokenListEdit(list, TOKEN_ADD, tokens, undefined, 'add'); },
  remove(list, tokens) { tokenListEdit(list, TOKEN_REMOVE, tokens, undefined, 'remove'); },
  toggle: (list, token, force) => tokenListEdit(list, TOKEN_TOGGLE, [token], force, 'toggle'),
  replace: (list, token, newToken) => tokenListEdit(list, TOKEN_REPLACE, [token, newToken], undefined, 'replace'),
  // Per spec, supports(token) throws only when the associated attribute
  // defines no supported tokens (e.g. class); for rel / sandbox it returns
  // whether the ASCII-lowercased token is in the supported set — the engine's
  // (token_list.rs `supported_tokens`).
  supports(list, token) {
    const supported = dom.tokenListSupports(nidOf(list.el), list.attr, token);
    if (supported === undefined) {
      throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.");
    }
    return supported;
  },
  get_value(list) { return attrsOf(list.el)[list.attr] || ''; },
  set_value(list, v) { setAttributeNS(list.el, null, list.attr, v); }
};
// An edit of the set (`TOKEN_ADD` …) by `method`: the update steps' write, where they write, and the method's result —
// or the exception of a token the engine refuses (token_list.rs `refusal`: an empty one, else one with ASCII whitespace;
// `replace`'s both for emptiness first, so `replace(" ", "")` is a SyntaxError).
const EMPTY_TOKEN = 1;
function tokenListEdit(list, op, tokens, force, method) {
  const [result, value, refused, index] = dom.tokenListEdit(nidOf(list.el), list.attr, op, tokens, force);
  if (refused !== undefined) {
    const prefix = `Failed to execute '${method}' on 'DOMTokenList': `;
    if (refused === EMPTY_TOKEN) throw new DOMException(prefix + 'The token provided must not be empty.', 'SyntaxError');
    const spaced = method === 'replace' ? 'The token provided contains HTML space characters.'
      : `The token provided ('${tokens[index]}') contains HTML space characters, which are not valid in tokens.`;
    throw new DOMException(prefix + spaced, 'InvalidCharacterError');
  }
  if (value !== undefined) setAttributeNS(list.el, null, list.attr, value);   // (…the attribute in no namespace)
  return result;
}
const DOMTokenListBinding = defineDOMTokenList(tokenListImpl);
globalThis.DOMTokenList = DOMTokenListBinding.interface;

// An element's token list for an attribute — one per (element, attribute), so the IDL `[SameObject]` identity holds.
export function tokenListFor(el, attr) {
  const cache = sameObject(el, 'tokenLists', () => ({}));
  return cache[attr] || (cache[attr] = DOMTokenListBinding.create(el, attr));
}

// ── Namespaces + createElementNS validation ────────────
// HTML_NS / SVG_NS imported from constants.js (shared with form-helpers /
// dom-class-aliases); the XML / XMLNS namespaces are local to this module.

// SVGAnimatedString (SVG 2 §4.6.6), generated from its IDL: an attribute reflected as a base value and an animated one
// — which, with no SMIL animation modelled, is the base value. Made by the platform alone.
const svgBaseVal = (s) => getAttributeNS(s.el, null, s.attr) ?? '';
const svgAnimatedString = defineSVGAnimatedString({
  init(s, el, attr) { s.el = el; s.attr = attr; },
  get_baseVal: svgBaseVal,
  set_baseVal(s, v) { setAttributeNS(s.el, null, s.attr, v); },
  get_animVal: svgBaseVal
});
globalThis.SVGAnimatedString = svgAnimatedString.interface;

// DOMStringMap (HTML §3.2.6.6), generated from its IDL: an element's `dataset`, a legacy platform object with named
// properties — a Proxy over an object of this prototype (`datasetOf`), whose traps answer them and whose slots hold
// its element. (…made by the platform alone: the interface has no constructor)
const DOMStringMap = defineDOMStringMap({});
globalThis.DOMStringMap = DOMStringMap;

// DOM's names (§1.5), the engine's (namespaces.rs): a valid element local name, attribute local name, doctype name.
const isValidElementLocalName = (name) => dom.validName(0, name);
const isValidAttributeLocalName = (name) => dom.validName(1, name);
const isValidDoctypeName = (name) => dom.validName(2, name);

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

// The node a namespace lookup starts from in the engine (namespaces.rs): an Attr's element, any other node itself.
function namespaceLookupNid(node) {
  const n = nodeTypeOf(node) === NODE_ATTRIBUTE ? attrOwnerOf(node) : node;
  return n ? nidOf(n) : null;
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

// An element's attribute list (DOM §4.9) is the engine's (attributes.rs): an attribute found by its qualified name — an
// HTML element's in an HTML document ASCII-lowercased — or by its namespace and local name, as the key the arena stores
// it under (its attribute store's key: its qualified name, or that name numbered where two share it); and every change of it made
// there with "handle attribute changes" — the record queued, the reaction enqueued, an input's type change — what is
// left of the attribute change steps the bindings' (`attributeChangeSteps`), by the steps the change answers.
const attrKeyNS = (el, namespace, localName) => dom.attrKey(el, BY_NS, namespace, localName);
// (…how a change is made: by `setAttribute`, `setAttributeNS`, the null namespace's value set — a dataset's —, the value
// under a key — an Attr's —, an Attr bound, and the removals by qualified name, by namespace, by key)
const ATTR_SET = 0, ATTR_SET_NS = 1, ATTR_SET_NULL_NS = 2, ATTR_SET_KEY = 3, ATTR_BIND = 4;
const ATTR_REMOVE = 5, ATTR_REMOVE_NS = 6, ATTR_REMOVE_KEY = 7;
// (…a name `setAttribute` refused: not a valid attribute name — `setAttributeNS`'s, `validateAndExtract`'s errors)
const INVALID_ATTRIBUTE_NAME = 7;
// The change `how` makes of `el`'s attributes, made: `[steps, key, oldValue, localName]`, or null where it made none (a
// removal of an attribute it has not). A name refused throws.
function changeAttribute(el, how, a, b, c, d) {
  const made = dom.attrWrite(el, how, a, b, c, d);
  if (made === undefined) return null;
  if (typeof made !== 'number') return made;
  if (made === INVALID_ATTRIBUTE_NAME) throw new DOMException("'" + a + "' is not a valid attribute name.", 'InvalidCharacterError');
  throw new DOMException(...EXTRACT_ERRORS[made]);
}
// …and with the bindings' share of handling it run.
function writeAttribute(el, how, a, b, c, d) {
  const made = changeAttribute(el, how, a, b, c, d);
  if (made !== null) attributeChanged(el, made);
}

// DOM "validate and extract" — the engine's (namespaces.rs `validate_and_extract`): `qualifiedName`'s namespace, prefix
// and local name in `namespace`, for an element or, with `context` 'attribute', an attribute; else the DOMException
// saying why not.
const EXTRACT_ERRORS = [
  null,
  ['The qualified name contains an invalid prefix.', 'InvalidCharacterError'],
  ['The local name is not a valid name.', 'InvalidCharacterError'],
  ['A namespace prefix was given but no namespace.', 'NamespaceError'],
  ['The "xml" prefix requires the XML namespace.', 'NamespaceError'],
  ['The "xmlns" name requires the XMLNS namespace.', 'NamespaceError'],
  ['The XMLNS namespace is reserved for the xmlns name.', 'NamespaceError']
];
function validateAndExtract(namespace, qualifiedName, context) {
  const answer = dom.validateAndExtract(namespace, qualifiedName, context === 'attribute');
  if (typeof answer === 'number') throw new DOMException(...EXTRACT_ERRORS[answer]);
  return { namespace: answer[0], prefix: answer[1], localName: answer[2] };
}

// ChildNode (DOM §4.2.8) and NonDocumentTypeChildNode's members, for the node they are called on: CharacterData's
// (generated) and Element's and DocumentType's. `nodes` are nodes or strings, a string a Text node to be.
function childNodeBefore(child, nodes) {
  const parent = parentOrHostOf(child);
  if (!parent) return;
  // viable previous sibling: first preceding sibling not itself being inserted.
  let ref = previousSiblingOf(child);
  while (ref && nodes.indexOf(ref) !== -1) ref = previousSiblingOf(ref);
  const node = convertNodesIntoNode(nodes, child);
  insertBefore(parent, node, ref ? nextSiblingOf(ref) : relativeOf(parent, RELATIVE_FIRST_CHILD));
}
function childNodeAfter(child, nodes) {
  const parent = parentOrHostOf(child);
  if (!parent) return;
  // viable next sibling: first following sibling not itself being inserted.
  let ref = nextSiblingOf(child);
  while (ref && nodes.indexOf(ref) !== -1) ref = nextSiblingOf(ref);
  insertBefore(parent, convertNodesIntoNode(nodes, child), ref);
}
function childNodeReplaceWith(child, nodes) {
  const parent = parentOrHostOf(child);
  if (!parent) return;
  let ref = nextSiblingOf(child);
  while (ref && nodes.indexOf(ref) !== -1) ref = nextSiblingOf(ref);
  const node = convertNodesIntoNode(nodes, child);
  // Replace the child with the node (DOM "replace": the child removed, then the node — a fragment's children —
  // inserted, one record). If it was detached while converting (a node arg adopted it), fall back to the viable next
  // sibling.
  if (parentOrHostOf(child) === parent) replaceChild(parent, node, child);
  else insertBefore(parent, node, ref);
}
export function childNodeRemove(child) {
  const parent = parentNodeOf(child);
  if (parent) removeChild(parent, child);
}
// …the element siblings before and after it (a text or comment sibling skipped): the engine's to name.
const previousElementSiblingOf = (child) => relativeOf(child, RELATIVE_PREVIOUS_ELEMENT);
const nextElementSiblingOf = (child) => relativeOf(child, RELATIVE_NEXT_ELEMENT);

// ParentNode (DOM §4.2.6)'s members, for the parent they are called on: DocumentFragment's (generated), Element's and
// Document's. `nodes` are nodes or strings, a string a Text node to be.
function parentNodePrepend(parent, nodes) {
  insertBefore(parent, convertNodesIntoNode(nodes, parent), childAtOf(parent, 0));
}
function parentNodeAppend(parent, nodes) {
  appendChild(parent, convertNodesIntoNode(nodes, parent));
}
// …"replace all": 1. convert nodes (moving any from their old parents, which fires removal records THERE); 2. validate
// the result against the parent (a Document with an existing element child rejects another element, etc.) BEFORE
// touching its children; 3. detach its current children and insert the new ones, queueing a SINGLE childList record
// (removed = all old, added = all new) — not one per child.
function parentNodeReplaceChildren(parent, nodes) {
  const node = convertNodesIntoNode(nodes, parent);
  ensurePreInsertionValidity(node, parent, null);
  replaceAllChildren(parent, node);
}
// …its children that are elements, a LIVE HTMLCollection (`item` / `namedItem`, the named getter): one per parent, so
// `el.children === el.children` and a hot traversal reads it in O(1); its Proxy re-runs the filter once an edge of the
// tree has changed (`currentEdgeGen`), and not for an attribute written to each child in turn.
function childrenOf(parent) {
  return sameObject(parent, 'children', () => liveHTMLCollection(() => childElementsOf(parent), currentEdgeGen));
}
// …and the first, the last, and how many — the engine's to name, rather than `children`'s, so a hot traversal
// allocates no array to read one.
const firstElementChildOf = (parent) => relativeOf(parent, RELATIVE_FIRST_ELEMENT);
const lastElementChildOf = (parent) => relativeOf(parent, RELATIVE_LAST_ELEMENT);
const childElementCountOf = (parent) => childCountOf(parent, true);

// A Node is an EventTarget (DOM §4.4), but its object is the engine's: made by `__dom.NodeBase` (node_handle.rs), a
// wrapper of a handle on V8's C++ heap that frees the node's slot when V8 collects it — for the class being constructed,
// so it is allocated once, reading `new.target.prototype` once (custom-elements/HTMLElement-constructor).
// Its type is given by the class constructing it (`nodeObject(new.target, NODE_TEXT)`) and fixed, its identity's
// (node-identity.js): `nodeType` is Node.prototype's read-only accessor over it, so the type its members' brand checks
// read is the one it was made with (`x.nodeType = 1` had made a text node no CharacterData).
// A node's object, of its interface's `newTarget`: what the constructors of the node interfaces make it by, no `super`, so nothing
// of a page's put in their [[Prototype]] chains is called (webidl.js `createObject`).
function nodeObject(newTarget, type, ...none) {
  return stampNode(reflectConstruct(dom.NodeBase, none, newTarget), type);
}
// …an element's or an Attr's, with its name.
function namedNodeObject(newTarget, type, ns, prefix, localName, tag, ...none) {
  return stampNamedNode(reflectConstruct(dom.NodeBase, none, newTarget), type, ns, prefix, localName, tag);
}
class Node extends EventTarget {
  constructor() { throw new TypeError("Failed to construct 'Node': Illegal constructor"); }
}
// A node's own steps, which its members and the driver's code call alike: functions of the node — by its type where the
// kinds answer apart — and no member of a prototype's, which a page would see and could replace.
// Its node value (DOM): an Attr's value, character data's data, null for the rest, whose setter does nothing.
export function nodeValueOf(node) {
  switch (nodeTypeOf(node)) {
    case NODE_ATTRIBUTE: return attrValueOf(node);
    case NODE_TEXT: case NODE_CDATA: case NODE_COMMENT: case NODE_PI: return dataOf(node);
    default: return null;
  }
}
// (…nullable: both null and undefined the empty string)
function setNodeValue(node, value) {
  switch (nodeTypeOf(node)) {
    case NODE_ATTRIBUTE: setAttrValue(node, value); break;
    case NODE_TEXT: case NODE_CDATA: case NODE_COMMENT: case NODE_PI: setData(node, value == null ? '' : String(value)); break;
  }
}
// Its text content (DOM): its descendant text content — its Text descendants' data, CDATA sections' too, in tree order —
// character data's own data, null for a document or a doctype: the engine's (traversal.rs `text_content`), but an Attr's,
// its value, which the bindings hold.
export function textContentOf(node) {
  const text = dom.textContent(node);
  return text === false ? attrValueOf(node) : text;
}
// …and its setting: an element's or a fragment's children replaced by one Text node — DOM "string replace all", none for
// the empty string: one childList record (PM/Tiptap's domchange observer reads it), the removed subtree's removing steps
// and disconnections — character data's data and an Attr's value set, nothing for a document or a doctype.
export function setTextContent(node, value) {
  const text = String(value == null ? '' : value);
  switch (nodeTypeOf(node)) {
    case NODE_ELEMENT: case NODE_FRAGMENT:
      // (…made in this node's document, which adopts nothing then — and not through `createTextNode`, which a page may
      // have replaced)
      replaceAllChildren(node, text.length > 0 ? nodeMadeFor(nodeDocumentOf(node), Text, text, undefined, node) : null);
      break;
    case NODE_ATTRIBUTE: setAttrValue(node, text); break;
    case NODE_TEXT: case NODE_CDATA: case NODE_COMMENT: case NODE_PI: setData(node, text); break;
  }
}
// `Node.baseURI`: its node document's document base URL — a document's its own, honouring its first `<base href>` (else
// its URL) — the realm's URL where it has none.
export function baseURIOf(node) {
  if (nodeTypeOf(node) === NODE_DOC) return documentBaseURL(node);
  const doc = nodeDocumentOf(node);
  return doc ? documentBaseURL(doc) : realmURL() || 'about:blank';
}
// `Node.contains(other)`: whether `other` is an inclusive descendant (DOM §4.2.1) of `node` — its tree's, not a shadow
// tree's under it, which no `contains` crosses (Chrome: `host.contains(nodeInItsShadow)` is false): the engine's answer
// (a fast call) — a generated box's holder answering as its element, an Attr, in no tree, only itself, and no node none.
// (jQuery 3.x's `isAttached(elem)` is `jQuery.contains(elem.ownerDocument, elem)`, `document.contains(elem)`.)
export function nodeContains(node, other) {
  if (node == null || other == null) return false;
  if (other === node) return true;
  if (pseudoOf(other) !== undefined) other = originOf(other);
  return dom.contains(nidOf(node), nidOf(other));
}
// A copy of a node the engine does not clone — a document, a doctype or an attribute — with nothing of its own copied
// but what its constructor takes.
function cloneShell(node) {
  switch (nodeTypeOf(node)) {
    case NODE_ATTRIBUTE: return new Attr(PLATFORM, localNameOf(node), namespaceOf(node), prefixOf(node), attrValueOf(node), nodeDocumentOf(node));
    case NODE_DOCTYPE: return new DocumentType(PLATFORM, doctypeField(node, 0), doctypeField(node, 1), doctypeField(node, 2), nodeDocumentOf(node));
    case NODE_DOC: return cloneDocumentShell(node);
  }
}
// DOM "get the root", the engine's: its tree's root (a shadow root the root of its own), or with `composed` its
// shadow-including root — an Attr, in no tree, its own.
function rootNodeOf(node, options) {
  return relativeOf(node, options && options.composed ? RELATIVE_SHADOW_INCLUDING_ROOT : RELATIVE_ROOT) ?? node;
}
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
function isEqualNode(node, other) {
  if (other == null || nodeTypeOf(node) !== nodeTypeOf(other)) return false;
  // (…an Attr by its namespace, local name and value; any other node the engine's — traversal.rs `is_equal_node`)
  if (nodeTypeOf(node) === NODE_ATTRIBUTE) {
    return namespaceOf(node) === namespaceOf(other) && localNameOf(node) === localNameOf(other) && attrValueOf(node) === attrValueOf(other);
  }
  return dom.isEqualNode(nidOf(node), nidOf(other));
}
// Where `other` is against this node in tree order (DOM §4.4), the engine's (traversal.rs): an Attr goes as its
// element and its place in that element's attribute list. (Sizzle / Stimulus sort by it; idiomorph reads its
// CONTAINS / CONTAINED_BY bits.)
function compareDocumentPosition(node, other) {
  if (other === node) return 0;
  return dom.comparePosition(
    positionNode(other),
    positionAttrKey(other),
    boundaryNid(other),
    positionNode(node),
    positionAttrKey(node),
    boundaryNid(node)
  );
}
// Shallow / deep node cloning. jQuery probes feature support
// via `document.createElement('div').cloneNode(true).attachEvent`
// etc. before initialising, so this needs to work even on
// detached nodes. Cloned nodes copy attrs and (deep) clone
// children; listeners + custom-element state are intentionally
// *not* copied (matches HTML spec).
function cloneNode(node, deep, _skipUpgrade) {
  // DOM: cloning a shadow root directly is not allowed (a shadow root is
  // cloned only as part of cloning its clonable host) — throw NotSupportedError.
  if (isShadowRoot(node)) {
    throw new DOMException("Failed to execute 'cloneNode' on 'Node': ShadowRoot nodes are not clonable.", 'NotSupportedError');
  }
  // (…made by the node's own realm, whose objects the copies are: `makingRealmOf`)
  const realm = makingRealmOf(node);
  if (realm !== null) return inRealm(realm, 'cloneNode', node, deep, _skipUpgrade);
  const made = engineClone(node, deep);
  if (made !== undefined) {
    // (…importNode upgrades its own, the clone re-owned by the importing document first)
    if (!_skipUpgrade) upgradeCopies(made, 1);
    return made[0];
  }
  // (…a document, a doctype or an attribute: the bindings')
  const copy = cloneShell(node);
  // DOM "clone a node": the copy's node document is the source's — a document's own clone is its own.
  if (nodeTypeOf(copy) !== NODE_DOC) setNodeDocumentOf(copy, nodeDocumentOf(node));
  // (…a document's children, each the engine's clone, re-owned by the copy: ownerDocument drives tag-name casing,
  // createAttribute, the FrameController cross-document check — documentElement is derived from its children)
  if (deep && nodeTypeOf(copy) === NODE_DOC) {
    insertEdges(copy, childNodesOf(node).map((c) => cloneNode(c, true, true)), -1);
    for (const c of childNodesOf(copy)) setSubtreeDocumentOf(c, copy);
  }
  return copy;
}
// `Node.normalize()` per DOM spec — merge adjacent exclusive-Text
// children (concatenating their data), drop empty Text nodes, then
// recurse into element children. Sanitizers / contenteditable
// reconcilers call it to coalesce text runs after repeated edits.
// (…the engine's whole: character_data.rs `normalize`)
function normalizeNode(node) {
  finishChanges(dom.normalize(node, CHANGE_STEPS), 0);
}
// https://dom.spec.whatwg.org/#dom-node-lookupnamespaceuri
// Namespace lookups (DOM §4.4) are the engine's (namespaces.rs).
function nodeLookupNamespaceURI(node, prefix) {
  return dom.locateNamespace(namespaceLookupNid(node), (prefix == null || prefix === '') ? null : String(prefix));
}
// https://dom.spec.whatwg.org/#dom-node-isdefaultnamespace
function nodeIsDefaultNamespace(node, namespace) {
  const want = (namespace == null || namespace === '') ? null : String(namespace);
  return dom.locateNamespace(namespaceLookupNid(node), null) === want;
}
// https://dom.spec.whatwg.org/#dom-node-lookupprefix
function nodeLookupPrefix(node, namespace) {
  if (namespace == null || namespace === '') return null;
  return dom.locatePrefix(namespaceLookupNid(node), String(namespace));
}
// DOM "replace all" with `node` (a fragment's children, or none for null) — replaceChildren's and the textContent
// setter's.
function replaceAllChildren(parent, node) {
  changeChildren(parent, ALL_CHILDREN, nodesOf(node), null);
}
export function appendChild(node, child) {
  assertNodeArg(child);
  ensurePreInsertionValidity(child, node, null);
  return appendValid(node, child);
}
// DOM "append" of `child`, its pre-insertion validity ensured.
function appendValid(node, child) {
  changeChildren(node, null, nodesOf(child), null);
  return child;
}
function removeChild(node, child) {
  assertNodeArg(child);
  changeChildren(node, child, NO_NODES, null);
  return child;
}
export function insertBefore(node, child, ref) {
  assertNodeArg(child);
  if (ref != null) assertNodeArg(ref);
  ensurePreInsertionValidity(child, node, ref);
  // DOM pre-insert step 3: a reference child that IS the node is its next sibling — the node back in its own place.
  if (ref === child) ref = nextSiblingOf(child);
  changeChildren(node, null, nodesOf(child), ref ?? null);
  return child;
}
// https://dom.spec.whatwg.org/#concept-node-replace — same validity as pre-insertion but the document-child constraints
// exclude `old` (the node being replaced), and `old` must itself be a child (NotFoundError).
export function replaceChild(node, neu, old) {
  assertNodeArg(neu);
  assertNodeArg(old);
  validateInsertion(neu, node, old, true);
  // Replacing a node with itself: `old` is removed and inserted back before its former next sibling — two mutations,
  // a removal then an addition, which observers see (DOM "replace" steps 7/11/13 with node === child).
  if (neu === old) {
    const ref = nextSiblingOf(old);
    removeChild(node, old);
    insertBefore(node, neu, ref);
    return old;
  }
  replaceNode(node, old, nodesOf(neu));
  return old;
}

// Node.prototype, every realm's, known by an identity of no node's (node-identity.js `markNodePrototype`): what tells
// EventTarget's members an object that inherits from it, and so is no EventTarget of its own (events.js
// `isEventTarget`) — no key a page could read or forge.
markNodePrototype(Node.prototype);
// What IS a node — any realm's, not an object inheriting from one (`Object.create(textNode)`): what an IDL brand check and a
// conversion to an interface type take — its type is its own (node-identity.js `isNodeObject`).
registerInterface('Node', isNodeObject);
// Node's members (generated/bindings.js): a node's own steps, by its type where the kinds answer apart (`nodeValueOf`,
// `textContentOf`, … — a Document's ownerDocument is null, a shadow root has no parentNode).
// (…an accessor of the tree's checks its `this` itself, in its answer: `selfChecked`, gen_bindings.mjs)
function illegalInvocation() {
  throw new TypeError('Illegal invocation');
}
// …the engine's, from the node's handle, which nothing but a node's object has: undefined for anything else.
function relativeOfSelf(self, kind) {
  const found = dom.relativeNode(nodeArgOf(self), kind);
  return found === undefined ? illegalInvocation() : found;
}
installNode(Node, {
  get_nodeType: (self) => nodeObjectTypeOf(self) ?? illegalInvocation(),
  get_nodeName: nodeNameOf,
  get_baseURI: baseURIOf,
  get_isConnected: isConnected,
  get_ownerDocument: (node) => (nodeTypeOf(node) === NODE_DOC ? null : nodeDocumentOf(node)),
  getRootNode: rootNodeOf,
  // (…the tree's accessors the engine's to answer: `relativeOf`)
  get_parentNode: (self) => relativeOfSelf(self, RELATIVE_PARENT),
  get_parentElement: (self) => relativeOfSelf(self, RELATIVE_PARENT_ELEMENT),
  hasChildNodes: (node) => childCountOf(node, false) > 0,
  get_childNodes: (node) => sameObject(node, 'childNodes', childNodeList),
  get_firstChild: (self) => relativeOfSelf(self, RELATIVE_FIRST_CHILD),
  get_lastChild: (self) => relativeOfSelf(self, RELATIVE_LAST_CHILD),
  get_previousSibling: (self) => relativeOfSelf(self, RELATIVE_PREVIOUS),
  get_nextSibling: (self) => relativeOfSelf(self, RELATIVE_NEXT),
  // (…`DOMString?`: null is the empty string to a node whose value can be set)
  get_nodeValue: nodeValueOf,
  set_nodeValue(node, value) { setNodeValue(node, value === null ? '' : value); },
  // (…the engine's, from the node's handle — but an Attr's, its value, which the bindings hold)
  get_textContent(self) {
    const text = dom.textContent(self);
    return text === undefined ? illegalInvocation() : text === false ? attrValueOf(self) : text;
  },
  set_textContent(node, value) { setTextContent(node, value === null ? '' : value); },
  normalize: normalizeNode,
  cloneNode: (node, deep) => cloneNode(node, deep),
  isEqualNode,
  isSameNode: (node, other) => node === other,
  compareDocumentPosition,
  contains: nodeContains,
  lookupPrefix: nodeLookupPrefix,
  lookupNamespaceURI: nodeLookupNamespaceURI,
  isDefaultNamespace: nodeIsDefaultNamespace,
  insertBefore,
  appendChild,
  replaceChild,
  removeChild
});

// CharacterData (https://dom.spec.whatwg.org/#interface-characterdata) — the
// shared base of Text / Comment / CDATASection / ProcessingInstruction. Real
// class (not a Text alias) so the prototype chain is `Text`/`Comment` →
// `CharacterData` → `Node`, which `instanceof` and the WPT constructor tests
// require. Subclasses set their own `nodeType` + `nodeName`.
// (…of character data: `data` an `optional DOMString = ""` — undefined (no argument) "", anything else its constructor converted.
// None for the object of a node the engine made, whose data is the engine's.)
function characterDataObject(newTarget, data, type) {
  const self = nodeObject(newTarget, type);
  if (!makingEngineObject()) storeData(self, data === undefined ? '' : data);
  return self;
}
class CharacterData extends Node {
  constructor() { throw new TypeError("Failed to construct 'CharacterData': Illegal constructor"); }
}
// The character data, the engine's: the arena's, as the string the node's handle holds (native-query-shadow.js
// `dataOf`) — written by `storeData` and `appendData`, the two doors every write passes (the parser coalescing text,
// splitText, replaceData, a range extraction's clones…), which queue nothing.
function storeData(node, data) { dom.setData(node, data); }
// …an append sends only what it appends: the parser coalescing a long text and an `appendData` loop append chunk by
// chunk, and re-sending the whole string each time made both quadratic.
export function appendData(node, s) { dom.appendData(node, s); }
// DOM "replace data": `count` UTF-16 code units from `offset` replaced with `str` — the engine's whole
// (character_data.rs: the count clamped to the data, the record — always, even of a no-op like `appendData("")` — the
// live ranges, the data, the generations, a `<style>`'s block, an `<?xml-stylesheet?>`'s sheet), and then what the
// bindings take of it; an offset past the data an IndexSizeError, data longer than a string can be a RangeError — as
// V8's own string operations throw — before anything changed. A processing instruction's attributes are read from its
// data again when next asked for: a map it wrote that its data does not parse back to is gone.
function replaceData(node, offset, count, str) {
  const refused = dom.replaceData(node, offset, count, str);
  if (refused === OFFSET_PAST_DATA) {
    throw new DOMException('The offset is greater than the data length.', 'IndexSizeError');
  }
  if (refused === TOO_LONG) throw new RangeError('Invalid string length');
  engineWritten();
  if (nodeTypeOf(node) === NODE_PI) setPIAttributes(node, null, null);
}
// Setting `data` (or `nodeValue` / `textContent`, which proxy through here) is "replace data" over the whole node —
// even to the value it has: the live ranges inside collapse to 0, a `characterData` record is queued, and a `<style>`
// parent's block is updated (Chrome: a new sheet).
function setData(node, next) {
  replaceData(node, 0, dataOf(node).length, next);
}
// (…character_data.rs)
const OFFSET_PAST_DATA = 1, TOO_LONG = 2;
globalThis.CharacterData = CharacterData;

// The node document of a node a constructor made — `new Text()`, `new Comment()`, `new DocumentFragment()` — the current
// global object's associated Document (DOM: their constructor steps), none in a realm with no document (a worker's);
// one the engine made its own has its own already, and one the bindings make for a document (`nodeMadeFor`: a factory's, a
// converted string's) that document, written once.
// (…`engine` whether it is the engine's, asked before the node is registered, which ends the making)
let constructingFor;
function constructedInto(node, engine) {
  if (engine) return;
  const doc = constructingFor !== undefined ? constructingFor : globalThis.document;
  constructingFor = undefined;
  if (doc) setNodeDocumentOf(node, doc);
}
// …a `Ctor` node (`a`, `b` its constructor's arguments) the bindings make in `doc`.
// (…by the realm of the object it is made for — `doc`, or the node `by` a step of which makes it — that realm's `Ctor`,
// by name: `makingRealmOf`)
function nodeMadeFor(doc, Ctor, a, b, by = doc) {
  const realm = makingRealmOf(by);
  if (realm !== null) return inRealm(realm, 'nodeMadeFor', doc, Ctor.name, a, b);
  return constructedFor(doc, Ctor, a, b);
}
// (…by this realm, whichever realm `doc` is of)
function constructedFor(doc, Ctor, a, b) {
  constructingFor = doc;
  try { return new Ctor(a, b); } finally { constructingFor = undefined; }
}

// Text node (CharacterData subclass).
// (…of a Text or a CDATASection: to the arena that is text, which XML serializes as a CDATA section)
function textObject(newTarget, data, type) {
  const self = characterDataObject(newTarget, data, type);
  const engine = makingEngineObject();
  registerNativeNode(self);
  constructedInto(self, engine);
  return self;
}
class Text extends CharacterData {
  // (…a string as it is — the parser's and the factories' — anything else converted as its IDL says: `new Text(Symbol())`
  // a TypeError)
  constructor(data) {
    if (data !== undefined && typeof data !== 'string') data = convertTextArguments(arguments)[0];
    return textObject(new.target, data, NODE_TEXT);
  }
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
    if (data !== undefined && typeof data !== 'string') data = convertCommentArguments(arguments)[0];
    const self = characterDataObject(new.target, data, NODE_COMMENT);
    const engine = makingEngineObject();
    registerNativeNode(self);
    constructedInto(self, engine);
    return self;
  }
}
globalThis.Comment = Comment;

// CharacterData, Text and Comment's members: generated from their IDL onto these classes (generated/bindings.js), what
// each does here. A node of each is told by its type.
const CHARACTER_DATA_TYPES = new Set([NODE_TEXT, NODE_CDATA, NODE_PI, NODE_COMMENT]);
registerInterface('CharacterData', (o) => CHARACTER_DATA_TYPES.has(nodeObjectTypeOf(o)));
registerInterface('Text', (o) => { const type = nodeObjectTypeOf(o); return type === NODE_TEXT || type === NODE_CDATA; });
registerInterface('Comment', (o) => nodeObjectTypeOf(o) === NODE_COMMENT);
installCharacterData(CharacterData, {
  get_data: dataOf,
  set_data: setData,
  get_length(node) { return dataOf(node).length; },
  // (…offsets and counts are UTF-16 code units, JS string indexing)
  substringData(node, offset, count) {
    if (offset > dataOf(node).length) throw new DOMException('The offset is greater than the data length.', 'IndexSizeError');
    return dataOf(node).slice(offset, offset + count);   // slice clamps the end to the length
  },
  appendData(node, data) { replaceData(node, dataOf(node).length, 0, data); },
  insertData(node, offset, data) { replaceData(node, offset, 0, data); },
  deleteData(node, offset, count) { replaceData(node, offset, count, ''); },
  replaceData(node, offset, count, data) { replaceData(node, offset, count, data); },
  get_previousElementSibling: previousElementSiblingOf,
  get_nextElementSibling: nextElementSiblingOf,
  before: childNodeBefore,
  after: childNodeAfter,
  replaceWith: childNodeReplaceWith,
  remove: childNodeRemove
});
// DOM "split a Text node" — the engine's whole (character_data.rs `split_text`): the new node with the data past
// `offset`, inserted after this one, the live ranges split, the data cut; then what the insertion ends with, as a change
// of children's (`changeFinished`).
function splitTextNode(node, offset) {
  const made = dom.splitText(node, offset, CHANGE_STEPS);
  if (made === OFFSET_PAST_DATA) {
    throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
  }
  finishChanges(made, 1);
  return made[0];
}
installText(Text, {
  // Per DOM spec: split this text node into two at `offset`, keep the
  // prefix in `this`, return a new Text sibling holding the suffix
  // and inserted into the parent right after `this`. Discourse's
  // `HighlightedSearch` modifier calls splitText to wrap matched
  // substrings in `<span class="d-highlighted">`.
  // Discourse's `HighlightedSearch` wraps matches by it.
  splitText: (node, offset) => splitTextNode(node, offset),
  // DOM `Text.wholeText`: the concatenated data of this node and its contiguous
  // Text-node siblings (the run of adjacent Text / CDATASection nodes), in tree
  // order. A non-Text sibling — or no parent — bounds the run.
  get_wholeText: (node) => dom.wholeText(node),

  // Slottable (Text and Element alone): the slot this text node is assigned to in an open shadow tree.
  get_assignedSlot(node) { return findSlotForSlottable(node, true); }
});
installComment(Comment, {});

// CDATASection (XML only) — a Text subclass carrying literal character data.
// Created via `document.createCDATASection(data)` on an XML document.
class CDATASection extends Text {
  constructor(token, data) {
    constructedBy(PLATFORM, token, 'CDATASection');
    return textObject(new.target, data, NODE_CDATA);
  }
}
globalThis.CDATASection = CDATASection;
registerInterface('CDATASection', (o) => nodeObjectTypeOf(o) === NODE_CDATA);
installCDATASection(CDATASection, {});

// XML's "Name" production — stricter than the HTML-lenient element/attribute local-name checks (U+00B7 a NameChar but
// no NameStartChar): a processing instruction's target, the engine's (xml_parse.rs `is_xml_name`).
const isXMLName = (s) => dom.xmlName(s);

// ProcessingInstruction node (nodeType 7) — a CharacterData leaf carrying a read-only `target` plus `data`, and an
// attribute map (DOM §4.13): the pseudo-attributes of its data, parsed by the xml-stylesheet rules, which its data
// changes update and its attribute members write back as data. Made by `new ProcessingInstruction(target, data)` (its
// global's document's), `document.createProcessingInstruction`, and the XML parser.
class ProcessingInstruction extends CharacterData {
  // (…the platform's `(PLATFORM, target, data, ownerDoc)`, its arguments as they are)
  constructor(target, data) {
    let ownerDoc;
    if (target === PLATFORM) {
      target = arguments[1];
      data = arguments[2];
      ownerDoc = arguments[3];
    } else {
      const converted = convertProcessingInstructionArguments(arguments);
      target = converted[0];
      data = converted[1];
      checkProcessingInstruction("Failed to construct 'ProcessingInstruction': ", target, data);
      ownerDoc = globalThis.document;
    }
    const self = characterDataObject(new.target, data == null ? '' : String(data), NODE_PI);
    stampPI(self, String(target));
    // (…the node document of one the engine made its own already)
    if (!makingEngineObject()) setNodeDocumentOf(self, ownerDoc || null);
    registerNativeNode(self);
    return self;
  }
}
// "Update attributes from data", where the data changed since its map was read from it or written as it: its
// pseudo-attributes, or none where it has no such syntax.
function piAttributeMap(pi) {
  const data = dataOf(pi);
  let map = piAttributesOf(pi, data);
  if (map === null) setPIAttributes(pi, map = pseudoAttributesOf(data), data);
  return map;
}
// "Update data from attributes": the data the engine writes of the map (character_data.rs `pseudo_attributes_data`), the
// whole of its data — the map kept as it is, not read back from it. (…a copy of its map changed: a write that throws —
// data longer than a string can be — leaves both as they were)
function writePIAttributes(pi, map) {
  replaceData(pi, 0, dataOf(pi).length, dom.pseudoAttributesData(map));
  setPIAttributes(pi, map, dataOf(pi));
}
// "Initialize a ProcessingInstruction": its target an XML Name, its data no instruction's end.
function checkProcessingInstruction(fail, target, data) {
  if (!isXMLName(target)) throw new DOMException(`${fail}The target provided ('${target}') is not a valid name.`, 'InvalidCharacterError');
  if (data.includes('?>')) throw new DOMException(`${fail}The data provided ('${data}') contains '?>'.`, 'InvalidCharacterError');
}
// Its data's pseudo-attributes (xml-stylesheet §3), the engine's parse (character_data.rs `pseudo_attributes`): a map of
// names to the values decoded, in their order — empty where the data is no such list.
function pseudoAttributesOf(data) {
  const flat = dom.pseudoAttributes(data), map = new Map();
  if (flat !== null) for (let i = 0; i < flat.length; i += 2) map.set(flat[i], flat[i + 1]);
  return map;
}
// ProcessingInstruction's members, and CSSOM's LinkStyle: generated from their IDL onto the class.
registerInterface('ProcessingInstruction', (o) => nodeObjectTypeOf(o) === NODE_PI);
// (…a name an attribute's local name may be, else an InvalidCharacterError)
function checkPIAttributeName(member, name) {
  if (!isValidAttributeLocalName(name)) {
    throw new DOMException(`Failed to execute '${member}' on 'ProcessingInstruction': '${name}' is not a valid attribute name.`, 'InvalidCharacterError');
  }
}
// CSSOM LinkStyle: an `<?xml-stylesheet?>` PI's associated CSSStyleSheet (mirrors `<link rel=stylesheet>`) — by its
// pseudo-attributes (`href="…" type="…"`), none where its data has no such syntax, nor for one outside its document's
// prolog, of another type than CSS, or an alternate with no title: the engine's to say, as for the cascade
// (sheet_owners.rs `associates_sheet`). (dom/nodes/ProcessingInstruction-escapes-1.xhtml) Its sheet is a new one each
// time it is inserted, the one before left with no owner (sheet_owners.rs) — as it is removed.
function piSheet(pi) {
  if (piTargetOf(pi) !== 'xml-stylesheet' || !dom.associatesSheet(nidOf(pi))) return null;
  const attrs = piAttributeMap(pi);
  const href = attrs.get('href');
  const had = ownerSheetOf(pi);
  if (had !== null) return had;
  // (…none where its fetch failed, as a `<link>`'s)
  const made = fetchedSheet(pi);
  if (!made) return null;
  const media = attrs.get('media') || '';
  const sheet = rareDataOf(pi, true).sheet = ownedStyleSheet(made.id, pi, { href: resolveURLValue(pi, href) ?? href, media, title: attrs.get('title') || null });
  // (…which shows it: the PI's next sheet a new one, the object a script holds keeping the rules it had)
  dom.ownerSheetShown(nidOf(pi));
  return sheet;
}
installProcessingInstruction(ProcessingInstruction, {
  get_target(pi) { return piTargetOf(pi); },
  hasAttributes: (pi) => piAttributeMap(pi).size > 0,
  getAttributeNames: (pi) => [...piAttributeMap(pi).keys()],
  getAttribute(pi, name) {
    const value = piAttributeMap(pi).get(name);
    return value === undefined ? null : value;
  },
  setAttribute(pi, name, value) {
    checkPIAttributeName('setAttribute', name);
    const map = new Map(piAttributeMap(pi));
    map.set(name, value);
    writePIAttributes(pi, map);
  },
  removeAttribute(pi, name) {
    const map = new Map(piAttributeMap(pi));
    map.delete(name);
    writePIAttributes(pi, map);
  },
  toggleAttribute(pi, name, force) {
    checkPIAttributeName('toggleAttribute', name);
    const map = new Map(piAttributeMap(pi));
    if (!map.has(name)) {
      if (force === false) return false;
      map.set(name, '');
      writePIAttributes(pi, map);
      return true;
    }
    if (force === true) return true;
    map.delete(name);
    writePIAttributes(pi, map);
    return false;
  },
  hasAttribute: (pi, name) => piAttributeMap(pi).has(name),
  get_sheet: (pi) => piSheet(pi)
});
globalThis.ProcessingInstruction = ProcessingInstruction;

// Real Attr node (nodeType 2). Bound to an owner element it is a *view* over
// that element's attribute store (`attr.value` tracks live changes and writes
// through), so the element's attribute store (`attrsOf`) stays the single source of truth
// for the hot read paths (cascade / serialization). Detached
// (createAttribute, removeAttributeNode) it carries its own value. Identity is
// stable per (element, stored-key) through the cache in the element's rare data (`attrNodes`): its own state is
// node-identity.js's (`stampAttr`).
class Attr extends Node {
  constructor(token, localName, namespace, prefix, value, ownerDoc) {
    constructedBy(PLATFORM, token, 'Attr');
    const self = namedNodeObject(new.target, NODE_ATTRIBUTE, namespace == null ? null : String(namespace),
      prefix == null ? null : String(prefix), String(localName), undefined);
    stampAttr(self, value == null ? '' : String(value));
    setNodeDocumentOf(self, ownerDoc || null);
    return self;
  }
}
// Its value: its element's attribute while it is one of its element's, its own while it is not.
function attrValueOf(attr) {
  const el = attrOwnerOf(attr), key = attrStoreKeyOf(attr);
  if (el && key != null && Object.prototype.hasOwnProperty.call(attrsOf(el), key)) {
    return attrsOf(el)[key];
  }
  return attrOwnValueOf(attr);
}
function setAttrValue(attr, v) {
  const s = String(v);
  const el = attrOwnerOf(attr), key = attrStoreKeyOf(attr);
  if (el && key != null) setAttrNodeValue(el, key, s);
  setAttrOwnValue(attr, s);
}
// An attribute's qualified name: its prefix and local name.
function attrQualifiedName(attr) {
  const prefix = prefixOf(attr);
  return prefix ? prefix + ':' + localNameOf(attr) : localNameOf(attr);
}
// DOM's `nodeName`, by the node's type — the one its constructor gave it, whatever its prototype is now
// (`Reflect.construct(Text, ['x'], Comment)` is a Text, `#text`).
function nodeNameOf(node) {
  switch (nodeTypeOf(node)) {
    case NODE_ELEMENT:   return elementNameOf(node);
    case NODE_ATTRIBUTE: return attrQualifiedName(node);
    case NODE_TEXT:      return '#text';
    case NODE_CDATA:     return '#cdata-section';
    case NODE_PI:        return piTargetOf(node);
    case NODE_COMMENT:   return '#comment';
    case NODE_DOC:       return '#document';
    case NODE_DOCTYPE:   return doctypeField(node, 0);
    case NODE_FRAGMENT:  return '#document-fragment';
  }
}
// …an element's, its `tagName`: the qualified name, ASCII-uppercased only for an HTML-namespace element whose node
// document is an HTML document (so an element in an XML/XHTML iframe document keeps its case) — the engine's, from the
// element itself, its name and its document's kind in the one call; one of another namespace keeps its case whatever
// its document, its name read here.
function elementNameOf(el) {
  if (namespaceOf(el) === HTML_NS) return dom.elementTagName(el);
  const prefix = prefixOf(el);
  return prefix ? prefix + ':' + localNameOf(el) : localNameOf(el);
}
// Attr's members: generated from its IDL onto the class.
function isAttr(o) { return nodeObjectTypeOf(o) === NODE_ATTRIBUTE; }
registerInterface('Attr', isAttr);
installAttr(Attr, {
  get_namespaceURI: (attr) => namespaceOf(attr),
  get_prefix: (attr) => prefixOf(attr),
  get_localName: (attr) => localNameOf(attr),
  get_name: attrQualifiedName,
  get_value: (attr) => attrValueOf(attr),
  set_value(attr, value) { setAttrValue(attr, value); },
  get_ownerElement: attrOwnerOf,
  get_specified: () => true
});
globalThis.Attr = Attr;

// DocumentType node (e.g. `<!DOCTYPE html>`) — a leaf node carrying name /
// publicId / systemId, the engine's. Created via document.implementation.createDocumentType.
class DocumentType extends Node {
  constructor(token, name, publicId, systemId, ownerDoc) {
    constructedBy(PLATFORM, token, 'DocumentType');
    const self = nodeObject(new.target, NODE_DOCTYPE);
    // (…the node document and names of one the engine made its own already)
    if (makingEngineObject()) {
      registerNativeNode(self);
      return self;
    }
    setNodeDocumentOf(self, ownerDoc || null);
    registerNativeNode(self, [String(name), String(publicId == null ? '' : publicId), String(systemId == null ? '' : systemId)]);
    return self;
  }
}
// DocumentType's members: generated from its IDL onto the class (generated/bindings.js).
registerInterface('DocumentType', (o) => nodeObjectTypeOf(o) === NODE_DOCTYPE);
installDocumentType(DocumentType, {
  get_name(dt) { return doctypeField(dt, 0); },
  get_publicId(dt) { return doctypeField(dt, 1); },
  get_systemId(dt) { return doctypeField(dt, 2); },
  before: childNodeBefore,
  after: childNodeAfter,
  replaceWith: childNodeReplaceWith,
  remove: childNodeRemove
});
globalThis.DocumentType = DocumentType;

// A form's `action` / a submitter's `formaction` value as a URL — what those IDL attributes return, and what a
// submission navigates to: the form document's ADDRESS where it is absent or empty, else the value resolved against
// the document's BASE URL (they differ under a <base>), a special URL's query in the document's encoding
// ("encoding-parse-and-serialize a URL"); a value that does not parse is returned as it is. A submission asks this, not
// the IDL attribute: a control named `action` shadows that on its form (named property access), as a page may.
export function submissionURL(el, value) {
  const doc = nodeDocumentOf(el);
  if (value == null || value === '') return documentURL(doc);
  return parseDocumentURL(doc, value) ?? String(value);
}

// HTML focusing steps: the focused area belongs to a BROWSING CONTEXT, and focusing an
// `<iframe>` hands focus to its NESTED context rather than keeping it on the container
// element — once that context exists; a frame whose realm hasn't been built has none to
// hand focus to, so the container's own context stays focused. The engine keeps which
// context has focus (navigables.rs `set_focused_realm`), the cross-realm answer
// `document.hasFocus()` reads; a MOVE is reported to the host, which hands the chain to the
// service worker registry — a worker's `WindowClient.focused` reads it, and a worker isolate
// can't ask the browser itself.
// `el` is the element gaining focus, or null to focus THIS realm's own context (an
// `<iframe>` losing focus hands it back to the document that contains the frame).
function noteFocusChain(el) {
  focusRealm((el && frameRealmOf(el)) ?? globalThis.__csimRealmId());
}

// HTML "focusable area" (focus.rs `focusable`): what `focus()` takes focus to (a `<span>` with no tabindex does not,
// whatever a library calls focus on), what the click resolver retargets to, and what sequential navigation stops at.
export function isFocusable(n) {
  return !!n && nodeTypeOf(n) === NODE_ELEMENT && styleEngineFocusable(n);
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
hostSteps.neuterDetachedWindow = function (realmId) {
  if (realmId == null) return;
  let win;
  try { win = hostNamespace.contextGlobal(realmId); } catch (_) { return; }
  if (!win) return;
  try {
    // (…its document no longer fully active either way, the engine's: nothing waiting on that — an image's data — goes
    // ahead. Its browsing context gone with it where the frame was removed — `closed` — the engine says from its
    // navigable: navigables.rs `browsingContextDiscarded`. A frame navigated keeps its browsing context, which its old
    // window still reads — Chrome's WindowProxy goes on to the new one.)
    dom.neuterRealm(realmId);
    win.setTimeout   = win.setInterval  = function () { return 0; };
    win.clearTimeout = win.clearInterval = function () {};
    // (…and the platform's own tasks queued on it — a message to one of its ports, from a realm still live)
    hooksOf(win)?.neuterTasks();
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame = function () { return 0; };
    if (typeof win.cancelAnimationFrame  === 'function') win.cancelAnimationFrame  = function () {};
    if (typeof win.queueMicrotask        === 'function') win.queueMicrotask        = function () {};
    // A disconnected / discarded browsing context is no longer a service-worker client, so a
    // reference retained to its `navigator.serviceWorker` (captured before removal) must report
    // `controller === null` (controller-on-disconnect). Runs while the realm is still alive, just
    // before disposal.
    stepsOf(win)?.swClientDiscarded();
  } catch (_) {}
};

// The documents made hidden as they unload (HTML "unload a document": "update the visibility state of document to
// 'hidden'", after its pagehide, firing `visibilitychange` at it) — this realm's own, the one its window shows: the
// engine's, `STATE_HIDDEN`.
const documentHidden = (doc) => defaultViewOf(doc) === null || hasState(doc, STATE_HIDDEN);
globalThis.__csimHideDocument = function () {
  const doc = globalThis.document;
  if (!doc || hasState(doc, STATE_HIDDEN)) return;
  setStateBit(doc, STATE_HIDDEN, true);
  // (…ungated: it bubbles to the window, whose listeners are as much its audience — once per document)
  dispatchWithOnHandler(doc, new Event('visibilitychange', { __proto__: null, bubbles: true }));
};

// A navigation of a frame whose document is being unloaded — a teardown handler of its own re-navigating it — is
// ignored (HTML "navigate" step 13, the document's unload counter above 0): it would tear the document down again, and
// the navigation unloading it is the one that wins (Chrome). So is one of a frame a traversal planned makes the document
// of again, its ongoing navigation "traversal" ("navigate" step 12; Chrome and Firefox: never requested).
function navigationIgnored(realm) {
  return realm != null && (dom.unloading(realm) || dom.navigableTraversing(realm));
}

// Before a frame's document is navigated away it is asked whether it may be (HTML "check if unloading is canceled"):
// `beforeunload` at it and then at each of its frames' documents, every one before any is unloaded (Chrome:
// c:beforeunload, g:beforeunload, then their teardown — `unloadDocumentTree`) — its unload counter raised while its
// handlers run, so a navigation one of them makes is ignored. __csimFireBeforeUnload self-gates on a handler being
// present, so the common handler-less src swap pays nothing beyond the realm lookup. A frame a handler removed
// meanwhile — its navigable destroyed then, its document's teardown waiting for its handlers to be done — is torn down
// once they are, and the navigation goes no further: false.
function promptToUnload(realm, traversal) {
  const container = dom.frameContainer(realm);
  promptDocumentToUnload(realm, traversal);
  if (container == null || isConnected(container)) return true;
  // (…its frame removed: its documents destroyed, unloaded by none — HTML "destroy a child navigable")
  disposeFrameRealmForNav(realm, true, true, true);
  return false;
}
// (…the page's, or a window's, as the host begins a navigation of it — or, `traversal`, applies a traversal's step:
// navigables.rs `session_history_takes`)
hostSteps.promptToUnload = (traversal = false) => promptDocumentToUnload(globalThis.__csimRealmId(), traversal);
// (…the documents to ask, and the order, the engine's: unload_walks.rs, which raises each one's unload counter as it is
// asked and lowers it after — and, as it ends, names those whose own handlers removed their frames, destroyed then: HTML
// "destroy a child navigable", which their removal left to it with their scripts on the stack)
function promptDocumentToUnload(realm, traversal = false) {
  const walk = dom.promptWalk(realm, traversal);
  let removed = [];
  try {
    for (let id; (id = dom.walkNext(walk)) >= 0;) {
      try {
        const win = hostNamespace.contextGlobal(id);
        if (win && typeof win.__csimFireBeforeUnload === 'function') win.__csimFireBeforeUnload();
      } catch (_) {}
    }
  } finally {
    removed = dom.walkEnd(walk);
  }
  for (const id of removed) globalThis.__csimDisposeDiscardedFrameRealm(id, true);
}

// Tear down a frame realm being navigated away (src/srcdoc reassigned OR removed): its document prompted to unload
// first, unless the navigation already did that before its fetch (`prompted`: the host's, `promptToUnloadFrame`)
// or a document above it is being unloaded — asked with that one's, or destroyed with it, which asks none: a teardown
// handler re-navigating a frame of its document's — then unloaded and disposed, dropped from the child-realm step set.
//
// Navigating a browsing context DISCARDS its descendant browsing contexts (HTML "navigate" → unload + discard of the
// document's nested contexts), so the old realm's nested frame realms are disposed with it. Without this a reference
// held to a now-detached child frame (e.g. `iframe.contentWindow` after the iframe's containing document navigated away)
// would resolve to a stale live window instead of null — and the child realms would leak per navigation.
// (…its document's teardown events fire while its navigable's active document it still is — `frameElement` the
// container in its beforeunload / pagehide / unload (Chrome, Firefox) — the caller taking it off the navigable after.)
// (…`destroyed`: its container removed — HTML "destroy a child navigable", which destroys its documents and their
// descendants with no "unload a document" of any: no pagehide, no unload, their unloading cleanup steps alone)
function disposeFrameRealmForNav(oldRealmId, discarded = false, prompted = false, destroyed = false) {
  if (oldRealmId == null) return;
  if (!prompted && !dom.ancestorUnloading(oldRealmId)) promptDocumentToUnload(oldRealmId);
  // (…its whole tree unloaded first, and only then destroyed: a frame's unload handler still reaches a sibling's
  // document, unloaded but not yet gone — HTML "unload a document" runs over the descendants before "destroy a
  // document", Chrome — each document's unload counter raised from its teardown until its realm is gone)
  const walk = unloadDocumentTree(oldRealmId, discarded, destroyed);
  try {
    // (…the window of a navigable that goes on to another document, its own still in its container, kept the one this
    // realm's WindowProxy of it is over — the next document's made, it is that one's (`__csimRetargetWindowProxy`), and
    // the navigable destroyed first, it goes with it: handles.js)
    const kept = !discarded && dom.frameContainer(oldRealmId) != null ? oldRealmId : null;
    for (const id of dom.walkDisposeOrder(walk, true)) disposeRealm(id, kept);
  } finally {
    dom.walkEnd(walk);
  }
}
// …and the page's, or a window's the host closes, the same way (HTML "unload a document and its descendants"): its
// document and its frames', each unload counter raised while it unloads — a navigation, a document.write or a dialog of
// one of its handlers ignored — and lowered once all have, before the host makes the next document (in the realm id
// the page reuses). Its session history entry is the host's (browser.rb `capture_left_page_form_state`).
hostSteps.fireWindowUnloadDeep = function () {
  dom.walkEnd(unloadDocumentTree(globalThis.__csimRealmId(), true, false));
};
// The realm of the entry settings object — the document open steps' entry document's — -1 for none.
function entryRealmId() {
  let entry = dom.entryRealm();
  if (entry < 0) {
    try { entry = hostNamespace.contextOf(dom.enteredGlobal()); } catch (_) { entry = -1; }
  }
  return entry ?? -1;
}
// …and the document of a realm whose Window the next one keeps: unloaded with its frames' as any is, their realms disposed,
// its own kept for the next document to load into.
function unloadKeptDocument(id) {
  const walk = unloadDocumentTree(id, false, false);
  try {
    for (const gone of dom.walkDisposeOrder(walk, false)) disposeRealm(gone, null);
  } finally {
    dom.walkEnd(walk);
  }
}
// Unload realm `root`'s document and its descendants' (HTML "unload a document and its descendants"), in the order the
// engine walks them (unload_walks.rs: each document after its frames' — HTML's explicit order, which Chrome and Firefox
// do not keep: both go parent first — its frames in tree order, a choice where HTML leaves it open; each one's unload
// counter raised as the walk reaches it, so a frame's handler navigating it is ignored), its frames' discarded with it. Returns the walk, which the caller ends (`walkEnd`) once it has
// destroyed what it unloaded (`walkDisposeOrder`), the counters raised till then.
function unloadDocumentTree(root, discarded, destroyed) {
  const walk = dom.unloadWalk(root);
  try {
    for (let id; (id = dom.walkNext(walk)) >= 0;) unloadDocument(id, discarded || id !== root, destroyed);
  } catch (e) {
    dom.walkEnd(walk);
    throw e;
  }
  return walk;
}
function unloadDocument(id, discarded, destroyed) {
  try {
    const win = hostNamespace.contextGlobal(id);
    if (!win) return;
    // The teardown pair (HTML "unload a document"): pagehide + unload, in the dying realm, BEFORE its window is neutered
    // — a keepalive fetch issued from these handlers must still reach a working host boundary.
    if (!destroyed && typeof win.__csimFireWindowUnload === 'function') win.__csimFireWindowUnload();
    // (…its session history entry's persisted state — its controls' values — saved as its handlers left them: Chrome
    // restores a value a pagehide handler wrote. A frame discarded with its parent has no entry of its own to keep.)
    if (!discarded && globalThis.__csim_frameUnloaded) globalThis.__csim_frameUnloaded(id);
    // …and its connections made to disappear (HTML "unloading document cleanup steps"): the host would otherwise go on
    // delivering into a realm being disposed, and the top window's maps would keep it alive.
    if (typeof win.__csimDropWebSockets === 'function') win.__csimDropWebSockets();
    if (typeof win.__csimDropEventSources === 'function') win.__csimDropEventSources();
  } catch (_) {}
}
function disposeRealm(id, kept) {
  hostSteps.neuterDetachedWindow(id);   // a retained contentWindow stays inert, not throwing
  // (…the host's to dispose, which drops every realm's WindowProxy of its window — it would pin the dead global, every
  // removed frame's realm, until the isolate ran out of memory, and be handed back stale — but the one `kept`)
  if (globalThis.__csim_disposeFrameRealm) {
    try { globalThis.__csim_disposeFrameRealm(id, id === kept); } catch (_) {}
  }
  // (…and this document's load, which the frame's may have delayed, asked about again: the frame delays it no more)
  globalThis.__csimLoadBlockerSettled();
}

// …and the host's own navigation of a frame (a link or a form in it, its `location` set — the host fetching the new
// document and rebuilding the frame's realm): its document prompted before the fetch — false when a handler removed
// the frame, the navigation then going no further — and torn down the same way when the response is in, before the host
// disposes what is left: false again when a teardown handler removed the frame, nothing for the response to go into.
hostSteps.promptToUnloadFrame = (realm, traversal = false) => promptToUnload(realm, traversal);
// …and a frame's container removed (handles.js `discardBrowsingContext`): its documents destroyed and its realms disposed,
// no prompt asked — or, where `destroyed` is false (removed by a handler of a document unloading above it), unloaded with
// that document's descendants first, as HTML "unload a document and its descendants" has them.
globalThis.__csimDisposeDiscardedFrameRealm = (realm, destroyed) => {
  // (…its navigable destroyed, its session history with it: session_history.rs `destroyNavigableHistory`)
  dom.destroyNavigableHistory(realm);
  disposeFrameRealmForNav(realm, true, true, destroyed);
};
const ATTR_NAV_NO_ENTRY = 0, ATTR_NAV_FRAGMENT = 1, ATTR_NAV_REPLACE = 3;
// A frame's navigation committing pushes the session history entry it was to push (`FN_URL_HISTORY`), the outgoing
// document — realm `realm`, alive still — snapshotted for a traversal back: one entry however many `src` writes came
// before the commit, the frame's current entry the old document's until then (Chrome). The host's bookkeeping, which
// no failure of may reach the page.
function recordFrameHistory(frameEl, realm) {
  const url = takeFrameNavUrl(frameEl, FN_URL_HISTORY);
  if (url === undefined || realm == null || !globalThis.__csim_recordFrameNav) return;
  try {
    // (…with the markup of a srcdoc document, which a traversal to it makes it of again)
    const srcdoc = dom.frameLoadingSrcdoc(nidOf(frameEl));
    globalThis.__csim_recordFrameNav(realm, url, srcdoc, frameNavHas(frameEl, FN_HISTORY_REPLACE));
  } catch (_) {}
}
// …and a frame's own navigation (a `src` change) committing, its response in: the document it leaves unloaded now —
// its realm disposed with it, or kept where the next document keeps its Window (`keepsWindow`: an initial about:blank's,
// bridge.entry.js `__csimFrameWindow`), its frames' realms gone all the same — false when a teardown handler removed
// the frame, nothing for the response to go into.
globalThis.__csimCommitFrameNavigation = (frameEl, keepsWindow = false) => {
  setFrameNav(frameEl, FN_COMMIT_PENDING, false);
  const old = frameRealmOf(frameEl);
  if (old != null) {
    recordFrameHistory(frameEl, old);
    if (keepsWindow) {
      unloadKeptDocument(old);
    } else {
      disposeFrameRealmForNav(old, false, true);
      dom.setFrameRealm(nidOf(frameEl), -1);
    }
  }
  return isConnected(frameEl);
};
hostSteps.tearDownFrameDocument = (realm) => {
  const container = dom.frameContainer(realm);
  disposeFrameRealmForNav(realm, false, true);
  return container != null && isConnected(container);
};

// …a frame's navigation going on past the steps HTML "navigate" runs at once: its document asked whether it may be
// unloaded where it still is to be (`FN_PROMPT_OWED`) — in parallel with the task that began it, which has ended; Chrome
// and Firefox ask inside `navigate`, before the setter returns — false where a handler removed the frame.
globalThis.__csimFramePrompted = (frameEl) => {
  const realm = dom.frameNavAsks(nidOf(frameEl));
  return realm < 0 || promptToUnload(realm);
};

// What a sandbox refuses a document, said so in Chrome's console words (measured): a new window its target would
// open, where it has no `allow-popups` (navigables.rs `auxiliary_refused` — of the document `el`, the link or the form,
// is in; of this realm's window for none, `open()`'s), the URL it would have loaded `url()`'s — and a form's
// submission, where it has no `allow-forms`.
export function popupRefused(target, el, url) {
  if (!dom.auxiliaryRefused(target, el ? nidOf(el) : null)) return false;
  logPopupRefused(url());
  return true;
}
export const logPopupRefused = (url) =>
  logError(`Blocked opening '${url}' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.`);
export function formsRefused(form) {
  if (!sandboxed(SANDBOXED_FORMS, form)) return false;
  logError(`Blocked form submission to '${formActionURL(form, null)}' because the form's frame is sandboxed and the 'allow-forms' permission is not set.`);
  return true;
}
// The URL a form submits to: its submitter's or its own action, resolved (`submissionURL`).
export function formActionURL(form, submitter) {
  return submissionURL(form, dom.formSubmission(nidOf(form), submitter ? nidOf(submitter) : -1, '')[0]);
}
// A hyperlink's navigation of the frame realm `realm`'s navigable a name chose, to `url`: through the host, this realm its
// initiator, under the policy `policy` its `rel` / `referrerpolicy` sets ('' for the document's) — and with this window's
// transient activation as it is followed (its source snapshot's: location.js `dispatchNav`).
function namedFrameNavigate(realm, url, policy) {
  planFrameNavigation(realm, url, false, globalThis.__csimRealmId(), policy, dom.sourceActivation(-1));
}
// Whether an `<a>` / `<area>` opening the browsing context `target` names keeps its opener — HTML "get an element's
// noopener", the engine's (token_list.rs `noopener`): not with `noopener` or `noreferrer`, nor for `_blank` without
// `opener`; a named target keeps it. Every click-activation path asks it (Element.click, a page's dispatchEvent, the UA
// click resolver), so they agree.
const anchorKeepsOpener = (anchor, target) => !dom.linkNoopener(attrsOf(anchor).rel ?? '', target);

// A hyperlink's navigation (`followHyperlink`), to `tgt`, the browsing context it opens in — its own `target`, or a new
// window's where the user asked for one: a same-document fragment hops in JS; anything else goes where the engine routes
// it (navigables.rs `linkRoute`) — nowhere; a frame a name chose, navigated through the host (one with no document yet
// made one now); a new auxiliary window the host opens for a frame's or a window's link; the navigable a frame's or a
// window's link names, navigated by this document as its location navigates it (`navigateFrom`, as `window.open`
// navigates one it chose: the page through its location, a frame through its container, a window of this isolate's
// through its realm); or the page's, the pending-navigation intent the Ruby drain (or the click resolver) takes. Each
// under the referrer policy the link's `rel` / `referrerpolicy` sets, with the opener its noopener's answer leaves
// (`anchorKeepsOpener`; the Ruby side forces noopener for a cross-partition blob: target). The target is HTML "get an
// element's target": its own, else its document's `<base target>` (url_ops.rs).
export function anchorActivateNavigate(anchor, tgt = dom.elementTarget(nidOf(anchor))) {
  // (…none of a navigable whose document is being unloaded, or asked whether it may be — a fragment's neither: HTML
  // "navigate" returns before it navigates to one — a teardown handler's click: navigables.rs `targetUnloading`)
  if (dom.targetUnloading(tgt)) return;
  if (fragmentNavigate(anchor, tgt)) return;
  const [route, at, container] = dom.linkRoute(String(tgt ?? ''), nidOf(anchor), typeof globalThis.__csimOpenAuxFromRealm === 'function');
  const url = String(hrefAttr(anchor));
  // (…its URL parsed now, as it is followed, against its node document's base URL as that is now — the URL every route
  // below carries, a plan for the host too — and none where it parses to no URL: HTML "follow the hyperlink")
  const abs = resolveURLValue(anchor, url);
  if (abs === null && route !== 'refused') return;
  const policy = dom.hyperlinkReferrerPolicy(nidOf(anchor));
  // A blob: link takes its blob reference NOW (HTML resolves the URL's blob URL entry as it parses it; the navigation
  // is deferred and the page may revoke the URL first) — snapshot the bytes so the document, a new window's or this
  // one's, still loads after revoke — by its URL as it resolves, white space around it and all. (A cross-partition blob
  // lives in another isolate → no local snapshot; the host resolves it cross-VM.)
  const blob = () => (abs !== null && schemeRoute(abs) === ROUTE_BLOB ? hostSteps.readBlobForWindow(abs) ?? undefined : undefined);
  switch (route) {
    case 'none':
      return;
    case 'refused':
      logPopupRefused(abs ?? url);
      return;
    case 'unbuilt': {
      try { hostNamespace.contextGlobal(at).__csimFrameWindow(container); } catch (_) {}
      // (…nowhere where none could be made: past the nesting limit, deferred by an activating service worker)
      const realm = frameRealmOf(container);
      if (realm != null) namedFrameNavigate(realm, abs, policy);
      return;
    }
    case 'frame':
      namedFrameNavigate(at, abs, policy);
      return;
    case 'auxiliary':
      globalThis.__csimOpenAuxFromRealm(abs, anchorKeepsOpener(anchor, tgt), blob(), at, policy, globalThis.__csimRealmId());
      return;
    case 'navigate':
      stepsOf(realmGlobalOf(at)).navigateFrom(abs, globalThis.__csimRealmId(), policy);
      return;
    case 'plan':
      // (…the navigable it opens in chosen now, by the engine — navigation_plan.rs `planNavigation` — and its referrer
      // policy '' for the document's: a new window's load needs it)
      dom.planNavigation(abs, at, anchorKeepsOpener(anchor, at), policy, blob());
  }
}

// The elements whose `click()` is dispatching its click (HTML's "click in progress flag").
const clicksInProgress = new WeakSet();
// DOM dispatch's activation (dispatch.js), for a click whose activation target is `act` — the nearest element with
// activation behaviour on its path (event_path.rs `activation_target`) — however it was clicked: a script's `click()`
// or `dispatchEvent`, a user's. The engine's (activation.rs): before the click's listeners run, its legacy-pre-activation
// behaviour — a checkbox's indeterminate cleared and its checkedness toggled, a radio button checked — answering what
// undoes it (`[radio, wasChecked, wasIndeterminate, checkedBefore]`)…
export function legacyPreActivation(act) {
  const pre = dom.preActivate(act);
  if (pre !== undefined) engineWritten();
  return pre ?? null;
}
// …its legacy-canceled-activation behaviour where a listener canceled the click: the radio button its group had checked
// checked again, or the checkbox's checkedness and indeterminate as they were (a value a listener set reverted too)…
export function legacyCanceledActivation(act, pre) {
  dom.cancelActivation(act, ...pre);
  engineWritten();
}
// …and otherwise its activation behaviours, which the engine says apply (activation.rs `ACTIVATION_*`), each run (the
// click's state reset: a listener of what it fires may dispatch the click again). `target` is what was clicked.
const ACTIVATION_CHECKABLE = 1, ACTIVATION_CHECKABLE_CHANGED = 1 << 1, ACTIVATION_PICKER = 1 << 2, ACTIVATION_IMAGE = 1 << 3;
const ACTIVATION_SUBMIT = 1 << 4, ACTIVATION_RESET = 1 << 5, ACTIVATION_SUMMARY = 1 << 6, ACTIVATION_INVOKER = 1 << 7;
const ACTIVATION_LABEL = 1 << 8, ACTIVATION_HYPERLINK = 1 << 9;
export function activationBehavior(act, event, target, pre) {
  const state = eventState(event);
  const activation = dom.activation(act, target, pre ? pre[1] : undefined);
  const steps = activation[0], form = activation[1], control = activation[2];
  // A checkbox's or a radio button's: `input` and `change`, where its checkedness changed — a connected one's only — and
  // a user's click an interaction with it, after which it matches `:user-invalid` / `:user-valid`.
  if (steps & ACTIVATION_CHECKABLE) {
    if (state.isTrusted) markUserValidity(act);
    if (steps & ACTIVATION_CHECKABLE_CHANGED) fireCheckableActivation(act);
    return;
  }
  // (…an input whose activation shows a picker consuming the user's transient activation)
  if (steps & ACTIVATION_PICKER) dom.consumeActivation();
  // (…an image button's beginning with the coordinate its click selected, from its padding edge — a pointer's, or a
  // page's click event's at its point (xhr/formdata/submitter-coordinate-value); a synthetic click selects none)
  if ((steps & ACTIVATION_IMAGE) && !state.noPoint) {
    const origin = globalThis.__csimPaddingEdgeOrigin(act);
    selectCoordinate(act, state.clientX - origin.x, state.clientY - origin.y);
  }
  // A submit or reset button's: its form owner submitted (interactively) or reset, where it is connected and enabled;
  // a summary's: its details opened or closed; a command or popover invoker's that activated no form: its target's
  // command.
  if (steps & ACTIVATION_SUBMIT) submitForm(form, act, true);
  else if (steps & ACTIVATION_RESET) resetForm(form);
  if (steps & ACTIVATION_SUMMARY) toggleDetails(parentOrHostOf(act));
  else if (steps & ACTIVATION_INVOKER) invokerActivation(act, target);
  // A label's, where the click was on it or on what of it is no interactive content: its labeled control focused and
  // clicked — a user's click's a user's, with the keys, the pointer, the point and the count they clicked with (Chrome:
  // an image button submits where in it that point is; Firefox focuses too), each the event's own, not a getter's.
  if (steps & ACTIVATION_LABEL) {
    focusElement(control);
    clickElement(control, state.isTrusted ? {
      ctrlKey:     state.ctrlKey,
      shiftKey:    state.shiftKey,
      altKey:      state.altKey,
      metaKey:     state.metaKey,
      detail:      state.detail,
      pointerId:   state.pointerId,
      pointerType: state.pointerType,
      isPrimary:   state.isPrimary,
      clientX:     state.clientX,
      clientY:     state.clientY,
      screenX:     state.screenX,
      screenY:     state.screenY
    } : null);
  }
  // A hyperlink's: its `href` followed — but not one in an editing host, which a click edits instead.
  if (steps & ACTIVATION_HYPERLINK) followHyperlink(act, state);
}
// HTML "follow the hyperlink" for a click: nothing for an href that is no URL; a `javascript:` URL's script run (a
// QUEUED navigation, as in real browsers — from the PARSED URL, so `java\nscript:` counts); a `download` link's resource
// saved (Ruby's drain); anything else navigated — in a new window where the user held Control, Meta or Shift.
function followHyperlink(anchor, state) {
  // (…its node document's to follow, whichever realm's code clicked it: a link the parent made and moved into a frame's
  // document navigates the frame — Chrome — as a form's submission does: `recordFormSubmission`)
  const realm = foreignRealmOf(nodeDocumentOf(anchor));
  if (realm !== null) return realm.followHyperlink(anchor, state);
  // (…none from a document that is not fully active — its frame removed, or navigated away: HTML "follow the
  // hyperlink" step 1, an `<a>`'s "cannot navigate")
  if (!dom.documentFullyActive(nidOf(nodeDocumentOf(anchor)))) return;
  const href = hrefAttr(anchor);
  const url = parseDocumentURL(nodeDocumentOf(anchor), href);
  if (url === null) return;
  const tgt = state.isTrusted && (state.ctrlKey || state.metaKey || state.shiftKey) ? '_blank' : dom.elementTarget(nidOf(anchor));
  if (url.startsWith('javascript:')) {
    // (…in the navigable its target chooses: this one's document, or another's through the window open steps, which
    // run it there — a named window's, a new one's, where the link keeps its opener: a new window with none has an
    // opaque origin, which runs no javascript: URL of this document's — Chrome)
    if (dom.targetsOwnNavigable(tgt)) globalThis.__csimNavigateJavascriptURL(href, documentBaseURL(nodeDocumentOf(anchor)));
    else globalThis.__csimWindowOpenSteps(url, tgt, anchorKeepsOpener(anchor, tgt) ? '' : 'noopener');
  } else if (attrsOf(anchor).download != null) {
    // (…none from a document sandboxed against downloads: HTML "allowed to download")
    // (…under the referrer policy its `rel` / `referrerpolicy` set, as Firefox 159 follows both and Chrome 156 the
    // attribute: measured 2026-10-31 — its URL the one parsed now, against its document's base URL)
    if (!sandboxed(SANDBOXED_DOWNLOADS, anchor)) {
      dom.planDownload(url, String(attrsOf(anchor).download || ''), dom.hyperlinkReferrerPolicy(nidOf(anchor)));
    }
  } else {
    anchorActivateNavigate(anchor, tgt);
  }
}

// "Ensure details exclusivity by closing other elements if needed": the open details elements of an open one's name group
// (HTML §4.11.1: the other details elements of its tree with the same non-empty `name` — the engine's, details.rs)
// closed, each one.
function closeOtherDetailsIfNeeded(details) {
  for (const other of dom.openDetailsInGroup(nidOf(details))) removeAttribute(other, 'open');
}
// …"by closing the given element if needed": an open details element closed where one of its group is open — its
// insertion steps and its `name` attribute's change steps.
function closeDetailsIfNeeded(details) {
  if (attrsOf(details).open != null && dom.openDetailsInGroup(nidOf(details)).length !== 0) removeAttribute(details, 'open');
}
// Whether a details element has ever had a `name` — none has a name group before, so an insertion looks for none.
let namedDetailsSeen = false;
const isDetails = (el) => isHtml(el, 'details');
const isDialog = (el) => isHtml(el, 'dialog');
// A parser's insertion steps for a node it inserts — before the nodes after it are there, so of the open details
// elements of a name group the first in tree order stays open — unless the engine built them all, and closed the
// others itself (`exclusive` false: html-tree-builder.js `builtSteps`).
function parserInsertionSteps(node, exclusive = true) {
  if (exclusive && isDetails(node) && attrsOf(node).open != null) closeDetailsIfNeeded(node);
  parserAutofocusStep(node);
  if (formNamingCustoms && nodeTypeOf(node) === NODE_ELEMENT && attrsOf(node).id != null) idsChanged(node);
}
// The details elements' insertion steps, for inserted nodes: each open named one among their shadow-including inclusive
// descendants, in tree order, closed where its group has another open.
function detailsExclusivityOnInsert(nodes) {
  if (!namedDetailsSeen) return;
  for (const node of nodes) {
    if (nodeTypeOf(node) !== NODE_ELEMENT) continue;
    for (const details of dom.openNamedDetailsIn(nidOf(node))) closeDetailsIfNeeded(details);
  }
}
// A details element opened or closed: its `open` attribute, whose change queues its `toggle`.
export function toggleDetails(details) {
  if (attrsOf(details).open != null) removeAttribute(details, 'open');
  else setAttribute(details, 'open', '');
}
// The attribute change steps an attribute APPENDED to a new element runs where no setter's handleAttributeChanges did —
// the parser's and a clone's: a details element's `open` queues its toggle, closed → open (Chrome fires it for a parsed
// `<details open>` and an open one's clone), and its `name` gives it a name group.
// (…the attributes whose appending has steps of its own)
// Whether `doc` is fully active, as this realm sees it: its document, while its window is not one a navigation or a
// discard neutered (the engine's: navigables.rs `documentFullyActive`).
function fullyActive(doc) {
  return doc === globalThis.document && dom.documentFullyActive();
}
// HTML "cannot navigate", for an element that is no `<a>`: not connected, or its node document not fully active — a
// form of a document its frame navigated away from submits nothing — whichever realm's code asks (navigables.rs).
const cannotNavigate = (el) => !isConnected(el) || !dom.documentFullyActive(nidOf(nodeDocumentOf(el)));
// HTML "update the image data" where a relevant mutation asks for it outside the attribute steps — a clone's attributes
// appended, an adoption: once its node document is fully active (this realm's own, with a browsing context — not
// template contents' or a DOMParser's, where it waits for an adoption that brings it into one), and after a stable state
// (a microtask), where the source is selected: a cloned `<picture>`'s image has its `<source>` siblings by then. An
// element of another realm's document — a main-realm clone of an image adopted into a frame, which stays in the main
// realm's arena — is that document's realm's to load.
function updateImageDataSoon(el) {
  if (nodeDocumentOf(el) !== globalThis.document) {
    foreignRealmOf(nodeDocumentOf(el))?.updateImageDataSoon(el);
    return;
  }
  const active = () => fullyActive(nodeDocumentOf(el));
  if (!active()) return;
  globalThis.__csimQueueMicrotask(() => {
    if (active()) loadImageResource(el);
  });
}
// …and of the images among `node`'s shadow-including inclusive descendants, now in a fully active document.
function updateImagesIn(node) {
  // (…the engine's to find: `imageElementsIn`)
  for (const img of imageElementsIn(node)) updateImageDataSoon(img);
}
// DOM "clone a node" of `node` (`deep`) — the engine's for an element, character data or a fragment, whole (cloning.rs
// `clone_tree`): a shadow host's clonable shadow root with it (`REALM.cloneShadowRoot`), the bindings' share of each
// element's steps run after, and a select's options initialised as its children's insertion would — as the engine
// answers it (`[copy, source, copy, names, …]`); undefined for a node the bindings clone (a document, a doctype, an
// attribute). What a shadow root's attaching threw, thrown.
function engineClone(node, deep) {
  const made = dom.cloneTree(node, deep);
  throwCloneException();
  if (made === undefined) return undefined;
  // (…a cloned shadow tree's slots signaled as the engine assigned them: their `slotchange` at the next checkpoint)
  engineWritten();
  for (let i = 1; i < made.length; i += 3) {
    bindingsCloningSteps(made[i], made[i + 1], made[i + 2]);
    if (deep && isHtml(made[i + 1], 'select')) finalizeSelectOptions(made[i + 1]);
  }
  return made;
}
NATIVE_REALM.updateImageDataSoon = updateImageDataSoon;
NATIVE_REALM.recordFormSubmission = recordFormSubmission;
NATIVE_REALM.followHyperlink = followHyperlink;
// DOM "clone a node" of a shadow host whose shadow root is clonable, the engine's clone asking (cloning.rs
// `clone_shadow_root`): a shadow root attached to `copy` as the source's was — its mode, slot assignment, delegatesFocus,
// serializable and clonable, its declarative-ness, its registry, its `shadowrootadoptedstylesheets` as written (a
// serializable one's getHTML round-trips it), whether its internals have it; null where it is not clonable, the engine
// cloning its children into it — each read off the engine's flags, never the members a page may replace.
NATIVE_REALM.cloneShadowRoot = (source, copy) => {
  const src = shadowRootOf(source);
  if (!src || !shadowIs(src, SHADOW_CLONABLE)) return null;
  const sr = attachShadow(copy, {
    mode:           shadowRootMode(src),
    slotAssignment: shadowIs(src, SHADOW_MANUAL_SLOTS) ? 'manual' : 'named',
    clonable:       true,
    delegatesFocus: shadowIs(src, SHADOW_DELEGATES_FOCUS),
    serializable:   shadowIs(src, SHADOW_SERIALIZABLE)
  });
  // (…its declarative-ness, its `shadowrootadoptedstylesheets` and its availability to internals the engine copies:
  // cloning.rs `clone_shadow_root`)
  const registry = ceRegistryOf(src);
  if (registry !== undefined) setCeRegistryOf(sr, registry);   // declarative null / scoped travels with the clone
  if (dom.ceKeepNull(src)) dom.ceSetKeepNull(sr, true);
  return sr;
};
// …and what a clonable shadow root's attaching threw in the op that cloned last, thrown — once the bindings have finished
// what that op changed (cloning.rs `takeCloneException`).
function throwCloneException() {
  const thrown = dom.takeCloneException();
  if (thrown !== null) throw thrown[0];
}
// …and the custom elements among a clone's copies — `made`'s `[source, copy, names]` triples from `at` on, every copy
// that may be one among them, in the order the engine made them — upgraded: DOM "clone a node" makes each with the
// synchronous custom elements flag unset, a definition found enqueuing its upgrade, which runs as the call returns —
// its constructor, an attributeChanged for each observed attribute copied, no connectedCallback (the clone is detached).
// By the registry of each — a DOMParser's document or a template's contents has none.
function upgradeCopies(made, at) {
  if (made.length <= at || !hasAnyCEDefinitions()) return;
  const copies = [];
  for (let i = at; i < made.length; i += 3) copies.push(made[i + 1]);
  ceEnqueueUpgradesOf(copies);
}
// …and the cloning steps of a copy of `el` the engine made (cloning.rs) that are the bindings' share: an image's data,
// and the steps of the attributes `names` (undefined for none) the engine answers with — an event handler's content
// attribute activating the copy's own handler (`fromClone`: a cloned `<body>` / `<frameset>` leaves the window's alone),
// an open details element's toggle, an open dialog's opening, a name or id the named properties' (an element imported
// from another realm's document).
function bindingsCloningSteps(el, copy, names) {
  // (…an image's source among them: "update the image data", inserted or not — Chrome loads a clone never inserted)
  if (isImageRequestElement(copy)) updateImageDataSoon(copy);
  if (names === undefined) return;
  const attrs = attrsOf(copy);
  for (const name of names) {
    const value = attrs[name];
    if (name.startsWith('on')) syncInlineEventHandler(copy, name, value, true);
    else appendedAttributeSteps(copy, name, value);
  }
}
function appendedAttributeSteps(el, name, value) {
  // (…a name or id a named property of the window, the document or a form: its gates — a parser's, an XML parser's)
  if ((name === 'id' || name === 'name') && value) registerNamedAccess(el, name, value);
  // (…a media element's `src`: one created with it — the engine names it only on one — invokes its resource selection)
  if (name === 'src') mediaCreated(el);
  if (name === 'open' && isDialog(el)) dialogOpened(el);
  if (!isDetails(el)) return;
  if (name === 'open') queueToggleTask(el, 'closed', 'open');
  else if (name === 'name') namedDetailsSeen = true;
}

// A form's submission — form.submit() / requestSubmit() / submit-button click activation / Enter + set("…\n") implicit
// submission, each through `runFormSubmit` — its request made and its navigation planned, for the host to make.
// `entryList` is the constructed entry list (the FormData that left, post-`formdata`), so `formdata` fires exactly once and
// a handler's append/delete is honoured. An interactive one (a submit button's default action, an implicit submission,
// not the `form.submit()` method) supersedes the form's last plan on another frame: the button's default submit to frame2
// cancels an onclick `form.submit()` to frame1 (form-double-submit), where one form submitted by its method into several
// frames navigates them all (form-double-submit-multiple-targets).
export function recordFormSubmission(form, submitter, entryList, fromSubmitMethod) {
  // (…its node document's to plan, whichever realm's code submitted it: a form the parent made and moved into a frame's
  // document navigates the frame, not the page — Chrome)
  const realm = foreignRealmOf(nodeDocumentOf(form));
  if (realm !== null) {
    realm.recordFormSubmission(form, submitter, entryList, fromSubmitMethod);
    return;
  }
  // (…its request made now, as HTML "submit" makes it before it plans the navigation: what the page does to the form
  // after — its values, its action, a move to another document — is no part of what it sends)
  const request = hostSteps.formSerialize(form, submitter || 0, entryList);
  const planned = dom.planFormSubmission(nidOf(form), request, !fromSubmitMethod);
  if (planned === FORM_PLANNED_TURN) hostSteps.queueNavigationTurn();
  else if (planned === FORM_POPUP_REFUSED) logPopupRefused(request.action);
}
const FORM_PLANNED_TURN = 1, FORM_POPUP_REFUSED = 2;

// "Handle attribute changes", the bindings' share of it, for each change (`changeAttribute`'s answer) — the writer's box
// and its subtree marked to be laid out anew and the generations moved as the engine made it (attributes.rs
// `attr_write`), what else the write restyles (a `body.os-pc .os-host` under it, the `.c` of a `.c:has(.flag)` above
// it) the style engine marking as it restyles them (layout.js `markRestyles`): the realms' observations asked for, the
// backup element queue's microtask queued where the reaction went there, and the attribute change steps the engine
// answers. The reaction RUNS as the [CEReactions] call that caused it returns, after every step — a callback sees the
// handler installed, the selectedness set, the value migrated — and even when a step throws; a write a step makes
// itself (the type change's `value`) is part of the same call, so its reaction runs behind the one that caused it.
function attributeChanged(el, made) {
  const steps = made[0];
  if (steps & STEP_REMOVED) detachAttrNode(el, made[1], made[2]);
  engineWritten();
  if (steps & STEP_BACKUP) queueBackupReactions();
  if ((steps & ~(STEP_REMOVED | STEP_BACKUP)) !== 0) {
    attributeChangeSteps(el, steps, made[3], made[2], steps & STEP_REMOVED ? null : attrsOf(el)[made[1]]);
  }
  wakeForFocusFixup(el);
}
// A change to the focused element or an element around it — a `hidden`, an `inert`, a style, a move — may make it no
// longer focusable: the rendering update's focus fixup (`__csimFocusFixup`) is owed a frame, which the event loop steps
// to.
function wakeForFocusFixup(el) {
  const doc = nodeDocumentOf(el);
  const ae = doc && focusedElementOf(doc);
  if (ae && (ae === el || dom.shadowIncludingInclusiveAncestor(el, ae))) oweFrame();
}
// The steps a change asks of the bindings (attributes.rs `STEP_*`), the attribute's local name `n`, its value `old`
// before and `next` after (null for none).
const STEP_IMAGE = 1, STEP_SCRIPT = 1 << 1, STEP_SHEET = 1 << 2, STEP_DISABLED = 1 << 3, STEP_NAMED = 1 << 4;
const STEP_CANVAS = 1 << 5, STEP_DIALOG = 1 << 6, STEP_DETAILS = 1 << 7, STEP_DETAILS_NAME = 1 << 8;
const STEP_SELECTED = 1 << 9, STEP_MULTIPLE = 1 << 10, STEP_FRAME_MARGINS = 1 << 11, STEP_FRAME_SRC = 1 << 12;
// (…1 << 14 the engine's alone: a picture's sources' images marked, attributes.rs `STEP_PICTURE`)
const STEP_MEDIA_SRC = 1 << 13, STEP_HANDLER = 1 << 15, STEP_FORM_OWNER = 1 << 16;
const STEP_FILES = 1 << 17, STEP_BACKUP = 1 << 18, STEP_REMOVED = 1 << 19, STEP_POPOVER = 1 << 20;
const STEP_LINK_RESOURCE = 1 << 21, STEP_PICTURE_SOURCE = 1 << 22, STEP_PLUGIN = 1 << 23;
function attributeChangeSteps(el, steps, n, old, next) {
  // A change to the attribute that sources an image element's bitmap (an <img>'s src, an SVG <image>'s href /
  // xlink:href) re-fetches + decodes the new resource; removing it discards the current request (resets intrinsic size +
  // bitmap), and for an SVG <image> lets a remaining xlink:href fallback take over.
  if (steps & STEP_IMAGE) loadImageResource(el);
  // A `src` set on a <script> that had none prepares it (an empty one inserted first, its source assigned after).
  if (steps & STEP_SCRIPT) globalThis.__csimPrepareScript(el);
  if (steps & STEP_SHEET) sheetAttrChanged(el, n, next, (steps & STEP_LINK_RESOURCE) !== 0);
  // Disabling a control or `<fieldset>` removes focus from any now-actually-disabled element SYNCHRONOUSLY (HTML runs
  // the focus fix-up during the disabled change, not on a later task) — so `fieldset.disabled = true; activeElement` is
  // already reset (disabled-003).
  if (steps & STEP_DISABLED) {
    const doc = nodeDocumentOf(el);
    const ae  = doc && focusedElementOf(doc);
    if (ae && !isFocusable(ae)) {
      setFocusedElement(doc, null);
      loseFocus(ae, null);
    }
  }
  // A name/id becomes a named property — gate the form / window / document named-access lookups for this value (the
  // exotic objects resolve existence + value live; see registerNamedAccess).
  if (steps & STEP_NAMED) registerNamedAccess(el, n, next);
  // HTML canvas: its `width` or `height` set resets its bitmap (canvas.js `resetBitmap`).
  if (steps & STEP_CANVAS) resetBitmap(el);
  // A dialog's `open` coming or going puts it on or takes it off its document's open dialogs; a details element's queues
  // its toggle task (queueToggleTask), and opening one closes the rest of its name group; a new `name` closes it where
  // its new group has one open already.
  if (steps & STEP_DIALOG) {
    if (next !== null) dialogOpened(el);
    else dialogClosed(el);
  }
  if (steps & STEP_DETAILS) {
    queueToggleTask(el, old == null ? 'closed' : 'open', next === null ? 'closed' : 'open');
    if (next !== null) closeOtherDetailsIfNeeded(el);
  }
  if (steps & STEP_DETAILS_NAME) {
    namedDetailsSeen = true;
    closeDetailsIfNeeded(el);
  }
  // HTML `selected` content-attribute change steps — the option's selectedness the engine's to set as it stores the
  // attribute (attributes.rs `STEP_SELECTED`) — and, where it is not dirty, its select's selectedness algorithm run.
  if ((steps & STEP_SELECTED) && !hasState(el, STATE_SELECTED_DIRTY)) askForReset(el);
  // HTML: removing `multiple` from a <select> re-runs the selectedness setting algorithm — a prior multi-selection
  // collapses to the last selected option in tree order (crbug.com/1245443 / select-multiple.html).
  if (steps & STEP_MULTIPLE) runSelectednessAlgorithm(el, null);
  // …a frame's `marginwidth` / `marginheight` are its document body's margins: pushed into the frame's realm.
  if ((steps & STEP_FRAME_MARGINS) && frameRealmOf(el) != null) {
    try {
      const win = hostNamespace.contextGlobal(frameRealmOf(el));
      if (win) stepsOf(win).frameMarginsChanged(getAttribute(el, 'marginwidth'), getAttribute(el, 'marginheight'));
    } catch (e) {}
  }
  // A frame's src/srcdoc change navigates its nested document (setting `src` navigates even to the SAME value: Chrome fires
  // a fresh `load`), and so does removing either (HTML "process the iframe attributes": to the `src` a `srcdoc` gone
  // leaves, else to about:blank — Chrome's `load` again).
  // (…none while the frame's document is being unloaded: `navigationIgnored`; nor where its `src` is a document above it,
  // which HTML's shared attribute processing steps navigate nowhere before anything else happens — the document it has
  // asked nothing, a navigation under way left to go on: frame_navigation.rs `process_src`)
  const frameRealm = steps & STEP_FRAME_SRC ? frameRealmOf(el) : null;
  if ((steps & STEP_FRAME_SRC) !== 0 && !navigationIgnored(frameRealm) && !dom.processFrameSrc(nidOf(el))) {
    // What the navigation makes of the frame's session history, the engine's to say (frame_navigation.rs
    // `frameAttributesNavigate`) — none at all for a fragment of its document, navigated to at once in it (HTML "navigate"):
    // an entry it adds or replaces as it commits, snapshotting the OUTGOING document, so history.go(-1) can traverse back
    // to it.
    const [handling, entryUrl] = dom.frameAttributesNavigate(el);
    if (handling === ATTR_NAV_FRAGMENT) {
      stepsOf(realmGlobalOf(frameRealm)).fragmentNavigate(entryUrl, false);
    } else {
      // (…a pending scripted-nav response superseded, and the retained blob bytes stale)
      setFrameContent(el, FC_LOADED, null);
      setFrameNav(el, FN_HISTORY_REPLACE, handling === ATTR_NAV_REPLACE);
      renavigateFrame(el, null, false, handling === ATTR_NAV_NO_ENTRY ? null : entryUrl);
    }
  }
  if (steps & STEP_MEDIA_SRC) mediaSrcChanged(el);
  // An `<embed>`'s or an `<object>`'s resource may be another: its processing runs again (bridge.entry.js).
  if (steps & STEP_PLUGIN) globalThis.__csimProcessPlugin(el);
  // A `<picture>`'s `<source>` changing what selects its images (attributes.rs `STEP_PICTURE_SOURCE`) re-runs each
  // sibling `<img>`'s "update the image data", the img's own attributes untouched (their boxes the engine marked).
  if (steps & STEP_PICTURE_SOURCE) {
    for (const sib of childNodesOf(parentOrHostOf(el))) {
      if (nodeTypeOf(sib) === 1 && isHtml(sib, 'img')) { try { loadImageResource(sib); } catch (_) {} }
    }
  }
  // An event-handler content attribute (`onclick="…"`) activates the element's handler as a registered listener (and
  // removing it clears the handler); a body's or frameset's forwarded ones drive the Window's (event_handlers.rs).
  if (steps & STEP_HANDLER) syncInlineEventHandler(el, n, next);
  // Form-associated custom element reactions: `form` re-points the owner, `disabled` (on the element or a <fieldset>)
  // flips the disabled state, `id` on a <form> re-points its references (resetFormAssociatedOwnersForAttr).
  if (steps & STEP_FORM_OWNER) resetFormAssociatedOwnersForAttr(el, n);
  // …and an input become a file input has its selected files emptied (HTML: its value set to '').
  if (steps & STEP_FILES) setSelectedFiles(el, []);
  // HTML `popover` attribute change steps: a showing popover whose attribute's state changed hidden.
  if (steps & STEP_POPOVER) popoverAttributeChanged(el, next);
}

// The insertion steps of an open named details element, which closes the rest of its group, and of an autofocus
// candidate, for inserted nodes. (A checked radio's, which unchecks the rest of its group, are the engine's: it runs them
// as it inserts — element_state.rs `radio_insertion_steps`.)
function insertionSteps(nodes) {
  detailsExclusivityOnInsert(nodes);
  autofocusInsertionSteps(nodes);
}
// A text control's `change` waits for its blur, and fires there only where the user edited it since it was focused and
// its value is another — the engine's (change_on_blur.rs: armed as it is focused, `changeArm`; edited as the user edits
// it, `changeEdited`). A script's write to the value never counts as an edit.
function commitChangeOnBlur(el) {
  if (el && dom.changeCommit(nidOf(el), false)) {
    markUserValidity(el);
    fireEvent(el, new Event('change', { __proto__: null, bubbles: true, cancelable: false }));
  }
}
// …and implicit form submission (Enter in a text field) commits it WITHOUT the blur: `change` before `submit`, the field
// keeping focus (Chrome), its value now what a later blur compares against.
export function commitChangeKeepingFocus(el) {
  if (el && dom.changeCommit(nidOf(el), true)) {
    markUserValidity(el);
    fireEvent(el, new Event('change', { __proto__: null, bubbles: true, cancelable: false }));
  }
}
// A form control's `autocomplete`: its autofill detail tokens, the engine's (reflect.rs `autofill`).
export const autofillOf = (control) => dom.autofill(nidOf(control));

// An `<iframe>`'s / a `<frame>`'s nested browsing context — a same-realm nested
// Document parsed from srcdoc / src (lazily, via the bridge frame loader).
// contentWindow.DOMException etc. resolve to the shared globals, so
// `instanceof` across the frame boundary works.
export function frameContentWindow(frame) {
  // A frame has no browsing context (contentWindow null) when it isn't
  // connected, or while a connect walk is in progress and the frame's OWN
  // post-insertion step (connectOneElement, which sets FN_CONTEXT_READY
  // in tree order) hasn't run yet. So a `<script>` inserted atomically BEFORE
  // an `<iframe>` in the same appendChild (div / DocumentFragment / append()
  // multi-arg) runs mid-walk and sees null, while a script AFTER it sees the
  // live window. OUTSIDE any connect walk a connected frame is always ready —
  // direct-splice inserts (innerHTML / DSD), which run no sibling scripts and
  // bypass the connect walk, are unaffected.
  // (dom/nodes/insertion-removing-steps/Node-appendChild-script-and-iframe.html)
  if (!isConnected(frame)) return null;
  if (inConnectWalk() && !frameNavHas(frame, FN_CONTEXT_READY)) return null;
  const w = globalThis.__csimFrameWindow ? globalThis.__csimFrameWindow(frame) : null;
  if (!w) return w;
  // Return THIS realm's WindowProxy for the frame, not the raw child global, so
  // `contentWindow === e.source` (from a message it sends) and cross-realm
  // postMessage attributes the sender. Falls back to raw if no proxy can be made.
  const realm = realmHooks.frameWindowProxyFor ? realmOfGlobal(w) : null;
  if (realm !== null) {
    try { return realmHooks.frameWindowProxyFor(realm) || w; } catch (_) {}
  }
  return w;
}
// …and the next document of a frame of this realm's document between two of them — its last one realm `realm`'s —
// made as a WindowProxy of it is used (navigables.rs `parked`): its window, the one a `contentWindow` read makes.
// One whose next document is made nowhere — its build failed — is given up on:
// made no more as it is used, the WindowProxies of it dropped.
globalThis.__csimMakeParkedFrame = (realm) => {
  const frame = dom.parkedNavigable(realm);
  if (!frame) return;
  frameContentWindow(frame);
  if (dom.parkedNavigable(realm) == null) return;
  dom.unparkNavigable(realm);
  if (globalThis.__csim_windowProxiesGone) globalThis.__csim_windowProxiesGone(realm);
};
export function frameContentDocument(frame) {
  const w = frameContentWindow(frame);
  if (!w) return null;
  // HTML "the content document": a frame's document is only reachable when its origin is same origin-domain with its
  // container's node document's — THIS realm's — a cross-origin frame's `contentDocument` null (its WindowProxy stays
  // accessible via `contentWindow`). Compare the frame's document origin — its raw child global's realm's, not the
  // WindowProxy's — against this realm's, by their keys and domains (`__csimIsSameOriginDomainWindow`): an opaque
  // origin same with the windows that share it alone (a child that inherited it), never with another opaque one,
  // whatever both serialize to. Fail CLOSED if the origin can't be read.
  const raw = globalThis.__csimFrameWindow ? globalThis.__csimFrameWindow(frame) : null;
  if (raw && !isSameOriginDomainWindow(raw)) return null;
  return w.document;
}

// A sheet owner's CSSStyleSheet, made in this realm (`sheetOfOwner` asks the realm the owner is in)…
NATIVE_REALM.sheetOf = (owner) => {
  if (nodeTypeOf(owner) === NODE_PI) return piSheet(owner);
  return tagOf(owner) === 'link' ? linkElementSheet(owner) : styleElementSheet(owner);
};
// …the owner's CSSStyleSheet of the engine sheet `made` (cascade.js `ownerSheet`, `fetchedSheet`), made in THIS realm,
// whose sheet store `made`'s id is of — not by a method of the owner's, which an owner adopted from another realm runs
// in its old one, whose store holds another sheet by that id: the one it has while that is the same sheet, a new one
// once it was made again.
function ownerSheetView(owner, made, fields) {
  const had = ownerSheetOf(owner);
  if (had !== null && slotsOf(had, 'CSSStyleSheet').id === made.id && rareDataOf(owner).sheetRev === made.rev) return had;
  dropSheet(owner);
  const rare = rareDataOf(owner, true);
  rare.sheet = ownedStyleSheet(made.id, owner, fields);
  rare.sheetRev = made.rev;
  dom.ownerSheetShown(nidOf(owner));
  return rare.sheet;
}
// …a connected `<style>`'s (CSSOM): a view of the style engine's sheet of its block (cascade.js `ownerSheet`), which
// follows the block's text — so an earlier-inserted script observes a later-inserted `<style>` already applied.
// Disconnected → null.
function styleElementSheet(style) {
  if (!isConnected(style) || !styleElementIsCss(style)) return dropSheet(style);
  return ownerSheetView(style, ownerSheet(style), { media: attrsOf(style).media || '' });
}

// …a connected `<link rel=stylesheet>`'s (CSSOM `LinkStyle.sheet`): its loaded sheet — the resource
// fetch is synchronous, so the sheet is there as soon as the link is connected (an earlier script observes it). A
// `<link disabled>` obtains none (HTML): it is absent from document.styleSheets and contributes nothing to the cascade —
// the disabling `setAttribute` orphaned any sheet it had. Disconnected → null, and failed — a network error, a status
// not ok, a type not text/css — null too: HTML creates a CSS style sheet only where it succeeded. One object for as
// long as the owner's engine sheet is the same one.
function linkElementSheet(link) {
  const href = attrsOf(link).href;
  if (!isConnected(link) || !(linkTypesOf(attrsOf(link).rel) & LINK_STYLESHEET) || !href || attrsOf(link).disabled != null) return dropSheet(link);
  const made = fetchedSheet(link);
  return made ? ownerSheetView(link, made, { href: resolveURLValue(link, href) ?? href, media: attrsOf(link).media || '' }) : dropSheet(link);
}

// Constraint validation (HTML §4.10.20), the listed elements' members: the constraints a control suffers from are the
// arena's (validity.rs — valueMissing by the radio group, the placeholder label option, mutability; pattern compiled
// with `v`; the email and url grammars; tooLong / tooShort after a user edit; range and step, a reversed range
// included; badInput; customError), read through a live ValidityState, the same object every time.
export const constraintValidationMembers = {
  get_validity: (control) => sameObject(control, 'validity', liveValidityState),
  // (…none for a control barred from validation (willValidate false), else its custom one or the user agent's: validity.rs
  // `validation_message`)
  get_validationMessage: (control) => validationMessageOf(control),
  // (…a candidate for constraint validation, validity.rs `will_validate`: a submittable control of a validating kind,
  // not actually disabled, not readonly, not in a `<datalist>`)
  get_willValidate: (control) => willValidateOf(control),
  checkValidity: (control) => checkValidityOf(control),
  reportValidity: (control) => reportValidityOf(control),
  // (…a custom error flips `:valid` / `:invalid`, dynamic pseudo-classes: the engine's write moves the style state)
  setCustomValidity(control, message) {
    setCustomValidityOf(control, message === '' ? 0 : CUSTOM_ERROR, message);
  }
};
// A control's validity, live — or a form-associated custom element's, its internals' `validity`.
const liveValidityState = (el) => validityStateOf(() => validityFlagsObject(validityFlagsOf(el)));
// Whether `el` is a candidate for constraint validation that suffers from a constraint (a form-associated custom element
// by the flags its internals were given)…
const suffersConstraintFailure = (el) => willValidateOf(el) && validityFlagsOf(el) !== 0;
// …and `checkValidity()`'s steps: such a one fires a cancelable, non-bubbling `invalid` and answers false (Discourse's
// form-template-validation listens for it to populate its errors)…
function checkValidityOf(el) {
  if (!suffersConstraintFailure(el)) return true;
  fireEvent(el, new Event('invalid', { __proto__: null, bubbles: false, cancelable: true }));
  return false;
}
// …and `reportValidity()`'s: the problem then reported where its `invalid` was not canceled — the element takes focus,
// or a form-associated custom element's validation anchor, the one its internals' `setValidity` named (Chrome 155 and
// Firefox; the user agent's error tooltip is not rendered).
function reportValidityOf(el) {
  if (!suffersConstraintFailure(el)) return true;
  if (fireEvent(el, new Event('invalid', { __proto__: null, bubbles: false, cancelable: true }))) reportProblem(el);
  return false;
}
const reportProblem = (el) => focusElement(rareDataOf(el)?.validationAnchor ?? el);
// HTML "statically validate the constraints" of a form: its controls that suffer from a constraint found first, then
// each fired a cancelable, non-bubbling `invalid` — so that a handler's change to another control decides nothing —
// and those whose event was not canceled answered (the unhandled ones), or null where none suffers (a positive result).
function staticallyValidate(form) {
  // (…its controls, not `form.elements`, which a control named so shadows)
  const invalid = formControlElements(form).filter(suffersConstraintFailure);
  if (invalid.length === 0) return null;
  return invalid.filter((el) => fireEvent(el, new Event('invalid', { __proto__: null, bubbles: false, cancelable: true })));
}
// …a form's checkValidity(): whether that is positive…
export const formCheckValidity = (form) => staticallyValidate(form) === null;
// …and "interactively validate the constraints" (its reportValidity(), a submission's): the problem reported at the first
// unhandled control, as its own reportValidity() reports it.
export function formReportValidity(form) {
  const unhandled = staticallyValidate(form);
  if (unhandled === null) return true;
  if (unhandled.length !== 0) reportProblem(unhandled[0]);
  return false;
}

// Text-field selection (HTMLInputElement / HTMLTextAreaElement) — the engine's (text_selection.rs: where the selection
// APIs apply, the offsets clamped to the value, "set the selection range", `setRangeText()`). Here the errors those
// name, and what a change of the selection sends: a TRUSTED `select` (bubbles, not cancelable) on an element task —
// never synchronously: a caller reads the new offsets at once, `select` lands on the next task
// (textfieldselection/select-event.html) — and a selectionchange.
// (…the control's selection as `[start, end, direction, set]`, null where none applies)
const selectionOfControl = (control) => nidOf(control) == null ? null : dom.textSelection(nidOf(control), true);
// (…or, where none applies, a thrown InvalidStateError — naming the type state, as Chrome does)
const notApplicable = (control) => new DOMException(
  "The input element's type ('" + inputTypeState(control) + "') does not support selection.", 'InvalidStateError');
function requiredSelection(control) {
  const sel = selectionOfControl(control);
  if (sel === null) throw notApplicable(control);
  return sel;
}
// "Set the selection range" — the one point that changes the offsets and sends `select`; whatever a line-wise move left
// the caret with goes, the same offsets set again included (Chrome: End, `setSelectionRange` to where it is, Home goes
// to the next line's start).
function setSelectionRange(control, start, end, direction) {
  forgetCaretMove();
  if (!dom.setTextSelection(nidOf(control), start, end, direction)) return;
  queueTask(() => {
    try {
      fireEvent(control, new Event('select', { __proto__: null, bubbles: true, cancelable: false }));
    } catch (_) {}
  }, 0);
  globalThis.__csimScheduleSelectionChange(control);
}
// `setRangeText(replacement, start, end, selectMode)`: the value the engine makes of it, written as the live value (it
// sets the dirty value flag, so `defaultValue` and a form reset keep the default; a programmatic edit, it never makes a
// focused control fire `change` on blur), and then the selection it says. Redmine's list-autofill controller calls it
// with `'start'` to remove a list marker when Enter is pressed on an empty item.
function setRangeText(control, replacement, start, end, selectMode) {
  const answer = dom.rangeTextEdit(nidOf(control), String(replacement), start, end, selectMode);
  if (answer === 1) throw notApplicable(control);
  if (answer === 2) throw new DOMException('The index is not in the allowed range.', 'IndexSizeError');
  setControlLiveValue(control, answer[0]);
  setSelectionRange(control, answer[1], answer[2], answer[3]);
}
export const textFieldSelectionMembers = {
  get_selectionStart(control) {
    const sel = selectionOfControl(control);
    return sel === null ? null : sel[0];
  },
  set_selectionStart(control, v) {
    const [, end, direction] = requiredSelection(control);
    setSelectionRange(control, v, Math.max(end, v), direction);
  },
  get_selectionEnd(control) {
    const sel = selectionOfControl(control);
    return sel === null ? null : sel[1];
  },
  set_selectionEnd(control, v) {
    const [start, , direction] = requiredSelection(control);
    setSelectionRange(control, start, v, direction);
  },
  get_selectionDirection(control) {
    const sel = selectionOfControl(control);
    return sel === null ? null : sel[2];
  },
  set_selectionDirection(control, v) {
    const [start, end] = requiredSelection(control);
    setSelectionRange(control, start, end, String(v));
  },
  setSelectionRange(control, start, end, direction) {
    requiredSelection(control);
    setSelectionRange(control, start, end, direction);
  },
  // (…its overloads: the replacement over the selection, or over a range with a selection mode)
  setRangeText_replacement: (control, replacement) => setRangeText(control, replacement),
  setRangeText_replacement_start_end_selectionMode: (control, replacement, start, end, selectMode) =>
    setRangeText(control, replacement, start, end, selectMode),
  select: selectAllText
};
// "selectAll" — execCommand's and Ctrl+A's — in what the engine answers (editing_commands.rs `command_target`): a
// cancelable `selectstart` first, and where none canceled it everything in it selected — a text control's value, else
// the element's content (an editing host's, the body's, the document element's), else nothing, the selection emptied
// (the Editing draft's selectAll). As Chrome has it: the `selectstart` is at a page's body (none with no body), at a
// text control itself, at an editing host in a shadow tree that tree's host; and what the listener changed is what is
// selected — the page's body read again, a host or a control taken out of the document, or a control no longer
// focused, selecting nothing.
export function selectEverything(doc, node) {
  const page = node === null || node === bodyOf(doc) || node === documentElementOf(doc);
  const control = !page && (isHtml(node, 'input') || isHtml(node, 'textarea'));
  const target = page ? bodyOf(doc) : control ? node : relativeOf(relativeOf(node, RELATIVE_ROOT), RELATIVE_HOST) ?? node;
  if (target !== null) {
    let canceled = false;
    try {
      canceled = !fireEvent(target, new Event('selectstart', { __proto__: null, bubbles: true, cancelable: true }));
    } catch (_) {}
    if (canceled) return;
  }
  if (page) node = bodyOf(doc) ?? documentElementOf(doc);
  else if (relativeOf(node, RELATIVE_SHADOW_INCLUDING_ROOT) !== doc || (control && focusedElementOf(doc) !== node)) return;
  if (node === null) globalThis.__csimCollapseSelection(null, 0, doc);
  else if (control) selectAllText(node);
  else globalThis.__csimSelect(node, 0, node, childCountOf(node, false), doc);
}
// HTML "select()": select all the text — of an email field too, whose selection offsets read null (Chrome) — and focus
// it, as browsers do. Over the RAW value: an email field's typed " foo@bar " is selected whole, though its `.value` is
// "foo@bar"; a clean <textarea>'s is its child text. (…and Ctrl+A's in a text control: form-fields.js)
export function selectAllText(control) {
  if (nidOf(control) == null || !dom.selectionApplies(nidOf(control), true)) return;
  focusElement(control);
  setSelectionRange(control, 0, String(controlLiveValue(control)).length, 'none');
}

// A text control's (a value-mode input's, a textarea's) `value` set: its live value — the dirty value flag set, the
// `value` attribute / child text (its default) left as it is, so `defaultValue` keeps reporting it and `<form>.reset()`
// restores it — sanitized by its type for an input, its newlines normalized (CRLF / CR → LF) for a textarea. A
// programmatic set is no user edit: tooLong / tooShort stop suffering, and it makes no `change` on blur. Only where the
// value CHANGES does the text entry cursor move to its end (HTML "set the value"); the same value leaves the selection
// and fires no `select`. (That runs for every text control: the caret matters for a non-selectable type too — a number
// field's typing position; a stale offset surfacing once the type becomes selectable is `set type`'s to reset.) `old`
// its value before — an input's `value` getter's (html-input.js), a textarea's its live value.
export function setTextControlValue(control, value, old = controlLiveValue(control)) {
  const next = sanitizedValueOf(control, tagOf(control) === 'input' ? inputTypeState(control) : 'textarea', value);
  setControlLiveValue(control, next);
  setStateBit(control, STATE_DIRTY_BY_USER, false);
  if (next !== old) moveTextEntryCursor(control, next.length);
}

// `showPicker()` — we have no native picker UI, but the observable contract is the precondition checks, the engine's
// (user_activation.rs `showPickerRefusal`): an InvalidStateError where the control is not mutable (disabled, or readonly
// on a type readonly applies to), a SecurityError where its document is cross-origin with the top-level one (a file or
// a colour input exempt), then a NotAllowedError without transient user activation, which a successful call consumes.
export function showPickerSteps(control) {
  const iface = tagOf(control) === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement';
  const refusal = dom.showPickerRefusal(control);
  if (refusal === 0) return;
  const [message, name] = PICKER_REFUSALS[refusal];
  throw new DOMException(`Failed to execute 'showPicker' on '${iface}': ${message.replaceAll('%', iface)}`, name);
}
const PICKER_REFUSALS = [
  null,
  ['The element is disabled.', 'InvalidStateError'],
  ['The input element is read-only.', 'InvalidStateError'],
  ['%::showPicker() called from cross-origin iframe.', 'SecurityError'],
  ['%::showPicker() requires a user gesture.', 'NotAllowedError']
];

// A template's contents: an inert DocumentFragment, made on first use for one the parser did not fill — its node
// document the template's document's associated INERT TEMPLATE DOCUMENT, a real separate Document, so inserting a node
// into it is a cross-document adopt (adoptedCallback fires) and `content.ownerDocument !== document` as in browsers.
export function templateContent(template) {
  if (!templateContentsOf(template)) {
    const content = nodeMadeFor(inertTemplateDocFor(nodeDocumentOf(template)), DocumentFragment, undefined, undefined, template);
    setCeRegistryOf(content, TRACKING_NULL);
    // …kept beside the template, in its tree's arena — another realm's, for one in a frame's document — and linked
    // there: a fragment WITH A HOST (DOM: adoptNode no-ops on it), which the template serializes.
    registerBeside(content, template);
    setTemplateContentOf(template, content);
  }
  return templateContentsOf(template);
}

// A labelable control's `labels` (see `get labels` on Element).
export function labelsOf(control) {
  // [SameObject]: the same live NodeList instance is returned on every access.
  // Build it once and cache it on the element; it is live (re-walked on settle-
  // gen bump) so it tracks moves/removals and empties out when the control
  // stops being labelable (e.g. an input toggled to type=hidden).
  const labels = sameObject(control, 'labels', () => liveNodeList(() => labelsFor(control)));
  // input[type=hidden] is not a labelable element → null. The cached list is
  // kept so a later type change returns the SAME NodeList object.
  return isLabelableControl(control) ? labels : null;
}

class Element extends Node {
  // `ns` / `localName` / `prefix` default to an HTML element named `tagName` lowercased; the parser's foreign content,
  // `createElementNS`, the XML parser and a clone pass their own — through `createElementNode`, which also gives the
  // element its interface prototype from birth.
  constructor(token, tagName, ns = HTML_NS, localName = undefined, prefix = null) {
    constructedBy(PLATFORM, token, 'Element');
    // An upgrade's `super()` (HTML's HTML element constructor, steps 9-15): the element on the construction stack of the
    // definition an upgrade constructs by NewTarget — the engine's, the agent's, as an upgrade in one realm constructs by
    // another's interface — given NewTarget's prototype and left "already constructed", a TypeError for a second
    // `super()` of it. Not an element another constructor makes, before or after it, which is made as any other. (Every
    // element its interface constructor makes — no name given — asks the count alone: `ceStack[3]`.)
    if (!tagName && ceStackView()[3] !== 0) {
      const upgraded = dom.ceConstructionTop(new.target);
      if (upgraded !== undefined) {
        const prototype = new.target.prototype;
        if (upgraded === null) throw new TypeError("Failed to construct 'HTMLElement': This instance is already constructed");
        // (…an ordinary object's [[SetPrototypeOf]] refused — one a page made non-extensible — returns false, no abrupt
        // completion: the element keeps its prototype and is constructed, as Chrome has it)
        if (prototype !== null && (typeof prototype === 'object' || typeof prototype === 'function')) Reflect.setPrototypeOf(upgraded, prototype);
        dom.ceMarkConstructed(new.target);
        return upgraded;
      }
    }
    // A custom element's constructor calls `super()` with no name: the one "create an element" made it under
    // (`currentCreation`), else — a DIRECT `new MyCustomElement()` — the one it is defined under (the HTMLElement
    // constructor's "look up definition by NewTarget").
    const creation = currentCreation !== null && new.target === currentCreation.def.ctor && !makingEngineObject() ? currentCreation : null;
    if (creation !== null) currentCreation = null;
    let tag = tagName || (creation && creation.tag), direct;
    if (!tag && new.target) {
      // DIRECT `new MyCustomElement()` (no createElement tag, no pending upgrade): the definition's local name — for a
      // customized built-in, the extended built-in tag, plus its is value (the definition name) so the element and any
      // later clone re-resolve the definition by local name + is value. The lookup is GLOBAL-registry-only (HTML: "look
      // up... in the current global object's registry"): a constructor defined only in scoped registries fails here.
      direct = globalDefinitionOf(new.target);
      if (direct === undefined && ctorHasAnyDefinition(new.target)) {
        throw new TypeError('Illegal constructor: the custom element constructor is not registered with the global custom element registry.');
      }
      tag = direct?.localName;
    }
    // Its name, its identity's (node-identity.js): the tag ASCII-lowercased, as `createElement` and the parser lowercase
    // a name (`<x-Ä>` stays `x-Ä`) — what the matcher and the cascade compare — and its local name as given.
    const lower = asciiLower(String(tag || ''));
    if (localName === undefined) localName = lower;
    const self = namedNodeObject(new.target, NODE_ELEMENT, ns, prefix, localName, lower);
    // (…its registry set before the constructor runs, which reads it as `this.customElementRegistry`)
    if (creation !== null && creation.registry !== undefined) setCeRegistryOf(self, creation.registry);
    // Its native arena node, made NOW, so its attribute store is the arena's from construction (`attrsOf`, the
    // attrsView over it) — no JS object ever backs a rendered element's attributes.
    registerNativeElement(self, localName, ns, prefix);
    // A custom element its constructor makes — a direct `new MyCE()`, or the one "create an element" constructs
    // synchronously — has the current global object's associated Document its node document as the constructor runs
    // (HTML's HTMLElement constructor steps: what it attaches a shadow root to and appends into is in a document). The
    // direct one constructs custom; the other is custom as its constructor runs (what it attaches is available to its
    // internals).
    if (direct !== undefined || creation !== null) constructedInto(self, false);
    if (direct !== undefined) {
      if (direct.localName !== direct.name) setIsValue(self, direct.name);
      becomeCustom(self, direct);
    } else if (creation !== null) {
      becomeCustom(self, creation.def);
    }
    // A `<form>` is wrapped in its named/indexed-property Proxy (see FORM_HANDLER):
    // `form.<control>` / `form[i]` resolve controls, with own-property descriptors
    // for Object.getOwnPropertyDescriptor / defineProperty / delete. The Proxy IS
    // the form everywhere (returned here), so identity holds — a customized built-in's too, whose own class prototype
    // the target keeps. MUST be the ctor's last statement — the returned object replaces `this`. A `<select>` likewise
    // (SELECT_HANDLER), its indices its options.
    if (ns === HTML_NS && localName === 'form') return makeFormProxy(self);
    if (ns === HTML_NS && localName === 'select') return makeSelectProxy(self);
    return self;
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








  // An SVG `<a>`'s `rel` (HTML's elements' are their interfaces'), on the shared
  // prototype: the driver gives SVG elements no interface of their own.
  get rel() { return attrsOf(this).rel == null ? '' : String(attrsOf(this).rel); }
  set rel(v) { setAttribute(this, 'rel', String(v)); }


  // An SVG `<a>`'s `relList`, a [SameObject, PutForwards=value] DOMTokenList over
  // `rel` (HTML's elements' are their interfaces'); `undefined` on any other.
  get relList() {
    return isSvg(this, 'a') ? tokenListFor(this, 'rel') : undefined;
  }
  set relList(v) {
    const list = this.relList;
    if (list) list.value = v == null ? '' : String(v);
  }

}
// HTML's focusing steps — HTMLOrSVGElement's `focus()` (htmlElementMembers) and the driver's own focusing, which a
// page's `focus` never replaces.
// Focus tracking: record `document.activeElement` and emit
// focus / focusin / blur / focusout events so listeners observing
// either path (`onfocus="..."` attribute, addEventListener, or
// jQuery's `.focus(handler)`) actually fire. `:focus` pseudo-
// class matches the element the engine holds focused (`setFocusedElement`).
export function focusElement(el) {
  // (…an element of another realm's arena — a frame's autofocus candidate, flushed by the top-level document — by its
  // own realm, whose window, selection, focus chain and event loop they are: `REALM`)
  const realm = foreignRealmOf(el);
  if (realm !== null) {
    realm.focusElement(el);
    return;
  }
  // What it focuses is the engine's (focus.rs `focus_target`): a shadow host with delegatesFocus is no focusable area
  // — focusing it focuses the one it stands for, the focused element where that is under it already, else its focus
  // delegate (its shadow tree's first `autofocus` one, else its first one), which becomes the shadow tree's
  // activeElement while document.activeElement retargets up to the host (shadow-dom/focus/
  // focus-method-delegatesFocus.html, focus-autofocus.html); a label that is not itself focusable (no valid
  // `tabindex`, or not rendered) forwards focus to its labeled control, like the click hop; and focusing an element
  // that is no focusable area does nothing (HTML focusing steps). Without that last, Discourse's DMenu close path
  // (closes its toolbar then `.focus()`s the trigger SPAN — a `<span class="composer-image-node">` with no
  // tabindex/role) was mutating `document.activeElement`, so PM's strict `hasFocus()` (root.activeElement ===
  // view.dom) returned false on the next dispatch and `selectionToDOM` bailed — leaving the caret behind when Enter
  // inserted a new paragraph after a selected image.
  const target = styleEngineFocusTarget(el);
  if (target) focusUpdate(target);
}
// HTML's focus update steps, focusing this focusable area.
function focusUpdate(el) {
  // (…in the document it is in, which an element made in another realm's document and adopted here is too)
  const doc = nodeDocumentOf(el);
  const prev = focusedElementOf(doc);
  if (prev === el) {
    // Already focused: no blur/focus churn, but re-evaluate :focus-visible — a
    // keyboard re-interaction (send_keys/Tab onto the current element) flips the
    // ring back on. The modality (the engine's: dom.rs `latchFocusRing`) is the
    // last DRIVER action (pointer/keyboard set at the click/Tab/send_keys entry points),
    // not a true last-input bit, so it stays sticky until the next driver action.
    latchFocusRing(el);
    // (…its document's focused area already, though maybe not the top-level traversable's — the focus gone to a
    // sibling frame since: HTML returns early only for that one, so the focus comes back into this document)
    noteFocusChain(el);
    return;
  }
  // HTML focus update steps: while the OUTGOING element fires its blur /
  // focusout, no element is the "currently focused area" — `document.
  // activeElement` is <body> and `:focus` matches nothing (verified against
  // Chrome). So clear the focused element (`activeElement` falls back to <body>) for
  // the duration of those events, and commit `el` only just before its own
  // focus / focusin. This also makes focus() re-entrant-safe: a blur/focusout
  // handler that synchronously moves focus — Discourse's ProseMirror alt-text
  // `onBlur → saveAltText → onSave → view.focus()` — now finds no element to
  // re-blur, so the old unbounded focus↔blur loop (which overflowed the stack,
  // threw a RangeError, was caught, and retried forever) can't form; the
  // handler completes the transition itself and the re-check below bails so we
  // neither double-fire focus nor clobber the target it chose. (`blur()` below
  // likewise clears the focused element before dispatching.)
  setFocusedElement(doc, null);
  if (prev) loseFocus(prev, el);
  // A blur/focusout handler above may have already moved focus (to `this` or
  // elsewhere). If so it owns the result — don't re-fire focus or override it.
  if (focusedElementOf(doc) !== null) return;
  setFocusedElement(doc, el);
  noteFocusChain(el);
  // (…a text control's `change` armed for its blur)
  dom.changeArm(nidOf(el));
  // `:focus-visible` latch: the focus ring shows unless this focus was driven
  // by a pointer (input handlers set the modality), and ALWAYS shows
  // for text-entry controls (real browsers always render their focus ring,
  // regardless of how focus arrived). Latched at focus time; the matcher reads
  // it. (shadow-dom/focus/focus-click-on-shadow-host.html)
  latchFocusRing(el);
  // An editing host focused with no selection in it gets the caret at its first caret position; one in it stays — the
  // engine's (caret_moves.rs `focusCaret`). PM / Tiptap's beforeinput handler computes its edits from the selection,
  // and bails without one.
  if (isContenteditable(el)) {
    feedStyleEngineSheets();
    const first = dom.focusCaret(el, globalThis.__csimSelectionState(globalThis.document));
    if (first) globalThis.__csimCollapseSelection(first[0][0], first[1]);
  }
  // focus/focusin on the element gaining focus carry relatedTarget = the
  // element that lost it (retargeted across shadow boundaries by dispatch).
  fireEvent(el, new FocusEvent('focus',    { __proto__: null, bubbles: false, cancelable: false, composed: true, view: globalThis, relatedTarget: prev }));
  fireEvent(el, new FocusEvent('focusin',  { __proto__: null, bubbles: true,  cancelable: false, composed: true, view: globalThis, relatedTarget: prev }));
  // A customizable `<input list>` opens its `<datalist>` popover on focus.
  showComboboxDatalist(el);
  // (…a `:focus`-conditioned style may make the just-focused element non-rendered (`#host:focus { display: none }`):
  // the focus is committed now, so `getComputedStyle(host).display` reads 'none' right after focus(), and the next
  // rendering update's focus fixup — `__csimFocusFixup` — resets it to the viewport, `:focus` matching no more)
  if (!isFocusable(el)) oweFrame();
}
// Focus went into this container's frame (the frame document's `setFocusedElement` asks this realm, the container's:
// `REALM`): the element focused here loses it as to any other — its pending change, blur, focusout — and the container
// is this document's.
function takeFocusFromFrame(el) {
  const doc = globalThis.document;
  const prev = focusedElementOf(doc);
  if (prev === el) return;
  setFocusedElement(doc, null);
  if (prev) loseFocus(prev, null);
  if (focusedElementOf(doc) === null) setFocusedElement(doc, el);   // (unless a blur handler moved it)
}
// HTML's unfocusing steps — HTMLOrSVGElement's `blur()`.
export function blurElement(el) {
  const realm = foreignRealmOf(el);
  if (realm !== null) {
    realm.blurElement(el);
    return;
  }
  const doc = nodeDocumentOf(el);
  let target = el;
  if (focusedElementOf(doc) !== el) {
    // A delegatesFocus host: the focused element lives in its shadow tree, but the
    // tree the host is in sees the host focused — so blur() on the host unfocuses the
    // delegated element, one nested in another such host's shadow tree too (Chrome).
    // (A slotted light-DOM element that has focus is NOT delegated: its tree sees the
    // slotted element, not the host, so this branch is skipped and blur() no-ops.)
    const sr = shadowRootOf(el);
    if (sr && shadowIs(sr, SHADOW_DELEGATES_FOCUS) && activeElementOf(relativeOf(el, RELATIVE_ROOT)) === el) {
      target = focusedElementOf(doc);
    } else {
      return;
    }
  }
  setFocusedElement(doc, null);
  // Blurring an `<iframe>` takes focus out of its nested context, so the focus chain
  // falls back to the document that owns the container — the mirror image of focus()
  // handing it down. (Blurring any other element leaves the browsing context alone.)
  if (frameRealmOf(el) != null) noteFocusChain(null);
  // (…the unfocusing steps: a text control commits a pending `change` first, iff its value changed since it gained
  // focus, then `blur` / `focusout`, and its datalist's popup goes)
  loseFocus(target, null);
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
// viewport's there too (`styleEngineScrollHolder`), so `scrollHeight - clientHeight - scrollTop` stays one question. A
// quirks body that scrolls ITSELF is no such element (Chrome: its own 3000, not the viewport's).
function isViewportElement(el) {
  const doc = nodeDocumentOf(el);
  return !!doc && el === styleEngineScrollingElement(doc);
}
// HTML "submit a form" — the interactive entry shared by requestSubmit() and a
// submit-button activation: it runs constraint validation and fires the submit
// event before constructing the entry list.
// (…an image submitter's selected coordinate is this submission's alone: the next starts from the origin)
export function submitForm(form, submitter, interactive) {
  try {
    return runFormSubmit(form, submitter, !interactive);
  } finally {
    if (submitter) forgetSelectedCoordinate(submitter);
  }
}
// The interactive submission's validation (HTML "submit a form" step 6): every control's user validity is set —
// `:user-invalid` shows on the ones that stop it — and, unless the form or its submitter says `novalidate`, the
// constraints are interactively validated (`invalid` fired at each control that fails). False when the submission
// must stop. Every interactive entry asks it: requestSubmit, a submit button's activation — Capybara's
// click_button included — and implicit submission.
function validatesForSubmission(form, submitter) {
  const controls = formControlElements(form);
  for (const form of controls) markUserValidity(form);
  if (attrsOf(form).novalidate != null || (submitter != null && attrsOf(submitter).formnovalidate != null)) return true;
  return formReportValidity(form);
}
// HTML "submit a form" (4.10.22.3), the steps we model, in spec order.
// `fromSubmitMethod` true ⇒ the caller is form.submit() (skips firing the
// submit event and constraint validation; steps 5a–5h). The two re-entrancy
// flags are kept distinct, matching the spec (element-flags.js):
//   FORM_FIRING_SUBMISSION_EVENTS — set while validating / firing `submit`; a
//                              nested interactive submit (requestSubmit / button
//                              click inside an `invalid` / `submit` handler) bails.
//   FORM_CONSTRUCTING_ENTRY_LIST  — set while building the entry list / firing
//                              `formdata`; a nested submit of ANY kind, INCLUDING
//                              form.submit(), bails (step 2).
// Whether it can navigate is re-checked after the submit event and again after `formdata`,
// so a handler that removes the form from the document aborts the navigation.
export function runFormSubmit(form, submitter, fromSubmitMethod) {
  if (!isHtml(form, 'form')) return false;
  if (cannotNavigate(form)) return false;          // step 1
  if (elementFlag(form, FORM_CONSTRUCTING_ENTRY_LIST)) return false;   // step 2
  if (formsRefused(form)) return false;                                  // step 4: no `allow-forms`
  if (!fromSubmitMethod) {
    if (elementFlag(form, FORM_FIRING_SUBMISSION_EVENTS)) return false;   // step 5: nested interactive submit
    setElementFlag(form, FORM_FIRING_SUBMISSION_EVENTS, true);
    try {
      if (!validatesForSubmission(form, submitter)) return false;
      const ev = new SubmitEvent('submit', { __proto__: null, bubbles: true, cancelable: true, submitter: submitter || null });
      if (!fireEvent(form, ev)) return false;
    } finally { setElementFlag(form, FORM_FIRING_SUBMISSION_EVENTS, false); }
  }
  // Then re-check the form can still navigate (a handler may have removed it), construct the entry list (`new
  // FormData` fires `formdata` exactly once and toggles the constructing-entry-list flag), re-check again (a
  // `formdata` handler may have removed it).
  if (cannotNavigate(form)) return false;
  const entryList = submissionFormData(form, submitter);
  if (cannotNavigate(form)) return false;
  // A `dialog` method — the submitter's `formmethod`, else the form's `method`, as the engine resolves them
  // (form_entries.rs `formSubmission`) — closes the form's nearest ancestor dialog with the result the engine gives
  // (the submitter's value, an image button's selected coordinate) rather than navigating.
  const [, method, , , , , dialogResult] = dom.formSubmission(nidOf(form), submitter ? nidOf(submitter) : -1, '');
  if (method === 'dialog') {
    closeDialog(htmlAncestorOf(form, 'dialog', false), dialogResult);
    return true;
  }
  // Plan the navigation with that list, so a handler's mutations are honoured.
  recordFormSubmission(form, submitter || null, entryList, fromSubmitMethod);
  return true;
}
// HTMLElement's `click()` (htmlElementMembers) — and the driver's, which a page's `click` never replaces: HTML "fire a
// synthetic pointer event" named click, its activation the dispatch's (`activationBehavior`), as any click's. jQuery
// clicks a hidden submit button, Rails-UJS a confirmed action's, Avo a filter's hidden link.
// `user`: what the user whose action clicks it holds — the keys of a keyboard's activation or of an implicit
// submission's default button; the keys, pointer and point of a click a label passes on — its click then trusted,
// theirs, carrying them (Chrome's); none for a script's `click()`.
export function clickElement(el, user = null) {
  // (…none at all of a disabled form control: no event, no activation — a script's `dispatchEvent` of one still fires;
  // and none of one whose click is in progress: a listener's `click()` of the element it is clicking — HTML `click()`
  // step 2, its "click in progress flag")
  const realm = documentRealmOf(el);
  if (realm !== null) {
    inRealm(realm, 'clickElement', el, user);
    return;
  }
  if (isActuallyDisabled(el) || clicksInProgress.has(el)) return;
  clicksInProgress.add(el);
  // (…a PointerEvent of no pointer (-1, no type), composed — it crosses shadow boundaries to the host — its view the
  // window, Chrome's and Firefox's; one at no point selects no coordinate: an image button's activation by it submits
  // the origin)
  const ev = new PointerEvent('click', { __proto__: null, bubbles: true, cancelable: true, composed: true, view: globalThis, pointerId: -1, ...user });
  eventState(ev).noPoint = !(user && user.clientX !== undefined);
  try {
    if (user) dispatchEventForUserAction(el, ev);
    else      dispatchEvent(el, ev);
  } catch (_) {
  } finally {
    clicksInProgress.delete(el);
  }
}
// HTML "navigate" this frame's navigable, the steps it runs at once: the navigation its latest (a load it queued for an
// earlier one fires for nothing), and the rest — its document asked whether it may be unloaded, its response fetched, that
// document unloaded, the next one made, its `load` — queued as a task (`__csim_onFrameSrcAssigned`), the old document the
// frame's until it runs. Shared by the src/srcdoc-reassignment path and `reloadFrame`. `navFrom` (a slot of the
// documents the navigation carries: frame-nav.js `FC_*`) preloads the document — used by reload to reuse a blob:'s
// retained bytes; null means rebuild from the current src/srcdoc.
// `historyUrl`: the session history entry the navigation pushes as it commits (a `src` change's), none for a reload;
// `url`: the URL it goes to, where it is no `src` — a navigation of the nested document from within.
// `prompted`: its document is asked no more — a traversal's, before its step; a javascript: URL's result, which HTML
// "navigate to a javascript: URL" replaces it with unasked.
export function renavigateFrame(el, navFrom, isReload = false, historyUrl = null, url = undefined, begun = undefined, prompted = false) {
  const oldRealmId = frameRealmOf(el);
  if (navigationIgnored(oldRealmId)) return;
  // The URL the navigation goes to is the one it starts with — a beforeunload handler rewriting `src` is a navigation
  // of its own, ignored (Chrome).
  // (…its `src` content attribute: the no-namespace one, as the build reads it — an `src` of another namespace is none)
  const navSrc = url !== undefined ? url : attrsOf(el).src ?? null;
  if (navFrom == null && oldRealmId != null && javascriptNavigation(el, oldRealmId, navSrc)) return;
  // (…its attributes' navigation, or a reload, begun now — not a javascript: URL's result, which HTML "navigate" makes
  // the document of with no ongoing navigation set, nor the host's, which cancelled it as it was planned
  // (frame_navigation.rs `planFrameLocation`) — cancelling a form's planned one: its request, not yet sent, never is —
  // Chrome and Firefox send none for `submit()` and then `src` / `srcdoc` set, or a reload)
  if (url === undefined && navFrom !== FC_NAV) {
    dom.cancelFrameNavigation(nidOf(el));
    frameNavigationFinalized(el);
  }
  if (navFrom != null) copyFrameContent(el, navFrom, FC_NAV);
  else setFrameContent(el, FC_NAV, null);
  setFrameNav(el, FN_LOAD_FIRED | FN_SRC_REFUSED, false);
  setFrameNavUrl(el, FN_URL_SRC, navSrc);
  // (…and the `sandbox` attribute it has now what the document it makes is sandboxed by — the one the host's navigation
  // began with, `begun`, where it carries it: frame_navigation.rs `begin`)
  dom.beginFrameNavigation(nidOf(el), begun);
  // Set the reload-navigation intent atomically with the re-navigation, so a FRESH nav
  // (a src/srcdoc change) resets it to false and a reload superseded before its build can't
  // leak isReloadNavigation=true onto the superseding navigation.
  setFrameNav(el, FN_RELOAD_NAV, isReload);
  setFrameNavUrl(el, FN_URL_HISTORY, historyUrl === null ? undefined : historyUrl);
  if (historyUrl === null) setFrameNav(el, FN_HISTORY_REPLACE, false);
  supersedeFrameNavigation(el);
  // The old document stays the frame's — its window the one `contentWindow` answers, as Chrome's does — until the
  // navigation's task (`__csimFrameWindow`, `commit`). A frame no task is coming for — one disconnected — unloads it now.
  if (!dom.frameNavigationBegins(nidOf(el), globalThis.__csim_onFrameSrcAssigned !== undefined, prompted)) {
    recordFrameHistory(el, oldRealmId);
    disposeFrameRealmForNav(oldRealmId, false, true);
    dom.setFrameRealm(nidOf(el), -1);   // re-navigation rebuilds the realm
  }
  if (!isConnected(el) || !globalThis.__csim_onFrameSrcAssigned) return;
  // (…its build a task, paced where the frame loaded this instant — a handler navigating it on every load:
  // `maybeFireFrameLoad`)
  globalThis.__csim_onFrameSrcAssigned(el);
}
// HTML "navigate" to a javascript: URL `src` of a frame that has a document, realm `realm`'s: no new document, the
// URL evaluated in that one (url-parse.js `runJavascriptURL`) — where it is of this document's origin, else the
// navigation ignored — and true; false for any other URL. (A frame with none yet builds its initial about:blank one
// to run it in: bridge.entry.js `FRAME_SOURCE_JAVASCRIPT`.)
function javascriptNavigation(el, realm, src) {
  const parsed = src == null ? null : parseURL(String(src), documentBaseURL(nodeDocumentOf(el)));
  if (parsed === null || parsed.protocol !== 'javascript:') return false;
  // (…its navigation the ongoing one from here, whatever comes of its URL: the one under way ended)
  dom.cancelFrameLocation(nidOf(el));
  frameNavigationFinalized(el);
  // (…by the origins' keys, the engine's: navigables.rs `navigationVerdict`)
  if (dom.navigationVerdict(globalThis.__csimRealmId(), realm, parsed.href, false) === 'navigate') {
    hostNamespace.contextGlobal(realm).__csimRunJavascriptURL(parsed.href);
  }
  return true;
}
// HTML "reload": re-navigate this nested browsing context to its CURRENT
// document (same URL — unlike a src change). `location.reload()` in a frame
// realm routes here (via reloadFrameByRealm) so it runs in the owning
// realm, never disposing the child realm while its own reload() is on the
// stack. A blob: frame reuses the bytes retained at build (frame-nav.js `FC_LOADED`)
// so reload still works after the blob URL was revoked (HTML keeps the blob
// alive for the loaded document's lifetime); other sources re-resolve from src.
export function reloadFrame(el) {
  if (!isHtml(el, 'iframe') && !isHtml(el, 'frame')) return;
  // Mark the imminent rebuild as a RELOAD navigation (isReload=true) so a controlling
  // service worker's fetch event sees `request.isReloadNavigation === true` (consumed +
  // cleared in __csimFrameWindow). Both location.reload() and history.go(0) route here.
  // (…the bytes of the document it loaded last — a blob: URL's, revoked since — where that is the one it reloads, its
  // fragment aside, and none where it went on to another since: that one's URL loaded again)
  const kept = frameContentUrl(el, FC_LOADED), reload = frameNavUrl(el, FN_URL_RELOAD);
  const unfragmented = (url) => url.split('#', 1)[0];
  if (kept != null && reload != null && unfragmented(kept) !== unfragmented(reload)) setFrameContent(el, FC_LOADED, null);
  renavigateFrame(el, FC_LOADED, true);
}
// Element's attribute steps (DOM §4.9), what its members and the driver's own code call — the engine's
// (attributes.rs): names and values strings (a value of any type its string: the driver's own callers pass numbers). Its
// reads are native-query-shadow.js's (`getAttribute` …).
export function setAttribute(el, name, value) { writeAttribute(el, ATTR_SET, name, String(value)); }
function setAttributeNS(el, namespace, qualifiedName, value) { writeAttribute(el, ATTR_SET_NS, namespace, qualifiedName, String(value)); }
// "set an attribute value" with the null namespace — distinct from setAttribute, which matches the first attribute by
// QUALIFIED name (so it would update a same-named attribute in ANOTHER namespace): a dataset write, its local name not
// colon-split (a `data-a:b` name is a valid attribute, not a prefix:local pair).
function setAttrValueNullNS(el, localName, value) { writeAttribute(el, ATTR_SET_NULL_NS, String(localName), String(value)); }
export function removeAttribute(el, name) { writeAttribute(el, ATTR_REMOVE, name); }
function removeAttributeNS(el, namespace, localName) { writeAttribute(el, ATTR_REMOVE_NS, namespace, localName); }
function removeAttrKey(el, key) { writeAttribute(el, ATTR_REMOVE_KEY, key); }
// (…what a reflected IDL attribute writes with: reflect.js)
setAttributeWriters(setAttribute, removeAttribute);
// …a bound Attr's `value` written (with the steps of setAttribute).
function setAttrNodeValue(el, key, value) { writeAttribute(el, ATTR_SET_KEY, key, value); }
// Stable, live Attr node for the attribute stored under `key`. Cached on the element so `getAttributeNode` returns the
// same identity each call.
export function attrNodeFor(el, key) {
  const cache = sameObject(el, 'attrNodes', () => ({}));
  let a = cache[key];
  if (!a) {
    const [ns, prefix, localName] = dom.attrName(el, key);
    // (…its node document its element's while it is one of them: none of its own to hold)
    const realm = makingRealmOf(el);
    a = realm !== null ? inRealm(realm, 'newAttr', localName, ns, prefix, attrsOf(el)[key]) : new Attr(PLATFORM, localName, ns, prefix, attrsOf(el)[key], null);
    bindAttr(a, el, key);
    cache[key] = a;
  }
  return a;
}
// Detach the cached Attr node (if any) at `key`, the attribute's value `value` gone with it: a held reference reads its
// last value and a null owner, per the DOM "remove an attribute" steps.
function detachAttrNode(el, key, value) {
  const nodes = rareDataOf(el)?.attrNodes;
  const a = nodes && nodes[key];
  if (!a) return;
  setAttrOwnValue(a, value);
  setNodeDocumentOf(a, nodeDocumentOf(el));   // (…its node document its element's, which it keeps)
  bindAttr(a, null, null);
  delete nodes[key];
}
// Bind a detached Attr into this element's attributes (setAttributeNode): the one of its namespace and local name
// replaced, else it appended.
function bindAttrNode(el, attr) {
  const made = changeAttribute(el, ATTR_BIND, namespaceOf(attr), prefixOf(attr), localNameOf(attr), attrOwnValueOf(attr));
  const key = made[1];
  setNodeDocumentOf(attr, null);   // (…its element's from here: none of its own to hold — `nodeDocumentOf`)
  bindAttr(attr, el, key);
  sameObject(el, 'attrNodes', () => ({}))[key] = attr;
  attributeChanged(el, made);
}
// HTML "the directionality" of this element → 'ltr' | 'rtl' — the arena's (element_state.rs `is_rtl`), what `:dir()`
// matches: its own `dir` (`auto`, and a bare `<bdi>`, by the first strong character of its text or a text
// control's value), else its shadow-including parent's, ltr at the root. (`dirname` submits it.)
function directionalityOf(el) {
  return isRtl(el) ? 'rtl' : 'ltr';
}
// The resource URL an image element fetches: an <img>'s `src`, or an SVG <image>'s
// `href` (SVG2) falling back to the legacy XLink one (SVG1.1) — link-href.js `hrefAttr`,
// where an empty `href` still wins, as in Chrome and Firefox. Both feed the same load path
// so createPattern / drawImage can tell a broken href (throw) from an unavailable /
// zero-size one (null / no-op).
export function imageResourceSrc(el) {
  return imageSourceFor(el)?.[0];
}
// …and its pixel density with it: `[url, density]`, undefined for none.
function imageSourceFor(el) {
  if (isHtml(el, 'img')) {
    // (…its picture's selected `<source>`'s candidates or its own `srcset`'s over its `src`, the density the chosen one
    // has: image_source.rs)
    return imageSourceOf(el);
  }
  const src = isSvg(el, 'image') ? hrefAttr(el)
    // `<input type=image>` is an image button: its `src` is fetched like an `<img>` (its Resource
    // Timing entry's initiator 'input', as the engine files it: resource_timing.rs, J_IMAGE).
    : isHtml(el, 'input') && inputTypeState(el) === 'image' ? attrsOf(el).src : undefined;
  return src == null ? undefined : [src, 1];
}
// HTML "update the image data" for an image element — an HTML `<img>`, an SVG `<image>`, an HTML `<input type=image>`
// — of a document with a browsing context: one with none (a DOMParser's, `createHTMLDocument`'s, template contents')
// loads no image until an adoption brings it into one (`updateImagesIn`) — Chrome: a DOMParser document's image has
// no size, whatever sets its source.
// (…`stable`: its stable state come already, none to await — the parser's images)
export function loadImageResource(el, stable = false) {
  if (!isImageRequestElement(el)) return;
  const doc = nodeDocumentOf(el);
  if (doc === null || defaultViewOf(doc) === null) return;
  // A realm without the host decoder wired (an early-boot / stripped build) keeps
  // the pre-feature behavior: the element stays inert (no load, no error), rather than
  // reporting every image as broken.
  if (typeof globalThis.__csim_loadImage !== 'function') return;
  const [src, density] = imageSourceFor(el) ?? [];
  if (src == null || src === '') {
    // Clearing the src discards the current request (the engine's: unavailable, complete, not broken, no taint, a
    // load in flight superseded, and a later assignment of any src a new load) and its bitmap.
    dom.imageLoadClear(el);
    // (…and the decodes waiting on it rejected: HTML `decode()`, its current request changed)
    settleImageDecodes(el, false);
    return;
  }
  // Resolve against THIS element's base (frame documents — the raw attribute resolved Ruby-side against the MAIN
  // document, the recurring wrong-base class), which also lets RELATIVE srcs route through the SW.
  let abs = resolveURLValue(el, src) ?? src;
  // A load's identity is its URL AND its CORS mode (`crossorigin`): setting `crossorigin` AFTER
  // `src` in the same task (the browser coalesces both into one deferred "update the image data"
  // run) must re-fetch under the new mode and re-evaluate taint, not be skipped as a same-src
  // no-op. The new load supersedes the first (mode-stale) load's queued event, so only
  // the final load fires `load` — matching the single load a real browser dispatches. The request's URL —
  // `currentSrc` — is the one selected, from this point (Chrome sets it at source selection, before any response).
  const load = dom.imageLoadBegin(el, abs, attrsOf(el).crossorigin ?? null, density);
  if (load === 0) return;   // already handled this (src, mode) — idempotent
  // (…a new current request: the decodes waiting on the one it replaces rejected)
  settleImageDecodes(el, false);
  // A preload of it taken first, else a controlling service worker's `fetch` event (destination 'image'), else the
  // network's — a host thread's, a `blob:` URL's store's, at once — the engine's to judge, decode and apply
  // (subresource_obtain.rs `imageObtain`).
  const done = dom.imageObtain(nidOf(el), nidOf(nodeDocumentOf(el)), abs, load, obtainHost());
  if (done !== IMAGE_FETCH_PENDING) fireImgEvent(el, done === IMAGE_FETCH_BROKEN ? 'error' : 'load', load);
  // (…HTML "update the image data" awaits a stable state before it fetches, which here the fetch is begun ahead of:
  // what an abort of its document comes to before that is the engine's to tell, `imageFetchesStop`)
  else if (stable) dom.imageStableState(el, load);
  else globalThis.__csimQueueMicrotask(() => dom.imageStableState(el, load));
}
// Whether `load` is the element's current one (no later one superseded it).
function isCurrentLoad(el, load) {
  return dom.imageLoad(el) === load;
}
// A fetch of its the document's abort cancelled, on the task that says so: load `load` of it, where it is the current
// one still, complete and broken, the decodes waiting on it rejected.
export function imageFetchAborted(el, load) {
  if (dom.imageFetchAborted(nidOf(el), load)) settleImageDecodes(el, false);
}
// Fire `load`/`error` from a queued task (approximated by a microtask), for load `load`: a newer load (a `src` /
// `crossorigin` reassignment in the same task) supersedes it, so its already-queued event is dropped and only the
// final load dispatches.
export function fireImgEvent(el, type, load) {
  // (…its data applied, what it shows marked by the engine — image_requests.rs — and its observations asked for)
  engineWritten();
  globalThis.__csimQueueMicrotask(() => {
    if (!isCurrentLoad(el, load)) return;
    settleImageDecodes(el, type === 'load');
    fireEvent(el, new Event(type));
  });
}
// Applies a host-thread image result delivered by Ruby's `deliver_image_loads` — to the realm that began the fetch,
// which the engine answers for (`imageFetchRealm`, `imageFetchTake`); `true` tells the deliverer the id was consumed
// here. A superseded load (src / crossorigin reassigned while in flight — the generation moved) consumes the id but
// applies nothing, exactly like the sync path's supersede guard. The arrival is an observable change the settle
// machinery must see: the find cache keys on settleGen, and the element's box (natural size) moved.
// A response its server delayed (a WPT handler's virtualized `time.sleep`: X-Csim-Server-Delay-Ms, `meta.delayMs`)
// arrives that many virtual ms later, as an XHR's does — what supersedes or aborts the load meanwhile (a navigation,
// `document.open()`) leaving it unapplied. Its bitmap leaves the host registry now, so a realm torn down before the
// arrival takes nothing pinned with it; and until it arrives it delays the document's load event, as every `<img>`
// fetch in progress does — one a later load superseded (aborted: HTML "update the image data") no more: the engine's
// (image_requests.rs `images_delay_load`, of the fetches it holds by the host's id and the arrivals held back).
function applyAsyncImage(id, r) {
  const taken = dom.imageFetchTake(id);
  if (!taken) return false;
  const [el, load, src, timingStart] = taken;
  const p = { el, load, src, timingStart };
  const result = takeHostBitmaps(r);
  const delay = (r && r.meta && r.meta.delayMs) | 0;
  if (delay > 0) {
    dom.imageArrival(el, load, true);
    globalThis.__csimSetTimeout(() => {
      dom.imageArrival(el, load, false);
      arriveAsyncImage(p, result);
      globalThis.__csimLoadBlockerSettled();
    }, delay);
  } else arriveAsyncImage(p, result);
  globalThis.__csimLoadBlockerSettled();
  return true;
}
// (…a superseded load consumed the id and drops the result unapplied, exactly like the sync path's supersede guard)
// (…its entry filed and its record applied by the engine, what it shows marked: subresource_obtain.rs `imageArrive`)
function arriveAsyncImage(p, r) {
  const el = p.el;
  const applied = dom.imageArrive(el, p.load, p.src, p.timingStart, r, obtainHost());
  if (applied === IMAGE_APPLIED_NONE) return;
  fireImgEvent(el, applied === IMAGE_APPLIED_ERROR ? 'error' : 'load', p.load);
}
// An element's or a shadow root's `innerHTML` (DOM Parsing): its children's serialization — in an XML/XHTML document
// the XML one (require-well-formed).
export function innerHTMLOf(node) {
  return isHtmlDocument(nodeDocumentOf(node)) ? serializeChildren(node) : xmlSerializeInner(node);
}
// …and its setting: the children replaced by the fragment parse of `html` — the XML one in an XML document, whose
// well-formedness error throws before anything changes — a `<template>`'s content's, not its own (the inert subtree
// lives in the fragment, whose document is the inert template document the insertion adopts the nodes into), and a
// shadow root's in its host's context — the form element pointer its host's nearest form — its elements of its own
// registry. (…parsed by the node's own realm, whose objects the nodes made are and whose named properties learn their
// names: `makingRealmOf`)
export function setInnerHTML(node, html) {
  const realm = makingRealmOf(node);
  if (realm !== null) return inRealm(realm, 'setInnerHTML', node, html);
  if (isShadowRoot(node)) {
    const host = hostOf(node);
    const nodes = isHtmlDocument(nodeDocumentOf(node)) ? parseFragment(html, host, false, node) : parseXmlFragment(html, host, node);
    changeChildren(node, ALL_CHILDREN, nodes, null, true);
    return;
  }
  if (!isHtmlDocument(nodeDocumentOf(node))) {
    // (…an HTML template's into its contents, in an XML document as in an HTML one: DOM Parsing's `innerHTML`)
    const nodes = parseXmlFragment(html, node);
    if (isHtml(node, 'template')) changeChildren(templateContent(node), ALL_CHILDREN, nodes, null);
    else changeChildren(node, ALL_CHILDREN, nodes, null, true);
    return;
  }
  parseIntoElement(node, String(html === null ? '' : html), false);
}
// The HTML fragment parsing algorithm's nodes the children of this element — of its template contents, a template's:
// innerHTML's, or with `declarative` setHTMLUnsafe's, which attaches the declarative shadow roots the markup makes.
function setElementHTML(el, markup, declarative) {
  const realm = makingRealmOf(el);
  if (realm !== null) return inRealm(realm, 'setElementHTML', el, markup, declarative);
  parseIntoElement(el, markup, declarative);
}
// (…by this realm, the one its object is of)
function parseIntoElement(el, markup, declarative) {
  if (isHtml(el, 'template')) {
    changeChildren(templateContent(el), ALL_CHILDREN, parseFragment(markup, el, declarative), null);
    return;
  }
  changeChildren(el, ALL_CHILDREN, parseFragment(markup, el, declarative), null, true);
}
// In an XML/XHTML document `outerHTML` getting is the XML serialization of the
// element itself (require-well-formed), mirroring the innerHTML getter.
export function outerHTMLOf(el) {
  return isHtmlDocument(nodeDocumentOf(el)) ? serializeElement(el) : xmlSerializeOuter(el);
}
// `el.outerHTML = html` (DOM Parsing spec): parse `html` as a fragment and
// replace this element with the result, within this element's parent.
export function setOuterHTML(el, html) {
  const parent = parentOrHostOf(el);
  // No parent → the parsed nodes would be unreferenceable; spec leaves this
  // a no-op. A Document parent can't have its child replaced this way.
  if (parent == null) return;
  if (nodeTypeOf(parent) === NODE_DOC) {
    throw new DOMException("Cannot set the 'outerHTML' property on an element whose parent is a Document.", 'NoModificationAllowedError');
  }
  const realm = makingRealmOf(el);
  if (realm !== null) return inRealm(realm, 'setOuterHTML', el, html);
  // In an XML/XHTML document the replacement is parsed as an XML fragment (context = the parent element).
  const nodes = isHtmlDocument(nodeDocumentOf(el)) ? parseFragment(html, parent) : parseXmlFragment(html, parent);
  // Spec (DOM Parsing): "replace this with the new nodes within parent" — a
  // single DOM "replace", so observers see ONE childList record (removedNodes
  // = [this], addedNodes = the parsed nodes), not a remove + separate inserts.
  replaceNode(parent, el, nodes, true);
}
// `insertAdjacentHTML(position, html)` — DOM spec method. Forem's
// initializeBroadcast uses `el.insertAdjacentHTML('afterbegin', …)`
// to inject the announcement banner. Positions: `beforebegin` /
// `afterbegin` / `beforeend` / `afterend`.
function insertAdjacentHTML(el, position, html) {
  const pos = asciiLower(position), parent = parentOrHostOf(el);
  // Resolve the context element per spec; an unknown position is a
  // SyntaxError, and beforebegin/afterend with no element parent (null or a
  // Document) is a NoModificationAllowedError.
  if (pos === 'beforebegin' || pos === 'afterend') {
    if (!parent || nodeTypeOf(parent) === NODE_DOC) {
      throw new DOMException("Failed to execute 'insertAdjacentHTML' on 'Element': The element has no parent.", 'NoModificationAllowedError');
    }
  } else if (pos !== 'afterbegin' && pos !== 'beforeend') {
    throw new DOMException(adjacentPositionError('insertAdjacentHTML', position), 'SyntaxError');
  }
  const realm = makingRealmOf(el);
  if (realm !== null) return inRealm(realm, 'insertAdjacentHTML', el, position, html);
  // XML/XHTML document → XML fragment parsing (context per spec: the parent for
  // beforebegin/afterend, this element otherwise); malformed markup throws SyntaxError.
  // (…its elements of the registry of the node it is parsed for, a body made for it or not: the parent's — a shadow
  // root's — for beforebegin/afterend)
  const doc = nodeDocumentOf(el);
  const node = (pos === 'beforebegin' || pos === 'afterend') ? parent : el;
  const ctx = fragmentContextOf(node, doc);
  const frag = isHtmlDocument(doc) ? parseFragment(html, ctx, false, node) : parseXmlFragment(html, ctx, node);
  // (…inserted as the fragment they are: one insertion, one record)
  if (pos === 'beforebegin')     changeChildren(parentOrHostOf(el), null, frag, el, true);
  else if (pos === 'afterbegin') changeChildren(el, null, frag, childAtOf(el, 0), true);
  else if (pos === 'beforeend')  changeChildren(el, null, frag, null, true);
  else /* afterend */            changeChildren(parentOrHostOf(el), null, frag, nextSiblingOf(el), true);
}
// Shared "insert adjacent" core for insertAdjacentElement / insertAdjacentText
// (NOT insertAdjacentHTML, which has its own context algorithm). beforebegin /
// afterend with no parent return null; an unknown position is a SyntaxError;
// a Document parent surfaces as HierarchyRequestError from the pre-insertion
// validity inside insertBefore (NOT the NoModificationAllowedError that
// insertAdjacentHTML raises). `member` is which one's, for the error's message.
function insertAdjacent(el, position, node, member) {
  const pos = asciiLower(position), parent = parentOrHostOf(el);
  if (pos === 'beforebegin')     { if (!parent) return null; insertBefore(parent, node, el); }
  else if (pos === 'afterbegin') { insertBefore(el, node, childAtOf(el, 0)); }
  else if (pos === 'beforeend')  { appendChild(el, node); }
  else if (pos === 'afterend')   { if (!parent) return null; insertBefore(parent, node, nextSiblingOf(el)); }
  else throw new DOMException(adjacentPositionError(member, position), 'SyntaxError');
  return node;
}
// DOM "attach a shadow root", of a ShadowRootInit (its members converted: `mode`, `slotAssignment`, `clonable`,
// `delegatesFocus`, `serializable`, `customElementRegistry`).
function attachShadow(el, init) {
  const { mode, slotAssignment } = init;
  if (!canAttachShadow(el)) {
    throw new DOMException("Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow", 'NotSupportedError');
  }
  if (shadowRootOf(el)) {
    // HTML "attach a shadow root" reuse path (whatwg/dom#1246): a DECLARATIVE
    // shadow root (from `<template shadowrootmode>`) is reused when the new
    // mode MATCHES — the only parameter checked. The root is emptied and its
    // declarative flag cleared, then returned AS-IS: delegatesFocus /
    // slotAssignment / clonable / serializable keep their declarative-creation
    // values and are NOT overwritten by this init. A non-declarative existing
    // root, or a mode mismatch, throws.
    const ex = shadowRootOf(el);
    if (!shadowIs(ex, SHADOW_DECLARATIVE) || shadowRootMode(ex) !== mode) {
      throw new DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", 'NotSupportedError');
    }
    // "Replace all with null within shadow" — a TREE MUTATION, recorded like any other. Emptying it
    // silently left the host's old declarative boxes laid out (Chrome drops to height 0, we kept 50),
    // queued no MutationObserver record where Chrome queues a childList one, and left every memo keyed
    // on a child-list record — the cascade's structural-context epochs and the enclosing-shadow-root
    // stamp among them — describing a tree that no longer exists.
    if (changeChildren(ex, ALL_CHILDREN, NO_NODES, null).length !== 0) markLayoutDirty(el, true);
    setShadowIs(ex, SHADOW_DECLARATIVE, false);
    return ex;
  }
  const realm = makingRealmOf(el);
  const sr = realm !== null ? inRealm(realm, 'newShadowRoot') : new ShadowRoot(SHADOW_ROOT_INTERNAL);
  // (…"available to element internals" where the host is custom, or being upgraded — precustomized — as it is attached;
  // cloneNode of the host clones a clonable shadow tree)
  const flags = (init.delegatesFocus ? SHADOW_DELEGATES_FOCUS : 0) | (slotAssignment === 'manual' ? SHADOW_MANUAL_SLOTS : 0) |
    (mode === 'closed' ? SHADOW_CLOSED : 0) | (init.clonable ? SHADOW_CLONABLE : 0) | (init.serializable ? SHADOW_SERIALIZABLE : 0) |
    (hasState(el, STATE_PRECUSTOMIZED | STATE_CUSTOM) ? SHADOW_INTERNALS : 0);
  // The shadow tree's custom element registry: elements parsed via the shadow's
  // innerHTML inherit it. Unset (undefined) → the global registry; a scoped registry
  // or the null-registry state is carried on the root.
  setCeRegistryOf(sr, ceRegistryOption(init));
  // (…and its node document, the host's: what its registry, unset, tracks — a host in an inert document gives it null)
  setNodeDocumentOf(sr, nodeDocumentOf(el));
  // (…the host's and the root's link, the engine's — which counts the host, `noteShadowHost`, and marks what it shows:
  // its empty shadow tree from now on, its light children out of the flat tree)
  arenaAttachShadow(el, sr, flags);
  engineWritten();
  return sr;
}
// DOM "set an attribute" of an Attr — `setAttributeNode`, `setAttributeNodeNS` and NamedNodeMap's `setNamedItem(NS)`:
// adopt it into this element's attribute list, replacing any existing attribute with the same (namespace, local
// name), and return the replaced Attr (or null). An InUseAttributeError if it is another element's.
export function setAttributeNode(el, attr) {
  if (attrOwnerOf(attr) != null && attrOwnerOf(attr) !== el) {
    throw new DOMException("The attribute is in use by another element.", "InUseAttributeError");
  }
  // (…an attribute of another document — another realm's too — is adopted into this element's)
  setNodeDocumentOf(attr, nodeDocumentOf(el));
  const key = attrKeyNS(el, namespaceOf(attr), localNameOf(attr));
  const oldAttr = key != null ? attrNodeFor(el, key) : null;
  if (oldAttr === attr) return attr;
  if (oldAttr) detachAttrNode(el, attrStoreKeyOf(oldAttr), attrValueOf(oldAttr));
  bindAttrNode(el, attr);
  return oldAttr;
}
// The CSSStyleSheet a sheet owner — a `<style>`, a `<link>`, an `<?xml-stylesheet?>` — made of the sheet it has
// (`ownerSheetView`, `piSheet`): none once it obtained another, a new block or the owner inserted again (sheet_owners.rs),
// which leaves that one with no owner node (CSSOM: the old sheet is removed from the document).
function ownerSheetOf(owner) {
  const sheet = rareDataOf(owner)?.sheet;
  return sheet != null && sheetOwnerOf(sheet) === owner ? sheet : null;
}
// (…whether it has one — no page can tell, as a `sheet` read makes one: what the web fonts spec asks to hold that a face
// is found with no CSSOM built)
globalThis.__csimOwnerSheetMade = (owner) => ownerSheetOf(owner) !== null;
function dropSheet(owner) {
  const rare = rareDataOf(owner);
  if (rare?.sheet) {
    slotsOf(rare.sheet, 'CSSStyleSheet').ownerNode = null;
    rare.sheet = null;
  }
  return null;
}
// A sheet owner obtains a new sheet (sheet_owners.rs: its count of them, which its engine sheet is made again for — and
// so its faces new ones: sheet_feed.rs `make`, style.rs `FaceIds`) where HTML says — a `<style>`'s block
// updated, even to the same text, and an owner inserted or removed, however deep in the subtree that moved, a shadow tree
// included, which the engine counts as it writes the tree — or one of its attributes says (`sheetAttrChanged`); what a
// script edited of the one before is gone with it. A change of the tree that renewed one asks for the cascade with its
// record (mutation.rs `record_child_list`).
// A `<link>`'s or `<style>`'s attribute that selects or obtains its sheet — HTML's attribute change steps, so here, where
// every write arrives (`setAttribute` / `setAttributeNS`, an `Attr`'s value, `attributes.setNamedItem`, a removal),
// rather than in `setAttribute` alone: the others left `<style media=print>` switched to `screen` applying nothing.
// Which attributes those are, and which of them obtain the owner a new sheet — a `<link>`'s `disabled` (its removal
// making it explicitly enabled), `rel`, `href` or `type`, a `<style>`'s `type` — is the engine's, as it stores the
// attribute (attributes.rs `STEP_SHEET`); `media` / `title` only re-select the sheet (which set it is in, whether its
// query holds), and the sheet's media list follows the attribute on the same sheet object, as Chrome's
// `sheet.media.mediaText` does. A `<link>` whose resource may be another (or newly a stylesheet: `linkResource`) is
// fetched again, its `load` fired (`maybeFireLinkLoad`). The cascade it re-selects is the engine's to mark stale as it
// stores the attribute — the cascade of the realm whose tree the owner is in, a shadow tree's its rule set moved
// (sheet_feed.rs `stale_cascade`).
function sheetAttrChanged(el, name, value, linkResource) {
  // (…its sheet's `media` and `title` follow the attribute on the same sheet object, while the owner has it)
  const sheet = ownerSheetOf(el);
  if (sheet && name === 'media') globalThis.__csimSetSheetMedia(sheet, value == null ? '' : value);
  else if (sheet && name === 'title') slotsOf(sheet, 'CSSStyleSheet').title = value || null;
  if (linkResource && globalThis.__csim_linkResourceChanged) globalThis.__csim_linkResourceChanged(el);
  else if (name === 'media' && globalThis.__csim_linkMediaChanged) globalThis.__csim_linkMediaChanged(el);
  else if (name === 'as' && globalThis.__csim_linkAsChanged) globalThis.__csim_linkAsChanged(el);
}
// HTML "reset" a form (§4.10.21.6), for its reset() and a reset button: a cancelable `reset` fired first — a listener
// that cancels it keeps every control as it is — then each resettable element its form owns restored to its default
// value / checkedness (the content attribute's). Not while it is already resetting (a `reset` listener's reset()).
export function resetForm(form) {
  if (elementFlag(form, FORM_LOCKED_FOR_RESET)) return;
  setElementFlag(form, FORM_LOCKED_FOR_RESET, true);
  try {
    if (fireEvent(form, new Event('reset', { __proto__: null, bubbles: true, cancelable: true }))) resetControls(form);
  } finally {
    setElementFlag(form, FORM_LOCKED_FOR_RESET, false);
  }
}
function resetControls(form) {
  // (…the built-in controls reset by the engine — their dirty values, checkedness and selectedness — answering what is
  // left: validity.rs `formReset`)
  const [customElements, fileInputs, followers, options] = dom.formReset(nidOf(form));
  // A file input's reset sets its value to '' — in filename mode, emptying its selected files.
  for (const el of fileInputs) setSelectedFiles(el, []);
  optionsChanged(options);
  // …then, in tree order, each select's `<selectedcontent>` following its selection, and each output reset: its value
  // mode flag the default's, its descendant text content the default value (a no-op while already in default mode).
  for (const el of followers) {
    if (isHtml(el, 'select')) syncSelectedContent(el, false);
    else if (liveValueOf(el) !== undefined) {
      setTextContent(el, liveValueOf(el));
      setLiveValue(el, undefined);
    }
  }
  // (…the reset an observable change, the engine's to note: validity.rs `form_reset`)
  engineWritten();
  // Now that the built-in controls are reset, each form-associated custom element's `formResetCallback` reaction is
  // enqueued, in tree order — so the callback observes the reset built-in controls (a spec-ordering the test checks
  // against an <output>); it runs as the [CEReactions] call that reset the form returns.
  for (const el of customElements) fireCEHook(el, FORM_RESET_CALLBACK);
}

// HTML "navigate to a fragment": when a hyperlink's resolved URL equals
// the current document URL except for the fragment, the activation is a
// same-document navigation — update the URL and fire `hashchange`, with
// NO document fetch. We run it entirely in JS (rather than handing the
// navigation to Ruby) for two reasons: it is genuinely same-document, and
// in a pure-JS run (the WPT harness) Ruby never drains the pending-
// navigation slot, so a fragment link would otherwise never fire
// `hashchange`. Returns true when it handled the activation, so the caller
// skips the cross-document navigation path. `anchor` is the activating
// `<a>` / `<area>`, `tgt` the browsing context it opens in.
export function fragmentNavigate(anchor, tgt) {
  // A target choosing another navigable (`_blank`, a named window, a frame's
  // `_top` / `_parent`, …) opens elsewhere — never a same-document fragment
  // hop; a top-level document's `_top` and `_parent`, and its own name, are
  // itself (navigables.rs `targetsOwnNavigable`) — asked after the fast reject
  // (avoid the URL parses in `tryFragmentNavigate` on the common
  // cross-document link): a navigation to a fragment needs one in the target,
  // and resolving a ref against a base never inherits the base's fragment, so
  // a `#`-free raw href stays fragmentless.
  const rawHref = hrefAttr(anchor) || '';
  if (rawHref.indexOf('#') === -1) return false;
  if (!dom.targetsOwnNavigable(tgt)) return false;
  // (…the URL the href resolves to — an SVG `<a>`'s `href` is an SVGAnimatedString, so not its member)
  const url = resolveURLValue(anchor, rawHref);
  return url !== null && tryFragmentNavigate(url);
}

// ARIAMixin's string members (ARIA §10.1), which an element's binding reflects as nullable strings (ARIA §6.3.2: no
// missing or invalid value default, the value not validated on get) — by name, for ElementInternals, whose are state of
// its own.
const ARIA_STRING_MEMBERS = [
  'role', 'ariaAtomic', 'ariaAutoComplete', 'ariaBusy', 'ariaChecked', 'ariaColCount', 'ariaColIndex',
  'ariaColIndexText', 'ariaColSpan', 'ariaCurrent', 'ariaDescription', 'ariaDisabled', 'ariaExpanded',
  'ariaHasPopup', 'ariaHidden', 'ariaInvalid', 'ariaKeyShortcuts', 'ariaLabel', 'ariaLevel', 'ariaLive', 'ariaModal',
  'ariaMultiLine', 'ariaMultiSelectable', 'ariaOrientation', 'ariaPlaceholder', 'ariaPosInSet', 'ariaPressed',
  'ariaReadOnly', 'ariaRelevant', 'ariaRequired', 'ariaRoleDescription', 'ariaRowCount', 'ariaRowIndex',
  'ariaRowIndexText', 'ariaRowSpan', 'ariaSelected', 'ariaSetSize', 'ariaSort', 'ariaValueMax', 'ariaValueMin',
  'ariaValueNow', 'ariaValueText', 'ariaBrailleLabel', 'ariaBrailleRoleDescription'
];
// (…the element-reference ones Element's implementation answers, below)
const ariaMembers = {};

// Reflected element references (HTML §2.6.1) — the engine's (element_references.rs): ARIA's
// `ariaActiveDescendantElement` and its seven `aria*Elements` lists, a button's command target, a popover invoker's
// popover. An element set through the IDL attribute is held by the engine, the content attribute set to "" for it;
// the getter answers the ones still valid, or the elements the content attribute's IDREFs name in the element's tree.
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
const ELEMENT_REF_ATTRS = {
  ...ARIA_ELEMENT_REF_ATTRS,
  commandForElement:    'commandfor',
  popoverTargetElement: 'popovertarget'
};
// The setter steps of the reference(s) `attr`: null removes the content attribute, which forgets what was set; else
// it is set to "" and the engine holds `elements`.
// (…the attribute in no namespace, whatever one in another of its name)
function setReferencedElements(el, attr, elements) {
  if (elements === null) { removeAttributeNS(el, null, attr); return; }
  setAttributeNS(el, null, attr, '');
  dom.setReferencedElements(nidOf(el), attr, elements);
}
// The getter and setter steps of the element reference `idl` (ELEMENT_REF_ATTRS: its content attribute's).
export function referencedElementOf(el, idl) {
  return dom.referencedElements(nidOf(el), ELEMENT_REF_ATTRS[idl], false);
}
export function setReferencedElement(el, idl, value) {
  setReferencedElements(el, ELEMENT_REF_ATTRS[idl], value === null ? null : [value]);
}
for (const idl of Object.keys(ARIA_ELEMENT_REF_ATTRS)) {
  ariaMembers['get_' + idl] = (el) => referencedElementOf(el, idl);
  ariaMembers['set_' + idl] = (el, value) => setReferencedElement(el, idl, value);
}
// (…a list's getter the same frozen array while the elements it answers are the same, in the same order)
const referenceListCache = new WeakMap();
function sameElements(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
for (const idl of Object.keys(ARIA_ELEMENT_REFLIST_ATTRS)) {
  const attr = ARIA_ELEMENT_REFLIST_ATTRS[idl];
  ariaMembers['get_' + idl] = (el) => {
    const elements = dom.referencedElements(nidOf(el), attr, true);
    if (elements === undefined) return null;
    let cached = referenceListCache.get(el);
    if (cached === undefined) referenceListCache.set(el, cached = objectCreate(null));
    const last = cached[attr];
    if (last !== undefined && sameElements(last, elements)) return last;
    return cached[attr] = Object.freeze(elements);
  };
  ariaMembers['set_' + idl] = (el, value) => setReferencedElements(el, attr, value);
}

// The SyntaxError an insertAdjacent* member throws for a position that is none of the four (Chrome's message).
function adjacentPositionError(member, position) {
  return `Failed to execute '${member}' on 'Element': The value provided ('${position}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`;
}

// `getHTML(options)` — an element's or a shadow root's: its children serialized as innerHTML's, but with the shadow
// roots the options ask for (`serializableShadowRoots` and a root's `serializable`, or one listed in `shadowRoots`) as
// `<template shadowrootmode=…>` first children; in an XML document, innerHTML's.
function getHTMLOf(node, options) {
  return isHtmlDocument(nodeDocumentOf(node)) ? serializeChildrenWithShadow(node, options) : innerHTMLOf(node);
}
// `styleSheets` — a document's or a shadow root's, the same list each time ([SameObject]): the sheet of every owner in
// it — an HTML or SVG `<style>`, an HTML `<link rel=stylesheet>`, the engine's to find as the cascade does (`sheetOwnersIn`)
// — each its own `sheet` (so `styleElement.sheet === document.styleSheets[i]`; none while a root is disconnected), in tree
// order, as the tree is at each read.
// (…its sheets found again once the tree moved: a tree generation moves on an insertion or a removal, an attribute
// write — `rel`, `disabled`, `media`, `type` — a `<style>`'s text and a parser mutation, and a `<link>`'s sheet is there
// as it is inserted)
function styleSheetListOf(root) {
  return sameObject(root, 'styleSheets', () => {
    let gen = NaN, sheets = null;
    return newStyleSheetList(() => {
      if (currentTreeGen() !== gen) {
        gen = currentTreeGen();
        sheets = styleSheetsOf(root);
      }
      return sheets;
    });
  });
}
function styleSheetsOf(root) {
  const sheets = [];
  for (const owner of sheetOwnersIn(root)) {
    const sheet = sheetOfOwner(owner);
    if (sheet) sheets.push(sheet);
  }
  return sheets;
}

// CSSOM View's scroll of an element to a position, or by an offset (`scroll` / `scrollTo` / `scrollBy`): only where
// it keeps a scroll offset (the engine's — scroll_boxes.rs `holds_scroll_offset`: the document's scrolling element,
// whatever the root's own overflow says, and any rendered scroll container; every other element refuses the write and
// reads back 0, as Chrome's `overflow: visible` / `clip`, a body whose overflow propagated, a `display: none` box), each axis
// given — a non-finite value 0 — clamped as the scrollTop / scrollLeft setters clamp (`moveScrollOffset`):
// `window.scrollTo(0, document.body.scrollHeight)` is how a page says "go to the bottom", and it must land AT the
// bottom, not past it. Discourse's RouteScrollManager restores `scrollingElement.scrollTop` with `scrollTo(left, top)`.
// A promise of the scroll's completion — an instant one, so resolved.
export function scrollElement(el, x, y, by) {
  return styleEngineHoldsScrollOffset(el) ? scrollBox(styleEngineScrollHolder(el), x, y, by) : resolvedPromise();
}
// …and of the box that keeps an offset itself — the root for the VIEWPORT, which is what the window's scrolls and a
// driver's move whatever element is the document's scrolling element: one there is none of (a quirks page whose body
// scrolls itself) scrolls all the same (Chrome: `scrollY` 500 after `scrollTo(0, 500)`).
export function scrollBox(box, x, y, by) {
  const finite = (v) => (v === undefined || Number.isFinite(v) ? v : 0);
  x = finite(x);
  y = finite(y);
  if (by) {
    x = x ? settledScrollOffsetOf(box, 0) + x : undefined;
    y = y ? settledScrollOffsetOf(box, 1) + y : undefined;
  }
  moveScrollOffset(box, x, y);
  return resolvedPromise();
}
// (…a driver's scroll of a box a plan or a request moves, layout.js `scrollBoxTo`: the viewport by its root, any other
// box as its scroll members would)
globalThis.__csimScrollBoxTo = (el, x, y) => {
  if (el === documentElementOf(nodeDocumentOf(el))) scrollBox(el, x, y, false);
  else scrollElement(el, x, y, false);
};

// Element's members (generated/bindings.js): its own steps and the driver's (`setAttribute`, `innerHTMLOf`,
// `attachShadow`, …), what Node's other kinds share with it (ParentNode / ChildNode's), the arena's answers
// (geometry.rs, collections.rs) — and ARIAMixin's reflection (`ariaMembers`).
registerInterface('Element', (o) => nodeObjectTypeOf(o) === NODE_ELEMENT);
// An element's attribute steps — Element's members' and its NamedNodeMap's, which run them on its element (a frame's
// map on a frame's element: its realm's steps, in its slots).
const attributeSteps = {
  attrNodeFor,
  setAttributeNode,
  getAttributeNode(el, qualifiedName) {
    const key = attrKeyOf(el, qualifiedName);
    return key === null ? null : attrNodeFor(el, key);
  },
  getAttributeNodeNS(el, namespace, localName) {
    const key = attrKeyNS(el, namespace, localName);
    return key === null ? null : attrNodeFor(el, key);
  },
  // (…an attribute of the element's, removed: Element's "remove an attribute")
  removeAttr(el, attr) {
    removeAttrKey(el, attrStoreKeyOf(attr));
    return attr;
  }
};
installElement(Element, {
  ...ariaMembers,
  get_namespaceURI: (el) => namespaceOf(el),
  get_prefix: (el) => prefixOf(el),
  get_localName: (el) => localNameOf(el),
  get_tagName: elementNameOf,
  // `id` / `className` / `slot` reflect their content attributes (an SVG element's `className` is SVGElement's).
  get_id: (el) => attrsOf(el).id || '',
  set_id(el, value) { setAttribute(el, 'id', value); },
  get_className: (el) => attrsOf(el)['class'] || '',
  set_className(el, value) { setAttribute(el, 'class', value); },
  // [SameObject, PutForwards=value]: one token list per element, its writes the `class` attribute's (so MutationObserver,
  // the cascade and `attributeChangedCallback` see a `classList.remove('hidden')`); `part`'s the same of `part` — the
  // names by which an element in a shadow tree is exposed to `::part()` outside it.
  get_classList: (el) => tokenListFor(el, 'class'),
  get_part: (el) => tokenListFor(el, 'part'),
  get_slot: (el) => attrsOf(el).slot || '',
  set_slot(el, value) { setAttribute(el, 'slot', value); },
  hasAttributes: (el) => Object.keys(attrsOf(el)).length > 0,
  // A LIVE NamedNodeMap, one per element.
  get_attributes: (el) => sameObject(el, 'attributes', () => liveNamedNodeMap(el, attributeSteps)),
  // (…qualified names in attribute order: a collision key mapped back to its name)
  getAttributeNames: (el) => dom.attrNames(el, false),
  getAttribute,
  getAttributeNS,
  setAttribute,
  setAttributeNS,
  removeAttribute,
  removeAttributeNS,
  // (…without `force`, flipped; with it, as it says — the presence it leaves)
  toggleAttribute(el, qualifiedName, force) {
    if (!isValidAttributeLocalName(qualifiedName)) {
      throw new DOMException("Failed to execute 'toggleAttribute' on 'Element': '" + qualifiedName + "' is not a valid attribute name.", 'InvalidCharacterError');
    }
    const has = hasAttribute(el, qualifiedName);
    const next = force === undefined ? !has : force;
    if (next === has) return next;
    if (next) setAttribute(el, qualifiedName, '');
    else removeAttribute(el, qualifiedName);
    return next;
  },
  hasAttribute,
  hasAttributeNS: (el, namespace, localName) => attrKeyNS(el, namespace, localName) !== null,
  getAttributeNode: attributeSteps.getAttributeNode,
  getAttributeNodeNS: attributeSteps.getAttributeNodeNS,
  setAttributeNode,
  setAttributeNodeNS: (el, attr) => setAttributeNode(el, attr),
  removeAttributeNode(el, attr) {
    if (attrOwnerOf(attr) !== el) {
      throw new DOMException("Failed to execute 'removeAttributeNode' on 'Element': The node provided is owned by another element.", 'NotFoundError');
    }
    return attributeSteps.removeAttr(el, attr);
  },
  attachShadow,
  get_shadowRoot(el) {
    const root = shadowRootOf(el);
    return root && shadowRootMode(root) === 'open' ? root : null;
  },
  // An element's custom element registry: unset (`ceRegistryOf(el) === undefined`) it TRACKS THE NODE DOCUMENT's (the
  // global one in the live document, null in an inert one); a scoped registry or the null-registry state as it is.
  get_customElementRegistry: registryForElement,
  closest: (el, selectors) => closestSelector(el, selectors),
  matches: (el, selectors) => matchesSelector(el, selectors),
  webkitMatchesSelector: (el, selectors) => matchesSelector(el, selectors),
  // (…an element's descendants; whether its document is HTML — which lowercases the search for its HTML elements —
  // bound as the live list is made, so moving the element into an XML document does not change the list)
  getElementsByTagName(el, qualifiedName) {
    const htmlDoc = isHtmlDocument(nodeDocumentOf(el));
    return liveHTMLCollection(() => collectByTagName(el, qualifiedName, htmlDoc), currentEdgeGen);
  },
  getElementsByTagNameNS: (el, namespace, localName) => liveHTMLCollection(() => collectByTagNameNS(el, namespace, localName), currentEdgeGen),
  getElementsByClassName: (el, classNames) => liveHTMLCollection(() => collectByClassName(el, classNames)),
  insertAdjacentElement: (el, where, element) => insertAdjacent(el, where, element, 'insertAdjacentElement'),
  insertAdjacentText(el, where, data) {
    insertAdjacent(el, where, nodeMadeFor(nodeDocumentOf(el), Text, data, undefined, el), 'insertAdjacentText');
  },
  // CSSOM View's geometry: one rect per FRAGMENT (a link wrapping over two lines has two — Chrome); none for an
  // element not rendered, one for a rendered empty one (what keeps `:visible`-style probes answering true for it).
  getClientRects: (el) => rectList(clientRectsOf(el).map((r) => new DOMRect(r.x, r.y, r.width, r.height))),
  getBoundingClientRect(el) {
    const r = rectOf(el);
    return new DOMRect(r.x, r.y, r.width, r.height);
  },
  // `checkVisibility(options)`: false for an element with no box — and, only when ASKED, for one whose `visibility` is
  // hidden (`visibilityProperty`, or its older name `checkVisibilityCSS`) or that has, or sits under, an `opacity` of 0
  // (`opacityProperty` / `checkOpacity`). Chrome: a bare `checkVisibility()` is true for a `visibility: hidden`
  // element; and false for SKIPPED content, a closed `<details>`'s (`isUnskippedNode`). (Not modelled yet:
  // `content-visibility: hidden` / `auto` skipping theirs.)
  checkVisibility(el, options) {
    if (!isUnskippedNode(el) || !globalThis.__csimGeneratesBox(el)) return false;
    if ((options.visibilityProperty || options.checkVisibilityCSS) && visibilityHidden(el)) return false;
    if ((options.opacityProperty || options.checkOpacity) && styleEngineTransparent(el)) return false;
    return true;
  },
  // `scrollIntoView(arg)` (CSSOM View §12.4): aligned in every ancestor scrolling box (`applyScrollIntoView`), each one
  // that moves firing its own (coalesced) scroll events. The legacy boolean picks the block edge — true the start,
  // false the end — the inline axis then `nearest`. The scroll generation moves even when nothing moved: it is a
  // user-action signal, and a pagination sentinel already in view gates on the intersection recheck it asks for.
  scrollIntoView(el, arg) {
    const block = typeof arg === 'boolean' ? (arg ? 'start' : 'end') : arg.block;
    const inline = typeof arg === 'boolean' ? 'nearest' : arg.inline;
    applyScrollIntoView(el, block, inline);
    noteScrolled();
    return resolvedPromise();
  },
  scroll_options: (el, options) => scrollElement(el, options.left, options.top, false),
  scroll_x_y: (el, x, y) => scrollElement(el, x, y, false),
  scrollTo_options: (el, options) => scrollElement(el, options.left, options.top, false),
  scrollTo_x_y: (el, x, y) => scrollElement(el, x, y, false),
  scrollBy_options: (el, options) => scrollElement(el, options.left, options.top, true),
  scrollBy_x_y: (el, x, y) => scrollElement(el, x, y, true),
  // (…kept only where a browser keeps one, `styleEngineScrollHolder`: elsewhere 0, and a write refused)
  get_scrollTop(el) { const box = styleEngineScrollHolder(el); return box ? settledScrollOffsetOf(box, 1) : 0; },
  set_scrollTop(el, value) { scrollElement(el, undefined, value, false); },
  get_scrollLeft(el) { const box = styleEngineScrollHolder(el); return box ? settledScrollOffsetOf(box, 0) : 0; },
  set_scrollLeft(el, value) { scrollElement(el, value, undefined, false); },
  // The scrollable content extent — the box unioned with its descendants' (Avo's Trix body shows a "More content"
  // expander above a threshold) — and the client box, the padding box inside the border (`clientLeft` / `clientTop`
  // the border widths: geometry.rs `client_box`). The viewport's for the document's scrolling element: the idiom a
  // page asks how big the window is by (`isViewportElement`).
  get_scrollWidth: (el) => contentExtent(isViewportElement(el) ? documentElementOf(nodeDocumentOf(el)) : el).width,
  get_scrollHeight: (el) => contentExtent(isViewportElement(el) ? documentElementOf(nodeDocumentOf(el)) : el).height,
  get_clientTop: (el) => clientBox(el).top,
  get_clientLeft: (el) => clientBox(el).left,
  get_clientWidth: (el) => (isViewportElement(el) ? viewportSize().width : clientBox(el).width),
  get_clientHeight: (el) => (isViewportElement(el) ? viewportSize().height : clientBox(el).height),
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
  // (…the HTML parser's, in an XML document too)
  setHTMLUnsafe(el, html) { setElementHTML(el, html, true); },
  getHTML: getHTMLOf,
  get_innerHTML: innerHTMLOf,
  set_innerHTML: setInnerHTML,
  get_outerHTML: outerHTMLOf,
  set_outerHTML: setOuterHTML,
  insertAdjacentHTML,
  // Pointer capture: with no real pointer device, none is ever held.
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture: () => false,
  // Web Animations: a real animation, whose value the same model reports as a CSS one's (web-animations.js).
  animate: (el, keyframes, options) => animateElement(el, keyframes, options),
  getAnimations: (el, options) => animationsForElement(el, options),
  // (…Fullscreen's, which are IDL attributes only: no content attribute is one)
  installEventHandlers: installEventHandlerAttrs
});

// HTMLOrSVGElement's members (`dataset`, `nonce`, `autofocus`, `tabIndex`, `focus`, `blur`), ElementCSSInlineStyle's
// `style` and GlobalEventHandlers' `on*` — what HTMLElement, SVGElement and MathMLElement share (generated/bindings.js
// installs each onto its interface: an element in no such namespace has none of them, Chrome's `'onclick' in` false —
// nor their content attributes, which are the engine's: event_handlers.rs).
// The reflected members the engine answers (reflect.rs `elementReflection`), each said beside its getter below.
const REFLECT_TAB_INDEX = 0, REFLECT_TRANSLATE = 1, REFLECT_WRITING_SUGGESTIONS = 2, REFLECT_HIDDEN = 3, REFLECT_ACCESS_KEY_LABEL = 4;
const REFLECT_AUTOCAPITALIZE = 5, REFLECT_AUTOCORRECT = 6, REFLECT_SPELLCHECK = 7, REFLECT_DRAGGABLE = 8;
const HIDDEN_STATES = [false, true, 'until-found'];
const htmlOrForeignElementMembers = {
  get_dataset: (el) => datasetOf(el),
  // `nonce` is the [[CryptographicNonce]] slot, not the content attribute: the setter writes only the slot (the
  // attribute stays as it was — html/dom reflection.js), which a `setAttribute('nonce', …)` keeps in sync and the
  // connection step fills when it hides the attribute (CSP nonce hiding); until written, the attribute is the value —
  // the engine's (nonce.rs).
  get_nonce: (el) => dom.nonce(el),
  set_nonce(el, value) { dom.setNonce(el, value); },
  // `tabIndex` reflects `tabindex` as a long; its default is 0 for an HTML a, area, button, frame, iframe, input,
  // object, select or textarea, an SVG a, and a summary that is its details' summary — -1 for anything else (HTML
  // "tabIndex"; an `<audio>` / `<video>` too, which Chrome and Firefox both answer 0 for, against the spec's list).
  get_tabIndex: (el) => dom.elementReflection(el, REFLECT_TAB_INDEX),
  focus: (el) => focusElement(el),
  blur: (el) => blurElement(el),
  get_style: (el) => inlineStyleOf(el),
  installEventHandlers: installEventHandlerAttrs
};

// HTMLElement's members (generated/bindings.js), which dom-class-aliases.js installs onto HTMLElement.
registerInterface('HTMLElement', (o) => nodeObjectTypeOf(o) === NODE_ELEMENT && namespaceOf(o) === HTML_NS);
export const htmlElementMembers = {
  ...htmlOrForeignElementMembers,
  // `translate` is an INHERITED enumerated attribute: an element with no valid one of its own takes its nearest
  // ancestor's, yes at the root. ASCII case-insensitive ('yeſ' is no yes).
  get_translate: (el) => dom.elementReflection(el, REFLECT_TRANSLATE),
  set_translate(el, value) { setAttribute(el, 'translate', value ? 'yes' : 'no'); },
  // `hidden` is 'until-found' in the Hidden Until Found state, true in the Hidden state, false with no attribute; the
  // setter's falsy values — false, '', null, 0, NaN — remove it, and any other value but 'until-found' makes it ''.
  get_hidden: (el) => HIDDEN_STATES[dom.elementReflection(el, REFLECT_HIDDEN)],
  set_hidden(el, value) {
    if (typeof value === 'string' && asciiLower(value) === 'until-found') setAttribute(el, 'hidden', 'until-found');
    else if (value === false || value === '' || value === null || value === 0 || Number.isNaN(value)) removeAttribute(el, 'hidden');
    else setAttribute(el, 'hidden', '');
  },
  click: (el) => clickElement(el),
  // The assigned access key's label, '' when none is: a key is assigned only for a single code point (a multi-token
  // `"s 0"` assigns none in browsers — access-key-label), and the modifier is the platform's, so `Alt+`.
  get_accessKeyLabel: (el) => dom.elementReflection(el, REFLECT_ACCESS_KEY_LABEL),
  get_draggable: (el) => isDraggable(el),
  set_draggable(el, value) { setAttribute(el, 'draggable', value ? 'true' : 'false'); },
  // (…inherited where the element states neither true nor false)
  get_spellcheck: (el) => dom.elementReflection(el, REFLECT_SPELLCHECK),
  set_spellcheck(el, value) { setAttribute(el, 'spellcheck', value ? 'true' : 'false'); },
  // 'false' when this element's writing suggestions are off — its own `writingsuggestions` false, or, with none (or
  // an invalid one), its nearest ancestor's that is true or false — 'true' otherwise.
  get_writingSuggestions: (el) => dom.elementReflection(el, REFLECT_WRITING_SUGGESTIONS),
  // The autocapitalization hint's keyword and whether autocorrection is on: an element's own, else — a form control's
  // — its form owner's.
  get_autocapitalize: (el) => dom.elementReflection(el, REFLECT_AUTOCAPITALIZE),
  get_autocorrect: (el) => dom.elementReflection(el, REFLECT_AUTOCORRECT),
  set_autocorrect(el, value) { setAttribute(el, 'autocorrect', value ? 'on' : 'off'); },
  // The text "as rendered" (rendered.rs: visible only, whitespace collapsed, line breaks from `<br>` and blocks) —
  // its descendant text content when it is not being rendered.
  get_innerText: (el) => globalThis.__csimInnerText(el),
  // HTML "set the inner text" and "set the outer text": the element's children, or the element itself, replaced by the
  // value's rendered text fragment — its runs Text, its line breaks `<br>` — and, for the latter, the Text on either
  // side merged with what came in: the engine's (text_setters.rs).
  set_innerText(el, value) {
    const made = dom.setInnerText(nidOf(el), value, CHANGE_STEPS);
    if (made !== undefined) finishChanges(made, 1);
  },
  get_outerText: (el) => globalThis.__csimInnerText(el),
  set_outerText(el, value) {
    const made = dom.setOuterText(nidOf(el), value, CHANGE_STEPS);
    if (made === false) {
      throw new DOMException("Failed to set the 'outerText' property on 'HTMLElement': The element has no parent.", 'NoModificationAllowedError');
    }
    if (made !== undefined) finishChanges(made, 1);
  },
  // HTML `attachInternals()`: a DEFINED autonomous custom element's ElementInternals, once — its definition its own
  // registry's (a customized built-in, with an is value, refused with the rest), the internals its definition disables
  // as `disabledFeatures` said them when it was defined.
  attachInternals(el) {
    const def = autonomousDefinitionOf(el);
    if (!def) {
      throw new DOMException("Failed to execute 'attachInternals' on 'HTMLElement': Unable to attach ElementInternals to non-custom elements.", 'NotSupportedError');
    }
    if (def.disableInternals) {
      throw new DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals is disabled by disabledFeatures static field.", 'NotSupportedError');
    }
    if (internalsAttached(el)) {
      throw new DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals for the specified element was already attached.", 'NotSupportedError');
    }
    // (…and only to one being upgraded or custom: not one "undefined" — made before its definition and never upgraded —
    // nor "failed")
    if (!hasState(el, STATE_PRECUSTOMIZED | STATE_CUSTOM)) {
      throw new DOMException("Failed to execute 'attachInternals' on 'HTMLElement': The element is not a custom element, nor being upgraded to one.", 'NotSupportedError');
    }
    return (rareDataOf(el, true).internals = new ElementInternals(PLATFORM, el));
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
  get_contentEditable: (el) => reflectEnum(el, 'contenteditable', REFLECT_KEYWORDS_CONTENT_EDITABLE),
  set_contentEditable(el, value) {
    const k = asciiLower(value);
    if (k === 'inherit') removeAttribute(el, 'contenteditable');
    else if (k === 'true' || k === 'false' || k === 'plaintext-only') setAttribute(el, 'contenteditable', k);
    else throw new DOMException("Failed to set the 'contentEditable' property on 'HTMLElement': The value provided ('" + value + "') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.", 'SyntaxError');
  },
  get_isContentEditable: (el) => isContenteditable(el)
};

registerInterface('SVGElement', (o) => nodeObjectTypeOf(o) === NODE_ELEMENT && namespaceOf(o) === SVG_NS);
// (…and SVG's `<image>`, which a conversion asks for — `createImageBitmap`'s source — though no SVG element has an
// interface of its own here)
registerInterface('SVGImageElement', (o) => nodeObjectTypeOf(o) === NODE_ELEMENT && isSvg(o, 'image'));
// SVGElement's: an SVG element's `className` an SVGAnimatedString reflecting `class` ([SameObject]), and the nearest
// `<svg>` ancestor its owner and its viewport's element — null for the outermost one.
export const svgElementMembers = {
  ...htmlOrForeignElementMembers,
  get_className: (el) => sameObject(el, 'className', () => svgAnimatedString.create(el, 'class')),
  get_ownerSVGElement: svgAncestorOf,
  get_viewportElement: svgAncestorOf
};

// MathMLElement's are only the ones it shares.
registerInterface('MathMLElement', (o) => nodeObjectTypeOf(o) === NODE_ELEMENT && namespaceOf(o) === MATHML_NS);
export const mathMLElementMembers = htmlOrForeignElementMembers;

// `draggable`'s value — the engine's (reflect.rs `draggable`): the attribute's true or false, else true for an `<img>`
// and an `<a>` with an href. An HTML element's alone (HTMLElement's member): no other is ever dragged.
const isDraggable = (el) => dom.elementReflection(el, REFLECT_DRAGGABLE);

// A button's command (HTML §4.10.6), the engine's (activation.rs `buttonCommand`): its `command` attribute's keyword —
// one of the built-in commands, ASCII case-insensitive; a custom one (`--` and more) as it is written; '' for a missing
// or unknown one.
export const buttonCommand = (button) => dom.buttonCommand(button);
// A popover shown, hidden or toggled by an invoker's action: `toggle`, `show` (a hidden one) or `hide` (a showing one).
function invokePopover(popover, action, invoker) {
  const showing = hasState(popover, STATE_POPOVER_OPEN);
  if (showing && action !== 'show') hidePopover(popover, 'hidePopover', invoker);
  else if (!showing && action !== 'hide') showPopover(popover, 'showPopover', invoker);
}
// HTML button activation for a command or popover invoker, which each click path runs for its activation target when
// that did not submit or reset its form — what it does the engine's to say (activation.rs `invokerAction`): a `<button
// commandfor>` fires a cancelable `command` CommandEvent at its target, the invoker its source, and, uncanceled and the
// target still connected, the built-in command's steps on a popover or a dialog; a popover invoker shows, hides or
// toggles its popover by its action.
const INVOKE_POPOVER_COMMAND = 1, INVOKE_DIALOG_COMMAND = 2, INVOKE_POPOVER_TARGET = 4;
export function invokerActivation(invoker, eventTarget) {
  const made = dom.invokerAction(invoker, eventTarget);
  if (made === undefined) return;
  const [kind, target, command, action] = made;
  if (kind === INVOKE_POPOVER_TARGET) {
    invokePopover(target, action, invoker);
    return;
  }
  const event = new CommandEvent('command', { __proto__: null, cancelable: true, source: invoker, command });
  fireEvent(target, event);
  if (eventState(event).canceled || !isConnected(target)) return;
  if (kind === INVOKE_POPOVER_COMMAND) invokePopover(target, action, invoker);
  else if (kind === INVOKE_DIALOG_COMMAND) dialogCommandSteps(target, command, invoker);
}

// HTMLOrSVGElement's `dataset`: a DOMStringMap over the element's NULL-namespace `data-*` attributes, read through on
// every access — `dataset.fooBar` ↔ `data-foo-bar`. ([SameObject]: one per element.)
function datasetOf(el) {
  return sameObject(el, 'dataset', makeDataset);
}
function makeDataset(el) {
  // The name conversions (`dataset.fooBar` ↔ `data-foo-bar`, a hyphen folded only before an ASCII lower alpha — `data-a-1`
  // ↔ `a-1`) and which names are supported — those that round-trip, no hyphen before an ASCII lower alpha, the rest
  // reading as undefined and deleting nothing — are the engine's (attributes.rs `datasetAttr`, `datasetNames`): a
  // property name's attribute, or null for none.
  const attrOf = (key) => (typeof key === 'string' ? dom.datasetAttr(key) : null);
  // The named setter (HTML's steps, its value converted first, Web IDL's): a name with U+002D before an ASCII lower
  // alpha is ambiguous with the camelCase→`data-*` conversion → SyntaxError; dataset writes the NULL-namespace
  // attribute (so a same-named foreign-namespace attribute is not overwritten), its name validated
  // (InvalidCharacterError for e.g. an embedded space).
  const setNamed = (key, value) => {
    value = toDOMString(value, false, `Failed to set a named property '${key}' on 'DOMStringMap': `);
    const attr = attrOf(key);
    if (attr === null) {
      throw new DOMException(
        `Failed to set a named property '${key}' on 'DOMStringMap': '${key}' is not a valid property name.`,
        'SyntaxError');
    }
    setAttrValueNullNS(el, attr, value);
  };
  const proxy = new Proxy(objectCreate(DOMStringMap.prototype), {
    get(t, key, recv) {
      // A `data-*` attribute wins over the prototype chain; otherwise fall
      // through so `toString` / page-set Object.prototype expandos show. Only
      // a supported property name (one that round-trips) maps to an attribute
      // — `dataset['-foo']` is undefined even when `data--foo` exists (that
      // attribute maps to the name `Foo`). dataset reads the NULL-namespace
      // attribute ("get an attribute value").
      const attr = attrOf(key);
      if (attr !== null) {
        const v = getAttributeNS(el, null, attr);
        if (v !== null) return v;
      }
      return Reflect.get(t, key, recv);
    },
    // [[Set]] (Web IDL §3.9.2): the named setter where the map itself is the receiver, any other — an object it is the
    // prototype of — the ordinary steps.
    // ([CEReactions], as its setter and deleter are: their reactions run as they return)
    set(t, key, value, recv) {
      if (typeof key !== 'string' || recv !== proxy) return Reflect.set(t, key, value, recv);
      const ce = ceEnter();
      try { setNamed(key, value); } finally { ceLeave(ce); }
      return true;
    },
    // [[DefineOwnProperty]] (§3.9.3, [LegacyOverrideBuiltIns] with a named setter): a data descriptor's value set
    // through the named setter, whatever else it says; an accessor or a generic descriptor refused. (A non-configurable
    // one is set too, but answered false: a Proxy may not report a non-configurable property its target lacks.)
    defineProperty(t, key, desc) {
      if (typeof key !== 'string') return Reflect.defineProperty(t, key, desc);
      if (!('value' in desc) && !('writable' in desc)) return false;
      const ce = ceEnter();
      try { setNamed(key, desc.value); } finally { ceLeave(ce); }
      return desc.configurable !== false;
    },
    deleteProperty(t, key) {
      // Only a supported property name (one that round-trips) maps to a
      // removable attribute; `delete dataset['-foo']` must leave `data--foo`
      // (which maps to the name `Foo`) untouched. (dataset-delete.html)
      // Removes the NULL-namespace attribute (gated like get/set).
      const attr = attrOf(key);
      if (attr !== null) {
        const ce = ceEnter();
        try { removeAttributeNS(el, null, attr); } finally { ceLeave(ce); }
        return true;
      }
      return Reflect.deleteProperty(t, key);
    },
    has(t, key) {
      const attr = attrOf(key);
      if (attr !== null && attrKeyNS(el, null, attr) !== null) return true;
      return Reflect.has(t, key);   // prototype chain (toString, expandos)
    },
    ownKeys(t) {
      // Supported property names = the local names of the element's NULL-namespace `data-*` attributes with NO ASCII
      // upper alpha after `data-` (a `data-Foo` attribute is unreachable via the property mapping, so it is not a
      // supported property name) — then its own symbol-keyed properties, a page's expandos (a string-keyed one is a
      // named property).
      return [...dom.datasetNames(el), ...Reflect.ownKeys(t)];
    },
    getOwnPropertyDescriptor(t, key) {
      const attr = attrOf(key);
      if (attr !== null) {
        const v = getAttributeNS(el, null, attr);
        if (v !== null) return { writable: true, enumerable: true, configurable: true, value: v };
      }
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    // (…never made non-extensible: the named properties come and go, Web IDL §3.9.4)
    preventExtensions: () => false
  });
  makeSlots(proxy, 'DOMStringMap').element = el;
  return proxy;
}

// An element's padding edge in the viewport (its border box, past its left and top borders) — a mouse event's offset
// is from it (events.js, which imports none of the layout, asks through this hook). An inline's the block it is laid out
// in: a non-replaced inline box has no padding edge of its own to measure from (Chrome's and Firefox's,
// MouseEvent-prototype-offsetX-offsetY: a span's offset from its container's; an `<img>`'s its own) — the engine's to
// say (scroll_boxes.rs `padding_edge_box`).
globalThis.__csimPaddingEdgeOrigin = (el) => {
  const box = styleEnginePaddingEdgeBox(el);
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
// (Redmine/Avo within noise); a form's own field reads do
// go through the trap, but forms are a tiny fraction of the elements find /
// cascade walk, so the div/span hot path is untouched (rule 3). This is the
// option the older shared-FormNamedProto comment rejected as "per-form Proxy …
// megamorphic" — but the form TARGET keeps ONE shape (the trap forwards), so
// there is no megamorphism, only the (measured-negligible) trap indirection.
// HTML's form-associated elements: the listed ones, `<img>`, and a form-associated custom element (whose definition says
// `static formAssociated = true`) — HTML elements each, the engine's to say (element_state.rs `is_form_associated`) —
// what a form's named access, and an inline handler's scope chain, take a form owner of.
const isFormAssociated = (el) => dom.isFormAssociated(nidOf(el));
const FORM_NAMED_VALUES = new Set();   // name/id values seen on a form-associatable element — gates the O(document) candidate scan
const FORM_INDEX_RE     = /^(?:0|[1-9]\d*)$/;
const formProxyOf       = new WeakMap();   // form TARGET → its Proxy (the canonical form), for traps without a receiver
// Per-form internal state kept in WeakMaps (keyed by the Proxy), NOT as `_`-prefixed
// fields on the form — reading such a field through the Proxy would re-enter the
// named-getter trap (and a control named "ownerDocument"/"_x" could even recurse).
const formNamedLists = new WeakMap();   // form → Map(name → live NodeList): [SameObject] for repeated `form.<radio>`

// `fieldset.elements` membership: the listed-element DESCENDANTS of the fieldset
// (including nested fieldsets and their controls), in tree order — rooted at the
// fieldset, not by form owner (HTMLFieldSetElement.elements is a plain HTMLCollection) — the engine's
// (element_state.rs `fieldset_listed`).
export function fieldsetControlElements(fieldset) {
  return dom.fieldsetListed(nidOf(fieldset));
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

// HTML form named getter — the engine's (element_state.rs `form_named_item`, which keeps the form's past names map):
// one named element of `name`, or the past names map's; several → a cached [SameObject] live RadioNodeList over them
// (`form_named`, in the form's tree — its root's, a shadow root's for a shadow-resident form, or its own subtree's
// detached); else undefined. Gated by FORM_NAMED_VALUES so a name no element has ever had is O(1) — mirrors
// WindowNamedProps — as every property read of a form asks (rule 3); the engine keeps what it finds until the tree
// next changes.
function formNamedItem(form, name) {
  if (!FORM_NAMED_VALUES.has(name)) return undefined;
  const item = dom.formNamedItem(nidOf(form), name);
  if (item !== true) return item ?? undefined;
  let lm = formNamedLists.get(form);
  if (!lm) formNamedLists.set(form, lm = new Map());
  let nl = lm.get(name);
  if (!nl) { nl = liveRadioNodeList(() => dom.formNamed(nidOf(form), name)); lm.set(name, nl); }
  return nl;
}

// Shared handler for every <form>'s Proxy. Each trap derives the canonical form
// from the receiver (get/set) or `formProxyOf` (the rest), so ONE handler object
// serves all forms (no per-form handler → no megamorphism on the handler).
// …what no control's name reaches: an own property of the form, an author's expando.
const formOwn = (t, prop) => Object.prototype.hasOwnProperty.call(t, prop);
const FORM_HANDLER = {
  get(t, prop, recv) {
    // OverrideBuiltins: a named control shadows a prototype builtin (form.submit →
    // <input name=submit>) and an index → the listed element. Per WebIDL only an
    // AUTHOR own property (an expando) blocks the named lookup.
    if (typeof prop === 'string' && !formOwn(t, prop)) {
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
    if (typeof prop === 'string' && !formOwn(t, prop) &&
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
    if (typeof prop === 'string' && !formOwn(t, prop)) {
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
    if (typeof prop === 'string' && !formOwn(t, prop)) {
      // A supported index or a current named property can't be redefined by an
      // author descriptor (legacy platform object) → false, so a strict define throws.
      if (FORM_INDEX_RE.test(prop)) { if ((+prop) < formIndexedElements(t).length) return false; }
      else if (formNamedItem(formProxyOf.get(t) || t, prop) !== undefined) return false;
    }
    return Reflect.defineProperty(t, prop, desc);
  },
  deleteProperty(t, prop) {
    if (typeof prop === 'string' && !formOwn(t, prop)) {
      // A supported index (in range) or a current named property can't be deleted
      // (legacy platform object) → false, so a strict `delete` throws.
      if (FORM_INDEX_RE.test(prop)) { if ((+prop) < formIndexedElements(t).length) return false; }
      else if (formNamedItem(formProxyOf.get(t) || t, prop) !== undefined) return false;
    }
    return Reflect.deleteProperty(t, prop);
  },
  // Web IDL [[OwnPropertyKeys]] of a legacy platform object: its supported indices, then its supported property names
  // (non-enumerable, [LegacyUnenumerableNamedProperties], but keys all the same) — the named elements' ids and names in
  // tree order, then the past names map's still reachable: the engine's — then its own properties.
  ownKeys(t) {
    const keys = [];
    const n = formIndexedElements(t).length;
    for (let i = 0; i < n; i++) keys.push(String(i));
    for (const name of dom.formSupportedNames(nidOf(t))) if (!formOwn(t, name) && !FORM_INDEX_RE.test(name)) keys.push(name);
    const listed = new Set(keys);
    for (const k of Reflect.ownKeys(t)) if (!listed.has(k)) keys.push(k);
    return keys;
  },
  // A legacy platform object cannot be made non-extensible (Web IDL §3.9.4): `Object.preventExtensions` throws.
  preventExtensions: () => false
};

// Wrap a freshly-constructed <form> target in its named-property Proxy and record
// the target→Proxy mapping. Called from the Element constructor.
function makeFormProxy(target) {
  const proxy = new Proxy(target, FORM_HANDLER);
  formProxyOf.set(target, proxy);
  stampNodeProxy(proxy, target);   // (…the node a script holds is the Proxy — its handle's too)
  if (dom) dom.setNodeObject(proxy);
  return proxy;
}

// A <select> is a legacy platform object (Web IDL §3.9) whose indexed properties are its list of options: the Proxy
// each select is — as a form is — answers an index with its option (an own, enumerable, writable property), takes one
// set at an index as its options collection's setter does (`select[i] = option | null`), defines one only as that
// setter, and keeps a supported one from deletion. Every other key is the select's own: its fields, read through the
// first trap's one comparison.
const SELECT_HANDLER = {
  get(t, prop, recv) {
    const i = arrayIndex(prop);
    if (i < 0) return Reflect.get(t, prop, recv);
    const options = listOfOptions(t);
    return i < options.length ? options[i] : Reflect.get(t, prop, recv);
  },
  // (…an object that inherits from the select set as an ordinary object is)
  set(t, prop, value, recv) {
    if (arrayIndex(prop) < 0 || recv !== selfOf(t)) return Reflect.set(t, prop, value, recv);
    recv.options[prop] = value;
    return true;
  },
  has(t, prop) {
    const i = arrayIndex(prop);
    return i >= 0 && i < listOfOptions(t).length || Reflect.has(t, prop);
  },
  getOwnPropertyDescriptor(t, prop) {
    const i = arrayIndex(prop);
    if (i < 0) return Reflect.getOwnPropertyDescriptor(t, prop);
    const options = listOfOptions(t);
    return i < options.length ? { value: options[i], writable: true, enumerable: true, configurable: true } : undefined;
  },
  defineProperty(t, prop, desc) {
    if (arrayIndex(prop) < 0) return Reflect.defineProperty(t, prop, desc);
    if (!('value' in desc)) return false;
    selfOf(t).options[prop] = desc.value;
    return true;
  },
  deleteProperty(t, prop) {
    const i = arrayIndex(prop);
    return i < 0 ? Reflect.deleteProperty(t, prop) : i >= listOfOptions(t).length;
  },
  ownKeys(t) {
    const keys = listOfOptions(t).map((_, i) => String(i));
    return keys.concat(Reflect.ownKeys(t));
  },
  preventExtensions: () => false
};
function makeSelectProxy(target) {
  const proxy = new Proxy(target, SELECT_HANDLER);
  stampNodeProxy(proxy, target);
  if (dom) dom.setNodeObject(proxy);
  return proxy;
}

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
export function registerTagTarget(tag, proto) {
  const target = function () {};
  target.prototype = proto;
  ELEMENT_TARGETS.set(tag, target);
}
// …and the interfaces an element with no tag interface of its own is made with, by namespace (dom-class-aliases.js
// registers them): HTMLElement for a known HTML name with none and for a valid custom element name not defined yet,
// HTMLUnknownElement for any other HTML name, SVGElement, MathMLElement.
const NAMESPACE_TARGETS = {};
export function registerNamespaceTargets(protos) {
  for (const [key, proto] of Object.entries(protos)) {
    const target = function () {};
    target.prototype = proto;
    NAMESPACE_TARGETS[key] = target;
  }
}
// An element as `new Element(PLATFORM, tagName, ns, localName, prefix)` makes one, with the prototype of its interface: an HTML
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
  return target === Element ? new Element(PLATFORM, tagName, ns, localName, prefix) : reflectConstruct(Element, [PLATFORM, tagName, ns, localName, prefix], target);
}
// Gate the form named-property lookup: record any name/id value seen on a
// form-associatable element, so `form.<unregistered>` is O(1) (a Set miss) and
// never walks the document. The form Proxy's traps resolve existence + value
// live against the tree (FORM_HANDLER / formNamedItem) — never frozen into a
// getter — so the value is always current, a control associated via `form="…"`
// outside the form subtree is found, same-named controls yield a RadioNodeList,
// and a cross-realm-adopted control still resolves.
function registerFormName(el, value) {
  if (value && isFormAssociated(el)) FORM_NAMED_VALUES.add(value);
}

// A form-associated custom element's form owner (HTML "reset the form owner") and disabled state re-derived — the
// engine's (ce_reactions.rs `ceFormStateReset`), which enqueues its formAssociatedCallback(newOwner) or
// formDisabledCallback(isDisabled) where either is another than its callbacks were last told, so the overlapping
// upgrade / connect seams enqueue nothing twice. A reset of its owner also registers its name and id for the form named
// getter: the parse-time registerFormName ran before the element was form-associated, so an element upgraded after the
// parse would be missing from formNamedItem. What either changes of the live form.elements / fieldset.elements
// collections and the form named getter is no tree mutation, so the settle generation moves for their caches (the
// explicit `customElements.upgrade()` path, which no parse or insertion bumps): the engine's for a new owner, the
// bindings' for a name.
function resetFormStateOf(el, which) {
  if (!isFormAssociatedCustomElement(el)) return;
  let changed = false;
  if (which & FACE_FORM_OWNER) {
    const named = attrsOf(el).form;
    if (named != null) formNamingCustoms = true;
    const nm = attrsOf(el).name, id = attrsOf(el).id;
    if (nm && !FORM_NAMED_VALUES.has(nm)) { FORM_NAMED_VALUES.add(nm); changed = true; }
    if (id && !FORM_NAMED_VALUES.has(id)) { FORM_NAMED_VALUES.add(id); changed = true; }
  }
  // (…a new owner the engine's to note — ce_reactions.rs `reset_form_state` — and a name the form's named getter has
  // newly, the bindings')
  resetCustomElementFormState(el, which);
  engineWritten();
  if (changed) bumpSettleGen(false, el);
}
const resetCustomElementFormOwner = (el) => resetFormStateOf(el, FACE_FORM_OWNER);
const resetCustomElementDisabledState = (el) => resetFormStateOf(el, FACE_DISABLED_STATE);
setFormAssociatedReset((el) => resetFormStateOf(el, FACE_FORM_OWNER | FACE_DISABLED_STATE));
// A select's `<selectedcontent>` elements made to show its selection (custom-elements.js `updateSelectedContent`): the
// engine's clones in place of their children, the copies' cloning steps and the changes finished — where it does not
// show them already, or `force`d.
setSelectedContentUpdater((select, force) => {
  const made = dom.updateSelectedContent(nidOf(select), force, CHANGE_STEPS);
  if (made === undefined) {
    throwCloneException();
    return;
  }
  const copiesEnd = 1 + 3 * made[0];
  for (let i = 1; i < copiesEnd; i += 3) bindingsCloningSteps(made[i], made[i + 1], made[i + 2]);
  finishChanges(made, copiesEnd);
  throwCloneException();
});

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
  } else if (attrName === 'id') {
    if (formNamingCustoms) idsChanged(el);
  } else if (attrName === 'disabled' && isHtml(el, 'fieldset')) {
    // A <fieldset disabled> toggle flips the "actually disabled" state of every
    // form-associated element it contains (except within its first <legend>). Walk
    // the fieldset's own subtree rather than the document — a detached fieldset tree
    // is common (createElement('fieldset') + innerHTML).
    for (const n of elementsInState(el, STATE_FORM_ASSOCIATED)) resetCustomElementDisabledState(n);
  }
}

// HTML: "an element with an ID is inserted into or removed from the Document, or its ID changes" — the form-associated
// custom elements whose `form` attribute names their form owner reset it (formAssociatedCallback where it changed — the
// engine's, which knows the owner each was last told, and in a document walks the tree only where an id such an
// attribute names is another element's now: ce_reactions.rs `ce_form_owners_reset`), those in the tree of `node`, the
// element it was or its parent: a `form="f"` parsed before its `<form id=f>` is owned by it once that is, and by none
// once an element of that id comes before it or the form goes. Run as the change ends — the parser's has an element
// queue of its own — and only once a form-associated custom element has had a `form` attribute (`formNamingCustoms`),
// so a page with none asks nothing.
let formNamingCustoms = false;
function idsChanged(node) {
  const ce = ceEnter();
  try {
    resetFormOwnersNamedIn(rootNodeOf(node));
    engineWritten();
  } finally { ceLeave(ce); }
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
// Perf (rule 3): the traps only ask the engine (`windowNamedLookup`) when the
// name was registered as an id/name AND isn't a real member of the prototype
// chain, so an undefined-global read (feature detection like `typeof Foo`) costs
// one Set.has — never a document walk; and one never seen as a `name` is looked up
// by id alone, from the engine's id map. The cascade/find hot path reads element
// fields, not globals, so it never touches this chain.
const WINDOW_NAMED_PROPS = { __proto__: null };
const WINDOW_NAME_VALUES  = new Set();   // …of those, the values seen as a window-named element's `name` (gates the walk)

// HTML's named access on the Window object: the named objects of the window with the name — the engine's
// (collections.rs `window_named`) — a navigable among them its container's WindowProxy, the first in tree order (the
// child realm's global, so `eventListenerGlobalObject.Object` reaches its intrinsics; an iframe matched by its `id`
// alone is the element, `window.<iframeId>.contentWindow` working as in Chrome); else the one element, or a live
// HTMLCollection of them all.
const WINDOW_NAVIGABLES = 0, WINDOW_IDS = 1, WINDOW_OBJECTS = 2;
function windowNamedObjects(doc, name, kind) {
  return dom.windowNamed(nidOf(doc), name, kind);
}
function sameOriginFrame(container) {
  const realm = frameRealmOf(container);
  if (realm == null) return true;
  return dom.sameOriginRealm(realm);
}
function windowNamedLookup(name) {
  const doc = globalThis.document;
  if (!doc) return undefined;
  const byName = WINDOW_NAME_VALUES.has(name);
  if (byName) {
    for (const container of windowNamedObjects(doc, name, WINDOW_NAVIGABLES)) {
      // (…a target name the navigable gave itself only where its document is same origin with this one: HTML §7.2.2.3
      // step 5 — a cross-origin frame's own `window.name` is not the parent's to see)
      if (attrsOf(container).name !== name && !sameOriginFrame(container)) continue;
      const cw = frameContentWindow(container);
      if (cw) return cw;
    }
  }
  const kind = byName ? WINDOW_OBJECTS : WINDOW_IDS;
  const objects = windowNamedObjects(doc, name, kind);
  if (objects.length <= 1) return objects[0];
  return liveHTMLCollection(() => windowNamedObjects(doc, name, kind));
}

const WindowNamedTarget = Object.getPrototypeOf(globalThis);
// The document's document-tree child navigables' containers — its HTML <iframe>s and <frame>s, in tree order (an
// `IFRAME` made by createElementNS, an HTMLUnknownElement, or another namespace's `iframe`, is none; nor is one in a
// shadow tree) — the engine's (navigables.rs), the first `limit` of them where it is given — which back `window[n]`,
// `window.length` and `window.frames`.
export function childNavigableContainers(limit) {
  const d = globalThis.document;
  return d ? dom.childNavigables(nidOf(d), limit) : EMPTY_NODES;
}
const WindowNamedProps  = new Proxy(WindowNamedTarget, {
  has(target, prop) {
    if (Reflect.has(target, prop)) return true;
    if (typeof prop === 'string') {
      if (/^(0|[1-9][0-9]*)$/.test(prop)) return Number(prop) < childNavigableContainers(Number(prop) + 1).length;
      if (WINDOW_NAMED_PROPS[prop] === true) return windowNamedLookup(prop) !== undefined;
    }
    return false;
  },
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !Reflect.has(target, prop)) {
      // `window[n]` — the nested browsing contexts: the n-th frame's contentWindow (== window.frames[n]; `length` is
      // the window's own attribute).
      if (/^(0|[1-9][0-9]*)$/.test(prop)) {
        const el = childNavigableContainers(Number(prop) + 1)[Number(prop)];
        if (el) return frameContentWindow(el);
      } else if (WINDOW_NAMED_PROPS[prop] === true) {
        const el = windowNamedLookup(prop);
        if (el !== undefined) return el;
      }
    }
    return Reflect.get(target, prop, receiver);
  },
  getOwnPropertyDescriptor(target, prop) {
    const own = Reflect.getOwnPropertyDescriptor(target, prop);
    if (own) return own;
    if (typeof prop === 'string' && WINDOW_NAMED_PROPS[prop] === true) {
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

// An element's local name where it is an HTML element — what the named properties of a window and a document ask (an
// `IFRAME` createElementNS makes, or another namespace's `form`, is none of theirs) — else null.
const htmlName = (el) => (namespaceOf(el) === HTML_NS ? localNameOf(el) : null);
// …and a frame's target name, the one it gave itself (`window.name`): its window's named access finds it by that too.
hostSteps.registerNavigableName = function (value) {
  if (!value) return;
  WINDOW_NAME_VALUES.add(value);
  WINDOW_NAMED_PROPS[value] = true;
};

// Single entry point for every name/id attribute-write path: a control's name/id gates its form's named access
// (FORM_NAMED_VALUES / FORM_HANDLER), and the window's and the document's named-properties objects (WindowNamedProps,
// DocumentNamedProps) the gates the engine says it arms (collections.rs `namedGates`) — only a name a lookup may find, so
// a gate stays a tight O(1) disqualifier (rule 3). Just the name: existence and value are resolved live by the Proxy
// traps against the current document, never frozen into a getter.
const GATE_WINDOW = 1, GATE_DOCUMENT = 2;
function registerNamedAccess(el, attrName, value) {
  if (!value) return;
  registerFormName(el, value);
  const gates = dom.namedGates(nidOf(el), attrName === 'name');
  if (gates & GATE_WINDOW) {
    WINDOW_NAMED_PROPS[value] = true;
    if (attrName === 'name') WINDOW_NAME_VALUES.add(value);
  }
  if (gates & GATE_DOCUMENT) {
    DOC_NAMED_PROPS[value] = true;
    docNamedPropsSeen = true;
  }
}
// …and an element's names, where another realm registered them: one adopted or imported from its document.
function registerNamesOf(el) {
  const attrs = attrsOf(el);
  if (attrs.id) registerNamedAccess(el, 'id', attrs.id);
  if (attrs.name) registerNamedAccess(el, 'name', attrs.name);
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
let docNamedPropsSeen = false;
const DOC_NAMED_PROPS = { __proto__: null };   // names ever seen as a doc-supported name/id (gates the lookup scan)

// The document's named elements with the name, in tree order — the engine's (collections.rs `document_named`).
function docNamedElements(doc, name) {
  return dom.documentNamed(nidOf(doc), name);
}

function documentNamedLookup(doc, name) {
  if (!doc || DOC_NAMED_PROPS[name] !== true) return undefined;
  const els = docNamedElements(doc, name);
  if (els.length === 0) return undefined;
  if (els.length === 1) {
    const el = els[0];
    if (htmlName(el) === 'iframe') { const cw = frameContentWindow(el); if (cw) return cw; }
    return el;
  }
  return liveHTMLCollection(() => docNamedElements(doc, name));
}

// The document's supported property NAMES, in tree order, deduped (first occurrence wins) — the engine's
// (collections.rs `document_names`). Backs the ownKeys trap; side-effect-free (never touches contentWindow).
function docSupportedNames(doc) {
  return dom.documentNames(nidOf(doc));
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
      if (!docNamedPropsSeen || !Reflect.isExtensible(t)) return keys;
      const seen = new Set(keys);
      // Gate on DOC_NAMED_PROPS so the key set matches exactly what the
      // descriptor / GET halves resolve (both gate on it) — no key can enumerate
      // that getOwnPropertyDescriptor would then report as absent.
      for (const n of docSupportedNames(t)) if (DOC_NAMED_PROPS[n] === true && !seen.has(n)) { keys.push(n); seen.add(n); }
      return keys;
    },
    getOwnPropertyDescriptor(t, p) {
      const own = Reflect.getOwnPropertyDescriptor(t, p);
      if (own) return own;
      if (typeof p === 'string' && DOC_NAMED_PROPS[p] === true) {
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
  stampNodeProxy(proxy, doc);   // (…the document a script holds is the Proxy — the one identity of its two views)
  if (dom) dom.setNodeObject(proxy);
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

class DocumentFragment extends Node {
  constructor() {
    const self = nodeObject(new.target, NODE_FRAGMENT);
    const engine = makingEngineObject();
    registerNativeNode(self);
    constructedInto(self, engine);
    return self;
  }
}
// DocumentFragment's members, and ParentNode / NonElementParentNode's: generated from their IDL onto the class.
registerInterface('DocumentFragment', (o) => nodeObjectTypeOf(o) === NODE_FRAGMENT);
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
  return elementsAtPoint(scope, x, y, false)[0] ?? null;
}
// …and `elementsFromPoint`: every element painted there, topmost first (`hitTestAll`) — each retargeted, once.
function elementsFromPointIn(scope, x, y) {
  return elementsAtPoint(scope, x, y, true);
}
// (…in the scope's own document, hit-tested by the realm whose document it is — another realm's member asked of a
// frame's answers the frame's — and none for a document that is not fully active: one with no browsing context, a
// `createHTMLDocument` one's, or a frame's its navigation or removal left behind — Chrome)
function elementsAtPoint(scope, x, y, all) {
  const doc = nodeTypeOf(scope) === NODE_DOC ? scope : nodeDocumentOf(scope);
  const realm = foreignRealmOf(doc);
  if (realm) return realm.elementsAtPoint(scope, x, y, all);
  if (!fullyActive(doc) || !insideViewport(x, y)) return [];
  const out = [];
  for (const hit of all ? hitTestAll(x, y) : [hitTest(x, y)]) {
    const el = hit && retarget(hit, scope);
    if (el && !out.includes(el)) out.push(el);
  }
  return out;
}
NATIVE_REALM.elementsAtPoint = elementsAtPoint;
function insideViewport(x, y) {
  const vp = viewportSize();
  return x >= 0 && y >= 0 && x < vp.width && y < vp.height;
}
// …and `caretPositionFromPoint`: the caret position at the viewport point — none for a document with no browsing
// context, or a point outside the viewport — out of each shadow tree `options.shadowRoots` does not name: before its
// host, in the host's parent.
function caretPositionFromPointIn(doc, x, y, options) {
  const realm = foreignRealmOf(doc);
  if (realm) return realm.caretPositionFromPoint(doc, x, y, options);
  if (!fullyActive(doc) || !insideViewport(x, y)) return null;
  const at = caretFromPoint(x, y);
  if (!at) return null;
  let [node, offset] = at;
  const given = options.shadowRoots || [];
  for (let root = rootNodeOf(node); isShadowRoot(root) && !given.includes(root); root = rootNodeOf(node)) {
    const host = hostOf(root);
    node = parentOrHostOf(host);
    if (!node) return null;
    offset = childIndexOf(node, host);
  }
  return new CaretPosition(PLATFORM, node, offset);
}
// (…a frame's document asked by another realm's member answers by the frame's)
NATIVE_REALM.caretPositionFromPoint = caretPositionFromPointIn;
// CSSOM View's CaretPosition: a caret position — its node and its offset there — and the caret's rect.
const caretPositionOf = (o) => slotsOf(o, 'CaretPosition');
const CaretPosition = defineCaretPosition({
  init(slots, offsetNode, offset) {
    slots.offsetNode = offsetNode;
    slots.offset = offset;
  },
  // (…a new rect each time: zero wide, where the layout has the place — text_geometry.rs `caret_rect` — else none)
  getClientRect(p) {
    const { offsetNode, offset } = caretPositionOf(p);
    const r = caretRectOf(offsetNode, offset);
    return r ? new DOMRect(r[0], r[1], r[2], r[3]) : null;
  }
});
globalThis.CaretPosition = CaretPosition;

// A shadow root's mode, the engine's closed flag (`SHADOW_CLOSED`, set as it is attached) — never its `mode` member,
// which a page may replace.
export const shadowRootMode = (sr) => (shadowIs(sr, SHADOW_CLOSED) ? 'closed' : 'open');
class ShadowRoot extends DocumentFragment {
  constructor(token) {
    if (token !== SHADOW_ROOT_INTERNAL) throw new TypeError('Illegal constructor');
    // (…a fragment, whose node document its host's: its attaching sets it)
    const self = nodeObject(new.target, NODE_FRAGMENT);
    stampShadowRoot(self);
    registerNativeNode(self);
    return self;
  }
  // CSSOM-View `ShadowRoot.elementFromPoint(x, y)` / `elementsFromPoint`: the document's hit test, retargeted
  // against this root (`elementFromPointIn`) — so a hit inside a tree nested in this one answers as its host.
  elementFromPoint(x, y)  { return elementFromPointIn(this, x, y); }
  elementsFromPoint(x, y) { return elementsFromPointIn(this, x, y); }
  // Legacy `ShadowRoot.getSelection()` (non-standard, Chrome-supported): the
  // current selection scoped to this shadow tree. We model a single per-document
  // selection, so return the document's selection (its range may live in this
  // shadow tree) — its toString reflects the selected text. (shadow-dom
  // ranges-and-selections.)
  getSelection() { return globalThis.__csimGetSelection(nodeDocumentOf(this)); }
}
globalThis.ShadowRoot = ShadowRoot;
// ShadowRoot's members (generated/bindings.js) — DocumentOrShadowRoot's among them, Document's alike where the two
// answer alike. (Chrome's legacy `elementFromPoint` / `elementsFromPoint` / `getSelection`, no IDL's, stay the
// class's.)
registerInterface('ShadowRoot', (o) => isShadowRoot(o) && isNodeObject(o));
installShadowRoot(ShadowRoot, {
  get_mode: shadowRootMode,
  get_host: (root) => hostOf(root),
  get_delegatesFocus: (root) => shadowIs(root, SHADOW_DELEGATES_FOCUS),
  get_slotAssignment: (root) => (shadowIs(root, SHADOW_MANUAL_SLOTS) ? 'manual' : 'named'),
  get_clonable: (root) => shadowIs(root, SHADOW_CLONABLE),
  get_serializable: (root) => shadowIs(root, SHADOW_SERIALIZABLE),
  // (…set at attachShadow: unset, it tracks the node document, as an element's does; else the scoped or null registry
  // the tree was made with)
  get_customElementRegistry: shadowRootRegistry,
  get_styleSheets: styleSheetListOf,
  // (…a rule-set change the document cascade key can't see: the cascade version moves, which hands the tree's sheets
  // to the style engine again — sheet_feed.rs `feed_shadows` — and re-keys every rule-set-keyed memo)
  get_adoptedStyleSheets: adoptedStyleSheetsOf,
  set_adoptedStyleSheets: setAdoptedStyleSheets,
  // The focused element retargeted against this tree: one in it, or the host in it of the tree it is in; none for one
  // elsewhere — its node document's focus (a root another realm made, adopted here, reads its document's realm's).
  get_activeElement: activeElementOf,
  get_fullscreenElement: () => null,
  get_pictureInPictureElement: () => null,
  get_pointerLockElement: () => null,
  getAnimations: (root) => animationsForRoot(root),
  // `setHTMLUnsafe` parses as `innerHTML` does — with the HTML parser, in an XML document too — and attaches the
  // declarative shadow roots it makes, as Element's.
  // (…in its host's context, of its own registry: HTML "unsafely set HTML" given it and its shadow host)
  setHTMLUnsafe: setShadowRootHTML,
  getHTML: getHTMLOf,
  get_innerHTML: innerHTMLOf,
  set_innerHTML: setInnerHTML,
  installEventHandlers: installEventHandlerAttrs
});

// ── ElementInternals, its CustomStateSet and ValidityState ───────────
// CustomStateSet (HTML §4.13.6.8), generated from its IDL: a setlike<DOMString> the platform makes for an
// ElementInternals, its states a Set in its slots. A mutation that changed it mirrors the set into the element's arena
// node, where the native matcher answers `:state()` — a cascade input no attribute and no DOM change stands behind, whose
// write moves the style-state generation (dom.rs `set_custom_states`). (Reads are free.)
const statesOf = (o) => slotsOf(o, 'CustomStateSet');
const CustomStateSet = defineCustomStateSet({
  init(slots, element) {
    slots.set = new Set();
    slots.element = element;
  },
  setOf: (states) => statesOf(states).set,
  setChanged(states) {
    const s = statesOf(states);
    syncCustomStates(s.element, s.set);
  }
});
globalThis.CustomStateSet = CustomStateSet;

// ValidityState's flags, in its IDL order, and a validity with none set.
const VALIDITY_FLAG_NAMES = [
  'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow',
  'stepMismatch', 'badInput', 'customError'
];
const CUSTOM_ERROR = 1 << VALIDITY_FLAG_NAMES.indexOf('customError');
const NO_VALIDITY_FLAGS = Object.freeze(Object.fromEntries(VALIDITY_FLAG_NAMES.map((k) => [k, false])));
// …told by value, not by being this realm's NO_VALIDITY_FLAGS: a frame's ValidityState getter may be handed flags of this
// realm, and the other way round.
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
// (…the form-associated members' first step: a NotSupportedError for an element that is not one)
function formAssociatedSlots(internals, member) {
  const s = internalsOf(internals);
  if (!s.formAssociated) {
    throw new DOMException(`Failed to execute '${member}' on 'ElementInternals': The target element is not a form-associated custom element.`, 'NotSupportedError');
  }
  return s;
}
// A value `setFormValue` was given, as the element keeps it: a FormData as its entries, anything else as it is.
const entriesOrValue = (value) => (isFormData(value) ? formDataEntries(value).slice() : value);
// ARIAMixin on ElementInternals: UNLIKE Element's, these do NOT reflect content attributes — they are the custom
// element's DEFAULT semantics, stored in its slots (null until set; a list FrozenArray-converted once by the binding,
// so `i.prop === i.prop`). The element's own role / aria-* attributes override them in the accessibility computation
// (testdriver-vendor's get_computed_role/label read both sides in that order). Strings are kept VERBATIM.
const internalsAria = {};
for (const idl of [...ARIA_STRING_MEMBERS, ...Object.keys(ARIA_ELEMENT_REF_ATTRS), ...Object.keys(ARIA_ELEMENT_REFLIST_ATTRS)]) {
  internalsAria[`get_${idl}`] = (internals) => internalsOf(internals).aria?.[idl] ?? null;
  internalsAria[`set_${idl}`] = (internals, v) => { (internalsOf(internals).aria ??= objectCreate(null))[idl] = v; };
}
const ElementInternals = defineElementInternals({
  init(slots, target) {
    slots.target = target;
    slots.formAssociated = autonomousDefinitionOf(target)?.formAssociated === true;
    slots.states = new CustomStateSet(PLATFORM, target);
    slots.aria = null;
  },
  // DocumentOrShadowRoot exposure: the (open OR closed) shadow root the element hosts — `Element.shadowRoot` hides a
  // closed root; this does not — where it is "available to element internals": declarative, or attached once the
  // element was custom (or being upgraded), not a closed one a script attached before.
  get_shadowRoot(internals) {
    const root = shadowRootOf(internalsOf(internals).target);
    return root && shadowIs(root, SHADOW_INTERNALS) ? root : null;
  },
  get_form: (internals) => formForControl(formAssociatedSlots(internals, 'form').target) || null,
  // Sets the target's submission value — what the form's entry list picks up for it (form-fields.js
  // `appendCustomElementEntries`) — and its state, what a history traversal back to its document hands its
  // formStateRestoreCallback (html-forms.js `restoreFormState`): `state` where given, else the value. A FormData is
  // stored as a SNAPSHOT of its entries, per spec: the element's value is "a list of entries", so a later mutation of
  // the caller's FormData must not reach the form.
  setFormValue(internals, value, state) {
    const rare = rareDataOf(formAssociatedSlots(internals, 'setFormValue').target, true);
    rare.submissionValue = entriesOrValue(value);
    rare.formState = state === undefined ? rare.submissionValue : entriesOrValue(state);
  },
  // HTML `setValidity(flags, message, anchor)`: the flags (a ValidityStateFlags dictionary) are the element's validity —
  // its custom validity (validity.rs `set_custom_validity`), as `:invalid` and its form read it; with any of them set,
  // `message` is required and non-empty; an `anchor` must be within the target's shadow-including subtree.
  setValidity(internals, flags, message, anchor) {
    const target = formAssociatedSlots(internals, 'setValidity').target;
    const bits = VALIDITY_FLAG_NAMES.reduce((b, k, i) => (flags[k] ? b | 1 << i : b), 0);
    if (bits !== 0 && !message) {
      throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': The second argument should not be empty if one or more flags in the first argument are true.");
    }
    // (…the flags and the message set before the anchor is checked: HTML's steps 5–8, then 10)
    setCustomValidityOf(target, bits, message ?? '');
    if (anchor !== undefined) {
      if (!dom.shadowIncludingInclusiveAncestor(target, anchor)) {
        throw new DOMException("Failed to execute 'setValidity' on 'ElementInternals': The validation anchor is not a shadow-including descendant of the element.", 'NotFoundError');
      }
    }
    // (…its validation anchor, where the problem is reported: none where none was given)
    rareDataOf(target, true).validationAnchor = anchor ?? null;
  },
  get_willValidate: (internals) => willValidateOf(formAssociatedSlots(internals, 'willValidate').target),
  get_validationMessage: (internals) => validationMessageOf(formAssociatedSlots(internals, 'validationMessage').target),
  get_validity: (internals) => sameObject(formAssociatedSlots(internals, 'validity').target, 'validity', liveValidityState),
  // (…its element's labels — a form-associated custom element is labelable — the same live list every time)
  get_labels: (internals) => labelsOf(formAssociatedSlots(internals, 'labels').target),
  checkValidity: (internals) => checkValidityOf(formAssociatedSlots(internals, 'checkValidity').target),
  reportValidity: (internals) => reportValidityOf(formAssociatedSlots(internals, 'reportValidity').target),
  // (…[SameObject]: its CustomStateSet, which the `:state(ident)` pseudo-class reads)
  ...internalsAria
});
globalThis.ElementInternals = ElementInternals;
hostSteps.applyAsyncImage = hostTask((id, r) => applyAsyncImage(id, r));
// …and which realm that is: the one that began it, -1 for none (image_requests.rs `fetch_realm`).
hostSteps.imageFetchRealm = (id) => dom.imageFetchRealm(id);

// ── Slot assignment (DOM §"assigning slottables and slots") ─────────
// The engine assigns (slots.rs) where the tree and the attributes change (dom.rs `slot_steps`), and signals each slot
// whose assigned nodes changed, whose slotchange fires here; assignedSlot / assignedNodes / assignedElements read what
// it stored. `shadowHostCount` gates the bindings' own shadow work (the flattened event path, focus): it only rises — a
// host removed mid-page keeps it — but `visit()` rebuilds the VM per page, so a shadow-free page starts (and stays) at
// zero.
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

// Whether an element may host a shadow tree: its local name a valid shadow host name — one of the listed elements, or a
// valid custom element name (custom_elements.rs `shadow_host_kind`) — and none whose definition — its registry's, by its
// local name and is value: a customized built-in `<h2 is="…">`'s too — disables a shadow root, as `disabledFeatures`
// said when it was defined: an imperative attachShadow and a declarative `<template shadowrootmode>` alike.
const HOST_CUSTOM = 2;
function canAttachShadow(el) {
  const kind = dom.shadowHostKind(nidOf(el));
  if (kind === 0) return false;
  return !((kind === HOST_CUSTOM || isValueOf(el) != null) && shadowDisabled(el));
}

// The steps a sheet adopted into a document or a shadow root passes — `adoptedStyleSheets = […]`'s and an index
// write's alike (CSSOM's "set an indexed value"): a constructed sheet, of the document the root is in (one an owned
// `<style>` / `<link>` has, or one built in another document — an iframe's — a NotAllowedError).
function checkAdoptable(sheet, root) {
  const constructorDocument = slotsOf(sheet, 'CSSStyleSheet').constructorDocument;
  if (constructorDocument === null) throw new DOMException("Can't adopt a non-constructed stylesheet", 'NotAllowedError');
  const doc = nodeTypeOf(root) === NODE_DOC ? root : nodeDocumentOf(root);
  if (constructorDocument !== doc) {
    throw new DOMException("Failed to set the 'adoptedStyleSheets' property: Sheet constructed in a different document", 'NotAllowedError');
  }
}
const IS_CSS_STYLE_SHEET = interfaceCheck('CSSStyleSheet');

// `adoptedStyleSheets` is a live ObservableArray<CSSStyleSheet>, not a plain array: an in-place mutation (push / splice /
// index or length assignment) must convert and check each new member and invalidate the cascade, exactly as
// reassigning the whole attribute does. A Proxy over an empty array keeps `Array.isArray` true while trapping every
// read and write of its indices and its length, which go to the engine's list (`adoptedSheet*`, dom.rs
// `AdoptedSheets`) — the one the cascade takes, and the only one there is; index writes go through
// [[DefineOwnProperty]] rather than [[Set]], so an inherited `Array.prototype` accessor can never observe or hijack the
// list — per the ObservableArray spec, and asserted by css/cssom/adoptedstylesheets-observablearray.
function makeAdoptedStyleSheetsArray(root) {
  const isIndex = (p) => typeof p === 'string' && p === String(p >>> 0) && p !== '4294967295';
  const count = () => dom.adoptedSheetCount(root);
  // (…a sheet converted and checked, then put at `index` — its end at most: WebIDL's ObservableArray "set an indexed
  // value" takes no hole)
  const put = (index, sheet) => {
    if (index > count()) return false;
    if (!IS_CSS_STYLE_SHEET(sheet)) throw new TypeError("Failed to convert value to 'CSSStyleSheet'.");
    checkAdoptable(sheet, root);
    const doc = nodeTypeOf(root) === NODE_DOC ? root : nodeDocumentOf(root);
    dom.adoptedSheetPut(root, nidOf(doc), index, sheet, slotsOf(sheet, 'CSSStyleSheet').id);
    adoptedSheetsChanged(root);
    return true;
  };
  // (…a length longer than it is none: "set the length" grows no list)
  const setLength = (value) => {
    const length = value >>> 0;
    if (length !== Number(value)) throw new RangeError('Invalid array length');
    if (length > count()) return false;
    dom.adoptedSheetsTruncate(root, length);
    adoptedSheetsChanged(root);
    return true;
  };
  return new Proxy([], {
    get(target, prop, receiver) {
      if (prop === 'length') return count();
      if (isIndex(prop)) return dom.adoptedSheetAt(root, Number(prop));
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (prop === 'length') return true;
      if (isIndex(prop)) return Number(prop) < count();
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'length') return { value: count(), writable: true, enumerable: false, configurable: false };
      if (isIndex(prop)) {
        const value = dom.adoptedSheetAt(root, Number(prop));
        return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      const keys = [];
      for (let i = 0, n = count(); i < n; i++) append(keys, String(i));
      for (const key of Reflect.ownKeys(target)) append(keys, key);
      return keys;
    },
    set(target, prop, value, receiver) {
      if (isIndex(prop)) return put(Number(prop), value);
      if (prop === 'length') return setLength(value);
      return Reflect.set(target, prop, value, receiver);
    },
    // (…and defined as it is set: an index as a sheet, converted and checked — past the end, as an accessor, or anything
    // but a writable, enumerable, configurable one none; the length no longer, and none but a writable, non-enumerable,
    // non-configurable one — ObservableArray's [[DefineOwnProperty]])
    defineProperty(target, prop, desc) {
      if (prop === 'length') {
        if ('get' in desc || 'set' in desc || desc.configurable === true || desc.enumerable === true || desc.writable === false) return false;
        return 'value' in desc ? setLength(desc.value) : true;
      }
      if (!isIndex(prop)) return Reflect.defineProperty(target, prop, desc);
      if ('get' in desc || 'set' in desc || !('value' in desc)) return false;
      if (desc.configurable === false || desc.enumerable === false || desc.writable === false) return false;
      return put(Number(prop), desc.value);
    },
    // (…an index deleted only at its end, the list one shorter: ObservableArray's [[Delete]])
    deleteProperty(target, prop) {
      if (!isIndex(prop)) return Reflect.deleteProperty(target, prop);
      const n = count();
      if (Number(prop) !== n - 1) return false;
      return setLength(n - 1);
    },
    // (…and never made inextensible: ObservableArray's [[PreventExtensions]])
    preventExtensions: () => false
  });
}

// A document's or a shadow root's `adoptedStyleSheets`, made as it is first read…
function adoptedStyleSheetsOf(root) {
  return sameObject(root, 'adoptedStyleSheets', makeAdoptedStyleSheetsArray);
}
// …whose change moves the cascade: a shadow root's, a document's only the active document's.
function adoptedSheetsChanged(root) {
  if (nodeTypeOf(root) !== NODE_DOC) markRuleSetMoved();
  else if (root === globalThis.document) markCascadeStale();
}
// `adoptedStyleSheets = sheets` (converted: a sequence of CSSStyleSheets, an array) — every one checked before the list
// changes, so a rejected assignment leaves it as it was; the list then its sheets.
function setAdoptedStyleSheets(root, sheets) {
  for (let i = 0; i < sheets.length; i++) checkAdoptable(sheets[i], root);
  const doc = nodeTypeOf(root) === NODE_DOC ? root : nodeDocumentOf(root);
  dom.adoptedSheetsTruncate(root, 0);
  for (let i = 0; i < sheets.length; i++) dom.adoptedSheetPut(root, nidOf(doc), i, sheets[i], slotsOf(sheets[i], 'CSSStyleSheet').id);
  adoptedSheetsChanged(root);
}
// (…`value` put at the end of the platform's own array as an own property: an index assignment would find an
// `Array.prototype` setter a page defined, and hand it the array)
const append = (array, value) => definePropertyOwn(array, array.length, { value, writable: true, enumerable: true, configurable: true });

// Build a CSSStyleSheet from a `shadowrootadoptedstylesheets` specifier:
// resolve it via the import map (bare specifier → mapped URL) or as a URL,
// fetch the CSS text (inline data: URL decoded directly; otherwise a sync
// Rack fetch), and `replaceSync` it. Returns null on any failure so a bad
// specifier is skipped rather than throwing during parse.
function sheetFromSpecifier(specifier, baseURL) {
  try {
    // (…through the document's import map, a specifier it maps its address — one that resolves to none, a bare one no map
    // has or one it maps to null, no sheet at all)
    const raw = resolveModuleSpecifier(specifier, baseURL || realmURL());
    if (raw === null) return null;
    // …fetched as a CSS module script is (css-utils.js `moduleStyleSheetText`, as the tentative WPT tests take the
    // attribute: the module map's): a fetched one that fails — no `text/css`, or none to load — leaving its placeholder
    // sheet empty (shadowrootadoptedstylesheets-async-fetch-failure), a `data:` / `blob:` one no sheet at all.
    const url = parseURL(raw, baseURL || realmURL() || null)?.href ?? raw;
    const css = moduleStyleSheetText(url) ?? (schemeRoute(url) === ROUTE_NETWORK ? '' : null);
    if (css == null) return null;
    return constructedSheetOf(css);
  } catch (_) { return null; }
}

// HTML's "insert a template start tag" with a shadowrootmode (§13.2.6.4.4), as the parser (html_parse.rs) asks: the
// declarative shadow root the template attaches to `host`, its children then parsed straight into it — or null where
// the host takes none (it hosts one already, or attachShadow throws), the template then inserted as any other.
export function attachDeclarativeShadow(host, template) {
  const attrs = attrsOf(template);
  if (shadowRootOf(host)) return null;
  let sr;
  try {
    sr = attachShadow(host, {
      mode:           asciiLower(String(attrs.shadowrootmode)),
      delegatesFocus: attrs.shadowrootdelegatesfocus != null,
      clonable:       attrs.shadowrootclonable != null,
      serializable:   attrs.shadowrootserializable != null,
      // (…`shadowrootslotassignment="manual"` its slot assignment, "named" else)
      slotAssignment: asciiLower(String(attrs.shadowrootslotassignment || '')) === 'manual' ? 'manual' : 'named',
      // (…`shadowrootcustomelementregistry` its registry null, kept null as it is adopted)
      ...(attrs.shadowrootcustomelementregistry != null ? { customElementRegistry: null } : {})
    });
  } catch (_) {
    return null;
  }
  setShadowIs(sr, SHADOW_DECLARATIVE, true);
  setShadowIs(sr, SHADOW_INTERNALS, true);
  if (attrs.shadowrootcustomelementregistry != null) dom.ceSetKeepNull(sr, true);
  // `shadowrootadoptedstylesheets`, as written (getHTML gives it back), and the sheets its specifiers name adopted —
  // sheets this document constructs, which a root in another (template contents' inert one) cannot adopt.
  const adopt = attrs.shadowrootadoptedstylesheets;
  setShadowAdoptedSheets(sr, adopt != null ? String(adopt) : null);
  if (adopt != null && nodeDocumentOf(sr) === globalThis.document) {
    const hostDoc = nodeDocumentOf(host), base = hostDoc && urlOf(hostDoc);
    const sheets = [];
    for (const specifier of asciiTokens(adopt)) {
      const sheet = sheetFromSpecifier(specifier, base);
      if (sheet) sheets.push(sheet);
    }
    if (sheets.length) setAdoptedStyleSheets(sr, sheets);
  }
  return sr;
}

// …the engine's parse build attaching one as it goes (html_parse.rs `attach_shadow`).
globalThis.__csimAttachParsedShadow = attachDeclarativeShadow;

// The slot `node` is assigned to, per "find a slot". `openOnly` mirrors the
// `assignedSlot` getter's open flag (a slot in a closed shadow tree is hidden).
function findSlotForSlottable(node, openOnly) {
  const parent = parentOrHostOf(node);
  if (!parent) return null;
  const sr = shadowRootOf(parent);
  if (!sr) return null;
  if (openOnly && shadowRootMode(sr) !== 'open') return null;
  return assignedSlotOf(node);
}
// The rendering update's "flush autofocus candidates" (timers.js), for the realm's document where it is a top-level one
// holding any.
globalThis.__csimFlushAutofocus = function () {
  const doc = globalThis.document;
  if (doc && dom.autofocusPending(nidOf(doc), true)) flushAutofocusCandidates(doc);
};

// Move focus to the next (Tab) / previous (Shift-Tab) sequential focus stop (focus.rs `next`: HTML's "sequential
// navigation search algorithm" over the document, shadow root and slot scopes), wrapping round at the document's ends.
// The answer is the stop's nid and the path to it from the document, followed here — and checked: a stop the path does
// not reach is found by its nid instead. A cold path (Capybara's send_keys, testdriver), never on find / dispatch /
// dom_op.
hostSteps.advanceFocus = function (reverse) {
  const doc = globalThis.document;
  if (!doc) return false;
  const cur = focusedElementOf(doc);
  const next = sequentialFocusNext(doc, cur && isConnected(cur) ? cur : null, !!reverse);
  if (!next) return false;
  dom.setPointerModality(false);   // Tab is keyboard-driven → :focus-visible applies
  try { focusElement(next); } catch (_) {}
  return true;
};

// slot.assign(...nodes): the engine's (slots.rs `assign_manual`) — the slot's manually assigned nodes the ones given,
// each taken from the slot that had it — then the slots of every shadow root whose assignments moved assigned.
export function assignManualSlottables(slot, nodes) {
  for (const sr of assignManual(slot, nodes)) assignSlottablesForShadowRoot(sr);
}
const EMPTY_NODES = [];
export function slotAssignedNodes(slot, options) {
  return assignedNodesOf(slot, !!(options && options.flatten === true));
}

// Whether any shadow root is attached: the gate dispatch.js's flattened-tree event path is behind, so a shadow-free page
// keeps the cheap `parentOrHostOf`-only walk (rule 3).
export function hasShadowRoots() { return shadowHostCount > 0; }

// Assign the slots of `sr` anew (slots.rs), each slot whose assigned nodes changed signaled, and it and the nodes that
// LEFT it marked, the engine's (dom.rs `assign_slots`: `h.innerText` reads "M" after `s1.assign(m)`, as in Chrome) — for
// what no tree or attribute change of the engine's assigns: an `assign()`. (A tree or attribute change assigns them in
// the engine, dom.rs `slot_steps`, as DOM's insert, remove and attribute change steps do.)
function assignSlottablesForShadowRoot(sr) {
  assignSlots(sr);
  engineWritten();
}
setSlotChangeFirer(function fireSlotChange(slot) {
  // `slotchange` bubbles within the shadow tree, is not composed, and carries
  // no relatedTarget (a plain Event).
  fireEvent(slot, new Event('slotchange', { __proto__: null, bubbles: true }));
});

// HTMLBodyElement's and HTMLFrameSetElement's members no attribute reflects: WindowEventHandlers, which they reflect to
// their Window (`<body onpopstate>` → `window.onpopstate`; the engine's, event_handlers.rs). (GlobalEventHandlers' blur /
// error / focus / load / resize / scroll they forward too.)
export const windowReflectingElementMembers = { installEventHandlers: installEventHandlerAttrs };

// The inline-handler scope chain includes an element's form owner only when the element is form-associated
// (`isFormAssociated`): a plain element — or <label>/<legend>/<option>, which expose `.form` but aren't form-associated —
// contributes no form scope.
setScopeFormOwnerResolver((node) => (isFormAssociated(node) ? formForControl(node) || null : null));

// HTML "update the current document readiness", where the engine's update of it changed it (document_lifecycle.rs
// `docOpen`, `docTheEnd`, `docLoadSteps`): a `readystatechange` at `doc`. (Turbo Drive's PageObserver dispatches
// `turbo:load` on the 'complete' one.)
export function readinessChanged(doc) {
  fireEvent(doc, new Event('readystatechange', { __proto__: null, bubbles: false, cancelable: false }));
}

// A document's DOMImplementation (DOM §4.5.1), generated from its IDL: `document.implementation`, one per document (the
// document's rare data), no page's to construct.
const implementationOf = (o) => slotsOf(o, 'DOMImplementation');
const DOMImplementation = defineDOMImplementation({
  init(slots, doc) {
    slots.doc = doc;
  },
  // (…a valid doctype name the only check: no namespace's)
  createDocumentType(impl, name, publicId, systemId) {
    if (!isValidDoctypeName(name)) {
      throw new DOMException(`The qualified name '${name}' is not a valid doctype name.`, 'InvalidCharacterError');
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
    setContentType(d, ns === HTML_NS ? 'application/xhtml+xml' : ns === SVG_NS ? 'image/svg+xml' : 'application/xml');
    clearEdges(d);                         // (the constructor yields an empty, complete document)
    if (doctype !== null) appendChild(d, doctype);
    if (qualifiedName !== '') appendEdge(d, createElementIn(d, rns, prefix, localName));
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
      appendEdge(t, nodeMadeFor(d, Text, title));
      appendEdge(head, t);
    }
    setContentType(d, 'text/html');
    setSubtreeDocumentOf(d, d);
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
    throw new TypeError("The 'customElementRegistry' option is not a CustomElementRegistry.");
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
// element has no node document yet (assigned later), which counts as `doc`.
function constructedElementError(el, doc, localName) {
  if (nodeTypeOf(el) !== NODE_ELEMENT || !isNodeObject(el)) {
    return new TypeError("Failed to construct custom element: the constructor did not return an element.");
  }
  const nse = (m) => new DOMException(m, 'NotSupportedError');
  if (Object.keys(attrsOf(el)).length !== 0)            return nse("The custom element constructor added an attribute.");
  if (childCountOf(el, false) !== 0)                  return nse("The custom element constructor added a child node.");
  if (parentOrHostOf(el) != null)                             return nse("The custom element constructor inserted the element into a parent.");
  const madeIn = nodeDocumentOf(el);
  if (madeIn !== null && madeIn !== doc)                     return nse("The custom element constructor moved the element into another document.");
  if (namespaceOf(el) !== HTML_NS)                              return nse("The custom element was constructed in the wrong namespace.");
  if (localNameOf(el) !== localName)                    return nse("The custom element's local name does not match its definition.");
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
  const reg = documentRegistry(doc);
  const def = reg ? lookupCEDefinition(reg, localName, isValue) : undefined;
  if (!def) return null;
  // (…a creation in an initialize()d document PINS the scoped association, like createElementIn's)
  const registry = doc ? ceRegistryOf(doc) : undefined;
  const el = createDefinedElement(def, doc, localName, registry);
  if (registry !== undefined) setCeRegistryOf(el, registry);
  return el;
}

// HTML "create an element" with a definition found and the synchronous custom elements flag set. A customized built-in
// is made the built-in element it extends, its is value set, "undefined", and upgraded at once — a throw reported and
// the element "failed", the same element, its prototype what the constructor left it (DOM "create an element" step
// 5.2): "precustomized" as its constructor runs, which Chrome and Firefox agree on (`:defined` false in it). An
// autonomous one is its constructor's own (`constructCustomElementSync`).
function createDefinedElement(def, doc, localName, registry, prefix = null) {
  if (def.localName === def.name) return constructCustomElementSync(def, doc, localName, registry, prefix);
  const el = createElementNode(localName, HTML_NS, localName, prefix);
  setIsValue(el, def.name);
  setNodeDocumentOf(el, doc);
  if (registry !== undefined) setCeRegistryOf(el, registry);
  if (!upgradeElement(el, def)) markFailed(el);
  return el;
}

// HTML "create an element" with the synchronous custom elements flag: run the
// constructor and validate what it returned. On ANY failure (a throw, a missing
// `super()`, a non-element / malformed return) the exception is REPORTED — never
// propagated to the caller — and the result is a plain element in custom element
// state "failed" (`markFailed`): it implements HTMLUnknownElement when its
// name is an autonomous custom element name, and it never upgrades later. Shared
// by `document.createElement` and the parser's create-an-element-for-the-token.
// `creationRegistry` is what the element being constructed should associate with
// (createElement's explicit `customElementRegistry` option, else the document's
// own association) — it is readable as `this.customElementRegistry` INSIDE the
// constructor, so it must be the caller's value, not re-derived here.
function constructCustomElementSync(def, doc, localName, creationRegistry, prefix = null) {
  const prev = currentCreation;
  currentCreation = { def, tag: localName, registry: creationRegistry };
  try {
    const el  = new def.ctor();
    const err = constructedElementError(el, doc, localName);
    if (err) throw err;
    // (…an HTML element of the local name it was looked up by, its prefix given once its constructor has returned,
    // which saw none — DOM "create an element" 5.1.3.9: its identity's, the object a script holds, and its arena node's)
    if (prefix !== null) {
      setPrefix(el, prefix);
      dom.setElementPrefix(el, prefix);
    }
    return el;
  } catch (e) {
    try { globalThis.__csimReportCallbackError(def.ctor, e); } catch (_) {}
    // A failed element's interface is HTMLUnknownElement — not the HTMLElement an undefined custom element name is born
    // as.
    const fb = reflectConstruct(Element, [PLATFORM, localName, HTML_NS, localName, prefix], NAMESPACE_TARGETS.htmlUnknown);
    markFailed(fb);
    return fb;
  } finally {
    currentCreation = prev;
  }
}

// The ElementInternals attached to `el`, null for none (attachInternals keeps it in the element's rare data) — what the
// WPT harness's accessibility queries read too (testdriver-vendor.js).
const internalsAttached = (el) => rareDataOf(el)?.internals ?? null;
hostSteps.internalsOf = internalsAttached;

// The document's focused and hovered element each carries the matching state bit, where the native `:focus` /
// `:focus-within` / `:hover` start: `prev` gives it up and `next` takes it.
// The unfocus steps of the element losing focus to `related` (null: to another document, or to none) — the focus
// update steps', blur()'s, and the fix-up's of an element no longer focusable: a text control commits its pending
// `change` first, then blur and focusout — FocusEvents, so the dispatch retargets `related` across shadow boundaries
// (shadow-relatedTarget) — and a customizable `<input list>` closes its datalist popover.
function loseFocus(prev, related) {
  commitChangeOnBlur(prev);
  fireEvent(prev, new FocusEvent('blur',     { __proto__: null, bubbles: false, cancelable: false, composed: true, view: globalThis, relatedTarget: related }));
  fireEvent(prev, new FocusEvent('focusout', { __proto__: null, bubbles: true,  cancelable: false, composed: true, view: globalThis, relatedTarget: related }));
  if (isHtml(prev, 'input') && attrsOf(prev).list != null) hideComboboxDatalist(prev);
}
// The document in `container`'s frame (its realm's, whatever its origin), or null.
function frameDocumentOf(container) {
  try {
    const w = hostNamespace.contextGlobal(frameRealmOf(container));
    return w ? w.document : null;
  } catch (_) {
    return null;
  }
}
function markStateOwner(prev, next, bit) {
  if (prev && nodeTypeOf(prev) === NODE_ELEMENT) setElementState(prev, bit, 0);
  if (next && nodeTypeOf(next) === NODE_ELEMENT) setElementState(next, bit, bit);
}
// A document's FOCUS and HOVER, signalled where they are written (document-state.js `focusedElementOf`,
// `hoveredElementOf` read them). The focused element is assigned from a dozen places (focus / blur / removal /
// navigation / dialog / shadow retarget), and the hovered one by the driver and by specs alike — but every one of them
// assigns it here, which sees them all. (They were compared on every style read instead: a poll that dereferenced two
// WeakRefs per call and was 3% of a layout pass.) The page's document only — a frame's by its own realm (`REALM`) —
// whose writes another document's go nowhere: its focus moves no rule of this one.
// A frame's document passes both up: what is focused or hovered in it makes its container — the `<iframe>` — the parent
// document's (HTML: the parent's focused area is the navigable container; `iframe:focus-within` and the parent's
// `:hover` chain match, and `document.activeElement` is the iframe — Chrome). The hover leaving the container in the
// parent leaves the frame's document too.
function setFocusedElement(doc, el) {
  if (doc !== globalThis.document) {
    foreignRealmOf(doc)?.setFocusedElement(doc, el);
    return;
  }
  const prev = focusedElementOf(doc);
  if (el === prev) return;
  markStateOwner(prev, el, STATE_FOCUSED);
  const container = globalThis.__csimFrameContainer;
  if (el && container) (foreignRealmOf(container) ?? NATIVE_REALM).takeFocusFromFrame(container);
}
export function setHoveredElement(doc, el) {
  if (doc !== globalThis.document) {
    foreignRealmOf(doc)?.setHoveredElement(doc, el);
    return;
  }
  const prev = hoveredElementOf(doc);
  if (el === prev) return;
  markStateOwner(prev, el, STATE_HOVERED);
  const container = globalThis.__csimFrameContainer;
  if (el && container) setHoveredElement(nodeDocumentOf(container), container);
  const left = prev && frameRealmOf(prev) != null ? frameDocumentOf(prev) : null;
  if (left && hoveredElementOf(left)) setHoveredElement(left, null);
}
NATIVE_REALM.setFocusedElement = setFocusedElement;
NATIVE_REALM.takeFocusFromFrame = takeFocusFromFrame;
NATIVE_REALM.focusElement = focusElement;
NATIVE_REALM.blurElement = blurElement;
NATIVE_REALM.adoptNode = adoptNode;
NATIVE_REALM.setHoveredElement = setHoveredElement;

// The stream hooks a script-created parser the engine made streaming runs under — a page's document's, its scripts run
// as a page load's: its realm's (bridge.entry.js `__csimDocumentParser`), whichever realm's code writes into it.
function streamingParserOf(doc) {
  const NS = hostNamespace;
  return (doc === globalThis.document ? globalThis : NS.contextGlobal(NS.contextOf(doc))).__csimDocumentParser;
}
// What the steps of dynamic markup insertion do first (document_lifecycle.rs `markup_steps`, `docMarkupSteps`), what stops
// them thrown: return; go on — open the document, write at the end of its script-created parser's input, end that input;
// write at the insertion point of the script its active parser runs; open it first, and then write — whether its
// script-created parser streams, and which parse its active parser is (`MARKUP_PARSER_SHIFT` up).
const MARKUP_STEPS_OPEN = 0, MARKUP_STEPS_WRITE = 1, MARKUP_STEPS_CLOSE = 2;
const MARKUP_RETURN = 0, MARKUP_GO = 1, MARKUP_AT_SCRIPT = 2, MARKUP_OPEN_FIRST = 3, MARKUP_THROW_XML = 4, MARKUP_THROW_ORIGIN = 6;
const MARKUP_STEP = 7, MARKUP_STREAMING = 8, MARKUP_PARSER_SHIFT = 4;
function markupSteps(doc, op, steps) {
  const answer = dom.docMarkupSteps(nidOf(doc), steps, steps === MARKUP_STEPS_OPEN ? entryRealmId() : -1);
  const step = answer & MARKUP_STEP;
  if (step < MARKUP_THROW_XML) return answer;
  if (step === MARKUP_THROW_ORIGIN) throw new DOMException("Failed to execute 'open' on 'Document': Can only call open() on same-origin documents.", 'SecurityError');
  throw new DOMException(step === MARKUP_THROW_XML
    ? `Failed to execute '${op}' on 'Document': Only HTML documents support ${op}().`
    : `Failed to execute '${op}' on 'Document': Custom Element constructor should not use open(), close() or write().`, 'InvalidStateError');
}
// What the document open steps answer (`docOpen`): its readiness changed, its URL moved, its script-created parser
// streams, and which parse that is (`OPENED_PARSER_SHIFT` up).
const OPENED_READY_CHANGED = 1, OPENED_URL_MOVED = 2, OPENED_STREAMING = 4, OPENED_PARSER_SHIFT = 3;
// HTML "document open steps": the document emptied for rewriting — every child removed (its doctype too: "replace all
// with null") — and then made one to write (`docOpen`: its URL the entry document's, in no-quirks mode, loading, with a
// script-created parser of its own, which the writes feed until `close()`). None from a script its own parser is running
// (an active parser with a script nesting level above zero: Chrome and Firefox write on at the insertion point); an
// open parser of an earlier `open()` is abandoned for the new one. What `docOpen` answered, 0 where it did not open.
function openDocument(doc) {
  if ((markupSteps(doc, 'open', MARKUP_STEPS_OPEN) & MARKUP_STEP) !== MARKUP_GO) return 0;
  // (…the navigation its navigable has under way stopped, its document aborted with it: HTML "document open steps",
  // "stop loading" a navigable whose ongoing navigation is a navigation ID — what the document is written with is its
  // document from then on)
  if (doc === globalThis.document) globalThis.__csimStopLoading(true);
  // (…its listeners and handlers erased — those of its nodes that have any, shadow trees' included, the engine's to
  // find (`listenedIn`), and its window's where it is the window's document — then its old content removed as any is:
  // recorded, disconnected, a focused or hovered element in it neither any more)
  for (const node of listOf(dom.listenedIn(nidOf(doc)))) if (node) eraseListenersAndHandlers(node);
  const win = defaultViewOf(doc);
  if (win !== null && win.document === doc) eraseListenersAndHandlers(win);
  changeChildren(doc, ALL_CHILDREN, NO_NODES, null);
  const opened = dom.docOpen(nidOf(doc), entryRealmId());
  if (opened & OPENED_URL_MOVED) engineWritten();
  // (…what the page's parse had queued for its connection none of the written document's)
  if (opened & OPENED_STREAMING) streamingParserOf(doc).open();
  if (opened & OPENED_READY_CHANGED) readinessChanged(doc);
  return opened;
}
// The URL a document's cookies are of (Chrome's cookie URL): its own, an http(s) one — else, an about:blank or srcdoc
// one's, its creator's: the document its frame is in (its container's, which it is linked to before its first script
// runs), and so on up; a top-level window's is the host's to find, from its opener.
function cookieURL(doc) {
  let url = documentURL(doc), container = doc === globalThis.document ? globalThis.__csimFrameContainer : null;
  // (…bounded, as the nesting of frames is)
  for (let depth = 0; !/^https?:/i.test(url) && container && depth < 32; depth++) {
    // (…the container of the window the owner document is of — its own realm's global, not this one's)
    const owner = nodeDocumentOf(container);
    url = documentURL(owner);
    let next = null;
    try { next = hostNamespace.contextGlobal(hostNamespace.contextOf(owner)).__csimFrameContainer ?? null; } catch (_) {}
    container = next === container ? null : next;
  }
  return url;
}
// A cookie-averse document (HTML): one with no browsing context — made with none, or one its navigable's active document
// no more, the engine's (navigables.rs `documentFullyActive`).
const cookieAverse = (doc) => hasNoBrowsingContext(doc) || !dom.documentFullyActive(nidOf(doc));
// HTML `document.cookie`'s first check: a document of an opaque origin has no cookies to read or write.
function cookieAllowed(verb) {
  const why = opaqueOriginRefusal({ data: "Cookies are disabled inside 'data:' URLs." });
  if (why) throw new DOMException(`Failed to ${verb} the 'cookie' property ${verb === 'read' ? 'from' : 'on'} 'Document': ${why}`, 'SecurityError');
}
class Document extends Node {
  constructor() {
    const self = nodeObject(new.target, NODE_DOC);
    // (…its state the engine's, document-state.js, and what the bindings keep for it its rare data, as any node's is)
    defineDocumentUnforgeables(self);
    registerNativeNode(self);
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
    // (…complete, in no-quirks mode and no XMLDocument, as the engine's state of one starts: document_state.rs)
    setContentType(self, 'application/xml');
    setURL(self, 'about:blank');
    setNoBrowsingContext(self, true);
    // GlobalEventHandlers IDL attributes (`document.onclick` / `oninput` / …) are
    // installed as spec-faithful EventHandler accessors on Document.prototype below
    // (installEventHandlerAttrs) — assigning one registers a real listener, and the
    // `in` probe React-DOM's input-change polyfill relies on (`'oninput' in
    // document`) still answers true via the prototype accessor.
    return self;
  }
}
// Document node basics (BATCH H) — the Document node's own
// nodeName / nodeValue / ownerDocument per DOM spec. (Document
// inherits Node's ownerDocument, which would resolve to itself;
// spec says a Document's ownerDocument is null.)
// Shared "create an element" step for createElement / createElementNS: build
// the element (custom-element upgrade only in the HTML namespace) and stamp
// its namespace slots + owner document.
export function createElementIn(doc, ns, prefix, localName, registry, isValue) {
  const realm = makingRealmOf(doc);
  if (realm !== null) return inRealm(realm, 'createElementIn', doc, ns, prefix, localName, registry, isValue);
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
  // exactly as before — no registry set, definitions from the global registry.
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
  const lookupReg = ns !== HTML_NS ? null : explicit ? registry : documentRegistry(doc);
  // …by the local name as it is: `createElement` has already ASCII-lowercased it, and `createElementNS` keeps its
  // case (`x-Ö` is defined, and looked up, as `x-Ö`).
  const def = lookupReg ? lookupCEDefinition(lookupReg, localName, isValue) : undefined;
  if (def) {
    // HTML "create an element" with the synchronous flag set — the shared
    // construct-and-validate (see constructCustomElementSync): a constructor
    // that throws or returns a malformed element REPORTS (never propagates to
    // the createElement caller) and yields a "failed" element with this local
    // name — a real `<div>` for a customized built-in, an
    // HTMLUnknownElement-implementing element for an autonomous name.
    el = createDefinedElement(def, doc, localName, explicit ? registry : ceRegistryOf(doc), prefix);
  } else {
    el = createElementNode(localName, ns, localName, prefix);
  }
  // The is value is an internal slot (NOT an `is` content attribute): it keeps a
  // customized built-in matchable after creation and drives `:defined`.
  if (isValue != null) setIsValue(el, String(isValue));
  setNodeDocumentOf(el, doc);
  // Record only a non-default (scoped or explicit-null) association; the default
  // leaves its registry unset so registryForElement resolves to the global registry.
  if (explicit) setCeRegistryOf(el, registry);
  // A creation in an initialize()d document PINS the scoped association on the
  // element (adoption must not strip it); the common live/inert default stays
  // unstamped (no read of it before a document has one — rule 3).
  else if (ceInitializedOf(doc) === true && ns === HTML_NS) setCeRegistryOf(el, ceRegistryOf(doc));
  return el;
}
// HTML "document write steps": `html` into the input stream at the insertion point — the page's own parser's, from a
// script it is running, or the script-created parser's that `open()` made, which parses it up to there (running the
// scripts it closes) before `write` returns. With no insertion point at all, the document is opened first — a page
// that has loaded is wiped, as in a browser — unless its ignore-destructive-writes counter is up (an external script
// it fetched is running: an `async` one's `write` is ignored) or it is being unloaded.
function documentWrite(doc, html) {
  const answer = markupSteps(doc, 'write', MARKUP_STEPS_WRITE);
  let streaming = (answer & MARKUP_STREAMING) !== 0, parser = answer >>> MARKUP_PARSER_SHIFT;
  switch (answer & MARKUP_STEP) {
    case MARKUP_RETURN: return;
    case MARKUP_AT_SCRIPT: writeAtScript(doc, html); return;
    case MARKUP_OPEN_FIRST: {
      // (…none where it did not open after all)
      const opened = openDocument(doc);
      if (!opened) return;
      streaming = (opened & OPENED_STREAMING) !== 0;
      parser = opened >>> OPENED_PARSER_SHIFT;
    }
  }
  if (streaming) streamingParserOf(doc).write(doc, parser, html);
  else if (writeScriptCreated(doc, parser, html, null)) setReadyState(doc, 'complete');
}
function documentOpen(doc) {
  openDocument(doc);
  return doc;
}
// HTML "document close steps": the script-created parser's input stream ended — the document parsed to its end, and
// "the end" run for it where it has a browsing context (the realm's: `__csimDocumentParser`); else it is complete.
function documentClose(doc) {
  const answer = markupSteps(doc, 'close', MARKUP_STEPS_CLOSE);
  if ((answer & MARKUP_STEP) !== MARKUP_GO) return;
  const parser = answer >>> MARKUP_PARSER_SHIFT;
  if (answer & MARKUP_STREAMING) streamingParserOf(doc).close(doc, parser);
  else if (closeScriptCreated(doc, parser, null)) setReadyState(doc, 'complete');
}
// `Document.importNode(node, options)` — a clone of `node` whose node document is
// THIS document. Turbo Drive's `importStreamElements` does
// `document.importNode(streamElement, true)` to graft turbo-stream fragments
// (parsed in an inert DOMParser document) into the live tree.
function importNode(doc, node, options) {
  // (…a document or a shadow root is no node to import)
  if (nodeTypeOf(node) === NODE_DOC || isShadowRoot(node)) {
    throw new DOMException(`Failed to execute 'importNode' on 'Document': The node provided is a ${isShadowRoot(node) ? 'shadow root' : 'document'}, which may not be imported.`, 'NotSupportedError');
  }
  const realm = makingRealmOf(doc);
  if (realm !== null) return inRealm(realm, 'importNode', doc, node, options);
  // `(boolean or ImportNodeOptions)`, converted: the legacy boolean says whether to clone deep (absent, false); an
  // ImportNodeOptions — null's too — clones deep unless `selfOnly`, and its `customElementRegistry`, where it gives
  // one, is the fallback registry ("use the importing document's" where it does not).
  const deep = typeof options === 'boolean' ? options : !options.selfOnly;
  const fallbackReg = typeof options === 'boolean' ? undefined : options.customElementRegistry;
  const made = engineClone(node, deep);
  const out = made !== undefined ? made[0] : cloneNode(node, deep, true);
  // Registry mapping (HTML "clone a node" with fallback registry = the option,
  // else the importing document's): a pinned SCOPED registry travels; a STICKY
  // null (customelementregistry attribute) stays null; a global-registry source
  // re-points to the importing document (the explicit option is IGNORED for
  // global sources); a NULL-resolving source (template contents, an inert
  // source document) takes the fallback. Nested template contents keep their
  // tracking-null — the fallback never reaches inside them.
  // — the engine's (adopt.rs `importInto`), as it gives each node of the clone this document; the bindings register the
  // names of its elements, which this realm's named properties are to know (a clone another realm's code made
  // registered them there).
  const destWinReg = windowRegistryOf(doc);
  const fallback   = fallbackReg !== undefined && fallbackReg !== destWinReg ? fallbackReg : undefined;
  const inert      = windowRegistryOf(nodeDocumentOf(node)) === null;
  if (nodeTypeOf(out) === NODE_ATTRIBUTE) setNodeDocumentOf(out, doc);   // (…an attribute, no tree's, its own)
  else {
    for (const el of dom.importInto(nidOf(out), doc, inert, registryCodeOf(fallback), fallback ?? null)) registerNamesOf(el);
    // (…and its images, made in the source's document — template contents' — whose data are updated in this one)
    if (doc === globalThis.document) updateImagesIn(out);
  }
  // Elements inert in `<template>.content` / a DOMParser doc aren't upgraded at creation; the copies are upgraded now,
  // in this document, in the order the clone made them — each against ITS registry, shadow trees included.
  if (made !== undefined) upgradeCopies(made, 1);
  return out;
}
function adoptNode(doc, node) {
  // (…by the realm whose document it is — a frame's, its parent's code inserting into it — whose images and named
  // properties the adoption updates)
  const realm = foreignRealmOf(doc);
  if (realm !== null) return realm.adoptNode(doc, node);
  // DOM §4.5: adopting a document is not supported.
  if (nodeTypeOf(node) === NODE_DOC) {
    throw new DOMException("Failed to execute 'adoptNode' on 'Document': The node provided is of type '#document', which may not be adopted.", 'NotSupportedError');
  }
  // A shadow root cannot be adopted (it is owned by its host's tree).
  if (isShadowRoot(node)) {
    throw new DOMException("Failed to execute 'adoptNode' on 'Document': The node provided is a shadow root, which may not be adopted.", 'HierarchyRequestError');
  }
  // DOM "adopt": a DocumentFragment with a non-null HOST (template content —
  // the shadow-root case threw above) is returned unchanged; its tree stays
  // in its own document (adoption.window.js "adoptNode() and DocumentFragment
  // with host").
  if (nodeTypeOf(node) === NODE_FRAGMENT && hostOf(node)) return node;
  const from = parentNodeOf(node);
  if (from) {
    try { removeChild(from, node); } catch (_) {}
  }
  // (…an attribute is taken from its element first, as a node from its parent)
  if (nodeTypeOf(node) === NODE_ATTRIBUTE && attrOwnerOf(node)) removeAttrKey(attrOwnerOf(node), attrStoreKeyOf(node));
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
  const dest = doc;
  const oldDoc = nodeDocumentOf(node);
  const crossDoc = oldDoc !== dest;
  // Registry re-pointing keys on the WINDOW REGISTRY actually changing — a
  // same-browsing-context document swap (the frame's boot skeleton vs its
  // current document) is not a registry move, and must not strip a sticky
  // null or re-point a global association.
  const destWinReg = windowRegistryOf(dest);
  const regChange = crossDoc && windowRegistryOf(oldDoc) !== destWinReg;
  // DOM §adopt: each shadow-including inclusive descendant's node document, and its custom element registry
  // association, and a shadow root's adopted stylesheets, which another document's empties, the engine's (adopt.rs) — an
  // attribute's follows its element's. What the bindings have to do besides is for the nodes it hands back: an
  // element's names, which this realm's named properties are to know (an element a frame's script named), a template's
  // contents, which go into the new document's inert template document, and a shadow root's cascade, which its emptied
  // list moved.
  // (…an attribute, no tree's, its own)
  if (nodeTypeOf(node) === NODE_ATTRIBUTE) { setNodeDocumentOf(node, dest); return node; }
  const kind = regChange ? ADOPT_CROSS_REGISTRY : crossDoc ? ADOPT_CROSS : ADOPT_SAME;
  const steps = dom.adoptInto(nidOf(node), dest, kind, destWinReg === null ? 0 : registryCodeOf(destWinReg));
  for (const n of steps) {
    if (isShadowRoot(n)) { adoptedSheetsChanged(n); continue; }
    registerNamesOf(n);
    const contents = templateContentsOf(n);
    if (contents) adoptTemplateContentInto(contents, dest, oldDoc);
  }
  // (…and the images it brings into a fully active document, whose image data are updated there: HTML's relevant
  // mutations include an adoption — template contents' clone, inserted)
  if (crossDoc && dest === globalThis.document) updateImagesIn(node);
  // HTML "adopt": a cross-document adopt enqueues an `adoptedCallback(oldDoc, newDoc)`
  // reaction on every custom element in the moved subtree — the "adopted" step of a
  // cross-document move's disconnected → adopted → connected sequence, and of a bare
  // `document.adoptNode`. Same-document adopt is a no-op.
  if (crossDoc) fireCEAdopted(node, oldDoc, dest);
  return node;
}
// `document.execCommand(command, showUI, value)` — deprecated but still in real browsers (Discourse's d-editor inserts
// its upload placeholders with `insertText`): the commands editing_commands.rs `COMMANDS` lists, each carried out in
// the focused text control or the editing host the selection is in — false for any other, and where it has nothing
// to act on.
function execCommand(doc, command, value) {
  // (…none from a listener of one running: the engine's answer, per document)
  if (!dom.commandBegin(nidOf(doc))) return false;
  try {
    return carryOutCommand(doc, command, value, ASKED_BY_SCRIPT);
  } finally {
    dom.commandEnd(nidOf(doc));
  }
}
// A command walked as the engine plans it (editing_commands.rs `commandPlan`) — the plan read of the focused element and
// the selection as they are now, a clipboard event's listeners having moved them if they would, and read again once a
// `beforeinput` has fired, which may have changed what there is to edit: what it says written to the clipboard, the
// `beforeinput` where it says (a listener canceling it ending the command, with what was written kept), and its edit.
// Whether it did.
function carryOutCommand(doc, command, value, asked) {
  const active = focusedElementOf(doc);
  const plan = dom.commandPlan(
    command,
    active ? nidOf(active) : -1,
    globalThis.__csimSelectionState(doc),
    defaultViewOf(doc) !== null,
    asked,
    globalThis.__csimClipboardPartition()
  );
  if (plan === undefined) return false;
  const [step, node, flags, inputType, name, pasted] = plan;
  switch (step) {
    case STEP_CLIPBOARD_EVENT: return clipboardAction(doc, name, SCRIPT_AFTER_EVENT);
    case STEP_COPY:
      writeSelectionToClipboard(doc, node);
      return true;
    case STEP_SELECT_ALL:
      selectEverything(doc, node);
      return true;
    case STEP_CONTROL:
    case STEP_HOST: {
      if (flags & PLAN_WRITE_SELECTION) writeSelectionToClipboard(doc, step === STEP_CONTROL ? node : null);
      const transfer = flags & PLAN_PASTE_TRANSFER ? readOnlyPasteTransfer() : null;
      if (flags & PLAN_BEFORE_INPUT) {
        const ranges = flags & PLAN_TARGET_RANGES ? hostSteps.targetRangesFromSelection() : [];
        if (!fireBeforeInput(node, inputType, transfer ? null : pasted, transfer, ranges)) return true;
        return carryOutCommand(doc, name, value, GESTURE_EDIT);
      }
      if (flags & (PLAN_MARKUP_FRAGMENT | PLAN_PASTED_FRAGMENT)) return hostFragment(doc, node, pasted ?? value, (flags & PLAN_PASTED_FRAGMENT) !== 0, inputType, transfer);
      const text = pasted ?? (flags & PLAN_MARKUP_TEXT ? markupText(value) : value);
      return step === STEP_CONTROL ? controlCommand(node, name, text, asked === GESTURE_EDIT) : hostCommand(doc, node, name, text, inputType, transfer);
    }
    default: return false;
  }
}
// The InputEvents an edit fires — not composed away, whatever it is at: `beforeinput` first where the plan says, whether no
// listener canceled it; `input` after. `data` and `dataTransfer` as the plan and the edit say.
function fireBeforeInput(target, inputType, data, dataTransfer, targetRanges) {
  try {
    const ev = new InputEvent('beforeinput', { __proto__: null, bubbles: true, cancelable: true, composed: true, data, inputType, dataTransfer, targetRanges });
    fireEvent(target, ev);
    return !eventState(ev).canceled;
  } catch (_) { return true; }
}
function fireInput(target, inputType, data, dataTransfer) {
  try {
    fireEvent(target, new InputEvent('input', { __proto__: null, bubbles: true, cancelable: false, composed: true, data, inputType, dataTransfer }));
  } catch (_) {}
}
// …the TEXT of markup (a text control's or a `plaintext-only` host's `insertHTML`, the engine's), parsed where nothing of it
// runs.
function markupText(markup) {
  return dom.markupPlainText(nidOf(inertFragment(markup)));
}
// A text form control's command: its value edited by the engine, which says whether `input` fires for it and with what.
function controlCommand(control, name, value, byUser) {
  const [changed, fire, data, inputType] = dom.controlCommand(control, name, value, byUser);
  valueEdited(control, changed);
  controlEdited(control, changed);
  if (fire) fireInput(control, inputType, data, null);
  return true;
}
// An editing host's command: the engine's edit of it over the selection (editing_commands.rs `editCommand`), which says
// what the rest is — what it changed finished, the cloning steps of what it copied run, the CSS the command gives the
// elements it answers set, the selection put where it says, and `input` fired, with its `data`, where it says it fires.
function hostCommand(doc, host, name, value, inputType, dataTransfer) {
  const ends = selectionEnds(doc);
  if (!ends) return false;
  const made = dom.editCommand(nidOf(host), ...ends, name, value, nidOf(doc), CHANGE_STEPS);
  if (made === undefined) return false;
  finishHostEdit(doc, made);
  if (made[0]) fireInput(host, inputType, made[1], dataTransfer);
  return true;
}
// …markup's: the selection deleted, the fragment made in the place that left — a script's by the Editing draft's own
// `createContextualFragment`, its scripts staying "already started": they do not run (Chrome, Firefox; the draft's own note
// on that step has it that its consequences "might be undesirable", and says none of running them), an image's handler
// does; a paste's in a document of its own, so nothing of it loads or runs, what it should not bring taken out by the
// engine's word — and its children put at the caret, `input` fired where anything changed.
function hostFragment(doc, host, markup, pasted, inputType, dataTransfer) {
  const ends = selectionEnds(doc);
  if (!ends) return false;
  const deleted = dom.editCommand(nidOf(host), ...ends, 'cut', '', nidOf(doc), CHANGE_STEPS);
  if (deleted !== undefined) finishHostEdit(doc, deleted);
  let fire = deleted !== undefined && deleted[0];
  const range = globalThis.__csimSelectionRange(doc);
  if (range && markup !== '') {
    const fragment = pasted ? pastedFragment(markup, doc) : createContextualFragment(range, markup);
    if (!pasted) for (const script of scriptsIn(fragment)) setScriptFlag(script, SCRIPT_ALREADY_STARTED, true);
    const at = selectionEnds(doc);
    const made = at && dom.editInsertFragment(nidOf(host), ...at, nidOf(fragment), CHANGE_STEPS, pasted);
    if (made) {
      finishHostEdit(doc, made);
      fire = true;
    }
  }
  if (fire) fireInput(host, inputType, null, dataTransfer);
  return true;
}
function inertFragment(markup) {
  const inert = new Document();
  setContentType(inert, 'text/html');
  return createContextualFragment(newRange(inert), markup);
}
function pastedFragment(markup, doc) {
  const fragment = inertFragment(markup);
  const removals = dom.pasteRemovals(nidOf(fragment));
  for (const node of removals[0]) removeChild(parentNodeOf(node), node);
  for (let i = 1; i < removals.length; i += 2) removeAttribute(removals[i], removals[i + 1]);
  adoptNode(doc, fragment);
  return fragment;
}
// …what a command's edit answers finished: its changes, the cloning steps of what it copied, the CSS it gives the elements
// it answers, and the selection where it says.
function finishHostEdit(doc, made) {
  const align = made[2], caret = made[3];
  let i = 4 + (caret === CARET_AROUND ? 4 : caret === 0 ? 0 : 2);
  const styledEnd = i + 1 + made[i];
  const styled = made.slice(i + 1, styledEnd);
  const copiesEnd = styledEnd + 1 + 3 * made[styledEnd];
  for (let k = styledEnd + 1; k < copiesEnd; k += 3) bindingsCloningSteps(made[k], made[k + 1], made[k + 2]);
  finishChanges(made, copiesEnd);
  throwCloneException();
  for (const el of styled) {
    if (align !== '') setInlineStyleProperty(el, 'text-align', align);
    else setAttribute(el, 'style', '');
  }
  if (caret === CARET_AROUND) globalThis.__csimSelect(made[4], made[5], made[6], made[7], doc);
  else if (caret !== 0) globalThis.__csimCollapseSelection(made[4], made[5], doc);
  // (…a selectionchange however the caret came there: the engine's edit moved the selection's range with it already)
  if (caret === CARET_MOVED) globalThis.__csimScheduleSelectionChange(doc);
}
// A clone of a document (DOM "clone a node"): a new EMPTY document of its kind — of its own interface, an XMLDocument's
// an XMLDocument, not of the `constructor` a page may have replaced — complete, with no browsing context (Chrome: no
// defaultView, no location), as the constructor makes one, its encoding, content type, URL, origin, type and mode the
// source's; its children are copied only by a deep clone (`cloneNode`).
function cloneDocumentShell(doc) {
  const d = isXMLDocumentObject(doc) ? newXMLDocument() : new Document();
  clearEdges(d);   // empty → documentElement derives as null
  setContentType(d, contentTypeOf(doc));
  setURL(d, doc.URL);   // the page's URL, resolved: the clone has no location to resolve it by
  setCompatMode(d, compatModeOf(doc));
  return d;
}
// XMLDocument (DOM §4.5.1), generated from its IDL — the document `document.implementation.createDocument` returns
// (and a clone of one), made by the platform alone. It has no browsing context (so `location` is null) and is
// XML-typed (the content type its maker sets makes isHtmlDocument false → case-sensitive element/attribute handling,
// per spec). Its brand is its own flag: a document is a node, no slotted object.
registerInterface('XMLDocument', (o) => isNodeObject(o) && isXMLDocumentObject(o) === true);
class XMLDocument extends Document {
  constructor(token) {
    constructedBy(PLATFORM, token, 'XMLDocument');
    const self = reflectConstruct(Document, NO_ARGUMENTS, new.target);
    setXMLDocumentObject(self, true);
    return self;
  }
}
installXMLDocument(XMLDocument, {});
export const newXMLDocument = () => new XMLDocument(PLATFORM);
globalThis.XMLDocument = XMLDocument;

// `setDomain`'s refusals (realm_location.rs `domain_to_set`): an opaque origin or a sandboxed document, a value that is
// no host — and, any other, one the effective domain is not a subdomain of.
const DOMAIN_OPAQUE = 1, DOMAIN_UNPARSED = 2;
// A document's origin's effective domain (HTML §7.5.2), the engine's (realm_location.rs `effective_domain`): the domain a
// `document.domain` write set on it, else its host — the window's realm's origin, the creator's where it has none; null
// for an opaque origin.
const effectiveDomain = (doc) => dom.effectiveDomain(realmOfDocument(doc));
// …the realm whose origin a document has: its window's, the creator's for one with none.
const realmOfDocument = (doc) => realmOfGlobal(defaultViewOf(doc) ?? globalThis);
// The legacy presentational colours: the body's attributes, reflected ([LegacyNullToEmptyString]).
function bodyColorOf(doc, attr) {
  const b = bodyOf(doc);
  return b && attrsOf(b)[attr] != null ? String(attrsOf(b)[attr]) : '';
}
function setBodyColor(doc, attr, value) {
  const b = bodyOf(doc);
  if (b) setAttribute(b, attr, value);
}
// A live collection of the document's, one per document (`document.embeds === document.embeds`), kept in its rare data:
// its HTML elements a filter takes (collections.rs) — an element of another namespace that shares a local name is none
// of them.
const documentCollection = (key, kind) => (doc) => sameObject(doc, key, () => liveHTMLCollection(() => collectBy(doc, kind)));
const get_embeds = documentCollection('embeds', BY_EMBEDS);

// HTMLAllCollection (HTML §2.6.2), its members generated from its IDL: `document.all`, the document's elements in tree
// order — one per document, an object the engine makes HTML's [[IsHTMLDDA]] one and callable, its indices and names its
// interceptors' (legacy.rs `allCollectionObject`), so that `typeof document.all` is "undefined" and it is falsy.
const allOf = (o) => slotsOf(o, 'HTMLAllCollection');
// …its elements, as the tree is now (one list for as long as its edges are)
function allElements(doc) {
  const gen = currentEdgeGen(), rare = rareDataOf(doc, true);
  if (rare.allGen !== gen) [rare.allGen, rare.allElements] = [gen, collectByTagName(doc, '*', true)];
  return rare.allElements;
}
// …HTML's "all-named elements" of `name`: one of that id, and an `a`, `button`, `embed`, … of that name — the engine's
// (collections.rs `all_named`)
const allNamed = (doc, name) => dom.allNamed(nidOf(doc), name);
// …"get the all-named element(s)": none null, one that one, more a live HTMLCollection of them — one per name, as
// Chrome's and Firefox's (`document.all.b === document.all.b`), live as an id or a name is written as well
function allNamedItem(doc, name) {
  const found = allNamed(doc, name);
  if (found.length < 2) return found[0] ?? null;
  const lists = (rareDataOf(doc, true).allNamedLists ??= new Map());
  if (!lists.has(name)) lists.set(name, liveHTMLCollection(() => allNamed(doc, name)));
  return lists.get(name);
}
// …its supported property names: each element's id and, for one of the named kinds, its name, in tree order, once —
// the engine's (`all_names`)
const allNames = (doc) => dom.allNames(nidOf(doc));
// …"get the all-indexed or named element(s)": an array index's element, any other name's named ones
function allItem(doc, nameOrIndex) {
  if (nameOrIndex === undefined) return null;
  const index = arrayIndex(nameOrIndex);
  return index >= 0 ? allElements(doc)[index] ?? null : allNamedItem(doc, nameOrIndex);
}
const HTMLAllCollection = defineHTMLAllCollection({
  get_length: (all) => allElements(allOf(all).doc).length,
  item: (all, nameOrIndex) => allItem(allOf(all).doc, nameOrIndex),
  namedItem: (all, name) => allNamedItem(allOf(all).doc, name)
});
globalThis.HTMLAllCollection = HTMLAllCollection;
// …the document's (its [[Call]] of no argument, or an undefined one, null; else of its argument as a string — a Symbol's
// a TypeError, as ToString's)
function get_all(doc) {
  // (…kept by identity, in its rare data: it is falsy, as an [[IsHTMLDDA]] object is)
  const rare = rareDataOf(doc, true);
  if (rare.all !== undefined) return rare.all;
  const all = dom.allCollectionObject(
    HTMLAllCollection.prototype,
    (i) => allElements(doc)[i] ?? null,
    () => allElements(doc).length,
    (name) => allNamedItem(doc, name),
    () => allNames(doc),
    (nameOrIndex) => allItem(doc, nameOrIndex === undefined ? undefined : toDOMString(nameOrIndex))
  );
  makeSlots(all, 'HTMLAllCollection').doc = doc;
  return (rare.all = all);
}

// Document's members (generated/bindings.js): its own steps (`createElementIn`, `documentWrite`, `documentOpen`,
// `importNode`, `adoptNode`, `execCommand`), ParentNode's shared with the other node kinds, and the rest here.
//
// What a command of `doc`'s acts on (execCommand's, queryCommandEnabled's) — the engine's (editing_commands.rs
// `commandTarget`), of its focused element and its own selection: `{control}` a focused text control, `{host}` the root
// editable element the selection is in, null for none — and for any in a document with no browsing context, whose
// selection is no window's.
const TARGET_CONTROL = 1, TARGET_HOST = 2;
function commandTarget(doc, commandId) {
  if (defaultViewOf(doc) === null) return null;
  const active = focusedElementOf(doc);
  const [kind, node] = dom.commandTarget(String(commandId), active ? nidOf(active) : -1, globalThis.__csimSelectionState(doc), globalThis.__csimClipboardPartition());
  return kind === TARGET_CONTROL ? { control: node } : kind === TARGET_HOST ? { host: node } : null;
}
// DocumentOrShadowRoot's `activeElement` (HTML §6.6.4) — the engine's (focus.rs `active_element`): its node document's
// focused element retargeted against it (a document's the outermost host in it: `shadowRoot.activeElement` exposes the
// inner one), none where that is in another tree; with nothing focused — one removed from the tree is focused no more (a
// ProseMirror NodeView rebuilt, a closed popup) — a document's body element, else its document element.
export function activeElementOf(root) {
  const doc = nodeTypeOf(root) === NODE_DOC ? root : nodeDocumentOf(root);
  return doc ? dom.activeElement(nidOf(root), nidOf(doc)) : null;
}
// `location` is [LegacyUnforgeable]: each document's own, defined by its constructor.
// (…the realm's own document answered first: it is the Proxy `makeDocProxy` makes, every read through which costs)
registerInterface('Document', (o) => (o != null && o === globalThis.document) || (nodeObjectTypeOf(o) === NODE_DOC));
const defineDocumentUnforgeables = installDocument(Document, {
  // ── DOM
  // `Document.parseHTMLUnsafe(html)`: a new HTML document of it — parsed as DOMParser's is, with no browsing context
  // (nothing runs, nothing is constructed, `<noscript>` is markup), but one that allows declarative shadow roots; its
  // URL about:blank (Chrome).
  parseHTMLUnsafe(_, html) {
    const doc = parseHtmlDocument(html, true);
    setContentType(doc, 'text/html');
    setURL(doc, 'about:blank');
    setWindowRegistryOf(doc, null);
    setReadyState(doc, 'complete');
    return doc;
  },
  get_implementation: (doc) => sameObject(doc, 'implementation', () => new DOMImplementation(PLATFORM, doc)),
  get_URL: documentURL,
  get_documentURI: documentURL,
  get_compatMode: (doc) => (isQuirksDocument(doc) ? 'BackCompat' : 'CSS1Compat'),
  // (…what its bytes were decoded as, natively — `__dom.decodeDocument` — and UTF-8 for a document made of a string:
  // DOMParser's, `srcdoc`, the initial about:blank, createHTMLDocument's; `charset` and `inputEncoding` legacy aliases)
  get_characterSet: documentEncoding,
  get_charset: documentEncoding,
  get_inputEncoding: documentEncoding,
  get_contentType: (doc) => contentTypeOf(doc) || 'text/html',
  get_doctype: (doc) => relativeOf(doc, RELATIVE_DOCTYPE),
  get_documentElement: documentElementOf,
  // (…whether the document is HTML — which lowercases the search for its HTML elements — bound as the live list is
  // made, so a later change of it does not change the list)
  getElementsByTagName(doc, qualifiedName) {
    const htmlDoc = isHtmlDocument(doc);
    return liveHTMLCollection(() => collectByTagName(doc, qualifiedName, htmlDoc), currentEdgeGen);
  },
  getElementsByTagNameNS: (doc, namespace, localName) => liveHTMLCollection(() => collectByTagNameNS(doc, namespace, localName), currentEdgeGen),
  getElementsByClassName: (doc, classNames) => liveHTMLCollection(() => collectByClassName(doc, classNames)),
  // createElement: the name validated, then ASCII-lowercased in an HTML document only (an XML one keeps its case), never
  // split at a prefix; HTML's namespace in an HTML or XHTML document, none in an XML one. Its options a string (a
  // legacy form, which says nothing) or an ElementCreationOptions — `is`, a customized built-in's name (an internal
  // slot, not an `is` attribute), and the registry to look the definition up in.
  createElement(doc, localName, options) {
    if (!isValidElementLocalName(localName)) {
      throw new DOMException(`Failed to execute 'createElement' on 'Document': The tag name provided ('${localName}') is not a valid name.`, 'InvalidCharacterError');
    }
    const html = isHtmlDocument(doc);
    const ns = html || contentTypeOf(doc) === 'application/xhtml+xml' ? HTML_NS : null;
    const { is = null, customElementRegistry } = typeof options === 'object' ? options : {};
    return createElementIn(doc, ns, null, html ? asciiLower(localName) : localName, customElementRegistry, is);
  },
  createElementNS(doc, namespace, qualifiedName, options) {
    const { namespace: ns, prefix, localName } = validateAndExtract(namespace, qualifiedName);
    const { is = null, customElementRegistry } = typeof options === 'object' ? options : {};
    return createElementIn(doc, ns, prefix, localName, customElementRegistry, is);
  },
  createDocumentFragment: (doc) => nodeMadeFor(doc, DocumentFragment),
  createTextNode: (doc, data) => nodeMadeFor(doc, Text, data),
  // (…an XML document's only, its data no CDATA section's end)
  createCDATASection(doc, data) {
    if (isHtmlDocument(doc)) throw new DOMException('This operation is not supported for HTML documents.', 'NotSupportedError');
    if (data.includes(']]>')) throw new DOMException('String contains an invalid character.', 'InvalidCharacterError');
    return nodeMadeFor(doc, CDATASection, PLATFORM, data);
  },
  createComment: (doc, data) => nodeMadeFor(doc, Comment, data),
  // (…its target an XML Name, its data no instruction's end)
  createProcessingInstruction(doc, target, data) {
    checkProcessingInstruction("Failed to execute 'createProcessingInstruction' on 'Document': ", target, data);
    return new ProcessingInstruction(PLATFORM, target, data, doc);
  },
  importNode,
  adoptNode: (doc, node) => adoptNode(doc, node),
  // (…a detached Attr: its name a Name, ASCII-lowercased in an HTML document)
  createAttribute(doc, localName) {
    if (!isValidAttributeLocalName(localName)) {
      throw new DOMException("'" + localName + "' is not a valid attribute name.", 'InvalidCharacterError');
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
    if (!Interface) throw new DOMException(`Failed to execute 'createEvent' on 'Document': The provided event type ('${interfaceName}') is invalid.`, 'NotSupportedError');
    // (…the interface itself, not a global a page may have replaced; TextEvent's and BeforeUnloadEvent's, which have no
    // constructor, their own)
    const ev = Interface === TextEvent ? createTextEvent() : Interface === BeforeUnloadEvent ? createBeforeUnloadEvent() : new Interface('');
    eventState(ev).initialized = false;
    return ev;
  },
  createRange: (doc) => newRange(doc),
  // A NodeIterator (DOM §6.1) — DOMPurify walks its sanitising fragment with one — and a TreeWalker (§6.2): the
  // engine's traversals (traversal.rs), which call back into `accept` for each node `whatToShow` shows.
  createNodeIterator: (doc, root, whatToShow, filter) => NodeIteratorBinding.create(root, whatToShow, filter),
  createTreeWalker: (doc, root, whatToShow, filter) => TreeWalkerBinding.create(root, whatToShow, filter),
  getElementById: (doc, elementId) => findById(doc, elementId),
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
  // (…HTML: its origin's effective domain — a document with no browsing context has its creator's origin (Chrome: a
  // `createHTMLDocument()` one's is the page's host), an about:blank / srcdoc frame's its parent's, an opaque one, a
  // sandboxed document's, none — which a write sets: only a document with a browsing context and a tuple origin may, to
  // its effective domain or a domain it is a subdomain of (no IP address but itself, no public suffix), host-parsed
  // (Chrome's messages).)
  get_domain: (doc) => effectiveDomain(doc) ?? '',
  set_domain(doc, value) {
    const fail = (why) => new DOMException(`Failed to set the 'domain' property on 'Document': ${why}`, 'SecurityError');
    if (defaultViewOf(doc) === null) throw fail('A browsing context is required to set a domain.');
    // (…null once set, else why not, the domain `value` host-parses to and the effective one)
    const refused = dom.setDomain(realmOfDocument(doc), value);
    if (refused === null) return;
    const [why, host, effective] = refused;
    if (why === DOMAIN_OPAQUE) throw fail('Assignment is forbidden for sandboxed iframes.');
    if (why === DOMAIN_UNPARSED) throw fail(value === '' ? "'' is an empty domain." : `'${value}' could not be parsed properly.`);
    throw fail(`'${host}' is not a suffix of '${effective}'.`);
  },
  // (…the page that led here — a link's, a form's, as its navigation's request sent it — and none for an address-bar
  // visit, nor for a document no navigation made: Discourse's /login sets its `destination_url` by it)
  get_referrer: (doc) => referrerOf(doc) ?? '',
  // (…the session's cookie store, the engine's (cookie_jar.rs), for the document's URL — its path, its host, its scheme —
  // in this realm's browsing context, whose ancestors make it cross-site or not; none for a cookie-averse document, one
  // without a browsing context — made with none, or no longer its navigable's active one: a frame's after it navigated
  // away (HTML), whose realm's host functions are not its any more either)
  // — a document of an opaque origin (sandboxed without allow-same-origin, a `data:` one) none, a SecurityError: HTML)
  // (…in the context the engine gives the document's cookie URL: referrer.rs `documentCookieContext`)
  get_cookie(doc) {
    if (cookieAverse(doc)) return '';
    cookieAllowed('read');
    const url = cookieURL(doc), realm = globalThis.__csimRealmId();
    return globalThis.__getDocumentCookie(url, realm, dom.documentCookieContext(realm, url)) || '';
  },
  set_cookie(doc, value) {
    if (cookieAverse(doc)) return;
    cookieAllowed('set');
    const url = cookieURL(doc), realm = globalThis.__csimRealmId();
    globalThis.__setDocumentCookie(value, url, realm, dom.documentCookieContext(realm, url));
  },
  // (…MM/DD/YYYY HH:MM:SS, local time: the response's Last-Modified, `lastModifiedOf`, else now)
  get_lastModified(doc) {
    const d = new IntrinsicDate(lastModifiedOf(doc) ?? platformDateNow());
    const p = (n) => ('0' + n).slice(-2);
    return p(d.getMonth() + 1) + '/' + p(d.getDate()) + '/' + d.getFullYear() + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  },
  get_readyState: readyStateOf,
  // (…its title element's — an SVG root's first `title` child, else the first HTML `title` in tree order — text,
  // whitespace stripped and collapsed: element_state.rs `document_title`)
  get_title: (doc) => dom.documentTitle(doc),
  // (…that title's text set — one made where there is none: an SVG root's first child, an HTML document's head's last,
  // and with neither a title nor a head, nothing done)
  set_title(doc, value) {
    const docEl = documentElementOf(doc);
    if (!docEl) return;
    const svgRoot = isSvg(docEl, 'svg');
    if (!svgRoot && namespaceOf(docEl) !== HTML_NS) return;
    let title = dom.titleElement(doc);
    if (!title && svgRoot) {
      insertBefore(docEl, title = createElementIn(doc, SVG_NS, null, 'title'), childAtOf(docEl, 0));
    } else if (!title) {
      const head = headOf(doc);
      if (!head) return;
      appendChild(head, title = createElementIn(doc, HTML_NS, null, 'title'));
    }
    setTextContent(title, value);
  },
  get_dir(doc) {
    const de = documentElementOf(doc);
    return de ? reflectEnum(de, 'dir', REFLECT_KEYWORDS_DIR) : '';
  },
  set_dir(doc, value) {
    const de = documentElementOf(doc);
    if (de) setAttribute(de, 'dir', value);
  },
  get_body: bodyOf,
  // (…a `body` or `frameset` — anything else a HierarchyRequestError — in place of the one there, else appended to the
  // document element, which must be)
  set_body(doc, value) {
    if (!(value && namespaceOf(value) === HTML_NS && (localNameOf(value) === 'body' || localNameOf(value) === 'frameset'))) {
      throw new DOMException(
        "Failed to set the 'body' property on 'Document': The new body element is of type '" + (value ? nodeNameOf(value) : 'null') +
        "'. It must be either a 'BODY' or 'FRAMESET' element.", 'HierarchyRequestError');
    }
    const current = bodyOf(doc);
    if (current === value) return;
    if (current) { replaceChild(parentOrHostOf(current), value, current); return; }
    const docEl = documentElementOf(doc);
    if (!docEl) throw new DOMException("Failed to set the 'body' property on 'Document': No document element exists.", 'HierarchyRequestError');
    appendChild(docEl, value);
  },
  get_head: headOf,
  get_images: documentCollection('images', BY_IMAGES),
  get_embeds,
  get_all,
  get_plugins: get_embeds,
  get_links: documentCollection('links', BY_LINKS),
  get_forms: documentCollection('forms', BY_FORMS),
  get_scripts: documentCollection('scripts', BY_SCRIPTS),
  get_anchors: documentCollection('anchors', BY_ANCHORS),
  get_applets: (doc) => sameObject(doc, 'applets', () => liveHTMLCollection(() => [])),
  // (…a LIVE NodeList, HTML §3.1.5, of the HTML elements whose `name` is the name, in tree order — the document element
  // among them — re-walked when the tree changes: a move into a shadow tree, a reorder, moveBefore-name-map)
  getElementsByName: (doc, elementName) => liveNodeList(() => collectBy(doc, BY_NAME, elementName)),
  // (…the `<script>` running, set around `__csim_runScript`: bundlers derive their public path from its `src`)
  get_currentScript: currentScriptOf,
  // open(): the document emptied for rewriting; open(url, name, features), the window's open steps — on its window,
  // which a document with none lacks.
  open_unused1_unused2: (doc) => documentOpen(doc),
  open_url_name_features(doc, url, name, features) {
    const win = defaultViewOf(doc);
    if (!win) throw new DOMException("Failed to execute 'open' on 'Document': The document has no window associated.", 'InvalidStateError');
    return win.open(url, name, features);
  },
  close: documentClose,
  write(doc, text) { documentWrite(doc, text.join('')); },
  writeln(doc, text) { documentWrite(doc, text.join('') + '\n'); },
  get_defaultView: defaultViewOf,
  // (…no window manager: a document with a browsing context is visible, one without hidden — Chrome — or one being
  // unloaded, hidden since its pagehide: `__csimHideDocument`; and focused where it is on the focus chain, HTML "has
  // focus steps": a frame's not until the focus is in it — Chrome, measured 2026-10-29)
  hasFocus: (doc) => dom.hasFocus(nidOf(doc)),
  get_visibilityState: (doc) => (documentHidden(doc) ? 'hidden' : 'visible'),
  get_hidden: (doc) => documentHidden(doc),
  // designMode: 'on' or 'off', set ASCII case-insensitively — any other value ignored.
  // (…the engine's, which makes the document element an editing host: STATE_DESIGN_MODE)
  get_designMode: (doc) => (hasState(doc, STATE_DESIGN_MODE) ? 'on' : 'off'),
  set_designMode(doc, value) {
    const mode = asciiLower(value);
    if (mode === 'on' || mode === 'off') setStateBit(doc, STATE_DESIGN_MODE, mode === 'on');
  },
  execCommand: (doc, commandId, showUI, value) => execCommand(doc, commandId, value),
  // (…the commands `execCommand` runs — editing_commands.rs `command_support` — enabled where the selection is in an
  // editing host, a text control's only where it is one a text control takes (Chrome); their state, value and
  // indeterminacy the inert defaults)
  queryCommandSupported: (doc, commandId) => dom.commandSupport(commandId) >= 0,
  queryCommandEnabled: (doc, commandId) => commandTarget(doc, commandId) !== null,
  queryCommandState: () => false,
  queryCommandIndeterm: () => false,
  queryCommandValue: () => '',
  get_fgColor: (doc) => bodyColorOf(doc, 'text'),
  set_fgColor(doc, value) { setBodyColor(doc, 'text', value); },
  get_linkColor: (doc) => bodyColorOf(doc, 'link'),
  set_linkColor(doc, value) { setBodyColor(doc, 'link', value); },
  get_vlinkColor: (doc) => bodyColorOf(doc, 'vlink'),
  set_vlinkColor(doc, value) { setBodyColor(doc, 'vlink', value); },
  get_alinkColor: (doc) => bodyColorOf(doc, 'alink'),
  set_alinkColor(doc, value) { setBodyColor(doc, 'alink', value); },
  get_bgColor: (doc) => bodyColorOf(doc, 'bgcolor'),
  set_bgColor(doc, value) { setBodyColor(doc, 'bgcolor', value); },
  // (…the Netscape event model's, which do nothing)
  clear() {},
  captureEvents() {},
  releaseEvents() {},
  get_activeElement: activeElementOf,
  get_styleSheets: styleSheetListOf,
  // `adoptedStyleSheets` — the constructed sheets adopted (Lit and Stencil push `new CSSStyleSheet()`s): only the
  // active document's feed its cascade.
  get_adoptedStyleSheets: adoptedStyleSheetsOf,
  set_adoptedStyleSheets: setAdoptedStyleSheets,
  // ── CSSOM View: hit-testing through the layout (`elementFromPoint` the topmost box under the point — ProseMirror's
  // `posAtCoords` resolves a click by it), and the viewport's scroll root: the root element in standards mode, the body
  // in quirks mode unless it is potentially scrollable (CSSOM View §scrollingElement; Chrome: then none) — the engine's
  // (scroll_boxes.rs `scrolling_element`)
  elementFromPoint: (doc, x, y) => elementFromPointIn(doc, x, y),
  elementsFromPoint: (doc, x, y) => elementsFromPointIn(doc, x, y),
  caretPositionFromPoint: (doc, x, y, options) => caretPositionFromPointIn(doc, x, y, options),
  get_scrollingElement: styleEngineScrollingElement,
  // ── The rest: Fonts (one FontFaceSet a document, always ready: fonts load on demand), Web Animations (the
  // document's animations, in composite order, and the driver's clock as its timeline), the Selection API's (its own,
  // where it has a browsing context), and what there is none of here — fullscreen, Picture-in-Picture, pointer lock — or nothing to ask —
  // the Storage Access API's, every access granted
  get_fonts: (doc) => sameObject(doc, 'fontFaceSet', () => globalThis.__csimNewFontFaceSet(doc)),
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
  installEventHandlers: installEventHandlerAttrs
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
const __docNamedTarget = objectCreate(Object.getPrototypeOf(Document.prototype));
const DocumentNamedProps = new Proxy(__docNamedTarget, {
  get(target, prop, receiver) {
    // Gate on the O(1) Set FIRST: the overwhelmingly common case is an
    // unresolved read whose name was never a supported document name, so a
    // missed `DOC_NAMED_PROPS.has` skips the proto-chain `Reflect.has` walk
    // entirely (rule 3). Registered names still defer to a real member.
    if (typeof prop === 'string' && DOC_NAMED_PROPS[prop] === true && !Reflect.has(target, prop)) {
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
  setContentType(doc, undefined);   // → isHtmlDocument() true (text/html)
  setURL(doc, undefined);    // URL resolves via globalThis.location
  // (…a browsing context's: THIS realm's window registry is its window registry, whichever realm asks)
  setWindowRegistryOf(doc, globalCERegistry);
  setReadyState(doc, 'loading');
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
    // (…its node document this one, as the engine reads it too: load_gates.rs `node_document`)
    assignOwnerDoc(html, proxy);
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
  dom.rangeSet(range, which, node, boundaryNid(node), offset);
  rangeMoved(range);
}
// …and where the range is the selection's, the selection changed with it: a selectionchange (Selection API: "the
// associated range's boundary point is mutated either by the user or the content script"), and what a line-wise move
// left the caret with ends (layout.js `forgetCaretMove`).
function rangeMoved(range) {
  if (!globalThis.__csimIsSelectionRange?.(range)) return;
  forgetCaretMove();
  globalThis.__csimScheduleSelectionChange(globalThis.document);
}
// `node`'s slot, as a boundary point names it: an Attr — no tree's — gets one the first time it is a boundary.
export function boundaryNid(node) {
  if (nidOf(node) == null || nidOf(node) < 0) registerNativeNode(node);
  return nidOf(node);
}
// A node's parent in its node tree — none for a shadow root, whose `parentOrHostOf` is its host.
function treeParent(node) {
  return isShadowRoot(node) ? null : parentOrHostOf(node);
}
// NodeIterator and TreeWalker (DOM §6.1-2): their bindings generated from their IDL, the traversals each member runs
// the engine's (traversal.rs), which calls back into the filter for each node `whatToShow` shows. A traverser's state,
// in its slots: the root, `whatToShow`, the filter and its active flag, and where it is — a TreeWalker's current node;
// a NodeIterator's reference, and whether it is before it, the engine's (node_iterators.rs, which runs the pre-removing
// steps of every removal on them), held by its handle (`iter`).
const NodeFilterBinding = defineNodeFilter();
globalThis.NodeFilter = NodeFilterBinding.interface;
const NodeIteratorBinding = defineNodeIterator({
  init(it, root, whatToShow, filter) {
    const iter = new dom.NodeIteratorBase();
    dom.iteratorInit(iter, boundaryNid(root));
    Object.assign(it, { root, whatToShow, filter, active: false, iter });
  },
  get_root(it) { return it.root; },
  get_referenceNode(it) { return dom.iteratorReference(it.iter); },
  get_pointerBeforeReferenceNode(it) { return dom.iteratorBefore(it.iter); },
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
// The traversals the engine runs (traversal.rs `traverse`), by number: a TreeWalker's.
const TRAVERSE_PARENT_NODE = 0, TRAVERSE_FIRST_CHILD = 1, TRAVERSE_LAST_CHILD = 2, TRAVERSE_NEXT_SIBLING = 3,
      TRAVERSE_PREVIOUS_SIBLING = 4, TRAVERSE_NEXT_NODE = 5, TRAVERSE_PREVIOUS_NODE = 6;
// Where the engine says a traversal is (traversal.rs `answer_value`): 0 for nowhere, else `[1, node]`.
const traversalStatus = (answer) => (answer === 0 ? 0 : answer[0]);
// A TreeWalker's traversal `kind` (`member`, by name) from its current node: the node it finds — the walker's current
// node then — or null.
function treeWalkerTraverse(tw, kind, member) {
  const filter = tw.filter && ((at) => {
    const was = tw.current;
    const result = filterNode(tw, at, member, 'TreeWalker');
    // (…a filter that sets the walker's current node: the traversal reads it as it goes on)
    if (tw.current !== was) dom.traverseCurrent(boundaryNid(tw.current));
    return result;
  });
  const answer = dom.traverse(kind, boundaryNid(tw.root), boundaryNid(tw.current), tw.whatToShow, filter);
  if (traversalStatus(answer) === 0) return null;
  return tw.current = answer[1];
}
// DOM NodeIterator "traverse" (forward = nextNode, else previousNode), the engine's: the node the filter accepts, the
// iterator's reference moving to it — or to where a removal while the filter ran moved it (as Chrome and Firefox do:
// the spec has the reference land on the removed node).
function nodeIteratorTraverse(it, forward) {
  let found = null;
  const filter = it.filter && ((node) => {
    found = node;
    return filterNode(it, node, forward ? 'nextNode' : 'previousNode', 'NodeIterator');
  });
  const node = dom.iteratorTraverse(it.iter, forward, it.whatToShow, filter);
  if (node === null) return null;
  return it.filter ? found : node;
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
    throw new DOMException(`Failed to execute '${member}' on '${iface}': The filter is already active.`, 'InvalidStateError');
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
// The "length of a node" (DOM §4.2): a DocumentType is 0, a CharacterData node its data's length, any other node its
// child count — the engine's, never a `data` getter a page may replace.
export const nodeLength = (node) => dom.nodeLength(boundaryNid(node));
// "Set the start/end of a range" (DOM §5.5): the boundary node + offset validated (a doctype has no boundary point, an
// offset past the node's length none in it), then the boundary set, the *other* boundary collapsed onto it where the new
// one would cross it or land in another tree.
function setRangeBoundary(range, node, offset, which) {
  checkRangePoint(which === 'start' ? 'setStart' : 'setEnd', node, offset);
  // (…and the other point with it where it would be in another tree, or on the wrong side: ranges.rs)
  dom.rangeSetPoint(range, which === 'start' ? RANGE_START : RANGE_END, node, boundaryNid(node), offset);
  rangeMoved(range);
}
// AbstractRange, Range and StaticRange (DOM §5.3-5.5), generated from their IDL. A Range's object is the engine's: made
// by `__dom.RangeBase` (ranges.rs), a wrapper of a handle holding its boundary points' containers, for the class being
// constructed — as a node's is by NodeBase — which exists from a realm on, not in the snapshot, where a range no realm's
// page ever sees is a plain object. A StaticRange's points are its own state, set as it is made and never moved.
class AbstractRange extends Object {
  constructor() { throw new TypeError("Failed to construct 'AbstractRange': Illegal constructor"); }
}
rootInterface(AbstractRange);
// (…the engine's range or a static one, whose points are its slots')
const staticRangeOf = (o) => slotsOf(o, 'StaticRange');
registerInterface('AbstractRange', (o) => IS_RANGE(o) || IS_STATIC_RANGE(o));
installAbstractRange(AbstractRange, {
  get_startContainer: (range) => staticRangeOf(range)?.startContainer ?? dom.rangeContainer(range, RANGE_START),
  get_startOffset: (range) => staticRangeOf(range)?.startOffset ?? dom.rangeOffset(range, RANGE_START),
  get_endContainer: (range) => staticRangeOf(range)?.endContainer ?? dom.rangeContainer(range, RANGE_END),
  get_endOffset: (range) => staticRangeOf(range)?.endOffset ?? dom.rangeOffset(range, RANGE_END),
  get_collapsed(range) {
    const s = staticRangeOf(range);
    return s ? s.startContainer === s.endContainer && s.startOffset === s.endOffset : dom.rangeCollapsed(range);
  }
});

// A live range's start and end, [node, offset], and whether it is collapsed — the engine's, as the platform reads them,
// never through the members a page may replace.
export const rangeStart = (range) => [dom.rangeContainer(range, RANGE_START), dom.rangeOffset(range, RANGE_START)];
export const rangeEnd = (range) => [dom.rangeContainer(range, RANGE_END), dom.rangeOffset(range, RANGE_END)];
export const rangeCollapsed = (range) => dom.rangeCollapsed(range);

// A Range is collapsed at (the relevant document, 0) as it is made — `new Range()`'s global's document, or the one
// `createRange()` was asked of (`newRange`).
export class Range extends AbstractRange {
  constructor(token, doc) {
    const self = reflectConstruct(dom.RangeBase, NO_ARGUMENTS, new.target);
    setRangePoint(self, RANGE_BOTH, token === PLATFORM ? doc : globalThis.document, 0);
    return self;
  }
}
export function newRange(doc) { return new Range(PLATFORM, doc || globalThis.document); }
// (…any realm's, which the engine knows by its handle; in the snapshot, this realm's alone)
const IS_RANGE = (o) => (dom ? dom.isRange(o) : o instanceof Range);
registerInterface('Range', IS_RANGE);
// "Set the start/end before/after a node": the boundary (node's parent, node's index [+1]) — a parentless node has no
// valid boundary, an InvalidNodeTypeError.
function boundaryRelativeToNode(range, node, which, after) {
  const fn = (which === 'start' ? 'setStart' : 'setEnd') + (after ? 'After' : 'Before');
  const parent = treeParent(node);
  if (!parent) {
    throw new DOMException(`Failed to execute '${fn}' on 'Range': the node has no parent.`, 'InvalidNodeTypeError');
  }
  setRangeBoundary(range, parent, childIndexOf(parent, node) + (after ? 1 : 0), which);
}
// (…a point's node a doctype, or its offset past the node's length, an error of `member`'s: the engine's, as a
// selection's are refused)
function checkRangePoint(member, node, offset) {
  switch (dom.rangePointError(boundaryNid(node), offset)) {
    case 1: throw new DOMException(`Failed to execute '${member}' on 'Range': the node is a doctype.`, 'InvalidNodeTypeError');
    case 2: throw new DOMException(`Failed to execute '${member}' on 'Range': the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
  }
}
installRange(Range, {
  // (…the engine's: one of the start container's inclusive ancestors)
  get_commonAncestorContainer: (range) => dom.rangeCommonAncestor(range),
  setStart: (range, node, offset) => setRangeBoundary(range, node, offset, 'start'),
  setEnd: (range, node, offset) => setRangeBoundary(range, node, offset, 'end'),
  setStartBefore: (range, node) => boundaryRelativeToNode(range, node, 'start', false),
  setStartAfter: (range, node) => boundaryRelativeToNode(range, node, 'start', true),
  setEndBefore: (range, node) => boundaryRelativeToNode(range, node, 'end', false),
  setEndAfter: (range, node) => boundaryRelativeToNode(range, node, 'end', true),
  collapse(range, toStart) {
    const from = toStart ? RANGE_START : RANGE_END;
    setRangePoint(range, toStart ? RANGE_END : RANGE_START, dom.rangeContainer(range, from), dom.rangeOffset(range, from));
  },
  // (…`node` within its parent: (parent, index) to (parent, index + 1); a parentless node an InvalidNodeTypeError)
  selectNode(range, node) {
    const parent = treeParent(node);
    if (!parent) {
      throw new DOMException("Failed to execute 'selectNode' on 'Range': the node has no parent.", 'InvalidNodeTypeError');
    }
    const index = childIndexOf(parent, node);
    setRangePoint(range, RANGE_START, parent, index);
    setRangePoint(range, RANGE_END, parent, index + 1);
  },
  // (…the whole of `node`: (node, 0) to (node, length); a doctype has no contents to select)
  selectNodeContents(range, node) {
    if (nodeTypeOf(node) === NODE_DOCTYPE) {
      throw new DOMException("Failed to execute 'selectNodeContents' on 'Range': the node is a doctype.", 'InvalidNodeTypeError');
    }
    setRangePoint(range, RANGE_START, node, 0);
    setRangePoint(range, RANGE_END, node, nodeLength(node));
  },
  // (…`how` one of the four constants, else a NotSupportedError; ranges of two trees a WrongDocumentError)
  compareBoundaryPoints(range, how, other) {
    if (how > 3) {
      throw new DOMException("Failed to execute 'compareBoundaryPoints' on 'Range': the comparison method must be 0, 1, 2 or 3.", 'NotSupportedError');
    }
    const order = dom.rangeCompareBoundaries(range, how, other);
    if (order === null) throw new DOMException('The two Ranges are not in the same tree.', 'WrongDocumentError');
    return order;
  },
  deleteContents: (range) => deleteRangeContents(range),
  extractContents: (range) => extractRangeContents(range),
  cloneContents: (range) => cloneRangeContents(range),
  insertNode: (range, node) => insertNodeInRange(range, node),
  // (…the contents extracted, wrapped in `newParent`, put where they were, and selected — no non-Text node partially
  // selected, no Document, DocumentType or DocumentFragment the parent)
  surroundContents(range, newParent) {
    const partialNonText = dom.rangeContents(...rangeBounds(range))[6];
    if (partialNonText) {
      throw new DOMException("Failed to execute 'surroundContents' on 'Range': the range partially selects a non-Text node.", 'InvalidStateError');
    }
    const nt = nodeTypeOf(newParent);
    if (nt === NODE_DOC || nt === NODE_DOCTYPE || nt === NODE_FRAGMENT) {
      throw new DOMException("Failed to execute 'surroundContents' on 'Range': the new parent is a Document, DocumentType, or DocumentFragment node.", 'InvalidNodeTypeError');
    }
    const fragment = extractRangeContents(range);
    // (…newParent emptied by "replace all", one change of its children)
    if (childNodesOf(newParent).length) replaceAllChildren(newParent, null);
    insertNodeInRange(range, newParent);
    appendChild(newParent, fragment);
    const parent = treeParent(newParent), index = childIndexOf(parent, newParent);
    setRangePoint(range, RANGE_START, parent, index);
    setRangePoint(range, RANGE_END, parent, index + 1);
  },
  cloneRange(range) {
    const start = dom.rangeContainer(range, RANGE_START);
    const r = newRange(nodeTypeOf(start) === NODE_DOC ? start : nodeDocumentOf(start));
    setRangePoint(r, RANGE_START, start, dom.rangeOffset(range, RANGE_START));
    setRangePoint(r, RANGE_END, dom.rangeContainer(range, RANGE_END), dom.rangeOffset(range, RANGE_END));
    return r;
  },
  // (…a no-op in today's DOM)
  detach() {},
  // (…a point in another tree false, not an error, as comparePoint's is)
  isPointInRange(range, node, offset) {
    const where = dom.rangeComparePoint(range, boundaryNid(node), offset);
    if (where === null) return false;
    checkRangePoint('isPointInRange', node, offset);
    return where === 0;
  },
  comparePoint(range, node, offset) {
    const where = dom.rangeComparePoint(range, boundaryNid(node), offset);
    if (where === null) throw new DOMException('The node provided is in a different tree than this Range.', 'WrongDocumentError');
    checkRangePoint('comparePoint', node, offset);
    return where;
  },
  intersectsNode: (range, node) => rangeIntersectsNode(range, node),
  // (…the text of the Text nodes it contains, the boundary ones sliced by their offsets: ranges.rs `rangeText`)
  stringify: (range) => dom.rangeText(range),
  // CSSOM View's: the client rects of what it selects (layout.js `rangeRectsOf`), and the one rect around them — the
  // engine's (`rangeBoundingRectOf`).
  getClientRects: (range) => rectList(rangeRectsOf(range).map(([x, y, w, h]) => new DOMRect(x, y, w, h))),
  getBoundingClientRect(range) {
    const [x, y, w, h] = rangeBoundingRectOf(range);
    return new DOMRect(x, y, w, h);
  },
  createContextualFragment: (range, html) => createContextualFragment(range, html)
});
// The range's boundary points as the engine's queries take them: (start nid, offset, end nid, offset).
function rangeBounds(range) {
  return [boundaryNid(dom.rangeContainer(range, RANGE_START)), dom.rangeOffset(range, RANGE_START),
          boundaryNid(dom.rangeContainer(range, RANGE_END)), dom.rangeOffset(range, RANGE_END)];
}
// `createContextualFragment(html)` (DOM Parsing): `html` parsed as a fragment in the context of the range's start node —
// an element, a Text's or a Comment's parent element (`fragmentContextOf`) — by the fragment parsing algorithm of its
// document, the XML one in an XML document; owned by that document, its scripts unmarked as already started (they run
// once the fragment is inserted, unlike innerHTML's).
function createContextualFragment(range, html) {
  const node = dom.rangeContainer(range, RANGE_START);
  const doc  = nodeTypeOf(node) === NODE_DOC ? node : nodeDocumentOf(node);
  const realm = makingRealmOf(doc);
  if (realm !== null) return inRealm(realm, 'createContextualFragment', range, html);
  const frag = nodeMadeFor(doc, DocumentFragment);
  const at = nodeTypeOf(node) === NODE_TEXT || nodeTypeOf(node) === NODE_CDATA || nodeTypeOf(node) === NODE_COMMENT ? parentOrHostOf(node) : node;
  // (…its elements of its context's registry — a body made for it its document's, HTML's "create an element")
  const ctx = fragmentContextOf(at, doc);
  for (const c of isHtmlDocument(doc) ? parseFragment(html, ctx) : parseXmlFragment(html, ctx)) appendChild(frag, c);
  // (…owned by the start node's document: parseFragment and createDocumentFragment fall back to the main one, so a
  // range in a createHTMLDocument / DOMParser document would hand back nodes of another)
  adoptNode(doc, frag);
  // A context INSIDE template content parses its fragment in the template-contents "document": the tracking sentinel
  // re-stamped (the hops above re-pointed it) — the start container may be the template content fragment itself.
  if (ceRegistryOf(ctx) === TRACKING_NULL) {
    restampRegistries(frag, REGISTRY_UNSET, TRACKING_NULL, true);
  } else {
    // (…its custom elements' upgrades enqueued by their registry, which run as the call returns)
    ceEnqueueUpgradesIn(frag);
  }
  for (const script of scriptsIn(frag)) setScriptFlag(script, SCRIPT_ALREADY_STARTED, false);
  return frag;
}
// …the context of insertAdjacentHTML's and createContextualFragment's parse (DOM Parsing): `node` where it is an element
// but an HTML document's `html`, else a new `body` of `doc` — whose mode, scripting flag and registry are its document's.
function fragmentContextOf(node, doc) {
  return node && nodeTypeOf(node) === NODE_ELEMENT && !(isHtmlDocument(doc) && isHtml(node, 'html')) ? node : createElementIn(doc, HTML_NS, null, 'body');
}
// `insertNode(node)`: `node` inserted at the range's start — a Text start node split at the offset, the node put
// before its second half; an element's, at child index `startOffset` — and a collapsed range's end after it.
function insertNodeInRange(range, node) {
  const sc = dom.rangeContainer(range, RANGE_START), so = dom.rangeOffset(range, RANGE_START);
  // (…a Text start node, for insertNode's purposes, a Text or CDATASection node: both split at the offset)
  const startIsText = nodeTypeOf(sc) === NODE_TEXT || nodeTypeOf(sc) === NODE_CDATA;
  // HierarchyRequestError: a PI/Comment start node, a parentless Text start node, or inserting an inclusive ancestor of
  // the start node.
  if (nodeTypeOf(sc) === NODE_PI || nodeTypeOf(sc) === NODE_COMMENT ||
      (startIsText && !parentOrHostOf(sc)) || node === sc || nodeContains(node, sc)) {
    throw new DOMException("Failed to execute 'insertNode' on 'Range': the node may not be inserted here.", 'HierarchyRequestError');
  }
  let referenceNode = startIsText ? sc : childAtOf(sc, so);
  const parent = referenceNode == null ? sc : parentOrHostOf(referenceNode);
  // (…the insertion validated BEFORE mutating, so an invalid node — a Document — throws without first splitting)
  ensurePreInsertionValidity(node, parent, referenceNode);
  if (startIsText) referenceNode = splitTextNode(sc, so);
  if (node === referenceNode) referenceNode = nextSiblingOf(node);
  // (…from its parent: a shadow root, inserted as its children, has none — its host is no parent)
  const from = parentNodeOf(node);
  if (from) removeChild(from, node);
  let newOffset = referenceNode == null ? nodeLength(parent) : childIndexOf(parent, referenceNode);
  newOffset += nodeTypeOf(node) === NODE_FRAGMENT ? nodeLength(node) : 1;
  insertBefore(parent, node, referenceNode);
  if (dom.rangeCollapsed(range)) setRangePoint(range, RANGE_END, parent, newOffset);
}

// A StaticRange: its points as its init gives them — any offsets, checked against nothing — a DocumentType or Attr no
// container. Consumed by input-events libraries through getTargetRanges().
const IS_STATIC_RANGE = (o) => staticRangeOf(o) !== undefined;
export const StaticRange = defineStaticRange(AbstractRange, {
  construct(slots, init) {
    const sc = init.startContainer, ec = init.endContainer;
    if (nodeTypeOf(sc) === NODE_DOCTYPE || nodeTypeOf(sc) === NODE_ATTRIBUTE || nodeTypeOf(ec) === NODE_DOCTYPE || nodeTypeOf(ec) === NODE_ATTRIBUTE) {
      throw new DOMException("Failed to construct 'StaticRange': a DocumentType or Attr node may not be a container.", 'InvalidNodeTypeError');
    }
    slots.startContainer = sc;
    slots.startOffset = init.startOffset;
    slots.endContainer = ec;
    slots.endOffset = init.endOffset;
  }
});
globalThis.AbstractRange = AbstractRange;
globalThis.Range         = Range;
globalThis.StaticRange   = StaticRange;

// Range's `intersectsNode` (DOM §5.5), the engine's (ranges.rs).
function rangeIntersectsNode(range, node) {
  return dom.rangeIntersectsNode(range, boundaryNid(node));
}

// A Range's contents as an HTML string — the text/html flavor a rich cut or copy writes to the clipboard, so a later
// paste can round-trip the markup: a clone of them, its children serialized in what holds them (the engine's).
function serializeRangeHtml(range) {
  try {
    return dom.clipboardMarkup(nidOf(cloneRangeContents(range)), boundaryNid(rangeStart(range)[0]), boundaryNid(rangeEnd(range)[0]), nidOf(nodeDocumentOf(rangeStart(range)[0])) ?? -1);
  } catch (_) { return ''; }
}
// The selected contents written to the clipboard: what is selected in a focused text control (`control`; the engine's,
// which gives a clipboard none of a password), or the selection's text and markup — what is empty held in no flavor,
// nothing selected leaving the clipboard as it was.
function writeSelectionToClipboard(doc, control) {
  // (…nothing of a document its copy's listener took out of its frame: Chrome, Firefox)
  if (defaultViewOf(doc) === null) return;
  const partition = globalThis.__csimClipboardPartition();
  if (control !== null) {
    dom.clipboardWriteControl(partition, nidOf(control));
    return;
  }
  const range = globalThis.__csimSelectionRange(doc);
  if (range && !rangeCollapsed(range)) {
    const [startNode, startOffset] = rangeStart(range), [endNode, endOffset] = rangeEnd(range);
    const text = styleEngineRangeText(boundaryNid(startNode), startOffset, boundaryNid(endNode), endOffset);
    dom.clipboardWriteSelected(partition, text ?? dom.rangeText(range), serializeRangeHtml(range));
  }
}
// The read-only DataTransfer an `insertFromPaste` InputEvent carries into an editing host: getData reads the flavors the
// engine gives it (system_clipboard.rs `paste_strings`) back, and its files are the clipboard's images (`types` "Files",
// Chrome, Firefox); setData and clearData doing nothing (Input Events §4).
function readOnlyPasteTransfer() {
  const dt = new DataTransfer();
  dom.clipboardFillStore(dataTransferStore(dt), globalThis.__csimClipboardPartition(), true);
  for (const f of hostSteps.clipboardFiles()) dt.items.add(f);
  setDataTransferMode(dt, 'read-only');
  return dt;
}
// A paste event's DataTransfer, read-only: the clipboard's flavors, and its files (`types` then includes "Files":
// Discourse's `clipboardHelpers` gates an upload on it). A cut's or a copy's is one the page may write: empty, read/write.
function clipboardEventData(kind) {
  const dt = new DataTransfer();
  setEffectAllowed(dt, 'uninitialized');
  if (kind !== 'paste') return dt;
  dom.clipboardFillStore(dataTransferStore(dt), globalThis.__csimClipboardPartition(), false);
  for (const f of hostSteps.clipboardFiles()) dt.items.add(f);
  setDataTransferMode(dt, 'read-only');
  return dt;
}
// A clipboard action (Clipboard API §8, whether a script's `execCommand` or a user's Ctrl+X / C / V): its ClipboardEvent at
// the element the engine answers, its clipboard data gone once dispatched (Chrome's; a read that waited finds nothing);
// what a canceled one ends with the engine's — what its page left in the data written, for a copy or a cut — and any other
// goes on to the rest of the command, planned of what its listeners left: `asked` says whose. Whether it did (§8).
function clipboardAction(doc, kind, asked) {
  const active = focusedElementOf(doc);
  const target = dom.clipboardEventTarget(active ? nidOf(active) : -1, globalThis.__csimSelectionState(doc));
  const clipboardData = clipboardEventData(kind);
  let canceled = false;
  if (target !== null) {
    try {
      const ev = new ClipboardEvent(kind, { __proto__: null, bubbles: true, cancelable: true, composed: true, clipboardData });
      fireEvent(target, ev);
      canceled = eventState(ev).canceled;
    } catch (_) {}
  }
  const done = dom.clipboardEventDone(kind, dataTransferStore(clipboardData), canceled, globalThis.__csimClipboardPartition());
  setDataTransferMode(clipboardData, null);
  return done ?? carryOutCommand(doc, kind, '', asked);
}
// …a user's: Ctrl/Cmd + X, C or V in `doc`, a `beforeinput` before its edit (Chrome, Firefox). The default of its keydown,
// and of the WPT testdriver's key actions.
export const clipboardGesture = (kind, doc) => clipboardAction(doc, kind, GESTURE_AFTER_EVENT);
hostSteps.clipboardGesture = clipboardGesture;

// (…range_contents.rs: what is made of the contents, and why it throws)
const CONTENTS_MODES = { clone: 0, extract: 1, delete: 2 };
const DOCTYPE_CONTAINED = 1;
// The shared DOM algorithm for Range cloneContents / extractContents / deleteContents (DOM §5.5), the engine's whole
// (range_contents.rs) — `mode` 'clone' copies the contained nodes into a returned fragment, the tree unchanged;
// 'extract' moves them into one; 'delete' removes them, no fragment. The changes it made are finished here, in order,
// the copies' own cloning steps run, a clone's custom elements upgraded (its shadow trees' with it: `cloneNode`'s), and
// for the mutating modes the range collapsed where it says — its start, or after its first partially contained child.
function processRangeContents(range, mode) {
  const [sc, so] = rangeStart(range), [ec, eo] = rangeEnd(range);
  const made = dom.processRangeContents(boundaryNid(sc), so, boundaryNid(ec), eo, CONTENTS_MODES[mode], CHANGE_STEPS);
  if (made === DOCTYPE_CONTAINED) throw hierarchyError('a range containing a doctype cannot be cloned or extracted');
  // (…none where making the answer threw, its exception the page's)
  if (made === undefined) return null;
  engineWritten();   // (…a cloned shadow tree's slots signaled: `cloneNode`'s)
  const copiesAt = finishChanges(made, 3);
  for (let i = copiesAt; i < made.length; i += 3) {
    bindingsCloningSteps(made[i], made[i + 1], made[i + 2]);
    if (isHtml(made[i + 1], 'select')) finalizeSelectOptions(made[i + 1]);
  }
  throwCloneException();
  const frag = made[0];
  upgradeCopies(made, copiesAt);
  if (mode !== 'clone') setRangePoint(range, RANGE_BOTH, made[1] ?? sc, made[1] === null ? so : made[2]);
  return frag;
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
hostSteps.targetRangesFromSelection = function () {
  const r = globalThis.__csimSelectionRange();
  if (!r) return [];
  // (…each point at the Text node beside it, as real browsers report a target range: ranges.rs `rangeTextPoints`)
  const points = dom.rangeTextPoints(r);
  if (!points) return [];
  const startContainer = points[0], startOffset = points[1], endContainer = points[2], endOffset = points[3];
  return [new StaticRange({ startContainer, startOffset, endContainer, endOffset })];
};

// XML serialization (DOM Parsing §3.2) is the arena's (serialize.rs): `XMLSerializer.serializeToString(node)` (dom-parser.js), and
// `innerHTML` / `outerHTML` in an XML document — those requiring the node well-formed, an InvalidStateError where it
// has no well-formed serialization.
export function xmlSerialize(node, inner, wellFormed) {
  const r = serializedXml(node, inner, wellFormed);
  if (typeof r !== 'string') throw new DOMException(r[0], 'InvalidStateError');
  return r;
}
function xmlSerializeInner(el) { return xmlSerialize(el, true, true); }
function xmlSerializeOuter(el) { return xmlSerialize(el, false, true); }

// HTML "update the rendering"'s focus fixup: the document's focused element no longer focusable — moved into an inert,
// hidden or display:none subtree (`moveBefore` keeps focus across the relocation), hidden, made inert — loses focus,
// at the rendering update and not before: it is still `document.activeElement` right after the change (Chrome).
globalThis.__csimFocusFixup = function () {
  const doc = globalThis.document;
  const ae = doc && focusedElementOf(doc);
  if (!ae || isFocusable(ae)) return;
  setFocusedElement(doc, null);   // → activeElement falls back to <body>
  loseFocus(ae, null);
};

// `ParentNode.moveBefore(node, child)` (DOM "atomic move") — relocates `node` to
// be before `child` in this parent WITHOUT removing-and-reinserting, so the
// node's connectedness never changes and no connected/disconnected reactions
// fire. It is stricter than insertBefore: only an Element or CharacterData node
// can move, and `node` and this parent must share a shadow-including root.
// The ParentNode interfaces' (Element / Document / DocumentFragment), never Node's — `"moveBefore" in textNode` must
// be false. Its arguments converted: `node` a Node, `child` a Node or null ("to the end").
function parentNodeMoveBefore(parent, node, child) {
  // The move, the engine's (mutation.rs `moveChild`): the checks of "move" (https://dom.spec.whatwg.org/#move) — one
  // shadow-including tree, no ancestor of the parent, a reference child of it, an Element or CharacterData node, and a
  // Document's one element — then the node's edges, with the live ranges' and NodeIterators' steps a removal and an
  // insertion run (dom/nodes/moveBefore/moveBefore-nodeiterator.html, live-range-updates.html) — it stays connected:
  // none of these removing or insertion steps, but the engine's radio group and registry ones — recorded as a removal and
  // an insertion, and the moving steps: a parser-given form owner left in another tree, and the focus or hover moved with
  // it (the chains above it flip).
  const answer = moveChildOf(parent, node, child);
  if (typeof answer === 'number') {
    switch (answer) {
      case 2: throw hierarchyError('moveBefore: the moved node is an ancestor of the new parent');
      case 3: throw new DOMException('The reference child is not a child of this node', 'NotFoundError');
      case 10: throw hierarchyError(`moveBefore: a ${nodeTypeName(node)} node cannot be moved`);
      case 11: throw hierarchyError('moveBefore: a Text node cannot be a child of a Document');
      case 12: throw hierarchyError('moveBefore: a Document can contain only one element child');
      default: throw hierarchyError('moveBefore: node and new parent are not in the same tree');
    }
  }
  const oldParent = answer;
  engineWritten();
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
  const ownerSelect = htmlAncestorOf(parent, 'select', true);
  if (ownerSelect && (isHtml(node, 'selectedcontent') || (nodeTypeOf(node) === NODE_ELEMENT && selectFirst(node, 'selectedcontent')))) {
    setElementFlag(ownerSelect, SELECT_HAS_SELECTED_CONTENT, true);
    scheduleSelectedContentUpdate(ownerSelect);
  }
  // Connectedness is unchanged (same shadow-including root). A connected move
  // still runs custom-element reactions per moved element — connectedMoveCallback,
  // or the legacy disconnected/connected pair — with isConnected staying true.
  if (isConnected(node)) fireCEMoveReactions(node);
  // (…a move into an inert / hidden subtree: a focused descendant loses focus at the rendering update's focus fixup)
  wakeForFocusFixup(node);
  return undefined;
}

// The node that stands for `node` in tree order: itself, or an Attr's element (null for none).
function positionNode(node) {
  if (nodeTypeOf(node) !== NODE_ATTRIBUTE) return nidOf(node);
  const el = attrOwnerOf(node);
  return el ? nidOf(el) : null;
}
// An Attr's store key in its element; null for any other node, or an Attr with no element.
function positionAttrKey(node) {
  return nodeTypeOf(node) === NODE_ATTRIBUTE ? attrStoreKeyOf(node) : null;
}

// The HTML parser is html5ever, run natively (html_parse.rs); html-tree-builder.js takes the tree it builds onto our
// node ctors. `parseHtmlIntoLive` is the document load path (parse directly into the live document, reusing its
// skeleton); `parseHtmlDocument` is the one-shot fresh-document path (DOMParser, frame fallback);
// `parseHtmlFragment` backs `parseFragment` (innerHTML / outerHTML / insertAdjacentHTML / createContextualFragment),
// context-aware. html-parser.js keeps only the serializers.
const { builtSteps, parseHtmlIntoLive, parseHtmlFragment, parseHtmlDocument, writeAtScript, writeScriptCreated, closeScriptCreated } = installHtmlTreeBuilder({
  createHtmlPageDocument, subtreeRemoved,
  syncInlineEventHandler, inertTemplateDocFor, constructParsedCustomElement, appendedAttributeSteps,
  parserInsertionSteps
});
const { parseXmlInto, parseXmlFragment: buildXmlFragment } = installXmlParser({ inertTemplateDocFor, builtSteps });
// `parseFragment(html, contextEl, declarative, registryOf)` — HTML fragment parsing in the context element's insertion mode (table / select /
// raw-text / foreign content, …), its elements of `registryOf`'s registry (the context's, a shadow root's for its host's
// context). Callers thread the spec fragment context.
function parseFragment(html, context, declarative, registryOf = context) {
  return fragmentImagesUpdated(html, parseHtmlFragment(html, context, declarative, registryOf));
}
// …and the images a fragment parse made updated: the spec's parse builds them in a document of its own, and their
// adoption into the context's — fully active, or not — is a relevant mutation ("update the image data"): an innerHTML
// `<img src=x onerror=…>` fires its `error`. (…none sought in markup that names no image element)
function fragmentImagesUpdated(markup, nodes) {
  if (nodes && IMAGE_MARKUP.test(markup)) for (const n of nodes) updateImagesIn(n);
  return nodes;
}
// (…an XML fragment's element may be written with a prefix: `<h:img xmlns:h="…xhtml">`)
const IMAGE_MARKUP = /<(?:[^\s/>:]+:)?(?:img|image|input)[\s/>]/i;

// In an XML/XHTML document, `innerHTML` / `outerHTML` setting and
// `insertAdjacentHTML` parse markup with the XML fragment parsing algorithm (in
// `context`'s namespace scope) rather than the HTML parser. A not-well-formed
// fragment is a SyntaxError DOMException (and nothing is inserted), per spec.
function parseXmlFragment(html, context, registryOf = context) {
  const nodes = fragmentImagesUpdated(html, buildXmlFragment(html, context));
  if (nodes === null) {
    throw new DOMException("The given markup is invalid XML, and therefore cannot be inserted into an XML document.", 'SyntaxError');
  }
  // Fragment-parsed elements inherit the CONTEXT's registry association (the
  // HTML path does this in the tree builder via curRegistry) — a scoped or
  // sticky-null context marks its parsed children.
  const ctxReg = registryOf && ceRegistryOf(registryOf);
  if (ctxReg !== undefined) for (const n of nodes) restampRegistries(n, REGISTRY_UNSET, ctxReg, true);
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
  createHtmlPageDocument,
  parseHtmlDocument,
  parseHtmlIntoLive,
  writeScriptCreated,
  closeScriptCreated,
  parseFragment,
  parseXmlInto
};

// What a host thread's image result comes to as it arrives (subresource_obtain.rs `imageArrive`, image_requests.rs
// `apply_record`): nothing (a later load superseded it), its `load`, its `error`.
const IMAGE_APPLIED_NONE = 0, IMAGE_APPLIED_ERROR = 2;

// The object of a node the engine made (node_handle.rs `object_of`), of its interface: an element as
// `createElementNode` makes one, character data (a processing instruction's target its local name) and a fragment as
// their constructors do — each bound to the node's slot as it is made
// (`makingObjectOf`), none of its own made. Undefined for a kind the engine makes none of.
function engineNodeObject(nid, nodeType, localName, ns, prefix) {
  makingObjectOf(nid);
  try {
    switch (nodeType) {
      case NODE_ELEMENT: return createElementNode(localName, ns === '' ? null : ns, localName, prefix);
      case NODE_TEXT: return new Text();
      case NODE_CDATA: return new CDATASection(PLATFORM);
      case NODE_COMMENT: return new Comment();
      case NODE_PI: return new ProcessingInstruction(PLATFORM, localName);
      case NODE_FRAGMENT: return new DocumentFragment();
      case NODE_DOCTYPE: return new DocumentType(PLATFORM);
      default: return undefined;
    }
  } finally {
    makingObjectOf(-1);
  }
}
NATIVE_REALM.nodeObject = engineNodeObject;
// A shadow root's `setHTMLUnsafe` (ShadowRoot's members), by its own realm as an element's markup setters are.
function setShadowRootHTML(root, html) {
  const realm = makingRealmOf(root);
  if (realm !== null) return inRealm(realm, 'setShadowRootHTML', root, html);
  changeChildren(root, ALL_CHILDREN, parseFragment(html, hostOf(root), true, root), null, true);
}
// …and what another realm's code asks this one to make for a node this realm's code made (`makingRealmOf`).
NATIVE_REALM.nodeMadeFor = (doc, name, a, b) => constructedFor(doc, { Text, Comment, CDATASection, DocumentFragment }[name], a, b);
NATIVE_REALM.newShadowRoot = () => new ShadowRoot(SHADOW_ROOT_INTERNAL);
NATIVE_REALM.newAttr = (localName, ns, prefix, value) => new Attr(PLATFORM, localName, ns, prefix, value, null);
Object.assign(NATIVE_REALM, {
  cloneNode, importNode, createElementIn, clickElement, setInnerHTML, setElementHTML, setOuterHTML, insertAdjacentHTML,
  setShadowRootHTML, createContextualFragment
});

// The document a window keeps loading the next one of its origin into (v8_runtime.rb `reuse_window_realm`) left as a
// new Document is: the listeners and handlers on it and its nodes erased, the observers registered on them let go of,
// its origin a new one (no `document.domain` written to it: realm_location.rs `renew_origin`), its adopted sheets, its
// fonts and its selection's range none, its design mode off, visible (the unload of the initial one hid that), its
// initial about:blank one no more, its sockets and event sources closed — what a new Document object would not have of
// the old (its expandos, and its skeleton elements' — the parse keeps them — stay: the gap CLAUDE.md lists).
hostSteps.renewDocument = function () {
  const doc = globalThis.document;
  dom.renewOrigin();
  for (const node of listOf(dom.listenedIn(nidOf(doc)))) if (node) eraseListenersAndHandlers(node);
  dom.moForgetTargetsIn(nidOf(doc));
  setAdoptedStyleSheets(doc, []);
  doc.fonts.clear();
  globalThis.getSelection()?.removeAllRanges();
  setStateBit(doc, STATE_DESIGN_MODE, false);
  setStateBit(doc, STATE_HIDDEN, false);
  setStateBit(doc, STATE_INITIAL_ABOUT_BLANK, false);
  dom.webauthnForgetRequest();
  // (…and what HTML's unloading document cleanup steps make disappear: its WebSockets, its EventSources)
  globalThis.__csimDropWebSockets?.();
  globalThis.__csimDropEventSources?.();
};
