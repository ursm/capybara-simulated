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

import { CE_FAILED, elementFlag } from './element-flags.js';
import { TRACKING_NULL, finalizeSelectOptions, enqueueAttributeChanged, hasAnyCEDefinitions, registryCodeOf } from './custom-elements.js';
import { isScriptElement } from './walk.js';
import { queueToggleTask } from './form-helpers.js';
import { NODE_DOC, NODE_ELEMENT, NODE_TEXT, NODE_DOCTYPE, HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS } from './constants.js';
import { bumpStructureGen } from './cascade.js';
import { noteParserTreeChange } from './mutation-observer.js';
import { syncTargetFragment } from './target.js';
import { appendEdge, insertEdge, removeEdge, clearEdges, childIndexOf } from './tree.js';
import { PLATFORM, ceEnter, ceLeave } from './webidl.js';
import {
  invalidateArena, syncNativeAttrs, clearNativeAttrs, setAttrNamespace, setParserFormOwner, setDoctypeOf, setTemplateContentOf, relativeOf, RELATIVE_FIRST_CHILD,
  RELATIVE_LAST_CHILD, RELATIVE_PREVIOUS, rareDataOf
} from './native-query-shadow.js';   // realm state reset on in-place reparse + batched attr flush
import { documentElementOf } from './document-tree.js';


// The form-associated elements the HTML parser associates with its form element
// pointer (button/fieldset/input/object/output/select/textarea). <img> and form-
// associated custom elements are out of scope here.
const FORM_ASSOCIATED_TAGS = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);
// Whether `node` is in a document with a browsing context — the ones whose insertions the connect walk follows.
function inBrowsingContext(node) {
  let root = node;
  while (root._parent) root = root._parent;
  return root._nodeType === NODE_DOC && !root._noBrowsingContext;
}

// The steps, as html_parse.rs numbers them.
const OP_ELEMENT = 1, OP_COMMENT = 2, OP_APPEND = 3, OP_APPEND_TEXT = 4, OP_APPEND_BASED = 5, OP_APPEND_BASED_TEXT = 6,
      OP_INSERT_BEFORE = 7, OP_INSERT_TEXT_BEFORE = 8, OP_DOCTYPE = 9, OP_QUIRKS = 10, OP_ADD_ATTRS = 11,
      OP_REMOVE = 12, OP_REPARENT = 13, OP_POP = 14, OP_FORM = 15, OP_SELECTED_CONTENT = 16, OP_SCRIPT_STARTED = 17,
      OP_SHADOW_ROOT = 18;
// …and its namespaces, by number (`ns_code`).
const NAMESPACES = [null, HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS];
const QUIRKS_MODES = ['no-quirks', 'limited-quirks', 'quirks'];

export function installHtmlTreeBuilder({
  Text, Comment, DocumentFragment, DocumentType,
  createHtmlPageDocument, subtreeRemoved,
  syncInlineEventHandler, createElementNode, inertTemplateDocFor, constructParsedCustomElement, appendedAttributeSteps,
  parserInsertionSteps, attachDeclarativeShadow
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
    if (!parent) return false;
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
    if (od !== curDoc && od && od._inertTemplateDoc === od) {
      newNode._ownerDoc = od;
      const attrNodes = rareDataOf(newNode)?.attrNodes;
      if (attrNodes) for (const k in attrNodes) attrNodes[k]._ownerDoc = od;
    }
  }

  // Whether `node` is in template contents — whichever built it, the bindings or the engine: its node document is an
  // inert template document (`inertTemplateDocFor`'s, which links itself).
  function inTemplateContents(node) {
    const od = node._ownerDoc;
    return !!od && od._inertTemplateDoc === od;
  }
  // A parsed token's attribute list's value for `name` (unprefixed), or null.
  function isAttrValue(attrs, name) {
    for (let i = 0; i < attrs.length; i++) {
      if (!attrs[i].prefix && attrs[i].name === name) return attrs[i].value;
    }
    return null;
  }

  // (…the insertion itself carries the tracking null into template contents for an element with none set — the engine's,
  // ce_reactions.rs; the replay the engine leaves the bindings — markup with a lone surrogate, a live batch with a
  // customizable select open — is rare enough to ask every parent)
  function propagateParserRegistry(parentNode, newNode) {
    if (newNode._nodeType !== 1) return;
    const preg = parentNode._ceRegistry;
    if (preg === TRACKING_NULL) newNode._ceRegistry = TRACKING_NULL;
    else if (preg === null && (newNode._ceRegistry === undefined || newNode._ceRegistry === curRegistry)) newNode._ceRegistry = null;
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
      // real namespace + localName, which the attribute's record keeps so the
      // Attr exposes namespaceURI / prefix / localName — e.g. SVG `xlink:href`
      // reports the xlink namespace.
      if (a.namespace) setAttrNamespace(el, name, a.namespace, a.name);
      // An event-handler content attribute (`onclick` / `onload` / …) activates
      // the element's handler as a registered listener; on <body> / <frameset>
      // the window-reflecting handlers drive the Window's handler instead. The
      // adapter writes `_attrs` directly (bypassing setAttribute), so do it here
      // or a served `<button onclick=…>` / `<body onresize=…>` would never fire.
      syncInlineEventHandler(el, name, a.value);
      appendedAttributeSteps(el, name, a.value);
    }
    // Flush the whole set at once.
    syncNativeAttrs(el, flat);
  }

  // (…a reused element's cached Attr nodes dropped, which snapshot its previous attributes)
  function dropAttrNodes(el) {
    const rare = rareDataOf(el);
    if (rare !== undefined) rare.attrNodes = undefined;
  }

  // Reset a reused skeleton element (html/head/body) before the parser repopulates
  // it: drop its prior attributes (and the cached Attr nodes, which snapshot
  // `_attrs`) so a stale class/id from the previous page can't survive, then
  // apply the new opening-tag attributes. Children are cleared separately in
  // `resetLiveDocument`.
  function resetReusedElement(el, attrs) {
    // (…in its arena node, its attribute store)
    clearNativeAttrs(el);
    dropAttrNodes(el);
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
  // cloned/adopted — leave its flag unset (falsy): the insertion parent's node
  // document says where it is (`inTemplateContents`).
  // (…once: a script the parser moves — the adoption agency's reparenting — is one it marked already, and one whose
  // empty body the after-parse pass left unstarted, for its text to prepare it, stays so)
  function markScriptStartedFlag(scriptEl, parentNode) {
    scriptEl._forceAsync = false;   // (…a parser-inserted script is no longer "force async", HTML §4.12.1)
    if (inTemplateContents(parentNode)) return;   // inside template content → stays preparable
    scriptEl._alreadyStarted = true;
    // …and a LIVE document parse's scripts are PARSER-INSERTED: the ones "the end" (`runInlineScripts`) is for. A
    // fragment's (innerHTML) are "already started" and never run — not even when moved into the document mid-parse.
    if (live) scriptEl._parserInserted = true;
  }

  // Parser tree mutations bypass the change's record (records are observer-gated and settleGen deliberately
  // doesn't move mid-parse), but the structure generation MUST move, as a script-driven one moves it — each step below
  // bumps it: a mid-parse read (an inline script's geometry read, an autofocus visibility check) keeps memos keyed on
  // it that later parser-inserted siblings change.


  // A parsed image element with a resource URL (an <img src>, or an SVG <image> href/xlink:href) in
  // the LIVE document starts fetching + decoding as soon as it is INSERTED, so naturalWidth/complete
  // and the load event are populated for later script. Run on insertion, not creation: an <img> in a
  // <picture> resolves its parent's matching <source> ("update the image data"), which needs the
  // picture parent and the <source> siblings that only exist once the element is in the tree. Gated
  // on `live`: a DOMParser document, an innerHTML/<template> fragment, and other non-browsing-context
  // parses are inert per spec (they load no resources), and the per-(src, mode) idempotence in
  // `_loadImageResource` keeps a re-append from re-fetching.
  // (…an image in template contents none: its node document, the inert template document, is not fully active)
  function loadParsedImage(node) {
    if (live && node._nodeType === 1 && node._ownerDoc === curDoc && typeof node._imageResourceSrc === 'function' && node._imageResourceSrc()) {
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
        constructedCE = el != null && !elementFlag(el, CE_FAILED);
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
      // (…and run as the attributes are appended: HTML "create an element for a token" pushes an element queue around it
      // where it will execute script)
      if (constructedCE) parsedElementReactions(el);
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
      if (isScriptElement(newNode) && !newNode._alreadyStarted && !newNode._parserInserted) markScriptStartedFlag(newNode, parentNode);
      if (stream) stream.onInsert(parentNode, newNode);
      loadParsedImage(newNode);
      parserInsertionSteps(newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      const i = childIndexOf(parentNode, referenceNode);
      reownIntoTemplateDoc(parentNode, newNode);
      insertEdge(parentNode, newNode, i);
      // Sticky-null propagation: every parser-created child of a null-registry
      // parent (the customelementregistry attribute, transitively) is null too.
      propagateParserRegistry(parentNode, newNode);
      bumpStructureGen();
      noteParserTreeChange();
      if (isScriptElement(newNode) && !newNode._alreadyStarted && !newNode._parserInserted) markScriptStartedFlag(newNode, parentNode);
      if (stream) stream.onInsert(parentNode, newNode);
      loadParsedImage(newNode);
      parserInsertionSteps(newNode);
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
      const last = relativeOf(parentNode, RELATIVE_LAST_CHILD);
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
      const prev = relativeOf(referenceNode, RELATIVE_PREVIOUS);
      if (prev && prev._nodeType === NODE_TEXT) { prev._appendData(text); noteParserTreeChange(); if (stream) stream.onTextAppend(parentNode); return; }
      const t = new Text(text);
      t._ownerDoc = curDoc;
      tree.insertBefore(parentNode, t, referenceNode);   // re-owns into template content itself
    },
    adoptAttributes(recipient, attrs) { applyAttrs(recipient, attrs, true); noteParserTreeChange(); },

    // ── <template> content fragment ────────────────────────────────
    setTemplateContent(templateElement, contentElement) {
      // Template content is another document with a NULL registry;
      // parsed children inherit the tracking-null sentinel via the appendChild
      // propagation below and re-point when they reach a real tree.
      contentElement._ceRegistry = TRACKING_NULL;
      // Its node document is the parsing document's associated inert template
      // document; parsed descendants follow via the insert-time owner
      // propagation below.
      contentElement._ownerDoc = inertTemplateDocFor(curDoc);
      setTemplateContentOf(templateElement, contentElement);   // fragment WITH HOST (adoptNode no-ops)
    },
    // ── doctype / document mode ─────────────────────────────────────
    setDocumentType(document, name, publicId, systemId) {
      const existing = document._children.find((n) => n._nodeType === NODE_DOCTYPE);
      if (existing) {
        setDoctypeOf(existing, String(name), String(publicId == null ? '' : publicId), String(systemId == null ? '' : systemId));
        return;
      }
      const dt = new DocumentType(PLATFORM, name, publicId, systemId, document);
      appendEdge(document, dt);
    },
    setDocumentMode(document, mode) {
      // (…`_quirks` its being "quirks", the engine's: document_state.rs)
      document._compatMode = mode;
    },
    // ── the stack of open elements ──────────────────────────────────
    onItemPop(node)  {
      // (…a <select> closed where no connect walk reaches it — a parse that streams into no page, a fragment's or a
      // DOMParser's, or a template's contents in one that does: its options were inserted into it all the same, so their
      // selectedness is initialised and set; Chrome: a template's `<select><option>1<option selected>2` reads
      // selectedIndex 1)
      if (node._tag === 'select' && (!stream || !inBrowsingContext(node))) finalizeSelectOptions(node);
      if (stream && stream.onPop) stream.onPop(node);
    },
  };

  // Detach the live document's current tree in preparation for a fresh parse,
  // preserving the document / <html> / <head> / <body> element identities:
  //   - Detach the prolog (doctype / comments before <html>), its removing steps run.
  //   - Detach <html> from the document (the parser re-appends it, so the prolog
  //     it emits first lands in the correct order — before <html>).
  //   - Detach <html>'s children, <head> / <body> included (the parser re-appends
  //     them where the new markup puts them).
  //   - Empty <head> / <body> (their subtrees' removing steps run).
  // Their attributes are reset by `resetReusedElement` when the parser reuses them.
  function resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody) {
    for (const c of clearEdges(liveDoc)) if (c !== liveHtml) subtreeRemoved(c);
    // …and the root's own children, the reused `<head>` / `<body>` included: they go back in where the parser puts them.
    // Left in place, a head script saw a connected `<body>` (Chrome and Firefox: `document.body` is null until the
    // parser reaches it) and the root's other children landed after both (`<html><!--c--><head>` read HEAD, BODY,
    // #comment where the tree is #comment, HEAD, #text, BODY).
    if (liveHtml) {
      for (const c of clearEdges(liveHtml)) if (c !== liveHead && c !== liveBody) subtreeRemoved(c);
    }
    if (liveHead) {
      for (const c of clearEdges(liveHead)) subtreeRemoved(c);
    }
    if (liveBody) {
      for (const c of clearEdges(liveBody)) subtreeRemoved(c);
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
  // The node a parse's handle names: the bindings' own, or — a live document's batch the engine built (`takeBuilt`) —
  // the engine's, its object made as it is asked for; and a node the bindings made for one, which the engine is told of
  // before it builds a batch after (`syncHandles`; html_parse.rs `htmlHandle` / `htmlSetHandles`).
  function H(p, k) {
    const node = p.handles[k];
    if (node !== undefined || !p.live) return node;
    return (p.handles[k] = globalThis.__dom.htmlHandle(p.id, k) ?? undefined);
  }
  function setH(p, k, node) {
    p.handles[k] = node;
    if (p.live) p.unsynced.push(k, node);
  }
  function syncHandles(p) {
    if (p.unsynced.length === 0) return;
    globalThis.__dom.htmlSetHandles(p.id, p.unsynced);
    p.unsynced = [];
  }
  // Where the step at `i` ends.
  function stepEnd(steps, i) {
    switch (steps[i]) {
      case OP_ELEMENT:   return i + 6 + 4 * steps[i + 4];
      case OP_ADD_ATTRS: return i + 3 + 4 * steps[i + 2];
      case OP_APPEND_BASED: case OP_APPEND_BASED_TEXT: case OP_DOCTYPE: return i + 4;
      case OP_QUIRKS: case OP_REMOVE: case OP_POP: case OP_SELECTED_CONTENT: case OP_SCRIPT_STARTED: return i + 2;
      case OP_SHADOW_ROOT: return i + 5;
      default: return i + 3;
    }
  }
  // The node the element `handle` is about to be inserted into: the first later step that inserts it says where.
  function insertionParent(p, steps, i, handle) {
    const h = (k) => H(p, k), end = steps.length - 1;
    for (; i < end; i = stepEnd(steps, i)) {
      switch (steps[i]) {
        case OP_APPEND:        if (steps[i + 2] === handle) return h(steps[i + 1]); break;
        case OP_INSERT_BEFORE: if (steps[i + 2] === handle) return h(steps[i + 1])._parent; break;
        case OP_APPEND_BASED:  if (steps[i + 3] === handle) return h(steps[i + 1])._parent || h(steps[i + 2]); break;
      }
    }
    return null;
  }

  // Take `steps` from `i` on; returns the status the parser stopped with (`htmlParse`): -1 its input ran out, else the
  // handle of the script to run before it goes on.
  function takeSteps(p, steps, i) {
    const h = (k) => H(p, k), end = steps.length - 1;
    while (i < end) {
      switch (steps[i]) {
        case OP_ELEMENT: {
          const handle = steps[i + 1], n = steps[i + 4];
          const attrs = readAttrs(steps, i + 5, n), contents = steps[i + 5 + 4 * n], next = i + 6 + 4 * n;
          const el = tree.createElement(steps[i + 3], NAMESPACES[steps[i + 2]], attrs, () => insertionParent(p, steps, next, handle));
          setH(p, handle, el);
          if (contents) {
            const f = tree.createDocumentFragment();
            tree.setTemplateContent(el, f);
            setH(p, contents, f);
          }
          i = next;
          continue;
        }
        case OP_COMMENT:      setH(p, steps[i + 1], tree.createCommentNode(steps[i + 2])); break;
        case OP_APPEND:       tree.appendChild(h(steps[i + 1]), h(steps[i + 2])); break;
        case OP_APPEND_TEXT:  tree.insertText(h(steps[i + 1]), steps[i + 2]); break;
        // (…the foster parent: before the table, while it has a parent — a script may have moved it — else into the
        // element before it on the stack of open elements)
        case OP_APPEND_BASED: case OP_APPEND_BASED_TEXT: {
          const el = h(steps[i + 1]), parent = el._parent, text = steps[i] === OP_APPEND_BASED_TEXT;
          if (parent) text ? tree.insertTextBefore(parent, steps[i + 3], el) : tree.insertBefore(parent, h(steps[i + 3]), el);
          else text ? tree.insertText(h(steps[i + 2]), steps[i + 3]) : tree.appendChild(h(steps[i + 2]), h(steps[i + 3]));
          break;
        }
        case OP_INSERT_BEFORE: case OP_INSERT_TEXT_BEFORE: {
          const sibling = h(steps[i + 1]), parent = sibling._parent;
          if (parent) steps[i] === OP_INSERT_TEXT_BEFORE ? tree.insertTextBefore(parent, steps[i + 2], sibling) : tree.insertBefore(parent, h(steps[i + 2]), sibling);
          break;
        }
        case OP_DOCTYPE:      tree.setDocumentType(h(0), steps[i + 1], steps[i + 2], steps[i + 3]); break;
        case OP_QUIRKS:       tree.setDocumentMode(h(0), QUIRKS_MODES[steps[i + 1]]); break;
        case OP_ADD_ATTRS:    tree.adoptAttributes(h(steps[i + 1]), readAttrs(steps, i + 3, steps[i + 2])); break;
        case OP_REMOVE:       tree.detachNode(h(steps[i + 1])); break;
        case OP_REPARENT: {
          const node = h(steps[i + 1]), to = h(steps[i + 2]);
          for (const c of node._children) { tree.detachNode(c); tree.appendChild(to, c); }
          break;
        }
        case OP_POP:          tree.onItemPop(h(steps[i + 1])); break;
        // (…a form-associated element the parser associates with its form element pointer, unless a `form` attribute
        // names its form: `<table><form>…<input>`, where the form is no ancestor of the input)
        case OP_FORM: {
          const el = h(steps[i + 1]);
          if (el._attrs.form == null && FORM_ASSOCIATED_TAGS.has(el._tag)) setParserFormOwner(el, h(steps[i + 2]));
          break;
        }
        // (…an `<option>` closed: the stream's own `onPop` mirrors it into a customizable select's `selectedcontent`)
        case OP_SELECTED_CONTENT: break;
        // (…a `<script>` the input ended inside — or a fragment's: "already started", and no script of the parser's to
        // run once the document has been parsed)
        case OP_SCRIPT_STARTED: {
          const el = h(steps[i + 1]);
          el._alreadyStarted = true;
          el._parserInserted = false;
          el._forceAsync = false;
          break;
        }
        // (…a declarative shadow root's template, on the stack of open elements alone: the shadow root its host takes,
        // where its children go — or, where the host takes none, the template inserted after all where the parser says,
        // its children going into its contents)
        case OP_SHADOW_ROOT: {
          const host = h(steps[i + 1]), template = h(steps[i + 2]);
          const root = attachDeclarativeShadow(host, template);
          if (root) setH(p, steps[i + 3], root);
          else {
            tree.appendChild(h(steps[i + 4]), template);
            setH(p, steps[i + 3], template._templateContent);
          }
          break;
        }
      }
      i = stepEnd(steps, i);
    }
    return steps[end];
  }

  // Start a parse of `html` (html_parse.rs `htmlParse`) whose document is `doc` — an iframe srcdoc document with
  // `srcdoc`, which HTML parses in no-quirks mode whatever its doctype — or, with `context`, a fragment parse in that
  // element's context (handle 0 then `doc`, the stand-in the fragment's root `<html>` goes into).
  function startParse(doc, html, scripting, context = null, form = null, srcdoc = false, declarative = false, scriptCreated = false) {
    const ctxNs = context ? NAMESPACES.indexOf(context._ns) : 0;
    const quirks = context ? QUIRKS_MODES.indexOf((context._ownerDoc && context._ownerDoc._compatMode) || 'no-quirks') : 0;
    const text = String(html == null ? '' : html);
    // (…a live document's batches the engine builds where it can — `nextBatch` — its parse started with none run)
    const isLive = live !== null && stream !== null && context === null;
    const steps = globalThis.__dom.htmlParse(text, text.isWellFormed(), scripting, ctxNs < 0 ? 0 : ctxNs,
                                             context ? context._localName : null, form !== null, quirks < 0 ? 0 : quirks,
                                             srcdoc, declarative, isLive, scriptCreated);
    const p = { id: steps[0], doc, handles: [doc, context, form], pending: null, depth: 0, live: isLive, unsynced: [] };
    return { p, steps };
  }

  // Run the parse to its end: each script it stops for runs — a live parse's — then it goes on.
  function runParse(p, steps) {
    let status = p.live ? nextBatch(p) : takeSteps(p, steps, 1);
    while (status >= 0) {
      scriptStopped(p, H(p, status));
      status = nextBatch(p);
    }
  }
  // The parse run on to where it stops — a script to run first (its handle), or the input run out (-1) — and the batch
  // of steps it took to get there taken: a live document's built by the engine where it builds it (html_parse.rs
  // `htmlRunBuilt`: none of the page's code runs as its nodes are made and inserted, and no steps of the bindings'
  // own with them, but those `takeBuilt` runs after it), replayed here otherwise.
  // (…a batch the engine built up to a custom element it constructed and inserted — `CUSTOM_ELEMENT_INSERTED` — connected
  // as it stands, it and what came before it, before the rest of the batch: its connectedCallback runs before the next
  // start tag's constructor, as the parser's insertion of it pops the element queue it pushed)
  const MAY_BUILD = 1, CE_DEFINED = 2, OBSERVED = 4, CUSTOM_ELEMENT_INSERTED = -2;
  function nextBatch(p) {
    for (;;) {
      const status = runBatch(p);
      if (status !== CUSTOM_ELEMENT_INSERTED) return status;
      stream.onCustomElementInserted();
    }
  }
  function runBatch(p) {
    if (!p.live) return takeSteps(p, globalThis.__dom.htmlRun(p.id), 0);
    const flags = (stream.mayBuild() ? MAY_BUILD : 0) | (hasAnyCEDefinitions() ? CE_DEFINED : 0) |
      (stream.observed() ? OBSERVED : 0);
    if (flags & MAY_BUILD) syncHandles(p);
    const made = globalThis.__dom.htmlRunBuilt(p.id, flags, p.doc, inertTemplateDocFor(p.doc),
                                               live.usedHtml ? null : live.html, live.usedHead ? null : live.head, live.usedBody ? null : live.body);
    // (…none where the engine failed partway — a node factory's exception what the page sees — and the parse goes no
    // further)
    if (made === undefined) return -1;
    return made[0] === 0 ? takeSteps(p, made, 1) : takeBuilt(p, made);
  }
  // A batch the engine built (`htmlRunBuilt`'s answer): the document's mode it set; the skeleton elements it reused —
  // their bindings' state of their old attributes dropped — then the steps of the bindings' own for the elements it
  // names (`builtSteps`); and what the page's insertions feed the stream: the elements with a connection step, a style
  // sheet coming in; then the images that fetch on insertion. The status it stopped with.
  function takeBuilt(p, made) {
    const [, status, quirks, sheets, connect, images, reused] = made;
    const at = 8, imagesAt = at + connect, reusedAt = imagesAt + images, end = reusedAt + reused;
    if (quirks >= 0) tree.setDocumentMode(p.doc, QUIRKS_MODES[quirks]);
    for (let k = reusedAt; k < end; k++) {
      const el = made[k];
      dropAttrNodes(el);
      if (el === live.html) live.usedHtml = true;
      else if (el === live.head) live.usedHead = true;
      else if (el === live.body) live.usedBody = true;
    }
    builtSteps(made, at + made[7]);
    stream.onBuilt(made.slice(at, imagesAt), sheets !== 0);
    for (let k = imagesAt; k < reusedAt; k++) loadParsedImage(made[k]);
    return status;
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
  // Whether the parser runs `el` where it stopped for it: not a script in template content, which is never prepared
  // (inert, as the insertion hook treats it).
  function runsHere(el) {
    return !inTemplateContents(el);
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
    for (;;) {
      const status = nextBatch(p);
      if (status < 0) return true;                 // the insertion point: everything written is parsed
      const el = H(p, status);
      if (runsHere(el)) {
        if (stream.blocksParser(el)) { p.pending = el; return true; }
        runWithInsertionPoint(p, el);
        if (p.pending) return true;                // (…it wrote one: nothing more is tokenized until it has run)
      }
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
  // (DOMParser-parseFromString-html.html "noscript works"), and no script runs. With `declarative`, a document that
  // allows declarative shadow roots (DOMParser's does not).
  function parseHtmlDocument(html, declarative = false) {
    // (…the engine's where it builds it (html_parse.rs `htmlParseDocument`), its mode set as the parse set it)
    const built = createHtmlPageDocument(false), text = String(html == null ? '' : html);
    const made = globalThis.__dom.htmlParseDocument(text, text.isWellFormed(), built, inertTemplateDocFor(built), declarative);
    if (made !== undefined && made[0] !== -2) {
      if (made[0] >= 0) tree.setDocumentMode(built, QUIRKS_MODES[made[0]]);
      builtSteps(made, 1);
      return built;
    }
    // (…replayed here otherwise, into a document of its own)
    const doc = createHtmlPageDocument(false);
    return withBinding(doc, null, null, undefined, () => {
      const { p, steps } = startParse(doc, html, false, null, null, false, declarative);
      cur = p;
      try { runParse(p, steps); } finally { globalThis.__dom.htmlDone(p.id); }
      return doc;
    });
  }

  // Parse `html` as an HTML fragment in `contextEl`'s context (the element whose innerHTML/insertAdjacentHTML/etc. is
  // being parsed): the fragment insertion mode for the context (table / select / raw-text `<textarea>`/`<script>`/
  // `<style>`, foreign content in an `<svg>`, …), the form element pointer its nearest form, the mode of its document.
  // Returns an array of the parsed top-level nodes, detached (`_parent = null`) so the caller adopts them. New nodes are
  // owned by `contextEl`'s document (or the main document). NOT streaming: fragment scripts never run. With `declarative`
  // (setHTMLUnsafe's), the declarative shadow roots the markup makes are attached.
  function parseHtmlFragment(html, contextEl, declarative = false) {
    const ownerDoc = (contextEl && contextEl._ownerDocument) || globalThis.document;
    // Parsed elements inherit the context node's custom element registry (shadow-root or element innerHTML into a
    // scoped tree). `undefined` for the default keeps the global-registry fast path.
    const registry = contextEl ? contextEl._ceRegistry : undefined;
    // (…the engine's where it builds it: html_parse.rs `htmlParseFragment`)
    const built = buildFragment(html, contextEl, ownerDoc, declarative, registry);
    if (built !== null) return built;
    return withBinding(ownerDoc, null, null, registry, () => {
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
      const { p, steps } = startParse(root, html, true, ctx, form || null, false, declarative);
      cur = p;
      try { runParse(p, steps); } finally { globalThis.__dom.htmlDone(p.id); }
      // The parsed nodes are the children of the parser's root `<html>`. Moving them into a fragment one `detachNode`
      // at a time — each an `indexOf` + `splice` off the front of the root's list and a child-list effect over every
      // remaining sibling — is quadratic: 60,000 nodes of `innerHTML` took 4 s.
      return clearEdges(relativeOf(root, RELATIVE_FIRST_CHILD));
    });
  }

  // A fragment parse the engine builds, in `contextEl`'s context as `parseHtmlFragment` takes it — every element it makes
  // taking the context's registry association, `registry` (undefined for none): its top-level nodes, and the steps that
  // are the bindings' run for the elements it names — an attribute's (an event handler, a named property, a details'
  // `open`), a namespaced attribute's names, an element's insertion steps, a select's options set up, a details' closing
  // where its name group has another open one — after the build; null where the engine leaves it to the bindings.
  const BUILT_SELECT = 1, BUILT_INSERTED = 4, BUILT_CLOSED = 8;
  function buildFragment(html, contextEl, ownerDoc, declarative, registry) {
    const element = contextEl && contextEl._nodeType === NODE_ELEMENT && !(contextEl._ns === HTML_NS && contextEl._localName === 'html');
    const ns = element ? NAMESPACES.indexOf(contextEl._ns) : 1;
    let form = element ? contextEl : null;
    while (form && !(form._nodeType === NODE_ELEMENT && form._ns === HTML_NS && form._localName === 'form')) form = form._parent;
    const quirks = QUIRKS_MODES.indexOf((element ? contextEl._ownerDoc && contextEl._ownerDoc._compatMode : ownerDoc._compatMode) || 'no-quirks');
    const text = String(html == null ? '' : html);
    const made = globalThis.__dom.htmlParseFragment(text, text.isWellFormed(), ns < 0 ? 0 : ns, element ? contextEl._localName : 'body',
                                                   form ? form._nid : -1, quirks < 0 ? 0 : quirks, ownerDoc, inertTemplateDocFor(ownerDoc),
                                                   declarative, registryCodeOf(registry), registry);
    if (made === undefined || made[0] < 0) return null;
    const count = made[0];
    builtSteps(made, 1 + count);
    return made.slice(1, 1 + count);
  }
  // …and the bindings' steps for the elements a build names, from `made[at]` on (html_parse.rs `Build::answer`).
  function builtSteps(made, at) {
    for (let i = at; i < made.length; i += 3) {
      const el = made[i], names = made[i + 1], flags = made[i + 2];
      if (names) {
        for (const name of names) {
          syncInlineEventHandler(el, name, el._attrs[name]);
          appendedAttributeSteps(el, name, el._attrs[name]);
        }
      }
      // (…a details' exclusivity the engine's: one it closed as it inserted it — its `open` removed then — has its toggle
      // queued from the open it was made with to closed)
      if (flags & BUILT_CLOSED) queueToggleTask(el, 'open', 'closed');
      if (flags & BUILT_INSERTED) parserInsertionSteps(el, false);
      if (flags & BUILT_SELECT) finalizeSelectOptions(el);
    }
    bumpStructureGen();
    noteParserTreeChange();
  }
  // Parse `html` directly into the live document, reusing its skeleton. The caller owns everything after tree
  // construction: custom-element upgrades, cascade rebuild, and running the deferred scripts.
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
      const srcdoc = (liveDoc._url || globalThis.location?.href) === 'about:srcdoc';
      const { p, steps } = startParse(liveDoc, html, true, null, null, srcdoc, true);
      cur = p;
      try { runParse(p, steps); } finally { globalThis.__dom.htmlDone(p.id); }
    });
    return true;
  }

  // A SCRIPT-CREATED parser (HTML "document open steps" 16-17): a parse of `doc` — emptied by `open` — from no input,
  // its insertion point at the end of the input stream, which `document.write` feeds and only `document.close` ends
  // (`htmlClose`). Its parser cannot change the document's mode (step 15: no-quirks, whatever doctype is written: the
  // srcdoc rule). With `streamHooks` (the realm's own document, which has a browsing context) its scripts run at their
  // end tags, as a page load's do; without, none. The parse's record: what `writeScriptCreated` and
  // `closeScriptCreated` take.
  function openScriptCreated(doc, streamHooks) {
    const rec = { doc, hooks: streamHooks || null, skeleton: { html: null, head: null, body: null, usedHtml: true, usedHead: true, usedBody: true }, p: null };
    withBinding(doc, rec.skeleton, rec.hooks, undefined, () => {
      const { p, steps } = startParse(doc, '', rec.hooks !== null, null, null, true, rec.hooks !== null, true);
      rec.p = p;
      if (!p.live) takeSteps(p, steps, 1);
    });
    return rec;
  }
  // …`html` inserted at its insertion point and parsed up to it — its scripts run as their end tags come — unless a
  // parsing-blocking script is pending (then it waits for that). From a script it is running, the insertion point is
  // where that script's `</script>` was (`__csimWriteAtInsertionPoint`).
  function writeScriptCreated(rec, html) {
    if (globalThis.__csimWriteAtInsertionPoint(rec.doc, html)) return;
    const text = String(html);
    if (globalThis.__dom.htmlWrite(rec.p.id, text, text.isWellFormed()) !== true || rec.p.pending) return;
    parseScriptCreated(rec);
  }
  // …and its input stream ended (`document.close`, an explicit end inserted after what was written): parsed to its
  // end, the parse gone (`rec.ended`) — true where it ended now. From a script it is running, or past a pending script,
  // the parse goes on with what it has first, and ends as the write that ran it is done.
  function closeScriptCreated(rec) {
    globalThis.__dom.htmlClose(rec.p.id);
    rec.closed = true;
    if (rec.p.pending || rec.p.depth > 0) return false;
    parseScriptCreated(rec);
    return rec.ended === true;
  }
  function parseScriptCreated(rec) {
    withBinding(rec.doc, rec.skeleton, rec.hooks, undefined, () => {
      const p = rec.p;
      cur = p;
      for (let status = nextBatch(p); status >= 0; status = nextBatch(p)) scriptStopped(p, H(p, status));
    });
    if (rec.closed && !rec.ended && !rec.p.pending && rec.p.depth === 0) {
      rec.ended = true;
      globalThis.__dom.htmlDone(rec.p.id);
    }
  }

  // HTML "create an element for the token" where it will execute script, for a live batch the engine builds
  // (html_parse.rs `construct`): the custom element's constructor run with the document's throw-on-dynamic-markup-
  // insertion counter held (a `document.write` in it throws, as in Chrome) — the element, and whether it is custom (a
  // constructor that failed leaves an HTMLUnknownElement), or null where none is made — …
  globalThis.__csimConstructParsedElement = (name, doc) => {
    doc._markupInsertionCounter = (doc._markupInsertionCounter || 0) + 1;
    let el;
    try { el = constructParsedCustomElement(name, doc, null); } finally { doc._markupInsertionCounter--; }
    if (!el) return null;
    el._ownerDoc = doc;
    return [el, !elementFlag(el, CE_FAILED)];
  };
  // …and the attributeChanged reactions of the attributes the parser appended to a custom one, in attribute-list order,
  // run as it is made (an element queue pushed around it) — with the document's throw-on-dynamic-markup-insertion counter
  // still held, as the element's creation holds it until its reactions have run ("create an element for the token" step
  // 10): a `document.write` in one throws.
  function parsedElementReactions(el) {
    const doc = el._ownerDoc;
    doc._markupInsertionCounter = (doc._markupInsertionCounter || 0) + 1;
    const ce = ceEnter();
    try {
      for (const key of Object.keys(el._attrs)) {
        const [ns, , localName] = globalThis.__dom.attrName(el, key);
        enqueueAttributeChanged(el, localName, null, el._attrs[key], ns);
      }
    } finally {
      ceLeave(ce);
      doc._markupInsertionCounter--;
    }
  }
  globalThis.__csimParsedElementReactions = parsedElementReactions;

  return { builtSteps, parseHtmlDocument, parseHtmlFragment, parseHtmlIntoLive, openScriptCreated, writeScriptCreated, closeScriptCreated };
}
