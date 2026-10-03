// The faces a family resolves to — a system font, or a document's `@font-face` — and the font FILES they are in, which
// native text metrics read (font.rs: advances, line metrics, x-height) and are told of as they ask (`teachFaces`).
import { latin1ToBytes } from './bytes.js';

// The `@font-face` a family stack is measured with — the first family of the stack that has one, its face picked by
// weight and style, its file loaded (fetched on first use, as Chrome loads a web font when text needs it) and readable
// — or null where the system face fontconfig substitutes answers for it.
function familyFace(family, weightStyle) {
  const doc = globalThis.document;
  const face = declaredFaceFor(doc, family, weightStyle);
  return face && faceFile(face, doc) ? face : null;
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
// One face-index entry → the font file it is read from, or null where it has none native reads: a buffer face's, the
// first of its `local()` names this machine has installed (a browser prefers one to a download), else its download —
// each fetch settling the face in its FontFaceSet's loading cycle. Shared by `familyFace` (the primary face) and
// `faceStackFor` (every candidate in a unicode-range split).
const LOCAL_FILES = new globalThis.Map();                      // `local()` name|weight/style → installed file, per realm
function faceFile(face, doc) {
  if (!face) return null;
  if (face.path !== undefined) return readable(face.path);     // a buffer face: the file its bytes were decoded to
  if (face.locals && face.locals.length) {
    const path = localFaceFile(face, doc);
    if (path) return path;
  }
  if (face.url) {
    const path = readable(webFontFile(face.url, doc, face.rule ? { rule: face.rule } : face.face));
    if (path) return path;
  }
  // Neither a local nor a readable download resolved. A url face was already settled by `webFontFile`'s loading cycle;
  // a local-only face is settled here as a FAILURE — a browser rejects a UA font load it cannot satisfy
  // (`font-face-reject`: `loaded` → NetworkError).
  if (!face.url) settleFace(face, doc, false);
  return null;
}
// A font file native can read (`registerFontPath`, which keeps what it parsed), or null — a `.ttc` collection, a
// container the decoder could not undo.
function readable(path) {
  return path && globalThis.__dom.registerFontPath(path) >= 0 ? path : null;
}
// The installed file for a face's `local(<name>)` sources, in order, or null when this machine has none of them. A
// resolved local settles the face as loaded. Memoised per (name, weight/style) so a relayout does not re-ask
// fontconfig.
function localFaceFile(face, doc) {
  if (typeof globalThis.__csim_localFontFile !== 'function') return null;
  const ws = localWeightStyle(face);
  for (const name of face.locals) {
    const key = name + '|' + ws;
    let path;
    if (LOCAL_FILES.has(key)) path = LOCAL_FILES.get(key);
    else { try { path = globalThis.__csim_localFontFile(name, ws); } catch (_) { path = null; } LOCAL_FILES.set(key, path); }
    if (readable(path)) { settleFace(face, doc, true); return path; }
  }
  return null;
}
// The weight/style a face's `local()` names are looked up under — its OWN descriptors, in the colon form `fc_match`
// expects.
function localWeightStyle(face) {
  const bold = face.wlo >= 600, italic = face.style === 'italic' || face.style === 'oblique';
  return (bold ? 'bold' : '') + (italic ? (bold ? ':italic' : 'italic') : '');
}
// Settle a face in its FontFaceSet's loading cycle — the document's, or a worker's `self.fonts`.
function settleFace(face, doc, ok) {
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.fonts);
  if (set && typeof set._faceFetched === 'function') set._faceFetched(face.rule ? { rule: face.rule } : face.face, ok);
}
// The ordered candidate faces a run's characters pick from when the family stack has a `unicode-range`-restricted face
// — each character takes the FIRST candidate whose range covers it, so a `size-adjust` face scoped to A–Z reshapes only
// those glyphs and the rest fall through to the next face. Returns null (the hot path) unless some `@font-face` in the
// document restricts its range: `{ ranges, sizeMul, face }` in stack-then-weight/style order, `ranges === null` a
// universal face that covers everything, the family's system face (`face` null) the last. Memoised per face index.
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
      if (!faceFile(face, doc)) continue;
      if (face.ranges) anyRestricted = true;
      cands.push({ ranges: face.ranges, sizeMul: face.metrics ? face.metrics.sizeAdjust : 1, face });
    }
  }
  // The last resort: a character no face's range covers takes the SYSTEM font, not the (possibly range-restricted,
  // size-adjusted) primary — Chrome never renders a codepoint through a face that excludes it. A universal candidate at
  // the end, reached only when no face above it covers.
  if (anyRestricted && readable(systemFontFile(family, weightStyle))) cands.push({ ranges: null, sizeMul: 1, face: null });
  const result = anyRestricted && cands.length ? cands : null;  // no restriction survived → hot path
  idx.stackMemo.set(memoKey, result);
  return result;
}
// The file fontconfig resolves a family's system face to, or null.
function systemFontFile(family, weightStyle) {
  try { return globalThis.__csim_fontFile ? globalThis.__csim_fontFile(family, weightStyle) : null; } catch (_) { return null; }
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
    else if (f._sfntPath) {                                       // a face built from a buffer: the file its bytes decode to
      const fam = String(f.family || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!families.has(fam)) families.set(fam, []);
      const w = weightRange(f.weight);
      const ranges = parseUnicodeRange(f.unicodeRange);
      if (ranges) restricted = true;
      families.get(fam).push({ url: '', path: f._sfntPath, wlo: w[0], whi: w[1], style: String(f.style || 'normal').toLowerCase(), rule: null, face: f, metrics: faceMetrics(f.sizeAdjust, f.ascentOverride, f.descentOverride, f.lineGapOverride), ranges });
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
// One fetch per face URL per realm: its decoded font file (null where the bytes are none the host decodes), whether
// bytes arrived (`ok` — a face whose file cannot be read still loads, measured with the fallback family), a Resource
// Timing entry (initiator `css`, as Chrome files a font a stylesheet pulled in) and, when a face asked, that face's
// settlement in the FontFaceSet's loading cycle — each time it asks, so a second face on the same URL settles too.
const WEB_FONT_FILES = new globalThis.Map();   // url → { path, ok }
function webFontFile(url, doc, face) {
  let entry = WEB_FONT_FILES.get(url);
  if (!entry) {
    let path = null, meta = null, ok = false;
    const started = globalThis.performance ? globalThis.performance.now() : 0;
    try {
      let r = null;
      if (/^blob:/i.test(url)) {
        const blob = typeof globalThis.__csimResolveBlobBytes === 'function' ? globalThis.__csimResolveBlobBytes(url) : null;
        r = blob && blob.bytes != null ? fontFileFromBytes(latin1ToBytes(blob.bytes)) : null;
      } else if (globalThis.__csim_webFontFetch) {
        r = globalThis.__csim_webFontFetch(url);
      }
      if (r) { path = r.path || null; meta = r.meta || null; ok = !!r.ok; }
    } catch (_) { path = null; }
    entry = { path, ok };
    WEB_FONT_FILES.set(url, entry);
    if (typeof globalThis.__csimRecordResource === 'function') {
      globalThis.__csimRecordResource({ name: url, initiatorType: 'css', startTime: started, resp: meta, noCors: false });
    }
  }
  // The set to settle the face in: the document's, or — in a worker (no document) — the
  // worker's own `self.fonts`, so `FontFace.load()` / `self.fonts.load()` resolves there too.
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.fonts);
  if (face && set && typeof set._faceFetched === 'function') set._faceFetched(face, entry.ok);
  return entry.path;
}
// A family stack whose `@font-face`s split a run's characters by `unicode-range` (`faceStackFor`), registered natively
// as one face (`registerFontStack`): each candidate its own registered face — a downloaded one under its `size-adjust`,
// the last resort the family's SYSTEM font — in pick order with its `@font-face` metric overrides (its vertical metrics
// raise the line a run's characters select it on, font.rs `run_vmax`) and its ranges. The stack's own face is the one
// the family resolves to (`familyFace`) — what a character no candidate covers is measured by, and what a `ch` is
// (style_fonts.rs) — or the system font, the candidate of no face, where it has none. -1 where any candidate has no file
// native can read, or none is the stack's own.
function nativeStackHandle(d, family, ws, stack) {
  const own = familyFace(family, ws);
  const flat = [];
  let primary = -1;
  for (const cand of stack) {
    let h = d.registerFontPath(cand.face ? faceFile(cand.face, globalThis.document) || '' : systemFontFile(family, ws) || '');
    if (h >= 0 && cand.sizeMul !== 1) h = d.registerFontScaled(h, cand.sizeMul);
    if (h < 0) return -1;
    if (cand.face === own && primary < 0) primary = h;
    flat.push(h, ...faceOverrides(cand.face), cand.ranges ? cand.ranges.length : -1);
    if (cand.ranges) for (const [lo, hi] of cand.ranges) flat.push(lo, hi);
  }
  return d.registerFontStack(primary, Float64Array.from(flat));
}
// What a face's chosen `src` already went through: 'loaded' / 'error' after its fetch, else
// 'unloaded'.
export function webFontStatus(src, base) {
  const chosen = fontFaceUrl(src);
  if (!chosen) return 'unloaded';
  const entry = WEB_FONT_FILES.get(absoluteFontUrl(chosen, base));
  return entry ? (entry.ok ? 'loaded' : 'error') : 'unloaded';
}
globalThis.__csimWebFontStatus = webFontStatus;
globalThis.__csimFontFaceIndex = fontFaceIndex;
// A face's own bytes (a `FontFace` built from a buffer, as a Uint8Array) decoded to a font file by the host: `ok` says
// whether they are a font at all, `path` is null where they decode to nothing.
export function fontFileFromBytes(bytes) {
  try { const r = globalThis.__csim_fontFileFromBytes ? globalThis.__csim_fontFileFromBytes(bytes) : null; return r ? { ok: !!r.ok, path: r.path || null } : { ok: false, path: null }; }
  catch (_) { return { ok: false, path: null }; }
}
// The FontFaceSet's `load()` / `FontFace.load()` reach the fetch through these
// (platform-globals.js cannot import layout-side modules).
globalThis.__csimWebFontLoad = function (doc, family) {
  const idx = fontFaceIndex(doc);
  const faces = idx.families.get(String(family).toLowerCase()) || [];
  for (const f of faces) if (f.url) webFontFile(f.url, doc, f.rule ? { rule: f.rule } : f.face);
  return faces.length;
};
globalThis.__csimWebFontLoadUrl = function (src, doc, face) {
  const chosen = fontFaceUrl(src);
  if (!chosen) return { url: '', ok: false };
  const url = absoluteFontUrl(chosen, doc && doc.baseURI);
  const path = webFontFile(url, doc, face);
  const entry = WEB_FONT_FILES.get(url);
  return { url, path, ok: !!(entry && entry.ok) };
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
// The native (fontations) handle for a family at a weight/style, memoised per pair; -1 when there's no native DOM, or
// no file to read: the family's declared `@font-face` (`familyFace`) under its `size-adjust`, else its fontconfig SYSTEM
// face, or — where its faces split by `unicode-range` — the stack of them (`nativeStackHandle`). The memo caches the
// system-vs-web BRANCH decision too, so it is cleared when the @font-face generation advances — otherwise a runtime
// `@font-face` add/remove would leave a stale handle.
function nativeFontHandle(family, ws) {
  const d = globalThis.__dom;
  if (!d || typeof d.registerFontPath !== 'function') return -1;
  const gen = natFontGen();
  if (gen !== NAT_FONT_GEN) { NAT_FONT.clear(); NAT_FONT_GEN = gen; }
  const key = family + '|' + ws;
  let h = NAT_FONT.get(key);
  if (h === undefined) {
    const stack = faceStackFor(family, ws);
    if (stack) {
      h = nativeStackHandle(d, family, ws, stack);
    } else {
      const face = familyFace(family, ws);
      const path = face ? faceFile(face, globalThis.document) : systemFontFile(family, ws);
      h = path ? d.registerFontPath(path) : -1;
      const sizeAdjust = face && face.metrics ? face.metrics.sizeAdjust : 1;
      if (h >= 0 && sizeAdjust !== 1) h = d.registerFontScaled(h, sizeAdjust);
    }
    NAT_FONT.set(key, h);
  }
  return h;
}
// The faces native asked for — the Rust walk's, or the style engine's font metrics' — `[family, bucket, …]`, resolved
// and told it (`walkFace`), with the `@font-face` overrides of the metrics native reads off the face's file. A face that
// yields no measure — no file native can read, or one with no vertical metrics, as a colour emoji font has (`font-family:
// emoji`) — is told as the face its text FALLS BACK to: the next family of the stack that does measure, else the default
// sans-serif, which a browser draws the letters with (Chrome: `emoji, monospace` sets `abc def` in monospace). The walk
// lays it out with that rather than declining the page. (Chrome keeps the emoji face's own space and line box — 62.6
// and 19 for `abc def` alone, where this gives sans-serif's 52.5 and 17 — which wants a per-character fallback this model
// does not have.)
export function teachFaces(d, wanted) {
  for (let k = 0; k < wanted.length; k += 2) {
    const family = wanted[k], bucket = wanted[k + 1];
    let handle = nativeFontHandle(family, bucket), overrides = familyOverrides(family, bucket);
    if (!d.fontMeasures(handle, ...overrides)) {
      for (const next of [...splitFontStack(family).slice(1), 'sans-serif']) {
        handle = nativeFontHandle(next, bucket);
        overrides = familyOverrides(next, bucket);
        if (d.fontMeasures(handle, ...overrides)) break;
      }
    }
    d.walkFace(family, bucket, handle, ...overrides);
  }
}
// The `@font-face` overrides of the vertical metrics (`ascent-override`, `descent-override`, `line-gap-override`, as em
// fractions of the unadjusted face) a family resolves to — NaN for each it does not override, all three for a system
// font.
function familyOverrides(family, ws) {
  return faceOverrides(familyFace(family, ws));
}
function faceOverrides(face) {
  const m = face && face.metrics;
  return m ? [m.asc ?? NaN, m.desc ?? NaN, m.gap ?? NaN] : [NaN, NaN, NaN];
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
