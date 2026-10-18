// An image element's current request — an `<img>`'s, an SVG `<image>`'s, an `<input type=image>`'s — as the engine
// keeps it (image_requests.rs): what its members, a canvas drawing it and the painter read.

import { SVG_NS, isHtml } from './constants.js';
import { inputTypeState } from './form-helpers.js';
import { UNSIGNED, reflectNumber } from './reflect.js';
import { isLaidOutNode } from './cascade.js';
import { contentSize } from './layout.js';

// Its state: whether it is complete, whether it is broken, the decoded bitmap's size, whether it taints a canvas it is
// drawn into, the EXIF turn its decode applied, and its NATURAL size — the bitmap's divided by its source's pixel density
// (a `2x` candidate's 100x50 is 50x25: HTML's density-corrected natural size). (Its URL is `__dom.imageUrl`'s: a `data:`
// URL is the whole image.)
export function imageRequestOf(el) {
  const [complete, broken, width, height, tainted, orientation, density] = globalThis.__dom.imageInfo(el) ?? [];
  const w = width | 0, h = height | 0, d = density > 0 ? density : 1;
  return {
    complete: !!complete, broken: !!broken, width: w, height: h, tainted: !!tainted, orientation: orientation | 0,
    naturalWidth: Math.trunc(w / d), naturalHeight: Math.trunc(h / d)
  };
}
// …whether `el` is one: an `<img>`, an SVG `<image>`, an `<input type=image>`.
export const isImageRequestElement = (el) =>
  isHtml(el, 'img') || (el._ns === SVG_NS && el._localName === 'image') || (isHtml(el, 'input') && inputTypeState(el) === 'image');
// …its `width` / `height` member (HTML §4.8.4.4): an image being rendered its content box's, else the attribute's where
// it has one, else the image's natural size. Chrome: `<img width=100 style="width:30px; padding:5px">` reads 30, the
// same one under `display: none` 100.
export const imageSize = (name) => (el) => {
  const rendered = isLaidOutNode(el) ? contentSize(el) : null;
  if (rendered !== null) return Math.round(rendered[name === 'width' ? 0 : 1]);
  // (…not rendered, its bitmap's: Chrome and Firefox read a `2x` image's 100 there, its `naturalWidth` 50)
  return el._attrs[name] == null ? imageRequestOf(el)[name] : reflectNumber(el, name, UNSIGNED, 0, 0, 0);
};
