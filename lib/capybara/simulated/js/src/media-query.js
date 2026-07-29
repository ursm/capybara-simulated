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
import { EventTarget, dispatchWithOnHandler, defineEventHandler } from './events.js';

export function mediaMatches(text, vp) {
  if (!text) return true; // empty media list = matches all
  for (const q of splitTopLevel(text, ',')) {
    if (singleMediaMatches(q.trim(), vp)) return true;
  }
  return false;
}

// `@supports` condition evaluator.
//
// Layout-free: we can't run the CSS value grammar, so we bias
// unrecognized conditions toward SUPPORTED. The cascade DROPS blocks
// whose condition is false, and dropping a `@supports` block a real
// Chromium 137 (the emulated UA) would apply is a parity break
// (CLAUDE.md rule 1) — so we err toward applying:
//   - `(prop: value)` is supported when it looks like a real
//     declaration (a property-shaped name + non-empty value); the
//     hardcoded property allowlist is gone in favour of this bias.
//   - `selector(<sel>)` is supported iff the selector parses with the
//     in-house engine (we genuinely support :has / :is / :where … ,
//     matching the UA); unsupported iff it throws.
//   - `font-tech(…)` / `font-format(…)` / unknown `foo(…)` — can't
//     evaluate, so supported.
// The `and` / `or` / `not` combinators and parenthesisation are
// evaluated per the `<supports-condition>` grammar, so
// `@supports not (<supported>)` does NOT apply and `@supports
// (<supported>)` DOES. (Because we bias toward supported,
// `not (text-wrap: balance)` resolves to false / drops — acceptable;
// the alternative of dropping the positive rule is worse.)
//
// Shared with the CSS cascade (`flattenCssTree` gates `@supports` descent
// on this, mirroring the `@media` / `@container` branches).
export function supportsMatches(prelude) {
  if (!prelude || typeof prelude !== 'string') return true;
  const tokens = tokenizeSupports(prelude);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let v = parseAnd();
    while (peek() && peek().toLowerCase() === 'or') { next(); const r = parseAnd(); v = v || r; }
    return v;
  }
  function parseAnd() {
    let v = parseUnary();
    while (peek() && peek().toLowerCase() === 'and') { next(); const r = parseUnary(); v = v && r; }
    return v;
  }
  function parseUnary() {
    if (peek() && peek().toLowerCase() === 'not') { next(); return !parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (t === undefined) return false;
    if (t === '(') {
      const v = parseOr();
      if (peek() === ')') next();
      return v;
    }
    return evalSupportsFeature(t);
  }

  const result = parseOr();
  return result === undefined ? false : result;
}

function evalSupportsFeature(text) {
  const s = String(text).trim();
  // Functional queries: `selector(<sel>)`, `font-tech(...)`,
  // `font-format(...)`, or any `foo(...)`. We bias toward SUPPORTED so
  // we never silently drop a `@supports` block a real Chromium 137 (the
  // emulated UA) would apply — dropping a rule a real browser keeps is
  // a worse parity break than keeping one (CLAUDE.md rule 1). The one
  // case we CAN evaluate honestly is `selector(<sel>)`: compile it with
  // the same selector engine the matcher uses — supported iff it parses
  // (we genuinely support :has / :is / :where etc., matching the UA),
  // unsupported iff it throws.
  const fn = /^([a-z-]+)\s*\(([\s\S]*)\)\s*$/i.exec(s);
  if (fn) {
    const name = fn[1].toLowerCase();
    if (name === 'selector') {
      const sel = fn[2].trim();
      if (!sel) return false;
      try {
        // Supported iff it parses with css-what (the parser behind the
        // css-select matcher) — throws only on malformed SYNTAX, not on
        // unknown pseudo names (those parse fine → reported supported). That
        // leniency matches this function's deliberate bias toward "supported"
        // (dropping a rule a real browser keeps is the worse parity break).
        const groups = globalThis.__csimVendor.cssWhat.parse(sel);
        return !!(groups && groups.length);
      } catch (_) {
        return false;
      }
    }
    // font-tech() / font-format() / unknown foo(...) — can't evaluate,
    // bias to supported (matches the pre-diff always-descend behaviour).
    return true;
  }
  // Property query `(prop: value)`: treat as SUPPORTED when it looks
  // like a real declaration (a property-shaped name + non-empty value).
  // We drop the hardcoded allowlist in favour of this bias-to-apply
  // rule so progressive-enhancement guards for modern properties
  // (`text-wrap: balance`, etc.) aren't silently dropped — a modern
  // browser applies them. Only clearly-malformed declarations (no
  // colon, empty value, or a non-property-shaped name) are unsupported,
  // which keeps `not(<malformed>)` honest.
  const idx = s.indexOf(':');
  if (idx === -1) return false;
  let prop = s.slice(0, idx).trim().toLowerCase();
  const value = s.slice(idx + 1).trim();
  if (!prop || !value) return false;
  prop = prop.replace(/^-(webkit|moz|ms|o)-/, '');
  return /^[-a-z]+$/.test(prop);
}

// Tokenise a `<supports-condition>` into '(' / ')' / the bare combinator
// keywords (and/or/not) / and the raw feature text inside each balanced
// parenthesis group. A group whose inner text itself contains a
// combinator or a nested paren is recursed into; otherwise its inner text
// is a single feature-query token.
function tokenizeSupports(input) {
  const out = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') { i++; continue; }
    if (ch === '(') {
      let depth = 0, j = i, inner = '';
      while (j < n) {
        const c = input[j];
        if (c === '(') { depth++; if (depth > 1) inner += c; }
        else if (c === ')') { depth--; if (depth === 0) { j++; break; } else inner += c; }
        else if (depth >= 1) inner += c;
        j++;
      }
      const trimmed = inner.trim();
      const looksLikeGroup = /(^|\s)(and|or|not)(\s|$)/i.test(trimmed) || /^\(/.test(trimmed);
      if (looksLikeGroup) {
        out.push('(');
        for (const t of tokenizeSupports(trimmed)) out.push(t);
        out.push(')');
      } else {
        out.push(trimmed);
      }
      i = j;
      continue;
    }
    if (ch === ')') { out.push(')'); i++; continue; }
    let j = i;
    while (j < n && ' \t\n\r\f()'.indexOf(input[j]) === -1) j++;
    out.push(input.slice(i, j));
    i = j;
  }
  return out;
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

// Splits on top-level `and` joiner (case-insensitive), respecting
// parentheses. Per the CSS spec, whitespace around `and` is optional
// when it abuts a `)` or `(` — sass emits `@media(min-width: 40rem)and
// (max-width: 47.999rem)` (no space before `and`), and the Discourse
// `.topic-list .views { display: none }` rule lives inside one of
// those compact `and`-joined blocks. Accept any of the four
// whitespace combinations around the literal `and`.
function splitMediaAnd(s) {
  const out = [];
  let depth = 0, start = 0;
  const lower = s.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      // Match `and` at this position; the joiner can be preceded by
      // either whitespace or a `)`, and followed by either whitespace
      // or a `(`.
      const prev = i > 0 ? s[i - 1] : '';
      const isAndStart = (prev === ')' || /\s/.test(prev)) &&
                         lower.startsWith('and', i) &&
                         (i + 3 >= s.length ||
                          /\s/.test(s[i + 3]) ||
                          s[i + 3] === '(');
      if (isAndStart) {
        out.push(s.slice(start, i).trimEnd());
        i += 3;
        start = i;
      }
    }
  }
  out.push(s.slice(start).trimStart());
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
  // Mobile-shaped viewport ⇒ touch capability: coarse pointer + no
  // hover. Discourse's `capabilities.touch` reads
  // `(any-pointer: coarse)`, then a top-level initializer adds
  // `discourse-touch` to `<html>`; tests gated on
  // `expect(page).to have_css("html.discourse-touch")` need this.
  // 700px matches Discourse's MOBILE_VIEW breakpoint.
  if (feat === 'hover' || feat === 'any-hover')     return val === (vp.width <= 700 ? 'none' : 'hover');
  if (feat === 'pointer' || feat === 'any-pointer') return val === (vp.width <= 700 ? 'coarse' : 'fine');
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

// The driver-owned viewport (`platform-globals.js` `__csimViewport`, written by Ruby's
// `Browser#set_viewport`). Read it directly rather than through `innerWidth` / `innerHeight`:
// those are `[Replaceable]`, so a page that assigns them shadows the getter — and a page must not
// be able to move the `@media` breakpoints or the layout out from under the driver. Shared with
// the cascade resolver and the layout engine so all three agree on one size.
export function currentViewport() {
  const vp = globalThis.__csimViewport;
  return vp ? {width: vp.width, height: vp.height} : {width: 1024, height: 768};
}

// `matchMedia(query)` — reuses the same evaluator the CSS cascade
// uses for `@media` blocks, so JS-side feature queries agree with
// what the cascade applies. Listeners are notified when
// `Browser#set_viewport` calls `__csimViewportChanged` after a
// viewport flip, so responsive component libs see the transition.
class MediaQueryList extends EventTarget {
  constructor(text) {
    super();
    this.media = text;
    this._lastMatches = mediaMatches(text, currentViewport());
  }
  get matches() { return mediaMatches(this.media, currentViewport()); }
  addListener(handler)    { this.addEventListener('change', handler); }
  removeListener(handler) { this.removeEventListener('change', handler); }
}
defineEventHandler(MediaQueryList.prototype, 'change');
const _activeQueries = [];
globalThis.matchMedia = function matchMedia(query) {
  const mql = new MediaQueryList(String(query || ''));
  _activeQueries.push(mql);
  return mql;
};
globalThis.__csimViewportChanged = function () {
  for (const mql of _activeQueries) {
    const now = mediaMatches(mql.media, currentViewport());
    if (now !== mql._lastMatches) {
      mql._lastMatches = now;
      dispatchWithOnHandler(mql, {type: 'change', matches: now, media: mql.media});
    }
  }
};
