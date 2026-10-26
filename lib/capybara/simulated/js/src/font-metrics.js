// The faces a family resolves to — a system font, or a document's `@font-face` — and the font FILES they are in, which
// native text metrics read (font.rs: advances, line metrics, x-height) and are told of as they ask (`teachFaces`).
// Which face a family takes, and which of its sources it is read from, are native's to say (font_faces.rs: the faces'
// descriptors and CSS Fonts' matching; font_files.rs: the sources in order); this side lists the faces, fetches what a
// source names when native asks, and settles each face in its FontFaceSet's loading cycle.
import { J_FONT, ROUTE_BLOB, S_EMPTY, SRC_NETWORK, SRC_SW_SYNC, V_OK } from './constants.js';
// (…a cycle with font-face.js, which imports this module: function declarations, called only once both have run)
import { fontSetAddedFaces, fontSetFaceFetched, fontSetGeneration, fontSetState } from './font-face.js';
import { consumePreload, requestingRealm } from './handles.js';

// The realm's document's faces, the engine's to list (font_faces.rs `fontFacesHand`): the `@font-face` rules that apply
// (cascade.js `fontFaceRulesOf`, made current here — the style engine's, memoised on the cascade version), then the faces
// script added to its `document.fonts` — handed again only where they moved. `rules` the rules, in that list's order.
function faceRules() {
  const doc = globalThis.document;
  return doc && typeof globalThis.__csimFontFaceRules === 'function' ? globalThis.__csimFontFaceRules(doc) : [];
}
// (…looked at again only once the face generation moves — the cascade version, the set's — or the realm's document is
// another: every text a canvas measures asks)
let HANDED_GEN = null, HANDED_DOC = null;
function handFaces() {
  const doc = globalThis.document, gen = natFontGen();
  if (gen === HANDED_GEN && doc === HANDED_DOC) return;
  const set = doc && doc._fontFaceSet;
  globalThis.__dom.fontFacesHand(faceRules().length > 0, set ? fontSetState(set) : null);
  HANDED_GEN = gen;
  HANDED_DOC = doc;
}
// What the engine asks the host for a source it has not had yet (font_files.rs `source_file`, once per source per
// realm): the file of a download, requested with its face's referrer where it has one (a rule's: its sheet's
// location), or of the font installed under a `local()` name at a weight / style — null for none.
const FONT_URL = 0, FONT_LOCAL = 1;
function fetchSource(kind, value, ws, referrer) {
  return kind === FONT_LOCAL ? localFontFile(value, ws) : webFontFile(value, referrer);
}
// …the installed font: null where this machine has none.
function localFontFile(name, ws) {
  if (typeof globalThis.__csim_localFontFile !== 'function') return null;
  try { return globalThis.__csim_localFontFile(name, ws); } catch (_) { return null; }
}
// …a face of the document's list the engine has the file of now — a rule's, by its place, or one script added after them
// — settled in its document's FontFaceSet's loading cycle by whether it has one (a font that arrives broken fails it,
// as Chrome's does).
function settleFace(index, ok) {
  const doc = globalThis.document, set = doc && doc._fontFaceSet;
  if (!set) return;
  const rules = faceRules();
  const face = index < rules.length ? { rule: rules[index].key } : fontSetAddedFaces(set)[index - rules.length];
  if (face) fontSetFaceFetched(set, face, ok);
}
// The file fontconfig resolves a family's system face to, or null.
function systemFontFile(family, weightStyle) {
  try { return globalThis.__csim_fontFile ? globalThis.__csim_fontFile(family, weightStyle) : null; } catch (_) { return null; }
}

// ── downloaded faces (`@font-face`) ──
// A FontFace's sources a browser would try (`__dom.ffSources`, by its state), in order, each `[kind, value]` — a `url()`
// resolved, a `local()` the name.
export function faceSources(state) {
  const flat = globalThis.__dom.ffSources(state);
  const out = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
}
// …the download: its decoded font file — a controlled document's through its service worker first (destination 'font',
// cors, its credentials same-origin), the answer's bytes where it answered, none where it refused (a network error:
// the next source tried), the network's where it let the request through — null where the bytes are none the host
// decodes (a 404, a broken file); and a Resource Timing entry of what came back (initiator `css`, as Chrome files a
// font a stylesheet pulled in) — none for a preload of it its document had, which it takes first (Fetch "fetch":
// "consume a preloaded resource", preload_map.rs). Asked when text first needs the face, as a browser fetches one: the
// engine keeps the file per URL (font_files.rs), so a URL is fetched once. `referrer` the URL it is referred by, null
// for its client's.
function webFontFile(url, referrer = null) {
  let path = null, timing = { resp: null };
  const started = globalThis.__csimPerformanceNow();
  // (…under its sheet's referrer policy, where its response set one: Referrer Policy §7)
  const plan = globalThis.__dom.subresourcePlan(J_FONT, null, null, referrer);
  const doc = globalThis.document?._nid;
  try {
    const preloaded = doc == null ? undefined : consumePreload(doc, String(url), 'font', plan, '');
    const sw = preloaded === undefined ? swFontAnswer(url, plan, referrer) : undefined;
    if (preloaded !== undefined) {
      const size = preloaded?.body_bytes.length ?? 0;
      if (preloaded && (globalThis.__dom.subresourceJudge(J_FONT, null, preloaded, SRC_NETWORK | (size === 0 ? S_EMPTY : 0)) & V_OK)) {
        path = fontFileFromBytes(preloaded.body_bytes).path;
      }
      timing = null;
    } else if (sw) {
      const size = !sw.blocked && sw.bytes != null ? sw.bytes.length : 0;
      if (globalThis.__dom.subresourceJudge(J_FONT, null, sw, SRC_SW_SYNC | (size === 0 ? S_EMPTY : 0)) & V_OK) path = fontFileFromBytes(sw.bytes).path;
      timing = { answer: sw };
    } else {
      let r = null;
      if (globalThis.__dom.fetchRoute(String(url), 0, '') === ROUTE_BLOB) {
        const blob = typeof globalThis.__csimResolveBlobBytes === 'function' ? globalThis.__csimResolveBlobBytes(url) : null;
        r = blob && blob.bytes != null ? fontFileFromBytes(blob.bytes) : null;
      } else if (globalThis.__csim_webFontFetch) {
        r = globalThis.__csim_webFontFetch(url, requestingRealm(), referrer, globalThis.__dom.subresourcePlanFields(plan)[2]);
      }
      if (r) { path = r.path || null; timing = { resp: r.meta || null }; }
    }
  } catch (_) { path = null; }
  if (timing && typeof globalThis.__csimRecordResource === 'function') {
    globalThis.__csimRecordResource({ name: url, kind: J_FONT, startTime: started, ...timing });
  }
  return path;
}
// …a controlling service worker's answer to it, its request `plan`, referred by `referrer`: undefined where no worker
// answers it — none controls the document, or the URL is no http(s) one (sw-client.js `requestRoute`) — null where the
// worker let it through.
function swFontAnswer(url, plan, referrer) {
  if (!globalThis.__csimServiceWorkerFor(url)) return undefined;
  try { return globalThis.__csimSwFetchDest(url, 'font', plan, true, referrer); } catch (_) { return null; }
}
// A face's own bytes (a `FontFace` built from a buffer, as a Uint8Array) decoded to a font file by the host: `ok` says
// whether they are a font at all, `path` is null where they decode to nothing.
export function fontFileFromBytes(bytes) {
  try { const r = globalThis.__csim_fontFileFromBytes ? globalThis.__csim_fontFileFromBytes(bytes) : null; return r ? { ok: !!r.ok, path: r.path || null } : { ok: false, path: null }; }
  catch (_) { return { ok: false, path: null }; }
}
// The FontFaceSet's `load()` / `FontFace.load()` reach the fetch through these (font-face.js, which this module
// imports, cannot import it back at load): a CSS-connected face, by its rule's key — its place among the document's
// faces — settled by whether its file loaded.
globalThis.__csimWebFontLoadRule = function (doc, key) {
  if (doc !== globalThis.document) return;
  const index = faceRules().findIndex((entry) => entry.key === key);
  if (index < 0) return;
  handFaces();
  globalThis.__dom.fontFaceFile(index, fetchSource, settleFace, systemFontFile);
};
// …and a script's face, by its state: the file its sources, tried in order, give (`__dom.ffFile`).
globalThis.__csimFaceFile = (state) => globalThis.__dom.ffFile(state, fetchSource);


// ── native faces ────────────────────────────────────────────────────────────
// The @font-face generation that decides which face a family resolves to — the cascade version (an `insertRule`
// / `<style>` append that adds or drops an `@font-face` bumps it) plus the FontFaceSet's added generation
// (`document.fonts.add`), MINUS the per-pass settle generation: what the style engine's face memo keys on.
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
