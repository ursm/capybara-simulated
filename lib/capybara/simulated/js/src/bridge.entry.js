// The DOM lives entirely in V8. No __dom callbacks. Capybara's Ruby
// side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.

import {
  IntrinsicDate,
  assertInterfacesRegistered,
  brandKey,
  ceEnter,
  ceLeave,
  jsonStringify,
  platformMicrotask,
  scriptOnStack,
  slotsOf
} from './webidl.js';
import { selectFirst } from './selectors.js';
import { INTERFACES_TAKEN, LEGACY_WINDOW_ALIASES } from './generated/bindings.js';
import './url-parse.js';   // defines globalThis.__csim_parseUrl before location.js's load-time use
import { installEngineAnimations } from './web-animations-engine.js';
import './css-animation-events.js';    // registers the rendering update's animation events
import { NODE_ELEMENT, isHtml, J_LINK, J_MODULE_SCRIPT, LINK_LEGACY, LINK_LOAD, LINK_PENDING, PLUGIN_FAILED, PLUGIN_FALLBACK_CHANGED, PLUGIN_FOUND } from './constants.js';
import {
  isConnected, isScriptElement, scriptFlag, scriptTypeOf, SCRIPT_FROM_EXTERNAL_FILE, SCRIPT_NOT_FORCE_ASYNC, SCRIPT_IMPORT_MAP, PREPARE_NONE, PREPARE_ERROR, PREPARE_MODULE,
  PREPARE_IMPORT_MAP, BY_SCRIPT, BY_PARSER, BY_PARSER_LIST
} from './walk.js';
import { clearEdges } from './tree.js';
import { queueTask } from './timers.js';
import {
  connectWalkBegin, connectWalkEnd, docToken, focusRealm, frameRealmOf, handleOf, lookup,
  requestAsItBegins, requestPlanOf, setDocToken, subtreeRemoved
} from './handles.js';
import { isObscured, rectOf, pointerRectOf, applyScrollTo, applyScrollBy, frameContentBox, frameObscuredAt, invalidateLayout, ensureInView, hitTest, isFlatAncestor, caretFromPoint, forgetCaretMove, flushCssImages } from './layout.js';
import { dragBegin, dragMove, dragFinish } from './drag.js';
import { dispatchEvent, dispatchEventForUserAction, fireEvent, firePointerStep } from './dispatch.js';
import { contenteditableHost } from './form-helpers.js';
import { clientId as swClientIdOf, controllerHandle, enableClientMessageQueue, serviceWorkerFor } from './sw-client.js';
import { ceState, ceTryConnect, runSelectednessAlgorithm, ensureOptionSelInit, connectSelectedContent, ownerSelectOf, updateSelectedContent, finalizeSelectOptions } from './custom-elements.js';
import { SELECT_HAS_SELECTED_CONTENT, EVER_CONNECTED, STYLE_LOAD_FIRED, elementFlag, setElementFlag } from './element-flags.js';
import {
  rebuildCascade,
  markCascadeStale,
  resetCascadeState,
  isVisibleNode,
  styleElementIsCss,
  styleEngineInnerText,
  styleEnginePressFocusTarget,
  styleEngineVisibleText
} from './cascade.js';
import {
  Event,
  CustomEvent,
  UIEvent,
  MouseEvent,
  PointerEvent,
  pointerEventInit,
  trustedPointerMove,
  DragEvent,
  KeyboardEvent,
  InputEvent,
  SubmitEvent,
  MessageEvent,
  ClipboardEvent,
  FocusEvent,
  WheelEvent,
  Touch,
  TouchListInterface,
  TouchEvent,
  CompositionEvent,
  TextEvent,
  DeviceMotionEvent,
  DeviceOrientationEvent,
  ProgressEvent,
  PopStateEvent,
  HashChangeEvent,
  StorageEvent,
  ErrorEvent,
  PromiseRejectionEvent,
  CloseEvent,
  PageTransitionEvent,
  ToggleEvent,
  CommandEvent,
  MediaQueryListEvent,
  IDBVersionChangeEvent,
  FontFaceSetLoadEvent,
  DeviceMotionEventAccelerationInterface,
  DeviceMotionEventRotationRateInterface,
  AnimationEvent,
  AnimationPlaybackEvent,
  TransitionEvent,
  FormDataEvent,
  BeforeUnloadEvent,
  GamepadEvent,
  EventTarget,
  eventState
} from './events.js';
import { deliverMutations, flushMutationDelivery, hasQueuedRecords, hasObservers, engineWritten, noteParsedChange } from './mutation-observer.js';
import { Blob, File, hostBackedFile, resolveBlobBytes }  from './blob.js';
import { setCrossOriginIsolated, thrownDetail } from './platform-globals.js';
import { captureSecureContextHolders, exposeSecureContextConstructs } from './secure-context.js';
import { TextEncoder } from './encoding.js';
import './streams.js';                 // WHATWG Streams globals + TextDecoder/EncoderStream
import { logError, logThrew }                    from './console.js';
import { installDomClassAliases }      from './dom-class-aliases.js';
import './xpath.js';
import { contentTypeEssence } from './mime.js';
import { registerImportMap, moduleIntegrity } from './esm-loader.js';
import {
  Node,
  Text,
  Element,
  Document,
  createHtmlPageDocument,
  parseHtmlIntoLive,
  writeScriptCreated,
  closeScriptCreated,
  parseXmlInto,
  readinessChanged
} from './dom-nodes.js';
import {
  FN_BUILD_QUEUED, FN_BUILDING, FN_COMMIT_PENDING, FN_CONTEXT_READY, FN_DEFERRED_SW, FN_LOAD_IN_PROGRESS, FN_LOAD_OWED, FN_PROMPT_OWED,
  FN_URL_RELOAD, FN_URL_SRC, FC_LOADED, FC_NAV, FC_PENDING_BLOB, copyFrameContent,
  frameContent, frameContentUrl, frameNavHas, frameNavigationFinalized, setFrameContent,
  setFrameNav, setFrameNavUrl
} from './frame-nav.js';
import { documentBaseURL, documentEncoding, resolveURLValue } from './base-url.js';
import { parseURL } from './url-parse.js';

// Side-effect modules — globalThis wirings.
import './abort.js';
import './canvas.js';
// Side-effect import: installs `__csimScreenshot`, the paint entry `save_screenshot` calls.
import './paint.js';
import { runSourceInsertionStep } from './media.js';
import './dialogs.js';
import { dialogOpened } from './dialog.js';
import './encoding.js';
import './event-source.js';
import './websocket.js';
import './fetch.js';
import './cache-storage.js';   // CacheStorage/Cache (globalThis.caches) — depends on fetch.js's Request/Response
import './file-reader.js';
import './form-fields.js';    // the host's form entry points: `__csimFormSerialize`, …
import './broadcast-channel.js';
import './history.js';
import './host-queries.js';
import './idb.js';
import {
  CONNECT_CUSTOM, CONNECT_DEFAULT_STYLE, CONNECT_DIALOG, CONNECT_FRAME, CONNECT_LINK, CONNECT_MEDIA, CONNECT_META_REFERRER, CONNECT_NONCE,
  CONNECT_OPTION, CONNECT_REFRESH, CONNECT_SCRIPT, CONNECT_SELECT, CONNECT_SELECTEDCONTENT, CONNECT_SOURCE, CONNECT_STYLE, CONNECT_USE,
  LINK_MODULEPRELOAD, LINK_PRELOAD, LINK_STYLESHEET, RELATIVE_ROOT, SHADOW_DECLARATIVE, STATE_INITIAL_ABOUT_BLANK,
  childTextContent, connectionStepElementsIn, connectionStepsOf, invalidateArena, linkTypesOf, relativeOf,
  setScrollOffset, setStateBit, shadowIs
} from './native-query-shadow.js';
import { syncTargetFragment } from './target.js';
import './navigator.js';
import './webauthn.js';
import './observers.js';
import './geometry.js';
import { DataTransfer, beginDndEvent, dragOperation, endDndEvent, setDataTransferMode, setEffectAllowed } from './data-transfer.js';
import { installWindowInterface, prepareWindowInterface } from './window.js';
import './worker-globals.js';
import './selection.js';
import './style-proxy.js';
import './cssom.js';
import './tz-override.js';
import './unhandled-rejection.js';
import './url.js';
import './url-pattern.js';
import './headers.js';
import './window-events.js';
import './workers.js';
import './xhr.js';
import { bodyOf, documentElementOf } from './document-tree.js';
import { DOMException, QuotaExceededError } from './dom-exception.js';
import { subresourceHost } from './subresource-host.js';
import { setObtainHost } from './obtain-host.js';
import { realmURL } from './document-origin.js';
import { attrsOf, holdRealmDocument, localNameOf, nidOf, nodeTypeOf, tagOf } from './node-identity.js';

// The host steps of the engine's own fetches (subresource-host.js), for the modules that cannot import them: the
// rendering update's CSS images (layout.js), a face's sources (font-metrics.js).
setObtainHost(subresourceHost);

// The Window's other names for interface objects ([LegacyWindowAlias]): DOMMatrix's SVGMatrix and WebKitCSSMatrix,
// DOMPoint's SVGPoint, DOMRect's SVGRect, URL's webkitURL — the same objects (a worker's scope drops them, workers.js).
// Chrome 154 and Firefox 157 keep SVGPoint / SVGRect / SVGMatrix interfaces of their own (measured); the Geometry
// Interfaces' aliases are the spec's.
// (…an interface no implementation here answers has none: its alias would be undefined)
for (const [name, aliases] of Object.entries(LEGACY_WINDOW_ALIASES)) {
  if (globalThis[name] === undefined) continue;
  for (const alias of aliases) Object.defineProperty(globalThis, alias, { value: globalThis[name], writable: true, enumerable: false, configurable: true });
}

// The cascade asks layout.js whether an element is a fieldset's rendered legend — a question about boxes. Handed over
// here, where both modules have been evaluated: the bundle evaluates layout.js FIRST, so a setter it called at its own
// init was undone when cascade.js's hook variable was initialised after it.

(function () {
  'use strict';

  // ── Event class + dispatch walk ─────────────────────────────────
  //
  // Capture / target / bubble per DOM4.

  // DOM event constructors live in `events.js`. Expose under the same
  // global names apps and framework code reach for.
  Object.assign(globalThis, {
    Event,
    DOMException,
    QuotaExceededError,
    CustomEvent,
    MouseEvent,
    KeyboardEvent,
    InputEvent,
    SubmitEvent,
    UIEvent,
    PointerEvent,
    DragEvent,
    FocusEvent,
    WheelEvent,
    Touch,
    TouchList: TouchListInterface,
    TouchEvent,
    CompositionEvent,
    TextEvent,
    DeviceMotionEvent,
    DeviceOrientationEvent,
    ProgressEvent,
    PopStateEvent,
    HashChangeEvent,
    PageTransitionEvent,
    ToggleEvent,
    CommandEvent,
    StorageEvent,
    ErrorEvent,
    PromiseRejectionEvent,
    CloseEvent,
    AnimationEvent,
    AnimationPlaybackEvent,
    TransitionEvent,
    FormDataEvent,
    BeforeUnloadEvent,
    GamepadEvent,
    MediaQueryListEvent,
    IDBVersionChangeEvent,
    FontFaceSetLoadEvent,
    DeviceMotionEventAcceleration: DeviceMotionEventAccelerationInterface,
    DeviceMotionEventRotationRate: DeviceMotionEventRotationRateInterface
  });
  // (…and the realm's own DOMException where another realm's code throws one into it — a property a page can neither
  // assign nor redefine, as it can `DOMException`)
  Object.defineProperty(globalThis, '__csimDOMException', { value: DOMException });
  // The style engine answers computed style — and runs the page's animations, whose constructors a page feature-probes
  // before using `animate()` — in every document realm: the runtime installs it there after this bundle has run. A
  // worker has neither (the Web Animations interfaces are `[Exposed=Window]`).
  globalThis.__csimEnableStylo = () => {
    globalThis.__csimStylo = true;
    installEngineAnimations();
  };

  // Mouse-event types need MouseEvent so click-handler readers see
  // `.button` / `.shiftKey` / `.ctrlKey` / `.altKey` / `.metaKey`
  // alongside the bubbling flags. Falls back to Event for keyboard /
  // generic events.
  const MOUSE_EVENT_TYPES = new Set([
    'click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout',
    'mouseenter', 'mouseleave', 'mousemove', 'contextmenu'
  ]);
  // Trusted dispatch for the testdriver shim: WebDriver input injection is a
  // user-agent action, dispatched as the driver's own user actions are — trusted,
  // a UI event's view the window — with the UA's steps that follow a user's press
  // (a dialog's light dismiss) — but called from the test's script, still on the stack, so with no microtask
  // checkpoint between its listeners (dispatch.js's head).
  globalThis.__csimDispatchTrusted = dispatchEventForUserAction;

  globalThis.__csimDispatchEvent = function (h, type, init) {
    const n = lookup(h);
    if (!n) return false;
    const typeStr = String(type);
    const ctor = MOUSE_EVENT_TYPES.has(typeStr) ? MouseEvent : Event;
    // Capybara's `.trigger("click")` is a synthetic-but-real click; in
    // real browsers it bubbles and is cancellable, which is what makes
    // Turbo Drive's window-capture LinkClickObserver intercept the
    // navigation. Empty init turns it into a non-bubbling event that
    // never reaches window-level listeners; default bubbles+cancelable
    // to `true` so the dispatch matches a user click.
    const merged = { __proto__: null, bubbles: true, cancelable: true, ...init };
    return dispatchEvent(n, new ctor(typeStr, merged));
  };

  // `globalThis.HTMLElement` (a real `class extends Element` with a
  // namespace-keyed `instanceof`) is installed by `installDomClassAliases`;
  // user classes do `class MyThing extends HTMLElement`, whose `super()`
  // reaches its constructor, which makes the element by `Element`'s. CE lifecycle (registry,
  // upgradeElement, connect/disconnect hooks, attributeChangedCallback,
  // "ask for a reset" on `<option>` insert into single-select) lives
  // in `custom-elements.js`. Script-and-link side effects of CE
  // connect stay inline (closure state).
  globalThis.__csimFireCEConnect = fireCEConnect;
  // Connection steps for ONE element — each element of a connected subtree that has one, as the engine names them
  // (connection_steps.rs `has_connection_step`: a step added here for an element it does not name never runs — add
  // its tag or its condition there too). Selects encountered are pushed to `selects` so the caller can run
  // the selectedness algorithm once every descendant option is initialised.
  // Shared by fireCEConnect (whole-subtree walk) and drainStreamConnect (the
  // streaming parser's incremental connect cursor) so both connect / upgrade /
  // fire-load identically — exactly once per element.
  // HTML's embed setup steps and object processing model — run as the element connects and as its `src` / `data` /
  // `type` change — the engine's (subresource_obtain.rs `processPlugin`: its resource fetched, its natural size, an
  // `<object>`'s fallback content shown or no longer), and its element's `load` fired once it is in — an `<object>`'s
  // `error` instead for a network response that is no ok one.
  // (…an `<object>` showing its fallback content or no longer — none to show, or one that failed — its plugins among its
  // descendants processed again, in one tree-order pass whose each reads what those above it set, but as it connects,
  // when the connect walk reaches them after it: they are its fallback content again, or no longer)
  function processPluginElement(el, connecting = false) {
    const done = globalThis.__dom.processPlugin(nidOf(el), nidOf(el._ownerDocument), subresourceHost);
    if ((done & PLUGIN_FALLBACK_CHANGED) && !connecting) {
      for (const d of connectionStepElementsIn(el)) {
        if (d !== el && (connectionStepsOf(d) & CONNECT_MEDIA)) processPluginElement(d, true);
      }
    }
    if (done & PLUGIN_FOUND) subresourceLoadTask(el, () => { if (isConnected(el)) fireEvent(el, new Event(done & PLUGIN_FAILED ? 'error' : 'load')); });
  }
  globalThis.__csimProcessPlugin = processPluginElement;
  // An element's connection steps — those the engine says connecting it runs (connection_steps.rs `CONNECT_*`), in
  // the order below.
  // (…what connecting an option asks of its select: `__dom.optionConnecting`, validity.rs `OPTION_*`)
  const OPTION_RUN = 1, OPTION_PER_OPTION = 1 << 1;
  function connectOneElement(el, selects, perOptionSelects, parsed = false) {
    const steps = connectionStepsOf(el);
    if (steps === 0) return;
    // HTML option selectedness: initialise from the authored `selected`
    // content attribute exactly once (parse-time default), unless the
    // IDL setter already dirtied it. After this the attribute-change
    // steps + the select algorithm maintain it. See custom-elements.js.
    if (steps & CONNECT_OPTION) {
      ensureOptionSelInit(el);
      // (…and what its insertion asks of its select: validity.rs `option_connecting` — its selectedness run now, where
      // it mirrors its selection into a `<selectedcontent>`, so a trailing sibling `<script>` observes the update and the
      // records interleave in tree order, or where an earlier batch connected it, a drain the parser made among its
      // options; and one that reconciles per option left out of the batch below, whose run would emit a redundant
      // remove + add of identical content. The run passes `null`, not the connecting option, so several authored
      // `selected` options resolve to the LAST in tree order, as the batch's does.)
      const asked = globalThis.__dom.optionConnecting(nidOf(el), parsed);
      if (asked) {
        const [select, how] = asked;
        if (how & OPTION_RUN) runSelectednessAlgorithm(select, null);
        if (how & OPTION_PER_OPTION) perOptionSelects.add(select);
      }
    }
    if (steps & CONNECT_SELECT) selects.push(el);
    // An open dialog connected goes back on its document's open dialogs list, which its removing steps took it off.
    if (steps & CONNECT_DIALOG) dialogOpened(el);
    if (steps & CONNECT_SELECTEDCONTENT) {
      // A <selectedcontent>'s post-connection step: mirror the owning select's
      // current selection into it now (document-order during the connect walk).
      // updateSelectedContent is idempotent during a streaming parse, so a drain that
      // re-runs this after the parser hooks already mirrored the selection adds no
      // record; a real (post-parse) connect/move re-clones with records.
      connectSelectedContent(el);
    }
    // A video's poster, a media element's tracks and an SVG `<use>`'s external document are fetched when it is
    // connected — the driver does not render them, but a browser files their Resource Timing entries, which
    // perf-monitoring reads — and a plugin element's resource is processed.
    if (steps & (CONNECT_MEDIA | CONNECT_USE)) globalThis.__dom.fetchTimedResources(nidOf(el), nidOf(el._ownerDocument), subresourceHost);
    if (steps & CONNECT_MEDIA) processPluginElement(el, true);
    // (…a `<meta http-equiv=refresh>` inserted into this document — its tree, not a shadow tree in it — its content
    // given and not empty: HTML's refresh pragma)
    if ((steps & CONNECT_REFRESH) && relativeOf(el, RELATIVE_ROOT) === globalThis.document) {
      const content = el._getAttribute('content');
      if (content) declarativeRefresh(content, true);
    }
    // Dynamically-inserted <script> elements should evaluate when
    // they become part of the document. Rails-UJS's `dataType:
    // 'script'` AJAX path creates a `<script>` with `.text = response`
    // and appends to head; without this hook the response never runs
    // and AJAX flows that depend on it (Redmine's show_api_key.js.erb
    // toggling visibility) silently no-op. Only do this *after* the
    // initial page-load script pass completes — otherwise the
    // initial pass would double-eval scripts that appendChild
    // surfaced via fireCEConnect during the page-build phase. During a
    // streaming parse __inHTMLGrafting is also true, so the parser's own
    // <script>s run at their `</script>` (`__streamHooks.onScript`), not here.
    // (An earlier script in this same insertion batch may have removed a later one before the walk reaches it — a
    // disconnected script, which the preparation leaves alone: later-script-removed-by-earlier-script.)
    if ((steps & CONNECT_SCRIPT) && !__inHTMLGrafting) maybeRunScript(el);
    // Vite's preload-helper appends `<link rel="stylesheet">` for
    // CSS deps in a chunk's dependency list and awaits the link's
    // `load` event before resolving the chunk's dynamic-import
    // chain. Real browsers fire `load` once the stylesheet is
    // fetched and parsed; without this hook the lazy MediaContainer
    // / public.tsx `[data-component]` portal mount stalls forever.
    // `rel="modulepreload"` / `rel="preload"` get the same treatment
    // — the helper waits on them with the same pattern.
    // (…its fetch made under the policy its document has as it is inserted: `requestPlanOf` — a parsed one's noted as
    // the parser inserted it, before the cascade fetched its sheet: `takeParsedSheets`)
    if (steps & CONNECT_LINK) {
      if (!__inHTMLGrafting || globalThis.__dom.requestPolicy(nidOf(el)) === undefined) globalThis.__dom.noteRequestPolicy(nidOf(el));
      maybeFireLinkLoad(el);
    }
    // A connected CSS `<style>` fires `load` once its sheet is ready (an @import block is
    // trickle-delayed until the import is fetched + applied; a plain block fires async).
    if (steps & CONNECT_STYLE) maybeFireStyleLoad(el);
    // A <source> connecting under a media element runs its insertion step (sets
    // the media's networkState). Covers single appendChild / parser / innerHTML
    // inserts; the fragment path already ran it during parenting (idempotent —
    // gated on NETWORK_EMPTY), so this is a no-op there.
    if (steps & CONNECT_SOURCE) runSourceInsertionStep(el, el._parent);
    if (steps & CONNECT_FRAME) {
      // The frame's post-insertion step: its browsing context now exists, so
      // contentWindow becomes non-null. Set in this tree-order connect walk so a
      // script connected later in the same batch observes it (and one connected
      // earlier does not). See the contentWindow getter.
      setFrameNav(el, FN_CONTEXT_READY, true);
      // (…and its attributes processed, which navigate it nowhere where its `src` is a document above it:
      // frame_navigation.rs `process_src` — no build, no `load`, and none of a `src` given it while in no document)
      if (globalThis.__dom.processFrameSrc(nidOf(el))) setFrameNavUrl(el, FN_URL_SRC, undefined);
      else maybeFireFrameLoad(el, true);
    }
    // `<meta http-equiv=default-style>` selects a stylesheet set (enabling its
    // titled alternate sheets). Its post-insertion step rebuilds the cascade
    // SYNCHRONOUSLY — running here in the tree-order connect walk, a script
    // connected later in the same batch observes the new style, one connected
    // earlier does not (the WPT default-style-meta-from-fragment ordering). An
    // ordinary <style>/<link> insert only marks the cascade stale, which the
    // next read of style hands the engine (sheet_feed.rs `fresh`).
    if (steps & CONNECT_DEFAULT_STYLE) rebuildCascade();
    // `<meta name="referrer">` sets its document's referrer policy as it is connected — in this walk, so a script
    // connected before it in the same batch fetches under the policy it had (the engine's: url_ops.rs
    // `meta_referrer_steps`).
    if (steps & CONNECT_META_REFERRER) globalThis.__dom.metaReferrerSteps(nidOf(el));
    // HTML "nonce" hiding: once an element with a nonce content attribute is
    // connected, its nonce is kept and the content attribute emptied so it can't
    // be exfiltrated via a CSS attribute selector — the engine's (nonce.rs). An
    // atomic move (moveBefore) skips connection steps, so it preserves the
    // attribute; insertBefore / appendChild (which connect) clear it.
    if (steps & CONNECT_NONCE) globalThis.__dom.hideNonce(el);
    if (steps & CONNECT_CUSTOM) ceTryConnect(el);
  }
  function fireCEConnect(subtree) {
    // Selects whose options were (re)connected in this batch — their
    // selectedness setting algorithm runs once after the walk, when every
    // descendant option's selectedness has been initialised (the walk is
    // pre-order, so a select is visited before its options).
    const connectedSelects = [];
    const perOptionSelects = new Set();
    // Track connect-walk nesting so a frame's contentWindow reports null until
    // its own (tree-order) connect step runs — see the contentWindow getter.
    connectWalkBegin();
    try {
      // The shadow-including subtree (not the light tree alone) so a connected host's shadow tree
      // connects too — a shadow-tree <script> prepares/executes and shadow CEs
      // upgrade + fire connectedCallback. `fireCEDisconnect` / `fireCEMoveReactions`
      // use the same shadow-aware order, so the lifecycle stays balanced. Only the elements with a step of their own
      // are visited: the engine names them (`connectionStepElementsIn`), and a plain `<div>` has none.
      for (const el of connectionStepElementsIn(subtree)) connectOneElement(el, connectedSelects, perOptionSelects);
    } finally {
      connectWalkEnd();
    }
    settleConnectedSelects(connectedSelects, perOptionSelects);
  }
  // The selects a connect batch (re)connected options of (`connectedSelects`), once every option's selectedness is
  // initialised: the single-select implicit default materialised (and multiple authored `selected` options deduped) —
  // but where `<selectedcontent>` reconciled them per option already (`perOptionSelects`).
  function settleConnectedSelects(connectedSelects, perOptionSelects) {
    for (const sel of connectedSelects) {
      if (!perOptionSelects.has(sel)) runSelectednessAlgorithm(sel, null);
      // A RE-connected customizable select (moved / re-inserted) re-clones its
      // selectedcontent per spec — a tree mutation replaces the children with fresh
      // clones even when the serialized content is unchanged (selectedcontent-
      // mutations test8). First connection (parse build) reconciles idempotently.
      if (elementFlag(sel, SELECT_HAS_SELECTED_CONTENT) && elementFlag(sel, EVER_CONNECTED)) updateSelectedContent(sel, true);
      setElementFlag(sel, EVER_CONNECTED, true);
    }
  }
  // Streaming parser connect cursor: the tree builder collects each appended
  // element into `__streamPendingConnect`; before every parser-blocking script
  // runs (and once at end-of-parse) we connect/upgrade exactly the elements
  // appended since the last drain — O(total nodes) across the parse, never the
  // O(N²) of re-walking the whole document per script. The list is in document
  // (append) order, so connectedCallback fires in tree order.
  let __streamPendingConnect = null;
  function drainStreamConnect() {
    const pending = __streamPendingConnect;
    if (!pending || !pending.length) return;
    // Snapshot + clear first: connecting an element can append more (a CE
    // connectedCallback), which must queue onto a fresh cursor, not this batch.
    __streamPendingConnect = [];
    const connectedSelects = [];
    const perOptionSelects = new Set();
    // Same connect-walk-depth tracking as fireCEConnect: a parser-blocking
    // <script> draining here must see a not-yet-connected later frame as null.
    connectWalkBegin();
    // (…the elements' custom element reactions run as the batch ends, as the parser's insertion of each runs its own
    // as it ends: HTML "insert an element at the adjusted insertion location", an element queue pushed around it)
    const ce = ceEnter();
    ceState.parsing++;
    try {
      for (let i = 0; i < pending.length; i++) {
        const el = pending[i];
        connectOneElement(el, connectedSelects, perOptionSelects, true);
        // …and its SHADOW tree. The parser queues each node it inserts, so a tree it builds needs
        // no descent here — but a custom element's constructor runs at its START TAG, which is
        // where `attachShadow` usually happens, and the parser queues none of the shadow tree the
        // constructor builds. Left alone, that tree was never connected at all: a nested custom
        // element inside it stayed un-upgraded for the life of the page (`::part` forwarding
        // tests, where an outer element's template holds an inner one), and a shadow `<script>`
        // never ran. `fireCEConnect` has always used the shadow-including walk for exactly this;
        // this is the parser's incremental cursor agreeing with it. (A declarative shadow root's
        // tree is the parser's, queued node by node: walked here too, its custom elements were
        // connected twice.)
        if (el._shadowRoot && !shadowIs(el._shadowRoot, SHADOW_DECLARATIVE)) {
          for (const m of connectionStepElementsIn(el._shadowRoot)) connectOneElement(m, connectedSelects, perOptionSelects, true);
        }
      }
    } finally {
      ceState.parsing--;
      connectWalkEnd();
      ceLeave(ce);
    }
    settleConnectedSelects(connectedSelects, perOptionSelects);
  }
  // Connect + upgrade everything the parser appended up to here (grafting still on), where a stylesheet came in since the
  // cascade made fresh first — before a script, now; before a custom element's connect, at the first read that asks (a
  // page of `<style>`s between custom elements rebuilt it once per element) — with the markup-insertion counter held, as
  // for a constructor the parser runs at a start tag: an upgrade's `document.write` throws (Chrome), where it wrote at
  // the insertion point of a script about to run.
  function connectParsed(beforeScript) {
    takeParsedSheets(beforeScript);
    const doc = globalThis.document;
    doc._markupInsertionCounter = (doc._markupInsertionCounter || 0) + 1;
    try { drainStreamConnect(); } finally { doc._markupInsertionCounter--; }
  }
  // …the cascade made fresh for the style sheets that came in, or marked stale.
  function takeParsedSheets(beforeScript) {
    // (…a sheet marked stale before a script: a frame's or a write's connection took it, with no fetch of it made: it blocks
    // that script all the same, HTML "has no style sheet that is blocking scripts", and the script's timers come after it)
    if (!__streamCascadeDirty) {
      if (beforeScript && __streamSheetsStale) {
        __streamSheetsStale = false;
        try { rebuildCascade(); } catch (_) {}
      }
      noteSheetWait(beforeScript);
      return;
    }
    __streamCascadeDirty = false;
    // (…each under the referrer policy its document had as the parser inserted it — a `<meta name="referrer">` parsed
    // before it setting it, one after it none of its: their connection steps taken now, in the order the parser inserted
    // them, which the connect walk below takes again)
    for (const el of __streamPendingConnect || []) {
      if (localNameOf(el) === 'meta') globalThis.__dom.metaReferrerSteps(nidOf(el));
      else if (localNameOf(el) === 'link') {
        globalThis.__dom.noteRequestPolicy(nidOf(el));
        __streamSheetFetched ||= (linkTypesOf(attrsOf(el).rel) & LINK_STYLESHEET) !== 0;
      }
    }
    __streamSheetsStale = !beforeScript;
    if (!beforeScript) markCascadeStale();
    else try { rebuildCascade(); } catch (_) {}
    noteSheetWait(beforeScript);
  }
  // …and one fetched that blocks the script about to run has the parser wait on it (`landAsyncScripts`).
  function noteSheetWait(beforeScript) {
    if (!beforeScript || !__streamSheetFetched) return;
    __streamSheetFetched = false;
    globalThis.__dom.parserWaitsOnFetch();
  }
  // Streaming-parse hooks handed to `parseHtmlIntoLive`: what the engine's build of each batch of the page (html_parse.rs
  // `htmlRunBuilt`) leaves the page's own steps — the elements it inserted connected and upgraded incrementally, the
  // customizable selects mirrored as their options go in, and each parser-blocking <script> run inline at its
  // `</script>` against the partial, connected tree.
  let __streamCascadeDirty = false, __streamSheetsStale = false, __streamSheetFetched = false;
  const __streamHooks = {
    // A custom element the engine constructed went in, its batch built that far (html-tree-builder.js `nextBatch`): it,
    // and what came before it, connected now — its connectedCallback before the next start tag's constructor, as the
    // parser's insertion of it pops the element queue it pushed (Chrome).
    onCustomElementInserted() {
      connectParsed();
    },
    // A frame container the engine's build paused at (html_parse.rs `Pause::Frame`), and what came before it, connected
    // now: its post-connection steps — a load fired at once where it navigates to about:blank — before the parser goes
    // on, seeing none of what follows it (Chrome). No constructor runs here, so `document.write` from that load is no
    // markup insertion the counter refuses: it opens the document, as Chrome's does.
    onFrameInserted() {
      takeParsedSheets(false);
      drainStreamConnect();
    },
    // A `document.write` from a script the parser is running parsed what it wrote up to the insertion point
    // (html-tree-builder.js `writeAtScript`): that, and what came before it, connected before `write`
    // returns, with the markup-insertion counter held as for a constructor.
    onWritten() {
      connectParsed(false);
    },
    // A customizable select's node the engine's build paused at (html_parse.rs `select_node`), its childList record
    // queued already: a `<selectedcontent>` inserted makes its select one, which keeps mirroring its selection from then
    // on — eagerly, as the connect walk's `connectSelectedContent` only runs at the next drain — and it or an option
    // inserted re-runs the selectedness algorithm: a just-inserted selected option supersedes the previous selection,
    // clearing the selectedcontent (the option's content fills in at its end tag), and a selectedcontent after its
    // options mirrors the selected one (option-before-selectedcontent) — but one before any option keeps its authored
    // content until the selected option is parsed. An option closed — its content complete — is mirrored if it is the
    // selected one. A `<select multiple>`, with no implicit selection to track, reconciles ONCE as it closes, replacing
    // the authored content (selectedcontent-mutations test6). All idempotent, so the later drain's are no-ops.
    onSelectNode(node, popped) {
      const sel = ownerSelectOf(node);
      if (!sel) return;
      if (isHtml(node, 'selectedcontent')) setElementFlag(sel, SELECT_HAS_SELECTED_CONTENT, true);
      const multiple = attrsOf(sel).multiple != null;
      if (!popped) {
        if (!multiple && (isHtml(node, 'option') || selectFirst(sel, 'option'))) runSelectednessAlgorithm(sel, null);
      } else if (isHtml(node, 'option')) {
        if (!multiple) updateSelectedContent(sel);
      } else if (multiple) {
        finalizeSelectOptions(node);
      }
    },
    // …and what a batch the engine built feeds the stream: its elements with a connection step, queued for the
    // connect cursor, whether a style sheet's element came in, the records it queued notified, and the tree changed for
    // a layout the parse ran already.
    onBuilt(connect, sheets) {
      if (connect.length) (__streamPendingConnect || (__streamPendingConnect = [])).push(...connect);
      // (…a preload link's fetch begun as it is inserted, its policy as it is: its consumers may come before its
      // connection steps — `maybeFireLinkLoad`'s `early`)
      for (const el of connect) {
        if (isHtml(el, 'link') && PRELOAD_REL.test(attrsOf(el).rel ?? '')) {
          globalThis.__dom.noteRequestPolicy(nidOf(el));
          maybeFireLinkLoad(el, true);
        }
      }
      if (sheets) __streamCascadeDirty = true;
      engineWritten();
      const doc = globalThis.document;
      noteParsedChange(documentElementOf(doc) || doc);
    },
    onScript(scriptEl) {
      // An import map is prepared — registered — the instant its `<script type=importmap>` closes, so a later module
      // script, and a declarative `shadowrootadoptedstylesheets` specifier (resolved when its `<template>` converts at
      // `</template>`), sees the mappings.
      if (scriptTypeOf(scriptEl) === SCRIPT_IMPORT_MAP) {
        maybeRunScript(scriptEl, BY_PARSER);
        return;
      }
      // Only a classic, non-deferred, parser-blocking <script> runs inline mid-parse. A module, and an external `defer` /
      // `async` one, goes on the list of scripts to execute after parsing — where it is connected now (script.rs
      // `list_parser_script`) — which the post-parse `theEnd` pass runs (real-browser ordering); one of a type
      // that runs nothing is left for a later change to prepare.
      if (!isParserBlockingScript(scriptEl)) {
        globalThis.__dom.listParserScript(nidOf(scriptEl));
        return;
      }
      // What was parsed since the last script connected first, under a fresh cascade where a stylesheet came in.
      connectParsed(true);
      // Microtask checkpoint between the connect steps and the script body: a
      // CE connectedCallback fired during the drain may have created slots and
      // queued `slotchange` (+ MutationObserver records); deliver them now so the
      // script observes them, matching the real-browser checkpoint between
      // parser-run scripts (slotchange-customelements.html).
      flushMutationDelivery();
      // The script body runs as an ordinary task: __inHTMLGrafting must be OFF so
      // a <script> it dynamically appends (e.g. div.appendChild(fragment with a
      // <script>)) executes synchronously on connection, the way it would in a
      // real browser — the parser's OWN <script>s stay gated by `_alreadyStarted`, so
      // they can't double-run via the connect path while grafting is off.
      const prevGrafting = __inHTMLGrafting;
      __inHTMLGrafting = false;
      try { runOneScript(scriptEl, BY_PARSER); }
      finally { __inHTMLGrafting = prevGrafting; }
    }
  };
  // The realm document's script-created parser (`document.open()`, dom-nodes.js; the engine's, document_lifecycle.rs
  // `docOpen`): a live parse as a page load's — its scripts run at their end tags under the streaming hooks, what each
  // write inserts connected as it returns — ended by `close()`, which runs "the end" for it: its deferred scripts, its
  // readiness made interactive (DOMContentLoaded), and a task queued for its readiness complete and its load. Begun, it
  // has none of what the page's parse had queued for its connection.
  globalThis.__csimDocumentParser = {
    open() { __streamPendingConnect = []; },
    write(doc, html) { feedDocumentParser(doc, () => writeScriptCreated(doc, html, __streamHooks)); },
    close(doc) { feedDocumentParser(doc, () => closeScriptCreated(doc, __streamHooks)); }
  };
  // …each step, and "the end" once the parse ended — in this step, or in the write a script that closed it ran in.
  function feedDocumentParser(doc, run) {
    const prev = __inHTMLGrafting;
    __inHTMLGrafting = true;
    let ended;
    try { ended = run(); } finally { __inHTMLGrafting = prev; }
    connectParsed(false);
    if (ended) theEndOfScriptCreated(doc);
  }
  // HTML "the end" for a script-created parser's document (`theEnd`): its load the window's, and the frame element's in
  // its parent ("completely finish loading"; Chrome: a written `<body onload>` and then `iframe.onload`, after `close()`
  // returned) — none where the document was opened again before it (document_lifecycle.rs `docLoadDue`).
  function theEndOfScriptCreated(doc) {
    rebuildCascade();
    theEnd(doc);
  }
  // (…a classic script, inline or neither `defer` nor `async`: the engine's, script.rs `blocks_parser`)
  function isParserBlockingScript(s) {
    return globalThis.__dom.scriptBlocksParser(nidOf(s));
  }

  // Reassigning a connected stylesheet link's `.href` must re-fetch
  // and re-resolve dependent computed styles, same as the initial
  // connect path — real browsers swap the sheet in place.
  // (…each such fetch made under the policy its document has as it begins: `requestPlanOf`)
  const refetchLink = (el) => {
    globalThis.__dom.noteRequestPolicy(nidOf(el));
    maybeFireLinkLoad(el);
  };
  globalThis.__csim_linkResourceChanged = refetchLink;
  // …and a `media` change or removal: a link not obtained because its media did not match obtains it now, where it does
  // (HTML "link type processing": "previously not obtained due to the media attribute"); one obtained is left as it is.
  globalThis.__csim_linkMediaChanged = (el) => {
    if (globalThis.__dom.linkMediaSkipped(nidOf(el))) refetchLink(el);
  };
  // …and an `as` change of a preload's or a modulepreload's, which obtains it again by the destination it names now
  // (HTML "link type processing": "when the as attribute … is changed"); a stylesheet's `as` is none of its business.
  globalThis.__csim_linkAsChanged = (el) => {
    if (linkTypesOf(attrsOf(el).rel) & (LINK_PRELOAD | LINK_MODULEPRELOAD)) refetchLink(el);
  };

  // Reassigning a connected `<iframe>`/`<frame>`'s src/srcdoc re-navigates it:
  // the nested document reloads and `load` fires again. The dom-nodes setter
  // clears the cached contentWindow / realm / once-guard first, then calls this
  // so the new document's `load` reaches handlers an onload-then-navigate chain
  // (`iframe.onload = …; iframe.src = next`) installed.
  globalThis.__csim_onFrameSrcAssigned = maybeFireFrameLoad;

  // Apply a frame's OWN `location` navigation (contentWindow.location.href =,
  // in-frame location.href/assign/replace/location=). location.js plans a child
  // realm's cross-document nav for the host (`planFrameNavigation`), which takes it at
  // the event loop's navigation turn (so the child realm isn't disposed while its location setter is
  // on the stack) and then calls this in the realm that OWNS the iframe (its parent). We find
  // the iframe by realm id and reassign its `src` — reusing the src-reassignment
  // path (dispose the old realm, load the new document, fire the iframe's load).
  // (Same-URL reload via location.href is a no-op here — the src setter skips an
  // unchanged value — a documented minor gap; navigations to a different URL,
  // incl. about:blank, work.)
  // The iframe/frame element in THIS realm's document whose navigable the given
  // child realm's document is the active document of (navigables.rs) — a deeper
  // frame's is in its own parent realm's, which the host calls this in.
  function findFrameByRealmId(realmId) {
    return globalThis.__dom.frameContainer(realmId);
  }
  // Snapshot a blob: URL's bytes NOW (at frame `location =`/`.href =` set time,
  // before the page revokes the URL) so the DEFERRED re-navigation can still load
  // the document — a navigation takes its blob reference at navigate time. Carried
  // by the owning iframe's navigation (frame-nav.js `FC_PENDING_BLOB`); consumed in
  // `__csimNavigateFrameByRealm`. Called from location.js's dispatchNav (frame
  // realm), where `resolveBlobBytes` reaches the same host registry.
  globalThis.__csimSnapshotFrameNavBlob = function (frameEl, url) {
    if (!frameEl) return;
    const r = resolveBlobBytes(url);
    if (r) setFrameContent(frameEl, FC_PENDING_BLOB, blobDocument(url, r));
  };
  // …and, for a frame the host navigates itself (an entered one: browser.rb `navigate_frame`), the blob its navigation
  // to `url` loads, `{bytes, type}`, kept as the document it loaded (`FC_LOADED`) — which a reload of a revoked URL
  // loads again — or none, keeping none: the snapshot its navigation took (`FC_PENDING_BLOB`); a `reload`'s, the bytes
  // the document it reloads was loaded of, its fragment aside; else the blob the URL names now in this window's registry,
  // as the container's own path resolves it — by the frame's storage key where `judged`, not for a traversal's: the
  // blob its entry's URL named as that was first navigated to, whatever document the frame is at now (HTML's URL
  // record keeps its blob URL entry).
  const sameDocumentURL = (a, b) => a != null && b != null && String(a).split('#', 1)[0] === String(b).split('#', 1)[0];
  globalThis.__csimTakeFrameNavBlob = function (realmId, url, reload, judged = true) {
    const el = findFrameByRealmId(realmId);
    if (!el) return null;
    if (frameContentUrl(el, FC_PENDING_BLOB) === url) {
      copyFrameContent(el, FC_PENDING_BLOB, FC_LOADED, true);
    } else if (!(reload && sameDocumentURL(frameContentUrl(el, FC_LOADED), url))) {
      // (…by the frame's own storage key: its document navigates itself — a URL another origin made it resolves none)
      const frame = globalThis.RustyRacer.contextGlobal(realmId);
      const r = !judged || !frame || frame.__dom.blobUrlUsable(url, globalThis.__csimBlobWindow()) ? resolveBlobBytes(url) : null;
      setFrameContent(el, FC_LOADED, r ? blobDocument(url, r) : null);
    }
    const content = frameContent(el, FC_LOADED);
    return content && { bytes: content.bytes, type: content.contentType };
  };
  // …and none for a document it loads of anything else: a reload of it loads its URL again.
  globalThis.__csimForgetFrameLoaded = function (realmId) {
    const el = findFrameByRealmId(realmId);
    if (el) setFrameContent(el, FC_LOADED, null);
  };
  // The frame's document navigated to `url` from within (its `location`, a link targeting it): the container
  // re-navigates to it — its `src` attribute untouched, which a navigation of the nested document never writes (Chrome
  // keeps the attribute as it was) — recording a session-history entry for an http(s) one, as a `src` change does (a
  // `blob:` one's its caller's: browser.rb `navigate_realm_self_get`).
  // (…`prompted`: its document asked whether it may be unloaded already — a traversal's, before its step)
  // (…`srcdoc` the markup of a traversal's about:srcdoc entry)
  globalThis.__csimNavigateFrameByRealm = function (realmId, url, begun, prompted = false, srcdoc = null) {
    const el = findFrameByRealmId(realmId);
    if (!el) return false;
    if (srcdoc !== null) globalThis.__dom.frameTraversalSrcdoc(nidOf(el), srcdoc);
    // A blob: nav snapshotted its bytes at location-set time (before the page
    // revoked the URL) — reuse them so the deferred rebuild survives the revoke.
    const snapped = frameContentUrl(el, FC_PENDING_BLOB) === url;
    try {
      let historyUrl = null;
      if (frameRealmOf(el) != null && globalThis.__csim_recordFrameNav) {
        const abs = parseURL(url, realmURL() || null);
        if (abs !== null && (abs.protocol === 'http:' || abs.protocol === 'https:')) historyUrl = abs.href;
      }
      // (…a pending scripted-nav response superseded, and the retained bytes those of the snapshot or none)
      if (snapped) copyFrameContent(el, FC_PENDING_BLOB, FC_LOADED);
      else setFrameContent(el, FC_LOADED, null);
      el._renavigateFrameDocument(snapped ? FC_PENDING_BLOB : null, false, historyUrl, url, begun ?? undefined, prompted);
    } catch (_) {}
    setFrameContent(el, FC_PENDING_BLOB, null);
    return true;
  };

  // The handle of the iframe/frame element that owns child realm `realmId`, when
  // it is in THIS realm's document (call it in the realm that owns the iframe —
  // the main realm for a top-level frame, the parent frame's realm for a nested
  // one). 0 when not found. Lets the host rebuild a contentWindow-reached frame
  // (no `within_frame` entry) by recovering its container element.
  globalThis.__csimGetFrameHandle = function (realmId) {
    const el = findFrameByRealmId(realmId);
    return handleOf(el);
  };

  // A frame element's `load` fired with its "iframe load in progress" flag set (HTML "iframe load event steps"): a
  // `document.open()` of its document from a listener mutes the load the written document would fire at it, which
  // would otherwise run the listener again (document_lifecycle.rs `docOpen`, which reads the flag).
  function firingFrameLoad(el, ev) {
    setFrameNav(el, FN_LOAD_IN_PROGRESS, true);
    try { fireEvent(el, ev); } finally { setFrameNav(el, FN_LOAD_IN_PROGRESS, false); }
  }
  // HTML "stop loading" the navigable of container `el`: the navigation under way cancelled, the `load` it owed with it —
  // its build, still queued, keeping the document it is at: the engine's (frame_navigation.rs `stopFrameLoading`) — and its
  // document's load, which it delayed, asked about again. Whether there was one.
  globalThis.__csimStopFrameLoading = (el, byStop = false) => {
    const stopped = globalThis.__dom.stopFrameLoading(nidOf(el), byStop);
    if (stopped) frameNavigationFinalized(el);
    return stopped;
  };
  // …this realm's navigable's: the frame's by its parent, the page's or a window's its own plan — and what of that a
  // document opened asks stopped only where its ongoing navigation is a navigation ID, its document aborted then
  // (`opening`); `stop()` whatever it finds, its frames' navigations with it, its document aborted in any case. Whether
  // there was a navigation to stop.
  globalThis.__csimStopLoading = (opening = false) => {
    const container = globalThis.__csimFrameContainer;
    const parent = container && globalThis.__csimParent && (globalThis.__csimParent.__csimRawWindow || globalThis.__csimParent);
    const stopped = parent && parent.__csimStopFrameLoading ? parent.__csimStopFrameLoading(container, !opening) : globalThis.__dom.stopOwnLoading(!opening);
    if (!opening) for (const nid of globalThis.__dom.stopChildFramesLoading()) frameNavigationFinalized(globalThis.__dom.nodeOf(nid));
    if (stopped || !opening) abortDocumentAndDescendants();
    return stopped;
  };
  // HTML "abort a document": its fetches cancelled — an event source's, an image's, a script's, an XHR's and a `fetch()`'s
  // — and its parser's input thrown away (`abortParser`), its `load` none from there; "…and its descendants": each frame's
  // a task queued on its window's event loop, what its requests would deliver cancelled now — no network's time here to
  // have kept them from being answered first (Chrome and Firefox abort a frame's XHR with its parent's `stop()`).
  function abortRequests() {
    globalThis.__csimAbortXhrRequests();
    globalThis.__csimAbortFetchRequests();
  }
  globalThis.__csimAbortDocumentRequests = abortRequests;
  function eachChildGlobal(run) {
    for (const id of globalThis.__dom.childRealms()) {
      const g = globalThis.__csimRealmGlobalById(id);
      if (g && typeof g.__csimAbortDocumentTree === 'function') run(g);
    }
  }
  function abortDescendantRequests() {
    eachChildGlobal((g) => {
      g.__csimAbortDocumentRequests();
      g.__csimAbortDescendantRequests();
    });
  }
  globalThis.__csimAbortDescendantRequests = abortDescendantRequests;
  function abortDocumentAndDescendants() {
    abortDescendantRequests();
    abortRequests();
    abortDocumentRest();
  }
  // (…a frame's the task's, its requests cancelled already — but at once for one whose parser is on the stack, a script of its
  // stopping its parent: there is no next chunk of its for the task to come between, and Chrome and Firefox parse none of
  // its markup after that script)
  // (…an image's on a task, complete and broken: `imageFetchesStop`; a script's, fetched already, by the task that would run
  // it: `docAborts`)
  // A document whose abort comes to its parser's its load never fires, which delays its parent's no more, and the load its
  // container owes for it is owed no more (`__csimFrameLoadPaid`): the parent's goes on, asked about again. One whose abort
  // leaves its load to fire (`docAbortParser`) fires it once what delays it is gone.
  function abortDocumentRest() {
    eachChildGlobal((g) => {
      if (g.__dom.docParsing(nidOf(g.document))) g.__csimAbortDocumentRest();
      else g.__csimSetTimeout(g.__csimAbortDocumentRest, 0);
    });
    globalThis.__csimAbortEventSources();
    const images = globalThis.__dom.imageFetchesStop();
    for (const [nid, load] of images) {
      globalThis.__csimSetTimeout(() => globalThis.__dom.nodeOf(nid)?._imageFetchAborted(load), 0);
    }
    const doc = globalThis.document;
    const aborted = globalThis.__dom.docAbortParser(nidOf(doc), images.length > 0);
    finishAbortedParser(doc);
    if (aborted) {
      globalThis.__dom.docLoadAborted();
      const parent = parentWindow();
      if (parent?.__csimFrameLoadPaid && globalThis.__csimFrameContainer) parent.__csimFrameLoadPaid(globalThis.__csimFrameContainer);
    } else globalThis.__csimLoadBlockerSettled();
  }
  globalThis.__csimAbortDocumentRest = abortDocumentRest;
  // HTML "abort a parser": its readiness `interactive`, then `complete`.
  function finishAbortedParser(doc) {
    while (globalThis.__dom.docAbortStep(nidOf(doc))) readinessChanged(doc);
  }
  globalThis.__csimAbortDocumentTree = abortDocumentAndDescendants;

  // A `load` event of this realm's own fired at `el` — a frame's container its document's load reaches.
  // …and the load a frame's document fired late — its images fetched — reaching its container: the container's own,
  // which its parent's `maybeFireFrameLoad` left to it (frame_navigation.rs `oweContainerLoad`).
  globalThis.__csimFireDelayedFrameLoad = (el) => {
    globalThis.__dom.frameLoadFired(nidOf(el), globalThis.__virtualNow(), false);
    frameLoadPaid(el, new Event('load'));
  };
  // …a container's load owed no more — fired (`ev`), or none to fire — and its document's own load, which it delayed,
  // asked about again. (…owed no more BEFORE it fires: a listener navigating the frame again owes the new navigation's)
  function frameLoadPaid(el, ev) {
    setFrameNav(el, FN_LOAD_OWED, false);
    if (ev) firingFrameLoad(el, ev);
    globalThis.__csimLoadBlockerSettled();
  }
  globalThis.__csimFrameLoadPaid = frameLoadPaid;
  // A document's load its images or its frames delay (`__csimFireWindowLoad`): the engine's (frame_navigation.rs
  // `loadDelay`) — delayed, and the container's load owed to the parent as well once the parent asked for it
  // (`oweContainerLoad`) — fired as a task once nothing delays it (`loadDelaySettled`: its images, its containers' loads
  // owed, its frames' documents whose own is delayed).
  const CONTAINER_LOAD_OWED = 2;
  // Something that delayed this document's load is done — an image of its in, a frame's load fired: where nothing does
  // any more, its delayed load fires as a task (`fireLoadTask`); and the parent, whose own load this one delayed, is
  // asked again in turn.
  globalThis.__csimLoadBlockerSettled = () => {
    if (!globalThis.__dom.loadDelaySettled()) return;
    globalThis.__csimSetTimeout(() => {
      if (globalThis.__dom.loadDelaySettled()) fireLoadTask();
    }, 0);
  };
  // The task that fires this document's load — "the end"'s (`__csimTaskOfTheEnd`), or one a
  // settled delay queued — and then the container's load it owes its parent: where the parent left that to it
  // (`oweContainerLoad`), or a written document's (`written`, its container's own but where muted) — delayed again, the
  // container's left to the load that fires once nothing delays it (`__csimFireWindowLoad`); a written document's
  // whatever its window's load did, which an earlier load of its fired already.
  function fireLoadTask(written = null) {
    const owes = written ?? globalThis.__dom.loadDelay() === CONTAINER_LOAD_OWED;
    if (!globalThis.__csimFireWindowLoad()) {
      const delayed = globalThis.__dom.loadDelay() !== 0;
      if (owes && delayed) globalThis.__dom.oweContainerLoad(-1);
      if (written === null || delayed) return;
    }
    const container = globalThis.__csimFrameContainer;
    const parent = parentWindow();
    if (owes && parent && container && isConnected(container) && typeof parent.__csimFireDelayedFrameLoad === 'function') {
      parent.__csimFireDelayedFrameLoad(container);
    }
  }
  // …this document's parent's, whose own load a frame of it may delay — asked again whenever that may have changed: the
  // frame's load fired (`__csimFireWindowLoad`), or its realm gone (dom-nodes.js `disposeRealm`).
  const parentWindow = () => globalThis.__csimParent && globalThis.__csimParent !== globalThis
    ? (globalThis.__csimParent.__csimRawWindow || globalThis.__csimParent) : null;
  function askParentAboutLoad() {
    const parent = parentWindow();
    if (parent && typeof parent.__csimLoadBlockerSettled === 'function') parent.__csimLoadBlockerSettled();
  }
  // Fire an iframe/frame ELEMENT's `load` event after the host rebuilt its realm
  // from a POST response (the realm rebuild already fired the child document's own
  // window `load`; this is the OUTER element load the parent observes —
  // `iframe.onload`). Mirrors `maybeFireFrameLoad`'s, minus the realm-build path (the
  // realm already exists); the POST response is the navigation completing
  // (frame_navigation.rs `frameLoadFired`). Called in the realm that owns the element
  // (same routing as `__csimRebindFrameRealm`).
  globalThis.__csimFireFrameElementLoad = function (h) {
    const el = lookup(h);
    if (!el || !isConnected(el)) return false;
    const ev = new Event('load');
    globalThis.__dom.frameLoadFired(nidOf(el), globalThis.__virtualNow(), true);
    frameLoadPaid(el, ev);
    // Leave window.event set for the rest of this microtask checkpoint, like the
    // src-path element load (see maybeFireFrameLoad).
    globalThis.__csimCurrentEvent = ev;
    return true;
  };

  // Resource Timing for a body the asset cache served: the facts of the response it came from
  // (`meta`, the host's answer's: browser.rb `external_asset_response`); a body with no facts (a
  // service worker's, a cache from before this ran) sizes the entry by its text.
  function assetTimingFields(meta, body) {
    if (meta && typeof meta === 'object') return { resp: meta };
    return { body: body != null ? body : undefined, status: body != null ? 200 : undefined };
  }
  globalThis.__csimAssetTimingFields = assetTimingFields;
  // `frame.contentWindow.location.reload()` — reload a child realm's CURRENT
  // document (same URL, which the src-reassignment path would skip as unchanged).
  // location.js plans it for the host (`planFrameReload`), which takes it at the event loop's
  // navigation turn (so the child realm isn't disposed while its own reload() is on the stack) and then
  // calls this in the realm that OWNS the iframe. `_reloadFrame()` reuses retained
  // blob bytes so reload survives a revoke.
  globalThis.__csimReloadFrameByRealm = function (realmId, url) {
    const el = findFrameByRealmId(realmId);
    if (!el) return false;
    // A reload re-navigates to the URL its document was at as `reload()` was called (`url`, its plan's) — a fragment set by
    // script, a `location.href` navigation (to data: or about:blank too, which writes no `src`) — not the
    // `src` attribute (a page that sets `location.hash` and reloads in its load handler would
    // otherwise reload its src forever), nor where a `document.open()` since moved it; an about:srcdoc document's is its
    // markup again.
    setFrameNavUrl(el, FN_URL_RELOAD, url && !/^about:srcdoc$/i.test(url) ? url : undefined);
    try { el._reloadFrame(); } catch (_) {}
    return true;
  };

  // A frame's document replaced by a javascript: URL's string result (url-parse.js `runJavascriptURL`), its realm
  // `realmId`: the frame navigated to a document of that markup at `url`, its document's — on a task of this realm, so
  // the evaluation that asked is off the frame realm's stack before it goes — unless a navigation of it began since the
  // `javascript:` URL's (whose number, its navigable's ongoing navigation then, is `navigation`: navigation_plan.rs
  // `javascriptOngoing`).
  // (…its markup as bytes, by the realm's own encoder, which no page can replace)
  const UTF8 = new TextEncoder();
  globalThis.__csimJavascriptDocumentByRealm = function (realmId, navigation, html, url) {
    globalThis.__csimSetTimeout(() => {
      const el = findFrameByRealmId(realmId);
      if (!el || !globalThis.__dom.javascriptOngoing(navigation, realmId)) return;
      // (…made with the referrer policy of the document the URL was evaluated in, whose policy container it keeps: HTML
      // "evaluate a javascript: URL")
      let policy = null;
      try { policy = globalThis.RustyRacer.contextGlobal(realmId).__csimDocumentReferrerPolicy() || null; } catch (_) {}
      setFrameContent(el, FC_NAV, { url, bytes: UTF8.encode(html), contentType: 'text/html;charset=utf-8', policy });
      el._renavigateFrameDocument(FC_NAV, false, null, undefined, undefined, true);
    }, 0);
  };

  // A connected `<iframe>` / `<frame>` fires `load` once its nested document is
  // ready. Two cases:
  //
  //  - The frame HAS a src/srcdoc: we EAGERLY build the nested browsing context
  //    as an event-loop TASK — mirroring HTML "navigate" — so the nested document
  //    loads, runs its scripts, and fires its OWN window `load` (which is how a
  //    frame reports back via `parent.postMessage`) WITHOUT the parent ever
  //    touching `contentWindow`.
  //    Then this element's `load` fires. The BUILD is a TASK (not a microtask) so
  //    a nested / self-referential iframe enqueues its own build task in its realm
  //    rather than recursing synchronously — bounded by the nesting limit the
  //    engine answers past (navigables.rs `MAX_FRAME_DEPTH`). The element `load`,
  //    however, fires as a MICROTASK (see below) — load-bearing for disposal.
  //
  //  - Otherwise (empty/about:blank frame): the nested
  //    document loads lazily on `contentDocument` access, so we just defer a bare
  //    `load` event to a microtask (after `iframe.onload = …; body.appendChild`).
  //
  // Tests like Document-createElement-namespace.html await element `load` to read
  // `contentDocument`; query-target-in-load-event / url/data-uri-fragment rely on
  // the eager nested-document path (they never read `contentWindow`).
  // Which frames build EAGERLY (vs lazily on contentWindow access): srcdoc, a
  // data:/blob:/javascript: URL, a SAME-ORIGIN http(s) `src`, and — only in a
  // universal-server context (the WPT runner; see allHostsLocal) — a CROSS-ORIGIN
  // http(s) `src`. A cross-origin iframe genuinely LOADS in a real browser and runs
  // its own scripts (which can postMessage the parent without the parent ever
  // reading contentWindow — e.g. WPT showPicker-cross-origin-iframe, which hangs if
  // the child stays inert), so the WPT runner (where every host is served
  // in-process) eager-builds it. An ordinary app leaves cross-origin frames lazy —
  // EXACTLY the previous behaviour — so an external embed isn't eager-@app.call'd
  // into running the app's own page in the frame (extra visit / log-row side
  // effects). The SOP gate keeps any built cross-origin realm inert to the parent
  // regardless. Only about:blank / empty src stay lazy (an empty document).
  // A blob: URL's document as a frame navigation carries it: the blob's bytes (resolveBlobBytes'), decoded as the frame's
  // document loads — its type's charset first, as a response's Content-Type is.
  function blobDocument(url, r) {
    return { url, bytes: r.bytes, contentType: r.type || 'text/html' };
  }

  // Cached "universal-server context" flag (the WPT runner). Constant for the VM's
  // life, so fetch it from the host once, not per cross-origin frame.
  let __allHostsLocal;
  function allHostsLocal() {
    if (__allHostsLocal === undefined) {
      __allHostsLocal = !!(globalThis.__csim_allHostsLocal && globalThis.__csim_allHostsLocal());
    }
    return __allHostsLocal;
  }

  // The container's `load` for the navigation under way — once per navigation, when, and its document built first where it
  // is built as it connects: the engine's (frame_navigation.rs `frameLoadBegin`, `frameLoadDue`, which say what is due as
  // it comes to fire).
  const FRAME_LOAD_NONE = 0, FRAME_LOAD_NOW = 1, FRAME_LOAD_BUILD = 2, FRAME_LOAD_COMMIT = 4;
  const FRAME_LOAD_PAID = 1, FRAME_LOAD_FIRE = 2;
  // What comes to run while the frame's build is under way — waiting on its response, a task of the event loop's ran as its
  // server took its time — held until it has ended, as the build's document is what the frame's `load` follows and another
  // build begins from.
  const afterBuild = new Map();
  function whenBuilt(el, run) {
    if (!frameNavHas(el, FN_BUILDING)) return run();
    const held = afterBuild.get(el);
    if (held) held.push(run);
    else afterBuild.set(el, [run]);
  }
  function frameBuilt(el) {
    globalThis.__dom.frameBuildEnd(nidOf(el));
    const held = afterBuild.get(el);
    if (!held) return;
    afterBuild.delete(el);
    platformMicrotask(() => { for (const run of held) whenBuilt(el, run); });
  }
  function maybeFireFrameLoad(el, initialInsertion = false) {
    const buildable = typeof globalThis.__csim_createFrameRealm === 'function';
    const [step, delay, generation] = globalThis.__dom.frameLoadBegin(el, initialInsertion, buildable, allHostsLocal(), globalThis.__virtualNow(), subresourceHost);
    if (step === FRAME_LOAD_NONE) return;
    // (…`now`: fired at once, inside the script that inserted it, `window.event` that script's again after it)
    const fireElementLoad = (now = false) => {
      if (frameNavHas(el, FN_BUILDING)) return whenBuilt(el, fireElementLoad);
      const due = globalThis.__dom.frameLoadDue(el, generation, globalThis.__virtualNow());
      if (due === FRAME_LOAD_PAID) frameLoadPaid(el);
      if (due !== FRAME_LOAD_FIRE) return;
      const ev = new Event('load');
      frameLoadPaid(el, ev);
      if (now) return;
      // Leave `window.event` set to this load event for the rest of the current
      // microtask checkpoint. A frame `load` is event-loop-driven, so per DOM
      // "inner invoke" the microtask checkpoint in "clean up after running script"
      // runs (the JS stack is empty) BEFORE the per-listener current-event
      // restore — i.e. a promise continuation chained off the load listener
      // observes `window.event` (dom/events/Event-dispatch-throwing-multiple-
      // globals). The runloop clears it at the step boundary (= the next task), so
      // a continuation resumed in a LATER task correctly sees `undefined`.
      // (Restoring synchronously here is wrong; draining-before-restore is
      // impossible — this runs inside a checkpoint, where a nested drain no-ops.)
      globalThis.__csimCurrentEvent = ev;
    };
    if (step === FRAME_LOAD_NOW) return fireElementLoad(true);
    // The navigation's tasks: its document asked whether it may be unloaded, where it is to be, on one of its own — what its
    // handlers queue, a message to the page, runs with that document still the frame's, HTML's parallel steps going on after
    // it: the engine's to say whom (frame_navigation.rs `frameNavAsks`) — and `task` on another, which goes on while it is
    // the container's latest.
    const latest = () => globalThis.__dom.frameNavGeneration(nidOf(el)) === generation;
    const queueTasks = (task) => {
      if (!frameNavHas(el, FN_PROMPT_OWED)) return globalThis.__csimQueueNavigationTask(task, delay);
      const asked = frameRealmOf(el);
      globalThis.__csimQueueNavigationTask(() => {
        const realm = globalThis.__dom.frameNavAsks(nidOf(el), generation, asked);
        if (realm >= 0) globalThis.__csimPromptToUnloadFrame(realm);
        globalThis.__csimQueueNavigationTask(task, 0);
      }, delay);
    };
    if (step === FRAME_LOAD_BUILD) {
      // Builds the realm (idempotent — returns the cached window if the parent
      // already touched contentWindow), loads + runs the nested document, and fires
      // its window `load` (in create_frame_realm). Discard the returned cross-realm
      // global so no handle to it lingers in this task's scope.
      const buildFrame = () => {
        if (frameNavHas(el, FN_BUILDING)) return whenBuilt(el, buildFrame);
        if (!latest()) return;
        setFrameNav(el, FN_BUILD_QUEUED, false);
        if (!isConnected(el)) return;
        // Already materialised (the page touched `contentWindow` / `contentDocument`
        // during parsing): there is nothing for the parent's `load` to wait for, and
        // reaching into a frame that already has a document in flight is how a
        // planned navigation got lost (reparent-form-during-planned-navigation-task).
        if (frameRealmOf(el) != null && !frameNavHas(el, FN_COMMIT_PENDING)) return;
        try { if (globalThis.__csimFrameWindow) globalThis.__csimFrameWindow(el, true); } catch (_) {}
      };
      // The parent document's `load` waits for its FRAMES' DOCUMENTS: a load handler
      // reads `iframe.contentWindow.document` (form-data-set-usv, and the
      // beforeunload-coercion test navigates one). Only the build is gated — the
      // ELEMENT's own load event stays on this task, where the page's other
      // navigation machinery expects it.
      // (…and the ELEMENT's follows the build, whoever runs it: the document's `load` flushing it ahead of this task, whose
      // handler's message to the page, queued as it loads, comes after the `load` of its frame)
      // The build parked on a still-activating service worker (Handle Fetch waits
      // for 'activated'): no load yet — __csim_swRetryDeferredNavs re-runs the
      // whole build+load when the activation settles.
      let loadQueued = false;
      const queueLoad = () => {
        if (loadQueued || frameNavHas(el, FN_DEFERRED_SW)) return;
        loadQueued = true;
        platformMicrotask(fireElementLoad);
      };
      const gate = subresourceGate(el, () => {
        buildFrame();
        queueLoad();
      });
      queueTasks(() => {
        gate();
        queueLoad();
      });
    } else if (step === FRAME_LOAD_COMMIT) {
      // No document built as it connects — an app's cross-origin embed: the one the frame has left on the navigation's task
      // all the same, its next made as its window is next read.
      queueTasks(() => {
        if (!latest()) return;
        if (frameNavHas(el, FN_COMMIT_PENDING) && globalThis.__csimFramePrompted(el)) globalThis.__csimCommitFrameNavigation(el);
        platformMicrotask(fireElementLoad);
      });
    } else if (delay > 0) {
      globalThis.__csimSetTimeout(fireElementLoad, delay);
    } else {
      platformMicrotask(fireElementLoad);
    }
  }

  // wptserve's `?pipe=trickle(dN[:dM…])` delays the response by the sum of its
  // `dN` (seconds). We fetch synchronously, so we model the delay by deferring the
  // resource's `load` event by that many virtual ms — letting render-blocking
  // tests observe the resource as not-yet-loaded within a frame (`finished===false`
  // after one rAF) yet eventually loaded. 0 when there's no trickle (the normal
  // setTimeout(0) task). Matches the raw URL/text (attribute value, unparsed): url_ops.rs `trickle_delay_ms`.
  const trickleDelayMs = (s) => globalThis.__dom.trickleDelay(String(s || ''));
  // The subresource work a document's `load` event WAITS FOR: its style sheets and its frames, each queued as a task, so
  // the window's `load` could otherwise beat a `<style>`'s (css/cssom/HTMLStyleElement-load-event) or land before a
  // frame's document exists at all (form-data-set-usv reads `iframe.contentWindow.document` from its load handler) — a
  // gate the engine keeps (load_gates.rs), run at most once by whoever gets there first: its own task, or the flush
  // `__csimFireWindowLoad` runs, rather than draining the timer queue, which would advance the driver's lazy clock past a
  // DELAYED `setTimeout` the page queued while parsing — one a test may still want to observe the state before. (The
  // zero-delay ones do run with the load, as they do in a browser; the Ruby side drains them right after this fires —
  // `flush_page_init`.) What each runs, by its number.
  const loadGateWork = new Map();
  const runLoadGate = (id) => {
    const run = loadGateWork.get(id);
    loadGateWork.delete(id);
    try {
      run?.();
    } finally {
      globalThis.__dom.loadGateEnd(id);
      globalThis.__csimLoadBlockerSettled();
    }
  };
  // Register work the document's `load` must not precede (`delayed`: a resource wptserve trickles, late on purpose), and
  // return the thunk that performs it.
  function subresourceGate(el, run, delayed) {
    const id = globalThis.__dom.loadGate(el ?? null, !!delayed);
    loadGateWork.set(id, run);
    return () => { if (globalThis.__dom.loadGateTake(id)) runLoadGate(id); };
  }
  // …and the common case, where the work IS a task of its own.
  function subresourceLoadTask(el, run, delay) {
    globalThis.__csimSetTimeout(subresourceGate(el, run, delay > 0), delay);
  }
  // …and one of no element's, a `javascript:` URL's (url-parse.js).
  globalThis.__csimLoadGateTask = (run) => subresourceLoadTask(null, run, 0);

  // A link's plan (link_resource.rs `link_plan`) and what it obtains, as `linkPlan` answers them.
  const PLAN_FAIL = 1, PLAN_FETCH = 2;
  const OBTAINS_STYLESHEET = 1, OBTAINS_MODULEPRELOAD = 1 << 2;
  const PRELOAD_REL = /(?:^|\s)preload(?:\s|$)/i;
  function maybeFireLinkLoad(el, early = false) {
    // (…none for a disconnected link: its attributes set before it is inserted, connecting it is what obtains the
    // resource)
    if (!isConnected(el)) return;
    // What the link obtains, and whether it fetches at all — the engine's (link_resource.rs `link_plan`): nothing for a
    // disabled one, a modulepreload's or a preload's whose `media` does not match (until a change of it does), a
    // preload's whose `as` names no preload destination, one with no `href`; a modulepreload whose `as` names no module
    // fails without a fetch. (Its request's destination, which its Fetch Metadata reports, its request plan's.)
    const [plan, obtains, moduleDestination, preloadDestination] = globalThis.__dom.linkPlan(nidOf(el));
    if (plan !== PLAN_FAIL && plan !== PLAN_FETCH) return;
    // (…requested as the link's document is now — its policy as its fetch is planned — whenever the fetch below runs)
    const kind = J_LINK | (obtains << 8), planned = requestPlanOf(el, kind);
    const isStylesheet = (obtains & OBTAINS_STYLESHEET) !== 0;
    const isModulePreload = (obtains & OBTAINS_MODULEPRELOAD) !== 0;
    const href = attrsOf(el).href;
    // (…its integrity metadata its request's: its `integrity` as it is planned — a change of it after is no trigger to
    // fetch again — a style sheet's the one its cascade reads with, sheet_fetch.rs `sheetIntegrity`)
    const linkIntegrity = isStylesheet ? globalThis.__dom.sheetIntegrity(nidOf(el)) : attrsOf(el).integrity || '';
    const hasIntegrity = attrsOf(el).integrity != null;
    // …its fetch of `abs`, `request` its request — the engine's (subresource_obtain.rs `linkObtain`), its entry filed —
    // whether it is a response the link loads, null where a service worker owns its event (a controlled prefetch's).
    // (…a module preload's of no `integrity` attribute — an empty one is one — its import map's: HTML "fetch a
    // modulepreload module script graph")
    const obtain = (abs, request) => {
      const integrity = hasIntegrity || !isModulePreload ? linkIntegrity : importmapIntegrityFor(abs);
      const done = globalThis.__dom.linkObtain(nidOf(el), nidOf(el._ownerDocument), abs, kind, request[1], integrity, moduleDestination, subresourceHost);
      return done === LINK_PENDING ? null : done === LINK_LOAD;
    };
    // A preload's fetch is one its consumers may need before the task runs: planned now, its entry in its document's
    // map pending — a consumer that finds it runs it then — the task its event's alone, as the preload's fetch begins as
    // its link is processed (HTML `preload`): the engine's (subresource_obtain.rs `linkPreloadPlan`). The parser's is
    // planned as the parser inserts it (`early`), before its connection steps come — a consumer it inserts next takes it.
    if (plan === PLAN_FETCH && preloadDestination !== null) {
      const request = requestAsItBegins(planned, el, kind), abs = resolveURLValue(el, href) ?? String(href);
      globalThis.__dom.linkPreloadPlan(nidOf(el), nidOf(el._ownerDocument), abs, kind, request[1], linkIntegrity, early, subresourceHost);
    }
    if (early) return;
    // (…a preload's task its plan's: one a later plan superseded fires nothing — the latest's task fires the link's one
    // event, as Chrome does)
    const plannedNow = preloadDestination !== null ? globalThis.__dom.linkPreloadId(nidOf(el)) : undefined;
    // A stylesheet/preload resource load completes as a TASK (network completion),
    // NOT a microtask: scheduling it on a microtask let the parse-time microtask
    // checkpoint ("clean up after running script") fire the `load` mid-parse —
    // before the rest of the document (e.g. the `.target` the stylesheet styles)
    // was parsed — so a `load` listener saw an incomplete tree / stale cascade
    // (render-blocking script-inserted-stylesheet-link). A task fires after the
    // current parse completes, matching real-browser ordering.
    subresourceLoadTask(el, () => {
      if (!isConnected(el)) return;
      if (plannedNow !== undefined && globalThis.__dom.linkPreloadId(nidOf(el)) !== plannedNow) return;
      // (…its mode and credentials as its fetch begins: its `crossorigin` as the task runs)
      const request = requestAsItBegins(planned, el, kind);
      // Its URL resolved against THIS document's base (the raw attribute resolves against the MAIN document Ruby-side —
      // wrong directory for a subframe's relative href; same class as the script srcKey fix).
      const abs = resolveURLValue(el, href) ?? String(href);
      let ok = false;
      if (plan !== PLAN_FAIL) {
        const run = plannedNow !== undefined ? globalThis.__dom.linkPreloadRun(nidOf(el), subresourceHost) : LINK_LEGACY;
        const got = run !== LINK_LEGACY ? run === LINK_LOAD : obtain(abs, request);
        if (got === null) return;
        ok = got;
      }
      // Newly loaded stylesheet rules must be in the cascade index
      // before `load` fires, otherwise listeners that synchronously
      // read `getComputedStyle` / `var(--*)` see stale values.
      if (ok && isStylesheet) {
        try { rebuildCascade(); } catch (_) {}
      }
      fireEvent(el, new Event(ok ? 'load' : 'error'));
    }, trickleDelayMs(href));
  }

  // A connected CSS `<style>` fires `load` once its sheet is ready (HTML "update a
  // style block"). Both flavours fire on a TASK, never a microtask, so the load never
  // lands mid-parse: an `@import` block is deferred by the import URL's `trickle` delay
  // (so render-blocking "is cancellable" sees it not-yet-loaded within a frame, then
  // eventually loaded) and fetches + applies the import first; a plain block has no
  // critical subresource and fires on the next task. (We don't model the `@import`-
  // failure `error`.)
  function maybeFireStyleLoad(el) {
    if (elementFlag(el, STYLE_LOAD_FIRED)) return;
    // A `<style>` fires `load` once its sheet is ready (HTML "update a style block" → the
    // subresource-obtaining steps queue a load task) — for EVERY CSS `<style>`, not only
    // `@import` ones. A non-CSS type has no sheet, so no load event.
    if (!styleElementIsCss(el)) return;
    // (…the `@import`s its sheet has, as the style engine's parse takes them — one in a comment, a refused one or one after
    // the rules that may import is none — read without making its sheet, which would fetch them now: the cascade does)
    const doc       = el._ownerDocument;
    const imports   = globalThis.__dom.styleImports(el._textContent || '', documentBaseURL(doc), nidOf(doc));
    const hasImport = imports.length > 0;
    setElementFlag(el, STYLE_LOAD_FIRED, true);
    subresourceLoadTask(el, () => {
      if (!isConnected(el)) return;
      // Fetch + apply an @import before the load fires; a plain block has no critical
      // subresource, so it just fires the (async) load task.
      if (hasImport) { try { rebuildCascade(); } catch (_) {} }
      fireEvent(el, new Event('load'));
    }, Math.max(0, ...imports.map(trickleDelayMs)));
  }
  // (…and for a block updated while connected — its text changed — which the engine lists: mutation-observer.js
  // `engineWritten`)
  globalThis.__csimStyleBlockUpdated = maybeFireStyleLoad;
  // True only while `__csimLoadDocument` is grafting the parsed HTML
  // skeleton onto the live document. Suppresses `maybeRunScript` for
  // parse-time `<script>` tags — `theEnd` will execute
  // those in DOM order afterward. Once grafting ends, dynamic appends
  // (chunk loaders doing `head.appendChild(script)` mid-evaluation)
  // run via `maybeRunScript`: inline scripts synchronously, external
  // scripts deferred to a task (see maybeRunScript).
  let __inHTMLGrafting = false;
  // Chunk loaders await the `<script>` element's `load` event to resolve the
  // dynamic-import Promise that triggered the append; for an external script
  // that `load` fires from the deferred task, settled by the settle/drain loop.
  // (…one from an external file, as it was prepared: a script that took its own `src` away as it ran fires it all the same,
  // Chrome and Firefox alike. An EMPTY src is a script that fires its `error` — `prepareScript`'s PREPARE_ERROR.)
  function dispatchScriptLoad(el, ok) {
    if (!scriptFlag(el, SCRIPT_FROM_EXTERNAL_FILE)) return;
    // wptserve's `?pipe=trickle(dN)` makes the resource finish loading N seconds
    // later, so the script's `load`/`error` event fires on a trickle-delayed
    // task — letting render-blocking tests observe the script as not-yet-loaded
    // within a frame (`finished===false` after one rAF) yet eventually loaded.
    // Gated on connection at fire time: a script removed before the delay elapses
    // doesn't fire load (remove-element-unblocks-rendering). 0 (the normal case,
    // every app script) fires synchronously — unchanged.
    const delay = trickleDelayMs(attrsOf(el).src);
    if (delay > 0) {
      globalThis.__csimSetTimeout(() => {
        if (!isConnected(el)) return;
        fireEvent(el, new Event(ok ? 'load' : 'error'));
      }, delay);
      return;
    }
    fireEvent(el, new Event(ok ? 'load' : 'error'));
  }

  // HTML "execute the script element": the value `document.currentScript` takes
  // while `el` runs. It's the executing element for a script in a document tree,
  // but null when the element's root is a shadow root (currentScript is only set
  // for a script in a document tree; Document-prototype-currentScript). Computed
  // at execution time — a script removed from its shadow tree before it runs is
  // no longer shadow-rooted, so currentScript becomes the element.
  function currentScriptFor(el) {
    const root = el && relativeOf(el, RELATIVE_ROOT);
    return (root && root._isShadowRoot) ? null : el;
  }

  // HTML "execute the script element" steps 4 and 6: a script from an external file — or a module — runs with its
  // document's ignore-destructive-writes counter raised, a `document.write` it makes with no insertion point ignored
  // rather than opening (wiping) the document. (document_state.rs, field 4.)
  const DOC_DESTRUCTIVE_IGNORED = 4, DOC_GENERATION = 5;
  function ignoringDestructiveWrites(doc, run) {
    const nid = doc ? nidOf(doc) : -1;
    if (!(nid >= 0)) return run();
    globalThis.__dom.setDocState(nid, DOC_DESTRUCTIVE_IGNORED, globalThis.__dom.docState(nid, DOC_DESTRUCTIVE_IGNORED) + 1);
    try { return run(); } finally {
      globalThis.__dom.setDocState(nid, DOC_DESTRUCTIVE_IGNORED, globalThis.__dom.docState(nid, DOC_DESTRUCTIVE_IGNORED) - 1);
    }
  }

  // The URL a script's text names in a `sourceMappingURL` comment (`//# …`, or the older `//@ …`) closing it — with
  // nothing but white space after, within its last 512 characters — or null. A run reads that tail alone: an inline data:
  // map, which would cost a scan (and a copy kept) of its whole length on every run, is never one (the host's twin, for a
  // module: StackResolver.mapping_url).
  function sourceMappingURLOf(body) {
    const tail = body.length > 512 ? body.slice(-512) : body;
    const m = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/.exec(tail);
    return m === null || m[1].startsWith('data:') ? null : m[1];
  }
  // …an external script's, kept by its URL in the main realm for the host's stack annotation (stack_resolver.rb,
  // `__csimSourceMapOf`) — a copy of the URL, none of its text.
  function noteSourceMap(label, body) {
    const NS = globalThis.RustyRacer, main = NS.contextOf(globalThis) === 0 ? globalThis : NS.contextGlobal(0);
    const url = sourceMappingURLOf(body);
    const maps = (main.__csimSourceMaps ??= new Map());
    if (url === null) maps.delete(label);
    else maps.set(label, url);
  }
  globalThis.__csimSourceMapOf = (label) => globalThis.__csimSourceMaps?.get(String(label)) ?? null;
  // HTML "execute the script element" for the classic script `el` whose source text is `body`: `url` the URL of the
  // external file it came from as it was prepared (what an exception thrown in it reports as its file), null for an
  // inline one, which runs as `inline://<hash>`. `document.currentScript` is it while it runs (`currentScriptFor`: null
  // in a shadow tree), which webpack / embroider bundles read their public path from, and is restored after so
  // unrelated callers see the spec-default null; a script from an external file runs with its document's
  // ignore-destructive-writes counter raised, a `document.write` with no insertion point ignored, not opening the
  // document — what its run's microtasks write too; a throw is reported (`report`) while currentScript still points at
  // it (Document.currentScript script-window-error). Where it runs from an empty JS stack — the parser's, or a task's
  // (`fromEmptyStack`) — and no other script is running beneath it (a `document.write`'s parser runs one inside the
  // script that wrote it, a frame built under its parent's script that one's: webidl.js `scriptOnStack`), "clean up
  // after running script" performs a microtask checkpoint before currentScript is restored, so a microtask it queued
  // (`Promise.resolve().then`, `queueMicrotask`) observes it (Document.currentScript "microtask") and runs before its
  // `load`; the checkpoint drains Promise continuations and the microtask-scheduled MutationObserver / slotchange
  // delivery, not timers, rAF or fetches.
  let scriptDepth = 0;
  let inlineScriptBases = null;
  const MAY_IMPORT = /\bimport\s*[(/]/;
  globalThis.__csimInlineScriptBase = (label) => inlineScriptBases?.get(label) ?? null;
  function executeClassicScript(el, body, url, fromEmptyStack, report = reportScriptError) {
    // (…an inline one's named by its text — hashed for it alone: an external one's, a bundle of megabytes, is its URL —
    // and, where the parser made it, the line of its document its text begins on, which its errors are counted from:
    // script.rs `exceptionSite`)
    let label = url;
    if (url === null) {
      const line = globalThis.__dom.takeScriptLine(nidOf(el));
      label = 'inline://' + hashStr(body) + (line > 1 ? '@' + line : '');
    }
    // (…an inline one's base URL its document's as it runs — HTML's, as it is prepared — which an `import()` it makes
    // resolves against: `__csimInlineScriptBase` — a second of the same text run under another base named apart, so
    // the first keeps its own)
    if (url === null && MAY_IMPORT.test(body)) {
      const bases = (inlineScriptBases ??= new Map()), base = documentBaseURL(el._ownerDocument), named = label;
      for (let n = 1; bases.has(label) && bases.get(label) !== base; n++) label = named + '~' + n;
      bases.set(label, base);
    }
    const doc = globalThis.document;
    const prevCurrent = doc && doc._currentScript;
    if (doc) doc._currentScript = currentScriptFor(el);
    if (url !== null) noteSourceMap(label, body);
    // (…its realm the entry realm while it runs — HTML "prepare to run script": a script a parent's listener appends to a
    // frame, or one an opener writes into a pop-up, its own document's: navigables.rs `entryRealm`)
    const run = () => {
      scriptDepth++;
      const entry = globalThis.__dom.enterRealm(globalThis.__csimRealmId());
      try {
        __csim_runScript(label, body);
      } catch (e) {
        report(e, url ?? realmURL());
      } finally {
        globalThis.__dom.exitRealm(entry);
        scriptDepth--;
        if (fromEmptyStack && scriptDepth === 0 && !scriptOnStack()) {
          try { const y = globalThis.__csim_yield; if (y) y(); } catch (_) {}
        }
      }
    };
    try {
      if (url !== null) ignoringDestructiveWrites(el._ownerDocument, run);
      else run();
    } finally {
      if (doc) doc._currentScript = prevCurrent;
    }
  }
  // …its throw's report: HTML "report the exception" — the `error` event at the window, the console where no listener
  // cancelled it — where the exception carries no location of its own (a SyntaxError its text threw as it compiled),
  // the script's `filename`: its URL, an inline one's its document's.
  function reportScriptError(e, filename) {
    try { globalThis.__csimReportScriptError(e, filename); } catch (_) { logThrew('dynamic script', e); }
  }
  // Execute a dynamic external script's already-fetched body, from the deferred task below (never synchronously) — and
  // `load`, whatever it threw: HTML "execute the script element" fires it for a script from an external file once it
  // has run (`error` is a failed fetch's).
  function runDeferredExternalScript(el, body, url) {
    executeClassicScript(el, body, url, true);
    dispatchScriptLoad(el, true);
  }

  // Count of dynamically-inserted external scripts whose deferred execution task
  // hasn't run yet — the Ruby boot drain pumps the event loop while this is > 0 so
  // the app's chunk-loader chain finishes before a test interacts.
  let pendingExternalScripts = 0;
  // (…whether script of the page's runs beneath the host now: webidl.js `scriptOnStack`, what a server's `sleep` asks)
  globalThis.__csimScriptOnStack = () => scriptOnStack();
  globalThis.__csimPendingExternalScriptCount = function () {
    return pendingExternalScripts;
  };
  // A controlled document's external classic script routed through its service
  // worker (destination 'script'), synchronously — shared by the parse-time
  // (runOneScript) and dynamic-insertion (maybeRunScript) paths. Returns
  // {body} for a served script, {blocked: true} for a networkError respondWith,
  // null for no interception / fallthrough (→ the plain network fetch).
  // (…its request the engine's `plan` of it: subresource_plan.rs — referred by `referrer` where it names one of its own,
  // a CSS image's sheet's location, else its document)
  function swFetchSubresource(absUrl, plan, binary, integrity, referrer = null) {
    const swCtrl = serviceWorkerFor(absUrl);
    if (!swCtrl) return null;
    const href = referrer || realmURL();
    try { return globalThis.__csim_swScriptFetch(swCtrl, absUrl, swClientIdOf(), href, plan, binary === true, integrity || '', globalThis.__dom.requestReferrerPolicy(plan)) || null; } catch (_) { return null; }
  }
  // Import-map "integrity" metadata for a RESOLVED module URL ('' when unmapped).
  const importmapIntegrityFor = (absUrl) => moduleIntegrity(absUrl);
  // Generic per-destination synchronous SW subresource fetch for modules outside
  // this one (video bytes, fonts), its request the engine's `plan` of it: {body}|{bytes (binary)}|{blocked}|null.
  globalThis.__csimSwFetchDest = function (absUrl, plan, binary, referrer = null, integrity = '') {
    return swFetchSubresource(absUrl, plan, binary, integrity, referrer);
  };
  // A dynamically inserted script's task: what runs it, its source fetched or to be — its preparation-time document's, of that
  // document's realm, whichever realm's script put it there. Tracked in the in-flight count, so the Ruby boot/settle drain can
  // run the app's (finite) deferred-chunk chain to quiescence before a test interacts — it runs async, so the module/chunk
  // loader isn't done when load returns, and a negative assertion would pass on a half-booted page. One of its document's "set
  // of scripts that will execute as soon as possible" or its "list of scripts that will execute in order as soon as possible",
  // a module's too, which its load waits for: HTML "the end" spins the event loop until they are empty (Chrome and Firefox:
  // `load` after it, and a module's own `load`) — a load gate, run by its own task or ahead of the load, where that is still to
  // come: a document past its load, and so its parent's, waits for nothing. None of it where its document's abort cancelled
  // the fetch before the task came: no event either, where the engines differ — Chrome `error`, Firefox none, for a `stop()` in
  // the task that inserted it — "discarding any tasks queued"; nor where it has moved to another document since: "execute the
  // script element" step 2, "If el's preparation-time document is not equal to document, then return" (Chrome no event,
  // Firefox `error`).
  function dynamicScriptTask(el, run) {
    const doc = el._ownerDocument;
    if (doc !== globalThis.document) {
      const NS = globalThis.RustyRacer;
      return NS.contextGlobal(NS.contextOf(doc)).__csimDynamicScriptTask(el, run);
    }
    pendingExternalScripts++;
    const aborts = globalThis.__dom.docAborts(nidOf(doc));
    const execute = () => {
      try {
        if (aborts === globalThis.__dom.docAborts(nidOf(doc)) && el._ownerDocument === doc) run();
      } finally {
        pendingExternalScripts--;
      }
    };
    // (…one of `async` false in its document's "list of scripts that will execute in order as soon as possible", each only once
    // those before it have run — one whose fetch runs the event loop, as a server's `sleep` does, running none after it inside it)
    let task = execute;
    if (scriptFlag(el, SCRIPT_NOT_FORCE_ASYNC) && !('async' in attrsOf(el))) {
      const entry = { execute, due: false };
      scriptsInOrder.push(entry);
      task = () => {
        entry.due = true;
        runScriptsInOrder();
      };
    }
    if (globalThis.__dom.docLoadFired(nidOf(doc))) globalThis.__csimSetTimeout(task, 0);
    else subresourceLoadTask(el, task, 0);
  }
  globalThis.__csimDynamicScriptTask = dynamicScriptTask;
  const scriptsInOrder = [];
  let runningScriptsInOrder = false;
  function runScriptsInOrder() {
    if (runningScriptsInOrder) return;
    runningScriptsInOrder = true;
    try {
      while (scriptsInOrder[0]?.due) scriptsInOrder.shift().execute();
    } finally {
      runningScriptsInOrder = false;
    }
  }
  function maybeRunScript(el, by = BY_SCRIPT) {
    // HTML "prepare the script element", as far as the element decides it — the engine's (script.rs `prepare_script`):
    // an empty one is not yet prepared (text appended later prepares it again, Node-appendChild-text-in-script), and one
    // it prepares is "already started" from there, and no script of the after-parse pass's (`_scriptRun`): only the
    // PARSER's scripts belong to "the end" — a loader snippet's injected script ran on insertion and AGAIN there.
    // (…scripting disabled for it where its node document has no browsing context: a createHTMLDocument's)
    // (…and the parser's import map, at its end tag: `by` it)
    const action = globalThis.__dom.prepareScript(nidOf(el), !el._ownerDocument._noBrowsingContext, by);
    if (action === PREPARE_NONE) return;
    // (…an empty `src` is a failed load, its `error` on a task: not the element's text run)
    if (action === PREPARE_ERROR) {
      globalThis.__csimSetTimeout(() => dispatchScriptLoad(el, false), 0);
      return;
    }
    if (action === PREPARE_IMPORT_MAP) return registerImportMap(el);
    // A dynamically-appended MODULE script loads + evaluates its graph on a later
    // task (modules are always async) and fires load/error on the element —
    // previously nothing ran it at all, so `script.onload` on a dynamic
    // `<script type=module src>` hung forever (fetch-destination's import cases).
    // (…its URL as it is prepared, a `src` changed or removed before the task runs it changing nothing, an inline one's none —
    // and an inline one's source text: "Let source text be el's child text content")
    if (action === PREPARE_MODULE) {
      const url = attrsOf(el).src ? resolveURLValue(el, attrsOf(el).src) : undefined;
      const source = url === undefined ? childTextContent(el) : undefined;
      dynamicScriptTask(el, () => {
        // No isConnected gate: a subsequent removeChild can't cancel an
        // already-started script (same rule the classic path documents below).
        try { runModuleScript(el, url, source); } catch (_) { dispatchScriptLoad(el, false); }
      });
      return;
    }
    // …a classic one. (Inline scripts in the original document parse run via `theEnd`; this path is for
    // dynamically-appended `<script>` elements.)
    if (attrsOf(el).src) {
      // External scripts load+execute ASYNCHRONOUSLY. Per HTML "prepare the
      // script", a dynamically-inserted external script is force-async: its body
      // runs on a later task, NOT synchronously during insertion. The fetch is
      // synchronous (Rack), so the body is captured here at insertion time — a
      // subsequent removeChild can't cancel an already-started script — but the
      // execution + the load/error event are deferred to a setTimeout(0) task,
      // pumped by the settle / __runLoopStep drain. This is what makes
      // document.currentScript observable to the script's own body but not to the
      // synchronous insertion code (Document-prototype-currentScript), and lets a
      // chunk loader's `el.onload`-resolved import Promise settle a tick later
      // rather than re-entrantly mid-insertion.
      // (…its src resolved against THIS document's base — the raw attribute would resolve against the MAIN document
      // Ruby-side: another directory for a subframe's relative src, the same class as runOneScript's srcKey fix)
      // (…from the network: an inserted script is no parser's, which the cross-visit asset cache serves; its Resource
      // Timing entry filed when the load COMPLETES — on the task below, as the fetch finishing is what a browser reports
      // — so a PerformanceObserver set up right after the `src` assignment sees it)
      // (…its URL as it is prepared: a `src` changed or removed before the task runs it changes nothing)
      const src = resolveURLValue(el, attrsOf(el).src), url = src ?? String(attrsOf(el).src);
      const [ok, body, entry] = globalThis.__dom.fetchClassicScript(nidOf(el), nidOf(el._ownerDocument), src, false, subresourceHost) ?? [false, '', null];
      dynamicScriptTask(el, () => {
        if (entry) globalThis.__csimRecordResource(entry);
        if (!ok)   { dispatchScriptLoad(el, false); return; }
        if (!body) { dispatchScriptLoad(el, true);  return; }
        runDeferredExternalScript(el, body, url);
      });
      return;
    }
    // (…an inline one at once, inside the script that inserted it: a shadow-tree one too, through the shadow-aware
    // connect walk)
    executeClassicScript(el, childTextContent(el), null, false);
  }

  // The events that PREPARE a connected, not-already-started, non-parser-inserted <script> (HTML "prepare the
  // script element" triggers): its children changed — `s.appendChild(textWithCode)` or setting its `text` /
  // `textContent` runs `s` synchronously (Node-appendChild-text-in-script / three-scripts / script-in-script) — and a
  // `src` attribute set where it had none. The DOM primitives call this after either. Gated like maybeRunScript: not
  // during the initial parse graft (`theEnd` owns that ordering).
  globalThis.__csimPrepareScript = function (el) {
    if (!__inHTMLGrafting && el && isScriptElement(el)) maybeRunScript(el);
  };

  // ── Globals seen by Ruby side via Context#call('__csim<Op>') ────

  globalThis.Document = Document;
  globalThis.Element  = Element;
  globalThis.Node     = Node;
  // DOM Node.nodeType constants per spec. Libraries that compare
  // `node.nodeType == Node.ELEMENT_NODE` (Stimulus's `elementFromNode`
  // is the canonical case — it gates Stimulus's add-to-tree path on
  // this check, so without the constant a Turbo body swap's added
  // body never gets its `[data-controller]` descendants connected).
  globalThis.Text     = Text;
  installDomClassAliases({ Element, Document, Text });
  prepareWindowInterface();

  // Layout-driven observers — apps construct these at module init
  // (Turbo's FrameController is the canonical case); they expect the
  // constructor to succeed and `observe()` to be a no-op when there's
  // no layout. `takeRecords()` returns empty so dirty-tracking code
  // doesn't loop.

  globalThis.EventTarget     = EventTarget;

  globalThis.Blob       = Blob;
  globalThis.File       = File;

  globalThis.ClipboardEvent = ClipboardEvent;

  // The documents a navigation response loads as besides an HTML one (mime.rs `document_kind`)…
  const DOCUMENT_XML = 1, DOCUMENT_TEXT = 2;
  // …and a text document's markup. A text document — text/plain, text/css, a script's or JSON's type — is the
  // response's text VERBATIM, not HTML-parsed, in a `<pre>` (HTML "convert to a preformatted document"), so character
  // references (`&#601;`) and tags stay literal in `body.textContent` (the form-submission charset tests echo the request
  // body and read it back), and EVERY newline is kept: a routed direct.txt body "Network\n" must read back with its
  // trailing newline (static-router-main-resource). Modelled by HTML-escaping the text into one, which the HTML parse
  // then reads; the extra leading newline feeds the parser's drop-first-newline-after-<pre> rule, so a body that itself
  // starts with one keeps it.
  function textDocumentMarkup(text) {
    return '<pre>\n' + String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
  }

  // The window of an `<iframe>` / `<frame>`, its document made as it is needed — a realm the host builds of the response
  // its srcdoc or src comes to — or null: none past the nesting limit (frame_response.rs).
  // `commit`: the build a frame's navigation is waiting for (`buildFrame`), where the frame's realm is still its old
  // document's — unloaded once the response is in (`__csimCommitFrameNavigation`); any other caller reads that window.
  // What a build makes of its frame's response (frame_response.rs `frameResponse`): the document it answers; none yet,
  // its navigation parked on a service worker still activating; none at all, a response that makes no document leaving
  // the frame at the one it is at.
  const FRAME_BUILD = 0, FRAME_DEFERRED = 1, FRAME_KEPT = 2;
  globalThis.__csimFrameWindow = function (frameEl, commit = false) {
    if (!frameEl || (!isHtml(frameEl, 'iframe') && !isHtml(frameEl, 'frame'))) return null;
    // Per-iframe realm already built → its global is the frame window.
    const realm = frameRealmOf(frameEl);
    if (realm != null && !(commit && frameNavHas(frameEl, FN_COMMIT_PENDING))) {
      try {
        return globalThis.RustyRacer.contextGlobal(realm);
      } catch (_) {
        // The realm was disposed — the frame's containing document navigated
        // away / was discarded (disposeFrameRealmForNav recursively disposes
        // descendant realms). A reference still held to this detached frame
        // reads a null browsing context rather than throwing "unknown context".
        return null;
      }
    }
    // Re-entrancy guard: building this frame's realm can, as a side effect, read
    // a property that resolves back to this same frame's contentWindow (e.g. an
    // enumeration of the parent document that touches the frame's own name),
    // which would call __csimFrameWindow(frameEl) again before its realm is
    // set — an unbounded rebuild loop. A re-entrant call during
    // the build returns null (the realm isn't ready yet) instead of recursing.
    // (…a mark the engine clears where a termination skips the `finally` below: unload_walks.rs `end_left_open_since`)
    if (!globalThis.__dom.frameBuildBegin(nidOf(frameEl))) return null;
    // Any build that gets past the SW-activation defer below clears the shelved
    // marker — a deferred frame whose src is REASSIGNED (re-navigation to an
    // out-of-scope URL, or to srcdoc) must not keep suppressing its element
    // `load` in the connect path. The defer re-sets it.
    setFrameNav(frameEl, FN_DEFERRED_SW, false);
    try {
    // (…its document asked first whether it may be unloaded, where it still is to be, before anything is fetched: a frame a
    // handler of it removed goes no further)
    if (commit && !globalThis.__csimFramePrompted(frameEl)) return null;
    // The response its document is made of — where it loads it from, what that says of the document, its origins and
    // sandboxing flags — the engine's (frame_response.rs `frameResponse`), the network's chain the host's: its initial
    // about:blank document's where the build its navigation queued has not run yet (`FN_BUILD_QUEUED`), that build
    // committing over it — HTML navigates the frame in parallel, its window the initial one's until the response is in.
    // (…an app's cross-origin embed's too, which is not built as it connects: read while its navigation is under way, it
    // is built from then on, its navigation begun again as one that is — `frameWindowRead`)
    const read = !commit && realm == null && !frameNavHas(frameEl, FN_BUILD_QUEUED) && isConnected(frameEl)
      && typeof globalThis.__csim_createFrameRealm === 'function' && globalThis.__dom.frameWindowRead(frameEl, allHostsLocal());
    const initial = read || (!commit && realm == null && frameNavHas(frameEl, FN_BUILD_QUEUED));
    const answer = globalThis.__dom.frameResponse(frameEl, subresourceHost, initial);
    if (answer[0] === FRAME_DEFERRED) return null;
    if (answer[0] === FRAME_KEPT) return realm == null ? null : globalThis.RustyRacer.contextGlobal(realm);
    const [, frameUrl, frameLocationHref, , , , frameAboutBase, frameClientId, frameReferrer, framePolicyHeader,
      frameRefreshHeader, frameDocOrigin, frameLocationOrigin, frameSandbox, frameOriginAgentCluster] = answer;
    let [, , , body, contentType, jsUrlSource] = answer;
    // A javascript: URL navigating a frame that has a document — its initial about:blank, made as its window was read —
    // is evaluated in that document (HTML "navigate" → "evaluate a javascript: URL"): no commit, its content, listeners
    // and Window kept, a string result the markup of the document that replaces it (Chrome: what the parent wrote into it
    // stays for `javascript:void 0`).
    if (realm != null && jsUrlSource != null && frameNavHas(frameEl, FN_COMMIT_PENDING)) {
      const win = globalThis.RustyRacer.contextGlobal(realm);
      const result = win.__csimScriptsSandboxed() ? null : win.__csimEvaluateJavascriptSource(jsUrlSource);
      if (typeof result !== 'string') {
        setFrameNav(frameEl, FN_COMMIT_PENDING, false);
        return win;
      }
      [body, contentType, jsUrlSource] = [UTF8.encode(result), 'text/html;charset=utf-8', null];
    }
    // The response is in: the document the frame is navigating away from is unloaded now (HTML: once the navigation's
    // response is in, before the new document is created), and a frame a handler of its removed takes none — its Window
    // kept, where that document is its initial about:blank and the response's of its origin (HTML "create and initialize
    // a Document object": `__csimKeepsWindowFor`), for the new document to load into (`__csim_reuseFrameRealm`).
    const committing = frameNavHas(frameEl, FN_COMMIT_PENDING);
    const keeps = committing && realm != null && typeof globalThis.__csim_reuseFrameRealm === 'function'
      && globalThis.RustyRacer.contextGlobal(realm).__csimKeepsWindowFor(frameLocationHref, null, frameDocOrigin ?? undefined);
    if (committing && !globalThis.__csimCommitFrameNavigation(frameEl, keeps)) return null;
    if (!initial) globalThis.__dom.frameSrcdocCommits(nidOf(frameEl));

    // Real nested browsing context: a separate realm (own global + intrinsics)
    // built by the host, running the frame's own scripts. The frame window is
    // that realm's global; cross-realm refs (`frames[i].DOMParser` / `.Function`
    // / `.onerror`) resolve per spec because each realm is distinct.
    if (typeof globalThis.__csim_createFrameRealm === 'function') {
      // The realm that owns this iframe — `__csimFrameWindow` runs in it, so
      // `contextOf(globalThis)` is the parent's context id. Passing it lets
      // `create_frame_realm` wire `window.parent` / `window.top` to the TRUE
      // parent (not unconditionally the main frame) BEFORE the frame's scripts
      // run, so a nested frame's load-time `window.parent.document` is correct
      // (Capybara's nested close-frame fixtures depend on this).
      const parentId = globalThis.__csimRealmId();
      // The container itself (its nid): create_frame_realm links the new realm to its
      // navigable BEFORE the document loads (navigables.rs) — its `window.name`, the
      // name the navigable has (its container's `name` the first time), and its
      // `frameElement` already there for a load handler that identifies itself by
      // either (declarative-shadow declarative-child-frame).
      // …and what the container gives the document, measured HERE, in the parent realm (`frameSeed`).
      const { viewport: frameViewport, margins: frameMargins } = frameSeed(frameEl);
      const id = keeps
        ? globalThis.__csim_reuseFrameRealm(realm, frameLocationHref, body, contentType, parentId, frameDocOrigin, frameLocationOrigin, jsUrlSource, frameAboutBase, frameViewport, frameClientId, frameMargins, frameSandbox, frameReferrer, framePolicyHeader, frameRefreshHeader, frameOriginAgentCluster)
        : globalThis.__csim_createFrameRealm(frameLocationHref, body, contentType, parentId, nidOf(frameEl), frameDocOrigin, frameLocationOrigin, jsUrlSource, frameAboutBase, frameViewport, frameClientId, frameMargins, frameSandbox, frameReferrer, framePolicyHeader, frameRefreshHeader, frameOriginAgentCluster);
      if (id != null) {
        const win = globalThis.RustyRacer.contextGlobal(id);
        // (…its navigable's initial about:blank, made for a navigation whose response is not in yet: what that
        // navigation, to a document of its origin, keeps the Window of — `__csimKeepsWindowFor`. KNOWN GAP: the initial
        // about:blank of a frame with no URL to go to, whose load fired as it was inserted, is not marked so, its Window
        // made anew by a later navigation, where HTML keeps it: Chrome 156 and Firefox 159 make a new one too, measured
        // 2026-11-01, and keeping it here would keep its Document object as well — the gap CLAUDE.md lists — which
        // `Window-document.html` and the per-document `history` / `customElements` tests hold to be a new one.)
        if (initial) {
          setFrameNav(frameEl, FN_COMMIT_PENDING, true);
          win.__csimMarkInitialAboutBlank();
          if (read) maybeFireFrameLoad(frameEl);
        }
        // The viewport was seeded pre-load (above). Re-push it here where the container's content box is no longer what
        // the frame was handed — measured again now, its load having run — the child's layout must never PULL it across
        // the realm boundary: layout runs on the page's own getBoundingClientRect path, and re-entering a realm from
        // inside that callback trips a V8 stack assertion (IsOnCentralStack) — a hard crash. We're in the parent realm
        // here, so measuring the container is free and safe.
        try {
          const vp = frameContentBox(frameEl);
          if (globalThis.__dom.frameViewportMoved(id, vp ? vp.width : null, vp ? vp.height : null)) win.__csimFrameViewportChanged(vp);
        } catch (e) {}
        // (frameDocOrigin is seeded INSIDE create_frame_realm before the frame's
        // document loads — see __csimSetDocumentOrigin — so load-time scripts read
        // the right self.origin; nothing to set here.)
        return win;
      }
    }

    return null;

    } finally { frameBuilt(frameEl); }
  };

  // Replay the frame builds this realm parked on a still-activating service worker
  // (the {deferred} branch above). Broadcast by the host when the activation state
  // changed — the worker activated, died, or its scope was unregistered — and run in
  // a task of its own: the broadcast arrives mid-drain, where a synchronous realm
  // build re-enters the engine (the same reason WindowClient.navigate is queued).
  // A frame that navigated/built by other means meanwhile is skipped; one whose
  // scope is STILL activating (a different worker) simply re-defers.
  globalThis.__csim_swRetryDeferredNavs = function () {
    // (…the engine's, in the order they were parked, each parked until its replay runs: frame_navigation.rs
    // `takeSwDeferredFrames`)
    const els = globalThis.__dom.takeSwDeferredFrames().map((nid) => globalThis.__dom.nodeOf(nid));
    if (!els.length) return;
    globalThis.__csimSetTimeout(() => {
      for (const el of els) {
        if (!el) continue;
        setFrameNav(el, FN_DEFERRED_SW, false);
        if (!isConnected(el)) continue;
        // The full connect choreography — build the realm, then the element `load`
        // (its FN_LOAD_FIRED guard was re-armed when the build deferred). A scope
        // still activating under a DIFFERENT worker simply re-defers inside. An
        // element already BUILT meanwhile (a contentWindow touch after activation
        // beat this task) still comes through here: the build is idempotent and
        // the re-armed FN_LOAD_FIRED means ITS pending element `load` fires now;
        // a frame that navigated by other means set the guard and no-ops.
        try { maybeFireFrameLoad(el); } catch (_) {}
      }
    }, 0);
  };

  // A window realm's own state, made when the realm is (`V8Runtime#init_realm`), not in the snapshot it is made from — a
  // worker's realm is made from the same one: the Window's members (window.js), and its document — the html/head/body
  // skeleton every load grafts onto — whose nodes are made through the engine's node constructor (`__dom.NodeBase`,
  // which exists from the realm on), so even the skeleton is a wrapper of a handle; in the handle registry, which Ruby
  // finds a node by; and the Worker constructors.
  // …and its cross-origin isolated capability (`isolated`: platform-globals.js `setCrossOriginIsolated`).
  globalThis.__csimInitRealm = function (isolated) {
    setCrossOriginIsolated(isolated);
    const document = createHtmlPageDocument(true);
    holdRealmDocument(document);
    installWindowInterface(document);
    globalThis.__csim_installWorker();
  };
  // A pointer's move over the page with no button pressed: the pointer events PointerEvents — no button changed (-1),
  // no pressure — and their compatibility mouse events MouseEvents.
  function fireHoverEvent(node, type, init) {
    // (…a boundary event at a node a listener of one before it took out of the document goes nowhere — a pointerleave
    // handler removing the tooltip it leaves gets no mouseleave there after; Chrome)
    if (type !== 'pointermove' && type !== 'mousemove' && !isConnected(node)) return;
    const pointer = type.startsWith('pointer') && pointerEventInit({ __proto__: null, ...init, button: -1 }, 0);
    const ev = !pointer ? new MouseEvent(type, init)
      : type === 'pointermove' ? trustedPointerMove(node, pointer)
      : new PointerEvent(type, pointer);
    try { dispatchEventForUserAction(node, ev); } catch (_) {}
  }
  // Shared hover-target update: sets `document._hoverElement` so
  // `:hover` cascade matches resolve against this node, fires the
  // pointer/mouse over+enter sequence where the target changed and the
  // moves (bubbling through ancestors), AND fires pointerleave/mouseleave on the
  // previously-hovered chain up to the common ancestor — Float-kit
  // tooltips with default `untriggers: ["hover", "click"]` close on
  // pointerleave, so without this dispatch sequential hovers across
  // sibling tooltips leak the first one open. The chains are the
  // engine's (event_path.rs `hover_chains`): flat-tree element ancestors.
  function dispatchHover(n, opts) {
    opts = opts || {};
    const doc = globalThis.document;
    if (!doc) return;
    // (…the element hovered before, where it is in the document yet: a removed one is left by nothing)
    const prev = doc._hoverElement && isConnected(doc._hoverElement) ? doc._hoverElement : null;
    // (…what is at the pointer, where that is inside `n`: a real browser hovers the topmost box under it — `n` itself
    // where the caller hit-tested it already)
    const target = opts.resolved ? n : pointerTarget(n, opts.point || {});
    const changed = prev !== target;
    doc._hoverElement = target;
    // (…the elements left, innermost first, and entered, outermost first — none left where nothing was hovered)
    const [leave, enter] = globalThis.__dom.hoverChains(prev && changed ? nidOf(prev) : -1, nidOf(target));
    // (…every one at the pointer's position, with the keys held: `opts.point`)
    const point = opts.point;
    // (…the pointer's boundary events, then their compatibility mouse events — each the left side, out on the element
    // left and leave on each one left, then the entered side, over on the target and enter on each one entered, the
    // other side's element their relatedTarget: Pointer Events, Chrome)
    if (changed) {
      const outInit = { __proto__: null, bubbles: true, cancelable: true, relatedTarget: target, ...point };
      const leaveInit = { __proto__: null, bubbles: false, cancelable: false, relatedTarget: target, ...point };
      const overInit = { __proto__: null, bubbles: true, cancelable: true, relatedTarget: prev, ...point };
      const enterInit = { __proto__: null, bubbles: false, cancelable: false, relatedTarget: prev, ...point };
      for (const kind of ['pointer', 'mouse']) {
        if (prev) {
          fireHoverEvent(prev, kind + 'out', outInit);
          for (const el of leave) fireHoverEvent(el, kind + 'leave', leaveInit);
        }
        fireHoverEvent(target, kind + 'over', overInit);
        for (const el of enter) fireHoverEvent(el, kind + 'enter', enterInit);
      }
    }
    const moveInit = { __proto__: null, bubbles: true, cancelable: true, relatedTarget: null, ...point };
    fireHoverEvent(target, 'pointermove', moveInit);
    fireHoverEvent(target, 'mousemove',   moveInit);
  }
  // Ruby-callable hover dispatch: combines `_hoverElement` update +
  // the hover events (over / enter where the target changed, the moves
  // each time) in one host call so Ruby doesn't re-enter JS twice. The pointer moves to the element's centre, scrolled into
  // view first, as WebDriver's pointer move does.
  globalThis.__csimSetHover = function (h) {
    const n = lookup(h);
    if (!n) return false;
    ensureInView(n);
    const r = pointerRectOf(n);
    const x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
    dispatchHover(n, { point: { clientX: x, clientY: y, screenX: x, screenY: y } });
    return true;
  };
  // Take the planned submission (navigation_plan.rs) for the Ruby side: its request as it was submitted
  // (form-fields.js `__csimFormSerialize`), or null. Used by `Browser#consume_pending_form_submit` after each user action
  // that might have triggered `<select onchange="$('#f').submit()">`.
  globalThis.__csimTakePendingFormSubmit = () => globalThis.__dom.takeSubmission();
  // (…the navigation planned as the host takes it, the engine's: navigation_plan.rs — a new window's only, where `auxOnly`)
  function takePlannedNavigation(auxOnly) {
    const p = globalThis.__dom.takeNavigation(auxOnly);
    if (!p) return null;
    const [url, opensWindow, name, opener, referrerPolicy, blob, userActivated] = p;
    const nav = { url, opensWindow, name, opener, referrerPolicy, userActivated };
    if (blob) nav.blob = blob;
    return nav;
  }
  globalThis.__csimTakePendingNavigation = () => takePlannedNavigation(false);
  // Take a pending navigation ONLY if its target chose a new top-level navigable
  // (`opensWindow`) — the event-loop drain consumes these (a script-driven
  // `anchor.click()` with no Capybara action behind it), since opening an aux
  // window is safe mid-call (it builds a separate Browser, not the current one).
  // Same-window / frame navigations are left for the drain a task ends with
  // (`drain_task_intents`), outside any call into the page.
  globalThis.__csimTakePendingAuxWindow = () => takePlannedNavigation(true);
  globalThis.__csimTakePendingDownload = function () {
    const p = globalThis.__dom.takeDownload();
    return p && { url: p[0], filename: p[1], realm: p[2], policy: p[3] };
  };

  // Replace the document with a freshly-parsed one. Capybara's `visit`
  // ends up here. After parse, walk top-level `<script>` elements and
  // eval their bodies (inline) or route through the Rack-backed loader
  // (`<script src>` and `<script type=module>`).
  // HTML encoding sniffing's parent step: a document in a frame inherits its container document's encoding when the
  // two are of the same origin (a cross-origin parent's `origin` throws). A top-level window is its own parent.
  function inheritedEncoding() {
    try {
      const parent = globalThis.__csimParent;
      if (!parent || parent === globalThis.window) return null;
      // (…its encoding as the document keeps it, not through a `characterSet` getter its page may have replaced)
      return globalThis.__csimIsSameOriginWindow(parent.__csimRawWindow || parent) ? documentEncoding(parent.document) : null;
    } catch (_) {
      return null;
    }
  }

  // (…the parse's grafting phase over however it ends: a parse that throws must not leave dynamic `<script>` insertion
  // suppressed for the rest of the page)
  globalThis.__csimLoadDocument = function (html, contentType, refresh = null) {
    try { return loadDocument(html, contentType, refresh); } finally { __inHTMLGrafting = false; }
  };
  function loadDocument(html, contentType, refresh) {
    // (…the host's hooks attached since boot hidden too, before a script of the page can enumerate the window)
    hideDriverGlobals();
    // (…and what only a secure context has, as this document's environment is one or not: a realm kept for it may have been
    // the other)
    exposeSecureContextConstructs();
    // A document of its own starts loading, with an asset memo of its own on the host (`__csimExternalAsset`).
    setDocToken(typeof globalThis.__csimAssetDocumentStarted === 'function' ? globalThis.__csimAssetDocumentStarted() : null);
    // Each document lands here in a fresh realm — the snapshot's bridge and vendor bundle, no page script run yet —
    // whose `document` it fills: the page's, a frame's, an auxiliary window's (a `javascript:` URL frame's string
    // result loads into the frame's realm a second time, an initial about:blank's Window is kept for the document a
    // navigation to its origin makes): loading, its load lifecycle begun anew — `loading` for the whole parse, so a
    // custom element connected and a parser-blocking script run during it see it, not the last document's `complete`
    // (Forem's `base.js`: ahoy.js schedules `ahoy.start()` by `documentReady`, which would run before
    // `ahoy.configure` undid the test-env opt-out) — its last document's load delay none of its own (the engine's,
    // document_lifecycle.rs `docLoadBegin`).
    globalThis.__dom.docLoadBegin(nidOf(globalThis.document));
    // The previous page's outstanding subresource gates are moot — their elements belong to a document being replaced.
    globalThis.__dom.loadGatesForget();
    scriptsInOrder.length = 0;
    loadGateWork.clear();
    // …as is its map of preloaded resources: a new document's is empty (preload_map.rs)
    globalThis.__dom.preloadsForget(nidOf(globalThis.document));
    resetCascadeState();
    // Hover is per-visit transient state — cleared so a stale `_hoverElement` from the previous page can't keep matching
    // `:hover` cascade rules against detached nodes. (What the old page planned goes with the realm's reset as the new
    // page parses: navigation_plan.rs.)
    globalThis.document._hoverElement = null;
    // A markup-insertion guard stranded >0 (a write() aborted by V8 termination
    // skips its finally) would make every later write() on this reused document
    // throw — reset it with the other per-visit transients.
    globalThis.document._markupInsertionCounter = 0;
    // Drop the previous page's inert template document (an in-place reload —
    // frame navigations — reuses this Document object): it pins that page's
    // template-content trees alive, and the XML branch below can flip the
    // document's flavor while a cached text/html inert doc lingered.
    globalThis.document._inertTemplateDoc = null;
    // Scroll offset is preserved on `documentElement` across SPA route
    // changes (so Discourse's route-scroll-manager can restore it on
    // `page.go_back`); a full-document visit resets it like a new tab.
    const __root = documentElementOf(globalThis.document);
    if (__root) setScrollOffset(__root, 0, 0);
    // The document's environment is a service-worker client from its creation, before any of its scripts runs — one
    // that posts to a worker while it loads is a client that worker's Clients find (its URL and origin are set by now;
    // the host refreshes the record once it has loaded). A report that fails loses only the report, not the load.
    try { globalThis.__csim_swReportClient(); } catch (_) {}

    // The document's encoding (the live document is reused across visits, so it is set on every load): a document
    // arriving as BYTES — a response, a data: or blob: URL — is decoded here, where its parent is at hand, as HTML's
    // encoding sniffing decides (natively; a frame's document inherits its parent's, `inheritedEncoding`). One
    // arriving as text is a string to begin with (`srcdoc`, about:blank, a javascript: URL's result): UTF-8.
    let encoding = 'UTF-8';
    if (ArrayBuffer.isView(html)) [html, encoding] = globalThis.__dom.decodeDocument(html, String(contentType || ''), inheritedEncoding());
    globalThis.document._encoding = encoding;
    // document.lastModified from the response Last-Modified header (epoch ms,
    // set by __csimBootContext before this load so inline scripts observe it);
    // null → the getter falls back to the current time — an XML document's as an HTML one's.
    const __lm = pendingLastModified;
    globalThis.document._lastModified = (__lm != null && !isNaN(__lm)) ? __lm : null;
    pendingLastModified = null;
    // …and its referrer, its navigation's (`__csimBootContext`, a frame's `__csimSetPendingReferrer`): none for one no
    // navigation that sent one made — and the referrer policy it begins with, its response's `Referrer-Policy` header's,
    // or the policy container it clones (a srcdoc or initial about:blank document its creator's, a javascript: URL's
    // result its frame's): a previous document's no part of it.
    globalThis.document._referrer = pendingReferrer ?? null;
    pendingReferrer = null;
    globalThis.__dom.inheritReferrerPolicy(nidOf(globalThis.document), pendingReferrerPolicy ?? '');
    pendingReferrerPolicy = null;
    // …and its declarative refresh: a previous document's none — the timer it set dies with its tasks — and the
    // `Refresh` header its response has (`refresh`) the first to say one, before any `<meta>` it parses: HTML "create and
    // initialize a Document object"
    afterLoad.length = 0;
    globalThis.__dom.forgetDeclarativeRefresh(nidOf(globalThis.document));
    if (refresh != null) declarativeRefresh(refresh, false);

    // XML / XHTML documents: parse with the XML rules (no implicit
    // html/head/body skeleton, case-sensitive tags, namespaced attributes) and
    // replace the live document's tree wholesale rather than grafting into a
    // skeleton. Scripts still run — XHTML test files carry <script src> +
    // inline scripts — and the document keeps its identity (and content type),
    // so it reports `isHtmlDocument` false (case-sensitivity, createCDATASection,
    // namespace lookups).
    const __ct = contentTypeEssence(String(contentType || '')) ?? '';
    const kind = globalThis.__dom.documentKind(__ct);
    if (kind === DOCUMENT_XML) {
      __inHTMLGrafting = true;
      invalidateArena();   // a new page: a fresh arena, as the HTML parse starts one (parseHtmlIntoLive)
      syncTargetFragment();
      const dx = globalThis.document;
      // Drop the previous tree, its removing steps run (as every other mutation path runs them), and parse into it.
      for (const c of clearEdges(dx)) subtreeRemoved(c);
      dx._contentType = __ct;
      parseXmlInto(dx, html);
      // Connect the parsed tree (custom-element upgrades + deferred iframe /
      // link `load`). Still in the grafting phase so `<script>` bodies aren't
      // run here — theEnd executes them in order just below, and the
      // deferred load microtasks fire after, once handlers are registered.
      globalThis.__csimFireCEConnect(dx);
      rebuildCascade();
      __inHTMLGrafting = false;
      theEnd(dx);
      return handleOf(dx);
    }

    if (kind === DOCUMENT_TEXT) html = textDocumentMarkup(html);

    __inHTMLGrafting = true;
    const srcHtml = String(html == null ? '' : html);
    const d = globalThis.document;
    // A document reports the response MIME as `document.contentType` — including
    // a frame loading a non-HTML resource (text/css, text/plain) and a direct
    // navigation to one (Discourse's `become.json` sign-in). Such a response is
    // still HTML-PARSED here (wrapped in <html><body>) and keeps HTML semantics:
    // `isHtmlDocument` keys on whether the doc was XML-PARSED (XML MIME), NOT on
    // this contentType, so the reflection is decoupled from find/XPath casing.
    // Set it on EVERY load (the live `d` is reused across visits) so a prior
    // non-HTML contentType can't leak onto a later HTML page; `__ct` is '' when
    // unspecified → 'text/html'.
    d._contentType = __ct || 'text/html';
    __streamPendingConnect = [];
    __streamCascadeDirty = __streamSheetsStale = __streamSheetFetched = false;
    // Parse the response directly into the live document, REUSING its
    // <html>/<head>/<body> identities: library IIFEs (jQuery 3.x) capture
    // `document.documentElement` at eval time, so replacing the skeleton would
    // strand them. The parse drops the prior tree, rebuilds the prolog, quirks flag
    // (`compatMode`), skeleton opening-tag attributes (Redmine's
    // `body.controller-X.action-Y` cascade scoping), and the full tree. The
    // streaming hooks (`__streamHooks`) interleave it with execution the way a
    // real browser does: each parser-blocking classic <script> runs inline at
    // its `</script>` against the partial, connected tree, and per-insertion
    // MutationObserver records fire once a parse-time observer exists.
    parseHtmlIntoLive(d, srcHtml, __streamHooks);
    // Connect / upgrade the tail — everything appended after the last inline
    // script (or the whole tree when the page authored no parser-blocking
    // script). The streaming `onScript` already connected each earlier segment.
    drainStreamConnect();
    // Final cascade for the complete tree. Content-keyed, so it's a no-op when a
    // parse-time rebuild already covered the authored stylesheets; it backstops
    // pages whose styles arrived after the last (or with no) inline script.
    rebuildCascade();
    __inHTMLGrafting = false;
    // Run the deferred remainder — modules + external defer/async — and anything
    // the streaming handler skipped; scripts already executed inline are skipped
    // via their `_scriptRun` flag.
    theEnd(d);
    // Flip the dynamic-script gate on: post-load <script> appends
    // (Rails-UJS dataType:'script' eval into head, jQuery .html() of
    // a fragment containing <script>) will now run via the
    // fireCEConnect → maybeRunScript path.
    return handleOf(globalThis.document);
  }

  // What the document about to load begins with, told before it loads (`__csimBootContext`, `__csimSetPendingReferrer`)
  // and taken as it does (`__csimLoadDocument`): its Last-Modified time, its referrer and the referrer policy it begins
  // with.
  let pendingLastModified = null, pendingReferrer = null, pendingReferrerPolicy = null;
  // (…the document it has loading, for the host: v8_runtime.rb `asset_document_of`)
  globalThis.__csimDocumentToken = docToken;
  // The referrer of the document a frame realm is about to load (v8_runtime.rb `create_frame_realm`) — and the one its
  // document has, which a session history entry made of it keeps (browser.rb `frame_entry`).
  globalThis.__csimSetPendingReferrer = (referrer, policy = null) => {
    pendingReferrer = referrer || null;
    pendingReferrerPolicy = policy || null;
  };
  globalThis.__csimDocumentReferrer = () => globalThis.document._referrer ?? '';
  // The Ruby↔V8 round-trip floor is ~4 ms per call. Running
  // the per-visit setter chain as 7 sequential calls cost ~28 ms of
  // pure overhead per visit; collapsing them into one payload is safe
  // because every setter is idempotent and order-insensitive past
  // `__csimLoadDocument`.
  globalThis.__csimBootContext = function (opts) {
    globalThis.__dom.setTouchInput(!!opts.touch);
    // (…the size the document is LOADED into, which is no resize of it: the resize steps take their first size from
    // there)
    if (typeof opts.viewportW === 'number' && typeof opts.viewportH === 'number') {
      globalThis.__dom.viewportSet(opts.viewportW, opts.viewportH, true);
      invalidateLayout();
    }
    globalThis.__csimSetTraceActive(!!opts.traceActive);
    globalThis.__csimSetTimezone(opts.timezone || '');
    // (…its time origin, now: the host's wall clock, or the last page's `Date` where that ran ahead of it — with the host's
    // clock's offset, `travel_to`'s)
    if (typeof opts.clockEpochMs === 'number') globalThis.__csimSetClockEpoch(opts.clockEpochMs, 0, 0, opts.timeTravelOffsetMs);
    if (opts.url) globalThis.__csimUpdateLocation(opts.url);
    // (…an about:blank document its initiator's origin and base URL: `inherit_creator`)
    if (opts.creatorOrigin) {
      if (opts.aboutBase) globalThis.__csimSetAboutBaseURL(opts.aboutBase);
      globalThis.__csimSetDocumentOrigin(opts.creatorOrigin);
      globalThis.__csimSetLocationOrigin(opts.creatorOrigin);
    }
    // `document.lastModified` reflects the response Last-Modified header (parsed
    // to epoch ms). Stash it BEFORE the load so __csimLoadDocument applies it to
    // the document before inline scripts (which may read document.lastModified)
    // run; an absent/unparseable header leaves lastModified at the current time.
    pendingLastModified = opts.lastModified ? IntrinsicDate.parse(opts.lastModified) : null;
    pendingReferrer = opts.referrer || null;
    if (opts.referrerPolicy) pendingReferrerPolicy = opts.referrerPolicy;
    // (…and, a document a reload or a traversal makes, its entry's classic history API state before its scripts run)
    if ('historyState' in opts) globalThis.__csimSetHistoryState(opts.historyState);
    // (…its origin an opaque one where its window's popup sandboxing flag set or its response's Content-Security-Policy
    // sandboxes it — HTML "determine the origin", a top-level document's as a frame's: realm_location.rs `pageSandbox` —
    // and the service worker its navigation matched, its controller before any of its scripts asks: the reserved client
    // the navigation made is the one it controls, as a frame's is (v8_runtime.rb `create_frame_realm`), none for an
    // opaque origin)
    const sandbox = globalThis.__dom.pageSandbox(opts.csp ?? null);
    if (sandbox !== 0) globalThis.__dom.setSandbox(sandbox);
    if (opts.controller) globalThis.__csim_swSetControllerDirect(...opts.controller);
    // (…an error document's a new opaque one)
    if (opts.opaqueOrigin) globalThis.__csimSetDocumentOrigin('null');
    // (…and its agent, its origin known — an origin-keyed one's where its response asked for it: realm_location.rs
    // `origin_keyed_cluster`)
    globalThis.__dom.obtainAgentCluster(opts.originAgentCluster === true);
    return globalThis.__csimLoadDocument(opts.html, opts.contentType, opts.refresh ?? null);
  };

  // A task "the end" queues for this realm's document — its DOMContentLoaded, its load — for the document it loads now
  // (`generation`, the engine's number of it: a reused realm's next document, an initial about:blank's Window kept for
  // the document of its origin a navigation makes, a document opened again, owes its own), which the engine says is due
  // as it runs (document_lifecycle.rs): a task of the page's event loop for a window `window.open` made in its isolate
  // (one event loop for an agent's windows: window.js `__csimQueueTaskOfTheEnd`) — ahead of the tasks due with it, the
  // DOMContentLoaded one, and the load one of a window's own event loop where nothing delays the load as it is queued
  // (timers.rs `AHEAD`: once each, so nothing starves).
  const END_CONTENT_LOADED = 0, END_LOAD = 1;
  function queueTaskOfTheEnd(step, generation) {
    if (globalThis.__dom.isSteppedWindow()) {
      globalThis.RustyRacer.contextGlobal(0).__csimQueueTaskOfTheEnd(globalThis.__csimRealmId(), step, generation, step === END_CONTENT_LOADED);
    } else {
      const ahead = step === END_CONTENT_LOADED || !globalThis.__dom.loadDelayedNow();
      queueTask(() => globalThis.__csimTaskOfTheEnd(step, generation), 0, ahead);
    }
  }
  // HTML "the end" step 6, its DOMContentLoaded task — and then, steps 7-9, the task of its load, queued as that one
  // ends: after what its DOMContentLoaded handlers queued (a message one posts its opener is heard before the load, as
  // Firefox 159 has it — Chrome 156 fires the load first; HTML lets the event loop choose), after the timers and the
  // messages its parse queued. Once nothing delays it, its task — its readiness complete, its load, its `pageshow`
  // (`__csimFireWindowLoad`); one its images or its frames delay set delayed by that task and fired as a task again once
  // nothing does (`__csimLoadBlockerSettled`). A written document's load (one `document.open()` made loading) owes its
  // container's load too, where it was not muted (`DUE_WRITTEN`).
  const DUE_PARSED = 1, DUE_WRITTEN = 2;
  globalThis.__csimTaskOfTheEnd = (step, generation) => {
    const doc = globalThis.document;
    if (step === END_CONTENT_LOADED) {
      fireContentLoaded(generation);
      queueTaskOfTheEnd(END_LOAD, generation);
      return;
    }
    const due = globalThis.__dom.docLoadDue(nidOf(doc), generation);
    if (due !== 0) fireLoadTask(due === DUE_PARSED ? null : due === DUE_WRITTEN);
  };
  // …DOMContentLoaded at the document, where it is due.
  function fireContentLoaded(generation) {
    const doc = globalThis.document;
    if (!globalThis.__dom.docContentLoadedDue(nidOf(doc), generation)) return;
    try { fireEvent(doc, new Event('DOMContentLoaded', { __proto__: null, bubbles: true, cancelable: false })); } catch (_) {}
    // (…and, in the same task, its ServiceWorkerContainer's client message queue enabled: HTML "the end")
    enableClientMessageQueue();
    globalThis.__dom.docContentLoadedEnd(nidOf(doc));
  }
  // HTML "the end" for the document its parser ended (steps 3-6): its parser's scripts no end tag ran, its readiness
  // `interactive`, its deferred scripts, and its DOMContentLoaded queued.
  function theEnd(doc) {
    // (…none of a document whose parser was aborted, nor what it had listed: HTML "abort a parser", "abort a document"
    // cancelling its scripts' fetches)
    if (globalThis.__dom.docParserAborted(nidOf(doc))) {
      forgetParserScripts();
      finishAbortedParser(doc);
      return;
    }
    // (…"the end" of a document with no element at all too — an empty XML one, a parse error — which runs no script)
    const root = documentElementOf(doc);
    // Snapshot to a plain array: running a script must not let it perturb the bounds of the loop iterating the script
    // set (e.g. a script that injects more scripts) — the engine's, its parser's scripts no end tag decided, in tree
    // order (script.rs `parser_scripts`), a plain array, not a NodeList or an HTMLCollection, whose length a page can
    // tamper through its prototype (NodeList-static-length-getter-tampered-3.html does, mid-parse under streaming).
    const scripts = root ? globalThis.__dom.parserScripts(nidOf(root)) : [];
    // A parse that handed NO scripts to a handler (the XML parser) leaves this pass to stand in for their end tags, in
    // tree order, while the document is still 'loading': its parser-blocking ones and its import maps run, the others go
    // on the list — each as its turn comes, where an earlier one's script may have removed it.
    for (const s of scripts) {
      if (s._scriptRun) continue;
      if (isParserBlockingScript(s) || scriptTypeOf(s) === SCRIPT_IMPORT_MAP) runOneScript(s, BY_PARSER);
      else globalThis.__dom.listParserScript(nidOf(s));
    }
    // …and then "the end": 'interactive' FIRST (firing readystatechange), then the deferred scripts, then
    // DOMContentLoaded — so a `defer` or module script sees 'interactive' (Chrome and Firefox), where this ran them
    // while it still said 'loading'. 'complete' comes with the window's load (`__csimFireWindowLoad`). (The engine's
    // update: document_lifecycle.rs `docTheEnd`.)
    if (globalThis.__dom.docTheEnd(nidOf(doc))) readinessChanged(doc);
    // The list of scripts to execute after parsing, in the order their end tags put them on it (script.rs
    // `takeParserList`): modules, `defer` / `async` — the PARSER's scripts only (one a script inserted ran, or never
    // runs — an innerHTML fragment's, a clone of a started script — on its own terms), and each whether or not an
    // earlier one removed it since (`BY_PARSER_LIST`) — but not one moved into another document: "execute the script
    // element" returns where its node document is not its preparation-time one, this parse's.
    // (…the `async` ones not on it: `landAsyncScripts`, those the parser's waits have landed first, and the rest where one of
    // these has it wait on a fetch)
    landAsyncScripts(doc);
    for (const s of globalThis.__dom.takeParserList()) {
      if (globalThis.__dom.docParserAborted(nidOf(doc))) return forgetParserScripts();
      if (s._scriptRun || s._ownerDocument !== doc) continue;
      if (attrsOf(s).src) landAsyncScripts(doc, globalThis.__dom.takeParserAsync());
      if (globalThis.__dom.docParserAborted(nidOf(doc))) return forgetParserScripts();
      runOneScript(s, BY_PARSER_LIST);
      if (globalThis.__dom.docParserAborted(nidOf(doc))) return forgetParserScripts();
    }
    // …and those it never waited for: what DOMContentLoaded does not wait for, each a task of its own after it, ahead of the
    // load, which does.
    for (const s of globalThis.__dom.takeParserAsync()) {
      if (s._scriptRun || s._ownerDocument !== doc) continue;
      pendingExternalScripts++;
      subresourceLoadTask(s, () => {
        pendingExternalScripts--;
        if (!globalThis.__dom.docParserAborted(nidOf(doc))) runOneScript(s, BY_PARSER_LIST);
      }, 0);
    }
    if (hasObservers() && hasQueuedRecords()) deliverMutations();
    // …then DOMContentLoaded, as a task (HTML "the end" step 6).
    queueTaskOfTheEnd(END_CONTENT_LOADED, globalThis.__dom.docState(nidOf(doc), DOC_GENERATION));
  }
  // An `async` script's fetch takes no time here, so what tells whether it has landed is whether its parser has had to wait
  // on a fetch at all — a parser-blocking script's, a sheet's that blocks a script (`parserWaitsOnFetch`), a script's on the
  // list of scripts to execute after parsing — in which browsers' fetches of what is parsed, and of what their scanners see
  // ahead, have the time to land. One whose parser has runs before DOMContentLoaded, and a DOMContentLoaded listener it adds
  // hears it; one whose parser has not runs after it. Chrome and Firefox agree on both families (rvfn `l_listener_sync`,
  // `d_sync_*`, `d_defer`, `e_mix*`, and `d_fast`, `z3_asy_fast`, `d_module`, 2026-11-06). Where among the parser's own scripts
  // they part, and the place here is Firefox's, at the end of the parse: a blocking script's `stop()` cancels it, which both
  // do (`h_ext_asy`).
  function landAsyncScripts(doc, due = globalThis.__dom.takeParserAsync(true)) {
    for (const s of due) {
      if (globalThis.__dom.docParserAborted(nidOf(doc))) return;
      if (!s._scriptRun && s._ownerDocument === doc) runOneScript(s, BY_PARSER_LIST);
    }
  }
  function forgetParserScripts() {
    globalThis.__dom.takeParserList();
    globalThis.__dom.takeParserAsync();
  }
  // Run ONE <script> per the HTML "execute the script element" steps: type
  // dispatch (an import map registered; module → deferred module eval;
  // classic inline / external-src). Shared by the after-parse `theEnd`
  // loop and the streaming `scriptHandler` (which runs classic parser-blocking
  // scripts inline at `</script>`). `_scriptRun` records that this element's
  // script actually ran so the after-parse pass doesn't re-run it; `_alreadyStarted`
  // additionally gates the dynamic-append path (`maybeRunScript`).
  function runOneScript(s, by) {
    // HTML "prepare the script element" for the parser's script, as far as the element decides it — the engine's
    // (script.rs `prepare_script`): its type, a classic one's `nomodule` (the other half of differential serving), an
    // empty `src` (a failed load, its `error` on a task), its having run, being connected — at its end tag (`BY_PARSER`),
    // not out of the after-parse lists (`BY_PARSER_LIST`) — and scripting being enabled; one it returned from before it
    // was "already started" (nothing in it yet, a type that runs nothing) left preparable by a later change.
    const action = globalThis.__dom.prepareScript(nidOf(s), !s._ownerDocument._noBrowsingContext, by);
    if (action === PREPARE_NONE) return;
    if (action === PREPARE_ERROR) {
      globalThis.__csimSetTimeout(() => dispatchScriptLoad(s, false), 0);
      return;
    }
    // (…an import map the parse did not prepare at its end tag — the XML parser's)
    if (action === PREPARE_IMPORT_MAP) return registerImportMap(s);
    if (action === PREPARE_MODULE) {
      runModuleScript(s);
      flushMutationDelivery();
      return;
    }
    let body;
    if (attrsOf(s).src) {
      // (…its src resolved against THIS document's base — the host fn resolves a relative URL against the MAIN document
      // (resolve_against_current), which is another directory for a subframe: same unify as fetch()'s relative-URL fix,
      // 1b9de029 — an unresolvable one kept as the raw attribute)
      const url = resolveURLValue(s, attrsOf(s).src);
      // (…its `load` / `error` fired as the parser runs it — HTML "execute the script element": at once, before the
      // parser goes on, Chrome and Firefox alike — as a script that ran fires its `load`; marked executed first, so the
      // after-parse `theEnd` pass doesn't process it again and fire a SECOND event)
      const settle = (ok) => { s._alreadyStarted = true; s._scriptRun = true; scriptEventDone(s, ok); };
      // (…from the cross-visit asset cache: fingerprinted app bundles a fresh VM per visit does not fetch again, as a
      // browser HTTP-caches them; its Resource Timing entry sized by its source text where the cache kept no facts. An
      // empty script is a loaded one, as an empty body's is — Chrome, Firefox: `load` — not an inline one still waiting
      // for its text. A failed one's `error` fires at once, as a run one's `load` does.)
      const doc = globalThis.document, aborts = globalThis.__dom.docAborts(nidOf(doc));
      if (by === BY_PARSER && isParserBlockingScript(s)) globalThis.__dom.parserWaitsOnFetch();
      const [ok, fetched, entry] = globalThis.__dom.fetchClassicScript(nidOf(s), nidOf(s._ownerDocument), url, true, subresourceHost) ?? [false, '', null];
      // (…nothing of a fetch an abort cancelled as its server took its time: HTML "abort a document", "discarding any tasks
      // queued for them")
      if (aborts !== globalThis.__dom.docAborts(nidOf(doc))) return;
      if (entry) globalThis.__csimRecordResource(entry);
      if (!ok || fetched === '') return settle(ok);
      body = fetched;
    } else {
      body = childTextContent(s);
    }
    // (…its throw logged with where it was, where no listener cancelled its `error` event. KNOWN NARROW GAP: the
    // checkpoint drains to exhaustion, so a microtask queued by a parser-fired custom-element connectedCallback (run by
    // drainStreamConnect between the previous script and this one, where the MO-only checkpoint at the scriptHandler
    // doesn't drain Promise jobs) runs with `currentScript` this script, whereas a real browser would have run it at
    // stack-empty with currentScript null. No WPT subtest / app flow exercises a CE callback reading currentScript from
    // a microtask; fixing it would need a second full checkpoint after drainStreamConnect.)
    s._alreadyStarted = true;
    s._scriptRun = true;
    executeClassicScript(s, body, attrsOf(s).src ? (resolveURLValue(s, attrsOf(s).src) ?? attrsOf(s).src) : null, true, (e, filename) => globalThis.__csimReportException(e, (ev) => {
      const where = attrsOf(s).src || ('(inline) ' + body.slice(0, 120).replace(/\s+/g, ' '));
      logError('[csim] script threw in', where, ':', thrownDetail(e, ev));
    }, { filename, lineno: 1, colno: 1 }));
    // (…`load` for one from an external file, whatever it threw: HTML "execute the script element")
    scriptEventDone(s, true);
  }
  // A parser-run script's `load` (`ok`) or `error`, fired — and then what its handlers queued: HTML "clean up after
  // running a callback", the stack empty, performs a microtask checkpoint before the parser goes on (Chrome: a promise
  // its onload resolved settles before the next script runs), and the MutationObserver records the dispatch produced
  // are delivered.
  function scriptEventDone(s, ok) {
    dispatchScriptLoad(s, ok);
    // (…the stack empty only where no script runs beneath the parser: one a script's `document.write` parsed — or a frame
    // its parent's script built — leaves the checkpoint to that script's own cleanup)
    if (scriptDepth === 0 && !scriptOnStack()) {
      try { const y = globalThis.__csim_yield; if (y) y(); } catch (_) {}
    }
    flushMutationDelivery();
  }
  // The SW fetch context a module graph's source fetches carry (a CONTROLLED
  // document's module loads dispatch fetch events, destination 'script', mode
  // 'cors'): [controllerHandle, clientId, referrer, credentials, rootIntegrity, referrer policy].
  // Null when uncontrolled -- the Ruby side then fetches from the network as before.
  function moduleSwCtx(el) {
    const swCtrl = controllerHandle();
    if (!swCtrl) return null;
    const href = realmURL();
    const plan = globalThis.__dom.subresourcePlan(J_MODULE_SCRIPT, nidOf(el), nidOf(el?._ownerDocument));
    const [, credentials] = globalThis.__dom.subresourcePlanFields(plan);
    return [swCtrl, swClientIdOf(), href, credentials, (el && attrsOf(el) && attrsOf(el).integrity) || '', globalThis.__dom.requestReferrerPolicy(plan)];
  }
  // A module script run: its `src` encoding-parsed against its node document's base URL — one that is no URL its
  // `error` — or its inline text, whose base URL that is; `error` too where its graph could not be fetched (the host's
  // false), an inline one's as an external one's (HTML "execute the script element": a null result), `load` where it
  // ran, a throw in it — or its graph's error to rethrow — reported. (…`url` its `src` as it was prepared, undefined for an
  // inline one, null for one that is no URL; `source` an inline one's text as it was prepared, where that is not the parser's)
  function runModuleScript(s, url = attrsOf(s).src ? resolveURLValue(s, attrsOf(s).src) : undefined, source = undefined) {
    const sw = moduleSwCtx(s);
    // (…its graph fetched under the referrer policy its `referrerpolicy` set as it was prepared and with the credentials
    // mode its `crossorigin` says — the engine's plan of its request, `requestPlanOf`)
    const [, credentials, policy] = globalThis.__dom.subresourcePlanFields(requestPlanOf(s, J_MODULE_SCRIPT)[1]);
    // (…its realm the entry realm while its graph runs: HTML "prepare to run script", as a classic one's)
    // (…none of it, and no event, where its document's abort cancelled its fetches as a server took its time, the host's to
    // ask as its graph is in: `__csimModuleCancelled`)
    const doc = globalThis.document, aborts = globalThis.__dom.docAborts(nidOf(doc));
    const evaluate = (url, body) => {
      let ran;
      const entry = globalThis.__dom.enterRealm(globalThis.__csimRealmId());
      const outer = globalThis.__dom.docModuleFetches(nidOf(doc), aborts);
      try {
        ran = ignoringDestructiveWrites(s._ownerDocument, () => (sw ? __csim_evalEsmEntry(url, body, policy, credentials, sw[0], sw[1], sw[2], sw[3], sw[4], sw[5])
                                                                    : __csim_evalEsmEntry(url, body, policy, credentials)));
      }
      catch (e) {
        try { logError('[csim] module', url, 'failed:', e && (e.stack || e.message)); } catch (_) {}
        return false;
      } finally {
        globalThis.__dom.docModuleFetches(nidOf(doc), outer);
        globalThis.__dom.exitRealm(entry);
      }
      if (Array.isArray(ran)) {
        reportModuleError(ran);
        return true;
      }
      return !!ran;
    };
    let ok;
    if (url !== undefined) {
      ok = url !== null && evaluate(url, null);
      if (aborts !== globalThis.__dom.docAborts(nidOf(doc))) return;
    } else {
      // (…a parser's listed one the source text its end tag found: script.rs `takeParserSource`)
      const body = source ?? globalThis.__dom.takeParserSource(nidOf(s)) ?? childTextContent(s);
      if (!body) return;
      // (…a module of its own, the document's base URL its `import.meta.url` — its fragment and all)
      ok = evaluate(documentBaseURL(s._ownerDocument) || 'inline://', body);
      if (!ok) fireEvent(s, new Event('error'));
    }
    // Resource Timing: file the entries for everything this graph fetched before the `load` event,
    // so a module's own load handler sees them (a browser adds the timing entry when the fetch
    // completes, ahead of the load). A dynamic `import()` has no runModuleScript after it — the host
    // `flush_module_rt` files those at the next driver read of `performance`.
    flushModuleRt();
    // A module script fires `load` (or `error`) on its element once the graph has
    // finished loading + evaluating, same as a classic external script. Routed
    // through dispatchScriptLoad so an external module honours its `?pipe=trickle`
    // delay; an inline module (none from an external file) no-ops there, unchanged.
    dispatchScriptLoad(s, ok);
  }
  globalThis.__csimModuleCancelled = () => globalThis.__dom.docModuleCancelled(nidOf(globalThis.document));
  // A module graph's error to rethrow (the host's `[name, message, filename, lineno]`: a module that could not be parsed,
  // a specifier that resolves to none, a link that failed) reported at the window, as HTML "run a module script" reports
  // it: an error of its kind made anew — of this realm's own constructors, taken as the bridge loaded, which no page
  // script can stand in for — with no stack of the driver's, at where V8 found it, the document at 0 for a specifier.
  const MODULE_ERRORS = { SyntaxError, TypeError, ReferenceError, RangeError };
  function reportModuleError([name, message, filename, lineno]) {
    const Kind = Object.hasOwn(MODULE_ERRORS, name) ? MODULE_ERRORS[name] : Error;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    let e;
    try { e = new Kind(message); } finally { Error.stackTraceLimit = limit; }
    const where = { filename: filename ?? realmURL(), lineno: lineno ?? 0, colno: 0 };
    globalThis.__csimReportException(e, () => logError(`Uncaught ${e.name}: ${e.message}`), where);
  }
  // Drain the module fetches the graph loaders collected host-side and file a 'script' Resource
  // Timing entry for each — the entry module and every module it imports, statically or via a
  // dynamic `import()` (each once per URL; `note_module_fetch` dedupes). Called after a
  // `<script type=module>` evaluates (so its graph is timed before the element's `load` fires) and
  // — via the host `flush_module_rt` before a script reads `performance` — for a dynamic import,
  // which has no runModuleScript after it.
  function flushModuleRt() {
    if (typeof globalThis.__csim_takeModuleRt !== 'function' || typeof globalThis.__csimRecordResource !== 'function') return;
    const mods = globalThis.__csim_takeModuleRt();
    if (!mods || !mods.length) return;
    const now = globalThis.__csimPerformanceNow();
    for (let i = 0; i < mods.length; i++) {
      // (…its fetch's times, the host's, as long ago as they were: a graph's every module filed after it evaluates)
      const { url, meta, answer, startAge, endAge } = mods[i];
      globalThis.__csimRecordResource({ name: url, kind: J_MODULE_SCRIPT, startTime: now - startAge, endTime: now - endAge, ...(answer ? { answer } : { resp: meta }) });
    }
  }
  globalThis.__csimFlushModuleRt = flushModuleRt;
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }


  // Capybara's `Session#evaluate_script` reaches here. Wrap the code
  // in a function so it sees `arguments[N]` and an implicit return
  // hands back the last expression. Args coming over the wire may
  // include `{__elementHandle: id}` sentinels (Capybara passing Node
  // instances); rehydrate them to live Element refs so user scripts
  // can call methods on them.
  // `eval(code)` inside the function body sees that function's
  // `arguments`, so user scripts referencing `arguments[i]` work the
  // same way as selenium / chrome. eval also handles statements vs
  // expressions uniformly — the `return <expr>` wrapping breaks the
  // moment a script starts with `var ...;` or similar. (…the realm's own
  // eval as it began, handed in as a parameter of the function around it, so
  // the call is still a direct one: a page's `window.eval` — or its `JSON` —
  // is no part of the driver's script)
  const __evalCache = new Map();
  const realmEval = eval;
  function compileScript(code) {
    let fn = __evalCache.get(code);
    if (!fn) {
      fn = new Function('eval', 'return function () { return eval(' + jsonStringify(code) + '); };')(realmEval);
      __evalCache.set(code, fn);
    }
    return fn;
  }
  // (…each a script run, cleaned up after as HTML's are: a microtask checkpoint, with the steps that follow it — a
  // transaction the script made is inactive once it returns)
  // (…its value marshalled first, as the script left it: what its microtasks do after is no part of it)
  // (…this realm the entry realm while it runs: navigables.rs `entryRealm`)
  globalThis.__csimEvalScript = function (code, args) {
    let out;
    const before = globalThis.__dom.enterRealm(globalThis.__csimRealmId());
    try {
      out = marshalReturn(compileScript(code).apply(null, rehydrateArgs(args || [])));
    } finally {
      globalThis.__dom.exitRealm(before);
      globalThis.__csim_yield();
    }
    return out;
  };
  // Run the script, drop the return. Lets execute_script tolerate
  // scripts whose result is a chainable jQuery object or other
  // structure the marshaller would walk recursively
  // (StackOverflowError when prevObject self-references chain).
  globalThis.__csimExecScript = function (code, args) {
    const before = globalThis.__dom.enterRealm(globalThis.__csimRealmId());
    try {
      compileScript(code).apply(null, rehydrateArgs(args || []));
    } finally {
      globalThis.__dom.exitRealm(before);
      globalThis.__csim_yield();
    }
  };
  function rehydrateArgs(args) {
    if (Array.isArray(args)) return args.map(rehydrateArgs);
    if (args && typeof args === 'object') {
      if (typeof args.__elementHandle === 'number') return lookup(args.__elementHandle);
      const out = {};
      for (const k of Object.keys(args)) out[k] = rehydrateArgs(args[k]);
      return out;
    }
    return args;
  }
  // A DOM collection's items — an HTMLCollection's or a NodeList's, any realm's, read off its slots where a page's
  // patching of its prototype does not reach, or a DOMRectList's rects — or null for anything else: a script returning
  // one marshals to an array of element handles, like a real browser serialising a collection.
  function domCollectionItems(v) {
    const list = slotsOf(v, 'NodeList');
    if (list) return list.nodes();
    const collection = slotsOf(v, 'HTMLCollection');
    if (collection) return collection.live();
    // (…`document.all`'s too, as WebDriver's clone lists one: its elements)
    if (slotsOf(v, 'HTMLAllCollection')) return Array.from({ length: v.length }, (_, i) => v[i]);
    return slotsOf(v, brandKey('DOMRectList')) ? Array.from(v) : null;
  }
  // Inverse: a script's return value as WebDriver's JSON clone has it — a node a handle the Ruby side wraps back into a
  // Node, an array or a DOM collection (a DOMRectList included) each of its items, an object with a `toJSON` method
  // what that returns (a DOMRect is its `x`, `y`, `width`, …, which live on its prototype), and an ordinary object its
  // own enumerable properties, each marshalled. Anything else — a Date (the Ruby side makes it a Time), a Map, a typed
  // array — is left to the Ruby side as it is, told by its brand so an iframe's is too; and so is a cycle, to refuse.
  function marshalReturn(value, seen = new Set()) {
    // (…an [[IsHTMLDDA]] object — `document.all`, falsy and of typeof "undefined" — a collection all the same; any other
    // primitive as it is, asked nothing more)
    const undetectable = typeof value === 'undefined' && value !== undefined;
    if ((!value || typeof value !== 'object') && !(undetectable && slotsOf(value, 'HTMLAllCollection'))) return value;
    // (…a node as its handle — an Attr, which has none, as nothing)
    if (nodeTypeOf(value) !== undefined) return nidOf(value) >= 0 ? { __elementHandle: handleOf(value) } : null;
    if (seen.has(value)) return value;
    seen.add(value);
    try {
      const items = Array.isArray(value) ? value : domCollectionItems(value);
      if (items) return Array.from(items, (v) => marshalReturn(v, seen));
      const tag = Object.prototype.toString.call(value);
      if (tag === '[object Date]') return value;
      if (typeof value.toJSON === 'function') return marshalReturn(value.toJSON(), seen);
      if (tag !== '[object Object]') return value;
      const out = {};
      for (const k of Object.keys(value)) out[k] = marshalReturn(value[k], seen);
      return out;
    } finally {
      seen.delete(value);
    }
  }
  // Visibility predicate behind Capybara's own `visible?`: "visible unless something says hidden" — INVISIBLE_TAGS
  // (head/script/style/template/…), the UA hides no page can override (a hidden input, an `<audio>` with no controls,
  // an `<embed>` with no resource), the `hidden` attribute, `display: none` / `visibility: hidden`, or a cascade rule
  // the resolver agrees with. One walk with `isVisibleNode`, which it used to keep a copy of.

  globalThis.__csimVisible = function (h) {
    // The same question `checkVisibility({visibilityProperty: true})` asks, up the flat tree: a light child no slot
    // renders, a slot's fallback while something is assigned, a closed `<details>`'s content.
    return isVisibleNode(lookup(h));
  };

  // `obscured?` — a coarse occlusion / hit-test (layout.js): an element is obscured when it's not
  // visible, out of the viewport, or a click at its centre lands on a non-descendant element on
  // top. Backed by the pay-per-use coarse box-layout model; the public getBoundingClientRect /
  // elementFromPoint stay on their existing coarse model (a later increment).
  globalThis.__csimObscured = function (h) {
    const n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return true;
    return isObscured(n);
  };

  // What a frame's container gives the document it holds, seeded before that document loads — a load-time
  // `innerWidth` / `@media` read and the body's first style are too early for anything set afterwards: the viewport
  // (the container's content box, null for an unrendered one) and the `marginwidth` / `marginheight` the body takes
  // its margins from. Measured in the PARENT realm, where it is free; the child must never pull it (see below). Ruby
  // re-navigates a frame with the seed `__csimFrameSeed` gives it, which builds the new realm the same way.
  function frameSeed(frameEl) {
    let viewport = null;
    try { viewport = frameContentBox(frameEl); } catch (e) {}
    return { viewport, margins: [frameEl._getAttribute('marginwidth'), frameEl._getAttribute('marginheight')] };
  }
  // (…and the container itself, by its nid, which the new realm is linked to as it is made: the element the host holds,
  // whatever realm its navigable had last — and the origins and the sandboxing of the document it navigates to at `url`,
  // its response's Content-Security-Policy `csp`, as its `sandbox` attribute was when the navigation began — the snapshot
  // its start took, the host's as it took its navigation (frame_navigation.rs `take_frame_sandbox`): realm_location.rs
  // `frame_origins`)
  globalThis.__csimFrameSeed = function (h, url, csp) {
    const el = lookup(h);
    if (!el) return null;
    const sandbox = globalThis.__dom.takeFrameSandbox(nidOf(el));
    const [docOrigin, locationOrigin, flags] = globalThis.__dom.frameOrigins(String(url ?? ''), sandbox, csp ?? null);
    return Object.assign(frameSeed(el), { container: nidOf(el), docOrigin, locationOrigin, sandbox: flags });
  };

  // Cross-realm geometry seam: a frame document lays out in its OWN realm, so it asks its parent
  // realm for the geometry of its container `<iframe>` — its viewport (content box), and whether a
  // click point that landed inside it also lands on the frame itself out through every ancestor
  // document. Called only from a child realm's layout.js (never from Ruby).
  globalThis.__csimFrameObscuredAt = function (frameEl, x, y) { return frameObscuredAt(frameEl, x, y); };

  // Move the window viewport (Capybara's `resize_to`) — the engine's one (viewport.rs), so `innerWidth`, the `@media`
  // cascade and the layout engine can't disagree. Called from Ruby only, which then runs the resize steps
  // (`__csimResizeSteps`).
  globalThis.__csimSetViewport = function (w, h) {
    globalThis.__dom.viewportSet(w, h);
    invalidateLayout();
  };
  // …and where it is: `[width, height]`.
  globalThis.__csimViewportSize = () => [globalThis.__dom.viewport(0), globalThis.__dom.viewport(1)];

  // This realm's container `<iframe>` has a (new) content box. Called by the PARENT realm — which has already measured
  // it — when the realm is built (BEFORE the frame's document loads, so a load-time `innerWidth` read is right), and
  // from its resize steps whenever the container's size moved.
  globalThis.__csimFrameViewportChanged = function (vp) {
    // A frame's WINDOW viewport IS its container's content box (viewport.rs): `innerWidth` / `innerHeight`, `@media`
    // and `matchMedia` inside the frame report the FRAME's size, not the top window's — that is what makes a responsive
    // component in a narrow frame take its narrow branch. An unrendered container (`display: none`, detached) has no
    // box, so the parent pushes none: that frame's window is 0x0 — what Chrome reports for a `display: none` iframe's
    // `contentWindow` — and nothing inside it is rendered or clickable.
    globalThis.__dom.frameViewportGive(vp ? vp.width : null, vp ? vp.height : null);
    invalidateLayout();
    // The same cascade refresh Ruby's `set_viewport` does for the top window. Skipped before the frame's document
    // exists (realm-build seeding), where there is nothing to restyle.
    if (!globalThis.document || !bodyOf(globalThis.document)) return;
    try { globalThis.__csimRebuildCascade(); } catch (e) {}
  };

  // A frame's body takes its margins from its container's `marginwidth` / `marginheight` where it declares none (HTML
  // §15.3.2), pushed in by the parent realm as they stand — at the realm's build and on every write of either.
  globalThis.__csimFrameMarginsChanged = function (width, height) {
    const body = globalThis.document && bodyOf(globalThis.document);
    globalThis.__dom.setContainerMargins(body ? nidOf(body) : -1, width, height);
  };

  // HTML's "run the resize steps": a window whose viewport is not the size it was at the last ones fires `resize`, and
  // its media queries report their changes (`matchMedia` listeners) — and then its frames: a container whose content
  // box is no longer its frame's viewport gives it the new one, and the frame runs its own steps, after this window's
  // (Chrome: the top window first). Run at each rendering update, and by `resize_to` at once — an idle page runs no
  // rendering update to run them in. Never from a page callback: re-entering a realm from a running JS frame trips V8's
  // IsOnCentralStack assertion.
  // (…whether the window is not the size it was at the last ones the engine's: viewport.rs `resize_steps`)
  globalThis.__csimResizeSteps = function () {
    if (globalThis.__dom.resizeSteps()) {
      fireEvent(globalThis, new Event('resize'));
      globalThis.__csimViewportChanged();
    }
    if (globalThis.__dom.childFrames[0] === 0) return;
    for (const id of globalThis.__dom.childRealms()) {
      try {
        const win = globalThis.RustyRacer.contextGlobal(id);
        const fe = win && win.__csimFrameContainer;
        if (!fe) continue;
        const frame = frameContentBox(fe);
        if (!globalThis.__dom.frameViewportMoved(id, frame ? frame.width : null, frame ? frame.height : null)) continue;
        win.__csimFrameViewportChanged(frame);
        win.__csimResizeSteps();
      } catch (e) {}
    }
  };

  // `Node#rect` — the element's coarse border-box (viewport-relative), backing the spatial selectors
  // and coordinate drag. Same additive layout seam as __csimObscured; the app-facing
  // getBoundingClientRect is unchanged.
  globalThis.__csimRect = function (h) {
    const n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return { x: 0, y: 0, width: 0, height: 0 };
    return rectOf(n);
  };

  // …and the box a synthetic POINTER is aimed at, which is not the same one: WebDriver measures
  // its in-view centre point on the element's FIRST client rect (they differ only for an inline
  // that wrapped — whose bounding box's centre is the paragraph between its two lines), and it
  // measures it AFTER scrolling the element into view. Reading it before, as the driver's Ruby
  // side does, meant clipping a rect that was still off-screen down to nothing and aiming the
  // pointer at the corner of the viewport; `__csimClickResolve` scrolls again and finds the
  // element where this left it, so the two agree.
  globalThis.__csimPointerRect = function (h) {
    const n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return { x: 0, y: 0, width: 0, height: 0 };
    ensureInView(n);
    return pointerRectOf(n);
  };

  // Capybara `scroll_to` (real): `selfH` is the element scroll_to was called on (the document root
  // for a session-level scroll, else an element); `targetH` a target element to bring into view, or
  // null with `pos`/`x`/`y` for a keyword / coordinate scroll. Drives the scroll offset so a
  // following obscured?/rect reflects it (layout.applyScrollTo).
  // Capybara `scroll_to(:current, offset: [dx, dy])` — a relative scroll from the current offset.
  globalThis.__csimScrollBy = function (selfH, dx, dy) {
    const self = lookup(selfH);
    if (!self || nodeTypeOf(self) !== NODE_ELEMENT) return;
    applyScrollBy(self, dx, dy);
  };

  globalThis.__csimScrollTo = function (selfH, targetH, pos, x, y) {
    const self = lookup(selfH);
    if (!self || nodeTypeOf(self) !== NODE_ELEMENT) return;
    const target = (targetH != null) ? lookup(targetH) : null;
    applyScrollTo(self, (target && nodeTypeOf(target) === NODE_ELEMENT) ? target : null, pos || null, x, y);
  };

  // A node's visible text (cascade.js `styleEngineVisibleText`, rendered.rs `visible_text`): the rendered text
  // collection — none for a node not rendered or skipped, a textarea's value — which Capybara's `has_text?` reads.
  // HTML's `innerText` getter (its textContent where it is not being rendered — `display: none`, `hidden`, an unrendered
  // ancestor, not `visibility: hidden` — else its rendered text), and the visible text a driver reads (`visible_text`):
  // the engine's, which keeps each node's for as long as nothing it reads can have moved (rendered.rs `Answered`) —
  // Capybara's `has_text?` polls the same unchanged node over and over.
  globalThis.__csimInnerText = (node) => (node ? styleEngineInnerText(node) : '');
  globalThis.__csimVisibleText = (h) => {
    const n = lookup(h);
    return n ? styleEngineVisibleText(n) : '';
  };

  // Async script support: the supplied callback is appended as the
  // last argument. The script invokes it with the eventual result,
  // which Ruby polls (advancing virtual time first to let any
  // setTimeout-driven completion fire). Element returns rehydrate
  // through the same `{__elementHandle: id}` sentinel used by
  // synchronous evaluate_script.
  let __asyncResult = null;
  globalThis.__evalAsyncScript = function (code, args) {
    __asyncResult = null;
    const list = (args || []).map(a =>
      (a && typeof a === 'object' && '__elementHandle' in a)
        ? lookup(a.__elementHandle)
        : a
    );
    list.push(function (v) { __asyncResult = { value: marshalReturn(v) }; });
    try {
      (new Function('args', 'return (function (' +
        list.map((_, i) => 'a' + i).join(', ') +
        ') { ' + String(code) + ' }).apply(null, args);'))(list);
    } catch (e) {
      __asyncResult = { value: null, error: e && e.message };
    }
    globalThis.__csim_yield();
  };
  globalThis.__pollAsyncResult = function () { return __asyncResult; };


  // Build the drag data store for a driver-initiated drop (`Element#drop`): its strings, and its files the user's
  // from disk — read through the drop's own pick (`pick`). `types` derives from the items, so adding an item is all it
  // takes for the page to see the format.
  // (…a string's format its own, the last given of one replacing the first, as setData does; its allowed effects
  // "uninitialized", HTML's start for any drag)
  function __csimMakeDataTransfer(items, pick) {
    const dt = new DataTransfer();
    setEffectAllowed(dt, 'uninitialized');
    let index = 0;
    for (const it of items || []) {
      if (it.kind === 'file') dt.items.add(hostBackedFile(it.file, pick, index++));
      else dt.setData(it.type, it.value);
    }
    return dt;
  }
  // Finish a click that was started with `mouseDownOnly: true`: its release, at what the press was at
  // (`releaseClick`), with the action shape `__csimClickResolve` produces so Ruby can drive the navigate / submit
  // follow-up.
  globalThis.__csimClickFinish = function () {
    const pressed = pendingPress;
    pendingPress = null;
    return pressed ? releaseClick(pressed) : null;
  };

  // Capybara `Element#drop(items)`: a drag from outside the page released over the element (HTML drag-and-drop) —
  // it is dropped only where its `dragover` left a drag operation (canceled, its dropEffect one the effects allow), and
  // otherwise left.
  globalThis.__csimDropOnto = function (h, items, pick) {
    const target = lookup(h);
    if (!target) return false;
    const dt = __csimMakeDataTransfer(items, pick);
    const fire = (type, cancelable) => {
      beginDndEvent(dt, type);
      const ev = new DragEvent(type, { __proto__: null, bubbles: true, cancelable, composed: true, dataTransfer: dt });
      dispatchEventForUserAction(target, ev);
      endDndEvent(dt, type, eventState(ev).canceled);
    };
    fire('dragenter', true);
    fire('dragover', true);
    if (dragOperation(dt) !== 'none') fire('drop', true);
    else fire('dragleave', false);
    setDataTransferMode(dt, null);   // (…the drag over, its store gone: DataTransfer)
    return true;
  };

  // Capybara `Element#drag_to(other)` — the driver-side drag emulation (drag.js): a mousedown on
  // the source (which also primes libraries that gate `draggable="true"` on a recent mousedown,
  // e.g. Discourse's sidebar-section-form-link, and decides pointer-driven vs HTML5), then either
  // mousemove/mouseup or the full drag-event chain over a shared DataTransfer. `opts` carries
  // Capybara's `drop_modifiers:` (as a `{altKey: true, …}` map) and an explicit `html5:` override.
  // Its drop is at the target's centre, as WebDriver's is — so an `offsetY < height/2` "above vs below" test reads it
  // as Chrome does.
  // Staged so the driver can settle between them — see drag.js: a real drag runs the page's timers
  // between the press, the move and the drop, and libraries schedule work in that gap.
  globalThis.__csimDragBegin = function (sourceHandle, targetHandle, opts) {
    return dragBegin(lookup(sourceHandle), lookup(targetHandle), opts);
  };
  globalThis.__csimDragMove   = function () { return dragMove(); };
  globalThis.__csimDragFinish = function () { return dragFinish(); };


  // Tab-key focus traversal is focus.rs's (`globalThis.__csimAdvanceFocus`, dom-nodes.js).

  // Click resolver: maps an element click to one of three outcomes
  // the Ruby side knows how to drive:
  //   - {kind:'navigate', url}  — <a href>
  //   - {kind:'submit',   spec} — submit-button inside <form>: its request as submitted
  //   - null                    — everything else; checkbox/radio
  //     toggling happens inline so Ruby sees the new state on the
  //     follow-up read.


  // An element's handle, for an in-VM caller that holds the element itself (the WPT `test_driver` shim) to hand the
  // handle-keyed entry points (__csimSendKeys, __csimClickResolve) without a Ruby round-trip.
  globalThis.__csimRegisterNode = function (node) {
    return node && nodeTypeOf(node) === NODE_ELEMENT ? handleOf(node) : 0;
  };

  // The WebDriver obscured-click probe for a REAL top-level pointer click aimed
  // at `n`: hit-test the click point (the caller's client coordinates when it
  // supplied them, else the in-view centre) and answer the retryable
  // `{kind:'intercepted'}` action when an unrelated page-covering overlay would
  // receive it. Only genuine pointer clicks opt in — keyboard activation, label
  // forwarding and other synthetic re-entries through `__csimClickResolve` are
  // default actions a browser performs regardless of overlays. KNOWN LIMIT: the
  // probe is realm-local, so a PARENT document's overlay over an iframe is not
  // seen here (obscuredAtPoint's cross-frame recursion is the model to adopt if
  // an app depends on it).
  function clickInterceptionAt(n, mods) {
    const rect = pointerRectOf(n);
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const px = typeof mods.clientX === 'number' ? mods.clientX : Math.floor(rect.x + rect.width / 2);
    const py = typeof mods.clientY === 'number' ? mods.clientY : Math.floor(rect.y + rect.height / 2);
    // (…what receives it instead — an inert target's covering hit, an unrelated page-covering overlay — the engine's,
    // over the layout its rect was read from: hit_test.rs `clickObstructor`)
    const other = globalThis.__dom.clickObstructor(nidOf(n), px, py, Float64Array.of(rect.x, rect.y, rect.width, rect.height));
    if (!other) return null;
    const desc = (el) => '<' + tagOf(el) +
      (attrsOf(el) && attrsOf(el).id ? ' id="' + attrsOf(el).id + '"' : '') +
      (attrsOf(el) && attrsOf(el).class ? ' class="' + String(attrsOf(el).class).slice(0, 80) + '"' : '') + '>';
    return { kind: 'intercepted', target: desc(n), other: desc(other), x: Math.round(px), y: Math.round(py) };
  }

  // The same probe for the click chains that don't route through
  // `__csimClickResolve` (right click, double click) — Ruby asks first and
  // raises the retryable error before dispatching anything.
  globalThis.__csimClickInterceptedAt = function (h, mods) {
    const n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return null;
    ensureInView(n);
    return clickInterceptionAt(n, { __proto__: null, ...mods });
  };

  // A press's focus: the nearest element up from its target that can take it, the engine's (focus.rs `press_target`) —
  // where none can, the viewport: the focused element loses focus, as Chrome's does on a click outside it (a dropdown
  // closing on blur, an input's `change`), and Tab goes on from the node pressed (Chrome).
  function focusOnPress(n) {
    const target = styleEnginePressFocusTarget(n);
    if (target) {
      try { target._focus(); } catch (_) {}
      return;
    }
    const focused = globalThis.document && globalThis.document._activeElement;
    if (focused) try { focused._blur(); } catch (_) {}
    // (…and the document's viewport takes it: HTML "run the focusing steps" for it — a frame's, the focus chain into it)
    focusRealm(globalThis.__csimRealmId());
    if (nidOf(n) != null) globalThis.__dom.setFocusStart(nidOf(n));
  }
  // …and the testdriver shim's press, a pointer's (not :focus-visible).
  globalThis.__csimFocusOnPress = (n) => {
    globalThis.__dom.setPointerModality(true);
    focusOnPress(n);
  };
  // What the driver's pointer at the point Ruby gives hits — where WebDriver's element click lands, the event's real
  // target — when that is inside `n`: a closed details' summary, which a click on the details opens; a button's icon.
  // `n` itself otherwise: no point, nothing laid out there, or an obstruction the caller has refused already.
  function pointerTarget(n, mods) {
    if (typeof mods.clientX !== 'number' || typeof mods.clientY !== 'number') return n;
    const hit = hitTest(mods.clientX, mods.clientY);
    return hit && hit !== n && isFlatAncestor(n, hit) ? hit : n;
  }
  // …and to the testdriver shim, whose actions aim at an element's point as the driver's own do: what is there inside it
  // (in its shadow tree too, unretargeted — the event retargets as it climbs), the element itself where what is there
  // is not inside it; at a viewport point, what is there.
  globalThis.__csimPointerTargetAt = (n, x, y) => (n ? pointerTarget(n, { clientX: x, clientY: y }) : hitTest(x, y));
  // Where the driver's pointer acts on `n`, with the keys `mods` holds: the point Ruby gives (the element's centre, or
  // Capybara's offset), else — a click the testdriver shim asks for — the element's in-view centre point, as WebDriver
  // aims, floored (`pointerRectOf`, the same box Ruby's centre is taken on): where an image button's click selects its
  // coordinate, and what ProseMirror's `isNear(event, lastClick)` tells two clicks on different elements apart by.
  function pointerPoint(n, mods) {
    let x = mods.clientX, y = mods.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') {
      const r = pointerRectOf(n);
      x = Math.floor(r.x + r.width / 2);
      y = Math.floor(r.y + r.height / 2);
    }
    return {
      clientX: x, clientY: y, screenX: x, screenY: y,
      shiftKey: !!mods.shiftKey, ctrlKey: !!mods.ctrlKey, altKey: !!mods.altKey, metaKey: !!mods.metaKey
    };
  }
  // Capybara `right_click`: the secondary button pressed over the element (`__csimContextPress`) and released
  // (`__csimContextRelease`) — the press focusing it unless canceled and opening the context menu, `contextmenu`, as on
  // Linux, where the menu opens on the press; the release a `mouseup` and an `auxclick` (UI Events: a button's click
  // that is not the primary's).
  globalThis.__csimContextPress = function (h, mods) {
    let n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return 0;
    ensureInView(n);
    n = pointerTarget(n, { __proto__: null, ...mods });
    const point = pointerPoint(n, { __proto__: null, ...mods });
    dispatchHover(n, { point, resolved: true });
    const press = { __proto__: null, bubbles: true, cancelable: true, button: 2, buttons: 2, detail: 1, ...point };
    // (…its `mousedown` — and its default action, and the release's `mouseup` — none where its `pointerdown` was
    // canceled, as a primary click's: `__csimClickResolve`)
    if (!firePointerStep(n, 'mousedown', press)) {
      globalThis.__dom.setPointerModality(true);
      focusOnPress(n);
    }
    dispatchEventForUserAction(n, new PointerEvent('contextmenu', pointerEventInit(press)));
    return handleOf(n);
  };
  globalThis.__csimContextRelease = function (h, mods) {
    const n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return false;
    const release = { __proto__: null, bubbles: true, cancelable: true, button: 2, buttons: 0, detail: 1, ...pointerPoint(n, { __proto__: null, ...mods }) };
    firePointerStep(n, 'mouseup', release);
    dispatchEventForUserAction(n, new PointerEvent('auxclick', pointerEventInit(release, 0)));
    return true;
  };
  // The `dblclick` closing a double click the driver played (Capybara `double_click`): at its clicks' point, their
  // count its `detail`.
  globalThis.__csimDblClick = function (h, mods) {
    let n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return false;
    n = pointerTarget(n, { __proto__: null, ...mods });
    const init = { __proto__: null, bubbles: true, cancelable: true, button: 0, detail: 2, ...pointerPoint(n, { __proto__: null, ...mods }) };
    dispatchEventForUserAction(n, new MouseEvent('dblclick', init));
    return true;
  };
  let pendingPress = null;
  // A click's release, of the press `__csimClickResolve` made: pointerup, mouseup and the click — whose activation is the
  // dispatch's, as any click's (dom-nodes `activationBehavior`) — at what was pressed, and the intent it left handed back
  // to Ruby: a submission (a click handler's `form.submit()`, Rails-UJS's data-method form, before anything else the
  // click planned), a navigation, a download. (leavePending: a testdriver click leaves them for the drain.)
  function releaseClick({ n, base, leavePending }) {
    firePointerStep(n, 'mouseup', base);
    // (…the click itself a PointerEvent, as in Chrome and Firefox (Pointer Events) — none at a disabled form control,
    // which HTML keeps a user's click from, nor at what a disabled button holds (Chrome): no event, no activation)
    if (!globalThis.__dom.clickWithheld(n)) dispatchEventForUserAction(n, new PointerEvent('click', pointerEventInit(base, 0)));
    if (leavePending) return null;
    const submit = globalThis.__dom.takeSubmission();
    const nav = takePlannedNavigation(false);
    const download = globalThis.__csimTakePendingDownload();
    if (submit) {
      return { kind: 'submit', spec: submit };
    }
    // (…an empty URL one too: `<a href="">` reloads the page; and a blob: one's click-time snapshot, whatever its target)
    if (nav) return { kind: 'navigate', ...nav };
    return download ? { kind: 'download', ...download } : null;
  }
  globalThis.__csimClickResolve = function (h, modifiers, opts) {
    pendingPress = null;   // (…a press left unreleased is no press of this click's)
    let n = lookup(h);
    if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return null;
    // WebDriver's element-click algorithm scrolls the target into view first, so a real browser
    // never clicks something that is off-screen. Page code reads that: floating-ui's `hide`
    // middleware — which positions every select-kit dropdown in Discourse — marks its reference
    // "hidden" and the menu never appears if the trigger is below the fold when it is clicked.
    ensureInView(n);
    // …and, for a REAL pointer click (Ruby's Browser#click opts in; synthetic
    // and forwarded activations don't), it hit-tests the click point before
    // dispatching: an unrelated element painted on top (a modal backdrop still
    // finishing its exit animation, a full-page overlay) RECEIVES the click in a
    // browser, so the driver refuses with the retryable "click intercepted"
    // error instead of tunnelling the events to the covered target. Capybara's
    // retry then re-finds and re-clicks once the obstruction is gone — which is
    // also what lets an in-flight async close (parked on its exit-animation
    // timer) complete before the next modal opens, instead of its stale
    // continuation closing the new one.
    if (opts && opts.interceptCheck) {
      const intercepted = clickInterceptionAt(n, modifiers || {});
      if (intercepted) return intercepted;
    }
    const mods = { __proto__: null, ...modifiers };
    n = pointerTarget(n, mods);
    // A Ruby-driven Capybara click wants the page's resulting submit/navigate
    // intent RETURNED so the Ruby side actions it. A testdriver click
    // (`test_driver.click`) is JS-side and discards the return, so it asks us to
    // LEAVE the intent in its pending slot — the driver's normal drain then
    // actions it, exactly as for a page-initiated `form.submit()` / nav.
    const leavePending = !!(opts && opts.leavePending);

    // Real clicks fire `mousedown` → `mouseup` → `click` (with
    // `pointerdown` / `pointerup` for Pointer-Event-aware listeners).
    // Libraries listen on the down-half of the pair: Tribute attaches
    // its menu-click handler to `mousedown` (so the menu select fires
    // before the textarea's `blur` chain commits), and jQuery's
    // `:active` selector + sortable plugins drag-detect off mousedown.
    // Without these dispatches, clicking a Tribute `<li>` does not
    // call `selectItemAtIndex` and the autocomplete never inserts.
    // The pointer at the click point with the keys held, where the hover
    // before the click moves it; the press there, of the primary button —
    // a click whose count is `detail` (a double click's second is 2) — and
    // the button held (`buttons`) until the release (`base`).
    const point = pointerPoint(n, mods);
    const press = { __proto__: null, bubbles: true, cancelable: true, button: 0, buttons: 1, detail: mods.detail || 1, ...point };
    const base  = { __proto__: null, ...press, buttons: 0 };
    // A real user click first moves the pointer over the target. Apps
    // such as InstantClick use mouseover capture to start link preload
    // before the subsequent click handler prevents the native
    // navigation. Over and enter fire only where the target changed
    // (hover-driven widgets recurse on duplicate mouseover events); the
    // moves fire each time, as Chrome's before its pointerdown.
    dispatchHover(n, { point, resolved: true });
    // Supersede what was planned before dispatch (navigation_plan.rs)
    // so the click handler can plan either if it ends in
    // `form.submit()` (Rails-UJS data-method / data-confirm chain) or
    // a programmatic `link.click()` (Avo's filter controller).
    globalThis.__dom.supersedePlanned();
    // Pointer Events level 3: `pointerdown` fires before its `mousedown`
    // compat counterpart. FloatKit's `d-close-on-click-outside` modifier
    // registers a `document.addEventListener('pointerdown', …)` listener
    // to dismiss menus, and Discourse's revamped header menu / many
    // FloatKit popovers depend on that path firing. Dispatched as a real
    // PointerEvent (which extends MouseEvent, so every mouse-shaped
    // listener still matches) — a library that branches on `instanceof
    // PointerEvent` / `pointerType` to prefer the pointer path, as
    // SortableJS does, has to see one. Same shape drag.js uses.
    // The whole pointer/mouse sequence of a UA click (testdriver / Ruby action)
    // is TRUSTED, like the click itself — real browsers fire trusted mousedown/
    // mouseup/pointer events for an input-injected click, and a listener that
    // re-dispatches one must see the original as isTrusted=true
    // (dom/events/Event-dispatch-redispatch.html).
    // A `pointerdown` canceled keeps its compatibility mouse events from firing until the pointer is released — the
    // `mousedown` and the `mouseup`, not the click — and with the `mousedown` its default action, the focus and the
    // caret (Pointer Events "preventing compatibility mouse events"; Chrome, measured).
    const pressCanceled = firePointerStep(n, 'mousedown', press);
    // HTML/UIEvents spec: if mousedown wasn't cancelled, the default
    // action moves focus to the clicked element when it's focusable.
    // flatpickr opens its calendar on the input's `focus` event, so
    // without this transfer a `click` on a `<input data-controller=
    // "date-field">` leaves the picker closed and the `set_picker_day`
    // helper can't find the (display:none-hidden) day buttons.
    if (!pressCanceled) {
      globalThis.__dom.setPointerModality(true);   // click-driven focus → not :focus-visible
      focusOnPress(n);
    }
    // A press in an editing host sets the caret where it pressed (layout.js `caretFromPoint`) — mousedown's default
    // action, a `selectionchange` that ProseMirror / Tiptap take a click by (a stale NodeSelection of an image clicked
    // before goes). Not on an atom a caret is placed beside (caret.rs `caretAtom`: an image, a `<br>`), whose click selects
    // it (ProseMirror's mouseup-time `selectClickedLeaf` selects an `<img>`, which a collapse made first would fight).
    // (A press on text no host holds sets a document selection there too in a browser — a recording layout per click,
    // not modelled.)
    if (!pressCanceled && !globalThis.__dom.caretAtom(nidOf(n))) {
      const ceHost = contenteditableHost(n);
      if (ceHost) {
        try {
          if (globalThis.document._activeElement !== ceHost) ceHost._focus();
          forgetCaretMove();
          const at = caretFromPoint(point.clientX, point.clientY);
          if (at && contenteditableHost(nodeTypeOf(at[0]) === NODE_ELEMENT ? at[0] : at[0]._parent) === ceHost) {
            globalThis.__csimCollapseSelection(at[0], at[1]);
          }
        } catch (_) {}
      }
    }
    // (…the press's state, which its release takes up — now, or after the wall-clock delay Ruby keeps between them:
    // `mouseDownOnly`, which returns the partial event init so `__csimClickFinish` ends the chain with it)
    const pressed = { n, base, leavePending };
    if (mods.mouseDownOnly) {
      pendingPress = pressed;
      return { kind: 'partial', base };
    }
    return releaseClick(pressed);
  };


  globalThis.MessageEvent = MessageEvent;

  // Fire the window `load` event using the module-captured `Event` constructor
  // rather than the `window.Event` global. A test may legitimately `delete
  // window.Event` (dom/interface-objects.html does, for every DOM interface) —
  // a real browser still fires `load` because the UA's internal event machinery
  // doesn't depend on the page's mutable global. The WPT runner prefers this
  // helper over `new (window.Event)('load')` so a deleted global can't turn a
  // genuine result into a harness error.
  //
  // ONE window `load` per document load. Several places can be the one to fire it — the task "the end" queued
  // (`__csimTaskOfTheEnd`), a settled delay's, the realm builder for a frame — and which one gets there first depends on
  // how the document was created: whoever arrives first fires, the rest are no-ops, so a page never sees the event twice.
  // Returns whether this call is the one that fired.
  // HTML "the end", its last steps: once nothing delays the load event — the document's sheets and frames, flushed here —
  // its readiness `complete`, then its load at the window, then `pageshow`, in one task — each step the engine's to
  // decide (document_lifecycle.rs `docLoadSteps`). (…its DOMContentLoaded first where its task has yet to run: a frame's
  // build fires its load as it ends, before any task of its own)
  const LOAD_ABORTED = 1, LOAD_FIRE = 3, LOAD_STEP = 3, READY_CHANGED = 4;
  globalThis.__csimFireWindowLoad = function () {
    const doc = globalThis.document;
    fireContentLoaded(globalThis.__dom.docState(nidOf(doc), DOC_GENERATION));
    // (…its style resolved and the images it uses fetched first — a `background-image`'s, a `list-style-image`'s, a
    // `content` image's, a cursor's: fetched as they are here, which holds the load for them. HTML leaves open what CSS
    // fetches delay the load event (csswg-drafts#1088); Chrome 156 and Firefox 159 both hold the load for a CSS
    // background image, measured 2026-11-01.)
    if (!globalThis.__dom.docCompletelyLoaded(nidOf(doc))) flushCssImages();
    // (…a gate's work that throws stopping none of the others; none for a document a navigation of its navigable aborted
    // as it parsed — HTML "abort a parser": "the end" runs no more — whose load delays its parent's no more either; and
    // delayed while its images are fetched or a frame's document has its own delayed, fired once nothing does:
    // `__csimLoadBlockerSettled`)
    // (…its readiness `complete` with the load, the engine's update: `READY_CHANGED`)
    const steps = globalThis.__dom.docLoadSteps((id) => { try { runLoadGate(id); } catch (_) {} });
    const step = steps & LOAD_STEP;
    if (step === LOAD_ABORTED) askParentAboutLoad();
    if (step !== LOAD_FIRE) return false;
    if (steps & READY_CHANGED) readinessChanged(doc);
    const ev = new Event('load');
    // HTML fires the document's load event AT THE WINDOW with the "legacy target
    // override flag" set, which leaves `currentTarget` the window but makes
    // `target` the DOCUMENT (Chrome: `event.target.constructor.name` is
    // `HTMLDocument`). Page code that routes on `event.target` — jQuery's
    // delegation, any `if (e.target === document)` guard — reads it.
    eventState(ev).legacyTargetOverride = true;
    fireEvent(globalThis, ev);
    // …then `pageshow`, its page showing from then on (HTML "the end": "Set the Document's page showing to true"), what
    // its unload fires `pagehide` by — never shown from a back/forward cache here
    globalThis.__dom.docShowPage(nidOf(doc));
    const show = new PageTransitionEvent('pageshow', { __proto__: null, persisted: false });
    eventState(show).legacyTargetOverride = true;
    fireEvent(globalThis, show);
    // …and HTML "completely finish loading"
    globalThis.__dom.docFinishLoading(nidOf(doc));
    for (const start of afterLoad.splice(0)) start();
    // (…and the parent's load, which this one may have delayed, asked about again)
    askParentAboutLoad();
    return true;
  };
  // …and a new window's initial about:blank, which no parse makes (HTML "create a new browsing context and document"):
  // completely finished loading as it is made, its readiness `complete` from the first — no `load` nor `pageshow`,
  // which only "the end" of a parse fires (Chrome and Firefox measured: none at `open(url)`'s window before its
  // navigation's document, none at `open()`'s), nor any later (document_lifecycle.rs `docCompleteInitial`).
  globalThis.__csimCompleteInitialDocument = function () {
    const doc = globalThis.document;
    // (…its initial about:blank, whose Window a navigation to a document of its origin keeps — until `document.open()`:
    // the engine's, `STATE_INITIAL_ABOUT_BLANK`) — `open('about:blank')`'s and `open()`'s too, which HTML's window open
    // steps leave the initial one (the URL and history update steps alone), whose Window "create and initialize a
    // Document object" then reuses: the spec's explicit rule, over Chrome and Firefox, which keep no expando of it
    // through `w.location = url` (measured 2026-10-31)
    setStateBit(doc, STATE_INITIAL_ABOUT_BLANK, true);
    globalThis.__dom.docCompleteInitial(nidOf(doc));
    for (const start of afterLoad.splice(0)) start();
  };
  // …and a frame's initial about:blank (HTML "create a new child navigable"), its load fired by its build already.
  globalThis.__csimMarkInitialAboutBlank = () => setStateBit(globalThis.document, STATE_INITIAL_ABOUT_BLANK, true);
  // What waits for the document to be completely loaded, run as it is.
  const afterLoad = [];
  // HTML's shared declarative refresh steps for this document and `input` — a `<meta http-equiv=refresh>`'s content
  // (`meta`), a `Refresh` header's value — the engine's (declarative_refresh.rs): its navigation once its delay is up
  // from the later of the document's load and now, the element's insertion.
  function declarativeRefresh(input, meta) {
    const doc = globalThis.document;
    const due = globalThis.__dom.declarativeRefresh(nidOf(doc), String(input), meta);
    if (!due) return;
    const [delay, url] = due;
    const start = () => globalThis.__csimSetTimeout(() => globalThis.__csimDeclarativeRefresh(url), delay);
    if (globalThis.__dom.docCompletelyLoaded(nidOf(doc))) start();
    else afterLoad.push(start);
  }

  // The driver's own globals — its `__…` hooks between the realm, the engine and the host, and the engine's `RustyRacer` —
  // kept out of a page's enumeration of the window, each still writable and configurable: the ones there at boot
  // (`DRIVER_GLOBALS`, before any page or app code ran), its `__csim…` namespace and the engine's `__dom`, and the native
  // functions the host attaches after boot. Another `__…` global is the page's own.
  const DRIVER_GLOBALS = new Set(['RustyRacer', '__dom']);
  const nativeSource = Function.prototype.toString;
  const isHostFunction = (v) => typeof v === 'function' && /\{\s*\[native code\]\s*\}$/.test(nativeSource.call(v));
  const isDriverGlobal = (name, value) => DRIVER_GLOBALS.has(name) || name.startsWith('__csim') || (name.startsWith('__') && isHostFunction(value));
  function hideDriverGlobals() {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (name.charCodeAt(0) !== 95 && name !== 'RustyRacer') continue;   // (…the cheap test first: not `_…`)
      const d = Object.getOwnPropertyDescriptor(globalThis, name);
      if (d && d.enumerable && d.configurable && isDriverGlobal(name, d.value)) Object.defineProperty(globalThis, name, { ...d, enumerable: false });
    }
  }

  // WebIDL: an interface object (and the legacy factory / namespace objects)
  // exposed on the global has property attributes { writable:true,
  // enumerable:false, configurable:true } — so `for (p in window)` must NOT
  // enumerate `Event`, `Node`, `NodeFilter`, … (dom/interface-objects.html). The
  // driver assigns most of these via `globalThis.X = X`, which creates an
  // *enumerable* data property when `X` didn't already exist. This one-time boot
  // pass (runs once at snapshot build, before any page/user script) restores the
  // spec attributes for every capitalized, enumerable, configurable own data
  // property — `delete` and reassignment still work because configurable/writable
  // stay true. Accessor globals (`location`, …) carry no `value` and are skipped.
  // The driver's own `__…` globals (its hooks between the realm, the engine and the host) are no page's either: a
  // `for (p in window)` or `Object.keys(window)` saw some 470 of them. (…those the driver sets only later — the
  // checkpoint steps and the callbacks running, globals rather than module state because they are the AGENT's, read
  // off whichever realm `agentGlobal()` names — made now, hidden, so that a later write keeps them so)
  const LATE_DRIVER_GLOBALS = [
    '__csimCheckpointSteps', '__csimRunningCallbacks'
  ];
  for (const name of LATE_DRIVER_GLOBALS) {
    if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value: undefined, writable: true, enumerable: false, configurable: true });
  }
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (name.charCodeAt(0) === 95 && name.charCodeAt(1) === 95) DRIVER_GLOBALS.add(name);
  }
  hideDriverGlobals();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (name.charCodeAt(0) < 65 || name.charCodeAt(0) > 90) continue;   // not /^[A-Z]/
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!d || !d.enumerable || !d.configurable || !('value' in d)) continue;
    const t = typeof d.value;
    if (t !== 'function' && t !== 'object') continue;
    if (d.value === null) continue;
    Object.defineProperty(globalThis, name, { value: d.value, writable: true, enumerable: false, configurable: true });
  }

})();

// What a realm that is no secure context takes away, as the bundle has made it (secure-context.js).
captureSecureContextHolders();
// Every interface a generated binding takes is registered once all the modules have run (webidl.js).
assertInterfacesRegistered(INTERFACES_TAKEN);
