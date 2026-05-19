// DOM Node.nodeType constants. Matches the W3C / WHATWG numeric
// values verbatim so JS / Ruby callers comparing against the spec
// (e.g. `n.nodeType === 1`) work without translation.

export const NODE_ELEMENT  = 1;
export const NODE_TEXT     = 3;
export const NODE_COMMENT  = 8;
export const NODE_DOC      = 9;
export const NODE_FRAGMENT = 11;
