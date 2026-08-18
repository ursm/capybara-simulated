// The font tables layout measures with, and the two CSS units that read them.
//
// The per-character table comes from the font FILE's own `hmtx` (host side:
// `font_advance_table`), so nothing is rasterised: one host call per (family,
// weight/style) for the whole table, then a few lookups per run. It lives here
// rather than in layout.js because `ch` and `ex` are resolved in style-proxy.js,
// which layout.js imports — a shared module is what keeps the two from importing
// each other.
const FONT_TABLES = new globalThis.Map();

export function advanceTableFor(family, weightStyle) {
  const key = family + ' ' + weightStyle;
  if (FONT_TABLES.has(key)) return FONT_TABLES.get(key);
  let t = null;
  try {
    t = globalThis.__csim_fontAdvances ? globalThis.__csim_fontAdvances(family, weightStyle) : null;
  } catch (_) { t = null; }
  FONT_TABLES.set(key, t);
  return t;
}

// A font's `0` advance and x-height, as per-em factors — CSS's `ch` and `ex`.
// Both fall back to the spec's 0.5em when the font can't be read or doesn't carry
// the metric (`ex` needs OS/2 version 2; `ch` needs the font to map U+0030).
export const FALLBACK_CH_EM = 0.5;
export const FALLBACK_EX_EM = 0.5;

export function chFactor(family, weightStyle) {
  const t = advanceTableFor(family, weightStyle);
  const zero = t && t.adv ? t.adv['0'] : undefined;
  return typeof zero === 'number' && zero > 0 ? zero : FALLBACK_CH_EM;
}

export function exFactor(family, weightStyle) {
  const t = advanceTableFor(family, weightStyle);
  const xh = t ? t.xh : undefined;
  return typeof xh === 'number' && xh > 0 ? xh : FALLBACK_EX_EM;
}
