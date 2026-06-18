// HTML tag-soup parser + serializer.
//
// Handles void elements, attribute syntax, text nodes, and simple
// `<script>` / `<style>` raw-text. Builds real Comment nodes for
// `<!-- … -->` (including HTML5's abrupt-closing `<!-->` / `<!--->`
// empty-comment quirks) and for bogus comments (`<? … >` / `<! … >`
// that isn't a DOCTYPE); DOCTYPE tokens are ignored. No table-body
// insertion mode beyond wrapping loose `<tr>` runs in implicit
// `<tbody>`.
//
// `installHtmlParser({Document, Element, Text, Comment, DocumentFragment})`
// closes over the DOM ctors once and returns the parser/serializer
// bag. The install seam exists because ES module imports can't
// reach bridge.entry.js's IIFE-local class definitions.

import { NODE_ELEMENT, NODE_TEXT, NODE_CDATA, NODE_COMMENT, NODE_DOC, NODE_FRAGMENT } from './constants.js';

const VOID    = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
// Raw-text elements: their content is taken verbatim as a single text node, not
// parsed as markup. `<noembed>` joins script/style here (HTML tokenizer raw-text
// state). `<noframes>`/`<xmp>` would too but no app/test needs them yet.
const RAWTEXT = new Set(['script','style','noembed']);

// Elements the HTML parser's "in head" insertion mode places in `<head>`. When
// a document has no explicit `<head>`/`<body>`, the leading run of these (with
// interleaved whitespace / comments) is the implicit head; the first flow
// element (or any non-whitespace text) ends it and switches to "in body".
const HEAD_CONTENT = new Set([
  'base','basefont','bgsound','link','meta','noscript','noframes','script','style','template','title'
]);

// HTML5 "special" category (the elements that bound an implicit-close walk).
// Used by `<li>` auto-closing: a new `<li>` closes the nearest open `<li>`, but
// the walk stops at a special element other than the address/div/p exceptions
// (so `<ul><li><ul><li>` keeps the inner li nested in the inner ul).
const SPECIAL = new Set([
  'address','applet','area','article','aside','base','basefont','bgsound','blockquote',
  'body','br','button','caption','center','col','colgroup','dd','details','dir','div','dl',
  'dt','embed','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2',
  'h3','h4','h5','h6','head','header','hgroup','hr','html','iframe','img','input','keygen',
  'li','link','listing','main','marquee','menu','meta','nav','noembed','noframes','noscript',
  'object','ol','p','param','plaintext','pre','script','section','select','source','style',
  'summary','table','tbody','td','template','textarea','tfoot','th','thead','title','tr',
  'track','ul','wbr','xmp'
]);

// Block start tags that implicitly close an open `<p>` in button scope (HTML5
// "in body" insertion mode). `<div><p>x<div>` → the second div closes the p.
const CLOSES_P = new Set([
  'address','article','aside','blockquote','center','details','dialog','dir','div','dl',
  'dd','dt','fieldset','figcaption','figure','footer','header','hgroup','hr','listing','main',
  'menu','nav','ol','p','plaintext','pre','section','summary','table','ul','xmp','form',
  'h1','h2','h3','h4','h5','h6','li'
]);
// "Button scope" boundary elements — the walk that closes a `<p>` stops here.
const P_SCOPE_BOUNDARY = new Set(['applet','caption','html','table','td','th','marquee','object','template','button']);

// `<!DOCTYPE html>` / legacy `PUBLIC` / `SYSTEM` forms. Captures the
// name plus optional public / system identifiers so the document gets a
// real DocumentType node (Node.lookupNamespaceURI, document.doctype).
const DOCTYPE_RE = /^\s*<!doctype\s+([^\s>]+)(?:\s+(?:public\s+("[^"]*"|'[^']*')(?:\s+("[^"]*"|'[^']*'))?|system\s+("[^"]*"|'[^']*')))?[^>]*>/i;

export function installHtmlParser({ Document, Element, Text, Comment, DocumentFragment, DocumentType, createHtmlPageDocument, registerNamedAccess }) {
  const unquote = (s) => (s == null ? '' : s.slice(1, -1));
  // Foreign-content namespaces (local copies — the parser reaches the DOM
  // through the install seam, not by importing dom-nodes). `<svg>`/`<math>`
  // and their descendants are placed in the SVG / MathML namespace; foreign
  // attribute prefixes (xlink / xml / xmlns) resolve to their namespaces.
  // LIMITATION: no HTML-integration-point breakout (`<foreignObject>` content,
  // an HTML tag inside foreign content) and no SVG/MathML tag/attr case-
  // adjustment table — a foreign subtree is assumed wholly foreign, which
  // covers the common inline-icon case.
  const HTML_NS_P   = 'http://www.w3.org/1999/xhtml';
  const SVG_NS_P    = 'http://www.w3.org/2000/svg';
  const MATHML_NS_P = 'http://www.w3.org/1998/Math/MathML';
  const XLINK_NS_P  = 'http://www.w3.org/1999/xlink';
  const XML_NS_P    = 'http://www.w3.org/XML/1998/namespace';
  const XMLNS_NS_P  = 'http://www.w3.org/2000/xmlns/';
  // Infra "normalize newlines" (https://infra.spec.whatwg.org/#normalize-newlines):
  // the HTML input-stream preprocessing replaces every CRLF and every lone CR
  // with a single LF, before tokenization — so it applies uniformly to text,
  // attribute values, raw-text (`<script>`/`<style>`), and `<pre>`/`<textarea>`
  // content. Run once at each parse entry; the per-page cost is one linear scan
  // (usually a no-op — served HTML is already LF), negligible beside tokenizing.
  const normalizeNewlines = (s) => (typeof s === 'string' && s.indexOf('\r') !== -1) ? s.replace(/\r\n?/g, '\n') : s;
  function parseDocument(html) {
    html = normalizeNewlines(html);
    // An HTML document with a browsing context (the parser builds its own
    // html/head/body below, so no skeleton). Not the bare spec `new Document()`
    // — that is empty + application/xml + no browsing context.
    const doc = createHtmlPageDocument(false);
    // Document prolog (HTML "initial" / "before html" insertion modes): the
    // leading run of whitespace (ignored), comments, and the DOCTYPE that
    // precedes the document element. Comments here are children of the
    // DOCUMENT, before <html> — and the DOCTYPE may FOLLOW a leading comment
    // (`<!-- … --><!doctype html>`), so it isn't necessarily at offset 0.
    // Synthesize the DocumentType + Comment nodes so `document.doctype`,
    // `document.childNodes`, and doctype namespace lookups behave.
    let hasDoctype = false;
    let prologEnd = 0;
    for (;;) {
      const rest = html.slice(prologEnd);
      let m;
      if ((m = /^[\t\n\f\r ]+/.exec(rest)))   { prologEnd += m[0].length; continue; }
      if ((m = /^<!--([\s\S]*?)-->/.exec(rest))) {
        const node = new Comment(m[1]);
        node._parent = doc;
        node._ownerDoc = doc;   // symmetry with DocumentType (its ctor sets ownerDoc)
        doc._children.push(node);
        prologEnd += m[0].length; continue;
      }
      if (DocumentType && (m = DOCTYPE_RE.exec(rest))) {
        const node = new DocumentType(m[1], unquote(m[2]), unquote(m[3] || m[4]), doc);
        node._parent = doc;
        doc._children.push(node);
        hasDoctype = true;
        prologEnd += m[0].length; continue;
      }
      break;
    }
    // Drop the consumed prolog so its comments / doctype aren't re-parsed into
    // <head>/<body> by stripHtmlWrapper below.
    if (prologEnd > 0) html = html.slice(prologEnd);
    // Quirks mode: no DOCTYPE → quirks (compatMode "BackCompat"); a DOCTYPE
    // (`<!DOCTYPE html>`) → no-quirks ("CSS1Compat"). The full HTML quirks
    // algorithm keys on the doctype's name/public/system ids; this covers the
    // common no-doctype-vs-`<!DOCTYPE html>` split every page hits.
    doc._quirks = !hasDoctype;
    const root = new Element('html');
    root._parent = doc;
    doc._children.push(root);   // documentElement derives from this
    // pre-create head + body so `document.body` / `document.head`
    // work even before the parsed tree is grafted in.
    const head = new Element('head');
    const body = new Element('body');
    head._parent = root; root._children.push(head);
    body._parent = root; root._children.push(body);
    const stripped = stripHtmlWrapper(html);
    // Preserve attributes on the html / body / head opening tags so
    // page-level classes (Redmine's `body class="controller-timelog
    // action-report"` is what hides the unused `<fieldset#options>`
    // via a body-class-scoped rule) survive the parse round-trip.
    if (stripped.htmlAttrs) applyAttributes(root, stripped.htmlAttrs);
    if (stripped.headAttrs) applyAttributes(head, stripped.headAttrs);
    if (stripped.bodyAttrs) applyAttributes(body, stripped.bodyAttrs);
    const nodes = parseFragment(stripped.body);
    for (const n of nodes) { n._parent = body; body._children.push(n); }
    if (stripped.head) {
      const headNodes = parseFragment(stripped.head);
      for (const n of headNodes) { n._parent = head; head._children.push(n); }
    }
    // "In head" insertion mode for an implicit head (no explicit
    // <head>/<body>): the leading run of head-content elements — plus the
    // whitespace / comments interleaved with them — belongs to <head>, not
    // <body>. The first flow element (or any non-whitespace text) ends the
    // head. Without this a leading `<base>` / `<meta>` / `<title>` lands in
    // <body>, breaking document-base-URL resolution and `document.head`.
    if (stripped.implicitHead) {
      const kids = body._children;
      let n = 0;
      while (n < kids.length) {
        const c = kids[n];
        if (c.nodeType === NODE_ELEMENT && HEAD_CONTENT.has(c._tag)) { n++; continue; }
        if (c.nodeType === NODE_COMMENT) { n++; continue; }
        // HTML whitespace is ASCII only ([\t\n\f\r ]); `\s` would wrongly
        // swallow a lone U+FEFF text node (a decoded BOM is content, not space).
        if (c.nodeType === NODE_TEXT && /^[\t\n\f\r ]*$/.test(String(c.data || ''))) { n++; continue; }
        break;
      }
      if (n > 0) {
        const moved = kids.splice(0, n);
        for (const m of moved) { m._parent = head; head._children.push(m); }
      }
    }
    // Real HTML parsers wrap loose `<tr>` children of `<table>` in
    // an implicit `<tbody>`. Without this, `tr:first-child` against
    // a table whose `<caption>` precedes the first `<tr>` reports
    // no match (the caption is "first child", not the tr).
    for (const table of body.querySelectorAll('table')) wrapLooseTrs(table);
    return doc;
  }

  // Sweep up consecutive `<tr>` siblings (plus the inter-`<tr>` whitespace text
  // nodes and comments — they're part of the run; absorbing them keeps two
  // `<tr>`s separated by a newline or an `<!-- … -->` marker in the same
  // implicit `<tbody>`, matching how a real parser inserts inter-row comments
  // into the open tbody rather than ending it).
  function wrapLooseTrs(table) {
    const kids = table._children;
    if (!kids) return;
    const isWs   = (k) => k.nodeType === NODE_TEXT && /^\s*$/.test(String(k.data || ''));
    const isTr   = (k) => k.nodeType === NODE_ELEMENT && k._tag === 'tr';
    // Whitespace and comments don't break a tr-run; they ride along into tbody.
    const isFiller = (k) => isWs(k) || k.nodeType === NODE_COMMENT;
    let i = 0;
    while (i < kids.length) {
      if (!isTr(kids[i])) { i++; continue; }
      const tbody = new Element('tbody');
      tbody._parent = table;
      let j = i;
      while (j < kids.length) {
        const k = kids[j];
        if (isTr(k))          { /* absorb */ }
        else if (isFiller(k)) {
          // Continue only if the next non-filler is another tr.
          let p = j + 1;
          while (p < kids.length && isFiller(kids[p])) p++;
          if (p >= kids.length || !isTr(kids[p])) break;
        } else break;
        k._parent = tbody;
        tbody._children.push(k);
        j++;
      }
      kids.splice(i, j - i, tbody);
      i++;
    }
  }

  // HTML "first newline removal": the parser drops a single leading line break in
  // the raw text content of <textarea> / <pre> / <listing> — the DOM text node
  // never contains it (an authoring convenience). parse5 (the main-document
  // parser) does this at tokenize time; mirror it here as a post-pass over the
  // built fragment so the innerHTML / DOMParser path agrees, and the textarea
  // `.value` getter reads child text content VERBATIM rather than re-stripping
  // (which would double-strip a parse5-built textarea). Newlines are already
  // normalised to LF (normalizeNewlines runs at every parse entry).
  const FIRST_NEWLINE_STRIP = new Set(['textarea', 'pre', 'listing']);
  function stripFirstNewline(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType !== NODE_ELEMENT) continue;
      if (FIRST_NEWLINE_STRIP.has(n._tag)) {
        const first = n._children[0];
        if (first && first.nodeType === NODE_TEXT && first._data.charCodeAt(0) === 10) {
          first._data = first._data.slice(1);
        }
      }
      if (n._children.length) stripFirstNewline(n._children);
      if (n._templateContent && n._templateContent._children.length) stripFirstNewline(n._templateContent._children);
    }
  }

  // Alternatives that consume a comment / `<script>` / `<style>` run as one
  // opaque unit. Structural-tag scanning (findStructuralTag) and stripping
  // (stripStructural) prepend these so a `<html>` / `<head>` / `<body>` literal
  // sitting inside script data or a comment — e.g. inline JS that builds HTML
  // strings, like `parser.parseFromString('<html id=x>…')` — is skipped, never
  // matched as real document structure. None of the alternatives capture, so
  // callers' own capture groups keep their indices.
  const RAWSPAN = '<!--[\\s\\S]*?-->|<script\\b[^>]*>[\\s\\S]*?<\\/script\\s*>|' +
                  '<style\\b[^>]*>[\\s\\S]*?<\\/style\\s*>';

  // Find the first *structural* `<tag …>` (or, for a name like `/body`, its end
  // tag) — one that is NOT script/style raw-text or comment data. We early-exit
  // at the first real hit, so there is no full-document copy or rescan. Returns
  // {index, attrs, end} | null.
  function findStructuralTag(html, want, from) {
    const re = new RegExp(RAWSPAN + '|<(' + want + ')\\b([^>]*)>', 'gi');
    re.lastIndex = from || 0;
    for (let m; (m = re.exec(html));) {
      if (m[1] !== undefined) return { index: m.index, attrs: m[2] || '', end: re.lastIndex };
    }
    return null;
  }

  // Remove the leading doctype and the named structural tags (open + close)
  // from `s`, but copy comment / `<script>` / `<style>` spans through verbatim
  // — a blanket `.replace(/<\/?html…>/g, '')` would reach into raw-text and
  // delete `<html>`-shaped substrings from a script's source, silently
  // corrupting the JS that then runs.
  function stripStructural(s, tagAlt) {
    const re = new RegExp('(' + RAWSPAN + ')|<!doctype[^>]*>|<\\/?(?:' + tagAlt + ')\\b[^>]*>', 'gi');
    return s.replace(re, (m, keep) => keep != null ? keep : '');
  }

  function stripHtmlWrapper(html) {
    // Crude head/body split. When a <body> start tag is present, the head is
    // *everything before it* — the implicit head (meta/title/script/link/style
    // that precede <body>) just as much as an explicit <head>…</head>. The old
    // code only kept an explicit <head>…</head> block, so the common WPT shape
    // (implicit head with `<script src=/resources/testharness.js>` then an
    // explicit `<body>…</body>`) dropped its harness scripts entirely and every
    // such test died with "test is not defined".
    const bodyTag = findStructuralTag(html, 'body');
    if (bodyTag) {
      // html / head opening tags (for their attributes) live in the head region,
      // before <body>; a bounded, raw-text-safe scan of that prefix is enough.
      const pre      = html.slice(0, bodyTag.index);
      const htmlOpen = findStructuralTag(pre, 'html');
      const headOpen = findStructuralTag(pre, 'head');
      const head     = stripStructural(pre, 'html|head');
      const close    = findStructuralTag(html, '\\/body', bodyTag.end);
      const body     = close ? html.slice(bodyTag.end, close.index) : html.slice(bodyTag.end);
      return { head, body,
               htmlAttrs: htmlOpen ? htmlOpen.attrs : '',
               headAttrs: headOpen ? headOpen.attrs : '',
               bodyAttrs: bodyTag.attrs,
               // <body> delimits the head explicitly — no implicit-head pass.
               implicitHead: false };
    }
    // No <body> tag: an explicit <head>…</head> is the head, and the rest of the
    // input (doctype/html wrappers stripped) is body content. When the head is
    // *also* implicit, parseDocument runs the "in head" pass to lift the leading
    // head-content run out of the body. All structural detection is raw-text-safe
    // so a `<head>…</head>` / `<html …>` inside a script literal is ignored.
    const htmlOpen  = findStructuralTag(html, 'html');
    const headOpen  = findStructuralTag(html, 'head');
    const headClose = headOpen ? findStructuralTag(html, '\\/head', headOpen.end) : null;
    const hasHead   = !!(headOpen && headClose);
    // With an explicit head, the head block (tags AND content) is captured as
    // `head` below — it must be EXCISED from the body string, not merely have its
    // tags stripped. `stripStructural` only removes the `<head>` / `</head>`
    // tokens, leaving the title/meta/etc. between them behind, which would then
    // double-parse into <body> (browsers keep head content out of the body).
    const bodySrc = hasHead
      ? html.slice(0, headOpen.index) + html.slice(headClose.end)
      : html;
    return { head: hasHead ? html.slice(headOpen.end, headClose.index) : '',
             htmlAttrs: htmlOpen ? htmlOpen.attrs : '',
             headAttrs: hasHead ? headOpen.attrs : '',
             bodyAttrs: '',
             implicitHead: !hasHead,
             body: stripStructural(bodySrc, 'html') };
  }

  function parseFragment(html) {
    html = normalizeNewlines(html);
    const out = [];
    const stack = []; // { el, parentForChildren, container }
    let target = out;
    // Text / nested-element pushes inside `target` need `_parent` set
    // to the owning Element so `firstChild` / `nextSibling` traversal
    // (the path the XPath sibling axes use) walks the full sibling
    // chain. Without
    // this, text nodes were created with `_parent = null` and the
    // sibling walk fell off after the first text child.
    //
    // `<template>` is special: per spec its children belong to an
    // inert `DocumentFragment` exposed as `.content`, not the
    // template's own tree. Parsing routes them into that fragment so
    // `querySelector` / `textContent` / cascade walks naturally skip
    // them, and `template.content.cloneNode(true)` (Avo's polymorphic
    // belongs_to pattern) lands on a real DocumentFragment.
    const pushChild = (child) => {
      const frame = stack.length ? stack[stack.length - 1] : null;
      child._parent = frame ? frame.parentForChildren : null;
      target.push(child);
    };
    // Tag regex: allow `>` inside quoted attribute values. Real HTML
    // only ends a tag on an unquoted `>`; without honouring quotes,
    // attributes like `data-action="click->stim#action"` (which
    // Stimulus / Hotwire emit pervasively) end the tag prematurely
    // and split the value into bogus garbage attributes. The repeated
    // alternation handles bare chars, double-quoted strings, and
    // single-quoted strings; everything else stops at `>`.
    //
    // Comment alternative `<!-- … -->` matches first so an HTML
    // comment doesn't leak into the surrounding text run and end up
    // as part of `Element.textContent` (Avo renders ViewComponent
    // slot-controls cells as `<!-- Item controls cell -->` markers
    // that would otherwise show up in column-header text assertions).
    //
    // The `<!-->` / `<!--->` shapes are HTML5's abrupt-closing-of-
    // empty-comment quirk: per spec both are empty comments. DOMPurify
    // ≥3 uses `<!-->` as its empty-input placeholder, so without the
    // quirk handling the literal string leaks into a text node and
    // serialises back as `&lt;!--&gt;` in the input's `value` attr
    // — the key_value_field controller's `addRow()` (which sanitises
    // `''`) and Avo's `meta_data = {nil => "bar"}` /show path both
    // hit this.
    // Three alternatives, captured so the branch is decided by WHICH matched,
    // not by re-sniffing m[0]: (1) a real `<!-- … -->` comment (incl. the
    // abrupt-close `<!-->` / `<!--->` empties), (2) a bogus `<! … >` / `<? … >`
    // (DOCTYPE or comment-like), (3) a start/end tag.
    // Tag-name continuation includes `<` (U+003C): the HTML tokenizer's
    // tag-name state treats `<` as "anything else" and APPENDS it, so `<x<>`
    // is one element with local name `x<` (not `<x>` + a bogus `<` attribute).
    // Only a `<` contiguous with the tag name is absorbed — `< ` / `<` in text
    // never starts a tag (the alternation still requires a trailing `>`), so
    // well-formed markup is unaffected.
    const re = /(<!--(?:>|->|[\s\S]*?-->))|(<[!?][^>]*>)|<(\/?)([a-zA-Z][\w<-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m, last = 0;
    while ((m = re.exec(html)) !== null) {
      if (m.index > last) {
        const text = html.slice(last, m.index);
        if (text.length) pushChild(makeText(text));
      }
      // Real comment `<!-- … -->`: data is between the delimiters; the
      // `<!-->` / `<!--->` abrupt-close shapes are empty comments per HTML5.
      if (m[1] !== undefined) {
        const data = (m[1] === '<!-->' || m[1] === '<!--->') ? '' : m[1].slice(4, -3);
        pushChild(new Comment(data));
        last = re.lastIndex; continue;
      }
      // `<! … >` / `<? … >`: a DOCTYPE is ignored in content; everything else
      // is a bogus comment. The HTML tokenizer reconsumes the `?` after `<`
      // (data keeps the `?`) but begins a `<!` bogus comment after the `<!`.
      if (m[2] !== undefined) {
        if (/^<!doctype/i.test(m[2])) { last = re.lastIndex; continue; }
        const data = m[2].charAt(1) === '?' ? m[2].slice(1, -1) : m[2].slice(2, -1);
        pushChild(new Comment(data));
        last = re.lastIndex; continue;
      }
      const closing = m[3] === '/';
      const tag = m[4].toLowerCase();
      const rest = m[5];
      last = re.lastIndex;
      if (closing) {
        // pop stack until we find this tag
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].el._tag === tag) {
            stack.length = s;
            target = stack.length ? stack[stack.length - 1].container : out;
            break;
          }
        }
        continue;
      }
      // HTML5 implicit close: a new `<li>` closes an open `<li>`, and a new
      // `<dd>`/`<dt>` closes an open `<dd>` or `<dt>` (walk the open-element
      // stack to the nearest matching item, stopping at a special element other
      // than address/div/p so a nested list keeps its own item scope). Pop to
      // that item so the new one is a sibling.
      if (tag === 'li' || tag === 'dd' || tag === 'dt') {
        const isItem = tag === 'li' ? (t => t === 'li') : (t => t === 'dd' || t === 'dt');
        for (let s = stack.length - 1; s >= 0; s--) {
          const t = stack[s].el._tag;
          if (isItem(t)) {
            stack.length = s;
            target = stack.length ? stack[stack.length - 1].container : out;
            break;
          }
          if (SPECIAL.has(t) && t !== 'address' && t !== 'div' && t !== 'p') break;
        }
      }
      // HTML5 implicit close: a block start tag closes an open `<p>` in button
      // scope (`<p>x<div>` → the div is a sibling of a now-closed p).
      if (CLOSES_P.has(tag)) {
        for (let s = stack.length - 1; s >= 0; s--) {
          const t = stack[s].el._tag;
          if (t === 'p') {
            stack.length = s;
            target = stack.length ? stack[stack.length - 1].container : out;
            break;
          }
          if (P_SCOPE_BOUNDARY.has(t)) break;
        }
      }
      // Namespace: `<svg>`/`<math>` enter foreign content; a child of a foreign
      // element inherits its namespace (no integration-point breakout — see the
      // LIMITATION note). Everything else stays HTML (the Element ctor default).
      const parentNS = stack.length ? stack[stack.length - 1].el._ns : HTML_NS_P;
      const elNS = tag === 'svg'  ? SVG_NS_P
                 : tag === 'math' ? MATHML_NS_P
                 : (parentNS === SVG_NS_P || parentNS === MATHML_NS_P) ? parentNS
                 : HTML_NS_P;
      // In the "in body" insertion mode an `<html>` / `<head>` / `<body>` start
      // tag is a parse error that produces NO element — the token is ignored and
      // its contents are parsed inline at the current level (any attributes would
      // merge onto the existing root, which a fragment has none of, so they drop).
      // This is the body-context fragment path (innerHTML / insertAdjacentHTML /
      // createContextualFragment). The DOM spec maps an `<html>` createContextual-
      // Fragment context to a `<body>` context, so `<body><p>` and `<p>` both
      // yield just `<p>`, matching real browsers. Only HTML-namespaced: inside
      // SVG/MathML these are foreign elements whose breakout is the documented
      // foreign-content limitation above. parseDocument never reaches here for the
      // real wrappers — stripHtmlWrapper consumes them before calling parseFragment.
      if (elNS === HTML_NS_P && (tag === 'html' || tag === 'head' || tag === 'body')) continue;
      const el = new Element(tag);
      if (elNS !== HTML_NS_P) el._ns = elNS;   // _localName already === tag; _prefix stays null
      applyAttributes(el, rest, elNS !== HTML_NS_P);
      // A `<script>` created by the FRAGMENT parser has its "already started"
      // flag set per HTML — it must NOT execute when the fragment is inserted
      // into the document (innerHTML / insertAdjacentHTML / createContextual-
      // Fragment). The connect hook skips scripts with `_csimRan` set; document
      // scripts still run because `runInlineScripts` ignores the flag.
      //
      // EXCEPTION: a script inside `<template>` content is inert but NOT
      // already-started — its content lives in the template's separate (inert)
      // content fragment, so the parser never prepares it. It must RUN when the
      // template content is later cloned/adopted into a document (the canonical
      // "stamp out a template" pattern; WPT remove-next-sibling-during-replace-
      // with). It stays inert at page load because the content fragment isn't a
      // descendant of documentElement, so `runInlineScripts` never sees it.
      if (tag === 'script') el._csimRan = !stack.some(f => f.el._tag === 'template');
      pushChild(el);
      if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
      if (RAWTEXT.has(tag)) {
        const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        const closeIdx = html.search.call(html.slice(last), closeRe);
        const absIdx   = closeIdx < 0 ? html.length : last + closeIdx;
        const raw = html.slice(last, absIdx);
        if (raw.length) {
          // Raw-text / script-data content is verbatim: the HTML tokenizer does
          // NOT resolve character references in these states, so `new Text(raw)`
          // — not makeText (which decodeEntities) — keeps `&lt;` / `&amp;` literal
          // (inline JS like `if (a &lt; b)` and `<noembed>&lt;a&gt;</noembed>`
          // must round-trip unchanged).
          const t = new Text(raw);
          t._parent = el;
          el._children.push(t);
        }
        const end = closeIdx < 0 ? html.length : (last + closeIdx + ('</' + tag + '>').length);
        last = end; re.lastIndex = end;
        continue;
      }
      // `<template>` routes descendants into an inert
      // `DocumentFragment` (the template's `.content`) so they don't
      // bleed into qsa / textContent / cascade walks.
      if (tag === 'template') {
        const frag = new DocumentFragment();
        frag._parent = null;
        el._templateContent = frag;
        stack.push({ el, parentForChildren: frag, container: frag._children });
        target = frag._children;
        continue;
      }
      stack.push({ el, parentForChildren: el, container: el._children });
      target = el._children;
    }
    if (last < html.length) {
      const tail = html.slice(last);
      if (tail.length) pushChild(makeText(tail));
    }
    // Top-level nodes have no fragment-level parent; the caller
    // (parseDocument or `innerHTML` setter) re-parents them.
    for (const n of out) n._parent = null;
    // First-newline removal only matters for textarea/pre/listing; gate the
    // recursive walk behind a cheap source scan so the common fragment (jQuery
    // `.html()`, Turbo frame swaps, …) skips it entirely — same pattern as the
    // `/<select/i` / `/shadowrootmode/i` precedents elsewhere (rule 3).
    if (/<(?:textarea|pre|listing)[\s/>]/i.test(html)) stripFirstNewline(out);
    return out;
  }

  function makeText(s) { return new Text(decodeEntities(s)); }

  // ASCII-lowercase only (HTML attribute-name casing — same as the DOM's
  // `attrKey`). Local copy: html-parser reaches the DOM through an install
  // seam rather than importing dom-nodes directly.
  function asciiLowerAttr(s) { return s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)); }

  // In foreign (SVG / MathML) content an attribute name is case-preserving and a
  // recognised prefix (xlink / xml / xmlns, plus bare `xmlns`) carries a real
  // namespace — populate `_attrNS` so the Attr exposes namespaceURI / prefix /
  // localName (e.g. SVG `xlink:href`). Returns { key, meta } or null for a plain
  // (no-namespace) foreign attribute.
  function foreignAttr(rawName) {
    if (rawName === 'xmlns') return { key: rawName, meta: { ns: XMLNS_NS_P, prefix: null, localName: 'xmlns' } };
    const ci = rawName.indexOf(':');
    if (ci > 0) {
      const p = rawName.slice(0, ci), ln = rawName.slice(ci + 1);
      if (p === 'xmlns') return { key: rawName, meta: { ns: XMLNS_NS_P, prefix: 'xmlns', localName: ln } };
      if (p === 'xlink') return { key: rawName, meta: { ns: XLINK_NS_P, prefix: 'xlink', localName: ln } };
      if (p === 'xml')   return { key: rawName, meta: { ns: XML_NS_P,   prefix: 'xml',   localName: ln } };
    }
    return null;
  }

  function applyAttributes(el, rest, foreign) {
    // Attribute name = any run of chars except whitespace / `"` / `'` / `=` /
    // `/` / `>` (the HTML tokenizer's attribute-name-state terminators). The
    // old `[a-zA-Z_:][\w:.-]*` truncated non-ASCII names (`data-中文` → `data-`).
    const re = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    // The parser builds fresh, disconnected, not-yet-upgraded elements from
    // already-tokenized attribute names, so the full `setAttribute` IDL path
    // spends its budget on work that all no-ops here: name validation (the
    // tokenizer guarantees a name — and, unlike `setAttribute`, the HTML parser
    // must NEVER throw on one), MutationObserver records (no observers during
    // the build), and `attributeChangedCallback` (the element upgrades later via
    // `fireCEConnect`, which replays its attributes straight from `_attrs`).
    // Assign `_attrs` directly — the same shortcut the XML parser already takes.
    // Exception: a `<body>` / `<frameset>` `onX` content attribute activates a
    // window-forwarded event handler, and the per-visit graft copies `_attrs`
    // wholesale (Object.assign) without re-running that side effect — so those
    // two elements keep the full `setAttribute` path.
    const slow = el._tag === 'body' || el._tag === 'frameset';
    while ((m = re.exec(rest)) !== null) {
      const v = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
      if (slow) { el.setAttribute(m[1], decodeEntities(v)); continue; }
      if (foreign) {
        // Case-preserving keys; resolve xlink/xml/xmlns prefixes into _attrNS.
        const fa = foreignAttr(m[1]);
        el._attrs[m[1]] = decodeEntities(v);
        if (fa) (el._attrNS || (el._attrNS = {}))[fa.key] = fa.meta;
        continue;
      }
      const k = asciiLowerAttr(m[1]);
      const dv = decodeEntities(v);
      el._attrs[k] = dv;
      // A parsed name/id feeds named access (form + window); the parser
      // bypasses setAttribute, so register here too (registerNamedAccess is
      // passed through the install seam — no per-attr global lookup).
      if (k === 'id' || k === 'name') registerNamedAccess(el, k, dv);
    }
  }

  return { parseDocument, parseFragment };
}

// Serializer side does not need the DOM-ctor injection — it's pure
// node-shape traversal. Live as top-level exports so host fns
// (`__csimInnerHTML` / `__csimOuterHTML` / `__csimDocumentHtml`) can
// import directly.
// Serialize an element's attributes under their qualified NAMEs. The store key
// usually IS the qualified name; a collision-keyed namespaced attr has a
// synthetic key, so recover the qualified name from _attrNS (same as the XML
// serializer).
function serializeAttrs(el) {
  return Object.keys(el._attrs).map(n => {
    const m = el._attrNS && el._attrNS[n];
    const qn = m ? (m.prefix ? m.prefix + ':' + m.localName : m.localName) : n;
    return ' ' + qn + '="' + escapeAttr(el._attrs[n]) + '"';
  }).join('');
}

export function serializeElement(el) {
  // DocumentFragment / Comment / Unknown nodeTypes lack `_attrs` and
  // `_tag` — they shouldn't be serialised as elements. Guard so a
  // foreign node grafted into the tree doesn't crash the dump path.
  if (!el || !el._tag || !el._attrs) return '';
  const attrs = serializeAttrs(el);
  if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
  return '<' + el._tag + attrs + '>' + serializeChildren(el) + '</' + el._tag + '>';
}

// Shadow-aware serialization for `getHTML(options)`. Like serializeChildren /
// serializeElement, but when an element hosts a shadow root that `options` asks
// to serialize — `serializableShadowRoots` + the root's `serializable` flag, or
// the root being listed in `shadowRoots` — the root is emitted as a
// `<template shadowrootmode=…>` first child (HTML "serializing a shadow root").
function shouldSerializeShadow(sr, opts) {
  if (!sr) return false;
  if (opts.serializableShadowRoots && sr.serializable) return true;
  return !!(opts.shadowRoots && opts.shadowRoots.indexOf(sr) !== -1);
}
// The `<template shadowrootmode>` serialization of `el`'s own shadow root, or
// '' when there is none to serialize. Emitted as the first child of `el`.
function shadowTemplate(el, opts) {
  const sr = el && el._shadowRoot;
  if (!shouldSerializeShadow(sr, opts)) return '';
  // HTML "serializing a shadow root" attribute order: mode, delegatesfocus,
  // serializable, slotassignment (only when non-default "manual"), clonable.
  return '<template shadowrootmode="' + sr.mode + '"' +
    (sr.delegatesFocus            ? ' shadowrootdelegatesfocus=""' : '') +
    (sr.serializable              ? ' shadowrootserializable=""'   : '') +
    (sr.slotAssignment === 'manual' ? ' shadowrootslotassignment="manual"' : '') +
    (sr.clonable                  ? ' shadowrootclonable=""'       : '') +
    '>' + serializeChildrenWithShadow(sr, opts) + '</template>';
}
// Serialize `el`'s children INCLUDING `el`'s own shadow root (as the first
// child). This is the `getHTML(el)` body — so calling getHTML directly on a
// shadow host emits its template, and a host nested inside the serialized
// subtree gets its template via serializeElementWithShadow → here.
export function serializeChildrenWithShadow(el, opts) {
  let s = shadowTemplate(el, opts);   // el's own shadow root, if serializable (no-op for non-hosts)
  if (!el || !el._children) return s;
  for (const c of el._children) {
    if (c.nodeType === NODE_TEXT) s += escapeText(c.data);
    else if (c.nodeType === NODE_COMMENT) s += '<!--' + String(c.data == null ? '' : c.data) + '-->';
    else if (c.nodeType === NODE_CDATA) s += '<![CDATA[' + String(c.data == null ? '' : c.data) + ']]>';
    else s += serializeElementWithShadow(c, opts);
  }
  return s;
}
function serializeElementWithShadow(el, opts) {
  if (!el || !el._tag || !el._attrs) return '';
  const attrs = serializeAttrs(el);
  if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
  return '<' + el._tag + attrs + '>' + serializeChildrenWithShadow(el, opts) + '</' + el._tag + '>';
}

export function serializeChildren(el) {
  let s = '';
  if (!el || !el._children) return s;
  for (const c of el._children) {
    if (c.nodeType === NODE_TEXT) s += escapeText(c.data);
    else if (c.nodeType === NODE_COMMENT) s += '<!--' + String(c.data == null ? '' : c.data) + '-->';
    // CDATASection (XML docs only) serializes verbatim, not escaped — without
    // this it would fall to serializeElement and vanish (no _tag).
    else if (c.nodeType === NODE_CDATA) s += '<![CDATA[' + String(c.data == null ? '' : c.data) + ']]>';
    else s += serializeElement(c);
  }
  return s;
}

export function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    if (e === 'amp')  return '&';
    if (e === 'lt')   return '<';
    if (e === 'gt')   return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'nbsp') return ' ';
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return '';
  });
}

export function escapeAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
export function escapeText(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
