// The layout's ENTRY, its WRITER and its READERS. The layout itself is the Rust walk (ext/csim_native/src/walk.rs, which
// builds a record per box from the arena and the style engine) laid out by ext/csim_native/src/layout.rs — what it
// models, and what it deliberately does not, is documented there. This module asks for a pass when a geometry read
// needs one (`ensureLayout` → `nativeLayoutPass` → `nlRustPass`); the pass keeps its boxes in the arena (geometry.rs),
// which every reader here asks (geometry.rs). A page the walk declines has the root's box alone (`layoutRootAlone`), counted
// by reason (`__csimNativeLayoutStats`).
//
// The page-visible geometry surface reads that layout through this module — `getBoundingClientRect` /
// `elementFromPoint` / `offset*` / `client*` / `scroll*`, the resolved CSSOM values that are used values, and the paint
// support (`recordingRuns`) — so the driver and the page's own JS never disagree about where anything is. The geometry
// itself is native (geometry.rs: the boxes, the scroll shift, the transform chain, the scrollable overflow region;
// hit_test.rs: the painting order and the hit test; rendered.rs: what box an element generates); what stays here is
// the shape the CSSOM surface hands it out in.
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
  maybeVerifyArena, scrollOffsetOf, scrollShiftOf, laidOutBoxOf, renderedBoxOf,
  layoutRootAloneIn, clippedAwayOf, hitTestIn, paintOrderIn, scrollSizeOf, clientBoxOf, frameViewportOf, clipFlagsOf, usedValueIn,
  renderedLegendOf, scrollIntoViewPlanOf, scrollRangeOf, clientRectsIn, paintTransformOf as paintTransformIn,
  paintQuadOf as paintQuadIn, offsetsIn, clipBoxesIn,
  arenaNid, REALM as NATIVE_REALM
} from './native-query-shadow.js';
import {
  isLaidOutNode, styleEngineNow, resolveLayoutProp, cascadeLayoutEpoch, settleLayoutInvalidation, flushStyleEngine,
  currentStructureGen, engineValue, styleEngineBoxKind, BOX_NONE, BOX_INLINE
} from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { natFontGen, teachFaces } from './font-metrics.js';
// Box props are read through `declaredValue` — the style engine's computed values, which getComputedStyle reads too:
// ONE geometry means one value resolution.
import { declaredValue, pseudoNodeFor, linkGeneratedBox, placeholderNodeFor, computedPositionOf } from './style-proxy.js';

// How many layout passes this realm has run (`__csimLayoutPasses`).
let layoutPass = 0;

function settleGen()     { return globalThis.__settleGenGet     ? globalThis.__settleGenGet()     : 0; }
// Whether the current layout gave `el` a box at all (geometry.rs `placed_box`).
export function hasLayoutBox(el) {
  return !!el && el._nid >= 0 && laidOutBoxOf(el, BOX);
}
// The mark for what a change restyled since the last one: how many elements the style engine's restyle replaced the
// style of (`__dom.styleRestyled`) — it decides what a class, a state or a sheet reaches. The early returns keyed on the
// dirty sequence read it.
function markRestyles() {
  const doc = globalThis.document;
  if (!globalThis.__dom || !doc || !doc.documentElement) return;
  flushStyleEngine();
  const restyled = globalThis.__dom.styleRestyled();
  if (restyled > 0) globalThis.__csimMarkRestyled(restyled);
}

// …answered for a reader in another realm holding a node of this one's arena, before it reads that node's geometry.
NATIVE_REALM.ensureLayout = ensureLayout;
function ensureLayout() {
  const doc = globalThis.document;
  if (!doc || !doc.documentElement) return;
  maybeVerifyArena();   // CSIM_ARENA_VERIFY: the arena mirrors the tree a pass is about to read
  // The restyle marks are made HERE, before the gate reads its keys; and the rule set is made known first, a changed
  // sheet being a restyle too (`settleLayoutInvalidation`).
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
  // to the paint. A painter reads style — `transform-origin` alone reaches `borderBoxSizeOf` — and a
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
// the box out (walk.rs `clip_flags`, the box's `clip`: `CLIP_*`): its overflow once the viewport has taken the root's,
// and the body's where the root has none of its own (CSS Overflow §3.3), and no inline box's, to which `overflow` does
// not apply. One answer, so the clip chain, the scrollable extents and the scroll shift (geometry.rs) can't disagree
// about the same box. The axes are kept apart because `clip` beside `visible` stays so — a child hanging off the SIDE
// of an `overflow-y: clip` box is visible and hit-testable in Chrome — and scrolling is not clipping: `clip` clips and
// forbids all scrolling, script included, so it is neither the scrollport a sticky box sticks within nor something
// `scrollIntoView` can scroll.
const CLIP_SCROLLS = 4;
export function scrollsContent(el) { return (clipFlagsOf(el) & CLIP_SCROLLS) !== 0; }

// The total scroll shift applied to `el`'s box, `{sx, sy}` (geometry.rs `scroll_shift`): the document's scroll and
// every scroll container's around it, compounding up, less what a sticky box among them has stuck — none for a fixed
// box.
const SHIFT = new Float64Array(2);
export function scrollShift(el) {
  scrollShiftOf(el, SHIFT);
  return { sx: SHIFT[0], sy: SHIFT[1] };
}


// A `display: contents` element generates NO BOX of its own — only its children's boxes are in the tree — so every
// page-visible geometry read has to say so itself, whatever box it still holds: Chrome reports a zero
// `getBoundingClientRect`, no client rects, `offsetWidth` / `offsetHeight` 0 and a null `offsetParent` for one. `<slot>`
// is `display: contents`, so this is every web component's slot. (Nor does a `display: none` one, which no layout gave
// a box.) Its own style says so, with nothing laid out (rendered.rs `box_kind`).
function generatesBox(el) {
  return styleEngineBoxKind(el) !== BOX_NONE;
}
globalThis.__csimGeneratesBox = (el) => el.nodeType === NODE_ELEMENT && generatesBox(el);

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
// The map the PAINTER draws under — a 2D affine, which is all a canvas has (geometry.rs `paint_transform`, its chain
// memoised there until anything it reads moves, since the run loop asks once per TEXT RUN). `false` (not null) says the
// element has a transform the painter cannot express at all, which a caller must not read as "no transform" and draw
// at the layout position.
const AFFINE = new Float64Array(6);
export function paintTransformOf(el) {
  const kind = paintTransformIn(el, AFFINE);
  return kind === 1 ? Array.from(AFFINE) : kind === 2 ? false : null;
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

// Parent-realm entry point (called from a CHILD realm): this frame's content box in THIS document's viewport coords,
// which is the child document's viewport (geometry.rs `frame_viewport`) — everything a page inside a frame resolves
// against, percentages, media queries, `innerWidth`, hangs off it.
const FRAME = new Float64Array(4);
export function frameContentBox(frameEl) {
  if (!frameEl || frameEl.nodeType !== NODE_ELEMENT) return null;
  ensureLayout();
  return frameViewportOf(frameEl, FRAME) ? { x: FRAME[0], y: FRAME[1], width: FRAME[2], height: FRAME[3] } : null;
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


// The laid-out border box's SIZE, `{width, height}` — what a percentage in a `transform` or a `transform-origin`
// resolves against — or null where the element has no box. Published for style-proxy and the animation engine, which
// can't import this module (layout.js imports them) — the same global seam `__isLaidOutNode` uses.
globalThis.__csimBorderBoxSize = (el) => borderBoxSizeOf(el);
function borderBoxSizeOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return null;
  ensureLayout();
  const b = renderedBoxUntransformed(el);
  return b ? { width: b.width, height: b.height } : null;
}

// CSSOM View's client box of `el` (geometry.rs `client_box`): `{left, top, width, height}` — `clientLeft` /
// `clientTop` / `clientWidth` / `clientHeight`, the padding box and the borders it lies inside, or a table's border
// box — all 0 for an element with none: one with no box, a box-less one, a non-replaced inline one. Those last two say
// so by their own style without anything laid out — a page reading a span's `clientWidth` after every write would
// otherwise lay it out each time.
const CLIENT = new Float64Array(4);
const NO_CLIENT_BOX = Object.freeze({ left: 0, top: 0, width: 0, height: 0 });
export function clientBox(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return NO_CLIENT_BOX;
  const kind = styleEngineBoxKind(el);
  if (kind === BOX_NONE || kind === BOX_INLINE) return NO_CLIENT_BOX;
  ensureLayout();
  if (!clientBoxOf(el, CLIENT)) return NO_CLIENT_BOX;
  return { left: CLIENT[0], top: CLIENT[1], width: CLIENT[2], height: CLIENT[3] };
}
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


// The element's border box as a viewport-relative `{x, y, width, height}` — Capybara's `Node#rect`, which backs the
// spatial selectors (`:above` / `:below` / `:left_of` / `:right_of` / `:near`) and coordinate drag — a zero rect for an
// element that is not laid out.
export function rectOf(el) {
  const ZERO = { x: 0, y: 0, width: 0, height: 0 };
  if (!el || el.nodeType !== NODE_ELEMENT || !(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return ZERO;
  ensureLayout();
  return renderedBox(el) || ZERO;
}

// The clip rectangles a PAINTER has to intersect before drawing `el`: every ancestor that clips,
// in viewport coordinates, opened out on whichever axis it does not clip (`overflow-y: clip` lets
// a child hang off the side). A fixed box escapes everything above it, so the walk stops there —
// the same terminator `isClipped` uses (geometry.rs `clip_boxes`).
// `self`: the element's OWN overflow clip as well, which is what clips its CONTENT (its text, its bitmap) and never its
// own box.
export function clipBoxesFor(el, self = false) {
  // (…no `ensureLayout()` of its own: the painter has already laid the page out — that is what produced the boxes it is
  // walking — and every extra call site on it is one more for V8 to weigh inlining into the per-element reads)
  const f = clipBoxesIn(el, self) || [], out = [];
  for (let k = 0; k + 9 < f.length; k += 10) {
    const m = [f[k + 4], f[k + 5], f[k + 6], f[k + 7], f[k + 8], f[k + 9]];
    const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
    out.push({ x: f[k], y: f[k + 1], width: f[k + 2], height: f[k + 3], m: identity ? null : m });
  }
  return out;
}

// The rect an IntersectionObserver measures against its root: the target's viewport-relative
// border box, or `null` when the target isn't rendered at all, or when an ancestor scroll container
// clips it away entirely — a clipped-away target intersects nothing, which is the whole point of
// observing one inside a scroller. Distinct from `rectOf`, which flattens both cases to a zero rect
// (Capybara's `Node#rect` has no null).
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
  // (…a STATIC box's inset is no used value, told before anything is laid out: on a page nothing has laid out yet,
  // reading `top` would otherwise lay the whole thing out to answer with the computed value it started from)
  if (INSET_PROPS.has(prop) && computedPositionOf(el) === 'static') return null;
  if (!isLaidOutNode(el)) return null;
  ensureLayout();
  return usedValueIn(el, prop);
};
const INSET_PROPS = new globalThis.Set(['top', 'right', 'bottom', 'left', 'inset-block-start', 'inset-block-end',
                                        'inset-inline-start', 'inset-inline-end']);

