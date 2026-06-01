// A small, namespace-aware XML / XHTML parser. Unlike the HTML tokenizer
// (html-parser.js) it:
//   - honours `<tag/>` self-closing on ANY element (HTML only self-closes void
//     tags, which corrupts the tree for `<div id="log"/>` etc.),
//   - preserves tag / attribute name case,
//   - materializes processing instructions (`<?target data?>`) and CDATA
//     sections (`<![CDATA[ … ]]>`) as real nodes,
//   - resolves namespaces from the in-scope `xmlns` / `xmlns:foo` declarations,
//     setting each element's `_ns` / `_prefix` / `_localName` and tagging
//     namespaced attributes into `_attrNS`.
//
// It is deliberately NOT a validating parser: it does not expand custom
// `<!ENTITY>` definitions from a DOCTYPE's internal subset, only decodes the
// predefined + numeric + HTML-named entities the shared `decodeEntities` knows,
// and (per XML, unlike HTML) does NOT treat `<script>` / `<style>` as raw text —
// their bodies are parsed as markup, so well-formed XHTML must wrap inline
// script containing `<` / `&` in `<![CDATA[ … ]]>` (which the WPT corpus does).

import { decodeEntities } from './html-parser.js';

const XML_NS   = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// Find the index of the `>` that closes the tag starting at `<` index `lt`,
// skipping `>` inside single/double-quoted attribute values.
function findTagEnd(s, lt) {
  let q = null;
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

// Parse the inside of an open tag (`name attr="v" attr2='v2'`) into a name and
// an ordered attribute list (values entity-decoded). Names keep their case.
function parseTag(inner) {
  let i = 0;
  const n = inner.length;
  while (i < n && isWs(inner[i])) i++;
  let nameEnd = i;
  while (nameEnd < n && !isWs(inner[nameEnd])) nameEnd++;
  const name = inner.slice(i, nameEnd);
  i = nameEnd;
  const attrs = [];
  while (i < n) {
    while (i < n && (isWs(inner[i]) || inner[i] === '/')) i++;
    if (i >= n) break;
    let ae = i;
    while (ae < n && !isWs(inner[ae]) && inner[ae] !== '=') ae++;
    const aname = inner.slice(i, ae);
    i = ae;
    while (i < n && isWs(inner[i])) i++;
    let avalue = '';
    if (inner[i] === '=') {
      i++;
      while (i < n && isWs(inner[i])) i++;
      const q = inner[i];
      if (q === '"' || q === "'") {
        const end = inner.indexOf(q, i + 1);
        avalue = end === -1 ? inner.slice(i + 1) : inner.slice(i + 1, end);
        i = end === -1 ? n : end + 1;
      } else {
        let ve = i;
        while (ve < n && !isWs(inner[ve])) ve++;
        avalue = inner.slice(i, ve);
        i = ve;
      }
    }
    if (aname) attrs.push({ name: aname, value: decodeEntities(avalue) });
  }
  return { name, attrs };
}

export function installXmlParser({ Element, Text, Comment, ProcessingInstruction, CDATASection, DocumentType }) {
  // Parse a `<!DOCTYPE …>` declaration body (text between `<!` and `>`, with any
  // `[ … ]` internal subset already stripped) into a DocumentType node, or null.
  function makeDoctype(decl) {
    if (!/^DOCTYPE(\s|$)/i.test(decl)) return null;
    const parts = decl.replace(/\[[\s\S]*\]/, '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const unq = (x) => (x ? x.replace(/^['"]|['"]$/g, '') : '');
    const name = parts[1] || '';
    const kw = (parts[2] || '').toUpperCase();
    let publicId = '', systemId = '';
    if (kw === 'PUBLIC')      { publicId = unq(parts[3]); systemId = unq(parts[4]); }
    else if (kw === 'SYSTEM') { systemId = unq(parts[3]); }
    return new DocumentType(name, publicId, systemId, null);
  }

  // Parse `src` into an array of top-level nodes (the document element plus any
  // surrounding comments / processing instructions).
  function parseXml(src) {
    const s = String(src == null ? '' : src);
    const n = s.length;
    const top = [];
    const stack = [];                         // open elements
    const nsStack = [{ xml: XML_NS }];        // namespace scopes: prefix → URI ('' = default)
    let i = 0;

    const append = (node) => {
      if (stack.length) {
        node._parent = stack[stack.length - 1];
        stack[stack.length - 1]._children.push(node);
      } else {
        top.push(node);
      }
    };

    while (i < n) {
      if (s[i] === '<') {
        if (s.startsWith('<!--', i)) {
          const end = s.indexOf('-->', i + 4);
          append(new Comment(end === -1 ? s.slice(i + 4) : s.slice(i + 4, end)));
          i = end === -1 ? n : end + 3;
        } else if (s.startsWith('<![CDATA[', i)) {
          const end = s.indexOf(']]>', i + 9);
          append(new CDATASection(end === -1 ? s.slice(i + 9) : s.slice(i + 9, end)));
          i = end === -1 ? n : end + 3;
        } else if (s.startsWith('<!', i)) {
          // DOCTYPE / declaration — scan to the closing `>`, balancing an
          // optional `[ … ]` internal subset (whose `<!ENTITY>` etc. we don't
          // expand). A DOCTYPE becomes a DocumentType node; anything else drops.
          let j = i + 2, depth = 0;
          for (; j < n; j++) {
            const c = s[j];
            if (c === '[') depth++;
            else if (c === ']') depth--;
            else if (c === '>' && depth <= 0) break;
          }
          const dt = makeDoctype(s.slice(i + 2, j));
          if (dt) append(dt);
          i = j < n ? j + 1 : n;
        } else if (s[i + 1] === '?') {
          const end = s.indexOf('?>', i + 2);
          const raw = end === -1 ? s.slice(i + 2) : s.slice(i + 2, end);
          i = end === -1 ? n : end + 2;
          const m = /^([^\s?]+)([\s\S]*)$/.exec(raw);
          // The `<?xml … ?>` declaration is not a processing instruction.
          if (m && m[1].toLowerCase() !== 'xml') {
            append(new ProcessingInstruction(m[1], m[2].replace(/^\s+/, ''), null));
          }
        } else if (s[i + 1] === '/') {
          const end = s.indexOf('>', i);
          if (stack.length) { stack.pop(); nsStack.pop(); }
          i = end === -1 ? n : end + 1;
        } else {
          const end = findTagEnd(s, i);
          if (end === -1) { i = n; break; }
          let inner = s.slice(i + 1, end);
          const selfClose = /\/\s*$/.test(inner);
          if (selfClose) inner = inner.replace(/\/\s*$/, '');
          const { name, attrs } = parseTag(inner);
          i = end + 1;

          // Build this element's namespace scope from the parent's + its decls.
          const scope = Object.assign({}, nsStack[nsStack.length - 1]);
          for (const a of attrs) {
            if (a.name === 'xmlns') scope[''] = a.value || null;
            else if (a.name.slice(0, 6) === 'xmlns:') scope[a.name.slice(6)] = a.value || null;
          }
          const colon = name.indexOf(':');
          const prefix = colon === -1 ? null : name.slice(0, colon);
          const localName = colon === -1 ? name : name.slice(colon + 1);
          const ns = prefix ? (scope[prefix] || null) : (scope[''] || null);

          const el = new Element(name);   // ctor lowercases _tag / _localName
          el._localName = localName;       // restore case-preserved local name
          el._prefix    = prefix;
          el._ns        = ns;
          el._attrs     = {};
          for (const a of attrs) {
            el._attrs[a.name] = a.value;
            const ac = a.name.indexOf(':');
            if (a.name === 'xmlns') {
              (el._attrNS || (el._attrNS = {}))[a.name] = { ns: XMLNS_NS, prefix: null, localName: 'xmlns' };
            } else if (ac !== -1) {
              const ap = a.name.slice(0, ac), al = a.name.slice(ac + 1);
              const ans = ap === 'xmlns' ? XMLNS_NS : ap === 'xml' ? XML_NS : (scope[ap] || null);
              (el._attrNS || (el._attrNS = {}))[a.name] = { ns: ans, prefix: ap, localName: al };
            }
          }

          append(el);
          if (!selfClose) { stack.push(el); nsStack.push(scope); }
        }
      } else {
        let j = s.indexOf('<', i);
        if (j === -1) j = n;
        const text = s.slice(i, j);
        // Whitespace between top-level nodes (around the document element) is
        // not part of the DOM; text inside elements is preserved verbatim.
        if (stack.length ? text.length : /\S/.test(text)) {
          append(new Text(decodeEntities(text)));
        }
        i = j;
      }
    }
    return top;
  }

  return { parseXml };
}
