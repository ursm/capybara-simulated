// CSSOM object model — `CSSStyleSheet` / the `CSSRule` hierarchy / `CSSRuleList` /
// `MediaList` / `StyleSheetList` / `CSSStyleDeclaration`.
//
// The rule list is css-tree's (`__csimVendor.cssTree`): a stylesheet's text parses to a typed rule list, `cssText`
// serializes back, and `insertRule` / `deleteRule` re-parse a single rule. What a rule SAYS is the style engine's: a
// style rule's selector is the list it parses (cssom_rule.rs), and every declaration block — through the
// `CSSStyleDeclaration` proxy `el.style` shares — the block it parses (cssom_decl.rs).

import { splitTopLevel, fetchStyleSheetText, CSS_PROPERTY_BY_IDL_ATTRIBUTE, documentBaseUrl } from './css-utils.js';
import { makeDeclProxy, declarationImplementation } from './style-proxy.js';
import { DOMException } from './events.js';

const CT = globalThis.__csimVendor.cssTree;
// A rule's prelude — a style rule's selector, a keyframe's key — is kept as written: the engine is what reads a selector
// (cssom_rule.rs), and parsing one here only to write it back out cost more than the engine's parse.
const PARSE_RULE  = { context: 'rule', parseRulePrelude: false };
const PARSE_SHEET = { context: 'stylesheet', parseRulePrelude: false };

// ── serialization helpers ───────────────────────────────────────────────────

// A style rule's selector list as the style engine parses and serializes it (cssom_rule.rs) — under the namespaces the
// sheet's `@namespace` rules declare, relative to the parent rule's when nested — or null where the engine does not
// parse it, which makes it no selector a rule can have.
function engineSelectorText(text, rule) {
  const ns = sheetNamespaces(rule._parentStyleSheet);
  return globalThis.__dom.selectorText(text, ns.default, ns.prefixes, rule._parentRule instanceof CSSStyleRule);
}

// The stylesheet's declared namespaces: `{ default: <uri|null>, prefixes: [prefix, uri, …] }`.
// @namespace rules must precede every style rule, so a style rule's sheet already holds them
// by the time its selector is serialized. They live in the leading @import*/@namespace* run,
// so we stop at the first ordinary rule — keeping this O(leading at-rules), not O(all rules),
// even though it's called once per style-rule construction (rule 3: no O(n²) on big sheets).
function sheetNamespaces(sheet) {
  const prefixes = [];
  let def = null;
  if (sheet && sheet._rules) {
    for (const r of sheet._rules) {
      if (r._type === RULE_TYPE.NAMESPACE_RULE) {
        if (r._prefix === '') def = r._namespaceURI;
        else prefixes.push(r._prefix, r._namespaceURI);
      } else if (r._type !== RULE_TYPE.IMPORT_RULE) {
        break;   // first ordinary rule reached — no @namespace can follow it
      }
    }
  }
  return { default: def, prefixes };
}

// The declaration text of a css-tree block node, as its SOURCE says it: what the sheet the style engine cascades from
// is rebuilt out of when a rule is edited, so a rule nobody touched keeps every digit it was written with
// (`canonicalDeclText` is what CSSOM reads of it).
function blockDeclText(blockNode) {
  if (!blockNode || !blockNode.children) return '';
  const parts = [];
  blockNode.children.forEach(d => {
    if (d.type !== 'Declaration') return;
    // Generated COMPONENT BY COMPONENT, joined with the space the tokens need. css-tree's own
    // generator writes the value as one run and drops the whitespace BETWEEN components, which
    // turned `background: #fff url(a.png) no-repeat` into `…url("a.png")no-repeat` — text this
    // driver's own parser then read as one token, so a rule edit anywhere in the sheet (every one
    // regenerates the whole sheet from these strings) silently changed what the cascade saw.
    let v;
    try {
      v = d.value.children
        ? d.value.children.toArray().map((child) => CT.generate(child)).join(' ')
        : CT.generate(d.value);
    } catch (_) { v = ''; }
    parts.push(d.property + ': ' + v + (d.important ? ' !important' : '') + ';');
  });
  return parts.join(' ');
}
// …as a CANONICAL CSSOM declaration-block string (`margin: 10px; padding: 0px;`, empty → ''), for a block of `kind`
// (`BLOCK_KIND_OF_RULE`): the style engine's parse and serialization of it, as `rule.style` reads it — so a rule's
// own `cssText` agrees with `rule.style.cssText`.
function canonicalDeclText(text, kind) {
  if (!text) return '';
  const doc = globalThis.document;
  return globalThis.__dom.declText(text, kind, !!(doc && doc._quirks), documentBaseUrl(), -1);
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

// CSSOM "serialize a CSS rule" for a grouping at-rule (@media / @supports): the prelude,
// then a brace block with each child rule on its own 2-space-indented line —
// `@media print {\n  #foo { … }\n}`, or `@media print {\n}` when empty.
function wrapGroupingRule(atText, childCssTexts) {
  return atText + ' {\n' + childCssTexts.map(c => '  ' + c + '\n').join('') + '}';
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
// CSSStyleDeclaration is an indexed property-name list, hence iterable. The decl proxy
// synthesizes iteration per instance, but the interface prototype must ALSO expose @@iterator
// (an author checks `Symbol.iterator in CSSStyleDeclaration.prototype`). It IS Array's `values`
// (the default indexed-property iterator), which iterates the proxy's length + indexed items.
CSSStyleDeclaration.prototype[Symbol.iterator] = Array.prototype.values;

// The interface's members, where CSSOM puts them: on the prototype. A declaration is a Proxy that
// synthesizes each one in its `get` trap, which answers a read but leaves REFLECTION empty —
// `Reflect.ownKeys` / `Reflect.getOwnPropertyDescriptor` walking the chain found nothing, so
// `'setProperty' in el.style` was true while `CSSStyleDeclaration.prototype.setProperty` was
// `undefined`, and `css/css-logical/getComputedStyle-listing.html`, which looks for a property by
// walking for a descriptor, failed on all 30 of its logical longhands.
//
// Two families: CSSOM's own members, and the IDL attribute it defines for every supported CSS
// property — the camel-cased spelling, the dashed one, `webkitAppearance`, `cssFloat`. Both go on
// the PROTOTYPE, not the instance, so `getComputedStyle(el).hasOwnProperty('color')` stays false,
// which is what `cssom/cssstyledeclaration-properties.html` asserts and what Chrome — which makes
// them own data properties per instance — fails. See the spec file for that measurement; the two
// agree on every read, and differ in what `for…in` walks.
//
// All three declaration proxies trap `get` and `set` ahead of the prototype, so these definitions
// are the reflection surface rather than the read path: one pass at realm boot, nothing per read.
// Measured Ruby-side against the parent commit, interleaved: a bare-page navigation is unchanged
// (4.1 ms), and READS got faster, because the table generated alongside these also short-cuts the
// fold `camelToKebab` used to run — `el.style.marginLeft` 489 → 228 ns, an unset property 458 →
// 239, `'marginLeft' in el.style` 172 → 26, one pass over 2000 elements' inline styles 28 → 19 ms.
// What pays is going through the prototype for a member: `el.style.length` 41 → 68 ns and
// `getPropertyValue(x)` 226 → 279.
{
  // A declaration is known by the implementation it carries; a receiver without one is not a
  // declaration, and WebIDL answers that with a TypeError rather than a value that reads as unset.
  const impl = (receiver) => {
    const implementation = declarationImplementation(receiver);
    if (!implementation) throw new TypeError('Illegal invocation');
    return implementation;
  };
  const attribute = (get, set) => ({ configurable: true, enumerable: true, get, ...(set ? { set } : {}) });
  const method    = (value)    => ({ configurable: true, enumerable: true, writable: true, value });
  // Written out rather than generated, so each one declares the parameters WebIDL gives it —
  // `setProperty.length` is 2 in a browser (its priority argument is optional), and a generated
  // `(...args)` wrapper would report 0 for all of them.
  Object.defineProperties(CSSStyleDeclaration.prototype, {
    cssText:    attribute(function () { return impl(this).cssText; },
                          function (value) { impl(this).cssText = value; }),
    length:     attribute(function () { return impl(this).length; }),
    parentRule: attribute(function () { return impl(this).parentRule; }),

    item:                method(function item(index) { return impl(this).item(index); }),
    getPropertyValue:    method(function getPropertyValue(property) { return impl(this).getPropertyValue(property); }),
    getPropertyPriority: method(function getPropertyPriority(property) { return impl(this).getPropertyPriority(property); }),
    setProperty:         method(function setProperty(property, value) { return impl(this).setProperty(property, value, arguments[2]); }),
    removeProperty:      method(function removeProperty(property) { return impl(this).removeProperty(property); })
  });

  // One descriptor per PROPERTY, shared by its spellings — they resolve to the same declaration.
  const perProperty = new Map();
  const attributes  = { __proto__: null };
  for (const name of Object.keys(CSS_PROPERTY_BY_IDL_ATTRIBUTE)) {
    const property = CSS_PROPERTY_BY_IDL_ATTRIBUTE[name];
    let descriptor = perProperty.get(property);
    if (!descriptor) perProperty.set(property, descriptor = attribute(
      function () { return impl(this).getPropertyValue(property); },
      // IDL `[LegacyNullToEmptyString]`: `null` clears the declaration rather than writing "null".
      function (value) { impl(this).setProperty(property, value === null ? '' : String(value)); }
    ));
    attributes[name] = descriptor;
  }
  Object.defineProperties(CSSStyleDeclaration.prototype, attributes);
}

// A face's declarations as a read-only CSSStyleDeclaration — given as their text, the style engine's (`declText`) —
// read as its CSSOM rule's `style` would read them, without building the sheet around it (cascade.js `EngineFontFace`).
// Read-only: nothing a script holds reaches it.
globalThis.__csimFontFaceStyle = function (declText) {
  const holder = { _declText: String(declText) };
  return makeDeclProxy({ read: () => holder._declText, write: () => {}, kind: FONT_FACE_BLOCK, cacheOn: holder, owner: null });
};

// The kind of declaration block a rule holds (style-proxy.js `storeKind`): what it may declare — a keyframe's and a
// page's properties, an `@font-face` rule's descriptors — and a style rule's properties for every other.
const FONT_FACE_BLOCK = 3;
const BLOCK_KIND_OF_RULE = { 8: 1, 6: 2, 5: FONT_FACE_BLOCK };   // KEYFRAME_RULE, PAGE_RULE, FONT_FACE_RULE
// A CSSStyleDeclaration whose text is owned by a rule: writes update the rule's
// `_declText` (so `rule.cssText` reflects edits) and re-run the rule's onChange.
function ruleStyle(rule) {
  return makeDeclProxy({
    read:    () => rule._declText || '',
    // A CSSOM edit to a rule's declarations must re-sync the owning sheet's _cssText and
    // refresh the cascade, so getComputedStyle reflects the change (set-selectorText /
    // -style cascade re-application) — the cascade reads the sheet's _cssText, not the
    // rule object.
    write:   (s) => { rule._declText = s; if (rule._parentStyleSheet) rule._parentStyleSheet._syncText(); },
    kind:    BLOCK_KIND_OF_RULE[rule.type] || 0,
    cacheOn: rule,
    owner:   rule
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
  // `_serialize(source)`: CSSOM's text of the rule, or — `source` — the text the owning sheet hands the style engine,
  // its declarations as they were written (`blockDeclText`).
  get cssText()  { return this._serialize(false); }
  set cssText(_) { /* CSSOM: setting cssText on a rule is a no-op */ }
  _serialize(_source) { return ''; }
}
// The legacy integer type constants live on the prototype (so `rule.STYLE_RULE`)
// and the constructor (so `CSSRule.STYLE_RULE`).
for (const [k, v] of Object.entries(RULE_TYPE)) { CSSRule.prototype[k] = v; CSSRule[k] = v; }

class CSSStyleRule extends CSSRule {
  // The selector and the canonical declaration text are derived from the parsed node on FIRST READ, not here: a page
  // that touches `sheet.cssRules` at all — a script walking the sheets, the `@font-face` index — built every rule of
  // every sheet, and serialising and validating each one was ~5% of a Redmine page load (80 KB of CSS, built afresh
  // for each document). Deterministic in the node, so when it is computed changes nothing.
  constructor(node, parentStyleSheet, parentRule) {
    super(RULE_TYPE.STYLE_RULE, parentStyleSheet, parentRule);
    this._node = node;
    this._sel = undefined;
    this._decl = undefined;
  }
  get _selectorText() {
    if (this._sel === undefined) { this._sel = engineSelectorText(this._node.prelude.value, this) ?? ''; this._derived(); }
    return this._sel;
  }
  set _selectorText(v) { this._sel = v; this._derived(); }
  get _declText() {
    if (this._decl === undefined) { this._decl = blockDeclText(this._node.block); this._derived(); }
    return this._decl;
  }
  set _declText(v) { this._decl = v; this._derived(); }
  // …and the parsed node let go once both are derived: nothing else reads it, and it holds the rule's whole AST.
  _derived() { if (this._sel !== undefined && this._decl !== undefined) this._node = null; }
  get selectorText()  { return this._selectorText; }
  set selectorText(v) {
    // A selector the engine does not parse — an empty one included — leaves the rule as it was (CSSOM).
    const text = engineSelectorText(String(v), this);
    if (text === null) return;
    this._selectorText = text;
    // Re-sync the owning sheet + refresh the cascade so the new selector re-matches
    // (getComputedStyle reflects it) — the cascade reads the sheet's serialized text.
    if (this._parentStyleSheet) this._parentStyleSheet._syncText();
  }
  get style() { return this._style || (this._style = ruleStyle(this)); }
  set style(v) { this.style.cssText = v == null ? '' : String(v); }  // [PutForwards=cssText]
  _serialize(source) {
    return this._selectorText + ' ' + wrapBlock(source ? this._declText : canonicalDeclText(this._declText, 0));
  }
}

// A rule that owns a plain declaration block (@font-face / @page / @keyframe frame).
class CSSDeclarationBlockRule extends CSSRule {
  // (…its declaration text on first read too — see `CSSStyleRule`)
  constructor(type, node, parentStyleSheet, parentRule) {
    super(type, parentStyleSheet, parentRule);
    this._node = node;
    this._decl = undefined;
  }
  get _declText() {
    if (this._decl === undefined) { this._decl = blockDeclText(this._node && this._node.block); this._node = null; }
    return this._decl;
  }
  set _declText(v) { this._decl = v; this._node = null; }
  get style() { return this._style || (this._style = ruleStyle(this)); }
  set style(v) { this.style.cssText = v == null ? '' : String(v); }
  _body(source) {
    return wrapBlock(source ? this._declText : canonicalDeclText(this._declText, BLOCK_KIND_OF_RULE[this.type] || 0));
  }
}

class CSSFontFaceRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) { super(RULE_TYPE.FONT_FACE_RULE, node, sheet, parent); }
  _serialize(source) { return '@font-face ' + this._body(source); }
}

class CSSPageRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.PAGE_RULE, node, sheet, parent);
    this._selectorText = normalizePageSelector(node && node.prelude ? CT.generate(node.prelude) : '') || '';
  }
  get selectorText()  { return this._selectorText; }
  set selectorText(v) {
    // A @page selector is `<page-name>? <pseudo-page>*` with no whitespace between the name
    // and the pseudo-pages. An invalid selector is rejected (the rule is left unchanged).
    const norm = normalizePageSelector(String(v));
    if (norm != null) this._selectorText = norm;
  }
  _serialize(source) {
    const sel = this._selectorText ? this._selectorText + ' ' : '';
    return '@page ' + sel + this._body(source);
  }
}

// Validate + serialize a @page selector: an optional page name and ANY NUMBER of
// `:first | :left | :right | :blank` pseudo-pages (case-insensitive → lowercased), with no
// whitespace between them. Returns the canonical string, or null if invalid.
const PAGE_PSEUDOS = new Set(['first', 'left', 'right', 'blank']);
function normalizePageSelector(raw) {
  const s = raw.trim();
  if (s === '') return '';
  // `<page-name>? <pseudo-page>*` — a page name (optional) followed by any number of
  // `:first` / `:left` / `:right` / `:blank` pseudo-pages (repeats and order are preserved
  // verbatim, lowercased — CSSOM doesn't dedupe or sort them).
  const m = /^([A-Za-z_-][\w-]*)?((?::[A-Za-z]+)*)$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const pseudos = m[2] ? m[2].slice(1).split(':') : [];
  for (const p of pseudos) if (!PAGE_PSEUDOS.has(p.toLowerCase())) return null;
  return (m[1] || '') + pseudos.map(p => ':' + p.toLowerCase()).join('');
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
  _nestedText(source) { return this._rules.map(r => r._serialize(source)).join(' '); }
}

class CSSConditionRule extends CSSGroupingRule {
  get conditionText() { return this._conditionText || ''; }
}

class CSSMediaRule extends CSSConditionRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.MEDIA_RULE, node, sheet, parent);
    this._media = new MediaList(node && node.prelude ? CT.generate(node.prelude) : '');
  }
  get media()         { return this._media; }
  set media(v)        { this._media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  get conditionText() { return this._media.mediaText; }   // live — always the current media text
  _serialize(source) { return wrapGroupingRule('@media ' + this._media.mediaText, this._rules.map(r => r._serialize(source))); }
}

class CSSSupportsRule extends CSSConditionRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.SUPPORTS_RULE, node, sheet, parent);
    this._conditionText = node && node.prelude ? CT.generate(node.prelude) : '';
  }
  _serialize(source) {
    const inner = this._nestedText(source);
    return '@supports ' + this._conditionText + ' {' + (inner ? ' ' + inner + ' ' : ' ') + '}';
  }
}

class CSSImportRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.IMPORT_RULE, sheet, parent);
    // The prelude is `<url> [supports(<cond>)] [<media>]`. Take the URL from the AST node
    // (a Url or String) rather than a regex over the generated text — the generated form
    // re-escapes embedded quotes (`url('a"b')`), which a regex then mis-splits. The rest
    // (supports + media) is the generated text of the remaining children.
    let href = '';
    const restParts = [];
    const children = node && node.prelude && node.prelude.children;
    if (children) {
      children.forEach(c => {
        if (c.type === 'Url') href = c.value;
        else if (c.type === 'String') href = String(c.value).replace(/^(["'])([\s\S]*)\1$/, '$2');
        else restParts.push(CT.generate(c));
      });
    }
    this._href = href;
    let rest = restParts.join(' ').trim();
    // `supports(<condition>)`: the condition can nest parentheses (`supports((a) or (b))`),
    // so scan for the BALANCED closing paren rather than the first one.
    this._supportsText = null;
    const supM = /^supports\s*\(/i.exec(rest);
    if (supM) {
      let depth = 0, end = -1;
      for (let i = supM[0].length - 1; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) { end = i; break; }
      }
      if (end >= 0) {
        // css-tree compacts `display: flex` to `display:flex`; the CSSOM serialization keeps the
        // DECLARATION `: ` spacing. Only re-space a colon that follows an ident inside a GROUPING
        // paren (`(display:flex)`), not a `selector(a:hover)` pseudo-class or a `url(scheme:…)`.
        this._supportsText = rest.slice(supM[0].length, end).trim()
          .replace(/(^|[^\w-])\(\s*([-\w]+)\s*:\s*/g, '$1($2: ');
        rest = rest.slice(end + 1).trim();
      }
    }
    this._media = new MediaList(rest);
    this._styleSheet = null;   // lazily fetched + parsed on first `.styleSheet` access
  }
  get href()         { return this._href; }
  get media()        { return this._media; }
  set media(v)       { this._media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  get supportsText() { return this._supportsText; }
  // The imported CSSStyleSheet — fetched + parsed lazily on first access (a NON-constructed
  // sheet linked to this rule and the importing sheet). Each CSSImportRule owns a SEPARATE
  // sheet, even two `@import`s of the same URL (cssimportrule-sheet-identity).
  get styleSheet() {
    if (this._styleSheet === null && this._href) this._styleSheet = this._loadImportedSheet();
    return this._styleSheet;
  }
  _loadImportedSheet() {
    const parent = this.parentStyleSheet;
    // Resolve the @import URL against the importing sheet's base (its href), else the document.
    const base = (parent && parent.href) || (globalThis.location && globalThis.location.href) || undefined;
    let url = this._href;
    try { url = new globalThis.URL(this._href, base).href; } catch (_) { /* keep the raw href */ }
    // An asset our harness can't reach (unvendored) still yields a distinct (empty) sheet —
    // NOT null: two `@import`s of the same URL must be different objects even when the fetch
    // yields nothing (cssimportrule-sheet-identity), and no test needs the failed→null case.
    const css = fetchStyleSheetText(url);
    const ss = buildOwnedStyleSheet(css == null ? '' : css, { baseURL: url, media: this._media.mediaText });
    ss._ownerRule        = this;
    ss._parentStyleSheet = parent || null;
    return ss;
  }
  _serialize() {
    const sup = this._supportsText != null ? ' supports(' + this._supportsText + ')' : '';
    const mt = this._media.mediaText;
    // The URL is serialized as a CSS string — escape `\` and `"` (`url("quote\"quote")`).
    const url = String(this._href).replace(/[\\"]/g, m => '\\' + m);
    return '@import url("' + url + '")' + sup + (mt ? ' ' + mt : '') + ';';
  }
}

class CSSNamespaceRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.NAMESPACE_RULE, sheet, parent);
    // `[<prefix>] <url-or-string>`, as the style engine reads it (an escaped prefix unescaped).
    const [prefix, url] = (node && node.prelude && globalThis.__dom.namespacePrelude(CT.generate(node.prelude))) || ['', ''];
    this._prefix = prefix;
    this._namespaceURI = url;
  }
  get prefix()       { return this._prefix; }
  get namespaceURI() { return this._namespaceURI; }
  _serialize() {
    return '@namespace ' + (this._prefix ? globalThis.CSS.escape(this._prefix) + ' ' : '') + 'url("' + this._namespaceURI + '");';
  }
}

class CSSKeyframeRule extends CSSDeclarationBlockRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.KEYFRAME_RULE, node, sheet, parent);
    this._keyText = node && node.prelude ? CT.generate(node.prelude) : '';
  }
  get keyText()  { return this._keyText; }
  set keyText(v) { this._keyText = String(v); }
  _serialize(source) { return this._keyText + ' ' + this._body(source); }
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
    try { node = CT.parse(String(text), PARSE_RULE); } catch (_) { return; }
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
  _serialize(source) {
    return wrapNested('@keyframes ' + serializeKeyframesName(this._name), this._rules.map(r => r._serialize(source)).join(' '));
  }
}

// A `<keyframes-name>` is `<custom-ident> | <string>`. A CSS-wide keyword, `none`, or `default`
// is NOT a valid custom-ident, so such a name serializes as a quoted string (`@keyframes
// "initial"`); any other name stays an unquoted ident (`@keyframes foo`).
const KEYFRAMES_RESERVED_NAMES = new Set(['none', 'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default']);
function serializeKeyframesName(name) {
  const s = String(name);
  // A reserved word can't be a custom-ident → serialize as a string; any other name is an
  // identifier, escaped as needed (`my anim` → `my\ anim`, `1abc` → `\31 abc`).
  if (KEYFRAMES_RESERVED_NAMES.has(s.toLowerCase())) return '"' + s.replace(/[\\"]/g, m => '\\' + m) + '"';
  return (globalThis.CSS && globalThis.CSS.escape) ? globalThis.CSS.escape(s) : s;
}

// A keyframe selector normalized for appendRule/deleteRule/findRule matching:
// comma-separated keys, `from`/`to` → `0%`/`100%`, whitespace-insensitive.
function normalizeKeyframeSelector(select) {
  return String(select == null ? '' : select).split(',')
    .map(s => { const t = s.trim().toLowerCase(); return t === 'from' ? '0%' : t === 'to' ? '100%' : t; })
    .join(',');
}

// css-fonts-4 CSSFontFeatureValuesMap: a maplike of `<feature-value-name>` →
// sequence of non-negative integers (`styleset: di 10 9 4 5` → `di` → [10, 9, 4, 5]).
// `set` coerces a lone number to a one-element sequence; a sequence is stored as-is.
class CSSFontFeatureValuesMap {
  constructor(entries) {
    this._map = new Map();
    if (entries) for (const [k, v] of entries) this._map.set(k, v);
  }
  get size()     { return this._map.size; }
  has(name)      { return this._map.has(String(name)); }
  get(name)      { return this._map.get(String(name)); }
  set(name, values) {
    // WebIDL `(unrestricted double or sequence<unrestricted double>)`: a bare number
    // becomes a single-element sequence; an array is copied element-wise through Number().
    const seq = Array.isArray(values) ? values.map(Number) : [Number(values)];
    this._map.set(String(name), seq);
  }
  delete(name)   { return this._map.delete(String(name)); }
  clear()        { this._map.clear(); }
  forEach(cb, thisArg) { this._map.forEach((v, k) => cb.call(thisArg, v, k, this)); }
  keys()         { return this._map.keys(); }
  values()       { return this._map.values(); }
  entries()      { return this._map.entries(); }
  [Symbol.iterator]() { return this._map.entries(); }
}

// css-fonts-4 CSSFontFeatureValuesRule: `@font-feature-values <family> { @styleset {…}
// @annotation {…} … }`. Each nested at-rule populates a same-named maplike; the six the
// spec exposes are annotation / ornaments / stylistic / swash / styleset / characterVariant.
class CSSFontFeatureValuesRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.FONT_FEATURE_VALUES_RULE, sheet, parent);
    // The prelude is a `<family-name>#` list, serialized verbatim (quotes kept, per
    // Chrome) — `@font-feature-values "My Font", Arial` → `"My Font", Arial`.
    this._fontFamily = node && node.prelude ? CT.generate(node.prelude) : '';
    // One map per feature at-rule, stored under its IDL attribute name; the
    // `@character-variant` at-rule maps to `characterVariant` (the only name that
    // isn't a verbatim lowercase of the at-rule).
    for (const key of Object.values(FONT_FEATURE_MAP_ATRULES)) this['_' + key] = new CSSFontFeatureValuesMap();
    if (node && node.block && node.block.children) {
      node.block.children.forEach(inner => {
        if (inner.type !== 'Atrule' || !inner.block || !inner.block.children) return;
        const key = FONT_FEATURE_MAP_ATRULES[(inner.name || '').toLowerCase()];
        if (!key) return;
        const map = this['_' + key];
        inner.block.children.forEach(decl => {
          if (decl.type !== 'Declaration') return;
          const nums = CT.generate(decl.value).trim().split(/\s+/).map(Number).filter(n => !Number.isNaN(n));
          map.set(decl.property, nums);
        });
      });
    }
  }
  get fontFamily()  { return this._fontFamily; }
  set fontFamily(v) { this._fontFamily = String(v); }
  get annotation()      { return this._annotation; }
  get ornaments()       { return this._ornaments; }
  get stylistic()       { return this._stylistic; }
  get swash()           { return this._swash; }
  get styleset()        { return this._styleset; }
  get characterVariant() { return this._characterVariant; }
  _serialize() {
    // Feature blocks are emitted in a fixed IDL-attribute order (not source order). The
    // spec pins no canonical order and no test reads this cssText; matching Chrome's exact
    // internal ordering isn't worth tracking per-rule source order.
    const blocks = [];
    for (const [atName, key] of Object.entries(FONT_FEATURE_MAP_ATRULES)) {
      const map = this['_' + key];
      if (!map.size) continue;
      const decls = [];
      map.forEach((seq, name) => decls.push(name + ': ' + seq.join(' ')));
      blocks.push('@' + atName + ' { ' + decls.join('; ') + ' }');
    }
    return wrapNested('@font-feature-values ' + this._fontFamily, blocks.join(' '));
  }
}
// `@<at-rule>` name → the CSSFontFeatureValuesRule IDL attribute it populates.
const FONT_FEATURE_MAP_ATRULES = {
  'annotation':        'annotation',
  'ornaments':         'ornaments',
  'stylistic':         'stylistic',
  'swash':             'swash',
  'styleset':          'styleset',
  'character-variant': 'characterVariant'
};

// An `@counter-style` rule: its descriptors are what the style engine reads of it (cssom_rule.rs) — each attribute one
// descriptor's value, `cssText` the engine's serialization — and its body stays as written for the sheet the engine
// cascades from until CSSOM writes it. A write the engine refuses — a value that does not parse, a name no counter style
// can have, another kind of system, symbols for an `extends` one — changes nothing (css-counter-styles-3 §The
// CSSCounterStyleRule interface).
const COUNTER_STYLE_ATTRIBUTES = ['system', 'symbols', 'additiveSymbols', 'negative', 'prefix', 'suffix', 'range', 'pad', 'speakAs', 'fallback'];
class CSSCounterStyleRule extends CSSRule {
  constructor(node, sheet, parent) {
    super(RULE_TYPE.COUNTER_STYLE_RULE, sheet, parent);
    this._name = node && node.prelude ? CT.generate(node.prelude) : '';
    this._declText = blockDeclText(node && node.block);
    this._parsed = undefined;
  }
  // `[cssText, body, …each descriptor's value]`, or null where the engine drops the rule.
  get _engine() {
    if (this._parsed === undefined) this._parsed = globalThis.__dom.counterStyleRule(this._name, this._declText);
    return this._parsed;
  }
  get name()  { return this._name; }
  set name(v) {
    const name = String(v), parsed = globalThis.__dom.counterStyleRule(name, this._declText);
    if (parsed) this._commit(name, parsed);
  }
  _commit(name, parsed) {
    this._name = name;
    this._declText = parsed[1];
    this._parsed = parsed;
    if (this._parentStyleSheet) this._parentStyleSheet._syncText();
  }
  _serialize(source) {
    if (!source && this._engine) return this._engine[0];
    return '@counter-style ' + this._name + ' ' + wrapBlock(source ? this._declText : '');
  }
}
COUNTER_STYLE_ATTRIBUTES.forEach((attribute, i) => {
  const descriptor = attribute.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  Object.defineProperty(CSSCounterStyleRule.prototype, attribute, {
    get() { return this._engine ? this._engine[i + 2] : ''; },
    set(v) {
      const parsed = globalThis.__dom.counterStyleRule(this._name, this._declText, descriptor, String(v));
      if (parsed) this._commit(this._name, parsed);
    },
    enumerable: true, configurable: true
  });
});

// Map a css-tree AST node to the right CSSRule subclass. Returns null for nodes
// that don't surface as rules (@charset, Raw/unparsed fragments).
function buildRule(node, sheet, parent) {
  if (!node) return null;
  if (node.type === 'Rule') {
    // A selector the engine does not parse makes no rule — in the sheet's rule list as in the cascade (Chrome keeps no
    // `::-moz-selection { }`, and `insertRule` refuses one).
    const rule = new CSSStyleRule(node, sheet, parent);
    return rule._selectorText ? rule : null;
  }
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
      case 'font-feature-values':  return new CSSFontFeatureValuesRule(node, sheet, parent);
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
// CSSOM "serialize a media query": lowercase the type + `not`/`only`/`and` keywords and
// each feature NAME, canonicalize `(feature: value)` spacing, and drop a redundant leading
// `all and` (a bare `all` type before features) — but keep a lone `all`, `not all`, and
// `not all and (…)`. Feature order / over-specified features / negation are preserved (no
// sorting or de-duplication).
function serializeMediaQuery(q) {
  q = q.trim();
  if (!q) return q;
  // Feature blocks: lowercase the name, normalize `: ` spacing (value case is preserved).
  q = q.replace(/\(\s*([\w-]+)\s*(:\s*)?/g, (_m, name, colon) => '(' + name.toLowerCase() + (colon ? ': ' : ''));
  // Lowercase keyword tokens OUTSIDE parens (media type + not/only/and) without touching
  // feature values inside `( … )`.
  q = q.replace(/[^()]+/g, seg => seg.replace(/[A-Za-z-]+/g, w => w.toLowerCase()));
  return q.replace(/^all\s+and\s+/, '').trim();
}

function parseMediaText(text) {
  return splitTopLevel(String(text || ''), ',')
    .map(serializeMediaQuery)
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
    const ast = CT.parse(String(text), PARSE_SHEET);
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
    // ownerNode / ownerRule / parentStyleSheet / href are readonly StyleSheet attributes
    // (getters on the prototype, per the IDL): the owner `<style>`/`<link>` element, the
    // `@import` rule that loaded this sheet, the sheet it was imported into, and its URL.
    this._ownerNode = null;
    this._ownerRule = null;
    this._parentStyleSheet = null;
    this._disabled  = !!options.disabled;
    // A `baseURL`, when given, is parsed against the document base URL (CSSOM "create a constructed
    // CSSStyleSheet"); a URL that fails to parse (e.g. `https://test:test/` — a non-numeric port) is a
    // NotAllowedError. Absent → the sheet has no location (`href` is null).
    if (options.baseURL == null) {
      this._href = null;
    } else {
      const base = (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href);
      try { this._href = new globalThis.URL(String(options.baseURL), base).href; }
      catch (_) { throw new globalThis.DOMException("Failed to construct 'CSSStyleSheet': Constructing a constructed stylesheet with an invalid base URL is not allowed.", 'NotAllowedError'); }
    }
    this._media     = new MediaList(typeof options.media === 'string' ? options.media : '');
    // The public `new CSSStyleSheet()` is "constructed": it disallows @import and is
    // the only kind `replace`/`replaceSync` accept. Only the internal owned-sheet
    // builder passes `owned: true` to opt out.
    this._constructed = !options.owned;
    // The document whose realm ran `new CSSStyleSheet()` — its "constructor document".
    // A constructed sheet may only be adopted into that same document / its shadow trees
    // (construct-stylesheets "cannot be used in iframes"). An owned `<style>`/`<link>` sheet
    // has no constructor document restriction.
    this._constructorDoc = this._constructed ? globalThis.document : null;
    // Raw text kept so the shadow-tree cascade can re-parse an adopted sheet.
    this._cssText   = '';
  }
  get type()     { return 'text/css'; }
  get ownerNode()        { return this._ownerNode; }
  get ownerRule()        { return this._ownerRule; }
  get parentStyleSheet() { return this._parentStyleSheet; }
  get href()             { return this._href; }
  get media()    { return this._media; }
  set media(v)   { this._media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  // `disabled` toggles whether the sheet contributes to the cascade — an adopted sheet
  // flipped disabled must re-resolve getComputedStyle, so signal the cascade on change.
  get disabled() { return this._disabled; }
  set disabled(v) { const b = !!v; if (b !== this._disabled) { this._disabled = b; this._notifyCascade(); } }
  // `title` reflects the owner element's current `title` attribute LIVE (a later
  // `setAttribute('title', …)` updates it); empty or absent → null. A constructed or
  // `@import` sheet has no owner node and no title (the `new CSSStyleSheet()` constructor
  // deliberately ignores title/alternate, per WICG/construct-stylesheets#105). A
  // `<?xml-stylesheet?>` owner is a ProcessingInstruction with no `_attrs` — its title
  // isn't modelled, so it reads null (guarded rather than throwing).
  get title()    { const on = this._ownerNode; return on && on._attrs ? (on._attrs.title || null) : null; }
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
  _syncText() { this._cssText = this._rules.map(r => r._serialize(true)).join(' '); this._notifyCascade(); }
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
    try { ast = CT.parse(cssText, PARSE_SHEET); }
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
globalThis.CSSFontFeatureValuesRule = CSSFontFeatureValuesRule;
globalThis.CSSFontFeatureValuesMap  = CSSFontFeatureValuesMap;
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
  CSSFontFeatureValuesRule, CSSFontFeatureValuesMap,
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

