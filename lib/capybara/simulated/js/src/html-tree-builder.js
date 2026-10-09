// The HTML parser's tree, built into our live DOM nodes. The parser itself is html5ever, run natively
// (ext/csim_native/src/html_parse.rs): it hands over the tree it builds as a list of STEPS — create this element,
// append that node there — and this module takes them, in order, over OUR node classes, so a parse produces the node
// graph the rest of the driver understands: `_children` / `_parent` links, `_attrs`, `_ns`, `_templateContent`, real
// DocumentType / Comment / Text nodes. A step that depends on the DOM (whether a foster-parented table still has a
// parent, which a script may have changed) is decided here, where the DOM is.
//
// Three entry points:
//   - `parseHtmlDocument(html)` — one-shot, into a FRESH document. For DOMParser / standalone parses.
//   - `parseHtmlFragment(html, contextEl)` — `innerHTML` and the like, in the context element's own context.
//   - `parseHtmlIntoLive(liveDoc, html)` — parse directly into the LIVE `globalThis.document`, REUSING its `document` /
//     `<html>` / `<head>` / `<body>` identities (libraries capture `document.documentElement` etc. at load and reuse
//     them — replacing the skeleton strands those references). This is the document load path: the parse stops at
//     each `</script>` the page runs before it goes on, and `document.write` parses at the insertion point.
//
// The DOM constructors + handle helpers are passed in via an install seam (they're IIFE-local in dom-nodes.js).

import { TRACKING_NULL, fireAttrChangedCallback, hasAnyCEDefinitions } from './custom-elements.js';
import { NODE_ELEMENT, NODE_TEXT, NODE_DOCTYPE, HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS } from './constants.js';
import { bumpStructureGen } from './cascade.js';
import { noteParserTreeChange } from './mutation-observer.js';
import { syncTargetFragment } from './target.js';
import { appendEdge, insertEdge, removeEdge, clearEdges } from './tree.js';
import { PLATFORM } from './webidl.js';
import { invalidateArena, syncNativeAttrs, clearNativeAttrs, setAttrMeta, setParserFormOwner, syncDoctype } from './native-query-shadow.js';   // realm state reset on in-place reparse + batched attr flush
import { documentElementOf } from './document-tree.js';


// The form-associated elements the HTML parser associates with its form element
// pointer (button/fieldset/input/object/output/select/textarea). <img> and form-
// associated custom elements are out of scope here.
const FORM_ASSOCIATED_TAGS = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);

// The steps, as html_parse.rs numbers them.
const OP_ELEMENT = 1, OP_COMMENT = 2, OP_APPEND = 3, OP_APPEND_TEXT = 4, OP_APPEND_BASED = 5, OP_APPEND_BASED_TEXT = 6,
      OP_INSERT_BEFORE = 7, OP_INSERT_TEXT_BEFORE = 8, OP_DOCTYPE = 9, OP_QUIRKS = 10, OP_ADD_ATTRS = 11,
      OP_REMOVE = 12, OP_REPARENT = 13, OP_POP = 14, OP_FORM = 15, OP_SELECTED_CONTENT = 16, OP_SCRIPT_STARTED = 17;
// …and its namespaces, by number (`ns_code`).
const NAMESPACES = [null, HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS];
const QUIRKS_MODES = ['no-quirks', 'limited-quirks', 'quirks'];

export function installHtmlTreeBuilder({
  Text, Comment, DocumentFragment, DocumentType,
  createHtmlPageDocument, registerSubtree, unregisterSubtree, registerNamedAccess,
  syncInlineEventHandler, createElementNode, inertTemplateDocFor, constructParsedCustomElement, appendedAttributeSteps,
  closeDetailsIfNeeded
}) {
  // Per-parse binding, saved and restored around every parse: a parse-time script can start another (DOMParser,
  // `innerHTML`), which must build into its own document and leave this one's binding intact.
  //   curDoc — the Document new nodes belong to (their `ownerDocument`).
  //   live   — when parsing into the live document: the reused skeleton nodes
  //            plus per-tag "already yielded" flags, else null.
  let curDoc = null;
  let live = null;
  // curRegistry — the custom element registry parsed elements inherit (a fragment's
  // context node's registry): undefined for the document default (global) so no
  // per-element field is set, or a scoped / null registry for a scoped shadow tree.
  let curRegistry = undefined;
  // Streaming hooks for the live parse, or null for a one-shot parse. When set (by `parseHtmlIntoLive(doc, html,
  // streamHooks)`), the tree-mutation methods report each insertion/removal so the caller can fire per-insertion
  // MutationObserver records + connect/upgrade incrementally, and `stream.onScript` runs each parser-blocking
  // <script> at its `</script>`.
  let stream = null;
  // The parse in progress (`startParse`): its id in html_parse.rs, its nodes by handle, the parsing-blocking script a
  // `document.write` left pending, and how many scripts it is running (an insertion point exists while one is).
  let cur = null;

  // HTML "create an element for the token": the will-execute-script flag, i.e.
  // may this token's custom element constructor run synchronously HERE?
  // Everything below is a NO:
  //   - a non-live parse (fragment / DOMParser): script-free by definition;
  //   - a token whose insertion parent is in `<template>` contents: parsed into the inert template
  //     document, which has no registry;
  //   - a NULL-registry insertion parent (the `customelementregistry`
  //     attribute, propagated down the parse) or that attribute on the token
  //     itself — the element's registry resolves to null, so no definition;
  //   - any parse with a scoped fragment registry (curRegistry set).
  // The insertion parent is where the step that inserts the element puts it (`parentOf`, asked only past the cheap
  // tests: the parser makes an element before it inserts it).
  function tokenMayConstruct(attrs, parentOf) {
    // Cheapest first (rule 3): a page that defines no custom elements at all —
    // the overwhelming majority — pays ONE boolean per token, never the
    // insertion-parent lookup or the attribute scan below.
    if (!hasAnyCEDefinitions() || !live || curRegistry !== undefined) return false;
    const parent = parentOf();
    if (!parent || parent.__csimTemplateContent === true) return false;
    const od = parent._ownerDoc;
    if (od !== curDoc && od && od._inertTemplateDoc === od) return false;
    if (parent._ceRegistry === null || parent._ceRegistry === TRACKING_NULL) return false;
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
  // `d._inertTemplateDoc === d` self-link is the O(1) inert-document test, asked
  // only of an owner that is not the parsing document — the one every node outside
  // template content has. A document is a Proxy, whose every read goes through
  // its `get` trap — a trap per node the parser inserted, asked of the other one.
  function reownIntoTemplateDoc(parentNode, newNode) {
    const od = parentNode._ownerDoc;
    if (od !== curDoc && od && od._inertTemplateDoc === od && newNode._ownerDoc !== od) {
      newNode._ownerDoc = od;
      if (newNode._attrNodes) for (const k in newNode._attrNodes) newNode._attrNodes[k]._ownerDoc = od;
    }
  }

  // A parsed token's attribute list's value for `name` (unprefixed), or null.
  function isAttrValue(attrs, name) {
    for (let i = 0; i < attrs.length; i++) {
      if (!attrs[i].prefix && attrs[i].name === name) return attrs[i].value;
    }
    return null;
  }

  function propagateParserRegistry(parentNode, newNode) {
    if (newNode._nodeType !== 1) return;
    const preg = parentNode._ceRegistry;
    if (preg === TRACKING_NULL) newNode._ceRegistry = TRACKING_NULL;
    else if (preg === null && newNode._ceRegistry === undefined) newNode._ceRegistry = null;
  }

  // A parsed attribute list ({name, value, prefix?, namespace?}) → our `_attrs`
  // object. A prefixed foreign attribute (xlink:href, xml:lang) is stored under
  // its qualified name, matching the hand-rolled parser. Only adds names not
  // already present (HTML "adopt attributes" / adoptAttributes semantics).
  // A qualified name is already present in the flat [name, value, …] list. Used
  // for the "adopt attributes" first-occurrence-wins semantics (below). Attributes
  // per element are few, so a linear scan beats a per-element Set allocation.
  function flatHasName(flat, name) {
    for (let i = 0; i < flat.length; i += 2) if (flat[i] === name) return true;
    return false;
  }

  function applyAttrs(el, attrs, adopt) {
    // Accumulate the element's FINAL attribute set in a flat [name, value, …]
    // list, then flush it into the arena node in ONE crossing (syncNativeAttrs).
    // Since the store flip, `el._attrs` is a native-backed view: a naive
    // per-attribute `el._attrs[name] = …` crosses into Rust once EACH, where the
    // plain object it replaced took zero — so a parse-time apply of an
    // attribute-dense element paid N crossings. Batching restores that economics.
    const flat = [];
    if (adopt) {
      // HTML "adopt attributes" (a repeated <html>/<body> start tag): existing
      // attributes are KEPT and only not-yet-present names added. syncNativeAttrs
      // replaces wholesale, so seed the list with the element's current
      // attributes to preserve them. Rare path — enumerating an already-parsed
      // skeleton's few attrs is cheap, and the seeded values round-trip
      // losslessly (attrsView returns the UTF-16 override, syncAttrs re-detects it).
      const cur = el._attrs;
      for (const k in cur) flat.push(k, cur[k]);
    }
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      // The parse-time `customelementregistry` attribute marks the element
      // sticky NULL-registry (parser-created descendants inherit it via the
      // insert propagation). Checked here — not in createElement — so the
      // reused skeleton <html>/<body>, whose attributes arrive via the parser's
      // adoptAttributes, is covered too.
      if (!a.prefix && a.name === 'customelementregistry') el._ceRegistry = null;
      const name = a.prefix ? a.prefix + ':' + a.name : a.name;
      // First occurrence wins (matches the old hasOwnProperty accumulation): a
      // duplicate qualified name — or, when adopting, one already on the element
      // — is skipped along with its side effects.
      if (flatHasName(flat, name)) continue;
      flat.push(name, a.value);
      // Foreign (SVG / MathML) namespaced attribute: the tree builder
      // resolves the xlink: / xml: / xmlns: prefixes (and bare `xmlns`) to a
      // real namespace + localName. Record `_attrNS` so the Attr exposes
      // namespaceURI / prefix / localName — e.g. SVG `xlink:href` reports the
      // xlink namespace — matching the hand-rolled parser's `foreignAttr`.
      if (a.namespace) {
        setAttrMeta(el, name, { ns: a.namespace, prefix: a.prefix || null, localName: a.name });
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
      appendedAttributeSteps(el, name);
    }
    // Flush the whole set at once. Before `__dom` exists `_attrs` is a plain
    // object and syncNativeAttrs declines (returns false) — write the flat list
    // into it directly there.
    if (!syncNativeAttrs(el, flat)) {
      for (let i = 0; i < flat.length; i += 2) el._attrs[flat[i]] = flat[i + 1];
    }
  }

  // Reset a reused skeleton element (html/head/body) before the parser repopulates
  // it: drop its prior attributes (and the cached Attr nodes, which snapshot
  // `_attrs`) so a stale class/id from the previous page can't survive, then
  // apply the new opening-tag attributes. Children are cleared separately in
  // `resetLiveDocument`.
  function resetReusedElement(el, attrs) {
    // (…in its arena node, its attribute store — or, without `__dom`, a plain JS object made afresh)
    if (!clearNativeAttrs(el)) el._attrs = {};
    // Drop the namespaced-attribute sidecar too, else a prior page's
    // `<html xml:lang>` / `xmlns:xlink` leaves a stale `_attrNS` entry whose
    // qualified name no longer maps to any live `_attrs` key.
    el._attrNS = null;
    el._attrNodes = null;
    applyAttrs(el, attrs);
    // …and it is created again as far as its is value goes: the token's `is`, or none.
    const is = isAttrValue(attrs, 'is');
    el._isValue = is !== null ? is : undefined;
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
    // …and a LIVE document parse's scripts are PARSER-INSERTED: the ones "the end" (`runInlineScripts`) is for. A
    // fragment's (innerHTML) are "already started" and never run — not even when moved into the document mid-parse.
    if (live) scriptEl._csimParserInserted = true;
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

  // Parser tree mutations bypass the recordChildList funnel (records are observer-gated and settleGen deliberately
  // doesn't move mid-parse), but the structure generation MUST move, as a script-driven one moves it — each step below
  // bumps it: a mid-parse read (an inline script's geometry read, an autofocus visibility check) keeps memos keyed on
  // it that later parser-inserted siblings change.


  // A parsed details element's insertion steps, as it is inserted — before the details after it are: one open where an
  // earlier one of its name group is open already closes, so the first open one in tree order stays open.
  function detailsInsertionSteps(node) {
    if (node._tag === 'details' && node._ns === HTML_NS && node._attrs.open != null) closeDetailsIfNeeded(node);
  }

  // A parsed image element with a resource URL (an <img src>, or an SVG <image> href/xlink:href) in
  // the LIVE document starts fetching + decoding as soon as it is INSERTED, so naturalWidth/complete
  // and the load event are populated for later script. Run on insertion, not creation: an <img> in a
  // <picture> resolves its parent's matching <source> ("update the image data"), which needs the
  // picture parent and the <source> siblings that only exist once the element is in the tree. Gated
  // on `live`: a DOMParser document, an innerHTML/<template> fragment, and other non-browsing-context
  // parses are inert per spec (they load no resources), and the per-(src, mode) idempotence in
  // `_loadImageResource` keeps a re-append from re-fetching.
  function loadParsedImage(node) {
    if (live && node._nodeType === 1 && typeof node._imageResourceSrc === 'function' && node._imageResourceSrc()) {
      node._loadImageResource();
    }
  }

  const tree = {
    createDocumentFragment() {
      const f = new DocumentFragment();
      f._ownerDoc = curDoc;
      return f;
    },
    createElement(tagName, namespaceURI, attrs, parentOf) {
      // Live parse: the first <html>/<head>/<body> reuses the live skeleton node
      // (identity preservation) instead of allocating a fresh element. A second
      // <html>/<body> start tag goes through the adoptAttributes path, not
      // here, so the flag only needs to guard the first occurrence.
      if (live && namespaceURI === HTML_NS) {
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
      if (namespaceURI === HTML_NS && tokenMayConstruct(attrs, parentOf)) {
        // AUTONOMOUS elements only. A customized built-in (`<p is=custom-p>`)
        // is left to the connect-time upgrade: the vendored
        // customized-built-in-constructor-exceptions.html requires a parser-
        // built customized built-in to KEEP children its constructor appended,
        // which "create an element"'s synchronous validation (empty element)
        // rejects — so constructing it here would fail those elements instead.
        // (…with the document's throw-on-dynamic-markup-insertion counter held: a constructor that calls
        // `document.write` / `open` throws InvalidStateError, as in Chrome.)
        curDoc._markupInsertionCounter = (curDoc._markupInsertionCounter || 0) + 1;
        try { el = constructParsedCustomElement(tagName, curDoc, null); }
        finally { curDoc._markupInsertionCounter--; }
        constructedCE = el != null && el._unknownFallback !== true;
      }
      if (!el) {
        // Foreign content keeps the name the parser hands over — already through HTML's "adjust SVG tag name" table
        // (`foreignObject`, `clipPath`, `linearGradient`) — which the ctor lowercases into `_tag`.
        el = namespaceURI === HTML_NS ? createElementNode(tagName) : createElementNode(tagName, namespaceURI, tagName);
        // Inherit the fragment context's scoped / null registry (only when non-default,
        // so document-parsed elements keep no per-element field and use the global one).
        if (curRegistry !== undefined) el._ceRegistry = curRegistry;
      }
      el._ownerDoc = curDoc;
      // Adopt-merge onto a constructed custom element: its constructor may already
      // have set attributes (the wholesale flush would otherwise wipe them). A
      // fresh element is empty, so its apply seeds nothing and pays no read.
      applyAttrs(el, attrs, constructedCE);
      // HTML "create an element for a token": the token's `is` attribute is the element's is value — fixed at
      // creation, whatever the attribute says later.
      if (namespaceURI === HTML_NS) {
        const is = isAttrValue(attrs, 'is');
        if (is !== null) el._isValue = is;
      }
      // The attributes the parser just appended enqueue attributeChanged
      // reactions on an element that is ALREADY custom (an element upgraded
      // later gets them from upgradeElement instead). Attribute-list order,
      // like the upgrade path.
      if (constructedCE) {
        for (const name of Object.keys(el._attrs)) fireAttrChangedCallback(el, name, null, el._attrs[name]);
      }
      // The image load is triggered on INSERTION (see `loadParsedImage`), not here: an <img> inside
      // a <picture> must pick its parent's matching <source> ("update the image data"), and its
      // <source> siblings + picture parent only exist once the element is appended.
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
      reownIntoTemplateDoc(parentNode, newNode);
      appendEdge(parentNode, newNode);
      // Sticky-null propagation: every parser-created child of a null-registry
      // parent (the customelementregistry attribute, transitively) is null too.
      propagateParserRegistry(parentNode, newNode);
      bumpStructureGen();
      noteParserTreeChange();
      if (newNode._tag === 'script' && newNode._csimRan === undefined) markScriptStartedFlag(newNode, parentNode);
      markDsdParent(newNode, parentNode);
      if (stream) stream.onInsert(parentNode, newNode);
      loadParsedImage(newNode);
      detailsInsertionSteps(newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      const i = parentNode._children.indexOf(referenceNode);
      reownIntoTemplateDoc(parentNode, newNode);
      insertEdge(parentNode, newNode, i);
      // Sticky-null propagation: every parser-created child of a null-registry
      // parent (the customelementregistry attribute, transitively) is null too.
      propagateParserRegistry(parentNode, newNode);
      bumpStructureGen();
      noteParserTreeChange();
      if (newNode._tag === 'script' && newNode._csimRan === undefined) markScriptStartedFlag(newNode, parentNode);
      markDsdParent(newNode, parentNode);
      if (stream) stream.onInsert(parentNode, newNode);
      loadParsedImage(newNode);
      detailsInsertionSteps(newNode);
    },
    detachNode(node) {
      const p = node._parent;
      if (!p) return;
      const i = removeEdge(node);
      bumpStructureGen();
      noteParserTreeChange();
      if (stream && i >= 0) stream.onRemove(p, node);
    },
    insertText(parentNode, text) {
      const kids = parentNode._children;
      const last = kids[kids.length - 1];
      // Coalescing into an existing trailing Text is a characterData change, not
      // a childList one — MutationObserver childList records (all the streaming
      // cluster observes) don't need it, so leave it silent.
      if (last && last._nodeType === NODE_TEXT) { last._appendData(text); noteParserTreeChange(); if (stream) stream.onTextAppend(parentNode); return; }
      const t = new Text(text);
      t._ownerDoc = curDoc;
      reownIntoTemplateDoc(parentNode, t);
      appendEdge(parentNode, t);
      bumpStructureGen();
      noteParserTreeChange();   // text is tree content too: a parse-time innerText read keys on this
      if (stream) stream.onInsert(parentNode, t);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const kids = parentNode._children;
      const i = kids.indexOf(referenceNode);
      const prev = i > 0 ? kids[i - 1] : null;
      if (prev && prev._nodeType === NODE_TEXT) { prev._appendData(text); noteParserTreeChange(); if (stream) stream.onTextAppend(parentNode); return; }
      const t = new Text(text);
      t._ownerDoc = curDoc;
      tree.insertBefore(parentNode, t, referenceNode);   // re-owns into template content itself
    },
    adoptAttributes(recipient, attrs) { applyAttrs(recipient, attrs, true); noteParserTreeChange(); },

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
    // ── doctype / document mode ─────────────────────────────────────
    setDocumentType(document, name, publicId, systemId) {
      const existing = document._children.find((n) => n._nodeType === NODE_DOCTYPE);
      if (existing) {
        existing._name     = String(name);
        existing._publicId = String(publicId == null ? '' : publicId);
        existing._systemId = String(systemId == null ? '' : systemId);
        syncDoctype(existing);
        return;
      }
      const dt = new DocumentType(PLATFORM, name, publicId, systemId, document);
      appendEdge(document, dt);
    },
    setDocumentMode(document, mode) {
      document._compatMode = mode;
      // Our cascade / `compatMode` reflection key off a `_quirks` boolean.
      // Only full "quirks" maps to BackCompat; "limited-quirks" (almost
      // standards) reports CSS1Compat like no-quirks.
      document._quirks = (mode === 'quirks');
    },
    // ── the stack of open elements ──────────────────────────────────
    onItemPop(node)  {
      if (stream && stream.onPop) stream.onPop(node);
      if (node._dsdScripts) releaseDsdScripts(node);
    },
  };

  // Detach the live document's current tree in preparation for a fresh parse,
  // preserving the document / <html> / <head> / <body> element identities:
  //   - Unregister + detach the prolog (doctype / comments before <html>).
  //   - Detach <html> from the document (the parser re-appends it, so the prolog
  //     it emits first lands in the correct order — before <html>).
  //   - Detach <html>'s children, <head> / <body> included (the parser re-appends
  //     them where the new markup puts them).
  //   - Empty <head> / <body> (unregistering their subtrees' handles).
  // Their attributes are reset by `resetReusedElement` when the parser reuses them.
  function resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody) {
    for (const c of clearEdges(liveDoc)) if (c !== liveHtml) unregisterSubtree(c);
    // …and the root's own children, the reused `<head>` / `<body>` included: they go back in where the parser puts them.
    // Left in place, a head script saw a connected `<body>` (Chrome and Firefox: `document.body` is null until the
    // parser reaches it) and the root's other children landed after both (`<html><!--c--><head>` read HEAD, BODY,
    // #comment where the tree is #comment, HEAD, #text, BODY).
    if (liveHtml) {
      for (const c of clearEdges(liveHtml)) if (c !== liveHead && c !== liveBody) unregisterSubtree(c);
    }
    if (liveHead) {
      for (const c of clearEdges(liveHead)) unregisterSubtree(c);
    }
    if (liveBody) {
      for (const c of clearEdges(liveBody)) unregisterSubtree(c);
    }
  }

  // The `<template shadowrootmode>` whose content `node` is being parsed into, if any.
  function dsdTemplateOf(node) {
    let n = node._parent;
    while (n && n.__csimTemplateContent !== true) n = n._parent;
    const t = n && n._host;
    return t && t._attrs && t._attrs.shadowrootmode != null ? t : null;
  }
  // At a declarative template's `</template>` (after `onPop` converted it): its scripts are now in a CONNECTED shadow
  // tree — parser-inserted, run in order before the parse goes past it. Not connected, it did not convert (an inert
  // template after all, or one nested in another declarative template that has not converted yet: they wait on that).
  function releaseDsdScripts(t) {
    const scripts = t._dsdScripts;
    t._dsdScripts = null;
    if (scripts[0].isConnected) {
      for (const s of scripts) { s._csimParserInserted = true; runWithInsertionPoint(cur, s); }
      runPendingScript(cur);
    } else if (t._dsdOuter) {
      const outer = t._dsdOuter;
      if (!outer._dsdScripts) { outer._dsdScripts = []; outer._dsdOuter = dsdTemplateOf(outer); }
      outer._dsdScripts.push(...scripts);
    }
  }

  // ── taking the parser's steps ──────────────────────────────────────────────────────────────────────────────────
  // A token's attributes as `applyAttrs` reads them, from `n` of them at `steps[i]` (prefix, namespace, name, value).
  function readAttrs(steps, i, n) {
    const attrs = new Array(n);
    for (let k = 0; k < n; k++, i += 4) {
      attrs[k] = { prefix: steps[i] || undefined, namespace: NAMESPACES[steps[i + 1]] || undefined, name: steps[i + 2], value: steps[i + 3] };
    }
    return attrs;
  }
  // Where the step at `i` ends.
  function stepEnd(steps, i) {
    switch (steps[i]) {
      case OP_ELEMENT:   return i + 6 + 4 * steps[i + 4];
      case OP_ADD_ATTRS: return i + 3 + 4 * steps[i + 2];
      case OP_APPEND_BASED: case OP_APPEND_BASED_TEXT: case OP_DOCTYPE: return i + 4;
      case OP_QUIRKS: case OP_REMOVE: case OP_POP: case OP_SELECTED_CONTENT: case OP_SCRIPT_STARTED: return i + 2;
      default: return i + 3;
    }
  }
  // The node the element `handle` is about to be inserted into: the first later step that inserts it says where.
  function insertionParent(p, steps, i, handle) {
    const h = p.handles, end = steps.length - 1;
    for (; i < end; i = stepEnd(steps, i)) {
      switch (steps[i]) {
        case OP_APPEND:        if (steps[i + 2] === handle) return h[steps[i + 1]]; break;
        case OP_INSERT_BEFORE: if (steps[i + 2] === handle) return h[steps[i + 1]]._parent; break;
        case OP_APPEND_BASED:  if (steps[i + 3] === handle) return h[steps[i + 1]]._parent || h[steps[i + 2]]; break;
      }
    }
    return null;
  }

  // Take `steps` from `i` on; returns the status the parser stopped with (`htmlParse`): -1 its input ran out, else the
  // handle of the script to run before it goes on.
  function takeSteps(p, steps, i) {
    const h = p.handles, end = steps.length - 1;
    while (i < end) {
      switch (steps[i]) {
        case OP_ELEMENT: {
          const handle = steps[i + 1], n = steps[i + 4];
          const attrs = readAttrs(steps, i + 5, n), contents = steps[i + 5 + 4 * n], next = i + 6 + 4 * n;
          const el = tree.createElement(steps[i + 3], NAMESPACES[steps[i + 2]], attrs, () => insertionParent(p, steps, next, handle));
          h[handle] = el;
          if (contents) {
            const f = tree.createDocumentFragment();
            tree.setTemplateContent(el, f);
            h[contents] = f;
          }
          i = next;
          continue;
        }
        case OP_COMMENT:      h[steps[i + 1]] = tree.createCommentNode(steps[i + 2]); break;
        case OP_APPEND:       tree.appendChild(h[steps[i + 1]], h[steps[i + 2]]); break;
        case OP_APPEND_TEXT:  tree.insertText(h[steps[i + 1]], steps[i + 2]); break;
        // (…the foster parent: before the table, while it has a parent — a script may have moved it — else into the
        // element before it on the stack of open elements)
        case OP_APPEND_BASED: case OP_APPEND_BASED_TEXT: {
          const el = h[steps[i + 1]], parent = el._parent, text = steps[i] === OP_APPEND_BASED_TEXT;
          if (parent) text ? tree.insertTextBefore(parent, steps[i + 3], el) : tree.insertBefore(parent, h[steps[i + 3]], el);
          else text ? tree.insertText(h[steps[i + 2]], steps[i + 3]) : tree.appendChild(h[steps[i + 2]], h[steps[i + 3]]);
          break;
        }
        case OP_INSERT_BEFORE: case OP_INSERT_TEXT_BEFORE: {
          const sibling = h[steps[i + 1]], parent = sibling._parent;
          if (parent) steps[i] === OP_INSERT_TEXT_BEFORE ? tree.insertTextBefore(parent, steps[i + 2], sibling) : tree.insertBefore(parent, h[steps[i + 2]], sibling);
          break;
        }
        case OP_DOCTYPE:      tree.setDocumentType(h[0], steps[i + 1], steps[i + 2], steps[i + 3]); break;
        case OP_QUIRKS:       tree.setDocumentMode(h[0], QUIRKS_MODES[steps[i + 1]]); break;
        case OP_ADD_ATTRS:    tree.adoptAttributes(h[steps[i + 1]], readAttrs(steps, i + 3, steps[i + 2])); break;
        case OP_REMOVE:       tree.detachNode(h[steps[i + 1]]); break;
        case OP_REPARENT: {
          const node = h[steps[i + 1]], to = h[steps[i + 2]];
          for (const c of node._children.slice()) { tree.detachNode(c); tree.appendChild(to, c); }
          break;
        }
        case OP_POP:          tree.onItemPop(h[steps[i + 1]]); break;
        // (…a form-associated element the parser associates with its form element pointer, unless a `form` attribute
        // names its form: `<table><form>…<input>`, where the form is no ancestor of the input)
        case OP_FORM: {
          const el = h[steps[i + 1]];
          if (el._attrs.form == null && FORM_ASSOCIATED_TAGS.has(el._tag)) setParserFormOwner(el, h[steps[i + 2]]);
          break;
        }
        // (…an `<option>` closed: the stream's own `onPop` mirrors it into a customizable select's `selectedcontent`)
        case OP_SELECTED_CONTENT: break;
        // (…a `<script>` the input ended inside — or a fragment's: "already started", and no script of the parser's to
        // run once the document has been parsed)
        case OP_SCRIPT_STARTED: {
          const el = h[steps[i + 1]];
          el._csimRan = true;
          el._csimParserInserted = false;
          break;
        }
      }
      i = stepEnd(steps, i);
    }
    return steps[end];
  }

  // Start a parse of `html` (html_parse.rs `htmlParse`) whose document is `doc`, or — with `context` — a fragment
  // parse in that element's context (handle 0 then `doc`, the stand-in the fragment's root `<html>` goes into).
  function startParse(doc, html, scripting, context = null, form = null) {
    const ctxNs = context ? NAMESPACES.indexOf(context._ns) : 0;
    const quirks = context ? QUIRKS_MODES.indexOf((context._ownerDoc && context._ownerDoc._compatMode) || 'no-quirks') : 0;
    const text = String(html == null ? '' : html);
    const steps = globalThis.__dom.htmlParse(text, text.isWellFormed(), scripting, ctxNs < 0 ? 0 : ctxNs,
                                             context ? context._localName : null, form !== null, quirks < 0 ? 0 : quirks);
    const p = { id: steps[0], doc, handles: [doc, context, form], pending: null, depth: 0 };
    return { p, steps };
  }

  // Run the parse to its end: each script it stops for runs — a live parse's — then it goes on.
  function runParse(p, steps) {
    let status = takeSteps(p, steps, 1);
    while (status >= 0) status = takeSteps(p, scriptStopped(p, p.handles[status]), 0);
  }
  // The parser stopped at `el`'s `</script>` (with no script running): run it — then the pending parsing-blocking
  // script its markup wrote, once the nesting level is back to zero, before anything after it is tokenized — and parse
  // on. A one-shot parse runs none.
  // A parser-blocking script runs AFTER its end tag is processed (HTML's "text" insertion mode pops the `<script>`
  // and restores the insertion mode first), which the parser has done by the time it stops.
  function scriptStopped(p, el) {
    if (stream && runsHere(el)) {
      runWithInsertionPoint(p, el);
      runPendingScript(p);
    }
    return globalThis.__dom.htmlRun(p.id);
  }
  // The pending parsing-blocking script a parser-run script's markup wrote runs once the nesting level is back to zero
  // — and before anything after it is tokenized.
  function runPendingScript(p) {
    while (p.depth === 0 && p.pending) {
      const pending = p.pending;
      p.pending = null;
      runWithInsertionPoint(p, pending);
    }
  }
  // Whether the parser runs `el` where it stopped for it. A script in TEMPLATE content is never prepared (inert, as the
  // insertion hook treats it) — except a DECLARATIVE SHADOW ROOT's content, which only looks inert here: this parser
  // builds it into the template's content and converts it at `</template>`, so its scripts wait on the template and run
  // once it has converted (`releaseDsdScripts`).
  function runsHere(el) {
    if (el._inStreamTC !== true) return true;
    const t = dsdTemplateOf(el);
    if (t) {
      // (…and the declarative template around THIS one, noted now: once this one converts it is out of the tree.)
      if (!t._dsdScripts) { t._dsdScripts = []; t._dsdOuter = dsdTemplateOf(t); }
      t._dsdScripts.push(el);
    }
    return false;
  }
  // Run `el` with an INSERTION POINT (HTML §8.4.3): just past its `</script>` — or, the pending parsing-blocking
  // script, just before the next input character: the same place by the time it runs. What it writes goes in there.
  function runWithInsertionPoint(p, el) {
    globalThis.__dom.htmlScriptBegin(p.id);
    p.depth++;
    try { stream.onScript(el); } finally {
      p.depth--;
      globalThis.__dom.htmlScriptEnd(p.id);
    }
  }

  // `document.write` from a script the parser is running: its markup goes into the input stream at the insertion
  // point and is tokenized THERE, before `write` returns, up to the insertion point. Appended to `<body>` instead,
  // `<div>one<script>document.write("two")</script> four</div>` read "one four two" (Chrome and Firefox: "one two
  // four"). A `<script>` in the written markup runs right there, inside `write`, with an insertion point of its own —
  // unless it is an EXTERNAL parser-blocking one: that is the pending parsing-blocking script, it runs once the writer
  // (and every script it is nested in) has returned, and until it has, a further `write` only inserts (nothing is
  // tokenized past a pending script).
  globalThis.__csimWriteAtInsertionPoint = (doc, html) => {
    const p = cur;
    if (!p || p.doc !== doc || p.depth === 0) return false;
    const text = String(html);
    if (globalThis.__dom.htmlWrite(p.id, text, text.isWellFormed()) !== true) return false;
    if (p.pending) return true;
    let steps = globalThis.__dom.htmlRun(p.id);
    for (;;) {
      const status = takeSteps(p, steps, 0);
      if (status < 0) return true;                 // the insertion point: everything written is parsed
      const el = p.handles[status];
      if (runsHere(el)) {
        if (stream.blocksParser(el)) { p.pending = el; return true; }
        runWithInsertionPoint(p, el);
        if (p.pending) return true;                // (…it wrote one: nothing more is tokenized until it has run)
      }
      steps = globalThis.__dom.htmlRun(p.id);
    }
  };
  // `document.open()` from a script the parser is running does nothing (HTML: an active parser with a script nesting
  // level above zero) — it wiped the page here, where Chrome and Firefox write on at the insertion point.
  globalThis.__csimParserScriptRunning = (doc) => !!cur && cur.doc === doc && cur.depth > 0;

  // Run `fn` with this module's per-parse binding set to the given one, restoring the previous after.
  function withBinding(doc, liveSkeleton, streamHooks, registry, fn) {
    const prevDoc = curDoc, prevLive = live, prevStream = stream, prevReg = curRegistry, prevCur = cur;
    curDoc = doc; live = liveSkeleton; stream = streamHooks; curRegistry = registry;
    try { return fn(); } finally {
      curDoc = prevDoc; live = prevLive; stream = prevStream; curRegistry = prevReg; cur = prevCur;
    }
  }

  // One-shot document parse (into a fresh document). Scripting DISABLED: `<noscript>` content is parsed as elements
  // (DOMParser-parseFromString-html.html "noscript works"), and no script runs.
  function parseHtmlDocument(html) {
    const doc = createHtmlPageDocument(false);
    return withBinding(doc, null, null, undefined, () => {
      const { p, steps } = startParse(doc, html, false);
      cur = p;
      try { runParse(p, steps); } finally { globalThis.__dom.htmlDone(p.id); }
      return doc;
    });
  }

  // Parse `html` as an HTML fragment in `contextEl`'s context (the element whose innerHTML/insertAdjacentHTML/etc. is
  // being parsed): the fragment insertion mode for the context (table / select / raw-text `<textarea>`/`<script>`/
  // `<style>`, foreign content in an `<svg>`, …), the form element pointer its nearest form, the mode of its document.
  // Returns an array of the parsed top-level nodes, detached (`_parent = null`) so the caller adopts them. New nodes are
  // owned by `contextEl`'s document (or the main document). NOT streaming: fragment scripts never run.
  function parseHtmlFragment(html, contextEl) {
    const ownerDoc = (contextEl && contextEl.ownerDocument) || globalThis.document;
    // Parsed elements inherit the context node's custom element registry (shadow-root or element innerHTML into a
    // scoped tree). `undefined` for the default keeps the global-registry fast path.
    return withBinding(ownerDoc, null, null, contextEl ? contextEl._ceRegistry : undefined, () => {
      // A context that is no element (a document, a fragment, a shadow root) parses "in body", and so does an HTML
      // `<html>` (createContextualFragment's rule, and `<html>`'s innerHTML here — where `<body>` and `<html>` behave
      // the same).
      let ctx = contextEl;
      if (!ctx || ctx._nodeType !== NODE_ELEMENT || (ctx._ns === HTML_NS && ctx._localName === 'html')) {
        ctx = tree.createElement('body', HTML_NS, [], () => null);
      }
      let form = ctx;
      while (form && !(form._nodeType === NODE_ELEMENT && form._ns === HTML_NS && form._localName === 'form')) form = form._parent;
      const root = tree.createDocumentFragment();
      const { p, steps } = startParse(root, html, true, ctx, form || null);
      cur = p;
      try { runParse(p, steps); } finally { globalThis.__dom.htmlDone(p.id); }
      // The parsed nodes are the children of the parser's root `<html>`. Moving them into a fragment one `detachNode`
      // at a time — each an `indexOf` + `splice` off the front of the root's list and a child-list effect over every
      // remaining sibling — is quadratic: 60,000 nodes of `innerHTML` took 4 s.
      return clearEdges(root._children[0]);
    });
  }

  // Parse `html` directly into the live document, reusing its skeleton. The caller owns everything after tree
  // construction: custom-element upgrades, cascade rebuild, declarative shadow roots, and running the deferred scripts.
  function parseHtmlIntoLive(liveDoc, html, streamHooks) {
    const liveHtml = documentElementOf(liveDoc) || null;
    const liveHead = liveHtml ? liveHtml._children.find((c) => c._tag === 'head') : null;
    const liveBody = liveHtml ? liveHtml._children.find((c) => c._tag === 'body') : null;
    // A new page: a fresh arena, which the new tree fills as it is parsed (see invalidateArena).
    invalidateArena();
    syncTargetFragment();
    resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody);
    // A live document parse always uses the document's own registry (a scoped one is a FRAGMENT-parse concept).
    const skeleton = { html: liveHtml, head: liveHead, body: liveBody, usedHtml: false, usedHead: false, usedBody: false };
    withBinding(liveDoc, skeleton, streamHooks || null, undefined, () => {
      const { p, steps } = startParse(liveDoc, html, true);
      cur = p;
      try { runParse(p, steps); } finally { globalThis.__dom.htmlDone(p.id); }
    });
    // The parse builds with raw `_children` pushes (no handle bookkeeping), so register the whole new tree once. New
    // nodes carry `_ownerDoc` from creation; the reused skeleton already had handles (re-set harmlessly).
    registerSubtree(liveDoc);
    return true;
  }

  return { parseHtmlDocument, parseHtmlFragment, parseHtmlIntoLive };
}
