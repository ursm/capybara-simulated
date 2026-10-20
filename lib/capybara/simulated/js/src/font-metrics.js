// The faces a family resolves to — a system font, or a document's `@font-face` — and the font FILES they are in, which
// native text metrics read (font.rs: advances, line metrics, x-height) and are told of as they ask (`teachFaces`).
// Which face a family takes, and which of its sources it is read from, are native's to say (font_faces.rs: the faces'
// descriptors and CSS Fonts' matching; font_files.rs: the sources in order); this side lists the faces, fetches what a
// source names when native asks, and settles each face in its FontFaceSet's loading cycle.
import { latin1ToBytes } from './bytes.js';
// (…a cycle with font-face.js, which imports this module: function declarations, called only once both have run)
import { faceStateOf, fontSetAddedFaces, fontSetFaceFetched, fontSetGeneration } from './font-face.js';

// Whether `doc` has any face at all: a declared `@font-face` (cascade.js, O(1)), or one script added to its set.
function hasFaces(doc) {
  return !!doc && ((typeof globalThis.__csimDocHasFontFace !== 'function' || globalThis.__csimDocHasFontFace()) ||
                   (doc._fontFaceSet && fontSetAddedFaces(doc._fontFaceSet).size > 0));
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
// …a face of the document's list the engine has the file of now, settled in its FontFaceSet's loading cycle by whether
// it has one (a font that arrives broken fails it, as Chrome's does) — the document's set, or a worker's `self.fonts`.
function settleFace(index, ok) {
  const face = SENT.faces[index], doc = SENT.doc;
  const set = (doc && doc._fontFaceSet) || (globalThis.document ? null : globalThis.__csimWorkerFonts());
  if (face && set) fontSetFaceFetched(set, face.rule ? { rule: face.rule } : face.face, ok);
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
  const idx = { cv, fg, faces, states, rules, doc, faceSig: null };
  for (const entry of rules) faces.push({ index: faces.length, rule: entry.key, face: null });
  // (…and the faces script added, by their states: the engine lists what it reads of each — none of one with nothing to
  // read, which holds its place — font_face_state.rs `listed`)
  const set = doc._fontFaceSet;
  if (set) fontSetAddedFaces(set).forEach((f) => {
    faces.push({ index: faces.length, rule: null, face: f });
    states.push(faceStateOf(f));
  });
  // (…what the CSS-connected faces are — each rule's identity and declarations — which the FontFaceSet's rendering-update
  // load compares: a rule set moving without moving them loads nothing again)
  idx.faceSig = rules.map((entry) => `${entry.key}\u0000${entry.identity}\u0000${entry.attributes.join('\u0000')}`).join('\u0001');
  sendFaces(idx);
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
// …the faces handed over (`__dom.fontFacesSet`: the rules' the engine holds already, the script-added ones' states).
function sendFaces(idx) {
  SENT = idx;
  globalThis.__dom.fontFacesSet(idx.rules.length, idx.states);
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
  const idx = fontFaceIndex(doc), face = idx.faces.find((f) => f.rule === key);
  if (face) nativeFaces(idx).fontFaceFile(face.index, fetchSource, settleFace, systemFontFile);
};
// …and a script's face, by its state: the file its sources, tried in order, give (`__dom.ffFile`).
globalThis.__csimFaceFile = (state) => globalThis.__dom.ffFile(state, fetchSource);


// ── native faces ────────────────────────────────────────────────────────────
// The @font-face generation that decides which face a family resolves to — the cascade version (an `insertRule`
// / `<style>` append that adds or drops an `@font-face` bumps it) plus the FontFaceSet's added generation
// (`document.fonts.add`): what `fontFaceIndex` keys on, MINUS the per-pass settle generation.
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
// The face a family stack takes at a weight / style — the engine's (font_resolve.rs `family_face`: the document's
// `@font-face` it picks under its `size-adjust`, else its fontconfig SYSTEM face, or the `unicode-range` split of them),
// kept there until the document's face list moves: `[handle, ascentOverride, descentOverride, lineGapOverride]`, -1 for
// no file to read, NaN for an override none gives. The realm's document's faces handed over first (none where it
// declares and adds none).
// (…looked at again only once the generation moves, or another document's faces were handed over since)
const NO_FACES = { faces: [], rules: [], states: [], doc: null };
let READY_GEN = null, READY = null;
function handFaces() {
  const gen = natFontGen();
  if (gen === READY_GEN && SENT === READY) return;
  const doc = globalThis.document;
  nativeFaces(READY = hasFaces(doc) ? fontFaceIndex(doc) : NO_FACES);
  READY_GEN = gen;
}
function familyFace(family, ws) {
  handFaces();
  return globalThis.__dom.fontFamilyFace(family, ws, fetchSource, settleFace, systemFontFile) ?? [-1, NaN, NaN, NaN];
}
// …its handle: what the layout measures a run with and a canvas shapes its text with.
export function fontHandleFor(family, ws) {
  const d = globalThis.__dom;
  if (!d || typeof d.fontFamilyHandle !== 'function') return -1;
  handFaces();
  return d.fontFamilyHandle(family, ws, fetchSource, settleFace, systemFontFile) ?? -1;
}
// The faces native asked for — the Rust walk's, or the style engine's font metrics' — learnt by the engine
// (`__dom.walkFaces`, which falls a face that yields no measure back to the next family of its stack), each family's
// face the engine's (`familyFace`).
export function teachFaces(d, wanted) {
  d.walkFaces(wanted, familyFace);
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
