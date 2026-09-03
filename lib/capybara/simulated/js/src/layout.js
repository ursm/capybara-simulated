// The box-layout model: a border-box `{x, y, width, height}` in document coordinates for every
// rendered element, plus the z-order hit-test built on those boxes. The page-visible geometry
// surface (`getBoundingClientRect` / `elementFromPoint` / `offset*` / `client*` / `scroll*`) reads
// the same boxes, so the driver and the page's own JS never disagree about where anything is.
//
// MODELLED: block flow with §8.3.1 margin collapsing (siblings, parent/child and collapse-through);
// floats (§9.5); inline runs measured with the font's own advance widths (see "Text metrics"
// below); absolute / fixed / relative positioning, stretched between opposite insets or shrunk to
// fit; flex layout along the container's FLOW axes (line breaking, grow / shrink distribution,
// alignment, and `writing-mode` / `direction` / `flex-direction` between them); a coarse
// grid pass; CSS Tables 3 table layout; overflow clipping, the scrollable overflow region and
// scroll offsets; the flat tree through shadow roots and slots; and frames across realms.
//
// Text BREAKS greedily, word by word, at white space and at forced breaks (`<br>`, a newline a
// `pre` block keeps) — see `placeTextRun` — and an inline box CONTINUES across the lines its text
// broke over, reporting the union of its fragments (see `placeInlineBox`).
//
// DELIBERATELY NOT, each documented at the box it affects:
//   - glyph SHAPING — pair KERNING (Chrome measures `Ta` at 16.9px in 16px Arial, we sum the raw
//     advances for 18.7), ligatures, bidi — and per-run font FALLBACK: a CJK line breaks in the
//     right places but is as tall as the element's own font, not the fallback's (Chrome: 24 to
//     our 18);
//   - the rest of UAX #14 beyond white space and wide characters — no break after a hyphen;
//   - `vertical-align` and BASELINE alignment: everything on a line hangs from its top, so an
//     inline box sharing a line with something taller sits where Chrome puts it only when the two
//     are the same height (Chrome drops a `<span>` 46px down a line a 60px image made);
//   - line ALIGNMENT: `text-align` is not read, so every line starts at the content edge and a
//     centred or right-aligned inline reports a box Chrome puts elsewhere on the line;
//   - an inline box's fragment list is split per LINE, where Chrome also splits it at each
//     descendant inline box: `<span>a <em>b</em> c</span>` on one line is one rect here and
//     three in Chrome. The union, and every point in it, are the same either way;
//   - a collapsible space the break eats stops counting toward the boxes around it but has
//     already advanced the line cursor, so an inline box's own EDGE placed after it (an empty
//     padded `<b>` at a line end) sits one space to the right of where Chrome shrinks it back;
//   - `text-indent`, `max-width` in shrink-to-fit, and `scrollHeight` for BARE wrapped text (a
//     clipped box holding only text reports its own height, because the extent unions child
//     ELEMENT boxes and text has none);
//   - an inline box split by a BLOCK child, which a browser breaks into anonymous blocks: it
//     falls back to ONE box shrink-wrapped to its text, and hands the block child that width
//     rather than the containing block's (see `isContinuedInline`);
//   - BLOCK flow is still physical in a vertical writing mode: a `vertical-rl` block puts its
//     overflowing child at 0..300 where Chrome puts it at -200..100 (flex layout follows the flow
//     axes now, and `scrollOriginSides` reads the two conventions apart until this moves);
//   - inline runs are HORIZONTAL: a vertical writing mode breaks and measures its text as if it
//     ran across the page, so an auto-sized item in one is a line tall rather than a word long,
//     and `align-items: baseline` in such a row has no baseline geometry to align on;
//   - grid TRACK sizing beyond the coarse column pass; PARTIAL overflow clipping (a box is clipped
//     whole or not at all); and a FLAT paint order (no nested stacking-context tree).
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

import { NODE_ELEMENT, NODE_TEXT }                       from './constants.js';
import { walkInclShadow, flatTreeParent }                from './walk.js';
import { isLaidOutNode, selfNotRendered, resolveLayoutProp, resolveCascadeDisplay, hasFallbackOnlyContent,
         rendersObjectFallback,
         cascadeLayoutEpoch, mayConstrainSize, inlineAxisIsHorizontal, flowSides,
         cascadeDeclaresProperty, animationsDeclareProperty, inlineDecls, dynamicReadSeq, visibilityHidden,
         ownWhiteSpace } from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { advanceTableFor }                               from './font-metrics.js';
// Box props are read through `declaredValue`, not the raw cascade: it resolves a `var()` against
// the element and decodes the pending slot a `flex: var(--f)` shorthand occupies. Reading the store
// directly made layout see an opaque marker where getComputedStyle saw `1` — ONE geometry means one
// value resolution too.
import { usedDisplay, uaDisplay, blockify, WIDGET_TAGS, declaredValue, declaredValueEntry, declaredValueIn, usedOverflow, propagatedOverflow,
         computedFontSizePx, computedLineHeight,
         computedFontFamily, computedFontWeight, computedFontStyle, declaresOwnFont,
         computedLetterSpacingPx, computedWordSpacingPx, declaresSpacing, textAlignOf, textIndentOf, tabSizeOf,
         fontRelativeToPx, uaDefault, computedBorderCollapse, computedBorderSpacing,
         isListBox, inputType, buttonInputLabel, usedTransformMatrix, usedPerspective, preserves3d,
         IDENT4, multiply4, translate4, flattenMatrix4, homographyOf, applyHomography,
         invertHomography } from './style-proxy.js';
import { usedLineWidthPx } from './css-utils.js';
import { selectDisplaySize } from './html-integers.js';

// `doc._sawSticky` — latched the first time a document lays out a `position: sticky` box (in
// `positionOf`). Until then every `scrollShift` — the hot path behind every rect read — skips the
// sticky walk on one read. A latch, not a per-pass flag: a pass that reuses an untouched subtree
// (`reuseSubtree`) never calls `positionOf` for the boxes inside it, so resetting per pass
// switched every sticky in the document off the moment its subtree went memo-stable —
// Discourse's pinned sidebar fell out of the viewport on the first scrolled click. Stamped on
// the DOCUMENT, not the module, so an SPA session that leaves a sticky page for a sticky-free
// one gets its fast path back.
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
  const parent = flatTreeParent(el);
  const above = parent ? inheritedDirty(parent) : 0;
  const own = el._lbSubDirty || 0;
  const v = own > above ? own : above;
  el._lbInhDirtyPass = layoutPass;
  el._lbInhDirty = v;
  return v;
}
// The cascade side of every layout memo is the LAYOUT epoch (`cascadeLayoutEpoch`): the rule-set
// version, plus the dynamic style state a selector can read (`:placeholder-shown`, `:checked`,
// `:popover-open`, hover / focus — everything `bumpStyleState` records) while a dynamic rule on the
// page can move a box. Keyed on the rule-set version alone, layout answered from a cache no state
// change could invalidate: `#t:placeholder-shown { width: 300px }` kept its 300px box — through
// `getBoundingClientRect`, not just the CSSOM — after the field was filled. (The cascade's own
// declared-value memo keys on the rule set alone and relies on the dynamic-pseudo taint instead;
// a layout box has no such bracket, hence the epoch.)
function memoStamp(el) {
  const d = el._lbDirty || 0, i = inheritedDirty(el);
  return ((d > i ? d : i) * 4294967296) + cascadeLayoutEpoch();
}
function memoFresh(el, key) {
  const m = el[key];
  return m !== undefined && m === memoStamp(el);
}
// …and the same for a memo that only STRUCTURE can invalidate (a table's grid): an attribute
// written on a cell cannot change which cells there are.
function structFresh(el, key) {
  const m = el[key];
  return m !== undefined && m === ((el._lbStruct || 0) * 4294967296) + cascadeLayoutEpoch();
}
function structStamp(el) { return ((el._lbStruct || 0) * 4294967296) + cascadeLayoutEpoch(); }
// Lay out the whole document once per (settleGen, style epoch). Boxes are stamped on `_lb`
// (border-box, document coords) and a monotonic `_lbOrder` (paint tie-break = tree order).
function ensureLayout() {
  const doc = globalThis.document;
  const body = doc && doc.body;
  if (!body) return;
  // Scoped dynamic-state dirtying runs HERE — before the gate reads its keys and before
  // `layoutPass++` — never mid-pass, where fresh marks are invisible to the per-pass
  // inheritedDirty memo (see __csimApplyScopedStateDirty in cascade.js).
  if (globalThis.__csimApplyScopedStateDirty) globalThis.__csimApplyScopedStateDirty();
  // The dirty sequence is the gate's third key: scoped state marks move NEITHER settleGen nor
  // the epoch — without it, a focus flip's marks would sit unread behind an early return.
  const gen = settleGen(), cv = cascadeLayoutEpoch();
  const ds = globalThis.__csimDirtySeq ? globalThis.__csimDirtySeq() : 0;
  if (doc._layoutGen === gen && doc._layoutCV === cv && doc._layoutDS === ds) return;
  doc._layoutGen = gen; doc._layoutCV = cv; doc._layoutDS = ds;
  // A layout pass IS a style flush, and the style recalc comes FIRST: a browser recomputes style
  // and only then lays out, so a transition this change starts is already running when the boxes
  // are measured. (Seeded at the END instead, the pass measured the value the transition was
  // heading for — `getComputedStyle(el).height` reported the target while the transition it had
  // just started reported the interpolation.) That computation is also what gives the NEXT change
  // something to be measured against: `el.classList.add('fade')`, a forced `offsetWidth`, then the
  // class that moves the value is THE idiom for starting a transition, and without a flush here
  // the two changes collapsed into one with nothing recorded in between.
  //
  // The rendered check inside it is CASCADE-only (`isLaidOutNode` walks `display` and connectivity,
  // never a box), so running before this pass has laid anything out costs it nothing. What keeps
  // an element that has only just appeared from transitioning is `_csimNoBaseline`, not the timing
  // of this call.
  if (!FLUSHING_STYLE && globalThis.__csimSeedStyleFlush) {
    FLUSHING_STYLE = true;
    try { globalThis.__csimSeedStyleFlush(); } finally { FLUSHING_STYLE = false; }
  }
  layoutPass++;
  OPEN_INLINE_BOXES.length = 0;
  LAYING_OUT.clear();
  PENDING_BY_CB.clear();
  // The viewport this document lays out against — the top-level one, or our container frame's
  // content box. Resolved once per layout pass (it needs a cross-realm call; see viewport()).
  doc._layoutVP = computeViewport();
  const vp = doc._layoutVP;
  // The float context every float in the page belongs to until a box starts one of its own. It
  // is the INITIAL containing block's: `<body>` does not establish a formatting context, so a
  // float in it overflows the body exactly as Chrome lets it (`floats.owner` is nobody, so no
  // box's auto height grows to hold these).
  const ctx = { order: 0, floats: newFloatContext(doc.documentElement) };
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

  const ml = marginOf(body, 'margin-left'), mr = marginOf(body, 'margin-right');
  // `<body>` establishes no formatting context of its own, so its first child's margin collapses
  // with its own and the page's content starts THERE: a `<p>` at the top of a `margin: 0` body sits
  // 16px down in Chrome, not at the viewport edge (§8.3.1, `collapsingTopMargin`).
  const mt = runValue(collapsingTopMargin(body, rootW));
  // …and `<body>`'s own declared height counts, exactly as any other block's: `body { height:
  // 3000px }` is how a page makes itself scrollable, and taking the flow height instead left the
  // document as tall as its content and the scrollable range at zero.
  const bodyDeclH = resolveLayoutProp(body, 'height', vp.height);
  const bodyDeclW = resolveLayoutProp(body, 'width',  rootW);
  layoutElement(body, {
    x: ml, y: mt, width: bodyDeclW != null ? bodyDeclW : Math.max(0, rootW - ml - mr),
    height: bodyDeclH != null ? bodyDeclH : 0, autoHeight: bodyDeclH == null
  }, ctx);
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
    // …and the floats, which the ROOT contains even though `<body>` does not (Chrome: a 2000px
    // float in the body leaves `body` 493 tall and `documentElement` 2000).
    const consumed = Math.max(bodyRendered ? bb.y + bb.height + runValue(collapsingBottomMargin(body, rootW)) : 0,
                              floatsBottom(ctx.floats));
    // The root box stays viewport-wide however wide the body is — Chrome reports 1024 for
    // `body { width: 3000px }`; the sideways scroll comes from the extent union below, not here.
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
// The baseline read re-enters geometry (`isRendered`), which re-enters this pass — already stamped
// fresh by then, so it returns at once with the PREVIOUS pass's boxes, but the seeding must not
// run again from inside itself.
let FLUSHING_STYLE = false;

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
export function layoutGeneration() {
  // The dirty sequence for the same reason as the pass gate's third key: scoped dynamic-state
  // marks move neither counter, and the IntersectionObserver recheck early-returns on this.
  // Defensive in practice — a settle step usually moves settleGen before the next rendering
  // update anyway — but a microtask-only turn between a flip and a recheck would slip through.
  // The scoped-state hook is invoked too: `ds` only moves once a sweep RUNS, and a flip nobody
  // read geometry after would otherwise sit undetected behind this early return.
  if (globalThis.__csimApplyScopedStateDirty) globalThis.__csimApplyScopedStateDirty();
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
function layoutChildren(el) {
  // A replaced element renders its own bitmap or widget and NEVER its contents: a `<canvas>`'s
  // fallback content, an `<iframe>`'s "your browser doesn't support frames" markup and a
  // `<video>`'s fallback are all in the DOM and generate no boxes at all. Until the painter drew
  // a canvas this was invisible; then every canvas WPT reftest showed its fallback text painted
  // OVER the drawing. The same set gates visibility and visible text (cascade.js), so a node that
  // has no box also can't be found or read.
  if (hasFallbackOnlyContent(el)) return NO_CHILDREN;
  const sr = el._shadowRoot;
  if (sr) return sr._children || [];
  if (el._tag === 'slot' && typeof el.assignedNodes === 'function') {
    const assigned = el.assignedNodes();
    if (assigned && assigned.length) return assigned;   // else the slot's own children = fallback
  }
  return el._children || [];
}

// A box that CONTAINS the out-of-flow boxes inside it whatever its own `position` is: one with a
// transform, a filter, a perspective, layout / paint containment, or a `will-change` naming any of
// those (css-position §fixpos-cb / css-transforms §transform-rendering). It is the containing
// block for FIXED descendants too, which is the only thing that ever takes one off the viewport —
// Chrome-measured: `top: 10%` on a fixed box inside a `transform: scale(1)` 300px-tall block is
// 30px, where the viewport would make it 76.8.
//
// Each property is behind the rule index and the whole answer is memoised per pass, but that is
// not what keeps this cheap on a real page — app sheets declare `transform` constantly. What does
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
function containsOutOfFlow(el) {
  if (memoFresh(el, '_lbCofPass')) return el._lbCof;
  el._lbCofPass = memoStamp(el);
  return (el._lbCof = computeContainsOutOfFlow(el));
}
function declaresNonNone(el, prop) {
  if (!declaresLayoutProp(el, prop)) return false;
  const v = declaredValue(el, prop);
  return v != null && String(v).trim().toLowerCase() !== 'none';
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
  if (declaresLayoutProp(el, 'will-change')) {
    const v = declaredValue(el, 'will-change');
    // Whole NAMES, not substrings: `will-change: transform-origin` names no containing property
    // (Chrome-measured), and `\btransform\b` matched inside it.
    if (v && String(v).split(',').some((name) => WILL_CHANGE_CONTAINING.has(name.trim().toLowerCase()))) {
      return true;
    }
  }
  return false;
}
// css-transforms §transformable-element: everything but a non-replaced inline box and the table
// column boxes — and a box that is not generated at all.
function isTransformable(el) {
  const disp = displayOf(el);
  if (disp === 'contents' || disp === 'none') return false;
  if (disp === 'table-column' || disp === 'table-column-group') return false;
  return disp !== 'inline' || !!intrinsicSize(el);
}

// The element an out-of-flow box resolves against: the nearest POSITIONED ancestor that has been
// laid out — or, whatever its own position, one that CONTAINS out-of-flow boxes, which is the only
// answer a fixed box takes. `null` when there is none: the box is positioned against the initial
// containing block, i.e. the viewport.
function containingBlockElementFor(el, fixed) {
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    // `display: contents` generates no box, so it is nobody's containing block however it is
    // positioned or transformed.
    if (!p._lb || p.nodeType !== NODE_ELEMENT || displayOf(p) === 'contents') continue;
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
// These are CONTENT boxes: `usedSize` adds the element's own edges, and a control's UA border and
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
  // An `<audio>` is a box only while it shows controls (`uaDisplay` hides the rest), and then it
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
const LABEL_BREAK_RE = /\r\n|\r|\n/;
function buttonInputSize(el, label) {
  if (!label) return { width: 0, height: lineHeightOf(el) };
  const lines = String(label).split(LABEL_BREAK_RE);
  let width = 0;
  for (const line of lines) width = Math.max(width, measureRun(line, el));
  return { width, height: lines.length * lineHeightOf(el) };
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

function intrinsicSize(el) {
  const t = el._tag;
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
  const vb = parseViewBox(el);
  el._lbSvg = vb ? { width: vb.width, height: vb.height, ratio: true, ratioOnly: true } : OBJECT_SIZE;
  el._lbSvgPass = memoStamp(el);
  return el._lbSvg;
}
// The `viewBox="minX minY width height"` presentation attribute, as a positive ratio.
function parseViewBox(el) {
  const raw = el._attrs && el._attrs.viewBox;
  if (raw == null) return null;
  const n = String(raw).trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || !n.every((v) => isFinite(v))) return null;
  return (n[2] > 0 && n[3] > 0) ? { width: n[2], height: n[3] } : null;
}

// The used border-box size of `el`: its declared width/height, else its intrinsic size, else the
// caller's auto fallback. `autoHeight` reports that the height really is auto — stamped on the
// box, because a declared `height: 0` is otherwise indistinguishable from one still to be filled,
// and an absolute child waiting for its containing block's height must not wait on the first. So
// the caller can
// back-fill it from content (an explicit `height: 0` stays 0).
function usedSize(el, autoW, autoH, cbW = autoW, cbH = null) {
  let w = resolveLayoutProp(el, 'width', cbW);
  const h = resolveLayoutProp(el, 'height', cbH);
  const intrinsic = intrinsicSize(el);
  // A DECLARED size is the content box unless `box-sizing: border-box` — the border
  // box the caller wants adds the edges back on. An AUTO width already arrives as a
  // border-box figure (the containing block's content width), so it is left alone.
  const edge = edgeInsets(el, cbW);
  const extraW = edge.left + edge.right, extraH = edge.top + edge.bottom;
  // `width: min-content` / `max-content` / `fit-content` on a block: the box is as wide as its
  // content asks (Chrome: a `max-content` div holding "aa bb" is 48.02 wide, `min-content` 19.2),
  // `fit-content` the max-content width clamped to the room, never below min-content.
  if (w == null) {
    const keyword = widthKeyword(el);
    if (keyword) {
      const iw = intrinsicWidths(el);                                   // border-box figures
      const box = keyword === 'min-content' ? iw.min
                : keyword === 'max-content' ? iw.max
                : Math.max(iw.min, Math.min(iw.max, autoW));
      w = isBorderBox(el) ? box : box - extraW;
    }
  }
  const grow = (w != null || h != null) && !isBorderBox(el);
  // `ratioOnly` marks an intrinsic RATIO with no intrinsic size — an `<svg viewBox>`. Its auto
  // width fills the containing block exactly as a non-replaced block's does; only the ratio then
  // gives the height.
  const sized = intrinsic && !intrinsic.ratioOnly;
  let width  = w != null ? w + (grow ? extraW : 0) : (sized ? intrinsic.width  + extraW : autoW);
  let height = h != null ? h + (grow ? extraH : 0) : (sized ? intrinsic.height + extraH : autoH);
  // The intrinsic ratio relates the two CONTENT boxes, so the element's own edges come off before
  // it is applied and back on after — everything here is a border-box figure (Chrome: a
  // `viewBox="0 0 100 200"` svg with 10px padding and a 5px border is 800x1570 in an 800px block,
  // and 80x130 with `width: 50px`, not the 80x100 the content-box figure alone gives).
  const ratio = intrinsic && intrinsic.ratio && intrinsic.width > 0 && intrinsic.height > 0
              ? intrinsic.width / intrinsic.height : 0;
  const heightFor = (bw) => Math.max(0, bw - extraW) / ratio + extraH;
  const widthFor  = (bh) => Math.max(0, bh - extraH) * ratio + extraW;
  // One axis given and the other auto on a replaced element: the missing one follows the ratio
  // (`<img width="500">` on a 4:3 image is 375 tall, not 150). Both auto on a RATIO-ONLY box: the
  // width filled the container above, so the height is whatever the ratio makes of it (Chrome: a
  // `viewBox="0 0 4 3"` svg in a 1000px block is 750 tall, not the 150 of the default object size).
  if (ratio) {
    if (h == null && (w != null || intrinsic.ratioOnly)) height = heightFor(width);
    else if (w == null && h != null)                     width  = widthFor(height);
  }
  // …then `min-*` / `max-*` clamp it (CSS 2.1 §10.4 / §10.7), which applies to an AUTO
  // size too: `max-width: 40em` on a block that would otherwise fill its container is
  // how most page shells cap their measure, and taking the container's width there put
  // every one of them at full bleed. `min` wins a contradiction, as the spec says.
  // The HEIGHT is clamped where it is FINAL, at the end of `layoutElementInner` — an auto height
  // is a 0 placeholder here that the flow back-fills, and clamping the placeholder froze the box
  // at its `min-height` however tall its content grew (`min-height: 100vh` on a page shell put
  // every following sibling under the fold). The basis travels with the element for that clamp.
  el._lbCbH = cbH;
  if (ratio) {
    // A box with a ratio has BOTH axes already, and a clamp on one of them scales the other with
    // it — `img, svg { max-width: 100% }`, which every CSS reset carries, has to shrink a too-wide
    // box, not squash it (Chrome: a 200x100 canvas in an 80px block is 80x40, where clamping the
    // width alone left it 80x100).
    const clamped = clampWithRatio(el, width, height, cbW, cbH, extraW, extraH, w == null, h == null);
    width = clamped.width; height = clamped.height;
  } else {
    width = clampToMinMax(el, width, 'width', cbW, extraW);
    if (h != null || intrinsic) height = clampToMinMax(el, height, 'height', cbH, extraH);
  }
  // A BORDER box is never smaller than the border and padding inside it — the content box floors
  // at zero, it does not go negative. Only reachable on a box whose declared (or clamped) size is
  // its border box, which the UA sheet now makes every `<button>` and `<select>`: Chrome gives
  // `<button style="width: 5px">` 16, the width of its own chrome, where this said 5.
  if (isBorderBox(el)) {
    width = Math.max(width, extraW);
    if (h != null || intrinsic) height = Math.max(height, extraH);
  }
  return { width, height, autoWidth: w == null && !intrinsic, autoHeight: h == null && !intrinsic };
}

// Clamp a used size by the element's own `min-*` / `max-*`. Both are border-box
// figures for the caller, so a content-box declaration adds the edges back on
// exactly as the size itself did. `none` (max) and `auto` (min) don't constrain.
function clampToMinMax(el, size, axis, basis, extra) {
  if (!mayConstrainSize(el)) return size;
  const dv = declaredValueEntry(el);
  const max = resolveLayoutProp(el, 'max-' + axis, basis, null, dv);
  const min = resolveLayoutProp(el, 'min-' + axis, basis, null, dv);
  if (max == null && min == null) return size;
  const edges = isBorderBox(el) ? 0 : extra;
  let out = size;
  if (max != null && max >= 0) out = Math.min(out, max + edges);
  if (min != null && min >= 0) out = Math.max(out, min + edges);
  return out;
}

// CSS 2.1 §10.4's constraint table, for a box whose two axes are tied by an intrinsic ratio: clamp
// each axis, then let whichever clamp binds hardest win — the other axis follows the ratio and is
// clamped in turn, which is all the table's `max(min-height, …)` rows say. Two clamps pulling
// opposite ways (too wide AND too short) is the one case no ratio can satisfy, and there both hold.
//
// Only an AUTO axis follows, though: a size the page asked for is not the ratio's to move (Chrome,
// on a 16x16 image: `max-width: 10px; max-height: 6px` is 6x6, where `max-width: 10px;
// height: 30px` is 10x30 and `min-width: 30px; height: 10px` is 30x10).
function clampWithRatio(el, width, height, cbW, cbH, extraW, extraH, autoW, autoH) {
  const clampW = (bw) => clampToMinMax(el, bw, 'width',  cbW, extraW);
  const clampH = (bh) => clampToMinMax(el, bh, 'height', cbH, extraH);
  const cw = Math.max(0, width - extraW), ch = Math.max(0, height - extraH);
  // The scale each clamp asks for, measured on the CONTENT box the ratio applies to.
  const sw = cw > 0 ? (clampW(width)  - extraW) / cw : 1;
  const sh = ch > 0 ? (clampH(height) - extraH) / ch : 1;
  const scale = autoW && autoH ? (sw === 1 ? sh : sh === 1 ? sw
                                : (sw < 1) !== (sh < 1) ? 0
                                : sw < 1 ? Math.min(sw, sh) : Math.max(sw, sh))
              : autoH ? sw : autoW ? sh : 0;
  if (scale === 0 || scale === 1) return { width: clampW(width), height: clampH(height) };
  return { width: clampW(cw * scale + extraW), height: clampH(ch * scale + extraH) };
}

function positionOf(el) {
  if (memoFresh(el, '_lbPosPass')) return el._lbPos;
  el._lbPosPass = memoStamp(el);
  return (el._lbPos = computePosition(el));
}
function computePosition(el) {
  const p = declaredValue(el, 'position');
  const v = p ? String(p).trim().toLowerCase() : 'static';
  // Noted here because every laid-out box passes through: until a page HAS EVER had a sticky
  // box, `scrollShift` — behind every rect read — skips the sticky walk on one property read.
  if (v === 'sticky' && globalThis.document) globalThis.document._sawSticky = true;
  return v;
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
// …and a width the page never gave a LENGTH still has one: `thin` / `medium` / `thick` are real
// widths, and so is the initial `medium` a bare `border-style: solid` leaves behind (Chrome gives
// that div a 3px border; taking only lengths measured it as 0).
const BORDER_WIDTH_KEYWORD_PX = { thin: 1, medium: 3, thick: 5 };
function usedBorderWidth(el, side, cbW, info, dv) {
  const style = declaredValueIn(dv, el, 'border-' + side + '-style') ??
                uaDefault(el, 'border-' + side + '-style');
  const t = style ? String(style).trim().toLowerCase() : '';
  if (!t || t === 'none' || t === 'hidden') return 0;
  const declared = declaredValueIn(dv, el, 'border-' + side + '-width') ??
                   uaDefault(el, 'border-' + side + '-width');
  if (declared != null) {
    const keyword = BORDER_WIDTH_KEYWORD_PX[String(declared).trim().toLowerCase()];
    if (keyword !== undefined) return keyword;
  }
  const bw = resolveLayoutProp(el, 'border-' + side + '-width', cbW, info, dv);
  // No width at all means the initial `medium`, which is 3px wherever the style paints — and a
  // width that IS given is used at whole-px granularity, the same flooring the computed value
  // reports (a 10pt border makes a 100px box 126px wide in Chrome, not 126.67).
  return bw == null ? BORDER_WIDTH_KEYWORD_PX.medium : usedLineWidthPx(bw);
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
  if (memoFresh(el, "_lbEdgePass") && (!el._lbEdgePct || el._lbEdgeCb === cbW)) return el._lbEdge;
  const e = { top: 0, right: 0, bottom: 0, left: 0, mt: 0, mr: 0, mb: 0, ml: 0, bt: 0, br: 0, bb: 0, bl: 0,
              autoMargins: 0 };
  const halve = halvesBorders(el);
  const info = EDGE_INFO;          // not re-entrant: nothing below calls back in here
  info.percent = false;
  // One memo entry serves the whole 12-16-property burst below (rule 3: this is the hottest
  // read cluster in a layout pass, and the per-read entry bookkeeping was ~29% of its time).
  const dv = declaredValueEntry(el);
  for (const side of SIDES) {
    const pad = resolveLayoutProp(el, 'padding-' + side, cbW, info, dv) || 0;
    let bw = usedBorderWidth(el, side, cbW, info, dv);
    if (halve) {
      // A collapsed edge is as wide as the WIDEST declaration on it, and a table's
      // cells face each other: the neighbour's opposite side is the other half of
      // this one. Taking only this cell's own side halved every row of a
      // `td { border-top: 1px }` table (the Bootstrap shape) — 0.5px short each,
      // which is 10px down a 20-row list.
      const facing = usedBorderWidth(el, OPPOSITE_SIDE[side], cbW, info, dv);
      if (facing > bw) bw = facing;
    }
    if (halve) bw /= 2;         // …and owns half of it
    e[side] = pad + bw;
    e[BORDER_KEY[side]] = bw;   // the border alone — the client box / scroll origin
    // A margin that doesn't RESOLVE is the only one that can be `auto`, so the keyword lookup —
    // which the auto-margin distribution below needs — is paid only there, not on every side of
    // every box. The box model itself reads `auto` as zero, which is what CSS says it is
    // everywhere except the two places that distribute it.
    const m = resolveLayoutProp(el, 'margin-' + side, cbW, info, dv);
    e[MARGIN_KEY[side]] = m || 0;
    if (m == null && marginIsAuto(el, side, dv)) e.autoMargins = (e.autoMargins || 0) | AUTO_MARGIN_BIT[side];
  }
  el._lbEdge = e;
  el._lbEdgePct = info.percent;
  el._lbEdgeCb = cbW;
  el._lbEdgePass = memoStamp(el);
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
    const v = declaredValue(cur, 'box-sizing') ?? uaDefault(cur, 'box-sizing');
    const s = v == null ? '' : String(v).trim().toLowerCase();
    if (s === 'border-box') return true;
    if (s === 'content-box') return false;
    if (s !== 'inherit') return false;      // undeclared → the initial content-box
    cur = cur._parent;
  }
  return false;
}

// The used LEFT margin of a box that QUALIFIES for auto-margin distribution: what `edgeInsets`
// resolved, unless a horizontal margin is `auto` and the box leaves room. Only two kinds of box
// qualify — an in-flow non-replaced BLOCK-LEVEL one (CSS 2.1 §10.3.3) and an absolutely positioned
// one with BOTH insets given (§10.3.7) — and the two call sites below are exactly those. Everywhere
// else `auto` computes to ZERO: on a float (§10.3.5), on an inline-block (§10.3.9), on an inline
// box (§10.3.1). Distributing regardless MOVED those boxes — a `float: left; margin: 0 auto` sat
// 462px in where Chrome puts it at 0 — so the callers gate it, and what they decide is STAMPED on
// the box for `getComputedStyle` to read back rather than re-derived there (one geometry: a flex
// item reported a 200px margin while its rect said x=0).
const AUTO_MARGIN_BIT = { top: 1, right: 2, bottom: 4, left: 8 };
// …and the two AXES, for the placement loops: which side an auto margin is on decides which axis
// it takes the slack from, and asking that per item was two calls and two string lookups.
const AUTO_MARGIN_Y = AUTO_MARGIN_BIT.top | AUTO_MARGIN_BIT.bottom;
const AUTO_MARGIN_X = AUTO_MARGIN_BIT.left | AUTO_MARGIN_BIT.right;
const hasAutoMargin = (e, side) => (e.autoMargins & AUTO_MARGIN_BIT[side]) !== 0;

// One `auto` margin takes the slack the box leaves; two split it. CSS 2.1 §10.3.3 for an in-flow
// block, §10.3.7 / §10.6.4 for an absolutely positioned box between two insets, and the flex CROSS
// axis — one rule, asked per axis, because the three used to be three near-identical functions and
// the vertical one answered only half the question.
function autoMarginSplit(edges, lead, trail, available, borderBoxSize) {
  const lm = MARGIN_KEY[lead], tm = MARGIN_KEY[trail];
  const leadAuto = hasAutoMargin(edges, lead), trailAuto = hasAutoMargin(edges, trail);
  if (!leadAuto && !trailAuto) return { lead: edges[lm], trail: edges[tm] };
  // The leftover is what the box doesn't take.
  const spare = available - borderBoxSize - (leadAuto ? 0 : edges[lm]) - (trailAuto ? 0 : edges[tm]);
  // OVER-CONSTRAINED (§10.3.3): a box bigger than the room it is given has a NEGATIVE remainder,
  // and in LTR the equation is balanced by the TRAILING margin — Chrome reports `-100px` for
  // `width: 600px; margin: 0 auto` in 500px, not the zero an "auto means nothing spare" reading
  // gives. The leading margin still takes 0, so the box stays flush against the start edge.
  if (!(spare > 0)) return { lead: leadAuto ? 0 : edges[lm], trail: trailAuto ? spare : edges[tm] };
  if (leadAuto && trailAuto) return { lead: spare / 2, trail: spare / 2 };
  return leadAuto ? { lead: spare, trail: edges[tm] } : { lead: edges[lm], trail: spare };
}
function isFloated(el) {
  // The rule-index gate first (rule 3): this is asked for every element a layout pass touches, and
  // almost no page declares `float` at all. An `align` attribute is the other door onto the
  // property (HTML's presentational hint), so an element carrying one is asked properly.
  if (!declaresLayoutProp(el, 'float') && !(el._attrs && el._attrs.align != null)) return false;
  const f = declaredValue(el, 'float');
  if (f == null) return false;
  const v = String(f).trim().toLowerCase();
  if (v !== 'left' && v !== 'right' && v !== 'inline-start' && v !== 'inline-end') return false;
  // §9.7: `float` computes to `none` on an out-of-flow box — an absolutely positioned box is
  // POSITIONED, not floated (Chrome: it sits at its insets and shortens no lines at all) — and a
  // box that is never generated cannot float either (`display: contents; float: left` lays its
  // children out in the flow around it, Chrome-measured).
  if (!generatesBox(el)) return false;
  const pos = positionOf(el);
  return pos !== 'absolute' && pos !== 'fixed';
}
// Is this side's margin the `auto` keyword? (`resolveLayoutProp` answers null for
// it, which the box model reads as zero — the distinction only matters here.)
function marginIsAuto(el, side, dv) {
  const v = declaredValueIn(dv, el, 'margin-' + side);
  return v != null && String(v).trim().toLowerCase() === 'auto';
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

// The shift LAYOUT folded into a box, remembered on the box's element. The flow position it moved
// from is otherwise gone by the time anything reads `_lb`, and the scrollable overflow region needs
// it: a relatively-positioned child extends its scroll container's region from where it SITS, but
// the container's end padding follows the position it was laid out at (Chrome: `left: 40px` on a
// 110px child in a `padding: 10px` scroller reports 160 — the shifted edge, with no padding after
// it — while `left: 5px` reports 130, the unshifted edge plus the padding).
//
// Only the callers that APPLY the shift may record it. `relativeOffset` itself is also the CSSOM
// side of `top` / `left` (`computeUsedInsets` asks it for STICKY boxes too, whose shift is never
// folded into `_lb` at all, and against a different containing block), so stamping in there let a
// `getComputedStyle(el).top` read poison the next pass's region.
function flowShift(el, rel) {
  el._lbRel = rel && (rel.x || rel.y) ? rel : null;
  el._lbRelPass = memoStamp(el);
  return rel;
}
// The USED display: author inline style, stylesheet, then the per-tag UA default — so the engine
// can tell a `<span>` from a `<div>` without the page saying so. Memoised per layout pass (the box
// stamp is thrown away with it), since every child asks once and the resolver walks the cascade.
function displayOf(el) {
  if (memoFresh(el, "_lbDispPass")) return el._lbDisp;
  el._lbDispPass = memoStamp(el);
  const d = computeUsedDisplay(el);
  // A widget's BOX is the UA's, not the page's: `<button style="display: table">` is still a
  // flow-root block (`button-layout/display-other`, 18 subtests). A USED-value rule only — the
  // COMPUTED value keeps the keyword the page wrote, which `button-layout/computed-style` pins in
  // 162 more, so this deliberately does not live in `blockify` beside the computed rule.
  el._lbDisp = WIDGET_TAGS.has(el._tag) && WIDGET_BLOCK_DISPLAYS.has(d) ? 'block' : d;
  return el._lbDisp;
}
// Only the block-level spellings are overridden — a `display: flex` button really is a flex
// container, and every inline-level keyword keeps the widget on its line.
const WIDGET_BLOCK_DISPLAYS = new globalThis.Set([
  'run-in', 'flow', 'flow-root', 'table', 'table-row-group', 'table-header-group',
  'table-footer-group', 'table-row', 'table-cell', 'table-column-group', 'table-column',
  'table-caption', 'ruby-base', 'ruby-text', 'ruby-base-container', 'ruby-text-container'
]);
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
  return blockify(el, resolveCascadeDisplay(el) || uaDisplay(el) || 'block');
}
const INLINE_LEVEL = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table']);
function isInlineLevel(el) { return INLINE_LEVEL.has(displayOf(el)); }

// A child only a BLOCK formatting context knows how to place — everything else in a
// block's children (text, `<br>`, an out-of-flow box, an inline-level one) is placed on
// a line. `placeInlineChild` hands exactly these back and `isContinuedInline` refuses to
// fragment a box that has one, so between them nothing goes unplaced. (`<br>` is the one
// asymmetry: the line path takes it before reading its display, so an author
// `br { display: block }` reads as block-level here and is still handled there — which
// costs the box its fragmentation, not its placement.)
function isOutOfFlowChild(node) {
  const pos = positionOf(node);
  return pos === 'absolute' || pos === 'fixed';
}

function isBlockLevelChild(node) {
  if (node.nodeType !== NODE_ELEMENT || selfNotRendered(node)) return false;
  if (isOutOfFlowChild(node) || isInlineLevel(node)) return false;
  // A FLOAT is hoisted out of the inline box it was written in (`placeInlineChild`), so it is no
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
  const f = el._lbFrags;
  if (!f) return el._lb;
  const first = f[0], last = f[f.length - 1];
  return { x: first.x, y: first.y,
           width: last.x + last.width - first.x, height: last.y + last.height - first.y };
}

// Is this box one that fragments across lines rather than sitting on one? A
// non-replaced `display: inline` box holding only inline content is: the line breaks
// inside it, and the box a browser reports is the union of the pieces. Anything else
// inline-level — `inline-block`, `inline-table`, an image, a form control — is ATOMIC:
// it takes a single rectangle on one line, and so does an inline holding a block,
// which a real browser splits into anonymous blocks and we do not.
function isContinuedInline(el) {
  if (displayOf(el) !== 'inline' || intrinsicSize(el)) return false;
  for (const child of layoutChildren(el)) {
    if (isBlockLevelChild(child)) return false;
  }
  return true;
}

// Place an out-of-flow (absolute/fixed) child against its containing block; `staticY` is the flow
// position an `auto` top falls back to. Does NOT advance the parent's flow.
// The inline boxes being fragmented right now, innermost last: each entry carries the box's
// relative offset and the list its block settles. This is a PASS-level stack rather than a
// per-block one because a box nested one layout deeper — an `<i>` inside an `inline-block`
// inside the inline, the everyday dropdown — is still inside the inline, and placing it there
// resolved it against a containing block that had no geometry yet.
const OPEN_INLINE_BOXES = [];

// Boxes laid out RIGHT NOW, and the out-of-flow boxes waiting for one of them to finish. A
// percentage inset resolves against the containing block's used size, and an auto-height box
// only knows that once its own content is laid out — placed during the child loop, a
// `top: 100%` dropdown resolved against 0 and opened ON its trigger instead of under it.
const LAYING_OUT = new globalThis.Set();
const PENDING_BY_CB = new globalThis.Map();

// `staticAlign`, when given, is a `(width, height) => [x, y]` the CALLER supplies for a static
// position that depends on the box's own size — a flex container's abspos child takes its from the
// container's ALIGNMENT (§4.1), and the size that alignment centres is this box's own.

// Mark every box BETWEEN an out-of-flow box and the containing block it is anchored to. Such a box
// cannot hand its subtree back to a later pass (`reuseSubtree`): the out-of-flow descendant inside
// it is positioned against a containing block further up, so it neither travels when the subtree
// is shifted nor keeps its offsets when that containing block resizes — and it is only ever
// re-placed from inside an ancestor that is really laid out. A fixed box has no containing element
// at all, so the mark runs to the root. Nothing else carries it: on an app page, a handful of
// elements per dropdown or dialog.
function noteEscapingAbs(child, cbEl) {
  // …up the FLAT tree, because that is the chain of boxes the out-of-flow one actually sits in
  // (`containingBlockElementFor` found `cbEl` the same way). A `_parent` walk marks the light-DOM
  // ancestors of a slotted box instead of the slot and shadow boxes between it and its containing
  // block — and, when `cbEl` is not on that chain at all, never meets its terminator.
  for (let n = flatTreeParent(child); n && n !== cbEl; n = flatTreeParent(n)) n._lbEscAbs = true;
}

// The box whose FLOW places these children: `display: contents` generates none of its own, so the
// answer is the nearest ancestor that does. A `<slot>` is the everyday case — its assigned children
// are laid out by the box around it, and its own `dir` does not turn them around.
function flowContainer(el) {
  let node = el;
  while (node && node.nodeType === NODE_ELEMENT && displayOf(node) === 'contents') {
    const parent = flatTreeParent(node);
    if (!parent || parent.nodeType !== NODE_ELEMENT) break;
    node = parent;
  }
  return node;
}

// HTML's `align` attribute on a block (`<div align=center>`, `<p align=right>`, the headings) and
// `<center>` also align the block-level DESCENDANTS (rendering §15.3.3 "align descendants"), which
// no computed value carries — Chrome's is the `-webkit-center` it computes, the spec's is the plain
// keyword. The nearest such ancestor-or-self decides; asked only on a page that has one (the
// `__csimLineAlignHint` latch), and once per block. (An author `text-align` on a block in between
// would cancel it in Chrome; not modelled.)
const LEGACY_ALIGN_TAGS = new globalThis.Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LEGACY_ALIGNS = Object.assign(Object.create(null), { left: 'left', right: 'right', center: 'center', middle: 'center' });
function legacyDescendantAlign(el) {
  for (let node = el; node && node.nodeType === NODE_ELEMENT; node = flatTreeParent(node)) {
    if (node._tag === 'center') return 'center';
    if (!LEGACY_ALIGN_TAGS.has(node._tag)) continue;
    const raw = node._attrs && node._attrs.align;
    const v = raw == null ? undefined : LEGACY_ALIGNS[String(raw).trim().toLowerCase()];
    if (v) return v;
  }
  return null;
}

// The STATIC POSITION of an out-of-flow box is where the flow would have put it, which on the
// INLINE axis is the container's inline-start edge: in an `rtl` block the line starts at the RIGHT,
// so the box's own right edge goes there (Chrome resolves its `left` to 370 in a 400px rtl
// container, not 30). The BLOCK axis is left alone — it is where the flow has reached, the cursor
// the caller hands in, and turning that around too put a box after a 50px block back at the top.
// `null` — the cursor as it stands — for the ordinary flow, which needs no function at all, and
// for a VERTICAL writing mode: this engine does not run the block flow sideways yet (a
// `vertical-rl` block still stacks its children downwards), and a flow-relative corner for a flow
// that doesn't run that way would put the box where nothing else agrees it is.
function staticCornerFor(sides, content) {
  if (sides['inline-start'] !== 'right' || sides['block-start'] !== 'top') return null;
  return (w, _h, _staticX, staticY) => [content.x + content.width - w, staticY];
}

function placeAbsolute(child, pos, staticX, staticY, ctx, order = null, staticAlign = null) {
  if (OPEN_INLINE_BOXES.length) {
    // Held until the OUTERMOST open inline has settled — until then one of the boxes around
    // this one may be its containing block and still have no geometry. Its paint order is
    // taken NOW, where the box sits in tree order, because that is what decides which of two
    // overlapping boxes is on top; laying it out later would put it above its own successors.
    // The static position moves with every relative inline it sits in, the same as the content
    // around it, and those offsets are applied to that content at settle time — long after
    // this position was read off the line.
    let dx = 0, dy = 0;
    for (const open of OPEN_INLINE_BOXES) if (open.rel) { dx += open.rel.x; dy += open.rel.y; }
    const entry = {
      child, pos, staticX: staticX + dx, staticY: staticY + dy, ctx, order: ctx.order++,
      // …and the same shift applies to an ALIGNED static position, which is computed from the
      // container's box and knows nothing about the relative inlines around it.
      staticAlign: staticAlign && ((w, h, sx, sy) => { const p = staticAlign(w, h, sx, sy); return [p[0] + dx, p[1] + dy]; })
    };
    OPEN_INLINE_BOXES[0].deferred.push(entry);
    return entry;
  }
  const cbEl = containingBlockElementFor(child, pos === 'fixed');
  // Its containing block is still being laid out and has no height yet — wait for it.
  if (cbEl && cbEl._lb.height === 0 && cbEl._lb.autoHeight !== false && LAYING_OUT.has(cbEl)) {
    const waiting = PENDING_BY_CB.get(cbEl);
    const entry = { child, pos, staticX, staticY, ctx, order: order == null ? ctx.order++ : order,
                    staticAlign };
    if (waiting) waiting.push(entry); else PENDING_BY_CB.set(cbEl, [entry]);
    return entry;
  }
  const cb = containingBlockBox(cbEl);

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
  // A margin is part of what fills the gap between two insets, so a stretched box is that gap LESS
  // its own margins: `inset: 0; margin: 10px` in a 400x300 block is 380x280 in Chrome, not 400x300
  // hanging 20px past both far edges.
  const cm = edgeInsets(child, cb.width);
  const stretched = left != null && right != null;
  const stretchedV = top != null && bottom != null;
  const availW = Math.max(0, cb.width - (left || 0) - (right || 0));
  const availH = stretchedV ? Math.max(0, cb.height - top - bottom) : 0;
  const autoW = stretched || ratioOnlyBox(child) ? Math.max(0, availW - cm.ml - cm.mr)
                                                 : shrinkToFitWidth(child, availW);
  const autoH = stretchedV ? Math.max(0, availH - cm.mt - cm.mb) : 0;
  const size = usedSize(child, autoW, autoH, cb.width, cb.height);
  // An `auto` inset falls back to the box's STATIC position — where the box would have sat had
  // it stayed in flow, which mid-line is the line cursor, not the containing block's edge (a
  // dropdown anchored to a word in a sentence opens under that word). The opposite inset
  // positions the box's far edge against that edge of the containing block, which is how a
  // bottom-right-pinned box tracks a viewport resize.
  // …and when BOTH insets are given and the box is narrower than the space between
  // them, an `auto` margin takes the slack (CSS 2.1 §10.3.7) — the same rule that
  // centres an in-flow block, and how a modal with `left: 0; right: 0; width: 40em;
  // margin: auto` sits in the middle of the viewport.
  // …and when BOTH insets on an axis are given and the box is smaller than the space between them,
  // an `auto` margin takes the slack — §10.3.7 across, §10.6.4 down. `top: 0; bottom: 0;
  // height: 50px; margin: auto` is how a dialog centres itself vertically.
  // A margin insets the box from whichever edge it is anchored to, `auto` or not: Chrome puts a
  // `left: 20px; margin-left: 30px` box at 50, and a `right: 10px; margin-right: 7px` one 17 in
  // from the right edge. Only a box stretched between BOTH insets has slack for an `auto` margin
  // to take.
  const mx = stretched  ? autoMarginSplit(cm, 'left', 'right', availW, size.width)
                        : { lead: cm.ml, trail: cm.mr };
  const my = stretchedV ? autoMarginSplit(cm, 'top', 'bottom', availH, size.height)
                        : { lead: cm.mt, trail: cm.mb };
  // The static position is asked for its ALIGNED point only now, when the box's own size — the
  // thing that alignment positions — is finally known, and only when an axis actually needs one:
  // a box with both insets given on both axes never reads it, and asking would cost two cascade
  // lookups for a discarded answer.
  const needsStatic = (left == null && right == null) || (top == null && bottom == null);
  const stat = staticAlign && needsStatic ? staticAlign(size.width, size.height, staticX, staticY) : null;
  const cx = left != null ? cb.x + left + mx.lead
           : right != null ? cb.x + cb.width - right - size.width - mx.trail
           : (stat ? stat[0] : staticX);
  const cy = top != null ? cb.y + top + my.lead
           : bottom != null ? cb.y + cb.height - bottom - size.height - my.trail
           : (stat ? stat[1] : staticY);
  // `fixed` is stamped on the box (not re-read from the cascade later): the geometry queries below
  // ask "does an ancestor scroll move this?" on every hit-test, and a flag read is O(1).
  const box = { x: cx, y: cy, width: size.width, height: size.height, autoHeight: size.autoHeight,
                // …`fixed` meaning VIEWPORT-fixed: a fixed box with a containing block of its own
                // scrolls with it, is clipped by it and moves when it moves, exactly as an absolute
                // one does (`scrollShift` / `shiftSubtree` / the clip walk all read this flag).
                fixed: pos === 'fixed' && !cbEl, outOfFlow: true, cbEl,
                // A box placed from the FLOW rather than from its containing block's edges follows
                // whatever moves the flow under it — an inline-block dropped onto its line's
                // baseline carries the dropdown inside it (Chrome: 26 with the box, where leaving
                // it behind put it 26px above its own trigger).
                staticBlock: top == null && bottom == null };
  // A FIXED box is placed from the viewport origin, `shiftSubtree` already leaves it where it is,
  // and a viewport resize rebuilds the cascade (so no memo survives it) — a subtree above it has
  // nothing to get wrong. Unless it takes its position from the FLOW, which a shift does move.
  // Anything anchored to an element keeps the mark: that containing block's origin and its size
  // can both move. Measured on a 40-row panel: marking a fixed dropdown's spine turned an
  // unrelated sibling's mutation from 2 reuses into 42, re-reaching every row.
  if (pos !== 'fixed' || needsStatic) noteEscapingAbs(child, cbEl);
  const from = ctx.order;
  layoutElement(child, box, ctx, cb.width);
  child._lbMargins = { left: mx.lead, right: mx.trail, top: my.lead, bottom: my.trail };
  // A box held back was numbered where it was finally laid out — after every sibling that
  // followed the inline. Its whole SUBTREE moves back into the slot reserved for it at
  // deferral time, keeping its own internal order: numbering only the box left its children
  // painting above the boxes that follow it, and a click on one of those landed inside the
  // dropdown instead.
  if (order != null) renumberSubtree(child, order, from, ctx.order);
  // An auto height isn't known until the child's own flow has been laid out (layoutElement
  // back-fills it), and a text-only out-of-flow box — a tooltip, a toast — gets the same coarse
  // line-height an in-flow one does, else it has a zero-height box and can't be hit at all.
  // Anchored by `bottom` alone, the box was placed against a height we didn't know yet: lift it by
  // what it turned out to be, so its BOTTOM edge — the anchored one — lands where it belongs. (A
  // `right`-anchored auto WIDTH needs no such pass: shrink-to-fit measures the content WITHOUT
  // laying it out, so the width above is already final and the far edge landed correctly.)
  if (bottom != null && top == null && box.height !== size.height) {
    shiftSubtreeY(child, size.height - box.height);
  }
  // What the caller may still move ALONG the line: a box held back (the entry, whose `staticX` is
  // read when it is finally placed) or one placed from the cursor just now (the box itself). The
  // static position is where the flow would have put the box, and the flow does not know where
  // its line ends up until the line closes — a `text-align: right` line moves its boxes at close,
  // and an out-of-flow box that took its static position from that line moves with them (Chrome:
  // 261.59 for an abspos before "abcd" on a right-aligned 300px line, not 0).
  return needsStatic && left == null && right == null ? child : null;
}

// ── Flex layout ──────────────────────────────────────────────────────────────
// One model, two axes. The items' MAIN sizes are resolved together — each item's flex base, then
// the line's free space handed out by `flex-grow` or taken back by `flex-shrink` — and on the CROSS
// axis each item either stretches to the line or is aligned within it. What differs between a row
// and a column is where a base comes from (a row can measure an item's content width without laying
// it out; a column has to lay it out) and which physical edge each logical one is.
//
// `flex-direction`, as the one question left that is about the KEYWORD rather than the axes it
// resolves to (`flexAxisPlan` answers those, from one read): does the line run backwards, which is
// what reverses the ORDER items are gathered in.
function isReverseFlex(el) {
  const d = declaredValue(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase().endsWith('-reverse');
}

// Does this element lay its children out as a flex container? The two display values, asked in one
// place because three passes now need the answer: the dispatch, the intrinsic widths, and the
// atomic-inline sizing that shrinks one to fit.
function laysOutAsFlex(el) {
  const d = displayOf(el);
  return d === 'flex' || d === 'inline-flex';
}

// `flex-wrap`, as the two questions layout asks of it: does the container break into more than one
// line, and does its cross axis run backwards? A MULTI-LINE container is one that says `wrap`, not
// one that happened to need a second line — `align-content` applies to a `wrap` container holding a
// single line (Chrome centres that line: y=35 of a 90px box) and to no `nowrap` one however far it
// overflows.
function flexWrapMode(el) {
  const w = declaredValue(el, 'flex-wrap');
  return w == null ? 'nowrap' : String(w).trim().toLowerCase();
}
function wrapsFlexLines(mode) { return mode === 'wrap' || mode === 'wrap-reverse'; }

// The physical edges each main axis maps onto. A REVERSED line runs the other way, so its
// main-start is the far edge and the margin that LEADS each item is the one on that side
// (Chrome puts two 100px items in a 400px `row-reverse` at 300 and 200, not 100 and 0).
const MAIN_AXES = {
  row:              { lead: 'left',   trail: 'right',  leadM: 'ml', trailM: 'mr', reverse: false, column: false },
  'row-reverse':    { lead: 'right',  trail: 'left',   leadM: 'mr', trailM: 'ml', reverse: true,  column: false },
  column:           { lead: 'top',    trail: 'bottom', leadM: 'mt', trailM: 'mb', reverse: false, column: true },
  'column-reverse': { lead: 'bottom', trail: 'top',    leadM: 'mb', trailM: 'mt', reverse: true,  column: true }
};
const AXIS_FOR_LEAD = {
  left:   MAIN_AXES.row,      right:  MAIN_AXES['row-reverse'],
  top:    MAIN_AXES.column,   bottom: MAIN_AXES['column-reverse']
};

// How this container's flex axes land on the page. `flex-direction` names the axes in FLOW terms —
// `row` is the inline axis, `column` the block one — so which way a line actually runs is a
// question about the container's `writing-mode` and `direction` as much as about the keyword: a
// `vertical-rl` row stacks its items DOWN the page and a `direction: rtl` row packs them from the
// right, both of which Chrome does and neither of which falls out of the keyword alone.
//
// `flexAxisPlan` below resolves that from `flowSides` (the out-of-flow static position has always
// worked this way; the in-flow placement did not), and this turns its two start edges into what the
// placement works in — the physical main axis, the margin sides that LEAD each item along it, and
// whether the cross axis runs towards the far physical edge. The `-reverse` and `wrap-reverse`
// cases fall out of the same two edges, so the keyword flags they used to be read from are gone.
//
// The GAPS stay flow-relative and do not follow the writing mode into a physical axis: `column-gap`
// is the gap along the INLINE axis whatever that axis is, so it is a row's main gap and a column's
// cross gap in every writing mode (Chrome, measured: `column-gap: 20px` on a `vertical-rl` row
// spaces its items vertically, and `row-gap: 20px` on the same container does nothing).
// An orphan `display: table-row` — a row a browser would have wrapped in an anonymous table, and
// we lay out as a flex row instead — has no flex axes to resolve. It gets the plain physical LTR
// row, spelled out in FULL: every field the pass and the out-of-flow placement read is here,
// because a missing one reads as `undefined` and means "not reversed" everywhere except
// `MARGIN_KEY_FOR_SIDE[axes.mainStart]`, where it made the static position NaN.
const PHYSICAL_ROW_PLAN = axisPlan('left', 'top', false, true, 'horizontal-tb', 'row', 'nowrap');

// The plan, spelled as ONE literal in ONE key order — `PHYSICAL_ROW_PLAN` and every computed plan
// come through here, so they share a hidden class and the `axes.*` reads in the placement loops stay
// monomorphic. (Measured: the two literals had diverged by two fields, and one orphan
// `display: table-row` on a page then made every flex container's alignment reads polymorphic.)
function axisPlan(mainStart, crossStart, crossFlip, inlineMain, mode, direction, wrapMode) {
  const column = direction.startsWith('column');
  return {
    mainStart, crossStart, crossFlip, inlineMain, mode, wrapMode,
    mainIsX:   mainStart === 'left' || mainStart === 'right',
    axis:      AXIS_FOR_LEAD[mainStart],
    // `crossFlip` above and `crossFar` here are NOT the same question. `wrap-reverse` is the one
    // the KEYWORDS care about — `start` / `end` are writing-mode relative and stay put where
    // `flex-start` / `flex-end` follow the reversal — while `crossFar` is where the axis physically
    // points, which is what every OFFSET is measured against.
    crossFar:   crossStart === 'right' || crossStart === 'bottom',
    // …and the third reversal, which is neither of those two: `start` / `end` are FLOW relative on
    // the main axis, so they follow `flex-direction`'s `-reverse` and NOT the physical direction an
    // RTL or vertical container sends the axis in (`justifyOffsets`).
    flexReverse: direction.endsWith('-reverse'),
    // Whether `align-items: baseline` has real baselines to align on. It does when the items sit
    // side by side along the INLINE axis — a ROW, in any writing mode — and not in a column, which
    // has none and sends the item to its line's cross-start instead. This follows the FLOW
    // question, not which routine runs: a `vertical-rl` column lays out along X and is still a
    // column (`align-items-baseline-column-vert`).
    //
    // A vertical ROW keeps the keyword without having the geometry: baseline alignment lives in the
    // row routine, and such a container goes through the COLUMN one, where `crossOffset` does not
    // know the keyword and answers 0 — the line's low physical edge. That is an approximation of an
    // unimplemented feature either way (`css-flexbox/alignment/flex-align-baseline-overflow-002`
    // wants real baseline offsets, 70/60/100), and it is the closer of the two: resolving to the
    // cross-START instead cost 36 subtests across the vertical-writing-mode baseline files.
    baselineMode: !column ? 'keep' : 'axis',
    mainGap:    column ? 'row' : 'column',
    crossGap:   column ? 'column' : 'row'
  };
}

// This container's flex axes, resolved through its flow. `flowSides` turns `writing-mode` /
// `direction` into physical sides, so `row` is the inline axis whichever way that runs — vertical
// in a vertical writing mode, right-to-left in an RTL one — and `column` is the block axis.
// `-reverse` takes the far edge of its axis, and `wrap-reverse` does the same to the cross one.
//
// `flex-direction` and `flex-wrap` are each read ONCE here and carried on the plan: this runs per
// flex container per pass (and again from `flexIntrinsicWidths`), and `flex-wrap` in particular is
// absent from nearly every page, which is what `declaresLayoutProp` answers in O(1) (rule 3).
function flexAxisPlan(el) {
  const sides = flowSides(el);
  const direction = String(declaredValue(el, 'flex-direction') || 'row').trim().toLowerCase();
  const wrapMode = declaresLayoutProp(el, 'flex-wrap') ? flexWrapMode(el) : 'nowrap';
  const blockMain = direction.startsWith('column');
  const reverse   = direction.endsWith('-reverse');
  const crossFlip = wrapMode === 'wrap-reverse';
  const main  = blockMain ? (reverse ? 'block-end' : 'block-start') : (reverse ? 'inline-end' : 'inline-start');
  const cross = blockMain ? (crossFlip ? 'inline-end' : 'inline-start') : (crossFlip ? 'block-end' : 'block-start');
  return axisPlan(sides[main], sides[cross], crossFlip, !blockMain, sides.mode, direction, wrapMode);
}

// Could this element have a value for a property almost no page declares? The rule index answers
// for the stylesheets in O(1) (cached per cascade build) and the element's own inline map for the
// rest — the `mayConstrainSize` pattern, for the same reason: one cascade read per ITEM per pass is
// what a flex line cannot afford (rule 3), and `order` / `align-self` are absent from nearly every
// page that has flex on it at all.
function declaresLayoutProp(el, prop) {
  return cascadeDeclaresProperty(prop) || prop in inlineDecls(el) || animationsDeclareProperty(el, prop);
}

// An item's flex factors. The `flex` shorthand is expanded into these longhands by the cascade, so
// reading only the longhands here is what makes declaration order work.
function flexParts(el) {
  if (el._lbFlexPass === layoutPass) return el._lbFlex;
  el._lbFlexPass = layoutPass;
  // A NEGATIVE factor makes the declaration invalid, so the property keeps its initial value —
  // `flex-shrink: -1` shrinks like the 1 it falls back to, it does not freeze the item.
  const num = (v, dflt) => { const n = parseFloat(v); return v != null && isFinite(n) && n >= 0 ? n : dflt; };
  el._lbFlex = {
    grow:   num(declaredValue(el, 'flex-grow'), 0),
    shrink: num(declaredValue(el, 'flex-shrink'), 1)
  };
  return el._lbFlex;
}

// The in-flow items of a flex container, with its out-of-flow children placed on the way past: an
// absolutely positioned child takes the container's content origin as its static position rather
// than a slot on the line.
function flexItems(el, content, ctx, outOfFlow) {
  const items = [];
  let ordered = false;
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    // Held back until the line has been placed: its static position is the container's ALIGNMENT
    // (§4.1), and for an auto-height container the cross size that alignment measures against is
    // not known until the items have been laid out. The paint-order number is taken HERE, where
    // the box sits in tree order, exactly as the inline path does for the boxes it defers.
    if (pos === 'absolute' || pos === 'fixed') { outOfFlow.push({ child, pos, order: ctx.order++ }); continue; }
    const order = orderOf(child);
    if (order !== 0) ordered = true;
    items.push({ child, pos, order, edges: edgeInsets(child, content.width) });
  }
  // `order` (§5.4) reorders the line — and paint order with it, which is why it is applied here
  // rather than at placement: `_lbOrder` is handed out as the items are laid out. `Array#sort` is
  // stable, so items sharing an `order` keep document order, as the spec says.
  if (ordered) items.sort((a, b) => a.order - b.order);
  return items;
}
// …and the flex pass does not place them itself: the container's height is only FINAL after
// `layoutElement` has clamped it by `min-height` / `max-height`, and aligning against the
// unclamped one put a `top: 100%` dropdown inside a `min-height` row at 20 where Chrome says 100.
// So the work is parked on the element and `layoutElement` runs it where it flushes the boxes that
// were waiting on this containing block — after the clamp.
function deferFlexOutOfFlow(el, box, content, ctx, outOfFlow, axes, itemsAlign) {
  el._lbFlexPending = outOfFlow && outOfFlow.length
    ? () => placeFlexOutOfFlow(el, box, content, ctx, outOfFlow, axes, itemsAlign)
    : null;
}

// CSS Flexbox §4.1: an absolutely-positioned child of a flex container takes no part in layout,
// but its STATIC POSITION is where it would sit if it were the sole flex item of the line — the
// container's `justify-content` along the main axis, its own `align-self` across it. So a dropdown
// inside a centred toolbar opens under the centre, not at the toolbar's left edge, which is what a
// page that anchors one to a flex row is relying on.
//
// One item, so the distribution keywords collapse: `space-between` packs at the start,
// `space-around` / `space-evenly` centre — which is exactly what `justifyOffsets` answers for a
// count of one. A NEGATIVE remainder places too (Chrome puts an 8px box in a 4px `justify-content:
// end` container at -4).
const MARGIN_KEY_FOR_SIDE = { top: 'mt', right: 'mr', bottom: 'mb', left: 'ml' };

// A distance measured from `startSide` turned into one from the container's left/top edge.
function alongAxis(startSide, containerSize, fromStart, itemSize) {
  return (startSide === 'left' || startSide === 'top') ? fromStart : containerSize - fromStart - itemSize;
}

function placeFlexOutOfFlow(el, box, content, ctx, outOfFlow, axes, itemsAlign) {
  if (!outOfFlow || !outOfFlow.length) return;
  const edge = edgeInsets(el, box.width);
  // The container's box is final now — an auto height has been filled in — so the cross axis has
  // something to align against.
  const inner = { x: content.x, y: content.y, width: content.width,
                  height: Math.max(0, (box.height || 0) - edge.top - edge.bottom) };
  // The axes as PHYSICAL edges, so an RTL row starts at the right and a `vertical-rl` row runs down
  // the page — the same plan the in-flow items were placed along. `justifyOffsets` and
  // `crossOffset` answer a distance from the axis's own START, which is all the alignment needs to
  // know; only the last step cares which edge that is.
  const axis = axes.axis;
  for (const { child, pos } of outOfFlow) {
    // The paint-order number is taken HERE, in the placement loop, so an out-of-flow child paints
    // ABOVE the in-flow items it shares the container with — which is where a browser puts it
    // (`elementFromPoint` over an `inset: 0` overlay answers the overlay, not the item under it).
    placeAbsolute(child, pos, inner.x, inner.y, ctx, null, (w, h) => {
      // §4.1 aligns the hypothetical item's MARGIN box, so the margins come out of the free space
      // and the border box then sits one lead margin in (Chrome: `justify-content: center` with a
      // 20px left margin puts an 8px box at 106 in a 200px row, not at 96).
      const m = edgeInsets(child, inner.width);
      const mainSize   = axes.mainIsX ? inner.width  : inner.height;
      const crossSize  = axes.mainIsX ? inner.height : inner.width;
      const mainBox    = axes.mainIsX ? w : h;
      const crossBox   = axes.mainIsX ? h : w;
      const mainLead   = m[MARGIN_KEY_FOR_SIDE[axes.mainStart]];
      const crossLead  = m[MARGIN_KEY_FOR_SIDE[axes.crossStart]];
      const mainItem   = mainBox  + mainLead  + m[MARGIN_KEY_FOR_SIDE[OPPOSITE_SIDE[axes.mainStart]]];
      const crossItem  = crossBox + crossLead + m[MARGIN_KEY_FOR_SIDE[OPPOSITE_SIDE[axes.crossStart]]];
      const main  = justifyOffsets(el, mainSize - mainItem, 1, axis, true, axes).lead + mainLead;
      const cross = crossOffset(crossAlign(itemsAlign, child, axes), crossSize, crossItem) + crossLead;
      const x = inner.x + (axes.mainIsX ? alongAxis(axes.mainStart,  inner.width,  main,  w)
                                        : alongAxis(axes.crossStart, inner.width,  cross, w));
      const y = inner.y + (axes.mainIsX ? alongAxis(axes.crossStart, inner.height, cross, h)
                                        : alongAxis(axes.mainStart,  inner.height, main,  h));
      return [x, y];
    });
  }
}

// An item's `order`, as an integer. Zero — the initial value and what anything unparseable means —
// is the overwhelming common case, and it costs one cascade read per item.
function orderOf(el) {
  if (!declaresLayoutProp(el, 'order')) return 0;
  const v = declaredValue(el, 'order');
  if (v == null) return 0;
  const n = parseInt(String(v).trim(), 10);
  return isFinite(n) ? n : 0;
}

// CSS Flexbox §9.7, "resolve the flexible lengths": the line's free space goes to (or comes from)
// the items in proportion to their factors, and each result is clamped by that item's own minimum
// and maximum. An item that hits a clamp is FROZEN and what it gave back is shared out among the
// rest in another round — one pass would leave that space nowhere, and `flex: 1; max-height: 80px`
// beside a plain `flex: 1` in a 300px column makes the second 220 in Chrome, not the 150 an even
// split gives.
//
// `clampOf(i, size)` belongs to the caller because what an item's automatic minimum COSTS differs
// per axis — a row measures its content, a column has to lay the item out — and each knows which
// of its items can be clamped at all.
function resolveFlexibleLengths(bases, inner, parts, available, clampOf) {
  const n = bases.length;
  const sizes = bases.slice();
  // Which way the line flexes is decided ONCE, and from the HYPOTHETICAL sizes — each base already
  // clamped — not from the bases themselves (§9.7.1). A `flex: 1` item bases at 0 and can still be
  // floored at its content: a pane holding 900px of rows next to a 50px header in a 300px column
  // makes that line SHRINK, and Chrome takes the header down to the 18 its own text needs. Reading
  // the bases instead called it a growing line and left the header at 50.
  const hypothetical = bases.map((b, i) => clampOf(i, b));
  let wanted = 0;
  for (const h of hypothetical) wanted += h;
  // An INDEFINITE main size (`available` null — an auto-height column) has no free space either
  // way: the line is as long as its items make it, and each keeps its hypothetical size.
  const room = available == null ? wanted : available;
  const grow = room >= wanted;
  // §9.7.4's SCALED flex shrink factor is weighted by the item's INNER base — its content box.
  // Weighting by the border box instead handed a padded item a bigger share of the deficit than
  // Chrome gives it (150/50 became 133/67 for a 100px basis with 100px of padding beside a bare
  // one).
  const factorOf = (i) => (grow ? parts[i].grow : parts[i].shrink * inner[i]);
  const flexFactorOf = (i) => (grow ? parts[i].grow : parts[i].shrink);
  const frozen = [];
  for (let i = 0; i < n; i++) {
    // §9.7.1: an item that cannot flex the way this line needs is frozen at its hypothetical size,
    // and so is one whose base already violates its clamp in that direction.
    frozen[i] = (grow ? parts[i].grow : parts[i].shrink) <= 0 ||
                (grow ? hypothetical[i] < bases[i] : hypothetical[i] > bases[i]);
    if (frozen[i]) sizes[i] = hypothetical[i];
  }
  const raw = [];
  let initial = null;
  // One round per item at most: each round freezes at least one of them, or ends the loop.
  for (let round = 0; round <= n; round++) {
    let free = room, weight = 0, factors = 0;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) { free -= sizes[i]; continue; }
      free -= bases[i];
      weight += factorOf(i);
      factors += flexFactorOf(i);
    }
    if (weight <= 0) break;
    if (initial == null) initial = free;
    // §9.7.4 step b: flex factors that add up to LESS THAN ONE hand out only that fraction of the
    // INITIAL free space — a lone `flex: 0.5` item takes half the room it is offered, not all of
    // it, and `flex: 0 0.25 200px` in 100px shrinks to 175 rather than to 100.
    let space = free;
    if (factors < 1) {
      const part = initial * factors;
      if (Math.abs(part) < Math.abs(free)) space = part;
    }
    let violation = 0;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      raw[i] = bases[i] + (space * factorOf(i)) / weight;
      sizes[i] = clampOf(i, raw[i]);
      violation += sizes[i] - raw[i];
    }
    if (violation === 0) break;
    // §9.7.4: freeze only the items that violated in the direction of the TOTAL violation. The
    // others keep flexing, now against what those gave up.
    for (let i = 0; i < n; i++) {
      if (!frozen[i] && (violation > 0 ? sizes[i] > raw[i] : sizes[i] < raw[i])) frozen[i] = true;
    }
  }
  return sizes;
}

// Where each item starts along the main axis, measured from the line's main-START — so a reversed
// line reads the same and only the mapping back to a coordinate differs. `auto` main margins take
// the free space before `justify-content` sees any (§9.5): `margin-left: auto` is how a toolbar
// pushes its last button to the far edge.
function mainAxisOffsets(el, items, sizes, gap, free, axis, axes = null) {
  const n = items.length;
  let autos = 0;
  for (const it of items) {
    if (hasAutoMargin(it.edges, axis.lead))  autos++;
    if (hasAutoMargin(it.edges, axis.trail)) autos++;
  }
  // §9.5: `auto` main margins take the free space before `justify-content` sees any — but only
  // when there IS any. With none (or a negative remainder) they resolve to zero and alignment
  // places the line as usual.
  const each = autos > 0 && free > 0 ? free / autos : 0;
  const just = autos > 0 && free > 0 ? ZERO_JUSTIFY : justifyOffsets(el, free, n, axis, false, axes);
  const offsets = [];
  let at = just.lead;
  for (let i = 0; i < n; i++) {
    const it = items[i], e = it.edges;
    if (i > 0) at += gap + just.between;
    // What each `auto` margin RESOLVED to is stamped on the item, because it is also what
    // `getComputedStyle` has to report — one geometry means one margin, not a box at 520 saying
    // its margin is 0.
    it.mainLead  = e[axis.leadM]  + (hasAutoMargin(e, axis.lead)  ? each : 0);
    it.mainTrail = e[axis.trailM] + (hasAutoMargin(e, axis.trail) ? each : 0);
    at += it.mainLead;
    offsets.push(at);
    at += sizes[i] + it.mainTrail;
  }
  return offsets;
}

// Where `justify-content` leaves the free space the items did NOT consume: an offset before the
// first of them and one between each pair. A NEGATIVE remainder — items that overflow their line —
// is placed too: the default overflow alignment is unsafe, so a centred overflowing row starts at
// -50 in Chrome rather than at 0. Only the distribution keywords fall back to packing at the start
// there (measured).
const ZERO_JUSTIFY = { lead: 0, between: 0 };
// `staticPos` asks for §4.1's "as if it were the sole flex item" reading, where a DISTRIBUTION
// keyword falls back to its alignment even when the box overflows: Chrome puts a `space-around`
// static position at -2 in a container 4px narrower than the box, while an in-flow line of the
// same items packs at 0.
// The physical edge `justify-content: left` / `right` names on THIS container's main axis, or null
// where the axis has no such edge. On a horizontal main axis they are themselves. On a vertical one
// they are line-left / line-right — the sides of a line as you face it, which a vertical writing
// mode puts at the top and bottom (`sideways-lr` runs its lines the other way). Where the main axis
// is the BLOCK axis of a horizontal mode they name nothing on it, and CSS Align has them behave as
// `start`. Measured across 320 combinations of writing mode, direction, flex-direction and
// justify-content against Chrome 151.0.7922.169.
function justifyPhysicalTarget(keyword, axes) {
  if (axes.mainIsX) return keyword;
  if (!axes.inlineMain) return null;
  const lineLeft = axes.mode === 'sideways-lr' ? 'bottom' : 'top';
  return keyword === 'left' ? lineLeft : OPPOSITE_SIDE[lineLeft];
}

function justifyOffsets(el, free, count, axis, staticPos = false, axes = null) {
  if (free === 0 || count === 0) return ZERO_JUSTIFY;
  let k = alignKeyword(declaredValue(el, 'justify-content'));
  let physical = false;
  if (k === 'left' || k === 'right') {
    // `left` / `right` are PHYSICAL, so which END of the main axis they name depends on where that
    // axis runs — which only the caller that knows the physical axes can say. Without them, keep
    // the old approximation: on a column they behave as `start`.
    const target = axes ? justifyPhysicalTarget(k, axes) : (axis.column ? null : k);
    if (target === null) k = 'start';
    else if (axes) { k = target === axes.mainStart ? 'flex-start' : 'flex-end'; physical = true; }
  }
  // `start` / `end` are FLOW relative and do NOT follow a reversed main axis the way `flex-start` /
  // `flex-end` do: Chrome packs a `row-reverse` line with `justify-content: start` against the
  // physical left edge — which is that line's main-END. A `left` / `right` already resolved against
  // the physical axis above is past that question.
  // …the FLEX reversal, which on a container whose axes were resolved through its flow is not the
  // same as the axis pointing at the far physical edge: an `rtl` row runs right-to-left and its
  // main-start IS the inline-start, so `start` stays there (Chrome), while `row-reverse` moves it.
  const flowReverse = axes && axes.flexReverse !== undefined ? axes.flexReverse : axis.reverse;
  if (flowReverse && !physical) {
    if (k === 'start' || k === 'left') k = 'flex-end';
    else if (k === 'end' || k === 'right') k = 'flex-start';
  }
  return distributionOffsets(k, free, count, staticPos);
}

// Where a run of things sits in the free space it leaves, once the keyword has been resolved onto
// the axis. Shared by `justify-content` along the main axis and by `align-content` across the lines
// of a wrapping container — the same arithmetic, and CSS Align defines it once.
function distributionOffsets(k, free, count, staticPos = false) {
  switch (k) {
    case 'center':                            return { lead: free / 2, between: 0 };
    case 'end': case 'flex-end': case 'right': return { lead: free, between: 0 };
    case 'space-between': return free > 0 && count > 1 ? { lead: 0, between: free / (count - 1) } : ZERO_JUSTIFY;
    case 'space-around':  return (free > 0 || staticPos) ? { lead: free / count / 2, between: free / count } : ZERO_JUSTIFY;
    case 'space-evenly':  return (free > 0 || staticPos) ? { lead: free / (count + 1), between: free / (count + 1) } : ZERO_JUSTIFY;
    default:              return ZERO_JUSTIFY;
  }
}

// How an item sits on the CROSS axis: its own `align-self`, else the container's `align-items` —
// which the caller has read once for the whole line rather than once per item. The initial
// `normal` is `stretch` for a flex item, and CSS Box Alignment writes each position several ways
// (`start` / `flex-start` / `self-start`), which all mean the same thing on one line.
function crossAlign(containerAlign, child, axes = null, baselineMode = 'flow') {
  const self = declaresLayoutProp(child, 'align-self')
    ? alignKeyword(declaredValue(child, 'align-self'))
    : null;
  const align = (self && self !== 'auto') ? self : containerAlign;
  // `left` / `right` are not <self-position> values at all (CSS Align 3 §6.2): Chrome drops the
  // declaration, so it falls back to `normal`.
  if (align == null || align === 'normal' || align === 'auto' || align === 'left' || align === 'right') return 'stretch';
  // `start` / `end` / `self-start` / `self-end` / `baseline` are WRITING-MODE relative and do NOT
  // follow a reversed cross axis, the way `flex-start` / `flex-end` do — the same distinction
  // `justifyOffsets` makes on the main axis. Measured in a `row wrap-reverse` container: Chrome
  // leaves `align-self: start` at the physical TOP (where `flex-start` has moved to the bottom),
  // and answers `baseline` there too.
  const atStart = (axes && axes.crossFlip) ? 'flex-end'   : 'flex-start';
  const atEnd   = (axes && axes.crossFlip) ? 'flex-start' : 'flex-end';
  // …and `self-start` / `self-end` are relative to the ITEM's own writing mode, not the container's
  // (measured: a `horizontal-tb` child of a `vertical-rl` flex container aligns `self-start` to the
  // container's cross-START, where `start` follows the container).
  if (axes && (align === 'self-start' || align === 'self-end')) {
    const own = flowSides(child);
    const inlineIsX = own['inline-start'] === 'left' || own['inline-start'] === 'right';
    const crossIsX  = axes.crossStart === 'left' || axes.crossStart === 'right';
    let side = (inlineIsX === crossIsX) ? own['inline-start'] : own['block-start'];
    if (align === 'self-end') side = OPPOSITE_SIDE[side];
    return side === axes.crossStart ? 'flex-start' : 'flex-end';
  }
  if (align === 'start' || align === 'self-start') return atStart;
  if (align === 'end'   || align === 'self-end')   return atEnd;
  // `last baseline` aligns the LAST baselines, which for a single-line box means its far edge —
  // Chrome puts a 6px box 4px down a 10px line for it, where plain `baseline` leaves it at 0.
  // A baseline keyword answers in one of three ways, and every caller means a different one.
  // `keep`: a ROW's in-flow items really do align on a shared baseline — the keyword goes back
  // untouched, and `measureLineCross` and the placement put the group together.
  // `axis`: a COLUMN's cross axis is the inline one, where horizontal text has no baseline to
  // align on, so the item goes to its line's cross-START — which `wrap-reverse` puts at the right
  // (measured: x=590 of a 600px container, where `flex-end` is at 570).
  // `flow`: an abspos child's static position has no line to share a baseline WITH, and Chrome
  // answers it where `start` is (measured: y=0 in a `wrap-reverse` row whose `flex-start` is 80).
  if (align === 'last baseline') {
    return baselineMode === 'keep' ? align : baselineMode === 'axis' ? 'flex-end' : atEnd;
  }
  if (align === 'baseline') {
    return baselineMode === 'keep' ? align : baselineMode === 'axis' ? 'flex-start' : atStart;
  }
  return align;
}

// The same alignment in the PHYSICAL terms the in-flow placement works in, where `crossAlign`
// answers in axis-relative ones for the static position. A `wrap-reverse` container runs its cross
// axis backwards, so its two ends swap: measured in a 90px `wrap-reverse` row of three 30px lines,
// `align-items: flex-start` puts a 20px item at its line's BOTTOM (70/40/10) and `start` at its top
// (60/30/0).
//
// Its `baselineMode` is `keep` for a ROW, which aligns real baselines, and `axis` for a COLUMN,
// which has none to align on and sends the item to its line's cross-start instead.
function crossAlignPhysical(containerAlign, child, axes, baselineMode = 'axis') {
  const align = crossAlign(containerAlign, child, axes, baselineMode);
  // …on the PHYSICAL direction of the cross axis, which `wrap-reverse` is only one way of
  // reversing: a `vertical-rl` row's cross axis runs right-to-left with no wrap at all, and its
  // cross-start is the far edge just the same. `crossAlign` above compensates for this swap on
  // the wrap-reverse flag alone, which is what keeps `start` writing-mode relative through it.
  if (axes == null || !axes.crossFar) return align;
  return align === 'flex-start' ? 'flex-end' : align === 'flex-end' ? 'flex-start' : align;
}

// Is this item placed by its baseline rather than by an edge?
function alignsOnBaseline(align) { return align === 'baseline' || align === 'last baseline'; }

// A line is as tall as what is ON it — and a baseline GROUP is one thing rather than several: the
// items in it share a baseline, so the group needs the deepest ascent above that baseline and the
// deepest descent below it. Measured in Chrome: a 32px word (29 above its baseline, 8 below) beside
// a 60px box with no text (whose synthesised baseline is its own bottom edge) makes a 68px line,
// where taking each item's height alone says 60.
function measureLineCross(line, crossFlip) {
  let plain = 0, firstAsc = 0, firstBelow = 0, lastAsc = 0, lastDesc = 0;
  for (const it of line.members) {
    if (it.align === 'baseline') {
      const { asc, outer } = baselineParts(it, false);
      it.baselineAsc = asc;
      if (asc > firstAsc) firstAsc = asc;
      if (outer - asc > firstBelow) firstBelow = outer - asc;
    } else if (it.align === 'last baseline') {
      const { asc, outer } = baselineParts(it, true);
      it.baselineAsc = asc;
      if (asc > lastAsc) lastAsc = asc;
      if (outer - asc > lastDesc) lastDesc = outer - asc;
    } else if (it.outer > plain) {
      plain = it.outer;
    }
  }
  line.firstAsc = firstAsc;
  line.firstExtent = firstAsc + firstBelow;
  line.lastAsc = lastAsc;
  line.lastExtent = lastAsc + lastDesc;
  line.crossFlip = crossFlip;
  const natural = Math.max(plain, line.firstExtent, line.lastExtent);
  if (natural > line.cross) line.cross = natural;
}

// Where a baseline-aligned item sits in its line. The GROUP is anchored as a whole — a first
// baseline group at the line's cross-START, a last baseline one at its cross-END (measured, in an
// 80px line: `baseline` puts a 37px item at 0 and `last baseline` the same item at 43) — and inside
// the group every item hangs from the shared baseline.
function baselineOffset(line, it) {
  const first = it.align === 'baseline';
  const extent = first ? line.firstExtent : line.lastExtent;
  const atStart = first !== !!line.crossFlip;
  const groupTop = atStart ? 0 : line.cross - extent;
  return groupTop + (first ? line.firstAsc : line.lastAsc) - it.baselineAsc;
}

// Where a box that does NOT stretch sits across its line. `stretch` is still an alignment for one:
// it places the box at the line's cross-START, which a reversed cross axis puts at the far physical
// end — measured, a 20px item with a declared height in a 30px `wrap-reverse` line sits at its
// line's BOTTOM (70/40/10 of a 90px row).
function crossPlacement(align, crossFlip) {
  return crossFlip && align === 'stretch' ? 'flex-end' : align;
}
// A box's FIRST (or LAST) baseline, as a page y — the line's own top plus the deepest baseline
// among what sits on it. A box with no line of its own answers with its first in-flow descendant's
// (Chrome takes a flex item's baseline from the line inside it, however deep: an item whose text
// sits under a 30px spacer aligns on THAT line, 44 down), and one with no line anywhere answers
// null — a flex line then synthesises a baseline from its margin box instead.
function boxBaselineOffset(el, last) {
  const lineY = last ? el._lbLastLineY : el._lbFirstLineY;
  if (lineY != null) {
    // The line's baseline is the deepest its boxes ask for — the block's own text, and every
    // inline box with a fragment on that line, each measured against ITS OWN `line-height`
    // (Chrome: a `line-height: 20px` 32px word on a `line-height: 60px` block leaves the line's
    // baseline at the block's 35, and a 32px word on a 16px block moves it to 29).
    const lineH = last ? el._lbLastLineH : el._lbFirstLineH;
    let asc = baselineWithin(el);
    const scan = (parent) => {
      for (const desc of layoutChildren(parent)) {
        if (desc.nodeType !== NODE_ELEMENT || selfNotRendered(desc) || !isInlineLevel(desc)) continue;
        const atomic = !isContinuedInline(desc);
        if (onLineAt(desc, el._lb.y + lineY, lineH)) {
          // An ATOMIC inline — an `inline-block`, an image, a control — brings its own baseline to
          // the line rather than its font's: the one of its LAST line, or its bottom margin edge
          // when it has no line to give (CSS 2.1 §10.8.1). Measured: an empty 50px `inline-block`
          // on a line puts that line's baseline at 50, and a 30px image at 30.
          const deep = atomic ? atomicInlineAscent(desc) : baselineWithin(desc);
          if (deep > asc) asc = deep;
        }
        // A nested inline carries its own font — `<a><span style="font-size:32px">` — but an atomic
        // one is a box of its own and its insides belong to no line here.
        if (!atomic) scan(desc);
      }
    };
    scan(el);
    return lineY + asc;
  }
  for (const child of baselineCandidates(el, last)) {
    const own = boxBaselineOffset(child, last);
    if (own != null) return (child._lb.y - el._lb.y) + own;
  }
  return null;
}

// What an atomic inline contributes above the line's baseline: its own last baseline, else the
// height of its margin box. A box that SCROLLS has no baseline to give either (CSS Align §9), which
// is what puts an `overflow: hidden` badge's bottom edge on the line.
// Where an ATOMIC inline's own baseline sits below its border-box top: the last line inside it, or
// the UA chrome's text where it draws any, or nothing at all — in which case the caller synthesises
// one from the margin box. ONE answer for both callers: the flow, which hangs the box from its
// line, and the line-baseline scan, which asks what the box brought to a line it is already on.
//
// A BUTTON is the exception to the scroll-container rule: it derives a baseline from its contents
// however it scrolls, so an `overflow: hidden` button renders exactly like a plain one
// (`html/rendering/widgets/button-layout/scrollable-button-centering`).
function atomicBaselineOffset(el, height) {
  if (scrollsInAxis(el, 'y') && el.tagName !== 'BUTTON') return null;
  if (intrinsicSize(el)) return controlBaseline(el, height);
  return boxBaselineOffset(el, true);
}

function atomicInlineAscent(el) {
  const own = atomicBaselineOffset(el, el._lb.height);
  const e = edgeInsets(el, null);
  return own == null ? el._lb.height + e.mb : own;
}

// Does this inline box have a fragment on the line that starts at `y`? A fragmented inline's own
// box is the UNION of its pieces, so the pieces are what answer for every line but the first.
function onLineAt(el, y, h) {
  if (!el._lb) return false;
  if (el._lbFrags) return el._lbFrags.some((r) => r.y < y + h && r.y + r.height > y);
  return el._lb.y < y + h && el._lb.y + el._lb.height > y;
}

// The children a baseline may come from, in the order the box lays them out: a flex container's
// are its ITEMS, which `order` may have reordered and `-reverse` runs backwards, and Chrome takes
// the first of those rather than the first in the DOM (measured: with `order: 1` on the second
// item, the container's baseline is that item's). Out-of-flow children have no line in this box,
// and neither does a float — Chrome reads past one to the first in-flow line (measured: a
// `float: left` 40px box before a line of text leaves the baseline at 54, not 14).
function baselineCandidates(el, last) {
  const kids = [];
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed' || isFloated(child)) continue;
    kids.push(child);
  }
  if (laysOutAsFlex(el)) {
    const ordered = kids.some((k) => orderOf(k) !== 0);
    if (ordered) kids.sort((a, b) => orderOf(a) - orderOf(b));
    if (isReverseFlex(el)) kids.reverse();
  }
  if (last) kids.reverse();
  return kids;
}

// What a flex item contributes to a baseline-aligned group: how far its baseline sits below the
// top of its MARGIN box (Chrome aligns the margin boxes — an 8px `margin-top` moves the item and
// its baseline together), and how far the box goes below that baseline. An item with no baseline
// at all synthesises one from the margin box's far edge (§8.3): a 40x40 box with no text in it
// aligns as if its baseline were its bottom, which is why the text beside it drops to 26.
function baselineParts(it, last) {
  const { child, edges } = it;
  const outer = child._lb.height + edges.mt + edges.mb;
  let own = boxBaselineOffset(child, last);
  // A line taller than the box it is in puts the baseline BELOW that box, and Chrome aligns on it
  // where it falls — a `height: 10px` item holding one line sits at 0 beside a plain one, not 4
  // down. Unless the box SCROLLS: a scroll container's baselines come from its own border box
  // (CSS Align §9), which is the same thing as clamping the line's into it — measured, an
  // `overflow: hidden` box 8px tall around one line aligns as if its baseline were its bottom
  // edge (its sibling drops to 6), and the last baseline of a clipped two-line box is that edge
  // too (20 of a 20px box, not the second line's 32).
  if (own != null && scrollsInAxis(child, 'y')) own = Math.max(0, Math.min(child._lb.height, own));
  return { asc: own == null ? outer : own + edges.mt, outer };
}

// The offset that alignment gives an item within the line's cross size. `baseline` is not one of
// them: a baseline group is placed together, by `baselineOffsets` below.
function crossOffset(align, lineCross, outer) {
  const free = lineCross - outer;
  if (free === 0) return 0;
  // A negative remainder is placed as well — an item taller than its line and centred hangs off
  // BOTH edges in Chrome (y = -40 in a 20px line), it does not sit at the top.
  if (align === 'center')   return free / 2;
  if (align === 'flex-end') return free;
  return 0;
}
// `safe` / `unsafe` qualify how an OVERFLOWING box is handled, not which alignment it is — strip
// them so `safe center` centres (Chrome does, even with a negative remainder) instead of falling
// through to the start edge. `first baseline` is the long spelling of `baseline` and means the
// same; `safe baseline` is not a value at all (the qualifiers take a <self-position>, which the
// baselines are not), and Chrome drops that declaration — measured: such an item stretches.
function alignKeyword(v) {
  if (v == null) return null;
  const k = String(v).trim().toLowerCase();
  if (k.startsWith('safe ') || k.startsWith('unsafe ')) {
    const rest = k.slice(k.startsWith('safe ') ? 5 : 7).trim();
    return rest.endsWith('baseline') ? null : rest;
  }
  return k.startsWith('first ') ? k.slice(6).trim() : k;
}

// Does this item take the line's cross size? Only when its alignment resolves to `stretch`, its
// cross size is SPECIFIED auto, and neither cross margin is `auto` — an `auto` margin eats the free
// space instead of the box growing into it.
//
// SPECIFIED auto, not merely unresolved: `height: 100%` against an auto-height container resolves
// to nothing and the box falls back to its content, but the declaration is still there, so Chrome
// does not stretch it (measured: 18px in a 40px row).
function stretchesInCross(align, child, prop, edges) {
  if (align !== 'stretch') return false;
  const size = declaredValue(child, prop);
  if (size != null && String(size).trim().toLowerCase() !== 'auto') return false;
  const sides = prop === 'height' ? CROSS_SIDES_V : CROSS_SIDES_H;
  return !hasAutoMargin(edges, sides[0]) && !hasAutoMargin(edges, sides[1]);
}
const CROSS_SIDES_V = ['top', 'bottom'];
const CROSS_SIDES_H = ['left', 'right'];

// The vertical padding + borders of `el`, the difference between its border box and the line box
// its flex items share.
function contentEdges(el, cbW) {
  const e = edgeInsets(el, cbW);
  return e.top + e.bottom;
}

// Text sitting DIRECTLY in a box that lays its children out as items — a flex or grid
// container, a table — rather than in one of those items.
function hasBareText(el) {
  for (const child of layoutChildren(el)) {
    if (child.nodeType === 3 && NON_WS_RE.test(child._data || child.data || '')) return true;
  }
  return false;
}

// Such text is an ANONYMOUS ITEM — a line of its own — and neither the flex nor the grid
// pass places one, so its height would otherwise be lost: an `inline-flex` span around a
// word measured 0 tall (Chrome: 18), which is not merely a wrong number but a box that
// can't be hit-tested or seen by a `getClientRects` visibility probe.
function anonymousItemHeight(el) {
  return hasBareText(el) ? lineHeightOf(el) : 0;
}

// The used margins a row's main axis resolved, as the physical pair `getComputedStyle` reports.
// Stamped after every layout of the item, because `layoutElementInner` clears the slot each time.
function stampMainMargins(it, reverse) {
  it.child._lbMargins = reverse ? { left: it.mainTrail, right: it.mainLead }
                                : { left: it.mainLead,  right: it.mainTrail };
}

// §9.3: which items share a line. A wrapping container takes items while their HYPOTHETICAL outer
// main size still fits, and starts a new line when the next would not. An item too large for the
// line on its own still gets a line (and overflows it), which is what keeps the loop terminating.
//
// `outerOf` is what makes this either axis: a row's clamped base plus its inline margins, a
// column's plus its block ones. The hypothetical size is the flex base CLAMPED, and it is the same
// figure the distribution then flexes, so the breaker and the sizer cannot disagree about where an
// item ends. Each line remembers where in the container it STARTS, which is what lets it take a
// slice of those measurements rather than making its own. (`resolveFlexibleLengths` then computes
// the same hypothetical sizes again for the line it is handed — threading them through is a
// backlog item, and it costs only containers that actually wrap.)
function flexLines(items, capacity, gap, outerOf) {
  const lines = [];
  let members = [], from = 0, used = 0;
  for (let i = 0; i < items.length; i++) {
    const outer = outerOf(i);
    if (members.length && used + gap + outer > capacity) {
      lines.push({ members, from, cross: 0 });
      members = []; from = i; used = 0;
    }
    used += (members.length ? gap : 0) + outer;
    members.push(items[i]);
  }
  lines.push({ members, from, cross: 0 });
  return lines;
}

// §9.6: how the LINES of a multi-line container sit in its cross size, as a distance from the
// container's CROSS-START (`lead`), the space between neighbouring lines, and how much each line
// GROWS. `normal` / `stretch` — the initial value — hands the free space to the lines instead of
// moving them, and never shrinks them: a line taller than the container keeps its size and
// overflows.
//
// The keyword is resolved onto the cross AXIS here, which `wrap-reverse` reverses: `flex-start` /
// `flex-end` follow that axis, `start` / `end` are flow-relative and do not — the same split
// `crossAlign` makes for the items and `justifyOffsets` for the main axis. Measured in a 90px
// `wrap-reverse` row of three 20px lines: `start` packs them against the physical top (items at
// 40/20/0) where `flex-start` packs against the bottom (70/50/30).
//
// A DISTRIBUTION keyword with no free space falls back to its own alignment, and the two fall back
// differently (CSS Align 3 §4.2, both measured in a 40px `wrap-reverse` row of three 20px lines):
// `space-between` to `flex-start`, so its lines overflow the container's TOP (20/0/-20), while
// `space-around` / `space-evenly` fall back to safe `center`, which under overflow is flow `start`
// and puts them at 40/20/0.
// §9.6 placement, in whichever direction the cross axis runs: the lines are stacked from `start`
// inside `containerCross`, `align-content` deciding both what sits between them and how much each
// one grows. Each line records its cross-START, which is a `y` down a row's cross axis and an `x`
// across a column's — the axis is the caller's business, the stacking is not.
function stackFlexLines(el, lines, start, containerCross, crossGap, axes) {
  const crossFlip = axes.crossFar;
  let stacked = crossGap * Math.max(0, lines.length - 1);
  for (const line of lines) stacked += line.cross;
  const spread = alignContentLines(el, lines.length, containerCross - stacked, axes);
  // `wrap-reverse` stacks the lines from the container's far edge — a row's first line lowest, a
  // column's rightmost — while each line still runs cross-start to cross-end inside itself.
  const order = crossFlip ? [...lines].reverse() : lines;
  let at = start + spread.lead;
  for (const line of order) {
    line.cross += spread.grow;
    line.crossStart = at;
    at += line.cross + crossGap + spread.between;
  }
  // Lines that STRETCH fill the cross size exactly, so the last one is closed against the
  // container's far edge rather than left wherever an equal share of the free space accumulated to.
  // Five lines sharing 40px otherwise end at 48.10000000000001 where the edge is 48.1, and a test
  // that checks the last item meets the end edge is right to call that a miss.
  if (spread.grow > 0) {
    const last = order[order.length - 1];
    last.cross = Math.max(0, start + containerCross - last.crossStart);
  }
}

function alignContentLines(el, count, freeCross, axes) {
  // The same split the item alignment makes: which physical way the stack GROWS is `crossFar`,
  // while `start` / `end` — writing-mode relative, unlike `flex-start` / `flex-end` — swap only
  // for `wrap-reverse`.
  const crossFlip = axes.crossFar;
  let k = alignKeyword(declaredValue(el, 'align-content'));
  // `left` / `right` are not <content-position> values (CSS Align 3 §6.2): Chrome drops the
  // declaration, so `align-content: right` stretches its lines like the `normal` it falls back to
  // rather than packing them at one end.
  if (k == null || k === 'normal' || k === 'stretch' || k === 'auto' || k === 'left' || k === 'right') {
    // Growing lines fill the container, so where the stack STARTS only matters when they overflow
    // it — and `stretch` falls back to `flex-start`, which a reversed axis puts past the container's
    // top (measured: 20/0/-20 in a 40px `wrap-reverse` row of three 20px lines).
    return { lead: crossFlip ? Math.min(0, freeCross) : 0, between: 0,
             grow: freeCross > 0 ? freeCross / count : 0 };
  }
  if (freeCross < 0) {
    if (k === 'space-between') k = 'flex-start';
    else if (k === 'space-around' || k === 'space-evenly') k = 'start';
  }
  if (axes.crossFlip) {
    if (k === 'start') k = 'flex-end';
    else if (k === 'end') k = 'flex-start';
  }
  const { lead, between } = distributionOffsets(k, freeCross, count);
  // …and turned into a distance from the container's TOP, which is what the placement works in: a
  // reversed axis is the mirror image of itself, so what the lines leave BELOW the stack in axis
  // terms is what sits above it physically.
  return { lead: crossFlip ? freeCross - lead - between * (count - 1) : lead, between, grow: 0 };
}

// A flex ROW: items sit side by side in source order with their widths resolved together (see
// `resolveFlexRowWidths`), and each line is as tall as its tallest item. A `nowrap` container is one
// such line however far it overflows — enough that a toolbar, a field row or a card row occupies
// ONE row's height instead of one per item — and a wrapping one breaks into as many as it needs
// (`flexLines`), stacked across the container by `align-content`.
function layoutFlexRow(el, box, content, ctx, { equalShare = false, plan }) {
  const outOfFlow = [];
  const items = flexItems(el, content, ctx, outOfFlow);
  const axes = plan;
  const axis = axes.axis;
  const reverse = axis.reverse;
  // …asked BEFORE the auto height below fills it in, which is what makes the two cases different.
  const definiteCross = box.height !== 0 || box.autoHeight === false;
  const gap = items.length > 1 ? axisGap(el, axes.mainGap, content.width) : 0;
  const itemsAlign = (items.length || outOfFlow.length) ? alignKeyword(declaredValue(el, 'align-items')) : null;
  // ONE cascade read of `flex-wrap` for both questions the cross axis asks of it, and none at all
  // on a page that never declares it: `declaresLayoutProp` answers that from the rule index in O(1),
  // the `mayConstrainSize` pattern (rule 3). An orphan `display: table-row` never wraps — its cells
  // are a real table's row in every way but where it sits.
  const wrap = (!equalShare && items.length) ? axes.wrapMode : 'nowrap';
  const multiline = wrapsFlexLines(wrap);
  const crossFlip = axes.crossFar;
  // The row's metrics measure each ITEM, not each line, so they are taken once for the whole row —
  // the breaker and every line's distribution then read the same figures instead of asking for them
  // again per line.
  const metrics = equalShare ? null : flexRowMetrics(items, content);
  const lines = (multiline && items.length > 1)
    ? flexLines(items, content.width, gap,
                (i) => metrics.clampOf(i, metrics.bases[i]) + items[i].edges.ml + items[i].edges.mr)
    : [{ members: items, from: 0, cross: 0, crossStart: 0 }];
  const crossGap = lines.length > 1 ? axisGap(el, axes.crossGap, content.height || 0) : 0;

  // FIRST pass, per line: resolve the widths together, place along the main axis, and measure how
  // tall the line came out. Every item is laid out at the container's content top for now — where
  // its LINE sits is not known until they have all been measured, and the second pass moves it.
  for (const line of lines) {
    const members = line.members;
    const n = members.length;
    // Gaps and the items' own margins come out of the line before anything is distributed — an
    // `auto` margin resolves to 0 here and takes its share of the free space further down.
    let taken = gap * Math.max(0, n - 1);
    for (const it of members) taken += it.edges.ml + it.edges.mr;
    const avail = Math.max(0, content.width - taken);
    // An item with no text of its own has no content width to measure, so it takes an equal share —
    // better than the zero a text estimate would give a container of blocks.
    const share = n ? Math.floor(avail / n) : avail;
    const widths = equalShare
      ? members.map(() => share)
      : resolveFlexRowWidths(members, avail, share, flexLineMetrics(metrics, line.from, n));

    let used = taken;
    for (const w of widths) used += w;
    const offsets = mainAxisOffsets(el, members, widths, gap, content.width - used, axis, axes);

    for (let i = 0; i < n; i++) {
      const it = members[i], { child, edges } = it;
      // The flex pass already resolved this axis: a declared width is an item's flex BASE, not its
      // final width, so it must not win here the way it does in block flow (two 500px items in a
      // 600px row shrink to fit, they don't overflow to 900). The `equalShare` path is the exception
      // — it is an ORPHAN `display: table-row` (a real table's rows never reach here), whose cells
      // keep their declared widths.
      const size = usedSize(child, widths[i], 0, content.width, content.height || null);
      if (!equalShare) size.width = widths[i];
      it.size = size;
      it.align = crossAlignPhysical(itemsAlign, child, axes, axes.baselineMode);
      // STRETCH beats an intrinsic size here exactly as it does in a column: a control whose height
      // comes from the element rather than its content still takes the line's (Chrome, in a 100px
      // row: an `<input>` and a `<select>` are both 100 tall, where their own heights are 21 and 19).
      // `autoHeight` alone cannot say so — `usedSize` stamps it false for anything with an intrinsic
      // size. Boxes with an intrinsic RATIO are left alone; stretching one means re-deriving the
      // other axis from the ratio, which is a replaced-sizing pass we don't have.
      const intrinsic = intrinsicSize(child);
      it.stretch = (size.autoHeight || (!!intrinsic && !intrinsic.ratio)) &&
                   stretchesInCross(it.align, child, 'height', edges);
      it.rel = flowShift(child, it.pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null);
      const x = reverse ? content.x + content.width - offsets[i] - size.width : content.x + offsets[i];
      layoutElement(child, {
        x: x + (it.rel ? it.rel.x : 0), y: content.y + edges.mt + (it.rel ? it.rel.y : 0),
        width: size.width, height: size.height, autoHeight: size.autoHeight
      }, ctx, content.width);
      stampMainMargins(it, reverse);
      it.outer = child._lb.height + edges.mt + edges.mb;
    }
    measureLineCross(line, crossFlip);
  }

  let stacked = crossGap * Math.max(0, lines.length - 1);
  for (const line of lines) stacked += line.cross;
  // Auto height wraps every LINE plus this container's own vertical edges.
  if (box.height === 0 && box.autoHeight !== false) {
    const e = edgeInsets(el, box.width);
    box.height = Math.max(stacked, anonymousItemHeight(el)) + e.top + e.bottom;
  }
  // CROSS AXIS, in a second pass because a line's cross size isn't known until every item in it has
  // been measured. An item with an AUTO cross size grows to it (the default `align-items`), so a
  // row of short items all end up as tall as its tallest — without that a single-icon flex item
  // was as tall as the icon, 16px where Chrome gives 40, and a click aimed at its centre landed on
  // whatever sat above. One that is ALIGNED instead is moved to where its alignment puts it.
  // A NOWRAP container's one line takes its whole cross size when that is definite: an item taller
  // than it overflows rather than growing the line, and everything aligned in that line is placed
  // against the container's own edges. Taking the tallest item instead made a 40px row report 90,
  // and put every centred sibling 30px low (Chrome: an item 60px too tall for a centred line sits
  // at -30). A container that WRAPS shares that cross size out through `align-content` instead.
  const containerCross = Math.max(0, (box.height || 0) - contentEdges(el, box.width));
  if (!multiline) {
    lines[0].cross = definiteCross ? containerCross : Math.max(lines[0].cross, containerCross);
    lines[0].crossStart = content.y;
  } else {
    // A MULTI-LINE container's lines are as tall as what is on them and `align-content` decides the
    // rest — including when there is only one of them, which is the whole difference between the
    // two branches. Measured, one 60x20 item in a 100x90 `wrap` container: its line is 20 tall and
    // `align-content: center` puts it at 35, where a `nowrap` container hands its line the whole 90.
    stackFlexLines(el, lines, content.y, containerCross, crossGap, axes);
  }

  for (const line of lines) {
    for (const it of line.members) {
      const { child, edges } = it;
      const b = child._lb;
      const room = line.cross - edges.mt - edges.mb;
      // An item that actually grows is laid out again so its own contents see the taller box, which
      // is what a percentage-height descendant resolves against.
      if (it.stretch) {
        // Stretch means the item IS the line's cross size, not "at least" it: an item whose content
        // is taller than a definite line is squeezed to the line and overflows (Chrome: 40, not 90).
        if (b.height !== room) {
          layoutElement(child, { x: b.x, y: b.y, width: b.width, height: room, autoHeight: false },
                        ctx, content.width);
          // …which cleared the used margins it was stamped with, and this box still has them.
          stampMainMargins(it, reverse);
        }
        shiftSubtreeY(child, line.crossStart + edges.mt + (it.rel ? it.rel.y : 0) - child._lb.y);
        continue;
      }
      // An `auto` cross margin takes the line's leftover instead of the box growing into it — the
      // column's cross rule, down rather than across (Chrome: `margin-top: auto` on a 20px item in a
      // 100px row puts it at 80 and reports the margin as 80px) — and then ALIGNMENT has no free
      // space left to place the item with. The two are kept apart because only one of them is a
      // margin: an `align-items: center` item is centred with `margin-top: 0`, not with 40px of one.
      // …on the CROSS axis's own margins. `autoMargins` is a mask over all four sides, and testing
      // the whole of it let a MAIN-axis `margin-left: auto` throw away `align-items` (Chrome puts
      // that item at y=40 in a 100px centred row; we left it at 0).
      const autoCross = (edges.autoMargins & AUTO_MARGIN_Y) !== 0;
      const m = autoCross ? autoMarginSplit(edges, 'top', 'bottom', line.cross, b.height)
                          : { lead: edges.mt, trail: edges.mb };
      const off = autoCross ? 0
                : alignsOnBaseline(it.align) ? baselineOffset(line, it)
                : crossOffset(crossPlacement(it.align, crossFlip), line.cross, b.height + edges.mt + edges.mb);
      shiftSubtreeY(child, line.crossStart + off + m.lead + (it.rel ? it.rel.y : 0) - b.y);
      child._lbMargins.top = m.lead;
      child._lbMargins.bottom = m.trail;
    }
  }
  deferFlexOutOfFlow(el, box, content, ctx, outOfFlow, axes, itemsAlign);
  stampExtent(el, box);
}

// A flex COLUMN: items stack, and their HEIGHTS are resolved together exactly as a row's widths
// are. Block flow, which this used to fall through to, got the stacking right and everything else
// wrong: a `flex: 1` pane was as tall as its text (Avo's sidebar scroll area came out 960 where
// Chrome gives 887, which pushed the profile row past the bottom of the sidebar and left a
// `useClickOutside` dropdown that never closed), margins between items collapsed where flex margins
// never do, and `column-reverse` ran forwards.
//
// It WRAPS down the block axis and stacks its lines across the inline one, which is the row's model
// with the axes exchanged — the same `flexLines` breaker, the same `stackFlexLines` placement. Two
// things are the column's own. A line's cross size is the width of its widest item, which nothing
// knows until every item has been measured, so an item that STRETCHES is measured twice: once at
// its own shrink-to-fit width to size the line, and again at the line's, because a wider box holds
// its text in fewer lines and its flex base moves with it. And the breaker needs a DEFINITE height
// to break against — an auto-height column is one line however many items it holds — while the
// cross axis does not, so `align-content` still places that single line.
function layoutFlexColumn(el, box, content, ctx, { plan }) {
  const outOfFlow = [];
  const items = flexItems(el, content, ctx, outOfFlow);
  const n = items.length;
  const axes = plan;
  const axis = axes.axis;
  const reverse = axis.reverse;
  const main = definiteMainHeight(el, box, content);
  // A column's own height and a `min-height` FLOOR are both main sizes, and they behave differently
  // in both places below. Only a real height (or a `max-height`, which the content cannot grow past)
  // is a CAPACITY to break lines against: Chrome keeps three 20px items in one column under
  // `min-height: 40px` and makes the column 60 tall, where breaking against the floor would have
  // made two columns of 40. And a floor only DIVIDES the main size once the content fails to reach
  // it — the same three items keep their 20 rather than being squeezed to 13.33.
  const heightIsDefinite = box.height !== 0 || box.autoHeight === false;
  const floor = heightIsDefinite ? null : main;
  const capacity = heightIsDefinite ? main : maxMainHeight(el, box);
  const itemsAlign = (n || outOfFlow.length) ? alignKeyword(declaredValue(el, 'align-items')) : null;
  // ONE cascade read of `flex-wrap`, gated on the rule index, exactly as the row does.
  const wrap = n ? axes.wrapMode : 'nowrap';
  // A wrapping column BREAKS only where its main size is definite: with no height to overflow there
  // is nothing to break against, and Chrome keeps every item in one column (measured: an auto-height
  // `wrap` column of three 30x20 items is 60 tall and one column wide, not three).
  //
  // Its CROSS axis is a different question, and the one the row learnt twice: a MULTI-LINE container
  // is one that SAYS `wrap`, so its line is as wide as its widest item and `align-content` places it
  // however many lines there are. Measured in an auto-height 200px column: three 30x20 items under
  // `align-content: center` all sit at x=85, a lone 30px one under `flex-end` at 170, and a 10px one
  // under `wrap-reverse; align-content: flex-end` at 0 — where a `nowrap` column hands its line the
  // whole width and leaves that last item at 190.
  const multiline = wrapsFlexLines(wrap);
  const crossFlip = axes.crossFar;
  const gap = n > 1 ? axisGap(el, axes.mainGap, main) : 0;

  // Where an item sits across its line: an `auto` cross margin centres it (or pushes it to one
  // side) and wins over alignment, which then has no free space left to place it in. What each of
  // them contributes is kept apart: only the margin is a MARGIN, and an `align-items: center` item
  // is centred with `margin-left: 0`, not with 150px of one.
  const placeCross = (it, lineX, lineCross) => {
    const { edges } = it;
    // …the CROSS axis's own margins only: a main-axis `margin-top: auto` is not this axis's
    // business, and taking the whole mask made it drop `align-items` (see the row).
    const autoCross = (edges.autoMargins & AUTO_MARGIN_X) !== 0;
    it.cross = autoCross
      ? autoMarginSplit(edges, 'left', 'right', lineCross, it.size.width)
      : { lead: edges.ml, trail: edges.mr };
    it.crossOffset = autoCross
      ? 0
      : crossOffset(crossPlacement(it.align, crossFlip), lineCross,
                    it.size.width + edges.ml + edges.mr);
    it.x = lineX + it.crossOffset + it.cross.lead + (it.rel ? it.rel.x : 0);
  };

  // The CROSS axis first: an item's height is measured at the width — and at the position — it
  // will actually have, so the measuring layout is one the placement pass can reuse where it stands.
  for (const it of items) {
    const { child, edges } = it;
    const availW = Math.max(0, content.width - edges.ml - edges.mr);
    it.align = crossAlignPhysical(itemsAlign, child, axes, axes.baselineMode);
    it.stretch = stretchesInCross(it.align, child, 'width', edges);
    // A stretched item fills its LINE, and a single-line column's line is the container. A WRAPPING
    // one's is only as wide as its widest item, which nothing knows until they have all been
    // measured — so every item starts at the shrink-to-fit width an aligned one keeps, and the
    // stretched ones are measured again once their line has a size (Chrome, three text items in a
    // 200x40 column: "one" and "two" share a line and are both 95.13 wide, their line's own 26.7
    // plus its share of what `align-content: stretch` had left).
    // An aligned item is as wide as its content wants to be, the same shrink-to-fit every other
    // content-sized box gets (Chrome: an `align-self: flex-start` item around the word "start" is
    // 31px wide, not the container's 600).
    // …except a box with an intrinsic RATIO, whose two axes are derived from each other by a
    // replaced-sizing pass we don't have: measuring one at a narrow width and stretching it after
    // gave an `<svg viewBox>` a 3px flex base. It takes the container's width in both paths.
    const ratioBox = it.stretch && !!(intrinsicSize(child) || {}).ratio;
    const width = it.stretch && (!multiline || ratioBox) ? availW : shrinkToFitWidth(child, availW);
    it.size = usedSize(child, width, 0, content.width, main);
    // STRETCH beats an intrinsic size: an item whose width comes from the element rather than its
    // content is still the line's cross size (Chrome, in a 200px column: a `<select>` is 200 where
    // its own width is 45, an `<input>` 200 against 185, an `<iframe>` 200 against 300). Boxes with
    // an intrinsic RATIO are left alone — Chrome stretches those too and then re-derives the other
    // axis from the ratio, which is a replaced-sizing pass we don't have.
    if (it.stretch && !multiline) {
      const intrinsic = intrinsicSize(child);
      if (intrinsic && !intrinsic.ratio) {
        it.size.width = clampToMinMax(child, availW, 'width', content.width, edges.left + edges.right);
      }
    }
    it.rel = flowShift(child, it.pos === 'relative' ? relativeOffset(child, content.width, main) : null);
    // A single line IS the container, so where the item sits across it is known already — and the
    // measuring layout below wants that, because it lays the item out where it will stand. A
    // wrapping column has to wait for its line to have both a size and a place, so it measures at
    // the content edge and the placement pass moves it.
    if (multiline) it.x = content.x + edges.ml;
    else placeCross(it, content.x, content.width);
  }

  // Each item's flex base, measured at the width it has now.
  const bases = items.map((it) => flexColumnBase(it, main, content, ctx));
  const parts = items.map((it) => flexParts(it.child));
  const clampOf = (i, size) => {
    const it = items[i];
    // One read of each constraint rather than two: going through `clampToMinMax` and then asking
    // `declaredMinHeight` separately resolved `min-height` twice per item per round, and on a page
    // carrying any `min-h-*` rule at all `mayConstrainSize` is true for every element on it.
    let min = null, max = null;
    if (mayConstrainSize(it.child)) {
      min = resolveLayoutProp(it.child, 'min-height', main);
      max = resolveLayoutProp(it.child, 'max-height', main);
    }
    let out = size;
    // `min-height: auto` — the initial value — resolves to the item's automatic minimum: the
    // content it holds, which is what stops a line from squeezing a pane to nothing and what floors
    // a `flex-basis: 0` item at the 18 its own text needs. It costs the item a LAYOUT, so it is
    // asked for only where it can bind: a base that was MEASURED already IS its own minimum, and a
    // SPECIFIED size caps it (§4.5), so nothing at or above either needs a floor. That is what
    // keeps a column of ordinary blocks — and one of fixed-height rows — to one layout each.
    if (min == null) {
      const known = it.baseMeasured ? it.measured : (it.size.autoHeight ? null : it.size.height);
      if (known == null || size < known) {
        const floor = automaticMinHeight(it, content, ctx);
        if (out < floor) out = floor;
      }
    }
    // …and the declared pair on top of it, the maximum first: §4.5 clamps the automatic minimum by
    // the maximum, so a `max-height` item stays capped however tall its content is.
    const extra = isBorderBox(it.child) ? 0 : it.edges.top + it.edges.bottom;
    if (max != null && max >= 0) out = Math.min(out, max + extra);
    if (min != null && min >= 0) out = Math.max(out, min + extra);
    return out;
  };

  // §9.3 down the block axis, and then §9.6 across it: the lines sit side by side in the
  // container's width, each as wide as its widest item until `align-content` hands out what is
  // left (Chrome, three 30x20 items in a 200x40 column: lines of 100 apiece, and 30 and 30
  // under `align-content: flex-start`).
  const lines = (multiline && capacity != null && n > 1)
    ? flexLines(items, capacity, gap,
                (i) => clampOf(i, bases[i]) + items[i].edges.mt + items[i].edges.mb)
    // A NOWRAP column's one line IS the container: it takes the whole width, and where each item
    // sits across it was settled in the measuring loop above.
    : [{ members: items, from: 0, cross: content.width, crossStart: content.x }];
  const crossGap = lines.length > 1 ? axisGap(el, axes.crossGap, content.width) : 0;

  if (multiline) {
    for (const line of lines) {
      line.cross = 0;
      for (const it of line.members) {
        const outer = it.size.width + it.edges.ml + it.edges.mr;
        if (outer > line.cross) line.cross = outer;
      }
    }
    stackFlexLines(el, lines, content.x, content.width, crossGap, axes);
    // A stretched item IS its line's cross size — its WIDTH, and only that. Its main size was
    // resolved from the size it had while the lines were being formed (§9.4 sizes the cross axis
    // after the main one), so the base stands and the placement below imposes it.
    for (const line of lines) {
      for (const it of line.members) {
        if (it.stretch) {
          const room = Math.max(0, line.cross - it.edges.ml - it.edges.mr);
          const width = clampToMinMax(it.child, room, 'width', content.width,
                                      it.edges.left + it.edges.right);
          if (width !== it.size.width) {
            it.size.width = width;
            it.restretched = true;
          }
        }
        placeCross(it, line.crossStart, line.cross);
      }
    }
  }

  const inner = items.map((it, i) =>
    Math.max(0, bases[i] - (isBorderBox(it.child) ? 0 : it.edges.top + it.edges.bottom)));
  let contentExtent = 0;
  for (const line of lines) {
    const members = line.members;
    const k = members.length;
    let taken = gap * Math.max(0, k - 1);
    for (const it of members) taken += it.edges.mt + it.edges.mb;
    // A column that never broke shares the whole-container arrays rather than copying them — the
    // short-circuit `flexLineMetrics` makes for a row, and for the same reason: every `nowrap`
    // column on every page is this case.
    const whole = k === n;
    const slice = whole ? (arr) => arr : (arr) => arr.slice(line.from, line.from + k);
    const lineClamp = whole ? clampOf : (i, size) => clampOf(line.from + i, size);
    // With no definite height to divide there is no free space — but the clamps still apply, so the
    // items go through the same resolution rather than a second code path.
    const available = heightIsDefinite ? Math.max(0, main - taken) : null;
    let heights = resolveFlexibleLengths(slice(bases), slice(inner), slice(parts), available, lineClamp);
    let used = taken;
    for (const h of heights) used += h;
    // A `min-height` the items do not fill IS a main size to divide — `min-h-screen` on a page
    // shell is the shape — but one they overrun is not: the column simply ends up taller than its
    // floor, with every item the size it asked for.
    if (floor != null && used < floor) {
      heights = resolveFlexibleLengths(slice(bases), slice(inner), slice(parts),
                                       Math.max(0, floor - taken), lineClamp);
      used = taken;
      for (const h of heights) used += h;
    }
    // A `max-height` the items overrun is a main size too — the container ends up exactly that
    // tall, so the line has to be resolved against it (Chrome squeezes a 200px item in a
    // `max-height: 100px` column to 100). Only when they DO overrun it: below the cap the column is
    // as tall as its content and nothing flexes. The measurements are cached, so the second pass
    // costs the arithmetic and no layout.
    const capped = heightIsDefinite ? null : cappedMainHeight(el, box, used);
    if (capped != null) {
      heights = resolveFlexibleLengths(slice(bases), slice(inner), slice(parts),
                                       Math.max(0, capped - taken), lineClamp);
      used = taken;
      for (const h of heights) used += h;
    }
    // Where the items sit runs to the container's own main size when it has one: `justify-content`
    // and a reversed line both measure from the far edge, which is the container's, not the
    // content's.
    const extent = heightIsDefinite ? main
                 : capped != null ? capped
                 : Math.max(used, floor != null ? floor : 0);
    const offsets = mainAxisOffsets(el, members, heights, gap, extent - used, axis, axes);
    if (extent > contentExtent) contentExtent = extent;
    if (used > contentExtent) contentExtent = used;

    for (let i = 0; i < k; i++) {
      const it = members[i], { child, edges } = it;
      const h = heights[i];
      const y = reverse ? content.y + extent - offsets[i] - h : content.y + offsets[i];
      // An item that ended up at exactly the height it measured is asked for that same auto height
      // again, so the measuring layout is REUSED rather than re-run — and its contents keep reading
      // an indefinite height, which is what they resolved a percentage against the first time.
      // …and an item the cross axis STRETCHED is imposed on too: its main size was resolved before
      // the stretch, as §9.4 has it, so letting it measure itself again at its new width would
      // re-answer a question already answered (Chrome keeps such an item 36 tall — two lines of
      // text at its HYPOTHETICAL width — where re-measuring at the stretched width gives 18).
      const imposed = heightIsDefinite || it.restretched ||
                      it.measured == null || it.measured !== h;
      layoutElement(child, {
        x: it.x, y: y + (it.rel ? it.rel.y : 0),
        width: it.size.width, height: imposed ? h : 0, autoHeight: !imposed
      }, ctx, content.width);
      // Both axes' used margins: an `auto` cross margin took the slack across, and an `auto` main
      // one took its share of the free space down — `getComputedStyle` reports each as the length it
      // resolved to, exactly as Chrome does (120px, not `auto`).
      child._lbMargins = { left: it.cross.lead, right: it.cross.trail,
                           top: reverse ? it.mainTrail : it.mainLead,
                           bottom: reverse ? it.mainLead : it.mainTrail };
    }
  }
  // Auto height wraps what the items consumed — or the floor a `min-height` put under them — plus
  // this container's own vertical edges. An auto height is what stops a column BREAKING at all, so
  // there is one line here whatever `flex-wrap` says.
  if (box.height === 0 && box.autoHeight !== false) {
    const e = edgeInsets(el, box.width);
    box.height = Math.max(contentExtent, anonymousItemHeight(el)) + e.top + e.bottom;
  }
  deferFlexOutOfFlow(el, box, content, ctx, outOfFlow, axes, itemsAlign);
  stampExtent(el, box);
}

// The main size a column has to distribute: its own content height when that is definite, else the
// floor a `min-height` puts under it — `min-h-screen` on a page shell is how a column of panes gets
// a viewport to divide, and reading such a shell as auto-height gave every pane its content height.
// `null` when there is nothing definite to distribute.
function definiteMainHeight(el, box, content) {
  if (box.height !== 0 || box.autoHeight === false) return content.height;
  const minH = declaredMinHeight(el, el._lbCbH);
  if (minH == null || !(minH > 0)) return null;
  const e = edgeInsets(el, box.width);
  return Math.max(0, isBorderBox(el) ? minH - (e.top + e.bottom) : minH);
}
// A declared `max-height` as an inner (content-box) figure, else null. It is a main size the
// container can never grow past, so it is what a wrapping column BREAKS against when it has no
// height of its own — Chrome puts three 30x20 items in a `max-height: 40px` column on two lines,
// each item still 20 tall, where resolving them into one line squeezed all three to 13.33.
function maxMainHeight(el, box) {
  const maxH = mayConstrainSize(el) ? resolveLayoutProp(el, 'max-height', el._lbCbH) : null;
  if (maxH == null || !(maxH >= 0)) return null;
  const e = edgeInsets(el, box.width);
  return Math.max(0, isBorderBox(el) ? maxH - (e.top + e.bottom) : maxH);
}
// …and the same figure only where the content has OVERRUN it, which is when the line has to be
// resolved against it rather than against what the items wanted.
function cappedMainHeight(el, box, used) {
  const inner = maxMainHeight(el, box);
  return inner != null && used > inner ? inner : null;
}
// A DECLARED `min-height` in px, else null — `auto` (the initial value, and what a flex item's
// automatic minimum comes from) resolves to no length. Behind `mayConstrainSize`, so a page that
// declares none of the size constraints pays a boolean rather than a cascade lookup per item.
function declaredMinHeight(el, basis) {
  return mayConstrainSize(el) ? resolveLayoutProp(el, 'min-height', basis) : null;
}

// `flex-basis: content` sizes the item from its CONTENT and ignores the declared main size — the
// one basis `resolveLayoutProp` cannot answer, since it is a keyword rather than a length.
function isContentBasis(el) { return basisKeyword(el) === 'content'; }

// `flex-basis` takes the intrinsic-size KEYWORDS as well as a length, and `resolveLayoutProp` can
// answer for none of them: `min-content` / `max-content` / `fit-content` size the item from what it
// HOLDS rather than from the space on offer, and `content` asks the same question with the item's
// declared width ignored (`flex-basis-intrinsics-001`).
function basisKeyword(el) {
  const v = declaredValue(el, 'flex-basis');
  if (v == null) return null;
  const k = String(v).trim().toLowerCase();
  return (k === 'content' || k === 'min-content' || k === 'max-content' || k === 'fit-content') ? k : null;
}

// An item's flex base along the COLUMN axis, as a border box. `flex-basis` wins over a declared
// height, which wins over an intrinsic one (an `<img>`, an `<svg viewBox>`), and an item with none
// of those is as tall as its CONTENT — which, unlike a row's content width, can only be found by
// laying the item out. That layout is the one the placement pass reuses when the item ends up at
// the height it measured.
function flexColumnBase(it, main, content, ctx) {
  const { child, edges, size } = it;
  const keyword = basisKeyword(child);
  const basis = keyword ? null : resolveLayoutProp(child, 'flex-basis', main);
  // A basis is a CONTENT size unless `box-sizing` says otherwise, exactly as a declared height is,
  // so the edges come back on top: Chrome makes a `flex: 0 0 120px` item with 10px of padding 140
  // tall.
  if (basis != null) return basis + (isBorderBox(child) ? 0 : edges.top + edges.bottom);
  // Along the COLUMN axis all four keywords ask the same question a declared height cannot answer:
  // how tall the item's own content is, which is what `measureItemHeight` lays out to find.
  if (!size.autoHeight && !keyword) return size.height;
  // Measured, so the automatic minimum below is this same figure and no clamp of a GROWING line
  // can bind — which is what keeps a column of ordinary blocks to one layout each.
  it.baseMeasured = true;
  return measureItemHeight(it, content, ctx);
}

// What the item is tall when nothing imposes a height on it, measured by laying it out — once per
// pass, however many of the answers below want it.
function measureItemHeight(it, content, ctx) {
  if (it.measured == null) {
    // Measured WHERE THE BOX ALREADY IS, because only its height is being read here and the
    // placement pass below moves it to where it belongs anyway. Measuring at a projected position
    // instead shifted every item's subtree twice on any line that actually flexed — 5398 node
    // visits per pass on a 300-row page whose header shrank by 40px.
    const prev = it.child._lb;
    // Paint order is handed out as boxes are PLACED, and this is a measurement: the numbers it
    // consumes are given back, so the placement pass numbers the line once and in order. Keeping
    // them left a reused item numbered after its own children and after the next item's subtree,
    // and `elementFromPoint` then answered with whichever box the stale order put on top.
    const from = ctx.order;
    layoutElement(it.child, { x: prev ? prev.x : it.x, y: prev ? prev.y : content.y,
                              width: it.size.width, height: 0, autoHeight: true }, ctx, content.width);
    ctx.order = from;
    it.measured = it.child._lb.height;
  }
  return it.measured;
}

// The automatic minimum main size of a flex item — what `min-height: auto` resolves to. CSS
// Flexbox §4.5: its CONTENT size, capped by a specified size. That cap is why Chrome keeps a
// `height: 20px` item 20 tall however many lines are in it, and why the same item may still be
// shrunk to its content when the line runs out of room.
function automaticMinHeight(it, content, ctx) {
  if (it.autoMin == null) {
    // …unless the item SCROLLS IN THIS AXIS. §4.5 gives such an item an automatic minimum of zero,
    // that is what lets an `overflow-y: auto` pane take the height its column hands it instead of
    // the height of everything inside it (Chrome: 227 of a 300px column, not 900). Avo's sidebar
    // is that shape — without this its scroll area was as tall as the whole nav list and pushed the
    // profile row past the bottom of the sidebar, where a `useClickOutside` dropdown never reopened.
    if (scrollsInAxis(it.child, 'y')) return (it.autoMin = 0);
    const measured = measureItemHeight(it, content, ctx);
    it.autoMin = it.size.autoHeight ? measured : Math.min(it.size.height, measured);
  }
  return it.autoMin;
}

// Does this box have content, all of it OUT OF FLOW? An absolutely positioned or fixed child
// contributes nothing to its parent's content width, so such a box is genuinely zero wide — as
// distinct from an empty one, which is zero for want of anything to measure.
function outOfFlowOnly(el) {
  let any = false;
  for (const child of layoutChildren(el)) {
    if (child.nodeType === NODE_ELEMENT) {
      if (!isLaidOutNode(child)) continue;
      any = true;
      const p = positionOf(child);
      if (p !== 'absolute' && p !== 'fixed') return false;
    } else if (child.data != null && /\S/.test(child.data)) {
      return false;
    }
  }
  return any;
}

// What a row's items measure BEFORE anything is distributed: each item's flex base size, whether
// that base came from its content, and the clamp that turns a size into a used one. Shared by the
// distribution below and by the LINE BREAKER, which needs the same hypothetical sizes to decide
// where a wrapping row breaks — computing them twice would be two answers to one question.
// Every figure here is a BORDER box: the free space is what the items OCCUPY, and counting their
// padding separately made two `flex: 1; padding: 20px` items 340 wide each in a 600px row.
function flexRowMetrics(items, content) {
  const parts = items.map(({ child }) => flexParts(child));
  // The flex base size, in the spec's order: an explicit `flex-basis` (including the `0%` the
  // `flex: <n>` shorthand expands to) wins over a declared `width`, which wins over the item's
  // intrinsic size — an `<input>`, a `<button>` or an `<img>` keeps ITS size rather than being
  // measured as text — which wins over what its content wants. An item with none of those has
  // nothing to measure, so it falls back to an equal share rather than collapsing to nothing.
  // …and whether that base came FROM the content, in which case it already is the item's own
  // minimum and no clamp below can bind — which is what keeps the measure off the common item.
  const contentBased = [];
  const bases = items.map(({ child, edges }, i) => {
    const extra = isBorderBox(child) ? 0 : edges.left + edges.right;
    const basis = resolveLayoutProp(child, 'flex-basis', content.width);
    if (basis != null) return basis + extra;
    // An intrinsic-size keyword answers from the item's own content, and pins its automatic
    // minimum with it (§4.5: a base that IS the content size can't be clamped up by it).
    const keyword = basisKeyword(child);
    if (keyword && keyword !== 'content') {
      contentBased[i] = true;
      const w = contentIntrinsicWidths(child);
      const inner = keyword === 'min-content' ? w.min
                  : keyword === 'max-content' ? w.max
                  : Math.min(Math.max(w.min, Math.max(0, content.width - edges.ml - edges.mr)), w.max);
      return inner + edges.left + edges.right;
    }
    // `flex-basis: content` says to IGNORE the declared width and size from the content, which is
    // the one keyword `resolveLayoutProp` cannot answer (Chrome: 8px for a one-character item that
    // also declares `width: 400px`).
    if (!isContentBasis(child)) {
      const declared = resolveLayoutProp(child, 'width', content.width);
      if (declared != null) return declared + extra;
    }
    contentBased[i] = true;
    const intrinsic = intrinsicSize(child);
    if (intrinsic) return intrinsic.ratioOnly ? Math.max(0, content.width - edges.ml - edges.mr)
                                              : intrinsic.width + edges.left + edges.right;
    // `flex-basis: content` has to look PAST the declared width, which `intrinsicWidths` pins both
    // figures to.
    if (isContentBasis(child)) return contentIntrinsicWidths(child).max + edges.left + edges.right;
    // Whatever the item's CONTENT wants — which a flat text sum could not answer for a wrapper
    // around block children (it said 0, and the fallback below had to rescue it). Already a border
    // box, edges included, and NOT capped by the row: an item wider than the whole container is
    // how a flex line comes to overflow (Chrome: a 72.64px word in a 40px row stays 72.64).
    return intrinsicWidths(child).max;
  });

  // `min-width: auto` on a flex item is its content — what keeps a label or a button from being
  // squeezed to nothing, and what makes two `flex: 1` items holding long words OVERFLOW their row
  // rather than fit in it (Chrome: 128.94 + 102.28 in a 200px row). A DECLARED minimum replaces it
  // (and `clampToMinMax` has already applied that one), so only a declared width or a `flex-basis`
  // pays the content measure — once per item, however many rounds ask.
  // An item that scrolls ACROSS the row has an automatic minimum of ZERO (§4.5) — an `overflow-x:
  // hidden` item is squeezed
  // as small as the line needs (Chrome: 97.72 beside a 102.28 sibling in a 200px row, where a
  // `visible` one would hold its 128.94). Measured once per item, however many rounds ask.
  const minima = [];
  const minOf = (i) => {
    if (minima[i] === undefined) {
      const { child, edges } = items[i];
      // …and ZERO is what §4.5 says, not "no minimum at all": a border box cannot go below its own
      // padding and borders, and `-Infinity` let one. Chrome puts two `overflow-x: hidden` items
      // squeezed into a 50px row at 0 and 300 (the second is 300px of padding); we had -125 and
      // 175 — a NEGATIVE used width, which every reader downstream then treated as real.
      minima[i] = scrollsInAxis(child, 'x') ? edges.left + edges.right : minContentWidth(child);
    }
    return minima[i];
  };
  const clampOf = (i, size) => {
    const { child, edges } = items[i];
    let min = null, max = null;
    if (mayConstrainSize(child)) {
      min = resolveLayoutProp(child, 'min-width', content.width);
      max = resolveLayoutProp(child, 'max-width', content.width);
    }
    let out = size;
    // `min-width: auto` on a flex item is its content — what keeps a label or a button from being
    // squeezed to nothing, and what makes two `flex: 1` items holding long words OVERFLOW their row
    // rather than fit in it. A base taken FROM the content is its own max-content, so nothing at or
    // above it can be below its min-content — that is the item the measure is skipped for. Below
    // it the floor is real: two content-sized words in a 60px row are 72.64 and 77.36 in Chrome,
    // not 30 and 30.
    if (min == null && !(contentBased[i] && size >= bases[i])) {
      const floor = minOf(i);
      if (out < floor) out = floor;
    }
    // The declared pair goes on top, the maximum first: §4.5 clamps the automatic minimum by the
    // maximum, so a `max-width: 20px` item stays 20 however wide its longest word is.
    const extra = isBorderBox(child) ? 0 : edges.left + edges.right;
    if (max != null && max >= 0) out = Math.min(out, max + extra);
    if (min != null && min >= 0) out = Math.max(out, min + extra);
    return out;
  };
  return { parts, bases, contentBased, clampOf };
}

// One line's view of the row's metrics: the same figures, indexed from the line's first item. They
// are per ITEM and say nothing about which line an item lands on, so a slice is the whole answer —
// and a row that never broke shares the object rather than copying it.
function flexLineMetrics(metrics, from, count) {
  if (from === 0 && count === metrics.bases.length) return metrics;
  const { parts, bases, contentBased, clampOf } = metrics;
  return {
    parts:        parts.slice(from, from + count),
    bases:        bases.slice(from, from + count),
    contentBased: contentBased.slice(from, from + count),
    clampOf:      (i, size) => clampOf(from + i, size)
  };
}

// A flex row's widths, resolved together: each item starts from its flex base size (0 for
// `flex: <n>`, a declared width, else its content) and `resolveFlexibleLengths` shares out what the
// line has left. Without the grow half a `flex: 1` pane is only as wide as the words in it; without
// the shrink half and the automatic minimum, a row of fixed-width items pushes its siblings off the
// line.
function resolveFlexRowWidths(items, avail, share, metrics) {
  const { parts, bases, contentBased, clampOf } = metrics;
  const inner = items.map(({ child, edges }, i) =>
    Math.max(0, bases[i] - (isBorderBox(child) ? 0 : edges.left + edges.right)));
  const sizes = resolveFlexibleLengths(bases, inner, parts, avail, clampOf);

  // An item that measured nothing — no basis, no width, no intrinsic size, no text: a wrapper
  // around block content — ends up at an equal share rather than collapsing to zero and becoming
  // unhittable. Applied to the RESULT, not to the base: putting it in the base makes such items
  // claim space in the free-space arithmetic and pushes their siblings into the shrink branch.
  //
  // …except when the item HAS content and every bit of it is OUT OF FLOW. Then zero is the item's
  // real content width, not a measurement that failed: Chrome gives a box whose only child is
  // `position: fixed` exactly 0, and Avo's sidebar wrapper is one — handing it an equal share put a
  // 700px invisible box over half the page, and every click aimed at the content under it landed
  // on the wrapper instead.
  //
  // An item with NO children at all keeps the share. Chrome sizes those to 0 as well, but ours is
  // what an EMPTY `<turbo-frame loading="lazy">` is until it loads, and a zero-width frame never
  // intersects the viewport, so it would never load and never stop being empty. That circularity is
  // its own gap (the frame's real width comes from a stretch we don't model); until it's closed,
  // the share is what keeps those frames loading.
  return sizes.map((w, i) => {
    const out = w;
    // …and only where the base was a MEASUREMENT that came back empty. A page that asked for zero
    // — `flex: 0 0 0`, `width: 0` — means it: handing those an equal share pushed every following
    // item along the row and left a 50px hit target where Chrome has none.
    return out > 0 || !contentBased[i] || outOfFlowOnly(items[i].child) ? out : share;
  });
}

// Squeeze the orders a subtree was handed — `[from, to)` — into the single slot reserved for
// it at `order`, keeping their sequence. Fractions are fine: `_lbOrder` is only ever compared.
function renumberSubtree(el, order, from, to) {
  const span = to - from + 1;
  const walk = (n) => {
    if (n._lbOrder >= from && n._lbOrder < to) n._lbOrder = order + (n._lbOrder - from) / span;
    for (const c of layoutChildren(n)) if (c.nodeType === NODE_ELEMENT) walk(c);
  };
  walk(el);
}

// Move an already-laid-out subtree: the bottom-anchored auto-height case above, a table row
// back-filling its height, and a relatively-positioned inline box, whose content goes onto
// the line BEFORE the offset can be applied to it. The walk is over one subtree, and only
// for boxes that moved after being laid out.
function shiftSubtree(el, dx, dy, root = el) {
  if (!dx && !dy) return;
  if (el._lb)        { el._lb.x            += dx; el._lb.y            += dy; }
  if (el._lbExt) {
    const e = el._lbExt;
    e.left += dx; e.right += dx; e.iLeft += dx; e.iRight += dx;
    e.top  += dy; e.bottom += dy; e.iTop  += dy; e.iBottom += dy;
  }
  if (el._lbFlowRight  !== undefined) el._lbFlowRight  += dx;
  if (el._lbFlowBottom !== undefined) el._lbFlowBottom += dy;
  if (el._lbFrags) for (const r of el._lbFrags) { r.x += dx; r.y += dy; }
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT) continue;
    const b = child._lb;
    // A `position: fixed` box is laid out against the VIEWPORT, and an absolutely positioned one
    // against a containing block that may sit OUTSIDE the box being moved — a flex item nudged
    // down its line must not drag a dropdown anchored to the container along with it. Either way
    // no ANCESTOR's offset carries them. (The root of the walk is the box being moved on purpose,
    // so it always moves.)
    // …unless the box takes its BLOCK position from the flow inside the box being moved, which is
    // what a static position is: then it moves too, and only across.
    if (b && (b.fixed || (b.outOfFlow && !isSelfOrAncestor(b.cbEl, root)))) {
      if (!b.fixed && b.staticBlock && dy) { shiftSubtree(child, 0, dy, child); }
      continue;
    }
    shiftSubtree(child, dx, dy, root);
  }
}
// Is `root` the element itself or one of its ancestors? Asked only of an out-of-flow box's
// containing block, which is a handful of boxes per page.
function isSelfOrAncestor(el, root) {
  for (let n = el; n; n = n._parent) if (n === root) return true;
  return false;
}
const shiftSubtreeY = (el, dy) => shiftSubtree(el, 0, dy);

// ── Paint recording ──────────────────────────────────────────────────────────────────────────
// Where each text run LANDED, which the flow otherwise throws away: `placeOnLine` returns the
// point and `placeTextRun` has no use for it. A painter does — it cannot re-derive the line
// breaking without repeating the whole pass — so the flow offers the runs to a sink when one is
// armed. Off for every ordinary pass (rule 3: one null check per placed run), armed only around a
// screenshot, which forces a fresh pass because the boxes it needs are memoised from a pass that
// recorded nothing.
// The per-pass run recorder: null unless a paint is in progress. Read once per text node (see
// `placeTextRun`), never per run. The LIST behind it is module-level too, because a run recorded
// inside an atomic inline is written before that box is dropped onto its line's baseline, and the
// flow moves those runs with it (see `shiftRecordedRuns`).
let RUN_SINK = null;
let RUN_LIST = null;
export function recordingRuns(fn) {
  const prevSink = RUN_SINK, prevList = RUN_LIST, runs = [];
  const doc = globalThis.document;
  RUN_LIST = runs;
  RUN_SINK = (r) => runs.push(r);
  // The whole tree is dirtied first, which is what defeats REUSE: a subtree nothing touched keeps
  // its boxes and never re-runs `placeTextRun`, so a recorder would see the runs of whatever
  // happened to be re-laid-out and nothing else. Done by marking rather than by a flag
  // `reuseSubtree` reads — a module variable that anything ASSIGNS stops V8 folding the branch
  // that reads it, and that branch runs once per element per pass: measured, a flag there cost
  // 14 % of the Redmine suite while never once being true.
  // Through the GLOBAL rather than an import: an import edge from here to mutation-observer.js
  // reorders module initialisation enough to break the slot hooks dom-nodes installs there (six
  // slotchange WPT files went red). Cold path, so a global lookup costs nothing that matters.
  if (globalThis.__csimMarkLayoutDirty) globalThis.__csimMarkLayoutDirty(doc && doc.documentElement, true);
  try {
    // …through the public geometry entry rather than `ensureLayout` directly, for the reason in
    // `clipBoxesFor`: a geometry read lays the page out, and this one is not on any hot path.
    rectOf(doc && doc.documentElement);
  } finally {
    RUN_SINK = prevSink;
    RUN_LIST = prevList;
  }
  // …and the recorder is disarmed BEFORE the painter runs, because it belongs to the PASS and not
  // to the paint. A painter reads style — `transform-origin` alone reaches `documentBoxOf` — and a
  // style read can move the keys `ensureLayout` gates on, so the next geometry question inside the
  // paint lays the page out again. With the sink still armed that second pass re-offered every run
  // and the painter drew each of them TWICE: measured, a glyph pixel that should be `59,59,59`
  // composited to `14,14,14`. Whatever a future painter reads, it can no longer feed the list.
  return fn(runs);
}

// How many runs have been recorded so far — the flow takes this either side of an atomic inline's
// layout so it can move that box's own runs when the box lands on its line's baseline.
function recordedRunCount() { return RUN_LIST ? RUN_LIST.length : 0; }
function shiftRecordedRuns(from, to, dx, dy) {
  if (!RUN_LIST || (!dx && !dy)) return;
  for (let i = from; i < to; i++) { RUN_LIST[i].x += dx; RUN_LIST[i].y += dy; RUN_LIST[i].baseline += dy; }
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
// A subtree nothing has touched, asked for the same size in the same containing width, lays out to
// what it laid out last time — its boxes only have to MOVE. Re-running the flow for it is the bulk
// of a pass whose mutation was somewhere else: measured on 300 rows of divs, a mutate-then-read
// pair goes 10.6 ms → 0.9 ms.
//
// Diagnostic: reuses granted, and refusals by reason. Specs assert that an untouched neighbour
// still gets its reuse — geometry alone cannot tell "kept its boxes" from "recomputed the same
// ones".
const REUSE_STATS = { hit: 0, escapingAbs: 0, remeasured: 0 };
globalThis.__csimReuseStats = () => ({ ...REUSE_STATS });

// What it must never do is answer differently from a layout that actually ran — the two REFUSALS
// below are the cases where it did. Both are reached by removing a node, which dirties the target
// and its ancestors but withholds the SUBTREE mark (`recordChildList`), so the sibling beside it
// is still offered its boxes back; these are everyday app shapes rather than corners. Each costs
// one property read, and refusing their whole CATEGORY instead (every flex item, every box that
// could hold an out-of-flow descendant) measured 2-7 % slower on Discourse / Redmine / Avo.
function reuseSubtree(el, box, cbW, ctx) {
  const prev = el._lb;
  if (!prev || el._lbReuse !== memoStamp(el) || el._lbCbW !== cbW) return false;
  // Only when it is asked the same QUESTION — and `wantsDefinite` is the question: a height the
  // caller IMPOSES, or "fill from your own content" (height 0 with the auto flag).
  //
  // A definite question is answered only by the same number, INCLUDING ZERO — which a flex line
  // squeezed to nothing imposes, and which a `box.height !== 0` test read as "asking to fill",
  // handing a 0-tall item back its 18px text line (Chrome: 0).
  //
  // An indefinite one cannot be answered out of a height somebody else imposed: a flex item is
  // measured with an auto height, STRETCHED to the line, and measured again on the next pass —
  // where handing the stretched height back kept the line as tall as it used to be, and a
  // container that should shrink never shrank.
  if (prev.width !== box.width) return false;
  const wantsDefinite = box.height !== 0 || box.autoHeight === false;
  if (wantsDefinite) {
    if (box.height !== prev.height) return false;
  } else if (el._lbDefiniteH) {
    REUSE_STATS.remeasured++;
    return false;
  }
  // …and a subtree holding an out-of-flow box anchored outside it is laid out again, because
  // that box is placed against a containing block this subtree does not own (`noteEscapingAbs`).
  if (el._lbEscAbs) { REUSE_STATS.escapingAbs++; return false; }
  const dx = box.x - prev.x, dy = box.y - prev.y;
  if (dx || dy) shiftSubtree(el, dx, dy);
  box.width  = prev.width;
  box.height = prev.height;
  el._lb = box;
  // Its paint order has to stay in step with the pass around it, and so does the span its subtree
  // occupies — the boxes inside keep the numbers they were given, and those are only ever compared.
  el._lbOrder = ctx.order;
  ctx.order += (el._lbOrderSpan || 1);
  REUSE_STATS.hit++;
  return true;
}

function layoutElement(el, box, ctx, cbW = box.width) {
  if (reuseSubtree(el, box, cbW, ctx)) return;
  const orderFrom = ctx.order;
  LAYING_OUT.add(el);
  let laidOut = false;
  // A float belongs to ONE formatting context: it neither escapes the box that starts one nor
  // intrudes into a box that starts its own. Swapped here, around the whole subtree, so every
  // path through `layoutElementInner` — flex, grid, table, block flow — is covered by one rule.
  const outerFloats = ctx.floats;
  if (startsFloatContext(el, displayOf(el))) ctx.floats = newFloatContext(el);
  try {
    layoutElementInner(el, box, ctx, cbW);
    // NOW the height is final, so `min-height` / `max-height` clamp it (CSS 2.1 §10.7). Here rather
    // than inside `layoutElementInner`, which returns early for a grid, a flex row and a table —
    // clamping at its end skipped every one of those, and `min-height: 100%` on the flex shell of
    // an app page (Avo's, Tailwind's `min-h-full`) left it as tall as its content, 932px where
    // Chrome fills the 1024 viewport.
    //
    // This is also the only point at which an AUTO height is a real number: it starts as a 0
    // placeholder the flow back-fills, and clamping the placeholder froze a box at its `min-height`
    // however tall its content grew. A declared height was clamped in `usedSize` too; the clamp is
    // idempotent, so passing through twice costs nothing but says the same thing.
    const edges = edgeInsets(el, cbW);
    box.height = clampToMinMax(el, box.height, 'height', el._lbCbH, edges.top + edges.bottom);
    laidOut = true;
  } finally {
    ctx.floats = outerFloats;
    LAYING_OUT.delete(el);
    // What this subtree resolved to, so a later pass that finds it untouched can reuse it.
    if (laidOut) { el._lbReuse = memoStamp(el); el._lbOrderSpan = ctx.order - orderFrom; }
    // A flex container's own out-of-flow children go first — their static position is its
    // ALIGNMENT, and the height that alignment measures against is the clamped one just written
    // above.
    const flexPending = laidOut && el._lbFlexPending;
    if (flexPending) { el._lbFlexPending = null; flexPending(); stampExtent(el, box); }
    // Its size is final now, so anything that was waiting on it can be placed. Only when the box
    // really was laid out: flushing while an exception unwinds would replace the error with
    // whatever the flush hits next.
    const waiting = laidOut && PENDING_BY_CB.get(el);
    if (waiting) {
      PENDING_BY_CB.delete(el);
      for (const w of waiting) placeAbsolute(w.child, w.pos, w.staticX, w.staticY, w.ctx, w.order, w.staticAlign);
      stampExtent(el, box);
      // …and they are part of what this box wraps. `stampExtent` unions its DIRECT children, and
      // every box between these and this one was stamped before they were placed, so a tall
      // dropdown would otherwise extend nothing at all (Chrome: the document scrolls to it).
      for (const w of waiting) {
        const ext = w.child._lb && clipsContent(w.child)
          ? extentRecord(w.child._lb.x, w.child._lb.y,
                         w.child._lb.x + w.child._lb.width, w.child._lb.y + w.child._lb.height)
          : w.child._lbExt;
        if (!ext) continue;
        // An out-of-flow box only ever joins the OUTER union: it is not content this box laid out,
        // so it takes no end padding (Chrome: an `inset: 0` overlay in a padded scroller reports
        // its own edge, while the same box in flow reports one padding more).
        if (ext.left   < el._lbExt.left)   el._lbExt.left   = ext.left;
        if (ext.top    < el._lbExt.top)    el._lbExt.top    = ext.top;
        if (ext.right  > el._lbExt.right)  el._lbExt.right  = ext.right;
        if (ext.bottom > el._lbExt.bottom) el._lbExt.bottom = ext.bottom;
      }
    }
  }
}

function layoutElementInner(el, box, ctx, cbW = box.width) {
  el._lb = box;
  // Which QUESTION this layout answered (`reuseSubtree`'s `wantsDefinite`) — asked here, at the
  // top, because the flow back-fills an auto height into the very same field before it is over.
  // Note what it does NOT settle: an imposed height that happens to equal the one an earlier auto
  // layout came to still reuses, so a percentage-height descendant keeps what it resolved against
  // an INDEFINITE parent (Chrome gives 9 where we give 18 for a `height: 50%` grandchild of a
  // 300px flex column). Refusing that costs a second layout for every measured-then-placed item
  // whose height did not change, which is most of them — so it stays a known residual.
  el._lbDefiniteH = box.height !== 0 || box.autoHeight === false;
  // An out-of-flow descendant anchored ABOVE this box has not been placed yet — this layout is
  // what places it (`noteEscapingAbs`), so the mark starts clear.
  el._lbEscAbs = false;
  // Only a fragmented inline has pieces; anything laid out as one box must not keep the
  // ones it had when it was something else.
  el._lbFrags = null;
  // Auto-margin distribution is decided by whoever PLACES this box (block flow, or the abspos
  // path when both insets are given) and stamped after `layoutElement` returns; nobody else
  // distributes, so the default is what `edgeInsets` resolved.
  el._lbMargins = null;
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
  if (laysOutAsFlex(el)) {
    // …along the axes this container's FLOW puts them on, not the ones the keyword names: a
    // `vertical-rl` row runs down the page, which is the column routine's geometry.
    const plan = flexAxisPlan(el);
    (plan.mainIsX ? layoutFlexRow : layoutFlexColumn)(el, box, content, ctx, { plan });
    return;
  }
  if (laysOutAsTable(el)) { layoutTable(el, box, content, ctx); return; }
  // Reached here, a row is an ORPHAN — a `display: table-row` with no table around
  // it, which a browser wraps in an anonymous table and we don't. Its cells at
  // least sit side by side rather than stacking, as they did before there was a
  // table pass at all (a table's own rows never come through here: `layoutTable`
  // places them itself).
  if (disp === 'table-row') {
    layoutFlexRow(el, box, content, ctx, { equalShare: true, plan: PHYSICAL_ROW_PLAN });
    return;
  }

  const right = content.x + content.width;
  // This block CONTAINS its floats when it is the one that started the context: its auto height
  // grows to hold them, where a block that merely inherited the context is not stretched by a
  // float at all (CSS 2.1 §10.6.7 — `overflow: hidden` on a clearfix wrapper is exactly this).
  const ownsFloats = !!ctx.floats && ctx.floats.owner === el;
  // The band the CURRENT line has to itself, which is the content box until a float narrows it.
  let lineLeft = content.x, lineRight = right;
  // The first and last line this block lays out, for whoever asks it for a baseline.
  let firstLineY = null, firstLineH = 0, lastLineY = null, lastLineH = 0, sawBreak = false;
  let flowY = content.y;      // top of the current line box / the next block
  let lineX = content.x;      // horizontal cursor within the current line
  // A line box is a BASELINE with boxes hanging from it, not a stack of tops: `lineAsc` is how
  // far the deepest box reaches above it and `lineDesc` how far the deepest reaches below, and the
  // line is those two summed. A 40px image beside text is a 44px line — the image's 40 above the
  // baseline, the text's 4 below — where taking the tallest box says 40.
  let lineAsc = 0, lineDesc = 0;
  // …and the tallest COLLAPSIBLE SPACE placed since the last real content on it, which counts
  // only once something follows it there: a line holding an empty `inline-block` and a space
  // the break then ate is zero tall in Chrome, not one line tall.
  let lineHangAsc = 0, lineHangDesc = 0;
  // The boxes on the current line that hang from a baseline nothing knows yet: an atomic inline is
  // placed at the line's top and moved onto the baseline when the line ends, and a painter's runs
  // are given that same baseline rather than each guessing its own.
  const lineBoxes = [];
  const lineRuns = [];
  // Every line this block closed, for the fragments that have to sit on their line's baseline.
  const lineRecords = [];
  // The STRUT: every line that holds anything is at least as tall as the block's own font asks,
  // which is what keeps a line holding one 10px badge 18 tall (Chrome) instead of 10.
  const seedStrut = () => {
    if (linePlaced) return;
    lineAsc = baselineWithin(el);
    lineDesc = lineHeightOf(el) - lineAsc;
  };
  const growLine = (asc, desc) => {
    if (asc > lineAsc) lineAsc = asc;
    if (desc > lineDesc) lineDesc = desc;
  };
  // A `vertical-align: top` / `bottom` box takes no part in the baseline — the line only has to be
  // TALL enough for it, and it hangs from whichever edge it named. Chrome grows the side away from
  // the box: a 40px `top` box on a 16px line leaves the baseline at 14 and takes the line to 40,
  // and a `bottom` one moves the baseline to 36 instead.
  let lineOuterMin = 0;
  const growLineFor = (outer) => { if (outer > lineOuterMin) lineOuterMin = outer; };
  let linePlaced = false;     // …and whether anything was put on it at all
  // …of which an inline box's own EDGES do not count: a break needs something to break AT, and
  // a padded `<span>` at the start of a line whose first word overflows must not break before
  // its own padding (which left an empty line box behind, and everything under it a line low).
  let lineHasContent = false;
  // Whether the line currently ends in a collapsible space. White space collapses across the
  // whole inline formatting context, not per text node, so the space before a `<span>` and
  // one at the start of its text are ONE space — which pretty-printed markup produces on
  // every indented line (`Hello <span>\n  world</span>` measured a space too wide).
  let lineEndsWithSpace = false;
  // Inline boxes being fragmented right now, outermost first, and every one whose content
  // has been placed but whose box is not decided yet — see `settleInlineBoxes`.
  const openInlines = [];
  const inlineBoxes = [];
  // Fragments of the CURRENT line that end in a collapsible space, and inline boxes closed
  // on it with nothing in them. Both are answered by how the line ends, so they are held
  // until it does. Per-line, not per-block: a block with thousands of spans must not
  // rescan them all at every break.
  const lineHangs = [];
  const lineEmpties = [];
  // Out-of-flow boxes whose static position is an inline box that had not opened yet when they
  // were reached: it is read off that box's first fragment once there is one.
  const pendingStatic = new globalThis.Map();
  // Out-of-flow boxes held back by the inline boxes this block fragments (see `placeAbsolute`).
  const deferredOutOfFlow = [];

  // Which way this flow runs: every block this box places starts at the flow's inline-start edge,
  // and every out-of-flow one takes its static position from the same two sides. `display:
  // contents` generates no box, so the flow — and the writing mode it runs in — is the nearest
  // ancestor that does.
  //
  // Asked at most ONCE for the container, and only when a child actually needs it: a box holding
  // nothing but text or inline boxes never asks, which is most boxes on a page (rule 3 — the
  // answer is memoised per cascade generation, so a style write makes every ask a real one).
  let flowMemo = null;
  const flowOf = () => (flowMemo || (flowMemo = flowSides(flowContainer(el))));
  const startsAtRight = () => flowOf()['inline-start'] === 'right';
  // …and the static corner out-of-flow children align to, built at most once from the same answer
  // (an ordinary `ltr` horizontal flow has none: the cursor IS the corner).
  let staticCorner;
  const staticAlignFor = () => (staticCorner !== undefined
                                ? staticCorner
                                : (staticCorner = staticCornerFor(flowOf(), content)));

  // ── Line alignment ──
  // `text-align` never moved a line: every line started at the content edge whatever the block
  // said. Each line is lined up when it CLOSES — the free space after its content is where a
  // `right` or `center` shifts everything on it, a `justify` spreads it over the collapsible
  // spaces, and an rtl block lines up `right` by default. Measured against Chrome on a 300px
  // block at 16px monospace: "abcd" right-aligned starts at 261.59, centred at 130.8, and a line
  // WIDER than the block stays at the start edge in ltr but hangs off the LEFT in rtl (x -7.2).
  //
  // The block whose line it is decides — the FLOW CONTAINER, not a `display: contents` box the
  // flow happens to be inside: a `<slot dir="rtl">` in an ltr host is rtl itself, but the host's
  // line still starts at the left (dir-shadow-31). Resolved at the first line that closes with
  // content on it, so a block that never lines one up never asks.
  let lineupMemo = null;
  const lineup = () => {
    if (lineupMemo) return lineupMemo;
    const rtl = flowOf()['inline-start'] === 'right';
    const owner = flowContainer(el);
    return (lineupMemo = { rtl, align: textAlignOf(owner, rtl),
                           descendants: globalThis.__csimLineAlignHint ? legacyDescendantAlign(owner) : null });
  };
  // `text-indent`, read once: the px and which lines take it — the first, or with `hanging` every
  // line BUT the first, and with `each-line` the first after every forced break as well. The indent
  // narrows the line from its START edge — the right one in rtl (Chrome: "ab" in a 300px rtl block
  // under a 40px indent ends at 260) — so every "is the line empty" test that compares the cursor
  // with `lineLeft` keeps working: an indented empty line is still empty. (Moving the cursor
  // instead gave a `text-indent` block a phantom line before its first block child, and kept the
  // collapsible space before its first word.)
  const indent = textIndentOf(flowContainer(el), right - content.x);
  let indentNext = true;
  const applyIndent = () => {
    if (indent === null || indentNext === indent.hanging) return;
    if (lineup().rtl) lineRight -= indent.px; else lineLeft += indent.px;
  };
  applyIndent();
  lineX = lineLeft;
  // What sits on the line being built, for the shift: the inline boxes that placed a piece on it,
  // the width of the collapsible white space hanging at its end (which is not content and lines
  // up against nothing), and where each collapsible gap was placed (which is what `justify` widens).
  const lineFrags = [];
  let trailingHang = 0;
  const lineGaps = [];
  const tailGaps = [];       // separators a run ended in, gaps only once something follows them
  // …and the PRESERVED spaces at its end (`pre-wrap`), which hang like collapsible ones at a soft
  // wrap but stay content before a forced break or the block's end (CSS Text 3 §4.1.3; Chrome:
  // "ffff " at a wrap ends at the right edge, "aaaa  <br>" stops two spaces short of it, and
  // "aaaa" plus 35 spaces on a last line overflows and stays at the left).
  let trailingPreserved = 0;
  // …and the out-of-flow boxes whose static position is a point on it, each with the recorded-run
  // range a box placed on the spot already wrote (a held-back one has written nothing yet).
  const lineStatics = [];

  // The bottom margin of the previous in-flow block, still "open" for collapsing with the next
  // block's top margin — as a RUN (§8.3.1: `max(positives) + min(negatives)` over the whole set,
  // not a fold of pairs). See the model above for the rest: what a box's own margins do with its
  // children's, and what an empty one does with the run around it.
  let openMargin = null;   // null = nothing open (distinct from a run that sums to 0)
  // Whether this box's own top margin ADJOINS its first in-flow child's: if it does, whoever
  // placed this box already spent that child's margin (`collapsingTopMargin` asked for it), so the
  // flow inside must not spend it again. It stays true through children that collapse through,
  // because the whole run was collapsed into that one margin.
  const adjoinsTop = marginsAdjoinTop(el, edge);
  let firstInFlow = true;
  // An open bottom margin still occupies flow even when nothing follows it to
  // collapse with (a last child's margin grows its parent; inline content after a
  // block sits below that margin) — dropping it lost the space entirely.
  const flushMargin = () => {
    if (openMargin != null) { flowY += runValue(openMargin); openMargin = null; }
  };

  // The band the line at `flowY` has, read off the floats around it. Called wherever the flow
  // cursor moves — a line that starts lower may have more room, or less. Given a width, an EMPTY
  // line too narrow for what is about to go on it drops below the shallowest float squeezing it
  // and takes the band there instead: that is what makes a paragraph clear a float it cannot fit
  // beside rather than overflow it (§9.5, "if a shortened line box is too small…").
  const retakeBand = (need) => {
    const fc = ctx.floats;
    if (!fc || !fc.items.length) return;
    const lh = lineHeightOf(el);
    let band = floatBand(fc, flowY, lh, content.x, right);
    if (need && !linePlaced && need > band.right - band.left) {
      const at = floatFitY(fc, flowY, need, content.x, right, lh);
      if (at > flowY) { flowY = at; band = floatBand(fc, flowY, lh, content.x, right); }
    }
    lineLeft = band.left;
    lineRight = band.right;
    applyIndent();
    // An empty line's cursor sits at the band's left edge, wherever that has moved to — a word
    // after a block that cleared the float starts at the content edge again, not where the last
    // shortened line began.
    if (!linePlaced) lineX = lineLeft;
  };

  // A collapsible space stops being a candidate for the end of its line — either a break
  // ATE it, or content followed it there. The difference is the whole point:
  // `<span>Hello </span>world` keeps the space inside the box, the same box at a break does
  // not, and Chrome measures the two 4.45px apart.
  const dropHangs = (eaten) => {
    for (const line of lineHangs) {
      if (eaten) line.hangRight = -Infinity;
      line.hangPending = false;
    }
    lineHangs.length = 0;
  };

  // Line the closing line's content up. `kind` says why the line ended: only a line that WRAPPED
  // is justified — the last line of a block, and one a `<br>` or a preserved newline ends, keep
  // their natural spacing (CSS Text 3 §7.1).
  const alignLine = (kind) => {
    const hanging = trailingHang + (kind === 'wrap' ? trailingPreserved : 0);
    const end = lineX - hanging;
    const free = lineRight - end;
    const { rtl, align: declared } = lineup();
    let align = declared;
    if (align === 'justify') {
      // A gap that is still hanging at the end is not between two words; the ones before are.
      const gaps = kind === 'wrap' && free > 0 ? lineGaps.filter((x) => x < end) : [];
      if (gaps.length) {
        const extra = free / gaps.length;
        const shiftFor = (x) => { let n = 0; for (const g of gaps) if (g < x) n++; return n * extra; };
        moveLine(shiftFor, gaps, extra);
        return;
      }
      align = rtl ? 'right' : 'left';        // the lines `justify` leaves alone are START-aligned
    }
    if (align === 'left') return;
    // An overflowing line stays at the START edge in ltr and hangs off the left in rtl — the
    // negative shift is real there, and clamped to zero here.
    const dx = align === 'right' ? (rtl ? free : Math.max(0, free))
             : (rtl ? Math.min(free / 2, free) : Math.max(0, free / 2));
    if (!dx) return;
    moveLine(() => dx);
  };
  // Everything on the closing line moves by `shiftFor(itsX)`: the text runs a painter recorded,
  // the atomic boxes (with the runs inside them), and this line's piece of every inline box.
  const moveLine = (shiftFor, gaps = null, extra = 0) => {
    for (const run of lineRuns) {
      // A run with gaps INSIDE it widens by them — its start moves by the gaps before it, its end
      // by those too plus its own — and the painter spreads the extra over its spaces.
      if (gaps) {
        let inside = 0;
        for (const g of gaps) if (g >= run.x && g < run.x + run.width) inside++;
        if (inside) { run.width += inside * extra; run.justify = extra; }
      }
      run.x += shiftFor(run.x);
    }
    for (const box of lineBoxes) {
      const dx = shiftFor(box.el._lb.x);
      if (!dx) continue;
      shiftSubtree(box.el, dx, 0);
      shiftRecordedRuns(box.runsFrom, box.runsTo, dx, 0);
    }
    // An inline box's piece moves by what its START moves — and its END by what the end moves,
    // which under `justify` is more when a widened gap lies inside the box.
    for (const frag of lineFrags) {
      const piece = frag.lines[frag.lines.length - 1];
      piece.minX += shiftFor(piece.minX);
      if (piece.maxRight !== -Infinity) piece.maxRight += shiftFor(piece.maxRight);
      if (piece.hangRight !== -Infinity) piece.hangRight += shiftFor(piece.hangRight);
    }
    for (const s of lineStatics) {
      const dx = shiftFor(s.x);
      if (!dx) continue;
      if (s.handle.child) s.handle.staticX += dx;
      else { shiftSubtree(s.handle, dx, 0); shiftRecordedRuns(s.runsFrom, s.runsTo, dx, 0); }
    }
    // An inline box that opened on this line and holds nothing has only the cursor it opened at.
    for (const frag of lineEmpties) if (frag.y === flowY) frag.x += shiftFor(frag.x);
    for (const frag of openInlines) if (!frag.lines.length && frag.y === flowY) frag.x += shiftFor(frag.x);
  };

  // End the current line unconditionally — a `<br>`, or a newline a `pre` block keeps. `kind` is
  // `wrap` where the line ran out of room, which is the one case `justify` applies to.
  const forceBreak = (kind = 'forced') => {
    dropHangs(true);
    // An inline box with nothing in it takes a fragment only where there is a line box to
    // take it on — Chrome gives `<span></span>label` a 0 x 17 rect and a lone
    // `<div><span></span></div>` an empty one, and no height at all.
    for (const frag of lineEmpties) frag.onLine = linePlaced;
    // A line is as tall as what is on it — including nothing at all: a lone empty
    // `inline-block` makes a zero-height line, and Chrome gives the block around one a
    // height of 0. The font's line height is the height of a line that was never
    // filled: the one a `<br>` at the start of a line, or a preserved newline, leaves
    // behind.
    // A line a baseline can be read from — `align-items: baseline` wants the first, `last
    // baseline` the last. Kept as an OFFSET from the block's own box (stamped where the flow ends)
    // rather than a page y: a box that is MOVED afterwards keeps its baseline where it belongs
    // (an item aligned or justified inside its own container, and every box `shiftSubtree` carries),
    // and a subtree that is REUSED without being laid out again keeps an answer that is still true.
    // A line the `<br>` at its start left empty is still a line, and Chrome reads a baseline from
    // it (`<div><br></div>` has one 14 down); it is as tall as the font says.
    if (linePlaced && lineOuterMin > lineAsc + lineDesc) {
      // …and the line grows AWAY from whichever edge asked for the most room: a 40px `top` box
      // beside a 30px `bottom` one takes the line to 40 with its baseline still at 14 (Chrome),
      // where letting any `bottom` box decide dropped every word on the line 22px.
      let maxTop = 0, maxBottom = 0;
      for (const box of lineBoxes) {
        if (box.mode === 'top') { if (box.outer > maxTop) maxTop = box.outer; }
        else if (box.mode === 'bottom') { if (box.outer > maxBottom) maxBottom = box.outer; }
      }
      const need = Math.max(maxTop, maxBottom);
      if (need > lineAsc + lineDesc) {
        if (maxBottom > maxTop) lineAsc = need - lineDesc;
        else lineDesc = need - lineAsc;
      }
    }
    const lineH = linePlaced ? lineAsc + lineDesc : lineHeightOf(el);
    if (linePlaced || sawBreak) {
      lastLineY = flowY;
      lastLineH = lineH;
      if (firstLineY == null) { firstLineY = lastLineY; firstLineH = lastLineH; }
    }
    sawBreak = false;
    // Everything that was waiting for the baseline: each atomic box drops from the line's top to
    // where its own baseline meets the line's, and each run of text is painted from that same
    // baseline rather than from its own font's idea of one.
    if (linePlaced) {
      for (const box of lineBoxes) {
        const dy = box.mode === 'top'    ? 0
                 : box.mode === 'bottom' ? lineH - box.outer
                 : lineAsc - box.asc;
        if (!dy) continue;
        shiftSubtreeY(box.el, dy);
        // …and the text a painter recorded INSIDE it, which was written while the box still stood
        // at the line's top.
        shiftRecordedRuns(box.runsFrom, box.runsTo, 0, dy);
      }
      for (const run of lineRuns) run.baseline = flowY + lineAsc;
      alignLine(kind);
      lineRecords.push({ y: flowY, asc: lineAsc, h: lineH });
    }
    lineEmpties.length = 0;
    lineBoxes.length = 0;
    lineRuns.length = 0;
    lineFrags.length = 0;
    lineGaps.length = 0;
    tailGaps.length = 0;
    lineStatics.length = 0;
    trailingHang = 0;
    trailingPreserved = 0;
    flowY += lineH;
    lineAsc = 0;
    lineDesc = 0;
    lineOuterMin = 0;
    lineHangAsc = 0;
    lineHangDesc = 0;
    linePlaced = false;
    lineHasContent = false;
    lineEndsWithSpace = false;
    indentNext = indent !== null && indent.eachLine && kind === 'forced';
    openLine();
  };
  // A fresh line's edges: the content box, less what a float takes and what the indent takes.
  const openLine = () => {
    lineLeft = content.x;
    lineRight = right;
    applyIndent();
    retakeBand();
    lineX = lineLeft;
  };
  // …and the same thing, but only when there IS a line to end: a block-level box
  // starts below whatever was open, and below nothing if nothing was.
  const breakLine = () => {
    if (linePlaced || lineX !== lineLeft) forceBreak();
    // The line after a block-level box is not the block's first: it takes no indent (Chrome).
    if (indentNext && indent !== null) { indentNext = false; openLine(); }
  };

  // GREEDY LINE BREAKING, the way a browser does it: words go on the line while they
  // fit, and the first one that doesn't starts the next. Before this the flow guessed
  // — the run's total width over the available width — which is right only when the
  // words happen to pack perfectly. What the guess had wrong: a `<br>` didn't break
  // at all, a `white-space: nowrap` block wrapped anyway, a `pre-wrap` newline was
  // dropped, and a box too narrow for even one word took four lines where Chrome
  // takes three.
  //
  // A break EATS the white space it happens at, which is why the decision measures
  // the WORD and the placement adds the space separately.
  // One placed run, for a painter: the text, where its line box starts, and the element whose
  // font and colour it takes. The BASELINE is derived here rather than at paint time, because the
  // half-leading that centres a font box in a taller line box is the flow's own arithmetic.
  const placeTextRun = (text, owner) => {
    // Read once per text node rather than per run: `RUN_SINK` is a module binding something
    // assigns, so V8 cannot fold a branch that reads it, and there are far more runs than nodes.
    const rec = RUN_SINK;
    const mode = whiteSpaceOf(owner);
    const preserves = PRESERVING_WS.has(mode);   // pre / pre-wrap / break-spaces
    // `pre-line` collapses SPACES but keeps NEWLINES — two independent axes, and
    // treating them as one is how its forced breaks went missing.
    const keepsNewlines = preserves || mode === 'pre-line';
    const wraps = modeWraps(mode);
    // …but the run is still placed on the line the CONTAINING block's mode allows: `nowrap`
    // forbids breaking INSIDE the run, not the break opportunity before it, so a `nowrap`
    // `<span>` that doesn't fit moves to the next line whole (Chrome). A block that is
    // itself unbreakable has no such opportunity, and overflows.
    const outerWraps = owner === el ? wraps : modeWraps(whiteSpaceOf(el));
    const lh = lineHeightOf(owner);
    // Where this run's own baseline sits in its line box — what the LINE's baseline is the deepest
    // of, and what a bigger font on the line raises for everything on it. `vertical-align` moves it
    // with the box the run belongs to.
    // …and only for a box that is ON someone's line: `vertical-align` on the BLOCK establishing
    // this formatting context (or on a table cell, or a flex item) says where THAT box sits in its
    // own parent's line, never where its own text sits. Applying it here inflated every
    // `td { vertical-align: middle }` row by 1.27px a line (Chrome: a 3-row table is 54, not 57.8).
    const ownAsc = owner === el ? baselineWithin(owner)
                                : inlineAscent(owner, baselineWithin(owner));
    const spaceW = measureRun(' ', owner);        // hoisted: every collapsed gap is one space
    // Whether this block's wrapped lines are justified — then the separators INSIDE a placed run
    // (a run placed whole, or a word holding a U+00A0) are gaps too. `lineup()` is memoised per
    // block; a block that never wraps (`pre`) has no line `justify` reaches.
    const justifying = outerWraps && lineup().align === 'justify';
    // A tab survives only in a preserving mode, and then its advance is to the next tab stop.
    const tab = preserves && text.indexOf('\t') !== -1 ? tabStopOf(el, owner) : null;
    const segments = keepsNewlines ? String(text).split('\n') : [String(text)];
    segments.forEach((segment, i) => {
      // A preserved newline breaks the line AFTER whatever the box opened with.
      if (i > 0) { flushOpenEdges(); forceBreak(); }
      const run = collapseRun(segment, owner, lineX === lineLeft || lineEndsWithSpace);
      if (!run) return;
      if (!wraps) {
        // A COLLAPSIBLE space a `nowrap` run ends in is the line's end when the line wraps there
        // — hung like the space between two words, outside the run's box (Chrome: the fragment
        // ends at the glyph, 19.2 wide, not 28.8) — and collapses against what follows otherwise.
        // A preserved one stays in the run (CSS Text 3 §4.1.1), so the space after a
        // `white-space: pre` span survives too.
        const trailing = !preserves && CSS_WS_RE.test(run.slice(-1));
        const body = trailing ? run.replace(TRAILING_WS_RE, '') : run;
        if (body) {
          // …from where the run will START: after the inline edges still to be placed before it.
          let from = lineX + openEdgeWidth() - content.x;
          let runW = measureRun(body, owner, from, tab);
          // A tabbed run's width is where it starts; one that moves to the next line is remeasured
          // from that line's start (the wrap `placeOnLine` would do, taken here first).
          if (tab && outerWraps && lineHasContent && lineX + openEdgeWidth() + runW > lineRight) {
            forceBreak('wrap');
            from = lineX + openEdgeWidth() - content.x;
            runW = measureRun(body, owner, from, tab);
          }
          const at0 = placeOnLine(runW, lh, !outerWraps, false, false, ownAsc);
          if (rec) noteRun(lineRuns, body, at0, owner, runW, from, tab);
          // Placed whole, its separators stay INSIDE it — and each is still a justification
          // opportunity (Chrome widens a `white-space: pre` span's inner space like any other:
          // "aaaa bbbb" measures 90.72 on a justified line where its natural width is 86.4).
          if (justifying && WS_ANY_RE.test(body)) noteGapsInside(body, owner, at0.x, tab);
        }
        if (trailing && (lineX > lineLeft || preserves)) placeOnLine(spaceW, lh, true, true, false, ownAsc);
        lineEndsWithSpace = trailing;
        return;
      }
      // Alternating [word, space, word, …] — split on the CSS white-space set, which
      // does NOT include U+00A0: an NBSP is a character a line may not break at, and
      // JS `\s` matches it, so `\s` here would wrap `10&nbsp;kg`.
      for (const token of run.split(WS_SPLIT_RE)) {
        if (!token) continue;
        if (CSS_WS_RE.test(token)) {
          // White space at a line start survives only where the mode preserves it.
          if (lineX > lineLeft || preserves) {
            const from = lineX + openEdgeWidth() - content.x;
            const advances = tab ? charAdvances(token, owner, from, tab) : null;
            const tokenW = preserves ? measureRun(token, owner, from, tab) : spaceW;
            const at = preserves ? placePreservedSpace(token, tokenW, lh, ownAsc, advances)
                                 : placeOnLine(tokenW, lh, true, true, false, ownAsc);
            if (rec && preserves) noteRun(lineRuns, token, at, owner, tokenW, from, tab);
          }
          continue;
        }
        const split = breakUnits(token, owner, lineRight - lineLeft);
        // `overflow-wrap: break-word` breaks a word only when there is no other
        // acceptable break — and moving to the next line IS one, so the word starts
        // fresh and breaks there (Chrome puts "see" alone above a broken URL).
        // `word-break: break-all` has no such rule and fills the line it is on.
        if (split.freshLine && lineHasContent) forceBreak('wrap');
        for (const unit of split.units) {
          const w = measureRun(unit, owner);
          if (lineHasContent && lineX + openEdgeWidth() + w > lineRight) forceBreak('wrap');
          // …and where the line is empty and still too narrow, it is the LINE that moves, down
          // past the float that is squeezing it.
          retakeBand(w + openEdgeWidth());
          const at1 = placeOnLine(w, lh, true, false, false, ownAsc);
          if (rec) noteRun(lineRuns, unit, at1, owner, w);
          // A word holds no CSS white space — the split took it — but it can hold a U+00A0,
          // and Chrome widens that too ("bbbb&nbsp;cccc" on a justified line: 90.72).
          if (justifying && unit.indexOf('\u00A0') !== -1) noteGapsInside(unit, owner, at1.x);
        }
      }
    });
  };

  // A run of preserved spaces is content the line keeps — each space a justification opportunity
  // of its own (Chrome widens a double space twice) — and at the line's end a hanging one (see
  // `trailingPreserved`).
  const placePreservedSpace = (token, w, h, asc, advances = null) => {
    const before = trailingPreserved;
    const at = placeOnLine(w, h, true, false, false, asc);
    trailingPreserved = before + w;
    let pen = at.x;
    for (let k = 0; k < token.length; k++) { lineGaps.push(pen); pen += advances ? advances[k] : w / token.length; }
    return at;
  };

  // The x of every word separator INSIDE a placed run — a space, a tab, and U+00A0, which Chrome
  // and CSS Text 3 §8.1 both widen like a space — as this line's justification gaps. The pen
  // advances exactly as `measureRun` does, letter- and word-spacing included, so a gap lands
  // where the run's own width says. Separators the run ENDS in are held back (`tailGaps`): if
  // nothing else lands on the line they are the line's end and no opportunity at all (Chrome: a
  // `pre` run's trailing space at a wrap stays content and takes no share).
  const noteGapsInside = (text, owner, x, tab = null) => {
    const f = fontOf(owner);
    const ls = f ? f.ls : 0, ws = f ? f.ws : 0, spaced = ls !== 0 || ws !== 0;
    const advances = charAdvances(text, owner, x - content.x, tab);
    let pen = x, k = 0, prev = -1;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const sep = cp === 0x20 || cp === 0xA0 || cp === 0x09 || cp === 0x0A || cp === 0x0D || cp === 0x0C;
      if (sep) tailGaps.push(pen);
      else if (tailGaps.length) { for (const g of tailGaps) lineGaps.push(g); tailGaps.length = 0; }
      pen += advances[k++];
      if (spaced && takesSpacing(cp, prev)) pen += ls + (cp === 0x20 || cp === 0xA0 ? ws : 0);
      prev = cp;
    }
  };

  // Reserve `w` x `h` on the current line, wrapping first if it doesn't fit; returns the origin.
  // `decided` says the caller has already chosen this line (the text breaker has —
  // it measured the WORD, and the trailing space it carries is allowed to hang past
  // the edge because a break eats it). Without that, a word that fits was pushed to
  // the next line by its own trailing space.
  // `hangs` marks COLLAPSIBLE white space, which a break eats: it advances the line
  // like anything else, but it is not part of what the inline box around it covers
  // unless real content follows it on the same line (Chrome ends a wrapped `<span>`'s
  // fragment at the last glyph, not at the space that broke it).
  //
  // `edge` marks an inline box's own padding / border / margin: it advances the line without
  // being TEXT, so it takes no part in white-space collapsing at all. The space either side
  // of an empty padded `<b>` still collapses to one, and a space the break is about to eat
  // is not rescued by the padding that follows it.
  const placeOnLine = (w, h, decided, hangs, edge, asc = h) => {
    // Inline content ends the block-margin adjacency: it sits BELOW a preceding
    // block's bottom margin rather than collapsing with it.
    flushMargin();
    // An edge still to be placed is part of what the content has to fit.
    const pending = edge ? 0 : openEdgeWidth();
    if (!decided && lineHasContent && lineX + pending + w > lineRight) forceBreak('wrap');
    // …and an empty line too narrow for what is going on it drops below the float instead of
    // overflowing, the same rule the word path applies to text (Chrome puts a 100px `inline-block`
    // under a 250px float in a 300px block, not 50px past its right edge).
    if (!decided && !edge) retakeBand(w + pending);
    if (pending) flushOpenEdges();
    const at = { x: lineX, y: flowY };
    lineX += w;
    // Anything but an edge makes what came before it not-the-line's-end: preserved spaces stop
    // hanging (a collapsible space after them is what hangs — Chrome keeps "ff  " content when
    // " gggg" follows and wraps), and CONTENT turns a run's held-back separators into gaps (a
    // hang that then drops leaves the pre run's trailing space the last white space on the line,
    // which Chrome gives no share: "ff " before " gggg" at the wrap shifts by 4 gaps, not 5).
    if (!edge) {
      trailingPreserved = 0;
      if (!hangs && tailGaps.length) { for (const g of tailGaps) lineGaps.push(g); tailGaps.length = 0; }
    }
    if (hangs) { trailingHang += w; lineGaps.push(at.x); } else if (!edge) trailingHang = 0;
    if (hangs) {
      // A collapsible space only counts once real content follows it on the line.
      if (asc > lineHangAsc) lineHangAsc = asc;
      if (h - asc > lineHangDesc) lineHangDesc = h - asc;
    } else {
      seedStrut();
      growLine(lineHangAsc, lineHangDesc);
      lineHangAsc = 0;
      lineHangDesc = 0;
      growLine(asc, h - asc);
    }
    linePlaced = true;
    if (!edge) lineHasContent = true;
    if (!edge) {
      if (!hangs) dropHangs(false);
      lineEndsWithSpace = !!hangs;
    }
    // Every inline box still open around this placement grows to hold it — one PIECE per
    // line, because a browser reports a fragmented inline as the union of its pieces and
    // hit-tests each piece on its own.
    for (const frag of openInlines) notePlacement(frag, at.x, lineX, at.y, hangs, edge, 0);
    return at;
  };

  // An inline box's opening edge — its left margin, border and padding — is not placed when the
  // box opens: its first word may not fit the line, and an edge already placed would be stranded
  // above it, taking that line's height and the boxes around it with it. It waits here until the
  // content it belongs to is placed, or until the box closes with none.
  const openEdgeWidth = () => {
    let w = 0;
    for (const frag of openInlines) w += frag.pendingOpen;
    return w;
  };
  const flushOpenEdges = () => {
    for (let i = 0; i < openInlines.length; i++) {
      const frag = openInlines[i];
      const w = frag.pendingOpen;
      if (!w) continue;
      frag.pendingOpen = 0;
      const at = lineX;
      lineX += w;
      // A line holding only an edge is an ordinary line box (Chrome gives the block around a lone
      // padded empty `<span>` a height of 18, not the box's own 17).
      seedStrut();
      linePlaced = true;
      // The margin sits outside the box, so this box's fragment starts after it; the boxes AROUND
      // it hold the whole placement.
      for (let a = 0; a <= i; a++) {
        notePlacement(openInlines[a], at, lineX, flowY, false, true, a === i ? frag.ce.ml : 0);
      }
    }
  };

  // One fragment's record of a placement: `inset` is what belongs OUTSIDE the box (an opening
  // margin), which advances the line without being part of the fragment.
  const notePlacement = (frag, fromX, toX, y, hangs, edge, inset) => {
    let line = frag.lines[frag.lines.length - 1];
    if (!line || line.y !== y) {
      line = { y, index: lineRecords.length, minX: fromX + inset, maxRight: -Infinity,
               hangRight: -Infinity, hangPending: false };
      frag.lines.push(line);
      lineFrags.push(frag);
    }
    if (fromX + inset < line.minX) line.minX = fromX + inset;
    if (hangs) {
      if (!line.hangPending) { line.hangPending = true; lineHangs.push(line); }
      if (toX > line.hangRight) line.hangRight = toX;
    } else if (toX > line.maxRight) {
      line.maxRight = toX;
    }
  };
  // One child of an inline formatting context — text, a break, an out-of-flow box, or
  // an inline-level box. `owner` is the element the text belongs to, which is the block
  // itself for its own runs and the inline box for a `<span>`'s: the font and the
  // `white-space` mode come from THERE, while the line cursors stay the block's,
  // because that is the box the line lives in. Returns false for a block-level child,
  // which only the block loop knows how to place.
  const placeInlineChild = (child, owner) => {
    // A FLOAT is a block box wherever it was written — `<span style="float: left">` is a float and
    // not a word, and one written INSIDE an inline box belongs to this block's band rather than to
    // that box's line (Chrome hoists it; leaving it on the line put it at the text cursor and made
    // the line as tall as the float).
    if (child.nodeType === NODE_ELEMENT && !selfNotRendered(child) && isFloated(child)) {
      placeFloat(child, positionOf(child), ctx, content, right,
                 flowY + (openMargin == null ? 0 : runValue(openMargin)));
      // …and a float placed beside the open line shortens the rest of it.
      retakeBand();
      return true;
    }
    // A text run shares the line with the inline boxes around it — that is what puts a link AFTER
    // the words before it rather than on a line of its own. Runs wider than the line wrap over as
    // many lines as they need (the line-count estimate the block case used to do on its own).
    if (child.nodeType === 3) {
      const t = child._data || child.data || '';
      // A run of pure white space between two inline boxes still occupies ONE
      // space (the classic inline-block gap) — dropping it put the next box
      // ~4px too far left. It contributes nothing at the start of a line.
      if (!NON_WS_RE.test(t)) {
        // In a PRESERVING mode this node is real content — its newlines break lines
        // and its spaces are indentation — so it goes through the breaker like any
        // other run. Where white space collapses, it is at most the ONE space between
        // two inline boxes (the classic inline-block gap; dropping it put the next box
        // ~4px too far left), and nothing at all at the start of a line.
        if (t && PRESERVING_WS.has(whiteSpaceOf(owner))) { flushMargin(); placeTextRun(t, owner); return true; }
        if (lineX > lineLeft && t && !lineEndsWithSpace) {
          flushMargin();
          placeOnLine(measureRun(' ', owner), lineHeightOf(owner), true, true, false,
                      baselineWithin(owner));
        }
        return true;
      }
      flushMargin();   // see placeOnLine: a text run also ends the adjacency
      placeTextRun(t, owner);
      return true;
    }
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) return true;
    const pos = positionOf(child);
    // Inside a fragmented inline `placeAbsolute` holds this back until the box exists — it may
    // be this box's containing block.
    if (pos === 'absolute' || pos === 'fixed') {
      // Its static position is where it would have sat in flow — which inside an inline box that
      // has not opened yet is not the cursor, but wherever that box turns out to open.
      const open = openInlines[openInlines.length - 1];
      if (open && open.pendingOpen) pendingStatic.set(child, open);
      const runsFrom = RUN_LIST ? RUN_LIST.length : 0;
      const handle = placeAbsolute(child, pos, lineX, flowY, ctx, null, staticAlignFor());
      // An rtl flow's static corner is the content's right edge whatever the cursor says (see
      // `staticCornerFor`), so there is nothing on the line for the alignment shift to move.
      if (handle && !staticAlignFor()) {
        lineStatics.push({ x: lineX, handle, runsFrom, runsTo: RUN_LIST ? RUN_LIST.length : 0 });
      }
      return true;
    }

    // `<br>` IS the break — it takes no width of its own, it ends the line. Left to
    // the inline path it was a zero-width box and the line simply ran on.
    if (child._tag === 'br') {
      flushMargin();
      // …and so does a `<br>`: Chrome gives `<span style="padding-left:20px"><br>b</span>` two
      // fragments, the first being that padding on the line the `<br>` ended.
      flushOpenEdges();
      child._lb = { x: lineX, y: flowY, width: 0, height: fontContentHeight(child) };
      child._lbOrder = ctx.order++;
      stampExtent(child, child._lb);
      sawBreak = true;
      forceBreak();
      // `<br clear=left>` — HTML's pre-CSS way of ending a float band, and still the mapping the
      // rendering section gives the attribute: the break moves down past the floats it named.
      const brClear = ctx.floats && ctx.floats.items.length ? clearOf(child) : null;
      if (brClear) {
        const below = clearanceY(ctx.floats, flowY, brClear);
        if (below > flowY) { flowY = below; retakeBand(); }
      }
      return true;
    }

    if (!isInlineLevel(child)) return false;
    // A non-replaced `display: inline` box holding only inline content is not a box at
    // all until its content is placed: it FRAGMENTS across the lines that content took.
    if (isContinuedInline(child)) { placeInlineBox(child, pos); return true; }
    // Everything else inline-level is ATOMIC: one rectangle on one line, as wide as its
    // content (a declared width or an intrinsic size wins) and as tall as what it holds.
    const ce   = edgeInsets(child, content.width);
    // Every atomic inline is SHRINK-TO-FIT (CSS 2.1 §10.3.9): as wide as its content wants, capped
    // by the room, never below its min-content — `intrinsicWidths`, the one walk a table, a flex
    // container and a block share. It used to be a TEXT estimate patched from the child's extent
    // afterwards, which summed a two-line `<pre>`'s lines (57.6 for lines of 38.41 and 19.2),
    // lost a `<b>`'s tab its pen, and dropped the right padding of a box holding a block child.
    // A box with an intrinsic RATIO and no intrinsic SIZE — an `<svg viewBox>` — takes the width
    // SVG's own sheet gives it, 100% of the block it is in, and `usedSize` derives the other axis
    // from the ratio (Chrome: a `viewBox="0 0 100 200"` svg is 800x1600 in an 800px block and
    // 400x800 in a 400px one). That width is a BORDER box, so only the MARGINS come off it — its
    // padding and border are inside it, and taking them off here made a padded one 770 wide where
    // Chrome fills the 800 and applies the ratio to what is left (800x1570).
    const autoInlineW = ratioOnlyBox(child) ? Math.max(0, content.width - ce.ml - ce.mr)
                      : shrinkToFitWidth(child, content.width);
    // Every non-replaced inline-level box fills its own height from what it holds —
    // a table from its rows, an `inline-block` from its LINES — so it must arrive
    // with an auto one. Handed a line box instead it kept that: an 80px-wide
    // `inline-block` around three words measured 18 tall while its text wrapped to
    // 36 below it, and a table lost the border-spacing under its last row.
    const size = usedSize(child, autoInlineW, 0, content.width, content.height || null);
    const rel  = flowShift(child, pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null);
    // The line takes the MARGIN box of what is on it — a `margin-bottom` under an inline image
    // pushes the whole line down with it (Chrome: 49 for a 40px box with 5px under it) — and it
    // hangs from the line's baseline, which nothing knows until the line ends. It goes down at the
    // line's top for now and `forceBreak` drops it onto the baseline.
    // Reserved WIDE but not tall: what this box asks of the line vertically is its own baseline's
    // business, and that is only readable once it has been laid out — `growAtomic` below tells the
    // line then. Asking for its height here instead pinned the line's ascent to the box's top,
    // which no later answer could bring back down.
    // …and WIDE enough for its own horizontal margins: they advance the line like anything else,
    // and the box sits after the leading one (Chrome puts a `margin-left: 40px` canvas at x=40,
    // where reserving the border box alone left it at 0).
    const at   = placeOnLine(ce.ml + size.width + ce.mr, 0, false, false, false, 0);
    const slot = { el: child, asc: 0, runsFrom: recordedRunCount(), runsTo: 0 };
    lineBoxes.push(slot);
    const cbox = {
      x: at.x + ce.ml + (rel ? rel.x : 0), y: at.y + ce.mt + (rel ? rel.y : 0),
      width: size.width, height: size.height, autoHeight: size.autoHeight
    };
    layoutElement(child, cbox, ctx, content.width);
    slot.runsTo = recordedRunCount();
    // A box that back-filled its own height — a table from its rows, an
    // `inline-block` from its lines — only knows it now, so the line grows to it as
    // it would have to a declared one, and its own baseline is only readable now too.
    growAtomic(slot, ce, cbox.height);
    // An atomic box WRAPS its content, which the text estimate above can badly undersell:
    // the `<span>` ProseMirror puts around an image contains no text at all, so it measured
    // 0 wide while holding a 500px image — two of them then sat 19px apart, overlapping, and
    // a click aimed at the first landed on the second. Grow whichever axis was auto to the
    // content extent and let the line follow.
    const extRight = child._lbFlowRight, extBottom = child._lbFlowBottom;
    if (extRight !== undefined && (size.autoWidth || size.autoHeight)) {
      if (size.autoWidth) {
        // NOT rounded: the extent is measured in the same sub-pixel units the box
        // is, and rounding it UP grew every inline box whose text happened to end
        // on a fraction below .5 — a 25.77px word reported 26.
        const w = Math.max(cbox.width, extRight - cbox.x);
        lineX += w - cbox.width;
        cbox.width = w;
      }
      // The extent already includes this box, so only a child that OVERFLOWS it grows
      // the box and the line.
      const contentH = extBottom - cbox.y;
      if (size.autoHeight && contentH > cbox.height) {
        cbox.height = contentH;
        growAtomic(slot, ce, contentH);
      }
      stampExtent(child, cbox);
    }
    return true;
  };

  // What an atomic inline finally asks of its line, once it has been laid out and knows its own
  // height: its MARGIN box, hanging from ITS baseline — the last line inside it, or its bottom
  // margin edge when it holds no line at all (CSS 2.1 §10.8.1), which is what puts an image's
  // bottom on the text's baseline. Measured in Chrome: an `inline-block` 40px tall holding a word
  // sits at the line's top and makes the line 40 (its baseline is its own text's), while an empty
  // one makes the line 44 (its baseline is its bottom, 40 above the text's 4 of descent).
  const growAtomic = (slot, ce, height) => {
    const inner = atomicBaselineOffset(slot.el, height);
    const outer = height + ce.mt + ce.mb;
    slot.outer = outer;
    slot.asc = ce.mt + (inner == null ? height + ce.mb : inner);
    const va = verticalAlignFor(slot.el);
    if (va) {
      // `top` and `bottom` hang from the LINE, which does not know how tall it is yet: the line
      // only has to be tall enough to hold them, and `forceBreak` places them once it is.
      if (va.mode === 'top' || va.mode === 'bottom') { slot.mode = va.mode; growLineFor(outer); return; }
      slot.asc = alignedAscent(slot.el, va, slot.asc, outer);
    }
    growLine(slot.asc, outer - slot.asc);
  };

  // A `display: inline` box FRAGMENTS: its content flows through the lines around it and
  // the box a browser reports is the union of the pieces. So it is placed by walking its
  // own children through the enclosing block's line cursors — no box of its own to lay
  // out in — and watching where they land.
  const placeInlineBox = (child, pos) => {
    const ce = edgeInsets(child, content.width);
    const ownH = fontContentHeight(child);
    child._lbCbW = content.width;
    child._lbOrder = ctx.order++;
    const frag = {
      el: child, ce, ownH, lines: [], onLine: false,
      // Its opening margin + border + padding, still to be placed (see `flushOpenEdges`).
      pendingOpen: ce.ml + ce.left,

      // Where an EMPTY box sits, and the offset it and its content take at settle time.
      x: lineX, y: flowY,
      rel: flowShift(child, pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null)
    };
    openInlines.push(frag);
    OPEN_INLINE_BOXES.push({ rel: frag.rel, deferred: deferredOutOfFlow });

    // `isContinuedInline` has already refused any child a block formatting context would
    // have to place, so nothing here comes back unhandled.
    for (const grand of layoutChildren(child)) placeInlineChild(grand, child);
    // Nothing came, so the box shows its edges where it opened (Chrome gives a lone padded empty
    // `<span>` a 10x27 box on its line).
    if (frag.pendingOpen) flushOpenEdges();
    if (ce.right) placeOnLine(ce.right, ownH, true, false, true, inlineAscent(child, fontAscent(child)));
    openInlines.pop();
    OPEN_INLINE_BOXES.pop();
    // The right margin is outside the box, so it advances the line after the box has closed.
    if (ce.mr) placeOnLine(ce.mr, ownH, true, false, true, inlineAscent(child, fontAscent(child)));
    inlineBoxes.push(frag);
    if (!frag.lines.length) lineEmpties.push(frag);
  };

  // How far below a line's top an element's own font box begins: the line's baseline less that
  // element's own ascent. Zero for a line whose baseline this box's own font decides, which is
  // every line that holds nothing taller.
  const lineTopOffset = (rec, box) => (rec ? rec.asc - inlineAscent(box, fontAscent(box)) : 0);

  // The geometry of every fragmented inline in this block, decided once the last line has
  // ended — which is the first moment the answers exist: whether the space a box ended on
  // was eaten by a break, and whether an empty box got a line box to sit on.
  const settleInlineBoxes = () => {
    // Innermost first (a nested box closes first), so an outer box's relative offset moves
    // an inner one that already has its final geometry.
    for (const frag of inlineBoxes) {
      const { el: box, ce, ownH, rel } = frag;
      // One rect per line the content landed on. The right edge takes a hanging space that
      // survived to the end of its line, and the vertical padding grows every fragment
      // (Chrome: a padded `<span>` measures 27 tall on an 18px line and overflows it).
      const rects = [];
      // Where this box's own font box sits on a line: hanging from that line's baseline, which a
      // taller box further along the line moves down — the fragment goes with it rather than
      // staying at the line's top.
      const fragTop = (line) => line.y + lineTopOffset(lineRecords[line.index], box) - ce.top;
      for (const line of frag.lines) {
        const right = Math.max(line.maxRight, line.hangRight);
        // Nothing survives on this line — its one placement was a space, and the break ate it.
        // The line record is still there; the fragment is not (Chrome: an `<a>` written across
        // two source lines has ONE rect, not one plus an empty one at the newline).
        if (right === -Infinity) continue;
        rects.push({ x: line.minX, y: fragTop(line),
                     width: Math.max(0, right - line.minX), height: ownH + ce.top + ce.bottom });
      }
      // The box is empty: either nothing was ever placed in it, or every line it did reach
      // was emptied by a break eating the space it held. It is a zero-WIDTH fragment where
      // there is a line box to sit on — the line it reached always is one — and a zero-SIZE
      // one where there is not.
      if (!rects.length) {
        const line = frag.lines[0];
        if (line) {
          rects.push({ x: line.minX, y: fragTop(line), width: 0, height: ownH + ce.top + ce.bottom });
        } else {
          rects.push(frag.onLine
            ? { x: frag.x, y: frag.y - ce.top, width: 0, height: ownH + ce.top + ce.bottom }
            : { x: frag.x, y: frag.y, width: 0, height: 0 });
        }
      }
      if (rel) for (const r of rects) { r.x += rel.x; r.y += rel.y; }
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const r of rects) {
        if (r.x < left) left = r.x;
        if (r.y < top) top = r.y;
        if (r.x + r.width > right) right = r.x + r.width;
        if (r.y + r.height > bottom) bottom = r.y + r.height;
      }
      box._lb = { x: left, y: top, width: right - left, height: bottom - top };
      // The pieces are kept only when there is more than one: they are what a hit test and
      // `getClientRects` must see — the union covers the end of one line and the start of
      // the next, which belong to whatever else is on those lines.
      box._lbFrags = rects.length > 1 ? rects : null;
      // `position: relative` moves the box AND everything in it, without moving anything
      // else on the line — and this box's content went onto the line before the offset was
      // known, so it is carried over now. The line records keep the UNSHIFTED positions, so
      // the line itself is laid out as if this box had not moved, which is right. An
      // ENCLOSING inline box is left behind too, which is not: Chrome grows the outer box's
      // fragments to the shifted inner ones. A relative inline inside another inline is rare
      // enough to leave to the pass that gives fragments their own offsets.
      if (rel) for (const grand of layoutChildren(box)) {
        if (grand.nodeType === NODE_ELEMENT) shiftSubtree(grand, rel.x, rel.y);
      }
    }
    // Now this block's inline boxes can be containing blocks, so the out-of-flow boxes held
    // back for them can be placed — and only then does an inline box know its scrollable
    // extent. The list is this block's own: a block laid out INSIDE one of these inlines runs
    // its own settle first, and the boxes waiting on the inline around it must keep waiting.
    for (const d of deferredOutOfFlow) {
      const from = pendingStatic.get(d.child);
      const line = from && from.lines[0];
      const x = line ? line.minX + from.ce.left : d.staticX;
      const y = line ? line.y : d.staticY;
      placeAbsolute(d.child, d.pos, x, y, d.ctx, d.order, d.staticAlign);
    }
    for (const frag of inlineBoxes) stampExtent(frag.el, frag.el._lb);
  };


  // A block whose formatting context already holds floats starts in the band they leave, not at
  // its own content edge: the paragraph after a floated image begins beside it.
  retakeBand();

  for (const child of layoutChildren(el)) {
    // Content on a line ENDS the run this box's own margin was collapsed into: the block after it
    // starts a new one (Chrome puts a `<p>` after a bare `<span>` a full margin below the line).
    if (firstInFlow && separatesMargins(child)) firstInFlow = false;
    if (placeInlineChild(child, el)) continue;

    const pos = positionOf(child);
    // In-flow block: fills the containing width unless explicitly sized, and starts below whatever
    // line was open.
    breakLine();
    // Margins inset the box horizontally and advance the flow vertically (collapsing
    // with the previous sibling's — see `collapsed` above).
    const cm = edgeInsets(child, content.width);
    // What this child brings to the run: its own top margin AND the ones it collapses out of its
    // own first children (`collapsingTopMargin`) — the div around a `<p>` starts where the p's
    // margin puts it, not 16px above.
    const childTop = collapsingTopMargin(child, content.width);
    // …unless this box's margins adjoin its first in-flow child's, in which case the run was
    // already spent by whoever placed THIS box.
    const spent = adjoinsTop && firstInFlow;
    // `flowY` sits at the previous border box's bottom; the gap to this one is the COLLAPSED
    // margin of the two adjoining ones, not their sum — and then `clear` pushes it below the
    // floats it named, which is how a clearfix ends a float band (§9.5.2). Both before the box is
    // sized, because a box that avoids floats is sized by the band it lands in.
    // The run this box joins: what is already open, plus what the child brings. A box whose own
    // margins were spent outside brings nothing here.
    const run = spent ? EMPTY_RUN : (openMargin == null ? childTop : joinRuns(openMargin, childTop));
    // Where the box's own border edge goes: only the margins ABOVE it (§8.3.1 places a box that
    // collapses through where it would be if it had a bottom border — Chrome: an empty
    // `margin-top: 5px; margin-bottom: 40px` div between two paragraphs sits 5px below the first,
    // and leaves 40 above the one after).
    const childAbove = marginInfo(child, content.width).topOnly;
    const before = spent ? EMPTY_RUN
                 : (openMargin == null ? childAbove : joinRuns(openMargin, childAbove));
    // A box that COLLAPSES THROUGH does not advance the flow at all: its own margins join the run,
    // and its (zero-height) box sits where that run has reached (Chrome: an empty `<div>` between
    // two paragraphs sits at the paragraph BELOW it, and leaves one margin between them). It is
    // sized and placed by the same code as anything else — only the flow's own cursor differs.
    const through = collapsesThrough(child, content.width);
    if (!through) { firstInFlow = false; flowY += runValue(run); }
    // Clearance moves the box DOWN to below the floats it named — it does not add to the margin
    // run, it replaces however much of it is above that line (Chrome: a `clear: left` spacer after
    // a 60px float sits at 60, not at 60 plus its own margin).
    const clear = ctx.floats && ctx.floats.items.length ? clearOf(child) : null;
    const clearTo = clear ? clearanceY(ctx.floats, flowY, clear) : 0;
    if (clear && clearTo > flowY) flowY = clearTo;
    // A box that starts its OWN formatting context does not overlap floats: it is placed in the
    // band that is left and narrowed to it (Chrome: an `overflow: hidden` block beside an 80px
    // right float is 320 wide, not 400 — which is how a float and a `flow-root` sibling read as
    // two columns). An ordinary block keeps its full width and shortens its LINES instead.
    const avoids = ctx.floats && ctx.floats.items.length && startsFloatContext(child, displayOf(child));
    let band = avoids ? floatBand(ctx.floats, flowY, 1, content.x, right) : null;
    const availW = Math.max(0, (band ? band.right - band.left : content.width) - cm.ml - cm.mr);
    // A table is SHRINK-TO-FIT where a block fills — including one with no rows in it, whose
    // width then comes from the text the flow path lays out (Chrome: a `display: table` div
    // around a word is as wide as the word, not as wide as its container).
    const autoW = isTableDisplay(displayOf(child)) || shrinkWrapsToFit(child)
                ? shrinkToFitWidth(child, availW) : availW;
    const size = usedSize(child, autoW, 0, content.width, content.height || null);
    // …and a box that avoids floats but is too WIDE for the band — one with a declared width —
    // drops below them instead of overlapping, exactly as a float that doesn't fit does.
    if (band && size.width + cm.ml + cm.mr > band.right - band.left) {
      flowY = floatFitY(ctx.floats, flowY, size.width + cm.ml + cm.mr, content.x, right, size.height);
      band = floatBand(ctx.floats, flowY, Math.max(size.height, 1), content.x, right);
    }
    // CSS 2.1 §10.3.3: a block narrower than its containing block gives the leftover to
    // whichever horizontal margins are `auto` — both, and it is centred; one, and it is
    // pushed to the other side. `margin: 0 auto` is how half the pages on the web centre
    // their shell, and taking `auto` as zero (which `edgeInsets` does, since there is no
    // length to resolve) left every one of them hard against the left edge.
    // A FLOAT reaches this branch too — floats aren't modelled, so one is laid out as an ordinary
    // block — but §10.3.5 computes its `auto` margins to zero rather than distributing them. Both
    // tests are behind `cm.autoMargins`, so a box with no `auto` margin (nearly every box) pays a
    // bitmask read and no cascade lookup at all.
    // …and it balances on the flow's own axis: §10.3.3 ignores `margin-right` in an `ltr`
    // containing block and `margin-left` in an `rtl` one, so a 500px block with `margin: 0 auto`
    // in a 400px `rtl` container hangs 100px off the LEFT (Chrome: x = -100), not off the right.
    const distributes = cm.autoMargins !== 0 && !isFloated(child);
    const bandLeft = band ? band.left : content.x;
    const bandRight = band ? band.right : content.x + content.width;
    // A block that FILLS its band with equal margins lands in the same place whichever end the
    // flow starts at, so it never asks which end that is — and that is most blocks on a page
    // (rule 3: `direction` stays off the hot path for all of them).
    const sameEitherWay = !distributes && cm.ml === cm.mr &&
                          size.width + cm.ml + cm.mr === bandRight - bandLeft;
    const startsRight = !sameEitherWay && startsAtRight();
    const m = distributes ? autoMarginSplit(cm, startsRight ? 'right' : 'left',
                                            startsRight ? 'left' : 'right',
                                            bandRight - bandLeft, size.width)
                          : null;
    const lead  = m ? m.lead  : (startsRight ? cm.mr : cm.ml);
    const trail = m ? m.trail : (startsRight ? cm.ml : cm.mr);
    // HTML's `align` attribute and `<center>` align the block-level descendants as well
    // (`legacyDescendantAlign`): a narrower block moves in its band the way `margin: auto` would
    // (Chrome: a 100px block in a 300px `<center>` sits at 100). Behind the same latch the line
    // gate uses — a page with no such markup asks nothing.
    let legacyShift = 0;
    if (!distributes && globalThis.__csimLineAlignHint) {
      const how = lineup().descendants;
      const spare = how ? bandRight - bandLeft - size.width - cm.ml - cm.mr : 0;
      if (spare > 0) {
        legacyShift = how === 'center' ? (startsRight ? -spare / 2 : spare / 2)
                    : how === 'right'  ? (startsRight ? 0 : spare)
                    :                    (startsRight ? -spare : 0);
      }
    }
    const rel  = flowShift(child, pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null);
    const ownTop = through ? Math.max(flowY + runValue(before), clearTo) : flowY;
    // A block narrower than its container sits at the container's INLINE-START edge, which in an
    // `rtl` block is the right one (Chrome: a 200px block in a 400px rtl container starts at 200,
    // and everything positioned inside it follows).
    layoutElement(child, { x: (startsRight ? bandRight - size.width - lead
                                           : bandLeft + lead) + legacyShift + (rel ? rel.x : 0),
                          y: ownTop + (rel ? rel.y : 0),
                          width: size.width, height: through ? 0 : size.height,
                          autoHeight: size.autoHeight }, ctx, content.width);
    // …after the box is laid out, because `layoutElementInner` clears the stamp first.
    child._lbMargins = startsRight ? { left: trail, right: lead } : { left: lead, right: trail };
    if (through) {
      // The run stays open for the next sibling — unless it was already spent outside this box.
      if (!spent) openMargin = run;
      continue;
    }
    flowY += child._lb.height;     // the flow advances by the box's height, not its shifted position
    // …and what it hands the next sibling is its own bottom margin PLUS the ones its last children
    // collapsed out of it.
    openMargin = collapsingBottomMargin(child, content.width);
    // The flow has moved: the next line takes the band THERE, which is wider once it is past a
    // float (a word after a block that cleared the float starts at the content edge again).
    retakeBand();
  }
  breakLine();
  settleInlineBoxes();
  // A last child's bottom margin belongs to THIS box only while something separates the two: where
  // they adjoin, the margin is what this box hands its own next sibling (`collapsingBottomMargin`
  // reads it there) and is no part of the height here.
  if (openMargin != null && marginsAdjoinBottom(el, edge, autoOrZeroHeight(el, 'height'))) {
    openMargin = null;
  }
  // …and the lines this block laid out, as offsets from its own box, for whoever asks it for a
  // baseline. Written once per block, not once per line.
  el._lbFirstLineY = firstLineY == null ? null : firstLineY - box.y;
  el._lbFirstLineH = firstLineH;
  el._lbLastLineY = lastLineY == null ? null : lastLineY - box.y;
  el._lbLastLineH = lastLineH;
  flushMargin();   // a last child's bottom margin is part of what this block wraps
  // Auto height (a block with no explicit height) = the flow its in-flow children
  // consumed, plus this element's own padding + borders (the flow started at the
  // content-box top, so both edges have to come back). An EMPTY box is that same sum with no flow
  // in it — its edges are its whole height, which is why Chrome gives `<button></button>` (2px
  // border, 1px padding) a 6px-tall box rather than nothing at all.
  // …unless the page asked for a zero height: `autoHeight` is stamped false only by a DECLARED
  // one, so a box that never went through `usedSize` (a caption, a frame document) still fills.
  if (box.height === 0 && box.autoHeight !== false) {
    // A box that started the formatting context CONTAINS the floats in it: its auto height grows
    // to the lowest of them, which is the whole point of `overflow: hidden` (and `flow-root`) on a
    // wrapper full of floats. A block that merely inherited the context is not stretched at all.
    const floatsTo = ownsFloats ? floatsBottom(ctx.floats) : -Infinity;
    box.height = (Math.max(flowY, floatsTo) - content.y) + edge.top + edge.bottom;
  }
  stampExtent(el, box);
}

// The scrollable overflow region, computed DURING layout instead of walked per read: every element
// gets its own box unioned with its children's regions on all four edges, and — separately — the
// union of its IN-FLOW children's margin boxes, which is the half `contentExtent` extends by this
// box's own end padding. scrollWidth/scrollHeight are read
// constantly by editors and virtualised lists (a code editor measures on every keystroke), and a
// per-read subtree walk turns that into O(document) per call — the layout pass already visits every
// box exactly once, so the union is free here.
function stampExtent(el, box) {
  let right = box.x + box.width, bottom = box.y + box.height;
  // …and the two edges the region can grow BACKWARDS through: an RTL row, a `row-reverse` flex
  // container and a `vertical-rl` block all lay their content out towards a physical edge the
  // box's own origin is not on, so what overflows them is reachable to the LEFT / ABOVE of it
  // (`contentExtent` decides which, from the scroll origin).
  let left = box.x, top = box.y;
  // The same union restricted to IN-FLOW children. An out-of-flow box is not part of what its
  // parent wraps — a nav link holding an absolutely positioned dropdown is as wide as its own word,
  // not as wide as the menu — so the inline auto-grow measures this one instead.
  let fRight = right, fBottom = bottom;
  // The in-flow children's MARGIN boxes, which is the half of the region the box's own END padding
  // extends (css-overflow-3 §3.2, Chrome-measured): a `padding: 10px` scroller holding a 110px
  // child reports 130, and the same child's 7px margins make it 144. Overflow that PROPAGATED from
  // deeper down is not extended — a 10px-wide child holding a 160px grandchild reports 170, not
  // 180 — so this is the direct children's own boxes, not their extents.
  let iLeft = Infinity, iTop = Infinity, iRight = -Infinity, iBottom = -Infinity;
  for (const child of layoutChildren(el)) {
    // A FIXED box is anchored to the viewport, so it is not scrollable content of anything: Chrome
    // reports a page holding one at `top: 900px` as exactly one viewport tall, before and after
    // it appears. It is also the one box `shiftSubtree` leaves behind, so counting it here made a
    // REUSED subtree's extent wrong by the shift on top of being wrong to begin with.
    if (child._lb && child._lb.fixed) continue;
    // Content that OVERFLOWS a clipping box is scrollable within it, not part of what its ancestors
    // wrap: only that box counts toward their scrollHeight (Chrome measured — a 200px
    // `overflow: auto` box holding 2400px of rows gives html/body/box `[681, 200, 2400]`). The FLOW
    // extent below is deliberately left alone: it sizes auto-height ancestors, and shrinking those
    // relaid the editor Avo's code field is built on into a loop.
    // …in the axes it clips, and only those: an `overflow-y: clip` box lets a child hang off its
    // SIDE, and clamping x as well left the document refusing to scroll to a box the hit test
    // says is visible (Chrome scrollWidth 1260 where we reported the 1024 viewport).
    let ce = child._lbExt;
    if (child._lb && clipsContent(child)) {
      const own = child._lb;
      ce = extentRecord(
        child._ccX ? own.x                : (ce ? ce.left   : own.x),
        child._ccY ? own.y                : (ce ? ce.top    : own.y),
        child._ccX ? own.x + own.width  : (ce ? ce.right  : own.x + own.width),
        child._ccY ? own.y + own.height : (ce ? ce.bottom : own.y + own.height));
    }
    if (!ce) continue;
    if (ce.left   < left)   left   = ce.left;
    if (ce.top    < top)    top    = ce.top;
    if (ce.right  > right)  right  = ce.right;
    if (ce.bottom > bottom) bottom = ce.bottom;
    if (child._lb && child._lb.outOfFlow) continue;
    const cfRight  = child._lbFlowRight  !== undefined ? child._lbFlowRight  : ce.right;
    const cfBottom = child._lbFlowBottom !== undefined ? child._lbFlowBottom : ce.bottom;
    if (cfRight  > fRight)  fRight  = cfRight;
    if (cfBottom > fBottom) fBottom = cfBottom;
    const cb = child._lb;
    if (!cb) continue;
    // …by its MARGIN box, where a margin box is a thing it has: margins do not apply to the
    // internal boxes of a table (CSS 2.1 §17.5) and a `<br>` has none at all, and counting theirs
    // put a `tr { margin-right: 400px }` 400px into its tbody's scrollWidth (Chrome, measured:
    // nothing at all — while the same 400px as PADDING on a cell does count, through the cell's
    // own box). Skipping them is also what keeps this off `edgeInsets`' slow path: neither is laid
    // out through `layoutElementInner`, so neither has the `_lbCbW` its memo is keyed on.
    const m = marginBoxApplies(child) ? insetsOf(child) : null;
    // …at the position the FLOW gave it: `relativeOffset` folded any relative shift into the box
    // itself, and that shift takes no padding after it (see there).
    const rel = memoFresh(child, '_lbRelPass') ? child._lbRel : null;
    const cx = rel ? cb.x - rel.x : cb.x, cy = rel ? cb.y - rel.y : cb.y;
    const ml = m ? m.ml : 0, mt = m ? m.mt : 0, mr = m ? m.mr : 0, mb = m ? m.mb : 0;
    if (cx - ml               < iLeft)   iLeft   = cx - ml;
    if (cy - mt               < iTop)    iTop    = cy - mt;
    if (cx + cb.width  + mr   > iRight)  iRight  = cx + cb.width  + mr;
    if (cy + cb.height + mb   > iBottom) iBottom = cy + cb.height + mb;
  }
  el._lbExt        = extentRecord(left, top, right, bottom, iLeft, iTop, iRight, iBottom);
  // The FLOW extent is two numbers on the element rather than a record of its own: it is read in
  // this same loop, and a second object per box per pass both allocated and gave that read a
  // second hidden class to dispatch on.
  el._lbFlowRight  = fRight;
  el._lbFlowBottom = fBottom;
}

// Does this box have a margin box for the region to union? Margins do not apply to a table's
// internal boxes, and a `<br>` is a forced break rather than a box that could carry one.
function marginBoxApplies(el) {
  return el._tag !== 'br' && !TABLE_INTERNAL_DISPLAY.has(displayOf(el));
}

// ONE shape for every extent record, so the reads in `stampExtent`'s loop stay monomorphic: the
// clipping branch builds one too, and a second key set there cost that loop a second hidden class
// on every property it touches.
function extentRecord(left, top, right, bottom, iLeft = Infinity, iTop = Infinity,
                      iRight = -Infinity, iBottom = -Infinity) {
  return { left, top, right, bottom, iLeft, iTop, iRight, iBottom };
}

// A COARSE CSS-grid pass: real COLUMN track sizing (see `gridColumnWidths`), a single gap, fixed
// auto-row height, row-major auto-placement, and `grid-column: a / b` column spans. No explicit
// row/column line placement and no alignment — those are later. `grid-column`-spanning items and
// out-of-flow items are handled.
function layoutGrid(el, box, content, ctx) {
  const gap    = axisGap(el, 'column', content.width);
  // The ROW gap is its own figure — `gap: 4px 24px` is a tight stack of wide columns, and taking
  // the column one for both put three rows' worth of extra space down a card grid.
  const rowGap = axisGap(el, 'row', content.height || null);
  const widths = gridColumnWidths(el, content.width, gap);
  const cols   = widths.length;
  // Track offsets from the container's content edge, so a span reads as a slice.
  const offsets = [];
  let atX = 0;
  for (const w of widths) { offsets.push(atX); atX += w + gap; }
  const declaredRowH = gridRowHeight(el);
  let col = 0;
  let rowTop = content.y;  // top of the row being filled — auto rows are as tall as their content,
  let rowH   = 0;          // so the next row can only start once this one's items are placed
  let bottom = content.y;
  const endRow = () => { rowTop += (declaredRowH != null ? declaredRowH : rowH) + rowGap; rowH = 0; col = 0; };
  // The grid's static corner, built at most once for the container — and only when there is an
  // out-of-flow child to align, which is what keeps the flow question off every grid (see the flow
  // path).
  let staticCorner;
  const staticAlignFor = () => (staticCorner !== undefined
                                ? staticCorner
                                : (staticCorner = staticCornerFor(flowSides(flowContainer(el)), content)));
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    // An out-of-flow grid child joins no row, so its static position is the grid's own content
    // origin — not the row being filled when the parser happened to reach it (Chrome puts one
    // at the container's content top-left whatever precedes it).
    if (pos === 'absolute' || pos === 'fixed') {
      placeAbsolute(child, pos, content.x, content.y, ctx, null, staticAlignFor());
      continue;
    }
    const span  = Math.max(1, Math.min(gridColumnSpan(child, cols), cols));
    const start = gridColumnStart(child, cols);
    if (start != null && start + span <= cols) {
      if (start < col) endRow();                                     // the row already passed it
      col = start;
    } else if (col + span > cols) {
      endRow();                                                      // wrap to the next row
    }
    let trackW = 0;
    for (let i = col; i < col + span; i++) trackW += widths[i] + (i > col ? gap : 0);
    // The track is how much room the item GETS; what it does with that room is its
    // own sizing. A `width` on a grid item is honoured the way it is anywhere else,
    // and its margins come out of the track before an auto width fills what's left
    // — using the track width verbatim made a `width: 300px` item report the full
    // column, and a margined one overflow its track by the margins. (Percentages
    // resolve against the track, which is the spec's "grid area" basis.)
    const ml = resolveLayoutProp(child, 'margin-left',  trackW) || 0;
    const mr = resolveLayoutProp(child, 'margin-right', trackW) || 0;
    const mt = resolveLayoutProp(child, 'margin-top',   trackW) || 0;
    const avail = Math.max(0, trackW - ml - mr);
    const size = usedSize(child, avail, declaredRowH != null ? declaredRowH : 0, trackW, content.height || null);
    const cx = content.x + offsets[col] + ml;
    layoutElement(child, { x: cx, y: rowTop + mt, width: size.width, height: size.height, autoHeight: size.autoHeight }, ctx, trackW);
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
  if (box.height === 0 && box.autoHeight !== false) {
    const e = edgeInsets(el, box.width);
    box.height = Math.max(bottom - content.y, anonymousItemHeight(el)) + e.top + e.bottom;
  }
  stampExtent(el, box);
}

const PX_RE = /(-?\d+(?:\.\d+)?)px/;
// ── Grid track sizing ────────────────────────────────────────────────────────
// The column widths a grid container hands its items. Enough of CSS Grid §12 for the
// track lists real stylesheets are written in: fixed lengths (px / em / %), `fr`
// weights, `auto` / `min-content` / `max-content`, `minmax(a, b)`, `fit-content(x)`
// and `repeat()` — including `auto-fill` / `auto-fit`, which need a fixed track size
// to count against. Rows are still content-sized (see `layoutGrid`).
//
// Splitting the list on whitespace — which is what this used to do, before dividing
// the width evenly — reads `minmax(0, 1fr)` as TWO tracks and `17em minmax(0, 1fr)`
// as three, so Discourse's `17em minmax(0, 1fr)` sidebar layout gave its main column
// a third of the page (341px of 1024) instead of the 752px Chrome gives it. Every
// post then wrapped into a column narrow enough that the topic ran ~3x too tall,
// which cloaked posts the test expected to be on screen.
function gridColumnWidths(el, contentW, gap) {
  const tracks = gridTrackList(el, contentW, gap);
  if (!tracks.length) return [contentW];
  const inner = contentW - gap * (tracks.length - 1);
  // Content measures cost a walk per item, so they're only taken when the list
  // actually asks for one (rule 3): a `1fr` / fixed template needs none.
  const needsContent = tracks.some(intrinsicTrack);
  const cols = needsContent ? gridColumnContent(el, tracks.length) : null;

  // §12.4-12.6: every track starts at its BASE and may grow toward its LIMIT.
  // A fixed track is pinned at both; `auto` bases at min-content and may grow to
  // max-content; `fr` bases at its floor and takes free space in the pass below.
  const base = [], limit = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    base[i]  = trackBase(t, cols, i, contentW);
    limit[i] = t.fr != null ? base[i] : trackLimit(t, cols, i, contentW);
  }

  let free = inner - base.reduce((a, b) => a + b, 0);

  // §12.6 "maximize tracks": grow the intrinsic ones toward their limits, sharing
  // what's free equally. A NEGATIVE free space grows nothing — the tracks stay at
  // their minimums and the grid overflows, exactly as a browser lets it.
  if (free > 0) {
    let growable = [];
    for (let i = 0; i < tracks.length; i++) if (tracks[i].fr == null && limit[i] > base[i]) growable.push(i);
    while (free > 0.01 && growable.length) {
      const share = free / growable.length;
      const next = [];
      for (const i of growable) {
        const room = limit[i] - base[i];
        const add  = Math.min(room, share);
        base[i] += add;
        free    -= add;
        if (limit[i] - base[i] > 0.01) next.push(i);
      }
      if (next.length === growable.length && share <= 0.01) break;
      growable = next;
    }
  }

  // §12.7: `fr` divides the space the other tracks didn't take — its OWN floor is
  // not subtracted first, so `minmax(300px, 1fr) 100px` in 1000px is 900 + 100, not
  // 600 + 100. The floor is a minimum the share can't fall below, which is what
  // keeps `minmax(200px, 1fr)` at 200 on a page too narrow to give it that.
  const frIdx = [];
  for (let i = 0; i < tracks.length; i++) if (tracks[i].fr != null) frIdx.push(i);
  if (frIdx.length) {
    let taken = 0;
    for (let i = 0; i < tracks.length; i++) if (tracks[i].fr == null) taken += base[i];
    let flexible = frIdx.slice();
    let spare    = Math.max(0, inner - taken);
    // §12.7.1 "find the size of an fr": a track whose FLOOR beats its share is
    // frozen at the floor and leaves the pool — the tracks still flexing then
    // divide what's left of it, not the original figure. Without the refreeze,
    // `minmax(600px, 1fr) 1fr` in 800px gave 600 + 400 and put the second item
    // 200px outside the container.
    for (;;) {
      // A weight sum BELOW 1 doesn't scale up: `0.5fr 0.25fr` takes half and a
      // quarter of the free space and leaves the rest, which is why the sum is
      // floored at 1 rather than normalised.
      const weight = Math.max(1, flexible.reduce((a, i) => a + tracks[i].fr, 0));
      const frozen = [];
      for (const i of flexible) {
        const share = (spare * tracks[i].fr) / weight;
        if (base[i] > share) frozen.push(i);
      }
      if (!frozen.length) {
        for (const i of flexible) base[i] = Math.max(base[i], (spare * tracks[i].fr) / weight);
        break;
      }
      for (const i of frozen) spare = Math.max(0, spare - base[i]);
      flexible = flexible.filter((i) => !frozen.includes(i));
      if (!flexible.length) break;
    }
  } else if (free > 0.01) {
    // No `fr` left to absorb it: `auto` tracks stretch to fill the row (the
    // `justify-content: normal` default behaves as `stretch` for them). A
    // fixed-only list keeps its sizes and leaves the remainder, as a browser does.
    const autos = [];
    for (let i = 0; i < tracks.length; i++) if (tracks[i].auto || (tracks[i].floor && tracks[i].floor.auto)) autos.push(i);
    if (autos.length) {
      const extra = free / autos.length;
      for (const i of autos) base[i] += extra;
    }
  }
  return base.map((w) => Math.max(0, w));
}

// A track's floor: what it is before anything is distributed to it.
function trackBase(t, cols, i, contentW) {
  if (t.fr != null) return t.floor ? resolveTrackSide(t.floor, cols, i, contentW, 'min') : 0;
  if (t.floor) return resolveTrackSide(t.floor, cols, i, contentW, 'min');
  return resolveTrackSide(t, cols, i, contentW, 'min');
}
// A track's ceiling: how far it may grow.
function trackLimit(t, cols, i, contentW) {
  return resolveTrackSide(t, cols, i, contentW, 'max');
}
// One side of a track spec in px. `which` picks which content measure an
// intrinsic keyword answers with — a `min` side of `auto` is min-content, its
// `max` side is max-content.
function resolveTrackSide(t, cols, i, contentW, which) {
  if (t.px != null) return t.px;
  if (t.pct != null) return (t.pct / 100) * contentW;
  const col = cols ? cols[i] : ZERO_WIDTHS;
  // `fit-content(limit)`: max-content capped at the limit, never below min-content.
  if (t.fit) {
    if (which === 'min') return col.min;
    const cap = t.fit.px != null ? t.fit.px : (t.fit.pct != null ? (t.fit.pct / 100) * contentW : Infinity);
    return Math.max(col.min, Math.min(cap, col.max));
  }
  if (t.min) return col.min;
  if (t.max) return col.max;
  if (t.auto) return which === 'min' ? col.min : col.max;
  return which === 'min' ? col.min : col.max;   // an `fr` side asked for a measure
}
function intrinsicTrack(t) {
  if (t.auto || t.min || t.max || t.fit) return true;
  return !!(t.floor && (t.floor.auto || t.floor.min || t.floor.max || t.floor.fit));
}

// Each column's `{min, max}` content contribution: the widest item PLACED IN IT,
// which needs the same row-major auto-placement the layout pass runs. Memoised per
// container per pass — an app grid can hold hundreds of items and this walks them
// all (rule 3).
function gridColumnContent(el, colCount) {
  if (memoFresh(el, '_lbGridColsPass') && el._lbGridCols && el._lbGridCols.length === colCount) return el._lbGridCols;
  // Stamped AND published before the walk: `intrinsicWidths` below can reach back
  // into this container, and a fresh stamp over a missing array would answer with
  // `undefined` (the same reason intrinsicWidths seeds its own slot first).
  el._lbGridColsPass = memoStamp(el);
  const cols = [];
  for (let i = 0; i < colCount; i++) cols.push({ min: 0, max: 0 });
  el._lbGridCols = cols;   // filled in place below
  let col = 0;
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') continue;
    const span  = Math.max(1, Math.min(gridColumnSpan(child, colCount), colCount));
    const start = gridColumnStart(child, colCount);
    if (start != null && start + span <= colCount) col = start;
    else if (col + span > colCount) col = 0;
    const iw = intrinsicWidths(child);
    // A spanning item contributes to each column it covers, divided evenly — the
    // spec distributes the excess more carefully, but that only matters once
    // tracks differ, and a coarse split keeps a spanning header from pinning one
    // column to the whole table's width.
    for (let i = col; i < col + span; i++) {
      if (iw.min / span > cols[i].min) cols[i].min = iw.min / span;
      if (iw.max / span > cols[i].max) cols[i].max = iw.max / span;
    }
    col = (col + span) % colCount;
  }
  return cols;
}


// Split a track list into tracks, respecting `minmax(…)` / `fit-content(…)` parens,
// and expand `repeat()`. Returns `[{px|pct|fr|auto|min|max, floor}]`.
function gridTrackList(el, contentW, gap) {
  const raw = declaredValue(el, 'grid-template-columns');
  const s = raw == null ? '' : String(raw).trim();
  if (!s || s === 'none' || s === 'auto') return s === 'auto' ? [parseTrack(el, 'auto')] : [];
  const out = [];
  for (const tok of splitTopLevel(s)) {
    if (LINE_NAMES_RE.test(tok)) continue;
    const rep = /^repeat\(\s*([^,]+)\s*,\s*([\s\S]*)\)$/i.exec(tok);
    if (rep) {
      const body = splitTopLevel(rep[2].trim())
        .filter((t) => !LINE_NAMES_RE.test(t))
        .map((t) => parseTrack(el, t));
      if (!body.length || body.some((t) => t == null)) return [];
      const count = repeatCount(rep[1].trim(), body, contentW, gap, el);
      if (count < 1) return [];   // `repeat(0, …)`: the whole declaration is invalid
      for (let i = 0; i < count; i++) for (const t of body) out.push(t);
      continue;
    }
    const t = parseTrack(el, tok);
    // A token that isn't a track size — a line NAME (`[main-start] 1fr`), an
    // at-rule-ish value, an unresolved `var()` — makes the whole declaration
    // invalid, and an invalid `grid-template-columns` computes to `none`: ONE
    // implicit column the full width, which is what a browser lays out. Sizing the
    // unknown token as a zero-width track instead collapsed every item in it.
    if (t == null) return [];
    out.push(t);
  }
  return out;
}
// `repeat(N, …)` is its count; `auto-fill` / `auto-fit` are as many copies as fit the
// container, which needs the pattern to be fixed-size — otherwise (a `1fr` in there)
// it is one repetition, as the spec requires.
function repeatCount(spec, body, contentW, gap, el) {
  const n = /^\d+$/.test(spec) ? parseInt(spec, 10) : null;
  if (n != null) return n >= 1 ? n : 0;   // `repeat(0, …)` is invalid CSS — see the caller
  if (!/^auto-(?:fill|fit)$/i.test(spec)) return 1;
  // How many fit is decided by each track's MINIMUM — `repeat(auto-fill, minmax(200px,
  // 1fr))`, the card-grid idiom, fits `contentW / 200` of them and the `1fr` then
  // shares out what is left. Counting the max instead (or refusing to count a track
  // that isn't a plain length) collapses the whole grid into one column.
  let per = 0;
  for (const t of body) {
    // The MINIMUM decides how many fit — `minmax(200px, 1fr)`, the card-grid idiom,
    // fits `contentW / 200` of them and the `1fr` shares out what's left. When the
    // minimum isn't a definite length (`minmax(auto, 200px)`) the spec falls back to
    // the maximum, which is the only definite figure there is.
    const fixedOf = (side) => (side.px != null ? side.px : (side.pct != null ? (side.pct / 100) * contentW : null));
    const fixed = (t.floor ? fixedOf(t.floor) : null) ?? fixedOf(t);
    if (fixed == null || fixed <= 0) return 1;   // nothing definite to count against
    per += fixed + gap;
  }
  if (per <= 0) return 1;
  const fits = Math.max(1, Math.floor((contentW + gap) / per));
  // `auto-fit` differs from `auto-fill` in one step: the tracks left EMPTY after
  // placement collapse, and the rest share what they freed. So a 1000px row of
  // `minmax(250px, 1fr)` holding three items is three 333px tracks under auto-fit
  // and four 250px ones (the last empty) under auto-fill.
  if (/^auto-fit$/i.test(spec)) {
    const items = inFlowGridItems(el, fits * body.length);
    if (items > 0) return Math.max(1, Math.min(fits, Math.ceil(items / body.length)));
  }
  return fits;
}
// How many items a grid has to place — the auto-fit collapse counts against it.
function inFlowGridItems(el, colCount) {
  let n = 0;
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') continue;
    n += Math.max(1, Math.min(gridColumnSpan(child, colCount), colCount));
  }
  return n;
}
// One track: a length, a percentage, an `fr`, a keyword, or a function of them.
// `minmax(a, b)` sizes as its MAX and keeps its min as the floor an `fr` share can't
// go below; `fit-content(x)` is max-content capped at x.
function parseTrack(el, text) {
  const s = String(text).trim();
  const mm = /^minmax\(\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*\)$/i.exec(s);
  if (mm) {
    const t = parseTrack(el, mm[2]), floor = parseTrack(el, mm[1]);
    if (t == null || floor == null) return null;
    t.floor = floor;
    return t;
  }
  const fc = /^fit-content\(\s*([\s\S]+?)\s*\)$/i.exec(s);
  if (fc) {
    const cap = parseTrack(el, fc[1]);
    return cap == null ? null : { px: null, pct: null, fr: null, auto: false, fit: cap, floor: null };
  }
  // A NEGATIVE track size is invalid CSS, and one invalid track invalidates the
  // whole `grid-template-columns` — so these answer null rather than clamping.
  const fr = /^(-?\d*\.?\d+)fr$/i.exec(s);
  if (fr) { const v = parseFloat(fr[1]); return v < 0 ? null : { px: null, pct: null, fr: v, auto: false, floor: null }; }
  const pct = /^(-?\d*\.?\d+)%$/.exec(s);
  if (pct) { const v = parseFloat(pct[1]); return v < 0 ? null : { px: null, pct: v, fr: null, auto: false, floor: null }; }
  const px = lengthPx(el, s);
  if (px != null) return px < 0 ? null : { px, pct: null, fr: null, auto: false, floor: null };
  const k = s.toLowerCase();
  if (k === 'auto' || k === 'min-content' || k === 'max-content') {
    return { px: null, pct: null, fr: null, auto: k === 'auto', min: k === 'min-content', max: k === 'max-content', floor: null };
  }
  return null;   // not a track size — see `gridTrackList`
}
// Split on top-level whitespace only — inside `minmax(…)` / `repeat(…)` the spaces
// and commas belong to the function.
function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // `[…]` is a LINE NAME, not a track — it holds its own spaces, so it has to be
    // kept whole here and dropped by the caller. `(…)` is a function's arguments.
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
// A `[name]` / `[a b]` token names a grid LINE. It sits between tracks and sizes
// nothing, so the sizer skips it — reading it as a track would invalidate the whole
// declaration and collapse the grid to one column (the full-bleed idiom,
// `[full-start] minmax(1em, 1fr) [main-start] … [full-end]`, is written this way).
const LINE_NAMES_RE = /^\[[\s\S]*\]$/;

// The gap between boxes along one axis, for whoever spaces them — a grid's tracks and rows, a
// flex line's items. `gap: <row> <column>` puts the ROW figure FIRST (a single value covers both),
// and the longhand wins over the shorthand whichever order they cascade in, because
// `declaredValue` already resolved that. Reading the first token of `gap: 10px 40px` as the column
// gap took the ROW figure, which then fed the track widths, the item offsets AND the auto-fill
// count.
function axisGap(el, axis, basis) {
  const own = declaredValue(el, axis + '-gap');
  if (own != null && String(own).trim() !== 'normal') {
    const px = gapLength(el, String(own).trim(), basis);
    if (px != null) return px;
  }
  const g = declaredValue(el, 'gap') ?? declaredValue(el, 'grid-gap');
  if (g == null) return 0;
  const parts = splitTopLevel(String(g).trim());
  if (!parts.length) return 0;
  const text = axis === 'row' ? parts[0] : parts[parts.length > 1 ? 1 : 0];
  return gapLength(el, text, basis) ?? 0;
}
// A gap is a length or a percentage of the container's own content box along that axis.
function gapLength(el, text, basis) {
  const pct = /^(-?\d*\.?\d+)%$/.exec(text);
  if (pct) return basis == null ? 0 : (parseFloat(pct[1]) / 100) * basis;
  return lengthPx(el, text);
}
// A declared `grid-auto-rows` length, else null: an AUTO row is as tall as its content, and
// pretending otherwise (this used to answer a flat 100px) inflated every grid on the page.
function gridRowHeight(el) {
  const r = declaredValue(el, 'grid-auto-rows');   // `minmax(100px, auto)` / `100px` → 100 (coarse)
  const m = r && PX_RE.exec(String(r));
  return m ? parseFloat(m[1]) : null;
}
// How many columns an item covers. `cols` (when known) resolves the NEGATIVE line
// numbers that count back from the end — `1 / -1`, the full-bleed idiom, is every
// column there is.
// The column an item asks to START in (0-based), or null when it takes the next
// free one. `grid-column: 2 / -1` is placed at line 2, not wherever the flow had
// got to — the half-bleed idiom reads that way.
function gridColumnStart(el, cols) {
  const shorthand = declaredValue(el, 'grid-column');
  const startRaw  = declaredValue(el, 'grid-column-start');
  const raw = startRaw != null ? String(startRaw) : (shorthand != null ? String(shorthand).split('/')[0] : null);
  if (raw == null) return null;
  const m = /^\s*(-?\d+)\s*$/.exec(raw);      // a bare line number; `span N` has no start of its own
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n === 0) return null;
  const line = n < 0 ? cols + 1 + n + 1 : n;   // -1 is the line after the last track
  const idx = line - 1;
  return idx >= 0 && idx < cols ? idx : null;
}
function gridColumnSpan(el, cols = null) {
  const shorthand = declaredValue(el, 'grid-column');
  const startRaw  = declaredValue(el, 'grid-column-start');
  const endRaw    = declaredValue(el, 'grid-column-end');
  const c = shorthand != null ? String(shorthand)
          : (startRaw != null || endRaw != null) ? `${startRaw == null ? 'auto' : startRaw} / ${endRaw == null ? 'auto' : endRaw}`
          : null;
  if (!c) return 1;
  const span = /span\s+(\d+)/i.exec(c);                        // `span 2`
  if (span) return Math.max(1, parseInt(span[1], 10));
  const range = /(-?\d+)\s*\/\s*(-?\d+)/.exec(c);             // `1 / 4`, `1 / -1`
  if (!range) return 1;
  const line = (n) => (n < 0 ? (cols == null ? null : cols + 1 + n + 1) : n);
  const from = line(parseInt(range[1], 10));
  const to   = line(parseInt(range[2], 10));
  if (from == null || to == null) return 1;
  return Math.max(1, to - from);
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
  if (memoFresh(el, "_lbIwPass")) return el._lbIw;
  // Marked BEFORE recursing: a slot assigned its own ancestor would otherwise spin.
  el._lbIwPass = memoStamp(el);
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
  } else if (intrinsic && !intrinsic.ratioOnly) {
    // `ratioOnly` is a ratio with no intrinsic SIZE: its `viewBox` numbers are not lengths, so the
    // box wants whatever its container gives it (Chrome: an absolutely positioned
    // `viewBox="0 0 100 200"` svg in an 800px block is 800x1600, not 100x200).
    inner = { min: intrinsic.width, max: intrinsic.width };
  } else if (laysOutAsFlex(el)) {
    inner = flexIntrinsicWidths(el);
  } else if (laysOutAsTable(el)) {
    // A table brings its own algorithm for the same question, and its rows are not
    // blocks to be measured one at a time — measured that way a nested table came
    // out as wide as its widest single CELL instead of the sum of its columns. That
    // answer is already a border-box figure, so it stands as it is.
    el._lbIw = tableIntrinsicWidths(el);
    return el._lbIw;
  } else {
    inner = contentIntrinsicWidths(el);
  }
  // `width: min-content` / `max-content` pin the box to that one figure (CSS Sizing 3 §5);
  // `fit-content` leaves both, and the room on offer decides between them.
  const keyword = widthKeyword(el);
  if (keyword === 'min-content') inner = { min: inner.min, max: inner.min };
  else if (keyword === 'max-content') inner = { min: inner.max, max: inner.max };
  el._lbIw = { min: inner.min + extra, max: inner.max + extra };
  return el._lbIw;
}
// `width` takes the intrinsic-size KEYWORDS as well as a length, and `resolveLayoutProp` answers
// for none of them (they size the box from what it HOLDS, which needs the walk above).
function widthKeyword(el) {
  const v = declaredValue(el, 'width');
  if (v == null) return null;
  const k = String(v).trim().toLowerCase();
  return (k === 'min-content' || k === 'max-content' || k === 'fit-content') ? k : null;
}
const ZERO_WIDTHS = { min: 0, max: 0 };
// `white-space` values that never wrap: their min-content IS their max-content.
const NON_WRAPPING_WS = new globalThis.Set(['pre', 'nowrap']);

// A flex container's intrinsic widths are its ITEMS', stacked the way its own axis stacks them:
// along a ROW they sum, with the gaps and the items' margins between them, while down a COLUMN the
// widest wins. Measured in Chrome, a float squeezed into a zero-width parent: two 60px items are
// 120 wide across a row and 60 down a column, 130 with a 10px `column-gap`, and 128 with an 8px
// margin between them. A WRAPPING row's min-content is one item wide, because each of them can have
// a line to itself — its max-content still sums, since nothing has to break.
//
// Without this a flex container answered as a stack of BLOCKS — as wide as its widest child — so
// an `inline-flex` badge or an abspos menu came out at one item's width. Harmless while everything
// shrank onto one line; once `flex-wrap` was modelled it broke such a container into a line per
// item, where a browser keeps them on one and is simply wider.
//
// The per-item figure is its main-size CONTRIBUTION, which along a row is its flex base clamped by
// its own minimum and maximum — not its declared width (Chrome: `flex: 0 0 30px` on a 60px item
// contributes 30, so the row is 90 and not 120). Down a column the main axis is vertical and an
// item contributes the width it wants, as any block child would.
//
// A WRAPPING column is the one shape this cannot answer: its width is the sum of its LINES, and
// which items share a line depends on their heights, which is a layout. So a wrapping column that
// is also shrink-to-fit — an abspos one — comes out as wide as its widest item and its later lines
// overflow to the right (Chrome makes it 60 for two lines of 30). An inline-level one is fine: the
// inline pass reads the box back after laying it out.
function flexIntrinsicWidths(el) {
  // …along the axes the container is actually laid out on, not the ones its keyword names: what
  // makes an X measurement a SUM or a MAX is whether the main axis runs across the page, which in a
  // vertical writing mode is the opposite of what `flex-direction` says. Asking the keyword sized a
  // `vertical-rl` column by its widest item and then let the row routine shrink the items to half
  // their declared width inside that box.
  const plan = flexAxisPlan(el);
  const column = !plan.mainIsX;
  const wrap = !column && wrapsFlexLines(plan.wrapMode);
  let min = 0, max = 0, count = 0;
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') continue;   // out of flow: sizes nothing
    const e = edgeInsets(child, null);
    const w = intrinsicWidths(child);
    let itemMin = w.min, itemMax = w.max;
    if (!column) {
      const extra = isBorderBox(child) ? 0 : e.left + e.right;
      const basis = resolveLayoutProp(child, 'flex-basis', null);
      if (basis != null) {
        const fixed = basis + extra;
        // A basis the item can GROW past is not what it wants to be: `flex-basis: 0; flex-grow: 1`
        // asks for a share of the line, and a container sized to the sum of those zeroes is as wide
        // as its borders. §9.9 resolves that with flex fractions; taking the item's own max-content
        // is the coarse form of the same answer, and it is what keeps a nested `flex-basis: 0` row
        // from being measured so narrow that its text wraps (the `bug1144312` shape in
        // `intrinsic-size/row-use-cases-001`). A basis it CANNOT grow past is the contribution
        // outright — Chrome's row of a `flex: 0 0 30px` item declaring `width: 60px` is 30 wide.
        if (flexParts(child).grow > 0) itemMax = Math.max(itemMax, fixed);
        else itemMin = itemMax = fixed;
      }
      if (mayConstrainSize(child)) {
        const lo = resolveLayoutProp(child, 'min-width', null);
        const hi = resolveLayoutProp(child, 'max-width', null);
        if (hi != null && hi >= 0) { itemMin = Math.min(itemMin, hi + extra); itemMax = Math.min(itemMax, hi + extra); }
        if (lo != null && lo >= 0) { itemMin = Math.max(itemMin, lo + extra); itemMax = Math.max(itemMax, lo + extra); }
      }
    }
    const margins = e.ml + e.mr;
    count++;
    if (column) {
      min = Math.max(min, itemMin + margins);
      max = Math.max(max, itemMax + margins);
    } else {
      max += itemMax + margins;
      if (wrap) min = Math.max(min, itemMin + margins);
      else min += itemMin + margins;
    }
  }
  if (!column && count > 1) {
    const gaps = axisGap(el, plan.mainGap, null) * (count - 1);
    max += gaps;
    if (!wrap) min += gaps;
  }
  return { min, max };
}

// The same two figures for what `el` CONTAINS. Text runs and inline boxes share a
// line — their max-content sums along it, their min-content is the widest single
// word — while a block child breaks the line and contributes its own outer width
// to both.
function contentIntrinsicWidths(el) {
  if (memoFresh(el, "_lbCiwPass")) return el._lbCiw;
  el._lbCiwPass = memoStamp(el);
  el._lbCiw = ZERO_WIDTHS;
  // ONE walk over the inline content with a PEN, the way the flow itself lays a line: the text of
  // every inline descendant lands on the same line as its neighbours, a preserved newline or a
  // `<br>` ends the line wherever it sits, and a tab advances from where the line has reached.
  // Measuring each node from zero and summing them — what this did before — made a two-line
  // `<pre>` as wide as both lines together (57.6 where Chrome wants the wider line's 38.41), put a
  // tab in a `<b>` at the first stop instead of the pen's, and split a word an inline box cuts
  // ("ab<b>cd</b>") into two for min-content.
  //
  // `line` is the pen: the widest line is the MAX-content width. `word` is the unbreakable run
  // since the last break opportunity, across inline boundaries: the widest is the MIN-content
  // width. A collapsible space is an opportunity, and content only once something follows it on
  // the line — a TRAILING one hangs and contributes nothing (Chrome: `<td>td` and `<td>td\n` are
  // the same width, and measuring the newline made one column of an evenly-split table 14px wider
  // than the other). White space between two floats is on no line at all (Chrome: a box holding
  // two 50px floats written on one source line wants 100, not 104.45).
  let min = 0, max = 0, line = 0, word = 0, pendingSpace = 0, inlineOnLine = false;
  const endLine = () => {
    if (line > max) max = line;
    if (word > min) min = word;
    line = 0; word = 0; pendingSpace = 0; inlineOnLine = false;
  };
  const opportunity = () => { if (word > min) min = word; word = 0; };
  const takePending = () => { line += pendingSpace; pendingSpace = 0; };
  const widest = (w) => { if (w > min) min = w; };
  const text = (data, owner) => {
    const mode = whiteSpaceOf(owner);
    const preserves = PRESERVING_WS.has(mode);
    const wraps = modeWraps(mode);
    if (preserves) {
      // `pre` / `pre-wrap` / `break-spaces`: every character is content, a newline ends the
      // line, and under a wrapping mode a space is where the line may break. A tab advances to
      // the block's next stop from the pen (`tabStopOf`).
      const tab = data.indexOf('\t') !== -1 ? tabStopOf(el, owner) : null;
      const segments = data.split('\n');
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) endLine();
        const seg = segments[i];
        if (!seg) continue;
        takePending();
        inlineOnLine = true;
        if (!wraps) {
          const w = measureRun(seg, owner, line, tab);
          line += w; word += w;
          continue;
        }
        for (const token of seg.split(WS_SPLIT_RE)) {
          if (!token) continue;
          const w = measureRun(token, owner, line, tab);
          if (CSS_WS_RE.test(token)) opportunity();
          else word += w;
          line += w;
        }
      }
      return;
    }
    // A collapsing mode: runs of white space are one space, kept only between two pieces of
    // content on the line; `pre-line` keeps its newlines as forced breaks. A `nowrap` run never
    // breaks, so its words join into one unbreakable unit.
    const keepsNewlines = mode === 'pre-line';
    const spaceW = measureRun(' ', owner);
    const segments = keepsNewlines ? data.split('\n') : [data];
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) endLine();
      const run = segments[i].replace(/[ \t\n\r\f]+/g, ' ');
      if (!run) continue;
      if (run === ' ') {
        if (inlineOnLine) pendingSpace = spaceW;
        if (wraps) opportunity();
        continue;
      }
      const leads = run.charCodeAt(0) === 0x20, trails = run.charCodeAt(run.length - 1) === 0x20;
      if (leads) { if (inlineOnLine) pendingSpace = spaceW; if (wraps) opportunity(); }
      const words = run.trim().split(' ');
      for (let k = 0; k < words.length; k++) {
        if (k === 0) takePending();
        else { line += spaceW; if (wraps) opportunity(); }
        const w = measureRun(words[k], owner, line);
        line += w; word += w;
      }
      inlineOnLine = true;
      if (trails) { pendingSpace = spaceW; if (wraps) opportunity(); }
    }
  };
  const walk = (node) => {
    for (const child of layoutChildren(node)) {
      if (child.nodeType === 3 /* text */) { text(child._data || child.data || '', node); continue; }
      if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
      // A `<br>` ends the line it is on even at MAX-content width — nothing after it can share
      // that line, so a box holding `one<br>two<br>three` wants the widest of the three, not their
      // sum (Chrome: 36.47, where summing them said 140.53 and made every such flex item four
      // times too wide before it was even shrunk).
      if (child.tagName === 'BR') { endLine(); continue; }
      const pos = positionOf(child);
      if (pos === 'absolute' || pos === 'fixed') continue;   // out of flow: sizes nothing
      // A FLOAT packs beside its neighbours exactly as an inline-level box does — a box holding
      // two 50px floats wants 100 at max-content and 50 at min-content
      // (`flex-basis-intrinsics-001`) — but it is not inline CONTENT: the white space around it
      // collapses to nothing. Its own MARGINS are part of what it asks for, because they are part
      // of the rectangle the lines route around (Chrome: a button around a 100px float with 10px
      // margins shrink-wraps to 132, its chrome included).
      if (isFloated(child)) {
        const w = intrinsicWidths(child);
        const fm = edgeInsets(child, null);
        line += w.max + fm.ml + fm.mr;
        widest(w.min + fm.ml + fm.mr);
        continue;
      }
      const d = displayOf(child);
      if (d === 'inline') {
        // An inline BOX: its own edges are content on the line and inside the word, and what it
        // holds continues the line — and the word — its neighbours are on.
        const ce = edgeInsets(child, null);
        takePending();
        line += ce.ml + ce.left; word += ce.ml + ce.left;
        inlineOnLine = true;
        walk(child);
        line += ce.right + ce.mr; word += ce.right + ce.mr;
        continue;
      }
      if (INLINE_LEVEL.has(d)) {
        // An ATOMIC inline (inline-block, inline-flex, a replaced element): one unbreakable unit
        // the line may break on either side of.
        const w = intrinsicWidths(child);
        takePending();
        opportunity();
        line += w.max;
        widest(w.min);
        inlineOnLine = true;
        opportunity();
        continue;
      }
      endLine();
      const w = intrinsicWidths(child);
      if (w.max > max) max = w.max;
      widest(w.min);
    }
  };
  walk(el);
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
// How tall a box is that a browser sizes from its FONT rather than from its line box: the
// font's content box, ascent + descent, which is shorter than the line box the line gap
// makes — Chrome makes a 16px inline span 17 tall on an 18px line. A `<br>` and every
// fragment of an inline box are this tall.
function fontContentHeight(el) {
  const f = fontOf(el);
  return f && f.table && f.table.asc ? fontBoxHeight(f, false) : lineHeightOf(el);
}

const TABLE_INTERNAL_DISPLAY = new globalThis.Set([
  'table-row', 'table-row-group', 'table-header-group', 'table-footer-group',
  'table-cell', 'table-column', 'table-column-group'
]);
function isTableDisplay(d) { return d === 'table' || d === 'inline-table'; }

// …and whether it has a table to lay out. A table box whose whole content is ANONYMOUS —
// no rows, no caption, just text — is laid out as ordinary flow by a browser (Chrome makes
// `<span style="display:inline-table">hi</span>` 12.45 x 18); the column algorithm has
// nothing to say about it and answered 0 x 0. An EMPTY table is still a table (0 x 0), and
// so is one holding only a caption.
function laysOutAsTable(el) {
  if (!isTableDisplay(displayOf(el))) return false;
  const grid = tableGrid(el);
  return grid.rows.length > 0 || grid.captions.length > 0 || !hasBareText(el);
}

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
  if (memoFresh(el, "_lbHalvePass")) return el._lbHalve;
  el._lbHalvePass = memoStamp(el);
  el._lbHalve = displayOf(el) === 'table-cell' && tableCollapses(el);
  return el._lbHalve;
}

// The cell grid: rows in RENDER order (a header group first and a footer group last,
// whatever the source says — Chrome), each cell at the first column its row still has
// free, so a `rowspan` from an earlier row pushes the cells beside it right.
function tableGrid(table) {
  if (structFresh(table, '_lbGridPass')) return table._lbGrid;
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
  table._lbGridPass = structStamp(table);
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
  if (memoFresh(table, "_lbColsPass")) return table._lbCols;
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
  table._lbColsPass = memoStamp(table);
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
// A box with an intrinsic RATIO and no intrinsic SIZE — an `<svg viewBox>` — has no width of its
// own to shrink to. CSS 2.1 §10.3.8 leaves that case undefined and Chrome stretches it to whatever
// space is on offer, then derives the other axis from the ratio (measured: an absolutely positioned
// one is 800 wide in an 800px block and 790 with `left: 10px`; a lone flex item is 800, and 792
// beside an 8px sibling). Where there is no space to offer — a shrink-to-fit container — it is 0,
// which is what its content-based intrinsic widths already say.
// ── Floats (CSS 2.1 §9.5) ────────────────────────────────────────────────────────────────────
// A float is taken out of the flow and shifted as far to one side as it fits, and the LINES
// around it are shortened to make room — the blocks holding those lines are not, which is the
// whole shape of the feature: a floated image sits inside the paragraph's box with the text
// wrapping beside it. So a float is a RECTANGLE recorded in the block formatting context it was
// placed in, every line below its top routes around it, and the flow's own cursor never advances
// past it.
//
// The context lives on the layout `ctx` and is swapped by whoever starts a new formatting context
// (`startsFloatContext`), because a float neither escapes its own context nor intrudes into one
// nested inside it.
function newFloatContext(owner) { return { items: [], owner }; }
// HTML's widgets — whose UA BOX `blockify` resolves in the same breath — and the replaced boxes.
// (`<legend>` is deliberately absent from both: outside a fieldset it is an ordinary box that
// takes the display the page gives it, which `legend-sans-fieldset-display` pins across the table
// displays.)
const OWN_CONTEXT_TAGS = new globalThis.Set([
  ...WIDGET_TAGS, 'img', 'canvas', 'video', 'audio', 'object', 'embed', 'iframe', 'frame', 'svg'
]);

// A `<button>` is as wide as its content wants, whatever display it has and however much room it
// is given — HTML's button layout is the shrink-to-fit algorithm (`button-layout/shrink-wrap`:
// 100 / 200 / 250 for one button in a 50 / 200 / 300px block). A block-level one filled its
// container here, which is 900px of clickable target where Chrome draws 132.
function shrinkWrapsToFit(el) { return el._tag === 'button'; }

// Which boxes start a formatting context of their own — a float never crosses this boundary in
// either direction. The root element, anything out of flow, a float, an atomic inline, a table
// part, a flex / grid item's box, and any scroll container (`overflow` other than `visible`),
// which is what `clipsContent` already answers.
function startsFloatContext(el, disp) {
  // The ROOT element's context is the page's: a float in `<body>` is contained by the document,
  // and nothing above it can contain anything. Asked of the FLAT tree — a box whose DOM parent is
  // a shadow root is an ordinary box inside its host, not a root of anything (a `<slot>`'s children
  // collapsed no margins at all while this read `_parent`).
  const parent = flatTreeParent(el);
  if (!parent || parent.nodeType !== NODE_ELEMENT) return true;
  // HTML's widgets and replaced boxes are their own formatting context whatever `display` the page
  // gives them — `html/rendering/widgets/button-layout/display-other` is eighteen subtests saying
  // exactly that (measured: a `<button style="display: block">` sits BESIDE a float, where a
  // `<div style="display: block">` overlaps it).
  if (OWN_CONTEXT_TAGS.has(el._tag)) return true;
  // `contents` generates no box at all, so it can establish nothing and it can neither float nor
  // be positioned: its children belong to the context around it, margins and floats included.
  // (`isFloated` says the same thing about the float, but this answers without touching the
  // cascade at all.)
  if (disp === 'contents') return false;
  // The display is in hand already, so it answers before anything has to be read from the cascade:
  // every box that is not an ordinary block or inline starts a context of its own anyway.
  if (disp !== 'block' && disp !== 'list-item' && disp !== 'inline') return true;
  if (isFloated(el)) return true;
  const pos = positionOf(el);
  if (pos === 'absolute' || pos === 'fixed') return true;
  if (clipsContent(el)) return true;
  // …and an ITEM of a flex or grid container is one too, whatever display it carries: each column
  // of a flex row lays its own floats out from its own top (`br-clear-presentational-hints` is four
  // such columns). The parent's display is memoised by the time any child asks — a box is laid out
  // after the box around it.
  const pd = displayOf(parent);
  return pd === 'flex' || pd === 'inline-flex' || pd === 'grid' || pd === 'inline-grid';
}

// The band a line box of height `h` starting at `y` has to itself: the containing block's content
// edges, moved in by every float that overlaps that band. A zero-height line still asks — an
// empty line box sits beside a float exactly as a full one does.
function floatBand(fc, y, h, left, right) {
  let l = left, r = right;
  if (!fc) return { left: l, right: r };
  const bottom = y + Math.max(h, 1);
  for (const f of fc.items) {
    if (f.bottom <= y || f.top >= bottom) continue;
    if (f.side === 'left') { if (f.right > l) l = f.right; }
    else if (f.left < r) r = f.left;
  }
  return { left: l, right: Math.max(l, r) };
}

// The first y at or below `y` where a band of `h` is at least `w` wide: what a float that does
// not fit beside the ones already there drops to (§9.5.1 rule 3), and where a line too narrow for
// its first word starts instead. The candidates are the float bottoms — the band only ever widens
// there — so this is a scan of the context, not a search over pixels.
function floatFitY(fc, y, w, left, right, h) {
  if (!fc || !fc.items.length) return y;
  const stops = [y];
  for (const f of fc.items) if (f.bottom > y) stops.push(f.bottom);
  stops.sort((a, b) => a - b);
  for (const at of stops) {
    const band = floatBand(fc, at, h, left, right);
    if (band.right - band.left >= w) return at;
  }
  return stops[stops.length - 1];
}

// Where a box with `clear` starts: below every float on the side(s) it named.
function clearanceY(fc, y, clear) {
  if (!fc) return y;
  const both = clear === 'both';
  let out = y;
  for (const f of fc.items) {
    if (!both && f.side !== clear) continue;
    if (f.bottom > out) out = f.bottom;
  }
  return out;
}

// `float: inline-start` and `clear: inline-end` resolve against the CONTAINING BLOCK's direction,
// not the box's own — an `rtl` float inside an `ltr` block floats LEFT (css-logical §float, which
// `logical-values-float-clear-reftest` covers in 96 combinations). An inline box is not a
// containing block for a float, so its direction is skipped along the way.
function flowRelativeRtl(el) {
  let p = flatTreeParent(el);
  while (p && p.nodeType === NODE_ELEMENT && displayOf(p) === 'inline') p = flatTreeParent(p);
  return !!(p && p.nodeType === NODE_ELEMENT && flowSides(p).rtl);
}

// The `clear` keyword in effect for `el`, or null. `inline-start` / `inline-end` are the
// flow-relative spellings of the same two sides.
function clearOf(el) {
  const c = declaredValue(el, 'clear');
  if (c == null) return null;
  const v = String(c).trim().toLowerCase();
  if (v === 'both') return 'both';
  if (v === 'left' || v === 'right') return v;
  if (v !== 'inline-start' && v !== 'inline-end') return null;
  const rtl = flowRelativeRtl(el);
  return (v === 'inline-start') === rtl ? 'right' : 'left';
}

// Which side `el` floats to, resolving the flow-relative keywords the same way.
function floatSide(el) {
  const v = String(declaredValue(el, 'float')).trim().toLowerCase();
  if (v === 'left' || v === 'right') return v;
  return (v === 'inline-start') === flowRelativeRtl(el) ? 'right' : 'left';
}

// The lowest edge any float in the context reaches — what a box that CONTAINS its floats (one
// that started the context) has to grow to.
function floatsBottom(fc) {
  let bottom = -Infinity;
  if (fc) for (const f of fc.items) if (f.bottom > bottom) bottom = f.bottom;
  return bottom;
}

// A float is placed where the flow has reached — beside the floats already there if it fits, below
// the shallowest of them if it does not — and the flow cursor does NOT move past it: the next block
// starts where this one would have, with its lines shortened instead (§9.5.1). `top0` is the flow
// position its MARGIN box hangs from, which the caller knows and this does not.
//
// A module-level function rather than a closure over the block's flow: every block box on the page
// would otherwise allocate one, and almost none of them holds a float.
function placeFloat(child, pos, ctx, content, right, top0) {
  const fc = ctx.floats;
  const cm = edgeInsets(child, content.width);
  // §10.3.5: a float's auto width shrinks to fit, and its auto margins compute to zero.
  const avail = Math.max(0, content.width - cm.ml - cm.mr);
  const size  = usedSize(child, shrinkToFitWidth(child, avail), 0, content.width, content.height || null);
  const outer = size.width + cm.ml + cm.mr;
  const side  = floatSide(child);
  // What the lines route around is the float's MARGIN box, and that box's top is where the flow
  // has reached: the current line's top while one is open (which is what keeps a float written
  // mid-paragraph beside that paragraph's first line), below a preceding block's still-open
  // bottom margin, and never above a float it has to clear. A float's own margins never collapse
  // with anything (§8.3.1), so its top margin is added rather than collapsed into that one.
  const clear = clearOf(child);
  const outerH = size.height + cm.mt + cm.mb;
  let marginTop = top0;
  if (clear) marginTop = Math.max(marginTop, clearanceY(fc, marginTop, clear));
  marginTop = floatFitY(fc, marginTop, outer, content.x, right, outerH);
  const top  = marginTop + cm.mt;
  const band = floatBand(fc, marginTop, outerH, content.x, right);
  const x = side === 'left' ? band.left + cm.ml : band.right - outer + cm.ml;
  const rel = flowShift(child, pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null);
  layoutElement(child, { x: x + (rel ? rel.x : 0), y: top + (rel ? rel.y : 0),
                         width: size.width, height: size.height, autoHeight: size.autoHeight },
                ctx, content.width);
  child._lbMargins = { left: cm.ml, right: cm.mr };
  // The RECTANGLE the lines route around is the float's margin box, and it is recorded where the
  // box would have been: a relative offset moves the painted box, not what the flow avoids.
  fc.items.push({ side, left: x - cm.ml, right: x + child._lb.width + cm.mr,
                  top: marginTop, bottom: top + child._lb.height + cm.mb });
}

// ── Margin collapsing (CSS 2.1 §8.3.1) ───────────────────────────────────────────────────────
// Two vertical margins ADJOIN when nothing separates them — no border, no padding, no line box,
// no clearance, and no formatting context of the box's own — and adjoining margins collapse into
// ONE. The adjacent-sibling case is the block flow's own; these answer the other half, which is
// what a box's own margins do with its CHILDREN's:
//
//   `<div><p>text</p></div>` — the p's margin is the DIV's, so the div is 18 tall and starts 16
//   lower, where keeping the margin inside made it 50 (Chrome-measured, and every page that does
//   not reset its margins is this shape).
//
// A RUN of adjoining margins is not a fold of pairs: it is `max(positives) + min(negatives)` over
// the whole set, and folding pairwise gets a three-margin run wrong (20, -30, 20 is -10, where
// folding left to right says +10). So a run travels as the pair it is and becomes a number only
// where the flow actually advances.
const EMPTY_RUN = { pos: 0, neg: 0 };
const marginRun = (m) => (m < 0 ? { pos: 0, neg: m } : { pos: m, neg: 0 });
const joinRuns = (a, b) => ({ pos: a.pos > b.pos ? a.pos : b.pos, neg: a.neg < b.neg ? a.neg : b.neg });
const runValue = (run) => run.pos + run.neg;

// A box establishes a BLOCK FORMATTING CONTEXT — and so keeps its children's margins inside it —
// when it floats, is out of flow, is an item of a flex or grid container, is anything but an
// ordinary block, scrolls (`startsFloatContext` answers all of those for floats already), or is
// contained / multicol. The last two are gated on the rule index: almost no page declares either,
// and this runs for every box a margin passes.
function establishesBFC(el, disp) {
  if (memoFresh(el, '_lbBfcPass')) return el._lbBfc;
  el._lbBfcPass = memoStamp(el);
  return (el._lbBfc = computeEstablishesBFC(el, disp));
}
function computeEstablishesBFC(el, disp) {
  if (startsFloatContext(el, disp)) return true;
  if (declaresLayoutProp(el, 'contain')) {
    const contain = declaredValue(el, 'contain');
    if (contain && /\b(layout|paint|content|strict)\b/i.test(String(contain))) return true;
  }
  for (const prop of ['column-count', 'column-width']) {
    if (!declaresLayoutProp(el, prop)) continue;
    const v = declaredValue(el, prop);
    if (v != null && String(v).trim().toLowerCase() !== 'auto' && String(v).trim() !== '') return true;
  }
  return false;
}

// A border or padding at that edge stands between the two margins; at the BOTTOM, so does a height
// of the box's own.
function marginsAdjoinTop(el, edge) {
  return edge.top === 0 && !establishesBFC(el, displayOf(el));
}
function marginsAdjoinBottom(el, edge, autoHeight) {
  return autoHeight && edge.bottom === 0 && !establishesBFC(el, displayOf(el));
}

// The width a CHILD's percentage margins resolve against: its own content box. Asked before the
// child is laid out, so it is derived rather than read — a percentage margin resolved against the
// grandparent's width put a `margin-top: 10%` child of a 200px block 102px down instead of 20.
function marginBasis(el, cbW) {
  const edge = edgeInsets(el, cbW);
  const w = resolveLayoutProp(el, 'width', cbW);
  if (w != null) return isBorderBox(el) ? Math.max(0, w - edge.left - edge.right) : w;
  return Math.max(0, cbW - edge.ml - edge.mr - edge.left - edge.right);
}

// The in-flow BLOCK children a margin can travel through, in order — the walk stops at anything
// that is content rather than a box (a word, an inline box), because a line box separates margins.
// A plain array rather than a generator: this is asked of every box a margin passes, and an
// iterator per ask was a measurable share of a layout pass on a deeply nested page.
function marginChildren(el, backwards) {
  const kids = layoutChildren(el);
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[backwards ? kids.length - 1 - i : i];
    if (child.nodeType === NODE_TEXT) {
      if (NON_WS_RE.test(child._data || child.data || '')) break;
      continue;
    }
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    if (isFloated(child)) continue;
    const pos = positionOf(child);
    if (pos === 'absolute' || pos === 'fixed') continue;
    if (isInlineLevel(child)) break;
    out.push(child);
  }
  return out;
}

// Is this height DECLARED as something that keeps the box's two margins apart? `auto`, an absent
// value, a plain zero and the intrinsic keywords all leave them adjoining; a length or a
// percentage stands between them — and it is the DECLARATION that decides, not what it resolves to
// here: a `height: 100%` is a real height even where this has no basis to resolve it against, and
// treating it as auto collapsed a percentage-sized box to nothing.
const AUTO_HEIGHT_KEYWORDS = new globalThis.Set(['', 'auto', 'initial', 'unset', 'revert', 'revert-layer',
                                                 'min-content', 'max-content', 'fit-content', 'inherit']);
function autoOrZeroHeight(el, prop) {
  const raw = declaredValue(el, prop) ?? uaDefault(el, prop);
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  if (AUTO_HEIGHT_KEYWORDS.has(v)) return true;
  return /^[+-]?0*(\.0*)?(px|em|rem|ex|ch|%|pt|pc|in|cm|mm|q|vw|vh|vmin|vmax)?$/.test(v);
}

// Everything a box's own margins do with its children's, in ONE memoised answer per box:
//
//   `through` — the box COLLAPSES THROUGH: nothing in it keeps its own two margins apart (no
//     border, no padding, no height, no in-flow content that is not itself collapsing through), so
//     its margins join the run around it rather than adding to it — two empty spacers with
//     `margin: 20px` between two paragraphs leave 20px, not 60.
//   `top` / `bottom` — the RUN it brings to the margin above it and hands to the one below,
//     its own margin joined with as many of its first / last children's as keep adjoining.
//
// One record rather than three walks: each of them needs the same edges, the same basis and the
// same child list, and they are asked of every box a margin passes.
function marginInfo(el, cbW) {
  if (memoFresh(el, '_lbMiPass') && el._lbMiCb === cbW) return el._lbMi;
  el._lbMiPass = memoStamp(el);
  el._lbMiCb = cbW;
  // Seeded before the recursion: a cycle cannot happen in a tree, but a re-entrant read during it
  // (a percentage basis that lays something out) must not see a half-built record.
  el._lbMi = MARGIN_INFO_NONE;
  const edge  = edgeInsets(el, cbW);
  const inner = marginBasis(el, cbW);
  const down  = marginChildren(el, false);
  const bfc   = establishesBFC(el, displayOf(el));

  let through = !bfc && edge.top === 0 && edge.bottom === 0 &&
                autoOrZeroHeight(el, 'height') && autoOrZeroHeight(el, 'min-height') &&
                !hasInlineContent(el);
  if (through) {
    for (const child of down) {
      if (!marginInfo(child, inner).through) { through = false; break; }
    }
  }

  // `topOnly` is the run ABOVE this box's own (hypothetical) bottom border: its top margin and its
  // first children's, but not its own bottom one. That is where a box that collapses through is
  // PLACED (§8.3.1), and it is not the same as what the box hands the run — Chrome puts an empty
  // `margin-top: 5px; margin-bottom: 40px` div 5px below the paragraph above it, and 40 above the
  // one below.
  let topOnly = marginRun(edge.mt);
  if (!bfc && edge.top === 0) {
    for (const child of down) {
      // A child that will take CLEARANCE keeps its margin to itself (§8.3.1) — asked structurally,
      // because this answer is needed before any float has been placed.
      if (takesClearance(child)) break;
      const ci = marginInfo(child, inner);
      topOnly = joinRuns(topOnly, ci.top);
      if (!ci.through) break;
    }
  }
  const top = through ? joinRuns(topOnly, marginRun(edge.mb)) : topOnly;

  let bottom = marginRun(edge.mb);
  if (through) bottom = joinRuns(bottom, marginRun(edge.mt));
  // §8.3.1: the bottom margins adjoin only where the box has no height of its own and nothing
  // below its last child — a `height: 0` box still adjoins, which is why this asks the
  // DECLARATION rather than the used size.
  if (through || (!bfc && edge.bottom === 0 && autoOrZeroHeight(el, 'height'))) {
    for (const child of marginChildren(el, true)) {
      const ci = marginInfo(child, inner);
      bottom = joinRuns(bottom, ci.bottom);
      if (!ci.through) break;
    }
  }
  return (el._lbMi = { through, top, topOnly, bottom });
}
const MARGIN_INFO_NONE = { through: false, top: EMPTY_RUN, topOnly: EMPTY_RUN, bottom: EMPTY_RUN };

function collapsesThrough(el, cbW) { return marginInfo(el, cbW).through; }
function collapsingBottomMargin(el, cbW) { return marginInfo(el, cbW).bottom; }

function hasInlineContent(el) {
  for (const child of layoutChildren(el)) if (separatesMargins(child)) return true;
  return false;
}
// A node that goes on a LINE, which is what stands between a box's top margin and the margin of
// the next block in it (§8.3.1): a word, an inline box, a `<br>`. White space alone is not content
// and neither is anything out of flow.
function separatesMargins(child) {
  if (child.nodeType === NODE_TEXT) return NON_WS_RE.test(child._data || child.data || '');
  if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) return false;
  if (child._tag === 'br') return true;
  if (isFloated(child)) return false;
  const pos = positionOf(child);
  if (pos === 'absolute' || pos === 'fixed') return false;
  return isInlineLevel(child);
}

// Will this box take CLEARANCE? Clearance is a real separator (§8.3.1: a box's own margin does not
// collapse with its parent's when it has clearance) — but only where there is a float to clear:
// without one, `clear: left` changes nothing at all (Chrome-measured, both ways). Asked
// STRUCTURALLY rather than off the placed floats, because a box's margin is wanted before its own
// subtree — floats included — has been laid out at all.
function takesClearance(el) {
  const clear = clearOf(el);
  return clear ? precedingFloat(el, clear) : false;
}
// Is there a float EARLIER in this box's formatting context — one its `clear` will wait for?
function precedingFloat(el, side) {
  for (let node = el; node; ) {
    const parent = flatTreeParent(node);
    if (!parent || parent.nodeType !== NODE_ELEMENT) return false;
    for (const kid of layoutChildren(parent)) {
      if (kid === node) break;
      if (kid.nodeType !== NODE_ELEMENT || selfNotRendered(kid)) continue;
      if (floatOnSide(kid, side) || subtreeHasFloat(kid, side)) return true;
    }
    if (establishesBFC(parent, displayOf(parent))) return false;
    node = parent;
  }
  return false;
}
function floatOnSide(el, side) {
  return isFloated(el) && (side === 'both' || floatSide(el) === side);
}
function subtreeHasFloat(el, side) {
  if (establishesBFC(el, displayOf(el))) return false;   // its floats are its own
  for (const kid of layoutChildren(el)) {
    if (kid.nodeType !== NODE_ELEMENT || selfNotRendered(kid)) continue;
    if (floatOnSide(kid, side) || subtreeHasFloat(kid, side)) return true;
  }
  return false;
}

// The margin a box brings to the run above it.
function collapsingTopMargin(el, cbW) { return marginInfo(el, cbW).top; }

function ratioOnlyBox(el) {
  const intrinsic = intrinsicSize(el);
  return !!(intrinsic && intrinsic.ratioOnly);
}

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
      const cbox = { x: colX[cell.col], y, width: cw, height: size.height, autoHeight: size.autoHeight };
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
  for (const { el: child, pos } of grid.outOfFlow) placeAbsolute(child, pos, content.x, gridTop, ctx);
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


// ── Text advance widths ──────────────────────────────────────────────────────
// A run's width is the sum of its characters' ADVANCE widths in the element's font,
// scaled by the used font size. The per-character table comes from the font file's
// own `hmtx` (host side: `font_advance_table`), so nothing is rasterised: one host
// call per (family, weight/style) for the whole table, then a few lookups per run.
// Against Chrome the sum lands within ~6% median where the flat 8px/char estimate
// this replaces was ~19% off and up to 177% on narrow or wide strings ("iiii" /
// "WWWW"). Falls back to that estimate when fontconfig can't resolve the family.
// The element's font as the table key + the size to scale by. Memoised per pass,
// and inherited from the parent when the element declares no font of its own —
// the same shortcut lineHeightOf takes, and for the same reason (both resolvers
// walk to the root otherwise).
function fontOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return null;
  if (memoFresh(el, "_lbFontPass")) return el._lbFont;
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
    // …and the two spacings, which the flow adds to every advance it measures. Both INHERIT: an
    // element that declares one reads its own, and one that does not takes its PARENT's record's —
    // the memoised figure, not a fresh inherit walk. Reading the computed value here instead lost
    // an ancestor's inline `letter-spacing` at every descendant with a font of its own (a `<b>`,
    // a `font-size`), because the O(1) gate sees the element's own inline map and not its
    // ancestors' — measured, `<div style="letter-spacing:10px"><b>abcd</b>` at 38.4 where Chrome
    // has 78.41 — and, once any rule declared the property, cost two inherit walks per own-record
    // element (+4.7% on a text-heavy relayout).
    const inherited = parent && parent.nodeType === NODE_ELEMENT ? fontOf(parent) : null;
    el._lbFont = { table, size: computedFontSizePx(el) || 16,
                   ls: declaresSpacing(el, 'letter-spacing') ? computedLetterSpacingPx(el) : (inherited ? inherited.ls : 0),
                   ws: declaresSpacing(el, 'word-spacing')   ? computedWordSpacingPx(el)   : (inherited ? inherited.ws : 0) };
  }
  el._lbFontPass = memoStamp(el);
  return el._lbFont;
}

// True when `el` neither declares a font of its own nor gets one from the UA
// stylesheet — its font, and therefore its line box, are exactly its parent's.
// Memoised per pass and shared by fontOf / lineHeightOf: the two used to run four
// and two cascade lookups per element respectively (measured +27% on a text-heavy
// relayout, all of it here).
function inheritsFont(el) {
  if (memoFresh(el, "_lbInhPass")) return el._lbInh;
  el._lbInh = !declaresOwnFont(el);
  el._lbInhPass = memoStamp(el);
  return el._lbInh;
}

// One placed run, for a painter: the text, where its line box starts, and the element whose font
// and colour it takes. The BASELINE is derived here rather than at paint time, because the
// half-leading that centres a font box in a taller line box is the flow's own arithmetic.
//
// At module scope, taking the sink as an argument: inside the flow's per-element closure scope it
// would be one more closure ALLOCATED per element laid out, and the flow already allocates several.
function noteRun(bucket, text, at, owner, width, tabFrom = 0, tab = null) {
  if (!at) return;
  // `width` is the advance the flow RESERVED for this run — the sum of the face's own `hmtx`
  // advances. The rasteriser measures differently (for a system font it reports the ink width,
  // rounded), so a painter that let it choose would draw a run wider than its box and eat the
  // space after it. Carrying the reserved width lets the painter condense to it: one geometry,
  // for text as for boxes.
  // Sunk WHERE IT IS PLACED, so a painter sees the runs in flow order — an atomic inline lays its
  // own out in the middle of this line, and buffering the outer ones to the end would put them
  // after it. The BASELINE is the LINE's rather than this run's own, and the line only knows it
  // when it closes, so the entry is kept and filled in there.
  // `justify`: the px a `text-align: justify` line adds to each SPACE inside this run (a run placed
  // whole — `white-space: pre` / `nowrap` — keeps its spaces inside; see `moveLine`). Declared in
  // the literal so every run has one shape.
  // `tabFrom` / `tab`: where the run starts from the block's content edge and the block's tab
  // stop, for a run holding a tab (0 / null otherwise) — the painter places its characters itself.
  const run = { text, x: at.x, y: at.y, baseline: at.y, owner, width, justify: 0, tabFrom, tab };
  bucket.push(run);
  RUN_SINK(run);
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
function controlBaseline(el, height) {
  const tag = el.tagName;
  const drawsText = tag === 'SELECT' ||
                    (tag === 'INPUT' && !CHROMELESS_INPUTS.has(inputType(el)));
  const e = edgeInsets(el, null);
  if (!drawsText) return tag === 'IMG' ? null : height;
  // A `<select>` showing more than one row is a LIST box rather than a dropdown, and its baseline
  // is its CONTENT box's bottom (measured: 67 of a 70px `multiple`, 50 of a 53px `size=3`).
  if (tag === 'SELECT' && isListBox(el)) return Math.max(0, height - e.bottom);
  const f = fontOf(el);
  const box = f && f.table ? fontBoxHeight(f, false) : lineHeightOf(el);
  const contentH = Math.max(0, height - e.top - e.bottom);
  return e.top + (contentH - box) / 2 + fontAscent(el);
}

// CSS 2.1 §10.8.1, `vertical-align`: where a box sits against the baseline of the line it is on.
// Four of the values SHIFT the box's own baseline (`baseline` by nothing, `sub` and `super` by a
// fraction of the font size, a length by itself, a percentage by that much of the box's own
// `line-height`), three place it against the PARENT's font box (`middle`, `text-top`,
// `text-bottom`), and two against the LINE itself (`top`, `bottom`) — which only the line can
// answer, once it knows how tall it is.
//
// The `sub` / `super` fractions are Chrome's, measured with a zero-height marker on a line whose
// baseline a 200px anchor pins: a superscript rises `font-size / 3 + 1` and a subscript falls
// `font-size / 5 + 1`, exact at 10, 15, 16, 20, 32 and 64px.
const VERTICAL_ALIGN_KEYWORDS = new globalThis.Set(
  ['baseline', 'sub', 'super', 'middle', 'text-top', 'text-bottom', 'top', 'bottom',
   // What HTML's `align=middle` maps to, which no CSS keyword spells: the box's own centre ON the
   // baseline, where CSS's `middle` puts it half an x-height above (measured: a 40px image sits
   // with the line's baseline at 20 for one and 24.23 for the other).
   '-webkit-baseline-middle']);
function verticalAlignFor(el) {
  // Memoised per element per pass: this is asked once per text node, per fragment per line and
  // twice per atomic box, and the answer cannot change inside a layout. Without it the gate alone
  // cost 4% of the layout phase — and on any page carrying a shadow host the rule index answers
  // "yes" unconditionally, so the gate is permanently open there.
  if (memoFresh(el, '_lbVaPass')) return el._lbVa;
  el._lbVaPass = memoStamp(el);
  el._lbVa = resolveVerticalAlign(el);
  return el._lbVa;
}
function resolveVerticalAlign(el) {
  // One rule-index question before any cascade read, the `mayConstrainSize` pattern (rule 3):
  // almost no page declares `vertical-align` at all. The two tags whose UA sheet does are named
  // here, and so is the `align` ATTRIBUTE — a presentational hint is in neither the stylesheet
  // index nor the inline map, so without it an `<img align=top>` moved or not depending on whether
  // some unrelated selector on the page happened to mention the property.
  const tag = el._tag;
  const hinted = el._attrs && el._attrs.align != null;
  if (tag !== 'sub' && tag !== 'sup' && !hinted && !declaresLayoutProp(el, 'vertical-align')) return null;
  const raw = declaredValue(el, 'vertical-align') ?? uaDefault(el, 'vertical-align');
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  // A SHIFT is relative to the parent's baseline, so an inline ancestor's shift carries into this
  // one: Chrome raises the inner `<span>` of two nested `vertical-align: super` boxes twice (its
  // own 6.33 above the outer's), and a `<sub>` inside a `<sup>` lands at 5.66 rather than 12.
  const inherited = inlineParentShift(el);
  if (v === '' || v === 'baseline') return inherited ? { mode: 'shift', px: inherited } : null;
  // `inherit` is the cell's own UA value in Chrome (`td { vertical-align: inherit }`), so it has to
  // resolve here rather than fall through as an unknown keyword.
  if (v === 'inherit') {
    const p = inlineParent(el);
    const up = p ? verticalAlignFor(p) : null;
    return up ? { mode: up.mode, px: up.px } : null;
  }
  if (VERTICAL_ALIGN_KEYWORDS.has(v)) {
    if (v === 'super' || v === 'sub') {
      // …of the PARENT's font, as CSS 2.1 says — "the appropriate superscript position of the
      // parent's font" — which is what a `<sup>` shows: its own text is `smaller`, and it still
      // rises by the 16px parent's 6.33 rather than by its own 13.33px 5.44 (measured: the line
      // is 22.33 tall with its baseline at 18.33).
      const p = el._parent && el._parent.nodeType === NODE_ELEMENT ? el._parent : el;
      const pf = fontOf(p);
      const size = pf ? pf.size : (computedFontSizePx(p) || 16);
      const own = v === 'super' ? size / 3 + 1 : -(size / 5 + 1);
      return { mode: 'shift', px: own + inherited };
    }
    return { mode: v, px: inherited };
  }
  // A LENGTH raises the box by itself, a PERCENTAGE by that much of its own `line-height`.
  const px = gapLength(el, v, lineHeightOf(el));
  return px == null || !isFinite(px) ? (inherited ? { mode: 'shift', px: inherited } : null)
                                     : { mode: 'shift', px: px + inherited };
}

// The inline box this one sits inside, if any — the walk a shift accumulates along. A BLOCK ends
// it: its own alignment is about the line IT sits on, not the lines it holds.
function inlineParent(el) {
  const p = el._parent;
  return p && p.nodeType === NODE_ELEMENT && isInlineLevel(p) && isContinuedInline(p) ? p : null;
}
function inlineParentShift(el) {
  const p = inlineParent(el);
  if (!p) return 0;
  const up = verticalAlignFor(p);
  return up && up.mode === 'shift' ? up.px : 0;
}

// How far a box aligned by `vertical-align` reaches ABOVE its line's baseline. A SHIFT moves the
// box's own baseline; the other three place the box against the PARENT's font box, which is why
// they read the parent's metrics and not the box's own. Measured in Chrome with a 10px box on a
// 16px/18px line whose baseline is 14: `middle` puts it at 4.77 (its centre half an x-height above
// the baseline), `text-top` at 0 (its top on the parent's ascent) and `text-bottom` at 7 (its
// bottom on the parent's descent).
function alignedAscent(el, va, own, outer) {
  if (va.mode === 'shift') return own + va.px;
  const parent = el._parent && el._parent.nodeType === NODE_ELEMENT ? el._parent : el;
  if (va.mode === '-webkit-baseline-middle') return outer / 2;
  if (va.mode === 'middle') return outer / 2 + exHeightOf(parent) / 2;
  if (va.mode === 'text-top') return fontAscent(parent);
  if (va.mode === 'text-bottom') return outer - fontDescent(parent);
  return own;
}

// The font's x-height and descent in px — `ex` and what sits under the baseline of a font box.
function exHeightOf(el) {
  const f = fontOf(el);
  if (!f) return 0;
  // The face's own `sxHeight` where it carries one, else CSS's half-em fallback — the same chain
  // the `ex` UNIT resolves through, so a `middle`-aligned box and a `1ex` length agree.
  const xh = f.table && typeof f.table.xh === 'number' && f.table.xh > 0 ? f.table.xh : 0.5;
  return f.size * xh;
}
function fontDescent(el) {
  const f = fontOf(el);
  return f && f.table ? Math.round(f.table.desc * f.size) : 0;
}

// Where an INLINE box's own font box reaches above the line's baseline, `vertical-align` included.
// A `<sup>` raises its text and the fragment around it together — they are the same box — so both
// callers ask this rather than the raw ascent (measured: a `vertical-align: super` span on a 16px
// line takes the line to 24.33 and puts its own 17px box at the top).
function inlineAscent(el, base) {
  const va = verticalAlignFor(el);
  if (!va || va.mode === 'top' || va.mode === 'bottom') return base;
  return alignedAscent(el, va, base, fontContentHeight(el));
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
// Whether a mode lets a line break at all: `pre` preserves and never wraps, `pre-wrap`
// preserves and does.
const modeWraps = (mode) => mode !== 'nowrap' && mode !== 'pre';
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
  el._lbWs = own || ((el._parent && el._parent.nodeType === NODE_ELEMENT) ? whiteSpaceOf(el._parent) : 'normal');
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
// the text holds one. `tab-size: 0` makes a tab as wide as the letter-spacing alone.
function tabAdvance(pen, tab, ls) {
  if (!(tab.px > 0)) return ls;
  const into = pen - Math.floor(pen / tab.px + 1e-9) * tab.px;
  const dist = tab.px - into;
  return dist < tab.min + 1e-6 ? dist + tab.px : dist;      // `<=`: float32 in Blink says 4.8 < 4.8
}
function measureRun(text, el, from = 0, tab = undefined) {
  const f = fontOf(el);
  if (!f || !f.table) return text.length * AVG_CHAR_PX + spacingOf(text, f);
  // ONE plain loop, no callback: this runs per run per relayout, and a 4000-character textarea
  // value walked through a closure per character cost QuickJS the 0.25s budget Capybara's own
  // `fill_in` spec gives it (0.23s against HEAD's 0.21, and over under a loaded gate). The spacing
  // is summed in the same walk for the same reason.
  const table = f.table, ls = f.ls, ws = f.ws, spaced = ls !== 0 || ws !== 0;
  let units = 0, spacing = 0, prev = -1;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (cp === 0x09) {
      if (tab === undefined) tab = tabStopOf(el);
      spacing += tabAdvance(from + units * f.size + spacing, tab, ls);
      prev = cp;
      continue;
    }
    units += unitOf(text, i, cp, prev, table);
    if (spaced && takesSpacing(cp, prev)) spacing += ls + (cp === 0x20 || cp === 0xA0 ? ws : 0);
    prev = cp;
  }
  return units * f.size + spacing;
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
    unit = block._lbTab = { space: bare + (f ? f.ls + f.ws : 0), min: bare / 2 };
  }
  const v = owner === block || owner.nodeType !== NODE_ELEMENT ? tabSizeOf(block) : tabSizeOf(owner);
  const px = /^[+-]?[\d.]+$/.test(v) ? parseFloat(v) * unit.space : parseFloat(v);
  return { px: Number.isFinite(px) && px > 0 ? px : 0, min: unit.min };
}
// One character's advance in font UNITS — `i` indexes its LAST code unit, `cp` is the code point,
// `prev` the one before it.
function unitOf(text, i, cp, prev, table) {
  // A zero-width character has no advance: a soft hyphen, a joiner, a combining mark that sits
  // on the glyph before it. Charging them the Latin mean made `ab&shy;cd` 9.6px wider than `abcd`.
  if (prev === 0x200D || zeroWidth(cp)) return 0;
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
  const ls = f.ls, ws = f.ws, spaced = ls !== 0 || ws !== 0;
  let prev = -1, pen = from;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xFFFF) i++;
    let adv;
    if (cp === 0x09) {
      if (tab === undefined) tab = tabStopOf(el);
      adv = tabAdvance(pen, tab, ls);
    } else {
      adv = unitOf(text, i, cp, prev, f.table) * f.size;
      if (spaced && takesSpacing(cp, prev)) pen += ls + (cp === 0x20 || cp === 0xA0 ? ws : 0);
    }
    out.push(adv);
    pen += adv;
    prev = cp;
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
// surrogate pair is one character, and so is a CJK glyph outside the advance table. The flow
// used to read neither property at all, so a spaced heading measured at its unspaced width and
// wrapped two lines where Chrome wraps three.
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
  if (prev === 0x200D) return false;                          // joined to the character before
  return !zeroWidth(cp);
}
function zeroWidth(cp) {
  // The common case first and WITHOUT the regex: this is asked for every character of every run
  // on every relayout, and a `\p{M}` test — a string allocation and a Unicode-table lookup — on
  // each of a 4000-character textarea value is what a QuickJS `fill_in` paid for.
  if (cp < 0x20) return true;
  if (cp < 0x7F) return false;                                // printable ASCII
  if (cp <= 0x9F) return true;                                // C1 controls
  if (cp < 0x300) return cp === 0xAD;                         // Latin-1: only the soft hyphen
  if (cp === 0xFEFF || cp === 0xFFFC || cp === 0x200E || cp === 0x200F) return true;
  if (cp >= 0x200B && cp <= 0x200D) return true;
  if (cp >= 0x202A && cp <= 0x202E) return true;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;             // variation selectors
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
  return COMBINING_RE.test(String.fromCodePoint(cp));         // a combining mark, U+0300 and up
}
const COMBINING_RE = /^\p{M}$/u;

// Coarse fallback for callers that only know a character COUNT (no string in hand).

// The total width of the text in `el`'s whole subtree, laid out on ONE line: an inline box is as
// wide as the text inside it, however deeply that text is nested (`<a><span>label</span></a>`).
// `contentIntrinsicWidths` is the richer measure — it knows where a block child breaks the line —
// and this is the flat sum the inline path wants.
function subtreeTextWidth(el) {
  if (memoFresh(el, "_lbTextPass")) return el._lbText;
  el._lbTextPass = memoStamp(el);
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
    } else if (c.nodeType === NODE_ELEMENT && !selfNotRendered(c) && !isOutOfFlowChild(c)) {
      // An out-of-flow box is not part of what its parent wraps — a nav item holding an
      // absolutely positioned dropdown is as wide as its own word, not as wide as the menu
      // (Chrome: 40, and counting the menu pushed the next item 200px right).
      width += subtreeTextWidth(c);
    }
  }
  el._lbText = width;
  return width;
}

// CSS white space — space, tab, newline, CR, form feed. NOT U+00A0: an NBSP is a
// character a line may not break at, and JS `\s` matches it, which is exactly the
// trap that made `10&nbsp;kg` wrap. Every white-space decision in this file goes
// through these two.
const CSS_WS_RE   = /^[ \t\n\r\f]+$/;
const WS_ANY_RE   = /[ \t\n\r\f\u00A0]/;
const TRAILING_WS_RE = /[ \t\n\r\f]+$/;
const WS_SPLIT_RE = /([ \t\n\r\f]+)/;
const NON_WS_RE   = /[^ \t\n\r\f]/;

// The pieces of a word a line may break BETWEEN. Normally there are none — a word is
// atomic — but two cases give a browser more to work with, and both are already
// answerable here:
//
//   - a WIDE character (CJK, fullwidth, Hangul) is its own break opportunity, which
//     is why a Japanese paragraph wraps at all: it has no spaces. `isWideChar` is
//     the same classifier `measureRun` already charges 1em for.
//   - `word-break: break-all` / `overflow-wrap: break-word|anywhere` let a word that
//     doesn't fit break ANYWHERE, which is what an app asks for to keep a long URL
//     inside its column.
//
// One `measureRun` per unit, and for the overwhelmingly common case (a Latin word
// that fits) exactly one for the whole word.
function breakUnits(word, el, avail) {
  let wide = false;
  for (let i = 0; i < word.length; i++) {
    const cp = word.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (isWideChar(cp)) { wide = true; break; }
  }
  // The common case by far: a Latin word, atomic, measured ONCE.
  if (!wide && (measureRun(word, el) <= avail || !breaksAnywhere(el))) return { units: [word], freshLine: false };
  const anywhere = !wide && breaksAnywhere(el);
  const units = [];
  let run = '';
  for (let i = 0; i < word.length; i++) {
    const cp = word.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (cp > 0xFFFF) i++;
    if (isWideChar(cp) || anywhere) {
      if (run) { units.push(run); run = ''; }
      units.push(ch);
    } else {
      run += ch;
    }
  }
  if (run) units.push(run);
  // Only the `overflow-wrap` spelling wants the fresh line; `word-break: break-all`
  // fills the line it is on, and a wide-character run breaks wherever it happens to be.
  return { units, freshLine: anywhere && wordBreakMode(el) !== 'break-all' };
}
// `word-break: break-all` and `overflow-wrap: break-word` / `anywhere` — the two
// declarations that let a line break inside a word.
function breaksAnywhere(el) {
  if (el._lbAnyPass === layoutPass) return el._lbAny;
  el._lbAnyPass = layoutPass;
  const ow = String(declaredValue(el, 'overflow-wrap') || declaredValue(el, 'word-wrap') || '').trim().toLowerCase();
  el._lbAny = wordBreakMode(el) === 'break-all' || ow === 'break-word' || ow === 'anywhere';
  return el._lbAny;
}
function wordBreakMode(el) {
  return String(declaredValue(el, 'word-break') || '').trim().toLowerCase();
}

// The widest single unbreakable run in `text`, measured in `el`'s font — one word's
// worth of min-content, wherever the caller found the run.
function longestWordWidth(text, el) {
  let best = 0;
  for (const word of text.split(WS_SPLIT_RE)) {
    if (!word || CSS_WS_RE.test(word)) continue;
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
  // …but a ratio-only box's `viewBox` numbers are not lengths (see `intrinsicWidths`).
  if (intrinsic && !intrinsic.ratioOnly) return intrinsic.width;
  const e = edgeInsets(el, null);
  const content = contentIntrinsicWidths(el).min + e.left + e.right;
  const declared = resolveLayoutProp(el, 'width', null);
  if (declared == null) return content;
  return Math.min(isBorderBox(el) ? declared : declared + e.left + e.right, content);
}


// The used line-box height for `el`. `line-height` INHERITS, so this goes through
// the same resolver getComputedStyle uses (style-proxy's computedLineHeight —
// "ONE geometry means one value resolution too"): an app that sets
// `body { line-height: 1.6 }` once must size every line below it. `normal` has no
// computed length, so it falls back to a factor over the used font size.
// Memoised per pass — every line placement asks.
function lineHeightOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return LINE_HEIGHT;
  if (memoFresh(el, "_lbLhPass")) return el._lbLh;
  // An element that declares NEITHER line-height nor font-size has exactly its
  // parent's used line height — take the parent's memo instead of re-walking the
  // ancestor chain for both properties. That is the overwhelming majority of
  // elements on a real page (the resolvers each walk to the root otherwise, which
  // made a 1200-row list pay two full walks per row).
  const parent = el._parent;
  if (declaredValue(el, 'line-height') == null && inheritsFont(el) &&
      parent && parent.nodeType === NODE_ELEMENT) {
    el._lbLh = lineHeightOf(parent);
    el._lbLhPass = memoStamp(el);
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
  el._lbLhPass = memoStamp(el);
  return el._lbLh;
}

// Document scroll offsets (standards-mode scrollingElement == documentElement).
// Whether `el` establishes a scroll/clip box (any overflow axis non-`visible`). For occlusion,
// clipping is what matters, so `scroll`/`auto`/`hidden`/`clip` all count.
// Does a flex item SCROLL IN ITS MAIN AXIS? That — not "does it scroll at all" — is what §4.5
// gives an automatic minimum of zero. Asking the looser question squeezed a box that scrolls only
// ACROSS its container to nothing ALONG it, and gave an `overflow: clip` item (which is not a
// scroll container at all) a minimum of zero where its content is the floor.
const OVERFLOW_SCROLLS = new globalThis.Set(['scroll', 'auto', 'hidden']);
function scrollsInAxis(el, axis) {
  return OVERFLOW_SCROLLS.has(usedOverflow(el, axis));
}


// Does this box actually CLIP its content, and IN WHICH AXES? A scroll/clip overflow does — except
// on the root, and on the body when the root took none of its own, where it PROPAGATES to the
// viewport instead (CSS Overflow §3.3) and the element itself stays `visible`. One predicate, so
// the clip chain and the scrollable-extent union can't disagree about the same box.
//
// The axes are kept apart (`_ccX` / `_ccY`) because after the computed-value rule there is exactly
// one box that clips in one axis and not the other — `clip` beside `visible` — and it is a real
// one: a child hanging off the SIDE of an `overflow-y: clip` box is visible and hit-testable in
// Chrome, where unioning the axes made it unclickable.
//
// Memoised per layout pass: `stampExtent` asks once per child, and each miss costs a cascade
// lookup per longhand — a candidate-rule walk with real selector matching — which is
// per-element-per-pass work on the hot path (rule 3).
function clipsContent(el) {
  if (el._ccPass === layoutPass) return el._ccVal;
  el._ccPass = layoutPass;
  const ox = propagatedOverflow(el, 'x'), oy = propagatedOverflow(el, 'y');
  el._ccX = ox !== 'visible';
  el._ccY = oy !== 'visible';
  // …and whether it SCROLLS, which is not the same question: `clip` clips and forbids all
  // scrolling, script included (CSS Overflow 3), so it is neither the scrollport a sticky box
  // sticks within nor something `scrollIntoView` can scroll.
  el._ccScroll = OVERFLOW_SCROLLS.has(ox) || OVERFLOW_SCROLLS.has(oy);
  return (el._ccVal = el._ccX || el._ccY);
}

// Is this box a SCROLL CONTAINER — something the user or a script can scroll? `clipsContent`
// stamps the answer alongside the clip axes, so this shares its per-pass memo.
export function scrollsContent(el) {
  clipsContent(el);
  return el._ccScroll;
}

// Is `eb` pushed entirely out of `p`'s box in an axis `p` actually clips? `clipsContent` stamps
// the two axes and is memoised per pass, so asking it here costs nothing and the flags can never
// be read from a previous pass.
function clippedOutBy(eb, p) {
  if (!clipsContent(p)) return false;
  const pb = renderedBox(p);
  if (!eb || !pb) return false;
  if (p._ccX && (eb.x + eb.width <= pb.x || eb.x >= pb.x + pb.width)) return true;
  if (p._ccY && (eb.y + eb.height <= pb.y || eb.y >= pb.y + pb.height)) return true;
  return false;
}

// Total scroll shift applied to `el` — the document root (documentElement) plus every ancestor
// scroll container. A container renders its descendants offset by its scroll, compounding up.
// A `position: sticky` box scrolls with its container until it reaches the offset it was given,
// and then STAYS there while the container's content keeps scrolling under it — as far as the end
// of its containing block, which pushes it back out. It is laid out in flow like any other box;
// the sticking is a paint-time offset, so it belongs here with the scroll shift rather than in the
// flow. Without it a sticky sidebar scrolled off the top of the viewport as the page moved: a
// click on one of its links then "scrolled it into view" and threw the page's scroll position
// away (Discourse's route-scroll-manager), and a sticky header stopped occluding what it covers
// (Redmine's issue header).
function stickyDelta(el) {
  if (!(globalThis.document && globalThis.document._sawSticky)) return null;
  // Memoised per layout pass AND per scroll: where a sticky box sits is a function of the scroll
  // offset, which does NOT relay the page out.
  if (el._lbStickyPass === layoutPass && el._lbStickyEpoch === scrollEpoch) return el._lbSticky;
  el._lbStickyPass = layoutPass;
  el._lbStickyEpoch = scrollEpoch;
  el._lbSticky = null;
  if (!el._lb || positionOf(el) !== 'sticky') return null;
  // Its containing block is the nearest BLOCK CONTAINER — for a sticky `<th>` that is the TABLE,
  // not the row, which is why a sticky table header holds for the table's whole height in a
  // browser and was releasing at its own row here.
  let parent = flatTreeParent(el);
  while (parent && parent._lb && TABLE_INTERNAL_DISPLAY.has(displayOf(parent))) parent = flatTreeParent(parent);
  while (parent && parent._lb && displayOf(parent) === 'inline') parent = flatTreeParent(parent);
  if (!parent || !parent._lb) return null;
  // The box it may not be pushed out of — its containing block's content box — and the scrollport
  // it sticks INSIDE, which is the nearest scrolling ancestor (the viewport otherwise). Both in
  // the same document coordinates the boxes are in, so the deltas fall out by subtraction.
  const cbEdge = insetsOf(parent);
  const cb = {
    x: parent._lb.x + cbEdge.left, y: parent._lb.y + cbEdge.top,
    width:  Math.max(0, parent._lb.width  - cbEdge.left - cbEdge.right),
    height: Math.max(0, parent._lb.height - cbEdge.top  - cbEdge.bottom)
  };
  const root = globalThis.document && globalThis.document.documentElement;
  let port = null;
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    if (p === root || scrollsContent(p)) {
      // A scroller's constraining rect is its scrollPORT — the padding box, inset by its own
      // padding — not its border box: Chrome pins a sticky child of a `border:10px;padding:20px`
      // scroller 30px in, not at its edge.
      const pe = p === root ? null : insetsOf(p);
      port = p === root
        ? { x: 0, y: 0, ...viewport() }
        : { x: p._lb.x + pe.left, y: p._lb.y + pe.top,
            width:  Math.max(0, p._lb.width  - pe.left - pe.right),
            height: Math.max(0, p._lb.height - pe.top  - pe.bottom) };
      // …in the document coordinates the boxes are in: the scrollport's visible window starts at
      // its own scroll offset.
      if (p === root) { port.x = root._scrollLeft || 0; port.y = root._scrollTop || 0; }
      else            { port.x += p._scrollLeft || 0;   port.y += p._scrollTop || 0; }
      break;
    }
  }
  if (!port) return null;
  const b = el._lb;
  let dx = 0, dy = 0;
  const top    = resolveLayoutProp(el, 'top',    port.height);
  const bottom = resolveLayoutProp(el, 'bottom', port.height);
  const left   = resolveLayoutProp(el, 'left',   port.width);
  const right  = resolveLayoutProp(el, 'right',  port.width);
  if (top != null)    dy = Math.max(dy, (port.y + top) - b.y);
  if (bottom != null) dy = Math.min(dy || 0, (port.y + port.height - bottom - b.height) - b.y) || dy;
  if (left != null)   dx = Math.max(dx, (port.x + left) - b.x);
  if (right != null)  dx = Math.min(dx || 0, (port.x + port.width - right - b.width) - b.x) || dx;
  // …never past the containing block: a sticky box leaves with it rather than outliving it.
  // Clamp ONLY the axes with a sticky inset: an axis with no `top`/`bottom` (or `left`/`right`)
  // never moves, per css-position §6.2 — clamping an unconstrained dx=0 against the CB SHIFTED a
  // box whose coarse-laid static position overflowed its containing block (Discourse's sticky
  // sidebar jumped 324px off-screen the moment it stuck vertically, so every click on it
  // triggered scroll-into-view and wiped the scroll position the route manager was about to save).
  if (top != null || bottom != null) {
    dy = Math.max(Math.min(dy, (cb.y + cb.height) - (b.y + b.height)), cb.y - b.y);
  }
  if (left != null || right != null) {
    dx = Math.max(Math.min(dx, (cb.x + cb.width)  - (b.x + b.width)),  cb.x - b.x);
  }
  el._lbSticky = (dx || dy) ? { dx, dy } : null;
  return el._lbSticky;
}

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
  // …and a STICKY ancestor carries this box with it, exactly as it carries its own.
  const own = stickyDelta(el);
  if (own) { sx -= own.dx; sy -= own.dy; }
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    if (p === root || scrollsContent(p)) { sx += p._scrollLeft || 0; sy += p._scrollTop || 0; }
    const st = stickyDelta(p);
    if (st) { sx -= st.dx; sy -= st.dy; }
    if (isFixedBox(p)) break;
  }
  return { sx, sy };
}

function isFixedBox(el) { return !!(el && el._lb && el._lb.fixed); }

// A `display: contents` element generates NO BOX of its own — only its children's boxes are in the
// tree. Layout still stamps one (its children are placed through it, and the flow needs somewhere
// to keep their band), so every page-visible geometry read has to say so itself: Chrome reports a
// zero `getBoundingClientRect`, no client rects, `offsetWidth` / `offsetHeight` 0 and a null
// `offsetParent` for one. `<slot>` is `display: contents`, so this is every web component's slot.
function generatesBox(el) { return displayOf(el) !== 'contents'; }
globalThis.__csimGeneratesBox = (el) => el.nodeType === NODE_ELEMENT && generatesBox(el);

// `el`'s border-box in VIEWPORT coords (laid-out box minus its ancestor scroll shift), or `null`
// when it generates none.
function renderedBox(el) {
  const box = renderedBoxUntransformed(el);
  if (!box) return null;
  const m = transformChain(el);
  return m ? transformedRect(m, box) : box;
}
function renderedBoxUntransformed(el) {
  return generatesBox(el) ? laidOutBox(el) : null;
}
// …and the same box WITHOUT that rule: where the element's layout box has been carried to by the
// scrolls above it. A `display: contents` element generates no box for the page to measure, but it
// still OWNS text runs (a `<slot>`'s fallback content is the everyday case), and the painter shifts
// those runs by their owner's box — so it asks this one.
// ── transformed geometry ─────────────────────────────────────────────────────
// A transform does not move the element in FLOW — everything around it lays out as though it were
// where it started — but it moves the box the page can MEASURE: `getBoundingClientRect`,
// `getClientRects` and a hit test all see the transformed quad. The driver composed a correct
// matrix for the computed value and then never applied it, so a rotated box measured its
// untransformed self (Chrome makes a `rotate(45deg)` 100×50 box 106.07 square; this said 100×50).
//
// The map from an element's own coordinates to the page's is its transform taken ABOUT ITS ORIGIN,
// and then every transformed ancestor's, outermost last. All the boxes here are already in
// document coordinates, so each step is `translate(origin) · M · translate(-origin)` with the
// origin in those same coordinates.
function transformChain(el) {
  // This runs on every rect read and on every candidate of a hit test, and almost no element on
  // almost any page is transformed — so the ANSWER is memoised per pass first, and the walk that
  // produces it asks the cheap question (does anything declare a transform on this node?) before
  // the expensive one (what matrix does it come to?).
  if (memoFresh(el, '_lbTfPass')) return el._lbTf;
  let m = null;
  let child = null;
  for (let node = el; node && node.nodeType === NODE_ELEMENT; node = flatTreeParent(node)) {
    // …and an ancestor that has already answered carries the whole chain above it with it — but the
    // BOUNDARY into that ancestor is still ours to cross. Skipping it was invisible while every
    // step was a flattened affine and is not now: `rotateX(45deg)` inside a flat parent's
    // `rotateX(45deg)` composed to `rotateX(90deg)` and the box vanished, where each half flattens
    // to a `scaleY(cos 45)` and the pair is a visible half-height box.
    // …and only where the crossing FLATTENS. `flatten(A · B)` equals `flatten(A) · B` on the
    // submatrix the geometry reads iff B is already flat, which is exactly what `crossInto`
    // guarantees when it flattens and never when it does not. Taking the shortcut across a
    // `preserve-3d` boundary applied the ancestor's own flatten one step too early, and made the
    // ANSWER DEPEND ON READ ORDER: `elementFromPoint` warms ancestors before descendants, so a hit
    // test poisoned itself — measured, 25 of 120 nested cases differed cold-vs-warm and the cold
    // answer was Chrome's every time.
    if (node !== el && memoFresh(node, '_lbTfPass') && (!m || !sharesContext(node))) {
      m = crossInto(node, m);
      m = m && node._lbTf ? multiply4(node._lbTf, m) : (node._lbTf || m);
      break;
    }
    if (child) m = crossInto(node, m);
    if (declaresTransform(node)) {
      const t = transformStepOf(node);
      if (t) m = m ? multiply4(t, m) : t;                   // an ancestor's map applies OVER ours
    }
    child = node;
  }
  el._lbTf = m;
  el._lbTfPass = memoStamp(el);
  return m;
}
// Crossing INTO a parent, in the order css-transforms-2 gives: the parent's `perspective` applies to
// what its children have accumulated, then the accumulation is FLATTENED unless the parent shares
// its 3D rendering context, and only then (at the call site) does the parent's own transform apply.
//
// Composing flattened affines instead — one flatten per step — is a different operation, and the
// difference is the everyday 3D idiom: `rotateY(60deg)` over a `preserve-3d` parent's
// `rotateY(-60deg)` should CANCEL (Chrome measures the box unmoved) where flattening each half
// leaves it a quarter of its width.
function crossInto(node, m) {
  if (!m) return m;
  if (declaresPerspective(node)) {
    const persp = perspectiveStepOf(node);
    if (persp) m = multiply4(persp, m);
  }
  if (sharesContext(node)) return m;
  return flattenMatrix4(m);
}
// Do this node's children share its 3D rendering context? The `declaresLayoutProp` gate first: an
// element that declares no `transform-style` cannot preserve one, and that is every element on
// almost every page.
function sharesContext(node) {
  return declaresLayoutProp(node, 'transform-style') && preserves3d(node);
}
// Does anything declare a `perspective` on this node? The `declaresLayoutProp` gate again: almost
// no element on almost any page has one, and this is asked per ancestor per rect read.
function declaresPerspective(el) {
  return declaresLayoutProp(el, 'perspective') || declaresLayoutProp(el, 'perspective-origin');
}
// The parent's perspective, about its own `perspective-origin`, in viewport coordinates.
function perspectiveStepOf(el) {
  if (!generatesBox(el)) return null;
  const box = laidOutBox(el);
  if (!box) return null;
  const p = usedPerspective(el);
  if (!p) return null;
  const ox = box.x + p.ox, oy = box.y + p.oy;
  return multiply4(translate4(ox, oy, 0), multiply4(p.m4, translate4(-ox, -oy, 0)));
}
// One element's own map, in the VIEWPORT coordinates every box here is in: its transform taken
// about its origin, where the origin is that same box's position plus the origin offset. Taking the
// origin from the DOCUMENT box instead conjugated a viewport-space box about a document-space point
// — exact for a pure translation, and hundreds of pixels out for anything else the moment the page
// scrolled.
function transformStepOf(el) {
  // A transform applies to a TRANSFORMABLE element only: a non-replaced inline box is not one
  // (Chrome leaves `a:hover { transform: translateY(-1px) }` measuring where the link is), and an
  // element that generates no box at all — `display: contents` — has neither a box to move nor an
  // origin to move it about.
  if (!generatesBox(el) || isNonReplacedInline(el)) return null;
  const box = laidOutBox(el);
  if (!box) return null;
  const t = usedTransformMatrix(el);
  if (!t) return null;
  const ox = box.x + t.ox, oy = box.y + t.oy;
  return multiply4(translate4(ox, oy, 0), multiply4(t.m4, translate4(-ox, -oy, 0)));
}
// Does anything declare a transform on THIS node? The rule index answers for the stylesheets in
// O(1) (cached per cascade build) and the node's own inline map for the rest — the
// `declaresLayoutProp` pattern, and the reason a page with no transforms pays four map lookups per
// ancestor rather than four cascade reads.
function declaresTransform(el) {
  for (const prop of TRANSFORM_GEOMETRY_PROPS) if (declaresLayoutProp(el, prop)) return true;
  return false;
}
const TRANSFORM_GEOMETRY_PROPS = ['transform', 'translate', 'rotate', 'scale'];
// A non-replaced INLINE box: the one display type a transform does not apply to.
function isNonReplacedInline(el) {
  return usedDisplay(el) === 'inline' && !REPLACED_TRANSFORM_TAGS.has(el._tag);
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
// per pass beside the chain itself, because the run loop asks once per TEXT RUN and not once per
// element. `false` (not null) says the element has a transform the painter cannot express at all,
// which a caller must not read as "no transform" and draw at the layout position.
export function paintTransformOf(el) {
  if (memoFresh(el, '_lbPaintTfPass')) return el._lbPaintTf;
  el._lbPaintTf = computePaintTransform(el);
  el._lbPaintTfPass = memoStamp(el);
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

export function laidOutBox(el) {
  const b = el._lb;
  if (!b) return null;
  const { sx, sy } = scrollShift(el);
  return { x: b.x - sx, y: b.y - sy, width: b.width, height: b.height };
}


// `el` is clipped away when its rendered box is pushed out of a scroll-container ancestor's
// rendered box, in an axis that ancestor clips (overflow clipping — whole-box, no rounded or
// partial clip).
function isClipped(el) {
  const eb = renderedBox(el);
  if (isFixedBox(el)) return false;   // pinned to the viewport, so no scroll container clips it
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    // The ROOT never clips: its overflow PROPAGATES to the viewport (CSS Overflow §3.3), leaving
    // the element itself `visible`. Treating `html { overflow-y: scroll }` as a scroll container
    // clipped to the root box made every absolutely positioned dropdown below the body's flow
    // bottom vanish from elementFromPoint — and the viewport clip that should apply instead is
    // already applied where it belongs, against `viewport()`. The BODY propagates the same way
    // when the root took no overflow of its own, which is what `body { overflow-x: hidden }` — as
    // common in app CSS as the `html` form — relies on.
    if (clipsContent(p) && p._lb && clippedOutBy(eb, p)) return true;
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
  if (z == null || !/^-?\d+$/.test(String(z).trim())) return 0.5;   // z-auto positioned, just above flow
  // `z-index: 0` and `z-index: auto` paint in the SAME layer (CSS 2.1 appendix E steps 8/9), so
  // tree order decides between them — ranking 0 below auto put an earlier `auto` box on top.
  const v = parseInt(z, 10);
  return v === 0 ? 0.5 : v;
}

// Is `a` an ancestor of `b` in the flat tree?
export function isFlatAncestor(a, b) {
  for (let p = flatTreeParent(b); p; p = flatTreeParent(p)) if (p === a) return true;
  return false;
}

// The chain of paint ranks an element inherits — every positioned ancestor from the root down, plus
// its own. Content is painted with the stacking context it lives in, so a static button inside a
// `z-index: 10` bar is painted at 10, ABOVE a `z-index: 5` box elsewhere. Comparing bare ranks made
// the button lose to that box (and comparing only ancestry made a fixed container swallow clicks
// meant for its own content) — the chain is what gets both right at once.
// Whether this box paints its positioned descendants itself, or hands them up. A positioned box
// with `z-index: auto` does NOT establish a stacking context: its own `z-index: 10` child
// competes at the level above, which is how a menu inside an un-z-indexed wrapper comes out on
// top. (`opacity` / `transform` / `filter` also establish one; none of them is modelled here.)
function establishesStackingContext(el) {
  const pos = positionOf(el);
  // `fixed` and `sticky` establish one whatever their z-index is.
  if (pos === 'fixed' || pos === 'sticky') return true;
  if (pos === 'static') return false;
  const z = declaredValue(el, 'z-index');
  return z != null && /^-?\d+$/.test(String(z).trim());
}

// The stacking contexts ABOVE this box, each contributing its paint RANK and — to break a tie
// between two of the same rank — where it sits in the tree. The box's own rank is compared
// separately (see `paintsAbove`), and only real contexts are levels: a level per POSITIONED box
// made "deeper" mean "on top", which put a relative child of one dropdown over the dropdown
// declared after it.
function stackChain(el) {
  if (el._lbChainPass === layoutPass) return el._lbChain;
  // The chain bakes in `paintRank` — a z-index read, which is PAINT-only and so no longer moves
  // the layout epoch (or `layoutPass`) when a dynamic rule flips it. Same taint bracket as the
  // declared-value memo: a chain whose ranks considered a dynamic rule is not cached, so the next
  // hit-test re-reads it live instead of comparing against a pre-focus snapshot.
  const seq0 = dynamicReadSeq();
  const parent = flatTreeParent(el);
  let chain = [];
  if (parent) {
    chain = stackChain(parent);
    if (establishesStackingContext(parent)) chain = chain.concat(paintRank(parent), parent._lbOrder);
  }
  if (dynamicReadSeq() === seq0) { el._lbChainPass = layoutPass; el._lbChain = chain; }
  return chain;
}

// Is the viewport point inside what this element actually paints? A FRAGMENTED inline is
// its pieces, not their union: the union covers the end of one line past the box's own text
// and the start of the next before it, and both belong to whatever else is on those lines —
// a wrapped nav link would otherwise swallow every click on the link before it.
function containsPoint(el, vx, vy) {
  const { sx, sy } = scrollShift(el);
  // A TRANSFORMED box is hit where the transformed QUAD covers, not where its bounding box does:
  // the point is carried back through the inverse and tested against the box layout placed. Testing
  // the axis-aligned bounds instead would answer for the corners a rotated box does not occupy —
  // Chrome hit-tests a point just outside a `rotate(45deg)` square as the page behind it.
  const m = transformChain(el);
  let px = vx, py = vy;
  if (m) {
    const h = homographyOf(m);
    const inv = invertHomography(h);
    if (!inv) return false;                                   // a degenerate box covers nothing
    const p = applyHomography(inv, vx, vy);
    if (!p) return false;                                     // the point maps to the horizon
    // …and a preimage BEHIND the projection plane is not on the box at all. The inverse happily
    // produces one — a `perspective(200px) translateZ(250px)` box has negative `w` everywhere — and
    // taking it hit-tested a box a browser does not hit anywhere (measured: 1176 of 2451 probes).
    if (h[2] * p.x + h[5] * p.y + h[8] <= 0) return false;
    px = p.x; py = p.y;
  }
  // Half-open, as a browser hit-tests: the near edges belong to the box and the FAR ones do not
  // (Chrome measured on a 100×50 box at the origin — (99.9, 25) is inside, (100, 25) is the page
  // behind it). Testing both edges inclusively made two adjacent boxes both contain the seam.
  const covers = (b) => px >= b.x - sx && px < b.x - sx + b.width &&
                        py >= b.y - sy && py < b.y - sy + b.height;
  if (!el._lbFrags) return covers(el._lb);
  for (const b of el._lbFrags) if (covers(b)) return true;
  return false;
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
  // The chains agree as far as the shorter one goes: one box is inside the other's stacking
  // context, or they are in the same one. An element's own box never covers its own content —
  // except content the page pushed BEHIND it with a negative z-index (CSS 2.1 appendix E step 3
  // paints those before the ancestor's own background).
  if (isFlatAncestor(best, cand)) return paintRank(cand) >= 0;
  if (isFlatAncestor(cand, best)) return paintRank(best) < 0;
  // Otherwise each box competes at the level where the chains ran out: the shorter one with its
  // OWN rank and position, the longer one with the context that encloses it there. Comparing
  // chain LENGTH instead made "deeper" mean "on top", so anything inside a stacking context beat
  // everything outside it — a `z-index: 100` box inside a `z-index: 1` context is still below a
  // `z-index: 2` sibling of that context.
  const rc = n < cc.length ? cc[n] : paintRank(cand);
  const rb = n < cb.length ? cb[n] : paintRank(best);
  if (rc !== rb) return rc > rb;
  const oc = n < cc.length ? cc[n + 1] : cand._lbOrder;
  const ob = n < cb.length ? cb[n + 1] : best._lbOrder;
  return oc >= ob;
}

// The topmost laid-out, non-clipped element whose rendered box contains the VIEWPORT point (vx, vy).
export function hitTest(vx, vy) {
  ensureLayout();
  const body = globalThis.document && globalThis.document.body;
  if (!body) return null;
  let best = null;
  walkInclShadow(body, (n) => {
    if (n.nodeType !== NODE_ELEMENT || !n._lb || !isLaidOutNode(n) || isClipped(n)) return;
    if (!containsPoint(n, vx, vy)) return;
    if (pointerEventsNone(n)) return;
    // `visibility: hidden` keeps its box in the layout but is NOT a hit target
    // (CSSOM `elementFromPoint`, Chrome-checked) — a parked full-viewport cloak
    // (Discourse's `.card-cloak`, hidden until a card opens) must not swallow
    // the page's clicks. Checked per node, not inherited-once, because a
    // visible descendant inside a hidden ancestor IS hit-testable again.
    if (visibilityHidden(n)) return;
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

// `pointer-events: none` takes an element OUT of hit-testing: the click falls THROUGH to whatever
// is behind it. Modern app CSS puts a full-viewport, `z-index`-topped overlay on the page for
// toasts and alerts and relies on this — Avo's `#alerts` frame is `fixed inset-0 z-[100]
// pointer-events-none`, so with the property ignored EVERY click in the app landed on it instead of
// on the page. It INHERITS, so a descendant is out of hit-testing too unless it declares its own
// value back (which is how the toast inside such an overlay stays clickable).
//
// Resolved recursively with a per-element memo, the same shape the flow-sides resolution uses: an
// ancestor that already answered ends the walk, so each element costs one lookup rather than a walk
// to the root. Skipped outright on a page that declares the property nowhere.
function pointerEventsNone(el) {
  if (memoFresh(el, '_lbPePass')) return el._lbPe;
  const declared = declaredValue(el, 'pointer-events');
  let none;
  if (declared != null) {
    none = String(declared).trim().toLowerCase() === 'none';
  } else {
    const p = flatTreeParent(el);
    none = (p && p.nodeType === NODE_ELEMENT) ? pointerEventsNone(p) : false;
  }
  el._lbPe = none;
  el._lbPePass = memoStamp(el);
  return none;
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
  const e = insetsAgainst(frameEl, box.width);
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
  if (!frameEl._lb || isClipped(frameEl)) return true;
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

// The scrollable overflow region of `el` as a width/height: the distance from the edge it SCROLLS
// FROM to the far end of what is reachable from there. That is what scrollWidth / scrollHeight
// report — at least the client box, larger when content overflows it, and nothing at all for
// content that overflows BEHIND the scroll origin.
export function contentExtent(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { width: 0, height: 0 };
  ensureLayout();
  const b = el._lb, ext = el._lbExt;
  if (!b || !ext) return { width: 0, height: 0 };
  // The region is measured from the PADDING box, not the border box: scrollWidth / scrollHeight
  // (and the scrollable range) start inside the borders, so a bordered scroller whose content is
  // exactly N tall reports N, not N + border (Chrome: a 50px box with 5px borders over 10px of
  // content has scrollHeight 50, and `scrollHeight > clientHeight` — every "is there more?"
  // affordance — stays false).
  // ONE `edgeInsets` read for both halves — `e[side]` is padding + border and `e.bl` the border
  // alone, so each padding is the difference. Two helpers here allocated two objects per read on a
  // path editors and virtualised lists hit on every keystroke.
  const e = insetsOf(el);
  const padLeft = b.x + e.bl, padTop = b.y + e.bt;
  const padRight = b.x + b.width - e.br, padBottom = b.y + b.height - e.bb;
  // `stampExtent` SEEDS the union with the element's own border box, so an element whose content
  // does not overflow measures that box here — one border wider than the client box on each side.
  // Anything that did not get past the border box is the seed, and the region's own contribution
  // is the padding box.
  const kidLeft   = ext.left   < b.x            ? ext.left   : padLeft;
  const kidTop    = ext.top    < b.y            ? ext.top    : padTop;
  const kidRight  = ext.right  > b.x + b.width  ? ext.right  : padRight;
  const kidBottom = ext.bottom > b.y + b.height ? ext.bottom : padBottom;
  const origin = scrollOriginSides(el);
  // §3.2's in-flow term — the children's MARGIN boxes, and this box's own END padding after them —
  // is a SCROLL CONTAINER's region. An `overflow: visible` box reports the plain union of the boxes
  // inside it (Chrome: a block over a `margin-bottom: 50px` child is 20 tall, and 70 the moment it
  // gains `overflow: hidden`; `padding-bottom: 10px` over a 40px child is 40, and 50 once it
  // scrolls), and `overflow: clip` — which clips but cannot scroll — reports the `visible` figures.
  // `scrollsContent` is that exact question, and it is per ELEMENT: one non-visible axis makes the
  // other `auto`, so Chrome pads BOTH axes of an `overflow-x: hidden` box.
  const scrolls = scrollsContent(el);
  const w = axisExtent(origin.x === 'left', padLeft, padRight, kidLeft, kidRight,
                       scrolls ? ext.iLeft  - (e.left  - e.bl) : Infinity,
                       scrolls ? ext.iRight + (e.right - e.br) : -Infinity);
  const h = axisExtent(origin.y === 'top', padTop, padBottom, kidTop, kidBottom,
                       scrolls ? ext.iTop    - (e.top    - e.bt) : Infinity,
                       scrolls ? ext.iBottom + (e.bottom - e.bb) : -Infinity);
  return { width: Math.round(w), height: Math.round(h) };
}

// Whether `el` establishes a containing block for absolutely-positioned descendants — i.e. it is
// positioned. CSSOM's `offsetParent` is the nearest such ancestor.
export function isPositionedElement(el) {
  return !!el && el.nodeType === NODE_ELEMENT && positionOf(el) !== 'static';
}

// Whether `el` ITSELF is `position: fixed` — read from the live cascade, never from the last
// pass's box stamp: `offsetParent` must answer null the moment a style write makes an element
// fixed, and `_lb.fixed` only moves when a pass happens to run afterwards. (Found as a latent
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
  if (el._lbFrags) {
    const f = el._lbFrags[0];
    return { x: f.x, y: f.y, width: el._lb.width, height: el._lb.height };
  }
  if (!el._lb) return null;
  // A stuck box's `offsetTop` moves with it, exactly as its client rect does — Chrome keeps
  // `rect.top + scrollY === offsetTop` through the stick.
  const st = stickyDelta(el);
  return st ? { x: el._lb.x + st.dx, y: el._lb.y + st.dy, width: el._lb.width, height: el._lb.height } : el._lb;
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

// The offsetParent's PADDING-box origin, which is what CSSOM-View measures `offsetLeft` /
// `offsetTop` from — its border edge is NOT the origin (Chrome: a box at the content origin of a
// `border: 5px; padding: 3px 4px` positioned parent reports 4 / 3, not 9 / 8).
export function paddingBoxOriginOf(el) {
  const b = documentBoxOf(el);
  if (!b) return null;
  // …except a NON-ATOMIC inline offsetParent, whose border box is the origin (Chrome, measured: a
  // positioned `<span style="border:5px;padding:3px 4px">` reports 5 for a child at its own
  // border edge, while an `inline-block` in the same shape reports 0).
  if (displayOf(el) === 'inline') return { x: b.x, y: b.y };
  const bw = borderWidthsOf(el);
  return { x: b.x + bw.left, y: b.y + bw.top };
}

// An already-laid-out element's edge insets, asked with the SAME containing-block width the pass
// resolved them against — `_lbCbW` is what layout stamped, and handing `edgeInsets` anything else
// misses its memo for every box with a percentage padding or margin.
function insetsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return edgeInsets(el, 0);
  return insetsAgainst(el, (el._lb && el._lb.width) || 0);
}

// …and the same for a caller that has a better fallback than the element's own box to offer when
// nothing was stamped (a frame's rendered box, a sticky ancestor's inline containing box).
function insetsAgainst(el, fallbackW) {
  return edgeInsets(el, el._lbCbW != null ? el._lbCbW : fallbackW);
}

// Used border widths per side (a side whose style is none/hidden contributes 0).
// Reads the per-pass `edgeInsets` memo — clientWidth / clientHeight / scrollWidth /
// scrollHeight go through here, and editors and virtualised lists read those on
// every keystroke, so this must not re-resolve 12 cascade properties per call
// (measured: 20 000 reads 217 ms unmemoised vs 117 ms memoised).
function borderWidthsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return { top: 0, right: 0, bottom: 0, left: 0 };
  const e = insetsOf(el);
  return { top: e.bt, right: e.br, bottom: e.bb, left: e.bl };
}

// Which physical edge each axis SCROLLS FROM — the scroll origin corner (css-overflow-3 §3.1).
// Content behind it is unreachable and reports nothing, which is why a negative margin adds nothing
// to an LTR block's `scrollWidth` while the same overflow in an RTL one adds all of it (Chrome:
// 100 and 300).
//
// It has to describe where THIS ENGINE actually put the content, not where the spec would: an
// origin that disagreed with the boxes would declare geometry the hit test can see unreachable.
// A flex container is now laid out along its FLOW axes, so its origin is simply its main-start
// corner. Block flow is not yet: `direction: rtl` it honours — a 300px child in a 100px box lands
// at -200..100 exactly as in Chrome — while a VERTICAL writing mode still places physically (the
// same child lands at 0..300 where Chrome puts it at -200..100), so the origin stays physical
// there until that placement moves.
function scrollOriginSides(el) {
  // Memoised on the layout stamp, like `displayOf`: this sits on the `scrollWidth` / `scrollHeight`
  // read path, and the axis resolution under it reads `flex-direction` and `flex-wrap` uncached —
  // answering per read made those two properties 2.7-3.1x more expensive (measured, 20 000 reads on
  // a 400-row scroller: 8.6 ms to 23-26 ms).
  if (memoFresh(el, '_lbOriginPass')) return el._lbOrigin;
  // …and, like `flowSides` itself, an answer that CONSIDERED a dynamic-pseudo rule is not cached:
  // nothing moves the layout stamp when `:hover { direction: rtl }` starts matching.
  const seq = dynamicReadSeq();
  const val = computeScrollOriginSides(el);
  if (dynamicReadSeq() === seq) { el._lbOriginPass = memoStamp(el); el._lbOrigin = val; }
  return val;
}
function computeScrollOriginSides(el) {
  // A flex container scrolls from its MAIN-START corner — and only when it is a SCROLL CONTAINER:
  // Chrome reports 100 for a `row-reverse` row overflowing 200px to the left while it is
  // `overflow: visible`, and 300 for the same row once it can scroll.
  if (laysOutAsFlex(el) && scrollsContent(el)) {
    const axes = flexAxisPlan(el);
    return axes.mainIsX ? { x: axes.mainStart, y: axes.crossFar ? 'bottom' : 'top' }
                        : { x: axes.crossFar ? 'right' : 'left', y: axes.mainStart };
  }
  const sides = flowSides(el);
  const inlineIsHorizontal = sides['block-start'] === 'top' || sides['block-start'] === 'bottom';
  return { x: inlineIsHorizontal && sides.rtl ? 'right' : 'left', y: 'top' };
}

// One axis of the scrollable overflow region, as the distance from the scroll-origin edge to the
// far end of what is reachable. Everything BEHIND the origin is unreachable and does not count.
function axisExtent(originAtStart, startEdge, endEdge, kidStart, kidEnd, inStart, inEnd) {
  return originAtStart ? Math.max(endEdge, kidEnd, inEnd) - startEdge
                       : endEdge - Math.min(startEdge, kidStart, inStart);
}

// The element's rendered pieces, viewport-relative: one rect per line a fragmented inline
// broke over, and its single box otherwise. `getClientRects` reports exactly this — every
// RENDERED element has at least one box, even a zero-sized one (an empty `<span>` alone in a
// block is `[0, 0, 0, 0]` in Chrome, and one rect, not none), and one that isn't rendered has
// none at all. A fragmented inline never goes through `layoutElement`, so its pieces are not
// cleared by a pass that stops rendering it: the guard has to be here.
export function clientRectsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return [];
  ensureLayout();
  if (!el._lb || !generatesBox(el)) return [];
  const { sx, sy } = scrollShift(el);
  const boxes = el._lbFrags || [el._lb];
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
    return el._lb && el._lb.outOfFlow ? containingBlockBox(el._lb.cbEl)
                                      : containingBlockFor(el, pos === 'fixed');
  }
  // A STICKY box's insets are measured against its nearest SCROLLPORT, not against the block that
  // holds it (css-position §sticky-pos — Chrome-measured: `top: 10%` inside a 100px block in a
  // 200px `overflow: hidden` container resolves to 20px, not 10).
  if (pos === 'sticky') {
    for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
      if (!p._lb || p.nodeType !== NODE_ELEMENT || displayOf(p) === 'contents') continue;
      // A SCROLLER, which `overflow: clip` is not — it clips and forbids scrolling, so a sticky box
      // inside one sticks within the scroller AROUND it (`clipsContent` says the same thing, and
      // `stickyDelta` already asks `scrollsContent`).
      if (!scrollsContent(p)) continue;
      const box = inlineContainingBox(p);
      const e = insetsAgainst(p, box.width);
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
    if (!p._lb || displayOf(p) === 'contents') continue;
    const box = inlineContainingBox(p);
    // A percentage padding or border on the PARENT resolves against the parent's own containing
    // block, not against its border box — the idiom every other read-time caller here uses. The
    // wrong basis also threw away and recomputed the parent's edge memo on every inset read.
    const e = insetsAgainst(p, box.width);
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
  if (displayOf(el) !== 'inline') return false;
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
  if (memoFresh(el, '_lbInsetPass')) return el._lbInsets;
  el._lbInsetPass = memoStamp(el);
  el._lbInsets = computeUsedInsets(el);
  return el._lbInsets;
}

function computeUsedInsets(el) {
  const pos = positionOf(el);
  if (pos === 'static') return null;
  const box = el._lb;
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
    const e = edgeInsets(el, cb.width);
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
export function clipBoxesFor(el) {
  // No `ensureLayout()` of its own: the painter has already laid the page out (that is what
  // produced the boxes it is walking), and every extra call site on `ensureLayout` is one more for
  // V8 to weigh when inlining it into the geometry reads that DO run per element — measured,
  // adding two cost several percent of a suite that never paints anything.
  const OPEN = 1e7;
  const out = [];
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    if (p._lb && clipsContent(p)) {
      // …in the UNTRANSFORMED space, which is the one the painter draws in and the one every
      // clip-vs-box comparison here is written against. A clipper's transformed rect would be
      // intersected with untransformed content, and the two would disagree about where the
      // scrollport is.
      const r = renderedBoxUntransformed(p);
      if (r) {
        out.push({
          x:      p._ccX ? r.x : -OPEN,
          y:      p._ccY ? r.y : -OPEN,
          width:  p._ccX ? r.width  : OPEN * 2,
          height: p._ccY ? r.height : OPEN * 2,
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
  if (!el._lb || isClipped(el)) return null;
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
  let sx = scrollEl._scrollLeft || 0, sy = scrollEl._scrollTop || 0;
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
  if (el !== root && !el._lb) return;
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
          const sx = (p._scrollLeft || 0) + dx, sy = (p._scrollTop || 0) + dy;
          const to = p === root ? clampScroll(p, true, sx, sy) : { x: Math.max(0, sx), y: Math.max(0, sy) };
          p.scrollLeft = to.x;
          p.scrollTop  = to.y;
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
    const to = clampScroll(p, p === root, (p._scrollLeft || 0) + dx, (p._scrollTop || 0) + dy);
    p.scrollLeft = to.x;
    p.scrollTop  = to.y;
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
  const m = el._lbMargins;
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
  if (target) {
    // Capybara's `scroll_to(element, align:)` is `element.scrollIntoView(...)` in the real
    // drivers this one stands in for (align :top → the legacy `true`, :bottom → `false`,
    // :center → `{block: 'center'}`); `self` plays no part once a target is named.
    applyScrollIntoView(target, pos === 'bottom' ? 'end' : pos === 'center' ? 'center' : 'start');
    return target;
  }
  const to = scrollTargetFor(self, pos, x, y);
  if (!to) return null;
  to.el.scrollLeft = to.x;
  to.el.scrollTop  = to.y;
  return to.el;
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
  const box = el._lb;
  if (!box) return null;
  const cbW  = el._lbCbW != null ? el._lbCbW : box.width;
  const e    = edgeInsets(el, cbW);

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

    case 'border-top-width':    return e.bt;
    case 'border-right-width':  return e.br;
    case 'border-bottom-width': return e.bb;
    case 'border-left-width':   return e.bl;

    // An `auto` margin resolves to the slack it took, and only whoever PLACED the box knows how
    // much that was: block flow and an abspos box between two insets across (§10.3.3 / §10.3.7),
    // an abspos box between `top` and `bottom` down (§10.6.4), and a flex item on either axis.
    // Whatever nobody distributed is what `edgeInsets` resolved — `auto` reads as zero there,
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

