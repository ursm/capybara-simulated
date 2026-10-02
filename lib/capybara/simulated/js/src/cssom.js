// CSSOM object model — `CSSStyleSheet` / the `CSSRule` hierarchy / `CSSRuleList` /
// `MediaList` / `StyleSheetList` / `CSSStyleDeclaration`.
//
// Every sheet is one of the style engine's (sheets.rs): a `<style>` / `<link>`'s, a constructed one, an `@import`ed
// one, each named by its id. Its rules are the engine's own rules, each CSSRule object naming one by a HANDLE
// (cssom_rule.rs): what a rule says — its text, selector, media, key, descriptors, declarations — is read off the rule
// the engine cascades, and every CSSOM mutation is made to that rule in place, through the engine's parsers and checks,
// and the engine told. The objects here keep only what identity needs: each list of rules, filled once from its
// handles and kept in step with the mutations made through it (CSSOM's [SameObject] rule lists).

import { splitTopLevel, CSS_PROPERTY_BY_IDL_ATTRIBUTE, documentBaseUrl } from './css-utils.js';
import { makeDeclProxy, declarationImplementation } from './style-proxy.js';
import { DOMException } from './events.js';

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
const BLOCK_KIND = { keyframe: 1, page: 2, margin: 2, 'font-face': FONT_FACE_BLOCK };

// ── the engine's rules, by handle ──────────────────────────────────────────

// A rule object's handle is let go of with the object (`ruleDrop`); a handle names nothing outside its realm, and
// nothing once the realm moved to another page.
const RULE_DROPS = new FinalizationRegistry((handle) => { if (globalThis.__dom) globalThis.__dom.ruleDrop(handle); });
// A CSSOM mutation reaches the engine as it is made (the rule IS the engine's), and the page side hears of it: the
// memos keyed on the rule set move (cascade.js `notifyCssomMutation`).
const rulesMoved = () => { if (globalThis.__csimScheduleCascadeRefresh) globalThis.__csimScheduleCascadeRefresh(); };
// Only the realm's own code makes a rule or a list: `new CSSStyleRule()` is an illegal constructor, as WebIDL has it.
const INTERNAL = Symbol('internal');
const mode = () => { const doc = globalThis.document; return !!(doc && doc._quirks); };

// The `CSSStyleDeclaration` of a rule's block (`rule.style`): every read and write is of the rule's own block (the
// decl ops' `rule` argument), its text — the block's serialization, kept until a write through it — only a key for
// what the reads memoize.
function ruleStyle(rule, kind) {
  return makeDeclProxy({
    read:    () => rule._blockText ??= globalThis.__dom.declText('', kind, mode(), documentBaseUrl(), -1, rule._handle),
    write:   (text) => { rule._blockText = text; rulesMoved(); },
    kind,
    rule:    () => rule._handle,
    cacheOn: rule,
    owner:   rule
  });
}

const RULE_TYPE = {
  STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4, FONT_FACE_RULE: 5,
  PAGE_RULE: 6, KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, MARGIN_RULE: 9, NAMESPACE_RULE: 10,
  COUNTER_STYLE_RULE: 11, SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14
};

class CSSRule {
  constructor(token, handle, parentStyleSheet, parentRule) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this._handle = handle;
    this._parentStyleSheet = parentStyleSheet || null;
    this._parentRule = parentRule || null;
  }
  get type()             { return 0; }
  get parentRule()       { return this._parentRule; }
  get parentStyleSheet() { return this._parentStyleSheet; }
  get cssText()  { return globalThis.__dom.ruleText(this._handle) || ''; }
  set cssText(_) { /* CSSOM: setting cssText on a rule is a no-op */ }
  // One of the rule's attributes as the engine reads it (`ruleGet`), and a write of one (`ruleSet`): whether it took.
  _get(what)        { return globalThis.__dom.ruleGet(this._handle, what); }
  _set(what, value) {
    const took = globalThis.__dom.ruleSet(this._handle, what, String(value));
    if (took) rulesMoved();
    return took;
  }
}
// The legacy integer type constants live on the prototype (so `rule.STYLE_RULE`)
// and the constructor (so `CSSRule.STYLE_RULE`).
for (const [k, v] of Object.entries(RULE_TYPE)) { CSSRule.prototype[k] = v; CSSRule[k] = v; }

// A list of rules — a sheet's, a grouping rule's, a `@keyframes`'s — filled from the handles the engine gives out, each
// made the object of its interface.
class CSSRuleList extends Array {
  item(i) { return this[i >>> 0] || null; }
}
function fillRules(list, entries, sheet, parent) {
  list.length = 0;
  if (entries) for (let i = 0; i < entries.length; i += 2) list.push(makeRule(entries[i], entries[i + 1], sheet, parent));
  return list;
}
function makeRule(handle, kind, sheet, parent) {
  const Rule = RULE_CLASSES[kind] || CSSRule;
  const rule = new Rule(INTERNAL, handle, sheet, parent);
  RULE_DROPS.register(rule, handle);
  return rule;
}

// CSSOM "insert a CSS rule" into `list` (the sheet `sheet`'s own, or the rule `parent`'s): the engine parses and checks
// it, and refuses it with the DOMException CSSOM names.
function insertRuleInto(list, sheet, parent, text, index) {
  const i = index === undefined ? 0 : index >>> 0;
  const answer = globalThis.__dom.ruleInsert(sheet._id, parent ? parent._handle : -1, String(text), i);
  if (typeof answer === 'string') throw new DOMException(`Failed to insert the rule: ${answer}`, answer);
  list.splice(i, 0, makeRule(answer[0], answer[1], sheet, parent));
  if (answer.length > 2 && globalThis.__csimResolveSheetImports) globalThis.__csimResolveSheetImports(answer.slice(2), mode());
  rulesMoved();
  return i;
}
// CSSOM "remove a CSS rule": the removed rule is detached (`parentRule` / `parentStyleSheet` null).
function deleteRuleFrom(list, sheet, parent, index) {
  const i = index >>> 0;
  const refused = globalThis.__dom.ruleDelete(sheet._id, parent ? parent._handle : -1, i);
  if (refused) throw new DOMException(`Failed to delete the rule: ${refused}`, refused);
  const [removed] = list.splice(i, 1);
  if (removed) { removed._parentStyleSheet = null; removed._parentRule = null; }
  rulesMoved();
}

// CSSGroupingRule — a rule that holds rules (`@media`, `@supports`, `@layer`, `@container`, a style rule's nested
// ones): its list filled on first read, and kept by the mutations made through it.
class CSSGroupingRule extends CSSRule {
  get cssRules() {
    return this._rules ??= fillRules(new CSSRuleList(), globalThis.__dom.ruleRules(this._handle), this._parentStyleSheet, this);
  }
  insertRule(text, index) {
    if (arguments.length < 1) throw new TypeError('insertRule requires a rule');
    return insertRuleInto(this.cssRules, this._parentStyleSheet, this, text, index);
  }
  deleteRule(index) {
    if (arguments.length < 1) throw new TypeError('deleteRule requires an index');
    deleteRuleFrom(this.cssRules, this._parentStyleSheet, this, index);
  }
}

class CSSConditionRule extends CSSGroupingRule {
  get conditionText() { return this._get('condition') || ''; }
}

class CSSStyleRule extends CSSGroupingRule {
  get type() { return RULE_TYPE.STYLE_RULE; }
  get selectorText()  { return this._get('selector') || ''; }
  // A selector the engine does not parse — an empty one included — leaves the rule as it was (CSSOM).
  set selectorText(v) { this._set('selector', v); }
  get style() { return this._style ??= ruleStyle(this, 0); }
  set style(v) { this.style.cssText = v == null ? '' : String(v); }  // [PutForwards=cssText]
}

class CSSMediaRule extends CSSConditionRule {
  get type()   { return RULE_TYPE.MEDIA_RULE; }
  get media()  { return this._media ??= ruleMediaList(this); }
  set media(v) { this.media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
}
class CSSSupportsRule extends CSSConditionRule {
  get type() { return RULE_TYPE.SUPPORTS_RULE; }
}
class CSSContainerRule extends CSSConditionRule {}
class CSSLayerBlockRule extends CSSGroupingRule {
  get name() { return this._get('name') || ''; }
}
class CSSLayerStatementRule extends CSSRule {
  get nameList() { return this._names ??= Object.freeze((this._get('names') || '').split(',').filter(Boolean)); }
}
class CSSScopeRule extends CSSGroupingRule {
  get start() { return this._get('start') || null; }
  get end()   { return this._get('end') || null; }
}
class CSSStartingStyleRule extends CSSGroupingRule {}

// A rule that owns a declaration block (`@font-face`, `@page`, a keyframe, a margin rule, nested declarations,
// `@position-try`): `style` is its block.
class CSSDeclarationBlockRule extends CSSRule {
  get style() { return this._style ??= ruleStyle(this, this._blockKind); }
  set style(v) { this.style.cssText = v == null ? '' : String(v); }
  get _blockKind() { return 0; }
}
class CSSFontFaceRule extends CSSDeclarationBlockRule {
  get type() { return RULE_TYPE.FONT_FACE_RULE; }
  get _blockKind() { return FONT_FACE_BLOCK; }
}
class CSSPageRule extends CSSDeclarationBlockRule {
  get type() { return RULE_TYPE.PAGE_RULE; }
  get _blockKind() { return BLOCK_KIND.page; }
  get selectorText()  { return this._get('selector') || ''; }
  set selectorText(v) { this._set('selector', v); }
}
class CSSMarginRule extends CSSDeclarationBlockRule {
  get type() { return RULE_TYPE.MARGIN_RULE; }
  get _blockKind() { return BLOCK_KIND.margin; }
}
class CSSNestedDeclarations extends CSSDeclarationBlockRule {}
class CSSPositionTryRule extends CSSDeclarationBlockRule {
  get name() { return this._get('name') || ''; }
}
class CSSKeyframeRule extends CSSDeclarationBlockRule {
  get type() { return RULE_TYPE.KEYFRAME_RULE; }
  get _blockKind() { return BLOCK_KIND.keyframe; }
  get keyText()  { return this._get('key') || ''; }
  // A key the engine does not parse is a SyntaxError (css-animations-1 §CSSKeyframeRule).
  set keyText(v) {
    if (!this._set('key', v)) throw new DOMException(`'${v}' is not a valid keyframe selector`, 'SyntaxError');
  }
}

class CSSKeyframesRule extends CSSRule {
  constructor(token, handle, sheet, parent) {
    super(token, handle, sheet, parent);
    // Indexed getter: `keyframesRule[0]` → the 0-th CSSKeyframeRule (undefined out of range).
    return new Proxy(this, {
      get(t, k) {
        if (typeof k === 'string' && /^\d+$/.test(k)) return t.cssRules[+k];
        return t[k];
      }
    });
  }
  get type()     { return RULE_TYPE.KEYFRAMES_RULE; }
  get name()     { return this._get('name') || ''; }
  set name(v)    { this._set('name', v); }
  get cssRules() {
    return this._rules ??= fillRules(new CSSRuleList(), globalThis.__dom.ruleRules(this._handle), this._parentStyleSheet, this);
  }
  get length()   { return this.cssRules.length; }
  // appendRule / deleteRule / findRule are keyed by a keyframe SELECTOR (`0%`, `from`, `50%, 60%`), compared as the
  // engine parses it; the LAST keyframe of that selector is the one found.
  appendRule(text) {
    const handle = globalThis.__dom.keyframeAppend(this._handle, String(text));
    if (handle == null) return;
    this.cssRules.push(makeRule(handle, 'keyframe', this._parentStyleSheet, this));
    rulesMoved();
  }
  deleteRule(select) {
    const i = globalThis.__dom.keyframeFind(this._handle, String(select));
    if (i < 0) return;
    globalThis.__dom.keyframeDelete(this._handle, i);
    const [removed] = this.cssRules.splice(i, 1);
    if (removed) { removed._parentStyleSheet = null; removed._parentRule = null; }
    rulesMoved();
  }
  findRule(select) {
    const i = globalThis.__dom.keyframeFind(this._handle, String(select));
    return i < 0 ? null : this.cssRules[i];
  }
}

class CSSImportRule extends CSSRule {
  get type()         { return RULE_TYPE.IMPORT_RULE; }
  get href()         { return this._get('href') || ''; }
  // (…its media the imported sheet's, written there)
  get media()        { return this._media ??= ruleMediaList(this); }
  set media(v)       { this.media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  get supportsText() { return this._get('supports'); }
  get layerName()    { return this._get('layer'); }
  // The imported sheet, once it arrived — a sheet of its own for each `@import`, even two of one URL
  // (cssimportrule-sheet-identity) — and null while it has none.
  get styleSheet() {
    if (this._styleSheet === undefined) {
      const id = globalThis.__dom.importSheet(this._handle);
      this._styleSheet = id == null ? null : sheetOf(id, { ownerRule: this, parentStyleSheet: this._parentStyleSheet, href: this._get('url') });
    }
    return this._styleSheet;
  }
}

class CSSNamespaceRule extends CSSRule {
  get type()         { return RULE_TYPE.NAMESPACE_RULE; }
  get prefix()       { return this._get('prefix') || ''; }
  get namespaceURI() { return this._get('namespace') || ''; }
}

// An `@counter-style` rule: each descriptor an attribute, written through the engine's own CSSOM checks — a value that
// does not parse, a name no counter style can have, another kind of system, symbols for an `extends` one, change
// nothing (css-counter-styles-3 §The CSSCounterStyleRule interface).
const COUNTER_STYLE_ATTRIBUTES = ['system', 'symbols', 'additiveSymbols', 'negative', 'prefix', 'suffix', 'range', 'pad', 'speakAs', 'fallback'];
class CSSCounterStyleRule extends CSSRule {
  get type()  { return RULE_TYPE.COUNTER_STYLE_RULE; }
  get name()  { return this._get('name') || ''; }
  set name(v) { this._set('name', v); }
}
for (const attribute of COUNTER_STYLE_ATTRIBUTES) {
  const descriptor = attribute.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  Object.defineProperty(CSSCounterStyleRule.prototype, attribute, {
    get() { return this._get(descriptor) || ''; },
    set(v) { this._set(descriptor, v); },
    enumerable: true, configurable: true
  });
}

class CSSPropertyRule extends CSSRule {
  get name()         { return this._get('name') || ''; }
  get syntax()       { return this._get('syntax') || ''; }
  get inherits()     { return this._get('inherits') === 'true'; }
  get initialValue() { return this._get('initial') || null; }
}

class CSSFontPaletteValuesRule extends CSSRule {
  get name()       { return this._get('name') || ''; }
  get fontFamily() { return this._get('family') || ''; }
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

// css-fonts-4 CSSFontFeatureValuesRule: `@font-feature-values <family> { @styleset {…} … }`. Each nested block fills a
// same-named maplike, from the declarations the engine read (`values`, a line per declaration). (A write to a map, or to
// `fontFamily`, is this object's alone: the engine holds the rule immutably, and nothing renders by it here.)
const FONT_FEATURE_MAP_ATRULES = {
  'annotation':        'annotation',
  'ornaments':         'ornaments',
  'stylistic':         'stylistic',
  'swash':             'swash',
  'styleset':          'styleset',
  'character-variant': 'characterVariant'
};
class CSSFontFeatureValuesRule extends CSSRule {
  get type()        { return RULE_TYPE.FONT_FEATURE_VALUES_RULE; }
  get fontFamily()  { return this._fontFamily ?? (this._get('family') || ''); }
  set fontFamily(v) { this._fontFamily = String(v); }
  _maps() {
    if (this._featureMaps) return this._featureMaps;
    const maps = {};
    for (const key of Object.values(FONT_FEATURE_MAP_ATRULES)) maps[key] = new CSSFontFeatureValuesMap();
    for (const line of (this._get('values') || '').split('\n')) {
      const [block, name, values] = line.split('\t');
      const key = FONT_FEATURE_MAP_ATRULES[block];
      if (key) maps[key].set(name, values.trim().split(/\s+/).map(Number));
    }
    return (this._featureMaps = maps);
  }
}
for (const key of Object.values(FONT_FEATURE_MAP_ATRULES)) {
  Object.defineProperty(CSSFontFeatureValuesRule.prototype, key, {
    get() { return this._maps()[key]; }, enumerable: true, configurable: true
  });
}

// Each interface by the name the engine gives a rule's (cssom_rule.rs `kind`); one it has none for is a CSSRule.
const RULE_CLASSES = {
  'style': CSSStyleRule, 'media': CSSMediaRule, 'supports': CSSSupportsRule, 'container': CSSContainerRule,
  'layer-block': CSSLayerBlockRule, 'layer-statement': CSSLayerStatementRule, 'scope': CSSScopeRule,
  'starting-style': CSSStartingStyleRule, 'import': CSSImportRule, 'namespace': CSSNamespaceRule,
  'font-face': CSSFontFaceRule, 'page': CSSPageRule, 'margin': CSSMarginRule, 'keyframes': CSSKeyframesRule,
  'keyframe': CSSKeyframeRule, 'counter-style': CSSCounterStyleRule, 'font-feature-values': CSSFontFeatureValuesRule,
  'font-palette-values': CSSFontPaletteValuesRule, 'property': CSSPropertyRule,
  'nested-declarations': CSSNestedDeclarations, 'position-try': CSSPositionTryRule
};

// ── MediaList / StyleSheetList ──────────────────────────────────────────────

// A media list over where its text lives — a sheet's, an `@media` rule's — read and written as the engine parses and
// serializes media queries.
class MediaList {
  constructor(read, write) {
    this._read = read;
    this._write = write;
    // A Proxy adds the CSSOM indexed getter (`mediaList[0]` → the 0-th medium)
    // without a per-index own property; every other access falls through to the
    // instance (methods, iteration) and `instanceof MediaList` still holds.
    return new Proxy(this, {
      get(t, k) {
        // Indexed getter returns the medium string, or `undefined` (not null) when
        // out of range — matching a WebIDL indexed property getter.
        if (typeof k === 'string' && /^\d+$/.test(k)) return t._items[+k];
        return t[k];
      }
    });
  }
  get _items()     { return splitTopLevel(this.mediaText, ',').map((m) => m.trim()).filter(Boolean); }
  get mediaText()  { return this._read(); }
  set mediaText(v) { this._write(globalThis.__dom.mediaText(v == null ? '' : String(v))); }
  get length()     { return this._items.length; }
  item(i)          { return this._items[i >>> 0] || null; }
  // appendMedium parses ONE medium; a comma-separated list is not a single medium,
  // so it is a no-op (per CSSOM). An already-present medium is also a no-op.
  appendMedium(m)  {
    if (arguments.length < 1) throw new TypeError('appendMedium requires a medium');
    const medium = globalThis.__dom.mediaText(String(m));
    if (!medium || splitTopLevel(medium, ',').length !== 1) return;
    const items = this._items;
    if (!items.includes(medium)) this.mediaText = items.concat(medium).join(', ');
  }
  deleteMedium(m)  {
    if (arguments.length < 1) throw new TypeError('deleteMedium requires a medium');
    const medium = globalThis.__dom.mediaText(String(m));
    if (!medium || splitTopLevel(medium, ',').length !== 1) return;
    const items = this._items;
    if (!items.includes(medium)) throw new DOMException(`'${medium}' not found`, 'NotFoundError');
    this.mediaText = items.filter((x) => x !== medium).join(', ');
  }
  toString()       { return this.mediaText; }
  [Symbol.iterator]() { return this._items[Symbol.iterator](); }
}
// …an `@media` / `@import` rule's, whose writes are the rule's (`ruleSet`).
function ruleMediaList(rule) {
  return new MediaList(() => rule._get('media') || '', (text) => { rule._set('media', text); });
}

class StyleSheetList extends Array {
  item(i) { return this[i >>> 0] || null; }
}

// ── CSSStyleSheet ───────────────────────────────────────────────────────────

const SHEET_DROPS = new FinalizationRegistry((id) => { if (globalThis.__dom) globalThis.__dom.sheetDrop(id); });

class CSSStyleSheet {
  // `new CSSStyleSheet(options)`: a CONSTRUCTED sheet, the only kind `replace` / `replaceSync` accept, which takes no
  // `@import` — a sheet of the engine's own, empty until it is given text, and let go of with this object.
  constructor(options) {
    options = options || {};
    // A `baseURL`, when given, is parsed against the document base URL (CSSOM "create a constructed CSSStyleSheet"); a
    // URL that fails to parse (e.g. `https://test:test/` — a non-numeric port) is a NotAllowedError. Absent → the sheet
    // has no location (`href` is null).
    let href = null;
    if (options.baseURL != null) {
      const base = (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href);
      try { href = new globalThis.URL(String(options.baseURL), base).href; }
      catch (_) { throw new globalThis.DOMException("Failed to construct 'CSSStyleSheet': Constructing a constructed stylesheet with an invalid base URL is not allowed.", 'NotAllowedError'); }
    }
    const id = globalThis.__dom.sheetMake('', href || documentBaseUrl(), '', true, mode())[0];
    SHEET_DROPS.register(this, id);
    initSheet(this, id, { href, media: typeof options.media === 'string' ? options.media : '', disabled: !!options.disabled });
    this._constructed = true;
    // The document whose realm ran `new CSSStyleSheet()` — its "constructor document". A constructed sheet may only be
    // adopted into that same document / its shadow trees (construct-stylesheets "cannot be used in iframes").
    this._constructorDoc = globalThis.document;
  }
  get type()             { return 'text/css'; }
  get ownerNode()        { return this._ownerNode; }
  get ownerRule()        { return this._ownerRule; }
  get parentStyleSheet() { return this._parentStyleSheet; }
  get href()             { return this._href; }
  get media()    { return this._media; }
  set media(v)   { this._media.mediaText = v == null ? '' : String(v); }  // [PutForwards=mediaText]
  // `disabled` toggles whether the sheet contributes to the cascade — an adopted sheet
  // flipped disabled must re-resolve getComputedStyle, so signal the cascade on change.
  get disabled() { return this._disabled; }
  set disabled(v) { const b = !!v; if (b !== this._disabled) { this._disabled = b; rulesMoved(); } }
  // `title` reflects the owner element's current `title` attribute LIVE (a later
  // `setAttribute('title', …)` updates it); empty or absent → null. A constructed or
  // `@import` sheet has no owner node and no title (the `new CSSStyleSheet()` constructor
  // deliberately ignores title/alternate, per WICG/construct-stylesheets#105). A
  // `<?xml-stylesheet?>` owner is a ProcessingInstruction with no `_attrs` — its title
  // isn't modelled, so it reads null (guarded rather than throwing).
  get title()    { const on = this._ownerNode; return on && on._attrs ? (on._attrs.title || null) : null; }
  // The sheet's rules — the same list object for the sheet's life, filled again when the sheet is made of other text
  // (its `<style>`'s text changed, `replaceSync`: the engine's `sheetVersion` moved).
  get cssRules() {
    const version = globalThis.__dom.sheetVersion(this._id);
    if (this._version !== version) {
      this._version = version;
      for (const rule of this._rules) { rule._parentStyleSheet = null; rule._parentRule = null; }
      fillRules(this._rules, globalThis.__dom.sheetRules(this._id), this, null);
    }
    return this._rules;
  }
  get rules()    { return this.cssRules; }   // legacy alias

  insertRule(text, index) {
    if (arguments.length < 1) throw new TypeError('insertRule requires a rule');
    return insertRuleInto(this.cssRules, this, null, text, index);
  }
  deleteRule(index) {
    if (arguments.length < 1) throw new TypeError('deleteRule requires an index');
    deleteRuleFrom(this.cssRules, this, null, index);
  }
  addRule(selector, style, index) {   // legacy IE API
    const i = index === undefined ? this.cssRules.length : index;
    this.insertRule(`${selector} { ${style || ''} }`, i);
    return -1;
  }
  removeRule(index)  { return this.deleteRule(index === undefined ? 0 : index); }

  replace(text)     { try { this.replaceSync(text); return Promise.resolve(this); } catch (e) { return Promise.reject(e); } }
  // A constructed sheet made of `text` (its `@import`s ignored, as the engine parses a constructed sheet).
  replaceSync(text) {
    if (!this._constructed) throw new DOMException('replaceSync on a non-constructed sheet', 'NotAllowedError');
    globalThis.__dom.sheetReplace(this._id, typeof text === 'string' ? text : String(text), this._href || documentBaseUrl(), '', true, mode());
    this._replaced++;
    rulesMoved();
  }
}

// A sheet object's state: the engine's sheet `id`, the media list it applies under (a write reaches the engine's
// sheet: `sheetMedia`), and the rest of its StyleSheet attributes.
function initSheet(sheet, id, { href = null, media = '', disabled = false, ownerNode = null, ownerRule = null, parentStyleSheet = null }) {
  let mediaText = media ? globalThis.__dom.mediaText(media) : '';
  sheet._id = id;
  sheet._href = href;
  sheet._media = new MediaList(() => mediaText, (text) => { mediaText = text; globalThis.__dom.sheetMedia(id, text, mode()); rulesMoved(); });
  sheet._disabled = disabled;
  sheet._ownerNode = ownerNode;
  sheet._ownerRule = ownerRule;
  sheet._parentStyleSheet = parentStyleSheet;
  sheet._constructed = false;
  sheet._constructorDoc = null;
  sheet._rules = new CSSRuleList();
  sheet._version = undefined;
  // How many times `replaceSync` made it of new text: what the cascade keys an adopted sheet on.
  sheet._replaced = 0;
}
// The CSSStyleSheet of the engine's sheet `id` that the page did not construct: a `<style>` / `<link>`'s, an
// `@import`ed one.
function sheetOf(id, fields) {
  const sheet = Object.create(CSSStyleSheet.prototype);
  initSheet(sheet, id, fields);
  return sheet;
}

// ── globals ─────────────────────────────────────────────────────────────────

const INTERFACES = {
  CSSStyleDeclaration, CSSRule, CSSStyleRule, CSSGroupingRule, CSSConditionRule, CSSMediaRule, CSSSupportsRule,
  CSSContainerRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSScopeRule, CSSStartingStyleRule, CSSImportRule,
  CSSNamespaceRule, CSSFontFaceRule, CSSPageRule, CSSMarginRule, CSSKeyframeRule, CSSKeyframesRule,
  CSSCounterStyleRule, CSSPropertyRule, CSSFontPaletteValuesRule, CSSFontFeatureValuesRule, CSSFontFeatureValuesMap,
  CSSNestedDeclarations, CSSPositionTryRule, CSSRuleList, MediaList, StyleSheetList, CSSStyleSheet
};
for (const [name, ctor] of Object.entries(INTERFACES)) {
  globalThis[name] = ctor;
  // `Object.prototype.toString.call(rule)` → `[object CSSStyleRule]` etc.: give every
  // CSSOM interface its Symbol.toStringTag (the class-string tests check this, and the
  // default would be the unhelpful `[object Object]`).
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
}

// The CSSStyleSheet of a `<style>` / `<link>` / `<?xml-stylesheet?>` — the engine's sheet `id` that the cascade
// made of it (cascade.js `ownerSheetId`) — under the owner's `media`.
export function ownedStyleSheet(id, owner, { href = null, media = '' } = {}) {
  return sheetOf(id, { href, media, ownerNode: owner });
}
