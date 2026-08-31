// `Element.prototype.style` — Proxy over the inline `style="..."`
// attribute that surfaces both camelCase IDL access
// (`style.backgroundColor`) and kebab-case (`style['background-color']`).
// Reads parse the attribute; writes round-trip through the decl
// parser so the attribute stays canonical regardless of how the
// caller phrased the value.
//
// `getComputedStyle(el)` returns a small Proxy whose `display` /
// `visibility` getters route through the cascade resolver — every
// other property falls back to the inline style read. jQuery 3.x's
// `.css()` / `:visible` / `isHiddenWithinTree` path lands here on
// every probe, so the per-element proxy is cached on `_computedStyleProxy`.

import { NODE_ELEMENT }                  from './constants.js';
import { flatTreeParent } from './walk.js';
import { currentDirtySeq } from './mutation-observer.js';
import { animatedValue, animatedProperties, transitionedValue, transitionSpecs, runKey, noteAnimatedElement } from './animation.js';
import { scriptAnimatedValue, scriptAnimatedProperties } from './web-animations.js';
import { documentHasKeyframes } from './cascade.js';
import { ANIMATION_TYPES } from './css-property-data.js';
import { SHADOW_LENGTHS, canonicalLengthPercentage } from './interpolate.js';
import { cascadedProperty, cascadedIsImportant, documentMayTransition, noteUncacheableRead, dynamicReadSeq, restoreDynamicSeq, ctxUnsafeReadSeq, restoreCtxUnsafeSeq, ctxEpochOf, cascadeStyleEpoch, varGen, varGenTotalNow, noteDep, depFrameOpen, openDepFrame, closeDepFrame, ownedByThisRealm, expandShorthandValue, twinName, matchesAnyHideRule, splitImportant, computedVisibility, ownDisplay, inlineDecls, cascadeDeclaresProperty, canExpandShorthand, flowSides } from './cascade.js';
import { CSS_PROPERTY_BY_IDL_ATTRIBUTE, cssPropertyName, parseStyleDeclList, serializeCssValue, serializeFontFamily, SYSTEM_COLORS, ABSOLUTE_FONT_SIZE_PX, resolveCssUrls, documentBaseUrl, canonicalizeBgPosition, normalizeZeroLengths, splitTopLevel, splitValues, isSupportedCssPropertyName, isValidDeclarationValue, htmlInteger } from './css-utils.js';
import { serializeDeclBlock, expandDeclList, isRegularShorthand, shorthandGet, shorthandExpand, shorthandLonghands, clearNamedLonghands, groupNeedsMove, allGet, allGetPriority, isCoveredByAll, isCssWideKeyword, combineBox, hasSubstitution, pendingSource } from './shorthands.js';
import { currentViewport }               from './media-query.js';
import { chFactor, exFactor }            from './font-metrics.js';
import { hasMathFunction, reduceMathFunctions, simplifySpecifiedMath, ABSOLUTE_UNIT_PX as CALC_ABSOLUTE_PX } from './calc.js';
import { lookup, handles }               from './handles.js';
import { LONGHANDS, INITIAL_VALUES, INHERITED_PROPERTIES, SHORTHAND_LONGHANDS } from './css-property-data.js';
import { selectDisplaySize }              from './html-integers.js';

// A resolved-value (computed) declaration enumerates every supported CSS LONGHAND, in
// lexicographic order (getComputedStyle-property-order / -logical-enumeration): shorthands
// and env vars are excluded (LONGHANDS is exactly the longhand set), and any custom property
// present on the element is appended (custom / vendor names sort after standard ones). `all`
// is filtered out — it is the reset shorthand, never itself enumerated in a computed style.
// KNOWN GAPS (bounded, no in-scope test): a getComputedStyle read resolves a property from the
// cascade only for the properties the cascade captures — the rest report their initial value
// unless an inline `style=` sets them; only the element's OWN inline custom properties are
// enumerated (inherited / registered ones need a cascaded custom-property model); and the
// proxy has no `ownKeys` trap, so `Object.keys(gCS)` stays `[]` (indices aren't own keys).
const COMPUTED_LONGHAND_NAMES = [...LONGHANDS].filter(n => n !== 'all').sort();
// The enumerated names for an inline-style proxy, memoized per computed-style proxy on the
// custom-property signature so a `for (i…) gCS[i]` loop doesn't re-scan / re-allocate per
// index (rule 3). The no-custom-property case returns the shared constant (zero allocation).
function makeComputedNames() {
  let cache = COMPUTED_LONGHAND_NAMES, sig = '';
  return (inlineStyle) => {
    let custom = null;
    for (const k of inlineStyle) if (k.charCodeAt(0) === 45 /* '-' */) (custom || (custom = [])).push(k);
    if (!custom) { sig = ''; return (cache = COMPUTED_LONGHAND_NAMES); }
    const nextSig = custom.sort().join(',');
    if (nextSig !== sig) { sig = nextSig; cache = COMPUTED_LONGHAND_NAMES.concat(custom); }
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
    for (const k in decls) if (!k.startsWith('--')) decls[k] = k === 'font-family' ? serializeFontFamily(decls[k]) : serializeCssValue(decls[k]);
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
  if (v !== '' && v != null) {
    if (/^\s*important\s*$/i.test(String(priority == null ? '' : priority))) {
      v = stripImportant(String(v)) + ' !important';
    } else if (priority != null && priority !== '') {
      return;
    }
  }
  // Reject a value the property's grammar can't accept (a longhand with a known simple type) — like
  // an unparseable shorthand, an invalid value is a no-op: the block is left untouched, so no
  // mutation record is queued (mutationrecord-002 / css-style-attr-decl-block invalid-value cases).
  if (v !== '' && v != null && !isValidDeclarationValue(name, stripImportant(String(v)))) return;
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
// element). Importance-bearing reads (the cold `getPropertyPriority`,
// `inlineDecls`) use the cascade's `splitImportant`. `IMPORTANT_SUFFIX_RE`
// mirrors `cascade.js`'s `IMPORTANT_RE`; keep them in sync.
const IMPORTANT_SUFFIX_RE = /\s*!\s*important\s*$/i;
function stripImportant(v) {
  if (typeof v !== 'string' || v.indexOf('!') < 0) return v;
  return v.replace(IMPORTANT_SUFFIX_RE, '').trim();
}

// jQuery 3.x calls `defaultDisplay` synthetically by mounting an
// element and reading its computed display; without a default our
// `__computedDisplayFor` returned '' for a "shown" element, jQuery
// resolved that as hidden again, and `.show()` left a misleading
// empty inline display on the element.
// The UA stylesheet's per-tag display. Exported for the layout engine's hot path: resolving a used
// display through the full cascade for every element on the page is far more than an inline/block
// decision needs when nothing declares one.
export // Prototype-less and read through `hasOwnProperty`: `el._tag` is page-controlled, so a
// `<constructor>` element would otherwise take Object's constructor as its display.
const DEFAULT_DISPLAY = Object.assign(Object.create(null), {
  a: 'inline', abbr: 'inline', b: 'inline', bdi: 'inline', bdo: 'inline',
  br: 'inline', cite: 'inline', code: 'inline', data: 'inline',
  dfn: 'inline', em: 'inline', i: 'inline', kbd: 'inline', mark: 'inline',
  q: 'inline', rp: 'inline', rt: 'inline', ruby: 'inline', s: 'inline',
  samp: 'inline', small: 'inline', span: 'inline', strong: 'inline',
  sub: 'inline', sup: 'inline', time: 'inline', u: 'inline', var: 'inline',
  wbr: 'inline', label: 'inline', input: 'inline-block', img: 'inline',
  // Embedded content is INLINE-level, every one of them (measured in Chrome: an `a<canvas>b`
  // is one 34px line, not three). Laying them out as blocks put an inline SVG icon, a video and
  // an embedded frame each on a line of its own and made the box around them twice too tall.
  canvas: 'inline', iframe: 'inline', svg: 'inline', video: 'inline',
  object: 'inline', embed: 'inline', audio: 'inline', marquee: 'inline-block',
  // A `<slot>` is a box only in the DOM: HTML's sheet gives it `display: contents`, so the nodes
  // assigned to it lay out in the box AROUND it — which is whose `direction` decides where they
  // go, however the slot's own `dir` reads (`dir-shadow-03`).
  slot: 'contents',
  meter: 'inline-block', progress: 'inline-block',
  button: 'inline-block', select: 'inline-block', textarea: 'inline-block',
  table: 'table', thead: 'table-header-group', tbody: 'table-row-group',
  tfoot: 'table-footer-group', tr: 'table-row', th: 'table-cell', td: 'table-cell',
  caption: 'table-caption', colgroup: 'table-column-group', col: 'table-column',
  li: 'list-item', summary: 'list-item',
  template: 'none', script: 'none', style: 'none', noscript: 'none',
  head: 'none', title: 'none', meta: 'none', link: 'none',
  option: 'block', optgroup: 'block'
});

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

// The UA stylesheet's display for `el`, or undefined where it has nothing to say: the per-tag
// table above, plus the unconditional hides.
export function uaDisplay(el) {
  return uaHidden(el) ? 'none' : DEFAULT_DISPLAY[el._tag];
}

// HTML's widgets, whose BOX the UA decides however the page spells `display` (layout.js
// `WIDGET_BLOCK_DISPLAYS`). That is a USED-value rule and deliberately not a computed one: the
// computed value stays the keyword the page wrote (`button-layout/computed-style` is 162 subtests
// of exactly that, and it is Chrome that diverges there, not this driver).
export const WIDGET_TAGS = new Set(['button', 'input', 'select', 'textarea', 'fieldset',
                                    'meter', 'progress', 'marquee']);
// CSS Display §2.7: a float and an out-of-flow box are BLOCKIFIED — `<span style="float: left">`
// is a block box, not a word on a line, and Chrome reports its computed `display` as `block`. A
// LAYOUT-INTERNAL box blockifies to `block` too (a floated `display: table-cell` is a block);
// `table` is block-level already and stays as it is.
const BLOCKIFIED = Object.assign(Object.create(null), {
  inline: 'block', 'inline-block': 'block', 'inline-table': 'table',
  'inline-flex': 'flex', 'inline-grid': 'grid',
  'table-row': 'block', 'table-row-group': 'block', 'table-header-group': 'block',
  'table-footer-group': 'block', 'table-column': 'block', 'table-column-group': 'block',
  'table-cell': 'block', 'table-caption': 'block', 'run-in': 'block',
  'ruby-base': 'block', 'ruby-text': 'block',
  'ruby-base-container': 'block', 'ruby-text-container': 'block'
});
// ONE funnel, so the computed value and the layout engine's own display cannot disagree about a
// blockified box. Nothing is read from the cascade while the display is not blockifiable at all,
// which is the answer for almost every element on a page.
export function blockify(el, display) {
  const b = BLOCKIFIED[display];
  if (b === undefined) return display;
  const pos = declaredValue(el, 'position');
  const p = pos == null ? '' : String(pos).trim().toLowerCase();
  if (p === 'absolute' || p === 'fixed') return b;
  const f = declaredValue(el, 'float');
  if (f == null) return display;
  const v = String(f).trim().toLowerCase();
  return (v === 'left' || v === 'right' || v === 'inline-start' || v === 'inline-end') ? b : display;
}

// Exported for the layout engine: it needs the USED display (author inline style, stylesheet, then
// the per-tag UA default), not just an author-declared keyword — telling a `<span>` from a `<div>`
// is what makes inline content share a line instead of stacking.
export { computedDisplayFor as usedDisplay };
function computedDisplayFor(el) {
  // The cascaded `display` (inline OR stylesheet — ownDisplay reads both). Report the actual
  // author keyword (flex / grid / inline-block / …), not just the tag default, so app JS can
  // read the layout mode. (We don't lay flex/grid out, but the COMPUTED display value is the
  // specified one regardless.) `display` does NOT inherit.
  // …except the UA rules Chrome marks `!important` (`uaHidden`), which the page cannot override.
  if (uaHidden(el)) return 'none';
  const d = ownDisplay(el);
  if (d === 'inherit') { const p = el._parent; return (p && p.nodeType === NODE_ELEMENT) ? computedDisplayFor(p) : 'inline'; }
  if (d === 'unset' || d === 'initial') return blockify(el, 'inline');           // display's CSS initial
  if (d === 'revert' || d === 'revert-layer') return blockify(el, uaDisplay(el) || 'block');
  if (d != null) return blockify(el, d);                                         // none / flex / grid / block / …
  // No author display: honour the UA `[hidden]` / filtered-option `display: none`, else the
  // per-tag default. (ignoreVisibility=true: `visibility` is independent of the display value.)
  if (matchesAnyHideRule(el, true, null, el._attrs.hidden != null)) return 'none';
  if (el._tag === 'option' && el._filtered === true) return 'none';
  return blockify(el, uaDisplay(el) || 'block');
}

// visibility resolves through the hide-rule cascade (author rule OR inline style) and
// INHERITS; the initial is `visible`. (The inline-only regex this used to run missed every
// stylesheet rule, so getComputedStyle(el).visibility was '' for them.)
function computedVisibilityFor(el) { return computedVisibility(el); }

// One axis's own computed overflow keyword, BEFORE the pairing rule below. A CSS-wide keyword is
// resolved through the one place that knows what each of them means (`readComputedGeneric` — the
// comment on `declaresCssWide` records that reimplementing `revert` here got it wrong), and
// anything unrecognised is discarded: an invalid declaration does not produce a used value, the
// initial `visible` does. Reading the raw string instead made `overflow: initial` — and every typo
// — CLIP its box, so a child hanging outside it could not be clicked.
const OVERFLOW_KEYWORDS = new globalThis.Set(['visible', 'hidden', 'clip', 'scroll', 'auto']);
function overflowKeyword(el, prop, dv) {
  // …falling back to the UA sheet, which is where a listbox `<select>`'s `overflow-y: scroll`
  // lives. `declaredValueIn` answers only for AUTHOR declarations; `resolveLayoutProp` adds this
  // same fallback, and the two have to agree about what a box's overflow is.
  const raw = declaredValueIn(dv, el, prop) ?? uaDefault(el, prop);
  if (raw == null) return 'visible';
  const v = String(raw).trim().toLowerCase();
  if (OVERFLOW_KEYWORDS.has(v)) return v;
  if (!CSS_WIDE_KEYWORDS.has(v)) return 'visible';
  const g = readComputedGeneric(el, prop);
  const gv = g && g.hit ? String(g.value).trim().toLowerCase() : '';
  return OVERFLOW_KEYWORDS.has(gv) ? gv : 'visible';
}

// The overflow a box USES in one axis. CSS Overflow 3: `visible` and `clip` compute to `auto` and
// `hidden` RESPECTIVELY when the other axis is neither `visible` nor `clip` — a box cannot scroll
// in one axis and spill in the other. So a bare `overflow-x: hidden` makes `overflow-y` compute to
// `auto`, and `overflow-x: hidden; overflow-y: clip` is `hidden hidden`.
//
// It lives here rather than in the layout engine because it IS a computed value, and the two have
// to agree: the layout engine asks it to decide what clips and what a flex item's automatic
// minimum is, and `getComputedStyle` reports the same answer, where it used to report the
// specified `visible` that no browser reports. `readComputed` routes both longhands here BEFORE
// its CSS-wide branch, so the pairing applies to an `overflow-x: inherit` too (Chrome pairs it:
// `inherit` beside a `hidden` reports `auto`).
// Both longhands come from ONE opened declared-value entry — the cascade expands every `overflow`
// shorthand, sheet and inline alike, so the shorthand itself never has to be consulted.
export function usedOverflow(el, axis) {
  const dv = declaredValueEntry(el);
  const x = overflowKeyword(el, 'overflow-x', dv), y = overflowKeyword(el, 'overflow-y', dv);
  const mine = axis === 'x' ? x : y, other = axis === 'x' ? y : x;
  if (other === 'visible' || other === 'clip') return mine;
  return mine === 'visible' ? 'auto' : mine === 'clip' ? 'hidden' : mine;
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

// Custom properties inherit, so walk ancestors. The depth cap catches
// ill-formed `var(--a) → var(--b) → var(--a)` cycles.
function resolveCssVars(el, value, depth) {
  if (typeof value !== 'string' || value.indexOf('var(') < 0) return value;
  if (depth == null) depth = 0;
  if (depth > 16) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start < 0) { out += value.slice(i); break; }
    out += value.slice(i, start);
    const inside = sliceBalanced(value, start + 4);
    if (!inside) { out += value.slice(start); break; }
    const commaIdx = topLevelComma(inside.body);
    const name = (commaIdx < 0 ? inside.body : inside.body.slice(0, commaIdx)).trim();
    const fallback = commaIdx < 0 ? '' : inside.body.slice(commaIdx + 1).trim();
    noteDep(name);
    let resolved = null;
    for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
      const v = cascadedProperty(cur, name);
      if (v != null && v !== '') { resolved = v; break; }
    }
    out += resolveCssVars(el, resolved != null ? resolved : fallback, depth + 1);
    i = inside.end;
  }
  return out;
}

// The element's DECLARED value for `key`, in the form every resolved-value read wants: a `var()` in
// the value resolved against this element, and a PENDING slot (the one a `margin: var(--m)`
// shorthand occupies) expanded from its source shorthand. Returns null when nothing declares the
// property — and equally when the substitution is INVALID AT COMPUTED-VALUE TIME, since the
// declaration then acts as `unset` (Chrome measured: `margin-top: 9px; margin: var(--bogus)`
// computes `0px`, so the failed shorthand both wins the slot and empties it), which is exactly what
// a null answer already means to every caller.
//
// Resolving here rather than at each of the twenty-odd `cascadedProperty` reads below is the point:
// doing it per site is what left `margin-left: var(--x)` unresolved in the px-reportable branch
// while the generic tail handled it. The LAYOUT pass reads through it too, so geometry and
// getComputedStyle can't disagree about what a `var()` resolves to.
// Decomposing a resolved shorthand is a PURE function of (shorthand, value), so the result is
// cached content-addressably — the same shape as the driver's other four caches. It stays even now
// that a per-element memo exists below: this one survives an invalidation, since the answer doesn't
// depend on the element at all.
const PENDING_EXPANSIONS = new Map();
function expandedPending(shorthand, resolved) {
  const k = shorthand + '\u0000' + resolved;
  if (PENDING_EXPANSIONS.has(k)) return PENDING_EXPANSIONS.get(k);
  const pairs = expandShorthandValue(shorthand, resolved);
  // Bounded: a page's design tokens are a handful of values, but a page GENERATING them (an
  // animation writing `--x` per frame) must not grow this without limit.
  if (PENDING_EXPANSIONS.size > 512) PENDING_EXPANSIONS.clear();
  PENDING_EXPANSIONS.set(k, pairs);
  return pairs;
}

// Reading a longhand behind a substitution runs an ancestor walk per `var()` that the literal form
// doesn't. The per-element memo below closes it: same machine, back to back, 400 elements x 5
// rounds over four box longhands + gBCR — behind `var()` 8.5-10.2 ms -> 2.0-2.6 ms, and the LITERAL
// path 4.7-6.1 ms -> 2.2-2.9 ms, since a layout pass re-reads the same properties several times per
// element.
// Memoised per element — but only a read that is SOUND to cache.
//
// Three attempts cached everything and invalidated by enumerating the state that dynamic
// pseudo-classes read; all three shipped stale style, because the axis that matters is not which
// pseudo-classes are dynamic but which code paths WRITE the state behind them (`_value` has 19
// writers, `_selectedness` 18, and every interaction path bypasses the IDL setter a bump was
// attached to). So this one doesn't enumerate: `cascadedRecord` reports whether the read so much as
// CONSIDERED a rule carrying a dynamic pseudo-class, and only an untainted answer is cached. A page
// with `:hover { color }` loses caching of `color` and keeps it for `margin-top`.
//
// The generation key still applies to what IS cached — stylesheets, the DOM, attributes, the form
// state — so the two mechanisms cover different halves and neither has to be complete alone.
// Every cache hit recomputed and compared. A BUILD-TIME constant — `build:bridge` defines it FALSE
// so esbuild folds the check away entirely (without the define there is nothing to substitute and
// the `typeof` survives, which is what the shipped bundle used to carry); the validation run is the
// same build with it defined true:
//
//   npx esbuild lib/capybara/simulated/js/src/bridge.entry.js --bundle --format=iife --keep-names \
//     --define:__CSIM_VERIFY_STYLE_CACHE__=true --outfile=lib/capybara/simulated/js/bridge.bundle.js
//
// then the full gate + app suites, then a plain rebuild. It only verifies what the run EXERCISES —
// a clean sweep of it once still shipped five stale pseudo-classes, because no gated test read
// computed style right after a hover / `value` write. Its dynamic-state coverage comes from
// `spec/cascade_invalidation_spec.rb`, whose table carries BOTH the IDL-setter and the interaction
// path for each pseudo-class. Keep that table complete and this check means something.
const VERIFY_STYLE_CACHE = typeof __CSIM_VERIFY_STYLE_CACHE__ !== 'undefined' && __CSIM_VERIFY_STYLE_CACHE__;
function verifyDeclaredValue(el, key, cached) {
  // The recompute must not disturb the taint bracket of the read we are INSIDE. A cache hit happens
  // within an outer `declaredValue` (a `var()` lookup, a font-size resolution, the inheritance
  // walk), and letting this recompute bump `dynamicSeq` made that outer read look tainted — so the
  // instrumented build never cached the nested entries the memo exists for, and verified strictly
  // less than the shipped build does.
  // …nor the enclosing DEPENDENCY frame: the recompute gets its own, and what it read must be
  // within what the hit recorded — otherwise the replay into the outer frame (declaredValueIn)
  // would be leaking the recompute's names, not the memo's.
  const seqBefore = dynamicReadSeq();
  const ctxSeqBefore = ctxUnsafeReadSeq();
  const outer = openDepFrame();
  let fresh, deps;
  // …and no BEFORE-CHANGE style: this is a recompute of a value the memo already holds, and
  // handing it one would let a verification pass start a transition of its own. (An animated or
  // transitioned value is never cached, so none reaches this check.)
  try { fresh = computeDeclaredValue(el, key, null); }
  finally { deps = closeDepFrame(outer); }
  restoreDynamicSeq(seqBefore);
  restoreCtxUnsafeSeq(ctxSeqBefore);
  const where = (el._tag || '?') + (el._attrs && el._attrs.id ? '#' + el._attrs.id : '');
  if (deps !== null) {
    const recorded = entryDepsFor(el, key);
    for (const [n] of deps) {
      if (recorded === undefined || recorded.indexOf(n) === -1) throw new Error(`[csim] style cache dep MISSING on ${where} ${key}: recompute read ${n}, memo recorded ${JSON.stringify(recorded)}`);
    }
  }
  if (fresh === cached) return;
  throw new Error(`[csim] style cache STALE on ${where} ${key}: cached ${JSON.stringify(cached)}, fresh ${JSON.stringify(fresh)}`);
}
function entryDepsFor(el, key) {
  const entry = DV_MEMO.get(el);
  if (!entry || entry.vdeps === undefined) return undefined;
  return entry.vdeps.get(key);
}

// Keyed in a MODULE-LOCAL WeakMap, not on the element. A frame realm evaluates its own copy of this
// bundle with its own `cascadeGeneration()` counter and its own rules; an element property would be
// shared across realms, and both counters start at 0 — so a parent-realm read of a child-realm
// element wrote its (differently-resolved) answer where the child realm read it back as current.
// A per-realm map makes the cache exactly as wide as the cascade that filled it.
const DV_MEMO = new WeakMap();

// `ownedByThisRealm` moved to cascade.js (the hide memos share it); see the guard rationale
// there and on the cache-refusal below.

// The element's declared-value memo entry for the CURRENT (rule set, structural context)
// key, opened once — or null when the element refuses caching (cross-realm,
// slottable candidate; the rationale for both refusals is on `declaredValue` below). A hot loop
// that reads many properties of ONE element (the layout pass asks ~17) fetches this once and
// reads through `declaredValueIn`, instead of paying the realm guard + both epoch derivations +
// the WeakMap round-trip per property. Hold it only across a synchronous read burst: any DOM
// mutation or dynamic-state write between reads can move the key, and a held entry would then
// serve the previous key's world.
export function declaredValueEntry(el) {
  if (!ownedByThisRealm(el)) return null;
  if (el._parent && el._parent._shadowRoot) return null;
  // An `<img>` in a `<picture>` takes its dimension hint from a SIBLING `<source>`'s attributes
  // (cascade.js `presentationalHint`), and the context epoch tracks only this element's own
  // attributes plus gated ancestor state — a `source.setAttribute('width', …)` moves neither, so
  // a memo here served the old width for the rest of the burst. That is exactly the responsive
  // swap the hint exists for, so this element refuses caching, like a slotted one.
  if (el._tag === 'img' && el._parent && el._parent._tag === 'picture') return null;
  const epoch = cascadeStyleEpoch();
  const ctx = ctxEpochOf(el);
  let entry = DV_MEMO.get(el);
  if (entry === undefined || entry.epoch !== epoch || entry.ctx !== ctx) {
    // The OUTGOING map is the element's before-change style for every property it READ, whether
    // or not it transitioned one at the time: a page that declares the transition and changes the
    // value in one go is measured against the style from before both, and nothing was transitioned
    // then. Carrying it costs one reference — the alternative is a map write on every
    // declared-value read in the driver, on every page.
    entry = { epoch, ctx, map: new Map(), prev: entry ? entry.map : null,
              vdeps: undefined, vgen: varGenTotalNow() };
    DV_MEMO.set(el, entry);
  }
  return entry;
}

// One declared-value read through an already-opened entry (null = the element refused caching —
// compute uncached, exactly as `declaredValue` would).
export function declaredValueIn(entry, el, key) {
  if (entry === null) return computeDeclaredValue(el, key, null);
  const memo = entry.map;
  // A value that substituted an inherited input (`var()`, a `calc()` font basis, the flow twin) is
  // valid while every name it read keeps its generation (cascade.js `varGen`): the element's
  // structural context does not move when an ancestor's `--x` changes, the generation does. The
  // per-name check runs once per entry per movement of ANY name (`varGenTotalNow`), never per hit.
  if (entry.vdeps !== undefined && entry.vgen !== varGenTotalNow()) revalidateDeps(entry);
  const cached = memo.get(key);
  if (cached !== undefined) {
    // A hit inside an enclosing compute hands its inherited inputs up, as a nested compute does:
    // the outer value depends on them too.
    if (entry.vdeps !== undefined && depFrameOpen()) {
      const deps = entry.vdeps.get(key);
      if (deps !== undefined) for (let i = 0; i < deps.length; i += 2) noteDep(deps[i]);
    }
    if (VERIFY_STYLE_CACHE) {
      // The hold-only-across-a-synchronous-burst contract is otherwise enforced by comment
      // discipline alone; a caller that held an entry across a mutation would serve stale
      // values with no signal. Re-opening is free when current (same object comes back).
      if (entry !== declaredValueEntry(el)) {
        throw new Error('[csim] declaredValueIn: held entry is stale for <' + el._tag + '> ' + key);
      }
      verifyDeclaredValue(el, key, cached);
    }
    return cached;
  }
  // Bracket the read by SEQUENCE rather than a flag: this read path re-enters itself (a `var()`
  // lookup, a font-size resolution), and a flag the inner call cleared would hand the outer one a
  // false "clean".
  const before = dynamicReadSeq();
  const beforeCtx = ctxUnsafeReadSeq();
  // …and collect the inherited inputs the compute reads (`noteDep`), nested reads included: an
  // inner frame hands its names up when it closes, so `width: var(--a)` over `--a: var(--b)`
  // depends on both.
  const outerDeps = openDepFrame();
  let value, mine;
  try { value = computeDeclaredValue(el, key, entry); }
  finally { mine = closeDepFrame(outerDeps); }
  if (dynamicReadSeq() === before && ctxUnsafeReadSeq() === beforeCtx) {
    memo.set(key, value);
    if (mine !== null) {
      const snap = [];
      for (const [n, g] of mine) snap.push(n, g);
      if (entry.vdeps === undefined) entry.vdeps = new Map();
      entry.vdeps.set(key, snap);
    }
  }
  return value;
}
// Some inherited-input name moved since this entry last checked: drop every value whose recorded
// generations no longer hold, then remember the counter — the next hits are one compare again.
function revalidateDeps(entry) {
  for (const [key, snap] of entry.vdeps) {
    if (!varDepsFresh(snap)) { entry.map.delete(key); entry.vdeps.delete(key); }
  }
  entry.vgen = varGenTotalNow();
}
// [name, gen, name, gen, …] as recorded; fresh while every generation still matches.
function varDepsFresh(snap) {
  for (let i = 0; i < snap.length; i += 2) if (varGen(snap[i]) !== snap[i + 1]) return false;
  return true;
}

export function declaredValue(el, key) {
  // Only an element THIS realm's document owns is cacheable. A cross-realm read — the parent
  // resolving a child frame's element — resolves against the PARENT's rules and its own generation
  // counter, and both realms' counters start at 0, so a cached answer would be handed back as
  // current in a cascade that never produced it. (The mis-resolution itself predates this cache:
  // measured identical on the commit before it, so this guard keeps the cache from making a
  // separate, existing bug sticky rather than fixing it.) A DOMParser document is excluded by the
  // same test, which is only ever conservative.
  //
  // A slottable candidate's `::slotted()` applicability can change via shadow-side slot
  // mutations that bump nothing on its ancestor chain — same refusal as the hide memos.
  //
  // Keyed on (the rule set, the element's OWN structural context) — deliberately NOT on
  // `settleGen` (a mutation on the other side of the page doesn't change this element's declared
  // values, and the global key made every app-page layout pass start cold) nor on the dynamic
  // style-state generation (see `cascadeStyleEpoch`: the taint bracket is what keeps a cached
  // value independent of focus / hover / form state, so the generation only cold-started the memo
  // on every keystroke). What a
  // mutation CAN change is covered element-locally: `ctxEpochOf` moves when the element's own
  // attributes / child list do, when its siblings' do where a sibling combinator reads them, and
  // when an ancestor's do as far as a rule reads that identifier in an ancestor position (the
  // structural-context gate, cascade.js); an inherited input a value substituted — a custom
  // property, a `calc()` font basis, the flow — is validated per name on every hit (`varGen`);
  // dynamic pseudo-classes decline caching via the taint bracket in `declaredValueIn`, and `:has()`
  // via the ctx-unsafe bracket.
  return declaredValueIn(declaredValueEntry(el), el, key);
}

// The former note, kept because it is why the above is shaped the way it is.
// NOT memoised by enumeration, and that is a decision with three rounds of evidence behind it.
//
// The cascade matches selectors LIVE on every read, so caching a result means invalidating it on
// every input a dynamic pseudo-class reads. Two attempts enumerated those inputs by hand; both
// shipped stale style. The second attempt even generated its cases from `selectors.js`'s own
// pseudo-class table — and still missed, because the axis that matters is not WHICH pseudo-classes
// are dynamic but WHICH CODE PATHS write the state behind them: `_value` has 19 writers,
// `_selectedness` 18, and a bump on the IDL setter leaves every interaction path (a click through
// `setCheckedness`, `setRangeText`, `execCommand`, typing) silently stale. `:checked` stopped
// updating after a click — the driver's most common interaction.
//
// The measured prize is real (behind `var()` 8.5-10.2 ms -> 2.0-2.6 ms over 400 elements), so this
// is a deferral, not an abandonment. What it needs is a cacheability rule that is sound BY
// CONSTRUCTION rather than by enumeration: `cascadedRecord` already walks the candidate rules for a
// property, so it can report whether any of them used a dynamic pseudo-class, and only an untainted
// answer is cacheable. No list of state writers to keep complete. See the backlog task.
//
// That rule is what ships now (the taint bracket in `declaredValueIn`), and it is the WHOLE
// cacheability story: the memo key carries the rule set and the element's structural context only —
// `styleStateGen` stays out of it (`cascadeStyleEpoch`). `cascadeGeneration` still feeds the
// writing-mode memo, and `spec/cascade_invalidation_spec.rb` pins the behaviour either way.
// A math function is resolved HERE, in the same funnel that resolves substitutions, so the cascade,
// getComputedStyle and the layout pass all see one already-reduced value. It runs after
// substitution, because `calc(var(--gap) * 2)` only has terms once the reference resolves.
// A resolved math function collapses to a plain value — Chrome reports `calc(10px + 5px)` as
// `15px` (measured) — and an INVALID one makes the whole declaration invalid.

// The LENGTH units the evaluator may use, and only these: `calc.js` needs `toPx` to answer null for
// anything else, and `fontLengthToPx`'s own fallback returns the bare number instead — which turned
// `calc(100dvh - 50px)` into `50px` and fed it to the layout engine. The dynamic/small/large
// viewport units are the viewport here (no browser chrome to retract), so they are `vh`/`vw`.
const CALC_VIEWPORT_ALIAS = Object.assign(Object.create(null),
  { dvh: 'vh', svh: 'vh', lvh: 'vh', dvw: 'vw', svw: 'vw', lvw: 'vw' });
const CALC_FONT_UNITS = new Set(['em', 'ex', 'ch']);
const CALC_VIEWPORT_UNITS = new Set(['vw', 'vh', 'vmin', 'vmax']);
// The properties whose used value can't go below zero. A math result IS clamped there (CSS Values
// 4) — `width: calc(50vw - 800px)` is `0px`, not `-288px`, and before this stage resolved anything
// a negative never reached layout at all. `margin` and the insets are deliberately absent: they may
// be negative.
const CALC_NON_NEGATIVE = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'inline-size', 'block-size', 'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-block-start-width', 'border-block-end-width', 'border-inline-start-width', 'border-inline-end-width',
  'outline-width', 'column-rule-width', 'column-width', 'column-gap', 'row-gap',
  'font-size', 'flex-basis', 'background-size', 'border-spacing'
]);

function resolveMath(el, key, value) {
  // A CUSTOM property keeps its token sequence — an unregistered `--x: calc(1px + 1px)` is handed
  // back verbatim, exactly as `.5px` and `url(a.png)` are.
  if (key.startsWith('--') || !hasMathFunction(value)) return value;
  // The em basis is computed LAZILY, and for `font-size` it is the PARENT's — `em` on font-size
  // means the inherited size (Chrome: `font-size: 2em` under a 20px parent is 40px). Both matter:
  // asking for this element's own font size while resolving its own `font-size` declaration
  // recursed until the stack blew, and `font-size: clamp(...)` is ordinary responsive typography.
  let fsPx = null;
  const emBasis = () => {
    if (fsPx === null) {
      noteDep('@font-size');   // an INHERITED input of this declared value (structural-context gate)
      const owner = key === 'font-size' ? el._parent : el;
      fsPx = (owner && owner.nodeType === NODE_ELEMENT) ? computedFontSizePx(owner) : DEFAULT_FONT_SIZE_PX;
    }
    return fsPx;
  };
  // `rem` is resolved HERE rather than through `fontLengthToPx`, which reads the root's computed
  // font-size unconditionally: while resolving the ROOT's own `font-size` that re-enters this
  // function forever. Per spec, `rem` inside the root's font-size is the INITIAL size — which is
  // also what makes `html { font-size: calc(1rem + 1vw) }`, the fluid-typography idiom, terminate.
  const remBasis = () => {
    noteDep('@font-size');
    const root = el && el._ownerDoc && el._ownerDoc.documentElement;
    if (!root || (key === 'font-size' && el === root)) return DEFAULT_FONT_SIZE_PX;
    return computedFontSizePx(root);
  };
  const toPx = (n, unit) => {
    const u = CALC_VIEWPORT_ALIAS[unit] || unit;
    if (u === 'rem')                return n * remBasis();
    if (u === 'ch' || u === 'ex')   noteDep('@font-family');   // the face's metrics, inherited too
    if (CALC_FONT_UNITS.has(u))     return fontLengthToPx(n, u, emBasis(), el);
    if (CALC_VIEWPORT_UNITS.has(u)) return fontLengthToPx(n, u, 0, el);
    const abs = CSS_ABSOLUTE_UNIT_PX[u];
    return abs === undefined ? null : n * abs;             // null => unresolvable, never a guess
  };
  const out = reduceMathFunctions(value, toPx);
  if (out === 'invalid') return null;
  return CALC_NON_NEGATIVE.has(key) ? clampNonNegativePx(out) : out;
}

// A negative px RESULT in a non-negative context clamps to zero (CSS Values 4). Only a value that
// actually reduced is touched: an expression carrying a percentage or an unmodelled unit comes back
// verbatim, and rewriting a negative literal inside it changes what it means — `calc(100% -
// var(--x))` with `--x: -10px` became `calc(100% - 0px)`, i.e. `100%`, where Chrome computes
// `calc(100% + 10px)`. (An earlier comment here claimed only reduced values could be negative. It
// was wrong, and unmeasured.)
function clampNonNegativePx(value) {
  if (hasMathFunction(value)) return value;                    // never reduced — leave it alone
  return /-\d/.test(value) ? String(value).replace(/-\d*\.?\d+px\b/g, '0px') : value;
}

// The declared value the cascade and the ANIMATIONS on the element agree on. An animation
// overrides a normal declaration of any origin and loses to an `!important` one (CSS Cascade
// §6.1), so this is the layer where the two meet — and because every reader (getComputedStyle, the
// layout pass, the painter) comes through here, an animated element measures and paints where it
// actually is rather than where its stylesheet says it started.
function computeDeclaredValue(el, key, entry) {
  const base = computeCascadedValue(el, key);
  // The animation and transition properties themselves are not animatable, which is also what
  // stops this from recursing: reading `animation-name` below re-enters here and leaves at once.
  // A property that is NOT ANIMATABLE takes no part in either layer — which is a different thing
  // from one whose values can't be interpolated: that one flips discretely, this one doesn't move
  // at all (`writing-mode` and `direction` are the two the css-logical tests pin).
  const animType = ANIMATION_TYPES[key];
  if (!animType || animType === 'notAnimatable' ||
      key.startsWith('animation-') || key.startsWith('transition-')) return base;
  // Both layers behind their document-wide gates before anything is asked of the element: on a page
  // that declares neither this is two boolean reads and nothing else, which is what it has to be —
  // this is the hottest read in the driver (rule 3).
  const animations = animatedPropertiesOf(el);
  // …and the ones script started (`element.animate`), which share the animation cascade origin and
  // sort ABOVE the CSS ones — an animation with no CSS owner is later in composite order
  // (web-animations §5.4.2).
  const scripted = scriptAnimatedProperties(el);
  const transitions = documentMayTransition();
  // …and an element with a RUN of its own stays in even on a page that declares no transition any
  // more: the declaration that started it can be gone (a stylesheet removed) while the run is
  // still there to cancel.
  if (!animations && !scripted && !transitions && !el._csimTrans) return base;
  // The FLOW-RELATIVE twin is the same value under another name (`padding-left` /
  // `padding-inline-start`), and the cascade already treats the two as one — so an animation or a
  // transition declared on either spelling has to show through both, or the layout pass (which
  // reads the physical name) misses what `getComputedStyle` reports.
  const twin = twinName(el, key);
  // A value computed while THIS ELEMENT's endpoint is being resolved is its cascade's alone — the
  // transition layer is off for it, so an element whose own transition is running would report
  // where it is heading rather than where it is. That is what an after-change style IS: this
  // element's own cascade output, with inherited values taken from the parent's ALREADY
  // TRANSITIONED value.
  //
  // Per ELEMENT, not per property and not one global flag. Per property, resolving a child's
  // `font-size` endpoint suppressed the PARENT's `font-size` transition too, so the child saw the
  // parent's jump and started a run of its own where Chrome starts none; and it suppressed the
  // element's own OTHER em-sized properties, which do move with it. Globally, resolving a `1em`
  // border width read a font size with every transition switched off, which made every em-sized
  // descendant of a `font-size` transition start one (WPT properties-value-inherit-003).
  const resolving = RESOLVING_ENDPOINT.size !== 0 && RESOLVING_ENDPOINT.has(el);
  const animated = animatedOver(el, key, twin, base, animations, scripted);
  // An ANIMATION suppresses a transition of the same property outright (css-transitions §3: a
  // property being animated is not transitioned). Without this the transition layer, which sits
  // above the animation one, would transition from the pre-animation value TOWARDS the interpolated
  // one and win — Chrome-measured: 2, where that gave 1.5.
  if (animated !== base) { noteUncacheableRead(); noteAnimatedElement(el); return animated; }
  // …otherwise a TRANSITION runs over the value the element is heading for (CSS Cascade §6.1 puts
  // it above every other layer, `!important` declarations included — so unlike an animation it
  // doesn't ask about importance). `before` is what this element reported at the last style change
  // event; a difference is the change that starts one.
  if (!transitions && !el._csimTrans) return base;
  if (resolving) { noteUncacheableRead(); return base; }
  // Only an element that DECLARES a transition for this property takes part — one read of its
  // `transition-*` longhands, memoised on the entry, in place of the endpoint work below for every
  // animatable property of every element on a page that declares any transition anywhere. An
  // element with a RUNNING transition stays in even after the declaration goes: removing
  // `transition` does not cancel what is already going.
  const spec = transitionSpecOf(entry, el, key, twin);
  const running = !!el._csimTrans && el._csimTrans.runs.has(baselineKey(key, twin));
  // A property this element does not transition records nothing: what the case that needs it — the
  // transition and the change declared in one go — is measured against is the declared-value
  // memo's outgoing map, which every read fills for free. (A record made then was discarded by the
  // reader anyway, and cost a map write on every animatable-property read of every element on any
  // page that declares a transition anywhere.)
  if (!spec && !running) return base;
  // A RUNNING transition is serviced whether or not the element still declares one: with the whole
  // `transition` shorthand removed the property is covered again by the initial `all`, so the run
  // goes on — redirected if the cascade sends the property somewhere else, retired when it
  // arrives. Only starting a NEW one needs a declaration, which `startTransition` asks for itself.
  //
  // KNOWN GAP, pre-existing and not fixed here: css-transitions §3 CANCELS a run whose property
  // the after-change style's `transition-property` no longer names, and this driver keeps it —
  // Chrome-measured, `transition-property: none` mid-run empties `getAnimations()` and jumps to
  // the target, where this reports the run still going. Cancelling it here was tried and reverted:
  // the document-wide gate above is a "could anything transition", not an answer about this
  // element, and cancelling on it broke the transitions harness.
  // Both ends of a transition are COMPUTED values (css-transitions §3), and the comparison is
  // between them — not between the two declared TEXTS. `padding: 1em` does not change when
  // `font-size` does, but what it computes to doubles, and that is a change to transition. A
  // property the element does not declare has a computed value too — the one it INHERITS — so a
  // parent's change is this element's change, and the endpoint resolves it as `unset`.
  // A value that comes from the PARENT — the property undeclared and inheriting, or declared as
  // `inherit` (or `unset` on an inherited property) — is the value the parent REPORTS, its own
  // transition included, since that is what this element shows. (Resolving it through
  // `transitionEndpoint` instead reads the parent's cascade with the transition layer switched
  // off: the parent's jump would arrive here as a change, and this element would start a second
  // transition alongside its parent's.)
  // A property the cascade DECLARES nothing for arrives as null — that is a value too, the one the
  // element inherits or its initial, and a change to it is a change to transition.
  const undeclared = base == null;
  const wide = typeof base === 'string' ? base.trim().toLowerCase() : '';
  const inherited = (undeclared
    ? INHERITED_PROPERTIES.has(key)
    : wide === 'inherit' || (wide === 'unset' && INHERITED_PROPERTIES.has(key)));
  // Resolved with the transition layer ON, whichever shape it takes: a `1em` length is measured
  // against the font size the element REPORTS, and an ancestor transitioning `font-size` moves
  // that gradually. Resolving it with the layer off reads the ancestor's cascade instead — the
  // whole jump at once — and every em-sized descendant starts a transition of its own
  // (WPT properties-value-inherit-003). Each level's read is one more level up, never a sweep.
  const cmp = inherited ? cssWideEndpoint(el, key, undeclared ? 'unset' : wide)
                        : transitionEndpoint(el, key, base);
  // A property the element TRANSITIONS is never memoised: its declared text can stand still while
  // what it computes to moves — `padding-left: 1em` under a changing `font-size`, or a value the
  // parent decides — and a memo hit would skip the comparison that notices.
  //
  // It is the one real cost of this model: on a page that declares `transition: all`, EVERY
  // animatable property of those elements recomputes per read (measured: +78% on 400 such
  // elements, against −19% for a page with no transitions and no change for a page naming one
  // property). Narrowing it to the values whose computed form can actually move while their text
  // stands still is a worthwhile follow-up — it was tried here and reverted, because the record it
  // has to consult is only correct once the interactions below are pinned by their own tests.
  noteUncacheableRead();
  // EVERY animatable property records what it was, though, not only the transitioned ones: a page
  // that declares the transition and changes the value in one go is measured against the style
  // from before both, and the property was not transitioned then (Chrome-measured — this is the
  // everyday `el.style.transition = …; el.style.color = …` pair). Where there is no transition to
  // resolve an endpoint for, the DECLARED text is recorded, and the comparison below resolves it
  // only if it differs — which is where a transition might start anyway.
  let from = beforeChangeValue(el, key, twin, cmp, entry && entry.prev);
  if (from !== undefined && from !== cmp) from = transitionEndpoint(el, key, from);
  // …but a change INHERITED from an element that is transitioning the same property starts
  // nothing (css-transitions §3): the value this element reports is that transition's, arriving
  // through the computed-value reader, and a second run would go alongside it.
  if (inherited && from !== undefined && from !== cmp && ancestorTransitions(el, key, twin)) return base;
  const t = transitionedValue(el, key, twin, cmp, from, declaredValue, transitionEndpoint);
  if (t == null) return base;
  // A transitioned value is a function of the CLOCK, which no epoch tracks: keeping it in the
  // declared-value memo would freeze the transition until the next style change.
  noteUncacheableRead();
  noteAnimatedElement(el);
  return t;
}

// ── The style change event ───────────────────────────────────────────────────────────────────
// A transition is measured against what the property computed to at the LAST STYLE CHANGE EVENT,
// and a browser has one whenever the page OBSERVES style with something DIRTY since the last: a
// computed-value read, or the style flush a forced layout runs. Both halves matter. Two class
// changes in one task with nothing looking in between are ONE event — a browser measures against
// the style before both — and two reads in a row with nothing changing are one as well, or the
// second would measure against the first and never see a change at all.
//
// It cannot ride the declared-value memo's epoch, which is where it used to live: an element that
// INHERITS a changed value has no epoch movement of its own — its own declarations did not change
// — and would never be compared at all.
let STYLE_CHANGE_GEN = 0;
let STYLE_CHANGE_SEQ = -1;
function styleChangeGen() {
  const seq = currentDirtySeq();
  if (seq !== STYLE_CHANGE_SEQ) { STYLE_CHANGE_SEQ = seq; STYLE_CHANGE_GEN++; }
  return STYLE_CHANGE_GEN;
}

// What `key` computed to at the last style change event, and the recording of what it computes to
// at this one. Kept per property rather than per event: a property nobody read at the last event
// keeps the value it was last seen with, which is what it still had.
// ONE record per flow-relative PAIR, under the name the RUN itself is keyed by — the same helper,
// since `runs.has(baselineKey(...))` below depends on the two agreeing. `block-size` and `height`
// are the same value, and two records drift apart: a read under one name leaves the other stale,
// and the stale one then starts a transition from a value the element had two style changes ago
// (WPT css-logical/animation-004). Keyed by the PHYSICAL name instead, a writing-mode change
// re-pairs the logical name with a different physical one and the record splits anyway — measured
// worse on the same file.
const baselineKey = runKey;

function baselineFor(el, key, twin, value) {
  const gen = styleChangeGen();
  const store = el._csimTBase || (el._csimTBase = new Map());
  const shared = baselineKey(key, twin);
  const rec = store.get(shared);
  const before = rec === undefined ? undefined : rec.value;
  if (rec === undefined) store.set(shared, { gen, value });
  else if (rec.gen !== gen) { rec.gen = gen; rec.value = value; }
  return before;
}

// The timing this element gives this property, or null where it transitions it not at all. The
// parsed `transition-*` lists are memoised on the entry: read once per element per style epoch
// instead of once per property read — and on the ELEMENT for the ones that refuse caching (a
// slotted node, a cross-realm one), which would otherwise re-read six `transition-*` longhands per
// property per read: measured 2.2x on 500 slotted elements. Keyed by the style epoch AND the style
// change generation, so a slot reassignment (a mutation, which moves the generation) and a
// `::slotted` rule change (which moves the epoch) both invalidate it.
function transitionSpecOf(entry, el, key, twin) {
  let specs;
  if (entry) {
    if (entry.tspecs === undefined) entry.tspecs = transitionSpecs(el, declaredValue);
    specs = entry.tspecs;
  } else {
    const stamp = `${cascadeStyleEpoch()}:${styleChangeGen()}`;
    if (el._csimTSpecStamp !== stamp) {
      el._csimTSpecStamp = stamp;
      el._csimTSpecs = transitionSpecs(el, declaredValue);
    }
    specs = el._csimTSpecs;
  }
  if (!specs) return null;
  return specs.specs.get(key) || (twin ? specs.specs.get(twin) : undefined) || specs.all || null;
}

// Whether an ANCESTOR is transitioning this property right now — the case where an inherited value
// changes because that transition is running, rather than because the cascade moved.
function ancestorTransitions(el, key, twin) {
  // The FLAT tree, which is what style inherits through: a shadow child's values come from its
  // HOST, and walking `_parent` stops at the shadow root.
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    const runs = p._csimTrans && p._csimTrans.runs;
    if (runs && (runs.has(key) || (twin && runs.has(twin)))) return true;
  }
  return false;
}

// What the property reported at the last style change event, and the recording of what it reports
// at this one — or `undefined` where it has reported nothing yet. A NOT-RENDERED element has no
// computed style for a transition to be measured against (css-transitions §3), so one that appears
// transitions from nothing: the event in which it is first read while rendered establishes the
// baseline, and only a change after THAT transitions.
function beforeChangeValue(el, key, twin, value, fallback) {
  if (!(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) {
    el._csimNoBaseline = true;
    el._csimTBase = null;
    return undefined;
  }
  const before = baselineFor(el, key, twin, value);
  if (el._csimNoBaseline) { el._csimNoBaseline = false; return undefined; }
  // The declared value the memo carried out of the LAST EPOCH wins where it has one: it is the
  // value this element's own declarations had one style change ago, which is fresher than a record
  // that may predate a change nothing read. The record covers what the memo cannot — a property
  // whose transition made it uncacheable, and a value that came from the parent.
  if (fallback) {
    const own = fallback.get(key);
    const carried = own !== undefined || !twin ? own : fallback.get(twin);
    if (carried !== undefined) return carried;
  }
  return before;
}

// One end of a transition, computed: the declared value where there is one, and what `unset`
// computes to where there is not.
//
// Resolving one must NOT re-enter the transition layer. For an INHERITED property the `unset`
// fallback reads the parent's computed value, whose own read would start a transition, whose
// endpoint would read the grandparent's — a chain up the tree that recurses once per level per
// level, and blew the stack on the pages that transition everything. The endpoints are the
// CASCADE's values; a transition running on an ancestor is not part of what this one starts from.
const RESOLVING_ENDPOINT = new Set();
function transitionEndpoint(el, key, declared) {
  const outer = RESOLVING_ENDPOINT.has(el);
  RESOLVING_ENDPOINT.add(el);
  try {
    return animationEndpoint(el, key, declared) ?? cssWideEndpoint(el, key, 'unset');
  } finally {
    if (!outer) RESOLVING_ENDPOINT.delete(el);
  }
}

// The animation layer alone: the interpolated value where one is running, the cascade's otherwise.
function animatedOver(el, key, twin, base, props, scripted) {
  const targetsCss = props && (props.has(key) || (twin && props.has(twin)));
  const targetsScript = scripted && (scripted.has(key) || (twin && scripted.has(twin)));
  if (!targetsCss && !targetsScript) return base;
  if (cascadedIsImportant(el, key)) return base;
  // The UNDERLYING value a neutral keyframe contributes. A property the cascade doesn't declare
  // still has one — what `unset` computes to — and without it a `@keyframes { 50% { … } }`, the
  // commonest keyframe shape there is, reported its one keyframe at every moment instead of
  // interpolating out of the value the element actually has.
  const under = animationEndpoint(el, key, base) ?? cssWideEndpoint(el, key, 'unset');
  // The answer depends on the CLOCK from here on, whether or not an animation is in effect at this
  // instant: one that has not started yet will be, and a value cached now would still be here then.
  noteUncacheableRead();
  let v = targetsCss ? animatedValue(el, key, twin, under, declaredValue, animationEndpoint) : null;
  // A script-driven animation runs OVER whatever the CSS one produced, since it sorts above it —
  // and takes that as its own underlying value, which is what a partial keyframe list composes with.
  if (targetsScript) {
    const over = scriptAnimatedValue(el, key, twin, v == null ? under : v, animationEndpoint);
    if (over != null) v = over;
  }
  if (v != null) noteAnimatedElement(el);
  return v == null ? base : v;
}

// Which properties the element's own animations declare, memoised for as long as the cascade and
// the element's structural context both hold still — the same key `allRecord` uses. Without it
// every declared-value read on an animated page rebuilt the element's animation list (rule 3).
function animatedPropertiesOf(el) {
  if (!documentHasKeyframes()) return null;          // the O(1) gate first: no page-wide keyframes,
  const key = `${cascadeStyleEpoch()}:${ctxEpochOf(el)}`;   // …nothing to memoise a key for
  if (el._csimAnimPropsKey !== key) {
    el._csimAnimPropsKey = key;
    el._csimAnimProps = animatedProperties(el, declaredValue);
  }
  return el._csimAnimProps;
}

// One end of an interpolation, in the element's own context: a keyframe's declared text with its
// `var()`s substituted, its maths reduced, its font-relative lengths turned into the px the other
// end is written in, and a colour in the canonical form the interpolator reads. The UNDERLYING
// value goes through the same funnel, so a neutral keyframe and a declared one are comparable.
function animationEndpoint(el, key, declared) {
  if (declared == null) return null;
  // A shadow or filter endpoint costs a serializer pass of its own, and an animating element is
  // asked for the same two endpoints on every read of the property. The answer is a pure function
  // of the element's style, so it rides the DECLARED-VALUE memo — with the two inputs that memo
  // does NOT track in the key: the element's own colour (which `currentcolor` and an omitted
  // shadow colour resolve to) and its font size (which an `em` length resolves against), both of
  // which may be INHERITED, and a parent's inline style moves neither epoch.
  //
  // A value the PARENT decides outright is not cacheable at all: a CSS-wide keyword reads the
  // parent's computed value, and a `var()` reference a custom property the parent may hold — the
  // memo has no dependency edge for either (WPT `box-shadow-responsive.html` is exactly this: the
  // keyframe says `inherit` and the test then rewrites the parent's style).
  const type = ANIMATION_TYPES[key];
  if (type !== 'shadowList' && type !== 'filterList') return computeAnimationEndpoint(el, key, declared);
  const text = String(declared);
  const entry = CSS_WIDE_KEYWORDS.has(text.trim().toLowerCase()) ||
                text.indexOf('var(') !== -1 || FONT_RELATIVE_RE.test(text)
    ? null : declaredValueEntry(el);
  if (entry === null) return computeAnimationEndpoint(el, key, declared);
  const cacheKey = `${key}|${text}`;
  const ends = entry.ends || (entry.ends = new Map());
  const hit = ends.get(cacheKey);
  // A cached endpoint that RESOLVED a colour is only good while that colour is: the read is paid
  // for those and skipped for the rest, which is most of them.
  if (hit !== undefined && (hit.color === null || hit.color === readComputed(el, 'color').value)) return hit.out;
  let color = null;
  const out = computeAnimationEndpoint(el, key, declared, () => (color = readComputed(el, 'color').value));
  ends.set(cacheKey, { out, color });
  return out;
}
// A length the element's own font decides. `rem` and `rlh` are the ROOT's, which no epoch here
// tracks either, so they are equally uncacheable. A VIEWPORT unit is deliberately absent: resizing
// rebuilds the cascade (`Browser#set_viewport`), which moves the epoch this memo already rides.
const FONT_RELATIVE_RE = /\d\s*(?:r?em|ex|ch|cap|ic|r?lh)\b/i;

function computeAnimationEndpoint(el, key, declared, ownColorFn = () => readComputed(el, 'color').value) {
  // A keyframe may name a CSS-WIDE KEYWORD, which is a value to compute rather than a value to
  // interpolate: `from { flex-grow: inherit }` animates from whatever the parent computes.
  const wide = String(declared).trim().toLowerCase();
  if (CSS_WIDE_KEYWORDS.has(wide)) return cssWideEndpoint(el, key, wide);
  const resolved = resolveMath(el, key, resolveCssVars(el, declared));
  if (resolved == null) return null;
  const text = String(resolved).trim();
  if (!text || hasSubstitution(text)) return null;
  const px = fontRelativeToPx(el, text);
  if (px != null) return formatPx(px);
  const out = serializeCssValue(text);
  const type = ANIMATION_TYPES[key];
  if (type === 'color') return normalizeColor(out);
  // A LIST-valued type goes through the PROPERTY'S OWN computed-value serializer, the same one a
  // cascaded value takes: the two ends of an interpolation have to be written the same way before
  // they can be mixed — `currentcolor` resolved to the element's colour, a length in px, an angle
  // in degrees — and a keyframe never passes through that reader on its own.
  if (type === 'shadowList') {
    return serializeShadow(out, SHADOW_LENGTHS[key], ownColorFn, el, key === 'box-shadow');
  }
  if (type === 'filterList') return serializeFilter(out, ownColorFn, el);

  // A transform's PERCENTAGES resolve against the element's own border box, and the two ends may
  // not be written in the same unit — `translateX(20px)` to `translateX(50%)` is a real
  // interpolation in Chrome, not a discrete flip — so they are resolved here, where the box is.
  if (type === 'transform' && out.indexOf('%') !== -1) return resolveTransformPercentages(out, el);
  return out;
}

// Every translate argument written as a percentage, in px. Only the translations resolve against
// the box; a `scale(50%)` is a plain factor and a `translateZ(50%)` has nothing to resolve
// against at all (both are left as written, for `transformMatrix` to read).
const TRANSLATE_FN_RE = /\b(translate|translatex|translatey|translate3d)\(([^()]*)\)/gi;
function resolveTransformPercentages(text, el) {
  let box = null;
  const boxFn = () => (box || (box = borderBoxOf(el)));
  return text.replace(TRANSLATE_FN_RE, (whole, name, args) => {
    const parts = splitTopLevel(args, ',').map((a) => a.trim());
    const out = parts.map((arg, i) => {
      // `translateY` is the Y axis whichever position its argument sits in; every other
      // translation takes X first — and a `translate3d`'s THIRD argument is the Z axis, which a
      // percentage does not resolve against at all (it makes the whole transform invalid, which
      // `transformMatrix` decides).
      if (arg.indexOf('%') === -1 || i > 1) return arg;
      const px = lengthPx(arg, boxFn, name.toLowerCase() === 'translatey' || i === 1 ? 'y' : 'x');
      return px == null ? arg : `${Math.round(px * 1e4) / 1e4}px`;
    });
    return `${name}(${out.join(', ')})`;
  });
}

// What a CSS-wide keyword computes to for this element: the parent's value where it inherits, the
// UA's where `revert` rolls back to it, and the property's initial otherwise — the same three
// origins `readComputedGeneric` consults when the CASCADE produces one of these keywords, reached
// here because a KEYFRAME can name one too (`from { flex-grow: inherit }`) and a keyframe value
// never passes through that reader.
function cssWideEndpoint(el, key, wide) {
  const inherits = wide === 'inherit' ||
                   (wide !== 'initial' && INHERITED_PROPERTIES.has(key));
  if (inherits) {
    // …from the FLAT-tree parent: a shadow child inherits from its host, and every undeclared
    // inherited property now comes through here, so the wrong parent is load-bearing on any page
    // with a shadow tree.
    const parent = flatTreeParent(el);
    if (parent && parent.nodeType === NODE_ELEMENT) return readComputed(parent, key).value;
  } else if (wide === 'revert' || wide === 'revert-layer') {
    const ua = uaDefault(el, key);
    if (ua !== undefined) return animationEndpoint(el, key, ua);
  }
  return computedInitialValue(key, el);
}

function computeCascadedValue(el, key) {
  const raw = cascadedProperty(el, key);
  if (raw == null) return null;
  const src = pendingSource(raw);
  if (!src) {
    const v = resolveMath(el, key, resolveCssVars(el, raw));
    if (v == null) return null;
    // `v === raw` is the no-substitution fast path — this is the hottest read in the driver, so the
    // regex only runs on a value that actually held one. It also returns the author's text as-is:
    // canonicalisation of a plain declared value is each reader's business, exactly as before.
    if (v === raw) return v;
    // A substitution that resolves to NOTHING is as invalid as one that doesn't resolve: an
    // undefined `var()` collapses to the empty string, and `margin-left: var(--bogus)` computes
    // `0px` in Chrome (measured) — the same `unset` the shorthand form takes. Returning '' let the
    // px-reportable branch treat it as a declared value and fall back to the author text.
    if (!String(v).trim() || hasSubstitution(v)) return null;
    // What a substitution PRODUCES is canonicalised, because the readers downstream match against
    // canonical forms: `--x: .5px` must report `0.5px` like the literal does, and `--a: +20px` fails
    // the px-reportable regex outright — which dropped the read all the way back to the author text.
    // A CUSTOM property is exempt: its computed value is a token sequence, not a parsed value, and
    // Chrome hands back exactly what was written (`.5px`, `url(a.png)`, `10PX` — measured). Only the
    // INDIRECTED form (`--a: var(--b)`) reaches here, so canonicalising it made a design token read
    // differently depending on whether it was written literally or through another token.
    return key.startsWith('--') ? v : serializeCssValue(v);
  }
  const resolved = String(resolveCssVars(el, src.value)).trim();
  if (!resolved || hasSubstitution(resolved)) return null;
  const pairs = expandedPending(src.shorthand, resolved);
  if (!pairs) return null;
  // The slot may have been won by `key`'s FLOW-RELATIVE twin — `margin-block-start` reads
  // `margin-top`'s pending slot, and the shorthand expands physically — so look the twin up too,
  // exactly as `cascadedProperty` did to hand us this value in the first place.
  const twin = twinName(el, key);
  const hit = pairs.find(([lh]) => lh === key) || (twin ? pairs.find(([lh]) => lh === twin) : null);
  if (!hit) return null;
  // A component of the expanded shorthand can itself be a math function (`margin: var(--m)` where
  // `--m: calc(1px + 1px) 2px`), so it goes through the same reduction.
  const component = resolveMath(el, key, splitImportant(String(hit[1])).value);
  return component == null ? null : serializeCssValue(component);
}

// Extracts the parenthesised body of a `var(...)` starting at `i`
// (the char after the `(`). Returns `{ body, end }` where `end`
// points past the closing `)`, or null if unbalanced.
function sliceBalanced(s, i) {
  let depth = 1;
  const start = i;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { body: s.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function topLevelComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

// Canonicalise color values to the `rgb(...)` / `rgba(...)` form real browsers
// return from `getComputedStyle(...).color`. culori (the vendored CSS Color 4
// parser) does the heavy lifting — named colours, `rgb()`/`hsl()` in every
// legacy/modern syntax, percentages, etc. all fold to the canonical sRGB
// serialization. An explicit non-sRGB colour space (`color(display-p3 …)`,
// `lab()`, `oklch()`, …) is PRESERVED verbatim, matching browsers; an
// unparseable value also passes through unchanged.
//
// The `#rrggbb`-family hex fast-paths stay ahead of culori: they're cheap and,
// more importantly, keep this function working during the V8 snapshot build
// (when `__csimVendor` isn't wired yet) — likewise the small `NAMED_COLORS`
// fallback below.
export function normalizeColor(value) {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  let m = v.match(/^#([0-9a-fA-F]{8})$/);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = parseInt(m[1].slice(6, 8), 16) / 255;
    return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
  }
  m = v.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
  }
  m = v.match(/^#([0-9a-fA-F]{4})$/);
  if (m) {
    const c = m[1];
    const r = parseInt(c[0] + c[0], 16);
    const g = parseInt(c[1] + c[1], 16);
    const b = parseInt(c[2] + c[2], 16);
    const a = parseInt(c[3] + c[3], 16) / 255;
    return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
  }
  m = v.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const c = m[1];
    const r = parseInt(c[0] + c[0], 16);
    const g = parseInt(c[1] + c[1], 16);
    const b = parseInt(c[2] + c[2], 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const vend = globalThis.__csimVendor && globalThis.__csimVendor.color;
  if (vend && typeof vend.computed === 'function') {
    try {
      const c = vend.computed(v);
      if (c) return c;
    } catch (_) { /* fall through to the static fallback */ }
  }
  const named = NAMED_COLORS[v.toLowerCase()];
  if (named) return named;
  // CSS system colors (Menu / ButtonFace / Canvas …) resolve to a UA sRGB value the
  // color libs don't know — map to hex, then reuse the hex→rgb path above.
  const sys = SYSTEM_COLORS[v.toLowerCase()];
  if (sys) return normalizeColor(sys);
  return v;
}

// getComputedStyle reports the color stops inside a gradient in resolved rgb()/rgba() form
// (`linear-gradient(red, blue)` → `linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))`), while
// leaving directions / angles / shapes / positions untouched. `currentColor` resolves to the
// element's used color. Non-gradient parts of the value (a `url(...)` layer) pass through.
function normalizeGradientColors(value, currentColor) {
  if (typeof value !== 'string' || value.toLowerCase().indexOf('gradient(') === -1) return value;
  const FN = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
  let out = '', last = 0, m;
  while ((m = FN.exec(value))) {
    const open = m.index + m[0].length;
    let depth = 1, j = open;                                 // scan to the matching close paren
    for (; j < value.length; j++) {
      const ch = value[j];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    out += value.slice(last, m.index) + m[0] + normalizeGradientArgs(value.slice(open, j), currentColor) + ')';
    last = j + 1;
    FN.lastIndex = last;                                      // resume past this gradient; recursion handles nesting
  }
  return out + value.slice(last);
}

// Normalize the color token of each comma-separated gradient argument (a color stop, direction,
// shape, or position). `normalizeColor` returns a non-color token unchanged, so only actual colors
// are rewritten; a nested gradient (e.g. inside `cross-fade`) is handled recursively.
function normalizeGradientArgs(inner, currentColor) {
  return splitTopLevel(inner, ',').map((arg) =>
    splitTopLevel(arg.trim(), ' ').map((tok) => {
      const t = tok.trim();
      if (!t) return t;
      if (/^currentcolor$/i.test(t)) return currentColor;
      if (/gradient\(/i.test(t)) return normalizeGradientColors(t, currentColor);
      return normalizeColor(t);
    }).filter(Boolean).join(' ')
  ).join(', ');
}

// Per-side + logical border color longhands, resolved through the uniform `border-color`
// when the side has no value of its own (per-side capture from stylesheets isn't modelled).
const BORDER_SIDE_COLOR_RE = /^border-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)-color$/;
const BORDER_SIDE_WIDTH_RE = /^border-(top|right|bottom|left)-width$/;

// Expand a cascaded border shorthand (`border` / `border-top` / `border-width` / `border-style`)
// to a { longhand: value } map, or null when unset / unparseable.
function borderShorthandMap(el, name) {
  const v = declaredValue(el, name);
  if (v == null || v === '') return null;
  const pairs = shorthandExpand(name, String(v));
  if (!pairs) return null;
  const m = {};
  for (const [lh, val] of pairs) m[lh] = stripImportant(String(val));
  return m;
}
// The uniform (all-side) border-width/style sources, expanded once — shared across the four sides
// when resolving the `border-width` shorthand so they aren't re-expanded per side.
function borderSharedSources(el) {
  return {
    bw:   borderShorthandMap(el, 'border-width'),
    bst:  borderShorthandMap(el, 'border-style'),
    ball: borderShorthandMap(el, 'border'),
  };
}
// Effective computed border WIDTH + STYLE for one physical side. Checks sources most-specific
// first — the per-side longhand, the `border-{side}` shorthand, the uniform `border-width` /
// `border-style`, then the `border` mega-shorthand — taking the first that sets each. Mirrors the
// border-*-color resolution: exact for the uniform cases getComputedStyle reports; it does not
// fully model the cross-shorthand cascade source order. `shared` reuses pre-expanded uniform
// sources (borderSharedSources) when resolving all four sides at once.
function resolveBorderSide(el, side, shared) {
  const s = shared || borderSharedSources(el);
  let width = null, style = null;
  const take = (w, st) => {
    if (width == null && w != null && w !== '') width = String(w);
    if (style == null && st != null && st !== '') style = String(st);
  };
  take(declaredValue(el, `border-${side}-width`), declaredValue(el, `border-${side}-style`));
  const bside = borderShorthandMap(el, `border-${side}`);
  if (bside) take(bside[`border-${side}-width`], bside[`border-${side}-style`]);
  take(s.bw && s.bw[`border-${side}-width`], s.bst && s.bst[`border-${side}-style`]);
  if (s.ball) take(s.ball[`border-${side}-width`], s.ball[`border-${side}-style`]);
  // The UA sheet sits below every author source and above the initial value, and it carries real
  // geometry — a control's border is part of its box, so this fallback is what layout measures.
  // Asked for LAST and only when something is still missing: `uaDefault` is cheap but this runs on
  // all four sides of every box in a layout pass.
  if (width == null || style == null) {
    take(uaDefault(el, `border-${side}-width`), uaDefault(el, `border-${side}-style`));
  }
  return { width, style };
}
// The computed `border-*-width` for a resolved width + style: 0 when the border-style is
// none/hidden, else the width (thin/medium/thick keyword → length; unitless 0 → 0px; absent →
// the initial `medium`).
function computedBorderWidth(width, style) {
  const st = (style || 'none').toLowerCase();
  if (st === 'none' || st === 'hidden') return '0px';
  if (width == null) return '3px';                       // initial 'medium'
  const lw = width.toLowerCase();
  if (BORDER_WIDTH_KEYWORDS[lw]) return BORDER_WIDTH_KEYWORDS[lw];
  if (/^0+(\.0+)?$/.test(lw)) return '0px';
  return width;
}

// Snapshot-build fallback: a CSS named-color subset mapped to canonical
// `rgb(...)` strings, used only when the culori-backed `__csimVendor.color`
// surface isn't available (e.g. during the V8 snapshot build). At runtime
// culori handles the full named-colour set; expand this on demand.
const NAMED_COLORS = {
  transparent: 'rgba(0, 0, 0, 0)',
  black: 'rgb(0, 0, 0)',
  white: 'rgb(255, 255, 255)',
  red: 'rgb(255, 0, 0)',
  green: 'rgb(0, 128, 0)',
  blue: 'rgb(0, 0, 255)',
  yellow: 'rgb(255, 255, 0)',
  cyan: 'rgb(0, 255, 255)',
  magenta: 'rgb(255, 0, 255)',
  gray: 'rgb(128, 128, 128)',
  grey: 'rgb(128, 128, 128)',
  silver: 'rgb(192, 192, 192)',
  maroon: 'rgb(128, 0, 0)',
  olive: 'rgb(128, 128, 0)',
  lime: 'rgb(0, 255, 0)',
  aqua: 'rgb(0, 255, 255)',
  teal: 'rgb(0, 128, 128)',
  navy: 'rgb(0, 0, 128)',
  fuchsia: 'rgb(255, 0, 255)',
  purple: 'rgb(128, 0, 128)',
  orange: 'rgb(255, 165, 0)'
};

// Layout / geometry computed values require a real layout engine and are
// out of scope: leave them to the inline-style fallback (empty) rather
// than fabricating numbers.
const LAYOUT_COMPUTED_PROPS = new Set([
  'width','height','top','right','bottom','left','inline-size','block-size',
  'min-width','min-height','max-width','max-height',
  'margin','margin-top','margin-right','margin-bottom','margin-left',
  'padding','padding-top','padding-right','padding-bottom','padding-left',
  'border-top-width','border-right-width','border-bottom-width',
  'border-left-width',
]);
// Box-model lengths whose COMPUTED value equals the specified length when the cascade resolves
// them to a concrete px (used == specified, no layout): the sizing + per-side margin/padding
// longhands, and the insets. Percentages / auto / calc still fall through to the layout gate
// above — that is where an inset's used value really is layout-dependent (`position: absolute;
// top: auto` reports the box's static position). A DEFINITE inset is reported as written in every
// case measured: static, relative, absolute, and over-constrained (`left: 10px; right: 10px;
// width: 50px` reports both sides, not the resolved one). Border widths stay excluded — theirs
// depends on `border-style`, which the per-side branch above handles.
// The `<time>`-valued longhands: each is a comma-separated list, one entry per transition or
// animation layer.
const TIME_VALUED_PROPS = new Set(['animation-duration', 'animation-delay', 'transition-duration', 'transition-delay']);
const MS_RE = /^(-?\d*\.?\d+)ms$/i;
function secondsList(value) {
  return value.split(',').map((part) => {
    const t = part.trim();
    const m = MS_RE.exec(t);
    if (m) return `${Number((parseFloat(m[1]) / 1000).toFixed(6))}s`;
    // A bare `0` is not a valid <time>, but a number with no unit reads as seconds everywhere else
    // we normalise, and Chrome reports the initial as `0s`.
    if (/^-?\d*\.?\d+$/.test(t)) return `${Number(t)}s`;
    return t;
  }).join(', ');
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
]);
// `border-width` keyword → computed length (medium is the initial).
const BORDER_WIDTH_KEYWORDS = { thin: '1px', medium: '3px', thick: '5px' };

// The initial value a resolved-value read reports where the COMPUTED value differs from the
// specified initial mdn-data records (INITIAL_VALUES): a colour computes to its rgb()/rgba()
// form, `font-weight: normal` to its numeric weight. The rest —
// the shorthands mdn omits from the longhand set (`overflow` / `text-decoration` /
// `background-position`) — have no generated entry at all, so they're listed rather than
// overridden.
// Prototype-less for the same reason INITIAL_VALUES is: the lookup key is a property name from
// page script, and `overrides['constructor']` must be a miss, not Object's constructor.
const COMPUTED_INITIAL_OVERRIDES = Object.assign(Object.create(null), {
  'font-weight': '400', 'color': 'rgb(0, 0, 0)',
  'background-color': 'rgba(0, 0, 0, 0)', 'background-size': 'auto',
  'background-position': '0% 0%',
  'overflow': 'visible',
  // `auto` on either of these means the element's own colour, which is what Chrome reports
  // (measured: an element with `color: rgb(0, 128, 0)` gives that for both).
  'outline-color': 'currentcolor', 'caret-color': 'currentcolor',
  // mdn's specified initial is `normal`; the computed value is a length (Chrome: `0px`).
  'word-spacing': '0px',
  // The `min-*` pair is NOT here: mdn says `auto`, and what that computes to depends on the
  // element (`automaticMinSize`), so it can't be a constant.
});
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

// `transform` is reported as the composed MATRIX, never as the author's function list (Chrome
// measured: `translateX(10px)` → `matrix(1, 0, 0, 1, 10, 0)`, and a 3D component escalates the
// whole thing to `matrix3d`). Page code parses that form to read a translation back out, so the
// function list is not a substitute.
const DEG = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
function angleDeg(tok) {
  const m = /^([+-]?[\d.]+)(deg|grad|rad|turn)?$/i.exec(String(tok == null ? '' : tok).trim());
  if (!m) return null;
  // Only a ZERO may omit its unit; `rotate(1)` is an invalid declaration, not one degree.
  if (!m[2] && parseFloat(m[1]) !== 0) return null;
  return parseFloat(m[1]) * (DEG[(m[2] || 'deg').toLowerCase()] || 1);
}
// A translate component in px. A PERCENTAGE resolves against the element's own border box, which
// is what makes `translate(-50%, -50%)` — the centring idiom — a real offset rather than zero.
// Anything else (em, calc) has no answer here; the caller reports the author's value instead of a
// matrix that would be wrong.
function lengthPx(tok, boxFn, axis) {
  const t = String(tok).trim();
  const px = /^([+-]?[\d.]+)(px)?$/i.exec(t);
  if (px) return parseFloat(px[1]);
  const pct = /^([+-]?[\d.]+)%$/.exec(t);
  if (!pct) return null;
  // The box is fetched ONLY here — resolving it eagerly ran a layout pass on every
  // `getComputedStyle(el).transform`, which is a walk Floating UI does per ancestor.
  const box = boxFn();
  return box ? parseFloat(pct[1]) / 100 * (axis === 'x' ? box.width : box.height) : null;
}
// 2D affine [a, b, c, d, e, f], composed left-to-right as CSS does.
function multiply2d(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const finite = (n) => Number.isFinite(n);
// A scale takes a NUMBER or a percentage — `scale(50%)` is 0.5, and `parseFloat` alone strips the
// `%` and hands page code a 100x factor. Anything else is an invalid declaration.
function scaleFactor(tok) {
  const t = String(tok == null ? '' : tok).trim();
  const pct = /^([+-]?[\d.]+)%$/.exec(t);
  if (pct) return parseFloat(pct[1]) / 100;
  const n = /^[+-]?[\d.]+$/.test(t) ? parseFloat(t) : NaN;
  return Number.isFinite(n) ? n : null;
}
// A Z translation takes a <length> ONLY: a percentage has nothing to resolve against, and makes
// the whole `transform` invalid (Chrome measured — `translateZ(50%)` reports `none`, it does not
// resolve against the height). NaN says invalid; null says a length we can't resolve here.
function zLengthPx(tok) {
  const t = String(tok == null ? '' : tok).trim();
  if (/%$/.test(t)) return NaN;
  const px = /^([+-]?[\d.]+)(px)?$/i.exec(t);
  return px ? parseFloat(px[1]) : null;
}
function transformMatrix(value, boxFn) {
  const v = String(value).trim();
  if (!v || /^none$/i.test(v)) return 'none';
  let m = [1, 0, 0, 1, 0, 0];
  let z = 0;
  const FN = /([a-z0-9]+)\(([^()]*)\)/gi;
  let match, seen = false;
  while ((match = FN.exec(v))) {
    seen = true;
    const name = match[1].toLowerCase();
    const args = match[2].split(',').map(t => t.trim()).filter(Boolean);
    const num = i => parseFloat(args[i]);
    switch (name) {
      case 'translate': {
        const tx = lengthPx(args[0], boxFn, 'x'), ty = args.length > 1 ? lengthPx(args[1], boxFn, 'y') : 0;
        if (tx == null || ty == null) return v;                // unresolvable — don't invent a matrix
        m = multiply2d(m, [1, 0, 0, 1, tx, ty]);
        break;
      }
      case 'translatex': { const t = lengthPx(args[0], boxFn, 'x'); if (t == null) return v; m = multiply2d(m, [1, 0, 0, 1, t, 0]); break; }
      case 'translatey': { const t = lengthPx(args[0], boxFn, 'y'); if (t == null) return v; m = multiply2d(m, [1, 0, 0, 1, 0, t]); break; }
      case 'translatez': { const t = zLengthPx(args[0]); if (Number.isNaN(t)) return 'none'; if (t == null) return v; z += t; break; }
      // `translate3d(x, y, 0)` — the GPU-compositing idiom — is a plain 2D matrix in Chrome, so it
      // composes like `translate` and only the Z component decides whether the result escalates.
      case 'translate3d': {
        if (args.length !== 3) return 'none';
        const tz = zLengthPx(args[2]);
        if (Number.isNaN(tz)) return 'none';
        const tx = lengthPx(args[0], boxFn, 'x'), ty = lengthPx(args[1], boxFn, 'y');
        if (tx == null || ty == null || tz == null) return v;
        m = multiply2d(m, [1, 0, 0, 1, tx, ty]);
        z += tz;
        break;
      }
      case 'scale': {
        const sx = scaleFactor(args[0]), sy = args.length > 1 ? scaleFactor(args[1]) : sx;
        if (sx == null || sy == null) return 'none';
        m = multiply2d(m, [sx, 0, 0, sy, 0, 0]); break;
      }
      case 'scalex': { const f = scaleFactor(args[0]); if (f == null) return 'none'; m = multiply2d(m, [f, 0, 0, 1, 0, 0]); break; }
      case 'scaley': { const f = scaleFactor(args[0]); if (f == null) return 'none'; m = multiply2d(m, [1, 0, 0, f, 0, 0]); break; }
      case 'rotate': case 'rotatez': {
        const deg = angleDeg(args[0]);
        if (deg == null) return 'none';                        // `rotate(1)` is not a valid angle
        const r = deg * Math.PI / 180;
        m = multiply2d(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        break;
      }
      case 'skew': {
        const ax = angleDeg(args[0]), ay = args.length > 1 ? angleDeg(args[1]) : 0;
        if (ax == null || ay == null) return 'none';
        m = multiply2d(m, [1, Math.tan(ay * Math.PI / 180), Math.tan(ax * Math.PI / 180), 1, 0, 0]); break;
      }
      case 'skewx': { const a = angleDeg(args[0]); if (a == null) return 'none'; m = multiply2d(m, [1, 0, Math.tan(a * Math.PI / 180), 1, 0, 0]); break; }
      case 'skewy': { const a = angleDeg(args[0]); if (a == null) return 'none'; m = multiply2d(m, [1, Math.tan(a * Math.PI / 180), 0, 1, 0, 0]); break; }
      case 'matrix': {
        const a = args.map(parseFloat);
        if (a.length !== 6 || !a.every(finite)) return 'none';   // an invalid declaration is dropped
        m = multiply2d(m, a);
        break;
      }
      // Anything with a genuine 3D component (`matrix3d`, `rotate3d`, `perspective`) needs the
      // full 4x4; we don't model it, so the author's value is reported unchanged rather than a
      // matrix that would be wrong.
      default: return v;
    }
  }
  if (!seen) return v;
  // Six SIGNIFICANT digits, which is what a browser reports — `Math.sqrt(2)` is `1.41421`, not
  // `1.414214` (rounding to six DECIMAL places agreed only for components below 1). A value that
  // is only floating-point noise is zero: `cos(90deg)` is 6.1e-17, and Chrome prints `0`.
  const round = n => {
    if (!Number.isFinite(n)) return 0;
    if (Math.abs(n) < 1e-6) return 0;
    const r = parseFloat(n.toPrecision(6));
    return Object.is(r, -0) ? 0 : r;
  };
  // Only a NON-ZERO Z escalates to the 4x4 form: `translateZ(0)` reports `matrix(1, 0, 0, 1, 0, 0)`
  // in Chrome, which is what makes the compositing hint invisible to page code reading a matrix.
  return z !== 0
    ? `matrix3d(${[m[0], m[1], 0, 0, m[2], m[3], 0, 0, 0, 0, 1, 0, m[4], m[5], z, 1].map(round).join(', ')})`
    : `matrix(${m.map(round).join(', ')})`;
}

// A token SHAPED like a length: a number with an optional unit or percent sign. One that is
// shaped like a length but isn't a valid one here makes the whole declaration invalid, so the two
// tests are separate — this one decides "the author meant a length", `shadowLengthPx` decides
// whether it is one.
const SHADOW_NUMERIC_RE = /^[+-]?[\d.]+[a-z%]*$/i;
// The length forms a shadow accepts: an optionally-signed number with an absolute, font-relative
// or viewport unit — plus a bare `0`. A PERCENTAGE is deliberately absent: it is not a valid
// shadow length at all, and Chrome drops the whole declaration for one.
const SHADOW_LENGTH_RE = /^([+-]?[\d.]+)(px|em|rem|ex|ch|pt|pc|in|cm|mm|q|vh|vw|vmin|vmax)?$/i;
// A SHADOW is reported colour-first, with every omitted length filled in (Chrome measured:
// `0 0 4px red` → `rgb(255, 0, 0) 0px 0px 4px 0px`; `text-shadow` has no spread, so three).
// A shadow length is reported as the USED value, so `1em` on a 16px element is `16px` and `2vw` on
// a 780px viewport is `15.6px` — the colour-first form exists to be parsed, and an unresolved unit
// in it defeats that. Returns null for a token that is no valid length.
function shadowLengthPx(tok, el) {
  const m = SHADOW_LENGTH_RE.exec(String(tok).trim());
  if (!m) return null;                                   // a percentage, or an unknown unit
  const n = parseFloat(m[1]);
  if (!m[2] && n !== 0) return null;                     // only a ZERO may omit its unit
  const px = fontLengthToPx(n, (m[2] || 'px').toLowerCase(), computedFontSizePx(el), el);
  return `${Math.round(px * 1e4) / 1e4}px`;
}

// The element's own colour arrives as a FUNCTION: most shadows name their colour outright, and
// resolving one that is never asked for costs an inherited computed read per shadow read.
//
// Returns null when a layer is INVALID — a length that is no length, one length too many, or an
// `inset` where the property's grammar has none — which drops the declaration, and the caller then
// reports the property's initial, as a browser does (Chrome-measured: a `text-shadow` with four
// lengths, or with `inset`, computes to `none`). A token we merely can't model (a `calc()`) still
// reports the author's value unchanged.
function serializeShadow(value, lengths, ownColorFn, el, insetOk) {
  const out = [];
  for (const layer of splitValues(value, ',')) {
    const toks = splitValues(layer, ' ');
    if (!toks.length) return value;
    let inset = false, color = null;
    const nums = [];
    for (const tok of toks) {
      if (/^inset$/i.test(tok)) {
        if (!insetOk) return null;                       // only a `box-shadow` is ever inset
        inset = true;
        continue;
      }
      // Meant as a length, but not a valid one (a percentage, a bare non-zero number, an unknown
      // unit) → the declaration is invalid whole, which is what a browser does with it.
      if (SHADOW_NUMERIC_RE.test(tok)) {
        const len = shadowLengthPx(tok, el);
        if (len === null) return null;
        nums.push(len);
        continue;
      }
      // `currentcolor` — written out or omitted — is the element's own colour, and a resolved
      // value never reports the keyword (Chrome-measured: `box-shadow: currentcolor 10px 10px`
      // computes to `rgb(0, 255, 0) 10px 10px 0px 0px` on a green-texted element).
      const c = /^currentcolor$/i.test(tok) ? ownColorFn() : normalizeColor(tok);
      if (/^rgba?\(/.test(c)) { color = c; continue; }
      return value;                              // something we don't model — report it as written
    }
    if (nums.length < 2) return value;
    if (nums.length > lengths) return null;              // more lengths than the property takes
    while (nums.length < lengths) nums.push('0px');
    // An omitted colour is `currentcolor`, and a resolved value never reports that keyword — the
    // colour-first form exists so a downstream parser can read one, so it has to be there.
    out.push([color || ownColorFn(), ...nums, inset ? 'inset' : null].filter(Boolean).join(' '));
  }
  return out.join(', ');
}

// The computed form of a `filter` / `backdrop-filter` list: every function's argument in its
// canonical unit — an angle in degrees, a proportion as a plain number, a blur radius in px — and
// a `drop-shadow()` serialized like any other shadow. (Chrome-measured:
// `hue-rotate(1turn) brightness(50%) drop-shadow(10px 10px red)` computes to
// `hue-rotate(360deg) brightness(0.5) drop-shadow(rgb(255, 0, 0) 10px 10px 0px)`.) It is what
// makes a filter INTERPOLATE at all: mixing a `1turn` with a `0deg` needs one unit between them.
//
// A `url()` reference passes through untouched, and a function we don't model reports as the
// author wrote it, with only its colours normalised.
const roundTo = (n, scale) => Math.round(n * scale) / scale;
// The seven functions taking an AMOUNT — a number or a percentage — of which four are proportions
// that CLAMP at 1 (`grayscale(150%)` computes to `grayscale(1)`), while the three gain functions
// have no ceiling (`brightness(150%)` is `brightness(1.5)`). None of the seven takes a negative
// amount: one makes the whole declaration invalid, and the property reports its initial
// (Chrome-measured, all four shapes).
const FILTER_AMOUNTS = new Set(['grayscale', 'sepia', 'invert', 'opacity', 'brightness', 'contrast', 'saturate']);
const FILTER_CAPPED = new Set(['grayscale', 'sepia', 'invert', 'opacity']);

// A filter's computed form is a pure function of its TEXT unless it resolves something the ELEMENT
// decides: its colour (`currentcolor`, or a `drop-shadow()` that omits one) or a length its font or
// the viewport sizes. Those are the minority, and every other filter — `blur(4px)`,
// `opacity(.5) saturate(180%)` — is the same answer for every element on the page, so it is
// content-addressed. Without it the funnel re-parsed the whole list on EVERY
// `getComputedStyle(el).filter`, animating or not.
const FILTER_MEMO = new Map();
const FILTER_MEMO_MAX = 512;
const ELEMENT_RELATIVE_RE = /\d\s*(?:r?em|ex|ch|cap|ic|r?lh|v[hwbi]|vmin|vmax|[sld]v[hwbi])\b/i;
function serializeFilter(value, ownColorFn, el) {
  const text = String(value).trim();
  if (ELEMENT_RELATIVE_RE.test(text)) return computeFilter(text, ownColorFn, el);
  const hit = FILTER_MEMO.get(text);
  if (hit !== undefined) return hit;
  let usedColor = false;
  const out = computeFilter(text, () => { usedColor = true; return ownColorFn(); }, el);
  if (usedColor) return out;
  if (FILTER_MEMO.size >= FILTER_MEMO_MAX) FILTER_MEMO.clear();
  FILTER_MEMO.set(text, out);
  return out;
}
function computeFilter(value, ownColorFn, el) {
  const v = String(value).trim();
  if (!v || /^none$/i.test(v)) return 'none';
  const out = [];
  for (const fn of splitValues(v, ' ')) {
    const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(fn);
    if (!m) return normalizeEmbeddedColors(v);
    const name = m[1].toLowerCase(), arg = m[2].trim();
    if (name === 'url') { out.push(fn); continue; }
    if (name === 'drop-shadow') {
      // A shadow it could serialize always leads with the colour; a null is an INVALID one, which
      // makes the whole filter invalid (Chrome: `drop-shadow(1px 1px 1px inset)` computes to
      // `none` — there is no inset drop shadow), and anything else is an argument we don't model.
      const shadow = arg && serializeShadow(arg, SHADOW_LENGTHS['drop-shadow'], ownColorFn, el, false);
      if (shadow === null) return null;
      if (!shadow || !/^rgba?\(/.test(shadow)) return normalizeEmbeddedColors(v);
      out.push(`drop-shadow(${shadow})`);
      continue;
    }
    // An OMITTED argument is the function's default, which is not its identity: `grayscale()` is
    // fully grey (1), `blur()` is no blur at all (0).
    if (name === 'blur') {
      const px = arg ? shadowLengthPx(arg, el) : '0px';
      if (px === null) return normalizeEmbeddedColors(v);
      if (parseFloat(px) < 0) return null;               // a blur radius is never negative
      out.push(`blur(${px})`);
      continue;
    }
    if (name === 'hue-rotate') {
      const deg = arg ? angleDeg(arg) : 0;               // an angle, and this one MAY be negative
      if (deg === null) return normalizeEmbeddedColors(v);
      out.push(`hue-rotate(${roundTo(deg, 1e4)}deg)`);
      continue;
    }
    if (!FILTER_AMOUNTS.has(name)) return normalizeEmbeddedColors(v);
    const pct = /^([+-]?[\d.]+)%$/.exec(arg);
    const n = arg === '' ? 1 : pct ? parseFloat(pct[1]) / 100 : (/^[+-]?[\d.]+$/.test(arg) ? parseFloat(arg) : null);
    if (n === null || !Number.isFinite(n)) return normalizeEmbeddedColors(v);
    if (n < 0) return null;
    out.push(`${name}(${roundTo(FILTER_CAPPED.has(name) ? Math.min(1, n) : n, 1e6)})`);
  }
  return out.join(' ');
}

// Properties whose value CONTAINS colours among other components AND that reach this fallback:
// their colours normalise in place and the surrounding syntax is left as the author wrote it.
// Every other colour-bearing property is a registered shorthand (`background` / `border` /
// `outline` / `column-rule` / `text-emphasis`) or has its own serializer above (`text-decoration`,
// the two shadows), and is serialized from its longhands before it ever gets here.
const COLOR_BEARING_PROPS = new Set(['filter', 'backdrop-filter']);
const HEX_OR_NAMED_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\b[a-z]{3,20}\b/gi;
// The spans a colour word can't be one: inside a `url()` it is part of a PATH
// (`url(/img/gold-star.png)`), inside a string it is text. Rewriting there corrupted asset URLs
// and SVG filter ids — `gold`, `red`, `tan`, `plum`, `snow`, `linen` are all named colours.
// Also skips a `var()` reference: `--tan-100` is an identifier, and `tan` in it is no more a
// colour than `gold` in a filename is.
const URL_OR_STRING_RE = /url\([^)]*\)|var\([^)]*\)|--[\w-]+|"[^"]*"|'[^']*'/gi;
function normalizeEmbeddedColors(value) {
  const skip = [];
  let m;
  URL_OR_STRING_RE.lastIndex = 0;
  while ((m = URL_OR_STRING_RE.exec(String(value)))) skip.push([m.index, m.index + m[0].length]);
  const inSkip = (i) => skip.some(([a, b]) => i >= a && i < b);
  return String(value).replace(HEX_OR_NAMED_RE, (tok, offset) => {
    if (inSkip(offset)) return tok;
    if (/^(inset|none|to|solid|dashed|dotted|double|groove|ridge|inset|outset|hidden|repeat|round|space|border|padding|content|box|scroll|fixed|local|underline|overline|line|through|wavy|filled|open|dot|circle|sesame|triangle)$/i.test(tok)) return tok;
    const out = normalizeColor(tok);
    return /^rgba?\(/.test(out) ? out : tok;
  });
}

// Colour-valued properties: `color`, every `*-color` longhand, and SVG's two PAINT properties,
// whose value can also be a `url()` / `none` / `context-*` keyword — `normalizeColor` passes those
// through untouched, so the same call serves both.
function isColorValued(key) {
  return key === 'color' || key === 'fill' || key === 'stroke' || key.endsWith('-color');
}

function inheritedColor(el, key) {
  if (key !== 'color') return readComputed(el, 'color').value || 'rgb(0, 0, 0)';
  const parent = el._parent;
  const inherited = parent && parent.nodeType === NODE_ELEMENT ? readComputed(parent, 'color').value : null;
  return inherited || COMPUTED_INITIAL_OVERRIDES['color'];
}

// The UA STYLESHEET, for the properties whose UA value differs from the CSS initial. Without this
// layer the initial-value fallback answers confidently and wrongly for elements every page has:
// `getComputedStyle(pre).whiteSpace` said `normal` while the driver's own
// `elementPreservesWhitespace` said the opposite, and `<ol>` reported `disc`. Page code branches on
// exactly these (`x !== 'none'`), so a wrong answer is worse than none.
//
// Every value below is Chrome measured. Keyed by tag; an entry with `when` applies only to elements
// it accepts (`<a>` gets its link styling from `:any-link`, so a bare anchor keeps the initial).
// The UA control chrome's face colour IS the `ButtonFace` system colour — hardcoding the rgb in
// three places let the two drift (they disagreed by one per channel until the system-colour table
// was Chrome-measured). One source, so the next measurement pass has one place to change.
const BUTTON_FACE = `rgb(${[1, 3, 5].map(i => parseInt(SYSTEM_COLORS.buttonface.slice(i, i + 2), 16)).join(', ')})`;
const MONOSPACE = { 'font-family': 'monospace' };
// A table cell's 1px UA padding is load-bearing for geometry, not decoration: it is
// in every column width and every row height a browser reports.
const CELL_PADDING = {
  'padding-top': '1px', 'padding-right': '1px', 'padding-bottom': '1px', 'padding-left': '1px'
};
// `dl` counts here but not for the marker: `<ul>` inside a `<dl>` keeps `disc` while losing its
// margins (Chrome-verified, and what HTML's `:is(dir,dl,menu,ol,ul) :is(…)` selector says).
const LIST_MARGIN_ANCESTORS = new globalThis.Set(['dir', 'dl', 'menu', 'ol', 'ul']);
const LIST_MARKER_ANCESTORS = new globalThis.Set(['dir', 'menu', 'ol', 'ul']);
function listNestingDepth(el, tags) {
  let depth = 0;
  for (let p = el._parent; p && p.nodeType === 1; p = p._parent) if (tags.has(p._tag)) depth++;
  return depth;
}
// Chrome's FIXED-font default size: 13px where the proportional default is 16 — and the RATIO
// travels with the keyword through inheritance rather than being a constant. A `<code>` is 13px at
// the top of a page, 26 inside an `<h1>` (32 x 13/16) and 15.6 inside `font-size: larger`
// (19.2 x 13/16), because each of those sizes is itself derived from the initial `medium`. An
// ABSOLUTE length anywhere up the chain ends the derivation and is inherited like any other size:
// `<div style="font-size: 20px"><code>` is 20px, and `<div style="font: 16px monospace"><pre>` 16.
// (Every figure measured.)
const FIXED_FONT_RATIO = 13 / 16;
// The units that make a size a LENGTH of its own. `em` / `ex` / `ch` / `%` are the parent's size
// restated, so they carry the derivation down with them.
const ABSOLUTE_FONT_SIZE_RE = /^[\d.]+(px|pt|pc|in|cm|mm|q|rem|vw|vh|vmin|vmax)$/;
const monospaceMedium = (el) => {
  for (let p = el._parent; p && p.nodeType === NODE_ELEMENT; p = p._parent) {
    const declared = declaredValue(p, 'font-size') ?? uaDefault(p, 'font-size');
    if (declared == null || declared === '') continue;
    const v = String(declared).trim().toLowerCase();
    if (v === 'inherit' || v === 'unset') continue;
    if (ABSOLUTE_FONT_SIZE_RE.test(v)) return undefined;
  }
  const parent = el._parent;
  const base = (parent && parent.nodeType === NODE_ELEMENT) ? computedFontSizePx(parent) : DEFAULT_FONT_SIZE_PX;
  return `${+(base * FIXED_FONT_RATIO).toFixed(4)}px`;
};

// HTML's block margins are written on the BLOCK axis, so a `writing-mode: vertical-rl` page puts
// them left and right exactly as Chrome does.
const blockMargin = (v) => ({ 'margin-block-start': v, 'margin-block-end': v });

// A list numbers its items, which HTML's sheet says with `counter-reset: list-item` — and the
// `start` / `reversed` attributes are part of that declaration, not separate rules: `<ol start=10>`
// resets the counter to 9 so the first item is 10, and a reversed list counts down from one past
// its length. The table is the SPEC's (`lists-styles` pins it); Chrome reports `none` for all of
// them, because Blink numbers lists natively rather than through the counter properties — and so
// does this driver's marker code, so these values are conformance, not machinery.
const listCounterReset = (el) => {
  if (el._tag !== 'ol') return 'list-item';
  const reversed = el._attrs && el._attrs.reversed != null;
  const start = htmlInteger(el._attrs && el._attrs.start);
  if (reversed) return start == null ? 'reversed(list-item)' : `reversed(list-item) ${start + 1}`;
  return start == null ? 'list-item' : `list-item ${start - 1}`;
};
// …and `<li value=10>` SETS the counter rather than resetting it, which is how one item renumbers
// the rest of its list.
const liCounterSet = (el) => {
  const v = htmlInteger(el._attrs && el._attrs.value);
  return v == null ? undefined : `list-item ${v}`;
};

// QUIRKS mode puts a stray `<li>`'s marker INSIDE its box — one that really is in a list keeps the
// standard `outside`. The one UA rule in this driver that depends on the document's mode
// (`lists-styles-quirks`, and its standards-mode twin says `outside` throughout).
const liMarkerPosition = (el) => {
  const doc = el._ownerDocument || globalThis.document;
  if (!doc || !doc._quirks) return undefined;
  return listNestingDepth(el, LIST_MARKER_ANCESTORS) === 0 ? 'inside' : undefined;
};

// A list directly in the flow gets `1em` block margins; one nested in any list loses them.
const listBlockMargin = (el) => (listNestingDepth(el, LIST_MARGIN_ANCESTORS) ? '0px' : '1em');
const LIST_BLOCK = { 'margin-block-start': listBlockMargin, 'margin-block-end': listBlockMargin };
// disc at the top, circle one deep, square from two down — it stops at square.
const unorderedMarker = (el) => {
  const depth = listNestingDepth(el, LIST_MARKER_ANCESTORS);
  return depth === 0 ? 'disc' : depth === 1 ? 'circle' : 'square';
};
// `frameborder` turns the frame off, and HTML reads it as an INTEGER prefix: anything that parses
// to zero — `0`, `-0`, `0.5`, `""` — and anything that does not parse at all — `no`, `none`,
// `error` — draws no border, while `1`, `10`, `-1` and `-10` all keep it (measured across that
// whole grammar in Chrome). `frameborder=0` is the everyday embed idiom.
function frameBorderWidth(el) {
  const raw = el._attrs && el._attrs.frameborder;
  if (raw == null) return '2px';
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) || n === 0 ? '0px' : '2px';
}

const UA_DEFAULTS = Object.assign(Object.create(null), {
  // (`<pre>`'s `1em` block margin is one em of ITS font, which is the 13px monospace one.)
  pre:      { 'white-space': 'pre', ...MONOSPACE, 'font-size': monospaceMedium, ...blockMargin('1em') },
  xmp:      { 'white-space': 'pre', ...MONOSPACE, 'font-size': monospaceMedium, ...blockMargin('1em') },
  plaintext:{ 'white-space': 'pre', ...MONOSPACE, 'font-size': monospaceMedium, ...blockMargin('1em') },
  listing:  { 'white-space': 'pre', ...MONOSPACE, 'font-size': monospaceMedium, ...blockMargin('1em') },
  textarea: { 'white-space': 'pre-wrap' },
  // A monospace element also takes the browser's FIXED-font default size — Chrome renders
  // `<code>` at 13px inside 16px body text, which is visible the moment text is measured for real
  // (its run is ~19% narrower than the same string in the surrounding font). It is the family's own
  // `medium`, not a rule of its own, so it applies only where the size would otherwise BE the
  // initial: a `<pre>` inside a `font-size: 20px` block inherits the 20 (`monospaceMedium`).
  code: { ...MONOSPACE, 'font-size': monospaceMedium }, kbd: { ...MONOSPACE, 'font-size': monospaceMedium },
  samp: { ...MONOSPACE, 'font-size': monospaceMedium }, tt: { ...MONOSPACE, 'font-size': monospaceMedium },
  // HTML's sheet draws a frame around an `<iframe>`, and it is part of the box: Chrome makes a
  // default one 304x154 rather than 300x150, and a `width: 20px` one 24 wide. Written as the
  // LONGHANDS the layout and `getComputedStyle` both read, as `<fieldset>`'s frame is below.
  iframe: {
    'border-top-style': 'inset', 'border-right-style': 'inset',
    'border-bottom-style': 'inset', 'border-left-style': 'inset',
    'border-top-width': frameBorderWidth, 'border-right-width': frameBorderWidth,
    'border-bottom-width': frameBorderWidth, 'border-left-width': frameBorderWidth
  },
  b: { 'font-weight': '700' }, strong: { 'font-weight': '700' },
  // HTML's own sheet raises and shrinks these two, and both halves are visible: Chrome renders a
  // `<sup>` in 16px text at 13.33px, 4.33 above the baseline, taking the line to 22.33.
  sup: { 'vertical-align': 'super', 'font-size': 'smaller' },
  sub: { 'vertical-align': 'sub',   'font-size': 'smaller' },
  // HTML's own two size keywords, which is how a `<big><code>` ends up at 15.6px: `big` raises the
  // inherited size by a step and the monospace ratio then applies to THAT.
  big:   { 'font-size': 'larger' },
  small: { 'font-size': 'smaller' },
  // Heading sizes are UA style too (`h1 { font-size: 2em }` …). Without them every
  // heading measured — and reported through getComputedStyle — as 16px body text.
  //
  // …and so are their MARGINS, which are `em` of the heading's own (already scaled) size: an `<h1>`
  // is 21.44px apart from what follows it, an `<h6>` 24.98 (Chrome-measured — `headings-styles` is
  // 92 subtests of exactly this table, and every page that does not reset its margins was laying
  // its headings out flush against the text around them).
  h1: { 'font-weight': '700', 'font-size': '2em',    ...blockMargin('0.67em') },
  h2: { 'font-weight': '700', 'font-size': '1.5em',  ...blockMargin('0.83em') },
  h3: { 'font-weight': '700', 'font-size': '1.17em', ...blockMargin('1em')    },
  h4: { 'font-weight': '700', 'font-size': '1em',    ...blockMargin('1.33em') },
  h5: { 'font-weight': '700', 'font-size': '0.83em', ...blockMargin('1.67em') },
  h6: { 'font-weight': '700', 'font-size': '0.67em', ...blockMargin('2.33em') },
  // The rest of HTML's block margins, in the flow-relative spelling its own sheet uses. `<pre>`'s
  // `1em` is one em of ITS font (13px), and `<blockquote>` / `<figure>` are indented 40px on both
  // inline sides.
  p:          { ...blockMargin('1em') },
  blockquote: { ...blockMargin('1em'), 'margin-inline-start': '40px', 'margin-inline-end': '40px' },
  figure:     { ...blockMargin('1em'), 'margin-inline-start': '40px', 'margin-inline-end': '40px' },
  // An `<hr>` is a 2px box of its own: HTML's sheet gives it a 1px inset border in grey, and it
  // clips (Chrome-measured — without the border it was 8px of margin around nothing).
  hr:         { ...blockMargin('0.5em'), 'color': 'rgb(128, 128, 128)',
                'border-top-width': '1px', 'border-right-width': '1px',
                'border-bottom-width': '1px', 'border-left-width': '1px',
                'border-top-style': 'inset', 'border-right-style': 'inset',
                'border-bottom-style': 'inset', 'border-left-style': 'inset',
                'overflow-x': 'hidden', 'overflow-y': 'hidden' },
  th: { 'font-weight': '700', 'text-align': 'center', ...CELL_PADDING },
  td: { ...CELL_PADDING },
  // The two table properties every table's geometry starts from. Both INHERIT, but
  // this UA rule is keyed on the TAG and a declared value outranks an inherited one:
  // a `<table>` inside `div { border-spacing: 10px }` still spaces at 2px, while a
  // `display: table` DIV inherits the 10px (Chrome-verified, both).
  // …and a table is a border box that resets `text-indent` for everything in it (HTML's own sheet:
  // an indented paragraph does not indent the cells of a table inside it — `text-align`, measured,
  // does still inherit).
  table: { 'border-spacing': '2px', 'border-collapse': 'separate',
           'box-sizing': 'border-box', 'text-indent': '0px' },
  // A `<marquee>` starts its text at the inline start and clips what it scrolls.
  marquee: { 'text-align': 'start', 'overflow-x': 'hidden', 'overflow-y': 'hidden' },
  caption: { 'text-align': 'center' },
  i: { 'font-style': 'italic' }, em: { 'font-style': 'italic' }, cite: { 'font-style': 'italic' },
  var: { 'font-style': 'italic' }, dfn: { 'font-style': 'italic' }, address: { 'font-style': 'italic' },
  del: { 'text-decoration-line': 'line-through' }, s: { 'text-decoration-line': 'line-through' },
  strike: { 'text-decoration-line': 'line-through' },
  ins: { 'text-decoration-line': 'underline' }, u: { 'text-decoration-line': 'underline' },
  a: { 'text-decoration-line': 'underline', 'cursor': 'pointer', 'color': 'rgb(0, 0, 238)' },
  // A `<fieldset>` carries real UA chrome, and most of it is GEOMETRY rather than decoration: the
  // groove border and the asymmetric padding inset every box inside one, so a driver without them
  // reports a fieldset's children in the wrong place. Chrome measured, and `em` rather than the px
  // it resolves to at 16px, because the padding scales with the fieldset's own font as Chrome's
  // does (font-size 40px gives 14 / 30 / 25px — measured).
  //
  // Written FLOW-RELATIVELY, as HTML's own UA sheet writes it: the block/inline pairs differ here,
  // so a `writing-mode: vertical-rl` fieldset has Chrome's 2px margins on top and bottom, not left
  // and right. The cascade maps a logical name to its physical twin (`twinName`), so a UA
  // declaration resolves through the same door an author's `padding-block-start` does.
  //
  // `min-inline-size: min-content` is reported but NOT yet honoured by layout — `min-content`
  // sizing is a gap this rule inherits rather than one it introduces (an author-declared
  // `min-width: min-content` is ignored the same way), so a narrow fieldset still overflows where
  // Chrome would widen it.
  fieldset: {
    'margin-inline-start': '2px', 'margin-inline-end': '2px',
    'border-top-style': 'groove', 'border-right-style': 'groove',
    'border-bottom-style': 'groove', 'border-left-style': 'groove',
    'border-top-width': '2px', 'border-right-width': '2px',
    'border-bottom-width': '2px', 'border-left-width': '2px',
    'border-top-color': 'threedface', 'border-right-color': 'threedface',
    'border-bottom-color': 'threedface', 'border-left-color': 'threedface',
    'padding-block-start': '0.35em', 'padding-inline-end': '0.75em',
    'padding-block-end': '0.625em', 'padding-inline-start': '0.75em',
    'min-inline-size': 'min-content'
  },
  legend: { 'padding-inline-start': '2px', 'padding-inline-end': '2px' },
  // The list family. Written flow-relatively as HTML's own sheet writes it, and DEPTH-DEPENDENT in
  // two places, which is what the function values below are for: a list nested in another list
  // loses its block margins, and an unordered marker walks disc -> circle -> square as it nests.
  // Chrome measured, including that `<ol>` keeps `decimal` at every depth and that `<dl>` counts
  // as a nesting ancestor for the MARGIN rule but not for the marker.
  ol:   { ...LIST_BLOCK, 'padding-inline-start': '40px', 'list-style-type': 'decimal',
          'counter-reset': listCounterReset },
  ul:   { ...LIST_BLOCK, 'padding-inline-start': '40px', 'list-style-type': unorderedMarker,
          'counter-reset': listCounterReset },
  menu: { ...LIST_BLOCK, 'padding-inline-start': '40px', 'list-style-type': unorderedMarker,
          'counter-reset': listCounterReset },
  dir:  { ...LIST_BLOCK, 'padding-inline-start': '40px', 'list-style-type': unorderedMarker },
  dl:   { ...LIST_BLOCK },
  dd:   { 'margin-inline-start': '40px' },
  // HTML's own sheet: an `<li>` aligns with its list, so a `dir` that differs from the list's
  // resolves against the LIST's direction — `<ul dir=rtl><li dir=ltr>` is `right`.
  li:   { 'text-align': 'match-parent', 'counter-set': liCounterSet, 'counter-increment': 'list-item',
          'list-style-position': liMarkerPosition },
  // The page's own margin, which the layout engine has always used (`BODY_MARGIN`) but the style
  // side reported as the initial `0px` — so `getComputedStyle(document.body).marginTop` said 0
  // where Chrome says 8, and the `marginwidth` attributes above had nothing to fall back to.
  body: { 'margin-top': '8px', 'margin-right': '8px', 'margin-bottom': '8px', 'margin-left': '8px' },
});
// The predicate lives OUTSIDE the value map: everything in that map is reachable as a property
// name, so a `when` key there answers `getComputedStyle(a).when` with a function.
const UA_APPLIES = Object.assign(Object.create(null), {
  a: (el) => el._attrs && el._attrs.href != null         // `:any-link`, not every <a>
});
// A LISTBOX `<select>` is a different control from a dropdown: it scrolls, it is white rather than
// grey, and it is as tall as the rows it shows. All three follow from HTML's DISPLAY SIZE, which
// the selectedness algorithm already computes (`selectDisplaySize`) — asking it here rather than
// re-deriving the rule is what keeps `<select multiple size="1">` a one-row dropdown, which is
// what Chrome shows it as.
export function isListBox(el) {
  return el._tag === 'select' && !!el._attrs && selectDisplaySize(el) > 1;
}
// SVG's geometry attributes: `<svg width="40" height="20">` sits in the cascade BELOW everything
// an author writes, which is exactly where `uaDefault` sits, so it resolves through the same door
// and both the layout engine and `getComputedStyle` see it. Chrome measured: an
// `<svg width="40" height="20">` is 40x20 where the default object size would say 300x150, and a
// CSS `height` overrides the attribute while the attribute still supplies the width (40x200, not
// the 400 its `viewBox` ratio implies).
//
// HTML's presentational dimension attributes are NOT here: they are the CASCADE's
// (cascade.js `presentationalHint`, which carries HTML's full element/attribute table and its
// "ignoring zero" variants). This used to hold a second, smaller copy of that table, and the two
// disagreed — on `200.%`, on `200 %`, and on which elements map at all.
function presentationSize(el, key) {
  if (el._tag !== 'svg' || (key !== 'width' && key !== 'height')) return undefined;
  const raw = el._attrs && el._attrs[key];
  if (raw == null) return undefined;
  const t = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return t + 'px';
  return /^-?\d*\.?\d+(px|em|rem|ex|ch|pt|pc|in|cm|mm|q|%|vw|vh|vmin|vmax)$/i.test(t) ? t : undefined;
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
const BUTTON_CHROME = controlChrome({ width: '2px', style: 'outset', color: 'rgb(0, 0, 0)',
                                      padY: '1px', padX: '6px', bg: BUTTON_FACE,
                                      sizing: 'border-box', align: 'center' });
// A button `<input>` is the same box that CLIPS — it has no element children to overflow it, but
// Chrome computes `clip` on it and `visible` on a `<button>`, which does.
const FIELD_CHROME  = controlChrome({ width: '2px', style: 'inset', color: 'rgb(118, 118, 118)',
                                      padY: '1px', padX: '2px', bg: 'rgb(255, 255, 255)',
                                      cursor: 'text', overflow: 'clip' });
const BUTTON_INPUT_CHROME = { ...BUTTON_CHROME, 'overflow-x': 'clip', 'overflow-y': 'clip' };
// A DATE / TIME field is a text field with its own metrics: no vertical padding, 1px horizontal,
// and a MONOSPACE font — the segments have to line up as they are typed over. Chrome-measured.
const DATE_CHROME = controlChrome({ width: '2px', style: 'inset', color: 'rgb(118, 118, 118)',
                                    padY: '0px', padX: '1px', bg: 'rgb(255, 255, 255)',
                                    family: 'monospace', overflow: 'clip' });
// A checkbox / radio / file / image input paints its own widget with no CSS box around it: no
// border, no padding, nothing behind it — the box is the widget's own size, which `intrinsicSize`
// gives it.
const WIDGET_CHROME = controlChrome({ overflow: 'clip', width: '0px', style: 'none', color: 'rgb(0, 0, 0)',
                                      padY: '0px', padX: '0px', bg: 'rgba(0, 0, 0, 0)' });
// A checkbox / radio carries a MARGIN of its own, and it is the only thing that spaces the widget
// from the label beside it. Chrome-measured, and the two differ: `3px 3px 3px 4px` for a checkbox,
// `3px 3px 0px 5px` for a radio. A range is 2px all round.
// A checkbox, a radio and a slider are the three inputs Chrome does NOT clip (measured across the
// whole type matrix): their widget is painted outside the content box they are given.
const CHECKBOX_CHROME = { ...WIDGET_CHROME, 'box-sizing': 'border-box',
                          'overflow-x': 'visible', 'overflow-y': 'visible',
                          'margin-top': '3px', 'margin-right': '3px',
                          'margin-bottom': '3px', 'margin-left': '4px' };
const RADIO_CHROME  = { ...CHECKBOX_CHROME, 'margin-left': '5px', 'margin-bottom': '0px' };
// The file widget's own label takes the page's colour — the one member of this family that does
// NOT reset it (Chrome: green inside `color: rgb(0, 128, 0)`, where a checkbox stays black).
const FILE_CHROME = { ...WIDGET_CHROME };
delete FILE_CHROME.color;
// …and an `image` input clips to its CONTENT box, where every other control clips at zero.
const IMAGE_CHROME = { ...WIDGET_CHROME, 'cursor': 'pointer', 'overflow-clip-margin': 'content-box' };
const RANGE_CHROME  = { ...WIDGET_CHROME, 'background-color': 'rgb(255, 255, 255)',
                        'color': 'rgb(157, 150, 142)',
                        'overflow-x': 'visible', 'overflow-y': 'visible',
                        'margin-top': '2px', 'margin-right': '2px',
                        'margin-bottom': '2px', 'margin-left': '2px' };
// A textarea is the one control that really scrolls: Chrome computes `overflow: auto` on it and
// honours `textarea.scrollTop = 20`. Without it the write was silently dropped, exactly as a
// listbox's was before it got its own rule.
const TEXTAREA_CHROME = controlChrome({ width: '1px', style: 'solid', color: 'rgb(118, 118, 118)',
                                        padY: '2px', padX: '2px', bg: 'rgb(255, 255, 255)',
                                        family: 'monospace', cursor: 'text', overflow: 'auto' });
// A dropdown CLIPS: its options are not rendered in the control at all, so nothing inside it can
// overflow (Chrome computes `overflow: clip` on it, and on a text `<input>` — measured). Without
// that, an option wider than the control pushed a scrollbar onto every ancestor around it.
const SELECT_CHROME = { ...controlChrome({ width: '1px', style: 'solid', color: 'rgb(118, 118, 118)',
                                           padY: '0px', padX: '0px', bg: BUTTON_FACE,
                                           sizing: 'border-box', overflow: 'clip' }),
                        // …and it clips at its CONTENT box, as an `image` input does.
                        'overflow-clip-margin': 'content-box' };

// A colour swatch is its own thing again: a thin black border round the swatch, on a button face.
const COLOR_CHROME = controlChrome({ width: '1px', style: 'solid', color: 'rgb(0, 0, 0)',
                                     padY: '1px', padX: '2px', bg: BUTTON_FACE,
                                     sizing: 'border-box', overflow: 'clip' });
// A listbox is a white SCROLLING pane, not a grey button face: Chrome computes
// `overflow-x: hidden; overflow-y: scroll` on it and honours `select.scrollTop = 40` (measured; a
// dropdown gets neither). Without it, restoring a listbox's scroll position was silently dropped.
const LISTBOX_CHROME = { ...SELECT_CHROME, 'background-color': 'rgb(255, 255, 255)',
                         'overflow-x': 'hidden', 'overflow-y': 'scroll' };

// `<input>`'s box follows its TYPE, which a tag-keyed table cannot express — a submit is a button,
// a checkbox is a widget, an `image` is a replaced element with no chrome at all (Chrome: 0x0, no
// border, no background), and everything else — including an unknown type — is a text field.
const INPUT_CHROME = Object.assign(Object.create(null), {
  button: BUTTON_INPUT_CHROME, submit: BUTTON_INPUT_CHROME, reset: BUTTON_INPUT_CHROME,
  checkbox: CHECKBOX_CHROME, radio: RADIO_CHROME,
  date: DATE_CHROME, 'datetime-local': DATE_CHROME, month: DATE_CHROME,
  week: DATE_CHROME, time: DATE_CHROME,
  range: RANGE_CHROME, color: COLOR_CHROME, file: FILE_CHROME, image: IMAGE_CHROME,
  // A `search` field is border-box where the other text fields are not, and it is the only one
  // (`form-controls/resets`, measured).
  search: { ...FIELD_CHROME, 'box-sizing': 'border-box' },
  // A hidden input is not rendered at all (`uaDisplay`), so its chrome is only what
  // `getComputedStyle` reports about a box that isn't there.
  hidden: WIDGET_CHROME
});
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

function controlChromeFor(el) {
  const tag = el._tag;
  // Cheap tag gate first: this runs on EVERY property resolution of every element, and the
  // overwhelming majority are not controls.
  if (tag === 'input')    return INPUT_CHROME[inputType(el)] || FIELD_CHROME;
  if (tag === 'button')   return BUTTON_CHROME;
  if (tag === 'select')   return isListBox(el) ? LISTBOX_CHROME : SELECT_CHROME;
  if (tag === 'textarea') return TEXTAREA_CHROME;
  return undefined;
}

// HTML's bidi UA rules, which no tag-keyed table can express: the block elements ISOLATE their
// text, `<bdo>` isolates and overrides whatever the page says, and ANY element carrying a valid
// `dir` isolates — with `dir=auto` on the elements that hold plain text (`<pre>`, `<textarea>` and
// the text-ish inputs) asking for `plaintext` instead. An invalid `dir` is no `dir` at all.
const BIDI_ISOLATE_TAGS = new globalThis.Set([
  'address', 'blockquote', 'center', 'div', 'figure', 'figcaption', 'footer', 'form', 'header',
  'hr', 'legend', 'listing', 'main', 'p', 'plaintext', 'pre', 'summary', 'xmp', 'article', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'nav', 'section', 'search', 'table', 'caption',
  'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'dir', 'dd', 'dl', 'dt', 'menu',
  'ol', 'ul', 'li', 'bdi', 'output'
]);
const PLAINTEXT_INPUT_TYPES = new globalThis.Set(['search', 'tel', 'url', 'email']);
function unicodeBidiDefault(el) {
  const tag = el._tag;
  if (tag === 'bdo') return 'isolate-override';
  const raw = el._attrs && el._attrs.dir;
  const dir = raw == null ? '' : String(raw).toLowerCase();
  if (dir === 'auto') {
    if (tag === 'pre' || tag === 'textarea') return 'plaintext';
    if (tag === 'input') return PLAINTEXT_INPUT_TYPES.has(inputType(el)) ? 'plaintext' : 'isolate';
    return 'isolate';
  }
  if (dir === 'ltr' || dir === 'rtl') return 'isolate';
  return BIDI_ISOLATE_TAGS.has(tag) ? 'isolate' : undefined;
}

export function uaDefault(el, key) {
  // Before the tables: this rule is keyed on the `dir` ATTRIBUTE as much as on the tag.
  if (key === 'unicode-bidi') return unicodeBidiDefault(el);
  const pres = presentationSize(el, key);
  if (pres !== undefined) return pres;
  // Control chrome first — the two tables are key-disjoint (`UA_DEFAULTS` keeps a `<select>`'s
  // overflow and a `<textarea>`'s white-space, neither of which the chrome sets), so the order is
  // only about which gate is cheaper: `controlChromeFor` rejects a non-control on one tag compare.
  const chrome = controlChromeFor(el);
  if (chrome && Object.prototype.hasOwnProperty.call(chrome, key)) return chrome[key];
  const entry = UA_DEFAULTS[el._tag];
  if (!entry) return undefined;
  let own = Object.prototype.hasOwnProperty.call(entry, key) ? key : undefined;
  // A UA rule may be written FLOW-RELATIVELY, as HTML's own sheet writes `<fieldset>`'s margins
  // and padding — so a physical read has to find its logical twin (and the reverse), exactly as
  // the cascade resolves an author's `margin-inline-start` against `margin-left`. Gated on the
  // entry actually holding a logical key (a flag computed once per table entry), so the tags whose
  // rules are all physical — every other tag in the table — never pay the twin lookup.
  if (own === undefined) {
    // …and the entry knows in O(1) whether it could answer for this key AT ALL — its own names
    // plus every physical spelling its logical ones can take. Without that gate, an entry holding
    // one flow-relative name made every OTHER property read on that element resolve the element's
    // flow (a cascade read) only to miss: giving `<p>` its UA margins cost 42% of a layout pass on
    // a page of paragraphs, all of it here.
    const answerable = LOGICAL_UA_KEYS.get(entry);
    if (!answerable || !answerable.has(key)) return undefined;
    const twin = twinName(el, key);
    if (!twin || !Object.prototype.hasOwnProperty.call(entry, twin)) return undefined;
    own = twin;
  }
  const applies = UA_APPLIES[el._tag];
  if (applies && !applies(el)) return undefined;
  // A UA value may be a FUNCTION of the element, which is how the depth-dependent list rules are
  // written (a nested list's margins and marker). Resolved here so a function can never escape as
  // a property value — the same reason `UA_APPLIES` lives outside the table.
  const value = entry[own];
  return typeof value === 'function' ? value(el) : value;
}
// Which PHYSICAL names each UA table entry's flow-relative rules could answer for — the whole
// point being that an entry with no logical name at all, and a key no logical name of this entry
// can spell, are both rejected on one Map/Set lookup. Computed once, at module load.
const LOGICAL_RE = /-(block|inline)-(start|end)$|^(min|max)?-?(block|inline)-size$/;
const PHYSICAL_FOR_LOGICAL = {
  'block-start': ['top'], 'block-end': ['bottom'], 'inline-start': ['left', 'right'],
  'inline-end': ['left', 'right']
};
const LOGICAL_UA_KEYS = new globalThis.Map();
for (const entry of Object.values(UA_DEFAULTS)) {
  let keys = null;
  for (const k of Object.keys(entry)) {
    if (!LOGICAL_RE.test(k)) continue;
    keys = keys || new globalThis.Set();
    // `margin-inline-start` answers for `margin-left` AND `margin-right` (which of them it is
    // depends on the element's own flow, which only `twinName` can say); a logical SIZE answers
    // for both physical sizes for the same reason.
    const m = /^(.*)-(block|inline)-(start|end)$/.exec(k);
    if (m) {
      for (const side of PHYSICAL_FOR_LOGICAL[`${m[2]}-${m[3]}`]) keys.add(`${m[1]}-${side}`);
    } else {
      const size = /^((?:min|max)-)?(block|inline)-size$/.exec(k);
      if (size) { keys.add(`${size[1] || ''}width`); keys.add(`${size[1] || ''}height`); }
    }
  }
  if (keys) LOGICAL_UA_KEYS.set(entry, keys);
}

// Longhand → the shorthands that can set it (mdn-data's own mapping, inverted). Used to tell a
// property nothing declares from one whose shorthand we simply don't expand.
// Built on FIRST USE: this consults `canExpandShorthand` from cascade.js, and the two modules
// import each other — calling across that cycle during module evaluation reads a binding that
// isn't initialised yet, which broke the V8 snapshot build outright.
let SHORTHANDS_SETTING_MAP = null;
const shorthandsSetting = (key) => {
  if (!SHORTHANDS_SETTING_MAP) SHORTHANDS_SETTING_MAP = buildShorthandsSetting();
  return SHORTHANDS_SETTING_MAP[key];
};
const buildShorthandsSetting = () => {
  const map = Object.create(null);
  for (const sh of Object.keys(SHORTHAND_LONGHANDS)) {
    // A FLOW-RELATIVE shorthand is excluded only when we actually EXPAND it: mdn's entry names
    // whichever physical side the value would resolve to, which depends on the writing mode, so
    // using it as a gate points at the wrong side. One we can't expand still has to gate — saying
    // `scroll-margin-top: 0px` for an element with `scroll-margin-block: 10px` is the confident
    // wrong answer this whole gate exists to prevent.
    if ((sh.indexOf('-block') !== -1 || sh.indexOf('-inline') !== -1) && canExpandShorthand(sh)) continue;
    for (const lh of SHORTHAND_LONGHANDS[sh]) (map[lh] || (map[lh] = [])).push(sh);
  }
  return map;
};

// Does a shorthand declared on `el` leave `key` UNKNOWABLE — set through a decomposition we can't
// perform? Only then may a resolved-value read refuse to answer; a shorthand that did fill the slot
// is no gate, because `key` would have a declared value of its own. Two cases separate them:
//   * a SUBSTITUTION fills every slot the shorthand names with a pending value, so reaching here
//     means it resolved to nothing — invalid at computed-value time, which is `unset`, i.e. the
//     initial value (Chrome measured `background: var(--undefined)` → `background-image: none`);
//   * otherwise the ONE decomposition answers it: a value we CAN decompose settles every longhand
//     the shorthand names — the ones it doesn't mention are reset to their initial, which is why a
//     literal `animation: spin 2s` and the same value behind a `var()` both report
//     `animation-timeline: auto`. Only a value that decomposes into NOTHING (`font: menu`) leaves
//     its longhands genuinely unknowable.
// Called only once a longhand has come up empty, which is why it can afford to re-expand. The
// question is not key-specific — `setters` is already `shorthandsSetting(key)`, and a shorthand
// that decomposes settles every longhand it names — so the lookup lives here rather than at each
// call site, where an unused `key` parameter suggested otherwise.
function setterLeavesUnknown(el, key) {
  const setters = shorthandsSetting(key);
  if (!setters) return false;
  for (const sh of setters) {
    const v = cascadedProperty(el, sh);
    if (v == null) continue;
    if (hasSubstitution(v) && canExpandShorthand(sh)) continue;
    // Same pure `(shorthand, value)` call the pending path makes, so it shares that cache: this runs
    // per longhand of an enumerated computed style, and once per ancestor in the inheritance walk.
    if (!expandedPending(sh, v)) return true;
  }
  return false;
}

// LIST-valued length properties: each component carries its own unit, so a bare `0` normalises per
// component rather than through the single-value path. (Only the ones measured against Chrome are
// listed — a property missing from here reports a bare zero, which is the pre-existing behaviour,
// not a new wrong answer.)
const ZERO_NORMALIZED_PROPS = new Set(['background-size', 'border-spacing', 'overflow-clip-margin']);
// A few keywords COMPUTE to a length rather than serializing as themselves: `word-spacing: normal`
// is `0px` in every browser, because its computed value IS a length — where `letter-spacing:
// normal` stays the keyword (asymmetric, and measured both ways).
const KEYWORD_LENGTHS = Object.assign(Object.create(null), { 'word-spacing': { normal: '0px' } });

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
  const pos = String(declaredValue(el, 'position') || 'static').trim().toLowerCase();
  return /(^|-)(flex|grid)$/.test(String(pd)) && pos !== 'absolute' && pos !== 'fixed' ? 'auto' : '0px';
}
function computedInitialValue(prop, el) {
  if (MIN_SIZE_PROPS.has(prop)) return automaticMinSize(el);
  const override = COMPUTED_INITIAL_OVERRIDES[prop];
  if (override !== undefined) return override;
  const initial = INITIAL_VALUES[prop];
  return initial !== undefined ? initial : null;
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
// Computed font-size in px. font-size INHERITS and resolves relative units against the
// PARENT's computed font-size (em / % / smaller / larger) or the root's (rem); an absolute
// length or size keyword is layout-free. So getComputedStyle can report it (and it backs the
// canvas em/rem/lh resolution, which reads `getComputedStyle(el).fontSize`). `parentPx` is a
// LAZY closure so an absolute own value short-circuits before any ancestor walk (rule 3).
export function computedFontSizePx(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return DEFAULT_FONT_SIZE_PX;
  const parentPx = () => {
    const p = el._parent;
    return (p && p.nodeType === NODE_ELEMENT) ? computedFontSizePx(p) : DEFAULT_FONT_SIZE_PX;
  };
  // The UA stylesheet sizes headings (`h1 { font-size: 2em }`) and monospace
  // elements (Chrome's 13px fixed-font default); an author declaration wins.
  const cascaded = declaredValue(el, 'font-size') ?? uaDefault(el, 'font-size');
  if (cascaded == null || cascaded === '') return parentPx();            // unset → inherit
  const s = String(cascaded).trim().toLowerCase();
  // CSS-wide keywords: `initial` / `revert` / `revert-layer` compute to the property initial
  // (medium = 16px); `inherit` / `unset` take the parent
  // (font-size inherits, so `unset` ≡ `inherit`).
  if (s === 'initial' || s === 'revert' || s === 'revert-layer') return DEFAULT_FONT_SIZE_PX;
  if (s === 'inherit' || s === 'unset') return parentPx();
  if (Object.prototype.hasOwnProperty.call(ABSOLUTE_FONT_SIZE_PX, s)) return ABSOLUTE_FONT_SIZE_PX[s];
  if (s === 'smaller') return parentPx() / 1.2;
  if (s === 'larger')  return parentPx() * 1.2;
  const m = /^(\d*\.?\d+)(px|em|rem|%|pt|pc|in|cm|mm|q|ex|ch|vw|vh|vmin|vmax)?$/.exec(s);
  if (!m) return parentPx();                                             // unparseable / negative → inherit
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case undefined: return n === 0 ? 0 : parentPx();                     // unitless: only `0` is a valid length
    case 'em':      return n * parentPx();
    // On `font-size` itself, `ex` / `ch` measure the PARENT's font — this element's is what
    // they're being used to compute. The factors are the font file's own (x-height, `0` advance),
    // the same ones every other length reads: Chrome sizes `2ex` at 16px Arial to 16.906px and
    // `3ch` to 26.695px, where the flat 0.5em this used to answer said 16 and 24.
    case 'ex': case 'ch': {
      const p = el._parent && el._parent.nodeType === NODE_ELEMENT ? el._parent : el;
      const factor = m[2] === 'ch' ? chFactor(computedFontFamily(p), fontKeyOf(p))
                                   : exFactor(computedFontFamily(p), fontKeyOf(p));
      return n * parentPx() * factor;
    }
    case '%':       return n / 100 * parentPx();
    case 'rem': { const root = el.ownerDocument && el.ownerDocument.documentElement;
                  return n * (root && root !== el ? computedFontSizePx(root) : DEFAULT_FONT_SIZE_PX); }
    // Viewport units need no font at all, so they resolve here rather than through the parent:
    // `font-size: 5vw` is how a responsive page scales its type, and inheriting instead left it
    // at the parent's size.
    case 'vw': case 'vh': case 'vmin': case 'vmax': {
      const vp = currentViewport();
      const basis = m[2] === 'vw' ? vp.width : m[2] === 'vh' ? vp.height
                  : m[2] === 'vmin' ? Math.min(vp.width, vp.height) : Math.max(vp.width, vp.height);
      return n * basis / 100;
    }
    default: { const f = CSS_ABSOLUTE_UNIT_PX[m[2]]; return f !== undefined ? n * f : parentPx(); }
  }
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
// The weight/style half of a font-table key, exactly as layout.js's `fontOf`
// builds it — the two have to agree or they'd measure with different faces.
function fontKeyOf(el) {
  const weight = computedFontWeight(el);
  const st     = computedFontStyle(el);
  const italic = st === 'italic' || st === 'oblique';
  return (weight >= 600 ? 'bold' : '') + (italic ? (weight >= 600 ? ':italic' : 'italic') : '');
}

export function fontRelativeToPx(el, raw, forFontSize = false) {
  if (raw == null || !el || el.nodeType !== NODE_ELEMENT) return null;
  const m = /^(-?\d*\.?\d+)(em|rem|ex|ch|pt|pc|in|cm|mm|q|vw|vh|vmin|vmax)$/i.exec(String(raw).trim().toLowerCase());
  if (!m) return null;
  const unit = m[2];
  const basisOwner = (forFontSize || unit === 'em' || unit === 'ex' || unit === 'ch')
    ? (forFontSize ? el._parent : el)
    : el;
  const fs = (basisOwner && basisOwner.nodeType === NODE_ELEMENT)
    ? computedFontSizePx(basisOwner)
    : DEFAULT_FONT_SIZE_PX;
  const px = fontLengthToPx(parseFloat(m[1]), unit, fs, el);
  return typeof px === 'number' && isFinite(px) ? px : null;
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
  const p = el._parent;
  return (p && p.nodeType === NODE_ELEMENT) ? resolve(p) : dflt;
}
// Computed line-height. `normal` stays `normal`; a <length> / <percentage> resolves to px at
// its DECLARING element's font-size, but a unitless <number> is inherited AS the number and
// re-resolved against the READING element's own font-size (so a child with a larger font
// scales up). So walk to the element that actually declares line-height (it inherits), then
// resolve. Negative / calc / unparseable values are invalid → treated as the initial `normal`.
export function computedLineHeight(el) {
  let owner = el, c = null;
  while (owner && owner.nodeType === NODE_ELEMENT) {
    // …through the UA sheet as well as the author cascade: a form control's `line-height: normal`
    // comes from its UA `font` shorthand, and it STOPS this walk — without it every button on a
    // page with `body { line-height: 1.5 }` inherited that and measured 6px too tall.
    const raw = declaredValue(owner, 'line-height') ?? uaDefault(owner, 'line-height');
    if (raw != null && raw !== '') {
      const v = String(raw).trim().toLowerCase();
      if (v !== 'inherit' && v !== 'unset') { c = v; break; }             // a real declaration → resolve it
    }
    owner = owner._parent;                                                // else keep inheriting up
  }
  if (c == null || c === 'normal' || c === 'initial' || c === 'revert' || c === 'revert-layer') return 'normal';
  if (/^\d*\.?\d+$/.test(c)) return formatPx(parseFloat(c) * computedFontSizePx(el));   // <number> → × own font-size
  const fs = computedFontSizePx(owner);
  let m = /^(\d*\.?\d+)%$/.exec(c);
  if (m) return formatPx(parseFloat(m[1]) / 100 * fs);
  m = /^(\d*\.?\d+)(px|em|rem|pt|pc|in|cm|mm|q|ex|ch)$/.exec(c);
  if (m) return formatPx(fontLengthToPx(parseFloat(m[1]), m[2], fs, owner));
  return 'normal';                                                        // negative / calc / unparseable
}
// Computed font-weight (a keyword resolves to its numeric form; `bolder`/`lighter` bracket
// off the inherited weight per the CSS table). Inherits; initial/revert → 400.
function relativeFontWeight(base, dir) {
  if (dir === 'bolder') return base < 400 ? 400 : base < 600 ? 700 : 900;
  return base < 600 ? 100 : base < 800 ? 400 : 700;                       // lighter
}
// Does `el` change the font at all — an author declaration OR a UA default
// (`<b>`/`<h1>` are bold, `<code>`/`<pre>` are monospace, `<h1>` is 2em)? Layout
// takes a fast path for elements that don't, reusing the parent's resolved font
// and line box, so this has to see the UA cascade or a `<b>` would silently
// measure in the parent's weight. ONE call replaces four `declaredValue`s on the
// hot path.
const FONT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style'];
export function declaresOwnFont(el) {
  for (let i = 0; i < FONT_PROPS.length; i++) {
    const k = FONT_PROPS[i];
    if (declaredValue(el, k) != null) return true;
    if (uaDefault(el, k) !== undefined) return true;
  }
  return false;
}

// `border-collapse` / `border-spacing` for the table pass, through the SAME resolver
// getComputedStyle uses. It already puts the UA origin above inheritance and walks to
// the nearest declaring ancestor, which is exactly the resolution these two need —
// layout must never grow a second one (see `computedLineHeight`).
export function computedBorderCollapse(el) {
  const r = readComputed(el, 'border-collapse');
  const v = r && r.hit && r.value ? String(r.value).trim().toLowerCase() : '';
  return v || 'separate';
}
export function computedBorderSpacing(el) {
  const r = readComputed(el, 'border-spacing');
  const v = r && r.hit && r.value ? String(r.value).trim() : '';
  // `border-spacing` takes non-negative lengths, and an INVALID declaration is no
  // declaration at all: the UA rule answers in its place, so a `<table>` written
  // `border-spacing: -4px` still spaces at 2px (Chrome-measured). The cascade
  // doesn't validate values, so the check lives at the one read that cares.
  if (!v || v.split(/\s+/).every((part) => !part.startsWith('-'))) return v;
  return uaDefault(el, 'border-spacing') || '';
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
  const c = declaredValue(el, 'font-weight');
  // The UA sheet sits below author rules and above inheritance: `<b>` / `<th>` / `<h1>` are bold
  // whatever their parent says. (Same shape for font-style below.)
  if (c == null || c === '') {
    const ua = uaDefault(el, 'font-weight');
    return ua !== undefined ? parseInt(ua, 10) : inheritComputed(el, computedFontWeight, 400);
  }
  const s = String(c).trim().toLowerCase();
  if (s === 'normal' || s === 'initial' || s === 'revert' || s === 'revert-layer') return 400;
  if (s === 'bold') return 700;
  if (s === 'inherit' || s === 'unset') return inheritComputed(el, computedFontWeight, 400);
  if (s === 'bolder' || s === 'lighter') return relativeFontWeight(inheritComputed(el, computedFontWeight, 400), s);
  const n = parseInt(s, 10);
  return (n >= 1 && n <= 1000) ? n : 400;
}
// Computed font-style: the cascaded keyword (`italic` / `oblique[ <angle>]` / `normal`).
// Inherits; initial/revert → normal.
export function computedFontStyle(el) {
  const c = declaredValue(el, 'font-style');
  if (c == null || c === '') {
    const ua = uaDefault(el, 'font-style');
    return ua !== undefined ? ua : inheritComputed(el, computedFontStyle, 'normal');
  }
  const s = String(c).trim().toLowerCase();
  if (s === 'inherit' || s === 'unset') return inheritComputed(el, computedFontStyle, 'normal');
  if (s === 'italic' || s === 'normal' || s.startsWith('oblique')) return s;
  return 'normal';
}
// Computed opacity as a number in [0, 1] (a percentage divides by 100). opacity does NOT
// inherit, so `unset`/`initial` are the initial 1 while an explicit `inherit` copies the
// PARENT's computed opacity; the initial is 1, and calc()/unresolvable falls back to 1.
function computedOpacity(el) {
  const c = declaredValue(el, 'opacity');
  if (c == null || c === '') return 1;
  const s = String(c).trim().toLowerCase();
  if (s === 'initial' || s === 'unset' || s === 'revert' || s === 'revert-layer') return 1;
  if (s === 'inherit') { const p = el._parent; return (p && p.nodeType === NODE_ELEMENT) ? computedOpacity(p) : 1; }
  const n = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  if (!isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// A CSS-WIDE KEYWORD is resolved BEFORE any property-specific interpretation: it is a declared
// value the cascade can produce for ANY property, and what it means doesn't depend on that
// property's grammar. Resolving it only in the generic reader meant every earlier branch saw the
// literal word — `border: inherit` reported a border-top-width of `"inherit"`, and `margin: inherit`
// reported '' from the px-reportable branch, both where Chrome inherits the parent's value
// (measured). This only DETECTS the keyword; `readComputedGeneric` is the one place that knows what
// each of them means, and reimplementing that here got `revert` wrong on the first attempt.
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
function declaresCssWide(el, key) {
  // A custom property is exempt: `--x: inherit` is a token sequence whose value IS the word.
  if (key.startsWith('--')) return false;
  const declared = declaredValue(el, key);
  return declared != null && CSS_WIDE_KEYWORDS.has(String(declared).trim().toLowerCase());
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
  const d = computedDisplayFor(el);
  if (d === 'contents') return true;
  return d === 'inline' && !REPLACED_TAGS.has(el._tag);
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

// One size DECLARATION, resolved to what `getComputedStyle` reports — or null when it needs a used
// value we can't produce. Shared by the author and UA origins (see the call sites): the cascade
// already picked a winner, and how a value resolves depends on the VALUE, never on which sheet it
// came from.
function resolveSizeDeclaration(el, key, raw) {
  const t = String(raw).trim();
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
    return !SIZE_KEYWORD_OK.has(key) && hasUsedBox(el) ? null : { hit: true, value: t.toLowerCase() };
  }
  return null;
}

function readComputed(el, key) {
  // Before the CSS-wide branch: `usedOverflow` resolves those itself, and the pairing rule has
  // to apply to the result (an `overflow-x: inherit` beside a `hidden` reports `auto`).
  if (key === 'overflow-x') return { hit: true, value: usedOverflow(el, 'x') };
  if (key === 'overflow-y') return { hit: true, value: usedOverflow(el, 'y') };
  if (key === 'direction') {
    // ONE funnel: `flowSides` resolves this property for the whole driver — it inherits through
    // the flat tree, it takes the `dir` attribute's half from the DOM layer (`_ownDirectionality`,
    // where `dir=auto`'s first-strong character and `<bdi>` belong, with the text they read), and
    // a CSS declaration beats the attribute. Answering here from a SECOND walk is what let
    // `getComputedStyle(el).direction` and `margin-inline-start` disagree about the same element
    // — measured at twenty divergent cases, in both directions at different times.
    return { hit: true, value: flowSides(el).rtl ? 'rtl' : 'ltr' };
  }

  if (declaresCssWide(el, key)) return readComputedGeneric(el, key);
  // ONE geometry: `getComputedStyle(el).width` and `el.getBoundingClientRect()` are
  // two views of the same box. Before this the style side answered with whatever the
  // author wrote — `10em`, `50%`, or `''` for an auto width — so a page that reads a
  // size back through the style API got a string it couldn't do arithmetic on.
  if (USED_VALUE_PROPS.has(key) && !skipsUsedValue(el, key)) {
    const used = usedStyleOf(el, key);
    if (used != null) return { hit: true, value: formatPx(used) };
  }
  // §9.7: `float` computes to `none` on an out-of-flow box — it is POSITIONED, not floated
  // (Chrome-measured, and the layout engine's `isFloated` says the same).
  if (key === 'float') {
    const pos = declaredValue(el, 'position');
    const p = pos == null ? '' : String(pos).trim().toLowerCase();
    if (p === 'absolute' || p === 'fixed') return { hit: true, value: 'none' };
  }
  if (key === 'display')    return { hit: true, value: computedDisplayFor(el) };
  if (key === 'visibility') return { hit: true, value: computedVisibilityFor(el) };
  // font-size resolves to a concrete px length without layout (relative units against the
  // inherited parent size); report it so em/rem-driven app JS and canvas text metrics work.
  if (key === 'font-size')   return { hit: true, value: formatPx(computedFontSizePx(el)) };
  if (key === 'opacity') return { hit: true, value: String(+computedOpacity(el).toFixed(6)) };
  // The other inherited font longhands are likewise layout-free computed values (they were
  // captured by the cascade but previously reported their always-initial value).
  if (key === 'font-weight') return { hit: true, value: String(computedFontWeight(el)) };
  if (key === 'font-style')  return { hit: true, value: computedFontStyle(el) };
  if (key === 'line-height') return { hit: true, value: computedLineHeight(el) };
  if (key === 'font-family') {
    const c = declaredValue(el, 'font-family');
    if (c != null && c !== '') {
      const s  = String(c).trim();
      const sl = s.toLowerCase();
      if (sl !== 'inherit' && sl !== 'unset') {
        // `initial`/`revert` compute to the UA default font, which we don't model a value for.
        return (sl === 'initial' || sl === 'revert' || sl === 'revert-layer') ? { hit: false } : { hit: true, value: serializeFontFamily(s) };
      }
    }
    const ua = uaDefault(el, 'font-family');   // `<code>` / `<pre>` are monospace whatever inherits
    if (ua !== undefined) return { hit: true, value: ua };
    const p = el._parent;   // inherits
    if (p && p.nodeType === NODE_ELEMENT) return readComputed(p, 'font-family');
    return { hit: false };
  }

  // `direction` computes from the HTML directionality algorithm (the dir
  // attribute + dir=auto first-strong-char + inheritance) unless author CSS
  // sets an explicit `direction` (style="" / a stylesheet rule), which wins.

  // `z-index`'s COMPUTED value is the specified integer regardless of position —
  // the "only applies to a positioned box" is a used-value concept, so
  // getComputedStyle reports the cascaded value (an integer, or the `auto` initial)
  // even on a static box. It falls through to the cascade resolution below.

  // `border-style` computes to its cascaded keyword, else the initial `none`.
  if (key === 'border-style') {
    // Through the same resolver the per-side longhands and the `border-width` shorthand use, or the
    // two disagree: a `<button>` reported `border-top-style: outset` and `border-style: none`.
    const shared = borderSharedSources(el);
    const vals = ['top', 'right', 'bottom', 'left'].map((side) => {
      const st = resolveBorderSide(el, side, shared).style;
      return st ? String(st).toLowerCase() : 'none';
    });
    return { hit: true, value: combineBox(vals) };
  }
  // A per-side `border-*-width` computes to 0 when its border-style is none/hidden, else the
  // width the cascade resolves for that side — including one supplied only via the `border` /
  // `border-{side}` / `border-width` shorthands (expanded on demand).
  if (BORDER_SIDE_WIDTH_RE.test(key)) {
    const side = key.slice('border-'.length, -'-width'.length);
    const { width, style } = resolveBorderSide(el, side);
    return { hit: true, value: computedBorderWidth(width, style) };
  }
  // The `border-width` shorthand: the 1–4-value box form over the four resolved side widths
  // (`combineBox` drops mirror-equal trailing sides, as browsers serialize it).
  if (key === 'border-width') {
    const shared = borderSharedSources(el);
    const vals = ['top', 'right', 'bottom', 'left'].map(s => {
      const { width, style } = resolveBorderSide(el, s, shared);
      return computedBorderWidth(width, style);
    });
    return { hit: true, value: combineBox(vals) };
  }
  // `border-color` + every per-side / logical border-*-color longhand computes to the
  // cascaded border colour, or — when unset / `currentcolor` — to the element's own
  // computed `color`. Per-side overrides aren't captured; the uniform `border` /
  // `border-color` value applies to every side (the cases getComputedStyle reports here).
  if (key === 'border-color' || BORDER_SIDE_COLOR_RE.test(key)) {
    // Prefer an explicitly-set value for THIS side (inline / captured); only when the
    // side has none of its own does the uniform `border`/`border-color` value apply.
    let bc = declaredValue(el, key);
    if (bc == null || bc === '') bc = declaredValue(el, 'border-color');
    if (bc == null || bc === '') bc = uaDefault(el, key);
    if (!bc || String(bc).toLowerCase() === 'currentcolor') return { hit: true, value: readComputed(el, 'color').value };
    return { hit: true, value: normalizeColor(bc) };
  }

  // Geometry generally needs layout. But a box-model length the cascade resolves to a
  // CONCRETE px — an author `width: 100px` / `margin-left: 10px`, or a presentational hint
  // like `<canvas width>` — equals its used value with no layout, so report it (a unitless
  // `0` normalises to `0px`). Percentages / `auto` / `calc` / intrinsic sizing still need
  // layout → empty. Positioning insets (top/right/bottom/left) and border widths stay
  // layout-only: their used value depends on layout / border-style.
  // An outline / column-rule width is a plain keyword-to-px resolution: unlike a BORDER, its style
  // has no bearing on it. Chrome measured across every combination — plain `3px` (`medium`),
  // `thick` `5px`, and a declared `2px` stays `2px` whether the style is `none` or `solid`.
  if (key === 'outline-width' || key === 'column-rule-width') {
    const w = declaredValue(el, key);
    if (w == null || w === '') return { hit: true, value: BORDER_WIDTH_KEYWORDS.medium };
    const t = String(w).trim().toLowerCase();
    return { hit: true, value: BORDER_WIDTH_KEYWORDS[t] || (/^-?\d*\.?\d+px$/.test(t) ? t : BORDER_WIDTH_KEYWORDS.medium) };
  }

  // A resolved-value read of a SHORTHAND is serialized from the computed longhands — which is what
  // makes `#r { margin: 1px }` and `style="margin: 1px"` report the same thing. Reading it off the
  // declaration block instead only ever worked for the inline case, by accident of the fallback.
  // If any longhand is unknowable the shorthand is too.
  if (isRegularShorthand(key)) {
    const longhands = shorthandLonghands(key);
    const parts = Object.create(null);
    let known = true;
    for (const lh of longhands) {
      const r = readComputed(el, lh);
      if (!r.hit || r.value === '') { known = false; break; }
      parts[lh] = r.value;
    }
    if (known) return { hit: true, value: shorthandGet(parts, key) };
    // A shorthand carrying a `var()` needs nothing extra here: it fills its longhands' slots with a
    // pending substitution, and each of those reads back above through `declaredValue`.
    return { hit: false };
  }

  // `text-decoration` is a shorthand: a browser serializes it from the longhands, so hardcoding
  // `none` contradicted `text-decoration-line` the moment the UA sheet or a rule set one (`<del>`
  // reported the line as `line-through` and the shorthand as `none`).
  if (key === 'text-decoration') {
    const line = readComputed(el, 'text-decoration-line').value || 'none';
    if (line === 'none') return { hit: true, value: 'none' };
    // A shorthand serialization OMITS every component still at its initial value (Chrome measured:
    // `text-decoration: underline` → `underline`; only `underline dotted blue` gives the full
    // `underline dotted rgb(0, 0, 255)`), which is what `getComputedStyle(el).textDecoration ===
    // 'underline'` in the spec suite is checking.
    const parts = [line];
    const style = declaredValue(el, 'text-decoration-style');
    if (style != null && String(style).trim().toLowerCase() !== 'solid') parts.push(readComputed(el, 'text-decoration-style').value);
    const color = declaredValue(el, 'text-decoration-color');
    if (color != null && !/^currentcolor$/i.test(String(color).trim())) parts.push(readComputed(el, 'text-decoration-color').value);
    return { hit: true, value: parts.join(' ') };
  }

  // A `<time>`'s COMPUTED value is in seconds, whatever the author wrote (CSS Values 4 §7.2, and
  // Chrome measured: `animation: k 250ms` reports `0.25s`). Reporting the authored `250ms` breaks
  // the everyday `parseFloat(style.animationDuration) * 1000` — Discourse's `waitForAnimationEnd`
  // reads it as 250 SECONDS and its modal stays `is-animating` until the test times out.
  if (TIME_VALUED_PROPS.has(key)) {
    const c = declaredValue(el, key);
    // …only when something declares one: with nothing declared the initial value comes from the
    // generic path below, which already reports it in seconds.
    if (c != null) return { hit: true, value: secondsList(String(c)) };
  }

  // Reached only when the element has NO BOX — `display: none`, or a document that
  // hasn't been laid out; a rendered one was answered from the layout engine at the
  // top of `readComputed`. The resolved value is then the COMPUTED one, which is
  // what a browser reports: Chrome on `display: none; width: 10em` says `160px`,
  // and leaves `height: auto` as `auto`.
  if (PX_REPORTABLE_LAYOUT_PROPS.has(key)) {
    const c = declaredValue(el, key);
    if (c != null) return resolveSizeDeclaration(el, key, c) || { hit: false };
    // Nothing the AUTHOR declares — but the UA stylesheet is an origin above the initial value and
    // it carries real values (a `<td>`'s 1px padding, a `<fieldset>`'s `min-width: min-content`).
    // It answers first, resolved by the SAME door the author's declaration goes through: one
    // origin's value is not a different KIND of value, and reading only px here left a UA keyword
    // falling through to the initial — a fieldset reported `min-width: 0px` where Chrome says
    // `min-content`. Layout resolves the same value through `resolveLayoutProp`.
    const ua = uaDefault(el, key);
    if (ua != null) {
      const resolved = resolveSizeDeclaration(el, key, ua);
      if (resolved) return resolved;
    }
    // A property whose initial is a LENGTH (or the keyword `none`) computes
    // to it with no layout at all — `margin-left` on a plain div is `0px` in every browser, and
    // answering '' there was the same "no value" that page code reads as an answer. `width` /
    // `height` keep falling through: their initial is `auto`, where the reported value is the USED
    // one and we would be guessing. (The `min-*` pair resolves above — `0px`, or `auto` for a flex
    // item — and `max-*` reports its `none`.)
    const initial = computedInitialValue(key, el);
    if (initial === null) return { hit: false };
    // The `min-*` pair resolves to a definite answer either way — `0px`, or `auto` for a flex /
    // grid item — so it reports whatever that resolution produced. For the rest, only a LENGTH or
    // `none` needs no layout; `width`'s `auto` would be a guess at the used value.
    if (MIN_SIZE_PROPS.has(key)) return { hit: true, value: initial };
    if (/^-?\d*\.?\d+px$/.test(initial) || initial === 'none') return { hit: true, value: initial };
    // `auto` — the initial for `width` / `height` / the insets. A rendered box's SIZE was answered
    // from layout above, so reaching here means either no box (where `auto` is the computed value
    // a browser reports) or a box with no used size of its own (an inline, `display: contents`) —
    // and Chrome reports `auto` for both. It is also what a STATIC element's undeclared insets
    // resolve to, which is the case that actually arrives here on a rendered page.
    return initial === 'auto' ? { hit: true, value: 'auto' } : { hit: false };
  }
  if (LAYOUT_COMPUTED_PROPS.has(key)) return { hit: false };

  // A declared value that is a CSS-WIDE KEYWORD skips every property-specific branch above and is
  // resolved by the generic reader below, which is the ONE place that knows what each keyword
  // means: `revert` rolls back to the UA origin and, finding nothing there, falls through to
  // inheritance; `unset` splits on whether the property inherits; `initial` skips the UA origin.
  // (Reached via the early return at the top of `readComputed`.)
  return readComputedGeneric(el, key);
}

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

// The two properties that take `match-parent` (CSS Text 4), under both spellings: Chrome does not
// parse the standard one at all (`CSS.supports('text-align','match-parent')` is false) and ships
// it as `-webkit-match-parent`, so a page written for Chrome uses the prefix and a page written to
// the spec uses the bare keyword. Both mean the same thing here.
const MATCH_PARENT_PROPS = new globalThis.Set(['text-align', 'text-align-last']);
const MATCH_PARENT_KEYWORDS = new globalThis.Set(['match-parent', '-webkit-match-parent']);

// `match-parent` takes the PARENT's computed value, and resolves a `start` / `end` there against
// the PARENT's direction — unconditionally, as CSS Text 4 says and as Chrome does under its own
// spelling (measured: parent `ltr`+`start` is `left` whatever the CHILD's direction is; parent
// `rtl`+`end` is `left`; `center` and `left` pass through). The parent's direction comes from
// `flowSides`, which inherits it properly AND honours the `dir` attribute — the plain
// `direction` read does neither (see the RTL backlog).
function matchParent(el, key) {
  const parent = el._parent && el._parent.nodeType === NODE_ELEMENT ? el._parent : null;
  if (!parent) return computedInitialValue(key, el);
  const inherited = readComputed(parent, key).value;
  const value = (inherited == null || inherited === '') ? computedInitialValue(key, parent) : inherited;
  const keyword = String(value).trim().toLowerCase();
  if (keyword !== 'start' && keyword !== 'end') return value;
  const ltr = !flowSides(parent).rtl;
  return keyword === 'start' ? (ltr ? 'left' : 'right') : (ltr ? 'right' : 'left');
}
function readComputedGeneric(el, key) {
  // Any other (layout-free) property: resolve through the cascade, then
  // fall back to the UA / inherited initial value.
  const cascaded = declaredValue(el, key);
  let cssWide = null;                       // the css-wide keyword the cascade produced, if any
  if (cascaded != null && cascaded !== '') {
    const resolved = cascaded;              // already substituted — `declaredValue` owns that
    let cw = String(resolved).trim().toLowerCase();
    if (MATCH_PARENT_KEYWORDS.has(cw) && MATCH_PARENT_PROPS.has(key)) {
      return { hit: true, value: matchParent(el, key) };
    }
    // A CSS-wide keyword computes rather than serializing literally: `inherit` (and `unset`
    // on an inherited prop) takes the parent's computed value; `initial` / `revert` (and
    // `unset` on a non-inherited prop) fall through to the initial-value lookup below.
    if (cw === 'inherit' || cw === 'unset' || cw === 'initial' || cw === 'revert' || cw === 'revert-layer') {
      cssWide = cw;
      if (cw === 'inherit' || (cw === 'unset' && INHERITED_PROPERTIES.has(key))) {
        const parent = el._parent;
        if (parent && parent.nodeType === NODE_ELEMENT) return readComputed(parent, key);
      }
    } else {
      // Colour-valued props normalise to the rgb()/rgba() forms browsers report. A
      // `background-image` `url(...)` computes to an ABSOLUTE URL: a cascade-sourced value is
      // already absolutized (per originating sheet, at append time), so resolving it again
      // against the document base is a no-op; an INLINE-sourced value is still relative, and the
      // document base is its correct base. Gradient color stops resolve to rgb()/rgba() too.
      // `background-position` canonicalizes keyword+offset pairs to the reported `x y` form.
      let value;
      if (isColorValued(key)) {
        // `currentcolor` never survives to a resolved value: it is the element's own computed
        // `color`, which is what a colour parser downstream expects to receive. (The per-side
        // border branch above resolves it the same way.) On `color` itself it means INHERIT — not
        // a self-reference, which would recurse forever.
        value = /^currentcolor$/i.test(String(resolved).trim())
          ? inheritedColor(el, key)
          : normalizeColor(resolved);
      } else if (key === 'background-image') {
        value = resolveCssUrls(resolved, documentBaseUrl());
        if (value.toLowerCase().indexOf('gradient(') !== -1) {
          const cc = /currentcolor/i.test(value) ? (readComputed(el, 'color').value || 'rgb(0, 0, 0)') : null;
          value = normalizeGradientColors(value, cc);
        }
      } else if (KEYWORD_LENGTHS[key] && KEYWORD_LENGTHS[key][cw] !== undefined) {
        value = KEYWORD_LENGTHS[key][cw];
      } else if (ZERO_NORMALIZED_PROPS.has(key)) {
        value = normalizeZeroLengths(resolved);
      } else if (key === 'background-position') {
        value = normalizeZeroLengths(canonicalizeBgPosition(resolved));
      } else {
        // Canonical form is applied where the declaration is PARSED — the inline block on the way
        // in, and now the rule capture too — so nothing is re-serialized per read here. Doing it
        // at read time cost a CSS parse per property per element, which timed out Avo's ACE editor
        // (whose values are all distinct, so a memo on the string thrashes).
        value = absolutizeLengths(el, key, resolved);
        // A `calc()` holding a length AND a percentage has a canonical order on the computed
        // surface — the percentage first — which the specified surface deliberately does not
        // apply (it keeps what the author wrote). Without it the same value reads back two ways:
        // one an animation produced, one the author typed. A CUSTOM property is exempt: its
        // computed value IS the specified token stream, and Chrome never reorders one (measured).
        if (key.charCodeAt(0) !== 45 && value.indexOf('%') !== -1 && value.indexOf('calc(') !== -1) {
          value = canonicalLengthPercentage(value) || value;
        }
        // A colour ANYWHERE inside a multi-part value is reported in its rgb()/rgba() form too —
        // `box-shadow: 0 0 4px red` carries one. (Chrome also reorders the colour to the front and
        // fills in the omitted spread; that needs a per-property serializer we don't have, so the
        // component ORDER is still the author's. The colour itself is what a parser downstream
        // reads.)
        if (key === 'transform')                          value = transformMatrix(value, () => borderBoxOf(el));
        else if (key === 'box-shadow' || key === 'text-shadow') {
          // An INVALID shadow is no declaration at all, so the property falls back to its initial.
          const shadow = serializeShadow(value, SHADOW_LENGTHS[key], () => readComputed(el, 'color').value,
                                         el, key === 'box-shadow');
          value = shadow === null ? computedInitialValue(key, el) : shadow;
        }
        else if (COLOR_BEARING_PROPS.has(key)) {
          const filter = serializeFilter(value, () => readComputed(el, 'color').value, el);
          value = filter === null ? computedInitialValue(key, el) : filter;
        }
      }
      return { hit: true, value };
    }
  }

  // The UA stylesheet is an ORIGIN below author rules but above inheritance: `<pre>` is `pre`
  // whatever its parent's `white-space` says, and a link is link-blue inside a red-texted div.
  // Checked here, before the inherited walk, for exactly that reason. An explicit `initial` asks
  // for the CSS initial and so skips this origin; `revert` asks to roll back TO it.
  if (cssWide !== 'initial' && !(cssWide === 'unset' && !INHERITED_PROPERTIES.has(key))) {
    const uaOwn = uaDefault(el, key);
    // A UA value is COMPUTED like any other: a relative length absolutizes. Returning it verbatim
    // reported `<fieldset style="padding-left: revert">` as `0.75em` where Chrome says `12px` —
    // the same "one origin is not a different kind of value" the size branch above settled, and it
    // only became reachable for geometry once a UA rule used `em` for something other than a font.
    if (uaOwn !== undefined) {
      // `match-parent` resolves the same way whichever origin declared it — HTML's own sheet puts
      // it on `<li>`, so this is the arm that actually carries it on a real page.
      if (MATCH_PARENT_PROPS.has(key) && MATCH_PARENT_KEYWORDS.has(String(uaOwn).trim().toLowerCase())) {
        return { hit: true, value: matchParent(el, key) };
      }
      // `medium` is never a computed value: a border width reverting to the UA origin reports the
      // px the keyword stands for (Chrome: `border-width: revert` on a bordered `<img>` is 3px).
      const keyword = BORDER_SIDE_WIDTH_RE.test(key) && BORDER_WIDTH_KEYWORDS[String(uaOwn).trim().toLowerCase()];
      const value = keyword ? keyword
                  : isColorValued(key) ? normalizeColor(uaOwn)
                  : absolutizeLengths(el, key, String(uaOwn));
      return { hit: true, value };
    }
  }

  const revertsToOrigin = cssWide === 'revert' || cssWide === 'revert-layer';
  if ((cascaded == null || cascaded === '' || revertsToOrigin) && INHERITED_PROPERTIES.has(key)) {
    // An inherited property with no value of its own takes the parent's computed value
    // (e.g. an <option> / a <span> inheriting `color` from its <select> / <div> —
    // option-color-inheritance). Walk the node-tree parent recursively.
    // Only a value some ancestor actually DECLARES inherits; one that merely bottomed out at the
    // initial is not handed down, because the initial is resolved against THIS element — that is
    // what makes `text-emphasis-color` (inherited, initial `currentcolor`) report the element's own
    // colour rather than the root's. So walk to the nearest ancestor that DECLARES one and resolve
    // there ONCE — inheritance passes the computed value, so its `var()` / `currentcolor` resolve
    // in that ancestor's context anyway. Recursing per level instead re-ran the whole resolver at
    // every step of a 30-deep tree for a property nothing on the page sets.
    // When no rule anywhere declares the property — the usual case for the long tail of inherited
    // longhands — an inline `style=` is the only thing that could supply one, and that's a lookup
    // in a map already parsed and cached per element. Without this gate every miss ran a full
    // cascade lookup at every level of the tree.
    const setters = shorthandsSetting(key);
    // The gate below skips an ancestor when NO rule declares the longhand — which is exactly the
    // state an unexpandable ancestor shorthand produces, so the shorthands count as rules for it.
    const fromRules = cascadeDeclaresProperty(key) ||
                      (setters ? setters.some(cascadeDeclaresProperty) : false);
    for (let p = el._parent; p && p.nodeType === NODE_ELEMENT; p = p._parent) {
      // A UA default is a real value too — `<pre><span>` inherits `white-space: pre` — and it is
      // invisible to the rule gate, so it is checked first.
      if (uaDefault(p, key) !== undefined) return readComputed(p, key);
      if (!fromRules && !(key in inlineDecls(p))) continue;
      const declared = declaredValue(p, key);
      if (declared != null && declared !== '') return readComputed(p, key);
      // An ancestor may set the property through a SHORTHAND we can't expand, in which case what
      // this element inherits is unknowable — say so rather than fall through to the initial.
      if (setterLeavesUnknown(p, key)) return { hit: false };
    }
  }

  // A border width falls back to the initial `medium`, which is never a computed VALUE: what it
  // computes to is 3px where that side paints and 0px where it does not (Chrome-measured on
  // `border-width: revert`).
  if (BORDER_SIDE_WIDTH_RE.test(key)) {
    const side = key.slice('border-'.length, -'-width'.length);
    return { hit: true, value: computedBorderWidth(null, resolveBorderSide(el, side).style) };
  }
  const initial = computedInitialValue(key, el);
  if (initial === null) return { hit: false };
  // A SHORTHAND we don't expand can set this longhand, and then the cascade never saw the
  // longhand at all — reporting its initial would be a confident wrong answer (`transition:
  // opacity 1s` → `transition-duration: 0s`). Report nothing instead, as we did before initial
  // values existed. (Only the element's own declarations are checked; an inherited longhand set
  // through an ancestor's shorthand is a further gap, in the shorthands we don't expand.)
  if (setterLeavesUnknown(el, key)) return { hit: false };
  // `currentcolor` is the initial of most colour longhands and never survives to a resolved value;
  // any other colour initial normalises to the rgb()/rgba() form a browser reports, exactly as a
  // cascaded one does (`flood-color: black` → `rgb(0, 0, 0)`).
  if (/^currentcolor$/i.test(initial)) return { hit: true, value: inheritedColor(el, key) };
  if (isColorValued(key)) return { hit: true, value: normalizeColor(initial) };
  return { hit: true, value: initial };
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
      return r.hit ? r.value : inline.getPropertyValue(property);
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
  const names = makeComputedNames();
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
      const r = readComputed(el, camelToKebab(key));
      // The fallback target is the element's INLINE declaration, itself a proxy — so a name this
      // resolved style has no value for lands back in `declarationMiss`, not on a raw object.
      return r.hit ? r.value : target[key];
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
  // An element not in a rendered document — detached, or inside a shadow tree whose host is
  // detached — has an EMPTY resolved style (length 0, every property ''); getComputedStyle
  // -detached-subtree. Re-checked per call (never cached), so re-attaching restores the real
  // style. (A connected-but-not-rendered element — `display:none` / outside the flat tree —
  // still resolves here; that finer "being rendered" gate is a separate layout concern.)
  if (!el.isConnected) return emptyComputedDeclaration();
  // A pseudo-element argument that is a colon-prefixed selector but not a valid
  // pseudo-element yields an empty declaration (CSSOM "invalid pseudo-element").
  // A valid pseudo (::before/…) or a colonless string falls through to the
  // originating element's style — we don't model pseudo-element boxes.
  if (pseudoElt != null && pseudoElt !== '' && String(pseudoElt)[0] === ':' && !VALID_PSEUDO_ELEMENT.test(String(pseudoElt))) {
    return emptyComputedDeclaration();
  }
  return el._computedStyleProxy || (el._computedStyleProxy = makeComputedStyleProxy(el));
};

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
