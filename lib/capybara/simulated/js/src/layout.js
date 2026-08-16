// The box-layout model: a border-box `{x, y, width, height}` in document coordinates for every
// rendered element, plus the z-order hit-test built on those boxes. The page-visible geometry
// surface (`getBoundingClientRect` / `elementFromPoint` / `offset*` / `client*` / `scroll*`) reads
// the same boxes, so the driver and the page's own JS never disagree about where anything is.
//
// MODELLED: block flow with adjacent-sibling margin collapsing; inline runs measured with the
// font's own advance widths (see "Text metrics" below); absolute / fixed / relative positioning,
// stretched between opposite insets or shrunk to fit; a coarse flex row; a coarse grid pass; CSS
// Tables 3 table layout; overflow clipping and scroll offsets; the flat tree through shadow roots
// and slots; and frames across realms.
//
// DELIBERATELY NOT, each documented at the box it affects: glyph SHAPING (kerning, ligatures,
// bidi) and the real line-breaking algorithm — a run wider than its line wraps on an estimate;
// flex / grid TRACK sizing; floats; PARTIAL overflow clipping (a box is clipped whole or not at
// all); parent/first-child margin collapsing; `vertical-align`; and a FLAT paint order (no nested
// stacking-context tree).
//
// Frames compose ACROSS REALMS rather than across one tree: a frame document lays itself out in its
// own realm, against its container's content box as the viewport, and occlusion walks OUT one frame
// at a time (see "Frame (nested browsing context) geometry" below).
//
// Cost: laid out once per (settleGen, cascadeVersion) generation — the same dual key the innerText
// memo uses (inline/attr edits bump settleGen; stylesheet/CSSOM edits bump cascadeVersion). It is
// pay-per-use for a page with no live IntersectionObserver: nothing lays out until something asks
// for geometry. A page that HAS one pays a pass per rendering update in which the DOM changed,
// because that is when observers are delivered (measured: a Discourse slice 6:20 → 7:14).

import { NODE_ELEMENT }                                  from './constants.js';
import { walkInclShadow }                                from './walk.js';
import { isLaidOutNode, selfNotRendered, resolveLayoutProp, resolveCascadeDisplay } from './cascade.js';
import { currentViewport }                               from './media-query.js';
// Box props are read through `declaredValue`, not the raw cascade: it resolves a `var()` against
// the element and decodes the pending slot a `flex: var(--f)` shorthand occupies. Reading the store
// directly made layout see an opaque marker where getComputedStyle saw `1` — ONE geometry means one
// value resolution too.
import { usedDisplay, DEFAULT_DISPLAY, declaredValue, computedFontSizePx, computedLineHeight,
         computedFontFamily, computedFontWeight, computedFontStyle, declaresOwnFont,
         fontRelativeToPx, computedBorderCollapse, computedBorderSpacing } from './style-proxy.js';

const BODY_MARGIN = 8;      // UA default body margin (coarse; not cascade-modelled)
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
  layoutPass++;
  // The viewport this document lays out against — the top-level one, or our container frame's
  // content box. Resolved once per layout pass (it needs a cross-realm call; see viewport()).
  doc._layoutVP = computeViewport();
  const vp = doc._layoutVP;
  const ctx = { order: 0 };
  // <body>'s content origin is its own margin — the UA's 8px unless the page says otherwise, which
  // plenty of pages do (`body { margin: 0 }` moves everything to the viewport origin). Its
  // containing block for absolute descendants is the initial containing block (the viewport),
  // resolved lazily in containingBlockFor.
  // The root's own declared size wins over the viewport when the page sets one — `html { height:
  // 250% }` makes the DOCUMENT that tall, which is what the scrollable range is measured from.
  // Percentages resolve against the initial containing block (the viewport).
  const root = doc.documentElement;
  const rootDeclW = root ? resolveLayoutProp(root, 'width',  vp.width)  : null;
  const rootDeclH = root ? resolveLayoutProp(root, 'height', vp.height) : null;
  const rootW = rootDeclW != null ? rootDeclW : vp.width;

  const ml = marginOf(body, 'margin-left'), mr = marginOf(body, 'margin-right'), mt = marginOf(body, 'margin-top');
  layoutElement(body, { x: ml, y: mt, width: Math.max(0, rootW - ml - mr), height: 0 }, ctx);
  // The root element gets a box too: apps read `documentElement.getBoundingClientRect()` for scroll
  // math. Its height is its declared one, else what the document actually consumed (which can exceed
  // the viewport — that's the point); `clientHeight`'s viewport-sized answer is a separate CSSOM
  // rule, see viewportSize(). Ordered BELOW everything so it never wins a hit-test tie.
  if (root) {
    const bb = body._lb;
    // The root wraps the body plus the body's own bottom margin — the UA's 8px unless the page set
    // one, exactly as the top margin above (a page that says `body { margin: 0 }` gets a root box
    // as tall as its content, which is what Chrome reports).
    // A body that isn't RENDERED contributes nothing: `layoutElement` stamps a box for it either
    // way, and taking that phantom flow gave the root a height for a document that draws nothing
    // (Chrome measured: `body { display: none }` → `html` rect height 0).
    const bodyRendered = bb && isLaidOutNode(body);
    const consumed = bodyRendered ? bb.y + bb.height + marginOf(body, 'margin-bottom') : 0;
    root._lb = { x: 0, y: 0, width: rootW, height: rootDeclH != null ? rootDeclH : consumed };
    root._lbOrder = -1;
    // The root is boxed here rather than through layoutElement, so stamp its content extent too —
    // `document.documentElement.scrollHeight` is how a page asks "how tall is the document", and
    // without this it reads 0. The extent, unlike the BOX, is floored at the viewport: a document
    // shorter than the window still reports `scrollHeight === clientHeight` (scroll math divides
    // by the difference), while its root element's client rect is only as tall as its content —
    // Chrome measured, `html { height: 100px }` content in a 768-tall window gives a 100-tall
    // rect and a 681 scrollHeight.
    stampExtent(root, { x: 0, y: 0, width: rootW, height: Math.max(root._lb.height, vp.height) });
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
  // global costs nothing and can't re-enter. The parent re-pushes on a window resize
  // (`__csimRefreshFrameViewports`), so a frame follows `resize_to` like everything else; a frame
  // whose CONTAINER is resized by page script keeps its box until the next re-push (coarse).
  const pushed = globalThis.__csimFrameViewport;
  if (pushed) return { width: pushed.width, height: pushed.height };
  // In a frame whose parent pushed nothing (an unrendered container — display:none, detached), the
  // viewport is EMPTY: nothing inside a non-rendered frame is clickable, and falling back to the
  // top-level size would report its content as in-view.
  if (globalThis.frameElement) return { width: 0, height: 0 };
  // Top level: the WINDOW viewport — the driver-owned `__csimViewport` that `innerWidth` /
  // `innerHeight` and the `@media` cascade also read, so a breakpoint flip and the boxes it moves
  // are computed against one size. `__csimSetViewport` invalidates the layout when it moves.
  return currentViewport();
}

// The generation geometry is valid for. Two calls with the same value can't produce different
// boxes, so a repeated observer pass over unchanged geometry can return immediately. Scrolling is
// NOT in it (it moves rendered boxes without touching either counter) — the scroll path forces its
// own update instead.
export function layoutGeneration() { return `${settleGen()}:${cascadeVersion()}:${scrollEpoch}`; }

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
// initial containing block (the viewport). CSS says the PADDING box of the ancestor —
// with real borders that is no longer its border box.
function containingBlockFor(el) {
  for (let p = layoutParent(el); p; p = layoutParent(p)) {
    const pos = positionOf(p);
    if (pos !== 'static' && p._lb) {
      const bw = borderWidthsOf(p);
      return {
        x: p._lb.x + bw.left,
        y: p._lb.y + bw.top,
        width:  Math.max(0, p._lb.width  - bw.left - bw.right),
        height: Math.max(0, p._lb.height - bw.top  - bw.bottom)
      };
    }
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
const BROKEN_IMAGE_SIZE = { width: 16, height: 16 };   // Chrome's box for an img that hasn't decoded

function intrinsicSize(el) {
  const t = el._tag;
  if (REPLACED_TAGS.has(t)) return OBJECT_SIZE;
  // An `<img>` is as big as the image it decoded — the driver already records that as
  // `_naturalWidth`/`_naturalHeight` — and 16x16 while it hasn't (Chrome's broken/placeholder box,
  // verified). Without this an image had no intrinsic size at all: it took a whole line's height in
  // an inline run and its containing block's width, so a click aimed at its centre missed it.
  if (t === 'img') {
    const w = el._naturalWidth, h = el._naturalHeight;
    // A decoded image is the only thing here with a REAL aspect ratio (`ratio: true`) — the 300x150
    // default object size is not one, so an `<iframe height="10">` must stay 300 wide rather than
    // being scaled to 20.
    return (w > 0 && h > 0) ? { width: w, height: h, ratio: true } : BROKEN_IMAGE_SIZE;
  }
  if (t === 'input') {
    const type = ((el._attrs && el._attrs.type) || '').toLowerCase();
    return (type === 'checkbox' || type === 'radio') ? CHECKBOX_SIZE : CONTROL_SIZES.input;
  }
  return CONTROL_SIZES[t] || null;
}

// The used border-box size of `el`: its declared width/height, else its intrinsic size, else the
// caller's auto fallback. `autoHeight` reports that the height really is auto, so the caller can
// back-fill it from content (an explicit `height: 0` stays 0).
function usedSize(el, autoW, autoH, cbW = autoW, cbH = null) {
  const w = resolveLayoutProp(el, 'width', cbW);
  const h = resolveLayoutProp(el, 'height', cbH);
  const intrinsic = intrinsicSize(el);
  // A DECLARED size is the content box unless `box-sizing: border-box` — the border
  // box the caller wants adds the edges back on. An AUTO width already arrives as a
  // border-box figure (the containing block's content width), so it is left alone.
  const edge = edgeInsets(el, cbW);
  const extraW = edge.left + edge.right, extraH = edge.top + edge.bottom;
  const grow = (w != null || h != null) && !isBorderBox(el);
  let width  = w != null ? w + (grow ? extraW : 0) : (intrinsic ? intrinsic.width  + extraW : autoW);
  let height = h != null ? h + (grow ? extraH : 0) : (intrinsic ? intrinsic.height + extraH : autoH);
  // One axis given and the other auto on a replaced element: the missing one follows the intrinsic
  // aspect ratio (`<img width="500">` on a 4:3 image is 375 tall, not 150).
  if (intrinsic && intrinsic.ratio && intrinsic.width > 0 && intrinsic.height > 0) {
    if (w != null && h == null)      height = Math.round(w * intrinsic.height / intrinsic.width);
    else if (h != null && w == null) width  = Math.round(h * intrinsic.width  / intrinsic.height);
  }
  return { width, height, autoWidth: w == null && !intrinsic, autoHeight: h == null && !intrinsic };
}

function positionOf(el) {
  const p = declaredValue(el, 'position');
  return p ? String(p).trim().toLowerCase() : 'static';
}

// A declared margin in px, else the UA default (only <body> asks, and 8px is its UA margin).
function marginOf(el, prop) {
  const m = resolveLayoutProp(el, prop);
  return m != null ? m : BODY_MARGIN;
}

// ── Box edges: border + padding + margin ─────────────────────────────────────
// The border box is the padding box plus borders, and children lay out against the
// CONTENT box (border box inset by both). Before this, boxes were content-only —
// `<div style="padding:20px">x</div>` measured 19 tall where Chrome says 58, and a
// margin never moved anything — so every padded container under-reported its size
// and its descendants sat at the wrong offsets.
//
// Each side is resolved through the same `resolveLayoutProp` the rest of layout
// uses (var() / calc() resolved, percentages against the containing width per CSS
// — vertical paddings resolve against the WIDTH too). A `border-<side>-width`
// counts only when that side's style isn't `none`/`hidden`, matching used values.
const SIDES = ['top', 'right', 'bottom', 'left'];

const MARGIN_KEY = { top: 'mt', right: 'mr', bottom: 'mb', left: 'ml' };
const OPPOSITE_SIDE = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
// One side's used border width. A width counts only when that side's style isn't
// `none` / `hidden`: the UA initial style is `none`, so a bare `border-width: 5px`
// paints — and measures — nothing.
function usedBorderWidth(el, side, cbW, info) {
  const bw = resolveLayoutProp(el, 'border-' + side + '-width', cbW, info) || 0;
  if (!bw) return 0;
  const style = declaredValue(el, 'border-' + side + '-style');
  const t = style ? String(style).trim().toLowerCase() : '';
  return (!t || t === 'none' || t === 'hidden') ? 0 : bw;
}

const BORDER_KEY = { top: 'bt', right: 'br', bottom: 'bb', left: 'bl' };

// Memoised per element per pass — and additionally per BASIS, but only for a box
// that actually has a percentage edge. Percentages resolve against `cbW`, so an
// intrinsic-sizing read (which has no basis at all — see `intrinsicWidths`) and the
// later flow read are genuinely different answers for such a box, and whichever
// arrived first used to win for the whole pass. Almost nothing has one, and those
// boxes keep computing their edges exactly once.
const EDGE_INFO = { percent: false };
function edgeInsets(el, cbW) {
  if (el._lbEdgePass === layoutPass && (!el._lbEdgePct || el._lbEdgeCb === cbW)) return el._lbEdge;
  const e = { top: 0, right: 0, bottom: 0, left: 0, mt: 0, mr: 0, mb: 0, ml: 0, bt: 0, br: 0, bb: 0, bl: 0 };
  const halve = halvesBorders(el);
  const info = EDGE_INFO;          // not re-entrant: nothing below calls back in here
  info.percent = false;
  for (const side of SIDES) {
    const pad = resolveLayoutProp(el, 'padding-' + side, cbW, info) || 0;
    let bw = usedBorderWidth(el, side, cbW, info);
    if (halve) {
      // A collapsed edge is as wide as the WIDEST declaration on it, and a table's
      // cells face each other: the neighbour's opposite side is the other half of
      // this one. Taking only this cell's own side halved every row of a
      // `td { border-top: 1px }` table (the Bootstrap shape) — 0.5px short each,
      // which is 10px down a 20-row list.
      const facing = usedBorderWidth(el, OPPOSITE_SIDE[side], cbW, info);
      if (facing > bw) bw = facing;
    }
    if (halve) bw /= 2;         // …and owns half of it
    e[side] = pad + bw;
    e[BORDER_KEY[side]] = bw;   // the border alone — the client box / scroll origin
    e[MARGIN_KEY[side]] = resolveLayoutProp(el, 'margin-' + side, cbW, info) || 0;
  }
  el._lbEdge = e;
  el._lbEdgePct = info.percent;
  el._lbEdgeCb = cbW;
  el._lbEdgePass = layoutPass;
  return e;
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

// `position: relative` shifts a box from its flow position by its insets WITHOUT changing the flow
// — following siblings stack as if it hadn't moved. `right` / `bottom` are the opposite-direction
// shift of the edge they name, and lose to `left` / `top` when both are set (LTR / top-to-bottom).
function relativeOffset(el, cbW = null, cbH = null) {
  // `position: relative` is on a lot of elements (utility CSS puts it everywhere), and every
  // `resolveLayoutProp` walks the rule index, so only look up the opposite inset when the primary
  // one is absent — which is also the CSS precedence, so nothing changes but the cost.
  const left = resolveLayoutProp(el, 'left', cbW);
  const top  = resolveLayoutProp(el, 'top',  cbH);
  const x = left != null ? left : -(resolveLayoutProp(el, 'right',  cbW) || 0);
  const y = top  != null ? top  : -(resolveLayoutProp(el, 'bottom', cbH) || 0);
  return { x, y };
}
// The USED display: author inline style, stylesheet, then the per-tag UA default — so the engine
// can tell a `<span>` from a `<div>` without the page saying so. Memoised per layout pass (the box
// stamp is thrown away with it), since every child asks once and the resolver walks the cascade.
function displayOf(el) {
  if (el._lbDispPass === layoutPass) return el._lbDisp;
  el._lbDispPass = layoutPass;
  el._lbDisp = computeUsedDisplay(el);
  return el._lbDisp;
}
// Hot path: an inline/block decision for every element on the page. The full resolver parses the
// element's inline style and walks the hide-rule cascade, which is 2x the cost of a layout pass on an
// editor-shaped DOM — so only pay it when the element's own `style` could carry a `display`, and
// otherwise take the author rule (which early-returns when the page has no hide rules at all) and
// then the UA per-tag default.
function computeUsedDisplay(el) {
  const st = el._attrs && el._attrs.style;
  if (st && String(st).indexOf('display') >= 0) {
    const d = usedDisplay(el);
    if (d) return d;
  }
  return resolveCascadeDisplay(el) || DEFAULT_DISPLAY[el._tag] || 'block';
}
const INLINE_LEVEL = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table']);
function isInlineLevel(el) { return INLINE_LEVEL.has(displayOf(el)); }

// Place an out-of-flow (absolute/fixed) child against its containing block; `staticY` is the flow
// position an `auto` top falls back to. Does NOT advance the parent's flow.
function placeAbsolute(child, pos, staticY, ctx) {
  const vp = viewport();
  const cb = pos === 'fixed' ? { x: 0, y: 0, width: vp.width, height: vp.height } : containingBlockFor(child);

  const top    = resolveLayoutProp(child, 'top',    cb.height);
  const left   = resolveLayoutProp(child, 'left',   cb.width);
  const right  = resolveLayoutProp(child, 'right',  cb.width);
  const bottom = resolveLayoutProp(child, 'bottom', cb.height);
  // Both insets on an axis + an auto size STRETCHES the box between them — `inset: 0` on a modal
  // overlay / backdrop is the everyday case, and it's what makes such an overlay actually cover
  // (and occlude) the page. With only one inset (or none) an auto width SHRINKS TO FIT instead: a
  // dropdown, a tooltip or a badge is as wide as its content, and reporting it as wide as its
  // containing block made it occlude a strip of page it doesn't cover. An auto height still stays
  // 0 for the flow to back-fill.
  const stretched = left != null && right != null;
  const availW = Math.max(0, cb.width - (left || 0) - (right || 0));
  const autoW = stretched ? availW : shrinkToFitWidth(child, availW);
  const autoH = (top  != null && bottom != null) ? Math.max(0, cb.height - top  - bottom) : 0;
  const size = usedSize(child, autoW, autoH, cb.width, cb.height);
  // An `auto` inset falls back to the box's static position (coarse: containing-block origin x /
  // current flow y); the opposite inset positions the box's far edge against that edge of the
  // containing block, which is how a bottom-right-pinned box tracks a viewport resize.
  const cx = left != null ? cb.x + left
           : right != null ? cb.x + cb.width - right - size.width
           : cb.x;
  const cy = top != null ? cb.y + top
           : bottom != null ? cb.y + cb.height - bottom - size.height
           : staticY;
  // `fixed` is stamped on the box (not re-read from the cascade later): the geometry queries below
  // ask "does an ancestor scroll move this?" on every hit-test, and a flag read is O(1).
  const box = { x: cx, y: cy, width: size.width, height: size.height, fixed: pos === 'fixed', outOfFlow: true };
  layoutElement(child, box, ctx, cb.width);
  // An auto height isn't known until the child's own flow has been laid out (layoutElement
  // back-fills it), and a text-only out-of-flow box — a tooltip, a toast — gets the same coarse
  // line-height an in-flow one does, else it has a zero-height box and can't be hit at all.
  if (size.autoHeight && box.height === 0) box.height = textHeight(child, box.width);
  // Anchored by `bottom` alone, the box was placed against a height we didn't know yet: lift it by
  // what it turned out to be, so its BOTTOM edge — the anchored one — lands where it belongs. (A
  // `right`-anchored auto WIDTH needs no such pass: shrink-to-fit measures the content WITHOUT
  // laying it out, so the width above is already final and the far edge landed correctly.)
  if (bottom != null && top == null && box.height !== size.height) {
    shiftSubtreeY(child, size.height - box.height);
  }
}

// `flex-direction: column` (and `column-reverse`) stacks, which is what block flow already does —
// only a ROW needs its own pass.
function isColumnFlex(el) {
  const d = declaredValue(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase().startsWith('column');
}
function isReverseFlex(el) {
  const d = declaredValue(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase() === 'row-reverse';
}

// An item's flex factors. The `flex` shorthand is expanded into these longhands by the cascade, so
// reading only the longhands here is what makes declaration order work.
function flexParts(el) {
  if (el._lbFlexPass === layoutPass) return el._lbFlex;
  el._lbFlexPass = layoutPass;
  const num = (v, dflt) => { const n = parseFloat(v); return v != null && isFinite(n) ? Math.max(0, n) : dflt; };
  el._lbFlex = {
    grow:   num(declaredValue(el, 'flex-grow'), 0),
    shrink: num(declaredValue(el, 'flex-shrink'), 1)
  };
  return el._lbFlex;
}

// A coarse flex ROW: items sit side by side in source order with their widths resolved together
// (see resolveFlexRowWidths — basis, grow, shrink and the automatic minimum), and the row is as tall
// as its tallest item. No wrapping, no alignment, no baseline — enough that a toolbar, a field row
// or a card row occupies ONE row's height instead of one per item.
function layoutFlexRow(el, box, content, ctx, { equalShare = false } = {}) {
  const items = [];
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, content.y, ctx); continue; }
    items.push({ child, pos });
  }
  // An item with no text of its own has no content width to measure, so it takes an equal share —
  // better than the zero a text estimate would give a container of blocks.
  const share = items.length ? Math.floor(content.width / items.length) : content.width;
  const widths = equalShare ? items.map(() => share) : resolveFlexRowWidths(items, content, share);

  // `row-reverse` runs the main axis the other way: items go in reverse order AND pack against the
  // right edge (Chrome puts two 100px items in a 400px reverse row at 300 and 200, not 100 and 0).
  // Redmine's `#main` is one — it is how its sidebar ends up on the right.
  const reverse = isReverseFlex(el);
  const order = reverse ? items.map((_, i) => items.length - 1 - i) : items.map((_, i) => i);
  let x = reverse ? content.x + content.width - widths.reduce((a, b) => a + b, 0) : content.x;
  let rowH = 0;
  for (const idx of order) {
    const { child, pos } = items[idx];
    const base = widths[idx];
    const size = usedSize(child, base, 0, content.width, content.height || null);
    // The flex pass already resolved this axis: a declared width is an item's flex BASE, not its
    // final width, so it must not win here the way it does in block flow (two 500px items in a 600px
    // row shrink to fit, they don't overflow to 900). The `equalShare` path is the exception — it
    // is an ORPHAN `display: table-row` (a real table's rows never reach here), whose cells keep
    // their declared widths.
    // The resolved main-axis figure is the item's CONTENT width, so its own padding
    // and borders still have to be added — dropping them (as an earlier revision did)
    // handed layoutElement a border box smaller than the item's own edges, and its
    // text then wrapped into a column many lines tall.
    if (!equalShare) {
      const ie = edgeInsets(child, content.width);
      size.width = base + (isBorderBox(child) ? 0 : ie.left + ie.right);
    }
    const rel  = pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null;
    layoutElement(child, {
      x: x + (rel ? rel.x : 0), y: content.y + (rel ? rel.y : 0),
      width: size.width, height: size.height
    }, ctx, content.width);
    if (size.autoHeight && child._lb.height === 0) child._lb.height = textHeight(child, child._lb.width) || lineHeightOf(child);
    x += child._lb.width;
    if (child._lb.height > rowH) rowH = child._lb.height;
  }
  // Auto height wraps the row plus this container's own vertical edges.
  if (box.height === 0) {
    const e = edgeInsets(el, box.width);
    box.height = rowH + e.top + e.bottom;
  }
  stampExtent(el, box);
}

// Resolve a flex row's widths together: each item starts from its flex base size (0 for
// `flex: <n>`, a declared width, else its content), then the leftover space is handed out in
// proportion to the grow factors — or, when the bases OVERFLOW the row, taken back in proportion to
// the shrink factors, never below the item's automatic minimum (its content). Without the grow half
// a `flex: 1` pane is only as wide as the words in it; without the shrink half and the minimum, a
// row of fixed-width items pushes its siblings off the line.
function resolveFlexRowWidths(items, box, share) {
  const parts = items.map(({ child }) => flexParts(child));
  // Flex base size, in the spec's order: an explicit `flex-basis` (including the `0%` the `flex: <n>`
  // shorthand expands to) wins over a declared `width`, which wins over the item's intrinsic size —
  // an `<input>`, a `<button>` or an `<img>` keeps ITS size rather than being measured as text —
  // which wins over a text estimate. An item with none of those has nothing to measure, so it falls
  // back to an equal share rather than collapsing to nothing.
  const bases = items.map(({ child }, i) => {
    const basis = resolveLayoutProp(child, 'flex-basis', box.width);
    if (basis != null) return basis;
    const declared = resolveLayoutProp(child, 'width', box.width);
    if (declared != null) return declared;
    const intrinsic = intrinsicSize(child);
    if (intrinsic) return intrinsic.width;
    // Whatever the item's CONTENT wants — which a flat text sum could not answer for
    // a wrapper around block children (it said 0, and the fallback below had to
    // rescue it).
    return Math.min(intrinsicWidths(child).max, box.width);
  });

  // An item that measured nothing — no basis, no width, no intrinsic size, no text: a wrapper around
  // block content — ends up at an equal share rather than collapsing to zero and becoming unhittable.
  // Applied to the RESULT, not to the base: putting it in the base makes such items claim space in
  // the free-space arithmetic and pushes their siblings into the shrink branch.
  const fallback = (w) => (w > 0 ? w : share);

  const free = box.width - bases.reduce((a, b) => a + b, 0);
  if (free > 0) {
    const totalGrow = parts.reduce((a, p) => a + p.grow, 0);
    if (totalGrow <= 0) return bases.map(fallback);
    return bases.map((b, i) => fallback(Math.round(b + (free * parts[i].grow) / totalGrow)));
  }
  if (free < 0) {
    // Shrink by `flex-shrink x base` (the spec's weighting), never past the item's automatic
    // minimum. Only this branch needs the minimums, so they are measured only here.
    const weights = bases.map((b, i) => b * parts[i].shrink);
    const totalW  = weights.reduce((a, b) => a + b, 0);
    if (totalW <= 0) return bases.map(fallback);
    return bases.map((b, i) => {
      const declaredMin = resolveLayoutProp(items[i].child, 'min-width', box.width);
      // `min-width: auto` on a flex item is its content size — what keeps a label or a button from
      // being squeezed to nothing.
      const min = declaredMin != null ? declaredMin : Math.min(minContentWidth(items[i].child), box.width);
      return fallback(Math.round(Math.max(min, b + (free * weights[i]) / totalW)));
    });
  }
  return bases.map(fallback);
}

// Move an already-laid-out subtree vertically. Only the bottom-anchored auto-height case above
// needs it, so the walk is not on any hot path.
function shiftSubtreeY(el, dy) {
  if (!dy) return;
  if (el._lb)        el._lb.y            += dy;
  if (el._lbExt)     el._lbExt.bottom     += dy;
  if (el._lbExtFlow) el._lbExtFlow.bottom += dy;
  for (const child of layoutChildren(el)) {
    if (child.nodeType === NODE_ELEMENT) shiftSubtreeY(child, dy);
  }
}

// Lay out `el` (already boxed as `box`) and its children — grid containers via a coarse grid pass,
// otherwise block flow with INLINE RUNS: inline-level children and text runs share a line box and
// only wrap when they fill the width, block-level children break the line and stack, and out-of-flow
// (absolute/fixed) boxes are positioned against their containing block without advancing the flow.
// Auto height back-fills from the consumed flow.
//
// The inline pass is what keeps a page's HEIGHT anywhere near a browser's: a label and its value, an
// icon and its text, a row of nav links are all inline, and stacking each on its own line made every
// page two to three times too tall — which then reported content as being below the fold when a
// browser has it in view.
// `cbW` is the CONTAINING BLOCK's content width — what a percentage padding, margin
// or border resolves against, never the box's own width. The two differ for anything
// with a margin or a declared size, and resolving against the wrong one gave a box
// one padding for its own size and a different one for where its children sit.
function layoutElement(el, box, ctx, cbW = box.width) {
  el._lb = box;
  // Remembered so a LATER read of this box's edges (`borderWidthsOf`, off the
  // geometry surface) resolves its percentages against the same width the layout
  // did, rather than against the box's own.
  el._lbCbW = cbW;
  el._lbOrder = ctx.order++;
  const disp = displayOf(el);
  // Children — flex items, grid items, table cells and block/inline flow alike —
  // live in the CONTENT box: this element's border box inset by its own borders
  // and padding.
  const edge = edgeInsets(el, cbW);
  const content = {
    x: box.x + edge.left,
    y: box.y + edge.top,
    width: Math.max(0, box.width - edge.left - edge.right),
    height: box.height ? Math.max(0, box.height - edge.top - edge.bottom) : 0
  };
  if (disp === 'grid' || disp === 'inline-grid') { layoutGrid(el, box, content, ctx); return; }
  if ((disp === 'flex' || disp === 'inline-flex') && !isColumnFlex(el)) { layoutFlexRow(el, box, content, ctx); return; }
  if (isTableDisplay(disp)) { layoutTable(el, box, content, ctx); return; }
  // Reached here, a row is an ORPHAN — a `display: table-row` with no table around
  // it, which a browser wraps in an anonymous table and we don't. Its cells at
  // least sit side by side rather than stacking, as they did before there was a
  // table pass at all (a table's own rows never come through here: `layoutTable`
  // places them itself).
  if (disp === 'table-row') { layoutFlexRow(el, box, content, ctx, { equalShare: true }); return; }

  const right = content.x + content.width;
  let flowY = content.y;      // top of the current line box / the next block
  let lineX = content.x;      // horizontal cursor within the current line
  let lineH = 0;              // tallest box on the current line (0 = the line is empty)
  let hadInFlow = false;
  // The bottom margin of the previous in-flow block, still "open" for collapsing
  // with the next block's top margin. CSS collapses ADJOINING vertical margins to
  // max(positives) + min(negatives) — so stacked cards sit one margin apart, and a
  // negative margin still pulls the next box up. Coarse: only the adjacent-sibling
  // case — parent/first-child and empty-block collapsing need the
  // block-formatting-context rules and stay out (documented deviation: a bare
  // `<div><p>text</p></div>` keeps the p's UA margin inside the div).
  let openMargin = null;   // null = nothing open (distinct from a real 0)
  const collapsed = (a, b) => Math.max(a > 0 ? a : 0, b > 0 ? b : 0) + Math.min(a < 0 ? a : 0, b < 0 ? b : 0);
  // An open bottom margin still occupies flow even when nothing follows it to
  // collapse with (a last child's margin grows its parent; inline content after a
  // block sits below that margin) — dropping it lost the space entirely.
  const flushMargin = () => {
    if (openMargin != null) { flowY += openMargin; openMargin = null; }
  };

  // Finish the current line, so a block-level box starts below it.
  const breakLine = () => {
    if (lineH === 0 && lineX === content.x) return;
    flowY += lineH || lineHeightOf(el);
    lineX = content.x;
    lineH = 0;
    hadInFlow = true;
  };
  // Reserve `w` x `h` on the current line, wrapping first if it doesn't fit; returns the origin.
  const placeOnLine = (w, h) => {
    // Inline content ends the block-margin adjacency: it sits BELOW a preceding
    // block's bottom margin rather than collapsing with it.
    flushMargin();
    if (lineX > content.x && lineX + w > right) { flowY += lineH || lineHeightOf(el); lineX = content.x; lineH = 0; }
    const at = { x: lineX, y: flowY };
    lineX += w;
    if (h > lineH) lineH = h;
    hadInFlow = true;
    return at;
  };

  for (const child of layoutChildren(el)) {
    // A text run shares the line with the inline boxes around it — that is what puts a link AFTER
    // the words before it rather than on a line of its own. Runs wider than the line wrap over as
    // many lines as they need (the line-count estimate the block case used to do on its own).
    if (child.nodeType === 3) {
      const t = child._data || child.data || '';
      // A run of pure white space between two inline boxes still occupies ONE
      // space (the classic inline-block gap) — dropping it put the next box
      // ~4px too far left. It contributes nothing at the start of a line.
      if (!/[^ \t\n\r\f]/.test(t)) {
        if (lineX > content.x && /[ \t\n\r\f]/.test(t)) { flushMargin(); placeOnLine(measureRun(' ', el), lineHeightOf(el)); }
        continue;
      }
      flushMargin();   // see placeOnLine: a text run also ends the adjacency
      const total = measureRun(collapseRun(t, el, lineX === content.x), el);
      const avail = content.width || 1;
      const used  = (lineX - content.x) + total;
      if (used > avail) {
        flowY += Math.floor(used / avail) * lineHeightOf(el);
        lineX  = content.x + (used % avail);
        lineH  = lineHeightOf(el);
        hadInFlow = true;
      } else {
        placeOnLine(total, lineHeightOf(el));
      }
      continue;
    }
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, flowY, ctx); continue; }

    if (isInlineLevel(child)) {
      // An inline box is as wide as its content (declared width or intrinsic size win) and one line
      // tall unless it says otherwise. Coarse: no baseline alignment, no half-leading.
      const ce   = edgeInsets(child, content.width);
      // An `inline-table` shrinks to fit like any table — and that figure is already
      // its whole border box; everything else inline is as wide as the text it holds,
      // plus its own edges.
      const isTable = isTableDisplay(displayOf(child));
      const autoInlineW = isTable
        ? shrinkToFitWidth(child, content.width)
        : Math.min(subtreeTextWidth(child), content.width) + ce.left + ce.right;
      // A non-replaced `display: inline` box is as tall as its font's CONTENT box
      // (ascent + descent), which is shorter than the line box the gap makes —
      // Chrome: a 16px inline span is 17 tall on an 18px line. `inline-block` is a
      // block container: it gets the full line box like any block.
      const cf   = fontOf(child);
      const pureInline = displayOf(child) === 'inline' && !intrinsicSize(child);
      const inlH = pureInline && cf && cf.table && cf.table.asc ? fontBoxHeight(cf, false) : lineHeightOf(child);
      // A table fills its own height from its rows, so it must arrive with an AUTO
      // one — handed a line box instead, it kept that and lost the border-spacing
      // below its last row.
      const size = usedSize(child, autoInlineW, isTable ? 0 : inlH + ce.top + ce.bottom,
                            content.width, content.height || null);
      const rel  = pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null;
      // A non-replaced `display: inline` box's padding/border grow its BORDER BOX but
      // not the line box (Chrome: a padded `<span>` measures 22 tall on a 15px line and
      // overflows it) — so the line advances by the line height, while the box keeps
      // its own. `inline-block` and replaced boxes DO size the line, as before.
      const lineContribution = displayOf(child) === 'inline' && !intrinsicSize(child)
        ? lineHeightOf(child)
        : size.height;
      const at   = placeOnLine(size.width, lineContribution);
      const cbox = {
        x: at.x + (rel ? rel.x : 0), y: at.y + (rel ? rel.y : 0),
        width: size.width, height: size.height
      };
      layoutElement(child, cbox, ctx, content.width);
      // A box that back-filled its own height (a table, from its rows) only knows it
      // now — the line grows to it as it would have to a declared height. A padded
      // `display: inline` box is the exception: its border box OVERFLOWS the line in
      // Chrome rather than stretching it, and it contributed `lineHeightOf` above.
      if (!pureInline && cbox.height > lineH) lineH = cbox.height;
      // An inline box WRAPS its inline content, which a text estimate can badly undersell: the
      // `<span>` ProseMirror puts around an image contains no text at all, so it measured 0 x one
      // line while holding a 500px image — two of them then sat 19px apart, overlapping, and a click
      // aimed at the first landed on the second. Grow whichever axis was auto to the content extent
      // and let the line follow.
      const ext = child._lbExtFlow;
      if (ext && (size.autoWidth || size.autoHeight)) {
        if (size.autoWidth) {
          // NOT rounded: the extent is measured in the same sub-pixel units the box
          // is, and rounding it UP grew every inline box whose text happened to end
          // on a fraction below .5 — a 25.77px word reported 26.
          const w = Math.max(cbox.width, ext.right - cbox.x);
          lineX += w - cbox.width;
          cbox.width = w;
        }
        // The line grows to the CONTENT extent, never to padding: a padded inline's
        // border box overflows its line box (Chrome), while an inline wrapping a tall
        // image really does make the line that tall — which is what this is for.
        // The extent already includes this box, so only a child that OVERFLOWS it
        // (the tall-image-in-a-span case this exists for) grows the box and the line.
        // Padding alone must not: a padded inline's border box overflows its line box
        // in Chrome rather than stretching it.
        const contentH = ext.bottom - cbox.y;
        if (size.autoHeight && contentH > cbox.height) {
          cbox.height = contentH;
          if (contentH > lineH) lineH = contentH;
        }
        stampExtent(child, cbox);
      }
      continue;
    }

    // In-flow block: fills the containing width unless explicitly sized, and starts below whatever
    // line was open.
    breakLine();
    // Margins inset the box horizontally and advance the flow vertically (collapsing
    // with the previous sibling's — see `collapsed` above).
    const cm = edgeInsets(child, content.width);
    const availW = Math.max(0, content.width - cm.ml - cm.mr);
    // A table is SHRINK-TO-FIT where a block fills: its auto width comes from its
    // own columns, not from the room it was offered.
    const autoW = isTableDisplay(displayOf(child)) ? shrinkToFitWidth(child, availW) : availW;
    const size = usedSize(child, autoW, 0, content.width, content.height || null);
    const rel  = pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null;
    // `flowY` sits at the previous border box's bottom; the gap to this one is the
    // COLLAPSED margin of the two adjoining ones, not their sum.
    flowY += openMargin == null ? cm.mt : collapsed(openMargin, cm.mt);
    layoutElement(child, { x: content.x + cm.ml + (rel ? rel.x : 0), y: flowY + (rel ? rel.y : 0), width: size.width, height: size.height }, ctx, content.width);
    if (size.autoHeight && child._lb.height === 0) child._lb.height = textHeight(child, child._lb.width) + cm.top + cm.bottom;
    flowY += child._lb.height;     // the flow advances by the box's height, not its shifted position
    openMargin = cm.mb;            // stays open for the next sibling to collapse with
    hadInFlow = true;
  }
  breakLine();
  flushMargin();   // a last child's bottom margin is part of what this block wraps
  // Auto height (a block with no explicit height) = the flow its in-flow children
  // consumed, plus this element's own padding + borders (the flow started at the
  // content-box top, so both edges have to come back).
  if (box.height === 0 && hadInFlow) box.height = (flowY - content.y) + edge.top + edge.bottom;
  stampExtent(el, box);
}

// The scrollable content extent, computed DURING layout instead of walked per read: every element
// gets the union of its own box and its children's extents. scrollWidth/scrollHeight are read
// constantly by editors and virtualised lists (a code editor measures on every keystroke), and a
// per-read subtree walk turns that into O(document) per call — the layout pass already visits every
// box exactly once, so the union is free here.
function stampExtent(el, box) {
  let right = box.x + box.width, bottom = box.y + box.height;
  // The same union restricted to IN-FLOW children. An out-of-flow box is not part of what its
  // parent wraps — a nav link holding an absolutely positioned dropdown is as wide as its own word,
  // not as wide as the menu — so the inline auto-grow measures this one instead.
  let fRight = right, fBottom = bottom;
  for (const child of layoutChildren(el)) {
    // Content that OVERFLOWS a clipping box is scrollable within it, not part of what its ancestors
    // wrap: only that box counts toward their scrollHeight (Chrome measured — a 200px
    // `overflow: auto` box holding 2400px of rows gives html/body/box `[681, 200, 2400]`). The FLOW
    // extent below is deliberately left alone: it sizes auto-height ancestors, and shrinking those
    // relaid the editor Avo's code field is built on into a loop.
    const ce = (child._lb && clipsContent(child))
      ? { right: child._lb.x + child._lb.width, bottom: child._lb.y + child._lb.height }
      : child._lbExt;
    if (!ce) continue;
    if (ce.right  > right)  right  = ce.right;
    if (ce.bottom > bottom) bottom = ce.bottom;
    if (child._lb && child._lb.outOfFlow) continue;
    const cf = child._lbExtFlow || ce;
    if (cf.right  > fRight)  fRight  = cf.right;
    if (cf.bottom > fBottom) fBottom = cf.bottom;
  }
  el._lbExt     = { right, bottom };
  el._lbExtFlow = { right: fRight, bottom: fBottom };
}

// A COARSE CSS-grid pass — enough for a simple uniform `repeat(N, …)` grid (Capybara's `spatial.erb`):
// equal columns, a single gap, fixed auto-row height, row-major auto-placement, and `grid-column:
// a / b` column spans. No fr-vs-fixed track sizing, no explicit row/column line placement, no
// alignment — those are later. `grid-column`-spanning items and out-of-flow items are handled.
function layoutGrid(el, box, content, ctx) {
  const cols = gridColumnCount(el);
  const gap  = gridGap(el);
  const declaredRowH = gridRowHeight(el);
  const colW = cols > 0 ? (content.width - (cols - 1) * gap) / cols : content.width;
  let col = 0;
  let rowTop = content.y;  // top of the row being filled — auto rows are as tall as their content,
  let rowH   = 0;          // so the next row can only start once this one's items are placed
  let bottom = content.y;
  const endRow = () => { rowTop += (declaredRowH != null ? declaredRowH : rowH) + gap; rowH = 0; col = 0; };
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, rowTop, ctx); continue; }
    const span = Math.max(1, Math.min(gridColumnSpan(child), cols));
    if (col + span > cols) endRow();                                 // wrap to the next row
    const cx = content.x + col * (colW + gap);
    // The track gives the item its width; its own declared height (or intrinsic
    // size) still wins over the row's auto height — a grid item with `height: 30px`
    // measured 0 before, and every auto-height ancestor collapsed with it.
    const trackW = span * colW + (span - 1) * gap;
    const size = usedSize(child, trackW, declaredRowH != null ? declaredRowH : 0, content.width, content.height || null);
    layoutElement(child, { x: cx, y: rowTop, width: trackW, height: size.height }, ctx, content.width);
    if (declaredRowH == null && child._lb.height === 0) child._lb.height = textHeight(child, child._lb.width);
    if (child._lb.height > rowH) rowH = child._lb.height;
    bottom = Math.max(bottom, rowTop + child._lb.height);
    col += span;
    if (col >= cols) endRow();
  }
  // Auto height back-fills from the placed rows — the same rule block flow follows. Without it a
  // grid container measures 0 while its items measure their row height, which is incoherent: a page
  // that divides by a container's height (Discourse's sidebar reorder decides insert-above from
  // `offsetY < rect.height / 2`) then takes the wrong branch, and every auto-height ancestor
  // collapses with it.
  if (box.height === 0) {
    const e = edgeInsets(el, box.width);
    box.height = (bottom - content.y) + e.top + e.bottom;
  }
  stampExtent(el, box);
}

const PX_RE = /(-?\d+(?:\.\d+)?)px/;
function gridColumnCount(el) {
  const t = declaredValue(el, 'grid-template-columns');
  if (!t) return 1;
  const s = String(t).trim();
  const rep = /^repeat\(\s*(\d+)\s*,/i.exec(s);
  if (rep) return parseInt(rep[1], 10);
  return s.split(/\s+/).filter(Boolean).length || 1;   // an explicit track list → one column each
}
function gridGap(el) {
  const g = declaredValue(el, 'gap') || declaredValue(el, 'grid-gap') || declaredValue(el, 'column-gap');
  const m = g && PX_RE.exec(String(g));
  return m ? parseFloat(m[1]) : 0;
}
// A declared `grid-auto-rows` length, else null: an AUTO row is as tall as its content, and
// pretending otherwise (this used to answer a flat 100px) inflated every grid on the page.
function gridRowHeight(el) {
  const r = declaredValue(el, 'grid-auto-rows');   // `minmax(100px, auto)` / `100px` → 100 (coarse)
  const m = r && PX_RE.exec(String(r));
  return m ? parseFloat(m[1]) : null;
}
function gridColumnSpan(el) {
  const c = declaredValue(el, 'grid-column');
  if (!c) return 1;
  const range = /(\d+)\s*\/\s*(\d+)/.exec(String(c));         // `1 / 4` → 3 columns
  if (range) return Math.max(1, parseInt(range[2], 10) - parseInt(range[1], 10));
  const span = /span\s+(\d+)/i.exec(String(c));               // `span 2`
  return span ? parseInt(span[1], 10) : 1;
}

// ── Intrinsic widths: min-content and max-content ────────────────────────────
// The two figures every content-based sizing decision is made from: `min` is the
// narrowest a box can be before its content overflows (the widest unbreakable
// unit), `max` the widest it would ever want (nothing wraps). Both are BORDER-box
// figures — the caller sizing a table column or a flex item wants the whole box.
//
// One resolver, because they are one concept: a table column and a flex item's
// automatic minimum were each reaching for their own approximation of "how narrow
// can this get", and only the flex one measured anything.
function intrinsicWidths(el) {
  if (el._lbIwPass === layoutPass) return el._lbIw;
  // Marked BEFORE recursing: a slot assigned its own ancestor would otherwise spin.
  el._lbIwPass = layoutPass;
  el._lbIw = ZERO_WIDTHS;
  // NO percentage basis, deliberately: an intrinsic size is what a box wants
  // BEFORE anyone has decided how much room it gets, so a percentage has nothing
  // to resolve against and behaves as `auto` (CSS Sizing 3). Passing the room it
  // might get instead is how `width: 100%` on a cell's wrapper became a pinned 0
  // and collapsed the column around it.
  const e = edgeInsets(el, null);
  const extra = e.left + e.right;
  const declared = resolveLayoutProp(el, 'width', null);
  const intrinsic = intrinsicSize(el);
  let inner;
  if (declared != null) {
    // A declared width pins BOTH figures — the box neither shrinks below it nor
    // wants more (`box-sizing` decides whether the edges are already inside it).
    const w = Math.max(0, isBorderBox(el) ? declared - extra : declared);
    inner = { min: w, max: w };
  } else if (intrinsic) {
    inner = { min: intrinsic.width, max: intrinsic.width };
  } else if (isTableDisplay(displayOf(el))) {
    // A table brings its own algorithm for the same question, and its rows are not
    // blocks to be measured one at a time — measured that way a nested table came
    // out as wide as its widest single CELL instead of the sum of its columns. That
    // answer is already a border-box figure, so it stands as it is.
    el._lbIw = tableIntrinsicWidths(el);
    return el._lbIw;
  } else {
    inner = contentIntrinsicWidths(el);
  }
  el._lbIw = { min: inner.min + extra, max: inner.max + extra };
  return el._lbIw;
}
const ZERO_WIDTHS = { min: 0, max: 0 };
// `white-space` values that never wrap: their min-content IS their max-content.
const NON_WRAPPING_WS = new globalThis.Set(['pre', 'nowrap']);

// The same two figures for what `el` CONTAINS. Text runs and inline boxes share a
// line — their max-content sums along it, their min-content is the widest single
// word — while a block child breaks the line and contributes its own outer width
// to both.
function contentIntrinsicWidths(el) {
  if (el._lbCiwPass === layoutPass) return el._lbCiw;
  el._lbCiwPass = layoutPass;
  el._lbCiw = ZERO_WIDTHS;
  let min = 0, max = 0, line = 0;
  const endLine = () => { if (line > max) max = line; line = 0; };
  const widest = (w) => { if (w > min) min = w; };
  for (const child of layoutChildren(el)) {
    if (child.nodeType === 3 /* text */) {
      const t = child._data || child.data || '';
      if (!/\S/.test(t)) { if (line > 0) line += measureRun(' ', el); continue; }
      const run = collapseRun(t, el, false);
      line += measureRun(run, el);
      widest(longestWordWidth(run, el));
      continue;
    }
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') continue;   // out of flow: sizes nothing
    const w = intrinsicWidths(child);
    if (isInlineLevel(child)) { line += w.max; widest(w.min); continue; }
    endLine();
    if (w.max > max) max = w.max;
    widest(w.min);
  }
  endLine();
  if (NON_WRAPPING_WS.has(whiteSpaceOf(el))) min = max;
  el._lbCiw = { min, max };
  return el._lbCiw;
}

// ── Tables ───────────────────────────────────────────────────────────────────
// Real auto table layout, because a table's geometry falls out of no other
// formatting context: a column is as wide as the widest cell IN THAT COLUMN across
// EVERY row, and the table itself is shrink-to-fit rather than filling its
// container. Laying each row out as an equal-share flex row (what this did before)
// got both wrong — every column the same width whatever it held, and the table
// always as wide as the page — so a Redmine issue list or a Discourse admin table
// reported cell geometry that shared nothing with a browser's.
//
// The column algorithm is CSS Tables 3 §"Distributing width to columns", which is
// what Chrome implements; `spec/layout_table_spec.rb` pins it to Chrome-measured
// figures, sub-pixel.
//
// Deliberately coarse, each documented where it bites: a missing ROW is generated
// (see `tableGrid`) but a missing CELL is not, so a stray non-cell child of a real
// `<tr>` is skipped rather than wrapped in an anonymous cell; no `vertical-align`
// inside a cell (content sits at the top of a taller row) and no baseline alignment
// between cells; `direction: rtl` does not reverse the columns; and a collapsed
// border is resolved between a cell and its own FACING side only (see `edgeInsets`),
// never against the table's border or a row's — so a table that borders itself more
// heavily than its cells is out by half the difference at each outer edge, and the
// last row keeps a bottom half-border a browser drops. Both are CONSTANT: the
// per-row error that left a 20-row list 10px short is gone.
const ROW_GROUP_DISPLAY = new globalThis.Set(['table-row-group', 'table-header-group', 'table-footer-group']);
function isTableDisplay(d) { return d === 'table' || d === 'inline-table'; }

// Both properties INHERIT, and both have a UA value keyed on the `table` TAG that
// outranks what a wrapper hands down — so they are read through style-proxy's
// resolver, the one getComputedStyle uses, rather than through a walk of our own.
// (Chrome-verified: a `<table>` inside `div { border-spacing: 10px }` still spaces
// at 2px, while a `display: table` div inherits the 10px.)
function tableCollapses(el) {
  return computedBorderCollapse(el) === 'collapse';
}
// `border-spacing: <horizontal> [<vertical>]`, and zero when the borders collapse.
function borderSpacingOf(el) {
  if (tableCollapses(el)) return ZERO_SPACING;
  const raw = computedBorderSpacing(el);
  if (!raw) return ZERO_SPACING;
  const parts = String(raw).trim().split(/\s+/);
  const x = lengthPx(el, parts[0]) || 0;
  const y = parts.length > 1 ? lengthPx(el, parts[1]) || 0 : x;
  return { x, y };
}
const ZERO_SPACING = { x: 0, y: 0 };
// One length, in px — the raw-value counterpart of `resolveLayoutProp`, for values
// that arrive as part of a multi-value property rather than under a name of their own.
function lengthPx(el, text) {
  if (text == null) return null;
  const s = String(text).trim();
  const m = /^(-?\d*\.?\d+)px$/.exec(s);
  if (m) return parseFloat(m[1]);
  if (/^-?0$/.test(s)) return 0;
  return fontRelativeToPx(el, s, false);
}

// A cell's border is SHARED with its neighbour when the table collapses them: each
// side owns half of it, and the outer half at the table's edge belongs to the
// table's own box (see `collapseOuter`). Chrome-measured: a 1px-bordered cell
// holding "A" is 14.56 wide — content + padding + 0.5 + 0.5, not + 1 + 1.
// Memoised: `edgeInsets` asks for every cell of every table, and the answer costs an
// ancestor walk.
function halvesBorders(el) {
  if (el._lbHalvePass === layoutPass) return el._lbHalve;
  el._lbHalvePass = layoutPass;
  el._lbHalve = displayOf(el) === 'table-cell' && tableCollapses(el);
  return el._lbHalve;
}

// The cell grid: rows in RENDER order (a header group first and a footer group last,
// whatever the source says — Chrome), each cell at the first column its row still has
// free, so a `rowspan` from an earlier row pushes the cells beside it right.
function tableGrid(table) {
  if (table._lbGridPass === layoutPass) return table._lbGrid;
  const rows = [], groups = [], captions = [], columns = [], outOfFlow = [];
  const collect = (parent, group) => {
    let anon = null;
    for (const child of layoutChildren(parent)) {
      if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
      // An out-of-flow child of a table or a row is positioned against its containing
      // block like any other and generates no table box at all (Chrome-verified on a
      // `display: table` holding an absolutely positioned overlay). Skipping it left
      // the box unstamped and unhittable.
      const p = positionOf(child);
      if (p === 'absolute' || p === 'fixed') { outOfFlow.push({ el: child, pos: p }); continue; }
      const d = displayOf(child);
      if (d === 'table-row') { anon = null; rows.push({ el: child, group, cells: [], nodes: null }); continue; }
      if (ROW_GROUP_DISPLAY.has(d)) {
        anon = null;
        const g = { el: child, first: -1, last: -1 };
        groups.push(g);
        collect(child, g);
        continue;
      }
      if (d === 'table-caption') { captions.push(child); continue; }
      if (d === 'table-column') { columns.push(child); continue; }
      // A `<colgroup>` with no `<col>` children is one column definition itself.
      if (d === 'table-column-group') {
        const cols = layoutChildren(child).filter((c) => c.nodeType === NODE_ELEMENT && displayOf(c) === 'table-column');
        if (cols.length) for (const c of cols) columns.push(c);
        else columns.push(child);
        continue;
      }
      // Everything else falls into an ANONYMOUS ROW (CSS 2.1 §17.2.1), one per run of
      // consecutive such children. `display: table` + `display: table-cell` with no row
      // between them is the everyday "table for layout" idiom; without this the table
      // had no rows at all and reported a 0x0 box.
      if (!anon) { anon = { el: null, group, cells: [], nodes: [] }; rows.push(anon); }
      anon.nodes.push(child);
    }
  };
  collect(table, null);

  // Render order: header groups, then bodies (and ungrouped rows), then footers.
  // `sort` is stable, so everything keeps its source order within its band.
  rows.sort((x, y) => rowGroupRank(x) - rowGroupRank(y));
  for (const g of groups) {
    g.first = rows.findIndex((row) => row.group === g);
    for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].group === g) { g.last = i; break; } }
  }

  // Column COUNT comes from the cells that span a single column (plus any `<col>`);
  // a wider `colspan` is clamped to the columns that exist rather than inventing
  // them — Chrome: `colspan="5"` across a two-column table gives two columns, and a
  // table whose only row is a `colspan="3"` gives one.
  let colDefs = 0;
  for (const col of columns) colDefs += spanAttr(col, 'span');
  const spanned = placeCells(rows, Infinity, outOfFlow);
  let count = colDefs;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.colSpan === 1 && cell.col + 1 > count) count = cell.col + 1;
    }
  }
  const colCount = Math.max(count, rows.some((row) => row.cells.length) ? 1 : 0);
  // The second pass exists only to clamp spans, so a table without any is already
  // placed — which is nearly every table, and this is a per-cell walk.
  if (spanned) placeCells(rows, colCount, null);

  table._lbGrid = { rows, groups, captions, columns, outOfFlow, colCount };
  table._lbGridPass = layoutPass;
  return table._lbGrid;
}
function rowGroupRank(row) {
  const d = row.group ? displayOf(row.group.el) : 'table-row-group';
  return d === 'table-header-group' ? 0 : d === 'table-footer-group' ? 2 : 1;
}
// Assign every cell its column, with `colspan` capped at `limit` columns in total.
// Run twice: once uncapped to learn how many columns the table has, then again to
// place the cells within them — `outOfFlow` collects on the first run only.
function placeCells(rows, limit, outOfFlow) {
  const taken = [];
  let spanned = false;
  rows.forEach((row, r) => {
    row.cells.length = 0;
    let c = 0;
    for (const child of (row.nodes || layoutChildren(row.el))) {
      if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
      const pos = positionOf(child);
      // An out-of-flow child of a ROW is positioned against its containing block and
      // generates no cell, exactly as one of the table itself is.
      if (pos === 'absolute' || pos === 'fixed') {
        if (outOfFlow) outOfFlow.push({ el: child, pos });
        continue;
      }
      // In a real row only a cell counts (a stray child is what a browser wraps in an
      // anonymous cell and we don't); in an anonymous row every child IS the content.
      if (!row.nodes && displayOf(child) !== 'table-cell') continue;
      while (taken[r] && taken[r].has(c)) c++;
      const colSpan = Math.max(1, Math.min(spanAttr(child, 'colspan'), limit - c));
      // A `rowspan` reaches to the end of its ROW GROUP and no further, and
      // `rowspan="0"` means exactly that far (Chrome: a span in one `<tbody>` does not
      // reach into the next).
      const lastRow = row.group && row.group.last >= 0 ? row.group.last : rows.length - 1;
      const room = Math.max(1, lastRow - r + 1);
      const declaredRowSpan = spanAttr(child, 'rowspan', 0);
      const rowSpan = declaredRowSpan === 0 ? room : Math.min(declaredRowSpan, room);
      if (colSpan > 1 || rowSpan > 1) spanned = true;
      row.cells.push({ el: child, col: c, colSpan, rowSpan, row: r });
      for (let dr = 0; dr < rowSpan; dr++) {
        const at = taken[r + dr] || (taken[r + dr] = new globalThis.Set());
        for (let dc = 0; dc < colSpan; dc++) at.add(c + dc);
      }
      c += colSpan;
    }
  });
  return spanned;
}
// A `colspan` / `rowspan` / `<col span>` count. `min` is 1 everywhere except
// `rowspan`, whose 0 is meaningful ("every remaining row in the group") — and a 0
// anywhere else would divide the column loops by nothing.
function spanAttr(el, name, min = 1) {
  const raw = el._attrs && el._attrs[name];
  if (raw == null) return min > 0 ? min : 1;
  const n = parseInt(String(raw), 10);
  if (!isFinite(n) || n < 0) return min > 0 ? min : 1;
  return Math.min(Math.max(n, min), 1000);
}

// Each column's min/max content width: the widest its cells need, and the widest
// they want. A cell that SPANS columns only has to fit across the ones it covers,
// so it contributes whatever they are still short of.
function tableColumns(table, grid, spacingX) {
  if (table._lbColsPass === layoutPass) return table._lbCols;
  const n = grid.colCount;
  const min = new Array(n).fill(0), max = new Array(n).fill(0);
  // `spec` is the width a column was GIVEN and `pct` the fraction it was given, 0
  // for neither. Either makes the column "constrained" in CSS Tables 3's sense, and
  // a constrained column takes no part in sharing out space beyond max-content — a
  // `<td width="100">` stays 100 in a table twice that wide while its auto
  // neighbour takes everything left.
  const spec = new Array(n).fill(0), pct = new Array(n).fill(0);
  const spans = [];
  // `declared` is the width the CELL was given, already resolved into a whole-box
  // figure by `intrinsicWidths` (which pins min == max for it); `outer` is that
  // figure. A `<col>` names the COLUMN instead, so it carries no padding of its own.
  const constrain = (i, el, outer) => {
    // ONE cascade read on the hot path: most cells declare no width at all, and a
    // `declaredValue` miss ends it before any parsing happens.
    const raw = declaredValue(el, 'width');
    if (raw == null) return;
    const p = /^\s*(-?\d*\.?\d+)%\s*$/.exec(String(raw));
    if (p) { const f = parseFloat(p[1]) / 100; if (f > pct[i]) pct[i] = f; return; }
    const w = outer !== undefined ? outer : resolveLayoutProp(el, 'width', null);
    if (w != null && w > spec[i]) spec[i] = w;
  };
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      const w = intrinsicWidths(cell.el);
      if (cell.colSpan > 1) { spans.push({ cell, w }); continue; }
      if (w.min > min[cell.col]) min[cell.col] = w.min;
      if (w.max > max[cell.col]) max[cell.col] = w.max;
      constrain(cell.col, cell.el, w.max);
    }
  }
  let ci = 0;
  for (const col of grid.columns) {
    const span = spanAttr(col, 'span');
    for (let i = 0; i < span && ci + i < n; i++) constrain(ci + i, col);
    ci += span;
  }
  for (const { cell, w } of spans) {
    const inner = (cell.colSpan - 1) * spacingX;   // the spacing a span covers is width it doesn't need
    distributeSpan(min, cell.col, cell.colSpan, w.min - inner);
    distributeSpan(max, cell.col, cell.colSpan, w.max - inner);
  }
  table._lbCols = { min, max, spec, pct };
  table._lbColsPass = layoutPass;
  return table._lbCols;
}
// Share a spanning cell's shortfall over the columns it covers, in proportion to
// what they already want (equally when they want nothing at all).
function distributeSpan(widths, start, span, required) {
  const end = Math.min(start + span, widths.length);
  let total = 0;
  for (let i = start; i < end; i++) total += widths[i];
  const deficit = required - total;
  if (deficit <= 0 || end <= start) return;
  for (let i = start; i < end; i++) {
    widths[i] += total > 0 ? deficit * (widths[i] / total) : deficit / (end - start);
  }
}

// CSS Tables 3 §"Distributing width to columns" — a ladder of guesses, each a wider
// table than the last, with the assignable width interpolated between whichever two
// it falls between:
//
//   min-content       every column at its minimum (below this the table overflows)
//   specified-width   …and the columns GIVEN a width or a percentage raised to it
//   max-content       …and every remaining column raised to its maximum
//   beyond            the surplus shared over the columns that were given neither
//
// Chrome-exact on every branch (`spec/layout_table_spec.rb`).
function distributeColumns(cols, assignable) {
  const n = cols.min.length;
  if (!n) return [];
  const minSum = sumOf(cols.min);
  if (assignable <= minSum) return cols.min.slice();
  // A percentage column is only now resolvable: its basis is the width being shared
  // out, not the table's own box (Chrome: `width: 25%` of a 400px table is 98.5 —
  // a quarter of the 394 left after border-spacing).
  const specified = cols.min.map((m, i) => Math.max(m, cols.spec[i], cols.pct[i] * assignable));
  const maxes = cols.max.map((m, i) => Math.max(m, specified[i]));
  const specSum = sumOf(specified), maxSum = sumOf(maxes);
  if (assignable <= specSum) {
    const ratio = (assignable - minSum) / (specSum - minSum);
    return cols.min.map((m, i) => m + (specified[i] - m) * ratio);
  }
  if (assignable <= maxSum) {
    const ratio = (assignable - specSum) / (maxSum - specSum);
    return specified.map((w, i) => w + (maxes[i] - w) * ratio);
  }
  const surplus = assignable - maxSum;
  const growable = maxes.map((m, i) => (cols.spec[i] > 0 || cols.pct[i] > 0 ? 0 : m));
  const basis = sumOf(growable);
  if (basis > 0)  return maxes.map((m, i) => m + surplus * (growable[i] / basis));
  if (maxSum > 0) return maxes.map((m) => m + surplus * (m / maxSum));
  return maxes.map(() => assignable / n);
}
function sumOf(xs) { let t = 0; for (const x of xs) t += x; return t; }

// `table-layout: fixed` sizes columns from the first row ALONE — a `<col width>`,
// then a first-row cell's declared width — and shares whatever is left equally
// among the columns that named nothing. Content never enters into it, which is the
// whole point: the browser lays the table out without measuring any of it, and a
// cell's text wraps to the column instead of the column growing to the text.
function fixedColumnWidths(table, grid, assignable) {
  const n = grid.colCount;
  const widths = new Array(n).fill(null);
  let ci = 0;
  for (const col of grid.columns) {
    const span = spanAttr(col, 'span');
    const w = resolveLayoutProp(col, 'width', assignable);
    if (w != null) for (let i = 0; i < span && ci + i < n; i++) widths[ci + i] = w;
    ci += span;
  }
  for (const cell of (grid.rows[0] ? grid.rows[0].cells : [])) {
    if (resolveLayoutProp(cell.el, 'width', assignable) == null) continue;
    // The declaration is the CONTENT box unless `box-sizing` says otherwise, and the
    // column holds the whole cell — `intrinsicWidths` already resolves both.
    const each = intrinsicWidths(cell.el, assignable).max / cell.colSpan;
    for (let i = 0; i < cell.colSpan && cell.col + i < n; i++) {
      if (widths[cell.col + i] == null) widths[cell.col + i] = each;
    }
  }
  let used = 0, autos = 0;
  for (const w of widths) { if (w == null) autos++; else used += w; }
  const share = autos > 0 ? Math.max(0, assignable - used) / autos : 0;
  return widths.map((w) => (w == null ? share : w));
}
// Fixed layout needs a width to distribute; with `width: auto` there is nothing to
// hand out and a browser falls back to sizing the table from its content.
function usesFixedLayout(table, available) {
  return String(declaredValue(table, 'table-layout') || '').trim().toLowerCase() === 'fixed' &&
         resolveLayoutProp(table, 'width', available) != null;
}

// Everything between and around the columns: the border-spacing gaps, plus (when
// the borders collapse) the outer halves of the edge cells' borders, which fall
// outside those cells and inside the table's own box.
function tableFrame(table, grid, sp) {
  const outer = collapseOuter(table, grid);
  const gaps = grid.colCount ? (grid.colCount + 1) * sp.x : 0;
  return { outer, width: gaps + outer.left + outer.right };
}
const NO_OUTER = { left: 0, right: 0, top: 0, bottom: 0 };
function collapseOuter(table, grid) {
  if (!tableCollapses(table)) return NO_OUTER;
  const out = { left: 0, right: 0, top: 0, bottom: 0 };
  const lastRow = grid.rows.length - 1, lastCol = grid.colCount - 1;
  grid.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const e = edgeInsets(cell.el, null);   // already halved — the other half is this
      if (cell.col === 0) out.left = Math.max(out.left, e.bl);
      if (cell.col + cell.colSpan - 1 >= lastCol) out.right = Math.max(out.right, e.br);
      if (r === 0) out.top = Math.max(out.top, e.bt);
      if (r + cell.rowSpan - 1 >= lastRow) out.bottom = Math.max(out.bottom, e.bb);
    }
  });
  return out;
}

// CSS 2.1 §10.3.7's shrink-to-fit — as wide as the content wants, capped by the
// room available and floored at the narrowest that content can be. ONE formula for
// every content-sized box: an out-of-flow one, an inline-level one, and a table
// (whose own column algorithm is what answers `intrinsicWidths`).
function shrinkToFitWidth(el, available) {
  const w = intrinsicWidths(el);
  return Math.min(Math.max(w.min, available), w.max);
}

// A table's intrinsic widths are its COLUMNS' — plus everything between and around
// them and its own padding and borders. `shrinkToFitWidth` turns those into a used
// width, so a table shrinks to fit wherever any other content-sized box does, and
// never takes the full containing width a block would.
//
// A CAPTION does not widen the table to its own max-content (Chrome: a caption far
// wider than the only column wraps to that column instead), but the table is never
// narrower than the caption's MIN-content — one unbreakable word still pushes it out.
function tableIntrinsicWidths(table) {
  const grid = tableGrid(table);
  const sp = borderSpacingOf(table);
  const cols = tableColumns(table, grid, sp.x);
  const edge = edgeInsets(table, null);
  const frame = tableFrame(table, grid, sp).width + edge.left + edge.right;
  let floor = 0;
  for (const caption of grid.captions) {
    const c = intrinsicWidths(caption).min + edge.left + edge.right;
    if (c > floor) floor = c;
  }
  return { min: Math.max(sumOf(cols.min) + frame, floor), max: Math.max(sumOf(cols.max) + frame, floor) };
}

function layoutTable(el, box, content, ctx) {
  const grid = tableGrid(el);
  const sp = borderSpacingOf(el);
  const frame = tableFrame(el, grid, sp);
  const assignable = Math.max(0, content.width - frame.width);
  const widths = usesFixedLayout(el, content.width)
    ? fixedColumnWidths(el, grid, assignable)
    : distributeColumns(tableColumns(el, grid, sp.x), assignable);
  // A table is never narrower than its own content: told to be 200px while holding a
  // 400px block, it grows (Chrome: 406) rather than letting its cells overflow the
  // box that is supposed to contain them.
  const need = sumOf(widths) + frame.width;
  if (need > content.width) {
    box.width = need + (box.width - content.width);
    content.width = need;
  }

  // Captions sit above the rows, or below them for `caption-side: bottom` — and
  // either way INSIDE what `<table>.getBoundingClientRect()` reports.
  const above = [], below = [];
  for (const caption of grid.captions) (captionAtBottom(caption) ? below : above).push(caption);
  let y = content.y;
  const layCaption = (caption) => {
    const capBox = { x: content.x, y, width: content.width, height: 0 };
    layoutElement(caption, capBox, ctx, content.width);
    y += capBox.height;
  };
  for (const caption of above) layCaption(caption);

  const gridTop = y;
  const hasGrid = grid.rows.length > 0 && grid.colCount > 0;
  if (hasGrid) y += sp.y + frame.outer.top;

  const colX = [];
  let x = content.x + sp.x + frame.outer.left;
  for (const w of widths) { colX.push(x); x += w + sp.x; }
  const rowX = colX.length ? colX[0] : content.x;
  const rowW = colX.length ? (colX[colX.length - 1] + widths[widths.length - 1]) - rowX : content.width;

  // A row group's box wraps the rows it holds, so it has to paint UNDER them.
  for (const g of grid.groups) g.el._lbOrder = ctx.order++;

  const rowTops = new Array(grid.rows.length).fill(y);
  const rowHeights = new Array(grid.rows.length).fill(0);
  // Rowspan cells, indexed by the LAST row each one touches: that is the row that
  // has to absorb whatever the ones above came up short of, and indexing means a
  // table of N rowspans doesn't rescan them all N times.
  const spanning = [], endingAt = [], placed = [];
  if (hasGrid) grid.rows.forEach((row, r) => {
    rowTops[r] = y;
    if (row.el) row.el._lbOrder = ctx.order++;
    // A declared row height is a MINIMUM: the row still grows for a taller cell.
    let rowH = row.el ? resolveLayoutProp(row.el, 'height', null) || 0 : 0;
    for (const cell of row.cells) {
      const cw = cellSpanWidth(colX, widths, cell);
      // The column decides the cell's width whatever the cell declared (that
      // declaration already spoke, when the column was sized). Its HEIGHT is its own,
      // and auto height back-fills from its content like any block's.
      const size = usedSize(cell.el, cw, 0, content.width, null);
      const cbox = { x: colX[cell.col], y, width: cw, height: size.height };
      layoutElement(cell.el, cbox, ctx, content.width);
      const span = { cell, box: cbox, startRow: r };
      placed.push(span);
      if (cell.rowSpan === 1) { if (cbox.height > rowH) rowH = cbox.height; continue; }
      spanning.push(span);
      const end = Math.min(r + cell.rowSpan - 1, grid.rows.length - 1);
      (endingAt[end] || (endingAt[end] = [])).push(span);
    }
    // A spanning cell that ENDS on this row still has to fit inside the table:
    // whatever the rows it covers are short of grows this one, the last it touches.
    for (const s of (endingAt[r] || EMPTY_SPANS)) {
      let have = 0;
      for (let i = s.startRow; i < r; i++) have += rowHeights[i] + sp.y;
      const need2 = s.box.height - have;
      if (need2 > rowH) rowH = need2;
    }
    rowHeights[r] = rowH;
    y += rowH + sp.y;
  });

  // A declared table height taller than the grid is shared out over the rows
  // (Chrome: two rows in a 200px table are 97 each) — a click aimed at the visible
  // bottom of a cell has to land inside it. Row positions move, so this happens
  // before any of them is stamped.
  if (box.height > 0 && hasGrid) {
    const edge = edgeInsets(el, box.width);
    const room = box.height - edge.top - edge.bottom - (frame.outer.bottom + y - content.y);
    if (room > 0) {
      const each = room / grid.rows.length;
      let shift = 0;
      for (let i = 0; i < rowHeights.length; i++) {
        rowTops[i] += shift;
        rowHeights[i] += each;
        shift += each;
      }
      y += room;
    }
  }

  // Every row's height and top are final: place the rows, and give each cell the
  // rows it covers. A cell is as tall as its row — that box, not its content's, is
  // what a click has to land in.
  for (const s of placed) {
    const end = Math.min(s.startRow + s.cell.rowSpan - 1, rowHeights.length - 1);
    let h = 0;
    for (let i = s.startRow; i <= end; i++) h += rowHeights[i] + (i > s.startRow ? sp.y : 0);
    const dy = rowTops[s.startRow] - s.box.y;
    if (dy) shiftSubtreeY(s.cell.el, dy);
    if (h > 0 && h !== s.box.height) { s.box.height = h; stampExtent(s.cell.el, s.box); }
  }
  grid.rows.forEach((row, r) => {
    if (!row.el) return;                 // an anonymous row has no box of its own
    row.el._lb = { x: rowX, y: rowTops[r], width: rowW, height: rowHeights[r] };
    stampExtent(row.el, row.el._lb);
  });
  for (const g of grid.groups) {
    const has = g.first >= 0 && g.first <= g.last && g.last < rowHeights.length;
    const top = has ? rowTops[g.first] : y;
    g.el._lb = { x: rowX, y: top, width: rowW, height: has ? (rowTops[g.last] + rowHeights[g.last]) - top : 0 };
    stampExtent(g.el, g.el._lb);
  }

  if (hasGrid) y += frame.outer.bottom;   // `y` already carries the last row's spacing
  for (const caption of below) layCaption(caption);
  // Out-of-flow children are placed after the grid, so their static position is the
  // flow they would have joined; none of them advances it.
  for (const { el: child, pos } of grid.outOfFlow) placeAbsolute(child, pos, gridTop, ctx);
  // The table's own padding and borders come back on top of the grid, as for any
  // auto-height block. A caption counts even with no rows under it (Chrome: a
  // caption-only table is exactly as tall as its caption).
  if (box.height === 0) {
    const edge = edgeInsets(el, box.width);
    box.height = Math.max(0, y - content.y) + edge.top + edge.bottom;
  }
  stampExtent(el, box);
}
// `caption-side` inherits and applies to the caption itself.
function captionAtBottom(caption) {
  for (let cur = caption, i = 0; cur && cur.nodeType === NODE_ELEMENT && i < 64; cur = cur._parent, i++) {
    const v = declaredValue(cur, 'caption-side');
    if (v == null) continue;
    const t = String(v).trim().toLowerCase();
    if (t && t !== 'inherit') return t === 'bottom';
  }
  return false;
}
const EMPTY_SPANS = [];
// A cell reaches from its first column's left edge to its last one's right — which
// is how it swallows the border-spacing between them.
function cellSpanWidth(colX, widths, cell) {
  const last = Math.min(cell.col + cell.colSpan, widths.length) - 1;
  if (last < cell.col || cell.col >= colX.length) return 0;
  return (colX[last] + widths[last]) - colX[cell.col];
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

// ── Text advance widths ──────────────────────────────────────────────────────
// A run's width is the sum of its characters' ADVANCE widths in the element's font,
// scaled by the used font size. The per-character table comes from the font file's
// own `hmtx` (host side: `font_advance_table`), so nothing is rasterised: one host
// call per (family, weight/style) for the whole table, then a few lookups per run.
// Against Chrome the sum lands within ~6% median where the flat 8px/char estimate
// this replaces was ~19% off and up to 177% on narrow or wide strings ("iiii" /
// "WWWW"). Falls back to that estimate when fontconfig can't resolve the family.
const FONT_TABLES = new globalThis.Map();

function advanceTableFor(family, weightStyle) {
  const key = family + ' ' + weightStyle;
  if (FONT_TABLES.has(key)) return FONT_TABLES.get(key);
  let t = null;
  try {
    t = globalThis.__csim_fontAdvances ? globalThis.__csim_fontAdvances(family, weightStyle) : null;
  } catch (_) { t = null; }
  FONT_TABLES.set(key, t);
  return t;
}

// The element's font as the table key + the size to scale by. Memoised per pass,
// and inherited from the parent when the element declares no font of its own —
// the same shortcut lineHeightOf takes, and for the same reason (both resolvers
// walk to the root otherwise).
function fontOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  if (el._lbFontPass === layoutPass) return el._lbFont;
  const parent = el._parent;
  if (inheritsFont(el) && parent && parent.nodeType === NODE_ELEMENT) {
    el._lbFont = fontOf(parent);
  } else {
    const family = computedFontFamily(el);
    const weight = computedFontWeight(el);
    const st     = computedFontStyle(el);
    const italic = st === 'italic' || st === 'oblique';
    const ws = (weight >= 600 ? 'bold' : '') + (italic ? (weight >= 600 ? ':italic' : 'italic') : '');
    const table = advanceTableFor(family, ws);
    el._lbFont = { table, size: computedFontSizePx(el) || 16 };
  }
  el._lbFontPass = layoutPass;
  return el._lbFont;
}

// True when `el` neither declares a font of its own nor gets one from the UA
// stylesheet — its font, and therefore its line box, are exactly its parent's.
// Memoised per pass and shared by fontOf / lineHeightOf: the two used to run four
// and two cascade lookups per element respectively (measured +27% on a text-heavy
// relayout, all of it here).
function inheritsFont(el) {
  if (el._lbInhPass === layoutPass) return el._lbInh;
  el._lbInh = !declaresOwnFont(el);
  el._lbInhPass = layoutPass;
  return el._lbInh;
}

// The font's content-box height (ascent + descent) at this size, plus the line gap
// when `withGap` — each metric rounded to whole px first, as browsers do.
function fontBoxHeight(f, withGap) {
  const t = f.table;
  const h = Math.round(t.asc * f.size) + Math.round(t.desc * f.size);
  return withGap ? h + Math.round((t.gap || 0) * f.size) : h;
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
  if (!el || el.nodeType !== NODE_ELEMENT) return '';
  if (el._lbWsPass === layoutPass) return el._lbWs;
  const own = declaredValue(el, 'white-space');
  const parent = el._parent;
  el._lbWs = own != null && String(own).trim() !== ''
    ? String(own).trim().toLowerCase()
    : (parent && parent.nodeType === NODE_ELEMENT ? whiteSpaceOf(parent) : '');
  el._lbWsPass = layoutPass;
  return el._lbWs;
}
function collapseRun(text, el, atLineStart) {
  const mode = whiteSpaceOf(el);
  if (PRESERVING_WS.has(mode)) return text.replace(/[\n\r]/g, '');
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
function measureRun(text, el) {
  const f = fontOf(el);
  if (!f || !f.table) return text.length * AVG_CHAR_PX;
  const adv = f.table.adv, avg = f.table.avg;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const a = adv[ch];
    if (a !== undefined) { units += a; continue; }
    // Outside the table: CJK / fullwidth / Hangul glyphs are FULL-WIDTH (~1em) in
    // every font that has them, so charging them the Latin mean (~0.5em) halved
    // every Japanese line. Astral characters (emoji) arrive as a surrogate PAIR —
    // count the pair once, also full-width.
    const cp = text.codePointAt(i);
    if (cp === 0x00A0) { units += adv[' '] !== undefined ? adv[' '] : avg; continue; }   // NBSP is a space
    if (cp > 0xFFFF) { units += 1; i++; continue; }
    units += isWideChar(cp) ? 1 : avg;
  }
  return units * f.size;
}

// Coarse fallback for callers that only know a character COUNT (no string in hand).
function textWidth(len) { return len * AVG_CHAR_PX; }

// The total width of the text in `el`'s whole subtree, laid out on ONE line: an inline box is as
// wide as the text inside it, however deeply that text is nested (`<a><span>label</span></a>`).
// `contentIntrinsicWidths` is the richer measure — it knows where a block child breaks the line —
// and this is the flat sum the inline path wants.
function subtreeTextWidth(el) {
  if (el._lbTextPass === layoutPass) return el._lbText;
  el._lbTextPass = layoutPass;
  el._lbText = 0;
  let width = 0;
  for (const c of layoutChildren(el)) {
    if (c.nodeType === 3) {
      const t = c._data || c.data || '';
      if (!/\S/.test(t)) continue;
      // Each run is measured in the font of the element that CONTAINS it (a `<b>`
      // or a smaller `<small>` counts at its own size) under the same white-space
      // model the flow uses — boundary spaces between inline boxes are real width.
      width += measureRun(collapseRun(t, el, false), el);
    } else if (c.nodeType === NODE_ELEMENT && !selfNotRendered(c)) {
      width += subtreeTextWidth(c);
    }
  }
  el._lbText = width;
  return width;
}

// The widest single unbreakable run in `text`, measured in `el`'s font — one word's
// worth of min-content, wherever the caller found the run.
function longestWordWidth(text, el) {
  let best = 0;
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    const w = measureRun(word, el);
    if (w > best) best = w;
  }
  return best;
}

// What `min-width: auto` resolves to for a flex item — Flexbox §4.5's automatic
// minimum size. Measuring the whole text instead (its MAX-content width) made a
// text-heavy pane unshrinkable: Redmine's `#content` sat at the full container
// width and pushed the sidebar, and everything in it, off the right edge.
//
// NOT `intrinsicWidths().min`, which a declared width PINS: an item's declared
// width is a preferred size, and the spec takes the SMALLER of that and the
// content's own minimum — so a 500px item in a 600px row shrinks to its longest
// word rather than refusing to shrink at all.
function minContentWidth(el) {
  const intrinsic = intrinsicSize(el);
  if (intrinsic) return intrinsic.width;
  const e = edgeInsets(el, null);
  const content = contentIntrinsicWidths(el).min + e.left + e.right;
  const declared = resolveLayoutProp(el, 'width', null);
  if (declared == null) return content;
  return Math.min(isBorderBox(el) ? declared : declared + e.left + e.right, content);
}

// Coarse text height: no glyph metrics, so line count comes from an average advance width. This is
// the difference between "has text" and "has a LOT of text" — a long paragraph pushes what follows
// it down, and a content-length gate (Avo's Trix "More content" expander reads `scrollHeight`) sees
// content grow. Anything shorter than a line still gets exactly one line.
const AVG_CHAR_PX = 8;
function textHeight(el, width) {
  const len = ownTextLength(el);
  if (!len) return 0;
  // Lines = the text's measured width over the available width, not a character
  // count over an average advance.
  const total = subtreeTextWidth(el);
  const lines = width > 0 && total > 0 ? Math.max(1, Math.ceil(total / width)) : 1;
  return lines * lineHeightOf(el);
}

// The used line-box height for `el`. `line-height` INHERITS, so this goes through
// the same resolver getComputedStyle uses (style-proxy's computedLineHeight —
// "ONE geometry means one value resolution too"): an app that sets
// `body { line-height: 1.6 }` once must size every line below it. `normal` has no
// computed length, so it falls back to a factor over the used font size.
// Memoised per pass — every line placement asks.
function lineHeightOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return LINE_HEIGHT;
  if (el._lbLhPass === layoutPass) return el._lbLh;
  // An element that declares NEITHER line-height nor font-size has exactly its
  // parent's used line height — take the parent's memo instead of re-walking the
  // ancestor chain for both properties. That is the overwhelming majority of
  // elements on a real page (the resolvers each walk to the root otherwise, which
  // made a 1200-row list pay two full walks per row).
  const parent = el._parent;
  if (declaredValue(el, 'line-height') == null && inheritsFont(el) &&
      parent && parent.nodeType === NODE_ELEMENT) {
    el._lbLh = lineHeightOf(parent);
    el._lbLhPass = layoutPass;
    return el._lbLh;
  }
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
    el._lbLh = f && f.table && f.table.asc
      ? fontBoxHeight(f, true)
      : Math.round((f ? f.size : (computedFontSizePx(el) || 16)) * NORMAL_LINE_FACTOR);
  }
  el._lbLhPass = layoutPass;
  return el._lbLh;
}

// Document scroll offsets (standards-mode scrollingElement == documentElement).
// Whether `el` establishes a scroll/clip box (any overflow axis non-`visible`). For occlusion,
// clipping is what matters, so `scroll`/`auto`/`hidden`/`clip` all count.
function isScrollContainer(el) {
  for (const v of [declaredValue(el, 'overflow-x'), declaredValue(el, 'overflow-y'), declaredValue(el, 'overflow')]) {
    if (v == null) continue;
    const s = String(v).trim().toLowerCase();
    if (s === 'scroll' || s === 'auto' || s === 'hidden' || s === 'clip') return true;
  }
  return false;
}

// Does this box actually CLIP its content? A scroll/clip overflow does — except on the root, and on
// the body when the root took none of its own, where it PROPAGATES to the viewport instead (CSS
// Overflow §3.3) and the element itself stays `visible`. One predicate, so the clip chain and the
// scrollable-extent union can't disagree about the same box.
//
// Memoised per layout pass: `stampExtent` asks once per child, and each miss costs three cascade
// lookups (`overflow-x` / `-y` / `overflow`), every one a candidate-rule walk with real selector
// matching — per-element-per-pass work on the hot path (rule 3).
function clipsContent(el) {
  if (el._ccPass === layoutPass) return el._ccVal;
  el._ccPass = layoutPass;
  const doc = globalThis.document;
  const root = doc && doc.documentElement;
  const clips = el === root ? false
              : el === (doc && doc.body) ? (isScrollContainer(el) && isScrollContainer(root))
              : isScrollContainer(el);
  return (el._ccVal = clips);
}

// Total scroll shift applied to `el` — the document root (documentElement) plus every ancestor
// scroll container. A container renders its descendants offset by its scroll, compounding up.
function scrollShift(el) {
  const root = globalThis.document && globalThis.document.documentElement;
  let sx = 0, sy = 0;
  // A `position: fixed` box is laid out against the VIEWPORT, so no ancestor's scrolling moves it —
  // that is what fixed means, and it's how a pinned header stays put while the page scrolls under
  // it. Its own descendants are carried along with it, so the walk stops at the fixed ancestor
  // (after taking that ancestor's own scroll offset, which does move its content).
  if (isFixedBox(el)) return { sx, sy };
  // The document's scroll moves the ROOT ELEMENT's own box, not just its descendants': `html`'s
  // client rect sits at `(-scrollX, -scrollY)` in every browser. Page code reads exactly that —
  // Floating UI derives the left scrollbar offset as `getBoundingClientRect(html).left +
  // scrollLeft`, which is 0 only because the two cancel, and a root pinned at x=0 turned it into
  // the whole scroll offset and made it judge on-screen references clipped.
  if (el === root) return { sx: root._scrollLeft || 0, sy: root._scrollTop || 0 };
  for (let p = layoutParent(el); p; p = layoutParent(p)) {
    if (p === root || clipsContent(p)) { sx += p._scrollLeft || 0; sy += p._scrollTop || 0; }
    if (isFixedBox(p)) break;
  }
  return { sx, sy };
}

function isFixedBox(el) { return !!(el && el._lb && el._lb.fixed); }

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
  if (isFixedBox(el)) return false;   // pinned to the viewport, so no scroll container clips it
  for (let p = layoutParent(el); p; p = layoutParent(p)) {
    // The ROOT never clips: its overflow PROPAGATES to the viewport (CSS Overflow §3.3), leaving
    // the element itself `visible`. Treating `html { overflow-y: scroll }` as a scroll container
    // clipped to the root box made every absolutely positioned dropdown below the body's flow
    // bottom vanish from elementFromPoint — and the viewport clip that should apply instead is
    // already applied where it belongs, against `viewport()`. The BODY propagates the same way
    // when the root took no overflow of its own, which is what `body { overflow-x: hidden }` — as
    // common in app CSS as the `html` form — relies on.
    if (clipsContent(p) && p._lb && !rectsIntersect(eb, renderedBox(p))) return true;
    if (isFixedBox(p)) break;
  }
  return false;
}

// Coarse FLAT paint rank (higher = nearer the viewer): a positioned box paints above non-positioned
// siblings; explicit `z-index` orders positioned boxes; ties break by tree order. Ignores nested
// stacking contexts (a later increment) — correct for flat fixtures and the no-overlap block case.
function paintRank(el) {
  if (positionOf(el) === 'static') return 0;
  const z = declaredValue(el, 'z-index');
  return z != null && /^-?\d+$/.test(String(z).trim()) ? parseInt(z, 10) : 0.5;  // z-auto positioned just above flow
}

// Is `a` an ancestor of `b` in the flat tree?
function isFlatAncestor(a, b) {
  for (let p = layoutParent(b); p; p = layoutParent(p)) if (p === a) return true;
  return false;
}

// The chain of paint ranks an element inherits — every positioned ancestor from the root down, plus
// its own. Content is painted with the stacking context it lives in, so a static button inside a
// `z-index: 10` bar is painted at 10, ABOVE a `z-index: 5` box elsewhere. Comparing bare ranks made
// the button lose to that box (and comparing only ancestry made a fixed container swallow clicks
// meant for its own content) — the chain is what gets both right at once.
function stackChain(el) {
  if (el._lbChainPass === layoutPass) return el._lbChain;
  const parent = layoutParent(el);
  const chain  = parent ? stackChain(parent).slice() : [];
  if (positionOf(el) !== 'static') chain.push(paintRank(el));
  el._lbChainPass = layoutPass;
  el._lbChain = chain;
  return chain;
}

// Of two boxes that both contain the point, which paints on top? Compare their stacking chains
// lexicographically; when neither is deeper in the other's chain, a DESCENDANT still wins (an
// element's own box never covers its own content) and equal chains break by tree order.
function paintsAbove(cand, best) {
  if (best === null) return true;
  const cc = stackChain(cand), cb = stackChain(best);
  const n = Math.min(cc.length, cb.length);
  for (let i = 0; i < n; i++) {
    if (cc[i] !== cb[i]) return cc[i] > cb[i];
  }
  if (isFlatAncestor(best, cand)) return true;
  if (isFlatAncestor(cand, best)) return false;
  if (cc.length !== cb.length) return cc.length > cb.length;
  return cand._lbOrder >= best._lbOrder;
}

// The topmost laid-out, non-clipped element whose rendered box contains the VIEWPORT point (vx, vy).
export function hitTest(vx, vy) {
  ensureLayout();
  const body = globalThis.document && globalThis.document.body;
  if (!body) return null;
  let best = null;
  walkInclShadow(body, (n) => {
    if (n.nodeType !== NODE_ELEMENT || !n._lb || !isLaidOutNode(n) || isClipped(n)) return;
    const b = renderedBox(n);
    if (vx < b.x || vx > b.x + b.width || vy < b.y || vy > b.y + b.height) return;
    if (paintsAbove(n, best)) best = n;
  });
  // Nothing painted here, but the point may still be over the page's CANVAS — the area the root
  // element paints even where its box is shorter (Chrome measured: `elementFromPoint` below a 50px
  // body returns `<html>`, not null). The root's BOX stays content-sized, which is what its client
  // rect must report; only what it answers for a hit is viewport-sized.
  if (!best) {
    const root = globalThis.document && globalThis.document.documentElement;
    const vp = viewport();
    if (root && root._lb && isLaidOutNode(root) && vx >= 0 && vy >= 0 && vx <= vp.width && vy <= vp.height) return root;
  }
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

// The size of the viewport this document lays out against — the window viewport (1024x768 until
// `resize_to` says otherwise), or the container frame's content box. CSSOM reports it as the ROOT
// element's clientWidth/clientHeight (the standards-mode rule), which is the idiom apps use to
// read "how big is the window".
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
  // Measured from the PADDING box origin, not the border box: scrollWidth /
  // scrollHeight (and the scrollable range) start inside the borders, so a
  // bordered scroller whose content is exactly N tall reports N, not N + border.
  // `stampExtent` seeds the union with the element's own BORDER box, so a box whose
  // content doesn't overflow measures its border box here — subtract both borders or
  // an unscrollable bordered box reports scrollHeight > clientHeight and every
  // "is there more?" affordance turns on (Chrome: a 50px box with 5px borders and
  // 10px of content has scrollHeight 50, not 55).
  // `stampExtent` seeds the union with the element's own BORDER box, so a box whose
  // content doesn't overflow would otherwise measure that box (border-inflated) as
  // its scrollable content. Anything up to the seed reports the CLIENT box — Chrome:
  // a 50px-tall box with 5px borders over 10px of content has scrollHeight 50, and
  // `scrollHeight > clientHeight` (every "is there more?" affordance) stays false.
  const bw = borderWidthsOf(el);
  const clientW = Math.max(0, b.width  - bw.left - bw.right);
  const clientH = Math.max(0, b.height - bw.top  - bw.bottom);
  const rawW = ext.right  - b.x - bw.left;
  const rawH = ext.bottom - b.y - bw.top;
  return {
    width:  Math.round(rawW > clientW + bw.right  ? rawW : clientW),
    height: Math.round(rawH > clientH + bw.bottom ? rawH : clientH)
  };
}

// Whether `el` establishes a containing block for absolutely-positioned descendants — i.e. it is
// positioned. CSSOM's `offsetParent` is the nearest such ancestor.
export function isPositionedElement(el) {
  return !!el && el.nodeType === NODE_ELEMENT && positionOf(el) !== 'static';
}

// The laid-out border box in DOCUMENT coordinates — no scroll subtracted, unlike `rectOf`. This is
// what the offset* properties are measured in: they're layout positions, so scrolling the page
// doesn't change them (only `getBoundingClientRect` moves).
// Published for style-proxy, which can't import this module (layout.js imports IT) — the same
// global seam `__isLaidOutNode` uses. A resolved `transform` needs the border box to turn a
// percentage translate into pixels.
globalThis.__csimDocumentBox = (el) => documentBoxOf(el);
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
// The CLIENT box size: the padding box, i.e. the border box minus its borders
// (padding stays inside it). `clientWidth` / `clientHeight` report this, and the
// scrollable range is measured against it — a bordered scroller's max scrollTop is
// scrollHeight minus the CLIENT height, so counting the borders in would clamp a
// scroll one border-width short (capybara's scroll.erb: a 50px, 1px-bordered
// #scrollable scrolls to 150, not 149).
export function clientBoxOf(el) {
  const r = rectOf(el);
  const bw = borderWidthsOf(el);
  return { width: Math.max(0, r.width - bw.left - bw.right), height: Math.max(0, r.height - bw.top - bw.bottom) };
}

// Used border widths per side (a side whose style is none/hidden contributes 0).
// Reads the per-pass `edgeInsets` memo — clientWidth / clientHeight / scrollWidth /
// scrollHeight go through here, and editors and virtualised lists read those on
// every keystroke, so this must not re-resolve 12 cascade properties per call
// (measured: 20 000 reads 217 ms unmemoised vs 117 ms memoised).
function borderWidthsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { top: 0, right: 0, bottom: 0, left: 0 };
  const e = edgeInsets(el, el._lbCbW != null ? el._lbCbW : (el._lb && el._lb.width) || 0);
  return { top: e.bt, right: e.br, bottom: e.bb, left: e.bl };
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
export function observedRect(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  if (!(globalThis.__isLaidOutNode && globalThis.__isLaidOutNode(el))) return null;
  ensureLayout();
  if (!el._lb || isClipped(el)) return null;
  return renderedBox(el);
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
  // The alignment box is the SCROLL BOX's visible height — the viewport for the document, but the
  // container's own height when scrolling a scroll container. Using the viewport for a 50px-tall
  // container puts `align: :bottom` hundreds of pixels off.
  // The scroll box is the PADDING box: its borders neither scroll nor count toward
  // the alignment span (Chrome aligns `bottom` against `top + clientHeight`).
  const scrollBw = isRoot ? { top: 0, left: 0 } : borderWidthsOf(scrollEl);
  const vpH = isRoot ? viewport().height : (clientBoxOf(scrollEl).height || viewport().height);
  let sx = scrollEl._scrollLeft || 0, sy = scrollEl._scrollTop || 0;
  if (target) {
    const b = target._lb;
    if (b) {
      // Scroll offset that brings the target's top to the scroll box's content top: the target's
      // laid-out position MINUS the scroll box's origin (the viewport origin (0,0) for the document
      // root; the container's own box for a scroll container).
      const ox = isRoot || !scrollEl._lb ? 0 : scrollEl._lb.x + scrollBw.left;
      const oy = isRoot || !scrollEl._lb ? 0 : scrollEl._lb.y + scrollBw.top;
      sy = b.y - oy;                                            // align:top
      if (pos === 'center')      sy = b.y - oy - (vpH - b.height) / 2;
      else if (pos === 'bottom') sy = b.y - oy - (vpH - b.height);
      sx = b.x - ox;                                            // bring a horizontally-offscreen box in too
    }
  } else if (x != null || y != null) {
    sx = +x || 0; sy = +y || 0;
  } else if (pos === 'top')    { sy = 0; }
  else if (pos === 'bottom')   { sy = maxScroll(scrollEl, isRoot).y; }
  else if (pos === 'center')   { sy = maxScroll(scrollEl, isRoot).y / 2; }
  return clampScroll(scrollEl, isRoot, sx, sy);
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
  const max = maxScroll(scrollEl, isRoot);
  return {
    el: scrollEl,
    x: Math.min(Math.max(0, sx), max.x),
    y: Math.min(Math.max(0, sy), max.y)
  };
}

// Bring `el` into view if it isn't — what every driver does before interacting with an element
// (Selenium's `scroll_if_needed`). Only when needed: a gratuitous scroll would move the page out
// from under the rest of the test. Returns true if it scrolled.
export function ensureInView(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  ensureLayout();
  const root = globalThis.document && globalThis.document.documentElement;
  // Already showing — in the viewport AND not clipped away by any scroll container on the way up?
  // Then touch nothing. This is the overwhelmingly common case (a test clicks what it can see), and
  // walking the scroll chain for it fires scroll events at every ancestor, which editors and
  // virtual scrollers react to: doing that on every click hung Avo's ACE-backed code field.
  const r0 = rectOf(el), vp0 = viewport();
  if (!isClipped(el) && r0.x + r0.width > 0 && r0.y + r0.height > 0 &&
      r0.x < vp0.width && r0.y < vp0.height) return false;
  let scrolled = false;
  // Innermost scroll box outwards, ending at the document — `scrollIntoView({block: 'nearest'})`,
  // which is what WebDriver's element-click runs. Scrolling only the document instead moved the
  // PAGE for an item inside an `overflow: auto` list and left the item exactly as hidden as before.
  for (let p = el; p; p = layoutParent(p)) {
    if (p !== root && !(p !== el && clipsContent(p))) continue;
    const visible = p === root ? { x: 0, y: 0, ...viewport() } : renderedBox(p);
    if (!visible) continue;
    const r = rectOf(el);
    // Already showing in THIS box? Then leave it alone. WebDriver clicks the in-view centre point,
    // so any box with a part inside already has a clickable one, and scrolling anyway would move
    // the page out from under everything the test looks at next.
    if (r.x + r.width > visible.x && r.y + r.height > visible.y &&
        r.x < visible.x + visible.width && r.y < visible.y + visible.height) continue;
    const dx = scrollDeltaInto(r.x - visible.x, r.width,  visible.width);
    const dy = scrollDeltaInto(r.y - visible.y, r.height, visible.height);
    if (!dx && !dy) continue;
    // Scroll THIS box, not whatever `applyScrollBy` would map it to: it treats `body` as the
    // document scroller (right for Capybara's `scroll_to`), so an app shell whose body is its own
    // `overflow: auto` box would have the delta applied to a root that can't scroll at all.
    const to = clampScroll(p, p === root, (p._scrollLeft || 0) + dx, (p._scrollTop || 0) + dy);
    p.scrollLeft = to.x;
    p.scrollTop  = to.y;
    scrolled = true;
  }
  return scrolled;
}

// How far to scroll one axis so a box at `pos` (viewport coords) of length `size` fits in a
// `visible`-long viewport — the MINIMUM, aligning to whichever edge is nearer, which is what a
// browser's scroll-into-view does for a click. Centring instead would introduce a horizontal
// scroll on pages that have no horizontal overflow to speak of and shift every other element the
// test then looks at.
function scrollDeltaInto(pos, size, visible) {
  // A box that STRADDLES the viewport — starting above it and ending below — already covers the
  // visible area, and CSSOM-View's `nearest` leaves it alone. Scrolling to its start instead would
  // jump the page to the top of any element taller than the window, on every click.
  if (pos <= 0 && pos + size >= visible) return 0;
  if (pos < 0 || size > visible) return pos;                 // above / taller than the box: align its start
  const overshoot = pos + size - visible;
  return overshoot > 0 ? overshoot : 0;
}

// Scroll `self` BY a delta from where it is now (Capybara's `scroll_to(:current, offset: [x, y])`).
// Clamp a scroll offset to `el`'s scrollable range on one axis — the setter's
// version of what scrollTargetFor's clampScroll does for the driver paths.
export function clampScrollOffset(el, axis, value) {
  if (!el || el.nodeType !== NODE_ELEMENT) return Math.max(0, value);
  ensureLayout();
  const root = globalThis.document && globalThis.document.documentElement;
  const isRoot = el === root || el._tag === 'html' || el._tag === 'body';
  const max = maxScroll(isRoot ? root : el, isRoot);
  return Math.min(Math.max(0, value), axis === 'x' ? max.x : max.y);
}

export function applyScrollBy(self, dx, dy) {
  const root = globalThis.document && globalThis.document.documentElement;
  const isRoot = !!self && (self._tag === 'html' || self._tag === 'body' || self === root);
  const scrollEl = isRoot ? root : self;
  if (!scrollEl) return null;
  ensureLayout();
  const to = clampScroll(scrollEl, isRoot, (scrollEl._scrollLeft || 0) + (+dx || 0),
                                           (scrollEl._scrollTop  || 0) + (+dy || 0));
  scrollEl.scrollLeft = to.x;
  scrollEl.scrollTop  = to.y;
  return scrollEl;
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
