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
import { cascadedProperty, dynamicReadSeq, restoreDynamicSeq, ctxUnsafeReadSeq, restoreCtxUnsafeSeq, ctxEpochOf, cascadeStyleEpoch, ownedByThisRealm, expandShorthandValue, twinName, matchesAnyHideRule, splitImportant, computedVisibility, ownDisplay, inlineDecls, cascadeDeclaresProperty, canExpandShorthand } from './cascade.js';
import { parseStyleDeclList, serializeCssValue, serializeFontFamily, SYSTEM_COLORS, ABSOLUTE_FONT_SIZE_PX, resolveCssUrls, documentBaseUrl, canonicalizeBgPosition, normalizeZeroLengths, splitTopLevel, isSupportedCssPropertyName, isValidDeclarationValue } from './css-utils.js';
import { serializeDeclBlock, expandDeclList, isRegularShorthand, shorthandGet, shorthandExpand, shorthandLonghands, clearNamedLonghands, groupNeedsMove, allGet, allGetPriority, isCoveredByAll, isCssWideKeyword, combineBox, hasSubstitution, pendingSource } from './shorthands.js';
import { currentViewport }               from './media-query.js';
import { chFactor, exFactor }            from './font-metrics.js';
import { hasMathFunction, reduceMathFunctions, simplifySpecifiedMath, ABSOLUTE_UNIT_PX as CALC_ABSOLUTE_PX } from './calc.js';
import { lookup, handles }               from './handles.js';
import { LONGHANDS, INITIAL_VALUES, INHERITED_PROPERTIES, SHORTHAND_LONGHANDS } from './css-property-data.js';

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

const DECL_METHODS = new Set(['cssText', 'getPropertyValue', 'getPropertyPriority',
  'setProperty', 'removeProperty', 'length', 'item', 'parentRule']);

// A CSSStyleDeclaration has an indexed property getter, which by WebIDL makes it a legacy platform
// object whose [[PreventExtensions]] returns false: `Object.freeze(el.style)` throws "TypeError:
// Cannot freeze" and the declaration stays extensible (measured, Chrome 151.0.7922.108). Modelling
// that refusal is not decoration here — our declarations are proxies, and a proxy may only report a
// property its TARGET lacks while that target can still grow one. Letting a caller seal it would
// turn every presence answer below into a TypeError raised from inside the next read.
function declarationsCannotBeSealed() { return false; }

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
function declarationHas(target, key, indexedLength) {
  if (DECL_METHODS.has(key) || key === Symbol.iterator) return true;
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
  const handler = {
    get(_t, prop) {
      // CSSOM: `cssText` is the CANONICAL serialization of the declaration block
      // (`color: red;` — trailing `;`, normalized spacing), not the raw source.
      // CSSOM: `cssText` serializes the declaration block — canonical values AND
      // shorthand reconstruction (longhands collapse to `margin: 1px 2px`).
      if (prop === 'cssText') return serializeDeclBlock(storeDecls(store));
      // The rule a declaration belongs to, or null when it belongs to an element or to nothing
      // (`new CSSStyleDeclaration()`). Only `ruleStyle` passes an owner.
      if (prop === 'parentRule') return store.owner || null;
      // The `getPropertyValue`/`setProperty`/`removeProperty` methods take a literal
      // CSS property name (ASCII-lowercased; custom `--*` props stay case-sensitive) —
      // NOT the IDL camelCase mapping, which is only for named-property access below.
      // A regular shorthand combines its longhands (`overflow` from overflow-x/-y).
      if (prop === 'getPropertyValue')    return name => propValue(store, cssName(name));
      if (prop === 'getPropertyPriority') return name => propPriority(store, cssName(name));
      // `setProperty` value is IDL `[LegacyNullToEmptyString]`: `null` clears (→ ''), while
      // `undefined` stringifies to 'undefined' (then fails value validation → a no-op, not a clear).
      if (prop === 'setProperty')         return (n, v, priority) => { const cn = cssName(n); if (isSettableProperty(cn)) writeStoreProp(store, cn, v === null ? '' : String(v), priority); };
      if (prop === 'removeProperty')      return name => removeStoreProp(store, cssName(name));
      // CSSStyleDeclaration is an indexed getter: `style[0]` / `style.item(0)` is the
      // 0-based property NAME, and it is iterable over those names. `length` counts them.
      if (prop === 'length') return Object.keys(storeDecls(store)).length;
      if (prop === 'item') return i => Object.keys(storeDecls(store))[i >>> 0] || '';
      if (prop === Symbol.iterator) return function* () { yield* Object.keys(storeDecls(store)); };
      // Non-string keys (Symbol.toStringTag, …) resolve from the target's prototype.
      if (typeof prop !== 'string') return _t[prop];
      if (/^\d+$/.test(prop)) return Object.keys(storeDecls(store))[+prop] || '';
      // Hot path: a CSS property read returns its value directly. Only on a MISS do we
      // fall back to a prototype Object member (toString / valueOf / constructor / …),
      // so the common value-returning read never pays the proto-chain walk (rule 3).
      const v = propValue(store, camelToKebab(prop));
      if (v !== '') return v;
      if (prop in _t) return _t[prop];
      return '';
    },
    set(_t, prop, value) {
      // Setting cssText PARSES + re-serializes (dropping syntactically invalid
      // declarations), so the stored block is canonical — not the raw assigned text.
      // Unlike a per-property mutation, assigning cssText ALWAYS rewrites the source
      // (CSSOM "set css text" unconditionally invokes "update style attribute"), so it
      // queues a mutation record even when the serialized value is unchanged.
      if (prop === 'cssText') {
        store.write(serializeDeclBlock(expandDeclList(parseStyleDeclList(String(value == null ? '' : value)))));
        return true;
      }
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
      _t[prop] = value;   // an unsupported name (or a symbol key) is a plain expando, not a declaration
      return true;
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
  // IDL camelCase (`backgroundColor`) folds to kebab. A leading `--` (custom
  // property) passes through unchanged; an already-kebab name has no uppercase to
  // fold.
  if (name.indexOf('--') === 0) return name;
  // `cssFloat` is CSSOM's legacy alias for `float` (a reserved word couldn't be an
  // IDL attribute name).
  if (name === 'cssFloat') return 'float';
  const s = name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  // A capitalised vendor prefix (`WebkitFilter`) already folds to a leading dash
  // (`-webkit-filter`); the lowercase legacy form (`webkitFilter`) folds WITHOUT one
  // (`webkit-filter`) and must get it back — CSSOM exposes both spellings for a
  // `-webkit-…` / `-moz-…` / `-ms-…` property.
  return /^(webkit|moz|ms)-/.test(s) ? '-' + s : s;
}

// A literal CSS property name for the method API: ASCII-lowercased, except a
// custom `--*` property (case-sensitive) which passes through verbatim.
function cssName(name) {
  const s = String(name);
  return s.indexOf('--') === 0 ? s : s.toLowerCase();
}

// Whether `setProperty` accepts this (already `cssName`-normalised) name: a supported CSS property
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
  button: 'inline-block', select: 'inline-block', textarea: 'inline-block',
  table: 'table', thead: 'table-header-group', tbody: 'table-row-group',
  tfoot: 'table-footer-group', tr: 'table-row', th: 'table-cell', td: 'table-cell',
  caption: 'table-caption', colgroup: 'table-column-group', col: 'table-column',
  li: 'list-item', summary: 'list-item',
  template: 'none', script: 'none', style: 'none', noscript: 'none',
  head: 'none', title: 'none', meta: 'none', link: 'none',
  option: 'block', optgroup: 'block'
});

// Exported for the layout engine: it needs the USED display (author inline style, stylesheet, then
// the per-tag UA default), not just an author-declared keyword — telling a `<span>` from a `<div>`
// is what makes inline content share a line instead of stacking.
export { computedDisplayFor as usedDisplay };
function computedDisplayFor(el) {
  // The cascaded `display` (inline OR stylesheet — ownDisplay reads both). Report the actual
  // author keyword (flex / grid / inline-block / …), not just the tag default, so app JS can
  // read the layout mode. (We don't lay flex/grid out, but the COMPUTED display value is the
  // specified one regardless.) `display` does NOT inherit.
  const d = ownDisplay(el);
  if (d === 'inherit') { const p = el._parent; return (p && p.nodeType === NODE_ELEMENT) ? computedDisplayFor(p) : 'inline'; }
  if (d === 'unset' || d === 'initial') return 'inline';                         // display's CSS initial
  if (d === 'revert' || d === 'revert-layer') return DEFAULT_DISPLAY[el._tag] || 'block';
  if (d != null) return d;                                                       // none / flex / grid / block / …
  // No author display: honour the UA `[hidden]` / filtered-option `display: none`, else the
  // per-tag default. (ignoreVisibility=true: `visibility` is independent of the display value.)
  if (matchesAnyHideRule(el, true, null, el._attrs.hidden != null)) return 'none';
  if (el._tag === 'option' && el._filtered === true) return 'none';
  return DEFAULT_DISPLAY[el._tag] || 'block';
}

// visibility resolves through the hide-rule cascade (author rule OR inline style) and
// INHERITS; the initial is `visible`. (The inline-only regex this used to run missed every
// stylesheet rule, so getComputedStyle(el).visibility was '' for them.)
function computedVisibilityFor(el) { return computedVisibility(el); }

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
  const seqBefore = dynamicReadSeq();
  const ctxSeqBefore = ctxUnsafeReadSeq();
  const fresh = computeDeclaredValue(el, key);
  restoreDynamicSeq(seqBefore);
  restoreCtxUnsafeSeq(ctxSeqBefore);
  if (fresh === cached) return;
  const where = (el._tag || '?') + (el._attrs && el._attrs.id ? '#' + el._attrs.id : '');
  throw new Error(`[csim] style cache STALE on ${where} ${key}: cached ${JSON.stringify(cached)}, fresh ${JSON.stringify(fresh)}`);
}

// Keyed in a MODULE-LOCAL WeakMap, not on the element. A frame realm evaluates its own copy of this
// bundle with its own `cascadeGeneration()` counter and its own rules; an element property would be
// shared across realms, and both counters start at 0 — so a parent-realm read of a child-realm
// element wrote its (differently-resolved) answer where the child realm read it back as current.
// A per-realm map makes the cache exactly as wide as the cascade that filled it.
const DV_MEMO = new WeakMap();

// `ownedByThisRealm` moved to cascade.js (the hide memos share it); see the guard rationale
// there and on the cache-refusal below.

export function declaredValue(el, key) {
  // Only an element THIS realm's document owns is cacheable. A cross-realm read — the parent
  // resolving a child frame's element — resolves against the PARENT's rules and its own generation
  // counter, and both realms' counters start at 0, so a cached answer would be handed back as
  // current in a cascade that never produced it. (The mis-resolution itself predates this cache:
  // measured identical on the commit before it, so this guard keeps the cache from making a
  // separate, existing bug sticky rather than fixing it.) A DOMParser document is excluded by the
  // same test, which is only ever conservative.
  if (!ownedByThisRealm(el)) return computeDeclaredValue(el, key);
  // A slottable candidate's `::slotted()` applicability can change via shadow-side slot
  // mutations that bump nothing on its ancestor chain — same refusal as the hide memos.
  if (el._parent && el._parent._shadowRoot) return computeDeclaredValue(el, key);
  // Keyed on (rules + dynamic style state, the element's OWN structural context) — deliberately
  // NOT on `settleGen`: a mutation on the other side of the page doesn't change this element's
  // declared values, and the global key made every app-page layout pass start cold. What a
  // mutation CAN change is covered element-locally: `ctxEpochOf` moves when the element's or any
  // ancestor's attributes / child lists do (which is everything a static selector — or an
  // inherited `var()` — can read), dynamic pseudo-classes decline caching via the taint bracket
  // below, and `:has()` via the ctx-unsafe bracket.
  const epoch = cascadeStyleEpoch();
  const ctx = ctxEpochOf(el);
  let entry = DV_MEMO.get(el);
  if (entry === undefined || entry.epoch !== epoch || entry.ctx !== ctx) {
    entry = { epoch, ctx, map: new Map() };
    DV_MEMO.set(el, entry);
  }
  const memo = entry.map;
  if (memo.has(key)) {
    const cached = memo.get(key);
    if (VERIFY_STYLE_CACHE) verifyDeclaredValue(el, key, cached);
    return cached;
  }
  // Bracket the read by SEQUENCE rather than a flag: this function re-enters itself (a `var()`
  // lookup, a font-size resolution), and a flag the inner call cleared would hand the outer one a
  // false "clean".
  const before = dynamicReadSeq();
  const beforeCtx = ctxUnsafeReadSeq();
  const value = computeDeclaredValue(el, key);
  if (dynamicReadSeq() === before && ctxUnsafeReadSeq() === beforeCtx) memo.set(key, value);
  return value;
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
// The `styleStateGen` epoch stays: it is what that rule will key on, `cascadeGeneration` feeds the
// writing-mode memo today, and `spec/cascade_invalidation_spec.rb` pins the behaviour either way.
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
    const root = el && el._ownerDoc && el._ownerDoc.documentElement;
    if (!root || (key === 'font-size' && el === root)) return DEFAULT_FONT_SIZE_PX;
    return computedFontSizePx(root);
  };
  const toPx = (n, unit) => {
    const u = CALC_VIEWPORT_ALIAS[unit] || unit;
    if (u === 'rem')                return n * remBasis();
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

function computeDeclaredValue(el, key) {
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

// Returns null when a layer is INVALID (a length that is no length), which drops the declaration
// — the caller then reports the property's initial, as a browser does. A token we merely can't
// model (a `calc()`) still reports the author's value unchanged.
function serializeShadow(value, lengths, ownColor, el) {
  const layers = splitTopLevel(String(value), ',');
  const out = [];
  for (const layer of layers) {
    const toks = splitTopLevel(layer.trim(), ' ').map(t => t.trim()).filter(Boolean);
    if (!toks.length) return value;
    let inset = false, color = null;
    const nums = [];
    for (const tok of toks) {
      if (/^inset$/i.test(tok)) { inset = true; continue; }
      // Meant as a length, but not a valid one (a percentage, a bare non-zero number, an unknown
      // unit) → the declaration is invalid whole, which is what a browser does with it.
      if (SHADOW_NUMERIC_RE.test(tok)) {
        const len = shadowLengthPx(tok, el);
        if (len === null) return null;
        nums.push(len);
        continue;
      }
      const c = normalizeColor(tok);
      if (/^rgba?\(/.test(c)) { color = c; continue; }
      return value;                              // something we don't model — report it as written
    }
    if (nums.length < 2 || nums.length > lengths) return value;
    while (nums.length < lengths) nums.push('0px');
    // An omitted colour is `currentcolor`, and a resolved value never reports that keyword — the
    // colour-first form exists so a downstream parser can read one, so it has to be there.
    out.push([color || ownColor, ...nums, inset ? 'inset' : null].filter(Boolean).join(' '));
  }
  return out.join(', ');
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
const MONOSPACE = { 'font-family': 'monospace' };
// A table cell's 1px UA padding is load-bearing for geometry, not decoration: it is
// in every column width and every row height a browser reports.
const CELL_PADDING = {
  'padding-top': '1px', 'padding-right': '1px', 'padding-bottom': '1px', 'padding-left': '1px'
};
const UA_DEFAULTS = Object.assign(Object.create(null), {
  pre:      { 'white-space': 'pre', ...MONOSPACE },
  xmp:      { 'white-space': 'pre', ...MONOSPACE },
  plaintext:{ 'white-space': 'pre', ...MONOSPACE },
  listing:  { 'white-space': 'pre', ...MONOSPACE },
  textarea: { 'white-space': 'pre-wrap' },
  // A monospace element also takes the browser's FIXED-font default size — Chrome
  // renders `<code>` at 13px inside 16px body text, which is visible the moment
  // text is measured for real (its run is ~19% narrower than the same string in the
  // surrounding font).
  code: { ...MONOSPACE, 'font-size': '13px' }, kbd: { ...MONOSPACE, 'font-size': '13px' },
  samp: { ...MONOSPACE, 'font-size': '13px' }, tt: { ...MONOSPACE, 'font-size': '13px' },
  ol: { 'list-style-type': 'decimal' },
  b: { 'font-weight': '700' }, strong: { 'font-weight': '700' },
  // Heading sizes are UA style too (`h1 { font-size: 2em }` …). Without them every
  // heading measured — and reported through getComputedStyle — as 16px body text.
  h1: { 'font-weight': '700', 'font-size': '2em'    }, h2: { 'font-weight': '700', 'font-size': '1.5em'  },
  h3: { 'font-weight': '700', 'font-size': '1.17em' }, h4: { 'font-weight': '700', 'font-size': '1em'    },
  h5: { 'font-weight': '700', 'font-size': '0.83em' }, h6: { 'font-weight': '700', 'font-size': '0.67em' },
  th: { 'font-weight': '700', 'text-align': 'center', ...CELL_PADDING },
  td: { ...CELL_PADDING },
  // The two table properties every table's geometry starts from. Both INHERIT, but
  // this UA rule is keyed on the TAG and a declared value outranks an inherited one:
  // a `<table>` inside `div { border-spacing: 10px }` still spaces at 2px, while a
  // `display: table` DIV inherits the 10px (Chrome-verified, both).
  table: { 'border-spacing': '2px', 'border-collapse': 'separate' },
  caption: { 'text-align': 'center' },
  button: { 'text-align': 'center' },
  i: { 'font-style': 'italic' }, em: { 'font-style': 'italic' }, cite: { 'font-style': 'italic' },
  var: { 'font-style': 'italic' }, dfn: { 'font-style': 'italic' }, address: { 'font-style': 'italic' },
  del: { 'text-decoration-line': 'line-through' }, s: { 'text-decoration-line': 'line-through' },
  strike: { 'text-decoration-line': 'line-through' },
  ins: { 'text-decoration-line': 'underline' }, u: { 'text-decoration-line': 'underline' },
  a: { 'text-decoration-line': 'underline', 'cursor': 'pointer', 'color': 'rgb(0, 0, 238)' },
});
// The predicate lives OUTSIDE the value map: everything in that map is reachable as a property
// name, so a `when` key there answers `getComputedStyle(a).when` with a function.
const UA_APPLIES = Object.assign(Object.create(null), {
  a: (el) => el._attrs && el._attrs.href != null,        // `:any-link`, not every <a>
});
// PRESENTATION ATTRIBUTES: the geometry attributes that some elements accept as a style
// declaration rather than as content — `<svg width="40" height="20">`, `<img width="500">`,
// `<canvas width="300">`. They sit in the cascade BELOW everything an author writes, which is
// exactly where `uaDefault` sits, so they resolve through the same door and both the layout engine
// and `getComputedStyle` see them. Chrome measured: an `<svg width="40" height="20">` is 40x20
// where the default object size would say 300x150, and a CSS `height` overrides the attribute
// while the attribute still supplies the width (40x200, not the 400 its `viewBox` ratio implies).
const PRESENTATION_SIZE_TAGS = new Set(['svg', 'img', 'canvas', 'embed', 'object', 'video', 'iframe']);
function presentationSize(el, key) {
  if (key !== 'width' && key !== 'height') return undefined;
  if (!PRESENTATION_SIZE_TAGS.has(el._tag)) return undefined;
  const raw = el._attrs && el._attrs[key];
  if (raw == null) return undefined;
  const t = String(raw).trim();
  // HTML's attributes are bare numbers (or a percentage); SVG's take any CSS length.
  if (/^\d+(\.\d+)?$/.test(t)) return t + 'px';
  return /^-?\d*\.?\d+(px|em|rem|ex|ch|pt|pc|in|cm|mm|q|%|vw|vh|vmin|vmax)$/i.test(t) ? t : undefined;
}
export function uaDefault(el, key) {
  const pres = presentationSize(el, key);
  if (pres !== undefined) return pres;
  const entry = UA_DEFAULTS[el._tag];
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, key)) return undefined;
  const applies = UA_APPLIES[el._tag];
  return (applies && !applies(el)) ? undefined : entry[key];
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
const ZERO_NORMALIZED_PROPS = new Set(['background-size', 'border-spacing']);

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
    const raw = declaredValue(owner, 'line-height');
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
  'inline-size', 'block-size'
  // NOT the insets yet: `top` / `right` / `bottom` / `left` resolve differently in
  // every positioning mode (CSSOM has eight WPT files on it — static, relative,
  // absolute, fixed, sticky, grid, and the no-box cases), and half-answering them is
  // worse than the current "report what was declared". Their own increment.
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
  'min-inline-size', 'min-block-size', 'max-inline-size', 'max-block-size'
]);

function readComputed(el, key) {
  if (declaresCssWide(el, key)) return readComputedGeneric(el, key);
  // ONE geometry: `getComputedStyle(el).width` and `el.getBoundingClientRect()` are
  // two views of the same box. Before this the style side answered with whatever the
  // author wrote — `10em`, `50%`, or `''` for an auto width — so a page that reads a
  // size back through the style API got a string it couldn't do arithmetic on.
  if (USED_VALUE_PROPS.has(key) && !skipsUsedValue(el, key)) {
    const used = usedStyleOf(el, key);
    if (used != null) return { hit: true, value: formatPx(used) };
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
  if (key === 'direction') {
    // CSS keywords are case-insensitive; the cascade captures the raw value
    // (e.g. `direction:RTL`), so fold before comparing.
    const c = declaredValue(el, 'direction');
    const cl = c && String(c).toLowerCase();
    if (cl === 'ltr' || cl === 'rtl') return { hit: true, value: cl };
    // CSS `direction` inherits via the FLAT tree (slot/host) — _cssDirectionality,
    // NOT _directionality (which is the node-tree :dir() walk).
    return { hit: true, value: typeof el._cssDirectionality === 'function' ? el._cssDirectionality() : 'ltr' };
  }

  // `z-index`'s COMPUTED value is the specified integer regardless of position —
  // the "only applies to a positioned box" is a used-value concept, so
  // getComputedStyle reports the cascaded value (an integer, or the `auto` initial)
  // even on a static box. It falls through to the cascade resolution below.

  // `border-style` computes to its cascaded keyword, else the initial `none`.
  if (key === 'border-style') {
    const bs = declaredValue(el, 'border-style');
    return { hit: true, value: bs ? String(bs).toLowerCase() : 'none' };
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
    if (c != null) {
      const t = String(c).trim();
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
      // the USED value, and for the insets we can't produce it yet (their own
      // increment), so it keeps the driver's honest "we don't know" rather than
      // reporting a computed value the browser doesn't.
      if (/^-?\d*\.?\d+%$/.test(t) || /^(auto|none|min-content|max-content|fit-content)$/i.test(t)) {
        // `SIZE_KEYWORD_OK` first: `hasUsedBox` runs a whole layout pass, and asking it before the
        // cheap set membership computed and threw one away on every `max-width: none` read.
        return !SIZE_KEYWORD_OK.has(key) && hasUsedBox(el) ? { hit: false } : { hit: true, value: t.toLowerCase() };
      }
      return { hit: false };
    }
    // Nothing the AUTHOR declares — but the UA stylesheet is an origin above the initial value and
    // it carries real lengths (a `<td>`'s 1px padding). It answers first, and with the same value
    // layout resolves through `resolveLayoutProp`: one origin, one number, whichever side asks.
    const ua = uaDefault(el, key);
    if (ua != null) {
      const t = String(ua).trim();
      if (/^-?\d*\.?\d+px$/.test(t)) return { hit: true, value: t };
      if (/^-?0(\.0+)?$/.test(t))    return { hit: true, value: '0px' };
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

function readComputedGeneric(el, key) {
  // Any other (layout-free) property: resolve through the cascade, then
  // fall back to the UA / inherited initial value.
  const cascaded = declaredValue(el, key);
  let cssWide = null;                       // the css-wide keyword the cascade produced, if any
  if (cascaded != null && cascaded !== '') {
    const resolved = cascaded;              // already substituted — `declaredValue` owns that
    const cw = String(resolved).trim().toLowerCase();
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
        // A colour ANYWHERE inside a multi-part value is reported in its rgb()/rgba() form too —
        // `box-shadow: 0 0 4px red` carries one. (Chrome also reorders the colour to the front and
        // fills in the omitted spread; that needs a per-property serializer we don't have, so the
        // component ORDER is still the author's. The colour itself is what a parser downstream
        // reads.)
        if (key === 'transform')                          value = transformMatrix(value, () => borderBoxOf(el));
        else if (key === 'box-shadow' || key === 'text-shadow') {
          // An INVALID shadow is no declaration at all, so the property falls back to its initial.
          const shadow = serializeShadow(value, key === 'box-shadow' ? 4 : 3, readComputed(el, 'color').value, el);
          value = shadow === null ? computedInitialValue(key, el) : shadow;
        }
        else if (COLOR_BEARING_PROPS.has(key))            value = normalizeEmbeddedColors(value);
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
    if (uaOwn !== undefined) return { hit: true, value: isColorValued(key) ? normalizeColor(uaOwn) : uaOwn };
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
function emptyComputedDeclaration() {
  // Empty, but still a CSSStyleDeclaration: the target inherits the interface prototype so
  // `instanceof` holds and the members the `get` below synthesizes are also the ones `in` reports.
  const proto = globalThis.CSSStyleDeclaration && globalThis.CSSStyleDeclaration.prototype;
  return new Proxy(proto ? Object.create(proto) : {}, {
    get(_t, key) {
      if (key === 'length')   return 0;
      if (key === 'cssText')  return '';
      // A resolved-value declaration is not tied to a rule (CSSOM) — matches
      // makeComputedStyleProxy's `parentRule`.
      if (key === 'parentRule') return null;
      if (key === 'getPropertyValue' || key === 'getPropertyPriority' || key === 'item') return () => '';
      if (key === 'setProperty' || key === 'removeProperty') return computedReadOnly;
      if (key === globalThis.Symbol.iterator) return function* () {};
      // Every property resolves to '' here; the only keys the target can answer for are the
      // prototype members (`toString`, `constructor`), none of which is a CSS property name.
      return key in _t ? _t[key] : (typeof key === 'string' ? '' : undefined);
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
    get(target, key) {
      if (key === 'getPropertyValue') {
        return function (name) {
          const r = readComputed(el, String(name).toLowerCase());
          if (r.hit) return r.value;
          return target.getPropertyValue ? target.getPropertyValue(name) : '';
        };
      }
      if (key === 'cssText')        return '';
      // A resolved-value (computed) declaration is not tied to a rule (CSSOM).
      if (key === 'parentRule')     return null;
      if (key === 'setProperty' || key === 'removeProperty') return computedReadOnly;
      // Enumeration: length / item / indexed getter / iteration walk every supported
      // longhand (plus the element's custom properties), NOT the inline declarations.
      if (key === 'length')         return names(target).length;
      if (key === 'item')           return i => names(target)[i >>> 0] || '';
      if (key === globalThis.Symbol.iterator) return function* () { yield* names(target); };
      if (typeof key === 'string' && /^\d+$/.test(key)) return names(target)[+key] || '';
      if (typeof key !== 'string') return target[key];
      // `cssFloat` is the CSSOM IDL alias for the `float` property (camelToKebab
      // would wrongly yield `css-float`).
      const r = readComputed(el, key === 'cssFloat' ? 'float' : camelToKebab(key));
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
