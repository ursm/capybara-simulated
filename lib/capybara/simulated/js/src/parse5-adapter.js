// parse5 tree adapter → our live DOM nodes.
//
// parse5's `Parser` is engine-agnostic: it builds the tree exclusively through
// an injected "tree adapter" (createElement / appendChild / …). This module
// implements that interface over OUR node classes, so a parse5 parse produces
// the exact same node graph the hand-rolled `parseDocument` builds — `_children`
// / `_parent` links, `_attrs`, `_ns`, `_templateContent`, real DocumentType /
// Comment / Text nodes — which the rest of the driver already understands.
//
// Like installHtmlParser, the DOM constructors are passed in via an install seam
// (they're IIFE-local in bridge.entry.js). parse5 itself comes from the vendor
// bundle (`__csimVendor.parse5.Parser`). Gated behind CSIM_STREAMING_PARSE; the
// default parse path stays the hand-rolled one until this validates.

import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOCTYPE } from './constants.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export function installParse5Adapter({ Document, Element, Text, Comment, DocumentFragment, DocumentType, createHtmlPageDocument }) {
  // parse5 Attribute[] ({name, value, prefix?, namespace?}) → our `_attrs`
  // object. A prefixed foreign attribute (xlink:href, xml:lang) is stored under
  // its qualified name, matching the hand-rolled parser. Only adds names not
  // already present (HTML "adopt attributes" / adoptAttributes semantics).
  function applyAttrs(el, attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const name = a.prefix ? a.prefix + ':' + a.name : a.name;
      if (!Object.prototype.hasOwnProperty.call(el._attrs, name)) el._attrs[name] = a.value;
    }
  }

  const treeAdapter = {
    // ── node creation ──────────────────────────────────────────────
    createDocument() {
      // An HTML document with a browsing context but NO skeleton — parse5
      // constructs <html>/<head>/<body> itself via appendChild.
      return createHtmlPageDocument(false);
    },
    createDocumentFragment() { return new DocumentFragment(); },
    createElement(tagName, namespaceURI, attrs) {
      const el = new Element(tagName);
      if (namespaceURI && namespaceURI !== HTML_NS) el._ns = namespaceURI;
      applyAttrs(el, attrs);
      return el;
    },
    createCommentNode(data) { return new Comment(data); },
    createTextNode(value)   { return new Text(value); },

    // ── tree mutation ──────────────────────────────────────────────
    appendChild(parentNode, newNode) {
      newNode._parent = parentNode;
      parentNode._children.push(newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      const i = parentNode._children.indexOf(referenceNode);
      newNode._parent = parentNode;
      if (i < 0) parentNode._children.push(newNode);
      else parentNode._children.splice(i, 0, newNode);
    },
    detachNode(node) {
      const p = node._parent;
      if (!p) return;
      const i = p._children.indexOf(node);
      if (i >= 0) p._children.splice(i, 1);
      node._parent = null;
    },
    insertText(parentNode, text) {
      const kids = parentNode._children;
      const last = kids[kids.length - 1];
      if (last && last.nodeType === NODE_TEXT) { last._data += text; return; }
      const t = new Text(text);
      t._parent = parentNode;
      kids.push(t);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const kids = parentNode._children;
      const i = kids.indexOf(referenceNode);
      const prev = i > 0 ? kids[i - 1] : null;
      if (prev && prev.nodeType === NODE_TEXT) { prev._data += text; return; }
      this.insertBefore(parentNode, new Text(text), referenceNode);
    },
    adoptAttributes(recipient, attrs) { applyAttrs(recipient, attrs); },

    // ── <template> content fragment ────────────────────────────────
    setTemplateContent(templateElement, contentElement) {
      templateElement._templateContent = contentElement;
    },
    getTemplateContent(templateElement) {
      if (!templateElement._templateContent) templateElement._templateContent = new DocumentFragment();
      return templateElement._templateContent;
    },

    // ── doctype / document mode ─────────────────────────────────────
    setDocumentType(document, name, publicId, systemId) {
      const existing = document._children.find((n) => n.nodeType === NODE_DOCTYPE);
      if (existing) {
        existing.name = String(name);
        existing.publicId = String(publicId == null ? '' : publicId);
        existing.systemId = String(systemId == null ? '' : systemId);
        return;
      }
      const dt = new DocumentType(name, publicId, systemId, document);
      dt._parent = document;
      document._children.push(dt);
    },
    setDocumentMode(document, mode) { document._compatMode = mode; },
    getDocumentMode(document)        { return document._compatMode || 'no-quirks'; },

    // ── reads ───────────────────────────────────────────────────────
    getFirstChild(node)  { return node._children ? (node._children[0] || null) : null; },
    getChildNodes(node)  { return node._children; },
    getParentNode(node)  { return node._parent || null; },
    getAttrList(element) {
      const out = [];
      const a = element._attrs;
      for (const name in a) {
        if (Object.prototype.hasOwnProperty.call(a, name)) out.push({ name, value: a[name] });
      }
      return out;
    },
    getTagName(element)        { return element._localName != null ? element._localName : element._tag; },
    getNamespaceURI(element)   { return element._ns || HTML_NS; },
    getTextNodeContent(textNode)       { return textNode._data; },
    getCommentNodeContent(commentNode) { return commentNode._data; },
    getDocumentTypeNodeName(dt)     { return dt.name; },
    getDocumentTypeNodePublicId(dt) { return dt.publicId; },
    getDocumentTypeNodeSystemId(dt) { return dt.systemId; },

    // ── predicates ──────────────────────────────────────────────────
    isTextNode(node)         { return node.nodeType === NODE_TEXT; },
    isCommentNode(node)      { return node.nodeType === NODE_COMMENT; },
    isDocumentTypeNode(node) { return node.nodeType === NODE_DOCTYPE; },
    isElementNode(node)      { return node.nodeType === NODE_ELEMENT; },

    // ── source-code locations (unused — we don't track them) ────────
    setNodeSourceCodeLocation()    {},
    updateNodeSourceCodeLocation() {},
    getNodeSourceCodeLocation()    { return undefined; },

    // ── open-element-stack hooks (optional; no-op) ──────────────────
    onItemPush() {},
    onItemPop()  {},
  };

  function getParser() {
    const v = globalThis.__csimVendor;
    return v && v.parse5 && v.parse5.Parser;
  }

  // One-shot document parse via parse5 (no streaming yet — the incremental
  // script-blocking driver layers on top in a later step). Returns the parsed
  // Document, or null if parse5 isn't available so callers can fall back.
  function parse5ParseDocument(html) {
    const Parser = getParser();
    if (!Parser) return null;
    const parser = new Parser({ treeAdapter, scriptingEnabled: true });
    parser.tokenizer.write(String(html == null ? '' : html), true);
    return parser.document;
  }

  return { treeAdapter, parse5ParseDocument, getParser };
}
