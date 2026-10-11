// The XML / XHTML parser is the engine's (xml_parse.rs: namespace-aware, `<tag/>` on any element, names' case kept,
// processing instructions and CDATA sections as nodes, a `<script>` / `<style>` body parsed as markup, a DOCTYPE's
// literal general entities expanded): it answers the steps that make the nodes, which these bindings replay — the
// objects are theirs to construct — with each node's own steps as the parser inserts it (an inline handler, an
// attribute's appended steps, an HTML `<template>`'s contents, a script's flags).

import { HTML_NS } from './constants.js';
import { setAttrMeta, setTemplateContentOf } from './native-query-shadow.js';
import { isScriptElement } from './walk.js';
import { appendEdge } from './tree.js';
import { PLATFORM } from './webidl.js';

const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

// The steps' opcodes (xml_parse.rs `OP_*`).
const OP_ELEMENT = 0, OP_TEXT = 1, OP_COMMENT = 2, OP_DOCTYPE = 5, OP_PI = 4;

export function installXmlParser({
  createElementNode, Text, Comment, ProcessingInstruction, CDATASection, DocumentType, DocumentFragment, syncInlineEventHandler,
  appendedAttributeSteps, parserInsertionSteps, TRACKING_NULL
}) {
  // An XHTML `<template>`'s contents, made as the parser first puts a node in it: an empty fragment, linked as the
  // template's (the engine's).
  function templateContentFor(template) {
    const content = new DocumentFragment();
    content._ceRegistry = TRACKING_NULL;   // (…another document's, with a null registry, as the HTML parser's are)
    setTemplateContentOf(template, content);
    return content;
  }

  // `src` parsed into its top-level nodes: a document's (its element, and the comments, processing instructions and
  // doctype around it) — a `<parsererror>` one where it is not well-formed — or, with `opts.context` an element, a
  // fragment's in that element's namespace scope (XML fragment parsing): its top level may hold text and more than one
  // element, and where it is not well-formed none, null (the caller throws a SyntaxError).
  function parseXml(src, opts) {
    const context = opts && opts.context;
    const fragment = context !== undefined && context !== null;
    const steps = globalThis.__dom.xmlParse(String(src == null ? '' : src), fragment ? context._nid : -1);
    if (steps === null) {
      if (fragment) return null;
      const pe = createElementNode('parsererror', PARSERERROR_NS);
      appendEdge(pe, new Text('XML parsing error'));
      return [pe];
    }
    const nodes = [], top = [];
    for (let i = 0; i < steps.length;) {
      const op = steps[i], parent = steps[i + 1];
      let node;
      if (op === OP_ELEMENT) {
        const localName = steps[i + 2], ns = steps[i + 3], prefix = steps[i + 4], count = steps[i + 5];
        node = createElementNode(localName, ns, localName, prefix);   // `_tag` its local name lowercased, as createElementNS makes it
        i += 6;
        for (let k = 0; k < count; k++, i += 5) {
          const name = steps[i], value = steps[i + 1], localPart = steps[i + 4];
          node._attrs[name] = value;
          syncInlineEventHandler(node, name, value);   // an on* attribute (SVG in XML) activates its handler
          appendedAttributeSteps(node, name, value);
          if (localPart !== undefined) setAttrMeta(node, name, { ns: steps[i + 2], prefix: steps[i + 3], localName: localPart });
          // XML "create an element": an HTML element's `is` attribute is its is value (fixed at creation).
          if (name === 'is' && ns === HTML_NS) node._isValue = value;
        }
        // (…a script parser-inserted: no longer "force async" — and a fragment's "already started", so its insertion
        // runs it not, where a document's is one the after-parse pass runs)
        if (isScriptElement(node)) {
          node._forceAsync = false;
          if (fragment) node._alreadyStarted = true;
          else node._parserInserted = true;
        }
      } else if (op === OP_DOCTYPE) {
        node = new DocumentType(PLATFORM, steps[i + 2], steps[i + 3], steps[i + 4], null);
        i += 5;
      } else if (op === OP_PI) {
        node = new ProcessingInstruction(PLATFORM, steps[i + 2], steps[i + 3], null);
        i += 4;
      } else {
        const data = steps[i + 2];
        node = op === OP_TEXT ? new Text(data) : op === OP_COMMENT ? new Comment(data) : new CDATASection(PLATFORM, data);
        i += 3;
      }
      nodes.push(node);
      if (parent < 0) {
        top.push(node);
        continue;
      }
      // (…an HTML `<template>`'s children its contents', any other element's its own)
      const open = nodes[parent];
      appendEdge(open._ns === HTML_NS && open._localName === 'template' ? (open._templateContent || templateContentFor(open)) : open, node);
      parserInsertionSteps(node);
    }
    return top;
  }

  return { parseXml };
}
