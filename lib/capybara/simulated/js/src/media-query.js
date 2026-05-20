// `@media` evaluator.
//
// Common-subset only: media types (`all` / `screen` / `print`),
// `and` / `not` / `only` joins (`,` is media-query-list), and the
// following feature expressions:
//
//   (min-width: N), (max-width: N), (width: N)
//   (min-height: N), (max-height: N), (height: N)
//   (orientation: landscape|portrait)
//   (hover: hover|none), (pointer: fine|coarse|none)
//   (prefers-color-scheme: light|dark)
//   (prefers-reduced-motion: reduce|no-preference)
//   (min-resolution: 1dppx etc.)
//
// Anything else falls back to *false* (the block doesn't apply).
// Conservative bias: a desktop viewport at 1× / no-touch / no-dark.
//
// Shared with the CSS cascade (`flattenCssTree` resolves `@media`
// blocks against the live viewport) and `window.matchMedia(query)`.

import { splitTopLevel } from './css-utils.js';

export function mediaMatches(text, vp) {
  if (!text) return true; // empty media list = matches all
  for (const q of splitTopLevel(text, ',')) {
    if (singleMediaMatches(q.trim(), vp)) return true;
  }
  return false;
}

function singleMediaMatches(q, vp) {
  if (!q) return true;
  let negate = false;
  const lower = q.toLowerCase();
  if (/^only\s+/.test(lower)) q = q.replace(/^\s*only\s+/i, '');
  if (/^not\s+/.test(lower))  { negate = true; q = q.replace(/^\s*not\s+/i, ''); }
  const parts = splitMediaAnd(q);
  let result = true;
  for (const p of parts) {
    if (!matchMediaPart(p.trim(), vp)) { result = false; break; }
  }
  return negate ? !result : result;
}

// Splits on top-level " and " (case-insensitive), respecting
// parentheses.
function splitMediaAnd(s) {
  const out = [];
  let depth = 0, start = 0;
  const lower = s.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && lower.startsWith(' and ', i)) {
      out.push(s.slice(start, i));
      i += 4;
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function matchMediaPart(p, vp) {
  if (!p) return true;
  if (p[0] !== '(') {
    const t = p.toLowerCase().trim();
    if (t === 'all' || t === '' || t === 'screen') return true;
    if (t === 'print' || t === 'speech') return false;
    return false;
  }
  if (p[p.length - 1] !== ')') return false;
  const inside = p.slice(1, -1).trim();
  const m = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(inside);
  if (!m) {
    // Bare feature like (hover) — treat as truthy if we'd answer
    // yes to its `(name: <any-value>)` form. Few tests rely on this.
    const name = inside.toLowerCase().trim();
    if (name === 'hover' || name === 'any-hover')     return true;
    if (name === 'pointer' || name === 'any-pointer') return true;
    return false;
  }
  const feat = m[1].toLowerCase();
  const val  = m[2].trim().toLowerCase();
  if (feat === 'min-width')  return vp.width  >= parsePx(val);
  if (feat === 'max-width')  return vp.width  <= parsePx(val);
  if (feat === 'width')      return vp.width  === parsePx(val);
  if (feat === 'min-height') return vp.height >= parsePx(val);
  if (feat === 'max-height') return vp.height <= parsePx(val);
  if (feat === 'height')     return vp.height === parsePx(val);
  if (feat === 'orientation') return val === (vp.width >= vp.height ? 'landscape' : 'portrait');
  if (feat === 'hover' || feat === 'any-hover')     return val === 'hover';
  if (feat === 'pointer' || feat === 'any-pointer') return val === 'fine';
  if (feat === 'prefers-color-scheme')              return val === 'light';
  if (feat === 'prefers-reduced-motion')            return val === 'no-preference';
  if (feat === 'min-resolution' || feat === 'max-resolution' || feat === 'resolution') {
    // 1dppx baseline. min-resolution matches when test ≤ 1; etc.
    const t = parseDppx(val);
    if (feat === 'min-resolution') return 1 >= t;
    if (feat === 'max-resolution') return 1 <= t;
    return 1 === t;
  }
  return false;
}

const PX_PER_EM    = 16;
const DPI_PER_DPPX = 96;
const CM_PER_INCH  = 2.54;
const DPCM_PER_DPPX = DPI_PER_DPPX / CM_PER_INCH;   // ≈ 37.795

function parsePx(s) {
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 0;
  if (/em$/.test(s))  return n * PX_PER_EM;
  if (/rem$/.test(s)) return n * PX_PER_EM;
  return n;
}

function parseDppx(s) {
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 1;
  if (/dppx$/.test(s)) return n;
  if (/dpi$/.test(s))  return n / DPI_PER_DPPX;
  if (/dpcm$/.test(s)) return n / DPCM_PER_DPPX;
  return n;
}

// Read the current viewport off `globalThis.innerWidth` /
// `innerHeight` (platform-globals seeds them at 1024×768; Ruby's
// `Browser#set_viewport` updates them). Shared with the cascade
// resolver so `@media` blocks and `matchMedia(...)` agree.
const VIEWPORT_DEFAULT = { width: 1024, height: 768 };
export function currentViewport() {
  return {
    width:  Number(globalThis.innerWidth)  || VIEWPORT_DEFAULT.width,
    height: Number(globalThis.innerHeight) || VIEWPORT_DEFAULT.height
  };
}

// `matchMedia(query)` — reuses the same evaluator the CSS cascade
// uses for `@media` blocks, so JS-side feature queries agree with
// what the cascade applies. `MediaQueryList` listener surface stays
// inert: with no layout there's no resize event.
globalThis.matchMedia = function matchMedia(query) {
  const text = String(query || '');
  return {
    media: text,
    get matches() { return mediaMatches(text, currentViewport()); },
    onchange: null,
    addListener:      () => {}, removeListener:      () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent:    () => false
  };
};
