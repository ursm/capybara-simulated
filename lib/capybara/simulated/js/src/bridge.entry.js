// The DOM lives entirely in V8. No __dom callbacks. Capybara's Ruby
// side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.

import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOC, NODE_FRAGMENT, installNodeConstants } from './constants.js';
import { walk, walkSubtree, isConnected, classes, scriptText, stripOneLeadingNewline } from './walk.js';
import { handles as __handles, lookup, registerNode, registerSubtree, unregisterSubtree } from './handles.js';
import { dispatchEvent } from './dispatch.js';
import './host-queries.js';
import { makeStyleProxy } from './style-proxy.js';
import {
  closeDialog,
  labeledControlFor,
  isContenteditable,
  isSubmitButton,
  ancestorForm,
  formForControl,
  toggleChecked,
  setRadio,
  formNamedAccess
} from './form-helpers.js';
import {
  ceState,
  fireAttrChangedCallback,
  askForReset,
  ceUpgradeTree,
  ceTryConnect,
  fireCEDisconnect,
  getCustomElementCtor
} from './custom-elements.js';
import { serializeElement, serializeChildren, escapeText } from './html-parser.js';
import {
  parseSelector,
  matchOne,
  matchComplex,
  specificity,
  compareSpec,
  findAll,
  findFirst,
  findById
} from './selector-parser.js';
import {
  matchesAnyHideRule,
  collectVisibleText,
  resolveLayoutProp,
  parseInlineLayout,
  resolveTextTransform,
  rebuildCascade,
  resetCascadeState,
  selfHidden,
  isVisibleNode,
  INVISIBLE_TAGS
} from './cascade.js';
import { bytesToLatin1, bytesToArrayBuffer } from './bytes.js';
import { selectAll, selectFirst, matchesSelector, closestSelector } from './selectors.js';
import { localStorage, sessionStorage } from './storage.js';
import { Event, DOMException, CustomEvent, MouseEvent, KeyboardEvent, InputEvent, SubmitEvent, MessageEvent, ClipboardEvent, EventTarget, installOnHandlerSlots } from './events.js';
import './abort.js';
import './event-source.js';
import './file-reader.js';
import './canvas.js';
import './encoding.js';
import './url.js';
import './xhr.js';
import './navigator.js';
import './history.js';
import './dialogs.js';
import './audio.js';
import {
  bumpSettleGen,
  recordAttrMutation,
  recordChildList,
  recordCharacterData,
  deliverMutations,
  hasQueuedRecords,
  hasObservers
} from './mutation-observer.js';
import './form-data.js';
import {
  resetTimers,
  scheduleTimer,
  timerStats
} from './timers.js';
import {
  Blob,
  File,
  installBlobURL
} from './blob.js';
import './idb.js';
import './workers.js';
import { installIfMissing as installIntlCollator } from './intl-collator.js';
import './platform-globals.js';
import './observers.js';
import { logThrew } from './console.js';
import './unhandled-rejection.js';
import { HTMLCollection, NamedNodeMap, htmlCollection } from './dom-collections.js';
import { installDomClassAliases }                 from './dom-class-aliases.js';
import './tz-override.js';
import './fetch.js';
import { ingestImportmaps } from './esm-loader.js';
import {
  Node,
  Text,
  Comment,
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
        if (!resp || resp.status >= 400) return;
        body = resp.body || '';
      } catch (_) { return; }
    } else {
      body = scriptText(el);
    }
    if (!body) return;
    const label = el._attrs.src || ('inline://' + hashStr(body));
    let _ok = true;
    try { __csim_runScript(label, body); }
    catch (e) {
      _ok = false;
      logThrew('dynamic script', e);
    }
    dispatchScriptLoad(el, _ok);
  }



  // HTMLFormElement named-item access: `form.foo` returns the form
  // control whose `name` (or `id`) is `foo`. The Proxy delegates
  // anything Element already owns (methods, attrs, IDL) and falls
  // back to a named lookup on miss. Cached on the form so identity
  // checks (`button.form === form`) hold across multiple reads.
  // Used by `ChildNode.before/after/replaceWith` + `ParentNode.append
  // /prepend` to accept strings (auto-wrap as Text) alongside nodes.
  function toNode(v) {
    if (v && (v.nodeType === NODE_ELEMENT || v.nodeType === NODE_TEXT || v.nodeType === NODE_FRAGMENT || v.nodeType === NODE_DOC)) return v;
    return new Text(v == null ? '' : String(v));
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
  // location proxy. URL components mirror what Ruby's Browser
  // tracks; updated on each `__csimLoadDocument(html, url)`. Library
  // code (jQuery 1.x feature detect, Turbo Drive) reads `.href` early
  // so we need at least a non-throwing initial value.
  globalThis.location = makeLocation('http://www.example.com/');
  function makeLocation(url) {
    return parseUrlForLocation(url);
  }
  // `location.{href,pathname,hash,search} = X` navigates; defining
  // setters on the location object reproduces that.
  function parseUrlForLocation(url) {
    try {
      const u = __csim_parseUrl(url, null);
      if (u && !u.error) {
        const loc = Object.assign({}, u, {
          toString() { return this.href; },
          assign:  (next) => __locationAssign(next),
          replace: (next) => __locationAssign(next),
          reload:  () => __locationReload()
        });
        const navTarget = (resolved) => __locationAssign(resolved);
        Object.defineProperty(loc, 'href', {
          configurable: true,
          get() { return u.href; },
          set(v) { navTarget(String(v)); }
        });
        // Our URL impl doesn't update `href` when a part setter fires,
        // so rebuild the absolute URL by string-composing the parts.
        const composeWith = (overrides) => {
          const o = Object.assign({}, u, overrides);
          const cred = o.username || o.password
            ? (o.username || '') + (o.password ? ':' + o.password : '') + '@'
            : '';
          return (o.protocol || '') + '//' + cred + (o.host || '') +
                 (o.pathname || '') + (o.search || '') + (o.hash || '');
        };
        const assignPart = (key, prefix) => {
          Object.defineProperty(loc, key, {
            configurable: true,
            get() { return u[key]; },
            set(v) {
              const s = String(v == null ? '' : v);
              const part = prefix && s.length > 0 && !s.startsWith(prefix) ? prefix + s : s;
              navTarget(composeWith({ [key]: part }));
            }
          });
        };
        assignPart('pathname', '/');
        assignPart('hash',     '#');
        assignPart('search',   '?');
        return loc;
      }
    } catch (_) {}
    return { href: url || '', protocol: 'http:', host: '', hostname: '',
             port: '', pathname: '/', search: '', hash: '', origin: '',
             toString() { return this.href; },
             assign:  (next) => __locationAssign(next),
             replace: (next) => __locationAssign(next),
             reload:  () => __locationReload() };
  }
  globalThis.__csimUpdateLocation = function (url) {
    let s = String(url || '');
    // SPA helpers (Turbo Drive's `history.replace`, Avo's tabs controller)
    // pass `pathname + search` rather than a full URL. Real browsers
    // resolve the URL argument of pushState/replaceState against the
    // document's current location; storing the raw path leaves
    // `location.href` / `document.baseURI` schemeless, which breaks any
    // downstream `new URL(x, document.baseURI)` (Turbo's lazy-frame
    // `expandURL` is the canonical failure mode).
    if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      try {
        const base = (globalThis.location && globalThis.location.href) || null;
        if (base && /^[a-z][a-z0-9+.-]*:/i.test(base)) s = new URL(s, base).href;
      } catch (_) {}
    }
    globalThis.location = makeLocation(s);
    // URL change is observable progress; settle yields on it the same
    // way it yields on DOM mutations.
    bumpSettleGen();
  };

  // Selection / `window.getSelection()` — minimal stub. Real apps
  // reading `selection.toString()` for partial-quote / copy-on-select
  // flows fall through to the "no selection" branch (length === 0)
  // without crashing. `addRange` / `removeAllRanges` are noops so
  // execCommand-style libraries don't trip over missing methods.
  class CsimSelection {
    constructor() { this._ranges = []; }
    get rangeCount()  { return this._ranges.length; }
    get isCollapsed() {
      if (!this._ranges.length) return true;
      const r = this._ranges[0];
      return r.collapsed;
    }
    get anchorNode()  { return this._ranges.length ? this._ranges[0].startContainer : null; }
    get focusNode()   { return this._ranges.length ? this._ranges[0].endContainer   : null; }
    get anchorOffset(){ return this._ranges.length ? this._ranges[0].startOffset    : 0; }
    get focusOffset() { return this._ranges.length ? this._ranges[0].endOffset      : 0; }
    get type()        { return this._ranges.length ? (this.isCollapsed ? 'Caret' : 'Range') : 'None'; }
    toString() {
      if (!this._ranges.length) return '';
      // Best-effort: emit the textContent of cloneContents() for the
      // first range. This isn't the spec algorithm (which walks the
      // range with whitespace collapsing) but matches what quote-reply
      // and the partial-quote tests actually inspect.
      const frag = cloneRangeContents(this._ranges[0]);
      return frag.textContent || '';
    }
    getRangeAt(i)     { return this._ranges[i] || null; }
    addRange(r)       { this._ranges = [r]; __notifySelectionChange(); }
    removeRange(r)    { const i = this._ranges.indexOf(r); if (i >= 0) { this._ranges.splice(i, 1); __notifySelectionChange(); } }
    removeAllRanges() { if (this._ranges.length) { this._ranges.length = 0; __notifySelectionChange(); } }
    empty()           { this.removeAllRanges(); }
    // Per spec: `collapse(node, offset)` clears ranges and inserts a
    // single collapsed range at (node, offset). PM's editor uses this
    // (via `Selection.collapse(domNode, offset)`) to drive its cursor
    // position; rich-text libraries that drive their own focus call
    // it from selectionchange handlers.
    collapse(node, offset) {
      if (node == null) { this.removeAllRanges(); return; }
      const r = new DocumentOrderRange();
      r.setStart(node, offset || 0);
      r.setEnd(node, offset || 0);
      this._ranges = [r];
      __notifySelectionChange();
    }
    collapseToStart() {
      if (!this._ranges.length) throw new Error('InvalidStateError: no range');
      const r = this._ranges[0];
      r.endContainer = r.startContainer;
      r.endOffset    = r.startOffset;
      __notifySelectionChange();
    }
    collapseToEnd() {
      if (!this._ranges.length) throw new Error('InvalidStateError: no range');
      const r = this._ranges[0];
      r.startContainer = r.endContainer;
      r.startOffset    = r.endOffset;
      __notifySelectionChange();
    }
    selectAllChildren(node) {
      if (!node) return;
      const r = new DocumentOrderRange();
      r.setStart(node, 0);
      const count = node._children ? node._children.length : 0;
      r.setEnd(node, count);
      this._ranges = [r];
      __notifySelectionChange();
    }
    // Spec: extend the current range's focus to (node, offset).
    // Anchor stays; focus moves. We don't track direction separately,
    // so we just update end to the new focus point. PM uses this to
    // expand a selection from a known anchor.
    extend(node, offset) {
      if (!this._ranges.length) throw new Error('InvalidStateError: no range');
      const r = this._ranges[0];
      r.endContainer = node;
      r.endOffset    = offset | 0;
      __notifySelectionChange();
    }
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      const r = new DocumentOrderRange();
      r.setStart(anchorNode, anchorOffset | 0);
      r.setEnd(focusNode,    focusOffset  | 0);
      this._ranges = [r];
      __notifySelectionChange();
    }
    setPosition(node, offset) { this.collapse(node, offset); }
    // True if `node` is contained (fully if `partial` is false, or
    // even partially if `partial` is true) within any range of the
    // selection. quote-reply gates `isSelected` on this for the
    // "selection partially covers target element" check before
    // walking the range.
    containsNode(node, partial) {
      for (const r of this._ranges) {
        if (rangeIntersectsNode(r, node)) {
          if (partial) return true;
          // Strict full containment: range start must be at or before
          // node, end must be at or after.
          if (nodeContains(r.startContainer, node) === false &&
              nodeContains(r.endContainer, node) === false &&
              nodeContains(node, r.startContainer) === true &&
              nodeContains(node, r.endContainer) === true) {
            return true;
          }
        }
      }
      return false;
    }
    deleteFromDocument() {}
  }
  globalThis.Selection = CsimSelection;
  const __sharedSelection = new CsimSelection();
  globalThis.getSelection = function () { return __sharedSelection; };
  // Fires `selectionchange` on `document` whenever the selection's
  // anchor / focus changes. Synchronous so libraries that update
  // their internal cursor on selectionchange (PM/Tiptap) have a
  // valid view state before the next `beforeinput` reads
  // `view.state.selection`. Real browsers also fire this sync for
  // JS-initiated selection changes per the Selection API spec.
  function __notifySelectionChange() {
    const doc = globalThis.document;
    if (!doc) return;
    try { dispatchEvent(doc, new Event('selectionchange', { bubbles: false, cancelable: false })); } catch (_) {}
  }
  globalThis.__notifySelectionChange = __notifySelectionChange;

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
    while (cur) {
      if (cur.nodeType === NODE_DOC) return true;
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        if (selfHidden(cur)) return false;
        // `<details>` hides its content while closed *unless* the
        // target sits inside `<summary>`.
        if (cur._tag === 'details' && cur._attrs.open == null && !summarySeen) return false;
        if (cur._tag === 'summary') summarySeen = true;
      }
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

  // HTML spec: `<option>.selected` IDL is true when the `selected`
  // attribute is set OR when no sibling option has `selected` and this
  // is the first non-disabled option of a single-select `<select>`
  // (implicit default). Capybara's `have_select(selected: "Choose an
  // option")` matcher's `selected?` per-option filter relies on the
  // implicit branch — without it, a `<select>` with no explicit
  // `<option selected>` reports zero selected options even though the
  // first option *is* the currently rendered choice.
  // "Alive" = the node behind this handle is still attached to the
  // document tree. Handles outlive their nodes (the handle map keeps
  // a strong ref so JS-side ops on detached fragments stay coherent),
  // so "is in __handles" isn't the same as "still in the document."
  // Capybara's stale-node detection (#reload / invalid_element_errors)
  // depends on this: a node that's been removed from the DOM must
  // report as stale on the next read.
  // Spec: when no element is explicitly focused, `document.activeElement`
  // falls back to `<body>` (or `<html>` if there's no body). Capybara's
  // `Session#active_element` expects a concrete Element handle, so the
  // host-fn surface returns the body's handle when nothing has focus.
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

  globalThis.__csimClickResolve = function (h, modifiers) {
    const n = lookup(h);
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

  // ── Form-field mutations ────────────────────────────────────────
  //
  // Ruby-side Capybara DSL (`fill_in 'X', with: 'Y'`, `choose`,
  // `select`) all eventually call Node#set / select_option /
  // unselect_option. Each is one Context#call into here.

  // send_keys: replay a sequence of typed keystrokes against a
  // focusable control (or, for non-typeable targets, a plain
  // keydown / keyup chain at the body). Each atom from the Ruby
  // side is one of:
  //   { kind: 'text',  value: 'abc' }   — printable text
  //   { kind: 'key',   name: 'enter' }  — special key (no modifier)
  //   { kind: 'combo', parts: [...] }   — modifier(s) + final key
  //
  // We fire a real `keydown` (cancelable) for each effective key
  // press, then — if it wasn't `preventDefault`-ed — apply the
  // typed effect to the input value and fire `input`. `keyup`
  // closes each press. A single `change` event coalesces at the
  // end if the value moved (selenium parity: change fires after
  // the whole `send_keys` batch, not per character).
  const __KEY_NAME_MAP = {
    enter:      { key: 'Enter',     code: 'Enter',     keyCode: 13, char: '\n', inputType: 'insertLineBreak' },
    return:     { key: 'Enter',     code: 'Enter',     keyCode: 13, char: '\n', inputType: 'insertLineBreak' },
    tab:        { key: 'Tab',       code: 'Tab',       keyCode:  9, char: '\t', inputType: 'insertText'      },
    space:      { key: ' ',         code: 'Space',     keyCode: 32, char: ' ',  inputType: 'insertText'      },
    backspace:  { key: 'Backspace', code: 'Backspace', keyCode:  8, char: null, inputType: 'deleteContentBackward' },
    delete:     { key: 'Delete',    code: 'Delete',    keyCode: 46, char: null, inputType: 'deleteContentForward'  },
    escape:     { key: 'Escape',    code: 'Escape',    keyCode: 27, char: null, inputType: null },
    up:         { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38, char: null, inputType: null },
    down:       { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40, char: null, inputType: null },
    left:       { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37, char: null, inputType: null },
    right:      { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, char: null, inputType: null }
  };
  const __MODIFIER_NAMES = new Set([
    'control', 'ctrl', 'command', 'cmd', 'meta', 'shift', 'alt', 'option'
  ]);
  const __MODIFIER_KEY_INFO = {
    shift:   { key: 'Shift',    code: 'ShiftLeft',   keyCode: 16 },
    control: { key: 'Control',  code: 'ControlLeft', keyCode: 17 },
    ctrl:    { key: 'Control',  code: 'ControlLeft', keyCode: 17 },
    alt:     { key: 'Alt',      code: 'AltLeft',     keyCode: 18 },
    option:  { key: 'Alt',      code: 'AltLeft',     keyCode: 18 },
    meta:    { key: 'Meta',     code: 'MetaLeft',    keyCode: 91 },
    command: { key: 'Meta',     code: 'MetaLeft',    keyCode: 91 },
    cmd:     { key: 'Meta',     code: 'MetaLeft',    keyCode: 91 }
  };
  function __resolveKey(spec) {
    // Try the named-key table first so callers can pass 'enter' /
    // 'tab' / 'escape' interchangeably as strings or symbols — the
    // Ruby side stringifies symbols at the JSON boundary, so an
    // atom for `:enter` arrives here as the string 'enter' and
    // would otherwise fall into the printable-char branch and get
    // typed verbatim.
    const known = __KEY_NAME_MAP[String(spec).toLowerCase()];
    if (known) return Object.assign({}, known);
    // Printable: typically a single char from a text atom.
    if (typeof spec === 'string' && spec.length >= 1) {
      return { key: spec,
               code: spec.length === 1 ? 'Key' + spec.toUpperCase() : '',
               keyCode: spec.length === 1 ? spec.toUpperCase().charCodeAt(0) : 0,
               char: spec,
               inputType: 'insertText' };
    }
    return { key: String(spec), code: '', keyCode: 0, char: null, inputType: null };
  }
  function __modifierFlags(names) {
    const out = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    for (const raw of names) {
      const n = String(raw).toLowerCase();
      if (n === 'control' || n === 'ctrl')                out.ctrlKey  = true;
      else if (n === 'command' || n === 'cmd' || n === 'meta') out.metaKey = true;
      else if (n === 'shift')                             out.shiftKey = true;
      else if (n === 'alt' || n === 'option')             out.altKey   = true;
    }
    return out;
  }
  function __appendValue(n, ch) {
    if (ch == null) return;
    const cur = n._attrs.value != null ? n._attrs.value : '';
    // Insert at the current selection (which may have been moved by
    // an ArrowLeft / ArrowRight earlier in the same send_keys atom
    // stream). If selection bounds are missing, fall back to "append
    // at end" — i.e. caret-at-end after the last write.
    const s = n._selectionStart != null ? n._selectionStart : cur.length;
    const e = n._selectionEnd   != null ? n._selectionEnd   : s;
    const composed = cur.slice(0, s) + ch + cur.slice(e);
    const maxlen   = parseInt(n._attrs.maxlength || '', 10);
    n._attrs.value = (maxlen > 0 && composed.length > maxlen) ? composed.slice(0, maxlen) : composed;
    if (n._tag === 'textarea') {
      n._children = [Object.assign(new Text(n._attrs.value), { _parent: n })];
    }
    const caret = Math.min(n._attrs.value.length, s + ch.length);
    n._selectionStart = caret;
    n._selectionEnd   = caret;
  }
  globalThis.__csimSendKeys = function (h, atoms) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    const ceTypeable = isContenteditable(n);
    const typeable = ceTypeable ||
                     ((n._tag === 'input' || n._tag === 'textarea') &&
                      !(n._attrs.readonly != null || n._attrs.disabled != null));
    if (typeable) { try { n.focus(); } catch (_) {} }
    const startValue = typeable ? (n._attrs.value || '') : null;
    const pressKey = (info, modifiers) => {
      const initBase = Object.assign({ bubbles: true, cancelable: true }, modifiers || {});
      const init = Object.assign({}, initBase, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode });
      const kd = new KeyboardEvent('keydown', init);
      dispatchEvent(n, kd);
      let blocked = kd.defaultPrevented;
      // Enter's default action in a text-like input runs the form's
      // implicit-submit algorithm. If the page handler called
      // preventDefault, skip (Tagify / Tribute do this to chip the
      // current token instead of submitting).
      if (!blocked && info.key === 'Enter' && typeable && (!modifiers || (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey))) {
        const form = implicitSubmitFormFor(n);
        if (form) {
          const submit = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: null });
          dispatchEvent(form, submit);
          if (!submit.defaultPrevented) {
            globalThis.__csimPendingFormSubmit = { form, submitter: null };
          }
        }
      }
      const wouldType =
        typeable && !blocked &&
        (info.char != null || info.inputType === 'deleteContentBackward' || info.inputType === 'deleteContentForward') &&
        (!modifiers || (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey));
      if (wouldType && info.inputType) {
        // `beforeinput` fires before the value mutates, with the
        // semantic `inputType` set ('insertText' / 'insertLineBreak'
        // / 'deleteContentBackward' / etc.). Stimulus actions like
        // `data-action="beforeinput->list-autofill#handleBeforeInput"`
        // gate on `event.inputType` and call preventDefault to take
        // over (e.g. list-autofill replaces the default Enter with
        // a marker-prefixed newline). Honour the cancellation.
        const bi = new InputEvent('beforeinput', {
          bubbles: true, cancelable: true,
          data: info.char != null ? info.char : null,
          inputType: info.inputType
        });
        dispatchEvent(n, bi);
        if (bi.defaultPrevented) blocked = true;
      }
      // Arrow keys: real keyboards move the caret as the default
       // action. We don't fire input/beforeinput for these (caret
       // moves don't dispatch input), but we update the selection
       // so a subsequent character lands at the new position —
       // Capybara's `send_keys('abc', :left, 'x')` expects 'abxc'.
       if (typeable && !blocked && info.key === 'ArrowLeft') {
         const cur = n._attrs.value != null ? n._attrs.value : '';
         const pos = n._selectionStart != null ? n._selectionStart : cur.length;
         const next = Math.max(0, pos - 1);
         n._selectionStart = next;
         n._selectionEnd   = next;
       } else if (typeable && !blocked && info.key === 'ArrowRight') {
         const cur = n._attrs.value != null ? n._attrs.value : '';
         const pos = n._selectionEnd != null ? n._selectionEnd : cur.length;
         const next = Math.min(cur.length, pos + 1);
         n._selectionStart = next;
         n._selectionEnd   = next;
       }
      if (!blocked && wouldType) {
        const doDefault = () => {
          if (ceTypeable) {
            if (info.char != null) {
              __csimInsertTextAtSelection(info.char);
            } else if (info.inputType === 'deleteContentBackward') {
              const sel = globalThis.getSelection && globalThis.getSelection();
              const r = sel && sel._ranges[0];
              const sc = r && r.startContainer;
              if (sc && sc.nodeType === NODE_TEXT && r.startOffset > 0) {
                const pos = r.startOffset;
                sc.data = sc._data.slice(0, pos - 1) + sc._data.slice(pos);
                r.startOffset = pos - 1; r.endOffset = pos - 1;
              }
            }
          } else if (info.char != null) {
            __appendValue(n, info.char);
          } else if (info.inputType === 'deleteContentBackward') {
            const cur = n._attrs.value != null ? n._attrs.value : '';
            const pos = n._selectionStart != null ? n._selectionStart : cur.length;
            if (pos > 0) {
              const next = cur.slice(0, pos - 1) + cur.slice(pos);
              n._attrs.value = next;
              if (n._tag === 'textarea') n._children = [Object.assign(new Text(next), { _parent: n })];
              n._selectionStart = pos - 1;
              n._selectionEnd   = pos - 1;
            }
          }
          try {
            dispatchEvent(n, new InputEvent('input', {
              bubbles: true, cancelable: true,
              data: info.char != null ? info.char : null,
              inputType: info.inputType
            }));
          } catch (_) {}
        };
        // Keys with a promise-deferrable default (Enter / Tab —
        // Tagify, Algolia's autocomplete, jQuery-UI menu all call
        // `e.preventDefault()` from a `beforeKeyDown(e).then(...)`
        // chain for these) defer to a task so listener microtasks
        // drain first. Regular character typing stays synchronous
        // so subsequent chars see the cursor mutation from the
        // previous one (`send_keys 'abc'` must produce "abc", not
        // an out-of-order shuffle).
        if (info.key === 'Enter' || info.key === 'Tab') {
          scheduleTimer(() => {
            if (kd.defaultPrevented) return;
            doDefault();
          }, 0, [], null);
        } else {
          doDefault();
        }
      }
      dispatchEvent(n, new KeyboardEvent('keyup', init));
    };
    const atomList = Array.isArray(atoms) ? atoms : [];
    for (const a of atomList) {
      if (!a || typeof a !== 'object') continue;
      if (a.kind === 'text') {
        const s = String(a.value || '');
        for (const ch of s) pressKey(__resolveKey(ch), null);
      } else if (a.kind === 'key') {
        pressKey(__resolveKey(a.name), null);
      } else if (a.kind === 'combo') {
        const parts = Array.isArray(a.parts) ? a.parts : [];
        // Modifiers are everything but the final atom; the final
        // atom is the key being pressed *while* the modifiers are
        // held. Some callers only pass modifiers (selecting all
        // text via Ctrl+A is the canonical "modifier + letter").
        let lastKeyIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (!__MODIFIER_NAMES.has(String(parts[i]).toLowerCase())) { lastKeyIdx = i; break; }
        }
        const modNames = parts.slice(0, lastKeyIdx >= 0 ? lastKeyIdx : parts.length);
        const mods     = __modifierFlags(modNames);
        const keyName  = lastKeyIdx >= 0 ? parts[lastKeyIdx] : '';
        // Real keyboards send a keydown for each modifier first.
        // Capybara's `should generate key events` checks for the
        // 16/17/18 etc. keyCodes alongside the printable key's.
        const modInfos = modNames.map(m => __MODIFIER_KEY_INFO[String(m).toLowerCase()]).filter(Boolean);
        for (const mi of modInfos) {
          try { dispatchEvent(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, which: mi.keyCode, ...mods })); } catch (_) {}
        }
        // `[:shift, 'side']` means "hold shift, type each character" —
        // unfold the string into per-character presses with the
        // modifier flags applied. Real keyboards send one keydown per
        // physical key; without unfolding, the whole 'side' string
        // typed as one keydown plus `info.char='side'` would either
        // miss the shift-uppercase mapping or land in the value as
        // the literal modifier name (the previous behaviour).
        // BUT: `[:control, :enter]` arrives with keyName='enter'
        // (Ruby stringifies symbols at the JSON boundary), and we
        // can't unfold a special-key name into 'e','n','t','e','r'.
        // Probe `__KEY_NAME_MAP` first so named keys take precedence
        // over per-character unfolding.
        const isNamedKey = typeof keyName === 'string' && __KEY_NAME_MAP[keyName.toLowerCase()];
        if (typeof keyName === 'string' && keyName.length > 1 && !isNamedKey) {
          for (const ch of keyName) {
            const cooked = mods.shiftKey ? ch.toUpperCase() : ch;
            pressKey(__resolveKey(cooked), mods);
          }
        } else {
          const single = String(keyName);
          const cooked = mods.shiftKey && single.length === 1 ? single.toUpperCase() : single;
          pressKey(__resolveKey(cooked), mods);
        }
        for (let i = modInfos.length - 1; i >= 0; i--) {
          const mi = modInfos[i];
          try { dispatchEvent(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: mi.key, code: mi.code, keyCode: mi.keyCode, which: mi.keyCode })); } catch (_) {}
        }
        // Clipboard paste: Ctrl+V / Cmd+V should fire a `paste` event
        // with the system clipboard's text content. Real browsers do
        // this as the default action of the keydown; Redmine's
        // `copy_*_to_clipboard` tests use it to round-trip the
        // value from a Stimulus `clipboard#copyText` call.
        const lowerKey = String(keyName).toLowerCase();
        if (typeable && (mods.ctrlKey || mods.metaKey) && lowerKey === 'v') {
          const pasted = globalThis.__csimClipboardGet();
          if (pasted) {
            const ev = new Event('paste', { bubbles: true, cancelable: true });
            ev.clipboardData = {
              types: ['text/plain'],
              getData (kind) {
                return kind === 'text' || kind === 'text/plain' ? pasted : '';
              },
              setData () {}
            };
            dispatchEvent(n, ev);
            if (!ev.defaultPrevented) {
              // Insert at current caret position, replacing any
              // selection range — same as a real browser paste.
              const cur = n._attrs.value != null ? n._attrs.value : '';
              const s = n._selectionStart != null ? n._selectionStart : cur.length;
              const e = n._selectionEnd   != null ? n._selectionEnd   : s;
              const next = cur.slice(0, s) + pasted + cur.slice(e);
              n._attrs.value = next;
              if (n._tag === 'textarea') {
                n._children = [Object.assign(new Text(next), { _parent: n })];
              }
              n._selectionStart = n._selectionEnd = s + pasted.length;
              dispatchEvent(n, new InputEvent('input', {
                bubbles: true, cancelable: true,
                data: pasted, inputType: 'insertFromPaste'
              }));
            }
          }
        }
      }
    }
    if (typeable && n._attrs.value !== startValue) {
      dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
    }
    return true;
  };

  globalThis.__csimAncestorForm = function (h) {
    const n = lookup(h);
    if (!n) return 0;
    const f = ancestorForm(n);
    return f ? f._id : 0;
  };

  // Called by the Ruby side after `attach_file` resolves a list of
  // paths to {name, size, type, lastModified} entries. The list is
  // attached to the input as a FileList-shaped array; `el.files`
  // exposes it to JS consumers (jQuery file widgets, Redmine's
  // attachments.js).
  // Build a File whose bytes lazily load from the Ruby side via
  // `__csimReadFilePick(handle, index, start, end)` — ActiveStorage's
  // `DirectUpload` MD5-chunks the file via
  // `fileSlice.call(file, start, end)` + `FileReader.readAsArrayBuffer`,
  // so attached files need real Blob slicing and reading rather
  // than a plain `{name, size, type}` info dict. The host-backed
  // mode is keyed off the `_csimHost` flag the Blob prototype's
  // `slice` / `text` check.
  function __makeHostBackedFile(info, handle, index) {
    const size = Number(info.size || 0);
    const file = new globalThis.File([], String(info.name || ''), {
      type: String(info.type || ''),
      lastModified: Number(info.lastModified || 0)
    });
    file._csimHost = true;
    file._handle   = handle;
    file._index    = index;
    file._start    = 0;
    file._end      = size;
    file.size      = size;
    return file;
  }
  globalThis.__csimSetFiles = function (h, fileInfos) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    const list = Array.isArray(fileInfos) ? fileInfos : [];
    n._files = list.map((info, i) => __makeHostBackedFile(info, h, i));
    return true;
  };
  globalThis.__csimSetValue = function (h, value) {
    let n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) {
      // The element vanished between the test's `find` and the `set`
      // host call. Forem's reply-form path is the canonical case: the
      // toggle handler schedules a setTimeout that focuses the textarea
      // 30 ms later; Capybara's `Element#set` calls `tick_real_time`
      // first, the focus fires inside that drain, the focus handler
      // hands off to Preact's `replaceTextArea` (microtask), and the
      // original textarea gets `remove()`d (with its handle unmapped)
      // before we ever reach this function. Fall back to whatever the
      // page just focused — which is what the test expected to type
      // into.
      const doc = globalThis.document;
      const active = doc && doc.activeElement;
      if (active && active !== doc.body && active.nodeType === NODE_ELEMENT &&
          (active._tag === 'input' || active._tag === 'textarea' || isContenteditable(active))) {
        n = active;
      } else {
        return false;
      }
    }
    let tag = n._tag;
    // `readonly` reject programmatic value changes for text-shaped
    // inputs. `disabled` does NOT — real-browser parity (and Cuprite,
    // which uses the native HTMLInputElement value setter) lets
    // programmatic assignment write through. The form-submit gate
    // separately drops disabled controls' values. Avo's KeyValueField
    // with `disable_editing_values: true` renders the value `<input
    // disabled>` and relies on the Stimulus controller's `input`
    // event listener to copy the typed value into a sibling
    // `<textarea>` that IS submitted.
    if (tag === 'input' || tag === 'textarea') {
      if (n._attrs.readonly != null) {
        const t = (n._attrs.type || 'text').toLowerCase();
        const READONLY_RESPECTING = new Set(['text', 'email', 'password', 'tel', 'url', 'search', 'number', 'date', 'datetime-local', 'time', 'week', 'month']);
        if (READONLY_RESPECTING.has(t) || tag === 'textarea') return false;
      }
    }
    // Selenium implicitly focuses the field before typing into it
    // (`feedback_send_keys_focus` memory). Without that, delegated
    // focus handlers — Redmine's inline-autocomplete attachment lives
    // on `$(document).on('focus', '[data-auto-complete=true]', ...)`,
    // Trix's editor focus path, Stimulus actionable-on-focus
    // controllers — never wire up, and the `input` event we're about
    // to dispatch has no observer. Skip for elements that don't accept
    // focus (option/optgroup/select-with-no-focus); checkboxes /
    // radios get focused for parity with selenium's `.click()` path.
    if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
      try { n.focus(); } catch (_) {}
      // Focus handlers may swap the focused control out from under us:
      //   - `<trix-editor>` focuses its internal `[contenteditable]`
      //     descendant.
      //   - A replaceWith-style swap detaches the original node and
      //     focuses the freshly-inserted replacement.
      // Drain any zero-delay work the focus handler queued, then
      // retarget either when the active element is a descendant of
      // the original *or* the original was detached. Apps that mount
      // a sibling Preact tree alongside the focused textarea (Forem
      // comments) keep the original attached and the new control
      // outside its subtree, so they fall through and we still write
      // into the field the user/test asked for.
      try {
        if (typeof globalThis.__drainTimers === 'function') globalThis.__drainTimers(0, 1000);
      } catch (_) {}
      const active = globalThis.document && globalThis.document.activeElement;
      if (active && active.nodeType === NODE_ELEMENT &&
          active !== n &&
          (n.contains(active) || !n._parent) &&
          (active._tag === 'input' || active._tag === 'textarea' || isContenteditable(active))) {
        n = active;
        tag = n._tag;
      }
    }
    const v = value == null ? '' : String(value);
    let kind = 'value';
    if (tag === 'textarea') {
      n._children = []; n._children.push(Object.assign(new Text(v), { _parent: n }));
      n._attrs.value = v;
      // Mirror real browsers: typing-style value updates leave the
      // caret at the end of the new content. Tribute / inline-
      // autocomplete read `selectionStart` to find the trigger
      // character before the cursor; without advancing the caret,
      // selectionStart stays at 0 and the trigger detection sees
      // an empty "text before cursor" slice.
      n._selectionStart = v.length;
      n._selectionEnd   = v.length;
    } else if (tag === 'input') {
      const type = (n._attrs.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        const wasChecked = n._attrs.checked != null;
        if (value === true || value === 'true') {
          // Radio: setting one in a group clears the others on the
          // same `name`.
          if (type === 'radio') setRadio(n);
          else                  n._attrs.checked = '';
        } else if (value === false || value === 'false') delete n._attrs.checked;
        else n._attrs.value = v;
        // Selenium parity: `set(true)` on a checkbox / radio fires
        // the same `click` event a real user click would, so page
        // handlers attached via `.click` see the change.
        if ((n._attrs.checked != null) !== wasChecked) {
          try { dispatchEvent(n, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, which: 1 })); } catch (_) {}
        }
        kind = 'checked';
      } else if (type === 'range' || type === 'number') {
        // HTML5: number inputs only *validate* against step (via
        // `:invalid` / `validity.stepMismatch`), they don't snap on
        // IDL assignment. Only `<input type="range">` snaps to the
        // nearest valid step. flatpickr's minute/second inputs are
        // `type="number"` with `step="5"`; snapping at `.set(17)`
        // turns it into 15 and the picker silently saves the wrong time.
        const num    = parseFloat(v);
        const min    = parseFloat(n._attrs.min);
        const max    = parseFloat(n._attrs.max);
        let clamped  = isNaN(num) ? (isNaN(min) ? 0 : min) : num;
        if (!isNaN(min) && clamped < min) clamped = min;
        if (!isNaN(max) && clamped > max) clamped = max;
        if (type === 'range') {
          const step = parseFloat(n._attrs.step) || 1;
          if (!isNaN(min) && step > 0) {
            const k = Math.round((clamped - min) / step);
            clamped = min + k * step;
            clamped = parseFloat(clamped.toFixed(10));
          }
        }
        n._attrs.value = String(clamped);
      } else {
        // Browsers truncate at maxlength when the user types; programmatic
        // assignment via the IDL setter does the same when the input is
        // a text-like control.
        const maxlen = parseInt(n._attrs.maxlength || '', 10);
        n._attrs.value = (maxlen > 0 && v.length > maxlen) ? v.slice(0, maxlen) : v;
        // Caret-at-end, same rationale as textarea above.
        n._selectionStart = n._attrs.value.length;
        n._selectionEnd   = n._attrs.value.length;
      }
    } else if (tag === 'select') {
      // Match the first <option> whose value (or textContent fallback)
      // equals v; mark it selected, clear siblings.
      const opts = n.querySelectorAll('option');
      let hit = false;
      for (const o of opts) {
        const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
        if (ov === v) { selectOptionExclusive(n, o); hit = true; break; }
      }
      if (!hit) return false;
    } else if (isContenteditable(n)) {
      // Capybara `.set('text')` on a contenteditable element. Real
      // browsers don't bulk-replace the contenteditable's children;
      // they simulate per-character typing, driving each keystroke
      // through the full UI Events pipeline:
      //
      //   1. Select all current content (Ctrl-A).
      //   2. For each character of `v`:
      //        - keydown (cancellable)
      //        - beforeinput (cancellable; data=char, targetRanges
      //          = the current selection)
      //        - if editor preventDefault'd → it ran its own model
      //          update; otherwise our default action runs:
      //          deleteRangeContents on the selection then insert
      //          the char at the cursor (extending an adjacent text
      //          node, or creating a new one)
      //        - input (non-cancellable, data=char)
      //        - keyup
      //   3. PM/Tiptap's beforeinput reads the selection's static
      //      range to know what to replace; without that drive
      //      `onUpdate` never fires.
      //
      // This matches Cuprite's per-char `set` flow plus the
      // browser-default text-insertion step that Cuprite gets for
      // free from CDP's `Input.dispatchKeyEvent` reaching Chromium's
      // editing pipeline.
      const sel = globalThis.getSelection && globalThis.getSelection();

      // Capybara's `.set` semantics on a contenteditable is "make
      // its value v" — replace, not append. Real user does Ctrl-A +
      // type, which (a) selects all, (b) the first keystroke replaces
      // the selection with the typed character. Mirror that:
      //   1. selectAllChildren(n) — non-collapsed range over the
      //      contenteditable's content
      //   2. deleteRangeContents on it — clears existing text
      //   3. Per-char insertion at the now-empty cursor
      //
      // PM/Tiptap observes the "delete all" mutation and resets the
      // editor to its empty placeholder; the per-char inserts then
      // land in that placeholder. Plain contenteditable just sees
      // the cleared element + per-char text inserts.
      if (sel) {
        sel.selectAllChildren(n);
        const r0 = sel._ranges[0];
        if (r0 && !r0.collapsed) deleteRangeContents(r0);
        // After delete the range collapses to the empty container;
        // re-position cursor inside the deepest leaf if one exists.
        const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link']);
        let leaf = n;
        while (leaf._children && leaf._children.length > 0) {
          const next = leaf._children.find(c =>
            c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
          );
          if (!next) break;
          leaf = next;
        }
        sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
      }

      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        const kd = new KeyboardEvent('keydown', {
          bubbles: true, cancelable: true, key: ch, char: ch
        });
        dispatchEvent(n, kd);
        if (kd.defaultPrevented) { continue; }

        // Build targetRanges from the current Selection's first range
        // (live snapshot per UI Events spec). PM uses this to map
        // back to model positions.
        const r = sel && sel._ranges[0];
        const targetRanges = r ? [{
          startContainer: r.startContainer, startOffset: r.startOffset | 0,
          endContainer:   r.endContainer,   endOffset:   r.endOffset   | 0
        }] : [];
        const bi = new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, data: ch, inputType: 'insertText',
          targetRanges
        });
        dispatchEvent(n, bi);
        if (!bi.defaultPrevented) {
          __csimInsertTextAtSelection(ch);
        }
        try {
          dispatchEvent(n, new InputEvent('input', {
            bubbles: true, cancelable: false, data: ch, inputType: 'insertText'
          }));
        } catch (_) {}
        try {
          dispatchEvent(n, new KeyboardEvent('keyup', {
            bubbles: true, cancelable: true, key: ch, char: ch
          }));
        } catch (_) {}
      }
      dispatchEvent(n, new InputEvent('input', {
        bubbles: true, cancelable: false, data: v, inputType: 'insertText'
      }));
      return true;
    } else {
      n._attrs.value = v;
    }
    // Selenium's `.send_keys(text)` fires keydown + (beforeinput) +
    // input + keyup per character; libraries like Tribute initialise
    // their per-keystroke state (`commandEvent = false`) inside the
    // keydown handler, so without keydown firing first the keyup
    // check `false === commandEvent` reads `false === undefined`
    // and the show-menu branch never enters. Fire one keydown / keyup
    // pair around the value-change for the whole `set('text')` (we
    // don't have a per-character chain to lean on); the keyCode is 0
    // because we don't simulate a specific character.
    if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
      try { dispatchEvent(n, new KeyboardEvent('keydown', { bubbles: true, cancelable: true })); } catch (_) {}
    }
    // Fire `input` (cancellable, bubbles) then `change` (bubbles only).
    // For checkbox / radio real browsers fire `change` only on a real
    // user interaction, but Capybara's `set` mirrors what `selenium`
    // does — both events, so listeners see the update either way.
    dispatchEvent(n, new InputEvent('input',  { bubbles: true, cancelable: true }));
    dispatchEvent(n, new Event('change', { bubbles: true, cancelable: false }));
    if (tag === 'input' || tag === 'textarea' || isContenteditable(n)) {
      try { dispatchEvent(n, new KeyboardEvent('keyup', { bubbles: true, cancelable: true })); } catch (_) {}
    }
    // Capybara's `set("value\n")` on a text input means "type the
    // value, then press Enter". HTML's implicit form submission says:
    // when Enter is pressed in a form's sole text-like control, the
    // form submits. Detect the trailing newline, strip it from the
    // stored value, and queue a form-submit intent for Ruby to drain
    // (same channel as Rails-UJS data-method chains).
    if (tag === 'input' && typeof value === 'string' && value.endsWith('\n')) {
      n._attrs.value = String(n._attrs.value || '').replace(/\n$/, '');
      const form = implicitSubmitFormFor(n);
      if (form) {
        // Match the shape `__takePendingFormSubmit` reads: an object
        // with the raw form/submitter Element refs, not handle ids.
        globalThis.__csimPendingFormSubmit = { form, submitter: null };
      }
    }
    return true;
  };
  // HTML5 implicit form submission. Returns the form to submit when
  // `control` is the target of an Enter keypress (or a `.set("...\n")`
  // trailing-newline). A form is eligible if it has a default submit
  // button OR exactly one text-shaped input; the control itself must
  // be a text-shaped input. Capybara's `should not submit single
  // text input forms if ended with \n and has multiple values` pins
  // the multi-input branch.
  const TEXT_LIKE_INPUT_TYPES = new Set([
    'text', 'email', 'password', 'search', 'tel', 'url',
    'number', 'date', 'datetime-local', 'month', 'time', 'week'
  ]);
  const DEFAULT_SUBMIT_SELECTOR = 'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]';
  function implicitSubmitFormFor (control) {
    if (!control || control._tag !== 'input') return null;
    const type = (control._attrs.type || 'text').toLowerCase();
    if (!TEXT_LIKE_INPUT_TYPES.has(type)) return null;
    const form = formForControl(control);
    if (!form) return null;
    if (form.querySelector(DEFAULT_SUBMIT_SELECTOR)) return form;
    let count = 0;
    for (const el of form.querySelectorAll('input')) {
      if (TEXT_LIKE_INPUT_TYPES.has((el._attrs.type || 'text').toLowerCase())) {
        if (++count > 1) return null;
      }
    }
    return count === 1 ? form : null;
  }
  function selectOptionExclusive(select, opt) {
    const multi = select._attrs.multiple != null;
    const opts = select.querySelectorAll('option');
    if (!multi) for (const o of opts) delete o._attrs.selected;
    opt._attrs.selected = '';
  }
  // Real browsers (and selenium's `.select_by(...)`) fire `input`
  // and `change` on the parent `<select>` when the user picks a
  // different option. Redmine's `<select onchange=
  // "updateIssueFrom(...)">` relies on `change` to refire the form
  // AJAX; without these dispatches the form stays stale. We gate on
  // a "did the selected state change" check so a redundant
  // `select_option` against the already-selected option doesn't
  // re-fire AJAX on every Capybara call.
  function __fireSelectChange (sel) {
    try { dispatchEvent(sel, new InputEvent('input',  { bubbles: true, cancelable: true })); } catch (_) {}
    try { dispatchEvent(sel, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
  }
  function __ancestorSelect (option) {
    let cur = option._parent;
    while (cur && cur._tag !== 'select') cur = cur._parent;
    return cur && cur._tag === 'select' ? cur : null;
  }
  globalThis.__csimSelectOption = function (h) {
    const n = lookup(h);
    if (!n || n._tag !== 'option') return false;
    const sel = __ancestorSelect(n);
    if (!sel) { n._attrs.selected = ''; return true; }
    const wasSelected = n._attrs.selected != null;
    selectOptionExclusive(sel, n);
    if (!wasSelected) __fireSelectChange(sel);
    return true;
  };
  globalThis.__csimUnselectOption = function (h) {
    const n = lookup(h);
    if (!n || n._tag !== 'option') return false;
    const wasSelected = n._attrs.selected != null;
    delete n._attrs.selected;
    if (wasSelected) {
      const sel = __ancestorSelect(n);
      if (sel) __fireSelectChange(sel);
    }
    return true;
  };

  // Form serialise — mirrors urlencoded submit semantics. Skips:
  //   - inputs without `name`
  //   - disabled controls
  //   - unchecked checkbox / radio
  //   - file inputs (reported separately as `fileInputs` for the
  //     multipart submit path)
  //   - submit buttons other than the submitter
  globalThis.__csimFormSerialize = function (formHandle, submitterHandle) {
    const form = lookup(formHandle);
    if (!form || form._tag !== 'form') return null;
    const submitter = submitterHandle ? lookup(submitterHandle) : null;
    const fields = [];
    const fileInputs = [];
    // HTML's `form` IDL: controls participate via either DOM ancestry
    // Walk the whole document once and keep controls whose form
    // association lands on this form (explicit `form=<id>` wins,
    // otherwise DOM-descendant). Document order matters — browsers
    // serialise in tree order regardless of where the control lives.
    const formId = form._attrs.id;
    const isDescendant = (el) => {
      for (let cur = el._parent; cur; cur = cur._parent) if (cur === form) return true;
      return false;
    };
    const inputs = [];
    for (const f of globalThis.document.documentElement.querySelectorAll('input,textarea,select,button')) {
      const explicit = f._attrs.form;
      if (explicit != null) {
        if (formId && explicit === formId) inputs.push(f);
      } else if (isDescendant(f)) {
        inputs.push(f);
      }
    }
    for (const f of inputs) {
      if (!f._attrs.name) continue;
      if (f._attrs.disabled != null) continue;
      const tag = f._tag;
      const name = f._attrs.name;
      if (tag === 'input') {
        const type = (f._attrs.type || 'text').toLowerCase();
        if (type === 'submit' || type === 'image' || type === 'reset' || type === 'button') {
          if (f !== submitter) continue;
          fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
          continue;
        }
        if (type === 'checkbox' || type === 'radio') {
          if (f._attrs.checked == null) continue;
          fields.push([name, f._attrs.value != null ? f._attrs.value : 'on']);
          continue;
        }
        if (type === 'file') {
          fileInputs.push({ name, handle: f._id });
          continue;
        }
        fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
      } else if (tag === 'textarea') {
        // HTML form-submission spec normalizes textarea LF to CRLF.
        // Strip the same single leading line terminator that
        // `__csimValue` strips, then re-normalize line endings.
        const raw = f._attrs.value != null
          ? f._attrs.value
          : stripOneLeadingNewline(f.textContent);
        fields.push([name, String(raw).replace(/\r\n|\r|\n/g, '\r\n')]);
      } else if (tag === 'select') {
        const multi = f._attrs.multiple != null;
        const opts = f.querySelectorAll('option');
        let chose = false;
        for (const o of opts) {
          if (o._attrs.selected != null) {
            const v = o._attrs.value != null ? o._attrs.value : o.textContent;
            fields.push([name, v]);
            chose = true;
            if (!multi) break;
          }
        }
        // Implicit selection: single-select non-multi falls back to
        // first non-disabled option (mirrors browser submit).
        if (!chose && !multi) {
          for (const o of opts) {
            if (o._attrs.disabled != null) continue;
            const v = o._attrs.value != null ? o._attrs.value : o.textContent;
            fields.push([name, v]);
            break;
          }
        }
      } else if (tag === 'button') {
        const type = (f._attrs.type || 'submit').toLowerCase();
        if (type !== 'submit') continue;
        if (f !== submitter) continue;
        fields.push([name, f._attrs.value != null ? f._attrs.value : '']);
      }
    }
    // HTML 5: a `<button formaction="...">` / `<button formmethod>` /
    // `<button formenctype>` on the submitter overrides the form's
    // attributes for that one submission.
    const subAction  = submitter && submitter._attrs && submitter._attrs.formaction;
    const subMethod  = submitter && submitter._attrs && submitter._attrs.formmethod;
    const subEnctype = submitter && submitter._attrs && submitter._attrs.formenctype;
    return {
      action:  subAction  != null ? subAction  : (form._attrs.action  != null ? form._attrs.action  : ''),
      method:  (subMethod  || form._attrs.method  || 'get').toLowerCase(),
      enctype: (subEnctype || form._attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
      fields: fields,
      fileInputs: fileInputs
    };
  };

  // Vestigial: the Ruby side now rebuilds the Context from the warm
  // snapshot on every visit (and on inter-test reset), so this JS-
  // side reset is unreachable. Kept as a no-op for any latent caller.
  globalThis.__resetPage = function () {
    if (globalThis.document) {
      for (const c of globalThis.document._children.slice()) {
        globalThis.document.removeChild(c);
      }
      globalThis.document.documentElement = null;
      globalThis.document._listeners = null;
    } else {
      globalThis.document = new Document();
    }
    __handles.clear();
    registerNode(globalThis.document);
    resetTimers();
    __externalScriptsRun.clear();
    delete globalThis._rails_loaded;
  };


  globalThis.MessageEvent = MessageEvent;

  installIntlCollator();

})();
