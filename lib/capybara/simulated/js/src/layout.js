// The layout's ENTRY, its WRITER and its READERS. The layout itself is the Rust walk (ext/csim_native/src/walk.rs, which
// builds a record per box from the arena and the style engine) laid out by ext/csim_native/src/layout.rs — what it
// models, and what it deliberately does not, is documented there. This module asks for a pass when a geometry read
// needs one (`ensureLayout` → `nativeLayoutPass` → `nlRustPass`); the pass keeps its boxes in the arena (geometry.rs),
// which every reader here asks (`boxOf`). A page the walk declines has the root's box alone (`layoutRootAlone`), counted
// by reason (`__csimNativeLayoutStats`).
//
// The page-visible geometry surface reads that layout through this module — `getBoundingClientRect` /
// `elementFromPoint` / `offset*` / `client*` / `scroll*`, the resolved CSSOM values that are used values, and the paint
// support (`recordingRuns`) — so the driver and the page's own JS never disagree about where anything is. The geometry
// itself is native (geometry.rs: the boxes, the scroll shift, the transform chain, the scrollable overflow region;
// hit_test.rs: the painting order and the hit test); what stays here is the arithmetic the CSSOM surface does over it,
// the per-element predicates those readers share (`displayOf`, `layoutChildren`, …) and the text metrics the painter
// measures with (`charAdvances`).
//
// Frames compose ACROSS REALMS rather than across one tree: a frame document lays itself out in its
// own realm, against its container's content box as the viewport, and occlusion walks OUT one frame
// at a time (see "Frame (nested browsing context) geometry" below).
//
// Cost: laid out once per (settleGen, layout epoch, dirty sequence) — the gate in `ensureLayout` (inline / attribute
// edits bump settleGen; stylesheet / CSSOM edits the epoch; restyle marks the dirty sequence). It is
// pay-per-use for a page with no live IntersectionObserver: nothing lays out until something asks
// for geometry. A page that HAS one pays a pass per rendering update in which the DOM changed,
// because that is when observers are delivered (measured: a Discourse slice 6:20 → 7:14).

import { NODE_ELEMENT, HTML_NS }                       from './constants.js';
import { walkInclShadow, flatTreeParent }                from './walk.js';
import {
  maybeVerifyArena, scrollOffsetOf, scrollShiftOf, stickyOffsetOf, laidOutBoxOf, renderedBoxOf, transformChainOf,
  layoutRootAloneIn, clippedAwayOf, hitTestIn, paintOrderIn, scrollSizeOf, boxInfoOf, fragmentsIn, containingBlockOf,
  arenaNid, REALM as NATIVE_REALM
} from './native-query-shadow.js';
import { isLaidOutNode, styleEngineNow, selfNotRendered, resolveLayoutProp, hasFallbackOnlyContent, rendersObjectFallback, cascadeLayoutEpoch, settleLayoutInvalidation, inlineAxisIsHorizontal, flowSides, ownWhiteSpace, declareStyledMemos, flushStyleEngine, currentStructureGen, engineValue } from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { advanceTableFor, faceStackFor, rangesCover, natFontGen, teachFaces } from './font-metrics.js';
// Box props are read through `declaredValue` — the style engine's computed values, which getComputedStyle reads too:
// ONE geometry means one value resolution.
import { usedDisplay, WIDGET_TAGS, renderingTag, displayAsLaidOut, declaredValue, computedFontSizePx, computedLineHeight, computedFontFamily, fontKeyOf, computedLetterSpacingText, computedWordSpacingText, spacingAt, textAlignOf, textIndentOf, tabSizeOf, pseudoNodeFor, linkGeneratedBox, placeholderNodeFor, isListBox, inputType, buttonInputLabel, homographyOf, applyHomography, computedPositionOf, computedFloatOrClear } from './style-proxy.js';
import { INITIAL_VALUES } from './css-utils.js';
import { selectDisplaySize } from './html-integers.js';

const LINE_HEIGHT = 19;     // fallback line box when the font size can't be resolved
// `line-height: normal` is font-dependent; browsers land near 1.15-1.2x the font
// size for the default UI faces (Chrome measured: 13px -> 15, 16px -> 18-19,
// 20px -> 23). One factor over the used font-size is far closer than the flat 19px
// this used, which made every non-16px block the wrong height.
const NORMAL_LINE_FACTOR = 1.16;

// Bumped once per layout pass. Per-element results that are only valid within a pass (used display,
// subtree text length) are stamped with it, so each element is measured ONCE however many times its
// ancestors ask — an editor whose every token is a nested `<span>` made the un-memoised walks
// quadratic and typing into it timed out.
let layoutPass = 0;
// `layoutChildren`'s per-pass memo — replaced wholesale when the pass advances. See `layoutChildren`.
let FLAT_CHILDREN = new globalThis.WeakMap();

function settleGen()     { return globalThis.__settleGenGet     ? globalThis.__settleGenGet()     : 0; }
// A per-element memo survives across layout PASSES: what it measured is still true until something
// touched the element (or, for a subtree measurement, anything inside it) or the cascade changed.
// `markLayoutDirty` stamps `_lbDirty`; a memo records the stamp and the cascade version it was
// computed under. Keyed on the pass instead, every pass re-measured the whole document — a
// mutate-then-read pair on a 300-row table cost 34 ms where this costs 8.
// The sequence at which anything ABOVE this element last invalidated its subtree — a `class` write
// on an ancestor, which changes what the text inside it measures. Walked on the READ side, where
// one walk serves every memo the element has, instead of on the write side where it would be
// O(subtree) per mutation. Memoised per element per pass: the chain does not move during one.
function inheritedDirty(el) {
  if (el._lbInhDirtyPass === layoutPass) return el._lbInhDirty;
  if (el._styled === false) declareStyledMemos(el);
  const parent = flatTreeParent(el);
  const above = parent ? inheritedDirty(parent) : 0;
  const own = el._lbSubDirty || 0;
  const v = own > above ? own : above;
  el._lbInhDirtyPass = layoutPass;
  el._lbInhDirty = v;
  return v;
}
// The cascade side of every layout memo is the LAYOUT epoch (`cascadeLayoutEpoch`): the rule-set
// version. A dynamic style state a selector reads (`:placeholder-shown`, `:checked`, hover / focus …)
// reaches a box through the marks the style engine's restyle makes (`markRestyles`), each memo's
// dirty stamp: keyed on the epoch alone with nothing marking it, `#t:placeholder-shown { width:
// 300px }` once kept its 300px box after the field was filled.
function memoStamp(el) {
  let d = el._lbDirty || 0;
  // A LEGEND's answers move with its fieldset's: the fieldset's other children decide whether it is the RENDERED one
  // (HTML §15.3.13), and no stamp of its own sees them — hiding the first legend, or a `display: contents` wrapper
  // around it, left the next one sized and placed as before. Any change under the fieldset stamps the fieldset.
  if (el._tag === 'legend') {
    const f = enclosingFieldset(el);
    if (f && f._lbDirty > d) d = f._lbDirty;
  }
  const i = inheritedDirty(el);
  return ((d > i ? d : i) * 4294967296) + cascadeLayoutEpoch();
}
function enclosingFieldset(el) {
  let f = flatTreeParent(el);
  while (f && f._tag !== 'fieldset') f = flatTreeParent(f);
  return f;
}
function memoFresh(el, key) {
  const m = el[key];
  return m !== undefined && m === memoStamp(el);
}

// The box the CURRENT layout gave `el` (geometry.rs `box_info`) — in DOCUMENT coordinates, an inline box's the union of
// its fragments (`fragmented` where it broke over more than one line, `fragmentsOf`) — with what the pass placed it
// by: the basis its percentages resolved against (`cbW`), the margins its placement used, its edges as it used them,
// whether it is out of flow and placed against the viewport, and how it clips. Null where it gave it none: one not
// rendered, or no element of the arena at all.
// Kept per element for the layout pass (`_lbBox` at `_lbBoxPass`): the edge reads ask it of every box over and over —
// one of this realm's arena only, whose passes `layoutPass` counts.
const INFO = new Float64Array(32);
const NL_OOF_FIXED = 2;
function boxOf(el) {
  if (!el) return null;
  if (el._lbBoxPass === layoutPass && arenaNid(el) >= 0) return el._lbBox;
  const box = readBox(el);
  if (arenaNid(el) >= 0) {
    if (el._styled === false) declareStyledMemos(el);
    el._lbBox = box;
    el._lbBoxPass = layoutPass;
  }
  return box;
}
function readBox(el) {
  if (!hasLayoutBox(el)) return null;
  const f = INFO;
  return {
    x: f[0], y: f[1], width: f[2], height: f[3], fragmented: f[4] > 1,
    cbW: f[5] === f[5] ? f[5] : null,
    margins: f[6] === f[6] ? { top: f[6], right: f[7], bottom: f[8], left: f[9] } : null,
    edges: f[12] === f[12] ? passEdges(f, 12) : null, edgesPct: (f[24] & 16) !== 0,
    outOfFlow: f[25] !== 0, fixed: f[25] === NL_OOF_FIXED && f[26] === 1, clip: f[29]
  };
}
// …whether it gave it one at all, leaving that box in `INFO`.
export function hasLayoutBox(el) {
  return !!el && el._nid >= 0 && boxInfoOf(el, INFO);
}
// …an inline box's fragments, `{x, y, width, height}` each in document coordinates, in the order the lines broke it.
function fragmentsOf(el) {
  const f = fragmentsIn(el), out = [];
  for (let k = 0; k + 3 < f.length; k += 4) out.push({ x: f[k], y: f[k + 1], width: f[k + 2], height: f[k + 3] });
  return out;
}
// The edges a pass used, off `f` at `o` — padding, border and margin, each top / right / bottom / left, an `auto` margin as
// 0, then the `auto` mask — in `edgesOf`' form: each side's padding and border, the borders alone, the margins.
function passEdges(f, o) {
  const bt = f[o + 4], br = f[o + 5], bb = f[o + 6], bl = f[o + 7];
  return { top: f[o] + bt, right: f[o + 1] + br, bottom: f[o + 2] + bb, left: f[o + 3] + bl,
           mt: f[o + 8], mr: f[o + 9], mb: f[o + 10], ml: f[o + 11], bt, br, bb, bl, autoMargins: f[o + 12] & 15 };
}

// The marks for what a change restyled since the last ones: the elements the style engine's restyle replaced the style
// of (`__dom.styleRestyled`) — it decides what a class, a state or a sheet reaches. The layout memos on this side, and
// the early returns keyed on the dirty sequence, read those marks.
function markRestyles() {
  const doc = globalThis.document;
  if (!globalThis.__dom || !doc || !doc.documentElement) return;
  flushStyleEngine();
  const nids = globalThis.__dom.styleRestyled();
  if (nids.length === 0) return;
  const mark = globalThis.__csimMarkRestyled;
  if (nids[0] === -1) { mark(doc.documentElement); return; }   // (…more than it keeps: everything)
  const byNid = nlNodesByNid(doc.documentElement);
  for (let i = 0; i < nids.length; i++) {
    const el = byNid.get(nids[i]);
    if (el !== undefined) mark(el);
  }
}

// …answered for a reader in another realm holding a node of this one's arena, before it reads that node's geometry.
NATIVE_REALM.ensureLayout = ensureLayout;
function ensureLayout() {
  const doc = globalThis.document;
  if (!doc || !doc.documentElement) return;
  maybeVerifyArena();   // CSIM_ARENA_VERIFY: the arena mirrors the tree a pass is about to read
  // The restyle marks are made HERE — before the gate reads its keys and before `layoutPass++` — never mid-pass, where
  // fresh marks are invisible to the per-pass inheritedDirty memo; and the rule set is made known first, a changed sheet
  // being a restyle too (`settleLayoutInvalidation`).
  settleLayoutInvalidation();
  markRestyles();
  // …and so do the marks for what the streaming parser inserted since the last pass (`noteParsedChange`), and for the
  // `dir=auto` scopes a mutation may have turned around (`markDirAutoScopes`).
  globalThis.__csimFlushPendingMarks();
  // The dirty sequence is the gate's third key: the restyle marks move NEITHER settleGen nor
  // the epoch — without it, a focus flip's marks would sit unread behind an early return.
  const gen = settleGen(), cv = cascadeLayoutEpoch();
  const ds = globalThis.__csimDirtySeq ? globalThis.__csimDirtySeq() : 0;
  if (doc._layoutGen === gen && doc._layoutCV === cv && doc._layoutDS === ds) return;
  doc._layoutGen = gen; doc._layoutCV = cv; doc._layoutDS = ds;
  layoutPass++;
  FLAT_CHILDREN = new globalThis.WeakMap();   // …the per-pass memo `layoutChildren` keeps, see there
  // The viewport this document lays out against — the top-level one, or our container frame's
  // content box. Resolved once per layout pass (it needs a cross-realm call; see viewport()).
  doc._layoutVP = computeViewport();
  // The Rust walk lays the page out, from the root element. What it lays nothing out for — an SVG or other XML
  // document's root, which is no box it lays out, or a page it declined (counted by reason, `__csimNativeLayoutStats`)
  // — has the root's box alone.
  const root = doc.documentElement;
  if (root._ns === HTML_NS && nativeLayoutPass(root)) return;
  layoutRootAlone(doc);
}

// A document the Rust walk lays nothing out for still has a ROOT box: as wide as the viewport (or its declared width), its
// declared height else none, and an extent the viewport tall (Chrome: an SVG document hit-tests its root). Nothing else
// is laid out — and none of the boxes an earlier pass placed under it stays, which nothing here replaces.
function layoutRootAlone(doc) {
  const root = doc.documentElement;
  if (!root) return;
  NL_PAINT_RUNS = null;
  const vp = doc._layoutVP;
  const width = resolveLayoutProp(root, 'width', vp.width) ?? vp.width;
  layoutRootAloneIn(root, { width, height: resolveLayoutProp(root, 'height', vp.height) ?? 0 }, vp);
}

// The page laid out by the Rust walk (`nlRustPass`) — or false where it declined; `__csimNativeLayoutStats` counts both,
// the declines by reason.
const NATIVE_LAYOUT_STATS = { rust: 0, rustFellBack: {} };
globalThis.__csimNativeLayoutStats = () => NATIVE_LAYOUT_STATS;
function nativeLayoutPass(root) {
  const r = nlRustPass(root);
  if (!r.ok) {
    NATIVE_LAYOUT_STATS.rustFellBack[r.reason] = (NATIVE_LAYOUT_STATS.rustFellBack[r.reason] || 0) + 1;
    return false;
  }
  NATIVE_LAYOUT_STATS.rust++;
  if (r.paintRuns) NL_PAINT_RUNS = r.paintRuns;
  return true;
}
// The pass the RUST walk builds (`__dom.layoutBuild`): its records built in native from the arena and the style engine's
// own values, and laid out there (layout.rs), its boxes kept in the arena — answered with the text pieces of a pass a
// painter records, or the faces it needs first, or the generated boxes it needs linked, or its decline, by name.
function nlRustPass(root) {
  const d = globalThis.__dom;
  if (!d || typeof d.layoutBuild !== 'function' || root._nid == null) return { ok: false, reason: 'rust: no __dom' };
  // (…a paint's recording pass asks each text piece as the painter draws it: its text and the element it was written in
  // beside where it sits — walked whole, nothing spliced back or put back)
  const painting = PAINTING;
  // (…the style engine's values brought up to date first: the walk reads them straight off the arena, through no read
  // that would flush them)
  flushStyleEngine();
  const vp = viewport(), gen = natFontGen();
  let answer;
  for (let round = 0; ; round++) {
    answer = d.layoutBuild(root._nid, gen, vp.width, vp.height, painting,
                           globalThis.__csimNativeLayoutVerifyReuse === true);
    // (…a put-back measure that laid out differently, under `CSIM_NL_REUSE_VERIFY`, is a bug to surface, not a pass to
    // decline: a decline would hide it)
    if (typeof answer === 'string' && answer.startsWith('reuse mismatch')) throw new NlReuseMismatch(answer);
    if (typeof answer === 'string') return { ok: false, reason: `rust: ${answer}` };
    // (…a BUILT pass is taken whichever round it comes on; only a fourth request is one too many)
    const built = answer === true || (Array.isArray(answer) && typeof answer[0] !== 'string');
    if (built) break;
    if (round === 3) return { ok: false, reason: 'rust: faces or boxes unresolved' };
    // (…the generated boxes it found rendering and no node linked for: made and linked, and walked again)
    if (answer && answer.boxes) {
      const byNid = nlNodesByNid(root);
      for (let k = 0; k < answer.boxes.length; k += 2) {
        const el = byNid.get(answer.boxes[k]);
        if (el) linkGeneratedBox(el, answer.boxes[k + 1] ? 'after' : 'before');
      }
      NL_NODES_BY_NID = null;   // (…the boxes just linked are in no map yet)
      continue;
    }
    if (!Array.isArray(answer)) return { ok: false, reason: 'rust: unexpected answer' };
    teachFaces(d, answer);
    flushStyleEngine();   // (…a face a font metric was computed without restyles the realm: `walk_face`)
  }
  // (…and the text pieces a painting pass asked for: `[x, y, baseline, width, justify, owner nid]` beside each text, as
  // the runs `recordingRuns` hands the painter)
  if (!painting) return { ok: true, paintRuns: null };
  const [paintRows, paintTexts] = answer;
  let byNid = nlNodesByNid(root), remade = false;
  const nodeOf = (nid) => {
    let el = byNid.get(nid);
    if (el === undefined && !remade) {
      remade = true;
      byNid = nlNodesByNid(root, true);
      el = byNid.get(nid);
    }
    return el;
  };
  const paintRuns = [];
  for (let k = 0, i = 0; k < paintRows.length; k += 6, i++) {
    const owner = paintRows[k + 5] >= 0 ? nodeOf(paintRows[k + 5]) : null;
    if (owner === undefined) return { ok: false, reason: 'rust: text run without a node' };
    paintRuns.push({ text: paintTexts[i], x: paintRows[k], y: paintRows[k + 1], baseline: paintRows[k + 2], owner, block: null,
                     width: paintRows[k + 3], justify: paintRows[k + 4], tabFrom: 0, tab: null });
  }
  return { ok: true, paintRuns };
}
// Every element the pass can hold a record for, by nid: the flat tree's, shadow trees included, and their generated
// boxes (`pseudoNodeFor`'s, which no tree holds) — kept while no node is inserted or removed (`currentStructureGen`: a
// text edit, most passes, moves nothing it maps), a walk of the whole tree per pass otherwise. A generated box linked
// since is no insertion: a nid the map does not hold has it made again once (`nlRustPass`'s `nodeOf`).
let NL_NODES_BY_NID = null;
function nlNodesByNid(root, fresh = false) {
  const gen = currentStructureGen();
  const kept = NL_NODES_BY_NID;
  if (!fresh && kept !== null && kept.root === root && kept.gen === gen) return kept.map;
  const byNid = new globalThis.Map();
  NL_NODES_BY_NID = { root, gen, map: byNid };
  walkInclShadow(root, (n) => {
    if (n.nodeType !== NODE_ELEMENT || n._nid == null) return;
    byNid.set(n._nid, n);
    const ps = n._pseudoNodes;
    if (ps !== undefined) {
      if (ps.before && ps.before._nid != null) byNid.set(ps.before._nid, ps.before);
      if (ps.after && ps.after._nid != null) byNid.set(ps.after._nid, ps.after);
    }
  });
  return byNid;
}
// The reuse check (`CSIM_NL_REUSE_VERIFY`): the pass walked and laid out again with no reuse — every record built, no
// block put back — and what that answered held against the reusing pass's, box by box and fragment by fragment
// (walk_ops.rs). It checks what a kept block does end to end, its placing included; a difference in an input that moves
// no box is not one it can see, and needs none. The kept MEASURES are checked besides, against laying the subtree out
// again on the spot, which sees what a measure writes that no box shows (a record, a count).
class NlReuseMismatch extends Error {}


// ── CSS-embedded image resources (Resource Timing) ────────────────────────────────────────────
// A browser fetches a `background-image` / `cursor` / `list-style-image` `url()` when a rendered
// element uses it, at the rendering update, filing a `css` Resource Timing entry. The driver does
// not paint backgrounds yet, so this fetch is for TIMING (and future painting): once per URL, over
// the rendered tree, and only when the document declares such a url() (`__csimDocHasCssImage`, O(1))
// and the tree / cascade changed since the last pass — so a settled page pays nothing.
const CSS_IMG_SEEN = new globalThis.Set();
const CSS_URL_RE   = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
let cssImgGen = null;
function fetchCssImage(url, type) {
  let abs = url;
  try { abs = new globalThis.URL(url, (globalThis.document && globalThis.document.baseURI) || undefined).href; } catch (_) {}
  if (CSS_IMG_SEEN.has(abs)) return;
  CSS_IMG_SEEN.add(abs);
  const started = globalThis.performance ? globalThis.performance.now() : 0;
  let r = null;
  try { r = globalThis.__csim_loadImage ? globalThis.__csim_loadImage(abs, false, 'same-origin') : null; } catch (_) { r = null; }
  if (typeof globalThis.__csimRecordResource !== 'function') return;
  const meta = (r && r.meta) || null;
  const size = meta && meta.encoded != null ? meta.encoded | 0 : ((r && r.encoded) | 0);
  globalThis.__csimRecordResource({ name: abs, initiatorType: type, startTime: started,
                                    encoded: size, decoded: size,
                                    status: meta ? (meta.status || 200) : undefined, redirected: !!(meta && meta.redirected),
                                    headers: meta ? { 'content-type': meta.contentType || '', 'timing-allow-origin': meta.tao } : null,
                                    noCors: true });
}
function collectCssImageUrls(value, out) {
  if (!value || value === 'none') return;
  CSS_URL_RE.lastIndex = 0;
  let m;
  while ((m = CSS_URL_RE.exec(value))) { const u = m[2].trim(); if (u && !/^data:/i.test(u)) out.push(u); }
}
function fetchCssImagesOf(el) {
  // The legacy `<body background>` presentational attribute — its own Resource Timing initiator, and taken FIRST: the
  // style engine folds it into the computed `background-image` (a presentational hint), which would otherwise fetch
  // it as `css`.
  if (el._tag === 'body' && el._attrs && el._attrs.background) fetchCssImage(el._attrs.background, 'body');
  const out = [];
  collectCssImageUrls(declaredValue(el, 'background-image'), out);
  collectCssImageUrls(declaredValue(el, 'cursor'), out);
  collectCssImageUrls(declaredValue(el, 'list-style-image'), out);
  for (let i = 0; i < out.length; i++) fetchCssImage(out[i], 'css');
}
// The rendering-update pass: called from the event loop after `flushAnimationFrame`.
export function flushCssImages() {
  const doc = globalThis.document;
  if (!doc || !doc.documentElement) return;
  const bodyBg = doc.body && doc.body._attrs && doc.body._attrs.background;
  if (!bodyBg && typeof globalThis.__csimDocHasCssImage === 'function' && !globalThis.__csimDocHasCssImage()) return;
  // Gate on the CASCADE version, NOT the settle generation: the latter bumps on every DOM mutation
  // (mutation-observer.js), which under an rAF/timer loop that mutates would re-run this whole O(N)
  // walk every frame. The cascade version moves only when stylesheets do — the walk runs on first
  // render and when styling changes, catching the resources a page declares. (Cost: an element
  // added later with no cascade change is picked up at the next cascade change, not at once —
  // acceptable for a timing-only fetch of a resource the driver does not paint.)
  const gen = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  if (gen === cssImgGen) return;                                // no style change since the last pass
  cssImgGen = gen;
  ensureLayout();                                              // rendered boxes exist to walk
  const walk = (el) => {
    if (!el || el.nodeType !== NODE_ELEMENT) return;
    if (displayOf(el) === 'none') return;                      // a `display:none` subtree isn't rendered
    fetchCssImagesOf(el);
    const sr = el._shadowRoot;
    if (sr && sr._children) for (const c of sr._children) walk(c);
    const kids = el._children;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };
  walk(doc.documentElement);
}
globalThis.__csimFlushCssResources = flushCssImages;

// ── Frame (nested browsing context) geometry ─────────────────────────────────────────────────
// A frame document lays itself out in ITS OWN realm — own stylesheets, own generation — so
// geometry across a frame boundary can't be composed by walking one tree. It is composed by
// ASKING the parent realm: its `__csimFrameContentBox` / `__csimFrameObscuredAt` globals run with
// the parent's own layout state and hand back plain data. (`__csim*` names bypass the cross-origin
// Window gate, matching a real browser: a cross-origin frame is still sized, clipped and occluded
// by its container even though script can't reach across.)

// This document's container `<iframe>` plus the realm that owns it, or null at the top level
// (where `frameElement` is null and `parent` is the window itself).
function containerFrame() {
  const fe = globalThis.__csimFrameContainer;
  if (!fe) return null;
  // A disposed / cross-origin parent can throw on either read (`__csim*` names bypass the SOP gate,
  // but a torn-down realm doesn't) — no reachable container then, so this document is its own top.
  try {
    const par = globalThis.parent;
    if (par && par !== globalThis && typeof par.__csimFrameObscuredAt === 'function') return { par, fe };
  } catch (_) {}
  return null;
}

// This document's viewport size: the container frame's content box, else the top-level viewport.
// Coarse: the iframe's border box stands in for its content box (no UA frame border modelled) —
// the same approximation Selenium's `obscured?` makes when it maps a frame-local point through the
// container's `getBoundingClientRect()`.
function computeViewport() {
  // The container's content box is PUSHED in by the parent when the frame realm is built
  // (`__csimFrameViewport`), never pulled across realms from here. Layout runs on the page's own
  // `getBoundingClientRect` path, and re-entering another realm from inside that callback trips a
  // V8 stack assertion (`IsOnCentralStack`) — a hard crash, seen on the Avo suite. Reading a plain
  // global costs nothing and can't re-enter. The parent re-pushes on a window resize
  // (`__csimRefreshFrameViewports`), so a frame follows `resize_to` like everything else; a frame
  // whose CONTAINER is resized by page script keeps its box until the next re-push (coarse).
  const pushed = globalThis.__csimFrameViewport;
  if (pushed) return { width: pushed.width, height: pushed.height };
  // In a frame whose parent pushed nothing (an unrendered container — display:none, detached), the
  // viewport is EMPTY: nothing inside a non-rendered frame is clickable, and falling back to the
  // top-level size would report its content as in-view.
  if (globalThis.__csimFrameContainer) return { width: 0, height: 0 };
  // Top level: the WINDOW viewport — the driver-owned `__csimViewport` that `innerWidth` /
  // `innerHeight` and the `@media` cascade also read, so a breakpoint flip and the boxes it moves
  // are computed against one size. `__csimSetViewport` invalidates the layout when it moves.
  return currentViewport();
}

// The generation geometry is valid for. Two calls with the same value can't produce different
// boxes, so a repeated observer pass over unchanged geometry can return immediately. Scrolling is
// NOT in it (it moves rendered boxes without touching either counter) — the scroll path forces its
// own update instead.
export function layoutGeneration() {
  // The dirty sequence for the same reason as the pass gate's third key: the restyle marks move
  // neither counter, and the IntersectionObserver recheck early-returns on this. Defensive in
  // practice — a settle step usually moves settleGen before the next rendering update anyway — but
  // a microtask-only turn between a flip and a recheck would slip through. The marks are made here
  // too: `ds` only moves once they are, and a flip nobody read geometry after would otherwise sit
  // undetected behind this early return.
  settleLayoutInvalidation();
  markRestyles();
  const ds = globalThis.__csimDirtySeq ? globalThis.__csimDirtySeq() : 0;
  return `${settleGen()}:${cascadeLayoutEpoch()}:${scrollEpoch}:${ds}`;
}

// Scrolling moves every rendered box without touching either counter, so it gets its own tick in the
// generation above — that is how the rendering update knows an IntersectionObserver pass has real
// work to do after `scrollTo`.
let scrollEpoch = 0;
export function bumpScrollEpoch() {
  scrollEpoch++;
  // A scroll requests a rendering update (observers.js schedules one; a plain global keeps layout
  // free of an import cycle through the observer module).
  if (typeof globalThis.__csimScheduleIntersectionUpdate === 'function') globalThis.__csimScheduleIntersectionUpdate();
}

// Force the next geometry query to lay out again. The memo below is keyed on (settleGen,
// cascadeVersion) — neither of which moves when the WINDOW is resized or when this document's
// container frame is, so whoever changes a viewport says so explicitly.
export function invalidateLayout() {
  const doc = globalThis.document;
  if (!doc) return;
  doc._layoutGen = null;
  doc._layoutCV  = null;
  doc._layoutDS  = null;
  doc._layoutVP  = null;
}

// The viewport of the CURRENT layout pass. Cached with the layout itself, so a container resize
// that doesn't touch this document's own generation is picked up on its next relayout (coarse).
function viewport() {
  const doc = globalThis.document;
  return (doc && doc._layoutVP) || computeViewport();
}

// ── Flat tree ────────────────────────────────────────────────────────────────────────────────
// What gets laid out is the FLAT tree, not the node tree: a shadow host renders its shadow tree
// (its light children appear only through the `<slot>` they're assigned to), and a slot renders its
// assigned nodes — or its own children as fallback when nothing is assigned. Read through the
// node's own `assignedNodes()` / `assignedSlot`, so the assignment rules stay in one place
// (dom-nodes.js) instead of being re-derived here.
// A REPLACED element renders no generated content (CSS Pseudo-Elements 4 §4: `::before` /
// `::after` do not apply to them; Chrome: an `<img>` / `<input>` / `<select>` / `<textarea>` with
// a `content` rule is unchanged, a `<button>` or an `<hr>` renders it) — nor does a `<progress>` / `<meter>`, laid out
// as a leaf of its own size (Chrome draws none either). The walk's list is the same (walk.rs `NO_GENERATED_CONTENT`).
const NO_GENERATED_CONTENT = new globalThis.Set(['img', 'input', 'textarea', 'select', 'iframe', 'video', 'audio', 'canvas', 'object', 'embed', 'svg', 'br', 'wbr', 'frame', 'progress', 'meter']);
// …except a CUSTOMIZABLE select (`appearance: base-select`), which is an ordinary box with a
// picker and renders its `::before` / `::after` (Chrome; `select-grid-before-after`).
function isBaseSelect(el) {
  if (el._tag !== 'select' || !declaresLayoutProp(el, 'appearance')) return false;
  return String(declaredValue(el, 'appearance') || '').trim().toLowerCase() === 'base-select';
}
// The FLAT TREE's children of an element, plus its generated content — what the DOM hands layout, before any
// layout rule is applied to it. Almost nothing wants this: the children a box actually LAYS OUT are
// `layoutChildren`'s, which looks through a `display: contents` element to the children that stand in for it.
// Ask for this one only where the question is about the tree itself rather than about boxes.
function flatTreeChildren(el) {
  // A replaced element renders its own bitmap or widget and NEVER its contents: a `<canvas>`'s
  // fallback content, an `<iframe>`'s "your browser doesn't support frames" markup and a
  // `<video>`'s fallback are all in the DOM and generate no boxes at all. Until the painter drew
  // a canvas this was invisible; then every canvas WPT reftest showed its fallback text painted
  // OVER the drawing. The same set gates visibility and visible text (cascade.js), so a node that
  // has no box also can't be found or read.
  if (hasFallbackOnlyContent(el)) return NO_CHILDREN;
  const sr = el._shadowRoot;
  let kids;
  if (sr) kids = sr._children || NO_CHILDREN;
  else if (el._tag === 'slot' && typeof el.assignedNodes === 'function') {
    const assigned = el.assignedNodes();
    kids = assigned && assigned.length ? assigned : el._children || NO_CHILDREN;   // else fallback
  } else kids = el._children || NO_CHILDREN;
  // GENERATED CONTENT: a `::before` box is the element's first child and an `::after` its last
  // (CSS Pseudo-Elements 4 §4) — as nodes the flow lays out like any other, made by
  // `pseudoNodeFor` and no part of the DOM. Asked only of a real element that can generate any (a pseudo generates none of its own, a replaced element none).
  if (!el._pseudo &&
      !(NO_GENERATED_CONTENT.has(el._tag) && !isBaseSelect(el))) {
    // Memoised per layout PASS (the cascade is fixed within one): this is the hottest walk in the engine — four calls per element — and
    // resolving both pseudos per call cost a 6000-element page a third of its relayout, a
    // `memoStamp` per call (an ancestor walk) a tenth.
    let ps;
    if (el._lbPsPass === layoutPass) ps = el._lbPs;
    else {
      el._lbPsPass = layoutPass;
      const before = pseudoNodeFor(el, 'before'), after = pseudoNodeFor(el, 'after');
      ps = el._lbPs = before || after ? { before, after } : null;
    }
    if (ps !== null) {
      const out = ps.before ? [ps.before] : [];
      for (let i = 0; i < kids.length; i++) out.push(kids[i]);
      if (ps.after) out.push(ps.after);
      return out;
    }
  }
  return kids;
}

// A box that CONTAINS the out-of-flow boxes inside it whatever its own `position` is: one with a
// transform, a filter, a perspective, layout / paint containment, or a `will-change` naming any of
// those (css-position §fixpos-cb / css-transforms §transform-rendering). It is the containing
// block for FIXED descendants too, which is the only thing that ever takes one off the viewport —
// Chrome-measured: `top: 10%` on a fixed box inside a `transform: scale(1)` 300px-tall block is
// 30px, where the viewport would make it 76.8.
//
// Each property is behind the initial-value gate (`declaresLayoutProp`) and the whole answer is memoised per pass, but
// that is not what keeps this cheap on a real page — app sheets declare `transform` constantly. What does
// is the order of the walk in `containingBlockElementFor`: an ordinary absolute box stops at its
// positioned ancestor without ever asking the question.
//
// A TRANSFORM only applies to a transformable box, so only such a box contains through one — a
// `transform` on a non-replaced `display: inline` span changes nothing at all, and neither does one
// on a box that generates none (Chrome-measured: a fixed box inside `<span style="transform:
// scale(1)">` still measures against the viewport). A FILTER is the exception: it contains whatever
// the box is.
const TRANSFORM_PROPS = ['transform', 'perspective', 'translate', 'rotate', 'scale'];
const FILTER_PROPS = ['filter', 'backdrop-filter'];
const WILL_CHANGE_CONTAINING = new globalThis.Set(['transform', 'perspective', 'translate', 'rotate',
                                                   'scale', 'filter', 'backdrop-filter', 'contain',
                                                   'content-visibility']);
const CONTAIN_RE = /(^|\s)(layout|paint|content|strict)(\s|$)/i;
// Whether `will-change` names one of `names` — whole names: `will-change: transform-origin` names no containing
// property (Chrome-measured), and `\btransform\b` matched inside it.
function willChangeNames(el, names) {
  if (!declaresLayoutProp(el, 'will-change')) return false;
  const v = declaredValue(el, 'will-change');
  return !!v && String(v).split(',').some((name) => names.has(name.trim().toLowerCase()));
}
function containsOutOfFlow(el) {
  if (memoFresh(el, '_lbCofPass')) return el._lbCof;
  el._lbCofPass = memoStamp(el);
  return (el._lbCof = computeContainsOutOfFlow(el));
}
function declaresNonNone(el, prop) {
  if (!declaresLayoutProp(el, prop)) return false;
  const v = declaredValue(el, prop);
  return v != null && v.toLowerCase() !== 'none';
}
function computeContainsOutOfFlow(el) {
  for (const prop of FILTER_PROPS) if (declaresNonNone(el, prop)) return true;
  if (!isTransformable(el)) return false;
  for (const prop of TRANSFORM_PROPS) if (declaresNonNone(el, prop)) return true;
  if (declaresLayoutProp(el, 'contain')) {
    const v = declaredValue(el, 'contain');
    if (v && CONTAIN_RE.test(String(v))) return true;
  }
  if (declaresLayoutProp(el, 'content-visibility')) {
    // Both non-`visible` values imply layout containment (css-contain §content-visibility), so both
    // contain — Chrome-measured for `hidden` and for `auto` alike.
    const v = String(declaredValue(el, 'content-visibility') || '').trim().toLowerCase();
    if (v === 'hidden' || v === 'auto') return true;
  }
  return willChangeNames(el, WILL_CHANGE_CONTAINING);
}
// css-transforms §transformable-element: everything but a non-replaced inline box and the table
// column boxes — and a box that is not generated at all.
function isTransformable(el) {
  const disp = displayOf(el);
  if (disp === 'contents' || disp === 'none') return false;
  if (disp === 'table-column' || disp === 'table-column-group') return false;
  if (isSplitInline(el)) return false;
  return disp !== 'inline' || !!intrinsicSize(el);
}

// The element an out-of-flow box resolves against: the nearest POSITIONED ancestor that has been
// laid out — or, whatever its own position, one that CONTAINS out-of-flow boxes, which is the only
// answer a fixed box takes. `null` when there is none: the box is positioned against the initial
// containing block, i.e. the viewport.
//
// NEVER the root element: the walk takes the viewport instead (walk.rs `containing_block`), and this answers as the
// boxes were placed. A recorded divergence: Chrome positions against a positioned `<html>`'s box.
function containingBlockElementFor(el, fixed) {
  const docEl = el.ownerDocument && el.ownerDocument.documentElement;
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    // `display: contents` generates no box, so it is nobody's containing block however it is
    // positioned or transformed.
    if (!hasLayoutBox(p) || p === docEl || p.nodeType !== NODE_ELEMENT || displayOf(p) === 'contents') continue;
    // A POSITIONED ancestor is the answer either way, so an ordinary absolute box never pays the
    // containment question at all.
    if (!fixed && positionOf(p) !== 'static') return p;
    if (containsOutOfFlow(p)) return p;
  }
  return null;
}
// That element's PADDING box — what CSS positions against and what a percentage inset resolves
// against, which with real borders is no longer its border box.
function paddingBoxOf(p) {
  const box = inlineContainingBox(p);
  const bw = borderWidthsOf(p);
  return {
    x: box.x + bw.left,
    y: box.y + bw.top,
    width:  Math.max(0, box.width  - bw.left - bw.right),
    height: Math.max(0, box.height - bw.top  - bw.bottom)
  };
}

// The containing BLOCK that element is — the viewport when there is none.
function containingBlockBox(p) {
  if (p) return paddingBoxOf(p);
  const vp = viewport();
  return { x: 0, y: 0, width: vp.width, height: vp.height };
}
function containingBlockFor(el, fixed) {
  return containingBlockBox(containingBlockElementFor(el, fixed));
}

// Elements whose size comes from the element itself rather than from its content. Replaced elements
// with no intrinsic size get the CSS "default object size" (300×150) — an `<iframe>` with no
// width/height is 300×150 in every browser — and form controls get their UA intrinsic size (these
// are Chrome's, measured). Without the control sizes a text input measures 0 tall, since it has no
// text children, and so does any row built around one: a page that divides by a row's height takes
// the wrong branch (Discourse's sidebar reorder decides insert-above from
// `event.offsetY < rect.height / 2`).
//
// These are CONTENT boxes: the layout adds the element's own edges, and a control's UA border and
// padding are real edges (see `uaDefault`'s control chrome). Chrome-measured border boxes, minus
// that chrome — a text `<input>` is 185x21 with its 2px border and 1px/2px padding, so 177x15 here.
//
// The width/height CONTENT attributes are presentational hints and arrive through
// `resolveLayoutProp`, so this is only the no-declaration default. (`<img>` is deliberately absent:
// its intrinsic size is the decoded image's, which we don't have.)
const OBJECT_SIZE   = { width: 300, height: 150 };
const REPLACED_TAGS = new Set(['iframe', 'frame', 'embed', 'video']);
// Prototype-less, because the key is a TAG NAME off the page: `<constructor>` reached
// `Object.prototype.constructor` here and handed a FUNCTION back as an intrinsic size.
const CONTROL_SIZES = Object.assign(Object.create(null), {
  input:    { width: 177, height: 15 },
  textarea: { width: 195, height: 36 },
  // An `<audio>` is a box only while it shows controls (the UA sheet hides the rest), and then it
  // is the widget Chrome draws: 300x54, measured.
  audio:    { width: 300, height: 54 },
  // Chrome-measured, and neither carries UA chrome of its own.
  meter:    { width:  80, height: 16 },
  progress: { width: 160, height: 16 }
});
const CHECKBOX_SIZE = { width: 13, height: 13 };
const FILE_SIZE     = { width: 253, height: 21 };      // Chrome-measured; the widget is a button
                                                       // plus the UA's own "No file chosen" label,
                                                       // so it is locale-dependent in a browser.
const RANGE_SIZE    = { width: 129, height: 16 };      // Chrome-measured, and it has no chrome
const COLOR_SIZE    = { width: 44,  height: 23 };      // 50x27 less its 1px border / 1px,2px padding
const ZERO_SIZE     = { width: 0,   height: 0 };       // `<input type=image>` with nothing decoded
// The date / time family, which sizes to the SEGMENTS it shows rather than to a `size` attribute.
// Chrome-measured border boxes (124.33 / 103 / 210.33 / 154.33 / 146.33 x 24), less the 2px border
// and 1px horizontal padding of their chrome. Locale-dependent in a real browser exactly as the
// file widget's "No file chosen" label is.
const DATE_SIZES = Object.assign(Object.create(null), {
  date:               { width: 118.33, height: 20 },
  time:               { width:  97,    height: 20 },
  'datetime-local':   { width: 204.33, height: 20 },
  month:              { width: 148.33, height: 20 },
  week:               { width: 140.33, height: 20 }
});
const BROKEN_IMAGE_SIZE = { width: 16, height: 16 };   // Chrome's box for an img that hasn't decoded

// A BUTTON is not a replaced element: it is as wide as its label, plus its chrome. `<button>` gets
// that for free by laying its children out (hence its absence from CONTROL_SIZES), but a button
// `<input>` has no children — its label is the `value` attribute, or the UA's own word for the type
// — so its content box is that string MEASURED in the control's font, exactly as a text run is.
// Chrome: `<input type=submit>` is 57.48x21 and `value="Go"` 33.78x21, both 16px of which is the
// chrome. Sizing every one of them 185 wide (the text-field default) made a row of submit buttons
// several times too wide, and none of them the width of the words on it.
//
// WHICH types those are — and what the UA calls them — is the chrome table's to say
// (`buttonInputLabel`), so the box a control gets and the label it is measured by cannot drift.
// …and a NEWLINE in the value is a line break, not a space and not nothing (Chromium 922011):
// `value="1&#10;2"` is a two-line button as wide as one digit, 23.42x36 in Chrome against 30.83x21
// for `"12"`. Measured per line, and the box is as wide as the widest and as tall as all of them.
// Memoised on the layout stamp, as `selectIntrinsic` is — the label is an attribute's, or the type's (a button's
// `value` is in the "default" mode: setting it sets the attribute) — since the gates ask the size of every replaced
// atomic on an edit's spine, and measuring a button's label again for each was an eighth of a relayout on Redmine's
// login page.
const LABEL_BREAK_RE = /\r\n|\r|\n/;
function buttonInputSize(el, label) {
  if (memoFresh(el, '_lbButtonPass')) return el._lbButton;
  let size;
  if (!label) size = { width: 0, height: lineHeightOf(el) };
  else {
    const lines = String(label).split(LABEL_BREAK_RE);
    let width = 0;
    for (const line of lines) width = Math.max(width, measureRun(line, el));
    size = { width, height: lines.length * lineHeightOf(el) };
  }
  el._lbButton = size;
  el._lbButtonPass = memoStamp(el);
  return size;
}

// A `<select>` is as wide as its WIDEST OPTION, plus room for the drop-down arrow — not a
// constant. Chrome-measured, and the two families differ: a DROPDOWN's content box is the widest
// option + 20, rounded UP to whole px (border-box 22 empty, 30 for `a`, 52 for `bbbb`, 45 for
// `one`, 179 for a 25-char label — all five exact), while a LISTBOX has no arrow and no rounding,
// + 19 (43.25 for `one` at `size=4`, 177.34 for the long one — both exact). Height is one 17px row
// per displayed row.
//
// Memoised per pass: a country `<select>` holds 250 options and every one is measured. Before
// this the width was a flat constant, so every select on a page was the same width whatever it
// held — and the one Chrome number it matched was whichever option length the constant came from.
const SELECT_ROW_H       = 17;
const SELECT_ARROW_W     = 20;
const SELECT_LISTBOX_PAD = 19;
function selectIntrinsic(el) {
  if (memoFresh(el, "_lbSelPass")) return el._lbSel;
  const listbox = isListBox(el);
  const widest  = widestOptionWidth(el, el, 0);
  el._lbSel = {
    width:  listbox ? widest + SELECT_LISTBOX_PAD : Math.ceil(widest + SELECT_ARROW_W),
    height: SELECT_ROW_H * (listbox ? selectDisplaySize(el) : 1)
  };
  el._lbSelPass = memoStamp(el);
  return el._lbSel;
}
// The widest option LABEL in `node`'s subtree, measured in the select's font. Walks rather than
// reading the child list because options live inside `<optgroup>` (and, in a customizable
// `<select>`, inside arbitrary wrappers), and an option's label is its `label` attribute when it
// has one, else its text — HTML's own definition.
//
// An `<optgroup>` INDENTS the options under it, which widens the control by exactly that indent
// (Chrome: a select holding one 25-char option is 179, and 194 with that option inside an
// optgroup). Its own LABEL does not — a group labelled `a very long group label indeed` over one
// `x` option is 44 wide, the same as an unlabelled group over the same option.
const OPTGROUP_INDENT = 15;
function widestOptionWidth(node, select, widest, indent = 0) {
  for (const child of node._children || NO_CHILDREN) {
    if (child.nodeType !== NODE_ELEMENT) continue;
    if (child._tag !== 'option') {
      widest = widestOptionWidth(child, select, widest,
                                 child._tag === 'optgroup' ? indent + OPTGROUP_INDENT : indent);
      continue;
    }
    // HTML's rendering label: the `label` attribute when it has one "and its value is not the
    // empty string", else the option's text. `label=""` is a real idiom in form builders, and
    // taking it literally measured every such option as empty.
    const attr = child._attrs && child._attrs.label;
    const label = (attr != null && String(attr) !== '') ? String(attr) : collectText(child, '');
    const w = indent + optionWidth(label, select);
    if (w > widest) widest = w;
  }
  return widest;
}
function optionWidth(text, select) {
  return measureRun(collapseRun(text, select, true), select);
}
function collectText(node, out) {
  for (const child of node._children || NO_CHILDREN) {
    if (child.nodeType === 3) out += child._data || child.data || '';
    else if (child.nodeType === NODE_ELEMENT) out = collectText(child, out);
  }
  return out;
}
const NO_CHILDREN = [];

// (Every figure here comes from the DOM, the cascade and the FONT — a decoded image's natural size, an `<svg>`'s
// viewBox, a control's UA chrome, the widest `<option>` measured in the select's own font — and none of it from a
// layout. Its `_lbSvg` / `_lbSel` stamps are its own memos, as `tableGrid`'s are.)
function intrinsicSize(el) {
  const t = renderingTag(el);
  if (REPLACED_TAGS.has(t)) return OBJECT_SIZE;
  // An `<object>` showing its fallback content is not replaced at all (`rendersObjectFallback`);
  // an `<embed>` with no resource gets no box whatsoever, which is `uaNotRendered`'s half of the
  // same rule.
  if (t === 'object') return rendersObjectFallback(el) ? null : OBJECT_SIZE;
  // An `<img>` is as big as the image it decoded — the driver already records that as
  // `_naturalWidth`/`_naturalHeight` — and 16x16 while it hasn't (Chrome's broken/placeholder box,
  // verified). Without this an image had no intrinsic size at all: it took a whole line's height in
  // an inline run and its containing block's width, so a click aimed at its centre missed it.
  // A `<canvas>` is as big as its BACKING STORE: `width`/`height` are the buffer's dimensions
  // (300x150 when unset), not a layout hint, and the painter stretches that buffer into whatever
  // box CSS ends up giving it. Without this a canvas has no intrinsic size at all and gets a box
  // only through the width/height presentational hints — which holds a `display: inline` canvas
  // at 0x0, since a fragmenting inline with no intrinsic size and (now) no children is nothing.
  if (t === 'canvas') return { width: el.width, height: el.height, ratio: true };
  if (t === 'img') {
    const w = el._naturalWidth, h = el._naturalHeight;
    // A decoded image is the only thing here with a REAL aspect ratio (`ratio: true`) — the 300x150
    // default object size is not one, so an `<iframe height="10">` must stay 300 wide rather than
    // being scaled to 20.
    return (w > 0 && h > 0) ? { width: w, height: h, ratio: true } : BROKEN_IMAGE_SIZE;
  }
  if (t === 'input') {
    const type = inputType(el);
    if (type === 'checkbox' || type === 'radio') return CHECKBOX_SIZE;
    if (type === 'file')  return FILE_SIZE;
    if (type === 'range') return RANGE_SIZE;
    if (type === 'color') return COLOR_SIZE;
    // An `image` input IS an image: no chrome, and no box until something decodes (Chrome: 0x0,
    // or the `width`/`height` presentation attributes when it has them).
    if (type === 'image') return ZERO_SIZE;
    const date = DATE_SIZES[type];
    if (date) return date;
    const label = buttonInputLabel(el);
    if (label !== null) return buttonInputSize(el, label);
    return CONTROL_SIZES.input;
  }
  if (t === 'svg')    return svgIntrinsic(el);
  if (t === 'select') return selectIntrinsic(el);
  return CONTROL_SIZES[t] || null;
}

// An `<svg>` is a replaced element sized by CSS Images 4 §4: its `viewBox` gives an intrinsic
// RATIO but no intrinsic SIZE, so with both axes auto it behaves like any other ratio-only
// replaced box — the width fills its container and the height follows the ratio. Chrome measured,
// in a 1000px block: `viewBox="0 0 4 3"` alone is 1000x750; with `height: 250px` and
// `viewBox="0 0 100 101"` it is 247.52 wide; with NOTHING at all it falls back to the 300x150
// default object size.
//
// Without this every icon on a page had no intrinsic size at all: a `<svg class="h-4">` filled its
// container's whole width, and one with no CSS height collapsed to zero — which put a
// full-width invisible box over Avo's page and swallowed the clicks aimed underneath it.
function svgIntrinsic(el) {
  // Memoised per pass like `selectIntrinsic`: every caller that asks what an inline box is worth
  // asks this too, and re-parsing the `viewBox` string each time is real work on an icon-heavy
  // page (Avo's tables carry hundreds).
  if (memoFresh(el, '_lbSvgPass')) return el._lbSvg;
  // Its `width` / `height` ATTRIBUTES are its intrinsic dimensions where they are absolute lengths (SVG 2 §8.2, CSS
  // Images §4.1: a percentage is no intrinsic size), and the `viewBox` its ratio, which supplies a missing one of the
  // two; with neither, the default object size. Read off the viewBox alone, `<svg width="16" height="16">` — every
  // icon set's markup — was 300 wide as a flex item, whose basis is the intrinsic width (Chrome: 16, and 32 x 16 for
  // `width="2em" height="1em"`).
  const vb = parseViewBox(el);
  const w = svgAttrLength(el, 'width'), h = svgAttrLength(el, 'height');
  el._lbSvg = w != null && h != null ? { width: w, height: h, ratio: true }
            : w != null ? { width: w, height: vb ? w * vb.height / vb.width : OBJECT_SIZE.height, ratio: !!vb }
            : h != null ? { width: vb ? h * vb.width / vb.height : OBJECT_SIZE.width, height: h, ratio: !!vb }
            : vb ? { width: vb.width, height: vb.height, ratio: true, ratioOnly: true } : OBJECT_SIZE;
  el._lbSvgPass = memoStamp(el);
  return el._lbSvg;
}
// An SVG sizing attribute as an ABSOLUTE length in px, or null — a percentage, `auto` and anything unparseable are no
// intrinsic dimension. (A bare number is px, and the font-relative units resolve against the element's own font.)
function svgAttrLength(el, name) {
  const raw = el._attrs && el._attrs[name];
  if (raw == null) return null;
  const m = /^\s*(\d*\.?\d+)(px|em|rem)?\s*$/i.exec(String(raw));
  if (!m) return null;
  const n = parseFloat(m[1]), unit = (m[2] || 'px').toLowerCase();
  const root = globalThis.document && globalThis.document.documentElement;
  return unit === 'px' ? n : n * (unit === 'em' ? computedFontSizePx(el) : (root ? computedFontSizePx(root) : 16));
}
// The `viewBox="minX minY width height"` presentation attribute, as a positive ratio.
function parseViewBox(el) {
  const raw = el._attrs && el._attrs.viewBox;
  if (raw == null) return null;
  const n = String(raw).trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || !n.every((v) => isFinite(v))) return null;
  return (n[2] > 0 && n[3] > 0) ? { width: n[2], height: n[3] } : null;
}
// …and whether the initial containing block STARTS at its right, where the root then sits and the viewport scrolls from
// (walk.rs `principal_starts_right`): a horizontal principal writing mode's inline start under `rtl`, a vertical one's
// block start under `vertical-rl` / `sideways-rl` — `direction` has no say on a vertical mode's horizontal axis.
function principalStartsRight(el) {
  const sides = flowSides(principalElement(el));
  const start = sides['block-start'];
  return start === 'top' || start === 'bottom' ? !!sides.rtl : start === 'right';
}
// The element whose writing mode is the principal one (CSS Writing Modes 3 §8): the root's `<body>` child where it has
// one, else the root itself.
function principalElement(el) {
  const body = el._tag === 'html' && el._children
    ? el._children.find((c) => c.nodeType === NODE_ELEMENT && (c._tag === 'body' || c._tag === 'frameset')) : null;
  return body || el;
}

function positionOf(el) {
  if (memoFresh(el, '_lbPosPass')) return el._lbPos;
  el._lbPosPass = memoStamp(el);
  return (el._lbPos = computePosition(el));
}
function computePosition(el) {
  // The COMPUTED position (`computedPositionOf`): a CSS-wide keyword resolved as `getComputedStyle` has it — handed on
  // as itself, `unset` was an unknown position that every route of the walk refused (Discourse's user card, on every
  // page: `block-level-box-unplaceable` at `#main-outlet`, 215 of 365 page states probed).
  return computedPositionOf(el);
}

// ── Box edges: border + padding + margin ─────────────────────────────────────
// The edges of `el`'s box as the pass laid it out (geometry.rs `box_info`; a box the pass gave none of its own — a
// table row, an inline box — as its style declares them): `{top, right, bottom, left}` each side's padding and border,
// `bt`…`bl` the borders alone, `mt`…`ml` the margins (an `auto` one as 0) and the `autoMargins` mask. All zero for an
// element with no box.
const NO_EDGES = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0, mt: 0, mr: 0, mb: 0, ml: 0, bt: 0, br: 0, bb: 0, bl: 0,
                                 autoMargins: 0 });
function edgesOf(el) {
  const b = el && el.nodeType === NODE_ELEMENT ? boxOf(el) : null;
  return b && b.edges ? b.edges : NO_EDGES;
}

// `box-sizing: border-box` makes a declared width/height the BORDER box; the default
// `content-box` makes it the content box, so the edges add on top.
function isBorderBox(el) {
  // `box-sizing` does not inherit by default, but `box-sizing: inherit` is half of
  // the classic reset (`*, *::before { box-sizing: inherit }`), so an explicit
  // inherit has to walk up or the reset silently does nothing.
  let cur = el;
  for (let i = 0; cur && cur.nodeType === NODE_ELEMENT && i < 64; i++) {
    const v = declaredValue(cur, 'box-sizing');
    const s = v == null ? '' : String(v).trim().toLowerCase();
    if (s === 'border-box') return true;
    if (s === 'content-box') return false;
    if (s !== 'inherit') return false;      // undeclared → the initial content-box
    cur = cur._parent;
  }
  return false;
}

function isFloated(el) {
  const v = computedFloatOrClear(el, 'float');
  if (v !== 'left' && v !== 'right' && v !== 'inline-start' && v !== 'inline-end') return false;
  // §9.7: `float` computes to `none` on an out-of-flow box — an absolutely positioned box is
  // POSITIONED, not floated (Chrome: it sits at its insets and shortens no lines at all) — and a
  // box that is never generated cannot float either (`display: contents; float: left` lays its
  // children out in the flow around it, Chrome-measured).
  if (!generatesBox(el)) return false;
  const pos = positionOf(el);
  return pos !== 'absolute' && pos !== 'fixed';
}
function relativeOffset(el, cbW = null, cbH = null) {
  const left  = resolveLayoutProp(el, 'left',  cbW);
  const right = resolveLayoutProp(el, 'right', cbW);
  const top   = resolveLayoutProp(el, 'top',   cbH);
  // §9.4.3: with BOTH `left` and `right` non-auto the box is OVER-CONSTRAINED and the containing block's
  // `direction` drops one — an ltr flow keeps `left`, an rtl one keeps `right` (used left = -right). Otherwise
  // the declared inset wins and the opposite one is its negation.
  // (…the CONTAINING BLOCK's direction, §9.4.3: the nearest block around the box, not the box's own)
  const x = left != null && right != null
    ? (flowRelativeRtl(el) ? -right : left)
    : (left != null ? left : -(right || 0));
  const y = top != null ? top : -(resolveLayoutProp(el, 'bottom', cbH) || 0);
  return { x, y };
}

// The USED display: author inline style, stylesheet, then the per-tag UA default — so the engine
// can tell a `<span>` from a `<div>` without the page saying so. Memoised per layout pass (the box
// stamp is thrown away with it), since every child asks once and the resolver walks the cascade.
function displayOf(el) {
  if (memoFresh(el, "_lbDispPass")) return el._lbDisp;
  el._lbDispPass = memoStamp(el);
  const tag = renderingTag(el);
  const laid = displayAsLaidOut(computeUsedDisplay(el), tag);
  // (…and a fieldset's RENDERED legend is a block box whatever inline-level display it declares — HTML blockifies it,
  // and the walk lays it out as one — so no reader takes it for an inline box with no client box)
  const d = laid === 'inline' && tag === 'legend' && renderedLegend(el) ? 'block' : laid;
  // A widget's BOX is the UA's, not the page's: `<button style="display: table">` is still a
  // flow-root block (`button-layout/display-other`, 18 subtests). A USED-value rule only — the
  // COMPUTED value keeps the keyword the page wrote, which `button-layout/computed-style` pins in
  // 162 more, so this deliberately does not live in `blockify` beside the computed rule.
  // …but not a CUSTOMIZABLE select (`appearance: base-select`): that one is the page's box, laid
  // out by whatever `display` it declares (a `display: inline-grid` select places its generated
  // content in its grid cells — `select-grid-before-after`).
  el._lbDisp = WIDGET_TAGS.has(tag) && WIDGET_BLOCK_DISPLAYS.has(d) && !isBaseSelect(el) ? 'block' : d;
  return el._lbDisp;
}
// Only the block-level spellings are overridden — a `display: flex` button really is a flex
// container, and every inline-level keyword keeps the widget on its line.
const WIDGET_BLOCK_DISPLAYS = new globalThis.Set([
  'run-in', 'flow', 'flow-root', 'table', 'table-row-group', 'table-header-group',
  'table-footer-group', 'table-row', 'table-cell', 'table-column-group', 'table-column',
  'table-caption'
]);
// The engine's computed display, which is blockified already — a run's `<br>` / `<wbr>` as an item too, which it is
// not for layout, and so is taken back to the inline-level break it is, whatever it declares, as the walk takes it
// (`blockified_break`): a `<br>` a flex or grid container holds is part of the text run beside it — an anonymous item's
// content, no item of its own (walk.rs `box_items`, and Chrome and Firefox fold `aa<br>bb` into one item of two lines) — so it
// keeps its inline display for layout, and breaks the line; its COMPUTED display is the blockified one all the same.
// An element the engine does not style has no box, `none`.
function computeUsedDisplay(el) {
  let d = engineValue(el, 'display') ?? 'none';
  if ((el._tag === 'br' || el._tag === 'wbr') && d !== 'none' && d !== 'contents' && !isOutOfFlowChild(el)) {
    const p = layoutParent(el);
    if (p && p.nodeType === NODE_ELEMENT && ITEM_CONTAINER_DISPLAYS.has(displayOf(p))) d = 'inline';
  }
  // (…whichever door the display came in by: an inline `style="display: inline"` holding a block is one as well)
  el._lbSplit = d === 'inline' && holdsBlockLevel(el);
  return el._lbSplit ? 'block' : d;
}
const ITEM_CONTAINER_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
// …and whether a box is such a block — laid out as one for the block it holds, an INLINE box to everything else: which
// properties apply to it (a width, an overflow, a transform), what the CSSOM reports of it (no client box, a
// percentage inset as specified), how it paints. Only the FLOW takes the block (`holdsBlockLevel`).
function isSplitInline(el) {
  return displayOf(el) === 'block' && el._lbSplit === true;
}
// A non-replaced `display: inline` box holding a block-level box among its in-flow children is laid out as a BLOCK
// here. CSS 2.1 §9.2.1.1 SPLITS it — the block at full width on its own, the inline content before and after it in
// anonymous blocks, the inline box's fragments around them — and the layout does not model the split; a block holding
// that content is what comes nearest: the block child at full width, the lines before and after it where the split
// puts them, the box the union of what it holds (Chrome: `<a><div>card</div></a>` has a card as wide as the page, and
// an `<a>` around it). An ATOMIC — one shrink-to-fit rectangle on a line — would shrink the card to its text. A USED
// display: the computed value stays `inline`. (Its children's displays read no parent, so this recursion ends at the
// leaves; a child's change dirties this box, which its memo keys on.)
function holdsBlockLevel(el) {
  if (intrinsicSize(el)) return false;
  for (const child of layoutChildren(el)) {
    if (isBlockLevelChild(child)) return true;
  }
  return false;
}
const INLINE_LEVEL = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table']);
function isInlineLevel(el) { return INLINE_LEVEL.has(displayOf(el)); }
// A `<br>` that IS a line break: an INLINE-LEVEL one. HTML's UA sheet gives it `display-outside: newline`, and an author
// `display` replaces that like any other declaration — so a block-level `<br>` is an (empty) block box, and a floated
// or absolutely positioned one (blockified) leaves the line, as the spec reads and Firefox renders. (Chrome keeps every
// `<br>` a break whatever it declares; where the spec and Blink part, the spec is the bar.) Where both engines agree
// past the letter of it — an `inline-block` `<br>` still breaks, and no edge of one shows — so does this.
function isLineBreak(el) { return el._tag === 'br' && isInlineLevel(el); }

// An OUT-OF-FLOW child: one `position: absolute` / `fixed` takes out of its parent's flow.
function isOutOfFlowChild(node) {
  const pos = positionOf(node);
  return pos === 'absolute' || pos === 'fixed';
}

// A child that generates NO BOX in its parent's layout: not an element at all, or not rendered —
// an invisible tag, `[hidden]`, a closed `<dialog>`, the UA sheet's own `display: none`, an author
// `display: none` from any origin, `all: initial` over one. EVERY list of a container's children
// asks this ONE question — a block's, a flex container's items, a grid's, a table's rows, the float
// walks — through `selfNotRendered`, the resolution `getComputedStyle` answers from. A second
// resolution beside it (`displayOf(c) === 'none'`) does not fold `all`: `#x { display: none } #x
// { all: initial }` has a box in Chrome and none through that door.
// Whether this child is one to look THROUGH: `display: contents` generates no box, so for layout its children
// are its parent's, in its place (CSS Display 3 §3.1) — an OUT-OF-FLOW one too: `blockify` has no `contents`
// entry, so a `position: absolute` one computes to `contents` and generates no box to position, its children
// laid out in the flow (Chrome and Firefox: 0 wide, its text where a static one's would be).
// (A FLOAT needs no clause: `isFloated` reads `generatesBox`, already false for a box-less element.)
function isBoxlessContents(c) {
  return c.nodeType === NODE_ELEMENT && displayOf(c) === 'contents';
}
function layoutChildren(el) {
  // Memoised per layout PASS, as `flatTreeChildren` memoises its generated content and for the same reason it
  // gives: this is the hottest walk in the engine, four calls per element, and the scan below asks `displayOf`
  // per child — a memo read, but one whose freshness test is a `memoStamp`, an ancestor walk. Once per pass
  // instead of four. `layoutPass` only ever advances BETWEEN passes (see its comment), which is what makes a
  // per-pass memo safe; nothing mutates the array handed back.
  // MEASURED, because the flattening is not free and the honest figure belongs here rather than in a commit
  // message. A 1,800-element page of short rows: 20.2 ms a relayout against HEAD's 20.1, no difference the
  // wall can resolve. A TEXT-DENSE page (400 paragraphs, each with four inline boxes and nine text nodes):
  // 26.3 ms against HEAD's 25.9 — about 2.3%, systematic across five interleaved pairs — and 26.9 without
  // this memo, so the memo is a third of what the flattening would otherwise cost. The perf gate's counts,
  // which are the hard limit, are unchanged.
  // BACKLOG: an O(1) page gate would take even that to zero — a document with no `display: contents` element
  // and no `<slot>` needs no scan at all. It wants a document-wide answer from the style engine — does any element
  // compute `display: contents` — plus the shadow-host count for `<slot>`, which the UA sheet makes one of these. Its
  // own increment, not this one.
  // Kept in a WeakMap rather than on the element: it is derived from the DOM and the cascade alone, and replaced
  // wholesale when the pass advances, with nothing on the element to clear.
  // Two things it freezes that `flatTreeChildren`'s pseudo memo did not: `el._children` and, for a `<slot>`,
  // `assignedNodes()`. A layout pass that moved a node or re-assigned a slot mid-pass would read the old list
  // — no pass does, and the pseudo
  // memo already assumes as much about the cascade.
  // What comes back is sometimes a fresh array and sometimes `el._children` itself (a LIVE list) or the shared
  // `NO_CHILDREN`, so no caller may mutate it — none does, and none may start.
  const memo = FLAT_CHILDREN.get(el);
  if (memo !== undefined) return memo;
  const out = lookThroughBoxless(el, layoutChildren);
  FLAT_CHILDREN.set(el, out);
  return out;
}
// …the enumeration itself, asking `nested` for a box-less child's own: the memo above within a pass, and itself for a
// reader that may run BETWEEN passes (`renderedLegend`, which `getComputedStyle` asks before any layout), where the
// memo still holds the last pass's tree.
function lookThroughBoxless(el, nested) {
  const kids = flatTreeChildren(el);
  let flat = null;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!isBoxlessContents(c)) {
      if (flat) flat.push(c);
      continue;
    }
    if (!flat) flat = kids.slice(0, i);
    for (const g of nested(c)) flat.push(g);
  }
  return flat || kids;
}
function currentLayoutChildren(el) {
  return lookThroughBoxless(el, currentLayoutChildren);
}

// A fieldset's RENDERED LEGEND (HTML §15.3.13): the first child BOX of the fieldset's box that is a `<legend>`, neither
// floated nor absolutely positioned. Laid out as a shrink-to-fit block in the fieldset's top border whatever display
// it declares. Boxes, not DOM children — so a legend that generates none (`display: none` / `contents`) is passed
// over for the next one, a legend reached through a `display: contents` wrapper or a slot is one, and a fieldset
// with no box of its own has none (Chrome and Firefox, all four).
export function renderedLegend(el) {
  if (el._tag !== 'legend' || el._ns !== HTML_NS) return false;
  const fieldset = layoutParent(el);
  if (!fieldset || fieldset._tag !== 'fieldset' || fieldset._ns !== HTML_NS) return false;
  for (const c of currentLayoutChildren(fieldset)) {
    if (c._tag !== 'legend' || c._ns !== HTML_NS || boxlessChild(c) || isFloated(c) || isOutOfFlowChild(c)) continue;
    return c === el;
  }
  return false;
}
function boxlessChild(c) {
  return c.nodeType !== NODE_ELEMENT || selfNotRendered(c);
}
// The element whose BOX lays this one out — the nearest flat-tree ancestor that generates one. A `display:
// contents` element generates none: for layout it is replaced by its children, IN ITS PLACE (CSS Display 3
// §3.1), which is exactly what `layoutChildren` splices. So the box that lays a child of one out, and the
// containing block its percentages resolve against, is the one PAST it — where `flatTreeParent` stops at the
// box-less element itself.
function layoutParent(el) {
  let p = flatTreeParent(el);
  while (p != null && p.nodeType === NODE_ELEMENT && !generatesBox(p)) p = flatTreeParent(p);
  return p;
}

// Whether a child is BLOCK-LEVEL content of its parent: what makes an inline box holding it a block
// (`holdsBlockLevel`).
function isBlockLevelChild(node) {
  if (boxlessChild(node)) return false;
  // A box-less `display: contents` element is not asked about — `layoutChildren` splices its children into
  // its parent's list in its place, so what this is handed has a box of its own. This line is what that
  // invariant costs if it ever breaks: without it the fallthrough would answer `true`, and a PHANTOM BOX
  // would split its inline parent with nothing to show for it.
  if (isBoxlessContents(node)) return false;
  // …and an OUT-OF-FLOW or inline-level one is no block-level content.
  if (isOutOfFlowChild(node) || isInlineLevel(node)) return false;
  // A FLOAT is hoisted out of the inline box it was written in, so it is no
  // reason for that box to stop fragmenting: Chrome keeps `<span>world <b style="float: left">`
  // one inline box on one 18px line, where treating the float as block-level content made the
  // whole span atomic and the line as tall as the float.
  return !isFloated(node);
}

// The containing block a FRAGMENTED inline establishes: CSS 2.1 §10.1 runs it from the first
// piece's top-left to the last piece's bottom-right, which is not the bounding union — a
// dropdown hung off a link that wraps opens under where the link STARTS, 137px right of the
// union's left edge (Chrome-verified).
function inlineContainingBox(el) {
  const b = boxOf(el);
  if (!b || !b.fragmented) return b;
  const f = fragmentsOf(el), first = f[0], last = f[f.length - 1];
  return { x: first.x, y: first.y,
           width: last.x + last.width - first.x, height: last.y + last.height - first.y };
}



// Could this element have a value for a property almost no page declares — `order` / `flex-wrap` are absent from nearly
// every page that has flex on it at all?
function declaresLayoutProp(el, prop) {
  // Whether the value the engine computed is anything but the initial one: a gate that answers false only where the
  // property has nothing to do, and true exactly where it may.
  const v = engineValue(el, prop);
  return v !== undefined && v !== INITIAL_VALUES[prop];
}

// ── Paint recording ──────────────────────────────────────────────────────────────────────────
// Where each text piece LANDED, which a layout pass otherwise throws away. A painter needs it — it cannot re-derive
// the line breaking without repeating the whole pass — so a pass asks the walk for it (`nlRustPass`'s `painting`)
// only while a paint is recording, which forces a fresh pass: the boxes it needs are memoised from a pass that
// recorded nothing.
let PAINTING = false;
// …and the pieces the last pass placed while it was (`paintRuns`), which the painter draws. A pass that lays out the
// root alone clears them (`layoutRootAlone`).
let NL_PAINT_RUNS = null;
export function recordingRuns(fn) {
  const prevPainting = PAINTING, prevRuns = NL_PAINT_RUNS;
  NL_PAINT_RUNS = null;
  PAINTING = true;
  const doc = globalThis.document;
  // The whole tree is dirtied first, so the pass walks every box again: the walk reuses nothing while it paints (a
  // kept subtree is a hole it never enters, whose pieces would have no owner to draw them in), but the gate in
  // `ensureLayout` would otherwise answer a settled page with the memoised layout and lay out nothing at all.
  // Through the GLOBAL rather than an import: an import edge from here to mutation-observer.js
  // reorders module initialisation enough to break the slot hooks dom-nodes installs there (six
  // slotchange WPT files went red). Cold path, so a global lookup costs nothing that matters.
  if (globalThis.__csimMarkLayoutDirty) globalThis.__csimMarkLayoutDirty(doc && doc.documentElement, true);
  try {
    // …through the public geometry entry rather than `ensureLayout` directly, for the reason in
    // `clipBoxesFor`: a geometry read lays the page out, and this one is not on any hot path.
    rectOf(doc && doc.documentElement);
  } finally {
    PAINTING = prevPainting;
  }
  const painted = NL_PAINT_RUNS || [];
  NL_PAINT_RUNS = prevRuns;
  // …and the recorder is disarmed BEFORE the painter runs, because it belongs to the PASS and not
  // to the paint. A painter reads style — `transform-origin` alone reaches `documentBoxOf` — and a
  // style read can move the keys `ensureLayout` gates on, so the next geometry question inside the
  // paint lays the page out again. With the recorder still armed that second pass would replace the
  // pieces mid-paint; whatever a painter reads, it cannot feed the list it is drawing.
  return fn(withControlText(painted));
}
// …and the text the form controls show (`controlTextRuns`), which no line placed — in place of whatever the pass laid
// out of their children (a textarea's DEFAULT value, a dropdown's every option), which is not what they show.
function withControlText(runs) {
  const doc = globalThis.document;
  const shown = new globalThis.Set(), extra = [];
  if (doc && doc.documentElement) {
    walkInclShadow(doc.documentElement, (n) => {
      if (n.nodeType !== NODE_ELEMENT || !hasLayoutBox(n) || (n._tag !== 'textarea' && n._tag !== 'input' && n._tag !== 'select')) return;
      const cr = controlTextRuns(n);
      if (!cr) return;
      shown.add(n);
      for (const r of cr) extra.push(r);
    });
  }
  if (!shown.size) return runs;
  const inShown = (o) => {
    for (let n = o, k = 0; n && k < 3; n = n._parent, k++) if (shown.has(n)) return true;   // (an option in a group)
    return false;
  };
  return runs.filter((r) => !inShown(r.owner)).concat(extra);
}
// Total layout passes since the VM booted — the perf gate's primary count metric
// (`spec/support/perf_gate.rb`). One full pass fires per read-after-mutation; a
// regression that adds passes moves this deterministically,
// independent of machine / Ruby version / JS engine.
globalThis.__csimLayoutPasses = () => layoutPass;


// ── Tables ───────────────────────────────────────────────────────────────────
function isTableDisplay(d) { return d === 'table' || d === 'inline-table'; }

// `float: inline-start` and `clear: inline-end` resolve against the CONTAINING BLOCK's direction,
// not the box's own — an `rtl` float inside an `ltr` block floats LEFT (css-logical §float, which
// `logical-values-float-clear-reftest` covers in 96 combinations). An inline box is not a
// containing block for a float, so its direction is skipped along the way.
function flowRelativeRtl(el) {
  let p = flatTreeParent(el);
  // (…an inline box laid out as a block for the block it holds is still an INLINE box here: §9.2.1.1's split leaves
  // a float in it to the block around it, whose direction reads its flow-relative keywords)
  while (p && p.nodeType === NODE_ELEMENT && (displayOf(p) === 'inline' || usedDisplay(p) === 'inline')) p = flatTreeParent(p);
  return !!(p && p.nodeType === NODE_ELEMENT && flowSides(p).rtl);
}

// How much a line of a textarea's shown text may exceed its width and still count as fitting (`controlTextRuns`): a
// billionth of a pixel,
// bounded on both sides by measurement: large enough to swallow the ULP two different addition orders leave
// behind (it holds to a line about 1.5e7 px long, past which `ulp(x) > 1e-9` — Chrome clamps a layout width
// at 33 554 428 and a font-size at 10 000, so no page reaches it), and small enough to hide no break Chrome
// would make, since Chrome decides one at LayoutUnit resolution: 1/64 px, seven orders of magnitude coarser.
const LINE_FIT_EPS = 1e-9;


// ── Text advance widths ──────────────────────────────────────────────────────
// A run's width is the sum of its characters' ADVANCE widths in the element's font,
// scaled by the used font size. The per-character table comes from the font file's
// own `hmtx` (host side: `font_advance_table`), so nothing is rasterised: one host
// call per (family, weight/style) for the whole table, then a few lookups per run.
// Against Chrome the sum lands within ~6% median where the flat 8px/char estimate
// this replaces was ~19% off and up to 177% on narrow or wide strings ("iiii" /
// "WWWW"). Falls back to that estimate when fontconfig can't resolve the family.
// The element's font as the table key + the size to scale by. Memoised per pass.
function fontOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  if (memoFresh(el, "_lbFontPass")) return el._lbFont;
  const family = computedFontFamily(el);
  const ws = fontKeyOf(el);
  const table = advanceTableFor(family, ws);
  // A stack with a `unicode-range`-restricted `@font-face` splits a run's characters across
  // faces (null on the hot path — no document face restricts a range); each character then
  // measures and paints with the face that covers it, `table` staying the primary.
  const faces = faceStackFor(family, ws);
  // …and the two spacings, which the flow adds to every advance it measures. Both INHERIT as the computed TEXT, a
  // percentage as the percentage, which each element resolves at its own size (`spacingAt`) — Chrome: a
  // `letter-spacing: 10%` block puts 3.2px between the letters of a 32px span in it.
  const size = computedFontSizePx(el) || 16;
  const lsText = computedLetterSpacingText(el), wsText = computedWordSpacingText(el);
  el._lbFont = { table, faces, size, lsText, wsText, ls: spacingAt(lsText, () => size), ws: spacingAt(wsText, () => size) };
  el._lbFontPass = memoStamp(el);
  return el._lbFont;
}

// A box with an INTRINSIC size has no line inside it to read a baseline from, and Chrome answers
// with its bottom margin edge — an image, a checkbox, a range slider, and every scroll container.
// Except where the UA chrome draws TEXT in it: a text field, a select or a button input puts that
// text's baseline on the line, so the words in the field line up with the words beside it.
// Measured in Chrome: a 21px `<input>` answers 15, a 19px `<select>` 14, and a 42px `<textarea>`
// — a scroll container — its own 42. The text sits in the CONTENT box, which is what keeps the
// answer tracking a control the page has made taller (a 46px input answers 27.5, the half pixel
// included: a browser's LayoutUnit keeps it and so does this).
//
// …and a widget the UA draws no text in answers with its BORDER box's bottom edge, which — unlike
// an image's or an inline-block's — leaves its bottom margin hanging below the baseline (measured:
// a checkbox with a 6px bottom margin answers 13, where an image with one answers 46). A LIST box
// — `<select multiple>` or one with a `size` — answers with its CONTENT box's bottom instead.
const CHROMELESS_INPUTS = new globalThis.Set(['checkbox', 'radio', 'range', 'image']);
// A control whose baseline is its FONT's (a dropdown / list box, a text-like input) — not a chromeless input, an
// image, or a textarea (a scroll container: its bottom edge).
function controlDrawsText(el) {
  const tag = el.tagName;
  return tag === 'SELECT' || (tag === 'INPUT' && !CHROMELESS_INPUTS.has(inputType(el)));
}
function controlBaseline(el, height) {
  const tag = el.tagName;
  // The box's OWN edges, percentages resolved against its containing block as the pass resolved them: a basis-less read
  // hangs half an asymmetric vertical percentage padding off the line (Chrome puts `<input style="padding-top:10%">` on
  // a 66px block where that says 86).
  const e = edgesOf(el);
  if (!controlDrawsText(el)) return tag === 'IMG' ? null : height;
  // A `<select>` showing more than one row is a LIST box rather than a dropdown, and its baseline
  // is its CONTENT box's bottom (measured: 67 of Chrome's 66px-tall `multiple`, 50 of a 53px `size=3`
  // — the driver's own control chrome is 4px taller, a separate gap).
  if (isListBox(el)) return Math.max(0, height - e.bottom);
  const f = fontOf(el);
  const box = f && f.table ? fontBoxHeight(f, false) : lineHeightOf(el);
  const contentH = Math.max(0, height - e.top - e.bottom);
  return e.top + (contentH - box) / 2 + fontAscent(el);
}

// The text a form control SHOWS, as the runs a painter draws (`recordingRuns`): a text field's value — its placeholder
// while that is empty, in `::placeholder`'s style — a button input's label, a dropdown's selected option. A browser
// builds it in the control's user-agent shadow tree, so no line of the page's ever places it, and the control's box
// is sized without it (`CONTROL_SIZES`). Laid out here against that box: one line on the control's baseline
// (`controlBaseline`), or a textarea's lines from the top of its content box — each hard line wrapped greedily at its
// spaces, a word longer than the box left to overflow (the UA's `overflow-wrap: break-word` would break it) — aligned
// by the control's own `text-align` and indented by its `text-indent`, as a block's lines are. Null for a control that shows no text of its own: a checkbox, a list box (whose
// options are laid out as boxes), a customizable select.
const TEXT_FIELD_TYPES = new globalThis.Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
export function controlTextRuns(el) {
  const b = boxOf(el);
  if (!b || !controlShowsText(el)) return null;
  let text = null, owner = el, centred = false;
  if (el._tag === 'select') {
    // …the option's LABEL as HTML renders it: its `label` attribute unless that is empty, else its text (the IDL
    // `label` answers an empty attribute as itself).
    const opt = el.options && el.options[el.selectedIndex];
    text = opt ? opt.getAttribute('label') || opt.text : '';
  } else if (el._tag === 'input' && !TEXT_FIELD_TYPES.has(inputType(el))) {
    text = buttonInputLabel(el);
    centred = true;
  } else {
    text = String(el.value ?? '');
    if (el._tag === 'input' && inputType(el) === 'password') text = '\u2022'.repeat([...text].length);
  }
  if (!text) {
    // (…a placeholder applies to a textarea and a text field — not to a button input or a dropdown)
    const ph = (el._tag === 'textarea' || (el._tag === 'input' && TEXT_FIELD_TYPES.has(inputType(el)))) && el.getAttribute('placeholder');
    if (!ph) return null;
    text = el._tag === 'input' ? ph.replace(/[\r\n]/g, '') : ph;
    owner = placeholderNodeFor(el);
  }
  const e = edgesOf(el);
  const left = b.x + e.left, width = Math.max(0, b.width - e.left - e.right);
  const rtl = !!flowSides(el).rtl;
  const align = centred ? 'center' : textAlignOf(el, rtl);
  const ind = textIndentOf(el, width);
  // (…the indent a line takes: the first, or every other under `hanging`; `each-line` is not modelled here)
  const indentOf = (row) => (ind && (row === 0) !== ind.hanging ? ind.px : 0);
  const runs = [];
  const place = (line, row, y, baseline) => {
    if (!/\S/.test(line)) return;
    const indent = indentOf(row), w = measureRun(line, owner);
    const free = width - indent - measureRun(line.replace(/\s+$/, ''), owner);
    const x = left + (rtl ? 0 : indent) + (align === 'right' ? free : align === 'center' ? free / 2 : 0);
    runs.push({ text: line, x, y, baseline, owner, block: null, width: w, justify: 0, tabFrom: 0, tab: null });
  };
  if (el._tag !== 'textarea') {
    place(text, 0, b.y + e.top, b.y + controlBaseline(el, b.height));
    return runs;
  }
  const lh = lineHeightOf(el), asc = baselineWithin(el), top = b.y + e.top;
  const wraps = String(el.getAttribute('wrap') || '').toLowerCase() !== 'off';
  let row = 0;
  for (const hard of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '', lineW = 0;
    for (const tok of wraps ? hard.split(/(\s+)/) : [hard]) {
      if (!tok) continue;
      const w = measureRun(tok, owner);
      if (line && /\S/.test(tok[0]) && lineW + w > width - indentOf(row) + LINE_FIT_EPS) {
        place(line, row, top + row * lh, top + row * lh + asc);
        row++;
        line = '';
        lineW = 0;
      }
      line += tok;
      lineW += w;
    }
    place(line, row, top + row * lh, top + row * lh + asc);
    row++;
  }
  return runs;
}
// …and whether it shows any: a textarea, a text field or a button input, a dropdown — each laid out as a widget.
function controlShowsText(el) {
  const tag = el._tag;
  if (tag === 'textarea') return true;
  if (tag === 'select') return !isListBox(el) && !isBaseSelect(el);
  return tag === 'input' && (TEXT_FIELD_TYPES.has(inputType(el)) || buttonInputLabel(el) != null);
}

// The font's ascent at this size, without the half-leading a line box adds around it — what an
// inline box's own edge box hangs by.
function fontAscent(el) {
  const f = fontOf(el);
  return f && f.table ? Math.round(f.table.asc * f.size) : Math.round(lineHeightOf(el) * 0.8);
}

// Where an element's own baseline sits below the top of the line it is on: its half-leading — half
// of what its OWN `line-height` leaves around its font box — plus its font's ascent. A LINE's
// baseline is the deepest of these among the boxes on it, which is why a 32px word on a 16px
// block's line puts the baseline 29 down and not 24.
//
// The half is FLOORED and may be NEGATIVE, as a browser's LayoutUnit arithmetic makes it: measured
// with a zero-height `inline-block` marker, which sits exactly on the baseline. 16px Arial on its
// natural 18px line has its baseline at 14, not the 14.5 an exact half gives; the same text on a
// 30px line at 20; and on a `line-height: 10px` one at 10, where clamping the half at zero says 14.
function baselineWithin(el) {
  const f = fontOf(el);
  const lh = lineHeightOf(el);
  if (!f || !f.table) return Math.round((lh || 16) * 0.8);
  return Math.floor((lh - fontBoxHeight(f, false)) / 2) + Math.round(f.table.asc * f.size);
}

// The font's content-box height (ascent + descent) at this size, plus the line gap
// when `withGap` — each metric rounded to whole px first, as browsers do.
function fontBoxHeight(f, withGap) {
  return boxHeightOfTable(f.table, f.size, withGap);
}
// The same for an explicit table — the primary's, or a unicode-range candidate's — so a run's line
// box can fit the tallest face its characters actually select, not only the element's primary.
function boxHeightOfTable(t, size, withGap) {
  const h = Math.round(t.asc * size) + Math.round(t.desc * size);
  return withGap ? h + Math.round((t.gap || 0) * size) : h;
}

// CSS white-space processing for a measured run: `normal` / `nowrap` / `pre-line`
// collapse each white-space sequence to ONE space (which still occupies width
// between inline items — `text with <a>link</a>`), and a space at the START of a
// line is dropped; `pre` / `pre-wrap` / `break-spaces` preserve every space, so
// they are measured verbatim. U+00A0 is NOT white space for this purpose — an
// `&nbsp;` run keeps its full width.
const PRESERVING_WS = new globalThis.Set(['pre', 'pre-wrap', 'break-spaces']);
// `white-space` INHERITS, so a `<span>` inside `<pre>` preserves its spaces too.
// Memoised per pass like the other inherited reads.
function whiteSpaceOf(el) {
  if (memoFresh(el, "_lbWsPass")) return el._lbWs;
  el._lbWsPass = memoStamp(el);
  // Through the UA layer as well as the cascade: `<pre>`'s `white-space: pre` is a UA
  // rule, and reading only the author cascade meant the ONE element built around
  // preserved newlines collapsed them — while `getComputedStyle` reported `pre`. Same
  // pairing `resolveLayoutProp` uses; ONE geometry means one value resolution.
  // One step, then the PARENT's answer — which is memoised in turn, so the walk up is paid once
  // per element rather than per read, and there is no depth at which it gives up (a 64-ancestor cap
  // silently reported `normal` for anything deeper). `ownWhiteSpace` is the shared reader: it takes
  // the UA layer into account and refuses `inherit` / `unset` / `revert` / anything unparseable,
  // which are not values this property takes.
  const own = ownWhiteSpace(el);
  const wsParent = flatTreeParent(el);
  el._lbWs = own || ((wsParent && wsParent.nodeType === NODE_ELEMENT) ? whiteSpaceOf(wsParent) : 'normal');
  return el._lbWs;
}
function collapseRun(text, el, atLineStart) {
  const mode = whiteSpaceOf(el);
  if (PRESERVING_WS.has(mode)) return text.replace(/[\n\r\f]/g, '');
  let run = text.replace(/[ \t\n\r\f]+/g, ' ');
  if (atLineStart) run = run.replace(/^ /, '');
  return run;
}

// East-Asian FULL-WIDTH ranges (CJK ideographs + kana + Hangul + fullwidth forms).
// A coarse but decisive test: these render one em wide, Latin fallbacks half that.
function isWideChar(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) ||     // Hangul Jamo
         (cp >= 0x2E80 && cp <= 0xA4CF) ||     // CJK radicals … Yi
         (cp >= 0xAC00 && cp <= 0xD7A3) ||     // Hangul syllables
         (cp >= 0xF900 && cp <= 0xFAFF) ||     // CJK compatibility ideographs
         (cp >= 0xFE30 && cp <= 0xFE6F) ||     // CJK compatibility forms
         (cp >= 0xFF00 && cp <= 0xFF60) ||     // fullwidth forms
         (cp >= 0xFFE0 && cp <= 0xFFE6);
}

// The advance width of `text` in `el`'s font.
// The per-character fallback for a font whose advance table can't be read at all (no
// fontconfig, an unreadable file): the last place in this file where a character
// count stands in for a measurement.
const AVG_CHAR_PX = 8;
// A TAB (preserved by `white-space: pre` & co; a collapsing mode turned it into a space before
// this) advances to the next tab stop — stops every `tab-size` from the block's content edge
// (CSS Text 3 §3.1; Chrome: `text-indent` does not move them, a tab sitting exactly on a stop
// takes the whole next one, and one whose stop is less than HALF A SPACE away takes the one after
// — Blink's `Font::TabWidth`: `tab-size: 20px` after 19.2px of text lands at 40, after 9.6px at
// 20). So a run's width depends on WHERE it starts: `from` is the pen's distance from that edge,
// `tab` the block's stop (`tabStopOf`), asked of the block itself when a caller has neither and
// the text holds one, and `px` 0 means there is no stop at all — the `tab-size: 0` fallback is resolved
// in `tabStopOf` below, not at the advance.
// Where the pen lands from `pen`, both figures already resolved by `tabStopOf` — which is the point: whose
// `tab-size` the spacing came from, and whose font the half-space minimum and the zero fallback came from,
// are settled there, so nothing here has an element to ask.
function tabAdvance(pen, tab) {
  if (!(tab.px > 0)) return 0;
  const into = pen - Math.floor(pen / tab.px + 1e-9) * tab.px;
  const dist = tab.px - into;
  return dist < tab.min + 1e-6 ? dist + tab.px : dist;      // `<=`: float32 in Blink says 4.8 < 4.8
}
function measureRun(text, el, from = 0, tab = undefined) {
  const f = fontOf(el);
  if (!f || !f.table) return text.length * AVG_CHAR_PX + spacingOf(text, f);
  // ONE plain loop, no callback: this runs per run per relayout, and a 4000-character textarea
  // value walked through a closure per character is measurable against the 0.25s budget
  // Capybara's own `fill_in` spec gives it. The spacing is summed in the same walk for the same
  // reason.
  const table = f.table, faces = f.faces, ls = f.ls, ws = f.ws, spaced = ls !== 0 || ws !== 0;
  let units = 0, spacing = 0, prev = -1;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (cp === 0x09) {
      if (tab === undefined) tab = tabStopOf(el);
      spacing += tabAdvance(from + units * f.size + spacing, tab);
      prev = cp;
      continue;
    }
    // A unicode-range split picks the covering face's table per character; its `size-adjust` is
    // already baked into that table's advances, so the width stays `units * f.size`.
    const c = faces ? pickCharCand(faces, cp) : null;
    units += unitOf(text, i, cp, prev, c ? c.table : table);
    if (spaced && takesSpacing(cp, prev)) spacing += ls + (cp === 0x20 || cp === 0xA0 ? ws : 0);
    prev = cp;
  }
  return units * f.size + spacing;
}
// The candidate face a character takes in a unicode-range split — the first whose range covers its
// code point — or null when the run has no split (`f.faces` absent) or nothing covers it (then the
// caller keeps the primary table). `{ ranges, table, sizeMul }`; `sizeMul` is the face's
// `size-adjust`, which the painter needs for the glyph size but measurement does not (baked in).
function pickCharCand(faces, cp) {
  for (let k = 0; k < faces.length; k++) if (rangesCover(faces[k].ranges, cp)) return faces[k];
  return null;
}
// The tab stop for a tab in `owner`'s text on `block`'s lines: `px`, the `tab-size` — the tab's
// OWN element's (a `code { tab-size: 4 }` inside a `pre { tab-size: 8 }` stops every 4) — as a
// length, or as a count of the BLOCK's space advances, letter- and word-spacing included (Chrome:
// 8 x (9.6 + 2) under `letter-spacing: 2px`; a 32px span's tab in a 16px `<pre>` stops at 76.8);
// and `min`, half the block's space, the least a tab advances. The block's unit is memoised on
// the block; the count is one cached computed read per tabbed text node.
function tabStopOf(block, owner = block) {
  let unit = memoFresh(block, '_lbTabPass') ? block._lbTab : null;
  if (unit === null) {
    block._lbTabPass = memoStamp(block);
    const f = fontOf(block);
    const bare = f && f.table ? (f.table.adv[' '] !== undefined ? f.table.adv[' '] : f.table.avg) * f.size : AVG_CHAR_PX;
    unit = block._lbTab = { space: bare + (f ? f.ls + f.ws : 0), min: bare / 2, ls: f ? f.ls : 0 };
  }
  const v = owner === block || owner.nodeType !== NODE_ELEMENT ? tabSizeOf(block) : tabSizeOf(owner);
  // A NUMBER counts the block's spaces; a LENGTH is the stop width itself (a computed read, so already px).
  // Anything else is not a `tab-size` — an `auto`, a typo, a second value — and the property keeps its
  // INITIAL 8, which is what Chrome lays out (`tab-size: auto` stops every 8 spaces, exactly like an
  // undeclared one). Parsed strictly rather than handed to `parseFloat`, which reads `2px 3px` as 2 and `4e`
  // as 4 — and, since a zero `px` now MEANS something (the letter-spacing grid, see `tabAdvance`), reading an
  // unparseable value as zero is a wrong answer rather than a missing one. A NEGATIVE never arrives: the
  // cascade drops it (`NEGATIVE_INVALID_PROPERTIES`), leaving the initial.
  const num = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v);
  const len = num ? null : /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(v);
  const raw = num ? parseFloat(v) * unit.space : len ? parseFloat(len[1]) : 8 * unit.space;
  // …and one that resolves to ZERO puts the stops a LETTER-SPACING apart instead — not a flat advance, so
  // the grid and the half-space rule go on applying to them (Blink's `Font::TabWidth` takes the fallback
  // inside the base-width computation, before the arithmetic). The BLOCK's letter-spacing, like every other
  // figure a stop takes from the block's own font: measured in Chrome, a tab in a `letter-spacing: 10px`
  // inline of a block with none
  // advances NOTHING (9.61, the pen unmoved), and one in a `letter-spacing: 0` inline of a block with 10px
  // stops every 10 (30). After one 9.6px character the block's 3px lands the next box at 18 (stops at 15 and
  // 18, the first too near), 0.5px at 11, 1px at 12. With no letter-spacing — or a NEGATIVE one — there is no
  // stop to reach. `word-spacing` is no fallback at all (`tab-size: 0; word-spacing: 5px` lands at 9.61).
  // (a value that OVERFLOWED is not one that resolved to nothing — it keeps the initial, like any other the
  // parse could not use. Chrome saturates it to a LayoutUnit maximum instead: `tab-size: 1e400` stops every
  // 32777.6 there and every 8 spaces here, which is an absurd-input difference not worth a clamp constant.)
  const px = Number.isFinite(raw) ? (raw > 0 ? raw : unit.ls) : 8 * unit.space;
  return { px: px > 0 ? px : 0, min: unit.min };
}
// One character's advance in font UNITS — `i` indexes its LAST code unit, `cp` is the code point,
// `prev` the one before it.
function unitOf(text, i, cp, prev, table) {
  // A zero-width character has no advance: a soft hyphen, a joiner, a combining mark that sits
  // on the glyph before it. Charging them the Latin mean made `ab&shy;cd` 9.6px wider than `abcd`.
  if (joinedByZwj(cp, prev) || zeroWidth(cp)) return 0;
  if (cp <= 0xFFFF) {
    const a = table.adv[text[i]];
    if (a !== undefined) return a;
    // Outside the table: CJK / fullwidth / Hangul glyphs are FULL-WIDTH (~1em) in every font that
    // has them, so charging them the Latin mean (~0.5em) halved every Japanese line.
    if (cp === 0x00A0) return table.adv[' '] !== undefined ? table.adv[' '] : table.avg;   // NBSP is a space
    return isWideChar(cp) ? 1 : table.avg;
  }
  return 1;                                        // an astral character (emoji) is full-width
}

// The advance of each CHARACTER of `text` in `el`'s font, unspaced, in px — one entry per code
// point — for a painter that has to place a spaced run itself. The same table `measureRun` sums.
// `from` / `tab`: see `measureRun` — a tab's advance is the distance to the next stop, which
// only the pen knows. Unspaced: the caller adds letter- and word-spacing per character.
export function charAdvances(text, el, from = 0, tab = undefined) {
  const f = fontOf(el);
  const out = [];
  if (!f || !f.table) { for (const ch of text) out.push(AVG_CHAR_PX); return out; }
  // The pen carries the spacing the caller will add (`measureRun` does the same), so a tab picks
  // the stop the run's width says it does; the advances handed back stay unspaced.
  const ls = f.ls, ws = f.ws, spaced = ls !== 0 || ws !== 0, faces = f.faces;
  let prev = -1, pen = from;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    let adv;
    if (cp === 0x09) {
      if (tab === undefined) tab = tabStopOf(el);
      adv = tabAdvance(pen, tab);
    } else {
      const c = faces ? pickCharCand(faces, cp) : null;
      adv = unitOf(text, i, cp, prev, c ? c.table : f.table) * f.size;
      if (spaced && takesSpacing(cp, prev)) pen += ls + (cp === 0x20 || cp === 0xA0 ? ws : 0);
    }
    out.push(adv);
    pen += adv;
    prev = cp;
  }
  return out;
}
// The px font SIZE to paint each code point at — the base size times the `size-adjust` of the face
// a unicode-range split gave it (a 200% face at 20px draws 40px glyphs). Null when the run has no
// split, so the painter keeps its single font string. Parallel to `charAdvances`, one entry per
// code point.
export function charFaceSizes(text, el) {
  const f = fontOf(el);
  if (!f || !f.faces) return null;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    const c = pickCharCand(f.faces, cp);
    out.push(f.size * (c ? c.sizeMul : 1));
  }
  return out;
}
// …and which of those code points take a spacing, in the same order, for the painter's pen.
export function spacingSlots(text) {
  const out = [];
  let prev = -1;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    out.push(takesSpacing(cp, prev));
    prev = cp;
  }
  return out;
}
// `letter-spacing` after EVERY character — the last one included — and `word-spacing` after each
// word separator on top of it (CSS Text 3 §8: U+0020 and U+00A0 are the ones a page writes).
// Chrome-measured at 16px monospace: "abcd" is 38.41 wide and 78.41 under `letter-spacing: 10px`,
// a lone "a" is 19.61, and "ab cd ef" gains 40 from `word-spacing: 20px`. Per CODE POINT: a
// surrogate pair is one character, and so is a CJK glyph outside the advance table.
function spacingOf(text, f) {
  if (!f || (!f.ls && !f.ws)) return 0;
  let chars = 0, seps = 0, prev = -1;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (!takesSpacing(cp, prev)) { prev = cp; continue; }
    chars++;
    if (cp === 0x20 || cp === 0xA0) seps++;
    prev = cp;
  }
  return chars * f.ls + seps * f.ws;
}
// Once per GRAPHEME CLUSTER, and never after a character that has no width of its own — which is
// Blink's rule (`ShapeResultSpacing`): a control, a soft hyphen, a zero-width space or joiner, a
// bidi control, BOM and the object-replacement character take none; a combining mark or a
// variation selector joins the cluster before it; and so does whatever follows a ZERO WIDTH JOINER,
// which is how a family emoji is one spacing and not seven (Chrome: 29.92 wide under 10px, where
// per code point it came to 117.2). These characters have no ADVANCE either, and `unitOf`
// charges them none for the same reason.
function takesSpacing(cp, prev) {
  if (joinedByZwj(cp, prev)) return false;                   // joined to the character before
  return !zeroWidth(cp);
}
// Whether `cp` is drawn as one glyph with the character before it: a pictograph a ZERO WIDTH JOINER joins (an emoji ZWJ
// sequence, UAX #29 GB11), where a letter after one keeps its own advance (Chrome: `abc‍def` is 57.6 in 16px
// monospace), and an emoji modifier after a pictograph (`👍🏽` is one glyph). font.rs `joined`.
const EXT_PICT_RE = /\p{Extended_Pictographic}/u;
function joinedByZwj(cp, prev) {
  if (prev === 0x200D) return EXT_PICT_RE.test(String.fromCodePoint(cp));
  return cp >= 0x1F3FB && cp <= 0x1F3FF && prev >= 0 && EXT_PICT_RE.test(String.fromCodePoint(prev));
}
function zeroWidth(cp) {
  // The common case first and WITHOUT the regex: this is asked for every character of every run
  // on every relayout, and a `\p{M}` test — a string allocation and a Unicode-table lookup — on
  // each of a 4000-character textarea value is what a `fill_in` paid for.
  if (cp < 0x20) return true;
  if (cp < 0x7F) return false;                                // printable ASCII
  if (cp <= 0x9F) return true;                                // C1 controls
  if (cp < 0x300) return cp === 0xAD;                         // Latin-1: only the soft hyphen
  if (cp === 0xFEFF || cp === 0xFFFC || cp === 0x200E || cp === 0x200F) return true;
  if (cp >= 0x200B && cp <= 0x200D) return true;
  if (cp >= 0x202A && cp <= 0x202E) return true;
  if ((cp >= 0x2060 && cp <= 0x206F) || cp === 0x180E || cp === 0x061C) return true;   // word joiner, isolates, …
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;             // variation selectors
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
  return COMBINING_RE.test(String.fromCodePoint(cp));         // a combining mark, U+0300 and up
}
const COMBINING_RE = /^\p{M}$/u;


// The used line-box height for `el`. `line-height` INHERITS, so this goes through
// the same resolver getComputedStyle uses (style-proxy's computedLineHeight —
// "ONE geometry means one value resolution too"): an app that sets
// `body { line-height: 1.6 }` once must size every line below it. `normal` has no
// computed length, so it falls back to a factor over the used font size.
// Memoised per pass — every line placement asks.
function lineHeightOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return LINE_HEIGHT;
  if (memoFresh(el, "_lbLhPass")) return el._lbLh;
  const resolved = computedLineHeight(el);
  const px = resolved && resolved !== 'normal' ? parseFloat(resolved) : NaN;
  if (isFinite(px)) {
    el._lbLh = Math.round(px);
  } else {
    // `normal` is the FONT's own line spacing, which the advance table carries as
    // hhea factors. A browser rounds each metric to whole px BEFORE summing —
    // Chrome's 16px Liberation Sans line box is 14 + 3 + 1 = 18, where scaling the
    // combined factor gives 18.4 -> 18 by luck and 18.56 -> 19 with a flat constant.
    const f = fontOf(el);
    el._lbLh = f && f.table && f.table.asc != null
      ? fontBoxHeight(f, true)
      : Math.round((f ? f.size : (computedFontSizePx(el) || 16)) * NORMAL_LINE_FACTOR);
  }
  el._lbLhPass = memoStamp(el);
  return el._lbLh;
}

// Document scroll offsets (standards-mode scrollingElement == documentElement).
// Does this box CLIP its content, and in which axes — and is it a SCROLL CONTAINER? The pass decided, when it laid
// the box out (walk.rs `clip_flags`, `boxOf`'s `clip`: `CLIP_*`): its overflow once the viewport has taken the root's,
// and the body's where the root has none of its own (CSS Overflow §3.3), and no inline box's, to which `overflow` does
// not apply. One answer, so the clip chain, the scrollable extents and the scroll shift (geometry.rs) can't disagree
// about the same box. The axes are kept apart because `clip` beside `visible` stays so — a child hanging off the SIDE
// of an `overflow-y: clip` box is visible and hit-testable in Chrome — and scrolling is not clipping: `clip` clips and
// forbids all scrolling, script included, so it is neither the scrollport a sticky box sticks within nor something
// `scrollIntoView` can scroll.
const CLIP_X = 1, CLIP_Y = 2, CLIP_SCROLLS = 4;
function clipFlags(el) {
  const b = boxOf(el);
  return b ? b.clip : 0;
}
function clipsContent(el) { return (clipFlags(el) & (CLIP_X | CLIP_Y)) !== 0; }
export function scrollsContent(el) { return (clipFlags(el) & CLIP_SCROLLS) !== 0; }

// The total scroll shift applied to `el`'s box, `{sx, sy}` (geometry.rs `scroll_shift`): the document's scroll and
// every scroll container's around it, compounding up, less what a sticky box among them has stuck — none for a fixed
// box.
const SHIFT = new Float64Array(2);
export function scrollShift(el) {
  scrollShiftOf(el, SHIFT);
  return { sx: SHIFT[0], sy: SHIFT[1] };
}

function isFixedBox(el) {
  const b = el && boxOf(el);
  return !!(b && b.fixed);
}

// A `display: contents` element generates NO BOX of its own — only its children's boxes are in the
// tree — so every page-visible geometry read has to say so itself, whatever box it still holds: Chrome reports a
// zero `getBoundingClientRect`, no client rects, `offsetWidth` / `offsetHeight` 0 and a null
// `offsetParent` for one. `<slot>` is `display: contents`, so this is every web component's slot.
function generatesBox(el) { return displayOf(el) !== 'contents'; }
globalThis.__csimGeneratesBox = (el) => el.nodeType === NODE_ELEMENT && generatesBox(el);
globalThis.__csimIsLineBreak = isLineBreak;

// `el`'s border box as the page MEASURES it (geometry.rs `rendered_box`): in VIEWPORT coordinates, where the scrolls
// above it carried it and under every transform on the way — `null` when it generates none. A transform does not move
// a box in flow, but it moves what `getBoundingClientRect`, `getClientRects` and a hit test see. A box in no arena —
// an ANONYMOUS one — is carried as a box its container holds.
const BOX = new Float64Array(4);
function renderedBox(el) {
  return renderedBoxOf(el, BOX) ? { x: BOX[0], y: BOX[1], width: BOX[2], height: BOX[3] } : null;
}
// …and the same box UNTRANSFORMED, which the painter draws under the matrix it sets itself (`paintTransformOf`).
function renderedBoxUntransformed(el) {
  return generatesBox(el) ? laidOutBox(el) : null;
}
// The 4x4 that maps `el`'s box to the viewport (geometry.rs `transform_chain`), or null where nothing transforms it.
const CHAIN = new Float64Array(16);
function transformChain(el) {
  return transformChainOf(el, CHAIN) ? Array.from(CHAIN) : null;
}
// A non-replaced INLINE box: the one display type a transform does not apply to. Reads the per-pass memoised
// `displayOf` (not the uncached `usedDisplay`) — it gives the same `=== 'inline'` answer (the used-display widget
// override never yields inline) and this sits on the every-keystroke clientWidth/Left path via `hasNoClientBox`.
function isNonReplacedInline(el) {
  const tag = renderingTag(el);
  return (displayOf(el) === 'inline' || isSplitInline(el)) && !REPLACED_TRANSFORM_TAGS.has(tag) && !WIDGET_TAGS.has(tag);
}
const REPLACED_TRANSFORM_TAGS = new globalThis.Set(
  ['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'input', 'select', 'textarea', 'button', 'svg']
);
// [a, b, c, d, e, f] · [a, b, c, d, e, f], the same 2D affine composition the value model uses.
// The axis-aligned box the transformed quad occupies — which is what both rect APIs report.
function transformedRect(m, r) {
  const h = homographyOf(m);
  const p = [
    applyHomography(h, r.x, r.y), applyHomography(h, r.x + r.width, r.y),
    applyHomography(h, r.x, r.y + r.height), applyHomography(h, r.x + r.width, r.y + r.height)
  ];
  // A corner ON the horizon has no image at all. A browser still reports a rect for the box, so the
  // corners that do project decide it; a quad with none of them left is nowhere.
  const q = p.filter(Boolean);
  if (!q.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = q.map((c) => c.x), ys = q.map((c) => c.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
// The box the PAINTER draws — the one layout placed — and, separately, the matrix it draws it
// UNDER. The two are handed over apart because the canvas applies the matrix itself: the painter
// sets it, draws the box, its borders, its bitmap and its text runs in the coordinates layout gave
// them, and the raster comes out transformed. Handing over a transformed RECT instead moved the box
// and left everything inside it behind.
export function paintRectOf(el) {
  return renderedBoxUntransformed(el) || { x: 0, y: 0, width: 0, height: 0 };
}
// The map the PAINTER draws under — a 2D affine, which is all a canvas has — memoised per element
// per pass and per scroll (the chain takes each origin where the scrolls carried it), because the run loop asks once
// per TEXT RUN and not once per element. `false` (not null) says the element has a transform the painter cannot
// express at all, which a caller must not read as "no transform" and draw at the layout position.
export function paintTransformOf(el) {
  if (el._lbPaintTfScroll === scrollEpoch && memoFresh(el, '_lbPaintTfPass')) return el._lbPaintTf;
  el._lbPaintTf = computePaintTransform(el);
  el._lbPaintTfPass = memoStamp(el);
  el._lbPaintTfScroll = scrollEpoch;
  return el._lbPaintTf;
}
function computePaintTransform(el) {
  const m = transformChain(el);
  if (!m) return null;
  const h = homographyOf(m);
  // A homography whose projective row is `0, 0, w` is not projective at all: it is a UNIFORM scale
  // by `1 / w`, which an affine holds exactly. That is the shape `perspective(d) translateZ(z)` and
  // `matrix3d(…, w)` both take, and not dividing by it drew the box at its pre-perspective size.
  if (h[2] === 0 && h[5] === 0) {
    const w = h[8] === 0 ? 1 : 1 / h[8];
    return [h[0] * w, h[1] * w, h[3] * w, h[4] * w, h[6] * w, h[7] * w];
  }
  // A genuinely projective map is one a canvas cannot draw, so the painter takes the affine that
  // carries three of the box's own corners where the projection carries them. Taking the
  // homography's LINEAR PART instead is not an approximation of the same map at all: where a
  // projection puts the box on a line — `rotateX(90deg)` about a perspective origin the box is
  // centred on — that linear part is a perfectly invertible matrix, and the painter inked a band
  // where the box has no area. (Off that origin the box does keep an area, and Chrome inks one
  // too; the linear part is simply not the map that decides its shape.)
  //
  // Three corners is all an affine has room for, so the fourth lands at `p1 + p2 - p0` — a
  // parallelogram where the truth is a trapezoid, over-inking by up to a third. The painter clips
  // to the real quad (`paintQuadOf`), which bounds that to the shape.
  const r = renderedBoxUntransformed(el);
  if (!r || !r.width || !r.height) return false;
  const p0 = applyHomography(h, r.x, r.y);
  const p1 = applyHomography(h, r.x + r.width, r.y);
  const p2 = applyHomography(h, r.x, r.y + r.height);
  if (!p0 || !p1 || !p2) return false;
  const a = (p1.x - p0.x) / r.width,  b = (p1.y - p0.y) / r.width;
  const c = (p2.x - p0.x) / r.height, d = (p2.y - p0.y) / r.height;
  return [a, b, c, d, p0.x - a * r.x - c * r.y, p0.y - b * r.x - d * r.y];
}
// …and the true quad the box projects to, for the painter to clip against — null where the map is
// affine and the quad is already exactly what the matrix draws.
export function paintQuadOf(el) {
  const m = transformChain(el);
  if (!m) return null;
  const h = homographyOf(m);
  if (h[2] === 0 && h[5] === 0) return null;
  const r = renderedBoxUntransformed(el);
  if (!r || !r.width || !r.height) return null;
  const q = [
    applyHomography(h, r.x, r.y), applyHomography(h, r.x + r.width, r.y),
    applyHomography(h, r.x + r.width, r.y + r.height), applyHomography(h, r.x, r.y + r.height)
  ];
  return q.every(Boolean) ? q : null;
}

// `el`'s box where the page's scrolling carried it (geometry.rs `laid_out_box`), in viewport coordinates.
export function laidOutBox(el) {
  return laidOutBoxOf(el, BOX) ? { x: BOX[0], y: BOX[1], width: BOX[2], height: BOX[3] } : null;
}


// `el` is clipped away when its rendered box lies wholly outside the padding box of a box that clips it — one in its
// containing-block chain, so an out-of-flow box escapes the clips between it and the box it was placed against — in an
// axis that box clips (hit_test.rs `clipped_away`).
function isClipped(el) {
  return clippedAwayOf(el);
}

// Is `a` an ancestor of `b` in the flat tree?
export function isFlatAncestor(a, b) {
  for (let p = flatTreeParent(b); p; p = flatTreeParent(p)) if (p === a) return true;
  return false;
}

// The painter's order: every layer it draws — a box, or `{contentOf}` the content a box owns — bottom first, by the
// same painting order `elementFromPoint` asks (hit_test.rs `Painting`), so painting and hit-testing agree about what is
// on top.
export function paintOrder(layers) {
  return paintOrderIn(globalThis.document, layers, styleEngineNow());
}

// The topmost element whose box paints at the VIEWPORT point (vx, vy) — laid out, not clipped away there, not
// `pointer-events: none` or `visibility: hidden` — or the root, whose canvas is under everything (hit_test.rs `hit`).
export function hitTest(vx, vy) {
  ensureLayout();
  return hitTestIn(globalThis.document, vx, vy, false, styleEngineNow())[0] || null;
}
// …and every element there, topmost first (`elementsFromPoint`), the root last for the canvas it paints.
export function hitTestAll(vx, vy) {
  ensureLayout();
  return hitTestIn(globalThis.document, vx, vy, true, styleEngineNow());
}

// CSSOM/Selenium click-point occlusion: an element is obscured when a click at its box centre
// would NOT land on it (or a descendant). Non-visible elements are obscured.
export function isObscured(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return true;
  if (!(globalThis.__isVisibleNode && globalThis.__isVisibleNode(el))) return true;
  ensureLayout();
  if (!hasLayoutBox(el)) return true;
  if (isClipped(el)) return true;                                // clipped away by a scroll container
  const b = renderedBox(el);                                     // viewport-space box (scroll subtracted)
  return obscuredAtPoint(el, b.x + b.width / 2, b.y + b.height / 2);
}

// The shared tail of both occlusion paths: would a click at the VIEWPORT point (px, py) land on
// `el` (or a descendant), out through every containing frame? The centre is deliberately NOT
// clamped into the viewport — a point outside it has no element at all (`elementFromPoint` → null),
// which is exactly how a half-scrolled-off element reads as obscured.
function obscuredAtPoint(el, px, py) {
  const vp = viewport();
  if (px < 0 || py < 0 || px > vp.width || py > vp.height) return true;
  const hit = hitTest(px, py);
  if (!hit) return true;
  let landed = false;
  for (let n = hit; n; n = flatTreeParent(n)) if (n === el) { landed = true; break; }
  if (!landed) return true;
  // The click lands inside this document — now the container frame has to be clickable at that
  // same point, and so on out to the top-level document (Selenium's `frame_obscured_at?`).
  const cf = containerFrame();
  if (!cf) return false;
  // A parent realm torn down mid-walk can't answer; the click landed cleanly in every document we
  // could reach, so report that rather than inventing an occlusion no one can see.
  try { return cf.par.__csimFrameObscuredAt(cf.fe, px, py) !== false; } catch (_) { return false; }
}

// Parent-realm entry point (called from a CHILD realm): this frame's content box in THIS
// document's viewport coords, which is the child document's viewport.
export function frameContentBox(frameEl) {
  if (!frameEl || frameEl.nodeType !== NODE_ELEMENT) return null;
  ensureLayout();
  const box = renderedBox(frameEl);
  if (!box) return box;
  // The frame's own CONTENT box: HTML draws a 2px frame around an `<iframe>`, and the document
  // inside it sees a viewport that much smaller (Chrome: `documentElement.clientWidth` inside a
  // `width: 200px` frame is 200, not the 204 its border box measures). Everything a page inside a
  // frame resolves against — percentages, media queries, `innerWidth` — hangs off this.
  const e = edgesOf(frameEl);
  return { ...box, x: box.x + e.left, y: box.y + e.top,
           width: Math.max(0, box.width - e.left - e.right),
           height: Math.max(0, box.height - e.top - e.bottom) };
}

// Parent-realm entry point (called from a CHILD realm): the child hit-tested (`x`, `y`) in its own
// viewport coords and landed on its element; that point maps to `frame`'s content box here, so the
// frame itself must be clickable there — recursing out through any further containers.
export function frameObscuredAt(frameEl, x, y) {
  if (!frameEl || frameEl.nodeType !== NODE_ELEMENT) return true;
  ensureLayout();
  if (!hasLayoutBox(frameEl) || isClipped(frameEl)) return true;
  const b = renderedBox(frameEl);
  return obscuredAtPoint(frameEl, b.x + x, b.y + y);
}

// The size of the viewport this document lays out against — the window viewport (1024x768 until
// `resize_to` says otherwise), or the container frame's content box. CSSOM reports it as the ROOT
// element's clientWidth/clientHeight (the standards-mode rule), which is the idiom apps use to
// read "how big is the window".
//
// Deliberately does NOT force a layout pass. The answer never depends on one: `viewport()` is
// `doc._layoutVP || computeViewport()`, and `_layoutVP` is exactly what a pass stores from
// `computeViewport()` — same plain-global read either way — and this engine models no classic
// scrollbars, so no content overflow can shave the root's client box (the one way the viewport
// COULD depend on layout in a real browser). The force was measurably expensive: floating-UI
// libraries read `innerWidth`/root `clientWidth` from rAF/scroll cycles between mutations, and
// each such read ran a full document pass — 3,211 of Avo's 11,680 real passes (27%) had a
// viewport read as their forcer. Callers that go on to read boxes (IntersectionObserver's
// per-target `observedRect`, rectOf) force their own pass, so dropping this one changes no
// observable geometry.
export function viewportSize() {
  return viewport();
}

// The scrollable overflow region of `el` as a width/height (geometry.rs `scroll_size`): the distance from the edge it
// SCROLLS FROM to the far end of what is reachable from there. That is what scrollWidth / scrollHeight report — at
// least the client box, larger when content overflows it, and nothing at all for content that overflows BEHIND the
// scroll origin — and 0 x 0 for an element with no box, or a non-replaced inline one (Chrome's `<span>`).
const SIZE = new Float64Array(2);
export function contentExtent(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { width: 0, height: 0 };
  ensureLayout();
  return scrollSizeOf(el, SIZE) ? { width: SIZE[0], height: SIZE[1] } : { width: 0, height: 0 };
}

// Whether `el` establishes a containing block for absolutely-positioned descendants — i.e. it is
// positioned, and has a BOX to be one: a positioned `display: contents` element has none (Chrome and
// Firefox skip it for `offsetParent`, the nearest such ancestor).
export function isPositionedElement(el) {
  return !!el && el.nodeType === NODE_ELEMENT && positionOf(el) !== 'static' && generatesBox(el);
}

// Whether `el` ITSELF is `position: fixed` — read from the live cascade, never from the last
// pass's box: `offsetParent` must answer null the moment a style write makes an element
// fixed, and the box's `fixed` only moves when a pass happens to run afterwards. (Found as a latent
// staleness while auditing the viewportSize elision: nothing on the bare `offsetParent` read
// path forces a pass.)
export function isFixedElement(el) {
  return !!el && el.nodeType === NODE_ELEMENT && positionOf(el) === 'fixed';
}

// The laid-out border box in DOCUMENT coordinates — no scroll subtracted, unlike `rectOf`. This is
// what the offset* properties are measured in: they're layout positions, so scrolling the page
// doesn't change them (only `getBoundingClientRect` moves).
// Published for style-proxy, which can't import this module (layout.js imports IT) — the same
// global seam `__isLaidOutNode` uses. A resolved `transform` needs the border box to turn a
// percentage translate into pixels.
globalThis.__csimDocumentBox = (el) => documentBoxOf(el);
export function documentBoxOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return null;
  ensureLayout();
  if (!generatesBox(el)) return null;   // no box, so no offsets to report (see `generatesBox`)
  // CSSOM-View measures `offsetLeft` / `offsetTop` from the FIRST CSS layout box, which for
  // a fragmented inline is its first piece — not the union, whose left edge is the leftmost
  // line's (Chrome: a link that opens 36px into a line and wraps reports offsetLeft 36
  // while its bounding rect starts at 0).
  const b = boxOf(el);
  if (!b) return null;
  if (b.fragmented) {
    const f = fragmentsOf(el)[0];
    return { x: f.x, y: f.y, width: b.width, height: b.height };
  }
  // A stuck box's `offsetTop` moves with it, exactly as its client rect does — Chrome keeps
  // `rect.top + scrollY === offsetTop` through the stick.
  if (!stickyOffsetOf(el, SHIFT)) return { x: b.x, y: b.y, width: b.width, height: b.height };
  return { x: b.x + SHIFT[0], y: b.y + SHIFT[1], width: b.width, height: b.height };
}

// The element's coarse border-box as a viewport-relative `{x, y, width, height}` — Capybara's
// `Node#rect`, which backs the spatial selectors (`:above`/`:below`/`:left_of`/`:right_of`/`:near`)
// and coordinate drag. Document coords minus the document scroll, so relative comparisons stay
// consistent. A non-laid-out element is a zero rect (the layout engine is used only here, so the
// app-facing getBoundingClientRect keeps its existing model).
// The CLIENT box size: the padding box, i.e. the border box minus its borders
// (padding stays inside it). `clientWidth` / `clientHeight` report this, and the
// scrollable range is measured against it — a bordered scroller's max scrollTop is
// scrollHeight minus the CLIENT height, so counting the borders in would clamp a
// scroll one border-width short (capybara's scroll.erb: a 50px, 1px-bordered
// #scrollable scrolls to 150, not 149).
// The INTERNAL scrollport of a box — its content+padding area, which scroll math and scrollIntoView measure
// against (an inline keeps its real box here, unlike its zero CSSOM clientWidth). A TABLE box's is its whole
// BORDER box in Blink: its border (and, separate-mode, its padding) is NOT subtracted, unlike every other box.
export function clientBoxOf(el) {
  const r = rectOf(el);
  if (isTableDisplay(displayOf(el))) return { width: r.width, height: r.height };
  const bw = borderWidthsOf(el);
  return { width: Math.max(0, r.width - bw.left - bw.right), height: Math.max(0, r.height - bw.top - bw.bottom) };
}
// A box with no CSSOM client box: one generating no box (display:contents), or a non-replaced inline — its
// clientLeft/clientTop/clientWidth/clientHeight are all 0 (Chrome). This is a CSSOM-getter rule ONLY: the
// internal `clientBoxOf` (the scrollport) keeps an inline's real box, which scroll math depends on.
function hasNoClientBox(el) {
  return !el || el.nodeType !== NODE_ELEMENT || !generatesBox(el) || isNonReplacedInline(el);
}
// The CSSOM clientWidth/clientHeight of a box (0 when it has no client box; the border box for a table).
export function clientDims(el) {
  if (hasNoClientBox(el)) return { width: 0, height: 0 };
  return clientBoxOf(el);
}
// `clientLeft` / `clientTop`: the used TOP / LEFT border width, rounded to an integer — 0 for a non-rendered or
// box-less element (display:contents, a non-replaced inline). For a border-collapse table this is the outer-half
// collapsed border, which the pass laid the table out with (`edgesOf`). (A left scrollbar in RTL would add to
// `clientLeft`; not modeled — rare.)
export function clientBorderTopLeft(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return { top: 0, left: 0 };
  ensureLayout();
  if (hasNoClientBox(el)) return { top: 0, left: 0 };
  const bw = borderWidthsOf(el);
  return { top: Math.round(bw.top), left: Math.round(bw.left) };
}

// The offsetParent's PADDING-box origin, which is what CSSOM-View measures `offsetLeft` /
// `offsetTop` from — its border edge is NOT the origin (Chrome: a box at the content origin of a
// `border: 5px; padding: 3px 4px` positioned parent reports 4 / 3, not 9 / 8).
export function paddingBoxOriginOf(el) {
  const b = documentBoxOf(el);
  if (!b) return null;
  // …except a NON-ATOMIC inline offsetParent, whose border box is the origin (Chrome, measured: a
  // positioned `<span style="border:5px;padding:3px 4px">` reports 5 for a child at its own
  // border edge, while an `inline-block` in the same shape reports 0).
  if (displayOf(el) === 'inline' || isSplitInline(el)) return { x: b.x, y: b.y };
  const bw = borderWidthsOf(el);
  return { x: b.x + bw.left, y: b.y + bw.top };
}

// Used border widths per side (a side whose style is none/hidden contributes 0).
// Reads the box's edges as the pass laid it out (`edgesOf`) — clientWidth / clientHeight / scrollWidth /
// scrollHeight go through here, and editors and virtualised lists read those on
// every keystroke, so this must not re-resolve 12 cascade properties per call
// (measured: 20 000 reads 217 ms unmemoised vs 117 ms memoised).
function borderWidthsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { top: 0, right: 0, bottom: 0, left: 0 };
  const e = edgesOf(el);
  return { top: e.bt, right: e.br, bottom: e.bb, left: e.bl };
}

// The element's rendered pieces, viewport-relative: one rect per line a fragmented inline
// broke over, and its single box otherwise. `getClientRects` reports exactly this — every
// RENDERED element has at least one box, even a zero-sized one (an empty `<span>` alone in a
// block is `[0, 0, 0, 0]` in Chrome, and one rect, not none), and one that isn't rendered has
// none at all.
export function clientRectsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return [];
  ensureLayout();
  const b = boxOf(el);
  if (!b || !generatesBox(el)) return [];
  const { sx, sy } = scrollShift(el);
  const boxes = b.fragmented ? fragmentsOf(el) : [b];
  const m = transformChain(el);
  return boxes.map((b) => {
    const r = { x: b.x - sx, y: b.y - sy, width: b.width, height: b.height };
    return m ? transformedRect(m, r) : r;
  });
}

// The box a synthetic POINTER is aimed at. WebDriver measures its in-view centre point on the
// element's FIRST client rect, not on its bounding box — and for an inline that wrapped, the
// bounding box's centre can miss the element entirely: a link's union spans two lines and its
// middle is the paragraph text between them (Chrome puts the click at 550,137; the union centre
// is 347,146, which hit-tests to the `<p>`).
export function pointerRectOf(el) {
  const r = clientRectsOf(el)[0] || rectOf(el);
  // …clipped to the viewport, as WebDriver's in-view centre point is: a first fragment scrolled
  // half off the top would otherwise put the pointer at a negative clientY, which reads as
  // obscured and is not where a browser would click.
  const vp = viewport();
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return {
    x, y,
    width:  Math.max(0, Math.min(r.x + r.width,  vp.width)  - x),
    height: Math.max(0, Math.min(r.y + r.height, vp.height) - y)
  };
}

// The inset property names, mapped to the physical side each reports. A flow-relative spelling
// names its side only once the writing mode is known, so it maps to '' and asks per element.
const INSET_SIDES = { __proto__: null, top: 'top', right: 'right', bottom: 'bottom', left: 'left',
  'inset-block-start': '', 'inset-block-end': '', 'inset-inline-start': '', 'inset-inline-end': '' };

// Which physical side a flow-relative inset names for THIS element — the cascade already resolves
// the writing mode and direction into exactly this map, and asking it here is what keeps
// `insetInlineStart` and `left` from ever disagreeing about the same box.
function flowInsetSide(el, prop) {
  return flowSides(el)[prop.slice('inset-'.length)];
}

// The containing block an INSET resolves against, in layout coordinates — the same box the
// placement itself used, so the two cannot disagree. An absolutely positioned box resolves against
// the nearest positioned ancestor's PADDING box (the initial containing block with none), a fixed
// one against the viewport, and a relative or sticky one against the CONTENT box of the block it
// sits in, exactly as a static box's percentages do.
function insetContainingBox(el, pos) {
  // A FIXED box measures against the viewport — unless an ancestor CONTAINS it, which is the one
  // thing that takes it off the viewport (`containsOutOfFlow`: a transform, a filter, containment).
  // The placement already resolved this and stamped the element it resolved against, so reading
  // the stamp is both O(1) and what keeps CSSOM and layout structurally unable to disagree about
  // which box an inset measures against (one geometry).
  if (pos === 'fixed' || pos === 'absolute') {
    const b = boxOf(el);
    return b && b.outOfFlow ? containingBlockBox(containingBlockOf(el)) : containingBlockFor(el, pos === 'fixed');
  }
  // A STICKY box's insets are measured against its nearest SCROLLPORT, not against the block that
  // holds it (css-position §sticky-pos — Chrome-measured: `top: 10%` inside a 100px block in a
  // 200px `overflow: hidden` container resolves to 20px, not 10).
  if (pos === 'sticky') {
    for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
      if (!hasLayoutBox(p) || p.nodeType !== NODE_ELEMENT || displayOf(p) === 'contents') continue;
      // A SCROLLER, which `overflow: clip` is not — it clips and forbids scrolling, so a sticky box
      // inside one sticks within the scroller AROUND it, as it does in geometry.rs `scrollport`.
      if (!scrollsContent(p)) continue;
      const box = inlineContainingBox(p);
      const e = edgesOf(p);
      return {
        x: box.x + e.left,
        y: box.y + e.top,
        width:  Math.max(0, box.width  - e.left - e.right),
        height: Math.max(0, box.height - e.top  - e.bottom)
      };
    }
    // …and with no scroller of its own the page is one: the sticky box sticks within the viewport.
    const svp = viewport();
    return { x: 0, y: 0, width: svp.width, height: svp.height };
  }
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    // `display: contents` generates no box of its own, so it is nobody's containing block — the
    // walk passes through it to the block that really holds the flow.
    if (!hasLayoutBox(p) || displayOf(p) === 'contents') continue;
    const box = inlineContainingBox(p);
    // A percentage padding or border on the PARENT resolves against the parent's own containing
    // block, not against its border box — the idiom every other read-time caller here uses. The
    // wrong basis also threw away and recomputed the parent's edge memo on every inset read.
    const e = edgesOf(p);
    return {
      x: box.x + e.left,
      y: box.y + e.top,
      width:  Math.max(0, box.width  - e.left - e.right),
      height: Math.max(0, box.height - e.top  - e.bottom)
    };
  }
  const vp = viewport();
  return { x: 0, y: 0, width: vp.width, height: vp.height };
}

// The insets of a POSITIONED box as CSSOM reports them, which is two different numbers depending on
// the side. A side that is NOT `auto` reports its own computed value absolutized against the
// containing block — which is why an OVER-CONSTRAINED box reports both sides rather than the one
// layout honoured — and a side that IS `auto` reports the distance layout ended up putting there.
// So both come back and the resolved-value read picks per side; `declared` is null exactly where
// the side is `auto`.
//
// `used` is measured to the box's MARGIN edge, which is where CSS puts the inset: `top: auto;
// bottom: 3px` on an empty box in a 200px containing block resolves `top` to 197px. A relative or
// sticky box has no such geometry — it is shifted from where the flow put it — so its used inset IS
// that shift, and the opposite side is its negation.
// A non-atomic INLINE box resolves a LENGTH inset but not a PERCENTAGE one: Chrome reports the
// computed `10%` back, and `auto` on the far side, while turning a `5px` into a used offset like
// any other box (measured, 151.0.7922.169). The axes decide separately — `top: 10%; left: 5px`
// answers `10%` down and `-5px` across.
function inlinePercentageAxis(el, startSide, endSide) {
  if (displayOf(el) !== 'inline' && !isSplitInline(el)) return false;
  const start = declaredValue(el, startSide);
  const raw = (start != null && String(start).trim().toLowerCase() !== 'auto')
    ? start : declaredValue(el, endSide);
  return raw != null && /%$/.test(String(raw).trim());
}

// Memoised per layout pass: a positioning library reads all four sides every frame, and each side
// otherwise recomputed the whole bundle — the containing-block walk, four `resolveLayoutProp`s and
// the edge resolution — and threw three quarters of it away. Measured on a positioned box: all four
// sides 24.2 → 19.4 µs, against 15.9 µs for one.
function usedInsetsOf(el) {
  if (memoFresh(el, '_lbInsetsPass')) return el._lbInsets;
  el._lbInsetsPass = memoStamp(el);
  el._lbInsets = computeUsedInsets(el);
  return el._lbInsets;
}

function computeUsedInsets(el) {
  const pos = positionOf(el);
  if (pos === 'static') return null;
  const box = boxOf(el);
  if (!box) return null;
  // CSSOM makes the resolved value the COMPUTED value when the resolved display is `none` or
  // `contents` — and a `display: contents` element has no box of its own to measure from, however
  // much geometry the engine hangs off it.
  if (displayOf(el) === 'contents') return null;
  const cb = insetContainingBox(el, pos);
  const declared = {
    top:    resolveLayoutProp(el, 'top',    cb.height),
    right:  resolveLayoutProp(el, 'right',  cb.width),
    bottom: resolveLayoutProp(el, 'bottom', cb.height),
    left:   resolveLayoutProp(el, 'left',   cb.width)
  };
  let used;
  if (pos === 'absolute' || pos === 'fixed') {
    const e = edgesOf(el);
    used = {
      top:    box.y - e.mt - cb.y,
      left:   box.x - e.ml - cb.x,
      bottom: (cb.y + cb.height) - (box.y + box.height + e.mb),
      right:  (cb.x + cb.width)  - (box.x + box.width  + e.mr)
    };
  } else {
    const shift = relativeOffset(el, cb.width, cb.height);
    // `null` where the box owes no used value on that axis; the reader then reports the computed
    // one, which is what a browser does for a percentage inset on an inline.
    const acrossPct = inlinePercentageAxis(el, 'left', 'right');
    const downPct   = inlinePercentageAxis(el, 'top', 'bottom');
    used = {
      top:    downPct   ? null : shift.y,
      bottom: downPct   ? null : -shift.y,
      left:   acrossPct ? null : shift.x,
      right:  acrossPct ? null : -shift.x
    };
    if (downPct)   { declared.top = null;  declared.bottom = null; }
    if (acrossPct) { declared.left = null; declared.right  = null; }
  }
  return { cb, declared, used };
}

export function rectOf(el) {
  const ZERO = { x: 0, y: 0, width: 0, height: 0 };
  if (!el || el.nodeType !== NODE_ELEMENT || !(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return ZERO;
  ensureLayout();
  return renderedBox(el) || ZERO;
}

// The rect an IntersectionObserver measures against its root: the target's viewport-relative
// border box, or `null` when the target isn't rendered at all, or when an ancestor scroll container
// clips it away entirely — a clipped-away target intersects nothing, which is the whole point of
// observing one inside a scroller. Distinct from `rectOf`, which flattens both cases to a zero rect
// (Capybara's `Node#rect` has no null).
// The clip rectangles a PAINTER has to intersect before drawing `el`: every ancestor that clips,
// in viewport coordinates, opened out on whichever axis it does not clip (`overflow-y: clip` lets
// a child hang off the side). A fixed box escapes everything above it, so the walk stops there —
// the same terminator `isClipped` uses, and the same per-axis flags `clipsContent` stamps.
// `self`: the element's OWN overflow clip as well, which is what clips its CONTENT (its text, its bitmap) and never its
// own box.
export function clipBoxesFor(el, self = false) {
  // No `ensureLayout()` of its own: the painter has already laid the page out (that is what
  // produced the boxes it is walking), and every extra call site on `ensureLayout` is one more for
  // V8 to weigh when inlining it into the geometry reads that DO run per element — measured,
  // adding two cost several percent of a suite that never paints anything.
  const OPEN = 1e7;
  const out = [];
  for (let p = self ? el : flatTreeParent(el); p; p = flatTreeParent(p)) {
    const clip = clipFlags(p);
    if (clip & (CLIP_X | CLIP_Y)) {
      // …in the UNTRANSFORMED space, which is the one the painter draws in and the one every
      // clip-vs-box comparison here is written against. A clipper's transformed rect would be
      // intersected with untransformed content, and the two would disagree about where the
      // scrollport is.
      const r = renderedBoxUntransformed(p);
      if (r) {
        out.push({
          x:      clip & CLIP_X ? r.x : -OPEN,
          y:      clip & CLIP_Y ? r.y : -OPEN,
          width:  clip & CLIP_X ? r.width  : OPEN * 2,
          height: clip & CLIP_Y ? r.height : OPEN * 2,
          // …paired with the matrix THIS clipper is drawn under, which is not the one its clipped
          // descendant is drawn under. A scrollport holds still while its child translates out of
          // it; drawn under the child's own matrix the clip travelled WITH the child and painted
          // ink a browser clips away (measured against Chrome: red at x 220 where Chrome has none).
          //
          // The PAINTER's form of it — a 2D affine — since that is what lays the rect down.
          // `false` — a map the painter cannot express — must not read as "no transform" here
          // either, so it clips with no matrix rather than at the layout position.
          m: paintTransformOf(p) || null
        });
      }
    }
    if (isFixedBox(p)) break;
  }
  return out;
}

export function observedRect(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  if (!(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return null;
  ensureLayout();
  if (!hasLayoutBox(el) || isClipped(el)) return null;
  return renderedBox(el);
}

// Where a scroll request lands, WITHOUT applying it: `{el, x, y}`, or null when there's nothing to
// scroll. `self` is the element the request was made on — the document root (html/body) scrolls the
// DOCUMENT (the documentElement offset, which rectOf/isObscured subtract), anything else scrolls
// ITSELF. Modes: explicit `[x, y]`, or a position keyword. A scroll aimed at a TARGET element is
// the other algorithm — `applyScrollIntoView` below, which walks the whole scroller chain.
export function scrollTargetFor(self, pos, x, y) {
  const root = globalThis.document && globalThis.document.documentElement;
  const isRoot = !!self && (self._tag === 'html' || self._tag === 'body' || self === root);
  const scrollEl = isRoot ? root : self;
  if (!scrollEl) return null;
  ensureLayout();
  let sx = scrollOffsetOf(scrollEl, 0), sy = scrollOffsetOf(scrollEl, 1);
  if (x != null || y != null) {
    sx = +x || 0; sy = +y || 0;
  } else if (pos === 'top')    { sy = 0; }
  else if (pos === 'bottom')   { sy = maxScroll(scrollEl, isRoot).y; }
  else if (pos === 'center')   { sy = maxScroll(scrollEl, isRoot).y / 2; }
  return clampScroll(scrollEl, isRoot, sx, sy);
}

// One axis of a `scrollIntoView` alignment: how far the scroller must move so a box at `pos`
// (scrollport-relative) of length `size` sits where `align` asks in a `visible`-long scrollport.
// `nearest` is the only conditional one — no move while the box fully fits, else the minimum to
// the closer edge; `start` / `center` / `end` align unconditionally, exactly as Chrome re-aligns
// an already-visible box.
function alignDelta(pos, size, visible, align) {
  if (align === 'center')  return pos - (visible - size) / 2;
  if (align === 'end')     return (pos + size) - visible;
  if (align !== 'nearest') return pos;                          // start
  if (fitsWithin(pos, size, visible)) return 0;
  // The spec's `nearest` table (CSSOM View §12.3) crosses over for a box TALLER than the
  // scrollport: a start edge sticking out aligns the END edge (and vice versa) — that is the
  // minimal move, since the tall box can cover the port either way. Same-edge alignment there
  // overshot by the whole size difference, dragging a mostly-visible tall panel's bottom out
  // of view.
  if (pos < 0) return size > visible ? (pos + size) - visible : pos;
  return size > visible ? pos : (pos + size) - visible;
}

// CSSOM View §12.4: `scrollIntoView` runs its alignment for EVERY ancestor scrolling box,
// innermost outwards — the document scroller is only the outermost of them. The chain is what
// makes a row inside a modal's `overflow: auto` body reachable at all: aligning only the document
// moved the PAGE under the modal and left the row exactly as clipped as before (Discourse's
// edit-categories modal pages in more rows only once its last row is fully visible to an
// IntersectionObserver). Capybara's `scroll_to(element, align:)` rides the same code — the real
// drivers it stands in for run literally `element.scrollIntoView(...)`.
//
// Alignments per axis: start / center / end / nearest. The legacy boolean maps to
// `{block: 'start'}` (true / default) or `{block: 'end'}` (false), inline `nearest` either way.
export function applyScrollIntoView(el, block = 'start', inline = 'nearest') {
  if (!el || el.nodeType !== NODE_ELEMENT) return;
  ensureLayout();
  const root = globalThis.document && globalThis.document.documentElement;
  // §12.4 terminates when the element has no box — running the alignment against the zero rect
  // an unrendered element reports scrolled the page toward the top instead of doing nothing.
  if (el !== root && !hasLayoutBox(el)) return;
  // A fixed-position box is viewport-anchored: no scroller moves it, so there is nothing to
  // bring into view (scrollShift returns zero for it for the same reason).
  if (isFixedBox(el)) return;
  // The box scrolled to is the target's border box grown by its `scroll-margin` — the gap a page
  // asks to be left around a box when it is scrolled to, how a site with a fixed header keeps an
  // anchor target from landing UNDER it (Redmine's `#update { scroll-margin-block-start: 50px }`).
  // `<length>` only — a percentage is invalid here, so it resolves against nothing.
  const smTop    = resolveLayoutProp(el, 'scroll-margin-top')    || 0;
  const smBottom = resolveLayoutProp(el, 'scroll-margin-bottom') || 0;
  const smLeft   = resolveLayoutProp(el, 'scroll-margin-left')   || 0;
  const smRight  = resolveLayoutProp(el, 'scroll-margin-right')  || 0;
  // The chain is the ancestor SCROLLING BOXES, which includes the viewport itself — so a
  // `scrollIntoView` on the root element (WPT calls it on `document.scrollingElement`) still
  // aligns the document, even though the viewport is not an ancestor *element* of html.
  for (let p = el === root ? root : flatTreeParent(el); p; p = flatTreeParent(p)) {
    if (p === root || scrollsContent(p)) {
      // The scrollport is the PADDING box — borders neither scroll nor count toward the alignment
      // span (Chrome aligns `end` against `top + clientHeight`) — in viewport coords, like the
      // target rect re-read after each inner scroll just moved it.
      let port = null;
      if (p === root) {
        port = { x: 0, y: 0, ...viewport() };
      } else {
        const rb = renderedBoxUntransformed(p);          // the clip space, as above
        if (rb) {
          const bw = borderWidthsOf(p), cb = clientBoxOf(p);
          port = { x: rb.x + bw.left, y: rb.y + bw.top, width: cb.width, height: cb.height };
        }
      }
      if (port) {
        const r = rectOf(el);
        const dy = alignDelta(r.y - smTop  - port.y, r.height + smTop  + smBottom, port.height, block);
        const dx = alignDelta(r.x - smLeft - port.x, r.width  + smLeft + smRight,  port.width,  inline);
        if (dx || dy) {
          // The document offset is clamped to its (exact) extent; an ELEMENT scroller is assigned
          // unclamped, like its scrollTop setter — its content extent is the coarse one, and
          // clamping against an under-measured extent turns a real scroll into one that silently
          // goes nowhere.
          const sx = scrollOffsetOf(p, 0) + dx, sy = scrollOffsetOf(p, 1) + dy;
          const to = p === root ? clampScroll(p, true, sx, sy) : { x: Math.max(0, sx), y: Math.max(0, sy) };
          scrollBoxTo(p, to.x, to.y);
        }
      }
      if (p === root) break;
    }
    // A fixed ancestor — scroller or not — carries this box with it: its own scrollers already
    // got their alignment above, and scrolling anything OUTSIDE it moves the page under the
    // fixed box without moving the target — the modal-under-page failure class this walk exists
    // to avoid.
    if (isFixedBox(p)) break;
  }
}

// How far a scroll box can scroll: content extent minus the visible size, never negative. Browsers
// clamp to this — a scroll past the end lands AT the end — and pages read the same number back as
// `scrollHeight - clientHeight`, so an unclamped offset (we used to jump to a "far down" sentinel)
// disagrees with everything the page computes.
function maxScroll(scrollEl, isRoot) {
  const ext = contentExtent(scrollEl);
  const vp = viewport();
  // The visible span is the CLIENT box (padding box) — the borders never scroll.
  const cb = isRoot ? null : clientBoxOf(scrollEl);
  const visW = isRoot ? vp.width  : cb.width;
  const visH = isRoot ? vp.height : cb.height;
  return { x: Math.max(0, ext.width - visW), y: Math.max(0, ext.height - visH) };
}

function clampScroll(scrollEl, isRoot, sx, sy) {
  return { el: scrollEl, x: clampToRange(scrollEl, isRoot, 'x', sx), y: clampToRange(scrollEl, isRoot, 'y', sy) };
}
// One axis's offset clamped to the scrollable range — `0..max` from a left or top origin, and `-max..0` for a viewport
// scrolling from its RIGHT (CSSOM View §6: non-positive offsets there, so what lies left of the origin — the whole of a
// `vertical-rl` page wider than the viewport, an rtl page's overflow — is reached by scrolling negative). An ELEMENT
// scrolling from its right keeps the positive range it has always had here (its offsets are unclamped besides).
function clampToRange(scrollEl, isRoot, axis, value) {
  const max = maxScroll(scrollEl, isRoot);
  if (axis === 'y') return Math.min(Math.max(0, value), max.y);
  return isRoot && principalStartsRight(scrollEl) ? Math.max(-max.x, Math.min(0, value)) : Math.min(Math.max(0, value), max.x);
}

// Bring `el` into view if it isn't — what every driver does before interacting with an element
// (Selenium's `scroll_if_needed`). Only when needed: a gratuitous scroll would move the page out
// from under the rest of the test. Returns true if it scrolled.
export function ensureInView(el, align = 'center') {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  ensureLayout();
  const root = globalThis.document && globalThis.document.documentElement;
  // Already showing — in the viewport AND not clipped away by any scroll container on the way up?
  // Then touch nothing. This is the overwhelmingly common case (a test clicks what it can see), and
  // walking the scroll chain for it fires scroll events at every ancestor, which editors and
  // virtual scrollers react to: doing that on every click hung Avo's ACE-backed code field.
  const r0 = rectOf(el), vp0 = viewport();
  if (!isClipped(el) && fitsWithin(r0.x, r0.width, vp0.width) &&
      fitsWithin(r0.y, r0.height, vp0.height)) return false;
  let scrolled = false;
  // Innermost scroll box outwards, ending at the document — `scrollIntoView({block: 'nearest'})`,
  // which is what WebDriver's element-click runs. Scrolling only the document instead moved the
  // PAGE for an item inside an `overflow: auto` list and left the item exactly as hidden as before.
  for (let p = el; p; p = flatTreeParent(p)) {
    if (p !== root && !(p !== el && scrollsContent(p))) continue;
    const visible = p === root ? { x: 0, y: 0, ...viewport() } : renderedBox(p);
    if (!visible) continue;
    const r = rectOf(el);
    // Already fully showing in THIS box? Then leave it alone — that is the one case Chrome's
    // `scrollIntoViewIfNeeded` does nothing for, and scrolling anyway would move the page out
    // from under everything the test looks at next.
    if (fitsWithin(r.x - visible.x, r.width,  visible.width) &&
        fitsWithin(r.y - visible.y, r.height, visible.height)) continue;
    const dx = scrollDeltaInto(r.x - visible.x, r.width,  visible.width,  align);
    const dy = scrollDeltaInto(r.y - visible.y, r.height, visible.height, align);
    if (!dx && !dy) continue;
    // Scroll THIS box, not whatever `applyScrollBy` would map it to: it treats `body` as the
    // document scroller (right for Capybara's `scroll_to`), so an app shell whose body is its own
    // `overflow: auto` box would have the delta applied to a root that can't scroll at all.
    const to = clampScroll(p, p === root, scrollOffsetOf(p, 0) + dx, scrollOffsetOf(p, 1) + dy);
    scrollBoxTo(p, to.x, to.y);
    scrolled = true;
  }
  return scrolled;
}

// How far to scroll one axis so a box at `pos` (viewport coords) of length `size` fits in a
// `visible`-long viewport, using the alignment the real drivers this one substitutes for use.
// Cuprite / Ferrum and Playwright both scroll for a click through CDP's
// `DOM.scrollIntoViewIfNeeded`, which is Blink's `CenterIfNeeded`: a box that is entirely OUT of
// view is CENTRED, one that is merely clipped moves the minimum to its nearest edge, and one that
// already fits is left alone. (Selenium's element-click is the `nearest` variant; the app suites
// here declare `:cuprite` / `:playwright`, and a driver that stands in for those has to leave the
// page where they leave it.)
//
// Measured, Avo's `tabs_spec` "keeps the pagination on tab": clicking a tab link 1416px down a
// 1024-tall viewport, Chrome scrolls to 921 — exactly `1416 - (1024 - 34) / 2`. Scrolling the
// MINIMUM instead stopped at 332, which left the tab's lazy `<turbo-frame>` 24px below the fold,
// so Turbo declined to load it and the pagination the spec waits for never rendered.
function scrollDeltaInto(pos, size, visible, align = 'center') {
  // Blink's `ScrollAlignment::CenterIfNeeded` is three-way, and each branch is measured against
  // Chrome 151 below. FULLY SHOWN — wholly inside the scrollport, or (for a box taller than it)
  // wholly covering it — moves nothing.
  if (fitsWithin(pos, size, visible)) return 0;
  const nearest = pos < 0 || size > visible ? pos : (pos + size) - visible;
  // PARTIALLY shown: the closest edge, i.e. the minimum move. A 1000px panel starting 100px down a
  // 681-tall viewport lands at 100, not the 267 centring would give; a 34px target clipped 10px by
  // the top edge lands at 2000, not 1549.
  if (align === 'nearest' || (pos < visible && pos + size > 0)) return nearest;
  // ENTIRELY out of view: centred. Rounded, because a scroll offset is a whole pixel in Blink —
  // Chrome reports 1549 for the 1548.5 the centre works out to, and 2282 for 2281.5.
  return Math.round(pos - (visible - size) / 2);
}
// Is a box at `pos` of length `size` fully shown in a `visible`-long scrollport?
// The used margin on one side: what the box's placer distributed, else what the cascade resolved.
// Stamped per side, so a box whose horizontal margins were distributed still reports its vertical
// ones from the cascade.
function usedMargin(el, side, resolved) {
  const b = boxOf(el), m = b && b.margins;
  return m && m[side] != null ? m[side] : resolved;
}

function fitsWithin(pos, size, visible) {
  return (pos >= 0 && pos + size <= visible) || (pos <= 0 && pos + size >= visible);
}

// Scroll `self` BY a delta from where it is now (Capybara's `scroll_to(:current, offset: [x, y])`).
// Clamp a scroll offset to `el`'s scrollable range on one axis — the setter's
// version of what scrollTargetFor's clampScroll does for the driver paths.
export function clampScrollOffset(el, axis, value) {
  if (!el || el.nodeType !== NODE_ELEMENT) return Math.max(0, value);
  ensureLayout();
  const root = globalThis.document && globalThis.document.documentElement;
  // The BODY is not the document scroller in standards mode — clamping its own overflow against
  // the viewport's range zeroed a scroll a browser allows (`html { overflow: hidden }` makes the
  // body a scroller in its own right, and Chrome takes its 100).
  const doc = globalThis.document;
  const isRoot = el === root || el._tag === 'html' || (doc && doc.scrollingElement === el);
  return clampToRange(isRoot ? root : el, isRoot, axis, value);
}

export function applyScrollBy(self, dx, dy) {
  const root = globalThis.document && globalThis.document.documentElement;
  const isRoot = !!self && (self._tag === 'html' || self._tag === 'body' || self === root);
  const scrollEl = isRoot ? root : self;
  if (!scrollEl) return null;
  ensureLayout();
  const to = clampScroll(scrollEl, isRoot, scrollOffsetOf(scrollEl, 0) + (+dx || 0),
                                           scrollOffsetOf(scrollEl, 1) + (+dy || 0));
  scrollBoxTo(scrollEl, to.x, to.y);
  return scrollEl;
}

// Capybara `scroll_to` — drive the scroll offset so a subsequent geometry read (obscured? / rect)
// reflects the new position. Applied through the public setters so scroll / scrollend fire
// (IntersectionObserver etc.). Returns the scrolled element.
export function applyScrollTo(self, target, pos, x, y) {
  if (target) {
    // Capybara's `scroll_to(element, align:)` is `element.scrollIntoView(...)` in the real
    // drivers this one stands in for (align :top → the legacy `true`, :bottom → `false`,
    // :center → `{block: 'center'}`); `self` plays no part once a target is named.
    applyScrollIntoView(target, pos === 'bottom' ? 'end' : pos === 'center' ? 'center' : 'start');
    return target;
  }
  const to = scrollTargetFor(self, pos, x, y);
  if (!to) return null;
  scrollBoxTo(to.el, to.x, to.y);
  return to.el;
}

// Scroll a box through its PUBLIC setters, so `scroll` / `scrollend` fire — the viewport through
// `document.scrollingElement`, which in quirks mode is the BODY: there the root's own setters are
// ignored (Chrome), and writing them left a quirks page unscrolled by `scrollIntoView` and by every
// click on an element below the fold.
function scrollBoxTo(el, x, y) {
  const doc = globalThis.document;
  const target = doc && el === doc.documentElement ? (doc.scrollingElement || el) : el;
  target.scrollLeft = x;
  target.scrollTop  = y;
}

// ── Resolved values (CSSOM) ──────────────────────────────────────────────────
// What `getComputedStyle` reports for the properties whose resolved value is the
// USED one: a rendered box's own geometry, in px. `null` means "this element has no
// box" — a `display: none` element, or a document that hasn't been laid out — and
// the caller then reports the COMPUTED value instead, which is what a browser does
// (Chrome on `display: none; width: 10em` says `160px`, and `height: auto` stays
// `auto`).
//
// Serving these from the layout engine is the same "ONE geometry" rule the rect
// APIs follow: `getComputedStyle(el).width` and `el.getBoundingClientRect().width`
// are two views of one box, and they used to disagree by a whole unit system —
// the style side reported the author's `10em` verbatim.
globalThis.__csimUsedStyle = function (el, prop) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  // The insets of a POSITIONED box. `usedInsetsOf` explains the two-answers-per-side rule; `null`
  // means "no used value" and the caller reports the computed one — which is right for a STATIC box
  // (`10%` stays `10%`) and for a sticky box's `auto` (the offsets constrain a scroll rather than
  // place the box, and every browser reports the keyword back).
  //
  // Ahead of `ensureLayout` because a STATIC box needs neither it nor the edge resolution below to
  // be told "no" — on a page nothing has laid out yet, reading `top` would otherwise lay the whole
  // thing out to answer with the computed value it started from. What the read does cost is the
  // `position` lookup itself: a static div's `top` goes 415 → 1348 ns on a page that declares
  // `position` in a rule, which is what any other resolved value costs there (`color` is 1297 on
  // the same page) and does not move the local suite's wall time (32.7-32.9 s either way).
  if (INSET_SIDES[prop] !== undefined) {
    if (positionOf(el) === 'static') return null;
    if (!(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return null;
    ensureLayout();
    const insets = usedInsetsOf(el);
    if (!insets) return null;
    const side = INSET_SIDES[prop] || flowInsetSide(el, prop);
    if (insets.declared[side] != null) return insets.declared[side];
    return positionOf(el) === 'sticky' ? null : insets.used[side];
  }
  if (!(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return null;
  ensureLayout();
  const box = boxOf(el);
  if (!box) return null;
  const cbW  = box.cbW !== null ? box.cbW : box.width;
  const e    = edgesOf(el);

  // `inline-size` / `block-size` are the same two boxes named by FLOW rather than by axis: in a
  // horizontal writing mode the inline one is the width, in a vertical mode the height. Chrome
  // reports them in px for a rendered box exactly as it does `width` / `height`.
  if (prop === 'inline-size' || prop === 'block-size') {
    const horiz = inlineAxisIsHorizontal(el);
    prop = (prop === 'inline-size') === horiz ? 'width' : 'height';
  }

  switch (prop) {
    // The used value of the `width` PROPERTY, which is the box `box-sizing` names:
    // a content-box element reports its content width, a border-box one its border
    // width. Measured in Chrome 151 — `box-sizing: border-box; width: 300px;
    // padding: 0 40px` reports `300px`, not the 220px of content inside it.
    case 'width':  return isBorderBox(el) ? box.width  : Math.max(0, box.width  - e.left - e.right);
    case 'height': return isBorderBox(el) ? box.height : Math.max(0, box.height - e.top  - e.bottom);

    case 'padding-top':    return e.top    - e.bt;
    case 'padding-right':  return e.right  - e.br;
    case 'padding-bottom': return e.bottom - e.bb;
    case 'padding-left':   return e.left   - e.bl;

    // …and NOT the border widths, whose resolved value is the computed one (CSSOM names no border property among the
    // used-value ones): a collapsing table's cell reports the width it declares, not the half of the shared edge its
    // box keeps (Chrome: `td { border: 4px solid }` is `4px`), and a side whose style draws nothing reports 0.

    // An `auto` margin resolves to the slack it took, and only whoever PLACED the box knows how
    // much that was: block flow and an abspos box between two insets across (§10.3.3 / §10.3.7),
    // an abspos box between `top` and `bottom` down (§10.6.4), and a flex item on either axis.
    // Whatever nobody distributed is what the edges say (`edgesOf`) — `auto` reads as zero there,
    // which is what CSS says it is everywhere else.
    case 'margin-left':   return usedMargin(el, 'left',   e.ml);
    case 'margin-right':  return usedMargin(el, 'right',  e.mr);
    case 'margin-top':    return usedMargin(el, 'top',    e.mt);
    case 'margin-bottom': return usedMargin(el, 'bottom', e.mb);

    // NOT the insets. Their resolved value is neither the box's offset nor the
    // declared length but a mix: Chrome reports a SPECIFIED inset as itself (`left: 0;
    // right: 0; width: 40px; margin: auto` answers `left: 0px`, though the box sits
    // 180px in) and derives only an `auto` one from the box, and `relative` reports the
    // SHIFT rather than a distance to the containing block. Deriving all four from the
    // box — the obvious implementation — is wrong in the first case, so they resolve to
    // their computed values until that model is built (CSSOM has eight WPT files on it:
    // static, relative, absolute, fixed, sticky, grid, and the no-box cases).
    default: return null;
  }
};

