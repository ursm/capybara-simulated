// Painting the laid-out page into a raster — what `save_screenshot` hands back. The engine builds the DISPLAY LIST
// (paint.rs `display_list`): what is drawn, where, under which clip and matrix, in which colour and font, in layout's
// paint order — the same boxes and the same style every geometry query and `getComputedStyle` read, so a screenshot can
// only ever show what the driver already believes. The bindings replay it on a 2D context, and hold the one thing it
// names that the engine does not: a replaced element's bitmap (an image's decoded one, a canvas's backing store).
import { stashTransfer } from './bytes.js';
import { scrollOffsetOf } from './native-query-shadow.js';
import { recordingPass, contentExtent, viewportSize } from './layout.js';
import { bodyOf, documentElementOf } from './document-tree.js';
import { imageRequestOf } from './image-request.js';
import { canvasBitmapOf, canvasSize, contextAttributeName, paintSurface, setContextAttribute, surfacePixels } from './canvas.js';
import { isHtml } from './constants.js';

// The display list's commands (paint.rs): each a code, then its operands.
const SAVE = 0, RESTORE = 1, MATRIX = 2, CLIP_RECT = 3, CLIP_QUAD = 4, FILL_RECT = 5, IMAGE = 6, TEXT = 7;
function replay(g, [cmds, strings, nodes]) {
  // (…`g` the context's engine: its methods take the arguments the binding would have converted, a clip its path and
  // rule, a drawImage all its source and destination rectangle)
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
        g.clip(null, 'nonzero');
        k += 4;
        break;
      case CLIP_QUAD:
        g.beginPath();
        g.moveTo(cmds[k], cmds[k + 1]);
        for (let c = 2; c < 8; c += 2) g.lineTo(cmds[k + c], cmds[k + c + 1]);
        g.closePath();
        g.clip(null, 'nonzero');
        k += 8;
        break;
      case FILL_RECT:
        setContextAttribute(g, 'fillStyle', strings[cmds[k]]);
        fill = -1;
        g.fillRect(cmds[k + 1], cmds[k + 2], cmds[k + 3], cmds[k + 4]);
        k += 5;
        break;
      case IMAGE: {
        const el = nodes[cmds[k]];
        if (bitmapWidthOf(el)) {
          try { g.drawImage(el, 0, 0, undefined, undefined, cmds[k + 1], cmds[k + 2], cmds[k + 3], cmds[k + 4]); } catch (_) { /* undecodable */ }
        }
        k += 5;
        break;
      }
      case TEXT: {
        if (fill !== cmds[k]) setContextAttribute(g, 'fillStyle', strings[fill = cmds[k]]);
        if (font !== cmds[k + 1]) setContextAttribute(g, 'font', strings[font = cmds[k + 1]]);
        if (rtl !== cmds[k + 2]) setContextAttribute(g, 'direction', (rtl = cmds[k + 2]) ? 'rtl' : 'ltr');
        const text = strings[cmds[k + 3]], max = cmds[k + 6];
        g.fillText(text, cmds[k + 4], cmds[k + 5], max === max ? max : undefined);
        k += 7;
        break;
      }
      default: return;
    }
  }
}
// A replaced element's bitmap: an image's `_pixels`, sized by its INTRINSIC size, and a canvas's (its context's, the
// engine's: `canvasBitmapOf`), by its width / height, which IS its buffer — none where it has no pixels yet. (A
// <video>'s decoded frame hangs off `_csimVideoFrame`, and is still not painted — backlog.)
function bitmapWidthOf(el) {
  if (!el) return 0;
  const canvas = isHtml(el, 'canvas');
  if (!(canvas ? canvasBitmapOf(el) : el._pixels)) return 0;
  const w = canvas ? canvasSize(el)[0] : imageRequestOf(el).width;
  return w > 0 ? w : 0;
}

// Paint the viewport and return the context's engine and its size. `full` paints the whole document instead, which is
// what a full-page screenshot wants; `surface` makes what it paints into, of that size.
export function paintPage({ full = false, surface = paintSurface } = {}) {
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
  // (…the platform's own surface: a page that replaced `createElement`, a canvas's size or `getContext` — a canvas
  // fingerprinting shim — paints the same)
  const g = surface(width, height);
  // The boxes answer in VIEWPORT coordinates — the root's scroll, an inner scroller's, sticky and fixed all applied —
  // which is exactly the frame being painted. A full-page paint undoes only the root's own scroll, so the whole document
  // lands in frame.
  const dx = full && root ? scrollOffsetOf(root, 0) : 0;
  const dy = full && root ? scrollOffsetOf(root, 1) : 0;
  const body = bodyOf(doc);
  setContextAttribute(g, 'textAlign', 'left');
  replay(g, globalThis.__dom.paintList(root ? root._nid : -1, body ? body._nid : -1, width, height, dx, dy));
  return { g, width, height };
}

// Diagnostic: the text runs a paint would draw, in flow order, with the advance the flow reserved for each. Specs
// assert against it because the pixels alone cannot say WHERE a run was told to go — only that ink landed somewhere.
globalThis.__csimPaintRuns = function () {
  recordingPass();
  const [rows, texts] = globalThis.__dom.paintRuns();
  return texts.map((text, i) => ({ text, x: rows[i * 9], y: rows[i * 9 + 1], baseline: rows[i * 9 + 2], width: rows[i * 9 + 3] }));
};

// …and the texts it draws, each with the direction it is drawn in: the paint replayed into a recorder of the calls.
globalThis.__csimPaintTexts = function () {
  const texts = [], attributes = {};
  const none = () => {};
  const recorder = {
    save: none, restore: none, setTransform: none, beginPath: none, rect: none, clip: none, moveTo: none, lineTo: none,
    closePath: none, fillRect: none, drawImage: none,
    _set: (attribute, value) => { attributes[contextAttributeName(attribute)] = value; },
    fillText: (text) => { texts.push({ text, direction: attributes.direction }); }
  };
  paintPage({ surface: () => recorder });
  return texts;
};

// The host entry point: the page painted and written as a PNG (`__dom.encodeImage`), handed to the host as a REF to the
// bytes stashed on its side — one crossing as a binary string, not a `data:` URL it would have to undo.
globalThis.__csimScreenshot = function (full) {
  const painted = paintPage({ full: !!full });
  const pixels = painted && surfacePixels(painted.g);
  if (!pixels) return null;
  const file = globalThis.__dom.encodeImage(pixels, painted.width, painted.height, 'image/png', NaN);
  return file ? { refId: stashTransfer(file[1]), width: painted.width, height: painted.height } : null;
};
