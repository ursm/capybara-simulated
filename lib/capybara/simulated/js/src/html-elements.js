// The HTML element interfaces' members that reflect no content attribute — the generated bindings take those
// (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with. (The tabular data interfaces'
// are html-tables.js's, the form controls' html-forms.js's, the dialog's dialog.js's, the canvas's canvas.js's and the
// media elements' media.js's.)

import { HTML_NS, NODE_ELEMENT } from './constants.js';
import { liveHTMLCollection } from './dom-collections.js';
import {
  assignManualSlottables, childTextContent, collectByTagNameNS, constraintValidationMembers, fallbackBaseURL,
  frameContentDocument, frameContentWindow, labelsOf, linkElementSheet, resolveURLValue, slotAssignedNodes,
  styleElementSheet, templateContent, tokenListFor
} from './dom-nodes.js';
import { formForControl, labeledControlFor } from './form-helpers.js';
import { LONG, UNSIGNED, reflectNumber } from './reflect.js';

const isElement = (node, tag) => node != null && node._nodeType === NODE_ELEMENT && node._ns === HTML_NS && node._localName === tag;

export const htmlTitleElementMembers = {
  // (…its child text content; a write replaces its children with the text, as `textContent`'s)
  get_text: childTextContent,
  set_text(title, value) { title.textContent = value; }
};

export const htmlBaseElementMembers = {
  // (…the `href` content attribute — '' where absent — parsed against the document's FALLBACK base URL, which no `<base>`
  // changes: a base's own href cannot resolve against itself; the value as it is where it parses to no URL)
  get_href(base) {
    const value = base._attrs.href ?? '';
    const url = globalThis.__csim_parseUrl(value, fallbackBaseURL(base.ownerDocument));
    return url && !url.error ? url.href : value;
  }
};

export const htmlMapElementMembers = {
  get_areas: (map) => map._areasColl || (map._areasColl = liveHTMLCollection(() => collectByTagNameNS(map, HTML_NS, 'area')))
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
  get_options: (datalist) => datalist._optionsColl || (datalist._optionsColl = liveHTMLCollection(() => collectByTagNameNS(datalist, HTML_NS, 'option')))
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
    const sheet = styleElementSheet(style);
    return sheet ? sheet.disabled : false;
  },
  set_disabled(style, value) {
    const sheet = styleElementSheet(style);
    if (sheet) sheet.disabled = value;
  },
  get_blocking: (style) => tokenListFor(style, 'blocking'),
  get_sheet: styleElementSheet
};

// HTMLHyperlinkElementUtils (HTML §4.6.4), an `<a>`'s and an `<area>`'s: the element's url its `href` content attribute
// parsed against its node document's base URL — none where that is absent or parses to none — each component read off
// it, and a component written by setting it on the url and writing the url back as the `href` attribute (nothing where
// there is no url).
function hyperlinkURL(el) {
  const value = el._attrs.href;
  if (value == null) return null;
  const href = resolveURLValue(el, value);
  return href === null ? null : new globalThis.URL(href);
}
const component = (name, none = '') => (el) => hyperlinkURL(el)?.[name] ?? none;
const setComponent = (name) => (el, value) => {
  const url = hyperlinkURL(el);
  if (!url) return;
  url[name] = value;
  el._setAttribute('href', url.href);
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
  get_text: (a) => a.textContent,
  set_text(a, value) { a.textContent = value; }
};

export const htmlAreaElementMembers = hyperlinkMembers;

export const htmlLinkElementMembers = {
  get_relList: (link) => tokenListFor(link, 'rel'),
  get_sizes: (link) => tokenListFor(link, 'sizes'),
  get_blocking: (link) => tokenListFor(link, 'blocking'),
  get_sheet: linkElementSheet
};

// The script types HTMLScriptElement.supports() answers for (HTML §4.12.1.1): a classic script, a module and an import
// map — speculation rules are not modelled.
const SUPPORTED_SCRIPT_TYPES = new Set(['classic', 'module', 'importmap']);
export const htmlScriptElementMembers = {
  // (…true while it is "force async" — one no parser inserted, whose `async` no one has set — else its attribute's)
  get_async: (script) => script._forceAsync !== false || script._attrs.async != null,
  set_async(script, value) {
    script._forceAsync = false;
    if (value) script._setAttribute('async', '');
    else script._removeAttribute('async');
  },
  get_blocking: (script) => tokenListFor(script, 'blocking'),
  // (…its child text content; a write replaces its children with the text)
  get_text: childTextContent,
  set_text(script, value) { script.textContent = value; },
  supports: (_, type) => SUPPORTED_SCRIPT_TYPES.has(type)
};

// (…an image's width / height: the attribute's where it has one, else the image's natural size — not yet its rendered
// box's, which HTML asks first of an image being rendered)
const imageSize = (name, natural) => (img) =>
  img._attrs[name] == null ? img[natural] | 0 : reflectNumber(img, name, UNSIGNED, 0, 0, 0);
// (…CSSOM View: its box's edge in the initial containing block — the page — 0 for one not rendered)
const imagePosition = (edge, scroll) => (img) =>
  img.getClientRects().length ? Math.trunc(img.getBoundingClientRect()[edge] + globalThis[scroll]) : 0;
export const htmlImageElementMembers = {
  get_x: imagePosition('left', 'scrollX'),
  get_y: imagePosition('top', 'scrollY'),
  get_width: imageSize('width', '_naturalWidth'),
  get_height: imageSize('height', '_naturalHeight'),
  get_naturalWidth: (img) => img._naturalWidth | 0,
  get_naturalHeight: (img) => img._naturalHeight | 0,
  // (…true with no source to load, or once the load has finished — broken or not)
  get_complete: (img) => !img._attrs.src || !!img._imgComplete,
  // (…the current request's URL once it has completed — a broken image's too — '' while loading or with no source)
  get_currentSrc: (img) => (img._imgComplete || img._imgRequestSrc) ? String(img._imgRequestSrc || img._attrs.src || '') : '',
  // (…resolves once the image is available, rejects with an EncodingError for a broken one: the driver decodes at load,
  // so a complete image resolves at once and a pending one waits for its load / error)
  decode(img) {
    const broken = () => new globalThis.DOMException('The source image cannot be decoded.', 'EncodingError');
    if (!img._attrs.src || img._imgBroken) return Promise.reject(broken());
    if (img._imgComplete) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (ev) => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        if (ev.type === 'load') resolve();
        else reject(broken());
      };
      img.addEventListener('load', done);
      img.addEventListener('error', done);
    });
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
