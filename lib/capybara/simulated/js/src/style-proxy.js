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
import { cascadedProperty, matchesAnyHideRule, splitImportant, computedVisibility, ownDisplay } from './cascade.js';
import { parseStyleDecls, serializeCssValue, serializeFontFamily, SYSTEM_COLORS, ABSOLUTE_FONT_SIZE_PX } from './css-utils.js';
import { serializeDeclBlock, isRegularShorthand, shorthandGet, shorthandExpand, shorthandLonghands, clearNamedLonghands, expandShorthandsInMap, groupNeedsMove, allGet, allGetPriority, isCoveredByAll, isCssWideKeyword, combineBox } from './shorthands.js';
import { lookup, handles }               from './handles.js';
import { LONGHANDS }                     from './css-property-data.js';

// A resolved-value (computed) declaration enumerates every supported CSS LONGHAND, in
// lexicographic order (getComputedStyle-property-order / -logical-enumeration): shorthands
// and env vars are excluded (LONGHANDS is exactly the longhand set), and any custom property
// present on the element is appended (custom / vendor names sort after standard ones). `all`
// is filtered out — it is the reset shorthand, never itself enumerated in a computed style.
// KNOWN GAPS (bounded, no in-scope test): a getComputedStyle read resolves only a handful of
// properties (the rest return ''); only the element's OWN inline custom properties are
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
    const decls = expandShorthandsInMap(parseStyleDecls(s));
    // `font-family` has its own serialization (Chrome-style quote normalization + single-ident
    // unquoting); every other property canonicalizes its numeric/url/string tokens generically.
    for (const k in decls) if (!k.startsWith('--')) decls[k] = k === 'font-family' ? serializeFontFamily(decls[k]) : serializeCssValue(decls[k]);
    holder._declCache = decls;
    holder._declKey = s;
  }
  return holder._declCache;
}

function readStoreProp(store, name) {
  const decls = storeDecls(store);
  return decls[name] != null ? stripImportant(decls[name]) : '';
}


// Property read (getPropertyValue / named access): a regular shorthand combines its
// longhands, everything else reads its own stored value. When the block carries an `all`
// declaration (rare), the cascade-aware `allGet` resolves it instead.
function propValue(store, name) {
  const decls = storeDecls(store);
  if (decls.all !== undefined) return allGet(decls, name);
  // Reuse the already-fetched map rather than re-entering readStoreProp (which fetches it
  // again) — this is the hottest read path (jQuery `.css()` / Floating UI read many props).
  return isRegularShorthand(name) ? shorthandGet(decls, name)
       : (decls[name] != null ? stripImportant(decls[name]) : '');
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

// Round-trip through parseStyleDecls so the serialized text is canonical
// regardless of how the existing value was written (raw `cssText` pastes can leave
// declarations without `;` separators). Removing collapses cleanly; setting
// overwrites. `setProperty(name, value, "important")` folds an explicit priority
// into the stored value as `value !important`; an unknown priority token is a no-op.
function writeStoreProp(store, name, value, priority) {
  const decls = expandShorthandsInMap(parseStyleDecls(store.read() || ''));
  // Fold an explicit priority into the value; an unknown priority token is a no-op.
  let v = value;
  if (v !== '' && v != null) {
    if (/^\s*important\s*$/i.test(String(priority == null ? '' : priority))) {
      v = stripImportant(String(v)) + ' !important';
    } else if (priority != null && priority !== '') {
      return;
    }
  }
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
    store.write(serializeDeclBlock(decls));
    return;
  }
  if (isRegularShorthand(name)) {
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
  store.write(serializeDeclBlock(decls));
}

function removeStoreProp(store, name) {
  const v = propValue(store, name);
  const decls = expandShorthandsInMap(parseStyleDecls(store.read() || ''));
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
  store.write(serializeDeclBlock(decls));
  return v;
}

const DECL_METHODS = new Set(['cssText', 'getPropertyValue', 'getPropertyPriority',
  'setProperty', 'removeProperty', 'length', 'item']);

export function makeDeclProxy(store) {
  // Proxy target is an object (so `typeof style === 'object'`) whose prototype is
  // CSSStyleDeclaration.prototype (so `instanceof` holds). The original `{}` /
  // `function(){}` targets broke both jQuery's `isHiddenWithinTree` typeof check
  // and `el.style instanceof CSSStyleDeclaration`.
  const proto = globalThis.CSSStyleDeclaration && globalThis.CSSStyleDeclaration.prototype;
  const target = proto ? Object.create(proto) : {};
  const handler = {
    get(_t, prop) {
      // CSSOM: `cssText` is the CANONICAL serialization of the declaration block
      // (`color: red;` — trailing `;`, normalized spacing), not the raw source.
      // CSSOM: `cssText` serializes the declaration block — canonical values AND
      // shorthand reconstruction (longhands collapse to `margin: 1px 2px`).
      if (prop === 'cssText') return serializeDeclBlock(storeDecls(store));
      // The `getPropertyValue`/`setProperty`/`removeProperty` methods take a literal
      // CSS property name (ASCII-lowercased; custom `--*` props stay case-sensitive) —
      // NOT the IDL camelCase mapping, which is only for named-property access below.
      // A regular shorthand combines its longhands (`overflow` from overflow-x/-y).
      if (prop === 'getPropertyValue')    return name => propValue(store, cssName(name));
      if (prop === 'getPropertyPriority') return name => propPriority(store, cssName(name));
      if (prop === 'setProperty')         return (n, v, priority) => writeStoreProp(store, cssName(n), v == null ? '' : String(v), priority);
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
      if (prop === 'cssText') {
        store.write(serializeDeclBlock(expandShorthandsInMap(parseStyleDecls(String(value == null ? '' : value)))));
        return true;
      }
      if (typeof prop === 'string') writeStoreProp(store, camelToKebab(prop), String(value));
      return true;
    },
    has(_t, prop) {
      if (DECL_METHODS.has(prop) || prop === Symbol.iterator) return true;
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return +prop < Object.keys(storeDecls(store)).length;
      return propValue(store, camelToKebab(String(prop))) !== '';
    }
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
  // fold. The `webkitFoo` → `-webkit-foo` vendor-prefix rule is handled by the plain
  // fold prepending a `-` for the leading capital.
  if (name.indexOf('--') === 0) return name;
  return name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

// A literal CSS property name for the method API: ASCII-lowercased, except a
// custom `--*` property (case-sensitive) which passes through verbatim.
function cssName(name) {
  const s = String(name);
  return s.indexOf('--') === 0 ? s : s.toLowerCase();
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
// `parseInlineLayout`) use the cascade's `splitImportant`. `IMPORTANT_SUFFIX_RE`
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
const DEFAULT_DISPLAY = {
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
  li: 'list-item', summary: 'list-item',
  template: 'none', script: 'none', style: 'none', noscript: 'none',
  head: 'none', title: 'none', meta: 'none', link: 'none',
  option: 'block', optgroup: 'block'
};

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
function normalizeColor(value) {
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

// Per-side + logical border color longhands, resolved through the uniform `border-color`
// when the side has no value of its own (per-side capture from stylesheets isn't modelled).
const BORDER_SIDE_COLOR_RE = /^border-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)-color$/;
const BORDER_SIDE_WIDTH_RE = /^border-(top|right|bottom|left)-width$/;

// Expand a cascaded border shorthand (`border` / `border-top` / `border-width` / `border-style`)
// to a { longhand: value } map, or null when unset / unparseable.
function borderShorthandMap(el, name) {
  const v = cascadedProperty(el, name);
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
  take(cascadedProperty(el, `border-${side}-width`), cascadedProperty(el, `border-${side}-style`));
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
// longhands. Percentages / auto / calc still fall through to the layout gate above. Insets and
// border widths are deliberately excluded (their used value is layout- / border-style-dependent).
const PX_REPORTABLE_LAYOUT_PROPS = new Set([
  'width','height','min-width','min-height','max-width','max-height',
  'margin-top','margin-right','margin-bottom','margin-left',
  'padding-top','padding-right','padding-bottom','padding-left',
]);
// `border-width` keyword → computed length (medium is the initial).
const BORDER_WIDTH_KEYWORDS = { thin: '1px', medium: '3px', thick: '5px' };

// UA / inherited initial values for layout-free properties, returned when
// no declaration applies. Anything not listed falls back to '' (we don't
// claim a computed value we can't justify without layout).
const COMPUTED_INITIAL_VALUES = {
  'opacity': '1', 'position': 'static', 'z-index': 'auto', 'float': 'none',
  'clear': 'none', 'font-weight': '400', 'font-style': 'normal',
  'text-align': 'start', 'text-transform': 'none', 'text-decoration': 'none',
  'white-space': 'normal', 'overflow': 'visible', 'overflow-x': 'visible',
  'overflow-y': 'visible', 'box-sizing': 'content-box', 'cursor': 'auto',
  'pointer-events': 'auto', 'vertical-align': 'baseline',
  'letter-spacing': 'normal', 'word-spacing': 'normal', 'direction': 'ltr',
  'text-indent': '0px', 'border-collapse': 'separate', 'table-layout': 'auto',
  'flex-direction': 'row', 'flex-wrap': 'nowrap', 'order': '0',
  'justify-content': 'normal', 'align-items': 'normal', 'align-content': 'normal',
  'align-self': 'auto',
  'color': 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)',
};
// Captured properties that INHERIT: with no cascaded value of their own, the
// computed value comes from the parent (CSS inheritance). `direction` / `visibility`
// have their own dedicated resolution above; the rest fall through to the walk.
const INHERITED_CAPTURED_PROPS = new Set(['color', 'text-transform', 'white-space', 'text-align', 'cursor', 'pointer-events']);

// The initial font-size (the `medium` keyword). The absolute-size keyword table lives in
// css-utils (ABSOLUTE_FONT_SIZE_PX), shared with the canvas `font` parser.
const DEFAULT_FONT_SIZE_PX = 16;
// Absolute CSS length units → px (at 96dpi). Font-relative units (em/ex/ch/rem/%) are NOT
// here — they depend on a font-size the caller supplies. Shared by every length resolver so
// a unit factor lives in one place.
const CSS_ABSOLUTE_UNIT_PX = {
  px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 25.4 / 4,
};
// Computed font-size in px. font-size INHERITS and resolves relative units against the
// PARENT's computed font-size (em / % / smaller / larger) or the root's (rem); an absolute
// length or size keyword is layout-free. So getComputedStyle can report it (and it backs the
// canvas em/rem/lh resolution, which reads `getComputedStyle(el).fontSize`). `parentPx` is a
// LAZY closure so an absolute own value short-circuits before any ancestor walk (rule 3).
function computedFontSizePx(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return DEFAULT_FONT_SIZE_PX;
  const parentPx = () => {
    const p = el._parent;
    return (p && p.nodeType === NODE_ELEMENT) ? computedFontSizePx(p) : DEFAULT_FONT_SIZE_PX;
  };
  const cascaded = cascadedProperty(el, 'font-size');
  if (cascaded == null || cascaded === '') return parentPx();            // unset → inherit
  const s = String(resolveCssVars(el, cascaded)).trim().toLowerCase();
  // CSS-wide keywords: `initial` / `revert` / `revert-layer` compute to the property initial
  // (medium = 16px — we model no UA font-size rules); `inherit` / `unset` take the parent
  // (font-size inherits, so `unset` ≡ `inherit`).
  if (s === 'initial' || s === 'revert' || s === 'revert-layer') return DEFAULT_FONT_SIZE_PX;
  if (s === 'inherit' || s === 'unset') return parentPx();
  if (Object.prototype.hasOwnProperty.call(ABSOLUTE_FONT_SIZE_PX, s)) return ABSOLUTE_FONT_SIZE_PX[s];
  if (s === 'smaller') return parentPx() / 1.2;
  if (s === 'larger')  return parentPx() * 1.2;
  const m = /^(\d*\.?\d+)(px|em|rem|%|pt|pc|in|cm|mm|q|ex|ch)?$/.exec(s);
  if (!m) return parentPx();                                             // unparseable / negative → inherit
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case undefined: return n === 0 ? 0 : parentPx();                     // unitless: only `0` is a valid length
    case 'em':      return n * parentPx();
    case 'ex': case 'ch': return n * parentPx() * 0.5;                   // approx — no glyph metrics
    case '%':       return n / 100 * parentPx();
    case 'rem': { const root = el.ownerDocument && el.ownerDocument.documentElement;
                  return n * (root && root !== el ? computedFontSizePx(root) : DEFAULT_FONT_SIZE_PX); }
    default: { const f = CSS_ABSOLUTE_UNIT_PX[m[2]]; return f !== undefined ? n * f : parentPx(); }
  }
}
function formatPx(px) { return (+px.toFixed(4)) + 'px'; }

// A CSS <length> value → px, resolving font-relative units against `fsPx` (em/ex/ch) or the
// root (rem) and absolute units via CSS_ABSOLUTE_UNIT_PX. Shared by the line-height resolver.
function fontLengthToPx(n, unit, fsPx, el) {
  switch (unit) {
    case 'em': return n * fsPx;
    case 'ex': case 'ch': return n * fsPx * 0.5;                          // approx — no glyph metrics
    case 'rem': { const root = el.ownerDocument && el.ownerDocument.documentElement;
                  return n * (root ? computedFontSizePx(root) : DEFAULT_FONT_SIZE_PX); }
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
function computedLineHeight(el) {
  let owner = el, c = null;
  while (owner && owner.nodeType === NODE_ELEMENT) {
    const raw = cascadedProperty(owner, 'line-height');
    if (raw != null && raw !== '') {
      const v = String(resolveCssVars(owner, raw)).trim().toLowerCase();
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
function computedFontWeight(el) {
  const c = cascadedProperty(el, 'font-weight');
  if (c == null || c === '') return inheritComputed(el, computedFontWeight, 400);
  const s = String(resolveCssVars(el, c)).trim().toLowerCase();
  if (s === 'normal' || s === 'initial' || s === 'revert' || s === 'revert-layer') return 400;
  if (s === 'bold') return 700;
  if (s === 'inherit' || s === 'unset') return inheritComputed(el, computedFontWeight, 400);
  if (s === 'bolder' || s === 'lighter') return relativeFontWeight(inheritComputed(el, computedFontWeight, 400), s);
  const n = parseInt(s, 10);
  return (n >= 1 && n <= 1000) ? n : 400;
}
// Computed font-style: the cascaded keyword (`italic` / `oblique[ <angle>]` / `normal`).
// Inherits; initial/revert → normal.
function computedFontStyle(el) {
  const c = cascadedProperty(el, 'font-style');
  if (c == null || c === '') return inheritComputed(el, computedFontStyle, 'normal');
  const s = String(resolveCssVars(el, c)).trim().toLowerCase();
  if (s === 'inherit' || s === 'unset') return inheritComputed(el, computedFontStyle, 'normal');
  if (s === 'italic' || s === 'normal' || s.startsWith('oblique')) return s;
  return 'normal';
}
// Computed opacity as a number in [0, 1] (a percentage divides by 100). opacity does NOT
// inherit, so `unset`/`initial` are the initial 1 while an explicit `inherit` copies the
// PARENT's computed opacity; the initial is 1, and calc()/unresolvable falls back to 1.
function computedOpacity(el) {
  const c = cascadedProperty(el, 'opacity');
  if (c == null || c === '') return 1;
  const s = String(resolveCssVars(el, c)).trim().toLowerCase();
  if (s === 'initial' || s === 'unset' || s === 'revert' || s === 'revert-layer') return 1;
  if (s === 'inherit') { const p = el._parent; return (p && p.nodeType === NODE_ELEMENT) ? computedOpacity(p) : 1; }
  const n = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  if (!isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function readComputed(el, key) {
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
    const c = cascadedProperty(el, 'font-family');
    if (c != null && c !== '') {
      const s  = String(resolveCssVars(el, c)).trim();
      const sl = s.toLowerCase();
      if (sl !== 'inherit' && sl !== 'unset') {
        // `initial`/`revert` compute to the UA default font, which we don't model a value for.
        return (sl === 'initial' || sl === 'revert' || sl === 'revert-layer') ? { hit: false } : { hit: true, value: serializeFontFamily(s) };
      }
    }
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
    const c = cascadedProperty(el, 'direction');
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
    const bs = cascadedProperty(el, 'border-style');
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
    let bc = cascadedProperty(el, key);
    if (bc == null || bc === '') bc = cascadedProperty(el, 'border-color');
    if (!bc || String(bc).toLowerCase() === 'currentcolor') return { hit: true, value: readComputed(el, 'color').value };
    return { hit: true, value: normalizeColor(resolveCssVars(el, bc)) };
  }

  // Geometry generally needs layout. But a box-model length the cascade resolves to a
  // CONCRETE px — an author `width: 100px` / `margin-left: 10px`, or a presentational hint
  // like `<canvas width>` — equals its used value with no layout, so report it (a unitless
  // `0` normalises to `0px`). Percentages / `auto` / `calc` / intrinsic sizing still need
  // layout → empty. Positioning insets (top/right/bottom/left) and border widths stay
  // layout-only: their used value depends on layout / border-style.
  if (PX_REPORTABLE_LAYOUT_PROPS.has(key)) {
    const c = cascadedProperty(el, key);
    if (c != null) {
      const t = String(c).trim();
      if (/^-?\d*\.?\d+px$/.test(t)) return { hit: true, value: t };
      if (/^-?0(\.0+)?$/.test(t))    return { hit: true, value: '0px' };
    }
    return { hit: false };
  }
  if (LAYOUT_COMPUTED_PROPS.has(key)) return { hit: false };

  // Any other (layout-free) property: resolve through the cascade, then
  // fall back to the UA / inherited initial value.
  const cascaded = cascadedProperty(el, key);
  if (cascaded != null && cascaded !== '') {
    const resolved = resolveCssVars(el, cascaded);
    const cw = String(resolved).trim().toLowerCase();
    // A CSS-wide keyword computes rather than serializing literally: `inherit` (and `unset`
    // on an inherited prop) takes the parent's computed value; `initial` / `revert` (and
    // `unset` on a non-inherited prop) fall through to the initial-value lookup below.
    if (cw === 'inherit' || cw === 'unset' || cw === 'initial' || cw === 'revert' || cw === 'revert-layer') {
      if (cw === 'inherit' || (cw === 'unset' && INHERITED_CAPTURED_PROPS.has(key))) {
        const parent = el._parent;
        if (parent && parent.nodeType === NODE_ELEMENT) return readComputed(parent, key);
      }
    } else {
      // Colour-valued props normalise to the rgb()/rgba() forms browsers report.
      const value = (key === 'color' || key.endsWith('-color')) ? normalizeColor(resolved) : resolved;
      return { hit: true, value };
    }
  } else if (INHERITED_CAPTURED_PROPS.has(key)) {
    // An inherited property with no value of its own takes the parent's computed value
    // (e.g. an <option> / a <span> inheriting `color` from its <select> / <div> —
    // option-color-inheritance). Walk the node-tree parent recursively; the root falls
    // through to the initial value below.
    const parent = el._parent;
    if (parent && parent.nodeType === NODE_ELEMENT) return readComputed(parent, key);
  }

  if (Object.prototype.hasOwnProperty.call(COMPUTED_INITIAL_VALUES, key)) {
    return { hit: true, value: COMPUTED_INITIAL_VALUES[key] };
  }
  return { hit: false };
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
  return new Proxy({}, {
    get(_t, key) {
      if (key === 'length')   return 0;
      if (key === 'cssText')  return '';
      // A resolved-value declaration is not tied to a rule (CSSOM) — matches
      // makeComputedStyleProxy's `parentRule`.
      if (key === 'parentRule') return null;
      if (key === 'getPropertyValue' || key === 'getPropertyPriority' || key === 'item') return () => '';
      if (key === 'setProperty' || key === 'removeProperty') return computedReadOnly;
      if (key === globalThis.Symbol.iterator) return function* () {};
      return typeof key === 'string' ? '' : undefined;
    },
    set() { computedReadOnly(); }
  });
}
function makeComputedStyleProxy(el) {
  const names = makeComputedNames();
  return new Proxy(el.style, {
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
