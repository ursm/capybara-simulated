// DOM node classes — Node + Text + Comment + Element +
// DocumentFragment + ShadowRoot + Document + DocumentOrderRange +
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

import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOC, NODE_FRAGMENT } from './constants.js';
import { lookup, registerSubtree, unregisterSubtree }                from './handles.js';
import { dispatchEvent }                                              from './dispatch.js';
import { recordAttrMutation, recordChildList, recordCharacterData }   from './mutation-observer.js';
import { walk, walkSubtree, isConnected, classes, scriptText, stripOneLeadingNewline } from './walk.js';
import { selectAll, selectFirst, matchesSelector, closestSelector }   from './selectors.js';
import { findById }                                                   from './selector-parser.js';
import { isVisibleNode, INVISIBLE_TAGS, matchesAnyHideRule, selfHidden } from './cascade.js';
import { ceState, getCustomElementCtor, ceUpgradeTree, fireCEDisconnect, fireAttrChangedCallback, askForReset } from './custom-elements.js';
import { isContenteditable, formNamedAccess, toggleChecked, setRadio, isSubmitButton, formForControl, closeDialog } from './form-helpers.js';
import { makeStyleProxy }                                             from './style-proxy.js';
import { htmlCollection }                                             from './dom-collections.js';
import { Event, InputEvent, MouseEvent, SubmitEvent }                 from './events.js';
import { installHtmlParser, serializeChildren, serializeElement, escapeText } from './html-parser.js';

let __nextId = 1;
// Carry the registered tag through `new SomeCustomElement()` so the
// Element base ctor can populate `_tag` even when the subclass
// doesn't call super(tag). Browsers do this via a per-construction
// queue; the single-threaded JS engine lets us collapse to a slot.
let __currentTag = null;

// Used by `ChildNode.before/after/replaceWith` + `ParentNode.append
// /prepend` to accept strings (auto-wrap as Text) alongside nodes.
function toNode(v) {
  if (v && (v.nodeType === NODE_ELEMENT || v.nodeType === NODE_TEXT || v.nodeType === NODE_FRAGMENT || v.nodeType === NODE_DOC)) return v;
  return new Text(v == null ? '' : String(v));
}

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
    // is just a sentinel. Uses the spec `DOMRect` class so
    // `instanceof DOMRect` probes succeed.
    const visible = isVisibleNode(this);
    return new globalThis.DOMRect(0, 0, visible ? 1 : 0, visible ? 1 : 0);
  }
  getClientRects() {
    return isVisibleNode(this) ? [new globalThis.DOMRect(0, 0, 1, 1)] : [];
  }
  // CSSOM-View Level 5: returns false when the element is invisible
  // (display:none, hidden attr, etc). `opts.checkVisibilityCSS` /
  // `checkOpacity` are nuances we don't model — defer to the same
  // visibility predicate as `isVisibleNode`.
  checkVisibility(_opts) { return isVisibleNode(this); }
  // Web Animations API stub: returns a no-op Animation-shaped object.
  // Tailwind transitions / motion-one feature-probe `el.animate?.`
  // and bail to a CSS class fallback when it's absent; returning a
  // resolved-shape stub keeps the JS-side animate branch alive.
  animate(_keyframes, _options) {
    const anim = {
      playState: 'finished',
      finished:  Promise.resolve(this),
      ready:     Promise.resolve(this),
      cancel() {}, finish() {}, pause() {}, play() {}, reverse() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
    };
    return anim;
  }
  getAnimations(_opts) { return []; }
  get offsetWidth()  { return isVisibleNode(this) ? 1 : 0; }
  get offsetHeight() { return isVisibleNode(this) ? 1 : 0; }
  get clientWidth()  { return isVisibleNode(this) ? 1 : 0; }
  get clientHeight() { return isVisibleNode(this) ? 1 : 0; }
  get scrollWidth()  { return isVisibleNode(this) ? 1 : 0; }
  // Approximate scrollHeight as 20px/line over 80 chars/line so
  // content-length gates fire. Avo's Trix body checks
  // `scrollHeight > some-threshold` to decide whether to inject the
  // "More content" expander; a flat `1` keeps it from ever rendering.
  // Counts element children only (whitespace text nodes between
  // formatted HTML would otherwise inflate the count and trip the
  // gate on short content).
  get scrollHeight() {
    if (!isVisibleNode(this)) return 0;
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
  // scrollIntoView({behavior, block, inline}) — without layout we
  // can't actually scroll, but accepting the options arg keeps smooth-
  // scroll polyfills from bailing on the feature-probe ("If
  // scrollIntoView accepts an options object…").
  scrollIntoView(_opts) { /* no-op */ }
  scrollIntoViewIfNeeded(_opts) { /* no-op */ }
  scrollTo()  { /* no-op */ }
  scrollBy()  { /* no-op */ }

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
      // Mirrors `globalThis.__csimPendingFormSubmit`.
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
  // ParentNode.replaceChildren(...nodes) — DOM spec: clear then append.
  // React 19 / Stimulus controllers reach for it as the modern
  // shorthand instead of `el.innerHTML = ''` + appendChild.
  replaceChildren(...nodes) {
    while (this._children.length) this.removeChild(this._children[this._children.length - 1]);
    for (const n of nodes) this.appendChild(toNode(n));
  }
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
        if (isConnected(this)) globalThis.__csimFireCEConnect(c);
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
    if (isConnected(this)) globalThis.__csimFireCEConnect(child);
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
        if (isConnected(this)) globalThis.__csimFireCEConnect(c);
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
    if (isConnected(this)) globalThis.__csimFireCEConnect(child);
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
    if (wasConnected) { fireCEDisconnect(old); globalThis.__csimFireCEConnect(neu); }
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
  getBoundingClientRect() { return new globalThis.DOMRect(0, 0, 0, 0); }
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
    const u = globalThis.__csim_parseUrl(v, base);
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
  // submit path in `globalThis.__csimClickResolve` is the close trigger; show
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
    return htmlCollection(all.filter(n => n !== this));
  }
  getElementsByClassName(cls) {
    const sel = String(cls).split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
    return htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
  }
  getElementsByName(name) {
    const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
    return htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
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
  // HTML spec: `el.hidden` reflects the `hidden` content attribute as
  // a boolean. Stimulus controllers commonly do `el.hidden = true`
  // instead of `el.setAttribute('hidden', '')`; without the setter
  // those toggles silently lose the attribute.
  get hidden()    { return this._attrs.hidden != null; }
  set hidden(v)   { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  // HTML Popover API — `el.popover` reflects the `popover` attribute
  // ('' / 'auto' / 'manual' / 'hint'). `showPopover` / `hidePopover`
  // / `togglePopover` flip a UA `:popover-open` state which we track
  // on `_popoverOpen`. Fire `toggle` / `beforetoggle` events per spec.
  get popover()  { return this._attrs.popover == null ? null : (this._attrs.popover || 'auto'); }
  set popover(v) {
    if (v == null) this.removeAttribute('popover');
    else this.setAttribute('popover', String(v));
  }
  showPopover() {
    if (this._popoverOpen) return;
    try { dispatchEvent(this, new Event('beforetoggle', { bubbles: false, cancelable: true })); } catch (_) {}
    this._popoverOpen = true;
    try { dispatchEvent(this, new Event('toggle', { bubbles: false, cancelable: false })); } catch (_) {}
  }
  hidePopover() {
    if (!this._popoverOpen) return;
    try { dispatchEvent(this, new Event('beforetoggle', { bubbles: false, cancelable: true })); } catch (_) {}
    this._popoverOpen = false;
    try { dispatchEvent(this, new Event('toggle', { bubbles: false, cancelable: false })); } catch (_) {}
  }
  togglePopover(force) {
    const next = force != null ? !!force : !this._popoverOpen;
    if (next) this.showPopover(); else this.hidePopover();
    return this._popoverOpen;
  }

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
    // Writes go through `setAttribute('class', ...)` (not direct
    // `_attrs['class'] =`) so MutationObserver + cascade + CE
    // `attributeChangedCallback` all see the change. Without that,
    // `classList.remove('hidden')` on a tab pane silently skipped the
    // IntersectionObserver recheck that reveals lazy turbo-frames.
    const commit = (cs) => el.setAttribute('class', cs.join(' '));
    return {
      contains(c) { return classes(el).includes(c); },
      add(...names) {
        const cs = classes(el);
        let changed = false;
        for (const n of names) if (!cs.includes(n)) { cs.push(n); changed = true; }
        if (changed) commit(cs);
      },
      remove(...names) {
        const cs   = classes(el);
        const drop = new Set(names);
        if (!cs.some(c => drop.has(c))) return;
        commit(cs.filter(x => !drop.has(x)));
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
        commit(cs);
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
        commit(cs);
        return true;
      },
      item(i) {
        const cs = classes(el);
        return i >= 0 && i < cs.length ? cs[i] : null;
      },
      get length() { return classes(el).length; },
      get value()  { return el._attrs['class'] || ''; },
      set value(v) { el.setAttribute('class', v == null ? '' : String(v)); },
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
    return form ? formNamedAccess(form) : null;
  }
  // Form-control IDL attributes — expose the pair-of-attr-and-IDL
  // shape so JS like `input.value = 'x'` / `input.checked = true`
  // works and reads back via `globalThis.__csimValue` / serialised attrs alike.
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
      return stripOneLeadingNewline(this.textContent);
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
      const u = globalThis.__csim_parseUrl(a, base);
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
  get willValidate() {
    if (this._tag === 'form') return true;
    if (this._tag !== 'input' && this._tag !== 'textarea' && this._tag !== 'select') return false;
    if ((this._attrs.type || '').toLowerCase() === 'hidden') return false;
    if (this._attrs.disabled != null || this._attrs.readonly != null) return false;
    return true;
  }
  checkValidity() {
    if (this._tag === 'form') {
      let allValid = true;
      for (const el of this.elements || []) {
        if (typeof el.checkValidity === 'function' && !el.checkValidity()) allValid = false;
      }
      return allValid;
    }
    if (!this.willValidate) return true;
    if (this.validity.valid) return true;
    // Real browsers fire `invalid` as a cancelable, non-bubbling event
    // on each invalid form control. Discourse's
    // `lib/form-template-validation.js` listens for it to populate
    // `.form-template-field__error`. Default action would be UA error
    // tooltip, which we don't render — we just need to dispatch.
    try { dispatchEvent(this, new globalThis.Event('invalid', { bubbles: false, cancelable: true })); } catch (_) {}
    return false;
  }
  reportValidity()        { return this.checkValidity(); }
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
    // HTML spec: select() focuses the input as a side effect.
    this.focus();
    this._selectionStart = 0;
    this._selectionEnd   = (this._attrs.value || '').length;
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
    return htmlCollection(all.filter(n => n !== this));
  }
  getElementsByClassName(cls) {
    const sel = String(cls).split(/\s+/).filter(Boolean).map(c => '.' + c).join('');
    return htmlCollection(this.querySelectorAll(sel).filter(n => n !== this));
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
  // Modern feature-detection slots — apps that probe
  // `document.fullscreenElement` / `pictureInPictureElement` / etc.
  // before calling the respective `request…` shouldn't get a missing-
  // property crash. We have no real fullscreen / PiP, so always null.
  get fullscreenElement()        { return null; }
  get pictureInPictureElement()  { return null; }
  get pointerLockElement()       { return null; }
  // `document.styleSheets` is a live StyleSheetList of every
  // `<style>` and `<link rel=stylesheet>` in the document. We build
  // CSSStyleSheet shells (no real CSSOM) so apps that enumerate
  // sheets (Webpack style-loader, Lit's adopted-stylesheet probe)
  // don't crash on the missing list.
  get styleSheets() {
    const list = [];
    if (this.documentElement) walkSubtree(this.documentElement, n => {
      if (n.nodeType !== NODE_ELEMENT) return;
      if (n._tag === 'style') {
        const ss = new globalThis.CSSStyleSheet();
        ss.ownerNode = n;
        const text = (n._children || []).map(c => c.data || '').join('');
        ss.replaceSync(text);
        list.push(ss);
      } else if (n._tag === 'link' && (n._attrs.rel || '').toLowerCase().includes('stylesheet')) {
        const ss = new globalThis.CSSStyleSheet({baseURL: n._attrs.href});
        ss.ownerNode = n;
        list.push(ss);
      }
    });
    list.item = i => list[i] || null;
    return list;
  }
  // `document.adoptedStyleSheets` — empty Array per spec when no
  // sheets adopted. Lit/Stencil's component init reads this.
  get adoptedStyleSheets()  { return []; }
  set adoptedStyleSheets(_) { /* discard */ }
  exitFullscreen()       { return Promise.resolve(); }
  exitPictureInPicture() { return Promise.resolve(); }
  exitPointerLock()      {}
  // CSSOM-View `document.elementFromPoint(x, y)` — without layout we
  // can't pick a "topmost at coords" element. Spec-compliant fallback:
  // return the body's last laid-out descendant (the "deepest visible"
  // tree position). For drag-drop libs that just need ANY element
  // back (rather than null) this keeps the chain alive.
  elementFromPoint(_x, _y) {
    const body = this.body;
    if (!body) return null;
    let last = null;
    walkSubtree(body, n => {
      if (n.nodeType === NODE_ELEMENT && globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(n)) last = n;
    });
    return last;
  }
  elementsFromPoint(x, y) {
    const el = this.elementFromPoint(x, y);
    if (!el) return [];
    const out = [];
    for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) out.push(cur);
    return out;
  }
  // Currently-executing `<script>` element (set by `runInlineScripts`
  // around `globalThis.__csim_runScript`). Bundlers read `currentScript.src` to
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
    // Each per-visit `globalThis.__csimLoadDocument` flips us to 'complete'
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
    // gets assigned. The per-visit `globalThis.__csimLoadDocument` swaps
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
  set location(v)     { globalThis.__locationAssign(String(v)); }
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
  // host fns (`globalThis.__getDocumentCookie` / `globalThis.__setDocumentCookie`) own
  // the storage; Browser-side cookies survive ctx rebuilds.
  get cookie()        { return globalThis.__getDocumentCookie() || ''; }
  set cookie(v)       { globalThis.__setDocumentCookie(String(v == null ? '' : v)); }
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
    const accept = (n) => {
      const mask = 1 << (n.nodeType - 1);
      if (!(mask & whatToShow)) return 3; // FILTER_SKIP
      if (filter) {
        const fn = typeof filter === 'function' ? filter : (filter && filter.acceptNode);
        if (fn) {
          const r = fn.call(filter || null, n);
          if (r === 2 || r === 3 || r === false) return 3;
        }
      }
      return 1;
    };
    let i = -1;
    return {
      root,
      whatToShow,
      filter,
      referenceNode: root,
      pointerBeforeReferenceNode: true,
      nextNode() {
        while (++i < all.length) {
          if (accept(all[i]) !== 1) continue;
          this.referenceNode = all[i];
          this.pointerBeforeReferenceNode = false;
          return all[i];
        }
        return null;
      },
      previousNode() {
        while (--i >= 0) {
          if (accept(all[i]) !== 1) continue;
          this.referenceNode = all[i];
          this.pointerBeforeReferenceNode = false;
          return all[i];
        }
        return null;
      },
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
  // `document.execCommand(command, showUI, value)` — deprecated but
  // still in real browsers. Discourse's d-editor uses
  // `execCommand('insertText', false, str)` to insert upload
  // placeholders into the composer textarea while the upload is
  // running; without it, Uppy emits an `error` event and the upload
  // never completes. We implement only the commands the suite actually
  // exercises (`insertText`, `copy`); everything else is a tolerant
  // no-op returning false.
  execCommand(command, _showUI, value) {
    const cmd = String(command || '').toLowerCase();
    const active = this._activeElement;
    if (cmd === 'copy') {
      // Selection-based copy works even without an activeElement, so
      // this runs before the `!active` gate below.
      let text = '';
      if (active && (active._tag === 'input' || active._tag === 'textarea')) {
        const v = String(active._attrs.value || '');
        text = v.slice(active.selectionStart, active.selectionEnd);
      } else {
        const sel = globalThis.getSelection && globalThis.getSelection();
        if (sel && typeof sel.toString === 'function') text = sel.toString();
      }
      globalThis.__csimClipboardSet(text);
      return true;
    }
    if (!active) return false;
    if (cmd === 'inserttext') {
      const str = value == null ? '' : String(value);
      if (active._tag === 'textarea' || (active._tag === 'input' && /^(text|search|email|url|tel|password)?$/i.test(active._attrs.type || ''))) {
        const cur  = String(active._attrs.value == null ? '' : active._attrs.value);
        const ss   = (active.selectionStart  == null ? cur.length : active.selectionStart);
        const se   = (active.selectionEnd    == null ? cur.length : active.selectionEnd);
        const next = cur.slice(0, ss) + str + cur.slice(se);
        active._attrs.value = next;
        active.selectionStart = active.selectionEnd = ss + str.length;
        try { dispatchEvent(active, new globalThis.InputEvent('input', { bubbles: true, cancelable: true, data: str, inputType: 'insertText' })); } catch (_) {}
        return true;
      }
      // contenteditable: append as a text node at the caret. Selection
      // collapse to end. Selection API insertion would be more
      // accurate but the editors that use this path (Discourse) only
      // care that the text lands in the contenteditable surface.
      if (active._attrs.contenteditable != null && (active._attrs.contenteditable || '').toLowerCase() !== 'false') {
        const text = new Text(str);
        active._children.push(text);
        text._parent = active;
        try { dispatchEvent(active, new globalThis.InputEvent('input', { bubbles: true, cancelable: true, data: str, inputType: 'insertText' })); } catch (_) {}
        return true;
      }
    }
    return false;
  }
  queryCommandSupported(command) {
    const c = String(command || '').toLowerCase();
    return c === 'inserttext' || c === 'copy';
  }
  queryCommandEnabled(command) { return this.queryCommandSupported(command); }
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
  getBoundingClientRect() { return new globalThis.DOMRect(0, 0, 0, 0); }
  cloneRange() {
    const r = new DocumentOrderRange();
    r.startContainer = this.startContainer; r.startOffset = this.startOffset;
    r.endContainer   = this.endContainer;   r.endOffset   = this.endOffset;
    return r;
  }
  // DOM spec Range#toString: concatenates the text of all Text nodes
  // wholly or partly contained within the range, slicing the
  // boundary text nodes by start/end offset. Selection-API consumers
  // (Tiptap's domchange, Trix's range readback, our own `copy`
  // execCommand fallback) need this.
  toString() {
    const sc = this.startContainer, ec = this.endContainer;
    if (!sc || !ec) return '';
    if (sc === ec && sc.nodeType === NODE_TEXT) {
      const data = sc.data || '';
      return data.slice(this.startOffset, this.endOffset);
    }
    let out = '';
    let inRange = false;
    let done = false;
    walkSubtree(this.commonAncestorContainer || sc, n => {
      if (done) return;
      if (n === sc) {
        inRange = true;
        if (sc.nodeType === NODE_TEXT) out += (sc.data || '').slice(this.startOffset);
        return;
      }
      if (n === ec) {
        if (ec.nodeType === NODE_TEXT) out += (ec.data || '').slice(0, this.endOffset);
        done = true;
        return;
      }
      if (inRange && n.nodeType === NODE_TEXT) out += n.data || '';
    });
    return out;
  }
  // Range#insertNode(node): inserts `node` at the start of the range.
  // Per DOM spec, splits a Text startContainer at the offset, then
  // inserts the new node before the second half. For Element
  // containers, inserts at child index `startOffset`. Tiptap /
  // ProseMirror's text-insertion fallback uses this.
  insertNode(node) {
    const sc = this.startContainer;
    if (!sc) return;
    if (sc.nodeType === NODE_TEXT) {
      const parent = sc._parent;
      if (!parent) return;
      const text = sc.data || '';
      const before = text.slice(0, this.startOffset);
      const after  = text.slice(this.startOffset);
      sc.data = before;
      const idx = parent._children.indexOf(sc);
      if (after.length > 0) {
        const tail = new Text(after);
        parent.insertBefore(tail, parent._children[idx + 1] || null);
      }
      parent.insertBefore(node, parent._children[idx + 1] || null);
    } else {
      const ref = sc._children ? sc._children[this.startOffset] : null;
      sc.insertBefore(node, ref || null);
    }
    // Collapse range to just after the inserted node.
    this.setStartAfter(node);
    this.collapse(true);
  }
  // Range#surroundContents(newParent): extract range contents, wrap
  // in `newParent`, insert wrapper at the range's start. Used by
  // highlight / annotate libraries.
  surroundContents(newParent) {
    const frag = this.extractContents();
    newParent.appendChild(frag);
    this.insertNode(newParent);
  }
  // Range#comparePoint(node, offset) — -1/0/+1 vs the range.
  // Range#isPointInRange(node, offset) — true if inside.
  comparePoint(node, offset) {
    if (!this.startContainer || !this.endContainer) return 0;
    if (compareDocOrder(node, this.startContainer) < 0) return -1;
    if (compareDocOrder(node, this.endContainer)   > 0) return  1;
    return 0;
  }
  isPointInRange(node, offset) {
    return this.comparePoint(node, offset) === 0;
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
DocumentOrderRange.END_TO_START   = 3;
DocumentOrderRange.prototype.START_TO_START = 0;
DocumentOrderRange.prototype.START_TO_END   = 1;
DocumentOrderRange.prototype.END_TO_END     = 2;
DocumentOrderRange.prototype.END_TO_START   = 3;

// Helper: is `descendant` either equal to or contained in `ancestor`?
export function nodeContains(ancestor, descendant) {
  return ancestor != null && ancestor.contains ? ancestor.contains(descendant) : false;
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
export function rangeIntersectsNode(range, node) {
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
    globalThis.__notifySelectionChange();
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
  globalThis.__notifySelectionChange();
  return true;
}
globalThis.__csimInsertTextAtSelection = __csimInsertTextAtSelection;

export function deleteRangeContents (range) {
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
export function cloneRangeContents (range) {
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

// HTML parser closes over the DOM ctors. Install here so
// `parseDocument` / `parseFragment` are available to the Element
// IDL methods (`innerHTML` setter, `insertAdjacentHTML`, etc.)
// without going through bridge.entry.js.
const { parseDocument, parseFragment } = installHtmlParser({ Document, Element, Text, DocumentFragment });

export {
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
  parseFragment
};
