// A COARSE box-layout model — enough for occlusion / hit-testing (`obscured?`), NOT a real layout
// engine. It computes an approximate border-box `{x, y, width, height}` (document coordinates) for
// each rendered element via block flow + absolute/fixed positioning with EXPLICIT sizes, plus a
// z-order hit-test. Deliberate coarse choices (documented per box): no text-metrics (auto width →
// containing-block width; a text-bearing block gets a coarse line-height so it has a hittable box),
// no inline flow / float / flex / grid track sizing, whole-box (never partial) overflow clipping,
// no per-side margin/padding/border in flow advancement, and a FLAT paint order (no nested
// stacking-context tree). This is sufficient for explicitly-sized fixtures (Capybara's
// `obscured.erb`) and for the no-false-overlap property of block flow on real pages; richer layout
// is a later increment.
//
// Frames compose ACROSS REALMS rather than across one tree: a frame document lays itself out in its
// own realm, against its container's content box as the viewport, and occlusion walks OUT one frame
// at a time (see "Frame (nested browsing context) geometry" below).
//
// Cost: pay-per-use. The whole tree is laid out once per (settleGen, cascadeVersion) generation —
// the same dual key the innerText memo uses (inline/attr edits bump settleGen; stylesheet/CSSOM
// edits bump cascadeVersion) — and only when a hit-test actually runs, so it never touches the hot
// path (rule 3).

import { NODE_ELEMENT }                                  from './constants.js';
import { walkInclShadow }                                from './walk.js';
import { isLaidOutNode, selfNotRendered, cascadedProperty, resolveLayoutProp, resolveCascadeDisplay } from './cascade.js';

const VIEWPORT_W  = 1024;   // mirrors platform-globals VIEWPORT_W/H (window.innerWidth/Height)
const VIEWPORT_H  = 768;
const BODY_MARGIN = 8;      // UA default body margin (coarse; not cascade-modelled)
const LINE_HEIGHT = 19;     // coarse ~1 line at the 16px default font (no glyph metrics)

function settleGen()     { return globalThis.__settleGenGet     ? globalThis.__settleGenGet()     : 0; }
function cascadeVersion() { return globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0; }

// Lay out the whole document once per (settleGen, cascadeVersion). Boxes are stamped on `_lb`
// (border-box, document coords) and a monotonic `_lbOrder` (paint tie-break = tree order).
function ensureLayout() {
  const doc = globalThis.document;
  const body = doc && doc.body;
  if (!body) return;
  const gen = settleGen(), cv = cascadeVersion();
  if (doc._layoutGen === gen && doc._layoutCV === cv) return;
  doc._layoutGen = gen; doc._layoutCV = cv;
  // The viewport this document lays out against — the top-level one, or our container frame's
  // content box. Resolved once per layout pass (it needs a cross-realm call; see viewport()).
  doc._layoutVP = computeViewport();
  const vp = doc._layoutVP;
  const ctx = { order: 0 };
  // <body>'s content origin is its own margin — the UA's 8px unless the page says otherwise, which
  // plenty of pages do (`body { margin: 0 }` moves everything to the viewport origin). Its
  // containing block for absolute descendants is the initial containing block (the viewport),
  // resolved lazily in containingBlockFor.
  const ml = marginOf(body, 'margin-left'), mr = marginOf(body, 'margin-right'), mt = marginOf(body, 'margin-top');
  layoutElement(body, { x: ml, y: mt, width: Math.max(0, vp.width - ml - mr), height: 0 }, ctx);
  // The root element gets a box too: apps read `documentElement.getBoundingClientRect()` for scroll
  // math. Its height is what the document actually consumed (which can exceed the viewport — that's
  // the point); `clientHeight`'s viewport-sized answer is a separate CSSOM rule, see viewportSize().
  // Ordered BELOW everything so it never wins a hit-test tie against real content.
  const root = doc.documentElement;
  if (root) {
    const bb = body._lb;
    root._lb = { x: 0, y: 0, width: vp.width, height: bb ? bb.y + bb.height + BODY_MARGIN : vp.height };
    root._lbOrder = -1;
    // The root is boxed here rather than through layoutElement, so stamp its content extent too —
    // `document.documentElement.scrollHeight` is how a page asks "how tall is the document", and
    // without this it reads 0.
    stampExtent(root, root._lb);
  }
}

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
  const fe = globalThis.frameElement;
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
  // global costs nothing and can't re-enter. Coarse: the size is captured at build time, so a frame
  // resized afterwards keeps its original viewport.
  const pushed = globalThis.__csimFrameViewport;
  if (pushed) return { width: pushed.width, height: pushed.height };
  // In a frame whose parent pushed nothing (an unrendered container — display:none, detached), the
  // viewport is EMPTY: nothing inside a non-rendered frame is clickable, and falling back to the
  // top-level size would report its content as in-view.
  if (globalThis.frameElement) return { width: 0, height: 0 };
  return { width: VIEWPORT_W, height: VIEWPORT_H };
}

// The viewport of the CURRENT layout pass. Cached with the layout itself, so a container resize
// that doesn't touch this document's own generation is picked up on its next relayout (coarse).
function viewport() {
  const doc = globalThis.document;
  return (doc && doc._layoutVP) || { width: VIEWPORT_W, height: VIEWPORT_H };
}

// ── Flat tree ────────────────────────────────────────────────────────────────────────────────
// What gets laid out is the FLAT tree, not the node tree: a shadow host renders its shadow tree
// (its light children appear only through the `<slot>` they're assigned to), and a slot renders its
// assigned nodes — or its own children as fallback when nothing is assigned. Read through the
// node's own `assignedNodes()` / `assignedSlot`, so the assignment rules stay in one place
// (dom-nodes.js) instead of being re-derived here.
function layoutChildren(el) {
  const sr = el._shadowRoot;
  if (sr) return sr._children || [];
  if (el._tag === 'slot' && typeof el.assignedNodes === 'function') {
    const assigned = el.assignedNodes();
    if (assigned && assigned.length) return assigned;   // else the slot's own children = fallback
  }
  return el._children || [];
}

// The flat-tree parent — the element whose box actually contains `el`'s: a slotted node's is the
// SLOT it's assigned to, and a shadow-tree top-level element's is the HOST (the shadow root itself
// is a fragment, not a box, so a plain `_parent` walk would stop dead at the boundary).
function layoutParent(el) {
  const slot = el.assignedSlot;
  if (slot) return slot;
  const p = el._parent;
  if (p && p._isShadowRoot) return p._parent;
  return p && p.nodeType === NODE_ELEMENT ? p : null;
}

// The nearest positioned ancestor's box is an absolute box's containing block; with none, it's the
// initial containing block (the viewport). (Coarse: padding box == border box here.)
function containingBlockFor(el) {
  for (let p = layoutParent(el); p; p = layoutParent(p)) {
    const pos = positionOf(p);
    if (pos !== 'static' && p._lb) return p._lb;
  }
  const vp = viewport();
  return { x: 0, y: 0, width: vp.width, height: vp.height };
}

// Elements whose size comes from the element itself rather than from its content. Replaced elements
// with no intrinsic size get the CSS "default object size" (300×150) — an `<iframe>` with no
// width/height is 300×150 in every browser — and form controls get their UA intrinsic size (these
// are Chrome's, measured). Without the control sizes a text input measures 0 tall, since it has no
// text children, and so does any row built around one: a page that divides by a row's height takes
// the wrong branch (Discourse's sidebar reorder decides insert-above from
// `event.offsetY < rect.height / 2`).
//
// The width/height CONTENT attributes are presentational hints and arrive through
// `resolveLayoutProp`, so this is only the no-declaration default. (`<img>` is deliberately absent:
// its intrinsic size is the decoded image's, which we don't have.)
const OBJECT_SIZE   = { width: 300, height: 150 };
const REPLACED_TAGS = new Set(['iframe', 'frame', 'embed', 'object', 'video']);
const CONTROL_SIZES = {
  input:    { width: 185, height: 21 },
  button:   { width: 25,  height: 21 },
  select:   { width: 30,  height: 19 },
  textarea: { width: 201, height: 42 }
};
const CHECKBOX_SIZE = { width: 13, height: 13 };

function intrinsicSize(el) {
  const t = el._tag;
  if (REPLACED_TAGS.has(t)) return OBJECT_SIZE;
  if (t === 'input') {
    const type = ((el._attrs && el._attrs.type) || '').toLowerCase();
    return (type === 'checkbox' || type === 'radio') ? CHECKBOX_SIZE : CONTROL_SIZES.input;
  }
  return CONTROL_SIZES[t] || null;
}

// The used border-box size of `el`: its declared width/height, else its intrinsic size, else the
// caller's auto fallback. `autoHeight` reports that the height really is auto, so the caller can
// back-fill it from content (an explicit `height: 0` stays 0).
function usedSize(el, autoW, autoH) {
  const w = resolveLayoutProp(el, 'width');
  const h = resolveLayoutProp(el, 'height');
  const intrinsic = intrinsicSize(el);
  return {
    width:      w != null ? w : (intrinsic ? intrinsic.width  : autoW),
    height:     h != null ? h : (intrinsic ? intrinsic.height : autoH),
    autoHeight: h == null && !intrinsic
  };
}

function positionOf(el) {
  const p = cascadedProperty(el, 'position');
  return p ? String(p).trim().toLowerCase() : 'static';
}

// A declared margin in px, else the UA default (only <body> asks, and 8px is its UA margin).
function marginOf(el, prop) {
  const m = resolveLayoutProp(el, prop);
  return m != null ? m : BODY_MARGIN;
}

// `position: relative` shifts a box from its flow position by top/left WITHOUT changing the flow —
// following siblings stack as if it hadn't moved. (Only top/left; bottom/right would need the
// containing block's edges, which the coarse model doesn't track for in-flow boxes.)
function relativeOffset(el) {
  const top = resolveLayoutProp(el, 'top');
  const left = resolveLayoutProp(el, 'left');
  return { x: left != null ? left : 0, y: top != null ? top : 0 };
}
function displayOf(el) { return resolveCascadeDisplay(el); }   // cascaded display keyword or null

// Place an out-of-flow (absolute/fixed) child against its containing block; `staticY` is the flow
// position an `auto` top falls back to. Does NOT advance the parent's flow.
function placeAbsolute(child, pos, staticY, ctx) {
  const vp   = viewport();
  const cb   = pos === 'fixed' ? { x: 0, y: 0, width: vp.width, height: vp.height } : containingBlockFor(child);
  const top  = resolveLayoutProp(child, 'top');
  const left = resolveLayoutProp(child, 'left');
  // auto inset → the box's static position (coarse: containing-block origin x / current flow y).
  const cx = left != null ? cb.x + left : cb.x;
  const cy = top  != null ? cb.y + top  : staticY;
  const size = usedSize(child, cb.width, 0);
  layoutElement(child, { x: cx, y: cy, width: size.width, height: size.height }, ctx);
}

// Lay out `el` (already boxed as `box`) and its children — grid containers via a coarse grid pass,
// otherwise block flow: in-flow blocks stack vertically from the content top; out-of-flow
// (absolute/fixed) boxes are positioned against their containing block and do NOT advance the flow.
// Auto height back-fills from the consumed flow.
function layoutElement(el, box, ctx) {
  el._lb = box;
  el._lbOrder = ctx.order++;
  if (displayOf(el) === 'grid') { layoutGrid(el, box, ctx); return; }
  let flowY = box.y;
  let hadInFlow = false;
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, flowY, ctx); continue; }
    // In-flow block: fills the containing width unless explicitly sized; stacks below its
    // predecessors (coarse: margins ignored). A text-bearing block with no explicit height gets a
    // coarse line-height so it still has a hittable box (no glyph metrics — line count only).
    const size = usedSize(child, box.width, 0);
    const rel  = pos === 'relative' ? relativeOffset(child) : null;
    layoutElement(child, { x: box.x + (rel ? rel.x : 0), y: flowY + (rel ? rel.y : 0), width: size.width, height: size.height }, ctx);
    if (size.autoHeight && child._lb.height === 0) child._lb.height = textHeight(child, child._lb.width);
    flowY += child._lb.height;      // the flow advances by the box's height, not its shifted position
    hadInFlow = true;
  }
  // Auto height (a block with no explicit height) = the flow its in-flow children consumed.
  if (box.height === 0 && hadInFlow) box.height = flowY - box.y;
  stampExtent(el, box);
}

// The scrollable content extent, computed DURING layout instead of walked per read: every element
// gets the union of its own box and its children's extents. scrollWidth/scrollHeight are read
// constantly by editors and virtualised lists (a code editor measures on every keystroke), and a
// per-read subtree walk turns that into O(document) per call — the layout pass already visits every
// box exactly once, so the union is free here.
function stampExtent(el, box) {
  let right = box.x + box.width, bottom = box.y + box.height;
  for (const child of layoutChildren(el)) {
    const ce = child._lbExt;
    if (!ce) continue;
    if (ce.right  > right)  right  = ce.right;
    if (ce.bottom > bottom) bottom = ce.bottom;
  }
  el._lbExt = { right, bottom };
}

// A COARSE CSS-grid pass — enough for a simple uniform `repeat(N, …)` grid (Capybara's `spatial.erb`):
// equal columns, a single gap, fixed auto-row height, row-major auto-placement, and `grid-column:
// a / b` column spans. No fr-vs-fixed track sizing, no explicit row/column line placement, no
// alignment — those are later. `grid-column`-spanning items and out-of-flow items are handled.
function layoutGrid(el, box, ctx) {
  const cols = gridColumnCount(el);
  const gap  = gridGap(el);
  const rowH = gridRowHeight(el);
  const colW = cols > 0 ? (box.width - (cols - 1) * gap) / cols : box.width;
  let col = 0, row = 0;
  let bottom = box.y;
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, box.y + row * (rowH + gap), ctx); continue; }
    const span = Math.max(1, Math.min(gridColumnSpan(child), cols));
    if (col + span > cols) { col = 0; row++; }                       // wrap to the next row
    const cx = box.x + col * (colW + gap);
    const cy = box.y + row * (rowH + gap);
    layoutElement(child, { x: cx, y: cy, width: span * colW + (span - 1) * gap, height: rowH }, ctx);
    bottom = Math.max(bottom, cy + child._lb.height);
    col += span;
    if (col >= cols) { col = 0; row++; }
  }
  // Auto height back-fills from the placed rows — the same rule block flow follows. Without it a
  // grid container measures 0 while its items measure their row height, which is incoherent: a page
  // that divides by a container's height (Discourse's sidebar reorder decides insert-above from
  // `offsetY < rect.height / 2`) then takes the wrong branch, and every auto-height ancestor
  // collapses with it.
  if (box.height === 0) box.height = bottom - box.y;
  stampExtent(el, box);
}

const PX_RE = /(-?\d+(?:\.\d+)?)px/;
function gridColumnCount(el) {
  const t = cascadedProperty(el, 'grid-template-columns');
  if (!t) return 1;
  const s = String(t).trim();
  const rep = /^repeat\(\s*(\d+)\s*,/i.exec(s);
  if (rep) return parseInt(rep[1], 10);
  return s.split(/\s+/).filter(Boolean).length || 1;   // an explicit track list → one column each
}
function gridGap(el) {
  const g = cascadedProperty(el, 'gap') || cascadedProperty(el, 'grid-gap') || cascadedProperty(el, 'column-gap');
  const m = g && PX_RE.exec(String(g));
  return m ? parseFloat(m[1]) : 0;
}
function gridRowHeight(el) {
  const r = cascadedProperty(el, 'grid-auto-rows');   // `minmax(100px, auto)` / `100px` → 100 (coarse)
  const m = r && PX_RE.exec(String(r));
  return m ? parseFloat(m[1]) : 100;
}
function gridColumnSpan(el) {
  const c = cascadedProperty(el, 'grid-column');
  if (!c) return 1;
  const range = /(\d+)\s*\/\s*(\d+)/.exec(String(c));         // `1 / 4` → 3 columns
  if (range) return Math.max(1, parseInt(range[2], 10) - parseInt(range[1], 10));
  const span = /span\s+(\d+)/i.exec(String(c));               // `span 2`
  return span ? parseInt(span[1], 10) : 1;
}

// The length of `el`'s OWN text (direct text children only — a descendant block's text is that
// block's own height). Used to estimate how many lines it takes.
function ownTextLength(el) {
  let len = 0;
  for (const c of layoutChildren(el)) {
    if (c.nodeType !== 3 /* text */) continue;
    const t = c._data || c.data || '';
    if (/\S/.test(t)) len += t.trim().length;
  }
  return len;
}

// Coarse text height: no glyph metrics, so line count comes from an average advance width. This is
// the difference between "has text" and "has a LOT of text" — a long paragraph pushes what follows
// it down, and a content-length gate (Avo's Trix "More content" expander reads `scrollHeight`) sees
// content grow. Anything shorter than a line still gets exactly one line.
const AVG_CHAR_PX = 8;
function textHeight(el, width) {
  const len = ownTextLength(el);
  if (!len) return 0;
  const perLine = Math.max(1, Math.floor((width || 0) / AVG_CHAR_PX));
  return Math.ceil(len / perLine) * LINE_HEIGHT;
}

// Document scroll offsets (standards-mode scrollingElement == documentElement).
// Whether `el` establishes a scroll/clip box (any overflow axis non-`visible`). For occlusion,
// clipping is what matters, so `scroll`/`auto`/`hidden`/`clip` all count.
function isScrollContainer(el) {
  for (const v of [cascadedProperty(el, 'overflow-x'), cascadedProperty(el, 'overflow-y'), cascadedProperty(el, 'overflow')]) {
    if (v == null) continue;
    const s = String(v).trim().toLowerCase();
    if (s === 'scroll' || s === 'auto' || s === 'hidden' || s === 'clip') return true;
  }
  return false;
}

// Total scroll shift applied to `el` — the document root (documentElement) plus every ancestor
// scroll container. A container renders its descendants offset by its scroll, compounding up.
function scrollShift(el) {
  const root = globalThis.document && globalThis.document.documentElement;
  let sx = 0, sy = 0;
  for (let p = layoutParent(el); p; p = layoutParent(p)) {
    if (p === root || isScrollContainer(p)) { sx += p._scrollLeft || 0; sy += p._scrollTop || 0; }
  }
  return { sx, sy };
}

// `el`'s border-box in VIEWPORT coords (laid-out box minus its ancestor scroll shift).
function renderedBox(el) {
  const b = el._lb;
  if (!b) return null;
  const { sx, sy } = scrollShift(el);
  return { x: b.x - sx, y: b.y - sy, width: b.width, height: b.height };
}

function rectsIntersect(a, b) {
  return !!a && !!b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// `el` is clipped away when its rendered box doesn't intersect a scroll-container ancestor's
// rendered box (overflow clipping — coarse: both axes, whole-box, no rounded/partial clip).
function isClipped(el) {
  const eb = renderedBox(el);
  for (let p = layoutParent(el); p; p = layoutParent(p)) {
    if (isScrollContainer(p) && p._lb && !rectsIntersect(eb, renderedBox(p))) return true;
  }
  return false;
}

// Coarse FLAT paint rank (higher = nearer the viewer): a positioned box paints above non-positioned
// siblings; explicit `z-index` orders positioned boxes; ties break by tree order. Ignores nested
// stacking contexts (a later increment) — correct for flat fixtures and the no-overlap block case.
function paintRank(el) {
  if (positionOf(el) === 'static') return 0;
  const z = cascadedProperty(el, 'z-index');
  return z != null && /^-?\d+$/.test(String(z).trim()) ? parseInt(z, 10) : 0.5;  // z-auto positioned just above flow
}

// The topmost laid-out, non-clipped element whose rendered box contains the VIEWPORT point (vx, vy).
export function hitTest(vx, vy) {
  ensureLayout();
  const body = globalThis.document && globalThis.document.body;
  if (!body) return null;
  let best = null, bestRank = -Infinity, bestOrder = -Infinity;
  walkInclShadow(body, (n) => {
    if (n.nodeType !== NODE_ELEMENT || !n._lb || !isLaidOutNode(n) || isClipped(n)) return;
    const b = renderedBox(n);
    if (vx < b.x || vx > b.x + b.width || vy < b.y || vy > b.y + b.height) return;
    const r = paintRank(n);
    if (r > bestRank || (r === bestRank && n._lbOrder >= bestOrder)) { best = n; bestRank = r; bestOrder = n._lbOrder; }
  });
  return best;
}

// CSSOM/Selenium click-point occlusion: an element is obscured when a click at its box centre
// would NOT land on it (or a descendant). Non-visible elements are obscured.
export function isObscured(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return true;
  if (!(globalThis.__isVisibleNode && globalThis.__isVisibleNode(el))) return true;
  ensureLayout();
  if (!el._lb) return true;
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
  for (let n = hit; n; n = layoutParent(n)) if (n === el) { landed = true; break; }
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
  return renderedBox(frameEl);
}

// Parent-realm entry point (called from a CHILD realm): the child hit-tested (`x`, `y`) in its own
// viewport coords and landed on its element; that point maps to `frame`'s content box here, so the
// frame itself must be clickable there — recursing out through any further containers.
export function frameObscuredAt(frameEl, x, y) {
  if (!frameEl || frameEl.nodeType !== NODE_ELEMENT) return true;
  ensureLayout();
  if (!frameEl._lb || isClipped(frameEl)) return true;
  const b = renderedBox(frameEl);
  return obscuredAtPoint(frameEl, b.x + x, b.y + y);
}

// The size of the viewport this document lays out against — the top-level 1024x768, or the
// container frame's content box. CSSOM reports it as the ROOT element's clientWidth/clientHeight
// (the standards-mode rule), which is the idiom apps use to read "how big is the window".
export function viewportSize() {
  ensureLayout();
  return viewport();
}

// The scrollable content extent of `el`: its own box unioned with every laid-out descendant's, as
// width/height relative to its own origin. That is what scrollWidth/scrollHeight report — always at
// least the element's own size, larger when content overflows it.
export function contentExtent(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { width: 0, height: 0 };
  ensureLayout();
  const b = el._lb, ext = el._lbExt;
  if (!b || !ext) return { width: 0, height: 0 };
  return { width: Math.round(ext.right - b.x), height: Math.round(ext.bottom - b.y) };
}

// Whether `el` establishes a containing block for absolutely-positioned descendants — i.e. it is
// positioned. CSSOM's `offsetParent` is the nearest such ancestor.
export function isPositionedElement(el) {
  return !!el && el.nodeType === NODE_ELEMENT && positionOf(el) !== 'static';
}

// The laid-out border box in DOCUMENT coordinates — no scroll subtracted, unlike `rectOf`. This is
// what the offset* properties are measured in: they're layout positions, so scrolling the page
// doesn't change them (only `getBoundingClientRect` moves).
export function documentBoxOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  ensureLayout();
  return el._lb || null;
}

// The element's coarse border-box as a viewport-relative `{x, y, width, height}` — Capybara's
// `Node#rect`, which backs the spatial selectors (`:above`/`:below`/`:left_of`/`:right_of`/`:near`)
// and coordinate drag. Document coords minus the document scroll, so relative comparisons stay
// consistent. A non-laid-out element is a zero rect (the layout engine is used only here, so the
// app-facing getBoundingClientRect keeps its existing model).
export function rectOf(el) {
  const ZERO = { x: 0, y: 0, width: 0, height: 0 };
  if (!el || el.nodeType !== NODE_ELEMENT || !(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return ZERO;
  ensureLayout();
  return renderedBox(el) || ZERO;
}

// Where a scroll request lands, WITHOUT applying it: `{el, x, y}`, or null when there's nothing to
// scroll. `self` is the element the request was made on — the document root (html/body) scrolls the
// DOCUMENT (the documentElement offset, which rectOf/isObscured subtract), anything else scrolls
// ITSELF. Modes: a target element (align top / center / bottom), explicit `[x, y]`, or a position
// keyword. Split from the applying wrapper so a caller that owns its own scroll notifications
// (`scrollIntoView`, which must produce exactly one) can assign the offsets silently.
export function scrollTargetFor(self, target, pos, x, y) {
  const root = globalThis.document && globalThis.document.documentElement;
  const isRoot = !!self && (self._tag === 'html' || self._tag === 'body' || self === root);
  const scrollEl = isRoot ? root : self;
  if (!scrollEl) return null;
  ensureLayout();                                               // also resolves the viewport size
  const vpH = viewport().height;
  let sx = scrollEl._scrollLeft || 0, sy = scrollEl._scrollTop || 0;
  if (target) {
    const b = target._lb;
    if (b) {
      // Scroll offset that brings the target's top to the scroll box's content top: the target's
      // laid-out position MINUS the scroll box's origin (the viewport origin (0,0) for the document
      // root; the container's own box for a scroll container).
      const ox = isRoot || !scrollEl._lb ? 0 : scrollEl._lb.x;
      const oy = isRoot || !scrollEl._lb ? 0 : scrollEl._lb.y;
      sy = b.y - oy;                                            // align:top
      if (pos === 'center')      sy = b.y - oy - (vpH - b.height) / 2;
      else if (pos === 'bottom') sy = b.y - oy - (vpH - b.height);
      sx = b.x - ox;                                            // bring a horizontally-offscreen box in too
    }
  } else if (x != null || y != null) {
    sx = +x || 0; sy = +y || 0;
  } else if (pos === 'top')    { sy = 0; }
  else if (pos === 'bottom')   { sy = 1e9; }                    // coarse "far down"
  else if (pos === 'center')   { sy = 5e8; }
  return { el: scrollEl, x: Math.max(0, sx), y: Math.max(0, sy) };
}

// Capybara `scroll_to` — drive the scroll offset so a subsequent geometry read (obscured? / rect)
// reflects the new position. Applied through the public setters so scroll / scrollend fire
// (IntersectionObserver etc.). Returns the scrolled element.
export function applyScrollTo(self, target, pos, x, y) {
  const to = scrollTargetFor(self, target, pos, x, y);
  if (!to) return null;
  to.el.scrollLeft = to.x;
  to.el.scrollTop  = to.y;
  return to.el;
}
