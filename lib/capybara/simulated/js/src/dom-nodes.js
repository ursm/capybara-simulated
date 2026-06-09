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
import { dispatchEvent }                                              from './dispatch.js';
import { recordAttrMutation, recordChildList, recordCharacterData, bumpSettleGen, currentSettleGen } from './mutation-observer.js';
import { walk, walkSubtree, isConnected, scriptText, stripOneLeadingNewline, findById } from './walk.js';
import { selectAll, selectFirst, matchesSelector, closestSelector }   from './selectors.js';
import { isVisibleNode, isLaidOutNode, INVISIBLE_TAGS, matchesAnyHideRule, selfHidden } from './cascade.js';
import { ceState, getCustomElementCtor, ceUpgradeTree, fireCEDisconnect, fireAttrChangedCallback, askForReset } from './custom-elements.js';
import { isContenteditable, formNamedAccess, toggleChecked, setRadio, isSubmitButton, formForControl, closeDialog, enclosingLabelFor, labeledControlFor, LABELABLE, isInteractiveForLabel } from './form-helpers.js';
import { makeStyleProxy }                                             from './style-proxy.js';
import { htmlCollection, nodeList, newChildList, makeNamedNodeMap }   from './dom-collections.js';
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
import { Event, InputEvent, MouseEvent, SubmitEvent, defaultPassiveValue, windowForwardedHandlerName, activateWindowForwardedHandler } from './events.js';
import { installHtmlParser, serializeChildren, serializeElement } from './html-parser.js';
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

// WebIDL: appendChild/insertBefore/replaceChild take non-nullable Node
// arguments, so a non-Node (null, undefined, a plain object) is a TypeError
// *before* the algorithm runs. Realm-safe: a duck-typed numeric nodeType is
// enough (avoids cross-document `instanceof` pitfalls).
function assertNodeArg(value) {
  if (value == null || typeof value.nodeType !== 'number') {
    throw new TypeError("Argument is not an object that implements Node");
  }
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
function attrKey(_el, name) { return asciiLower(String(name)); }

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
    // Per spec, identical {type, handler, capture} is deduped. The
    // identity for handler-object form is the original object, so
    // re-registering the same EventListener instance is a no-op.
    if (list.some(l => (l.handler === fn ||
                        (handler && l.handler._csimEventListenerObject === handler)) &&
                       l.capture === capture)) return;
    list.push({ handler: fn, capture, passive, once });
  }
  removeEventListener(type, handler, options) {
    if (!this._listeners || !this._listeners[type]) return;
    const capture = !!(options && (options === true || options.capture));
    this._listeners[type] = this._listeners[type].filter(l => {
      const isMatch = l.capture === capture && (
        l.handler === handler ||
        (handler && typeof handler.handleEvent === 'function' && l.handler._csimEventListenerObject === handler)
      );
      // Mark so an in-flight dispatch's snapshot skips this now-removed entry.
      if (isMatch) l.removed = true;
      return !isMatch;
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
    const copy = this._cloneShell();
    if (deep && this._children) {
      for (const c of this._children) {
        const cc = c.cloneNode(true);
        cc._parent = copy;
        copy._children.push(cc);
      }
      // A deep-cloned Document must re-establish its documentElement (the shell
      // is empty; the loop above only fills _children) and re-own its cloned
      // subtree — the copied nodes' _ownerDoc still points at the original, but
      // a document clone's descendants belong to the clone (like createDocument
      // / createHTMLDocument re-tag). ownerDocument drives tag-name casing,
      // createAttribute, the FrameController cross-document check, etc.
      if (copy.nodeType === NODE_DOC) {
        copy.documentElement = copy._children.find(c => c.nodeType === NODE_ELEMENT) || null;
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
      // `selfActivated` tracks whether `this` (the clicked element) ran its
      // OWN activation behaviour — checkbox/radio toggle, form submit,
      // reset, `<summary>` toggle, or a `<label>` hop. Per the single-
      // activation-behaviour spec only ONE activation runs per click, so
      // once `this` self-activates we must NOT also walk up and activate an
      // ANCESTOR hyperlink (the anchor block below). A non-prevented click
      // on a checkbox/radio is itself the activation.
      let selfActivated = isInputControl && !ev.defaultPrevented;
      let didSubmit = false;
      if (!ev.defaultPrevented && isSubmitButton(this)) {
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
    const node = convertNodesIntoNode(nodes);
    while (this._children.length) this.removeChild(this._children[this._children.length - 1]);
    this.appendChild(node);
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
    const connected = isConnected(this);
    for (const c of moved) { c._parent = this; registerSubtree(c); }
    recordChildList(this, moved.slice(), [], prevSib, nextSib);  // one addition record
    if (connected) for (const c of moved) globalThis.__csimFireCEConnect(c);
    for (const c of moved) askForReset(c);
    return frag;
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
    this._children.splice(i, 1);
    child._parent = null;
    unregisterSubtree(child);
    recordChildList(this, [], [child], prevSib, nextSib);
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
    if (ref == null) return this.appendChild(child);
    // DocumentFragment splice — same unwrap as appendChild, but
    // inserting before `ref` rather than at the end (one record each on the
    // fragment and on this, via the shared helper).
    if (child && child.nodeType === NODE_FRAGMENT) return this._insertFragmentChildren(child, ref);
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
    // https://dom.spec.whatwg.org/#concept-node-replace — same validity as
    // pre-insertion but the document-child constraints exclude `old` (the node
    // being replaced), and `old` must itself be a child (NotFoundError).
    assertNodeArg(neu);
    assertNodeArg(old);
    validateInsertion(neu, this, old, true);
    const i = this._children.indexOf(old);
    if (i < 0) return null;
    // Replacing a node with itself is a no-op — identity and position are
    // unchanged (spec: referenceChild becomes node's next sibling, so it lands
    // back in its own slot).
    if (neu === old) return old;
    // A DocumentFragment is inserted as its CHILDREN, never as itself. Remove
    // `old`, then insert the fragment before old's former next sibling
    // (`insertBefore` unwraps the fragment + handles registration/records).
    // Covers `document.replaceChild(frag, documentElement)`.
    if (neu.nodeType === NODE_FRAGMENT) {
      const ref = old.nextSibling;
      this.removeChild(old);
      this.insertBefore(neu, ref);
      return old;
    }
    const wasConnected = isConnected(this);
    // Cross-document `neu` is adopted into this node's document (the insert
    // steps adopt). `adoptNode` re-tags the subtree's ownerDocument AND detaches
    // `neu` from its old parent; gate on a real mismatch so the common
    // same-document replace stays a plain detach (no subtree walk).
    const destDoc = this.nodeType === NODE_DOC ? this : this._ownerDoc;
    if (destDoc && neu._ownerDoc !== destDoc && typeof destDoc.adoptNode === 'function') {
      destDoc.adoptNode(neu);
    } else if (neu._parent) {
      neu._parent.removeChild(neu);
    }
    // Re-find old's index: detaching `neu` above can shift it when `neu` was an
    // earlier sibling of `old` under this same parent.
    const j = this._children.indexOf(old);
    neu._parent = this;
    old._parent = null;
    this._children[j] = neu;
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
  get innerText() { return this.textContent; }
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
    if (prev === next) return;
    this._data = next;
    recordCharacterData(this, prev);
  }
  // The XPath engine reads these off every node for node tests / string-value.
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
  // Per DOM spec: split this text node into two at `offset`, keep the
  // prefix in `this`, return a new Text sibling holding the suffix
  // and inserted into the parent right after `this`. Discourse's
  // `HighlightedSearch` modifier calls splitText to wrap matched
  // substrings in `<span class="d-highlighted">`; without this, the
  // modifier throws and Glimmer aborts the rest of the modifier
  // install chain on that template (including `{{on "click"}}` on
  // search-result anchors).
  splitText(offset) {
    const len = this._data.length;
    if (offset < 0 || offset > len) {
      throw new globalThis.DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
    }
    const suffix = this._data.substring(offset);
    const newNode = new this.constructor(suffix);
    newNode._ownerDoc = this._ownerDoc;
    if (this._parent) {
      const idx = this._parent._children.indexOf(this);
      this._parent._children.splice(idx + 1, 0, newNode);
      newNode._parent = this._parent;
    }
    this.data = this._data.substring(0, offset);
    return newNode;
  }
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
    // appendData/insertData/replaceData take a non-nullable DOMString, so
    // null → "null" and undefined → "undefined" (no LegacyNullToEmptyString).
    // Per the "replace data" algorithm this ALWAYS queues a characterData
    // record — even for a no-op like appendData("") — so MutationObserver
    // tests waiting on the empty-mutation record don't hang.
    this._data = prev.slice(0, offset) + String(data) + prev.slice(offset + count);
    recordCharacterData(this, prev);
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
class ProcessingInstruction extends Text {
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
  get nodeValue()     { return null; }
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
  }
  _cloneShell() {
    const e = new Element(this._tag);
    e._attrs     = Object.assign({}, this._attrs);
    if (this._attrNS) e._attrNS = Object.assign({}, this._attrNS);
    e._ns        = this._ns;
    e._prefix    = this._prefix;
    e._localName = this._localName;
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
  get nodeValue()  { return null; }
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
  // `<iframe>` / `<frame>` nested browsing context — a same-realm nested
  // Document parsed from srcdoc / src (lazily, via the bridge frame loader).
  // contentWindow.DOMException etc. resolve to the shared globals, so
  // `instanceof` across the frame boundary works. Non-frame tags get null.
  get contentWindow() {
    if (this._tag !== 'iframe' && this._tag !== 'frame') return null;
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
  getAttribute(name)        { const v = this._attrs[attrKey(this, name)]; return v == null ? null : v; }
  setAttribute(name, value) {
    const qn = String(name);
    if (!isValidAttributeLocalName(qn)) {
      throw new globalThis.DOMException("'" + qn + "' is not a valid attribute name.", "InvalidCharacterError");
    }
    const n = attrKey(this, qn);
    const old = this._attrs[n];
    const next = String(value);
    this._attrs[n] = next;
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
    if (old !== next) fireAttrChangedCallback(this, n, old == null ? null : old, next, Element);
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
    const key = this._attrKeyByNS(rns, localName) || qn;   // replace existing (ns,localName)
    const old = this._attrs[key];
    const next = String(value);
    this._attrs[key] = next;
    if (rns !== null || prefix !== null) {
      (this._attrNS || (this._attrNS = {}))[key] = { ns: rns, prefix, localName };
    } else if (this._attrNS) {
      delete this._attrNS[key];
    }
    recordAttrMutation(this, key, old == null ? null : old);
    if (old !== next) fireAttrChangedCallback(this, key, old == null ? null : old, next, Element);
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
  removeAttribute(name) { this._removeAttrKey(attrKey(this, name)); }
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
    if (old === value) return;
    this._attrs[key] = value;
    recordAttrMutation(this, key, old == null ? null : old);
    fireAttrChangedCallback(this, key, old == null ? null : old, value, Element);
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
    const key = hasNs ? (this._attrKeyByNS(attr._ns, attr._localName) || qn) : asciiLower(qn);
    const old = this._attrs[key];
    this._attrs[key] = attr._value;
    if (hasNs) (this._attrNS || (this._attrNS = {}))[key] = { ns: attr._ns, prefix: attr._prefix, localName: attr._localName };
    else if (this._attrNS) delete this._attrNS[key];
    attr._ownerElement = this;
    attr._key = key;
    (this._attrNodes || (this._attrNodes = {}))[key] = attr;
    recordAttrMutation(this, key, old == null ? null : old);
    if (old !== attr._value) fireAttrChangedCallback(this, key, old == null ? null : old, attr._value, Element);
  }
  // Remove the attribute stored under the exact key `n` (no re-keying).
  _removeAttrKey(n) {
    if (!Object.prototype.hasOwnProperty.call(this._attrs, n)) return;
    const old = this._attrs[n];
    this._detachAttrNode(n);
    delete this._attrs[n];
    if (this._attrNS) delete this._attrNS[n];
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
    recordAttrMutation(this, n, old == null ? null : old);
    fireAttrChangedCallback(this, n, old == null ? null : old, null, Element);
  }
  hasAttribute(name)        { return Object.prototype.hasOwnProperty.call(this._attrs, attrKey(this, name)); }
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
  getAttributeNames() { return Object.keys(this._attrs); }
  // `attributes` returns a live-platform-object NamedNodeMap (a fresh snapshot
  // per access): indexed entries + supported named properties, with `length` /
  // `item` / `getNamedItem` on the prototype. Each entry is an Attr carrying the
  // fields consumers touch (`name`, `value`, `namespaceURI`, `prefix`,
  // `localName`, `ownerElement`). The XPath engine reads attributes straight
  // from the store, not through this collection.
  get attributes() {
    const el    = this;
    const names = Object.keys(this._attrs);
    const items = names.map(n => el._attrNodeFor(n));
    // Drop qualified names containing ASCII uppercase from the supported NAMED
    // properties for an HTML-namespace element in an HTML document (spec
    // "supported property names"). Indexed access + getNamedItem still reach
    // every attribute; only the named own-property is omitted.
    const dropUppercase = el._ns === HTML_NS && isHtmlDocument(el.ownerDocument);
    return makeNamedNodeMap(el, items, dropUppercase);
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
    const q = String(tag);
    const all = this.querySelectorAll('*');
    const htmlDoc = isHtmlDocument(this.ownerDocument);
    const qLower = htmlDoc ? asciiLower(q) : q;
    const out = [];
    for (const n of all) {
      if (n === this) continue;                       // our walk starts at the receiver
      if (q === '*') { out.push(n); continue; }
      const qn = n._prefix ? n._prefix + ':' + n._localName : n._localName;
      // HTML doc: lowercase the SEARCH, but compare against the element's
      // ACTUAL qualified name (parsed HTML elements are already lowercase; an
      // `createElementNS(HTML_NS, "I")` keeps "I" and so matches neither "I"
      // nor "i"). Don't lowercase the element's name.
      const ok = htmlDoc
        ? (n._ns === HTML_NS ? qn === qLower : qn === q)
        : qn === q;
      if (ok) out.push(n);
    }
    return htmlCollection(out);
  }
  getElementsByClassName(cls) { return htmlCollection(collectByClassName(this, cls)); }
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
    // HTML dirty-value flag: snapshot the parsed default once before the
    // first IDL write so `<form>.reset()` can restore it (see reset()).
    if (this._defaultValue === undefined) {
      this._defaultValue = (this._tag === 'textarea') ? this.textContent : (this._attrs.value || '');
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
    let changed = (this._attrs.selected != null) !== !!v;
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
          if (o !== this && o._attrs.selected != null) { delete o._attrs.selected; changed = true; }
        }
      }
    } else {
      delete this._attrs.selected;
    }
    // Selectedness drives `:checked`/`option[selected]` cascade + visible_text;
    // bump the settle generation those memos + settle key on (see `set checked`).
    if (changed) bumpSettleGen();
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
    return selectAll(this._children, 'option', this).filter(o => o._attrs.selected != null);
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
    return globalThis.document && globalThis.document.getElementById(id);
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
      const all = doc.getElementsByTagName('label');
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

  get innerHTML() { return serializeChildren(this); }
  set innerHTML(html) {
    // `<template>.innerHTML` setter populates the template's
    // `.content` fragment, not the template's own children (per
    // HTML spec — the inert subtree lives on the fragment).
    if (this._tag === 'template') {
      const frag = this.content;
      const tmplRemoved = frag._children.slice();
      for (const c of tmplRemoved) { c._parent = null; unregisterSubtree(c); }
      frag._children = newChildList();
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
    this._children = newChildList();
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
    const next = this.nextSibling;
    // `outerHTML` is `[LegacyNullToEmptyString]`: only `null` → "" — `undefined`
    // coerces normally to the string "undefined".
    const frag = parseFragment(html === null ? '' : String(html));
    parent.removeChild(this);
    for (const c of frag) parent.insertBefore(c, next);
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
    const frag = parseFragment(String(html == null ? '' : html));
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
    return this._insertAdjacent(position, element);
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

  // ── DOM Element method completeness (BATCH B2/B3) ───────────────
  hasAttributes() { return Object.keys(this._attrs).length > 0; }
  // `webkitMatchesSelector` is the legacy vendor alias of `matches`.
  webkitMatchesSelector(sel) { return this.matches(sel); }
  // Namespace-aware element queries collapse to the flat tag store.
  getElementsByTagNameNS(ns, local) { return htmlCollection(collectByTagNameNS(this, ns, local)); }
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
  // `scroll(...)` is the legacy synonym of `scrollTo(...)`.
  scroll(...args) { return this.scrollTo(...args); }
  // Pointer-capture API — no real pointer device, so capture is never
  // held. Methods are no-ops that satisfy feature-detecting callers.
  hasPointerCapture(_id) { return false; }
  setPointerCapture(_id) {}
  releasePointerCapture(_id) {}
  // HTML serialization helpers — `getHTML()` returns serialized
  // children; `setHTMLUnsafe(s)` parses markup into children. Both
  // route through the existing innerHTML path.
  getHTML(_options) { return this.innerHTML; }
  setHTMLUnsafe(markup) { const html = String(markup == null ? '' : markup); this.innerHTML = html; }

  // ── HTMLElement string / boolean reflection (BATCH C) ───────────
  get lang()  { return this._attrs.lang || ''; }
  set lang(v) { this.setAttribute('lang', String(v == null ? '' : v)); }
  get dir()   { return this._attrs.dir || ''; }
  set dir(v)  { this.setAttribute('dir', String(v == null ? '' : v)); }
  get nonce()  { return this._attrs.nonce || ''; }
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
        for (const o of el.querySelectorAll('option')) {
          if (o.getAttributeNode('selected')) o._attrs.selected = ''; else delete o._attrs.selected;
        }
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
    this._children = newChildList();
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
    const all = t === '*' ? this.querySelectorAll('*') : this.querySelectorAll(t);
    return htmlCollection(all.filter(n => n !== this));
  }
  getElementsByClassName(cls) { return htmlCollection(collectByClassName(this, cls)); }
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
  // `document.adoptedStyleSheets` — empty Array per spec when no
  // sheets adopted. Lit/Stencil's component init reads this.
  get adoptedStyleSheets()  { return []; }
  set adoptedStyleSheets(_) { /* discard */ }
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
  // The main document's window is the global; a nested (iframe) document
  // carries its own `_defaultView` (a frame-window proxy) set at load time.
  get defaultView()   { return this._defaultView || globalThis; }
  get parentWindow()  { return this.defaultView; }
  // Document node basics (BATCH H) — the Document node's own
  // nodeName / nodeValue / ownerDocument per DOM spec. (Document
  // inherits Node's ownerDocument, which would resolve to itself;
  // spec says a Document's ownerDocument is null.)
  get nodeName()      { return '#document'; }
  get nodeValue()     { return null; }
  get textContent()   { return null; }
  set textContent(_)  { /* spec: no-op for Document */ }
  get ownerDocument() { return null; }
  // Cloning a Document yields a new EMPTY document of the same kind, carrying
  // the content type — children are copied only on a deep clone (cloneNode
  // handles that + sets documentElement). The base shell would re-run the
  // constructor's html/head/body skeleton, leaving a shallow clone non-empty.
  _cloneShell() {
    const d = new this.constructor();
    d._children = newChildList();
    d.documentElement = null;
    d._contentType = this._contentType;
    if (this._url) d._url = this._url;   // preserve a frame doc's own URL (used by :target)
    d.readyState = 'complete';
    return d;
  }
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
    if (ae && isConnected(ae)) return ae;
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
  createElement(tag) {
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
    return this._createElement(ns, null, localName);
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
  createTextNode(data)   { const t = new Text(data);                                 t._ownerDoc = this; return t; }
  createComment(data)    { const c = new Comment(String(data == null ? '' : data));   c._ownerDoc = this; return c; }
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
    const root = this.documentElement;
    if (!root) return [];
    const want = String(tag).toLowerCase();
    const out  = want === '*' || root._tag === want ? [root] : [];
    const tail = root.getElementsByTagName(tag);
    for (let i = 0; i < tail.length; i++) out.push(tail[i]);
    return out;
  }
  getElementsByClassName(cls) { return htmlCollection(collectByClassName(this, cls)); }
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
      createHTMLDocument: (...args) => {
        const d = new Document();
        // Per spec the skeleton starts with a `<!DOCTYPE html>` node.
        const doctype = new DocumentType('html', '', '', d);
        doctype._parent = d;
        const html = new Element('html');
        const head = new Element('head');
        const body = new Element('body');
        html._children = newChildList([head, body]);
        head._parent = html; body._parent = html;
        d.documentElement = html;
        html._parent = d;
        d._children = newChildList([doctype, html]);
        // The `title` arg is created iff it was actually supplied (a present
        // `null` becomes the string "null"; an omitted/undefined arg adds no
        // <title> at all, per the WebIDL optional-DOMString semantics).
        if (args.length > 0 && args[0] !== undefined) {
          const t = new Element('title');
          t._children = newChildList([Object.assign(new Text(String(args[0])), { _parent: t })]);
          t._parent = head;
          head._children.push(t);
        }
        // Own the skeleton so every node reports this document as its owner,
        // consistent with nodes created via d.createElement (which set _ownerDoc).
        walkSubtree(d, n => { n._ownerDoc = d; });
        return d;
      },
      // createDocumentType(qualifiedName, publicId, systemId) — modern spec
      // validates only the name (a "valid doctype name"); no namespace checks.
      createDocumentType: (qualifiedName, publicId, systemId) => {
        const name = String(qualifiedName);
        if (!isValidDoctypeName(name)) {
          throw new globalThis.DOMException(
            `The qualified name '${name}' is not a valid doctype name.`, 'InvalidCharacterError');
        }
        return new DocumentType(name, publicId, systemId, this);
      },
      // createDocument(namespace, qualifiedName, doctype) — a fresh XMLDocument
      // with an optional root element (from the validated qualifiedName) and an
      // optional doctype, in [doctype?, element?] order.
      createDocument: (...args) => {
        if (args.length < 2) {
          throw new TypeError("Failed to execute 'createDocument': 2 arguments required.");
        }
        const namespace = args[0], qualifiedName = args[1], doctype = args[2];
        // WebIDL: the doctype arg is typed `DocumentType?` — reject anything else
        // up front (before any side effect), matching the real-browser TypeError.
        if (doctype != null && !(doctype instanceof DocumentType)) {
          throw new TypeError("Failed to execute 'createDocument': parameter 3 is not of type 'DocumentType'.");
        }
        const ns = (namespace == null || namespace === '') ? null : String(namespace);
        // WebIDL: qualifiedName is [LegacyNullToEmptyString] — only NULL maps to
        // "" (no root element); an explicit `undefined` becomes "undefined".
        const qn = qualifiedName === null ? '' : String(qualifiedName);
        // Validate the qualified name up front (throws before any side effect).
        let rns = null, prefix = null, localName = null;
        if (qn !== '') ({ namespace: rns, prefix, localName } = validateAndExtract(ns, qn, 'element'));
        const d = new XMLDocument();
        // contentType per the created document's namespace (spec).
        d._contentType = ns === HTML_NS ? 'application/xhtml+xml'
                       : ns === SVG_NS  ? 'image/svg+xml'
                       : 'application/xml';   // XML doc → isHtmlDocument false
        d._children = newChildList();                     // drop the HTML skeleton the Document ctor built
        d.documentElement = null;
        d.readyState = 'complete';            // fully constructed — no loading phase (the ctor's
                                              // 'loading' jQuery-self-schedule hack only fits the main doc)
        if (doctype != null) {
          // Spec appends the doctype, which adopts it — detach from any prior
          // parent first so a reused node can't live in two _children arrays.
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
          d._children.push(el);
          d.documentElement = el;
        }
        return d;
      },
      hasFeature: () => true
    };
  }

  // Minimal Range stub for `document.createRange()`. We don't model
  // partial-range selection (start/end offsets on text nodes etc.);
  // only document-order comparison between two nodes' start containers
  // via `compareBoundaryPoints`, which is all the consumers here drive.
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
    // WebIDL: root is a non-nullable Node; whatToShow is `unsigned long = 0xFFFFFFFF`
    // (omitted/undefined → default; null → ToUint32(null) = 0); filter is
    // `NodeFilter? = null` (undefined/null → null).
    if (!isNodeArg(root)) {
      throw new TypeError("Failed to execute 'createTreeWalker': parameter 1 is not of type 'Node'.");
    }
    whatToShow = whatToShow === undefined ? 0xFFFFFFFF : (whatToShow >>> 0);
    filter = filter == null ? null : filter;
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
  // Namespace-aware lookup collapses to the flat local-name query.
  getElementsByTagNameNS(ns, local) { return htmlCollection(collectByTagNameNS(this, ns, local)); }
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
  get compatMode()    { return 'CSS1Compat'; }
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
  // Consumers here only care that the start container ends up
  // referring to the node we passed.
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
    for (const c of parseFragment(String(html))) frag.appendChild(c);
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

// Remove (from the tree) the slice of `subtree` between the cuts.
// Mirror of __emitSlice / __cloneSlice (the clone traversal) but
// deleting in place instead of cloning, so extractContents leaves no
// duplicate originals and deleteContents removes exactly the selected
// remainder. A null cut means "no boundary on this side".
function __deleteSlice (subtree, startCut, endCut) {
  if (subtree.nodeType === NODE_TEXT) {
    const data = subtree.data || '';
    const lo = startCut && startCut.container === subtree ? startCut.offset : 0;
    const hi = endCut   && endCut.container === subtree   ? endCut.offset   : data.length;
    subtree.data = data.slice(0, lo) + data.slice(hi);
    return;
  }
  __emitSliceDelete(subtree, startCut, endCut);
}
function __emitSliceDelete (subtree, startCut, endCut) {
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
  // Trim the partially-contained start / end children in place first,
  // then drop the fully-contained middle children. (Recurse before
  // removing the middle so the cached index range stays valid.)
  if (startChild && startChild === endChild) {
    __deleteSlice(startChild, startCut, endCut);
    return;
  }
  if (startChild) __deleteSlice(startChild, startCut, null);
  if (endChild)   __deleteSlice(endChild, null, endCut);
  for (let i = endIdx - 1; i >= startIdx; i--) {
    if (kids[i]) subtree.removeChild(kids[i]);
  }
}
export function deleteRangeContents (range) {
  const sc = range.startContainer, so = range.startOffset | 0;
  const ec = range.endContainer,   eo = range.endOffset | 0;
  // Text nodes also carry an (empty) `_children` array, so the
  // character-trim case must be checked BEFORE the child-index case or
  // a same-Text-node range silently no-ops.
  if (sc === ec && sc && sc.nodeType === NODE_TEXT) {
    const data = sc.data || '';
    sc.data = data.slice(0, so) + data.slice(eo);
    range.endOffset = range.startOffset;
  } else if (sc === ec && sc && sc._children) {
    const end = Math.min(eo, sc._children.length);
    for (let i = end - 1; i >= so; i--) {
      const child = sc._children[i];
      if (child) sc.removeChild(child);
    }
    range.endOffset = range.startOffset;
    range.endContainer = range.startContainer;
  } else if (sc && ec) {
    // Cross-container: remove every fully-contained node between the
    // boundaries and trim the partially-contained start / end nodes,
    // walking the common ancestor exactly as the clone traversal does.
    const ancestor = range.commonAncestorContainer;
    if (ancestor) {
      __deleteSlice(ancestor, {container: sc, offset: so}, {container: ec, offset: eo});
    }
    // Per spec the range collapses to the (original) start boundary.
    range.endContainer = sc;
    range.endOffset    = so;
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
// node. This is the practical subset of the (very large) spec algorithm: full
// node-type coverage (element / text / cdata / comment / PI / doctype / document
// / fragment) and DEFAULT-namespace tracking (`xmlns="…"` declarations), but NOT
// the namespace-prefix-generation machinery (generated `ns1:` prefixes for
// attributes in a namespace). That covers the common cases; the prefix-heavy
// XMLSerializer-serializeToString cases stay out of scope.
function xmlEscapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}
function xmlEscapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}
function xmlSerializeDoctype(dt) {
  let m = '<!DOCTYPE ' + dt.name;
  if (dt.publicId) m += ' PUBLIC "' + dt.publicId + '"';
  else if (dt.systemId) m += ' SYSTEM';
  if (dt.systemId) m += ' "' + dt.systemId + '"';
  return m + '>';
}
function xmlSerializeNode(node, defaultNs) {
  switch (node.nodeType) {
    case NODE_ELEMENT:  return xmlSerializeElement(node, defaultNs);
    case NODE_TEXT:     return xmlEscapeText(node._data);
    case NODE_CDATA:    return '<![CDATA[' + node._data + ']]>';
    case NODE_COMMENT:  return '<!--' + node._data + '-->';
    case NODE_PI:       return '<?' + node._target + ' ' + node._data + '?>';
    case NODE_DOCTYPE:  return xmlSerializeDoctype(node);
    case NODE_DOC:
    case NODE_FRAGMENT: return (node._children || []).map(c => xmlSerializeNode(c, defaultNs)).join('');
    default:            return '';
  }
}
function xmlSerializeElement(el, defaultNs) {
  const ns    = el._ns || null;
  const qname = el._prefix ? el._prefix + ':' + el._localName : (el._localName || el._tag);
  let markup  = '<' + qname;
  let childNs = defaultNs;
  // Default-namespace declaration: an unprefixed element whose namespace differs
  // from the inherited default declares it (`xmlns="ns"`, or `xmlns=""` to reset
  // to no namespace). Prefixed elements assume an in-scope prefix (no generation).
  if (!el._prefix && ns !== (defaultNs || null)) {
    markup += ' xmlns="' + (ns || '') + '"';
    childNs = ns;
  }
  for (const key of Object.keys(el._attrs)) {
    // The bare `xmlns` default-namespace declaration is emitted from the element's
    // namespace above; the parser also keeps it as a literal `_attrs` entry, so
    // skip it here to avoid declaring it twice (a DOMParser round-trip otherwise
    // produces `xmlns="…" xmlns="…"`).
    if (key === 'xmlns') continue;
    const meta   = el._attrNS && el._attrNS[key];
    const aqname = meta && meta.prefix ? meta.prefix + ':' + meta.localName : key;
    markup += ' ' + aqname + '="' + xmlEscapeAttr(el._attrs[key]) + '"';
  }
  const kids = el._children;
  if (!kids || kids.length === 0) {
    // An empty HTML-namespace element serializes with an explicit end tag
    // (`<a></a>`) — HTML elements can't be self-closed; other namespaces use
    // `<x/>`.
    markup += ns === HTML_NS ? '></' + qname + '>' : '/>';
  } else {
    markup += '>';
    for (const c of kids) markup += xmlSerializeNode(c, childNs);
    markup += '</' + qname + '>';
  }
  return markup;
}
class XMLSerializer {
  serializeToString(node) {
    if (!node || typeof node.nodeType !== 'number') {
      throw new TypeError("Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.");
    }
    return xmlSerializeNode(node, null);
  }
}
globalThis.XMLSerializer = XMLSerializer;

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
  // 1. node and parent must share a shadow-including root (getRootNode already
  //    crosses shadow boundaries via ShadowRoot._parent = host). This subsumes
  //    the "both connected", cross-document and cross-tree cases.
  if (node.getRootNode() !== parent.getRootNode()) {
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
      oldParent._children.splice(oi, 1);
    }
  }
  node._parent = parent;
  const ii = ref == null ? -1 : parent._children.indexOf(ref);
  if (ii < 0) parent._children.push(node);
  else parent._children.splice(ii, 0, node);
  // A single-select <select> keeps only the last selected <option>; moving an
  // option in or around can change that, so run the spec's "ask for a reset"
  // like insertBefore / replaceChild do.
  askForReset(node);

  // Connectedness is unchanged (same shadow-including root), so no CE
  // connected/disconnected callbacks fire. MutationObserver still sees the
  // relocation as a removal from the old parent and an addition to the new one.
  if (oldParent) recordChildList(oldParent, [], [node], prevSib, nextSib);
  recordChildList(parent, [node], []);
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
// `parseDocument` / `parseFragment` are available to the Element
// IDL methods (`innerHTML` setter, `insertAdjacentHTML`, etc.)
// without going through bridge.entry.js.
const { parseDocument, parseFragment } = installHtmlParser({ Document, Element, Text, DocumentFragment, DocumentType });
const { parseXml } = installXmlParser({ Element, Text, Comment, ProcessingInstruction, CDATASection, DocumentType });

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
  parseFragment,
  parseXml,
  newChildList
};
