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
// and the per-element predicates those readers share (`generatesBox`, `positionOf`, …).
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
  maybeVerifyArena, scrollOffsetOf, scrollShiftOf, stickyOffsetOf, laidOutBoxOf, renderedBoxOf,
  layoutRootAloneIn, clippedAwayOf, hitTestIn, paintOrderIn, scrollSizeOf, boxInfoOf, fragmentsIn, usedInsetsOf,
  renderedLegendOf, scrollIntoViewPlanOf, scrollRangeOf, clientRectsIn, paintTransformOf as paintTransformIn,
  paintQuadOf as paintQuadIn, offsetsIn,
  arenaNid, REALM as NATIVE_REALM
} from './native-query-shadow.js';
import { isLaidOutNode, styleEngineNow, resolveLayoutProp, cascadeLayoutEpoch, settleLayoutInvalidation, inlineAxisIsHorizontal, flowSides, declareStyledMemos, flushStyleEngine, currentStructureGen, engineValue } from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { natFontGen, teachFaces } from './font-metrics.js';
// Box props are read through `declaredValue` — the style engine's computed values, which getComputedStyle reads too:
// ONE geometry means one value resolution.
import { declaredValue, pseudoNodeFor, linkGeneratedBox, placeholderNodeFor, computedPositionOf } from './style-proxy.js';

// Bumped once per layout pass. Per-element results that are only valid within a pass (used display,
// subtree text length) are stamped with it, so each element is measured ONCE however many times its
// ancestors ask — an editor whose every token is a nested `<span>` made the un-memoised walks
// quadratic and typing into it timed out.
let layoutPass = 0;

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
// whether it is out of flow and placed against the viewport, how it clips, and whether it is a non-replaced inline box
// and a table box. Null where it gave it none: one not
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
    outOfFlow: f[25] !== 0, fixed: f[25] === NL_OOF_FIXED && f[26] === 1, clip: f[29],
    inlineBox: f[30] === 1, table: f[31] === 1
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
  // (…and the text pieces a painting pass asked for: `[x, y, baseline, width, justify, owner nid, placeholder, steps at,
  // steps]` beside each text, as the runs `recordingRuns` hands the painter — a control's placeholder drawn in its
  // `::placeholder`, and a piece drawn a character at a time with the pen steps native measured it by, `[advance, step,
  // size]` per character: walk_ops.rs `paint_rows`)
  if (!painting) return { ok: true, paintRuns: null };
  const [paintRows, paintTexts, paintSteps] = answer;
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
  for (let k = 0, i = 0; k < paintRows.length; k += 9, i++) {
    const written = paintRows[k + 5] >= 0 ? nodeOf(paintRows[k + 5]) : null;
    if (written === undefined) return { ok: false, reason: 'rust: text run without a node' };
    const owner = paintRows[k + 6] === 1 ? placeholderNodeFor(written) : written;
    const steps = paintRows[k + 8] > 0 ? paintSteps.subarray(paintRows[k + 7], paintRows[k + 7] + 3 * paintRows[k + 8]) : null;
    paintRuns.push({ text: paintTexts[i], x: paintRows[k], y: paintRows[k + 1], baseline: paintRows[k + 2], owner,
                     width: paintRows[k + 3], steps });
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
    if (engineValue(el, 'display') === 'none') return;         // a `display:none` subtree isn't rendered
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

// A `<br>` that IS a line break: an INLINE-LEVEL one. HTML's UA sheet gives it `display-outside: newline`, and an author
// `display` replaces that like any other declaration — so a block-level `<br>` is an (empty) block box, and a floated
// or absolutely positioned one (blockified) leaves the line, as the spec reads and Firefox renders. (Chrome keeps every
// `<br>` a break whatever it declares; where the spec and Blink part, the spec is the bar.) Where both engines agree
// past the letter of it — an `inline-block` `<br>` still breaks, and no edge of one shows — so does this. A `<br>` a
// flex or grid container holds is part of the text run beside it, whatever its computed display (blockified as an
// item's) says — as the walk takes it (walk.rs `blockified_break`).
const INLINE_LEVEL = new globalThis.Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table']);
const ITEM_CONTAINER_DISPLAYS = new globalThis.Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
function isLineBreak(el) {
  if (el._tag !== 'br') return false;
  const d = engineValue(el, 'display');
  if (d === undefined || d === 'none' || d === 'contents') return false;
  const pos = positionOf(el);
  if (pos === 'absolute' || pos === 'fixed') return false;
  if (INLINE_LEVEL.has(d)) return true;
  let p = flatTreeParent(el);
  while (p && p.nodeType === NODE_ELEMENT && engineValue(p, 'display') === 'contents') p = flatTreeParent(p);
  return !!p && p.nodeType === NODE_ELEMENT && ITEM_CONTAINER_DISPLAYS.has(engineValue(p, 'display'));
}

// Is `el` its fieldset's RENDERED LEGEND (HTML §15.3.13, geometry.rs `rendered_legend`): the first child box of the
// fieldset's box that is a `<legend>`, neither floated nor absolutely positioned — laid out as a shrink-to-fit block in
// the fieldset's top border whatever display it declares?
export function renderedLegend(el) {
  if (el._tag !== 'legend' || el._ns !== HTML_NS) return false;
  flushStyleEngine();
  return renderedLegendOf(el);
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
  return fn(painted);
}
// Total layout passes since the VM booted — the perf gate's primary count metric
// (`spec/support/perf_gate.rb`). One full pass fires per read-after-mutation; a
// regression that adds passes moves this deterministically,
// independent of machine / Ruby version / JS engine.
globalThis.__csimLayoutPasses = () => layoutPass;



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
function generatesBox(el) {
  if (memoFresh(el, '_lbGenPass')) return el._lbGen;
  if (el._styled === false) declareStyledMemos(el);
  el._lbGenPass = memoStamp(el);
  return (el._lbGen = engineValue(el, 'display') !== 'contents');
}
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
// The box the PAINTER draws — the one layout placed — and, separately, the matrix it draws it
// UNDER. The two are handed over apart because the canvas applies the matrix itself: the painter
// sets it, draws the box, its borders, its bitmap and its text runs in the coordinates layout gave
// them, and the raster comes out transformed. Handing over a transformed RECT instead moved the box
// and left everything inside it behind.
export function paintRectOf(el) {
  return renderedBoxUntransformed(el) || { x: 0, y: 0, width: 0, height: 0 };
}
// The map the PAINTER draws under — a 2D affine, which is all a canvas has (geometry.rs `paint_transform`) — memoised
// per element per pass and per scroll (the chain takes each origin where the scrolls carried it), because the run loop
// asks once per TEXT RUN and not once per element. `false` (not null) says the element has a transform the painter
// cannot express at all, which a caller must not read as "no transform" and draw at the layout position.
const AFFINE = new Float64Array(6);
export function paintTransformOf(el) {
  if (el._lbPaintTfScroll === scrollEpoch && memoFresh(el, '_lbPaintTfPass')) return el._lbPaintTf;
  const kind = paintTransformIn(el, AFFINE);
  el._lbPaintTf = kind === 1 ? Array.from(AFFINE) : kind === 2 ? false : null;
  el._lbPaintTfPass = memoStamp(el);
  el._lbPaintTfScroll = scrollEpoch;
  return el._lbPaintTf;
}
// …and the true quad the box projects to, for the painter to clip against (`paint_quad`) — null where the map is
// affine and the quad is already exactly what the matrix draws.
const QUAD = new Float64Array(8);
export function paintQuadOf(el) {
  if (!paintQuadIn(el, QUAD)) return null;
  return [0, 2, 4, 6].map((k) => ({ x: QUAD[k], y: QUAD[k + 1] }));
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
// The CLIENT box of a box — its padding box, the scrollport — as the layout sized it: what a `transform` draws it as
// is no part of it (Chrome: a 100px scroller under `scale(0.5)` keeps a clientHeight of 100). A TABLE box's is its
// whole BORDER box in Blink: its border (and, separate-mode, its padding) is NOT subtracted, unlike every other box.
// Asked once the layout is up to date.
function clientBoxOf(el) {
  const r = renderedBoxUntransformed(el) || { x: 0, y: 0, width: 0, height: 0 };
  const box = boxOf(el);
  if (box && box.table) return { width: r.width, height: r.height };
  const bw = borderWidthsOf(el);
  return { width: Math.max(0, r.width - bw.left - bw.right), height: Math.max(0, r.height - bw.top - bw.bottom) };
}
// A box with no CSSOM client box: none in the current layout (display:contents generates none), or a non-replaced
// inline — its clientLeft/clientTop/clientWidth/clientHeight are all 0 (Chrome). Asked once the layout is brought up to
// date.
function hasNoClientBox(el) {
  const b = el && el.nodeType === NODE_ELEMENT ? boxOf(el) : null;
  return !b || b.inlineBox;
}
// Is `el` a non-replaced inline box by its computed display alone — no replaced element, no widget (HTML lays a
// `display: inline` button out as an inline-block), no legend (a rendered one is a block whatever it declares)?
const ATOMIC_INLINE_TAGS = new globalThis.Set([
  'img', 'input', 'textarea', 'select', 'button', 'iframe', 'frame', 'embed', 'object', 'video', 'audio', 'canvas',
  'svg', 'meter', 'progress', 'fieldset', 'marquee', 'legend'
]);
function inlineByDisplay(el) {
  return !ATOMIC_INLINE_TAGS.has(el._tag) && engineValue(el, 'display') === 'inline';
}
// The CSSOM clientWidth/clientHeight of a box (0 when it has no client box; the border box for a table).
export function clientDims(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { width: 0, height: 0 };
  // (…a box-less element, and a non-replaced inline one — split for a block it holds or not — has no client box
  // whatever the layout makes of it, which its computed display says without laying the page out: a page reading a
  // span's `clientWidth` after every write would otherwise lay it out each time)
  if (!generatesBox(el) || inlineByDisplay(el)) return { width: 0, height: 0 };
  // (…and for any other, the CURRENT layout's box)
  ensureLayout();
  if (hasNoClientBox(el)) return { width: 0, height: 0 };
  return clientBoxOf(el);
}
// `clientLeft` / `clientTop`: the used TOP / LEFT border width, rounded to an integer — 0 for a non-rendered or
// box-less element (display:contents, a non-replaced inline). For a border-collapse table this is the outer-half
// collapsed border, which the pass laid the table out with (`edgesOf`). (A left scrollbar in RTL would add to
// `clientLeft`; not modeled — rare.)
// CSSOM View's offsets of `el` (geometry.rs `offsets`): `{ parent, left, top, width, height }` — the offsetParent, the
// position from its padding edge and the border-box size, in layout space — or none at all (null, 0s) for an element
// with no box.
const OFFSETS = new Float64Array(5);
const NO_OFFSETS = Object.freeze({ parent: null, left: 0, top: 0, width: 0, height: 0 });
export function offsetsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return NO_OFFSETS;
  ensureLayout();
  if (!offsetsIn(el, OFFSETS)) return NO_OFFSETS;
  const parent = OFFSETS[0] < 0 ? null : offsetParentNamed(el, OFFSETS[0]);
  return { parent, left: OFFSETS[1], top: OFFSETS[2], width: OFFSETS[3], height: OFFSETS[4] };
}
// …the offsetParent native named: one of `el`'s flat-tree ancestors.
function offsetParentNamed(el, nid) {
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) if (p._nid === nid) return p;
  return null;
}
export function clientBorderTopLeft(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return { top: 0, left: 0 };
  ensureLayout();
  if (hasNoClientBox(el)) return { top: 0, left: 0 };
  const bw = borderWidthsOf(el);
  return { top: Math.round(bw.top), left: Math.round(bw.left) };
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
  const f = clientRectsIn(el) || [], out = [];
  for (let k = 0; k + 3 < f.length; k += 4) out.push({ x: f[k], y: f[k + 1], width: f[k + 2], height: f[k + 3] });
  return out;
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
// …and where `usedInsetsOf` answers each: the declared sides `[top, right, bottom, left]` then the used ones (NaN for
// none).
const SIDE_INDEX = { __proto__: null, top: 0, right: 1, bottom: 2, left: 3 };
const INSETS = new Float64Array(8);

// Which physical side a flow-relative inset names for THIS element — the cascade already resolves
// the writing mode and direction into exactly this map, and asking it here is what keeps
// `insetInlineStart` and `left` from ever disagreeing about the same box.
function flowInsetSide(el, prop) {
  return flowSides(el)[prop.slice('inset-'.length)];
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
// the same terminator `isClipped` uses, and the same per-axis flags (`clipFlags`).
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
  else if (pos === 'bottom')   { sy = scrollEnd(scrollEl); }
  else if (pos === 'center')   { sy = scrollEnd(scrollEl) / 2; }
  return clampScroll(scrollEl, sx, sy);
}

// CSSOM View §12.4: `scrollIntoView` runs its alignment for EVERY ancestor scrolling box,
// innermost outwards — the document scroller is only the outermost of them. The chain is what
// makes a row inside a modal's `overflow: auto` body reachable at all: aligning only the document
// moved the PAGE under the modal and left the row exactly as clipped as before (Discourse's
// edit-categories modal pages in more rows only once its last row is fully visible to an
// IntersectionObserver). Capybara's `scroll_to(element, align:)` rides the same code — the real
// drivers it stands in for run literally `element.scrollIntoView(...)`. Planned natively
// (scroll_into_view.rs), applied here.
//
// Alignments per axis: start / center / end / nearest. The legacy boolean maps to
// `{block: 'start'}` (true / default) or `{block: 'end'}` (false), inline `nearest` either way.
const ALIGN = { __proto__: null, start: 0, center: 1, end: 2, nearest: 3 };
export function applyScrollIntoView(el, block = 'start', inline = 'nearest') {
  if (!el || el.nodeType !== NODE_ELEMENT) return;
  ensureLayout();
  applyScrollPlan(el, scrollIntoViewPlanOf(el, false, ALIGN[block] ?? 0, ALIGN[inline] ?? 3));
}

// The range a scroll box's offsets may take in each axis (geometry.rs `scroll_range`): from 0 to how far its region
// reaches past its scrollport — the viewport for the root, else its padding box — or to 0 from minus that where it
// scrolls from its far edge (CSSOM View §6: non-positive offsets there, so what lies behind the origin — the whole of a
// `vertical-rl` page wider than the viewport, an rtl box's overflow — is reached by scrolling negative). Browsers
// clamp to it — a scroll past the end lands AT the end — and pages read the same number back as `scrollHeight -
// clientHeight`. A box with no box has none, and scrolls nowhere.
const RANGE = new Float64Array(4);
function clampToRange(scrollEl, axis, value) {
  if (!scrollRangeOf(scrollEl, RANGE)) return 0;
  const k = axis === 'y' ? 2 : 0;
  return Math.min(Math.max(RANGE[k], value), RANGE[k + 1]);
}
function clampScroll(scrollEl, sx, sy) {
  return { el: scrollEl, x: clampToRange(scrollEl, 'x', sx), y: clampToRange(scrollEl, 'y', sy) };
}
// …and the far end of its block-axis range: where `scroll_to(:bottom)` goes.
function scrollEnd(scrollEl) {
  return scrollRangeOf(scrollEl, RANGE) ? RANGE[3] : 0;
}

// Bring `el` into view if it isn't — what every driver does before interacting with an element: Cuprite / Ferrum and
// Playwright scroll for a click through CDP's `DOM.scrollIntoViewIfNeeded` (Blink's `CenterIfNeeded`), which leaves a
// box that already shows alone, moves one merely clipped the least, and centres one entirely out of view (Avo's
// `tabs_spec` needs the 921 that centring gives — the least move left a lazy `<turbo-frame>` 24px below the fold).
// Only when needed: a gratuitous scroll would move the page out from under the rest of the test, and fire `scroll` at
// every ancestor an editor reacts to (it hung Avo's ACE-backed code field). Returns true if it scrolled.
export function ensureInView(el, align = 'center') {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  ensureLayout();
  return applyScrollPlan(el, scrollIntoViewPlanOf(el, true, 0, ALIGN[align] ?? 1));
}

// A plan's moves (`[scroller nid, x, y, …]`, innermost first) applied through the setters, which fire the scroll
// events — each scroller `el` or one of its flat-tree ancestors. Whether anything moved.
function applyScrollPlan(el, plan) {
  if (!plan || !plan.length) return false;
  const byNid = new globalThis.Map();
  for (let p = el; p; p = flatTreeParent(p)) byNid.set(p._nid, p);
  for (let k = 0; k < plan.length; k += 3) {
    const p = byNid.get(plan[k]);
    if (p) scrollBoxTo(p, plan[k + 1], plan[k + 2]);
  }
  return true;
}

// The used margin on one side: what the box's placer distributed, else what the cascade resolved.
// Stamped per side, so a box whose horizontal margins were distributed still reports its vertical
// ones from the cascade.
function usedMargin(el, side, resolved) {
  const b = boxOf(el), m = b && b.margins;
  return m && m[side] != null ? m[side] : resolved;
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
  return clampToRange(isRoot ? root : el, axis, value);
}

export function applyScrollBy(self, dx, dy) {
  const root = globalThis.document && globalThis.document.documentElement;
  const isRoot = !!self && (self._tag === 'html' || self._tag === 'body' || self === root);
  const scrollEl = isRoot ? root : self;
  if (!scrollEl) return null;
  ensureLayout();
  const to = clampScroll(scrollEl, scrollOffsetOf(scrollEl, 0) + (+dx || 0), scrollOffsetOf(scrollEl, 1) + (+dy || 0));
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
  // The insets of a POSITIONED box (geometry.rs `used_insets`: a DECLARED side as itself, resolved against the
  // containing block the placement used, an `auto` one from the box); `null`
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
    if (!usedInsetsOf(el, INSETS)) return null;
    const k = SIDE_INDEX[INSET_SIDES[prop] || flowInsetSide(el, prop)];
    if (INSETS[k] === INSETS[k]) return INSETS[k];
    return positionOf(el) === 'sticky' || INSETS[4 + k] !== INSETS[4 + k] ? null : INSETS[4 + k];
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

