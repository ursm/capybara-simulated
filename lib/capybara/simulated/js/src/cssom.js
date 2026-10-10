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
import { declarationImplementation as declarationOf, declarationPrototypes, makeDeclProxy } from './style-proxy.js';
import { DOMException } from './events.js';
import {
  convertCSSStyleSheetArguments,
  defineCSSRuleList,
  defineMediaList,
  defineStyleSheetList,
  installCSSConditionRule,
  installCSSContainerRule,
  installCSSCounterStyleRule,
  installCSSFontFaceDescriptors,
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
  installCSSPageDescriptors,
  installCSSPageRule,
  installCSSPositionTryDescriptors,
  installCSSPositionTryRule,
  installCSSPropertyRule,
  installCSSRule,
  installCSSScopeRule,
  installCSSStartingStyleRule,
  installCSSStyleDeclaration,
  installCSSStyleProperties,
  installCSSStyleRule,
  installCSSStyleSheet,
  installCSSSupportsRule,
  installStyleSheet
} from './generated/bindings.js';
import { currentViewport, mediaMatches } from './media-query.js';
import { queueTask } from './timers.js';
import {
  IntrinsicPromise,
  PLATFORM,
  brandKey,
  constructedBy,
  interfaceCheck,
  makeSlots,
  ownRealm,
  registerInterface,
  slotsOf,
  thisIs,
  withIndexedGetter
} from './webidl.js';

// ── CSSStyleDeclaration and its kinds ───────────────────────────────────────

// A declaration block — an element's inline style, a rule's block, a computed style — generated from its IDL: the
// Proxy style-proxy.js makes (`makeDeclProxy`), which answers its indices and carries its implementation (CSSOM's
// members over the block it reads and writes: `declarationImplementation`), its prototype the one of its kind. A style
// rule's, a keyframe's, a margin rule's, nested declarations', an element's and a computed style are CSSStyleProperties,
// with an attribute for every supported property; a page rule's, a font face's and a position-try rule's are the
// descriptors interface of their kind, with an attribute for each of their descriptors.
class CSSStyleDeclaration {
  constructor(token) {
    constructedBy(PLATFORM, token, new.target.name);
  }
}
class CSSStyleProperties extends CSSStyleDeclaration {}
class CSSPageDescriptors extends CSSStyleDeclaration {}
class CSSFontFaceDescriptors extends CSSStyleDeclaration {}
class CSSPositionTryDescriptors extends CSSStyleDeclaration {}
const DECLARATION_INTERFACES = { CSSStyleDeclaration, CSSStyleProperties, CSSPageDescriptors, CSSFontFaceDescriptors, CSSPositionTryDescriptors };
for (const [name, iface] of Object.entries(DECLARATION_INTERFACES)) {
  declarationPrototypes[name] = iface.prototype;
  registerInterface(name, name === 'CSSStyleDeclaration'
    ? (o) => declarationOf(o) !== undefined
    : (o) => declarationOf(o)?.interface === name);
}
installCSSStyleDeclaration(CSSStyleDeclaration, {
  get_cssText: (d) => declarationOf(d).cssText,
  set_cssText(d, v) { declarationOf(d).cssText = v; },
  get_length: (d) => declarationOf(d).length,
  item: (d, index) => declarationOf(d).item(index),
  getPropertyValue: (d, property) => declarationOf(d).getPropertyValue(property),
  getPropertyPriority: (d, property) => declarationOf(d).getPropertyPriority(property),
  setProperty(d, property, value, priority) { declarationOf(d).setProperty(property, value, priority); },
  removeProperty: (d, property) => declarationOf(d).removeProperty(property),
  get_parentRule: (d) => declarationOf(d).parentRule
});
installCSSStyleProperties(CSSStyleProperties, {
  get_cssFloat: (d) => declarationOf(d).getPropertyValue('float'),
  set_cssFloat(d, v) { declarationOf(d).setProperty('float', v, ''); }
});
// A descriptors interface's attributes, each its descriptor's — the camel-cased spelling and the dashed one alike
// (CSSOM's prose for CSSPageDescriptors, as css-fonts-5's and css-anchor-position's for theirs): `get_<attribute>` /
// `set_<attribute>` answered for whatever attribute the binding asks of.
const descriptorSteps = new Map();
const descriptorAttributes = new Proxy({}, {
  get(_, member) {
    let step = descriptorSteps.get(member);
    if (step === undefined) {
      const descriptor = member.slice(4).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      step = member.startsWith('get_')
        ? (d) => declarationOf(d).getPropertyValue(descriptor)
        : (d, v) => { declarationOf(d).setProperty(descriptor, v, ''); };
      descriptorSteps.set(member, step);
    }
    return step;
  }
});
installCSSPageDescriptors(CSSPageDescriptors, descriptorAttributes);
installCSSFontFaceDescriptors(CSSFontFaceDescriptors, descriptorAttributes);
installCSSPositionTryDescriptors(CSSPositionTryDescriptors, descriptorAttributes);

// …and a CSSStyleProperties' attribute for every supported CSS property (CSSOM §6.7.2's prose, so no IDL's): the
// camel-cased spelling, the dashed one, `webkitAppearance`. On the PROTOTYPE, not the instance, so
// `getComputedStyle(el).hasOwnProperty('color')` stays false, which is what `cssom/cssstyledeclaration-properties.html`
// asserts and what Chrome — which makes them own data properties per instance — fails.
//
// The declaration proxies trap `get` and `set` ahead of the prototype, so these are the reflection surface rather than
// the read path: one pass at realm boot, nothing per read.
{
  const attribute = (get, set) => ({ configurable: true, enumerable: true, get, set });
  const IS_PROPERTIES = interfaceCheck('CSSStyleProperties');
  const properties = (self) => declarationOf(thisIs(self, IS_PROPERTIES));
  // One accessor pair per PROPERTY, shared by its spellings — they resolve to the same declaration.
  const perProperty = new Map();
  const attributes  = { __proto__: null };
  for (const name of Object.keys(CSS_PROPERTY_BY_IDL_ATTRIBUTE)) {
    if (Object.hasOwn(CSSStyleProperties.prototype, name)) continue;
    const property = CSS_PROPERTY_BY_IDL_ATTRIBUTE[name];
    let descriptor = perProperty.get(property);
    if (!descriptor) perProperty.set(property, descriptor = attribute(
      function () { return properties(this).getPropertyValue(property); },
      // IDL `[LegacyNullToEmptyString]`: `null` clears the declaration rather than writing "null".
      function (value) { properties(this).setProperty(property, value === null ? '' : String(value), ''); }
    ));
    attributes[name] = descriptor;
  }
  Object.defineProperties(CSSStyleProperties.prototype, attributes);
}

// A face's declarations as a read-only CSSFontFaceDescriptors — given as their text, the style engine's (`declText`) —
// read as its CSSOM rule's `style` would read them, without building the sheet around it (cascade.js `EngineFontFace`).
// Read-only: nothing a script holds reaches it.
globalThis.__csimFontFaceStyle = function (declText) {
  const holder = { _declText: String(declText) };
  return makeDeclProxy({ read: () => holder._declText, write: () => {}, kind: FONT_FACE_BLOCK, interface: 'CSSFontFaceDescriptors', owner: null });
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
// A rule and a sheet are their realm's (webidl.js `ownRealm`): an iframe's rule handed to this realm's
// `CSSStyleRule.prototype.selectorText` getter names a handle and a sheet id only its own realm's store holds, and what
// its member makes (rules, sheets) and tells (the cascade) is that realm's.
const REALM = {};
const installRule = (install, Rule, impl) => install(Rule, ownRealm(REALM, Rule.name, ruleOf, impl));
class CSSRule {
  constructor(token, handle, kind, parentStyleSheet, parentRule) {
    constructedBy(PLATFORM, token, new.target.name);
    makeSlots(this, 'CSSRule', { handle, kind, parentStyleSheet, parentRule, realm: REALM });
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
installRule(installCSSRule, CSSRule, {
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
  // (…a grouping rule a sheet no longer holds: its own list, in the sheet it was made in — the engine finds it)
  const answer = globalThis.__dom.ruleInsert(sheet ? sheetOf(sheet).id : -1, parent ? ruleOf(parent).handle : -1, text, index);
  if (typeof answer === 'string') throw new DOMException(`Failed to insert the rule: ${answer}`, answer);
  rules.splice(index, 0, makeRule(answer[0], answer[1], sheet, parent));
  if (answer.length > 2 && globalThis.__csimResolveSheetImports) globalThis.__csimResolveSheetImports(answer.slice(2), mode());
  rulesMoved();
  return index;
}
// CSSOM "remove a CSS rule": the removed rule is detached (`parentRule` / `parentStyleSheet` null).
function deleteRuleFrom(rules, sheet, parent, index) {
  const refused = globalThis.__dom.ruleDelete(sheet ? sheetOf(sheet).id : -1, parent ? ruleOf(parent).handle : -1, index);
  if (refused) throw new DOMException(`Failed to delete the rule: ${refused}`, refused);
  const [removed] = rules.splice(index, 1);
  if (removed) detachRule(removed);
  rulesMoved();
}
// …it, and what it holds: its rules, in no sheet now, and an `@import`'s sheet, imported by no rule (both engines).
function detachRule(rule) {
  const s = ruleOf(rule);
  s.parentStyleSheet = null;
  s.parentRule = null;
  if (s.rules) for (const child of s.rules) detachSheetOf(child);
  if (s.styleSheet) {
    const imported = sheetOf(s.styleSheet);
    imported.ownerRule = null;
    imported.parentStyleSheet = null;
  }
}
function detachSheetOf(rule) {
  const s = ruleOf(rule);
  s.parentStyleSheet = null;
  if (s.rules) for (const child of s.rules) detachSheetOf(child);
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
installRule(installCSSGroupingRule, CSSGroupingRule, {
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
installRule(installCSSConditionRule, CSSConditionRule, { get_conditionText: (rule) => conditionText(ruleOf(rule)) });
// A condition rule's condition, as the engine serializes it — an `@container`'s its conditions, joined as
// css-conditional-5 joins them.
function conditionText(s) {
  if (s.kind !== 'container') return ruleGet(s, 'condition') || '';
  return containerConditions(s).map(({ name, query }) => (name && query ? `${name} ${query}` : name + query)).join(', ');
}

// A rule's media list (`@media`, `@import`): read and written as the rule's (`ruleSet`).
const ruleMedia = (s) => (s.media ??= mediaListBinding.create(() => ruleGet(s, 'media') || '', (text) => { ruleSet(s, 'media', text); }));
class CSSMediaRule extends CSSConditionRule {}
installRule(installCSSMediaRule, CSSMediaRule, {
  get_media: (rule) => ruleMedia(ruleOf(rule)),
  // (…whether its media query list matches on the window's viewport, as the cascade applies it)
  get_matches: (rule) => mediaMatches(ruleGet(ruleOf(rule), 'media') || '', currentViewport())
});
class CSSSupportsRule extends CSSConditionRule {}
installRule(installCSSSupportsRule, CSSSupportsRule, {
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
installRule(installCSSContainerRule, CSSContainerRule, {
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
installRule(installCSSLayerBlockRule, CSSLayerBlockRule, { get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '' });
class CSSLayerStatementRule extends CSSRule {}
installRule(installCSSLayerStatementRule, CSSLayerStatementRule, {
  // (…a frozen array, the same one each time)
  get_nameList(rule) {
    const s = ruleOf(rule);
    return (s.names ??= Object.freeze((ruleGet(s, 'names') || '').split(',').filter(Boolean)));
  }
});
class CSSScopeRule extends CSSGroupingRule {}
installRule(installCSSScopeRule, CSSScopeRule, {
  get_start: (rule) => ruleGet(ruleOf(rule), 'start') || null,
  get_end: (rule) => ruleGet(ruleOf(rule), 'end') || null
});
class CSSStartingStyleRule extends CSSGroupingRule {}
installRule(installCSSStartingStyleRule, CSSStartingStyleRule, {});

// The declaration block of a rule (`rule.style`): every read and write is of the rule's own block (the decl ops' `rule`
// argument), its text — the block's serialization, kept until a write through it — only a key for what the reads
// memoize. Its kind (style-proxy.js `storeKind`) is what it may declare: a keyframe's and a page's properties, an
// `@font-face` rule's descriptors, and a style rule's properties for every other.
const BLOCK_KIND_OF_RULE = { 'keyframe': BLOCK_KIND.keyframe, 'page': BLOCK_KIND.page, 'margin': BLOCK_KIND.margin, 'font-face': FONT_FACE_BLOCK };
// (…and the interface it is: CSSStyleProperties but for a page rule's, a font face's and a position-try rule's. A
// margin rule's is typed a CSSStyleDeclaration, which a CSSStyleProperties is — the ED's CSSMarginDescriptors it
// names is defined nowhere yet — and css/cssom/idlharness.html holds it one.)
const STYLE_INTERFACE_OF_RULE = { 'page': 'CSSPageDescriptors', 'font-face': 'CSSFontFaceDescriptors', 'position-try': 'CSSPositionTryDescriptors' };
// (…the base URL its sheet parses against, a constructed one's `baseURL` included)
const ruleBase = (s) => (s.parentStyleSheet ? sheetOf(s.parentStyleSheet).base : null) ?? documentBaseUrl();
function ruleStyle(s) {
  return (s.style ??= makeDeclProxy({
    read:      () => s.blockText ??= globalThis.__dom.declText('', BLOCK_KIND_OF_RULE[s.kind] ?? 0, mode(), ruleBase(s), -1, s.handle),
    write:     (text) => { s.blockText = text; rulesMoved(); },
    kind:      BLOCK_KIND_OF_RULE[s.kind] ?? 0,
    interface: STYLE_INTERFACE_OF_RULE[s.kind] ?? 'CSSStyleProperties',
    rule:      () => s.handle,
    owner:     s.owner
  }));
}
const style = (rule) => ruleStyle(ruleOf(rule));
const selectorText = (rule) => ruleGet(ruleOf(rule), 'selector') || '';
// (…a selector the engine does not parse — an empty one included — leaves the rule as it was, CSSOM says)
const setSelectorText = (rule, v) => { ruleSet(ruleOf(rule), 'selector', v); };

class CSSStyleRule extends CSSGroupingRule {}
installRule(installCSSStyleRule, CSSStyleRule, { get_selectorText: selectorText, set_selectorText: setSelectorText, get_style: style });
class CSSPageRule extends CSSGroupingRule {}
installRule(installCSSPageRule, CSSPageRule, { get_selectorText: selectorText, set_selectorText: setSelectorText, get_style: style });
const MARGIN_RULE_NAMES = [
  'top-left-corner', 'top-left', 'top-center', 'top-right', 'top-right-corner', 'bottom-left-corner', 'bottom-left',
  'bottom-center', 'bottom-right', 'bottom-right-corner', 'left-top', 'left-middle', 'left-bottom', 'right-top',
  'right-middle', 'right-bottom'
];
class CSSMarginRule extends CSSRule {}
installRule(installCSSMarginRule, CSSMarginRule, {
  // (…its at-keyword's name, read off its text: `@top-left { … }` → "top-left")
  get_name(rule) {
    const name = (/^@([a-z-]+)/.exec(globalThis.__dom.ruleText(ruleOf(rule).handle) || '') || [])[1] || '';
    return MARGIN_RULE_NAMES.includes(name) ? name : '';
  },
  get_style: style
});
class CSSFontFaceRule extends CSSRule {}
installRule(installCSSFontFaceRule, CSSFontFaceRule, { get_style: style });
class CSSNestedDeclarations extends CSSRule {}
installRule(installCSSNestedDeclarations, CSSNestedDeclarations, { get_style: style });
class CSSPositionTryRule extends CSSRule {}
installRule(installCSSPositionTryRule, CSSPositionTryRule, { get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '', get_style: style });
class CSSKeyframeRule extends CSSRule {}
installRule(installCSSKeyframeRule, CSSKeyframeRule, {
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
installRule(installCSSKeyframesRule, CSSKeyframesRule, {
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

// The imported sheet, once it arrived — a sheet of its own for each `@import`, even two of one URL
// (cssimportrule-sheet-identity) — and null while it has none: its media list the rule's media (`ruleMedia`).
function importedSheet(s) {
  if (s.styleSheet === undefined) {
    const id = globalThis.__dom.importSheet(s.handle);
    s.styleSheet = id == null ? null : platformSheet(id, { ownerRule: s.owner, parentStyleSheet: s.parentStyleSheet, href: ruleGet(s, 'url'), mediaList: ruleMedia(s) });
  }
  return s.styleSheet;
}
class CSSImportRule extends CSSRule {}
installRule(installCSSImportRule, CSSImportRule, {
  get_href: (rule) => ruleGet(ruleOf(rule), 'href') || '',
  // (…its media query list the imported sheet's, the same object — and the rule's own while there is none)
  get_media(rule) {
    const s = ruleOf(rule), sheet = importedSheet(s);
    return sheet ? sheetOf(sheet).media : ruleMedia(s);
  },
  get_styleSheet: (rule) => importedSheet(ruleOf(rule)),
  get_layerName: (rule) => ruleGet(ruleOf(rule), 'layer'),
  get_supportsText: (rule) => ruleGet(ruleOf(rule), 'supports')
});
class CSSNamespaceRule extends CSSRule {}
installRule(installCSSNamespaceRule, CSSNamespaceRule, {
  get_namespaceURI: (rule) => ruleGet(ruleOf(rule), 'namespace') || '',
  get_prefix: (rule) => ruleGet(ruleOf(rule), 'prefix') || ''
});

// An `@counter-style` rule: each descriptor an attribute, written through the engine's own CSSOM checks — a value that
// does not parse, a name no counter style can have, another kind of system, symbols for an `extends` one, change
// nothing (css-counter-styles-3 §The CSSCounterStyleRule interface).
function counterStyleDescriptor(attribute) {
  const descriptor = attribute.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  return {
    [`get_${attribute}`]: (rule) => ruleGet(ruleOf(rule), descriptor) || '',
    [`set_${attribute}`](rule, v) { ruleSet(ruleOf(rule), descriptor, v); }
  };
}
class CSSCounterStyleRule extends CSSRule {}
installRule(installCSSCounterStyleRule, CSSCounterStyleRule, Object.assign({}, ...[
  'name', 'system', 'symbols', 'additiveSymbols', 'negative', 'prefix', 'suffix', 'range', 'pad', 'speakAs', 'fallback'
].map(counterStyleDescriptor)));

class CSSPropertyRule extends CSSRule {}
installRule(installCSSPropertyRule, CSSPropertyRule, {
  get_name: (rule) => ruleGet(ruleOf(rule), 'name') || '',
  get_syntax: (rule) => ruleGet(ruleOf(rule), 'syntax') || '',
  get_inherits: (rule) => ruleGet(ruleOf(rule), 'inherits') === 'true',
  get_initialValue: (rule) => ruleGet(ruleOf(rule), 'initial') ?? null
});
class CSSFontPaletteValuesRule extends CSSRule {}
installRule(installCSSFontPaletteValuesRule, CSSFontPaletteValuesRule, {
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
installRule(installCSSFontFeatureValuesRule, CSSFontFeatureValuesRule, Object.assign({
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
// The kinds of rule a CSSGroupingRule is, which hold rules of their own.
const GROUPING_KINDS = new Set();
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
  for (const kind of kindsOf.get(CSSGroupingRule)) GROUPING_KINDS.add(kind);
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
installStyleSheet(StyleSheet, ownRealm(REALM, 'StyleSheet', (o) => sheetOf(o), {
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
}));

class CSSStyleSheet extends StyleSheet {
  // `new CSSStyleSheet(options)`: a CONSTRUCTED sheet, the only kind `replace` / `replaceSync` accept, which takes no
  // `@import` — a sheet of the engine's own, empty until it is given text, and let go of with this object.
  constructor() {
    const [options] = convertCSSStyleSheetArguments(arguments);
    super();
    // (CSSOM "create a constructed CSSStyleSheet": its location the document's base URL, its stylesheet base URL the
    // `baseURL` given, parsed against that — one that fails to parse, e.g. `https://test:test/` with its non-numeric
    // port, a NotAllowedError — and its media a string given or a MediaList's text)
    const href = documentBaseUrl();
    let base = href;
    if (options.baseURL !== null) {
      try { base = new URL(options.baseURL, href).href; }
      catch (_) { throw new DOMException("Failed to construct 'CSSStyleSheet': Constructing a constructed stylesheet with an invalid base URL is not allowed.", 'NotAllowedError'); }
    }
    const id = globalThis.__dom.sheetMake('', base, '', true, mode())[0];
    SHEET_DROPS.register(this, id);
    const media = typeof options.media === 'string' ? options.media : slotsOf(options.media, brandKey('MediaList')).read();
    // (…its constructor document: the document whose realm made it, the one it may be adopted into)
    initSheet(this, id, { href, base, media, disabled: options.disabled, constructorDocument: globalThis.document });
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
// A constructed sheet made of `text` (its `@import`s ignored, as the engine parses a constructed sheet); any other — or
// one a `replace` is still making of new text (its disallow modification flag) — a NotAllowedError, as an insertion or
// a removal is then.
function checkModifiable(s, member) {
  if (s.disallowModification) throw new DOMException(`Failed to execute '${member}' on 'CSSStyleSheet': Can't modify the stylesheet while a replace() is pending.`, 'NotAllowedError');
}
function replaceSheet(s, text, member) {
  if (s.constructorDocument === null) throw new DOMException(`Failed to execute '${member}' on 'CSSStyleSheet': Can't call ${member} on non-constructed CSSStyleSheets.`, 'NotAllowedError');
  checkModifiable(s, member);
  return () => {
    globalThis.__dom.sheetReplace(s.id, text, s.base, '', true, mode());
    s.replaced++;
    rulesMoved();
  };
}
installCSSStyleSheet(CSSStyleSheet, ownRealm(REALM, 'CSSStyleSheet', (o) => sheetOf(o), {
  get_ownerRule: (sheet) => sheetOf(sheet).ownerRule,
  get_cssRules: (sheet) => { const s = sheetOf(sheet); sheetRules(s); return s.ruleList; },
  get_rules: (sheet) => { const s = sheetOf(sheet); sheetRules(s); return s.ruleList; },
  insertRule(sheet, text, index) {
    const s = sheetOf(sheet);
    checkModifiable(s, 'insertRule');
    return insertRuleInto(sheetRules(s), sheet, null, text, index);
  },
  deleteRule(sheet, index) {
    const s = sheetOf(sheet);
    checkModifiable(s, 'deleteRule');
    deleteRuleFrom(sheetRules(s), sheet, null, index);
  },
  // (…the legacy addRule: the rule `selector { style }` inserted at `index`, the end by default — and -1)
  addRule(sheet, selector, block, index) {
    const s = sheetOf(sheet), rules = sheetRules(s);
    checkModifiable(s, 'addRule');
    insertRuleInto(rules, sheet, null, `${selector} { ${block === '' ? '' : block + ' '}}`, index ?? rules.length);
    return -1;
  },
  removeRule(sheet, index) {
    const s = sheetOf(sheet);
    checkModifiable(s, 'removeRule');
    deleteRuleFrom(sheetRules(s), sheet, null, index);
  },
  // (…`replace` making it of the text a task later, modification refused until then; `replaceSync` at once)
  replace(sheet, text) {
    const s = sheetOf(sheet), made = replaceSheet(s, text, 'replace');
    s.disallowModification = true;
    return new IntrinsicPromise((resolve) => {
      queueTask(() => {
        made();
        s.disallowModification = false;
        resolve(sheet);
      });
    });
  },
  replaceSync(sheet, text) { replaceSheet(sheetOf(sheet), text, 'replaceSync')(); }
}));

// A sheet object's state: the engine's sheet `id`, its location and the base URL it was parsed against, and the media
// list it applies under (a write reaches the engine's sheet: `sheetMedia`).
function initSheet(sheet, id, { href = null, base = href, media = '', mediaList = null, disabled = false, ownerNode = null, ownerRule = null, parentStyleSheet = null, constructorDocument = null }) {
  const rules = [];
  makeSlots(sheet, 'StyleSheet');
  const s = makeSlots(sheet, 'CSSStyleSheet', {
    realm: REALM,
    id,
    href,
    base,
    disallowModification: false,
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
  // (…an `@import`ed one's the rule's media list, `mediaList`)
  s.media = mediaList ?? mediaListBinding.create(() => s.mediaText, (text) => {
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
  CSSStyleDeclaration, CSSStyleProperties, CSSPageDescriptors, CSSFontFaceDescriptors, CSSPositionTryDescriptors,
  CSSRule, CSSStyleRule, CSSGroupingRule, CSSConditionRule, CSSMediaRule, CSSSupportsRule, CSSContainerRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSScopeRule, CSSStartingStyleRule, CSSImportRule,
  CSSNamespaceRule, CSSFontFaceRule, CSSPageRule, CSSMarginRule, CSSKeyframeRule, CSSKeyframesRule,
  CSSCounterStyleRule, CSSPropertyRule, CSSFontPaletteValuesRule, CSSFontFeatureValuesRule, CSSFontFeatureValuesMap,
  CSSNestedDeclarations, CSSPositionTryRule, StyleSheet, CSSStyleSheet
]) {
  globalThis[iface.name] = iface;
}

// A sheet's `@font-face` rules in order, `visit(rule, base)` each with the URL its `src` resolves against — its sheet's
// base URL: into each `@import` that applies (the imported sheet's; `chain` guards a cycle) and each `@media` / `@supports`
// that holds, and every other grouping rule (`@layer`) — not a keyframes rule. Read off the rules' own state (cascade.js
// `fontFaceRulesOf`), which a page's patching of their getters does not reach.
export function faceRulesOf(sheet, base, vp, visit) {
  const s = sheetOf(sheet);
  walkFaceRules(sheetRules(s), s.base || base, 0, new Set(s.href ? [s.href] : []), vp, visit);
}
function walkFaceRules(rules, base, depth, chain, vp, visit) {
  if (depth > 32) return;
  for (const rule of rules) {
    const s = ruleOf(rule);
    switch (s.kind) {
      case 'font-face': visit(rule, base); break;
      case 'import': {
        const media = ruleGet(s, 'media'), supports = ruleGet(s, 'supports');
        if (media && !mediaMatches(media, vp)) break;
        if (supports && !globalThis.__dom.declSupportsCondition(supports)) break;
        const sheet = importedSheet(s);
        if (!sheet) break;
        const imported = sheetOf(sheet);
        if (imported.href && chain.has(imported.href)) break;   // a cycle: this sheet is already an ancestor
        if (imported.href) chain.add(imported.href);
        walkFaceRules(sheetRules(imported), imported.base || base, depth + 1, chain, vp, visit);
        if (imported.href) chain.delete(imported.href);
        break;
      }
      case 'media': if (mediaMatches(ruleGet(s, 'media') || '', vp)) walkFaceRules(childRules(s), base, depth + 1, chain, vp, visit); break;
      case 'supports': if (globalThis.__dom.declSupportsCondition(ruleGet(s, 'condition') || '')) walkFaceRules(childRules(s), base, depth + 1, chain, vp, visit); break;
      default: if (GROUPING_KINDS.has(s.kind)) walkFaceRules(childRules(s), base, depth + 1, chain, vp, visit);   // @layer blocks and the like
    }
  }
}

// The CSSStyleSheet of a `<style>` / `<link>` / `<?xml-stylesheet?>` — the engine's sheet `id` that the cascade
// made of it (cascade.js `engineSheetOf`) — under the owner's `media`.
// The engine's sheet lives as long as the object does, once one shows it (cascade.js `engineSheetOf`).
export function ownedStyleSheet(id, owner, { href = null, media = '' } = {}) {
  const sheet = platformSheet(id, { href, media, ownerNode: owner });
  SHEET_DROPS.register(sheet, id);
  return sheet;
}
