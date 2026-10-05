// `Element.prototype.style` — Proxy over the inline `style="..."`
// attribute that surfaces both camelCase IDL access
// (`style.backgroundColor`) and kebab-case (`style['background-color']`).
// Reads parse the attribute; writes round-trip through the decl
// parser so the attribute stays canonical regardless of how the
// caller phrased the value.
//
// `getComputedStyle(el)` returns a small Proxy that reads the style engine's computed values, and layout's used ones
// where CSSOM says so. jQuery 3.x's `.css()` / `:visible` / `isHiddenWithinTree` path lands here on every probe, so
// the per-element proxy is cached (`COMPUTED_STYLE_PROXIES`).

import { NODE_ELEMENT, HTML_NS, SVG_NS } from './constants.js';
import { flatTreeParent } from './walk.js';
import { registerPseudoBox, arenaNid } from './native-query-shadow.js';

// The element an inherited property is inherited FROM: the FLAT-tree parent — a slotted element
// inherits from its slot, a `<slot>` from the host chain through the shadow root, generated
// content from its originating element (CSS Scoping 1 §3.2). The DOM parent left a `<slot>` with
// no font at all, so slotted bare text measured in the default face.
const inheritParent = (el) => {
  const p = flatTreeParent(el);
  return p && p._nodeType === NODE_ELEMENT ? p : null;
};
import { engineValue, styleEngineResolvedValue, styleEngineGenerated, declareStyledMemos } from './cascade.js';
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, isSupportedCssPropertyName, documentBaseUrl, LONGHANDS } from './css-utils.js';
import { handles }                       from './handles.js';

// A resolved-value (computed) declaration enumerates every CSS LONGHAND the style engine computes, in
// lexicographic order with the vendor-prefixed ones after the rest (getComputedStyle-property-order /
// -logical-enumeration): shorthands and aliases are excluded (LONGHANDS is exactly the longhand set), and any custom
// property present on the element is appended.
// KNOWN GAPS (bounded): only the element's OWN inline custom properties are
// enumerated (inherited / registered ones need a cascaded custom-property model); and the
// proxy has no `ownKeys` trap, so `Object.keys(gCS)` stays `[]` (indices aren't own keys).
const COMPUTED_LONGHAND_NAMES = [...LONGHANDS].sort((a, b) =>
  (a.charCodeAt(0) === 45) - (b.charCodeAt(0) === 45) || (a < b ? -1 : 1));
// …and an unstyled element's: none.
const NO_NAMES = Object.freeze([]);
// The enumerated names for an inline-style proxy, memoized per computed-style proxy on the
// custom-property signature so a `for (i…) gCS[i]` loop doesn't re-scan / re-allocate per
// index (rule 3). The no-custom-property case returns the shared constant (zero allocation).
function makeComputedNames() {
  let cache = null, sig = '';
  return (inlineStyle) => {
    let custom = null;
    for (const k of inlineStyle) if (k.charCodeAt(0) === 45 /* '-' */) (custom || (custom = [])).push(k);
    if (!custom) { sig = ''; return (cache = COMPUTED_LONGHAND_NAMES); }
    const nextSig = custom.sort().join(',');
    if (nextSig !== sig || cache === null) { sig = nextSig; cache = COMPUTED_LONGHAND_NAMES.concat(custom); }
    return cache;
  };
}

// Properties whose `getComputedStyle(el).<prop>` reads route through
// the cascade resolver. Without this, `style.color` etc. would only
// see inline `style="..."` values and miss every stylesheet rule.
// Keys are kebab-case; the proxy normalises camelCase via
// `camelToKebab` before lookup.

// A `CSSStyleDeclaration` backing store abstracts WHERE the declaration text
// lives: an element's inline `style=""` attribute, or a CSSOM rule's block.
//   read():        the current source declaration text
//   write(str):    persist the canonical serialization
//   document():    the document whose mode it parses in (the current one where absent)
//   kind:          which block it is (`storeKind`): a style rule's where absent
//   nid():         an element's arena node, for its `style` attribute (`storeNid`)
//   rule():        a CSSOM rule's handle, for its block (`storeRule`)
//   cacheOn:       object to memoize the reads on (keyed by source string)
// `makeDeclProxy` turns a store into the live CSSStyleDeclaration Proxy every
// caller sees (`el.style`, `rule.style`). The Proxy target's prototype is
// `CSSStyleDeclaration.prototype`, so `x instanceof CSSStyleDeclaration` holds.

// The block's text and its document's mode, which every op over it takes (`__dom.decl*`, cssom_decl.rs: the style
// engine's own declaration blocks, so a page's CSSOM parses and serializes as the style it computes). The text is all
// that is kept here: the attribute's value, or the serialization of the rule's block.
const storeText = (store) => store.read() || '';
// …and the kind of block it is (cssom_decl.rs `Kind`): a style rule's — an element's `style` attribute is one — 0, a
// keyframe's 1, a page's 2, an `@font-face` rule's descriptors 3.
const storeKind = (store) => store.kind || 0;
// …and the document it parses in: its mode, and the base its `url()`s resolve against.
const storeDocument = (store) => (store.document ? store.document() : globalThis.document);
function storeQuirks(store) {
  const doc = storeDocument(store);
  return !!(doc && doc._quirks);
}
function storeBase(store) {
  const doc = storeDocument(store);
  return doc && doc !== globalThis.document ? doc.baseURI : documentBaseUrl();
}
// …and, for an element's `style` attribute, the element's arena node, which keeps the block a write made — what every
// read and the next write are of, and the style engine computes the element's style from (cssom_decl.rs) — and -1 for
// any other block.
const storeNid = (store) => (store.nid ? store.nid() : -1);
// …and, for a CSSOM rule's block, the rule's handle (cssom.js): every read and write is of the rule's own block, which the
// engine cascades — and -1 for any other block.
const storeRule = (store) => (store.rule ? store.rule() : -1);
// What a page reads of one block between two writes — the names it indexes and iterates, and the values it asks for —
// kept on `store.cacheOn` under the text it was read from, so a write (a new text) misses. jQuery's `.css()` and
// Floating UI read a dozen properties of one element at a time (rule 3).
function storeReads(store) {
  const text = storeText(store);
  const holder = store.cacheOn;
  if (holder._declKey !== text) {
    holder._declKey = text;
    holder._declCache = { names: null, values: new Map() };
  }
  return holder._declCache;
}
function storeNames(store) {
  const reads = storeReads(store);
  const text = storeText(store);
  return reads.names ??= (text ? globalThis.__dom.declNames(text, storeKind(store), storeQuirks(store), storeBase(store), storeNid(store), storeRule(store)) : NO_NAMES);
}

// `getPropertyValue(name)`: a shorthand serialized from its longhands, '' for a property the block does not set.
function propValue(store, name) {
  const text = storeText(store);
  if (!text) return '';
  const values = storeReads(store).values;
  let v = values.get(name);
  if (v === undefined) values.set(name, v = globalThis.__dom.declValue(text, storeKind(store), storeQuirks(store), storeBase(store), name, storeNid(store), storeRule(store)));
  return v;
}

function propPriority(store, name) {
  const text = storeText(store);
  return text && globalThis.__dom.declImportant(text, storeKind(store), storeQuirks(store), storeBase(store), name, storeNid(store), storeRule(store)) ? 'important' : '';
}

// `setProperty(name, value, priority)`: an empty value removes the property, a priority other than `important` is no
// write at all, and so is a value the property does not parse — and the text is written only where the block CHANGED
// (CSSOM "update style attribute", and with it the mutation record, runs only then).
function writeStoreProp(store, name, value, priority) {
  if (value === '') { removeStoreProp(store, name); return; }
  const p = priority == null ? '' : String(priority);
  if (p !== '' && p.toLowerCase() !== 'important') return;
  const next = globalThis.__dom.declSet(storeText(store), storeKind(store), storeQuirks(store), storeBase(store), name, value, p !== '', storeNid(store), storeRule(store));
  if (next !== null) store.write(next);
}

function removeStoreProp(store, name) {
  const [old, next] = globalThis.__dom.declRemove(storeText(store), storeKind(store), storeQuirks(store), storeBase(store), name, storeNid(store), storeRule(store));
  if (next !== null) store.write(next);
  return old;
}

// A CSSStyleDeclaration has an indexed property getter, which by WebIDL makes it a legacy platform
// object whose [[PreventExtensions]] returns false: `Object.freeze(el.style)` throws "TypeError:
// Cannot freeze" and the declaration stays extensible (measured, Chrome 151.0.7922.108). Modelling
// that refusal is not decoration here — our declarations are proxies, and a proxy may only report a
// property its TARGET lacks while that target can still grow one. Letting a caller seal it would
// turn every presence answer below into a TypeError raised from inside the next read.
function declarationsCannotBeSealed() { return false; }

// CSSOM's own members, as opposed to the per-property IDL attributes it also defines. They live on
// the interface prototype (cssom.js), where each one reads its receiver's implementation — so
// `a.style.item`, `b.style.item` and `CSSStyleDeclaration.prototype.item` are all the SAME function,
// as they are in Chrome (measured, 151.0.7922.169). Synthesizing them per access in the `get` trap
// made every read a different object, which a page comparing two declarations member by member can
// see (`html/rendering/…/multicol-*-mode.html` does exactly that).
export const DECL_ATTRIBUTES = new Set(['cssText', 'length', 'parentRule']);
export const DECL_METHODS    = new Set(['getPropertyValue', 'getPropertyPriority', 'setProperty',
  'removeProperty', 'item']);
export const DECL_MEMBERS    = new Set([...DECL_ATTRIBUTES, ...DECL_METHODS]);

// The implementation behind a live declaration — an inline one, a resolved one, and the empty
// resolved one each supply their own, named as CSSOM names them. It travels WITH the declaration,
// under a registry symbol, rather than sitting in a map on the side: a node adopted out of an
// iframe keeps the declaration its own realm built, while the prototype member that runs belongs to
// the realm of whoever reads it, and `Symbol.for` is the one key both realms agree on.
//
// That makes it reachable, and forgeable, by page script — an object carrying the same symbol is
// accepted by a prototype member. Nothing enumerates it (there is no `ownKeys` trap and `in` says
// false), and no real declaration can be made to answer with a different one, so this buys
// cross-realm reach at the price of a brand that a determined page can imitate.
const DECLARATION_IMPLEMENTATION = Symbol.for('capybara-simulated.declarationImplementation');
export function declarationImplementation(receiver) {
  return receiver == null ? undefined : receiver[DECLARATION_IMPLEMENTATION];
}

// What is `in` a declaration, shared by all three of them (inline / rule, resolved-value, and the
// empty one a detached element or an unknown pseudo yields) so that presence cannot drift from the
// getter that answers next to it. Four things are there: the interface's own members; the indexed
// run, whose LENGTH is the one thing the three differ on (hence the thunk); EVERY supported
// property name, in both spellings, set or not; and finally whatever the target itself carries —
// an expando parked under a name that is not a property (`style.COLOR = …`) or a prototype member
// (`toString`). A CUSTOM property is deliberately absent even once set: `--x` gets no IDL
// attribute, so Chrome answers `false` to `'--x' in el.style` while still counting it in `length`
// and naming it from `item(0)` (measured, Chrome 151.0.7922.108).
const NO_INDEXED_PROPERTIES = () => 0;

// Reading one of those members. An ATTRIBUTE is a value, so it comes straight from this
// declaration's implementation; a METHOD has to be the shared function the prototype holds, so it
// resolves through the prototype with this declaration as the receiver.
function readMember(target, prop, receiver, implementation) {
  return DECL_ATTRIBUTES.has(prop) ? implementation[prop] : Reflect.get(target, prop, receiver);
}

// What a declaration answers for a name it has no value for. A non-property name — `toString`,
// `constructor`, an expando — resolves from the proxy's target as it always did; a CSS property
// name is simply UNSET, and answering it is the declaration's own job. It must not reach the
// target, because CSSOM puts an IDL attribute for every supported property on the interface
// prototype (see cssom.js) and that accessor would then run against an internal receiver with no
// declaration behind it.
function declarationMiss(target, prop, receiver, kebab) {
  if (isSupportedCssPropertyName(kebab)) return '';
  // Through `Reflect`, so an accessor the page installed on the declaration runs against the
  // DECLARATION rather than the proxy's internal target. A name the target has never heard of still
  // answers '' — Chrome answers `undefined` there, a bounded gap of its own.
  return prop in target ? Reflect.get(target, prop, receiver) : '';
}

function declarationHas(target, key, indexedLength) {
  if (DECL_MEMBERS.has(key) || key === Symbol.iterator) return true;
  if (typeof key === 'string' && /^\d+$/.test(key)) return +key < indexedLength();
  if (typeof key === 'string' && isSupportedCssPropertyName(camelToKebab(key))) return true;
  return Reflect.has(target, key);
}

export function makeDeclProxy(store) {
  // Proxy target is an object (so `typeof style === 'object'`) whose prototype is
  // CSSStyleDeclaration.prototype (so `instanceof` holds). The original `{}` /
  // `function(){}` targets broke both jQuery's `isHiddenWithinTree` typeof check
  // and `el.style instanceof CSSStyleDeclaration`.
  const proto = globalThis.CSSStyleDeclaration && globalThis.CSSStyleDeclaration.prototype;
  const target = proto ? Object.create(proto) : {};
  // Hoisted so `has` allocates nothing: it is consulted only on the indexed branch.
  const indexedLength = () => storeNames(store).length;
  let implementation;
  const handler = {
    get(_t, prop, receiver) {
      if (DECL_MEMBERS.has(prop)) return readMember(_t, prop, receiver,
        implementation || (implementation = writableDeclaration(store)));
      if (prop === Symbol.iterator) return function* () { yield* storeNames(store); };
      // Non-string keys (Symbol.toStringTag, …) resolve from the target's prototype.
      if (typeof prop !== 'string') {
        if (prop !== DECLARATION_IMPLEMENTATION) return _t[prop];
        return implementation || (implementation = writableDeclaration(store));
      }
      if (/^\d+$/.test(prop)) return storeNames(store)[+prop] || '';
      // Hot path: a CSS property read returns its value directly. Only on a MISS do we
      // fall back to a prototype Object member (toString / valueOf / constructor / …),
      // so the common value-returning read never pays the proto-chain walk (rule 3).
      // An OWN property of the target wins: it is an expando, or a descriptor an author installed
      // with `Object.defineProperty(el.style, …)`, and a non-configurable one makes any other
      // answer a [[Get]] invariant violation that V8 raises from inside the read.
      if (Object.prototype.hasOwnProperty.call(_t, prop)) return Reflect.get(_t, prop, receiver);
      const kebab = camelToKebab(prop);
      const v = propValue(store, kebab);
      return v !== '' ? v : declarationMiss(_t, prop, receiver, kebab);
    },
    set(_t, prop, value, receiver) {
      // A named-property write maps to a CSS declaration only when the camelCased name folds to a
      // SUPPORTED property (`backgroundColor` → `background-color`, `cssFloat` → `float`). Any other
      // name — `COLOR` (folds to `-c-o-l-o-r`), `unknown`, a `--custom` property (settable only via
      // setProperty) — is a plain expando, exactly as browsers treat it. The value is IDL
      // `[LegacyNullToEmptyString]`: `null` clears (→ ''); `undefined` stringifies to 'undefined'.
      if (typeof prop === 'string') {
        const kebab = camelToKebab(prop);
        if (isSupportedCssPropertyName(kebab)) {
          writeStoreProp(store, kebab, value === null ? '' : String(value));
          return true;
        }
      }
      // Everything else is written the way an ordinary object would write it: an interface member
      // through its prototype setter (`cssText` has one; `length` and `parentRule` are readonly and
      // refuse, as they do in a browser), an author's accessor through that accessor, and anything
      // left over as a plain expando.
      return Reflect.set(_t, prop, value, receiver);
    },
    // Reporting only the STORED declarations here failed the first assertion of every WPT
    // `*-computed` test — `assert_true(property in getComputedStyle(target))` — before the test
    // could read a value.
    has: (_t, prop) => declarationHas(_t, prop, indexedLength),
    preventExtensions: declarationsCannotBeSealed
  };
  return new Proxy(target, handler);
}

// `Element.prototype.style` — a CSSStyleDeclaration over the inline `style=""`
// attribute. Writes call `setAttribute('style', …)` (which replaces the immutable
// string, invalidating the parse cache on `el`); reads parse it (cached on `el`).
export function makeStyleProxy(el) {
  return makeDeclProxy({
    read:    () => el._attrs.style || '',
    write:   (s) => el.setAttribute('style', s),
    document: () => el.ownerDocument,
    nid:     () => arenaNid(el),
    cacheOn: el
  });
}

function camelToKebab(name) {
  // A leading `--` (custom property) passes through unchanged.
  if (name.indexOf('--') === 0) return name;
  // An IDL attribute names its property exactly — `backgroundColor`, `cssFloat`, and the dashed
  // spellings, which map to themselves.
  const attribute = CSS_PROPERTY_BY_IDL_ATTRIBUTE[name];
  if (attribute !== undefined) return attribute;
  // Anything else is not a property of ours — the table holds every spelling that is, including the
  // whole `-webkit-…` surface. Fold it anyway so the name it is TESTED against is stable, and so a
  // `style.mozOsxFontSmoothing = …` reads as the plain expando it is in a browser (measured, Chrome
  // 151.0.7922.169: 151 `webkit`-cased IDL attributes, zero `moz`/`ms` ones).
  return name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}


// The tag an element is laid out by (walk.rs `rendering_tag`): an HTML element's local name, and the svg root's — and
// none for any other, whatever it is named: a `urn:x` `<img>` is no image, and the box its style makes it.
export function renderingTag(el) {
  return el._ns === HTML_NS || (el._ns === SVG_NS && el._tag === 'svg') ? el._tag : '';
}
// The display a box is laid out by where it is not the computed one (walk.rs `laid_display`): a ruby display an
// inline box — a `block ruby` a block — save an internal one on a `<button>`, the flow-root of HTML's button layout;
// and a table display on a replaced element or a control no table box but an inline-level one (CSS Tables 3 §2.1;
// Firefox puts an `<img style="display: table-cell">` on the line).
export function displayAsLaidOut(d, tag) {
  if (d === 'ruby') return 'inline';
  if (d === 'block ruby') return 'block';
  if (d && d.startsWith('ruby-')) return tag === 'button' ? 'block' : 'inline';
  if (d && (d.startsWith('table-') || d === 'table-caption') && REPLACED_OR_CONTROL_TAGS.has(tag)) return 'inline-block';
  return d;
}
// (walk.rs `replaced_or_control` — save that it takes an `<object>` showing its fallback content for no replaced box,
// and this, asked with the tag alone, for one: the readers ask only whether the box is an inline one, which neither is)
const REPLACED_OR_CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'meter', 'progress', 'img', 'canvas', 'video', 'audio',
                                          'embed', 'iframe', 'frame', 'svg', 'object']);

// Exported for the layout engine: it needs the USED display (author inline style, stylesheet, then
// the per-tag UA default), not just an author-declared keyword — telling a `<span>` from a `<div>`
// is what makes inline content share a line instead of stacking.
export { computedDisplayFor as usedDisplay };
function computedDisplayFor(el) {
  // The engine's computed `display` — the UA rules Chrome marks `!important` and the blockification already applied —
  // and `none` for an element it does not style, which has no box.
  return engineValue(el, 'display') ?? 'none';
}

// The overflow a box USES in one axis: its computed value, which carries CSS Overflow 3's pairing — `visible` and
// `clip` compute to `auto` and `hidden` RESPECTIVELY when the other axis is neither `visible` nor `clip` — and `visible`
// for an element the engine does not style.
function usedOverflow(el, axis) {
  return engineValue(el, axis === 'x' ? 'overflow-x' : 'overflow-y') ?? 'visible';
}

// …and the overflow a box uses once VIEWPORT PROPAGATION has been applied (CSS Overflow 3.3): the
// ROOT's overflow belongs to the viewport rather than to the root box, and the BODY's does too
// when the root took none of its own. Both then behave as `visible` themselves — which is why
// `body { overflow: auto }` neither clips nor holds a scroll offset (Chrome measured: 0), while
// the same declaration under `html { overflow: hidden }` makes the body a scroller in its own
// right. One place, because the clip test and the scroll-offset gate must not disagree about it.
export function propagatedOverflow(el, axis) {
  const doc = el._ownerDoc || globalThis.document;
  const root = doc && doc.documentElement;
  if (el === root) return 'visible';
  if (root && el === doc.body &&
      usedOverflow(root, 'x') === 'visible' && usedOverflow(root, 'y') === 'visible') return 'visible';
  return usedOverflow(el, axis);
}

// The value `el` has for `key`: the style engine's computed value — the cascade, the UA sheet and every animation and
// transition layer applied — where a reader here asks for a declared one, which it then finds already resolved (an `em`
// to px, an `inherit` to the parent's, an undeclared property to the UA's or its initial). Null where there is none:
// an ANONYMOUS box, which no selector names and which has no style attribute (CSS Display §2.3), so that every property
// is its initial value; an element the engine does not style; and a name that is no property.
export function declaredValue(el, key) {
  return engineValue(el, key) ?? null;
}


// An `<input>`'s type, lowercased, memoised on the RAW attribute string. Every property resolution
// of every input asks, and `String(...).toLowerCase()` per call was ~6ns and an allocation each
// time. Keying on the raw value is self-invalidating — a changed `type` is a different string —
// so this needs no epoch and cannot go stale.
export function inputType(el) {
  const raw = (el._attrs && el._attrs.type) != null ? String(el._attrs.type) : '';
  if (el._uaTypeRaw !== raw) {
    el._uaTypeRaw  = raw;
    el._uaTypeNorm = raw ? raw.toLowerCase() : 'text';
  }
  return el._uaTypeNorm;
}


// The initial font-size (the `medium` keyword). The absolute-size keyword table lives in
// css-utils (ABSOLUTE_FONT_SIZE_PX), shared with the canvas `font` parser.
const DEFAULT_FONT_SIZE_PX = 16;
// An INHERITED property's computed value: the engine's — and, for an anonymous box, which declares nothing and inherits
// everything that inherits, its parent's. Undefined where nothing up the chain is styled.
function inheritedValue(el, prop) {
  for (let cur = el; cur; cur = inheritParent(cur)) {
    const v = engineValue(cur, prop);
    if (v !== undefined) return v;
  }
  return undefined;
}
// The computed font-size in px — every relative unit and keyword resolved.
export function computedFontSizePx(el) {
  if (!el || el._nodeType !== NODE_ELEMENT) return DEFAULT_FONT_SIZE_PX;
  const v = inheritedValue(el, 'font-size');
  return v === undefined ? DEFAULT_FONT_SIZE_PX : parseFloat(v);
}





// ── Generated content ──────────────────────────────────────────────────────────────────────────
// A `::before` / `::after` with a `content` is a box in the flow — an inline one by default, holding
// the text the `content` names — and a node the layout can size, place and paint like any other.
// It is no DOM node: nothing that walks the DOM (`innerText`, a query, an observer) sees it, and a
// hit over it answers its originating element, which is what Chrome does. The node's `_parent` is
// that element, and the style engine answers its properties as the originating element's pseudo-element's
// (cascade.js `engineValue`).
//
// One node per element per pseudo, kept for the element's life so its layout stamps and its
// computed-style proxy survive; the text inside it is refreshed on every ask (`pseudoNodeFor`).
const PSEUDO_TAGS = { before: '::before', after: '::after', placeholder: '::placeholder' };
function makePseudoNode(el, which) {
  const node = {
    nodeType: NODE_ELEMENT, _nodeType: NODE_ELEMENT, _pseudo: which, _tag: PSEUDO_TAGS[which], _localName: PSEUDO_TAGS[which], _parent: el, _attrs: {},
    _children: [], _shadowRoot: null, _isShadowRoot: false,
    get isConnected() { return el.isConnected; },
    get ownerDocument() { return el.ownerDocument; },
    get tagName() { return this._tag; },
    get localName() { return this._tag; },
    get id() { return ''; },
    get className() { return ''; }
  };
  node.style = makeStyleProxy(node);
  return node;
}
// The generated-content node of `el` for `which`, or null when it generates none — a pseudo
// with no `content`, or `content: none` / `normal`. `force` hands the node back regardless (for
// `getComputedStyle(el, '::before')`, which resolves a pseudo that renders nothing). The text is what the style
// engine generated — the text its walk lays out, or null for no box — asked every time: it is one lookup of a style
// the engine keeps.
export function pseudoNodeFor(el, which, force = false) {
  const text = styleEngineGenerated(el, which) ?? null;
  // The common answer first: an element that generates nothing, and never generated anything, has no node.
  if (!force && text === null && el._pseudoNodes === undefined) return null;
  // (…its memos declared before its slot is written, or declaring them later would clear the slot)
  if (el._styled === false) declareStyledMemos(el);
  let slot = el._pseudoNodes;
  if (slot === undefined) slot = el._pseudoNodes = { before: null, after: null, beforeOn: false, afterOn: false };
  const onKey = which + 'On';
  if (text !== null || force) {
    let node = slot[which];
    if (!node) node = slot[which] = makePseudoNode(el, which);
    // …and an ARENA NODE the first time it actually RENDERS, which is what makes its box a box like any
    // other: the layout pass names every box by its `_nid` (`nlRustPass`), and the walk records the pseudo's box
    // under it (walk.rs `Generated`). Never LINKED into the tree — a pseudo is no part of the DOM and
    // nothing queries it; the slot is a box holder. One per (element, pseudo) for the element's life, and not taken
    // at all for a `force`d one that renders nothing — `getComputedStyle(el, '::before')` on a page with no
    // `content` rule allocates no box.
    if (text !== null) registerPseudoBox(el, node, PSEUDO_TAGS[which], which);
    // The text node is replaced only when the text is: an unchanged one is the same node, as a DOM text
    // child that nothing edited is, so what was measured of it stands.
    const kids = node._children;
    const same = text === null || text === '' ? kids.length === 0 : kids.length === 1 && kids[0]._data === text;
    if (!same) node._children = text === null || text === '' ? [] : [{ nodeType: 3, _nodeType: 3, _data: text, data: text, _parent: node }];
  }
  slot[onKey] = text !== null;
  return slot[onKey] || force ? slot[which] : null;
}
// …and the box of a generated `::before` / `::after` the RUST walk found rendering (`layoutBuild` asks for it): made and
// linked whatever this side's own `content` says — the style engine's decides there — so the walk names its record by it.
export function linkGeneratedBox(el, which) {
  const node = pseudoNodeFor(el, which, true);
  if (!node) return;
  registerPseudoBox(el, node, PSEUDO_TAGS[which], which);
}
// The `::placeholder` of `el`: a style holder and nothing more — the painter draws a control's placeholder text in its
// colour and font (`paint.js`), and no layout box ever holds it. One per element, for the element's life.
export function placeholderNodeFor(el) {
  return el._placeholderNode || (el._placeholderNode = makePseudoNode(el, 'placeholder'));
}


// The computed `font-family` list — the same inheritance + UA-default resolution
// getComputedStyle reports, exposed for layout's advance-table lookup.
export function computedFontFamily(el) {
  // A page that names no family gets the browser's STANDARD font, which is a serif
  // in every major browser (Chrome: Times New Roman) — measuring unstyled text in a
  // sans made every such run ~3% too wide.
  return inheritedValue(el, 'font-family') || 'Times New Roman';
}

export function computedFontWeight(el) {
  const v = inheritedValue(el, 'font-weight');
  return v === undefined ? 400 : parseInt(v, 10);
}
// Computed font-style: `italic` / `oblique[ <angle>]` / `normal`.
export function computedFontStyle(el) {
  return inheritedValue(el, 'font-style') ?? 'normal';
}

// The computed `color` — what text is painted in: every keyword (`inherit`, `currentcolor`, a system colour) resolved,
// animations included, as `getComputedStyle` reports it.
export function computedColor(el) {
  return readComputed(el, 'color').value;
}
// How a line of the element's text is put in visual order: its computed `direction`, and whether `unicode-bidi` is
// `plaintext` (each paragraph's direction its own first strong character's — a `dir=auto` <pre> or <textarea>, by the
// UA sheet).
export function computedBidi(el) {
  return { rtl: readComputed(el, 'direction').value === 'rtl', plaintext: readComputed(el, 'unicode-bidi').value === 'plaintext' };
}
function readComputed(el, key) {
  const value = styleEngineResolvedValue(el, key);
  return value === undefined ? NO_VALUE : { hit: true, value };
}
const NO_VALUE = Object.freeze({ hit: false });


// A resolved-value CSSStyleDeclaration (getComputedStyle) is READ-ONLY: mutating it
// throws NoModificationAllowedError, and `cssText` serializes to '' (per CSSOM, a
// computed style has no author declaration text).
function computedReadOnly() {
  throw new globalThis.DOMException('Cannot modify the computed style', 'NoModificationAllowedError');
}
// getComputedStyle for an invalid pseudo-element returns an EMPTY, read-only
// declaration: length 0, every property reads '', and any mutation throws
// (CSSStyleDeclaration-is-immutable holds for the empty result too).
// How a WRITABLE declaration — an element's inline style, or a rule's block — implements CSSOM's
// own members. Built on first use: a declaration that is only ever read by property name never
// needs one, and `el.style` is constructed far more often than its members are called.
function writableDeclaration(store) {
  return {
    // CSSOM: `cssText` is the CANONICAL serialization of the declaration block — canonical values
    // AND shorthand reconstruction (longhands collapse to `margin: 1px 2px`), trailing `;`,
    // normalized spacing — not the raw source. Setting it PARSES + re-serializes (dropping
    // syntactically invalid declarations), and unlike a per-property mutation it ALWAYS rewrites
    // the source (CSSOM "set css text" unconditionally invokes "update style attribute"), so it
    // queues a mutation record even when the serialized value is unchanged.
    get cssText()      { const text = storeText(store); return text && globalThis.__dom.declText(text, storeKind(store), storeQuirks(store), storeBase(store), storeNid(store), storeRule(store)); },
    set cssText(value) { store.write(globalThis.__dom.declReplace(String(value == null ? '' : value), storeKind(store), storeQuirks(store), storeBase(store), storeNid(store), storeRule(store))); },
    // CSSStyleDeclaration is an indexed getter: `style[0]` / `style.item(0)` is the 0-based
    // property NAME, and it is iterable over those names. `length` counts them.
    get length()       { return storeNames(store).length; },
    item:              (index) => storeNames(store)[index >>> 0] || '',
    // The rule a declaration belongs to, or null when it belongs to an element or to nothing
    // (`new CSSStyleDeclaration()`). Only `ruleStyle` passes an owner.
    get parentRule()   { return store.owner || null; },
    // These take a literal CSS property name (ASCII-lowercased; custom `--*` props stay
    // case-sensitive) — NOT the IDL camelCase mapping, which is only for named-property access.
    // A regular shorthand combines its longhands (`overflow` from overflow-x/-y).
    getPropertyValue:    (property) => propValue(store, cssPropertyName(property)),
    getPropertyPriority: (property) => propPriority(store, cssPropertyName(property)),
    // The value is IDL `[LegacyNullToEmptyString]`: `null` clears (→ ''), while `undefined`
    // stringifies to 'undefined' (then fails value validation → a no-op, not a clear).
    setProperty: (property, value, priority) => {
      const name = cssPropertyName(property);
      writeStoreProp(store, name, value === null ? '' : String(value), priority);
    },
    removeProperty: (property) => removeStoreProp(store, cssPropertyName(property))
  };
}

// What both RESOLVED declarations answer alike. A resolved value carries no priority (`!important`
// is a cascade input, not part of the value the cascade produced), the block has no serialization
// and no owning rule, and every write is refused.
const RESOLVED_DECLARATION = {
  get cssText()       { return ''; },
  set cssText(_value) { computedReadOnly(); },
  get parentRule()    { return null; },
  getPropertyPriority: () => '',
  setProperty:         computedReadOnly,
  removeProperty:      computedReadOnly
};

// …and how a RESOLVED one does, over the cascade rather than a stored block. `names` is the
// element's memoized property run, which the proxy also indexes and iterates.
function resolvedDeclaration(el, inline, names) {
  return {
    __proto__: RESOLVED_DECLARATION,
    getPropertyValue: (property) => {
      const r = readComputed(el, cssPropertyName(property));
      return r.hit ? r.value : '';
    },
    // Enumeration: length / item / the indexed getter / the iteration walk cover every supported
    // longhand (plus the element's custom properties), NOT the inline declarations.
    get length()  { return names(inline).length; },
    item:         (index) => names(inline)[index >>> 0] || ''
  };
}

// The resolved style of an element that is not being rendered: every property reads '', and the
// indexed run is empty. One object serves them all — it closes over nothing.
const EMPTY_DECLARATION = {
  __proto__: RESOLVED_DECLARATION,
  get length()      { return 0; },
  item:             () => '',
  getPropertyValue: () => ''
};

function emptyComputedDeclaration() {
  // Empty, but still a CSSStyleDeclaration: the target inherits the interface prototype, so
  // `instanceof` holds and the members resolve from it like any other declaration's.
  const proto = globalThis.CSSStyleDeclaration && globalThis.CSSStyleDeclaration.prototype;
  return new Proxy(proto ? Object.create(proto) : {}, {
    get(_t, key, receiver) {
      if (DECL_MEMBERS.has(key)) return readMember(_t, key, receiver, EMPTY_DECLARATION);
      if (key === globalThis.Symbol.iterator) return function* () {};
      // Every property resolves to '' here; anything else the target can answer for is a prototype
      // member (`toString`, `constructor`).
      if (typeof key !== 'string') return key === DECLARATION_IMPLEMENTATION ? EMPTY_DECLARATION : _t[key];
      return declarationMiss(_t, key, receiver, camelToKebab(key));
    },
    // …and it reports the same property NAMES as a real one: a detached element's computed style
    // has every property (reading '' from each), so `'width' in getComputedStyle(detached)` is true
    // in Chrome exactly as it is for an attached one. Its indexed run is empty.
    has: (t, key) => declarationHas(t, key, NO_INDEXED_PROPERTIES),
    preventExtensions: declarationsCannotBeSealed,
    set() { computedReadOnly(); }
  });
}
function makeComputedStyleProxy(el) {
  // (…and none at all while the engine does not style the element: one the page holds on to after it left the
  // document reads as empty, as one asked for then does)
  const styledNames = makeComputedNames();
  const names = (inlineStyle) => (engineValue(el, 'display') === undefined ? NO_NAMES : styledNames(inlineStyle));
  const inline = el.style;
  const indexedLength = () => names(inline).length;
  let implementation;
  return new Proxy(inline, {
    // The resolved-value declaration carries the same per-property IDL attributes the inline one
    // does, so `'flex-wrap' in getComputedStyle(el)` is true (Chrome, measured). Without this the
    // `in` fell through to the INLINE style behind this proxy, which only knows the declarations
    // actually written, so it answered false for every unset property — and every WPT `*-computed`
    // test failed on its opening `assert_true(property in getComputedStyle(target))`.
    //
    // Presence WITHOUT a `getOwnPropertyDescriptor` trap is the spec answer, not a shortcut: CSSOM
    // defines these as IDL attributes on CSSStyleDeclaration.prototype, so they are present but NOT
    // own — `css/cssom/cssstyledeclaration-properties.html` asserts `hasOwnProperty('color')` is
    // false, and Chrome, which defines them as own properties, fails that subtest. Adding the trap
    // to "match Chrome" would give the name back and lose the conformance. It would cost as well:
    // this proxy's TARGET is `el.style` — itself a proxy — so V8 consults the target's
    // `[[GetOwnProperty]]` on every property READ to check its invariants, and the trap then ran a
    // declaration lookup per read (measured 17-56% slower on `getComputedStyle(el).display` /
    // `.color` / `.width`, which app JS reads constantly). Reporting a name the target lacks stays
    // legal because a declaration refuses to be sealed — see `declarationsCannotBeSealed`.
    //
    // The indexed run is this declaration's OWN — every supported longhand plus the element's
    // custom properties, the same list `length` / `item` / the iterator walk below. Letting it fall
    // through to the target would have answered from however many INLINE declarations the element
    // happened to carry, so `0 in getComputedStyle(el)` was false for a bare element and true for a
    // styled one.
    has: (target, key) => declarationHas(target, key, indexedLength),
    preventExtensions: declarationsCannotBeSealed,
    get(target, key, receiver) {
      if (DECL_MEMBERS.has(key)) return readMember(target, key, receiver,
        implementation || (implementation = resolvedDeclaration(el, inline, names)));
      if (key === globalThis.Symbol.iterator) return function* () { yield* names(target); };
      if (typeof key === 'string' && /^\d+$/.test(key)) return names(target)[+key] || '';
      if (typeof key !== 'string') {
        if (key !== DECLARATION_IMPLEMENTATION) return target[key];
        return implementation || (implementation = resolvedDeclaration(el, inline, names));
      }
      const kebab = camelToKebab(key);
      const r = readComputed(el, kebab);
      // A name this resolved style has no value for is no inline declaration's either: '' for a property — the
      // engine's for every one it styles — and the declaration's own member otherwise.
      return r.hit ? r.value : declarationMiss(target, key, receiver, kebab);
    },
    set() { computedReadOnly(); }
  });
}

// The pseudo-elements getComputedStyle recognizes, double- or legacy single-colon.
// Matched against the RAW argument (no trimming): a trailing token — even a space
// (`"::before "`) — makes it invalid, and getComputedStyle then returns an empty
// declaration. A colonless argument (`"before"`) is ignored, not invalid.
const VALID_PSEUDO_ELEMENT = /^::?(before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|grammar-error|spelling-error|target-text|cue)$/i;

globalThis.getComputedStyle = function (el, pseudoElt) {
  if (!el || el._nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
  // The style is the ELEMENT's document's (CSSOM: its node document's), resolved where that document lives: a frame's
  // element read through its parent's `getComputedStyle` styled nothing in the frame, so a class change after it had no
  // before-change style there and started no transition.
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (view && view !== globalThis && typeof view.getComputedStyle === 'function' && view.getComputedStyle !== globalThis.getComputedStyle) {
    return view.getComputedStyle(el, pseudoElt);
  }
  // An element the engine does not style — detached, inside a shadow tree whose host is detached, or in a document with
  // no browsing context — has an EMPTY resolved style (CSSOM: length 0, every property ''; getComputedStyle
  // -detached-subtree). A disconnected one is answered here, without asking the engine; the declaration below reads
  // empty for the rest, and for one that leaves the document while a page holds its declaration.
  if (!el.isConnected) return emptyComputedDeclaration();
  // A pseudo-element argument that is a colon-prefixed selector but not a valid
  // pseudo-element yields an empty declaration (CSSOM "invalid pseudo-element").
  // A colonless string is ignored, and a valid pseudo-element other than the generated ones below reads the
  // originating element's style.
  if (pseudoElt != null && pseudoElt !== '' && String(pseudoElt)[0] === ':' && !VALID_PSEUDO_ELEMENT.test(String(pseudoElt))) {
    return emptyComputedDeclaration();
  }
  // `::before` / `::after` resolve on the generated-content node — the one the layout sized, when
  // it generates anything, and one that renders nothing otherwise (Chrome: `content: none`,
  // `width: auto`, the rest inherited from the element).
  if (pseudoElt != null && pseudoElt !== '') {
    const m = /^::?(before|after)$/i.exec(String(pseudoElt));
    const node = m ? pseudoNodeFor(el, m[1].toLowerCase(), true) : /^::placeholder$/i.test(String(pseudoElt)) ? placeholderNodeFor(el) : null;
    if (node) return computedStyleProxyOf(node);
  }
  return computedStyleProxyOf(el);
};
// Kept in a MODULE-LOCAL map, not on the element: a frame realm evaluates its own copy of this bundle, reading its own
// engine, and an element adopted into a frame's document takes its reads there — a proxy kept on the element was the
// realm's that read it FIRST, and answered every later read from that realm's engine, which no longer styles it.
const COMPUTED_STYLE_PROXIES = new WeakMap();
function computedStyleProxyOf(el) {
  let proxy = COMPUTED_STYLE_PROXIES.get(el);
  if (proxy === undefined) COMPUTED_STYLE_PROXIES.set(el, proxy = makeComputedStyleProxy(el));
  return proxy;
}

// Batched style read — `Node#style(['width', 'height'])` pays one
// V8 round-trip from Ruby instead of one per property.
globalThis.__csimComputedStyle = function (handle, names) {
  const el = handles.get(handle);
  if (!el || el._nodeType !== NODE_ELEMENT) return {};
  const proxy = globalThis.getComputedStyle(el);
  const out = {};
  for (const n of names) out[n] = String(proxy[n] || '');
  return out;
};
