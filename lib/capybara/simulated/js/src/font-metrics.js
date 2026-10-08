// The faces a family resolves to — a system font, or a document's `@font-face` — and the font FILES they are in, which
// native text metrics read (font.rs: advances, line metrics, x-height) and are told of as they ask (`teachFaces`).
// Which face a family takes is native's to say (font_faces.rs: the faces' descriptors and CSS Fonts' matching); this
// side lists the faces, loads the file of the one taken, and settles each in its FontFaceSet's loading cycle.
import { latin1ToBytes } from './bytes.js';

// The `@font-face` a family stack is measured with — the first family of the stack that has one, its face picked by
// weight and style, its file loaded (fetched on first use, as Chrome loads a web font when text needs it) and readable
// — or null where the system face fontconfig substitutes answers for it.
function familyFace(family, weightStyle) {
  const doc = globalThis.document;
  const face = declaredFaceFor(doc, family, weightStyle);
  return face && faceFile(face, doc) ? face : null;
}
// Whether `doc` has any face at all: a declared `@font-face` (cascade.js, O(1)), or one script added to its set.
function hasFaces(doc) {
  return !!doc && ((typeof globalThis.__csimDocHasFontFace !== 'function' || globalThis.__csimDocHasFontFace()) ||
                   (doc._fontFaceSet && doc._fontFaceSet._faces.size > 0));
}
// The `@font-face` a family stack takes as its own (`__dom.fontFacePick`), or null where the document declares none for
// it. Memoised per (stack, weight / style).
function declaredFaceFor(doc, family, weightStyle) {
  const idx = hasFaces(doc) ? fontFaceIndex(doc) : null;
  if (!idx || !idx.faces.length) return null;
  const memoKey = family + '|' + weightStyle;
  if (idx.stackMemo.has(memoKey)) return idx.stackMemo.get(memoKey);
  const picked = nativeFaces(idx).fontFacePick(family, weightStyle, false);
  const face = picked.length ? idx.faces[picked[0]] : null;
  idx.stackMemo.set(memoKey, face);
  return face;
}
// What the engine parsed of a face's descriptors (`__dom.fontFaceInfo`), asked once per face: its sources in `src`
// order (`[kind, value]`, `url` / `local`), its `size-adjust`, its metric overrides (NaN for none), its `unicode-range`
// (`[lo, hi]` pairs, or null for every code point), the low end of its weight range and whether it is slanted.
function faceInfo(face) {
  if (face.info === undefined) {
    const r = nativeFaces(face.idx).fontFaceInfo(face.index);
    const pairs = (flat) => { const out = []; for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]); return out; };
    face.info = r === null ? { sources: [], sizeAdjust: 1, overrides: [NaN, NaN, NaN], ranges: null, weight: 400, slanted: false }
      : { sources: pairs(r[0]), sizeAdjust: r[1], overrides: [r[2], r[3], r[4]], ranges: r[5] === null ? null : pairs(r[5]),
          weight: r[6], slanted: r[7] };
  }
  return face.info;
}
// One face → the font file it is read from, or null where it has none native reads: a buffer face's, else the first of
// its sources that loads — an installed `local()` font, or a download (a browser tries each in turn: a `src` listing
// woff2, then woff, then ttf takes the first that comes) — the face settled in its FontFaceSet's loading cycle by
// whether one did (a font that arrives broken fails it, as Chrome's does). Asked once per face per index. Shared by
// `familyFace` (the primary face) and `faceStackFor` (every candidate in a unicode-range split).
const LOCAL_FILES = new globalThis.Map();                      // `local()` name|weight/style → installed file, per realm
function faceFile(face, doc) {
  if (!face) return null;
  if (face.file !== undefined) return face.file;
  if (face.path !== undefined) return (face.file = readable(face.path));   // a buffer face: the file its bytes made
  const info = faceInfo(face);
  face.file = null;
  for (const [kind, value] of info.sources) {
    const path = readable(kind === 'local' ? localFontFile(value, localWeightStyle(info.weight, info.slanted)) : webFontFile(value));
    if (path) { face.file = path; break; }
  }
  settleFace(face, doc, face.file !== null);
  return face.file;
}
// A face native can read (`registerFontPath`, which keeps what it parsed), or null — a container the decoder could not
// undo, a file that is no font.
function readable(path) {
  return path && globalThis.__dom.registerFontPath(path) >= 0 ? path : null;
}
// The file of the font installed under a `local()` name, or null where this machine has none. Memoised per (name,
// weight/style) so a relayout does not re-ask fontconfig.
function localFontFile(name, ws) {
  if (typeof globalThis.__csim_localFontFile !== 'function') return null;
  const key = name + '|' + ws;
  if (!LOCAL_FILES.has(key)) {
    let path = null;
    try { path = globalThis.__csim_localFontFile(name, ws); } catch (_) { path = null; }
    LOCAL_FILES.set(key, path);
  }
  return LOCAL_FILES.get(key);
}
// The weight/style a face's `local()` names are looked up under — its OWN descriptors, in the colon form `fc_match`
// expects.
function localWeightStyle(weight, slanted) {
  const bold = weight >= 600;
  return (bold ? 'bold' : '') + (slanted ? (bold ? ':italic' : 'italic') : '');
}
// Settle a face in its FontFaceSet's loading cycle — the document's, or a worker's `self.fonts`.
function settleFace(face, doc, ok) {
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.fonts);
  if (set && typeof set._faceFetched === 'function') set._faceFetched(face.rule ? { rule: face.rule } : face.face, ok);
}
// The ordered candidate faces a run's characters pick from when the family stack has a `unicode-range`-restricted face
// — each character takes the FIRST candidate whose range covers it, so a `size-adjust` face scoped to A–Z reshapes only
// those glyphs and the rest fall through to the next face. Returns null (the hot path) unless some `@font-face` in the
// document restricts its range: `{ ranges, sizeMul, face }` in the engine's pick order (`__dom.fontFacePick`),
// `ranges === null` a universal face that covers everything, the family's system face (`face` null) the last.
// Memoised per face index.
export function faceStackFor(family, weightStyle) {
  const doc = globalThis.document;
  if (!hasFaces(doc)) return null;
  const idx = fontFaceIndex(doc);
  if (!idx.faces.length || !idx.restricted) return null;        // O(1): no face restricts a range
  const memoKey = 'stack|' + family + '|' + weightStyle;
  if (idx.stackMemo.has(memoKey)) return idx.stackMemo.get(memoKey);
  const cands = [];
  let anyRestricted = false;
  for (const k of nativeFaces(idx).fontFacePick(family, weightStyle, true)) {
    const face = idx.faces[k];
    if (!faceFile(face, doc)) continue;
    const info = faceInfo(face);
    if (info.ranges) anyRestricted = true;
    cands.push({ ranges: info.ranges, sizeMul: info.sizeAdjust, face });
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
// The document's faces, listed for the engine (`__dom.fontFacesSet`) in order — each `{ index, rule | face, path }`, a
// face's place in that list, the identity its FontFaceSet settles it by, and a buffer face's file — from the
// `@font-face` rules that apply (cascade.js `fontFaceRulesOf`: the sheets the cascade takes, `@import` / `@media` /
// `@supports` walked, each src resolved against ITS sheet) and the faces script added to `document.fonts`. Memoised on
// what decides that set: the cascade version (every sheet the cascade takes is in its content key — a `<style>` /
// `<link>` inserted, removed or re-selected, the viewport a `@media` reads, an `insertRule` — and the version moves
// exactly when that key does) and the set's own generation. It was keyed on the SETTLE generation too, which moves on
// every DOM mutation: each one walked every sheet again for its `@font-face` rules, fingerprinting every `<style>`'s
// text on the way (`cascadeCacheKey`) — the largest single cost of a relayout on a page that declares a web font.
function fontFaceIndex(doc) {
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const fg = doc._fontFaceSet ? doc._fontFaceSet._facesGen | 0 : 0;
  const kept = doc.__csimFontFaceIndex;
  if (kept && kept.cv === cv && kept.fg === fg) return kept;
  const faces = [], texts = [], bases = [];
  const docBase = doc.baseURI || 'about:blank';
  const rules = typeof globalThis.__csimFontFaceRules === 'function' ? globalThis.__csimFontFaceRules(doc) : [];
  const idx = { cv, fg, faces, texts, bases, stackMemo: new globalThis.Map(), rules, restricted: false };
  for (const entry of rules) {
    const text = ruleDeclText(entry.rule);
    if (text == null) continue;
    faces.push({ idx, index: faces.length, rule: entry.key, face: null });
    texts.push(text);
    bases.push(entry.base || docBase);
  }
  const set = doc._fontFaceSet;
  if (set && set._faces) set._faces.forEach((f) => {
    if (typeof f._source !== 'string' && !f._sfntPath) return;   // a buffer that decoded to no font
    faces.push(Object.assign({ idx, index: faces.length, rule: null, face: f }, typeof f._source === 'string' ? {} : { path: f._sfntPath }));
    texts.push(fontFaceDeclText(f));
    bases.push(docBase);
  });
  idx.restricted = sendFaces(idx);
  return (doc.__csimFontFaceIndex = idx);
}
// The engine's face list is the realm's one (font_faces.rs), and a realm can index more than one document — its own,
// and one script made (`createHTMLDocument().fonts`): the engine holding a document's faces is `nativeFaces(idx)`,
// which hands them over again where it last held another's.
let SENT = null;
function nativeFaces(idx) {
  if (SENT !== idx) sendFaces(idx);
  return globalThis.__dom;
}
// …the faces handed over (`__dom.fontFacesSet`): whether any of them restricts its `unicode-range`.
function sendFaces(idx) {
  SENT = idx;
  return globalThis.__dom.fontFacesSet(idx.texts, idx.bases);
}
// A rule's descriptor block: the engine's text for a face read off an unbuilt sheet, the CSSOM rule's own otherwise.
function ruleDeclText(rule) {
  if (rule._declText !== undefined) return rule._declText;
  return rule.style ? rule.style.cssText : null;
}
// …and a FontFace's, from its attributes (a buffer face's file is its own: no `src`).
function fontFaceDeclText(f) {
  const family = '"' + String(f.family).trim().replace(/^["']|["']$/g, '').replace(/["\\]/g, '\\$&') + '"';
  let text = `font-family: ${family}; font-weight: ${f.weight}; font-style: ${f.style}; unicode-range: ${f.unicodeRange}; ` +
             `size-adjust: ${f.sizeAdjust}; ascent-override: ${f.ascentOverride}; descent-override: ${f.descentOverride}; ` +
             `line-gap-override: ${f.lineGapOverride};`;
  if (typeof f._source === 'string') text += ` src: ${f._source};`;
  return text;
}
// A `src` descriptor's sources the engine reads (`__dom.fontFaceSources`), in order, each `[kind, value]` — a `url()`
// resolved against `base`, a `local()` the name.
export function faceSources(src, base) {
  const flat = globalThis.__dom.fontFaceSources(String(src), base || 'about:blank');
  const out = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
}
// One fetch per face URL per realm: its decoded font file, null where the bytes are none the host decodes (a 404, a
// broken file), and a Resource Timing entry (initiator `css`, as Chrome files a font a stylesheet pulled in).
const WEB_FONT_FILES = new globalThis.Map();   // url → path
function webFontFile(url) {
  if (WEB_FONT_FILES.has(url)) return WEB_FONT_FILES.get(url);
  let path = null, meta = null;
  const started = globalThis.__csimPerformanceNow();
  try {
    let r = null;
    if (/^blob:/i.test(url)) {
      const blob = typeof globalThis.__csimResolveBlobBytes === 'function' ? globalThis.__csimResolveBlobBytes(url) : null;
      r = blob && blob.bytes != null ? fontFileFromBytes(latin1ToBytes(blob.bytes)) : null;
    } else if (globalThis.__csim_webFontFetch) {
      r = globalThis.__csim_webFontFetch(url);
    }
    if (r) { path = r.path || null; meta = r.meta || null; }
  } catch (_) { path = null; }
  WEB_FONT_FILES.set(url, path);
  if (typeof globalThis.__csimRecordResource === 'function') {
    globalThis.__csimRecordResource({ name: url, initiatorType: 'css', startTime: started, resp: meta, noCors: false });
  }
  return path;
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
// What a face's `src` already went through: 'loaded' where one of its downloads came as a font native reads, 'error'
// where every one came and none did, else 'unloaded'.
export function webFontStatus(src, base) {
  const urls = faceSources(src, base).filter(([kind]) => kind === 'url').map(([, url]) => url);
  if (urls.some((url) => readable(WEB_FONT_FILES.get(url)))) return 'loaded';
  return urls.length && urls.every((url) => WEB_FONT_FILES.has(url)) ? 'error' : 'unloaded';
}
globalThis.__csimWebFontStatus = webFontStatus;
globalThis.__csimFontFaceIndex = fontFaceIndex;
// A face's own bytes (a `FontFace` built from a buffer, as a Uint8Array) decoded to a font file by the host: `ok` says
// whether they are a font at all, `path` is null where they decode to nothing.
export function fontFileFromBytes(bytes) {
  try { const r = globalThis.__csim_fontFileFromBytes ? globalThis.__csim_fontFileFromBytes(bytes) : null; return r ? { ok: !!r.ok, path: r.path || null } : { ok: false, path: null }; }
  catch (_) { return { ok: false, path: null }; }
}
// The FontFaceSet's `load()` / `FontFace.load()` reach the fetch through these (platform-globals.js cannot import
// layout-side modules): every face of a family in the document's index, and a script's face's own `src` — each source
// tried in turn, the face settled by whether one loaded.
globalThis.__csimWebFontLoad = function (doc, family) {
  const idx = fontFaceIndex(doc);
  const picked = nativeFaces(idx).fontFacePick(family, '', true);
  for (const k of picked) faceFile(idx.faces[k], doc);
  return picked.length;
};
globalThis.__csimWebFontLoadUrl = function (src, doc, face) {
  let path = null;
  for (const [kind, url] of faceSources(src, doc && doc.baseURI)) {
    if (kind === 'url' && (path = readable(webFontFile(url)))) break;
  }
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.fonts);
  if (face && set && typeof set._faceFetched === 'function') set._faceFetched(face, path !== null);
  return path;
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
// The native (fontations) handle for a family stack at a weight/style — what the layout measures a run with and a
// canvas shapes its text with — memoised per pair; -1 when there's no native DOM, or
// no file to read: the family's declared `@font-face` (`familyFace`) under its `size-adjust`, else its fontconfig SYSTEM
// face, or — where its faces split by `unicode-range` — the stack of them (`nativeStackHandle`). The memo caches the
// system-vs-web BRANCH decision too, so it is cleared when the @font-face generation advances — otherwise a runtime
// `@font-face` add/remove would leave a stale handle.
export function fontHandleFor(family, ws) {
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
      const sizeAdjust = face ? faceInfo(face).sizeAdjust : 1;
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
    let handle = fontHandleFor(family, bucket), overrides = familyOverrides(family, bucket);
    if (!d.fontMeasures(handle, ...overrides)) {
      for (const next of [...splitFontStack(family).slice(1), 'sans-serif']) {
        handle = fontHandleFor(next, bucket);
        overrides = familyOverrides(next, bucket);
        if (d.fontMeasures(handle, ...overrides)) break;
      }
    }
    d.walkFace(family, bucket, handle, ...overrides);
  }
}
// `family, family, generic` → the families, unquoted.
function splitFontStack(stack) {
  return String(stack || '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}
// The `@font-face` overrides of the vertical metrics (`ascent-override`, `descent-override`, `line-gap-override`, as em
// fractions of the unadjusted face) a family resolves to — NaN for each it does not override, all three for a system
// font.
function familyOverrides(family, ws) {
  return faceOverrides(familyFace(family, ws));
}
function faceOverrides(face) {
  return face ? faceInfo(face).overrides : [NaN, NaN, NaN];
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
