// CSS Font Loading (FontFace / FontFaceSet), generated from their IDL. A downloaded face (`@font-face` with a `url()`
// src) is FETCHED the first time text needs it — font-metrics.js `faceFile` asks the host for the file, the way Chrome
// loads a web font on first use — and `document.fonts` is the set of the document's CSS-connected faces plus what script
// added: `ready` resolves once the faces the rendered text needs are in (a layout pass loads them), `load()` / `check()`
// take a font shorthand, and a fetch runs a loading cycle (`loading`, then `loadingdone` / `loadingerror` with the
// faces), every step of it a task.
// A FontFace descriptor is parsed by its `@font-face` grammar, the engine's: setting an invalid value throws SyntaxError,
// and an invalid value passed to the CONSTRUCTOR errors the face (its `load()` rejects SyntaxError, its status is
// 'error') rather than throwing.

import { EventTarget, FontFaceSetLoadEvent, installEventHandlerAttrs } from './events.js';
import { fireEvent } from './dispatch.js';
import { faceSources, fontFileFromBytes } from './font-metrics.js';
import { onFontFlush } from './animation.js';
import { foreignRealmOf, REALM as NATIVE_REALM } from './native-query-shadow.js';
import { apiBaseURL } from './platform-globals.js';
import { convertFontFaceArguments, installFontFace, installFontFaceSet } from './generated/bindings.js';
import {
  IntrinsicPromise, PLATFORM, bufferSourceBytes, constructedBy, makeSlots, promiseAll, promiseResolvedWith, promiseThen,
  promiseThenChained, registerInterface, rejectedPromise, resolvedPromise, slotsOf
} from './webidl.js';
import { DOMException } from './dom-exception.js';

// The FontFace attributes that reflect a descriptor, in the order the engine holds them (font_faces.rs
// `FACE_ATTRIBUTE_DESCRIPTORS`), and the face's other fields it reads (font_face_state.rs `ffField`).
const FONT_DESCRIPTORS = [
  'style', 'weight', 'stretch', 'unicodeRange', 'featureSettings', 'variationSettings', 'display', 'ascentOverride',
  'descentOverride', 'lineGapOverride', 'sizeAdjust'
];
const FAMILY = 11, STATUS = 12, ERROR_MESSAGE = 13, RULE = 14, IDENTITY = 15;
const STATUSES = ['unloaded', 'loading', 'loaded', 'error'];
const UNLOADED = 0, LOADED = 2, ERROR = 3;
// A FontFace's slots: its state, the engine's (font_face_state.rs: its family and descriptors, its source, its status,
// the error its constructor's arguments gave it, and for a CSS-connected face the rule it is of), its realm's global
// (whose hooks load and settle it, whichever realm calls), and its `loaded` promise and how to settle it — which resolves
// with the face itself (`owner`) — and the sets that hold it, of whichever realm (`sets`).
const faceOf = (o) => slotsOf(o, 'FontFace');
const field = (s, f) => globalThis.__dom.ffField(s.state, f);
const statusOf = (s) => field(s, STATUS);
registerInterface('FontFace', (o) => faceOf(o) !== undefined);
export class FontFace {
  constructor(family, source, descriptors) {
    [family, source, descriptors] = convertFontFaceArguments(arguments);
    // (…its family, its descriptors and its `src` parsed by the engine — one that does not parse errors the face, which
    // is `error` at once and its `loaded` already rejected, whether or not `load()` is ever called: Chrome)
    const state = new globalThis.__dom.FontFaceStateBase(
      family, typeof source === 'string' ? source : null, apiBaseURL(), FONT_DESCRIPTORS.map((name) => descriptors[name])
    );
    const s = makeSlots(this, 'FontFace', { state, global: globalThis, loaded: null, settle: null, owner: this, sets: new Set() });
    const error = field(s, ERROR_MESSAGE);
    if (error !== null) {
      loadedOf(s);
      s.settle.reject(new DOMException(error, 'SyntaxError'));
    } else if (typeof source !== 'string') {
      // A buffer source is the face's own bytes, parsed at construction: a buffer that is no font fails the face
      // (Chrome: `error`, `loaded` rejects with a SyntaxError).
      globalThis.__dom.ffStart(state);
      const r = fontFileFromBytes(bufferSourceBytes(source));
      globalThis.__dom.ffSetFile(state, r.path);
      globalThis.__csimSetTimeout(() => finishFace(s, r.ok, 'SyntaxError'), 0);
    }
  }
}
// Its `loaded` promise, made when first asked for — handled, as an `error` face rejects it and nobody has to listen.
function loadedOf(s) {
  if (!s.loaded) {
    let settle;
    s.loaded = new IntrinsicPromise((resolve, reject) => { settle = { resolve, reject }; });
    s.settle = settle;
    promiseThen.call(s.loaded, undefined, () => {});
  }
  return s.loaded;
}
// Settled: loaded or errored, its promise with it. `relayout`: whether text already laid out has to be measured again,
// which it does when the face settles on its own schedule (a script's `load()`, a buffer). One layout fetched is being
// measured with by that very pass, and a cascade refresh for it threw away every declared value and kept subtree on the
// page: a Redmine issue page paid a whole relayout per load for its Noto Sans.
function finishFace(s, ok, errorName = 'NetworkError', relayout = true) {
  if (!globalThis.__dom.ffSettle(s.state, ok)) return;
  loadedOf(s);
  if (ok) s.settle.resolve(s.owner);
  else s.settle.reject(new DOMException('A network error occurred.', errorName));
  if (relayout && typeof s.global.__csimScheduleCascadeRefresh === 'function') s.global.__csimScheduleCascadeRefresh();
}
// …and a CSS-connected face whose file layout already fetched starts settled — loaded, or failed.
function startSettled(s, ok) {
  globalThis.__dom.ffSettle(s.state, ok);
  s.loaded = ok ? resolvedPromise(s.owner) : rejectedPromise(new DOMException('A network error occurred.', 'NetworkError'));
  promiseThen.call(s.loaded, undefined, () => {});
}
// load(): the face's sources tried in order — a `url()` fetched (a controlling service worker answers first), a
// `local()` one loaded where this machine has the font under the name — and the face settled by whether one gave a file
// native reads (font_files.rs `face_file`); a settled or loading face's promise as it is. A face with a download that a
// set holds settles through that set's loading cycle; any other in a task of its own — a set's cycle is of the faces
// it holds (Chrome fires none of its events for a face it does not), and a face of `local()` sources alone is no
// download (Chrome rejects `loaded` with a NetworkError where none is installed — `font-face-reject`).
function loadFace(s) {
  if (!globalThis.__dom.ffStart(s.state)) return loadedOf(s);
  const src = faceSources(s.state).find(([kind]) => kind === 'url');
  // (…a blocked respondWith fails the face, as a browser's)
  if (src && /^https?:/i.test(src[1]) && typeof s.global.__csimSwFetchDest === 'function') {
    const sw = s.global.__csimSwFetchDest(src[1], 'font', 'cors', 'same-origin', true);
    if (sw && sw.blocked) { s.global.__csimSetTimeout(() => finishFace(s, false), 0); return loadedOf(s); }
  }
  let ok = false;
  try { ok = s.global.__csimFaceFile(s.state) !== null; } catch (_) { ok = false; }
  if (src && s.sets.size) for (const set of s.sets) fontSetFaceFetched(set, s.owner, ok);
  else s.global.__csimSetTimeout(() => finishFace(s, ok), 0);
  return loadedOf(s);
}
// A descriptor set: parsed by its grammar (a SyntaxError for what it refuses — a set never errors the face), serialized,
// and the document's set told, where it holds the face. The family's strictly, the setter's steps, which #6236 left as
// they were.
const setter = (name, f) => (face, v) => {
  if (!globalThis.__dom.ffSet(faceOf(face).state, f, v)) {
    throw new DOMException(`Failed to set the '${name}' property on 'FontFace': Failed to set '${v}' as a property value.`, 'SyntaxError');
  }
  descriptorChanged(face);
};
const descriptorAccessors = Object.fromEntries(FONT_DESCRIPTORS.flatMap((name, i) => [
  [`get_${name}`, (f) => field(faceOf(f), i)],
  [`set_${name}`, setter(name, i)]
]));
installFontFace(FontFace, {
  get_family: (f) => field(faceOf(f), FAMILY),
  set_family: setter('family', FAMILY),
  ...descriptorAccessors,
  get_status: (f) => STATUSES[statusOf(faceOf(f))],
  get_loaded: (f) => loadedOf(faceOf(f)),
  load: (f) => loadFace(faceOf(f))
});
globalThis.FontFace = FontFace;
// A face the document's set holds matches by its descriptors, so rewriting one changes what the set holds as surely as
// adding the face does (`fontface-descriptor-updates-2`: a style swapped, a family renamed, and the next measure takes
// them) — every set's that holds it, another realm's too. The document's index was rebuilt on every DOM mutation until
// it keyed on what decides it, and so saw these only when a mutation happened to follow.
function descriptorChanged(face) {
  for (const set of faceOf(face).sets) facesChanged(setOf(set));
}

// What font-metrics.js reads of a face: its state (the engine lists the document's faces by them).
export function faceStateOf(face) { return faceOf(face).state; }

// A FontFaceSet's slots: the set itself (`self`, what a face it holds keeps), its realm's global (whose hooks read its
// document's faces and run its loading cycle, whichever realm calls) and how that realm makes a face, its document (none
// for a worker's), the faces script added, the CSS-connected faces by their rule's key, the faces of the loading cycle under way and whether its task is queued, its `ready` promise and how to
// settle it, the generation of what it HOLDS — a face added, deleted, or one of its descriptors rewritten — which the
// document's face index keys on (font-metrics.js `fontFaceIndex`), and whether the rendering update has to load the
// faces rendered text needs (initially, so the first update loads the page's own) and the CSS-connected faces it last
// loaded them for (`faceSig`).
const setOf = (o) => slotsOf(o, 'FontFaceSet');
registerInterface('FontFaceSet', (o) => setOf(o) !== undefined);
export class FontFaceSet extends EventTarget {
  constructor(token, doc) {
    constructedBy(PLATFORM, token, 'FontFaceSet');
    super();
    makeSlots(this, 'FontFaceSet', {
      self: this, global: globalThis, makeFace: (...args) => new FontFace(...args), connected: null,
      doc, faces: new Set(), cssFaces: new Map(), pending: [], cycleQueued: false, readyPromise: null, readySettle: null,
      facesGen: 0, needFlush: true, flushedSig: null, materialisingRule: null
    });
  }
}
// The CSS-connected faces, in stylesheet order — a FontFace per applying rule whose `src` names a source this UA can use
// (Chrome: a rule of only `format("embedded-opentype")` sources is no face of the set), reused while the rule lives (a
// face removed with its stylesheet drops out of the set) — the same list while the document's face index is the same.
function connectedFaces(t) {
  const out = [], doc = t.doc;
  const index = doc && typeof t.global.__csimFontFaceIndex === 'function' ? t.global.__csimFontFaceIndex(doc) : null;
  if (index && t.connected && t.connected.index === index && !t.materialisingRule) return t.connected.faces;
  const live = new Set();
  for (const entry of index ? index.rules : []) {
    // (…keyed by the identity the style engine keeps for the face's rule, `entry.key`: style.rs `FaceIds`; a rule with
    // no family the style engine took — `font-family: serif` — or no source to try, no face at all: font_faces.rs
    // `rule_face`)
    const key = entry.key;
    if (!entry.isFace) continue;
    // …and only while it names the font it was made from: a rule whose family or sources CSSOM rewrote is a face of its
    // own (`entry.identity`: its family and its sources, resolved — not its declarations' text, which a descriptor
    // rewritten changes without making it another face).
    let face = t.cssFaces.get(key);
    if (face && field(faceOf(face), IDENTITY) !== entry.identity) {
      faceOf(face).sets.delete(t.self);
      face = null;
    }
    // The same face reflects its rule as it is now (CSS Font Loading §2.2: a CSS-connected face's attributes are its
    // rule's descriptors) — one whose weight or style was rewritten keeps its identity, and reads the new value.
    if (face) globalThis.__dom.ffConnect(faceOf(face).state, key, null, entry.attributes);
    else {
      const desc = {};
      FONT_DESCRIPTORS.forEach((name, i) => { if (entry.attributes[i]) desc[name] = entry.attributes[i]; });
      face = t.makeFace(entry.family, entry.src, desc);
      const s = faceOf(face);
      // (…its family the rule's descriptor as the style engine took and serialized it — `math` stays `math`, which the
      // constructor's stricter reading would have quoted — CSS Font Loading §2.2)
      globalThis.__dom.ffConnect(s.state, key, entry.identity, entry.attributes, entry.family);
      // A CSS-connected face whose file layout already fetched (text needed it before script looked at
      // `document.fonts`) is loaded — or failed — from the start; a face script constructs starts `unloaded` whatever
      // the cache holds. …unless THIS is the face `faceFetched` is materialising for its own cycle (that face settles
      // there, not here).
      if (key !== t.materialisingRule) {
        const status = t.global.__dom.ffFetchedStatus(s.state);
        if (status !== UNLOADED) startSettled(s, status === LOADED);
      }
      // (…a face this set holds: its own `load()` settles through the set's cycle)
      s.sets.add(t.self);
      t.cssFaces.set(key, face);
    }
    live.add(key);
    out.push(face);
  }
  for (const [k, face] of Array.from(t.cssFaces)) {
    if (live.has(k)) continue;
    faceOf(face).sets.delete(t.self);
    t.cssFaces.delete(k);
  }
  if (index) t.connected = { index, faces: out };
  return out;
}
// Reading the set lays the document out first: Chrome has loaded the faces its rendered text needs by the time script
// looks, and layout is what loads them here.
function allFaces(t) {
  flushLayout(t);
  return connectedFaces(t).concat(Array.from(t.faces));
}
// (…by the realm whose document it is, through no member a page may have replaced)
function flushLayout(t) {
  if (!t.doc) return;
  try { (foreignRealmOf(t.doc) ?? NATIVE_REALM).ensureLayout?.(); } catch (_) {}
}
function facesChanged(t) {
  t.facesGen++;
  if (typeof t.global.__csimScheduleCascadeRefresh === 'function') t.global.__csimScheduleCascadeRefresh();
}
// font-metrics.js reports a fetched face here — by the face (its rule, or the script object) — and the loading cycle's
// events go out as TASKS: `loading` once per cycle, `loadingdone` / `loadingerror` with the faces once the turn's
// fetches are in, `ready` settled after them. Nothing here touches layout: a listener that mutates the DOM must not
// re-enter the pass that loaded the face.
export function fontSetFaceFetched(set, who, ok) {
  const t = setOf(set);
  let face = null;
  if (who && who.rule) {
    face = t.cssFaces.get(who.rule) || null;
    if (!face) {
      // Materialise the rule's face (no layout) as `unloaded`: THIS fetch is its cycle; other CSS faces still take
      // their cached status.
      t.materialisingRule = who.rule;
      try { connectedFaces(t); } finally { t.materialisingRule = null; }
      face = t.cssFaces.get(who.rule) || null;
    }
  } else if (faceOf(who) !== undefined) face = who;
  if (!face) return;
  const s = faceOf(face);
  const status = statusOf(s);
  if (status === LOADED || status === ERROR) return;
  if (!t.pending.length && !t.cycleQueued) {
    t.cycleQueued = true;
    t.global.__csimSetTimeout(() => {
      t.cycleQueued = false;
      fireEvent(set, new FontFaceSetLoadEvent('loading', { fontfaces: [] }));
      t.global.__csimSetTimeout(() => {
        const batch = t.pending;
        t.pending = [];
        for (const p of batch) finishFace(faceOf(p.face), p.ok);
        const done = batch.filter((p) => p.ok).map((p) => p.face), failed = batch.filter((p) => !p.ok).map((p) => p.face);
        fireEvent(set, new FontFaceSetLoadEvent('loadingdone', { fontfaces: done }));
        if (failed.length) fireEvent(set, new FontFaceSetLoadEvent('loadingerror', { fontfaces: failed }));
        const settle = t.readySettle;
        t.readySettle = null;
        if (settle) settle(set);
      }, 0);
    }, 0);
  }
  // A face layout fetched is settled at once — Chrome has loaded what rendered text needs by the time script looks; the
  // cycle's events still go out as tasks. One script `load()`ed stays `loading` until its task, as in Chrome.
  if (who && who.rule) finishFace(s, ok, 'NetworkError', false);
  else globalThis.__dom.ffStart(s.state);
  // (…once per cycle: a face whose file is asked again — the document's face list handed over anew — is in it already)
  if (!t.pending.some((p) => p.face === face)) t.pending.push({ face, ok });
}
// What font-metrics.js reads of a set: the faces script added, and the generation of what it holds.
export function fontSetAddedFaces(set) { return setOf(set).faces; }
export function fontSetGeneration(set) { return setOf(set).facesGen; }
// The faces of a set that `font` and `text` match — `check()`'s and `load()`'s (CSS Font Loading "find the matching font
// faces"): the engine's font matching over their families and descriptors (font_faces.rs `matching`: the nearest
// stretch, the same style, the nearest weight, a `unicode-range` covering a character of `text`); a shorthand that does
// not parse is a SyntaxError. (…check()'s message its operation's, load()'s rejection the bare one: Chrome)
function matchingFaces(t, font, text, prefix) {
  const faces = allFaces(t);
  const picked = globalThis.__dom.fontFacesMatching(font, text, faces.map(faceStateOf));
  if (picked === null) throw new DOMException(`${prefix}Could not resolve '${font}' as a font.`, 'SyntaxError');
  return Array.from(picked, (i) => faces[i]);
}
installFontFaceSet(FontFaceSet, {
  // (…the set's faces, the CSS-connected ones first: setlike<FontFace> over them)
  setOf: (set) => new Set(allFaces(setOf(set))),
  // add(): a face script made, once (a CSS-connected face is in the set already).
  add(set, font) {
    const t = setOf(set);
    if (field(faceOf(font), RULE) !== null || t.faces.has(font)) return set;
    t.faces.add(font);
    faceOf(font).sets.add(set);
    t.needFlush = true;
    facesChanged(t);
    return set;
  },
  delete(set, font) {
    const t = setOf(set);
    const had = t.faces.delete(font);
    if (had) {
      faceOf(font).sets.delete(set);
      facesChanged(t);
    }
    return had;
  },
  clear(set) {
    const t = setOf(set);
    if (!t.faces.size) return;
    for (const face of t.faces) faceOf(face).sets.delete(set);
    t.faces.clear();
    facesChanged(t);
  },
  // load(): every face `font` and `text` match fetched, resolved with them once in — a face that failed rejects it
  // (NetworkError).
  load(set, font, text) {
    const t = setOf(set);
    const faces = matchingFaces(t, font, text, '');
    for (const f of faces) {
      const s = faceOf(f);
      if (statusOf(s) !== UNLOADED) continue;
      const rule = field(s, RULE);
      if (rule !== null && t.doc) { try { t.global.__csimWebFontLoadRule(t.doc, rule); } catch (_) {} }
      else loadFace(s);
    }
    return promiseThenChained(promiseAll(faces.map((f) => loadedOf(faceOf(f)))), () => faces);
  },
  // check(): every face `font` and `text` match loaded — none to load among them, or none matched at all.
  check: (set, font, text) => matchingFaces(setOf(set), font, text, "Failed to execute 'check' on 'FontFaceSet': ").every((f) => statusOf(faceOf(f)) === LOADED),
  // ready: one promise per loading cycle, resolved once the cycle's `loadingdone` went out.
  get_ready(set) {
    const t = setOf(set);
    flushLayout(t);
    if (!t.pending.length && !t.cycleQueued) return t.readyPromise || (t.readyPromise = promiseResolvedWith(set));
    if (!t.readySettle) t.readyPromise = new IntrinsicPromise((resolve) => { t.readySettle = resolve; });
    return t.readyPromise;
  },
  get_status: (set) => (setOf(set).pending.length || setOf(set).cycleQueued ? 'loading' : 'loaded'),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.FontFaceSet = FontFaceSet;
// A document's set (`document.fonts`), or a worker's (`self.fonts`, of no document).
export const newFontFaceSet = (doc) => new FontFaceSet(PLATFORM, doc);
globalThis.__csimNewFontFaceSet = newFontFaceSet;

// At each rendering update, load the faces this realm's rendered text needs — a browser loads a
// used font at the update even if no script measured it (`font-face-reject` relies on it). Gated on
// `needFlush` (set when a face is added, and once initially) and on the document's CSS-connected
// faces moving (`faceSig` of `__csimFontFaceIndex`: a sheet declaring one inserted — not every
// rule-set change), so a page whose faces have all settled pays nothing.
onFontFlush(() => {
  const doc = globalThis.document;
  if (!doc) return;
  let set = doc._fontFaceSet;
  if (!set) {
    // No script has touched `document.fonts`, but a page can declare an `@font-face` used by
    // rendered text with no script at all — a browser still loads it at the rendering update.
    // Instantiate the set (its first flush) only when the document declares a face; the O(1) gate
    // keeps a page with none from paying anything.
    if (typeof globalThis.__csimDocHasFontFace === 'function' && !globalThis.__csimDocHasFontFace()) return;
    set = doc.fonts;                                            // lazily creates it, `needFlush` true
  }
  const t = setOf(set);
  const index = typeof globalThis.__csimFontFaceIndex === 'function' ? globalThis.__csimFontFaceIndex(doc) : null;
  const sig = index ? index.faceSig : null;
  if (t.needFlush || sig !== t.flushedSig) {
    t.needFlush = false;
    t.flushedSig = sig;
    flushLayout(t);
  }
});
