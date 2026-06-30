// XPath 1.0 via the standalone `xpathway` engine (replaces the vendored,
// unmaintained wgxpath blob). xpathway never imports a node type — it runs over
// our bridge Node objects through the small adapter below, then exposes the DOM
// Level 3 XPath surface (`evaluate` / `createExpression` / `createNSResolver`)
// which we install onto Document.prototype, exactly where wgxpath used to patch.
//
// The empty-string-attribute existence trap that wgxpath had
// (`<span contenteditable="">` → `[@contenteditable]` false) cannot recur here:
// xpathway's attribute axis walks the materialized attribute nodes and applies
// the name test to them, never `!!getAttribute(name)`.

import { isHtmlDocument } from './mime.js';

const X = globalThis.__csimVendor && globalThis.__csimVendor.xpathway;

const DOCUMENT_POSITION_FOLLOWING = 4;

// A doc has XML XPath semantics (case-sensitive names) only if it was XML-PARSED;
// a non-HTML, non-XML response (text/plain, application/json, text/css) is
// HTML-parsed and keeps HTML semantics despite its `contentType` reflection — else
// a lowercase `/html` query misses the uppercase nodeName (Discourse `become.json`).
const isHtmlDoc = isHtmlDocument;

// XPath string-value of a node, per kind.
function stringValue(n) {
  switch (n.nodeType) {
    case 2:                   return n.value;        // attribute
    case 3: case 7: case 8:   return n.data;         // text, PI, comment
    case 9: case 11: {
      // Root / fragment: the XPath string-value is the concatenation of all
      // descendant text. We can't use `.textContent` — DOM spec (and this
      // codebase) make Document/DocumentType textContent null — so walk the
      // children, recursing into elements (whose textContent is already the
      // Text-only concatenation) and collecting Text data directly.
      let s = '';
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.data;            // text
        else if (c.nodeType === 1) s += c.textContent; // element
      }
      return s;
    }
    default:                  return n.textContent;  // element
  }
}

// DOM adapter (§5 of xpathway's REQUIREMENTS): opaque node handles are our own
// Node objects, so every operation is a thin duck-typed delegation.
const adapter = {
  nodeType:      n => n.nodeType,
  parent:        n => n.parentNode,
  childNodes:    n => n.childNodes,
  ownerDocument: n => n.ownerDocument,
  // localName/namespaceURI are IDL members of Element/Attr only (not Node), so
  // a Text/Comment/Document node doesn't expose them — coerce the resulting
  // undefined back to null, the value the XPath data model wants for nodes
  // without an expanded-name (matches the old CharacterData null getters).
  localName:     n => n.localName ?? null,
  namespaceURI:  n => n.namespaceURI ?? null,
  nodeName:      n => n.nodeName,
  // Plain Attr array for xpathway's attribute axis — built directly from the
  // store (the public `attributes` NamedNodeMap is a non-Array legacy platform
  // object, and rebuilding it per visited element would be wasted work here).
  attributes:    el => el._attrs ? Object.keys(el._attrs).map(k => el._attrNodeFor(k)) : [],
  getAttribute:  (el, ns, ln) => (ns == null ? el.getAttribute(ln) : el.getAttributeNS(ns, ln)),
  stringValue,
  // xpathway wants a comparator (negative / 0 / positive), not the DOM bitmask.
  // FOLLOWING set on `a.compareDocumentPosition(b)` means b follows a in document
  // order, i.e. a precedes b → negative. (Covers the contained-by case too.)
  compareDocumentPosition: (a, b) =>
    a === b ? 0 : ((a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING) ? -1 : 1),
  getElementById: (doc, id) => (doc.getElementById ? doc.getElementById(id) : null),
  isHtmlDocument: doc => isHtmlDoc(doc),
  nextSibling:     n => n.nextSibling,
  previousSibling: n => n.previousSibling,
};

// Install the DOM L3 XPath surface onto the given Document prototype. Called
// once at boot (bridge.entry.js), after Document and __csimVendor are present.
export function installXPath(DocumentProto) {
  // Fail loud at boot if the engine didn't make it into the vendor bundle —
  // otherwise every find_xpath would silently return [] (document.evaluate
  // undefined → __csimEvaluateXPath's catch swallows it), which reads as a
  // test-wide ElementNotFound with no pointer at the real cause.
  if (!X) {
    throw new Error('xpathway engine missing from vendor bundle (__csimVendor.xpathway undefined) — rebuild vendor.bundle.js');
  }
  if (!DocumentProto) return;
  const evaluator = X.createEvaluator(adapter, {
    // Make grammar errors real DOMExceptions so app JS sees err.name ===
    // 'SyntaxError'; type errors stay native TypeErrors.
    exceptions: {
      syntaxError: m => new globalThis.DOMException(String(m), 'SyntaxError'),
      typeError:   m => new globalThis.TypeError(String(m)),
    },
  });

  DocumentProto.evaluate = function (expression, contextNode, resolver, type, result) {
    return evaluator.evaluate(expression, contextNode, resolver, type, result);
  };
  DocumentProto.createExpression = function (expression, resolver) {
    return evaluator.createExpression(expression, resolver);
  };
  DocumentProto.createNSResolver = function (node) {
    return evaluator.createNSResolver(node);
  };

  // Expose XPathResult globally for app JS reading its type constants.
  if (X.XPathResult) globalThis.XPathResult = X.XPathResult;
}
