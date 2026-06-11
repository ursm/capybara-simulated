// The DOM lives entirely in V8. No __dom callbacks. Capybara's Ruby
// side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.

import './url-parse.js';   // defines globalThis.__csim_parseUrl before location.js's load-time use
import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, installNodeConstants } from './constants.js';
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
import { ceTryConnect } from './custom-elements.js';
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
  EventTarget,
  installOnHandlerSlots,
  installWindowForwardedHandlers
} from './events.js';
import { deliverMutations, hasQueuedRecords, hasObservers, recordAttrMutation } from './mutation-observer.js';
import { timerStats }                  from './timers.js';
import { Blob, File, installBlobURL }  from './blob.js';
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
  parseDocument,
  parseFragment,
  parseXml,
  newChildList,
  deleteRangeContents,
  isFocusable,
  resetLayoutY,
  fragmentNavigate
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

  // Mouse-event types need MouseEvent so click-handler readers see
  // `.button` / `.shiftKey` / `.ctrlKey` / `.altKey` / `.metaKey`
  // alongside the bubbling flags. Falls back to Event for keyboard /
  // generic events.
  const MOUSE_EVENT_TYPES = new Set([
    'click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout',
    'mouseenter', 'mouseleave', 'mousemove', 'contextmenu'
  ]);
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
  function fireCEConnect(subtree) {
    walkSubtree(subtree, el => {
      if (el.nodeType !== NODE_ELEMENT) return;
      // Dynamically-inserted <script> elements should evaluate when
      // they become part of the document. Rails-UJS's `dataType:
      // 'script'` AJAX path creates a `<script>` with `.text = response`
      // and appends to head; without this hook the response never runs
      // and AJAX flows that depend on it (Redmine's show_api_key.js.erb
      // toggling visibility) silently no-op. Only do this *after* the
      // initial page-load script pass completes — otherwise the
      // initial pass would double-eval scripts that appendChild
      // surfaced via fireCEConnect during the page-build phase.
      if (!__inHTMLGrafting && el._tag === 'script' && !el._csimRan) maybeRunScript(el);
      // Vite's preload-helper appends `<link rel="stylesheet">` for
      // CSS deps in a chunk's dependency list and awaits the link's
      // `load` event before resolving the chunk's dynamic-import
      // chain. Real browsers fire `load` once the stylesheet is
      // fetched and parsed; without this hook the lazy MediaContainer
      // / public.tsx `[data-component]` portal mount stalls forever.
      // `rel="modulepreload"` / `rel="preload"` get the same treatment
      // — the helper waits on them with the same pattern.
      if (el._tag === 'link') maybeFireLinkLoad(el);
      if (el._tag === 'iframe' || el._tag === 'frame') maybeFireFrameLoad(el);
      ceTryConnect(el);
    });
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

  // A connected `<iframe>` / `<frame>` fires `load` once its nested document is
  // ready. Our content loads lazily on `contentDocument` access, so we just
  // defer a `load` event to a microtask (after the handler that an appender set
  // — `iframe.onload = …; body.appendChild(iframe)` — is in place). Tests like
  // Document-createElement-namespace.html await this to read `contentDocument`.
  function maybeFireFrameLoad(el) {
    // Fire `load` once per navigation, not on every connect — a move / re-attach
    // (src unchanged) must NOT re-fire, else a `t.step_func_done` handler calls
    // done() twice. The guard is cleared when src/srcdoc is reassigned
    // (dom-nodes.js), so a real re-navigation does re-fire.
    if (el._frameLoadFired) return;
    el._frameLoadFired = true;
    Promise.resolve().then(() => {
      if (!isConnected(el)) return;
      try { el.dispatchEvent(new Event('load')); } catch (_) {}
    });
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
    el._csimRan = true;
    let body;
    if (el._attrs.src) {
      try {
        const resp = __rackFetch('GET', el._attrs.src, '', null, 'follow');
        if (!resp || resp.status >= 400) { dispatchScriptLoad(el, false); return; }
        body = resp.body || '';
      } catch (_) { dispatchScriptLoad(el, false); return; }
    } else {
      body = scriptText(el);
    }
    if (!body) { dispatchScriptLoad(el, true); return; }
    const label = el._attrs.src || ('inline://' + hashStr(body));
    let _ok = true;
    try { __csim_runScript(label, body); }
    catch (e) {
      _ok = false;
      logThrew('dynamic script', e);
    }
    dispatchScriptLoad(el, _ok);
  }

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

  globalThis.document = new Document();
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
  globalThis.DOMParser = class DOMParser {
    constructor() { this._ownerDoc = globalThis.document; }
    parseFromString(input, mimeType) {
      const src = String(input == null ? '' : input);
      const t = String(mimeType || 'text/html').toLowerCase();
      // XML-family types parse as XML (no implicit html/head/body skeleton) and
      // carry their content-type, so the result reports `isHtmlDocument` false
      // — which gates case-sensitivity, `createCDATASection`, etc. text/html
      // stays on the HTML parser.
      let doc;
      if (isXmlMimeType(t)) {
        doc = parseXMLDocument(src);
        doc._contentType = t;
      } else {
        doc = parseDocument(src);
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
    doc.documentElement = null;
    for (const node of parseXml(String(xml == null ? '' : xml))) {
      node._parent = doc;
      doc._children.push(node);
      if (node.nodeType === NODE_ELEMENT && !doc.documentElement) doc.documentElement = node;
    }
    return doc;
  }

  function makeFrameWindow(doc, frameEl) {
    let win;
    win = new Proxy(globalThis, {
      get(target, prop) {
        switch (prop) {
          case 'document':     return doc;
          case 'frameElement': return frameEl;
          case 'self':
          case 'window':       return win;
          case 'parent':
          case 'top':          return globalThis;
          default:             return Reflect.get(target, prop, globalThis);
        }
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
          const resp = globalThis.__rackFetch('GET', frameUrl, null, {}, 'follow');
          if (resp) {
            body = (resp.body || '');
            const ct = resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type']);
            if (ct) contentType = ct;
          }
        } catch (e) { /* unreachable src → empty about:blank-ish document */ }
      }
    }

    // Real nested browsing context: a separate realm (own global + intrinsics)
    // built by the host, running the frame's own scripts. The frame window is
    // that realm's global; cross-realm refs (`frames[i].DOMParser` / `.Function`
    // / `.onerror`) resolve per spec because each realm is distinct.
    if (typeof globalThis.__csim_createFrameRealm === 'function' && globalThis.RustyRacer && typeof globalThis.RustyRacer.contextGlobal === 'function') {
      const id = globalThis.__csim_createFrameRealm(frameUrl, body, contentType);
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
    const doc = isXmlMimeType(ct) ? parseXMLDocument(body) : parseDocument(String(body));
    doc._contentType = ct || 'text/html';
    if (frameUrl) doc._url = frameUrl;
    const win = makeFrameWindow(doc, frameEl);
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
      dx.documentElement = null;
      dx._contentType = __ct;
      for (const c of xmlDoc._children) {
        c._parent = dx;
        walkSubtree(c, (n) => { n._ownerDoc = dx; });
        dx._children.push(c);
        if (c.nodeType === NODE_ELEMENT && !dx.documentElement) dx.documentElement = c;
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
    const freshDoc = parseDocument(String(html == null ? '' : html));
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
    // Preserve document / documentElement / head / body identity across
    // per-visit content swaps. Library IIFEs (jQuery 3.x in particular)
    // capture `document.documentElement` at evaluation time and reuse
    // it for `createElement` / `appendChild` probes; replacing the
    // documentElement strands those references on a detached node.
    // So instead: walk the parsed tree's <head> and <body> children
    // and graft them onto the live skeleton.
    // Graft the parsed `<!DOCTYPE …>` onto the live document (the
    // skeleton built at boot has no doctype). Drop any prior doctype
    // first, then insert before the live <html> so `document.doctype`
    // and doctype-node namespace lookups reflect the new page.
    const freshDoctype = freshDoc._children.find(c => c.nodeType === NODE_DOCTYPE);
    for (const c of d._children.slice()) if (c.nodeType === NODE_DOCTYPE) { c._parent = null; d._children.splice(d._children.indexOf(c), 1); }
    if (freshDoctype) { freshDoctype._parent = d; freshDoctype._ownerDoc = d; d._children.unshift(freshDoctype); }
    const freshHtml = freshDoc.documentElement;
    const liveHtml  = d.documentElement;
    if (freshHtml && liveHtml) {
      const freshHead = freshHtml._children.find(c => c._tag === 'head');
      const freshBody = freshHtml._children.find(c => c._tag === 'body');
      const liveHead  = liveHtml._children.find(c => c._tag === 'head');
      const liveBody  = liveHtml._children.find(c => c._tag === 'body');
      if (liveHead) for (const c of liveHead._children.slice()) liveHead.removeChild(c);
      if (liveBody) for (const c of liveBody._children.slice()) liveBody.removeChild(c);
      if (liveHead && freshHead) for (const c of freshHead._children.slice()) {
        c._parent = null;
        liveHead.appendChild(c);
      }
      if (liveBody && freshBody) for (const c of freshBody._children.slice()) {
        c._parent = null;
        liveBody.appendChild(c);
      }
      // Copy attributes from the parsed body / head / html onto the
      // live skeleton elements. Redmine scopes its
      // `display: none` rule for unused fieldsets on
      // `body.controller-X.action-Y`; without the body class copy the
      // cascade selector misses and the fieldset stays visible.
      // Wholesale `_attrs` swap bypasses the Attr setters, so drop each
      // element's cached Attr nodes (`_attrNodes`) too — a held Attr would
      // otherwise read a removed key's stale snapshot.
      if (liveHtml && freshHtml) {
        for (const k of Object.keys(liveHtml._attrs)) delete liveHtml._attrs[k];
        Object.assign(liveHtml._attrs, freshHtml._attrs);
        liveHtml._attrNodes = null;
      }
      if (liveHead && freshHead) {
        for (const k of Object.keys(liveHead._attrs)) delete liveHead._attrs[k];
        Object.assign(liveHead._attrs, freshHead._attrs);
        liveHead._attrNodes = null;
      }
      if (liveBody && freshBody) {
        for (const k of Object.keys(liveBody._attrs)) delete liveBody._attrs[k];
        Object.assign(liveBody._attrs, freshBody._attrs);
        liveBody._attrNodes = null;
      }
    }
    // Stay on 'loading' through inline-script evaluation to match real
    // browsers, where parser-blocking scripts see readyState='loading'
    // and register `DOMContentLoaded` listeners instead of running
    // their ready callbacks inline. Forem's `base.js` bundle is the
    // canonical case: it pulls in ahoy.js via `//= require`, then
    // later in the same bundle calls `ahoy.configure({cookies: false,
    // trackVisits: false})`. ahoy.js's IIFE schedules `ahoy.start()`
    // via `documentReady` — if readyState is already 'complete', that
    // callback fires synchronously and the visit POST goes out before
    // `ahoy.configure` runs, undoing the test-environment opt-out.
    d.readyState = 'loading';
    // Cascade-derived hide rules need to land *before* scripts run —
    // a script that tests visibility (`offsetWidth`-style probes) or
    // queries Capybara-visible elements would otherwise see the
    // pre-cascade state.
    rebuildCascade(globalThis.document);
    __inHTMLGrafting = false;
    runInlineScripts(globalThis.document);
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
    const scripts = doc.documentElement.querySelectorAll('script');
    for (const s of scripts) {
      const type = (s._attrs.type || '').toLowerCase();
      if (type === 'importmap') continue;  // already consumed
      if (type === 'module') {
        runModuleScript(s);
        continue;
      }
      if (type && !SCRIPT_TYPES_CLASSIC.has(type)) continue;
      let body;
      if (s._attrs.src) {
        // De-dupe across page loads: each app-wide bundle runs once
        // per Context. See `__externalScriptsRun` comment above.
        if (__externalScriptsRun.has(s._attrs.src)) continue;
        // Synchronous fetch via Ruby Rack callback (the engine's attach is
        // blocking, preserving classic-script "block the parser until loaded"
        // without an event loop). `__csimExternalAsset` serves fingerprinted app
        // bundles from a cross-visit cache so a fresh VM per visit doesn't re-fetch
        // them — a real browser HTTP-caches; returns null on 4xx / failure.
        body = globalThis.__csimExternalAsset(s._attrs.src);
        if (!body) continue;
        __externalScriptsRun.set(s._attrs.src, body);
      } else {
        body = scriptText(s);
      }
      if (!body) continue;
      // Route through Ruby so the runtime can cache compiled bytecode
      // across per-visit context rebuilds (QuickJS today; V8 once the
      // upstream cache PR lands). Indirect-eval semantics are
      // preserved: both runtimes evaluate at globalThis.
      //
      // `document.currentScript` must point at the executing `<script>`
      // during eval so webpack/embroider bundles can read
      // `currentScript.src` to derive the public-path origin. Restore
      // afterwards so unrelated callers see the spec-default `null`.
      const label = s._attrs.src || ('inline://' + hashStr(body));
      const prevCurrent = globalThis.document && globalThis.document._currentScript;
      if (globalThis.document) globalThis.document._currentScript = s;
      s._csimRan = true;
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
      try { dispatchEvent(doc, new Event('DOMContentLoaded', { bubbles: true, cancelable: false })); } catch (_) {}
    }
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
  // Inverse: when a script returns an Element / NodeList, marshal so
  // the Ruby side can wrap the handles back into Node instances.
  function marshalReturn(value) {
    if (value && typeof value === 'object' && value.nodeType !== undefined && typeof value._id === 'number') {
      return { __elementHandle: value._id };
    }
    if (Array.isArray(value)) return value.map(marshalReturn);
    // HTMLCollection is no longer an Array (it's a legacy platform object), but a
    // script returning one still marshals to an array of element handles — like a
    // real browser serialises a collection. It's iterable, so Array.from walks it.
    if (value && typeof value === 'object' && globalThis.HTMLCollection &&
        value instanceof globalThis.HTMLCollection) {
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
        dt.files.push(file);
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


  // Tab-key focus traversal. Walk the document in tree order, pull
  // out tabbable elements (tabindex >= 0 or default-tabbable form
  // controls / anchors), then move focus to the next (or previous,
  // for shift-tab) entry relative to the current `_activeElement`.
  const __TABBABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
  function __isTabbable (el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return false;
    if (el._attrs.disabled != null) return false;
    if (el._attrs.hidden != null) return false;
    if (selfHidden(el)) return false;
    const ti = el._attrs.tabindex;
    if (ti != null) {
      const n = parseInt(ti, 10);
      return !isNaN(n) && n >= 0;
    }
    // contenteditable hosts (PM / Tiptap / Trix editor div) ARE
    // tabbable per spec — without this, Tab from inside the editor
    // can't find the editor in the tabbable list and jumps to the
    // first tabbable on the page (typically the skip-link) instead
    // of the next tabbable after the editor (e.g. the PM link
    // toolbar's edit button).
    if (el._attrs.contenteditable != null &&
        (el._attrs.contenteditable || '').toLowerCase() !== 'false') {
      return true;
    }
    // Elements (anchors, etc.) inside a contenteditable host are not
    // independently tabbable — Tab navigation treats the contenteditable
    // as one focus stop, then moves to the next focusable after it in
    // document order. Without this skip, Tab from PM stops on every
    // `<a href>` typed into the editor instead of moving to the
    // floating link toolbar that PM rendered just after the editor.
    for (let cur = el._parent; cur; cur = cur._parent) {
      if (cur.nodeType !== NODE_ELEMENT) continue;
      const ce = cur._attrs.contenteditable;
      if (ce != null && String(ce).toLowerCase() !== 'false') return false;
    }
    if (!__TABBABLE_TAGS.has(el._tag)) return false;
    if (el._tag === 'input' && (el._attrs.type || '').toLowerCase() === 'hidden') return false;
    if (el._tag === 'a' && el._attrs.href == null) return false;
    return true;
  }
  function __collectTabbables () {
    const out = [];
    if (globalThis.document) walk(globalThis.document, el => { if (__isTabbable(el)) out.push(el); });
    return out;
  }
  globalThis.__csimAdvanceFocus = function (reverse) {
    const list = __collectTabbables();
    if (list.length === 0) return false;
    const current = globalThis.document && globalThis.document._activeElement;
    let idx = current ? list.indexOf(current) : -1;
    idx = reverse ? (idx <= 0 ? list.length - 1 : idx - 1) : (idx + 1) % list.length;
    const next = list[idx];
    if (next && typeof next.focus === 'function') {
      try { next.focus(); } catch (_) {}
    }
    return true;
  };


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
    if (!mousedownEv.defaultPrevented && isFocusable(n)) {
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

})();
