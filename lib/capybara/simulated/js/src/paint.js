// Painting the laid-out page into a raster — what `save_screenshot` hands back.
//
// There is no second geometry here: the painter reads the SAME boxes every geometry query reads
// (the boxes the pass left in the arena) and the same cascade every `getComputedStyle` reads, so a
// screenshot can only ever show what the driver already believes. Its one extra input is where
// each TEXT RUN landed, which the flow discards and re-offers through `recordingRuns` — the
// painter cannot re-derive line breaking without repeating the pass — a form control's shown text among them, laid out
// in its box (walk.rs `control_text`).
//
// Paint order is layout's (`paintOrder`): the stacking contexts and the CSS 2.1 appendix E phases
// inside each, the SAME comparison `elementFromPoint` makes — so what a screenshot shows on top is
// what a click lands on, box for box. A box's CONTENT — its text, a replaced element's bitmap — is
// a layer of its own there, painted in the inline phase rather than with the box's background.
// (Hit-testing does not see TEXT: a point over a paragraph's words that overlap a float hits the
// float here and the paragraph in Chrome — it has no line geometry to ask. Opacity groups are not
// modelled.)
import { NODE_ELEMENT } from './constants.js';
import { stashTransfer } from './bytes.js';
import { scrollOffsetOf } from './native-query-shadow.js';
import { recordingRuns, contentExtent, viewportSize, paintRectOf, paintTransformOf, paintQuadOf, paintOrder,
         hasLayoutBox, scrollShift, clipBoxesFor } from './layout.js';
import { flatTreeParent } from './walk.js';
import { declaredValue, computedFontSizePx, computedFontFamily, computedFontWeight, computedFontStyle, computedColor,
         computedBidi } from './style-proxy.js';
import { bodyOf, documentElementOf } from './document-tree.js';

// A colour the canvas can take, or null for "paint nothing". `transparent` and a zero alpha are
// the same answer, and both are the common case for a background — most boxes paint none.
function paintColor(el, prop) {
  const raw = declaredValue(el, prop);
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v || v === 'transparent' || v === 'none') return null;
  if (/^currentcolor$/i.test(v)) return opaqueOrNull(computedColor(el));   // (…a keyword the canvas cannot take)
  return opaqueOrNull(v);
}
// …and a zero alpha is no colour to paint either.
function opaqueOrNull(v) {
  return /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0?\.?0+\s*\)$/i.test(v) ? null : v;
}

// The COMPUTED `color`, which is what text is painted in — the declared one walked up the tree handed the canvas a
// keyword it cannot draw (`inherit`, `currentcolor`), and the canvas then kept whatever colour it last had.
function textColor(el) {
  return computedColor(el) || 'rgb(0, 0, 0)';
}

// The CSS font shorthand the canvas takes, built from the same computed values layout measured
// with — so the glyphs drawn are the glyphs that were measured.
function fontString(el) {
  const size = computedFontSizePx(el) || 16;
  const weight = computedFontWeight(el);
  const style = computedFontStyle(el);
  const family = computedFontFamily(el) || 'sans-serif';
  return `${style === 'normal' ? '' : style + ' '}${weight} ${size}px ${family}`;
}

// Put the canvas under `m`, an ABSOLUTE set rather than a multiply so a clip and the box it clips
// can each be laid down under their own matrix inside one `save()`. The matrix is in VIEWPORT
// coordinates — the same space `paintRectOf` answers in — so a full-page paint, which shifts the
// whole picture by the root's scroll, has to shift the matrix's translation with it: the canvas
// point is `p + D`, the pixel wanted is `M(p) + D`, hence `t + D - A·D`.
function setPaintMatrix(g, m, dx, dy) {
  if (!m) { g.setTransform(1, 0, 0, 1, 0, 0); return; }
  g.setTransform(m[0], m[1], m[2], m[3],
                 m[4] + dx - (m[0] * dx + m[2] * dy),
                 m[5] + dy - (m[1] * dx + m[3] * dy));
}
// The axis-aligned bounds a transformed box lands in — only to decide whether it is worth drawing.
// In VIEWPORT coordinates, with the paint's own shift added AFTER the matrix, for the same reason:
// mapping `p + D` instead of `M(p) + D` is off by `(A - I)·D`, which is zero for a translation and
// not for a scale — measured, a `scale(2)` box on a scrolled full-page shot was culled unpainted.
function transformedBounds(m, x, y, w, h, dx, dy) {
  const px = [x, x + w, x, x + w], py = [y, y, y + h, y + h];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const tx = m[0] * px[i] + m[2] * py[i] + m[4];
    const ty = m[1] * px[i] + m[3] * py[i] + m[5];
    if (tx < minX) minX = tx;
    if (tx > maxX) maxX = tx;
    if (ty < minY) minY = ty;
    if (ty > maxY) maxY = ty;
  }
  return { x: minX + dx, y: minY + dy, width: maxX - minX, height: maxY - minY };
}
const offFrame = (b, width, height) =>
  b.x > width || b.y > height || b.x + b.width < 0 || b.y + b.height < 0;
// A SINGULAR matrix collapses the box onto a line — a `rotateX(90deg)` seen edge-on — and a box
// with no area paints nothing. The canvas would still ink the degenerate rect as a hairline.
const singular = (m) => m[0] * m[3] - m[1] * m[2] === 0;

const SIDES = ['top', 'right', 'bottom', 'left'];
// The border box's own borders and padding, which is what separates it from the content box.
function contentInset(el) {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of SIDES) {
    const bd = borderOf(el, side);
    const pad = parseFloat(declaredValue(el, `padding-${side}`)) || 0;
    out[side] = (bd ? bd.width : 0) + pad;
  }
  return out;
}
function borderOf(el, side) {
  const style = String(declaredValue(el, `border-${side}-style`) ?? 'none')
    .trim().toLowerCase();
  if (style === 'none' || style === 'hidden') return null;
  const raw = declaredValue(el, `border-${side}-width`);
  const width = parseFloat(raw);
  if (!(width > 0)) return null;
  return { width, color: paintColor(el, `border-${side}-color`) || textColor(el) };
}

// Apply an element's ancestor clips, paint, and put the context back. A screenshot is not a hot
// path, so the clip chain is walked per box rather than tracked as a stack — which also means the
// painter cannot get out of step with a subtree it skipped.
// Each clip goes down under ITS OWN clipper's matrix, and only then is the canvas set to the
// matrix the element itself draws under. A rotated clipper therefore clips to its true quad rather
// than to its bounding box, because the rect is built in the space it is a rect in.
// `content`: what is drawn is the element's CONTENT, which its own overflow clips too.
function clipped(g, el, m, dx, dy, draw, content = false) {
  const boxes = clipBoxesFor(el, content);
  // …and the element's own PROJECTED QUAD where its map is one a canvas cannot draw: the affine the
  // painter falls back to carries three of the four corners and puts the fourth at
  // `p1 + p2 - p0`, a parallelogram where the truth is a trapezoid. Clipping to the real quad is
  // what keeps the ink inside the shape — measured, it was over-inking by a third.
  const quad = paintQuadOf(el);
  if (!boxes.length && !m && !quad) { draw(); return; }
  g.save();
  try {
    for (const b of boxes) {
      setPaintMatrix(g, b.m, dx, dy);
      g.beginPath();
      g.rect(b.x + dx, b.y + dy, b.width, b.height);
      g.clip();
    }
    if (quad) {
      setPaintMatrix(g, null, dx, dy);          // the quad is already in viewport coordinates
      g.beginPath();
      g.moveTo(quad[0].x + dx, quad[0].y + dy);
      for (let i = 1; i < quad.length; i++) g.lineTo(quad[i].x + dx, quad[i].y + dy);
      g.closePath();
      g.clip();
    }
    setPaintMatrix(g, m, dx, dy);
    draw();
  } finally { g.restore(); }
}

// The box a text run paints WITH: the element that owns it, or the nearest ancestor that has a box.
function runBoxOwner(run) {
  const owner = run.owner;
  if (!owner || owner._nodeType !== NODE_ELEMENT) return null;
  // A run's owner may generate no box of its own — a `<slot>` or any `display: contents` box,
  // whose text the flow places in its parent's line — and the run then moves, clips and
  // transforms with the nearest ancestor that does; the owner itself still answers for the
  // font and the colour. (Gating on the owner's own box dropped every slotted run once slots stopped
  // being laid out as blocks: `dir-shadow-25` painted no "paragraph." at all.)
  let boxOwner = owner;
  while (boxOwner && boxOwner._nodeType === NODE_ELEMENT && !hasLayoutBox(boxOwner)) boxOwner = flatTreeParent(boxOwner);
  return boxOwner && boxOwner._nodeType === NODE_ELEMENT && hasLayoutBox(boxOwner) ? boxOwner : null;
}

// Where a box paints in the frame: its rectangle (`x` / `y` in the frame, `r` as layout placed it) and the transform
// the canvas draws it under — or null for a box that paints nothing here. The box layout placed is drawn UNDER the
// element's transform — the canvas applies the matrix, so the box, its borders and its bitmap all move together
// and a rotation comes out as the quad it is rather than as its bounding rectangle. `dx` / `dy` undo the root's
// scroll for a full-page paint; `width` / `height` are the frame, for culling.
function boxFrame(el, dx, dy, width, height) {
  const r = paintRectOf(el);                       // zero for anything not rendered
  if (!r || r.width <= 0 || r.height <= 0) return null;
  const x = r.x + dx, y = r.y + dy;
  const m = paintTransformOf(el);
  if (m === false) return null;                   // a transform the painter cannot express at all
  if (m && singular(m)) return null;
  // …and the off-frame test asks about the box the transform PUTS there: a `translate` can
  // bring a box on screen from far outside it, and can carry one off.
  if (offFrame(m ? transformedBounds(m, r.x, r.y, r.width, r.height, dx, dy)
                 : { x, y, width: r.width, height: r.height }, width, height)) return null;
  return { r, x, y, m };
}

// One box: its background and its borders.
function paintBox(g, el, dx, dy, width, height) {
  const f = boxFrame(el, dx, dy, width, height);
  if (!f) return;
  const { r, x, y, m } = f;
  clipped(g, el, m, dx, dy, () => {
    const bg = paintColor(el, 'background-color');
    if (bg) { g.fillStyle = bg; g.fillRect(x, y, r.width, r.height); }
    // Borders as four rectangles, which is what a solid border IS. A dashed or dotted one is
    // painted solid for now, and a radius is not honoured — both are later work, and a solid
    // approximation is closer than leaving the edge unpainted.
    for (const side of SIDES) {
      const bd = borderOf(el, side);
      if (!bd) continue;
      g.fillStyle = bd.color;
      if (side === 'top')         g.fillRect(x, y, r.width, bd.width);
      else if (side === 'bottom') g.fillRect(x, y + r.height - bd.width, r.width, bd.width);
      else if (side === 'left')   g.fillRect(x, y, bd.width, r.height);
      else                        g.fillRect(x + r.width - bd.width, y, bd.width, r.height);
    }
  });
}

// A replaced element's bitmap, which fills its CONTENT box — the border box less its own borders
// and padding, which is where layout sized it to sit. `_pixels` is the decoded bitmap of an
// <img> / SVG <image>, and equally the backing store a <canvas>'s 2D context draws into, so
// a canvas paints its own drawing here too. The two are sized differently: an image by its
// INTRINSIC size, a canvas by its width/height, which IS its buffer. Naming both rather
// than `_naturalWidth || width` keeps this from silently catching some future element
// whose `width` means something else (`width` answers for img / pre / the table family /
// video / input). Without this a canvas painted as an empty box, which is what made every
// canvas WPT reftest compare against a blank page. (A <video>'s decoded frame hangs off
// `_csimVideoFrame`, not `_pixels`, and is still not painted — backlog.)
function bitmapWidthOf(el) {
  const w = el._tag === 'canvas' ? el.width : el._naturalWidth;
  return el._pixels && w > 0 ? w : 0;
}
function paintBitmap(g, el, dx, dy, width, height) {
  const f = boxFrame(el, dx, dy, width, height);
  if (!f) return;
  const { r, x, y, m } = f;
  clipped(g, el, m, dx, dy, () => {
    const e = contentInset(el);
    const cw = r.width - e.left - e.right, ch = r.height - e.top - e.bottom;
    if (cw > 0 && ch > 0) {
      try { g.drawImage(el, x + e.left, y + e.top, cw, ch); } catch (_) { /* undecodable */ }
    }
  }, true);
}

// One text run of `boxOwner`'s, in the owner's font and colour, where the flow put it.
function paintRun(g, run, boxOwner, dx, dy, width, height) {
  const owner = run.owner;
  // The run was recorded in DOCUMENT coordinates by the flow; the box's shift is the same
  // `rectOf` applied, so one subtraction puts the run in the frame with it — inner scrollers
  // and sticky included, without the painter knowing about either.
  if (!hasLayoutBox(boxOwner)) return;            // a box no pass has given it any more
  const { sx, sy } = scrollShift(boxOwner);
  const shiftX = -sx, shiftY = -sy;
  const x = run.x + shiftX + dx, y = run.baseline + shiftY + dy;
  const m = paintTransformOf(boxOwner);
  if (m === false) return;
  if (m && singular(m)) return;
  // Culled on the band the run can ink — its advance, and the ascent/descent slack the
  // untransformed test spends either side of the baseline — put where the transform puts it.
  // Skipping the test entirely under a transform was measured at 11.7x on a page whose only
  // transform was one `translateY(1px)` on a wrapper: one is enough to un-cull the whole
  // document, and a centred modal or a `translate3d` compositing hint is that one.
  if (m ? offFrame(transformedBounds(m, run.x + shiftX, run.baseline + shiftY - 40,
                                     run.width || 1, 80, dx, dy), width, height)
        : (x > width || y < -40 || y > height + 40)) return;
  clipped(g, boxOwner, m, dx, dy, () => {
    g.fillStyle = textColor(owner);
    g.font = fontString(owner);
    // The run's text in visual order on its paragraph's base direction (its element's, or — `unicode-bidi: plaintext`
    // — its own first strong character's), drawn from its left edge whichever that is.
    const bidi = computedBidi(owner);
    const strong = bidi.plaintext ? globalThis.__dom.firstStrongDirection(run.text) : undefined;
    g.direction = (strong ?? bidi.rtl) ? 'rtl' : 'ltr';
    g.textAlign = 'left';
    // A run the flow placed a character at a time — spaced, justified, tabbed, or split across faces — is drawn the
    // same way, each glyph at the pen step native measured it by (`run.steps`: `[advance, step, size]` per character,
    // walk_ops.rs `paint_rows`), so it lands where the box says it does. A split's glyph takes its own face — and that
    // face's `size-adjust` — in the canvas too, which resolves the family stack as the flow did.
    if (run.steps) {
      const steps = run.steps;
      let pen = x, k = 0;
      for (const ch of run.text) {
        const adv = steps[k], step = steps[k + 1];
        k += 3;
        if (adv > 0 && ch !== ' ' && ch !== '\u00A0' && ch !== '\t') g.fillText(ch, pen, y, adv);
        pen += step;
      }
      return;
    }
    // Condensed to the advance the FLOW reserved: the layout's figure is the one every geometry query reports, so it
    // is the one that wins where the canvas shapes the run a little differently (it kerns; the flow sums advances).
    if (run.width > 0) g.fillText(run.text, x, y, run.width);
    else g.fillText(run.text, x, y);
  }, true);
}

// Paint the viewport and return the canvas. `full` paints the whole document instead, which is
// what a full-page screenshot wants.
export function paintPage({ full = false } = {}) {
  const doc = globalThis.document;
  const root = doc && documentElementOf(doc);
  // A document CAN have no root element — `documentElement.remove()` is legal, and WPT tests it.
  // A browser shows a blank page there, so paint one: an empty canvas, not "no screenshot".
  if (!doc) return null;
  return recordingRuns((runs) => {
    const vp = viewportSize();
    const width  = Math.max(1, Math.ceil(vp.width));
    const rootExtent = root ? contentExtent(root).height : 0;
    const height = Math.max(1, Math.ceil(full ? Math.max(vp.height, rootExtent) : vp.height));
    // A detached `<canvas>` rather than an `OffscreenCanvas`: the two share the raster stack, but
    // only the element carries `toDataURL`, and the encode has to be SYNCHRONOUS — the host call
    // that takes the screenshot has nowhere to await a Blob.
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    // `rectOf` already answers in VIEWPORT coordinates — the root's scroll, an inner scroller's,
    // sticky and fixed all applied — which is exactly the frame being painted. A full-page paint
    // undoes only the root's own scroll, so the whole document lands in frame.
    const dx = full && root ? scrollOffsetOf(root, 0) : 0;
    const dy = full && root ? scrollOffsetOf(root, 1) : 0;
    // A page with no background of its own is white, as a browser's canvas is.
    const body = bodyOf(doc);
    g.fillStyle = (root && paintColor(root, 'background-color')) ||
                  (body && paintColor(body, 'background-color')) || '#ffffff';
    g.fillRect(0, 0, width, height);

    // The layers, in the order they paint: every laid-out box, and the CONTENT each box owns — its text runs, and a
    // replaced element's bitmap (`paintKey`).
    const layers = [], contentOf = new Map();
    const content = (el) => {
      let c = contentOf.get(el);
      if (!c) { c = { contentOf: el, runs: [], bitmap: false }; contentOf.set(el, c); layers.push(c); }
      return c;
    };
    for (const run of runs) {
      if (!run.text || !/\S/.test(run.text)) continue;
      const boxOwner = runBoxOwner(run);
      if (boxOwner) content(boxOwner).runs.push(run);
    }
    if (root) {
      const walk = (n) => {
        if (n._nodeType === NODE_ELEMENT && n !== root && hasLayoutBox(n)) {    // the root's background filled the canvas
          layers.push(n);
          if (bitmapWidthOf(n)) content(n).bitmap = true;
        }
        const sr = n._shadowRoot;
        if (sr && sr._children) for (const c of sr._children) walk(c);
        const ch = n._children;
        if (ch) for (const c of ch) walk(c);
      };
      walk(root);
    }
    for (const layer of paintOrder(layers)) {
      const el = layer.contentOf;
      if (!el) { paintBox(g, layer, dx, dy, width, height); continue; }
      if (layer.bitmap) paintBitmap(g, el, dx, dy, width, height);
      for (const run of layer.runs) paintRun(g, run, el, dx, dy, width, height);
    }
    return canvas;
  });
}

// The host entry point: paint, then hand back PNG bytes as a data URL. One string per screenshot,
// which is not a hot path.
// Diagnostic: the text runs a paint would draw, in flow order, with the advance the flow reserved
// for each. Specs assert against it because the pixels alone cannot say WHERE a run was told to
// go — only that ink landed somewhere.
globalThis.__csimPaintRuns = function () {
  return recordingRuns((runs) => runs.map(r => ({ text: r.text, x: r.x, y: r.y, baseline: r.baseline, width: r.width })));
};

// The host entry point: the page painted and written as a PNG (`__dom.encodeImage`), handed to the host as a REF to the
// bytes stashed on its side — one crossing as a binary string, not a `data:` URL it would have to undo.
globalThis.__csimScreenshot = function (full) {
  const canvas = paintPage({ full: !!full });
  if (!canvas || !canvas.width || !canvas.height || !canvas._pixels) return null;
  const file = globalThis.__dom.encodeImage(canvas._pixels, canvas.width, canvas.height, 'image/png', NaN);
  return file ? { refId: stashTransfer(file[1]), width: canvas.width, height: canvas.height } : null;
};
