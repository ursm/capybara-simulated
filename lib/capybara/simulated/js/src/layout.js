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
//   - flex / grid TRACK sizing; floats; PARTIAL overflow clipping (a box is clipped whole or not
//     at all); parent/first-child margin collapsing; and a FLAT paint order (no nested
//     stacking-context tree).
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
import { walkInclShadow, flatTreeParent }                from './walk.js';
import { isLaidOutNode, selfNotRendered, resolveLayoutProp, resolveCascadeDisplay,
         cascadeLayoutEpoch, mayConstrainSize, inlineAxisIsHorizontal,
         cascadeDeclaresProperty, inlineDecls, dynamicReadSeq, visibilityHidden } from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { advanceTableFor }                               from './font-metrics.js';
// Box props are read through `declaredValue`, not the raw cascade: it resolves a `var()` against
// the element and decodes the pending slot a `flex: var(--f)` shorthand occupies. Reading the store
// directly made layout see an opaque marker where getComputedStyle saw `1` — ONE geometry means one
// value resolution too.
import { usedDisplay, uaDisplay, declaredValue, declaredValueEntry, declaredValueIn, usedOverflow, propagatedOverflow,
         computedFontSizePx, computedLineHeight,
         computedFontFamily, computedFontWeight, computedFontStyle, declaresOwnFont,
         fontRelativeToPx, uaDefault, computedBorderCollapse, computedBorderSpacing,
         isListBox, inputType, buttonInputLabel } from './style-proxy.js';
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
  layoutPass++;
  OPEN_INLINE_BOXES.length = 0;
  LAYING_OUT.clear();
  PENDING_BY_CB.clear();
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
    const consumed = bodyRendered ? bb.y + bb.height + marginOf(body, 'margin-bottom') : 0;
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
  const sr = el._shadowRoot;
  if (sr) return sr._children || [];
  if (el._tag === 'slot' && typeof el.assignedNodes === 'function') {
    const assigned = el.assignedNodes();
    if (assigned && assigned.length) return assigned;   // else the slot's own children = fallback
  }
  return el._children || [];
}

// The nearest positioned ancestor's box is an absolute box's containing block; with none, it's the
// initial containing block (the viewport). CSS says the PADDING box of the ancestor —
// with real borders that is no longer its border box.
// The element an absolutely positioned box resolves against: the nearest POSITIONED ancestor
// that has been laid out. `null` when there is none — the box is positioned against the
// initial containing block, i.e. the viewport.
function containingBlockElementFor(el) {
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    if (positionOf(p) !== 'static' && p._lb) return p;
  }
  return null;
}

function containingBlockFor(el) {
  for (let p = flatTreeParent(el); p; p = flatTreeParent(p)) {
    const pos = positionOf(p);
    if (pos !== 'static' && p._lb) {
      const box = inlineContainingBox(p);
      const bw = borderWidthsOf(p);
      return {
        x: box.x + bw.left,
        y: box.y + bw.top,
        width:  Math.max(0, box.width  - bw.left - bw.right),
        height: Math.max(0, box.height - bw.top  - bw.bottom)
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
// These are CONTENT boxes: `usedSize` adds the element's own edges, and a control's UA border and
// padding are real edges (see `uaDefault`'s control chrome). Chrome-measured border boxes, minus
// that chrome — a text `<input>` is 185x21 with its 2px border and 1px/2px padding, so 177x15 here.
//
// The width/height CONTENT attributes are presentational hints and arrive through
// `resolveLayoutProp`, so this is only the no-declaration default. (`<img>` is deliberately absent:
// its intrinsic size is the decoded image's, which we don't have.)
const OBJECT_SIZE   = { width: 300, height: 150 };
const REPLACED_TAGS = new Set(['iframe', 'frame', 'embed', 'object', 'video']);
// Prototype-less, because the key is a TAG NAME off the page: `<constructor>` reached
// `Object.prototype.constructor` here and handed a FUNCTION back as an intrinsic size.
const CONTROL_SIZES = Object.assign(Object.create(null), {
  input:    { width: 177, height: 15 },
  textarea: { width: 195, height: 36 }
});
const CHECKBOX_SIZE = { width: 13, height: 13 };
const FILE_SIZE     = { width: 253, height: 21 };      // Chrome-measured; the widget is a button
                                                       // plus the UA's own "No file chosen" label,
                                                       // so it is locale-dependent in a browser.
const RANGE_SIZE    = { width: 129, height: 16 };      // Chrome-measured, and it has no chrome
const COLOR_SIZE    = { width: 44,  height: 23 };      // 50x27 less its 1px border / 1px,2px padding
const ZERO_SIZE     = { width: 0,   height: 0 };       // `<input type=image>` with nothing decoded
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
function buttonInputSize(el, label) {
  return { width: label ? measureRun(label, el) : 0, height: lineHeightOf(el) };
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
// An `<optgroup>` INDENTS the options under it and puts its own label above them, both of which
// widen the control (Chrome: a select holding one 25-char option is 179, and 194 with that option
// inside an optgroup — the 15px indent exactly).
const OPTGROUP_INDENT = 15;
function widestOptionWidth(node, select, widest, indent = 0) {
  for (const child of node._children || NO_CHILDREN) {
    if (child.nodeType !== NODE_ELEMENT) continue;
    if (child._tag !== 'option') {
      const group = child._tag === 'optgroup';
      const label = group && child._attrs && child._attrs.label;
      if (label != null && label !== false) widest = Math.max(widest, optionWidth(String(label), select));
      widest = widestOptionWidth(child, select, widest, group ? indent + OPTGROUP_INDENT : indent);
      continue;
    }
    const attr = child._attrs && child._attrs.label;
    const w = indent + optionWidth(attr != null ? String(attr) : collectText(child, ''), select);
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
    const type = inputType(el);
    if (type === 'checkbox' || type === 'radio') return CHECKBOX_SIZE;
    if (type === 'file')  return FILE_SIZE;
    if (type === 'range') return RANGE_SIZE;
    if (type === 'color') return COLOR_SIZE;
    // An `image` input IS an image: no chrome, and no box until something decodes (Chrome: 0x0,
    // or the `width`/`height` presentation attributes when it has them).
    if (type === 'image') return ZERO_SIZE;
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
  const vb = parseViewBox(el);
  if (vb) return { width: vb.width, height: vb.height, ratio: true, ratioOnly: true };
  return OBJECT_SIZE;
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
  const w = resolveLayoutProp(el, 'width', cbW);
  const h = resolveLayoutProp(el, 'height', cbH);
  const intrinsic = intrinsicSize(el);
  // A DECLARED size is the content box unless `box-sizing: border-box` — the border
  // box the caller wants adds the edges back on. An AUTO width already arrives as a
  // border-box figure (the containing block's content width), so it is left alone.
  const edge = edgeInsets(el, cbW);
  const extraW = edge.left + edge.right, extraH = edge.top + edge.bottom;
  const grow = (w != null || h != null) && !isBorderBox(el);
  // `ratioOnly` marks an intrinsic RATIO with no intrinsic size — an `<svg viewBox>`. Its auto
  // width fills the containing block exactly as a non-replaced block's does; only the ratio then
  // gives the height.
  const sized = intrinsic && !intrinsic.ratioOnly;
  let width  = w != null ? w + (grow ? extraW : 0) : (sized ? intrinsic.width  + extraW : autoW);
  let height = h != null ? h + (grow ? extraH : 0) : (sized ? intrinsic.height + extraH : autoH);
  // One axis given and the other auto on a replaced element: the missing one follows the intrinsic
  // aspect ratio (`<img width="500">` on a 4:3 image is 375 tall, not 150).
  if (intrinsic && intrinsic.ratio && intrinsic.width > 0 && intrinsic.height > 0) {
    if (w != null && h == null)      height = Math.round(w * intrinsic.height / intrinsic.width);
    else if (h != null && w == null) width  = h * intrinsic.width / intrinsic.height;
    // Both auto on a ratio-only box: the width filled the container above, so the height is
    // whatever the ratio makes of it (Chrome: a `viewBox="0 0 4 3"` svg in a 1000px block is 750
    // tall, not the 150 of the default object size).
    else if (w == null && h == null && intrinsic.ratioOnly) height = width * intrinsic.height / intrinsic.width;
  }
  // …then `min-*` / `max-*` clamp it (CSS 2.1 §10.4 / §10.7), which applies to an AUTO
  // size too: `max-width: 40em` on a block that would otherwise fill its container is
  // how most page shells cap their measure, and taking the container's width there put
  // every one of them at full bleed. `min` wins a contradiction, as the spec says.
  width = clampToMinMax(el, width, 'width', cbW, extraW);
  // The HEIGHT is clamped where it is FINAL, at the end of `layoutElementInner` — an auto height
  // is a 0 placeholder here that the flow back-fills, and clamping the placeholder froze the box
  // at its `min-height` however tall its content grew (`min-height: 100vh` on a page shell put
  // every following sibling under the fold). The basis travels with the element for that clamp.
  el._lbCbH = cbH;
  if (h != null || intrinsic) height = clampToMinMax(el, height, 'height', cbH, extraH);
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

function positionOf(el) {
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
function usedBorderWidth(el, side, cbW, info, dv) {
  const bw = resolveLayoutProp(el, 'border-' + side + '-width', cbW, info, dv) || 0;
  if (!bw) return 0;
  const style = declaredValueIn(dv, el, 'border-' + side + '-style') ??
                uaDefault(el, 'border-' + side + '-style');
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
  const f = declaredValue(el, 'float');
  if (f == null) return false;
  const v = String(f).trim().toLowerCase();
  return v === 'left' || v === 'right' || v === 'inline-start' || v === 'inline-end';
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
// The USED display: author inline style, stylesheet, then the per-tag UA default — so the engine
// can tell a `<span>` from a `<div>` without the page saying so. Memoised per layout pass (the box
// stamp is thrown away with it), since every child asks once and the resolver walks the cascade.
function displayOf(el) {
  if (memoFresh(el, "_lbDispPass")) return el._lbDisp;
  el._lbDispPass = memoStamp(el);
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
  return resolveCascadeDisplay(el) || uaDisplay(el) || 'block';
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
  return !isOutOfFlowChild(node) && !isInlineLevel(node);
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
    OPEN_INLINE_BOXES[0].deferred.push({
      child, pos, staticX: staticX + dx, staticY: staticY + dy, ctx, order: ctx.order++,
      // …and the same shift applies to an ALIGNED static position, which is computed from the
      // container's box and knows nothing about the relative inlines around it.
      staticAlign: staticAlign && ((w, h) => { const p = staticAlign(w, h); return [p[0] + dx, p[1] + dy]; })
    });
    return;
  }
  const cbEl = pos === 'fixed' ? null : containingBlockElementFor(child);
  // Its containing block is still being laid out and has no height yet — wait for it.
  if (cbEl && cbEl._lb.height === 0 && cbEl._lb.autoHeight !== false && LAYING_OUT.has(cbEl)) {
    const waiting = PENDING_BY_CB.get(cbEl);
    const entry = { child, pos, staticX, staticY, ctx, order: order == null ? ctx.order++ : order,
                    staticAlign };
    if (waiting) waiting.push(entry); else PENDING_BY_CB.set(cbEl, [entry]);
    return;
  }
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
  // A margin is part of what fills the gap between two insets, so a stretched box is that gap LESS
  // its own margins: `inset: 0; margin: 10px` in a 400x300 block is 380x280 in Chrome, not 400x300
  // hanging 20px past both far edges.
  const cm = edgeInsets(child, cb.width);
  const stretched = left != null && right != null;
  const stretchedV = top != null && bottom != null;
  const availW = Math.max(0, cb.width - (left || 0) - (right || 0));
  const availH = stretchedV ? Math.max(0, cb.height - top - bottom) : 0;
  const autoW = stretched ? Math.max(0, availW - cm.ml - cm.mr) : shrinkToFitWidth(child, availW);
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
  const stat = staticAlign && needsStatic ? staticAlign(size.width, size.height) : null;
  const cx = left != null ? cb.x + left + mx.lead
           : right != null ? cb.x + cb.width - right - size.width - mx.trail
           : (stat ? stat[0] : staticX);
  const cy = top != null ? cb.y + top + my.lead
           : bottom != null ? cb.y + cb.height - bottom - size.height - my.trail
           : (stat ? stat[1] : staticY);
  // `fixed` is stamped on the box (not re-read from the cascade later): the geometry queries below
  // ask "does an ancestor scroll move this?" on every hit-test, and a flag read is O(1).
  const box = { x: cx, y: cy, width: size.width, height: size.height, autoHeight: size.autoHeight,
                fixed: pos === 'fixed', outOfFlow: true, cbEl };
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
}

// ── Flex layout ──────────────────────────────────────────────────────────────
// One model, two axes. The items' MAIN sizes are resolved together — each item's flex base, then
// the line's free space handed out by `flex-grow` or taken back by `flex-shrink` — and on the CROSS
// axis each item either stretches to the line or is aligned within it. What differs between a row
// and a column is where a base comes from (a row can measure an item's content width without laying
// it out; a column has to lay it out) and which physical edge each logical one is.
//
// `flex-direction`, as the two questions layout asks of it: does the main axis run down the block
// axis, and does it run backwards?
function isColumnFlex(el) {
  const d = declaredValue(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase().startsWith('column');
}
function isReverseFlex(el) {
  const d = declaredValue(el, 'flex-direction');
  return d != null && String(d).trim().toLowerCase().endsWith('-reverse');
}

// The physical edges each main axis maps onto. A REVERSED line runs the other way, so its
// main-start is the far edge and the margin that LEADS each item is the one on that side
// (Chrome puts two 100px items in a 400px `row-reverse` at 300 and 200, not 100 and 0).
const MAIN_AXES = {
  row:              { lead: 'left',   trail: 'right',  leadM: 'ml', trailM: 'mr', reverse: false, column: false },
  'row-reverse':    { lead: 'right',  trail: 'left',   leadM: 'mr', trailM: 'ml', reverse: true,  column: false },
  column:           { lead: 'top',    trail: 'bottom', leadM: 'mt', trailM: 'mb', reverse: false, column: true },
  'column-reverse': { lead: 'bottom', trail: 'top',    leadM: 'mb', trailM: 'mt', reverse: true,  column: true }
};

// Could this element have a value for a property almost no page declares? The rule index answers
// for the stylesheets in O(1) (cached per cascade build) and the element's own inline map for the
// rest — the `mayConstrainSize` pattern, for the same reason: one cascade read per ITEM per pass is
// what a flex line cannot afford (rule 3), and `order` / `align-self` are absent from nearly every
// page that has flex on it at all.
function declaresLayoutProp(el, prop) {
  return cascadeDeclaresProperty(prop) || prop in inlineDecls(el);
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
function deferFlexOutOfFlow(el, box, content, ctx, outOfFlow, axis, itemsAlign) {
  el._lbFlexPending = outOfFlow && outOfFlow.length
    ? () => placeFlexOutOfFlow(el, box, content, ctx, outOfFlow, axis, itemsAlign)
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
function placeFlexOutOfFlow(el, box, content, ctx, outOfFlow, axis, itemsAlign) {
  if (!outOfFlow || !outOfFlow.length) return;
  const edge = edgeInsets(el, box.width);
  // The container's box is final now — an auto height has been filled in — so the cross axis has
  // something to align against.
  const inner = { x: content.x, y: content.y, width: content.width,
                  height: Math.max(0, (box.height || 0) - edge.top - edge.bottom) };
  const column = axis.column;
  // Only where the axes are the ones this mapping describes. `direction: rtl` and the vertical
  // writing modes flip which physical edge is main-start, and we do not model either in the flex
  // pass — applying the LTR mapping there turned answers that were accidentally right (the content
  // origin) into confidently wrong ones. Falling back to the origin keeps those tests where they
  // were until the axes are modelled properly.
  if (!ltrHorizontal(el)) {
    for (const { child, pos } of outOfFlow) placeAbsolute(child, pos, inner.x, inner.y, ctx, null);
    return;
  }
  for (const { child, pos } of outOfFlow) {
    // The paint-order number is taken HERE, in the placement loop, so an out-of-flow child paints
    // ABOVE the in-flow items it shares the container with — which is where a browser puts it
    // (`elementFromPoint` over an `inset: 0` overlay answers the overlay, not the item under it).
    placeAbsolute(child, pos, inner.x, inner.y, ctx, null, (w, h) => {
      // §4.1 aligns the hypothetical item's MARGIN box, so the margins come out of the free space
      // and the border box then sits one lead margin in (Chrome: `justify-content: center` with a
      // 20px left margin puts an 8px box at 106 in a 200px row, not at 96).
      const m = edgeInsets(child, inner.width);
      const mainSize  = column ? inner.height : inner.width;
      const crossSize = column ? inner.width  : inner.height;
      const mainItem  = (column ? h : w) + m[axis.leadM] + m[axis.trailM];
      const crossItem = (column ? w + m.ml + m.mr : h + m.mt + m.mb);
      const crossLead = column ? m.ml : m.mt;
      const lead  = justifyOffsets(el, mainSize - mainItem, 1, axis, true).lead + m[axis.leadM];
      const main  = axis.reverse ? mainSize - mainItem - lead + m[axis.leadM] * 2 : lead;
      const cross = crossOffset(crossAlign(itemsAlign, child), crossSize, crossItem) + crossLead;
      return column ? [inner.x + cross, inner.y + main] : [inner.x + main, inner.y + cross];
    });
  }
}

// Is this box laid out the way the flex mapping above assumes — an LTR horizontal writing mode?
// Read through the same cascade the rest of layout uses, and gated so a page that declares neither
// (nearly all of them) pays a rules-index boolean rather than two lookups per container.
function ltrHorizontal(el) {
  if (declaresLayoutProp(el, 'direction')) {
    const d = declaredValue(el, 'direction');
    if (d != null && String(d).trim().toLowerCase() === 'rtl') return false;
  }
  if (declaresLayoutProp(el, 'writing-mode')) {
    const w = declaredValue(el, 'writing-mode');
    if (w != null && String(w).trim().toLowerCase() !== 'horizontal-tb') return false;
  }
  return true;
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
function mainAxisOffsets(el, items, sizes, gap, free, axis) {
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
  const just = autos > 0 && free > 0 ? ZERO_JUSTIFY : justifyOffsets(el, free, n, axis);
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
function justifyOffsets(el, free, count, axis, staticPos = false) {
  if (free === 0 || count === 0) return ZERO_JUSTIFY;
  let k = alignKeyword(declaredValue(el, 'justify-content'));
  // `left` / `right` name the INLINE axis. A column's main axis is not it, so there they behave as
  // `start` (CSS Align 3) — Chrome leaves a `justify-content: right` column's static position at
  // the start edge.
  if (axis.column && (k === 'left' || k === 'right')) k = 'start';
  // `start` / `end` / `left` / `right` are PHYSICAL (writing-mode relative) and do NOT follow a
  // reversed main axis the way `flex-start` / `flex-end` do: Chrome packs a `row-reverse` line with
  // `justify-content: right` against the physical right edge — which is that line's main-START.
  if (axis.reverse) {
    if (k === 'start' || k === 'left') k = 'flex-end';
    else if (k === 'end' || k === 'right') k = 'flex-start';
  }
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
function crossAlign(containerAlign, child) {
  const self = declaresLayoutProp(child, 'align-self')
    ? alignKeyword(declaredValue(child, 'align-self'))
    : null;
  const align = (self && self !== 'auto') ? self : containerAlign;
  if (align == null || align === 'normal' || align === 'auto') return 'stretch';
  if (align === 'start' || align === 'left'  || align === 'self-start') return 'flex-start';
  if (align === 'end'   || align === 'right' || align === 'self-end')   return 'flex-end';
  // `last baseline` aligns the LAST baselines, which for a single-line box means its far edge —
  // Chrome puts a 6px box 4px down a 10px line for it, where plain `baseline` leaves it at 0.
  if (align === 'last baseline') return 'flex-end';
  return align;
}
// The offset that alignment gives an item within the line's cross size. `baseline` aligns first
// baselines, which a coarse pass has none of; for the single-line items it is used on, a browser
// puts them exactly where `flex-start` does.
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
// through to the start edge.
function alignKeyword(v) {
  if (v == null) return null;
  const k = String(v).trim().toLowerCase();
  return k.startsWith('safe ') ? k.slice(5).trim() : k.startsWith('unsafe ') ? k.slice(7).trim() : k;
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

// A flex ROW: items sit side by side in source order with their widths resolved together (see
// `resolveFlexRowWidths`), and the line is as tall as its tallest item. No wrapping — enough that a
// toolbar, a field row or a card row occupies ONE row's height instead of one per item.
function layoutFlexRow(el, box, content, ctx, { equalShare = false } = {}) {
  const outOfFlow = [];
  const items = flexItems(el, content, ctx, outOfFlow);
  const n = items.length;
  const reverse = isReverseFlex(el);
  const axis = MAIN_AXES[reverse ? 'row-reverse' : 'row'];
  // Gaps and the items' own margins come out of the line before anything is distributed — an
  // `auto` margin resolves to 0 here and takes its share of the free space further down.
  // …asked BEFORE the auto height below fills it in, which is what makes the two cases different.
  const definiteCross = box.height !== 0 || box.autoHeight === false;
  const gap = n > 1 ? axisGap(el, 'column', content.width) : 0;
  let taken = gap * Math.max(0, n - 1);
  for (const it of items) taken += it.edges.ml + it.edges.mr;
  const avail = Math.max(0, content.width - taken);
  // An item with no text of its own has no content width to measure, so it takes an equal share —
  // better than the zero a text estimate would give a container of blocks.
  const share = n ? Math.floor(avail / n) : avail;
  const widths = equalShare ? items.map(() => share) : resolveFlexRowWidths(items, content, avail, share);

  let used = taken;
  for (const w of widths) used += w;
  const offsets = mainAxisOffsets(el, items, widths, gap, content.width - used, axis);

  let rowH = 0;
  const itemsAlign = (n || outOfFlow.length) ? alignKeyword(declaredValue(el, 'align-items')) : null;
  for (let i = 0; i < n; i++) {
    const it = items[i], { child, edges } = it;
    // The flex pass already resolved this axis: a declared width is an item's flex BASE, not its
    // final width, so it must not win here the way it does in block flow (two 500px items in a
    // 600px row shrink to fit, they don't overflow to 900). The `equalShare` path is the exception
    // — it is an ORPHAN `display: table-row` (a real table's rows never reach here), whose cells
    // keep their declared widths.
    const size = usedSize(child, widths[i], 0, content.width, content.height || null);
    if (!equalShare) size.width = widths[i];
    it.size = size;
    it.align = crossAlign(itemsAlign, child);
    it.stretch = size.autoHeight && stretchesInCross(it.align, child, 'height', edges);
    it.rel = it.pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null;
    const x = reverse ? content.x + content.width - offsets[i] - size.width : content.x + offsets[i];
    layoutElement(child, {
      x: x + (it.rel ? it.rel.x : 0), y: content.y + edges.mt + (it.rel ? it.rel.y : 0),
      width: size.width, height: size.height, autoHeight: size.autoHeight
    }, ctx, content.width);
    stampMainMargins(it, reverse);
    const outer = child._lb.height + edges.mt + edges.mb;
    if (outer > rowH) rowH = outer;
  }
  // Auto height wraps the line plus this container's own vertical edges.
  if (box.height === 0 && box.autoHeight !== false) {
    const e = edgeInsets(el, box.width);
    box.height = Math.max(rowH, anonymousItemHeight(el)) + e.top + e.bottom;
  }
  // CROSS AXIS, in a second pass because the line's cross size isn't known until every item has
  // been measured. An item with an AUTO cross size grows to it (the default `align-items`), so a
  // row of short items all end up as tall as its tallest — without that a single-icon flex item
  // was as tall as the icon, 16px where Chrome gives 40, and a click aimed at its centre landed on
  // whatever sat above. One that is ALIGNED instead is moved to where its alignment puts it.
  // A container with a DEFINITE cross size hands its single line exactly that: an item taller than
  // it overflows rather than growing the line, and everything aligned in that line is placed
  // against the container's own edges. Taking the tallest item instead made a 40px row report 90,
  // and put every centred sibling 30px low (Chrome: an item 60px too tall for a centred line sits
  // at -30).
  const lineCross = Math.max(0, (box.height || 0) - contentEdges(el, box.width));
  const cross = definiteCross ? lineCross : Math.max(rowH, lineCross);
  for (const it of items) {
    const { child, edges } = it;
    const b = child._lb;
    const room = cross - edges.mt - edges.mb;
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
      continue;
    }
    // An `auto` cross margin takes the line's leftover instead of the box growing into it — the
    // column's cross rule, down rather than across (Chrome: `margin-top: auto` on a 20px item in a
    // 100px row puts it at 80 and reports the margin as 80px) — and then ALIGNMENT has no free
    // space left to place the item with. The two are kept apart because only one of them is a
    // margin: an `align-items: center` item is centred with `margin-top: 0`, not with 40px of one.
    const m = edges.autoMargins ? autoMarginSplit(edges, 'top', 'bottom', cross, b.height)
                                : { lead: edges.mt, trail: edges.mb };
    const off = edges.autoMargins ? 0 : crossOffset(it.align, cross, b.height + edges.mt + edges.mb);
    shiftSubtreeY(child, content.y + off + m.lead + (it.rel ? it.rel.y : 0) - b.y);
    child._lbMargins.top = m.lead;
    child._lbMargins.bottom = m.trail;
  }
  deferFlexOutOfFlow(el, box, content, ctx, outOfFlow, axis, itemsAlign);
  stampExtent(el, box);
}

// A flex COLUMN: items stack, and their HEIGHTS are resolved together exactly as a row's widths
// are. Block flow, which this used to fall through to, got the stacking right and everything else
// wrong: a `flex: 1` pane was as tall as its text (Avo's sidebar scroll area came out 960 where
// Chrome gives 887, which pushed the profile row past the bottom of the sidebar and left a
// `useClickOutside` dropdown that never closed), margins between items collapsed where flex margins
// never do, and `column-reverse` ran forwards.
function layoutFlexColumn(el, box, content, ctx) {
  const outOfFlow = [];
  const items = flexItems(el, content, ctx, outOfFlow);
  const n = items.length;
  const reverse = isReverseFlex(el);
  const axis = MAIN_AXES[reverse ? 'column-reverse' : 'column'];
  const main = definiteMainHeight(el, box, content);
  const gap = n > 1 ? axisGap(el, 'row', main) : 0;
  let taken = gap * Math.max(0, n - 1);
  for (const it of items) taken += it.edges.mt + it.edges.mb;

  // The CROSS axis first: an item's height is measured at the width — and at the position — it
  // will actually have, so the measuring layout is one the placement pass can reuse where it stands.
  const itemsAlign = (n || outOfFlow.length) ? alignKeyword(declaredValue(el, 'align-items')) : null;
  for (const it of items) {
    const { child, edges } = it;
    const availW = Math.max(0, content.width - edges.ml - edges.mr);
    it.align = crossAlign(itemsAlign, child);
    it.stretch = stretchesInCross(it.align, child, 'width', edges);
    // A stretched item fills the line; an aligned one is as wide as its content wants to be, the
    // same shrink-to-fit every other content-sized box gets (Chrome: an `align-self: flex-start`
    // item around the word "start" is 31px wide, not the container's 600).
    it.size = usedSize(child, it.stretch ? availW : shrinkToFitWidth(child, availW), 0, content.width, main);
    // STRETCH beats an intrinsic size: an item whose width comes from the element rather than its
    // content is still the line's cross size (Chrome, in a 200px column: a `<select>` is 200 where
    // its own width is 45, an `<input>` 200 against 185, an `<iframe>` 200 against 300). Boxes with
    // an intrinsic RATIO are left alone — Chrome stretches those too and then re-derives the other
    // axis from the ratio, which is a replaced-sizing pass we don't have.
    const intrinsic = intrinsicSize(child);
    if (it.stretch && intrinsic && !intrinsic.ratio) {
      it.size.width = clampToMinMax(child, availW, 'width', content.width, edges.left + edges.right);
    }
    it.rel = it.pos === 'relative' ? relativeOffset(child, content.width, main) : null;
    // An `auto` cross margin centres the item (or pushes it to one side) and wins over alignment,
    // which then has no free space left to place it in. What each of them contributes is kept
    // apart: only the margin is a MARGIN, and an `align-items: center` item is centred with
    // `margin-left: 0`, not with 150px of one.
    it.cross = edges.autoMargins
      ? autoMarginSplit(edges, 'left', 'right', content.width, it.size.width)
      : { lead: edges.ml, trail: edges.mr };
    it.crossOffset = edges.autoMargins
      ? 0
      : crossOffset(it.align, content.width, it.size.width + edges.ml + edges.mr);
    it.x = content.x + it.crossOffset + it.cross.lead + (it.rel ? it.rel.x : 0);
  }

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
  // With no definite height to divide there is no free space — but the clamps still apply, so the
  // items go through the same resolution rather than a second code path.
  const available = main != null ? Math.max(0, main - taken) : null;
  const inner = items.map((it, i) =>
    Math.max(0, bases[i] - (isBorderBox(it.child) ? 0 : it.edges.top + it.edges.bottom)));
  let heights = resolveFlexibleLengths(bases, inner, parts, available, clampOf);
  let used = taken;
  for (const h of heights) used += h;
  // A `max-height` the items overrun is a main size too — the container ends up exactly that tall,
  // so the line has to be resolved against it (Chrome squeezes a 200px item in a
  // `max-height: 100px` column to 100). Only when they DO overrun it: below the cap the column is
  // as tall as its content and nothing flexes. The measurements are cached, so the second pass
  // costs the arithmetic and no layout.
  const capped = main == null ? cappedMainHeight(el, box, used) : null;
  if (capped != null) {
    heights = resolveFlexibleLengths(bases, inner, parts, Math.max(0, capped - taken), clampOf);
    used = taken;
    for (const h of heights) used += h;
  }
  // Where the items sit runs to the container's own main size when it has one: `justify-content`
  // and a reversed line both measure from the far edge, which is the container's, not the content's.
  const extent = main != null ? main : (capped != null ? capped : used);
  const offsets = mainAxisOffsets(el, items, heights, gap, extent - used, axis);

  for (let i = 0; i < n; i++) {
    const it = items[i], { child, edges } = it;
    const h = heights[i];
    const y = reverse ? content.y + extent - offsets[i] - h : content.y + offsets[i];
    // An item that ended up at exactly the height it measured is asked for that same auto height
    // again, so the measuring layout is REUSED rather than re-run — and its contents keep reading
    // an indefinite height, which is what they resolved a percentage against the first time.
    const imposed = main != null || it.measured == null || it.measured !== h;
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
  // Auto height wraps what the items consumed — or the floor a `min-height` put under them — plus
  // this container's own vertical edges.
  if (box.height === 0 && box.autoHeight !== false) {
    const e = edgeInsets(el, box.width);
    box.height = Math.max(extent, used, anonymousItemHeight(el)) + e.top + e.bottom;
  }
  deferFlexOutOfFlow(el, box, content, ctx, outOfFlow, axis, itemsAlign);
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
// The `max-height` a column's content has overrun, as an inner (content-box) figure — else null,
// which is every column that fits inside its own cap.
function cappedMainHeight(el, box, used) {
  const maxH = mayConstrainSize(el) ? resolveLayoutProp(el, 'max-height', el._lbCbH) : null;
  if (maxH == null || !(maxH >= 0)) return null;
  const e = edgeInsets(el, box.width);
  const inner = Math.max(0, isBorderBox(el) ? maxH - (e.top + e.bottom) : maxH);
  return used > inner ? inner : null;
}
// A DECLARED `min-height` in px, else null — `auto` (the initial value, and what a flex item's
// automatic minimum comes from) resolves to no length. Behind `mayConstrainSize`, so a page that
// declares none of the size constraints pays a boolean rather than a cascade lookup per item.
function declaredMinHeight(el, basis) {
  return mayConstrainSize(el) ? resolveLayoutProp(el, 'min-height', basis) : null;
}

// `flex-basis: content` sizes the item from its CONTENT and ignores the declared main size — the
// one basis `resolveLayoutProp` cannot answer, since it is a keyword rather than a length.
function isContentBasis(el) {
  const v = declaredValue(el, 'flex-basis');
  return v != null && String(v).trim().toLowerCase() === 'content';
}

// An item's flex base along the COLUMN axis, as a border box. `flex-basis` wins over a declared
// height, which wins over an intrinsic one (an `<img>`, an `<svg viewBox>`), and an item with none
// of those is as tall as its CONTENT — which, unlike a row's content width, can only be found by
// laying the item out. That layout is the one the placement pass reuses when the item ends up at
// the height it measured.
function flexColumnBase(it, main, content, ctx) {
  const { child, edges, size } = it;
  const basis = isContentBasis(child) ? null : resolveLayoutProp(child, 'flex-basis', main);
  // A basis is a CONTENT size unless `box-sizing` says otherwise, exactly as a declared height is,
  // so the edges come back on top: Chrome makes a `flex: 0 0 120px` item with 10px of padding 140
  // tall.
  if (basis != null) return basis + (isBorderBox(child) ? 0 : edges.top + edges.bottom);
  if (!size.autoHeight && !isContentBasis(child)) return size.height;
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

// A flex row's widths, resolved together: each item starts from its flex base size (0 for
// `flex: <n>`, a declared width, else its content) and `resolveFlexibleLengths` shares out what the
// line has left. Without the grow half a `flex: 1` pane is only as wide as the words in it; without
// the shrink half and the automatic minimum, a row of fixed-width items pushes its siblings off the
// line. Every figure here is a BORDER box: the free space is what the items OCCUPY, and counting
// their padding separately made two `flex: 1; padding: 20px` items 340 wide each in a 600px row.
function resolveFlexRowWidths(items, box, avail, share) {
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
    const basis = resolveLayoutProp(child, 'flex-basis', box.width);
    if (basis != null) return basis + extra;
    // `flex-basis: content` says to IGNORE the declared width and size from the content, which is
    // the one keyword `resolveLayoutProp` cannot answer (Chrome: 8px for a one-character item that
    // also declares `width: 400px`).
    if (!isContentBasis(child)) {
      const declared = resolveLayoutProp(child, 'width', box.width);
      if (declared != null) return declared + extra;
    }
    contentBased[i] = true;
    const intrinsic = intrinsicSize(child);
    if (intrinsic) return intrinsic.width + edges.left + edges.right;
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
      min = resolveLayoutProp(child, 'min-width', box.width);
      max = resolveLayoutProp(child, 'max-width', box.width);
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
  if (el._lbExt)     { el._lbExt.right     += dx; el._lbExt.bottom     += dy; }
  if (el._lbExtFlow) { el._lbExtFlow.right += dx; el._lbExtFlow.bottom += dy; }
  if (el._lbFrags) for (const r of el._lbFrags) { r.x += dx; r.y += dy; }
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT) continue;
    const b = child._lb;
    // A `position: fixed` box is laid out against the VIEWPORT, and an absolutely positioned one
    // against a containing block that may sit OUTSIDE the box being moved — a flex item nudged
    // down its line must not drag a dropdown anchored to the container along with it. Either way
    // no ANCESTOR's offset carries them. (The root of the walk is the box being moved on purpose,
    // so it always moves.)
    if (b && (b.fixed || (b.outOfFlow && !isSelfOrAncestor(b.cbEl, root)))) continue;
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
          ? { right: w.child._lb.x + w.child._lb.width, bottom: w.child._lb.y + w.child._lb.height }
          : w.child._lbExt;
        if (!ext) continue;
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
  if (disp === 'flex' || disp === 'inline-flex') {
    (isColumnFlex(el) ? layoutFlexColumn : layoutFlexRow)(el, box, content, ctx);
    return;
  }
  if (laysOutAsTable(el)) { layoutTable(el, box, content, ctx); return; }
  // Reached here, a row is an ORPHAN — a `display: table-row` with no table around
  // it, which a browser wraps in an anonymous table and we don't. Its cells at
  // least sit side by side rather than stacking, as they did before there was a
  // table pass at all (a table's own rows never come through here: `layoutTable`
  // places them itself).
  if (disp === 'table-row') { layoutFlexRow(el, box, content, ctx, { equalShare: true }); return; }

  const right = content.x + content.width;
  let flowY = content.y;      // top of the current line box / the next block
  let lineX = content.x;      // horizontal cursor within the current line
  let lineH = 0;              // tallest box on the current line
  // …and the tallest COLLAPSIBLE SPACE placed since the last real content on it, which counts
  // only once something follows it there: a line holding an empty `inline-block` and a space
  // the break then ate is zero tall in Chrome, not one line tall.
  let lineHangH = 0;
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

  // End the current line unconditionally — a `<br>`, or a newline a `pre` block keeps.
  const forceBreak = () => {
    dropHangs(true);
    // An inline box with nothing in it takes a fragment only where there is a line box to
    // take it on — Chrome gives `<span></span>label` a 0 x 17 rect and a lone
    // `<div><span></span></div>` an empty one, and no height at all.
    for (const frag of lineEmpties) frag.onLine = linePlaced;
    lineEmpties.length = 0;
    // A line is as tall as what is on it — including nothing at all: a lone empty
    // `inline-block` makes a zero-height line, and Chrome gives the block around one a
    // height of 0. The font's line height is the height of a line that was never
    // filled: the one a `<br>` at the start of a line, or a preserved newline, leaves
    // behind.
    flowY += linePlaced ? lineH : lineHeightOf(el);
    lineX = content.x;
    lineH = 0;
    lineHangH = 0;
    linePlaced = false;
    lineHasContent = false;
    lineEndsWithSpace = false;
  };
  // …and the same thing, but only when there IS a line to end: a block-level box
  // starts below whatever was open, and below nothing if nothing was.
  const breakLine = () => {
    if (!linePlaced && lineX === content.x) return;
    forceBreak();
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
  const placeTextRun = (text, owner) => {
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
    const spaceW = measureRun(' ', owner);        // hoisted: every collapsed gap is one space
    const segments = keepsNewlines ? String(text).split('\n') : [String(text)];
    segments.forEach((segment, i) => {
      // A preserved newline breaks the line AFTER whatever the box opened with.
      if (i > 0) { flushOpenEdges(); forceBreak(); }
      const run = collapseRun(segment, owner, lineX === content.x || lineEndsWithSpace);
      if (!run) return;
      if (!wraps) {
        placeOnLine(measureRun(run, owner), lh, !outerWraps);
        // Placed whole, so `placeOnLine` saw no white space in it — but a run that ENDS in a
        // COLLAPSIBLE space still ends the line in one, and the space after it collapses
        // against it. A preserved one does not collapse with anything (CSS Text 3 §4.1.1),
        // so the space after a `white-space: pre` span survives.
        lineEndsWithSpace = !preserves && CSS_WS_RE.test(run.slice(-1));
        return;
      }
      // Alternating [word, space, word, …] — split on the CSS white-space set, which
      // does NOT include U+00A0: an NBSP is a character a line may not break at, and
      // JS `\s` matches it, so `\s` here would wrap `10&nbsp;kg`.
      for (const token of run.split(WS_SPLIT_RE)) {
        if (!token) continue;
        if (CSS_WS_RE.test(token)) {
          // White space at a line start survives only where the mode preserves it.
          if (lineX > content.x || preserves) {
            placeOnLine(preserves ? measureRun(token, owner) : spaceW, lh, true, !preserves);
          }
          continue;
        }
        const split = breakUnits(token, owner, content.width);
        // `overflow-wrap: break-word` breaks a word only when there is no other
        // acceptable break — and moving to the next line IS one, so the word starts
        // fresh and breaks there (Chrome puts "see" alone above a broken URL).
        // `word-break: break-all` has no such rule and fills the line it is on.
        if (split.freshLine && lineHasContent) forceBreak();
        for (const unit of split.units) {
          const w = measureRun(unit, owner);
          if (lineHasContent && (lineX - content.x) + openEdgeWidth() + w > content.width) forceBreak();
          placeOnLine(w, lh, true);
        }
      }
    });
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
  const placeOnLine = (w, h, decided, hangs, edge) => {
    // Inline content ends the block-margin adjacency: it sits BELOW a preceding
    // block's bottom margin rather than collapsing with it.
    flushMargin();
    // An edge still to be placed is part of what the content has to fit.
    const pending = edge ? 0 : openEdgeWidth();
    if (!decided && lineHasContent && lineX + pending + w > right) forceBreak();
    if (pending) flushOpenEdges();
    const at = { x: lineX, y: flowY };
    lineX += w;
    if (hangs) {
      if (h > lineHangH) lineHangH = h;
    } else {
      if (lineHangH > lineH) lineH = lineHangH;
      lineHangH = 0;
      if (h > lineH) lineH = h;
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
      if (lineHeightOf(el) > lineH) lineH = lineHeightOf(el);
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
      line = { y, minX: fromX + inset, maxRight: -Infinity, hangRight: -Infinity,
               hangPending: false };
      frag.lines.push(line);
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
        if (lineX > content.x && t && !lineEndsWithSpace) {
          flushMargin();
          placeOnLine(measureRun(' ', owner), lineHeightOf(owner), true, true);
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
      placeAbsolute(child, pos, lineX, flowY, ctx);
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
      forceBreak();
      return true;
    }

    if (!isInlineLevel(child)) return false;
    // A non-replaced `display: inline` box holding only inline content is not a box at
    // all until its content is placed: it FRAGMENTS across the lines that content took.
    if (isContinuedInline(child)) { placeInlineBox(child, pos); return true; }
    // Everything else inline-level is ATOMIC: one rectangle on one line, as wide as its
    // content (a declared width or an intrinsic size wins) and as tall as what it holds.
    const ce   = edgeInsets(child, content.width);
    // An `inline-table` shrinks to fit like any table — and that figure is already
    // its whole border box; everything else inline is as wide as the text it holds,
    // plus its own edges.
    const isTable = laysOutAsTable(child);
    const autoInlineW = isTable
      ? shrinkToFitWidth(child, content.width)
      : Math.min(subtreeTextWidth(child), content.width) + ce.left + ce.right;
    // Every non-replaced inline-level box fills its own height from what it holds —
    // a table from its rows, an `inline-block` from its LINES — so it must arrive
    // with an auto one. Handed a line box instead it kept that: an 80px-wide
    // `inline-block` around three words measured 18 tall while its text wrapped to
    // 36 below it, and a table lost the border-spacing under its last row.
    const size = usedSize(child, autoInlineW, 0, content.width, content.height || null);
    const rel  = pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null;
    // The line takes the height of what is on it — which a box that back-fills its
    // own is not yet able to say, so the line grows again below once it has.
    const at   = placeOnLine(size.width, size.height);
    const cbox = {
      x: at.x + (rel ? rel.x : 0), y: at.y + (rel ? rel.y : 0),
      width: size.width, height: size.height, autoHeight: size.autoHeight
    };
    layoutElement(child, cbox, ctx, content.width);
    // A box that back-filled its own height — a table from its rows, an
    // `inline-block` from its lines — only knows it now, so the line grows to it as
    // it would have to a declared one.
    if (cbox.height > lineH) lineH = cbox.height;
    // An atomic box WRAPS its content, which the text estimate above can badly undersell:
    // the `<span>` ProseMirror puts around an image contains no text at all, so it measured
    // 0 wide while holding a 500px image — two of them then sat 19px apart, overlapping, and
    // a click aimed at the first landed on the second. Grow whichever axis was auto to the
    // content extent and let the line follow.
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
      // The extent already includes this box, so only a child that OVERFLOWS it grows
      // the box and the line.
      const contentH = ext.bottom - cbox.y;
      if (size.autoHeight && contentH > cbox.height) {
        cbox.height = contentH;
        if (contentH > lineH) lineH = contentH;
      }
      stampExtent(child, cbox);
    }
    return true;
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
      rel: pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null
    };
    openInlines.push(frag);
    OPEN_INLINE_BOXES.push({ rel: frag.rel, deferred: deferredOutOfFlow });

    // `isContinuedInline` has already refused any child a block formatting context would
    // have to place, so nothing here comes back unhandled.
    for (const grand of layoutChildren(child)) placeInlineChild(grand, child);
    // Nothing came, so the box shows its edges where it opened (Chrome gives a lone padded empty
    // `<span>` a 10x27 box on its line).
    if (frag.pendingOpen) flushOpenEdges();
    if (ce.right) placeOnLine(ce.right, ownH, true, false, true);
    openInlines.pop();
    OPEN_INLINE_BOXES.pop();
    // The right margin is outside the box, so it advances the line after the box has closed.
    if (ce.mr) placeOnLine(ce.mr, ownH, true, false, true);
    inlineBoxes.push(frag);
    if (!frag.lines.length) lineEmpties.push(frag);
  };

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
      for (const line of frag.lines) {
        const right = Math.max(line.maxRight, line.hangRight);
        // Nothing survives on this line — its one placement was a space, and the break ate it.
        // The line record is still there; the fragment is not (Chrome: an `<a>` written across
        // two source lines has ONE rect, not one plus an empty one at the newline).
        if (right === -Infinity) continue;
        rects.push({ x: line.minX, y: line.y - ce.top,
                     width: Math.max(0, right - line.minX), height: ownH + ce.top + ce.bottom });
      }
      // The box is empty: either nothing was ever placed in it, or every line it did reach
      // was emptied by a break eating the space it held. It is a zero-WIDTH fragment where
      // there is a line box to sit on — the line it reached always is one — and a zero-SIZE
      // one where there is not.
      if (!rects.length) {
        const line = frag.lines[0];
        if (line) {
          rects.push({ x: line.minX, y: line.y - ce.top, width: 0, height: ownH + ce.top + ce.bottom });
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

  for (const child of layoutChildren(el)) {
    if (placeInlineChild(child, el)) continue;

    const pos = positionOf(child);
    // In-flow block: fills the containing width unless explicitly sized, and starts below whatever
    // line was open.
    breakLine();
    // Margins inset the box horizontally and advance the flow vertically (collapsing
    // with the previous sibling's — see `collapsed` above).
    const cm = edgeInsets(child, content.width);
    const availW = Math.max(0, content.width - cm.ml - cm.mr);
    // A table is SHRINK-TO-FIT where a block fills — including one with no rows in it, whose
    // width then comes from the text the flow path lays out (Chrome: a `display: table` div
    // around a word is as wide as the word, not as wide as its container).
    const autoW = isTableDisplay(displayOf(child)) ? shrinkToFitWidth(child, availW) : availW;
    const size = usedSize(child, autoW, 0, content.width, content.height || null);
    // CSS 2.1 §10.3.3: a block narrower than its containing block gives the leftover to
    // whichever horizontal margins are `auto` — both, and it is centred; one, and it is
    // pushed to the other side. `margin: 0 auto` is how half the pages on the web centre
    // their shell, and taking `auto` as zero (which `edgeInsets` does, since there is no
    // length to resolve) left every one of them hard against the left edge.
    // A FLOAT reaches this branch too — floats aren't modelled, so one is laid out as an ordinary
    // block — but §10.3.5 computes its `auto` margins to zero rather than distributing them. Both
    // tests are behind `cm.autoMargins`, so a box with no `auto` margin (nearly every box) pays a
    // bitmask read and no cascade lookup at all.
    const distributes = cm.autoMargins !== 0 && !isFloated(child);
    const m = distributes ? autoMarginSplit(cm, 'left', 'right', content.width, size.width) : cm;
    const lead  = distributes ? m.lead  : cm.ml;
    const trail = distributes ? m.trail : cm.mr;
    const rel  = pos === 'relative' ? relativeOffset(child, content.width, content.height || null) : null;
    // `flowY` sits at the previous border box's bottom; the gap to this one is the
    // COLLAPSED margin of the two adjoining ones, not their sum.
    flowY += openMargin == null ? cm.mt : collapsed(openMargin, cm.mt);
    layoutElement(child, { x: content.x + lead + (rel ? rel.x : 0), y: flowY + (rel ? rel.y : 0),
                          width: size.width, height: size.height, autoHeight: size.autoHeight }, ctx, content.width);
    // …after the box is laid out, because `layoutElementInner` clears the stamp first.
    child._lbMargins = { left: lead, right: trail };
    flowY += child._lb.height;     // the flow advances by the box's height, not its shifted position
    openMargin = cm.mb;            // stays open for the next sibling to collapse with
  }
  breakLine();
  settleInlineBoxes();
  flushMargin();   // a last child's bottom margin is part of what this block wraps
  // Auto height (a block with no explicit height) = the flow its in-flow children
  // consumed, plus this element's own padding + borders (the flow started at the
  // content-box top, so both edges have to come back). An EMPTY box is that same sum with no flow
  // in it — its edges are its whole height, which is why Chrome gives `<button></button>` (2px
  // border, 1px padding) a 6px-tall box rather than nothing at all.
  // …unless the page asked for a zero height: `autoHeight` is stamped false only by a DECLARED
  // one, so a box that never went through `usedSize` (a caption, a frame document) still fills.
  if (box.height === 0 && box.autoHeight !== false) {
    box.height = (flowY - content.y) + edge.top + edge.bottom;
  }
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
      ce = {
        right:  child._ccX ? own.x + own.width  : (ce ? ce.right  : own.x + own.width),
        bottom: child._ccY ? own.y + own.height : (ce ? ce.bottom : own.y + own.height)
      };
    }
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
  for (const child of layoutChildren(el)) {
    if (child.nodeType !== NODE_ELEMENT || selfNotRendered(child)) continue;
    const pos = positionOf(child);
    // An out-of-flow grid child joins no row, so its static position is the grid's own content
    // origin — not the row being filled when the parser happened to reach it (Chrome puts one
    // at the container's content top-left whatever precedes it).
    if (pos === 'absolute' || pos === 'fixed') { placeAbsolute(child, pos, content.x, content.y, ctx); continue; }
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
  } else if (intrinsic) {
    inner = { min: intrinsic.width, max: intrinsic.width };
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
  if (memoFresh(el, "_lbCiwPass")) return el._lbCiw;
  el._lbCiwPass = memoStamp(el);
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
    // A `<br>` ends the line it is on even at MAX-content width — nothing after it can share that
    // line, so a box holding `one<br>two<br>three` wants the widest of the three, not their sum
    // (Chrome: 36.47, where summing them said 140.53 and made every such flex item four times too
    // wide before it was even shrunk).
    if (child.tagName === 'BR') { endLine(); continue; }
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
    el._lbFont = { table, size: computedFontSizePx(el) || 16 };
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
  let cur = el, v = null;
  for (let i = 0; cur && cur.nodeType === NODE_ELEMENT && i < 64; cur = cur._parent, i++) {
    const raw = declaredValue(cur, 'white-space') ?? uaDefault(cur, 'white-space');
    if (raw == null) continue;
    const t = String(raw).trim().toLowerCase();
    if (t && t !== 'inherit') { v = t; break; }
  }
  el._lbWs = v || 'normal';
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
  if (intrinsic) return intrinsic.width;
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
  const cbEdge = edgeInsets(parent, parent._lbCbW != null ? parent._lbCbW : parent._lb.width);
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
      const pe = p === root ? null : edgeInsets(p, p._lbCbW != null ? p._lbCbW : p._lb.width);
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

// `el`'s border-box in VIEWPORT coords (laid-out box minus its ancestor scroll shift).
function renderedBox(el) {
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
  const covers = (b) => vx >= b.x - sx && vx <= b.x - sx + b.width &&
                        vy >= b.y - sy && vy <= b.y - sy + b.height;
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

// The element's rendered pieces, viewport-relative: one rect per line a fragmented inline
// broke over, and its single box otherwise. `getClientRects` reports exactly this — every
// RENDERED element has at least one box, even a zero-sized one (an empty `<span>` alone in a
// block is `[0, 0, 0, 0]` in Chrome, and one rect, not none), and one that isn't rendered has
// none at all. A fragmented inline never goes through `layoutElement`, so its pieces are not
// cleared by a pass that stops rendering it: the guard has to be here.
export function clientRectsOf(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || !isLaidOutNode(el)) return [];
  ensureLayout();
  if (!el._lb) return [];
  const { sx, sy } = scrollShift(el);
  const boxes = el._lbFrags || [el._lb];
  return boxes.map((b) => ({ x: b.x - sx, y: b.y - sy, width: b.width, height: b.height }));
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
        const rb = renderedBox(p);
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

