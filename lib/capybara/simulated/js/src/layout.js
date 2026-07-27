// A COARSE box-layout model — enough for occlusion / hit-testing (`obscured?`), NOT a real layout
// engine. It computes an approximate border-box `{x, y, width, height}` (document coordinates) for
// each rendered element via block flow + absolute/fixed positioning with EXPLICIT sizes, plus a
// z-order hit-test. Deliberate coarse choices (documented per box): no text-metrics (auto width →
// containing-block width; a text-bearing block gets a coarse line-height so it has a hittable box),
// no inline flow / float / flex / grid track sizing, no overflow-scroll clipping, no per-side
// margin/padding/border in flow advancement, and a FLAT paint order (no nested stacking-context
// tree). This is sufficient for explicitly-sized fixtures (Capybara's `obscured.erb`) and for the
// no-false-overlap property of block flow on real pages; richer layout is a later increment.
//
// Cost: pay-per-use. The whole tree is laid out once per (settleGen, cascadeVersion) generation —
// the same dual key the innerText memo uses (inline/attr edits bump settleGen; stylesheet/CSSOM
// edits bump cascadeVersion) — and only when a hit-test actually runs, so it never touches the hot
// path (rule 3).

import { NODE_ELEMENT }                                  from './constants.js';
import { walkSubtree }                                   from './walk.js';
import { isLaidOutNode, cascadedProperty, resolveLayoutProp, resolveCascadeDisplay } from './cascade.js';

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
  const ctx = { order: 0 };
  // <body>'s content origin is its margin; its containing block for absolute descendants is the
  // initial containing block (the viewport), resolved lazily in containingBlockFor.
  layoutElement(body, { x: BODY_MARGIN, y: BODY_MARGIN, width: VIEWPORT_W - 2 * BODY_MARGIN, height: 0 }, ctx);
}

// The nearest positioned ancestor's box is an absolute box's containing block; with none, it's the
// initial containing block (the viewport). (Coarse: padding box == border box here.)
function containingBlockFor(el) {
  for (let p = el._parent; p && p.nodeType === NODE_ELEMENT; p = p._parent) {
    const pos = positionOf(p);
    if (pos !== 'static' && p._lb) return p._lb;
  }
  return { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H };
}

function positionOf(el) {
  const p = cascadedProperty(el, 'position');
  return p ? String(p).trim().toLowerCase() : 'static';
}
function displayOf(el) { return resolveCascadeDisplay(el); }   // cascaded display keyword or null

// Place an out-of-flow (absolute/fixed) child against its containing block; `staticY` is the flow
// position an `auto` top falls back to. Does NOT advance the parent's flow.
function placeAbsolute(child, pos, staticY, ctx) {
  const cb   = pos === 'fixed' ? { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H } : containingBlockFor(child);
  const w    = resolveLayoutProp(child, 'width');
  const h    = resolveLayoutProp(child, 'height');
  const top  = resolveLayoutProp(child, 'top');
  const left = resolveLayoutProp(child, 'left');
  // auto inset → the box's static position (coarse: containing-block origin x / current flow y).
  const cx = left != null ? cb.x + left : cb.x;
  const cy = top  != null ? cb.y + top  : staticY;
  layoutElement(child, { x: cx, y: cy, width: w != null ? w : cb.width, height: h != null ? h : 0 }, ctx);
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
  for (const child of el._children) {
    if (child.nodeType !== NODE_ELEMENT || !isLaidOutNode(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, flowY, ctx); continue; }
    // In-flow block: fills the containing width unless explicitly sized; stacks below its
    // predecessors (coarse: margins ignored). A text-bearing block with no explicit height gets a
    // coarse line-height so it still has a hittable box (no glyph metrics — line count only).
    const w = resolveLayoutProp(child, 'width');
    const h = resolveLayoutProp(child, 'height');
    layoutElement(child, { x: box.x, y: flowY, width: w != null ? w : box.width, height: h != null ? h : 0 }, ctx);
    if (h == null && child._lb.height === 0 && hasOwnText(child)) child._lb.height = LINE_HEIGHT;
    flowY += child._lb.height;
    hadInFlow = true;
  }
  // Auto height (a block with no explicit height) = the flow its in-flow children consumed.
  if (box.height === 0 && hadInFlow) box.height = flowY - box.y;
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
  for (const child of el._children) {
    if (child.nodeType !== NODE_ELEMENT || !isLaidOutNode(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, box.y + row * (rowH + gap), ctx); continue; }
    const span = Math.max(1, Math.min(gridColumnSpan(child), cols));
    if (col + span > cols) { col = 0; row++; }                       // wrap to the next row
    const cx = box.x + col * (colW + gap);
    const cy = box.y + row * (rowH + gap);
    layoutElement(child, { x: cx, y: cy, width: span * colW + (span - 1) * gap, height: rowH }, ctx);
    col += span;
    if (col >= cols) { col = 0; row++; }
  }
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

function hasOwnText(el) {
  for (const c of el._children) if (c.nodeType === 3 /* text */ && /\S/.test(c._data || c.data || '')) return true;
  return false;
}

// Document scroll offsets (standards-mode scrollingElement == documentElement).
function scrollOffset() {
  const root = globalThis.document && globalThis.document.documentElement;
  return { x: (root && root._scrollLeft) || 0, y: (root && root._scrollTop) || 0 };
}

// Coarse FLAT paint rank (higher = nearer the viewer): a positioned box paints above non-positioned
// siblings; explicit `z-index` orders positioned boxes; ties break by tree order. Ignores nested
// stacking contexts (a later increment) — correct for flat fixtures and the no-overlap block case.
function paintRank(el) {
  if (positionOf(el) === 'static') return 0;
  const z = cascadedProperty(el, 'z-index');
  return z != null && /^-?\d+$/.test(String(z).trim()) ? parseInt(z, 10) : 0.5;  // z-auto positioned just above flow
}

// The topmost laid-out element whose border-box contains the DOCUMENT-coordinate point (x, y).
export function hitTest(x, y) {
  ensureLayout();
  const body = globalThis.document && globalThis.document.body;
  if (!body) return null;
  let best = null, bestRank = -Infinity, bestOrder = -Infinity;
  walkSubtree(body, (n) => {
    if (n.nodeType !== NODE_ELEMENT || !n._lb || !isLaidOutNode(n)) return;
    const b = n._lb;
    if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) return;
    const r = paintRank(n);
    if (r > bestRank || (r === bestRank && n._lbOrder >= bestOrder)) { best = n; bestRank = r; bestOrder = n._lbOrder; }
  });
  return best;
}

// CSSOM/Selenium click-point occlusion: an element is obscured when a click at its in-view centre
// would NOT land on it (or a descendant). Non-visible or fully out-of-viewport elements are obscured.
export function isObscured(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return true;
  if (!(globalThis.__isVisibleNode && globalThis.__isVisibleNode(el))) return true;
  ensureLayout();
  const box = el._lb;
  if (!box) return true;
  const s = scrollOffset();
  const vx = box.x - s.x, vy = box.y - s.y;                       // viewport-space box
  const ix0 = Math.max(vx, 0), iy0 = Math.max(vy, 0);
  const ix1 = Math.min(vx + box.width, VIEWPORT_W), iy1 = Math.min(vy + box.height, VIEWPORT_H);
  if (ix1 <= ix0 || iy1 <= iy0) return true;                     // no in-view area → obscured
  const hit = hitTest((ix0 + ix1) / 2 + s.x, (iy0 + iy1) / 2 + s.y);   // hit-test in document coords
  if (!hit) return true;
  for (let n = hit; n; n = n._parent) if (n === el) return false;   // hit is el or a descendant → not obscured
  return true;
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
  const b = el._lb;
  if (!b) return ZERO;
  const s = scrollOffset();
  return { x: b.x - s.x, y: b.y - s.y, width: b.width, height: b.height };
}
