// DOM Node.nodeType constants. Matches the W3C / WHATWG numeric
// values verbatim so JS / Ruby callers comparing against the spec
// (e.g. `n.nodeType === 1`) work without translation.

export const NODE_ELEMENT  = 1;
export const NODE_ATTRIBUTE = 2;
export const NODE_TEXT     = 3;
export const NODE_CDATA    = 4;
export const NODE_PI       = 7;
export const NODE_COMMENT  = 8;
export const NODE_DOC      = 9;
export const NODE_DOCTYPE  = 10;
export const NODE_FRAGMENT = 11;

// Element namespace URIs. Centralized here because several modules
// (dom-nodes, dom-class-aliases, form-helpers) all need to gate
// "HTML element" / "SVG element" checks on the exact namespace string.
export const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS  = 'http://www.w3.org/2000/svg';
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
export const XLINK_NS  = 'http://www.w3.org/1999/xlink';
export const XML_NS    = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS  = 'http://www.w3.org/2000/xmlns/';

// Whether `el` is the HTML element of that local name — an SVG `<a>`, a MathML `<form>`, or the `FORM` `createElementNS`
// makes in the HTML namespace, none: `_tag` is a lowercased local name of ANY namespace, so a check that means the
// HTML element asks this.
export const isHtml = (el, localName) => el._ns === HTML_NS && el._localName === localName;
// …and the SVG one (an `<image>`, an `<a>`, the root `<svg>`).
export const isSvg = (el, localName) => el._ns === SVG_NS && el._localName === localName;
// …and the local name of an HTML element — none of any other namespace — for a check that tells several apart.
export const htmlLocalName = (el) => (el._ns === HTML_NS ? el._localName : undefined);

// What answers a request — the engine's choice (fetch_rules.rs `fetch_route`, sw-client.js `requestRoute`) — and the
// facts of a request it chooses by.
export const ROUTE_NETWORK = 0, ROUTE_DATA = 1, ROUTE_BLOB = 2, ROUTE_NAVIGATION = 3, ROUTE_REFUSED = 4, ROUTE_SERVICE_WORKER = 5, ROUTE_KEEPALIVE = 6;
export const FETCH_CONTROLLED = 1, FETCH_SYNC = 2, FETCH_KEEPALIVE = 4, FETCH_NAVIGATE = 8, FETCH_IN_WORKER = 16, FETCH_SAME_ORIGIN = 32;
// What a subresource's response comes to for the consumer that fetched it — the engine's verdict (subresource_judge.rs
// `judge`): the consumer, what answered (and what the bindings saw of its body), and the verdict's bits.
export const J_CLASSIC_SCRIPT = 1, J_WORKER_IMPORT = 2, J_SHEET = 3, J_CSS_MODULE = 4, J_LINK = 5, J_PREFETCH = 6, J_IMAGE = 7, J_VIDEO = 8, J_AUDIO = 9, J_FONT = 10, J_OBJECT = 11, J_CSS_IMAGE = 12, J_EMBED = 13, J_TIMED = 14, J_MODULE_SCRIPT = 15;
// …and the fetches only a Resource Timing entry is filed for (resource_timing.rs `initiator_of`): a frame's document, a
// dedicated worker's main script (a module worker's `| WORKER_MODULE << 8`), a fetch() (a beacon's
// `| FETCH_BEACON << 8`), an XMLHttpRequest, an EventSource's connection.
export const J_FRAME = 16, J_WORKER_SCRIPT = 17, J_FETCH = 18, J_XHR = 19, J_EVENT_SOURCE = 20, WORKER_MODULE = 1, FETCH_BEACON = 1;
export const SRC_NETWORK = 0, SRC_ASSET = 1, SRC_SW_SYNC = 2, SRC_SW_EVENT = 3, SRC_SCHEME = 4, S_NO_BODY = 8, S_EMPTY = 16;
export const V_OK = 1, V_FETCHED = 2, V_CROSS_ORIGIN = 4;
