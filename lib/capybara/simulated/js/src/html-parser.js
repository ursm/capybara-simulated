// HTML tag-soup parser + serializer.
//
// Handles void elements, attribute syntax, text nodes, and simple
// `<script>` / `<style>` raw-text. Ignores DOCTYPE / comments past
// HTML5's abrupt-closing quirks. No table-body insertion mode beyond
// wrapping loose `<tr>` runs in implicit `<tbody>`; no SVG namespace.
//
// `installHtmlParser({Document, Element, Text, DocumentFragment})`
// captures the DOM node constructors once at bridge IIFE init time
// and returns `{parseDocument, parseFragment, serializeElement,
// serializeChildren, escapeText, escapeAttr, decodeEntities}`.
// The caller binds them into its closure once and never re-installs.

import { NODE_ELEMENT, NODE_TEXT, NODE_COMMENT, NODE_DOC, NODE_FRAGMENT } from './constants.js';

const VOID    = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAWTEXT = new Set(['script','style']);

export function installHtmlParser({ Document, Element, Text, DocumentFragment }) {
  function parseDocument(html) {
    const doc = new Document();
    const root = new Element('html');
    doc.documentElement = root;
    root._parent = doc;
    doc._children.push(root);
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
    // Real HTML parsers wrap loose `<tr>` children of `<table>` in
    // an implicit `<tbody>`. Without this, `tr:first-child` against
    // a table whose `<caption>` precedes the first `<tr>` reports
    // no match (the caption is "first child", not the tr).
    for (const table of body.querySelectorAll('table')) wrapLooseTrs(table);
    return doc;
  }

  // Sweep up consecutive `<tr>` siblings (plus the inter-`<tr>`
  // whitespace text nodes — they're part of the run; absorbing them
  // keeps two `<tr>`s separated by a newline in the same implicit
  // `<tbody>`).
  function wrapLooseTrs(table) {
    const kids = table._children;
    if (!kids) return;
    const isWs = (k) => k.nodeType === NODE_TEXT && /^\s*$/.test(String(k.data || ''));
    const isTr = (k) => k.nodeType === NODE_ELEMENT && k._tag === 'tr';
    let i = 0;
    while (i < kids.length) {
      if (!isTr(kids[i])) { i++; continue; }
      const tbody = new Element('tbody');
      tbody._parent = table;
      let j = i;
      while (j < kids.length) {
        const k = kids[j];
        if (isTr(k))      { /* absorb */ }
        else if (isWs(k)) {
          // Continue only if the next non-ws is another tr.
          let p = j + 1;
          while (p < kids.length && isWs(kids[p])) p++;
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

  function stripHtmlWrapper(html) {
    // Crude: pull out <head>…</head> and <body>…</body> blocks; if
    // neither is present treat the whole thing as body content.
    const htmlMatch = /<html\b([^>]*)>/i.exec(html);
    const headMatch = /<head\b([^>]*)>([\s\S]*?)<\/head>/i.exec(html);
    const bodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
    const head      = headMatch ? headMatch[2] : '';
    const body      = bodyMatch ? bodyMatch[2] : '';
    const htmlAttrs = htmlMatch ? htmlMatch[1] : '';
    const headAttrs = headMatch ? headMatch[1] : '';
    const bodyAttrs = bodyMatch ? bodyMatch[1] : '';
    if (bodyMatch) return { head, body, htmlAttrs, headAttrs, bodyAttrs };
    // No wrapper: the whole input is body content. Strip <!doctype>.
    return { head, htmlAttrs, headAttrs, bodyAttrs,
             body: html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html\b[^>]*>/gi, '') };
  }

  function parseFragment(html) {
    const out = [];
    const stack = []; // { el, parentForChildren, container }
    let target = out;
    // Text / nested-element pushes inside `target` need `_parent` set
    // to the owning Element so `firstChild` / `nextSibling` traversal
    // (the path wgxpath uses) walks the full sibling chain. Without
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
    let i = 0;
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
    const re = /<!--(?:>|->|[\s\S]*?-->)|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m, last = 0;
    while ((m = re.exec(html)) !== null) {
      if (m.index > last) {
        const text = html.slice(last, m.index);
        if (text.length) pushChild(makeText(text));
      }
      if (m[0].startsWith('<!--')) { last = re.lastIndex; continue; }
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const rest = m[3];
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
      const el = new Element(tag);
      applyAttributes(el, rest);
      pushChild(el);
      if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
      if (RAWTEXT.has(tag)) {
        const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        const closeIdx = html.search.call(html.slice(last), closeRe);
        const absIdx   = closeIdx < 0 ? html.length : last + closeIdx;
        const raw = html.slice(last, absIdx);
        if (raw.length) {
          const t = makeText(raw);
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
    return out;
  }

  function makeText(s) { return new Text(decodeEntities(s)); }

  function applyAttributes(el, rest) {
    const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
      const v = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
      el.setAttribute(m[1], decodeEntities(v));
    }
  }

  function serializeElement(el) {
    // DocumentFragment / Comment / Unknown nodeTypes lack `_attrs` and
    // `_tag` — they shouldn't be serialised as elements. Guard so a
    // foreign node grafted into the tree doesn't crash the dump path.
    if (!el || !el._tag || !el._attrs) return '';
    const attrs = Object.keys(el._attrs).map(n => ' ' + n + '="' + escapeAttr(el._attrs[n]) + '"').join('');
    if (VOID.has(el._tag)) return '<' + el._tag + attrs + '>';
    return '<' + el._tag + attrs + '>' + serializeChildren(el) + '</' + el._tag + '>';
  }

  function serializeChildren(el) {
    let s = '';
    if (!el || !el._children) return s;
    for (const c of el._children) {
      if (c.nodeType === NODE_TEXT) s += escapeText(c.data);
      else if (c.nodeType === NODE_COMMENT) s += '<!--' + String(c.data == null ? '' : c.data) + '-->';
      else s += serializeElement(c);
    }
    return s;
  }

  return { parseDocument, parseFragment, serializeElement, serializeChildren, escapeText };
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
