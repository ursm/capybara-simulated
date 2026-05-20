// The DOM lives entirely in V8. No __dom callbacks. Capybara's Ruby
// side dispatches via `Context#call('__csim<Op>', args)` at the
// granularity of Capybara actions (visit / click / find / has_? / …),
// not per DOM op.

import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOC, NODE_FRAGMENT, installNodeConstants } from './constants.js';
import { walk, walkSubtree, isConnected, classes } from './walk.js';
import {
  ceState,
  fireAttrChangedCallback,
  askForReset,
  ceUpgradeTree,
  ceTryConnect,
  fireCEDisconnect,
  getCustomElementCtor
} from './custom-elements.js';
import { installHtmlParser } from './html-parser.js';
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
import { HTMLCollection, NodeList, NamedNodeMap } from './dom-collections.js';
import { installDomClassAliases }                 from './dom-class-aliases.js';
import { fireWindowListeners }                    from './window-events.js';
import { splitTopLevel }                          from './css-utils.js';
import { mediaMatches, currentViewport }          from './media-query.js';
import './tz-override.js';
import './fetch.js';
import { ingestImportmaps } from './esm-loader.js';

(function () {
  'use strict';

  // ── Node / Element classes ──────────────────────────────────────
  //
  // Mutable, JS-native, no Ruby roundtrip. Children kept in a plain
  // Array so JIT can specialise. Attributes in a plain object (string
  // keys, string values; same shape browsers expose). `_parent` is a
  // back-pointer for parentNode walks.

  let __nextId = 1;
  // Carry the registered tag through `new SomeCustomElement()` so the
  // Element base ctor can populate `_tag` even when the subclass
  // doesn't call super(tag). Browsers do this via a per-construction
  // queue; the single-threaded JS engine lets us collapse to a slot.
  let __currentTag = null;

  class Node {
    constructor() {
      this._id        = __nextId++;
      this._parent    = null;
      this._children  = [];      // ordered child nodes (Element + Text)
      this._listeners = null;    // type → [{handler, capture}]; lazy
      this.nodeType   = NODE_ELEMENT;
    }
    getRootNode(_options) {
      let cur = this;
      while (cur._parent) cur = cur._parent;
      return cur;
    }
    isSameNode(other) { return other != null && this === other; }
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
    isEqualNode(other) {
      if (other == null || this.nodeType !== other.nodeType) return false;
      if (this.nodeType === NODE_ELEMENT) {
        if (this._tag !== other._tag) return false;
        const a = this._attrs || {}, b = other._attrs || {};
        const akeys = Object.keys(a), bkeys = Object.keys(b);
        if (akeys.length !== bkeys.length) return false;
        for (const k of akeys) if (a[k] !== b[k]) return false;
      } else if (this.nodeType === NODE_TEXT || this.nodeType === NODE_COMMENT) {
        if ((this._data || '') !== (other._data || '')) return false;
      }
      const ac = this._children || [], bc = other._children || [];
      if (ac.length !== bc.length) return false;
      for (let i = 0; i < ac.length; i++) {
        if (!ac[i].isEqualNode(bc[i])) return false;
      }
      return true;
    }
    addEventListener(type, handler, options) {
      // DOM spec: handler may be either a function OR an EventListener
      // object with a `handleEvent` method. Stimulus's central
      // dispatcher passes the latter (one `EventListener` instance per
      // (element, eventName) pair, with bindings looked up inside
      // `handleEvent`) — without this branch the listener silently
      // never registers and every Stimulus `data-action` is a no-op.
      let fn = null;
      if (typeof handler === 'function') fn = handler;
      else if (handler && typeof handler.handleEvent === 'function') {
        fn = handler.handleEvent.bind(handler);
        fn._csimEventListenerObject = handler;
      } else return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners = this._listeners || Object.create(null);
      const list = this._listeners[type] || (this._listeners[type] = []);
      // Per spec, identical {type, handler, capture} is deduped. The
      // identity for handler-object form is the original object, so
      // re-registering the same EventListener instance is a no-op.
      if (list.some(l => (l.handler === fn ||
                          (handler && l.handler._csimEventListenerObject === handler)) &&
                         l.capture === capture)) return;
      list.push({ handler: fn, capture });
    }
    removeEventListener(type, handler, options) {
      if (!this._listeners || !this._listeners[type]) return;
      const capture = !!(options && (options === true || options.capture));
      this._listeners[type] = this._listeners[type].filter(l => {
        if (l.capture !== capture) return true;
        if (typeof handler === 'function') return l.handler !== handler;
        if (handler && typeof handler.handleEvent === 'function') {
          return l.handler._csimEventListenerObject !== handler;
        }
        return true;
      });
    }
    dispatchEvent(event) {
      return dispatchEvent(this, event);
    }
    // Shallow / deep node cloning. jQuery probes feature support
    // via `document.createElement('div').cloneNode(true).attachEvent`
    // etc. before initialising, so this needs to work even on
    // detached nodes. Cloned nodes copy attrs and (deep) clone
    // children; listeners + custom-element state are intentionally
    // *not* copied (matches HTML spec).
    // Focus tracking: record `document.activeElement` and emit
    // focus / focusin / blur / focusout events so listeners observing
    // either path (`onfocus="..."` attribute, addEventListener, or
    // jQuery's `.focus(handler)`) actually fire. `:focus` pseudo-
    // class matches via `_activeElement` comparison in matchPseudo.
    focus() {
      const prev = globalThis.document._activeElement;
      if (prev === this) return;
      if (prev) {
        try { dispatchEvent(prev, new Event('blur',     { bubbles: false, cancelable: false })); } catch (_) {}
        try { dispatchEvent(prev, new Event('focusout', { bubbles: true,  cancelable: false })); } catch (_) {}
      }
      globalThis.document._activeElement = this;
      // Focusing a contenteditable element should leave the cursor at
      // a valid position (real browsers collapse the selection to the
      // last known caret, or to start/end if none). PM/Tiptap's
      // beforeinput handler reads the current Selection to compute
      // edits; without an active range the handler bails out and
      // `onUpdate` never fires. Set a collapsed range at the end of
      // the contenteditable if no selection is currently inside it.
      if (typeof isContenteditable === 'function' && isContenteditable(this) && typeof globalThis.getSelection === 'function') {
        try {
          const sel = globalThis.getSelection();
          const r0  = sel._ranges && sel._ranges[0];
          const inside = r0 && r0.startContainer && nodeContains(this, r0.startContainer);
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
                c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
              );
              if (!next) break;
              leaf = next;
            }
            // If the leaf has a single text-node child, position at
            // its end; otherwise position at the leaf's children-
            // count (after any placeholder <br>).
            if (leaf._children && leaf._children.length === 1 &&
                leaf._children[0].nodeType === NODE_TEXT) {
              sel.collapse(leaf._children[0], leaf._children[0]._data.length);
            } else {
              sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
            }
          }
        } catch (_) {}
      }
      try { dispatchEvent(this, new Event('focus',    { bubbles: false, cancelable: false })); } catch (_) {}
      try { dispatchEvent(this, new Event('focusin',  { bubbles: true,  cancelable: false })); } catch (_) {}
    }
    blur() {
      if (globalThis.document._activeElement !== this) return;
      globalThis.document._activeElement = null;
      try { dispatchEvent(this, new Event('blur',     { bubbles: false, cancelable: false })); } catch (_) {}
      try { dispatchEvent(this, new Event('focusout', { bubbles: true,  cancelable: false })); } catch (_) {}
    }

    // Layout stubs — there's no rendering engine, so geometry is
    // always zero. Returning a sensible shape lets feature-detection
    // probes in jQuery / DOM libraries continue instead of throwing
    // "not a function". `getBoundingClientRect()` is the canonical
    // shape; `getClientRects()` returns a DOMRectList (an empty
    // array works for callers that just iterate or check length).
    getBoundingClientRect() {
      // Non-zero dims for visible elements so libraries that probe
      // layout to test visibility (jQuery 3.x's `:visible` filter,
      // Stimulus targets, intersection observers' default behaviour)
      // see "rendered" results that match real-browser-equivalent
      // visibility. We don't model true layout; the 1×1 box at 0,0
      // is just a sentinel.
      if (__isVisibleNode(this)) {
        return { top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0 };
      }
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    getClientRects() {
      return __isVisibleNode(this)
        ? [{ top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, x: 0, y: 0 }]
        : [];
    }
    get offsetWidth()  { return __isVisibleNode(this) ? 1 : 0; }
    get offsetHeight() { return __isVisibleNode(this) ? 1 : 0; }
    get clientWidth()  { return __isVisibleNode(this) ? 1 : 0; }
    get clientHeight() { return __isVisibleNode(this) ? 1 : 0; }
    get scrollWidth()  { return __isVisibleNode(this) ? 1 : 0; }
    // Approximate scrollHeight as 20px/line over 80 chars/line so
    // content-length gates fire. Avo's Trix body checks
    // `scrollHeight > some-threshold` to decide whether to inject the
    // "More content" expander; a flat `1` keeps it from ever rendering.
    // Counts element children only (whitespace text nodes between
    // formatted HTML would otherwise inflate the count and trip the
    // gate on short content).
    get scrollHeight() {
      if (!__isVisibleNode(this)) return 0;
      const txt  = (this.textContent || '').length;
      const kids = this.children ? this.children.length : 0;
      if (txt === 0 && kids === 0) return 0;
      return Math.max(Math.ceil(txt / 80) * 20, kids * 20);
    }
    get offsetTop()    { return 0; }
    get offsetLeft()   { return 0; }
    get offsetParent() { return this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null; }
    get scrollTop()    { return 0; }
    set scrollTop(_)   { /* no-op */ }
    get scrollLeft()   { return 0; }
    set scrollLeft(_)  { /* no-op */ }
    scrollIntoView() { /* no-op */ }
    scrollTo()       { /* no-op */ }
    scrollBy()       { /* no-op */ }

    // DOM Node bitmask: DOCUMENT_POSITION_PRECEDING=2,
    // DOCUMENT_POSITION_FOLLOWING=4. Stimulus / Sizzle / various
    // libs use this for document-order sorting.
    compareDocumentPosition(other) {
      if (other === this) return 0;
      const cmp = compareDocOrder(this, other);
      if (cmp < 0) return 4;  // FOLLOWING
      if (cmp > 0) return 2;  // PRECEDING
      return 0;
    }

    cloneNode(deep) {
      const copy = this._cloneShell();
      if (deep && this._children) {
        for (const c of this._children) {
          const cc = c.cloneNode(true);
          cc._parent = copy;
          copy._children.push(cc);
        }
      }
      // `<template>.content` carries the inert children; mirror them
      // onto the clone so `template.content.cloneNode(true)` (Avo's
      // belongs_to polymorphic pattern, Turbo's StreamMessage parsing)
      // lands on a real DocumentFragment.
      if (deep && this.nodeType === NODE_ELEMENT && this._tag === 'template' && this._templateContent) {
        const frag = new DocumentFragment();
        for (const c of this._templateContent._children) {
          const cc = c.cloneNode(true);
          cc._parent = frag;
          frag._children.push(cc);
        }
        copy._templateContent = frag;
      }
      return copy;
    }
    _cloneShell() {
      // Override in Element / Text.
      return new this.constructor();
    }
    get parentNode()    { return this._parent; }
    get parentElement() { return this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null; }
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
    get isConnected() { return isConnected(this); }
    get firstChild()    { return this._children[0] || null; }
    get lastChild()     { return this._children[this._children.length - 1] || null; }
    get childNodes()    { return this._children.slice(); }
    hasChildNodes()     { return this._children.length > 0; }
    // `Node.contains(other)` — true if other is inclusively `this` or
    // descendant. Per DOM spec lives on Node (Document inherits).
    // jQuery 3.x's `isAttached(elem)` calls
    // `jQuery.contains(elem.ownerDocument, elem)`, and jQuery.contains
    // internally calls `document.contains(elem)`; without the method
    // on Document the isHidden path threw and `.toggle()` mis-decided
    // its direction (always hide).
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur._parent;
      }
      return false;
    }
    // `form.submit()` — programmatic form submission. Per HTML spec
    // this does NOT fire a `submit` event (selenium-mode submit-via-
    // button fires submit; programmatic skips it; memory
    // `feedback_form_submit_spec_compliance`). We can't return out
    // through the synchronous JS call stack here, so we stash the
    // intent on a global slot that the outer click-resolver picks up
    // (Rails-UJS data-method/data-confirm chain ends in form.submit
    // inside the click handler; the Ruby side reads the intent after
    // dispatch and routes through the normal POST/GET form-submit
    // path). Direct callers (Capybara `Node#submit`) hit the host
    // fn instead.
    submit() {
      if (this._tag !== 'form') return;
      globalThis.__csimPendingFormSubmit = { form: this, submitter: null };
    }
    requestSubmit(submitter) {
      // `form.requestSubmit()` (HTML spec): like submit() but DOES
      // fire 'submit' event and goes through the form-submit
      // algorithm. We can't fully run that algorithm pre-navigation,
      // so we dispatch submit + record the intent + let the
      // submitter contribute its value.
      if (this._tag !== 'form') return;
      const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null });
      dispatchEvent(this, ev);
      if (ev.defaultPrevented) return;
      globalThis.__csimPendingFormSubmit = { form: this, submitter: submitter || null };
    }
    // `el.click()` — programmatic synthetic click. jstoolbar dispatches
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
    click() {
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
        const wasChecked = isInputControl ? (this._attrs.checked != null) : null;
        if (isInputControl) {
          if (inputType === 'checkbox') toggleChecked(this);
          else                          setRadio(this);
        }
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, which: 1 });
        dispatchEvent(this, ev);
        if (ev.defaultPrevented && isInputControl) {
          // Roll back the state change if the click was cancelled.
          if (wasChecked) this._attrs.checked = '';
          else            delete this._attrs.checked;
        } else if (isInputControl && (this._attrs.checked != null) !== wasChecked) {
          try { dispatchEvent(this, new InputEvent('input',  { bubbles: true, cancelable: true })); } catch (_) {}
          try { dispatchEvent(this, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
        }
        if (!ev.defaultPrevented && isSubmitButton(this)) {
          const form = formForControl(this);
          if (form) {
            const submitEv = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: this });
            dispatchEvent(form, submitEv);
            if (!submitEv.defaultPrevented) {
              globalThis.__csimPendingFormSubmit = { form, submitter: this };
            }
          }
        }
        // HTML-spec anchor activation behaviour for programmatic
        // `el.click()`. Walk to the nearest `<a href>` ancestor — Avo's
        // `text-filter`/`select-filter`/etc. controllers do
        // `this.urlRedirectTarget.click()` on a hidden `<a>` after
        // building the filtered URL; without queuing the navigation
        // here the controller silently no-ops and the filters panel
        // never closes (filters_panel_open_spec's "keeps the panel
        // closed on selection"). We DEFER the navigation to a Ruby-
        // side drain slot rather than navigating in-call: navigating
        // from inside a V8 callback rebuilds the Context mid-eval and
        // terminates the script (see `feedback_visit_always_rebuilds`).
        // Mirrors `__csimPendingFormSubmit`.
        if (!ev.defaultPrevented && !globalThis.__csimPendingFormSubmit) {
          let anchor = this;
          while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== 'a') {
            anchor = anchor._parent;
          }
          if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag === 'a' &&
              anchor._attrs.href != null && (anchor._attrs.href || '').trim() !== '' &&
              !(anchor._attrs.href || '').toLowerCase().startsWith('javascript:')) {
            globalThis.__csimPendingNavigation = {
              url: String(anchor._attrs.href),
              target: anchor._attrs.target || ''
            };
          }
        }
      } catch (_) {}
    }
    // `Element.remove()` / `ChildNode.remove()` — detach this node from
    // its parent. Standard since DOM4; the table-paste Stimulus
    // controller walks pasted HTML and strips `<style>` / wrapping
    // nodes via `e.remove()` before formatting.
    remove() {
      if (this._parent) this._parent.removeChild(this);
    }
    // `ChildNode.before(...nodes)` / `after(...nodes)` / `replaceWith
    // (...nodes)` — convenience neighbours of `remove`. Pass strings or
    // nodes; strings become Text nodes. Stimulus / jQuery 3.x lean on
    // these for shorter swap-this-with-that idioms.
    before (...nodes) { if (this._parent) for (const n of nodes) this._parent.insertBefore(toNode(n), this); }
    after  (...nodes) {
      if (!this._parent) return;
      const sibs = this._parent._children;
      const idx  = sibs.indexOf(this);
      const ref  = idx + 1 < sibs.length ? sibs[idx + 1] : null;
      for (const n of nodes) this._parent.insertBefore(toNode(n), ref);
    }
    replaceWith (...nodes) {
      if (!this._parent) return;
      const p = this._parent;
      for (const n of nodes) p.insertBefore(toNode(n), this);
      p.removeChild(this);
    }
    // `ParentNode.prepend(...nodes)` / `append(...nodes)` — the
    // sibling of `appendChild` that accepts strings + variadic args.
    prepend (...nodes) {
      const first = this._children[0] || null;
      for (const n of nodes) this.insertBefore(toNode(n), first);
    }
    append (...nodes) { for (const n of nodes) this.appendChild(toNode(n)); }
    get children()      { return this._children.filter(c => c.nodeType === NODE_ELEMENT); }
    // ParentNode mixin: element-only child accessors. Hand-rolled
    // short-circuit walks rather than composing on `children` so
    // hot DOM-traversal callers don't pay an array allocation per
    // access just to read first / last / count.
    get firstElementChild() {
      for (const c of this._children) if (c.nodeType === NODE_ELEMENT) return c;
      return null;
    }
    get lastElementChild() {
      for (let i = this._children.length - 1; i >= 0; i--) {
        if (this._children[i].nodeType === NODE_ELEMENT) return this._children[i];
      }
      return null;
    }
    get childElementCount() {
      let n = 0;
      for (const c of this._children) if (c.nodeType === NODE_ELEMENT) n++;
      return n;
    }
    get nextSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      const i = sibs.indexOf(this);
      return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
    }
    get previousSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      const i = sibs.indexOf(this);
      return i > 0 ? sibs[i - 1] : null;
    }
    // Skip non-element siblings (text / comment nodes). Standard DOM
    // API; libraries and css-select v7's `:first-child` /
    // `:nth-of-type` rely on these.
    get previousElementSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      for (let i = sibs.indexOf(this) - 1; i >= 0; i--) {
        if (sibs[i].nodeType === NODE_ELEMENT) return sibs[i];
      }
      return null;
    }
    get nextElementSibling() {
      if (!this._parent) return null;
      const sibs = this._parent._children;
      for (let i = sibs.indexOf(this) + 1; i < sibs.length; i++) {
        if (sibs[i].nodeType === NODE_ELEMENT) return sibs[i];
      }
      return null;
    }
    appendChild(child) {
      // DocumentFragment splice: spec says appendChild(fragment) moves
      // each child of the fragment to the new parent and leaves the
      // fragment empty. The fragment itself is not inserted. Real-DOM
      // libraries (jQuery's `.html(fragment)`, Stimulus's element
      // templating) rely on this — without unwrapping we'd graft a
      // bare DocumentFragment into the tree, breaking ancestor walks
      // and Capybara's visibility / find_xpath paths.
      if (child && child.nodeType === NODE_FRAGMENT) {
        const moved = child._children.slice();
        for (const c of moved) {
          if (c._parent) c._parent.removeChild(c);
          c._parent = this;
          this._children.push(c);
          registerSubtree(c);
          recordChildList(this, [c], []);
          if (isConnected(this)) fireCEConnect(c);
          askForReset(c);
        }
        child._children.length = 0;
        return child;
      }
      if (child._parent) child._parent.removeChild(child);
      child._parent = this;
      this._children.push(child);
      registerSubtree(child);
      recordChildList(this, [child], []);
      if (isConnected(this)) fireCEConnect(child);
      askForReset(child);
      return child;
    }
    removeChild(child) {
      const i = this._children.indexOf(child);
      if (i < 0) return null;
      const wasConnected = isConnected(this);
      this._children.splice(i, 1);
      child._parent = null;
      unregisterSubtree(child);
      recordChildList(this, [], [child]);
      if (wasConnected) fireCEDisconnect(child);
      return child;
    }
    insertBefore(child, ref) {
      if (ref == null) return this.appendChild(child);
      // DocumentFragment splice — same unwrap as appendChild, but
      // inserting before `ref` rather than at the end.
      if (child && child.nodeType === NODE_FRAGMENT) {
        const moved = child._children.slice();
        for (const c of moved) {
          if (c._parent) c._parent.removeChild(c);
          const idx = this._children.indexOf(ref);
          c._parent = this;
          this._children.splice(idx < 0 ? this._children.length : idx, 0, c);
          registerSubtree(c);
          recordChildList(this, [c], []);
          if (isConnected(this)) fireCEConnect(c);
          askForReset(c);
        }
        child._children.length = 0;
        return child;
      }
      if (child._parent) child._parent.removeChild(child);
      const i = this._children.indexOf(ref);
      if (i < 0) return this.appendChild(child);
      child._parent = this;
      this._children.splice(i, 0, child);
      registerSubtree(child);
      recordChildList(this, [child], []);
      if (isConnected(this)) fireCEConnect(child);
      askForReset(child);
      return child;
    }
    replaceChild(neu, old) {
      const i = this._children.indexOf(old);
      if (i < 0) return null;
      const wasConnected = isConnected(this);
      if (neu._parent) neu._parent.removeChild(neu);
      neu._parent = this;
      old._parent = null;
      this._children[i] = neu;
      unregisterSubtree(old);
      registerSubtree(neu);
      recordChildList(this, [neu], [old]);
      if (wasConnected) { fireCEDisconnect(old); fireCEConnect(neu); }
      askForReset(neu);
      return old;
    }
    // textContent collects descendant text; setter replaces children
    // with a single text node.
    get textContent() {
      let s = '';
      for (const c of this._children) {
        s += c.nodeType === NODE_TEXT ? c.data : c.textContent;
      }
      return s;
    }
    set textContent(v) {
      // Spec: "replace all" — clear children, insert single Text node.
      // Fire a childList mutation (removedNodes = old children,
      // addedNodes = the new text node) so MutationObservers see the
      // change. PM/Tiptap's domchange observer needs this to know
      // the user's `set()` updated the editor content.
      const removed = this._children.slice();
      for (const c of removed) c._parent = null;
      this._children = [];
      const text = String(v == null ? '' : v);
      const added = [];
      if (text.length > 0) {
        const t = new Text(text);
        t._parent = this;
        this._children.push(t);
        added.push(t);
      }
      if (removed.length > 0 || added.length > 0) {
        recordChildList(this, added, removed);
      }
    }
    // `innerText` is the "as rendered" sibling of textContent — line
    // breaks from `<br>` / block boundaries, whitespace collapsed,
    // visibility-aware. Without a layout engine we can't compute the
    // rendered form, so we fall back to textContent — what Chromium
    // does anyway for detached / not-being-rendered subtrees per spec
    // note. Critical because Redmine's jstoolbar builds its Edit /
    // Preview tabs via `link.innerText = tabName`, and without the
    // setter the tabs end up empty and `click_link 'Preview'` fails.
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
  }

  class Text extends Node {
    constructor(data) {
      super();
      this.nodeType = NODE_TEXT;
      this._data    = String(data == null ? '' : data);
    }
    get nodeName()    { return '#text'; }
    _cloneShell()     { return new Text(this._data); }
    get data()        { return this._data; }
    // Spec: every write to a Text node's `data` (or `nodeValue` /
    // `textContent`, which proxy through here) queues a
    // `characterData` mutation record. ProseMirror/Tiptap's
    // `domchange` reconciler reads these to map browser-side text
    // edits back into a transaction; without the record, our
    // `set("text")` on contenteditable updates the DOM but PM
    // silently skips the model update and `onUpdate` never fires.
    set data(v) {
      const next = String(v == null ? '' : v);
      const prev = this._data;
      if (prev === next) return;
      this._data = next;
      recordCharacterData(this, prev);
    }
    get nodeValue()   { return this.data; }
    set nodeValue(v)  { this.data = v; }
    get textContent() { return this.data; }
    set textContent(v){ this.data = v; }
    // wgxpath uses these on text nodes via XPath `text()` / `string()`.
    get prefix()       { return null; }
    get namespaceURI() { return null; }
    get localName()    { return null; }
    get ownerDocument(){ return this._ownerDoc || globalThis.document; }
    // Layout stubs — Text nodes implement getClientRects/getBoundingClientRect
    // too (browsers wrap each line in a rect; we don't lay out, so
    // empty/zero-rect responses are the closest spec-shaped fallback).
    // PM's domchange calls getClientRects on changed text nodes to
    // decide whether to bail on certain CSS-cursor edge cases; without
    // these methods PM's flush throws and never delivers the
    // transaction.
    getClientRects() { return []; }
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
  }

  // Comment node. Created via `document.createComment(data)` and
  // serialised as `<!--data-->`. Trix uses `<!--block-->` markers
  // inside its rendered editor DOM, then strips them with a regex
  // on `innerHTML` before storing in the form's hidden input — if
  // we represented comments as text the marker leaked through as
  // the literal string "block".
  class Comment extends Text {
    constructor(data) {
      super(data);
      this.nodeType = NODE_COMMENT;
    }
    get nodeName() { return '#comment'; }
    _cloneShell()  { return new Comment(this.data); }
  }
  globalThis.Comment = Comment;

  // Per HTML spec, the `href` / `src` IDL attributes return the URL
  // resolved against the document base — not the raw attribute value.
  const HREF_REFLECTING_TAGS = new Set(['a', 'area', 'link']);
  const SRC_REFLECTING_TAGS  = new Set([
    'script', 'img', 'iframe', 'frame', 'embed', 'source', 'audio', 'video', 'track'
  ]);
  function reflectURLAttr(el, name, tagSet) {
    if (!tagSet.has(el._tag)) return el._attrs[name];
    const v = el._attrs[name];
    if (v == null) return '';
    try {
      const base = (globalThis.location && globalThis.location.href) || null;
      const u = __csim_parseUrl(v, base);
      return u && !u.error ? u.href : v;
    } catch (_) { return v; }
  }

  class Element extends Node {
    constructor(tagName) {
      if (ceState.pendingUpgrade) {
        const target = ceState.pendingUpgrade;
        ceState.pendingUpgrade = null;
        try { Object.setPrototypeOf(target, new.target.prototype); } catch (_) {}
        return target;
      }
      super();
      // Allow subclasses (custom elements) to call `super()` without
      // a tagName — `__currentTag` carries the registered tag through
      // the `new MyCustomElement()` path from createElement.
      this._tag    = String(tagName || __currentTag || '').toLowerCase();
      this._attrs  = {};   // name(lower) → value(string)
    }
    _cloneShell() {
      const e = new Element(this._tag);
      e._attrs = Object.assign({}, this._attrs);
      return e;
    }
    get tagName()    { return this._tag.toUpperCase(); }
    get nodeName()   { return this.tagName; }
    get nodeValue()  { return null; }
    get localName()  { return this._tag; }
    // `.content` is tag-specific per HTML spec:
    //   - `<template>`: the inert `DocumentFragment` carrying the
    //     template's children. Lazy-initialised for templates created
    //     via `document.createElement`; the HTML parser pre-populates
    //     `_templateContent` when it encounters `<template>…</template>`.
    //     Readonly per IDL — the setter is a silent no-op.
    //   - `<meta>`: reflects the `content` attribute. Forem's
    //     `initializeBodyData.js` builds the csrf-token meta via
    //     `createElement('meta'); el.content = token; head.append(el)`,
    //     so without the setter the csrf wait loop never resolves and
    //     Preact never mounts.
    // Any other element treats `.content` as an own data property,
    // matching real-browser behaviour for tags without a `content`
    // IDL slot.
    get content() {
      if (this._tag === 'template') {
        if (!this._templateContent) this._templateContent = new DocumentFragment();
        return this._templateContent;
      }
      if (this._tag === 'meta') {
        const v = this._attrs['content'];
        return v == null ? '' : v;
      }
      return undefined;
    }
    set content(v) {
      if (this._tag === 'template') return;
      if (this._tag === 'meta') { this.setAttribute('content', v == null ? '' : String(v)); return; }
      Object.defineProperty(this, 'content', {value: v, writable: true, configurable: true, enumerable: true});
    }
    // `<dialog>` HTML interface — show() / showModal() / close() per
    // HTMLDialogElement. Turbo's confirm flow uses this: opens
    // `<dialog id="turbo-confirm">` via `showModal()`, waits for the
    // `close` event, reads `returnValue`. The `<form method="dialog">`
    // submit path in `__csimClickResolve` is the close trigger; show
    // simply flips the `open` attribute (no real layout / focus
    // trapping — Capybara just queries the visible-by-attribute
    // descendants and that suffices).
    show() {
      if (this._tag !== 'dialog') return;
      this.setAttribute('open', '');
    }
    showModal() {
      if (this._tag !== 'dialog') return;
      this.setAttribute('open', '');
    }
    close(returnValue) {
      if (this._tag !== 'dialog') return;
      closeDialog(this, returnValue);
    }
    // Report the XHTML namespace per HTML spec. wgxpath defaults
    // missing namespaceURI to XHTML (vendor/js/wgxpath.js:55), so
    // Capybara's `//*` queries are unaffected by reporting it
    // explicitly. Required for DOMPurify's `_checkValidNamespace`
    // to keep elements (Trix's HTMLSanitizer wipes the body
    // without it).
    get prefix()       { return null; }
    get namespaceURI() { return 'http://www.w3.org/1999/xhtml'; }
    get ownerDocument(){ return this._ownerDoc || globalThis.document; }
    getAttribute(name)        { const v = this._attrs[String(name).toLowerCase()]; return v == null ? null : v; }
    setAttribute(name, value) {
      const n = String(name).toLowerCase();
      const old = this._attrs[n];
      const next = String(value);
      this._attrs[n] = next;
      recordAttrMutation(this, n, old == null ? null : old);
      if (old !== next) fireAttrChangedCallback(this, n, old == null ? null : old, next, Element);
    }
    // Namespace-aware setters delegate to the flat store. React-DOM
    // production calls `setAttributeNS('http://www.w3.org/1999/xlink',
    // 'xlink:href', value)` etc. for SVG attributes; we ignore the
    // namespace and key on the qualified name, which is enough for
    // serialization parity and selector matching.
    setAttributeNS(_ns, qualifiedName, value) { this.setAttribute(qualifiedName, value); }
    removeAttributeNS(_ns, qualifiedName)     { this.removeAttribute(qualifiedName); }
    getAttributeNS(_ns, qualifiedName)        { return this.getAttribute(qualifiedName); }
    hasAttributeNS(_ns, qualifiedName)        { return this.hasAttribute(qualifiedName); }
    removeAttribute(name) {
      const n = String(name).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
      const old = this._attrs[n];
      delete this._attrs[n];
      recordAttrMutation(this, n, old == null ? null : old);
      fireAttrChangedCallback(this, n, old == null ? null : old, null, Element);
    }
    hasAttribute(name)        { return Object.prototype.hasOwnProperty.call(this._attrs, String(name).toLowerCase()); }
    // `Element.toggleAttribute(name, force?)` per DOM spec. Without
    // `force`, flips the attribute (present → absent, absent →
    // present-with-empty-value); with `force`, asserts the state.
    // Returns the resulting presence as a boolean. Trix's
    // `makeEditable(element)` calls `element.toggleAttribute(
    // "contenteditable", !element.disabled)` and throws if the
    // method is missing — connectedCallback aborts before the
    // EditorController is wired up.
    toggleAttribute(name, force) {
      const has = this.hasAttribute(name);
      const next = arguments.length > 1 ? !!force : !has;
      if (next === has) return next;
      if (next) this.setAttribute(name, '');
      else      this.removeAttribute(name);
      return next;
    }
    getAttributeNames() { return Object.keys(this._attrs); }
    // `attributes` returns a NamedNodeMap-shaped collection — array-
    // indexed + `getNamedItem(name)`. wgxpath iterates via `length` +
    // index access; Capybara's `Element#native.attributes` reads
    // `{name, value}` pairs. We give each item the Attr fields wgxpath
    // touches (`specified`, `namespaceURI`, `prefix`, `localName`,
    // `ownerElement`).
    get attributes() {
      const el    = this;
      const names = Object.keys(this._attrs);
      const list  = names.map(n => makeAttr(el, n));
      // NamedNodeMap supports both numeric (`attributes[0]`) and named
      // (`attributes['id']`) access. The array gives us numeric for
      // free; assign named keys for getNamedItem-equivalent lookups
      // that frameworks (jQuery 1.x, Sizzle) use during feature
      // detection. Mark them non-enumerable so `Object.keys(attributes)`
      // matches a real browser (numeric indices only) — Forem's
      // `replaceTextArea` does `Object.keys(attributes).forEach(k =>
      // newEl.setAttribute(attributes[k].name, attributes[k].value))`,
      // and would otherwise iterate `getNamedItem` (an anonymous
      // function with `.name === ''`, `.value === undefined`) and call
      // `setAttribute('', 'undefined')` on the replacement node.
      for (const n of names) {
        Object.defineProperty(list, n, { value: makeAttr(el, n), enumerable: false, configurable: true, writable: true });
      }
      Object.defineProperty(list, 'getNamedItem', {
        value: name => {
          const lower = String(name).toLowerCase();
          return Object.prototype.hasOwnProperty.call(el._attrs, lower) ? makeAttr(el, lower) : null;
        },
        enumerable: false, configurable: true, writable: true
      });
      return list;
    }
    getAttributeNode(name) {
      const n = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(this._attrs, n) ? makeAttr(this, n) : null;
    }
    // HTMLCollection-shaped getters wgxpath / framework code expects.
    // Spec says these return *descendants* of the element (not self);
    // my `walk()` starts at the receiver so we have to drop the
    // self-hit explicitly to avoid wgxpath descendant-axis dupes.
    getElementsByTagName(tag) {
      const t = String(tag).toLowerCase();
      const all = t === '*' ? this.querySelectorAll('*') : this.querySelectorAll(t);
      return __htmlCollection(all.filter(n => n !== this));
    }
    getElementsByClassName(cls) {
      const sel = String(cls).split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
      return __htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
    }
    getElementsByName(name) {
      const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
      return __htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
    }
    // IDL `id` / `className` go through setAttribute so MO sees the
    // change record. Setting them directly on `_attrs` would skip the
    // hook and break observers that watch `attributes`.
    // Minimal CSSStyleDeclaration. We don't parse / compute styles —
    // `cssText` is just a mirror onto the `style="..."` attribute,
    // and individual property access reads / writes the corresponding
    // declaration in that string. Enough for jQuery / framework
    // feature-detection (`el.style.cssText = '...'`); not enough for
    // `getComputedStyle()`-style cascade resolution.
    get style() {
      if (!this._styleProxy) this._styleProxy = makeStyleProxy(this);
      return this._styleProxy;
    }
    set style(v) {
      this.setAttribute('style', String(v == null ? '' : v));
      this._styleProxy = null;
    }

    get id()        { return this._attrs.id || ''; }
    set id(v)       { this.setAttribute('id', String(v)); }
    get className() { return this._attrs['class'] || ''; }
    set className(v){ this.setAttribute('class', String(v)); }

    // `HTMLTimeElement#dateTime` reflects the `datetime` content
    // attribute. Mastodon's `public.tsx` reads `<time>.dateTime` to
    // re-format timestamps; without the IDL getter the property is
    // undefined, `new Date(undefined)` is Invalid Date, and
    // `Intl.DateTimeFormat.format(invalid)` throws under QuickJS's
    // strict polyfill (V8 returns "Invalid Date" instead).
    get dateTime()  { return this._attrs.datetime || ''; }
    set dateTime(v) { this.setAttribute('datetime', String(v)); }
    get classList() {
      const el = this;
      // DOMTokenList — `add` / `remove` are variadic per the spec;
      // libraries lean on that (`el.classList.add('a','b','c')`).
      return {
        contains(c) { return classes(el).includes(c); },
        add(...names) {
          const cs = classes(el);
          for (const n of names) if (!cs.includes(n)) cs.push(n);
          el._attrs['class'] = cs.join(' ');
        },
        remove(...names) {
          const drop = new Set(names);
          el._attrs['class'] = classes(el).filter(x => !drop.has(x)).join(' ');
        },
        toggle(c, force) {
          const cs = classes(el);
          const i = cs.indexOf(c);
          const present = i >= 0;
          if (force === true || (force === undefined && !present)) {
            if (!present) cs.push(c);
          } else {
            if (present) cs.splice(i, 1);
          }
          el._attrs['class'] = cs.join(' ');
          return cs.includes(c);
        },
        // `replace(old, new)` — swaps one class for another (DOMTokenList
        // spec). Returns true if `old` was present. quote-reply +
        // syntax-highlighter callers do
        // `el.classList.replace('ruby', 'language-ruby')`.
        replace(oldClass, newClass) {
          const cs = classes(el);
          const i = cs.indexOf(String(oldClass));
          if (i < 0) return false;
          cs[i] = String(newClass);
          el._attrs['class'] = cs.join(' ');
          return true;
        },
        item(i) {
          const cs = classes(el);
          return i >= 0 && i < cs.length ? cs[i] : null;
        },
        get length() { return classes(el).length; },
        get value()  { return el._attrs['class'] || ''; },
        set value(v) { el._attrs['class'] = String(v == null ? '' : v); },
        toString()   { return el._attrs['class'] || ''; },
        forEach(fn)  { classes(el).forEach((c, i) => fn(c, i, this)); },
        entries()    { return classes(el).entries(); },
        keys()       { return classes(el).keys(); },
        values()     { return classes(el).values(); }
      };
    }
    // HTMLElement.dataset — DOMStringMap-shaped live view of every
    // `data-*` attribute on the element. Real-browser equivalents:
    // `el.dataset.fooBar` ↔ `data-foo-bar` attribute (camelCase
    // ↔ kebab-case). Libraries lean on it heavily (Tribute checks
    // `element.dataset.tribute === 'true'` to avoid double-attach,
    // Stimulus stores controller / target / action data, Trix mirrors
    // its editor state, etc.) — without the getter, the read throws
    // `Cannot read properties of undefined (reading 'fooBar')` and the
    // library short-circuits silently. Proxy reads `_attrs` lazily so
    // setAttribute / removeAttribute mutations show through without
    // cache invalidation.
    get dataset() {
      if (this._datasetProxy) return this._datasetProxy;
      const el = this;
      const toAttr   = (k) => 'data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      const fromAttr = (n) => n.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
      this._datasetProxy = new Proxy({}, {
        get(_t, key) {
          if (typeof key !== 'string') return undefined;
          const v = el._attrs[toAttr(key)];
          return v == null ? undefined : v;
        },
        set(_t, key, value) {
          if (typeof key !== 'string') return false;
          el.setAttribute(toAttr(key), String(value));
          return true;
        },
        deleteProperty(_t, key) {
          if (typeof key !== 'string') return false;
          el.removeAttribute(toAttr(key));
          return true;
        },
        has(_t, key) {
          return typeof key === 'string' &&
                 Object.prototype.hasOwnProperty.call(el._attrs, toAttr(key));
        },
        ownKeys() {
          return Object.keys(el._attrs).filter((n) => n.startsWith('data-')).map(fromAttr);
        },
        getOwnPropertyDescriptor(_t, key) {
          if (typeof key !== 'string') return undefined;
          const attr = toAttr(key);
          if (!Object.prototype.hasOwnProperty.call(el._attrs, attr)) return undefined;
          return { enumerable: true, configurable: true, value: el._attrs[attr] };
        }
      });
      return this._datasetProxy;
    }
    // `Element#querySelectorAll` matches against the element's
    // *descendants only* — the element itself is never returned
    // even when the selector would match it. Pass children as
    // roots, not `this`.
    querySelector(sel)    { return selectFirst(this._children, sel); }
    querySelectorAll(sel) { return selectAll(this._children,   sel); }
    matches(sel)          { return matchesSelector(this, sel); }
    closest(sel)          { return closestSelector(this, sel); }
    // Common HTMLElement / form-control IDL attributes that mirror to
    // their named attributes. jQuery 3.x's `.serialize()` filter keys
    // on `this.name` / `this.type`; without these getters the filter
    // rejects every form element (`.name` undefined → falsy → skip).
    // Mirrors HTML spec's reflection rules: read returns the attribute
    // value (or '' if absent), write goes through setAttribute so
    // MutationObserver / attributeChangedCallback see the change.
    get name()  { return this._attrs.name  != null ? this._attrs.name  : ''; }
    set name(v) { this.setAttribute('name', String(v == null ? '' : v)); }
    get type()  {
      // <input>.type defaults to 'text' when the type attr is absent
      // (spec). Other elements just reflect.
      if (this._tag === 'input') {
        const t = this._attrs.type;
        return t != null ? t.toLowerCase() : 'text';
      }
      // `<select>.type` is `'select-multiple'` when the multiple attr
      // is set, otherwise `'select-one'`. jQuery's `.val()` for a
      // select branches on this string; without the override it read
      // `''`, which doesn't equal `'select-one'`, so jQuery walked
      // every option as if multi-select and tripped over `null.value`.
      if (this._tag === 'select') {
        return this._attrs.multiple != null ? 'select-multiple' : 'select-one';
      }
      return this._attrs.type != null ? this._attrs.type : '';
    }
    set type(v) { this.setAttribute('type', String(v == null ? '' : v)); }
    // `<select>.options` / `<datalist>.options` — HTMLOptionsCollection /
    // live HTMLCollection of every `<option>` descendant. jQuery's
    // `.val()` reads it with an indexed lookup based on `selectedIndex`;
    // controllers also reach for the collection's spec mutators
    // (`add` / `remove` / `item` / `namedItem`) — Avo's
    // `city-in-country` does `options.remove(0)` per option to wipe and
    // rebuild after a country change.
    get options() {
      if (this._tag !== 'select' && this._tag !== 'datalist') return undefined;
      const arr = this.querySelectorAll('option');
      const owner = this;
      arr.add       = function (option, before) { owner.add ? owner.add(option, before) : owner.appendChild(option); };
      arr.remove    = function (idx)  { const o = arr[idx]; if (o && o._parent) o._parent.removeChild(o); };
      arr.item      = function (i)    { return arr[i] || null; };
      arr.namedItem = function (name) { return arr.find(o => o._attrs.id === name || o._attrs.name === name) || null; };
      return arr;
    }
    // HTMLSelectElement.add(option, before?) — `before` may be a
    // numeric index into the existing options or the reference
    // element itself.
    add(element, before) {
      if (this._tag !== 'select') return;
      if (before == null) this.appendChild(element);
      else if (typeof before === 'number') {
        this.insertBefore(element, this.querySelectorAll('option')[before] || null);
      } else this.insertBefore(element, before);
    }
    get title() { return this._attrs.title != null ? this._attrs.title : ''; }
    set title(v){ this.setAttribute('title', String(v == null ? '' : v)); }

    // HTMLFormElement.elements — collection of named form controls.
    // jQuery's `.serialize()` reads this; without it, serialize returns
    // empty even though the form has inputs (Redmine's context-menu
    // AJAX sends an empty query string and the server 404s). Real
    // browsers include input/select/textarea/button (and a few more);
    // returning a length-bearing array is sufficient for jQuery.
    get elements() {
      if (this._tag !== 'form') return undefined;
      const out = [];
      walkSubtree(this, el => {
        if (el === this || el.nodeType !== NODE_ELEMENT) return;
        const t = el._tag;
        if (t === 'input' || t === 'select' || t === 'textarea' ||
            t === 'button' || t === 'fieldset' || t === 'object') {
          out.push(el);
        }
      });
      out.length = out.length;
      return out;
    }
    // `HTMLButtonElement.form` (and the IDL for all form-associated
    // controls) — returns the owning form. Per spec the `form="<id>"`
    // attribute takes precedence over the ancestor `<form>`; we
    // mirror that. Redmine's settings page uses
    // `onclick="moveOptions(this.form.selected_..., this.form.
    // available_...)"` to wire up its column-mover buttons — without
    // `this.form` the onclick threw and the columns never moved.
    get form() {
      if (!FORM_ASSOCIATED_TAGS.has(this._tag)) return undefined;
      const form = formForControl(this);
      return form ? __formNamedAccess(form) : null;
    }
    // Form-control IDL attributes — expose the pair-of-attr-and-IDL
    // shape so JS like `input.value = 'x'` / `input.checked = true`
    // works and reads back via `__csimValue` / serialised attrs alike.
    get value() {
      // `<select>.value` is the value of the first selected option, or
      // (per HTML spec) the value of the first non-disabled option as
      // the default. Library handlers (Redmine's `updateIssueFrom`
      // posts `$('#issue-form').serialize()` which reads the IDL
      // value, jQuery's `.val()` falls through to this getter for
      // selects) all expect this resolution rather than `_attrs.value`.
      if (this._tag === 'select') {
        const opts = this.querySelectorAll('option');
        if (this._attrs.multiple != null) {
          const out = [];
          for (const o of opts) if (o._attrs.selected != null) {
            out.push(o._attrs.value != null ? o._attrs.value : o.textContent);
          }
          return out;
        }
        let implicit = null;
        for (const o of opts) {
          if (o._attrs.disabled != null) continue;
          if (o._attrs.selected != null) return o._attrs.value != null ? o._attrs.value : o.textContent;
          if (implicit == null) implicit = o._attrs.value != null ? o._attrs.value : o.textContent;
        }
        return implicit == null ? '' : implicit;
      }
      if (this._tag === 'textarea') {
        // HTML spec: `<textarea>.value` returns the "raw value", which
        // is the child text content minus one leading line terminator
        // (CR LF / CR / LF) — the "first newline removal" rule. After
        // a `set` / direct assignment, `_attrs.value` carries the new
        // raw value verbatim, so prefer that. Avo's KeyValueField stores
        // a JSON blob in a hidden `<textarea>` and parses it on Stimulus
        // connect — without this getter the parse runs on '' and the
        // controller's fieldValue stays empty on /show.
        if (this._attrs.value != null) return this._attrs.value;
        return __stripOneLeadingNewline(this.textContent);
      }
      return this._attrs.value != null ? this._attrs.value : '';
    }
    set value(v)   {
      if (this._tag === 'select') {
        const target = String(v == null ? '' : v);
        const opts = this.querySelectorAll('option');
        for (const o of opts) delete o._attrs.selected;
        for (const o of opts) {
          const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
          if (ov === target) { o._attrs.selected = ''; break; }
        }
        return;
      }
      this._attrs.value = String(v == null ? '' : v);
    }
    // `<option>.selected` IDL — boolean reflecting the `selected`
    // content attribute. jQuery's `.val()` over a `<select>` walks the
    // options checking each `.selected`; Redmine's onchange handlers
    // probe `option[selected]` after manual `select` calls. Without
    // the IDL getter the read returns `undefined` and the resolved
    // value comes back empty.
    get selected() {
      if (this._tag !== 'option') return false;
      return this._attrs.selected != null;
    }
    set selected(v) {
      if (this._tag !== 'option') return;
      if (v) {
        this._attrs.selected = '';
        // HTML spec: setting `selected = true` on an option in a
        // single-select select implicitly clears `selected` from the
        // other options. Redmine's `selectTracker` sets
        // `target.find('option[value="X"]').prop('selected', true)`
        // and expects the previously-selected option to no longer
        // win the `.value` resolution.
        let p = this._parent;
        while (p && p.nodeType === NODE_ELEMENT && p._tag !== 'select') p = p._parent;
        if (p && p._tag === 'select' && p._attrs.multiple == null) {
          for (const o of p.querySelectorAll('option')) {
            if (o !== this) delete o._attrs.selected;
          }
        }
      } else {
        delete this._attrs.selected;
      }
    }
    // `<select>.selectedIndex` — index of the first selected option,
    // or 0 (the default) when no option is explicitly selected.
    get selectedIndex() {
      if (this._tag !== 'select') return -1;
      const opts = this.querySelectorAll('option');
      for (let i = 0; i < opts.length; i++) {
        if (opts[i]._attrs.selected != null) return i;
      }
      return opts.length > 0 ? 0 : -1;
    }
    // `<select>.selectedOptions` — live HTMLCollection of every
    // currently-selected `<option>` descendant. Avo's
    // `multiple-select-filter` controller reads
    // `Array.from(selectorTarget.selectedOptions).map(...)` to build
    // the filter query; without this accessor the filter button click
    // throws silently and the URL never gains the `encoded_filters`
    // param.
    get selectedOptions() {
      if (this._tag !== 'select') return undefined;
      return this.querySelectorAll('option').filter(o => o._attrs.selected != null);
    }
    // Rails-UJS reads `element.href` to get an AJAX target; the raw
    // attribute would resolve against `location.href` (= current page)
    // and re-fetch the current page on every remote-link click.
    get href() { return reflectURLAttr(this, 'href', HREF_REFLECTING_TAGS); }
    set href(v) { this._attrs.href = String(v == null ? '' : v); }
    // Bundlers read `document.currentScript.src` at top level to derive
    // their public-path origin; an unresolved `/assets/…` crashes
    // auto-detection ("Automatic publicPath is not supported in this
    // browser").
    get src()  { return reflectURLAttr(this, 'src',  SRC_REFLECTING_TAGS); }
    set src(v) { this._attrs.src = String(v == null ? '' : v); }
    // `<a>` / `<area>` `download` IDL attribute — reflects the
    // `download` content attribute as a string. file-saver feature-
    // detects via `'download' in HTMLAnchorElement.prototype` to pick
    // its saveAs implementation; without this getter it falls through
    // to the popup-based fallback (`open('', '_blank')`) which throws
    // a ReferenceError, breaking Avo's action downloads.
    get download() { return this._attrs.download == null ? '' : String(this._attrs.download); }
    set download(v) { this.setAttribute('download', v == null ? '' : String(v)); }
    // `<link>` / `<a>` / `<area>` reflect the `rel` content attribute.
    // Vite's preload-helper sets `l.rel = 'stylesheet'` before
    // `head.appendChild(l)`; without the reflection the rel attribute
    // stays empty and downstream selectors / event-firing gates
    // (`maybeFireLinkLoad`'s rel check) miss the link entirely.
    get rel() { return this._attrs.rel == null ? '' : String(this._attrs.rel); }
    set rel(v) { this.setAttribute('rel', v == null ? '' : String(v)); }
    // `<canvas>.getContext('2d')` delegates to the same context
    // implementation OffscreenCanvas uses, so libraries that work
    // off a DOM canvas (e.g. image-processing widgets) get the same
    // `drawImage` / `getImageData` surface.
    getContext(type) {
      if (this._tag !== 'canvas') return null;
      if (type !== '2d' && type !== 'bitmaprenderer') return null;
      this._ctx = this._ctx || new globalThis.CanvasRenderingContext2D(this);
      return this._ctx;
    }
    // HTMLHyperlinkElementUtils mixin: `<a>` / `<area>` override
    // `toString()` to return the resolved `href`. Forem's
    // `trackNotification` reads `target.toString()` on the clicked
    // link to build an ahoy event property; without this, every
    // anchor stringifies to the default `[object Object]`.
    toString() {
      if (this._tag === 'a' || this._tag === 'area') return this.href;
      return Object.prototype.toString.call(this);
    }
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
      const m = (this._attrs.method || 'get').toLowerCase();
      return m === 'dialog' ? 'dialog' : (m === 'post' ? 'post' : 'get');
    }
    set method(v) {
      if (this._tag === 'form') this.setAttribute('method', String(v == null ? '' : v));
      else                       this._attrs.method = String(v == null ? '' : v);
    }
    get action() {
      if (this._tag !== 'form') return this._attrs.action;
      const a = this._attrs.action;
      if (a == null) return (globalThis.location && globalThis.location.href) || '';
      try {
        const base = (globalThis.location && globalThis.location.href) || null;
        const u = __csim_parseUrl(a, base);
        return u && !u.error ? u.href : a;
      } catch (_) { return a; }
    }
    set action(v)  { this.setAttribute('action', String(v == null ? '' : v)); }
    get enctype()  { return this._attrs.enctype != null ? this._attrs.enctype : 'application/x-www-form-urlencoded'; }
    set enctype(v) { this.setAttribute('enctype', String(v == null ? '' : v)); }
    get target()   { return this._attrs.target != null ? this._attrs.target : ''; }
    set target(v)  { this.setAttribute('target', String(v == null ? '' : v)); }
    // HTMLScriptElement / HTMLTitleElement / etc. expose `.text` as
    // an alias for `textContent`. stimulus-rails' `parseImportmapJson`
    // reads `script.text` to get the JSON; without this alias it
    // gets `undefined`.
    get text()     { return this.textContent; }
    set text(v)    { this.textContent = v; }
    // `<input list="<id>">` exposes the associated <datalist> via
    // `input.list`. Capybara's `select` for datalist inputs reads
    // `this.list.options` to enumerate choices.
    get list() {
      if (this._tag !== 'input') return null;
      const id = this._attrs.list;
      if (!id) return null;
      return globalThis.document && globalThis.document.getElementById(id);
    }
    get checked()  { return this._attrs.checked != null; }
    set checked(v) { if (v) this._attrs.checked = ''; else delete this._attrs.checked; }
    // Boolean IDL reflections — `el.disabled = true` mirrors to the
    // `disabled` content attribute (HTML IDL contract).
    get disabled() { return this._attrs.disabled != null; }
    set disabled(v){ if (v) this._attrs.disabled = ''; else delete this._attrs.disabled; }
    get readOnly() { return this._attrs.readonly != null; }
    set readOnly(v){ if (v) this._attrs.readonly = ''; else delete this._attrs.readonly; }
    get required() { return this._attrs.required != null; }
    set required(v){ if (v) this._attrs.required = ''; else delete this._attrs.required; }
    // Constraint validation API — partial. We compute a subset of the
    // validity flags below (enough for `:valid` / `:invalid` selectors
    // and the common Stimulus form-controller probes); the full
    // algorithm including custom validators isn't run.
    get validity() {
      // Compute the subset of HTML5 validity flags Capybara's specs
      // gate on: `valueMissing` (required + empty), `patternMismatch`
      // (pattern attr + value doesn't match), `typeMismatch`
      // (email / url with bad value), and `customError` (setCustomValidity).
      const tag  = this._tag;
      const type = (this._attrs.type || 'text').toLowerCase();
      const val  = this._attrs.value != null ? String(this._attrs.value) : '';
      const checkable = type === 'checkbox' || type === 'radio';
      const empty = checkable ? this._attrs.checked == null : val === '';
      const v = {
        valueMissing: false, typeMismatch: false, patternMismatch: false,
        tooLong: false, tooShort: false, rangeUnderflow: false,
        rangeOverflow: false, stepMismatch: false, badInput: false,
        customError: !!this._validationMessage,
        valid: true
      };
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (this._attrs.required != null && empty) v.valueMissing = true;
        if (!empty && this._attrs.pattern != null && tag === 'input') {
          try { v.patternMismatch = !(new RegExp('^(?:' + this._attrs.pattern + ')$').test(val)); }
          catch (_) {}
        }
        if (!empty && tag === 'input') {
          if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) v.typeMismatch = true;
          if (type === 'url'   && !/^[a-z]+:\/\//i.test(val))               v.typeMismatch = true;
        }
        // tooShort / tooLong fire only after a user edit; for our
        // purposes the test pre-fills via `fill_in` which counts as
        // dirty, so we always check.
        if (!empty && tag === 'input') {
          const min = parseInt(this._attrs.minlength || '', 10);
          const max = parseInt(this._attrs.maxlength || '', 10);
          if (!isNaN(min) && val.length < min) v.tooShort = true;
          if (!isNaN(max) && val.length > max) v.tooLong  = true;
        }
        if (v.valueMissing || v.patternMismatch || v.typeMismatch ||
            v.tooShort || v.tooLong || v.customError) v.valid = false;
      }
      return v;
    }
    get validationMessage() {
      if (this._validationMessage) return this._validationMessage;
      const v = this.validity;
      if (v.valid) return '';
      if (v.valueMissing)    return 'Please fill out this field.';
      if (v.typeMismatch)    return 'Please match the requested format.';
      if (v.patternMismatch) return 'Please match the requested format.';
      return '';
    }
    get willValidate()      { return false; }
    checkValidity()         { return true; }
    reportValidity()        { return true; }
    setCustomValidity(msg)  { this._validationMessage = String(msg || ''); }

    // Text-input selection — minimum HTMLInputElement / HTMLTextAreaElement
    // surface. `setSelectionRange` is called by Redmine's "reply to issue"
    // / partial-quote flow and by some libraries' "focus and select all"
    // patterns; we just store the offsets so reads of selectionStart /
    // selectionEnd are stable.
    get selectionStart() { return this._selectionStart || 0; }
    set selectionStart(v){ this._selectionStart = v | 0; }
    get selectionEnd()   { return this._selectionEnd != null ? this._selectionEnd : (this._attrs.value || '').length; }
    set selectionEnd(v)  { this._selectionEnd = v | 0; }
    get selectionDirection() { return this._selectionDirection || 'none'; }
    set selectionDirection(v){ this._selectionDirection = String(v || 'none'); }
    setSelectionRange(start, end, direction) {
      this._selectionStart     = start | 0;
      this._selectionEnd       = end   | 0;
      this._selectionDirection = direction != null ? String(direction) : 'none';
    }
    // `setRangeText(replacement, start, end, selectMode)` — HTMLSpec.
    // Replaces the text between `start` and `end` with `replacement`
    // and updates the caret per the `selectMode` argument
    // ('select' / 'start' / 'end' / 'preserve'; default 'preserve').
    // Redmine's list-autofill controller calls this with `'start'` to
    // remove a list marker when the user presses Enter on an empty
    // item; without the method the call throws and the marker stays.
    setRangeText(replacement, start, end, selectMode) {
      if (this._tag !== 'input' && this._tag !== 'textarea') return;
      const cur = this._attrs.value != null ? this._attrs.value : '';
      const len = cur.length;
      if (replacement == null) replacement = '';
      replacement = String(replacement);
      let s = start == null ? (this._selectionStart || 0) : (start | 0);
      let e = end   == null ? (this._selectionEnd   || s) : (end   | 0);
      if (s < 0) s = 0; if (e > len) e = len; if (s > e) s = e;
      const before = cur.slice(0, s);
      const after  = cur.slice(e);
      const next = before + replacement + after;
      this._attrs.value = next;
      if (this._tag === 'textarea') {
        this._children = [Object.assign(new Text(next), { _parent: this })];
      }
      const mode = selectMode == null ? 'preserve' : String(selectMode);
      const replEnd = s + replacement.length;
      if (mode === 'select') {
        this._selectionStart = s;
        this._selectionEnd   = replEnd;
      } else if (mode === 'start') {
        this._selectionStart = s;
        this._selectionEnd   = s;
      } else if (mode === 'end') {
        this._selectionStart = replEnd;
        this._selectionEnd   = replEnd;
      } else {
        // 'preserve': adjust positions to account for the length delta.
        const delta = replacement.length - (e - s);
        let ss = this._selectionStart != null ? this._selectionStart : len;
        let se = this._selectionEnd   != null ? this._selectionEnd   : len;
        if (ss > e) ss += delta; else if (ss > s) ss = replEnd;
        if (se > e) se += delta; else if (se > s) se = replEnd;
        this._selectionStart = ss;
        this._selectionEnd   = se;
      }
    }
    select() {
      this._selectionStart = 0;
      this._selectionEnd   = (this._attrs.value || '').length;
    }

    // File-input `.files` accessor. Set by `__csimSetFiles` after
    // `attach_file`; each entry is a File-shaped object with name /
    // size / type / lastModified. Libraries that iterate input.files
    // (Redmine's `uploadAndAttachFiles`, drag-drop handlers reading
    // `dataTransfer.files`) see something usable. The actual byte
    // stream isn't carried here — the multipart serialiser pulls the
    // file contents from `@file_picks` on the Ruby side at form-submit
    // time.
    get files() {
      if (this._tag !== 'input') return null;
      const t = (this._attrs.type || '').toLowerCase();
      if (t !== 'file') return null;
      const list = this._files || [];
      list.item = function (i) { return this[i] || null; };
      return list;
    }

    get innerHTML() { return serializeChildren(this); }
    set innerHTML(html) {
      // `<template>.innerHTML` setter populates the template's
      // `.content` fragment, not the template's own children (per
      // HTML spec — the inert subtree lives on the fragment).
      if (this._tag === 'template') {
        const frag = this.content;
        const tmplRemoved = frag._children.slice();
        for (const c of tmplRemoved) { c._parent = null; unregisterSubtree(c); }
        frag._children = [];
        const parsed = parseFragment(String(html == null ? '' : html));
        for (const c of parsed) {
          c._parent = frag;
          frag._children.push(c);
          registerSubtree(c);
        }
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
      const removedChildren = this._children.slice();
      for (const c of removedChildren) { c._parent = null; unregisterSubtree(c); }
      this._children = [];
      let frag;
      if (this._tag === 'html') {
        const parsed = parseDocument(String(html == null ? '' : html));
        frag = parsed.documentElement ? parsed.documentElement._children.slice() : [];
      } else {
        frag = parseFragment(String(html == null ? '' : html));
      }
      for (const c of frag) {
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
      }
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
    }
    get outerHTML() { return serializeElement(this); }
    // `insertAdjacentHTML(position, html)` — DOM spec method. Forem's
    // initializeBroadcast uses `el.insertAdjacentHTML('afterbegin', …)`
    // to inject the announcement banner. Positions: `beforebegin` /
    // `afterbegin` / `beforeend` / `afterend`.
    insertAdjacentHTML(position, html) {
      const pos  = String(position || '').toLowerCase();
      const frag = parseFragment(String(html == null ? '' : html));
      if (pos === 'beforebegin' || pos === 'afterend') {
        if (!this._parent) return;
        const ref = pos === 'beforebegin' ? this : this._children && this.nextSibling;
        for (const c of frag) this._parent.insertBefore(c, pos === 'afterend' ? this.nextSibling : this);
        return;
      }
      if (pos === 'afterbegin') {
        const first = this._children[0] || null;
        for (const c of frag) this.insertBefore(c, first);
        return;
      }
      if (pos === 'beforeend') {
        for (const c of frag) this.appendChild(c);
      }
    }
    insertAdjacentText(position, text) {
      this.insertAdjacentHTML(position, escapeText(String(text == null ? '' : text)));
    }
    insertAdjacentElement(position, element) {
      const pos = String(position || '').toLowerCase();
      if (pos === 'beforebegin' || pos === 'afterend') {
        if (!this._parent) return null;
        this._parent.insertBefore(element, pos === 'afterend' ? this.nextSibling : this);
      } else if (pos === 'afterbegin') {
        this.insertBefore(element, this._children[0] || null);
      } else if (pos === 'beforeend') {
        this.appendChild(element);
      }
      return element;
    }
    attachShadow(init) {
      if (this._shadowRoot) return this._shadowRoot;
      const mode = init && init.mode === 'closed' ? 'closed' : 'open';
      const sr = new ShadowRoot(this, mode);
      this._shadowRoot = sr;
      registerSubtree(sr);
      return sr;
    }
    get shadowRoot() {
      return this._shadowRoot && this._shadowRoot.mode === 'open' ? this._shadowRoot : null;
    }
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
      super();
      this.nodeType = NODE_FRAGMENT;
    }
    get nodeName()     { return '#document-fragment'; }
    get ownerDocument(){ return this._ownerDoc || globalThis.document; }
    get innerHTML()    { return serializeChildren(this); }
    set innerHTML(html) {
      // Spec: replacing all children must orphan the removed nodes
      // (parentNode → null) — Tagify's `input.set('')` does
      // `DOM.input.innerHTML = ''` to clear after committing a tag,
      // and our typing pipeline checks `isConnected(textNode)` to
      // decide whether to re-anchor the caret. Without clearing
      // `_parent`, the removed text node is still "connected" via
      // its dangling parent pointer and subsequent inserts go into
      // a phantom node Tagify never reads from.
      const removed = this._children.slice();
      for (const c of removed) { c._parent = null; unregisterSubtree(c); }
      this._children = [];
      const added = [];
      for (const c of parseFragment(String(html == null ? '' : html))) {
        c._parent = this;
        this._children.push(c);
        registerSubtree(c);
        added.push(c);
      }
      if (removed.length > 0 || added.length > 0) {
        recordChildList(this, added, removed);
      }
    }
    querySelector(sel)    { return selectFirst(this._children, sel); }
    querySelectorAll(sel) { return selectAll(this._children,   sel); }
    getElementById(id)    { return findById(this, id); }
    // wgxpath's descendant axis traversal probes
    // `getElementsByTagName('*')` on the context node. Inherit
    // Element's behaviour so a ShadowRoot context resolves
    // `.//*[@id=…]` against its own subtree.
    getElementsByTagName(tag) {
      const t = String(tag).toLowerCase();
      const all = t === '*' ? this.querySelectorAll('*') : this.querySelectorAll(t);
      return __htmlCollection(all.filter(n => n !== this));
    }
    getElementsByClassName(cls) {
      const sel = String(cls).split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
      return __htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
    }
  }
  globalThis.DocumentFragment = DocumentFragment;

  // ShadowRoot: a DocumentFragment that lives as a sibling tree off
  // a host Element. Same query API (`querySelector` / `getElementById`)
  // as Element; queries from outside the shadow tree don't descend in.
  class ShadowRoot extends DocumentFragment {
    constructor(host, mode) {
      super();
      this.host = host;
      this.mode = mode || 'open';
      // Shadow-tree descendants need an upward path so `isConnected`
      // and ancestor walks land back in the document. Use the host
      // as the "parent" of the shadow root itself; descendants
      // inside the shadow root have their _parent pointing inside
      // the shadow tree as usual.
      this._parent = host;
    }
    get nodeName() { return '#shadow-root'; }
  }
  globalThis.ShadowRoot = ShadowRoot;

  // HTML spec GlobalEventHandlers mixin — every Element / Document /
  // Window exposes these as own properties defaulting to null. React-DOM
  // and many libraries feature-detect via `'on<event>' in document`,
  // so they must walk the own-property table (not just the prototype
  // chain). Centralised so additions stay one-line.
  const GLOBAL_EVENT_HANDLER_ATTRS = [
    'onabort', 'onblur', 'oncancel', 'oncanplay', 'oncanplaythrough',
    'onchange', 'onclick', 'onclose', 'oncontextmenu', 'oncopy',
    'oncuechange', 'oncut', 'ondblclick', 'ondrag', 'ondragend',
    'ondragenter', 'ondragleave', 'ondragover', 'ondragstart',
    'ondrop', 'ondurationchange', 'onemptied', 'onended', 'onerror',
    'onfocus', 'oninput', 'oninvalid', 'onkeydown', 'onkeypress',
    'onkeyup', 'onload', 'onloadeddata', 'onloadedmetadata',
    'onloadstart', 'onmousedown', 'onmouseenter', 'onmouseleave',
    'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup',
    'onpaste', 'onpause', 'onplay', 'onplaying', 'onprogress',
    'onratechange', 'onreset', 'onresize', 'onscroll', 'onseeked',
    'onseeking', 'onselect', 'onstalled', 'onsubmit', 'onsuspend',
    'ontimeupdate', 'ontoggle', 'onvolumechange', 'onwaiting',
    'onwheel'
  ];

  class Document extends Node {
    // No window-manager → always treat the document as visible + focused.
    // Apps that gate work on these (Mastodon's scroll context, Vue's
    // hidden-tab pause, etc.) get the steady-state "user is here" branch.
    get visibilityState() { return 'visible'; }
    get hidden()          { return false; }
    hasFocus()            { return true;  }
    // Currently-executing `<script>` element (set by `runInlineScripts`
    // around `__csim_runScript`). Bundlers read `currentScript.src` to
    // derive the public-path origin.
    get currentScript() { return this._currentScript || null; }
    // Standards-mode viewport scroll root. Scroll-aware libs read
    // `scrollingElement.scrollLeft` during route transitions; undefined
    // here throws and aborts the transition.
    get scrollingElement() { return this.documentElement || null; }

    constructor() {
      super();
      this.nodeType   = NODE_DOC;
      // Start in 'loading' so library IIFEs (jQuery 3.x sniffs
      // `document.readyState === 'complete'` and self-schedules
      // `jQuery.ready` via setTimeout) register a DOMContentLoaded
      // listener instead of side-effecting onto the virtual clock.
      // Each per-visit `__csimLoadDocument` flips us to 'complete'
      // *after* the new body is in place, then dispatches
      // DOMContentLoaded so the queued ready cbs fire against the
      // fresh body.
      this.readyState = 'loading';
      // Pre-populate an empty html/head/body skeleton. jQuery 3.x's
      // feature-detection code captures `documentElement` at IIFE
      // evaluation time and dereferences it later (e.g.
      // `T.createElement('fieldset')` inside a `$` support probe).
      // Without a valid skeleton in the snapshot, the captured `T`
      // is null/undefined and the IIFE throws before `window.jQuery`
      // gets assigned. The per-visit `__csimLoadDocument` swaps
      // this skeleton out for the parsed-from-HTML tree.
      const html = new Element('html');
      const head = new Element('head');
      const body = new Element('body');
      html._parent = this;     this._children.push(html);
      head._parent = html;     html._children.push(head);
      body._parent = html;     html._children.push(body);
      this.documentElement = html;
      // GlobalEventHandlers IDL attributes — present on every
      // EventTarget per the HTML spec, default to null. React-DOM's
      // input-change-event polyfill probes `'oninput' in document` to
      // decide between modern onChange and IE9-style onpropertychange;
      // without these slots React falls through to the legacy path
      // and crashes calling `element.attachEvent` (IE-only).
      // Written as own properties (not defineProperty on the
      // prototype) so the `in` operator's own-property walk sees
      // them.
      for (const name of GLOBAL_EVENT_HANDLER_ATTRS) this[name] = null;
    }
    // jQuery's `mc(node)` helper resolves a node back to its window
    // via `doc.defaultView || doc.parentWindow`; without these the
    // offset / scroll path throws "Cannot read properties of
    // undefined (reading 'pageYOffset')".
    get defaultView()   { return globalThis; }
    get parentWindow()  { return globalThis; }
    // HTML spec `Document.location` aliases `window.location`. Forem's
    // searchParams.js reads `document.location.search`; without this
    // getter the call hits `undefined.search` and the whole bundle's
    // top-level module init aborts before the search-feed fetch fires.
    get location()      { return globalThis.location; }
    // DOM spec URL accessors — all return the document's URL string.
    // Honeybadger's XHR breadcrumb instrumentation calls
    // `parseURL(document.URL)` to decide same-origin; without `URL`
    // the parser is fed `undefined`, throws on `.match`, and the
    // entire XHR open path that triggered the breadcrumb aborts
    // (which on Forem's top-bar is the `/notifications/counts`
    // request that populates the notification badge).
    get URL()           { return (globalThis.location && globalThis.location.href) || ''; }
    get documentURI()   { return this.URL; }
    get baseURI()       { return this.URL; }
    // `document.cookie` IDL — getter returns the serialised cookie
    // jar, setter parses a single `name=value; flags…` line. The Ruby
    // host fns (`__getDocumentCookie` / `__setDocumentCookie`) own
    // the storage; Browser-side cookies survive ctx rebuilds.
    get cookie()        { return __getDocumentCookie() || ''; }
    set cookie(v)       { __setDocumentCookie(String(v == null ? '' : v)); }
    // Public accessor over the internal `_activeElement` slot that the
    // Element focus/blur methods write to. Returns the document's
    // body as a sentinel when no element is focused, matching real
    // browsers (HTMLBodyElement is the fallback `activeElement` per
    // the HTML spec, and libraries occasionally test for non-null
    // before reading properties).
    get activeElement() {
      return this._activeElement || this.body || null;
    }
    // PM (and other libs) call `view.root.getSelection()` where
    // `view.root` is the document — `globalThis.getSelection` exists
    // but `document.getSelection` was missing, throwing
    // "Cannot read properties of undefined (reading 'getSelection')"
    // inside `domSelectionRange()`. Per the Selection API spec
    // `document.getSelection()` is a synonym for window.getSelection().
    getSelection() { return globalThis.getSelection ? globalThis.getSelection() : null; }
    createElement(tag) {
      const t = String(tag).toLowerCase();
      const ctor = getCustomElementCtor(t);
      if (ctor) {
        const prev = __currentTag;
        __currentTag = t;
        try { return new ctor(); } finally { __currentTag = prev; }
      }
      return new Element(t);
    }
    // `createElementNS(ns, tag)` per DOM spec. Preact's `z` function
    // takes this path for any SVG tag (it checks the SVG-namespace
    // flag and routes through createElementNS). Without it, Forem's
    // Preact-rendered editor — which uses inline SVG icons via
    // crayons_icon_tag — throws during diff and the whole component
    // tree fails to mount. We ignore the namespace argument since
    // we don't track SVG vs HTML namespaces (no layout engine to
    // care about the distinction); the tag-only fallback works
    // because matcher / cascade / event-dispatch paths don't
    // discriminate by ns either.
    createElementNS(_ns, tag) { return this.createElement(tag); }
    createTextNode(data)   { return new Text(data); }
    createComment(data)    { return new Comment(String(data == null ? '' : data)); }
    get body() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === 'body') return c;
      }
      return null;
    }
    get head() {
      const html = this.documentElement;
      if (!html) return null;
      for (const c of html._children) {
        if (c._tag === 'head') return c;
      }
      return null;
    }
    get title() {
      const head = this.head;
      const title = head && head.querySelector('title');
      return title ? title.textContent : '';
    }
    // Per HTML spec, `document.referrer` is always a string — empty for
    // a top-level navigation with no referrer. Tracking libraries
    // (Ahoy / Honeybadger) read `document.referrer.length` during their
    // setTimeout-scheduled init; without this getter the read returns
    // `undefined`, throws, and the timer's downstream side effects
    // (visit registration, follow-up render scheduling) never happen.
    get referrer() { return ''; }
    set title(v) {
      let head = this.head;
      if (!head) {
        head = new Element('head');
        head._parent = this.documentElement;
        this.documentElement._children.unshift(head);
        registerSubtree(head);
      }
      let title = head.querySelector('title');
      if (!title) {
        title = new Element('title');
        title._parent = head;
        head._children.push(title);
        registerSubtree(title);
      }
      title.textContent = String(v == null ? '' : v);
    }
    getElementById(id) {
      return findById(this.documentElement, id);
    }
    // Spec: `Document#querySelector` matches against the entire
    // document tree — documentElement itself IS a valid match. Use
    // documentElement as a root (not its children) so e.g.
    // `document.querySelector('html')` returns the html element.
    querySelector(sel)    { return this.documentElement ? selectFirst([this.documentElement], sel) : null; }
    querySelectorAll(sel) { return this.documentElement ? selectAll([this.documentElement],   sel) : []; }
    // wgxpath optimizes `descendant::name` and `descendant::*` against
    // Document-rooted queries via getElementsByTagName. Without these
    // shims the descendant axis returns empty from a Document context.
    // Per DOM spec these include self when called on Document (the
    // documentElement IS a descendant of Document), so `//html`
    // matching documentElement is a hard requirement Capybara relies
    // on for `find(:css, 'html')` and `match_selector('html')`.
    getElementsByTagName(tag) {
      const root = this.documentElement;
      if (!root) return [];
      const want = String(tag).toLowerCase();
      const out  = want === '*' || root._tag === want ? [root] : [];
      const tail = root.getElementsByTagName(tag);
      for (let i = 0; i < tail.length; i++) out.push(tail[i]);
      return out;
    }
    getElementsByClassName(cls) {
      const root = this.documentElement;
      if (!root) return [];
      const classes = String(cls).split(/\s+/).filter(Boolean);
      const has = (el) => classes.every(c => (el.classList && el.classList.contains(c)));
      const out  = has(root) ? [root] : [];
      const tail = root.getElementsByClassName(cls);
      for (let i = 0; i < tail.length; i++) out.push(tail[i]);
      return out;
    }
    getElementsByName(name) {
      return this.documentElement ? this.documentElement.getElementsByName(name) : [];
    }
    // DocumentFragment — a lightweight node container with no parent
    // identity in the document. jQuery (and similar libraries) build
    // off-document subtrees in fragments before splicing them into
    // the live tree via `appendChild`. We give it just enough surface
    // for `appendChild` / `childNodes` to work.
    createDocumentFragment() {
      return new DocumentFragment();
    }
    // `Document.createEvent(interfaceName)` — legacy DOM Level 2 API
    // still used by libraries that target older browsers (Trix's
    // `triggerEvent` builds `document.createEvent("Event")` /
    // `event.initEvent(...)` so it works without `new Event()`
    // support detection). The returned event needs `initEvent` /
    // `initCustomEvent` mutators per the spec.
    createEvent(interfaceName) {
      const name = String(interfaceName || '').toLowerCase();
      const Ctor = (name === 'customevent' || name === 'customevents')
        ? globalThis.CustomEvent
        : globalThis.Event;
      const ev = new Ctor('', { bubbles: false, cancelable: false });
      ev.initEvent = function (type, bubbles, cancelable) {
        ev.type = String(type || '');
        ev.bubbles = !!bubbles;
        ev.cancelable = !!cancelable;
      };
      ev.initCustomEvent = function (type, bubbles, cancelable, detail) {
        ev.type = String(type || '');
        ev.bubbles = !!bubbles;
        ev.cancelable = !!cancelable;
        ev.detail = detail;
      };
      return ev;
    }
    // `Document.importNode(node, deep)` — clone of `node` adopted into
    // this document. We only have one document at a time, so this is
    // an alias for `cloneNode(deep)`. Turbo Drive's
    // `importStreamElements` uses `document.importNode(streamElement,
    // true)` to graft turbo-stream fragments into the live tree.
    importNode(node, deep) {
      if (!node || typeof node.cloneNode !== 'function') return null;
      const out = node.cloneNode(!!deep);
      // Per HTML spec, elements in `<template>.content` are inert and
      // NOT upgraded by the customElements registry. When moved into
      // the destination document via `importNode`, they should be
      // upgraded if their tag is registered. Turbo's
      // `importStreamElements` does `document.importNode(turboStream,
      // true)` and immediately accesses `streamElement.templateElement
      // .content` — that getter only exists on the upgraded
      // `StreamElement` prototype, so without the upgrade here we'd
      // throw "Cannot read property 'content' of undefined" and the
      // form submit's turbo-stream response would never render.
      ceUpgradeTree(out);
      return out;
    }
    adoptNode(node) {
      if (!node) return null;
      if (node._parent && typeof node._parent.removeChild === 'function') {
        try { node._parent.removeChild(node); } catch (_) {}
      }
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
      walkSubtree(node, n => { n._ownerDoc = dest; });
      return node;
    }
    // `document.implementation.createHTMLDocument(title)` — DOMParser
    // shims and Turbo Drive page-snapshot logic both probe it. We
    // return a fresh Document with a minimal `<html><head><title>X</title>
    // </head><body></body></html>` skeleton; full HTML-spec
    // construction (DOCTYPE / quirks-mode flag) is out of scope.
    get implementation() {
      return {
        createHTMLDocument: (title) => {
          const d = new Document();
          const html = new Element('html');
          const head = new Element('head');
          const body = new Element('body');
          html._children = [head, body];
          head._parent = html; body._parent = html;
          d.documentElement = html;
          html._parent = d;
          d._children = [html];
          if (title != null) {
            const t = new Element('title');
            t._children = [Object.assign(new Text(String(title)), { _parent: t })];
            t._parent = head;
            head._children.push(t);
          }
          return d;
        },
        hasFeature: () => true
      };
    }

    // Minimal Range stub. wgxpath uses `document.createRange()` +
    // `compareBoundaryPoints` to sort XPath result sets into document
    // order. We don't model partial-range selection (start/end offsets
    // on text nodes etc.); only document-order comparison between two
    // nodes' start containers, which is the only thing wgxpath drives.
    createRange() { return new DocumentOrderRange(); }
    // Minimal NodeIterator. DOMPurify is the canonical consumer —
    // it walks a freshly-parsed sanitisation fragment via
    // `nextNode()` and uses `whatToShow` to gate ELEMENT / TEXT /
    // COMMENT visits. We pre-collect descendants in document order;
    // DOMPurify operates on small per-call fragments so the up-front
    // walk is cheaper than the per-step sibling/ancestor traversal.
    createNodeIterator(root, whatToShow, filter) {
      if (whatToShow == null) whatToShow = 0xFFFFFFFF;
      const all = [];
      walkSubtree(root, n => all.push(n));
      let i = -1;
      return {
        root,
        whatToShow,
        filter,
        referenceNode: root,
        pointerBeforeReferenceNode: true,
        nextNode() {
          while (++i < all.length) {
            const n = all[i];
            const mask = 1 << (n.nodeType - 1);
            if (!(mask & whatToShow)) continue;
            if (filter) {
              const fn = typeof filter === 'function' ? filter : (filter && filter.acceptNode);
              if (fn) {
                const r = fn.call(filter || null, n);
                // NodeFilter spec: FILTER_REJECT (2) / FILTER_SKIP (3)
                // exclude. Predicate-style filters (`n => boolean`)
                // also use `false` to reject; coerce so both calling
                // conventions work.
                if (r === 2 || r === 3 || r === false) continue;
              }
            }
            this.referenceNode = n;
            this.pointerBeforeReferenceNode = false;
            return n;
          }
          return null;
        },
        previousNode() { return null; },
        detach() {}
      };
    }
    // `Document.createTreeWalker(root, whatToShow, filter)` — Trix
    // builds one to traverse the editable subtree by nodeType (its
    // `walkTree` helper passes `SHOW_ELEMENT` / `SHOW_TEXT` /
    // `SHOW_COMMENT`). We pre-walk descendants in document order and
    // serve `nextNode` / sibling navigation off the buffer; Trix only
    // uses `nextNode()` and `currentNode` so the rest of the
    // TreeWalker surface (`firstChild` / `nextSibling` / etc.) is a
    // light shim.
    createTreeWalker(root, whatToShow, filter) {
      if (whatToShow == null) whatToShow = 0xFFFFFFFF;
      const all = [];
      walkSubtree(root, n => all.push(n));
      const accept = (n) => {
        if (!n) return 2;
        const mask = 1 << (n.nodeType - 1);
        if (!(mask & whatToShow)) return 3; // skip
        if (filter) {
          const fn = typeof filter === 'function' ? filter : (filter && filter.acceptNode);
          if (fn) return fn.call(filter || null, n);
        }
        return 1;
      };
      const tw = {
        root,
        whatToShow,
        filter,
        currentNode: root,
        nextNode() {
          const i = all.indexOf(this.currentNode);
          for (let j = i + 1; j < all.length; j++) {
            if (accept(all[j]) === 1) { this.currentNode = all[j]; return all[j]; }
          }
          return null;
        },
        previousNode() {
          const i = all.indexOf(this.currentNode);
          for (let j = i - 1; j >= 0; j--) {
            if (accept(all[j]) === 1) { this.currentNode = all[j]; return all[j]; }
          }
          return null;
        },
        parentNode() {
          let p = this.currentNode && this.currentNode._parent;
          while (p && p !== root && accept(p) !== 1) p = p._parent;
          if (p && p !== root) { this.currentNode = p; return p; }
          return null;
        },
        firstChild() {
          const c = this.currentNode && this.currentNode._children;
          if (c) for (const k of c) if (accept(k) === 1) { this.currentNode = k; return k; }
          return null;
        },
        lastChild() {
          const c = this.currentNode && this.currentNode._children;
          if (c) for (let i = c.length - 1; i >= 0; i--) if (accept(c[i]) === 1) { this.currentNode = c[i]; return c[i]; }
          return null;
        },
        nextSibling() {
          const p = this.currentNode && this.currentNode._parent;
          const c = p && p._children;
          if (!c) return null;
          const i = c.indexOf(this.currentNode);
          for (let j = i + 1; j < c.length; j++) if (accept(c[j]) === 1) { this.currentNode = c[j]; return c[j]; }
          return null;
        },
        previousSibling() {
          const p = this.currentNode && this.currentNode._parent;
          const c = p && p._children;
          if (!c) return null;
          const i = c.indexOf(this.currentNode);
          for (let j = i - 1; j >= 0; j--) if (accept(c[j]) === 1) { this.currentNode = c[j]; return c[j]; }
          return null;
        }
      };
      return tw;
    }
  }
  class DocumentOrderRange {
    constructor() {
      this.startContainer = null;
      this.startOffset    = 0;
      this.endContainer   = null;
      this.endOffset      = 0;
    }
    setStart(node, offset)  { this.startContainer = node; this.startOffset = offset | 0; }
    setEnd(node, offset)    { this.endContainer   = node; this.endOffset   = offset | 0; }
    // Boundary helpers — node-relative variants of setStart / setEnd.
    // `setStartBefore(n)` puts the range start at (n.parentNode,
    // indexOf(n)); `setStartAfter` adds 1; ditto for end. Per HTML
    // spec — the offset is the position of `n` among its parent's
    // children. The old "offset=0" approximation broke partial-quote
    // tests where the range was supposed to skip past leading
    // siblings, and quote-reply's cloneContents walked from the
    // wrong start position.
    setStartBefore(node) {
      const p = node && node._parent;
      this.startContainer = p || node;
      this.startOffset    = p ? p._children.indexOf(node) : 0;
    }
    setStartAfter(node)  {
      const p = node && node._parent;
      this.startContainer = p || node;
      this.startOffset    = p ? (p._children.indexOf(node) + 1) : 0;
    }
    setEndBefore(node)   {
      const p = node && node._parent;
      this.endContainer   = p || node;
      this.endOffset      = p ? p._children.indexOf(node) : 0;
    }
    setEndAfter(node)    {
      const p = node && node._parent;
      this.endContainer   = p || node;
      this.endOffset      = p ? (p._children.indexOf(node) + 1) : 0;
    }
    // Real DOM: selectNode sets the range to span the given node
    // *within* its parent. Collapse moves both endpoints to one side.
    // wgxpath only cares that the start container ends up referring to
    // the node we passed.
    selectNode(node) {
      this.startContainer = this.endContainer = node;
      this.startOffset    = this.endOffset    = 0;
    }
    selectNodeContents(node) {
      this.startContainer = this.endContainer = node;
      this.startOffset    = 0;
      // For a Text node, the upper bound is the character length;
      // for elements, the number of child nodes.
      this.endOffset = node.nodeType === NODE_TEXT
        ? (node.data || '').length
        : (node._children ? node._children.length : 0);
    }
    // `Range.intersectsNode(node)` — true if any part of node overlaps
    // the range. quote-reply uses this to find which of the
    // window.getSelection() ranges intersects the issue description.
    intersectsNode(node) {
      return rangeIntersectsNode(this, node);
    }
    // `Range.cloneContents()` — returns a DocumentFragment cloned from
    // the range. quote-reply walks the fragment's textContent / HTML
    // to build the quoted reply. The full DOM spec algorithm is
    // intricate (partial container splits, text-node boundary
    // handling, …); we implement the common-case subset that Redmine's
    // partial-quote tests exercise.
    cloneContents() {
      return cloneRangeContents(this);
    }
    extractContents() {
      // Spec: removes the range's contents from the tree AND returns
      // them as a DocumentFragment. Turbo's `FrameRenderer.renderElement`
      // uses this to MOVE children out of the parsed `<turbo-frame>`
      // into the live frame (`currentElement.appendChild(sourceRange.
      // extractContents())`); a clone-only impl loses the move
      // semantics — `appendChild` would then re-parent each clone but
      // leave the originals orphaned, and the frame's live content
      // stays empty.
      const frag = cloneRangeContents(this);
      deleteRangeContents(this);
      return frag;
    }
    // Spec: removes everything inside the range from its container.
    // Turbo's `FrameRenderer` calls `selectNodeContents(currentElement);
    // deleteContents()` to clear the lazy frame's loading placeholder
    // before grafting the response's frame content. Without this the
    // placeholder stays in place and the comment list never appears.
    deleteContents() {
      deleteRangeContents(this);
    }
    collapse(toStart) {
      if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
      else         { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    }
    // Range.getClientRects / getBoundingClientRect — return the
    // geometry of each rendered fragment covered by the range. PM's
    // domchange `singleRect` calls `textRange(child, 0, len).
    // getClientRects()` to measure changed text nodes. Layout-free,
    // so we return zero-rect stubs (matches Element's geometry stubs).
    getClientRects() { return []; }
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    cloneRange() {
      const r = new DocumentOrderRange();
      r.startContainer = this.startContainer; r.startOffset = this.startOffset;
      r.endContainer   = this.endContainer;   r.endOffset   = this.endOffset;
      return r;
    }
    toString() {
      // Best-effort: emit textContent of the start container when the
      // range collapses to a single element; otherwise empty. Partial-
      // quote tests reach here but the apps under test typically guard
      // on `selection.toString().length > 0`, so emitting empty mirrors
      // the "no selection" state cleanly.
      return '';
    }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() {
      if (!this.startContainer) return null;
      if (this.startContainer === this.endContainer) return this.startContainer;
      // Find LCA via ancestorChain.
      const a = ancestorChain(this.startContainer);
      const b = ancestorChain(this.endContainer);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i > 0 ? a[i - 1] : this.startContainer;
    }
    compareBoundaryPoints(_how, other) {
      return compareDocOrder(this.startContainer, other.startContainer);
    }
  }
  // Range boundary-comparison constants. wgxpath reads them off the
  // range instance via `range.START_TO_END` so they have to live on
  // the prototype (not just the constructor).
  DocumentOrderRange.START_TO_START = 0;
  DocumentOrderRange.START_TO_END   = 1;
  DocumentOrderRange.END_TO_END     = 2;

  // Helper: is `descendant` either equal to or contained in `ancestor`?
  function nodeContains(ancestor, descendant) {
    return ancestor != null && ancestor.contains ? ancestor.contains(descendant) : false;
  }
  // Tags whose IDL exposes `.form` to point at the owning HTMLFormElement.
  const FORM_ASSOCIATED_TAGS = new Set([
    'input', 'select', 'textarea', 'button', 'fieldset', 'object', 'output'
  ]);
  // HTML spec "first newline removal" for textarea contents: a single
  // leading line terminator (CR LF / CR / LF) that immediately follows
  // the open tag is dropped from the IDL value. Same rule applies to
  // the form-submission serialization.
  function __stripOneLeadingNewline (s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    if (s.length >= 2 && s.charCodeAt(0) === 13 && s.charCodeAt(1) === 10) return s.slice(2);
    if (s.charCodeAt(0) === 13 || s.charCodeAt(0) === 10) return s.slice(1);
    return s;
  }
  // True if `range` overlaps with `node` (the node is partially or
  // fully covered by the range). The DOM-spec algorithm is "node and
  // range share at least one boundary point or one is inside the
  // other"; we implement a conservative subset that handles the
  // single-Text-node and within-an-element cases the partial-quote
  // tests use.
  function rangeIntersectsNode(range, node) {
    if (!range.startContainer) return false;
    if (nodeContains(node, range.startContainer)) return true;
    if (nodeContains(node, range.endContainer))   return true;
    if (nodeContains(range.startContainer, node) && nodeContains(range.endContainer, node)) return true;
    // Document-order overlap: node sits between start and end at the
    // same tree level.
    const s = compareDocOrder(range.startContainer, node);
    const e = compareDocOrder(range.endContainer,   node);
    if (s <= 0 && e >= 0) return true;
    return false;
  }
  // Clone the content covered by `range` into a DocumentFragment.
  // Spec-compliant.
  //
  // The recursive shape: each call to __cloneSlice clones one subtree
  // bounded by two optional cuts. A null cut means "no boundary on
  // this side" (clone from the start, or to the end). If a cut's
  // container is the subtree itself, slice by offset directly; if
  // it's a descendant, recurse into the ancestor-child that contains
  // it with a tighter cut. Text-node subtrees slice by character
  // offset; Element subtrees slice by child index.
  function __rangeAncestorChild (ancestor, descendant) {
    let cur = descendant;
    while (cur && cur._parent && cur._parent !== ancestor) cur = cur._parent;
    return cur && cur._parent === ancestor ? cur : null;
  }
  function __appendCloned (parent, child) {
    child._parent = parent;
    parent._children.push(child);
  }
  // Emit (into `target`) the slice of `subtree` between the cuts.
  // `target` is usually a shell clone of `subtree`, but cloneRangeContents
  // passes its top-level DocumentFragment for the common-ancestor walk.
  function __emitSlice (target, subtree, startCut, endCut) {
    const kids = subtree._children || [];
    let startIdx = 0, startChild = null;
    if (startCut) {
      if (startCut.container === subtree) {
        startIdx = startCut.offset;
      } else {
        startChild = __rangeAncestorChild(subtree, startCut.container);
        if (startChild) startIdx = kids.indexOf(startChild) + 1;
      }
    }
    let endIdx = kids.length, endChild = null;
    if (endCut) {
      if (endCut.container === subtree) {
        endIdx = endCut.offset;
      } else {
        endChild = __rangeAncestorChild(subtree, endCut.container);
        if (endChild) endIdx = kids.indexOf(endChild);
      }
    }
    if (startChild && startChild === endChild) {
      __appendCloned(target, __cloneSlice(startChild, startCut, endCut));
      return;
    }
    if (startChild) __appendCloned(target, __cloneSlice(startChild, startCut, null));
    for (let i = startIdx; i < endIdx; i++) {
      if (kids[i]) __appendCloned(target, kids[i].cloneNode(true));
    }
    if (endChild) __appendCloned(target, __cloneSlice(endChild, null, endCut));
  }
  function __cloneSlice (subtree, startCut, endCut) {
    if (subtree.nodeType === NODE_TEXT) {
      const data = subtree.data || '';
      const lo = startCut && startCut.container === subtree ? startCut.offset : 0;
      const hi = endCut   && endCut.container === subtree   ? endCut.offset   : data.length;
      return new Text(data.slice(lo, hi));
    }
    const shell = subtree.cloneNode(false);
    __emitSlice(shell, subtree, startCut, endCut);
    return shell;
  }
  // Spec-best-effort removal: for `selectNodeContents`-style ranges
  // (both endpoints on the same element container) remove the
  // children inside the range and collapse it. Cross-container
  // ranges are no-op'd; nothing in the app workloads we run reaches
  // for delete on a non-trivial selection.
  // Spec's "insert text" default action for `beforeinput insertText`:
  // delete the current selection's content (if non-collapsed) then
  // insert `text` at the cursor, updating the selection to live at
  // the end of the inserted text. PM/Trix/Tiptap's beforeinput
  // handler does this internally and `preventDefault`s; for editors
  // that don't intercept (plain contenteditable, Lexical's idle
  // path, …) we run the browser-default-equivalent so the typed
  // text actually lands. Coalesces text into the adjacent text node
  // when possible (matches what real browsers do — they don't create
  // a fresh text node per character).
  function __csimInsertTextAtSelection(text) {
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (!sel || !sel._ranges.length) return false;
    let range = sel._ranges[0];
    let sc = range.startContainer;
    try { (globalThis.__csim_inserts = globalThis.__csim_inserts || []).push({ text, sc_tag: sc && (sc._tag || sc.nodeName), sc_data: sc && sc.nodeType === 3 ? (sc._data||'').slice(0, 20) : null, connected: sc && isConnected(sc) }); } catch (_) {}
    // The previous keystroke's commit-handler (Tagify on `,`, Trix on
    // <Enter>, etc.) may have detached the text node our cursor was
    // pointing at. Re-anchor to the active contenteditable when the
    // current container is no longer attached — without this the
    // subsequent chars splice into a phantom node that's no longer
    // in the DOM and the editor never sees the rest of the typing.
    if (sc && !isConnected(sc)) {
      const doc = globalThis.document;
      const active = doc && doc.activeElement;
      if (active && active.nodeType === NODE_ELEMENT && isContenteditable(active)) {
        // Walk into the deepest non-void leaf, position at end.
        const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'meta', 'link']);
        let leaf = active;
        while (leaf._children && leaf._children.length > 0) {
          const next = leaf._children.find(c =>
            c.nodeType === NODE_ELEMENT && !VOID_TAGS.has(c._tag)
          );
          if (!next) break;
          leaf = next;
        }
        sel.collapse(leaf, leaf._children ? leaf._children.length : 0);
        range = sel._ranges[0];
        sc = range.startContainer;
      } else {
        return false;
      }
    }
    if (!range.collapsed) deleteRangeContents(range);

    const so = range.startOffset | 0;
    if (!sc) return false;

    // Case 1: cursor is inside a Text node → splice the chars in.
    if (sc.nodeType === NODE_TEXT) {
      const before = sc._data.slice(0, so);
      const after  = sc._data.slice(so);
      sc.data = before + text + after;
      const newPos = so + text.length;
      range.startContainer = sc;
      range.endContainer   = sc;
      range.startOffset    = newPos;
      range.endOffset      = newPos;
      __notifySelectionChange();
      return true;
    }

    // Case 2: cursor is in an element. Try to extend a neighbour text
    // node (real browsers prefer this — they keep contiguous runs in
    // one text node); only create a new node when neither neighbour
    // is text.
    const children = sc._children || [];
    const prevNode = children[so - 1];
    const atNode   = children[so];
    if (prevNode && prevNode.nodeType === NODE_TEXT) {
      const oldLen = prevNode._data.length;
      prevNode.data = prevNode._data + text;
      range.startContainer = prevNode;
      range.endContainer   = prevNode;
      range.startOffset    = oldLen + text.length;
      range.endOffset      = range.startOffset;
    } else if (atNode && atNode.nodeType === NODE_TEXT) {
      atNode.data = text + atNode._data;
      range.startContainer = atNode;
      range.endContainer   = atNode;
      range.startOffset    = text.length;
      range.endOffset      = range.startOffset;
    } else {
      const t = new Text(text);
      if (atNode) sc.insertBefore(t, atNode);
      else        sc.appendChild(t);
      range.startContainer = t;
      range.endContainer   = t;
      range.startOffset    = text.length;
      range.endOffset      = range.startOffset;
    }
    __notifySelectionChange();
    return true;
  }
  globalThis.__csimInsertTextAtSelection = __csimInsertTextAtSelection;

  function deleteRangeContents (range) {
    const sc = range.startContainer, so = range.startOffset | 0;
    const ec = range.endContainer,   eo = range.endOffset | 0;
    if (sc === ec && sc && sc._children) {
      const end = Math.min(eo, sc._children.length);
      for (let i = end - 1; i >= so; i--) {
        const child = sc._children[i];
        if (child) sc.removeChild(child);
      }
      range.endOffset = range.startOffset;
      range.endContainer = range.startContainer;
    } else if (sc === ec && sc && sc.nodeType === NODE_TEXT) {
      const data = sc.data || '';
      sc.data = data.slice(0, so) + data.slice(eo);
      range.endOffset = range.startOffset;
    }
  }
  function cloneRangeContents (range) {
    const frag = new DocumentFragment();
    if (!range.startContainer || !range.endContainer) return frag;
    const sc = range.startContainer, so = range.startOffset;
    const ec = range.endContainer,   eo = range.endOffset;
    if (sc === ec) {
      if (sc.nodeType === NODE_TEXT) {
        __appendCloned(frag, new Text((sc.data || '').slice(so, eo)));
      } else if (sc._children) {
        for (let i = so; i < Math.min(eo, sc._children.length); i++) {
          __appendCloned(frag, sc._children[i].cloneNode(true));
        }
      }
      return frag;
    }
    const ancestor = range.commonAncestorContainer;
    if (ancestor) {
      __emitSlice(frag, ancestor, {container: sc, offset: so}, {container: ec, offset: eo});
    }
    return frag;
  }
  DocumentOrderRange.END_TO_START   = 3;
  DocumentOrderRange.prototype.START_TO_START = 0;
  DocumentOrderRange.prototype.START_TO_END   = 1;
  DocumentOrderRange.prototype.END_TO_END     = 2;
  DocumentOrderRange.prototype.END_TO_START   = 3;
  globalThis.Range = DocumentOrderRange;
  function compareDocOrder(a, b) {
    if (a === b) return 0;
    const chainA = ancestorChain(a), chainB = ancestorChain(b);
    let i = 0;
    while (i < chainA.length && i < chainB.length && chainA[i] === chainB[i]) i++;
    if (i === 0) return 0; // disconnected — treat as equal
    const lca = chainA[i - 1];
    // If one node is an ancestor of the other, ancestor comes first.
    if (i === chainA.length) return -1;
    if (i === chainB.length) return  1;
    const idxA = lca._children.indexOf(chainA[i]);
    const idxB = lca._children.indexOf(chainB[i]);
    return idxA < idxB ? -1 : (idxA > idxB ? 1 : 0);
  }
  function ancestorChain(node) {
    const chain = [];
    let cur = node;
    while (cur) { chain.unshift(cur); cur = cur._parent; }
    return chain;
  }


  // Lightweight CSSStyleDeclaration proxy backed by `style="..."`.
  // `cssText` is the round-trip serialization; individual property
  // access (e.g. `style.display = 'none'`) parses / rebuilds the
  // declaration string in place. jQuery 1.x sets `style.cssText`
  // during feature detection, so the proxy has to at least support
  // round-trip without throwing.
  function makeStyleProxy(el) {
    // A Proxy that intercepts both camelCase IDL property access
    // (`style.backgroundColor`) and kebab-case (`style['background-color']`).
    // Reads parse the `style="..."` attribute; writes update it.
    // Frameworks that probe arbitrary CSS properties (jQuery UI's
    // `p.style.backgroundColor.indexOf("rgba")`) now get a string
    // back instead of `undefined`.
    // Proxy target is an object so `typeof el.style === 'object'`.
    // The original `function(){}` target made it `'function'`, which
    // broke jQuery 3.x's `isHiddenWithinTree` (reads
    // `elem.style.display` after a typeof check — when `elem.style`
    // is a function jQuery skipped the inline-style branch and
    // toggle() routed to the wrong direction).
    const target = {};
    const handler = {
      get(_t, prop) {
        if (prop === 'cssText') return el._attrs.style || '';
        if (prop === 'getPropertyValue') return name => readCssProp(el, String(name));
        if (prop === 'setProperty')      return (n, v) => writeCssProp(el, String(n), String(v));
        if (prop === 'removeProperty')   return name => removeCssProp(el, String(name));
        if (prop === 'length') return Object.keys(parseStyleDecls(el._attrs.style || '')).length;
        if (typeof prop !== 'string') return undefined;
        // camelCase → kebab-case lookup
        return readCssProp(el, camelToKebab(prop));
      },
      set(_t, prop, value) {
        if (prop === 'cssText') {
          el.setAttribute('style', String(value == null ? '' : value));
          return true;
        }
        if (typeof prop === 'string') {
          writeCssProp(el, camelToKebab(prop), String(value));
        }
        return true;
      },
      has(_t, prop) {
        if (prop === 'cssText' || prop === 'getPropertyValue' ||
            prop === 'setProperty' || prop === 'removeProperty' || prop === 'length') return true;
        return readCssProp(el, camelToKebab(String(prop))) !== '';
      }
    };
    return new Proxy(target, handler);
  }
  function camelToKebab(name) {
    return name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function readCssProp(el, name) {
    const decls = parseStyleDecls(el._attrs.style || '');
    return decls[name] != null ? decls[name] : '';
  }
  function writeCssProp(el, name, value) {
    // Round-trip through parseStyleDecls so the style string is
    // canonical regardless of how the existing value was written
    // (multiple writes can leave declarations without `;` separators
    // when raw `cssText` setter pastes arbitrary strings). Removing a
    // property collapses cleanly; setting overwrites.
    const decls = parseStyleDecls(el._attrs.style || '');
    if (value === '' || value == null) {
      delete decls[name];
    } else {
      decls[name] = String(value);
    }
    el.setAttribute('style', serializeStyleDecls(decls));
  }
  function removeCssProp(el, name) {
    const v = readCssProp(el, name);
    const decls = parseStyleDecls(el._attrs.style || '');
    delete decls[name];
    el.setAttribute('style', serializeStyleDecls(decls));
    return v;
  }
  function serializeStyleDecls(decls) {
    return Object.entries(decls).map(([k, v]) => k + ': ' + v).join('; ');
  }
  function parseStyleDecls(css) {
    // Char-walking parser that tolerates inputs missing `;` between
    // declarations. We scan `name: value` pairs, terminating each
    // value at `;` *or* at a look-ahead `<word>:` pattern (which can
    // only be the start of the next declaration). Existing CSS values
    // never contain `:` outside of `url(...)` parens, so peeking for
    // an unparenthesised `<word>:` is safe.
    const out = {};
    let i = 0;
    const n = css.length;
    while (i < n) {
      while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
      if (i >= n) break;
      const nameStart = i;
      while (i < n && /[a-zA-Z-]/.test(css[i])) i++;
      if (i === nameStart) { i++; continue; }
      const name = css.slice(nameStart, i).toLowerCase();
      while (i < n && /\s/.test(css[i])) i++;
      if (css[i] !== ':') continue;
      i++;
      while (i < n && /\s/.test(css[i])) i++;
      let value = '';
      let parenDepth = 0;
      while (i < n) {
        const c = css[i];
        if (c === '(') parenDepth++;
        else if (c === ')') parenDepth--;
        else if (c === ';' && parenDepth === 0) { i++; break; }
        else if (parenDepth === 0 && /\s/.test(c)) {
          let j = i + 1;
          while (j < n && /\s/.test(css[j])) j++;
          const wStart = j;
          while (j < n && /[a-zA-Z-]/.test(css[j])) j++;
          if (j > wStart) {
            let k = j;
            while (k < n && /\s/.test(css[k])) k++;
            if (css[k] === ':') break; // next declaration begins
          }
        }
        value += c;
        i++;
      }
      if (name) out[name] = value.trim();
    }
    return out;
  }

  // Build an Attr-shaped object on demand. Returned from `attributes`
  // / `getAttributeNode`. wgxpath reads `specified`, `value`,
  // `nodeName`, `name`, `namespaceURI`, `prefix`, `localName`,
  // `ownerElement`.
  function makeAttr(el, name) {
    return {
      name,
      nodeName: name,
      value:    el._attrs[name],
      nodeValue: el._attrs[name],
      specified: true,
      namespaceURI: null,
      prefix:    null,
      localName: name,
      ownerElement: el,
      ownerDocument: globalThis.document,
      // wgxpath calls `node.ownerDocument.createRange()` for
      // document-order comparison. Real DOM gives every node a
      // valid ownerDocument; we have to thread it through Attr
      // shims explicitly since they're plain objects.
      parentNode: null,
      nodeType:  2  // ATTRIBUTE_NODE
    };
  }

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

  // Each event dispatch is one "task". MutationObserver records that
  // queue *during* the task deliver as a microtask at the end of the
  // task — matching spec timing closely enough for tests that look at
  // `addedNodes` / attribute changes from a click handler.
  function dispatchEvent(target, event) {
    event.target = target;
    const path = [];
    let cur = target;
    while (cur) { path.push(cur); cur = cur._parent; }
    // Legacy `window.event` — IE-era global that handlers reach for
    // when no event parameter is in scope. Redmine's inline-autocomplete
    // `values()` callback (`event.target.type === 'text'`) and a few
    // other library entry points rely on it. Save / restore so nested
    // dispatches don't shadow each other.
    const prevWinEvent = globalThis.event;
    globalThis.event = event;
    try {
      // Capture: window → root → target's parent. Turbo Drive's
      // FormSubmitObserver / LinkClickObserver attach to `window`
      // with `{capture: true}` and call `event.preventDefault()` to
      // take over the navigation / submission; skipping the window
      // hop means every form falls through to the Ruby-side
      // submit_form_handle without Turbo's turbo-stream Accept
      // header, and the receiving controller (e.g. Avo actions)
      // raises `ActionController::UnknownFormat`.
      event.eventPhase = 1;
      fireWindowListeners(event, true);
      if (!event._propagationStopped) {
        for (let i = path.length - 1; i > 0; i--) {
          fireListeners(path[i], event, true);
          if (event._propagationStopped) break;
        }
      }
      if (!event._propagationStopped) {
        // target
        event.eventPhase = 2;
        fireListeners(target, event, false);
        fireListeners(target, event, true);
      }
      if (!event._propagationStopped && event.bubbles) {
        // bubble: target's parent → root → window
        event.eventPhase = 3;
        for (let i = 1; i < path.length; i++) {
          fireListeners(path[i], event, false);
          if (event._propagationStopped) break;
        }
        if (!event._propagationStopped) fireWindowListeners(event, false);
      }
      // HTML-spec default-action for click events that reach an
      // `<a download>` ancestor: queue a download intent so Ruby's
      // tick-time drain saves the file. file-saver's `saveAs` does
      // `node.dispatchEvent(new MouseEvent('click'))` rather than
      // `node.click()`, so without this hook the synthetic click is
      // a no-op and Avo's action-download tests never produce a file.
      // Default-action runs regardless of `bubbles` (in real browsers
      // a non-bubbling click on `<a download>` still follows the link).
      // Non-download anchors stay on the existing Element.click() /
      // Ruby-driven click paths; we don't want every random
      // dispatchEvent('click') on a div containing an anchor to
      // navigate the page.
      if (!event.defaultPrevented && event.type === 'click') {
        let anchor = target;
        while (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag !== 'a') {
          anchor = anchor._parent;
        }
        if (anchor && anchor.nodeType === NODE_ELEMENT && anchor._tag === 'a' &&
            anchor._attrs.download != null && anchor._attrs.href != null) {
          globalThis.__csimPendingDownload = {
            url: String(anchor._attrs.href),
            filename: String(anchor._attrs.download || '')
          };
        }
      }
      return !event.defaultPrevented;
    } finally {
      // Per spec, MutationObserver delivery is the microtask checkpoint
      // — synchronous flush at end-of-dispatchEvent re-enters Trix's
      // reparse → loadHTML inside its own custom-event dispatch and
      // pegs the heap (the observer's stop()/start() bracket relies on
      // delivery happening after Trix's synchronous code finishes).
      // Schedule via microtask; settle's drain_microtasks picks it up
      // in the same iteration.
      if (hasObservers() && hasQueuedRecords()) Promise.resolve().then(deliverMutations);
      if (typeof globalThis.__recheckIntersectionObservers === 'function') globalThis.__recheckIntersectionObservers();
      globalThis.event = prevWinEvent;
    }
  }
  function fireListeners(node, event, capture) {
    // Inline `on<event>` attribute handler (e.g. `onclick="..."`) fires
    // alongside the addEventListener-registered listeners in the
    // bubble phase. We compile the attribute value to a function once
    // and cache it on the node so the per-click cost is one closure
    // call. Without this, Redmine's `onclick="showAndScrollTo(...);
    // return false"` never runs and the issue-notes form stays
    // collapsed (the "Quote" link is effectively a no-op).
    if (!capture && node._attrs && !event._immediatePropagationStopped) {
      const attrName = 'on' + event.type;
      // Property assignment (`el.onclick = fn`) takes precedence over
      // any `onclick="..."` attribute per HTML spec — the setter
      // *replaces* the inline handler. jstoolbar registers its Edit /
      // Preview tab handlers via `this.previewTab.onclick = ...` and
      // the click_link 'Preview' chain depends on that running.
      // Plain property access works for the read; the only thing the
      // bridge has to do is dispatch through it during the bubble.
      const propHandler = typeof node[attrName] === 'function' ? node[attrName] : null;
      const attrVal     = propHandler ? null : node._attrs[attrName];
      let handler = propHandler;
      if (!handler && attrVal != null) {
        handler = node._onCompiled && node._onCompiled[attrName];
        if (handler === undefined) {
          try { handler = new Function('event', String(attrVal)); }
          catch (_) { handler = null; }
          (node._onCompiled = node._onCompiled || {})[attrName] = handler;
        }
      }
      if (handler) {
        event.currentTarget = node;
        try {
          const ret = handler.call(node, event);
          // Returning false from an on-attribute handler cancels the
          // event's default action (HTML spec; mirrored by jQuery's
          // own behaviour for event handlers).
          if (ret === false && event.cancelable) event.defaultPrevented = true;
        } catch (e) {
          logThrew('on-attribute handler', e);
        }
      }
    }
    const list = node._listeners && node._listeners[event.type];
    if (!list || !list.length) return;
    event.currentTarget = node;
    for (const entry of list.slice()) {
      if (entry.capture !== capture) continue;
      if (event._immediatePropagationStopped) return;
      try { entry.handler.call(node, event); } catch (e) {
        try { console.error('[csim] listener threw on event=' + event.type + ' tag=' + (node && node._tag) + ': ' + (e && e.message)); } catch (_) {}
      }
    }
  }
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


  // HTML parser + serializer live in `./html-parser.js`. Install
  // once with the DOM ctors so the parser closes over them.
  const { parseDocument, parseFragment, serializeElement, serializeChildren, escapeText } =
    installHtmlParser({ Document, Element, Text, DocumentFragment });

  // HTMLFormElement named-item access: `form.foo` returns the form
  // control whose `name` (or `id`) is `foo`. The Proxy delegates
  // anything Element already owns (methods, attrs, IDL) and falls
  // back to a named lookup on miss. Cached on the form so identity
  // checks (`button.form === form`) hold across multiple reads.
  function __formNamedAccess(form) {
    if (form._namedAccessProxy) return form._namedAccessProxy;
    const proxy = new Proxy(form, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== 'string') return target[key];
        for (const f of target.elements || []) {
          if (f._attrs && (f._attrs.name === key || f._attrs.id === key)) return f;
        }
        return undefined;
      }
    });
    form._namedAccessProxy = proxy;
    return proxy;
  }
  // Tag the returned Array as HTMLCollection-shaped (Array + `.item(i)`
  // + `.namedItem(name)`). DOM spec returns HTMLCollection; lots of
  // Redmine code paths (updateSVGIcon, etc.) do `collection.item(0)`.
  function __htmlCollection(arr) {
    const hc = HTMLCollection.from(arr);
    hc.item = function (i) { return this[i] || null; };
    hc.namedItem = function (n) {
      for (const el of this) if (el && (el._attrs && (el._attrs.id === n || el._attrs.name === n))) return el;
      return null;
    };
    return hc;
  }
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

  // `getComputedStyle(el)` — minimal cascade-aware proxy. For the
  // properties we actually have answers for (`display`, `visibility`),
  // return the resolved value from the inline-or-cascade pipeline.
  // For every other property fall back to whatever the inline style
  // proxy reports. jQuery 3.x's `isHiddenWithinTree` reads
  // `jQuery.css(elem, 'display')` which lands here; without the
  // resolved 'none' answer for a class-hidden div, `$.fn.toggle()`
  // mis-direction-detects and ends up hiding an already-hidden div.
  // Tag → default `display` lookup. jQuery 3.x's `defaultDisplay`
  // probes this synthetically by mounting an element and reading its
  // computed display; without a default our `__computedDisplayFor`
  // returned '' for a "shown" element, jQuery resolved that as
  // hidden again, and `.show()` left a misleading empty inline
  // display on the element.
  const __DEFAULT_DISPLAY = {
    a: 'inline', abbr: 'inline', b: 'inline', bdi: 'inline', bdo: 'inline',
    br: 'inline', cite: 'inline', code: 'inline', data: 'inline',
    dfn: 'inline', em: 'inline', i: 'inline', kbd: 'inline', mark: 'inline',
    q: 'inline', rp: 'inline', rt: 'inline', ruby: 'inline', s: 'inline',
    samp: 'inline', small: 'inline', span: 'inline', strong: 'inline',
    sub: 'inline', sup: 'inline', time: 'inline', u: 'inline', var: 'inline',
    wbr: 'inline', label: 'inline', input: 'inline-block', img: 'inline',
    button: 'inline-block', select: 'inline-block', textarea: 'inline-block',
    table: 'table', thead: 'table-header-group', tbody: 'table-row-group',
    tfoot: 'table-footer-group', tr: 'table-row', th: 'table-cell', td: 'table-cell',
    li: 'list-item', summary: 'list-item',
    template: 'none', script: 'none', style: 'none', noscript: 'none',
    head: 'none', title: 'none', meta: 'none', link: 'none',
    option: 'block', optgroup: 'block'
  };
  function __computedDisplayFor (el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)display\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return m[2].trim();
    }
    // Cascade-derived hidden? `matchesAnyHideRule` returns true when
    // the winning display rule is 'none' OR visibility rule is
    // 'hidden'. We approximate by reading it for 'display:none' only.
    if (el._attrs.hidden != null) return 'none';
    if (matchesAnyHideRule(el)) return 'none';
    // Default-display table: jQuery uses this resolved value to
    // restore visibility on a `.show()`-after-class-hide.
    return __DEFAULT_DISPLAY[el._tag] || 'block';
  }
  function __computedVisibilityFor (el) {
    const inlineStyle = el._attrs.style;
    if (inlineStyle) {
      const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
      if (m) return m[2].trim();
    }
    return '';
  }
  // jQuery 3.x calls `getComputedStyle(elem).display` on every
  // `.css()` / `:visible` query — i.e., the hot path. Cache the
  // proxy per element so we're not minting one (+ closure + inner
  // `getPropertyValue` closure) per call. The closure captures `el`
  // by reference, so any subsequent `_attrs.style` mutation is
  // reflected without invalidating the cache.
  function __makeComputedStyleProxy (el) {
    return new Proxy(el.style, {
      get (target, key) {
        if (key === 'display')    return __computedDisplayFor(el);
        if (key === 'visibility') return __computedVisibilityFor(el);
        if (key === 'getPropertyValue') {
          return function (name) {
            const n = String(name).toLowerCase();
            if (n === 'display')    return __computedDisplayFor(el);
            if (n === 'visibility') return __computedVisibilityFor(el);
            return target.getPropertyValue ? target.getPropertyValue(name) : (target[n] || '');
          };
        }
        return target[key];
      }
    });
  }
  globalThis.getComputedStyle = function (el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
    return el._computedStyleProxy || (el._computedStyleProxy = __makeComputedStyleProxy(el));
  };

  // Batched style read — `Node#style(['width', 'height'])` pays one
  // V8 round-trip instead of one per property.
  globalThis.__csimComputedStyle = function (handle, names) {
    const el = __handles.get(handle);
    if (!el || el.nodeType !== NODE_ELEMENT) return {};
    const proxy = getComputedStyle(el);
    const out = {};
    for (const n of names) out[n] = String(proxy[n] || '');
    return out;
  };

  // Handle registry — Ruby keeps integer ids, looks up Element back
  // via `__csimGet*(handle)` accessors. Wired in `parseDocument`
  // and pushed during create / append paths once those exist.
  const __handles = new Map();
  // Document + its html/head/body skeleton need to be in `__handles`
  // so wgxpath / find_xpath / `__csimVisible` lookups can resolve
  // skeleton nodes by id. We register the live document here at
  // bridge init; per-visit appendChild calls add the grafted body
  // descendants via `registerSubtree` automatically.
  registerNode(globalThis.document);
  function registerNode(n) {
    __handles.set(n._id, n);
    if (n._children) for (const c of n._children) registerNode(c);
  }
  function lookup(h) { return __handles.get(h) || null; }
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
  // Mutation hooks (called from Node.prototype.{appendChild, insertBefore,
  // replaceChild, removeChild} and `innerHTML` setter). Keeps the
  // handle registry in sync so Capybara's `find` results stay live
  // and stale references invalidate after `removeChild`.
  function registerSubtree(node) {
    if (!node) return;
    __handles.set(node._id, node);
    if (node._children) for (const c of node._children) registerSubtree(c);
  }
  function unregisterSubtree(node) {
    if (!node) return;
    __handles.delete(node._id);
    if (node._children) for (const c of node._children) unregisterSubtree(c);
  }

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
    __hideRules = [];
    __layoutRules = [];
    __hideRuleIdx = __layoutRuleIdx = null;
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
    ({ hide: __hideRules, layout: __layoutRules } = collectCascadeRules(globalThis.document));
    __hideRuleIdx = __layoutRuleIdx = null; // rebuilt lazily on first lookup
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
  function scriptText(el) {
    let s = '';
    for (const c of el._children) if (c.nodeType === NODE_TEXT) s += c.data;
    return s;
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
  globalThis.__csimDocumentTitle = function () {
    const head = globalThis.document.head;
    if (!head) return '';
    const t = head._children.find(c => c._tag === 'title');
    return t ? t.textContent : '';
  };
  globalThis.__csimDocumentText = function () {
    const body = globalThis.document.body;
    return body ? body.textContent : '';
  };

  // Query under `root` (handle, or 0 for document). Returns array of
  // handles; Ruby resolves each via accessors below.
  globalThis.__csimQuery = function (rootHandle, selector) {
    const root = rootHandle ? lookup(rootHandle) : globalThis.document;
    if (!root) return [];
    const matches = root.nodeType === NODE_DOC
      ? root.querySelectorAll(selector)
      : (root.querySelectorAll ? root.querySelectorAll(selector) : []);
    return matches.map(el => el._id);
  };
  // XPath evaluation via wgxpath (Google's wicked-good-xpath, vendored
  // into vendor/js/wgxpath.js and installed at boot). `document.
  // evaluate` is patched onto Document.prototype. We use ORDERED_NODE_
  // SNAPSHOT_TYPE (7) so the result is a live array we can iterate
  // by index, and so the node order matches Capybara's expectations.
  globalThis.__csimEvaluateXPath = function (xpath, contextHandle) {
    const ctx = contextHandle ? lookup(contextHandle) : globalThis.document;
    if (!ctx) return [];
    let result;
    try {
      result = globalThis.document.evaluate(String(xpath), ctx, null, 7, null);
    } catch (e) {
      // Match Capybara's selenium driver: throw `Capybara::ElementNotFound`
      // for bad XPath. Surface to Ruby as a sentinel so the caller can
      // raise; for now we just return an empty result and log.
      try { console.error('[csim] XPath threw:', e && e.message, 'for', xpath); } catch (_) {}
      return [];
    }
    const out = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const n = result.snapshotItem(i);
      if (n && typeof n._id === 'number') out.push(n._id);
    }
    return out;
  };

  globalThis.__csimQueryOne = function (rootHandle, selector) {
    const root = rootHandle ? lookup(rootHandle) : globalThis.document;
    if (!root) return 0;
    const hit = root.nodeType === NODE_DOC
      ? root.querySelector(selector)
      : (root.querySelector ? root.querySelector(selector) : null);
    return hit ? hit._id : 0;
  };

  // Element field accessors. Each is one V8 round-trip from Ruby
  // (mini_racer's `Context#call`) — at the granularity of one
  // Capybara DSL operation (`node.text`, `node.tag_name`, …), not
  // per-internal-DOM-op.
  globalThis.__csimText      = function (h) { const n = lookup(h); return n ? n.textContent : ''; };
  globalThis.__csimTag       = function (h) {
    const n = lookup(h);
    if (!n) return '';
    if (n._tag) return n._tag;
    if (n instanceof ShadowRoot) return 'ShadowRoot';
    return '';
  };
  // Trace `description` helper: `{tag, id, cls}` for a CSS-selector-ish
  // short form. Class is truncated to the first whitespace-separated
  // token so a node with 10 utility classes doesn't drown the trace.
  globalThis.__csimDescribeNode = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const cls = (n._attrs.class || '').trim().split(/\s+/)[0] || '';
    return { tag: n._tag || '', id: n._attrs.id || '', cls: cls };
  };
  globalThis.__csimAttr      = function (h, name) {
    const n = lookup(h);
    if (!n) return null;
    // Capybara's `node[name]` reads either a content attribute or an
    // IDL property. Route a few well-known IDL names off the
    // getAttribute path so `node[:validationMessage]` /
    // `node[:innerHTML]` etc. return what user JS sees.
    switch (String(name)) {
      case 'validationMessage': return n.validationMessage || '';
      case 'validity':          return n.validity || null;
      case 'innerHTML':         return typeof n.innerHTML === 'string' ? n.innerHTML : null;
      case 'outerHTML':         return typeof n.outerHTML === 'string' ? n.outerHTML : null;
      case 'textContent':       return typeof n.textContent === 'string' ? n.textContent : null;
      case 'checked':           return !!n.checked;
      case 'disabled':          return !!n.disabled;
      case 'value':             return n.value != null ? n.value : '';
    }
    return n.getAttribute ? n.getAttribute(name) : null;
  };
  globalThis.__csimHasAttr   = function (h, name) { const n = lookup(h); return !!(n && n.hasAttribute && n.hasAttribute(name)); };
  // Visibility walk — `self_hidden?` + ancestor chain:
  // INVISIBLE_TAGS (head/script/style/template/noscript/title),
  // `<input type=hidden>`, `hidden` attribute, inline `style=`
  // `display:none` / `visibility:hidden`. Cascade-derived rules
  // (display / visibility from <style> + <link rel=stylesheet>) are
  // resolved in `matchesAnyHideRule` with proper specificity + @media
  // evaluation — see the "Display / visibility cascade" block below.
  const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);
  const DISPLAY_NONE_RE       = /(^|;|\s)display\s*:\s*none\b/i;
  const VISIBILITY_HIDDEN_RE  = /(^|;|\s)visibility\s*:\s*hidden\b/i;
  // Inline `display` / `visibility` declarations that AREN'T `none` /
  // `hidden` — anything else (block, inline, inline-block, …) wins
  // over a class-derived `display: none` (per spec, inline style has
  // higher specificity than ordinary author rules). jQuery's
  // `.show()` over a `.hidden`-classed element ends up writing
  // `style="display: block"`; without this branch the element stayed
  // invisible because matchesAnyHideRule kept asserting hidden.
  const DISPLAY_OTHER_RE      = /(^|;|\s)display\s*:\s*(?!none\b)[^;]+/i;
  const VISIBILITY_OTHER_RE   = /(^|;|\s)visibility\s*:\s*(?!hidden\b)[^;]+/i;
  function selfHidden(el) {
    if (el._attrs.hidden != null) return true;
    // `<dialog>` HTML spec UA stylesheet: `dialog:not([open]) { display: none }`.
    // Avo's confirm-dialog template (the "Close modal / Are you sure? /
    // Yes, I'm sure / No, cancel" block) is rendered into every page
    // and stays in the DOM without `open` until `data-turbo-confirm`
    // triggers `showModal()`. Without honouring the UA hide here,
    // Capybara's `click_on "Close modal"` matches both the dropdown
    // action item and the dialog's close button → ambiguous-match.
    if (el._tag === 'dialog' && el._attrs.open == null) return true;
    const style = el._attrs.style;
    if (style && (DISPLAY_NONE_RE.test(style) || VISIBILITY_HIDDEN_RE.test(style))) return true;
    // Inline display:<other> overrides any class-derived display:none.
    if (style && DISPLAY_OTHER_RE.test(style)) return false;
    return matchesAnyHideRule(el);
  }

  // Visibility predicate exposed to the Element class for layout-shaped
  // getters (offsetWidth, getBoundingClientRect, …). Mirrors the
  // ancestor walk in `__csimVisible` but takes a node directly. We
  // don't model real layout, so the answer is "true unless something
  // says hidden": INVISIBLE_TAGS (head/script/style/template/…),
  // `<input type=hidden>`, the `hidden` attribute, inline `display:none`
  // / `visibility:hidden`, or a cascade rule the resolver agrees with.
  function __isVisibleNode(el) {
    if (!el || el.nodeType !== NODE_ELEMENT) return false;
    if (INVISIBLE_TAGS.has(el._tag)) return false;
    if (el._tag === 'input' && (el._attrs.type || '').toLowerCase() === 'hidden') return false;
    let cur = el;
    while (cur) {
      if (cur.nodeType === NODE_DOC) return true;
      if (cur.nodeType === NODE_ELEMENT) {
        if (INVISIBLE_TAGS.has(cur._tag)) return false;
        if (selfHidden(cur)) return false;
      }
      cur = cur._parent;
    }
    return false;
  }
  globalThis.__isVisibleNode = __isVisibleNode;

  // ── Display / visibility cascade ────────────────────────────────
  //
  // Scope: just `display` and `visibility`. We don't model any other
  // CSS property — selfHidden is the only consumer, so the resolver
  // can throw away everything else at parse time.
  //
  // Pipeline:
  //   1. parseCssTree(text)         — tokenise into nested {at-rule|rule}
  //   2. flattenRules(tree, ctx)    — eval @media against viewport,
  //                                   substitute & for parent selector,
  //                                   drop @keyframes / @font-face / etc.
  //   3. extractHideRules(text)     — flatten → one entry per (selector,
  //                                   display, visibility, !important).
  //   4. matchesAnyHideRule(el)     — for each matching rule, pick the
  //                                   declaration with highest priority
  //                                   (important > !important; among
  //                                   equals, higher specificity wins;
  //                                   among equals, later source order
  //                                   wins). Element is hidden iff the
  //                                   winning `display` is `none` or
  //                                   `visibility` is `hidden`.
  //
  // We don't compute inheritance — `visibility` does inherit per spec
  // but selfHidden walks the ancestor chain anyway, so the inheritance
  // falls out naturally. `display` doesn't inherit.

  let __hideRules = [];
  let __layoutRules = [];
  let __ruleSerial = 0;
  // Re-run the cascade resolution against the current viewport. Called
  // from Ruby after `set_viewport` so `@media` rules update without a
  // full reload — without this, a mobile-breakpoint resize (Forem's
  // ahoy spec drops to 425×694) keeps every desktop-only `display`
  // / `visibility` rule active and the hamburger trigger still
  // reports as hidden via the cascade.
  globalThis.__csimRebuildCascade = function () {
    if (!globalThis.document || !globalThis.document.documentElement) return;
    ({ hide: __hideRules, layout: __layoutRules } = collectCascadeRules(globalThis.document));
    __hideRuleIdx = __layoutRuleIdx = null;
  };

  function stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

  // Parse CSS text into a tree. Returns an array of nodes:
  //   { type: 'rule', selector, decls: [{prop, value, important}], children: [...] }
  //   { type: 'at-rule', name, prelude, children: [...] | null, decls: [...] }
  //
  // CSS Nesting (Level 4) is supported: a rule can contain both
  // declarations and child rules. The flattener composes child rule
  // selectors against the parent's.
  function parseCssTree(text) {
    const s = stripCssComments(text);
    const out = parseCssBody(s, 0, false);
    return out.nodes;
  }

  function parseCssBody(s, start, inBlock) {
    const nodes = [];
    let i = start;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      if (inBlock && s[i] === '}') { i++; return { nodes, next: i }; }
      if (s[i] === '@') {
        const at = parseAtRule(s, i);
        nodes.push(at.node);
        i = at.next;
        continue;
      }
      // Look ahead to decide if this is a declaration or a qualified
      // rule. Track top-level `{`/`;`/`}` (i.e. depth == 0 for [], ()).
      const probe = scanToBreaker(s, i);
      if (probe.kind === 'lbrace') {
        const selector = s.slice(i, probe.at).trim();
        const body = parseDeclsAndNested(s, probe.at + 1);
        nodes.push({ type: 'rule', selector, decls: body.decls, children: body.children });
        i = body.next;
        continue;
      }
      // Stray declaration at top level (or no terminator) — skip past.
      i = probe.at + (probe.kind === 'semi' ? 1 : 0);
      if (i <= start) i = s.length;
    }
    return { nodes, next: i };
  }

  function scanToBreaker(s, i) {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      // CSS escape outside strings: `\<char>` consumes one extra char.
      // Avo's Tailwind utilities encode every attribute-selector punct
      // (`\[disabled\=\'true\'\]`) this way — without the skip, a bare
      // `\'` flips us into quote mode and we miss the next `}`.
      if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (c === '{' || c === ';' || c === '}')) {
        return { kind: c === '{' ? 'lbrace' : c === ';' ? 'semi' : 'rbrace', at: i };
      }
      i++;
    }
    return { kind: 'eof', at: i };
  }

  function parseAtRule(s, i) {
    i++; // skip @
    const start = i;
    while (i < s.length && /[a-zA-Z-]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    const preStart = i;
    while (i < s.length && /\s/.test(s[i])) i++;
    // prelude until ; or {
    const pStart = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (c === ';' || c === '{')) break;
      i++;
    }
    const prelude = s.slice(pStart, i).trim();
    if (i >= s.length || s[i] === ';') {
      return { node: { type: 'at-rule', name, prelude, children: null }, next: i + 1 };
    }
    // s[i] === '{'
    i++;
    // For @keyframes / @font-face / @page / etc. we just want to skip
    // the body without descending. Everything else can carry nested
    // rules + declarations.
    if (name === 'keyframes' || name === 'font-face' || name === 'page' ||
        name === 'counter-style' || name === 'property' || name === 'font-feature-values') {
      const skipped = skipBalancedBlock(s, i);
      return { node: { type: 'at-rule', name, prelude, children: null }, next: skipped };
    }
    const body = parseDeclsAndNested(s, i);
    return {
      node: { type: 'at-rule', name, prelude, children: body.children, decls: body.decls },
      next: body.next
    };
  }

  function skipBalancedBlock(s, i) {
    let depth = 1;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    return i;
  }

  function parseDeclsAndNested(s, i) {
    const decls = [];
    const children = [];
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      if (s[i] === '}') return { decls, children, next: i + 1 };
      if (s[i] === '@') {
        const at = parseAtRule(s, i);
        children.push(at.node);
        i = at.next;
        continue;
      }
      const probe = scanToBreaker(s, i);
      if (probe.kind === 'lbrace') {
        // nested rule
        const selector = s.slice(i, probe.at).trim();
        const body = parseDeclsAndNested(s, probe.at + 1);
        children.push({ type: 'rule', selector, decls: body.decls, children: body.children });
        i = body.next;
        continue;
      }
      if (probe.kind === 'semi' || probe.kind === 'rbrace') {
        const declText = s.slice(i, probe.at).trim();
        if (declText) {
          const colonIdx = declText.indexOf(':');
          if (colonIdx > 0) {
            const prop = declText.slice(0, colonIdx).trim().toLowerCase();
            let value = declText.slice(colonIdx + 1).trim();
            let important = false;
            if (/!important\s*$/i.test(value)) {
              important = true;
              value = value.replace(/!important\s*$/i, '').trim();
            }
            // Retain only the properties the cascade resolvers care
            // about — display / visibility (hide rules),
            // top / left / width / height (layout for click-offset),
            // text-transform (visible-text uppercase/lowercase).
            if (prop === 'display' || prop === 'visibility' || prop === 'text-transform') {
              decls.push({ prop, value: value.toLowerCase(), important });
            } else if (prop === 'top' || prop === 'left' || prop === 'width' || prop === 'height') {
              decls.push({ prop, value: value.trim(), important });
            }
          }
        }
        if (probe.kind === 'rbrace') return { decls, children, next: probe.at + 1 };
        i = probe.at + 1;
        continue;
      }
      // EOF / no terminator
      break;
    }
    return { decls, children, next: i };
  }


  // Flatten the parsed CSS tree to a list of {selectorText, decls,
  // sourceIdx, important}. Resolves @media (drops non-matching),
  // @supports (always-true, descend), CSS nesting via `&` substitution.
  function flattenCssTree(tree, vp) {
    const out = [];
    const stack = []; // parent selector groups for nesting context
    function walk(nodes) {
      for (const node of nodes) {
        if (node.type === 'at-rule') {
          if (node.name === 'media') {
            if (mediaMatches(node.prelude, vp)) {
              if (node.decls && node.decls.length && stack.length) {
                // Decls inside @media inside a rule attach to the
                // enclosing rule's selector.
                out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
              }
              walk(node.children || []);
            }
            continue;
          }
          if (node.name === 'supports' || node.name === 'container') {
            // Always-on fallback: descend.
            if (node.decls && node.decls.length && stack.length) {
              out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
            }
            walk(node.children || []);
            continue;
          }
          // @keyframes / @font-face / @import / etc. — skip.
          continue;
        }
        // node.type === 'rule'
        const parentSel = stack.length ? stack[stack.length - 1] : null;
        const resolved = composeNestedSelector(node.selector, parentSel);
        if (node.decls && node.decls.length) {
          out.push({ selectorText: resolved, decls: node.decls });
        }
        if (node.children && node.children.length) {
          stack.push(resolved);
          walk(node.children);
          stack.pop();
        }
      }
    }
    walk(tree);
    return out;
  }

  // CSS nesting: `&` in a nested selector substitutes the parent
  // selector list. Without `&`, the nested selector is implicitly
  // `& <descendant> child`. Multi-selector lists distribute.
  function composeNestedSelector(child, parent) {
    if (!parent) return child;
    const childParts = splitTopLevel(child, ',').map(p => p.trim()).filter(Boolean);
    const parentParts = splitTopLevel(parent, ',').map(p => p.trim()).filter(Boolean);
    const out = [];
    for (const cp of childParts) {
      const hasAmpersand = /&/.test(cp);
      for (const pp of parentParts) {
        if (hasAmpersand) {
          // Parentheses around pp so that `& .foo` keeps `pp` as a
          // single compound chunk in the descendant join. Real CSS uses
          // `:is(pp)` for this; the in-house matcher supports `:is`.
          out.push(cp.replace(/&/g, ':is(' + pp + ')'));
        } else {
          out.push(pp + ' ' + cp);
        }
      }
    }
    return out.join(', ');
  }

  // Walk every `<style>` and `<link rel=stylesheet>` once and pull
  // out the two slices of cascade state we care about — hide rules
  // (display / visibility, for `visible?`) and layout rules
  // (`top/left/width/height` + `text-transform`, for click-offset
  // resolution and visible-text upper-casing). One Rack fetch per
  // external stylesheet, one `parseCssTree` per blob.
  function collectCascadeRules(doc) {
    const empty = { hide: [], layout: [] };
    if (!doc || !doc.documentElement) return empty;
    __ruleSerial = 0;
    const vp = currentViewport();
    const hide   = [];
    const layout = [];
    const consume = (cssText) => {
      let tree;
      try { tree = parseCssTree(cssText); } catch (_) { return; }
      for (const r of flattenCssTree(tree, vp)) {
        if (!r.selectorText || !r.decls.length) continue;
        let display = null, displayImp = false;
        let visibility = null, visibilityImp = false;
        const captured = {};
        for (const d of r.decls) {
          if      (d.prop === 'display')    { display = d.value; displayImp = d.important; }
          else if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
          if (LAYOUT_PROPS.includes(d.prop)) captured[d.prop] = { value: d.value, important: d.important };
        }
        const hasHide   = display != null || visibility != null;
        const hasLayout = Object.keys(captured).length > 0;
        if (!hasHide && !hasLayout) continue;
        for (const sel of splitTopLevel(r.selectorText, ',')) {
          const trimmed = sel.trim();
          if (!trimmed) continue;
          let group;
          try { group = parseSelector(trimmed); } catch (_) { continue; }
          if (!group || !group.length) continue;
          const spec   = specificity(group[0]);
          const source = __ruleSerial++;
          if (hasHide)   hide  .push({ group, spec, source, display, displayImp, visibility, visibilityImp });
          if (hasLayout) layout.push({ group, spec, source, captured });
        }
      }
    };
    for (const s of doc.documentElement.querySelectorAll('style')) {
      const txt = scriptText(s);
      if (txt) consume(txt);
    }
    for (const l of doc.documentElement.querySelectorAll('link')) {
      const rel = (l._attrs.rel || '').toLowerCase();
      if (!rel.split(/\s+/).includes('stylesheet')) continue;
      const href = l._attrs.href;
      if (!href) continue;
      try {
        const resp = __rackFetch('GET', href, '', null, 'follow');
        if (resp && resp.status < 400 && resp.body) consume(resp.body);
      } catch (_) {}
    }
    return { hide, layout };
  }

  // Hide-rule index: bucket each rule by the terminal compound's
  // most-discriminating signal (id > class > tag > universal). The
  // resolver then only walks buckets the element can plausibly match,
  // instead of scanning every rule on the page.
  //
  // Cost model: a Redmine-scale stylesheet has ~4000 rules, of which
  // the vast majority pin a class or tag at the terminal. With the
  // index, a visibility check for a `<div class="foo">` element
  // typically inspects ~5–20 rules instead of all 4000. Cascade
  // resolution (specificity + source order + !important) works the
  // same — each rule already carries its `spec` / `source` /
  // `displayImp` / `visibilityImp` so per-bucket order doesn't matter.
  let __hideRuleIdx   = null;
  let __layoutRuleIdx = null;
  // Bucket rules by their terminal compound's most-discriminating
  // signal (id > class > tag > universal). The resolver then only
  // walks buckets the element can plausibly match — typically
  // ~5–20 rules per element instead of the full 4000 on a
  // Redmine/Tailwind page. Layout-rule cascade uses the same shape;
  // we maintain a separate index per rule list because the records
  // carry different decl shapes.
  function buildRuleIndex(rules) {
    const idx = {
      byTag:     new Map(),
      byId:      new Map(),
      byClass:   new Map(),
      universal: []
    };
    for (const r of rules) {
      const seq = r.group[0];
      const term = seq[seq.length - 1];
      let bucket;
      if (term.classes && term.classes.length) {
        const key = term.classes[0];
        bucket = idx.byClass.get(key);
        if (!bucket) idx.byClass.set(key, bucket = []);
      } else if (term.id) {
        bucket = idx.byId.get(term.id);
        if (!bucket) idx.byId.set(term.id, bucket = []);
      } else if (term.tag) {
        bucket = idx.byTag.get(term.tag);
        if (!bucket) idx.byTag.set(term.tag, bucket = []);
      } else {
        bucket = idx.universal;
      }
      bucket.push(r);
    }
    return idx;
  }
  // Walk the rule buckets that could match `el`, calling `cb(rule)`
  // for each candidate. Matches the bucket-selection logic that used
  // to live inline in `matchesAnyHideRule`.
  function forEachCandidateRule(idx, el, cb) {
    const tagBucket = idx.byTag.get(el._tag);
    if (tagBucket) for (const r of tagBucket) cb(r);
    const idAttr = el._attrs.id;
    if (idAttr) {
      const idBucket = idx.byId.get(idAttr);
      if (idBucket) for (const r of idBucket) cb(r);
    }
    for (const c of classTokens(el)) {
      const cb2 = idx.byClass.get(c);
      if (cb2) for (const r of cb2) cb(r);
    }
    if (idx.universal.length) for (const r of idx.universal) cb(r);
  }
  // Tokenise `element.class` with a per-element cache. `\s+`-splitting
  // is the single hottest regex in the JS profile because every
  // cascade lookup, `tailwindTextTransform` probe, and `[class~=…]`
  // selector match re-splits the same string. The cache key is the
  // raw class string — V8 interns string literals so the equality
  // check is cheap, and a `class` mutation (via setAttribute / IDL
  // setters / classList) produces a fresh string that misses the
  // cache and re-splits once. Empty / missing class returns a
  // shared empty array.
  const EMPTY_CLASS_TOKENS = Object.freeze([]);
  function classTokens(el) {
    const cls = el._attrs.class;
    if (!cls) return EMPTY_CLASS_TOKENS;
    if (el._classTokensKey !== cls) {
      el._classTokensKey   = cls;
      el._classTokensCache = cls.split(/\s+/).filter(Boolean);
    }
    return el._classTokensCache;
  }

  // Captured by `collectCascadeRules` into the `layout` slice.
  // `top/left/width/height` resolve to numeric coordinates for the
  // click-offset path; `text-transform` feeds the visible-text
  // upper/lower-case path (Tailwind `.uppercase` etc. — without it
  // Avo's column headers come back mixed-case instead of `ID`/`NAME`).
  const LAYOUT_PROPS = ['top', 'left', 'width', 'height', 'text-transform'];
  // Inline `style="top: 100px; left: 100px"` parsing for one element.
  function parseInlineLayout (el) {
    const out = {};
    const s = el._attrs && el._attrs.style;
    if (!s) return out;
    for (const part of String(s).split(';')) {
      const m = /^\s*(top|left|width|height)\s*:\s*([^;]+?)\s*$/.exec(part);
      if (m) out[m[1]] = { value: m[2], important: /\s+!important\s*$/.test(m[2]) };
    }
    return out;
  }
  function parsePx (v) {
    if (v == null) return null;
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
    return m ? parseFloat(m[1]) : (/^(-?\d+(?:\.\d+)?)$/.test(v) ? parseFloat(v) : null);
  }
  function resolveLayoutProp (el, prop) {
    const inline = parseInlineLayout(el)[prop];
    let best = inline ? { spec: [1,0,0,0], source: Infinity, ...inline } : null;
    if (__layoutRules.length) {
      if (!__layoutRuleIdx) __layoutRuleIdx = buildRuleIndex(__layoutRules);
      forEachCandidateRule(__layoutRuleIdx, el, (r) => {
        const cap = r.captured[prop];
        if (!cap) return;
        let m;
        try { m = matchOne(el, r.group); } catch (_) { return; }
        if (!m) return;
        if (!best ||
            (cap.important && !best.important) ||
            (cap.important === best.important &&
             (specCompare(r.spec, best.spec) > 0 ||
              (specCompare(r.spec, best.spec) === 0 && r.source >= best.source)))) {
          best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
        }
      });
    }
    return best ? parsePx(best.value) : null;
  }
  function specCompare(a, b) {
    for (let i = 0; i < 4; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }
  // Sum each ancestor's top/left to translate an element's CSS-declared
  // box into an absolute "viewport" position. We don't run a layout
  // engine; this is just "if a test declares position via px values,
  // honour those values" — enough for the click-offset specs.
  globalThis.__csimTimersDebug = timerStats;
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

  function matchesAnyHideRule(el) {
    if (__hideRules.length === 0) return false;
    if (!__hideRuleIdx) __hideRuleIdx = buildRuleIndex(__hideRules);
    let bestD = null, bestV = null;
    forEachCandidateRule(__hideRuleIdx, el, (r) => {
      let m;
      try { m = matchOne(el, r.group); } catch (_) { return; }
      if (!m) return;
      if (r.display != null && winsCascade(bestD, r, true)) {
        bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
      }
      if (r.visibility != null && winsCascade(bestV, r, false)) {
        bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source };
      }
    });
    if (bestD && bestD.value === 'none') return true;
    if (bestV && bestV.value === 'hidden') return true;
    return false;
  }

  function winsCascade(current, candidate, isDisplay) {
    const candImp = isDisplay ? candidate.displayImp : candidate.visibilityImp;
    if (!current) return true;
    if (candImp && !current.important) return true;
    if (!candImp && current.important) return false;
    const cmp = compareSpec(candidate.spec, current.spec);
    if (cmp !== 0) return cmp > 0;
    return candidate.source >= current.source;
  }
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
        // <details> hides its content while closed *unless* the target
        // sits inside <summary>.
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
  // the skip, page titles and <script> source land in the visible-
  // text string and trip "found N times including non-visible text"
  // assertions.
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
    // `value`, not subtree text. React-controlled textareas keep an
    // empty subtree, so without this `have_css(text:)` would never
    // match content typed into one.
    if (n.nodeType === NODE_ELEMENT && n._tag === 'textarea') {
      return n.value == null ? '' : String(n.value);
    }
    // Pick up an inherited text-transform from ancestors above the
    // starting node so e.g. `<body style="text-transform:uppercase">`
    // applies to a descendant's visible_text.
    let startTransform = 'none';
    for (let cur = n._parent; cur; cur = cur._parent) {
      if (cur.nodeType !== NODE_ELEMENT) continue;
      const v = cascadedTextTransform(cur);
      if (v && v !== 'inherit') { startTransform = v; break; }
    }
    return collectVisibleText(n, startTransform);
  };
  // Per innerText: collapse inline-whitespace runs (tab/newline/VT)
  // to a single space in each text node.
  const INLINE_WS_RE = /[\t\n\v\f\r]+/g;
  // Block-shaped tags get a `\n` boundary before/after their content.
  const BLOCK_TAGS = new Set([
    'address','article','aside','blockquote','dd','div','dl','dt',
    'figcaption','figure','footer','form','h1','h2','h3','h4','h5',
    'h6','header','hr','li','main','nav','ol','p','pre','section',
    'table','tbody','td','tfoot','th','thead','tr','ul'
  ]);
  // Adjacent `<th>` / `<td>` cells get a U+0009 between them per the
  // innerText spec §14.4 step 4 ("required line break count" carries a
  // tab on table-cell boundaries). The expected text in Avo's
  // `table thead` assertion is `"A\n\t\nB"`, which only comes out
  // after appending this tab AFTER each cell that has a next cell
  // sibling.
  const TABLE_CELL_TAGS = new Set(['td','th']);
  function hasNextCellSibling(node) {
    const siblings = node._parent && node._parent._children;
    if (!siblings) return false;
    const i = siblings.indexOf(node);
    for (let j = i + 1; j < siblings.length; j++) {
      const s = siblings[j];
      if (s.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(s._tag)) return true;
    }
    return false;
  }
  // CSS flex / grid containers blockify their children, so innerText
  // joins them with `\n` even when the children are `<a>` / `<span>`
  // (Avo's tab switcher: a `<div class="flex flex-wrap">` of `<a>`s).
  // Detection covers the inline-style override and the Tailwind utility
  // class — the two ways every observed real-world flex container in
  // the test suites declares itself. Other CSS rules can flow in later
  // via the cascade if a test needs it.
  const FLEX_LIKE_DISPLAY = new Set(['flex','grid','inline-flex','inline-grid']);
  const INLINE_DISPLAY_RE = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i;
  function isFlexLikeContainer(el) {
    const style = el._attrs && el._attrs.style;
    if (style) {
      const m = INLINE_DISPLAY_RE.exec(style);
      if (m) {
        const v = m[1].trim().toLowerCase();
        // Inline `display` wins over class-derived `flex`, either way.
        return FLEX_LIKE_DISPLAY.has(v);
      }
    }
    for (const tok of classTokens(el)) {
      if (FLEX_LIKE_DISPLAY.has(tok)) return true;
    }
    return false;
  }
  // text-transform inherits per CSS — resolve once per element by
  // walking inline style → cascade → parent. Capybara's case-insensitive
  // assertion message ("found 1 time using a case insensitive search")
  // hinges on visible_text being `TEXT HERE` for `text-transform:uppercase`,
  // not the underlying `text here`.
  // Utility-class shortcut: Tailwind / similar frameworks ship one
  // class per text-transform value. When an element carries the
  // class AND has no inline `style="text-transform: …"` override,
  // skip the full cascade walk — the matching rule's value is
  // determined by the class name. Falls back to the cascade for
  // anything more elaborate (inline style with `!important`, a
  // higher-specificity stylesheet rule).
  const TAILWIND_TEXT_TRANSFORM = Object.assign(Object.create(null), {
    uppercase:    'uppercase',
    lowercase:    'lowercase',
    capitalize:   'capitalize',
    'normal-case': 'none',
  });
  function tailwindTextTransform (el) {
    for (const tok of classTokens(el)) {
      const t = TAILWIND_TEXT_TRANSFORM[tok];
      if (t) return t;
    }
    return null;
  }
  function parseInlineTextTransform (el) {
    const s = el._attrs && el._attrs.style;
    if (!s) return null;
    const m = /(?:^|;)\s*text-transform\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i.exec(String(s));
    return m ? m[1].toLowerCase() : null;
  }
  function cascadedTextTransform (el) {
    const inline = parseInlineTextTransform(el);
    // Fast path: no inline override + a Tailwind utility-class token
    // present. Skip the cascade walk entirely.
    if (!inline) {
      const tw = tailwindTextTransform(el);
      if (tw) return tw;
    }
    let best = inline ? { value: inline, spec: [1,0,0,0], important: /!important/i.test(el._attrs.style || ''), source: Infinity } : null;
    if (__layoutRules.length) {
      if (!__layoutRuleIdx) __layoutRuleIdx = buildRuleIndex(__layoutRules);
      forEachCandidateRule(__layoutRuleIdx, el, (r) => {
        const cap = r.captured['text-transform'];
        if (!cap) return;
        let m;
        try { m = matchOne(el, r.group); } catch (_) { return; }
        if (!m) return;
        if (!best ||
            (cap.important && !best.important) ||
            (cap.important === best.important &&
             (specCompare(r.spec, best.spec) > 0 ||
              (specCompare(r.spec, best.spec) === 0 && r.source >= best.source)))) {
          best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
        }
      });
    }
    return best ? best.value : null;
  }
  function resolveTextTransform (el) {
    for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
      const v = cascadedTextTransform(cur);
      if (v && v !== 'inherit') return v;
    }
    return 'none';
  }
  function applyTextTransform (text, mode) {
    if (!text || mode === 'none' || mode === 'initial' || mode === 'unset' || !mode) return text;
    if (mode === 'uppercase') return text.toUpperCase();
    if (mode === 'lowercase') return text.toLowerCase();
    if (mode === 'capitalize') {
      return text.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
    }
    return text;
  }
  function collectVisibleText(node, transform) {
    if (node.nodeType === NODE_TEXT) {
      const raw = String(node.data || '').replace(INLINE_WS_RE, ' ');
      return applyTextTransform(raw, transform || 'none');
    }
    if (node.nodeType !== NODE_ELEMENT && node.nodeType !== NODE_DOC && node.nodeType !== NODE_FRAGMENT) return '';
    if (node.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(node._tag)) return '';
      if (node._tag === 'input' && (node._attrs.type || '').toLowerCase() === 'hidden') return '';
      if (selfHidden(node)) return '';
      if (node._tag === 'br') return '\n';
      const ownTransform = cascadedTextTransform(node);
      const effTransform = (ownTransform && ownTransform !== 'inherit') ? ownTransform : (transform || 'none');
      if (node._tag === 'details' && node._attrs.open == null) {
        // Closed details: only emit text inside <summary>.
        let s = '';
        for (const c of node._children) {
          if (c.nodeType === NODE_ELEMENT && c._tag === 'summary') s += collectVisibleText(c, effTransform);
        }
        return s;
      }
      transform = effTransform;
    }
    const flexContext = node.nodeType === NODE_ELEMENT && isFlexLikeContainer(node);
    let out = '';
    for (const c of node._children) {
      // Whitespace-only text nodes between flex/grid items don't
      // produce visible runs (no anonymous flex item is generated
      // for whitespace).
      if (flexContext && c.nodeType === NODE_TEXT && !/\S/.test(String(c.data || ''))) continue;
      const part = collectVisibleText(c, transform);
      if (!part) continue;
      const isBlock = c.nodeType === NODE_ELEMENT && (BLOCK_TAGS.has(c._tag) || flexContext);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
      out += part;
      if (isBlock && !part.endsWith('\n')) out += '\n';
      if (c.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(c._tag) && hasNextCellSibling(c)) {
        out += '\t';
      }
    }
    return out;
  }

  // HTML spec: `<option>.selected` IDL is true when the `selected`
  // attribute is set OR when no sibling option has `selected` and this
  // is the first non-disabled option of a single-select `<select>`
  // (implicit default). Capybara's `have_select(selected: "Choose an
  // option")` matcher's `selected?` per-option filter relies on the
  // implicit branch — without it, a `<select>` with no explicit
  // `<option selected>` reports zero selected options even though the
  // first option *is* the currently rendered choice.
  globalThis.__csimOptionSelected = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT || n._tag !== 'option') return false;
    if (n._attrs.selected != null) return true;
    // Find the owning <select>; walk past optgroup wrappers.
    let sel = n._parent;
    while (sel && sel.nodeType === NODE_ELEMENT && sel._tag === 'optgroup') sel = sel._parent;
    if (!sel || sel._tag !== 'select') return false;
    // Multi-select has no implicit default — only explicit `selected`
    // counts.
    if (sel._attrs.multiple != null) return false;
    const opts = sel.querySelectorAll('option');
    // Walk all options. Any explicit `<option selected>` kills the
    // implicit pick (only explicit counts). Track the first non-
    // disabled candidate; n is the implicit selection iff it matches.
    let firstEnabled = null;
    for (const o of opts) {
      if (o._attrs.selected != null) return false;
      if (o._attrs.disabled == null && firstEnabled === null) firstEnabled = o;
    }
    return n === firstEnabled;
  };

  // `disabled?` — only form controls (+ fieldset) can be disabled;
  // an `<option>` inherits disabled from an ancestor `<select>` /
  // `<optgroup>`; form controls inherit from an ancestor
  // `<fieldset disabled>` unless they sit inside its first `<legend>`.
  const FORM_CONTROLS = new Set(['input','select','textarea','button','optgroup','option']);
  globalThis.__csimDisabled = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return false;
    if ((FORM_CONTROLS.has(n._tag) || n._tag === 'fieldset') && n._attrs.disabled != null) return true;
    if (n._tag === 'option') {
      let cur = n._parent;
      while (cur && cur.nodeType === NODE_ELEMENT && (cur._tag === 'optgroup' || cur._tag === 'select')) {
        if (cur._attrs.disabled != null) return true;
        cur = cur._parent;
      }
    }
    if (FORM_CONTROLS.has(n._tag)) {
      let cur = n._parent;
      while (cur && cur.nodeType === NODE_ELEMENT) {
        if (cur._tag === 'fieldset' && cur._attrs.disabled != null) {
          // Find the fieldset's first <legend>; if n sits inside it,
          // it stays enabled.
          let legend = null;
          for (const c of cur._children) {
            if (c.nodeType === NODE_ELEMENT && c._tag === 'legend') { legend = c; break; }
          }
          if (legend) {
            let p = n;
            while (p) { if (p === legend) return false; p = p._parent; }
          }
          return true;
        }
        cur = cur._parent;
      }
    }
    return false;
  };

  globalThis.__csimAttrs = function (h) {
    const n = lookup(h);
    return n && n._attrs ? Object.assign({}, n._attrs) : {};
  };
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

  globalThis.__csimBaseHref = function () {
    const doc = globalThis.document;
    if (!doc || !doc.head) return '';
    for (const c of doc.head._children || []) {
      if (c.nodeType === NODE_ELEMENT && c._tag === 'base' && c._attrs.href != null) {
        return String(c._attrs.href);
      }
    }
    return '';
  };

  globalThis.__csimNodePath = function (h) {
    const start = __handles.get(h);
    if (!start || start.nodeType !== NODE_ELEMENT) return '';
    // A node living inside a ShadowRoot doesn't have a stable
    // document-level XPath. Capybara uses the same marker string for
    // these as selenium/cuprite.
    for (let cur = start; cur; cur = cur._parent) {
      if (cur instanceof ShadowRoot) return '(: Shadow DOM element - no XPath :)';
    }
    const segments = [];
    let cur = start;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      const parent = cur._parent;
      if (!parent) break;
      const sibs = (parent._children || []).filter(c =>
        c.nodeType === NODE_ELEMENT && c._tag === cur._tag
      );
      const idx = sibs.indexOf(cur) + 1;
      segments.unshift(`${cur._tag}[${idx}]`);
      cur = parent;
    }
    return '/' + segments.join('/');
  };

  globalThis.__csimOptionContext = function (h) {
    const n = __handles.get(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return { hasSelect: false, multiple: false };
    let cur = n._parent;
    while (cur && cur._tag !== 'select') cur = cur._parent;
    if (!cur || cur._tag !== 'select') return { hasSelect: false, multiple: false };
    return { hasSelect: true, multiple: cur._attrs.multiple != null };
  };

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

  globalThis.__csimShadowRoot = function (h) {
    const el = __handles.get(h);
    const sr = el && el._shadowRoot;
    return sr && sr.mode === 'open' && sr._id != null ? sr._id : 0;
  };

  globalThis.__csimActiveElement = function () {
    const doc = globalThis.document;
    if (!doc) return 0;
    const el = doc._activeElement || doc.body || doc.documentElement;
    return el && el._id != null ? el._id : 0;
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

  globalThis.__csimAlive = function (h) {
    const n = __handles.get(h);
    return n != null && isConnected(n);
  };

  // Form-field value reader. Mirrors what Capybara reads via
  // Node#value: input/textarea use `.value`, select returns its
  // selected option value, checkbox / radio surface their `.value` only
  // when checked (rack-test parity).
  globalThis.__csimValue = function (h) {
    const n = lookup(h);
    if (!n || n.nodeType !== NODE_ELEMENT) return null;
    const tag = n._tag;
    if (tag === 'textarea') {
      // HTML spec: when initialised from parsed text, the textarea
      // value drops one leading newline that immediately follows the
      // open tag (the spec calls this "first newline removal"). After
      // a `set`, `_attrs.value` carries the user's intent verbatim,
      // so prefer that. The "one newline" is a single line terminator
      // — `\r\n` / `\r` / `\n` — not just `\n`, so we need to strip
      // CR + LF as a pair when Redmine sends a textarea body with CRLF
      // line endings (the default for forms responding via AJAX).
      if (n._attrs.value != null) return n._attrs.value;
      return __stripOneLeadingNewline(n.textContent);
    }
    if (tag === 'select') {
      const opts = n.querySelectorAll('option');
      const multi = n._attrs.multiple != null;
      // `<select multiple>` returns an array of every selected
      // option's value; single-select returns the first explicitly-
      // selected option, or the first non-disabled option as the
      // implicit default.
      if (multi) {
        const out = [];
        for (const o of opts) {
          if (o._attrs.selected != null) out.push(o._attrs.value != null ? o._attrs.value : o.textContent);
        }
        return out;
      }
      let implicit = null;
      for (const o of opts) {
        if (o._attrs.disabled != null) continue;
        if (o._attrs.selected != null) return o._attrs.value != null ? o._attrs.value : o.textContent;
        if (implicit == null) implicit = o._attrs.value != null ? o._attrs.value : o.textContent;
      }
      return implicit;
    }
    if (tag === 'input') {
      const type = (n._attrs.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return n._attrs.value != null ? n._attrs.value : 'on';
      return n._attrs.value != null ? n._attrs.value : '';
    }
    return n._attrs.value != null ? n._attrs.value : '';
  };

  // Element-targeted HTML access — what tests reach for via
  // `find('.x').native.inner_html` / `.outer_html`. Returns '' when
  // the handle no longer resolves rather than throwing; stale
  // handles are caught at the Ruby `check_stale` layer.
  globalThis.__csimInnerHTML = function (h) {
    const el = lookup(h);
    return el && el.nodeType === NODE_ELEMENT ? el.innerHTML : '';
  };
  globalThis.__csimOuterHTML = function (h) {
    const el = lookup(h);
    return el && el.nodeType === NODE_ELEMENT ? el.outerHTML : '';
  };

  // Document-level reads that don't need a handle.
  globalThis.__csimDocumentHtml = function () {
    return globalThis.document.documentElement
      ? serializeElement(globalThis.document.documentElement)
      : '';
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
  // Spec-minimal `<dialog>.close(returnValue)` — strip `open`,
  // dispatch a non-bubbling, non-cancelable `close` event. Turbo's
  // `confirm` flow waits on this event and reads `dialog.returnValue`
  // to decide whether to proceed.
  function closeDialog(dlg, returnValue) {
    if (!dlg || dlg._tag !== 'dialog') return;
    dlg.returnValue = String(returnValue == null ? '' : returnValue);
    if (Object.prototype.hasOwnProperty.call(dlg._attrs, 'open')) {
      const old = dlg._attrs.open;
      delete dlg._attrs.open;
      recordAttrMutation(dlg, 'open', old == null ? null : old);
    }
    try { dispatchEvent(dlg, new Event('close', { bubbles: false, cancelable: false })); } catch (_) {}
  }
  // Resolve a `<label>` element to its labeled form control per HTML
  // spec. Preference order: `for` attribute → first labelable
  // descendant (input / textarea / select / button / output / meter
  // / progress, excluding `input[type=hidden]`).
  function labeledControlFor(label) {
    const forId = label._attrs.for;
    if (forId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const hit = selectFirst([root], '#' + forId);
        if (hit) return hit;
      }
    }
    const LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
    const stack = [label];
    while (stack.length) {
      const cur = stack.shift();
      for (const c of cur._children) {
        if (c.nodeType !== NODE_ELEMENT) continue;
        if (LABELABLE.has(c._tag)) {
          if (c._tag === 'input' && (c._attrs.type || '').toLowerCase() === 'hidden') continue;
          return c;
        }
        stack.push(c);
      }
    }
    return null;
  }
  function isContenteditable(n) {
    let cur = n;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      const v = cur._attrs.contenteditable;
      if (v != null) {
        // contenteditable="" / "true" → editable; "false" → not.
        const lower = String(v).toLowerCase();
        if (lower === '' || lower === 'true' || lower === 'plaintext-only') return true;
        if (lower === 'false') return false;
      }
      cur = cur._parent;
    }
    return false;
  }

  function isSubmitButton(n) {
    if (n._tag === 'button') {
      const t = (n._attrs.type || 'submit').toLowerCase();
      return t === 'submit';
    }
    if (n._tag === 'input') {
      const t = (n._attrs.type || '').toLowerCase();
      return t === 'submit' || t === 'image';
    }
    return false;
  }
  function ancestorForm(n) {
    let cur = n._parent;
    while (cur && cur.nodeType === NODE_ELEMENT) {
      if (cur._tag === 'form') return cur;
      cur = cur._parent;
    }
    return null;
  }
  // HTML 5: a form control's owning form is resolved via either the
  // `form="<id>"` IDL attribute (looking up the form by id) or — when
  // absent — by walking ancestors. The attribute takes precedence
  // and is the only way to associate a button that lives *outside*
  // the form's DOM subtree.
  function formForControl(n) {
    const formId = n._attrs.form;
    if (formId) {
      const root = globalThis.document.documentElement;
      if (root) {
        const forms = root.getElementsByTagName('form');
        for (const f of forms) if (f._attrs.id === formId) return f;
      }
    }
    return ancestorForm(n);
  }
  function toggleChecked(n) {
    if (n._attrs.checked != null) delete n._attrs.checked;
    else n._attrs.checked = '';
  }
  function setRadio(n) {
    const name = n._attrs.name;
    if (name) {
      // siblings in same form sharing name: clear, then set this one
      const root = ancestorForm(n) || globalThis.document.documentElement;
      const candidates = root && root.querySelectorAll
        ? root.querySelectorAll('input')
        : [];
      for (const o of candidates) {
        if ((o._attrs.type || '').toLowerCase() === 'radio' && o._attrs.name === name) {
          delete o._attrs.checked;
        }
      }
    }
    n._attrs.checked = '';
  }

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
          : __stripOneLeadingNewline(f.textContent);
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
