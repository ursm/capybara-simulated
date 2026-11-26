// CSS Font Loading (FontFace / FontFaceSet), generated from their IDL. A downloaded face (`@font-face` with a `url()`
// src) begins loading the first time text needs it — the engine begins its download (font_files.rs), the way Chrome
// loads a web font on first use, and lays the text out with the fallback until it lands as a task — and `document.fonts`
// is the set of the document's CSS-connected faces plus what script added: its loading cycle the engine's
// (font_face_set.rs: `loading` as a face begins loading, `loaded` as the last one settles and its document is completely
// loaded, `ready` fulfilled then), its tasks — `loading`, then `loadingdone` / `loadingerror` with the faces — and its
// promises this side's; `load()` / `check()` take a font shorthand.
// A FontFace descriptor is parsed by its `@font-face` grammar, the engine's: setting an invalid value throws SyntaxError,
// and an invalid value passed to the CONSTRUCTOR errors the face (its `load()` rejects SyntaxError, its status is
// 'error') rather than throwing.

import { EventTarget, FontFaceSetLoadEvent, installEventHandlerAttrs } from './events.js';
import { fireEvent } from './dispatch.js';
import { fontFileFromBytes } from './font-metrics.js';
import { nidOf } from './node-identity.js';
import { onFontFlush } from './animation.js';
import { foreignRealmOf, rareDataOf, REALM as NATIVE_REALM, sameObject } from './native-query-shadow.js';
import { apiBaseURL } from './platform-globals.js';
import { convertFontFaceArguments, installFontFace, defineFontFaceSet } from './generated/bindings.js';
import {
  Dictionary,
  IntrinsicPromise,
  PLATFORM,
  bufferSourceBytes,
  makeSlots,
  promiseAll,
  promiseResolvedWith,
  promiseThen,
  promiseThenChained,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf,
  createObject,
  rootInterface
} from './webidl.js';
import { DOMException } from './dom-exception.js';
import {
  builtList, dom, engineOf, hooksOf, listConcat, listEach, listEvery, listFlatMap, listFrom, listMap, pageList,
  realmHooks
} from './engine.js';
import { InternalSet, reflectApply } from './intrinsics.js';

// The FontFace attributes that reflect a descriptor, in the order the engine holds them (font_faces.rs
// `FACE_ATTRIBUTE_DESCRIPTORS`), and the face's other fields it reads (font_face_state.rs `ffField`).
const FONT_DESCRIPTORS = [
  'style', 'weight', 'stretch', 'unicodeRange', 'featureSettings', 'variationSettings', 'display', 'ascentOverride',
  'descentOverride', 'lineGapOverride', 'sizeAdjust'
];
const FAMILY = 11, STATUS = 12, ERROR_MESSAGE = 13, RULE = 14;
const STATUSES = ['unloaded', 'loading', 'loaded', 'error'];
const UNLOADED = 0, LOADING = 1, LOADED = 2;
// A FontFace's slots: its state, the engine's (font_face_state.rs: its family and descriptors, its source, its status,
// the error its constructor's arguments gave it, and for a CSS-connected face the rule it is of), its realm's global
// (whose hooks load and settle it, whichever realm calls), and its `loaded` promise and how to settle it — which resolves
// with the face itself (`owner`). The sets that hold it, of whichever realm, are the engine's (`ffSets`).
const faceOf = (o) => slotsOf(o, 'FontFace');
const field = (s, f) => dom.ffField(s.state, f);
const statusOf = (s) => field(s, STATUS);
registerInterface('FontFace', (o) => faceOf(o) !== undefined);
export class FontFace extends Object {
  constructor(family, source, descriptors) {
    const converted = convertFontFaceArguments(arguments);
    family = converted[0];
    source = converted[1];
    descriptors = converted[2];
    // (…its family, its descriptors and its `src` parsed by the engine — one that does not parse errors the face, which
    // is `error` at once and its `loaded` already rejected, whether or not `load()` is ever called: Chrome)
    const state = new dom.FontFaceStateBase(
      family, typeof source === 'string' ? source : null, apiBaseURL(), listMap(FONT_DESCRIPTORS, (name) => descriptors[name])
    );
    const self = createObject(new.target);
    const s = makeSlots(self, 'FontFace');
    s.state = state;
    s.global = globalThis;
    s.loaded = null;
    s.settle = null;
    s.owner = self;
    const error = field(s, ERROR_MESSAGE);
    if (error !== null) {
      loadedOf(s);
      s.settle.reject(new DOMException(error, 'SyntaxError'));
    } else if (typeof source !== 'string') {
      // A buffer source is the face's own bytes, parsed at construction: a buffer that is no font fails the face
      // (Chrome: `error`, `loaded` rejects with a SyntaxError).
      dom.ffStart(state);
      const r = fontFileFromBytes(bufferSourceBytes(source));
      dom.ffSetFile(state, r.path);
      realmHooks.setTimeout(() => finishFace(s, r.ok, 'SyntaxError'), 0);
    }
    return self;
  }
}
rootInterface(FontFace);
// Its `loaded` promise, made when first asked for — handled, as an `error` face rejects it and nobody has to listen.
function loadedOf(s) {
  if (!s.loaded) {
    let settle;
    s.loaded = new IntrinsicPromise((resolve, reject) => { settle = { resolve, reject }; });
    s.settle = settle;
    reflectApply(promiseThen, s.loaded, [undefined, () => {}]);
  }
  return s.loaded;
}
// Loading: its status `loading` and each set that holds it told (font_face_set.rs `fsFaceLoading`) — `now` the set's
// status with it, a script's `load()`; a load the user agent began makes it so a task later. False where it was not
// `unloaded`.
function startFace(s, now) {
  if (!dom.ffStart(s.state)) return false;
  for (let i = 0, list = dom.ffSets(s.state); i < list.length; i++) {
    const t = setOf(list[i]);
    engineOf(t.global).fsFaceLoading(t.state, s.owner, s.state, now);
    setStepped(t);
  }
  return true;
}
// Settled: loaded or errored, its promise with it, and each set that holds it told (`fsFaceSettled`). What text it lays
// out with is the engine's, which measures with its file from the download's landing on (font_files.rs).
function finishFace(s, ok, errorName = 'NetworkError') {
  if (!dom.ffSettle(s.state, ok)) return;
  loadedOf(s);
  if (ok) s.settle.resolve(s.owner);
  else s.settle.reject(new DOMException('A network error occurred.', errorName));
  for (let i = 0, list = dom.ffSets(s.state); i < list.length; i++) {
    const t = setOf(list[i]);
    engineOf(t.global).fsFaceSettled(t.state, s.owner, ok);
    setStepped(t);
  }
}
// …and a CSS-connected face whose file layout already had starts settled — loaded, or failed.
function startSettled(s, ok) {
  dom.ffSettle(s.state, ok);
  s.loaded = ok ? resolvedPromise(s.owner) : rejectedPromise(new DOMException('A network error occurred.', 'NetworkError'));
  reflectApply(promiseThen, s.loaded, [undefined, () => {}]);
}
// load(): the face `loading` — each set that holds it with it — its sources tried in order — a `url()` downloaded (a
// controlling service worker answers first), a `local()` one loaded where this machine has the font under the name —
// and the face settled by whether one gave a file native reads (font_files.rs `face_file`), as a task: CSS Font
// Loading "when the load operation completes … queue a task" — a download's landing (`fontFaceLanded`), else one of its
// own. A settled or loading face's promise as it is. (A face of `local()` sources alone where none is installed
// rejects `loaded` with a NetworkError, as Chrome does — `font-face-reject`.)
function loadFace(s) {
  if (!startFace(s, true)) return loadedOf(s);
  let file = null;
  try { file = hooksOf(s.global).faceFile(s.state, s.owner); } catch (_) { file = null; }
  if (file !== undefined) hooksOf(s.global).setTimeout(() => finishFace(s, file !== null), 0);
  return loadedOf(s);
}
// …a download it waited for landed (font-metrics.js `landFont`): settled by whether its sources gave a file.
export function fontFaceLanded(face, ok) {
  finishFace(faceOf(face), ok);
}
// A descriptor set: parsed by its grammar (a SyntaxError for what it refuses — a set never errors the face), serialized,
// and the document's set told, where it holds the face. The family's strictly, the setter's steps, which #6236 left as
// they were.
const setter = (name, f) => (face, v) => {
  if (!dom.ffSet(faceOf(face).state, f, v)) {
    throw new DOMException(`Failed to set the '${name}' property on 'FontFace': Failed to set '${v}' as a property value.`, 'SyntaxError');
  }
  descriptorChanged(face);
};
const descriptorAccessors = Object.fromEntries(listFlatMap(FONT_DESCRIPTORS, (name, i) => [
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
  for (let i = 0, list = dom.ffSets(faceOf(face).state); i < list.length; i++) {
    const set = list[i];
    const t = setOf(set);
    dom.fsTouch(t.state);
    facesChanged(t);
  }
}

// What font matching reads of a face: its state.
const faceStateOf = (face) => faceOf(face).state;

// A FontFaceSet's slots: its realm's global (whose hooks read its document's faces and run its loading cycle, whichever
// realm calls) and how that realm makes a face, its document (none for a worker's), its state, the engine's (font_face_set.rs: its CSS-connected faces, the faces script added and the
// generation of what script made it HOLD — a face added, deleted, or one of its descriptors rewritten — which the
// document's face list is handed by, font-metrics.js `handFaces`; and its loading cycle, the faces it waits on and
// whether its task is queued), its `ready` promise and how to settle it, and whether the rendering update has to load
// the faces rendered text needs (initially, so the first update loads the page's own) and the generation of the rules it
// last loaded them for (`flushedSig`).
const setOf = (o) => slotsOf(o, 'FontFaceSet');
// …how its realm makes a CSS-connected face, of its rule's family, `src` and descriptors (FONT_DESCRIPTORS' order, empty
// for one not declared) — `[face, state]`, for the engine (`fsConnect`). Its descriptors are its rule's alone (§2.2):
// none read off `Object.prototype`, where a page's property would name one, or its getter run mid-connect.
function makeConnected(family, src, attributes) {
  const desc = new Dictionary();
  listEach(FONT_DESCRIPTORS, (name, i) => { if (attributes[i]) desc[name] = attributes[i]; });
  const face = new FontFace(family, src, desc);
  return [face, faceOf(face).state];
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
  const rulesOf = doc && hooksOf(t.global).fontFaceRules;
  const rules = typeof rulesOf === 'function' ? rulesOf(doc) : pageList();
  const pair = engineOf(t.global).fsConnect(t.state, rules.length > 0, t.makeConnected);
  const faces = pair[0], made = pair[1];
  for (let i = 0; i < made.length; i++) {
    const face = made[i];
    const s = faceOf(face);
    if (field(s, RULE) !== t.materialisingRule) {
      const status = engineOf(t.global).ffFetchedStatus(s.state);
      if (status === LOADING) startFace(s, false);
      else if (status !== UNLOADED) startSettled(s, status === LOADED);
    }
  }
  return faces;
}
// Reading the set lays the document out first: Chrome has loaded the faces its rendered text needs by the time script
// looks, and layout is what loads them here.
function allFaces(t) {
  flushLayout(t);
  return listConcat(connectedFaces(t), dom.fsAdded(t.state));
}
// (…by the realm whose document it is, through no member a page may have replaced)
function flushLayout(t) {
  if (!t.doc) return;
  try { (foreignRealmOf(t.doc) ?? NATIVE_REALM).ensureLayout?.(); } catch (_) {}
}
// (…what it holds moved — the engine's generation of it with it, font_face_set.rs: text is measured again)
function facesChanged(t) {
  hooksOf(t.global).rulesMoved?.();
}
// font-metrics.js reports what a face of the document's came to here — by the face (its rule, or the script object), as
// the engine says (font_resolve.rs `FACE_*`) — and the face goes through its loading: `loading` as its download begins
// (its set's status with it where a script asked, FontFaceSet `load()`), settled as it lands — or, its file there as it
// was first asked for, `loading` now and settled a task later (CSS Font Loading "load()": "when the load operation
// completes … queue a task"). Nothing here touches layout: a listener that mutates the DOM must not re-enter the pass
// that asked for the face; the set's events go out as tasks (`setStepped`).
const FACE_LOADED = 1, FACE_LOADING = 2, FACE_LOADING_BY_SCRIPT = 3, FACE_LANDED = 4;
export function fontSetFace(set, who, what) {
  const t = setOf(set);
  let face = null;
  if (who && who.rule) {
    face = engineOf(t.global).fsCssFace(t.state, who.rule) ?? null;
    if (!face) {
      // Materialise the rule's face (no layout) as `unloaded`: THIS is its loading; other CSS faces still take their
      // status from what their downloads came to.
      t.materialisingRule = who.rule;
      try { connectedFaces(t); } finally { t.materialisingRule = null; }
      face = engineOf(t.global).fsCssFace(t.state, who.rule) ?? null;
    }
  } else if (faceOf(who) !== undefined) face = who;
  if (!face) return;
  const s = faceOf(face);
  if (what === FACE_LOADING || what === FACE_LOADING_BY_SCRIPT) {
    startFace(s, what === FACE_LOADING_BY_SCRIPT);
    return;
  }
  const ok = (what & FACE_LOADED) !== 0;
  if (what & FACE_LANDED) {
    finishFace(s, ok);
    return;
  }
  startFace(s, false);
  hooksOf(t.global).setTimeout(() => finishFace(s, ok), 0);
}
// A set's loading cycle stepped (font_face_set.rs): the tasks it owes queued — `loading` (its status `loading` as it runs,
// where the user agent began the load), `loadingdone` / `loadingerror` with the faces that loaded or failed — and its
// `ready` promise settled where the engine has it fulfilled, or let go of where it replaced it.
const OWE_LOADING_EVENT = 1, OWE_SHOW_LOADING = 2, OWE_DONE_EVENTS = 4;
function setStepped(t) {
  syncReady(t);
  const engine = engineOf(t.global), owed = engine.fsOwed(t.state);
  if (owed & OWE_LOADING_EVENT) hooksOf(t.global).setTimeout(() => {
    if (owed & OWE_SHOW_LOADING) engine.fsShowLoading(t.state);
    fireEvent(t.owner, new FontFaceSetLoadEvent('loading', { __proto__: null, fontfaces: pageList() }));
  }, 0);
  if (owed & OWE_DONE_EVENTS) hooksOf(t.global).setTimeout(() => {
    const lists = engine.fsTakeDone(t.state);
    fireEvent(t.owner, new FontFaceSetLoadEvent('loadingdone', { __proto__: null, fontfaces: builtList(lists[0]) }));
    if (lists[1].length) fireEvent(t.owner, new FontFaceSetLoadEvent('loadingerror', { __proto__: null, fontfaces: builtList(lists[1]) }));
  }, 0);
}
// …its `ready` promise as the engine has it (`fsReady`: which one, and whether fulfilled): one made pending resolved where
// it is fulfilled, or replaced — a replaced one was fulfilled first.
function syncReady(t) {
  const ready = engineOf(t.global).fsReady(t.state), epoch = ready >>> 1, fulfilled = (ready & 1) === 1;
  if (t.readySettle !== null && (fulfilled || epoch !== t.readyEpoch)) {
    const settle = t.readySettle;
    t.readySettle = null;
    settle(t.owner);
  }
  if (epoch !== t.readyEpoch) {
    t.readyEpoch = epoch;
    t.readyPromise = null;
  }
  return fulfilled;
}
// What font-metrics.js reads of a set: the faces script added, and its state.
export function fontSetAddedFaces(set) { return dom.fsAdded(setOf(set).state); }
export function fontSetState(set) { return setOf(set).state; }
// The faces of a set that `font` and `text` match — `check()`'s and `load()`'s (CSS Font Loading "find the matching font
// faces"): the engine's font matching over their families and descriptors (font_faces.rs `matching`: the nearest
// stretch, the same style, the nearest weight, a `unicode-range` covering a character of `text`); a shorthand that does
// not parse is a SyntaxError. (…check()'s message its operation's, load()'s rejection the bare one: Chrome)
function matchingFaces(t, font, text, prefix) {
  const faces = allFaces(t);
  const picked = dom.fontFacesMatching(font, text, listMap(faces, faceStateOf));
  if (picked === null) throw new DOMException(`${prefix}Could not resolve '${font}' as a font.`, 'SyntaxError');
  return listFrom(picked, (i) => faces[i]);
}
function clearFaces(set) {
  const t = setOf(set);
  if (dom.fsClear(t.state).length) facesChanged(t);
  setStepped(t);
}
// …and a document's, where it has made its set, as the document is renewed — not through its `fonts`, which a page's
// element named `fonts` answers ([LegacyOverrideBuiltIns]).
realmHooks.clearDocumentFonts = (doc) => {
  const set = rareDataOf(doc)?.fontFaceSet;
  if (set) clearFaces(set);
};
export const FontFaceSet = defineFontFaceSet(EventTarget, {
  init(slots, doc) {
    slots.global = globalThis;
    slots.makeConnected = makeConnected;
    slots.doc = doc;
    // (…pending on the environment while its document — its realm's, which loads — is not yet completely loaded)
    const loading = doc !== null && doc === globalThis.document && !dom.docCompletelyLoaded(nidOf(doc));
    slots.state = new dom.FontFaceSetStateBase(slots.owner, loading);
    slots.readyPromise = null;
    slots.readySettle = null;
    slots.readyEpoch = 0;
    slots.needFlush = true;
    slots.flushedSig = null;
    slots.materialisingRule = null;
  },
  // (…the set's faces, the CSS-connected ones first: setlike<FontFace> over them)
  setOf: (set) => new InternalSet(allFaces(setOf(set))),
  // add(): a face script made, once (a CSS-connected face is in the set already).
  add(set, font) {
    const t = setOf(set);
    if (!dom.fsAdd(t.state, font, faceOf(font).state)) return set;
    t.needFlush = true;
    facesChanged(t);
    setStepped(t);
    return set;
  },
  delete(set, font) {
    const t = setOf(set);
    const had = dom.fsDelete(t.state, font);
    if (had) facesChanged(t);
    setStepped(t);
    return had;
  },
  clear: clearFaces,
  // load(): every face `font` and `text` match fetched, resolved with them once in — a face that failed rejects it
  // (NetworkError).
  load(set, font, text) {
    const t = setOf(set);
    const faces = matchingFaces(t, font, text, '');
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const s = faceOf(f);
      if (statusOf(s) !== UNLOADED) continue;
      const rule = field(s, RULE);
      if (rule !== null && t.doc) { try { hooksOf(t.global).webFontLoadRule(t.doc, rule); } catch (_) {} }
      else loadFace(s);
    }
    return promiseThenChained(promiseAll(listMap(faces, (f) => loadedOf(faceOf(f)))), () => faces);
  },
  // check(): every face `font` and `text` match loaded — none to load among them, or none matched at all.
  check: (set, font, text) => listEvery(matchingFaces(setOf(set), font, text, "Failed to execute 'check' on 'FontFaceSet': "), (f) => statusOf(faceOf(f)) === LOADED),
  // ready: its [[ReadyPromise]] — the engine's to say which, and whether fulfilled (`syncReady`) — the document laid out
  // first, which begins the loads its rendered text needs, and its CSS-connected faces made, a face loading already
  // `loading` in the set (Chrome and Firefox: a new one at once as a face begins loading, its status `loading` a task
  // later, csim-bench font7 `f6`, `f18`).
  get_ready(set) {
    const t = setOf(set);
    allFaces(t);
    const fulfilled = syncReady(t);
    if (!t.readyPromise) {
      t.readyPromise = fulfilled ? promiseResolvedWith(set) : new IntrinsicPromise((resolve) => { t.readySettle = resolve; });
    }
    return t.readyPromise;
  },
  // status: the engine's, its CSS-connected faces made first (a face loading already in it).
  get_status(set) {
    const t = setOf(set);
    connectedFaces(t);
    return dom.fsLoading(t.state) ? 'loading' : 'loaded';
  },
  installEventHandlers: installEventHandlerAttrs
});
globalThis.FontFaceSet = FontFaceSet;
// A document's set (`document.fonts`), or a worker's (`self.fonts`, of no document).
export const newFontFaceSet = (doc) => new FontFaceSet(PLATFORM, doc);
realmHooks.newFontFaceSet = newFontFaceSet;

// At each rendering update, load the faces this realm's rendered text needs — a browser loads a
// used font at the update even if no script measured it (`font-face-reject` relies on it). Gated on
// `needFlush` (set when a face is added, and once initially) and on the document's `@font-face` rules
// moving (the engine's generation of them, `fontRuleGeneration`: a sheet declaring one inserted — not
// every rule-set change), so a page whose faces have all settled pays nothing. And once more as the
// document's load is about to fire (bridge.entry.js `fireWindowLoad`): the faces its text needs begun
// loading before it, which it waits for (Chrome and Firefox: a page whose text uses a face fires its
// `load` once the face is in, whatever script did or did not read — csim-bench font7 `f11`).
function loadUsedFonts() {
  const doc = globalThis.document;
  if (!doc) return;
  let set = rareDataOf(doc)?.fontFaceSet;
  if (!set) {
    // No script has touched `document.fonts`, but a page can declare an `@font-face` used by
    // rendered text with no script at all — a browser still loads it at the rendering update.
    // Instantiate the set (its first flush) only when the document declares a face; the O(1) gate
    // keeps a page with none from paying anything.
    if (typeof realmHooks.docHasFontFace === 'function' && !realmHooks.docHasFontFace()) return;
    set = sameObject(doc, 'fontFaceSet', newFontFaceSet);       // its first: `needFlush` true
  }
  const t = setOf(set);
  // (…its rules made current first: cascade.js `fontFaceRulesOf`)
  if (typeof realmHooks.fontFaceRules === 'function') realmHooks.fontFaceRules(doc);
  const sig = dom.fontRuleGeneration();
  if (t.needFlush || sig !== t.flushedSig) {
    t.needFlush = false;
    t.flushedSig = sig;
    flushLayout(t);
  }
}
onFontFlush(loadUsedFonts);
realmHooks.loadUsedFonts = loadUsedFonts;
// …and the document completely loaded (bridge.entry.js `fireWindowLoad`): its set pending on the environment no more —
// switched to loaded where it was stuck on it (font_face_set.rs `fsEnvironmentSettled`).
realmHooks.fontsEnvironmentSettled = (doc) => {
  const set = rareDataOf(doc)?.fontFaceSet;
  if (!set) return;
  const t = setOf(set);
  dom.fsEnvironmentSettled(t.state);
  setStepped(t);
};
