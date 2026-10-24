// The document's style, as this side meets it.
//
// The style engine (stylo, style.rs) cascades and computes every value. What lives here is what it is handed and how
// it is asked:
//   - the sheets that apply — the sheet sets, a `disabled` sheet, a `<link>`'s media, the `@import`s fetched, the
//     constructed and adopted sheets and the shadow trees' own — fed to it (`feedStyleEngine`), and the facts the
//     driver keeps of them (`@font-face` rules, whether a sheet names an image);
//   - its answers (`engineValue`, `styleEngineRendered` …), and the style flush that starts the transitions a change owes;
//   - what is rendered and what is not (`isVisibleNode`, rendered.rs `rendered`), and the rendered text
//     (`styleEngineVisibleText`, rendered.rs `visible_text`);

import { platformMicrotask } from './webidl.js';
import { teachStyleFaces } from './font-metrics.js';
import { NODE_ELEMENT, NODE_PI } from './constants.js';

import { bumpCascadeVersion, currentCascadeVersion, currentTreeGen } from './mutation-observer.js';
import {
  documentBaseUrl, fetchStyleSheetText, forgetFetchedSheets, networkStyleSheetText, ownSchemeSheet, sheetEncodingOf
} from './css-utils.js';
import { resolveURLValue } from './base-url.js';
import {
  maybeVerifyArena, arenaNid, foreignRealmOf, shadowHostsIn, REALM as NATIVE_REALM
} from './native-query-shadow.js';
import { documentElementOf } from './document-tree.js';

// Visibility predicate (rendered.rs `rendered`): false if the element or an ancestor is not rendered — an invisible
// tag, `display: none`, a hidden `<input>`, fallback content — or its `visibility` hides it. Exposed as
// `globalThis.__isVisibleNode` so observers.js's IntersectionObserver
// fast-path can fire without importing — observers loads before the
// cascade state is wired up, so a globalThis getter is the seam.
export function isVisibleNode(el) { return isVisibleNodeImpl(el, false, true); }
// Layout-bounds visibility, for IntersectionObserver. Per spec IO
// doesn't consult `visibility` — `visibility: hidden` elements still
// reserve layout and intersect normally. Discourse's `DLoadMore`
// sentinel is `visibility: hidden` and must still fire its IO to
// drive infinite-scroll fetches.
export function isLaidOutNode(el) { return isVisibleNodeImpl(el, true, false); }
// …and `checkVisibility()`'s base answer: laid out AND not SKIPPED — a closed `<details>`'s content has its boxes
// (Chrome: a rect 17 tall) but is skipped content, and `checkVisibility()` says false there. `visibility` is left to
// its options.
export function isUnskippedNode(el) { return isVisibleNodeImpl(el, true, true); }

// (…an element, the engine's to answer — and keep, for as long as nothing it reads can have moved: rendered.rs
// `Answered`)
function isVisibleNodeImpl(el, ignoreVisibility, honourSkips) {
  return !!el && el._nodeType === NODE_ELEMENT && styleEngineRendered(el, ignoreVisibility, honourSkips);
}
// Whether the style engine renders `el` (rendered.rs `rendered`) — another realm's element asks that realm; a generated
// box is rendered where its element is and its own `display` is not `none`.
export function styleEngineRendered(el, ignoreVisibility, honourSkips) {
  if (el._pseudo) {
    const d = engineValue(el, 'display');
    return d !== undefined && d !== 'none' && isVisibleNodeImpl(el._parent, ignoreVisibility, honourSkips);
  }
  const nid = arenaNid(el);
  if (nid < 0) return !!foreignRealmOf(el)?.styleEngineRendered(el, ignoreVisibility, honourSkips);
  feedStyleEngineSheets();
  return !!globalThis.__dom.rendered(nid, ignoreVisibility, honourSkips);
}
// …whether it is a focusable area (focus.rs `focusable`), which asks whether it is rendered…
export function styleEngineFocusable(el) {
  const nid = arenaNid(el);
  if (nid < 0) return !!foreignRealmOf(el)?.styleEngineFocusable(el);
  feedStyleEngineSheets();
  return !!globalThis.__dom.focusable(nid);
}
// …and where sequential focus navigation goes from `current` in the document `doc` (focus.rs `next`): the element, or
// null where nothing is focusable.
export function sequentialFocusNext(doc, current, reverse) {
  const nid = arenaNid(doc);
  if (nid < 0) return null;
  feedStyleEngineSheets();
  return globalThis.__dom.nextFocus(nid, current ? arenaNid(current) : -1, reverse) ?? null;
}
// …and what focusing a shadow host that delegates focus focuses (focus.rs `focusable_area`), or null…
export function styleEngineFocusableArea(host) {
  const nid = arenaNid(host);
  if (nid < 0) return foreignRealmOf(host)?.styleEngineFocusableArea(host) ?? null;
  feedStyleEngineSheets();
  return globalThis.__dom.focusableArea(nid)[0] ?? null;
}
// …and what focusing an element focuses (focus.rs `focus_target`): a delegating host's focusable area, a label's
// control where it is no focusable area itself, else the element where it is one — null for nothing.
export function styleEngineFocusTarget(el) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineFocusTarget(el) ?? null;
  feedStyleEngineSheets();
  return globalThis.__dom.focusTarget(nid)[0] ?? null;
}
// Whether an element, or an element of its flat-tree ancestry, has an `opacity` of 0 (rendered.rs `transparent`).
export function styleEngineTransparent(el) {
  const nid = arenaNid(el);
  if (nid < 0) return !!foreignRealmOf(el)?.styleEngineTransparent(el);
  feedStyleEngineSheets();
  return !!globalThis.__dom.transparent(nid);
}
// …and what a press on an element focuses (focus.rs `press_target`): the nearest flat-tree inclusive ancestor that is a
// focusable area or a shadow host delegating focus — null for none (the viewport).
export function styleEnginePressFocusTarget(el) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEnginePressFocusTarget(el) ?? null;
  feedStyleEngineSheets();
  return globalThis.__dom.pressFocusTarget(nid)[0] ?? null;
}
// …and what a dialog opening focuses (focus.rs `dialog_focus_control`), the element focused now kept for its closing…
export function styleEngineDialogFocusingSteps(dialog) {
  const nid = arenaNid(dialog);
  if (nid < 0) return foreignRealmOf(dialog)?.styleEngineDialogFocusingSteps(dialog) ?? dialog;
  feedStyleEngineSheets();
  return globalThis.__dom.dialogFocusingSteps(nid)[0] ?? dialog;
}
// …and where a caret at (`node`, `offset`) steps on (back, without `forward`) by a character or a word (caret.rs
// `caret_step` / `caret_word_step`, `op` the one): [node, offset], or undefined where it stays.
export function styleEngineCaretStep(op, node, offset, forward) {
  const nid = arenaNid(node);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  const to = globalThis.__dom[op](nid, offset, forward);
  return to === undefined ? undefined : [to[0][0], to[1]];
}
// …and the first caret position in an element (its last, with `end`) — caret.rs `caret_edge`: [node, offset].
export function styleEngineCaretEdge(root, end) {
  const nid = arenaNid(root);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  const to = globalThis.__dom.caretEdge(nid, end);
  return to === undefined ? undefined : [to[0][0], to[1]];
}
// …and the VISIBLE text of a node (rendered.rs `visible_text`): HTML's rendered text collection, what `innerText` and a
// driver's text read are made of.
export function styleEngineVisibleText(node) {
  const nid = arenaNid(node);
  if (nid < 0) return foreignRealmOf(node)?.styleEngineVisibleText(node) ?? '';
  feedStyleEngineSheets();
  return globalThis.__dom.visibleText(nid) ?? '';
}
// …and its `innerText` (rendered.rs `innerText`): its textContent where it is not being rendered, else its rendered
// text.
export function styleEngineInnerText(node) {
  const nid = arenaNid(node);
  if (nid < 0) return foreignRealmOf(node)?.styleEngineInnerText(node) ?? '';
  feedStyleEngineSheets();
  return globalThis.__dom.innerText(nid) ?? '';
}
// …and what box an element generates by its own computed style (rendered.rs `box_kind`), which says so before anything
// is laid out: `BOX_NONE` none (`display: none` / `contents`, or no style), `BOX_INLINE` a non-replaced inline box,
// `BOX_OTHER` any other.
export const BOX_NONE = 0, BOX_INLINE = 1;
export function styleEngineBoxKind(el) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineBoxKind(el) ?? BOX_NONE;
  feedStyleEngineSheets();
  return globalThis.__dom.boxKind(nid) ?? BOX_NONE;
}
// …and the scroll boxes (scroll_boxes.rs): whether an element keeps a scroll offset — its document's scrolling element,
// or a rendered scroll container — the box whose offset its own is (the viewport's, kept on the root, for the scrolling
// element; none for the root in quirks mode), that scrolling element itself, and the box a mouse event's offset is
// measured from.
export function styleEngineHoldsScrollOffset(el) {
  const nid = arenaNid(el);
  if (nid < 0) return !!foreignRealmOf(el)?.styleEngineHoldsScrollOffset(el);
  feedStyleEngineSheets();
  return globalThis.__dom.holdsScrollOffset(nid, el._ownerDocument?._nid ?? -1);
}
export function styleEngineScrollHolder(el) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineScrollHolder(el) ?? null;
  feedStyleEngineSheets();
  return globalThis.__dom.scrollHolder(nid, el._ownerDocument?._nid ?? -1)[0] ?? null;
}
export function styleEngineScrollingElement(doc) {
  const nid = arenaNid(doc);
  if (nid < 0) return foreignRealmOf(doc)?.styleEngineScrollingElement(doc) ?? null;
  feedStyleEngineSheets();
  return globalThis.__dom.scrollingElement(nid)[0] ?? null;
}
export function styleEnginePaddingEdgeBox(el) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEnginePaddingEdgeBox(el) ?? el;
  feedStyleEngineSheets();
  return globalThis.__dom.paddingEdgeBox(nid)[0] ?? el;
}
globalThis.__isVisibleNode = isVisibleNode;
globalThis.__isLaidOutNode = isLaidOutNode;

// HTML's style sheet sets — which of a document's `<style>` / `<link>` sheets take part in the cascade: a `<style>`
// whose `type` is CSS, a `<link rel=stylesheet>` with an `href` and no `disabled`, neither's sheet disabled (CSSOM), and
// of those the persistent ones, the selected set's, and a `<link>` explicitly enabled; a shadow root's, all of them but
// an alternate `<link>` — the engine's (sheet_owners.rs `sheetSet`), which also keys what that turns on.

// Whether a `<style>` holds a style sheet at all — the engine's (sheet_owners.rs `style_is_css`), which its cascade asks
// too: the `.sheet` getter's and the `load` event's.
export const styleElementIsCss = (el) => globalThis.__dom.styleIsCss(el._nid);

// A sheet owner's attribute — an `<?xml-stylesheet?>`'s pseudo-attribute (`href`, `media`), as a `<link>`'s — or
// undefined.
function ownerAttr(owner, name) {
  return owner._nodeType === NODE_PI ? owner._attributeMap().get(name) : owner._attrs[name];
}

// A shadow `<link>`'s sheet text, fetched once per URL — and `charset`, its environment's encoding — for the page (a
// document's `<link>` is fetched once too; a new page starts over, `resetCascadeState`).
const shadowLinkTexts = new Map();
function shadowLinkText(url, owner) {
  const key = url + '\n' + (owner._attrs.charset ?? '');
  // (A failed fetch is tried again next time, as a document's `<link>` is.)
  if (!shadowLinkTexts.has(key)) {
    const text = urlSheetText(url, null, owner);
    if (text == null) return null;
    shadowLinkTexts.set(key, text);
  }
  return shadowLinkTexts.get(key);
}

// Bumped whenever the resolved cascade actually changes (a real rebuild or a
// per-visit reset). A deferred `<link>` load / @media resize rebuilds the cascade
// — changing display / visibility / text-transform — WITHOUT any DOM mutation, so
// the settle generation is NOT a complete cache key for cascade-dependent reads
// (e.g. the visible texts the engine keeps, rendered.rs `Answered`). Those key on this version too: the realm's rule-set generation (dom.rs
// `GEN_CASCADE`, `currentCascadeVersion`).
// Set by a CSSOM edit (notifyCssomMutation); makes the next getComputedStyle read in the
// SAME task rebuild the cascade synchronously (CSSOM getComputedStyle flushes style),
// while stylesheet LOAD stays deferred. See ensureCascadeFresh.
let cascadeStale = false;
// …read as the version IN FORCE: a pending rebuild (a `<style>` inserted, a CSSOM edit) is taken first, so a memo keyed
// on it never files an answer under the version the change is about to replace.
globalThis.__csimCascadeVersion = () => { ensureCascadeFresh(); return currentCascadeVersion(); };
// Whether the document declares an `@font-face` (font-metrics.js gates the per-run face lookup on this — a page without
// a web font never walks a stylesheet's rules).
globalThis.__csimDocHasFontFace = () => currentFontFaces().length > 0;

// The `@font-face` rules the document's sheets hold that apply (`fontFaceRulesOf`) — asked of the style engine, which
// parsed them (`__dom.styleFontFaces`): inside an `@media` / `@supports` that holds and through an `@import`, in the
// order of their sheets, each by the identity the engine keeps for its rule. Asked once per rule set, when first wanted
// — a CSSOM edit moves it too. (Read off the sheets' TEXT here, they took a Redmine page load 3 ms of regular
// expressions over its stylesheets and a css-tree parse of the one holding its Noto Sans — every load; off their CSSOM,
// building it cost 8.7 ms, jQuery UI's sheet and every other beside the one declaring that face.)
let fontFaces = [], fontFacesAt = null;
function currentFontFaces() {
  feedStyleEngineSheets();
  const version = currentCascadeVersion();
  if (fontFacesAt !== version) {
    fontFacesAt = version;
    fontFaces = engineFontFaces();
  }
  return fontFaces;
}
// (…each the face as the style engine holds it, `{ key, isFace, family, src, identity, referrer, attributes }`: what the
// FontFaceSet makes of its rule — its downloads referred by `referrer`, its sheet's location — dom.rs `styleFontFaces`,
// which keeps what font matching reads of it for the document's face list)
const FACE_ROW = 17;
function engineFontFaces() {
  const flat = globalThis.__dom.styleFontFaces();
  const faces = [];
  for (let i = 0; flat && i + FACE_ROW <= flat.length; i += FACE_ROW) {
    const [key, isFace, family, src, identity, referrer, ...attributes] = flat.slice(i, i + FACE_ROW);
    faces.push({ key, isFace, family, src, identity, referrer, attributes });
  }
  return faces;
}

export function rebuildCascade(doc) {
  // The style engine reads the arena, which mirrors every tree as it changes (the parser's steps included) — so a
  // mid-parse `<script>` reading style is answered from it too. The verify mode checks it here.
  maybeVerifyArena();
  rebuildCascadeImpl(doc);
}

function rebuildCascadeImpl(doc) {
  doc = doc || globalThis.document;
  if (!doc || !documentElementOf(doc)) return;
  // The cascade made of the sheets it was last made of — the engine has them already: none of the redundant
  // per-linked-sheet rebuilds a page graft schedules (a build, then one per linked sheet's deferred load, all of the
  // same sheet sets and viewport). Else the rule-set generation moved, which re-keys every cascade-keyed memo — the
  // engine's to compare and move (sheet_owners.rs `cascadeRekey`), forgotten for a new page (`resetCascadeState`).
  const owners = globalThis.__dom.cascadeRekey(doc._nid);
  if (owners !== null) feedStyleEngine(doc, owners);
}

// The style engine's sheets (stylo, `__dom.styleSheets`): the document's `<style>` / `<link>` sheets and its adopted
// ones, as text with the base URL and the media list each applies under, and whether it is a CONSTRUCTED sheet (whose
// `@import`s are ignored, as `replace()` ignores them) — the engine parses them, evaluates the media, and asks back
// for what their `@import`s name, which is fetched and handed over until nothing is waiting. Which sheets take part
// is the document's to say (disabled, the sheet set: `owners`, `sheetSet`'s).
let styleEngineFedAt = null;
function feedStyleEngine(doc, owners = globalThis.__dom.sheetSet(doc._nid)[2]) {
  styleEngineFedAt = currentCascadeVersion();
  // (…an `<?xml-stylesheet?>`'s fetched as no element's: no `charset` of its own; its adopted sheets after them all, the
  // engine's: dom.rs `AdoptedSheets`)
  const entries = ownerSheetEntries(owners, doc, (abs, owner) => urlSheetText(abs, null, owner._nodeType === NODE_PI ? null : owner));
  globalThis.__dom.styleSheets(doc._nid, documentBaseUrl(), entries);
}
// The style engine's sheets of `owners` — a document's or a shadow root's that take part, in order (`sheetSet`) — each
// one's id: a `<style>`'s of its block, a `<link>`'s or an `<?xml-stylesheet?>`'s of its text as `linkText(url, owner)`
// fetches it; none for one whose URL does not resolve or whose fetch failed.
function ownerSheetEntries(owners, doc, linkText) {
  const entries = [];
  for (const owner of owners) {
    if (owner._tag === 'style') {
      entries.push(ownerSheetId(owner));
      continue;
    }
    const abs = resolveURLValue(owner, ownerAttr(owner, 'href'));
    if (abs === null) continue;
    const css = linkText(abs, owner);
    if (css != null) entries.push(engineSheetOf(owner, css, abs, ownerAttr(owner, 'media') || '', doc).id);
  }
  return entries;
}
// The style engine's sheet of `owner` — a `<style>` / `<link>` / `<?xml-stylesheet?>` — made of `css` (a `<style>`'s, null:
// its block, which the engine reads off the tree) at `base` under `media` in `doc`: ONE per owner, made again where its
// text, base, mode or count of sheets moved and given another media list in place, let go of with its owner — the
// engine's (dom.rs `ownerSheet`, sheet_owners.rs `MadeSheet`) — as `{ id, rev }`, `rev` moving each time it is made
// again. The `@import`s a parse meets are fetched and handed over before it is used. Its CSSStyleSheet is a view of it
// (cssom.js `ownedStyleSheet`).
export function engineSheetOf(owner, css, base, media, doc) {
  const answer = globalThis.__dom.ownerSheet(owner._nid, css, base, media, doc._nid);
  // (…its imports' environment its own encoding: a fetched sheet's as it decoded, a `<style>`'s its document's)
  resolveStyleEngineImports(answer.slice(2), doc._nid, css === null ? null : sheetEncodingOf(base) ?? null);
  return { id: answer[0], rev: answer[1] };
}
// …a `<style>`'s, of its block as it stands.
export function ownerSheet(style) {
  return engineSheetOf(style, null, documentBaseUrl(), style._attrs.media || '', style._ownerDocument || globalThis.document);
}
function ownerSheetId(style) {
  return ownerSheet(style).id;
}

// The sheets the style engine's `@import`s wait for, fetched and handed over until none is. Each URL is fetched once,
// however many sheets import it; an import CYCLE would ask for ever, so a chain deeper than any real page nests is
// answered with nothing.
// (…each decoded in the encoding of the sheet that imports it — `environment` the first ones': CSS Cascade 5 §2.2)
function resolveStyleEngineImports(waiting, docNid, environment = null) {
  const texts = new Map();
  let pending = new Map((waiting || []).map((url) => [url, environment]));
  for (let depth = 0; pending.size; depth++) {
    const next = new Map();
    for (const [url, env] of pending) {
      if (!texts.has(url)) texts.set(url, urlSheetText(url, 'css', null, env));
      for (const child of globalThis.__dom.styleImport(url, depth < IMPORT_DEPTH_LIMIT ? texts.get(url) : null, docNid)) {
        if (!next.has(child)) next.set(child, sheetEncodingOf(url) ?? env);
      }
    }
    pending = next;
  }
}
const IMPORT_DEPTH_LIMIT = 16;
// (…and for a rule `insertRule` put in a sheet, cssom.js, which cannot import this module)
globalThis.__csimResolveSheetImports = resolveStyleEngineImports;

// Each shadow root's own sheets for the style engine (`__dom.styleShadowSheets`): its `<style>` elements in tree order,
// then its adopted sheets. A root is handed them again when the rule set moved (`cascadeVersion`, which a shadow tree's
// sheets move without the document's key seeing it); the document's hosts are asked for again when that or the tree
// moved, which is how a host connected since is found — the engine's to name, shadow trees' own included, in
// shadow-including tree order (`shadowHostsIn`).
let shadowSheetsFedAt = null, shadowSheetsFedTree = null;
// …each root's in a MODULE-LOCAL map, as every realm counts its own `cascadeVersion`: a root adopted with its host into
// a frame's document, its count kept on the root, was one the frame's engine took as fed whenever its count matched.
const SHADOW_SHEETS_FED = new WeakMap();
function feedShadowStyleSheets(doc) {
  const tree = currentTreeGen();
  const version = currentCascadeVersion();
  if (shadowSheetsFedAt === version && shadowSheetsFedTree === tree) return;
  shadowSheetsFedAt = version;
  shadowSheetsFedTree = tree;
  const feed = (host) => {
    const sr = host._shadowRoot;
    if (!sr || !(sr._nid >= 0)) return;
    if (SHADOW_SHEETS_FED.get(sr) !== version) {
      SHADOW_SHEETS_FED.set(sr, version);
      // (…a link's text kept across the roots that link the same sheet: `shadowLinkText`)
      globalThis.__dom.styleShadowSheets(sr._nid, ownerSheetEntries(globalThis.__dom.sheetSet(sr._nid)[2], doc, shadowLinkText));
    }
  };
  for (const host of shadowHostsIn(doc)) feed(host);
}

// Whether this realm has a style engine — `true` in a document realm, where the runtime installs it; a worker has none.
// Defined from the start, so the event loop's read of it every frame is no property miss.
if (globalThis.__csimStylo === undefined) globalThis.__csimStylo = false;

// `el`'s computed value of the longhand `key` (or its pseudo-element `pseudo`'s: `before`, `placeholder`, …) from the
// style engine, or undefined where it has none to give — an element of another realm's document included, whose
// engine is that realm's.
export function styleEngineValue(el, key, pseudo) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineValue(el, key, pseudo);
  feedStyleEngineSheets();
  const value = globalThis.__dom.styleValue(nid, key, pseudo);
  // (…read again once the faces a font metric was computed without are told: `flushStyleEngine`)
  return teachStyleFaces() ? globalThis.__dom.styleValue(nid, key, pseudo) : value;
}

// …and its RESOLVED value, what `getComputedStyle` reports (resolved.rs `resolved_value`): the computed value, or for a
// property whose resolved value is layout's — a size, a margin, an origin, `transform` — the box the layout placed,
// which is laid out first where it is not up to date. A generated box's is its element's pseudo-element's. Undefined
// where there is none.
export function styleEngineResolvedValue(el, key) {
  const origin = el._pseudo ? el._parent : el, pseudo = el._pseudo || null;
  const nid = arenaNid(origin);
  if (nid < 0) return foreignRealmOf(origin)?.styleEngineResolvedValue(el, key);
  feedStyleEngineSheets();
  const value = resolvedValueOf(nid, pseudo, key);
  // (…read again once the faces a font metric was computed without are told: `flushStyleEngine`)
  return teachStyleFaces() ? resolvedValueOf(nid, pseudo, key) : value;
}
function resolvedValueOf(nid, pseudo, key) {
  const value = globalThis.__dom.resolvedValue(nid, pseudo, key, false);
  if (value !== null) return value;
  NATIVE_REALM.ensureLayout();
  return globalThis.__dom.resolvedValue(nid, pseudo, key, true);
}

// …and the custom properties that resolved style lists after its longhands (resolved.rs `custom_property_count` /
// `custom_property_name`): how many — undefined where the engine does not style `el` — and the `index`th's name.
export function styleEngineCustomPropertyCount(el) {
  const origin = el._pseudo ? el._parent : el;
  const nid = arenaNid(origin);
  if (nid < 0) return foreignRealmOf(origin)?.styleEngineCustomPropertyCount(el);
  feedStyleEngineSheets();
  return globalThis.__dom.customPropertyCount(nid, el._pseudo || null);
}
export function styleEngineCustomPropertyName(el, index) {
  const origin = el._pseudo ? el._parent : el;
  const nid = arenaNid(origin);
  if (nid < 0) return foreignRealmOf(origin)?.styleEngineCustomPropertyName(el, index);
  feedStyleEngineSheets();
  return globalThis.__dom.customPropertyName(nid, el._pseudo || null, index);
}

// The style engine's computed value of `key` for `el` — a generated box's being its element's pseudo-element's — or
// undefined where it has none: an element it does not style, which is one in no rendered document (detached, or in a
// document with no browsing context), and so has no style and no box.
export function engineValue(el, key) {
  return el._pseudo ? styleEngineValue(el._parent, key, el._pseudo) : styleEngineValue(el, key);
}



// …each of them asked of the realm whose arena holds `el` where that is another realm's (`foreignRealmOf`): its engine
// is the one that styles it.
Object.assign(NATIVE_REALM, { styleEngineValue, styleEngineResolvedValue, styleEngineCustomPropertyCount, styleEngineCustomPropertyName, styleEngineRendered, styleEngineFocusable,
                              styleEngineVisibleText, styleEngineInnerText, styleEngineBoxKind, styleEngineHoldsScrollOffset, styleEngineFocusableArea, styleEngineFocusTarget,
                              styleEngineDialogFocusingSteps, styleEnginePressFocusTarget, styleEngineTransparent,
                              styleEngineScrollHolder, styleEngineScrollingElement, styleEnginePaddingEdgeBox });

// A style flush (a forced `getComputedStyle` or layout read) in the style engine: the document is styled as it stands,
// which is what starts the transitions a change since the last flush owes.
export function flushStyleEngine() {
  feedStyleEngineSheets();
  const retargeted = globalThis.__dom.styleFlush();
  if (retargeted) RETARGETED(retargeted);
  // …and once more where a font metric (`ex`, `ch`) was computed with a stand-in for a face not resolved yet: the faces
  // are resolved on this side, and telling them restyles what used them.
  if (teachStyleFaces()) {
    const again = globalThis.__dom.styleFlush();
    if (again) RETARGETED(again);
  }
  // (…a transition or animation the flush started needs frames from now on.)
  globalThis.__csimWakeForAnimations();
}

// The rendering update in the style engine: a style flush, and the animation / transition events owed since the last
// update, as `__dom.styleTick` lists them after the elements the flush reports.
export function tickStyleEngine() {
  feedStyleEngineSheets();
  const out = globalThis.__dom.styleTick();
  if (!out) return out;
  const retargeted = out[0];
  if (retargeted) RETARGETED(out.slice(1, 1 + retargeted));
  return out.slice(1 + retargeted);
}

// What is told of the elements whose animations' properties a style flush changed (a CSS animation made or let go):
// registered by the Web Animations bindings, which this module cannot import (they import it).
let RETARGETED = () => {};
export function onStyleEngineRetargeted(fn) {
  RETARGETED = fn;
}

// The engine is asked with the sheets as they stand: a pending sheet edit is taken first, and a rule-set change the
// cascade key does not see (an adopted sheet's list or text) moves the version without a rebuild. (Exported for what
// needs the engine to exist before it asks anything of it: the Web Animations bindings.)
export function feedStyleEngineSheets() {
  const doc = globalThis.document;
  ensureCascadeFresh();
  if (styleEngineFedAt !== currentCascadeVersion() && doc && documentElementOf(doc)) feedStyleEngine(doc);
  if (globalThis.__csimShadowHostCount) feedShadowStyleSheets(doc);
}

// The realm's style engine, made if nothing has asked it anything yet (the first feed makes it); a page it styles
// already is left as it is — the next read feeds what changed.
export function ensureStyleEngine() {
  if (styleEngineFedAt === null) feedStyleEngineSheets();
}

export function resetCascadeState() {
  globalThis.__dom.forgetCascadeKey();   // force the next rebuildCascade to run
  IMPORT_TIMED.clear();     // (…a new page fetches its imports anew)
  shadowLinkTexts.clear();
  forgetFetchedSheets();
  bumpCascadeVersion();
  fontFaces = [];
  fontFacesAt = null;
}
// Called at a layout's ENTRY, before any memo is read: the rule set made known — fed to the style engine — if a sheet
// changed since.
export function settleLayoutInvalidation() {
  ensureCascadeFresh();
}

globalThis.__csimRebuildCascade = function () { rebuildCascade(); };

let cascadeRefreshScheduled = false;
// A connected `<style>` / `<link rel=stylesheet>` inserted, removed, or having its
// text edited changes the resolved cascade WITHOUT any per-element attr mutation —
// so `cascadeVersion` would otherwise stay frozen, the style engine keep the old sheets and the
// kept visible texts serve stale visibility. The mutation path
// (a change's record and a `<style>`'s text written, the engine's flags that
// engineWritten takes) calls this when a stylesheet node is involved. rebuildCascade does nothing
// for a cascade made of the sheets it was last made of (`cascadeRekey`) and bumps cascadeVersion ONLY when the rules
// actually change, so a spurious schedule is
// cheap and the memos invalidate exactly when needed. Microtask-coalesced (mirrors
// the deferred <link>-load rebuild at maybeFireLinkLoad); a read in the SAME task
// as the insertion still sees the prior cascade, consistent with the existing
// async-stylesheet model.
export function scheduleCascadeRefresh() {
  // Mark the cascade stale so the NEXT getComputedStyle / visibility read in this same task
  // rebuilds synchronously (ensureCascadeFresh) — a `<style>`/`<link>` inserted or removed, or
  // a connected `<style>`'s text edited, must be reflected before a synchronous style read,
  // not only after the deferred microtask. rebuildCascade early-returns on an unchanged content
  // key, so a spurious mark is cheap.
  cascadeStale = true;
  if (cascadeRefreshScheduled) return;
  cascadeRefreshScheduled = true;
  platformMicrotask(() => {
    cascadeRefreshScheduled = false;
    cascadeStale = false;               // …this IS the rebuild the mark asked for
    try { rebuildCascade(globalThis.document); } catch (_) {}
  });
}
// …asked of this realm by whichever realm's code changed its tree (mutation-observer.js `engineWritten`): its cascade
// refreshed, or — a shadow tree's sheet — its version moved.
NATIVE_REALM.refreshCascade = (version) => {
  if (version) bumpCascadeVersion();
  else scheduleCascadeRefresh();
};
// A CSSOM mutation (cssom.js: replaceSync / insertRule / deleteRule on a constructed
// sheet) may affect a document-adopted sheet OR a shadow-root-adopted one — as may a
// shadow root's `adoptedStyleSheets` list itself changing. The former is picked up by
// the deferred document rebuild (its key re-fingerprints the document's adopted sheets, the engine's); the
// latter is handed to the engine per shadow root, keyed on `cascadeVersion`
// (`feedShadowStyleSheets`), and is NOT in the document key — so the version moves here.
// …and the cascade stale, no more: the next style or layout read rebuilds it (`ensureCascadeFresh`).
export function markCascadeStale() {
  cascadeStale = true;
}
export function notifyCssomMutation() {
  bumpCascadeVersion();
  cascadeStale = true;
  scheduleCascadeRefresh();
}

// Reflect a pending CSSOM edit before a cascade read in the same task. Only fires when
// cascadeStale is set (a CSSOM edit happened) — a read between edits pays nothing, and
// rebuildCascade early-returns when the content key is unchanged.
function ensureCascadeFresh() {
  if (!cascadeStale) return;
  cascadeStale = false;
  try { rebuildCascade(globalThis.document); } catch (_) {}
}
// Global hook so cssom.js can signal a mutation without importing cascade (avoiding a
// module cycle). rebuildCascade early-returns on an unchanged content key, so the
// document rebuild for a sheet not in the document cascade is cheap.
globalThis.__csimScheduleCascadeRefresh = notifyCssomMutation;


// The `@font-face` rules that apply to `doc`, in stylesheet order, each the face as the style engine holds it (its
// sources' URLs resolved against the sheet each was written in) by the identity the engine keeps for its rule
// (`engineFontFaces`): the sheets the cascade takes — a `<style media>` / `<link media>` that matches, no `disabled` sheet, alternate
// sets by the selected set, the adopted sheets — and inside them `@media` / `@supports` blocks that hold and `@import`s
// (`currentFontFaces`). The realm's document's alone: another document of the realm's (`createHTMLDocument`, a
// DOMParser's) is styled by no engine, and so declares none (Firefox; Chrome lists the realm document's there). Read by
// font-metrics.js and the FontFaceSet; memoised there per cascade version.
export function fontFaceRulesOf(doc) {
  if (!doc || doc !== globalThis.document || !documentElementOf(doc)) return [];
  return currentFontFaces();
}
globalThis.__csimFontFaceRules = fontFaceRulesOf;
// The text of the sheet at `url` — null when it could not be fetched, or a controlling service worker blocked it or
// answered with no body. (css-utils' `fetchStyleSheetText` fetches the same way; this one also records the Resource
// Timing entry of a fetch that is the NETWORK's — a service worker's answer records none — so it is its own.)
const IMPORT_TIMED = new Set();
// (…`owner` its `<link>`, `environment` the encoding of the sheet importing it: css-utils.js `fetchStyleSheetText`)
function urlSheetText(url, initiator = null, owner = null, environment = null) {
  let body = null;
  const timingStart = initiator ? globalThis.__csimPerformanceNow() : 0;
  try {
    if (ownSchemeSheet(url)) {
      body = fetchStyleSheetText(url, owner, environment);
    } else {
      // A controlling service worker answers first (destination 'style'; memoized
      // per URL in bridge.entry so the load-event/.sheet consumers share the SAME
      // dispatch + body). blocked / bodyless → the sheet contributes nothing
      // (NOT cached, like a failed fetch — the memo already pins the verdict).
      const sw = (typeof globalThis.__csimSwFetchStyle === 'function') ? globalThis.__csimSwFetchStyle(url) : null;
      if (sw) return sw.blocked ? null : sw.body;
      body = networkStyleSheetText(url, owner, environment);
    }
  } catch (_) {}
  // (…an `@import` once: the style engine asks for the sheet on every rebuild that feeds it — it is ONE fetch to the
  // page, as the memory cache makes it in a browser)
  if (initiator === 'css') {
    if (IMPORT_TIMED.has(url)) initiator = null;
    else IMPORT_TIMED.add(url);
  }
  if (initiator && typeof globalThis.__csimRecordResource === 'function') {
    const fields = typeof globalThis.__csimAssetTimingFields === 'function' ? globalThis.__csimAssetTimingFields(url, body)
                                                                            : { body: body != null ? body : undefined, status: body != null ? 200 : undefined };
    globalThis.__csimRecordResource({ name: url, initiatorType: initiator, startTime: timingStart, ...fields });
  }
  return body;
}




// The computed `visibility`, which the engine inherits through the FLAT tree (a slotted span under a hidden shadow box)
// — `visible` where it does not style the element.
export function computedVisibility(el) { return engineValue(el, 'visibility') ?? 'visible'; }
export function visibilityHidden(el) { const v = computedVisibility(el); return v === 'hidden' || v === 'collapse'; }
// Diagnostic: the rule-set generation LAYOUT keys its gate on (walk_ops.rs `layoutDue`), so a spec can assert that
// dynamic state does (or does not) reach layout — a geometry read can't distinguish "gate held" from "recomputed equal".
// What a dynamic state flip reaches — `#t:placeholder-shown { width: 300px }` once the field is filled — the style
// engine marks as it restyles (layout.js `markRestyles`), which moves no rule set: keyed on the state as well, every
// keystroke relaid out the document.
globalThis.__csimLayoutEpoch = globalThis.__csimCascadeVersion;

// The memos an element gains once it is STYLED, declared together, in one order, on its first style read (here, and in
// style-proxy.js `pseudoNodeFor`, which writes one before any read): added as each was first written, in whatever order
// a page's reads took, they split one tag's elements across several hidden classes (130 maps for the 369 elements of a
// Redmine issue page, 88 declared), a page load 5% slower. Declared in the Element constructor instead, every element
// paid for them — a detached, parsed or template one never styled: createElement 75% slower, ~550 bytes each.
// `undefined` is the absent memo each reader already tests for.
export function declareStyledMemos(el) {
  el._styled = true;
  el._pseudoNodes = undefined;                                              // ::before / ::after holders (style-proxy.js)
}


