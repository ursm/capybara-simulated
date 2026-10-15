// The layout's ENTRY, its WRITER and its READERS. The layout itself is the Rust walk (ext/csim_native/src/walk.rs, which
// builds a record per box from the arena and the style engine) laid out by ext/csim_native/src/layout.rs — what it
// models, and what it deliberately does not, is documented there. This module asks for a pass when a geometry read
// needs one (`ensureLayout` → `nativeLayoutPass` → `nlRustPass`); the pass keeps its boxes in the arena (geometry.rs),
// which every reader here asks (geometry.rs). A page the walk declines has the root's box alone (`layoutRootAlone`), counted
// by reason (`__csimNativeLayoutStats`).
//
// The page-visible geometry surface reads that layout through this module — `getBoundingClientRect` /
// `elementFromPoint` / `offset*` / `client*` / `scroll*`, the resolved CSSOM values that are used values, and the paint
// support (`recordingPass`) — so the driver and the page's own JS never disagree about where anything is. The geometry
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
import {
  maybeVerifyArena, scrollOffsetOf, laidOutBoxOf, renderedBoxOf,
  layoutRootAloneIn, clippedAwayOf, hitTestIn, scrollSizeOf, clientBoxOf, frameViewportOf,
  scrollIntoViewPlanOf, scrollRangeOf, clientRectsIn, offsetsIn, observedVisibleIn, observeIntersectionsIn, resizeObservationsIn,
  REALM as NATIVE_REALM
} from './native-query-shadow.js';
import {
  isLaidOutNode, styleEngineNow, cascadeLayoutEpoch, settleLayoutInvalidation, flushStyleEngine, feedStyleEngineSheets,
  styleEngineBoxKind, styleEngineScrollingElement, BOX_NONE, BOX_INLINE
} from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { natFontGen, teachFaces } from './font-metrics.js';
import { bodyOf, documentElementOf } from './document-tree.js';

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
  if (!globalThis.__dom || !doc || !documentElementOf(doc)) return;
  flushStyleEngine();
  const restyled = globalThis.__dom.styleRestyled();
  if (restyled > 0) globalThis.__csimMarkRestyled(restyled);
}

// …answered for a reader in another realm holding a node of this one's arena, before it reads that node's geometry.
NATIVE_REALM.ensureLayout = ensureLayout;
function ensureLayout() {
  const doc = globalThis.document;
  if (!doc || !documentElementOf(doc)) return;
  maybeVerifyArena();   // CSIM_ARENA_VERIFY: the arena mirrors the tree a pass is about to read
  // The restyle marks are made HERE, before the gate reads its keys; and the rule set is made known first, a changed
  // sheet being a restyle too (`settleLayoutInvalidation`).
  settleLayoutInvalidation();
  markRestyles();
  // …and so do the marks for what the streaming parser inserted since the last pass (`noteParsedChange`). (A `dir=auto`
  // scope a mutation turned around is the style engine's restyle: its `direction` changed.)
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
  const root = documentElementOf(doc);
  if (root._ns === HTML_NS && nativeLayoutPass(root)) return;
  layoutRootAlone(doc);
}

// A document the Rust walk lays nothing out for still has a ROOT box: as wide as the viewport (or its declared width), its
// declared height else none, and an extent the viewport tall (Chrome: an SVG document hit-tests its root). Nothing else
// is laid out — and none of the boxes an earlier pass placed under it stays, which nothing here replaces.
function layoutRootAlone(doc) {
  const root = documentElementOf(doc);
  if (!root) return;
  layoutRootAloneIn(root, doc._layoutVP);
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
  return true;
}
// The pass the RUST walk builds (`__dom.layoutBuild`): its records built in native from the arena and the style engine's
// own values, and laid out there (layout.rs), its boxes kept in the arena — and a pass a painter records keeping where
// its text pieces landed (paint.rs `Painted`) — or answered with the faces it needs first, or its decline, by name.
function nlRustPass(root) {
  const d = globalThis.__dom;
  if (!d || typeof d.layoutBuild !== 'function' || root._nid == null) return { ok: false, reason: 'rust: no __dom' };
  // (…a pass that records its text pieces for the text geometry (text_geometry.rs) — and a paint's each piece as the
  // painter draws it besides: its text and the element it was written in beside where it sits)
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
    if (answer === true) break;
    if (round === 3) return { ok: false, reason: 'rust: faces unresolved' };
    if (!Array.isArray(answer)) return { ok: false, reason: 'rust: unexpected answer' };
    teachFaces(d, answer);
    flushStyleEngine();   // (…a face a font metric was computed without restyles the realm: `walk_face`)
  }
  return { ok: true };
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
let cssImgGen = null;
function fetchCssImage(url, type) {
  let abs = url;
  try { abs = new globalThis.URL(url, (globalThis.document && globalThis.document.baseURI) || undefined).href; } catch (_) {}
  if (CSS_IMG_SEEN.has(abs)) return;
  CSS_IMG_SEEN.add(abs);
  const started = globalThis.__csimPerformanceNow();
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
// The rendering-update pass: called from the event loop after `flushAnimationFrame`.
export function flushCssImages() {
  const doc = globalThis.document;
  if (!doc || !documentElementOf(doc)) return;
  const body = bodyOf(doc);
  const bodyBg = body && body._attrs && body._attrs.background;
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
  // (…the images the rendered tree uses, a `<body background>` among them — rendered.rs `css_image_urls`)
  const urls = globalThis.__dom.cssImageUrls(documentElementOf(doc)._nid, styleEngineNow()) || [];
  for (let k = 0; k + 1 < urls.length; k += 2) fetchCssImage(urls[k + 1], urls[k]);
}
globalThis.__csimFlushCssResources = flushCssImages;

// ── Frame (nested browsing context) geometry ─────────────────────────────────────────────────
// A frame document lays itself out in ITS OWN realm — own stylesheets, own generation — so
// geometry across a frame boundary can't be composed by walking one tree. It is composed by
// ASKING the parent realm: its `__csimFrameObscuredAt` global runs with
// the parent's own layout state and hands back plain data. (`__csim*` names bypass the cross-origin
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
    const par = globalThis.__csimParent;
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
  // global costs nothing and can't re-enter. The parent re-pushes it from its resize steps
  // (`__csimResizeSteps`) whenever the container's size moved — a `resize_to`, or a page script.
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
  // (…a viewport that moved is a rendering change both kinds of observation may see)
  if (typeof globalThis.__csimScheduleObservations === 'function') globalThis.__csimScheduleObservations();
}

// The viewport of the CURRENT layout pass. Cached with the layout itself, so a container resize
// that doesn't touch this document's own generation is picked up on its next relayout (coarse).
function viewport() {
  const doc = globalThis.document;
  return (doc && doc._layoutVP) || computeViewport();
}

// ── Paint recording ──────────────────────────────────────────────────────────────────────────
// Where each text piece LANDED, which a layout pass otherwise throws away: what the text geometry is read off (a caret
// from a point, a range's rects — text_geometry.rs), and what a painter draws — it cannot re-derive the line breaking
// without repeating the whole pass. A pass records them (`nlRustPass`'s `painting`) only when one is asked for
// (`recordingPass`): 0 none, `RECORD_GEOMETRY` the geometry's, `RECORD_PAINT` the painter's besides.
const RECORD_GEOMETRY = 1, RECORD_PAINT = 2;
let PAINTING = 0;
// A layout pass that records — forced, as the gate in `ensureLayout` would answer a settled page with the memoised layout
// — but with nothing dirtied: the walk splices back what did not change, the marks of its text runs included, and the
// layout puts back measures that hold its pieces (walk.rs `splice`, layout.rs `Measured::texts`), so what a pass that
// records does again is what changed since the last that did. The painter's (`RECORD_PAINT`) keeps where its pieces
// landed for the display list (paint.rs `Painted`).
export function recordingPass(mode = RECORD_PAINT) {
  const prev = PAINTING;
  PAINTING = mode;
  const doc = globalThis.document;
  if (doc) doc._layoutGen = undefined;
  try {
    // …through the public geometry entry rather than `ensureLayout` directly: a geometry read lays the page out, and this
    // one is not on any hot path.
    rectOf(doc && documentElementOf(doc));
  } finally {
    PAINTING = prev;
  }
}
// Total layout passes since the VM booted — the perf gate's primary count metric
// (`spec/support/perf_gate.rb`). One full pass fires per read-after-mutation; a
// regression that adds passes moves this deterministically,
// independent of machine / Ruby version / JS engine.
globalThis.__csimLayoutPasses = () => layoutPass;






// A `display: contents` element generates NO BOX of its own — only its children's boxes are in the tree — so every
// page-visible geometry read has to say so itself, whatever box it still holds: Chrome reports a zero
// `getBoundingClientRect`, no client rects, `offsetWidth` / `offsetHeight` 0 and a null `offsetParent` for one. `<slot>`
// is `display: contents`, so this is every web component's slot. (Nor does a `display: none` one, which no layout gave
// a box.) Its own style says so, with nothing laid out (rendered.rs `box_kind`).
function generatesBox(el) {
  return styleEngineBoxKind(el) !== BOX_NONE;
}
globalThis.__csimGeneratesBox = (el) => el._nodeType === NODE_ELEMENT && generatesBox(el);

// `el`'s border box as the page MEASURES it (geometry.rs `rendered_box`): in VIEWPORT coordinates, where the scrolls
// above it carried it and under every transform on the way — `null` when it generates none. A transform does not move
// a box in flow, but it moves what `getBoundingClientRect`, `getClientRects` and a hit test see. A box in no arena —
// an ANONYMOUS one — is carried as a box its container holds.
const BOX = new Float64Array(4);
function renderedBox(el) {
  return renderedBoxOf(el, BOX) ? { x: BOX[0], y: BOX[1], width: BOX[2], height: BOX[3] } : null;
}
// …and the same box UNTRANSFORMED: where the page's scrolling carried it (geometry.rs `laid_out_box`), in viewport
// coordinates — what a percentage in a `transform` resolves against.
function renderedBoxUntransformed(el) {
  return generatesBox(el) && laidOutBoxOf(el, BOX) ? { x: BOX[0], y: BOX[1], width: BOX[2], height: BOX[3] } : null;
}


// `el` is clipped away when its rendered box lies wholly outside the padding box of a box that clips it — one in its
// containing-block chain, so an out-of-flow box escapes the clips between it and the box it was placed against — in an
// axis that box clips (hit_test.rs `clipped_away`).
function isClipped(el) {
  return clippedAwayOf(el);
}

// Is `a` an ancestor of `b` in the flat tree (the engine's walk)? …and `a` itself or one.
const isFlatInclusiveAncestor = (a, b) => a._nid != null && b._nid != null && globalThis.__dom.flatInclusiveAncestor(a._nid, b._nid);
export const isFlatAncestor = (a, b) => a !== b && isFlatInclusiveAncestor(a, b);


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

// The caret position at the viewport point (text_geometry.rs `caret_from_point`): [node, offset] — in the element a hit
// there lands on — or null where it lands on none…
// (…in `within` wherever the point is, where given: a line a scroller clipped is no hit)
export function caretFromPoint(vx, vy, within) {
  ensureTextGeometry();
  const at = globalThis.__dom.caretFromPoint(vx, vy, styleEngineNow(), within ? within._nid : undefined);
  return at ? [at[0][0], at[1]] : null;
}
// …the caret's rect at (`node`, `offset`) in the viewport, [x, y, width, height] (`caret_rect`) — at the end of the line
// a wrap ends there, with `upstream`; `boxed`, where the text has none, the box there, zero wide — or null…
export function caretRectOf(node, offset, upstream = false, boxed = false) {
  if (node._nid == null) return null;
  ensureTextGeometry();
  const r = globalThis.__dom.caretRect(node._nid, offset, upstream, boxed);
  return r ? [r[0], r[1], r[2], r[3]] : null;
}
// …and a range's client rects, each [x, y, width, height] in the viewport (ranges.rs `range_rects`).
export function rangeRectsOf(range) {
  ensureTextGeometry();
  const flat = globalThis.__dom.rangeRects(range) ?? [];
  const out = [];
  for (let i = 0; i < flat.length; i += 4) out.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]);
  return out;
}
// Each is read off the text the last recording pass placed (`recordingPass`): a layout the page has moved since is laid
// out recording — one pass, not a pass and then another to record — and one made without recording is followed by one
// that does.
function ensureTextGeometry() {
  const prev = PAINTING;
  PAINTING = Math.max(prev, RECORD_GEOMETRY);
  try {
    ensureLayout();
  } finally {
    PAINTING = prev;
  }
  if (!globalThis.__dom.textCurrent()) recordingPass(RECORD_GEOMETRY);
}

// Where the last line-wise move left the caret — the x a vertical move set out from, and whether a place a wrap ends one
// line and starts the next is the end of the first — is the engine's (text_geometry.rs `CaretMove`): a move is
// { node, offset, x, upstream }, which its caller keeps once it has set the selection to it (`rememberCaretMove`)…
export function rememberCaretMove(move) {
  globalThis.__dom.caretMoveKeep(move.node._nid, move.offset, move.x, move.upstream);
}
// …and which anything else that sets the selection ends — another key, a press, a script's (Chrome).
export function forgetCaretMove() {
  if (globalThis.__dom) globalThis.__dom.caretMoveForget();
}

// ArrowUp / ArrowDown: the caret a line up or down in `root` — a contenteditable's editing host, or a textarea, whose
// value it moves in — at the x the moves set out from, past the first line at the start and past the last at the end
// (`edge`): the engine's (`caretLineOver`).
export function caretALineOver(root, node, offset, up, edge) {
  if (root._nid == null || node._nid == null) return null;
  ensureTextGeometry();
  const at = globalThis.__dom.caretLineOver(root._nid, node._nid, offset, up, edge ? edge[0]._nid : undefined, edge ? edge[1] : 0);
  return at && { node: at[0][0], offset: at[1], x: at[2], upstream: false };
}
// Home / End: the first or last place of the line the caret at (`node`, `offset`) is on in `root` (`caretLineEdge`).
export function caretAtLineEdge(root, node, offset, end) {
  if (root._nid == null || node._nid == null) return null;
  ensureTextGeometry();
  const at = globalThis.__dom.caretLineEdge(root._nid, node._nid, offset, end);
  return at && { node: at[0][0], offset: at[1], x: undefined, upstream: at[2] };
}

// `Selection.modify()`'s motion from (`node`, `offset`) by `granularity` in `direction` — the engine's (text_geometry.rs
// `modify_target`): `[forward]` where it moves nowhere, `[forward, [node], offset, x, upstream]` where it moves, and
// undefined for a direction or a granularity it does not know.
export function selectionModifyTarget(node, offset, direction, granularity) {
  if (node._nid == null) return undefined;
  ensureTextGeometry();
  feedStyleEngineSheets();
  return globalThis.__dom.selectionModifyTarget(node._nid, offset, String(direction), String(granularity), styleEngineNow());
}

// CSSOM/Selenium click-point occlusion: an element is obscured when a click at its box centre
// would NOT land on it (or a descendant). Non-visible elements are obscured.
export function isObscured(el) {
  if (!el || el._nodeType !== NODE_ELEMENT) return true;
  if (!(globalThis.__isVisibleNode && globalThis.__isVisibleNode(el))) return true;
  ensureLayout();
  if (!hasLayoutBox(el)) return true;
  if (isClipped(el)) return true;                                // clipped away by a scroll container
  const b = renderedBox(el);                                     // viewport-space box (scroll subtracted)
  return obscuredAtPoint(el, b.x + b.width / 2, b.y + b.height / 2);
}

// Whether an IntersectionObserver tracking visibility sees each of `els` visible — untransformed but for a translation
// or an upscaling, opaque, unfiltered and covered by nothing (hit_test.rs `Painting::visible`) — as a Map.
export function observedVisibility(els) {
  if (els.length === 0) return new Map();
  ensureLayout();
  return observedVisibleIn(els, styleEngineNow());
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
  if (!isFlatInclusiveAncestor(el, hit)) return true;
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
  if (!frameEl || frameEl._nodeType !== NODE_ELEMENT) return null;
  ensureLayout();
  return frameViewportOf(frameEl, FRAME) ? { x: FRAME[0], y: FRAME[1], width: FRAME[2], height: FRAME[3] } : null;
}

// Parent-realm entry point (called from a CHILD realm): the child hit-tested (`x`, `y`) in its own
// viewport coords and landed on its element; that point maps to `frame`'s content box here, so the
// frame itself must be clickable there — recursing out through any further containers.
export function frameObscuredAt(frameEl, x, y) {
  if (!frameEl || frameEl._nodeType !== NODE_ELEMENT) return true;
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
// observations, rectOf) force their own pass, so dropping this one changes no observable geometry.
export function viewportSize() {
  return viewport();
}

// The scrollable overflow region of `el` as a width/height (geometry.rs `scroll_size`): the distance from the edge it
// SCROLLS FROM to the far end of what is reachable from there. That is what scrollWidth / scrollHeight report — at
// least the client box, larger when content overflows it, and nothing at all for content that overflows BEHIND the
// scroll origin — and 0 x 0 for an element with no box, or a non-replaced inline one (Chrome's `<span>`).
const SIZE = new Float64Array(2);
export function contentExtent(el) {
  if (!el || el._nodeType !== NODE_ELEMENT) return { width: 0, height: 0 };
  ensureLayout();
  return scrollSizeOf(el, SIZE) ? { width: SIZE[0], height: SIZE[1] } : { width: 0, height: 0 };
}


// The laid-out border box's SIZE, `{width, height}` — what a percentage in a `transform` or a `transform-origin`
// resolves against — or null where the element has no box. Published for style-proxy and the animation engine, which
// can't import this module (layout.js imports them) — the same global seam `__isLaidOutNode` uses.
globalThis.__csimBorderBoxSize = (el) => borderBoxSizeOf(el);
function borderBoxSizeOf(el) {
  if (!el || el._nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return null;
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
  if (!el || el._nodeType !== NODE_ELEMENT) return NO_CLIENT_BOX;
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
  if (!el || el._nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return NO_OFFSETS;
  ensureLayout();
  if (!offsetsIn(el, OFFSETS)) return NO_OFFSETS;
  const parent = OFFSETS[0] < 0 ? null : globalThis.__dom.nodeOf(OFFSETS[0]);
  return { parent, left: OFFSETS[1], top: OFFSETS[2], width: OFFSETS[3], height: OFFSETS[4] };
}
// The element's rendered pieces, viewport-relative: one rect per line a fragmented inline
// broke over, and its single box otherwise. `getClientRects` reports exactly this — every
// RENDERED element has at least one box, even a zero-sized one (an empty `<span>` alone in a
// block is `[0, 0, 0, 0]` in Chrome, and one rect, not none), and one that isn't rendered has
// none at all.
export function clientRectsOf(el) {
  if (!el || el._nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return [];
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
  if (!el || el._nodeType !== NODE_ELEMENT || !(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return ZERO;
  ensureLayout();
  return renderedBox(el) || ZERO;
}


// A ResizeObserver's observations of `targets` at `ratio` device pixels (resize_observation.rs), each document's in its
// own realm's layout: a Float64Array, eleven numbers a target — its border, content and device-pixel content sizes
// (`[inline, block]` each), its content rect (`[x, y, w, h]`), all 0 where it is not laid out, and its depth.
export function resizeObservations(targets, ratio) {
  ensureLayout();
  const out = new Float64Array(targets.length * 11);
  const byDocument = new Map();
  for (let i = 0; i < targets.length; i++) {
    if (targets[i]._nid == null) continue;
    const doc = targets[i].ownerDocument;
    let group = byDocument.get(doc);
    if (!group) byDocument.set(doc, group = []);
    group.push(i);
  }
  for (const group of byDocument.values()) {
    const args = group.flatMap((i) => [targets[i]._nid, isLaidOutNode(targets[i])]);
    const g = resizeObservationsIn(targets[group[0]], ratio, args);
    if (g) for (let j = 0; j < group.length; j++) out.set(g.subarray(j * 11, j * 11 + 11), group[j] * 11);
  }
  return out;
}
// An IntersectionObserver's observations of `targets` against `root` (an element, a document — its viewport — or null:
// this realm's viewport) grown by `margin` (as `__dom.parseMargin` gives it), its `thresholds` ascending —
// intersection.rs, each document's targets in its own realm's layout: a Float64Array, the root rectangle then ten
// numbers a target (`observeIntersections`). A target in another document than its root's is not observed (§3.2.8: no
// box, no intersection).
export function observeIntersections(root, margin, thresholds, targets) {
  ensureLayout();
  const out = new Float64Array(4 + targets.length * 10).fill(NaN);
  const rootEl = root && root._nodeType === NODE_ELEMENT ? root : null;
  const rootDoc = rootEl ? rootEl.ownerDocument : root;
  const rootNid = rootEl && rootEl._nid != null ? rootEl._nid : -1;
  const rootRect = root ? observeIntersectionsIn(root, rootNid, margin, thresholds, [])
    : globalThis.__dom.observeIntersections(-1, margin, thresholds);
  if (rootRect) out.set(rootRect.subarray(0, 4));
  const byDocument = new Map();
  for (let i = 0; i < targets.length; i++) {
    const k = 4 + i * 10;
    out[k + 8] = 0;
    out[k + 9] = 0;
    const doc = targets[i].ownerDocument;
    if (targets[i]._nid == null || (rootDoc && doc !== rootDoc)) continue;
    let group = byDocument.get(doc);
    if (!group) byDocument.set(doc, group = []);
    group.push(i);
  }
  for (const group of byDocument.values()) {
    const g = observeIntersectionsIn(targets[group[0]], rootNid, margin, thresholds, group.map((i) => targets[i]._nid));
    if (g) for (let j = 0; j < group.length; j++) out.set(g.subarray(4 + j * 10, 14 + j * 10), 4 + group[j] * 10);
  }
  return out;
}

// The box a scroll of `self` moves: the DOCUMENT's — the documentElement offset, which rectOf/isObscured subtract — for
// the root element and for the scrolling element (the BODY in quirks mode); `self` for any other element, the body in
// standards mode among them: Capybara's page-level scroll aims at `<html>` there, and a real driver's `body.scrollTo()`
// moves the body alone (`html { overflow: hidden }` makes it a scroller in its own right, and Chrome scrolls it).
function scrollerOf(self) {
  const doc = globalThis.document;
  const root = doc && documentElementOf(doc);
  return self && (self === root || self._tag === 'html' || (doc && styleEngineScrollingElement(doc) === self)) ? root : self;
}

// Where a scroll request lands, WITHOUT applying it: `{el, x, y}`, or null when there's nothing to
// scroll. `self` is the element the request was made on (`scrollerOf`). Modes: explicit `[x, y]`, or a position
// keyword. A scroll aimed at a TARGET element is the other algorithm — `applyScrollIntoView` below, which walks the
// whole scroller chain.
export function scrollTargetFor(self, pos, x, y) {
  const scrollEl = scrollerOf(self);
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
  if (!el || el._nodeType !== NODE_ELEMENT) return;
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
  if (!el || el._nodeType !== NODE_ELEMENT) return false;
  ensureLayout();
  return applyScrollPlan(el, scrollIntoViewPlanOf(el, true, 0, ALIGN[align] ?? 1));
}

// A plan's moves (`[scroller nid, x, y, …]`, innermost first) applied through the setters, which fire the scroll
// events — each scroller `el` or one of its flat-tree ancestors. Whether anything moved.
function applyScrollPlan(el, plan) {
  if (!plan || !plan.length) return false;
  for (let k = 0; k < plan.length; k += 3) {
    const p = globalThis.__dom.nodeOf(plan[k]);
    if (p) scrollBoxTo(p, plan[k + 1], plan[k + 2]);
  }
  return true;
}


// Clamp a scroll offset to `el`'s scrollable range on one axis — the setter's
// version of what scrollTargetFor's clampScroll does for the driver paths.
export function clampScrollOffset(el, axis, value) {
  if (!el || el._nodeType !== NODE_ELEMENT) return Math.max(0, value);
  ensureLayout();
  return clampToRange(scrollerOf(el), axis, value);
}

// Scroll `self` BY a delta from where it is now (Capybara's `scroll_to(:current, offset: [x, y])`).
export function applyScrollBy(self, dx, dy) {
  const scrollEl = scrollerOf(self);
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
  const target = doc && el === documentElementOf(doc) ? (doc.scrollingElement || el) : el;
  target.scrollLeft = x;
  target.scrollTop  = y;
}

