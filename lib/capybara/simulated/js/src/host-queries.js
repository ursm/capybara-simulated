// Small read-only host fns Capybara calls from Ruby via
// `Context#call('__csim<Op>', args)`. Document-level reads,
// querySelector / querySelectorAll batching, XPath evaluation, and
// per-element field accessors (`node.text`, `node.tag_name`,
// `node[name]`, `node.has_attr?`). One V8 round-trip per Capybara
// DSL operation — not per internal DOM op.

import { NODE_DOC, NODE_ELEMENT, NODE_FRAGMENT, isHtml, htmlLocalName } from './constants.js';
import { frameRealmOf, handleOf, lookup } from './handles.js';
import { isConnected } from './walk.js';
import { serializeElement }             from './html-parser.js';
import { controlLiveValue, isActuallyDisabled, optionValue } from './form-helpers.js';
import { documentElementOf } from './document-tree.js';
import { selectAll, selectFirst } from './selectors.js';
import { selectXPath } from './xpath.js';
import { activeElementOf, shadowRootMode, textContentOf, baseURIOf, outerHTMLOf, innerHTMLOf } from './dom-nodes.js';
import { inputValue } from './html-input.js';
import {
  FN_BUILD_QUEUED, FN_COMMIT_PENDING, frameNavHas, supersedeFrameNavigation, frameNavigationFinalized
} from './frame-nav.js';
import { optionSelectOf, selectedOptionsOf, shadowRootOf, selectednessOf, getAttribute } from './native-query-shadow.js';
import { logError } from './console.js';
import { attrsOf, nidOf, nodeTypeOf, tagOf } from './node-identity.js';
import { dom, hostNamespace, hostSteps, listBuild, listMap } from './engine.js';

// HTML spec: the `document.title` getter strips and collapses ASCII
// whitespace in the title element's child text content (runs of
// `[\t\n\f\r ]+` → single space, plus leading/trailing trim). Without
// this, server-rendered titles that go through emoji-strip-with-gap
// expansions (Discourse's `gsub_emoji_to_unicode` for a denied emoji
// leaves a double space where `:name:` used to be) reach the test as
// raw textContent and assertions on `page.title` fail vs the
// real-browser-canonical normalisation.
hostSteps.documentTitle = function () {
  // Delegate to the spec-correct `document.title` getter (tree-order HTML title
  // / SVG-root title, namespace-aware, child-text-content with the same
  // whitespace strip+collapse) so `page.title` can't diverge from it.
  return globalThis.document.title;
};

// Query under `root` (handle, or 0 for document). Returns array of
// handles; Ruby resolves each via accessors below.
hostSteps.query = function (rootHandle, selector) {
  const root = rootHandle ? lookup(rootHandle) : globalThis.document;
  if (!root) return [];
  return listMap(selectAll(root, selector), handleOf);
};

// XPath evaluation (xpath.js `selectXPath`, over xpath.rs): the nodes in document order, as an ordered snapshot holds
// them — Capybara's order.
hostSteps.evaluateXPath = function (xpath, contextHandle) {
  const ctx = contextHandle ? lookup(contextHandle) : globalThis.document;
  if (!ctx) return [];
  let nodes;
  try {
    nodes = selectXPath(String(xpath), ctx);
  } catch (e) {
    try { logError('[csim] XPath threw:', e && e.message, 'for', xpath); } catch (_) {}
    return [];
  }
  return listBuild((add) => {
    for (let i = 0; i < nodes.length; i++) {
      const h = handleOf(nodes[i]);
      if (h !== 0) add(h);
    }
  });
};

hostSteps.queryOne = function (rootHandle, selector) {
  const root = rootHandle ? lookup(rootHandle) : globalThis.document;
  if (!root) return 0;
  const hit = nodeTypeOf(root) === NODE_DOC || nodeTypeOf(root) === NODE_ELEMENT || nodeTypeOf(root) === NODE_FRAGMENT
    ? selectFirst(root, selector)
    : null;
  return handleOf(hit);
};

hostSteps.text = function (h) {
  const n = lookup(h);
  return n ? textContentOf(n) : '';
};

hostSteps.tag = function (h) {
  const n = lookup(h);
  if (!n) return '';
  if (tagOf(n)) return tagOf(n);
  if (n instanceof globalThis.ShadowRoot) return 'ShadowRoot';
  return '';
};

// Trace `description` helper: `{tag, id, cls}` for a CSS-selector-ish
// short form. Class is truncated to the first whitespace-separated
// token so a node with 10 utility classes doesn't drown the trace.
hostSteps.describeNode = function (h) {
  const n = lookup(h);
  if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return null;
  const cls = (attrsOf(n).class || '').trim().split(/\s+/)[0] || '';
  return { tag: tagOf(n) || '', id: attrsOf(n).id || '', cls };
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
hostSteps.attr = function (h, name) {
  const n = lookup(h);
  if (!n) return null;
  const s = String(name);
  switch (s) {
    case 'validationMessage': return n.validationMessage || '';
    case 'validity':          return n.validity || null;
    case 'innerHTML':         return nodeTypeOf(n) === NODE_ELEMENT ? innerHTMLOf(n) : null;
    case 'outerHTML':         return nodeTypeOf(n) === NODE_ELEMENT ? outerHTMLOf(n) : null;
    case 'innerText': {
      // The node's rendered text — what the `Element#innerText` getter is made of (rendered.rs `visible_text`).
      const raw = typeof hostSteps.visibleText === 'function' ? hostSteps.visibleText(h)
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
  if (ints && Object.hasOwn(ints, content) && getAttribute(n, content) != null) return n[ints[content]];
  // ARIA IDL reflection: `el.ariaExpanded` etc. map to the matching
  // `aria-*` content attribute per the ARIAMixin spec, so Selenium /
  // Cuprite's `getAttribute("ariaExpanded")` returns the content
  // attribute value via the IDL property path. Without this hop,
  // Discourse's `replies_button[:ariaExpanded]` reads `null` instead
  // of `"true"`.
  if (s.length > 4 && s.startsWith('aria') && s[4] >= 'A' && s[4] <= 'Z' && nodeTypeOf(n) === NODE_ELEMENT) {
    return getAttribute(n, 'aria-' + s[4].toLowerCase() + s.slice(5));
  }
  return nodeTypeOf(n) === NODE_ELEMENT ? getAttribute(n, s) : null;
};

hostSteps.optionSelected = function (h) {
  const n = lookup(h);
  if (!n || nodeTypeOf(n) !== NODE_ELEMENT || !isHtml(n, 'option')) return false;
  // Selectedness is maintained eagerly by the selectedness setting
  // algorithm (custom-elements.js) on parse / insert / remove / pick, so
  // the implicit single-select default is already materialised on the
  // first non-disabled option — no per-read scan needed.
  return selectednessOf(n) === true;
};

// `disabled?` shares the HTML "actually disabled" algorithm with the `:disabled`
// CSS pseudo (form-helpers isActuallyDisabled) so the two can never disagree:
// own `[disabled]`, a control in a disabled `<fieldset>`, or an option/optgroup in
// a disabled `<select>` / optgroup.
hostSteps.disabled = function (h) {
  return isActuallyDisabled(lookup(h));
};

// The document's base URL (`documentBaseURL`: its `<base href>`'s, else its fallback base URL) — '' for no document.
hostSteps.baseURL = function () {
  return globalThis.document ? baseURIOf(globalThis.document) : '';
};

hostSteps.nodePath = function (h) {
  const start = lookup(h);
  if (!start || nodeTypeOf(start) !== NODE_ELEMENT) return '';
  // (…the engine's, xpath.rs `node_path`: none for a node in a shadow tree, which has no stable document-level XPath —
  // Capybara uses the same marker string for these as selenium/cuprite)
  return dom.nodePath(nidOf(start)) ?? '(: Shadow DOM element - no XPath :)';
};

hostSteps.optionContext = function (h) {
  const n = lookup(h);
  if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return { hasSelect: false, multiple: false };
  const cur = optionSelectOf(n);
  if (!cur) return { hasSelect: false, multiple: false };
  return { hasSelect: true, multiple: attrsOf(cur).multiple != null };
};

hostSteps.shadowRoot = function (h) {
  const el = lookup(h);
  const sr = el && shadowRootOf(el);
  return sr && shadowRootMode(sr) === 'open' ? handleOf(sr) : 0;
};

// Capybara's `Session#active_element`: `document.activeElement` — a focused element in a shadow tree retargeted to its
// host, as Chrome answers a driver; with nothing focused the body, else the document element.
hostSteps.activeElement = function () {
  const doc = globalThis.document;
  return doc ? handleOf(activeElementOf(doc)) : 0;
};

// "Alive" = the node behind this handle is still attached to the document tree: a handle names its node for as long as
// the node lives (handles.js), in a document or not, so "it names a node" isn't "still in the document". Capybara's
// stale-node detection depends on this: a node that's been removed from the DOM must report as stale on the next read.
hostSteps.alive = function (h) {
  const n = lookup(h);
  return n != null && isConnected(n);
};

// `switch_to_frame` entry point: given an `<iframe>` / `<frame>` handle in
// THIS realm, force its nested browsing context to exist (the realm is built
// lazily on first `contentWindow` access) and return the realm's context id,
// or 0 when none is (past the nesting limit, or a non-frame element). Ruby then routes the `within_frame` body's DOM ops
// into that realm via `V8Runtime#realm_call`.
// (…the document its navigation is under way to, where that one's build is still queued — the one the user switching to
// the frame waits for, not its initial about:blank or the one it is leaving: its queued build, committing now)
hostSteps.ensureFrameRealm = function (h) {
  const el = lookup(h);
  if (!el || (!isHtml(el, 'iframe') && !isHtml(el, 'frame'))) return 0;
  if (typeof globalThis.__csimFrameWindow !== 'function') return 0;
  globalThis.__csimFrameWindow(el, frameNavHas(el, FN_BUILD_QUEUED | FN_COMMIT_PENDING));   // builds + loads the realm if needed
  return frameRealmOf(el) ?? 0;
};

// This realm's document's policy container's referrer policy, as its `<meta name="referrer">` elements have set it —
// each as it was connected or its `name` / `content` changed, the last to run winning (url_ops.rs
// `meta_referrer_steps`): what a navigation the document makes, and a fetch or XHR whose request names none, is sent
// under (`containerReferrerPolicy`, referrer.rs `request_referrer`). '' = none set → the platform default
// (strict-origin-when-cross-origin).
hostSteps.documentReferrerPolicy = function () {
  const doc = globalThis.document;
  return doc ? dom.metaReferrerPolicy(nidOf(doc)) : '';
};
// The client a request of realm `realm`'s document is made as (referrer.rs `requestClient`), which the host asks of the
// page's realm for any of its realms.
hostSteps.requestClient = (realm, policy, opaque) => dom.requestClient(realm, policy, opaque);
// …and the site for cookies of its document, and the origins of its ancestors' documents — its own too, `own` — which a
// request of it is cross-site for cookies by (referrer.rs).
hostSteps.siteForCookies = (realm) => dom.siteForCookies(realm);
hostSteps.ancestorDocuments = (realm, own = false) => dom.ancestorDocuments(realm, own);
// …and the origins and sandboxing of the about:blank document a navigation its document began makes in a navigable
// (realm_location.rs `navigationOrigins`).
hostSteps.navigationOrigins = (realm, navigable) => dom.navigationOrigins(realm, navigable);
// …and the sandboxing a window this realm's document opens is made with (realm_location.rs `popupFlags`).
hostSteps.popupFlags = () => dom.popupFlags();
// Where nested realm `realm` sits in the navigable tree as it was made — [parent realm, depth, navigable, first,
// traversable, top-level realm] — the realms navigable `id` had, and those made in realm `realm`'s document's containers
// and theirs, each after its own (navigables.rs).
hostSteps.realmTree = (realm) => dom.realmTree(realm);
hostSteps.navigableRealms = (id) => dom.navigableRealms(id);
hostSteps.frameDestination = (realm) => dom.frameDestination(realm);
hostSteps.realmsMadeUnder = (realm) => dom.realmsMadeUnder(realm);
// …and frame realm `realm`'s navigable in its traversable's session history — [navigable, parent navigable, parent realm,
// traversable] — and its active entry, `create` made where it has none: [traversable, entry] (session_history.rs).
hostSteps.frameNavigable = (realm) => dom.frameNavigable(realm);
hostSteps.frameEntry = (realm, create) => dom.frameEntry(realm, create);
// …and a navigation of it begun, the entry it makes as its document is: [handling, navigable, number], null none
// (session_history.rs `beginFrameEntry`).
hostSteps.beginFrameEntry = (realm, url, replace, srcdoc) => dom.beginFrameEntry(realm, url, replace, srcdoc ?? null);
// The realms a `storage` event goes to, of a change realm `source` made (-1: another window) as document number `made`
// was the last begun (storage_areas.rs `storage_event_targets`).
hostSteps.storageEventTargets = (source, made) => dom.storageEventTargets(source, made);
// The walks over a document's tree and the frame builds an entry into the isolate left open — a termination ran no
// `finally` of theirs — ended: those begun after number `mark`, the last as it was made (unload_walks.rs
// `end_left_open_since`); how many.
hostSteps.endLeftOpenSince = (mark) => dom.endLeftOpenSince(mark);
// The realms whose documents have focus (navigables.rs `focus_chain`).
hostSteps.focusChain = () => dom.focusChain();

// A new frame realm's document is the active document of the container's navigable (navigables.rs), linked as the
// realm is made (-1: none, a load that failed) — the realm of the document it had before returned, or -1: the window
// the WindowProxies of it were over, the host's to retarget (`__csimRetargetWindowProxy`). The realm takes its nesting
// then (realm-nesting.js).
function linkFrameRealm(container, realm) {
  const before = dom.setFrameRealm(container, realm);
  if (realm >= 0) hostNamespace.contextGlobal(realm)?.__csimTakeNesting?.();
  return before;
}
hostSteps.linkFrameRealm = linkFrameRealm;

// A navigation of a frame the host took and finalized — the document it made, or none
// (`frameNavigationFinalized`): the frame's by its container's handle in this document (browser.rb
// `consume_pending_frame_nav`).
hostSteps.frameNavigationFinalizedAt = (h) => frameNavigationFinalized(lookup(h));

// The host's navigation of the frame about to commit, its document about to run: a `src` one still waiting for its
// response over (Chrome's later one wins) — not one that document's `load` handler begins, which is the frame's next.
hostSteps.hostCommitBegins = function (h) {
  const el = lookup(h);
  if (el && dom.hostCommitBegins(nidOf(el))) supersedeFrameNavigation(el);
};

// Point an `<iframe>` element at a freshly (re)built frame realm after a
// frame-scoped navigation. Runs in the PARENT realm (where the element lives):
// drops the element's cached window and swaps the id in the parent's
// child-realm set so the event loop runs the new realm's tasks (timers.rs
// `agentNext`) and no more the disposed one's. Mirrors what `__csimFrameWindow` does
// on the lazy first build, which the Ruby-driven reload path bypasses.
hostSteps.rebindFrameRealm = function (h, oldId, newId) {
  const el = lookup(h);
  if (el) {
    // (…its navigable's active document the new realm's: linked as the realm was made where the host found the
    // container, and here — the element itself in hand — in any case)
    if (newId) linkFrameRealm(nidOf(el), newId);
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
hostSteps.value = function (h) {
  const n = lookup(h);
  if (!n || nodeTypeOf(n) !== NODE_ELEMENT) return null;
  const tag = htmlLocalName(n);
  if (tag === 'textarea') {
    // The live value: `liveValueOf` after a `set`/typing edit (dirty value flag),
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
    if (attrsOf(n).multiple != null) return listMap(selectedOptionsOf(n), optionValue);
    const first = selectedOptionsOf(n, true)[0];
    return first === undefined ? '' : optionValue(first);
  }
  if (tag === 'input') return inputValue(n);
  // (…an output's `value` property its descendant text content — the property, as Selenium reads it — not an attribute)
  if (tag === 'output') return textContentOf(n);
  return attrsOf(n).value != null ? attrsOf(n).value : '';
};

// Element-targeted HTML access — what tests reach for via
// `find('.x').native.inner_html` / `.outer_html`. Returns '' when
// the handle no longer resolves rather than throwing; stale handles
// are caught at the Ruby `check_stale` layer.
hostSteps.innerHTML = function (h) {
  const el = lookup(h);
  return el && nodeTypeOf(el) === NODE_ELEMENT ? innerHTMLOf(el) : '';
};
hostSteps.outerHTML = function (h) {
  const el = lookup(h);
  return el && nodeTypeOf(el) === NODE_ELEMENT ? outerHTMLOf(el) : '';
};

hostSteps.documentHtml = function () {
  const root = documentElementOf(globalThis.document);
  return root
    ? serializeElement(root)
    : '';
};

