// DOM Node.nodeType constants. Matches the W3C / WHATWG numeric
// values verbatim so JS / Ruby callers comparing against the spec
// (e.g. `n.nodeType === 1`) work without translation.

export const NODE_ELEMENT  = 1;
export const NODE_ATTRIBUTE = 2;
export const NODE_TEXT     = 3;
export const NODE_PI       = 7;
export const NODE_COMMENT  = 8;
export const NODE_DOC      = 9;
export const NODE_DOCTYPE  = 10;
export const NODE_FRAGMENT = 11;

// Install the full DOM Level 4 nodeType set onto both the `Node`
// constructor and `Node.prototype`. Spec exposes the same constants
// in both places (`Node.ELEMENT_NODE === node.ELEMENT_NODE`) and
// libraries probe both — Stimulus's `elementFromNode` reads
// `Node.ELEMENT_NODE` directly; some jQuery paths read it off the
// instance. CDATA / processing-instruction / document-type are
// included because DOMPurify and serializer libraries enumerate the
// full set even though we don't construct those node kinds.
export function installNodeConstants(Node) {
  const c = {
    ELEMENT_NODE:                1,
    ATTRIBUTE_NODE:              2,
    TEXT_NODE:                   3,
    CDATA_SECTION_NODE:          4,
    ENTITY_REFERENCE_NODE:       5,
    ENTITY_NODE:                 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE:                8,
    DOCUMENT_NODE:               9,
    DOCUMENT_TYPE_NODE:          10,
    DOCUMENT_FRAGMENT_NODE:      11,
    NOTATION_NODE:               12,

    DOCUMENT_POSITION_DISCONNECTED:            0x01,
    DOCUMENT_POSITION_PRECEDING:               0x02,
    DOCUMENT_POSITION_FOLLOWING:               0x04,
    DOCUMENT_POSITION_CONTAINS:                0x08,
    DOCUMENT_POSITION_CONTAINED_BY:            0x10,
    DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 0x20
  };
  for (const k in c) {
    Node[k] = c[k];
    Node.prototype[k] = c[k];
  }
}
