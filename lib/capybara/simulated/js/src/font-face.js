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
  Dictionary, IntrinsicPromise, PLATFORM, bufferSourceBytes, constructedBy, makeSlots, promiseAll, promiseResolvedWith, promiseThen,
  promiseThenChained, registerInterface, rejectedPromise, resolvedPromise, slotsOf
} from './webidl.js';
import { DOMException } from './dom-exception.js';

// The FontFace attributes that reflect a descriptor, in the order the engine holds them (font_faces.rs
// `FACE_ATTRIBUTE_DESCRIPTORS`), and the face's other fields it reads (font_face_state.rs `ffField`).
const FONT_DESCRIPTORS = [
  'style', 'weight', 'stretch', 'unicodeRange', 'featureSettings', 'variationSettings', 'display', 'ascentOverride',
  'descentOverride', 'lineGapOverride', 'sizeAdjust'
];
const FAMILY = 11, STATUS = 12, ERROR_MESSAGE = 13, RULE = 14;
const STATUSES = ['unloaded', 'loading', 'loaded', 'error'];
const UNLOADED = 0, LOADED = 2;
// A FontFace's slots: its state, the engine's (font_face_state.rs: its family and descriptors, its source, its status,
// the error its constructor's arguments gave it, and for a CSS-connected face the rule it is of), its realm's global
// (whose hooks load and settle it, whichever realm calls), and its `loaded` promise and how to settle it — which resolves
// with the face itself (`owner`). The sets that hold it, of whichever realm, are the engine's (`ffSets`).
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
    const s = makeSlots(this, 'FontFace', { state, global: globalThis, loaded: null, settle: null, owner: this });
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
  // (…each `url()` through the controlling service worker first, as its download: font-metrics.js `webFontFile`)
  let ok = false;
  try { ok = s.global.__csimFaceFile(s.state) !== null; } catch (_) { ok = false; }
  const sets = globalThis.__dom.ffSets(s.state);
  if (src && sets.length) for (const set of sets) fontSetFaceFetched(set, s.owner, ok);
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
  for (const set of globalThis.__dom.ffSets(faceOf(face).state)) {
    const t = setOf(set);
    globalThis.__dom.fsTouch(t.state);
    facesChanged(t);
  }
}

// What font matching reads of a face: its state.
const faceStateOf = (face) => faceOf(face).state;

// A FontFaceSet's slots: its realm's global (whose hooks read its document's faces and run its loading cycle, whichever
// realm calls) and how that realm makes a face, its document (none for a worker's), its state, the engine's (font_face_set.rs: its CSS-connected faces, the faces script added and the
// generation of what script made it HOLD — a face added, deleted, or one of its descriptors rewritten — which the
// document's face index keys on, font-metrics.js `fontFaceIndex`; and its loading cycle, the faces it waits on and
// whether its task is queued), its `ready` promise and how to settle it, and whether the rendering update has to load
// the faces rendered text needs (initially, so the first update loads the page's own) and the generation of the rules it
// last loaded them for (`flushedSig`).
const setOf = (o) => slotsOf(o, 'FontFaceSet');
// …how its realm makes a CSS-connected face, of its rule's family, `src` and descriptors (FONT_DESCRIPTORS' order, empty
// for one not declared) — `[face, state]`, for the engine (`fsConnect`). Its descriptors are its rule's alone (§2.2):
// none read off `Object.prototype`, where a page's property would name one, or its getter run mid-connect.
function makeConnected(family, src, attributes) {
  const desc = new Dictionary();
  FONT_DESCRIPTORS.forEach((name, i) => { if (attributes[i]) desc[name] = attributes[i]; });
  const face = new FontFace(family, src, desc);
  return [face, faceOf(face).state];
}
registerInterface('FontFaceSet', (o) => setOf(o) !== undefined);
export class FontFaceSet extends EventTarget {
  constructor(token, doc) {
    constructedBy(PLATFORM, token, 'FontFaceSet');
    super();
    makeSlots(this, 'FontFaceSet', {
      global: globalThis, makeConnected, doc, state: new globalThis.__dom.FontFaceSetStateBase(this),
      readyPromise: null, readySettle: null, needFlush: true, flushedSig: null, materialisingRule: null
    });
  }
}
// The CSS-connected faces, in stylesheet order — the engine's (font_face_set.rs `fsConnect`: a FontFace per applying rule
// whose `src` names a source this UA can use — Chrome: a rule of only `format("embedded-opentype")` sources is no face
// of the set — reused while the rule names the font it was made of, its attributes its rule's descriptors as they are
// now), of the document's rule list made current first (font-metrics.js). A face made here whose file layout already
// fetched (text needed it before script looked at `document.fonts`) is loaded — or failed — from the start, as a face
// script constructs starts `unloaded` whatever the cache holds; but for THE face `fontSetFaceFetched` is materialising
// for its own cycle, which settles there. Each is linked to the set, as a face its own `load()` settles through.
function connectedFaces(t) {
  const doc = t.doc;
  const rules = doc && typeof t.global.__csimFontFaceRules === 'function' ? t.global.__csimFontFaceRules(doc) : [];
  const [faces, made] = t.global.__dom.fsConnect(t.state, rules.length > 0, t.makeConnected);
  for (const face of made) {
    const s = faceOf(face);
    if (field(s, RULE) !== t.materialisingRule) {
      const status = t.global.__dom.ffFetchedStatus(s.state);
      if (status !== UNLOADED) startSettled(s, status === LOADED);
    }
  }
  return faces;
}
// Reading the set lays the document out first: Chrome has loaded the faces its rendered text needs by the time script
// looks, and layout is what loads them here.
function allFaces(t) {
  flushLayout(t);
  return connectedFaces(t).concat(globalThis.__dom.fsAdded(t.state));
}
// (…by the realm whose document it is, through no member a page may have replaced)
function flushLayout(t) {
  if (!t.doc) return;
  try { (foreignRealmOf(t.doc) ?? NATIVE_REALM).ensureLayout?.(); } catch (_) {}
}
// (…what it holds moved — the engine's generation of it with it, font_face_set.rs: text is measured again)
function facesChanged(t) {
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
    face = t.global.__dom.fsCssFace(t.state, who.rule) ?? null;
    if (!face) {
      // Materialise the rule's face (no layout) as `unloaded`: THIS fetch is its cycle; other CSS faces still take
      // their cached status.
      t.materialisingRule = who.rule;
      try { connectedFaces(t); } finally { t.materialisingRule = null; }
      face = t.global.__dom.fsCssFace(t.state, who.rule) ?? null;
    }
  } else if (faceOf(who) !== undefined) face = who;
  if (!face) return;
  const s = faceOf(face);
  // (…waited on by the set's cycle — the engine's, font_face_set.rs `fsFetched`: none for a face settled already, a task
  // queued where this begins one)
  const waited = globalThis.__dom.fsFetched(t.state, face, s.state, ok);
  if (waited === CYCLE_NONE) return;
  if (waited === CYCLE_BEGINS) t.global.__csimSetTimeout(() => runCycle(set, t), 0);
  // A face layout fetched is settled at once — Chrome has loaded what rendered text needs by the time script looks; the
  // cycle's events still go out as tasks. One script `load()`ed stays `loading` until its task, as in Chrome.
  if (who && who.rule) finishFace(s, ok, 'NetworkError', false);
  else globalThis.__dom.ffStart(s.state);
}
const CYCLE_NONE = 0, CYCLE_BEGINS = 2;
// …its cycle: `loading`, then in a task of its own the faces it waited on settled, `loadingdone` with those that gave a
// file and `loadingerror` with those that did not, and `ready` resolved.
function runCycle(set, t) {
  globalThis.__dom.fsCycleBegun(t.state);
  fireEvent(set, new FontFaceSetLoadEvent('loading', { fontfaces: [] }));
  t.global.__csimSetTimeout(() => {
    const batch = globalThis.__dom.fsCycleTake(t.state), done = [], failed = [];
    for (let k = 0; k + 1 < batch.length; k += 2) {
      finishFace(faceOf(batch[k]), batch[k + 1]);
      (batch[k + 1] ? done : failed).push(batch[k]);
    }
    fireEvent(set, new FontFaceSetLoadEvent('loadingdone', { fontfaces: done }));
    if (failed.length) fireEvent(set, new FontFaceSetLoadEvent('loadingerror', { fontfaces: failed }));
    const settle = t.readySettle;
    t.readySettle = null;
    if (settle) settle(set);
  }, 0);
}
// What font-metrics.js reads of a set: the faces script added, and the generation of what it holds.
export function fontSetAddedFaces(set) { return globalThis.__dom.fsAdded(setOf(set).state); }
export function fontSetGeneration(set) { return globalThis.__dom.fsGeneration(setOf(set).state); }
export function fontSetState(set) { return setOf(set).state; }
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
    if (!globalThis.__dom.fsAdd(t.state, font, faceOf(font).state)) return set;
    t.needFlush = true;
    facesChanged(t);
    return set;
  },
  delete(set, font) {
    const t = setOf(set);
    const had = globalThis.__dom.fsDelete(t.state, font);
    if (had) facesChanged(t);
    return had;
  },
  clear(set) {
    const t = setOf(set);
    if (globalThis.__dom.fsClear(t.state).length) facesChanged(t);
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
    if (!globalThis.__dom.fsLoading(t.state)) return t.readyPromise || (t.readyPromise = promiseResolvedWith(set));
    if (!t.readySettle) t.readyPromise = new IntrinsicPromise((resolve) => { t.readySettle = resolve; });
    return t.readyPromise;
  },
  get_status: (set) => (globalThis.__dom.fsLoading(setOf(set).state) ? 'loading' : 'loaded'),
  installEventHandlers: installEventHandlerAttrs
});
globalThis.FontFaceSet = FontFaceSet;
// A document's set (`document.fonts`), or a worker's (`self.fonts`, of no document).
export const newFontFaceSet = (doc) => new FontFaceSet(PLATFORM, doc);
globalThis.__csimNewFontFaceSet = newFontFaceSet;

// At each rendering update, load the faces this realm's rendered text needs — a browser loads a
// used font at the update even if no script measured it (`font-face-reject` relies on it). Gated on
// `needFlush` (set when a face is added, and once initially) and on the document's `@font-face` rules
// moving (the engine's generation of them, `fontRuleGeneration`: a sheet declaring one inserted — not
// every rule-set change), so a page whose faces have all settled pays nothing.
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
  // (…its rules made current first: cascade.js `fontFaceRulesOf`)
  if (typeof globalThis.__csimFontFaceRules === 'function') globalThis.__csimFontFaceRules(doc);
  const sig = globalThis.__dom.fontRuleGeneration();
  if (t.needFlush || sig !== t.flushedSig) {
    t.needFlush = false;
    t.flushedSig = sig;
    flushLayout(t);
  }
});
