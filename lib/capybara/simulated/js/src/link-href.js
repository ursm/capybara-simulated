// The URL an element's `href` names, for the readers that meet SVG elements as well as HTML ones: an SVG `<a>`,
// `<image>` or `<use>` takes its `href` from the attribute in NO namespace (SVG 2) when there is one — an EMPTY one
// included — and else from the XLink namespace's (SVG 1.1 — `xlink:href`, or `setAttributeNS(XLINK, 'href', …)` with
// no prefix, which libraries write; a `setAttribute('xlink:href', …)` is an attribute in no namespace and names
// nothing). Chrome and Firefox measured: an `<image href="">` beside a valid XLink href fails to load. An HTML element
// has only the first. Read by namespace and local name, since a namespaced attribute is stored under its qualified
// name or a synthetic key, never under the bare `href` a plain one takes.
import { SVG_NS, XLINK_NS } from './constants.js';

// The XLink `href`, or null.
export function xlinkHref(el) {
  return el._attrNS ? el.getAttributeNS(XLINK_NS, 'href') : null;
}
// The `href` (null when there is none): an SVG element falls back to its XLink one.
export function hrefAttr(el) {
  const h = el._attrs.href;
  return h != null || el._ns !== SVG_NS ? h : xlinkHref(el);
}
