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
import {
  convertCSSStyleSheetArguments,
  defineCSSRuleList,
  defineMediaList,
  defineStyleSheetList,
  installCSSConditionRule,
  installCSSContainerRule,
  installCSSCounterStyleRule,
  installCSSFontFaceRule,
  installCSSFontFeatureValuesMap,
  installCSSFontFeatureValuesRule,
  installCSSFontPaletteValuesRule,
  installCSSGroupingRule,
  installCSSImportRule,
  installCSSKeyframeRule,
  installCSSKeyframesRule,
  installCSSLayerBlockRule,
  installCSSLayerStatementRule,
  installCSSMarginRule,
  installCSSMediaRule,
  installCSSNamespaceRule,
  installCSSNestedDeclarations,
  installCSSPageRule,
  installCSSPositionTryRule,
  installCSSPropertyRule,
  installCSSRule,
  installCSSScopeRule,
  installCSSStartingStyleRule,
  installCSSStyleRule,
  installCSSStyleSheet,
  installCSSSupportsRule,
  installStyleSheet
} from './generated/bindings.js';
import { currentViewport, mediaMatches } from './media-query.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, resolvedPromise, slotsOf, withIndexedGetter } from './webidl.js';

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
const mode = () => { const doc = globalThis.document; return !!(doc && doc._quirks); };

// ── CSSRuleList ─────────────────────────────────────────────────────────────

// A list of rules — a sheet's, a grouping rule's, a `@keyframes`'s — generated from its IDL: an array of its rules in
// its slots (`rules`), the one its owner fills from the handles the engine gives out and keeps in step with the
// mutations made through it ([SameObject]).
const ruleListBinding = defineCSSRuleList({
  init(s, rules) { s.rules = rules; },
  item: (s, index) => s.rules[index] ?? null,
  get_length: (s) => s.rules.length
});
globalThis.CSSRuleList = ruleListBinding.interface;
// `rules` filled from the engine's `entries` (handle, kind, …), each made the object of its interface.
function fillRules(rules, entries, sheet, parent) {
  rules.length = 0;
  if (entries) for (let i = 0; i < entries.length; i += 2) rules.push(makeRule(entries[i], entries[i + 1], sheet, parent));
  return rules;
}

// ── CSSRule ─────────────────────────────────────────────────────────────────

// Every rule interface generated from its IDL, installed on the class below that makes its objects: the platform alone
// (`new CSSStyleRule()` is an illegal constructor), one for each rule the engine hands out a handle to. A rule's slots:
// its handle and kind (cssom_rule.rs `kind`), its parent sheet and rule (both null once it is removed), and what
// [SameObject] keeps — its list of rules, its style, its media list.
const ruleOf = (o) => slotsOf(o, 'CSSRule');
class CSSRule {
  constructor(token, handle, kind, parentStyleSheet, parentRule) {
    constructedBy(PLATFORM, token, new.target.name);
    makeSlots(this, 'CSSRule', { handle, kind, parentStyleSheet, parentRule });
  }
}
// The legacy `type` of a rule of each kind (CSSOM's constants, and the ones the other specs add); 0 for every other.
const RULE_TYPE = {
  'style': 1, 'import': 3, 'media': 4, 'font-face': 5, 'page': 6, 'keyframes': 7, 'keyframe': 8, 'margin': 9,
  'namespace': 10, 'counter-style': 11, 'supports': 12, 'font-feature-values': 14
};
// One of the rule's attributes as the engine reads it (`ruleGet`), and a write of one (`ruleSet`): whether it took.
const ruleGet = (s, what) => globalThis.__dom.ruleGet(s.handle, what);
function ruleSet(s, what, value) {
  const took = globalThis.__dom.ruleSet(s.handle, what, value);
  if (took) rulesMoved();
  return took;
}
installCSSRule(CSSRule, {
  get_cssText: (rule) => globalThis.__dom.ruleText(ruleOf(rule).handle) || '',
  // (…setting it does nothing, CSSOM says)
  set_cssText() {},
  get_parentRule: (rule) => ruleOf(rule).parentRule,
  get_parentStyleSheet: (rule) => ruleOf(rule).parentStyleSheet,
  get_type: (rule) => RULE_TYPE[ruleOf(rule).kind] ?? 0
});

// CSSOM "insert a CSS rule" into the list `rules` (the sheet `sheet`'s own, or the rule `parent`'s): the engine parses
// and checks it, and refuses it with the DOMException CSSOM names.
function insertRuleInto(rules, sheet, parent, text, index) {
  const answer = globalThis.__dom.ruleInsert(sheetOf(sheet).id, parent ? ruleOf(parent).handle : -1, text, index);
  if (typeof answer === 'string') throw new DOMException(`Failed to insert the rule: ${answer}`, answer);
  rules.splice(index, 0, makeRule(answer[0], answer[1], sheet, parent));
  if (answer.length > 2 && globalThis.__csimResolveSheetImports) globalThis.__csimResolveSheetImports(answer.slice(2), mode());
  rulesMoved();
  return index;
}
// CSSOM "remove a CSS rule": the removed rule is detached (`parentRule` / `parentStyleSheet` null).
function deleteRuleFrom(rules, sheet, parent, index) {
  const refused = globalThis.__dom.ruleDelete(sheetOf(sheet).id, parent ? ruleOf(parent).handle : -1, index);
  if (refused) throw new DOMException(`Failed to delete the rule: ${refused}`, refused);
  const [removed] = rules.splice(index, 1);
  if (removed) detachRule(removed);
  rulesMoved();
}
function detachRule(rule) {
  const s = ruleOf(rule);
  s.parentStyleSheet = null;
  s.parentRule = null;
}
// A rule's own rules — a grouping rule's, a `@keyframes`'s — filled on first read, and their list.
function childRules(s) {
  if (s.rules === undefined) s.rules = fillRules([], globalThis.__dom.ruleRules(s.handle), s.parentStyleSheet, s.owner);
  return s.rules;
}
const childRuleList = (s) => (s.ruleList ??= ruleListBinding.create(childRules(s)));

// CSSGroupingRule — a rule that holds rules (`@media`, `@supports`, `@layer`, `@container`, `@scope`, a style rule's
// nested ones, a page rule's margin rules).
class CSSGroupingRule extends CSSRule {}
installCSSGroupingRule(CSSGroupingRule, {
  get_cssRules: (rule) => childRuleList(ruleOf(rule)),
  insertRule(rule, text, index) {
    const s = ruleOf(rule);
    return insertRuleInto(childRules(s), s.parentStyleSheet, s.owner, text, index);
  },
  deleteRule(rule, index) {
    const s = ruleOf(rule);
    deleteRuleFrom(childRules(s), s.parentStyleSheet, s.owner, index);
  }
});
class CSSConditionRule extends CSSGroupingRule {}
installCSSConditionRule(CSSConditionRule, { get_conditionText: (rule) => conditionText(ruleOf(rule)) });
// A condition rule's condition, as the engine serializes it — an `@container`'s its conditions, joined as
// css-conditional-5 joins them.
function conditionText(s) {
  if (s.kind !== 'container') return ruleGet(s, 'condition') || '';
  return containerConditions(s).map(({ name, query }) => (name && query ? `${name} ${query}` : name + query)).join(', ');
}

// A rule's media list (`@media`, `@import`): read and written as the rule's (`ruleSet`).
const ruleMedia = (s) => (s.media ??= mediaListBinding.create(() => ruleGet(s, 'media') || '', (text) => { ruleSet(s, 'media', text); }));
class CSSMediaRule extends CSSConditionRule {}
installCSSMediaRule(CSSMediaRule, {
  get_media: (rule) => ruleMedia(ruleOf(rule)),
  // (…whether its media query list matches on the window's viewport, as the cascade applies it)
  get_matches: (rule) => mediaMatches(ruleGet(ruleOf(rule), 'media') || '', currentViewport())
});
class CSSSupportsRule extends CSSConditionRule {}
installCSSSupportsRule(CSSSupportsRule, {
  // (…whether its condition holds, as the cascade evaluates it: the condition `CSS.supports` takes)
  get_matches: (rule) => globalThis.__dom.declSupportsCondition(ruleGet(ruleOf(rule), 'condition') || '')
});
// An `@container`'s conditions — a name and a query each, in the order written (css-conditional-5) — the same frozen
// array until the rule changes.
function containerConditions(s) {
  if (s.conditions === undefined) {
    const lines = (ruleGet(s, 'conditions') || '').split('\n').filter(Boolean);
    s.conditions = Object.freeze(lines.map((line) => {
      const [name, query] = line.split('\t');
      return { name, query };
    }));
  }
  return s.conditions;
}
class CSSContainerRule extends CSSConditionRule {}
installCSSContainerRule(CSSContainerRule, {
  get_containerName(rule) {
    const conditions = containerConditions(ruleOf(rule));
    return conditions.length === 1 ? conditions[0].name : '';
  },
  get_containerQuery(rule) {
    const conditions = containerConditions(ruleOf(rule));
    return conditions.length === 1 ? conditions[0].query : '';
  },
  get_conditions: (rule) => containerConditions(ruleOf(rule))
});

class CSSLayerBlockRule extends CSSGroupingRule {}
installCSSLayerBlockRule(CSSLayerBlockRule, { get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '' });
class CSSLayerStatementRule extends CSSRule {}
installCSSLayerStatementRule(CSSLayerStatementRule, {
  // (…a frozen array, the same one each time)
  get_nameList(rule) {
    const s = ruleOf(rule);
    return (s.names ??= Object.freeze((ruleGet(s, 'names') || '').split(',').filter(Boolean)));
  }
});
class CSSScopeRule extends CSSGroupingRule {}
installCSSScopeRule(CSSScopeRule, {
  get_start: (rule) => ruleGet(ruleOf(rule), 'start') || null,
  get_end: (rule) => ruleGet(ruleOf(rule), 'end') || null
});
class CSSStartingStyleRule extends CSSGroupingRule {}
installCSSStartingStyleRule(CSSStartingStyleRule, {});

// The declaration block of a rule (`rule.style`): every read and write is of the rule's own block (the decl ops' `rule`
// argument), its text — the block's serialization, kept until a write through it — only a key for what the reads
// memoize. Its kind (style-proxy.js `storeKind`) is what it may declare: a keyframe's and a page's properties, an
// `@font-face` rule's descriptors, and a style rule's properties for every other.
const BLOCK_KIND_OF_RULE = { 'keyframe': BLOCK_KIND.keyframe, 'page': BLOCK_KIND.page, 'margin': BLOCK_KIND.margin, 'font-face': FONT_FACE_BLOCK };
function ruleStyle(s) {
  return (s.style ??= makeDeclProxy({
    read:    () => s.blockText ??= globalThis.__dom.declText('', BLOCK_KIND_OF_RULE[s.kind] ?? 0, mode(), documentBaseUrl(), -1, s.handle),
    write:   (text) => { s.blockText = text; rulesMoved(); },
    kind:    BLOCK_KIND_OF_RULE[s.kind] ?? 0,
    rule:    () => s.handle,
    cacheOn: s,
    owner:   s.owner
  }));
}
const style = (rule) => ruleStyle(ruleOf(rule));
const selectorText = (rule) => ruleGet(ruleOf(rule), 'selector') || '';
// (…a selector the engine does not parse — an empty one included — leaves the rule as it was, CSSOM says)
const setSelectorText = (rule, v) => { ruleSet(ruleOf(rule), 'selector', v); };

class CSSStyleRule extends CSSGroupingRule {}
installCSSStyleRule(CSSStyleRule, { get_selectorText: selectorText, set_selectorText: setSelectorText, get_style: style });
class CSSPageRule extends CSSGroupingRule {}
installCSSPageRule(CSSPageRule, { get_selectorText: selectorText, set_selectorText: setSelectorText, get_style: style });
const MARGIN_RULE_NAMES = [
  'top-left-corner', 'top-left', 'top-center', 'top-right', 'top-right-corner', 'bottom-left-corner', 'bottom-left',
  'bottom-center', 'bottom-right', 'bottom-right-corner', 'left-top', 'left-middle', 'left-bottom', 'right-top',
  'right-middle', 'right-bottom'
];
class CSSMarginRule extends CSSRule {}
installCSSMarginRule(CSSMarginRule, {
  // (…its at-keyword's name, read off its text: `@top-left { … }` → "top-left")
  get_name(rule) {
    const name = (/^@([a-z-]+)/.exec(globalThis.__dom.ruleText(ruleOf(rule).handle) || '') || [])[1] || '';
    return MARGIN_RULE_NAMES.includes(name) ? name : '';
  },
  get_style: style
});
class CSSFontFaceRule extends CSSRule {}
installCSSFontFaceRule(CSSFontFaceRule, { get_style: style });
class CSSNestedDeclarations extends CSSRule {}
installCSSNestedDeclarations(CSSNestedDeclarations, { get_style: style });
class CSSPositionTryRule extends CSSRule {}
installCSSPositionTryRule(CSSPositionTryRule, { get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '', get_style: style });
class CSSKeyframeRule extends CSSRule {}
installCSSKeyframeRule(CSSKeyframeRule, {
  get_keyText: (rule) => ruleGet(ruleOf(rule), 'key') || '',
  // (…a key the engine does not parse a SyntaxError, css-animations-1 says)
  set_keyText(rule, v) {
    if (!ruleSet(ruleOf(rule), 'key', v)) throw new DOMException(`Failed to set the 'keyText' property on 'CSSKeyframeRule': The key '${v}' is invalid and cannot be parsed`, 'SyntaxError');
  },
  get_style: style
});

// An `@keyframes` rule: its keyframes, a legacy platform object's indices too (`keyframesRule[0]`) — the Proxy
// `withIndexedGetter` makes, stamped with the rule's slots.
class CSSKeyframesRule extends CSSRule {
  constructor(...args) {
    super(...args);
    return withIndexedGetter(this, (s, index) => childRules(s)[index] ?? null, (s) => childRules(s).length);
  }
}
installCSSKeyframesRule(CSSKeyframesRule, {
  get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '',
  set_name(rule, v) { ruleSet(ruleOf(rule), 'name', v); },
  get_cssRules: (rule) => childRuleList(ruleOf(rule)),
  get_length: (rule) => childRules(ruleOf(rule)).length,
  // appendRule / deleteRule / findRule are keyed by a keyframe SELECTOR (`0%`, `from`, `50%, 60%`), compared as the
  // engine parses it; the LAST keyframe of that selector is the one found.
  appendRule(rule, text) {
    const s = ruleOf(rule), handle = globalThis.__dom.keyframeAppend(s.handle, text);
    if (handle == null) return;
    childRules(s).push(makeRule(handle, 'keyframe', s.parentStyleSheet, s.owner));
    rulesMoved();
  },
  deleteRule(rule, select) {
    const s = ruleOf(rule), i = globalThis.__dom.keyframeFind(s.handle, select);
    if (i < 0) return;
    globalThis.__dom.keyframeDelete(s.handle, i);
    const [removed] = childRules(s).splice(i, 1);
    if (removed) detachRule(removed);
    rulesMoved();
  },
  findRule(rule, select) {
    const s = ruleOf(rule), i = globalThis.__dom.keyframeFind(s.handle, select);
    return i < 0 ? null : childRules(s)[i];
  }
});

class CSSImportRule extends CSSRule {}
installCSSImportRule(CSSImportRule, {
  get_href: (rule) => ruleGet(ruleOf(rule), 'href') || '',
  // (…its media the imported sheet's, written there)
  get_media: (rule) => ruleMedia(ruleOf(rule)),
  // The imported sheet, once it arrived — a sheet of its own for each `@import`, even two of one URL
  // (cssimportrule-sheet-identity) — and null while it has none.
  get_styleSheet(rule) {
    const s = ruleOf(rule);
    if (s.styleSheet === undefined) {
      const id = globalThis.__dom.importSheet(s.handle);
      s.styleSheet = id == null ? null : platformSheet(id, { ownerRule: s.owner, parentStyleSheet: s.parentStyleSheet, href: ruleGet(s, 'url') });
    }
    return s.styleSheet;
  },
  get_layerName: (rule) => ruleGet(ruleOf(rule), 'layer'),
  get_supportsText: (rule) => ruleGet(ruleOf(rule), 'supports')
});
class CSSNamespaceRule extends CSSRule {}
installCSSNamespaceRule(CSSNamespaceRule, {
  get_namespaceURI: (rule) => ruleGet(ruleOf(rule), 'namespace') || '',
  get_prefix: (rule) => ruleGet(ruleOf(rule), 'prefix') || ''
});

// An `@counter-style` rule: each descriptor an attribute, written through the engine's own CSSOM checks — a value that
// does not parse, a name no counter style can have, another kind of system, symbols for an `extends` one, change
// nothing (css-counter-styles-3 §The CSSCounterStyleRule interface).
const counterStyleDescriptor = (what) => ({
  [`get_${what}`]: (rule) => ruleGet(ruleOf(rule), what === 'name' ? 'name' : what.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) || '',
  [`set_${what}`](rule, v) { ruleSet(ruleOf(rule), what === 'name' ? 'name' : what.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v); }
});
class CSSCounterStyleRule extends CSSRule {}
installCSSCounterStyleRule(CSSCounterStyleRule, Object.assign({}, ...[
  'name', 'system', 'symbols', 'additiveSymbols', 'negative', 'prefix', 'suffix', 'range', 'pad', 'speakAs', 'fallback'
].map(counterStyleDescriptor)));

class CSSPropertyRule extends CSSRule {}
installCSSPropertyRule(CSSPropertyRule, {
  get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '',
  get_syntax: (rule) => ruleGet(ruleOf(rule), 'syntax') || '',
  get_inherits: (rule) => ruleGet(ruleOf(rule), 'inherits') === 'true',
  get_initialValue: (rule) => ruleGet(ruleOf(rule), 'initial') || null
});
class CSSFontPaletteValuesRule extends CSSRule {}
installCSSFontPaletteValuesRule(CSSFontPaletteValuesRule, {
  get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '',
  get_fontFamily: (rule) => ruleGet(ruleOf(rule), 'family') || '',
  get_basePalette: (rule) => ruleGet(ruleOf(rule), 'base-palette') || '',
  get_overrideColors: (rule) => ruleGet(ruleOf(rule), 'override-colors') || ''
});

// css-fonts-4 CSSFontFeatureValuesMap: a maplike of `<feature-value-name>` → a sequence of non-negative integers
// (`styleset: di 10 9 4 5` → `di` → [10, 9, 4, 5]) in its slots' `map`, and `set`, which takes a lone number as a
// one-item sequence.
const featureMapOf = (o) => slotsOf(o, 'CSSFontFeatureValuesMap');
class CSSFontFeatureValuesMap {
  constructor(token) {
    constructedBy(PLATFORM, token, 'CSSFontFeatureValuesMap');
    makeSlots(this, 'CSSFontFeatureValuesMap', { map: new Map() });
  }
}
registerInterface('CSSFontFeatureValuesMap', (o) => featureMapOf(o) !== undefined);
installCSSFontFeatureValuesMap(CSSFontFeatureValuesMap, {
  mapOf: (map) => featureMapOf(map).map,
  set(map, name, values) { featureMapOf(map).map.set(name, typeof values === 'number' ? [values] : values); }
});

// css-fonts-4 CSSFontFeatureValuesRule: `@font-feature-values <family> { @styleset {…} … }`. Each nested block fills a
// same-named maplike, from the declarations the engine read (`values`, a line per declaration). (A write to a map, or to
// `fontFamily`, is this object's alone: the engine holds the rule immutably, and nothing renders by it here.)
const FONT_FEATURE_MAPS = {
  'annotation':        'annotation',
  'ornaments':         'ornaments',
  'stylistic':         'stylistic',
  'swash':             'swash',
  'character-variant': 'characterVariant',
  'styleset':          'styleset',
  'historical-forms':  'historicalForms'
};
function featureMaps(s) {
  if (s.featureMaps) return s.featureMaps;
  const maps = {};
  for (const key of Object.values(FONT_FEATURE_MAPS)) maps[key] = new CSSFontFeatureValuesMap(PLATFORM);
  for (const line of (ruleGet(s, 'values') || '').split('\n')) {
    const [block, name, values] = line.split('\t');
    const key = FONT_FEATURE_MAPS[block];
    if (key) featureMapOf(maps[key]).map.set(name, values.trim().split(/\s+/).map(Number));
  }
  return (s.featureMaps = maps);
}
class CSSFontFeatureValuesRule extends CSSRule {}
installCSSFontFeatureValuesRule(CSSFontFeatureValuesRule, Object.assign({
  get_fontFamily(rule) {
    const s = ruleOf(rule);
    return s.fontFamily ?? (ruleGet(s, 'family') || '');
  },
  set_fontFamily(rule, v) { ruleOf(rule).fontFamily = v; }
}, ...Object.values(FONT_FEATURE_MAPS).map((key) => ({ [`get_${key}`]: (rule) => featureMaps(ruleOf(rule))[key] }))));

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
function makeRule(handle, kind, sheet, parent) {
  const rule = new (RULE_CLASSES[kind] || CSSRule)(PLATFORM, handle, kind, sheet, parent);
  RULE_DROPS.register(rule, handle);
  return rule;
}
// What an IDL conversion to each rule interface takes: a rule of any realm's whose kind is one of the interface's or
// an interface's that inherits from it — read off the kind, which every realm's rules carry alike.
{
  const kindsOf = new Map([[CSSRule, null]]);
  for (const [kind, Rule] of Object.entries(RULE_CLASSES)) {
    for (let c = Rule; c !== CSSRule; c = Object.getPrototypeOf(c)) {
      if (!kindsOf.has(c)) kindsOf.set(c, new Set());
      kindsOf.get(c).add(kind);
    }
  }
  for (const [Rule, kinds] of kindsOf) {
    registerInterface(Rule.name, kinds === null ? (o) => ruleOf(o) !== undefined : (o) => kinds.has(ruleOf(o)?.kind));
  }
}

// ── MediaList / StyleSheetList ──────────────────────────────────────────────

// A media list over where its text lives — a sheet's, an `@media` rule's — generated from its IDL, read and written as
// the engine parses and serializes media queries: its slots the two steps.
const mediaItems = (s) => splitTopLevel(s.read(), ',').map((m) => m.trim()).filter(Boolean);
// (…one medium, as the engine parses it, or null where the text is none or more than one)
function oneMedium(text) {
  const medium = globalThis.__dom.mediaText(text);
  return medium && splitTopLevel(medium, ',').length === 1 ? medium : null;
}
const mediaListBinding = defineMediaList({
  init(s, read, write) {
    s.read = read;
    s.write = write;
  },
  get_mediaText: (s) => s.read(),
  set_mediaText(s, v) { s.write(globalThis.__dom.mediaText(v)); },
  get_length: (s) => mediaItems(s).length,
  item: (s, index) => mediaItems(s)[index] ?? null,
  // (…an already-present medium, or text that is no one medium, nothing)
  appendMedium(s, text) {
    const medium = oneMedium(text), items = mediaItems(s);
    if (medium !== null && !items.includes(medium)) s.write(items.concat(medium).join(', '));
  },
  deleteMedium(s, text) {
    const medium = oneMedium(text), items = mediaItems(s);
    if (medium === null) return;
    if (!items.includes(medium)) throw new DOMException(`Failed to execute 'deleteMedium' on 'MediaList': Failed to delete '${medium}'.`, 'NotFoundError');
    s.write(items.filter((x) => x !== medium).join(', '));
  }
});
globalThis.MediaList = mediaListBinding.interface;

// A document's or a shadow root's style sheets, generated from its IDL: the sheets `sheetsOf()` finds in it, read
// again on each access — a list as live as the tree.
const styleSheetListBinding = defineStyleSheetList({
  init(s, sheetsOf) { s.sheetsOf = sheetsOf; },
  item: (s, index) => s.sheetsOf()[index] ?? null,
  get_length: (s) => s.sheetsOf().length
});
globalThis.StyleSheetList = styleSheetListBinding.interface;
export const newStyleSheetList = (sheetsOf) => styleSheetListBinding.create(sheetsOf);

// ── StyleSheet / CSSStyleSheet ──────────────────────────────────────────────

// A sheet's slots — any realm's code's to read (cascade.js, dom-nodes.js): the engine's sheet `id`, its location,
// media list and its text (`mediaText`) and the rest of its StyleSheet attributes, whether a page constructed it (and in which document), its
// rules and their list, the engine's `sheetVersion` they were filled at, and how many times `replaceSync` made it of new
// text — what the cascade keys an adopted sheet on.
const sheetOf = (o) => slotsOf(o, 'CSSStyleSheet');
const SHEET_DROPS = new FinalizationRegistry((id) => { if (globalThis.__dom) globalThis.__dom.sheetDrop(id); });
registerInterface('StyleSheet', (o) => slotsOf(o, 'StyleSheet') !== undefined);
registerInterface('CSSStyleSheet', (o) => sheetOf(o) !== undefined);

class StyleSheet {
  constructor() {
    if (new.target === StyleSheet) constructedBy(PLATFORM, undefined, 'StyleSheet');
  }
}
installStyleSheet(StyleSheet, {
  get_type: () => 'text/css',
  get_href: (sheet) => sheetOf(sheet).href,
  get_ownerNode: (sheet) => sheetOf(sheet).ownerNode,
  get_parentStyleSheet: (sheet) => sheetOf(sheet).parentStyleSheet,
  // (…its owner element's `title` LIVE, empty or absent null; a constructed or `@import`ed sheet has no owner and no
  // title, and an `<?xml-stylesheet?>`'s is not modelled)
  get_title(sheet) {
    const owner = sheetOf(sheet).ownerNode;
    return owner && owner._attrs ? (owner._attrs.title || null) : null;
  },
  get_media: (sheet) => sheetOf(sheet).media,
  get_disabled: (sheet) => sheetOf(sheet).disabled,
  // (…a flip re-resolves the cascade: an adopted sheet disabled must not apply)
  set_disabled(sheet, v) {
    const s = sheetOf(sheet);
    if (v !== s.disabled) {
      s.disabled = v;
      rulesMoved();
    }
  }
});

class CSSStyleSheet extends StyleSheet {
  // `new CSSStyleSheet(options)`: a CONSTRUCTED sheet, the only kind `replace` / `replaceSync` accept, which takes no
  // `@import` — a sheet of the engine's own, empty until it is given text, and let go of with this object.
  constructor() {
    const [options] = convertCSSStyleSheetArguments(arguments);
    super();
    // A `baseURL`, when given, is parsed against the document base URL (CSSOM "create a constructed CSSStyleSheet"); a
    // URL that fails to parse (e.g. `https://test:test/` — a non-numeric port) is a NotAllowedError. Absent → the sheet
    // has no location (`href` is null).
    let href = null;
    if (options.baseURL !== null) {
      const base = (globalThis.document && globalThis.document.baseURI) || (globalThis.location && globalThis.location.href);
      try { href = new globalThis.URL(options.baseURL, base).href; }
      catch (_) { throw new DOMException("Failed to construct 'CSSStyleSheet': Constructing a constructed stylesheet with an invalid base URL is not allowed.", 'NotAllowedError'); }
    }
    const id = globalThis.__dom.sheetMake('', href || documentBaseUrl(), '', true, mode())[0];
    SHEET_DROPS.register(this, id);
    const media = typeof options.media === 'string' ? options.media : options.media.mediaText;
    // (…its constructor document: the document whose realm made it, the one it may be adopted into)
    initSheet(this, id, { href, media, disabled: options.disabled, constructorDocument: globalThis.document });
  }
}
// The sheet's rules — filled again when the sheet is made of other text (its `<style>`'s text changed, `replaceSync`:
// the engine's `sheetVersion` moved), the rules it had detached.
function sheetRules(s) {
  const version = globalThis.__dom.sheetVersion(s.id);
  if (s.version !== version) {
    s.version = version;
    for (const rule of s.rules) detachRule(rule);
    fillRules(s.rules, globalThis.__dom.sheetRules(s.id), s.owner, null);
  }
  return s.rules;
}
// A constructed sheet made of `text` (its `@import`s ignored, as the engine parses a constructed sheet); any other a
// NotAllowedError.
function replaceSheet(s, text, member) {
  if (s.constructorDocument === null) throw new DOMException(`Failed to execute '${member}' on 'CSSStyleSheet': Can't call ${member} on non-constructed CSSStyleSheets.`, 'NotAllowedError');
  globalThis.__dom.sheetReplace(s.id, text, s.href || documentBaseUrl(), '', true, mode());
  s.replaced++;
  rulesMoved();
}
installCSSStyleSheet(CSSStyleSheet, {
  get_ownerRule: (sheet) => sheetOf(sheet).ownerRule,
  get_cssRules: (sheet) => { const s = sheetOf(sheet); sheetRules(s); return s.ruleList; },
  get_rules: (sheet) => { const s = sheetOf(sheet); sheetRules(s); return s.ruleList; },
  insertRule: (sheet, text, index) => insertRuleInto(sheetRules(sheetOf(sheet)), sheet, null, text, index),
  deleteRule(sheet, index) { deleteRuleFrom(sheetRules(sheetOf(sheet)), sheet, null, index); },
  // (…the legacy addRule: the rule `selector { style }` inserted at `index`, the end by default — and -1)
  addRule(sheet, selector, block, index) {
    const rules = sheetRules(sheetOf(sheet));
    insertRuleInto(rules, sheet, null, `${selector} { ${block === '' ? '' : block + ' '}}`, index ?? rules.length);
    return -1;
  },
  removeRule(sheet, index) { deleteRuleFrom(sheetRules(sheetOf(sheet)), sheet, null, index); },
  replace(sheet, text) {
    replaceSheet(sheetOf(sheet), text, 'replace');
    return resolvedPromise(sheet);
  },
  replaceSync(sheet, text) { replaceSheet(sheetOf(sheet), text, 'replaceSync'); }
});

// A sheet object's state: the engine's sheet `id`, and the media list it applies under (a write reaches the engine's
// sheet: `sheetMedia`).
function initSheet(sheet, id, { href = null, media = '', disabled = false, ownerNode = null, ownerRule = null, parentStyleSheet = null, constructorDocument = null }) {
  const rules = [];
  makeSlots(sheet, 'StyleSheet');
  const s = makeSlots(sheet, 'CSSStyleSheet', {
    id,
    href,
    mediaText: media ? globalThis.__dom.mediaText(media) : '',
    disabled,
    ownerNode,
    ownerRule,
    parentStyleSheet,
    constructorDocument,
    rules,
    ruleList: ruleListBinding.create(rules),
    version: undefined,
    replaced: 0
  });
  s.media = mediaListBinding.create(() => s.mediaText, (text) => {
    s.mediaText = text;
    globalThis.__dom.sheetMedia(id, text, mode());
    rulesMoved();
  });
}
// The CSSStyleSheet of the engine's sheet `id` that the page did not construct: a `<style>` / `<link>`'s, an
// `@import`ed one.
function platformSheet(id, fields) {
  const sheet = Object.create(CSSStyleSheet.prototype);
  initSheet(sheet, id, fields);
  return sheet;
}

// ── globals ─────────────────────────────────────────────────────────────────

for (const iface of [
  CSSStyleDeclaration, CSSRule, CSSStyleRule, CSSGroupingRule, CSSConditionRule, CSSMediaRule, CSSSupportsRule,
  CSSContainerRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSScopeRule, CSSStartingStyleRule, CSSImportRule,
  CSSNamespaceRule, CSSFontFaceRule, CSSPageRule, CSSMarginRule, CSSKeyframeRule, CSSKeyframesRule,
  CSSCounterStyleRule, CSSPropertyRule, CSSFontPaletteValuesRule, CSSFontFeatureValuesRule, CSSFontFeatureValuesMap,
  CSSNestedDeclarations, CSSPositionTryRule, StyleSheet, CSSStyleSheet
]) {
  globalThis[iface.name] = iface;
}
// (…and CSSStyleDeclaration's class string, which no binding of it defines)
Object.defineProperty(CSSStyleDeclaration.prototype, Symbol.toStringTag, { value: 'CSSStyleDeclaration', configurable: true });

// The CSSStyleSheet of a `<style>` / `<link>` / `<?xml-stylesheet?>` — the engine's sheet `id` that the cascade
// made of it (cascade.js `engineSheetOf`) — under the owner's `media`.
// The engine's sheet lives as long as the object does, once one shows it (cascade.js `engineSheetOf`).
export function ownedStyleSheet(id, owner, { href = null, media = '' } = {}) {
  const sheet = platformSheet(id, { href, media, ownerNode: owner });
  SHEET_DROPS.register(sheet, id);
  return sheet;
}
