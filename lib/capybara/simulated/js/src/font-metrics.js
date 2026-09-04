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
  // the stack that has one, its face picked by weight and style; the system face answers for
  // the rest. The hot path is one lookup: the stack's resolved URL is memoised per face index.
  const doc = globalThis.document;
  // The gate: a declared `@font-face` (cascade.js, O(1)) OR a face script added to the set.
  const hasFaces = doc && ((typeof globalThis.__csimDocHasFontFace !== 'function' || globalThis.__csimDocHasFontFace()) || (doc._fontFaceSet && doc._fontFaceSet._faces.size > 0));
  const idx = hasFaces ? fontFaceIndex(doc) : null;
  let face = null;
  if (idx && idx.families.size) {
    const memoKey = family + '|' + weightStyle;
    if (idx.stackMemo.has(memoKey)) face = idx.stackMemo.get(memoKey);
    else {
      for (const fam of splitFontStack(family)) {
        face = pickFace(idx, fam, weightStyle);
        if (face) break;
      }
      idx.stackMemo.set(memoKey, face);
    }
  }
  if (face && face.table) return applyFaceMetrics(face.table, face.metrics);
  const key = family + ' ' + weightStyle + (face ? ' @' + face.url + (face.metrics ? '#' + face.metrics.sizeAdjust + ',' + face.metrics.asc + ',' + face.metrics.desc + ',' + face.metrics.gap : '') : '');
  if (FONT_TABLES.has(key)) return FONT_TABLES.get(key);
  let t = face ? applyFaceMetrics(webFontTable(face.url, doc, face && (face.rule ? { rule: face.rule } : face.face)), face.metrics) : null;
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
// The document's faces: family (lowercased) → [{ url, weight, style, rule | face }], built
// from the `@font-face` rules that apply (cascade.js `fontFaceRulesOf`: the sheets the
// cascade takes, `@import` / `@media` / `@supports` walked, each src resolved against ITS
// sheet) and the faces script added to `document.fonts`. Memoised per settle generation AND
// cascade version — an `insertRule` / `deleteRule` bumps the version without a DOM mutation.
function fontFaceIndex(doc) {
  const gen = (globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0) + ':' +
              (globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0) + ':' +
              (doc._fontFaceSet ? doc._fontFaceSet._addedGen | 0 : 0);
  if (doc.__csimFontFaceIndex && doc.__csimFontFaceIndex.gen === gen) return doc.__csimFontFaceIndex;
  const families = new globalThis.Map();
  const add = (family, src, weight, style, rule, face, metrics) => {
    const fam = String(family || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (!fam) return;
    const chosen = fontFaceUrl(src);
    if (!chosen) return;
    const url = absoluteFontUrl(chosen, rule ? rule.base : (doc.baseURI || undefined));
    if (!families.has(fam)) families.set(fam, []);
    const w = weightRange(weight);
    families.get(fam).push({ url, wlo: w[0], whi: w[1], style: String(style || 'normal').toLowerCase(), rule: rule ? rule.rule : null, face: face || null, metrics });
  };
  const rules = typeof globalThis.__csimFontFaceRules === 'function' ? globalThis.__csimFontFaceRules(doc) : [];
  for (const entry of rules) {
    const st = entry.rule.style;
    if (!st) continue;
    add(st.getPropertyValue('font-family'), st.getPropertyValue('src'), st.getPropertyValue('font-weight'), st.getPropertyValue('font-style'), entry, null,
        faceMetrics(st.getPropertyValue('size-adjust'), st.getPropertyValue('ascent-override'), st.getPropertyValue('descent-override'), st.getPropertyValue('line-gap-override')));
  }
  const set = doc._fontFaceSet;
  if (set && set._faces) set._faces.forEach((f) => {
    if (typeof f._source === 'string') add(f.family, f._source, f.weight, f.style, null, f, faceMetrics(f.sizeAdjust, f.ascentOverride, f.descentOverride, f.lineGapOverride));
    else if (f._table) {                                          // a face built from a buffer: its bytes are its table
      const fam = String(f.family || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!families.has(fam)) families.set(fam, []);
      const w = weightRange(f.weight);
      families.get(fam).push({ url: '', table: f._table, wlo: w[0], whi: w[1], style: String(f.style || 'normal').toLowerCase(), rule: null, face: f, metrics: faceMetrics(f.sizeAdjust, f.ascentOverride, f.descentOverride, f.lineGapOverride) });
    }
  });
  return (doc.__csimFontFaceIndex = { gen, families, stackMemo: new globalThis.Map(), rules });
}
// The `@font-face` metric descriptors that reshape the table: `size-adjust` scales every
// advance and the font's own metrics; `ascent-override` / `descent-override` /
// `line-gap-override` REPLACE the line box metrics (a percentage of the used font size, so an
// em fraction). Returns null when the face declares none (the common case, no work later).
function faceMetrics(sizeAdjust, asc, desc, gap) {
  const sa = pctFraction(sizeAdjust), a = pctFraction(asc), d = pctFraction(desc), g = pctFraction(gap);
  if (sa == null && a == null && d == null && g == null) return null;
  return { sizeAdjust: sa == null ? 1 : sa, asc: a, desc: d, gap: g };
}
// A `<percentage>` descriptor → a fraction (`200%` → 2), or null for `normal` / absent / a
// value we don't evaluate (`calc()`).
function pctFraction(v) {
  if (v == null) return null;
  const m = /^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))%\s*$/.exec(String(v));
  return m ? parseFloat(m[1]) / 100 : null;
}
// The advance table reshaped by a face's metric descriptors: `size-adjust` scales the
// advances (`adv` map + `avg`) and the intrinsic vertical metrics; the overrides then replace
// `asc` / `desc` / `gap`. The url path caches the result in `FONT_TABLES`; a buffer face's
// table is small and reshaped on read.
function applyFaceMetrics(table, metrics) {
  if (!table || !metrics) return table;
  const sa = metrics.sizeAdjust;
  // `size-adjust` scales the RESOLVED vertical metric — an override included (Chrome: the
  // fallback-matching recipe sets `size-adjust` AND the overrides together, and a 100% ascent
  // override under `size-adjust: 200%` is 2em, not 1em).
  const out = { avg: table.avg * sa, xh: table.xh * sa,
                asc:  (metrics.asc  != null ? metrics.asc  : (table.asc  || 0)) * sa,
                desc: (metrics.desc != null ? metrics.desc : (table.desc || 0)) * sa,
                gap:  (metrics.gap  != null ? metrics.gap  : (table.gap  || 0)) * sa };
  if (sa === 1) { out.adv = table.adv; }
  else { const adv = {}; for (const k in table.adv) adv[k] = table.adv[k] * sa; out.adv = adv; }
  return out;
}
// `font-weight` descriptor → `[lo, hi]` (one keyword / number is a point range; `bold` 700,
// `normal` 400).
function weightRange(v) {
  const parts = String(v || 'normal').trim().toLowerCase().split(/\s+/).map((t) => t === 'bold' ? 700 : t === 'normal' ? 400 : parseFloat(t)).filter((n) => isFinite(n));
  if (!parts.length) return [400, 400];
  return [Math.min(parts[0], parts[parts.length - 1]), Math.max(parts[0], parts[parts.length - 1])];
}
// The distance from a target weight to a face's range, ordered as CSS Fonts 4 §5.2: 0 inside the
// range; for a 400 target, 400–500 preferred ascending, then below descending, then above; for
// 700, at-or-above ascending then below. Returned so a smaller number wins (ties → later rule).
function weightDistance(want, lo, hi) {
  if (want >= lo && want <= hi) return 0;
  const below = want - hi, above = lo - want;                 // one is > 0
  if (want < 400)      return below > 0 ? below : 100000 + above;   // <400: below then above
  else if (want <= 500) {                                       // 400–500: 400..500 up, then down, then >500
    if (above > 0) return above <= (500 - want) ? above : 100000 + above;   // just above, still ≤500
    return 50000 + below;
  }
  return above > 0 ? above : 50000 + below;                    // ≥bold: at/above up, then below
}
// The face for `family` at the run's weight / style: same style first, then the nearest weight
// (layout only distinguishes bold, so the target is 400 / 700). A tie goes to the LATER rule.
function pickFace(idx, family, weightStyle) {
  const faces = idx.families.get(family.toLowerCase());
  if (!faces || !faces.length) return null;
  const want = /bold/.test(weightStyle) ? 700 : 400, wantItalic = /italic/.test(weightStyle);
  let best = null, bestScore = Infinity;
  for (const f of faces) {
    const italic = f.style === 'italic' || f.style === 'oblique';
    const score = (italic === wantItalic ? 0 : 1e9) + weightDistance(want, f.wlo, f.whi);
    if (score <= bestScore) { best = f; bestScore = score; }   // `<=`: the later of equals wins
  }
  return best;
}
// The @font-face src URL (absolute) for `family` at the default weight / style, or '' — what
// the canvas text host hands pango.
export function resolveFontFace(doc, family) {
  const face = pickFace(fontFaceIndex(doc), family, '');
  return face ? face.url : '';
}
// The `url()` of a `src` list a browser would take: the first one whose `format()` (or
// extension) is a container the host reads — TrueType / OpenType / WOFF; a WOFF2 face has no
// decoder on the host, so it is taken only when nothing else is offered (fetched, then
// measured with the fallback family). A `local()` source is skipped.
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
function absoluteFontUrl(src, base) {
  try { return new globalThis.URL(src, base || (globalThis.location && globalThis.location.href) || undefined).href; }
  catch (_) { return src; }
}
// One fetch per face URL per realm: the table (null when the host cannot read the file), the
// facts (`ok`: bytes arrived — a WOFF2 face loads even though it measures with the fallback),
// a Resource Timing entry (initiator `css`, as Chrome files a font a stylesheet pulled in) and,
// when a face asked, that face's settlement in the FontFaceSet's loading cycle.
const WEB_FONT_TABLES = new globalThis.Map();   // url → { table, ok }
export function webFontTable(url, doc, face) {
  let entry = WEB_FONT_TABLES.get(url);
  if (!entry) {
    let table = null, meta = null, ok = false;
    const started = globalThis.performance ? globalThis.performance.now() : 0;
    try {
      let r = null;
      if (/^blob:/i.test(url)) {
        const blob = typeof globalThis.__csimResolveBlobBytes === 'function' ? globalThis.__csimResolveBlobBytes(url) : null;
        r = blob && blob.bytes != null && globalThis.__csim_fontAdvancesFromBytes ? globalThis.__csim_fontAdvancesFromBytes(globalThis.btoa(blob.bytes)) : null;
      } else if (globalThis.__csim_fontAdvancesFromUrl) {
        r = globalThis.__csim_fontAdvancesFromUrl(url);
      }
      if (r) { table = r.table || null; meta = r.meta || null; ok = !!r.ok; }
    } catch (_) { table = null; }
    entry = { table, ok };
    WEB_FONT_TABLES.set(url, entry);
    if (typeof globalThis.__csimRecordResource === 'function') {
      globalThis.__csimRecordResource({ name: url, initiatorType: 'css', startTime: started, resp: meta, noCors: false });
    }
  }
  // The set to settle the face in: the document's, or — in a worker (no document) — the
  // worker's own `self.fonts`, so `FontFace.load()` / `self.fonts.load()` resolves there too.
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.fonts);
  if (face && set && typeof set._faceFetched === 'function') set._faceFetched(face, entry.ok);
  return entry.table;
}
// What a face's chosen `src` already went through: 'loaded' / 'error' after its fetch, else
// 'unloaded'.
export function webFontStatus(src, base) {
  const chosen = fontFaceUrl(src);
  if (!chosen) return 'unloaded';
  const entry = WEB_FONT_TABLES.get(absoluteFontUrl(chosen, base));
  return entry ? (entry.ok ? 'loaded' : 'error') : 'unloaded';
}
globalThis.__csimWebFontStatus = webFontStatus;
globalThis.__csimFontFaceIndex = fontFaceIndex;
// A face's own bytes (a `FontFace` built from a buffer): the host parses them; `ok` says
// whether they are a font at all.
export function webFontTableFromBytes(b64) {
  try { const r = globalThis.__csim_fontAdvancesFromBytes ? globalThis.__csim_fontAdvancesFromBytes(b64) : null; return r ? { table: r.table || null, ok: !!r.ok } : { table: null, ok: false }; }
  catch (_) { return { table: null, ok: false }; }
}
// The FontFaceSet's `load()` / `FontFace.load()` reach the fetch through these
// (platform-globals.js cannot import layout-side modules).
globalThis.__csimWebFontLoad = function (doc, family) {
  const idx = fontFaceIndex(doc);
  const faces = idx.families.get(String(family).toLowerCase()) || [];
  for (const f of faces) if (f.url) webFontTable(f.url, doc, f.rule ? { rule: f.rule } : f.face);
  return faces.length;
};
globalThis.__csimWebFontLoadUrl = function (src, doc, face) {
  const chosen = fontFaceUrl(src);
  if (!chosen) return { url: '', ok: false };
  const url = absoluteFontUrl(chosen, doc && doc.baseURI);
  const table = webFontTable(url, doc, face);
  const entry = WEB_FONT_TABLES.get(url);
  return { url, table, ok: !!(entry && entry.ok) };
};
globalThis.__csimWebFontFromBytes = webFontTableFromBytes;

// ── the font shorthand, for `document.fonts.check()` / `load()` ──
// The family list of a `font` shorthand (`[style] [weight] size[/line-height] family, …`);
// null when it does not parse — a css-wide keyword or a `var()` anywhere, no size, a bare
// family — which the callers turn into a SyntaxError.
const FONT_KEYWORDS = new globalThis.Set(['normal', 'italic', 'oblique', 'small-caps', 'bold', 'bolder', 'lighter',
  'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed', 'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded']);
const FONT_SIZE_KEYWORDS = new globalThis.Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'larger', 'smaller']);
const CSS_WIDE = new globalThis.Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']);
export function fontShorthandFamilies(font) {
  const CT = globalThis.__csimVendor && globalThis.__csimVendor.cssTree;
  const raw = String(font == null ? '' : font).trim();
  if (!raw || !CT || /var\(/i.test(raw)) return null;
  let ast;
  try { ast = CT.parse(raw, { context: 'value' }); } catch (_) { return null; }
  const toks = [];
  ast.children.forEach((n) => { if (n.type !== 'WhiteSpace') toks.push(n); });
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'Identifier' && FONT_KEYWORDS.has(t.name.toLowerCase())) continue;
    if (t.type === 'Number' && +t.value >= 1 && +t.value <= 1000) continue;
    break;
  }
  const st = toks[i];
  if (!st) return null;
  if (!(st.type === 'Dimension' || st.type === 'Percentage' || (st.type === 'Identifier' && FONT_SIZE_KEYWORDS.has(st.name.toLowerCase())))) return null;
  i++;
  if (toks[i] && toks[i].type === 'Operator' && toks[i].value === '/') i += 2;
  const families = [];
  let cur = null;
  const flush = () => {
    if (cur == null) return false;
    if (cur.ident && CSS_WIDE.has(cur.text.toLowerCase())) return false;
    families.push(cur.text); cur = null; return true;
  };
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'Operator' && t.value === ',') { if (!flush()) return null; }
    else if (t.type === 'String') { if (cur != null) return null; cur = { text: t.value, ident: false }; }
    else if (t.type === 'Identifier') { cur = cur == null ? { text: t.name, ident: true } : { text: cur.text + ' ' + t.name, ident: true }; }
    else return null;
  }
  if (!flush()) return null;
  return families.length ? families : null;
}
globalThis.__csimFontShorthandFamilies = fontShorthandFamilies;

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
