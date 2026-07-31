// A COARSE box-layout model — enough for occlusion / hit-testing (`obscured?`), NOT a real layout
// engine. It computes an approximate border-box `{x, y, width, height}` (document coordinates) for
// each rendered element via block flow + absolute/fixed positioning (explicit sizes, or stretched
// between opposite insets), plus a z-order hit-test. Deliberate coarse choices (documented per
// box): no text-metrics (auto width → containing-block width; a text-bearing block gets a coarse
// line-height so it has a hittable box),
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
// Cost: laid out once per (settleGen, cascadeVersion) generation — the same dual key the innerText
// memo uses (inline/attr edits bump settleGen; stylesheet/CSSOM edits bump cascadeVersion). It is
// pay-per-use for a page with no live IntersectionObserver: nothing lays out until something asks
// for geometry. A page that HAS one pays a pass per rendering update in which the DOM changed,
// because that is when observers are delivered (measured: a Discourse slice 6:20 → 7:14).

import { NODE_ELEMENT }                                  from './constants.js';
import { walkInclShadow }                                from './walk.js';
import { isLaidOutNode, selfNotRendered, cascadedProperty, resolveLayoutProp, resolveCascadeDisplay } from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { usedDisplay, DEFAULT_DISPLAY }                  from './style-proxy.js';

const BODY_MARGIN = 8;      // UA default body margin (coarse; not cascade-modelled)
const LINE_HEIGHT = 19;     // coarse ~1 line at the 16px default font (no glyph metrics)

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
    const consumed = bb ? bb.y + bb.height + marginOf(body, 'margin-bottom') : 0;
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
  let width  = w != null ? w : (intrinsic ? intrinsic.width  : autoW);
  let height = h != null ? h : (intrinsic ? intrinsic.height : autoH);
  // One axis given and the other auto on a replaced element: the missing one follows the intrinsic
  // aspect ratio (`<img width="500">` on a 4:3 image is 375 tall, not 150).
  if (intrinsic && intrinsic.ratio && intrinsic.width > 0 && intrinsic.height > 0) {
    if (w != null && h == null)      height = Math.round(w * intrinsic.height / intrinsic.width);
    else if (h != null && w == null) width  = Math.round(h * intrinsic.width  / intrinsic.height);
  }
  return { width, height, autoWidth: w == null && !intrinsic, autoHeight: h == null && !intrinsic };
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
const INLINE_LEVEL = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid']);
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
  // (and occlude) the page. Otherwise an auto width still fills the containing block, and an auto
  // height stays 0 for the flow to back-fill.
  const autoW = (left != null && right  != null) ? Math.max(0, cb.width  - left - right)  : cb.width;
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
  layoutElement(child, box, ctx);
  // An auto height isn't known until the child's own flow has been laid out (layoutElement
  // back-fills it), and a text-only out-of-flow box — a tooltip, a toast — gets the same coarse
  // line-height an in-flow one does, else it has a zero-height box and can't be hit at all.
  if (size.autoHeight && box.height === 0) box.height = textHeight(child, box.width);
  // Anchored by `bottom` alone, the box was placed against a height we didn't know yet: lift it by
  // what it turned out to be, so its BOTTOM edge — the anchored one — lands where it belongs. (A
  // `right`-anchored auto WIDTH needs no such pass: an auto width already fills the containing
  // block, so its right edge is the containing block's right edge. Coarse: no shrink-to-fit.)
  if (bottom != null && top == null && box.height !== size.height) {
    shiftSubtreeY(child, size.height - box.height);
  }
}

// `flex-direction: column` (and `column-reverse`) stacks, which is what block flow already does —
// only a ROW needs its own pass.
function isColumnFlex(el) {
  const d = cascadedProperty(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase().startsWith('column');
}
function isReverseFlex(el) {
  const d = cascadedProperty(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase() === 'row-reverse';
}

// An item's flex factors. The `flex` shorthand is expanded into these longhands by the cascade, so
// reading only the longhands here is what makes declaration order work.
function flexParts(el) {
  if (el._lbFlexPass === layoutPass) return el._lbFlex;
  el._lbFlexPass = layoutPass;
  const num = (v, dflt) => { const n = parseFloat(v); return v != null && isFinite(n) ? Math.max(0, n) : dflt; };
  el._lbFlex = {
    grow:   num(cascadedProperty(el, 'flex-grow'), 0),
    shrink: num(cascadedProperty(el, 'flex-shrink'), 1)
  };
  return el._lbFlex;
}

// A coarse flex ROW: items sit side by side in source order with their widths resolved together
// (see resolveFlexRowWidths — basis, grow, shrink and the automatic minimum), and the row is as tall
// as its tallest item. No wrapping, no alignment, no baseline — enough that a toolbar, a field row
// or a card row occupies ONE row's height instead of one per item.
function layoutFlexRow(el, box, ctx, { equalShare = false } = {}) {
  const items = [];
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, box.y, ctx); continue; }
    items.push({ child, pos });
  }
  // An item with no text of its own has no content width to measure, so it takes an equal share —
  // better than the zero a text estimate would give a container of blocks.
  const share = items.length ? Math.floor(box.width / items.length) : box.width;
  const widths = equalShare ? items.map(() => share) : resolveFlexRowWidths(items, box, share);

  // `row-reverse` runs the main axis the other way: items go in reverse order AND pack against the
  // right edge (Chrome puts two 100px items in a 400px reverse row at 300 and 200, not 100 and 0).
  // Redmine's `#main` is one — it is how its sidebar ends up on the right.
  const reverse = isReverseFlex(el);
  const order = reverse ? items.map((_, i) => items.length - 1 - i) : items.map((_, i) => i);
  let x = reverse ? box.x + box.width - widths.reduce((a, b) => a + b, 0) : box.x;
  let rowH = 0;
  for (const idx of order) {
    const { child, pos } = items[idx];
    const content = widths[idx];
    const size = usedSize(child, content, 0, box.width, box.height || null);
    // The flex pass already resolved this axis: a declared width is an item's flex BASE, not its
    // final width, so it must not win here the way it does in block flow (two 500px items in a 600px
    // row shrink to fit, they don't overflow to 900). Table cells are NOT flex items — their
    // declared width stands.
    if (!equalShare) size.width = content;
    const rel  = pos === 'relative' ? relativeOffset(child, box.width, box.height || null) : null;
    layoutElement(child, {
      x: x + (rel ? rel.x : 0), y: box.y + (rel ? rel.y : 0),
      width: size.width, height: size.height
    }, ctx);
    if (size.autoHeight && child._lb.height === 0) child._lb.height = textHeight(child, child._lb.width) || LINE_HEIGHT;
    x += child._lb.width;
    if (child._lb.height > rowH) rowH = child._lb.height;
  }
  if (box.height === 0) box.height = rowH;
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
    return Math.min(textWidth(subtreeTextLength(child)), box.width);
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
function layoutElement(el, box, ctx) {
  el._lb = box;
  el._lbOrder = ctx.order++;
  const disp = displayOf(el);
  if (disp === 'grid' || disp === 'inline-grid') { layoutGrid(el, box, ctx); return; }
  if ((disp === 'flex' || disp === 'inline-flex') && !isColumnFlex(el)) { layoutFlexRow(el, box, ctx); return; }
  // A table ROW puts its cells side by side, exactly like a flex row — and a table of N columns whose
  // cells each stacked full-width was N times too tall, the same error inline and flex had. (Real
  // table layout — column sizing from content across rows, spans, borders — stays out of scope.)
  if (disp === 'table-row') { layoutFlexRow(el, box, ctx, { equalShare: true }); return; }

  const right = box.x + box.width;
  let flowY = box.y;      // top of the current line box / the next block
  let lineX = box.x;      // horizontal cursor within the current line
  let lineH = 0;          // tallest box on the current line (0 = the line is empty)
  let hadInFlow = false;

  // Finish the current line, so a block-level box starts below it.
  const breakLine = () => {
    if (lineH === 0 && lineX === box.x) return;
    flowY += lineH || LINE_HEIGHT;
    lineX = box.x;
    lineH = 0;
    hadInFlow = true;
  };
  // Reserve `w` x `h` on the current line, wrapping first if it doesn't fit; returns the origin.
  const placeOnLine = (w, h) => {
    if (lineX > box.x && lineX + w > right) { flowY += lineH || LINE_HEIGHT; lineX = box.x; lineH = 0; }
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
      if (!/\S/.test(t)) continue;
      const total = textWidth(t.trim().length);
      const avail = box.width || 1;
      const used  = (lineX - box.x) + total;
      if (used > avail) {
        flowY += Math.floor(used / avail) * LINE_HEIGHT;
        lineX  = box.x + (used % avail);
        lineH  = LINE_HEIGHT;
        hadInFlow = true;
      } else {
        placeOnLine(total, LINE_HEIGHT);
      }
      continue;
    }
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, flowY, ctx); continue; }

    if (isInlineLevel(child)) {
      // An inline box is as wide as its content (declared width or intrinsic size win) and one line
      // tall unless it says otherwise. Coarse: no baseline alignment, no half-leading.
      const content = Math.min(textWidth(subtreeTextLength(child)), box.width);
      const size = usedSize(child, content, LINE_HEIGHT, box.width, box.height || null);
      const rel  = pos === 'relative' ? relativeOffset(child, box.width, box.height || null) : null;
      const at   = placeOnLine(size.width, size.height);
      const cbox = {
        x: at.x + (rel ? rel.x : 0), y: at.y + (rel ? rel.y : 0),
        width: size.width, height: size.height
      };
      layoutElement(child, cbox, ctx);
      // An inline box WRAPS its inline content, which a text estimate can badly undersell: the
      // `<span>` ProseMirror puts around an image contains no text at all, so it measured 0 x one
      // line while holding a 500px image — two of them then sat 19px apart, overlapping, and a click
      // aimed at the first landed on the second. Grow whichever axis was auto to the content extent
      // and let the line follow.
      const ext = child._lbExtFlow;
      if (ext && (size.autoWidth || size.autoHeight)) {
        if (size.autoWidth) {
          const w = Math.max(cbox.width, Math.round(ext.right - cbox.x));
          lineX += w - cbox.width;
          cbox.width = w;
        }
        if (size.autoHeight) {
          cbox.height = Math.max(cbox.height, Math.round(ext.bottom - cbox.y));
        }
        if (cbox.height > lineH) lineH = cbox.height;
        stampExtent(child, cbox);
      }
      continue;
    }

    // In-flow block: fills the containing width unless explicitly sized, and starts below whatever
    // line was open (coarse: margins ignored).
    breakLine();
    const size = usedSize(child, box.width, 0, box.width, box.height || null);
    const rel  = pos === 'relative' ? relativeOffset(child, box.width, box.height || null) : null;
    layoutElement(child, { x: box.x + (rel ? rel.x : 0), y: flowY + (rel ? rel.y : 0), width: size.width, height: size.height }, ctx);
    if (size.autoHeight && child._lb.height === 0) child._lb.height = textHeight(child, child._lb.width);
    flowY += child._lb.height;      // the flow advances by the box's height, not its shifted position
    hadInFlow = true;
  }
  breakLine();
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
  // The same union restricted to IN-FLOW children. An out-of-flow box is not part of what its
  // parent wraps — a nav link holding an absolutely positioned dropdown is as wide as its own word,
  // not as wide as the menu — so the inline auto-grow measures this one instead.
  let fRight = right, fBottom = bottom;
  for (const child of layoutChildren(el)) {
    const ce = child._lbExt;
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
function layoutGrid(el, box, ctx) {
  const cols = gridColumnCount(el);
  const gap  = gridGap(el);
  const declaredRowH = gridRowHeight(el);
  const colW = cols > 0 ? (box.width - (cols - 1) * gap) / cols : box.width;
  let col = 0;
  let rowTop = box.y;      // top of the row being filled — auto rows are as tall as their content,
  let rowH   = 0;          // so the next row can only start once this one's items are placed
  let bottom = box.y;
  const endRow = () => { rowTop += (declaredRowH != null ? declaredRowH : rowH) + gap; rowH = 0; col = 0; };
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, rowTop, ctx); continue; }
    const span = Math.max(1, Math.min(gridColumnSpan(child), cols));
    if (col + span > cols) endRow();                                 // wrap to the next row
    const cx = box.x + col * (colW + gap);
    layoutElement(child, { x: cx, y: rowTop, width: span * colW + (span - 1) * gap, height: declaredRowH != null ? declaredRowH : 0 }, ctx);
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
// A declared `grid-auto-rows` length, else null: an AUTO row is as tall as its content, and
// pretending otherwise (this used to answer a flat 100px) inflated every grid on the page.
function gridRowHeight(el) {
  const r = cascadedProperty(el, 'grid-auto-rows');   // `minmax(100px, auto)` / `100px` → 100 (coarse)
  const m = r && PX_RE.exec(String(r));
  return m ? parseFloat(m[1]) : null;
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

// Coarse advance width for a run of text. No glyph metrics, so an average character advance — the
// same constant the line count uses, and close enough in practice (Chrome measures "alpha" at 39px;
// 5 chars x 8px = 40).
function textWidth(len) { return len * AVG_CHAR_PX; }

// The text in `el`'s whole subtree: an inline box is as wide as the text inside it, however deeply
// that text is nested (`<a><span>label</span></a>`).
function subtreeText(el) {
  if (el._lbTextPass === layoutPass) return el._lbText;
  let len = 0, longest = 0;
  for (const c of layoutChildren(el)) {
    if (c.nodeType === 3) {
      const t = c._data || c.data || '';
      if (!/\S/.test(t)) continue;
      const trimmed = t.trim();
      len += trimmed.length;
      for (const word of trimmed.split(/\s+/)) {
        if (word.length > longest) longest = word.length;
      }
    } else if (c.nodeType === NODE_ELEMENT && !selfNotRendered(c)) {
      const sub = subtreeText(c);
      len += sub.len;
      if (sub.longest > longest) longest = sub.longest;
    }
  }
  el._lbTextPass = layoutPass;
  el._lbText = { len, longest };
  return el._lbText;
}
function subtreeTextLength(el) { return subtreeText(el).len; }

// The MIN-CONTENT width: the longest unbreakable run, which is what `min-width: auto` resolves to
// for a flex item. Measuring the whole text instead (its MAX-content width) made a text-heavy pane
// unshrinkable — Redmine's `#content` sat at the full container width and pushed the sidebar, and
// everything in it, off the right edge of the viewport.
function minContentWidth(el) {
  const intrinsic = intrinsicSize(el);
  if (intrinsic) return intrinsic.width;
  return textWidth(subtreeText(el).longest);
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
    if (p === root || isScrollContainer(p)) { sx += p._scrollLeft || 0; sy += p._scrollTop || 0; }
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
    if (isScrollContainer(p) && p._lb && !rectsIntersect(eb, renderedBox(p))) return true;
    if (isFixedBox(p)) break;
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
  const vpH = isRoot ? viewport().height : ((scrollEl._lb && scrollEl._lb.height) || viewport().height);
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
  const visW = isRoot ? vp.width  : (scrollEl._lb ? scrollEl._lb.width  : 0);
  const visH = isRoot ? vp.height : (scrollEl._lb ? scrollEl._lb.height : 0);
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
  const r = rectOf(el);
  const vp = viewport();
  const dx = scrollDeltaInto(r.x, r.width,  vp.width);
  const dy = scrollDeltaInto(r.y, r.height, vp.height);
  if (!dx && !dy) return false;
  const root = globalThis.document && globalThis.document.documentElement;
  applyScrollBy(root, dx, dy);
  return true;
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
