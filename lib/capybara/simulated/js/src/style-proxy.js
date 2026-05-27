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
import { cascadedProperty, matchesAnyHideRule } from './cascade.js';
import { lookup, handles }               from './handles.js';

// Properties whose `getComputedStyle(el).<prop>` reads route through
// the cascade resolver. Without this, `style.color` etc. would only
// see inline `style="..."` values and miss every stylesheet rule.
// Keys are kebab-case; the proxy normalises camelCase via
// `camelToKebab` before lookup.
const CASCADE_READ_PROPS = new Set([
  'color',
  'background-color'
]);

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
      if (prop === 'cssText') return el._attrs.style || '';
      if (prop === 'getPropertyValue') return name => readCssProp(el, String(name));
      if (prop === 'setProperty')      return (n, v) => writeCssProp(el, String(n), String(v));
      if (prop === 'removeProperty')   return name => removeCssProp(el, String(name));
      if (prop === 'length') return Object.keys(parseStyleDecls(el._attrs.style || '')).length;
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
      if (prop === 'cssText' || prop === 'getPropertyValue' ||
          prop === 'setProperty' || prop === 'removeProperty' || prop === 'length') return true;
      return readCssProp(el, camelToKebab(String(prop))) !== '';
    }
  };
  return new Proxy(target, handler);
}

function camelToKebab(name) {
  return name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

function readCssProp(el, name) {
  const decls = parseStyleDecls(el._attrs.style || '');
  return decls[name] != null ? decls[name] : '';
}

function writeCssProp(el, name, value) {
  // Round-trip through parseStyleDecls so the style string is
  // canonical regardless of how the existing value was written
  // (multiple writes can leave declarations without `;` separators
  // when raw `cssText` setter pastes arbitrary strings). Removing a
  // property collapses cleanly; setting overwrites.
  const decls = parseStyleDecls(el._attrs.style || '');
  if (value === '' || value == null) {
    delete decls[name];
  } else {
    decls[name] = String(value);
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

function serializeStyleDecls(decls) {
  return Object.entries(decls).map(([k, v]) => k + ': ' + v).join('; ');
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
    if (name) out[name] = value.trim();
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
    if (m) return m[2].trim();
  }
  if (el._attrs.hidden != null) return 'none';
  if (matchesAnyHideRule(el)) return 'none';
  return DEFAULT_DISPLAY[el._tag] || 'block';
}

function computedVisibilityFor(el) {
  const inlineStyle = el._attrs.style;
  if (inlineStyle) {
    const m = /(^|;|\s)visibility\s*:\s*([^;]+)/i.exec(inlineStyle);
    if (m) return m[2].trim();
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

// Canonicalise color values to the `rgb(...)` / `rgba(...)` form
// real browsers return from `getComputedStyle(...).color`:
//   - `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`
//   - CSS named colors (`red`, `transparent`, …)
// `rgb(...)` / `hsl(...)` already-canonical forms pass through.
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
  const named = NAMED_COLORS[v.toLowerCase()];
  if (named) return named;
  return v;
}

// CSS named-color subset mapped to canonical `rgb(...)` strings —
// real browsers return these forms from `getComputedStyle(...).color`
// regardless of how the stylesheet wrote them. Expand on demand.
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

function readComputed(el, key) {
  if (key === 'display')    return { hit: true, value: computedDisplayFor(el) };
  if (key === 'visibility') return { hit: true, value: computedVisibilityFor(el) };
  if (CASCADE_READ_PROPS.has(key)) {
    const cascaded = cascadedProperty(el, key);
    if (cascaded != null && cascaded !== '') {
      return { hit: true, value: normalizeColor(resolveCssVars(el, cascaded)) };
    }
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
      const r = readComputed(el, camelToKebab(key));
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
