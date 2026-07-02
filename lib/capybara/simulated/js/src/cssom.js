// CSSOM object model — `CSSStyleSheet` / the `CSSRule` hierarchy / `CSSRuleList` /
// `MediaList` / `StyleSheetList` / `CSSStyleDeclaration`.
//
// Rules are backed by css-tree (the SAME parser the cascade resolver uses, exposed
// as `__csimVendor.cssTree`) rather than a hand-rolled `}`-splitter: a stylesheet's
// text parses to a typed rule list, `selectorText` / `cssText` serialize back, and
// `insertRule` / `deleteRule` re-parse a single rule. Declaration blocks reuse the
// shared `CSSStyleDeclaration` proxy from style-proxy so `rule.style` and
// `el.style` behave identically. Value/shorthand-recombination serialization
// (`serialize-values`, shorthand tests) needs the full property database and is a
// separate backlog; here we serialize the parsed declaration text faithfully.

import { parseStyleDecls, splitTopLevel } from './css-utils.js';
import { serializeDeclBlock, expandShorthandsInMap } from './shorthands.js';
import { makeDeclProxy } from './style-proxy.js';
import { DOMException } from './events.js';

const CT = globalThis.__csimVendor.cssTree;

// ── serialization helpers ───────────────────────────────────────────────────

// css-tree's `generate` is compact (`a,.b>c`); CSSOM serializes a selector list
// with a space after each top-level `,` and around the `>` / `+` / `~` combinators
// (the descendant combinator is already a space). Combinators inside `[...]` /
// `(...)` (attribute selectors, `:nth-child(2n+1)`, `:is(a,b)`) are left untouched.
function normalizeSelectorText(compact) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < compact.length; i++) {
    const c = compact[i];
    if (c === '[' || c === '(') { depth++; out += c; continue; }
    if (c === ']' || c === ')') { depth--; out += c; continue; }
    if (depth === 0 && (c === '>' || c === '+' || c === '~')) {
      out = out.replace(/ $/, '') + ' ' + c + ' ';
      while (compact[i + 1] === ' ') i++;
      continue;
    }
    if (depth === 0 && c === ',') {
      out = out.replace(/ $/, '') + ', ';
      while (compact[i + 1] === ' ') i++;
      continue;
    }
    out += c;
  }
  return out;
}

// CSSOM "serialize an <An+B>": `even` → `2n`, `odd` → `2n+1`, a constant-only form keeps
// just the integer, `1n`/`-1n` collapse to `n`/`-n`, `+0`/`-0` drop, and the constant is
// re-attached with an explicit sign (`2n+1`, `-n-5`). css-tree hands us structured
// {a, b} (a null ⇒ constant only), or an even/odd identifier.
function serializeAnPlusB(a, b) {
  const bn = b == null ? 0 : Number(b);
  if (a == null) return String(bn);           // constant only (String(-0) === '0')
  const an = Number(a);
  let s = an === 1 ? 'n' : an === -1 ? '-n' : an + 'n';
  if (bn > 0) s += '+' + bn;
  else if (bn < 0) s += '-' + (-bn);
  return s;
}

// Canonicalize every `:nth-*(An+B)` argument in a parsed selector AST in place, so the
// generated text is the CSSOM canonical form regardless of how it was written.
function canonicalizeSelectorNth(node) {
  CT.walk(node, n => {
    if (n.type !== 'Nth') return;
    const arg = n.nth;
    let text = null;
    if (arg && arg.type === 'AnPlusB') text = serializeAnPlusB(arg.a, arg.b);
    else if (arg && arg.type === 'Identifier' && (arg.name === 'even' || arg.name === 'odd')) {
      text = arg.name === 'even' ? '2n' : '2n+1';
    }
    if (text !== null) n.nth = { type: 'Raw', value: text };
  });
}

function serializeSelector(preludeNode) {
  if (!preludeNode) return '';
  try {
    canonicalizeSelectorNth(preludeNode);
    return normalizeSelectorText(CT.generate(preludeNode));
  } catch (_) { return ''; }
}

// The declaration text of a css-tree block node, as a CANONICAL CSSOM
// declaration-block string (`margin: 10px; padding: 0px;`, empty → ''). Passing it
// through the shared parse + shorthand-reconstructing serialize dedups repeated
// properties (last value wins, first position kept — the CSSOM declaration semantics)
// AND collapses longhands to their shorthand, so a rule's own `cssText` agrees with
// `rule.style.cssText` (both go through serializeDeclBlock) instead of diverging.
function blockDeclText(blockNode) {
  if (!blockNode || !blockNode.children) return '';
  const parts = [];
  blockNode.children.forEach(d => {
    if (d.type !== 'Declaration') return;
    let v;
    try { v = CT.generate(d.value); } catch (_) { v = ''; }
    parts.push(d.property + ': ' + v + (d.important ? ' !important' : '') + ';');
  });
  return serializeDeclBlock(expandShorthandsInMap(parseStyleDecls(parts.join(' '))));
}

// CSSOM "serialize a CSS declaration block" wrapped as a rule body: `{ decls }` /
// `{ }`. Used by every rule with a `style` (style / font-face / page / keyframe).
function wrapBlock(declText) {
  return declText ? '{ ' + declText + ' }' : '{ }';
}

// A grouping / prelude at-rule body: `@name prelude { nested }` / `@name prelude { }`
// (used by @media / @supports / @keyframes). Shares the empty-vs-non-empty spacing
// with `wrapBlock` so the serialization shape lives in one place.
function wrapNested(atText, innerText) {
  return atText + ' ' + (innerText ? '{ ' + innerText + ' }' : '{ }');
}

// ── CSSStyleDeclaration ─────────────────────────────────────────────────────

// The class identity behind both `el.style` and `rule.style` (see makeDeclProxy in
// style-proxy, whose Proxy target inherits this prototype). Constructing one
// directly yields a detached, empty declaration block.
class CSSStyleDeclaration {
  constructor() {
    let text = '';
    return makeDeclProxy({ read: () => text, write: (s) => { text = s; }, cacheOn: {} });
  }
}

// A CSSStyleDeclaration whose text is owned by a rule: writes update the rule's
// `_declText` (so `rule.cssText` reflects edits) and re-run the rule's onChange.
function ruleStyle(rule) {
  return makeDeclProxy({
    read:    () => rule._declText || '',
    write:   (s) => { rule._declText = s; },
    cacheOn: rule
  });
}

// ── CSSRule hierarchy ───────────────────────────────────────────────────────

const RULE_TYPE = {
  STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4, FONT_FACE_RULE: 5,
  PAGE_RULE: 6, KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, MARGIN_RULE: 9, NAMESPACE_RULE: 10,
  COUNTER_STYLE_RULE: 11, SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14
};

class CSSRule {
  constructor(type, parentStyleSheet, parentRule) {
    this._type = type;
    this._parentStyleSheet = parentStyleSheet || null;
    this._parentRule = parentRule || null;
  }
  get type()             { return this._type; }
  get parentRule()       { return this._parentRule; }
  get parentStyleSheet() { return this._parentStyleSheet; }
  // `cssText` is the ONE accessor (getter + no-op setter) on the base; subclasses
  // override `_serialize()` rather than redefining `get cssText` — otherwise a
  // getter-only override would shadow the setter and `rule.cssText = x` would throw
  // in strict mode instead of being the CSSOM no-op it should be.
  get cssText()  { return this._serialize(); }
  set cssText(_) { /* CSSOM: setting cssText on a rule is a no-op */ }
  _serialize()   { return ''; }
}
// The legacy integer type constants live on the prototype (so `rule.STYLE_RULE`)
// and the constructor (so `CSSRule.STYLE_RULE`).
for (const [k, v] of Object.entries(RULE_TYPE)) { CSSRule.prototype[k] = v; CSSRule[k] = v; }

class CSSStyleRule extends CSSRule {
  constructor(node, parentStyleSheet, parentRule) {
    super(RULE_TYPE.STYLE_RULE, parentStyleSheet, parentRule);
    this._selectorText = serializeSelector(node.prelude);
    this._declText = blockDeclText(node.block);
  }
  get selectorText()  { return this._selectorText; }
  set selectorText(v) {
    // Re-parse the new selector; an empty or syntactically invalid selector is
    // ignored (CSSOM leaves the rule's current selectorText unchanged).
    const s = String(v);
    if (!s.trim()) return;
    try {
      const p = CT.parse(s, { context: 'selectorList' });
      this._selectorText = serializeSelector(p);
    } catch (_) { /* leave unchanged */ }
  }
  get style() { return this._style || (this._style = ruleStyle(this)); }
  set style(v) { this.style.cssText = v == null ? '' : String(v); }  // [PutForwards=cssText]
  // `_declText` is kept canonical (blockDeclText / serializeStyleDecls writes), so it
  // wraps directly — no per-read re-parse.
  _serialize() { return this._selectorText + ' ' + wrapBlock(this._declText || ''); }
}

// A rule that owns a plain declaration block (@font-face / @page / @keyframe frame).
class CSSDeclarationBlockRule extends CSSRule {
  constructor(type, node, parentStyleSheet, parentRule) {
    super(type, parentStyleSheet, parentRule);
    this._declText = blockDeclText(node && node.block);
  }
  get style() { return this._style || (this._style = ruleStyle(this)); }
  set style(v) { this.style.cssText = v == null ? '' : String(v); }
  get _body()  { return wrapBlock(this._declText || ''); }
}

class CSSFontFaceRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) { super(RULE_TYPE.FONT_FACE_RULE, node, sheet, parent); }
  _serialize() { return '@font-face ' + this._body; }
}

class CSSPageRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.PAGE_RULE, node, sheet, parent);
    this._selectorText = normalizePageSelector(node && node.prelude ? CT.generate(node.prelude) : '') || '';
  }
  get selectorText()  { return this._selectorText; }
  set selectorText(v) {
    // A @page selector is `<page-name>? [ : <page-pseudo> ]?` with no whitespace
    // between the name and the pseudo. An invalid selector is rejected (unchanged).
    const norm = normalizePageSelector(String(v));
    if (norm != null) this._selectorText = norm;
  }
  _serialize() {
    const sel = this._selectorText ? this._selectorText + ' ' : '';
    return '@page ' + sel + this._body;
  }
}

// Validate + serialize a @page selector: an optional page name and an optional
// `:first | :left | :right | :blank` pseudo (case-insensitive → lowercased), with
// no whitespace between them. Returns the canonical string, or null if invalid.
const PAGE_PSEUDOS = new Set(['first', 'left', 'right', 'blank']);
function normalizePageSelector(raw) {
  const s = raw.trim();
  if (s === '') return '';
  const m = /^([A-Za-z_-][\w-]*)?(?::([A-Za-z]+))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  if (m[2] && !PAGE_PSEUDOS.has(m[2].toLowerCase())) return null;
  return (m[1] || '') + (m[2] ? ':' + m[2].toLowerCase() : '');
}

// CSSGroupingRule — a rule that contains nested rules (@media / @supports). Its
// `cssRules` are parsed from the at-rule block; insertRule/deleteRule operate on them.
class CSSGroupingRule extends CSSRule {
  constructor(type, node, parentStyleSheet, parentRule) {
    super(type, parentStyleSheet, parentRule);
    this._rules = new CSSRuleList();
    if (node && node.block && node.block.children) {
      node.block.children.forEach(child => {
        const r = buildRule(child, parentStyleSheet, this);
        if (r) this._rules.push(r);
      });
    }
  }
  get cssRules() { return this._rules; }
  insertRule(text, index) {
    if (arguments.length < 1) throw new TypeError('insertRule requires a rule');
    return insertRuleInto(this._rules, this._parentStyleSheet, this, text, index);
  }
  deleteRule(index) {
    if (arguments.length < 1) throw new TypeError('deleteRule requires an index');
    return deleteRuleFrom(this._rules, index);
  }
  _nestedText() { return this._rules.map(r => r.cssText).join(' '); }
}

class CSSConditionRule extends CSSGroupingRule {
  get conditionText() { return this._conditionText || ''; }
}

class CSSMediaRule extends CSSConditionRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.MEDIA_RULE, node, sheet, parent);
    this._media = new MediaList(node && node.prelude ? CT.generate(node.prelude) : '');
    this._conditionText = this._media.mediaText;
  }
  get media()         { return this._media; }
  get conditionText() { return this._media.mediaText; }
  _serialize()       { return wrapNested('@media ' + this._media.mediaText, this._nestedText()); }
}

class CSSSupportsRule extends CSSConditionRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.SUPPORTS_RULE, node, sheet, parent);
    this._conditionText = node && node.prelude ? CT.generate(node.prelude) : '';
  }
  _serialize() {
    const inner = this._nestedText();
    return '@supports ' + this._conditionText + ' {' + (inner ? ' ' + inner + ' ' : ' ') + '}';
  }
}

class CSSImportRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.IMPORT_RULE, sheet, parent);
    // The prelude is `<url> [supports(<cond>)] [<media>]`; the URL is the first
    // String/Url token, an optional `supports(...)` the condition, the rest media.
    const raw = node && node.prelude ? CT.generate(node.prelude) : '';
    const m = /^\s*(?:url\(\s*)?(['"]?)([^'")]*)\1\s*\)?\s*(.*)$/.exec(raw) || [];
    this._href = m[2] || '';
    let rest = (m[3] || '').trim();
    const sup = /^supports\(([\s\S]*?)\)\s*/i.exec(rest);
    this._supportsText = sup ? sup[1].trim() : null;
    if (sup) rest = rest.slice(sup[0].length).trim();
    this._media = new MediaList(rest);
    this._styleSheet = null;   // we don't fetch the imported sheet
  }
  get href()         { return this._href; }
  get media()        { return this._media; }
  set media(v)       { this._media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  get supportsText() { return this._supportsText; }
  get styleSheet()   { return this._styleSheet; }
  _serialize() {
    const sup = this._supportsText != null ? ' supports(' + this._supportsText + ')' : '';
    const mt = this._media.mediaText;
    return '@import url("' + this._href + '")' + sup + (mt ? ' ' + mt : '') + ';';
  }
}

class CSSNamespaceRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.NAMESPACE_RULE, sheet, parent);
    // Prelude is `[<prefix>] <url()-or-string>`. The optional prefix is an ident
    // FOLLOWED BY whitespace before the URL — the `\s+` guard stops it from greedily
    // eating the `url` of a prefix-less `@namespace url(...)`.
    const raw = node && node.prelude ? CT.generate(node.prelude) : '';
    const m = /^\s*(?:([A-Za-z_][\w-]*)\s+)?(?:url\(\s*)?(['"]?)([^'")]*)\2\s*\)?\s*$/.exec(raw) || [];
    this._prefix = m[1] || '';
    this._namespaceURI = m[3] || '';
  }
  get prefix()       { return this._prefix; }
  get namespaceURI() { return this._namespaceURI; }
  _serialize() {
    return '@namespace ' + (this._prefix ? this._prefix + ' ' : '') + 'url("' + this._namespaceURI + '");';
  }
}

class CSSKeyframeRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.KEYFRAME_RULE, node, sheet, parent);
    this._keyText = node && node.prelude ? CT.generate(node.prelude) : '';
  }
  get keyText()  { return this._keyText; }
  set keyText(v) { this._keyText = String(v); }
  _serialize()  { return this._keyText + ' ' + this._body; }
}

class CSSKeyframesRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.KEYFRAMES_RULE, sheet, parent);
    this._name = node && node.prelude ? CT.generate(node.prelude).replace(/^['"]|['"]$/g, '') : '';
    this._rules = new CSSRuleList();
    if (node && node.block && node.block.children) {
      node.block.children.forEach(frame => {
        if (frame.type === 'Rule') this._rules.push(new CSSKeyframeRule(frame, this._parentStyleSheet, this));
      });
    }
    // Indexed getter: `keyframesRule[0]` → the 0-th CSSKeyframeRule (undefined OOR).
    return new Proxy(this, {
      get(t, k) {
        if (typeof k === 'string' && /^\d+$/.test(k)) return t._rules[+k];
        return t[k];
      }
    });
  }
  get name()      { return this._name; }
  set name(v)     { this._name = String(v); }
  get cssRules()  { return this._rules; }
  get length()    { return this._rules.length; }
  // appendRule/deleteRule/findRule are keyed by a keyframe SELECTOR (`0%`, `from`,
  // `50%,60%`) rather than an index; the key is normalized (whitespace-insensitive).
  appendRule(text) {
    let node;
    try { node = CT.parse(String(text), { context: 'rule' }); } catch (_) { return; }
    if (node && node.type === 'Rule') this._rules.push(new CSSKeyframeRule(node, this._parentStyleSheet, this));
  }
  deleteRule(select) {
    const key = normalizeKeyframeSelector(select);
    for (let i = this._rules.length - 1; i >= 0; i--) {
      if (normalizeKeyframeSelector(this._rules[i].keyText) === key) { this._rules.splice(i, 1); return; }
    }
  }
  findRule(select) {
    const key = normalizeKeyframeSelector(select);
    for (let i = this._rules.length - 1; i >= 0; i--) {
      if (normalizeKeyframeSelector(this._rules[i].keyText) === key) return this._rules[i];
    }
    return null;
  }
  _serialize() { return wrapNested('@keyframes ' + this._name, this._rules.map(r => r.cssText).join(' ')); }
}

// A keyframe selector normalized for appendRule/deleteRule/findRule matching:
// comma-separated keys, `from`/`to` → `0%`/`100%`, whitespace-insensitive.
function normalizeKeyframeSelector(select) {
  return String(select == null ? '' : select).split(',')
    .map(s => { const t = s.trim().toLowerCase(); return t === 'from' ? '0%' : t === 'to' ? '100%' : t; })
    .join(',');
}

class CSSCounterStyleRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.COUNTER_STYLE_RULE, node, sheet, parent);
    this._name = node && node.prelude ? CT.generate(node.prelude) : '';
  }
  get name()    { return this._name; }
  set name(v)   { this._name = String(v); }
  _serialize() { return '@counter-style ' + this._name + ' ' + this._body; }
}

// Map a css-tree AST node to the right CSSRule subclass. Returns null for nodes
// that don't surface as rules (@charset, Raw/unparsed fragments).
function buildRule(node, sheet, parent) {
  if (!node) return null;
  if (node.type === 'Rule') return new CSSStyleRule(node, sheet, parent);
  if (node.type === 'Atrule') {
    switch ((node.name || '').toLowerCase()) {
      case 'media':                return new CSSMediaRule(node, sheet, parent);
      case 'supports':             return new CSSSupportsRule(node, sheet, parent);
      case 'import':               return new CSSImportRule(node, sheet, parent);
      case 'namespace':            return new CSSNamespaceRule(node, sheet, parent);
      case 'font-face':            return new CSSFontFaceRule(node, sheet, parent);
      case 'page':                 return new CSSPageRule(node, sheet, parent);
      case 'keyframes':
      case '-webkit-keyframes':    return new CSSKeyframesRule(node, sheet, parent);
      case 'counter-style':        return new CSSCounterStyleRule(node, sheet, parent);
      case 'charset':              return null;   // @charset is not exposed in cssRules
      default:                     return null;   // unmodeled at-rule → skipped
    }
  }
  return null;
}

// ── CSSRuleList / MediaList / StyleSheetList ────────────────────────────────

// CSSRuleList extends Array so frameworks can iterate/`.map` it; `.item(i)` and the
// out-of-range `null` are the CSSOM surface on top.
class CSSRuleList extends Array {
  item(i) { return this[i >>> 0] || null; }
}

class MediaList {
  constructor(text) {
    this._items = parseMediaText(text);
    // A Proxy adds the CSSOM indexed getter (`mediaList[0]` → the 0-th medium)
    // without a per-index own property; every other access falls through to the
    // instance (methods, `_items`, iteration) and `instanceof MediaList` still holds.
    return new Proxy(this, {
      get(t, k) {
        // Indexed getter returns the medium string, or `undefined` (not null) when
        // out of range — matching a WebIDL indexed property getter.
        if (typeof k === 'string' && /^\d+$/.test(k)) return t._items[+k];
        return t[k];
      }
    });
  }
  get mediaText()  { return this._items.join(', '); }
  set mediaText(v) { this._items = parseMediaText(v); }
  get length()     { return this._items.length; }
  item(i)          { return this._items[i >>> 0] || null; }
  // appendMedium parses ONE medium; a comma-separated list is not a single medium,
  // so it is a no-op (per CSSOM). An already-present medium is also a no-op.
  appendMedium(m)  {
    if (arguments.length < 1) throw new TypeError('appendMedium requires a medium');
    const parts = parseMediaText(m);
    if (parts.length !== 1) return;
    if (!this._items.includes(parts[0])) this._items.push(parts[0]);
  }
  deleteMedium(m)  {
    if (arguments.length < 1) throw new TypeError('deleteMedium requires a medium');
    const parts = parseMediaText(m);
    if (parts.length !== 1) return;
    const before = this._items.length;
    this._items = this._items.filter(x => x !== parts[0]);
    if (this._items.length === before) throw new DOMException(`'${parts[0]}' not found`, 'NotFoundError');
  }
  toString()       { return this.mediaText; }
  [Symbol.iterator]() { return this._items[Symbol.iterator](); }
}

// Split a media-text string into normalized media queries: comma-separated,
// trimmed, empties dropped, and each `(feature:value)` given the canonical space
// after the colon (`(min-width:480px)` → `(min-width: 480px)`).
function parseMediaText(text) {
  return splitTopLevel(String(text || ''), ',')
    .map(s => s.trim().replace(/\(\s*([\w-]+)\s*:\s*/g, '($1: '))
    .filter(Boolean);
}

class StyleSheetList extends Array {
  item(i) { return this[i >>> 0] || null; }
}

// ── CSSStyleSheet ───────────────────────────────────────────────────────────

// Shared insertRule/deleteRule over a CSSRuleList, used by both CSSStyleSheet and
// CSSGroupingRule. `insertRule` parses exactly one rule and enforces the CSSOM
// index and hierarchy exceptions.
function insertRuleInto(list, sheet, parentRule, text, index) {
  const i = index === undefined ? 0 : index >>> 0;
  if (i > list.length) throw new DOMException('index is greater than length', 'IndexSizeError');
  // Parse as a stylesheet (the only css-tree context that accepts any rule type —
  // style rule OR at-rule) and require it to contain exactly one rule.
  let nodes;
  try {
    const ast = CT.parse(String(text), { context: 'stylesheet' });
    nodes = [];
    ast.children.forEach(n => nodes.push(n));
  } catch (_) { throw new DOMException('failed to parse the rule', 'SyntaxError'); }
  if (nodes.length !== 1) throw new DOMException('the parsed rule was not a single rule', 'SyntaxError');
  const rule = buildRule(nodes[0], sheet, parentRule);
  if (!rule) throw new DOMException('unsupported rule', 'SyntaxError');
  checkRuleInsertion(list, rule, i, !!parentRule);
  list.splice(i, 0, rule);
  return i;
}

const isImport    = (r) => r instanceof CSSImportRule;
const isNamespace = (r) => r instanceof CSSNamespaceRule;

// CSSOM "insert a CSS rule" ordering constraints (steps 6–7): the rule list must
// stay ordered @import* @namespace* (everything else)*. @import / @namespace are
// also invalid inside a grouping rule. Throws the spec exception; returns nothing.
function checkRuleInsertion(list, rule, i, nested) {
  if (nested) {
    // @import / @namespace are only valid at a stylesheet's top level.
    if (isImport(rule) || isNamespace(rule)) {
      throw new DOMException('this rule cannot be inserted here', 'HierarchyRequestError');
    }
    return;
  }
  if (isImport(rule)) {
    // An @import may only be preceded by @import (and @charset, which we don't expose).
    for (let k = 0; k < i; k++) if (!isImport(list[k])) {
      throw new DOMException('@import must precede all other rules', 'HierarchyRequestError');
    }
  } else if (isNamespace(rule)) {
    // @namespace is invalid once the sheet holds anything but @import / @namespace.
    for (const r of list) if (!isImport(r) && !isNamespace(r)) {
      throw new DOMException('@namespace not allowed with other rule types', 'InvalidStateError');
    }
    for (let k = 0; k < i; k++) if (!isImport(list[k]) && !isNamespace(list[k])) {
      throw new DOMException('@namespace misordered', 'HierarchyRequestError');
    }
    for (let k = i; k < list.length; k++) if (isImport(list[k])) {
      throw new DOMException('@namespace cannot precede an @import', 'HierarchyRequestError');
    }
  } else {
    // A normal rule cannot be inserted before an existing @import / @namespace.
    for (let k = i; k < list.length; k++) if (isImport(list[k]) || isNamespace(list[k])) {
      throw new DOMException('cannot insert a rule before an @import / @namespace', 'HierarchyRequestError');
    }
  }
}

function deleteRuleFrom(list, index) {
  const i = index >>> 0;
  if (i >= list.length) throw new DOMException('index is greater than length', 'IndexSizeError');
  // CSSOM "remove a CSS rule": removing an @namespace is invalid once the sheet holds
  // anything but @import / @namespace (a later rule may depend on the namespace prefix).
  if (isNamespace(list[i]) && list.some(r => !isImport(r) && !isNamespace(r))) {
    throw new DOMException('cannot remove @namespace while other rules exist', 'InvalidStateError');
  }
  const [removed] = list.splice(i, 1);
  // A removed rule is detached: `parentRule` / `parentStyleSheet` become null.
  if (removed) { removed._parentStyleSheet = null; removed._parentRule = null; }
}

class CSSStyleSheet {
  constructor(options) {
    options = options || {};
    this._rules = new CSSRuleList();
    this.ownerNode  = null;
    this.ownerRule  = null;
    this.parentStyleSheet = null;
    this.disabled   = !!options.disabled;
    this.href       = options.baseURL || null;
    // `title` is only set for an owned `<style>`/`<link>` sheet; the public
    // `new CSSStyleSheet()` constructor deliberately does NOT accept title/alternate
    // (WICG/construct-stylesheets#105), so a constructed sheet's title stays null.
    this._title     = options.owned ? (options.title || '') : '';
    this._media     = new MediaList(typeof options.media === 'string' ? options.media : '');
    // The public `new CSSStyleSheet()` is "constructed": it disallows @import and is
    // the only kind `replace`/`replaceSync` accept. Only the internal owned-sheet
    // builder passes `owned: true` to opt out.
    this._constructed = !options.owned;
    // Raw text kept so the shadow-tree cascade can re-parse an adopted sheet.
    this._cssText   = '';
  }
  get type()     { return 'text/css'; }
  get media()    { return this._media; }
  set media(v)   { this._media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  // `title` returns null (not '') when unset — a constructed sheet has no title
  // (the constructor deliberately ignores title/alternate, per WICG issue #105).
  get title()    { return this._title || null; }
  get cssRules() { return this._rules; }
  get rules()    { return this._rules; }   // legacy alias

  insertRule(text, index) {
    if (arguments.length < 1) throw new TypeError('insertRule requires a rule');
    const i = insertRuleInto(this._rules, this, null, text, index);
    if (this._constructed && this._rules[i] instanceof CSSImportRule) {
      this._rules.splice(i, 1);
      throw new DOMException('@import is not allowed in a constructed stylesheet', 'SyntaxError');
    }
    this._syncText();
    return i;
  }
  deleteRule(index) {
    if (arguments.length < 1) throw new TypeError('deleteRule requires an index');
    const r = deleteRuleFrom(this._rules, index);
    this._syncText();
    return r;
  }
  addRule(selector, style, index) {   // legacy IE API
    const i = index === undefined ? this._rules.length : index;
    this.insertRule(`${selector} { ${style || ''} }`, i);
    return -1;
  }
  removeRule(index)  { return this.deleteRule(index === undefined ? 0 : index); }
  // Keep the raw `_cssText` (read by the cascade for adopted sheets) in step with
  // CSSOM edits, so `sheet.insertRule(...)` / `deleteRule(...)` re-apply.
  _syncText() { this._cssText = this._rules.map(r => r.cssText).join(' '); this._notifyCascade(); }
  // A CSSOM edit changes the resolved cascade, so signal a mutation (coalesced; a
  // no-op for a sheet neither adopted nor owning a connected `<style>`). This covers
  // BOTH a constructed sheet adopted into the document / a shadow root AND an owned
  // `<style>`/`<link>` sheet mutated via insertRule/deleteRule — the cascade's
  // `effectiveStyleCss` reads an owned sheet's serialized rules once it has diverged
  // from the element's text.
  _notifyCascade() {
    if (globalThis.__csimScheduleCascadeRefresh) globalThis.__csimScheduleCascadeRefresh();
  }

  replace(text)     { try { this.replaceSync(text); return Promise.resolve(this); } catch (e) { return Promise.reject(e); } }
  replaceSync(text) {
    if (!this._constructed) throw new DOMException('replaceSync on a non-constructed sheet', 'NotAllowedError');
    this._reparse(typeof text === 'string' ? text : '', true);
    this._notifyCascade();
  }

  // Parse `cssText` into the rule list. Called for a `<style>`/`<link>` sheet
  // (dropImport=false) and for a constructed sheet's replace (dropImport=true —
  // @import/@charset are silently ignored per spec).
  _reparse(cssText, dropImport) {
    this._cssText = cssText;
    this._rules.length = 0;
    let ast;
    try { ast = CT.parse(cssText, { context: 'stylesheet' }); }
    catch (_) { return; }
    ast.children.forEach(node => {
      if (dropImport && node.type === 'Atrule' && /^(import|charset)$/i.test(node.name || '')) return;
      const rule = buildRule(node, this, null);
      if (rule) this._rules.push(rule);
    });
  }
}

// ── globals ─────────────────────────────────────────────────────────────────

globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
globalThis.CSSRule             = CSSRule;
globalThis.CSSStyleRule        = CSSStyleRule;
globalThis.CSSGroupingRule     = CSSGroupingRule;
globalThis.CSSConditionRule    = CSSConditionRule;
globalThis.CSSMediaRule        = CSSMediaRule;
globalThis.CSSSupportsRule     = CSSSupportsRule;
globalThis.CSSImportRule       = CSSImportRule;
globalThis.CSSNamespaceRule    = CSSNamespaceRule;
globalThis.CSSFontFaceRule     = CSSFontFaceRule;
globalThis.CSSPageRule         = CSSPageRule;
globalThis.CSSKeyframeRule     = CSSKeyframeRule;
globalThis.CSSKeyframesRule    = CSSKeyframesRule;
globalThis.CSSCounterStyleRule = CSSCounterStyleRule;
globalThis.CSSRuleList         = CSSRuleList;
globalThis.MediaList           = MediaList;
globalThis.StyleSheetList      = StyleSheetList;
globalThis.CSSStyleSheet       = CSSStyleSheet;

// `Object.prototype.toString.call(rule)` → `[object CSSStyleRule]` etc.: give every
// CSSOM interface its Symbol.toStringTag (the class-string tests check this, and the
// default would be the unhelpful `[object Object]`).
for (const ctor of [CSSStyleDeclaration, CSSRule, CSSStyleRule, CSSGroupingRule,
  CSSConditionRule, CSSMediaRule, CSSSupportsRule, CSSImportRule, CSSNamespaceRule,
  CSSFontFaceRule, CSSPageRule, CSSKeyframeRule, CSSKeyframesRule, CSSCounterStyleRule,
  CSSRuleList, MediaList, StyleSheetList, CSSStyleSheet]) {
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: ctor.name, configurable: true });
}

// Build a (non-constructed) "owned" sheet from a `<style>`/`<link>` element's CSS
// text — used by dom-nodes' `.sheet` / `document.styleSheets` getters. `owned: true`
// is what distinguishes it from the public `new CSSStyleSheet()` (constructed).
export function buildOwnedStyleSheet(cssText, opts) {
  const ss = new CSSStyleSheet({ ...(opts || {}), owned: true });
  ss._reparse(typeof cssText === 'string' ? cssText : '', false);
  return ss;
}
