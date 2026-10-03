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
//   - the generations the memos on this side key on (`cascadeGeneration`, `cascadeLayoutEpoch` …).

import { teachStyleFaces } from './font-metrics.js';
import { NODE_ELEMENT, HTML_NS, SVG_NS } from './constants.js';

import { walk, walkSubtree, scriptText } from './walk.js';
import { bumpStyleState, currentStyleStateGen, currentDirtySeq, currentTreeGen } from './mutation-observer.js';
import { mediaMatches, currentViewport } from './media-query.js';
import { asciiLower, asciiTokens } from './ascii.js';
import { decodeDataUrlCss, networkStyleSheetText, documentBaseUrl } from './css-utils.js';
import { isHtmlDocument } from './mime.js';
import { maybeVerifyArena, arenaNid, foreignRealmOf, REALM as NATIVE_REALM } from './native-query-shadow.js';
import { declaredValue, fontRelativeToPx } from './style-proxy.js';
import { hasMathFunction, reduceMathFunctions, absoluteToPx } from './calc.js';

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

// …memoised per element for as long as nothing it reads can have moved: the cascade generation (a mutation, the rule
// set, a dynamic state), the parser's tree generation and the layout dirty sequence. Every used-value `getComputedStyle`
// read and every geometry read asks it.
function isVisibleNodeImpl(el, ignoreVisibility, honourSkips) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  // (…an element this realm's document owns: another realm counts its generations from 0 too)
  if (!ownedByThisRealm(el)) return styleEngineRendered(el, ignoreVisibility, honourSkips);
  const gen = cascadeGeneration(), tree = currentTreeGen(), dirty = currentDirtySeq();
  let m = el._visMemo;
  if (m === undefined || m.gen !== gen || m.tree !== tree || m.dirty !== dirty) {
    if (el._styled === false) declareStyledMemos(el);
    m = el._visMemo = { gen, tree, dirty, v: [undefined, undefined, undefined, undefined] };
  }
  const i = (ignoreVisibility ? 1 : 0) | (honourSkips ? 2 : 0);
  let v = m.v[i];
  if (v === undefined) v = m.v[i] = styleEngineRendered(el, ignoreVisibility, honourSkips);
  return v;
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
  return !!globalThis.__dom.rendered(nid, ignoreVisibility, honourSkips, styleEngineNow());
}
// …and the VISIBLE text of a node (rendered.rs `visible_text`): HTML's rendered text collection, what `innerText` and a
// driver's text read are made of.
export function styleEngineVisibleText(node) {
  const nid = arenaNid(node);
  if (nid < 0) return foreignRealmOf(node)?.styleEngineVisibleText(node) ?? '';
  feedStyleEngineSheets();
  return globalThis.__dom.visibleText(nid, styleEngineNow()) ?? '';
}
globalThis.__isVisibleNode = isVisibleNode;
globalThis.__isLaidOutNode = isLaidOutNode;

// HTML alternate / preferred stylesheet SET selection.
//
// A `<link rel="stylesheet">` / `<style>` with a non-empty `title` belongs to a
// named set; a `<link rel="alternate stylesheet">` is an ALTERNATE sheet,
// disabled by default. The active set is the "selected stylesheet set": the
// content of the last `<meta http-equiv="default-style">` (HTML "default style
// sheet set"), else the PREFERRED set — the title of the first non-alternate
// titled sheet. A sheet contributes to the cascade iff it's a persistent sheet
// (no title, not alternate) OR its title matches the selected set. A titleless
// alternate sheet is permanently disabled.
//
// The common page (only titleless non-alternate sheets) is unaffected — those
// are always enabled and the selected-set machinery is never consulted.

// Does this element select a stylesheet set? `<meta http-equiv=default-style>`.
export function isDefaultStyleMeta(el) {
  return el._tag === 'meta' && (el._attrs['http-equiv'] || '').toLowerCase() === 'default-style';
}

// Content of the last `<meta http-equiv=default-style>` with a non-empty content
// (document order, last wins), or null if none — the "default style sheet set".
function metaDefaultStyleSet(doc) {
  let sel = null;
  for (const m of doc.documentElement.getElementsByTagName('meta')) {
    if (isDefaultStyleMeta(m)) { const c = m._attrs.content; if (c) sel = c; }
  }
  return sel;
}

// Is a sheet with this title / alternate-ness enabled under `selectedSet`?
function sheetSetEnabled(title, alternate, selectedSet) {
  if (title === '') return !alternate;       // persistent (non-alt) on; titleless alternate permanently off
  return title === selectedSet;              // titled: on only when its set is selected
}

// Does a `<link rel=stylesheet>` contribute rules to the cascade? A `<link disabled>`
// never does (HTML disabled attribute). Otherwise its stylesheet-set membership decides,
// EXCEPT that an "explicitly enabled" link (the `disabled` attribute was removed at runtime)
// applies unconditionally — overriding the alternate-default-off — per the HTMLLinkElement.disabled
// model. Non-links (`<style>`) never carry this flag, so their gating stays `sheetSetEnabled`.
function linkSheetEnabled(l, title, alternate, selectedSet) {
  if (l._attrs.disabled != null) return false;
  if (l._explicitlyEnabled) return true;
  return sheetSetEnabled(title, alternate, selectedSet);
}

// Is the sheet this `<style>` / `<link>` owns DISABLED? `disabled` is a CSSOM flag on the SHEET,
// not a content attribute — `document.styleSheets[0].disabled = true` and `styleEl.disabled = true`
// (which HTMLStyleElement reflects onto its sheet) both set it with nothing in the DOM to see. It
// was invisible to the cascade key AND to the rule collection, so a disabled sheet kept applying.
// `<link disabled>` also has the attribute form, which the callers check separately; this covers
// the sheet-object route both elements share.
function sheetDisabled(el) {
  const sheet = el._sheet;
  return !!(sheet && sheet.disabled);
}
// Whether a `<style>` holds a style sheet at all. HTML's "update a style block" makes one only when the element's `type`
// is absent, empty or an ASCII case-insensitive `text/css`, and runs again when `type` changes — Chrome and Firefox both
// drop the sheet's rules on a switch to `text/plain`. The `.sheet` getter and the `load` event asked this; the cascade
// did not, so a `<style type="text/plain">` applied its rules from the start.
export function styleElementIsCss(el) {
  const type = el._attrs.type;
  return type == null || type === '' || type.toLowerCase() === 'text/css';
}


// The cascade identity key AND the resolved selected stylesheet set, computed in
// one pass. The selected set is folded INTO the key (not just the default-style
// meta) because the resolved set — preferred = first non-alternate titled sheet,
// overridden by the default-style meta — decides which titled / alternate sheets
// contribute. Keying only the meta would let two sheet sets that enable different
// sheets but carry no meta look unchanged to a rebuild. The whole machinery is gated
// on `anyTitledOrAlt`: the common page (only titleless non-alternate sheets) adds
// nothing to the key and never pays the `<meta>` scan.
// A shadow `<link>`'s sheet text, fetched once per URL for the page (a document's `<link>` is fetched once too; a new
// page starts over, `resetCascadeState`).
const shadowLinkTexts = new Map();
function shadowLinkText(url) {
  // (A failed fetch is tried again next time, as a document's `<link>` is.)
  if (!shadowLinkTexts.has(url)) {
    const text = urlSheetText(url);
    if (text == null) return null;
    shadowLinkTexts.set(url, text);
  }
  return shadowLinkTexts.get(url);
}

// A shadow tree's `<link>`'s sheet URL, absolute — null for a link that is no enabled style sheet link.
function shadowLinkSheetUrl(l, base) {
  const rel = asciiTokens(asciiLower(l._attrs.rel || ''));
  if (!rel.includes('stylesheet') || rel.includes('alternate')) return null;
  const href = l._attrs.href;
  if (!href) return null;
  try { return new URL(href, base).href; } catch (_) { return null; }
}

// A document's (or a shadow root's) `<style>` and `<link>` elements in TREE order — the order their sheets cascade
// in, whichever kind each is (a `<style>` after a `<link>` wins over it). Walked over the tree itself, which a page
// cannot tamper with (a shadow root has no `getElementsByTagName` in any browser, and `compareDocumentPosition` is
// page-overridable), and kept per root until the tree changes.
const SHEET_OWNERS = new WeakMap();
// An HTML or SVG `<style>`, or an HTML `<link>` — by local name and namespace, as `getElementsByTagName` would not
// tell an SVG `STYLE` (no style element) from one.
function isSheetOwner(el) {
  const name = el._localName;
  if (name === 'style') return el._ns === HTML_NS || el._ns === SVG_NS;
  return name === 'link' && el._ns === HTML_NS;
}
function styleSheetOwners(root) {
  const tree = currentTreeGen();
  const kept = SHEET_OWNERS.get(root);
  if (kept !== undefined && kept.tree === tree) return kept.owners;
  const owners = [];
  walk(root, (el) => { if (isSheetOwner(el)) owners.push(el); });
  SHEET_OWNERS.set(root, { tree, owners });
  return owners;
}

function cascadeCacheKey(doc, vp) {
  const root = doc.documentElement;
  // …and the document's MODE, which the engine matches class and id selectors in.
  let acc = 'vp:' + vp.width + 'x' + vp.height + (doc._quirks ? ':q' : '');
  let anyTitledOrAlt = false, preferred = '';
  // getElementsByTagName (HTMLCollection), NOT querySelectorAll (a static
  // NodeList) — the cascade rebuild runs mid-parse under streaming, where a
  // parse-time script may have tampered NodeList.prototype.length (which a static
  // NodeList's length reads through); iterating one would then yield undefined
  // and throw. Parity with rebuildCascade's own style/link scan below.
  for (const owner of styleSheetOwners(root)) {
    if (owner._tag === 'style') {
      const s = owner;
      if (!styleElementIsCss(s) || sheetDisabled(s)) continue;      // contributes nothing; re-enabling re-keys and rebuilds
      const media = s._attrs.media; if (media && !mediaMatches(media, vp)) continue;
      const title = (s._attrs.title || '').trim();
      if (title) { anyTitledOrAlt = true; if (!preferred) preferred = title; }
      // (…keyed on its engine sheet and each time that was made again — of new text, or of a block updated to the same
      // text — an empty one included: a rule CSSOM inserts in it is the engine's only once the engine has the sheet)
      const sheet = ownerSheet(s);
      acc += '\nS:' + sheet.id + ':' + sheet.rev + (title ? '|t:' + title : '');
      continue;
    }
    const l = owner;
    const tokens = asciiTokens(asciiLower(l._attrs.rel || '')); if (!tokens.includes('stylesheet')) continue;
    const href = l._attrs.href; if (!href) continue;
    // A `<link disabled>` contributes no rules and isn't a set member — keep it out of the key
    // entirely, so enabling it (attribute removed → this link re-enters the key) re-keys + rebuilds.
    if (l._attrs.disabled != null || sheetDisabled(l)) continue;
    const media = l._attrs.media; if (media && !mediaMatches(media, vp)) continue;
    const title = (l._attrs.title || '').trim();
    const alternate = tokens.includes('alternate');
    if (title || alternate) anyTitledOrAlt = true;
    if (title && !alternate && !preferred) preferred = title;
    // `|ee` (explicitly enabled) distinguishes an applied alternate from an inert one — same
    // href/title/alt, different cascade — so toggling `disabled` on an alternate re-keys.
    acc += '\nL:' + href + (title ? '|t:' + title : '') + (alternate ? '|alt' : '') + (l._explicitlyEnabled ? '|ee' : '');
  }
  // `document.adoptedStyleSheets` contribute to the cascade; key on each sheet — and on each time it was made of new
  // text (`replaceSync`), which makes it another sheet to the engine — so reassigning or replacing them re-keys and
  // rebuilds. (A CSSOM edit of one is the engine's as it is made.) A disabled sheet, or one whose media doesn't match,
  // contributes no rules — keyed as `A:off` so toggling `disabled` / a media change still re-keys and rebuilds.
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    acc += adoptedSheetActive(sheet, vp) ? '\nA:' + sheet._id + ':' + sheet._replaced : '\nA:off';
  }
  // Only resolve the selected set (and scan `<meta>`) when a titled / alternate
  // sheet exists — otherwise it can't affect the cascade.
  let selectedSet = '';
  if (anyTitledOrAlt) {
    const ds = metaDefaultStyleSet(doc);
    selectedSet = ds != null ? ds : preferred;
    acc += '\nSS:' + selectedSet;
  }
  return { key: acc, selectedSet };
}

// Key of the most-recent build. A page graft fires rebuildCascade once (the main
// build) AND once per linked sheet's deferred load microtask — but those all see
// the SAME (sheet-set, viewport), so after the main build they're redundant. The
// gate below short-circuits them on an unchanged key, skipping even the cache
// round-trip. Reset by resetCascadeState so the next document always rebuilds.
let lastCascadeKey = null;
// Bumped whenever the resolved cascade actually changes (a real rebuild or a
// per-visit reset). A deferred `<link>` load / @media resize rebuilds the cascade
// — changing display / visibility / text-transform — WITHOUT any DOM mutation, so
// the settle generation is NOT a complete cache key for cascade-dependent reads
// (e.g. `__csimVisibleText`'s memo). Those key on this version too.
let cascadeVersion = 0;
// Set by a CSSOM edit (notifyCssomMutation); makes the next getComputedStyle read in the
// SAME task rebuild the cascade synchronously (CSSOM getComputedStyle flushes style),
// while stylesheet LOAD stays deferred. See ensureCascadeFresh.
let cascadeStale = false;
// …read as the version IN FORCE: a pending rebuild (a `<style>` inserted, a CSSOM edit) is taken first, so a memo keyed
// on it never files an answer under the version the change is about to replace.
globalThis.__csimCascadeVersion = () => { ensureCascadeFresh(); return cascadeVersion; };
// Whether the document declares an `@font-face` (font-metrics.js gates the per-run face lookup on this — a page without
// a web font never walks a stylesheet's rules).
globalThis.__csimDocHasFontFace = () => currentSheetFacts().hasFontFace;
// Whether the document sets a `background(-image)` / `cursor` / `list-style(-image)` to a url() —
// the O(1) gate for the rendering-update fetch of those CSS-embedded images (layout.js).
globalThis.__csimDocHasCssImage = () => currentSheetFacts().hasCssImage;

// What the document's sheets hold besides their rules — whether any declares an `@font-face` and whether any sets a
// CSS-embedded image (the two gates above), and each sheet owner's faces (`fontFaceRulesOf`) — asked of the style
// engine, which parsed them (`__dom.styleSheetFacts`): the faces that apply, inside an `@media` / `@supports` that holds
// and through an `@import`, each by the `<style>` / `<link>` (or adopted sheet) it came from. Asked once per rule set,
// when first wanted. (Read off the sheets' TEXT here, they took a Redmine page load 3 ms of regular expressions over its
// stylesheets and a css-tree parse of the one holding its Noto Sans — every load.) A realm with no engine — the
// snapshot's warm-up — has no faces and no images to speak of.
const NO_SHEET_FACTS = { hasFontFace: false, hasCssImage: false, ownerFaces: new Map() };
let sheetFacts = NO_SHEET_FACTS, sheetFactsOwed = false;
function currentSheetFacts() {
  ensureCascadeFresh();
  if (sheetFactsOwed) {
    sheetFactsOwed = false;
    sheetFacts = engineSheetFacts();
  }
  return sheetFacts;
}
function engineSheetFacts() {
  const flat = globalThis.__dom && globalThis.__dom.styleSheetFacts();
  if (!flat) return NO_SHEET_FACTS;
  const ownerFaces = new Map();
  for (let i = 1; i + 1 < flat.length; i += 2) {
    const owner = styleEngineOwners[flat[i]];
    if (owner === undefined) continue;
    let faces = ownerFaces.get(owner);
    if (faces === undefined) ownerFaces.set(owner, faces = []);
    faces.push(new EngineFontFace(flat[i + 1]));
    // (…a CONTROLLED document fetches each face's source through its service worker, as the JS model's collection did:
    // destination 'font', the response discarded — the fetch is the observable)
    const src = FACE_SRC_URL_RE.exec(flat[i + 1]);
    if (src) swFetchFontSrcs([src[2]], null);
  }
  return { hasFontFace: ownerFaces.size > 0, hasCssImage: flat[0] === true, ownerFaces };
}

export function rebuildCascade(doc) {
  // The style engine reads the arena, which mirrors every tree as it changes (the parser's steps included) — so a
  // mid-parse `<script>` reading style is answered from it too. The verify mode checks it here.
  maybeVerifyArena();
  rebuildCascadeImpl(doc);
}

function rebuildCascadeImpl(doc) {
  doc = doc || globalThis.document;
  if (!doc || !doc.documentElement) return;
  const vp  = currentViewport();
  const { key, selectedSet } = cascadeCacheKey(doc, vp);
  // Sheets + viewport unchanged since the last build → the engine has them already. Skips the redundant
  // per-linked-sheet rebuilds a page graft schedules.
  if (key === lastCascadeKey) return;
  lastCascadeKey = key;
  cascadeVersion = (cascadeVersion + 1) | 0;   // cascade actually changing → invalidate cascade-keyed memos
  feedStyleEngine(doc, selectedSet);
}

// The style engine's sheets (stylo, `__dom.styleSheets`): the document's `<style>` / `<link>` sheets and its adopted
// ones, as text with the base URL and the media list each applies under, and whether it is a CONSTRUCTED sheet (whose
// `@import`s are ignored, as `replace()` ignores them) — the engine parses them, evaluates the media, and asks back
// for what their `@import`s name, which is fetched and handed over until nothing is waiting. Which sheets take part
// is the document's to say (disabled, the sheet set), so that is decided here.
// …each sheet's owner kept in its place (`styleEngineOwners`): the `<style>` / `<link>`, or the adopted sheet, the
// engine's facts name a sheet by (`engineSheetFacts`).
let styleEngineFedAt = null;
let styleEngineOwners = [];
function feedStyleEngine(doc, selectedSet = cascadeCacheKey(doc, currentViewport()).selectedSet) {
  styleEngineFedAt = cascadeVersion;
  const vp = currentViewport();
  const docBase = documentBaseUrl();
  const entries = [];
  const owners = [];
  for (const owner of styleSheetOwners(doc.documentElement)) {
    if (owner._tag === 'style') {
      const s = owner;
      if (!styleElementIsCss(s) || sheetDisabled(s)) continue;
      if (!sheetSetEnabled((s._attrs.title || '').trim(), false, selectedSet)) continue;
      entries.push(ownerSheetId(s));
      owners.push(s);
      continue;
    }
    const l = owner;
    const tokens = asciiTokens(asciiLower(l._attrs.rel || ''));
    const href = l._attrs.href;
    if (!tokens.includes('stylesheet') || !href || sheetDisabled(l)) continue;
    if (!linkSheetEnabled(l, (l._attrs.title || '').trim(), tokens.includes('alternate'), selectedSet)) continue;
    let abs; try { abs = new URL(href, docBase).href; } catch (_) { continue; }
    const css = urlSheetText(abs);
    if (css != null) { entries.push(engineSheetOf(l, css, abs, l._attrs.media || '', doc, l._sheetGen | 0).id); owners.push(l); }
  }
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    if (!adoptedSheetActive(sheet, vp)) continue;
    entries.push(sheet._id);
    owners.push(sheet);
  }
  globalThis.__dom.styleSheets(doc._nid, docBase, !!doc._quirks, !isHtmlDocument(doc), vp.width, vp.height, entries);
  styleEngineOwners = owners;
  sheetFactsOwed = true;
}
// The style engine's sheet of `owner` — a `<style>` / `<link>` / `<?xml-stylesheet?>` — made of `css` at `base` under
// `media` in `doc`: ONE per owner (`__dom.sheetMake`), made again of other text, or of the same text in a block updated
// since (`gen`, HTML's "update a style block": a new sheet), at another base or in another mode (`sheetReplace`), and
// given another media list in place (`sheetMedia`, its rules kept); let go of with its owner. The `@import`s a parse
// meets are fetched and handed over before it is used. Its CSSStyleSheet is a view of it (cssom.js `ownedStyleSheet`).
const ENGINE_SHEETS = new WeakMap();
// (…the sheet an owner last had is let go of with the owner, unless a CSSStyleSheet still shows it: then with that)
const ENGINE_SHEET_DROPS = new FinalizationRegistry((made) => { if (globalThis.__dom && !made.shown) globalThis.__dom.sheetDrop(made.id); });
// …as the record of it: its `id`, and `rev`, which moves each time it is made again. A sheet made again that a
// CSSStyleSheet shows (`shown`, dom-nodes.js `_sheetOf`) is made anew under another id, so the object a script still
// holds keeps the rules it had; one nothing shows is made again in place.
export function engineSheetOf(owner, css, base, media, doc, gen) {
  const quirks = !!doc._quirks;
  let made = ENGINE_SHEETS.get(owner);
  if (made && made.css === css && made.base === base && made.quirks === quirks && made.gen === gen) {
    if (made.media !== media) { made.media = media; globalThis.__dom.sheetMedia(made.id, media, quirks); }
    return made;
  }
  let waiting;
  if (made && !made.shown) {
    waiting = globalThis.__dom.sheetReplace(made.id, css, base, media, false, quirks);
    made.rev++;
  } else {
    const answer = globalThis.__dom.sheetMake(css, base, media, false, quirks);
    waiting = answer.slice(1);
    if (made) {
      Object.assign(made, { id: answer[0], shown: false });
      made.rev++;
    } else {
      made = { id: answer[0], rev: 0, shown: false };
      ENGINE_SHEETS.set(owner, made);
      ENGINE_SHEET_DROPS.register(owner, made);
    }
  }
  Object.assign(made, { css, base, media, quirks, gen });
  resolveStyleEngineImports(waiting, quirks);
  return made;
}
// …a `<style>`'s, of its block as it stands.
export function ownerSheet(style) {
  return engineSheetOf(style, scriptText(style), documentBaseUrl(), style._attrs.media || '', style.ownerDocument || globalThis.document, style._sheetGen | 0);
}
function ownerSheetId(style) {
  return ownerSheet(style).id;
}

// The sheets the style engine's `@import`s wait for, fetched and handed over until none is. Each URL is fetched once,
// however many sheets import it; an import CYCLE would ask for ever, so a chain deeper than any real page nests is
// answered with nothing.
function resolveStyleEngineImports(waiting, quirks) {
  const texts = new Map();
  for (let depth = 0; waiting && waiting.length; depth++) {
    const next = [];
    for (const url of new Set(waiting)) {
      if (!texts.has(url)) texts.set(url, urlSheetText(url, 'css'));
      next.push(...globalThis.__dom.styleImport(url, depth < IMPORT_DEPTH_LIMIT ? texts.get(url) : null, quirks));
    }
    waiting = next;
  }
}
const IMPORT_DEPTH_LIMIT = 16;
// (…and for a rule `insertRule` put in a sheet, cssom.js, which cannot import this module)
globalThis.__csimResolveSheetImports = resolveStyleEngineImports;

// Each shadow root's own sheets for the style engine (`__dom.styleShadowSheets`): its `<style>` elements in tree order,
// then its adopted sheets. A root is handed them again when the rule set moved (`cascadeVersion`, which a shadow tree's
// sheets move without the document's key seeing it); the document is walked for roots again when that or the tree
// moved, which is how a host connected since is found. Shadow roots nested in shadow trees are reached through their
// hosts, as a walk of the document does not enter a shadow tree.
let shadowSheetsFedAt = null, shadowSheetsFedTree = null;
// …each root's in a MODULE-LOCAL map, as every realm counts its own `cascadeVersion`: a root adopted with its host into
// a frame's document, its count kept on the root, was one the frame's engine took as fed whenever its count matched.
const SHADOW_SHEETS_FED = new WeakMap();
function feedShadowStyleSheets(doc) {
  const tree = currentTreeGen();
  if (shadowSheetsFedAt === cascadeVersion && shadowSheetsFedTree === tree) return;
  shadowSheetsFedAt = cascadeVersion;
  shadowSheetsFedTree = tree;
  const vp = currentViewport();
  const docBase = documentBaseUrl();
  const feed = (host) => {
    const sr = host._shadowRoot;
    if (!sr || !(sr._nid >= 0)) return;
    if (SHADOW_SHEETS_FED.get(sr) !== cascadeVersion) {
      SHADOW_SHEETS_FED.set(sr, cascadeVersion);
      const entries = [];
      for (const owner of styleSheetOwners(sr)) {
        if (sheetDisabled(owner)) continue;
        if (owner._tag === 'style') {
          if (styleElementIsCss(owner)) entries.push(ownerSheetId(owner));
        } else {
          const abs = shadowLinkSheetUrl(owner, docBase);
          const css = abs && shadowLinkText(abs);
          if (css != null && abs) entries.push(engineSheetOf(owner, css, abs, owner._attrs.media || '', doc, owner._sheetGen | 0).id);
        }
      }
      const adopted = sr.adoptedStyleSheets;
      if (adopted) for (const sheet of adopted) {
        if (adoptedSheetActive(sheet, vp)) entries.push(sheet._id);
      }
      globalThis.__dom.styleShadowSheets(sr._nid, entries);
    }
    walk(sr, feed);
  };
  walk(doc, feed);
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
  const value = globalThis.__dom.styleValue(nid, key, pseudo, styleEngineNow());
  // (…read again once the faces a font metric was computed without are told: `flushStyleEngine`)
  return teachStyleFaces() ? globalThis.__dom.styleValue(nid, key, pseudo, styleEngineNow()) : value;
}

// The style engine's computed value of `key` for `el` — a generated box's being its element's pseudo-element's — or
// undefined where it has none: an element it does not style, which is one in no rendered document (detached, or in a
// document with no browsing context), and so has no style and no box.
export function engineValue(el, key) {
  return el._pseudo ? styleEngineValue(el._parent, key, el._pseudo) : styleEngineValue(el, key);
}


// …and its `transform` as the 4x4 the engine composes (`__dom.styleTransformMatrix`), about a `width` x `height`
// reference box: null for `none`, undefined where it has no node or no style there.
export function styleEngineTransformMatrix(el, width, height) {
  if (el._pseudo) return undefined;
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineTransformMatrix(el, width, height);
  feedStyleEngineSheets();
  const m = globalThis.__dom.styleTransformMatrix(nid, width, height, styleEngineNow());
  return m === null || m === undefined ? m : Array.from(m);
}

// What `el`'s `::before` / `::after` renders as the style engine styled it (`__dom.styleGenerated`, what its walk lays
// out): its text, or null where it generates no box — undefined where `el` has no node in the engine's arena.
export function styleEngineGenerated(el, which) {
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineGenerated(el, which);
  feedStyleEngineSheets();
  return globalThis.__dom.styleGenerated(nid, which === 'before' ? 0 : 1, styleEngineNow());
}
// …each of them asked of the realm whose arena holds `el` where that is another realm's (`foreignRealmOf`): its engine
// is the one that styles it.
Object.assign(NATIVE_REALM, { styleEngineValue, styleEngineTransformMatrix, styleEngineGenerated, styleEngineRendered,
                              styleEngineVisibleText });

// A style flush (a forced `getComputedStyle` or layout read) in the style engine: the document is styled as it stands,
// which is what starts the transitions a change since the last flush owes.
export function flushStyleEngine() {
  feedStyleEngineSheets();
  const retargeted = globalThis.__dom.styleFlush(styleEngineNow());
  if (retargeted) RETARGETED(retargeted);
  // …and once more where a font metric (`ex`, `ch`) was computed with a stand-in for a face not resolved yet: the faces
  // are resolved on this side, and telling them restyles what used them.
  if (teachStyleFaces()) {
    const again = globalThis.__dom.styleFlush(styleEngineNow());
    if (again) RETARGETED(again);
  }
  // (…a transition or animation the flush started needs frames from now on.)
  globalThis.__csimWakeForAnimations();
}

// The rendering update in the style engine: a style flush, and the animation / transition events owed since the last
// update, as `__dom.styleTick` lists them after the elements the flush reports.
export function tickStyleEngine() {
  feedStyleEngineSheets();
  const out = globalThis.__dom.styleTick(styleEngineNow());
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
  if (styleEngineFedAt !== cascadeVersion && doc && doc.documentElement) feedStyleEngine(doc);
  if (globalThis.__csimShadowHostCount) feedShadowStyleSheets(doc);
}

// The realm's style engine, made if nothing has asked it anything yet (the first feed makes it); a page it styles
// already is left as it is — the next read feeds what changed.
export function ensureStyleEngine() {
  if (styleEngineFedAt === null) feedStyleEngineSheets();
}

export function styleEngineNow() {
  return globalThis.__virtualNow ? globalThis.__virtualNow() : 0;
}

export function resetCascadeState() {
  lastCascadeKey = null;   // force the next rebuildCascade to run
  IMPORT_TIMED.clear();     // (…a new page fetches its imports anew)
  shadowLinkTexts.clear();
  cascadeVersion = (cascadeVersion + 1) | 0;
  sheetFacts = NO_SHEET_FACTS;
  sheetFactsOwed = false;
  styleEngineOwners = [];
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
// __csimVisibleText memos serve stale visibility. The mutation path
// (recordChildList / recordCharacterData) calls this when a stylesheet node is
// involved. rebuildCascade early-returns on an unchanged content key and bumps
// cascadeVersion ONLY when the rules actually change, so a spurious schedule is
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
  Promise.resolve().then(() => {
    cascadeRefreshScheduled = false;
    cascadeStale = false;               // …this IS the rebuild the mark asked for
    try { rebuildCascade(globalThis.document); } catch (_) {}
  });
}
// A CSSOM mutation (cssom.js: replaceSync / insertRule / deleteRule on a constructed
// sheet) may affect a document-adopted sheet OR a shadow-root-adopted one — as may a
// shadow root's `adoptedStyleSheets` list itself changing. The former is picked up by
// the deferred document rebuild (its key re-fingerprints doc.adoptedStyleSheets); the
// latter is handed to the engine per shadow root, keyed on `cascadeVersion`
// (`feedShadowStyleSheets`), and is NOT in the document key — so the version moves here.
export function notifyCssomMutation() {
  bumpCascadeVersion();
  cascadeStale = true;
  scheduleCascadeRefresh();
}
// A rule-set change that the DOCUMENT cascade key cannot see — a shadow root's own
// `<style>` / `adoptedStyleSheets`, or a custom-element definition that flips what a STATIC
// pseudo-class matches (`:disabled` reads form-associatedness off the registry) — moves the
// version alone: that hands the shadow trees' sheets to the engine again and re-keys every
// rule-set-keyed memo, without marking the document cascade stale, which would only walk
// every `<style>`/`<link>` to find its key unchanged.
export function bumpCascadeVersion() {
  cascadeVersion = (cascadeVersion + 1) | 0;
}
// Global hook for the modules that can't import cascade.js without a cycle (custom-elements.js
// via selectors.js).
globalThis.__csimBumpCascadeVersion = bumpCascadeVersion;

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

// A face the style engine holds, standing where its CSSOM rule would: its declarations' text, and a `style` read as the
// rule's own would be (cssom.js `__csimFontFaceStyle`), built on first read.
class EngineFontFace {
  constructor(declText) { this._declText = declText; this._style = null; }
  get cssText() { return `@font-face { ${this._declText} }`; }
  get style() { return this._style || (this._style = globalThis.__csimFontFaceStyle(this._declText)); }
}
// The identity `document.fonts` connects a face by (`key`): the sheet's OWNER — its `<style>` / `<link>`, or an adopted
// sheet — and the face's place among the owner's faces as the parse reads them, for as long as the owner holds the same
// sheet (`faceSource`). Keyed by the rule read, a face became a new FontFace once a script built the sheet's CSSOM, and
// two `<style>`s of one text shared one.
const FACE_KEYS = new WeakMap();
function faceKey(owner, ordinal) {
  const source = faceSource(owner);
  let series = FACE_KEYS.get(owner);
  if (series === undefined || series.source !== source) FACE_KEYS.set(owner, series = { source, keys: [] });
  return series.keys[ordinal] || (series.keys[ordinal] = { owner, ordinal, rule: null });
}
// What an owner's faces are the faces OF: a `<style>`'s block as last updated (mutation-observer.js `styleBlockChanged`),
// a `<link>`'s URL. Changed, they are another sheet's rules, and so new FontFaces (CSS Font Loading §2.2: a rule removed
// is no longer connected, and one added makes a face of its own) — even a text changed and changed back — where a CSSOM
// edit of the sheet, which leaves the block alone, keeps the faces it does not touch.
function faceSource(owner) {
  if (owner._tag === 'style') return owner._sheetGen | 0;
  if (owner._tag === 'link') return owner._attrs.href;
  return owner;
}
// …and a CSSOM rule, once read, keeps the key it took: the one of its place if no other rule holds it — which is how
// the faces a parse listed stay the same FontFaces once the sheet is built — or one of its own. A rule inserted before
// another moves no key, so every face after it stays the FontFace it was (a `deleteRule` likewise).
function ruleFaceKey(rule, owner, ordinal) {
  if (rule._faceKey !== undefined) return rule._faceKey;
  const placed = faceKey(owner, ordinal);
  const key = placed.rule === null || placed.rule === rule ? placed : { owner, ordinal: -1, rule };
  key.rule = rule;
  return (rule._faceKey = key);
}
// A CSSOM sheet's `@font-face` rules in order, with the base each resolves against: into each `@import` that applies
// (the imported sheet's URL its base; `chain` guards a cycle) and each `@media` / `@supports` that holds, and every
// other grouping rule (`@layer`) — not a keyframes rule.
function walkFaceRules(rules, base, depth, chain, vp, visit) {
  if (!rules || depth > 32) return;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r) continue;
    switch (r.type) {
      case 5: visit(r, base); break;
      case 3: {                                                     // @import
        const mt = r.media && r.media.mediaText;
        if (mt && !mediaMatches(mt, vp)) break;
        if (r.supportsText && !globalThis.__dom.declSupportsCondition(r.supportsText)) break;
        let sheet = null;
        try { sheet = r.styleSheet; } catch (_) { sheet = null; }
        const href = sheet && sheet.href;
        if (!sheet || (href && chain.has(href))) break;   // a cycle: this sheet is already an ancestor
        if (href) chain.add(href);
        walkFaceRules(sheet.cssRules, href || base, depth + 1, chain, vp, visit);
        if (href) chain.delete(href);
        break;
      }
      case 4:  if (mediaMatches(r.media ? r.media.mediaText : r.conditionText, vp)) walkFaceRules(r.cssRules, base, depth + 1, chain, vp, visit); break;
      case 12: if (globalThis.__dom.declSupportsCondition(r.conditionText)) walkFaceRules(r.cssRules, base, depth + 1, chain, vp, visit); break;
      default: if (r.cssRules && r.type !== 7) walkFaceRules(r.cssRules, base, depth + 1, chain, vp, visit);   // @layer blocks and the like
    }
  }
}
// A `<style>` / `<link>`'s sheet has just been built (dom-nodes.js): its faces take their keys NOW, each the one of its
// place among the owner's faces — the key the style engine's listing gave it — before a script can insert a rule ahead
// of them (`ruleFaceKey`).
globalThis.__csimStampFaceKeys = function (owner, sheet) {
  if (!sheet) return;
  let n = 0;
  walkFaceRules(sheet.cssRules, sheet.href || null, 0, new Set(sheet.href ? [sheet.href] : []), currentViewport(),
                (r) => { ruleFaceKey(r, owner, n++); });
};
// The `@font-face` rules that apply to `doc`, in stylesheet order, each with the base URL its
// `src` resolves against (the owning sheet's, or the document's for a `<style>`): the sheets
// the cascade would take — a `<style media>` / `<link media>` that matches, no `disabled`
// sheet, alternate sets by the selected set — and inside them `@media` / `@supports` blocks
// that hold and `@import`s (the imported sheet's own base). Read by font-metrics.js and the
// FontFaceSet; memoised there per settle generation and cascade version.
export function fontFaceRulesOf(doc) {
  const out = [];
  if (!doc || !doc.documentElement) return out;
  const vp = currentViewport();
  const selectedSet = cascadeCacheKey(doc, vp).selectedSet || '';
  const docBase = documentBaseUrl();
  const seen = new Set();
  let keyOwner = null;
  const at = { n: 0 };
  const walk = (rules, base, depth, chain) =>
    walkFaceRules(rules, base, depth, chain, vp, (r, b) => out.push({ rule: r, base: b, key: ruleFaceKey(r, keyOwner, at.n++) }));
  // The sheet owners in tree order, as `document.styleSheets` lists them. One with no `sheet` built is read from the
  // style engine (`currentSheetFacts`), which holds the faces of exactly the sheets it took — their media, `disabled`
  // and stylesheet set already asked — each a key of its place among the owner's faces (`faceKey`): building its CSSOM
  // to find them cost a Redmine page load 8.7 ms, jQuery UI's sheet and every other beside the one declaring its Noto
  // Sans. Once built, a sheet is read as it stands: a script may have edited it.
  const { ownerFaces } = currentSheetFacts();
  const owners = [];
  walkSubtree(doc.documentElement, (n) => { if (n.nodeType === NODE_ELEMENT && (n._tag === 'style' || n._tag === 'link')) owners.push(n); });
  for (const owner of owners) {
    keyOwner = owner; at.n = 0;
    if (!owner._sheet) {
      // (…its sources' URLs already resolved, against the sheet each was written in: no base to hand on)
      for (const face of ownerFaces.get(owner) || []) out.push({ rule: face, base: null, key: faceKey(owner, at.n++) });
      continue;
    }
    const sheet = owner.sheet;
    if (!sheet || sheet.disabled) continue;
    if (sheetDisabled(owner)) continue;
    const media = owner._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    const title = (owner._attrs.title || '').trim();
    if (owner._tag === 'link') {
      const tokens = asciiTokens(asciiLower(owner._attrs.rel || ''));
      if (!linkSheetEnabled(owner, title, tokens.includes('alternate'), selectedSet)) continue;
    } else if (!sheetSetEnabled(title, false, selectedSet)) continue;
    if (seen.has(sheet)) continue;
    seen.add(sheet);
    let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
    const chain = new Set(); if (sheet.href) chain.add(sheet.href);
    walk(rules, sheet.href || docBase, 0, chain);
  }
  const adopted = doc.adoptedStyleSheets;
  for (let i = 0; adopted && i < adopted.length; i++) {
    const sheet = adopted[i];
    if (!sheet || sheet.disabled || seen.has(sheet) || !adoptedSheetActive(sheet, vp)) continue;
    seen.add(sheet);
    keyOwner = sheet; at.n = 0;
    walk(sheet.cssRules, docBase, 0, new Set());
  }
  return out;
}
globalThis.__csimFontFaceRules = fontFaceRulesOf;
// The text of the sheet at `url` — null when it could not be fetched, or a controlling service worker blocked it or
// answered with no body. (css-utils' `fetchStyleSheetText` fetches the same way; this one also records the Resource
// Timing entry of a fetch that is the NETWORK's — a service worker's answer records none — so it is its own.)
const IMPORT_TIMED = new Set();
function urlSheetText(url, initiator = null) {
  let body = null;
  const timingStart = initiator ? globalThis.performance.now() : 0;
  try {
    if (/^data:/i.test(url)) {
      body = decodeDataUrlCss(url);
    } else {
      // A controlling service worker answers first (destination 'style'; memoized
      // per URL in bridge.entry so the load-event/.sheet consumers share the SAME
      // dispatch + body). blocked / bodyless → the sheet contributes nothing
      // (NOT cached, like a failed fetch — the memo already pins the verdict).
      const sw = (typeof globalThis.__csimSwFetchStyle === 'function') ? globalThis.__csimSwFetchStyle(url) : null;
      if (sw) return sw.blocked ? null : sw.body;
      body = networkStyleSheetText(url);
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

const __swFontFetched = new Set();
function swFetchFontSrcs(srcs, base) {
  if (!srcs || !srcs.length || typeof globalThis.__csimSWControllerHandle !== 'function' ||
      (globalThis.__csimSWControllerHandle() | 0) <= 0) return;
  for (const fs of srcs) {
    let fabs = fs;
    try { fabs = new URL(fs, base || undefined).href; } catch (_) { continue; }
    if (!/^https?:/i.test(fabs) || __swFontFetched.has(fabs)) continue;
    __swFontFetched.add(fabs);
    try { globalThis.__csimSwFetchDest(fabs, 'font', 'cors', 'same-origin', true); } catch (_) {}
  }
}
// The first `url()` a face's `src` names (`cssTreeFlatten`'s `fontSrcs`, the engine's face text alike).
const FACE_SRC_URL_RE = /src\s*:[^;}]*url\(\s*(['"]?)([^'")]+)\1\s*\)/i;
// A length in px. Viewport units resolve against the current viewport — `height: 100vh` is how a
// page says "fill the screen", and the layout engine has to see it as a real height rather than
// `auto`. Percentages and font-relative units still return null (they need the containing block /
// computed font size, which the caller doesn't pass).
const VIEWPORT_UNIT_RE = /^(-?\d+(?:\.\d+)?)(vh|vw|vmin|vmax)$/i;
function parsePx (v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
  if (m) return parseFloat(m[1]);
  const vu = VIEWPORT_UNIT_RE.exec(s);
  if (vu) {
    const vp = currentViewport();
    const n = parseFloat(vu[1]);
    switch (vu[2].toLowerCase()) {
      case 'vh':   return n * vp.height / 100;
      case 'vw':   return n * vp.width  / 100;
      case 'vmin': return n * Math.min(vp.width, vp.height) / 100;
      case 'vmax': return n * Math.max(vp.width, vp.height) / 100;
    }
  }
  return /^(-?\d+(?:\.\d+)?)$/.test(s) ? parseFloat(s) : null;
}

// Is `el` a fieldset's RENDERED LEGEND (HTML §15.3.13)? A question about BOXES — layout.js's `renderedLegend`, which
// bridge.entry.js hands over (layout.js imports this module, so it cannot be imported back).
let renderedLegendTest = () => false;
export function setRenderedLegendTest(fn) {
  renderedLegendTest = fn;
}
export function isRenderedLegend(el) {
  return renderedLegendTest(el);
}

// A percentage, as a fraction — `null` when the value isn't one. Percentages resolve against the
// containing block, which only the layout pass knows, so `resolveLayoutProp` hands the fraction back
// through `basis` rather than guessing here.
const PERCENT_RE = /^(-?\d+(?:\.\d+)?)%$/;
function parsePercent (v) {
  const m = v == null ? null : PERCENT_RE.exec(String(v).trim());
  return m ? parseFloat(m[1]) / 100 : null;
}

// `el`'s value of `prop` as px: the engine's computed value — a length is px already — with a percentage or a math
// function of one resolved against `basis`, the containing-block extent (width for horizontal props, height for
// vertical ones; omit it and a percentage stays unresolved). `info`, when given, reports back whether the value was a
// PERCENTAGE — i.e. whether this answer depends on `basis` at all: a caller that caches a resolved length (the box-edge
// memo) needs that to know whether its cache survives a different basis. An anonymous box declares nothing and takes
// the UA sheet's value, which carries real geometry for the boxes that have one (a `<td>`'s 1px padding).
export function resolveLayoutProp (el, prop, basis = null, info = null) {
  const raw = declaredValue(el, prop);
  const px = parsePx(raw);
  if (px != null) return px;
  return lengthTextTail(el, raw, basis, info, prop === 'font-size');
}
// The tail of the resolution above — a declared LENGTH / PERCENTAGE / math function as px against a basis — for a
// caller that holds the TEXT and no property to read it from: the length component of a `text-indent`
// (style-proxy.js `textIndentOf`). One resolution rather than a partial re-spelling per caller: splitting on white
// space and `parseFloat`ing the pieces reads `calc(10% + 1px)` as 1px, a silent wrong number on a value this resolves.
// A plain px FIRST — `resolveLayoutProp` has already returned on one before it delegates, so that step is for the
// standalone callers, and without it `text-indent: 40px` resolves to nothing. An intrinsic-size keyword is no length,
// and resolves to null.
export function lengthTextToPx(el, raw, basis, info = null, forFontSize = false) {
  const px = parsePx(raw);
  if (px != null) return px;
  return lengthTextTail(el, raw, basis, info, forFontSize);
}
// …and the tail alone, for `resolveLayoutProp`, which has done the `parsePx` already and must not pay for it twice.
function lengthTextTail(el, raw, basis, info, forFontSize) {
  // FONT-RELATIVE units (em / rem / ex / ch / pt …). Modern app CSS is written in
  // rem (Bootstrap, Tailwind) — resolving only px left every such padding, margin
  // and border at 0, so the box model didn't reach the stylesheets that matter.
  const fontPx = fontRelativeToPx(el, raw, forFontSize);
  if (fontPx != null) return fontPx;
  const pct = parsePercent(raw);
  if (pct != null) {
    if (info) info.percent = true;
    return basis != null ? pct * basis : null;
  }
  // A math function is the last thing to try, and only when it IS one — the check is
  // a substring test and this is the hot path every box measurement runs through.
  // The computed stage already reduced whatever it could (`10em + 20px`); what's left
  // needs the basis only layout has, which is exactly `calc(50% + 10px)`.
  if (!hasMathFunction(raw)) return null;
  if (info) info.percent = true;
  if (basis == null) return null;
  const reduced = reduceMathFunctions(String(raw), (n, unit) => (
    unit === '%' ? (n / 100) * basis : lengthUnitToPx(el, n, unit)
  ));
  return parsePx(reduced);
}

// One length token → px for the math reducer: the absolute units, then the
// font-relative ones through the same resolver every other length uses.
function lengthUnitToPx(el, n, unit) {
  const abs = absoluteToPx(n, unit);
  if (abs != null) return abs;
  return fontRelativeToPx(el, `${n}${unit}`);
}
// Does THIS realm's document own `el`? Only then may an answer be memoised under this realm's generations — the two
// realms' counters are unrelated — or this realm's layout be asked about it.
export function ownedByThisRealm(el) {
  const owner = el._ownerDoc;
  if (owner != null) return owner === globalThis.document;
  let n = el;
  for (let hops = 0; n && hops < 64; hops++) {
    if (n._parent == null) break;
    n = n._parent;
  }
  return n === globalThis.document;
}

// The computed `visibility`, which the engine inherits through the FLAT tree (a slotted span under a hidden shadow box)
// — `visible` where it does not style the element.
export function computedVisibility(el) { return engineValue(el, 'visibility') ?? 'visible'; }
export function visibilityHidden(el) { const v = computedVisibility(el); return v === 'hidden' || v === 'collapse'; }
// Block-shaped tags get a `\n` boundary before/after their content.
// Note: `td`/`th` are deliberately NOT block — W3C innerText §14.4
// inserts only `\t` between adjacent cells; the `\n` only appears
// when the cell's own *content* includes a block-level child (see
// `isCellWithInnerBlock` below). Real Chrome:
//   `<td>A</td><td>B</td>`       → `"A\tB"`
//   `<th><div>A</div></th>…`     → `"A\n\t\nB"`
export const BLOCK_TAGS = new Set([
  'address','article','aside','blockquote','dd','div','dl','dt',
  'figcaption','figure','footer','form','h1','h2','h3','h4','h5',
  'h6','header','hr','li','main','nav','ol','p','pre','section',
  'table','tbody','tfoot','thead','tr','ul'
]);
// The generation the rendered-ness memo keys on (`isVisibleNodeImpl`): the DOM (`settleGen`), the rule set
// (`cascadeVersion`, which a CSSOM edit moves without touching the DOM) and the dynamic style state.
// One monotonic number for THREE inputs, without packing them arithmetically: a long app-suite run
// pushes `settleGen` into the tens of thousands, and `gen * 1e12` would leave the exactly-integral
// range of a double. A counter that ticks whenever any input moves is exact for as long as any of
// them is, and every caller only ever compares it for equality.
const GEN = { gen: -1, cv: -1, ss: -1, value: 0 };
export function cascadeGeneration () {
  // A `dir=auto` scope a mutation touched is tested here, before the generation is read: a flip moves it.
  if (globalThis.__csimDirAutoPending) globalThis.__csimFlushDirAutoScopes();
  ensureCascadeFresh();
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  const cv  = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const ss  = styleStateGeneration();
  if (gen !== GEN.gen || cv !== GEN.cv || ss !== GEN.ss) {
    GEN.gen = gen; GEN.cv = cv; GEN.ss = ss;
    GEN.value = (GEN.value + 1) | 0;
  }
  return GEN.value;
}

// The epoch LAYOUT keys its memos on: the rule set. What a dynamic state flip reaches — `#t:placeholder-shown { width:
// 300px }` once the field is filled — the style engine marks as it restyles (layout.js `markRestyles`); keyed on the
// state as well, every keystroke relaid out the document.
const LAYOUT_EPOCH = { cv: -1, value: 0 };
export function cascadeLayoutEpoch () {
  ensureCascadeFresh();
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  if (cv !== LAYOUT_EPOCH.cv) {
    LAYOUT_EPOCH.cv = cv;
    LAYOUT_EPOCH.value = (LAYOUT_EPOCH.value + 1) | 0;
  }
  return LAYOUT_EPOCH.value;
}
// Diagnostic: the epoch value itself, so a spec can assert that dynamic state does (or does not)
// reach layout — a geometry read can't distinguish "memo survived" from "recomputed equal".
globalThis.__csimLayoutEpoch = () => cascadeLayoutEpoch();

// The memos an element gains once it is STYLED — the cascade's, then layout's — declared together, in one order, on
// its first style read or layout visit (here, in style-proxy.js `pseudoNodeFor`, which writes one before any read, and
// layout.js `inheritedDirty`, which a pass asks before either): added as each was first written,
// in whatever order a page's reads took, they split one tag's elements across several hidden classes (130 maps for
// the 369 elements of a Redmine issue page, 88 declared), a page load 5% slower. Declared in the Element constructor
// instead, every element paid for them — a detached, parsed or template one never styled: createElement 75% slower,
// ~550 bytes each. `undefined` is the absent memo each reader already tests for.
export function declareStyledMemos(el) {
  el._styled = true;
  el._pseudoNodes = undefined;                                              // ::before / ::after nodes (style-proxy.js)
  el._visMemo = undefined;                                                  // rendered-ness (`isVisibleNodeImpl`)
  // …and layout's (layout.js): the box the pass left in the arena (`boxOf`), then each memo beside its `…Pass` stamp — the
  // ones a geometry read asks of a page the Rust walk lays out. (The other memos layout.js keeps — the font records, … —
  // are not declared: declaring them for every styled element
  // cost a Redmine page load 2.8% of its main thread.)
  el._lbBox = undefined; el._lbBoxPass = undefined;
  el._lbInhDirty = undefined; el._lbInhDirtyPass = undefined; el._lbGen = undefined; el._lbGenPass = undefined;
  el._lbPos = undefined; el._lbPosPass = undefined;
  el._lbPs = undefined; el._lbPsPass = undefined;
}


// FOCUS and HOVER are signalled where they are written (dom-nodes.js `Document#_activeElement` / `_hoverElement`).
// `__csimFocusVisible` is compared here: it distinguishes `:focus-visible` from `:focus` at the same instant, so a
// pointer-driven focus that leaves the focused element unchanged still counts as a change.
let lastFocusVisible = undefined;
function styleStateGeneration () {
  const fv = globalThis.__csimFocusVisible;
  if (fv !== lastFocusVisible) {
    lastFocusVisible = fv;
    bumpStyleState();
  }
  return currentStyleStateGen();
}
// An adopted stylesheet contributes rules only when it is enabled AND its media (if any)
// matches — a `disabled` constructed sheet, or one whose `{media}` excludes this viewport,
// is inert (constructable-stylesheets disabled / media subtests).
function adoptedSheetActive(sheet, vp) {
  if (!sheet || sheet.disabled) return false;
  const media = sheet.media && sheet.media.mediaText;
  return !media || mediaMatches(media, vp);
}
// A generation that moves on every insertion or removal (`bumpStructureGen`), and on nothing else: an attribute write
// moves the tree generation (`currentTreeGen`) and not this one. Each realm counts its own from 1.
let structureGen = 1;
export function bumpStructureGen() {
  structureGen = (structureGen + 1) | 0;
}
export function currentStructureGen() { return structureGen; }

