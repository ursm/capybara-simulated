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
  // A family the document declares an `@font-face` for measures with the DOWNLOADED face —
  // fetched on first use, as Chrome loads a web font when text needs it — the first family of
  // the stack that has one; the system face answers for the rest.
  const doc = globalThis.document;
  let url = '';
  if (doc && documentDeclaresFontFaces(doc)) {
    for (const fam of splitFontStack(family)) {
      const src = resolveFontFace(doc, fam);
      if (src) { url = absoluteFontUrl(src, doc); break; }
    }
  }
  const key = family + ' ' + weightStyle + (url ? ' @' + url : '');
  if (FONT_TABLES.has(key)) return FONT_TABLES.get(key);
  let t = url ? webFontTable(url, doc) : null;
  if (!t) {
    try {
      t = globalThis.__csim_fontAdvances ? globalThis.__csim_fontAdvances(family, weightStyle) : null;
    } catch (_) { t = null; }
  }
  FONT_TABLES.set(key, t);
  return t;
}

// ── downloaded faces (`@font-face`) ──
// `family, family, generic` → the families, unquoted.
export function splitFontStack(stack) {
  return String(stack || '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}
// Whether any stylesheet of `doc` declares an `@font-face` (or script added a FontFace) —
// the O(1) gate before the per-family lookup, memoised per settle generation.
function documentDeclaresFontFaces(doc) {
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  if (doc.__csimFontFacesAnyGen === gen) return doc.__csimFontFacesAny;
  doc.__csimFontFacesAnyGen = gen;
  let any = !!(doc._fontFaceSet && doc._fontFaceSet._faces.size > 0);
  const sheets = doc.styleSheets;
  for (let i = 0; !any && sheets && i < sheets.length; i++) {
    let rules;
    try { rules = sheets[i].cssRules; } catch (_) { continue; }
    for (let j = 0; rules && j < rules.length; j++) if (rules[j] && rules[j].type === 5) { any = true; break; }
  }
  return (doc.__csimFontFacesAny = any);
}
// The @font-face src URL for `family` (from a document stylesheet rule or a
// programmatically-added FontFace), or ''. Memoized per document keyed by lowercased
// family, and invalidated when the DOM mutates (a stylesheet / FontFace may have been
// added) via the settle generation — so a steady draw loop keeps hitting the cache
// while a dynamically-injected @font-face is still picked up.
export function resolveFontFace(doc, family) {
  const key = family.toLowerCase();
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  let cache = doc.__csimFontFaces;
  if (!cache || doc.__csimFontFacesGen !== gen) {
    cache = doc.__csimFontFaces = new globalThis.Map();
    doc.__csimFontFacesGen = gen;
  }
  if (cache.has(key)) return cache.get(key);
  const url = fontFaceSrc(doc, key);
  cache.set(key, url);
  return url;
}
function fontFaceSrc(doc, key) {
  const sheets = doc.styleSheets;
  for (let i = 0; sheets && i < sheets.length; i++) {
    let rules;
    try { rules = sheets[i].cssRules; } catch (_) { continue; }   // cross-origin sheet
    for (let j = 0; rules && j < rules.length; j++) {
      const r = rules[j];
      if (!r || r.type !== 5 /* CSSRule.FONT_FACE_RULE, realm-safe */ || !r.style) continue;
      const fam = (r.style.getPropertyValue('font-family') || '').trim().replace(/['"]/g, '');
      if (fam.toLowerCase() === key) {
        const u = fontFaceUrl(r.style.getPropertyValue('src'));
        if (u) return u;
      }
    }
  }
  const set = doc._fontFaceSet;
  let found = '';
  if (set && set._faces) {
    set._faces.forEach(f => {
      if (!found && f && String(f.family).replace(/['"]/g, '').toLowerCase() === key) found = fontFaceUrl(f._source);
    });
  }
  return found;
}
// The `url()` of a `src` list a browser would take: the first one whose `format()` (or
// extension) is a container the host reads — TrueType / OpenType / WOFF; a WOFF2 face has no
// decoder on the host, so it is taken only when nothing else is offered (fetched, then
// measured with the fallback family).
const UNREADABLE_FORMAT_RE = /woff2|embedded-opentype|svg/i;
export function fontFaceUrl(src) {
  const text = typeof src === 'string' ? src : '';
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/g;
  let m, first = '';
  while ((m = re.exec(text))) {
    const url = m[2].trim();
    const format = m[4] ? m[4] : (/\.woff2(?:$|[?#])/i.test(url) ? 'woff2' : /\.(?:eot|svg)(?:$|[?#])/i.test(url) ? 'embedded-opentype' : '');
    if (!UNREADABLE_FORMAT_RE.test(format)) return url;
    if (!first) first = url;
  }
  return first;
}
function absoluteFontUrl(src, doc) {
  try { return new globalThis.URL(src, (doc && doc.baseURI) || (globalThis.location && globalThis.location.href) || undefined).href; }
  catch (_) { return src; }
}
// One fetch per face URL per realm: the table (null when the host cannot read the file), a
// Resource Timing entry (initiator `css`, as Chrome files a font a stylesheet pulled in), and
// the FontFaceSet's loading cycle.
const WEB_FONT_TABLES = new globalThis.Map();
// What a face's `src` already went through: 'loaded' / 'error' after its fetch, else 'unloaded'.
const WEB_FONT_OK = new globalThis.Map();
export function webFontStatus(src, doc) {
  const url = absoluteFontUrl(src, doc);
  return WEB_FONT_OK.has(url) ? (WEB_FONT_OK.get(url) ? 'loaded' : 'error') : 'unloaded';
}
globalThis.__csimWebFontStatus = webFontStatus;
export function webFontTable(url, doc) {
  if (WEB_FONT_TABLES.has(url)) return WEB_FONT_TABLES.get(url);
  let table = null, meta = null;
  const started = globalThis.performance ? globalThis.performance.now() : 0;
  try {
    const r = globalThis.__csim_fontAdvancesFromUrl ? globalThis.__csim_fontAdvancesFromUrl(url) : null;
    if (r) { table = r.table || null; meta = r.meta || null; }
  } catch (_) { table = null; }
  WEB_FONT_TABLES.set(url, table);
  WEB_FONT_OK.set(url, !!(meta && meta.status > 0 && meta.status < 400));
  if (typeof globalThis.__csimRecordResource === 'function') {
    globalThis.__csimRecordResource({ name: url, initiatorType: 'css', startTime: started, resp: meta, noCors: false });
  }
  const set = doc && doc._fontFaceSet;
  if (set && typeof set._faceFetched === 'function') set._faceFetched(url, !!(meta && meta.status > 0 && meta.status < 400));
  return table;
}
// The FontFaceSet's `load()` / `ready` reach the fetch through these (platform-globals.js
// cannot import layout-side modules).
globalThis.__csimWebFontLoad = function (doc, family) {
  const src = resolveFontFace(doc, family);
  if (!src) return null;
  const url = absoluteFontUrl(src, doc);
  webFontTable(url, doc);
  return url;
};
globalThis.__csimWebFontLoadUrl = function (src, doc) {
  const url = absoluteFontUrl(src, doc);
  return { url, table: webFontTable(url, doc) };
};

// A font's `0` advance and x-height, as per-em factors — CSS's `ch` and `ex`.
// Both fall back to the spec's 0.5em when the font can't be read or doesn't carry
// the metric (`ex` needs OS/2 version 2; `ch` needs the font to map U+0030).
export const FALLBACK_CH_EM = 0.5;
export const FALLBACK_EX_EM = 0.5;

export function chFactor(family, weightStyle) {
  const t = advanceTableFor(family, weightStyle);
  if (!t) return FALLBACK_CH_EM;
  // The SAME fallback chain `measureRun` walks — the table's own advance, else its
  // mean for a character it has no figure for. A `ch` that fell straight to 0.5em
  // while the run it is supposed to match measured by the mean is how the unit and
  // the text it sizes came apart on a font with no digits.
  const zero = t.adv ? t.adv['0'] : undefined;
  if (typeof zero === 'number' && zero > 0) return zero;
  return typeof t.avg === 'number' && t.avg > 0 ? t.avg : FALLBACK_CH_EM;
}

export function exFactor(family, weightStyle) {
  const t = advanceTableFor(family, weightStyle);
  const xh = t ? t.xh : undefined;
  return typeof xh === 'number' && xh > 0 ? xh : FALLBACK_EX_EM;
}
