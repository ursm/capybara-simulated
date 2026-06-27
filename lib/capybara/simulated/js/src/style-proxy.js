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
import { cascadedProperty, matchesAnyHideRule, splitImportant } from './cascade.js';
import { lookup, handles }               from './handles.js';

// Properties whose `getComputedStyle(el).<prop>` reads route through
// the cascade resolver. Without this, `style.color` etc. would only
// see inline `style="..."` values and miss every stylesheet rule.
// Keys are kebab-case; the proxy normalises camelCase via
// `camelToKebab` before lookup.

export function makeStyleProxy(el) {
  // Proxy target is an object so `typeof el.style === 'object'`.
  // The original `function(){}` target made it `'function'`, which
  // broke jQuery 3.x's `isHiddenWithinTree` (reads `elem.style.display`
  // after a `typeof` check — when `elem.style` was a function jQuery
  // skipped the inline-style branch and toggle() routed to the wrong
  // direction).
  const target = {};
  const handler = {
    get(_t, prop) {
      // CSSOM: `cssText` is the CANONICAL serialization of the declaration block
      // (`color: red;` — trailing `;`, normalized spacing), not the raw attribute
      // string. `getAttribute('style')` still returns the verbatim attribute.
      if (prop === 'cssText') return serializeStyleDecls(parsedDecls(el));
      if (prop === 'getPropertyValue')    return name => readCssProp(el, String(name));
      if (prop === 'getPropertyPriority') return name => readCssPriority(el, String(name));
      if (prop === 'setProperty')         return (n, v, priority) => writeCssProp(el, String(n), String(v), priority);
      if (prop === 'removeProperty')      return name => removeCssProp(el, String(name));
      if (prop === 'length') return Object.keys(parsedDecls(el)).length;
      if (typeof prop !== 'string') return undefined;
      return readCssProp(el, camelToKebab(prop));
    },
    set(_t, prop, value) {
      if (prop === 'cssText') {
        el.setAttribute('style', String(value == null ? '' : value));
        return true;
      }
      if (typeof prop === 'string') {
        writeCssProp(el, camelToKebab(prop), String(value));
      }
      return true;
    },
    has(_t, prop) {
      if (prop === 'cssText' || prop === 'getPropertyValue' || prop === 'getPropertyPriority' ||
          prop === 'setProperty' || prop === 'removeProperty' || prop === 'length') return true;
      return readCssProp(el, camelToKebab(String(prop))) !== '';
    }
  };
  return new Proxy(target, handler);
}

function camelToKebab(name) {
  return name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

// Parse the element's inline `style` declarations, cached per element keyed on the
// raw string. `getComputedStyle`/inline-style reads parse the whole attribute per
// property access; style-read-heavy callers (Floating UI reads ~10 computed props
// per element, jQuery `.css()`/`:visible`) would otherwise re-parse the same string
// once per property. Keying on the string auto-invalidates: a write replaces
// `el._attrs.style` with a new (immutable) string, so the next read misses and
// re-parses. Read-only — the cached object is never mutated (writeCssProp parses
// its own copy).
function parsedDecls(el) {
  const s = el._attrs.style || '';
  if (el._declKey !== s) {
    el._declCache = parseStyleDecls(s);
    el._declKey = s;
  }
  return el._declCache;
}

// A declaration's `!important` priority lives inline in the stored value
// (`display: none !important`) — the single source of truth the style attribute
// serializes and the cascade resolver reads importance off. Value reads strip it
// so `getPropertyValue` / `style.display` return the bare value (CSSOM), with
// `getPropertyPriority` reporting it.
//
// `readCssProp` is a hot path (jQuery `.css()`, Floating UI read ~10 props per
// element), so `stripImportant` stays a string→string with a cheap `indexOf`
// guard — no per-read object. Importance-bearing reads (the cold
// `getPropertyPriority`, `parseInlineLayout`) use the cascade's `splitImportant`.
// `IMPORTANT_SUFFIX_RE` mirrors `cascade.js`'s `IMPORTANT_RE`; keep them in sync.
const IMPORTANT_SUFFIX_RE = /\s*!\s*important\s*$/i;
function stripImportant(v) {
  if (typeof v !== 'string' || v.indexOf('!') < 0) return v;
  return v.replace(IMPORTANT_SUFFIX_RE, '').trim();
}

function readCssProp(el, name) {
  const decls = parsedDecls(el);
  return decls[name] != null ? stripImportant(decls[name]) : '';
}

function readCssPriority(el, name) {
  const v = parsedDecls(el)[name];
  return v != null && splitImportant(v).important ? 'important' : '';
}

function writeCssProp(el, name, value, priority) {
  // Round-trip through parseStyleDecls so the style string is
  // canonical regardless of how the existing value was written
  // (multiple writes can leave declarations without `;` separators
  // when raw `cssText` setter pastes arbitrary strings). Removing a
  // property collapses cleanly; setting overwrites.
  const decls = parseStyleDecls(el._attrs.style || '');
  if (value === '' || value == null) {
    delete decls[name];
  } else {
    let v = String(value);
    // CSSOM `setProperty(name, value, "important")`: an explicit priority
    // marks the declaration important. Fold it into the stored value as
    // `value !important` (the cascade reads importance off the attribute);
    // an empty/absent priority clears any previously-important state.
    if (/^\s*important\s*$/i.test(String(priority == null ? '' : priority))) {
      v = stripImportant(v) + ' !important';
    } else if (priority != null && priority !== '') {
      // Unknown priority token (per CSSOM, anything but "important"/"") — the
      // whole call is a no-op; leave the declaration block untouched.
      return;
    }
    decls[name] = v;
  }
  el.setAttribute('style', serializeStyleDecls(decls));
}

function removeCssProp(el, name) {
  const v = readCssProp(el, name);
  const decls = parseStyleDecls(el._attrs.style || '');
  delete decls[name];
  el.setAttribute('style', serializeStyleDecls(decls));
  return v;
}

// CSSOM serialization of a declaration block: each declaration as `name: value;`
// joined by a single space, so a non-empty block ends in `;` (matches browsers:
// `color: green; background-color: blue;`). An empty block serializes to ''.
function serializeStyleDecls(decls) {
  return Object.entries(decls).map(([k, v]) => k + ': ' + v + ';').join(' ');
}

// Char-walking parser that tolerates inputs missing `;` between
// declarations. We scan `name: value` pairs, terminating each value
// at `;` *or* at a look-ahead `<word>:` pattern (which can only be
// the start of the next declaration). Existing CSS values never
// contain `:` outside of `url(...)` parens, so peeking for an
// unparenthesised `<word>:` is safe.
function parseStyleDecls(css) {
  const out = {};
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && (css[i] === ';' || /\s/.test(css[i]))) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && /[a-zA-Z-]/.test(css[i])) i++;
    if (i === nameStart) { i++; continue; }
    const name = css.slice(nameStart, i).toLowerCase();
    while (i < n && /\s/.test(css[i])) i++;
    if (css[i] !== ':') continue;
    i++;
    while (i < n && /\s/.test(css[i])) i++;
    let value = '';
    let parenDepth = 0;
    while (i < n) {
      const c = css[i];
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth--;
      else if (c === ';' && parenDepth === 0) { i++; break; }
      else if (parenDepth === 0 && /\s/.test(c)) {
        let j = i + 1;
        while (j < n && /\s/.test(css[j])) j++;
        const wStart = j;
        while (j < n && /[a-zA-Z-]/.test(css[j])) j++;
        if (j > wStart) {
          let k = j;
          while (k < n && /\s/.test(css[k])) k++;
          if (css[k] === ':') break; // next declaration begins
        }
      }
      value += c;
      i++;
    }
    const v = value.trim();
    // Drop a malformed declaration whose value begins with a colon — e.g.
    // `color:: invalid` parses as name `color`, value `: invalid`, which is
    // invalid CSS. It must not enter the parsed block (so `style.cssText` /
    // `style.color` are empty), though `getAttribute('style')` still returns
    // the raw string verbatim.
    if (name && v[0] !== ':') out[name] = v;
  }
  return out;
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
  const inlineStyle = el._attrs.style;
  if (inlineStyle) {
    const m = /(^|;|\s)display\s*:\s*([^;]+)/i.exec(inlineStyle);
    if (m) return stripImportant(m[2].trim());
  }
  // `[hidden]` is the UA `display: none`, but an author `display` rule overrides
  // it — let matchesAnyHideRule resolve both together rather than hard-returning.
  // ignoreVisibility=true: `visibility` is independent of the `display` value.
  if (matchesAnyHideRule(el, true, null, el._attrs.hidden != null)) return 'none';
  // UA `option:filtered { display: none }` — a combobox option filtered out by its
  // associated filter `<input>` (same rule honoured in cascade selfHidden).
  if (el._tag === 'option' && el._filtered === true) return 'none';
  return DEFAULT_DISPLAY[el._tag] || 'block';
}

function computedVisibilityFor(el) {
  const inlineStyle = el._attrs.style;
  if (inlineStyle) {
    const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
    if (m) return stripImportant(m[2].trim());
  }
  return '';
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
  return v;
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
  'border-width','border-top-width','border-right-width','border-bottom-width',
  'border-left-width',
]);

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
};

function readComputed(el, key) {
  if (key === 'display')    return { hit: true, value: computedDisplayFor(el) };
  if (key === 'visibility') return { hit: true, value: computedVisibilityFor(el) };

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

  // `z-index` computes to `auto` on a non-positioned box regardless of any
  // specified value; only a positioned element reports the cascaded integer.
  if (key === 'z-index') {
    const pos = readComputed(el, 'position');
    if (!pos.hit || pos.value === 'static') return { hit: true, value: 'auto' };
    // positioned → fall through to the cascade resolution below.
  }

  // Geometry needs layout; leave to the inline-style fallback (empty).
  if (LAYOUT_COMPUTED_PROPS.has(key)) return { hit: false };

  // Any other (layout-free) property: resolve through the cascade, then
  // fall back to the UA / inherited initial value.
  const cascaded = cascadedProperty(el, key);
  if (cascaded != null && cascaded !== '') {
    const resolved = resolveCssVars(el, cascaded);
    // Colour-valued props normalise to the rgb()/rgba() forms browsers report.
    const value = (key === 'color' || key.endsWith('-color')) ? normalizeColor(resolved) : resolved;
    return { hit: true, value };
  }

  if (Object.prototype.hasOwnProperty.call(COMPUTED_INITIAL_VALUES, key)) {
    return { hit: true, value: COMPUTED_INITIAL_VALUES[key] };
  }
  return { hit: false };
}

function makeComputedStyleProxy(el) {
  return new Proxy(el.style, {
    get(target, key) {
      if (key === 'getPropertyValue') {
        return function (name) {
          const r = readComputed(el, String(name).toLowerCase());
          if (r.hit) return r.value;
          return target.getPropertyValue ? target.getPropertyValue(name) : '';
        };
      }
      if (typeof key !== 'string') return target[key];
      // `cssFloat` is the CSSOM IDL alias for the `float` property (camelToKebab
      // would wrongly yield `css-float`).
      const r = readComputed(el, key === 'cssFloat' ? 'float' : camelToKebab(key));
      return r.hit ? r.value : target[key];
    }
  });
}

globalThis.getComputedStyle = function (el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return makeStyleProxy({ _attrs: {} });
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
