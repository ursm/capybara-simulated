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
import { registerNativeBoxNode, linkPseudoBox } from './native-query-shadow.js';

// The element an inherited property is inherited FROM: the FLAT-tree parent — a slotted element
// inherits from its slot, a `<slot>` from the host chain through the shadow root, generated
// content from its originating element (CSS Scoping 1 §3.2). The DOM parent left a `<slot>` with
// no font at all, so slotted bare text measured in the default face.
const inheritParent = (el) => {
  const p = flatTreeParent(el);
  return p && p.nodeType === NODE_ELEMENT ? p : null;
};
import { animatedPropertiesOn, animationsCurrentlyAnimate } from './web-animations.js';
import { flushStyleEngine, lengthTextToPx, engineValue, styleEngineGenerated, styleEngineTransformMatrix, isRenderedLegend, noteUncacheableRead, ownedByThisRealm, splitImportant, declareStyledMemos } from './cascade.js';
import { canonicalLengthPercentage } from './canonical-values.js';
import { normalizeColor, CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, parseStyleDeclList, serializeCssValue, serializeFontFamily, canonicalizeOrigin, stripCssComments, splitTopLevel, splitTopLevelWhitespace, isSupportedCssPropertyName, unwrapCalc } from './css-utils.js';
// `normalizeColor` lives in css-utils now, where the value SERIALIZER needs it too — a hex
// colour is a colour wherever it appears, and the specified surface reports it in the same
// canonical form the computed one does. Re-exported so the rest of the tree keeps one import.
export { normalizeColor };
import { serializeDeclBlock, expandDeclList, declarationIsValid, isRegularShorthand, shorthandGet, shorthandExpand, shorthandLonghands, clearNamedLonghands, groupNeedsMove, allGet, allGetPriority, isCoveredByAll, isCssWideKeyword, pendingSource } from './shorthands.js';
import { currentViewport }               from './media-query.js';
import { chFactor, exFactor }            from './font-metrics.js';
import { hasMathFunction, reduceMathFunctions, simplifySpecifiedMath, ABSOLUTE_UNIT_PX as CALC_ABSOLUTE_PX } from './calc.js';
import { handles }                       from './handles.js';
import { LONGHANDS, SHORTHAND_LONGHANDS } from './css-property-data.js';
import { selectDisplaySize }              from './html-integers.js';

// A resolved-value (computed) declaration enumerates every CSS LONGHAND the style engine computes, in
// lexicographic order (getComputedStyle-property-order / -logical-enumeration): shorthands
// and env vars are excluded (LONGHANDS is exactly the longhand set), and any custom property
// present on the element is appended (custom / vendor names sort after standard ones). `all`
// is filtered out — it is the reset shorthand, never itself enumerated in a computed style.
// A longhand the engine does not implement (`animation-range`) is not enumerated, and reads ''.
// KNOWN GAPS (bounded): only the element's OWN inline custom properties are
// enumerated (inherited / registered ones need a cascaded custom-property model); and the
// proxy has no `ownKeys` trap, so `Object.keys(gCS)` stays `[]` (indices aren't own keys).
// Taken on the first enumeration, when the engine is there to ask.
let computedLonghandNames = null;
const COMPUTED_LONGHAND_NAMES = () => computedLonghandNames ??=
  [...LONGHANDS].filter((n) => n !== 'all' && globalThis.__dom.styleSupports(n)).sort();
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
    if (!custom) { sig = ''; return (cache = COMPUTED_LONGHAND_NAMES()); }
    const nextSig = custom.sort().join(',');
    if (nextSig !== sig || cache === null) { sig = nextSig; cache = COMPUTED_LONGHAND_NAMES().concat(custom); }
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
//   cacheOn:       object to memoize the parse on (keyed by source string)
// `makeDeclProxy` turns a store into the live CSSStyleDeclaration Proxy every
// caller sees (`el.style`, `rule.style`). The Proxy target's prototype is
// `CSSStyleDeclaration.prototype`, so `x instanceof CSSStyleDeclaration` holds.

// Parse `store.read()`, cached on `store.cacheOn` keyed by the source string.
// `getComputedStyle`/inline reads parse per property access; style-read-heavy
// callers (Floating UI reads ~10 props/element, jQuery `.css()`/`:visible`) would
// otherwise re-parse the same string once per property. Keying on the string
// auto-invalidates: a write replaces the source with a new string, so the next
// read misses. Read-only — the cached object is never mutated (writes parse a copy).
function storeDecls(store) {
  const s = store.read() || '';
  const holder = store.cacheOn;
  if (holder._declKey !== s) {
    // Canonicalize each value once per distinct source string (CSSOM "serialize a CSS
    // value") so per-property reads — the hot path — return the canonical form (`.5%`
    // → `0.5%`) whether the source was set via setProperty or a raw `style=""` attribute,
    // without re-parsing on every read.
    // Expand shorthands so the cached map is uniformly longhand-based (a `style=
    // "overflow: hidden"` source becomes overflow-x/-y), then canonicalize each value.
    // A custom property (`--*`) is a verbatim token stream — never canonicalized.
    const decls = expandDeclList(parseStyleDeclList(s));
    // `font-family` has its own serialization (Chrome-style quote normalization + single-ident
    // unquoting); every other property canonicalizes its numeric/url/string tokens generically.
    for (const k in decls) if (!k.startsWith('--')) decls[k] = k === 'font-family' ? serializeFontFamily(decls[k]) : serializeCssValue(decls[k], k);
    holder._declCache = decls;
    holder._declKey = s;
  }
  return holder._declCache;
}

// Property read (getPropertyValue / named access): a regular shorthand combines its
// longhands, everything else reads its own stored value. When the block carries an `all`
// declaration (rare), the cascade-aware `allGet` resolves it instead.
function propValue(store, name) {
  const decls = storeDecls(store);
  // Every route leaves through the same guard: a slot still holding a PENDING substitution has no
  // specified value of its own — `el.style.marginTop` is '' after `margin: var(--m)`, while
  // `el.style.margin` gives back `var(--m)` (measured). Returning `allGet`'s answer directly
  // skipped it, and `all: initial; margin: var(--m)` handed page script the internal marker.
  const specified = (v) => (pendingSource(v) ? '' : v);
  if (decls.all !== undefined) return specified(allGet(decls, name));
  // Read straight off the already-fetched map — this is the hottest read path (jQuery `.css()` /
  // Floating UI read many props).
  if (isRegularShorthand(name)) return specified(shorthandGet(decls, name, true));
  return decls[name] == null ? '' : specified(stripImportant(decls[name]));
}

// A shorthand's priority is `important` only when every longhand is present AND important
// (so the shorthand actually covers them all at that priority). An `all` declaration
// propagates its own priority to every property it covers.
function propPriority(store, name) {
  const decls = storeDecls(store);
  if (decls.all !== undefined) return allGetPriority(decls, name);
  if (!isRegularShorthand(name)) return decls[name] != null && splitImportant(decls[name]).important ? 'important' : '';
  const longhands = shorthandLonghands(name);
  return longhands.every(lh => decls[lh] != null && splitImportant(decls[lh]).important) ? 'important' : '';
}

// Round-trip through the ordered declaration parse so the serialized text is canonical
// regardless of how the existing value was written (raw `cssText` pastes can leave
// declarations without `;` separators). Removing collapses cleanly; setting
// overwrites. `setProperty(name, value, "important")` folds an explicit priority
// into the stored value as `value !important`; an unknown priority token is a no-op.
function writeStoreProp(store, name, value, priority) {
  const decls = expandDeclList(parseStyleDeclList(store.read() || ''));
  const before = serializeDeclBlock(decls);
  // Fold an explicit priority into the value; an unknown priority token is a no-op.
  let v = value;
  // A comment is not part of the value: it is stripped at tokenization, before storage or grammar.
  if (v !== '' && v != null && !name.startsWith('--')) v = stripCssComments(String(v));
  if (v !== '' && v != null) {
    if (/^\s*important\s*$/i.test(String(priority == null ? '' : priority))) {
      v = stripImportant(String(v)) + ' !important';
    } else if (priority != null && priority !== '') {
      return;
    }
  }
  // Reject a value the property's grammar can't accept (`declarationIsValid`, a shorthand's components
  // included) — like an unparseable shorthand, an invalid value is a no-op: the block is left untouched, so no
  // mutation record is queued (mutationrecord-002 / css-style-attr-decl-block invalid-value cases).
  if (v !== '' && v != null && !declarationIsValid(name, String(v))) return;
  // Same specified-surface simplification the block parse applies, so `style.x = 'calc(10px + 5px)'`
  // and `style.cssText = 'x: calc(10px + 5px)'` store the same `calc(15px)`.
  if (v !== '' && v != null && !name.startsWith('--')) v = simplifySpecifiedMath(String(v));
  if (name === 'all') {
    // `all` accepts only a css-wide keyword; any other value fails to parse and is a no-op
    // (the existing block is left untouched). It is stored as a single plain `all` key,
    // moved to the end so it overrides every prior declaration (css-cascade "all").
    if (v === '' || v == null) {
      delete decls.all;
    } else {
      if (!isCssWideKeyword(stripImportant(String(v)))) return;
      delete decls.all;
      decls.all = String(v);
    }
  } else if (isRegularShorthand(name)) {
    // A shorthand sets its longhands (CSSOM keeps the store in longhand form). Clearing
    // it removes them all; an unparseable value is a no-op (leaves the block untouched).
    const longhands = shorthandLonghands(name);
    if (v === '' || v == null) {
      for (const lh of longhands) delete decls[lh];
    } else {
      const pairs = shorthandExpand(name, String(v));
      if (!pairs) return;
      for (const lh of longhands) delete decls[lh];
      for (const [lh, lv] of pairs) decls[lh] = lv;
    }
  } else if (v === '' || v == null) {
    delete decls[name];
    // Clearing a non-modelled shorthand (font / background / …) also clears the longhands it
    // names, so a stale longhand doesn't outlive it.
    clearNamedLonghands(decls, name);
  } else {
    // A non-modelled shorthand we store as a single key still RESETS the longhands it names
    // (CSSOM "set a CSS declaration") — e.g. `font: menu` clears the font-variant longhands —
    // so a value read for one of them no longer sees a stale prior declaration.
    clearNamedLonghands(decls, name);
    // CSSOM "set a CSS declaration": a logical-property-group longhand whose group already
    // holds a declaration of a different mapping logic (physical vs flow-relative) is
    // (re)positioned at the end. A shorthand set already re-appends its longhands above.
    // Likewise a covered property set while an `all` declaration is present must move past
    // it, so it overrides `all` (which sits at the end).
    if (groupNeedsMove(decls, name) || (decls.all !== undefined && isCoveredByAll(name))) delete decls[name];
    decls[name] = String(v);
  }
  // Persist the RECONSTRUCTED block (browsers write `margin: 1px` — not the longhands —
  // to the style attribute, so getAttribute('style') and mutation-record oldValue match).
  commitDeclBlock(store, before, decls);
}

function removeStoreProp(store, name) {
  const v = propValue(store, name);
  const decls = expandDeclList(parseStyleDeclList(store.read() || ''));
  const before = serializeDeclBlock(decls);
  if (name === 'all') {
    // `all` is a shorthand for every covered longhand, so removing it clears them all (plus
    // the `all` key itself) — `direction` / `unicode-bidi` / custom props are untouched.
    for (const k of Object.keys(decls)) if (k === 'all' || isCoveredByAll(k)) delete decls[k];
  } else if (isRegularShorthand(name)) {
    for (const lh of shorthandLonghands(name)) delete decls[lh];
  } else {
    delete decls[name];
    // Removing a non-modelled shorthand clears the longhands it names too, matching the
    // setter — `removeProperty('font')` drops font-variant-*, like `font=''` does.
    clearNamedLonghands(decls, name);
  }
  commitDeclBlock(store, before, decls);
  return v;
}

// CSSOM only "update style attribute" — and thus only queues a MutationObserver record —
// when the declaration block actually CHANGED. A no-op mutation (setProperty to the current
// value, removeProperty of an absent property) leaves the block identical, so it must NOT
// rewrite the source (which would spuriously re-canonicalize a raw `style="color:red"` and
// queue a record). The comparison is block-level (canonical before vs after), not against the
// raw source string, so a non-canonical authored attribute is still recognised as unchanged.
function commitDeclBlock(store, before, decls) {
  const after = serializeDeclBlock(decls);
  if (after !== before) store.write(after);
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
  const indexedLength = () => Object.keys(storeDecls(store)).length;
  let implementation;
  const handler = {
    get(_t, prop, receiver) {
      if (DECL_MEMBERS.has(prop)) return readMember(_t, prop, receiver,
        implementation || (implementation = writableDeclaration(store)));
      if (prop === Symbol.iterator) return function* () { yield* Object.keys(storeDecls(store)); };
      // Non-string keys (Symbol.toStringTag, …) resolve from the target's prototype.
      if (typeof prop !== 'string') {
        if (prop !== DECLARATION_IMPLEMENTATION) return _t[prop];
        return implementation || (implementation = writableDeclaration(store));
      }
      if (/^\d+$/.test(prop)) return Object.keys(storeDecls(store))[+prop] || '';
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

// Whether `setProperty` accepts this (already `cssPropertyName`-normalised) name: a supported CSS property
// (isSupportedCssPropertyName) or a `--custom` property. Any other name is ignored (CSSOM only
// mutates the block for a "supported property name"), so `setProperty('unknown', …)` is a no-op.
// A named-property write (`style.foo = …`) excludes custom props — see the set trap.
function isSettableProperty(name) {
  return name.indexOf('--') === 0 || isSupportedCssPropertyName(name);
}

// A declaration's `!important` priority lives inline in the stored value
// (`display: none !important`) — the single source of truth the style attribute
// serializes and the cascade resolver reads importance off. Value reads strip it
// so `getPropertyValue` / `style.display` return the bare value (CSSOM), with
// `getPropertyPriority` reporting it.
//
// This stays a string→string with a cheap `indexOf` guard — no per-read object —
// because it's on the read hot path (jQuery `.css()`, Floating UI ~10 props per
// element). The importance-bearing read (the cold `getPropertyPriority`) uses the cascade's
// `splitImportant`. `IMPORTANT_SUFFIX_RE`
// mirrors `cascade.js`'s `IMPORTANT_RE`; keep them in sync.
const IMPORTANT_SUFFIX_RE = /\s*!\s*important\s*$/i;
function stripImportant(v) {
  if (typeof v !== 'string' || v.indexOf('!') < 0) return v;
  return v.replace(IMPORTANT_SUFFIX_RE, '').trim();
}

// The UA `display: none` rules HTML marks `!important`, which no author declaration can beat and
// no tag-keyed table can express: a hidden input, and an `<audio>` that is not showing controls
// (measured in Chrome — `input[type=hidden] { display: block }` and
// `<audio style="display: block">` both still compute `none`). ONE door: the computed value, the
// layout walk and the visibility walk all ask here, so they cannot disagree about whether a box
// exists (cascade.js `uaNotRendered`).
export function uaHidden(el) {
  if (el._tag === 'input') return inputType(el) === 'hidden';
  if (el._tag === 'audio') return el._attrs.controls == null;
  return false;
}

// HTML's widgets, whose BOX the UA decides however the page spells `display` (layout.js
// `WIDGET_BLOCK_DISPLAYS`). That is a USED-value rule and deliberately not a computed one: the
// computed value stays the keyword the page wrote (`button-layout/computed-style` is 162 subtests
// of exactly that, and it is Chrome that diverges there, not this driver).
export const WIDGET_TAGS = new Set(['button', 'input', 'select', 'textarea', 'fieldset',
                                    'meter', 'progress', 'marquee']);
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
// ONE funnel, so the computed value and the layout engine's own display cannot disagree about a
// blockified box. Nothing is read from the cascade while the display is not blockifiable at all,
// which is the answer for almost every element on a page.
// `displayOf` is how the PARENT's display is read — the layout's memoised used display where layout asks — and `items`
// whether being a flex or grid item blockifies at all (layout's `<br>` / `<wbr>` are run content, no items).
// A `display` in its precomposed form (CSS Display 3 §2.8), which is how it computes and serializes and so the one form
// every reader of it compares: `inline flex` is `inline-flex`, `block flow` `block`, `inline flow-root` `inline-block`,
// `flow list-item` `list-item` (Chrome and Firefox). A spelling that is no display is handed back as it is.
const DISPLAY_OUTER = new Set(['block', 'inline', 'run-in']);
const DISPLAY_INNER = new Set(['flow', 'flow-root', 'table', 'flex', 'grid', 'ruby']);
const PRECOMPOSED = Object.assign(Object.create(null), {
  'block flow': 'block', 'block flow-root': 'flow-root', 'inline flow': 'inline', 'inline flow-root': 'inline-block',
  'run-in flow': 'run-in', 'block table': 'table', 'inline table': 'inline-table', 'block flex': 'flex',
  'inline flex': 'inline-flex', 'block grid': 'grid', 'inline grid': 'inline-grid', 'inline ruby': 'ruby',
  'block ruby': 'block ruby'
});
export function canonicalDisplay(display) {
  const text = String(display);
  if (text.indexOf(' ') === -1) return text;
  let outer = null, inner = null, listItem = false;
  for (const t of text.trim().toLowerCase().split(/\s+/)) {
    if (t === 'list-item' && !listItem) listItem = true;
    else if (DISPLAY_OUTER.has(t) && !outer) outer = t;
    else if (DISPLAY_INNER.has(t) && !inner) inner = t;
    else return text;
  }
  if (listItem) {
    if (inner && inner !== 'flow' && inner !== 'flow-root') return text;
    return [outer === 'inline' ? 'inline' : null, inner === 'flow-root' ? 'flow-root' : null, 'list-item'].filter(Boolean).join(' ');
  }
  return PRECOMPOSED[`${outer || (inner === 'ruby' ? 'inline' : 'block')} ${inner || 'flow'}`] || text;
}

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
  if (el._anonCell || el._anonItem) return null;
  return engineValue(el, key) ?? null;
}

const PX_REPORTABLE_LAYOUT_PROPS = new Set([
  'width','height','min-width','min-height','max-width','max-height',
  'top','right','bottom','left',
  // Their flow-relative twins resolve to the same declaration, so they report the same way — and
  // have to, or `inset-block: 3px` answers `3px` for `insetBlockStart` and nothing for `top`.
  'inline-size','block-size','min-inline-size','min-block-size','max-inline-size','max-block-size',
  'inset-block-start','inset-block-end','inset-inline-start','inset-inline-end',
  'margin-top','margin-right','margin-bottom','margin-left',
  'padding-top','padding-right','padding-bottom','padding-left',
  // Their flow-relative twins are deliberately ABSENT: the used-value path answers by physical
  // side, so a logical name reaching it reports nothing at all rather than the px it resolves to.
  // `margin-block-start: 10%` therefore still reads back as `10%` where `margin-top` says `40px`,
  // and the animation table leaves the logical longhands typed `length` for the same reason — the
  // two halves move together, or a transition interpolates percentages into a value no browser
  // reports.
]);
// The initial value for any property, computed-form where that differs from the specified one.
// Reporting the real initial rather than '' is what a browser does, and page code branches on
// it — Floating UI treats `getComputedStyle(el).transform !== 'none'` as "this ancestor
// establishes a containing block", so '' made EVERY element one and put fixed-position
// dropdowns at their offset parent's scroll offset instead of at their trigger.
// The colour `currentcolor` denotes. On any property EXCEPT `color` that is the element's own
// computed `color`; on `color` itself the keyword means `inherit` (CSS Color 4), so it comes from
// the parent — and at the root from `color`'s own initial, which is a real colour, terminating.
// The element's own border box, for resolving a percentage translate. The layout engine owns the
// one geometry; a document with no layout yet simply has no box, and the caller falls back.
function borderBoxOf(el) {
  const fn = globalThis.__csimDocumentBox;
  try { return fn ? fn(el) : null; } catch (_) { return null; }
}

// The two `<position>`-valued origins. `transform-origin` takes a third, z-axis LENGTH; the other
// does not, and neither resolves a percentage on that axis.
const ORIGIN_PROPS = new globalThis.Set(['transform-origin', 'perspective-origin']);
// The origin's computed form — `left`/`top` as `0%`, `right`/`bottom` as `100%`, `center` as `50%`,
// a length as itself — resolved to the px it lands on when the element has a box.
function usedOrigin(el, key) {
  // A CSS-WIDE keyword is resolved against the COMPUTED value, which for an origin is the pair of
  // offsets — not the px they land on. `inherit` therefore copies the parent's percentages and the
  // child resolves them against its OWN box, which is what Chrome reports.
  return resolveOrigin(el, computedOriginOffsets(el, key));
}
// One origin value — already in its two-or-three-component form — as the px it lands on, a zero z
// not reported: `transform-origin: center center 0` is `50px 10px`.
function resolveOrigin(el, offsets) {
  const parts = splitTopLevelWhitespace(offsets).filter(Boolean);
  const box = originBox(el);
  const axes = [box ? box.width : null, box ? box.height : null];
  const out = [];
  for (let i = 0; i < parts.length && i < 3; i++) {
    // The z axis is a length and nothing else — no percentage, no box to resolve against.
    const px = i === 2 ? fontRelativeToPx(el, parts[i]) ?? parsePxLength(parts[i])
                       : originAxisPx(el, parts[i], axes[i]);
    // A component this driver cannot resolve makes the WHOLE value unresolved: half of a pair in
    // px and half in the author's tokens is neither what a browser reports nor what the page wrote.
    // (…reported under the same rule for its z: a computed `50% 50% 0px`, the style engine's, is `50% 50%`.)
    if (px == null) return parts.length === 3 && parseFloat(parts[2]) === 0 ? parts.slice(0, 2).join(' ') : offsets;
    out.push(formatPx(px));
  }
  while (out.length < 2) out.push(formatPx(0));
  if (out.length === 3 && parseFloat(out[2]) === 0) out.pop();
  return out.join(' ');
}
// The origin's COMPUTED value: the pair of offsets.
function computedOriginOffsets(el, key) {
  const declared = declaredValue(el, key);
  const text = declared == null ? '' : String(declared).trim();
  return !text ? '50% 50%' : canonicalizeOrigin(text);
}
// The box an origin's percentages resolve against: the element's BORDER box. A non-replaced INLINE
// has none to speak of — `transform` does not apply to it — and Chrome reports `0px 0px` there.
// The REPLACED tags are the ones `skipsUsedValue` already lists, read the same way (`_tag` is the
// lowercased name; `tagName` is not, and testing it left every `<img>` and `<canvas>` in the
// zero-box branch reporting confident, wrong pixels).
//
// An SVG element that is not the root has a reference box of its own — `transform-box` names it,
// and its initial value is the nearest viewport in USER units, which this driver does not model.
// It is treated as boxless, so what shows is the offsets rather than an invented px pair.
function originBox(el) {
  if (el.namespaceURI === SVG_NS && el._tag !== 'svg') return null;
  const tag = renderingTag(el);
  if (displayAsLaidOut(computedDisplayFor(el), tag) === 'inline' && !REPLACED_TAGS.has(tag) && !WIDGET_TAGS.has(tag) && tag !== 'svg' &&
      !(tag === 'legend' && isRenderedLegend(el))) {
    return { width: 0, height: 0 };
  }
  return borderBoxOf(el);
}

// One axis, in px against `extent` — or null when it cannot be resolved (no box under a
// percentage, or a length this driver cannot read).
function originAxisPx(el, token, extent) {
  const pct = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(token);
  if (pct) return extent == null ? null : parseFloat(pct[1]) / 100 * extent;
  // …and a `calc()` that mixes the two, in the percentage-first form the specified surface writes
  // (`calc(10px + 5%)` is stored as `calc(5% + 10px)`), which is the form an origin percentage
  // usually arrives in.
  // …in either order, which is why it goes through the canonical form first: the specified surface
  // writes the percentage first, but a value that never passed through it (a keyframe, a cascade
  // entry) can still be `calc(10px + 5%)`.
  const calc = ORIGIN_CALC_LP_RE.exec(canonicalLengthPercentage(token) || token);
  if (calc) {
    return extent == null ? null
      : parseFloat(calc[1]) / 100 * extent + (calc[2] === '-' ? -1 : 1) * parseFloat(calc[3]);
  }
  return fontRelativeToPx(el, token) ?? parsePxLength(token);
}
const ORIGIN_CALC_LP_RE = /^calc\(\s*([+-]?(?:\d+\.?\d*|\.\d+))%\s*([+-])\s*((?:\d+\.?\d*|\.\d+))px\s*\)$/i;
const parsePxLength = (token) => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(String(token).trim());
  return m ? parseFloat(m[1]) : null;
};

// `transform` is reported as the composed MATRIX, never as the author's function list (Chrome
// measured: `translateX(10px)` → `matrix(1, 0, 0, 1, 10, 0)`, and a 3D component escalates the
// whole thing to `matrix3d`). Page code parses that form to read a translation back out, so the
// function list is not a substitute.
const DEG = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
// A CSS number, EXPONENT included: the driver's own length normalizer emits `1e-7px`, and a regex
// without the exponent read that back as "not a length at all".
const CSS_NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const PX_RE  = new globalThis.RegExp(`^(${CSS_NUMBER})(px)?$`, 'i');
const PCT_RE = new globalThis.RegExp(`^(${CSS_NUMBER})%$`);
const NUMBER_RE = new globalThis.RegExp(`^${CSS_NUMBER}$`);
const ANGLE_RE = new globalThis.RegExp(`^(${CSS_NUMBER})(deg|grad|rad|turn)?$`, 'i');
function angleDeg(tok) {
  const m = ANGLE_RE.exec(String(tok == null ? '' : tok).trim());
  if (!m) return null;
  // Only a ZERO may omit its unit; `rotate(1)` is an invalid declaration, not one degree.
  if (!m[2] && parseFloat(m[1]) !== 0) return null;
  return parseFloat(m[1]) * (DEG[(m[2] || 'deg').toLowerCase()] || 1);
}
// A translate component in px. A PERCENTAGE resolves against the element's own border box, which
// is what makes `translate(-50%, -50%)` — the centring idiom — a real offset rather than zero.
// Anything else (em, calc) has no answer here; the caller reports the author's value instead of a
// matrix that would be wrong.
// One level of nesting, which is what a `calc()` argument is: `translateX(calc(25px + 25%))` did
// not match `[^()]*` at all, so the whole declaration fell through as an unresolvable string.
// A FRESH regex per scan — a `g` regex carries `lastIndex`, and the two scanners share this one.
const TRANSFORM_FN_RE = () => /([a-z0-9]+)\(((?:[^()]|\([^()]*\))*)\)/gi;
// …and the arguments split at TOP level, or `calc(25px + 25%), 0` would split inside the calc.
// An EMPTY argument is kept: `scale(2,)` is not `scale(2)`, it is an invalid declaration, and
// dropping the empty token here made a browser-dropped value compute to a real matrix.
const transformArgs = (text) => {
  const t = text.trim();
  return t === '' ? [] : splitTopLevel(text, ',').map((a) => a.trim());
};
// Everything a transform value may hold BESIDE its functions: whitespace, and nothing else. The
// scanner matches `name(args)` and skips whatever sits between matches, so `none rotate(45deg)`
// composed a rotation where a browser drops the declaration.
function onlyFunctions(value, matched) {
  return String(value).replace(TRANSFORM_FN_RE(), ' ').trim() === '' && matched;
}

function lengthPx(tok, boxFn, axis) {
  const t = String(tok).trim();
  const px = PX_RE.exec(t);
  if (px) return parseFloat(px[1]);
  const pct = PCT_RE.exec(t);
  // The box is fetched ONLY here — resolving it eagerly ran a layout pass on every
  // `getComputedStyle(el).transform`, which is a walk Floating UI does per ancestor.
  if (pct) {
    const box = boxFn();
    return box ? parseFloat(pct[1]) / 100 * (axis === 'x' ? box.width : box.height) : null;
  }
  // A `calc()` the cascade could not reduce is one holding a PERCENTAGE: the evaluator has no box
  // to resolve it against and leaves the whole expression standing (`calc(2em - 25px)` reduces
  // there and never reaches this). Here the box is in hand, so each percentage becomes the px it
  // means and the expression reduces the rest of the way — Chrome reports
  // `translateX(calc(25px + 25%))` on a 120px box as `matrix(1, 0, 0, 1, 55, 0)`, where we
  // reported the declaration back verbatim.
  // NaN, not null: a token that is no length at all makes the declaration INVALID, where a
  // percentage with no box yet is merely unresolved. Conflating the two reported the author's text
  // for `translateX(auto)`, which a browser drops.
  if (!hasMathFunction(t)) return NaN;
  if (t.indexOf('%') === -1) return null;
  const box = boxFn();
  if (!box) return null;
  const basis = axis === 'x' ? box.width : box.height;
  const resolved = t.replace(/([+-]?[\d.]+)%/g, (_, n) => `${parseFloat(n) / 100 * basis}px`);
  // Absolute units only: anything font- or viewport-relative was reduced by the cascade's own
  // evaluator on the way here (which is why `calc(2em - 25px)` never reaches this), so what is left
  // inside is px and the percentages just substituted.
  const reduced = reduceMathFunctions(resolved, (n, unit) => {
    const abs = CSS_ABSOLUTE_UNIT_PX[unit];
    return abs === undefined ? null : n * abs;
  });
  const out = /^([+-]?[\d.]+)px$/i.exec(String(reduced).trim());
  return out ? parseFloat(out[1]) : null;
}
const finite = (n) => Number.isFinite(n);
// A scale takes a NUMBER or a percentage — `scale(50%)` is 0.5, and `parseFloat` alone strips the
// `%` and hands page code a 100x factor. Anything else is an invalid declaration.
function scaleFactor(tok) {
  const t = String(tok == null ? '' : tok).trim();
  const pct = PCT_RE.exec(t);
  if (pct) return parseFloat(pct[1]) / 100;
  const n = NUMBER_RE.test(t) ? parseFloat(t) : NaN;
  return Number.isFinite(n) ? n : null;
}
// A Z translation takes a <length> ONLY: a percentage has nothing to resolve against, and makes
// the whole `transform` invalid (Chrome measured — `translateZ(50%)` reports `none`, it does not
// resolve against the height). NaN says invalid; null says a length we can't resolve here.
function zLengthPx(tok) {
  const t = String(tok == null ? '' : tok).trim();
  if (/%$/.test(t)) return NaN;
  const px = PX_RE.exec(t);
  if (px) return parseFloat(px[1]);
  // …and a token that is no length at all is INVALID, not unresolved.
  return t === '' || /[a-z(]/i.test(t) ? NaN : null;
}
// ── The 4x4 ──────────────────────────────────────────────────────────────────────────────────
// A transform list composes into one 4x4, which is the only form that holds every function the
// grammar has. The driver used to compose a 2D affine and carry a `z` translation beside it, and to
// project ONE 3D function for geometry — so a list with two of them, or a rotation about a tilted
// axis, reported the author's text back and measured untransformed.
//
// COLUMN-MAJOR, in the order `matrix3d()` writes: `M[(col - 1) * 4 + (row - 1)]`, so `M[12]`,
// `M[13]`, `M[14]` are the translation. A point goes through it as
// `x' = M[0]x + M[4]y + M[8]z + M[12]`, and the list composes LEFT TO RIGHT — the leftmost function
// is applied last, which is what `A(B(p))` means for `transform: A B`.
export const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
export const translate4 = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale4     = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
// Rodrigues about a normalised axis. Every rotation goes through this one — `rotateX` is
// `rotate3d(1, 0, 0, …)` — so there is one place for the sign convention to be right.
function rotate4(x, y, z, deg) {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 0)) return null;                   // a zero axis makes the function invalid
  x /= len; y /= len; z /= len;
  // An exact multiple of 90 degrees has EXACT components: `cos(90deg)` is 6.1e-17 through the
  // library, and a browser reports a clean 0 because it special-cases the quarter turns rather than
  // because it rounds noise away.
  const quarter = deg / 90;
  const exact = Number.isInteger(quarter);
  const q = ((quarter % 4) + 4) % 4;
  const r = deg * Math.PI / 180;
  const c = exact ? [1, 0, -1, 0][q] : Math.cos(r);
  const s = exact ? [0, 1, 0, -1][q] : Math.sin(r);
  const t = 1 - c;
  return [
    c + x * x * t,     y * x * t + z * s, z * x * t - y * s, 0,
    x * y * t - z * s, c + y * y * t,     z * y * t + x * s, 0,
    x * z * t + y * s, y * z * t - x * s, c + z * z * t,     0,
    0, 0, 0, 1
  ];
}
const skew4 = (ax, ay) => [1, Math.tan(ay * Math.PI / 180), 0, 0,
                           Math.tan(ax * Math.PI / 180), 1, 0, 0,
                           0, 0, 1, 0, 0, 0, 0, 1];
// `perspective(d)` is the only function with a fourth ROW: it divides by depth.
const perspective4 = (d) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / d, 0, 0, 0, 1];

// Whether the 4x4 is a plain 2D affine, which decides whether a page reads `matrix()` or
// `matrix3d()` back (CSSMatrix's own `is2D`).
function is2D(m) {
  return m[2] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0 &&
         m[8] === 0 && m[9] === 0 && m[11] === 0 && m[14] === 0 &&
         m[10] === 1 && m[15] === 1;
}
// The 2D affine a box is drawn under. FLATTENING is dropping the Z row and column, which is what a
// non-`preserve-3d` parent does to its child's 3D transform — with no perspective in play a
// `rotateY(60deg)` is exactly a horizontal scale by cos 60, and Chrome's rect agrees.
//
// Used by `matrixNumbers` for a `matrix3d()` a page wrote: the geometry chain carries the 4x4 and
// does its own flattening at the rendering-context boundaries (`crossInto`), so this is only the
// straight projection of a single matrix onto the plane.
// css-transforms-2's flattening: an element that is not in a 3D rendering context has its
// accumulated matrix flattened onto the plane. It zeroes the Z row and column — but NOT `m14` /
// `m24`, the projective row's x and y terms, which is exactly why a flat box under a `perspective`
// still comes out foreshortened.
export function flattenMatrix4(m) {
  const out = m.slice();
  out[2] = out[6] = out[8] = out[9] = out[11] = out[14] = 0;
  out[10] = 1;
  return out;
}
// A FLAT box lives at z = 0, so its map to the viewport is a 3x3 HOMOGRAPHY: the 4x4's first,
// second and fourth columns, rows 1, 2 and 4. Carrying that rather than a 2D affine is what lets a
// perspective divide reach the geometry at all.
export function homographyOf(m) {
  return [m[0], m[1], m[3], m[4], m[5], m[7], m[12], m[13], m[15]];
}
export function applyHomography(h, x, y) {
  const w = h[2] * x + h[5] * y + h[8];
  if (!w) return null;                              // on the horizon: no image at all
  return { x: (h[0] * x + h[3] * y + h[6]) / w, y: (h[1] * x + h[4] * y + h[7]) / w };
}
export function invertHomography(h) {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = (e * j - f * i), B = -(b * j - c * i), C = (b * f - c * e);
  const det = a * A + d * B + g * C;
  if (!det) return null;
  return [
    A / det, B / det, C / det,
    -(d * j - f * g) / det, (a * j - c * g) / det, -(a * f - c * d) / det,
    (d * i - e * g) / det, -(a * i - b * g) / det, (a * e - b * d) / det
  ];
}

// Six SIGNIFICANT digits, which is what a browser reports — `Math.sqrt(2)` is `1.41421`, not
// `1.414214` (rounding to six DECIMAL places agreed only for components below 1). A value that is
// only floating-point noise is zero: `cos(90deg)` is 6.1e-17, and Chrome prints `0`.
function roundMatrixComponent(n) {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) < 1e-6) return 0;
  const r = parseFloat(n.toPrecision(6));
  return Object.is(r, -0) ? 0 : r;
}
// …and printed the way a browser prints it: six significant digits, in EXPONENTIAL form once the
// decimal exponent leaves [-4, 6) — `perspective(20000px)` reports `-5e-05`, not `-0.00005`, and
// that is an authorable value. The exponent carries its sign and at least two digits, as `%g` does.
function formatMatrixComponent(n) {
  const r = roundMatrixComponent(n);
  if (r === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(r)));
  if (exp >= -4 && exp < 6) return String(r);
  return r.toExponential(5)
    .replace(/\.?0+e/, 'e')
    .replace(/e([+-])(\d)$/, 'e$10$2');
}
function serializeMatrix(m) {
  const out = m.map(roundMatrixComponent);
  // …rounded FIRST: a `rotateX(90deg) rotateX(-90deg)` composes to a 4x4 whose off-axis terms are
  // 1e-17, and a page reading it back gets `matrix(1, 0, 0, 1, 0, 0)` in Chrome, not `matrix3d`.
  const text = m.map(formatMatrixComponent);
  return is2D(out)
    ? `matrix(${[text[0], text[1], text[4], text[5], text[12], text[13]].join(', ')})`
    : `matrix3d(${text.join(', ')})`;
}

// The list as a 4x4, or a REASON it is not one: `'invalid'` for a declaration a browser drops
// (`rotate(1)` names no angle), `'unresolved'` for one this driver cannot resolve yet (a percentage
// with no box), which the caller reports back verbatim rather than inventing a matrix for.
function transform4x4(value, boxFn) {
  const v = String(value).trim();
  if (!v || /^none$/i.test(v)) return 'none';
  let m = IDENT4;
  const FN = TRANSFORM_FN_RE();
  let match, seen = false;
  while ((match = FN.exec(v))) {
    seen = true;
    const name = match[1].toLowerCase();
    const args = transformArgs(match[2]);
    const nums = args.map(parseFloat);
    let step = null;
    switch (name) {
      case 'translate': case 'translatex': case 'translatey': case 'translate3d': {
        const wantsZ = name === 'translate3d';
        // EXACT arity. A browser drops `translate(10px, 20px, 30px)` and `translateY(10px, 20px)`
        // outright; without the upper bound the extra argument was simply ignored.
        const want = wantsZ ? [3, 3] : name === 'translate' ? [1, 2] : [1, 1];
        if (args.length < want[0] || args.length > want[1]) return 'invalid';
        const xTok = name === 'translatey' ? null : args[0];
        const yTok = name === 'translatey' ? args[0] : (name === 'translate' || wantsZ ? args[1] : null);
        const x = xTok == null ? 0 : lengthPx(xTok, boxFn, 'x');
        const y = yTok == null ? 0 : lengthPx(yTok, boxFn, 'y');
        // A Z translation takes no percentage — there is nothing to resolve one against, and the
        // whole declaration is invalid for it.
        const z = wantsZ ? zLengthPx(args[2]) : 0;
        // NaN says the token is no length at all, which drops the declaration; null says a
        // percentage with no box yet, which is merely unresolved.
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return 'invalid';
        if (x == null || y == null || z == null) return 'unresolved';
        step = translate4(x, y, z);
        break;
      }
      case 'translatez': {
        if (args.length !== 1) return 'invalid';
        const z = zLengthPx(args[0]);
        if (Number.isNaN(z)) return 'invalid';
        if (z == null) return 'unresolved';
        step = translate4(0, 0, z);
        break;
      }
      case 'scale': case 'scalex': case 'scaley': case 'scalez': case 'scale3d': {
        const f = (tok) => (tok == null ? null : scaleFactor(tok));
        const want = name === 'scale3d' ? [3, 3] : name === 'scale' ? [1, 2] : [1, 1];
        if (args.length < want[0] || args.length > want[1]) return 'invalid';
        if (name === 'scale3d') {
          const [x, y, z] = args.map(f);
          if (x == null || y == null || z == null) return 'invalid';
          step = scale4(x, y, z);
          break;
        }
        const first = f(args[0]);
        if (first == null) return 'invalid';
        if (name === 'scalex') step = scale4(first, 1, 1);
        else if (name === 'scaley') step = scale4(1, first, 1);
        else if (name === 'scalez') step = scale4(1, 1, first);
        else {
          // `scale(2)` means `scale(2, 2)`; the Z factor is never implied.
          const second = args.length > 1 ? f(args[1]) : first;
          if (second == null) return 'invalid';
          step = scale4(first, second, 1);
        }
        break;
      }
      case 'rotate': case 'rotatez': case 'rotatex': case 'rotatey': {
        if (args.length !== 1) return 'invalid';
        const deg = angleDeg(args[0]);
        if (deg == null) return 'invalid';       // `rotate(1)` is not a valid angle
        const axis = name === 'rotatex' ? [1, 0, 0] : name === 'rotatey' ? [0, 1, 0] : [0, 0, 1];
        step = rotate4(axis[0], axis[1], axis[2], deg);
        break;
      }
      case 'rotate3d': {
        if (args.length !== 4) return 'invalid';
        const deg = angleDeg(args[3]);
        if (deg == null || !nums.slice(0, 3).every(finite)) return 'invalid';
        // A ZERO axis names no rotation, and Chrome computes the IDENTITY for it rather than
        // dropping the declaration (measured: `rotate3d(0, 0, 0, 45deg)` reports
        // `matrix(1, 0, 0, 1, 0, 0)`, not `none`).
        step = rotate4(nums[0], nums[1], nums[2], deg) || IDENT4;
        break;
      }
      case 'skew': case 'skewx': case 'skewy': {
        const want = name === 'skew' ? [1, 2] : [1, 1];
        if (args.length < want[0] || args.length > want[1]) return 'invalid';
        const a0 = angleDeg(args[0]);
        if (a0 == null) return 'invalid';
        if (name === 'skewx') step = skew4(a0, 0);
        else if (name === 'skewy') step = skew4(0, a0);
        else {
          const a1 = args.length > 1 ? angleDeg(args[1]) : 0;
          if (a1 == null) return 'invalid';
          step = skew4(a0, a1);
        }
        break;
      }
      case 'perspective': {
        if (args.length !== 1) return 'invalid';
        // `perspective(none)` is an infinite depth, which is the identity.
        if (/^none$/i.test(args[0])) { step = IDENT4; break; }
        const d = zLengthPx(args[0]);
        if (d == null || Number.isNaN(d)) return 'invalid';
        // The grammar is a NON-NEGATIVE length: a negative one drops the declaration rather than
        // clamping (Chrome-measured — `perspective(-1px)` reports `none`).
        if (d < 0) return 'invalid';
        // A depth below one pixel is clamped to one, which is the range the property's own
        // definition gives it (Chrome-measured: `perspective(0px)` behaves as `perspective(1px)`).
        step = perspective4(Math.max(1, d));
        break;
      }
      case 'matrix': {
        // NUMBERS, strictly: `parseFloat` reads `matrix(10px, …)` as 10 and `matrix(50%, …)` as 50,
        // where a browser drops both.
        if (args.length !== 6 || !args.every((a) => NUMBER_RE.test(a)) || !nums.every(finite)) return 'invalid';
        step = [nums[0], nums[1], 0, 0, nums[2], nums[3], 0, 0, 0, 0, 1, 0, nums[4], nums[5], 0, 1];
        break;
      }
      case 'matrix3d': {
        if (args.length !== 16 || !args.every((a) => NUMBER_RE.test(a)) || !nums.every(finite)) return 'invalid';
        step = nums;
        break;
      }
      default: return 'invalid';                 // not a transform function at all
    }
    m = multiply4(m, step);
  }
  // …and nothing but functions and whitespace may sit in the value: `none rotate(45deg)` is a
  // dropped declaration, not a rotation.
  return onlyFunctions(v, seen) ? m : 'invalid';
}

// The computed VALUE: the list composed into one matrix and written the way a browser writes it.
// `none` for a declaration a browser drops, and the author's own text for one this driver cannot
// resolve — inventing a matrix for that would be worse than saying so.
function transformMatrix(value, boxFn) {
  const m = transform4x4(value, boxFn);
  if (m === 'none') return 'none';
  if (m === 'invalid') return 'none';
  if (m === 'unresolved') return String(value).trim();
  return serializeMatrix(m);
}

// …and under the style engine, the matrix IT composes: the value it serializes rounds every angle to six figures, and
// composed again here `skew(-0.7rad)` — `-40.107deg` — reads one digit off what Chrome and Firefox report. The box is
// asked for only where a percentage needs it. Undefined where the engine does not answer, or a percentage has no box
// to resolve against (which the list composed here reports as it stands).
function engineTransformMatrix(el, value) {
  const box = String(value).includes('%') ? borderBoxOf(el) : { width: 0, height: 0 };
  if (!box) return undefined;
  const m = styleEngineTransformMatrix(el, box.width, box.height);
  if (m === undefined) return undefined;
  return m === null ? 'none' : serializeMatrix(m);
}

// The `perspective` PROPERTY, as the matrix it contributes to its CHILDREN's transforms — taken
// about `perspective-origin`, in the element's own border-box coordinates. Distinct from the
// `perspective()` FUNCTION, which is part of the element's own transform: this one is what makes
// `perspective: 500px` on a wrapper foreshorten a `rotateY(45deg)` child.
export function usedPerspective(el) {
  const text = readComputed(el, 'perspective').value;
  if (!text || /^none$/i.test(String(text).trim())) return null;
  const d = parseFloat(text);
  // A NEGATIVE depth is not a value at all (the computed value is `none`); ZERO is one, and Chrome
  // uses it — `perspective: 0` collapses everything onto the perspective origin, where treating it
  // as `none` left the box unprojected.
  if (!Number.isFinite(d) || d < 0) return null;
  const origin = splitTopLevelWhitespace(usedOrigin(el, 'perspective-origin'));
  // The same one-pixel floor the function takes.
  return { m4: perspective4(Math.max(1, d)),
           ox: parseFloat(origin[0]) || 0, oy: parseFloat(origin[1]) || 0 };
}
// Whether the element's children share its 3D rendering context, so their transforms compose with
// its own instead of being flattened onto its plane.
//
// `transform-style` is not the whole answer: css-transforms-2 makes the USED value `flat` on a
// GROUPING element, because a group has to be rendered as one image before anything can be composed
// with it. Chrome-measured, each of these forces flat on an otherwise `preserve-3d` parent —
// `overflow` other than visible, a `filter`, an `opacity` below 1, `isolation: isolate`, a
// `mix-blend-mode`, a `clip-path`, a `mask-image`, a `backdrop-filter`, and a `will-change` naming
// one of them. `contain: paint` does NOT (measured twice), nor do the no-op values `opacity: 1` and
// `filter: none`.
export function preserves3d(el) {
  if (!/^preserve-3d$/i.test(String(readComputed(el, 'transform-style').value || '').trim())) return false;
  return !groups(el);
}
const NOT_NONE = (el, prop) => {
  const v = String(readComputed(el, prop).value || '').trim();
  return v !== '' && !/^none$/i.test(v);
};
function groups(el) {
  // Only ever asked of an element that DECLARES `preserve-3d`, which is rare enough that these
  // reads never reach an ordinary page.
  if (!/^visible$/i.test(usedOverflow(el, 'x')) || !/^visible$/i.test(usedOverflow(el, 'y'))) return true;
  const opacity = parseFloat(readComputed(el, 'opacity').value);
  if (Number.isFinite(opacity) && opacity < 1) return true;
  if (/^isolate$/i.test(String(readComputed(el, 'isolation').value || '').trim())) return true;
  const blend = String(readComputed(el, 'mix-blend-mode').value || '').trim();
  if (blend !== '' && !/^normal$/i.test(blend)) return true;
  for (const prop of ['filter', 'backdrop-filter', 'clip-path', 'mask-image']) {
    if (NOT_NONE(el, prop)) return true;
  }
  const willChange = String(readComputed(el, 'will-change').value || '').toLowerCase();
  return /\b(opacity|filter|backdrop-filter|clip-path|mask|mask-image|isolation|mix-blend-mode)\b/.test(willChange);
}

// The element's own transform as the 2D matrix GEOMETRY uses, with the origin it turns about —
// both in the element's own border-box coordinates — or null when it has no transform.
//
// The computed VALUE is the authority for the 2D forms: it is already `matrix(a, b, c, d, e, f)`,
// composed and with percentages resolved, so this reads it rather than composing a second time.
// A 3D form is where the two part company: the computed value reports the author's function list
// (this driver does not model the 4x4 yet), while a box on screen is FLATTENED — with no
// perspective in play a `rotateY(60deg)` is exactly a horizontal scale by cos60, which is what
// Chrome's rect shows (a 100px box measures 50px). So the 3D functions are projected here, for
// geometry only, and the computed value is left alone.
export function usedTransformMatrix(el) {
  const boxFn = () => borderBoxOf(el);
  // The INDIVIDUAL transform properties come first, in the order css-transforms-2 composes them —
  // `translate`, then `rotate`, then `scale` — and `transform` on top of all three (Chrome
  // measured: `translate: 10px; transform: translateX(20px)` moves the box 30px). They are
  // properties of their own, not part of the computed `transform`, so nothing else here sees them.
  const list = [];
  for (const [prop, toList] of INDIVIDUAL_TRANSFORMS) {
    const text = readComputed(el, prop).value;
    if (!text || /^none$/i.test(String(text).trim())) continue;
    const fn = toList(String(text).trim());
    if (fn) list.push(fn);
  }
  // …and the element's own `transform` on top of all three. Its computed value is already the
  // composed matrix, so this re-reads a `matrix()` / `matrix3d()` rather than the author's text —
  // ONE geometry, and the same figures a page reads back.
  const value = readComputed(el, 'transform').value;
  if (value && !/^none$/i.test(String(value).trim())) list.push(String(value).trim());
  if (!list.length) return null;
  // Composed as ONE 4x4 and flattened ONCE: flattening each part and multiplying the results is a
  // different operation, and the difference shows the moment two 3D functions meet.
  const composed = transform4x4(list.join(' '), boxFn);
  if (typeof composed === 'string') return null;
  // The 4x4 itself, not a flattening of it: the chain composes in three dimensions and flattens at
  // the boundaries where a rendering context ends, which is not the same as flattening each step.
  if (composed.every((n, i) => n === IDENT4[i])) return null;
  const origin = splitTopLevelWhitespace(usedOrigin(el, 'transform-origin'));
  return { m4: composed, ox: parseFloat(origin[0]) || 0, oy: parseFloat(origin[1]) || 0 };
}
// `translate` / `rotate` / `scale`, each as the 2D matrix it contributes. Their grammars are their
// own: `rotate` may name an AXIS (`rotate: x 45deg`, which flattens like `rotateX`), and `scale`
// takes one to three numbers.
// `translate` / `rotate` / `scale`, each as the FUNCTION LIST it is equivalent to. Written this way
// so one composer and one flattening serve all four properties: the hand-rolled 2D matrices these
// used to build knew only the cardinal axes, so `rotate: 1 1 0 45deg` measured untransformed — the
// exact failure the 4x4 exists to kill, surviving in the sibling path.
const INDIVIDUAL_TRANSFORMS = [
  ['translate', (text) => {
    const p = splitTopLevelWhitespace(text);
    if (!p.length || p.length > 3) return null;
    return `translate3d(${p[0]}, ${p[1] || '0'}, ${p[2] || '0'})`;
  }],
  ['rotate', (text) => {
    const p = splitTopLevelWhitespace(text);
    const angle = p[p.length - 1];
    if (p.length === 1) return `rotate(${angle})`;
    if (p.length === 2) {
      const axis = p[0].toLowerCase();
      if (axis === 'x' || axis === 'y' || axis === 'z') return `rotate${axis.toUpperCase()}(${angle})`;
      return null;
    }
    // …and the three-number axis, which is `rotate3d`'s own.
    return p.length === 4 ? `rotate3d(${p[0]}, ${p[1]}, ${p[2]}, ${angle})` : null;
  }],
  ['scale', (text) => {
    const p = splitTopLevelWhitespace(text);
    if (!p.length || p.length > 3) return null;
    // `scale: 2` is both axes; the Z factor is never implied.
    return `scale3d(${p[0]}, ${p[1] || p[0]}, ${p[2] || '1'})`;
  }]
];
// A LISTBOX `<select>` is a different control from a dropdown: it scrolls, it is white rather than
// grey, and it is as tall as the rows it shows. All three follow from HTML's DISPLAY SIZE, which
// the selectedness algorithm already computes (`selectDisplaySize`) — asking it here rather than
// re-deriving the rule is what keeps `<select multiple size="1">` a one-row dropdown, which is
// what Chrome shows it as.
export function isListBox(el) {
  return el._tag === 'select' && !!el._attrs && selectDisplaySize(el) > 1;
}

// ── Form-control chrome ──────────────────────────────────────────────────────────────────────
// A UA gives every form control a border, padding, a background and a font OF ITS OWN, and those
// are part of the BOX — so without them a `<button>` measured 25x21 where Chrome gives 67x21, and
// `<select>` 30x19 against 45x19. That is a geometry error, not a cosmetic one: it feeds
// hit-testing, `obscured?`, overlap and how much room a row of buttons takes. (It is also why a
// screenshot drew buttons as bare text — the painter was being faithful to the cascade.)
//
// Chrome 151-measured on this machine, per control FAMILY rather than per tag.
//
// The font is a SHORTHAND in the UA sheet — `font: 400 13.3333px Arial` — so it resets the whole
// font, not just the size and the family: a control inside `<b>`, inside `font-style: italic`, or
// on a page with `body { line-height: 1.5 }` still reports 400 / normal / normal in Chrome, and
// still measures 21 tall. Emitting only size and family left every button 6px too tall on any app
// with a root line-height (Bootstrap, Tailwind, Discourse) and measured its label in the bold
// advance table. `color` and `letter-spacing` are reset the same way (measured: a control inside
// `color: rgb(200,0,0); letter-spacing: 2px` reports `rgb(0, 0, 0)` and `normal`).
//
// `sizing` is the control's own `box-sizing`, which is not the initial one everywhere: a `<button>`
// or a `<select>` sized `height: 20px` is 20px TALL — border and padding inside it — while a text
// `<input>` at `width: 100px` is 108 wide (both Chrome-measured). Getting that wrong is a whole
// border-box of error on every sized control on a page.
function controlChrome({ width, style, color, padY, padX, bg, fg = 'rgb(0, 0, 0)', family = 'Arial',
                         sizing = 'content-box', align = 'start', cursor = 'default',
                         margin = '0px', marginLeft = null, overflow = 'visible' }) {
  const out = Object.assign(Object.create(null), {
    'background-color': bg, 'color': fg,
    'font-size': '13.3333px', 'font-family': family, 'font-weight': '400', 'font-style': 'normal',
    'line-height': 'normal', 'letter-spacing': 'normal',
    // …and the rest of the inherited TEXT properties, which HTML's sheet resets on every control:
    // a control inside `text-transform: uppercase; word-spacing: 5px; text-indent: 5px` shows its
    // own label, unshifted and unspaced (`form-controls/resets`, 116 subtests).
    'word-spacing': '0px', 'text-transform': 'none', 'text-indent': '0px', 'text-shadow': 'none',
    'box-sizing': sizing, 'text-align': align, 'cursor': cursor,
    'overflow-x': overflow, 'overflow-y': overflow
  });
  for (const side of ['top', 'right', 'bottom', 'left']) {
    out[`border-${side}-width`] = width;
    out[`border-${side}-style`] = style;
    out[`border-${side}-color`] = color;
    out[`padding-${side}`]      = (side === 'top' || side === 'bottom') ? padY : padX;
    out[`margin-${side}`]       = (side === 'left' && marginLeft) ? marginLeft : margin;
  }
  return out;
}
// A checkbox / radio / file / image input paints its own widget with no CSS box around it: no
// border, no padding, nothing behind it — the box is the widget's own size, which `intrinsicSize`
// gives it.
const WIDGET_CHROME = controlChrome({ overflow: 'clip', width: '0px', style: 'none', color: 'rgb(0, 0, 0)',
                                      padY: '0px', padX: '0px', bg: 'rgba(0, 0, 0, 0)' });
// The file widget's own label takes the page's colour — the one member of this family that does
// NOT reset it (Chrome: green inside `color: rgb(0, 128, 0)`, where a checkbox stays black).
const FILE_CHROME = { ...WIDGET_CHROME };
delete FILE_CHROME.color;
// The UA's own word on a button `<input>` with no `value` — what it paints, and what layout
// measures it by. An `image` has no label at all: it is the image.
const BUTTON_INPUT_LABELS = Object.assign(Object.create(null), {
  submit: 'Submit', reset: 'Reset', button: ''
});

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
// Is this a BUTTON `<input>` — one sized by its label rather than by a UA constant — and what does
// it say? `null` when it isn't one. Layout measures the label; the chrome table above decides what
// box it sits in, and the two must not drift apart.
export function buttonInputLabel(el) {
  const label = BUTTON_INPUT_LABELS[inputType(el)];
  if (label === undefined) return null;
  const value = el._attrs && el._attrs.value;
  return value != null ? String(value) : label;
}

// An element's COMPUTED `position` — `static` for an anonymous box, which declares nothing. ONE answer for the layout
// engine (`positionOf`), the minimum size and the painter.
export function computedPositionOf(el) {
  return engineValue(el, 'position') ?? 'static';
}
// Whether a CURRENT or IN-EFFECT animation on `el` — a CSS one, a transition, or one script started — animates any of
// `props`: one still in its DELAY counts, which is what makes an animated `transform` a stacking context before it has
// moved anything. Behind the property gates, so an element no animation names any of `props` on asks nothing more.
// A TRUE answer is one no memo may keep (`noteUncacheableRead`): it holds only until the animation runs out, which
// moves the clock and nothing else — a card that faded in stayed a stacking context, trapping its dropdown.
export function currentlyAnimatesAnyOf(el, props) {
  const animated = animatedPropertiesOn(el);
  const current = !!animated && props.some((prop) => animated.has(prop)) && animationsCurrentlyAnimate(el, props);
  if (current) noteUncacheableRead();
  return current;
}
// `float` / `clear` as they COMPUTE — null for an anonymous box, which declares nothing.
export function computedFloatOrClear(el, prop) {
  return engineValue(el, prop) ?? null;
}
// A `calc()` holding a length AND a percentage has a canonical order on the computed surface — the
// percentage first — which every branch of the resolved-value read applies, so that the same value
// reads back one way whether an animation produced it or the author typed it.
const canonicalCalcOrder = (value) => {
  if (value.indexOf('calc(') === -1) return value;
  const unwrapped = unwrapCalc(value);
  return unwrapped.indexOf('%') !== -1 && unwrapped.indexOf('calc(') !== -1 ? canonicalLengthPercentage(unwrapped) || unwrapped : unwrapped;
};

const MIN_SIZE_PROPS = new Set(['min-width', 'min-height', 'min-inline-size', 'min-block-size']);
// `auto` on a min-size resolves the same way whether it is the INITIAL value or an explicit
// declaration (`min-width: auto` is what flex-reset CSS writes): it stays `auto` for a flex / grid
// item and computes `0px` for anything else (Chrome measured).
function automaticMinSize(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return '0px';
  const parent = el._parent;
  const pd = parent && parent.nodeType === NODE_ELEMENT ? computedDisplayFor(parent) : '';
  // Absolutely positioned children are OUT OF FLOW — not flex items — and compute `0px` (Chrome
  // measured). A float still is one, since the container blockifies it, so the guard is on
  // positioning rather than on floats.
  const pos = computedPositionOf(el);
  return /(^|-)(flex|grid)$/.test(String(pd)) && pos !== 'absolute' && pos !== 'fixed' ? 'auto' : '0px';
}

// The initial font-size (the `medium` keyword). The absolute-size keyword table lives in
// css-utils (ABSOLUTE_FONT_SIZE_PX), shared with the canvas `font` parser.
const DEFAULT_FONT_SIZE_PX = 16;
// Absolute CSS length units → px (at 96dpi). Font-relative units (em/ex/ch/rem/%) are NOT
// here — they depend on a font-size the caller supplies. Shared by every length resolver so
// a unit factor lives in one place.
// The ONE absolute-length table, defined in calc.js and shared — the comment there promised this
// and two copies were living side by side (identical factors today, free to drift tomorrow).
const CSS_ABSOLUTE_UNIT_PX = CALC_ABSOLUTE_PX;
// The computed font-size in px — the engine's, every relative unit and keyword resolved — and, for an anonymous box,
// which declares nothing and inherits everything that inherits, its parent's.
function parentFontSizePx(el) {
  const p = inheritParent(el);
  return p ? computedFontSizePx(p) : DEFAULT_FONT_SIZE_PX;
}
export function computedFontSizePx(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return DEFAULT_FONT_SIZE_PX;
  const v = engineValue(el, 'font-size');
  return v === undefined ? parentFontSizePx(el) : parseFloat(v);
}
function formatPx(px) { return (+px.toFixed(4)) + 'px'; }

// A CSS <length> value → px, resolving font-relative units against `fsPx` (em/ex/ch) or the
// root (rem), viewport units against the viewport the media queries and the layout engine share,
// and absolute units via CSS_ABSOLUTE_UNIT_PX. Shared by the line-height and shadow resolvers.
// (cascade.js's `parsePx` is the layout-side twin: it needs no element, so it handles px and the
// viewport units only.)
// A font-relative length (`1rem`, `.5em`, `2ex`, `3ch`, `12pt` …) in px, or null
// when `raw` isn't one. `forFontSize` selects the em basis the spec requires for
// the `font-size` property itself: the PARENT's computed size, not this element's
// (which would recurse). Shared with layout through resolveLayoutProp.
// The weight/style half of a font-table key — the face a run is measured in, bucketed to regular / bold (from 600)
// × upright / slanted. The ONE spelling of it: layout reads its faces through here too, or the two would measure
// with different ones. Slanted is `italic` or an `oblique` at any angle but zero, which is upright (css-fonts-4 §3.3:
// `oblique 0deg` is the `normal` face).
export function fontKeyOf(el) {
  const weight = computedFontWeight(el);
  const italic = slanted(computedFontStyle(el));
  return (weight >= 600 ? 'bold' : '') + (italic ? (weight >= 600 ? ':italic' : 'italic') : '');
}
function slanted(st) {
  if (st === 'italic') return true;
  if (!st.startsWith('oblique')) return false;
  const angle = /^oblique\s+([-+]?(?:\d+\.?\d*|\.\d+))[a-z]*$/.exec(st);
  return !angle || parseFloat(angle[1]) !== 0;
}

export function fontRelativeToPx(el, raw, forFontSize = false) {
  if (raw == null || !el || el.nodeType !== NODE_ELEMENT) return null;
  const m = /^(-?\d*\.?\d+)(em|rem|ex|ch|pt|pc|in|cm|mm|q|vw|vh|vmin|vmax)$/i.exec(String(raw).trim().toLowerCase());
  if (!m) return null;
  const unit = m[2];
  // Only `em` / `ex` / `ch` are measured against a font size, and resolving one walks the ancestor
  // chain reading each element's cascade — so an absolute or viewport unit must not ask for it.
  // Computing it for every unit and throwing it away cost 8× the read (measured, 50 elements ×
  // 300 `getComputedStyle` reads: 32ms against 4ms for `outline-width: 10pt`), and `rem` — which
  // needs the ROOT's size — paid for the element's own chain on top of the root's.
  const needsFontSize = unit === 'em' || unit === 'ex' || unit === 'ch';
  const fs = needsFontSize ? fontSizeBasis(el, forFontSize) : 0;
  const px = fontLengthToPx(parseFloat(m[1]), unit, fs, el);
  return typeof px === 'number' && isFinite(px) ? px : null;
}

// The font size an `em` / `ex` / `ch` is measured against: this element's, or — on `font-size`
// itself, whose own value is what is being computed — its parent's.
function fontSizeBasis(el, forFontSize) {
  const owner = forFontSize ? inheritParent(el) : el;
  return owner ? computedFontSizePx(owner) : DEFAULT_FONT_SIZE_PX;
}

function fontLengthToPx(n, unit, fsPx, el) {
  switch (unit) {
    case 'em': return n * fsPx;
    // `ch` is the advance of the font's `0` and `ex` its x-height — both read from
    // the font FILE, the same table layout measures runs with, so they answer what
    // the page will actually render at. (16px Arial → Liberation Sans here: 1ch =
    // 8.898px, 1ex = 8.453px; Chrome 151 measures 8.891 and 8.453. A flat 0.5em,
    // which is only the spec's FALLBACK, said 8 for both.) A font that can't be
    // read, or carries no x-height, still falls back to 0.5em.
    case 'ch': return n * fsPx * chFactor(computedFontFamily(el), fontKeyOf(el));
    case 'ex': return n * fsPx * exFactor(computedFontFamily(el), fontKeyOf(el));
    case 'rem': { const root = el && el.ownerDocument && el.ownerDocument.documentElement;
                  return n * (root ? computedFontSizePx(root) : DEFAULT_FONT_SIZE_PX); }
    case 'vw': case 'vh': case 'vmin': case 'vmax': {
      const { width: w, height: h } = currentViewport();
      return n * (unit === 'vw' ? w : unit === 'vh' ? h
                : unit === 'vmin' ? Math.min(w, h) : Math.max(w, h)) / 100;
    }
    default: { const f = CSS_ABSOLUTE_UNIT_PX[unit]; return f !== undefined ? n * f : n; }
  }
}
// Walk to the nearest element ancestor (an inherited property with no value of its own takes
// the parent's computed value), or return `dflt` at the root.
function inheritComputed(el, resolve, dflt) {
  const p = inheritParent(el);
  return p ? resolve(p) : dflt;
}
// The line-height as px, or `normal`: the engine's computed value — a length or a percentage resolved to px at the
// declaring element's font size — and a unitless <number>, which is inherited AS the number, resolved against THIS
// element's own font size. An anonymous box takes its parent's.
export function computedLineHeight(el) {
  let owner = el, v;
  while ((v = engineValue(owner, 'line-height')) === undefined) {
    owner = inheritParent(owner);
    if (!owner) return 'normal';
  }
  if (v === 'normal') return v;
  return /^\d*\.?\d+$/.test(v) ? formatPx(parseFloat(v) * computedFontSizePx(el)) : v;
}
// `letter-spacing` / `word-spacing` as the px the flow adds to an advance — `normal` is zero, and
// a length is already px by the time it is computed (`1em` reads back as `16px`). A PERCENTAGE is of the element's font size — `word-spacing: 50%` adds 8px at 16px, and Chrome
// takes one for `letter-spacing` too — and a `calc()` reduces once its percentages are px. The
// computed SURFACE keeps the percentage (`getComputedStyle` reports `50%`, as Chrome does), so the
// resolution lives here, where the advance is built. `parseFloat` alone read `50%` as 50px.
export function spacingToPx(el, text) {
  return spacingAt(text, () => computedFontSizePx(el) || 16);
}
// …and as it INHERITS: a percentage inherits as the percentage, and each element resolves it against its OWN font size
// (Chrome: `letter-spacing: 10%` on a 16px block puts 3.2px between the letters of a 32px span in it) — so what a
// descendant that declares none takes is the computed TEXT, resolved here at its size (`fontSize`, read only when the
// value has a percentage). No pair of figures stands in for it: `max(10%, 2px)` is not linear in the size.
export function spacingAt(text, fontSize) {
  if (text == null) return 0;
  let v = String(text).trim();
  if (v === '' || /^normal$/i.test(v)) return 0;
  if (v.indexOf('%') !== -1) {
    const fs = fontSize();
    v = v.replace(/([+-]?[\d.]+)%/g, (_, n) => `${parseFloat(n) / 100 * fs}px`);
  }
  if (hasMathFunction(v)) {
    v = String(reduceMathFunctions(v, (n, unit) => {
      const abs = CSS_ABSOLUTE_UNIT_PX[unit];
      return abs === undefined ? null : n * abs;
    }));
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
export const computedLetterSpacingPx = (el) => spacingToPx(el, readComputed(el, 'letter-spacing').value);
export const computedWordSpacingPx   = (el) => spacingToPx(el, readComputed(el, 'word-spacing').value);
export const computedLetterSpacingText = (el) => readComputed(el, 'letter-spacing').value;
export const computedWordSpacingText   = (el) => readComputed(el, 'word-spacing').value;

// How a block lines its inline content up: `left` / `right` / `center` / `justify`, with `start`
// and `end` already turned by the block's direction (a `-webkit-` spelling folds to its keyword).
export function textAlignOf(el, rtl) {
  return foldTextAlign(readComputed(el, 'text-align').value, rtl);
}
function foldTextAlign(value, rtl) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'left' || v === 'right' || v === 'center' || v === 'justify') return v;
  if (v === '-webkit-left' || v === '-webkit-right' || v === '-webkit-center') return v.slice(8);
  if (v === '-moz-left' || v === '-moz-right' || v === '-moz-center') return v.slice(5);   // (the style engine's spelling)
  if (v === 'end') return rtl ? 'left' : 'right';
  return rtl ? 'right' : 'left';                                       // `start` and everything else
}
// A block's `text-indent`, or null where there is none: the px (a percentage is of the containing
// block's width, which the caller has in hand — as a number, or as a function asked only when a percentage
// needs it) and which lines take it — `hanging` inverts the choice, `each-line` re-indents after every forced
// break. A math function is read whole: `calc(10% + 10px)` is 30px at a 200px basis, as Chrome says, not whichever
// piece a white-space split parses last.
// `String#split(/\s+/)`, except that white space inside brackets does not split — a math function is one
// token however it is spaced.
function splitTopLevelWs(v) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= v.length; i++) {
    const c = i < v.length ? v[i] : ' ';
    if (c === '(') depth++;
    // …floored at 0: an unbalanced `)` would drive it negative, and the `depth === 0` arm below — which is also what
    // flushes the LAST token — would never run again, so a value like `40px)` would come back as NO tokens at all
    // rather than one. Unreachable from valid CSS; one character.
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(c)) {
      if (i > start) out.push(v.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}
// `text-indent` as declared: its length TEXT (a length, a percentage or a math function of both — the last one written,
// split on TOP-LEVEL white space so a math function stays whole: `calc(10% + 1px)` is one piece, a 41px indent at a
// 400px basis as in Chrome, not three), `hanging` and `each-line`. Null where there is none. `textIndentOf` resolves
// the text at a basis.
function textIndentParts(el) {
  const v = String(readComputed(el, 'text-indent').value || '').trim().toLowerCase();
  if (!v) return null;
  let hanging = false, eachLine = false, text = null;
  for (const part of splitTopLevelWs(v)) {
    if (part === 'hanging') hanging = true;
    else if (part === 'each-line') eachLine = true;
    else text = part;
  }
  return { text, hanging, eachLine };
}
// …resolved: the one resolution the cascade already has, which knows a length, a percentage and a math function of
// both, against this block's own content width, as `text-indent`'s percentage is defined (CSS Text 3 §7.1). Null
// where there is no indent to take.
export function textIndentOf(el, availableWidth) {
  const parts = textIndentParts(el);
  if (!parts || parts.text == null) return null;
  const px = lengthTextToPx(el, parts.text, typeof availableWidth === 'function' ? availableWidth() : availableWidth);
  return Number.isFinite(px) && px ? { px, hanging: parts.hanging, eachLine: parts.eachLine } : null;
}

// An element's computed `tab-size`: a number of spaces, or a length in px (layout.js `tabStopOf`
// turns either into the stop width, asked only of text that holds a tab). The Rust walk reads the
// style engine's `tab-size` itself (walk.rs).
export function tabSizeOf(el) {
  return String(readComputed(el, 'tab-size').value || '8').trim();
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
    nodeType: NODE_ELEMENT, _pseudo: which, _tag: PSEUDO_TAGS[which], _localName: PSEUDO_TAGS[which], _parent: el, _attrs: {},
    _children: [], _shadowRoot: null, _isShadowRoot: false, _lb: null,
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
    if (text !== null) {
      if (node._nid == null) registerNativeBoxNode(node, PSEUDO_TAGS[which]);
      linkPseudoBox(el, node, which);
    }
    // The text node is replaced only when the text is: an unchanged one is the same node, as a DOM text
    // child that nothing edited is, so what was measured of it stands.
    const kids = node._children;
    const same = text === null || text === '' ? kids.length === 0 : kids.length === 1 && kids[0]._data === text;
    if (!same) node._children = text === null || text === '' ? [] : [{ nodeType: 3, _data: text, data: text, _parent: node }];
  }
  slot[onKey] = text !== null;
  return slot[onKey] || force ? slot[which] : null;
}
// …and the box of a generated `::before` / `::after` the RUST walk found rendering (`layoutBuild` asks for it): made and
// linked whatever this side's own `content` says — the style engine's decides there — so the walk names its record by it.
export function linkGeneratedBox(el, which) {
  const node = pseudoNodeFor(el, which, true);
  if (!node) return;
  if (node._nid == null) registerNativeBoxNode(node, PSEUDO_TAGS[which]);
  linkPseudoBox(el, node, which);
}
// The `::placeholder` of `el`: a style holder and nothing more — the painter draws a control's placeholder text in its
// colour and font (`paint.js`), and no layout box ever holds it. One per element, for the element's life.
export function placeholderNodeFor(el) {
  return el._placeholderNode || (el._placeholderNode = makePseudoNode(el, 'placeholder'));
}

// `border-collapse` for layout's table predicates, through the SAME resolver
// getComputedStyle uses. It already puts the UA origin above inheritance and walks to
// the nearest declaring ancestor, which is exactly the resolution it needs —
// layout must never grow a second one (see `computedLineHeight`).
export function computedBorderCollapse(el) {
  const r = readComputed(el, 'border-collapse');
  const v = r && r.hit && r.value ? String(r.value).trim().toLowerCase() : '';
  return v || 'separate';
}

// The computed `font-family` list — the same inheritance + UA-default resolution
// getComputedStyle reports, exposed for layout's advance-table lookup.
export function computedFontFamily(el) {
  const r = readComputed(el, 'font-family');
  // A page that names no family gets the browser's STANDARD font, which is a serif
  // in every major browser (Chrome: Times New Roman) — measuring unstyled text in a
  // sans made every such run ~3% too wide.
  return r && r.hit && r.value ? r.value : 'Times New Roman';
}

export function computedFontWeight(el) {
  const v = engineValue(el, 'font-weight');
  return v === undefined ? inheritComputed(el, computedFontWeight, 400) : parseInt(v, 10);
}
// Computed font-style: `italic` / `oblique[ <angle>]` / `normal`.
export function computedFontStyle(el) {
  return engineValue(el, 'font-style') ?? inheritComputed(el, computedFontStyle, 'normal');
}

// The properties whose RESOLVED value is the used one — the box's own geometry, in
// px — when the element has a box. CSSOM calls these out by name; everything else
// resolves to its computed value.
const USED_VALUE_PROPS = new globalThis.Set([
  'width', 'height',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  // …and the flow-relative spellings of the first two, which name the same boxes.
  'inline-size', 'block-size',
  // The insets. A POSITIONED box owes a used value here — a percentage absolutized against its
  // containing block, and `auto` resolved to wherever layout put it — while a STATIC one reports
  // what was declared, which is what the layout answers `null` for.
  'top', 'right', 'bottom', 'left',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end'
]);
// The used figure from the layout engine, or null when the element has no box (it
// is `display: none`, or nothing has been laid out) — the caller then reports the
// COMPUTED value, as a browser does.
function usedStyleOf(el, key) {
  const fn = globalThis.__csimUsedStyle;
  if (!fn) return null;
  // Another realm's element has another realm's layout: running THIS document's pass over it
  // would answer with boxes from the wrong page. The same refusal `declaredValue` makes, and it
  // reports the computed value instead — which is what an unlaid-out element reports anyway.
  if (!ownedByThisRealm(el)) return null;
  return fn(el, key);
}

// A non-replaced INLINE box has no used width, height or MARGIN — `width` / `height` don't apply
// to it at all, and Chrome reports its margins as written (`margin-left: auto` stays `auto`,
// `50%` stays `50%`) rather than as the figure the line box gives. `display: contents` generates
// no box of its own, so nothing about it has a used value either. Both fall back to the computed
// value, which is what a browser reports: `display: inline; width: 10em` answers `160px`.
const INLINE_UNUSED_PROPS = new globalThis.Set([
  'width', 'height', 'inline-size', 'block-size',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left'
]);
function skipsUsedValue(el, key) {
  if (!INLINE_UNUSED_PROPS.has(key)) return false;
  const tag = renderingTag(el);
  const d = displayAsLaidOut(computedDisplayFor(el), tag);
  if (d === 'contents') return true;
  // (…and a fieldset's rendered legend is a block whatever display it declares: HTML's rendering blockifies it — as a
  // widget's inline-level display is an inline-block, never an inline box)
  return d === 'inline' && !REPLACED_TAGS.has(tag) && !WIDGET_TAGS.has(tag) && !(tag === 'legend' && isRenderedLegend(el));
}
const REPLACED_TAGS = new globalThis.Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'input', 'select', 'textarea', 'button']);

// Does this element have a box at all? (`display: none`, `display: contents`, and a
// document with no layout do not.) The size properties answer from the layout engine
// when it does; the rest of the box properties fall back to the computed value only
// when it doesn't.
function hasUsedBox(el) {
  return usedStyleOf(el, 'width') != null;
}
// `max-*` and `min-*` are never used values — `max-width: none` is `none` in Chrome
// whether the element is rendered or not — so their keywords report either way.
const SIZE_KEYWORD_OK = new globalThis.Set([
  'min-width', 'min-height', 'max-width', 'max-height',
  'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
  // The insets, for the opposite reason: the layout answers for every POSITIONED box above, so an
  // inset reaching here belongs to a static one — where the computed value IS the resolved value,
  // percentage and all. Declining it reported '' for `#t { position: static; top: 10% }`, and the
  // WPT file that asserts `10%` passed only because the inline-style fallback happened to carry the
  // same text; the identical rule in a STYLESHEET answered nothing.
  'top', 'right', 'bottom', 'left',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end'
]);

// A px length written with an exponent — how the style engine serializes a tiny or a huge one (`1e-9px`) — in the
// decimal form every reader here parses, and a browser reports (`0.000000001px`); anything else as it is.
function decimalPx(t) {
  const m = /^(-?\d*\.?\d+e[+-]?\d+)px$/i.exec(t);
  if (!m) return t;
  const n = Number(m[1]);
  return (Math.abs(n) < 1 ? n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : String(BigInt(Math.round(n)))) + 'px';
}
// One size DECLARATION, resolved to what `getComputedStyle` reports — or null when it needs a used
// value we can't produce. Shared by the author and UA origins (see the call sites): the cascade
// already picked a winner, and how a value resolves depends on the VALUE, never on which sheet it
// came from.
function resolveSizeDeclaration(el, key, raw) {
  const t = decimalPx(String(raw).trim());
  if (/^-?\d*\.?\d+px$/.test(t)) return { hit: true, value: t };
  if (/^-?0(\.0+)?$/.test(t))    return { hit: true, value: '0px' };
  // An explicitly declared `min-width: auto` resolves exactly like the initial one does.
  if (MIN_SIZE_PROPS.has(key) && /^auto$/i.test(t)) return { hit: true, value: automaticMinSize(el) };
  // A relative length computes to px — `max-width: 30em` is `480px` in Chrome,
  // whether or not the element has a box.
  const abs = absolutizeLengths(el, key, t);
  if (/^-?\d*\.?\d+px$/.test(abs)) return { hit: true, value: abs };
  // A PERCENTAGE computes to itself, and `auto` / `none` are keywords — but only
  // for an element with NO BOX is that the resolved value. A rendered one owes
  // the USED value.
  if (/^-?\d*\.?\d+%$/.test(t) || /^(auto|none|min-content|max-content|fit-content)$/i.test(t)) {
    // `SIZE_KEYWORD_OK` first: `hasUsedBox` runs a whole layout pass, and asking it before the
    // cheap set membership computed and threw one away on every `max-width: none` read.
    // (…and a box the property does not apply to — a non-replaced inline, a `display: contents` — owes no used value
    // whatever it declares: `<span style="width: auto">` is `auto`, as an undeclared one is (Chrome))
    return !SIZE_KEYWORD_OK.has(key) && !skipsUsedValue(el, key) && hasUsedBox(el) ? null : { hit: true, value: t.toLowerCase() };
  }
  // …and a `calc()` computes to its canonical form, on the same terms: one mixing the two to its canonical sum (a modal
  // `<dialog>`'s UA `max-height: calc(100% - 6px - 2em)` is `calc(100% - 38px)` in Chrome), and one wrapping a single
  // math function to that function (`calc(max(10%, 20px))` is `max(10%, 20px)`, Chrome and Firefox).
  if (abs.indexOf('calc(') === -1) return null;
  const canon = canonicalCalcOrder(abs);
  if (canon === abs && !canonicalLengthPercentage(abs)) return null;
  return !SIZE_KEYWORD_OK.has(key) && hasUsedBox(el) ? null : { hit: true, value: canon };
}

// The computed `color` — what text is painted in: every keyword (`inherit`, `currentcolor`, a system colour) resolved,
// animations included, as `getComputedStyle` reports it.
export function computedColor(el) {
  return readComputed(el, 'color').value;
}
// What the style engine leaves to the JS side while it is measured: the values layout resolves (a box's size, margins,
// padding, borders and insets, in either spelling, the origins, and `transform` as the matrix it comes to on the box)
// — and every shorthand of one of those, whose value is made of theirs. (Any other shorthand is the engine's to
// serialize, as CSSOM says: the shortest form, as Firefox gives it.)
const STYLE_ENGINE_DEFERS = new globalThis.Set([
  ...USED_VALUE_PROPS, ...ORIGIN_PROPS, 'transform',
  ...['margin', 'padding', 'inset'].flatMap((p) => ['block-start', 'block-end', 'inline-start', 'inline-end'].map((s) => `${p}-${s}`)),
  ...['block-start', 'block-end', 'inline-start', 'inline-end'].map((s) => `border-${s}-width`)
]);
for (const [shorthand, longhands] of Object.entries(SHORTHAND_LONGHANDS)) {
  if (longhands.some((l) => STYLE_ENGINE_DEFERS.has(l))) STYLE_ENGINE_DEFERS.add(shorthand);
}
function readComputed(el, key) {
  // The style engine answers every value that is not layout's to give — its own animations and transitions, CSS and
  // script, applied. A pseudo-element's node asks about its originating element's pseudo-element.
  if (!STYLE_ENGINE_DEFERS.has(key)) {
    const value = engineValue(el, key);
    return value === undefined ? NO_VALUE : { hit: true, value };
  }
  // A value layout gives is read at a style flush all the same, and in the engine that flush is what starts the
  // transitions the changes before it owe.
  flushStyleEngine();
  // A resolved-value read of a SHORTHAND is serialized from the resolved longhands: `#r { margin: 1px }` reports the
  // used margins as `style="margin: 1px"` does. If any longhand is unknowable the shorthand is too.
  if (isRegularShorthand(key)) {
    const parts = Object.create(null);
    for (const lh of shorthandLonghands(key)) {
      const r = readComputed(el, lh);
      if (!r.hit || r.value === '') return NO_VALUE;
      parts[lh] = r.value;
    }
    return { hit: true, value: shorthandGet(parts, key) };
  }
  const computed = engineValue(el, key);
  if (computed === undefined) return NO_VALUE;
  // A `<position>`-valued ORIGIN reports the USED offsets — the px its percentages and keywords
  // resolve to against the element's own BORDER box (Chrome-measured: `transform-origin: center`
  // on a 100×20 box is `50px 10px`, and with `padding: 10px; border: 5px` it is `65px 25px`).
  // Without a box there is nothing to resolve against, and what shows is the computed value
  // itself, keywords and all turned into percentages — which is also what an `inherit` copies, so
  // the child resolves the parent's percentages against its OWN box.
  if (ORIGIN_PROPS.has(key)) return { hit: true, value: usedOrigin(el, key) };
  // ONE geometry: `getComputedStyle(el).width` and `el.getBoundingClientRect()` are
  // two views of the same box — a page that reads a size back through the style API gets a
  // number it can do arithmetic on, not `50%` or `auto`.
  if (USED_VALUE_PROPS.has(key) && !skipsUsedValue(el, key)) {
    const used = usedStyleOf(el, key);
    if (used != null) return { hit: true, value: formatPx(used) };
  }
  // …and `transform` as the matrix it comes to on the box.
  if (key === 'transform') return { hit: true, value: engineTransformMatrix(el, computed) ?? transformMatrix(computed, () => borderBoxOf(el)) };
  // Reached only when the element has NO used box for the property — `display: none`, an inline, a static inset.
  // The resolved value is then the COMPUTED one, which is what a browser reports: Chrome on `display: none; width:
  // 10em` says `160px`, and leaves `height: auto` as `auto`.
  if (PX_REPORTABLE_LAYOUT_PROPS.has(key)) return resolveSizeDeclaration(el, key, computed) || NO_VALUE;
  return { hit: true, value: computed };
}
const NO_VALUE = Object.freeze({ hit: false });

// Absolutize the LENGTHS in a computed value: `10em` → `160px`, `12pt` → `16px`,
// `10ch` → the font's own figure. A computed value carries no relative unit — the
// cascade's job is to resolve them against the element's own font — and a page that
// reads one back expects a number it can do arithmetic on. Percentages stay as
// written: a percentage computes to itself for every property whose resolved value
// isn't the used one (`background-position: 50%` is `50%` in Chrome too).
//
// Applied token-wise so a multi-part value keeps its shape (`text-shadow: 0 0 .5em
// red`, `border-radius: 1em / 2em`), and only to tokens that are lengths — a bare
// number, a keyword, a colour and a function's name are left alone.
const LENGTH_TOKEN_RE = /(^|[\s,(/])(-?\d*\.?\d+)(em|rem|ex|ch|pt|pc|in|cm|mm|q|vw|vh|vmin|vmax)(?![\w%])/gi;
// A quoted STRING is data, not a value to rewrite: `content: " 1em "` and
// `font-family: "Foo 2em"` come back verbatim from Chrome, and absolutizing inside them
// would corrupt the text a `::before` renders. Only the spans BETWEEN quotes are rewritten.
// Deliberately NOT global: `absolutizeSpan` below resolves `ex` / `ch` through the element's font,
// which reads back through `readComputed`. A shared `/g` regex driven by `lastIndex` would have
// that inner read reset the outer scan to 0 and loop forever; a local scan position cannot.
const QUOTED_SPAN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/;
function absolutizeLengths(el, key, value) {
  // A CUSTOM property computes to its SPECIFIED token stream (CSS Variables §3, unless it was
  // registered with `@property`): Chrome reports `--gap: 2em` as `2em`, and design-token code
  // reads it back expecting exactly what it wrote. `resolveMath` bails on `--` for the same
  // reason. The `var()` SUBSTITUTION still absolutizes, because that resolves as the referring
  // property's value, not as this one.
  if (key.charCodeAt(0) === 45 && key.charCodeAt(1) === 45) return String(value);
  const s = String(value);
  if (!/\d/.test(s)) return s;
  if (s.indexOf('"') === -1 && s.indexOf("'") === -1) return absolutizeSpan(el, s);
  let out = '', at = 0, m;
  while ((m = QUOTED_SPAN_RE.exec(s.slice(at)))) {
    const start = at + m.index;
    out += absolutizeSpan(el, s.slice(at, start)) + m[0];
    at = start + m[0].length;
  }
  return out + absolutizeSpan(el, s.slice(at));
}
function absolutizeSpan(el, s) {
  return s.replace(LENGTH_TOKEN_RE, (whole, lead, num, unit) => {
    const px = fontRelativeToPx(el, num + unit);
    return px == null ? whole : lead + formatPx(px);
  });
}

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
    get cssText()      { return serializeDeclBlock(storeDecls(store)); },
    set cssText(value) { store.write(serializeDeclBlock(expandDeclList(parseStyleDeclList(String(value == null ? '' : value))))); },
    // CSSStyleDeclaration is an indexed getter: `style[0]` / `style.item(0)` is the 0-based
    // property NAME, and it is iterable over those names. `length` counts them.
    get length()       { return Object.keys(storeDecls(store)).length; },
    item:              (index) => Object.keys(storeDecls(store))[index >>> 0] || '',
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
      if (isSettableProperty(name)) writeStoreProp(store, name, value === null ? '' : String(value), priority);
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
  if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
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
  if (!el || el.nodeType !== NODE_ELEMENT) return {};
  const proxy = globalThis.getComputedStyle(el);
  const out = {};
  for (const n of names) out[n] = String(proxy[n] || '');
  return out;
};
