// The document's style, as this side meets it.
//
// The style engine (stylo, style.rs) cascades and computes every value. What lives here is what it is handed and how
// it is asked:
//   - the sheets that apply — the sheet sets, a `disabled` sheet, a `<link>`'s media, the `@import`s fetched, the
//     constructed and adopted sheets and the shadow trees' own — fed to it (`feedStyleEngine`), and the facts the
//     driver keeps of them (`@font-face` rules, whether a sheet names an image);
//   - its answers (`engineValue`, `styleEngineShown` …), and the style flush that starts the transitions a change owes;
//   - what is rendered and what is not (`isVisibleNode`), and the rendered text (`collectVisibleText`, `innerText`);
//   - a shorthand's longhands for a CSSOM declaration block (`expandShorthandValue`), and a box's flow-relative sides;
//   - the generations the memos on this side key on (`cascadeGeneration`, `cascadeLayoutEpoch` …).

import { teachStyleFaces } from './font-metrics.js';
import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_FRAGMENT, HTML_NS, SVG_NS } from './constants.js';

import { walk, walkSubtree, scriptText, flatTreeParent, assignedSlotFor } from './walk.js';
import { bumpStyleState, currentStyleStateGen, currentDirtySeq, currentTreeGen } from './mutation-observer.js';
import { mediaMatches, currentViewport } from './media-query.js';
import { asciiLower, asciiTokens } from './ascii.js';
import { splitTopLevel, decodeDataUrlCss, networkStyleSheetText, documentBaseUrl } from './css-utils.js';
import { isRegularShorthand, shorthandExpand, shorthandLonghands, isCssWideKeyword, isLineWidth, isLineStyle, FONT_SHORTHAND } from './shorthands.js';
import { isHtmlDocument } from './mime.js';
import { maybeVerifyArena, arenaNid, foreignRealmOf, REALM as NATIVE_REALM } from './native-query-shadow.js';
import { normalizeColor, declaredValue, fontRelativeToPx, uaHidden, canonicalDisplay } from './style-proxy.js';
import { hasMathFunction, reduceMathFunctions, absoluteToPx } from './calc.js';

// Tags whose subtree never contributes to visible text or
// `__csimVisible`: head/script/style/template/noscript/title.
export const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);

// Elements whose child content is FALLBACK: shown only by a browser that can't render the element
// itself, which this one can. Their children generate no boxes, contribute no text, and are not
// visible — the ELEMENT is all three, since it renders its own bitmap or widget. Chrome-measured
// per tag; `<object>` is deliberately absent, because ITS fallback content does render when the
// resource fails to load. Read by the layout walk (layout.js `flatTreeChildren`), the visibility
// walk and the visible-text walk below, so the three cannot drift apart.
export const FALLBACK_ONLY_TAGS = new Set(['canvas','iframe','frame','embed','video','audio','progress','meter']);
// …and `<object>` joins them only while it is not showing its fallback: see `rendersObjectFallback`.
export function hasFallbackOnlyContent(el) {
  return FALLBACK_ONLY_TAGS.has(el._tag) || (el._tag === 'object' && !rendersObjectFallback(el));
}

// An `<object>` with no resource of its own renders its CHILDREN — and is then not a replaced
// element at all, but an ordinary inline box around them that `width` / `height` do not apply to
// (Chrome: `<object style="width: 20px">hello</object>` is as wide as the word). With no resource
// AND no fallback content it stays a replaced box at the default object size, which is what an
// empty `<object>` on a page is (Chrome: 300x150). A resource this driver never fetches is taken
// to have loaded, exactly as `<embed src>` is. (Text is content unless it is CSS white space: an NBSP or an em space is
// fallback content — Chrome lays `<object>&nbsp;</object>` out as an inline 9.61 wide — where `\S` took them for space.)
export function rendersObjectFallback(el) {
  if (el._attrs.data != null) return false;
  return el._children.some((c) => c.nodeType === NODE_ELEMENT ||
                                  (c.nodeType === NODE_TEXT && /[^ \t\n\r\f]/.test(String(c.data || ''))));
}

// Elements no UA renders, whatever the page declares: the `!important` UA hides (`uaHidden`), and
// an `<embed>` with no resource — which Chrome gives no layout box at all while its computed
// `display` stays `inline`, so this is a missing box rather than a hide.
export function uaNotRendered(el) {
  return uaHidden(el) || (el._tag === 'embed' && el._attrs.src == null);
}


// Visibility predicate: walks the ancestor chain. Returns false if
// the element itself or any ancestor is INVISIBLE_TAGS / hidden /
// display:none / `<input type=hidden>`, otherwise true. Exposed as
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

// The display-side check for the ELEMENT ITSELF — no ancestor walk, no connectivity check. For a
// caller that has already established both (the layout walk descends only into rendered parents,
// starting from a connected <body>), `isLaidOutNode` re-walks every ancestor, making a whole-tree pass
// O(elements x depth) when O(elements) is enough. Same verdict, minus the work the caller already did.
export function selfNotRendered(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return true;
  if (el._pseudo) return engineValue(el, 'display') === 'none';   // a generated box: only its own display hides it
  if (el._anonCell || el._anonItem) return false;                  // an anonymous box: a box by construction
  if (INVISIBLE_TAGS.has(el._tag)) return true;
  if (uaNotRendered(el)) return true;
  return selfHidden(el);
}
// …memoised per element for as long as nothing it reads can have moved: the cascade generation (a mutation, the rule
// set, a dynamic state), the parser's tree generation and the layout dirty sequence — a read that met something none
// of them tracks (`noteUncacheableRead`) is not kept. Every used-value `getComputedStyle` read and every geometry read asks
// it, and the ancestor walk was half of a warm `borderTopWidth` read.
function isVisibleNodeImpl(el, ignoreVisibility, honourSkips, renderedAt = null) {
  // (…an element this realm's document owns: another realm counts its generations from 0 too.)
  if (renderedAt !== null || !el || el.nodeType !== NODE_ELEMENT || !ownedByThisRealm(el)) {
    return visibleNodeWalk(el, ignoreVisibility, honourSkips, renderedAt);
  }
  const gen = cascadeGeneration(), tree = currentTreeGen(), dirty = currentDirtySeq();
  let m = el._visMemo;
  if (m === undefined || m.gen !== gen || m.tree !== tree || m.dirty !== dirty) {
    if (el._styled === false) declareStyledMemos(el);
    m = el._visMemo = { gen, tree, dirty, v: [undefined, undefined, undefined, undefined] };
  }
  const i = (ignoreVisibility ? 1 : 0) | (honourSkips ? 2 : 0);
  let v = m.v[i];
  if (v === undefined) {
    const seq = uncacheableSeq;
    v = visibleNodeWalk(el, ignoreVisibility, honourSkips, null, styleEngineShown(el));
    if (uncacheableSeq === seq) m.v[i] = v;
  }
  return v;
}
// …`shown` being the style engine's answer where it styles `el` (`styleEngineShown`): whether a `display: none` hides
// it anywhere up its flat tree, and whether its `visibility` does — the two questions the walk otherwise asks of every
// ancestor (`selfHidden`, `visibilityHidden`). The walk's structural questions (fallback content, a closed `<details>`,
// a slot's fallback, connectedness) are its own either way.
function visibleNodeWalk(el, ignoreVisibility, honourSkips, renderedAt, shown = undefined) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  if (INVISIBLE_TAGS.has(el._tag)) return false;
  if (uaNotRendered(el)) return false;
  // Display-side hiding is UNCONDITIONAL: any ancestor-or-self that is
  // display:none / [hidden] / dialog:not([open]) / INVISIBLE_TAGS hides the
  // whole subtree. `visibility` is deliberately NOT checked in this walk —
  // it inherits AND a descendant can override it — so pass ignoreVisibility
  // to selfHidden and resolve visibility per-target below.
  let cur = el, connected = false, summarySeen = false;
  while (cur) {
    // (`renderedAt`: a node the caller has already reached through rendered ancestors — the walk stops there.)
    if (cur === renderedAt) return true;
    if (cur.nodeType === NODE_DOC) { connected = true; break; }
    if (cur.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(cur._tag)) return false;
      // An ANCESTOR whose content is fallback hides everything below it; the element itself is
      // rendered (it draws its own bitmap / widget), so this one is skipped for `el`.
      if (cur !== el && hasFallbackOnlyContent(cur)) return false;
      if (shown === undefined ? selfHidden(cur) : shown === 0) return false;
      // A CLOSED `<details>` SKIPS all but its `<summary>` — its content slot is `content-visibility: hidden` (HTML
      // §15.3.x), laid out but not shown: Chrome gives the content a rect and says `checkVisibility()` false, and a
      // user sees none of it, whatever `display` an author gives it (Chrome and Firefox). A widget built on one opens it
      // to show its body — Discourse's select-kit sets `open` as it expands.
      if (honourSkips && cur !== el && cur._tag === 'details' && cur._attrs.open == null && !summarySeen) return false;
      if (cur._tag === 'summary') summarySeen = true;
    }
    const p = cur._parent;
    // …up the FLAT tree where it leaves the node tree: a shadow host's light child renders through the slot it is
    // assigned to, under whatever hides that slot — and with no slot it renders nowhere. Walked to the host instead, a
    // span whose `slot` attribute went away stayed "rendered": its old box answered rects, offsetHeight and hit tests,
    // and `checkVisibility()` said true (Chrome: an empty rect, 0, no hit, false).
    if (p && p._shadowRoot && cur.nodeType === NODE_ELEMENT && !cur._pseudo) {
      cur = assignedSlotFor(cur);
      if (!cur) return false;
      continue;
    }
    // …and a slot's own children are its FALLBACK, rendered only while nothing is assigned to it (the same choice
    // layout's `flatTreeChildren` makes). Chrome: `checkVisibility()` false for a fallback `<em>` beside a slotted
    // title, where Capybara's visible filter found it.
    // (The slot's assigned set is its slotchange SNAPSHOT where one has been taken — kept current by every assignment
    // change, and free to read; `assignedNodes()` allocates and scans the host, +50% on 16k fallback reads.)
    if (p && p._tag === 'slot' && typeof p.assignedNodes === 'function' &&
        (p._assignedSnapshot !== undefined ? p._assignedSnapshot : p.assignedNodes()).length) return false;
    cur = p;
  }
  if (!connected) return false;
  if (!ignoreVisibility && (shown === undefined ? visibilityHidden(el) : shown === 2)) return false;
  return true;
}
globalThis.__isVisibleNode = isVisibleNode;
globalThis.__isLaidOutNode = isLaidOutNode;

export function selfHidden(el) {
  // Its computed `display`: every origin, `!important` and UA rule already folded in — and an element the engine does
  // not style, one in no rendered document, is not rendered at all.
  const display = engineValue(el, 'display');
  return display === undefined || display === 'none';
}

// FNV-1a 32-bit string hash — fast, allocation-free; good enough for a cache key.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
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

// The EFFECTIVE CSS text of a `<style>` for the cascade. Normally this is the
// element's own text node (`scriptText`) — the common, allocation-free path taken
// whenever no script has touched the element's CSSOM `.sheet`. But once `.sheet` is
// materialized and mutated via the CSSOM (`sheet.insertRule` / `deleteRule`), the
// element text no longer reflects the rules, so we use the sheet's serialized text
// instead. A change to the element's own children re-runs "update a style block":
// the sheet is reparsed from the element text, discarding prior insertRule edits —
// keyed on the `_styleTextDirty` flag (set on any child mutation) so a same-text
// change (an empty text node added/removed) still reparses, not just a differing
// string. `_sheetText` / the flag are shared with the `.sheet` getter, keeping them
// in step.
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

function effectiveStyleCss(s) {
  const sheet = s._sheet;
  if (!sheet) return scriptText(s);
  const text = scriptText(s);
  if (s._styleTextDirty || s._sheetText !== text) { sheet._reparse(text, false); s._sheetText = text; s._styleTextDirty = false; }
  return sheet._cssText;
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
      const t = effectiveStyleCss(s); if (!t) continue;
      const title = (s._attrs.title || '').trim();
      if (title) { anyTitledOrAlt = true; if (!preferred) preferred = title; }
      acc += '\nS:' + fnv1a(t) + ':' + t.length + (title ? '|t:' + title : '');
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
  // `document.adoptedStyleSheets` contribute to the cascade; key on each sheet's
  // text fingerprint so reassigning / mutating them re-keys and rebuilds. A disabled
  // sheet, or one whose media doesn't match, contributes no rules — keyed as `A:off` so
  // toggling `disabled` / a media change still re-keys and rebuilds.
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    if (!adoptedSheetActive(sheet, vp)) { acc += '\nA:off'; continue; }
    const t = sheetCssText(sheet);
    if (t) acc += '\nA:' + fnv1a(t) + ':' + t.length;
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
      entries.push(effectiveStyleCss(s) || '', docBase, s._attrs.media || '', false);
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
    if (css != null) { entries.push(css, abs, l._attrs.media || '', false); owners.push(l); }
  }
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    if (!adoptedSheetActive(sheet, vp)) continue;
    const txt = sheetCssText(sheet);
    if (txt) { entries.push(txt, sheet._href || docBase, '', true); owners.push(sheet); }
  }
  resolveStyleEngineImports(globalThis.__dom.styleSheets(doc._nid, docBase, !!doc._quirks, !isHtmlDocument(doc), vp.width, vp.height, entries));
  styleEngineOwners = owners;
  sheetFactsOwed = true;
}
// The sheets the style engine's `@import`s wait for, fetched and handed over until none is. Each URL is fetched once,
// however many sheets import it; an import CYCLE would ask for ever, so a chain deeper than any real page nests is
// answered with nothing.
function resolveStyleEngineImports(waiting) {
  const texts = new Map();
  for (let depth = 0; waiting && waiting.length; depth++) {
    const next = [];
    for (const url of new Set(waiting)) {
      if (!texts.has(url)) texts.set(url, urlSheetText(url, 'css'));
      next.push(...globalThis.__dom.styleImport(url, depth < IMPORT_DEPTH_LIMIT ? texts.get(url) : null));
    }
    waiting = next;
  }
}
const IMPORT_DEPTH_LIMIT = 16;

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
          if (styleElementIsCss(owner)) entries.push(effectiveStyleCss(owner) || '', docBase, owner._attrs.media || '', false);
        } else {
          const abs = shadowLinkSheetUrl(owner, docBase);
          const css = abs && shadowLinkText(abs);
          if (css != null && abs) entries.push(css, abs, owner._attrs.media || '', false);
        }
      }
      const adopted = sr.adoptedStyleSheets;
      if (adopted) for (const sheet of adopted) {
        if (!adoptedSheetActive(sheet, vp)) continue;
        const txt = sheetCssText(sheet);
        if (txt) entries.push(txt, sheet._href || docBase, '', true);
      }
      resolveStyleEngineImports(globalThis.__dom.styleShadowSheets(sr._nid, entries));
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
// Whether the style engine shows `el` (`__dom.styleShown`): 0 no box, 1 displayed and visible, 2 displayed with its
// `visibility` hiding it — undefined where it has no node in the engine's arena, and for a generated box, whose style
// is its originating element's pseudo-element's rather than a node's own.
export function styleEngineShown(el) {
  if (el._pseudo) return undefined;
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineShown(el);
  feedStyleEngineSheets();
  return globalThis.__dom.styleShown(nid, styleEngineNow());
}

// …and whether it SKIPS its contents (`__dom.styleSkips`): shown itself, under a `content-visibility: hidden` nothing under
// it is — undefined where it has no node in the engine's arena.
export function styleEngineSkips(el) {
  if (el._pseudo) return undefined;
  const nid = arenaNid(el);
  if (nid < 0) return foreignRealmOf(el)?.styleEngineSkips(el);
  feedStyleEngineSheets();
  return globalThis.__dom.styleSkips(nid, styleEngineNow());
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
Object.assign(NATIVE_REALM, { styleEngineValue, styleEngineShown, styleEngineSkips, styleEngineTransformMatrix, styleEngineGenerated });

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

function styleEngineNow() {
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

// The CSS box shorthands (`margin` / `padding` / `inset`): 1–4 values map to top / right / bottom /
// left by the usual mirroring rules. A value count outside 1–4 is invalid and contributes nothing.
function expandBoxShorthand(prop, value) {
  const parts = splitTopLevel(value, ' ').map(t => t.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return [];
  const [top, right = top, bottom = top, left = right] = parts;
  // `inset`'s longhands ARE the physical insets (`top` / `right` / …), not `inset-top` & co.
  const name = (side) => prop === 'inset' ? side : `${prop}-${side}`;
  return [
    { prop: name('top'),    value: top },
    { prop: name('right'),  value: right },
    { prop: name('bottom'), value: bottom },
    { prop: name('left'),   value: left }
  ];
}

// `overflow: <x> [<y>]` — one value sets both axes, two set them in order. The longhands are what
// everything reads: our own clip / scroll-container test, and page code deciding whether an
// ancestor scrolls (Floating UI's `isOverflowElement` tests `overflow + overflowY + overflowX`).
// The shorthand itself stays captured so getComputedStyle can report it directly.
function expandOverflowShorthand(value) {
  const parts = splitTopLevel(value, ' ').map(t => t.trim()).filter(Boolean);
  if (!parts.length || parts.length > 2) return [];
  const [x, y = x] = parts;
  return [{ prop: 'overflow', value }, { prop: 'overflow-x', value: x }, { prop: 'overflow-y', value: y }];
}

// The flow-relative BORDER shorthands (`border-block-end: 3px solid red`), which the CSSOM registry
// doesn't carry. They expand exactly like their physical twins — the width / style / colour
// classification is shared — into `border-<flow-side>-{width,style,color}`; turning those into a
// physical side is the reader's job, since it depends on the writing mode.
const LOGICAL_BORDER_RE = /^border-(block|inline)(-(start|end))?$/;
function expandLogicalBorder(prop, value) {
  const flow = prop.slice('border-'.length);
  const parts = expandBorderShorthand(value);          // border-{width,style,color}
  const sides = flow === 'block' ? ['block-start', 'block-end']
              : flow === 'inline' ? ['inline-start', 'inline-end']
              : [flow];
  const out = [];
  for (const side of sides) {
    for (const d of parts) out.push({ prop: `border-${side}-${d.prop.slice('border-'.length)}`, value: d.value });
  }
  // `border-block` also sets the AXIS-level names (`border-block-width`), which are shorthands over
  // the two sides in their own right. Chrome reports `border-block-width: 2px` for
  // `border-block: 2px solid red` (measured); emitting only the per-side longhands left the axis
  // names undeclared, and the resolved-value read then answered with their initial.
  if (sides.length === 2) {
    for (const d of parts) out.push({ prop: `border-${flow}-${d.prop.slice('border-'.length)}`, value: d.value });
  }
  return out;
}

// `font` — the cascade's own reading of it. The CSSOM registry deliberately doesn't carry `font`
// (its block serialization has a contract this parse doesn't model), but the cascade still wants
// the longhands, so it takes the shared parse and shapes it into the `{prop, value}` list the
// expander speaks.
function expandFontShorthand(value) {
  const vals = FONT_SHORTHAND.expand(value);
  return vals ? FONT_SHORTHAND.longhands.map((prop, i) => ({ prop, value: vals[i] })) : [];
}

// `text-decoration: <line> || <style> || <color> || <thickness>` — a free-order shorthand the CSSOM
// registry doesn't carry. The line keywords are a space-separated LIST (`underline overline`), the
// style is one of five keywords, and anything else is the colour. Expanding it is what lets a
// resolved-value read serialize the shorthand back from its longhands, and what makes an inherited
// `text-decoration-line` visible to a child.
const TEXT_DECORATION_LINES  = new Set(['none', 'underline', 'overline', 'line-through', 'blink', 'spelling-error', 'grammar-error']);
const TEXT_DECORATION_STYLES = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy']);
function expandTextDecorationShorthand(value) {
  const parts = splitTopLevel(value, ' ').map(t => t.trim()).filter(Boolean);
  if (!parts.length) return [];
  const lines = [];
  let style = null, color = null, thickness = null;
  for (const tok of parts) {
    const low = tok.toLowerCase();
    if (TEXT_DECORATION_LINES.has(low)) lines.push(low);
    else if (TEXT_DECORATION_STYLES.has(low)) { if (style) return []; style = low; }
    else if (/^(auto|from-font)$/i.test(low) || /^-?\d/.test(tok)) { if (thickness) return []; thickness = tok; }
    else { if (color) return []; color = tok; }
  }
  // A shorthand RESETS every longhand it names, so an omitted component contributes its INITIAL
  // rather than nothing: `text-decoration: underline` computes a thickness of `auto` and a style of
  // `solid` in Chrome (measured), where emitting only the components present left them unknowable.
  return [
    { prop: 'text-decoration-line',      value: lines.length ? lines.join(' ') : 'none' },
    { prop: 'text-decoration-style',     value: style     || 'solid' },
    { prop: 'text-decoration-color',     value: color     || 'currentcolor' },
    { prop: 'text-decoration-thickness', value: thickness || 'auto' }
  ];
}

// `flex: <grow> <shrink> <basis>` with the spec's defaults for the shorthand: a single `<number>`
// is `<n> 1 0%` (which is what makes two `flex: 1` items split their row evenly), a single length is
// `1 1 <length>`, and the SECOND value is `flex-basis` unless it is a bare number. Expanding here
// rather than reading the shorthand at layout time is what makes the longhands obey cascade order —
// `.a { flex-grow: 0 } .a { flex: 1 }` has to end up with grow 1.
function expandFlexShorthand(value) {
  const s = String(value).trim().toLowerCase();
  const out = (grow, shrink, basis) => [
    { prop: 'flex-grow', value: String(grow) },
    { prop: 'flex-shrink', value: String(shrink) },
    { prop: 'flex-basis', value: basis }
  ];
  if (s === 'none')    return out(0, 0, 'auto');
  if (s === 'auto')    return out(1, 1, 'auto');
  if (s === 'initial') return out(0, 1, 'auto');
  const isNumber = (t) => /^-?\d+(\.\d+)?$/.test(t);
  const parts = splitTopLevel(s, ' ').map((t) => t.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) return [];
  if (parts.length === 1) {
    return isNumber(parts[0]) ? out(parts[0], 1, '0%') : out(1, 1, parts[0]);
  }
  if (parts.length === 2) {
    if (!isNumber(parts[0])) return [];
    return isNumber(parts[1]) ? out(parts[0], parts[1], '0%') : out(parts[0], 1, parts[1]);
  }
  return isNumber(parts[0]) && isNumber(parts[1]) ? out(parts[0], parts[1], parts[2]) : [];
}

// `border: <width> || <style> || <color>` (any order/subset) → the three uniform
// longhands getComputedStyle reports as `borderWidth`/`borderStyle`/`borderColor`.
// Only the all-sides-equal `border` shorthand is expanded (per-side `border-top` etc.
// aren't modelled — no gated test needs them).
function expandBorderShorthand(value) {
  let width = null, style = null, color = null;
  for (const tok of splitTopLevel(value, ' ')) {
    const t = tok.trim(); if (!t) continue;
    // The SAME classification the CSSOM registry uses (shorthands.js). This was a third copy of it
    // — a bare `/^[\d.]/` — which sent `calc(2px)` to the COLOUR slot, where the real colour then
    // overwrote it and the width fell back to `medium`. `border-inline-start: calc(2px) solid red`
    // painted a `medium` border in a page that asked for 2px, and the CSSOM and the cascade
    // disagreed about the same declaration.
    if (isLineStyle(t)) style = t.toLowerCase();
    else if (isLineWidth(t)) width = t;
    else color = t;
  }
  // The shorthand sets ALL three longhands; an omitted component resets to its
  // initial (so a later `border:` overrides an earlier explicit longhand).
  return [
    { prop: 'border-width', value: width != null ? width : 'medium' },
    { prop: 'border-style', value: style != null ? style : 'none' },
    { prop: 'border-color', value: color != null ? color : 'currentcolor' },
  ];
}

// Is a single top-level token a CSS <color>? Canonical color functions and hex are matched
// by shape (so an already-serialized `rgb(0, 128, 0)` counts); everything else defers to the
// shared color parser, which folds a named color to `rgb(...)` (≠ the input) and leaves a
// non-color keyword (`no-repeat`, `center`, `cover`, `url(...)`) untouched.
function isCssColorToken(t) {
  const s = t.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(s)) return true;
  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(s)) return true;
  if (s === 'transparent' || s === 'currentcolor') return true;
  return normalizeColor(s) !== s;
}

// Sub-property keyword sets of the `background` shorthand, used to classify each token when
// expanding it into longhands (the grammar is order-independent, so we bucket by kind).
const BG_REPEAT_KW = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round']);
const BG_ATTACH_KW = new Set(['scroll', 'fixed', 'local']);
const BG_BOX_KW    = new Set(['border-box', 'padding-box', 'content-box']);
// The longhands `background` sets that getComputedStyle reports, and their initial values (for a
// layer that omits the component). `background-image` keeps its `url(...)` in SPECIFIED form here
// (the parse cache is base-independent).
const BG_LONGHANDS = [
  ['background-image',      'none'],
  ['background-position',   '0% 0%'],
  ['background-size',       'auto'],
  ['background-repeat',     'repeat'],
  ['background-attachment', 'scroll'],
  ['background-origin',     'padding-box'],
  ['background-clip',       'border-box'],
];

// A `background-image` value: `none`, a `url(...)`, or an image function (gradient / image-set / …).
const BG_IMAGE_RE = /^(url|(?:repeating-)?(?:linear|radial|conic)-gradient|image-set|cross-fade|element|paint)\(/i;
// A `background-size` component: the `auto`/`cover`/`contain` keywords or a <length-percentage>.
function isBgSizeToken(t) { return /^(auto|cover|contain)$/i.test(t) || /^[+-]?[\d.]/.test(t); }

// Expand ONE comma-separated `background` layer into its longhand components (the ones present;
// callers fill the rest with initials). `isFinal` gates the background-color, which per spec only
// the final layer may carry. The shorthand's grammar is order-independent EXCEPT that a `/`
// binds a (bounded, 1-2 token) `<bg-size>` to the preceding `<position>` — after those size
// tokens, remaining tokens are ordinary layer components again.
function parseBgLayer(layer, isFinal) {
  const out = { image: null, position: null, size: null, repeat: null, attachment: null, origin: null, clip: null, color: null };
  // Tokenise parens-safely (so a `url(a/b.png)` / gradient stays one token), then break out the
  // position/size separator `/` — whether spaced (`center / cover`) or not (`center/cover`) —
  // into its own token. A `/` inside a function is left intact (the token holds a `(`).
  const raw = [];
  for (const tok of splitTopLevel(layer, ' ')) {
    const t = tok.trim(); if (!t) continue;
    if (t !== '/' && t.indexOf('/') !== -1 && t.indexOf('(') === -1) {
      const parts = t.split('/');
      for (let k = 0; k < parts.length; k++) { if (k) raw.push('/'); if (parts[k]) raw.push(parts[k]); }
    } else raw.push(t);
  }
  const posTokens = [], repeats = [], boxes = [], sizeTokens = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i], lt = t.toLowerCase();
    if (t === '/') {
      // The `<bg-size>` (1-2 tokens) follows the slash; stop at the first non-size token.
      while (i + 1 < raw.length && sizeTokens.length < 2 && isBgSizeToken(raw[i + 1])) sizeTokens.push(raw[++i]);
      continue;
    }
    if (lt === 'none' || BG_IMAGE_RE.test(t)) out.image = t;
    else if (BG_REPEAT_KW.has(lt)) repeats.push(lt);
    else if (BG_ATTACH_KW.has(lt)) out.attachment = lt;
    else if (BG_BOX_KW.has(lt)) boxes.push(lt);
    else if (isFinal && isCssColorToken(t)) out.color = t;
    else posTokens.push(t);
  }
  if (repeats.length) out.repeat = repeats.join(' ');
  if (boxes.length) { out.origin = boxes[0]; out.clip = boxes[1] || boxes[0]; }   // one box value sets both
  // Keep the position tokens raw; getComputedStyle canonicalizes them at read time (the same
  // path a direct `background-position` longhand takes), so both sources resolve identically.
  if (posTokens.length) out.position = posTokens.join(' ');
  // Keywords (cover / contain / auto) lowercase; a <length>/<percentage> passes through verbatim.
  if (sizeTokens.length) out.size = sizeTokens.map(s => /^(cover|contain|auto)$/i.test(s) ? s.toLowerCase() : s).join(' ');
  return out;
}

// Expand the `background` shorthand into every longhand getComputedStyle reports, in computed
// form (position keywords → %, one box → origin+clip, per-layer components comma-joined). A
// CSS-wide keyword applies to all longhands. The final layer's color (or `transparent` when it
// omits one — the shorthand RESETS background-color) becomes background-color.
function expandBackgroundShorthand(value) {
  const v = value.trim();
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(v)) {
    const kw = v.toLowerCase();
    return BG_LONGHANDS.map(([prop]) => ({ prop, value: kw })).concat([{ prop: 'background-color', value: kw }]);
  }
  const layers = splitTopLevel(v, ',').map(s => s.trim());
  const parsed = layers.map((lyr, i) => parseBgLayer(lyr, i === layers.length - 1));
  const out = BG_LONGHANDS.map(([prop, initial]) => ({
    prop,
    value: parsed.map(p => p[prop.slice('background-'.length)] != null ? p[prop.slice('background-'.length)] : initial).join(', '),
  }));
  out.push({ prop: 'background-color', value: parsed[parsed.length - 1].color || 'transparent' });
  return out;
}

// The `mask` shorthand (CSS Masking 1), layer by layer as `background` is: an image, a mode, a position with its size
// after a `/`, a repeat, one or two boxes (origin, then clip — `no-clip` a clip alone) and a compositing operator, each
// longhand its initial where a layer omits it. Unexpanded, every longhand under it read as the initial — `mask: url(#a)
// luminance` gave `mask-mode: match-source` where Chrome and Firefox say `luminance`.
const MASK_LONGHANDS = [
  ['mask-image',     'none'],
  ['mask-mode',      'match-source'],
  ['mask-position',  '0% 0%'],
  ['mask-size',      'auto'],
  ['mask-repeat',    'repeat'],
  ['mask-origin',    'border-box'],
  ['mask-clip',      'border-box'],
  ['mask-composite', 'add']
];
const MASK_MODE_KW = new Set(['alpha', 'luminance', 'match-source']);
const MASK_BOX_KW = new Set(['border-box', 'padding-box', 'content-box', 'fill-box', 'stroke-box', 'view-box']);
const MASK_COMPOSITE_KW = new Set(['add', 'subtract', 'intersect', 'exclude']);
function parseMaskLayer(layer) {
  const out = {};
  const positions = [], sizes = [], repeats = [], boxes = [];
  let afterSlash = false;
  for (const tok of splitTopLevel(layer.replace(/\//g, ' / '), ' ')) {
    const t = tok.trim(), lt = t.toLowerCase();
    if (!t) continue;
    if (t === '/') { afterSlash = true; continue; }
    if (afterSlash && sizes.length < 2 && isBgSizeToken(t)) { sizes.push(/^(cover|contain|auto)$/i.test(t) ? lt : t); continue; }
    afterSlash = false;
    if (lt === 'none' || BG_IMAGE_RE.test(t)) out['mask-image'] = t;
    else if (MASK_MODE_KW.has(lt)) out['mask-mode'] = lt;
    else if (BG_REPEAT_KW.has(lt)) repeats.push(lt);
    else if (MASK_BOX_KW.has(lt)) boxes.push(lt);
    else if (lt === 'no-clip') out['mask-clip'] = lt;
    else if (MASK_COMPOSITE_KW.has(lt)) out['mask-composite'] = lt;
    else positions.push(t);
  }
  if (positions.length) out['mask-position'] = positions.join(' ');
  if (sizes.length) out['mask-size'] = sizes.join(' ');
  if (repeats.length) out['mask-repeat'] = repeats.join(' ');
  if (boxes.length) {
    out['mask-origin'] = boxes[0];
    if (!out['mask-clip']) out['mask-clip'] = boxes[1] || boxes[0];
  }
  return out;
}
function expandMaskShorthand(value) {
  const v = value.trim();
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(v)) return MASK_LONGHANDS.map(([prop]) => ({ prop, value: v.toLowerCase() }));
  const parsed = splitTopLevel(v, ',').map((layer) => parseMaskLayer(layer.trim()));
  return MASK_LONGHANDS.map(([prop, initial]) => ({ prop, value: parsed.map((p) => p[prop] ?? initial).join(', ') }));
}

// The longhands each HAND-written expander owns. Four of these shorthands the CSSOM registry
// doesn't carry at all (`inset`, `background`, `text-decoration`, `font`); `border` it carries with
// a per-side model where the cascade uses a uniform triple. A pending substitution has to fill
// every slot a reader might consult, so `shorthandSlots` fills the UNION of this and the registry's
// list. A slot this table forgets is caught by the literal-vs-`var()` equivalence sweep in
// `spec/shorthand_expansion_spec.rb`, which compares EVERY computed property between the two forms
// — so the table can't quietly drift from the expander beside it.
// Prototype-LESS: this is keyed by property name, and a plain literal answers `shorthandSlots
// ('constructor')` with a Function that the caller would then try to iterate.
const HAND_SLOTS = Object.assign(Object.create(null), {
  border:            ['border-width', 'border-style', 'border-color'],
  inset:             ['top', 'right', 'bottom', 'left'],
  background:        BG_LONGHANDS.map(([p]) => p).concat('background-color'),
  mask:              MASK_LONGHANDS.map(([p]) => p),
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  font:              FONT_SHORTHAND.longhands,
});
// The flow-relative border shorthands expand to `border-<flow-side>-{width,style,color}`, so their
// slots follow the same sides `expandLogicalBorder` writes.
function logicalBorderSlots(prop) {
  const flow  = prop.slice('border-'.length);
  const sides = flow === 'block' ? ['block-start', 'block-end']
              : flow === 'inline' ? ['inline-start', 'inline-end']
              : [flow];
  const out = [];
  for (const side of sides) for (const c of ['width', 'style', 'color']) out.push(`border-${side}-${c}`);
  // The axis-level names the two-sided form also sets — see `expandLogicalBorder`.
  if (sides.length === 2) for (const c of ['width', 'style', 'color']) out.push(`border-${flow}-${c}`);
  return out;
}
// Every longhand `prop` occupies when it is declared, or null when it isn't a shorthand we model.
// Memoised: the answer is a constant per property, and the union allocates.
const SLOTS_MEMO = new Map();
function shorthandSlots(prop) {
  if (SLOTS_MEMO.has(prop)) return SLOTS_MEMO.get(prop);
  const reg  = isRegularShorthand(prop) ? shorthandLonghands(prop) : null;
  const hand = LOGICAL_BORDER_RE.test(prop) ? logicalBorderSlots(prop) : HAND_SLOTS[prop];
  const slots = !reg ? (hand || null) : hand ? [...new Set([...reg, ...hand])] : reg;
  SLOTS_MEMO.set(prop, slots);
  return slots;
}

// Decompose `prop: value` into [longhand, value] pairs — the CSSOM registry's expansion with the
// hand-written one layered over it, or null when the value decomposes into nothing. This is the ONE
// decomposition: the cascade writes through it and the resolved-value read re-expands a pending
// substitution through it, so the two families can't answer differently.
export function expandShorthandValue(prop, value) {
  // A CSS-WIDE KEYWORD is decided here, once, for BOTH families. Only as the SOLE token is it
  // valid, and then it fills every slot the shorthand names (Chrome measured: a child with
  // `border: inherit` / `overflow: inherit` / `margin: inherit` takes the parent's computed value);
  // mixed with anything else the declaration is invalid and contributes nothing (`margin: inherit
  // 1px` computes `0px`). The registry expanders knew this, but each hand-written one classified
  // the keyword as some COMPONENT — `border: inherit` made it a colour, `text-decoration: inherit`
  // likewise, and the longhands came back at their initials instead of inheriting.
  const slots = shorthandSlots(prop);
  if (slots) {
    const toks = splitTopLevel(String(value).trim(), ' ').map(t => t.trim()).filter(Boolean);
    if (toks.some(isCssWideKeyword)) {
      return toks.length === 1 ? slots.map(lh => [lh, toks[0].toLowerCase()]) : null;
    }
  }
  const out = new Map();
  if (isRegularShorthand(prop)) {
    const pairs = shorthandExpand(prop, value);
    if (pairs) for (const [lh, v] of pairs) out.set(lh, v);
  }
  const hand = prop === 'border'     ? expandBorderShorthand(value)
             : prop === 'flex'       ? expandFlexShorthand(value)
             : prop === 'background' ? expandBackgroundShorthand(value)
             : prop === 'mask'       ? expandMaskShorthand(value)
             : prop === 'overflow'   ? expandOverflowShorthand(value)
             : prop === 'text-decoration' ? expandTextDecorationShorthand(value)
             : prop === 'font'       ? expandFontShorthand(value)
             : LOGICAL_BORDER_RE.test(prop) ? expandLogicalBorder(prop, value)
             : (prop === 'margin' || prop === 'padding' || prop === 'inset') ? expandBoxShorthand(prop, value)
             : null;
  // The hand-written expander runs LAST where one exists, because it knows things the generic
  // registry doesn't (`flex: initial` is `0 1 auto`), so its values win. An empty list (how those
  // expanders report a value they reject) contributes nothing — for a shorthand the registry ALSO
  // carries, the registry's pairs still stand, which is what keeps `margin: 1px 2px` working when
  // only one of the two expanders likes it.
  if (hand) for (const d of hand) out.set(d.prop, d.value);
  return out.size ? [...out] : null;
}
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
// A monotonic counter, bumped by a read whose answer depends on something no generation or layout stamp tracks — the
// CLOCK: an animation or a transition reports a different value at a different moment with nothing about the document
// having changed (`noteUncacheableRead`). A memo brackets its read by comparing the counter before and after — which,
// unlike a flag, survives RE-ENTRY: a nested read only pushes it further. Nothing ever resets it.
let uncacheableSeq = 0;
export function dynamicReadSeq() { return uncacheableSeq; }
export function noteUncacheableRead() { uncacheableSeq++; }
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
// …and one element's, given its parent's (`inherited`), for a walk that threads it down: the element's computed value
// already holds what it inherits, so `inherited` stands only where the engine does not style it.
function hidesByVisibility(el, inherited) {
  const v = engineValue(el, 'visibility');
  return v === undefined ? inherited : v === 'hidden' || v === 'collapse';
}
// A run of CSS-collapsible white space — space, tab and newline (CR arrives normalized). NOT JS's
// `\s`, which also matches NBSP and the rest of Unicode's spacing, all of which render; and not the
// form feed either, which Chrome renders (`a\fb` keeps the U+000C).
const COLLAPSIBLE_WS_RUN_RE = /[ \t\n\r]+/g;
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
const TABLE_CELL_TAGS = new Set(['td','th']);
// The table structure itself holds no text: white space between a `<table>` and its rows generates
// no box, even under `white-space: pre` (Chrome: `<table style="white-space:pre">  <td>abc</td>  `
// is "abc"). Anything else there was foster-parented out by the parser long before this walk.
const TABLE_STRUCTURE_TAGS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
// An ATOMIC INLINE renders as one box of its own, so it does not join the collapsible white space
// on either side of it into one run: `abc <img> def` keeps BOTH spaces in Chrome, where `abc <span
// ></span> def` keeps one. It contributes no text of its own here.
const ATOMIC_INLINE_TAGS = new Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'input',
                                    'select', 'textarea', 'button', 'audio', 'svg', 'math']);
function hasNextCellSibling(node) {
  const siblings = node._parent && node._parent._children;
  if (!siblings) return false;
  const i = siblings.indexOf(node);
  for (let j = i + 1; j < siblings.length; j++) {
    const s = siblings[j];
    if (s.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(s._tag)) return true;
  }
  return false;
}
// CSS flex / grid containers blockify their children, so innerText
// joins them with `\n` even when the children are `<a>` / `<span>`
// (Avo's tab switcher: a Tailwind `flex` container of `<a>`s).
const FLEX_LIKE_DISPLAY = new Set(['flex','grid','inline-flex','inline-grid']);
function isFlexLikeContainer(el) {
  const d = engineValue(el, 'display');
  return d !== undefined && FLEX_LIKE_DISPLAY.has(canonicalDisplay(d));
}
// [block-start, block-end, inline-start, inline-end] → physical sides, per writing mode.
const FLOW_SIDES = {
  'horizontal-tb': ['top', 'bottom', 'left', 'right'],
  'vertical-rl':   ['right', 'left', 'top', 'bottom'],
  'vertical-lr':   ['left', 'right', 'top', 'bottom'],
  'sideways-rl':   ['right', 'left', 'top', 'bottom'],
  'sideways-lr':   ['left', 'right', 'bottom', 'top'],
};
// NOT frozen: `twinName` memoises on it, and every element in the default configuration shares
// this one object, which is exactly what makes that memo worth having.
const DEFAULT_FLOW_SIDES = {
  'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right',
  mode: 'horizontal-tb', rtl: false,
};
// The resolved MODE and direction travel with the sides: two writing modes can produce the same
// block sides (`vertical-lr` and `sideways-lr`) while differing on the inline axis, so recovering
// them from the map is guesswork that invents an `rtl` out of nothing.
function sidesFor (wm, rtl) {
  const s = (FLOW_SIDES[wm] || FLOW_SIDES['horizontal-tb']);
  return {
    'block-start': s[0], 'block-end': s[1],
    'inline-start': rtl ? s[3] : s[2], 'inline-end': rtl ? s[2] : s[3],
    mode: FLOW_SIDES[wm] ? wm : 'horizontal-tb', rtl,
  };
}
const ENGINE_FLOW_SIDES = new Map();
function engineFlowSides (wm, rtl) {
  const key = rtl ? wm + ' rtl' : wm;
  let sides = ENGINE_FLOW_SIDES.get(key);
  if (sides === undefined) ENGINE_FLOW_SIDES.set(key, sides = wm === 'horizontal-tb' && !rtl ? DEFAULT_FLOW_SIDES : sidesFor(wm, rtl));
  return sides;
}
export function flowSides (el) {
  // Its computed `writing-mode` and `direction`: the flat-tree inheritance, a `dir` attribute and every CSS-wide keyword
  // resolved by the engine — one object per combination, as this sits on the layout's hot path.
  const wm = engineValue(el, 'writing-mode');
  return wm === undefined ? DEFAULT_FLOW_SIDES : engineFlowSides(wm, engineValue(el, 'direction') === 'rtl');
}
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
  // …and layout's (layout.js): the box and what a pass writes with it, then each memo beside its `…Pass` stamp — the
  // ones a geometry read asks of a page the Rust walk lays out. (The other memos layout.js keeps — the font records, … —
  // are not declared: declaring them for every styled element
  // cost a Redmine page load 2.8% of its main thread.)
  el._lb = undefined; el._lbFrags = undefined; el._lbCbW = undefined; el._lbMargins = undefined;
  el._lbRel = undefined; el._lbRelPass = undefined; el._nlRow = undefined;
  el._ccAt = undefined; el._ccX = undefined; el._ccY = undefined; el._ccScroll = undefined; el._ccVal = undefined;
  el._lbInhDirty = undefined; el._lbInhDirtyPass = undefined; el._lbDisp = undefined; el._lbDispPass = undefined;
  el._lbPos = undefined; el._lbPosPass = undefined;
  el._lbEdge = undefined; el._lbEdgePct = undefined; el._lbEdgeCb = undefined; el._lbEdgeDep = undefined;
  el._lbEdgePass = undefined; el._lbTf = undefined; el._lbTfPass = undefined; el._lbPs = undefined; el._lbPsPass = undefined;
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
// Is this element's inline axis HORIZONTAL? In a vertical writing mode the axes swap, so
// `inline-size` is the height and `block-size` the width.
export function inlineAxisIsHorizontal (el) {
  return flowSides(el)['inline-start'] === 'left' || flowSides(el)['inline-start'] === 'right';
}

// An adopted stylesheet contributes rules only when it is enabled AND its media (if any)
// matches — a `disabled` constructed sheet, or one whose `{media}` excludes this viewport,
// is inert (constructable-stylesheets disabled / media subtests).
function adoptedSheetActive(sheet, vp) {
  if (!sheet || sheet.disabled) return false;
  const media = sheet.media && sheet.media.mediaText;
  return !media || mediaMatches(media, vp);
}
// A constructed sheet's CSS text: the raw `replaceSync` text when present,
// else reconstructed from its rules (a sheet built via `insertRule` has no
// raw text but its cssRules carry each rule's cssText).
function sheetCssText(sheet) {
  if (!sheet) return '';
  if (sheet._cssText) return sheet._cssText;
  const rules = sheet.cssRules;
  if (!rules || !rules.length) return '';
  let out = '';
  for (let i = 0; i < rules.length; i++) out += (rules[i].cssText || '') + '\n';
  return out;
}

// A generation that moves on every insertion or removal (`bumpStructureGen`), and on nothing else: an attribute write
// moves the tree generation (`currentTreeGen`) and not this one. Each realm counts its own from 1.
let structureGen = 1;
export function bumpStructureGen() {
  structureGen = (structureGen + 1) | 0;
}
export function currentStructureGen() { return structureGen; }

// The computed `text-transform` — inherited by the engine — and `none` where it does not style the element.
export function resolveTextTransform (el) {
  return engineValue(el, 'text-transform') ?? 'none';
}
function applyTextTransform (text, mode) {
  if (!text || mode === 'none' || mode === 'initial' || mode === 'unset' || !mode) return text;
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'lowercase') return text.toLowerCase();
  if (mode === 'capitalize') {
    return text.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
  }
  return text;
}
// The four `white-space` values that keep some of their white space, and they do NOT keep it the
// same way: `pre-line` collapses spaces and tabs and preserves only newlines, where the other three
// preserve everything.
const WS_PRESERVING_VALUES = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);
const WS_VALUES = new Set(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']);
export function ownWhiteSpace(el) {
  // Its computed value — one of the keywords, or a combination of the longhands no keyword names, which this model has
  // no mode for — and null where the engine does not style the element.
  const v = engineValue(el, 'white-space');
  return v !== undefined && WS_VALUES.has(v) ? v : null;
}
// The mode in force AT `node`, resolving the inheritance by walking up. O(depth), and the walk
// below pays it ONCE at its root — every element inside gets its parent's answer handed down.
export function inheritedWhiteSpace(node) {
  for (let cur = node; cur; cur = cur._parent) {
    if (cur.nodeType !== NODE_ELEMENT) continue;
    const own = ownWhiteSpace(cur);
    if (own) return own;
  }
  return 'normal';
}
// Does this element generate a box for the rendered-text walk? `<script>`/`<style>` and friends
// never do; fallback content is not rendered either, so `innerText` of a `<canvas>` carrying "your
// browser doesn't support…" is empty in a browser; and the two hiding predicates are the cascade's — the DISPLAY side
// only: `visibility` hides a node's own contribution, not its subtree (`collectText`'s `hidden`), so a hidden element
// stopping the walk here lost a `visibility: visible` child that still reads.
// (…and under the style engine, what it SHOWS: a `display: none` there, and a box that skips its contents — under a
// `content-visibility: hidden`, a `hidden=until-found`'s among them — whose text renders nothing, not even the breaks
// around it: Chrome, "A||" for `A|<div hidden=until-found>uf</div>|`.)
function generatesTextBox(el) {
  if (INVISIBLE_TAGS.has(el._tag) || hasFallbackOnlyContent(el) || uaNotRendered(el)) return false;
  const shown = styleEngineShown(el);
  return shown !== undefined ? shown !== 0 && !styleEngineSkips(el) : !selfHidden(el);
}

// What the last `collectVisibleText` call produced, beyond its string. A collected string cannot
// say whether its whitespace is COLLAPSIBLE (a space between words, which renders nothing against
// a line break) or rendered (a `<br>`, an NBSP, anything under `white-space: pre`), nor whether the
// walk ended owing its parent a break — and the caller needs both. Module-level rather than an
// out-parameter because the walk is depth-first and synchronous: the parent reads them on the line
// after the call returns, and nothing allocates.
let lastCollapsibleOnly = true;   // the string is only collapsible white space
let lastOwedBreaks = 0;           // required line breaks this walk did not write (see the return)
// White-space processing is STREAMING: whether a collapsible space renders depends on what was
// emitted before it, across siblings and across nesting, so the state belongs to the whole walk
// rather than to one element's string. The public entry starts a walk; the recursion below shares
// its state. (Before this, each text node was collapsed on its own and a final pass over the
// finished string did the rest — which could not tell a `<pre>`'s spaces from collapsible ones and
// trimmed them away.)
let emitAtStart = true;              // nothing rendered yet — a leading collapsible space is dropped
let emitEndsCollapsibleSpace = false; // the last thing rendered was a collapsible space
let emitBreakPending = false;         // a required break comes before whatever is collected next
let emitAnyRendered = false;          // anything at all has been rendered by this walk
let walkRoot = null;                  // the element the current walk was asked about
// Whether a host's light child renders is its slot's question, asked once per slot per walk (`slotTextState`) — and so
// is the `visibility` it inherits, which comes through the SLOT, not the host: a span slotted into a hidden shadow box
// is hidden, and one slotted into a visible box inside a hidden host is not (Chrome and Firefox, and our own computed
// style). 0: not rendered; 1: rendered and visible; 2: rendered, visibility-hidden.
let slotRenders = null;
function slotTextState(slot, shadowRoot, hostHidden) {
  if (!slotRenders) slotRenders = new Map();
  let v = slotRenders.get(slot);
  if (v === undefined) {
    if (!isVisibleNodeImpl(slot, true, false, shadowRoot)) {
      v = 0;
    } else {
      // Its `visibility` from the HOST's — which the walk already holds — down the shadow-side ancestors to the slot,
      // not resolved from the slot to the document: that second walk per slot per read doubled the text of an
      // 800-component page.
      const host = shadowRoot._parent, chain = [];
      for (let n = slot; n && n !== host; n = flatTreeParent(n)) chain.push(n);
      let hidden = hostHidden;
      for (let i = chain.length - 1; i >= 0; i--) hidden = hidesByVisibility(chain[i], hidden);
      v = hidden ? 2 : 1;
    }
    slotRenders.set(slot, v);
  }
  return v;
}
export function collectVisibleText(node, transform, preserveWs) {
  walkRoot = node;
  slotRenders = null;
  // The `visibility` the walk starts under: its parent's, resolved once, then threaded down (`hidesByVisibility`).
  const parent = node._parent && node._parent.nodeType === NODE_ELEMENT ? node._parent : null;
  const above = parent ? visibilityHidden(parent) : false;
  emitAtStart = true;
  emitEndsCollapsibleSpace = false;
  emitBreakPending = false;
  emitAnyRendered = false;
  const out = collectText(node, transform, preserveWs, node.nodeType === NODE_ELEMENT ? hidesByVisibility(node, above) : above);
  // A collapsible space at the very END renders nothing either — the last line's trailing edge,
  // which the per-line trim used to take care of before white-space processing moved in here.
  return (emitEndsCollapsibleSpace && out.endsWith(' ')) ? out.slice(0, -1) : out;
}
// `hidden`: whether THIS node's `visibility` hides it (for a text node, its parent's). innerText §2: a node whose
// `visibility` is not `visible` contributes its CHILDREN's items and nothing of its own — no text, no `<br>` newline, no
// required line breaks — so a `visibility: visible` child of a hidden element still reads (Chrome and Firefox: "b").
function collectText(node, transform, preserveWs, hidden = false) {
  lastCollapsibleOnly = true;
  lastOwedBreaks = 0;
  if (node.nodeType === NODE_TEXT && hidden) return '';
  if (node.nodeType === NODE_TEXT) {
    const data = String(node.data || '');
    // Recursion threads `preserveWs` from the entering element, but
    // a direct text-node entry (rare) has no flag — fall back to the
    // ancestor walk in that case.
    // A direct text-node entry (rare) has no mode threaded in — resolve it from the ancestors.
    if (preserveWs === undefined) preserveWs = node._parent ? inheritedWhiteSpace(node._parent) : 'normal';
    // CSS Text §white-space processing, per node: a run of collapsible white space renders as ONE
    // space, and `pre-line` collapses spaces and tabs while keeping its newlines. Doing it here —
    // rather than over the finished string — is what lets a `<pre>` inside a `white-space: normal`
    // parent keep its spaces.
    // `pre-line` renders only its newlines: its spaces and tabs collapse like `normal`'s, and the
    // ones that end up beside a newline disappear with it (Chrome: `abc \n def` is "abc\ndef").
    // `normal` / `nowrap` collapse everything; `pre-line` collapses spaces and tabs and keeps its
    // newlines; the other three keep it all.
    const preserving = WS_PRESERVING_VALUES.has(preserveWs);
    const collapsesSpaces = !preserving || preserveWs === 'pre-line';
    let raw = preserveWs === 'pre-line' ? data.replace(/[ \t\f]+/g, ' ').replace(/ ?\n ?/g, '\n')
            : preserving               ? data
            :                            data.replace(COLLAPSIBLE_WS_RUN_RE, ' ');
    let outText = applyTextTransform(raw, transform || 'none');
    // …and the run that CROSSES nodes: a collapsible space renders nothing when what came before it
    // was one, or when nothing has been rendered yet. `<b>a </b> b` is "a b", and " abc" is "abc".
    if (collapsesSpaces && outText.startsWith(' ') &&
        (emitAtStart || emitEndsCollapsibleSpace || emitBreakPending)) {
      outText = outText.slice(1);
    }
    // CSS collapsible white space is exactly ` \t\n\r\f` — NOT JS's `\s`, which also matches
    // NBSP, the ideographic space and the rest of Unicode's spacing, every one of which RENDERS.
    // And text that PRESERVES its white space is never collapsible.
    // `pre-line` collapses its spaces and tabs like `normal` does — only its newlines are
    // rendered — so a run of them next to a break disappears just the same.
    lastCollapsibleOnly = collapsesSpaces && !/[^ \t\n\r\f]/.test(outText) &&
                          !(preserving && outText.indexOf('\n') !== -1);
    if (outText) {
      emitAtStart = false;
      emitBreakPending = false;
      if (!lastCollapsibleOnly) emitAnyRendered = true;
      emitEndsCollapsibleSpace = collapsesSpaces && outText.endsWith(' ');
    }
    return outText;
  }
  if (node.nodeType !== NODE_ELEMENT && node.nodeType !== NODE_DOC && node.nodeType !== NODE_FRAGMENT) return '';
  if (node.nodeType === NODE_ELEMENT) {
    // Nothing under a box-less element is rendered text. `generatesTextBox` is the same question
    // the child loop below asks about an EMPTY block, so the two can't drift.
    if (!generatesTextBox(node)) return '';
    // …and the newline a `<br>` renders is a FORCED break: it survives beside a required one
    // (`abc<div><br></div>def` is three breaks in Chrome), where a collapsed space would not. It is
    // what the `<br>` contributes to the text AROUND it, though — asked for its OWN `innerText`, a
    // `<br>` has no content and answers "" (`getter.html`'s `<br>` case reads the element itself).
    // A `<textarea>`'s content is its VALUE, not rendered text: it contributes nothing to an
    // ancestor's `innerText` (Chrome measured — the wrapper of a textarea holding "a  b" is ""),
    // while the element asked about ITSELF still answers with its value, which is what Capybara
    // reads (`__csimInnerText`'s own textarea case).
    if (node._tag === 'textarea' && node !== walkRoot) return '';
    if (node._tag === 'br') {
      // (…a `display: contents` one is no break: it behaves as `none` on a `<br>`, and layout draws `aa<br>bb` on one
      // line — Chrome's innerText is `aabb`.)
      if (node === walkRoot || hidden || !globalThis.__csimGeneratesBox(node)) return '';
      lastCollapsibleOnly = false;
      emitAnyRendered = true;
      return '\n';
    }
    const effTransform = engineValue(node, 'text-transform') ?? (transform || 'none');
    // `preserveWs` is sticky: once an ancestor has `white-space: pre*`
    // (or is `<pre>`), every descendant text node preserves whitespace,
    // so threading the flag down beats walking ancestors per text node.
    // `white-space` INHERITS, so the mode is threaded DOWN and an element that declares its own
    // replaces it — a `white-space: normal` span inside a `<pre>` folds its spaces (Chrome), which
    // a sticky "is preserving" flag could not express. Threading also means each element reads its
    // own declaration once: no ancestor walk, no memo, no depth cap.
    preserveWs = ownWhiteSpace(node) || preserveWs || 'normal';
    if (node._tag === 'details' && node._attrs.open == null) {
      // Closed details: only emit text inside <summary>.
      let s = '';
      for (const c of node._children) {
        if (c.nodeType === NODE_ELEMENT && c._tag === 'summary') s += collectText(c, effTransform, preserveWs, hidesByVisibility(c, hidden));
      }
      return s;
    }
    transform = effTransform;
  }
  const flexContext = node.nodeType === NODE_ELEMENT && isFlexLikeContainer(node);
  let out = '';
  // Required line breaks are PENDING until something is written after them, because they MERGE
  // (innerText §4: consecutive requirements collapse to the largest) and because collapsible
  // white-space next to one renders nothing. Writing each break as it was met made
  // `abc<hr> <hr>def` two breaks around a space where every browser gives one.
  let pending = 0;
  // Whether everything written here is collapsible white space, and the breaks this walk ends up
  // owing — the two things `lastCollapsibleOnly` / `lastOwedBreaks` report to the caller.
  let collapsibleOnly = true;
  // Whether `out` currently ends in a space, tracked rather than asked. `out` is built by repeated
  // `+=`, which V8 keeps as a cons string; `endsWith` flattens it, and doing that once per child at
  // every level was the whole of this walk's cost over the previous one (measured: 113 ms to 106).
  let outEndsSpace = false;
  // Writing a required break also ENDS a line, and a collapsible space either side of one renders
  // nothing: `abc <div>x</div>` is "abc\nx", not "abc \nx". The trailing half is stripped here (it
  // is the tail of what this level has written), the leading half by the text branch, which sees
  // the flag this leaves behind.
  // Writing the owed breaks is INLINE at both sites below, never a closure: one arrow function per
  // element — capturing and mutating `out` and `pending` — costs a heap-allocated context per call
  // and measured 48% of this walk (`innertext_rendered_text`). `spaceBefore` there is the state as
  // it stood BEFORE the child being written was collected: collecting it has already moved the
  // flags, and the space to drop is the one that preceded it.
  // A shadow HOST renders its light children only through the slots they are assigned to — none, or a slot that is
  // itself not rendered, and they are no part of its text (Chrome: `""` for a host whose children no rendered slot
  // takes, where this read "UH"). The walk does not descend the shadow tree itself (see the carve-out below).
  // The host itself was reached through rendered ancestors, so the slot is asked only as far as its shadow root, and
  // once per walk: asked all the way to the document for every light child, the text of an 800-component page took
  // 2.5x as long.
  const host = node.nodeType === NODE_ELEMENT && node._shadowRoot;
  for (const c of node._children) {
    let inherited = hidden;
    if (host) {
      const slot = c._assignedSlot !== undefined ? c._assignedSlot : assignedSlotFor(c);
      const state = slot ? slotTextState(slot, host, hidden) : 0;
      if (!state) continue;
      inherited = state === 2;
    }
    // Whitespace-only text nodes between flex/grid items don't
    // produce visible runs (no anonymous flex item is generated
    // for whitespace).
    if (flexContext && c.nodeType === NODE_TEXT && !/\S/.test(String(c.data || ''))) continue;
    // …white space only: text put there by the DOM (`tr.appendChild(document.createTextNode(…))`)
    // is wrapped in an anonymous cell and RENDERS. The parser foster-parents such text out, so
    // this is the script-built case, and skipping it lost real content.
    if (c.nodeType === NODE_TEXT && node.nodeType === NODE_ELEMENT &&
        TABLE_STRUCTURE_TAGS.has(node._tag) && !/\S/.test(String(c.data || ''))) continue;
    const spaceBefore = emitEndsCollapsibleSpace;
    // …and whether anything has been rendered at all, sampled BEFORE this child is collected: a
    // required break SEPARATES, so with nothing in front of it there is nothing to separate. Asking
    // this element's own `out` instead answered "nothing" for a block that merely opens an inline
    // (`abc<span><div></div>def</span>` lost the break Chrome puts before `def`).
    const renderedBefore = emitAnyRendered;
    // Whatever is collected next opens a line if a break is already owed, so a collapsible space
    // at its start renders nothing either.
    if (pending) emitBreakPending = true;
    const isElement = c.nodeType === NODE_ELEMENT;
    const cHidden = isElement ? hidesByVisibility(c, inherited) : inherited;
    const part = collectText(c, transform, preserveWs, cHidden);
    const partCollapsible = lastCollapsibleOnly;
    // What the child itself left behind. Writing the owed breaks below sets the flag to "a
    // collapsible space was last", which is true of the BREAK but not of the part written after
    // it — and the next strip then ate a PRESERVED space (`<p>b  </p>` under `pre-wrap` lost one).
    const partEndsCollapsibleSpace = emitEndsCollapsibleSpace;
    const isCell = isElement && TABLE_CELL_TAGS.has(c._tag);
    // An atomic inline separates the white space around it even though it contributes no text of
    // its own — and it is skipped by the empty-child gate below, so this is settled first.
    if (isElement && ATOMIC_INLINE_TAGS.has(c._tag) && generatesTextBox(c)) {
      emitEndsCollapsibleSpace = false;
      emitAtStart = false;
      emitBreakPending = false;
    }
    // A td/th whose content includes a BLOCK box acts like a block at the tr-level: \n before AND
    // after, to produce `"A\n\t\nB"` between adjacent cells (W3C innerText §14.4). A cell whose
    // content is pure inline text emits only the `\t` separator — Chrome `tr.innerText` for
    // `<td>A</td><td>B</td>` is `"A\tB"`. The question is STRUCTURAL: the walk reports the breaks
    // the cell owes, where sniffing its string for a `\n` missed a cell holding exactly one block
    // (whose trailing break, by the rule at the return below, it never writes) and misfired on a
    // `<br>`, which renders a newline without being a block.
    const isCellWithInnerBlock = isCell && lastOwedBreaks > 0;
    // (…and a `<br>` that is no line break — block-level, floated, absolutely positioned — is a block like any other:
    // innerText gives it the required breaks either side of its newline, `aa\n\n\nbb` as the spec's algorithm and
    // Firefox have it.)
    const isBlock = isElement && !cHidden && (BLOCK_TAGS.has(c._tag) || flexContext || isCellWithInnerBlock ||
                                  (c._tag === 'br' && globalThis.__csimGeneratesBox(c) && !globalThis.__csimIsLineBreak(c)));
    // A block-level child that RENDERS contributes its line breaks even when it holds no text of
    // its own: `abc<div></div>def` is "abc\ndef" in every browser, and an `<hr>` — which can hold
    // nothing at all — is the same shape. A `display: none` sibling returns the same empty string
    // and must contribute nothing, so the question is whether the BOX exists, not the string.
    // …with one carve-out: a shadow HOST. Capybara pins an empty-looking host between two inlines
    // as a SPACE (its own `#shadow_root` fixture, node_spec.rb), and this walk does not descend
    // into a shadow tree, so it has nothing to put between the breaks either way. Chrome does
    // break there; matching it would need the walk to collect the shadow tree first.
    // `generatesTextBox` is asked LAST — it resolves the cascade, and the recursive call above has
    // already paid for that on every child that isn't empty.
    if (!part && !isCell && !(isBlock && !c._shadowRoot && generatesTextBox(c))) continue;
    // A `<p>` asks for TWO breaks — a blank line either side — and keeps asking for them whatever
    // its `display` is (Chrome: `123<p style="display:inline-block">abc` is still "123\n\nabc").
    // …and a cell passes on what its own content asked for, so a `<td>` holding a `<p>` still puts
    // a blank line before the next cell (Chrome: "A\n\n\tB").
    const breaks = isElement && c._tag === 'p' ? 2 : Math.max(1, isCell ? lastOwedBreaks : 1);
    if (isBlock && out) pending = Math.max(pending, breaks);
    // …and white space that is COLLAPSIBLE renders nothing against a break: the space in
    // `abc<hr> <hr>def` sits between two of them and disappears. What is collapsible is the CHILD's
    // question, not this element's — a `<pre>` inside a `white-space: normal` parent keeps its
    // spaces, an NBSP is not collapsible anywhere, and a `<br>`'s newline is a forced break.
    if (part && !(pending && partCollapsible)) {
      if (pending) {
        if (spaceBefore && outEndsSpace) { out = out.slice(0, -1); outEndsSpace = false; }
        // …and a break SEPARATES: with nothing left before it there is nothing to separate, which
        // is the case an atomic inline creates (`<input> <div>abc</div>` is "abc" — the input
        // renders but contributes no text, and the space it kept apart has just been stripped).
        if (renderedBefore) {
          out += pending === 1 ? '\n' : '\n'.repeat(pending);
          emitEndsCollapsibleSpace = true;
          emitAnyRendered = true;
        }
        pending = 0;
        emitAtStart = false;
        emitBreakPending = false;
      }
      // A `<br>` ends a line the same way a required break does, so the collapsible space either
      // side of one renders nothing (`abc <br> def` is "abc\ndef"). It arrives as a part that
      // BEGINS with the newline it renders, rather than as a break this level owes.
      else if (spaceBefore && !partCollapsible && part.startsWith('\n') && outEndsSpace) {
        out = out.slice(0, -1);
      }
      out += part;
      outEndsSpace = part.endsWith(' ');
      emitEndsCollapsibleSpace = partEndsCollapsibleSpace;
      if (part.endsWith('\n')) { emitEndsCollapsibleSpace = true; emitBreakPending = false; }
      if (!partCollapsible) collapsibleOnly = false;
    }
    if (isBlock) pending = Math.max(pending, breaks);
    // (…and a hidden cell adds its children's items and no separator of its own: innerText §2 comes before the tab.)
    if (isCell && !cHidden && hasNextCellSibling(c)) {
      if (pending) {
        if (spaceBefore && outEndsSpace) { out = out.slice(0, -1); outEndsSpace = false; }
        if (renderedBefore) { out += pending === 1 ? '\n' : '\n'.repeat(pending); }
        pending = 0;
        emitAtStart = false;
        emitBreakPending = false;
        emitEndsCollapsibleSpace = true;
      }
      out += '\t';
      emitAnyRendered = true;
      outEndsSpace = false;
      emitEndsCollapsibleSpace = false;
      collapsibleOnly = false;
    }
  }
  // …taken from what the CHILDREN reported, never re-derived from the string: a `<pre>` full of
  // spaces looks collapsible in the output and is not (`x<pre>   </pre>y` keeps them in Chrome).
  lastCollapsibleOnly = collapsibleOnly;
  lastOwedBreaks = pending;
  // A trailing required break is deliberately NOT written: this element's own block-ness is the
  // PARENT's business, and it raises the same requirement there. Writing it here as well gave
  // `abc<table><td>def</table>ghi` a break per nesting level — three — where each boundary asks
  // for one. A literal newline in preserved text is text and stays, which is the distinction the
  // old "count the newlines already at the end" version could not make.
  return out;
}
