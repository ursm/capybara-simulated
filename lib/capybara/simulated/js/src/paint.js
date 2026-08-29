// Painting the laid-out page into a raster — what `save_screenshot` hands back.
//
// There is no second geometry here: the painter reads the SAME boxes every geometry query reads
// (`_lb`, in document coordinates) and the same cascade every `getComputedStyle` reads, so a
// screenshot can only ever show what the driver already believes. Its one extra input is where
// each TEXT RUN landed, which the flow discards and re-offers through `recordingRuns` — the
// painter cannot re-derive line breaking without repeating the pass.
//
// Paint order is the flow's own `_lbOrder`: the number layout hands out as boxes are placed, and
// the same one `elementFromPoint` sorts by. That gives tree order with out-of-flow boxes in the
// slot they were placed in — not a real stacking-context walk (`z-index` and opacity groups are
// the next stage), but the order the rest of the driver already agrees on.
import { NODE_ELEMENT } from './constants.js';
import { stashTransfer } from './bytes.js';
import { recordingRuns, viewportSize, rectOf, laidOutBox, clipBoxesFor } from './layout.js';
import { declaredValue, computedFontSizePx, computedFontFamily, computedFontWeight,
         computedFontStyle, uaDefault } from './style-proxy.js';

// A colour the canvas can take, or null for "paint nothing". `transparent` and a zero alpha are
// the same answer, and both are the common case for a background — most boxes paint none.
function paintColor(el, prop) {
  const raw = declaredValue(el, prop) ?? uaDefault(el, prop);
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v || v === 'transparent' || v === 'none') return null;
  if (/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0?\.?0+\s*\)$/i.test(v)) return null;
  return v;
}

// The inherited `color`, which is what text is painted in. Walked rather than read through the
// computed layer so an element that declares none takes its parent's, as the cascade does.
function textColor(el) {
  for (let n = el; n && n.nodeType === NODE_ELEMENT; n = n._parent) {
    const c = paintColor(n, 'color');
    if (c) return c;
  }
  return 'rgb(0, 0, 0)';
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

const SIDES = ['top', 'right', 'bottom', 'left'];
// The border box's own borders and padding, which is what separates it from the content box.
function contentInset(el) {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of SIDES) {
    const bd = borderOf(el, side);
    const pad = parseFloat(declaredValue(el, `padding-${side}`) ?? uaDefault(el, `padding-${side}`)) || 0;
    out[side] = (bd ? bd.width : 0) + pad;
  }
  return out;
}
function borderOf(el, side) {
  const style = String(declaredValue(el, `border-${side}-style`) ?? uaDefault(el, `border-${side}-style`) ?? 'none')
    .trim().toLowerCase();
  if (style === 'none' || style === 'hidden') return null;
  const raw = declaredValue(el, `border-${side}-width`) ?? uaDefault(el, `border-${side}-width`);
  const width = parseFloat(raw);
  if (!(width > 0)) return null;
  return { width, color: paintColor(el, `border-${side}-color`) || textColor(el) };
}

// The painting LEVEL of a box, coarsely: CSS paints in-flow content before positioned content,
// and orders positioned content by `z-index`. So a non-positioned box sits below every positioned
// one, a positioned box with `z-index: auto` sits at 0, and an explicit index is taken as written.
// Not a real stacking-context tree — an index is compared globally rather than within its parent
// context, which is wrong for nested contexts and right for the overlays and dropdowns a
// screenshot is usually about.
function paintLevel(el) {
  const pos = String(declaredValue(el, 'position') ?? 'static').trim().toLowerCase();
  if (pos === 'static') return -1;
  const z = String(declaredValue(el, 'z-index') ?? 'auto').trim().toLowerCase();
  const n = parseInt(z, 10);
  return Number.isFinite(n) ? n : 0;
}

// Every laid-out element, in paint order: by level, then by the flow's own `_lbOrder` — the number
// layout hands out as boxes are placed, and the one `elementFromPoint` sorts by. Painting and
// hit-testing therefore agree about what is on top.
function boxesInPaintOrder(root) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeType === NODE_ELEMENT && n._lb) out.push(n);
    const sr = n._shadowRoot;
    if (sr && sr._children) for (const c of sr._children) walk(c);
    const ch = n._children;
    if (ch) for (const c of ch) walk(c);
  };
  walk(root);
  for (const el of out) el._paintLevel = paintLevel(el);
  out.sort((a, b) => (a._paintLevel - b._paintLevel) || ((a._lbOrder || 0) - (b._lbOrder || 0)));
  return out;
}

// Apply an element's ancestor clips, paint, and put the context back. A screenshot is not a hot
// path, so the clip chain is walked per box rather than tracked as a stack — which also means the
// painter cannot get out of step with a subtree it skipped.
function clipped(g, el, dx, dy, draw) {
  const boxes = clipBoxesFor(el);
  if (!boxes.length) { draw(); return; }
  g.save();
  for (const b of boxes) {
    g.beginPath();
    g.rect(b.x + dx, b.y + dy, b.width, b.height);
    g.clip();
  }
  draw();
  g.restore();
}

const EMPTY = [];

// Paint the viewport and return the canvas. `full` paints the whole document instead, which is
// what a full-page screenshot wants.
export function paintPage({ full = false } = {}) {
  const doc = globalThis.document;
  const root = doc && doc.documentElement;
  // A document CAN have no root element — `documentElement.remove()` is legal, and WPT tests it.
  // A browser shows a blank page there, so paint one: an empty canvas, not "no screenshot".
  if (!doc) return null;
  return recordingRuns((runs) => {
    const vp = viewportSize();
    const width  = Math.max(1, Math.ceil(vp.width));
    const rootExtent = (root && root._lbExt) ? root._lbExt.bottom : 0;
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
    const dx = full ? ((root && root._scrollLeft) || 0) : 0;
    const dy = full ? ((root && root._scrollTop)  || 0) : 0;
    // A page with no background of its own is white, as a browser's canvas is.
    g.fillStyle = (root && paintColor(root, 'background-color')) ||
                  (doc.body && paintColor(doc.body, 'background-color')) || '#ffffff';
    g.fillRect(0, 0, width, height);

    const painted = root ? boxesInPaintOrder(root) : EMPTY;
    for (const el of painted) {
      if (el === root) continue;                       // its background already filled the canvas
      const r = rectOf(el);                            // zero for anything not rendered
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const x = r.x + dx, y = r.y + dy;
      if (x > width || y > height || x + r.width < 0 || y + r.height < 0) continue;   // off-frame
      clipped(g, el, dx, dy, () => {
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
        // A replaced element's bitmap fills its CONTENT box — the border box less its own borders
        // and padding, which is where layout sized it to sit. `_pixels` is the decoded bitmap of an
        // <img> / SVG <image>, and equally the backing store a <canvas>'s 2D context draws into, so
        // a canvas paints its own drawing here too. The two are sized differently: an image by its
        // INTRINSIC size, a canvas by its width/height, which IS its buffer. Naming both rather
        // than `_naturalWidth || width` keeps this from silently catching some future element
        // whose `width` means something else (`width` answers for img / pre / the table family /
        // video / input). Without this a canvas painted as an empty box, which is what made every
        // canvas WPT reftest compare against a blank page. (A <video>'s decoded frame hangs off
        // `_csimVideoFrame`, not `_pixels`, and is still not painted — backlog.)
        const bitmapWidth = el._tag === 'canvas' ? el.width : el._naturalWidth;
        if (el._pixels && bitmapWidth > 0) {
          const e = contentInset(el);
          const cw = r.width - e.left - e.right, ch = r.height - e.top - e.bottom;
          if (cw > 0 && ch > 0) {
            try { g.drawImage(el, x + e.left, y + e.top, cw, ch); } catch (_) { /* undecodable */ }
          }
        }
      });
    }

    for (const run of runs) {
      if (!run.text || !/\S/.test(run.text)) continue;
      const owner = run.owner;
      if (!owner || owner.nodeType !== NODE_ELEMENT || !owner._lb) continue;
      // The run was recorded in DOCUMENT coordinates by the flow; its owner's box carries the same
      // shift `rectOf` applied, so one subtraction puts the run in the frame with it — inner
      // scrollers and sticky included, without the painter knowing about either.
      // …asked of the owner's LAID-OUT box, not of `rectOf`: a run's owner may generate no box of
      // its own (a `<slot>` is `display: contents`), and its runs still move with the page.
      const owned = laidOutBox(owner);
      const shiftX = owned.x - owner._lb.x, shiftY = owned.y - owner._lb.y;
      const x = run.x + shiftX + dx, y = run.baseline + shiftY + dy;
      if (x > width || y < -40 || y > height + 40) continue;
      clipped(g, owner, dx, dy, () => {
        g.fillStyle = textColor(owner);
        g.font = fontString(owner);
        // Condensed to the advance the FLOW reserved. The rasteriser measures a run differently
        // — for a system font it reports the rounded INK width, where layout sums the face's own
        // `hmtx` advances — and drawing at the rasteriser's width made words overrun the space
        // after them (measured: a 14px "painter" ran 5px past its box and touched the next word).
        // The layout's figure is the one every geometry query reports, so it is the one that wins.
        if (run.width > 0) g.fillText(run.text, x, y, run.width);
        else g.fillText(run.text, x, y);
      });
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
  return recordingRuns((runs) => runs.map(r => ({ text: r.text, x: r.x, y: r.y, width: r.width })));
};

// The host entry point. It hands back a REF to the encoded PNG, which the host already holds:
// `__csim_encodeImage` stashes the bytes on the Ruby side and returns an id for them. Going
// through `toDataURL` instead would pull a megabyte of PNG back into JS only to base64 it and
// push it out again — work the host then undoes. On QuickJS that base64 pass tripped the
// interpreter's execution interrupt outright, so every screenshot failed there.
globalThis.__csimScreenshot = function (full) {
  const canvas = paintPage({ full: !!full });
  if (!canvas || !canvas.width || !canvas.height) return null;
  const pixels = canvas._pixels;
  if (!pixels || typeof globalThis.__csim_encodeImage !== 'function') return null;
  const out = globalThis.__csim_encodeImage(stashTransfer(pixels), canvas.width, canvas.height, 'image/png', 90);
  return out && out.refId ? { refId: out.refId, width: canvas.width, height: canvas.height } : null;
};
