// DOMParser and XMLSerializer (HTML §8.5, DOM Parsing), generated from their IDL. A DOMParser is bound to the document
// that made it — its realm's at construction — whose URL a parsed document takes: `new frames[0].DOMParser()` yields one
// with the frame's URL even when called from this realm. Turndown (the quote-reply controller) checks for
// `new DOMParser()` at load and keeps its fast path with it. XML serialization is the arena's (serialize.rs).
import { Document, parseHtmlDocument, parseXml, xmlSerialize } from './dom-nodes.js';
import { NODE_ATTRIBUTE } from './constants.js';
import { appendEdge, clearEdges } from './tree.js';
import { assignOwnerDoc } from './walk.js';
import { isXmlMimeType } from './mime.js';
import { installDOMParser, installXMLSerializer } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

// An XML / XHTML document parsed by the standalone namespace-aware parser (xml-parser.js): no implicit html / head /
// body skeleton, self-closing tags on any element, case-preserved names, processing-instruction / CDATA / doctype
// nodes, xmlns declarations resolved into `_ns` / `_attrNS`; its `documentElement` null where the source has no
// element. It has a browsing context (its location follows the global / frame), its URL and content type the caller's,
// its readyState 'loading' until the load completes — a DOMParser's sets them.
export function parseXMLDocument(xml) {
  const doc = new Document();
  clearEdges(doc);
  doc._url               = undefined;
  doc._noBrowsingContext = false;
  doc._ceDefaultRegistry = globalThis.document && globalThis.document._ceDefaultRegistry;
  doc._readyState        = 'loading';
  for (const node of parseXml(xml)) appendEdge(doc, node);
  return doc;
}

// HTML "parseFromString" of `text` as `type` (a DOMParserSupportedType), for `owner`, the document whose URL it takes:
// an XML-family type parses as XML — its content type its own, so `isHtmlDocument` is false, which gates case-
// sensitivity, `createCDATASection`, … — text/html on the HTML parser. Every node's owner document is the parsed one
// (Turbo Drive's `activateElement` checks `element.ownerDocument !== document` before `importNode`, without which a
// cloned `<turbo-frame>` never upgraded). It has no browsing context (`document.location` null), and its readyState is
// "complete": parsed synchronously and to completion. XMLHttpRequest's document response is one too.
export function parseDocument(text, type, owner) {
  let doc;
  if (isXmlMimeType(type)) {
    doc = parseXMLDocument(text);
    doc._contentType = type;
  } else {
    doc = parseHtmlDocument(text);
  }
  assignOwnerDoc(doc, doc);
  const url = (owner || globalThis.document).URL;
  if (url) doc._url = url;
  doc._noBrowsingContext = true;
  doc._readyState = 'complete';
  return doc;
}

const parserOf = (o) => slotsOf(o, 'DOMParser');
registerInterface('DOMParser', (o) => parserOf(o) !== undefined);
export class DOMParser {
  constructor() {
    makeSlots(this, 'DOMParser', { document: globalThis.document });
  }
}
installDOMParser(DOMParser, {
  // (…the owner's URL read now, so a pushState on it since construction is reflected)
  parseFromString: (parser, string, type) => parseDocument(string, type, parserOf(parser).document)
});
globalThis.DOMParser = DOMParser;

registerInterface('XMLSerializer', (o) => slotsOf(o, 'XMLSerializer') !== undefined);
export class XMLSerializer {
  constructor() {
    makeSlots(this, 'XMLSerializer', {});
  }
}
installXMLSerializer(XMLSerializer, {
  // (…an Attr's the empty string; any other node's its XML serialization, not required well-formed)
  serializeToString: (serializer, root) => (root._nodeType === NODE_ATTRIBUTE ? '' : xmlSerialize(root, false, false))
});
globalThis.XMLSerializer = XMLSerializer;
