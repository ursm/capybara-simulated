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
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// XML name productions, ASCII subset (the WPT parsererror corpus is ASCII; the
// full XML grammar allows more name characters, but flagging only clear ASCII
// violations keeps valid Unicode names from false-positiving as errors).
const isNCName = (s) => /^[A-Za-z_][\w.\-]*$/.test(s);                 // no colon
const isQName  = (s) => { const c = s.indexOf(':'); return c === -1 ? isNCName(s) : isNCName(s.slice(0, c)) && isNCName(s.slice(c + 1)); };

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
  let err = false;
  while (i < n && isWs(inner[i])) i++;
  let nameEnd = i;
  while (nameEnd < n && !isWs(inner[nameEnd])) nameEnd++;
  const name = inner.slice(i, nameEnd);
  i = nameEnd;
  const attrs = [];
  while (i < n) {
    while (i < n && (isWs(inner[i]) || inner[i] === '/')) i++;
    if (i >= n) break;
    if (inner[i] === '=') { err = true; break; }            // missing attribute name (`="x"`)
    let ae = i;
    while (ae < n && !isWs(inner[ae]) && inner[ae] !== '=') ae++;
    const aname = inner.slice(i, ae);
    i = ae;
    while (i < n && isWs(inner[i])) i++;
    if (inner[i] !== '=') { err = true; break; }            // attribute with no value — XML requires one
    i++;
    while (i < n && isWs(inner[i])) i++;
    const q = inner[i];
    if (q !== '"' && q !== "'") { err = true; break; }      // unquoted attribute value
    const end = inner.indexOf(q, i + 1);
    if (end === -1) { err = true; break; }                  // unterminated quoted value
    attrs.push({ name: aname, value: decodeEntities(inner.slice(i + 1, end)) });
    i = end + 1;
  }
  return { name, attrs, err };
}

export function installXmlParser({ Element, Text, Comment, ProcessingInstruction, CDATASection, DocumentType, finalizeElementProto }) {
  // Parse a `<!DOCTYPE …>` declaration body (text between `<!` and `>`, with any
  // `[ … ]` internal subset already stripped). Returns `{ dt, err }`: `dt` is the
  // DocumentType node (null when `decl` isn't a DOCTYPE at all), and `err` flags a
  // well-formedness violation. `PUBLIC` requires BOTH a public and a system literal
  // and `SYSTEM` a system literal; omitting the system id (`PUBLIC "…//EN"`) is an
  // error → a <parsererror> document, per XML's ExternalID production.
  function makeDoctype(decl) {
    if (!/^DOCTYPE(\s|$)/i.test(decl)) return { dt: null, err: false };
    const parts = decl.replace(/\[[\s\S]*\]/, '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const unq = (x) => (x ? x.replace(/^['"]|['"]$/g, '') : '');
    const name = parts[1] || '';
    const kw = (parts[2] || '').toUpperCase();
    let publicId = '', systemId = '';
    if (kw === 'PUBLIC') {
      if (parts[3] === undefined || parts[4] === undefined) return { dt: null, err: true };
      publicId = unq(parts[3]); systemId = unq(parts[4]);
    } else if (kw === 'SYSTEM') {
      if (parts[3] === undefined) return { dt: null, err: true };
      systemId = unq(parts[3]);
    }
    return { dt: new DocumentType(name, publicId, systemId, null), err: false };
  }

  // Extract general internal-subset entity declarations (`<!ENTITY name "value">`,
  // single- or double-quoted) from a DOCTYPE's `[ … ]` subset into `name → value`.
  // Parameter entities (`<!ENTITY % …>`) and external ones are skipped — only the
  // simple literal-value form the WPT corpus uses is honoured.
  function collectEntities(decl, into) {
    const subset = decl.match(/\[([\s\S]*)\]/);
    if (!subset) return;
    const re = /<!ENTITY\s+([^\s%][^\s]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;
    let m;
    while ((m = re.exec(subset[1])) !== null) {
      into[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
  }

  // The in-scope namespace declarations for `el` — the union of every `xmlns` /
  // `xmlns:foo` declaration on `el` and its ancestors, nearest winning. Used to
  // seed the scope when parsing a fragment in the context of an existing element
  // (XML fragment parsing algorithm), so default-namespaced markup resolves.
  function inScopeNamespaces(el) {
    const scope = { xml: XML_NS };
    const chain = [];
    // A ShadowRoot context (`shadowRoot.innerHTML = …`) is not itself in any
    // namespace; it inherits the in-scope declarations from its host's position
    // in the document tree, so start the ancestor walk at the host.
    let start = el && el._isShadowRoot ? el.host : el;
    for (let node = start; node instanceof Element; node = node._parent) chain.push(node);
    for (let k = chain.length - 1; k >= 0; k--) {   // root → context, so nearest wins
      const attrs = chain[k]._attrs || {};
      for (const name in attrs) {
        if (name === 'xmlns') scope[''] = attrs[name] || null;
        else if (name.slice(0, 6) === 'xmlns:') scope[name.slice(6)] = attrs[name] || null;
      }
    }
    return scope;
  }

  // Parse `src` into an array of top-level nodes (the document element plus any
  // surrounding comments / processing instructions). With `opts.context` set, run
  // the XML fragment parsing algorithm instead: the namespace scope is seeded from
  // the context element's in-scope declarations, top-level text is allowed, and a
  // well-formedness violation returns `null` (the caller throws a SyntaxError)
  // rather than a <parsererror> document.
  function parseXml(src, opts) {
    const context   = opts && opts.context;
    const seedScope = opts && opts.scope;     // pre-built scope (entity replacement re-parse)
    // Fragment-like modes (a context element, or an entity's replacement text)
    // signal malformity by returning `null` rather than a <parsererror> document.
    const fragment = (context !== undefined && context !== null) || (seedScope !== undefined && seedScope !== null);
    const s = String(src == null ? '' : src);
    const n = s.length;
    const top = [];
    const stack = [];                         // open elements
    const nsStack = [seedScope != null ? seedScope : context != null ? inScopeNamespaces(context) : { xml: XML_NS }];   // prefix → URI ('' = default)
    const entities = Object.create(null);     // internal-subset general entities (name → replacement text);
                                              // null-proto so `&constructor;` / `__proto__` aren't spuriously "declared"
    let i = 0;
    let err = false;                          // any XML well-formedness violation → parsererror document
    let rootCount = 0;                        // top-level elements seen; XML allows exactly one (a second → error)

    const append = (node) => {
      if (stack.length) {
        node._parent = stack[stack.length - 1];
        stack[stack.length - 1]._children.push(node);
      } else {
        top.push(node);
      }
    };

    // Append a run of character data, expanding any reference to a declared
    // general entity (`&name;`). An entity's replacement text is re-parsed as
    // markup in the current namespace scope (XML "included" processing), so a
    // value like `<span …>…</span>` materializes real element nodes; a plain
    // value like `y` yields a text node. Predefined / numeric references in the
    // surrounding text are handled by `decodeEntities` as before. The re-parse
    // starts with a fresh (empty) entity table, so a value that references
    // another general entity is NOT recursively expanded — a bounded gap that
    // also makes runaway "billion laughs" nesting impossible.
    const appendChars = (text) => {
      // XML well-formedness: every `&` must start a valid reference (`&name;`,
      // `&#d;`, `&#xH;`); a bare or unterminated `&` (e.g. `&amp` with no `;`) is an
      // error, unlike the lenient HTML entity rules decodeEntities otherwise applies.
      if (/&(?!#[0-9]+;|#[xX][0-9A-Fa-f]+;|[A-Za-z_:][\w.:-]*;)/.test(text)) err = true;
      if (!/&[^\s;&]+;/.test(text)) { append(new Text(decodeEntities(text))); return; }
      const re = /&([^\s;&]+);/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (!(m[1] in entities)) continue;     // predefined / numeric / unknown → leave for decodeEntities
        if (m.index > last) append(new Text(decodeEntities(text.slice(last, m.index))));
        const expanded = parseXml(entities[m[1]], { scope: nsStack[nsStack.length - 1] });
        if (expanded === null) { err = true; } else { for (const node of expanded) append(node); }
        last = re.lastIndex;
      }
      if (last < text.length) append(new Text(decodeEntities(text.slice(last))));
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
          // optional `[ … ]` internal subset. General `<!ENTITY>` declarations in
          // the subset are collected for `&name;` expansion; a DOCTYPE becomes a
          // DocumentType node (sans internal subset); anything else drops.
          let j = i + 2, depth = 0;
          for (; j < n; j++) {
            const c = s[j];
            if (c === '[') depth++;
            else if (c === ']') depth--;
            else if (c === '>' && depth <= 0) break;
          }
          const decl = s.slice(i + 2, j);
          const { dt, err: dtErr } = makeDoctype(decl);
          // The only `<!…>` valid in content is a DOCTYPE (`<!--` and `<![CDATA[`
          // are handled above): a malformed DOCTYPE or any other `<!…>` (e.g. the
          // mistyped `<!CDATA[`) is a well-formedness error.
          if (dt) { append(dt); collectEntities(decl, entities); }
          else err = true;
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
          const raw = end === -1 ? s.slice(i + 2) : s.slice(i + 2, end);
          const endName = raw.replace(/\s+$/, '');            // trailing ws is allowed; leading is not
          if (end === -1 || /^\s/.test(raw) || !endName) err = true;   // unterminated / `</ span>` / empty
          if (stack.length === 0) {
            err = true;                                        // end tag with no matching open element
          } else {
            const top = stack[stack.length - 1];
            const openName = top._prefix ? top._prefix + ':' + top._localName : top._localName;
            if (endName !== openName) err = true;              // mismatched / staggered tags
            stack.pop(); nsStack.pop();
          }
          i = end === -1 ? n : end + 1;
        } else {
          if (isWs(s[i + 1])) err = true;                      // `< span>` — whitespace after `<`
          const end = findTagEnd(s, i);
          if (end === -1) { err = true; i = n; break; }        // unterminated start tag (`15<span`)
          let inner = s.slice(i + 1, end);
          const selfClose = /\/\s*$/.test(inner);
          if (selfClose) inner = inner.replace(/\/\s*$/, '');
          const { name, attrs, err: tagErr } = parseTag(inner);
          if (tagErr || !isQName(name)) err = true;            // bad attribute syntax / invalid element name
          i = end + 1;

          // Build this element's namespace scope from the parent's + its decls.
          // Pass 1: build the namespace scope from this element's xmlns
          // declarations. Attribute ORDER is not significant for resolution, so
          // a prefix is in scope for every attribute regardless of where on the
          // element it's declared — validation must wait until scope is complete.
          const scope = Object.assign({}, nsStack[nsStack.length - 1]);
          for (const a of attrs) {
            if (a.name === 'xmlns') { scope[''] = a.value || null; }
            else if (a.name.slice(0, 6) === 'xmlns:') {
              const p = a.name.slice(6);
              if (!isNCName(p) || p === 'xmlns') err = true;   // `xmlns:` / `xmlns:xmlns` / bad prefix name
              else scope[p] = a.value || null;
            }
          }
          // Pass 2: validate ordinary attributes against the completed scope.
          for (const a of attrs) {
            if (a.name === 'xmlns' || a.name.slice(0, 6) === 'xmlns:') continue;
            if (!isQName(a.name)) { err = true; continue; }    // invalid attribute name (`::`)
            const ac = a.name.indexOf(':');
            if (ac !== -1 && a.name.slice(0, ac) !== 'xml' && !(a.name.slice(0, ac) in scope)) {
              err = true;                                      // undeclared attribute prefix (`x:test`)
            }
          }
          const colon = name.indexOf(':');
          const prefix = colon === -1 ? null : name.slice(0, colon);
          const localName = colon === -1 ? name : name.slice(colon + 1);
          if (prefix && prefix !== 'xml' && !(prefix in scope)) err = true;   // undeclared element prefix
          const ns = prefix ? (scope[prefix] || null) : (scope[''] || null);

          const el = new Element(name);   // ctor lowercases _tag / _localName
          el._localName = localName;       // restore case-preserved local name
          el._prefix    = prefix;
          el._ns        = ns;
          finalizeElementProto(el);        // XML (non-HTML / case-preserved) reverts to base Element.prototype
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

          // A `<script>` produced by FRAGMENT parsing has its "already started"
          // flag set (HTML §fragment parsing) so it does NOT execute when the
          // fragment is inserted (innerHTML / insertAdjacentHTML in XML). The
          // connect hook skips scripts with `_csimRan` set. Mirrors html-parser.js.
          if (fragment && el._tag === 'script') el._csimRan = true;

          // A second top-level element is malformed — an XML document has one root.
          // (In a fragment parse multiple top-level elements are allowed.)
          if (!fragment && stack.length === 0 && ++rootCount > 1) err = true;
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
          appendChars(text);
        }
        i = j;
      }
    }
    if (stack.length > 0) err = true;          // open elements left unclosed at end of input
    if (fragment) return err ? null : top;     // fragment: signal malformity to the caller (→ SyntaxError)
    if (err) {
      // Any well-formedness violation yields a document whose single element is
      // a <parsererror> (the Mozilla-style error document the DOM spec/browsers
      // surface), replacing whatever partial tree was built.
      const pe = new Element('parsererror');
      pe._localName = 'parsererror';
      pe._ns        = PARSERERROR_NS;
      const msg = new Text('XML parsing error');
      msg._parent = pe;
      pe._children.push(msg);
      return [pe];
    }
    return top;
  }

  return { parseXml };
}
