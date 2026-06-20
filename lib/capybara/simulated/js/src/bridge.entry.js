// The DOM lives entirely in V8. No __dom callbacks. Capybara's Ruby
// side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.

import './url-parse.js';   // defines globalThis.__csim_parseUrl before location.js's load-time use
import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_DOCTYPE, NODE_COMMENT, NODE_FRAGMENT, installNodeConstants } from './constants.js';
import { walk, walkSubtree, isConnected, classes, scriptText } from './walk.js';
import { handles as __handles, lookup, registerNode, registerSubtree, unregisterSubtree } from './handles.js';
import { dispatchEvent, dispatchEventForUserAction } from './dispatch.js';
import {
  closeDialog,
  LABELABLE,
  labeledControlFor,
  enclosingLabelFor,
  isSubmitButton,
  formForControl,
  toggleChecked,
  setRadio,
  checkedRadioInGroup,
  contenteditableHost
} from './form-helpers.js';
import { ceTryConnect, runSelectednessAlgorithm, ensureOptionSelInit } from './custom-elements.js';
import { serializeElement } from './html-parser.js';
import {
  collectVisibleText,
  elementPreservesWhitespace,
  resolveLayoutProp,
  resolveTextTransform,
  rebuildCascade,
  resetCascadeState,
  resolveCascadeDisplay,
  selfHidden,
  visibilityHidden,
  INVISIBLE_TAGS
} from './cascade.js';
import { localStorage, sessionStorage } from './storage.js';
import {
  Event,
  DOMException,
  CustomEvent,
  UIEvent,
  MouseEvent,
  PointerEvent,
  DragEvent,
  KeyboardEvent,
  InputEvent,
  SubmitEvent,
  MessageEvent,
  ClipboardEvent,
  FocusEvent,
  WheelEvent,
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
  AnimationEvent,
  TransitionEvent,
  FormDataEvent,
  BeforeUnloadEvent,
  GamepadEvent,
  EventTarget,
  installOnHandlerSlots,
  installWindowForwardedHandlers
} from './events.js';
import { deliverMutations, flushMutationDelivery, hasQueuedRecords, hasObservers, recordAttrMutation, recordChildList } from './mutation-observer.js';
import { timerStats }                  from './timers.js';
import { Blob, File, installBlobURL }  from './blob.js';
import './streams.js';                 // WHATWG Streams globals + TextDecoder/EncoderStream
import { installIfMissing as installIntlCollator } from './intl-collator.js';
import { logThrew }                    from './console.js';
import { installDomClassAliases }      from './dom-class-aliases.js';
import { installXPath }                from './xpath.js';
import { makeLocation }                from './location.js';
import { ingestImportmaps, resolveAgainst } from './esm-loader.js';
import {
  Node,
  Text,
  Element,
  DocumentFragment,
  ShadowRoot,
  Document,
  DocumentOrderRange,
  makeAttr,
  createHtmlPageDocument,
  parse5ParseDocument,
  parse5ParseIntoLive,
  parseFragment,
  parseXml,
  newChildList,
  deleteRangeContents,
  resetLayoutY,
  fragmentNavigate,
  processDeclarativeShadowRoots,
  convertDeclarativeTemplate
} from './dom-nodes.js';

// Side-effect modules — globalThis wirings + Promise.then patch.
import './abort.js';
import './audio.js';
import './canvas.js';
import { installCanvasToBlob }                  from './canvas.js';
import { installVideoIDL, onVideoSrcAssigned } from './video.js';
import './dialogs.js';
import './dom-collections.js';
import './encoding.js';
import './event-source.js';
import './websocket.js';
import './fetch.js';
import './file-reader.js';
import './form-data.js';
import './form-fields.js';
import './history.js';
import './host-queries.js';
import './idb.js';
import './navigator.js';
import './webauthn.js';
import './observers.js';
import './platform-globals.js';
import './selection.js';
import './style-proxy.js';
import './tz-override.js';
import './unhandled-rejection.js';
import './url.js';
import './window-events.js';
import './workers.js';
import './xhr.js';

(function () {
  'use strict';

  // ── Event class + dispatch walk ─────────────────────────────────
  //
  // Capture / target / bubble per DOM4.

  // DOM event constructors live in `events.js`. Expose under the same
  // global names apps and framework code reach for.
  globalThis.Event          = Event;
  globalThis.DOMException   = DOMException;
  globalThis.CustomEvent    = CustomEvent;
  globalThis.MouseEvent     = MouseEvent;
  globalThis.KeyboardEvent  = KeyboardEvent;
  globalThis.InputEvent     = InputEvent;
  globalThis.SubmitEvent    = SubmitEvent;
  globalThis.UIEvent               = UIEvent;
  globalThis.PointerEvent          = PointerEvent;
  globalThis.DragEvent             = DragEvent;
  globalThis.FocusEvent            = FocusEvent;
  globalThis.WheelEvent            = WheelEvent;
  globalThis.TouchEvent            = TouchEvent;
  globalThis.CompositionEvent      = CompositionEvent;
  globalThis.TextEvent             = TextEvent;
  globalThis.DeviceMotionEvent     = DeviceMotionEvent;
  globalThis.DeviceOrientationEvent = DeviceOrientationEvent;
  globalThis.ProgressEvent         = ProgressEvent;
  globalThis.PopStateEvent         = PopStateEvent;
  globalThis.HashChangeEvent       = HashChangeEvent;
  globalThis.StorageEvent          = StorageEvent;
  globalThis.ErrorEvent            = ErrorEvent;
  globalThis.PromiseRejectionEvent = PromiseRejectionEvent;
  globalThis.AnimationEvent        = AnimationEvent;
  globalThis.TransitionEvent       = TransitionEvent;
  globalThis.FormDataEvent         = FormDataEvent;
  globalThis.BeforeUnloadEvent     = BeforeUnloadEvent;
  globalThis.GamepadEvent          = GamepadEvent;

  // Mouse-event types need MouseEvent so click-handler readers see
  // `.button` / `.shiftKey` / `.ctrlKey` / `.altKey` / `.metaKey`
  // alongside the bubbling flags. Falls back to Event for keyboard /
  // generic events.
  const MOUSE_EVENT_TYPES = new Set([
    'click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout',
    'mouseenter', 'mouseleave', 'mousemove', 'contextmenu'
  ]);
  // Trusted dispatch for the testdriver shim (WebDriver input injection is a
  // user-agent action → isTrusted=true). Routes through the internal trusted
  // `dispatchEvent` so the public-API untrusting (dispatchEventPublic) doesn't
  // apply. Same dispatch walk as a script `el.dispatchEvent`, only trusted.
  globalThis.__csimDispatchTrusted = function (target, event) {
    if (event) event.isTrusted = true;
    return dispatchEvent(target, event);
  };

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
    const merged = Object.assign({ bubbles: true, cancelable: true }, init || {});
    return dispatchEvent(n, new ctor(typeStr, merged));
  };

  // `globalThis.HTMLElement` (a real `class extends Element` with a
  // namespace-keyed `instanceof`) is installed by `installDomClassAliases`;
  // user classes do `class MyThing extends HTMLElement`, whose `super()`
  // chains to our `Element` constructor. CE lifecycle (registry,
  // upgradeElement, connect/disconnect hooks, attributeChangedCallback,
  // "ask for a reset" on `<option>` insert into single-select) lives
  // in `custom-elements.js`. Script-and-link side effects of CE
  // connect stay inline (closure state).
  globalThis.__csimFireCEConnect = fireCEConnect;
  // Connection steps for ONE element (the per-node body of fireCEConnect's
  // walk). Selects encountered are pushed to `selects` so the caller can run
  // the selectedness algorithm once every descendant option is initialised.
  // Shared by fireCEConnect (whole-subtree walk) and drainStreamConnect (the
  // streaming parser's incremental connect cursor) so both connect / upgrade /
  // fire-load identically — exactly once per element.
  function connectOneElement(el, selects) {
    if (el.nodeType !== NODE_ELEMENT) return;
    // HTML option selectedness: initialise from the authored `selected`
    // content attribute exactly once (parse-time default), unless the
    // IDL setter already dirtied it. After this the attribute-change
    // steps + the select algorithm maintain it. See custom-elements.js.
    if (el._tag === 'option') {
      ensureOptionSelInit(el);
    } else if (el._tag === 'select') {
      selects.push(el);
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
    // <script>s run via the parse5 scriptHandler, not here.
    // `isConnected` re-check: an earlier script in this same insertion batch
    // may have removed a later one before the walk reaches it — a disconnected
    // script must not run (later-script-removed-by-earlier-script).
    if (!__inHTMLGrafting && el._tag === 'script' && !el._csimRan && el.isConnected) maybeRunScript(el);
    // Vite's preload-helper appends `<link rel="stylesheet">` for
    // CSS deps in a chunk's dependency list and awaits the link's
    // `load` event before resolving the chunk's dynamic-import
    // chain. Real browsers fire `load` once the stylesheet is
    // fetched and parsed; without this hook the lazy MediaContainer
    // / public.tsx `[data-component]` portal mount stalls forever.
    // `rel="modulepreload"` / `rel="preload"` get the same treatment
    // — the helper waits on them with the same pattern.
    if (el._tag === 'link') maybeFireLinkLoad(el);
    if (el._tag === 'iframe' || el._tag === 'frame') {
      // The frame's post-insertion step: its browsing context now exists, so
      // contentWindow becomes non-null. Set in this tree-order connect walk so a
      // script connected later in the same batch observes it (and one connected
      // earlier does not). See the contentWindow getter.
      el._browsingContextReady = true;
      maybeFireFrameLoad(el);
    }
    // HTML "nonce" hiding: once an element with a nonce content attribute is
    // connected, stash the value in an internal slot and empty the content
    // attribute so it can't be exfiltrated via a CSS attribute selector. An
    // atomic move (moveBefore) skips connection steps, so it preserves the
    // attribute; insertBefore / appendChild (which connect) clear it.
    if (el._attrs.nonce) { el._nonce = el._attrs.nonce; el._attrs.nonce = ''; }
    ceTryConnect(el);
  }
  function fireCEConnect(subtree) {
    // Selects whose options were (re)connected in this batch — their
    // selectedness setting algorithm runs once after the walk, when every
    // descendant option's selectedness has been initialised (the walk is
    // pre-order, so a select is visited before its options).
    const connectedSelects = [];
    // Track connect-walk nesting so a frame's contentWindow reports null until
    // its own (tree-order) connect step runs — see the contentWindow getter.
    globalThis.__csimConnectWalkDepth = (globalThis.__csimConnectWalkDepth || 0) + 1;
    try {
      walkSubtree(subtree, el => connectOneElement(el, connectedSelects));
    } finally {
      globalThis.__csimConnectWalkDepth--;
    }
    // Materialise the single-select implicit default (and dedupe multiple
    // authored `selected` options) now that every option's selectedness is set.
    for (const sel of connectedSelects) runSelectednessAlgorithm(sel, null);
  }
  // Streaming parser connect cursor: the parse5 adapter collects each appended
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
    // Same connect-walk-depth tracking as fireCEConnect: a parser-blocking
    // <script> draining here must see a not-yet-connected later frame as null.
    globalThis.__csimConnectWalkDepth = (globalThis.__csimConnectWalkDepth || 0) + 1;
    try {
      for (let i = 0; i < pending.length; i++) connectOneElement(pending[i], connectedSelects);
    } finally {
      globalThis.__csimConnectWalkDepth--;
    }
    for (const sel of connectedSelects) runSelectednessAlgorithm(sel, null);
  }
  // Streaming-parse hooks handed to `parse5ParseIntoLive`. The adapter calls
  // these as it builds the tree so we (a) queue MutationObserver childList
  // records for parser insertions once an observer exists, (b) collect each
  // appended element for the incremental connect cursor, and (c) run each
  // parser-blocking <script> inline at its `</script>` against the partial,
  // connected tree.
  let __streamCascadeDirty = false;
  // Set per load from a cheap scan of the source — gates the per-pop declarative-
  // shadow conversion so the overwhelming majority of pages (no `shadowrootmode`)
  // pay nothing for it.
  let __streamHasDSD = false;
  const __streamHooks = {
    onInsert(parent, node) {
      // `<template>` content (and everything below it) is an inert fragment —
      // parse5 builds it through this same adapter, but its nodes must NOT be
      // connected / upgraded or reported to observers; they only come alive when
      // cloned into a document (a declarative shadow template's content is
      // connected later by processDeclarativeShadowRoots). The one-shot
      // fireCEConnect walked `_children` only, never `_templateContent`, so it
      // skipped them; preserve that. Propagate the marker O(1) down the parse.
      if (parent.__csimTemplateContent === true || parent._inStreamTC === true) {
        node._inStreamTC = true;
        return;
      }
      if (node.nodeType === NODE_ELEMENT) {
        (__streamPendingConnect || (__streamPendingConnect = [])).push(node);
        if (node._tag === 'style' || node._tag === 'link') __streamCascadeDirty = true;
      }
      // A childList record only matters once something is observing; before the
      // first parse-time observer registers there is nothing to deliver to, and
      // the per-insertion call would just be churn on the hot parse path.
      if (hasObservers()) recordChildList(parent, [node], []);
    },
    onRemove(parent, node) {
      if (hasObservers()) recordChildList(parent, [], [node]);
    },
    // parse5 pops an element off the open-element stack at its end tag. Convert a
    // declarative-shadow `<template shadowrootmode>` the instant its `</template>`
    // closes so a following parse-time <script> observes `host.shadowRoot`
    // already populated — including one inside another `<template>`'s content (a
    // template-contents document processes DSD too: cloning that content must
    // yield a shadow root, per declarative-shadow-dom-basic.html). convert is a
    // no-op when the host isn't a valid shadow host (e.g. a bare fragment), so
    // it's safe to call for every closed shadowrootmode template.
    onPop(node) {
      if (!__streamHasDSD) return;
      if (node._tag === 'template' && node._attrs.shadowrootmode != null) {
        try { convertDeclarativeTemplate(node); } catch (_) {}
      }
    },
    onScript(scriptEl) {
      // Ingest an import map the instant its `<script type=importmap>` closes, so
      // a later declarative `shadowrootadoptedstylesheets` specifier (resolved
      // when its `<template>` converts at `</template>`) sees the mappings. The
      // post-parse ingest stays as an idempotent backstop.
      if ((scriptEl._attrs.type || '').toLowerCase() === 'importmap') {
        try { ingestImportmaps(globalThis.document); } catch (_) {}
        return;
      }
      // Only a classic, non-deferred, parser-blocking <script> runs inline mid-
      // parse. Modules, and external `defer`/`async`, are deferred to the post-
      // parse `runInlineScripts` pass (real-browser ordering) — leaving them
      // un-executed here lets that pass pick them up (they have no
      // `_csimExecuted`).
      if (!isParserBlockingScript(scriptEl)) return;
      // Stylesheets parsed since the last script change the cascade that a
      // connectedCallback (or this script) might read; rebuild only when one was
      // added — skipping the call keeps the common no-stylesheet-between-scripts
      // case free.
      if (__streamCascadeDirty) { __streamCascadeDirty = false; try { rebuildCascade(globalThis.document); } catch (_) {} }
      drainStreamConnect();   // connect + upgrade everything appended up to this script (grafting still on)
      // Microtask checkpoint between the connect steps and the script body: a
      // CE connectedCallback fired during the drain may have created slots and
      // queued `slotchange` (+ MutationObserver records); deliver them now so the
      // script observes them, matching the real-browser checkpoint between
      // parser-run scripts (slotchange-customelements.html).
      flushMutationDelivery();
      // The script body runs as an ordinary task: __inHTMLGrafting must be OFF so
      // a <script> it dynamically appends (e.g. div.appendChild(fragment with a
      // <script>)) executes synchronously on connection, the way it would in a
      // real browser — the parser's OWN <script>s stay gated by `_csimRan`, so
      // they can't double-run via the connect path while grafting is off.
      const prevGrafting = __inHTMLGrafting;
      __inHTMLGrafting = false;
      try { runOneScript(scriptEl); }
      finally { __inHTMLGrafting = prevGrafting; }
    }
  };
  function isParserBlockingScript(s) {
    const type = (s._attrs.type || '').toLowerCase();
    if (type === 'module') return false;                      // modules are always deferred
    if (type && !SCRIPT_TYPES_CLASSIC.has(type)) return false; // importmap / json / non-JS
    // `defer` / `async` only take effect on EXTERNAL scripts; both are ignored
    // for an inline script (which always blocks the parser).
    if (s._attrs.src != null && (s._attrs.defer !== undefined || s._attrs.async !== undefined)) return false;
    return true;
  }

  // Reassigning a connected stylesheet link's `.href` must re-fetch
  // and re-resolve dependent computed styles, same as the initial
  // connect path — real browsers swap the sheet in place.
  globalThis.__csim_onLinkHrefAssigned = maybeFireLinkLoad;

  // Reassigning a connected `<iframe>`/`<frame>`'s src/srcdoc re-navigates it:
  // the nested document reloads and `load` fires again. The dom-nodes setter
  // clears the cached contentWindow / realm / once-guard first, then calls this
  // so the new document's `load` reaches handlers an onload-then-navigate chain
  // (`iframe.onload = …; iframe.src = next`) installed.
  globalThis.__csim_onFrameSrcAssigned = maybeFireFrameLoad;

  // Apply a frame's OWN `location` navigation (contentWindow.location.href =,
  // in-frame location.href/assign/replace/location=). location.js routes a child
  // realm's cross-document nav to the host fn `__csimFrameNavigate`, which DEFERS
  // (so the child realm isn't disposed while its location setter is on the stack)
  // and then calls this in the realm that OWNS the iframe (its parent). We find
  // the iframe by realm id and reassign its `src` — reusing the src-reassignment
  // path (dispose the old realm, load the new document, fire the iframe's load).
  // (Same-URL reload via location.href is a no-op here — the src setter skips an
  // unchanged value — a documented minor gap; navigations to a different URL,
  // incl. about:blank, work.)
  globalThis.__csimNavigateFrameByRealm = function (realmId, url) {
    for (const tag of ['iframe', 'frame']) {
      const els = document.getElementsByTagName(tag);
      for (let i = 0; i < els.length; i++) {
        if (els[i]._frameRealmId === realmId) {
          try { els[i].setAttribute('src', url); } catch (_) {}
          return true;
        }
      }
    }
    return false;
  };

  // A connected `<iframe>` / `<frame>` fires `load` once its nested document is
  // ready. Two cases:
  //
  //  - The frame HAS a src/srcdoc and the engine supports per-frame realms (V8):
  //    we EAGERLY build the nested browsing context as an event-loop TASK —
  //    mirroring HTML "navigate" — so the nested document loads, runs its scripts,
  //    and fires its OWN window `load` (which is how a frame reports back via
  //    `parent.postMessage`) WITHOUT the parent ever touching `contentWindow`.
  //    Then this element's `load` fires. The BUILD is a TASK (not a microtask) so
  //    a nested / self-referential iframe enqueues its own build task in its realm
  //    rather than recursing synchronously — bounded by the nested-frame DEPTH
  //    guard (MAX_FRAME_DEPTH) in `create_frame_realm`. The element `load`,
  //    however, fires as a MICROTASK (see below) — load-bearing for disposal.
  //
  //  - Otherwise (empty/about:blank frame, or no realm support): the nested
  //    document loads lazily on `contentDocument` access, so we just defer a bare
  //    `load` event to a microtask (after `iframe.onload = …; body.appendChild`).
  //
  // Tests like Document-createElement-namespace.html await element `load` to read
  // `contentDocument`; query-target-in-load-event / url/data-uri-fragment rely on
  // the eager nested-document path (they never read `contentWindow`).
  // Which frames build EAGERLY (vs lazily on contentWindow access): only those
  // whose document we can load cheaply and locally — `srcdoc`, a `data:` URL, or
  // a SAME-ORIGIN `src`. A cross-origin `src` (Discourse oneboxes, third-party
  // embeds) is left lazy: eager-building it would `__rackFetch` an external URL
  // on every page load (cost + wrong content), and a cross-origin frame reporting
  // to the parent without a contentWindow touch is not something any in-scope
  // test/app needs. This keeps the eager path to the spec-observable local cases
  // (query-target / data-uri-fragment / data: contentType) and off the hot path
  // for external frames (rule 3).
  function frameEagerEligible(el) {
    if (!el._attrs) return false;
    if (el._attrs.srcdoc != null) return true;
    const src = el._attrs.src;
    if (src == null) return false;
    const s = String(src).trim();
    if (/^data:/i.test(s)) return true;
    if (/^about:/i.test(s) || s === '') return false;   // about:blank etc. → empty, lazy is fine
    try {
      const base = (globalThis.location && globalThis.location.href) || 'http://localhost/';
      return new URL(s, base).origin === new URL(base).origin;
    } catch (_) { return false; }
  }

  function maybeFireFrameLoad(el) {
    // Fire `load` once per navigation, not on every connect — a move / re-attach
    // (src unchanged) must NOT re-fire, else a `t.step_func_done` handler calls
    // done() twice. The guard is cleared when src/srcdoc is reassigned
    // (dom-nodes.js), so a real re-navigation does re-fire.
    if (el._frameLoadFired) return;
    el._frameLoadFired = true;
    const fireElementLoad = () => {
      if (!isConnected(el)) return;
      const ev = new Event('load');
      try { el.dispatchEvent(ev); } catch (_) {}
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
      globalThis.event = ev;
    };
    // Cheap engine/tag gates first so QuickJS (no realm support) short-circuits
    // before frameEagerEligible's same-origin `new URL()` work (rule 3).
    const canBuild = (el._tag === 'iframe' || el._tag === 'frame') &&
      globalThis.RustyRacer && typeof globalThis.RustyRacer.contextGlobal === 'function' &&
      typeof globalThis.__csim_createFrameRealm === 'function' &&
      frameEagerEligible(el);
    if (canBuild) {
      setTimeout(() => {
        if (!isConnected(el)) return;
        // Builds the realm (idempotent — returns the cached window if the parent
        // already touched contentWindow), loads + runs the nested document, and
        // fires its window `load` (in create_frame_realm). Discard the returned
        // cross-realm global so no handle to it lingers in this task's scope.
        try { if (globalThis.__csimFrameWindow) globalThis.__csimFrameWindow(el); } catch (_) {}
        Promise.resolve().then(fireElementLoad);
      }, 0);
    } else {
      Promise.resolve().then(fireElementLoad);
    }
  }

  function maybeFireLinkLoad(el) {
    const rel = (el._attrs.rel || '').toLowerCase().split(/\s+/);
    const isStylesheet = rel.includes('stylesheet');
    if (!isStylesheet && !rel.includes('modulepreload') && !rel.includes('preload')) return;
    const href = el._attrs.href;
    if (!href) return;
    Promise.resolve().then(() => {
      if (!isConnected(el)) return;
      let ok = true;
      try {
        const resp = __rackFetch('GET', href, '', null, 'follow');
        ok = !!(resp && resp.status < 400);
      } catch (_) { ok = false; }
      // Newly loaded stylesheet rules must be in the cascade index
      // before `load` fires, otherwise listeners that synchronously
      // read `getComputedStyle` / `var(--*)` see stale values.
      if (ok && isStylesheet) {
        try { rebuildCascade(globalThis.document); } catch (_) {}
      }
      try { el.dispatchEvent(new Event(ok ? 'load' : 'error')); } catch (_) {}
    });
  }
  let __initialScriptsDone = false;
  // True only while `__csimLoadDocument` is grafting the parsed HTML
  // skeleton onto the live document. Suppresses `maybeRunScript` for
  // parse-time `<script>` tags — `runInlineScripts` will execute
  // those in DOM order afterward. Once grafting ends, dynamic
  // appends (chunk loaders doing `head.appendChild(script)` mid-
  // evaluation) evaluate eagerly so their `onload` can resolve the
  // import Promise the caller is awaiting.
  let __inHTMLGrafting = false;
  // Chunk loaders await the `<script>` element's `load` event to
  // resolve the dynamic-import Promise that triggered the append.
  function dispatchScriptLoad(el, ok) {
    if (!el._attrs.src) return;
    try { el.dispatchEvent(new Event(ok ? 'load' : 'error')); } catch (_) {}
  }

  function maybeRunScript(el) {
    const type = (el._attrs.type || '').toLowerCase();
    // Same gate as the initial parse-time scripts: classic only, no
    // modules (those go through `runModuleScript`). Inline scripts in
    // the original document parse run via `runInlineScripts`; this
    // path is for dynamically-appended `<script>` elements.
    if (type && type !== 'text/javascript' && type !== 'application/javascript' &&
        type !== 'application/x-javascript' && type !== 'text/ecmascript') return;
    let body;
    if (el._attrs.src) {
      el._csimRan = true;   // external script: "already started" once preparation begins
      try {
        const resp = __rackFetch('GET', el._attrs.src, '', null, 'follow');
        if (!resp || resp.status >= 400) { dispatchScriptLoad(el, false); return; }
        body = resp.body || '';
      } catch (_) { dispatchScriptLoad(el, false); return; }
      if (!body) { dispatchScriptLoad(el, true); return; }
    } else {
      body = scriptText(el);
      // An EMPTY inline script is NOT marked "already started": per HTML's
      // children-changed steps, appending content while it's connected re-runs
      // preparation and executes it (Node-appendChild-text-in-script / three-
      // scripts). So leave `_csimRan` unset and fire no spurious load.
      if (!body) return;
      el._csimRan = true;
    }
    const label = el._attrs.src || ('inline://' + hashStr(body));
    let _ok = true;
    try { __csim_runScript(label, body); }
    catch (e) {
      _ok = false;
      logThrew('dynamic script', e);
    }
    dispatchScriptLoad(el, _ok);
  }

  // HTML "children changed steps" for a <script>: when content is appended to a
  // connected, not-already-started script, preparation re-runs and executes it.
  // The DOM mutation primitives call this after adding children to a script, so
  // `s.appendChild(textWithCode)` runs `s` synchronously (Node-appendChild-
  // text-in-script / three-scripts / script-in-script). Gated like maybeRunScript:
  // not during the initial parse graft (runInlineScripts owns that ordering).
  globalThis.__csimScriptChildrenChanged = function (el) {
    if (!__inHTMLGrafting && el && el._tag === 'script' && !el._csimRan && el.isConnected) {
      maybeRunScript(el);
    }
  };

  // ── Globals seen by Ruby side via Context#call('__csim<Op>') ────

  globalThis.Document = Document;
  globalThis.Element  = Element;
  installXPath(Document.prototype);   // Document.prototype.{evaluate,createExpression,createNSResolver}

  installOnHandlerSlots(Element);
  installWindowForwardedHandlers(Element);   // body/frameset on{blur,error,…} ↔ Window
  installVideoIDL(Element);
  installCanvasToBlob(Element);
  globalThis.__csim_onVideoSrcAssigned = onVideoSrcAssigned;
  globalThis.Node     = Node;
  // DOM Node.nodeType constants per spec. Libraries that compare
  // `node.nodeType == Node.ELEMENT_NODE` (Stimulus's `elementFromNode`
  // is the canonical case — it gates Stimulus's add-to-tree path on
  // this check, so without the constant a Turbo body swap's added
  // body never gets its `[data-controller]` descendants connected).
  installNodeConstants(Node);
  globalThis.Text     = Text;
  installDomClassAliases({ Element, Document, Text });

  // The boot document carries the html/head/body skeleton (the snapshot must
  // present a valid `documentElement`; per-visit loads graft onto it).
  globalThis.document = createHtmlPageDocument(true);
  globalThis.window   = globalThis;

  // Layout-driven observers — apps construct these at module init
  // (Turbo's FrameController is the canonical case); they expect the
  // constructor to succeed and `observe()` to be a no-op when there's
  // no layout. `takeRecords()` returns empty so dirty-tracking code
  // doesn't loop.

  globalThis.EventTarget     = EventTarget;

  globalThis.Blob       = Blob;
  globalThis.File       = File;

  globalThis.localStorage   = localStorage;
  globalThis.sessionStorage = sessionStorage;

  globalThis.ClipboardEvent = ClipboardEvent;


  // The XML-family content types that parse as XML (no implicit html/head/body
  // skeleton, case-sensitive) rather than HTML. Shared by DOMParser and the
  // frame-document loader so the two can't drift.
  function isXmlMimeType(t) {
    return t === 'text/xml' || t === 'application/xml' ||
           t === 'application/xhtml+xml' || t === 'image/svg+xml';
  }

  // `DOMParser` — parse an HTML / XML string into a Document. Turndown
  // (used by quote-reply Stimulus controller) checks `new DOMParser()`
  // at module-load time; without it, Turndown falls back to
  // `document.implementation.createHTMLDocument('').open()` which then
  // throws because we don't implement the legacy `Document.open()`.
  // Providing native DOMParser keeps Turndown on its fast path.
  // Each DOMParser is bound to the document that created it (its realm's
  // `document` at construction). Per spec the parsed document's URL is that
  // owner's URL — `new frames[0].DOMParser()` (the iframe realm's class) yields
  // a document with the iframe's URL even when called from this frame, and the
  // URL follows the PARSER instance (`this._ownerDoc`), not the method's realm.
  // The WebIDL `SupportedType` enum accepted by DOMParser#parseFromString.
  const DOMPARSER_SUPPORTED_TYPES = new Set([
    'text/html',
    'text/xml',
    'application/xml',
    'application/xhtml+xml',
    'image/svg+xml'
  ]);
  globalThis.DOMParser = class DOMParser {
    constructor() { this._ownerDoc = globalThis.document; }
    parseFromString(input, mimeType) {
      const src = String(input == null ? '' : input);
      // `type` is a WebIDL `SupportedType` enum. We stay lenient only for an
      // omitted argument (null/undefined → text/html, which some app callers
      // rely on); ANY explicitly-provided value outside the set — including the
      // empty string — is a TypeError, as in a real browser.
      const provided = mimeType != null;
      const t = provided ? String(mimeType).toLowerCase() : 'text/html';
      if (provided && !DOMPARSER_SUPPORTED_TYPES.has(t)) {
        throw new TypeError("Failed to execute 'parseFromString' on 'DOMParser': The provided value '" +
          String(mimeType) + "' is not a valid enum value of type SupportedType.");
      }
      // XML-family types parse as XML (no implicit html/head/body skeleton) and
      // carry their content-type, so the result reports `isHtmlDocument` false
      // — which gates case-sensitivity, `createCDATASection`, etc. text/html
      // stays on the HTML parser.
      let doc;
      if (isXmlMimeType(t)) {
        doc = parseXMLDocument(src);
        doc._contentType = t;
      } else {
        doc = parse5ParseDocument(src);
      }
      // Tag every node with its owner doc so `Element.ownerDocument`
      // returns this parsed Document rather than `globalThis.document`.
      // Turbo Drive's `activateElement` gates on `element.ownerDocument
      // !== document` before calling `importNode` — without this
      // tagging the cross-document check is silently false (every
      // ownerDocument resolves to the live document), importNode is
      // skipped, the cloned `<turbo-frame>` never upgrades to
      // FrameElement, and `<turbo-frame loading=lazy>` lazy responses
      // come back "did not contain the expected <turbo-frame>".
      // Scoped to DOMParser only — the visit pipeline's internal
      // `parseDocument` call grafts the parsed tree onto
      // `globalThis.document`, so those nodes must continue to report
      // the live document as their owner.
      walkSubtree(doc, n => { n._ownerDoc = doc; });
      // The parsed document's URL is the owner document's (read now so a
      // pushState on the owner since construction is reflected).
      const ownerURL = (this._ownerDoc || globalThis.document).URL;
      if (ownerURL) doc._url = ownerURL;
      // A DOMParser document has NO browsing context, so `document.location`
      // is null (parseXMLDocument/parseDocument default to a browsing context
      // for their frame / direct-navigation callers; DOMParser overrides it).
      doc._noBrowsingContext = true;
      // parseFromString is fed an already-decoded string, so the resulting
      // document's encoding is always UTF-8 regardless of any `<meta charset>`
      // in the markup (the byte-level sniffing that honours meta only runs for
      // documents loaded from bytes). Pin it so `characterSet` skips meta.
      doc._charsetOverride = 'UTF-8';
      // parseFromString parses synchronously and to completion — the resulting
      // document is never in a loading phase (no network/streaming), so its
      // `readyState` is "complete" (the XML path's constructor default of
      // "loading" is for byte-loaded / frame documents).
      doc.readyState = 'complete';
      return doc;
    }
  };

  // XML / XHTML document parse via the standalone namespace-aware parser
  // (xml-parser.js): no implicit html/head/body skeleton, self-closing tags on
  // any element, case-preserved names, processing-instruction / CDATA / doctype
  // nodes, and xmlns declarations resolved into `_ns` / `_attrNS`.
  // `documentElement` is null when the source has no element node.
  function parseXMLDocument(xml) {
    const doc = new Document();
    doc._children = newChildList();
    // The bare constructor yields a no-browsing-context application/xml shell;
    // a parsed (DOMParser / frame / direct-navigation) document has a browsing
    // context (location follows the global / frame) and the caller assigns its
    // URL + content type. readyState stays 'loading' until the load completes.
    doc._url               = undefined;
    doc._noBrowsingContext = false;
    doc.readyState         = 'loading';
    for (const node of parseXml(String(xml == null ? '' : xml))) {
      node._parent = doc;
      doc._children.push(node);   // documentElement derives from the first element child
    }
    return doc;
  }

  function makeFrameWindow(doc, frameEl) {
    let win;
    // A child browsing context's name, initialised from the container's `name`
    // attribute. Kept frame-local in a closure: this proxy has no per-frame
    // backing object (it wraps the shared globalThis), so a plain `win.name = …`
    // would write through to — and corrupt — the PARENT window's name.
    let frameName = frameEl.getAttribute('name') || '';
    win = new Proxy(globalThis, {
      get(target, prop) {
        switch (prop) {
          case 'document':     return doc;
          case 'frameElement': return frameEl;
          case 'name':         return frameName;
          case 'self':
          case 'window':       return win;
          case 'parent':
          case 'top':          return globalThis;
          default:             return Reflect.get(target, prop, globalThis);
        }
      },
      set(target, prop, value) {
        if (prop === 'name') { frameName = String(value); return true; }
        return Reflect.set(target, prop, value);
      },
      has(target, prop) { return Reflect.has(target, prop); }
    });
    return win;
  }

  // Same-realm nested browsing context for `<iframe>` / `<frame>`. Lazily loads
  // the frame's srcdoc / src (synchronously via __rackFetch), parses it into a
  // real nested Document, and returns a frame-window proxy: the global with
  // `document` / `frameElement` / `self` / `window` / `parent` / `top`
  // overridden — every other global (DOMException, Event, …) resolves to the one
  // shared realm, so `instanceof` across the boundary works. Cached on the
  // element; setAttribute('src'|'srcdoc') clears it so a navigation re-parses.
  // URL-only behaviour (target=_blank handles) is unaffected.
  globalThis.__csimFrameWindow = function (frameEl) {
    if (!frameEl || (frameEl._tag !== 'iframe' && frameEl._tag !== 'frame')) return null;
    // Per-iframe realm already built → its global is the frame window.
    if (frameEl._frameRealmId != null && globalThis.RustyRacer && typeof globalThis.RustyRacer.contextGlobal === 'function') {
      return globalThis.RustyRacer.contextGlobal(frameEl._frameRealmId);
    }
    if (frameEl._frameWindow) return frameEl._frameWindow;

    let body = '', contentType = 'text/html', frameUrl = '';
    const srcdoc = frameEl.getAttribute('srcdoc');
    if (srcdoc != null) {
      body = srcdoc;
    } else {
      const src = frameEl.getAttribute('src');
      if (src && src !== 'about:blank') {
        try {
          const base = (globalThis.location && globalThis.location.href) || 'http://localhost/';
          frameUrl = new URL(src, base).href;   // the frame document's own URL (incl. #fragment, for :target)
          if (/^data:/i.test(frameUrl)) {
            // `data:[<mediatype>][;base64],<data>` (RFC 2397) — decode inline, no
            // rackFetch. The URL fragment (#…) is NOT part of the body (it rides on
            // frameUrl for :target), so decode from the raw src up to the first `#`.
            const hashIdx = src.indexOf('#');
            const dm = /^data:([^,]*),([\s\S]*)$/i.exec(hashIdx === -1 ? src : src.slice(0, hashIdx));
            if (dm) {
              const b64 = /;base64\s*$/i.test(dm[1]);
              if (b64) { try { body = globalThis.atob(dm[2]); } catch (_) { body = ''; } }
              else { try { body = decodeURIComponent(dm[2]); } catch (_) { body = dm[2]; } }
              const ct = dm[1].replace(/;base64\s*$/i, '').split(';')[0].trim();
              if (ct) contentType = ct;
            }
          } else {
            const resp = globalThis.__rackFetch('GET', frameUrl, null, {}, 'follow');
            if (resp) {
              body = (resp.body || '');
              const ct = resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type']);
              if (ct) contentType = ct;
            }
          }
        } catch (e) { /* unreachable src → empty about:blank-ish document */ }
      }
    }

    // Real nested browsing context: a separate realm (own global + intrinsics)
    // built by the host, running the frame's own scripts. The frame window is
    // that realm's global; cross-realm refs (`frames[i].DOMParser` / `.Function`
    // / `.onerror`) resolve per spec because each realm is distinct.
    if (typeof globalThis.__csim_createFrameRealm === 'function' && globalThis.RustyRacer && typeof globalThis.RustyRacer.contextGlobal === 'function') {
      // The realm that owns this iframe — `__csimFrameWindow` runs in it, so
      // `contextOf(globalThis)` is the parent's context id. Passing it lets
      // `create_frame_realm` wire `window.parent` / `window.top` to the TRUE
      // parent (not unconditionally the main frame) BEFORE the frame's scripts
      // run, so a nested frame's load-time `window.parent.document` is correct
      // (Capybara's nested close-frame fixtures depend on this).
      const parentId = (typeof globalThis.RustyRacer.contextOf === 'function')
        ? globalThis.RustyRacer.contextOf(globalThis) : 0;
      // A child browsing context's name is its container's `name` content
      // attribute (`frames[i].name` / named `window.frames['name']`). Pass it so
      // create_frame_realm sets `window.name` BEFORE the document loads — a frame
      // whose load handler reads window.name to identify itself (declarative-shadow
      // declarative-child-frame) must see it (setting it after the load is too late).
      const id = globalThis.__csim_createFrameRealm(frameUrl, body, contentType, parentId, frameEl.getAttribute('name'));
      if (id != null) {
        frameEl._frameRealmId = id;
        // Register so this realm's event loop also steps the child's timers
        // (`__runLoopStep` → `drainChildRealms`). Removed on re-navigation.
        (globalThis.__csimChildRealmIds || (globalThis.__csimChildRealmIds = new Set())).add(id);
        const win = globalThis.RustyRacer.contextGlobal(id);
        try { win.frameElement = frameEl; } catch (e) {}
        return win;
      }
    }

    // Fallback (no realm support in the build): a same-realm frame window.
    const ct = String(contentType).split(';')[0].trim().toLowerCase();
    const doc = isXmlMimeType(ct) ? parseXMLDocument(body) : parse5ParseDocument(String(body));
    doc._contentType = ct || 'text/html';
    if (frameUrl) doc._url = frameUrl;
    const win = makeFrameWindow(doc, frameEl);   // initialises win.name from the `name` attr
    doc._defaultView = win;
    walkSubtree(doc, n => { n._ownerDoc = doc; });
    frameEl._frameWindow = win;
    return win;
  };

  // `URL.createObjectURL` / `revokeObjectURL` wire to the shared
  // Blob registry now that `globalThis.URL` exists.
  installBlobURL();


  // Handle registry — Ruby keeps integer ids, looks up Element back
  // via `__csimGet*(handle)` accessors. Wired in `parseDocument`
  // and pushed during create / append paths once those exist.
  // Document + its html/head/body skeleton need to be in the handle
  // registry so xpathway / find_xpath / `__csimVisible` lookups can
  // resolve skeleton nodes by id. Per-visit appendChild calls add
  // the grafted body descendants via `registerSubtree` automatically.
  registerNode(globalThis.document);
  // Hit-target descent: real browsers hit-test to the topmost element
  // under the cursor. Without layout, we approximate by descending
  // through a single-visible-element-child chain — Float-kit tooltips
  // wrap `<outer><trigger><container><inner/></container></trigger>
  // </outer>`; tests hover the outer wrapper but the listener lives on
  // the inner trigger span, so descent + bubble is what makes the event
  // reach the listener.
  function descendForHover(n) {
    while (n && n.nodeType === NODE_ELEMENT && n._children) {
      let only = null;
      let multi = false;
      for (const child of n._children) {
        if (child.nodeType !== NODE_ELEMENT) continue;
        if (!__isVisibleNode(child)) continue;
        if (only) { multi = true; break; }
        only = child;
      }
      if (multi || !only) break;
      n = only;
    }
    return n;
  }
  function commonAncestor(a, b) {
    if (!a || !b) return null;
    const seen = new Set();
    for (let cur = a; cur; cur = cur._parent) seen.add(cur);
    for (let cur = b; cur; cur = cur._parent) if (seen.has(cur)) return cur;
    return null;
  }
  function fireMouseEventSafe(node, type, init) {
    try { dispatchEvent(node, new MouseEvent(type, init)); } catch (_) {}
  }
  // Shared hover-target update: sets `document._hoverElement` so
  // `:hover` cascade matches resolve against this node, fires the
  // pointer/mouse over+enter+move sequence on the target (and bubbles
  // through ancestors), AND fires pointerleave/mouseleave on the
  // previously-hovered chain up to the common ancestor — Float-kit
  // tooltips with default `untriggers: ["hover", "click"]` close on
  // pointerleave, so without this dispatch sequential hovers across
  // sibling tooltips leak the first one open.
  function dispatchHover(n, opts) {
    opts = opts || {};
    const doc = globalThis.document;
    if (!doc) return;
    const prev = doc._hoverElement || null;
    // Cheap dedupe miss path: pre-click hover fires with `dedupe: true`
    // on every click, usually re-hovering the same element. Skip
    // descent + ancestor walks when the raw target matches.
    if (opts.dedupe && prev === n) return;
    const target = descendForHover(n);
    const changed = prev !== target;
    doc._hoverElement = target;
    if (opts.dedupe && !changed) return;
    const common = (prev && changed) ? commonAncestor(prev, target) : null;
    if (prev && changed) {
      const outInit = { bubbles: true, cancelable: true, relatedTarget: target };
      const leaveInit = { bubbles: false, cancelable: false, relatedTarget: target };
      fireMouseEventSafe(prev, 'pointerout', outInit);
      fireMouseEventSafe(prev, 'mouseout',   outInit);
      for (let cur = prev; cur && cur !== common; cur = cur._parent) {
        fireMouseEventSafe(cur, 'pointerleave', leaveInit);
        fireMouseEventSafe(cur, 'mouseleave',   leaveInit);
      }
    }
    const init = Object.assign({ bubbles: true, cancelable: true, relatedTarget: prev }, opts.init || {});
    const enterInit = { bubbles: false, cancelable: false, relatedTarget: prev };
    // pointerenter/mouseenter don't bubble — fire on each newly-entered
    // ancestor, outermost-first.
    const enterPath = opts.dispatchEnter ? [] : null;
    if (enterPath) {
      for (let cur = target; cur && cur !== common; cur = cur._parent) enterPath.push(cur);
    }
    fireMouseEventSafe(target, 'pointerover', init);
    if (enterPath) {
      for (let i = enterPath.length - 1; i >= 0; i--) fireMouseEventSafe(enterPath[i], 'pointerenter', enterInit);
    }
    fireMouseEventSafe(target, 'mouseover', init);
    if (enterPath) {
      for (let i = enterPath.length - 1; i >= 0; i--) fireMouseEventSafe(enterPath[i], 'mouseenter', enterInit);
    }
    fireMouseEventSafe(target, 'pointermove', init);
    fireMouseEventSafe(target, 'mousemove',   init);
  }
  // Ruby-callable hover dispatch: combines `_hoverElement` update +
  // mouseover + mouseenter in one host call so Ruby doesn't re-enter
  // JS twice.
  globalThis.__csimSetHover = function (h) {
    const n = lookup(h);
    if (!n) return false;
    dispatchHover(n, { dispatchEnter: true });
    return true;
  };
  // Drain the JS-side pending-submit slot for the Ruby side. Returns
  // `{formHandle, submitterHandle}` shape so callers don't have to
  // know about the internal `{form, submitter}` Node refs. Used by
  // `Browser#consume_pending_form_submit` after each user action
  // that might have triggered `<select onchange="$('#f').submit()">`.
  function __takePendingFormSubmit () {
    const p = globalThis.__csimPendingFormSubmit;
    if (!p) return null;
    globalThis.__csimPendingFormSubmit = null;
    return {
      formHandle:      p.form && p.form._id,
      submitterHandle: p.submitter && p.submitter._id
    };
  }
  globalThis.__csimTakePendingFormSubmit = __takePendingFormSubmit;
  globalThis.__csimTakePendingNavigation = function () {
    const p = globalThis.__csimPendingNavigation;
    globalThis.__csimPendingNavigation = null;
    return p;
  };
  globalThis.__csimTakePendingDownload = function () {
    const p = globalThis.__csimPendingDownload;
    globalThis.__csimPendingDownload = null;
    return p;
  };

  // Replace the document with a freshly-parsed one. Capybara's `visit`
  // ends up here. After parse, walk top-level `<script>` elements and
  // eval their bodies (inline) or route through the Rack-backed loader
  // (`<script src>` and `<script type=module>`).
  globalThis.__csimLoadDocument = function (html, contentType) {
    // Each Capybara visit lands here on a freshly-checked-out Context
    // from the snapshot pool. The Context is either:
    //   - "base snapshot" — just bridge + vendor bundle, no app bundles run.
    //     `__externalScriptsRun` empty, document has no body. Library
    //     scripts in the page's `<head>` get evaluated here for the
    //     first time.
    //   - "app-warm snapshot" — bridge + vendor + app library bundles
    //     pre-evaluated, with their `$(document).on(...)` delegates
    //     attached to `document` and `__externalScriptsRun` already
    //     containing the library URLs. `readyState` is still 'loading'
    //     because the warmup epilogue parks DOMContentLoaded.
    // In the app-warm case the library delegates must keep pointing at
    // the SAME `document` instance the snapshot baked them against, so
    // we reuse `globalThis.document` here and only swap in fresh
    // children. In the base case we just append onto the empty doc.
    __initialScriptsDone = false;
    resetCascadeState();
    // Reset the monotonic layout-Y counter so the new document's
    // first-measured element (typically the header that sets
    // `--header-offset`) lands at Y=0; subsequent measurements stack
    // upward and Discourse's `_moveSelection` finds first-visible
    // articles correctly (without a real layout engine).
    resetLayoutY();
    // Hover / pending-submit slots are per-visit transient state —
    // clear them so a stale `_hoverElement` from the previous page
    // can't keep matching `:hover` cascade rules against detached
    // nodes, and a never-consumed `__csimPendingFormSubmit` doesn't
    // pin the old form/submitter pair alive across the rebuild.
    globalThis.document._hoverElement = null;
    globalThis.__csimPendingFormSubmit = null;
    // Scroll offset is preserved on `documentElement` across SPA route
    // changes (so Discourse's route-scroll-manager can restore it on
    // `page.go_back`); a full-document visit resets it like a new tab.
    const __root = globalThis.document.documentElement;
    if (__root) { __root._scrollTop = 0; __root._scrollLeft = 0; }

    // XML / XHTML documents: parse with the XML rules (no implicit
    // html/head/body skeleton, case-sensitive tags, xmlns → _attrNS) and
    // replace the live document's tree wholesale rather than grafting into a
    // skeleton. Scripts still run — XHTML test files carry <script src> +
    // inline scripts — and the document keeps its identity (and content type),
    // so it reports `isHtmlDocument` false (case-sensitivity, createCDATASection,
    // namespace lookups).
    const __ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (isXmlMimeType(__ct)) {
      __inHTMLGrafting = true;
      const xmlDoc = parseXMLDocument(String(html == null ? '' : html));
      const dx = globalThis.document;
      // Drop the previous tree, unregistering its handles so a stale `_id`
      // can't resolve to a detached node (every other mutation path does this).
      for (const c of dx._children.slice()) { unregisterSubtree(c); c._parent = null; }
      dx._children = newChildList();
      dx._contentType = __ct;
      for (const c of xmlDoc._children) {
        c._parent = dx;
        walkSubtree(c, (n) => { n._ownerDoc = dx; });
        dx._children.push(c);   // documentElement derives from the first element child
      }
      registerSubtree(dx);
      // Connect the parsed tree (custom-element upgrades + deferred iframe /
      // link `load`). Still in the grafting phase so `<script>` bodies aren't
      // run here — runInlineScripts executes them in order just below, and the
      // deferred load microtasks fire after, once handlers are registered.
      globalThis.__csimFireCEConnect(dx);
      dx.readyState = 'loading';
      rebuildCascade(dx);
      __inHTMLGrafting = false;
      runInlineScripts(dx);
      dx.readyState = 'interactive';
      try { dispatchEvent(dx, new Event('readystatechange', { bubbles: false, cancelable: false })); } catch (_) {}
      dx.readyState = 'complete';
      try { dispatchEvent(dx, new Event('readystatechange', { bubbles: false, cancelable: false })); } catch (_) {}
      __initialScriptsDone = true;
      return dx._id;
    }

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
    // Stay on 'loading' for the whole parse: a parser-blocking script (which now
    // runs DURING the parse, below) must see readyState='loading' and register
    // `DOMContentLoaded` rather than fire ready callbacks inline. Forem's
    // `base.js` is the canonical case — ahoy.js schedules `ahoy.start()` via
    // `documentReady`; if readyState were already 'complete' it would fire before
    // `ahoy.configure` runs, undoing the test-env opt-out.
    d.readyState = 'loading';
    __streamPendingConnect = [];
    __streamCascadeDirty = false;
    __streamHasDSD = /shadowrootmode/i.test(srcHtml);
    // Parse the response directly into the live document via parse5, REUSING its
    // <html>/<head>/<body> identities: library IIFEs (jQuery 3.x) capture
    // `document.documentElement` at eval time, so replacing the skeleton would
    // strand them. parse5 drops the prior tree, rebuilds the prolog, quirks flag
    // (`compatMode`), skeleton opening-tag attributes (Redmine's
    // `body.controller-X.action-Y` cascade scoping), and the full tree. The
    // streaming hooks (`__streamHooks`) interleave it with execution the way a
    // real browser does: each parser-blocking classic <script> runs inline at
    // its `</script>` against the partial, connected tree, and per-insertion
    // MutationObserver records fire once a parse-time observer exists.
    parse5ParseIntoLive(d, srcHtml, __streamHooks);
    // Connect / upgrade the tail — everything appended after the last inline
    // script (or the whole tree when the page authored no parser-blocking
    // script). The streaming `onScript` already connected each earlier segment.
    drainStreamConnect();
    // Declarative Shadow DOM: convert leftover `<template shadowrootmode>` now
    // that parse-time scripts have run (one may have imperatively attached a
    // shadow, or moved a template — the converter validates each against its
    // parse-time parent). Ingest the import map first so a declarative
    // `shadowrootadoptedstylesheets` specifier resolves. Cheap scan gate skips
    // the O(N) walk on the majority of pages with no declarative shadow root.
    if (/shadowrootmode/i.test(srcHtml)) { ingestImportmaps(d); processDeclarativeShadowRoots(d); }
    // Final cascade for the complete tree. Content-keyed, so it's a no-op when a
    // parse-time rebuild already covered the authored stylesheets; it backstops
    // pages whose styles arrived after the last (or with no) inline script.
    rebuildCascade(d);
    __inHTMLGrafting = false;
    // Run the deferred remainder — modules + external defer/async — and anything
    // the streaming handler skipped; scripts already executed inline are skipped
    // via their `_csimExecuted` flag.
    runInlineScripts(d);
    // Browsers fire `readystatechange` on every `document.readyState`
    // transition. Turbo Drive's `PageObserver` listens on document
    // for it and only dispatches `turbo:load` once readyState reaches
    // 'complete'; Avo's `initTippy()` (and a long tail of other
    // `turbo:load`-bound init) won't run unless we fire the
    // transition.
    d.readyState = 'interactive';
    try { dispatchEvent(d, new Event('readystatechange', { bubbles: false, cancelable: false })); } catch (_) {}
    d.readyState = 'complete';
    try { dispatchEvent(d, new Event('readystatechange', { bubbles: false, cancelable: false })); } catch (_) {}
    // Flip the dynamic-script gate on: post-load <script> appends
    // (Rails-UJS dataType:'script' eval into head, jQuery .html() of
    // a fragment containing <script>) will now run via the
    // fireCEConnect → maybeRunScript path.
    __initialScriptsDone = true;
    return globalThis.document._id;
  };

  // The Ruby↔V8 round-trip floor is ~4 ms per call. Running
  // the per-visit setter chain as 7 sequential calls cost ~28 ms of
  // pure overhead per visit; collapsing them into one payload is safe
  // because every setter is idempotent and order-insensitive past
  // `__csimLoadDocument`.
  globalThis.__csimBootContext = function (opts) {
    if (typeof opts.viewportW === 'number') globalThis.innerWidth  = opts.viewportW;
    if (typeof opts.viewportH === 'number') globalThis.innerHeight = opts.viewportH;
    if (opts.userAgent) {
      try { Object.defineProperty(globalThis.navigator, 'userAgent', { value: opts.userAgent, configurable: true }); } catch (_) {}
    }
    globalThis.__csimSetTraceActive(!!opts.traceActive);
    globalThis.__csimSetTimezone(opts.timezone || '');
    if (opts.timeTravelOffsetMs) globalThis.__csimSetTimeTravelOffsetMs(opts.timeTravelOffsetMs);
    if (opts.url) globalThis.__csimUpdateLocation(opts.url);
    return globalThis.__csimLoadDocument(opts.html, opts.contentType);
  };

  // External script URLs that have been evaluated in this Context.
  // Persists across page loads. Once an app-wide bundle (jQuery,
  // application-legacy.js, rails-ujs, etc.) has run its IIFE — which
  // typically attaches listeners to `document` via `$(document).on(...)`
  // — re-evaluating it on the next visit would attach the *same*
  // listeners again, duplicating delegated handlers. Real browsers
  // don't re-run cached scripts on bf-cache / SPA navigation, and we
  // keep `document` stable across visits, so the resulting semantics
  // match.
  // url → body. Doubles as the "already evaluated" set (.has() check
  // semantics) and the registry the Ruby side reads to build the
  // app-warm snapshot. Map (not Set) so we can hand back the bodies
  // verbatim instead of re-fetching them.
  const __externalScriptsRun = new Map();
  function runInlineScripts(doc) {
    if (!doc || !doc.documentElement) return;
    // Importmaps land first so `<script type="module">` can resolve
    // bare specifiers against them.
    ingestImportmaps(doc);
    // Snapshot to a plain array: running a script must not let it perturb the
    // bounds of the loop iterating the script set (e.g. a script that injects
    // more scripts). Snapshot from `getElementsByTagName` (an HTMLCollection),
    // NOT `querySelectorAll` (a static NodeList) — a static NodeList reads its
    // length through `NodeList.prototype.length`, which a page can tamper
    // (NodeList-static-length-getter-tampered-3.html does, now mid-parse under
    // streaming); `Array.from` would then copy a truncated/undefined-padded list
    // and crash this loop. The HTMLCollection's length is immune to that tamper.
    const scripts = Array.from(doc.documentElement.getElementsByTagName('script'));
    for (const s of scripts) {
      // Skip a script the streaming parse already executed inline at its
      // `</script>` (its `scriptHandler` ran it against the partial tree).
      // The after-parse pass then runs only the deferred remainder — modules,
      // `defer` / `async`, and anything the handler chose not to run inline.
      if (s._csimExecuted) continue;
      runOneScript(s);
    }
    if (hasObservers() && hasQueuedRecords()) deliverMutations();
    if (typeof globalThis.__recheckIntersectionObservers === 'function') globalThis.__recheckIntersectionObservers();
    // After scripts have run, fire the readiness lifecycle events
    // libraries hook into (`DOMContentLoaded` on document, `load` on
    // window). jQuery 1.x's `$(handler)` short-circuits if
    // `readyState === 'complete'` at the time it's called; but a
    // library that registers via `addEventListener('DOMContentLoaded')`
    // only sees the handler fire if we actually emit the event.
    if (doc) {
      // UA-fired lifecycle event → trusted (the internal dispatcher leaves
      // isTrusted alone, so mark it here).
      const dcl = new Event('DOMContentLoaded', { bubbles: true, cancelable: false });
      dcl.isTrusted = true;
      try { dispatchEvent(doc, dcl); } catch (_) {}
    }
  }
  // Run ONE <script> per the HTML "execute the script element" steps: type
  // dispatch (importmap consumed elsewhere; module → deferred module eval;
  // classic inline / external-src). Shared by the after-parse `runInlineScripts`
  // loop and the streaming `scriptHandler` (which runs classic parser-blocking
  // scripts inline at `</script>`). `_csimExecuted` records that this element's
  // script actually ran so the after-parse pass doesn't re-run it; `_csimRan`
  // additionally gates the dynamic-append path (`maybeRunScript`).
  function runOneScript(s) {
    const type = (s._attrs.type || '').toLowerCase();
    if (type === 'importmap') return;  // already consumed
    if (type === 'module') {
      s._csimExecuted = true;
      runModuleScript(s);
      flushMutationDelivery();
      return;
    }
    if (type && !SCRIPT_TYPES_CLASSIC.has(type)) return;
    let body;
    if (s._attrs.src) {
      // De-dupe across page loads: each app-wide bundle runs once
      // per Context. See `__externalScriptsRun` comment above.
      if (__externalScriptsRun.has(s._attrs.src)) return;
      // Synchronous fetch via Ruby Rack callback (the engine's attach is
      // blocking, preserving classic-script "block the parser until loaded"
      // without an event loop). `__csimExternalAsset` serves fingerprinted app
      // bundles from a cross-visit cache so a fresh VM per visit doesn't re-fetch
      // them — a real browser HTTP-caches; returns null on 4xx / failure.
      body = globalThis.__csimExternalAsset(s._attrs.src);
      if (!body) return;
      __externalScriptsRun.set(s._attrs.src, body);
    } else {
      body = scriptText(s);
    }
    // An empty document-parsed <script> is left preparable (un-mark the
    // parser's "already started" flag) so appending content later runs it via
    // the children-changed steps. Fragment/innerHTML scripts never reach here,
    // so they keep their parser-set flag and stay inert on insertion.
    if (!body) { s._csimRan = false; return; }
    // Route through Ruby so the runtime can cache compiled bytecode
    // across per-visit context rebuilds (QuickJS today; V8 once the
    // upstream cache PR lands). Indirect-eval semantics are
    // preserved: both runtimes evaluate at globalThis.
    //
    // `document.currentScript` must point at the executing <script>
    // during eval so webpack/embroider bundles can read
    // `currentScript.src` to derive the public-path origin. Restore
    // afterwards so unrelated callers see the spec-default `null`.
    const label = s._attrs.src || ('inline://' + hashStr(body));
    const prevCurrent = globalThis.document && globalThis.document._currentScript;
    if (globalThis.document) globalThis.document._currentScript = s;
    s._csimRan = true;
    s._csimExecuted = true;
    let _ok = true;
    try { __csim_runScript(label, body); } catch (e) {
      _ok = false;
      try {
        const _prev = Error.stackTraceLimit; Error.stackTraceLimit = 60;
        const where = s._attrs.src || ('(inline) ' + body.slice(0, 120).replace(/\s+/g, ' '));
        const detail = (e && (e.stack || e.message)) || ('typeof=' + typeof e + ' str=' + String(e));
        console.error('[csim] script threw in', where, ':', detail);
        Error.stackTraceLimit = _prev;
      } catch (_) {}
    } finally {
      if (globalThis.document) globalThis.document._currentScript = prevCurrent;
    }
    dispatchScriptLoad(s, _ok);
    // HTML "clean up after running a script": the JS stack is empty between
    // parser-run scripts, so the microtask checkpoint's MutationObserver /
    // slotchange delivery runs here. Flush just that compound microtask (not
    // the whole agent job queue — cross-realm Promise timing stays untouched)
    // so a later inline <script> observes the same state a real browser would
    // — e.g. slotchange fired for custom elements an earlier <script>'s
    // `customElements.define` just upgraded.
    flushMutationDelivery();
  }
  function runModuleScript(s) {
    const baseUrl = (globalThis.location && globalThis.location.href) || null;
    if (s._attrs.src) {
      const url = resolveAgainst(s._attrs.src, baseUrl);
      try { __csim_evalEsmEntry(url, null); }
      catch (e) {
        try { console.error('[csim] module', url, 'failed:', e && (e.stack || e.message)); } catch (_) {}
      }
    } else {
      const body = scriptText(s);
      if (!body) return;
      const url = (baseUrl || 'inline://') + '#inline-' + hashStr(body);
      try { __csim_evalEsmEntry(url, body); }
      catch (e) {
        try { console.error('[csim] inline module failed:', e && e.message); } catch (_) {}
      }
    }
  }
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  const SCRIPT_TYPES_CLASSIC = new Set([
    '', 'text/javascript', 'application/javascript', 'application/ecmascript'
  ]);


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
  // moment a script starts with `var ...;` or similar.
  const __evalCache = new Map();
  function compileScript(code) {
    let fn = __evalCache.get(code);
    if (!fn) {
      fn = new Function('return eval(' + JSON.stringify(code) + ');');
      __evalCache.set(code, fn);
    }
    return fn;
  }
  globalThis.__csimEvalScript = function (code, args) {
    return marshalReturn(compileScript(code).apply(null, rehydrateArgs(args || [])));
  };
  // Run the script, drop the return. Lets execute_script tolerate
  // scripts whose result is a chainable jQuery object or other
  // structure the marshaller would walk recursively
  // (StackOverflowError when prevObject self-references chain).
  globalThis.__csimExecScript = function (code, args) {
    compileScript(code).apply(null, rehydrateArgs(args || []));
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
  // A DOM collection that is NOT an Array exotic: HTMLCollection (a legacy
  // platform object) and a STATIC NodeList (querySelectorAll's return). A LIVE
  // childNodes NodeList still IS an Array exotic and is caught by `Array.isArray`
  // before this. Both are iterable, so `Array.from` walks them — a script
  // returning one marshals to an array of element handles, like a real browser
  // serialising a collection.
  function isDomCollection(v) {
    return v && typeof v === 'object' &&
      ((globalThis.HTMLCollection && v instanceof globalThis.HTMLCollection) ||
       (globalThis.NodeList && v instanceof globalThis.NodeList));
  }
  // Inverse: when a script returns an Element / NodeList, marshal so
  // the Ruby side can wrap the handles back into Node instances.
  function marshalReturn(value) {
    if (value && typeof value === 'object' && value.nodeType !== undefined && typeof value._id === 'number') {
      return { __elementHandle: value._id };
    }
    if (Array.isArray(value)) return value.map(marshalReturn);
    if (isDomCollection(value)) {
      return Array.from(value, marshalReturn);
    }
    return value;
  }
  // Visibility predicate exposed to the Element class for layout-shaped
  // getters (offsetWidth, getBoundingClientRect, …). Mirrors the
  // ancestor walk in `__csimVisible` but takes a node directly. We
  // don't model real layout, so the answer is "true unless something
  // says hidden": INVISIBLE_TAGS (head/script/style/template/…),
  // `<input type=hidden>`, the `hidden` attribute, inline `display:none`
  // / `visibility:hidden`, or a cascade rule the resolver agrees with.

  globalThis.__csimVisible = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if (INVISIBLE_TAGS.has(n._tag)) return false;
    if (n._tag === 'input' && (n._attrs.type || '').toLowerCase() === 'hidden') return false;
    let summarySeen = false;
    let cur = n;
    let prev = null;
    while (cur) {
      if (cur.nodeType === NODE_DOC) break;
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        // Display-side hiding only (ignoreVisibility=true): `visibility`
        // inherits and a descendant can override it, so it's resolved
        // per-target after the walk, not flagged on any hidden ancestor.
        if (selfHidden(cur, true)) return false;
        // `<details>` hides its non-summary content while closed —
        // but the `<details>` element itself (and its `<summary>`) is
        // rendered. Spec-equivalent UA stylesheet rule is
        // `details:not([open]) > *:not(summary) { display: none }`,
        // which higher-specificity author rules (e.g. Discourse
        // select-kit's `.is-expanded .select-kit-body { display:
        // flex }`) override per cascade. We don't materialise the UA
        // rule, so check the direct child of the closed `<details>`
        // on the path to `n`: if cascade gives it an explicit non-
        // `none` `display`, the UA rule is overridden and the
        // subtree is visible; otherwise the UA rule applies and
        // we treat `n` as hidden.
        if (cur !== n && cur._tag === 'details' && cur._attrs.open == null && !summarySeen) {
          const display = prev && prev.nodeType === NODE_ELEMENT ? resolveCascadeDisplay(prev) : null;
          if (display == null || display === 'none') return false;
        }
        if (cur._tag === 'summary') summarySeen = true;
      }
      prev = cur;
      cur = cur._parent;
    }
    // `visibility` inherits but a descendant `visibility:visible` overrides an
    // ancestor's hidden — resolve the target's effective visibility once,
    // honouring that override, rather than failing on any hidden ancestor.
    if (visibilityHidden(n)) return false;
    return true;
  };

  // visible_text walks the subtree like textContent does, but skips
  // INVISIBLE_TAGS / hidden / display:none / `<input type=hidden>`
  // children. Capybara's `has_text?` defaults to this path; without
  // the skip, page titles and `<script>` source land in the
  // visible-text string and trip "found N times including non-visible
  // text" assertions.
  function __computeVisibleText(n) {
    // If any ancestor is hidden, the whole subtree is invisible —
    // Capybara's `text` on a node found with `visible: false` whose
    // parent has `display: none` must return ''. collectVisibleText
    // only consults the descended-into node, so walk parents first.
    for (let cur = n._parent; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_ELEMENT && (INVISIBLE_TAGS.has(cur._tag) || selfHidden(cur))) return '';
    }
    // WebDriver §13.5: `getText` on `<textarea>` returns the IDL
    // `value`, not subtree text. React-controlled textareas keep
    // an empty subtree, so without this `have_css(text:)` would
    // never match content typed into one.
    if (n.nodeType === NODE_ELEMENT && n._tag === 'textarea') {
      return n.value == null ? '' : String(n.value);
    }
    // Pick up an inherited text-transform from ancestors above the
    // starting node so e.g. `<body style="text-transform:uppercase">`
    // applies to a descendant's visible_text. Same idea for
    // `white-space: pre*` so a query rooted inside a `<pre>` keeps
    // preserving newlines.
    const startTransform = n._parent ? resolveTextTransform(n._parent) : 'none';
    let preserveWs = false;
    for (let cur = n._parent; cur; cur = cur._parent) {
      if (cur.nodeType !== NODE_ELEMENT) continue;
      if (elementPreservesWhitespace(cur)) { preserveWs = true; break; }
    }
    return collectVisibleText(n, startTransform, preserveWs);
  }
  // `Element#innerText` IDL getter (the JS-side `el.innerText`): the "as rendered"
  // text — visible-only (flat-tree, slot-projected, hidden-skipped) with space
  // runs collapsed and per-line trim, per W3C §11. Backs the Element.prototype
  // getter (dom-nodes.js), which falls back to textContent only pre-boot. Same
  // collapse the host-query `:innerText` path (host-queries.js) applies.
  function __collapseInnerText(raw) {
    if (raw == null) return '';
    return raw.split('\n').map(line => line.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/^\n+|\n+$/g, '');
  }
  // HTML "innerText getter" step 1: an element that is NOT being rendered returns
  // its `textContent`, NOT the (empty) rendered text. "Not being rendered" is
  // DISPLAY-side hiding (display:none / `hidden` attr / an INVISIBLE_TAG ancestor)
  // — NOT visibility:hidden, which DOES generate boxes (is rendered) and so yields
  // the rendered text (empty for hidden content). selfHidden(_, true) is exactly
  // the display-only, cascade-resolved predicate (a class like `.hidden{display:
  // none}` counts). Without this, `el.innerText` of a field inside an inactive
  // (display:none) tab returns '' — Avo's date_field_controller reads it to parse
  // the timestamp and renders "Invalid DateTime" (regression from this getter
  // replacing the old textContent fallback). Matches Chromium / CLAUDE.md rule 2.
  function __innerTextNotRendered(n) {
    // One parent walk: a DISPLAY-hidden / INVISIBLE_TAG / hidden-input ancestor →
    // not rendered; reaching a Document → connected & rendered; falling off the
    // top without a Document → a detached subtree, also "not being rendered" (spec
    // + MDN list "detached from the document"). ShadowRoot._parent is its host, so
    // connected shadow content reaches the Document here (not misread as detached).
    for (let cur = n; cur; cur = cur._parent) {
      if (cur.nodeType === NODE_DOC) return false;
      if (cur.nodeType !== NODE_ELEMENT) continue;
      if (INVISIBLE_TAGS.has(cur._tag)) return true;
      if (cur._tag === 'input' && (cur._attrs.type || '').toLowerCase() === 'hidden') return true;
      if (selfHidden(cur, true)) return true;
    }
    return true;
  }
  globalThis.__csimInnerText = function (node) {
    if (!node) return '';
    // A <textarea>'s rendered text is its IDL value, which changes without a
    // settle-gen bump — don't memoize (cheap, no subtree walk). Mirrors __csimVisibleText.
    if (node.nodeType === NODE_ELEMENT && node._tag === 'textarea') return __collapseInnerText(__computeVisibleText(node));
    // Memoize the result per (settleGen, cascadeVersion) — the getter is read
    // broadly and the old textContent path also walked, so this is a net win and
    // keeps a hot `.innerText` reader O(1) between mutations (rule 3). The
    // not-being-rendered branch is folded in: textContent (DOM-mutation-keyed) and
    // the rendered text (cascade-keyed) both invalidate on the same gen/cv key.
    const gen = globalThis.__settleGenGet();
    const cv  = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
    if (node._itGen === gen && node._itCV === cv) return node._it;
    const out = __innerTextNotRendered(node)
      ? (node.textContent == null ? '' : String(node.textContent))
      : __collapseInnerText(__computeVisibleText(node));
    node._itGen = gen; node._itCV = cv; node._it = out;
    return out;
  };
  globalThis.__csimVisibleText = function (h) {
    const n = lookup(h);
    if (!n) return '';
    // A <textarea>'s visible_text is its IDL `.value`, which the value setter
    // writes (`_attrs.value`) WITHOUT a settle-gen bump (React-controlled
    // textareas, `el.value = …`). Don't memoize it — it's cheap (no subtree walk)
    // and the cache would go stale on value change.
    if (n.nodeType === NODE_ELEMENT && n._tag === 'textarea') return __computeVisibleText(n);
    // Memoize the full-subtree walk per node. have_text/assert_text poll the SAME
    // unchanged node repeatedly; recomputing each time is ~14% of suite wall
    // ([[perf_boundary_is_js_exec]]). Key on BOTH the settle generation (DOM/URL
    // mutations) AND the cascade version: a deferred <link> load / @media resize
    // rebuilds the cascade (changing display/visibility/text-transform) WITHOUT a
    // DOM mutation, so settleGen alone is an incomplete key. Safe under the
    // deterministic clock — the virtual-clock advance no longer reads csim's
    // execution wall, so this speedup can't shift timer firing (the perf↔timing
    // coupling that previously flipped actions_spec:464 is closed).
    const gen = globalThis.__settleGenGet();
    const cv  = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
    if (n._vtGen === gen && n._vtCV === cv) return n._vt;
    const result = __computeVisibleText(n);
    n._vtGen = gen; n._vtCV = cv; n._vt = result;
    return result;
  };

  globalThis.__csimTimersDebug = timerStats;
  // Sum each ancestor's top/left to translate an element's
  // CSS-declared box into an absolute "viewport" position. We don't
  // run a layout engine; this is just "if a test declares position
  // via px values, honour those values" — enough for the
  // click-offset specs.
  globalThis.__csimElementRect = function (h) {
    const el = __handles.get(h);
    if (!el || el.nodeType !== NODE_ELEMENT) return { x: 0, y: 0, width: 0, height: 0 };
    let x = resolveLayoutProp(el, 'left') || 0;
    let y = resolveLayoutProp(el, 'top')  || 0;
    const w = resolveLayoutProp(el, 'width')  || 0;
    const h2 = resolveLayoutProp(el, 'height') || 0;
    for (let cur = el._parent; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
      x += resolveLayoutProp(cur, 'left') || 0;
      y += resolveLayoutProp(cur, 'top')  || 0;
    }
    return { x, y, width: w, height: h2 };
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
        ? __handles.get(a.__elementHandle) || null
        : a
    );
    list.push(function (v) { __asyncResult = { value: __marshalAsyncResult(v) }; });
    try {
      (new Function('args', 'return (function (' +
        list.map((_, i) => 'a' + i).join(', ') +
        ') { ' + String(code) + ' }).apply(null, args);'))(list);
    } catch (e) {
      __asyncResult = { value: null, error: e && e.message };
    }
  };
  function __marshalAsyncResult (v) {
    if (v && typeof v === 'object') {
      if (v.nodeType === NODE_ELEMENT) return { __elementHandle: v._id };
      if (Array.isArray(v)) return v.map(__marshalAsyncResult);
      // A static NodeList / HTMLCollection isn't an Array but marshals as a list
      // of handles (mirrors marshalReturn for the sync path).
      if (isDomCollection(v)) return Array.from(v, __marshalAsyncResult);
    }
    return v;
  }
  globalThis.__pollAsyncResult = function () { return __asyncResult; };


  function __csimMakeDataTransfer(items) {
    const dt = new globalThis.DataTransfer();
    for (const it of items || []) {
      if (it.kind === 'file') {
        const file = { name: it.name, type: '', size: 0 };
        dt.items.push(new globalThis.DataTransferItem('file', 'application/octet-stream', null, file));
        if (!dt.types.includes('Files')) dt.types.push('Files');
      } else {
        dt.items.push(new globalThis.DataTransferItem('string', it.type, it.value, null));
        if (!dt.types.includes(it.type)) dt.types.push(it.type);
      }
    }
    return dt;
  }
  // Finish a click that was started with `mouseDownOnly: true`: fire
  // mouseup + click, then return the same action shape
  // `__csimClickResolve` produces so Ruby can drive the navigate /
  // submit follow-up.
  globalThis.__csimClickFinish = function (h, base) {
    const n = __handles.get(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    dispatchEvent(n, new MouseEvent('mouseup', base));
    const click = new MouseEvent('click', base);
    click._csimActivationHandled = true;   // checkbox/radio toggle handled by the click resolver
    dispatchEvent(n, click);
    const pendingSubmit = __takePendingFormSubmit();
    if (pendingSubmit) return { kind: 'submit', formHandle: pendingSubmit.formHandle, submitter: pendingSubmit.submitterHandle || 0 };
    if (click.defaultPrevented) return null;
    if (n._tag === 'a' && n._attrs.href != null) {
      const href = String(n._attrs.href);
      if (/^\s*javascript:/i.test(href)) return null;
      if (n._attrs.download != null) {
        return { kind: 'download', url: href, filename: String(n._attrs.download || '') };
      }
      let target = String(n._attrs.target || '');
      if (click && (click.metaKey || click.ctrlKey)) target = '_blank';
      return { kind: 'navigate', url: href, target };
    }
    return null;
  };

  globalThis.__csimDropOnto = function (h, items) {
    const target = __handles.get(h);
    if (!target) return false;
    const dt = __csimMakeDataTransfer(items || []);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = dt;
      dispatchEvent(target, ev);
    }
    return true;
  };

  // Capybara `Element#drag_to(other)` — element-to-element HTML5
  // drag. mousedown on source primes libraries that gate
  // `draggable="true"` on a recent mousedown (Discourse
  // sidebar-section-form-link), then the full drag-event chain
  // fires with a shared DataTransfer. DragEvent (which extends
  // MouseEvent) defaults `offsetY` to 0, so listeners that compute
  // `offsetY < height/2` to decide "above vs below" land on
  // "above" — matches Capybara's drag_to semantic of moving the
  // source to *before* the target.
  globalThis.__csimDragOnto = function (sourceHandle, targetHandle) {
    const source = __handles.get(sourceHandle);
    const target = __handles.get(targetHandle);
    if (!source || !target) return false;
    const dt = new globalThis.DataTransfer();
    const init = { bubbles: true, cancelable: true, button: 0 };
    dispatchEvent(source, new MouseEvent('mousedown', init));
    const fireDrag = (el, type) => {
      const ev = new DragEvent(type, init);
      ev.dataTransfer = dt;
      dispatchEvent(el, ev);
    };
    fireDrag(source, 'dragstart');
    fireDrag(target, 'dragenter');
    fireDrag(target, 'dragover');
    fireDrag(target, 'drop');
    fireDrag(source, 'dragend');
    dispatchEvent(source, new MouseEvent('mouseup', init));
    return true;
  };


  // Tab-key focus traversal lives in dom-nodes.js as the shadow/slot-aware
  // sequential-focus-navigation engine (`globalThis.__csimAdvanceFocus` /
  // `__csimSequentialFocusOrder`), built where the slot/flat-tree helpers live.

  // Click resolver: maps an element click to one of three outcomes
  // the Ruby side knows how to drive:
  //   - {kind:'navigate', url}  — <a href>
  //   - {kind:'submit',   formHandle}  — submit-button inside <form>
  //   - null                    — everything else; checkbox/radio
  //     toggling happens inline so Ruby sees the new state on the
  //     follow-up read.
  // Tags PM (and most contenteditable hosts) treat as atomic / void
  // leaves — caret movement inside them is undefined, and the library
  // sets its own NodeSelection on click.
  const __csimCEAtomicTags = new Set(['img', 'video', 'audio', 'iframe', 'object', 'embed', 'br', 'hr', 'input', 'wbr', 'svg', 'math']);

  // Click hit-test approximation. Selenium's "element click" sends a
  // pointer event to the centre of the target's bounding box; the
  // browser then hit-tests through layout to find the topmost element
  // under that coordinate, which is what fires the click. Wrappers that
  // exist only to group an interactive descendant therefore behave as
  // if the descendant was clicked directly (target = descendant, then
  // bubble). Discourse FloatKit's `<div class="…-dropdown"><button
  // class="…-dropdown-trigger"></button>…</div>` shape is a typical
  // case — system specs do `find('.…-dropdown').click` and rely on the
  // hit-test reaching the inner trigger button. Without layout we
  // approximate by retargeting to the first descendant that is either
  // focusable or has a click/mousedown/pointerdown listener registered.
  // Natively interactive tags: a real click coord always lands on
  // these when present, regardless of wrapper layout. tabindex-only
  // focusable elements (e.g. an `<li role="button" tabindex="0">`
  // wrapping a real `<button>`) don't count — the keyboard hint is
  // for accessibility; real browsers still hit-test the inner button.
  const __csimInteractiveTags = new Set(['a', 'button', 'input', 'select', 'textarea']);
  function __csimIsHitTarget(n) {
    if (__csimInteractiveTags.has(n._tag)) return true;
    // `<label>` has its own HTML default-action (activate the labeled
    // control), handled post-dispatch in `__csimClickResolve`. Retargeting
    // away from the label would skip that hop and break capybara's
    // `check 'foo', allow_label_click: true` flow against hidden inputs.
    if (n._tag === 'label') return true;
    const ll = n._listeners;
    if (ll && (ll.click || ll.mousedown || ll.pointerdown)) return true;
    const a = n._attrs;
    if (a && (a.onclick != null || a.onmousedown != null)) return true;
    return false;
  }
  function __csimHitTestRetarget(n) {
    if (!n || n.nodeType !== NODE_ELEMENT) return n;
    if (__csimIsHitTarget(n)) return n;
    // Inside a contenteditable, retargeting to inner listenered nodes
    // is wrong: real browsers hit-test the click coordinate, and a
    // click on a paragraph block lands on the paragraph (or its text
    // node) regardless of which inline child happens to carry a
    // ProseMirror/Tiptap NodeView listener. Retargeting here turned a
    // "click outside the image" gesture into another click on the
    // image-wrapper SPAN — the existing NodeSelection was never
    // cleared and the image toolbar stayed open.
    if (contenteditableHost(n)) return n;
    function dfs(node) {
      const kids = node._children;
      if (!kids) return null;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.nodeType !== NODE_ELEMENT) continue;
        // `<a href>` triggers navigation as click default action. A
        // user click on a content container with an embedded link
        // (Redmine gantt row: `<div id="issue-1"><span class="icon"/>
        // <a class="issue">subject</a></div>`) lands on either the
        // icon or the link depending on hit-test layout, but the
        // test intent for `find('#issue-1').click` is "click the
        // row", not "navigate to the issue". Skip anchors in the
        // wrapper-retarget DFS so they only fire when explicitly
        // selected. Buttons / inputs / focusable controls are still
        // valid retargets (matches the Discourse FloatKit
        // `<div class="dropdown"><button class="trigger"/></div>`
        // pattern that motivated this heuristic in the first place).
        if (k._tag === 'a') continue;
        if (__csimIsHitTarget(k)) return k;
        const found = dfs(k);
        if (found) return found;
      }
      return null;
    }
    const hit = dfs(n);
    if (hit) return hit;
    // Anchor-fronted wrapper. Three real-browser shapes that all land
    // on the wrapper element here because the DFS skips anchors:
    //
    //  (a) Single-href subtree (Discourse nav-pill `<li><a href>…</a></li>`,
    //      subcategory category-box with just `.parent-box-link` inside):
    //      the lone anchor visually fills the wrapper.
    //
    //  (b) "Stretched link" wrapper: the wrapper has `data-url` pointing
    //      at a primary anchor (often styled with `position:absolute;
    //      inset:0` on a `::before`), with secondary anchor chips
    //      overlaid (Discourse's parent category-box on `/categories`).
    //      Match the wrapper's data-url against an inner anchor's href.
    //
    //  (c) Wrapping anchor: a single outer `<a href>` envelopes the
    //      whole result, with description-embedded anchors nested
    //      inside (Discourse admin-search result, render-decorated
    //      excerpts that include "Configuring …" links). Pick the
    //      ancestor anchor since it spans the whole click region.
    //
    // Multi-anchor wrappers that don't fit any of these (e.g. a
    // disambiguated card with sibling author + tag links) stay on the
    // wrapper. The Redmine gantt row carries a hidden `<input>`
    // checkbox inside the subject span, so DFS short-circuits on the
    // input before this fallback runs.
    const dataUrl = n._attrs && n._attrs['data-url'];
    const anchors = [];
    function collectAnchors(node) {
      const kids = node._children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.nodeType !== NODE_ELEMENT) continue;
        if (k._tag === 'a' && k._attrs.href != null) anchors.push(k);
        collectAnchors(k);
      }
    }
    collectAnchors(n);
    if (anchors.length === 0) return n;
    if (anchors.length === 1) return anchors[0];
    if (dataUrl) {
      const match = anchors.find(a => a._attrs.href === dataUrl);
      if (match) return match;
    }
    // Wrapping anchor: an anchor that is the ancestor of every other
    // anchor in the set. Walk each other anchor's parent chain looking
    // for this candidate.
    const cand = anchors[0];
    const wraps = anchors.every(a => {
      if (a === cand) return true;
      for (let p = a._parent; p; p = p._parent) if (p === cand) return true;
      return false;
    });
    if (wraps) return cand;
    // Homogeneous list-of-items wrapper. When every anchor sits
    // under the same `<ul>` / `<ol>` (typically as `<li><a>` rows),
    // a real-browser click at the wrapper's centre coordinate
    // hit-tests to whichever inner item lies at that y. We have no
    // layout, so approximate that with the middle list item: for
    // N stacked equal-height items the centre y lands in
    // `items[floor(N/2)]` (boundary between halves resolves to the
    // lower box per CSS box-model). Discourse's search-menu
    // `.search-result-topic` wraps `<ul><li><a class="search-link">`
    // ×N — `find('.search-result-topic', text: title)` returns the
    // wrapper (the selector only matches it), and tests rely on the
    // hit-test reaching the result row whose title was filtered.
    // Card-shaped wrappers with author/tag chips in disparate
    // containers don't share a list ancestor and stay on the
    // wrapper as before.
    let listAncestor = null;
    let allInSameList = true;
    for (const a of anchors) {
      let p = a._parent;
      while (p && p !== n && p._tag !== 'ul' && p._tag !== 'ol') {
        p = p._parent;
      }
      if (!p || p === n || (p._tag !== 'ul' && p._tag !== 'ol')) {
        allInSameList = false;
        break;
      }
      if (listAncestor === null) listAncestor = p;
      else if (listAncestor !== p) { allInSameList = false; break; }
    }
    if (allInSameList) return anchors[Math.floor(anchors.length / 2)];
    return n;
  }

  globalThis.__csimClickResolve = function (h, modifiers) {
    const n = __csimHitTestRetarget(lookup(h));
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const mods = modifiers || {};

    // checkbox / radio: toggle *before* the click dispatch so listeners
    // observe the new state. Mirrors what real browsers do (the IDL
    // mutation precedes the click event chain when the user clicks
    // a form control). `wasChecked` is captured so we can roll back the
    // toggle if the click is cancelled, and fire `input` / `change` if
    // it isn't — matching HTML spec activation behavior for checkboxes.
    let preToggled = null;
    let wasChecked = null;
    let prevCheckedRadio = null;
    if (n._tag === 'input') {
      const type = (n._attrs.type || '').toLowerCase();
      if (type === 'checkbox') {
        wasChecked = n._attrs.checked != null;
        toggleChecked(n); preToggled = 'checkbox';
      } else if (type === 'radio') {
        wasChecked = n._attrs.checked != null;
        prevCheckedRadio = checkedRadioInGroup(n);   // restore group on cancel
        setRadio(n); preToggled = 'radio';
      }
    }

    // Real clicks fire `mousedown` → `mouseup` → `click` (with
    // `pointerdown` / `pointerup` for Pointer-Event-aware listeners).
    // Libraries listen on the down-half of the pair: Tribute attaches
    // its menu-click handler to `mousedown` (so the menu select fires
    // before the textarea's `blur` chain commits), and jQuery's
    // `:active` selector + sortable plugins drag-detect off mousedown.
    // Without these dispatches, clicking a Tribute `<li>` does not
    // call `selectItemAtIndex` and the autocomplete never inserts.
    // Synthetic clients we dispatch always reported `clientX/Y = 0`,
    // which made ProseMirror's `isNear(event, lastClick)` (`(dx² +
    // dy²) < 100`) classify every consecutive click within 500 ms as
    // a `doubleClick` / `tripleClick`. PM then took the dblclick
    // path and never constructed `MouseDown` (the only path that
    // calls `selectClickedLeaf` → `NodeSelection`). Give each click
    // a unique tens-of-pixels offset based on the target's handle
    // so successive clicks on *different* elements look "far"
    // (singleClick path), while two clicks on the *same* element
    // stay near (double-click path — matches real keyboard cadence
    // for `Element#double_click`).
    const clickX = +mods.clientX || ((n._id * 31) % 1000) + 1;
    const clickY = +mods.clientY || ((n._id * 71) % 1000) + 1;
    const base = { bubbles: true, cancelable: true, button: 0, which: 1,
                   shiftKey: !!mods.shiftKey, ctrlKey: !!mods.ctrlKey,
                   altKey: !!mods.altKey, metaKey: !!mods.metaKey,
                   clientX: clickX, clientY: clickY };
    // Record the click target so a follow-on `document.elementFromPoint(x, y)`
    // can return it. ProseMirror's `mousedown` handler calls
    // `posAtCoords({left: event.clientX, top: event.clientY})`, which in
    // turn calls `caretFromPoint` + `elementFromPoint`; without a layout
    // engine our `caretFromPoint` returns null and `elementFromPoint(0, 0)`
    // would otherwise pick an arbitrary "deepest laid-out" node. Pinning
    // the most recent click target lets PM resolve the click to the
    // correct node (image / link / etc.) and fire NodeSelection.
    globalThis.__csimLastClickTarget = n;
    // A real user click first moves the pointer over the target. Apps
    // such as InstantClick use mouseover capture to start link preload
    // before the subsequent click handler prevents the native
    // navigation. `dedupe: true` skips the dispatch when the node was
    // already hovered — hover-driven widgets recurse on duplicate
    // mouseover events.
    dispatchHover(n, { dedupe: true, init: base });
    // Reset the form-submit / navigation intent slots before dispatch
    // so the click handler can populate either if it ends in
    // `form.submit()` (Rails-UJS data-method / data-confirm chain) or
    // a programmatic `link.click()` (Avo's filter controller).
    globalThis.__csimPendingFormSubmit = null;
    globalThis.__csimPendingNavigation = null;
    // Pointer Events level 3: `pointerdown` fires before its `mousedown`
    // compat counterpart. FloatKit's `d-close-on-click-outside` modifier
    // registers a `document.addEventListener('pointerdown', …)` listener
    // to dismiss menus, and Discourse's revamped header menu / many
    // FloatKit popovers depend on that path firing. No PointerEvent
    // ctor today — most listeners just read `event.target` / `.type`,
    // so a `MouseEvent`-shaped object with `type='pointerdown'` reaches
    // them; libraries that need true `PointerEvent` instanceof checks
    // would need a real constructor.
    try { dispatchEvent(n, new MouseEvent('pointerdown', base)); } catch (_) {}
    const mousedownEv = new MouseEvent('mousedown', base);
    dispatchEvent(n, mousedownEv);
    // HTML/UIEvents spec: if mousedown wasn't cancelled, the default
    // action moves focus to the clicked element when it's focusable.
    // flatpickr opens its calendar on the input's `focus` event, so
    // without this transfer a `click` on a `<input data-controller=
    // "date-field">` leaves the picker closed and the `set_picker_day`
    // helper can't find the (display:none-hidden) day buttons.
    // n.focus() is self-gating: it focuses a focusable target, delegates into a
    // delegatesFocus shadow host (which isn't `isFocusable` itself — clicking it
    // moves focus into its shadow tree), and no-ops otherwise — so call it
    // unconditionally rather than re-deriving its gating here.
    // (shadow-dom/focus/click-focus-delegatesFocus-click.html)
    if (!mousedownEv.defaultPrevented) {
      globalThis.__csimFocusModality = 'pointer';   // click-driven focus → not :focus-visible
      try { n.focus(); } catch (_) {}
    }
    // Real browsers move the caret to the click position as part of
    // mousedown's default action, firing `selectionchange`. Without
    // layout, that default action never runs — so libraries that
    // listen on `selectionchange` (ProseMirror, Tiptap, …) never see
    // the click and stale NodeSelections (e.g. an image selected by
    // a previous click) persist when the user clicks back into a
    // paragraph. Skip atom-shaped targets: PM's own mouseup-time
    // `selectClickedLeaf` sets the NodeSelection for `<img>` etc.
    // and calls `selectionToDOM`, which would conflict with our
    // pre-emptive collapse.
    if (!mousedownEv.defaultPrevented && !__csimCEAtomicTags.has(n._tag)) {
      const ceHost = contenteditableHost(n);
      if (ceHost && ceHost !== n) {
        try {
          if (globalThis.document._activeElement !== ceHost) ceHost.focus();
          const sel = globalThis.getSelection();
          if (sel) sel.collapse(n, 0);
        } catch (_) {}
      }
    }
    if (mods.mouseDownOnly) {
      // Caller (Ruby) handles the wall-clock delay between mousedown
      // and mouseup; return the partial event init so the follow-up
      // call can finish the chain with the same modifier state.
      return { kind: 'partial', base };
    }
    try { dispatchEvent(n, new MouseEvent('pointerup', base)); } catch (_) {}
    dispatchEvent(n, new MouseEvent('mouseup',   base));
    const click = new MouseEvent('click', base);
    click._csimActivationHandled = true;   // checkbox/radio toggle handled above (line ~1513)
    dispatchEventForUserAction(n, click);
    // HTML spec activation for `<input type=checkbox|radio>`: if the
    // click was cancelled, roll back the IDL-mutated state; otherwise
    // fire `input` then `change` (both bubble). Avo's row-select
    // checkbox (`data-action="input->item-selector#toggle"`) and a
    // dozen other Stimulus controllers listen for `input` to react to
    // toggle state; without this dispatch, clicking the checkbox flips
    // the IDL state silently and the dependent UI never updates.
    if (preToggled) {
      if (click.defaultPrevented) {
        if (preToggled === 'radio') {
          delete n._attrs.checked;
          if (prevCheckedRadio) prevCheckedRadio._attrs.checked = '';
        } else if (wasChecked) n._attrs.checked = '';
        else                   delete n._attrs.checked;
      } else if (isConnected(n) && (n._attrs.checked != null) !== wasChecked) {
        try { dispatchEvent(n, new InputEvent('input', { bubbles: true, cancelable: true })); } catch (_) {}
        try { dispatchEvent(n, new Event('change',     { bubbles: true, cancelable: false })); } catch (_) {}
      }
    }
    // A click handler that ended in `form.submit()` (Rails-UJS
    // data-method link → builds synthetic form → submit) takes
    // precedence: the page intent is to submit, not navigate.
    const pendingSubmit = __takePendingFormSubmit();
    if (pendingSubmit) return { kind: 'submit', formHandle: pendingSubmit.formHandle, submitter: pendingSubmit.submitterHandle || 0 };
    // A click handler that ended in `link.click()` on an `<a href>`
    // (Avo's filter-controller: builds the filtered URL on a hidden
    // anchor, then `.click()`s it) wants a navigation.
    const pendingNav = globalThis.__csimPendingNavigation;
    if (pendingNav && pendingNav.url) {
      globalThis.__csimPendingNavigation = null;
      return { kind: 'navigate', url: String(pendingNav.url), target: String(pendingNav.target || '') };
    }
    // `<summary>` / `<details>` click toggles the `<details>`'s `open`
    // attribute as the HTML default action. Two click targets, two
    // rules:
    //
    // - target=summary: real browsers fire the default toggle unless a
    //   listener preventDefaulted. Discourse's select-kit-header
    //   preventDefaults AND toggles itself, so skip when defaultPrevented
    //   to avoid double-toggling.
    // - target=details (has summary child): events don't propagate
    //   down, so any summary-level toggle listener (select-kit-header)
    //   never fired. Run the fallback regardless of defaultPrevented —
    //   the listener at the details level may have preventDefaulted
    //   without itself driving the toggle.
    {
      let details = null;
      if (n._tag === 'summary' && !click.defaultPrevented) {
        let p = n._parent;
        while (p && p._tag !== 'details') p = p._parent;
        details = p && p._tag === 'details' ? p : null;
      } else if (n._tag === 'details' && (n._children || []).some(c => c && c._tag === 'summary')) {
        details = n;
      }
      if (details) {
        const oldOpen = details._attrs.open;
        if (oldOpen != null) delete details._attrs.open;
        else                 details._attrs.open = '';
        // Record the `open` flip: it changes what's visible (closed <details> hides
        // its non-summary content), so it must bump settleGen (invalidates the
        // visible_text memo) + the attr-version, like any attribute mutation.
        recordAttrMutation(details, 'open', oldOpen == null ? null : oldOpen);
        try { dispatchEvent(details, new Event('toggle', { bubbles: false })); } catch (_) {}
      }
    }

    if (click.defaultPrevented) return null;

    // Click default action follows the nearest ancestor `<a>` per spec
    // ("activation behaviour of A is to follow the hyperlink"). Avo's
    // sort buttons render `<a href><svg data-tippy-content=...></svg></a>`,
    // and the test clicks on the inner `<svg>`; without the walk we
    // missed the link entirely.
    // The activating hyperlink: `<area>` activates itself; otherwise walk
    // to the nearest `<a>` ancestor.
    let __anchor = n;
    if (n._tag !== 'area') {
      while (__anchor && __anchor.nodeType === NODE_ELEMENT && __anchor._tag !== 'a') {
        __anchor = __anchor._parent;
      }
    }
    if (__anchor && __anchor.nodeType === NODE_ELEMENT &&
        (__anchor._tag === 'a' || __anchor._tag === 'area') && __anchor._attrs.href != null) {
      const href = String(__anchor._attrs.href);
      // `javascript:` URLs only ever ran the embedded script (already
      // handled by the click dispatch above, which fires the JS).
      // The default action is a no-op.
      if (/^\s*javascript:/i.test(href)) return null;
      // `<a download>` (any value) signals that the linked resource
      // should be saved rather than rendered. Real browsers honour
      // this regardless of the response's Content-Disposition, so we
      // tell Ruby to take the download path even if the server only
      // sets a Content-Type.
      if (__anchor._attrs.download != null) {
        return { kind: 'download', url: href, filename: String(__anchor._attrs.download || '') };
      }
      // Cmd/Ctrl+click (or cmd+Enter on a focused link) opens in a
      // new window in every desktop browser — override the anchor's
      // own `target` so the Ruby side routes through
      // `open_aux_window`.
      let target = String(__anchor._attrs.target || '');
      if (click && (click.metaKey || click.ctrlKey)) target = '_blank';
      // Same-document fragment links navigate in JS (URL update +
      // `hashchange`) with no document fetch — but only a plain
      // activation; a forced new-window open (cmd/ctrl) still routes
      // through Ruby. `fragmentNavigate` itself bails on non-`_self`
      // targets.
      if (!(click && (click.metaKey || click.ctrlKey)) && fragmentNavigate(__anchor)) return null;
      return { kind: 'navigate', url: href, target };
    }
    // `<label>` activation: clicking a label (or any non-control
    // descendant inside it) activates the labeled form control.
    // Redmine's "New member" modal renders user checkboxes as
    // `<label><input type=checkbox ...>Name</label>`; Discourse's
    // FormKit checkbox wraps `<input type=checkbox>` plus a
    // `.form-kit__control-checkbox-checkmark` span inside an outer
    // `<label>`, and the FormKit page object's `.toggle` clicks the
    // checkmark span. Without this hop, `find('label', ...).click`
    // or the checkmark click runs the click chain on the inner
    // element but the checkbox stays unchecked. Per HTML spec the
    // labeled control is the `for` target, or — if no `for` attr —
    // the first labelable descendant; clicking anywhere inside the
    // label that isn't itself a labelable control fires the same
    // activation behaviour.
    const label = (n._tag === 'label') ? n
                : LABELABLE.has(n._tag) ? null
                : enclosingLabelFor(n);
    if (label) {
      const labeled = labeledControlFor(label);
      if (labeled && labeled !== n && labeled !== label) {
        return __csimClickResolve(labeled._id);
      }
    }
    if (isSubmitButton(n)) {
      const form = formForControl(n);
      if (!form) return null;
      const submit = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: n });
      dispatchEvent(form, submit);
      // The submit listener may have called `form.submit()` (Avo's
      // sign-out controller: `e.preventDefault(); confirm(); this.
      // element.submit()` — `form.submit()` per spec doesn't re-fire
      // the submit event, so the queued intent has to be honoured
      // even though the original submit was preventDefault'd). Take
      // the pending intent first; otherwise the queued submit sits
      // forever and the page never navigates.
      const pendingFromHandler = __takePendingFormSubmit();
      if (pendingFromHandler) return { kind: 'submit', formHandle: pendingFromHandler.formHandle, submitter: pendingFromHandler.submitterHandle || 0 };
      if (submit.defaultPrevented) return null;
      // `<form method="dialog">` per HTML spec: submitting the form
      // closes the form's nearest ancestor `<dialog>` rather than
      // issuing a request. `dialog.returnValue` becomes the
      // submitter's `value`. Turbo's `confirm` flow uses this:
      // `data-turbo-confirm` opens a `<dialog id="turbo-confirm">`
      // with `<form method=dialog>`, and resolves its `Promise` on
      // the dialog's `close` event by reading `returnValue`.
      const methodAttr = ((n._attrs.formmethod || form._attrs.method) || '').toLowerCase();
      if (methodAttr === 'dialog') {
        let dlg = form._parent;
        while (dlg && dlg._tag !== 'dialog') dlg = dlg._parent;
        if (dlg) closeDialog(dlg, String(n._attrs.value == null ? '' : n._attrs.value));
        return null;
      }
      return { kind: 'submit', formHandle: form._id, submitter: n._id };
    }
    return null;
  };


  globalThis.MessageEvent = MessageEvent;

  installIntlCollator();

  // Fire the window `load` event using the module-captured `Event` constructor
  // rather than the `window.Event` global. A test may legitimately `delete
  // window.Event` (dom/interface-objects.html does, for every DOM interface) —
  // a real browser still fires `load` because the UA's internal event machinery
  // doesn't depend on the page's mutable global. The WPT runner prefers this
  // helper over `new (window.Event)('load')` so a deleted global can't turn a
  // genuine result into a harness error.
  globalThis.__csimFireWindowLoad = function () {
    globalThis.dispatchEvent(new Event('load'));
  };

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
