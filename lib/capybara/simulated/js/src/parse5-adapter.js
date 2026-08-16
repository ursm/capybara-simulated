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

import { TRACKING_NULL, fireAttrChangedCallback, hasAnyCEDefinitions } from './custom-elements.js';
import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOCTYPE } from './constants.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
// The form-associated elements the HTML parser associates with its form element
// pointer (button/fieldset/input/object/output/select/textarea). <img> and form-
// associated custom elements are out of scope here.
const FORM_ASSOCIATED_TAGS = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);

export function installParse5Adapter({
  Document, Element, Text, Comment, DocumentFragment, DocumentType,
  createHtmlPageDocument, registerSubtree, unregisterSubtree, newChildList, registerNamedAccess,
  syncInlineEventHandler, finalizeElementProto, inertTemplateDocFor, constructParsedCustomElement
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
  // curRegistry — the custom element registry parsed elements inherit (a fragment's
  // context node's registry): undefined for the document default (global) so no
  // per-element field is set, or a scoped / null registry for a scoped shadow tree.
  let curRegistry = undefined;
  // The relaxed-select Parser subclass (built lazily once from the vendored
  // base Parser; see makeRelaxedSelectParser / getParser).
  let relaxedParserClass = null;
  // Streaming hooks for the incremental script-blocking driver, or null for a
  // one-shot parse. When set (by `parse5ParseIntoLive(doc, html, streamHooks)`),
  // the tree-mutation methods report each insertion/removal so the caller can
  // fire per-insertion MutationObserver records + connect/upgrade incrementally,
  // and parse5's `scriptHandler` (`stream.onScript`) runs parser-blocking
  // <script>s inline at `</script>`. Saved/restored around every parse so a
  // parse-time script that re-enters the parser (DOMParser) doesn't corrupt it.
  let stream = null;
  // The live parse's parse5 Parser, for the open-element stack (its insertion
  // context). `createElement` gets only the token, so the "may this token run
  // script?" decision — which depends on WHERE the element is about to land —
  // has to read the stack. Set for the live path only; null otherwise.
  let curParser = null;

  // HTML "create an element for the token": the will-execute-script flag, i.e.
  // may this token's custom element constructor run synchronously HERE?
  // Everything below is a NO:
  //   - a non-live parse (fragment / DOMParser): script-free by definition;
  //   - a token inside `<template>` contents: parsed into the inert template
  //     document, which has no registry (parse5's `tmplCount` is the same
  //     signal the spec's "appropriate place for inserting" uses — the
  //     adapter's own createElement runs BEFORE setTemplateContent re-owns the
  //     content, so the node's document can't answer this yet);
  //   - a NULL-registry insertion parent (the `customelementregistry`
  //     attribute, propagated down the parse) or that attribute on the token
  //     itself — the element's registry resolves to null, so no definition;
  //   - any parse with a scoped fragment registry (curRegistry set).
  // A page with no definitions at all short-circuits in the caller.
  function tokenMayConstruct(attrs) {
    // Cheapest first (rule 3): a page that defines no custom elements at all —
    // the overwhelming majority — pays ONE boolean per token, never the
    // open-element reads or the attribute scan below.
    if (!hasAnyCEDefinitions() || !live || curRegistry !== undefined) return false;
    const oe = curParser && curParser.openElements;
    if (!oe || oe.tmplCount > 0) return false;
    const parent = oe.current;
    if (parent && (parent._ceRegistry === null || parent._ceRegistry === TRACKING_NULL)) return false;
    for (let i = 0; i < attrs.length; i++) {
      if (!attrs[i].prefix && attrs[i].name === 'customelementregistry') return false;
    }
    return true;
  }

  // A node the parser inserts under template content (or any of its
  // descendants) belongs to the ASSOCIATED INERT TEMPLATE DOCUMENT, not the
  // parsing document. The parent's owner carries the identity down the build
  // (setTemplateContent seeds the fragment), so re-owning the single inserted
  // node as it lands keeps the whole content subtree consistent. The
  // `d._inertTemplateDoc === d` self-link is the O(1) inert-document test —
  // two reads and a compare on the non-template hot path (rule 3).
  function reownIntoTemplateDoc(parentNode, newNode) {
    const od = parentNode._ownerDoc;
    if (od && od._inertTemplateDoc === od && newNode._ownerDoc !== od) {
      newNode._ownerDoc = od;
      if (newNode._attrNodes) for (const k in newNode._attrNodes) newNode._attrNodes[k]._ownerDoc = od;
    }
  }

  // A parse5 Attribute[]'s value for `name` (unprefixed), or null.
  function isAttrValue(attrs, name) {
    for (let i = 0; i < attrs.length; i++) {
      if (!attrs[i].prefix && attrs[i].name === name) return attrs[i].value;
    }
    return null;
  }

  function propagateParserRegistry(parentNode, newNode) {
    if (newNode.nodeType !== 1) return;
    const preg = parentNode._ceRegistry;
    if (preg === TRACKING_NULL) newNode._ceRegistry = TRACKING_NULL;
    else if (preg === null && newNode._ceRegistry === undefined) newNode._ceRegistry = null;
  }

  // parse5 Attribute[] ({name, value, prefix?, namespace?}) → our `_attrs`
  // object. A prefixed foreign attribute (xlink:href, xml:lang) is stored under
  // its qualified name, matching the hand-rolled parser. Only adds names not
  // already present (HTML "adopt attributes" / adoptAttributes semantics).
  function applyAttrs(el, attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      // The parse-time `customelementregistry` attribute marks the element
      // sticky NULL-registry (parser-created descendants inherit it via the
      // insert propagation). Checked here — not in createElement — so the
      // reused skeleton <html>/<body>, whose attributes arrive via parse5's
      // adoptAttributes, is covered too.
      if (!a.prefix && a.name === 'customelementregistry') el._ceRegistry = null;
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
        // An event-handler content attribute (`onclick` / `onload` / …) activates
        // the element's handler as a registered listener; on <body> / <frameset>
        // the window-reflecting handlers drive the Window's handler instead. The
        // adapter writes `_attrs` directly (bypassing setAttribute), so do it here
        // or a served `<button onclick=…>` / `<body onresize=…>` would never fire.
        syncInlineEventHandler(el, name, a.value);
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

  // Pin a declarative-shadow-root `<template shadowrootmode>`'s ORIGINAL parent
  // at parse time. A streaming parse-time script can move the template before
  // the post-parse declarative-shadow conversion runs (move-template-before-
  // closing-tag.html); HTML decides convertibility from the parent the template
  // had WHEN PARSED, not its current one — so the converter validates against
  // this pin, not `node._parent`. Recorded unconditionally (one-shot too) so the
  // converter can rely on it; it's a no-op write on the rare DSD template only.
  function markDsdParent(node, parentNode) {
    if (node._tag === 'template' && node._attrs.shadowrootmode != null && node._dsdOriginalParent === undefined) {
      node._dsdOriginalParent = parentNode;
    }
  }

  // Parser tree mutations bypass the recordChildList funnel (records are observer-gated and
  // settleGen deliberately doesn't move mid-parse), but the element-local `_selEpoch` context
  // counters (cascade.js ctxEpochOf) MUST move: a mid-parse style read (an inline script's
  // getComputedStyle, an autofocus visibility check) would otherwise cache a structural answer
  // (`:nth-child`, `:empty`, descendant context) that later parser-inserted siblings silently
  // change — and with settleGen out of the memo key, nothing would ever invalidate it.
  function bumpSel(node) { if (node) node._selEpoch = (node._selEpoch || 0) + 1; }

  // Inserting (or foster-parenting away) a `<base>` changes the document base URL
  // with no settleGen movement — parser mutations are deliberately silent — so the
  // per-document `__baseUrlCache` (documentBaseURL, keyed on the generation) must
  // be dropped explicitly, like the `<base>.href` IDL setter does. Without this, a
  // `baseURI` read that lands mid-parse BEFORE the `<base>` (the cascade rebuild's
  // documentBaseUrl, an early script) pins the no-base value for the rest of the
  // task, and a form submission then resolves its action against the document URL.
  function dropBaseUrlCache(node) {
    const doc = node._ownerDoc || curDoc;
    if (doc) doc.__baseUrlCache = null;
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
      // HTML "create an element for the token" runs the custom element
      // constructor SYNCHRONOUSLY when the parser may execute script — a LIVE
      // document parse (a fragment / DOMParser / template-content parse is
      // script-free, and its inert document has no registry anyway, so the
      // lookup inside the helper answers null there too). The element must be
      // EMPTY while the constructor runs, so this precedes applyAttrs, and the
      // constructor's RETURN VALUE is what lands in the tree.
      let el = null;
      let constructedCE = false;
      if ((!namespaceURI || namespaceURI === HTML_NS) && tokenMayConstruct(attrs)) {
        // AUTONOMOUS elements only. A customized built-in (`<p is=custom-p>`)
        // is left to the connect-time upgrade: the vendored
        // customized-built-in-constructor-exceptions.html requires a parser-
        // built customized built-in to KEEP children its constructor appended,
        // which "create an element"'s synchronous validation (empty element)
        // rejects — so constructing it here would fail those elements instead.
        el = constructParsedCustomElement(tagName, curDoc, null);
        constructedCE = el != null && el._unknownFallback !== true;
      }
      if (!el) {
        el = new Element(tagName);
        // Inherit the fragment context's scoped / null registry (only when non-default,
        // so document-parsed elements keep no per-element field and use the global one).
        if (curRegistry !== undefined) el._ceRegistry = curRegistry;
      }
      el._ownerDoc = curDoc;
      if (namespaceURI && namespaceURI !== HTML_NS) el._ns = namespaceURI;
      // A constructed custom element already carries its class prototype —
      // reparenting it to Element.prototype would undo the construction.
      if (!constructedCE) finalizeElementProto(el);   // foreign content (SVG/MathML) reverts to base Element.prototype
      applyAttrs(el, attrs);
      // The attributes the parser just appended enqueue attributeChanged
      // reactions on an element that is ALREADY custom (an element upgraded
      // later gets them from upgradeElement instead). Attribute-list order,
      // like the upgrade path.
      if (constructedCE) {
        for (const name of Object.keys(el._attrs)) fireAttrChangedCallback(el, name, null, el._attrs[name]);
      }
      // A parsed image element with a resource URL (an <img src>, or an SVG <image>
      // href / xlink:href) in the LIVE document starts fetching + decoding immediately,
      // so naturalWidth/complete and the load event are populated for later script.
      // Gated on `live`: a DOMParser document, an innerHTML/`<template>` fragment, and
      // other non-browsing-context parses are inert per spec — they must not load
      // resources (and skipping them avoids a fetch + decode per image for parse-only work).
      if (live && el._imageResourceSrc()) el._loadImageResource();
      return el;
    },
    createCommentNode(data) { const c = new Comment(data); c._ownerDoc = curDoc; return c; },
    createTextNode(value)   { const t = new Text(value);   t._ownerDoc = curDoc; return t; },

    // ── tree mutation ──────────────────────────────────────────────
    // Parser-created children inherit the parent's registry marker: template
    // content FORCES the tracking sentinel (createElement may have stamped the
    // fragment context's registry first — content is inert either way); a
    // sticky-null parent (customelementregistry attribute) propagates to
    // unstamped children.
    appendChild(parentNode, newNode) {
      // A reused skeleton node is already a child of its skeleton parent
      // (<head>/<body> stay under <html> across the reset); parse5 re-appends
      // them, which must be a no-op rather than a duplicate push.
      if (newNode._parent === parentNode) return;
      reownIntoTemplateDoc(parentNode, newNode);
      newNode._parent = parentNode;
      parentNode._children.push(newNode);
      // Sticky-null propagation: every parser-created child of a null-registry
      // parent (the customelementregistry attribute, transitively) is null too.
      propagateParserRegistry(parentNode, newNode);
      bumpSel(parentNode); bumpSel(newNode);
      if (newNode._tag === 'script' && newNode._csimRan === undefined) markScriptStartedFlag(newNode, parentNode);
      if (newNode._tag === 'base') dropBaseUrlCache(newNode);
      markDsdParent(newNode, parentNode);
      if (stream) stream.onInsert(parentNode, newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      const i = parentNode._children.indexOf(referenceNode);
      reownIntoTemplateDoc(parentNode, newNode);
      newNode._parent = parentNode;
      if (i < 0) parentNode._children.push(newNode);
      else parentNode._children.splice(i, 0, newNode);
      // Sticky-null propagation: every parser-created child of a null-registry
      // parent (the customelementregistry attribute, transitively) is null too.
      propagateParserRegistry(parentNode, newNode);
      bumpSel(parentNode); bumpSel(newNode);
      if (newNode._tag === 'script' && newNode._csimRan === undefined) markScriptStartedFlag(newNode, parentNode);
      if (newNode._tag === 'base') dropBaseUrlCache(newNode);
      markDsdParent(newNode, parentNode);
      if (stream) stream.onInsert(parentNode, newNode);
    },
    detachNode(node) {
      const p = node._parent;
      if (!p) return;
      const i = p._children.indexOf(node);
      if (i >= 0) p._children.splice(i, 1);
      node._parent = null;
      bumpSel(p);
      if (node._tag === 'base') dropBaseUrlCache(node);
      if (stream && i >= 0) stream.onRemove(p, node);
    },
    insertText(parentNode, text) {
      const kids = parentNode._children;
      const last = kids[kids.length - 1];
      // Coalescing into an existing trailing Text is a characterData change, not
      // a childList one — MutationObserver childList records (all the streaming
      // cluster observes) don't need it, so leave it silent.
      if (last && last.nodeType === NODE_TEXT) { last._data += text; bumpSel(parentNode); return; }
      const t = new Text(text);
      t._ownerDoc = curDoc;
      reownIntoTemplateDoc(parentNode, t);
      t._parent = parentNode;
      kids.push(t);
      bumpSel(parentNode);
      if (stream) stream.onInsert(parentNode, t);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const kids = parentNode._children;
      const i = kids.indexOf(referenceNode);
      const prev = i > 0 ? kids[i - 1] : null;
      if (prev && prev.nodeType === NODE_TEXT) { prev._data += text; bumpSel(parentNode); return; }
      const t = new Text(text);
      t._ownerDoc = curDoc;
      this.insertBefore(parentNode, t, referenceNode);   // re-owns into template content itself
    },
    adoptAttributes(recipient, attrs) { applyAttrs(recipient, attrs); bumpSel(recipient); bumpSel(recipient._parent); },

    // ── <template> content fragment ────────────────────────────────
    setTemplateContent(templateElement, contentElement) {
      // Mark the content fragment so `markScriptStartedFlag` can tell a
      // template-content <script> (runs on clone) from a document <script>.
      contentElement.__csimTemplateContent = true;
      // Template content is another document with a NULL registry;
      // parsed children inherit the tracking-null sentinel via the appendChild
      // propagation below and re-point when they reach a real tree.
      contentElement._ceRegistry = TRACKING_NULL;
      // Its node document is the parsing document's associated inert template
      // document; parsed descendants follow via the insert-time owner
      // propagation below.
      contentElement._ownerDoc = inertTemplateDocFor(curDoc);
      contentElement._host = templateElement;   // fragment WITH HOST (adoptNode no-ops)
      templateElement._templateContent = contentElement;
    },
    getTemplateContent(templateElement) {
      if (!templateElement._templateContent) {
        const f = new DocumentFragment();
        f._ownerDoc = inertTemplateDocFor(curDoc);
        f._host = templateElement;
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
    onItemPop(node)  { if (stream && stream.onPop) stream.onPop(node); },
  };

  // SelectParserRelaxation (customizable `<select>` — WHATWG HTML / Chromium
  // ≥134, on by default): the "in select" and "in select in table" insertion
  // modes were REMOVED from the spec. A `<select>`'s content is now parsed with
  // the in-body rules, so `<div>` / `<button>` / arbitrary flow content + text
  // are KEPT inside the select (instead of being dropped), and
  // `<option>`/`<optgroup>`/`<hr>`/`<textarea>`/`<keygen>` all stay inside too.
  // The only carry-over is that `<input>` and a nested `<select>` still "break
  // out" of an open select (close it). parse5@8 predates this change; subclass
  // its `Parser` to emulate the new spec without patching the vendored dist
  // (matches Chrome 149 exactly: `<select><div><option>` keeps the div;
  // `<select><input>` / `<select><select>` break out; `<select><textarea>` does
  // not). Options nested under wrappers are handled DOM-side because the select
  // machinery already collects them via `querySelectorAll('option')`.
  function makeRelaxedSelectParser(Base) {
    // Always-applied subclass: capture the HTML parser's "form element pointer" as
    // the form owner of each form-associated element it inserts. This is how a
    // mis-nested control gets its form — `<table><form>…<input>` (the form isn't a
    // DOM ancestor) or `<form><div></div><input></form>` (the </div> mis-closes
    // before the input). The DOM-side `formForControl` falls back to `_formOwner`
    // when there's no ancestor form / `form=` attribute. A present `form` attribute
    // is left to be resolved by id (reset-the-form-owner), so it's skipped here.
    const CsimParser = class extends Base {
      _attachElementToTree(element, location) {
        super._attachElementToTree(element, location);
        const f = this.formElement;
        if (f && element && element._attrs && element._attrs.form == null &&
            FORM_ASSOCIATED_TAGS.has(element._tag)) {
          element._formOwner = f;
        }
      }
    };
    // The insertion-mode constants are a parse5-internal (non-exported) enum, so
    // capture their numeric values once by probing the base parser — no
    // hard-coded enum numbers, so this survives a parse5 version bump. The probe
    // uses parse5's default tree adapter (no treeAdapter passed), so it can't
    // touch our `curDoc` / streaming state; `write(html, false)` parses without
    // EOF, leaving the parser settled in the mode reached by `html`.
    const probe = (html) => { const p = new Base({ scriptingEnabled: false }); p.tokenizer.write(html, false); return p; };
    const selProbe = probe('<body><select>');
    const IN_SELECT = selProbe.insertionMode;
    // parse5's numeric tagID for `<select>` — read off the just-opened select on
    // the open-element stack (version-proof; no exported tag-id enum).
    const SELECT_TAG_ID = selProbe.openElements.currentTagId;
    const IN_BODY = probe('<body>x').insertionMode;
    const IN_SELECT_IN_TABLE = probe('<table><select>').insertionMode;
    const TEXT = probe('<body><textarea>').insertionMode;
    // Forward-compatible no-op: if a future parse5 adopts SelectParserRelaxation
    // itself (select content already parses in-body, so `<select>` no longer has
    // its own insertion mode), keep the vendored Parser untouched — the
    // emulation would be redundant/wrong.
    if (IN_SELECT === IN_BODY) return CsimParser;
    // Tags parse5's "in select" mode already handles per the CURRENT spec — let
    // it: `<html>`, `<option>`/`<optgroup>`/`<hr>` (close a prior option/optgroup
    // so optgroups stay siblings and an hr lands under the select), `<input>` and
    // a nested `<select>` (break the open select out), `<script>`/`<template>`
    // (in-head rules). Only keygen/textarea and arbitrary flow content changed
    // under SelectParserRelaxation — those are now KEPT inside the select, so the
    // override below diverts just them to the in-body rules.
    const SELECT_PASSTHROUGH = new Set(['html', 'option', 'optgroup', 'hr', 'input', 'select', 'script', 'template']);
    // End tags parse5's "in select" mode handles correctly (it closes an open
    // option / optgroup — which, like Chrome, it leaves IGNORED when a flow
    // element is open between them, and runs `</template>` via in-head).
    // `</select>` is handled explicitly below (parse5 uses select-scope, the new
    // spec uses regular scope); flow-content end tags (`</div>` etc.) are
    // diverted to the in-body rules or their elements never leave the
    // open-element stack (a following `<div>` would nest).
    const SELECT_END_PASSTHROUGH = new Set(['option', 'optgroup', 'template']);
    // Tags the "in select in table" mode breaks the select out on (everything
    // else there falls through to the plain in-select handling).
    const TABLE_IN_SELECT = new Set(['caption', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'td', 'th']);
    return class RelaxedSelectParser extends CsimParser {
      // Keep parse5 managing every mode TRANSITION (entering/leaving the select,
      // select-in-table, nested tables) so we never have to recompute the mode;
      // only the per-token DISPATCH while inside a select is adjusted.
      _startTagOutsideForeignContent(token) {
        const m = this.insertionMode;
        if (m === IN_SELECT || m === IN_SELECT_IN_TABLE) {
          const tn = token.tagName;
          if (SELECT_PASSTHROUGH.has(tn) || (m === IN_SELECT_IN_TABLE && TABLE_IN_SELECT.has(tn))) {
            super._startTagOutsideForeignContent(token);
            return;
          }
          // New spec: flow content (`<div>`/`<button>`/…), `<textarea>` and
          // `<keygen>` are KEPT inside the select (the old in-select mode dropped
          // flow content and broke keygen/textarea out). Insert them with the
          // in-body rules, then resume the select's insertion mode. A flow
          // element that itself switches mode (a `<table>` → in-table; an RCDATA
          // /RAWTEXT `<textarea>`/`<xmp>` → text) is left in that mode; for the
          // text case we point its resume target back at the select so the
          // select continues correctly after the element's end tag.
          this.insertionMode = IN_BODY;
          super._startTagOutsideForeignContent(token);
          if (this.insertionMode === IN_BODY) this.insertionMode = m;
          else if (this.insertionMode === TEXT) this.originalInsertionMode = m;
          return;
        }
        super._startTagOutsideForeignContent(token);
      }
      _endTagOutsideForeignContent(token) {
        const m = this.insertionMode;
        if (m === IN_SELECT || m === IN_SELECT_IN_TABLE) {
          const tn = token.tagName;
          if (tn === 'select') {
            // New spec: `</select>` closes through any open flow content using
            // REGULAR scope (a `<div>` is not a boundary), then resets the mode.
            // parse5's legacy endTagInSelect uses SELECT scope, where a `<div>`
            // is a boundary — so it would ignore the `</select>`, leaving the
            // select (and the flow element) open to swallow following siblings.
            if (this.openElements.hasInScope(SELECT_TAG_ID)) {
              this.openElements.popUntilTagNamePopped(SELECT_TAG_ID);
              this._resetInsertionMode();
            }
            return;
          }
          if (SELECT_END_PASSTHROUGH.has(tn) || (m === IN_SELECT_IN_TABLE && TABLE_IN_SELECT.has(tn))) {
            super._endTagOutsideForeignContent(token);
            return;
          }
          // Flow-content end tags (`</div>`, `</button>`, …) close their element
          // via the in-body rules, then we resume the select's mode.
          this.insertionMode = IN_BODY;
          super._endTagOutsideForeignContent(token);
          if (this.insertionMode === IN_BODY) this.insertionMode = m;
          return;
        }
        super._endTagOutsideForeignContent(token);
      }
    };
  }

  function getParser() {
    if (relaxedParserClass) return relaxedParserClass;
    const v = globalThis.__csimVendor;
    const Base = v && v.parse5 && v.parse5.Parser;
    if (!Base) return null;
    relaxedParserClass = makeRelaxedSelectParser(Base);
    return relaxedParserClass;
  }

  // One-shot document parse via parse5 (into a fresh document). Returns the
  // parsed Document, or null if parse5 isn't available so callers can fall back.
  function parse5ParseDocument(html) {
    const Parser = getParser();
    if (!Parser) return null;
    // Save/restore: a streaming parse-time script can call DOMParser, which
    // lands here re-entrantly — it must parse into its OWN fresh document with
    // no streaming hooks, then leave the outer parse's binding intact.
    const prevDoc = curDoc, prevLive = live, prevStream = stream;
    curDoc = null;
    live = null;
    stream = null;
    try {
      // scriptingEnabled:false → <noscript> content is PARSED as elements (not
      // raw text). DOMParser.parseFromString must parse with scripting disabled
      // (DOMParser-parseFromString-html.html "noscript works"); the frame-
      // fallback / <html>-innerHTML callers match the prior hand-rolled
      // behavior. The live document load path (parse5ParseIntoLive) keeps
      // scripting ENABLED + its scriptHandler.
      const parser = new Parser({ treeAdapter, scriptingEnabled: false });
      parser.tokenizer.write(String(html == null ? '' : html), true);
      return parser.document;
    } finally {
      curDoc = prevDoc; live = prevLive; stream = prevStream;
    }
  }

  // Parse `html` as an HTML fragment in `contextEl`'s context (the element whose
  // innerHTML/insertAdjacentHTML/etc. is being parsed), via parse5's fragment
  // parser — which applies the correct fragment insertion mode for the context
  // (table / select / raw-text `<textarea>`/`<script>`/`<style>`, …) and does the
  // HTML "first newline removal" for `<textarea>`/`<pre>`. Returns an array of
  // the parsed top-level nodes, detached (`_parent = null`) so the caller adopts
  // them — matching the hand-rolled parseFragment it replaces. New nodes are
  // owned by `contextEl`'s document (or the main document). `null` if parse5 is
  // unavailable. NOT streaming: fragment scripts never run (no scriptHandler).
  function parse5ParseFragment(html, contextEl) {
    const Parser = getParser();
    if (!Parser) return null;
    const ownerDoc = (contextEl && contextEl.ownerDocument) || globalThis.document;
    const prevDoc = curDoc, prevLive = live, prevStream = stream, prevReg = curRegistry;
    curDoc = ownerDoc;
    live = null;
    stream = null;
    // Parsed elements inherit the context node's custom element registry (shadow-root
    // or element innerHTML into a scoped tree). `undefined` for the default keeps the
    // global-registry fast path.
    curRegistry = contextEl ? contextEl._ceRegistry : undefined;
    try {
      // Normalize the fragment context to a BODY context unless it's a genuine
      // HTML-namespace element OTHER than <html>. Per the fragment parsing
      // algorithm / createContextualFragment: a null / non-element / HTML <html>
      // / foreign-namespace context all parse "in body" — so <html> and <body>
      // behave the same, and a foreign-namespace "html"/"div" or an SVG element
      // isn't special (matches the prior hand-rolled body-only behavior, while a
      // real HTML <table>/<select>/<tr> context still gets its own insertion
      // mode). createContextualFragment + insertAdjacentHTML rely on this.
      let ctx = contextEl;
      if (!ctx || ctx.nodeType !== NODE_ELEMENT || ctx._ns !== HTML_NS || ctx._localName === 'html') {
        ctx = treeAdapter.createElement('body', HTML_NS, []);
      }
      const parser = Parser.getFragmentParser(ctx, { treeAdapter, scriptingEnabled: true });
      parser.tokenizer.write(String(html == null ? '' : html), true);
      const frag = parser.getFragment();
      const kids = frag._children.slice();
      for (const c of kids) c._parent = null;
      return kids;
    } finally {
      curDoc = prevDoc; live = prevLive; stream = prevStream; curRegistry = prevReg;
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
  function parse5ParseIntoLive(liveDoc, html, streamHooks) {
    const Parser = getParser();
    if (!Parser) return false;
    const liveHtml = liveDoc.documentElement || null;
    const liveHead = liveHtml ? liveHtml._children.find((c) => c._tag === 'head') : null;
    const liveBody = liveHtml ? liveHtml._children.find((c) => c._tag === 'body') : null;
    resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody);
    const prevDoc = curDoc, prevLive = live, prevStream = stream, prevReg = curRegistry, prevParser = curParser;
    curDoc = liveDoc;
    live = { html: liveHtml, head: liveHead, body: liveBody, usedHtml: false, usedHead: false, usedBody: false };
    stream = streamHooks || null;
    // A live document parse always uses the document's own registry (a scoped
    // one is a FRAGMENT-parse concept) — reset it explicitly, since
    // tokenMayConstruct now depends on the invariant.
    curRegistry = undefined;
    try {
      // Pass the live document as parse5's document so it appends into it
      // directly (rather than creating a fresh one via createDocument). In
      // streaming mode `stream.onScript` is parse5's scriptHandler: it fires
      // synchronously at each `</script>`, mid-parse, so a parser-blocking
      // classic script runs against the partial tree (and `document.write`
      // could re-enter the tokenizer) before tokenization resumes.
      const parser = new Parser({ treeAdapter, scriptingEnabled: true }, liveDoc, null, stream ? stream.onScript : null);
      curParser = parser;   // its open-element stack answers tokenMayConstruct
      parser.tokenizer.write(String(html == null ? '' : html), true);
    } finally {
      curDoc = prevDoc; live = prevLive; stream = prevStream; curRegistry = prevReg; curParser = prevParser;
    }
    // The adapter builds with raw `_children` pushes (no handle bookkeeping), so
    // register the whole new tree once. New nodes carry `_ownerDoc` from
    // creation; the reused skeleton already had handles (re-set harmlessly).
    registerSubtree(liveDoc);
    return true;
  }

  return { treeAdapter, parse5ParseDocument, parse5ParseFragment, parse5ParseIntoLive, getParser };
}
