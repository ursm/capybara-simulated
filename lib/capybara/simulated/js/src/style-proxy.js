// ElementCSSInlineStyle's `style` — Proxy over the inline `style="..."`
// attribute that surfaces both camelCase IDL access
// (`style.backgroundColor`) and kebab-case (`style['background-color']`).
// Reads parse the attribute; writes round-trip through the decl
// parser so the attribute stays canonical regardless of how the
// caller phrased the value.
//
// `getComputedStyle(el)` returns a small Proxy that reads the style engine's computed values, and layout's used ones
// where CSSOM says so — a new one each call, as CSSOM's steps make it (Chrome too): what it reads is the engine's, kept
// there, so the object is all a call makes. (jQuery 3.x's `.css()` / `:visible` / `isHiddenWithinTree` lands here on
// every probe.)

import { NODE_ELEMENT } from './constants.js';
import { isConnected } from './walk.js';
import { arenaNid, rareDataOf, sameObject, nodeDocumentOf } from './native-query-shadow.js';

import { engineValue, styleEngineResolvedValue, styleEngineCustomPropertyCount, styleEngineCustomPropertyName } from './cascade.js';
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, isSupportedCssPropertyName, documentBaseUrl, LONGHANDS } from './css-utils.js';
import { lookup }                        from './handles.js';
import { documentBaseURL } from './base-url.js';
import { Stamp, arrayIndex, ceEnter, ceLeave, objectCreate }  from './webidl.js';
import { legacyCSSStyleDeclaration } from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { asciiLower } from './ascii.js';
import { attrsOf, nidOf, nodeTypeOf, stampNamedNode, stampGeneratedBox } from './node-identity.js';
import { setAttribute } from './dom-nodes.js';
import { defaultViewOf } from './document-state.js';
import { dom, hooksOf, hostSteps, rawWindowOf, realmHooks } from './engine.js';
import {
  arrayValues, InternalMap, InternalSet, objectHasOwnProperty, reflectApply, reflectGet, stringIndexOf
} from './intrinsics.js';

// A resolved-value (computed) declaration enumerates every CSS LONGHAND the style engine computes, in
// lexicographic order with the vendor-prefixed ones after the rest (getComputedStyle-property-order /
// -logical-enumeration): shorthands and aliases are excluded (LONGHANDS is exactly the longhand set). After them come
// the custom properties the element has a computed value for — its own, inherited, or a registered one's initial value
// — as the style engine's computed map holds them, in its order: Firefox's set and order (Chrome's holds one declared
// `initial` too, which the map drops). An element the engine does not style lists none.
// KNOWN GAP (bounded): the proxy has no `ownKeys` trap, so `Object.keys(gCS)` stays `[]` (indices aren't own keys).
const COMPUTED_LONGHAND_NAMES = [...LONGHANDS].sort((a, b) =>
  (a.charCodeAt(0) === 45) - (b.charCodeAt(0) === 45) || (a < b ? -1 : 1));
// How many names `el`'s resolved style lists…
function computedLength(el) {
  const custom = styleEngineCustomPropertyCount(el);
  return custom === undefined ? 0 : COMPUTED_LONGHAND_NAMES.length + custom;
}
// …the `index`th of them, '' past the last…
function computedNameAt(el, index) {
  const custom = index - COMPUTED_LONGHAND_NAMES.length;
  if (custom >= 0) return styleEngineCustomPropertyName(el, custom) ?? '';
  return styleEngineCustomPropertyCount(el) === undefined ? '' : COMPUTED_LONGHAND_NAMES[index];
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
//   interface:     the declaration interface it is (`storeInterface`): CSSStyleProperties where absent
//   nid():         an element's arena node, for its `style` attribute (`storeNid`)
//   rule():        a CSSOM rule's handle, for its block (`storeRule`)
// `makeDeclProxy` turns a store into the live CSSStyleDeclaration Proxy every
// caller sees (`el.style`, `rule.style`). The Proxy target's prototype is its
// interface's, so `x instanceof CSSStyleDeclaration` holds.

// The block's text and its document's mode, which every op over it takes (`__dom.decl*`, cssom_decl.rs: the style
// engine's own declaration blocks, so a page's CSSOM parses and serializes as the style it computes). The text is all
// that is kept here: the attribute's value, or the serialization of the rule's block.
const storeText = (store) => store.read() || '';
// …and the kind of block it is (cssom_decl.rs `Kind`): a style rule's — an element's `style` attribute is one — 0, a
// keyframe's 1, a page's 2, an `@font-face` rule's descriptors 3.
const storeKind = (store) => store.kind || 0;
// …the interface the declaration is (cssom.js `declarationPrototypes`).
const storeInterface = (store) => store.interface || 'CSSStyleProperties';
// …and the document it parses in: its mode, and the base its `url()`s resolve against.
const storeDocument = (store) => (store.document ? store.document() : globalThis.document);
// (…by its nid, whose mode the engine reads: -1 for none)
function storeDocNid(store) {
  const doc = storeDocument(store);
  return doc ? nidOf(doc) : -1;
}
function storeBase(store) {
  const doc = storeDocument(store);
  return doc && doc !== globalThis.document ? documentBaseURL(doc) : documentBaseUrl();
}
// …and, for an element's `style` attribute, the element's arena node, which keeps the block a write made — what every
// read and the next write are of, and the style engine computes the element's style from (cssom_decl.rs) — and -1 for
// any other block.
const storeNid = (store) => (store.nid ? store.nid() : -1);
// …and, for a CSSOM rule's block, the rule's handle (cssom.js): every read and write is of the rule's own block, which the
// engine cascades — and -1 for any other block.
const storeRule = (store) => (store.rule ? store.rule() : -1);
// What a page reads of one block between two writes — the names it indexes and iterates, and the values it asks for —
// kept on the store (one per block) under the text it was read from, so a write (a new text) misses. jQuery's `.css()`
// and Floating UI read a dozen properties of one element at a time (rule 3).
function storeReads(store) {
  const text = storeText(store);
  if (store.readsOf !== text) {
    store.readsOf = text;
    store.reads = { names: null, values: new InternalMap() };
  }
  return store.reads;
}
// …of which an empty block's names are none.
const NO_NAMES = Object.freeze([]);
function storeNames(store) {
  const reads = storeReads(store);
  const text = storeText(store);
  return reads.names ??= (text ? dom.declNames(text, storeKind(store), storeDocNid(store), storeBase(store), storeNid(store), storeRule(store)) : NO_NAMES);
}

// `getPropertyValue(name)`: a shorthand serialized from its longhands, '' for a property the block does not set.
function propValue(store, name) {
  const text = storeText(store);
  if (!text) return '';
  const values = storeReads(store).values;
  let v = values.get(name);
  if (v === undefined) values.set(name, v = dom.declValue(text, storeKind(store), storeDocNid(store), storeBase(store), name, storeNid(store), storeRule(store)));
  return v;
}

function propPriority(store, name) {
  const text = storeText(store);
  return text && dom.declImportant(text, storeKind(store), storeDocNid(store), storeBase(store), name, storeNid(store), storeRule(store)) ? 'important' : '';
}

// `setProperty(name, value, priority)`: an empty value removes the property, a priority other than `important` is no
// write at all, and so is a value the property does not parse — and the text is written only where the block CHANGED
// (CSSOM "update style attribute", and with it the mutation record, runs only then).
function writeStoreProp(store, name, value, priority) {
  if (value === '') { removeStoreProp(store, name); return; }
  const p = priority == null ? '' : String(priority);
  if (p !== '' && asciiLower(p) !== 'important') return;
  const next = dom.declSet(storeText(store), storeKind(store), storeDocNid(store), storeBase(store), name, value, p !== '', storeNid(store), storeRule(store));
  if (next !== null) store.write(next);
}

function removeStoreProp(store, name) {
  const pair = dom.declRemove(storeText(store), storeKind(store), storeDocNid(store), storeBase(store), name, storeNid(store), storeRule(store));
  const old = pair[0], next = pair[1];
  if (next !== null) store.write(next);
  return old;
}


// CSSOM's own members, as opposed to the per-property IDL attributes it also defines. They live on
// the interface prototype (cssom.js), where each one reads its receiver's implementation — so
// `a.style.item`, `b.style.item` and `CSSStyleDeclaration.prototype.item` are all the SAME function,
// as they are in Chrome (measured, 151.0.7922.169). Synthesizing them per access in the `get` trap
// made every read a different object, which a page comparing two declarations member by member can
// see (`html/rendering/…/multicol-*-mode.html` does exactly that).
export const DECL_ATTRIBUTES = new InternalSet(['cssText', 'length', 'parentRule']);
export const DECL_METHODS    = new InternalSet(['getPropertyValue', 'getPropertyPriority', 'setProperty',
  'removeProperty', 'item']);
export const DECL_MEMBERS    = new InternalSet([...DECL_ATTRIBUTES, ...DECL_METHODS]);

// The implementation behind a live declaration — an inline one, a resolved one, and the empty
// resolved one each supply their own, named as CSSOM names them. It travels WITH the declaration,
// private fields stamped on its Proxy's target (its state, and the step that makes the implementation of
// it as it is first asked for), rather than sitting in a map on the side: a node adopted out of an iframe
// keeps the declaration its own realm built, while the prototype member that runs belongs to the realm of
// whoever reads it — and every realm of the isolate is made from the one snapshot, which shares the class's
// private name between them. No page reaches it, nor makes an object that has one. (The target's, found
// behind the Proxy by the engine — `proxyTarget` — not the Proxy's own: a field added to a Proxy costs a runtime
// call, some 150 ns, and `getComputedStyle` makes one each call.)
class Declaration extends Stamp {
  #state;
  #implementation;
  constructor(o, state, implementation) {
    super(o);
    this.#state = state;
    this.#implementation = implementation;
  }
  static of(o) {
    if (typeof o !== 'object' || o === null) return undefined;
    const target = dom.proxyTarget(o);
    return target !== undefined && #state in target ? target.#implementation(target.#state) : undefined;
  }
}
// (…each kind's implementation, of its state, made as it is first asked for)
const storedImplementation = (d) => (d.implementation ??= writableDeclaration(d.store));
const resolvedImplementation = (d) => (d.implementation ??= resolvedDeclaration(d.el));
const emptyImplementation = () => EMPTY_DECLARATION;
// The prototype of each declaration interface by its name (cssom.js fills it as it loads): what a declaration's Proxy
// target inherits — CSSStyleProperties' unless its store names another (a rule's descriptors: `store.interface`).
export const declarationPrototypes = {};
export const declarationImplementation = Declaration.of;

// Each declaration — an inline / rule one, a resolved-value one, and the empty one a detached element or an unknown
// pseudo yields — is a legacy platform object of its indexed properties (CSSOM's `getter item(index)`: its run, each the
// property name at the index, read-only — generated, `legacyCSSStyleDeclaration`), whose state is a record of its own
// (the steps' `d`, read off its target by `legacyArgOf`), and which answers a property's read, write and presence
// itself first: a CSS property's IDL attribute, its prototype's accessor, answered without the lookup. (Its property
// attributes are its prototype's, no own property of its: see `has` below.)
//
// What is `in` a declaration, shared by all three so that presence cannot drift from the getter that answers next to it.
// Four things are there: the interface's own members; the indexed run (the legacy object's, whose length is the one
// thing the three differ on); EVERY supported property name, in both spellings, set or not; and finally whatever the
// target itself carries — an expando parked under a name that is not a property (`style.COLOR = …`) or a prototype
// member (`toString`). A CUSTOM property is deliberately absent even once set: `--x` gets no IDL attribute, so Chrome
// answers `false` to `'--x' in el.style` while still counting it in `length` and naming it from `item(0)` (measured,
// Chrome 151.0.7922.108).
//
// Presence WITHOUT a property's own descriptor is the spec answer, not a shortcut: CSSOM defines these as IDL
// attributes on CSSStyleDeclaration.prototype, so they are present but NOT own — `css/cssom/cssstyledeclaration-
// properties.html` asserts `hasOwnProperty('color')` is false, and Chrome, which defines them as own properties, fails
// that subtest. Reporting a name the target lacks stays legal because a declaration refuses to be sealed, as a legacy
// platform object does.
function declarationHas(target, key, legacy) {
  if (typeof key === 'string' && isSupportedCssPropertyName(camelToKebab(key))) return true;
  return indexedHas(target, key, legacy);
}
// …and of a declaration of no property attributes (a descriptors interface's): its members, its indices, and what its
// prototype has.
function indexedHas(target, key, legacy) {
  return DECL_MEMBERS.has(key) || key === Symbol.iterator || legacy.has(target, key);
}

// Reading one of those members. An ATTRIBUTE is a value, so it comes straight from this
// declaration's implementation; a METHOD has to be the shared function the prototype holds, so it
// resolves through the prototype with this declaration as the receiver.
function readMember(target, prop, receiver, implementation) {
  return DECL_ATTRIBUTES.has(prop) ? implementation[prop] : reflectGet(target, prop, receiver);
}

// What a declaration answers for a name it has no value for: '' for a supported property, which is merely unset — never
// through the target, whose prototype holds an IDL accessor for every property that would run against an internal
// receiver with no declaration behind it — and for any other name (a custom property, which has no attribute; a
// prototype member; an expando) an ordinary [[Get]], through `Reflect` so an accessor the page installed runs against the
// DECLARATION: `undefined` for a name nothing has (Chrome).
function declarationMiss(target, prop, receiver, kebab) {
  return isSupportedCssPropertyName(kebab) ? '' : reflectGet(target, prop, receiver);
}

// A writable declaration's (an element's inline style, a rule's block), its state `{ store, properties, implementation }`:
// its run the stored declarations' names. Only a CSSStyleProperties has an attribute for every property, which its
// `get` / `set` / `has` answer here (`properties`); a descriptors interface's few are its prototype's accessors.
const storedDeclarationObject = legacyCSSStyleDeclaration({
  get_length: (d) => storeNames(d.store).length,
  item: (d, index) => storeNames(d.store)[index]
}, (legacy, legacyArgOf) => ({
  get(t, prop, receiver) {
    const d = legacyArgOf(t);
    if (DECL_MEMBERS.has(prop)) return readMember(t, prop, receiver, storedImplementation(d));
    // (…its @@iterator %Array.prototype.values%, as Web IDL makes an indexed getter's: `length` and each index read
    // through the declaration)
    if (prop === Symbol.iterator) return arrayValues;
    // Non-string keys (Symbol.toStringTag, …) resolve from the target's prototype.
    if (typeof prop !== 'string') return reflectGet(t, prop, receiver);
    if (!d.properties || arrayIndex(prop) >= 0) return legacy.get(t, prop, receiver);
    // Hot path: a CSS property read returns its value directly. Only on a MISS do we
    // fall back to a prototype Object member (toString / valueOf / constructor / …),
    // so the common value-returning read never pays the proto-chain walk (rule 3).
    // An OWN property of the target wins: it is an expando, or a descriptor an author installed
    // with `Object.defineProperty(el.style, …)`, and a non-configurable one makes any other
    // answer a [[Get]] invariant violation that V8 raises from inside the read.
    if (reflectApply(objectHasOwnProperty, t, [prop])) return reflectGet(t, prop, receiver);
    // A supported property's attribute answers its value ('' unset); any other name — a custom property (`--x`, which
    // has no attribute: getPropertyValue reads it) among them — is no attribute of the declaration's
    // (`declarationMiss`): `undefined` where nothing has it, which `style[prefixed] !== undefined` feature detection
    // reads.
    const kebab = camelToKebab(prop);
    return isSupportedCssPropertyName(kebab) ? propValue(d.store, kebab) : declarationMiss(t, prop, receiver, kebab);
  },
  set(t, prop, value, receiver) {
    // A named-property write maps to a CSS declaration only when the camelCased name folds to a
    // SUPPORTED property (`backgroundColor` → `background-color`, `cssFloat` → `float`). Any other
    // name — `COLOR` (folds to `-c-o-l-o-r`), `unknown`, a `--custom` property (settable only via
    // setProperty) — is a plain expando, exactly as browsers treat it. The value is IDL
    // `[LegacyNullToEmptyString]`: `null` clears (→ ''); `undefined` stringifies to 'undefined'.
    const d = legacyArgOf(t);
    if (d.properties && typeof prop === 'string') {
      const kebab = camelToKebab(prop);
      if (isSupportedCssPropertyName(kebab)) {
        // ([CEReactions], as the property's IDL attribute is: an element's `style` it writes is an attribute change)
        const ce = ceEnter();
        try { writeStoreProp(d.store, kebab, value === null ? '' : String(value)); } finally { ceLeave(ce); }
        return true;
      }
    }
    // Everything else is written the way an ordinary object would write it: an interface member
    // through its prototype setter (`cssText` has one; `length` and `parentRule` are readonly and
    // refuse, as they do in a browser), an author's accessor through that accessor, and anything
    // left over as a plain expando — an index none, the run's to answer.
    return legacy.set(t, prop, value, receiver);
  },
  // Reporting only the STORED declarations here failed the first assertion of every WPT
  // `*-computed` test — `assert_true(property in getComputedStyle(target))` — before the test
  // could read a value.
  has: (t, prop) => (legacyArgOf(t).properties ? declarationHas(t, prop, legacy) : indexedHas(t, prop, legacy))
}));
export function makeDeclProxy(store) {
  // Its target an object (so `typeof style === 'object'`) whose prototype is its interface's (so `instanceof` holds):
  // jQuery's `isHiddenWithinTree` typeof check, `el.style instanceof CSSStyleDeclaration`.
  const target = objectCreate(declarationPrototypes[storeInterface(store)]);
  const d = { store, properties: storeInterface(store) === 'CSSStyleProperties', implementation: undefined };
  new Declaration(target, d, storedImplementation);
  return storedDeclarationObject(target, d);
}

// ElementCSSInlineStyle's `style` — a CSSStyleDeclaration over the inline `style=""`
// attribute. Writes call `setAttribute('style', …)` (which replaces the immutable
// string, invalidating the parse cache on `el`); reads parse it (cached on `el`).
// An element's inline style declaration — one per element, made when first asked for: what its `style` attribute
// (HTMLElement / SVGElement / MathMLElement's) answers, and what the driver reads behind a computed style whatever
// interface the element has.
export function inlineStyleOf(el) {
  return sameObject(el, 'style', makeStyleProxy);
}

export function makeStyleProxy(el) {
  return makeDeclProxy(inlineStore(el));
}
// (…its style attribute's declarations, as a store the declaration steps read and write)
function inlineStore(el) {
  return {
    read:    () => attrsOf(el)?.style || '',
    write:   (s) => setAttribute(el, 'style', s),
    document: () => nodeDocumentOf(el),
    nid:     () => arenaNid(el)
  };
}
// …and a property of them set by the platform — an animation's committed styles — with the steps `setProperty` takes,
// through no member a page may replace.
export function setInlineStyleProperty(el, property, value) {
  writeStoreProp(inlineStore(el), cssPropertyName(property), value, '');
}

function camelToKebab(name) {
  // A leading `--` (custom property) passes through unchanged.
  if (stringIndexOf(name, '--') === 0) return name;
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


// The value `el` has for `key`: the style engine's computed value — the cascade, the UA sheet and every animation and
// transition layer applied — where a reader here asks for a declared one, which it then finds already resolved (an `em`
// to px, an `inherit` to the parent's, an undeclared property to the UA's or its initial). Null where there is none:
// an ANONYMOUS box, which no selector names and which has no style attribute (CSS Display §2.3), so that every property
// is its initial value; an element the engine does not style; and a name that is no property.
export function declaredValue(el, key) {
  return engineValue(el, key) ?? null;
}
// …and its RESOLVED value, what `getComputedStyle` reports (`styleEngineResolvedValue`): `{hit, value}`, a miss where
// the engine answers none.
function readComputed(el, key) {
  const value = styleEngineResolvedValue(el, key);
  return value === undefined ? NO_VALUE : { hit: true, value };
}
const NO_VALUE = Object.freeze({ hit: false });



// ── Generated content ──────────────────────────────────────────────────────────────────────────
// A `::before` / `::after` with a `content` is a box in the flow — an inline one by default, holding
// the text the `content` names — and a box the layout can size, place and paint like any other.
// It is no DOM node: nothing that walks the DOM (`innerText`, a query, an observer) sees it, and a
// hit over it answers its originating element, which is what Chrome does. Whether it renders, its text and its box are
// the engine's: the walk lays it out from the style engine's values, in a slot of its own made the first time it renders
// (dom.rs `link_generated`). What this side keeps is its HOLDER, the object `getComputedStyle(el, '::before')` answers
// and the painter draws its text with: stamped with that element and its pseudo-element, privately (node-identity.js
// `originOf`, `pseudoOf`), the style engine answering its properties as the originating element's pseudo-element's
// (cascade.js `engineValue`), and an element's node type with no node's identity (node-identity.js).
//
// One holder per element per pseudo, kept for the element's life so its computed-style proxy survives.
const PSEUDO_TAGS = { before: '::before', after: '::after', placeholder: '::placeholder' };
function makePseudoNode(el, which) {
  const node = {
    nodeType: NODE_ELEMENT,
    get isConnected() { return isConnected(el); },
    get ownerDocument() { return nodeDocumentOf(el); },
    get tagName() { return PSEUDO_TAGS[which]; },
    get localName() { return PSEUDO_TAGS[which]; },
    get id() { return ''; },
    get className() { return ''; }
  };
  stampGeneratedBox(node, which, el);
  node.style = makeStyleProxy(node);
  return stampNamedNode(node, NODE_ELEMENT, undefined, undefined, PSEUDO_TAGS[which], PSEUDO_TAGS[which], null);
}
// The holder of `el`'s `::before` or `::after` (`which`), whether or not it renders — kept in its rare data.
export function pseudoNodeFor(el, which) {
  const rare = rareDataOf(el, true);
  return which === 'before' ? (rare.beforeHolder ??= makePseudoNode(el, which)) : (rare.afterHolder ??= makePseudoNode(el, which));
}
// The `::placeholder` of `el`: a style holder and nothing more — what `getComputedStyle(el, '::placeholder')` reads; no
// layout box ever holds it. One per element, for the element's life.
export function placeholderNodeFor(el) {
  return rareDataOf(el, true).placeholderHolder ??= makePseudoNode(el, 'placeholder');
}




// A resolved-value CSSStyleDeclaration (getComputedStyle) is READ-ONLY: mutating it
// throws NoModificationAllowedError, and `cssText` serializes to '' (per CSSOM, a
// computed style has no author declaration text).
function computedReadOnly() {
  throw new DOMException('Cannot modify the computed style', 'NoModificationAllowedError');
}
// getComputedStyle for an invalid pseudo-element returns an EMPTY, read-only
// declaration: length 0, every property reads '', and any mutation throws
// (CSSStyleDeclaration-is-immutable holds for the empty result too).
// How a WRITABLE declaration — an element's inline style, or a rule's block — implements CSSOM's
// own members. Built on first use: a declaration that is only ever read by property name never
// needs one, and `el.style` is constructed far more often than its members are called.
function writableDeclaration(store) {
  return {
    interface: storeInterface(store),
    // CSSOM: `cssText` is the CANONICAL serialization of the declaration block — canonical values
    // AND shorthand reconstruction (longhands collapse to `margin: 1px 2px`), trailing `;`,
    // normalized spacing — not the raw source. Setting it PARSES + re-serializes (dropping
    // syntactically invalid declarations), and unlike a per-property mutation it ALWAYS rewrites
    // the source (CSSOM "set css text" unconditionally invokes "update style attribute"), so it
    // queues a mutation record even when the serialized value is unchanged.
    get cssText()      { const text = storeText(store); return text && dom.declText(text, storeKind(store), storeDocNid(store), storeBase(store), storeNid(store), storeRule(store)); },
    set cssText(value) { store.write(dom.declReplace(String(value == null ? '' : value), storeKind(store), storeDocNid(store), storeBase(store), storeNid(store), storeRule(store))); },
    // CSSStyleDeclaration is an indexed getter: `style[0]` / `style.item(0)` is the 0-based
    // property NAME, and it is iterable over those names. `length` counts them.
    get length()       { return storeNames(store).length; },
    item:              (index) => storeNames(store)[index >>> 0] || '',
    // The rule a declaration belongs to, or null when it belongs to an element. Only `ruleStyle`
    // passes an owner.
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
  interface: 'CSSStyleProperties',
  get cssText()       { return ''; },
  set cssText(_value) { computedReadOnly(); },
  get parentRule()    { return null; },
  getPropertyPriority: () => '',
  setProperty:         computedReadOnly,
  removeProperty:      computedReadOnly
};

// …and how a RESOLVED one does, over the cascade rather than a stored block.
function resolvedDeclaration(el) {
  return {
    __proto__: RESOLVED_DECLARATION,
    getPropertyValue: (property) => {
      const r = readComputed(el, cssPropertyName(property));
      return r.hit ? r.value : '';
    },
    // Enumeration: length / item / the indexed getter / the iteration walk cover every supported
    // longhand (plus the element's custom properties), NOT the inline declarations.
    get length()  { return computedLength(el); },
    item:         (index) => computedNameAt(el, index >>> 0)
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

// A read-only declaration's property attribute refuses a write — NoModificationAllowedError, as its setter does (Chrome
// and Firefox) — and anything else is written as onto any object: an expando kept, `cssText` through its setter, which
// refuses too. (A definition is an ordinary one, of an own property the reads then answer — the attribute is the
// prototype's: Firefox; Chrome refuses it.)
function readOnlySet(legacy, t, key, value, receiver) {
  if (typeof key === 'string' && isSupportedCssPropertyName(camelToKebab(key))) computedReadOnly();
  return legacy.set(t, key, value, receiver);
}
// The resolved-value declaration of an element (its state `{ el, implementation, expandos }`): read-only, its run every
// supported longhand plus the element's custom properties — the same list `length` / `item` / the iterator walk — none at all
// while the engine does not style the element (one the page holds on to after it left the document reads as empty, as
// one asked for then does). Its own run, not the INLINE style's behind it: `0 in getComputedStyle(el)` was false for a
// bare element and true for a styled one. It carries the same per-property IDL attributes the inline one does, so
// `'flex-wrap' in getComputedStyle(el)` is true (Chrome, measured) — every WPT `*-computed` test opens on it.
const resolvedDeclarationObject = legacyCSSStyleDeclaration({
  get_length: (d) => computedLength(d.el),
  item: (d, index) => computedNameAt(d.el, index)
}, (legacy, legacyArgOf) => ({
  has: (t, key) => declarationHas(t, key, legacy),
  get(t, key, receiver) {
    const d = legacyArgOf(t);
    if (DECL_MEMBERS.has(key)) return readMember(t, key, receiver, resolvedImplementation(d));
    if (key === Symbol.iterator) return arrayValues;
    if (typeof key !== 'string') return reflectGet(t, key, receiver);
    // (…an own property of its, one a page wrote or defined, asked for only where it has been given one: every read of a
    // computed style is no lookup of them)
    if (arrayIndex(key) >= 0 || (d.expandos && reflectApply(objectHasOwnProperty, t, [key]))) {
      return legacy.get(t, key, receiver);
    }
    const kebab = camelToKebab(key);
    // (…a custom property no attribute of this one's either: getPropertyValue reads it)
    const r = stringIndexOf(kebab, '--') === 0 ? null : readComputed(d.el, kebab);
    // A name this resolved style has no value for is no inline declaration's either: '' for a property — the
    // engine's for every one it styles — and the declaration's own member otherwise.
    return r !== null && r.hit ? r.value : declarationMiss(t, key, receiver, kebab);
  },
  set(t, key, value, receiver) {
    const written = readOnlySet(legacy, t, key, value, receiver);
    legacyArgOf(t).expandos = true;
    return written;
  },
  defineProperty(t, key, desc) {
    legacyArgOf(t).expandos = true;
    return legacy.defineProperty(t, key, desc);
  }
}));
// …and the empty one, of an element not being rendered or an unknown pseudo-element: still a CSSStyleProperties (its
// target inherits the interface prototype, so `instanceof` holds and the members resolve from it), every property ''
// — and present: a detached element's computed style has every property, so `'width' in getComputedStyle(detached)` is
// true in Chrome exactly as it is for an attached one — and its run empty.
const emptyDeclarationObject = legacyCSSStyleDeclaration({
  get_length: () => 0,
  item: () => ''
}, (legacy) => ({
  has: (t, key) => declarationHas(t, key, legacy),
  get(t, key, receiver) {
    if (DECL_MEMBERS.has(key)) return readMember(t, key, receiver, EMPTY_DECLARATION);
    if (key === Symbol.iterator) return arrayValues;
    // Every property resolves to '' here; anything else the target can answer for is a prototype
    // member (`toString`, `constructor`).
    if (typeof key !== 'string') return reflectGet(t, key, receiver);
    if (reflectApply(objectHasOwnProperty, t, [key])) return legacy.get(t, key, receiver);
    return declarationMiss(t, key, receiver, camelToKebab(key));
  },
  set: (t, key, value, receiver) => readOnlySet(legacy, t, key, value, receiver)
}));
function emptyComputedDeclaration() {
  const target = objectCreate(declarationPrototypes.CSSStyleProperties);
  new Declaration(target, null, emptyImplementation);
  return emptyDeclarationObject(target);
}
// (…its target an object of the interface's own, as the empty one's is: nothing the page set on the INLINE style — an
// expando — is the resolved style's to answer, Chrome)
function makeComputedStyleProxy(el) {
  const d = { el, implementation: undefined, expandos: false };
  const target = objectCreate(declarationPrototypes.CSSStyleProperties);
  new Declaration(target, d, resolvedImplementation);
  return resolvedDeclarationObject(target, d);
}

// The Window's `getComputedStyle` (window.js, which converted its arguments: `el` an element).
export function getComputedStyle(el, pseudoElt) {
  // The style is the ELEMENT's document's (CSSOM: its node document's), resolved where that document lives: a frame's
  // element read through its parent's `getComputedStyle` styled nothing in the frame, so a class change after it had no
  // before-change style there and started no transition.
  const doc = nodeDocumentOf(el), view = doc && defaultViewOf(doc);
  const raw = view && rawWindowOf(view);
  const other = raw && raw !== globalThis && hooksOf(raw)?.getComputedStyle;
  if (other) return other(el, pseudoElt);
  // An element the engine does not style — detached, inside a shadow tree whose host is detached, or in a document with
  // no browsing context — has an EMPTY resolved style (CSSOM: length 0, every property ''; getComputedStyle
  // -detached-subtree). A disconnected one is answered here, without asking the engine; the declaration below reads
  // empty for the rest, and for one that leaves the document while a page holds its declaration.
  if (!isConnected(el)) return emptyComputedDeclaration();
  // A colon-prefixed argument is parsed as a <pseudo-element-selector> (the engine's selector parser): one that is none —
  // `::slotted()` / `::part()`, a pseudo-class, anything around it, even a space — yields an empty declaration (CSSOM
  // "invalid pseudo-element"). A colonless string is ignored. `::before` / `::after` resolve on the generated-content
  // node — the one the layout sized, when it generates anything, and one that renders nothing otherwise (Chrome:
  // `content: none`, `width: auto`, the rest inherited from the element) — `::placeholder` on the placeholder's, and any
  // other reads the originating element's style.
  if (pseudoElt != null && pseudoElt !== '' && String(pseudoElt)[0] === ':') {
    const name = dom.pseudoElementSelector(String(pseudoElt));
    if (name === null) return emptyComputedDeclaration();
    const node = name === 'before' || name === 'after' ? pseudoNodeFor(el, name) : name === 'placeholder' ? placeholderNodeFor(el) : null;
    if (node) return makeComputedStyleProxy(node);
  }
  return makeComputedStyleProxy(el);
}
// …which another realm's asks for an element of this realm's document.
realmHooks.getComputedStyle = getComputedStyle;

// Batched style read — `Node#style(['width', 'height'])` pays one
// V8 round-trip from Ruby instead of one per property.
hostSteps.computedStyle = function (handle, names) {
  const el = lookup(handle);
  if (!el || nodeTypeOf(el) !== NODE_ELEMENT) return {};
  const proxy = realmHooks.getComputedStyle(el);
  const out = {};
  for (let i = 0; i < names.length; i++) { const n = names[i]; out[n] = String(proxy[n] || ''); }
  return out;
};
