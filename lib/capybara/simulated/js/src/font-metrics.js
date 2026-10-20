// The faces a family resolves to — a system font, or a document's `@font-face` — and the font FILES they are in, which
// native text metrics read (font.rs: advances, line metrics, x-height) and are told of as they ask (`teachFaces`).
// Which face a family takes, and which of its sources it is read from, are native's to say (font_faces.rs: the faces'
// descriptors and CSS Fonts' matching; font_files.rs: the sources in order); this side lists the faces, fetches what a
// source names when native asks, and settles each face in its FontFaceSet's loading cycle.
import { latin1ToBytes } from './bytes.js';
// (…a cycle with font-face.js, which imports this module: function declarations, called only once both have run)
import { faceStateOf, fontSetAddedFaces, fontSetFaceFetched, fontSetGeneration } from './font-face.js';

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
                   (doc._fontFaceSet && fontSetAddedFaces(doc._fontFaceSet).size > 0));
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
// What the engine parsed of a face's descriptors (`__dom.fontFaceInfo`), asked once per face: its `size-adjust`, its
// metric overrides (NaN for none), and its `unicode-range` (`[lo, hi]` pairs, or null for every code point).
function faceInfo(face) {
  if (face.info === undefined) {
    const r = nativeFaces(face.idx).fontFaceInfo(face.index);
    const pairs = (flat) => { const out = []; for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]); return out; };
    face.info = r === null ? { sizeAdjust: 1, overrides: [NaN, NaN, NaN], ranges: null }
      : { sizeAdjust: r[0], overrides: [r[1], r[2], r[3]], ranges: r[4] === null ? null : pairs(r[4]) };
  }
  return face.info;
}
// One face → the font file it is read from, or null where it has none native reads (`__dom.fontFaceFile`: a buffer
// face's, else the first of its sources that gives one — an installed `local()` font, or a download), the face settled in
// its FontFaceSet's loading cycle by whether one did (a font that arrives broken fails it, as Chrome's does). Asked once
// per face per index. Shared by `familyFace` (the primary face) and `faceStackFor` (every candidate in a unicode-range
// split).
function faceFile(face, doc) {
  if (!face) return null;
  if (face.file !== undefined) return face.file;
  face.file = nativeFaces(face.idx).fontFaceFile(face.index, fetchSource);
  settleFace(face, doc, face.file !== null);
  return face.file;
}
// A face native can read (`registerFontPath`, which keeps what it parsed), or null — a container the decoder could not
// undo, a file that is no font.
function readable(path) {
  return path && globalThis.__dom.registerFontPath(path) >= 0 ? path : null;
}
// What the engine asks the host for a source it has not had yet (font_files.rs `source_file`, once per source per
// realm): the file of a download, or of the font installed under a `local()` name at a weight / style — null for none.
const FONT_URL = 0, FONT_LOCAL = 1;
function fetchSource(kind, value, ws) {
  return kind === FONT_LOCAL ? localFontFile(value, ws) : webFontFile(value);
}
// …the installed font: null where this machine has none.
function localFontFile(name, ws) {
  if (typeof globalThis.__csim_localFontFile !== 'function') return null;
  try { return globalThis.__csim_localFontFile(name, ws); } catch (_) { return null; }
}
// Settle a face in its FontFaceSet's loading cycle — the document's, or a worker's `self.fonts`.
function settleFace(face, doc, ok) {
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.__csimWorkerFonts());
  if (set) fontSetFaceFetched(set, face.rule ? { rule: face.rule } : face.face, ok);
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
// The document's faces, listed for the engine (`__dom.fontFacesSet`) in order — each `{ index, rule | face }`, a
// face's place in that list and the identity its FontFaceSet settles it by — from the
// `@font-face` rules that apply (cascade.js `fontFaceRulesOf`: the sheets the cascade takes, `@import` / `@media` /
// `@supports` walked, each src resolved against ITS sheet) and the faces script added to `document.fonts`. Memoised on
// what decides that set: the cascade version (every sheet the cascade takes is in its content key — a `<style>` /
// `<link>` inserted, removed or re-selected, the viewport a `@media` reads, an `insertRule` — and the version moves
// exactly when that key does) and the set's own generation. It was keyed on the SETTLE generation too, which moves on
// every DOM mutation: each one walked every sheet again for its `@font-face` rules, fingerprinting every `<style>`'s
// text on the way (the cascade's key, then) — the largest single cost of a relayout on a page that declares a web font.
function fontFaceIndex(doc) {
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const fg = doc._fontFaceSet ? fontSetGeneration(doc._fontFaceSet) : 0;
  const kept = doc.__csimFontFaceIndex;
  if (kept && kept.cv === cv && kept.fg === fg) return kept;
  const faces = [], states = [];
  const rules = typeof globalThis.__csimFontFaceRules === 'function' ? globalThis.__csimFontFaceRules(doc) : [];
  const idx = { cv, fg, faces, states, stackMemo: new Map(), rules, restricted: false, faceSig: null };
  for (const entry of rules) faces.push({ idx, index: faces.length, rule: entry.key, face: null });
  // (…and the faces script added, by their states: the engine lists what it reads of each — none of one with nothing to
  // read, which holds its place — font_face_state.rs `listed`)
  const set = doc._fontFaceSet;
  if (set) fontSetAddedFaces(set).forEach((f) => {
    faces.push({ idx, index: faces.length, rule: null, face: f });
    states.push(faceStateOf(f));
  });
  // (…what the CSS-connected faces are — each rule's identity and declarations — which the FontFaceSet's rendering-update
  // load compares: a rule set moving without moving them loads nothing again)
  idx.faceSig = rules.map((entry) => `${entry.key}\u0000${entry.identity}\u0000${entry.attributes.join('\u0000')}`).join('\u0001');
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
// …the faces handed over (`__dom.fontFacesSet`: the rules' the engine holds already, the script-added ones' states):
// whether any of them restricts its `unicode-range`.
function sendFaces(idx) {
  SENT = idx;
  return globalThis.__dom.fontFacesSet(idx.rules.length, idx.states);
}
// A FontFace's sources a browser would try (`__dom.ffSources`, by its state), in order, each `[kind, value]` — a `url()`
// resolved, a `local()` the name.
export function faceSources(state) {
  const flat = globalThis.__dom.ffSources(state);
  const out = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
}
// …the download: its decoded font file, null where the bytes are none the host decodes (a 404, a broken file), and a
// Resource Timing entry (initiator `css`, as Chrome files a font a stylesheet pulled in).
function webFontFile(url) {
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
globalThis.__csimFontFaceIndex = fontFaceIndex;
// A face's own bytes (a `FontFace` built from a buffer, as a Uint8Array) decoded to a font file by the host: `ok` says
// whether they are a font at all, `path` is null where they decode to nothing.
export function fontFileFromBytes(bytes) {
  try { const r = globalThis.__csim_fontFileFromBytes ? globalThis.__csim_fontFileFromBytes(bytes) : null; return r ? { ok: !!r.ok, path: r.path || null } : { ok: false, path: null }; }
  catch (_) { return { ok: false, path: null }; }
}
// The FontFaceSet's `load()` / `FontFace.load()` reach the fetch through these (font-face.js, which this module
// imports, cannot import it back at load): a CSS-connected face, by its rule's key in the document's index, settled by
// whether its file loaded.
globalThis.__csimWebFontLoadRule = function (doc, key) {
  faceFile(fontFaceIndex(doc).faces.find((face) => face.rule === key), doc);
};
// …and a script's face, by its state: the file its sources, tried in order, give (`__dom.ffFile`).
globalThis.__csimFaceFile = (state) => globalThis.__dom.ffFile(state, fetchSource);


// ── native faces ────────────────────────────────────────────────────────────
const NAT_FONT = new Map();
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
  const ag = (doc && doc._fontFaceSet) ? fontSetGeneration(doc._fontFaceSet) : 0;
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
// The faces native asked for — the Rust walk's, or the style engine's font metrics' — learnt by the engine
// (`__dom.walkFaces`, which falls a face that yields no measure back to the next family of its stack), each family's
// face resolved here: its handle (`fontHandleFor`) and the `@font-face` overrides of the metrics native reads off its
// file.
export function teachFaces(d, wanted) {
  d.walkFaces(wanted, resolveFace);
}
function resolveFace(family, bucket) {
  return [fontHandleFor(family, bucket), ...familyOverrides(family, bucket)];
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
