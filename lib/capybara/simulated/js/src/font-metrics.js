// The faces a family resolves to — a system font, or a document's `@font-face` — and the font FILES they are in, which
// native text metrics read (font.rs: advances, line metrics, x-height) and are told of as they ask (`teachFaces`).
// Which face a family takes, and which of its sources it is read from, are native's to say (font_faces.rs: the faces'
// descriptors and CSS Fonts' matching; font_files.rs: the sources in order, subresource_obtain.rs: a download's fetch);
// this side lists the faces, hands native the host steps a source's file is fetched or looked up by
// (subresource-host.js), and takes each face through its FontFaceSet's loading cycle as native says what it came to.
// (…a cycle with font-face.js, which imports this module: function declarations, called only once both have run)
import { fontFaceLanded, fontSetAddedFaces, fontSetFace, fontSetState } from './font-face.js';
import { obtainHost } from './obtain-host.js';
import { rareDataOf } from './native-query-shadow.js';
import { dom, hostObject, listFindIndex, pageList, realmHooks } from './engine.js';

// The realm's document — none of a worker's, whatever a script of it names `document` (a library's shim of one).
const realmDocument = () => (realmHooks.isWorker ? null : globalThis.document);
// The realm's faces, the engine's to list (font_faces.rs `fontFacesHand`): its document's `@font-face` rules that apply
// (cascade.js `fontFaceRulesOf`, made current here — the style engine's, memoised on the cascade version), then the faces
// script added to its FontFaceSet — handed again only where they moved. `rules` the rules, in that list's order.
function faceRules() {
  const doc = realmDocument();
  return doc && typeof realmHooks.fontFaceRules === 'function' ? realmHooks.fontFaceRules(doc) : pageList();
}
// …and the realm's FontFaceSet, the faces script added are its: its document's (`document.fonts`), a worker's own
// (`self.fonts`, its font source — CSS Font Loading §4.1, "Worker FontFaceSources": an OffscreenCanvas's there measuring
// with its faces).
function realmFontSet() {
  const doc = realmDocument();
  if (doc) return rareDataOf(doc)?.fontFaceSet ?? null;
  return realmHooks.isWorker && typeof realmHooks.workerFonts === 'function' ? realmHooks.workerFonts() : null;
}
// (…looked at again only once the face generation moves — the cascade version, the set's — or the realm's document is
// another: every text a canvas measures asks)
let HANDED_GEN = null, HANDED_DOC = null;
function handFaces() {
  const doc = realmDocument(), gen = natFontGen();
  if (gen === HANDED_GEN && doc === HANDED_DOC) return;
  const set = realmFontSet();
  dom.fontFacesHand(faceRules().length > 0, set ? fontSetState(set) : null);
  HANDED_GEN = gen;
  HANDED_DOC = doc;
}
// …a face of the realm's list as the engine says what it came to (font_resolve.rs `FACE_*`) — a rule's, by its place, or
// one script added after them — taken through its FontFaceSet's loading cycle: its download begun, or its file in or
// not (a font that arrives broken fails it, as Chrome's does).
function settleFace(index, what) {
  const set = realmFontSet();
  if (!set) return;
  const rules = faceRules();
  const face = index < rules.length ? { rule: rules[index].key } : fontSetAddedFaces(set)[index - rules.length];
  if (face) fontSetFace(set, face, what);
}
// The file fontconfig resolves a family's system face to, or null.
function systemFontFile(family, weightStyle) {
  try { return hostObject.fontFile ? hostObject.fontFile(family, weightStyle) : null; } catch (_) { return null; }
}

// ── downloaded faces (`@font-face`) ──
// A face's own bytes (a `FontFace` built from a buffer, as a Uint8Array) decoded to a font file by the host: `ok` says
// whether they are a font at all, `path` is null where they decode to nothing.
export function fontFileFromBytes(bytes) {
  try { const r = hostObject.fontFileFromBytes ? hostObject.fontFileFromBytes(bytes) : null; return r ? { ok: !!r.ok, path: r.path || null } : { ok: false, path: null }; }
  catch (_) { return { ok: false, path: null }; }
}
// The FontFaceSet's `load()` / `FontFace.load()` reach the fetch through these (font-face.js, which this module
// imports, cannot import it back at load): a CSS-connected face, by its rule's key — its place among the document's
// faces — settled by whether its file loaded.
realmHooks.webFontLoadRule = function (doc, key) {
  if (doc !== realmDocument()) return;
  const index = listFindIndex(faceRules(), (entry) => entry.key === key);
  if (index < 0) return;
  handFaces();
  dom.fontFaceFile(index, obtainHost(), settleFace, systemFontFile);
};
// …and what a CSS-connected face, by its rule's key, came to as text or a script asked for it — its FontFace's status
// (font_resolve.rs `fontFaceStatus`): `unloaded` where nothing asked.
realmHooks.webFontStatus = function (doc, key) {
  if (doc !== realmDocument()) return 0;
  const index = listFindIndex(faceRules(), (entry) => entry.key === key);
  if (index < 0) return 0;
  handFaces();
  return dom.fontFaceStatus(index);
};
// …and a script's face, by its state: the file its sources, tried in order, give (`__dom.ffFile`) — undefined while its
// download is under way, the FontFace `face` handed back as it lands (`landFont`).
realmHooks.faceFile = (state, face) => dom.ffFile(state, obtainHost(), face);
// A download of a face's source landed, as its task runs (bridge.entry.js `queueFontLand`): the engine's (font_resolve.rs
// `fontFetchLand`), the faces of the realm's list it settles taken through their sets' cycles there, and each FontFace
// whose own `load()` waited for it settled here.
realmHooks.landFont = function (id) {
  const settled = dom.fontFetchLand(id, obtainHost(), settleFace, systemFontFile);
  if (settled) for (let k = 0; k + 1 < settled.length; k += 2) fontFaceLanded(settled[k], settled[k + 1]);
};


// ── native faces ────────────────────────────────────────────────────────────
// The @font-face generation that decides which face a family resolves to — the cascade version (an `insertRule`
// / `<style>` append that adds or drops an `@font-face` bumps it) plus the engine's generation of the rest
// (`fontGeneration`: what script made the FontFaceSet hold — `document.fonts.add` — and what the downloads gave, which
// moves as one lands), MINUS the per-pass settle generation: what the style engine's face memo keys on.
// (…the same string while neither half moves: it is asked on every style-engine read)
let GEN_CV = -1, GEN_AG = -1, GEN = '';
export function natFontGen() {
  const cv = typeof realmHooks.cascadeVersion === 'function' ? realmHooks.cascadeVersion() : 0;
  const set = realmFontSet();
  const ag = dom.fontGeneration(set ? fontSetState(set) : null);
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
// declares and adds none). (…`inPass` a layout pass's ask, which may take a stack's own face tentatively — settled as
// the pass ends — where the style engine's may not)
function familyFace(family, ws, inPass) {
  handFaces();
  return dom.fontFamilyFace(family, ws, obtainHost(), settleFace, systemFontFile, inPass) ?? [-1, NaN, NaN, NaN];
}
// …and the faces of a `unicode-range` split a character measured has asked for since, their loads begun (font_resolve.rs
// `fontFacesWanted`): after a layout pass, and at each rendering update (a canvas's text) — whether one's file was there
// at once, which the text it covers is measured with from now.
export function askWantedFaces() {
  return dom ? dom.fontFacesWanted(obtainHost(), settleFace, systemFontFile) === true : false;
}
// …its handle: what the layout measures a run with and a canvas shapes its text with.
export function fontHandleFor(family, ws) {
  if (!dom) return -1;
  handFaces();
  return dom.fontFamilyHandle(family, ws, obtainHost(), settleFace, systemFontFile) ?? -1;
}
// The faces native asked for — the Rust walk's, or the style engine's font metrics' — learnt by the engine
// (`__dom.walkFaces`, which falls a face that yields no measure back to the next family of its stack), each family's
// face the engine's (`familyFace`) — `inPass` a layout pass's.
const passFace = (family, ws) => familyFace(family, ws, true);
const styleFace = (family, ws) => familyFace(family, ws, false);
export function teachFaces(d, wanted, inPass) {
  d.walkFaces(wanted, inPass ? passFace : styleFace);
}
// …and the style engine's own, after a style flush (cascade.js `flushStyleEngine`): whether it told any.
// (The generation crosses only when it has moved since it last did — the engine keeps the one it was told.)
let TOLD_GEN = null;
export function teachStyleFaces() {
  const gen = natFontGen();
  const wanted = dom.styleFaces(gen === TOLD_GEN ? undefined : (TOLD_GEN = gen));
  if (wanted == null) return false;
  teachFaces(dom, wanted, false);
  return true;
}
