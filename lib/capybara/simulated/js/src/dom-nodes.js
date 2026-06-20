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

import { NODE_ELEMENT, NODE_ATTRIBUTE, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT, NODE_PI } from './constants.js';
import { lookup, registerSubtree, unregisterSubtree }                from './handles.js';
import { dispatchEvent, dispatchEventPublic }                        from './dispatch.js';
import { recordAttrMutation, recordChildList, recordCharacterData, bumpSettleGen, currentSettleGen, signalSlotChange, setSlotChangeFirer, setSlotMutationHooks } from './mutation-observer.js';
import { walk, walkFind, walkSubtree, isConnected, scriptText, findById } from './walk.js';
import { selectAll, selectFirst, matchesSelector, closestSelector }   from './selectors.js';
import { isVisibleNode, isLaidOutNode, INVISIBLE_TAGS, selfHidden } from './cascade.js';
import { ceState, getCustomElementCtor, ceUpgradeTree, fireCEDisconnect, fireCEMoveReactions, fireAttrChangedCallback, askForReset, askForResetAfterRemoval, runSelectednessAlgorithm, finalizeSelectOptions, ensureOptionSelInit } from './custom-elements.js';
import { isContenteditable, toggleChecked, setRadio, checkedRadioInGroup, isSubmitButton, formForControl, closeDialog, enclosingLabelFor, labeledControlFor, LABELABLE, isInteractiveForLabel } from './form-helpers.js';
import { makeStyleProxy }                                             from './style-proxy.js';
import { htmlCollection, liveHTMLCollection, nodeList, newChildList, liveNamedNodeMap }   from './dom-collections.js';
import { getEncoding }                                                from './encodings.js';
import { tryFragmentNavigate }                                        from './location.js';

// First `<meta>`-declared charset label that resolves to a valid encoding, in
// document order (HTML prescan): a `charset=` attribute, or `http-equiv=
// content-type` with a `charset=` in its `content`.
function firstMetaCharset(doc) {
  const root = doc.documentElement;
  if (!root) return null;
  const metas = root.getElementsByTagName('meta');
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    let label = m._attrs.charset;
    if (label == null && (m._attrs['http-equiv'] || '').toLowerCase() === 'content-type') {
      // HTML "extract a character encoding from a meta element": the value may
      // be `"…"` / `'…'`-quoted — strip a matching surrounding quote pair.
      const mm = /charset\s*=\s*("[^"]*"|'[^']*'|[^\s;]+)/i.exec(m._attrs.content || '');
      if (mm) label = mm[1].replace(/^["']|["']$/g, '');
    }
    if (label != null && getEncoding(label, true) != null) return label;
  }
  return null;
}
import { Event, FocusEvent, InputEvent, MouseEvent, SubmitEvent, defaultPassiveValue, flattenCapture, windowForwardedHandlerName, activateWindowForwardedHandler } from './events.js';
import { serializeChildren, serializeChildrenWithShadow, serializeElement, escapeText, decodeEntities } from './html-parser.js';
import { installParse5Adapter } from './parse5-adapter.js';
import { installXmlParser } from './xml-parser.js';

let __nextId = 1;
// Carry the registered tag through `new SomeCustomElement()` so the
// Element base ctor can populate `_tag` even when the subclass
// doesn't call super(tag). Browsers do this via a per-construction
// queue; the single-threaded JS engine lets us collapse to a slot.
let __currentTag = null;

// User-initiated scroll signal (scrollIntoView / scrollTo / scrollBy
// on any node). Scroll position is tracked per-element via `_scrollTop`
// / `_scrollLeft`; for the document scrolling element (documentElement)
// `window.scrollY` reads through. The SIGNAL is what DLoadMore-shaped
// sentinels (and scroll-driven UI swaps) gate on. Fire a `scroll`
// event on the target (defaulting to document) and force-refire any
// observed IntersectionObserver targets so a paginated list advances
// past its first page.
function __notifyScroll(target) {
  try {
    const doc = globalThis.document;
    if (target && target !== doc) {
      dispatchEvent(target, new Event('scroll', { bubbles: false }));
    }
    if (doc) {
      dispatchEvent(doc, new Event('scroll', { bubbles: false }));
    }
    // Window scroll handlers (Discourse's site-header debouncer, Turbo's
    // scroll observers) register on `window`, which has its own
    // listener registry in window-events.js.
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new Event('scroll', { bubbles: false }));
    }
  } catch (_) {}
  try {
    if (typeof globalThis.__forceRefireIntersectionObservers === 'function') {
      globalThis.__forceRefireIntersectionObservers();
    }
  } catch (_) {}
}

// scrollTo / scrollBy / window.scrollTo overloads — accept (x, y)
// positional args OR a single `ScrollToOptions` dict with `left`/`top`.
// Returns `[x, y]` with each slot either a number or undefined (so
// callers can leave unspecified axes unchanged).
function __scrollArgsToXY(args) {
  if (args.length >= 2) {
    return [Number(args[0]) || 0, Number(args[1]) || 0];
  }
  const opt = args[0];
  if (opt && typeof opt === 'object') {
    const x = opt.left != null ? Number(opt.left) || 0 : undefined;
    const y = opt.top  != null ? Number(opt.top)  || 0 : undefined;
    return [x, y];
  }
  return [undefined, undefined];
}

// Used by `ChildNode.before/after/replaceWith` + `ParentNode.append
// /prepend` to accept strings (auto-wrap as Text) alongside nodes.
// WebIDL `(Node or DOMString)` coercion used by the ChildNode/ParentNode
// variadic methods: an actual Node passes through (any node type — a doctype
// must reach insertion so the validity check can throw, not be stringified);
// everything else becomes a Text node of its string value (null → "null",
// undefined → "undefined", per the IDL DOMString conversion).
function toNode(v) {
  if (isNodeArg(v)) return v;
  return new Text(String(v));
}
// https://dom.spec.whatwg.org/#converting-nodes-into-a-node — collect the
// variadic args into a single node: one item stays as-is, several are wrapped
// in a DocumentFragment so the caller inserts them in one operation.
function convertNodesIntoNode(nodes) {
  if (nodes.length === 1) return toNode(nodes[0]);
  const frag = new DocumentFragment();
  for (const n of nodes) frag.appendChild(toNode(n));
  return frag;
}

// getElementsByClassName: ordered-set match. Splits on ASCII whitespace ONLY
// — JS `\s` would wrongly treat NBSP / vertical-tab / OGHAM SPACE etc. as
// separators, but the DOM ordered-set parser keeps them as part of the token.
// Matches class tokens directly rather than building a `.class` CSS selector,
// so exotic class names can't trip the selector parser. Standards mode → the
// comparison is case-sensitive.
const ASCII_WHITESPACE = /[\t\n\f\r ]+/;
// Collect descendants of `scope` (Document or Element) matching `matches`, in
// tree order. The document's descendants include its documentElement.
function collectDescendants(scope, matches) {
  const out = [];
  const isDoc = scope.nodeType === NODE_DOC;
  const root  = isDoc ? scope.documentElement : scope;
  if (!root) return out;
  if (isDoc && matches(root)) out.push(root);   // documentElement is a descendant of the document
  for (const n of root.querySelectorAll('*')) {
    if (n === root) continue;                    // querySelectorAll('*') may include the receiver
    if (matches(n)) out.push(n);
  }
  return out;
}
function collectByClassName(scope, classNames) {
  const wanted = String(classNames).split(ASCII_WHITESPACE).filter(Boolean);
  if (!wanted.length) return [];
  return collectDescendants(scope, (el) => {
    const c = el._attrs && el._attrs['class'];
    if (!c) return false;
    const tok = c.split(ASCII_WHITESPACE);
    return wanted.every(w => tok.indexOf(w) !== -1);
  });
}
// getElementsByTagNameNS: namespace "*" = any, "" / null = no-namespace,
// otherwise an exact match; localName "*" = any, otherwise an EXACT
// (case-sensitive, unlike getElementsByTagName) match on `_localName`.
function collectByTagNameNS(scope, namespace, localName) {
  const wantNs = namespace === '*' ? '*' : (namespace == null || namespace === '' ? null : String(namespace));
  const wantLn = String(localName);
  return collectDescendants(scope, (el) =>
    (wantNs === '*' || el._ns === wantNs) && (wantLn === '*' || el._localName === wantLn));
}

// getElementsByTagName: `*` = any; in an HTML document the SEARCH is ASCII-
// lowercased but compared against the element's ACTUAL qualified name (so a
// `createElementNS(HTML_NS, "I")` — kept as "I" — matches neither "i" nor "I").
// Returns a plain Array; the live `getElementsBy*` collections wrap it.
function collectByTagName(scope, tag, htmlDoc) {
  const q = String(tag);
  // `htmlDoc` (whether to ASCII-lowercase the search for HTML-namespaced
  // elements) is bound by the LIVE collection at CREATION time per WHATWG
  // "list of elements with qualified name" — moving the root into a
  // differently-HTML document must NOT change an existing list. Non-live
  // callers omit it and get the scope's current document.
  if (htmlDoc === undefined) htmlDoc = isHtmlDocument(scope.ownerDocument);
  const qLower = htmlDoc ? asciiLower(q) : q;
  return collectDescendants(scope, (n) => {
    if (q === '*') return true;
    const qn = n._prefix ? n._prefix + ':' + n._localName : n._localName;
    return htmlDoc ? (n._ns === HTML_NS ? qn === qLower : qn === q) : qn === q;
  });
}

// DOM node-type names for HierarchyRequestError messages.
const NODE_TYPE_NAMES = {
  [NODE_ELEMENT]:  'Element',
  [NODE_TEXT]:     'Text',
  [NODE_COMMENT]:  'Comment',
  [NODE_DOC]:      'Document',
  [NODE_DOCTYPE]:  'DocumentType',
  [NODE_FRAGMENT]: 'DocumentFragment'
};
function nodeTypeName(node) {
  return NODE_TYPE_NAMES[node && node.nodeType] || 'node';
}

// node is a (host-including) inclusive ancestor of parent? A ShadowRoot's
// `_parent` is its host (set in the ShadowRoot ctor), so walking `_parent`
// already crosses the shadow boundary — no separate `.host` hop is needed
// (and an element's `.host`, e.g. an anchor's URL host string, must not be
// followed).
function isInclusiveAncestor(node, parent) {
  for (let p = parent; p; p = p._parent) {
    if (p === node) return true;
  }
  return false;
}

function hierarchyError(msg) { return new globalThis.DOMException(msg, 'HierarchyRequestError'); }
// Any sibling of `child` (after it when `after`, else before it) has nodeType `t`?
function siblingOfType(parent, child, t, after) {
  const arr = parent._children, i = arr.indexOf(child);
  if (i < 0) return false;
  if (after) { for (let j = i + 1; j < arr.length; j++) if (arr[j].nodeType === t) return true; }
  else       { for (let j = 0; j < i; j++)            if (arr[j].nodeType === t) return true; }
  return false;
}

// Shared pre-insertion / replace validity
// (https://dom.spec.whatwg.org/#concept-node-ensure-pre-insertion-validity and
// #concept-node-replace). `child` is the reference (pre-insert) or replaced
// (replace) node; `isReplace` switches the document-child constraints to exclude
// the node being replaced.
function validateInsertion(node, parent, child, isReplace) {
  const pt = parent.nodeType;
  // 1. parent must be a Document, DocumentFragment, or Element.
  if (pt !== NODE_DOC && pt !== NODE_FRAGMENT && pt !== NODE_ELEMENT) {
    throw hierarchyError(`Cannot add a child to a ${nodeTypeName(parent)} node`);
  }
  // 2. node must not be an inclusive ancestor of parent.
  if (isInclusiveAncestor(node, parent)) {
    throw hierarchyError('The new child is an ancestor of the parent');
  }
  // 3. a given reference/old child must actually be a child of parent.
  if (child != null && child._parent !== parent) {
    throw new globalThis.DOMException('The reference child is not a child of this node', 'NotFoundError');
  }
  // 4. node must be a DocumentFragment, DocumentType, Element, or CharacterData
  // (CharacterData = Text, CDATASection, Comment, ProcessingInstruction).
  const t = node.nodeType;
  if (t !== NODE_FRAGMENT && t !== NODE_DOCTYPE && t !== NODE_ELEMENT && t !== NODE_TEXT && t !== NODE_CDATA && t !== NODE_COMMENT && t !== NODE_PI) {
    throw hierarchyError(`Cannot insert a ${nodeTypeName(node)} node`);
  }
  // 5. a Text node cannot be a Document child; a doctype must have a Document parent.
  if (((t === NODE_TEXT || t === NODE_CDATA) && pt === NODE_DOC) || (t === NODE_DOCTYPE && pt !== NODE_DOC)) {
    throw hierarchyError(`A ${nodeTypeName(node)} node cannot be a child of a ${nodeTypeName(parent)} node`);
  }
  // 6. document-only constraints (at most one element child + one doctype, in
  //    order). For replace, the node being replaced (`child`) is excluded.
  if (pt !== NODE_DOC) return;
  const except = isReplace ? child : null;
  const hasEl = parent._children.some(c => c.nodeType === NODE_ELEMENT && c !== except);
  const hasDt = parent._children.some(c => c.nodeType === NODE_DOCTYPE && c !== except);
  const childIsDoctype = !isReplace && child && child.nodeType === NODE_DOCTYPE;
  if (t === NODE_FRAGMENT) {
    let nEl = 0, hasText = false;
    for (const c of node._children) {
      if (c.nodeType === NODE_ELEMENT) nEl++;
      else if (c.nodeType === NODE_TEXT) hasText = true;
    }
    if (nEl > 1 || hasText) throw hierarchyError('Document can contain only one element');
    if (nEl === 1 && (hasEl || childIsDoctype || (child && siblingOfType(parent, child, NODE_DOCTYPE, true)))) {
      throw hierarchyError('Invalid placement of an element in a Document');
    }
  } else if (t === NODE_ELEMENT) {
    if (hasEl || childIsDoctype || (child && siblingOfType(parent, child, NODE_DOCTYPE, true))) {
      throw hierarchyError('Document can contain only one element child');
    }
  } else if (t === NODE_DOCTYPE) {
    if (hasDt || (child && siblingOfType(parent, child, NODE_ELEMENT, false)) ||
        (!child && parent._children.some(c => c.nodeType === NODE_ELEMENT))) {
      throw hierarchyError('Invalid placement of a doctype in a Document');
    }
  }
}
function ensurePreInsertionValidity(node, parent, child) { validateInsertion(node, parent, child, false); }

// Pre-insertion "adopt" step (https://dom.spec.whatwg.org/#concept-node-pre-insert
// step 2): a node inserted into `parent` is first adopted into `parent`'s
// node document, which re-tags the subtree's `ownerDocument` AND detaches it
// from any previous parent. A same-document insert is just a detach (no
// subtree walk). Shared by appendChild / insertBefore / replaceChild so all
// three honour the adoption that the WPT Node-appendChild "Adopting an orphan
// / non-orphan" cases (and real cross-document grafting) depend on.
function adoptIntoParent(parent, node) {
  // Use the `ownerDocument` accessor, not the raw `_ownerDoc` field: a node
  // attached to the main document carries `_ownerDoc === null` and relies on
  // the getter's `|| globalThis.document` fallback, so reading `_ownerDoc`
  // here would see null and skip the (cross-document) adoption entirely.
  const destDoc = parent.nodeType === NODE_DOC ? parent : parent.ownerDocument;
  if (destDoc && node.ownerDocument !== destDoc && typeof destDoc.adoptNode === 'function') {
    destDoc.adoptNode(node);
  } else if (node._parent) {
    node._parent.removeChild(node);
  }
}

// WebIDL: appendChild/insertBefore/replaceChild take non-nullable Node
// arguments, so a non-Node (null, undefined, a plain object) is a TypeError
// *before* the algorithm runs. Realm-safe: a duck-typed numeric nodeType is
// enough (avoids cross-document `instanceof` pitfalls).
function assertNodeArg(value) {
  if (value == null || typeof value.nodeType !== 'number') {
    throw new TypeError("Argument is not an object that implements Node");
  }
}

// Elements that support the `disabled` attribute (HTML "can be disabled").
// `disabled` on anything else (e.g. a <div>) is inert. Used to gate the
// synthetic-click path: a disabled form control's click() / trusted click
// fires nothing (HTML "fire a synthetic pointer event" returns early), even
// though an untrusted event dispatched directly via dispatchEvent still runs.
const DISABLEABLE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);
// `<input>` types the `required` attribute (→ `valueMissing`) has NO effect on,
// so a `required` on these must NOT make the control invalid (matches Chrome).
// Any other / unrecognised type behaves like `text` (required applies).
const NO_REQUIRED_INPUT_TYPES = new Set([
  'submit', 'image', 'reset', 'button', 'hidden', 'range', 'color'
]);
function isActuallyDisabled(el) {
  return !!el && el.nodeType === NODE_ELEMENT && DISABLEABLE_TAGS.has(el._tag) && el._attrs.disabled != null;
}

// ── DOMTokenList ─────────────────────────────────────────────────
// https://dom.spec.whatwg.org/#interface-domtokenlist — the live token
// list behind classList / relList / sandbox / etc. Backed by (element,
// attribute local name); reads re-parse the attribute and writes round-trip
// through setAttribute so MutationObserver / cascade / CE callbacks see them.

// DOM "ASCII whitespace": TAB, LF, FF, CR, SPACE (NOT vertical tab / Unicode).
const DOM_WS_RUN = /[\t\n\f\r ]+/;
const DOM_WS_ANY = /[\t\n\f\r ]/;

// Ordered set parser: split on ASCII whitespace, drop empties, dedupe in order.
function parseOrderedSet(str) {
  if (!str) return [];
  const out = [], seen = new Set();
  for (const tok of String(str).split(DOM_WS_RUN)) {
    if (tok === '' || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

// The supported-token sets a real browser's DOMTokenList.supports() reflects.
// These are the keywords the ENGINE actually registers (observed in Chromium
// 148), a strict subset of the keywords merely *valid* on the attribute — a
// feature-detect must see the same answer it would in the browser. `class`
// defines no supported tokens (so classList.supports() throws); the
// load-bearing case is Vite's boot-time `link.relList.supports('modulepreload')`.
// https://html.spec.whatwg.org/#concept-supported-tokens
const REL_LINK = new Set([
  'alternate', 'canonical', 'dns-prefetch', 'icon', 'manifest', 'modulepreload',
  'next', 'preconnect', 'prefetch', 'preload', 'stylesheet', 'apple-touch-icon'
]);
// a / area / form relLists all reflect the same three hyperlink keywords.
const REL_HYPERLINK = new Set(['noopener', 'noreferrer', 'opener']);
const SANDBOX_TOKENS = new Set([
  'allow-downloads', 'allow-forms', 'allow-modals', 'allow-orientation-lock',
  'allow-pointer-lock', 'allow-popups', 'allow-popups-to-escape-sandbox',
  'allow-presentation', 'allow-same-origin', 'allow-scripts',
  'allow-storage-access-by-user-activation', 'allow-top-navigation',
  'allow-top-navigation-by-user-activation'
]);

// The supported-token set for an (element, attribute) pair, or null when the
// attribute defines none (e.g. class) — in which case supports() throws.
function supportedTokensFor(el, attr) {
  const tag = (el && el.tagName ? String(el.tagName) : '').toLowerCase();
  if (attr === 'rel') {
    if (tag === 'link') return REL_LINK;
    if (tag === 'a' || tag === 'area' || tag === 'form') return REL_HYPERLINK;
    return null;
  }
  if (attr === 'sandbox' && tag === 'iframe') return SANDBOX_TOKENS;
  return null;
}

function validateToken(token, method) {
  if (token === '') {
    throw new globalThis.DOMException(
      `Failed to execute '${method}' on 'DOMTokenList': The token provided must not be empty.`,
      'SyntaxError');
  }
  if (DOM_WS_ANY.test(token)) {
    throw new globalThis.DOMException(
      `Failed to execute '${method}' on 'DOMTokenList': ` +
      `The token provided ('${token}') contains HTML space characters, which are not valid in tokens.`,
      'InvalidCharacterError');
  }
}

class DOMTokenList {
  constructor(el, attr) {
    // Non-enumerable internal slots: a Proxy-wrapped DOMTokenList must not
    // leak `_el` (a live element graph) into `{...el.classList}` /
    // Object.keys / JSON — the same own-enumerability hazard as NamedNodeMap.
    Object.defineProperty(this, '_el',   { value: el });
    Object.defineProperty(this, '_attr', { value: attr });
  }

  // The current token set (ordered, deduped) parsed from the attribute.
  _set() { return parseOrderedSet(this._el._attrs[this._attr]); }

  // Update steps: serialize the set back to the attribute — but if the
  // attribute is absent AND the set is empty, do nothing (don't create it).
  _update(tokens) {
    if (!(this._attr in this._el._attrs) && tokens.length === 0) return;
    this._el.setAttribute(this._attr, tokens.join(' '));
  }

  get length() { return this._set().length; }

  item(index) {
    const set = this._set();
    index = index >>> 0;                 // unsigned-long coercion
    return index < set.length ? set[index] : null;
  }

  contains(token) { return this._set().includes(String(token)); }

  add(...tokens) {
    tokens = tokens.map(String);
    for (const t of tokens) validateToken(t, 'add');
    const set = this._set();
    for (const t of tokens) if (!set.includes(t)) set.push(t);
    this._update(set);
  }

  remove(...tokens) {
    tokens = tokens.map(String);
    for (const t of tokens) validateToken(t, 'remove');
    const drop = new Set(tokens);
    this._update(this._set().filter(t => !drop.has(t)));
  }

  toggle(token, force) {
    token = String(token);
    validateToken(token, 'toggle');
    // `force` is an optional WebIDL boolean: absent → flip; present → coerce
    // (so the common `toggle('x', truthyValue)` idiom behaves like a browser).
    const hasForce = arguments.length > 1;
    const f = hasForce ? Boolean(force) : undefined;
    const set = this._set();
    const i = set.indexOf(token);
    if (i >= 0) {
      if (!hasForce || f === false) { set.splice(i, 1); this._update(set); return false; }
      return true;
    }
    if (!hasForce || f === true) { set.push(token); this._update(set); return true; }
    return false;
  }

  replace(token, newToken) {
    token = String(token); newToken = String(newToken);
    // replace validates differently from add/remove: BOTH tokens are checked
    // for emptiness (SyntaxError) before EITHER is checked for whitespace
    // (InvalidCharacterError) — so replace(" ", "") is a SyntaxError, not an
    // InvalidCharacterError.
    if (token === '' || newToken === '') {
      throw new globalThis.DOMException(
        "Failed to execute 'replace' on 'DOMTokenList': The token provided must not be empty.",
        'SyntaxError');
    }
    if (DOM_WS_ANY.test(token) || DOM_WS_ANY.test(newToken)) {
      throw new globalThis.DOMException(
        "Failed to execute 'replace' on 'DOMTokenList': The token provided contains HTML space characters.",
        'InvalidCharacterError');
    }
    const set = this._set();
    const i = set.indexOf(token);
    if (i < 0) return false;
    set[i] = newToken;
    this._update(parseOrderedSet(set.join(' ')));   // re-dedupe if newToken already present
    return true;
  }

  // Per spec, supports(token) throws only when the associated attribute
  // defines no supported tokens (e.g. class); for rel / sandbox it returns
  // whether the ASCII-lowercased token is in the supported set.
  supports(token) {
    const supported = supportedTokensFor(this._el, this._attr);
    if (!supported) {
      throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.");
    }
    return supported.has(String(token).toLowerCase());
  }

  get [Symbol.toStringTag]() { return 'DOMTokenList'; }

  get value() { return this._el._attrs[this._attr] || ''; }
  set value(v) { this._el.setAttribute(this._attr, v == null ? '' : String(v)); }
  toString() { return this.value; }

  forEach(fn, thisArg) { this._set().forEach((t, i) => fn.call(thisArg, t, i, this)); }
  entries() { return this._set().entries(); }
  keys()    { return this._set().keys(); }
  values()  { return this._set().values(); }
  [Symbol.iterator]() { return this._set()[Symbol.iterator](); }
}
globalThis.DOMTokenList = DOMTokenList;

// A DOMTokenList must also support integer indexing (`list[0]`), returning
// `undefined` out of range. A Proxy gives live indexed access without a stale
// snapshot of own properties; method/accessor reads fall through unchanged.
// Cached per (element, attribute) so the IDL `[SameObject]` identity holds.
// A canonical array index (0 … 2^32−2, no leading zeros) or −1.
function asArrayIndex(prop) {
  if (typeof prop !== 'string') return -1;
  const n = prop >>> 0;
  return (String(n) === prop && n < 0xFFFFFFFF) ? n : -1;
}
function tokenListFor(el, attr) {
  const cache = el._tokenLists || (el._tokenLists = {});
  if (cache[attr]) return cache[attr];
  const list = new DOMTokenList(el, attr);
  const proxy = new Proxy(list, {
    get(target, prop, receiver) {
      const idx = asArrayIndex(prop);
      if (idx >= 0) {
        const v = target.item(idx);
        return v === null ? undefined : v;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      const idx = asArrayIndex(prop);
      if (idx >= 0) return idx < target.length;
      return Reflect.has(target, prop);
    }
  });
  cache[attr] = proxy;
  return proxy;
}

// ── Namespaces + createElementNS validation ────────────
const HTML_NS  = "http://www.w3.org/1999/xhtml";
const SVG_NS   = "http://www.w3.org/2000/svg";
const XML_NS   = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

// ASCII-whitespace / NUL / "/" / ">" — the chars a prefix may not contain.
const PREFIX_FORBIDDEN = /[\t\n\f\r \0/>]/;
function isAsciiAlpha(c)  { return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A); }
function isAsciiDigit(c)  { return c >= 0x30 && c <= 0x39; }
// A valid namespace prefix: length >= 1 and none of the forbidden chars.
function isValidNamespacePrefix(s) { return s.length >= 1 && !PREFIX_FORBIDDEN.test(s); }
// https://dom.spec.whatwg.org/#valid-element-local-name (algorithmic form,
// to avoid a fragile literal-codepoint regex in source).
function isValidElementLocalName(name) {
  if (name.length === 0) return false;
  const c0 = name.codePointAt(0);
  if (isAsciiAlpha(c0)) return !PREFIX_FORBIDDEN.test(name);
  // otherwise the first code point must be ":", "_", or >= U+0080
  if (!(c0 === 0x3A || c0 === 0x5F || c0 >= 0x80)) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0);
    const ok = isAsciiAlpha(c) || isAsciiDigit(c) ||
               c === 0x2D || c === 0x2E || c === 0x3A || c === 0x5F || c >= 0x80;
    if (!ok) return false;
  }
  return true;
}

// https://dom.spec.whatwg.org/#validate-and-extract (context: element).
// Returns { namespace, prefix, localName } or throws the spec exception.
// ASCII-only case conversion (NOT String#toUpperCase/toLowerCase, which fold
// non-ASCII like U+212A KELVIN / U+0130). HTML tagName/localName casing is
// ASCII-only per spec.
function asciiUpper(s) { return s.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 32)); }
function asciiLower(s) { return s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)); }

// A document uses XML semantics (case-sensitive names, CDATA, no implicit
// html/head/body skeleton) iff it was PARSED as XML — i.e. its content type is an
// XML MIME. A non-HTML, non-XML response (text/plain, application/json, text/css —
// a JSON endpoint navigated directly, or a frame loading a stylesheet) is
// HTML-PARSED (wrapped in <html><body>…), so it keeps HTML semantics even though
// `document.contentType` reflects the response MIME. Keying on `=== 'text/html'`
// instead wrongly flipped those to XML and broke find/XPath (uppercase nodeName vs
// lowercase query) — e.g. Discourse's `become.json` sign-in.
function isHtmlDocument(doc) {
  if (!doc || !doc._contentType) return true;
  const ct = doc._contentType;
  return ct !== 'text/xml' && ct !== 'application/xml' &&
         ct !== 'application/xhtml+xml' && ct !== 'image/svg+xml';
}

// https://dom.spec.whatwg.org/#valid-doctype-name — no ASCII whitespace, NUL,
// or ">". (createDocumentType validates only the name; it does no namespace or
// QName checks, and an empty name is valid.)
const DOCTYPE_NAME_FORBIDDEN = /[\t\n\f\r \0>]/;
function isValidDoctypeName(name) { return !DOCTYPE_NAME_FORBIDDEN.test(name); }

// https://dom.spec.whatwg.org/#locate-a-namespace — used by lookupNamespaceURI /
// isDefaultNamespace. `prefix` is already '' → null normalised.
function locateNamespace(node, prefix) {
  if (!node) return null;
  const parentEl = (n) => (n._parent && n._parent.nodeType === NODE_ELEMENT) ? n._parent : null;
  switch (node.nodeType) {
    case NODE_ELEMENT: {
      // Browsers keep the legacy xml / xmlns prefix bindings.
      if (prefix === 'xml')   return XML_NS;
      if (prefix === 'xmlns') return XMLNS_NS;
      if (node._ns != null && node._prefix === prefix) return node._ns;
      if (node._attrNS) {
        // `_attrNS` is sparse — only namespaced / prefixed attributes —
        // so this skips plain attributes without scanning them.
        for (const key in node._attrNS) {
          const meta = node._attrNS[key];
          if (meta.ns !== XMLNS_NS) continue;
          const match = (prefix != null) ? (meta.prefix === 'xmlns' && meta.localName === prefix)
                                         : (meta.prefix == null   && meta.localName === 'xmlns');
          if (match) { const v = node._attrs[key]; return v === '' ? null : v; }
        }
      }
      return locateNamespace(parentEl(node), prefix);
    }
    case NODE_DOC:       return locateNamespace(node.documentElement, prefix);
    case NODE_ATTRIBUTE: return locateNamespace(node._ownerElement, prefix);  // attr → its element
    case NODE_DOCTYPE:
    case NODE_FRAGMENT:  return null;
    default:            return locateNamespace(parentEl(node), prefix);  // Text / Comment
  }
}

// https://dom.spec.whatwg.org/#dom-document-createevent — the legacy
// createEvent table: ASCII-lowercased interface name → the event interface's
// global constructor name. Anything not here is a NotSupportedError.
const CREATE_EVENT_INTERFACES = {
  beforeunloadevent:      'BeforeUnloadEvent',
  compositionevent:       'CompositionEvent',
  customevent:            'CustomEvent',
  devicemotionevent:      'DeviceMotionEvent',
  deviceorientationevent: 'DeviceOrientationEvent',
  dragevent:              'DragEvent',
  event:                  'Event',
  events:                 'Event',
  focusevent:             'FocusEvent',
  hashchangeevent:        'HashChangeEvent',
  htmlevents:             'Event',
  keyboardevent:          'KeyboardEvent',
  messageevent:           'MessageEvent',
  mouseevent:             'MouseEvent',
  mouseevents:            'MouseEvent',
  storageevent:           'StorageEvent',
  svgevents:              'Event',
  textevent:              'TextEvent',
  // touchevent is added by the Touch Events spec; we expose touch
  // (`ontouchstart` in document), so it's supported here too. (wheelevent is
  // deliberately absent — it's a non-legacy interface and must NotSupportedError.)
  touchevent:             'TouchEvent',
  uievent:                'UIEvent',
  uievents:               'UIEvent'
};

// https://dom.spec.whatwg.org/#valid-attribute-local-name — like a namespace
// prefix but also forbidding "=".
const ATTR_NAME_FORBIDDEN = /[\t\n\f\r \0/=>]/;
function isValidAttributeLocalName(name) { return name.length >= 1 && !ATTR_NAME_FORBIDDEN.test(name); }

// The store key / localName for setAttribute/getAttribute by qualified name.
// ASCII-lowercased (NOT Unicode toLowerCase, which folds U+212A etc.) — the
// flat `_attrs` store, the CSS matcher, the cascade, and the serializer all key
// off this lowercased form, so it must stay consistent across them. (Case-
// sensitive namespaced attributes go through setAttributeNS, which keys on the
// qualified name directly and records the real case in `_attrNS`.)
// Attribute-name → store key. HTML-namespace element names are ASCII-lowercased
// (HTML attributes are case-insensitive); names on a non-HTML element (SVG /
// MathML / createElementNS) are CASE-SENSITIVE, so they key as-is — matching the
// case-preserving keys the parser/setAttributeNS store for foreign content
// (without this, an SVG `viewBox` stored case-preserved is unreadable via the
// lowercased lookup).
function attrKey(el, name) { const s = String(name); return el && el._ns === HTML_NS ? asciiLower(s) : s; }
// The qualified name an attribute store key exposes (getAttributeNames /
// serialization). For the common case the key IS the qualified name; a
// collision-keyed namespaced attribute (see `freshAttrKey`) carries a synthetic
// key, so its real qualified name comes from `_attrNS`.
function attrQName(el, key) {
  const m = el._attrNS && el._attrNS[key];
  return m ? (m.prefix ? m.prefix + ':' + m.localName : m.localName) : key;
}
// A free `_attrs` store key for a NEW attribute whose qualified name is `qn`. Two
// attributes can share a qualified name in different namespaces (e.g. a null-ns
// `x` and a foo-ns `x`), but the value map can't share a key — so when `qn` is
// already taken by a different attribute, mint a unique synthetic key. The
// qualified name is recovered from `_attrNS` (attrQName); the synthetic key is
// never exposed. The NUL separator can't appear in a real qualified name.
function freshAttrKey(el, qn) {
  if (!Object.prototype.hasOwnProperty.call(el._attrs, qn)) return qn;
  let i = 1, k;
  do { k = qn + '\x00' + (i++); } while (Object.prototype.hasOwnProperty.call(el._attrs, k));
  return k;
}
// First store key whose qualified name === `name` (HTML lowercases the lookup),
// in attribute (insertion) order, or null. Gated by the caller on `_attrNS`
// existing — with no namespaced attribute every key IS its qualified name, so a
// direct `_attrs[attrKey]` hit/miss is authoritative and this scan never runs.
function firstAttrKeyByQName(el, name) {
  const want = el._ns === HTML_NS ? asciiLower(String(name)) : String(name);
  for (const k in el._attrs) if (attrQName(el, k) === want) return k;
  return null;
}

// https://dom.spec.whatwg.org/#validate-and-extract. `context` is 'element' or
// 'attribute' (which validates the local name more permissively, allowing ":").
function validateAndExtract(namespace, qualifiedName, context) {
  if (namespace === "") namespace = null;
  let prefix = null, localName = qualifiedName;
  const ci = qualifiedName.indexOf(":");
  if (ci !== -1) {
    prefix = qualifiedName.slice(0, ci);
    localName = qualifiedName.slice(ci + 1);
  }
  if (prefix !== null && !isValidNamespacePrefix(prefix)) {
    throw new globalThis.DOMException(
      `The qualified name  contains an invalid prefix.`, "InvalidCharacterError");
  }
  const localNameOk = context === 'attribute'
    ? isValidAttributeLocalName(localName)
    : isValidElementLocalName(localName);
  if (!localNameOk) {
    throw new globalThis.DOMException(
      `The local name is not a valid name.`, "InvalidCharacterError");
  }
  if (prefix !== null && namespace === null) {
    throw new globalThis.DOMException("A namespace prefix was given but no namespace.", "NamespaceError");
  }
  if (prefix === "xml" && namespace !== XML_NS) {
    throw new globalThis.DOMException("The \"xml\" prefix requires the XML namespace.", "NamespaceError");
  }
  if ((qualifiedName === "xmlns" || prefix === "xmlns") && namespace !== XMLNS_NS) {
    throw new globalThis.DOMException("The \"xmlns\" name requires the XMLNS namespace.", "NamespaceError");
  }
  if (namespace === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
    throw new globalThis.DOMException("The XMLNS namespace is reserved for the xmlns name.", "NamespaceError");
  }
  return { namespace, prefix, localName };
}

class Node {
  constructor() {
    this._id        = __nextId++;
    this._parent    = null;
    this._children  = newChildList();  // ordered child nodes; a live NodeList (childNodes returns it)
    this._listeners = null;    // type → [{handler, capture}]; lazy
    this.nodeType   = NODE_ELEMENT;
    this._ownerDoc  = null;    // set by createElement/adopt; pre-init keeps the hidden class STABLE so the
                               // per-element hot readers (find/visible_text/cascade) hit monomorphic ICs.
  }
  getRootNode(options) {
    // DOM "get the root": the topmost node reached by following `_parent`.
    // `composed: false` (the default) stops at a shadow boundary — a
    // ShadowRoot's `_parent` IS its host, so without the break we'd cross into
    // the light tree and wrongly report the document. `composed: true` returns
    // the shadow-INCLUDING root and keeps climbing across the boundary.
    const composed = !!(options && options.composed);
    let cur = this;
    while (cur._parent) {
      if (!composed && cur._isShadowRoot) break;
      cur = cur._parent;
    }
    return cur;
  }
  // Per DOM, `nodeValue` is null for every node type except Attr (its value)
  // and CharacterData (its data), and its setter is a no-op on the others.
  // CharacterData / Attr override both; this base covers Document,
  // DocumentFragment, DocumentType, and Element (which otherwise inherited an
  // `undefined` nodeValue here).
  get nodeValue()    { return null; }
  set nodeValue(_v)  { /* no-op for non-Attr / non-CharacterData nodes */ }
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
      // Elements compare on namespace + prefix + local name (NOT the lowercased
      // `_tag`, which would miss case / namespace differences), then on their
      // attribute lists matched by (namespace, local name, value), order-
      // independently.
      if (this._ns !== other._ns || this._prefix !== other._prefix || this._localName !== other._localName) return false;
      const ak = Object.keys(this._attrs), bk = Object.keys(other._attrs);
      if (ak.length !== bk.length) return false;
      const bMap = new Map();
      for (const k of bk) {
        const m = other._attrNS && other._attrNS[k];
        bMap.set((m ? m.ns || '' : '') + '\x00' + (m ? m.localName : k), other._attrs[k]);
      }
      for (const k of ak) {
        const m = this._attrNS && this._attrNS[k];
        const key = (m ? m.ns || '' : '') + '\x00' + (m ? m.localName : k);
        if (!bMap.has(key) || bMap.get(key) !== this._attrs[k]) return false;
      }
    } else if (this.nodeType === NODE_ATTRIBUTE) {
      if (this._ns !== other._ns || this._localName !== other._localName || this.value !== other.value) return false;
    } else if (this.nodeType === NODE_DOCTYPE) {
      if (this.name !== other.name || this.publicId !== other.publicId || this.systemId !== other.systemId) return false;
    } else if (this.nodeType === NODE_PI) {
      if (this._target !== other._target || (this._data || '') !== (other._data || '')) return false;
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
    // Spec "flatten options" reads `capture` (a getter on `options` must run)
    // BEFORE the null-callback early-return below.
    const capture = flattenCapture(options);
    // DOM spec: the listener callback is either a Function OR an
    // EventListener object with a `handleEvent` method. We store the RAW
    // callback and resolve `handleEvent` at INVOKE time (per "inner
    // invoke": Get on each dispatch, so a getter runs every time and a
    // handleEvent added/replaced after registration is honoured) — NOT
    // pre-bound. Stimulus's central dispatcher passes one EventListener
    // object per (element, eventName) pair with bindings looked up inside
    // handleEvent, so object identity is what dedup / removal key on.
    let isObject = false;
    if (typeof handler === 'function') { /* function callback */ }
    else if (handler !== null && typeof handler === 'object') isObject = true;
    else return;   // null / undefined / primitive → no-op
    // Passive flag: explicit `{passive: …}` wins; otherwise the spec's
    // default-passive-value (touchstart/move/wheel on window/doc/root/body).
    const passive = (options && typeof options === 'object' && options.passive !== undefined)
      ? !!options.passive
      : defaultPassiveValue(type, this);
    // `once`: the listener is removed before it's invoked, so a callback that
    // re-dispatches the same event doesn't re-enter it (the spec bounds what
    // would otherwise be unbounded recursion — see dispatch.js fireListeners).
    const once = !!(options && typeof options === 'object' && options.once);
    this._listeners = this._listeners || Object.create(null);
    const list = this._listeners[type] || (this._listeners[type] = []);
    // Per spec, identical {type, callback, capture} is deduped — and the
    // callback identity is the original function / object reference.
    if (list.some(l => l.handler === handler && l.capture === capture)) return;
    list.push({ handler, isObject, capture, passive, once });
  }
  removeEventListener(type, handler, options) {
    // Spec "flatten options" reads `capture` before the empty-list early-return.
    const capture = flattenCapture(options);
    if (!this._listeners || !this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(l => {
      // Callback identity is the original function / object reference.
      const isMatch = l.capture === capture && l.handler === handler;
      // Mark so an in-flight dispatch's snapshot skips this now-removed entry.
      if (isMatch) l.removed = true;
      return !isMatch;
    });
  }
  dispatchEvent(event) {
    // The script-facing IDL method → untrusted (dispatchEventPublic). UA-internal
    // callers import `dispatchEvent` directly, which marks the event trusted.
    return dispatchEventPublic(this, event);
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
    // A shadow host with delegatesFocus delegates focus to its "focus delegate"
    // — the first focusable element in its shadow tree (tree order) — rather than
    // focusing the host itself. The delegate becomes the shadow tree's
    // activeElement, and document.activeElement retargets up to the host. With no
    // focusable delegate, focus() is a no-op. If the shadow tree already has a
    // focused descendant, focus() keeps it rather than re-delegating to the first
    // focusable. (shadow-dom/focus/focus-method-delegatesFocus.html)
    if (this._shadowRoot && this._shadowRoot._delegatesFocus) {
      const delegate = this._shadowRoot.activeElement || firstFocusDelegate(this._shadowRoot);
      if (delegate) delegate.focus();
      return;
    }
    // Per HTML focusing-steps: `el.focus()` on a non-focusable element
    // is a no-op. Without this guard, Discourse's DMenu close path
    // (closes its toolbar then `.focus()`s the trigger SPAN — a
    // `<span class="composer-image-node">` with no tabindex/role) was
    // mutating `document.activeElement`, so PM's strict `hasFocus()`
    // (root.activeElement === view.dom) returned false on the next
    // dispatch and `selectionToDOM` bailed — leaving the caret behind
    // when Enter inserted a new paragraph after a selected image.
    if (!isFocusable(this)) return;
    const prev = globalThis.document._activeElement;
    if (prev === this) {
      // Already focused: no blur/focus churn, but re-evaluate :focus-visible — a
      // keyboard re-interaction (send_keys/Tab onto the current element) flips the
      // ring back on. `__csimFocusModality` is the last DRIVER action (pointer/
      // keyboard set at the click/Tab/send_keys entry points), not a true
      // last-input bit, so it stays sticky until the next driver action.
      globalThis.__csimFocusVisible =
        (globalThis.__csimFocusModality !== 'pointer') || __isTextEntryFocusTarget(this);
      return;
    }
    const doc = globalThis.document;
    // HTML focus update steps: while the OUTGOING element fires its blur /
    // focusout, no element is the "currently focused area" — `document.
    // activeElement` is <body> and `:focus` matches nothing (verified against
    // Chrome). So clear `_activeElement` (its getter falls back to <body>) for
    // the duration of those events, and commit `this` only just before its own
    // focus / focusin. This also makes focus() re-entrant-safe: a blur/focusout
    // handler that synchronously moves focus — Discourse's ProseMirror alt-text
    // `onBlur → saveAltText → onSave → view.focus()` — now finds no element to
    // re-blur, so the old unbounded focus↔blur loop (which overflowed the stack,
    // threw a RangeError, was caught, and retried forever) can't form; the
    // handler completes the transition itself and the re-check below bails so we
    // neither double-fire focus nor clobber the target it chose. (`blur()` below
    // likewise clears `_activeElement` before dispatching.)
    doc._activeElement = null;
    if (prev) {
      // blur/focusout on the element losing focus carry relatedTarget = the
      // element gaining it; FocusEvent (not plain Event) so the dispatch path
      // retargets relatedTarget across shadow boundaries (shadow-relatedTarget).
      try { dispatchEvent(prev, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true, relatedTarget: this })); } catch (_) {}
      try { dispatchEvent(prev, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true, relatedTarget: this })); } catch (_) {}
    }
    // A blur/focusout handler above may have already moved focus (to `this` or
    // elsewhere). If so it owns the result — don't re-fire focus or override it.
    if (doc._activeElement !== null) return;
    doc._activeElement = this;
    // `:focus-visible` latch: the focus ring shows unless this focus was driven
    // by a pointer (input handlers set `__csimFocusModality`), and ALWAYS shows
    // for text-entry controls (real browsers always render their focus ring,
    // regardless of how focus arrived). Latched at focus time; the matcher reads
    // it. (shadow-dom/focus/focus-click-on-shadow-host.html)
    globalThis.__csimFocusVisible =
      (globalThis.__csimFocusModality !== 'pointer') || __isTextEntryFocusTarget(this);
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
    // focus/focusin on the element gaining focus carry relatedTarget = the
    // element that lost it (retargeted across shadow boundaries by dispatch).
    try { dispatchEvent(this, new FocusEvent('focus',    { bubbles: false, cancelable: false, composed: true, relatedTarget: prev })); } catch (_) {}
    try { dispatchEvent(this, new FocusEvent('focusin',  { bubbles: true,  cancelable: false, composed: true, relatedTarget: prev })); } catch (_) {}
  }
  blur() {
    const doc = globalThis.document;
    let target = this;
    if (doc._activeElement !== this) {
      // A delegatesFocus host: the focused element lives in its shadow tree, but
      // document.activeElement retargets up to the host — so blur() on the host
      // unfocuses the delegated element. (A slotted light-DOM element that has
      // focus is NOT delegated: document.activeElement is the slotted element,
      // not the host, so this branch is skipped and blur() no-ops.)
      const sr = this._shadowRoot;
      if (sr && sr._delegatesFocus && doc.activeElement === this) {
        target = doc._activeElement;
      } else {
        return;
      }
    }
    doc._activeElement = null;
    try { dispatchEvent(target, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true })); } catch (_) {}
    try { dispatchEvent(target, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true })); } catch (_) {}
  }

  // Layout stubs — there's no rendering engine, so geometry is
  // always zero. Returning a sensible shape lets feature-detection
  // probes in jQuery / DOM libraries continue instead of throwing
  // "not a function". `getBoundingClientRect()` is the canonical
  // shape; `getClientRects()` returns a DOMRectList (an empty
  // array works for callers that just iterate or check length).
  // No layout engine; the 1×1 sentinel keeps jQuery `:visible` /
  // Stimulus / IntersectionObserver probes from misclassifying
  // visible elements as hidden. `_layoutY` gives each visible
  // element a unique top in measurement order — Discourse's
  // `_moveSelection` (J/K shortcut) calls `articles.find(rect.top
  // >= headerOffset())`; with all rects at top=0 the find never
  // matches and Discourse's fallback selects the LAST article
  // instead of the first. Assigning Y lazily on first measurement
  // means header (measured at boot to set `--header-offset`) lands
  // at 0 and later-measured articles get Y > headerOffset.
  _ensureLayoutY() {
    if (!isVisibleNode(this)) return null;
    return this._layoutY ??= nextLayoutY();
  }
  getBoundingClientRect() {
    const y = this._ensureLayoutY();
    return y == null ? new globalThis.DOMRect(0, 0, 0, 0)
                     : new globalThis.DOMRect(0, y, 1, 1);
  }
  getClientRects() {
    const y = this._ensureLayoutY();
    return y == null ? [] : [new globalThis.DOMRect(0, y, 1, 1)];
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
  // Per-element scroll state. Real browsers store scroll offsets on
  // every scrollable box; without a layout engine we can't know which
  // boxes are actually scrollable, so we just remember whatever a
  // caller stored. Discourse's RouteScrollManager saves
  // `scrollingElement.scrollTop` on routeWillChange and restores it on
  // routeDidChange — the restore is `scrollingElement.scrollTo(left,
  // top)`, so a no-op scroll setter loses the saved position and the
  // `page.go_back` scroll-restore assertion fails.
  get scrollTop()    { return this._scrollTop  || 0; }
  set scrollTop(v) {
    const next = Number(v) || 0;
    if (next === (this._scrollTop || 0)) return;
    this._scrollTop = next;
    __notifyScroll(this);
  }
  get scrollLeft()   { return this._scrollLeft || 0; }
  set scrollLeft(v) {
    const next = Number(v) || 0;
    if (next === (this._scrollLeft || 0)) return;
    this._scrollLeft = next;
    __notifyScroll(this);
  }
  // scrollIntoView({behavior, block, inline}) — without layout we
  // can't actually scroll, but the user-scroll signal is what
  // DLoadMore-style pagination sentinels gate on. Update the document
  // scrolling element's scrollTop to the target's monotonic Y so
  // `window.scrollY > 0` after a programmatic scrollIntoView (Ember's
  // route-scroll-manager service saves/restores this between routes).
  scrollIntoView(_opts) {
    const y = this._ensureLayoutY();
    const root = globalThis.document && globalThis.document.documentElement;
    if (root && typeof y === 'number') {
      root._scrollTop = y;
    }
    // scrollIntoView always refires IOs even if scroll didn't move —
    // it's a user-action signal that pagination sentinels rely on.
    __notifyScroll(this);
  }
  scrollIntoViewIfNeeded(_opts) { this.scrollIntoView(_opts); }
  scrollTo() {
    const [x, y] = __scrollArgsToXY(arguments);
    let changed = false;
    if (typeof x === 'number' && x !== (this._scrollLeft || 0)) { this._scrollLeft = x; changed = true; }
    if (typeof y === 'number' && y !== (this._scrollTop  || 0)) { this._scrollTop  = y; changed = true; }
    if (changed) __notifyScroll(this);
  }
  scrollBy() {
    const [dx, dy] = __scrollArgsToXY(arguments);
    let changed = false;
    if (typeof dx === 'number' && dx !== 0) { this._scrollLeft = (this._scrollLeft || 0) + dx; changed = true; }
    if (typeof dy === 'number' && dy !== 0) { this._scrollTop  = (this._scrollTop  || 0) + dy; changed = true; }
    if (changed) __notifyScroll(this);
  }

  // DOM Node bitmask (https://dom.spec.whatwg.org/#dom-node-comparedocumentposition):
  // DISCONNECTED=1, PRECEDING=2, FOLLOWING=4, CONTAINS=8,
  // CONTAINED_BY=16, IMPLEMENTATION_SPECIFIC=32. Stimulus / Sizzle /
  // various libs use this for document-order sorting; idiomorph reads
  // the CONTAINS / CONTAINED_BY bits for ancestor relationships.
  compareDocumentPosition(other) {
    if (other === this) return 0;
    const DISCONNECTED = 1, PRECEDING = 2, FOLLOWING = 4,
          CONTAINS = 8, CONTAINED_BY = 16, IMPLEMENTATION_SPECIFIC = 32;
    // Ancestor relationship: `other` contains `this` -> CONTAINS|PRECEDING;
    // `other` is contained by `this` -> CONTAINED_BY|FOLLOWING.
    for (let n = this._parent; n; n = n._parent) {
      if (n === other) return CONTAINS | PRECEDING;       // 10
    }
    for (let n = other._parent; n; n = n._parent) {
      if (n === this) return CONTAINED_BY | FOLLOWING;    // 20
    }
    const cmp = compareDocOrder(this, other);
    if (cmp < 0) return FOLLOWING;  // 4
    if (cmp > 0) return PRECEDING;  // 2
    // Disconnected (no common root). Spec requires a result that is
    // DISCONNECTED|IMPLEMENTATION_SPECIFIC plus a stable PRECEDING or
    // FOLLOWING bit, consistent for any given pair. Use per-node ordinal
    // ids as a deterministic tiebreak.
    const dir = __nodeOrdinal(this) < __nodeOrdinal(other) ? FOLLOWING : PRECEDING;
    return DISCONNECTED | IMPLEMENTATION_SPECIFIC | dir;
  }

  cloneNode(deep) {
    // DOM: cloning a shadow root directly is not allowed (a shadow root is
    // cloned only as part of cloning its clonable host) — throw NotSupportedError.
    if (this._isShadowRoot) {
      throw new globalThis.DOMException("Failed to execute 'cloneNode' on 'Node': ShadowRoot nodes are not clonable.", 'NotSupportedError');
    }
    const copy = this._cloneShell();
    if (deep && this._children) {
      for (const c of this._children) {
        const cc = c.cloneNode(true);
        cc._parent = copy;
        copy._children.push(cc);
      }
      // A deep-cloned Document must re-own its cloned subtree — the copied
      // nodes' _ownerDoc still points at the original, but a document clone's
      // descendants belong to the clone (like createDocument / createHTMLDocument
      // re-tag). ownerDocument drives tag-name casing, createAttribute, the
      // FrameController cross-document check, etc. (documentElement is derived
      // from _children, so the cloned tree above already establishes it.)
      if (copy.nodeType === NODE_DOC) {
        for (const c of copy._children) walkSubtree(c, n => { n._ownerDoc = copy; });
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
    // A clonable shadow root is duplicated onto the clone, deep-cloning its
    // tree — independent of `deep` (cloneNode(false) of the host still clones
    // the shadow). `_shadowRoot` is unset on virtually every element, so this
    // is a cheap short-circuit on the hot clone path (rule 3).
    if (this.nodeType === NODE_ELEMENT && this._shadowRoot && this._shadowRoot.clonable) {
      const src = this._shadowRoot;
      const sr  = copy.attachShadow({ mode: src.mode, slotAssignment: src.slotAssignment, clonable: true,
                                      delegatesFocus: src.delegatesFocus, serializable: src.serializable });
      for (const c of src._children) {
        const cc = c.cloneNode(true);
        cc._parent = sr;
        sr._children.push(cc);
      }
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
  // `Node.normalize()` per DOM spec — merge adjacent exclusive-Text
  // children (concatenating their data), drop empty Text nodes, then
  // recurse into element children. Sanitizers / contenteditable
  // reconcilers call it to coalesce text runs after repeated edits.
  normalize() {
    const kids = this._children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (node.nodeType === NODE_TEXT) {
        if ((node._data || '').length === 0) {
          // Removing an empty Text node — mirror removeChild's
          // observable contract: queue a childList removedNodes record,
          // drop connectivity, and null the parent. Capture siblings first.
          const ep = i > 0 ? kids[i - 1] : null;
          const en = i + 1 < kids.length ? kids[i + 1] : null;
          kids.splice(i, 1);
          node._parent = null;
          unregisterSubtree(node);
          recordChildList(this, [], [node], ep, en);
          i--;
          continue;
        }
        let next = kids[i + 1];
        while (next && next.nodeType === NODE_TEXT) {
          // Concatenate the sibling into the survivor; fire a
          // characterData record carrying the survivor's pre-merge value.
          const prev = node._data || '';
          node._data = prev + (next._data || '');
          recordCharacterData(node, prev);
          // The removed node's previousSibling is the survivor `node`; its
          // nextSibling is whatever follows it (captured before the splice).
          const removedNext = kids[i + 2] || null;
          kids.splice(i + 1, 1);
          next._parent = null;
          unregisterSubtree(next);
          recordChildList(this, [], [next], node, removedNext);
          next = kids[i + 1];
        }
      } else if (node.nodeType === NODE_ELEMENT) {
        node.normalize();
      }
    }
  }
  // https://dom.spec.whatwg.org/#dom-node-lookupnamespaceuri
  lookupNamespaceURI(prefix) {
    return locateNamespace(this, (prefix == null || prefix === '') ? null : String(prefix));
  }
  // https://dom.spec.whatwg.org/#dom-node-isdefaultnamespace
  isDefaultNamespace(namespace) {
    const want = (namespace == null || namespace === '') ? null : String(namespace);
    return locateNamespace(this, null) === want;
  }
  // https://dom.spec.whatwg.org/#dom-node-lookupprefix
  lookupPrefix(namespace) {
    if (namespace == null || namespace === '') return null;
    const ns = String(namespace);
    for (let el = (this.nodeType === NODE_ELEMENT ? this
                  : this.nodeType === NODE_DOC ? this.documentElement
                  : (this._parent && this._parent.nodeType === NODE_ELEMENT ? this._parent : null));
         el; el = (el._parent && el._parent.nodeType === NODE_ELEMENT) ? el._parent : null) {
      if (el._ns === ns && el._prefix != null) return el._prefix;
      if (el._attrNS) {
        for (const key in el._attrNS) {
          const meta = el._attrNS[key];
          if (meta.ns === XMLNS_NS && meta.prefix === 'xmlns' && el._attrs[key] === ns) return meta.localName;
        }
      }
    }
    return null;
  }
  get firstChild()    { return this._children[0] || null; }
  get lastChild()     { return this._children[this._children.length - 1] || null; }
  // Live + cached NodeList: `_children` IS a NodeList, so return it directly
  // (per spec childNodes is a live, identity-stable collection). Internal code
  // mutates `_children` in place, so held childNodes references stay current.
  get childNodes()    { return this._children; }
  hasChildNodes()     { return this._children.length > 0; }
  // `Node.baseURI` — the node document's document base URL, honouring the
  // first `<base href>` element (falling back to the document URL). Document
  // overrides to resolve against itself.
  get baseURI() {
    const d = this.ownerDocument;
    if (d && d !== this) return documentBaseURL(d);
    return (globalThis.location && globalThis.location.href) || 'about:blank';
  }
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
    // HTML "fire a synthetic pointer event": a disabled form control's
    // synthetic click is a no-op — no click event, no activation. (An
    // untrusted event dispatched directly via dispatchEvent still fires;
    // only this synthetic-click path is gated.)
    if (isActuallyDisabled(this)) return;
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
      // For radio, remember the group's prior selection so a canceled click
      // restores it (not just this control's own prior state).
      const prevCheckedRadio = inputType === 'radio' ? checkedRadioInGroup(this) : null;
      if (isInputControl) {
        if (inputType === 'checkbox') toggleChecked(this);
        else                          setRadio(this);
      }
      // A real click is composed (it crosses shadow boundaries to the host).
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, which: 1 });
      // We performed the checkbox/radio pre-toggle above, so the dispatch
      // algorithm must NOT run its own activation (would double-toggle).
      ev._csimActivationHandled = true;
      dispatchEvent(this, ev);
      if (ev.defaultPrevented && isInputControl) {
        // Roll back the state change if the click was cancelled.
        if (inputType === 'radio') {
          delete this._attrs.checked;
          if (prevCheckedRadio) prevCheckedRadio._attrs.checked = '';
        } else if (wasChecked) this._attrs.checked = '';
        else                   delete this._attrs.checked;
      } else if (isInputControl && isConnected(this) && (this._attrs.checked != null) !== wasChecked) {
        // Per HTML, a DETACHED control's activation mutates state but fires
        // no input/change — only a connected control dispatches them.
        try { dispatchEvent(this, new InputEvent('input',  { bubbles: true, cancelable: true })); } catch (_) {}
        try { dispatchEvent(this, new Event('change', { bubbles: true, cancelable: false })); } catch (_) {}
      }
      // `selfActivated` tracks whether `this` (the clicked element) ran its
      // OWN activation behaviour — checkbox/radio toggle, form submit,
      // reset, `<summary>` toggle, or a `<label>` hop. Per the single-
      // activation-behaviour spec only ONE activation runs per click, so
      // once `this` self-activates we must NOT also walk up and activate an
      // ANCESTOR hyperlink (the anchor block below). A non-prevented click
      // on a checkbox/radio is itself the activation.
      let selfActivated = isInputControl && !ev.defaultPrevented;
      let didSubmit = false;
      // Re-check the control AFTER dispatch: a listener may have morphed its
      // type or disabled it. A disconnected control's form never submits, and
      // a (now) disabled submit button has no activation behavior.
      if (!ev.defaultPrevented && isSubmitButton(this) && isConnected(this) && !isActuallyDisabled(this)) {
        const form = formForControl(this);
        if (form) {
          const submitEv = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: this });
          dispatchEvent(form, submitEv);
          if (!submitEv.defaultPrevented) {
            globalThis.__csimPendingFormSubmit = { form, submitter: this };
            didSubmit = true;
            selfActivated = true;
          }
        }
      }
      // HTML-spec activation behaviour for a reset control (`<input
      // type=reset>` / `<button type=reset>`): reset the control's form
      // owner. `form.reset()` runs the "reset the form" steps (restore
      // every control's default + fire `reset`). Programmatic
      // `resetButton.click()` must do this just like a real click, and
      // — per the single-activation-behaviour spec — only the clicked
      // control activates, so nesting it inside another activatable
      // parent never double-fires.
      if (!ev.defaultPrevented &&
          (this._tag === 'input' || this._tag === 'button') &&
          (this._attrs.type || '').toLowerCase() === 'reset') {
        const form = formForControl(this);
        if (form && typeof form.reset === 'function') { form.reset(); selfActivated = true; }
      }
      // `<summary>` activation toggles its `<details>` parent (open
      // flag flip + non-bubbling `toggle` event). Mirrors the UA-click
      // path so a programmatic `summary.click()` behaves the same.
      if (!ev.defaultPrevented && this._tag === 'summary') {
        let details = this._parent;
        while (details && details.nodeType === NODE_ELEMENT && details._tag !== 'details') {
          details = details._parent;
        }
        if (details && details.nodeType === NODE_ELEMENT && details._tag === 'details') {
          const oldOpen = details._attrs.open;
          if (oldOpen != null) delete details._attrs.open;
          else                 details._attrs.open = '';
          recordAttrMutation(details, 'open', oldOpen == null ? null : oldOpen);
          try { dispatchEvent(details, new Event('toggle', { bubbles: false })); } catch (_) {}
          selfActivated = true;
        }
      }
      // `<label>` activation: a click on a non-interactive descendant of
      // a `<label>` runs a synthetic click on the label's labeled
      // control (HTML "click in a label" → activation of the labeled
      // control), like the UA-click path's label hop. Per the single-
      // activation-behaviour spec, the label does nothing when the click
      // is targeted at interactive content (or a descendant thereof) —
      // that element's own activation runs instead. The structural guards
      // below cover it: `this` being labelable / interactive / a label is
      // skipped here, and `enclosingLabelFor` stops at any interactive
      // ancestor between `this` and the label. Runs BEFORE the anchor hop
      // so that a label wrapping the click target takes precedence over a
      // still-further-out ancestor `<a>` (single activation). NOTE: unlike
      // the UA path we intentionally skip `this` itself being the
      // `<label>` (a direct `labelEl.click()`): the spec/WPT cases always
      // click a descendant, and no app drives a label through IDL click().
      if (!ev.defaultPrevented && !selfActivated &&
          this._tag !== 'label' &&
          !LABELABLE.has(this._tag) &&
          !isInteractiveForLabel(this)) {
        const label = enclosingLabelFor(this);
        if (label) {
          const labeled = labeledControlFor(label);
          if (labeled && labeled !== this) { labeled.click(); selfActivated = true; }
        }
      }
      // HTML-spec anchor activation behaviour for programmatic
      // `el.click()`. The IDL `click()` method's activation runs on `this`
      // ONLY (the element `.click()` was called on) — unlike a trusted
      // user click, it does NOT walk up to activate an enclosing `<a>`.
      // So a synthetic click on a non-hyperlink (a submit button, a plain
      // descendant) inside an `<a>` does NOT navigate; only `anchor.click()`
      // directly does. Avo's filter controllers call
      // `this.urlRedirectTarget.click()` on a hidden `<a>` element itself,
      // so `this` IS the anchor there. (The UA / Capybara click path keeps
      // the ancestor walk — that one models a trusted click.) Same-document
      // fragment links navigate in JS (and fire `hashchange`); everything
      // else DEFERS the document fetch to a Ruby drain slot rather than
      // navigating in-call (navigating from inside a V8 callback rebuilds
      // the Context mid-eval; see `feedback_visit_always_rebuilds`). The
      // `!didSubmit`/`!selfActivated` gates are belt-and-suspenders for the
      // single-activation contract (an `<a>`/`<area>` never self-activates
      // via the earlier blocks, so they hold trivially here).
      if (!ev.defaultPrevented && !didSubmit && !selfActivated &&
          (this._tag === 'a' || this._tag === 'area') &&
          this._attrs.href != null && (this._attrs.href || '').trim() !== '' &&
          !(this._attrs.href || '').toLowerCase().startsWith('javascript:')) {
        if (!fragmentNavigate(this)) {
          globalThis.__csimPendingNavigation = {
            url: String(this._attrs.href),
            target: this._attrs.target || ''
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
  before (...nodes) {
    const parent = this._parent;
    if (!parent) return;
    // viable previous sibling: first preceding sibling not itself being inserted.
    let ref = this.previousSibling;
    while (ref && nodes.indexOf(ref) !== -1) ref = ref.previousSibling;
    const node = convertNodesIntoNode(nodes);
    parent.insertBefore(node, ref ? ref.nextSibling : parent.firstChild);
  }
  after (...nodes) {
    const parent = this._parent;
    if (!parent) return;
    // viable next sibling: first following sibling not itself being inserted.
    let ref = this.nextSibling;
    while (ref && nodes.indexOf(ref) !== -1) ref = ref.nextSibling;
    parent.insertBefore(convertNodesIntoNode(nodes), ref);
  }
  replaceWith (...nodes) {
    const parent = this._parent;
    if (!parent) return;
    let ref = this.nextSibling;
    while (ref && nodes.indexOf(ref) !== -1) ref = ref.nextSibling;
    const node = convertNodesIntoNode(nodes);
    // replaceChild can't expand a fragment, so insert-then-remove. If `this`
    // was detached while converting (a node arg adopted it), fall back to the
    // viable next sibling.
    if (this._parent === parent) { parent.insertBefore(node, this); parent.removeChild(this); }
    else parent.insertBefore(node, ref);
  }
  // `ParentNode.prepend(...nodes)` / `append(...nodes)` — the
  // sibling of `appendChild` that accepts strings + variadic args.
  prepend (...nodes) { this.insertBefore(convertNodesIntoNode(nodes), this._children[0] || null); }
  append  (...nodes) { this.appendChild(convertNodesIntoNode(nodes)); }
  // ParentNode.replaceChildren(...nodes) — DOM spec: clear then append.
  // React 19 / Stimulus controllers reach for it as the modern
  // shorthand instead of `el.innerHTML = ''` + appendChild.
  replaceChildren(...nodes) {
    // Spec "replace all": 1. convert nodes (moving any from their old parents,
    // which fires removal records THERE); 2. validate the result against this
    // (a Document with an existing element child rejects another element, etc.)
    // BEFORE touching this's children; 3. detach this's current children and
    // insert the new ones, queueing a SINGLE childList record on this
    // (removed = all old, added = all new) — not one per child.
    const node = convertNodesIntoNode(nodes);
    ensurePreInsertionValidity(node, this, null);
    const isFrag  = node && node.nodeType === NODE_FRAGMENT;
    const added   = isFrag ? node._children.slice() : (node ? [node] : []);
    const removed = this._children.slice();
    const wasConnected = isConnected(this);
    for (const c of removed) { c._parent = null; unregisterSubtree(c); }
    this._children = newChildList();
    for (const c of added) {
      // A node still parented elsewhere (the single-node case from another
      // tree) is removed from that parent — firing its own record. Fragment
      // children already sit on `node` (moved by convertNodesIntoNode); just
      // re-home them and clear the fragment below.
      if (c._parent && c._parent !== this && c._parent !== node) c._parent.removeChild(c);
      c._parent = this;
      this._children.push(c);
      registerSubtree(c);
      askForReset(c);
    }
    if (isFrag) node._children = newChildList();
    if (removed.length || added.length) recordChildList(this, added, removed);
    if (wasConnected) {
      for (const c of removed) fireCEDisconnect(c);
      for (const c of added)   globalThis.__csimFireCEConnect(c);
    }
    // Rebuilding a `<select>`'s options wholesale (`select.innerHTML = …`,
    // a common Stimulus/jQuery refresh) bypasses the connect-walk's
    // per-select finalize because the select itself isn't in the walked
    // subtree — initialise + reconcile selectedness here so the implicit
    // default lands even on a detached or multiple select.
    if (this._tag === 'select') finalizeSelectOptions(this);
  }
  // `Element.children` is a LIVE HTMLCollection (not a plain Array): it carries
  // `item`/`namedItem` and the empty-name / named-getter semantics. The collection
  // object is cached per element (like real browsers) so repeated `.children`
  // access on a hot DOM-traversal path is O(1) and `el.children === el.children`;
  // its Proxy re-runs the element-filter query per settle generation, so it still
  // tracks the live tree after mutations.
  get children() {
    return this._childrenColl ||
      (this._childrenColl = liveHTMLCollection(() => this._children.filter(c => c.nodeType === NODE_ELEMENT)));
  }
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
  // Move every child of `frag` into this before `ref` (null = append), per the
  // DOM "insert"/"remove" steps: the fragment's children are first removed (ONE
  // childList record on the fragment) then inserted (ONE record on this with all
  // of them as addedNodes) — not one record per child.
  _insertFragmentChildren(frag, ref) {
    const moved = frag._children.slice();
    if (!moved.length) return frag;                 // empty fragment: no-op, no records
    for (const c of moved) c._parent = null;
    frag._children.length = 0;
    recordChildList(frag, [], moved, null, null);   // fragment emptied: one removal record
    let idx = ref == null ? this._children.length : this._children.indexOf(ref);
    if (idx < 0) idx = this._children.length;
    const prevSib = idx > 0 ? this._children[idx - 1] : null;
    const nextSib = idx < this._children.length ? this._children[idx] : null;
    this._children.splice(idx, 0, ...moved);
    liveRangesOnInsert(this, idx, moved.length);
    const connected = isConnected(this);
    for (const c of moved) { c._parent = this; registerSubtree(c); }
    recordChildList(this, moved.slice(), [], prevSib, nextSib);  // one addition record
    if (this._tag === 'script') globalThis.__csimScriptChildrenChanged(this);   // outer <script> runs before the inserted children's insertion steps
    if (connected) for (const c of moved) globalThis.__csimFireCEConnect(c);
    for (const c of moved) askForReset(c);
    return frag;
  }
  // Replace `old` (a child of this) with `nodes` (already-detached nodes, e.g.
  // a parsed fragment's children) as a single DOM "replace": ONE childList
  // record on this with removedNodes = [old] and addedNodes = nodes — not a
  // remove plus separate inserts. Shared by the `outerHTML` setter and
  // replaceChild's DocumentFragment branch.
  _replaceChildWithNodes(old, nodes) {
    const i = this._children.indexOf(old);
    if (i < 0) return;
    const wasConnected = isConnected(this);
    const prevSib = i > 0 ? this._children[i - 1] : null;
    const nextSib = i + 1 < this._children.length ? this._children[i + 1] : null;
    for (const c of nodes) adoptIntoParent(this, c);
    liveRangesOnRemove(this, old, i);   // collapse boundaries inside `old` before detaching it
    old._parent = null;
    unregisterSubtree(old);
    this._children.splice(i, 1, ...nodes);
    liveRangesOnInsert(this, i, nodes.length);
    for (const c of nodes) { c._parent = this; registerSubtree(c); }
    recordChildList(this, nodes.slice(), [old], prevSib, nextSib);
    if (wasConnected) {
      fireCEDisconnect(old);
      for (const c of nodes) globalThis.__csimFireCEConnect(c);
    }
    for (const c of nodes) askForReset(c);
    // Replacing a selected option (or an option-bearing subtree) with
    // non-option nodes drops the owning select's selection — reconcile the
    // removal side too, like removeChild / moveBefore.
    askForResetAfterRemoval(old, this);
  }
  appendChild(child) {
    assertNodeArg(child);
    ensurePreInsertionValidity(child, this, null);
    // DocumentFragment splice: spec says appendChild(fragment) moves
    // each child of the fragment to the new parent and leaves the
    // fragment empty. The fragment itself is not inserted. Real-DOM
    // libraries (jQuery's `.html(fragment)`, Stimulus's element
    // templating) rely on this — without unwrapping we'd graft a
    // bare DocumentFragment into the tree, breaking ancestor walks
    // and Capybara's visibility / find_xpath paths.
    if (child && child.nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, null);
    adoptIntoParent(this, child);
    child._parent = this;
    const insertIndex = this._children.length;
    this._children.push(child);
    liveRangesOnInsert(this, insertIndex, 1);
    registerSubtree(child);
    recordChildList(this, [child], []);
    if (this._tag === 'script') globalThis.__csimScriptChildrenChanged(this);   // outer <script> runs before the inserted child's insertion steps
    if (isConnected(this)) globalThis.__csimFireCEConnect(child);
    askForReset(child);
    return child;
  }
  removeChild(child) {
    assertNodeArg(child);
    // Spec: removeChild throws NotFoundError if `child` is not a child of this.
    if (child._parent !== this) {
      throw new globalThis.DOMException(
        'The node to be removed is not a child of this node.', 'NotFoundError');
    }
    const i = this._children.indexOf(child);
    if (i < 0) return null;
    // Capture the removed node's adjacent siblings BEFORE the splice — by
    // record-delivery time `child` is detached, so its own pointers are gone
    // and recordChildList can't derive them (it only derives from added nodes).
    const prevSib = i > 0 ? this._children[i - 1] : null;
    const nextSib = i + 1 < this._children.length ? this._children[i + 1] : null;
    const wasConnected = isConnected(this);
    nodeIteratorPreRemove(child);         // keep live NodeIterators' reference valid BEFORE the detach
    liveRangesOnRemove(this, child, i);   // collapse boundaries inside `child` BEFORE the detach
    this._children.splice(i, 1);
    child._parent = null;
    unregisterSubtree(child);
    // Focus fixup: removing the currently-focused element (or an ancestor of
    // it) resets the document's focus. `removeChild` is the "remove" half of a
    // regular move, so a focused element relocated via appendChild/insertBefore
    // loses focus — unlike `moveBefore`, which splices directly and preserves
    // it. activeElement falls back to <body> once cleared (see the getter).
    // Silent reset (no blur/focusout) matches Chromium's observable behavior on
    // DOM removal. Cheap: short-circuits unless something is focused.
    const doc = globalThis.document;
    const ae  = doc && doc._activeElement;
    if (ae && (ae === child || nodeContains(child, ae))) doc._activeElement = null;
    recordChildList(this, [], [child], prevSib, nextSib);
    // An option (or a subtree containing options) leaving a select can
    // drop its selection to zero — re-run the owning select's algorithm.
    askForResetAfterRemoval(child, this);
    if (wasConnected) fireCEDisconnect(child);
    return child;
  }
  insertBefore(child, ref) {
    // WebIDL: insertBefore(node, child) — child is nullable but NOT optional,
    // so a missing 2nd argument is a TypeError (distinct from an explicit
    // null/undefined, which mean "append"). arguments.length is the only way
    // to tell them apart.
    if (arguments.length < 2) {
      throw new TypeError("Failed to execute 'insertBefore': 2 arguments required");
    }
    assertNodeArg(child);
    if (ref != null) assertNodeArg(ref);
    ensurePreInsertionValidity(child, this, ref);
    // DOM pre-insert step 3: if the reference child IS the node being inserted,
    // advance it to the node's next sibling so "insert before itself" returns the
    // node to its own slot (a no-op move) instead of detaching it and appending
    // at the end (adoptIntoParent below would invalidate a ref === child).
    if (ref === child) ref = child.nextSibling;
    if (ref == null) return this.appendChild(child);
    // DocumentFragment splice — same unwrap as appendChild, but
    // inserting before `ref` rather than at the end (one record each on the
    // fragment and on this, via the shared helper).
    if (child && child.nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, ref);
    adoptIntoParent(this, child);
    const i = this._children.indexOf(ref);
    if (i < 0) return this.appendChild(child);
    child._parent = this;
    this._children.splice(i, 0, child);
    liveRangesOnInsert(this, i, 1);
    registerSubtree(child);
    recordChildList(this, [child], []);
    if (this._tag === 'script') globalThis.__csimScriptChildrenChanged(this);   // outer <script> runs before the inserted child's insertion steps
    if (isConnected(this)) globalThis.__csimFireCEConnect(child);
    askForReset(child);
    return child;
  }
  replaceChild(neu, old) {
    // https://dom.spec.whatwg.org/#concept-node-replace — same validity as
    // pre-insertion but the document-child constraints exclude `old` (the node
    // being replaced), and `old` must itself be a child (NotFoundError).
    assertNodeArg(neu);
    assertNodeArg(old);
    validateInsertion(neu, this, old, true);
    const i = this._children.indexOf(old);
    if (i < 0) return null;
    // Replacing a node with itself: per spec `old` is removed and `node`
    // (=== old) is then inserted before old's former next sibling, so it
    // lands back in its own slot. The position is unchanged, but it is two
    // observable mutations — a removal then an addition — which observers see
    // (DOM "replace" steps 7/11/13 with node === child).
    if (neu === old) {
      const ref = old.nextSibling;
      this.removeChild(old);
      this.insertBefore(neu, ref);
      return old;
    }
    // A DocumentFragment is inserted as its CHILDREN, never as itself. Per the
    // DOM "replace" steps this is ONE childList record (removedNodes [old],
    // addedNodes the fragment's children) plus the fragment's own emptying
    // record — not a separate remove + insert. Covers
    // `document.replaceChild(frag, documentElement)`.
    if (neu.nodeType === NODE_FRAGMENT) {
      const moved = neu._children.slice();
      for (const c of moved) c._parent = null;
      neu._children.length = 0;
      if (moved.length) recordChildList(neu, [], moved, null, null);
      this._replaceChildWithNodes(old, moved);
      return old;
    }
    const wasConnected = isConnected(this);
    // Cross-document `neu` is adopted into this node's document (the insert
    // steps adopt); a same-document replace is just a detach. See adoptIntoParent.
    adoptIntoParent(this, neu);
    // Re-find old's index: detaching `neu` above can shift it when `neu` was an
    // earlier sibling of `old` under this same parent.
    const j = this._children.indexOf(old);
    // Spec "replace" = remove `old` then insert `neu` at the same index, so
    // boundaries inside `old` collapse to (this, j) while boundaries past it
    // net out unchanged (the remove's −1 and the insert's +1 cancel).
    liveRangesOnRemove(this, old, j);
    neu._parent = this;
    old._parent = null;
    this._children[j] = neu;
    liveRangesOnInsert(this, j, 1);
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
    // Descendant text content: concatenate the data of all Text node
    // descendants in tree order. CDATASection is a Text subclass so its data
    // counts too; comments and processing instructions are not Text nodes and
    // contribute nothing.
    let s = '';
    for (const c of this._children) {
      if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) s += c.data;
      else if (c.nodeType === NODE_ELEMENT) s += c.textContent;
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
    this._children = newChildList();
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
  get innerText() {
    return (typeof globalThis.__csimInnerText === 'function')
      ? globalThis.__csimInnerText(this)   // "as rendered": visible-only + whitespace-collapsed (W3C §11)
      : this.textContent;                  // pre-boot fallback
  }
  set innerText(v) { this.textContent = v; }
}

// nodeType + DOCUMENT_POSITION_* constants are installed on the Node
// interface object and prototype via `installNodeConstants` (constants.js,
// wired in bridge.entry.js) — the single source for the spec table.

// Cross-realm Node brand. Each iframe realm has its OWN Node class (separate
// identity), so `x instanceof Node` is false for a node that belongs to another
// realm — but WebIDL `Node` parameters accept a node from ANY realm. Every
// realm's bridge defines this same string-keyed marker on Node.prototype, so a
// cross-realm read of `x.__csimIsNode` resolves through that realm's prototype
// and is true for any csim node. Non-enumerable so it can't leak into `for..in`
// / `Object.keys` over a node.
Object.defineProperty(Node.prototype, '__csimIsNode', { value: true });
// WebIDL `Node` type guard that, unlike `instanceof Node`, also accepts nodes
// from another realm (e.g. an iframe's document passed to the top realm's
// `createTreeWalker` / `createNodeIterator` / `Range`).
function isNodeArg(x) { return x != null && x.__csimIsNode === true; }

// CharacterData (https://dom.spec.whatwg.org/#interface-characterdata) — the
// shared base of Text / Comment / CDATASection / ProcessingInstruction. Real
// class (not a Text alias) so the prototype chain is `Text`/`Comment` →
// `CharacterData` → `Node`, which `instanceof` and the WPT constructor tests
// require. Subclasses set their own `nodeType` + `nodeName`.
class CharacterData extends Node {
  constructor(data) {
    super();
    // The constructor's `data` arg is `optional DOMString = ""`: `undefined`
    // (incl. no argument) → "", but `null` coerces to "null". (Factories like
    // `createTextNode` pre-stringify, so they pass a real string.)
    this._data = data === undefined ? '' : String(data);
  }
  get data()        { return this._data; }
  // Spec: every write to a Text node's `data` (or `nodeValue` /
  // `textContent`, which proxy through here) queues a
  // `characterData` mutation record. ProseMirror/Tiptap's
  // `domchange` reconciler reads these to map browser-side text
  // edits back into a transaction; without the record, our
  // `set("text")` on contenteditable updates the DOM but PM
  // silently skips the model update and `onUpdate` never fires.
  // `data` is `[LegacyNullToEmptyString] DOMString`: null → "", but undefined
  // → "undefined". nodeValue / textContent are nullable, so both null AND
  // undefined → "". Each coerces, then routes through `_setData`.
  set data(v)       { this._setData(v === null ? '' : String(v)); }
  get nodeValue()   { return this.data; }
  set nodeValue(v)  { this._setData(v == null ? '' : String(v)); }
  get textContent() { return this.data; }
  set textContent(v){ this._setData(v == null ? '' : String(v)); }
  _setData(next) {
    const prev = this._data;
    // Setting data is "replace data" over the whole node (offset 0, count =
    // old length), so live-range boundaries inside the old data collapse to 0.
    // Per spec this runs unconditionally — even setting `.data` to its current
    // value still clamps the ranges — so it precedes the no-op short-circuit.
    liveRangesOnReplaceData(this, 0, prev.length, next.length);
    if (prev === next) return;
    this._data = next;
    recordCharacterData(this, prev);
  }
  // prefix/namespaceURI/localName are NOT exposed on CharacterData: per DOM they
  // are IDL members of Element and Attr only, so `'localName' in textNode` must
  // be false (dom/historical.html). The XPath adapter coerces the resulting
  // undefined back to null for these nodes (see xpath.js).
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
  // CharacterData methods (https://dom.spec.whatwg.org/#interface-characterdata).
  // All offsets/counts are UTF-16 code units (JS string indexing), coerced to
  // unsigned long; the shared replace step clamps count and queues the
  // characterData mutation record.
  get length() { return this._data.length; }
  substringData(offset, count) {
    if (arguments.length < 2) throw new TypeError("Failed to execute 'substringData': 2 arguments required.");
    offset = offset >>> 0; count = count >>> 0;
    const len = this._data.length;
    if (offset > len) throw new globalThis.DOMException('The offset is greater than the data length.', 'IndexSizeError');
    return this._data.slice(offset, offset + count);   // slice clamps the end to len
  }
  appendData(data)          { if (arguments.length < 1) throw new TypeError("Failed to execute 'appendData': 1 argument required."); this._replaceData(this._data.length, 0, data); }
  insertData(offset, data)  { if (arguments.length < 2) throw new TypeError("Failed to execute 'insertData': 2 arguments required.");  this._replaceData(offset, 0, data); }
  deleteData(offset, count) { if (arguments.length < 2) throw new TypeError("Failed to execute 'deleteData': 2 arguments required.");  this._replaceData(offset, count, ''); }
  replaceData(offset, count, data) { if (arguments.length < 3) throw new TypeError("Failed to execute 'replaceData': 3 arguments required."); this._replaceData(offset, count, data); }
  _replaceData(offset, count, data) {
    offset = offset >>> 0; count = count >>> 0;
    const prev = this._data;
    const len  = prev.length;
    if (offset > len) throw new globalThis.DOMException('The offset is greater than the data length.', 'IndexSizeError');
    if (offset + count > len) count = len - offset;
    const str = String(data);
    // Live-range fix-up (DOM "replace data"): boundaries inside the replaced
    // span clamp to `offset`; boundaries after it shift by the length delta.
    liveRangesOnReplaceData(this, offset, count, str.length);
    // appendData/insertData/replaceData take a non-nullable DOMString, so
    // null → "null" and undefined → "undefined" (no LegacyNullToEmptyString).
    // Per the "replace data" algorithm this ALWAYS queues a characterData
    // record — even for a no-op like appendData("") — so MutationObserver
    // tests waiting on the empty-mutation record don't hang.
    this._data = prev.slice(0, offset) + str + prev.slice(offset + count);
    recordCharacterData(this, prev);
  }
}
globalThis.CharacterData = CharacterData;

// Text node (CharacterData subclass).
class Text extends CharacterData {
  constructor(data) {
    super(data);
    this.nodeType = NODE_TEXT;
  }
  get nodeName()    { return '#text'; }
  // Slottable mixin (Text + Element only — not Comment / ProcessingInstruction):
  // the slot this text node is assigned to in an open shadow tree.
  get assignedSlot() { return findSlotForSlottable(this, true); }
  _cloneShell()     { return new Text(this._data); }
  // Per DOM spec: split this text node into two at `offset`, keep the
  // prefix in `this`, return a new Text sibling holding the suffix
  // and inserted into the parent right after `this`. Discourse's
  // `HighlightedSearch` modifier calls splitText to wrap matched
  // substrings in `<span class="d-highlighted">`; without this, the
  // modifier throws and Glimmer aborts the rest of the modifier
  // install chain on that template (including `{{on "click"}}` on
  // search-result anchors).
  splitText(offset) {
    offset = offset >>> 0;   // WebIDL unsigned long
    const len = this._data.length;
    if (offset > len) {
      throw new globalThis.DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
    }
    const count   = len - offset;
    const newNode = new this.constructor(this._data.substring(offset));
    newNode._ownerDoc = this._ownerDoc;
    const parent = this._parent;
    if (parent) {
      const idx = parent._children.indexOf(this);
      parent._children.splice(idx + 1, 0, newNode);
      newNode._parent = parent;
      registerSubtree(newNode);
      recordChildList(parent, [newNode], []);   // the inserted half is an observable childList mutation
      // Live-range "split" fix-up: boundaries past the split point move to the
      // new node; a boundary at the new node's slot in the parent shifts right.
      liveRangesOnSplit(this, offset, newNode, parent, idx);
    }
    // Spec step: replace this node's data from `offset` (count chars) with "".
    // Runs BEFORE-moved boundaries are already on newNode, so this is a no-op
    // for them; remaining boundaries (≤ offset) stay put.
    this._replaceData(offset, count, '');
    return newNode;
  }
  // DOM `Text.wholeText`: the concatenated data of this node and its contiguous
  // Text-node siblings (the run of adjacent Text / CDATASection nodes), in tree
  // order. A non-Text sibling — or no parent — bounds the run.
  get wholeText() {
    const parent = this._parent;
    if (!parent || !parent._children) return this._data;
    const kids = parent._children;
    const isTextLike = (n) => n && (n.nodeType === NODE_TEXT || n.nodeType === NODE_CDATA);
    let start = kids.indexOf(this);
    if (start < 0) return this._data;
    while (start > 0 && isTextLike(kids[start - 1])) start--;
    let s = '';
    for (let j = start; j < kids.length && isTextLike(kids[j]); j++) s += kids[j]._data;
    return s;
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
    super(data);
    this.nodeType = NODE_COMMENT;
  }
  get nodeName() { return '#comment'; }
  _cloneShell()  { return new Comment(this.data); }
}
globalThis.Comment = Comment;

// CDATASection (XML only) — a Text subclass carrying literal character data.
// Created via `document.createCDATASection(data)` on an XML document.
class CDATASection extends Text {
  constructor(data) {
    super(data);
    this.nodeType = NODE_CDATA;
  }
  get nodeName() { return '#cdata-section'; }
  _cloneShell()  { return new CDATASection(this.data); }
}
globalThis.CDATASection = CDATASection;

// XML "Name" production (https://www.w3.org/TR/xml/#NT-Name) — stricter than the
// HTML-lenient element/attribute local-name checks: e.g. U+00B7 (·) is a
// NameChar but NOT a NameStartChar, and U+00D7 (×) is neither. Used by
// createProcessingInstruction's target validation.
function isXMLNameStartChar(c) {
  return c === 0x3A || (c >= 0x41 && c <= 0x5A) || c === 0x5F || (c >= 0x61 && c <= 0x7A) ||
    (c >= 0xC0 && c <= 0xD6) || (c >= 0xD8 && c <= 0xF6) || (c >= 0xF8 && c <= 0x2FF) ||
    (c >= 0x370 && c <= 0x37D) || (c >= 0x37F && c <= 0x1FFF) || (c >= 0x200C && c <= 0x200D) ||
    (c >= 0x2070 && c <= 0x218F) || (c >= 0x2C00 && c <= 0x2FEF) || (c >= 0x3001 && c <= 0xD7FF) ||
    (c >= 0xF900 && c <= 0xFDCF) || (c >= 0xFDF0 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0xEFFFF);
}
function isXMLNameChar(c) {
  return isXMLNameStartChar(c) || c === 0x2D || c === 0x2E || (c >= 0x30 && c <= 0x39) ||
    c === 0xB7 || (c >= 0x300 && c <= 0x36F) || (c >= 0x203F && c <= 0x2040);
}
function isXMLName(s) {
  if (s.length === 0) return false;
  let first = true;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (first) { if (!isXMLNameStartChar(c)) return false; first = false; }
    else if (!isXMLNameChar(c)) return false;
  }
  return true;
}

// ProcessingInstruction node (nodeType 7) — a CharacterData leaf carrying a
// read-only `target` plus `data`. Created via document.createProcessingInstruction.
class ProcessingInstruction extends CharacterData {
  constructor(target, data, ownerDoc) {
    super(data == null ? '' : String(data));
    this.nodeType = NODE_PI;
    this._target  = String(target);
    this._ownerDoc = ownerDoc || null;
  }
  get target()        { return this._target; }
  get nodeName()      { return this._target; }
  get ownerDocument() { return this._ownerDoc || globalThis.document; }
  _cloneShell()       { return new ProcessingInstruction(this._target, this.data, this._ownerDoc); }
  // CSSOM LinkStyle: an `<?xml-stylesheet?>` PI exposes its associated
  // CSSStyleSheet via `.sheet` (mirrors `<link rel=stylesheet>`). The PI's data
  // is raw XML text, so its pseudo-attributes (`href="…" type="…"`) are parsed
  // and entity-decoded here (unlike HTML attributes, which the parser already
  // decoded). Only `text/css` (or no type) qualifies; any other PI returns
  // undefined. (dom/nodes/ProcessingInstruction-escapes-1.xhtml)
  get sheet() {
    if (this._target !== 'xml-stylesheet' || !this.isConnected) { this._sheet = null; return undefined; }
    const attrs = {};
    const re = /([\w-]+)\s*=\s*("[^"]*"|'[^']*')/g;
    let m;
    while ((m = re.exec(this.data)) !== null) attrs[m[1]] = decodeEntities(m[2].slice(1, -1));
    const type = (attrs.type || '').toLowerCase();
    if (type && type !== 'text/css') return null;
    const href = attrs.href;
    if (!href) return null;
    if (!this._sheet) {
      this._sheet = new globalThis.CSSStyleSheet();
      this._sheet.ownerNode = this;
      this._sheet.href = href;
      let css = '';
      const dataCss = /^data:text\/css[^,]*,(.*)$/is.exec(href);   // `data:text/css,<css>`
      if (dataCss) { try { css = decodeURIComponent(dataCss[1]); } catch (_) { css = dataCss[1]; } }
      else { try { css = globalThis.__csimExternalAsset(href) || ''; } catch (_) {} }
      try { this._sheet.replaceSync(css); } catch (_) {}
    }
    return this._sheet;
  }
}
globalThis.ProcessingInstruction = ProcessingInstruction;

// Real Attr node (nodeType 2). Bound to an owner element it is a *view* over
// that element's attribute store (`attr.value` tracks live changes and writes
// through), so the existing fast `_attrs` map stays the single source of truth
// for the hot read paths (cascade / css-select / serialization). Detached
// (createAttribute, removeAttributeNode) it carries its own value. Identity is
// stable per (element, stored-key) through the element's `_attrNodes` cache.
class Attr extends Node {
  constructor(localName, namespace, prefix, value, ownerDoc) {
    super();
    this.nodeType   = NODE_ATTRIBUTE;
    this._localName = String(localName);
    this._ns        = namespace == null ? null : String(namespace);
    this._prefix    = prefix    == null ? null : String(prefix);
    this._value     = value     == null ? ''   : String(value);
    this._ownerElement = null;
    this._key       = null;     // element store key while bound; null when detached
    this._ownerDoc  = ownerDoc || null;
  }
  get namespaceURI() { return this._ns; }
  get prefix()       { return this._prefix; }
  get localName()    { return this._localName; }
  get name()         { return this._prefix ? this._prefix + ':' + this._localName : this._localName; }
  get nodeName()     { return this.name; }
  get specified()    { return true; }
  get ownerElement() { return this._ownerElement; }
  get ownerDocument(){ return this._ownerDoc || globalThis.document; }
  get value() {
    const el = this._ownerElement;
    if (el && this._key != null && Object.prototype.hasOwnProperty.call(el._attrs, this._key)) {
      return el._attrs[this._key];
    }
    return this._value;
  }
  set value(v) {
    const s = String(v);
    const el = this._ownerElement;
    if (el && this._key != null) el._setAttrNodeValue(this._key, s);
    this._value = s;
  }
  get nodeValue()   { return this.value; }
  set nodeValue(v)  { this.value = v; }
  get textContent() { return this.value; }
  set textContent(v){ this.value = v; }
  _cloneShell() { return new Attr(this._localName, this._ns, this._prefix, this.value, this._ownerDoc); }
}
globalThis.Attr = Attr;

// DocumentType node (e.g. `<!DOCTYPE html>`) — a leaf node carrying name /
// publicId / systemId. Created via document.implementation.createDocumentType.
class DocumentType extends Node {
  constructor(name, publicId, systemId, ownerDoc) {
    super();
    this.nodeType = NODE_DOCTYPE;
    this.name     = String(name);
    this.publicId = String(publicId == null ? '' : publicId);
    this.systemId = String(systemId == null ? '' : systemId);
    this._ownerDoc = ownerDoc || null;
  }
  get nodeName()      { return this.name; }
  get textContent()   { return null; }
  set textContent(_)  { /* spec: no-op for DocumentType */ }
  get ownerDocument() { return this._ownerDoc || globalThis.document; }
  _cloneShell()       { return new DocumentType(this.name, this.publicId, this.systemId, this._ownerDoc); }
}
globalThis.DocumentType = DocumentType;

// Per HTML spec, the `href` / `src` IDL attributes return the URL
// resolved against the document base — not the raw attribute value.
const HREF_REFLECTING_TAGS = new Set(['a', 'area', 'link']);
const SRC_REFLECTING_TAGS  = new Set([
  'script', 'img', 'iframe', 'frame', 'embed', 'source', 'audio', 'video', 'track'
]);
// First `<base href>` element. The parser's "in head" insertion mode lifts a
// `<base>` into `<head>`, so scan head's direct children — O(head children),
// document-size-independent (vs. a full-tree DFS on every URL-attribute read).
function firstBaseWithHref(doc) {
  const head = doc.head;
  if (!head || !head._children) return null;
  for (const c of head._children) {
    if (c.nodeType === NODE_ELEMENT && c._tag === 'base' && c._attrs.href != null) return c;
  }
  return null;
}
// HTML "document base URL": the frozen base URL of the first `<base href>`
// element, resolved against the document's fallback base URL (its own URL);
// absent any such `<base>`, the fallback URL itself. Cached per-document and
// invalidated on the next observable DOM change — `settleGen` bumps on
// childList / attribute mutations (so inserting/removing a `<base>` or editing
// its href via setAttribute invalidates), and the `<base>.href` IDL setter
// bumps it explicitly.
function documentBaseURL(doc) {
  const fallback = (doc && typeof doc.URL === 'string' && doc.URL) ||
                   (globalThis.location && globalThis.location.href) || 'about:blank';
  if (!doc || !doc.documentElement) return fallback;
  const gen = currentSettleGen();
  const cache = doc.__baseUrlCache;
  // Key on the fallback URL too: a navigation can swap the document URL without
  // the generation having advanced past the cached value (the live document is
  // reused across visits), and the resolved base depends on that fallback.
  if (cache && cache.gen === gen && cache.fallback === fallback) return cache.href;
  let href = fallback;
  const baseEl = firstBaseWithHref(doc);
  if (baseEl) {
    try {
      const u = globalThis.__csim_parseUrl(baseEl._attrs.href, fallback);
      if (u && !u.error && u.href) href = u.href;
    } catch (_) {}
  }
  doc.__baseUrlCache = { gen, fallback, href };
  return href;
}
function reflectURLAttr(el, name, tagSet) {
  if (!tagSet.has(el._tag)) return el._attrs[name];
  const v = el._attrs[name];
  if (v == null) return '';
  try {
    const base = documentBaseURL(el.ownerDocument);
    const u = globalThis.__csim_parseUrl(v, base);
    return u && !u.error ? u.href : v;
  } catch (_) { return v; }
}

// Mirrors HTML "focusable area" — form controls, anchors/areas with
// href, contenteditable hosts, anything with tabindex, and the few
// other interactive elements browsers consider focusable. Used by
// `Element#focus` to no-op `el.focus()` on non-focusable elements
// (a non-tabindexed `<span>` doesn't take focus in real browsers
// even if a library calls focus on it) and by `__csimClickResolve`'s
// hit-test retarget heuristic.
// Monotonically increasing Y for `getBoundingClientRect` /
// `getClientRects` — assigned the first time an element is
// measured. Reset on document reload via `resetLayoutY`, called
// from `__csimLoadDocument`. Element instances cache their own
// assignment on `_layoutY`.
let __layoutYSeq = 0;
function nextLayoutY() { return __layoutYSeq++; }
export function resetLayoutY() { __layoutYSeq = 0; }

const __FOCUSABLE_TAGS = new Set(['input', 'textarea', 'select', 'button', 'iframe', 'embed', 'object', 'audio', 'video', 'details', 'summary']);
// A text-entry control (textarea, contenteditable, or a text-like <input>) —
// real browsers always render `:focus-visible` on these regardless of whether
// focus arrived by pointer or keyboard. Used by the focus() :focus-visible latch.
const __NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden']);
function __isTextEntryFocusTarget(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  if (el._tag === 'textarea') return true;
  if (isContenteditable(el)) return true;   // canonical CE check (honours true/plaintext-only, ancestors)
  if (el._tag === 'input') return !__NON_TEXT_INPUT_TYPES.has((el._attrs.type || 'text').toLowerCase());
  return false;
}
export function isFocusable(n) {
  if (!n || n.nodeType !== NODE_ELEMENT) return false;
  if (n._attrs.disabled != null) return false;
  // Cheap tag / attribute dispatch first; only walk the ancestor chain
  // for the "would otherwise be focusable" cases.
  let candidate = false;
  if (n._attrs.tabindex != null) candidate = true;
  else {
    const t = n._tag;
    if (__FOCUSABLE_TAGS.has(t)) {
      if (t === 'input' && (n._attrs.type || '').toLowerCase() === 'hidden') return false;
      candidate = true;
    } else if ((t === 'a' || t === 'area') && n._attrs.href != null) {
      candidate = true;
    } else {
      const ce = n._attrs.contenteditable;
      if (ce != null && String(ce).toLowerCase() !== 'false') candidate = true;
    }
  }
  if (!candidate) return false;
  // HTML "focusable area" requires "being rendered". Use
  // `isLaidOutNode` (display:none + `hidden` on self/ancestor) NOT
  // `isVisibleNode` — `visibility:hidden` still reserves layout and
  // takes focus in real Chrome. Without this, a did-insert autofocus
  // on a CSS-hidden replacement input (Discourse `/` shortcut mounts
  // `#icon-search-input` inside `.panel .search-menu { display: none }`)
  // would steal focus from the visible target (`#header-search-input`).
  return isLaidOutNode(n);
}

// The "focus delegate" of a shadow host with delegatesFocus, per HTML
// "get the focus delegate": the AUTOFOCUS delegate — the first focusable shadow-
// tree descendant carrying the `autofocus` attribute, in tree (pre)order — if any,
// else the first focusable descendant. (focus-autofocus.html)
//
// Both passes walk the SHADOW TREE only: slotted light-DOM content is NOT a
// shadow-tree node, so it's naturally excluded — a `<slot>`'s own subtree (its
// fallback content) is walked, but nodes assigned INTO it are not (they live in
// the host's light children). tabindex priority is irrelevant: it's the first
// match in preorder (`isFocusable` counts tabindex=-1 + inherently-focusable and
// excludes a no-tabindex div). A nested shadow host that itself delegatesFocus is
// recursed into ITS OWN shadow tree (not its light children); in the fallback pass
// its already-focused descendant wins. A nested host that does NOT delegate is
// descended as an ordinary element — its node-tree children are walked, but its
// SHADOW content stays unreachable via delegation.
function firstFocusDelegate(root) {
  return focusDelegateScan(root, true) || focusDelegateScan(root, false);
}
function focusDelegateScan(root, autofocusOnly) {
  const kids = root && root._children;
  if (!kids) return null;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType !== NODE_ELEMENT) continue;
    if (isFocusable(n) && (!autofocusOnly || n._attrs.autofocus != null)) return n;
    if (n._shadowRoot && n._shadowRoot._delegatesFocus) {
      const nested = autofocusOnly
        ? focusDelegateScan(n._shadowRoot, true)
        : (n._shadowRoot.activeElement || focusDelegateScan(n._shadowRoot, false));
      if (nested) return nested;
      continue;
    }
    const d = focusDelegateScan(n, autofocusOnly);
    if (d) return d;
  }
  return null;
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
    // Namespace slots. createElement() leaves these at the HTML defaults;
    // createElementNS() overrides them. `_localName` is case-preserving (vs
    // the always-lowercased `_tag` that the matcher / cascade use).
    this._ns        = HTML_NS;
    this._prefix    = null;
    this._localName = this._tag;
    // Pre-init the lazily-added per-element hot-read caches/memos so EVERY element
    // shares ONE V8 hidden class — the per-element readers in find / visible_text /
    // cascade then hit monomorphic property ICs instead of megamorphic ones
    // (measured: late-added fields tipped ~400 els into a 2nd shape past V8's
    // 4-shape IC threshold). Keep this list in sync with the fields written below.
    this._classesCache = null; this._classesCacheKey = null;   // walk.js classes()
    this._isKey = null; this._isCache = null;                  // inline-style parse cache (cascade.js)
    this._declKey = null; this._declCache = null;              // inline-style decl read cache (style-proxy.js)
    this._vt = ''; this._vtGen = -1; this._vtCV = -1;          // __csimVisibleText memo (bridge.entry.js)
    this._attrsColl = null;                                    // live NamedNodeMap cache (get attributes)
    // A `<form>` gets the shared FormNamedProto in its prototype chain so
    // `form.<control-name>` resolves a descendant control. All forms share
    // this one prototype → one hidden class → the cascade/find hot path
    // stays fast (see FormNamedProto). The form itself stays a plain object,
    // so `el.form === document.querySelector('form')` holds.
    if (this._tag === 'form') Object.setPrototypeOf(this, FormNamedProto);
  }
  _cloneShell() {
    const e = new Element(this._tag);
    e._attrs     = Object.assign({}, this._attrs);
    if (this._attrNS) e._attrNS = Object.assign({}, this._attrNS);
    e._ns        = this._ns;
    e._prefix    = this._prefix;
    e._localName = this._localName;
    // A cloned <script> inherits the original's "already started" flag (HTML
    // "the cloning steps for script elements"). So a clone of a script that has
    // already run does NOT execute again when inserted. Without this, deep-
    // cloning a subtree that contains an already-run inline <script> and
    // inserting the clone re-runs it — and when that script is the page's own
    // code (`new Document().appendChild(documentElement.cloneNode(true))`), it
    // re-runs unboundedly (stack overflow → OOM).
    if (this._tag === 'script' && this._csimRan) e._csimRan = true;
    return e;
  }
  // tagName / nodeName: the qualified name, ASCII-uppercased only for an
  // HTML-namespace element whose node document is an HTML document (so an
  // element in an XML/XHTML iframe document keeps its case).
  get tagName() {
    const qn = this._prefix ? this._prefix + ':' + this._localName : this._localName;
    return (this._ns === HTML_NS && isHtmlDocument(this.ownerDocument)) ? asciiUpper(qn) : qn;
  }
  get nodeName()   { return this.tagName; }
  get localName()  { return this._localName; }
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
  // Declarative Shadow DOM reflection on `<template>` (HTMLTemplateElement).
  // `shadowRootMode` is a limited-to-known-values enumerated attribute: only
  // "open"/"closed" (ASCII case-insensitive) are valid, anything else (incl.
  // absent) reflects as "". The other three are boolean attributes. These let
  // feature detection (`'shadowRootMode' in HTMLTemplateElement.prototype`)
  // and the parser's declarative-shadow conversion read the authored intent.
  get shadowRootMode() {
    if (this._tag !== 'template') return undefined;
    const v = this._attrs.shadowrootmode;
    if (v == null) return '';
    const lc = asciiLower(String(v));
    return (lc === 'open' || lc === 'closed') ? lc : '';
  }
  set shadowRootMode(v) {
    if (this._tag !== 'template') return;
    this.setAttribute('shadowrootmode', String(v == null ? '' : v));
  }
  get shadowRootDelegatesFocus() { return this._tag === 'template' && this._attrs.shadowrootdelegatesfocus != null; }
  set shadowRootDelegatesFocus(v) {
    if (this._tag !== 'template') return;
    if (v) this.setAttribute('shadowrootdelegatesfocus', ''); else this.removeAttribute('shadowrootdelegatesfocus');
  }
  get shadowRootClonable() { return this._tag === 'template' && this._attrs.shadowrootclonable != null; }
  set shadowRootClonable(v) {
    if (this._tag !== 'template') return;
    if (v) this.setAttribute('shadowrootclonable', ''); else this.removeAttribute('shadowrootclonable');
  }
  get shadowRootSerializable() { return this._tag === 'template' && this._attrs.shadowrootserializable != null; }
  set shadowRootSerializable(v) {
    if (this._tag !== 'template') return;
    if (v) this.setAttribute('shadowrootserializable', ''); else this.removeAttribute('shadowrootserializable');
  }
  // Enumerated reflection: "manual" maps to manual, everything else (incl.
  // missing / invalid) to the "named" default.
  get shadowRootSlotAssignment() {
    if (this._tag !== 'template') return undefined;
    const v = this._attrs.shadowrootslotassignment;
    return (v != null && asciiLower(String(v)) === 'manual') ? 'manual' : 'named';
  }
  set shadowRootSlotAssignment(v) {
    if (this._tag !== 'template') return;
    this.setAttribute('shadowrootslotassignment', String(v == null ? '' : v));
  }
  // `HTMLStyleElement.sheet` — the CSSStyleSheet associated with a connected
  // `<style>` (CSSOM). It exists once the element is in a document and reflects
  // the element's current text content, so an earlier-inserted script can
  // observe a later-inserted `<style>` already applied (cssRules track the text
  // live). Disconnected → null; `<link>` sheets (which need the fetched
  // resource) are not modelled here. Created lazily and cached for stable identity.
  get sheet() {
    if (this._tag === 'style') {
      if (!this.isConnected) { this._sheet = null; return null; }
      const type = (this._attrs.type || '').toLowerCase();
      if (type && type !== 'text/css') { this._sheet = null; return null; }
      if (!this._sheet) {
        this._sheet = new globalThis.CSSStyleSheet();
        this._sheet.ownerNode = this;
      }
      this._sheet.replaceSync(this.textContent || '');   // re-sync rules from the current text
      return this._sheet;
    }
    if (this._tag === 'link') {
      // A connected `<link rel=stylesheet>` exposes its loaded CSSStyleSheet.
      // Our resource fetch is synchronous, so the sheet is available as soon as
      // the link is connected (an earlier script observes it). The CSS is
      // external/static, so create + populate cssRules once.
      const rel  = (this._attrs.rel || '').toLowerCase().split(/\s+/);
      const href = this._attrs.href;
      if (!this.isConnected || !rel.includes('stylesheet') || !href) { this._sheet = null; return null; }
      if (!this._sheet) {
        this._sheet = new globalThis.CSSStyleSheet();
        this._sheet.ownerNode = this;
        this._sheet.href = href;
        let css = '';
        const dataCss = /^data:text\/css[^,]*,(.*)$/is.exec(href);   // `data:text/css,<css>`
        if (dataCss) { try { css = decodeURIComponent(dataCss[1]); } catch (_) { css = dataCss[1]; } }
        else { try { css = globalThis.__csimExternalAsset(href) || ''; } catch (_) {} }
        this._sheet.replaceSync(css);
      }
      return this._sheet;
    }
    return undefined;
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
    this._modal = false;   // show() is explicitly non-modal; drop any stale modal flag
    this.setAttribute('open', '');
  }
  showModal() {
    if (this._tag !== 'dialog') return;
    this.setAttribute('open', '');
    // Modal-ness is internal state (`:modal`), distinct from the `open`
    // content attribute that show() also sets. An atomic move (moveBefore)
    // preserves it because the same element object is relocated.
    this._modal = true;
  }
  close(returnValue) {
    if (this._tag !== 'dialog') return;
    this._modal = false;
    closeDialog(this, returnValue);
  }
  // `<iframe>` / `<frame>` nested browsing context — a same-realm nested
  // Document parsed from srcdoc / src (lazily, via the bridge frame loader).
  // contentWindow.DOMException etc. resolve to the shared globals, so
  // `instanceof` across the frame boundary works. Non-frame tags get null.
  get contentWindow() {
    if (this._tag !== 'iframe' && this._tag !== 'frame') return null;
    // A frame has no browsing context (contentWindow null) when it isn't
    // connected, or while a connect walk is in progress and the frame's OWN
    // post-insertion step (connectOneElement, which sets `_browsingContextReady`
    // in tree order) hasn't run yet. So a `<script>` inserted atomically BEFORE
    // an `<iframe>` in the same appendChild (div / DocumentFragment / append()
    // multi-arg) runs mid-walk and sees null, while a script AFTER it sees the
    // live window. OUTSIDE any connect walk a connected frame is always ready —
    // direct-splice inserts (innerHTML / DSD), which run no sibling scripts and
    // bypass the connect walk, are unaffected.
    // (dom/nodes/insertion-removing-steps/Node-appendChild-script-and-iframe.html)
    if (!isConnected(this)) return null;
    if (globalThis.__csimConnectWalkDepth > 0 && !this._browsingContextReady) return null;
    return globalThis.__csimFrameWindow ? globalThis.__csimFrameWindow(this) : null;
  }
  get contentDocument() {
    const w = this.contentWindow;
    return w ? w.document : null;
  }
  // Report the XHTML namespace per HTML spec. The XPath engine scopes
  // unprefixed element name tests to the XHTML namespace in HTML
  // documents, so reporting it explicitly keeps `//*` and `//div`
  // queries working. Also required for DOMPurify's `_checkValidNamespace`
  // to keep elements (Trix's HTMLSanitizer wipes the body
  // without it).
  get prefix()       { return this._prefix; }
  get namespaceURI() { return this._ns; }
  get ownerDocument(){ return this._ownerDoc || globalThis.document; }
  getAttribute(name) {
    const v = this._attrs[attrKey(this, name)];
    if (v != null) return v;                       // common case: key === qualified name
    // Collision fallback (gated): a same-qualified-name attribute in a namespace
    // may live under a synthetic key. Only runs once a namespaced attr exists.
    if (this._attrNS) { const k = firstAttrKeyByQName(this, name); if (k != null) return this._attrs[k]; }
    return null;
  }
  setAttribute(name, value) {
    const qn = String(name);
    if (!isValidAttributeLocalName(qn)) {
      throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
    }
    let n = attrKey(this, qn);
    // setAttribute targets the FIRST attribute with this qualified name; if that
    // is a namespaced attr parked under a synthetic collision key (no bare-key
    // entry), update IT (value only — the namespace is preserved) rather than
    // appending a duplicate. Gated on _attrNS, so an HTML element with no
    // namespaced attribute pays only one hasOwnProperty miss.
    if (this._attrNS && !Object.prototype.hasOwnProperty.call(this._attrs, n)) {
      n = firstAttrKeyByQName(this, qn) || n;
    }
    const old = this._attrs[n];
    const next = String(value);
    this._attrs[n] = next;
    // A name/id becomes a named-property — register the getters (the form's
    // FormNamedProto and the global WindowNamedProps; no-op for already-seen
    // names or non-applicable tags; see registerNamedAccess).
    if ((n === 'id' || n === 'name') && next) registerNamedAccess(this, n, next);
    // HTML nonce attribute-change steps: setting the content attribute syncs the
    // internal slot the IDL getter reads (see the `nonce` accessor + the
    // connection-time hiding in fireCEConnect). Keeps `.nonce` correct after an
    // explicit `setAttribute('nonce', '')` once the value has been hidden.
    if (n === 'nonce') this._nonce = next;
    // HTML `selected` content-attribute change steps: adding the
    // attribute, when the option's selectedness is not dirty (never set
    // via the IDL setter / a user pick), sets selectedness to true. The
    // content attribute is `defaultSelected`; selectedness is the live
    // `.selected`. `_selInit` records that the connect-walk default has
    // been applied, so a programmatic `setAttribute('selected')` takes
    // effect immediately rather than waiting for the next connect.
    if (n === 'selected' && this._tag === 'option') {
      this._selInit = true;
      if (this._dirtySel !== true) { this._selectedness = true; askForReset(this); }
    }
    // setAttribute matches an existing attribute by qualified name and updates
    // only its value — it must NOT clear the namespace/prefix of an attribute
    // previously set via setAttributeNS. (A brand-new attribute has no _attrNS
    // entry, so there's nothing to clear.)
    // A frame's src/srcdoc change reloads its nested document — drop the cached
    // contentWindow so the next access re-parses (matches real-browser reload).
    if ((n === 'src' || n === 'srcdoc') && (this._tag === 'iframe' || this._tag === 'frame') && old !== next) {
      const oldRealmId = this._frameRealmId;
      this._frameWindow = null;
      this._frameRealmId = null;   // re-navigation rebuilds the realm
      // Tear down the superseded realm so it doesn't linger and get re-drained.
      if (oldRealmId != null) {
        if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(oldRealmId);
        if (globalThis.__csim_disposeFrameRealm) globalThis.__csim_disposeFrameRealm(oldRealmId);
      }
      // Re-navigation fires `load` again — clear the once-guard so the next
      // connect re-fires (a mere move, with src unchanged, must NOT re-fire).
      this._frameLoadFired = false;
      // An already-connected frame won't re-run the connect path, so re-fire
      // the nested document's `load` directly (the new content loads lazily on
      // next access). Disconnected frames fire on their eventual connect.
      if (isConnected(this) && globalThis.__csim_onFrameSrcAssigned) globalThis.__csim_onFrameSrcAssigned(this);
    }
    // A window-reflected handler content attribute (`onblur="…"`) on body/frameset
    // activates the Window's handler, compiling the source.
    if (this._tag === 'body' || this._tag === 'frameset') {
      const evt = windowForwardedHandlerName(n);
      if (evt) activateWindowForwardedHandler(evt, next);
    }
    recordAttrMutation(this, n, old == null ? null : old);
    if (old !== next) fireAttrChangedCallback(this, n, old == null ? null : old, next);
  }
  // Namespaced attributes: validate-and-extract the (namespace, prefix,
  // localName), key the flat store on the qualified name, and remember the
  // namespace metadata in `_attrNS` (sparse — only namespaced/prefixed attrs).
  // getAttributeNS / hasAttributeNS / removeAttributeNS match on
  // (namespace, localName), case-sensitively, per spec.
  setAttributeNS(namespace, qualifiedName, value) {
    const ns = namespace == null ? null : String(namespace);
    const { namespace: rns, prefix, localName } = validateAndExtract(ns, String(qualifiedName), 'attribute');
    const qn  = prefix ? prefix + ':' + localName : localName;
    // Replace an existing (ns, localName); otherwise a fresh key — the qualified
    // name when free, else a synthetic collision key so a same-qualified-name
    // attribute in a different namespace coexists instead of overwriting.
    const existing = this._attrKeyByNS(rns, localName);
    const key = existing != null ? existing : freshAttrKey(this, qn);
    const old = this._attrs[key];
    const next = String(value);
    this._attrs[key] = next;
    // A null-namespace name/id set via setAttributeNS still feeds form named
    // access (registerFormName mirrors the setAttribute hook; namespaced
    // name/id attributes are not form named-properties).
    if (rns === null && (localName === 'id' || localName === 'name') && next) registerNamedAccess(this, localName, next);
    // Record metadata when there's a namespace/prefix, OR when the key is a
    // synthetic collision key (key !== qn) — a null-namespace attribute parked
    // under a synthetic key still needs _attrNS so attrQName / _attrKeyByNS can
    // recover its qualified name and (null) namespace.
    if (rns !== null || prefix !== null || key !== qn) {
      (this._attrNS || (this._attrNS = {}))[key] = { ns: rns, prefix, localName };
    } else if (this._attrNS) {
      delete this._attrNS[key];
    }
    recordAttrMutation(this, key, old == null ? null : old);
    if (old !== next) fireAttrChangedCallback(this, key, old == null ? null : old, next);
  }
  // The stored key of the attribute matching (namespace, localName), or null.
  _attrKeyByNS(ns, localName) {
    const wantNs = ns === '' ? null : ns;
    // Fast path: with no namespaced attributes, an attribute matches only when
    // the wanted namespace is null and the localName is a plain store key.
    if (!this._attrNS) {
      return (wantNs === null && Object.prototype.hasOwnProperty.call(this._attrs, localName)) ? localName : null;
    }
    for (const key in this._attrs) {
      const meta = this._attrNS && this._attrNS[key];
      const aNs  = meta ? meta.ns : null;
      const aLn  = meta ? meta.localName : key;
      if (aNs === wantNs && aLn === localName) return key;
    }
    return null;
  }
  getAttributeNS(namespace, localName) {
    const key = this._attrKeyByNS(namespace == null ? null : String(namespace), String(localName));
    return key == null ? null : this._attrs[key];
  }
  hasAttributeNS(namespace, localName) {
    return this._attrKeyByNS(namespace == null ? null : String(namespace), String(localName)) != null;
  }
  removeAttributeNS(namespace, localName) {
    const key = this._attrKeyByNS(namespace == null ? null : String(namespace), String(localName));
    if (key != null) this._removeAttrKey(key);
  }
  removeAttribute(name) {
    const key = attrKey(this, name);
    if (Object.prototype.hasOwnProperty.call(this._attrs, key)) { this._removeAttrKey(key); return; }
    // Remove the first attribute with this qualified name irrespective of
    // namespace (a synthetic-keyed collision attr); gated on a namespaced attr.
    if (this._attrNS) { const k = firstAttrKeyByQName(this, name); if (k != null) this._removeAttrKey(k); }
  }
  // Stable, live Attr node for the attribute stored under `key`. Cached on
  // the element so `getAttributeNode` returns the same identity each call.
  _attrNodeFor(key) {
    const cache = this._attrNodes || (this._attrNodes = {});
    let a = cache[key];
    if (!a) {
      const meta = this._attrNS && this._attrNS[key];
      a = new Attr(meta ? meta.localName : key, meta ? meta.ns : null,
                   meta ? meta.prefix : null, this._attrs[key], this.ownerDocument);
      a._ownerElement = this;
      a._key = key;
      cache[key] = a;
    }
    return a;
  }
  // Low-level store write used by a bound Attr's `value` setter (keeps the
  // mutation-record / attributeChangedCallback side effects of setAttribute).
  _setAttrNodeValue(key, value) {
    const old = this._attrs[key];
    this._attrs[key] = value;
    if ((key === 'id' || key === 'name') && value) registerNamedAccess(this, key, value);   // Attr#value mutation feeds named access
    // Setting an attribute value always queues a mutation record, even when the
    // value is unchanged (DOM "set an existing attribute value" has no equality
    // guard) — mirrors setAttribute. The CE attributeChangedCallback stays gated
    // on an actual change, matching setAttribute's behaviour.
    recordAttrMutation(this, key, old == null ? null : old);
    if (old !== value) fireAttrChangedCallback(this, key, old == null ? null : old, value);
  }
  // Detach the cached Attr node (if any) at `key`: snapshot its value and
  // sever the owner link so a held reference reads its last value and a null
  // owner, per the DOM "remove an attribute" steps.
  _detachAttrNode(key) {
    const a = this._attrNodes && this._attrNodes[key];
    if (!a) return;
    a._value = this._attrs[key];
    a._ownerElement = null;
    a._key = null;
    delete this._attrNodes[key];
  }
  // Bind a detached Attr into this element's store (setAttributeNode).
  _bindAttrNode(attr) {
    const hasNs = attr._ns != null || attr._prefix != null;
    const qn = attr.name;
    // Same collision-safe keying as setAttributeNS: replace a matching (ns,
    // localName), else a fresh (possibly synthetic) key. Non-namespaced attrs
    // key by their lowercased name (HTML, never collide — same name = same attr).
    const key = hasNs ? (this._attrKeyByNS(attr._ns, attr._localName) || freshAttrKey(this, qn)) : asciiLower(qn);
    const old = this._attrs[key];
    this._attrs[key] = attr._value;
    if (!hasNs && (key === 'id' || key === 'name') && attr._value) registerNamedAccess(this, key, attr._value);   // setAttributeNode feeds named access
    if (hasNs) (this._attrNS || (this._attrNS = {}))[key] = { ns: attr._ns, prefix: attr._prefix, localName: attr._localName };
    else if (this._attrNS) delete this._attrNS[key];
    attr._ownerElement = this;
    attr._key = key;
    (this._attrNodes || (this._attrNodes = {}))[key] = attr;
    recordAttrMutation(this, key, old == null ? null : old);
    if (old !== attr._value) fireAttrChangedCallback(this, key, old == null ? null : old, attr._value);
  }
  // Remove the attribute stored under the exact key `n` (no re-keying).
  _removeAttrKey(n) {
    if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
    const old = this._attrs[n];
    // Capture the namespaced metadata before it's deleted below — the removal
    // MutationRecord needs the attribute's localName + namespace (recordAttrMutation
    // would otherwise look up the already-deleted _attrNS[n] and lose them).
    const meta = (this._attrNS && this._attrNS[n]) || null;
    this._detachAttrNode(n);
    delete this._attrs[n];
    if (this._attrNS) delete this._attrNS[n];
    // Removing the nonce content attribute clears the internal slot (HTML nonce
    // attribute-change steps), so a hidden value isn't resurrected by the getter.
    if (n === 'nonce') this._nonce = '';
    // HTML `selected` content-attribute removal step: when selectedness is
    // not dirty, removing the attribute clears selectedness (then the
    // owning select re-runs its algorithm to restore a default).
    if (n === 'selected' && this._tag === 'option' && this._dirtySel !== true) {
      this._selectedness = false;
      askForReset(this);
    }
    // Removing a frame's src/srcdoc reloads it — drop the cached contentWindow
    // (mirrors the same invalidation in setAttribute).
    if ((n === 'src' || n === 'srcdoc') && (this._tag === 'iframe' || this._tag === 'frame')) {
      const oldRealmId = this._frameRealmId;
      this._frameWindow = null;
      this._frameRealmId = null;   // re-navigation rebuilds the realm
      if (oldRealmId != null) {
        if (globalThis.__csimChildRealmIds) globalThis.__csimChildRealmIds.delete(oldRealmId);
        if (globalThis.__csim_disposeFrameRealm) globalThis.__csim_disposeFrameRealm(oldRealmId);
      }
    }
    if (this._tag === 'body' || this._tag === 'frameset') {
      const evt = windowForwardedHandlerName(n);
      if (evt) activateWindowForwardedHandler(evt, null);
    }
    recordAttrMutation(this, n, old == null ? null : old, meta);
    fireAttrChangedCallback(this, n, old == null ? null : old, null);
  }
  hasAttribute(name) {
    if (Object.prototype.hasOwnProperty.call(this._attrs, attrKey(this, name))) return true;
    return this._attrNS ? firstAttrKeyByQName(this, name) != null : false;
  }
  // `Element.toggleAttribute(name, force?)` per DOM spec. Without
  // `force`, flips the attribute (present → absent, absent →
  // present-with-empty-value); with `force`, asserts the state.
  // Returns the resulting presence as a boolean. Trix's
  // `makeEditable(element)` calls `element.toggleAttribute(
  // "contenteditable", !element.disabled)` and throws if the
  // method is missing — connectedCallback aborts before the
  // EditorController is wired up.
  toggleAttribute(name, force) {
    const qn = String(name);
    if (!isValidAttributeLocalName(qn)) {
      throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
    }
    name = qn;
    const has = this.hasAttribute(name);
    const next = arguments.length > 1 ? !!force : !has;
    if (next === has) return next;
    if (next) this.setAttribute(name, '');
    else      this.removeAttribute(name);
    return next;
  }
  // Qualified names in attribute order. Maps collision-keyed synthetic keys back
  // to their qualified name (no-op for the common case where key === name).
  getAttributeNames() {
    const keys = Object.keys(this._attrs);
    return this._attrNS ? keys.map(k => attrQName(this, k)) : keys;
  }
  // `attributes` returns a live-platform-object NamedNodeMap (a fresh snapshot
  // per access): indexed entries + supported named properties, with `length` /
  // `item` / `getNamedItem` on the prototype. Each entry is an Attr carrying the
  // fields consumers touch (`name`, `value`, `namespaceURI`, `prefix`,
  // `localName`, `ownerElement`). The XPath engine reads attributes straight
  // from the store, not through this collection.
  get attributes() {
    // A LIVE NamedNodeMap, cached per element (`el.attributes === el.attributes`)
    // and re-querying the attribute list per settle generation. dropUppercase
    // applies the spec "supported property names" filter for an HTML-namespace
    // element in an HTML document (named access omits uppercase-bearing names;
    // indexed access + getNamedItem still reach every attribute).
    if (this._attrsColl) return this._attrsColl;
    const dropUppercase = this._ns === HTML_NS && isHtmlDocument(this.ownerDocument);
    return this._attrsColl = liveNamedNodeMap(this, dropUppercase);
  }
  getAttributeNode(name) {
    const n = attrKey(this, name);
    return Object.prototype.hasOwnProperty.call(this._attrs, n) ? makeAttr(this, n) : null;
  }
  // HTMLCollection-shaped getters framework code expects.
  // Spec says these return *descendants* of the element (not self).
  // https://dom.spec.whatwg.org/#concept-getelementsbytagname — match on the
  // element's qualified name (prefix:localName), not the uppercased tagName. In
  // an HTML document the comparison is ASCII case-insensitive for HTML-namespace
  // elements and case-sensitive otherwise; in an XML/XHTML document it is always
  // case-sensitive. We refine querySelectorAll('*') (the iterative CSS walk — no
  // recursion, so it's deep-DOM safe, unlike a recursive walk). Note this does
  // materialise all descendants; a tag-specific CSS query can't substitute here
  // because it would over-match foreign-namespace elements by lowercased tag.
  getElementsByTagName(tag) {
    // LIVE collection — recomputed (per settle generation) so DOM changes are
    // reflected through the held reference. The HTML-ness (whether to ASCII-
    // lowercase the search for HTML-namespaced elements) is bound HERE, at
    // creation, per spec: the list keeps lowercasing-for-HTML even after the
    // root is moved into a non-HTML (XML) document; a fresh call re-evaluates.
    const htmlDoc = isHtmlDocument(this.ownerDocument);
    return liveHTMLCollection(() => collectByTagName(this, tag, htmlDoc));
  }
  getElementsByClassName(cls) { return liveHTMLCollection(() => collectByClassName(this, cls)); }
  getElementsByName(name) {
    // Spec: getElementsByName returns a LIVE collection in tree order. Back it
    // with liveHTMLCollection (re-walked when a DOM mutation bumps the settle
    // generation, memoised otherwise) so a later move/insert/remove — e.g.
    // moveBefore relocating a match into a shadow tree, which querySelectorAll
    // doesn't descend, or reordering two matches — is reflected, instead of the
    // old fixed snapshot. (dom/nodes/moveBefore/moveBefore-name-map.html)
    const sel = '[name="' + String(name).replace(/"/g, '\\"') + '"]';
    return liveHTMLCollection(() => this.querySelectorAll(sel).filter(n => n !== this));
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
  // HTML spec IDL: true iff the element is editable (own
  // `contenteditable` is "" / "true" / "plaintext-only", OR an
  // ancestor enables it without an intervening "false"). Mousetrap's
  // default `stopCallback` checks this to skip keyboard shortcuts
  // while typing in a contenteditable — without the getter, plain
  // letters typed into a PM/Tiptap editor route through Discourse's
  // window-level `c`-to-compose / etc. shortcuts and surprise the
  // user with modals.
  get isContentEditable() { return isContenteditable(this); }
  // HTML spec: `el.hidden` reflects the `hidden` content attribute as
  // a boolean. Stimulus controllers commonly do `el.hidden = true`
  // instead of `el.setAttribute('hidden', '')`; without the setter
  // those toggles silently lose the attribute.
  get hidden()    { return this._attrs.hidden != null; }
  set hidden(v)   { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  // HTML spec: `<details>` and `<dialog>` expose `open` as a boolean
  // IDL attribute reflecting the content attribute. Discourse's
  // select-kit `_handleNativeToggle` reads `element.open` to decide
  // open vs close; without this getter the read is `undefined`,
  // its open/close branches mis-fire and the dropdown stays empty.
  get open()      { return this._attrs.open != null; }
  set open(v)     { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
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
  // [SameObject, PutForwards=value] — return one cached DOMTokenList per
  // element (identity is observable: `e.classList === e.classList`), and
  // assigning to `.classList` forwards to its `.value`. Writes round-trip
  // through setAttribute('class', …) so MutationObserver + cascade + CE
  // `attributeChangedCallback` all see the change (e.g. the
  // IntersectionObserver recheck that reveals lazy turbo-frames on
  // `classList.remove('hidden')`).
  get classList() {
    return tokenListFor(this, 'class');
  }
  set classList(v) { this.classList.value = v; }
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
  querySelector(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelector': 1 argument required, but only 0 present.");
    return selectFirst(this._children, sel, this);
  }
  querySelectorAll(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelectorAll': 1 argument required, but only 0 present.");
    return nodeList(selectAll(this._children, sel, this));
  }
  matches(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'matches': 1 argument required, but only 0 present.");
    return matchesSelector(this, sel);
  }
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
    // selectAll (plain Array), not the public querySelectorAll (NodeList): the
    // options collection is an HTMLOptionsCollection, not a NodeList.
    const arr = selectAll(this._children, 'option', this);
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
    // The form node is already its own named-properties object (it carries
    // FormNamedProto), so return it directly — `el.form === form` holds and
    // `el.form.<control-name>` resolves through the shared prototype.
    return formForControl(this) || null;
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
        for (const o of opts) if (o._selectedness === true) {
          out.push(o._attrs.value != null ? o._attrs.value : o.textContent);
        }
        return out;
      }
      let implicit = null;
      for (const o of opts) {
        if (o._attrs.disabled != null) continue;
        if (o._selectedness === true) return o._attrs.value != null ? o._attrs.value : o.textContent;
        if (implicit == null) implicit = o._attrs.value != null ? o._attrs.value : o.textContent;
      }
      return implicit == null ? '' : implicit;
    }
    if (this._tag === 'textarea') {
      // HTML spec: `<textarea>.value` returns the "raw value" = the element's
      // child text content. The "first newline removal" rule (dropping one
      // leading line terminator) is a PARSE-time operation, so the DOM text node
      // already lacks it — both the main-document parser (parse5) and the
      // fragment parser (`stripFirstNewline`) strip it at build time. Reading
      // textContent verbatim here is therefore correct; re-stripping would
      // double-strip a parsed textarea (`\n\nx` → `x` instead of `\nx`). After a
      // `set` / direct assignment, `_attrs.value` carries the new raw value, so
      // prefer that. Avo's KeyValueField stores a JSON blob in a hidden
      // `<textarea>` and parses it on Stimulus connect — its value has no leading
      // newline, so textContent is exactly the stored blob.
      if (this._attrs.value != null) return this._attrs.value;
      return this.textContent;
    }
    return this._attrs.value != null ? this._attrs.value : '';
  }
  set value(v)   {
    if (this._tag === 'select') {
      const target = String(v == null ? '' : v);
      const opts = this.querySelectorAll('option');
      // HTML: setting `select.value` sets the selectedness of the first
      // option whose value matches and clears every other, mirroring a
      // user pick rather than touching the `selected` content attribute.
      let matched = false;
      for (const o of opts) {
        ensureOptionSelInit(o);
        const ov = o._attrs.value != null ? o._attrs.value : o.textContent;
        if (!matched && ov === target) { matched = true; o._selectedness = true; o._dirtySel = true; }
        else o._selectedness = false;
      }
      // No match ⇒ run the algorithm so the single-select implicit default
      // is materialised, keeping `value` / `selectedOptions` / `:selected`
      // mutually consistent (multiple-selects legitimately end up empty).
      if (!matched) runSelectednessAlgorithm(this, null);
      bumpSettleGen();   // selectedness changed: invalidate :checked/:selected memos + settle key
      return;
    }
    // HTML dirty-value flag: snapshot the parsed default once before the
    // first IDL write so `<form>.reset()` can restore it (see reset()).
    if (this._defaultValue === undefined) {
      this._defaultValue = (this._tag === 'textarea') ? this.textContent : (this._attrs.value || '');
    }
    this._attrs.value = String(v == null ? '' : v);
  }
  // `<option>.selected` IDL — reads/writes the internal *selectedness*
  // (`_selectedness`), NOT the `selected` content attribute (that is
  // `defaultSelected`). jQuery's `.val()` over a `<select>` walks the
  // options checking each `.selected`; Redmine's onchange handlers
  // probe selection after manual `select` calls.
  get selected() {
    if (this._tag !== 'option') return false;
    // Lazy-init so a parsed `<option selected>` read before it is ever
    // connected to a select (DOMParser / detached fragment) still reports
    // its authored default, matching real browsers. O(1) after first read.
    ensureOptionSelInit(this);
    return this._selectedness === true;
  }
  set selected(v) {
    if (this._tag !== 'option') return;
    const next = !!v;
    const changed = (this._selectedness === true) !== next;
    // IDL setter sets the dirtiness flag so later content-attribute
    // changes no longer drive selectedness (HTML spec).
    this._dirtySel = true;
    this._selectedness = next;
    // Setting `selected = true` on an option in a single-select clears
    // selectedness from the others; setting false can drop the select
    // to zero selected, so re-run the algorithm (picks a new default).
    // Redmine's `selectTracker` sets `prop('selected', true)` and
    // expects the previously-selected option to lose `.value`.
    askForReset(this);
    // Selectedness drives `:checked`/`:selected`/visible_text; bump the
    // settle generation those memos + settle key on (see `set checked`).
    if (changed) bumpSettleGen();
  }
  // `<option>.defaultSelected` IDL — reflects the `selected` content
  // attribute (the authored default, restored by `<form>.reset()`).
  get defaultSelected() {
    if (this._tag !== 'option') return false;
    return this._attrs.selected != null;
  }
  set defaultSelected(v) {
    if (this._tag !== 'option') return;
    if (v) this.setAttribute('selected', ''); else this.removeAttribute('selected');
  }
  // `<select>.selectedIndex` — index of the first selected option,
  // or 0 (the default) when no option is explicitly selected.
  get selectedIndex() {
    if (this._tag !== 'select') return -1;
    const opts = this.querySelectorAll('option');
    for (let i = 0; i < opts.length; i++) {
      if (opts[i]._selectedness === true) return i;
    }
    return opts.length > 0 ? 0 : -1;
  }
  set selectedIndex(v) {
    if (this._tag !== 'select') return;
    const idx = Number(v);
    const opts = this.querySelectorAll('option');
    // HTML: clear every option's selectedness, then select the one at the
    // given index (a dirty user-style pick). Mark `_selInit` so a later
    // ensureOptionSelInit can't re-derive the cleared state from the
    // content attribute.
    let matched = false;
    for (let i = 0; i < opts.length; i++) {
      opts[i]._selInit = true;
      if (i === idx) { opts[i]._selectedness = true; opts[i]._dirtySel = true; matched = true; }
      else opts[i]._selectedness = false;
    }
    // Out-of-range index ⇒ run the algorithm so a single-select restores
    // its implicit default (keeps the getter / value / :selected aligned).
    if (!matched) runSelectednessAlgorithm(this, null);
    bumpSettleGen();
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
    return selectAll(this._children, 'option', this).filter(o => o._selectedness === true);
  }
  // Rails-UJS reads `element.href` to get an AJAX target; the raw
  // attribute would resolve against `location.href` (= current page)
  // and re-fetch the current page on every remote-link click.
  get href() { return reflectURLAttr(this, 'href', HREF_REFLECTING_TAGS); }
  set href(v) {
    const next = String(v == null ? '' : v);
    const old = this._attrs.href;
    this._attrs.href = next;
    // Reassigning a connected `<link>`'s href must re-fetch and
    // dispatch load — real browsers swap the sheet in place;
    // without this, dependent computed styles stay stale.
    if (this._tag === 'link' && old !== next && globalThis.__csim_onLinkHrefAssigned) {
      globalThis.__csim_onLinkHrefAssigned(this);
    }
    // `<base>.href` changes the document base URL — an observable change the
    // per-document base cache (and any settle-gen-keyed memo) keys on. The
    // IDL setter bypasses setAttribute, so bump the generation explicitly.
    if (this._tag === 'base' && old !== next) bumpSettleGen();
  }
  // Bundlers read `document.currentScript.src` at top level to derive
  // their public-path origin; an unresolved `/assets/…` crashes
  // auto-detection ("Automatic publicPath is not supported in this
  // browser").
  get src()  { return reflectURLAttr(this, 'src',  SRC_REFLECTING_TAGS); }
  set src(v) {
    const next = String(v == null ? '' : v);
    // `iframe.src = …` reflects to the content attribute exactly like
    // setAttribute, so route frames through it — that path clears the cached
    // contentWindow / realm and re-fires `load` on re-navigation (an
    // onload-then-navigate chain depends on the second `load`).
    if (this._tag === 'iframe' || this._tag === 'frame') { this.setAttribute('src', next); return; }
    this._attrs.src = next;
    if (this._tag === 'video' && globalThis.__csim_onVideoSrcAssigned) {
      globalThis.__csim_onVideoSrcAssigned(this, next);
    }
  }
  // `iframe.srcdoc` reflects the `srcdoc` content attribute — a DOMString of
  // HTML, NOT a URL. Route the setter through setAttribute so the frame-reload
  // path (clears the cached realm + re-fires `load`) runs: `iframe.srcdoc = html`
  // must load that HTML into the nested document, exactly as the `src` setter
  // does for navigation.
  get srcdoc()  { const v = this._attrs.srcdoc; return v == null ? '' : String(v); }
  set srcdoc(v) { this.setAttribute('srcdoc', v == null ? '' : String(v)); }
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
  // `<link>` / `<style>` / `<source>` reflect the `media` content
  // attribute. Discourse's `interface-color` service does
  // `lightStylesheet.media = "all"` to toggle color schemes; without
  // the setter the JS-side `link.media` is a plain instance prop and
  // `document.querySelector('link[media="all"]')` (the color-mode page
  // object's check) never matches.
  get media() { return this._attrs.media == null ? '' : String(this._attrs.media); }
  set media(v) { this.setAttribute('media', v == null ? '' : String(v)); }
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
    // `list` resolves the <datalist> by id within the input's own tree (its
    // shadow root, else the document) — not across the shadow boundary.
    const root = this.getRootNode();
    const hit  = root && root.getElementById ? root.getElementById(id) : null;
    return (hit && hit._tag === 'datalist') ? hit : null;
  }
  get checked()  { return this._attrs.checked != null; }
  set checked(v) {
    // HTML dirty-checkedness flag: snapshot the default once before the
    // first IDL write so `<form>.reset()` can restore it (see reset()).
    if (this._defaultChecked === undefined) this._defaultChecked = (this._attrs.checked != null);
    const was = this._attrs.checked != null;
    if (v) this._attrs.checked = ''; else delete this._attrs.checked;
    // Checkedness is observable — `:checked` cascade rules, getComputedStyle,
    // visible_text — so bump the settle generation that those memos + Capybara's
    // settle key on. NOT a content-attribute mutation (checkedness is separate
    // from the `checked` attribute per HTML), so no MutationObserver record and
    // no input/change event (those are user-action only).
    if (was !== !!v) bumpSettleGen();
  }
  // Boolean IDL reflections — `el.disabled = true` mirrors to the `disabled`
  // content attribute (HTML IDL contract), so route through setAttribute /
  // removeAttribute (like `hidden` / `open`) rather than writing `_attrs`
  // directly: that fires the MutationObserver attributes record + settle-gen bump
  // real browsers produce for a reflected change (and re-resolves any cascade
  // memo keyed on the settle generation). A direct `_attrs` write was silent to
  // both — e.g. `el.disabled = true` under `input[disabled]{display:none}` left
  // the element wrongly reported visible.
  get disabled() { return this._attrs.disabled != null; }
  set disabled(v){ if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get readOnly() { return this._attrs.readonly != null; }
  set readOnly(v){ if (v) this.setAttribute('readonly', ''); else this.removeAttribute('readonly'); }
  get required() { return this._attrs.required != null; }
  set required(v){ if (v) this.setAttribute('required', ''); else this.removeAttribute('required'); }
  // Integer-reflecting IDL: `<input minlength="10">` → input.minLength === 10
  // (real browsers return -1 when unset). Discourse's
  // form-template-validation passes `count: field.minLength` into the
  // tooShort i18n string; an undefined here renders the literal
  // `count=undefined` placeholder instead of the translated count.
  get minLength() { const n = parseInt(this._attrs.minlength || '', 10); return isNaN(n) ? -1 : n; }
  set minLength(v){ this.setAttribute('minlength', String(v == null ? '' : v)); }
  get maxLength() { const n = parseInt(this._attrs.maxlength || '', 10); return isNaN(n) ? -1 : n; }
  set maxLength(v){ this.setAttribute('maxlength', String(v == null ? '' : v)); }
  // ── HTMLInputElement reflected string IDL ─────────────────────────
  // Each reflects its same-named (lowercased) content attribute as a
  // string. Only meaningful on `<input>`; mirror the existing
  // reflected-string idiom and default to '' off-input.
  get accept()      { return this._tag === 'input' ? (this._attrs.accept      == null ? '' : String(this._attrs.accept))      : ''; }
  set accept(v)     { this.setAttribute('accept', v == null ? '' : String(v)); }
  get alt()         { return this._tag === 'input' ? (this._attrs.alt         == null ? '' : String(this._attrs.alt))         : ''; }
  set alt(v)        { this.setAttribute('alt', v == null ? '' : String(v)); }
  get pattern()     { return this._tag === 'input' ? (this._attrs.pattern     == null ? '' : String(this._attrs.pattern))     : ''; }
  set pattern(v)    { this.setAttribute('pattern', v == null ? '' : String(v)); }
  get placeholder() { return this._tag === 'input' ? (this._attrs.placeholder == null ? '' : String(this._attrs.placeholder)) : ''; }
  set placeholder(v){ this.setAttribute('placeholder', v == null ? '' : String(v)); }
  get step()        { return this._tag === 'input' ? (this._attrs.step        == null ? '' : String(this._attrs.step))        : ''; }
  set step(v)       { this.setAttribute('step', v == null ? '' : String(v)); }
  get min()         { return this._tag === 'input' ? (this._attrs.min         == null ? '' : String(this._attrs.min))         : ''; }
  set min(v)        { this.setAttribute('min', v == null ? '' : String(v)); }
  get max()         { return this._tag === 'input' ? (this._attrs.max         == null ? '' : String(this._attrs.max))         : ''; }
  set max(v)        { this.setAttribute('max', v == null ? '' : String(v)); }
  get dirName()     { return this._tag === 'input' ? (this._attrs.dirname     == null ? '' : String(this._attrs.dirname))     : ''; }
  set dirName(v)    { this.setAttribute('dirname', v == null ? '' : String(v)); }
  get capture()     { return this._tag === 'input' ? (this._attrs.capture     == null ? '' : String(this._attrs.capture))     : ''; }
  set capture(v)    { this.setAttribute('capture', v == null ? '' : String(v)); }
  get useMap()      { return this._tag === 'input' ? (this._attrs.usemap      == null ? '' : String(this._attrs.usemap))      : ''; }
  set useMap(v)     { this.setAttribute('usemap', v == null ? '' : String(v)); }
  get align()       { return this._tag === 'input' ? (this._attrs.align       == null ? '' : String(this._attrs.align))       : ''; }
  set align(v)      { this.setAttribute('align', v == null ? '' : String(v)); }
  // formaction / formenctype / formmethod / formtarget — submit-button
  // overrides; plain reflected strings.
  get formAction()  { return this._tag === 'input' ? (this._attrs.formaction  == null ? '' : String(this._attrs.formaction))  : ''; }
  set formAction(v) { this.setAttribute('formaction', v == null ? '' : String(v)); }
  get formEnctype() { return this._tag === 'input' ? (this._attrs.formenctype == null ? '' : String(this._attrs.formenctype)) : ''; }
  set formEnctype(v){ this.setAttribute('formenctype', v == null ? '' : String(v)); }
  get formMethod()  { return this._tag === 'input' ? (this._attrs.formmethod  == null ? '' : String(this._attrs.formmethod))  : ''; }
  set formMethod(v) { this.setAttribute('formmethod', v == null ? '' : String(v)); }
  get formTarget()  { return this._tag === 'input' ? (this._attrs.formtarget  == null ? '' : String(this._attrs.formtarget))  : ''; }
  set formTarget(v) { this.setAttribute('formtarget', v == null ? '' : String(v)); }
  // popovertargetaction — enumerated string, default ''.
  get popoverTargetAction()  { return this._tag === 'input' ? (this._attrs.popovertargetaction == null ? '' : String(this._attrs.popovertargetaction)) : ''; }
  set popoverTargetAction(v) { this.setAttribute('popovertargetaction', v == null ? '' : String(v)); }
  // ── HTMLInputElement boolean IDL reflections ──────────────────────
  get formNoValidate()  { return this._tag === 'input' ? this.hasAttribute('formnovalidate') : false; }
  set formNoValidate(v) { if (v) this.setAttribute('formnovalidate', ''); else this.removeAttribute('formnovalidate'); }
  get multiple()        { return this._tag === 'input' ? this.hasAttribute('multiple') : false; }
  set multiple(v)       { if (v) this.setAttribute('multiple', ''); else this.removeAttribute('multiple'); }
  get webkitdirectory()  { return this._tag === 'input' ? this.hasAttribute('webkitdirectory') : false; }
  set webkitdirectory(v) { if (v) this.setAttribute('webkitdirectory', ''); else this.removeAttribute('webkitdirectory'); }
  // ── HTMLInputElement unsigned-long IDL reflections ────────────────
  // size defaults to 20; non-positive / NaN falls back to the default.
  get size()  { const n = parseInt(this._attrs.size, 10); return Number.isNaN(n) || n <= 0 ? 20 : n; }
  set size(v) { this.setAttribute('size', String(v == null ? '' : v)); }
  // height / width default to 0 (the rendered pixel size for image
  // inputs; we don't lay out, so just reflect the attribute or 0).
  get height()  { const n = parseInt(this._attrs.height, 10); return Number.isNaN(n) ? 0 : n; }
  set height(v) { this.setAttribute('height', String(v == null ? '' : v)); }
  get width()   { const n = parseInt(this._attrs.width, 10); return Number.isNaN(n) ? 0 : n; }
  set width(v)  { this.setAttribute('width', String(v == null ? '' : v)); }
  // ── HTMLInputElement default* IDL ─────────────────────────────────
  // `defaultChecked` / `defaultValue` reflect the *content* attribute
  // (`checked` / `value`), NOT the dirty-tracking `_defaultChecked` /
  // `_defaultValue` snapshot fields used by `<form>.reset()` — those
  // are independent concepts (HTML "dirty flag" vs. attribute view).
  get defaultChecked()  { return this.hasAttribute('checked'); }
  set defaultChecked(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
  // NB: the live `value` IDL and the `value` content attribute share
  // the `_attrs.value` slot in this codebase (a known wart). Reading /
  // writing `defaultValue` via getAttribute/setAttribute('value', …)
  // at least keeps it consistent with the attribute view.
  // `value` and the `value` content attribute share the `_attrs.value`
  // slot here, so once the live value is dirtied (`set value`) the
  // content attribute is gone. `set value` snapshots the pre-dirty
  // default into `_defaultValue` (same field `<form>.reset()` restores
  // from), so prefer that snapshot — that IS the default value. Falls
  // back to the live attribute when never dirtied.
  get defaultValue()  { return this._defaultValue !== undefined ? this._defaultValue : (this.getAttribute('value') || ''); }
  set defaultValue(v) {
    const s = v == null ? '' : String(v);
    // When dirtied, only move the default; the live value stays put.
    // When clean, write the attribute so the (clean) live value tracks it.
    if (this._defaultValue !== undefined) this._defaultValue = s;
    else this.setAttribute('value', s);
  }
  // `indeterminate` is an IDL boolean stored on the instance — it has
  // no content attribute. Backed by a field, default false.
  get indeterminate()  { return this._indeterminate === true; }
  set indeterminate(v) { this._indeterminate = !!v; }
  // `<input>.labels` — every `<label for=this.id>` in the document
  // plus any ancestor `<label>`. Deduped, in document order. When the
  // id is empty, only ancestor labels participate.
  get labels() {
    if (this._tag !== 'input') return undefined;
    const out = [];
    const seen = new Set();
    const push = (l) => { if (l && !seen.has(l)) { seen.add(l); out.push(l); } };
    const doc = this.ownerDocument;
    const id = this._attrs.id;
    if (id && doc) {
      for (const l of doc.getElementsByTagName('label')) {
        if (l._attrs.for === id) push(l);
      }
    }
    let p = this._parent;
    while (p && p.nodeType === NODE_ELEMENT) {
      if (p._tag === 'label') push(p);
      p = p._parent;
    }
    // Document order: for-associated labels are already in tree order;
    // re-sort the merged set so an ancestor label slots correctly.
    if (doc) {
      // HTMLCollection is not an Array — materialise it for indexOf-based ordering.
      const all = Array.from(doc.getElementsByTagName('label'));
      out.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    }
    return out;
  }
  // ── HTMLInputElement value-as-number / value-as-date ──────────────
  // For number / range, parse `value` as a float (NaN when blank /
  // invalid). Other types report NaN (minimal — date parsing is heavy).
  get valueAsNumber() {
    if (this._tag !== 'input') return NaN;
    const type = (this._attrs.type || 'text').toLowerCase();
    if (type === 'number' || type === 'range') {
      const v = this.value;
      if (v === '' || v == null) return NaN;
      const n = parseFloat(v);
      return Number.isNaN(n) ? NaN : n;
    }
    return NaN;
  }
  set valueAsNumber(v) {
    if (this._tag !== 'input') return;
    this.value = (v == null || Number.isNaN(v)) ? '' : String(v);
  }
  // Minimal `valueAsDate`: cheaply support type=date (`new Date(value)`,
  // null on invalid); other types / blank → null. Setter formats a
  // Date into `value` for date types.
  get valueAsDate() {
    if (this._tag !== 'input') return null;
    const type = (this._attrs.type || 'text').toLowerCase();
    if (type === 'date') {
      const v = this.value;
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  set valueAsDate(v) {
    if (this._tag !== 'input') return;
    if (v == null) { this.value = ''; return; }
    const type = (this._attrs.type || 'text').toLowerCase();
    if (type === 'date' && v instanceof Date && !Number.isNaN(v.getTime())) {
      this.value = v.toISOString().slice(0, 10);
    } else {
      this.value = '';
    }
  }
  // `stepUp(n)` / `stepDown(n)` — adjust the numeric value by
  // `step * n`, clamped to min / max when those parse as numbers.
  stepUp(n)   { this._stepBy(n == null ? 1 : n); }
  stepDown(n) { this._stepBy(-(n == null ? 1 : n)); }
  _stepBy(delta) {
    if (this._tag !== 'input') return;
    const min  = parseFloat(this._attrs.min);
    const step = parseFloat(this._attrs.step);
    const base = (() => { const b = parseFloat(this.value); return Number.isNaN(b) ? (Number.isNaN(min) ? 0 : min) : b; })();
    let next = base + (Number.isNaN(step) ? 1 : step) * delta;
    if (!Number.isNaN(min) && next < min) next = min;
    const max = parseFloat(this._attrs.max);
    if (!Number.isNaN(max) && next > max) next = max;
    this.value = String(next);
  }
  // `showPicker()` — real browsers require user activation; a no-op is
  // a safe approximation (we have no native picker UI).
  showPicker() {}
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
    let empty;
    if (tag === 'select') {
      // A `<select>`'s value is its selected option's value (or the implicit
      // first-option default), NOT a `value` attribute — resolve it via the
      // IDL getter so `required` validity reflects the actual selection.
      const sv = this.value;
      empty = Array.isArray(sv) ? sv.length === 0 : (sv == null || sv === '');
    } else {
      empty = checkable ? this._attrs.checked == null : val === '';
    }
    const v = {
      valueMissing: false, typeMismatch: false, patternMismatch: false,
      tooLong: false, tooShort: false, rangeUnderflow: false,
      rangeOverflow: false, stepMismatch: false, badInput: false,
      customError: !!this._validationMessage,
      valid: true
    };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const requiredApplies = tag !== 'input' || !NO_REQUIRED_INPUT_TYPES.has(type);
      if (requiredApplies && this._attrs.required != null && empty) v.valueMissing = true;
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
      this._children = newChildList([Object.assign(new Text(next), { _parent: this })]);
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
    // HTML spec: select() focuses the input as a side effect and
    // fires a `select` event if one can be fired on the element.
    this.focus();
    this._selectionStart = 0;
    this._selectionEnd   = (this._attrs.value || '').length;
    try { dispatchEvent(this, new Event('select', { bubbles: true, cancelable: false })); } catch (_) {}
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
  // HTML lets you assign a `FileList` to a file input programmatically — the
  // canonical pattern is `input.files = dataTransfer.files` (drag-drop libraries,
  // and the kamalog `attach-images` Stimulus controller, do exactly this). Accept
  // any array-like of File objects; null/undefined clears the selection.
  set files(value) {
    if (this._tag !== 'input') return;
    if ((this._attrs.type || '').toLowerCase() !== 'file') return;
    this._files = value == null ? [] : Array.from(value);
  }

  // In an XML/XHTML document `innerHTML` getting is the XML serialization of the
  // children (require-well-formed), not the HTML serialization.
  get innerHTML() {
    return isHtmlDocument(this.ownerDocument) ? serializeChildren(this) : xmlSerializeInner(this);
  }
  set innerHTML(html) {
    // XML/XHTML document: replace the children with the XML-fragment parse
    // (well-formedness errors throw before anything is mutated). The HTML-only
    // <template>.content / <html> special cases below don't apply in XML.
    if (!isHtmlDocument(this.ownerDocument)) {
      const doc = this.ownerDocument;
      const parsed = parseXmlFragment(html, this);
      const removed = this._children.slice();
      for (const c of removed) { c._parent = null; unregisterSubtree(c); }
      this._children = newChildList();
      for (const c of parsed) {
        // The parsed nodes are born owner-less; adopt them into this element's
        // document so `ownerDocument` resolves to the XML document (not the main
        // HTML page), matching the outerHTML / insertAdjacentHTML insert paths.
        doc.adoptNode(c);
        c._parent = this; this._children.push(c); registerSubtree(c);
      }
      if (removed.length || parsed.length) recordChildList(this, parsed, removed);
      return;
    }
    // `<template>.innerHTML` setter populates the template's
    // `.content` fragment, not the template's own children (per
    // HTML spec — the inert subtree lives on the fragment).
    if (this._tag === 'template') {
      const frag = this.content;
      const tmplRemoved = frag._children.slice();
      for (const c of tmplRemoved) { c._parent = null; unregisterSubtree(c); }
      frag._children = newChildList();
      const parsed = parseFragment(String(html === null ? '' : html), this);
      for (const c of parsed) {
        c._parent = frag;
        frag._children.push(c);
        registerSubtree(c);
      }
      bumpSettleGen();   // direct _children edit: refresh live collections (cached frag.children)
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
    this._children = newChildList();
    let frag;
    if (this._tag === 'html') {
      const parsed = parse5ParseDocument(String(html === null ? '' : html));
      frag = parsed.documentElement ? parsed.documentElement._children.slice() : [];
    } else {
      frag = parseFragment(String(html === null ? '' : html), this);
    }
    // Parsed nodes are born owner-less; for the main document the ownerDocument
    // getter's fallback covers that, but when this element belongs to another
    // document (createHTMLDocument / XML) they must be adopted so their
    // ownerDocument resolves to it (mirrors the XML / insertAdjacentHTML paths).
    // Gated on the non-main case to keep the hot main-document path allocation-
    // and walk-free (rule 3).
    const ownerDoc = this.ownerDocument;
    const adopt = ownerDoc && ownerDoc !== globalThis.document && typeof ownerDoc.adoptNode === 'function';
    for (const c of frag) {
      if (adopt) ownerDoc.adoptNode(c);
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
    // Selectedness: this inline `innerHTML` path attaches parsed nodes
    // directly (no insert hook, no connect walk), so a rebuilt `<select>`
    // would miss the selectedness algorithm. Run it for the direct-select
    // case (the common `select.innerHTML = options` refresh) and — only
    // when the markup could contain one — for selects nested in the
    // fragment. The `<select` pre-filter keeps the walk off the hot path.
    if (this._tag === 'select') {
      finalizeSelectOptions(this);
    } else if (frag.length && /<select/i.test(html)) {
      for (const c of frag) {
        if (c.nodeType !== NODE_ELEMENT) continue;
        if (c._tag === 'select') finalizeSelectOptions(c);
        if (c.querySelectorAll) for (const sel of c.querySelectorAll('select')) finalizeSelectOptions(sel);
      }
    }
  }
  // In an XML/XHTML document `outerHTML` getting is the XML serialization of the
  // element itself (require-well-formed), mirroring the innerHTML getter.
  get outerHTML() {
    return isHtmlDocument(this.ownerDocument) ? serializeElement(this) : xmlSerializeOuter(this);
  }
  // `el.outerHTML = html` (DOM Parsing spec): parse `html` as a fragment and
  // replace this element with the result, within this element's parent.
  set outerHTML(html) {
    const parent = this._parent;
    // No parent → the parsed nodes would be unreferenceable; spec leaves this
    // a no-op. A Document parent can't have its child replaced this way.
    if (parent == null) return;
    if (parent.nodeType === NODE_DOC) {
      throw new globalThis.DOMException("Cannot set the 'outerHTML' property on an element whose parent is a Document.", 'NoModificationAllowedError');
    }
    // `outerHTML` is `[LegacyNullToEmptyString]`: only `null` → "" — `undefined`
    // coerces normally to the string "undefined". In an XML/XHTML document the
    // replacement is parsed as an XML fragment (context = the parent element).
    const nodes = isHtmlDocument(this.ownerDocument)
      ? parseFragment(html === null ? '' : String(html), parent)
      : parseXmlFragment(html, parent);
    // Spec (DOM Parsing): "replace this with the new nodes within parent" — a
    // single DOM "replace", so observers see ONE childList record (removedNodes
    // = [this], addedNodes = the parsed nodes), not a remove + separate inserts.
    parent._replaceChildWithNodes(this, nodes);
  }
  // `insertAdjacentHTML(position, html)` — DOM spec method. Forem's
  // initializeBroadcast uses `el.insertAdjacentHTML('afterbegin', …)`
  // to inject the announcement banner. Positions: `beforebegin` /
  // `afterbegin` / `beforeend` / `afterend`.
  insertAdjacentHTML(position, html) {
    const pos = String(position).toLowerCase();
    // Resolve the context element per spec; an unknown position is a
    // SyntaxError, and beforebegin/afterend with no element parent (null or a
    // Document) is a NoModificationAllowedError.
    if (pos === 'beforebegin' || pos === 'afterend') {
      if (!this._parent || this._parent.nodeType === NODE_DOC) {
        throw new globalThis.DOMException("Cannot insert adjacent HTML: the element has no parent.", 'NoModificationAllowedError');
      }
    } else if (pos !== 'afterbegin' && pos !== 'beforeend') {
      throw new globalThis.DOMException("The value provided ('" + position + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", 'SyntaxError');
    }
    // XML/XHTML document → XML fragment parsing (context per spec: the parent for
    // beforebegin/afterend, this element otherwise); malformed markup throws SyntaxError.
    const ctx = (pos === 'beforebegin' || pos === 'afterend') ? this._parent : this;
    const frag = isHtmlDocument(this.ownerDocument)
      ? parseFragment(String(html === null ? '' : html), ctx)
      : parseXmlFragment(html, ctx);
    if (pos === 'beforebegin')     { for (const c of frag) this._parent.insertBefore(c, this); }
    else if (pos === 'afterbegin') { const first = this._children[0] || null; for (const c of frag) this.insertBefore(c, first); }
    else if (pos === 'beforeend')  { for (const c of frag) this.appendChild(c); }
    else /* afterend */            { const next = this.nextSibling; for (const c of frag) this._parent.insertBefore(c, next); }
  }
  // Shared "insert adjacent" core for insertAdjacentElement / insertAdjacentText
  // (NOT insertAdjacentHTML, which has its own context algorithm). beforebegin /
  // afterend with no parent return null; an unknown position is a SyntaxError;
  // a Document parent surfaces as HierarchyRequestError from the pre-insertion
  // validity inside insertBefore (NOT the NoModificationAllowedError that
  // insertAdjacentHTML raises).
  _insertAdjacent(position, node) {
    const pos = String(position).toLowerCase();
    if (pos === 'beforebegin')     { if (!this._parent) return null; this._parent.insertBefore(node, this); }
    else if (pos === 'afterbegin') { this.insertBefore(node, this._children[0] || null); }
    else if (pos === 'beforeend')  { this.appendChild(node); }
    else if (pos === 'afterend')   { if (!this._parent) return null; this._parent.insertBefore(node, this.nextSibling); }
    else throw new globalThis.DOMException("The value provided ('" + position + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.", 'SyntaxError');
    return node;
  }
  insertAdjacentText(position, text) {
    this._insertAdjacent(position, this.ownerDocument.createTextNode(String(text == null ? '' : text)));
  }
  insertAdjacentElement(position, element) {
    // WebIDL: the second argument is a non-nullable `Element`, so a non-Element
    // (e.g. a DocumentType) is a TypeError at the binding layer — before the
    // insertion algorithm runs (which would otherwise raise HierarchyRequestError).
    if (element == null || element.nodeType !== NODE_ELEMENT) {
      throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.");
    }
    return this._insertAdjacent(position, element);
  }
  attachShadow(init) {
    // `mode` is a required ShadowRootMode enum; `slotAssignment` an optional
    // SlotAssignmentMode. WebIDL enum coercion (→ TypeError) happens before the
    // method body, so both precede the element-validity / already-hosts checks.
    const mode = init && init.mode;
    if (mode !== 'open' && mode !== 'closed') {
      throw new globalThis.TypeError("Failed to execute 'attachShadow' on 'Element': The provided value '" + mode + "' is not a valid enum value of type ShadowRootMode.");
    }
    const slotAssignment = init && init.slotAssignment !== undefined ? String(init.slotAssignment) : 'named';
    if (slotAssignment !== 'named' && slotAssignment !== 'manual') {
      throw new globalThis.TypeError("Failed to execute 'attachShadow' on 'Element': The provided value '" + slotAssignment + "' is not a valid enum value of type SlotAssignmentMode.");
    }
    if (!canAttachShadow(this)) {
      throw new globalThis.DOMException("Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow", 'NotSupportedError');
    }
    if (this._shadowRoot) {
      // HTML "attach a shadow root" reuse path (whatwg/dom#1246): a DECLARATIVE
      // shadow root (from `<template shadowrootmode>`) is reused when the new
      // mode MATCHES — the only parameter checked. The root is emptied and its
      // declarative flag cleared, then returned AS-IS: delegatesFocus /
      // slotAssignment / clonable / serializable keep their declarative-creation
      // values and are NOT overwritten by this init. A non-declarative existing
      // root, or a mode mismatch, throws.
      const ex = this._shadowRoot;
      if (!ex._declarative || ex.mode !== mode) {
        throw new globalThis.DOMException("Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree.", 'NotSupportedError');
      }
      for (const c of ex._children.slice()) { c._parent = null; unregisterSubtree(c); }
      ex._children = newChildList();
      ex._declarative    = false;
      ex._scopedRules    = null;   // invalidate the shadow cascade's cached rules
      return ex;
    }
    const sr = new ShadowRoot(this, mode, SHADOW_ROOT_INTERNAL);
    sr._slotAssignment = slotAssignment;
    sr._clonable = !!(init && init.clonable);   // cloneNode of the host clones a clonable shadow tree
    sr._delegatesFocus = !!(init && init.delegatesFocus);
    sr._serializable   = !!(init && init.serializable);
    this._shadowRoot = sr;
    shadowHostCount++;
    // Mirror the count to a global so the cascade (a separate module, can't
    // import this without a cycle) can cheaply skip its shadow-scope ancestor
    // walk on shadow-free pages — the hot getComputedStyle path pays one
    // truthy check instead of an O(depth) walk per property read (rule 3).
    globalThis.__csimShadowHostCount = shadowHostCount;
    registerSubtree(sr);
    return sr;
  }
  get shadowRoot() {
    return this._shadowRoot && this._shadowRoot.mode === 'open' ? this._shadowRoot : null;
  }
  // HTML `HTMLElement.attachInternals()`: hands a custom element its
  // ElementInternals (closed-shadow access + form association + ARIA).
  // Restricted to a DEFINED autonomous custom element, once per element. The
  // definition is in the registry by the time a CE constructor (or post-define
  // caller) runs, so `getCustomElementCtor` resolves it. A customized built-in
  // (`<h2 is="…">`) is rejected per spec — and falls out naturally: its local
  // name has no hyphen, so the registry lookup misses and the `!def` throw
  // fires. (We don't read the `is` content attribute: an autonomous CE's `is`
  // value is always null regardless of a stray `is=` attribute, so reading the
  // attribute would spuriously reject a valid autonomous host.)
  attachInternals() {
    const def = this._ns === HTML_NS ? getCustomElementCtor(this._localName) : null;
    if (!def) {
      throw new globalThis.DOMException("Failed to execute 'attachInternals' on 'HTMLElement': Unable to attach ElementInternals to non-custom elements.", 'NotSupportedError');
    }
    let df; try { df = def.disabledFeatures; } catch (_) { df = null; }
    if (df && typeof df.indexOf === 'function' && df.indexOf('internals') !== -1) {
      throw new globalThis.DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals is disabled by disabledFeatures static field.", 'NotSupportedError');
    }
    if (this._internals) {
      throw new globalThis.DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals for the specified element was already attached.", 'NotSupportedError');
    }
    this._internals = new ElementInternals(this, ELEMENT_INTERNALS_INTERNAL);
    return this._internals;
  }

  // ── DOM Element method completeness (BATCH B2/B3) ───────────────
  hasAttributes() { return Object.keys(this._attrs).length > 0; }
  // `webkitMatchesSelector` is the legacy vendor alias of `matches`. Needs its
  // own arity guard: `this.matches(sel)` would pass an explicit `undefined`
  // (arity 1), so a no-arg `webkitMatchesSelector()` wouldn't otherwise throw.
  webkitMatchesSelector(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'webkitMatchesSelector': 1 argument required, but only 0 present.");
    return this.matches(sel);
  }
  // Namespace-aware element queries collapse to the flat tag store.
  getElementsByTagNameNS(ns, local) { return liveHTMLCollection(() => collectByTagNameNS(this, ns, local)); }
  getAttributeNodeNS(ns, localName) {
    const key = this._attrKeyByNS(ns == null ? null : String(ns), String(localName));
    return key == null ? null : this._attrNodeFor(key);
  }
  // `setAttributeNode(attr)` per https://dom.spec.whatwg.org/#dom-element-setattributenode:
  // adopt a real Attr into this element's attribute list, replacing any
  // existing attribute with the same (namespace, local name), and return the
  // replaced Attr (or null). Throws InUseAttributeError if `attr` is already
  // bound to a different element.
  setAttributeNode(attr) {
    if (!(attr instanceof Attr)) {
      throw new globalThis.DOMException("Argument to setAttributeNode is not an Attr.", "TypeMismatchError");
    }
    if (attr._ownerElement != null && attr._ownerElement !== this) {
      throw new globalThis.DOMException("The attribute is in use by another element.", "InUseAttributeError");
    }
    const key = this._attrKeyByNS(attr._ns, attr._localName);
    const oldAttr = key != null ? this._attrNodeFor(key) : null;
    if (oldAttr === attr) return attr;
    if (oldAttr) this._detachAttrNode(oldAttr._key);
    this._bindAttrNode(attr);
    return oldAttr;
  }
  setAttributeNodeNS(attr) { return this.setAttributeNode(attr); }
  // `removeAttributeNode(attr)` — detach `attr` from this element and return
  // it. NotFoundError if `attr` is not in this element's attribute list.
  removeAttributeNode(attr) {
    if (!(attr instanceof Attr) || attr._ownerElement !== this) {
      throw new globalThis.DOMException("The attribute is not owned by this element.", "NotFoundError");
    }
    this._removeAttrKey(attr._key);
    return attr;
  }
  // `slot` reflects the `slot` content attribute (shadow-DOM slotting).
  get slot()  { return this._attrs.slot || ''; }
  set slot(v) { this.setAttribute('slot', String(v == null ? '' : v)); }
  // Slottable mixin: the slot this element is assigned to (open shadow trees
  // only — a slot inside a closed shadow tree is not observable here).
  get assignedSlot() { return findSlotForSlottable(this, true); }
  // HTMLSlotElement methods. Live on Element.prototype (every HTML interface
  // shares it) but only meaningful for a <slot>: on any other element they
  // return [] (findSlottables sees no enclosing shadow root for it). flatten
  // expands nested slots / fallback content; assignedElements drops Text.
  // slotAssignedNodes already returns a fresh array, so no defensive copy.
  assignedNodes(options)    { return slotAssignedNodes(this, options); }
  assignedElements(options) { return slotAssignedNodes(this, options).filter(n => n.nodeType === NODE_ELEMENT); }
  // HTMLSlotElement.assign((Element or Text)... nodes) — imperative slot
  // assignment. WebIDL takes a variadic, NOT a sequence: an array argument (or
  // any non-Element/Text node) is a TypeError. Meaningful only for a <slot> in
  // a manual-assignment shadow root; recording is harmless elsewhere.
  assign(...nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || (n.nodeType !== NODE_ELEMENT && n.nodeType !== NODE_TEXT)) {
        throw new TypeError("Failed to execute 'assign' on 'HTMLSlotElement': The provided value is not of type '(Element or Text)'.");
      }
    }
    assignManualSlottables(this, nodes);
  }
  // `scroll(...)` is the legacy synonym of `scrollTo(...)`.
  scroll(...args) { return this.scrollTo(...args); }
  // Pointer-capture API — no real pointer device, so capture is never
  // held. Methods are no-ops that satisfy feature-detecting callers.
  hasPointerCapture(_id) { return false; }
  setPointerCapture(_id) {}
  releasePointerCapture(_id) {}
  // `getHTML(options)` serializes the element's children like innerHTML, but
  // ALSO serializes shadow roots the options ask for (`serializableShadowRoots`
  // + a root's `serializable` flag, or roots listed in `shadowRoots`) as
  // `<template shadowrootmode=…>` first children. No options → plain innerHTML.
  getHTML(options) {
    if (!isHtmlDocument(this.ownerDocument)) return this.innerHTML;
    return serializeChildrenWithShadow(this, normalizeGetHTMLOptions(options));
  }
  // `setHTMLUnsafe` parses like `innerHTML` but ADDITIONALLY processes
  // declarative shadow roots (`<template shadowrootmode>` → real shadow root).
  // `innerHTML` deliberately does not, so do the conversion after the parse.
  setHTMLUnsafe(markup) {
    const html = String(markup == null ? '' : markup);
    this.innerHTML = html;
    // `<template>.innerHTML` routes the parse into the inert content fragment
    // (not `_children`), so scan there for declarative shadow roots; every
    // other element holds the parsed nodes as its own children. Pass `this` as
    // the context element so a top-level `<template shadowrootmode>` (its parent
    // being `this`) is NOT converted — the context element is never a DSD host.
    if (this._tag === 'template') {
      processDeclarativeShadowRoots(this.content);
    } else {
      processDeclarativeShadowRoots(this, this);
    }
  }

  // ── HTMLElement string / boolean reflection (BATCH C) ───────────
  get lang()  { return this._attrs.lang || ''; }
  set lang(v) { this.setAttribute('lang', String(v == null ? '' : v)); }
  get dir()   { return this._attrs.dir || ''; }
  set dir(v)  { this.setAttribute('dir', String(v == null ? '' : v)); }
  // HTML hides the nonce content attribute once the element is connected (it's
  // emptied and stashed in an internal slot, so it can't be read back via a CSS
  // attribute selector — see the connection step in fireCEConnect). A still-
  // visible content attribute (set but not yet connected) wins; otherwise the
  // IDL getter falls back to the stashed value.
  get nonce()  { const a = this._attrs.nonce; return (a != null && a !== '') ? a : (this._nonce || ''); }
  set nonce(v) { this.setAttribute('nonce', String(v == null ? '' : v)); }
  get accessKey()  { return this._attrs.accesskey || ''; }
  set accessKey(v) { this.setAttribute('accesskey', String(v == null ? '' : v)); }
  get accessKeyLabel() { return ''; }
  get autocapitalize()  { return this._attrs.autocapitalize || ''; }
  set autocapitalize(v) { this.setAttribute('autocapitalize', String(v == null ? '' : v)); }
  get autocorrect()  { return this._attrs.autocorrect || ''; }
  set autocorrect(v) { this.setAttribute('autocorrect', String(v == null ? '' : v)); }
  get enterKeyHint()  { return this._attrs.enterkeyhint || ''; }
  set enterKeyHint(v) { this.setAttribute('enterkeyhint', String(v == null ? '' : v)); }
  get inputMode()  { return this._attrs.inputmode || ''; }
  set inputMode(v) { this.setAttribute('inputmode', String(v == null ? '' : v)); }
  get virtualKeyboardPolicy()  { return this._attrs.virtualkeyboardpolicy || ''; }
  set virtualKeyboardPolicy(v) { this.setAttribute('virtualkeyboardpolicy', String(v == null ? '' : v)); }
  // `draggable` is an enumerated attribute ('true' / 'false') reflected
  // as a boolean IDL. Missing-value default is TRUE for <img> and for
  // <a> / <area> with an href, false otherwise (HTML spec).
  get draggable()  {
    const v = this._attrs.draggable;
    if (v != null) return v === 'true';
    const t = this._tag;
    if (t === 'img') return true;
    if ((t === 'a' || t === 'area') && this._attrs.href != null) return true;
    return false;
  }
  set draggable(v) { this.setAttribute('draggable', v ? 'true' : 'false'); }
  // `spellcheck` / `translate` / `writingSuggestions` default to "on".
  get spellcheck()  { return this._attrs.spellcheck !== 'false'; }
  set spellcheck(v) { this.setAttribute('spellcheck', v ? 'true' : 'false'); }
  // `translate` is an INHERITED enumerated attribute (missing-value
  // default 'inherit'): an element with no own `translate` attr takes
  // the value from its nearest ancestor that has one; default true at
  // the root (HTML spec).
  get translate()  {
    let el = this;
    while (el && el.nodeType === NODE_ELEMENT) {
      const v = el._attrs.translate;
      if (v === 'yes') return true;
      if (v === 'no') return false;
      el = el._parent;
    }
    return true;
  }
  set translate(v) { this.setAttribute('translate', v ? 'yes' : 'no'); }
  get writingSuggestions()  { return this._attrs.writingsuggestions !== 'false'; }
  set writingSuggestions(v) { this.setAttribute('writingsuggestions', v ? 'true' : 'false'); }
  // `inert` / `autofocus` are plain boolean reflections.
  get inert()  { return this.hasAttribute('inert'); }
  set inert(v) { if (v) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
  get autofocus()  { return this.hasAttribute('autofocus'); }
  set autofocus(v) { if (v) this.setAttribute('autofocus', ''); else this.removeAttribute('autofocus'); }
  // `tabIndex` reflects `tabindex` as a long; default 0 for natively-
  // focusable elements, -1 otherwise.
  get tabIndex() {
    const n = parseInt(this._attrs.tabindex, 10);
    if (!Number.isNaN(n)) return n;
    const t = this._tag;
    if (t === 'a' || t === 'area' ? this._attrs.href != null
        : (t === 'button' || t === 'input' || t === 'select' || t === 'textarea' ||
           t === 'iframe' || t === 'details' || t === 'summary')) return 0;
    return -1;
  }
  set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  // `contentEditable` enumerated reflection of `contenteditable`
  // (the boolean `isContentEditable` IDL lives elsewhere).
  get contentEditable() {
    const v = this._attrs.contenteditable;
    if (v == null) return 'inherit';
    const lc = String(v).toLowerCase();
    if (lc === '' || lc === 'true') return 'true';
    if (lc === 'false') return 'false';
    if (lc === 'plaintext-only') return 'plaintext-only';
    return 'inherit';
  }
  set contentEditable(v) { this.setAttribute('contenteditable', String(v == null ? '' : v)); }
  // `outerText` getter mirrors `innerText`. The setter is writable in
  // real browsers (a getter-only accessor throws under strict mode).
  // Spec-wise it replaces the element *itself* with the assigned text
  // (newlines → <br>); we approximate by replacing the element's
  // content with a single Text node, which avoids the TypeError
  // regression and covers the common `el.outerText = str` usage.
  get outerText() { return this.innerText; }
  set outerText(v) { this.textContent = String(v == null ? '' : v); }

  // ── HTMLAnchorElement URL decomposition (BATCH E) ───────────────
  // Gate on the `<a>` / `<area>` tag and parse the resolved href.
  get hreflang()  { return this._attrs.hreflang || ''; }
  set hreflang(v) { this.setAttribute('hreflang', String(v == null ? '' : v)); }
  get referrerPolicy()  { return this._attrs.referrerpolicy || ''; }
  set referrerPolicy(v) { this.setAttribute('referrerpolicy', String(v == null ? '' : v)); }
  get rev()  { return this._attrs.rev || ''; }
  set rev(v) { this.setAttribute('rev', String(v == null ? '' : v)); }
  get coords()  { return this._attrs.coords || ''; }
  set coords(v) { this.setAttribute('coords', String(v == null ? '' : v)); }
  get shape()  { return this._attrs.shape || ''; }
  set shape(v) { this.setAttribute('shape', String(v == null ? '' : v)); }
  get charset()  { return this._attrs.charset || ''; }
  set charset(v) { this.setAttribute('charset', String(v == null ? '' : v)); }
  get ping()  { return this._attrs.ping || ''; }
  set ping(v) { this.setAttribute('ping', String(v == null ? '' : v)); }
  // Per HTMLHyperlinkElementUtils, when the element's url is null (absent or
  // unparseable href) the `protocol` getter returns ':' (every other component
  // returns ''). Gated to a/area so a stray `div.protocol` stays ''.
  get protocol() {
    if (this._tag !== 'a' && this._tag !== 'area') return '';
    const u = anchorURL(this);
    return u ? u.protocol : ':';
  }
  set protocol(v) { anchorSetURL(this, u => { u.protocol = String(v); }); }
  get host() { const u = anchorURL(this); return u ? u.host : ''; }
  set host(v) { anchorSetURL(this, u => { u.host = String(v); }); }
  get hostname() { const u = anchorURL(this); return u ? u.hostname : ''; }
  set hostname(v) { anchorSetURL(this, u => { u.hostname = String(v); }); }
  get port() { const u = anchorURL(this); return u ? u.port : ''; }
  set port(v) { anchorSetURL(this, u => { u.port = String(v); }); }
  get pathname() { const u = anchorURL(this); return u ? u.pathname : ''; }
  set pathname(v) { anchorSetURL(this, u => { u.pathname = String(v); }); }
  get search() { const u = anchorURL(this); return u ? u.search : ''; }
  set search(v) { anchorSetURL(this, u => { u.search = String(v); }); }
  get hash() { const u = anchorURL(this); return u ? u.hash : ''; }
  set hash(v) { anchorSetURL(this, u => { u.hash = String(v); }); }
  get origin() { const u = anchorURL(this); return u ? u.origin : ''; }
  get username() { const u = anchorURL(this); return u ? u.username : ''; }
  set username(v) { anchorSetURL(this, u => { u.username = String(v); }); }
  get password() { const u = anchorURL(this); return u ? u.password : ''; }
  set password(v) { anchorSetURL(this, u => { u.password = String(v); }); }
  // Token-list reflections are element-type gated per the HTML spec: an
  // element that doesn't define the attribute exposes `undefined`, not a
  // stray DOMTokenList. `relList` is on a/area/link/form (HTML) plus <a> in
  // SVG; sandbox/sizes/htmlFor are each on a single HTML element.
  get relList() {
    const ns = this._ns, ln = this._localName;
    if ((ns === HTML_NS && (ln === 'a' || ln === 'area' || ln === 'link' || ln === 'form')) ||
        (ns === SVG_NS && ln === 'a')) return tokenListFor(this, 'rel');
    return undefined;
  }
  get sandbox() {
    return (this._ns === HTML_NS && this._localName === 'iframe') ? tokenListFor(this, 'sandbox') : undefined;
  }
  get sizes() {
    return (this._ns === HTML_NS && this._localName === 'link') ? tokenListFor(this, 'sizes') : undefined;
  }
  // `htmlFor` is a DOMTokenList on <output> but a plain string ('for'
  // attribute) on <label>; undefined on everything else.
  get htmlFor() {
    if (this._ns !== HTML_NS) return undefined;
    if (this._localName === 'output') return tokenListFor(this, 'for');
    if (this._localName === 'label')  return this.getAttribute('for') || '';
    return undefined;
  }
  // HTMLLabelElement.control — the label's labeled control (its `for` target
  // resolved within the label's own tree, else the first labelable descendant),
  // or null. Resolved live; `null` (not undefined) when there is none.
  get control() {
    if (this._ns !== HTML_NS || this._localName !== 'label') return undefined;
    return labeledControlFor(this) || null;
  }
  // <output>.htmlFor is a [PutForwards=value] DOMTokenList and <label>.htmlFor
  // a plain string — both write the `for` attribute, so the setter is shared.
  set htmlFor(v) {
    if (this._ns === HTML_NS && (this._localName === 'label' || this._localName === 'output')) {
      this.setAttribute('for', String(v));
    }
  }

  // ── HTMLFormElement members (BATCH F) ───────────────────────────
  // `encoding` is the legacy alias of `enctype`.
  get encoding()  { return this.enctype; }
  set encoding(v) { this.enctype = v; }
  // `acceptCharset` reflects the hyphenated `accept-charset` attribute.
  get acceptCharset()  { return this._attrs['accept-charset'] || ''; }
  set acceptCharset(v) { this.setAttribute('accept-charset', String(v == null ? '' : v)); }
  get noValidate()  { return this.hasAttribute('novalidate'); }
  set noValidate(v) { if (v) this.setAttribute('novalidate', ''); else this.removeAttribute('novalidate'); }
  // `<form>.autocomplete` is enumerated 'on' / 'off' (default 'on').
  get autocomplete() {
    const v = (this._attrs.autocomplete || '').toLowerCase();
    return v === 'off' ? 'off' : 'on';
  }
  set autocomplete(v) { this.setAttribute('autocomplete', String(v == null ? '' : v)); }
  // `<form>.length` is the number of listed form controls.
  get length() {
    if (this._tag !== 'form') return undefined;
    const els = this.elements;
    return els ? els.length : 0;
  }
  // `<form>.reset()` restores each control to its default value /
  // checkedness (the original content attribute) and dispatches a
  // cancelable `reset` event, per the HTML reset algorithm.
  reset() {
    if (this._tag !== 'form') return;
    for (const el of this.elements || []) {
      const t = el._tag;
      if (t === 'input') {
        const type = (el._attrs.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          // Restore the snapshotted default checkedness (HTML dirty-
          // checkedness flag); fall back to the content attribute when
          // the control was never dirtied.
          const def = el._defaultChecked !== undefined ? el._defaultChecked : el.hasAttribute('checked');
          if (def) el._attrs.checked = '';
          else delete el._attrs.checked;
        } else {
          // Restore the snapshotted default value (HTML dirty-value
          // flag); fall back to the `value` content attribute when the
          // control was never dirtied.
          el._attrs.value = el._defaultValue !== undefined ? el._defaultValue : (el.getAttribute('value') || '');
        }
      } else if (t === 'textarea') {
        // When dirtied, `_defaultValue` holds the original textContent;
        // otherwise `el.value` derives the default from the children
        // (with the one-leading-newline strip).
        el._attrs.value = el._defaultValue !== undefined ? el._defaultValue : el.value;
      } else if (t === 'select') {
        // HTML reset: each option's selectedness reverts to its
        // `selected` content attribute (defaultSelected) and dirtiness
        // clears; then the select re-runs its selectedness algorithm.
        for (const o of el.querySelectorAll('option')) {
          o._selectedness = o.getAttributeNode('selected') != null;
          o._dirtySel = false;
          o._selInit = true;
        }
        runSelectednessAlgorithm(el, null);
      }
    }
    try { dispatchEvent(this, new Event('reset', { bubbles: true, cancelable: true })); } catch (_) {}
  }
}

// ── HTMLAnchorElement URL decomposition helpers (BATCH E) ─────────
// Parse an anchor's resolved `href` into a WHATWG URL via the in-VM
// `URL`; return null on a missing / unparseable href so component
// getters answer '' rather than throwing.
function anchorURL(el) {
  if (el._tag !== 'a' && el._tag !== 'area') return null;
  const href = el.href;
  if (!href) return null;
  try { return new globalThis.URL(href); } catch (_) { return null; }
}
// Mutate one URL component and write the recomposed href back.
function anchorSetURL(el, mutate) {
  const u = anchorURL(el);
  if (!u) return;
  try { mutate(u); el.href = u.href; } catch (_) {}
}

// HTML "navigate to a fragment": when a hyperlink's resolved URL equals
// the current document URL except for the fragment, the activation is a
// same-document navigation — update the URL and fire `hashchange`, with
// NO document fetch. We run it entirely in JS (rather than handing the
// navigation to Ruby) for two reasons: it is genuinely same-document, and
// in a pure-JS run (the WPT harness) Ruby never drains the pending-
// navigation slot, so a fragment link would otherwise never fire
// `hashchange`. Shared by both click paths (IDL `Element.click()` and the
// UA/Capybara click resolver). Returns true when it handled the
// activation, so the caller skips the cross-document navigation path.
// `anchor` is the activating `<a>` / `<area>`; its `.href` getter has
// already resolved the attribute against the document base URL.
export function fragmentNavigate(anchor) {
  // A non-self browsing-context target (`_blank`, a named window, …)
  // opens elsewhere — never a same-document fragment hop.
  const target = String(anchor._attrs.target || '').toLowerCase();
  if (target && target !== '_self') return false;
  // Fast reject (avoid the URL parses in `tryFragmentNavigate` on the
  // common cross-document link): a same-document fragment hop needs EITHER
  // a fragment in the target OR one in the current URL to clear. Resolving
  // a ref against a base never inherits the base's fragment, so a `#`-free
  // raw href stays fragmentless.
  const rawHref = anchor._attrs.href || '';
  if (rawHref.indexOf('#') === -1 && (globalThis.location.href || '').indexOf('#') === -1) return false;
  return tryFragmentNavigate(anchor.href);
}

// ── ARIAMixin string reflection (BATCH B1) ───────────────────────
// Each ARIA IDL property reflects an `aria-*` content attribute (or
// bare `role`). Per spec these reflect as nullable strings: getter
// returns the attribute value or null; setter writes the attribute,
// or removes it when assigned null/undefined. Installed once on
// Element.prototype via a camelCase→attribute table.
const ARIA_REFLECTED_ATTRS = {
  role: 'role',
  ariaAtomic: 'aria-atomic',
  ariaAutoComplete: 'aria-autocomplete',
  ariaBusy: 'aria-busy',
  ariaChecked: 'aria-checked',
  ariaColCount: 'aria-colcount',
  ariaColIndex: 'aria-colindex',
  ariaColIndexText: 'aria-colindextext',
  ariaColSpan: 'aria-colspan',
  ariaCurrent: 'aria-current',
  ariaDescription: 'aria-description',
  ariaDisabled: 'aria-disabled',
  ariaExpanded: 'aria-expanded',
  ariaHasPopup: 'aria-haspopup',
  ariaHidden: 'aria-hidden',
  ariaInvalid: 'aria-invalid',
  ariaKeyShortcuts: 'aria-keyshortcuts',
  ariaLabel: 'aria-label',
  ariaLevel: 'aria-level',
  ariaLive: 'aria-live',
  ariaModal: 'aria-modal',
  ariaMultiLine: 'aria-multiline',
  ariaMultiSelectable: 'aria-multiselectable',
  ariaOrientation: 'aria-orientation',
  ariaPlaceholder: 'aria-placeholder',
  ariaPosInSet: 'aria-posinset',
  ariaPressed: 'aria-pressed',
  ariaReadOnly: 'aria-readonly',
  ariaRelevant: 'aria-relevant',
  ariaRequired: 'aria-required',
  ariaRoleDescription: 'aria-roledescription',
  ariaRowCount: 'aria-rowcount',
  ariaRowIndex: 'aria-rowindex',
  ariaRowIndexText: 'aria-rowindextext',
  ariaRowSpan: 'aria-rowspan',
  ariaSelected: 'aria-selected',
  ariaSetSize: 'aria-setsize',
  ariaSort: 'aria-sort',
  ariaValueMax: 'aria-valuemax',
  ariaValueMin: 'aria-valuemin',
  ariaValueNow: 'aria-valuenow',
  ariaValueText: 'aria-valuetext',
  ariaBrailleLabel: 'aria-braillelabel',
  ariaBrailleRoleDescription: 'aria-brailleroledescription'
};
for (const idl of Object.keys(ARIA_REFLECTED_ATTRS)) {
  const attr = ARIA_REFLECTED_ATTRS[idl];
  Object.defineProperty(Element.prototype, idl, {
    configurable: true,
    enumerable: false,
    get() {
      const v = this._attrs[attr];
      return v == null ? null : v;
    },
    set(value) {
      if (value == null) this.removeAttribute(attr);
      else this.setAttribute(attr, String(value));
    }
  });
}

// ARIAMixin element-reference reflection (ARIA 1.3): `ariaActiveDescendantElement`
// reflects a single IDREF; the seven `aria*Elements` reflect IDREF-list
// attributes as a frozen array. Per the spec's "attr-associated element(s)"
// model (verified against Chromium): a value SET through the IDL attribute is
// stored in an internal slot (`_attrElements`) and the content attribute is
// set to the empty string — so `hasAttribute()` is true but `getAttribute()`
// returns '' — and the getter returns the stored element(s). When only the
// content attribute is present (parsed HTML / setAttribute, no IDL assignment),
// the getter resolves its IDREF(s) by id against the document, dropping ids
// with no match. (Real browsers additionally drop stored elements that have
// left a valid scope; we return the stored set verbatim — a bounded
// simplification for an API a11y libraries rarely round-trip.)
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
function __ariaRefDoc(el) {
  return (el && el.ownerDocument) || globalThis.document || null;
}
function __ariaClearSlot(el, idl) {
  if (el._attrElements) delete el._attrElements[idl];
}
function __ariaStoreSlot(el, idl, value) {
  (el._attrElements || (el._attrElements = Object.create(null)))[idl] = value;
}
for (const idl of Object.keys(ARIA_ELEMENT_REF_ATTRS)) {
  const attr = ARIA_ELEMENT_REF_ATTRS[idl];
  Object.defineProperty(Element.prototype, idl, {
    configurable: true,
    enumerable: false,
    get() {
      if (this._attrElements && idl in this._attrElements) return this._attrElements[idl] || null;
      const id = this._attrs[attr];
      if (id == null || id === '') return null;
      const doc = __ariaRefDoc(this);
      return (doc && doc.getElementById(String(id))) || null;
    },
    set(value) {
      if (value == null) { __ariaClearSlot(this, idl); this.removeAttribute(attr); return; }
      __ariaStoreSlot(this, idl, value);
      this.setAttribute(attr, '');
    }
  });
}
for (const idl of Object.keys(ARIA_ELEMENT_REFLIST_ATTRS)) {
  const attr = ARIA_ELEMENT_REFLIST_ATTRS[idl];
  Object.defineProperty(Element.prototype, idl, {
    configurable: true,
    enumerable: false,
    get() {
      if (this._attrElements && idl in this._attrElements) return this._attrElements[idl];
      const raw = this._attrs[attr];
      if (raw == null || raw === '') return null;
      const doc = __ariaRefDoc(this);
      if (!doc) return null;
      const out = [];
      for (const id of String(raw).split(/\s+/)) {
        if (!id) continue;
        const el = doc.getElementById(id);
        if (el) out.push(el);
      }
      return Object.freeze(out);
    },
    set(value) {
      if (value == null) { __ariaClearSlot(this, idl); this.removeAttribute(attr); return; }
      if (typeof value !== 'object' || typeof value[Symbol.iterator] !== 'function') {
        throw new TypeError("Failed to set the '" + idl + "' property on 'Element': The provided value is not iterable.");
      }
      __ariaStoreSlot(this, idl, Object.freeze(Array.from(value)));
      this.setAttribute(attr, '');
    }
  });
}

// `customElementRegistry` — the per-node scoped registry (ARIA / scoped
// custom elements). We have a single global registry, so both Element
// and Document reflect `globalThis.customElements`.
Object.defineProperty(Element.prototype, 'customElementRegistry', {
  configurable: true, enumerable: false,
  get() { return globalThis.customElements || null; }
});

// HTMLFormElement named-properties object. A `<form>` exposes its
// descendant controls by `name`/`id`: `form.foo` (and `el.form.foo`)
// resolve to the matching control — Redmine's column-mover reads
// `this.form.selected_columns` this way.
//
// The form stays a PLAIN object: `el.form === form` identity holds, and
// the cascade/find hot path reads its own fields (`_tag`, `_children`)
// with no Proxy trap. The named getters live on ONE shared prototype,
// `FormNamedProto`, inserted between every form and `Element.prototype`.
// Because all forms share this single prototype object they share ONE
// hidden class, so a hot read like `el._tag` sees just two maps (plain
// element + form) — degree-2 polymorphic, effectively free — instead of
// the megamorphic blow-up a per-form Proxy (exotic object, trap on every
// read) or per-instance accessors (a distinct shape per form) would cause.
// Getters are defined lazily, once per distinct control name, as names are
// seen (`registerFormName`, called from every name/id attribute-write path:
// setAttribute, setAttributeNS, setAttributeNode / Attr#value, and the HTML
// parser); each scans the form's controls at access time.
//
// Known narrow gaps vs a real browser's live named-property object (none hit
// by the app suites or WPT, all preserve the prior proxy's behavior or are
// strictly rarer): (1) `formNamedLookup` scans `form.elements` (descendants),
// so a control associated via `form="<id>"` from OUTSIDE the form subtree is
// reachable as `control.form` but not as `form.<name>`; (2) it returns the
// FIRST same-named control, not a RadioNodeList; (3) names registered only in
// another realm aren't on this realm's FormNamedProto, so a control adopted
// cross-realm (or an XHTML-parsed control) may not expose `form.<name>`.
const FormNamedProto  = Object.create(Element.prototype);
const FORM_NAMED_PROPS = new Set();
const FORM_NAMED_TAGS  = new Set(['input', 'select', 'textarea', 'button', 'fieldset', 'object']);

function formNamedLookup(form, name) {
  if (!form || form._tag !== 'form') return undefined;
  const els = form.elements;
  if (els) for (const c of els) {
    if (c._attrs && (c._attrs.name === name || c._attrs.id === name)) return c;
  }
  return undefined;
}

function registerFormName(el, value) {
  if (!value || !FORM_NAMED_TAGS.has(el._tag)) return;
  if (FORM_NAMED_PROPS.has(value)) return;
  FORM_NAMED_PROPS.add(value);
  // Named access never shadows a built-in form/Element/Node member
  // (`submit`, `length`, `id`, `appendChild`, …): the probe walks
  // FormNamedProto's chain (= Element.prototype), so a name that already
  // resolves there is left alone.
  if (value in FormNamedProto) return;
  Object.defineProperty(FormNamedProto, value, {
    configurable: true, enumerable: false,
    get() { return formNamedLookup(this, value); },
    // Assigning `form.<name> = x` creates an OWN property that shadows the
    // named getter — matching browser LegacyPlatformObject semantics (named
    // properties are configurable). Without a setter, strict-mode assignment
    // to a getter-only property THROWS; jQuery stores its private-data expando
    // directly on the element (`form[expando] = cache`) and also parks its
    // marker on `id`/`name` during scoped queries, so a getter-only named prop
    // would break every form jQuery binds an event to or calls `.data()` on.
    set(v) {
      Object.defineProperty(this, value, { value: v, writable: true, enumerable: true, configurable: true });
    }
  });
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
// Perf (rule 3): the traps only run the O(document) `windowNamedLookup` when the
// name was registered as an id/name AND isn't a real member of the prototype
// chain, so an undefined-global read (feature detection like `typeof Foo`) costs
// one Set.has — never a document walk. The cascade/find hot path reads element
// fields, not globals, so it never touches this chain.
const WINDOW_NAMED_PROPS  = new Set();
const WINDOW_NAME_VALUES  = new Set();   // values seen as a `name` on an exposed tag (gates the lookup scan)
const WINDOW_NAME_TAGS    = new Set(['a', 'applet', 'area', 'embed', 'form', 'frameset', 'frame', 'iframe', 'img', 'object']);

// A browsing-context container matched by its `name` exposes the WindowProxy of
// its nested browsing context as the named-property value, NOT the element —
// `window.<iframeName>` is the child realm's global, so e.g.
// `eventListenerGlobalObject.Object` reaches that realm's intrinsics. This is the
// NAME path only: an iframe matched by `id` resolves to the element (verified
// against Chrome — `window.<iframeId>.contentWindow` must work), so the byId path
// below returns the element unchanged.
function windowNamedValueByName(el) {
  if (el && (el._tag === 'iframe' || el._tag === 'frame')) {
    const cw = el.contentWindow;
    if (cw) return cw;
  }
  return el;
}

function windowNamedLookup(name) {
  const doc = globalThis.document;
  if (!doc) return undefined;
  // `id` matches any element; getElementById returns the first in tree order.
  // An id-matched browsing-context container resolves to the ELEMENT (not its
  // WindowProxy) — only the `name` match below resolves to the content window.
  const byId = doc.getElementById && doc.getElementById(name);
  if (byId) return byId;
  // Otherwise only a name-exposed element can match. Skip the document scan
  // unless this value was actually registered as such a `name`, so a missed
  // or detached id resolves in O(1) instead of an O(document) walk per access.
  if (!WINDOW_NAME_VALUES.has(name)) return undefined;
  let found;
  walkSubtree(doc, el => {
    if (found || el.nodeType !== NODE_ELEMENT) return;
    if (WINDOW_NAME_TAGS.has(el._tag) && el._attrs && el._attrs.name === name) found = el;
  });
  return found ? windowNamedValueByName(found) : undefined;
}

const WindowNamedTarget = Object.getPrototypeOf(globalThis);
// The child browsing contexts (nested <iframe>/<frame>), in tree order — backs
// `window[n]` (indexed access) and `window.length`, mirroring `window.frames`.
function __windowFrameEls() {
  const d = globalThis.document;
  return (d && typeof d.querySelectorAll === 'function') ? d.querySelectorAll('iframe, frame') : EMPTY_NODES;
}
const WindowNamedProps  = new Proxy(WindowNamedTarget, {
  has(target, prop) {
    if (Reflect.has(target, prop)) return true;
    if (typeof prop === 'string') {
      if (prop === 'length') return true;                              // window.length = frame count (>=0)
      if (/^(0|[1-9][0-9]*)$/.test(prop)) return Number(prop) < __windowFrameEls().length;
      if (WINDOW_NAMED_PROPS.has(prop)) return windowNamedLookup(prop) !== undefined;
    }
    return false;
  },
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !Reflect.has(target, prop)) {
      // `window.length` / `window[n]` — the nested browsing contexts. Numeric
      // indexed access returns the n-th frame's contentWindow (== window.frames[n]).
      if (prop === 'length') return __windowFrameEls().length;
      if (/^(0|[1-9][0-9]*)$/.test(prop)) {
        const el = __windowFrameEls()[Number(prop)];
        if (el) return el.contentWindow;
      } else if (WINDOW_NAMED_PROPS.has(prop)) {
        const el = windowNamedLookup(prop);
        if (el !== undefined) return el;
      }
    }
    return Reflect.get(target, prop, receiver);
  },
  getOwnPropertyDescriptor(target, prop) {
    const own = Reflect.getOwnPropertyDescriptor(target, prop);
    if (own) return own;
    if (typeof prop === 'string' && WINDOW_NAMED_PROPS.has(prop)) {
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

function registerWindowName(el, attrName, value) {
  if (!value) return;
  if (attrName === 'name') {
    if (!WINDOW_NAME_TAGS.has(el._tag)) return;   // name exposes only certain tags
    WINDOW_NAME_VALUES.add(value);
  }
  // Just gate the name; existence and value are resolved live by the Proxy
  // traps against the current document, never frozen into a getter.
  WINDOW_NAMED_PROPS.add(value);
}

// Single entry point for every name/id attribute-write path: a control's
// name/id feeds BOTH its form's named access (FormNamedProto) and the window
// named-properties object (WindowNamedProps).
function registerNamedAccess(el, attrName, value) {
  registerFormName(el, value);
  registerWindowName(el, attrName, value);
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
  get innerHTML()    { return isHtmlDocument(this.ownerDocument) ? serializeChildren(this) : xmlSerializeInner(this); }
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
    const isHtml = isHtmlDocument(this.ownerDocument);
    const parsed = isHtml
      ? parseFragment(String(html === null ? '' : html), this)
      : parseXmlFragment(html, this);   // throws SyntaxError before mutating
    const doc = this.ownerDocument;
    for (const c of removed) { c._parent = null; unregisterSubtree(c); }
    this._children = newChildList();
    const added = [];
    for (const c of parsed) {
      if (!isHtml) doc.adoptNode(c);   // own the parsed XML nodes to the XML document
      c._parent = this;
      this._children.push(c);
      registerSubtree(c);
      added.push(c);
    }
    if (removed.length > 0 || added.length > 0) {
      recordChildList(this, added, removed);
    }
  }
  querySelector(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelector': 1 argument required, but only 0 present.");
    return selectFirst(this._children, sel, this);
  }
  querySelectorAll(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelectorAll': 1 argument required, but only 0 present.");
    return nodeList(selectAll(this._children, sel, this));
  }
  getElementById(id)    { return findById(this, id); }
  // `getElementsByTagName('*')` on a context node must work for a
  // ShadowRoot too — inherit Element's behaviour so a ShadowRoot
  // context resolves
  // `.//*[@id=…]` against its own subtree.
  getElementsByTagName(tag) {
    const t = String(tag).toLowerCase();
    return liveHTMLCollection(() => {
      const all = t === '*' ? this.querySelectorAll('*') : this.querySelectorAll(t);
      return all.filter(n => n !== this);
    });
  }
  getElementsByClassName(cls) { return liveHTMLCollection(() => collectByClassName(this, cls)); }
}
globalThis.DocumentFragment = DocumentFragment;

// ShadowRoot: a DocumentFragment that lives as a sibling tree off
// a host Element. Same query API (`querySelector` / `getElementById`)
// as Element; queries from outside the shadow tree don't descend in.
// Internal token gating ShadowRoot construction — script-side `new ShadowRoot()`
// is illegal per WebIDL (the interface has no constructor); only attachShadow
// may build one, by passing this private token.
const SHADOW_ROOT_INTERNAL = {};
class ShadowRoot extends DocumentFragment {
  constructor(host, mode, token) {
    if (token !== SHADOW_ROOT_INTERNAL) throw new TypeError('Illegal constructor');
    super();
    this.host = host;
    this.mode = mode || 'open';
    // Cheap boundary marker the event dispatcher / composedPath test
    // for, so they can detect a shadow boundary without importing this
    // class (keeps the hot dispatch path free of a cross-module ref).
    this._isShadowRoot = true;
    // Shadow-tree descendants need an upward path so `isConnected`
    // and ancestor walks land back in the document. Use the host
    // as the "parent" of the shadow root itself; descendants
    // inside the shadow root have their _parent pointing inside
    // the shadow tree as usual.
    this._parent = host;
  }
  // A ShadowRoot is a DocumentFragment, so its nodeName is "#document-fragment"
  // (DOM: nodeName for a DOCUMENT_FRAGMENT_NODE), NOT "#shadow-root" — inherit
  // DocumentFragment's. (Kept explicit for clarity; matches WPT.)
  get nodeName() { return '#document-fragment'; }
  // A shadow root has no parent in the node tree — `parentNode` / `parentElement`
  // are always null (its host is reached via `.host`, not as a parent). The
  // internal `_parent` slot still points at the host so the event-dispatch walk
  // and isConnected climb across the boundary; only the public accessors hide it.
  get parentNode()    { return null; }
  get parentElement() { return null; }
  // A shadow root's node document is its host's node document (DOM: the shadow
  // root is created in the host's document). This also drives adoption — a node
  // inserted into the shadow tree is adopted into the host's document, since
  // adoptIntoParent reads the parent's ownerDocument.
  get ownerDocument() { return this.host ? this.host.ownerDocument : (this._ownerDoc || globalThis.document); }
  // The slot-assignment mode chosen at attachShadow time ('named' | 'manual').
  get slotAssignment() { return this._slotAssignment || 'named'; }
  // Whether cloneNode of the host duplicates this shadow tree (attachShadow
  // `clonable`); declarative shadow roots opt in via `shadowrootclonable`.
  get clonable() { return !!this._clonable; }
  // Whether focus delegates into the tree (attachShadow `delegatesFocus` /
  // declarative `shadowrootdelegatesfocus`) and whether getHTML serializes it
  // (`shadowrootserializable`). `_delegatesFocus` is modeled behaviourally —
  // Element#focus/#blur and the `:focus` matcher act on it (see firstFocusDelegate);
  // the flags also reflect for DSD round-trips + feature detection.
  get delegatesFocus() { return !!this._delegatesFocus; }
  get serializable()   { return !!this._serializable; }
  // `ShadowRoot.getHTML(options)` serializes the shadow tree's children, with
  // nested serializable shadow roots emitted as `<template shadowrootmode>`.
  // (Defined here, not on DocumentFragment — a plain fragment has no getHTML.)
  getHTML(options) {
    if (!isHtmlDocument(this.ownerDocument)) return this.innerHTML;
    return serializeChildrenWithShadow(this, normalizeGetHTMLOptions(options));
  }
  // `ShadowRoot.setHTMLUnsafe` parses like innerHTML and ALSO converts nested
  // declarative shadow roots (`innerHTML` does not), mirroring Element.
  setHTMLUnsafe(markup) {
    this.innerHTML = String(markup == null ? '' : markup);
    processDeclarativeShadowRoots(this);
  }
  // DocumentOrShadowRoot.adoptedStyleSheets — constructed CSSStyleSheets
  // adopted into this shadow tree (also populated declaratively from a
  // `<template shadowrootadoptedstylesheets>` attribute at parse time).
  get adoptedStyleSheets()  { return this._adoptedStyleSheets || (this._adoptedStyleSheets = []); }
  set adoptedStyleSheets(v) {
    this._adoptedStyleSheets = normalizeAdoptedStyleSheets(v);
    this._scopedRules = null;   // invalidate the shadow cascade's cached rule set
  }
  // DocumentOrShadowRoot.activeElement: the focused element RETARGETED against
  // this shadow tree (HTML "retarget"). If the focus lives directly in this tree
  // → that element; if it lives in a DESCENDANT shadow tree → the host in this
  // tree that contains it (so `innermostActiveElement` can descend host-by-host);
  // if it's elsewhere (light DOM / another tree) → null.
  get activeElement() {
    const ae = globalThis.document && globalThis.document._activeElement;
    if (!ae || !ae.isConnected) return null;
    for (let node = ae; node; ) {
      const root = enclosingShadowRoot(node);
      if (root === this) return node;   // directly in this tree (or the host we ascended to)
      if (!root) return null;           // reached light DOM / a different document
      node = root.host;                 // ascend to the host (which lives in the parent tree)
    }
    return null;
  }
  // DocumentOrShadowRoot.styleSheets: a StyleSheetList of the CSSStyleSheets of
  // the <style>/<link> elements in this tree (the element's own `.sheet`, so
  // identity matches; null — hence empty — while the root is disconnected).
  get styleSheets() {
    const list = [];
    walkSubtree(this, (n) => {
      if (n.nodeType === NODE_ELEMENT && (n._tag === 'style' || n._tag === 'link')) {
        const s = n.sheet;
        if (s) list.push(s);
      }
    });
    list.item = (i) => list[i] || null;
    return list;
  }
}
globalThis.ShadowRoot = ShadowRoot;

// ── ElementInternals (HTML custom-element internals) ────────────────
// Returned by `HTMLElement.attachInternals()`. Two capabilities matter for
// in-process suites: exposing the element's shadow root (even a CLOSED one —
// every root we create, imperative or declarative, is "available to element
// internals"), and the form-associated surface. The form members throw
// NotSupportedError unless the element's definition is `static formAssociated
// = true`, per spec. ARIA reflection (`role` / `aria*`) is left as plain
// property storage — assignment works, it just isn't mirrored to the host
// (nothing in scope reads it back off the element).
const ELEMENT_INTERNALS_INTERNAL = Symbol('ElementInternals');
class ElementInternals {
  constructor(target, token) {
    // WebIDL: ElementInternals has no constructor — script `new` is illegal.
    if (token !== ELEMENT_INTERNALS_INTERNAL) {
      throw new globalThis.TypeError('Illegal constructor');
    }
    this._target = target;
    const ctor = target._ns === HTML_NS ? getCustomElementCtor(target._localName) : null;
    this._formAssociated   = !!(ctor && ctor.formAssociated === true);
    this._validationMessage = '';
    this._states = new Set();
  }
  // DocumentOrShadowRoot exposure: returns the (open OR closed) shadow root the
  // element hosts. `Element.shadowRoot` hides a closed root; this does not.
  get shadowRoot() {
    return this._target && this._target._shadowRoot ? this._target._shadowRoot : null;
  }
  _requireFormAssociated(member) {
    if (!this._formAssociated) {
      throw new globalThis.DOMException("Failed to execute '" + member + "' on 'ElementInternals': The target element is not a form-associated custom element.", 'NotSupportedError');
    }
  }
  get form() { this._requireFormAssociated('form'); return formForControl(this._target) || null; }
  // Value submission isn't modeled (FormData collects only the built-in
  // controls), so this records nothing — matching the pre-existing behavior
  // where a form-associated CE's value never reached a submission anyway.
  setFormValue() { this._requireFormAssociated('setFormValue'); }
  setValidity(flags, message) {
    this._requireFormAssociated('setValidity');
    const invalid = !!(flags && Object.keys(flags).some((k) => k !== 'valid' && flags[k]));
    this._validationMessage = invalid ? String(message == null ? '' : message) : '';
  }
  get willValidate()        { this._requireFormAssociated('willValidate'); return true; }
  get validationMessage()   { this._requireFormAssociated('validationMessage'); return this._validationMessage; }
  get validity() {
    this._requireFormAssociated('validity');
    const customError = !!this._validationMessage;
    return {
      valueMissing: false, typeMismatch: false, patternMismatch: false,
      tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false,
      stepMismatch: false, badInput: false, customError, valid: !customError
    };
  }
  get labels()       { this._requireFormAssociated('labels'); return nodeList([]); }
  checkValidity()    { this._requireFormAssociated('checkValidity'); return !this._validationMessage; }
  reportValidity()   { this._requireFormAssociated('reportValidity'); return this.checkValidity(); }
  // CustomStateSet — a real Set is close enough for `:state()` consumers that
  // only add/has/delete (we don't model the `:state()` pseudo-class match).
  get states() { return this._states; }
}
globalThis.ElementInternals = ElementInternals;

// ── Slot assignment (DOM §"assigning slottables and slots") ─────────
// Named-slot assignment, computed lazily on read (assignedSlot /
// assignedNodes / assignedElements walk the host's light children and the
// shadow tree's slots fresh each time — these are not hot paths and lazy
// keeps them correct regardless of which mutation path ran). The eager work
// is limited to slotchange signaling: on the two mutation chokepoints
// (recordChildList / recordAttrMutation) we recompute the affected shadow
// root's slot assignments and signal any whose assigned-node set changed.
//
// Performance (rule 3): every hook short-circuits on `shadowHostCount` — a
// page that never calls attachShadow pays one hook call that returns on a
// single integer check, and nothing else. When shadow roots DO exist, a
// light-DOM mutation costs one O(1) `target._shadowRoot` check plus a scan of
// the (small) added/removed sets for a <slot>; the ancestor walk to find an
// enclosing shadow root happens only when a slot was actually inserted /
// removed / moved. `shadowHostCount` only rises — a host removed mid-page
// keeps the hooks live — but `visit()` rebuilds the VM per page, so a
// shadow-free page starts (and stays) at zero.
let shadowHostCount = 0;

// Elements that may host a shadow tree (HTML "valid shadow host name"): the
// fixed safelist plus a custom-element name, approximated as an HTML-namespace
// tag containing a hyphen (a fuller PotentialCustomElementName check — reserved
// hyphenated names, leading digit — would only matter for adversarial names no
// app uses). attachShadow throws NotSupportedError for anything else.
const SHADOW_HOST_TAGS = new Set([
  'article', 'aside', 'blockquote', 'body', 'div', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span'
]);
// A custom-element definition whose `static disabledFeatures` includes "shadow"
// cannot host a shadow root (HTML attachShadow step). Both an imperative
// attachShadow and a declarative `<template shadowrootmode>` must respect it.
function ctorDisablesShadow(ctor) {
  if (!ctor) return false;
  let df; try { df = ctor.disabledFeatures; } catch (_) { df = null; }
  return !!(df && typeof df.indexOf === 'function' && df.indexOf('shadow') !== -1);
}
function canAttachShadow(el) {
  if (el._ns !== HTML_NS) return false;
  const ln = el._localName;
  if (ln.indexOf('-') !== -1) {
    // Autonomous custom element: keyed by its local name.
    if (ctorDisablesShadow(getCustomElementCtor(ln))) return false;
    return true;
  }
  // Customized built-in (`<h2 is="…">`): keyed by its `is` value's definition.
  // `_isValue` is the slot set by createElement({is}); fall back to the `is`
  // content attribute so a PARSED or CLONED customized built-in (whose is value
  // is carried by the attribute, copied on clone) is gated too. Safe here because
  // this branch is non-hyphenated names only — an autonomous CE (hyphenated) took
  // the branch above and never reaches a stray `is=`.
  const isValue = el._isValue || (el._attrs && el._attrs.is);
  if (isValue && ctorDisablesShadow(getCustomElementCtor(isValue))) return false;
  return SHADOW_HOST_TAGS.has(ln);
}

// Coerce an assignment to `adoptedStyleSheets` into a plain array of
// CSSStyleSheet objects (spec validates each member is a constructed sheet;
// we accept anything sheet-shaped and drop the rest rather than throw, since
// nothing downstream depends on strict typing).
// Coerce a `getHTML(options)` argument to the two fields the serializer reads.
function normalizeGetHTMLOptions(options) {
  return {
    serializableShadowRoots: !!(options && options.serializableShadowRoots),
    shadowRoots: options && Array.isArray(options.shadowRoots) ? options.shadowRoots : null
  };
}
function normalizeAdoptedStyleSheets(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : (typeof v.length === 'number' ? Array.prototype.slice.call(v) : []);
  return arr.filter(s => s && typeof s.replaceSync === 'function');
}

// Build a CSSStyleSheet from a `shadowrootadoptedstylesheets` specifier:
// resolve it via the import map (bare specifier → mapped URL) or as a URL,
// fetch the CSS text (inline data: URL decoded directly; otherwise a sync
// Rack fetch), and `replaceSync` it. Returns null on any failure so a bad
// specifier is skipped rather than throwing during parse.
function sheetFromSpecifier(specifier, baseURL) {
  try {
    const map = globalThis.__csim_importmap;
    let raw = (map && map.imports && map.imports[specifier]) || specifier;
    let css = null;
    // A data: URL is decoded from the RAW specifier (not the parser's
    // re-serialized href, which percent-encodes the inline body and would
    // corrupt base64 / break the decode). Percent-decode only well-formed
    // `%XX` escapes so a literal `%` (e.g. a CSS `50%`) stays intact instead
    // of throwing — matching how browsers decode data: bodies.
    const dm = /^data:[^,]*?(;base64)?,([\s\S]*)$/i.exec(raw);
    if (dm) {
      css = dm[1]
        ? (globalThis.atob ? globalThis.atob(dm[2].replace(/\s+/g, '')) : '')
        : dm[2].replace(/%[0-9A-Fa-f]{2}/g, m => { try { return decodeURIComponent(m); } catch (_) { return m; } });
    } else if (typeof globalThis.__rackFetch === 'function') {
      // Otherwise resolve relative URLs against the document base and fetch.
      let url = raw;
      try {
        const base = baseURL || (globalThis.location && globalThis.location.href) || null;
        const u = globalThis.__csim_parseUrl(url, base);
        if (u && !u.error) url = u.href;
      } catch (_) { /* keep the raw specifier */ }
      const resp = globalThis.__rackFetch('GET', url, '', null, 'follow');
      css = resp && resp.body != null ? String(resp.body) : '';
    }
    if (css == null) return null;
    const sheet = new globalThis.CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet;
  } catch (_) { return null; }
}

// Declarative Shadow DOM: convert each `<template shadowrootmode=open|closed>`
// in `root`'s subtree into a real shadow root on its parent (the host),
// moving the template's content into the shadow tree and removing the
// template. Per the HTML parser's "attach a shadow root" steps this runs only
// for trusted parsing (main-document parse + `setHTMLUnsafe` / `parseHTMLUnsafe`)
// — NOT for `innerHTML` / `insertAdjacentHTML`, which leave the template intact.
// A template that doesn't convert (invalid mode, host already hosts a shadow
// tree, or a host that can't attach one) is left untouched, but its content is
// still scanned for nested declarative shadow roots. The walk runs before the
// tree is connected, so slot assignment happens later on connect as usual.
// `contextEl` is the fragment-parsing context element — the node a top-level
// `setHTMLUnsafe`/`innerHTML` was invoked on. Per HTML's DSD tree-construction
// (verified against Chrome), that element is NEVER a declarative shadow host for
// its own direct `<template shadowrootmode>` children: such a template parses as
// a child of the synthetic fragment root (discarded), not of the context, so it
// is moved over as a plain template. Only a *parsed descendant* element hosts a
// declarative shadow. This matters for void hosts: `el.setHTMLUnsafe('<br><template
// shadowrootmode=open>…')` leaves `<br>` childless, so the template lands directly
// under the context element and must stay a template — not become its shadow.
// The exemption is the top-level call's concern only; recursion passes no context
// (every descendant is a legitimate host).
// Convert ONE `<template shadowrootmode>` (the DSD opt-in) into a real shadow
// root on its host, moving the template's content into it. A no-op (leaving the
// template in place) when the host can't host a shadow — invalid host, already a
// host, mode mismatch, or moved off a valid parse-time parent. Shared by the
// post-parse walk below and the streaming parser's `onItemPop`, which calls this
// the instant a `</template>` closes so a following parse-time script sees
// `host.shadowRoot` already populated (declarative-shadow-dom-basic.html et al).
export function convertDeclarativeTemplate(node, contextEl = null) {
  const ma   = node._attrs.shadowrootmode;
  const mode = ma == null ? '' : asciiLower(String(ma));
  // Attach to the parent the template had WHEN PARSED. "Moving the template
  // doesn't change attachment point" (move-template-before-closing-tag.html): a
  // streaming parse-time script (or MutationObserver) can move the template off
  // its parent before conversion, but the shadow still attaches to the original
  // parent — and never attaches if that parent wasn't a valid host (video → div).
  // `_dsdOriginalParent` is pinned at parse time by the parse5 adapter; absent
  // (non-streaming / innerHTML / setHTMLUnsafe fragment) → the current parent.
  const host = node._dsdOriginalParent || node._parent;
  let sr = null;
  if ((mode === 'open' || mode === 'closed') && host && host.nodeType === NODE_ELEMENT && host !== contextEl && !host._shadowRoot && canAttachShadow(host)) {
    try {
      sr = host.attachShadow({
        mode,
        delegatesFocus: node._attrs.shadowrootdelegatesfocus != null,
        clonable:       node._attrs.shadowrootclonable != null,
        serializable:   node._attrs.shadowrootserializable != null,
        // `shadowrootslotassignment="manual"` opts the declarative root into
        // manual slot assignment (default "named"); case-insensitive.
        slotAssignment: String(node._attrs.shadowrootslotassignment || '').toLowerCase() === 'manual' ? 'manual' : 'named'
      });
    } catch (_) { sr = null; }   // unsupported host → leave the template as-is
    if (sr) sr._declarative = true;   // a re-attachShadow of the same mode reuses it
  }
  if (sr) {
    const content = node._templateContent;
    if (content) {
      for (const c of content._children.slice()) { c._parent = sr; sr._children.push(c); }
      content._children.length = 0;
    }
    // Remove the template from its CURRENT parent — a parse-time script may have
    // moved it off `host` (the original parent) before this conversion.
    const cur = node._parent;
    if (cur) { const i = cur._children.indexOf(node); if (i >= 0) cur._children.splice(i, 1); }
    // Drop the now-detached template's handle (the setHTMLUnsafe path
    // registered it via innerHTML; the main-doc path never did, so this
    // is a no-op there), then register the shadow tree so Ruby-side
    // find/lookup resolves nodes inside it — registerSubtree / the connect
    // walk only descend `_children`, never `_shadowRoot`, and attachShadow
    // registered an empty root. Upgrade any custom elements now in the
    // shadow tree (connectedCallback for shadow-resident elements is a
    // known gap shared with imperative disconnected-shadow population).
    unregisterSubtree(node);
    node._parent = null;
    registerSubtree(sr);
    ceUpgradeTree(sr);
    // Declarative adoptedStyleSheets: resolve each space-separated
    // specifier in `shadowrootadoptedstylesheets` to a CSSStyleSheet.
    const adopt = node._attrs.shadowrootadoptedstylesheets;
    if (adopt != null && String(adopt).trim() !== '') {
      const base = host.ownerDocument && host.ownerDocument._url;
      const sheets = [];
      for (const spec of String(adopt).split(/\s+/)) {
        if (!spec) continue;
        const s = sheetFromSpecifier(spec, base);
        if (s) sheets.push(s);
      }
      if (sheets.length) sr.adoptedStyleSheets = sheets;
    }
    processDeclarativeShadowRoots(sr);   // nested declarative shadow roots
    return;
  }
  // Not converted: still scan the inert content for nested declarative roots.
  if (node._templateContent) processDeclarativeShadowRoots(node._templateContent);
}

export function processDeclarativeShadowRoots(root, contextEl = null) {
  if (!root || !root._children) return;
  for (const node of root._children.slice()) {
    if (node.nodeType !== NODE_ELEMENT) continue;
    if (node._tag === 'template' && node._ns === HTML_NS) {
      convertDeclarativeTemplate(node, contextEl);
      continue;
    }
    processDeclarativeShadowRoots(node);
    if (node._shadowRoot) processDeclarativeShadowRoots(node._shadowRoot);
  }
}

// A slottable is an Element or a Text node. Its "name" is the `slot`
// content attribute (Text is always the empty name → the default slot).
function isSlottable(node) {
  return node && (node.nodeType === NODE_ELEMENT || node.nodeType === NODE_TEXT);
}
function slottableName(node) {
  return node.nodeType === NODE_ELEMENT ? (node._attrs.slot || '') : '';
}
// The shadow root that `node` is a descendant of (or is), else null.
function enclosingShadowRoot(node) {
  for (let n = node; n; n = n._parent) {
    if (n._isShadowRoot) return n;
  }
  return null;
}
// True iff `el` is an HTML <slot>. A foreign-namespace element whose local
// name happens to be "slot" (SVG `createElementNS`) does NOT participate in
// slot assignment, so the namespace check is load-bearing, not cosmetic.
function isHtmlSlot(el) {
  return el._tag === 'slot' && el._ns === HTML_NS;
}
// Walk `sr` once, building name → first-in-tree-order <slot>. This is the
// single "which slot owns name N" source: per-child and per-slot callers look
// up the map instead of re-walking the shadow tree, keeping reassignment
// O(tree + lightChildren) rather than O(slots × lightChildren × tree) (rule 3).
function slotNameMap(sr) {
  const map = new Map();
  walk(sr, el => {
    if (!isHtmlSlot(el)) return;
    const n = el._attrs.name || '';
    if (!map.has(n)) map.set(n, el);
  });
  return map;
}
// The slot `node` is assigned to, per "find a slot". `openOnly` mirrors the
// `assignedSlot` getter's open flag (a slot in a closed shadow tree is hidden).
// A manual-assignment shadow root never auto-assigns by name — assignment is
// driven by slot.assign() (not yet modeled), so slottables resolve to no slot.
function findSlotForSlottable(node, openOnly) {
  const parent = node._parent;
  if (!parent) return null;
  const sr = parent._shadowRoot;
  if (!sr) return null;
  if (openOnly && sr.mode !== 'open') return null;
  if (sr.slotAssignment === 'manual') {
    // Manual mode: the slot is whatever slot.assign() pointed this node at, but
    // only when that slot actually lives in this host's shadow root (moving the
    // slot out, or the node to another host, hides the assignment — computed
    // live, the stored pointer persists). See [[shadow-dom-campaign]] inc3.
    const slot = node._manualSlot;
    return slot && enclosingShadowRoot(slot) === sr ? slot : null;
  }
  return slotNameMap(sr).get(slottableName(node)) || null;
}
// Mode-agnostic slot lookup for the cascade's `::slotted` matching (the public
// `assignedSlot` is open-only; styling must not depend on shadow-root mode).
// Exposed as a global so cascade.js can call it without importing dom-nodes
// (which would create an import cycle).
globalThis.__csimSlotForStyling = function (node) { return findSlotForSlottable(node, false); };
// "Find slottables" for a slot (named mode): the host's light children that
// resolve to THIS slot (i.e. this is the first slot matching their name), in
// tree order. A slot outside a shadow tree — or in a manual shadow root — has
// no slottables.
function findSlottables(slot) {
  const sr = enclosingShadowRoot(slot);
  if (!sr) return [];
  if (sr.slotAssignment === 'manual') return manualSlottablesForSlot(sr, slot);
  return slottablesForSlot(sr, slot, slotNameMap(sr));
}

// ── Sequential focus navigation (HTML "sequential navigation search algorithm",
// flattened across the shadow / slot tree) ──────────────────────────────────
// Tab / Shift-Tab move focus through the page in tabindex order. Within each
// focus scope (the document, a shadow root, or a slot's assigned nodes) the
// candidates are ordered by tabindex — positive values ascending (stable by
// flat-tree preorder), then 0/auto in preorder — and a scope owner (shadow host
// or slot) has its sub-scope traversed at its own position (right after the host
// itself, which is a stop when focusable). Negative tabindex is click-focusable
// but skipped by sequential navigation. This is real-browser behaviour: pressing
// Tab moves focus regardless of how the key event was synthesised.
function __seqIsCEHost(el) {
  const ce = el._attrs.contenteditable;
  return ce != null && String(ce).toLowerCase() !== 'false';
}
// Classify an element as a sequential-focus ITEM within its scope, per the HTML
// "sequential navigation search algorithm" (recursive over focus scopes, NOT a
// single flat list). Returns null for a plain element we descend through but
// don't collect. An item is:
//   kind 'stop'  — a leaf focus stop;
//   kind 'owner' — a scope owner that is NOT itself a stop (a slot, a
//                  delegatesFocus host, or a non-focusable / negative host);
//   kind 'both'  — a focusable non-delegating non-negative host: a stop AND owner.
// `sub` (the owner's built sub-scope) is ALWAYS built, even when excluded, so
// focus scripted into a tabindex=-1 host's shadow tree is still navigable.
// `included` = whether the owner's sub-scope joins the GLOBAL order: false for a
// negative-tabindex host AND a negative-tabindex slot (entered only from inside).
function __seqClassify(el) {
  const sr = el._shadowRoot, isHost = !!sr, isSlot = isHtmlSlot(el);
  let n = null;
  const ti = el._attrs.tabindex;
  if (ti != null) { const p = parseInt(ti, 10); if (!isNaN(p)) n = p; }
  const negative = n != null && n < 0;
  if (isSlot) {
    // A negative-tabindex slot is excluded like a negative host — not a stop AND
    // its assigned sub-scope is dropped from the global order.
    return { el, kind: 'owner', sub: __seqBuildSlotScope(el), included: !negative, group: negative ? 0 : (n != null ? n : 0) };
  }
  if (isHost) {
    const sub = __seqBuildScope('host', el, sr._children);
    // A delegatesFocus host is NEVER its own sequential stop, whatever its tabindex.
    const stop = !sr._delegatesFocus && !negative && isFocusable(el);
    return { el, kind: stop ? 'both' : 'owner', sub, included: !negative, group: negative ? 0 : (n != null ? n : 0) };
  }
  if (negative) return null;          // plain negative: descend children, not a stop
  if (!isFocusable(el)) return null;
  return { el, kind: 'stop', group: n != null ? n : 0 };
}
// Build the focus scope rooted at `nodes` (a shadow root's children, a slot's
// assigned nodes, or the document's children). `tree` keeps the candidates in
// flat-tree PREORDER (load-bearing: __seqStepFromTreePos resumes after an
// excluded owner by tree-nearest, which preorder index distance gives); `items`
// is the same candidates in TABINDEX order (positives ascending stable, then
// group 0) and drives normal stepping.
function __seqBuildScope(owner, ownerEl, nodes) {
  const tree = [];
  const visit = (el) => {
    const c = __seqClassify(el);
    if (c) { c.treePos = tree.length; tree.push(c); }
    // Descend in-scope only through non-owners that aren't CE hosts (same gate as
    // the old __seqGather): an owner's contents are a sub-scope, not this scope.
    if ((!c || (c.kind !== 'owner' && c.kind !== 'both')) && !__seqIsCEHost(el) && el._children) {
      for (let i = 0; i < el._children.length; i++) {
        if (el._children[i].nodeType === NODE_ELEMENT) visit(el._children[i]);
      }
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === NODE_ELEMENT) visit(nodes[i]);
  }
  const pos = [], zer = [];
  for (let i = 0; i < tree.length; i++) (tree[i].group > 0 ? pos : zer).push(tree[i]);
  pos.sort((a, b) => a.group - b.group);   // stable → preorder ties preserved
  return { owner, ownerEl, items: pos.concat(zer), tree };
}
function __seqBuildSlotScope(slot) {
  const a = findSlottables(slot);
  return __seqBuildScope('slot', slot, a.length ? a : (slot._children || EMPTY_NODES));
}
function __seqBuildDocScope() {
  const d = globalThis.document;
  return (d && d._children) ? __seqBuildScope('document', null, d._children)
                            : { owner: 'document', ownerEl: null, items: [], tree: [] };
}
// Flatten a scope tree to the public global focus order (debug / the WPT gate).
// Same output as the old __seqEmit except the two classification fixes.
function __seqFlatten(scope, out) {
  for (let i = 0; i < scope.items.length; i++) {
    const it = scope.items[i];
    if (it.kind === 'stop' || it.kind === 'both') out.push(it.el);
    if ((it.kind === 'owner' || it.kind === 'both') && it.included && it.sub) __seqFlatten(it.sub, out);
  }
  return out;
}
// The document's sequential focus navigation order — the flat list of focus
// stops Tab visits, in order. (Kept for debugging; the hot Tab path computes the
// next stop scope-relatively in __csimAdvanceFocus without flattening.)
globalThis.__csimSequentialFocusOrder = function () {
  return __seqFlatten(__seqBuildDocScope(), []);
};
// First (or last, reverse) reachable stop strictly INSIDE a scope, descending
// included owners. Used when entering a scope.
function __seqEdgeStop(scope, reverse) {
  const it = scope.items;
  const lo = reverse ? it.length - 1 : 0, hi = reverse ? -1 : it.length, st = reverse ? -1 : 1;
  for (let i = lo; i !== hi; i += st) {
    const x = it[i];
    if (!reverse && (x.kind === 'stop' || x.kind === 'both')) return x.el;
    if (x.sub && x.included) { const e = __seqEdgeStop(x.sub, reverse); if (e) return e; }
    if (reverse && (x.kind === 'stop' || x.kind === 'both')) return x.el;
  }
  return null;
}
// Step within one scope from a known item index. skipOwnSub=false: we just
// LANDED on items[idx], so forward must first descend its own sub-scope.
// skipOwnSub=true: we just EXITED items[idx]'s sub-scope, so resume past it.
function __seqStepInScope(scope, idx, reverse, skipOwnSub) {
  const it = scope.items;
  if (!reverse) {
    if (!skipOwnSub) {
      const c = it[idx];
      if (c && c.kind === 'both' && c.included && c.sub) { const e = __seqEdgeStop(c.sub, false); if (e) return e; }
    }
    for (let i = idx + 1; i < it.length; i++) {
      const x = it[i];
      if (x.kind === 'stop' || x.kind === 'both') return x.el;
      if (x.sub && x.included) { const e = __seqEdgeStop(x.sub, false); if (e) return e; }
    }
    return null;
  }
  if (skipOwnSub) { const c = it[idx]; if (c && c.kind === 'both') return c.el; }  // land back ON the owner-stop
  for (let i = idx - 1; i >= 0; i--) {
    const x = it[i];
    if (x.sub && x.included) { const e = __seqEdgeStop(x.sub, true); if (e) return e; }
    if (x.kind === 'stop' || x.kind === 'both') return x.el;
  }
  return null;
}
// Resume after an EXCLUDED owner (tabindex=-1 host/slot) by TREE position: the
// nearest suitable stop after (forward) / before (reverse) the owner in flat-tree
// order. `tree` is preorder, so the first match is the tree-nearest.
function __seqStepFromTreePos(scope, treePos, reverse) {
  const t = scope.tree;
  const lo = reverse ? treePos - 1 : treePos + 1, hi = reverse ? -1 : t.length, st = reverse ? -1 : 1;
  for (let i = lo; i !== hi; i += st) {
    const x = t[i];
    if (x.kind === 'stop' || x.kind === 'both') {
      if (!reverse) return x.el;                       // forward: nearest stop AFTER the owner
      if (x.sub && x.included) { const e = __seqEdgeStop(x.sub, true); if (e) return e; }
      return x.el;
    }
    if (x.sub && x.included) { const e = __seqEdgeStop(x.sub, reverse); if (e) return e; }
  }
  return null;
}
function __seqFindItem(scope, el)    { for (const x of scope.tree)  if (x.el === el) return x; return null; }
function __seqIndexOfItem(scope, el) { for (let i = 0; i < scope.items.length; i++) if (scope.items[i].el === el) return i; return -1; }
// Locate `el` as an item anywhere in the scope tree (included AND excluded subs),
// returning the chain of scopes from the document down to it + its item index.
function __seqLocate(scope, el, chain) {
  chain.push(scope);
  for (let i = 0; i < scope.items.length; i++) {
    const it = scope.items[i];
    if (it.el === el) return { chain, idx: i };
    if (it.sub) { const h = __seqLocate(it.sub, el, chain); if (h) return h; }
  }
  chain.pop();
  return null;
}
// Step outward scope-by-scope from a located item: try this scope, then resume
// past each enclosing owner (in tabindex order if it's included, else by tree
// position) until a stop is found or the document edge is reached.
function __seqStepFromChain(chain, idx, reverse) {
  let scope = chain[chain.length - 1];
  const curItem = scope.items[idx];
  // If the focused element is ITSELF an excluded owner (a script/click-focused
  // tabindex=-1 host/slot), it isn't part of the sequential order — resume by its
  // flat-tree position, not its tabindex-items position (which the positive-
  // tabindex sort can move out of tree order).
  let next = (curItem && curItem.kind === 'owner' && !curItem.included)
    ? __seqStepFromTreePos(scope, curItem.treePos, reverse)
    : __seqStepInScope(scope, idx, reverse, false);   // just landed → descend own sub first
  if (next) return next;
  for (let i = chain.length - 2; i >= 0; i--) {
    const parent = chain[i];
    const ownerItem = __seqFindItem(parent, scope.ownerEl);
    if (ownerItem) {
      next = ownerItem.included
        ? __seqStepInScope(parent, __seqIndexOfItem(parent, scope.ownerEl), reverse, true)
        : __seqStepFromTreePos(parent, ownerItem.treePos, reverse);
      if (next) return next;
    }
    scope = parent;
  }
  return null;   // document edge → caller wraps
}
// True iff the flat focus order is itself in document (tree) order — i.e. no
// positive-tabindex reordering moved a stop out of tree position.
function __seqOrderInDocumentOrder(flat) {
  for (let i = 1; i < flat.length; i++) if (compareDocOrder(flat[i - 1], flat[i]) > 0) return false;
  return true;
}
// `cur` is focused but is NOT a sequential-focus item (a non-focusable element, a
// plain tabindex=-1 element, a disabled control, or a non-stop node inside a
// 'both' / CE-host stop). Resume from its flat-tree DOCUMENT POSITION: the first
// stop after it (forward) / the last stop before it (backward) in the global
// order. compareDocOrder follows the ShadowRoot→host chain, so a focused
// shadow-internal node compares at its host's flat-tree position. Only valid when
// the order is itself in document order: positive tabindex reorders it and then
// document position can't locate the continuation — return null so the caller
// wraps (no worse than the old behavior).
function __seqStepFromDocPosition(root, cur, reverse) {
  const flat = __seqFlatten(root, []);
  if (!flat.length || !__seqOrderInDocumentOrder(flat)) return null;
  if (reverse) {
    let pick = null;
    for (let i = 0; i < flat.length; i++) if (compareDocOrder(flat[i], cur) < 0) pick = flat[i];
    return pick;
  }
  for (let i = 0; i < flat.length; i++) if (compareDocOrder(cur, flat[i]) < 0) return flat[i];
  return null;
}
// Move focus to the next (Tab) / previous (Shift-Tab) sequential focus stop,
// computed scope-relatively from the currently focused element (HTML "sequential
// navigation search algorithm"). Wraps at the document edges. Tab is a cold path
// (Capybara send_keys + testdriver), never on find/dispatch/dom_op.
globalThis.__csimAdvanceFocus = function (reverse) {
  const root = __seqBuildDocScope();
  const cur  = globalThis.document && globalThis.document._activeElement;
  let next = null;
  if (cur && isConnected(cur)) {
    const loc = __seqLocate(root, cur, []);
    if (loc) next = __seqStepFromChain(loc.chain, loc.idx, reverse);
    else next = __seqStepFromDocPosition(root, cur, reverse);   // focused, but not a sequential item
  }
  if (next == null) {                       // nothing focused, or page edge → wrap
    next = __seqEdgeStop(root, reverse);
    if (next == null) {
      const flat = __seqFlatten(root, []);
      if (!flat.length) return false;
      next = reverse ? flat[flat.length - 1] : flat[0];
    }
  }
  globalThis.__csimFocusModality = 'keyboard';   // Tab is keyboard-driven → :focus-visible applies
  if (next && typeof next.focus === 'function') { try { next.focus(); } catch (_) {} }
  return true;
};
// Manual mode "find slottables": the slot's assign()-ed nodes, in assignment
// order, restricted to those that are currently light children of this shadow
// root's host (the only observable ones).
function manualSlottablesForSlot(sr, slot) {
  const host = sr.host;
  const list = slot._manualAssignedNodes || EMPTY_NODES;
  const out  = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n._parent === host && isSlottable(n)) out.push(n);
  }
  return out;
}
// slot.assign(...nodes): set the slot's manually-assigned nodes (deduped,
// first-occurrence order), stealing each node from any slot that previously
// held it, and signal slotchange on every shadow root whose assignments moved.
function assignManualSlottables(slot, nodes) {
  const seen = new Set();
  const deduped = [];
  for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (!seen.has(n)) { seen.add(n); deduped.push(n); } }
  const touched = new Set();
  const here = enclosingShadowRoot(slot);
  if (here) touched.add(here);
  const prev = slot._manualAssignedNodes || EMPTY_NODES;
  for (let i = 0; i < prev.length; i++) { if (prev[i]._manualSlot === slot) prev[i]._manualSlot = null; }
  for (let i = 0; i < deduped.length; i++) {
    const n = deduped[i], old = n._manualSlot;
    if (old && old !== slot) {
      old._manualAssignedNodes = (old._manualAssignedNodes || EMPTY_NODES).filter((x) => x !== n);
      const osr = enclosingShadowRoot(old);
      if (osr) touched.add(osr);
    }
  }
  slot._manualAssignedNodes = deduped;
  for (let i = 0; i < deduped.length; i++) deduped[i]._manualSlot = slot;
  for (const sr of touched) assignSlottablesForShadowRoot(sr);
}
// Light children of `sr.host` that the name→slot `map` resolves to `slot`.
function slottablesForSlot(sr, slot, map) {
  const kids = sr.host._children;
  const out  = [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (isSlottable(c) && map.get(slottableName(c)) === slot) out.push(c);
  }
  return out;
}
// "Find flattened slottables": assigned nodes with nested slots expanded into
// their own flattened slottables, falling back to a slot's own children when
// it has no assigned nodes.
function findFlattenedSlottables(slot) {
  if (!enclosingShadowRoot(slot)) return [];
  let slottables = findSlottables(slot);
  if (slottables.length === 0) {
    const kids = slot._children;
    for (let i = 0; i < kids.length; i++) if (isSlottable(kids[i])) slottables.push(kids[i]);
  }
  const out = [];
  for (const s of slottables) {
    if (s.nodeType === NODE_ELEMENT && isHtmlSlot(s) && enclosingShadowRoot(s)) {
      const inner = findFlattenedSlottables(s);
      for (let i = 0; i < inner.length; i++) out.push(inner[i]);
    } else {
      out.push(s);
    }
  }
  return out;
}
function slotAssignedNodes(slot, options) {
  return options && options.flatten === true ? findFlattenedSlottables(slot) : findSlottables(slot);
}

// Event-dispatch helpers (dispatch.js). The flattened-tree event path crosses
// slot boundaries (a slotted node's event-parent is its assigned slot), so the
// dispatcher needs the INTERNAL "find a slot" (open AND closed — encapsulation
// hides the slot from `assignedSlot`, but the event still propagates through
// it). `hasShadowRoots()` gates the whole flattened-path machinery so a
// shadow-free page keeps the cheap `_parent`-only dispatch walk (rule 3).
export function flatTreeAssignedSlot(node) { return findSlotForSlottable(node, false); }
export function isSlottableNode(node) { return isSlottable(node); }
export function hasShadowRoots() { return shadowHostCount > 0; }

const EMPTY_NODES = [];
function sameNodeList(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// Recompute every slot's assigned-node set in `sr` and signal a slotchange for
// each slot whose set changed since the last pass. One shadow-tree walk
// (slots + name map) + one light-children pass (bucketing) — NOT a per-slot
// re-walk (rule 3). The cached snapshot exists only for this diff; reads stay
// lazy.
function assignSlottablesForShadowRoot(sr) {
  // Manual mode: each slot's assigned set is its assign()-ed nodes filtered to
  // current host children (in tree order of slots), diffed for slotchange.
  if (sr.slotAssignment === 'manual') {
    const mslots = [];
    walk(sr, (el) => { if (isHtmlSlot(el)) mslots.push(el); });
    for (const slot of mslots) {
      const assigned = manualSlottablesForSlot(sr, slot);
      if (!sameNodeList(slot._assignedSnapshot || EMPTY_NODES, assigned)) {
        slot._assignedSnapshot = assigned;
        signalSlotChange(slot);
      }
    }
    return;
  }
  const slots = [];
  const map   = new Map();   // name → first <slot> in tree order
  walk(sr, el => {
    if (!isHtmlSlot(el)) return;
    slots.push(el);
    const n = el._attrs.name || '';
    if (!map.has(n)) map.set(n, el);
  });
  if (!slots.length) return;
  const buckets = new Map();   // slot → assigned nodes (tree order)
  const kids = sr.host._children;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!isSlottable(c)) continue;
    const slot = map.get(slottableName(c));
    if (!slot) continue;
    const b = buckets.get(slot);
    if (b) b.push(c); else buckets.set(slot, [c]);
  }
  for (const slot of slots) {
    const assigned = buckets.get(slot) || EMPTY_NODES;
    if (!sameNodeList(slot._assignedSnapshot || EMPTY_NODES, assigned)) {
      slot._assignedSnapshot = assigned;
      signalSlotChange(slot);
    }
  }
}
function subtreeHasSlot(nodes) {
  if (!nodes || !nodes.length) return false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || n.nodeType !== NODE_ELEMENT) continue;
    if (isHtmlSlot(n) || walkFind(n, isHtmlSlot)) return true;
  }
  return false;
}
// Signal slotchange on a single slot if its assigned set changed since the last
// snapshot (computed live, so a detached slot resolves to []).
function signalSlotIfChanged(slot) {
  const assigned = findSlottables(slot);
  if (!sameNodeList(slot._assignedSnapshot || EMPTY_NODES, assigned)) {
    slot._assignedSnapshot = assigned;
    signalSlotChange(slot);
  }
}
// A slot pulled out of its shadow tree loses all its assigned nodes; if it had
// any, that is a slotchange on the now-detached slot (assignSlottablesForShadow-
// Root only revisits slots still in the tree, so removed slots need this).
function signalRemovedSlots(removed) {
  for (let i = 0; i < removed.length; i++) {
    const n = removed[i];
    if (!n || n.nodeType !== NODE_ELEMENT) continue;
    walk(n, (el) => { if (isHtmlSlot(el)) signalSlotIfChanged(el); });
  }
}
// Mutation hooks installed into mutation-observer.js. Both self-gate on
// shadowHostCount so a shadow-free page does no slot work at all.
setSlotMutationHooks(
  function onChildListMutation(target, added, removed) {
    if (!shadowHostCount || !target) return;
    // Light children of a shadow host changed → re-match against its slots.
    if (target._shadowRoot) assignSlottablesForShadowRoot(target._shadowRoot);
    // A slot removed from a shadow tree loses its assignments → slotchange on it.
    if (subtreeHasSlot(removed)) signalRemovedSlots(removed);
    // A <slot> entered/left/moved within a shadow tree → its slot set changed.
    if (subtreeHasSlot(added) || subtreeHasSlot(removed)) {
      const sr = enclosingShadowRoot(target);
      if (sr) assignSlottablesForShadowRoot(sr);
    }
    // Changing the children of a slot that is showing fallback content (empty
    // assigned nodes) changes the flattened tree → slotchange on that slot, and
    // up the nested-fallback chain (an enclosing slot also showing fallback).
    if (isHtmlSlot(target) && enclosingShadowRoot(target)) {
      for (let s = target; s && isHtmlSlot(s); s = s._parent) {
        if (findSlottables(s).length) break;
        signalSlotChange(s);
      }
    }
  },
  function onAttrMutation(target, key) {
    if (!shadowHostCount || !target) return;
    if (key === 'slot') {
      const host = target._parent;
      if (host && host._shadowRoot) assignSlottablesForShadowRoot(host._shadowRoot);
    } else if (isHtmlSlot(target)) {   // key === 'name'
      const sr = enclosingShadowRoot(target);
      if (sr) assignSlottablesForShadowRoot(sr);
    }
  }
);
setSlotChangeFirer(function fireSlotChange(slot) {
  // `slotchange` bubbles within the shadow tree, is not composed, and carries
  // no relatedTarget (a plain Event).
  try { slot.dispatchEvent(new globalThis.Event('slotchange', { bubbles: true })); }
  catch (_) {}
});

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
  'onwheel',
  'onanimationcancel', 'onanimationend', 'onanimationiteration',
  'onanimationstart', 'onauxclick', 'onbeforeinput', 'onbeforematch',
  'onbeforetoggle', 'onbeforexrselect', 'oncommand', 'oncontextlost',
  'oncontextrestored', 'onfencedtreeclick', 'onformdata', 'onfreeze',
  'onfullscreenchange', 'onfullscreenerror', 'ongotpointercapture',
  'onlostpointercapture', 'onpointercancel', 'onpointerdown',
  'onpointerenter', 'onpointerleave', 'onpointerlockchange',
  'onpointerlockerror', 'onpointermove', 'onpointerout',
  'onpointerover', 'onpointerrawupdate', 'onpointerup',
  'onprerenderingchange', 'onreadystatechange', 'onresume',
  'onscrollend', 'onsecuritypolicyviolation', 'onselectionchange',
  'onselectstart', 'onslotchange', 'onsnapchanged', 'onsnapchanging',
  'ontouchcancel', 'ontouchend', 'ontouchmove', 'ontouchstart',
  'ontransitioncancel', 'ontransitionend', 'ontransitionrun',
  'ontransitionstart', 'onvisibilitychange', 'onwebkitanimationend',
  'onwebkitanimationiteration', 'onwebkitanimationstart',
  'onwebkittransitionend'
];

// GlobalEventHandlers live on BOTH Element and Document. The Document
// constructor seeds them as own properties (below); Element gets the
// same set as prototype `null` slots here, so `'onpointerdown' in el`
// / `'onanimationend' in el` etc. answer true the way real browsers do.
// Using the single array above for both surfaces keeps them from
// drifting (the events.js `installOnHandlerSlots` covers a legacy
// subset for early boot; this is the authoritative superset, and both
// guard with `in`, so duplication / ordering is harmless).
for (const __h of GLOBAL_EVENT_HANDLER_ATTRS) {
  if (!(__h in Element.prototype)) Element.prototype[__h] = null;
}

// `document.implementation` — the DOMImplementation interface object. Exposed
// globally so `document.implementation instanceof DOMImplementation` holds, and
// cached per document (see `Document#implementation`) so repeated reads return
// the SAME instance. References Document / XMLDocument / DocumentType / … which
// are module-level and resolved at call time, so its position is immaterial.
class DOMImplementation {
  constructor(doc) { this._doc = doc; }
  // Legacy: `hasFeature` always returns true (DOM §4.5.1).
  hasFeature() { return true; }
  // `createHTMLDocument(title)` — DOMParser shims and Turbo Drive's page-
  // snapshot logic both probe it. Returns a fresh Document with a minimal
  // `<!DOCTYPE html><html><head><title>X</title></head><body></body></html>`
  // skeleton; full HTML-spec construction (quirks-mode flag) is out of scope.
  createHTMLDocument(...args) {
    const d = new Document();
    const doctype = new DocumentType('html', '', '', d);
    doctype._parent = d;
    const html = new Element('html');
    const head = new Element('head');
    const body = new Element('body');
    html._children = newChildList([head, body]);
    head._parent = html; body._parent = html;
    html._parent = d;
    d._children = newChildList([doctype, html]);   // documentElement derives from this
    // The `title` arg adds a <title> iff actually supplied (a present `null`
    // becomes "null"; an omitted/undefined arg adds none — WebIDL optional).
    if (args.length > 0 && args[0] !== undefined) {
      const t = new Element('title');
      t._children = newChildList([Object.assign(new Text(String(args[0])), { _parent: t })]);
      t._parent = head;
      head._children.push(t);
    }
    // An HTML document (text/html → case-insensitive tags), overriding the
    // bare constructor's "application/xml". It still has no browsing context —
    // URL "about:blank", `location` null (DOM §4.5.1) — which it inherits from
    // the constructor.
    d._contentType = 'text/html';
    // Own the skeleton so every node reports this document as its owner.
    walkSubtree(d, n => { n._ownerDoc = d; });
    return d;
  }
  // createDocumentType(qualifiedName, publicId, systemId) — modern spec
  // validates only the name (a "valid doctype name"); no namespace checks.
  createDocumentType(qualifiedName, publicId, systemId) {
    const name = String(qualifiedName);
    if (!isValidDoctypeName(name)) {
      throw new globalThis.DOMException(
        `The qualified name '${name}' is not a valid doctype name.`, 'InvalidCharacterError');
    }
    return new DocumentType(name, publicId, systemId, this._doc);
  }
  // createDocument(namespace, qualifiedName, doctype) — a fresh XMLDocument with
  // an optional root element (from the validated qualifiedName) and an optional
  // doctype, in [doctype?, element?] order.
  createDocument(...args) {
    if (args.length < 2) {
      throw new TypeError("Failed to execute 'createDocument': 2 arguments required.");
    }
    const namespace = args[0], qualifiedName = args[1], doctype = args[2];
    // WebIDL: the doctype arg is `DocumentType?` — reject anything else up front.
    if (doctype != null && !(doctype instanceof DocumentType)) {
      throw new TypeError("Failed to execute 'createDocument': parameter 3 is not of type 'DocumentType'.");
    }
    const ns = (namespace == null || namespace === '') ? null : String(namespace);
    // qualifiedName is [LegacyNullToEmptyString] — only NULL → "" (no root).
    const qn = qualifiedName === null ? '' : String(qualifiedName);
    let rns = null, prefix = null, localName = null;
    if (qn !== '') ({ namespace: rns, prefix, localName } = validateAndExtract(ns, qn, 'element'));
    const d = new XMLDocument();
    d._contentType = ns === HTML_NS ? 'application/xhtml+xml'
                   : ns === SVG_NS  ? 'image/svg+xml'
                   : 'application/xml';   // XML doc → isHtmlDocument false
    d._children = newChildList();         // fresh child list (constructor yields an empty document)
    d.readyState = 'complete';            // fully constructed — no loading phase
    if (doctype != null) {
      if (doctype._parent) {
        const i = doctype._parent._children.indexOf(doctype);
        if (i >= 0) doctype._parent._children.splice(i, 1);
      }
      doctype._parent = d; doctype._ownerDoc = d;
      d._children.push(doctype);
    }
    if (qn !== '') {
      const el = d._createElement(rns, prefix, localName);   // _ownerDoc = d
      el._parent = d;
      d._children.push(el);   // documentElement derives from this
    }
    return d;
  }
}
globalThis.DOMImplementation = DOMImplementation;

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
  // Scoped custom-element registry — single global registry here.
  get customElementRegistry()    { return globalThis.customElements || null; }
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
  // `document.adoptedStyleSheets` — the array of constructed CSSStyleSheets
  // adopted into this document (CSSOM). Lit/Stencil push `new CSSStyleSheet()`
  // here. Stored live so reads see prior writes (spec exposes a FrozenArray;
  // a plain array is observably equivalent for our purposes).
  get adoptedStyleSheets()  { return this._adoptedStyleSheets || (this._adoptedStyleSheets = []); }
  set adoptedStyleSheets(v) { this._adoptedStyleSheets = normalizeAdoptedStyleSheets(v); }
  exitFullscreen()       { return Promise.resolve(); }
  exitPictureInPicture() { return Promise.resolve(); }
  exitPointerLock()      {}
  // CSSOM-View `document.elementFromPoint(x, y)` — without layout we
  // can't pick a "topmost at coords" element. ProseMirror's mousedown
  // handler uses this (via posAtCoords) to resolve click → node so
  // it can set NodeSelection on the clicked image / leaf. Pinning the
  // most recent click target (set by `__csimClickResolve`) lets that
  // resolution work without geometry. Falls back to the deepest
  // laid-out descendant so drag-drop libs that just need ANY element
  // keep working.
  elementFromPoint(_x, _y) {
    const last = globalThis.__csimLastClickTarget;
    if (last && last.nodeType === NODE_ELEMENT && globalThis.document && globalThis.document.body && globalThis.document.body.contains(last)) {
      return last;
    }
    const body = this.body;
    if (!body) return null;
    let deepest = null;
    walkSubtree(body, n => {
      if (n.nodeType === NODE_ELEMENT && globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(n)) deepest = n;
    });
    return deepest;
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
    this.readyState         = 'complete';
    this._contentType       = 'application/xml';
    this._url               = 'about:blank';
    this._noBrowsingContext = true;
    // GlobalEventHandlers IDL attributes — present on every EventTarget per the
    // HTML spec, default to null. React-DOM's input-change-event polyfill
    // probes `'oninput' in document` to decide between modern onChange and
    // IE9-style onpropertychange; without these slots React falls through to
    // the legacy path and crashes calling `element.attachEvent` (IE-only).
    // Written as own properties (not defineProperty on the prototype) so the
    // `in` operator's own-property walk sees them.
    for (const name of GLOBAL_EVENT_HANDLER_ATTRS) this[name] = null;
  }
  // The document element is the document's (single) element child — derived
  // from the tree rather than maintained as a field, so it stays correct after
  // any insert / remove (e.g. `new Document().appendChild(html)`), not just the
  // explicit parser / graft paths. A Document's child list is tiny (an optional
  // doctype + the root), so the scan is effectively free; the manual loop
  // avoids a per-access closure allocation on this hot getter.
  get documentElement() {
    const kids = this._children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === NODE_ELEMENT) return kids[i];
    }
    return null;
  }
  // jQuery's `mc(node)` helper resolves a node back to its window
  // via `doc.defaultView || doc.parentWindow`; without these the
  // offset / scroll path throws "Cannot read properties of
  // undefined (reading 'pageYOffset')".
  // The main document's window is the global; a nested (iframe) document
  // carries its own `_defaultView` (a frame-window proxy) set at load time.
  // A document with no browsing context (`new Document()`, createHTMLDocument,
  // createDocument) has no associated window — `defaultView` is null (DOM
  // §4.5.1). Returning the global here would splice the live window (and its
  // document) into a detached document's event path, cycling it unbounded.
  get defaultView()   { return this._noBrowsingContext ? null : (this._defaultView || globalThis); }
  get parentWindow()  { return this.defaultView; }
  // Document node basics (BATCH H) — the Document node's own
  // nodeName / nodeValue / ownerDocument per DOM spec. (Document
  // inherits Node's ownerDocument, which would resolve to itself;
  // spec says a Document's ownerDocument is null.)
  get nodeName()      { return '#document'; }
  get textContent()   { return null; }
  set textContent(_)  { /* spec: no-op for Document */ }
  get ownerDocument() { return null; }
  // Cloning a Document yields a new EMPTY document of the same kind, carrying
  // the content type and browsing-context-ness — children are copied only on a
  // deep clone (cloneNode handles that + sets documentElement).
  _cloneShell() {
    const d = new this.constructor();
    d._children = newChildList();   // empty → documentElement derives as null
    d._contentType = this._contentType;
    d._noBrowsingContext = this._noBrowsingContext;   // a page clone keeps its (non-null) location
    d._url = this._url;   // copy verbatim: a page doc (no _url → resolves via location) must NOT inherit the ctor's "about:blank"
    d.readyState = 'complete';
    return d;
  }
  // HTML spec `Document.location` aliases `window.location`. Forem's
  // searchParams.js reads `document.location.search`; without this
  // getter the call hits `undefined.search` and the whole bundle's
  // top-level module init aborts before the search-feed fetch fires.
  // A document with no browsing context (createHTMLDocument) has `location`
  // null; the main / frame documents return the live location object.
  get location()      { return this._noBrowsingContext ? null : globalThis.location; }
  set location(v)     { globalThis.__locationAssign(String(v)); }
  // DOM spec URL accessors — all return the document's URL string.
  // Honeybadger's XHR breadcrumb instrumentation calls
  // `parseURL(document.URL)` to decide same-origin; without `URL`
  // the parser is fed `undefined`, throws on `.match`, and the
  // entire XHR open path that triggered the breadcrumb aborts
  // (which on Forem's top-bar is the `/notifications/counts`
  // request that populates the notification badge).
  // A document parsed for a nested browsing context (iframe/frame) or via
  // DOMParser carries its own `_url` (the frame's src / the DOMParser owner
  // document's URL); the live top-level document has none and reflects
  // `location.href` so pushState navigation is tracked.
  get URL()           { return this._url || (globalThis.location && globalThis.location.href) || ''; }
  get documentURI()   { return this.URL; }
  get baseURI()       { return documentBaseURL(this); }
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
    // Real browsers reset `document.activeElement` to `<body>` when
    // the focused element is removed from the tree (e.g. PM rebuilds
    // a NodeView's host span on `tr` dispatch; or a closing popup
    // detaches its focus-trapped panel). Stale references break
    // anything that gates on `view.dom.contains(activeElement)` —
    // notably ProseMirror's `editorOwnsSelection`, which bails its
    // `selectionToDOM` early and leaves the DOM caret behind.
    const ae = this._activeElement;
    if (ae && isConnected(ae)) {
      // HTML "retarget" against the document: when focus lives inside a shadow
      // tree, `document.activeElement` is the OUTERMOST shadow host (the element
      // actually in the document tree), not the shadow-internal node —
      // `shadowRoot.activeElement` exposes the latter. Ascend out of every shadow
      // tree. Gated on the page actually having a shadow host so the common
      // (shadow-free) case keeps this hot read O(1) — no _parent walk (rule 3).
      if (globalThis.__csimShadowHostCount) {
        let node = ae;
        for (let root = enclosingShadowRoot(node); root; root = enclosingShadowRoot(node)) {
          node = root.host;
        }
        return node;
      }
      return ae;
    }
    return this.body || null;
  }
  // PM (and other libs) call `view.root.getSelection()` where
  // `view.root` is the document — `globalThis.getSelection` exists
  // but `document.getSelection` was missing, throwing
  // "Cannot read properties of undefined (reading 'getSelection')"
  // inside `domSelectionRange()`. Per the Selection API spec
  // `document.getSelection()` is a synonym for window.getSelection().
  getSelection() { return globalThis.getSelection ? globalThis.getSelection() : null; }
  // createElement(localName) per DOM spec. The name is validated, then
  // ASCII-lowercased only in an HTML document (XML/XHTML preserve case);
  // createElement never splits a prefix (localName may contain ":"). The
  // namespace is HTML for HTML / XHTML documents, null for XML documents.
  createElement(tag, options) {
    const raw = String(tag);
    if (!isValidElementLocalName(raw)) {
      throw new globalThis.DOMException(
        `The tag name provided ('${raw}') is not a valid name.`, 'InvalidCharacterError');
    }
    // createElement never splits a prefix (localName may contain ":") and
    // ASCII-lowercases only in an HTML document; the namespace is HTML for
    // HTML/XHTML documents, null for XML documents.
    const html = isHtmlDocument(this);
    const localName = html ? asciiLower(raw) : raw;
    const ns = (html || this._contentType === 'application/xhtml+xml') ? HTML_NS : null;
    const el = this._createElement(ns, null, localName);
    // The `is` option records the element's "is value" (a customized built-in's
    // defining custom-element name) — an internal slot, NOT an `is` content
    // attribute. attachShadow consults it for the definition's disabledFeatures.
    if (options && options.is != null) el._isValue = String(options.is);
    return el;
  }
  // createElementNS(namespace, qualifiedName) per DOM spec: validate-and-extract
  // the (namespace, prefix, localName), then create an element carrying them.
  // Preact's `z` takes this path for SVG (Forem's crayons_icon_tag icons); the
  // matcher / cascade / event paths still key off the lowercased `_tag`, so
  // SVG keeps matching while namespaceURI / prefix / localName / tagName reflect
  // the real namespace.
  createElementNS(namespace, qualifiedName) {
    const ns = namespace == null ? null : String(namespace);
    const { namespace: rns, prefix, localName } = validateAndExtract(ns, String(qualifiedName));
    return this._createElement(rns, prefix, localName);
  }
  // Shared "create an element" step for createElement / createElementNS: build
  // the element (custom-element upgrade only in the HTML namespace) and stamp
  // its namespace slots + owner document.
  _createElement(ns, prefix, localName) {
    let el;
    const ctor = ns === HTML_NS ? getCustomElementCtor(localName.toLowerCase()) : null;
    if (ctor) {
      const prev = __currentTag;
      __currentTag = localName.toLowerCase();
      try { el = new ctor(); } finally { __currentTag = prev; }
    } else {
      el = new Element(localName);
    }
    el._ns        = ns;
    el._prefix    = prefix;
    el._localName = localName;
    el._ownerDoc  = this;
    return el;
  }
  // `data` is a required DOMString (not nullable): `null` → "null", `undefined`
  // → "undefined". Coerce at the factory so the node ctor still receives a
  // string (its own `new Text()`/`new Comment()` optional-arg default is
  // separate). NB: these factories have no internal callers — public API only.
  createTextNode(data)   { const t = new Text(String(data));    t._ownerDoc = this; return t; }
  createComment(data)    { const c = new Comment(String(data)); c._ownerDoc = this; return c; }
  // `document.write(...)` / `writeln` / `open` / `close` — the HTML document.write
  // entry point. We don't model a streaming parser with a live insertion point,
  // so write() parses its concatenated markup as a fragment in the <body> context
  // and APPENDS it (never implicitly open()/clears — a clear-and-rewrite of the
  // live page would wipe the running test; every write() use here is an append:
  // during-parse insertion, a fresh empty iframe, or a fresh createHTMLDocument).
  // Declarative shadow roots (`<template shadowrootmode>`) in the written markup
  // are converted only when the document HAS a browsing context — a
  // createHTMLDocument document (`_noBrowsingContext`) must NOT convert them, per
  // the HTML "document.write disallowed on fresh document" rule.
  // (shadow-dom/declarative/declarative-shadow-dom-{opt-in,write-to-iframe}.html)
  write(...args) {
    const html = args.map(a => String(a == null ? '' : a)).join('');
    if (html === '') return;
    let body = this.body;
    if (!body) {
      // No <body> yet (e.g. write into an opened/empty doc) — build a skeleton.
      let de = this.documentElement;
      if (!de) { de = this._createElement(HTML_NS, null, 'html'); this.appendChild(de); }
      body = this._createElement(HTML_NS, null, 'body'); de.appendChild(body);
    }
    const nodes = parseFragment(html, body);
    for (const n of nodes) body.appendChild(n);   // appendChild fires connect + CE upgrade
    // Convert declarative shadow roots in the appended subtrees — only when the
    // document has a browsing context, and only when the markup could contain one
    // (the cheap `/shadowrootmode/` gate keeps a no-DSD write off the walk, like
    // the streaming-parse path). A TOP-LEVEL `<template shadowrootmode>` becomes
    // the host = <body>, so convert it directly; otherwise scan its descendants.
    if (!this._noBrowsingContext && /shadowrootmode/i.test(html)) {
      for (const n of nodes) {
        if (n.nodeType !== NODE_ELEMENT) continue;
        if (n._tag === 'template' && n._ns === HTML_NS) {
          // parseFragment pins `_dsdOriginalParent` to the fragment context; after
          // append the real host is <body>, so clear it to convert against _parent.
          n._dsdOriginalParent = null;
          convertDeclarativeTemplate(n, null);
        } else {
          processDeclarativeShadowRoots(n);
        }
      }
    }
  }
  writeln(...args) { this.write(args.map(a => String(a == null ? '' : a)).join('') + '\n'); }
  // open() resets the document for rewriting and returns it; we have no streaming
  // parser, so it just clears the body. NOT called implicitly by write() (see above).
  open() {
    const body = this.body;
    if (body) {
      for (const c of body._children.slice()) { c._parent = null; unregisterSubtree(c); }
      body._children = newChildList();
      bumpSettleGen();
    }
    return this;
  }
  close() { /* no streaming parser to finish */ }
  // `createCDATASection(data)` — XML documents only (NotSupportedError in HTML);
  // data must not contain the CDATA-section close delimiter "]]>".
  createCDATASection(data) {
    if (isHtmlDocument(this)) {
      throw new globalThis.DOMException("This operation is not supported for HTML documents.", 'NotSupportedError');
    }
    const s = String(data);   // WebIDL DOMString: null → "null", undefined → "undefined"
    if (s.includes(']]>')) {
      throw new globalThis.DOMException("String contains an invalid character.", 'InvalidCharacterError');
    }
    const c = new CDATASection(s); c._ownerDoc = this; return c;
  }
  get body() {
    const html = this.documentElement;
    if (!html) return null;
    for (const c of html._children) {
      if (c._tag === 'body') return c;
    }
    return null;
  }
  // The document's DocumentType child, or null. Populated for a page's
  // `<!DOCTYPE html>` (the parser synthesizes the node and the per-visit
  // graft in __csimLoadDocument carries it onto the live document) and
  // for createDocument / createDocumentType.
  get doctype() {
    for (const c of this._children) if (c.nodeType === NODE_DOCTYPE) return c;
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
    if (!title) return '';
    // HTML spec: getter strips and collapses ASCII whitespace.
    return title.textContent.replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
  }
  // Per HTML spec, `document.referrer` is the URL of the page that
  // initiated this navigation — populated for link clicks / form
  // submits, empty for address-bar visits. Discourse's `/login` route
  // relies on `document.referrer` to set the `destination_url` cookie
  // when the user clicked into login from an internal topic page;
  // without this the post-auth `location.assign(destination_url)`
  // branch never fires and the user lands on `/` instead of the
  // pre-login URL.
  get referrer() {
    return (typeof globalThis.__getDocumentReferrer === 'function')
      ? (globalThis.__getDocumentReferrer() || '')
      : '';
  }
  set title(v) {
    let head = this.head;
    if (!head) {
      head = new Element('head');
      head._parent = this.documentElement;
      this.documentElement._children.unshift(head);
      registerSubtree(head);
      bumpSettleGen();   // direct _children edit: refresh live collections (cached .children)
    }
    let title = head.querySelector('title');
    if (!title) {
      title = new Element('title');
      title._parent = head;
      head._children.push(title);
      registerSubtree(title);
      bumpSettleGen();
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
  querySelector(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelector': 1 argument required, but only 0 present.");
    return this.documentElement ? selectFirst([this.documentElement], sel, this.documentElement) : null;
  }
  querySelectorAll(sel) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'querySelectorAll': 1 argument required, but only 0 present.");
    return nodeList(this.documentElement ? selectAll([this.documentElement], sel, this.documentElement) : []);
  }
  // `getElementsByTagName` on a Document is a real DOM API apps and
  // Capybara reach for directly. Per DOM spec these include self when
  // called on Document (the
  // documentElement IS a descendant of Document), so `//html`
  // matching documentElement is a hard requirement Capybara relies
  // on for `find(:css, 'html')` and `match_selector('html')`.
  getElementsByTagName(tag) {
    const want = String(tag).toLowerCase();
    // LIVE HTMLCollection; documentElement-inclusive (it IS a descendant of the
    // Document, so `getElementsByTagName('html')` returns it).
    return liveHTMLCollection(() => {
      const root = this.documentElement;
      if (!root) return [];
      const out = (want === '*' || root._tag === want) ? [root] : [];
      // Array helper (NOT root.getElementsByTagName, which would build a
      // throwaway nested live Proxy on every recompute).
      for (const n of collectByTagName(root, tag)) out.push(n);
      return out;
    });
  }
  getElementsByClassName(cls) { return liveHTMLCollection(() => collectByClassName(this, cls)); }
  getElementsByName(name) {
    return this.documentElement ? this.documentElement.getElementsByName(name) : [];
  }
  // DocumentFragment — a lightweight node container with no parent
  // identity in the document. jQuery (and similar libraries) build
  // off-document subtrees in fragments before splicing them into
  // the live tree via `appendChild`. We give it just enough surface
  // for `appendChild` / `childNodes` to work.
  createDocumentFragment() {
    const f = new DocumentFragment();
    f._ownerDoc = this;   // own to this document, like createTextNode / createComment
    return f;
  }
  // `Document.createEvent(interfaceName)` — legacy DOM Level 2 API
  // still used by libraries that target older browsers (Trix's
  // `triggerEvent` builds `document.createEvent("Event")` /
  // `event.initEvent(...)` so it works without `new Event()`
  // support detection). The returned event needs `initEvent` /
  // `initCustomEvent` mutators per the spec.
  createEvent(interfaceName) {
    // https://dom.spec.whatwg.org/#dom-document-createevent — fixed table of
    // (ASCII-lowercased) legacy interface names → event interface. ASCII-only
    // folding is load-bearing: "UİEvent" must NOT fold to "uievent".
    const name = asciiLower(String(interfaceName == null ? '' : interfaceName));
    const ctorName = CREATE_EVENT_INTERFACES[name];
    if (!ctorName) {
      throw new globalThis.DOMException(
        `The event interface "${interfaceName}" is not supported.`, 'NotSupportedError');
    }
    const Ctor = globalThis[ctorName] || globalThis.Event;
    const ev = new Ctor('', { bubbles: false, cancelable: false });
    // createEvent leaves the initialized flag UNSET — dispatching before
    // init*Event must throw InvalidStateError. The prototype init*Event methods
    // (events.js) set it; they also carry the dispatch-flag no-op + the full
    // spec resets, so no per-instance override is needed here.
    ev._initialized = false;
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
    // DOM §4.5: adopting a document is not supported.
    if (node.nodeType === NODE_DOC) {
      throw new globalThis.DOMException('Cannot adopt a document', 'NotSupportedError');
    }
    // A shadow root cannot be adopted (it is owned by its host's tree).
    if (node._isShadowRoot) {
      throw new globalThis.DOMException('Cannot adopt a shadow root', 'HierarchyRequestError');
    }
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
    const oldDoc = node.ownerDocument;
    // DOM §adopt: for each inclusive descendant set its node document, and for an
    // element also set the node document of every attribute in its attribute list.
    // Attr nodes are cached per-element (`_attrNodes`) with a stable identity, so a
    // reference taken before the adopt must follow the element to `dest`.
    walkSubtree(node, n => {
      n._ownerDoc = dest;
      if (n._attrNodes) for (const k in n._attrNodes) n._attrNodes[k]._ownerDoc = dest;
    });
    // Live ranges are tracked per node-document (doc._liveRanges). A range whose
    // boundary container is in the adopted subtree must follow it to `dest`, or
    // the destination document's mutation hooks won't find it — a removeChild
    // after a cross-document adopt would then fail to collapse the range.
    // _track() recomputes from the (now reassigned) startContainer's document.
    const oldReg = oldDoc && oldDoc._liveRanges;
    if (oldReg && oldReg.size) {
      for (const r of [...oldReg]) {
        if (sameTreeContains(node, r.startContainer) || sameTreeContains(node, r.endContainer)) r._track();
      }
    }
    return node;
  }
  // `document.implementation` — a per-document, cached `DOMImplementation`
  // (createHTMLDocument / createDocument / createDocumentType / hasFeature).
  // Cached so repeated reads return the same instance, and a real class so
  // `instanceof DOMImplementation` holds.
  get implementation() {
    return this._implementation || (this._implementation = new DOMImplementation(this));
  }

  // Minimal Range stub for `document.createRange()`. We don't model
  // partial-range selection (start/end offsets on text nodes etc.);
  // only document-order comparison between two nodes' start containers
  // via `compareBoundaryPoints`, which is all the consumers here drive.
  createRange() { return new DocumentOrderRange(this); }
  // Minimal NodeIterator. DOMPurify is the canonical consumer —
  // it walks a freshly-parsed sanitisation fragment via
  // `nextNode()` and uses `whatToShow` to gate ELEMENT / TEXT /
  // COMMENT visits. We pre-collect descendants in document order;
  // DOMPurify operates on small per-call fragments so the up-front
  // walk is cheaper than the per-step sibling/ancestor traversal.
  createNodeIterator(root, whatToShow, filter) {
    if (!isNodeArg(root)) {
      throw new TypeError("Failed to execute 'createNodeIterator': parameter 1 is not of type 'Node'.");
    }
    // WebIDL: `whatToShow` defaults to 0xFFFFFFFF only when OMITTED; an explicit
    // null is ToUint32(null) = 0. `filter` defaults to null (not undefined).
    whatToShow = whatToShow === undefined ? 0xFFFFFFFF : (whatToShow >>> 0);
    if (filter === undefined) filter = null;
    // `referenceNode` / `pointerBeforeReferenceNode` move as the iterator
    // traverses and as the tree mutates, but all five IDL attributes are
    // readonly — so they are getters over a non-enumerable mutable state object.
    // `active` guards against a filter that re-enters nextNode/previousNode.
    const state = { node: root, before: true, active: false };
    // A LIVE iterator: nextNode / previousNode traverse the CURRENT tree from
    // `referenceNode` (per DOM §6.1), and the "pre-removing steps" in removeChild
    // keep the reference valid as the tree mutates — not a one-shot snapshot.
    const accept = (n) => {
      if (!((1 << (n.nodeType - 1)) & whatToShow)) return 3; // FILTER_SKIP
      if (!filter) return 1;
      // Per HTML "invoke a callback function": a filter whose realm is a destroyed
      // browsing context (its iframe was removed) is no longer runnable — throw
      // instead of calling it. (TreeWalker-acceptNode-filter-cross-realm-null-
      // browsing-context.html)
      if (!globalThis.__csimCallbackRunnable(filter)) {
        throw new TypeError("Failed to execute 'nextNode' on 'NodeIterator': The provided callback is no longer runnable.");
      }
      // "Filtering" sets the active flag; re-entering during the callback
      // (a filter that itself calls nextNode) is an InvalidStateError — thrown
      // BEFORE the active flag is set so it isn't realm-rewritten as a TypeError.
      if (state.active) {
        throw new globalThis.DOMException("Failed to execute 'nextNode' on 'NodeIterator': the iterator's filter is already active.", 'InvalidStateError');
      }
      state.active = true;
      try {
        // WebIDL callback-interface invocation (mirrors createTreeWalker): a
        // filter whose `acceptNode` is missing/non-callable is a TypeError, and a
        // cross-realm filter's TypeError is of the FILTER's realm.
        const fn = typeof filter === 'function' ? filter : filter.acceptNode;
        if (typeof fn !== 'function') throw new TypeError("Failed to execute 'acceptNode' on 'NodeFilter': the callback is not callable.");
        const r = fn.call(filter, n);
        return (r === 2 || r === 3 || r === false) ? 3 : 1;
      } catch (e) {
        throw globalThis.__csimRealmizeCallbackError(filter, e);
      } finally {
        state.active = false;
      }
    };
    const it = {
      nextNode()     { return nodeIteratorTraverse(this, true); },
      previousNode() { return nodeIteratorTraverse(this, false); },
      detach() {}
    };
    Object.defineProperties(it, {
      _state:     { value: state, writable: false, enumerable: false },
      _accept:    { value: accept, writable: false, enumerable: false },
      root:       { value: root, enumerable: true },
      whatToShow: { value: whatToShow, enumerable: true },
      filter:     { value: filter, enumerable: true },
      referenceNode:              { get() { return state.node; }, enumerable: true },
      pointerBeforeReferenceNode: { get() { return state.before; }, enumerable: true },
      [Symbol.toStringTag]:       { value: 'NodeIterator' }
    });
    LIVE_NODE_ITERATORS.add(it);
    return it;
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
    // WebIDL: root is a non-nullable Node; whatToShow is `unsigned long = 0xFFFFFFFF`
    // (omitted/undefined → default; null → ToUint32(null) = 0); filter is
    // `NodeFilter? = null` (undefined/null → null).
    if (!isNodeArg(root)) {
      throw new TypeError("Failed to execute 'createTreeWalker': parameter 1 is not of type 'Node'.");
    }
    whatToShow = whatToShow === undefined ? 0xFFFFFFFF : (whatToShow >>> 0);
    filter = filter == null ? null : filter;
    let cur = root;
    let active = false;
    // "Filter" a node → FILTER_ACCEPT(1) / FILTER_REJECT(2) / FILTER_SKIP(3).
    // whatToShow gates first; the callback (re-entrancy throws per spec) runs
    // only on shown nodes. REJECT means "skip the node AND its subtree" — the
    // distinction the old flat-array walker couldn't make.
    const accept = (n) => {
      const mask = 1 << (n.nodeType - 1);
      if (!(mask & whatToShow)) return 3;
      if (!filter) return 1;
      // A filter whose realm is a destroyed browsing context (removed iframe) is
      // no longer runnable — throw instead of calling it (mirrors NodeIterator).
      if (!globalThis.__csimCallbackRunnable(filter)) {
        throw new TypeError("Failed to execute 'firstChild' on 'TreeWalker': The provided callback is no longer runnable.");
      }
      // Re-entrancy guard (thrown BEFORE the active flag is set so it isn't
      // realm-rewritten): a filter that traverses the same walker is an error.
      if (active) throw new globalThis.DOMException('TreeWalker filter is already running.', 'InvalidStateError');
      active = true;
      try {
        // WebIDL callback-interface invocation: resolve `acceptNode` (a Get that
        // can itself throw for a revoked-Proxy filter) and require it callable.
        const fn = typeof filter === 'function' ? filter : filter.acceptNode;
        if (typeof fn !== 'function') throw new TypeError("Failed to execute 'acceptNode' on 'NodeFilter': the callback is not callable.");
        return fn.call(filter, n) & 0xFFFF;   // NodeFilter returns `unsigned short` (ToUint16)
      } catch (e) {
        // The operation runs with the FILTER's [[Realm]] current, so a TypeError
        // it raises is of that realm — `assert_throws_js(otherRealm.TypeError)`.
        throw globalThis.__csimRealmizeCallbackError(filter, e);
      } finally {
        active = false;
      }
    };
    // Raw (unfiltered) tree navigation on the full node tree.
    const fc = (n) => (n._children && n._children.length) ? n._children[0] : null;
    const lc = (n) => (n._children && n._children.length) ? n._children[n._children.length - 1] : null;
    const ns = (n) => { const p = n._parent; if (!p) return null; const i = p._children.indexOf(n); return (i >= 0 && i + 1 < p._children.length) ? p._children[i + 1] : null; };
    const ps = (n) => { const p = n._parent; if (!p) return null; const i = p._children.indexOf(n); return i > 0 ? p._children[i - 1] : null; };
    // DOM spec "traverse children" (firstChild = forward, lastChild = !forward).
    function traverseChildren(forward) {
      let node = forward ? fc(cur) : lc(cur);
      while (node) {
        const r = accept(node);
        if (r === 1) { cur = node; return node; }
        if (r === 3) { const child = forward ? fc(node) : lc(node); if (child) { node = child; continue; } }
        // REJECT, or SKIP with no child → next sibling, else up.
        while (node) {
          const sib = forward ? ns(node) : ps(node);
          if (sib) { node = sib; break; }
          const parent = node._parent;
          if (!parent || parent === root || parent === cur) return null;
          node = parent;
        }
      }
      return null;
    }
    // DOM spec "traverse siblings" (nextSibling = forward, previousSibling = !forward).
    function traverseSiblings(forward) {
      let node = cur;
      if (node === root) return null;
      while (true) {
        let sibling = forward ? ns(node) : ps(node);
        while (sibling) {
          node = sibling;
          const r = accept(node);
          if (r === 1) { cur = node; return node; }
          sibling = forward ? fc(node) : lc(node);
          if (r === 2 || !sibling) sibling = forward ? ns(node) : ps(node);
        }
        node = node._parent;
        if (!node || node === root) return null;
        if (accept(node) === 1) return null;
      }
    }
    const tw = {
      get currentNode() { return cur; },
      set currentNode(v) {
        if (!isNodeArg(v)) throw new TypeError("Failed to set the 'currentNode' property on 'TreeWalker': parameter 1 is not of type 'Node'.");
        cur = v;
      },
      parentNode() {
        let node = cur;
        while (node && node !== root) {
          node = node._parent;
          if (node && accept(node) === 1) { cur = node; return node; }
        }
        return null;
      },
      firstChild()      { return traverseChildren(true); },
      lastChild()       { return traverseChildren(false); },
      nextSibling()     { return traverseSiblings(true); },
      previousSibling() { return traverseSiblings(false); },
      nextNode() {
        let node = cur, result = 1;
        while (true) {
          while (result !== 2 && fc(node)) {
            node = fc(node);
            result = accept(node);
            if (result === 1) { cur = node; return node; }
          }
          let sibling = null, temp = node;
          while (temp) {
            if (temp === root) return null;
            sibling = ns(temp);
            if (sibling) { node = sibling; break; }
            temp = temp._parent;
          }
          if (!sibling) return null;
          result = accept(node);
          if (result === 1) { cur = node; return node; }
        }
      },
      previousNode() {
        let node = cur;
        while (node !== root) {
          let sibling = ps(node);
          while (sibling) {
            node = sibling;
            let result = accept(node);
            while (result !== 2 && lc(node)) { node = lc(node); result = accept(node); }
            if (result === 1) { cur = node; return node; }
            sibling = ps(node);
          }
          if (node === root || !node._parent) return null;
          node = node._parent;
          if (accept(node) === 1) { cur = node; return node; }
        }
        return null;
      }
    };
    // Spec: root / whatToShow / filter are read-only; `[object TreeWalker]`.
    Object.defineProperty(tw, 'root',       { value: root,       enumerable: true, writable: false });
    Object.defineProperty(tw, 'whatToShow', { value: whatToShow, enumerable: true, writable: false });
    Object.defineProperty(tw, 'filter',     { value: filter,     enumerable: true, writable: false });
    Object.defineProperty(tw, Symbol.toStringTag, { value: 'TreeWalker' });
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
      // contenteditable: fire a cancelable `beforeinput`, then (unless
      // prevented) replace the current Selection with the text at the
      // caret via the same helper the send-keys path uses, and fire
      // `input`. Matches the execCommand('insertText') default action
      // per the input-events spec.
      if (active._attrs.contenteditable != null && (active._attrs.contenteditable || '').toLowerCase() !== 'false') {
        let prevented = false;
        try {
          const bi = new globalThis.InputEvent('beforeinput', { bubbles: true, cancelable: true, data: str, inputType: 'insertText' });
          prevented = !dispatchEvent(active, bi);
        } catch (_) {}
        if (!prevented) {
          globalThis.__csimInsertTextAtSelection(str);
          try { dispatchEvent(active, new globalThis.InputEvent('input', { bubbles: true, cancelable: true, data: str, inputType: 'insertText' })); } catch (_) {}
        }
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
  // execCommand legacy state/value/indeterminacy probes — we don't
  // run execCommand, so report the inert defaults.
  queryCommandState() { return false; }
  queryCommandValue() { return ''; }
  queryCommandIndeterm() { return false; }
  // ── Document collections (BATCH G) ──────────────────────────────
  // Live HTMLCollections built from tag/attribute queries, matching
  // the legacy `document.forms` / `images` / etc. surface.
  get forms()   { return htmlCollection(this.getElementsByTagName('form')); }
  get images()  { return htmlCollection(this.getElementsByTagName('img')); }
  // `links` = <a> / <area> with an href attribute.
  get links()   { return htmlCollection(this.querySelectorAll('a[href], area[href]')); }
  get scripts() { return htmlCollection(this.getElementsByTagName('script')); }
  // `anchors` = <a> elements with a `name` attribute (legacy).
  get anchors() { return htmlCollection(this.querySelectorAll('a[name]')); }
  get embeds()  { return htmlCollection(this.getElementsByTagName('embed')); }
  // `plugins` is the legacy alias of `embeds`.
  get plugins() { return htmlCollection(this.getElementsByTagName('embed')); }
  // `applets` is a historical accessor; the `<applet>` element was removed from
  // HTML, so per spec it always returns an empty HTMLCollection. (We intentionally
  // do NOT expose `document.all`: its defining behaviour is the [[IsHTMLDDA]]
  // exotic slot — falsy in boolean context, `typeof` === 'undefined' — which is
  // unmodellable in plain JS, and a normal object would break the `if (document.all)`
  // / `typeof document.all` feature-detection real libraries rely on.)
  get applets() { return htmlCollection([]); }
  // Namespace-aware lookup collapses to the flat local-name query.
  getElementsByTagNameNS(ns, local) { return liveHTMLCollection(() => collectByTagNameNS(this, ns, local)); }
  // ── Document legacy string / metadata members (BATCH G) ─────────
  // `document.dir` reflects the documentElement's `dir` attribute.
  get dir() {
    const de = this.documentElement;
    return de ? (de._attrs.dir || '') : '';
  }
  set dir(v) {
    const de = this.documentElement;
    if (de) de.setAttribute('dir', String(v == null ? '' : v));
  }
  // `domain` defaults to the current host; stored so writes round-trip.
  get domain() {
    return this._domain != null ? this._domain
      : ((globalThis.location && globalThis.location.hostname) || '');
  }
  set domain(v) { this._domain = String(v == null ? '' : v); }
  // `designMode` is 'off' by default; stored so a write round-trips.
  get designMode()  { return this._designMode || 'off'; }
  set designMode(v) { this._designMode = String(v == null ? '' : v); }
  // Legacy presentational color attributes — empty steady state,
  // stored for round-trip reads.
  get fgColor()    { return this._fgColor || ''; }
  set fgColor(v)   { this._fgColor = String(v == null ? '' : v); }
  get bgColor()    { return this._bgColor || ''; }
  set bgColor(v)   { this._bgColor = String(v == null ? '' : v); }
  get linkColor()  { return this._linkColor || ''; }
  set linkColor(v) { this._linkColor = String(v == null ? '' : v); }
  get vlinkColor() { return this._vlinkColor || ''; }
  set vlinkColor(v){ this._vlinkColor = String(v == null ? '' : v); }
  get alinkColor() { return this._alinkColor || ''; }
  set alinkColor(v){ this._alinkColor = String(v == null ? '' : v); }
  // Encoding accessors. We don't transcode bytes (the loader hands us UTF-8),
  // but the declared charset IS observable: the first valid `<meta charset>` /
  // `<meta http-equiv=content-type>`, normalised to its canonical Encoding-
  // standard name (default UTF-8). `_httpCharset` is a forward hook for an HTTP
  // `Content-Type; charset=…` (which per spec would win over meta) — not yet
  // wired (no test needs it; our responses carry no charset). `charset` /
  // `inputEncoding` are legacy aliases of `characterSet`.
  get characterSet() {
    // A string-sourced document (DOMParser.parseFromString) is pinned to UTF-8;
    // its markup's `<meta charset>` does not feed the encoding (no byte sniffing).
    if (this._charsetOverride) return this._charsetOverride;
    let name = this._httpCharset ? getEncoding(this._httpCharset, false) : null;
    if (!name) {
      const label = firstMetaCharset(this);
      if (label != null) name = getEncoding(label, true);
    }
    return name || 'UTF-8';
  }
  get charset()       { return this.characterSet; }
  get inputEncoding() { return this.characterSet; }
  get contentType()   { return this._contentType || 'text/html'; }
  // Standards-mode rendering only.
  get compatMode()    { return this._quirks ? 'BackCompat' : 'CSS1Compat'; }
  // Deterministic fixed timestamp (MM/DD/YYYY HH:MM:SS, local time).
  get lastModified()  { return '01/01/1970 00:00:00'; }
  // ── Document Attr / storage / legacy-event members (BATCH G) ─────
  // `createAttribute(localName)` — a detached Attr (no owner, empty value).
  // Validates the Name production and ASCII-lowercases in an HTML document.
  createAttribute(name) {
    const qn = String(name);
    if (!isValidAttributeLocalName(qn)) {
      throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
    }
    const ln = isHtmlDocument(this) ? asciiLower(qn) : qn;
    return new Attr(ln, null, null, '', this);
  }
  createAttributeNS(namespace, qualifiedName) {
    const ns = namespace == null ? null : String(namespace);
    const { namespace: rns, prefix, localName } = validateAndExtract(ns, String(qualifiedName), 'attribute');
    return new Attr(localName, rns, prefix, '', this);
  }
  // `createProcessingInstruction(target, data)` — target must match the XML Name
  // production; data must not contain the PI close delimiter "?>".
  createProcessingInstruction(target, data) {
    const t = String(target);
    if (!isXMLName(t)) {
      throw new globalThis.DOMException("'" + t + "' is not a valid PI target.", "InvalidCharacterError");
    }
    const d = String(data);
    if (d.indexOf('?>') !== -1) {
      throw new globalThis.DOMException("PI data must not contain '?>'.", "InvalidCharacterError");
    }
    return new ProcessingInstruction(t, d, this);
  }
  // Storage Access API — no cookie partitioning here, always granted.
  hasStorageAccess()              { return Promise.resolve(true); }
  requestStorageAccess()          { return Promise.resolve(); }
  hasUnpartitionedCookieAccess()  { return Promise.resolve(true); }
  // Legacy Netscape event-model no-ops.
  captureEvents() {}
  releaseEvents() {}
  clear() {}
}
// XMLDocument — the object `document.implementation.createDocument` returns. It
// has no browsing context (so `location` is null) and is XML-typed (the
// `_contentType` createDocument sets makes isHtmlDocument false → case-sensitive
// element/attribute handling, per spec).
class XMLDocument extends Document {
  get location() { return null; }
  get URL()      { return 'about:blank'; }   // no browsing context; documentURI follows via this.URL
}
globalThis.XMLDocument = XMLDocument;

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
  doc._contentType       = undefined;   // → isHtmlDocument() true (text/html)
  doc._url               = undefined;    // URL resolves via globalThis.location
  doc._noBrowsingContext = false;
  doc.readyState         = 'loading';
  if (withSkeleton) {
    const html = new Element('html');
    const head = new Element('head');
    const body = new Element('body');
    html._parent = doc;  doc._children.push(html);   // documentElement derives from this
    head._parent = html; html._children.push(head);
    body._parent = html; html._children.push(body);
  }
  return doc;
}

// Live ranges (DOM §4.5). The registry of live ranges hangs off the DOCUMENT
// (`doc._liveRanges`), not a module-level Set: a document object is shared
// across V8 realms, so a range created in one realm is still found when its
// node is mutated by code running in another (the WPT iframe harness clones
// main-realm nodes into a frame document, then mutates them — a per-realm Set
// would miss the frame-realm range). Every Range tracks itself into its current
// document's set; the per-mutation hooks short-circuit when that set is empty,
// so the hot insert/remove paths stay cheap.
function rangesFor(node) {
  const d = node && (node.nodeType === NODE_DOC ? node : node.ownerDocument);
  return d ? d._liveRanges : null;   // undefined until the first range → falsy → skip
}
// "insert" fix-up: `count` nodes were inserted into `parent` at `index`.
// Boundaries in `parent` past the insertion point shift right.
function liveRangesOnInsert(parent, index, count) {
  const reg = rangesFor(parent);
  if (!reg || reg.size === 0) return;
  for (const r of reg) {
    if (r.startContainer === parent && r.startOffset > index) r.startOffset += count;
    if (r.endContainer   === parent && r.endOffset   > index) r.endOffset   += count;
  }
}
// Same-node-tree containment: like `contains` but does NOT cross a shadow
// boundary (a range inside a shadow tree is in its own node tree, so removing
// the light-tree host must not disturb it).
function sameTreeContains(ancestor, descendant) {
  for (let n = descendant; n; n = n._parent) {
    if (n === ancestor) return true;
    if (n._isShadowRoot) return false;   // stop at the shadow boundary
  }
  return false;
}
// "remove" fix-up: `node` (at `index` in `oldParent`) is about to be removed.
// Boundaries inside `node` collapse to (oldParent, index); boundaries in
// oldParent past the node shift left. Must run BEFORE the actual detach.
function liveRangesOnRemove(oldParent, node, index) {
  const reg = rangesFor(oldParent);
  if (!reg || reg.size === 0) return;
  for (const r of reg) {
    if (sameTreeContains(node, r.startContainer)) { r.startContainer = oldParent; r.startOffset = index; }
    if (sameTreeContains(node, r.endContainer))   { r.endContainer   = oldParent; r.endOffset   = index; }
    if (r.startContainer === oldParent && r.startOffset > index) r.startOffset -= 1;
    if (r.endContainer   === oldParent && r.endOffset   > index) r.endOffset   -= 1;
  }
}
// "replace data" fix-up: `count` code units at `offset` in `node` were replaced
// by `dataLen` units. Boundaries inside the replaced span clamp to `offset`;
// boundaries after it shift by the length delta.
function liveRangesOnReplaceData(node, offset, count, dataLen) {
  const reg = rangesFor(node);
  if (!reg || reg.size === 0) return;
  const delta = dataLen - count;
  for (const r of reg) {
    if (r.startContainer === node) {
      if (r.startOffset > offset && r.startOffset <= offset + count) r.startOffset = offset;
      else if (r.startOffset > offset + count) r.startOffset += delta;
    }
    if (r.endContainer === node) {
      if (r.endOffset > offset && r.endOffset <= offset + count) r.endOffset = offset;
      else if (r.endOffset > offset + count) r.endOffset += delta;
    }
  }
}
// "split" fix-up: `node` was split at `offset`; the tail moved to `newNode`
// (now at index `nodeIndex + 1` in `parent`). Boundaries past the split point
// move to `newNode`; a boundary in `parent` at the new node's slot shifts right.
function liveRangesOnSplit(node, offset, newNode, parent, nodeIndex) {
  const reg = rangesFor(node);
  if (!reg || reg.size === 0) return;
  for (const r of reg) {
    if (r.startContainer === node && r.startOffset > offset) { r.startContainer = newNode; r.startOffset -= offset; }
    if (r.endContainer   === node && r.endOffset   > offset) { r.endContainer   = newNode; r.endOffset   -= offset; }
    if (parent) {
      if (r.startContainer === parent && r.startOffset === nodeIndex + 1) r.startOffset += 1;
      if (r.endContainer   === parent && r.endOffset   === nodeIndex + 1) r.endOffset   += 1;
    }
  }
}
// Live NodeIterators (DOM §6.1). Registered at creation so `removeChild` can run
// the "NodeIterator pre-removing steps" — keeping `referenceNode` valid as the
// tree mutates. Gated on an empty set so removeChild stays cheap when none exist.
const LIVE_NODE_ITERATORS = new Set();
// First node after `node` in tree order, confined to `root`'s subtree, skipping
// `node`'s own descendants. Null if none.
function followingSkippingSubtree(node, root) {
  for (let cur = node; cur && cur !== root; cur = cur._parent) {
    const p = cur._parent;
    if (p) {
      const sibs = p._children, i = sibs.indexOf(cur);
      if (i >= 0 && i + 1 < sibs.length) return sibs[i + 1];
    }
  }
  return null;
}
// First node after `node` in tree order within `root` (into descendants first).
function followingWithinRoot(node, root) {
  if (node._children && node._children.length) return node._children[0];
  return followingSkippingSubtree(node, root);
}
// Last node before `node` in tree order within `root` (root itself is valid).
function precedingWithinRoot(node, root) {
  if (node === root || !node._parent) return null;
  const sibs = node._parent._children, i = sibs.indexOf(node);
  if (i > 0) {
    let n = sibs[i - 1];
    while (n._children && n._children.length) n = n._children[n._children.length - 1];
    return n;
  }
  return node._parent;
}
// DOM NodeIterator "traverse" (forward = nextNode, else previousNode): move past
// the reference one accepted node at a time over the live tree.
function nodeIteratorTraverse(it, forward) {
  let node = it._state.node;
  let before = it._state.before;
  while (true) {
    if (forward) {
      if (!before) { const n = followingWithinRoot(node, it.root); if (!n) return null; node = n; }
      else before = false;
    } else {
      if (before) { const n = precedingWithinRoot(node, it.root); if (!n) return null; node = n; }
      else before = true;
    }
    if (it._accept(node) === 1) break;
  }
  it._state.node = node;
  it._state.before = before;
  return node;
}
// DOM "NodeIterator pre-removing steps": run BEFORE `toBeRemoved` leaves the tree
// so the iterator's reference doesn't strand on a detached node.
function nodeIteratorPreRemove(toBeRemoved) {
  if (LIVE_NODE_ITERATORS.size === 0) return;
  const removedDoc = toBeRemoved.nodeType === NODE_DOC ? toBeRemoved : toBeRemoved.ownerDocument;
  for (const it of LIVE_NODE_ITERATORS) {
    const st = it._state;
    // If the removed node is the iterator's root — or an ancestor of it — the
    // whole iterator subtree detaches as a unit, so referenceNode stays valid.
    if (nodeContains(toBeRemoved, it.root)) continue;
    const itDoc = it.root.nodeType === NODE_DOC ? it.root : it.root.ownerDocument;
    if (itDoc !== removedDoc) continue;
    if (!nodeContains(toBeRemoved, st.node)) continue;   // not an inclusive ancestor of the reference
    if (st.before) {
      // "first following node that is not an inclusive descendant of toBeRemoved"
      // — document-wide (NOT confined to the iterator's root, which may itself
      // be inside toBeRemoved).
      const next = followingSkippingSubtree(toBeRemoved, null);
      if (next) { st.node = next; continue; }
      st.before = false;
    }
    const prevSib = toBeRemoved.previousSibling;
    if (!prevSib) {
      st.node = toBeRemoved._parent;
    } else {
      let n = prevSib;
      while (n._children && n._children.length) n = n._children[n._children.length - 1];
      st.node = n;
    }
  }
}
// The "length of a node" (DOM §4.4): a DocumentType is 0, a CharacterData node
// is its data length, any other node is its child count.
function nodeLength(node) {
  const t = node.nodeType;
  if (t === NODE_DOCTYPE) return 0;
  if (t === NODE_TEXT || t === NODE_CDATA || t === NODE_COMMENT || t === NODE_PI) {
    return (node.data || '').length;
  }
  return node._children ? node._children.length : 0;
}
// "Set the start/end of a range" (DOM §4.5). Validates the boundary node + offset
// (WebIDL `offset` is an unsigned long, so a negative literal wraps to a huge
// value → IndexSizeError), then sets the boundary, collapsing the *other*
// boundary when the new one would cross it or land in a different tree.
function setRangeBoundary(range, node, offset, which) {
  const fn = which === 'start' ? 'setStart' : 'setEnd';
  if (!isNodeArg(node)) {
    throw new TypeError(`Failed to execute '${fn}' on 'Range': parameter 1 is not of type 'Node'.`);
  }
  if (node.nodeType === NODE_DOCTYPE) {
    throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the node is a doctype.`, 'InvalidNodeTypeError');
  }
  offset = offset >>> 0;   // WebIDL unsigned long (ToUint32) — `-1` → 4294967295
  if (offset > nodeLength(node)) {
    throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
  }
  const newRoot = ancestorChain(node)[0];
  if (which === 'start') {
    const endRoot = range.endContainer && ancestorChain(range.endContainer)[0];
    if (newRoot !== endRoot ||
        compareBoundaryPoint(node, offset, range.endContainer, range.endOffset) > 0) {
      range.endContainer = node; range.endOffset = offset;
    }
    range.startContainer = node; range.startOffset = offset;
  } else {
    const startRoot = range.startContainer && ancestorChain(range.startContainer)[0];
    if (newRoot !== startRoot ||
        compareBoundaryPoint(node, offset, range.startContainer, range.startOffset) < 0) {
      range.startContainer = node; range.startOffset = offset;
    }
    range.endContainer = node; range.endOffset = offset;
  }
  range._track();   // boundary moved → ensure registration follows its (possibly new) document
}
// "Set the start/end before/after a node" — the boundary is (node's parent,
// node's index [+1]); a parentless node has no valid boundary → InvalidNodeTypeError.
function boundaryRelativeToNode(range, node, which, after) {
  const fn = (which === 'start' ? 'setStart' : 'setEnd') + (after ? 'After' : 'Before');
  const parent = node && node._parent;
  if (!parent) {
    throw new globalThis.DOMException(`Failed to execute '${fn}' on 'Range': the node has no parent.`, 'InvalidNodeTypeError');
  }
  const index = parent._children.indexOf(node);
  setRangeBoundary(range, parent, index + (after ? 1 : 0), which);
}
class DocumentOrderRange {
  constructor(doc) {
    // Spec: a newly constructed Range's boundary points are both
    // (the relevant document, 0) — NOT null. `new Range()` collapses at the
    // global document; `someDoc.createRange()` collapses at `someDoc`.
    const d = doc || globalThis.document || null;
    this.startContainer = d;
    this.startOffset    = 0;
    this.endContainer   = d;
    this.endOffset      = 0;
    this._reg           = null;
    this._track();   // register in the start container's document so mutations update this range
  }
  // (Re-)register this range in its current document's live-range set. Called
  // after every boundary change so a range that moves to another document is
  // tracked there (the registry hangs off the shared document, not a realm).
  _track() {
    const sc = this.startContainer;
    const d  = sc && (sc.nodeType === NODE_DOC ? sc : sc.ownerDocument);
    const reg = d ? (d._liveRanges || (d._liveRanges = new Set())) : null;
    if (reg === this._reg) return;
    if (this._reg) this._reg.delete(this);
    this._reg = reg;
    if (reg) reg.add(this);
  }
  setStart(node, offset)  { setRangeBoundary(this, node, offset, 'start'); }
  setEnd(node, offset)    { setRangeBoundary(this, node, offset, 'end'); }
  setStartBefore(node) { boundaryRelativeToNode(this, node, 'start', false); }
  setStartAfter(node)  { boundaryRelativeToNode(this, node, 'start', true); }
  setEndBefore(node)   { boundaryRelativeToNode(this, node, 'end', false); }
  setEndAfter(node)    { boundaryRelativeToNode(this, node, 'end', true); }
  // selectNode spans `node` within its parent: start (parent, index),
  // end (parent, index+1). A parentless node → InvalidNodeTypeError.
  selectNode(node) {
    const parent = node && node._parent;
    if (!parent) {
      throw new globalThis.DOMException("Failed to execute 'selectNode' on 'Range': the node has no parent.", 'InvalidNodeTypeError');
    }
    const index = parent._children.indexOf(node);
    this.startContainer = parent; this.startOffset = index;
    this.endContainer   = parent; this.endOffset   = index + 1;
    this._track();
  }
  // selectNodeContents spans the whole node: start (node, 0), end (node, length).
  // A doctype has no contents to select → InvalidNodeTypeError.
  selectNodeContents(node) {
    if (node.nodeType === NODE_DOCTYPE) {
      throw new globalThis.DOMException("Failed to execute 'selectNodeContents' on 'Range': the node is a doctype.", 'InvalidNodeTypeError');
    }
    this.startContainer = this.endContainer = node;
    this.startOffset    = 0;
    this.endOffset      = nodeLength(node);
    this._track();
  }
  // `Range.createContextualFragment(html)` — parse `html` as a fragment using
  // the range's start node as context, returning a DocumentFragment owned by the
  // start node's document. The context element is the start node when it's an
  // Element (an `<html>` element, a non-element node, or none falls back to a
  // body context — which our body-context parseFragment already is). `fragment`
  // is a required WebIDL argument, so a missing one is a TypeError (not "").
  createContextualFragment(html) {
    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'createContextualFragment' on 'Range': 1 argument required, but only 0 present.");
    }
    const node = this.startContainer;
    const doc  = (node && node.ownerDocument) || globalThis.document;
    const frag = doc.createDocumentFragment();
    // `fragment` is a plain DOMString — null / undefined stringify to "null" /
    // "undefined" (NOT "" — that's innerHTML's [LegacyNullToEmptyString]).
    // Context = the Range's start node when it's an Element (else a default
    // context); parse5 picks the matching fragment insertion mode.
    const ctx = (node && node.nodeType === NODE_ELEMENT) ? node : null;
    for (const c of parseFragment(String(html), ctx)) frag.appendChild(c);
    // Own the fragment + parsed nodes by the start node's document (parseFragment
    // and createDocumentFragment otherwise fall back to the main document, so a
    // range whose start node lives in a createHTMLDocument / DOMParser document
    // would hand back wrongly-owned nodes).
    doc.adoptNode(frag);
    // Spec step: "unmark all scripts as already started" — unlike innerHTML /
    // insertAdjacentHTML, a `<script>` in a contextual fragment DOES run when
    // the fragment is later inserted into the document.
    walkSubtree(frag, n => { if (n._tag === 'script') n._csimRan = false; });
    return frag;
  }
  // `Range.detach()` is a no-op in the modern DOM (kept for legacy callers).
  detach() {}
  // `Range.intersectsNode(node)` — true if any part of node overlaps
  // the range. quote-reply uses this to find which of the
  // window.getSelection() ranges intersects the issue description.
  intersectsNode(node) {
    if (!isNodeArg(node)) throw new TypeError("Failed to execute 'intersectsNode' on 'Range': parameter 1 is not of type 'Node'.");
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
    return extractRangeContents(this);
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
    r._track();
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
    if (!isNodeArg(node)) throw new TypeError("Failed to execute 'insertNode' on 'Range': parameter 1 is not of type 'Node'.");
    const sc = this.startContainer;
    // A Text start node — for insertNode's purposes, a Text or CDATASection
    // node (CDATASection is a Text subclass), both of which split at the offset.
    const startIsText = sc.nodeType === NODE_TEXT || sc.nodeType === NODE_CDATA;
    // HierarchyRequestError: a PI/Comment start node, a parentless Text start
    // node, or inserting an inclusive ancestor of the start node.
    if (sc.nodeType === NODE_PI || sc.nodeType === NODE_COMMENT ||
        (startIsText && !sc._parent) || node === sc || nodeContains(node, sc)) {
      throw new globalThis.DOMException("Failed to execute 'insertNode' on 'Range': the node may not be inserted here.", 'HierarchyRequestError');
    }
    // referenceNode: the Text start node itself, else the child at startOffset.
    let referenceNode = startIsText ? sc
                      : (sc._children ? (sc._children[this.startOffset] || null) : null);
    const parent = referenceNode == null ? sc : referenceNode._parent;
    // Validate the insertion BEFORE mutating (so an invalid node — e.g. a
    // Document — throws without first splitting the start text node).
    ensurePreInsertionValidity(node, parent, referenceNode);
    // Split a Text start node at the offset; the new node becomes the reference.
    if (startIsText) referenceNode = sc.splitText(this.startOffset);
    if (node === referenceNode) referenceNode = node.nextSibling;
    if (node._parent) node._parent.removeChild(node);
    let newOffset = referenceNode == null ? nodeLength(parent) : parent._children.indexOf(referenceNode);
    newOffset += node.nodeType === NODE_FRAGMENT ? nodeLength(node) : 1;
    parent.insertBefore(node, referenceNode);
    // If the range was collapsed, its end is now (parent, newOffset).
    if (this.collapsed) { this.endContainer = parent; this.endOffset = newOffset; }
  }
  // Range#surroundContents(newParent): extract range contents, wrap
  // in `newParent`, insert wrapper at the range's start. Used by
  // highlight / annotate libraries.
  surroundContents(newParent) {
    // InvalidStateError if a non-Text node is partially contained (a boundary
    // sits inside a non-Text node below the common ancestor — it can't be split
    // to wrap cleanly). Text nodes are fine; they get split by extract.
    const common = this.commonAncestorContainer;
    const partialNonText = (boundary, other) => {
      if (nodeContains(boundary, other)) return false;   // boundary contains the other → fully, not partial
      for (let n = boundary; n && n !== common; n = n._parent) {
        // CDATASection is a Text node (it splits fine); only other node types block.
        if (n.nodeType !== NODE_TEXT && n.nodeType !== NODE_CDATA) return true;
      }
      return false;
    };
    if (partialNonText(this.startContainer, this.endContainer) ||
        partialNonText(this.endContainer, this.startContainer)) {
      throw new globalThis.DOMException("Failed to execute 'surroundContents' on 'Range': the range partially selects a non-Text node.", 'InvalidStateError');
    }
    const nt = newParent.nodeType;
    if (nt === NODE_DOC || nt === NODE_DOCTYPE || nt === NODE_FRAGMENT) {
      throw new globalThis.DOMException("Failed to execute 'surroundContents' on 'Range': the new parent is a Document, DocumentType, or DocumentFragment node.", 'InvalidNodeTypeError');
    }
    const fragment = extractRangeContents(this);
    if (newParent._children) for (const c of newParent._children.slice()) newParent.removeChild(c);
    this.insertNode(newParent);
    newParent.appendChild(fragment);
    this.selectNode(newParent);
  }
  // Range#comparePoint(node, offset) — -1/0/+1 vs the range.
  // Range#isPointInRange(node, offset) — true if inside.
  comparePoint(node, offset) {
    if (!isNodeArg(node)) throw new TypeError("Failed to execute 'comparePoint' on 'Range': parameter 1 is not of type 'Node'.");
    // WrongDocumentError if `node`'s root differs from the range's root.
    if (ancestorChain(node)[0] !== ancestorChain(this.startContainer)[0]) {
      throw new globalThis.DOMException("The node provided is in a different tree than this Range.", 'WrongDocumentError');
    }
    if (node.nodeType === NODE_DOCTYPE) {
      throw new globalThis.DOMException("Failed to execute 'comparePoint' on 'Range': the node is a doctype.", 'InvalidNodeTypeError');
    }
    offset = offset >>> 0;   // WebIDL unsigned long
    if (offset > nodeLength(node)) {
      throw new globalThis.DOMException(`Failed to execute 'comparePoint' on 'Range': the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
    }
    // Offset-precise boundary comparison (node granularity can't tell
    // (div,0) from (div,1) when the point shares a container with an endpoint).
    if (compareBoundaryPoint(node, offset, this.startContainer, this.startOffset) < 0) return -1;
    if (compareBoundaryPoint(node, offset, this.endContainer, this.endOffset)   > 0) return  1;
    return 0;
  }
  isPointInRange(node, offset) {
    if (!isNodeArg(node)) throw new TypeError("Failed to execute 'isPointInRange' on 'Range': parameter 1 is not of type 'Node'.");
    // Different tree → false (NOT a throw, unlike comparePoint).
    if (ancestorChain(node)[0] !== ancestorChain(this.startContainer)[0]) return false;
    if (node.nodeType === NODE_DOCTYPE) {
      throw new globalThis.DOMException("Failed to execute 'isPointInRange' on 'Range': the node is a doctype.", 'InvalidNodeTypeError');
    }
    offset = offset >>> 0;
    if (offset > nodeLength(node)) {
      throw new globalThis.DOMException(`Failed to execute 'isPointInRange' on 'Range': the offset ${offset} is larger than the node's length.`, 'IndexSizeError');
    }
    if (compareBoundaryPoint(node, offset, this.startContainer, this.startOffset) < 0) return false;
    if (compareBoundaryPoint(node, offset, this.endContainer, this.endOffset)   > 0) return false;
    return true;
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
  // compareBoundaryPoints(how, sourceRange): compares the two ranges' boundary
  // points selected by `how`. `how` is a WebIDL unsigned short; a value outside
  // {0,1,2,3} → NotSupportedError. Different roots → WrongDocumentError.
  compareBoundaryPoints(how, other) {
    how = how & 0xFFFF;   // WebIDL unsigned short
    if (how > 3) {
      throw new globalThis.DOMException("Failed to execute 'compareBoundaryPoints' on 'Range': the comparison method must be 0, 1, 2 or 3.", 'NotSupportedError');
    }
    if (ancestorChain(this.startContainer)[0] !== ancestorChain(other.startContainer)[0]) {
      throw new globalThis.DOMException("The two Ranges are not in the same tree.", 'WrongDocumentError');
    }
    // START_TO_START 0, START_TO_END 1, END_TO_END 2, END_TO_START 3.
    let tn, to, on, oo;
    if (how === 0)      { tn = this.startContainer; to = this.startOffset; on = other.startContainer; oo = other.startOffset; }
    else if (how === 1) { tn = this.endContainer;   to = this.endOffset;   on = other.startContainer; oo = other.startOffset; }
    else if (how === 2) { tn = this.endContainer;   to = this.endOffset;   on = other.endContainer;   oo = other.endOffset; }
    else                { tn = this.startContainer; to = this.startOffset; on = other.endContainer;   oo = other.endOffset; }
    return compareBoundaryPoint(tn, to, on, oo);
  }
}
// Range boundary-comparison constants. Consumers read them off the
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
// Position of boundary point (nodeA, offsetA) relative to (nodeB,
// offsetB): -1 before, 0 equal, +1 after. DOM §4.5 "the position of a
// boundary point relative to a boundary point". Offset-precise — node
// granularity (compareDocOrder) can't tell (div,0)-(div,1) from
// (div,1)-(div,2), which Range.intersectsNode needs.
function compareBoundaryPoint(nodeA, offsetA, nodeB, offsetB) {
  if (nodeA === nodeB) return offsetA < offsetB ? -1 : offsetA > offsetB ? 1 : 0;
  // nodeA follows nodeB (incl. nodeA a descendant of nodeB) → invert
  // the comparison of B relative to A.
  if (compareDocOrder(nodeA, nodeB) > 0) return -compareBoundaryPoint(nodeB, offsetB, nodeA, offsetA);
  // nodeA is an ancestor of nodeB → after iff the child of nodeA on
  // the path to nodeB sits before offsetA.
  if (nodeContains(nodeA, nodeB)) {
    let child = nodeB;
    while (child && child._parent !== nodeA) child = child._parent;
    if (child) return nodeA._children.indexOf(child) < offsetA ? 1 : -1;
  }
  // nodeA precedes nodeB and is not an ancestor → before.
  return -1;
}
export function rangeIntersectsNode(range, node) {
  if (!range.startContainer) return false;
  // Spec step 1: if node's root is not the range's root, return false. Use the
  // node-tree root (getRootNode stops at a shadow boundary) — `_parent` crosses
  // into the host's light tree (ShadowRoot._parent IS its host), so a node in a
  // different shadow tree would otherwise share the document root and wrongly
  // intersect.
  if (node.getRootNode() !== range.startContainer.getRootNode()) return false;
  const parent = node._parent;
  if (!parent) return true;            // node is its own root → intersects
  const offset = parent._children.indexOf(node);
  // (parent, offset) is before end AND (parent, offset+1) is after start.
  return compareBoundaryPoint(parent, offset, range.endContainer, range.endOffset) < 0 &&
         compareBoundaryPoint(parent, offset + 1, range.startContainer, range.startOffset) > 0;
}
// The child of `ancestor` on the path down to `descendant` (the "partially
// contained child" in the Range algorithms), or null if `descendant` isn't a
// descendant of `ancestor`.
function __rangeAncestorChild (ancestor, descendant) {
  let cur = descendant;
  while (cur && cur._parent && cur._parent !== ancestor) cur = cur._parent;
  return cur && cur._parent === ancestor ? cur : null;
}
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

// True for the CharacterData node types whose contents a range slices by offset.
function isCharacterData(n) {
  return n != null && (n.nodeType === NODE_TEXT || n.nodeType === NODE_CDATA ||
                       n.nodeType === NODE_COMMENT || n.nodeType === NODE_PI);
}
// The shared DOM algorithm for Range cloneContents / extractContents /
// deleteContents (DOM §4.5). `mode`:
//   'clone'   — copy contained nodes into a returned fragment; tree unchanged.
//   'extract' — move contained nodes into a returned fragment; tree mutated.
//   'delete'  — remove contained nodes; no fragment, tree mutated.
// Partially-contained boundary children are recursed into (their contained
// slice is cloned/moved/deleted) so all three modes share one structure. For
// the mutating modes the range collapses to the precomputed (newNode, newOffset).
function processRangeContents(range, mode) {
  const sc = range.startContainer, so = range.startOffset;
  const ec = range.endContainer,   eo = range.endOffset;
  const ownerDoc = (sc && (sc.nodeType === NODE_DOC ? sc : sc.ownerDocument)) || globalThis.document;
  const frag = mode === 'delete' ? null : ownerDoc.createDocumentFragment();
  if (!sc || !ec) return frag;
  // Collapsed range: nothing contained.
  if (sc === ec && so === eo) return frag;

  // Single CharacterData container: slice [so, eo) of the one node.
  if (sc === ec && isCharacterData(sc)) {
    if (mode !== 'delete') {
      const clone = sc.cloneNode(false);
      clone._data = (sc.data || '').slice(so, eo);
      frag.appendChild(clone);
    }
    if (mode !== 'clone') sc._replaceData(so, eo - so, '');
    return frag;
  }

  const common  = range.commonAncestorContainer;
  // First / last partially-contained child of the common ancestor — the child
  // on the path to the start / end node, unless that node is an inclusive
  // ancestor of the other boundary node (then there is no partial on that side).
  const firstPC = nodeContains(sc, ec) ? null : __rangeAncestorChild(common, sc);
  const lastPC  = nodeContains(ec, sc) ? null : __rangeAncestorChild(common, ec);
  // Fully-contained children of the common ancestor, in tree order.
  const contained = [];
  const kids = common._children || [];
  for (let i = 0; i < kids.length; i++) {
    if (compareBoundaryPoint(common, i, sc, so) >= 0 &&
        compareBoundaryPoint(common, i + 1, ec, eo) <= 0) {
      contained.push(kids[i]);
    }
  }

  // Where a mutating range collapses to once its contents are gone.
  let newNode = sc, newOffset = so;
  if (mode !== 'clone' && !nodeContains(sc, ec)) {
    let ref = sc;
    while (ref._parent && !nodeContains(ref._parent, ec)) ref = ref._parent;
    newNode   = ref._parent;
    newOffset = newNode._children.indexOf(ref) + 1;
  }

  // First partially-contained child.
  if (isCharacterData(firstPC)) {
    if (mode !== 'delete') {
      const clone = sc.cloneNode(false);
      clone._data = (sc.data || '').slice(so);
      frag.appendChild(clone);
    }
    if (mode !== 'clone') sc._replaceData(so, nodeLength(sc) - so, '');
  } else if (firstPC) {
    let clone = null;
    if (mode !== 'delete') { clone = firstPC.cloneNode(false); frag.appendChild(clone); }
    const sub = new DocumentOrderRange(ownerDoc);
    sub.startContainer = sc;      sub.startOffset = so;
    sub.endContainer   = firstPC; sub.endOffset   = nodeLength(firstPC);
    const subResult = processRangeContents(sub, mode);
    if (clone) clone.appendChild(subResult);
    if (sub._reg) sub._reg.delete(sub);
  }

  // Fully-contained children: clone (deep), move, or remove.
  for (const child of contained) {
    if (mode === 'clone') frag.appendChild(child.cloneNode(true));
    else if (mode === 'extract') frag.appendChild(child);
    else if (child._parent) child._parent.removeChild(child);
  }

  // Last partially-contained child.
  if (isCharacterData(lastPC)) {
    if (mode !== 'delete') {
      const clone = ec.cloneNode(false);
      clone._data = (ec.data || '').slice(0, eo);
      frag.appendChild(clone);
    }
    if (mode !== 'clone') ec._replaceData(0, eo, '');
  } else if (lastPC) {
    let clone = null;
    if (mode !== 'delete') { clone = lastPC.cloneNode(false); frag.appendChild(clone); }
    const sub = new DocumentOrderRange(ownerDoc);
    sub.startContainer = lastPC; sub.startOffset = 0;
    sub.endContainer   = ec;     sub.endOffset   = eo;
    const subResult = processRangeContents(sub, mode);
    if (clone) clone.appendChild(subResult);
    if (sub._reg) sub._reg.delete(sub);
  }

  if (mode !== 'clone') {
    range.startContainer = newNode; range.startOffset = newOffset;
    range.endContainer   = newNode; range.endOffset   = newOffset;
  }
  return frag;
}
export function deleteRangeContents (range) { processRangeContents(range, 'delete'); }
export function cloneRangeContents  (range) { return processRangeContents(range, 'clone'); }
export function extractRangeContents(range) { return processRangeContents(range, 'extract'); }
DocumentOrderRange.END_TO_START   = 3;
DocumentOrderRange.prototype.START_TO_START = 0;
DocumentOrderRange.prototype.START_TO_END   = 1;
DocumentOrderRange.prototype.END_TO_END     = 2;
DocumentOrderRange.prototype.END_TO_START   = 3;
globalThis.Range = DocumentOrderRange;

// StaticRange (DOM §StaticRange) — a lightweight, immutable range snapshot.
// Unlike Range it does NOT validate offsets against node length and is not kept
// live as the tree mutates; the constructor's only validity check rejects
// DocumentType / Attr containers. `collapsed` is start === end (same container
// and offset). Consumed by input-events libraries via getTargetRanges().
class StaticRange {
  constructor(init) {
    // WebIDL: the four StaticRangeInit members are all required, and the two
    // containers are non-nullable `Node` — a missing or null value (or a
    // non-Node) is a TypeError before any other step.
    const i = init == null ? {} : init;
    if (!isNodeArg(i.startContainer) || !isNodeArg(i.endContainer)) {
      throw new TypeError("Failed to construct 'StaticRange': a required Node member is undefined or null.");
    }
    if (i.startOffset === undefined || i.endOffset === undefined) {
      throw new TypeError("Failed to construct 'StaticRange': a required offset member is undefined.");
    }
    if (i.startContainer.nodeType === NODE_DOCTYPE || i.startContainer.nodeType === NODE_ATTRIBUTE ||
        i.endContainer.nodeType === NODE_DOCTYPE   || i.endContainer.nodeType === NODE_ATTRIBUTE) {
      throw new globalThis.DOMException(
        "Failed to construct 'StaticRange': a DocumentType or Attr node may not be a container.",
        'InvalidNodeTypeError'
      );
    }
    this._startContainer = i.startContainer;
    this._startOffset    = i.startOffset >>> 0;   // WebIDL unsigned long (ToUint32)
    this._endContainer   = i.endContainer;
    this._endOffset      = i.endOffset >>> 0;
  }
  get startContainer() { return this._startContainer; }
  get startOffset()    { return this._startOffset; }
  get endContainer()   { return this._endContainer; }
  get endOffset()      { return this._endOffset; }
  get collapsed() {
    return this._startContainer === this._endContainer && this._startOffset === this._endOffset;
  }
}
globalThis.StaticRange = StaticRange;

// `XMLSerializer.serializeToString(node)` — produce an XML serialization of a
// node, implementing the DOM Parsing and Serialization "XML serialization"
// algorithm (https://w3c.github.io/DOM-Parsing/): a namespace prefix map,
// generated `ns${n}:` prefixes, and nearest-declared prefix selection for
// namespaced attributes. The structure mirrors the spec step-for-step (and the
// reference w3c-xmlserializer port). The require-well-formed checks (which throw
// InvalidStateError on data that has no well-formed XML serialization) are
// present but gated on `refs.wf`: ON for the `innerHTML`/`outerHTML` getters in
// an XML document, OFF for `XMLSerializer.serializeToString` (which never throws
// on well-formedness).
//
// A few subtests in the vendored WPT file are mutually CONTRADICTORY — the
// namespace-prefix algorithm changed across spec revisions (DOM-Parsing issues
// #29/#44/#45/#47/#52) and the file mixes old and new expectations, so no single
// serializer passes all of them. Where the file is self-consistent we follow what
// Chrome / Firefox actually do (CLAUDE.md rule 1: "spec-correct means what real
// browsers do"); where it contradicts itself we follow the revision that passes
// the MOST subtests. The residual out-of-scope failures (wpt_out_of_scope.yml),
// all verified directly against Chrome:
//   - "Drop inconsistent xmlns by matching on local name" — abandoned revision;
//     Chrome keeps the literal xmlns attrs (fails the subtest too).
//   - "...prefix of an attribute is NOT preserved..." (issue #29) — Chrome
//     preserves the author prefix (fails the subtest too); only the old revision
//     generated `ns1`.
//   - "...prefix bound to an empty namespace URI..." — Chrome KEEPS `xmlns=""`
//     here and PASSES this subtest, but only by then FAILING the
//     "redundant/inconsistent xmlns is dropped" subtests (it keeps every redundant
//     xmlns). We instead drop redundant xmlns aggressively, passing those two drop
//     subtests at the cost of this one — strictly more of the file either way.
//
// HTML void elements serialize self-closed only when childless; HTML elements
// with children (and all other tags) get an explicit end tag.
const XML_SER_VOID = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr',
  'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source',
  'track', 'wbr'
]);
// The XML `Char` production (a valid surrogate pair, or a permitted BMP code
// unit — excludes lone surrogates, NUL, and most C0 controls like U+000C). Used
// only when require-well-formed is on (the innerHTML getter in an XML document),
// to reject text/comment/PI data a real browser can't serialize.
function xmlSerIsXmlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {              // high surrogate: must pair
      const n = s.charCodeAt(i + 1);
      if (n >= 0xDC00 && n <= 0xDFFF) { i++; continue; }
      return false;                                // lone high surrogate
    }
    if (c >= 0xDC00 && c <= 0xDFFF) return false;  // lone low surrogate
    if (c === 0x9 || c === 0xA || c === 0xD) continue;
    if (c >= 0x20 && c <= 0xD7FF) continue;
    if (c >= 0xE000 && c <= 0xFFFD) continue;
    return false;                                  // NUL / C0 control (e.g. U+000C) / U+FFFE-F
  }
  return true;
}
function xmlSerWfThrow(message) { throw new globalThis.DOMException(message, 'InvalidStateError'); }
function xmlSerLocalName(el) { return el._localName || el._tag; }
// Build the spec's "attribute list" from our `_attrs` (name→value) +
// `_attrNS` (name→{ns,prefix,localName}) sidecar, preserving insertion order.
// An attribute with no `_attrNS` entry is an ordinary null-namespace attribute.
function xmlSerAttrList(el) {
  const list  = [];
  const attrs = el._attrs || {};
  const meta  = el._attrNS;
  for (const key of Object.keys(attrs)) {
    const m = meta && meta[key];
    list.push({
      namespaceURI: m ? (m.ns || null) : null,
      prefix:       m ? (m.prefix || null) : null,
      localName:    m ? m.localName : key,
      value:        attrs[key]
    });
  }
  return list;
}
function xmlSerEscapeAttrValue(value) {
  if (value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}
// A namespace prefix map: namespace-URI string → ordered list of prefixes. We
// copy it per element with the inner arrays cloned, so a prefix a child declares
// for an inherited namespace can't leak into a sibling serialized later (the
// spec's "copy" is a deep copy; a shallow copy would share the arrays).
function xmlSerCopyMap(map) {
  const out = Object.create(null);
  for (const ns in map) out[ns] = map[ns].slice();
  return out;
}
function xmlSerGeneratePrefix(map, newNamespace, refs) {
  const generated = 'ns' + refs.prefixIndex;
  refs.prefixIndex += 1;
  map[newNamespace] = [generated];
  return generated;
}
function xmlSerPreferredPrefix(map, ns, preferredPrefix) {
  const candidates = map[ns];
  if (!candidates) return null;
  if (candidates.includes(preferredPrefix)) return preferredPrefix;
  return candidates[candidates.length - 1];
}
// Is `prefix` already bound to some namespace in `map`? Used to decide whether a
// namespaced attribute can reuse its own author prefix (e.g. `xl:type`) or must
// fall back to a generated `ns${n}:` prefix because its prefix is taken.
function xmlSerPrefixInUse(map, prefix) {
  for (const ns in map) if (map[ns].includes(prefix)) return true;
  return false;
}
// "Record the namespace information": fold the element's xmlns / xmlns:* attrs
// into `map` + `localPrefixes`, and return the element's default-namespace
// declaration value (or null).
function xmlSerRecordNamespaces(el, map, localPrefixes) {
  let defaultNamespaceAttrValue = null;
  for (const attr of xmlSerAttrList(el)) {
    // A literal `xmlns` attribute that landed outside the xmlns namespace — e.g.
    // via `setAttribute('xmlns', …)` or HTML parsing (which keeps it as a plain
    // null-namespace attribute) — is still a default-namespace declaration for
    // serialization. Record its value so the element doesn't ALSO emit its own
    // `xmlns="…"` declaration duplicating it (browsers collapse the two when the
    // values agree, e.g. `<html xmlns="http://www.w3.org/1999/xhtml">`; a
    // disagreeing literal value is still serialized as a plain attribute).
    if (attr.namespaceURI === null && attr.localName === 'xmlns' && attr.prefix === null) {
      defaultNamespaceAttrValue = attr.value;
      continue;
    }
    if (attr.namespaceURI !== XMLNS_NS) continue;
    if (attr.prefix === null) { defaultNamespaceAttrValue = attr.value; continue; }
    let namespaceDefinition = attr.value;
    if (namespaceDefinition === XML_NS) continue;
    if (namespaceDefinition === null) namespaceDefinition = '';
    if (map[namespaceDefinition] && map[namespaceDefinition].includes(attr.localName)) continue;
    if (!map[namespaceDefinition]) map[namespaceDefinition] = [];
    map[namespaceDefinition].push(attr.localName);
    localPrefixes[attr.localName] = namespaceDefinition;
  }
  return defaultNamespaceAttrValue;
}
function xmlSerSerializeAttributes(el, map, localPrefixes, ignoreNamespaceDefAttr, refs) {
  let result = '';
  for (const attr of xmlSerAttrList(el)) {
    const attributeNamespace = attr.namespaceURI;
    let candidatePrefix = null;
    if (attributeNamespace !== null) {
      candidatePrefix = xmlSerPreferredPrefix(map, attributeNamespace, attr.prefix);
      if (attributeNamespace === XMLNS_NS) {
        if (attr.value === XML_NS ||
            (attr.prefix === null && ignoreNamespaceDefAttr) ||
            (attr.prefix !== null && localPrefixes[attr.localName] !== attr.value &&
              map[attr.value] && map[attr.value].includes(attr.localName))) {
          continue;
        }
        if (attr.prefix === 'xmlns') candidatePrefix = 'xmlns';
      } else if (candidatePrefix === null) {
        // The namespace isn't mapped to any prefix yet. Real browsers reuse the
        // attribute's own author prefix (`xl:type` stays `xl:type`) when that
        // prefix is still free, and only fall back to a generated `ns${n}:`
        // prefix when the attribute has none or its prefix is already bound to
        // another namespace (`xmlns:p` taken → generate). This matches Chrome /
        // Firefox; the literal w3c-xmlserializer reference always generates.
        if (attr.prefix !== null && attr.prefix !== 'xmlns' && !xmlSerPrefixInUse(map, attr.prefix)) {
          candidatePrefix = attr.prefix;
          if (map[attributeNamespace]) map[attributeNamespace].push(candidatePrefix);
          else map[attributeNamespace] = [candidatePrefix];
        } else {
          candidatePrefix = xmlSerGeneratePrefix(map, attributeNamespace, refs);
        }
        result += ' xmlns:' + candidatePrefix + '="' + xmlSerEscapeAttrValue(attributeNamespace) + '"';
      }
    }
    result += ' ';
    if (candidatePrefix !== null) result += candidatePrefix + ':';
    // require-well-formed: an attribute local name can't contain ':' (its prefix
    // is carried separately) and its value must be valid XML Char.
    if (refs.wf && (String(attr.localName).indexOf(':') !== -1 || !xmlSerIsXmlChar(String(attr.value == null ? '' : attr.value)))) {
      xmlSerWfThrow('Failed to serialize XML: attribute is not well-formed.');
    }
    result += attr.localName + '="' + xmlSerEscapeAttrValue(attr.value) + '"';
  }
  return result;
}
function xmlSerSerializeElement(node, namespace, prefixMap, refs) {
  // require-well-formed (the innerHTML getter in an XML document): a local name
  // containing ':' has no well-formed XML serialization → InvalidStateError.
  if (refs.wf && xmlSerLocalName(node).indexOf(':') !== -1) {
    xmlSerWfThrow("Failed to serialize XML: an element's local name contains ':'.");
  }
  let markup = '<';
  let qualifiedName = '';
  let skipEndTag = false;
  let ignoreNamespaceDefAttr = false;
  const map = xmlSerCopyMap(prefixMap);
  const localPrefixes = Object.create(null);
  const localDefaultNamespace = xmlSerRecordNamespaces(node, map, localPrefixes);
  let inheritedNs = namespace;
  const ns = node._ns || null;
  if (inheritedNs === ns) {
    if (localDefaultNamespace !== null) ignoreNamespaceDefAttr = true;
    qualifiedName = ns === XML_NS ? 'xml:' + xmlSerLocalName(node) : xmlSerLocalName(node);
    markup += qualifiedName;
  } else {
    let prefix = node._prefix || null;
    let candidatePrefix = xmlSerPreferredPrefix(map, ns, prefix);
    if (prefix === 'xmlns') candidatePrefix = 'xmlns';
    if (candidatePrefix !== null) {
      qualifiedName = candidatePrefix + ':' + xmlSerLocalName(node);
      if (localDefaultNamespace !== null && localDefaultNamespace !== XML_NS) {
        inheritedNs = localDefaultNamespace === '' ? null : localDefaultNamespace;
      }
      markup += qualifiedName;
    } else if (prefix !== null) {
      if (prefix in localPrefixes) prefix = xmlSerGeneratePrefix(map, ns, refs);
      if (map[ns]) map[ns].push(prefix);
      else map[ns] = [prefix];
      qualifiedName = prefix + ':' + xmlSerLocalName(node);
      markup += qualifiedName + ' xmlns:' + prefix + '="' + xmlSerEscapeAttrValue(ns) + '"';
      if (localDefaultNamespace !== null) {
        inheritedNs = localDefaultNamespace === '' ? null : localDefaultNamespace;
      }
    } else if (localDefaultNamespace === null || localDefaultNamespace !== ns) {
      ignoreNamespaceDefAttr = true;
      qualifiedName = xmlSerLocalName(node);
      inheritedNs = ns;
      markup += qualifiedName + ' xmlns="' + xmlSerEscapeAttrValue(ns) + '"';
    } else {
      qualifiedName = xmlSerLocalName(node);
      inheritedNs = ns;
      markup += qualifiedName;
    }
  }

  markup += xmlSerSerializeAttributes(node, map, localPrefixes, ignoreNamespaceDefAttr, refs);

  const kids = node._children || [];
  if (ns === HTML_NS && kids.length === 0 && XML_SER_VOID.has(xmlSerLocalName(node))) {
    markup += ' /';
    skipEndTag = true;
  } else if (ns !== HTML_NS && kids.length === 0) {
    markup += '/';
    skipEndTag = true;
  }
  markup += '>';
  if (skipEndTag) return markup;

  if (ns === HTML_NS && xmlSerLocalName(node) === 'template' && node.content) {
    markup += xmlSerSerializeNode(node.content, inheritedNs, map, refs);
  } else {
    for (const child of kids) markup += xmlSerSerializeNode(child, inheritedNs, map, refs);
  }
  markup += '</' + qualifiedName + '>';
  return markup;
}
function xmlSerSerializeDoctype(dt) {
  let markup = '<!DOCTYPE ' + dt.name;
  if (dt.publicId) markup += ' PUBLIC "' + dt.publicId + '"';
  else if (dt.systemId) markup += ' SYSTEM';
  if (dt.systemId) markup += ' "' + dt.systemId + '"';
  return markup + '>';
}
function xmlSerSerializeNode(node, namespace, prefixMap, refs) {
  switch (node.nodeType) {
    case NODE_ELEMENT:  return xmlSerSerializeElement(node, namespace, prefixMap, refs);
    case NODE_TEXT: {
      const data = node._data == null ? '' : String(node._data);
      if (refs.wf && !xmlSerIsXmlChar(data)) {
        xmlSerWfThrow('Failed to serialize XML: text node data contains a character not allowed by the XML Char production.');
      }
      return escapeText(node._data == null ? '' : node._data);
    }
    case NODE_CDATA: {
      const data = String(node._data == null ? '' : node._data);
      if (refs.wf && (!xmlSerIsXmlChar(data) || data.indexOf(']]>') !== -1)) {
        xmlSerWfThrow('Failed to serialize XML: CDATA section data is not well-formed.');
      }
      return '<![CDATA[' + node._data + ']]>';
    }
    case NODE_COMMENT: {
      const data = String(node._data == null ? '' : node._data);
      if (refs.wf && (!xmlSerIsXmlChar(data) || data.indexOf('--') !== -1 || data.endsWith('-'))) {
        xmlSerWfThrow('Failed to serialize XML: comment node data is not well-formed.');
      }
      return '<!--' + node._data + '-->';
    }
    case NODE_PI: {
      const data = String(node._data == null ? '' : node._data);
      const target = String(node._target == null ? '' : node._target);
      // require-well-formed: a PI target may not contain ':' nor be an ASCII
      // case-insensitive match for "xml", and its data must be valid XML Char and
      // not contain the PI close `?>`.
      if (refs.wf && (target.indexOf(':') !== -1 || /^xml$/i.test(target) ||
                      !xmlSerIsXmlChar(data) || data.indexOf('?>') !== -1)) {
        xmlSerWfThrow('Failed to serialize XML: processing instruction node is not well-formed.');
      }
      return '<?' + node._target + ' ' + node._data + '?>';
    }
    case NODE_DOCTYPE:  return xmlSerSerializeDoctype(node);
    case NODE_ATTRIBUTE: return '';
    case NODE_DOC:
    case NODE_FRAGMENT: {
      let out = '';
      for (const child of (node._children || [])) out += xmlSerSerializeNode(child, namespace, prefixMap, refs);
      return out;
    }
    default: return '';
  }
}
// The XML serialization of an element's CHILDREN, with a fresh namespace context
// (context namespace null). This is the "inner XML" an Element's `innerHTML`
// getter returns in an XML document, run with require-well-formed = true (so a
// child element with a ':' local name or a text node with an illegal character
// throws InvalidStateError, per the spec's fragment serialization).
function xmlSerializeInner(el) {
  const map = Object.create(null);
  map[XML_NS] = ['xml'];
  const refs = {prefixIndex: 1, wf: true};
  let out = '';
  for (const c of (el._children || [])) out += xmlSerSerializeNode(c, null, map, refs);
  return out;
}
// The XML serialization of an element ITSELF — the "outer XML" an Element's
// `outerHTML` getter returns in an XML document (also require-well-formed).
function xmlSerializeOuter(el) {
  const map = Object.create(null);
  map[XML_NS] = ['xml'];
  return xmlSerSerializeNode(el, null, map, {prefixIndex: 1, wf: true});
}
class XMLSerializer {
  serializeToString(node) {
    if (!node || typeof node.nodeType !== 'number') {
      throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
    }
    const map = Object.create(null);
    map[XML_NS] = ['xml'];
    return xmlSerSerializeNode(node, null, map, {prefixIndex: 1});
  }
}
globalThis.XMLSerializer = XMLSerializer;

// An element is inert when it (or an ancestor) carries the `inert` attribute.
// Inert ancestry, like `hidden` / `display:none`, makes a focused element no
// longer focusable.
function inInertSubtree(n) {
  for (let cur = n; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
    if (cur._attrs.inert != null) return true;
  }
  return false;
}
// HTML "check that the focused area is still focusable", which a real browser
// runs in its rendering update: if the currently-focused element has become
// non-focusable (moved into an inert / hidden / display:none subtree, or
// disconnected), the document loses focus — but ASYNCHRONOUSLY, so the element
// is still `document.activeElement` synchronously right after the mutation and
// blurs on a later task. `moveBefore` is the entry point that needs this
// because, unlike removeChild, it preserves focus across the relocation.
function resetFocusIfUnfocusableAfterMove() {
  const doc = globalThis.document;
  const ae  = doc && doc._activeElement;
  if (!ae) return;
  if (isFocusable(ae) && !inInertSubtree(ae)) return;   // still focusable → keep
  globalThis.setTimeout(() => {
    if (doc._activeElement !== ae) return;                       // focus moved meanwhile
    if (isFocusable(ae) && !inInertSubtree(ae)) return;          // became focusable again
    doc._activeElement = null;                                   // → activeElement falls back to <body>
    try { dispatchEvent(ae, new FocusEvent('blur',     { bubbles: false, cancelable: false, composed: true })); } catch (_) {}
    try { dispatchEvent(ae, new FocusEvent('focusout', { bubbles: true,  cancelable: false, composed: true })); } catch (_) {}
  }, 0);
}

// `ParentNode.moveBefore(node, child)` (DOM "atomic move") — relocates `node` to
// be before `child` in this parent WITHOUT removing-and-reinserting, so the
// node's connectedness never changes and no connected/disconnected reactions
// fire. It is stricter than insertBefore: only an Element or CharacterData node
// can move, and `node` and this parent must share a shadow-including root.
// Installed only on the ParentNode interfaces (Element / Document /
// DocumentFragment), never on Node — `"moveBefore" in textNode` must be false.
function moveBeforeImpl(node, child) {
  // WebIDL: moveBefore(Node node, Node? child) — both args required; `node` is
  // non-nullable, `child` is nullable (null/undefined both mean "to the end").
  if (arguments.length < 2) {
    throw new TypeError("Failed to execute 'moveBefore': 2 arguments required");
  }
  assertNodeArg(node);
  if (child != null) assertNodeArg(child);

  const parent = this;
  // Ensure pre-move validity (https://whatpr.org/dom/1307.html#concept-node-ensure-pre-move-validity).
  // 1. node and parent must share a shadow-including root. `composed: true`
  //    crosses shadow boundaries (ShadowRoot._parent = host) — plain
  //    getRootNode() now stops at a shadow root per spec. This subsumes the
  //    "both connected", cross-document and cross-tree cases.
  if (node.getRootNode({ composed: true }) !== parent.getRootNode({ composed: true })) {
    throw hierarchyError('moveBefore: node and new parent are not in the same tree');
  }
  // 2. node must not be a (host-including) inclusive ancestor of parent.
  if (isInclusiveAncestor(node, parent)) {
    throw hierarchyError('moveBefore: the moved node is an ancestor of the new parent');
  }
  // 3. a non-null reference child must actually be a child of parent.
  if (child != null && child._parent !== parent) {
    throw new globalThis.DOMException('The reference child is not a child of this node', 'NotFoundError');
  }
  // 4. only an Element or CharacterData node may be moved (NOT a
  //    DocumentFragment, DocumentType, or Document — stricter than insertBefore).
  const t = node.nodeType;
  if (t !== NODE_ELEMENT && t !== NODE_TEXT && t !== NODE_CDATA && t !== NODE_COMMENT && t !== NODE_PI) {
    throw hierarchyError(`moveBefore: a ${nodeTypeName(node)} node cannot be moved`);
  }
  // 5. document-child constraints: a Text/CDATA node can't be a document child,
  //    and a document holds at most one element child.
  if (parent.nodeType === NODE_DOC) {
    if (t === NODE_TEXT || t === NODE_CDATA) {
      throw hierarchyError('moveBefore: a Text node cannot be a child of a Document');
    }
    if (t === NODE_ELEMENT && parent._children.some(c => c.nodeType === NODE_ELEMENT && c !== node)) {
      throw hierarchyError('moveBefore: a Document can contain only one element child');
    }
  }

  // Move. "If child is node, set child to node's next sibling" so moving a node
  // before itself is a no-op.
  let ref = child === node ? node.nextSibling : child;
  const oldParent = node._parent;
  let prevSib = null, nextSib = null;
  if (oldParent) {
    const oi = oldParent._children.indexOf(node);
    if (oi >= 0) {
      // Capture the removed node's adjacent siblings BEFORE the splice — by
      // record-delivery time `node` sits at its new position, so recordChildList
      // can't derive the removal record's siblings (matches removeChild).
      prevSib = oi > 0 ? oldParent._children[oi - 1] : null;
      nextSib = oi + 1 < oldParent._children.length ? oldParent._children[oi + 1] : null;
      // Live-range "removing steps": a range whose start/end is inside the moved
      // node snaps up to the old parent at the node's index — moveBefore mirrors
      // ordinary removal here (whatwg/dom: the atomic move "still" adjusts live
      // ranges like a remove). (dom/nodes/moveBefore/live-range-updates.html)
      liveRangesOnRemove(oldParent, node, oi);
      oldParent._children.splice(oi, 1);
    }
  }
  node._parent = parent;
  const ii = ref == null ? -1 : parent._children.indexOf(ref);
  let insertIdx;
  if (ii < 0) { parent._children.push(node); insertIdx = parent._children.length - 1; }
  else { parent._children.splice(ii, 0, node); insertIdx = ii; }
  // Live-range "insertion steps": a range anchored in the destination parent past
  // the insertion point shifts up by one — the second half of moveBefore's
  // remove-then-insert range fixup (verified against Chrome: cross-parent and
  // same-parent moves both bump a destination-anchored offset). Mirrors
  // insertBefore's liveRangesOnInsert.
  liveRangesOnInsert(parent, insertIdx, 1);
  // A single-select <select> keeps only the last selected <option>; moving an
  // option in or around can change that, so run the spec's selectedness
  // algorithm on both ends: the destination select (the moved option wins if
  // selected) and the source select (which may need a fresh default). This is
  // what makes the WPT moveBefore option/optgroup selectedness contract pass.
  askForReset(node);
  if (oldParent && oldParent !== parent) askForResetAfterRemoval(node, oldParent);

  // MutationObserver sees the relocation as a removal from the old parent and
  // an addition to the new one.
  if (oldParent) recordChildList(oldParent, [], [node], prevSib, nextSib);
  recordChildList(parent, [node], []);
  // Connectedness is unchanged (same shadow-including root). A connected move
  // still runs custom-element reactions per moved element — connectedMoveCallback,
  // or the legacy disconnected/connected pair — with isConnected staying true.
  if (isConnected(node)) fireCEMoveReactions(node);
  // A move into an inert / hidden subtree makes a focused descendant lose focus
  // (asynchronously), per HTML's focus-fixup in the rendering update.
  resetFocusIfUnfocusableAfterMove();
  return undefined;
}
Element.prototype.moveBefore = moveBeforeImpl;
Document.prototype.moveBefore = moveBeforeImpl;
DocumentFragment.prototype.moveBefore = moveBeforeImpl;

// `Element.prototype[Symbol.unscopables]` — the ChildNode / ParentNode mixin
// methods (and `slot` / `moveBefore`) are [Unscopable], so a `with`-scoped
// inline event handler resolves a bare `remove` / `append` / … to the global,
// not the element's method. Null-proto data property, {writable:false,
// enumerable:false, configurable:true} per WebIDL.
Object.defineProperty(Element.prototype, Symbol.unscopables, {
  value: Object.assign(Object.create(null), {
    after: true, append: true, before: true, prepend: true, remove: true,
    replaceChildren: true, replaceWith: true, slot: true, moveBefore: true,
  }),
  writable: false, enumerable: false, configurable: true,
});

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
// Monotonic per-node ordinal, assigned lazily on first use. Gives
// compareDocumentPosition a stable tiebreak for disconnected pairs so
// the same pair always reports the same direction (per spec).
let __nodeOrdinalSeq = 0;
function __nodeOrdinal(node) {
  if (node.__ordinal == null) {
    // Define non-enumerably so the ordinal never leaks into
    // `Object.keys(node)` / spread after a disconnected compare — the
    // rest of the DOM keeps its internal members non-enumerable for
    // exactly this reason.
    Object.defineProperty(node, '__ordinal', {
      value: ++__nodeOrdinalSeq, enumerable: false, writable: true, configurable: true
    });
  }
  return node.__ordinal;
}



// The stable, live Attr node for the attribute stored under `key`. Returned
// from `attributes` / `getAttributeNode`. `key` must already exist in the
// element's store (callers guard with hasOwnProperty). Identity is cached on
// the element so repeated reads return the same Attr (the XPath engine /
// Capybara's `native.attributes` read `value` / `name` / `namespaceURI` /
// `prefix` / `localName` / `ownerElement` off it).
function makeAttr(el, key) {
  return el._attrNodeFor(key);
}

// HTML parser closes over the DOM ctors. Install here so
const { parseXml } = installXmlParser({ Element, Text, Comment, ProcessingInstruction, CDATASection, DocumentType });
// parse5 is the ONE HTML parser now. The adapter maps parse5's tree ops onto our
// node ctors. `parse5ParseIntoLive` is the document load path (parse directly
// into the live document, reusing its skeleton); `parse5ParseDocument` is the
// one-shot fresh-document path (DOMParser, frame fallback, `<html>`-innerHTML);
// `parse5ParseFragment` backs `parseFragment` (innerHTML / outerHTML /
// insertAdjacentHTML / createContextualFragment), context-aware. The hand-rolled
// regex parser (installHtmlParser) is gone; html-parser.js keeps only the
// serializers.
const { parse5ParseIntoLive, parse5ParseFragment, parse5ParseDocument } = installParse5Adapter({
  Document, Element, Text, Comment, DocumentFragment, DocumentType,
  createHtmlPageDocument, registerSubtree, unregisterSubtree, newChildList, registerNamedAccess,
  windowForwardedHandlerName, activateWindowForwardedHandler
});
// `parseFragment(html, contextEl)` — HTML fragment parsing via parse5, in the
// context element's insertion mode (table / select / raw-text, …). Callers
// thread the spec fragment context.
const parseFragment = parse5ParseFragment;

// In an XML/XHTML document, `innerHTML` / `outerHTML` setting and
// `insertAdjacentHTML` parse markup with the XML fragment parsing algorithm (in
// `context`'s namespace scope) rather than the HTML parser. A not-well-formed
// fragment is a SyntaxError DOMException (and nothing is inserted), per spec.
function parseXmlFragment(html, context) {
  const nodes = parseXml(String(html === null ? '' : html), { context });
  if (nodes === null) {
    throw new globalThis.DOMException("The given markup is invalid XML, and therefore cannot be inserted into an XML document.", 'SyntaxError');
  }
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
  DocumentOrderRange,
  makeAttr,
  createHtmlPageDocument,
  parse5ParseDocument,
  parse5ParseIntoLive,
  parseFragment,
  parseXml,
  newChildList
};
