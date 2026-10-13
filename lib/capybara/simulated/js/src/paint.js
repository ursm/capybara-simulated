// Painting the laid-out page into a raster — what `save_screenshot` hands back. The engine builds the DISPLAY LIST
// (paint.rs `display_list`): what is drawn, where, under which clip and matrix, in which colour and font, in layout's
// paint order — the same boxes and the same style every geometry query and `getComputedStyle` read, so a screenshot can
// only ever show what the driver already believes. The bindings replay it on a 2D context, and hold the one thing it
// names that the engine does not: a replaced element's bitmap (an image's decoded one, a canvas's backing store).
import { stashTransfer } from './bytes.js';
import { scrollOffsetOf } from './native-query-shadow.js';
import { recordingPass, contentExtent, viewportSize } from './layout.js';
import { styleEngineNow } from './cascade.js';
import { bodyOf, documentElementOf } from './document-tree.js';
import { imageRequestOf } from './image-request.js';

// The display list's commands (paint.rs): each a code, then its operands.
const SAVE = 0, RESTORE = 1, MATRIX = 2, CLIP_RECT = 3, CLIP_QUAD = 4, FILL_RECT = 5, IMAGE = 6, TEXT = 7;
function replay(g, [cmds, strings, nodes]) {
  // (…a text's fill, font and direction set only where they change: a piece drawn a glyph at a time repeats them, and a
  // font set is parsed again)
  let fill = -1, font = -1, rtl = -1;
  for (let k = 0; k < cmds.length;) {
    switch (cmds[k++]) {
      case SAVE: g.save(); break;
      // (…which puts back what a text set inside it)
      case RESTORE: g.restore(); fill = font = rtl = -1; break;
      case MATRIX: g.setTransform(cmds[k], cmds[k + 1], cmds[k + 2], cmds[k + 3], cmds[k + 4], cmds[k + 5]); k += 6; break;
      case CLIP_RECT:
        g.beginPath();
        g.rect(cmds[k], cmds[k + 1], cmds[k + 2], cmds[k + 3]);
        g.clip();
        k += 4;
        break;
      case CLIP_QUAD:
        g.beginPath();
        g.moveTo(cmds[k], cmds[k + 1]);
        for (let c = 2; c < 8; c += 2) g.lineTo(cmds[k + c], cmds[k + c + 1]);
        g.closePath();
        g.clip();
        k += 8;
        break;
      case FILL_RECT:
        g.fillStyle = strings[cmds[k]];
        fill = -1;
        g.fillRect(cmds[k + 1], cmds[k + 2], cmds[k + 3], cmds[k + 4]);
        k += 5;
        break;
      case IMAGE: {
        const el = nodes[cmds[k]];
        if (bitmapWidthOf(el)) {
          try { g.drawImage(el, cmds[k + 1], cmds[k + 2], cmds[k + 3], cmds[k + 4]); } catch (_) { /* undecodable */ }
        }
        k += 5;
        break;
      }
      case TEXT: {
        if (fill !== cmds[k]) g.fillStyle = strings[fill = cmds[k]];
        if (font !== cmds[k + 1]) g.font = strings[font = cmds[k + 1]];
        if (rtl !== cmds[k + 2]) g.direction = (rtl = cmds[k + 2]) ? 'rtl' : 'ltr';
        const text = strings[cmds[k + 3]], max = cmds[k + 6];
        if (max === max) g.fillText(text, cmds[k + 4], cmds[k + 5], max);
        else g.fillText(text, cmds[k + 4], cmds[k + 5]);
        k += 7;
        break;
      }
      default: return;
    }
  }
}
// A replaced element's bitmap: `_pixels`, sized as an image by its INTRINSIC size and a canvas by its width / height,
// which IS its buffer — none where it has no pixels yet. (A <video>'s decoded frame hangs off `_csimVideoFrame`, not
// `_pixels`, and is still not painted — backlog.)
function bitmapWidthOf(el) {
  if (!el || !el._pixels) return 0;
  const w = el._tag === 'canvas' ? el.width : imageRequestOf(el).width;
  return w > 0 ? w : 0;
}

// Paint the viewport and return the canvas. `full` paints the whole document instead, which is what a full-page
// screenshot wants.
export function paintPage({ full = false } = {}) {
  const doc = globalThis.document;
  // A document CAN have no root element — `documentElement.remove()` is legal, and WPT tests it. A browser shows a blank
  // page there, so paint one: an empty canvas, not "no screenshot".
  if (!doc) return null;
  const root = documentElementOf(doc);
  recordingPass();
  const vp = viewportSize();
  const width  = Math.max(1, Math.ceil(vp.width));
  const rootExtent = root ? contentExtent(root).height : 0;
  const height = Math.max(1, Math.ceil(full ? Math.max(vp.height, rootExtent) : vp.height));
  // A detached `<canvas>` rather than an `OffscreenCanvas`: the two share the raster stack, but only the element
  // carries `toDataURL`, and the encode has to be SYNCHRONOUS — the host call that takes the screenshot has nowhere to
  // await a Blob.
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // The boxes answer in VIEWPORT coordinates — the root's scroll, an inner scroller's, sticky and fixed all applied —
  // which is exactly the frame being painted. A full-page paint undoes only the root's own scroll, so the whole document
  // lands in frame.
  const dx = full && root ? scrollOffsetOf(root, 0) : 0;
  const dy = full && root ? scrollOffsetOf(root, 1) : 0;
  const body = bodyOf(doc);
  const g = canvas.getContext('2d');
  g.textAlign = 'left';
  replay(g, globalThis.__dom.paintList(root ? root._nid : -1, body ? body._nid : -1, width, height, dx, dy, styleEngineNow()));
  return canvas;
}

// Diagnostic: the text runs a paint would draw, in flow order, with the advance the flow reserved for each. Specs
// assert against it because the pixels alone cannot say WHERE a run was told to go — only that ink landed somewhere.
globalThis.__csimPaintRuns = function () {
  recordingPass();
  const [rows, texts] = globalThis.__dom.paintRuns();
  return texts.map((text, i) => ({ text, x: rows[i * 9], y: rows[i * 9 + 1], baseline: rows[i * 9 + 2], width: rows[i * 9 + 3] }));
};

// The host entry point: the page painted and written as a PNG (`__dom.encodeImage`), handed to the host as a REF to the
// bytes stashed on its side — one crossing as a binary string, not a `data:` URL it would have to undo.
globalThis.__csimScreenshot = function (full) {
  const canvas = paintPage({ full: !!full });
  if (!canvas || !canvas.width || !canvas.height || !canvas._pixels) return null;
  const file = globalThis.__dom.encodeImage(canvas._pixels, canvas.width, canvas.height, 'image/png', NaN);
  return file ? { refId: stashTransfer(file[1]), width: canvas.width, height: canvas.height } : null;
};
