// The DOM lives entirely in V8. No __dom callbacks. Capybara's Ruby
// side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.

import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_FRAGMENT, installNodeConstants } from './constants.js';
import { walk, walkSubtree, isConnected, classes, scriptText } from './walk.js';
import { handles as __handles, lookup, registerNode, registerSubtree } from './handles.js';
import { dispatchEvent } from './dispatch.js';
import {
  closeDialog,
  labeledControlFor,
  isSubmitButton,
  formForControl,
  toggleChecked,
  setRadio
} from './form-helpers.js';
import { ceTryConnect } from './custom-elements.js';
import { serializeElement } from './html-parser.js';
import {
  collectVisibleText,
  resolveLayoutProp,
  resolveTextTransform,
  rebuildCascade,
  resetCascadeState,
  resolveCascadeDisplay,
  selfHidden,
  INVISIBLE_TAGS
} from './cascade.js';
import { localStorage, sessionStorage } from './storage.js';
import {
  Event,
  DOMException,
  CustomEvent,
  MouseEvent,
  KeyboardEvent,
  InputEvent,
  SubmitEvent,
  MessageEvent,
  ClipboardEvent,
  EventTarget,
  installOnHandlerSlots
} from './events.js';
import { deliverMutations, hasQueuedRecords, hasObservers } from './mutation-observer.js';
import { timerStats }                  from './timers.js';
import { Blob, File, installBlobURL }  from './blob.js';
import { installIfMissing as installIntlCollator } from './intl-collator.js';
import { logThrew }                    from './console.js';
import { installDomClassAliases }      from './dom-class-aliases.js';
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
  deleteRangeContents
} from './dom-nodes.js';

// Side-effect modules — globalThis wirings + Promise.then patch.
import './abort.js';
import './audio.js';
import './canvas.js';
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

  // `HTMLElement` is just an alias for our `Element`; user classes do
  // `class MyThing extends HTMLElement`. CE lifecycle (registry,
  // upgradeElement, connect/disconnect hooks, attributeChangedCallback,
  // "ask for a reset" on `<option>` insert into single-select) lives
  // in `custom-elements.js`. Script-and-link side effects of CE
  // connect stay inline (closure state).
  globalThis.HTMLElement = Element;

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
      ceTryConnect(el);
    });
  }

  function maybeFireLinkLoad(el) {
    const rel = (el._attrs.rel || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet') && !rel.includes('modulepreload') && !rel.includes('preload')) return;
    const href = el._attrs.href;
    if (!href) return;
    Promise.resolve().then(() => {
      if (!isConnected(el)) return;
      let ok = true;
      try {
        const resp = __rackFetch('GET', href, '', null, 'follow');
        ok = !!(resp && resp.status < 400);
      } catch (_) { ok = false; }
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

  // Classic-script dynamic-import substitution. Webpack-bundled chunks
  // sometimes leave `await import(<expr>)` in the output (the
  // `/* webpackIgnore: true */` magic comment opts a call out of
  // webpack's chunk loader, so the raw `import()` survives into the
  // emitted bundle). When the chunk is then evaluated as a classic
  // `<script src>`, V8's parser accepts `import()` but its dynamic-
  // import resolution callback hasn't been wired up, so the call
  // rejects with `Error: Not supported`. Discourse's
  // `loadThemeFromModulePreload` / `loadPluginFromModulePreload` are
  // both shaped like that — without this hop every theme JS file ends
  // up rejected, and `define('discourse/theme-${id}/…')` never runs,
  // so the theme blocks never render and a chunk of the dev-tools and
  // blocks system specs sit on "expected to find css '.block-…'".
  // EsmRewriter does the equivalent transform for module scripts; this
  // is the matching pass for the classic-script path.
  const CSIM_CLASSIC_IMPORT_RE = /(?<![\w$.])\bimport(?=\s*\()/g;
  function csimRewriteClassicScript(body) {
    return body.indexOf('import') < 0 ? body : body.replace(CSIM_CLASSIC_IMPORT_RE, '__csim_dynamicImport');
  }

  function maybeRunScript(el) {
    const type = (el._attrs.type || '').toLowerCase();
    // Same gate as the initial parse-time scripts: classic only, no
    // modules (those go through `__csim_require`). Inline scripts in
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
    body = csimRewriteClassicScript(body);
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

  globalThis.Document = Document;     // so wgxpath patches Document.prototype.evaluate
  globalThis.Element  = Element;

  installOnHandlerSlots(Element);
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


  // `DOMParser` — parse an HTML / XML string into a Document. Turndown
  // (used by quote-reply Stimulus controller) checks `new DOMParser()`
  // at module-load time; without it, Turndown falls back to
  // `document.implementation.createHTMLDocument('').open()` which then
  // throws because we don't implement the legacy `Document.open()`.
  // Providing native DOMParser keeps Turndown on its fast path.
  globalThis.DOMParser = class DOMParser {
    parseFromString(input, mimeType) {
      const html = String(input == null ? '' : input);
      const t = String(mimeType || 'text/html').toLowerCase();
      // Note `text/xml` / `application/xml`: we use the same loose
      // parser for shape — Capybara-driven tests rarely poke past
      // the root.
      const doc = parseDocument(html);
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
      return doc;
    }
  };

  // `URL.createObjectURL` / `revokeObjectURL` wire to the shared
  // Blob registry now that `globalThis.URL` exists.
  installBlobURL();


  // Handle registry — Ruby keeps integer ids, looks up Element back
  // via `__csimGet*(handle)` accessors. Wired in `parseDocument`
  // and pushed during create / append paths once those exist.
  // Document + its html/head/body skeleton need to be in the handle
  // registry so wgxpath / find_xpath / `__csimVisible` lookups can
  // resolve skeleton nodes by id. Per-visit appendChild calls add
  // the grafted body descendants via `registerSubtree` automatically.
  registerNode(globalThis.document);
  // Shared hover-target update: sets `document._hoverElement` so
  // `:hover` cascade matches resolve against this node, then dispatches
  // mouseover (always) and mouseenter (opt-in). Pass `dedupe: true` to
  // skip the dispatch when the node was already the hover target —
  // hover-driven widgets recurse into their own listeners when fed
  // duplicate mouseover events.
  function dispatchHover(n, opts) {
    opts = opts || {};
    const doc = globalThis.document;
    if (!doc) return;
    const prev = doc._hoverElement || null;
    const changed = prev !== n;
    doc._hoverElement = n;
    if (opts.dedupe && !changed) return;
    const init = Object.assign({ bubbles: true, cancelable: true, relatedTarget: prev }, opts.init || {});
    try { dispatchEvent(n, new MouseEvent('mouseover', init)); } catch (_) {}
    if (opts.dispatchEnter) {
      try { dispatchEvent(n, new MouseEvent('mouseenter', { bubbles: false, cancelable: false, relatedTarget: prev })); } catch (_) {}
    }
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
  globalThis.__csimLoadDocument = function (html) {
    // Each Capybara visit lands here on a freshly-checked-out Context
    // from the snapshot pool. The Context is either:
    //   - "base snapshot" — just bridge + wgxpath, no app bundles run.
    //     `__externalScriptsRun` empty, document has no body. Library
    //     scripts in the page's `<head>` get evaluated here for the
    //     first time.
    //   - "app-warm snapshot" — bridge + wgxpath + app library bundles
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
    // Hover / pending-submit slots are per-visit transient state —
    // clear them so a stale `_hoverElement` from the previous page
    // can't keep matching `:hover` cascade rules against detached
    // nodes, and a never-consumed `__csimPendingFormSubmit` doesn't
    // pin the old form/submitter pair alive across the rebuild.
    globalThis.document._hoverElement = null;
    globalThis.__csimPendingFormSubmit = null;
    __inHTMLGrafting = true;
    const freshDoc = parseDocument(String(html == null ? '' : html));
    const d = globalThis.document;
    // Preserve document / documentElement / head / body identity across
    // per-visit content swaps. Library IIFEs (jQuery 3.x in particular)
    // capture `document.documentElement` at evaluation time and reuse
    // it for `createElement` / `appendChild` probes; replacing the
    // documentElement strands those references on a detached node.
    // So instead: walk the parsed tree's <head> and <body> children
    // and graft them onto the live skeleton.
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
      if (liveHtml && freshHtml) {
        for (const k of Object.keys(liveHtml._attrs)) delete liveHtml._attrs[k];
        Object.assign(liveHtml._attrs, freshHtml._attrs);
      }
      if (liveHead && freshHead) {
        for (const k of Object.keys(liveHead._attrs)) delete liveHead._attrs[k];
        Object.assign(liveHead._attrs, freshHead._attrs);
      }
      if (liveBody && freshBody) {
        for (const k of Object.keys(liveBody._attrs)) delete liveBody._attrs[k];
        Object.assign(liveBody._attrs, freshBody._attrs);
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
        // Synchronous fetch via Ruby Rack callback. mini_racer's attach
        // is blocking, so this preserves the classic-script "block the
        // parser until loaded" semantics without an event loop.
        const resp = __rackFetch('GET', s._attrs.src, '', null, 'follow');
        if (!resp || resp.status >= 400) continue;
        body = resp.body || '';
        __externalScriptsRun.set(s._attrs.src, body);
      } else {
        body = scriptText(s);
      }
      if (!body) continue;
      body = csimRewriteClassicScript(body);
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
    // `__csim_evalEsmEntry` is registered by runtimes that have a
    // native module loader (QuickJS via `vm.module_loader=`). When
    // present, hand the entry off so live bindings / `import.meta` /
    // `import()` all use spec semantics instead of our lexical
    // rewrite. V8 stays on `__csim_require` until mini_racer exposes
    // V8's Module API.
    const nativeEsm = typeof globalThis.__csim_evalEsmEntry === 'function';
    if (s._attrs.src) {
      const url = resolveAgainst(s._attrs.src, baseUrl);
      try {
        if (nativeEsm) __csim_evalEsmEntry(url, null);
        else           __csim_require(url);
      } catch (e) {
        try { console.error('[csim] module', url, 'failed:', e && (e.stack || e.message)); } catch (_) {}
      }
    } else {
      const body = scriptText(s);
      if (!body) return;
      const url = (baseUrl || 'inline://') + '#inline-' + hashStr(body);
      globalThis.__csim_inlineSources = globalThis.__csim_inlineSources || Object.create(null);
      globalThis.__csim_inlineSources[url] = body;
      try {
        if (nativeEsm) __csim_evalEsmEntry(url, body);
        else           __csim_require(url);
      } catch (e) {
        try { console.error('[csim] inline module failed:', e && e.message); } catch (_) {}
      }
    }
  }
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  globalThis.__csim_inlineSources = Object.create(null);
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
  // structure mini_racer's value filter would walk recursively
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
      if (cur.nodeType === NODE_DOC) return true;
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        if (selfHidden(cur)) return false;
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
    return true;
  };

  // visible_text walks the subtree like textContent does, but skips
  // INVISIBLE_TAGS / hidden / display:none / `<input type=hidden>`
  // children. Capybara's `has_text?` defaults to this path; without
  // the skip, page titles and `<script>` source land in the
  // visible-text string and trip "found N times including non-visible
  // text" assertions.
  globalThis.__csimVisibleText = function (h) {
    const n = lookup(h);
    if (!n) return '';
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
    // applies to a descendant's visible_text.
    const startTransform = n._parent ? resolveTextTransform(n._parent) : 'none';
    return collectVisibleText(n, startTransform);
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
    const dtItems = items.map(it => {
      if (it.kind === 'file') {
        const file = { name: it.name, type: '', size: 0 };
        return { kind: 'file', type: 'application/octet-stream', getAsFile: () => file };
      }
      return {
        kind: 'string', type: it.type,
        getAsString: (cb) => { try { cb(it.value); } catch (_) {} }
      };
    });
    const files = items.filter(it => it.kind === 'file').map(it => ({ name: it.name, type: '', size: 0 }));
    const types = items.map(it => it.kind === 'file' ? 'Files' : it.type);
    return {
      items: dtItems, files, types,
      effectAllowed: 'all', dropEffect: 'none',
      getData: (t) => { const i = items.find(x => x.type === t); return i ? i.value : ''; },
      setData: () => {},
      clearData: () => {}
    };
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
      return { kind: 'navigate', url: href, target: String(n._attrs.target || '') };
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
  // Minimal "is element focusable by a mouse click?" — used by
  // `__csimClickResolve` to mirror the HTML/UIEvents spec
  // mousedown-default-action focus transfer. Conservative whitelist:
  // standard form controls (input/textarea/select/button), anchors
  // with `href`, contenteditable hosts, and anything with an explicit
  // `tabindex`. Disabled controls aren't focusable.
  function __csimIsFocusable(n) {
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if (n._attrs.disabled != null) return false;
    const t = n._tag;
    if (t === 'input') {
      const it = (n._attrs.type || '').toLowerCase();
      if (it === 'hidden') return false;
      return true;
    }
    if (t === 'textarea' || t === 'select' || t === 'button') return true;
    if (t === 'a' && n._attrs.href != null) return true;
    if (n._attrs.tabindex != null) return true;
    if (n._attrs.contenteditable != null && (n._attrs.contenteditable || '').toLowerCase() !== 'false') return true;
    return false;
  }

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
  function __csimIsHitTarget(n) {
    if (__csimIsFocusable(n)) return true;
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
    function dfs(node) {
      const kids = node._children;
      if (!kids) return null;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.nodeType !== NODE_ELEMENT) continue;
        if (__csimIsHitTarget(k)) return k;
        const found = dfs(k);
        if (found) return found;
      }
      return null;
    }
    return dfs(n) || n;
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
    if (n._tag === 'input') {
      const type = (n._attrs.type || '').toLowerCase();
      if (type === 'checkbox') {
        wasChecked = n._attrs.checked != null;
        toggleChecked(n); preToggled = 'checkbox';
      } else if (type === 'radio') {
        wasChecked = n._attrs.checked != null;
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
    const base = { bubbles: true, cancelable: true, button: 0, which: 1,
                   shiftKey: !!mods.shiftKey, ctrlKey: !!mods.ctrlKey,
                   altKey: !!mods.altKey, metaKey: !!mods.metaKey,
                   clientX: +mods.clientX || 0, clientY: +mods.clientY || 0 };
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
    if (!mousedownEv.defaultPrevented && __csimIsFocusable(n)) {
      try { n.focus(); } catch (_) {}
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
    dispatchEvent(n, click);
    // HTML spec activation for `<input type=checkbox|radio>`: if the
    // click was cancelled, roll back the IDL-mutated state; otherwise
    // fire `input` then `change` (both bubble). Avo's row-select
    // checkbox (`data-action="input->item-selector#toggle"`) and a
    // dozen other Stimulus controllers listen for `input` to react to
    // toggle state; without this dispatch, clicking the checkbox flips
    // the IDL state silently and the dependent UI never updates.
    if (preToggled) {
      if (click.defaultPrevented) {
        if (wasChecked) n._attrs.checked = '';
        else            delete n._attrs.checked;
      } else if ((n._attrs.checked != null) !== wasChecked) {
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
    if (click.defaultPrevented) return null;

    // Summary click toggles its parent <details>'s `open` attribute.
    if (n._tag === 'summary' && !click.defaultPrevented) {
      let parent = n._parent;
      while (parent && parent._tag !== 'details') parent = parent._parent;
      if (parent && parent._tag === 'details') {
        if (parent._attrs.open != null) delete parent._attrs.open;
        else                            parent._attrs.open = '';
        try { dispatchEvent(parent, new Event('toggle', { bubbles: false })); } catch (_) {}
      }
    }

    // Click default action follows the nearest ancestor `<a>` per spec
    // ("activation behaviour of A is to follow the hyperlink"). Avo's
    // sort buttons render `<a href><svg data-tippy-content=...></svg></a>`,
    // and the test clicks on the inner `<svg>`; without the walk we
    // missed the link entirely.
    let __anchor = n;
    while (__anchor && __anchor.nodeType === NODE_ELEMENT && __anchor._tag !== 'a') {
      __anchor = __anchor._parent;
    }
    if (__anchor && __anchor.nodeType === NODE_ELEMENT && __anchor._tag === 'a' && __anchor._attrs.href != null) {
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
      return { kind: 'navigate', url: href, target: String(__anchor._attrs.target || '') };
    }
    // `<label>` activation: clicking a label clicks its labeled
    // form control. Redmine's "New member" modal renders user
    // checkboxes as `<label><input type=checkbox ...>Name</label>`;
    // without this hop, `find('label', text: ...).click` runs the
    // label's click chain but the checkbox stays unchecked and the
    // POST body omits the user_ids — the form submits but adds no
    // one. Per HTML spec the labeled control is the `for` target,
    // or — if no `for` attr — the first labelable descendant.
    if (n._tag === 'label') {
      const labeled = labeledControlFor(n);
      if (labeled && labeled !== n) {
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
