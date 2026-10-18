// The HTML element interfaces' members that reflect no content attribute — the generated bindings take those
// (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with. (The tabular data interfaces'
// are html-tables.js's, the form controls' html-forms.js's, the dialog's dialog.js's, the canvas's canvas.js's and the
// media elements' media.js's.)

import { HTML_NS, NODE_ELEMENT } from './constants.js';
import { parseURL, urlComponents } from './url-parse.js';
import { liveHTMLCollection } from './dom-collections.js';
import {
  assignManualSlottables, collectByTagNameNS, constraintValidationMembers, frameContentDocument,
  frameContentWindow, labelsOf, slotAssignedNodes, templateContent, tokenListFor
} from './dom-nodes.js';
import { documentEncoding, fallbackBaseURL, resolveURLValue } from './base-url.js';
import { formForControl, labeledControlFor } from './form-helpers.js';
import { awaitImageDecode, childTextContent, imageDecodeError, sameObject, settledScrollOffsetOf, sheetOfOwner } from './native-query-shadow.js';
import { documentElementOf } from './document-tree.js';
import { LONG, reflectNumber } from './reflect.js';
import { imageRequestOf, imageSize } from './image-request.js';
import { firstBoxOriginOf } from './layout.js';

const isElement = (node, tag) => node != null && node._nodeType === NODE_ELEMENT && node._ns === HTML_NS && node._localName === tag;

export const htmlTitleElementMembers = {
  // (…its child text content; a write replaces its children with the text, as `textContent`'s)
  get_text: childTextContent,
  set_text(title, value) { title._textContent = value; }
};

export const htmlBaseElementMembers = {
  // (…the `href` content attribute — '' where absent — parsed against the document's FALLBACK base URL, which no `<base>`
  // changes: a base's own href cannot resolve against itself — in the document's encoding; the value as it is where it
  // parses to no URL)
  get_href(base) {
    const value = base._attrs.href ?? '';
    const doc = base._ownerDocument;
    return parseURL(value, fallbackBaseURL(doc), documentEncoding(doc))?.href ?? value;
  }
};

export const htmlMapElementMembers = {
  get_areas: (map) => sameObject(map, 'areas', () => liveHTMLCollection(() => collectByTagNameNS(map, HTML_NS, 'area')))
};

export const htmlLabelElementMembers = {
  get_control: (label) => labeledControlFor(label) || null,
  // (…its labeled control's form owner, not its own ancestor form's)
  get_form(label) {
    const control = labeledControlFor(label);
    return control ? (formForControl(control) || null) : null;
  }
};

export const htmlLegendElementMembers = {
  // (…its parent fieldset's form owner — a direct parent only — not its own ancestor form's)
  get_form: (legend) => isElement(legend._parent, 'fieldset') ? (formForControl(legend._parent) || null) : null
};

export const htmlDataListElementMembers = {
  get_options: (datalist) => sameObject(datalist, 'options', () => liveHTMLCollection(() => collectByTagNameNS(datalist, HTML_NS, 'option')))
};

export const htmlEmbedElementMembers = {
  // (…an embed has no content navigable here, so no SVG document)
  getSVGDocument: () => null
};

export const htmlFrameElementMembers = {
  get_contentWindow: frameContentWindow,
  get_contentDocument: frameContentDocument
};

// A marquee's loop count: its `loop` content attribute where that parses to an integer above zero, else −1 (forever).
// Nothing animates a marquee here, so `start` / `stop` have no marquee to start or stop.
function marqueeLoopCount(marquee) {
  const value = reflectNumber(marquee, 'loop', LONG, -1, 0, 0);
  return value > 0 ? value : -1;
}
export const htmlMarqueeElementMembers = {
  get_loop: marqueeLoopCount,
  // (…a new count, above zero or −1, written; any other ignored)
  set_loop(marquee, value) {
    if ((value > 0 || value === -1) && value !== marqueeLoopCount(marquee)) marquee._setAttribute('loop', String(value));
  },
  start() {},
  stop() {}
};

// (…a meter's actual value, minimum, maximum, low, high and optimum points and a progress bar's current value and
// position: the engine's, of their content attributes — reflect.rs)
const meterValue = (which) => (meter) => globalThis.__dom.meterValue(meter._nid, which);
export const htmlMeterElementMembers = {
  get_value: meterValue(0),
  get_min: meterValue(1),
  get_max: meterValue(2),
  get_low: meterValue(3),
  get_high: meterValue(4),
  get_optimum: meterValue(5),
  get_labels: labelsOf
};

const progressValue = (which) => (progress) => globalThis.__dom.progressValue(progress._nid, which);
export const htmlProgressElementMembers = {
  get_value: progressValue(0),
  get_position: progressValue(2),
  get_labels: labelsOf
};

export const htmlTemplateElementMembers = {
  get_content: templateContent
};

export const htmlSlotElementMembers = {
  // (…flattened through nested slots and fallback content where `options.flatten` says)
  assignedNodes: (slot, options) => slotAssignedNodes(slot, options),
  assignedElements: (slot, options) => slotAssignedNodes(slot, options).filter((n) => n._nodeType === NODE_ELEMENT),
  assign(slot, nodes) { assignManualSlottables(slot, nodes); }
};

export const htmlTrackElementMembers = {
  // (…its text track's readiness: NONE — no text track is loaded here, §4.8.13.5)
  get_readyState: () => 0
};

export const htmlStyleElementMembers = {
  // (…its sheet's disabled flag, CSSOM's — false, and a write nothing, with no sheet)
  get_disabled(style) {
    const sheet = sheetOfOwner(style);
    return sheet ? sheet.disabled : false;
  },
  set_disabled(style, value) {
    const sheet = sheetOfOwner(style);
    if (sheet) sheet.disabled = value;
  },
  get_blocking: (style) => tokenListFor(style, 'blocking'),
  get_sheet: sheetOfOwner
};

// HTMLHyperlinkElementUtils (HTML §4.6.4), an `<a>`'s and an `<area>`'s: the element's url its `href` content attribute
// parsed against its node document's base URL — none where that is absent or parses to none — each component read off
// it (the native parser's, not the `URL` a page can replace), and a component written by setting it on the url as the
// URL interface's setter does (url_ops.rs `urlSet`) and writing the url back as the `href` attribute — as it was where
// the setter took nothing; nothing where there is no url.
function hyperlinkURL(el) {
  const value = el._attrs.href;
  if (value == null) return null;
  const parts = globalThis.__dom.docParseUrl(el._ownerDocument._nid, value, true);
  return parts === null ? null : urlComponents(parts);
}
const component = (name, none = '') => (el) => hyperlinkURL(el)?.[name] ?? none;
const setComponent = (name) => (el, value) => {
  const url = hyperlinkURL(el);
  if (!url) return;
  const parts = globalThis.__dom.urlSet(url.href, name, String(value));
  el._setAttribute('href', parts === null ? url.href : parts[0]);
};
const hyperlinkMembers = {
  // (…the url serialized; the attribute's value where it parses to none, '' where there is none)
  get_href(el) {
    const value = el._attrs.href;
    return value == null ? '' : (resolveURLValue(el, value) ?? value);
  },
  get_origin: component('origin'),
  // (…':' where there is no url)
  get_protocol: component('protocol', ':'),
  set_protocol: setComponent('protocol'),
  get_username: component('username'),
  set_username: setComponent('username'),
  get_password: component('password'),
  set_password: setComponent('password'),
  get_host: component('host'),
  set_host: setComponent('host'),
  get_hostname: component('hostname'),
  set_hostname: setComponent('hostname'),
  get_port: component('port'),
  set_port: setComponent('port'),
  get_pathname: component('pathname'),
  set_pathname: setComponent('pathname'),
  get_search: component('search'),
  set_search: setComponent('search'),
  get_hash: component('hash'),
  set_hash: setComponent('hash'),
  get_relList: (el) => tokenListFor(el, 'rel')
};

export const htmlAnchorElementMembers = {
  ...hyperlinkMembers,
  // (…its text content, both ways)
  get_text: (a) => a._textContent,
  set_text(a, value) { a._textContent = value; }
};

export const htmlAreaElementMembers = hyperlinkMembers;

export const htmlLinkElementMembers = {
  get_relList: (link) => tokenListFor(link, 'rel'),
  get_sizes: (link) => tokenListFor(link, 'sizes'),
  get_blocking: (link) => tokenListFor(link, 'blocking'),
  get_sheet: sheetOfOwner
};

// The script types HTMLScriptElement.supports() answers for (HTML §4.12.1.1): a classic script, a module and an import
// map — speculation rules are not modelled.
const SUPPORTED_SCRIPT_TYPES = new Set(['classic', 'module', 'importmap']);
export const htmlScriptElementMembers = {
  // (…true while it is "force async" — one no parser inserted, whose `async` no one has set — else its attribute's)
  get_async: (script) => script._forceAsync || script._attrs.async != null,
  set_async(script, value) {
    script._forceAsync = false;
    if (value) script._setAttribute('async', '');
    else script._removeAttribute('async');
  },
  get_blocking: (script) => tokenListFor(script, 'blocking'),
  // (…its child text content; a write replaces its children with the text)
  get_text: childTextContent,
  set_text(script, value) { script._textContent = value; },
  supports: (_, type) => SUPPORTED_SCRIPT_TYPES.has(type)
};

// (…CSSOM View: the border edge of its first box, no transform applied, relative to the initial containing block's
// origin — the page's, so the viewport's own scroll is added back to where the engine finds the box in it
// (`firstBoxOriginOf`) — 0 for one not rendered. Chrome and Firefox both give the viewport's position, unscrolled: the
// spec says otherwise, and it wins.)
const imagePosition = (axis) => (img) => {
  const origin = firstBoxOriginOf(img);
  if (origin === null) return 0;
  const root = documentElementOf(img._ownerDocument);
  return Math.trunc(origin[axis] + (root ? settledScrollOffsetOf(root, axis) : 0));
};
export const htmlImageElementMembers = {
  get_x: imagePosition(0),
  get_y: imagePosition(1),
  get_width: imageSize('width'),
  get_height: imageSize('height'),
  get_naturalWidth: (img) => imageRequestOf(img).width,
  get_naturalHeight: (img) => imageRequestOf(img).height,
  // (…true with no source selected — no `src`, `srcset` or `<picture>` candidate — or once the load has finished, broken
  // or not)
  get_complete: (img) => !img._imageResourceSrc() || imageRequestOf(img).complete,
  // (…the current request's URL: the source selected, from its load's start; '' with none)
  get_currentSrc: (img) => globalThis.__dom.imageUrl(img) ?? '',
  // (…resolves once the image is available, rejects with an EncodingError for a broken one: the driver decodes at load,
  // so a complete image resolves at once and a pending one waits for its load / error)
  decode(img) {
    const r = imageRequestOf(img);
    if (!img._imageResourceSrc() || r.broken) return Promise.reject(imageDecodeError());
    return r.complete ? Promise.resolve() : awaitImageDecode(img);
  }
};

// An iframe's: its srcdoc, its sandbox, its nested browsing context — and, its content being no SVG document here, no
// SVG document.
export const htmlIFrameElementMembers = {
  get_srcdoc: (iframe) => iframe._attrs.srcdoc ?? '',
  // (…through the attribute, whose change steps navigate the frame to the document)
  set_srcdoc(iframe, value) { iframe._setAttribute('srcdoc', value); },
  get_sandbox: (iframe) => tokenListFor(iframe, 'sandbox'),
  get_contentWindow: frameContentWindow,
  get_contentDocument: frameContentDocument,
  getSVGDocument: () => null
};

// An object element's: it has no nested browsing context here, so no content document, window or SVG document; it is
// a listed element, its form owner and constraint validation the form controls'.
export const htmlObjectElementMembers = {
  ...constraintValidationMembers,
  get_form: (object) => formForControl(object) || null,
  get_contentDocument: () => null,
  get_contentWindow: () => null,
  getSVGDocument: () => null
};
