// The faces a family resolves to — a system font, or a document's `@font-face` — and the font tables they carry, which
// the native side (font.rs, style_fonts.rs) is told of as it asks for them (`teachFaces`).
//
// The per-character table comes from the font FILE's own `hmtx` (host side: `font_advance_table`), so nothing is
// rasterised: one host call per (family, weight/style) for the whole table.
import { latin1ToBytes } from './bytes.js';

const FONT_TABLES = new globalThis.Map();
// "family|weightStyle" -> true when advanceTableFor resolved a fontconfig SYSTEM font (no @font-face
// matched), false when an @font-face provided the table. Native text metrics (layout.js) may parse a
// font from its fontconfig PATH only in the system case; a face's table came from bytes / a local name.
const SYSTEM_FONT = new globalThis.Map();
export function fontIsSystem(family, weightStyle) {
  return SYSTEM_FONT.get(family + '|' + weightStyle) === true;
}

export function advanceTableFor(family, weightStyle) {
  // A family the document declares an `@font-face` for measures with the DOWNLOADED face —
  // fetched on first use, as Chrome loads a web font when text needs it — the first family of
  // the stack that has one, its face picked by weight and style; the system face answers for
  // the rest. The hot path is one lookup: the stack's resolved URL is memoised per face index.
  const doc = globalThis.document;
  const ft = resolvedFaceTable(declaredFaceFor(doc, family, weightStyle), doc);
  if (ft) { SYSTEM_FONT.set(family + '|' + weightStyle, false); return ft; }
  // No matching face, or its file was unreadable: the system face fontconfig substitutes — the case
  // native measure can parse from the fontconfig path (same file, same advances).
  SYSTEM_FONT.set(family + '|' + weightStyle, true);
  const key = 'sys ' + family + ' ' + weightStyle;
  if (FONT_TABLES.has(key)) return FONT_TABLES.get(key);
  let t = null;
  try {
    t = globalThis.__csim_fontAdvances ? globalThis.__csim_fontAdvances(family, weightStyle) : null;
  } catch (_) { t = null; }
  FONT_TABLES.set(key, t);
  return t;
}
// The `@font-face` a family stack takes as its own — the first family of the stack that has one, its face picked by
// weight and style — or null where the document declares none for it. Memoised per (stack, weight / style).
function declaredFaceFor(doc, family, weightStyle) {
  // The gate: a declared `@font-face` (cascade.js, O(1)) OR a face script added to the set.
  const hasFaces = doc && ((typeof globalThis.__csimDocHasFontFace !== 'function' || globalThis.__csimDocHasFontFace()) || (doc._fontFaceSet && doc._fontFaceSet._faces.size > 0));
  const idx = hasFaces ? fontFaceIndex(doc) : null;
  if (!idx || !idx.families.size) return null;
  const memoKey = family + '|' + weightStyle;
  if (idx.stackMemo.has(memoKey)) return idx.stackMemo.get(memoKey);
  let face = null;
  for (const fam of splitFontStack(family)) {
    face = pickFace(idx, fam, weightStyle);
    if (face) break;
  }
  idx.stackMemo.set(memoKey, face);
  return face;
}
// One face-index entry → its advance table with the metric descriptors applied, or null when the
// face's file could not be read. A buffer face carries its own table; a url face is fetched once
// and memoised per (url, descriptors). Shared by `advanceTableFor` (the primary face) and
// `faceStackFor` (every candidate in a unicode-range split).
const LOCAL_TABLES = new globalThis.Map();                     // `local()` name → host table, per realm
function resolvedFaceTable(face, doc) {
  if (!face) return null;
  if (face.table) return applyFaceMetrics(face.table, face.metrics);
  // `local(<name>)` first — a browser prefers a font installed under that name to a download.
  if (face.locals && face.locals.length) {
    const t = localFaceTable(face, doc);
    if (t) return t;
  }
  if (face.url) {
    const key = '@' + face.url + (face.metrics ? '#' + face.metrics.sizeAdjust + ',' + face.metrics.asc + ',' + face.metrics.desc + ',' + face.metrics.gap : '');
    let t;
    if (FONT_TABLES.has(key)) {
      // A cache hit skips `webFontTable`, which is what SETTLES the face — so a second face sharing
      // this URL (e.g. a `TwoSrc` and an `OnlyWoff2` both on the same woff2) would never leave
      // `unloaded`. Settle it here instead; the table's presence is its success.
      t = FONT_TABLES.get(key);
      settleFace(face, doc, !!t);                              // a shared URL that FAILED settles this face error too
    } else {
      t = applyFaceMetrics(webFontTable(face.url, doc, face.rule ? { rule: face.rule } : face.face), face.metrics);
      FONT_TABLES.set(key, t);
    }
    if (t) return t;
  }
  // Neither a local nor a readable download resolved. A url face was already settled by
  // `webFontTable`'s loading cycle; a local-only face is settled here as a FAILURE — a browser
  // rejects a UA font load it cannot satisfy (`font-face-reject`: `loaded` → NetworkError).
  if (!face.url) settleFace(face, doc, false);
  return null;
}
// The installed-font table for a face's `local(<name>)` sources, in order, or null when this
// machine has none of them. A resolved local settles the face as loaded. Memoised per (name,
// weight/style) so a relayout does not re-ask fontconfig.
function localFaceTable(face, doc) {
  if (typeof globalThis.__csim_localFontTable !== 'function') return null;
  const ws = localWeightStyle(face);
  for (const name of face.locals) {
    const key = name + '|' + ws;
    let r;
    if (LOCAL_TABLES.has(key)) r = LOCAL_TABLES.get(key);
    else { try { r = globalThis.__csim_localFontTable(name, ws); } catch (_) { r = null; } LOCAL_TABLES.set(key, r); }
    if (r && r.ok && r.table) { settleFace(face, doc, true); return applyFaceMetrics(r.table, face.metrics); }
  }
  return null;
}
// The weight/style a face's `local()` names are looked up under — its OWN descriptors, in the colon form `fc_match`
// expects. ONE answer for the advance table (`localFaceTable`) and native's file (`faceSfntPath`).
function localWeightStyle(face) {
  const bold = face.wlo >= 600, italic = face.style === 'italic' || face.style === 'oblique';
  return (bold ? 'bold' : '') + (italic ? (bold ? ':italic' : 'italic') : '');
}
// Settle a face in its FontFaceSet's loading cycle — the document's, or a worker's `self.fonts`.
function settleFace(face, doc, ok) {
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.fonts);
  if (set && typeof set._faceFetched === 'function') set._faceFetched(face.rule ? { rule: face.rule } : face.face, ok);
}
// The ordered candidate faces a run's characters pick from when the family stack has a
// `unicode-range`-restricted face — each character takes the FIRST candidate whose range covers
// it, so a `size-adjust` face scoped to A–Z reshapes only those glyphs and the rest fall through
// to the next face. Returns null (the hot path) unless some `@font-face` in the document restricts
// its range: `{ ranges, table, sizeMul }` in stack-then-weight/style order, `ranges === null` a
// universal face that covers everything. Memoised per face index like `advanceTableFor`.
export function faceStackFor(family, weightStyle) {
  const doc = globalThis.document;
  const hasFaces = doc && ((typeof globalThis.__csimDocHasFontFace !== 'function' || globalThis.__csimDocHasFontFace()) || (doc._fontFaceSet && doc._fontFaceSet._faces.size > 0));
  if (!hasFaces) return null;
  const idx = fontFaceIndex(doc);
  if (!idx.families.size || !idx.restricted) return null;       // O(1): no face restricts a range
  const memoKey = 'stack|' + family + '|' + weightStyle;
  if (idx.stackMemo.has(memoKey)) return idx.stackMemo.get(memoKey);
  const cands = [];
  let anyRestricted = false;
  for (const fam of splitFontStack(family)) {
    for (const face of pickFaces(idx, fam, weightStyle)) {
      const table = resolvedFaceTable(face, doc);
      if (!table) continue;
      if (face.ranges) anyRestricted = true;
      cands.push({ ranges: face.ranges, table, sizeMul: face.metrics ? face.metrics.sizeAdjust : 1, face });
    }
  }
  // The last resort: a character no face's range covers takes the SYSTEM font, not the (possibly
  // range-restricted, size-adjusted) primary — Chrome never renders a codepoint through a face that
  // excludes it. A universal candidate at the end, reached only when no face above it covers.
  if (anyRestricted) {
    let sys = null;
    try { sys = globalThis.__csim_fontAdvances ? globalThis.__csim_fontAdvances(family, weightStyle) : null; } catch (_) { sys = null; }
    if (sys) cands.push({ ranges: null, table: sys, sizeMul: 1, face: null });
  }
  const result = anyRestricted && cands.length ? cands : null;  // no restriction survived → hot path
  idx.stackMemo.set(memoKey, result);
  return result;
}

// ── downloaded faces (`@font-face`) ──
// `family, family, generic` → the families, unquoted.
export function splitFontStack(stack) {
  return String(stack || '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}
// The document's faces: family (lowercased) → [{ url, weight, style, rule | face }], built
// from the `@font-face` rules that apply (cascade.js `fontFaceRulesOf`: the sheets the
// cascade takes, `@import` / `@media` / `@supports` walked, each src resolved against ITS
// sheet) and the faces script added to `document.fonts`. Memoised on what decides that set: the cascade version
// (every sheet the cascade takes is in its content key — a `<style>` / `<link>` inserted, removed or re-selected,
// the viewport a `@media` reads, an `insertRule` — and the version moves exactly when that key does) and the
// set's own generation. It was keyed on the SETTLE generation too, which moves on every DOM mutation: each one
// walked every sheet again for its `@font-face` rules, fingerprinting every `<style>`'s text on the way
// (`cascadeCacheKey`) — the largest single cost of a relayout on a page that declares a web font.
function fontFaceIndex(doc) {
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const fg = doc._fontFaceSet ? doc._fontFaceSet._facesGen | 0 : 0;
  const kept = doc.__csimFontFaceIndex;
  if (kept && kept.cv === cv && kept.fg === fg) return kept;
  const families = new globalThis.Map();
  const add = (family, src, weight, style, rule, face, metrics, unicodeRange) => {
    const fam = String(family || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (!fam) return;
    const chosen = fontFaceUrl(src);
    const locals = fontFaceLocals(src);
    if (!chosen && !locals.length) return;                     // neither a readable url nor a local()
    const url = chosen ? absoluteFontUrl(chosen, rule ? rule.base : (doc.baseURI || undefined)) : '';
    if (!families.has(fam)) families.set(fam, []);
    const w = weightRange(weight);
    const ranges = parseUnicodeRange(unicodeRange);
    if (ranges) restricted = true;
    families.get(fam).push({ url, locals, wlo: w[0], whi: w[1], style: String(style || 'normal').toLowerCase(), rule: rule ? rule.key : null, face: face || null, metrics, ranges });
  };
  let restricted = false;                                         // any face carries a non-universal unicode-range
  const rules = typeof globalThis.__csimFontFaceRules === 'function' ? globalThis.__csimFontFaceRules(doc) : [];
  for (const entry of rules) {
    const st = entry.rule.style;
    if (!st) continue;
    add(st.getPropertyValue('font-family'), st.getPropertyValue('src'), st.getPropertyValue('font-weight'), st.getPropertyValue('font-style'), entry, null,
        faceMetrics(st.getPropertyValue('size-adjust'), st.getPropertyValue('ascent-override'), st.getPropertyValue('descent-override'), st.getPropertyValue('line-gap-override')),
        st.getPropertyValue('unicode-range'));
  }
  const set = doc._fontFaceSet;
  if (set && set._faces) set._faces.forEach((f) => {
    if (typeof f._source === 'string') add(f.family, f._source, f.weight, f.style, null, f, faceMetrics(f.sizeAdjust, f.ascentOverride, f.descentOverride, f.lineGapOverride), f.unicodeRange);
    else if (f._table) {                                          // a face built from a buffer: its bytes are its table
      const fam = String(f.family || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!families.has(fam)) families.set(fam, []);
      const w = weightRange(f.weight);
      const ranges = parseUnicodeRange(f.unicodeRange);
      if (ranges) restricted = true;
      families.get(fam).push({ url: '', path: f._sfntPath, table: f._table, wlo: w[0], whi: w[1], style: String(f.style || 'normal').toLowerCase(), rule: null, face: f, metrics: faceMetrics(f.sizeAdjust, f.ascentOverride, f.descentOverride, f.lineGapOverride), ranges });
    }
  });
  return (doc.__csimFontFaceIndex = { cv, fg, families, stackMemo: new globalThis.Map(), rules, restricted });
}
// The `@font-face` metric descriptors that reshape the table: `size-adjust` scales every
// advance and the font's own metrics; `ascent-override` / `descent-override` /
// `line-gap-override` REPLACE the line box metrics (a percentage of the used font size, so an
// em fraction). Returns null when the face declares none (the common case, no work later) — and a `size-adjust` of
// 100%, the identity, is none: a `FontFace` reports it for every face that sets nothing.
function faceMetrics(sizeAdjust, asc, desc, gap) {
  const sa = pctFraction(sizeAdjust), a = pctFraction(asc), d = pctFraction(desc), g = pctFraction(gap);
  if ((sa == null || sa === 1) && a == null && d == null && g == null) return null;
  return { sizeAdjust: sa == null ? 1 : sa, asc: a, desc: d, gap: g };
}
// A `<percentage>` descriptor → a fraction (`200%` → 2), or null for `normal` / absent / a
// value we don't evaluate (`calc()`).
function pctFraction(v) {
  if (v == null) return null;
  const m = /^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))%\s*$/.exec(String(v));
  return m ? parseFloat(m[1]) / 100 : null;
}
// A `unicode-range` descriptor → the codepoint intervals `[lo, hi]` it covers, or null when it
// covers everything (absent, or the `U+0-10FFFF` default) — null is the fast path: a face with
// no restriction takes any character. `U+41` is a point, `U+41-5A` a range, `U+4??` a wildcard
// (`?` spans 0–F in that digit). A token we can't read is skipped.
function parseUnicodeRange(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s || /^u\+0-10ffff$/i.test(s)) return null;
  const ranges = [];
  for (const tok of s.split(',')) {
    const t = tok.trim();
    let m;
    if ((m = /^u\+([0-9a-f]{1,6})-([0-9a-f]{1,6})$/i.exec(t))) {
      ranges.push([parseInt(m[1], 16), parseInt(m[2], 16)]);
    } else if ((m = /^u\+([0-9a-f?]{1,6})$/i.exec(t))) {
      const hex = m[1];
      if (hex.indexOf('?') !== -1) ranges.push([parseInt(hex.replace(/\?/g, '0'), 16), parseInt(hex.replace(/\?/g, 'f'), 16)]);
      else { const v = parseInt(hex, 16); ranges.push([v, v]); }
    }
  }
  return ranges.length ? ranges : null;
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
// Every face for `family`, weight/style-ordered (best first), for a per-character unicode-range
// split — a character then walks these and takes the first whose range covers it. A tie keeps the
// LATER rule ahead, as `pickFace`'s `<=` does when it collapses the list to one.
function pickFaces(idx, family, weightStyle) {
  const faces = idx.families.get(family.toLowerCase());
  if (!faces || !faces.length) return [];
  const want = /bold/.test(weightStyle) ? 700 : 400, wantItalic = /italic/.test(weightStyle);
  return faces
    .map((f, i) => {
      const italic = f.style === 'italic' || f.style === 'oblique';
      return { f, i, score: (italic === wantItalic ? 0 : 1e9) + weightDistance(want, f.wlo, f.whi) };
    })
    .sort((a, b) => a.score - b.score || b.i - a.i)            // equal score → later rule first
    .map((x) => x.f);
}
// The @font-face src URL (absolute) for `family` at the default weight / style, or '' — what
// the canvas text host hands pango.
export function resolveFontFace(doc, family) {
  const face = pickFace(fontFaceIndex(doc), family, '');
  return face ? face.url : '';
}
// The `url()` of a `src` list a browser would take: the first one whose `format()` (or
// extension) is a container the host reads — TrueType / OpenType / WOFF / WOFF2 (the host
// Brotli-decompresses WOFF2 for its metrics). `embedded-opentype` (EOT) and SVG fonts have no
// decoder, so they are taken only when nothing else is offered. A `local()` source is skipped.
const UNREADABLE_FORMAT_RE = /embedded-opentype|svg/i;
export function fontFaceUrl(src) {
  const text = typeof src === 'string' ? src : '';
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/g;
  let m, first = '';
  while ((m = re.exec(text))) {
    const url = m[2].trim();
    const format = m[4] ? m[4] : (/\.(?:eot|svg)(?:$|[?#])/i.test(url) ? 'embedded-opentype' : '');
    if (!UNREADABLE_FORMAT_RE.test(format)) return url;
    if (!first) first = url;
  }
  return first;
}
// The `local(<name>)` names a `src` lists, in order — the installed fonts a face names before (or
// instead of) a downloadable one.
export function fontFaceLocals(src) {
  const text = typeof src === 'string' ? src : '';
  const re = /local\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) { const n = m[2].trim(); if (n) out.push(n); }
  return out;
}
function absoluteFontUrl(src, base) {
  try { return new globalThis.URL(src, base || (globalThis.location && globalThis.location.href) || undefined).href; }
  catch (_) { return src; }
}
// One fetch per face URL per realm: the table (null when the host cannot read the file), the
// facts (`ok`: bytes arrived — a face whose bytes the host cannot read still loads),
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
        r = blob && blob.bytes != null && globalThis.__csim_fontAdvancesFromBytes ? globalThis.__csim_fontAdvancesFromBytes(latin1ToBytes(blob.bytes)) : null;
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
// The on-disk SFNT path for a family's @font-face — the SAME decoded file the host measures advances from (its
// `font_file_for`: fetched once, WOFF/WOFF2 decoded, cached; a buffer face's bytes decoded the same way), so native
// (skrifa) and the host read identical hmtx advances — with the face's `size-adjust`, `{ path, sizeAdjust }`. Null for
// a `unicode-range`-restricted face, which is a STACK of faces (`faceStackFor`), or one with no file.
export function webFontSfntFace(family, weightStyle) {
  const doc = globalThis.document;
  if (!doc || typeof globalThis.__csim_webFontFile !== 'function') return null;
  const hasFaces = (typeof globalThis.__csimDocHasFontFace !== 'function' || globalThis.__csimDocHasFontFace()) ||
                   (doc._fontFaceSet && doc._fontFaceSet._faces.size > 0);
  if (!hasFaces) return null;
  const idx = fontFaceIndex(doc);
  if (!idx || !idx.families.size) return null;
  let face = null;
  for (const fam of splitFontStack(family)) { face = pickFace(idx, fam, weightStyle); if (face) break; }
  // Decline what native can't reproduce by registering one SFNT: a unicode-range face (a run splits across faces). A
  // metric-descriptor face is the file's table RESHAPED: its `size-adjust` scales the advances, which native registers
  // as a face of its own (`registerFontScaled`), and its vertical metrics reach native through `walkFace`.
  if (!face || face.ranges) return null;
  const path = faceSfntPath(face);
  return path ? { path, sizeAdjust: face.metrics ? face.metrics.sizeAdjust : 1 } : null;
}
// A face's SFNT file, the one the host measures: a buffer face's is the file its bytes were decoded to; otherwise
// `resolvedFaceTable` prefers a font INSTALLED under a `local()` name to the download, so those come first, in order —
// the very file `local_font_table` read (a face listing one was declined outright until 2026-09-26, which was EVERY text
// block on every Mastodon page: `src: local("Roboto"), url(…)`). Null where there is none.
function faceSfntPath(face) {
  if (face.path) return face.path;   // a buffer face: the file its bytes were decoded to
  try {
    if (face.locals && face.locals.length) {
      if (typeof globalThis.__csim_localFontFile !== 'function') return null;
      const ws = localWeightStyle(face);
      for (const name of face.locals) {
        const path = globalThis.__csim_localFontFile(name, ws);
        if (path) return path;
      }
    }
    return face.url && typeof globalThis.__csim_webFontFile === 'function' ? globalThis.__csim_webFontFile(face.url) || null : null;
  } catch (_) { return null; }
}
// A family stack whose `@font-face`s split a run's characters by `unicode-range` (`faceStackFor`), registered natively
// as one face (`registerFontStack`): each candidate its own registered face — a downloaded one under its `size-adjust`,
// the last resort the family's SYSTEM font — in pick order with its vertical metrics (which raise the line a run's
// characters select it on, font.rs `run_vmax`) and its ranges. The stack's own face is the one `advanceTableFor` resolves
// the family to — what a character no candidate covers is measured by, and what a `ch` is (style_fonts.rs): its declared
// face, or the system font — the candidate of no face — where it has none or that face's file is unreadable. -1 where
// any candidate has no file native can read, or none is the stack's own.
function nativeStackHandle(d, family, ws, stack) {
  advanceTableFor(family, ws);
  const own = fontIsSystem(family, ws) ? null : declaredFaceFor(globalThis.document, family, ws);
  const flat = [];
  let primary = -1;
  for (const cand of stack) {
    let h;
    if (cand.face) {
      const path = faceSfntPath(cand.face);
      h = path ? d.registerFontPath(path) : -1;
      if (h >= 0 && cand.sizeMul !== 1) h = d.registerFontScaled(h, cand.sizeMul);
    } else {
      let path = null;
      try { path = globalThis.__csim_fontFile(family, ws); } catch (_) { path = null; }
      h = path ? d.registerFontPath(path) : -1;
    }
    if (h < 0) return -1;
    if (cand.face === own && primary < 0) primary = h;
    const t = cand.table;
    flat.push(h, t.asc != null ? t.asc : NaN, t.desc != null ? t.desc : NaN, t.gap || 0, cand.ranges ? cand.ranges.length : -1);
    if (cand.ranges) for (const [lo, hi] of cand.ranges) flat.push(lo, hi);
  }
  return d.registerFontStack(primary, Float64Array.from(flat));
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
// A face's own bytes (a `FontFace` built from a buffer, as a Uint8Array): the host parses
// them; `ok` says whether they are a font at all.
export function webFontTableFromBytes(bytes) {
  try { const r = globalThis.__csim_fontAdvancesFromBytes ? globalThis.__csim_fontAdvancesFromBytes(bytes) : null; return r ? { table: r.table || null, ok: !!r.ok, path: r.path || null } : { table: null, ok: false, path: null }; }
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

// ── the font shorthand, for `document.fonts.check()` / `load()` ──
// The family list of a `font` shorthand (`[style] [weight] size[/line-height] family, …`), the style engine's parse of
// it (`__dom.fontShorthandFamilies`); null when it does not parse — a CSS-wide keyword or a `var()` anywhere, no size, a
// bare family — which the callers turn into a SyntaxError.
export function fontShorthandFamilies(font) {
  return globalThis.__dom.fontShorthandFamilies(String(font == null ? '' : font));
}
globalThis.__csimFontShorthandFamilies = fontShorthandFamilies;




// ── native faces ────────────────────────────────────────────────────────────
const NAT_FONT = new globalThis.Map();
let NAT_FONT_GEN = null;
// The @font-face generation that decides which face a family resolves to — the cascade version (an `insertRule`
// / `<style>` append that adds or drops an `@font-face` bumps it) plus the FontFaceSet's added generation
// (`document.fonts.add`). Mirrors what `fontFaceIndex` keys on, MINUS the per-pass settle generation, so the
// native handle memo below invalidates exactly when the face resolution can change — not every layout pass.
// (…the same string while neither half moves: it is asked on every style-engine read)
let GEN_CV = -1, GEN_AG = -1, GEN = '';
export function natFontGen() {
  const doc = globalThis.document;
  const cv = typeof globalThis.__csimCascadeVersion === 'function' ? globalThis.__csimCascadeVersion() : 0;
  const ag = (doc && doc._fontFaceSet) ? (doc._fontFaceSet._facesGen | 0) : 0;
  if (cv !== GEN_CV || ag !== GEN_AG) {
    GEN_CV = cv;
    GEN_AG = ag;
    GEN = cv + ':' + ag;
  }
  return GEN;
}
// The native (fontations) handle for a family at a weight/style, memoised per pair; -1 when there's no native DOM /
// no host path resolver, or the font's file can't be resolved. A fontconfig SYSTEM font resolves via `__csim_fontFile`;
// an `@font-face` WEB font via `webFontSfntFace` (the SAME decoded SFNT file the advance table is measured from, under
// the face's `size-adjust`); a family whose faces split by `unicode-range` as a stack (`nativeStackHandle`). The memo
// caches the system-vs-web BRANCH decision too, so it is cleared when the @font-face generation advances — otherwise a
// runtime `@font-face` add/remove would leave a stale handle.
function nativeFontHandle(family, ws) {
  const d = globalThis.__dom;
  if (!d || typeof d.registerFontPath !== 'function') return -1;
  const gen = natFontGen();
  if (gen !== NAT_FONT_GEN) { NAT_FONT.clear(); NAT_FONT_GEN = gen; }
  const key = family + '|' + ws;
  let h = NAT_FONT.get(key);
  if (h === undefined) {
    let path = null, sizeAdjust = 1;
    // Which face the family resolves to — a system one or an `@font-face` — is settled where the ADVANCES are
    // (`advanceTableFor`), so it is asked there first: without that, a family the page had not measured yet reads as
    // no system font.
    advanceTableFor(family, ws);
    const stack = typeof d.registerFontStack === 'function' ? faceStackFor(family, ws) : null;
    if (stack) {
      h = nativeStackHandle(d, family, ws, stack);
      NAT_FONT.set(key, h);
      return h;
    }
    if (fontIsSystem(family, ws)) {
      if (typeof globalThis.__csim_fontFile === 'function') { try { path = globalThis.__csim_fontFile(family, ws); } catch (_) { path = null; } }
    } else {
      let face = null;
      try { face = webFontSfntFace(family, ws); } catch (_) { face = null; }
      if (face) ({ path, sizeAdjust } = face);
    }
    h = path ? d.registerFontPath(path) : -1;
    if (h >= 0 && sizeAdjust !== 1) h = d.registerFontScaled(h, sizeAdjust);
    NAT_FONT.set(key, h);
  }
  return h;
}
// The faces native asked for — the Rust walk's, or the style engine's font metrics' — `[family, bucket, …]`, resolved
// and told it (`walkFace`). A face that yields no measure — no file native can read, or a table with no letters or no
// vertical metrics, as a colour emoji font has (`font-family: emoji`) — is told as the face its text FALLS BACK to: the
// next family of the stack that does measure, else the default sans-serif, which a browser draws the letters with
// (Chrome: `emoji, monospace` sets `abc def` in monospace). The walk lays it out with that rather than declining the
// page. (Chrome keeps the emoji face's own space and line box — 62.6 and 19 for `abc def` alone, where this gives
// sans-serif's 52.5 and 17 — which wants a per-character fallback this model does not have.)
const measures = (handle, t) => handle >= 0 && t && t.asc != null && t.desc != null;
export function teachFaces(d, wanted) {
  for (let k = 0; k < wanted.length; k += 2) {
    const family = wanted[k], bucket = wanted[k + 1];
    let handle = nativeFontHandle(family, bucket);
    let t = advanceTableFor(family, bucket);
    if (!measures(handle, t)) {
      for (const next of [...splitFontStack(family).slice(1), 'sans-serif']) {
        handle = nativeFontHandle(next, bucket);
        t = advanceTableFor(next, bucket);
        if (measures(handle, t)) break;
      }
    }
    const space = t ? (t.adv[' '] !== undefined ? t.adv[' '] : t.avg) : NaN;
    d.walkFace(family, bucket, handle, t && t.asc != null ? t.asc : NaN, t && t.desc != null ? t.desc : NaN,
               t ? t.gap || 0 : NaN, space, t && typeof t.xh === 'number' ? t.xh : NaN);
  }
}
// …and the style engine's own, after a style flush (cascade.js `flushStyleEngine`): whether it told any.
// (The generation crosses only when it has moved since it last did — the engine keeps the one it was told.)
let TOLD_GEN = null;
export function teachStyleFaces() {
  const d = globalThis.__dom, gen = natFontGen();
  const wanted = d.styleFaces(gen === TOLD_GEN ? undefined : (TOLD_GEN = gen));
  if (wanted == null) return false;
  teachFaces(d, wanted);
  return true;
}
