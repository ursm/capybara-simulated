// The layout's ENTRY, its WRITER and its READERS. The layout itself is the Rust walk (ext/csim_native/src/walk.rs, which
// builds a record per box from the arena and the style engine) laid out by ext/csim_native/src/layout.rs — what it
// models, and what it deliberately does not, is documented there. This module asks for a pass when a geometry read
// needs one (`ensureLayout` → `nativeLayoutPass` → `nlRustPass`), writes its answer onto the elements as their boxes
// (`nlCommitPass` / `nlWriteBoxes`: a border-box `{x, y, width, height}` in document coordinates per rendered element,
// an inline box's fragments, the edges and margins the pass used), and stamps the paint order and the scrollable
// overflow extents when something reads them (`ensureOrderAndExtents`). A page the walk declines has the root's box
// alone (`layoutRootAlone`), counted by reason (`__csimNativeLayoutStats`).
//
// Everything that reads that layout lives here as well: the page-visible geometry surface
// (`getBoundingClientRect` / `elementFromPoint` / `offset*` / `client*` / `scroll*`), the z-order hit test, the
// transformed geometry, the resolved CSSOM values that are used values, and the paint support (`recordingRuns`) — so
// the driver and the page's own JS never disagree about where anything is. So do the per-element predicates and memos
// those readers share (`displayOf`, `layoutChildren`, `edgeInsets`, `tableGrid`, …) and the text metrics the painter
// and the intrinsic sizes measure with (`measureRun`, `charAdvances`).
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

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, HTML_NS }  from './constants.js';
import { walkInclShadow, flatTreeParent }                from './walk.js';
import { maybeVerifyArena, scrollOffsetOf, scrollShiftOf, stickyOffsetOf, layoutRootAloneIn } from './native-query-shadow.js';
import { animationGeneration }                           from './web-animations.js';
import { isLaidOutNode, selfNotRendered, resolveLayoutProp, hasFallbackOnlyContent, rendersObjectFallback, cascadeLayoutEpoch, settleLayoutInvalidation, inlineAxisIsHorizontal, flowSides, dynamicReadSeq, visibilityHidden, ownWhiteSpace, declareStyledMemos, flushStyleEngine, currentStructureGen, engineValue } from './cascade.js';
import { currentViewport }                               from './media-query.js';
import { advanceTableFor, faceStackFor, rangesCover, natFontGen, teachFaces } from './font-metrics.js';
// Box props are read through `declaredValue` — the style engine's computed values, which getComputedStyle reads too:
// ONE geometry means one value resolution.
import { usedDisplay, WIDGET_TAGS, renderingTag, displayAsLaidOut, declaredValue, computedFontSizePx, computedLineHeight, computedFontFamily, fontKeyOf, computedLetterSpacingText, computedWordSpacingText, spacingAt, textAlignOf, textIndentOf, tabSizeOf, pseudoNodeFor, linkGeneratedBox, placeholderNodeFor, computedBorderCollapse, isListBox, inputType, buttonInputLabel, usedTransformMatrix, usedPerspective, preserves3d, multiply4, translate4, flattenMatrix4, homographyOf, applyHomography, invertHomography, computedPositionOf, computedFloatOrClear, currentlyAnimatesAnyOf } from './style-proxy.js';
import { usedLineWidthPx, INITIAL_VALUES } from './css-utils.js';
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
// A border-collapse CELL's used geometry (its edges, intrinsic widths, box) depends on the cells it
// FACES — its border is as wide as the widest declaration on each shared edge. A per-cell memo keyed
// on the cell's OWN `memoStamp` is therefore stale when only a SIBLING changed: the sibling's mutation
// bumps the TABLE's dirty (an ancestor of both) but never the facing cell's, so `memoStamp(cell)` does
// not move. This returns the table's collapsed-border RESOLUTION generation for a collapse cell —
// `ensureCollapseBorders` advances it only when some resolved half-border actually moved, so the facing
// cells re-lay-out on a real border change but NOT on a table mutation that leaves the borders alone
// (a background, text — the common case). 0 for everything else; a memo that reads the collapsed
// geometry stores this beside its result and re-runs when it moves. (A collapse TABLE's own frame needs
// no such guard — any cell change dirties the table itself, moving its own memoStamp.)
function collapseDepStamp(el) {
  // Memoised per pass (the generation is fixed for the pass) — it is read by THREE memo gates per cell.
  if (el._lbDepPass === layoutPass) return el._lbDep;
  el._lbDepPass = layoutPass;
  let dep = 0;
  if (collapseMode(el) === COLLAPSE_CELL && el._lbTable) {
    ensureCollapseBorders(el._lbTable);   // make sure this pass's generation is resolved before we read it
    dep = el._lbTable._lbCollapseGen || 0;
  }
  el._lbDep = dep;
  return dep;
}
// …and the same for a memo that only STRUCTURE can invalidate (a table's grid): an attribute
// written on a cell cannot change which cells there are.
function structFresh(el, key) {
  const m = el[key];
  return m !== undefined && m === ((el._lbStruct || 0) * 4294967296) + cascadeLayoutEpoch();
}
function structStamp(el) { return ((el._lbStruct || 0) * 4294967296) + cascadeLayoutEpoch(); }
// A GRID container (§12), laid out by layout.rs `measure_grid` — `inline-grid` the same way wherever it lands
// (blockified as a flex / grid item, or as an ATOMIC INLINE at its line's shrink-to-fit).
function laysOutAsGrid(el) {
  const d = displayOf(el);
  return d === 'grid' || d === 'inline-grid';
}
// Text that is CONTENT to the inline formatting context: anything but CSS white space (`[ \t\n\r\f]`). NOT
// `String#trim`, which also strips U+00A0 / U+2000-200A / U+3000 / U+FEFF — an NBSP is content and no break, so a
// text node holding only one still makes a line.
const CSS_CONTENT_RE = /[^ \t\n\r\f]/;

// An out-of-flow box's flags, off its row: its containing block's ELEMENT (null: the viewport), whether it is
// VIEWPORT-fixed, and which axes take the static position (no inset on either side).
function nlOutOfFlowFlags(nb, nodes, inlines) {
  const axes = nb[NL_ROW_OOF + 3];
  return { fixed: nb[NL_ROW_OOF] === NL_OOF_FIXED && nb[NL_ROW_OOF + 1] === -1, outOfFlow: true,
           cbEl: nlRowContainingBlock(nb, 0, nodes, inlines),
           staticBlock: (axes & NL_STATIC_BLOCK) !== 0, staticInline: (axes & NL_STATIC_INLINE) !== 0 };
}
// …the containing block ELEMENT of the row at `o` in `rows` (null: the viewport). Named by its record or inline entry,
// so the same row names another element where the block was REPLACED by one that took its place in the pass — which
// is why a row kept as it was is still asked it (`nlWriteBoxes`).
function nlRowContainingBlock(rows, o, nodes, inlines) {
  const cb = rows[o + NL_ROW_OOF + 1];
  return (cb >= 0 ? nodes[cb] : cb === -2 ? inlines[rows[o + NL_ROW_OOF + 2]] : null) || null;
}
// The pass's answer WRITTEN as the layout, for what the geometry API and the painter read: each
// element's box with its out-of-flow flags, the basis its percentages resolved against, the margins its
// placement used and its own relative shift; an inline box's fragments and their union. Returns the elements written.
// A box a KEPT slice put back (`kept`) that native answers with the very row it answered last time — and whose `_lb` is
// still the object this wrote then, not one a root-alone layout put there since — is left as it is: nothing about it
// can have changed, its style included (the slice's stamp held), and building its box again was most of what writing a
// page cost (3.2 ms of a 28 ms pass on 1,500 rows, one text edit apart).
// A pass that follows straight on the one last written (`trusted`: no other pass and no root-alone layout in between)
// also skips, without reading the element at all, a kept box native answers with the box its node already held
// (`changed` lists the rest): what was written for it then is still there. Asking each of them again was most of what
// writing 1,500 rows cost — every element a different shape, so every property read of one a megamorphic load.
function nlWriteBoxes({ nodes, inlines, fragRows, boxRows, anon, kept, changed }, trusted = false) {
  const written = new globalThis.Set(nodes);
  written.delete(null);
  const keptMask = new Uint8Array(nodes.length);
  if (kept) for (let j = 0; j < kept.length; j += 2) keptMask.fill(1, kept[j], kept[j + 1]);
  if (trusted) {
    for (let j = 0; j < changed.length; j++) keptMask[changed[j]] = 0;
    for (let i = 0; i < nodes.length; i++) keptMask[i] += keptMask[i];    // (2: kept and as it was — skipped outright)
  }
  // …and which of them came out somewhere NEW (`written.moved`): a box, fragments or a shift unlike the last written —
  // what `nlStampOrderAndExtents` restamps extents from.
  const moved = written.moved = new globalThis.Set();
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const sameList = (a, b) => (a == null || b == null ? a == b : a.length === b.length && a.every((f, i) => same(f, b[i])));
  // (…an ANONYMOUS cell or grid item by its record, since it has no node: only its box, the rest is a DOM box's.)
  for (const [i, el] of anon) {
    const o = i * NL_BOX_ROW, box = { x: boxRows[o], y: boxRows[o + 1], width: boxRows[o + 2], height: boxRows[o + 3] };
    if (!same(el._lb, box)) moved.add(el);
    el._lb = { ...box, autoHeight: false };
    written.add(el);
  }
  // (…an out-of-flow box kept as it was all the same where the element its row names as its containing block is another
  // than it wrote: a block replaced by one that took its record's place leaves every number of the row as it was.)
  const cbReplaced = (el, o) => boxRows[o + NL_ROW_OOF] !== 0 && !!el && !!el._lb &&
    el._lb.cbEl !== nlRowContainingBlock(boxRows, o, nodes, inlines);
  for (let i = 0; i < nodes.length; i++) {
    if (keptMask[i] === 2 && !cbReplaced(nodes[i], i * NL_BOX_ROW)) continue;
    const el = nodes[i];
    if (el == null) continue;
    if (el._nid == null) { written.delete(el); continue; }
    const last = el._nlRow;
    if (keptMask[i] && last !== undefined && el._lb === last.lb && sameRow(last.row, boxRows, i * NL_BOX_ROW) &&
        !cbReplaced(el, i * NL_BOX_ROW)) continue;
    const nb = boxRows.subarray(i * NL_BOX_ROW, (i + 1) * NL_BOX_ROW);
    // (…its memos declared before the first is written, as a style read declares them: nothing on this side need have
    // read the element before)
    if (el._styled === false) declareStyledMemos(el);
    const prev = el._lb, prevRel = el._lbRel;
    el._lb = { x: nb[0], y: nb[1], width: nb[2], height: nb[3], autoHeight: !!nb[4], clip: nb[NL_ROW_CLIP],
               ...(nb[NL_ROW_OOF] ? nlOutOfFlowFlags(nb, nodes, inlines) : null) };
    if (!same(prev, el._lb) || el._lbFrags) moved.add(el);
    el._lbFrags = null;
    el._lbCbW = Number.isNaN(nb[5]) ? null : nb[5];
    nlWriteEdges(el, nb);
    const m = NL_USED_SIDES.map((_, k) => (Number.isNaN(nb[6 + k]) ? null : nb[6 + k]));
    el._lbMargins = m.some((v) => v != null) ? { top: m[0], right: m[1], bottom: m[2], left: m[3] } : null;
    flowShift(el, nlNativeRel(el, nb));
    const rel = el._lbRel;
    if ((rel ? rel.x : 0) !== (prevRel ? prevRel.x : 0) || (rel ? rel.y : 0) !== (prevRel ? prevRel.y : 0)) moved.add(el);
    if (last !== undefined) { last.row.set(nb); last.lb = el._lb; }
    else el._nlRow = { row: nb.slice(), lb: el._lb };
  }
  // Each inline box's fragment rows, by offset. One whose rows are the very ones written last time, onto the `_lb` written
  // then, is left as it is — the same test as a kept box's, and needing no kept range: nothing an inline box is written
  // with besides its fragments can differ (it is never out of flow, and it carries no basis, margins or shift yet). All
  // of them were rebuilt every pass, 56 on a Redmine issue page for the one a text edit touched.
  const byIdx = new globalThis.Map();
  for (let o = 0; o + NL_FRAG_ROW <= fragRows.length; o += NL_FRAG_ROW) {
    const offs = byIdx.get(fragRows[o]);
    if (offs) offs.push(o);
    else byIdx.set(fragRows[o], [o]);
  }
  inlines.forEach((el, i) => {
    const offs = byIdx.get(i);
    if (!offs) return;
    const last = el._nlFrags;
    if (last !== undefined && el._lb === last.lb && sameFragRows(last.rows, fragRows, offs)) { written.add(el); return; }
    const list = offs.map((o) => ({ x: fragRows[o + 1], y: fragRows[o + 2], width: fragRows[o + 3], height: fragRows[o + 4] }));
    const x0 = Math.min(...list.map((f) => f.x)), y0 = Math.min(...list.map((f) => f.y));
    const x1 = Math.max(...list.map((f) => f.x + f.width)), y1 = Math.max(...list.map((f) => f.y + f.height));
    if (el._styled === false) declareStyledMemos(el);
    const prev = el._lb, prevFrags = el._lbFrags;
    el._lb = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, autoHeight: true };
    el._lbFrags = list.length > 1 ? list : null;
    if (!same(prev, el._lb) || !sameList(prevFrags, el._lbFrags)) moved.add(el);
    // (No basis, no used margins and no shift: the pass reports none of them for an inline box, so a percentage
    // edge on one reads back against its own width.)
    el._lbCbW = null; el._lbMargins = null;
    flowShift(el, null);
    el._nlFrags = { rows: offs.map((o) => fragRows.slice(o + 1, o + NL_FRAG_ROW)), lb: el._lb };   // (copies: a view would hold the pass's buffer)
    written.add(el);
  });
  return written;
}
// A written box's edges, from its row, made its `edgeInsets` memo at the basis just written (`_lbCbW`): the geometry
// reads — the extents below, `clientWidth`, a used padding in `getComputedStyle` — take what the pass laid it out
// with, rather than resolving a dozen properties of the cascade again for every box the pass wrote. Whatever memo was
// there is replaced: the edges the pass laid the box out with are the answer, and a memo this side computed — from
// another resolution, whose invalidation a stamp here does not follow — is not. Held for one basis only where an edge
// resolved a percentage (`NL_ROW_PCT_EDGES`), as `edgeInsets` holds its own. (No basis, no memo: `insetsOf` then falls
// back to the box's own width, which is not the basis the pass had; and none for a table row or row group, which the
// pass gives no edges of its own.)
// …and held for as long as the layout it wrote is the page's (`NL_EDGES_OF_THE_PASS`), not to a stamp: they are the
// style engine's, which no stamp of this side's tracks — held to one, they would go stale with every mark a restyle
// made.
function nlWriteEdges(el, nb) {
  if (el._lbCbW == null || Number.isNaN(nb[NL_ROW_EDGES])) return;
  const o = NL_ROW_EDGES, bt = nb[o + 4], br = nb[o + 5], bb = nb[o + 6], bl = nb[o + 7], flags = nb[o + 12];
  el._lbEdge = { top: nb[o] + bt, right: nb[o + 1] + br, bottom: nb[o + 2] + bb, left: nb[o + 3] + bl,
                 mt: nb[o + 8], mr: nb[o + 9], mb: nb[o + 10], ml: nb[o + 11], bt, br, bb, bl, autoMargins: flags & 15 };
  el._lbEdgePct = (flags & NL_ROW_PCT_EDGES) !== 0;
  el._lbEdgeCb = el._lbCbW;
  el._lbEdgePass = NL_EDGES_OF_THE_PASS;
}
const NL_EDGES_OF_THE_PASS = -1;
// Whether an inline box's kept fragment rows are the ones at `offs` in `rows`, in order.
function sameFragRows(kept, rows, offs) {
  if (kept.length !== offs.length) return false;
  for (let f = 0; f < offs.length; f++) {
    const k = kept[f], o = offs[f] + 1;
    for (let j = 0; j < k.length; j++) if (k[j] !== rows[o + j]) return false;
  }
  return true;
}

// Whether a kept row says what `rows` does at `o`, NaN included (an absent basis or margin is NaN on both) — read in
// place, since a view per box was most of what the skip cost.
function sameRow(a, rows, o) {
  for (let k = 0; k < a.length; k++) {
    const x = a[k], y = rows[o + k];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}
// Every box in the layout tree under `root` that `has` one, pre-order — the paint order a pass hands out, a
// flex container's items in ORDER-MODIFIED document order, which is the order they paint in (Flexbox §4.3).
// (`pre.parents[i]` is the index of `pre[i]`'s parent in the list, -1 for the root; `pre.clean[i]` is 1 where the box
// came from a kept segment, whose stamps held.)
// A subtree whose `memoStamp` held since the last pass that kept one lists exactly what it listed then, so its SEGMENT
// is put back rather than walked (`_nlPre`): walking it asked every box its stamp and its children again — 5.4 ms of a
// 28 ms pass on 1,500 flex rows one text edit apart. A leaf keeps none (`NL_PRE_KEEP`): it is its own segment, and a
// segment holds its whole subtree, so the page is held once per level of depth above a leaf — the price of pasting a
// row of four as one step.
const NL_PRE_KEEP = 2;
let nlPreGen = 0;              // …moved when a root-alone layout wrote last, whose boxes no kept segment knows
function nlLayoutPreorder(root, has) {
  const pre = [];
  const parents = [];
  const clean = [];
  const visit = (el, parent) => {
    const stamp = memoStamp(el);
    const seg = el._nlPre;
    if (seg !== undefined && seg.stamp === stamp && seg.gen === nlPreGen) {
      const base = pre.length;
      const els = seg.els, rel = seg.parents;
      for (let j = 0; j < els.length; j++) {
        pre.push(els[j]);
        parents.push(j === 0 ? parent : base + rel[j]);
        clean.push(1);
      }
      return;
    }
    const at = pre.length;
    pre.push(el);
    parents.push(parent);
    clean.push(0);
    for (const c of nlPaintKids(el, has)) visit(c, at);
    if (pre.length - at >= NL_PRE_KEEP) {
      const rel = parents.slice(at);
      for (let j = 0; j < rel.length; j++) rel[j] -= at;
      el._nlPre = { stamp, gen: nlPreGen, els: pre.slice(at), parents: rel };
    }
  };
  visit(root, -1);
  pre.parents = parents;
  pre.clean = clean;
  return pre;
}

// An element's children in that order, kept while its `memoStamp` holds: nothing in or around it changed, so neither
// did which of them have a box nor their `order` — and asking the tree again is most of what a pass costs on a page one
// mutation touches. (`has` must answer alike for every pass that shares a stamp, which a written-box set does.)
function nlPaintKids(el, has) {
  const stamp = memoStamp(el);
  const kept = el._nlKids;
  if (kept && kept.stamp === stamp) return kept.kids;
  const kids = (laidOutBoxItems(el) || layoutChildren(el)).filter((c) => c && c.nodeType !== 3 && has(c));
  if (laysOutAsFlex(el)) kids.sort((a, b) => orderOf(a) - orderOf(b));
  el._nlKids = { stamp, kids };
  return kids;
}

// …and that order stamped (`_lbOrder`, the root first at -1), then the scrollable-overflow EXTENTS bottom-up
// (`stampExtent`) — the root's floored at the viewport, as `ensureLayout` floors it. Only where one can have moved,
// when the writer says which boxes did (`moved`): a box whose geometry is new, one whose own style or subtree changed
// since its extent was stamped (`_nlExtStamp` — a clip or a padding moves the extent with no box moving), and every
// box above either. The rest keep theirs; on a page one mutation touches, that is nearly all of them.
// The seed of the ROOT's extent — the VIEWPORT's scrolling area (CSSOM View): the initial containing block, and the
// root's MARGIN box where it reaches further. Native places the root at its margins, so a root box at (0, 0) as wide as
// the viewport is no longer a given: `html { margin-top: 32px }` (an admin bar's shape) over a 2000px body scrolls
// 2048 in Chrome. The root-alone layout does not (`atMargins` false): its root box already spans the viewport, and a
// margin added to it would scroll a page that does not.
function rootScrollSeed(root, atMargins) {
  const b = root._lb, vp = viewport();
  const e = atMargins ? insetsOf(root) : { ml: 0, mt: 0, mr: 0, mb: 0 };
  const x = Math.min(0, b.x - e.ml), y = Math.min(0, b.y - e.mt);
  return { x, y, width: Math.max(vp.width, b.x + b.width + e.mr) - x, height: Math.max(vp.height, b.y + b.height + e.mb) - y };
}
function nlStampOrderAndExtents(root, pre, moved) {
  for (let i = 0; i < pre.length; i++) pre[i]._lbOrder = i;
  root._lbOrder = -1;
  const stale = new Uint8Array(pre.length);
  const clean = pre.clean;
  for (let i = pre.length - 1; i >= 0; i--) {
    const el = pre[i];
    // (…a box from a kept preorder segment has the stamp it had when its extent was stamped: not asked again.)
    if (el !== root && !stale[i] && !moved.has(el) && el._lbExt && clean[i] && el._nlExtStamp !== undefined) continue;
    const stamp = memoStamp(el);
    if (el !== root && !stale[i] && !moved.has(el) && el._nlExtStamp === stamp && el._lbExt) continue;
    el._nlExtStamp = stamp;
    if (pre.parents[i] >= 0) stale[pre.parents[i]] = 1;
    if (el === root) stampExtent(root, rootScrollSeed(root, true));
    else stampExtent(el, el._lb);
  }
}
// How many times the walk has been asked for a pass (`__dom.layoutBuild`), and the count when its answer was last
// WRITTEN: the node boxes a pass compares its own with (`changed`) are the ones written only when no other pass came
// between.
let nlLayoutCalls = 0, nlWroteAtCall = -2;
// What a geometry read takes off a box BESIDES its rectangle, which the writer stamps off the row as well: the basis its
// percentage edges resolve against again (`_lbCbW`, read by `insetsAgainst` — the box's own width where none was
// stamped), the margins its placement used (`_lbMargins`, read by `usedMargin` — the resolved ones where a side was not
// stamped; these are its four sides) and its relative shift (`_lbRel`).
const NL_USED_SIDES = [['top', 'mt'], ['right', 'mr'], ['bottom', 'mb'], ['left', 'ml']];
// The relative shift a box took ITSELF, as `_lbRel` holds it (`flowShift`), off its row (the shift less the relative
// INLINE chain's around it, which stays on those inlines) — for a box that is `position: relative`, which an
// out-of-flow box's displacement in the same fields is not. Null for none.
function nlNativeRel(el, nb) {
  const position = nb[NL_ROW_POSITION];
  if (!(position ? position === NL_POSITION_RELATIVE : positionOf(el) === 'relative') || (!nb[10] && !nb[11])) return null;
  return { x: nb[10], y: nb[11] };
}
// One record's row in the pass's box answer (dom.rs `box_row`): [x, y, width, height, autoHeight,
// basis, the four used margins, the relative shift x / y], then its EDGES as the pass used them from `NL_ROW_EDGES` —
// padding, border and margin, each top / right / bottom / left, an `auto` margin as 0 — which margins are `auto`
// (`AUTO_MARGIN_BIT`, with `NL_ROW_PCT_EDGES` beside them where an edge resolved a percentage), and from `NL_ROW_OOF`
// whether the box is out of flow (1, `NL_OOF_FIXED` for `position: fixed`) and what placed it: its containing block
// (a record, −1 the viewport, −2 the inline entry after it; −3 on a box in flow) and the axes it takes its static
// position in (`NL_STATIC_BLOCK` / `NL_STATIC_INLINE`); and at `NL_ROW_POSITION` its computed `position`
// (`NL_POSITION_*`, walk.rs `position_code`), 0 for an anonymous box; and at `NL_ROW_CLIP` how it clips its content
// (`NL_CLIP_*`, walk.rs `clip_flags`).
const NL_BOX_ROW = 31;
const NL_ROW_EDGES = 12, NL_ROW_OOF = 25, NL_ROW_PCT_EDGES = 16, NL_ROW_POSITION = 29, NL_ROW_CLIP = 30;
const NL_OOF_FIXED = 2, NL_STATIC_BLOCK = 1, NL_STATIC_INLINE = 2;
const NL_POSITION_RELATIVE = 2;
const NL_CLIP_X = 1, NL_CLIP_Y = 2, NL_CLIP_SCROLLS = 4;
// A row of the pass's fragment answer: [inline index, x, y, width, height].
const NL_FRAG_ROW = 5;

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
  if (nids[0] === -1) { mark(doc.documentElement, true); return; }   // (…more than it keeps: everything)
  const byNid = nlNodesByNid(doc.documentElement);
  for (let i = 0; i < nids.length; i++) {
    const el = byNid.get(nids[i]);
    // A STRUCTURAL change where the restyle changed the `display` the last pass laid the element out by: which rows
    // and cells a table's grid is made of goes with it, and this side's grid memo (`tableGrid`) keys on the structure stamp — a
    // `:checked ~ table tr { display: none }` hid nothing there. Every restyle marked so cost a 400-row table its grid
    // on every colour change in a cell (+40% a relayout).
    if (el !== undefined) mark(el, el._lbDisp === undefined || engineValue(el, 'display') !== el._lbDisp);
  }
}

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
  if (NATIVE_WROTE_LAYOUT) {
    walkInclShadow(root, (n) => { if (n.nodeType === NODE_ELEMENT && n !== root) { n._lb = null; n._lbExt = null; n._lbFrags = null; } });
    NATIVE_WROTE_LAYOUT = false;
  }
  ROOT_ALONE_WROTE_LAYOUT = true;
  NL_ORDER_OWED = null;
  NL_PAINT_RUNS = null;
  const vp = doc._layoutVP;
  const width = resolveLayoutProp(root, 'width', vp.width) ?? vp.width;
  // (…its memos declared before the box is written, as the writer does: the first style read after would wipe it)
  if (root._styled === false) declareStyledMemos(root);
  root._lb = { x: 0, y: 0, width, height: resolveLayoutProp(root, 'height', vp.height) ?? 0 };
  layoutRootAloneIn(root, root._lb, vp);
  root._lbOrder = -1;
  stampExtent(root, rootScrollSeed(root, false));
}

// The page laid out by the Rust walk (`nlRustPass`) and its answer WRITTEN as the layout (`nlCommitPass`) — or false
// where it declined; `__csimNativeLayoutStats` counts both, the declines by reason.
let NATIVE_WROTE_LAYOUT = false;
// …and whether the last layout was the root's box alone (`layoutRootAlone`), whose leftovers — the boxes of what the next
// pass lays out no box for — that pass clears.
let ROOT_ALONE_WROTE_LAYOUT = true;
const NATIVE_LAYOUT_STATS = { rust: 0, rustFellBack: {} };
globalThis.__csimNativeLayoutStats = () => NATIVE_LAYOUT_STATS;
function nativeLayoutPass(root) {
  const r = nlRustPass(root);
  if (!r.ok) {
    NATIVE_LAYOUT_STATS.rustFellBack[r.reason] = (NATIVE_LAYOUT_STATS.rustFellBack[r.reason] || 0) + 1;
    return false;
  }
  NATIVE_LAYOUT_STATS.rust++;
  nlCommitPass(root, r);
  return true;
}
// A pass the walk laid out, WRITTEN as the layout: its boxes (`nlWriteBoxes`) — and every box it did not write cleared
// where the root's box alone was the last layout — and the paint order and the extents OWED (`nlOweOrderAndExtents`).
function nlCommitPass(root, r) {
  NATIVE_WROTE_LAYOUT = true;
  if (r.results.paintRuns) NL_PAINT_RUNS = r.results.paintRuns;
  const written = nlWriteBoxes(r.results, !ROOT_ALONE_WROTE_LAYOUT && r.results.callAt === nlWroteAtCall + 1);
  nlWroteAtCall = nlLayoutCalls;
  if (ROOT_ALONE_WROTE_LAYOUT) {
    ROOT_ALONE_WROTE_LAYOUT = false;
    nlPreGen++;
    walkInclShadow(root, (n) => {
      if (n.nodeType === NODE_ELEMENT && n._lb && !written.has(n)) { n._lb = null; n._lbExt = null; n._lbFrags = null; }
    });
  }
  nlOweOrderAndExtents(root, written);
}
// The paint order and the scrollable-overflow extents of the passes committed since they were last stamped, stamped
// when something READS one (`ensureOrderAndExtents`) — the hit test, the painter and the scroll sizes — rather than
// after every pass: a page load lays the page out ten times over for the box sizes its scripts ask, and walking every
// box for its order and its extent each time was more than half of what committing a pass cost, for readers that
// mostly never came. What is owed is the LAST pass's layout (`lastWritten`, the boxes it wrote) and the boxes every pass
// since MOVED (`moved`, gathered): a box one pass moved and the next left alone still has the extent of where it was.
// Only a box the last pass wrote is stamped, so one it did not — removed, or no longer rendered — leaves the set:
// held on to, 2,000 inserted-then-removed rows kept 6,000 detached elements and their boxes alive until a read came.
let NL_ORDER_OWED = null;
function nlOweOrderAndExtents(root, written) {
  const owed = NL_ORDER_OWED;
  if (owed !== null && owed.root !== root) nlStampOwedOrderAndExtents();
  if (NL_ORDER_OWED === null) {
    NL_ORDER_OWED = { root, lastWritten: written, moved: new globalThis.Set(written.moved) };
    return;
  }
  const moved = NL_ORDER_OWED.moved;
  for (const el of moved) if (!written.has(el)) moved.delete(el);
  for (const el of written.moved) moved.add(el);
  NL_ORDER_OWED.lastWritten = written;
}
function nlStampOwedOrderAndExtents() {
  const owed = NL_ORDER_OWED;
  if (owed === null) return;
  NL_ORDER_OWED = null;
  nlStampOrderAndExtents(owed.root, nlLayoutPreorder(owed.root, (c) => owed.lastWritten.has(c)), owed.moved);
}
// The layout brought up to date, its paint order and its extents with it — what a reader of either asks first.
export function ensureOrderAndExtents() {
  ensureLayout();
  nlStampOwedOrderAndExtents();
}
// The pass the RUST walk builds (`__dom.layoutBuild`): its records built in native from the arena and the style engine's
// own values, and laid out there (layout.rs). It answers with the boxes and the fragments, and with what names each box
// to this side beside them — the records' nids, the anonymous cells and items by their container and ordinal, the
// inline table's elements — or the faces it needs first, or the generated boxes it needs linked, or its decline, by
// name.
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
    nlLayoutCalls++;
    answer = d.layoutBuild(root._nid, gen, vp.width, vp.height, painting,
                           globalThis.__csimNativeLayoutVerifyReuse === true);
    // (…a put-back measure that laid out differently, under `CSIM_NL_REUSE_VERIFY`, is a bug to surface, not a pass to
    // decline: a decline would hide it)
    if (typeof answer === 'string' && answer.startsWith('reuse mismatch')) throw new NlReuseMismatch(answer);
    if (typeof answer === 'string') return { ok: false, reason: `rust: ${answer}` };
    // (…a BUILT pass is taken whichever round it comes on; only a fourth request is one too many)
    const built = Array.isArray(answer) && typeof answer[0] !== 'string';
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
  const [fragRows, boxRows, changed, , recNids, anonRows, inlineNids, unchanged, paintRows, paintTexts] = answer;
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
  const nodes = new Array(recNids.length);
  for (let i = 0; i < recNids.length; i++) {
    if (recNids[i] < 0) { nodes[i] = null; continue; }
    nodes[i] = nodeOf(recNids[i]);
    if (nodes[i] === undefined) return { ok: false, reason: 'rust: record without a node' };
  }
  const anon = new globalThis.Map();
  for (let o = 0; o < anonRows.length; o += 4) {
    const el = nlAnonymousBoxOf(nodeOf(anonRows[o + 2]), anonRows[o + 1], anonRows[o + 3]);
    if (!el) return { ok: false, reason: 'rust: anonymous box without its object' };
    anon.set(anonRows[o], el);
  }
  const inlines = new Array(inlineNids.length);
  for (let i = 0; i < inlineNids.length; i++) {
    inlines[i] = nodeOf(inlineNids[i]);
    if (inlines[i] === undefined) return { ok: false, reason: 'rust: inline box without a node' };
  }
  // (…and the text pieces a painting pass asked for: `[x, y, baseline, width, justify, owner nid]` beside each text, as
  // the runs `recordingRuns` hands the painter)
  let paintRuns = null;
  if (painting) {
    paintRuns = [];
    for (let k = 0, i = 0; k < paintRows.length; k += 6, i++) {
      const owner = paintRows[k + 5] >= 0 ? nodeOf(paintRows[k + 5]) : null;
      if (owner === undefined) return { ok: false, reason: 'rust: text run without a node' };
      paintRuns.push({ text: paintTexts[i], x: paintRows[k], y: paintRows[k + 1], baseline: paintRows[k + 2], owner, block: null,
                       width: paintRows[k + 3], justify: paintRows[k + 4], tabFrom: 0, tab: null });
    }
  }
  // (…and the records it built as it built them last pass — kept, for the writer to leave where their box did not move)
  return { ok: true, results: { nodes, inlines, fragRows, boxRows, anon, kept: unchanged, paintRuns, changed, callAt: nlLayoutCalls } };
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
// The JS object an anonymous box of the Rust walk's is: a table's `ordinal`-th anonymous cell in render order (kind 1,
// `tableGrid`'s), or a flex or grid container's `ordinal`-th anonymous item (kind 2, `boxItems`'s) — the objects the JS
// side memoises, and the ones its paint order and hit test walk.
function nlAnonymousBoxOf(container, kind, ordinal) {
  if (!container) return null;
  let n = 0;
  if (kind === 1) {
    for (const row of tableGrid(container).rows) {
      for (const cell of row.cells) if (cell.el._anonCell && n++ === ordinal) return cell.el;
    }
    return null;
  }
  for (const it of boxItems(container)) if (it._anonItem && n++ === ordinal) return it;
  return null;
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
const PSEUDO_KINDS = ['before', 'after'];
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
  // …and never for an ANONYMOUS box: `::before` / `::after` are generated on an ELEMENT (CSS Pseudo-Elements 4
  // §2), and §17.2.1's cell around a table's stray content is not one. It matches `*` like anything else here,
  // so a page carrying a universal `content` rule grew one on the cell as well as on the table — measured,
  // `*::before{content:"XX"}` over `<div style="display:table">stray text</div>` is 134.4 wide here against
  // Chrome's 115.22, two copies against one.
  // …nor is CSS Grid §4's anonymous ITEM, for the same reason and with the same consequence. The `pseudo`
  // sweep carries a `<style>` — one of only two that do — but scopes its rule to `.p`, so nothing in the
  // instrument would have said so: it takes a UNIVERSAL rule, and no page here has one.
  if (!el._pseudo && !el._anonCell && !el._anonItem &&
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
  // Whole NAMES, not substrings: `will-change: transform-origin` names no containing property
  // (Chrome-measured), and `\btransform\b` matched inside it.
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
    if (!p._lb || p === docEl || p.nodeType !== NODE_ELEMENT || displayOf(p) === 'contents') continue;
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
function usedBorderWidth(el, side, cbW, info) {
  const style = declaredValue(el, 'border-' + side + '-style');
  const t = style ? String(style).trim().toLowerCase() : '';
  if (!t || t === 'none' || t === 'hidden') return 0;
  const declared = declaredValue(el, 'border-' + side + '-width');
  if (declared != null) {
    const keyword = BORDER_WIDTH_KEYWORD_PX[String(declared).trim().toLowerCase()];
    if (keyword !== undefined) return keyword;
  }
  const bw = resolveLayoutProp(el, 'border-' + side + '-width', cbW, info);
  // No width at all means the initial `medium`, which is 3px wherever the style paints — and a
  // width that IS given is used at whole-px granularity, the same flooring the computed value
  // reports (a 10pt border makes a 100px box 126px wide in Chrome, not 126.67).
  return bw == null ? BORDER_WIDTH_KEYWORD_PX.medium : usedLineWidthPx(bw);
}

const BORDER_KEY = { top: 'bt', right: 'br', bottom: 'bb', left: 'bl' };

// Memoised per element per pass — and additionally per BASIS, but only for a box
// that actually has a percentage edge. Percentages resolve against `cbW`, so a read
// with no basis at all and one at the box's basis are genuinely different answers for
// such a box, and neither may be served the other's. Almost nothing has one, and those
// boxes keep computing their edges exactly once.
const EDGE_INFO = { percent: false };
function edgeInsets(el, cbW) {
  // The edges the pass laid the box out with, while that layout is the page's (`nlWriteEdges`) — at the basis it used,
  // where an edge resolved a percentage. Else this side's memo: the `_lbEdgeDep` clause catches a collapse cell whose
  // FACING sibling changed without dirtying this cell (see `collapseDepStamp`). Only table cells carry `_lbTable`, so
  // the check is skipped entirely for every other box — the overwhelming majority — and is a no-op (0 === 0) for a
  // separate cell.
  const fromPass = el._lbEdgePass === NL_EDGES_OF_THE_PASS && NATIVE_WROTE_LAYOUT;
  if (fromPass
    ? !el._lbEdgePct || el._lbEdgeCb === cbW
    : memoFresh(el, "_lbEdgePass") && (!el._lbEdgePct || el._lbEdgeCb === cbW) &&
      (!el._lbTable || el._lbEdgeDep === collapseDepStamp(el))) return el._lbEdge;
  const e = { top: 0, right: 0, bottom: 0, left: 0, mt: 0, mr: 0, mb: 0, ml: 0, bt: 0, br: 0, bb: 0, bl: 0,
              autoMargins: 0 };
  // A border-collapse table folds each shared edge into ONE border — as wide as the widest
  // declaration meeting on it — that the two boxes sharing it split down the middle (CSS 2.1
  // §17.6.2). A cell's border therefore depends on which cells it FACES across the grid, and
  // the table keeps no padding and no separate border of its own: its border IS the outer half
  // of its rim cells' collapsed borders. Neither answer is visible to a per-element read: a box the
  // pass laid out keeps the borders it was laid out with (`passBorders` — they do not move with the
  // basis, which is the only thing this read can differ from the pass's in), and for any other
  // `ensureCollapseBorders` resolves them once per table per pass and stamps them for us.
  const mode = collapseMode(el);
  const passBorders = fromPass && mode !== COLLAPSE_NONE ? el._lbEdge : null;
  const cellHalves = mode === COLLAPSE_CELL && !passBorders ? cellCollapseHalves(el) : null;
  // A collapse table with no grid to collapse (a `display:table`/`inline-table` element over bare text, or a
  // caption-only table) has no rim-cell borders to halve — `tableCollapseOuter` returns the NO_OUTER sentinel.
  // Keep the table's OWN declared border (the separate-table path below) so the border box carries it rather
  // than dropping it to zero. (Chrome frames such a table as if an anonymous cell held the inner halves — the
  // box is content + the full border, with clientLeft still the half; the inner-half detail is the anonymous-cell
  // backlog item, but the border box is right this way.)
  const outer = mode === COLLAPSE_TABLE ? tableCollapseOuter(el) : null;
  const tableOuter = outer === NO_OUTER ? null : outer;
  const info = EDGE_INFO;          // not re-entrant: the collapse reads above use their own info
  info.percent = false;
  // One memo entry serves the whole 12-16-property burst below (rule 3: this is the hottest
  // read cluster in a layout pass, and the per-read entry bookkeeping was ~29% of its time).
  for (const side of SIDES) {
    let pad, bw;
    if (tableOuter) {
      pad = 0;                                     // a collapse table has no padding of its own
      bw = passBorders ? passBorders[BORDER_KEY[side]] : tableOuter[side];   // and its border is the edge cells' outer half
    } else {
      // A used padding is never NEGATIVE (§ CSS Box: the property takes a non-negative length, and a `calc()`
      // that computes below zero clamps rather than eating into the box) — measured: a
      // `padding-left: calc(10% - 100px)` block puts its content at x 0 in Chrome, not at −60.
      pad = Math.max(0, resolveLayoutProp(el, 'padding-' + side, cbW, info) || 0);
      if (passBorders) {
        bw = passBorders[BORDER_KEY[side]];
      } else if (cellHalves) {
        bw = cellHalves[BORDER_KEY[side]];         // grid-resolved, already halved
      } else {
        bw = usedBorderWidth(el, side, cbW, info);
        if (mode === COLLAPSE_CELL) {
          // A cell no grid built here holds (`tableGrid` builds one only where this side asks for it — an
          // anonymous cell, a table predicate): its own widest side, halved.
          const facing = usedBorderWidth(el, OPPOSITE_SIDE[side], cbW, info);
          if (facing > bw) bw = facing;
          bw /= 2;
        }
      }
    }
    e[side] = pad + bw;
    e[BORDER_KEY[side]] = bw;   // the border alone — the client box / scroll origin
    // A margin that doesn't RESOLVE is the only one that can be `auto`, so the keyword lookup —
    // which the auto-margin distribution below needs — is paid only there, not on every side of
    // every box. The box model itself reads `auto` as zero, which is what CSS says it is
    // everywhere except the two places that distribute it.
    const m = resolveLayoutProp(el, 'margin-' + side, cbW, info);
    e[MARGIN_KEY[side]] = m || 0;
    if (m == null && marginIsAuto(el, side)) e.autoMargins = (e.autoMargins || 0) | AUTO_MARGIN_BIT[side];
  }
  // (…and a read at another basis than the pass's is answered without replacing the pass's edges, whose borders the
  // next such read takes again)
  if (passBorders) return e;
  el._lbEdge = e;
  el._lbEdgePct = info.percent;
  el._lbEdgeCb = cbW;
  el._lbEdgePass = memoStamp(el);
  // The collapse-resolution generation this edge was computed against — only table cells carry `_lbTable`
  // and only the gate behind `!el._lbTable` reads it, so every other box skips the call (it is 0 == 0 there).
  el._lbEdgeDep = el._lbTable ? collapseDepStamp(el) : 0;
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
// Is this side's margin the `auto` keyword? (`resolveLayoutProp` answers null for
// it, which the box model reads as zero — the distinction only matters here.)
function marginIsAuto(el, side) {
  return declaredValue(el, 'margin-' + side) === 'auto';
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

// The shift the layout folded into a box, remembered on the box's element (the writer stamps it off the
// row). The flow position it moved from is otherwise gone by the time anything reads `_lb`, and the
// scrollable overflow region needs
// it: a relatively-positioned child extends its scroll container's region from where it SITS, but
// the container's end padding follows the position it was laid out at (Chrome: `left: 40px` on a
// 110px child in a `padding: 10px` scroller reports 160 — the shifted edge, with no padding after
// it — while `left: 5px` reports 130, the unshifted edge plus the padding).
//
// Only the writer records it. `relativeOffset` is the CSSOM side of `top` / `left`
// (`computeUsedInsets` asks it for STICKY boxes too, whose shift is never folded into `_lb` at all,
// and against a different containing block), so stamping in there would let a
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
  if (el._anonCell) return 'table-cell';   // an anonymous table box (anonTableCell) IS a cell, by construction
  if (el._anonItem) return 'block';        // …and an anonymous GRID item is the block container §4 wraps a run in
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
// content, no item of its own (`boxItems`, and Chrome and Firefox fold `aa<br>bb` into one item of two lines) — so it
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
  // — no pass does (`anonTableCell` synthesises boxes without rewriting any child's `_parent`), and the pseudo
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
  const f = el._lbFrags;
  if (!f) return el._lb;
  const first = f[0], last = f[f.length - 1];
  return { x: first.x, y: first.y,
           width: last.x + last.width - first.x, height: last.y + last.height - first.y };
}

// Does this element lay its children out as a flex container? The two display values, asked in one
// place because three passes now need the answer: the dispatch, the intrinsic widths, and the
// atomic-inline sizing that shrinks one to fit.
function laysOutAsFlex(el) {
  const d = displayOf(el);
  return d === 'flex' || d === 'inline-flex';
}

// A flex / grid ITEM — an in-flow child whose PARENT BOX lays out as flex or grid (`layoutParent`: a box-less
// `display: contents` parent — a `<slot>` — is looked through, and is no container itself). A real browser BLOCKIFIES
// such a child (CSS Display §2.7: a `display: table-cell` flex item is a block), which is why its
// min/max-height apply where a genuine table cell's are ignored. A FLOATED one is still an item: `float` does not
// apply to a flex or grid item.
function isFlexOrGridItem(el) {
  const pos = positionOf(el);
  if (pos === 'absolute' || pos === 'fixed') return false;
  const p = layoutParent(el);
  if (!p || p.nodeType !== NODE_ELEMENT) return false;
  if (laysOutAsFlex(p)) return true;
  const pd = displayOf(p);
  return pd === 'grid' || pd === 'inline-grid';
}

// A flex container's axes, as its scroll origin asks them (`computeScrollOriginSides`): the physical edge its main axis
// starts from, and whether its cross axis runs from the far physical edge back (`crossFar`). Resolved through its flow:
// `flowSides` turns `writing-mode` / `direction` into physical sides, so `row` is the inline axis whichever way that
// runs — vertical in a vertical writing mode, right-to-left in an RTL one — and `column` is the block axis. `-reverse`
// takes the far edge of its axis (Chrome puts two 100px items in a 400px `row-reverse` at 300 and 200, not 100 and 0),
// and `wrap-reverse` does the same to the cross one — absent from nearly every page, which is what `declaresLayoutProp`
// answers in O(1) (rule 3).
function flexAxisPlan(el) {
  const sides = flowSides(el);
  const direction = String(declaredValue(el, 'flex-direction') || 'row').trim().toLowerCase();
  const wrapReverse = declaresLayoutProp(el, 'flex-wrap') &&
    String(declaredValue(el, 'flex-wrap')).trim().toLowerCase() === 'wrap-reverse';
  const blockMain = direction.startsWith('column');
  const reverse   = direction.endsWith('-reverse');
  const mainStart  = sides[blockMain ? (reverse ? 'block-end' : 'block-start') : (reverse ? 'inline-end' : 'inline-start')];
  const crossStart = sides[blockMain ? (wrapReverse ? 'inline-end' : 'inline-start') : (wrapReverse ? 'block-end' : 'block-start')];
  return { mainStart, mainIsX: mainStart === 'left' || mainStart === 'right',
           crossFar: crossStart === 'right' || crossStart === 'bottom' };
}

// Could this element have a value for a property almost no page declares — `order` / `flex-wrap` are absent from nearly
// every page that has flex on it at all?
function declaresLayoutProp(el, prop) {
  // An anonymous box declares nothing: no selector names it (CSS Display §2.3), and it has no style attribute.
  if (el._anonCell || el._anonItem) return false;
  // Whether the value the engine computed is anything but the initial one: a gate that answers false only where the
  // property has nothing to do, and true exactly where it may.
  const v = engineValue(el, prop);
  return v !== undefined && v !== INITIAL_VALUES[prop];
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
      if (n.nodeType !== NODE_ELEMENT || !n._lb || (n._tag !== 'textarea' && n._tag !== 'input' && n._tag !== 'select')) return;
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

// The scrollable overflow region, stamped once per layout (`nlStampOrderAndExtents`, bottom-up, where
// a box can have moved) instead of walked per read: every element gets its own box unioned with its
// children's regions on all four edges, and — separately — the union of its IN-FLOW children's margin
// boxes, which is the half `contentExtent` extends by this box's own end padding. scrollWidth /
// scrollHeight are read constantly by editors and virtualised lists (a code editor measures on every
// keystroke), and a per-read subtree walk turns that into O(document) per call.
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
  // …and restricted to BOXES: a fragmented inline box or a `<br>` is a piece of its lines, not a box that
  // reaches anywhere of its own, so it adds only what it holds (an atomic inside it). Its fragments' union
  // reaches wherever an overflowing word or a relative shift took its text, and growing a wrapping flex
  // container to that was not Chrome (30 wide around a 30px item holding a long word in a `<span>`, where
  // this made 85).
  const flows = !isLineBreak(el) && !(displayOf(el) === 'inline' && !intrinsicSize(el));
  let fRight = flows ? right : -Infinity, fBottom = flows ? bottom : -Infinity;
  // The in-flow children's MARGIN boxes, which is the half of the region the box's own END padding
  // extends (css-overflow-3 §3.2, Chrome-measured): a `padding: 10px` scroller holding a 110px
  // child reports 130, and the same child's 7px margins make it 144. Overflow that PROPAGATED from
  // deeper down is not extended — a 10px-wide child holding a 160px grandchild reports 170, not
  // 180 — so this is the direct children's own boxes, not their extents.
  let iLeft = Infinity, iTop = Infinity, iRight = -Infinity, iBottom = -Infinity;
  // The children's reach WITHOUT the border-box seed above — what `contentExtent` measures the
  // scroll region against, so a box in the border region (a table caption, a negative margin) is
  // seen as overflow past the padding box rather than lost behind the seed.
  let cLeft = Infinity, cTop = Infinity, cRight = -Infinity, cBottom = -Infinity;
  // …a GRID's items, not its raw children: an anonymous item (§4) is where a run of bare text has its box, and
  // the raw list yields the text NODE, which has none — and a subtree skipped here reports a scroller
  // UNSCROLLABLE with nothing to show for it. Measured: a 60px `overflow: auto` box holding a
  // grid with a 200px track and a bare run in it reported `scrollWidth` 60 on the raw list, 200 on this one,
  // and Chrome says 200.
  for (const child of (laidOutBoxItems(el) || layoutChildren(el))) {
    // An unrendered BODY's box and extent are no content of the root's: Chrome reports a `body { display: none }` page
    // one viewport tall.
    if (child === globalThis.document.body && !isLaidOutNode(child)) continue;
    // A FIXED box is anchored to the viewport, so it is not scrollable content of anything: Chrome
    // reports a page holding one at `top: 900px` as exactly one viewport tall, before and after
    // it appears.
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
    const clip = clipFlags(child);
    if (clip & (NL_CLIP_X | NL_CLIP_Y)) {
      const own = child._lb, cx = clip & NL_CLIP_X, cy = clip & NL_CLIP_Y;
      ce = extentRecord(
        cx ? own.x              : (ce ? ce.left   : own.x),
        cy ? own.y              : (ce ? ce.top    : own.y),
        cx ? own.x + own.width  : (ce ? ce.right  : own.x + own.width),
        cy ? own.y + own.height : (ce ? ce.bottom : own.y + own.height));
    }
    if (!ce) continue;
    if (ce.left   < left)    left    = ce.left;
    if (ce.top    < top)     top     = ce.top;
    if (ce.right  > right)   right   = ce.right;
    if (ce.bottom > bottom)  bottom  = ce.bottom;
    if (ce.left   < cLeft)   cLeft   = ce.left;
    if (ce.top    < cTop)    cTop    = ce.top;
    if (ce.right  > cRight)  cRight  = ce.right;
    if (ce.bottom > cBottom) cBottom = ce.bottom;
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
    // own box). Skipping them is also what keeps this off `edgeInsets`' slow path: the pass writes no
    // edges for either (`nlWriteEdges`).
    const m = marginBoxApplies(child) ? insetsOf(child) : null;
    // …at the position the FLOW gave it: the box holds any relative shift it took (`_lbRel`,
    // `flowShift`), and that shift takes no padding after it.
    const rel = memoFresh(child, '_lbRelPass') ? child._lbRel : null;
    const cx = rel ? cb.x - rel.x : cb.x, cy = rel ? cb.y - rel.y : cb.y;
    const ml = m ? m.ml : 0, mt = m ? m.mt : 0, mr = m ? m.mr : 0, mb = m ? m.mb : 0;
    if (cx - ml               < iLeft)   iLeft   = cx - ml;
    if (cy - mt               < iTop)    iTop    = cy - mt;
    if (cx + cb.width  + mr   > iRight)  iRight  = cx + cb.width  + mr;
    if (cy + cb.height + mb   > iBottom) iBottom = cy + cb.height + mb;
  }
  el._lbExt        = extentRecord(left, top, right, bottom, iLeft, iTop, iRight, iBottom, cLeft, cTop, cRight, cBottom);
  // The FLOW extent is two numbers on the element rather than a record of its own: it is read in
  // this same loop, and a second object per box per pass both allocated and gave that read a
  // second hidden class to dispatch on.
  el._lbFlowRight  = fRight;
  el._lbFlowBottom = fBottom;
}

// Does this box have a margin box for the region to union? Margins do not apply to a table's
// internal boxes, and a `<br>` is a forced break rather than a box that could carry one.
function marginBoxApplies(el) {
  return !isLineBreak(el) && !TABLE_INTERNAL_DISPLAY.has(displayOf(el));
}

// ONE shape for every extent record, so the reads in `stampExtent`'s loop stay monomorphic: the
// clipping branch builds one too, and a second key set there cost that loop a second hidden class
// on every property it touches. `c*` is the same union WITHOUT the element's own border-box seed —
// the reach of its real descendants alone, which `contentExtent` measures the scrollable region
// against (a table CAPTION sits in the border region, outside the padding box: the seeded union
// can't tell it from the seed, this one can).
function extentRecord(left, top, right, bottom, iLeft = Infinity, iTop = Infinity,
                      iRight = -Infinity, iBottom = -Infinity,
                      cLeft = Infinity, cTop = Infinity, cRight = -Infinity, cBottom = -Infinity) {
  return { left, top, right, bottom, iLeft, iTop, iRight, iBottom, cLeft, cTop, cRight, cBottom };
}

// An ANONYMOUS ITEM (CSS Grid §4, CSS Flexbox §4 — the same sentence in both): the box a grid or flex container
// wraps a contiguous sequence of its child text runs in. It is no part of the DOM — no `_nid`, no tag, no
// attributes — so it matches no selector and inherits everything from the container, which is exactly what §4 asks
// of it. `anonTableCell` is the same object one spec over, and the two are deliberately spelled alike.
function anonBoxItem(grid, nodes) {
  return {
    nodeType: NODE_ELEMENT, _anonItem: true,
    _tag: '', _parent: grid, _attrs: {}, _children: nodes,
    _shadowRoot: null, _isShadowRoot: false, _pseudo: undefined, _lb: null,
    get ownerDocument() { return grid.ownerDocument; },
    get isConnected() { return grid.isConnected; }
  };
}
// The children a GRID or a FLEX container lays out: `layoutChildren` with every contiguous run of text wrapped in one
// of those boxes — the list the pass names its anonymous items in (`nlAnonymousBoxOf`) and the readers walk (the paint
// order, the extents). A list that SKIPPED the runs would hand the item after one the column the run takes.
//
// What groups and what breaks, all of it MEASURED against Chrome 153 rather than read off §4's sentence — in a grid, and
// the same again in a flex container (`A <b>B</b> C` is three items, `a<br>b` one item two lines tall, a run of white
// space none):
//   • text nodes group, and an element between two of them splits the sequence in three —
//     `a<span>b</span>c` is THREE items, `a <span>s</span> b` likewise (the spaces ride the text they touch).
//   • `<br>` and `<wbr>` group WITH the text instead of becoming items of their own, which is the one place
//     the sentence does not predict Chrome: `a<br>b` in a one-column grid is 1 column wide and 2 lines tall
//     (one item), where `a<span>b</span>` is 1 column and 2 ROWS (two items). A lone `<br>` is still an item.
//   • a COMMENT and a `display: none` element are transparent — they neither join a run nor break one
//     (`a<!--x-->b` and `a<span style="display:none">x</span>b` are ONE item each).
//   • …and the `<br>` rule is about the TAG, not about its used display: `display: block`, `float: left` and
//     `position: absolute` on the `<br>` all still leave `a<br>b` ONE item in Chrome. Measured, because the
//     obvious theory (Blink makes a LayoutBR only at `display: inline`, so a blockified one would be an item
//     of its own) predicts the opposite and is wrong here. Do not add a display test to this line.
//   • an OUT-OF-FLOW element breaks the sequence though it is no item itself: `a<span style="position:
//     absolute">x</span>b` is two items, two rows.
//   • a sequence of nothing but white space makes NO item — §4 leaves it unrendered whatever the
//     `white-space` mode says, so a `pre` grid of ten spaces is 0 wide and not 40.
// Memoised on the PASS stamp (`memoStamp`), NOT on the structure stamp `tableGrid` uses, and the difference
// is the whole of what decides whether an item exists: **whether a run is content is a question about its
// TEXT**, and a `characterData` edit is not a structural change (`markLayoutDirty(target)` with no
// `structural`, so `_lbStruct` does not move). Measured on the structure stamp: a grid whose first child was
// `'   '` and became `'xx'` kept the memo that said there was no item, so the box beside it stayed in column
// 0 where Chrome moves it to column 1. `markLayoutDirty` walks UP the flat tree stamping `_lbDirty`, so the grid's own
// pass stamp
// moves for an edit anywhere under it, which is exactly the invalidation this needs.
// The objects are stable for every caller WITHIN a pass; a READER between passes gets `laidOutBoxItems`, which never
// builds.
// …and the form a READER asks. `boxItems` builds, and building at read time mints anonymous items with no `_lb` while
// the laid-out ones are orphaned, so a reader gets the memo or nothing, and falls back to the raw list. It also drops
// an item with no `_lb`: one the pass named no box for leaves the stamp fresh over a boxless item.
function laidOutBoxItems(el) {
  if (!(laysOutAsGrid(el) || laysOutAsFlex(el)) || !memoFresh(el, '_lbItemsPass') || !el._lbItems) return null;
  return el._lbItems.some((it) => it._anonItem && !it._lb)
    ? el._lbItems.filter((it) => !it._anonItem || it._lb)
    : el._lbItems;
}
function boxItems(el) {
  if (memoFresh(el, '_lbItemsPass')) return el._lbItems;
  const out = [];
  let run = null;
  const flush = () => {
    // …`some`, not a test of the whole: an element in the run (a `<br>`) is content however much white space
    // surrounds it, and `CSS_CONTENT_RE` is the file's one definition of "is this text content" (NOT
    // `String#trim`, which would drop an NBSP).
    if (run && run.some((c) => c.nodeType === NODE_ELEMENT || CSS_CONTENT_RE.test(c._data || ''))) {
      out.push(anonBoxItem(el, run));
    }
    run = null;
  };
  for (const c of layoutChildren(el)) {
    if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) { (run || (run = [])).push(c); continue; }
    if (c.nodeType === NODE_ELEMENT && (isLineBreak(c) || c._tag === 'wbr') && !selfNotRendered(c)) {
      (run || (run = [])).push(c);
      continue;
    }
    if (boxlessChild(c)) continue;                         // a comment / a `display: none` element: transparent
    flush();
    out.push(c);
  }
  flush();
  el._lbItemsPass = memoStamp(el);
  return (el._lbItems = out);
}

// ── Tables ───────────────────────────────────────────────────────────────────
// What this side needs of a table's STRUCTURE — the layout itself is layout.rs's (CSS Tables 3, the column algorithm
// pinned to Chrome-measured figures in `spec/layout_table_spec.rb`): the grid of rows and cells (`tableGrid`), the
// anonymous cells the pass names by ordinal (`nlAnonymousBoxOf`), and the collapsed borders an edge read resolves
// (`ensureCollapseBorders`).
const ROW_GROUP_DISPLAY = new globalThis.Set(['table-row-group', 'table-header-group', 'table-footer-group']);

const TABLE_INTERNAL_DISPLAY = new globalThis.Set([
  'table-row', 'table-row-group', 'table-header-group', 'table-footer-group',
  'table-cell', 'table-column', 'table-column-group'
]);
function isTableDisplay(d) { return d === 'table' || d === 'inline-table'; }

// Both properties INHERIT, and both have a UA value keyed on the `table` TAG that
// outranks what a wrapper hands down — so they are read through style-proxy's
// resolver, the one getComputedStyle uses, rather than through a walk of our own.
// (Chrome-verified: a `<table>` inside `div { border-spacing: 10px }` still spaces
// at 2px, while a `display: table` div inherits the 10px.)
function tableCollapses(el) {
  return computedBorderCollapse(el) === 'collapse';
}

// How the collapsing border model (CSS 2.1 §17.6) touches one box's edges:
//   CELL  — each border is SHARED with the cell it faces; the two split it down the middle.
//   TABLE — the table keeps no padding and no border of its own; its border IS the outer
//           half of its rim cells' collapsed borders (the inner half lives in the cells).
// `edgeInsets` asks this of every box in a layout pass, so it is memoised and kept to one
// `displayOf` + one ancestor-walking `tableCollapses`.
const COLLAPSE_NONE = 0, COLLAPSE_CELL = 1, COLLAPSE_TABLE = 2;
function collapseMode(el) {
  // An anonymous cell carries no cascade (border-collapse would read `separate`), so it takes its
  // table's mode from the flag set when it was built — a COLLAPSE_CELL with zero own borders, which
  // is how it ends up holding the inner half of the table's rim border.
  if (el._anonCell) return el._anonCollapse ? COLLAPSE_CELL : COLLAPSE_NONE;
  if (memoFresh(el, '_lbCollapseModePass')) return el._lbCollapseMode;
  el._lbCollapseModePass = memoStamp(el);
  const d = displayOf(el);
  // An `inline-table` collapses exactly like a `table` (§17.6 is indifferent to the table's outer display) —
  // its own border is likewise the outer half of its rim cells' collapsed borders.
  el._lbCollapseMode = (d === 'table-cell' || isTableDisplay(d)) && tableCollapses(el)
    ? (isTableDisplay(d) ? COLLAPSE_TABLE : COLLAPSE_CELL)
    : COLLAPSE_NONE;
  return el._lbCollapseMode;
}
// This cell's four collapsed half-borders (`bt`/`br`/`bb`/`bl`), grid-resolved by
// `ensureCollapseBorders`, or null when no grid built here holds the cell (`tableGrid` stamps `_lbTable`).
function cellCollapseHalves(cell) {
  const table = cell._lbTable;
  if (!table) return null;
  ensureCollapseBorders(table);
  return cell._lbCollapse || null;
}
// The outer half of each rim's collapsed border — the collapse table's own border.
const NO_OUTER = { left: 0, right: 0, top: 0, bottom: 0 };
function tableCollapseOuter(table) {
  ensureCollapseBorders(table);
  return table._lbCollapseOuter || NO_OUTER;
}
// Resolve every collapsed border of a table ONCE per pass and stamp it on the cells (and the
// table), so the per-element `edgeInsets` can read a grid-aware answer it could never compute
// alone: a cell's edge is as wide as the WIDEST border meeting on it — its own, its facing
// neighbour's, or, at the rim, the table's — and the two boxes sharing that edge own half each.
// [Chrome-measured: td{border-left:2;border-right:10} beside td{border-left:6;border-right:4}
// makes the first cell 66 wide (60 + 1 + 5), not the 72 a per-cell max-of-own-sides gives; around
// border:2 cells a border:4 table insets the first cell by max(4,2)/2 = 2px, not the full 4 (the
// same 2px Chrome reports as the table's clientLeft).]
const COLLAPSE_EDGE_INFO = { percent: false };
// One side's collapsed-border contribution: its used width, or the sentinel -1 when the side is
// `border-style: hidden`. In the collapsing model `hidden` has the HIGHEST priority and SUPPRESSES the
// whole shared edge (width 0), beating any wider neighbour (CSS 2.1 §17.6.2.1); `none` is lowest and
// simply contributes 0. (The style / element-type tiebreaks below width only pick the painted colour,
// which layout does not model, so they don't enter the geometry.)
function collapseSideW(el, side) {
  const style = declaredValue(el, 'border-' + side + '-style');
  const s = style ? String(style).trim().toLowerCase() : '';
  if (s === 'hidden') return -1;
  if (!s || s === 'none') return 0;   // no border paints, so no width to read — the common (borderless) side
  return usedBorderWidth(el, side, 0, COLLAPSE_EDGE_INFO);
}
// Combine two contributions meeting on one edge: a `hidden` (-1) on EITHER side wins and suppresses the
// edge (result -1); otherwise the wider wins. `halfOf` is the half-border a box owns (0 for a suppressed edge).
function combineW(a, b) { return a < 0 || b < 0 ? -1 : (a > b ? a : b); }
function halfOf(w) { return w < 0 ? 0 : w / 2; }
function ensureCollapseBorders(table) {
  if (memoFresh(table, '_lbCollapsePass')) return;
  table._lbCollapsePass = memoStamp(table);
  if (!tableCollapses(table)) { table._lbCollapseOuter = null; return; }
  const grid = tableGrid(table);
  const n = grid.colCount, rowCount = grid.rows.length;
  if (!n || !rowCount) { table._lbCollapseOuter = null; return; }
  // The columns run right-to-left in an rtl table (§17): logical column 0 is at the physical RIGHT, so the
  // table's physical `border-left` collapses with the HIGHEST-index column and its `border-right` with column 0
  // — the outer left/right rim (and each internal cell's physical-left/right neighbour) is mirrored. Cell / row
  // borders stay physical, so only the column-index bookkeeping for a vertical edge flips (§17.6.2).
  const rtl = flowSides(table).rtl;
  // This runs EVERY pass on a table of potentially hundreds of cells (rule 3), so it allocates
  // almost nothing: each cell's raw (pre-collapse) border widths go on the persistent grid-cell
  // object as scalars (no Map, no per-cell object), the occupant grid is ONE flat array, and the
  // per-cell result object is REUSED across passes.
  const tbT = collapseSideW(table, 'top');
  const tbR = collapseSideW(table, 'right');
  const tbB = collapseSideW(table, 'bottom');
  const tbL = collapseSideW(table, 'left');
  // occ[r * n + c] = the cell covering that slot (a span fills every slot it covers), so a cell can
  // find the cell(s) it faces across each edge.
  const occ = new Array(rowCount * n).fill(null);
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      const el = cell.el;
      cell._rbT = collapseSideW(el, 'top');
      cell._rbR = collapseSideW(el, 'right');
      cell._rbB = collapseSideW(el, 'bottom');
      cell._rbL = collapseSideW(el, 'left');
      for (let dr = 0; dr < cell.rowSpan && cell.row + dr < rowCount; dr++) {
        const base = (cell.row + dr) * n;
        for (let dc = 0; dc < cell.colSpan && cell.col + dc < n; dc++) occ[base + cell.col + dc] = cell;
      }
    }
  }
  // Structural borders participate in the collapse too (§17.6.2.1): a tr / row-group / col / colgroup border
  // meets the cells on a grid line and the WIDEST (or any `hidden`) wins, exactly as two cells do. Read them
  // into per-index arrays — 0 where absent — so the resolution folds them with combineW as a no-op for the
  // common cells-only table. (Cheap: O(rows+groups+cols), and a borderless side is a style-only lookup.) A row
  // border is a HORIZONTAL edge (its left/right reach only the table's outer rim); a column border a VERTICAL
  // one (its top/bottom reach only the outer rim); a row-group's top/bottom apply at its first/last row.
  const rowT = new Array(rowCount).fill(0), rowB = new Array(rowCount).fill(0),
        rowL = new Array(rowCount).fill(0), rowR = new Array(rowCount).fill(0),
        grpTopAt = new Array(rowCount).fill(0), grpBotAt = new Array(rowCount).fill(0),
        grpL = new Array(rowCount).fill(0), grpR = new Array(rowCount).fill(0);
  grid.rows.forEach((row, r) => {
    if (!row.el) return;
    rowT[r] = collapseSideW(row.el, 'top'); rowB[r] = collapseSideW(row.el, 'bottom');
    rowL[r] = collapseSideW(row.el, 'left'); rowR[r] = collapseSideW(row.el, 'right');
  });
  // A group's borders are read ONCE and spread over its rows (its left/right apply to every row at the table's
  // outer rim; its top/bottom only at its first/last row) — not re-read per row.
  for (const g of grid.groups) {
    if (!g.el || g.first < 0) continue;
    const gl = collapseSideW(g.el, 'left'), gr = collapseSideW(g.el, 'right');
    for (let r = g.first; r <= g.last; r++) { grpL[r] = gl; grpR[r] = gr; }
    grpTopAt[g.first] = collapseSideW(g.el, 'top');
    grpBotAt[g.last] = collapseSideW(g.el, 'bottom');
  }
  const colT = new Array(n).fill(0), colB = new Array(n).fill(0), colL = new Array(n).fill(0), colR = new Array(n).fill(0);
  // Each column ELEMENT's starting column index (a `<col span=N>` covers N), so a `<colgroup>` with `<col>`
  // children can recover the index range its own border collapses across.
  const colStart = new Map();
  let cIdx = 0;
  for (const col of grid.columns) {
    colStart.set(col, cIdx);
    const span = spanAttr(col, 'span');
    // A <col span=N> is N column BOXES, each carrying the whole border (Chrome renders it byte-identically to N
    // separate <col>s), so its left/right reach EVERY column it covers — the internal grid lines inside the span
    // included. A childless <colgroup span=N> is ONE box, so its left/right land only at the span's OUTER rim.
    // Either way top/bottom reach every covered column. Folded with combineW so overlaps and `hidden` win.
    const group = displayOf(col) === 'table-column-group';
    const cl = collapseSideW(col, 'left'), cr = collapseSideW(col, 'right'),
          ct = collapseSideW(col, 'top'), cb = collapseSideW(col, 'bottom');
    for (let i = 0; i < span && cIdx + i < n; i++) {
      if (!group || i === (rtl ? span - 1 : 0)) colL[cIdx + i] = combineW(colL[cIdx + i], cl);
      if (!group || i === (rtl ? 0 : span - 1)) colR[cIdx + i] = combineW(colR[cIdx + i], cr);
      colT[cIdx + i] = combineW(colT[cIdx + i], ct);
      colB[cIdx + i] = combineW(colB[cIdx + i], cb);
    }
    cIdx += span;
  }
  // A `<colgroup>` that defines its columns through `<col>` children still contributes its OWN border at the
  // group's outer rim: its left/right on the group's physical-left / -right column (mirrored under rtl, like a
  // childless colgroup above), its top/bottom on every column it spans.
  for (const cg of grid.columnGroups) {
    const first = colStart.get(cg.cols[0]);
    const lastCol = cg.cols[cg.cols.length - 1];
    const last = colStart.get(lastCol) + spanAttr(lastCol, 'span') - 1;
    if (first == null || last >= n) continue;
    const gl = collapseSideW(cg.el, 'left'), gr = collapseSideW(cg.el, 'right'),
          gt = collapseSideW(cg.el, 'top'), gb = collapseSideW(cg.el, 'bottom');
    colL[rtl ? last : first] = combineW(colL[rtl ? last : first], gl);
    colR[rtl ? first : last] = combineW(colR[rtl ? first : last], gr);
    for (let c = first; c <= last; c++) {
      colT[c] = combineW(colT[c], gt);
      colB[c] = combineW(colB[c], gb);
    }
  }
  // This cell's half-border on an INTERNAL edge, which a spanning cell can share with SEVERAL others. Each
  // facing cell is its own SEGMENT, collapsed independently against this cell's own side (`own`) and the
  // uniform `extra` borders on that grid line (the columns for a vertical edge; the rows / row-group boundary
  // for a horizontal one) — so a `hidden` on ONE of them suppresses only ITS segment (§17.6.2.1), not the
  // cell's whole edge, and the cell's box owns the widest surviving half. A ragged gap faces a 0-width border.
  const faceRows = (own, extra, r0, rs, col, prop) => {
    const seed = combineW(own, extra);
    let h = 0;
    for (let dr = 0; dr < rs && r0 + dr < rowCount; dr++) {
      const nb = occ[(r0 + dr) * n + col];
      const seg = halfOf(combineW(seed, nb ? nb[prop] : 0));
      if (seg > h) h = seg;
    }
    return h;
  };
  const faceCols = (own, extra, c0, cs, row, prop) => {
    const seed = combineW(own, extra);
    let h = 0;
    const base = row * n;
    for (let dc = 0; dc < cs && c0 + dc < n; dc++) {
      const nb = occ[base + c0 + dc];
      const seg = halfOf(combineW(seed, nb ? nb[prop] : 0));
      if (seg > h) h = seg;
    }
    return h;
  };
  // This cell's half-border on an OUTER edge: the table's own side, the outermost column/row border, and — per
  // the rows it spans (left/right) or the cols it spans (top/bottom) — that track's own border and its
  // row-group's; widest surviving half wins.
  const outerV = (own, tbSide, colSide, r0, rs, rowArr, grpArr) => {
    const seed = combineW(combineW(own, tbSide), colSide);
    let h = 0;
    for (let dr = 0; dr < rs && r0 + dr < rowCount; dr++) {
      const seg = halfOf(combineW(combineW(seed, rowArr[r0 + dr]), grpArr[r0 + dr]));
      if (seg > h) h = seg;
    }
    return h;
  };
  const outerH = (own, tbSide, rowSide, grpSide, c0, cs, colArr) => {
    const seed = combineW(combineW(combineW(own, tbSide), rowSide), grpSide);
    let h = 0;
    for (let dc = 0; dc < cs && c0 + dc < n; dc++) {
      const seg = halfOf(combineW(seed, colArr[c0 + dc]));
      if (seg > h) h = seg;
    }
    return h;
  };
  // Track whether any resolved half-border actually MOVED since last pass. `_lbCollapseGen` advances only
  // then — so `collapseDepStamp` re-lays-out the facing cells on a real BORDER change, but a table mutation
  // that leaves the borders alone (a row's background, a cell's text — the common case) costs nothing. The
  // cell whose OWN style changed re-lays-out regardless, off its own memoStamp; the gen is only for its
  // unchanged siblings.
  let changed = false;
  // The table's OWN border is the widest outer half surviving on each rim — the MAX over the rim cells of
  // their already-resolved half (which folds in the table's own border via the `atLeft ? tbL` branch below).
  // It must NOT be seeded with the table's half as a floor: a rim cell whose outer edge is `hidden` resolves
  // to 0 and has to be able to zero the table's border there too (§17.6.2.1). A rim no cell covers (never, in
  // a gridded table) simply stays 0.
  let outT = 0, outR = 0, outB = 0, outL = 0;
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      // Which cells sit at the PHYSICAL left / right rim: logical column 0 in ltr, the highest-index column in
      // rtl (and vice-versa). The physical-left half collapses at the left rim with the table's own left border
      // and the physically-leftmost column's left border; an internal one meets the neighbour across that edge.
      const atLeft = rtl ? cell.col + cell.colSpan >= n : cell.col === 0;
      const atRight = rtl ? cell.col === 0 : cell.col + cell.colSpan >= n;
      const atTop = cell.row === 0, atBottom = cell.row + cell.rowSpan >= rowCount;
      const rLast = cell.row + cell.rowSpan - 1, cLast = cell.col + cell.colSpan - 1;
      // An OUTER edge collapses with the table's own side + the outer column/row track (per spanned row or
      // col); an INTERNAL edge is resolved per facing cell, folding in the columns it crosses (vertical) or the
      // rows / row-group boundary (horizontal). A vertical edge's neighbour column is one PAST the span on the
      // physical side: to the left that is `cLast + 1` in rtl (higher index) but `col - 1` in ltr.
      const bl = atLeft
        ? outerV(cell._rbL, tbL, rtl ? colL[n - 1] : colL[0], cell.row, cell.rowSpan, rowL, grpL)
        : rtl
          ? faceRows(cell._rbL, combineW(colR[cLast + 1], colL[cLast]), cell.row, cell.rowSpan, cLast + 1, '_rbR')
          : faceRows(cell._rbL, combineW(colR[cell.col - 1], colL[cell.col]), cell.row, cell.rowSpan, cell.col - 1, '_rbR');
      const br = atRight
        ? outerV(cell._rbR, tbR, rtl ? colR[0] : colR[n - 1], cell.row, cell.rowSpan, rowR, grpR)
        : rtl
          ? faceRows(cell._rbR, combineW(colR[cell.col], colL[cell.col - 1]), cell.row, cell.rowSpan, cell.col - 1, '_rbL')
          : faceRows(cell._rbR, combineW(colR[cLast], colL[cell.col + cell.colSpan]), cell.row, cell.rowSpan, cell.col + cell.colSpan, '_rbL');
      const bt = atTop
        ? outerH(cell._rbT, tbT, rowT[cell.row], grpTopAt[cell.row], cell.col, cell.colSpan, colT)
        : faceCols(cell._rbT, combineW(combineW(rowB[cell.row - 1], rowT[cell.row]), combineW(grpBotAt[cell.row - 1], grpTopAt[cell.row])), cell.col, cell.colSpan, cell.row - 1, '_rbB');
      const bb = atBottom
        ? outerH(cell._rbB, tbB, rowB[rLast], grpBotAt[rLast], cell.col, cell.colSpan, colB)
        : faceCols(cell._rbB, combineW(combineW(rowB[rLast], rowT[cell.row + cell.rowSpan]), combineW(grpBotAt[rLast], grpTopAt[cell.row + cell.rowSpan])), cell.col, cell.colSpan, cell.row + cell.rowSpan, '_rbT');
      const cb = cell.el._lbCollapse;
      if (!cb) { cell.el._lbCollapse = { bt, br, bb, bl }; changed = true; }
      else {
        if (cb.bl !== bl || cb.br !== br || cb.bt !== bt || cb.bb !== bb) changed = true;
        cb.bl = bl; cb.br = br; cb.bt = bt; cb.bb = bb;
      }
      if (atLeft   && bl > outL) outL = bl;
      if (atRight  && br > outR) outR = br;
      if (atTop    && bt > outT) outT = bt;
      if (atBottom && bb > outB) outB = bb;
    }
  }
  const o = table._lbCollapseOuter;
  if (!o) { table._lbCollapseOuter = { top: outT, right: outR, bottom: outB, left: outL }; changed = true; }
  else {
    if (o.top !== outT || o.right !== outR || o.bottom !== outB || o.left !== outL) changed = true;
    o.top = outT; o.right = outR; o.bottom = outB; o.left = outL;
  }
  if (changed) table._lbCollapseGen = (table._lbCollapseGen || 0) + 1;
}

// An ANONYMOUS table-cell (§17.2.1) wrapping a run of stray content — text and non-table boxes a
// browser cannot leave loose in a table. It is not an element: it matches no selector and carries no
// declaration (`declaredValue` returns null for it, so every property is its initial value — zero border and
// padding), its `display` is forced in `displayOf` and its collapse
// participation flagged here, and it lays its run out as its own block-flow content — so an in-flow
// `%`-sized descendant resolves against THIS box, which lays it out (Chrome: a `height: 50%` block in a 77px
// anonymous row is 38.5). The run keeps its real DOM parent, though, so a POSITIONED descendant's containing
// block is still found through the table (a bounded-scope gap); a MIXED inline+block run needs anonymous
// BLOCKS we don't model either. The common runs — all-inline (text) or all-block — lay out correctly.
function anonTableCell(table, nodes) {
  return {
    nodeType: NODE_ELEMENT, _anonCell: true, _anonCollapse: tableCollapses(table),
    _tag: '', _parent: table, _attrs: {}, _children: nodes,
    _shadowRoot: null, _isShadowRoot: false, _pseudo: undefined, _lb: null,
    // What it holds changing moves its stamp (`memoStamp`): the cell is in no DOM, so no mutation marks it, but every
    // mutation under its content marks the content's PARENTS (the row or table, or a `display: contents` element in
    // between). Kept by the table's STRUCTURE stamp alone, the cell would answer a memo — and the paint order a kept
    // segment — with the text it held before an edit (a row's stray span growing 20 times longer left the table 17.1
    // wide).
    get _lbDirty() {
      let d = 0;
      for (const n of nodes) { const v = (n._parent && n._parent._lbDirty) || 0; if (v > d) d = v; }
      return d;
    },
    get ownerDocument() { return table.ownerDocument; },
    get isConnected() { return table.isConnected; }
  };
}
// The cell grid: rows in RENDER order (a header group first and a footer group last,
// whatever the source says — Chrome), each cell at the first column its row still has
// free, so a `rowspan` from an earlier row pushes the cells beside it right.
function tableGrid(table) {
  if (structFresh(table, '_lbGridPass')) return table._lbGrid;
  const rows = [], groups = [], captions = [], columns = [], columnGroups = [], outOfFlow = [];
  // A real table-row's OWN children go through the same anonymous-cell run-grouping below (§17.2.1 applies to
  // a row exactly as to the table): its stray non-cell content must be WRAPPED in an anonymous cell, not
  // dropped. So gather the row's in-flow rendered children here (whitespace discarded, out-of-flow diverted)
  // rather than leaving `nodes` null for placeCells to filter down to only its table-cells.
  const rowContent = (rowEl) => {
    const out = [];
    for (const c of layoutChildren(rowEl)) {
      if (c.nodeType === NODE_TEXT || c.nodeType === NODE_CDATA) { if ((c._data || '').trim() !== '') out.push(c); continue; }
      if (boxlessChild(c)) continue;
      const p = positionOf(c);
      if (p === 'absolute' || p === 'fixed') { outOfFlow.push({ el: c, pos: p }); continue; }
      out.push(c);
    }
    return out;
  };
  const collect = (parent, group) => {
    let anon = null;
    for (const child of layoutChildren(parent)) {
      // Stray non-whitespace TEXT is anonymous-cell content (§17.2.1) — a browser wraps it in an
      // anonymous cell; whitespace BETWEEN table parts is discarded (it generates no box).
      if (child.nodeType === NODE_TEXT || child.nodeType === NODE_CDATA) {
        if ((child._data || '').trim() === '') continue;
        if (!anon) { anon = { el: null, group, cells: [], nodes: [] }; rows.push(anon); }
        anon.nodes.push(child);
        continue;
      }
      if (boxlessChild(child)) continue;
      // An out-of-flow child of a table or a row is positioned against its containing
      // block like any other and generates no table box at all (Chrome-verified on a
      // `display: table` holding an absolutely positioned overlay). Skipping it left
      // the box unstamped and unhittable.
      const p = positionOf(child);
      if (p === 'absolute' || p === 'fixed') { outOfFlow.push({ el: child, pos: p }); continue; }
      const d = displayOf(child);
      if (d === 'table-row') { anon = null; rows.push({ el: child, group, cells: [], nodes: rowContent(child) }); continue; }
      // (…a row group, a caption or a column belongs to a TABLE: inside a row group it is content like any other, which
      // an anonymous row and cell take — and the cell an anonymous table around it, CSS 2.1 §17.2.1; walk.rs
      // `collect_table`)
      const proper = group === null;
      if (proper && ROW_GROUP_DISPLAY.has(d)) {
        anon = null;
        const g = { el: child, first: -1, last: -1 };
        groups.push(g);
        collect(child, g);
        continue;
      }
      // A table-caption / -column / -column-group is a PROPER table child (§17.2.1), so — like a real
      // table-row or row-group — it TERMINATES a run of anonymous-row cells: misparented cells on either side
      // of one fall into SEPARATE anonymous rows (Chrome stacks them), not one row straddling it.
      if (proper && d === 'table-caption') { anon = null; captions.push(child); continue; }
      if (proper && d === 'table-column') { anon = null; columns.push(child); continue; }
      // A `<colgroup>` with no `<col>` children is one column definition itself; one WITH `<col>` children
      // defines its columns through them, but its OWN border still collapses at the group's outer rim (§17.6.2.1),
      // so it is remembered (with its child cols, to recover the span) for the collapse resolution.
      if (proper && d === 'table-column-group') {
        anon = null;
        const cols = layoutChildren(child).filter((c) => c.nodeType === NODE_ELEMENT && displayOf(c) === 'table-column');
        if (cols.length) { for (const c of cols) columns.push(c); columnGroups.push({el: child, cols}); }
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

  // Anonymous cells (§17.2.1): in EVERY row with gathered content (an anonymous row, or a real row's own
  // children), each maximal run of consecutive NON-cell content (stray text and non-table-cell boxes) becomes
  // ONE anonymous cell laying the run out as block flow; a real table-cell stays its own cell. placeCells then
  // sees a row of cell boxes. (A lone stray block wraps to a one-child anonymous cell — the same box it would
  // have had alone; a lone inline gains the cell's line box, which is what Chrome gives it too.)
  for (const row of rows) {
    if (!row.nodes || !row.nodes.length) continue;
    const cells = [];
    let run = null;
    for (const node of row.nodes) {
      if (node.nodeType === NODE_ELEMENT && displayOf(node) === 'table-cell') {
        if (run) { cells.push(anonTableCell(table, run)); run = null; }
        cells.push(node);
      } else (run || (run = [])).push(node);
    }
    if (run) cells.push(anonTableCell(table, run));
    row.nodes = cells;
  }

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

  // A back-pointer so a cell can find its table for the collapsed-border resolution
  // (`cellCollapseHalves`), which needs the grid a per-element read can't see.
  for (const row of rows) for (const cell of row.cells) cell.el._lbTable = table;

  table._lbGrid = { rows, groups, captions, columns, columnGroups, outOfFlow, colCount };
  table._lbGridPass = structStamp(table);
  return table._lbGrid;
}
// The order a table RENDERS its top-level row content in, whatever the source order (§17.2.1 / the HTML UA
// sheet): every header group first, then the bodies and any bare rows, then every footer group — the order
// `tableGrid` sorts its row list in, which is the order the pass names a table's anonymous cells in.
function rowGroupRankOf(d) {
  return d === 'table-header-group' ? 0 : d === 'table-footer-group' ? 2 : 1;
}
function rowGroupRank(row) {
  return rowGroupRankOf(row.group ? displayOf(row.group.el) : 'table-row-group');
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
      if (boxlessChild(child)) continue;
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
      // `colspan` / `rowspan` are HTML attributes defined only on `<td>` / `<th>`; on any OTHER element acting as
      // a cell (a `display: table-cell` `<div>`, an anonymous cell) a browser ignores them — it stays 1x1.
      const spans = child._tag === 'td' || child._tag === 'th';
      const colSpan = spans ? Math.max(1, Math.min(spanAttr(child, 'colspan'), limit - c)) : 1;
      // A `rowspan` reaches to the end of its ROW GROUP and no further, and
      // `rowspan="0"` means exactly that far (Chrome: a span in one `<tbody>` does not
      // reach into the next).
      const lastRow = row.group && row.group.last >= 0 ? row.group.last : rows.length - 1;
      const room = Math.max(1, lastRow - r + 1);
      const declaredRowSpan = spans ? spanAttr(child, 'rowspan', 0) : 1;
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
  // The box's OWN edges, percentages resolved against its containing block: a basis-less read hangs half an
  // asymmetric vertical percentage padding off the line (Chrome puts `<input style="padding-top:10%">` on a 66px
  // block where that says 86). `_lbCbW` is the basis the box's own layout used.
  const e = edgeInsets(el, el._lbCbW != null ? el._lbCbW : null);
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
  const b = el._lb;
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
  const e = edgeInsets(el, el._lbCbW != null ? el._lbCbW : null);
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
// Whether `el` establishes a scroll/clip box (any overflow axis non-`visible`). For occlusion,
// clipping is what matters, so `scroll`/`auto`/`hidden`/`clip` all count.
// Does a flex item SCROLL IN ITS MAIN AXIS? That — not "does it scroll at all" — is what §4.5
// gives an automatic minimum of zero. Asking the looser question squeezed a box that scrolls only
// ACROSS its container to nothing ALONG it, and gave an `overflow: clip` item (which is not a
// scroll container at all) a minimum of zero where its content is the floor.
// Does this box CLIP its content, and in which axes — and is it a SCROLL CONTAINER? The pass decided, when it laid
// the box out (walk.rs `clip_flags`, the row's `NL_ROW_CLIP`): its overflow once the viewport has taken the root's,
// and the body's where the root has none of its own (CSS Overflow §3.3), and no inline box's, to which `overflow` does
// not apply. One answer, so the clip chain, the scrollable extents and the scroll shift (geometry.rs) can't disagree
// about the same box. The axes are kept apart because `clip` beside `visible` stays so — a child hanging off the SIDE
// of an `overflow-y: clip` box is visible and hit-testable in Chrome — and scrolling is not clipping: `clip` clips and
// forbids all scrolling, script included, so it is neither the scrollport a sticky box sticks within nor something
// `scrollIntoView` can scroll.
function clipFlags(el) {
  const b = el._lb;
  return (b && b.clip) || 0;
}
function clipsContent(el) { return (clipFlags(el) & (NL_CLIP_X | NL_CLIP_Y)) !== 0; }
export function scrollsContent(el) { return (clipFlags(el) & NL_CLIP_SCROLLS) !== 0; }

// Is `eb` pushed entirely out of `p`'s box in an axis `p` actually clips?
function clippedOutBy(eb, p) {
  const clip = clipFlags(p);
  if (!(clip & (NL_CLIP_X | NL_CLIP_Y))) return false;
  const pb = renderedBox(p);
  if (!eb || !pb) return false;
  if (clip & NL_CLIP_X && (eb.x + eb.width <= pb.x || eb.x >= pb.x + pb.width)) return true;
  if (clip & NL_CLIP_Y && (eb.y + eb.height <= pb.y || eb.y >= pb.y + pb.height)) return true;
  return false;
}

// The total scroll shift applied to `el`'s box, `{sx, sy}` (geometry.rs `scroll_shift`): the document's scroll and
// every scroll container's around it, compounding up, less what a sticky box among them has stuck — none for a fixed
// box. A box in no arena — an ANONYMOUS one, which is no node — takes the shift of a box its container holds.
const SHIFT = new Float64Array(2);
function scrollShift(el) {
  if (el._nid >= 0) scrollShiftOf(el, false, SHIFT);
  else scrollShiftOf(flatTreeParent(el), true, SHIFT);
  return { sx: SHIFT[0], sy: SHIFT[1] };
}

function isFixedBox(el) { return !!(el && el._lb && el._lb.fixed); }

// A `display: contents` element generates NO BOX of its own — only its children's boxes are in the
// tree — so every page-visible geometry read has to say so itself, whatever `_lb` it still holds: Chrome reports a
// zero `getBoundingClientRect`, no client rects, `offsetWidth` / `offsetHeight` 0 and a null
// `offsetParent` for one. `<slot>` is `display: contents`, so this is every web component's slot.
function generatesBox(el) { return displayOf(el) !== 'contents'; }
globalThis.__csimGeneratesBox = (el) => el.nodeType === NODE_ELEMENT && generatesBox(el);
globalThis.__csimIsLineBreak = isLineBreak;

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
// Does anything declare a transform on THIS node — any of the four at other than its initial value
// (`declaresLayoutProp`)?
function declaresTransform(el) {
  for (const prop of TRANSFORM_GEOMETRY_PROPS) if (declaresLayoutProp(el, prop)) return true;
  return false;
}
const TRANSFORM_GEOMETRY_PROPS = ['transform', 'translate', 'rotate', 'scale'];
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

// The PHASE a box paints in within its stacking context (higher = nearer the viewer), CSS 2.1 appendix E: the
// negative `z-index` contexts (step 3), the block-level backgrounds (step 4), the FLOATS (step 5), the inline-level
// content — inline boxes, atomic inlines and the text of the lines (step 7) — then the positioned boxes of `z-index`
// auto or 0 (step 8), then the positive contexts (step 9). Tree order breaks a tie within a phase. So a float
// covers the blocks around it and the text of a line covers a float it overlaps, whatever order they were placed in.
// A flex or grid ITEM paints as an inline-block does, in the order its container placed it (Flexbox §4.3, Grid
// §9), and takes a `z-index` without being positioned; any other context a static box makes (an `opacity`, a
// `transform`) paints as a positioned `z-index: 0` box would.
const PAINT_BLOCK = 0, PAINT_FLOAT = 0.2, PAINT_INLINE = 0.3, PAINT_POSITIONED = 0.5;
function paintRank(el) {
  const positioned = positionOf(el) !== 'static', item = !positioned && isFlexOrGridItem(el);
  const z = positioned || item ? zIndexOf(el) : null;
  // `z-index: 0` and `z-index: auto` paint in the SAME layer (CSS 2.1 appendix E steps 8/9), so
  // tree order decides between them — ranking 0 below auto put an earlier `auto` box on top.
  if (z != null) return z === 0 ? PAINT_POSITIONED : z;
  if (positioned || establishesStackingContext(el)) return PAINT_POSITIONED;
  return item ? PAINT_INLINE : isFloated(el) ? PAINT_FLOAT : isInlineLevel(el) ? PAINT_INLINE : PAINT_BLOCK;
}
// An integer `z-index`, or null for `auto` (and for anything that is not an integer) — as it COMPUTES, so an
// `inherit` takes the parent's.
function zIndexOf(el) {
  const z = declaredValue(el, 'z-index');
  return z != null && /^-?\d+$/.test(z) ? parseInt(z, 10) : null;
}
// Whether a box paints its OWN box in the inline phase of the context it sits in, not as a unit: a non-atomic inline.
function paintsItsBoxInline(el) {
  return (displayOf(el) === 'inline' || isSplitInline(el)) && !intrinsicSize(el);
}

// Whether a box that makes no stacking context is still painted as ONE UNIT, as if it made one (appendix E): a float,
// an atomic inline (an inline-block and its kin, an inline replaced element), a positioned box of `z-index: auto`.
// What is inside it competes inside it — a float's text is under a later float, not over it — except its positioned
// descendants and the contexts it holds, which belong to the enclosing context (`stackChain`).
function paintsAsUnit(el) {
  if (establishesStackingContext(el)) return false;
  if (positionOf(el) !== 'static') return true;
  if (isFloated(el) || isFlexOrGridItem(el)) return true;
  return isInlineLevel(el) && !paintsItsBoxInline(el);
}

// Is `a` an ancestor of `b` in the flat tree?
export function isFlatAncestor(a, b) {
  for (let p = flatTreeParent(b); p; p = flatTreeParent(p)) if (p === a) return true;
  return false;
}

// Whether this box paints its positioned descendants itself, or hands them up. A positioned box
// with `z-index: auto` does NOT establish a stacking context: its own `z-index: 10` child
// competes at the level above, which is how a menu inside an un-z-indexed wrapper comes out on
// top. `fixed` and `sticky` establish one whatever their z-index is, and so does a flex or grid
// item with one (or with `will-change: z-index`, as a positioned box does) — and so does every box
// that CONTAINS a fixed descendant (a transform, a filter, paint or layout containment:
// `containsOutOfFlow`) or composites its subtree as one image — or has a current animation of a
// property that would, even one still waiting out its delay.
function establishesStackingContext(el) {
  return declaresStackingContext(el) || currentlyAnimatesAnyOf(el, STACKING_ANIMATED);
}
// …the half the STYLESHEETS decide, kept for the pass behind the same bracket as `stackChain` (`dynamicReadSeq`): a hit
// test asks it of every candidate and of every level above one, and a page full of effect declarations paid a style
// read per question. (The animation half moves with the clock, not the pass, and is asked live.)
function declaresStackingContext(el) {
  if (el._lbCtxPass === layoutPass) return el._lbCtx;
  const seq0 = dynamicReadSeq();
  const pos = positionOf(el);
  const v = pos === 'fixed' || pos === 'sticky' ||
            ((pos !== 'static' || isFlexOrGridItem(el)) && (zIndexOf(el) != null || willChangeNames(el, WILL_CHANGE_Z))) ||
            containsOutOfFlow(el) || compositesAsGroup(el);
  if (dynamicReadSeq() === seq0) { el._lbCtxPass = layoutPass; el._lbCtx = v; }
  return v;
}
// …an animation that is merely CURRENT makes one for these alone — Chrome, a `@keyframes` in its delay: a context for
// `clip-path`, none for `mask-image`, `mix-blend-mode` or `isolation`, which make one only while their animated VALUE
// is in effect (`compositesAsGroup` reads those animated).
const STACKING_ANIMATED = ['transform', 'translate', 'rotate', 'scale', 'opacity', 'filter', 'backdrop-filter', 'clip-path'];
const WILL_CHANGE_Z = new globalThis.Set(['z-index']);
// Whether `will-change` names one of `names` — whole names, as `containsOutOfFlow` reads it.
function willChangeNames(el, names) {
  if (!declaresLayoutProp(el, 'will-change')) return false;
  const v = declaredValue(el, 'will-change');
  return !!v && String(v).split(',').some((name) => names.has(name.trim().toLowerCase()));
}
// …the effects that composite a subtree as ONE image before it meets the page (CSS Color §opacity, Compositing
// §isolation / §mix-blend-mode, Masking §clip-path / §mask, View Transitions §view-transition-name, Transforms
// §transform-style): an `opacity` below 1, a blend mode other than `normal`, `isolation: isolate`, a clip path, a
// mask, a view-transition name, a transformable box that preserves 3D — and a `will-change` naming one of them, each
// read as it stands, animated values included (and `currentlyAnimatesAnyOf` makes a context of the two whose mere
// animation already makes one, `opacity` and `clip-path`, for the animation's whole run).
const GROUP_NON_NONE = ['mask-image', 'mask', 'view-transition-name'];
const WILL_CHANGE_GROUPS = new globalThis.Set(['opacity', 'mix-blend-mode', 'isolation', 'clip-path', 'mask', 'mask-image',
                                               'view-transition-name', 'transform-style']);
function compositesAsGroup(el) {
  const value = (prop) => (declaresLayoutProp(el, prop) ? declaredValue(el, prop) : null);
  const is = (v, keyword) => v != null && v.toLowerCase() === keyword;
  const opacity = value('opacity');
  if (opacity != null) {
    const n = parseFloat(opacity);
    if (Number.isFinite(n) && (opacity.endsWith('%') ? n / 100 : n) < 1) return true;
  }
  const clip = value('clip-path');
  if (clip != null && !is(clip, 'none')) return true;
  const blend = value('mix-blend-mode');
  if (blend != null && !is(blend, 'normal')) return true;
  if (is(value('isolation'), 'isolate')) return true;
  if (is(value('transform-style'), 'preserve-3d') && isTransformable(el)) return true;
  for (const prop of GROUP_NON_NONE) {
    const v = value(prop);
    if (v != null && !is(v, 'none')) return true;
  }
  return willChangeNames(el, WILL_CHANGE_GROUPS);
}

// The levels ABOVE this box, each contributing its paint RANK and — to break a tie between two of the same rank —
// where it sits in the tree; the box's own rank and place end its key (`paintKey`). Content is painted with the
// stacking context it lives in, so a static button inside a `z-index: 10` bar is painted at 10, ABOVE a
// `z-index: 5` box elsewhere: comparing bare ranks made the button lose to that box, and comparing only ancestry
// made a fixed container swallow clicks meant for its own content. A level is a real context or a painting unit
// the box is inside; a POSITIONED box leaves the units, so a relative child of one dropdown is not lifted over
// the dropdown declared after it.
function stackChain(el) {
  const anims = animationGeneration();
  if (el._lbChainPass === layoutPass && el._lbChainAnims === anims) return el._lbChain;
  // The chain bakes in `paintRank` — a z-index read.
  const seq0 = dynamicReadSeq();
  const parent = flatTreeParent(el);
  let chain = [];
  chain.real = 0;
  if (parent) {
    // `real` is how much of the chain the enclosing stacking contexts make up: a POSITIONED box, or one that makes a
    // context, leaves every unit (`paintsAsUnit`) below that — it is painted with the context, not inside the float
    // it sits in.
    // A parent that generates NO box (`display: contents`, a `<slot>`) is no level of any kind: it has no box to
    // paint, no paint order of its own, and what it would make of itself is made of nothing.
    const up = stackChain(parent);
    if (!generatesBox(parent)) { chain = up; }
    else if (establishesStackingContext(parent)) { chain = up.concat(paintRank(parent), parent._lbOrder); chain.real = chain.length; }
    else if (paintsAsUnit(parent)) { chain = up.concat(paintRank(parent), parent._lbOrder); chain.real = up.real; }
    else { chain = up; }
    if (chain.length > chain.real && (positionOf(el) !== 'static' || establishesStackingContext(el))) {
      const real = chain.real;
      chain = chain.slice(0, real);
      chain.real = real;
    }
  }
  // A chain that met a CURRENT animation is not kept (`currentlyAnimatesAnyOf` brackets the read: it holds until the
  // clock runs it out), and one computed before an animation started is not asked again (`animationGeneration`).
  if (dynamicReadSeq() === seq0) { el._lbChainPass = layoutPass; el._lbChainAnims = anims; el._lbChain = chain; }
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

// Where a paint LAYER sits in the painting order, as a key compared entry by entry, a key that runs out first
// painting first: the stacking chain the layer lives in, then its phase and its place in the tree. A layer is a box
// (an element) or the CONTENT a box owns (`{ contentOf: el }`: the text runs the painter draws for it, and a
// replaced element's image), which paints in the inline phase of whatever the box paints INSIDE — its own context or
// unit if it is one, else the box's — just after the box itself: over the block backgrounds and the floats there,
// under anything positioned. (A block-level replaced element's image included: appendix E paints it with the lines.)
// Comparing chains alone let "deeper" mean "on top", so anything inside a stacking context beat everything outside
// it — a `z-index: 100` box inside a `z-index: 1` context is still below a `z-index: 2` sibling of that context:
// each box competes at the level where the chains part, with the context or unit that encloses it there.
function paintKey(layer) {
  const el = layer.contentOf;
  if (!el) return stackChain(layer).concat(paintRank(layer), layer._lbOrder);
  const inner = establishesStackingContext(el) || paintsAsUnit(el)
    ? stackChain(el).concat(paintRank(el), el._lbOrder)
    : stackChain(el);
  return inner.concat(PAINT_INLINE, el._lbOrder, 0);
}

// Of two layers that both paint at a point, which is on top? Their keys decide, except between a BOX and what is
// inside it (`descendantAbove`). Not transitive in every shape — a block inside an inline under a float is above
// the inline (the ancestor rule), the inline above the float and the float above the block (the keys) — so the
// painter's sort (`paintOrder`) is exact only where no such cycle overlaps. `kc` / `kb` are the two `paintKey`s.
function paintsAboveKeyed(cand, kc, best, kb) {
  if (!cand.contentOf && !best.contentOf) {
    if (isFlatAncestor(best, cand)) return descendantAbove(best, kb, cand, kc);
    if (isFlatAncestor(cand, best)) return !descendantAbove(cand, kc, best, kb);
  }
  const n = Math.min(kc.length, kb.length);
  let i = 0;
  while (i < n && kc[i] === kb[i]) i++;
  return i === n ? kc.length >= kb.length : kc[i] > kb[i];
}
// An element's own box never covers what is inside it — an inline box around a block paints in a later phase than
// the block, and the block is still what a point over it hits — with three exceptions, each read where the two keys
// part (`d`, the descendant's entry there):
// - a NEGATIVE rank: content the page pushed behind the box with a negative `z-index`;
// - the box is the CONTEXT or UNIT that content belongs to (its key a prefix of the descendant's) and a block: its
//   own background is painted first (step 1), its negative children over it (step 3). A non-atomic INLINE one paints
//   its box in its inline step instead (7.2.1), over them and over its floats;
// - a FLOAT inside a non-atomic inline: the inline's fragments paint in the inline phase, over the floats (step 5).
function descendantAbove(anc, ka, desc, kd) {
  const n = Math.min(ka.length, kd.length);
  let i = 0;
  while (i < n && ka[i] === kd[i]) i++;
  // (Only where the keys part at a RANK — an even index, the ranks and orders alternating — does `d` name a phase: an
  // order is a fraction wherever a subtree was renumbered, and could read as one.)
  const d = i % 2 === 0 ? kd[i] : undefined;
  if (i === ka.length) return !(paintsItsBoxInline(anc) && (d < 0 || d === PAINT_FLOAT));
  if (d < 0) return false;
  return !(d === PAINT_FLOAT && ka[i] === PAINT_INLINE && paintsItsBoxInline(anc));
}

// The painter's order: every layer it draws (`paintKey`), bottom first — the same comparison `elementFromPoint`
// makes, so painting and hit-testing agree about what is on top.
export function paintOrder(layers) {
  ensureOrderAndExtents();
  const keyed = layers.map((layer) => ({ layer, key: paintKey(layer) }));
  keyed.sort((a, b) => (paintsAboveKeyed(a.layer, a.key, b.layer, b.key) ? 1 : -1));
  return keyed.map((k) => k.layer);
}

// Every element a hit at the VIEWPORT point (vx, vy) can land on — laid out, not clipped away, not `pointer-events:
// none` or `visibility: hidden`, its rendered box around the point — handed to `take` with its `paintKey`. An element
// that paints REPLACED content (`paintsReplacedContent`) is keyed by that content, which is over the floats even
// where its box is a block's; a GENERATED box is handed over as itself, and answers as its element.
function hitCandidates(vx, vy, take) {
  const body = globalThis.document && globalThis.document.body;
  if (!body) return;
  ensureOrderAndExtents();
  const consider = (n) => take(n, paintsReplacedContent(n) ? paintKey({ contentOf: n }) : paintKey(n));
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
    consider(n);
  });
  // …and the GENERATED boxes, which a DOM walk never reaches: a badge `::after` positioned outside
  // its element, a floated `::before` — a hit over one answers the originating element (Chrome).
  walkInclShadow(body, (n) => {
    const ps = n._pseudoNodes;
    if (!ps || n.nodeType !== NODE_ELEMENT) return;
    for (const which of PSEUDO_KINDS) {
      const p = ps[which];
      if (!p || !ps[which + 'On'] || !p._lb || !isLaidOutNode(p) || isClipped(p)) continue;
      if (!containsPoint(p, vx, vy) || pointerEventsNone(p) || visibilityHidden(p)) continue;
      consider(p);
    }
  });
}
// Whether an element paints REPLACED content over its box — an image, a canvas's drawing, a video, a nested browsing
// context, a `<select>`'s face — which appendix E paints with the lines (Chrome hits each over a float laid across
// it). A `<button>`, an `<input>` or a `<textarea>` is not one here: what it shows is text, and text is not
// hit-tested (Chrome hits the float over an empty input, and over a button beside its label; so does this).
const REPLACED_CONTENT_TAGS = new globalThis.Set(['img', 'canvas', 'video', 'iframe', 'embed', 'object', 'select']);
function paintsReplacedContent(el) {
  return !!el._pixels || REPLACED_CONTENT_TAGS.has(el._tag);
}
// The page's CANVAS: the area the root element paints even where its box is shorter (Chrome measured:
// `elementFromPoint` below a 50px body returns `<html>`, not null). The root's BOX stays content-sized, which is what
// its client rect must report; only what it answers for a hit is viewport-sized.
function canvasHit(vx, vy) {
  const root = globalThis.document && globalThis.document.documentElement;
  const vp = viewport();
  return root && root._lb && isLaidOutNode(root) && vx >= 0 && vy >= 0 && vx <= vp.width && vy <= vp.height ? root : null;
}

// The topmost laid-out, non-clipped element whose rendered box contains the VIEWPORT point (vx, vy) — the root where
// nothing else paints there.
export function hitTest(vx, vy) {
  ensureLayout();
  let best = null, bestKey = null;
  hitCandidates(vx, vy, (n, key) => {
    if (best === null || paintsAboveKeyed(n, key, best, bestKey)) { best = n; bestKey = key; }
  });
  if (best && best._pseudo) best = best._parent;
  return best || canvasHit(vx, vy);
}
// …and every element there, topmost first (`elementsFromPoint`), the root last for the canvas it paints.
export function hitTestAll(vx, vy) {
  ensureLayout();
  const found = [];
  hitCandidates(vx, vy, (n, key) => found.push({ n, key }));
  found.sort((a, b) => (paintsAboveKeyed(a.n, a.key, b.n, b.key) ? -1 : 1));
  const out = [];
  for (const { n } of found) {
    const el = n._pseudo ? n._parent : n;
    if (!out.includes(el)) out.push(el);
  }
  const root = canvasHit(vx, vy);
  if (root && !out.includes(root)) out.push(root);
  return out;
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
  // (…nor has an element with no box: one not rendered, or detached, still holds the extent a pass left it, and read
  // back a size it had two passes ago — CSSOM View says 0, and Chrome does)
  if (!isLaidOutNode(el) || !generatesBox(el)) return { width: 0, height: 0 };
  ensureOrderAndExtents();
  // (…a non-replaced inline box has no scrolling area to report: Chrome's `<span>` answers 0 x 0)
  if (isNonReplacedInline(el)) return { width: 0, height: 0 };
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
  // The ROOT's is the viewport's scrolling area, which is measured from the initial containing block — not from inside
  // the root's own borders — to its seed (`rootScrollSeed`) or the furthest box inside, clipped on the side it scrolls
  // from: the ICB's left edge (or its RIGHT one, for an rtl or `*-rl` root) and its top.
  const origin = scrollOriginSides(el);
  if (el === el.ownerDocument.documentElement) {
    const vp = viewport();
    const w = origin.x === 'left' ? Math.max(ext.right, ext.cRight) : vp.width - Math.min(ext.left, ext.cLeft);
    const h = origin.y === 'top' ? Math.max(ext.bottom, ext.cBottom) : vp.height - Math.min(ext.top, ext.cTop);
    return { width: Math.round(w), height: Math.round(h) };
  }
  const e = insetsOf(el);
  const padLeft = b.x + e.bl, padTop = b.y + e.bt;
  // A border-collapse TABLE's scroll region runs to its BORDER-box far corner, not the padding box: Chrome
  // reports scrollWidth == clientWidth - clientLeft / scrollHeight == clientHeight - clientTop — the top-left
  // outer-half border is the scrollport origin (padLeft/padTop, via `e`), but the FAR outer-half border is
  // counted INSIDE the region. Every other box — a SEPARATE table included — stops at the padding box. (`e`
  // for a collapse table is the outer-half frame; clientWidth/Height are already its border box, see clientBoxOf.)
  const farEdgeToBorder = isTableDisplay(displayOf(el)) && tableCollapses(el);
  const padRight  = b.x + b.width  - (farEdgeToBorder ? 0 : e.br);
  const padBottom = b.y + b.height - (farEdgeToBorder ? 0 : e.bb);
  // `stampExtent` SEEDS the union with the element's own border box, so an element whose content does
  // not overflow measures the padding box here (the seed sits AT the border box and is filtered by the
  // `> border box` test) — and a box stamped with an INFLATED seed floors the region to it (the root is
  // stamped at the viewport height so a short page still reports `scrollHeight === clientHeight`). That
  // border-box filter can't see a box in the BORDER REGION though (a table CAPTION spans the border box,
  // OUTSIDE the padding box — its edge equals the seed's), so also union the reach of the real
  // descendants alone (`ext.c*`, the seedless union): it catches the caption without disturbing the seed.
  const kidLeft   = Math.min(ext.left   < b.x            ? ext.left   : padLeft,   ext.cLeft);
  const kidTop    = Math.min(ext.top    < b.y            ? ext.top    : padTop,    ext.cTop);
  const kidRight  = Math.max(ext.right  > b.x + b.width  ? ext.right  : padRight,  ext.cRight);
  const kidBottom = Math.max(ext.bottom > b.y + b.height ? ext.bottom : padBottom, ext.cBottom);
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
// positioned, and has a BOX to be one: a positioned `display: contents` element has none (Chrome and
// Firefox skip it for `offsetParent`, the nearest such ancestor).
export function isPositionedElement(el) {
  return !!el && el.nodeType === NODE_ELEMENT && positionOf(el) !== 'static' && generatesBox(el);
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
  if (!stickyOffsetOf(el, SHIFT)) return el._lb;
  return { x: el._lb.x + SHIFT[0], y: el._lb.y + SHIFT[1], width: el._lb.width, height: el._lb.height };
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
// collapsed border, which `borderWidthsOf` resolves through `edgeInsets`. (A left scrollbar in RTL would add to
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
  // (…the viewport's from where the initial containing block starts, the root sitting there: `principalStartsRight`)
  if (el === el.ownerDocument.documentElement) return { x: principalStartsRight(el) ? 'right' : 'left', y: 'top' };
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
// none at all. A pass that stops rendering a fragmented inline writes nothing over its pieces
// (`nlWriteBoxes` writes what it laid out), so the guard has to be here.
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
      // inside one sticks within the scroller AROUND it, as it does in geometry.rs `scrollport`.
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
    if (clip & (NL_CLIP_X | NL_CLIP_Y)) {
      // …in the UNTRANSFORMED space, which is the one the painter draws in and the one every
      // clip-vs-box comparison here is written against. A clipper's transformed rect would be
      // intersected with untransformed content, and the two would disagree about where the
      // scrollport is.
      const r = renderedBoxUntransformed(p);
      if (r) {
        out.push({
          x:      clip & NL_CLIP_X ? r.x : -OPEN,
          y:      clip & NL_CLIP_Y ? r.y : -OPEN,
          width:  clip & NL_CLIP_X ? r.width  : OPEN * 2,
          height: clip & NL_CLIP_Y ? r.height : OPEN * 2,
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
  return isRoot && scrollOriginSides(scrollEl).x === 'right' ? Math.max(-max.x, Math.min(0, value)) : Math.min(Math.max(0, value), max.x);
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

    // …and NOT the border widths, whose resolved value is the computed one (CSSOM names no border property among the
    // used-value ones): a collapsing table's cell reports the width it declares, not the half of the shared edge its
    // box keeps (Chrome: `td { border: 4px solid }` is `4px`), and a side whose style draws nothing reports 0.

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

