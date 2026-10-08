// DOMParser and XMLSerializer (HTML §8.5, DOM Parsing), generated from their IDL. A DOMParser is bound to the document
// that made it — its realm's at construction — whose URL a parsed document takes: `new frames[0].DOMParser()` yields one
// with the frame's URL even when called from this realm. Turndown (the quote-reply controller) checks for
// `new DOMParser()` at load and keeps its fast path with it. XML serialization is the arena's (serialize.rs).
import { Document, newXMLDocument, parseHtmlDocument, parseXml, xmlSerialize } from './dom-nodes.js';
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
// its readyState 'loading' until the load completes — a DOMParser's sets them. It is parsed into `doc`, a Document unless
// the caller makes it an XMLDocument.
export function parseXMLDocument(xml, doc = new Document()) {
  clearEdges(doc);
  doc._url               = undefined;
  doc._noBrowsingContext = false;
  doc._ceDefaultRegistry = globalThis.document && globalThis.document._ceDefaultRegistry;
  doc._readyState        = 'loading';
  for (const node of parseXml(xml)) appendEdge(doc, node);
  return doc;
}

// A document of `text` — DOMParser's "parseFromString", XMLHttpRequest's document response: XML where `xml` (its
// `isHtmlDocument` then false, which gates case-sensitivity, `createCDATASection`, …), HTML otherwise; its content type
// `contentType` and its URL `url`. Every node's owner document is the parsed one (Turbo Drive's `activateElement` checks
// `element.ownerDocument !== document` before `importNode`, without which a cloned `<turbo-frame>` never upgraded). It
// has no browsing context (`document.location` null), and its readyState is "complete": parsed synchronously and to
// completion. An XML one is an XMLDocument where `xmlDocument` — XHR's, which says only "a document", as Chrome and
// Firefox make it — and a Document otherwise: HTML's parseFromString makes "a new Document", as WPT's
// DOMParser-parseFromString-xml asserts (Chrome and Firefox make an XMLDocument there too).
export function parseDocument(text, xml, contentType, url, xmlDocument = false) {
  const doc = xml ? parseXMLDocument(text, xmlDocument ? newXMLDocument() : new Document()) : parseHtmlDocument(text);
  doc._contentType = contentType;
  assignOwnerDoc(doc, doc);
  if (url) doc._url = url;
  doc._noBrowsingContext = true;
  doc._readyState = 'complete';
  return doc;
}

// A parser's slots: its relevant global, whose associated document's URL a parsed document takes — read at the parse, so
// a pushState since is reflected — and the parse of its realm, where the document is made (Web IDL's realm of `this`,
// not of the method: `frame.DOMParser.prototype.parseFromString.call(new DOMParser(), …)` is this realm's document).
const parserOf = (o) => slotsOf(o, 'DOMParser');
registerInterface('DOMParser', (o) => parserOf(o) !== undefined);
export class DOMParser {
  constructor() {
    makeSlots(this, 'DOMParser', { global: globalThis, parse: parseDocument });
  }
}
installDOMParser(DOMParser, {
  // (…an XML-family type parses as XML, its content type the type; text/html on the HTML parser)
  parseFromString(parser, string, type) {
    const s = parserOf(parser);
    return s.parse(string, isXmlMimeType(type), type, s.global.document.URL);
  }
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
