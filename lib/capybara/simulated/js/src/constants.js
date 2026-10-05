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
