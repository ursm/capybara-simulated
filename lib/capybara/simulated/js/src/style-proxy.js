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

import { NODE_ELEMENT }       from './constants.js';
import { matchesAnyHideRule } from './cascade.js';
import { lookup, handles }    from './handles.js';

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

function makeComputedStyleProxy(el) {
  return new Proxy(el.style, {
    get(target, key) {
      if (key === 'display')    return computedDisplayFor(el);
      if (key === 'visibility') return computedVisibilityFor(el);
      if (key === 'getPropertyValue') {
        return function (name) {
          const n = String(name).toLowerCase();
          if (n === 'display')    return computedDisplayFor(el);
          if (n === 'visibility') return computedVisibilityFor(el);
          return target.getPropertyValue ? target.getPropertyValue(name) : (target[n] || '');
        };
      }
      return target[key];
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
