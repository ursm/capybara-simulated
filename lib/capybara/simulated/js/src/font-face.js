// CSS Font Loading (FontFace / FontFaceSet), generated from their IDL. A downloaded face (`@font-face` with a `url()`
// src) is FETCHED the first time text needs it — font-metrics.js `faceFile` asks the host for the file, the way Chrome
// loads a web font on first use — and `document.fonts` is the set of the document's CSS-connected faces plus what script
// added: `ready` resolves once the faces the rendered text needs are in (a layout pass loads them), `load()` / `check()`
// take a font shorthand, and a fetch runs a loading cycle (`loading`, then `loadingdone` / `loadingerror` with the
// faces), every step of it a task.
// A FontFace descriptor is validated where the spec's grammar is one this checks: setting an invalid value throws
// SyntaxError, and an invalid value passed to the CONSTRUCTOR errors the face (its `load()` rejects SyntaxError, its
// status is 'error') rather than throwing. `family` / `unicode-range` and the list-valued ones keep the driver's lenient
// acceptance; the override / size-adjust / display grammars are validated because css-font-loading tests assert the
// SyntaxError.

import { Event, EventTarget, FontFaceSetLoadEvent, installEventHandlerAttrs } from './events.js';
import { fireEvent } from './dispatch.js';
import { faceSources, fontFileFromBytes } from './font-metrics.js';
import { onFontFlush } from './animation.js';
import { documentElementOf } from './document-tree.js';
import { location } from './location.js';
import { convertFontFaceArguments, installFontFace, installFontFaceSet } from './generated/bindings.js';
import { PLATFORM, bufferSourceBytes, constructedBy, makeSlots, promiseResolvedWith, registerInterface, rejectedPromise, slotsOf } from './webidl.js';

// The descriptors, each its default and the grammar it is held to.
const FONT_DESCRIPTORS = {
  style:             { def: 'normal' },
  weight:            { def: 'normal' },
  stretch:           { def: 'normal' },
  unicodeRange:      { def: 'U+0-10FFFF' },
  featureSettings:   { def: 'normal' },
  variationSettings: { def: 'normal' },
  display:           { def: 'auto', valid: (v) => /^(auto|block|swap|fallback|optional)$/i.test(v.trim()) },
  ascentOverride:    { def: 'normal', valid: validOverride },
  descentOverride:   { def: 'normal', valid: validOverride },
  lineGapOverride:   { def: 'normal', valid: validOverride },
  sizeAdjust:        { def: '100%', valid: validSizeAdjust }
};
// `normal` or a non-negative <percentage> (CSS Fonts 4 §5.x metric overrides).
const CALC_RE = /^calc\(/i;   // Chrome stores a calc() percentage verbatim, no deep validation
function validOverride(v) { const t = v.trim(); return t.toLowerCase() === 'normal' || CALC_RE.test(t) || nonNegPercent(t); }
function validSizeAdjust(v) { const t = v.trim(); return CALC_RE.test(t) || nonNegPercent(t); }
// A non-negative <percentage>, `-0%` included; `+` and a bare leading `.` allowed.
function nonNegPercent(t) { const m = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)%$/.exec(t); return !!m && (m[1] !== '-' || parseFloat(m[2]) === 0); }
// The serialized form of a validated descriptor (Chrome normalizes: keywords lowercased, a
// percentage's `+` dropped, a bare `.5%` padded to `0.5%`, `-0%` to `0%`, whitespace trimmed;
// a `calc()` is kept verbatim). Only the validated descriptors are normalized — `family` and
// the list-valued ones round-trip as given.
function normalizeDescriptor(name, v) {
  const t = v.trim();
  if (name === 'display') return t.toLowerCase();
  if (CALC_RE.test(t)) return t;
  if (t.toLowerCase() === 'normal') return 'normal';
  const m = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)%$/.exec(t);
  if (!m) return t;
  let n = parseFloat(m[2]);
  if (n === 0) n = 0;                                  // `-0` → `0`
  return (Number.isFinite(n) ? String(n) : m[2]) + '%';
}
// The value a descriptor takes from `raw`: its default when absent, stored normalized when valid, and null when invalid
// (the constructor errors the face then).
function descriptorValue(name, raw) {
  const spec = FONT_DESCRIPTORS[name];
  if (raw === undefined) return spec.def;
  if (!spec.valid) return raw;
  return spec.valid(raw) ? normalizeDescriptor(name, raw) : null;
}

// A FontFace's slots: its realm's global (whose hooks load and settle it, whichever realm calls), its family, its
// descriptors, its source (a `src` string, or none for a buffer's face, whose file is `sfntPath`), its status, its
// `loaded` promise and how to settle it, the error a constructor argument it could not parse settles it with — and, for a
// CSS-connected face, the rule it is of (`rule`), what that rule's descriptors were when last reflected (`ruleDesc`) and
// its identity (`cssDecl`).
const faceOf = (o) => slotsOf(o, 'FontFace');
registerInterface('FontFace', (o) => faceOf(o) !== undefined);
export class FontFace {
  constructor(family, source, descriptors) {
    [family, source, descriptors] = convertFontFaceArguments(arguments);
    const s = makeSlots(this, 'FontFace', {
      global: globalThis, family, desc: {}, source: typeof source === 'string' ? source : null, sfntPath: null,
      status: 'unloaded', loaded: null, settle: null, error: null, rule: null, ruleDesc: null, cssDecl: null
    });
    // (…a descriptor that does not parse the empty string, as the constructor's steps set it)
    for (const name in FONT_DESCRIPTORS) {
      const val = descriptorValue(name, descriptors[name]);
      if (val === null) s.error = 'The provided descriptor value is invalid.';
      s.desc[name] = val === null ? '' : val;
    }
    // (…a `src` string that does not parse as one — no source in it — errored too: the constructor's "parse source as a
    // <font-src>"; Chrome: `new FontFace('a', {})` is an error face, in these words)
    if (s.source !== null && faceSources(s.source, location.href || undefined).length === 0) {
      s.error = `The source provided ('${s.source}') could not be parsed as a value list.`;
    }
    if (s.error !== null) {
      // Errored at construction, synchronously (Chrome): status is `error` at once and `loaded`
      // is already a rejected promise, whether or not `load()` is ever called.
      s.status = 'error';
      loadedOf(s);
      s.settle.reject(new DOMException(s.error, 'SyntaxError'));
    } else if (s.source === null) {
      // A buffer source is the face's own bytes, parsed at construction: a buffer that is no
      // font fails the face (Chrome: `error`, `loaded` rejects with a SyntaxError).
      s.status = 'loading';
      const r = fontFileFromBytes(bufferSourceBytes(source));
      s.sfntPath = r.path;
      globalThis.__csimSetTimeout(() => finishFace(s, r.ok, 'SyntaxError'), 0);
    }
  }
}
// Its `loaded` promise, made when first asked for — handled, as an `error` face rejects it and nobody has to listen.
function loadedOf(s) {
  if (!s.loaded) {
    let settle;
    s.loaded = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    s.settle = settle;
    s.loaded.catch(() => {});
  }
  return s.loaded;
}
// Settled: loaded or errored, its promise with it. `relayout`: whether text already laid out has to be measured again,
// which it does when the face settles on its own schedule (a script's `load()`, a buffer). One layout fetched is being
// measured with by that very pass, and a cascade refresh for it threw away every declared value and kept subtree on the
// page: a Redmine issue page paid a whole relayout per load for its Noto Sans.
function finishFace(s, ok, errorName = 'NetworkError', relayout = true) {
  if (s.status === 'loaded' || s.status === 'error') return;
  s.status = ok ? 'loaded' : 'error';
  loadedOf(s);
  if (ok) s.settle.resolve(s.owner);
  else s.settle.reject(new DOMException('A network error occurred.', errorName));
  if (relayout && typeof s.global.__csimScheduleCascadeRefresh === 'function') s.global.__csimScheduleCascadeRefresh();
}
// …and a CSS-connected face whose file layout already fetched starts settled — loaded, or failed.
function startSettled(s, status) {
  s.status = status;
  s.loaded = status === 'loaded' ? Promise.resolve(s.owner) : rejectedPromise(new DOMException('A network error occurred.', 'NetworkError'));
  s.loaded.catch(() => {});
}
// load(): a face with a `url()` source fetched (a controlling service worker answers first); one of `local()` sources
// loaded where this machine has the font under one of the names; a settled or loading face's promise as it is.
function loadFace(s) {
  if (s.status !== 'unloaded') return loadedOf(s);
  s.status = 'loading';
  const sources = s.source !== null ? faceSources(s.source, s.global.location.href || undefined) : [];
  const src = sources.find(([kind]) => kind === 'url');
  if (!src) {
    // No downloadable source: a `local(<name>)` face loads if this machine has the font under
    // that name, else it fails (Chrome rejects `loaded` with a NetworkError — `font-face-reject`).
    const locals = sources.map(([, name]) => name);
    let ok = false;
    if (locals.length && typeof s.global.__csim_localFontFile === 'function') {
      const bold = parseInt(s.desc.weight, 10) >= 600, italic = /italic|oblique/.test(s.desc.style);
      const ws = (bold ? 'bold' : '') + (italic ? (bold ? ':italic' : 'italic') : '');   // colon form, as `fc_match` expects
      for (const name of locals) {
        try { if (s.global.__csim_localFontFile(name, ws)) { ok = true; break; } } catch (_) { /* misses */ }
      }
    }
    s.global.__csimSetTimeout(() => finishFace(s, ok), 0);
    return loadedOf(s);
  }
  // A controlling service worker answers first (destination 'font'); a blocked
  // respondWith fails the face like a browser.
  const abs = src[1];
  if (/^https?:/i.test(abs) && typeof s.global.__csimSwFetchDest === 'function') {
    const sw = s.global.__csimSwFetchDest(abs, 'font', 'cors', 'same-origin', true);
    if (sw && sw.blocked) { s.global.__csimSetTimeout(() => finishFace(s, false), 0); return loadedOf(s); }
  }
  try { s.global.__csimWebFontLoadUrl(s.source, s.global.document, s.owner); }
  catch (_) { s.global.__csimSetTimeout(() => finishFace(s, false), 0); }
  return loadedOf(s);
}
// A descriptor set: validated (a SyntaxError for what its grammar refuses — a set never errors the face), normalized,
// and the document's set told, where it holds the face.
const descriptorAccessors = Object.fromEntries(Object.keys(FONT_DESCRIPTORS).flatMap((name) => [
  [`get_${name}`, (f) => faceOf(f).desc[name]],
  [`set_${name}`, (f, v) => {
    const spec = FONT_DESCRIPTORS[name];
    if (spec.valid && !spec.valid(v)) {
      throw new DOMException(`Failed to set the '${name}' property on 'FontFace': Failed to set '${v}' as a property value.`, 'SyntaxError');
    }
    faceOf(f).desc[name] = spec.valid ? normalizeDescriptor(name, v) : v;
    descriptorChanged(f);
  }]
]));
installFontFace(FontFace, {
  get_family: (f) => faceOf(f).family,
  set_family(f, v) { faceOf(f).family = v; descriptorChanged(f); },
  ...descriptorAccessors,
  get_status: (f) => faceOf(f).status,
  get_loaded: (f) => loadedOf(faceOf(f)),
  load: (f) => loadFace(faceOf(f))
});
globalThis.FontFace = FontFace;
// A face the document's set holds matches by its descriptors, so rewriting one changes what the set holds as surely as
// adding the face does (`fontface-descriptor-updates-2`: a style swapped, a family renamed, and the next measure takes
// them). The document's index was rebuilt on every DOM mutation until it keyed on what decides it, and so saw these only
// when a mutation happened to follow.
function descriptorChanged(face) {
  const doc = faceOf(face).global.document;
  const set = doc && doc._fontFaceSet;
  if (set && setOf(set).faces.has(face)) facesChanged(setOf(set));
}

// What font-metrics.js reads of a face, by its slots: its descriptors, its `src` (null for a buffer's), its file.
export function faceDescriptors(face) { return { family: faceOf(face).family, ...faceOf(face).desc }; }
export function faceSourceOf(face) { return faceOf(face).source; }
export function faceFileOf(face) { return faceOf(face).sfntPath; }

// A CSS-connected face's identity (`connectedFaces`): its family and the sources its `src` names, each `url()` resolved
// against `base` — what makes two reads of one rule the same face, however each wrote its declarations (a format hint,
// the quoting, the spacing between them).
function faceIdentity(style, base) {
  const family = (style.getPropertyValue('font-family') || '').trim().replace(/^["']|["']$/g, '');
  const sources = faceSources(style.getPropertyValue('src') || '', base).map(([kind, value]) => `${kind}:${value}`);
  return `${family}\n${sources.join('\n')}`;
}
// The `@font-face` descriptor each FontFace attribute reflects.
const RULE_DESCRIPTORS = {
  style:             'font-style',
  weight:            'font-weight',
  stretch:           'font-stretch',
  unicodeRange:      'unicode-range',
  featureSettings:   'font-feature-settings',
  variationSettings: 'font-variation-settings',
  display:           'font-display',
  ascentOverride:    'ascent-override',
  descentOverride:   'descent-override',
  lineGapOverride:   'line-gap-override',
  sizeAdjust:        'size-adjust'
};
// A rule's descriptors as the FontFace constructor takes them: the ones it declares.
function ruleDescriptors(style) {
  const d = {};
  for (const name in RULE_DESCRIPTORS) {
    const v = style.getPropertyValue(RULE_DESCRIPTORS[name]);
    if (v) d[name] = v;
  }
  return d;
}
// …and written over a face already connected to it once they CHANGE (`ruleDesc`, what was last reflected): each
// attribute what the rule says now, or its default. A rule that says the same as it did leaves the face alone — a
// script may have set an attribute since, which this face keeps (Chrome; the setters reach no rule here).
function reflectRuleDescriptors(s, style) {
  const d = ruleDescriptors(style), sig = JSON.stringify(d);
  if (sig === s.ruleDesc) return;
  s.ruleDesc = sig;
  for (const name in RULE_DESCRIPTORS) {
    const val = descriptorValue(name, d[name]);
    s.desc[name] = val === null ? FONT_DESCRIPTORS[name].def : val;
  }
}

// A FontFaceSet's slots: its realm's global (whose hooks read its document's faces and run its loading cycle, whichever
// realm calls) and how that realm makes a face, its document (none for a worker's), the faces script added, the CSS-connected faces by their
// rule's key, the faces of the loading cycle under way and whether its task is queued, its `ready` promise and how to
// settle it, the generation of what it HOLDS — a face added, deleted, or one of its descriptors rewritten — which the
// document's face index keys on (font-metrics.js `fontFaceIndex`), and whether the rendering update has to load the
// faces rendered text needs (initially, so the first update loads the page's own).
const setOf = (o) => slotsOf(o, 'FontFaceSet');
registerInterface('FontFaceSet', (o) => setOf(o) !== undefined);
export class FontFaceSet extends EventTarget {
  constructor(token, doc) {
    constructedBy(PLATFORM, token, 'FontFaceSet');
    super();
    makeSlots(this, 'FontFaceSet', {
      global: globalThis, makeFace: (...args) => new FontFace(...args), connected: null,
      doc, faces: new Set(), cssFaces: new Map(), pending: [], cycleQueued: false, readyPromise: null, readySettle: null,
      facesGen: 0, needFlush: true, materialisingRule: null
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
    // (…keyed by the face's identity, `entry.key`, which outlives the rule it is read from: see cascade.js `faceKey`.)
    const r = entry.rule, key = entry.key;
    if (!r.style || faceSources(r.style.getPropertyValue('src') || '', entry.base).length === 0) continue;
    // …and only while it is the face it was made from: a rule inserted before it moves the next rule into its place,
    // which is a face of its own. Known by its family and its sources, resolved — not by its declarations' text, which
    // the style engine (an unbuilt sheet's faces) and the CSSOM (a built one's) write differently for one face.
    const decl = faceIdentity(r.style, entry.base);
    let face = t.cssFaces.get(key);
    if (face && faceOf(face).cssDecl !== decl) face = null;
    // The same face reflects its rule as it is now (CSS Font Loading §2.2: a CSS-connected face's attributes are its
    // rule's descriptors) — one whose weight or style was rewritten keeps its identity, and reads the new value.
    if (face) reflectRuleDescriptors(faceOf(face), r.style);
    else {
      const fam = (r.style.getPropertyValue('font-family') || '').trim().replace(/^["']|["']$/g, '');
      const desc = ruleDescriptors(r.style);
      face = t.makeFace(fam, r.style.getPropertyValue('src') || '', desc);
      Object.assign(faceOf(face), { ruleDesc: JSON.stringify(desc), rule: key, cssDecl: decl });
      // A CSS-connected face whose file layout already fetched (text needed it before script looked at
      // `document.fonts`) is loaded — or failed — from the start; a face script constructs starts `unloaded` whatever
      // the cache holds. …unless THIS is the face `faceFetched` is materialising for its own cycle (that face settles
      // there, not here).
      if (key !== t.materialisingRule && typeof t.global.__csimWebFontStatus === 'function') {
        const st = t.global.__csimWebFontStatus(faceOf(face).source, entry.base);
        if (st !== 'unloaded') startSettled(faceOf(face), st);
      }
      t.cssFaces.set(key, face);
    }
    live.add(key);
    out.push(face);
  }
  for (const k of Array.from(t.cssFaces.keys())) if (!live.has(k)) t.cssFaces.delete(k);
  if (index) t.connected = { index, faces: out };
  return out;
}
// Reading the set lays the document out first: Chrome has loaded the faces its rendered text needs by the time script
// looks, and layout is what loads them here.
function allFaces(t) {
  flushLayout(t);
  return connectedFaces(t).concat(Array.from(t.faces));
}
function flushLayout(t) {
  const root = t.doc && documentElementOf(t.doc);
  if (root && typeof root.getBoundingClientRect === 'function') { try { root.getBoundingClientRect(); } catch (_) {} }
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
  if (s.status === 'loaded' || s.status === 'error') return;
  if (!t.pending.length && !t.cycleQueued) {
    t.cycleQueued = true;
    t.global.__csimSetTimeout(() => {
      t.cycleQueued = false;
      fireEvent(set, new Event('loading'));
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
  else if (s.status === 'unloaded') s.status = 'loading';
  t.pending.push({ face, ok });
}
// What font-metrics.js reads of a set: the faces script added, and the generation of what it holds.
export function fontSetAddedFaces(set) { return setOf(set).faces; }
export function fontSetGeneration(set) { return setOf(set).facesGen; }
// `check(font)` / `load(font)` take the `font` shorthand's families; a shorthand that does not parse is a SyntaxError.
// (…check()'s message its operation's, load()'s rejection the bare one: Chrome)
function familiesOf(font, prefix) {
  const fams = globalThis.__csimFontShorthandFamilies(font);
  if (!fams) throw new DOMException(`${prefix}Could not resolve '${font}' as a font.`, 'SyntaxError');
  return fams;
}
const facesFor = (t, fam) => allFaces(t).filter((f) => faceOf(f).family.replace(/^["']|["']$/g, '').toLowerCase() === fam.toLowerCase());
installFontFaceSet(FontFaceSet, {
  // (…the set's faces, the CSS-connected ones first: setlike<FontFace> over them)
  setOf: (set) => new Set(allFaces(setOf(set))),
  // add(): a face script made, once (a CSS-connected face is in the set already).
  add(set, font) {
    const t = setOf(set);
    if (faceOf(font).rule !== null || t.faces.has(font)) return set;
    t.faces.add(font);
    t.needFlush = true;
    facesChanged(t);
    return set;
  },
  delete(set, font) {
    const t = setOf(set);
    const had = t.faces.delete(font);
    if (had) facesChanged(t);
    return had;
  },
  clear(set) {
    const t = setOf(set);
    if (!t.faces.size) return;
    t.faces.clear();
    facesChanged(t);
  },
  // load(): every face of the families the shorthand names fetched, resolved with them once in — a face that failed
  // rejects it (NetworkError).
  load(set, font) {
    const t = setOf(set);
    const faces = [];
    for (const fam of familiesOf(font, '')) {
      for (const f of facesFor(t, fam)) {
        const s = faceOf(f);
        if (s.status === 'unloaded') {
          if (s.rule !== null && t.doc) { try { t.global.__csimWebFontLoad(t.doc, fam); } catch (_) {} }
          else loadFace(s);
        }
        faces.push(f);
      }
    }
    return Promise.all(faces.map((f) => loadedOf(faceOf(f)))).then(() => faces);
  },
  // check(): every family the shorthand names has no face to load, or loaded ones.
  check(set, font) {
    const t = setOf(set);
    return familiesOf(font, "Failed to execute 'check' on 'FontFaceSet': ").every((fam) => facesFor(t, fam).every((f) => faceOf(f).status === 'loaded'));
  },
  // ready: one promise per loading cycle, resolved once the cycle's `loadingdone` went out.
  get_ready(set) {
    const t = setOf(set);
    flushLayout(t);
    if (!t.pending.length && !t.cycleQueued) return t.readyPromise || (t.readyPromise = promiseResolvedWith(set));
    if (!t.readySettle) t.readyPromise = new Promise((resolve) => { t.readySettle = resolve; });
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
// `needFlush` (set when a face is added, and once initially), so a page whose faces have all
// settled pays nothing; the flush itself is a memoised layout when nothing changed.
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
  if (t.needFlush) { t.needFlush = false; flushLayout(t); }
});
