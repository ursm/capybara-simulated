// An image element's current request — an `<img>`'s, an SVG `<image>`'s, an `<input type=image>`'s — as the engine
// keeps it (image_requests.rs): what its members, a canvas drawing it and the painter read.

import { inputTypeState } from './form-helpers.js';
import { UNSIGNED, reflectNumber } from './reflect.js';

// Its state: whether it is complete, whether it is broken, the decoded image's size, whether it taints a canvas it is
// drawn into, and the EXIF turn its decode applied. (Its URL is `__dom.imageUrl`'s: a `data:` URL is the whole image.)
export function imageRequestOf(el) {
  const [complete, broken, width, height, tainted, orientation] = globalThis.__dom.imageInfo(el) ?? [];
  return { complete: !!complete, broken: !!broken, width: width | 0, height: height | 0, tainted: !!tainted, orientation: orientation | 0 };
}
// …whether `el` is one: an `<img>`, an SVG `<image>`, an `<input type=image>`.
export const isImageRequestElement = (el) =>
  el._tag === 'img' || el._tag === 'image' || (el._tag === 'input' && inputTypeState(el) === 'image');
// …its `width` / `height` member: the attribute's where it has one, else the image's natural size — not yet its rendered
// box's, which HTML asks first of an image being rendered.
export const imageSize = (name) => (el) =>
  el._attrs[name] == null ? imageRequestOf(el)[name] : reflectNumber(el, name, UNSIGNED, 0, 0, 0);
