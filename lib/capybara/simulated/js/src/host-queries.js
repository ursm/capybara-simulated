// Small read-only host fns Capybara calls from Ruby via
// `Context#call('__csim<Op>', args)`. Document-level reads,
// querySelector / querySelectorAll batching, XPath evaluation, and
// per-element field accessors (`node.text`, `node.tag_name`,
// `node[name]`, `node.has_attr?`). One V8 round-trip per Capybara
// DSL operation — not per internal DOM op.

import { NODE_DOC, NODE_ELEMENT, NODE_FRAGMENT, isHtml, htmlLocalName } from './constants.js';
import { documentOriginIsOpaque }       from './document-origin.js';
import { frameRealmOf, handleOf, lookup } from './handles.js';
import { isConnected } from './walk.js';
import { serializeElement }             from './html-parser.js';
import { controlLiveValue, isActuallyDisabled, optionValue } from './form-helpers.js';
import { documentElementOf } from './document-tree.js';
import { selectAll, selectFirst } from './selectors.js';
import { activeElementOf, shadowRootMode } from './dom-nodes.js';
import { inputValue } from './html-input.js';
import {
  FN_COMMIT_PENDING, FN_URL_HISTORY, FN_URL_SRC, NAVIGATION_BLOCKED, NO_NAVIGABLE, TOP_NAVIGABLE, frameNavHas, setFrameNav,
  setFrameNavUrl, supersedeFrameNavigation
} from './frame-nav.js';
import { optionSelectOf, selectedOptionsOf } from './native-query-shadow.js';
import { logError } from './console.js';

// HTML spec: the `document.title` getter strips and collapses ASCII
// whitespace in the title element's child text content (runs of
// `[\t\n\f\r ]+` → single space, plus leading/trailing trim). Without
// this, server-rendered titles that go through emoji-strip-with-gap
// expansions (Discourse's `gsub_emoji_to_unicode` for a denied emoji
// leaves a double space where `:name:` used to be) reach the test as
// raw textContent and assertions on `page.title` fail vs the
// real-browser-canonical normalisation.
globalThis.__csimDocumentTitle = function () {
  // Delegate to the spec-correct `document.title` getter (tree-order HTML title
  // / SVG-root title, namespace-aware, child-text-content with the same
  // whitespace strip+collapse) so `page.title` can't diverge from it.
  return globalThis.document.title;
};

// Query under `root` (handle, or 0 for document). Returns array of
// handles; Ruby resolves each via accessors below.
globalThis.__csimQuery = function (rootHandle, selector) {
  const root = rootHandle ? lookup(rootHandle) : globalThis.document;
  if (!root) return [];
  return selectAll(root, selector).map(handleOf);
};

// XPath evaluation through `document.evaluate` (js/src/xpath.js, over
// xpath.rs). We use ORDERED_NODE_SNAPSHOT_TYPE (7) so the result is a
// snapshot array we can iterate by index, matching Capybara's order
// expectations.
globalThis.__csimEvaluateXPath = function (xpath, contextHandle) {
  const ctx = contextHandle ? lookup(contextHandle) : globalThis.document;
  if (!ctx) return [];
  let result;
  try {
    result = globalThis.document.evaluate(String(xpath), ctx, null, 7, null);
  } catch (e) {
    try { logError('[csim] XPath threw:', e && e.message, 'for', xpath); } catch (_) {}
    return [];
  }
  const out = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const h = handleOf(result.snapshotItem(i));
    if (h !== 0) out.push(h);
  }
  return out;
};

globalThis.__csimQueryOne = function (rootHandle, selector) {
  const root = rootHandle ? lookup(rootHandle) : globalThis.document;
  if (!root) return 0;
  const hit = root._nodeType === NODE_DOC || root._nodeType === NODE_ELEMENT || root._nodeType === NODE_FRAGMENT
    ? selectFirst(root, selector)
    : null;
  return handleOf(hit);
};

globalThis.__csimText = function (h) {
  const n = lookup(h);
  return n ? n._textContent : '';
};

globalThis.__csimTag = function (h) {
  const n = lookup(h);
  if (!n) return '';
  if (n._tag) return n._tag;
  if (n instanceof globalThis.ShadowRoot) return 'ShadowRoot';
  return '';
};

// Trace `description` helper: `{tag, id, cls}` for a CSS-selector-ish
// short form. Class is truncated to the first whitespace-separated
// token so a node with 10 utility classes doesn't drown the trace.
globalThis.__csimDescribeNode = function (h) {
  const n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) return null;
  const cls = (n._attrs.class || '').trim().split(/\s+/)[0] || '';
  return { tag: n._tag || '', id: n._attrs.id || '', cls };
};

// Capybara's `node[name]` reads either a content attribute or an
// IDL property. Selenium / Cuprite both prefer the IDL property
// when one exists for the named attribute, so `link[:href]` returns
// the URL-resolved absolute href rather than the raw attribute.
// Integer-typed IDL reflections per HTML spec: the IDL property
// returns a parsed Number, not the raw attribute string. Selenium
// (and therefore Capybara's selenium driver) honours this via
// `getProperty`, so a spec assertion like `find('ol')['start']`
// expects `5` not `"5"`. A small set of well-known integer attributes —
// by tag, each name (its content attribute's or its IDL attribute's) the IDL
// attribute it reads, whose reflection parses it as HTML says (a `colspan="0"`
// is 1) — answers so where its content attribute is there; any other name
// (`getAttribute`) keeps returning the string. (…of no prototype: a `<constructor>` is no tag of it)
const __csimIntAttrIDLs = {
  __proto__: null,
  ol:       { start: 'start' },
  li:       { value: 'value' },
  td:       { colspan: 'colSpan', rowspan: 'rowSpan' },
  th:       { colspan: 'colSpan', rowspan: 'rowSpan' },
  input:    { maxlength: 'maxLength', minlength: 'minLength', size: 'size' },
  textarea: { cols: 'cols', rows: 'rows', maxlength: 'maxLength', minlength: 'minLength' },
  select:   { size: 'size' },
  img:      { width: 'width', height: 'height' }
};
// Mirror that here for the URL-reflecting attributes plus the
// well-known form-control IDLs.
globalThis.__csimAttr = function (h, name) {
  const n = lookup(h);
  if (!n) return null;
  const s = String(name);
  switch (s) {
    case 'validationMessage': return n.validationMessage || '';
    case 'validity':          return n.validity || null;
    case 'innerHTML':         return n._nodeType === NODE_ELEMENT ? n._innerHTML : null;
    case 'outerHTML':         return n._nodeType === NODE_ELEMENT ? n._outerHTML : null;
    case 'innerText': {
      // The node's rendered text — what the `Element#innerText` getter is made of (rendered.rs `visible_text`).
      const raw = typeof globalThis.__csimVisibleText === 'function' ? globalThis.__csimVisibleText(h)
                : typeof n.innerText === 'string' ? n.innerText
                : null;
      return raw;
    }
    case 'textContent':       return typeof n.textContent === 'string' ? n.textContent : null;
    case 'checked':           return !!n.checked;
    case 'disabled':          return !!n.disabled;
    case 'value':             return n.value != null ? n.value : '';
    case 'href':
    case 'src':
      if (typeof n[s] === 'string') return n[s];
      break;
  }
  const ints = htmlLocalName(n) && __csimIntAttrIDLs[htmlLocalName(n)];
  const content = s.toLowerCase();
  if (ints && Object.hasOwn(ints, content) && n._getAttribute(content) != null) return n[ints[content]];
  // ARIA IDL reflection: `el.ariaExpanded` etc. map to the matching
  // `aria-*` content attribute per the ARIAMixin spec, so Selenium /
  // Cuprite's `getAttribute("ariaExpanded")` returns the content
  // attribute value via the IDL property path. Without this hop,
  // Discourse's `replies_button[:ariaExpanded]` reads `null` instead
  // of `"true"`.
  if (s.length > 4 && s.startsWith('aria') && s[4] >= 'A' && s[4] <= 'Z' && n._getAttribute) {
    return n._getAttribute('aria-' + s[4].toLowerCase() + s.slice(5));
  }
  return n._getAttribute ? n._getAttribute(s) : null;
};

globalThis.__csimOptionSelected = function (h) {
  const n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT || !isHtml(n, 'option')) return false;
  // Selectedness is maintained eagerly by the selectedness setting
  // algorithm (custom-elements.js) on parse / insert / remove / pick, so
  // the implicit single-select default is already materialised on the
  // first non-disabled option — no per-read scan needed.
  return n._selectedness === true;
};

// `disabled?` shares the HTML "actually disabled" algorithm with the `:disabled`
// CSS pseudo (form-helpers isActuallyDisabled) so the two can never disagree:
// own `[disabled]`, a control in a disabled `<fieldset>`, or an option/optgroup in
// a disabled `<select>` / optgroup.
globalThis.__csimDisabled = function (h) {
  return isActuallyDisabled(lookup(h));
};

// The document's base URL (`documentBaseURL`: its `<base href>`'s, else its fallback base URL) — '' for no document.
globalThis.__csimBaseURL = function () {
  return globalThis.document ? globalThis.document._baseURI : '';
};

globalThis.__csimNodePath = function (h) {
  const start = lookup(h);
  if (!start || start._nodeType !== NODE_ELEMENT) return '';
  // (…the engine's, xpath.rs `node_path`: none for a node in a shadow tree, which has no stable document-level XPath —
  // Capybara uses the same marker string for these as selenium/cuprite)
  return globalThis.__dom.nodePath(start._nid) ?? '(: Shadow DOM element - no XPath :)';
};

globalThis.__csimOptionContext = function (h) {
  const n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) return { hasSelect: false, multiple: false };
  const cur = optionSelectOf(n);
  if (!cur) return { hasSelect: false, multiple: false };
  return { hasSelect: true, multiple: cur._attrs.multiple != null };
};

globalThis.__csimShadowRoot = function (h) {
  const el = lookup(h);
  const sr = el && el._shadowRoot;
  return sr && shadowRootMode(sr) === 'open' ? handleOf(sr) : 0;
};

// Capybara's `Session#active_element`: `document.activeElement` — a focused element in a shadow tree retargeted to its
// host, as Chrome answers a driver; with nothing focused the body, else the document element.
globalThis.__csimActiveElement = function () {
  const doc = globalThis.document;
  return doc ? handleOf(activeElementOf(doc)) : 0;
};

// "Alive" = the node behind this handle is still attached to the document tree: a handle names its node for as long as
// the node lives (handles.js), in a document or not, so "it names a node" isn't "still in the document". Capybara's
// stale-node detection depends on this: a node that's been removed from the DOM must report as stale on the next read.
globalThis.__csimAlive = function (h) {
  const n = lookup(h);
  return n != null && isConnected(n);
};

// `switch_to_frame` entry point: given an `<iframe>` / `<frame>` handle in
// THIS realm, force its nested browsing context to exist (the realm is built
// lazily on first `contentWindow` access) and return the realm's context id,
// or 0 when no per-frame realm is available (the same-realm fallback past the
// nesting-depth guard, or a non-frame element). Ruby then routes the `within_frame` body's DOM ops
// into that realm via `V8Runtime#realm_call`.
globalThis.__csimEnsureFrameRealm = function (h) {
  const el = lookup(h);
  if (!el || (!isHtml(el, 'iframe') && !isHtml(el, 'frame'))) return 0;
  if (typeof globalThis.__csimFrameWindow !== 'function') return 0;
  globalThis.__csimFrameWindow(el);   // builds + loads the realm if needed
  return frameRealmOf(el) ?? 0;
};

// This realm's own browsing-context URL (`window.location.href`). Read by the
// Browser to resolve a frame-relative navigation and set the request referrer.
globalThis.__csimLocationHref = function () {
  return (globalThis.location && globalThis.location.href) || '';
};

// This realm's document's policy container's referrer policy, as its `<meta name="referrer">` elements have set it —
// each as it was connected or its `name` / `content` changed, the last to run winning (url_ops.rs
// `meta_referrer_steps`): what a navigation the document makes, and a fetch or XHR whose request names none, is sent
// under (`containerReferrerPolicy`, compute_referrer). '' = none set → the platform default
// (strict-origin-when-cross-origin).
globalThis.__csimDocumentReferrerPolicy = function () {
  const doc = globalThis.document;
  return doc ? globalThis.__dom.metaReferrerPolicy(doc._nid) : '';
};
// …and whether its origin is opaque (a sandboxed document's, without `allow-same-origin`), which refers as no document:
// Referrer Policy's "determine request's referrer" returns no referrer for it, before a srcdoc one looks to its container.
globalThis.__csimDocumentOriginOpaque = documentOriginIsOpaque;
// Which navigable realm `realm`'s document is the active document of (navigables.rs `realm_navigable`), 0 for none.
globalThis.__csimRealmNavigable = (realm) => globalThis.__dom.realmNavigable(realm);

// A new frame realm's document is the active document of the container's navigable (navigables.rs), linked as the
// realm is made (-1: none, a load that failed).
globalThis.__csimLinkFrameRealm = function (container, realm) {
  globalThis.__dom.setFrameRealm(container, realm);
};

// The navigable a target name chooses from this realm's browsing context (navigables.rs `findNavigable`): a frame's
// realm — made now, where its navigable has no document yet — or one of frame-nav.js's sentinels.
globalThis.__csimFindNamedFrame = function (name) {
  const found = globalThis.__dom.findNavigable(String(name));
  if (found === false) return NAVIGATION_BLOCKED;
  if (!found) return NO_NAVIGABLE;
  const [realm, container, parent, window] = found;
  // (…another window of this isolate's, which a hyperlink's navigation by name does not reach yet: a new one's then)
  if (window) return NO_NAVIGABLE;
  if (!container) return TOP_NAVIGABLE;
  if (realm >= 0) return realm;
  try { globalThis.RustyRacer.contextGlobal(parent).__csimFrameWindow(container); } catch (_) {}
  return frameRealmOf(container) ?? NO_NAVIGABLE;
};
// …and the one `_top` or `_parent` (`keyword`, TARGET_TOP / TARGET_PARENT) chooses from this realm's (navigables.rs
// `keyword_navigable`): its realm — TOP_NAVIGABLE for the page's — or NAVIGATION_BLOCKED where its document may not
// navigate it.
globalThis.__csimKeywordNavigable = function (keyword) {
  const realm = globalThis.__dom.keywordNavigable(keyword);
  return realm < 0 ? NAVIGATION_BLOCKED : realm === 0 ? TOP_NAVIGABLE : realm;
};

// Point an `<iframe>` element at a freshly (re)built frame realm after a
// frame-scoped navigation. Runs in the PARENT realm (where the element lives):
// drops the element's cached window and swaps the id in the parent's
// child-realm step set so `drainChildRealms` steps the new realm's event loop
// (and stops stepping the disposed one). Mirrors what `__csimFrameWindow` does
// on the lazy first build, which the Ruby-driven reload path bypasses.
globalThis.__csimRebindFrameRealm = function (h, oldId, newId) {
  const el = lookup(h);
  if (el) {
    el._frameWindow = null;
    // (…the host's navigation committed, a `src` one still waiting for its response is over: Chrome's later one wins)
    if (frameNavHas(el, FN_COMMIT_PENDING)) supersedeFrameNavigation(el);
    setFrameNav(el, FN_COMMIT_PENDING, false);
    setFrameNavUrl(el, FN_URL_SRC, undefined);
    setFrameNavUrl(el, FN_URL_HISTORY, undefined);
    // (…its navigable's active document the new realm's: linked as the realm was made where the host found the
    // container, and here — the element itself in hand — in any case)
    if (newId) globalThis.__dom.setFrameRealm(el._nid, newId);
  }
};

// Form-field value reader — what Capybara reads via Node#value. Mirrors the
// SELENIUM driver (single select / input / textarea read the `value` IDL; a
// `multiple` select maps its selected options), not the rack-test driver: this
// is a browser-shaped driver, so real-browser semantics win where the two
// differ (rack-test falls back to the first option and reads raw option text).
// checkbox / radio surface their `.value` (defaulting to 'on') whether or not
// they are checked, as in a real browser; `checked?` is a separate query. An input's is its `value` IDL's, the engine's
// by its value mode — sanitized (an email's " a@b " reads "a@b"), a file input's its fakepath — where the raw live value
// it read diverged from what a page's script reads.
globalThis.__csimValue = function (h) {
  const n = lookup(h);
  if (!n || n._nodeType !== NODE_ELEMENT) return null;
  const tag = htmlLocalName(n);
  if (tag === 'textarea') {
    // The live value: `_value` after a `set`/typing edit (dirty value flag),
    // else the child text content as-is. HTML "first newline removal" is a
    // parse-time operation (the parser already dropped one leading line
    // terminator), so re-stripping here would double-strip.
    return controlLiveValue(n);
  }
  if (tag === 'select') {
    // `o.value` is the spec's "option's value" (the `value` attribute, else the
    // collapsed/trimmed `text` IDL). Selection is read from selectedness only:
    // a selected option counts even when DISABLED (Chrome: `<option disabled
    // selected>X` ⇒ value "X"), and nothing selected reads back as '' — the
    // HTML "first option selected by default" rule is already materialised into
    // selectedness by runSelectednessAlgorithm, so a `size > 1` select or one
    // reset via `selectedIndex = -1` genuinely has no value. Both were verified
    // against headless Chrome.
    if (n._attrs.multiple != null) return selectedOptionsOf(n).map(optionValue);
    const [first] = selectedOptionsOf(n, true);
    return first === undefined ? '' : optionValue(first);
  }
  if (tag === 'input') return inputValue(n);
  // (…an output's `value` property its descendant text content — the property, as Selenium reads it — not an attribute)
  if (tag === 'output') return n._textContent;
  return n._attrs.value != null ? n._attrs.value : '';
};

// Element-targeted HTML access — what tests reach for via
// `find('.x').native.inner_html` / `.outer_html`. Returns '' when
// the handle no longer resolves rather than throwing; stale handles
// are caught at the Ruby `check_stale` layer.
globalThis.__csimInnerHTML = function (h) {
  const el = lookup(h);
  return el && el._nodeType === NODE_ELEMENT ? el._innerHTML : '';
};
globalThis.__csimOuterHTML = function (h) {
  const el = lookup(h);
  return el && el._nodeType === NODE_ELEMENT ? el._outerHTML : '';
};

globalThis.__csimDocumentHtml = function () {
  const root = documentElementOf(globalThis.document);
  return root
    ? serializeElement(root)
    : '';
};

// ── Cross-window remote-ref RPC (TARGET side) ──────────────────────────────
// Another window's opener holds proxies that forward every get/set/method-call
// to here, addressing the object by a ref id: a positive id is a DOM node's
// handle (handles.js), the node held here as it was served — a frame's node too,
// which is no node of this realm's to look up; a negative id is a non-node object (window,
// document-adjacent objects, navigator, …) registered on demand. The window
// itself is ref id 0. Values crossing back are serialized to plain markers so
// the host marshaller can copy them: primitives pass through, a function →
// `{__csimRefFn:true}` (the caller re-invokes it via __csimRemoteRefCall on the
// owning ref), and any node/object → `{__csimRef:id}` (wrapped as a proxy).
const __remoteObjRegistry = new Map();   // negative id -> object
const __remoteNodes       = new Map();   // handle -> the node a proxy names, kept as long as the page
const __remoteObjIds      = new WeakMap();
let __remoteObjSeq = 0;
function __remoteResolveRef(id) {
  if (id === 0) return globalThis;
  if (id < 0) return __remoteObjRegistry.get(id) || null;
  return __remoteNodes.get(id) ?? lookup(id);
}
function __remoteSerialize(v) {
  if (v == null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (t === 'function') return { __csimRefFn: true };
  if (t !== 'object') return null;                       // symbol / bigint — unsupported
  if (v._nodeType != null && v._nid >= 0) {
    const h = handleOf(v);
    __remoteNodes.set(h, v);
    return { __csimRef: h };
  }
  let id = __remoteObjIds.get(v);
  if (id == null) { id = (__remoteObjSeq -= 1); __remoteObjIds.set(v, id); __remoteObjRegistry.set(id, v); }
  return { __csimRef: id };
}
function __remoteDeserialize(v) {
  return (v && typeof v === 'object' && v.__csimRef != null) ? __remoteResolveRef(v.__csimRef) : v;
}
globalThis.__csimRemoteRefGet = function (id, prop) {
  const o = __remoteResolveRef(id);
  if (o == null) return null;
  try { return __remoteSerialize(o[prop]); } catch (_) { return null; }
};
globalThis.__csimRemoteRefSet = function (id, prop, value) {
  const o = __remoteResolveRef(id);
  if (o == null) return;
  try { o[prop] = __remoteDeserialize(value); } catch (_) {}
};
globalThis.__csimRemoteRefCall = function (id, method, args) {
  const o = __remoteResolveRef(id);
  if (o == null) return null;
  try {
    const fn = o[method];
    if (typeof fn !== 'function') return null;
    return __remoteSerialize(fn.apply(o, (args || []).map(__remoteDeserialize)));
  } catch (_) { return null; }
};
