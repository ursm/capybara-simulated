// parse5 tree adapter → our live DOM nodes.
//
// parse5's `Parser` is engine-agnostic: it builds the tree exclusively through
// an injected "tree adapter" (createElement / appendChild / …). This module
// implements that interface over OUR node classes, so a parse5 parse produces
// the exact same node graph the hand-rolled `parseDocument` builds — `_children`
// / `_parent` links, `_attrs`, `_ns`, `_templateContent`, real DocumentType /
// Comment / Text nodes — which the rest of the driver already understands.
//
// Two entry points:
//   - `parse5ParseDocument(html)` — one-shot, into a FRESH document. For
//     DOMParser / standalone parses.
//   - `parse5ParseIntoLive(liveDoc, html)` — parse directly into the LIVE
//     `globalThis.document`, REUSING its `document` / `<html>` / `<head>` /
//     `<body>` identities (libraries capture `document.documentElement` etc. at
//     load and reuse them — replacing the skeleton strands those references).
//     This is the document load path, and the foundation the incremental
//     script-blocking streaming driver layers onto.
//
// Like installHtmlParser, the DOM constructors + handle helpers are passed in
// via an install seam (they're IIFE-local in dom-nodes.js). parse5 itself comes
// from the vendor bundle (`__csimVendor.parse5.Parser`).

import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOCTYPE } from './constants.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export function installParse5Adapter({
  Document, Element, Text, Comment, DocumentFragment, DocumentType,
  createHtmlPageDocument, registerSubtree, unregisterSubtree, newChildList, registerNamedAccess,
  windowForwardedHandlerName, activateWindowForwardedHandler
}) {
  // Per-parse binding. The VM is single-threaded and a parse never reentrantly
  // triggers another parse (scripts run AFTER the tree is built, in step 1), so
  // module-level mutable state is safe and avoids rebuilding the ~30-method
  // adapter object per visit.
  //   curDoc — the Document new nodes belong to (their `ownerDocument`).
  //   live   — when parsing into the live document: the reused skeleton nodes
  //            plus per-tag "already yielded" flags, else null.
  let curDoc = null;
  let live = null;

  // parse5 Attribute[] ({name, value, prefix?, namespace?}) → our `_attrs`
  // object. A prefixed foreign attribute (xlink:href, xml:lang) is stored under
  // its qualified name, matching the hand-rolled parser. Only adds names not
  // already present (HTML "adopt attributes" / adoptAttributes semantics).
  function applyAttrs(el, attrs) {
    const winForward = el._tag === 'body' || el._tag === 'frameset';
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const name = a.prefix ? a.prefix + ':' + a.name : a.name;
      if (!Object.prototype.hasOwnProperty.call(el._attrs, name)) {
        el._attrs[name] = a.value;
        // Foreign (SVG / MathML) namespaced attribute: parse5's tree builder
        // resolves the xlink: / xml: / xmlns: prefixes (and bare `xmlns`) to a
        // real namespace + localName. Record `_attrNS` so the Attr exposes
        // namespaceURI / prefix / localName — e.g. SVG `xlink:href` reports the
        // xlink namespace — matching the hand-rolled parser's `foreignAttr`.
        if (a.namespace) {
          (el._attrNS || (el._attrNS = {}))[name] = { ns: a.namespace, prefix: a.prefix || null, localName: a.name };
        }
        // Feed window/form named access (`window.<id>`, `form.<name>`,
        // `window.frames`) — the hand-rolled parser does this per id/name attr.
        // Skipping it strands named-property lookups (the proxy reads live tree
        // state, but form-name getters are defined lazily on first registration).
        if ((name === 'id' || name === 'name') && a.value) registerNamedAccess(el, name, a.value);
        // A window-reflected handler content attribute (`onresize` / `onscroll`
        // / `onblur` / …) on <body> / <frameset> activates the Window's handler,
        // compiling the source. The hand-rolled parser routed body/frameset
        // through the full `setAttribute` for exactly this side effect; the
        // adapter writes `_attrs` directly, so do it explicitly here or a served
        // `<body onresize=…>` would never fire.
        if (winForward) {
          const evt = windowForwardedHandlerName(name);
          if (evt) activateWindowForwardedHandler(evt, a.value);
        }
      }
    }
  }

  // Reset a reused skeleton element (html/head/body) before parse5 repopulates
  // it: drop its prior attributes (and the cached Attr nodes, which snapshot
  // `_attrs`) so a stale class/id from the previous page can't survive, then
  // apply the new opening-tag attributes. Children are cleared separately in
  // `resetLiveDocument`.
  function resetReusedElement(el, attrs) {
    for (const k of Object.keys(el._attrs)) delete el._attrs[k];
    // Drop the namespaced-attribute sidecar too, else a prior page's
    // `<html xml:lang>` / `xmlns:xlink` leaves a stale `_attrNS` entry whose
    // qualified name no longer maps to any live `_attrs` key.
    el._attrNS = null;
    el._attrNodes = null;
    applyAttrs(el, attrs);
  }

  // A `<script>` parsed as part of the DOCUMENT (not inside <template> content)
  // is "already started" per HTML — it must not re-execute if later re-inserted
  // (`runInlineScripts` ignores the flag and runs document scripts in order; the
  // dynamic-insert path `maybeRunScript` honours it). A script inside <template>
  // content is inert but NOT already-started, so it RUNS when the content is
  // cloned/adopted — leave its flag unset (falsy). The hand-rolled parser set
  // this from the open-element stack; the adapter walks up from the insertion
  // parent to the (marked) template content fragment instead.
  function markScriptStartedFlag(scriptEl, parentNode) {
    for (let p = parentNode; p; p = p._parent) {
      if (p.__csimTemplateContent) return;   // inside template content → stays preparable
    }
    scriptEl._csimRan = true;
  }

  const treeAdapter = {
    // ── node creation ──────────────────────────────────────────────
    createDocument() {
      // Only reached by the one-shot path (the live path passes the document to
      // `new Parser(opts, liveDoc)` directly). A browsing-context HTML document
      // with NO skeleton — parse5 builds <html>/<head>/<body> via appendChild.
      const d = createHtmlPageDocument(false);
      curDoc = d;
      return d;
    },
    createDocumentFragment() {
      const f = new DocumentFragment();
      f._ownerDoc = curDoc;
      return f;
    },
    createElement(tagName, namespaceURI, attrs) {
      // Live parse: the first <html>/<head>/<body> reuses the live skeleton node
      // (identity preservation) instead of allocating a fresh element. A second
      // <html>/<body> start tag goes through parse5's adoptAttributes path, not
      // here, so the flag only needs to guard the first occurrence.
      if (live && (!namespaceURI || namespaceURI === HTML_NS)) {
        if (tagName === 'html' && live.html && !live.usedHtml) { live.usedHtml = true; resetReusedElement(live.html, attrs); return live.html; }
        if (tagName === 'head' && live.head && !live.usedHead) { live.usedHead = true; resetReusedElement(live.head, attrs); return live.head; }
        if (tagName === 'body' && live.body && !live.usedBody) { live.usedBody = true; resetReusedElement(live.body, attrs); return live.body; }
      }
      const el = new Element(tagName);
      el._ownerDoc = curDoc;
      if (namespaceURI && namespaceURI !== HTML_NS) el._ns = namespaceURI;
      applyAttrs(el, attrs);
      return el;
    },
    createCommentNode(data) { const c = new Comment(data); c._ownerDoc = curDoc; return c; },
    createTextNode(value)   { const t = new Text(value);   t._ownerDoc = curDoc; return t; },

    // ── tree mutation ──────────────────────────────────────────────
    appendChild(parentNode, newNode) {
      // A reused skeleton node is already a child of its skeleton parent
      // (<head>/<body> stay under <html> across the reset); parse5 re-appends
      // them, which must be a no-op rather than a duplicate push.
      if (newNode._parent === parentNode) return;
      newNode._parent = parentNode;
      parentNode._children.push(newNode);
      if (newNode._tag === 'script' && newNode._csimRan === undefined) markScriptStartedFlag(newNode, parentNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      const i = parentNode._children.indexOf(referenceNode);
      newNode._parent = parentNode;
      if (i < 0) parentNode._children.push(newNode);
      else parentNode._children.splice(i, 0, newNode);
      if (newNode._tag === 'script' && newNode._csimRan === undefined) markScriptStartedFlag(newNode, parentNode);
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
      t._ownerDoc = curDoc;
      t._parent = parentNode;
      kids.push(t);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const kids = parentNode._children;
      const i = kids.indexOf(referenceNode);
      const prev = i > 0 ? kids[i - 1] : null;
      if (prev && prev.nodeType === NODE_TEXT) { prev._data += text; return; }
      const t = new Text(text);
      t._ownerDoc = curDoc;
      this.insertBefore(parentNode, t, referenceNode);
    },
    adoptAttributes(recipient, attrs) { applyAttrs(recipient, attrs); },

    // ── <template> content fragment ────────────────────────────────
    setTemplateContent(templateElement, contentElement) {
      // Mark the content fragment so `markScriptStartedFlag` can tell a
      // template-content <script> (runs on clone) from a document <script>.
      contentElement.__csimTemplateContent = true;
      templateElement._templateContent = contentElement;
    },
    getTemplateContent(templateElement) {
      if (!templateElement._templateContent) {
        const f = new DocumentFragment();
        f._ownerDoc = curDoc;
        templateElement._templateContent = f;
      }
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
    setDocumentMode(document, mode) {
      document._compatMode = mode;
      // Our cascade / `compatMode` reflection key off a `_quirks` boolean.
      // Only full "quirks" maps to BackCompat; "limited-quirks" (almost
      // standards) reports CSS1Compat like no-quirks.
      document._quirks = (mode === 'quirks');
    },
    getDocumentMode(document) { return document._compatMode || 'no-quirks'; },

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

  // One-shot document parse via parse5 (into a fresh document). Returns the
  // parsed Document, or null if parse5 isn't available so callers can fall back.
  function parse5ParseDocument(html) {
    const Parser = getParser();
    if (!Parser) return null;
    curDoc = null;
    live = null;
    try {
      const parser = new Parser({ treeAdapter, scriptingEnabled: true });
      parser.tokenizer.write(String(html == null ? '' : html), true);
      return parser.document;
    } finally {
      curDoc = null;
    }
  }

  // Detach the live document's current tree in preparation for a fresh parse,
  // preserving the document / <html> / <head> / <body> element identities:
  //   - Unregister + detach the prolog (doctype / comments before <html>).
  //   - Detach <html> from the document (parse5 re-appends it, so the prolog
  //     it emits first lands in the correct order — before <html>).
  //   - Empty <head> / <body> (unregistering their subtrees' handles).
  // <head>/<body> stay children of <html> (so parse5's appendChild re-append is a
  // no-op via the identity guard); their attributes are reset by
  // `resetReusedElement` when parse5 reuses them.
  function resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody) {
    for (const c of liveDoc._children.slice()) {
      if (c !== liveHtml) unregisterSubtree(c);
      c._parent = null;
    }
    liveDoc._children = newChildList();
    if (liveHead) {
      for (const c of liveHead._children.slice()) { unregisterSubtree(c); c._parent = null; }
      liveHead._children = newChildList();
    }
    if (liveBody) {
      for (const c of liveBody._children.slice()) { unregisterSubtree(c); c._parent = null; }
      liveBody._children = newChildList();
    }
  }

  // Parse `html` directly into the live document, reusing its skeleton. Returns
  // true on success, false if parse5 is unavailable (caller falls back). The
  // caller owns everything after tree construction: custom-element upgrades,
  // cascade rebuild, declarative shadow roots, and running the scripts.
  function parse5ParseIntoLive(liveDoc, html) {
    const Parser = getParser();
    if (!Parser) return false;
    const liveHtml = liveDoc.documentElement || null;
    const liveHead = liveHtml ? liveHtml._children.find((c) => c._tag === 'head') : null;
    const liveBody = liveHtml ? liveHtml._children.find((c) => c._tag === 'body') : null;
    resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody);
    curDoc = liveDoc;
    live = { html: liveHtml, head: liveHead, body: liveBody, usedHtml: false, usedHead: false, usedBody: false };
    try {
      // Pass the live document as parse5's document so it appends into it
      // directly (rather than creating a fresh one via createDocument).
      const parser = new Parser({ treeAdapter, scriptingEnabled: true }, liveDoc);
      parser.tokenizer.write(String(html == null ? '' : html), true);
    } finally {
      curDoc = null;
      live = null;
    }
    // The adapter builds with raw `_children` pushes (no handle bookkeeping), so
    // register the whole new tree once. New nodes carry `_ownerDoc` from
    // creation; the reused skeleton already had handles (re-set harmlessly).
    registerSubtree(liveDoc);
    return true;
  }

  return { treeAdapter, parse5ParseDocument, parse5ParseIntoLive, getParser };
}
