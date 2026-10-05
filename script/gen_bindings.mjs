// Generate the JS bindings of the interfaces the driver implements from their Web IDL (@webref/idl, the curated IDL of
// every web platform spec): per interface a `define<Name>(impl)` that makes its interface object — its members' argument
// counts, the conversion of each argument to its IDL type, the brand check of `this`, its constants, its class string,
// its indexed getter, stringifier and iterator — and hands the converted values to the implementation, `impl`, whose
// functions take the object first. Per callback interface, its legacy callback interface object and the call of each of
// its operations on a user object. What an interface does is its implementation's; the binding is what IDL says of it.
//
//   node script/gen_bindings.mjs           # write lib/capybara/simulated/js/src/generated/bindings.js
//   node script/gen_bindings.mjs --check   # fail where the written file is not what the IDL makes now
//
// An interface is generated once listed in INTERFACES; a construct of IDL no binding here makes yet is an error, not a
// silent gap.

import { parseAll } from '@webref/idl';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'lib', 'capybara', 'simulated', 'js', 'src', 'generated', 'bindings.js');

// The interfaces generated, by spec. `install`: an interface whose objects a hand-written class makes, its members
// generated onto that class's prototype (`install<Name>(iface, impl)`) — the class, its constructor and the objects it
// makes stay the hand-written code's, which registers the test that tells its objects apart. `omit`: what another spec
// adds to it that no implementation here answers yet, and why — a mixin it includes, by name; a partial interface of
// it, or a partial of a mixin it includes, by the spec's name. Anything else added is merged. `omitMembers`: single
// members no implementation answers, by name (and why). `namedProperties`: how an installed interface's objects answer
// its named property getter themselves (a Proxy of the class's).
const INTERFACES = [
  ['dom', 'DOMTokenList'],
  ['dom', 'NodeFilter'],
  ['dom', 'NodeIterator'],
  ['dom', 'TreeWalker'],
  ['dom', 'Node', { install: true }],
  ['dom', 'CharacterData', { install: true }],
  ['dom', 'Text', { install: true, omit: { GeometryUtils: 'getBoxQuads / convert*FromNode (cssom-view) are not implemented' } }],
  ['dom', 'Comment', { install: true }],
  ['dom', 'CDATASection', { install: true }],
  ['dom', 'ProcessingInstruction', { install: true }],
  ['dom', 'DocumentType', { install: true }],
  ['dom', 'Attr', { install: true }],
  ['dom', 'DocumentFragment', { install: true }],
  ['dom', 'Element', {
    install: true,
    omit: {
      'container-timing': 'containertiming / containertimingIgnore: Container Timing is not implemented',
      'css-nav': 'spatial navigation is not implemented',
      'css-pseudo': 'pseudo(): CSSPseudoElement is not implemented',
      'css-typed-om': 'computedStyleMap(): the Typed OM is not implemented',
      'css-view-transitions': 'startViewTransition / activeViewTransition: View Transitions are not implemented',
      'element-timing': 'elementTiming: Element Timing is not implemented',
      pointerlock: 'requestPointerLock: Pointer Lock is not implemented',
      'sanitizer-api': 'setHTML: the Sanitizer API is not implemented',
      Region: 'regionOverset / getRegionFlowRanges: CSS Regions are not implemented',
      GeometryUtils: 'getBoxQuads / convert*FromNode (cssom-view) are not implemented',
      ARIANotifyMixin: 'ariaNotify: no accessibility tree to announce to'
    },
    omitMembers: {
      currentCSSZoom: 'the effective zoom is not computed',
      requestFullscreen: 'no fullscreen'
    }
  }],
  ['dom', 'Document', {
    install: true,
    namedProperties: 'the DocumentNamedProps Proxy spliced into its prototype chain (dom-nodes.js)',
    omit: {
      SVG: 'rootElement: the SVG document is not modelled',
      'css-regions': 'namedFlows: CSS Regions are not implemented',
      'css-view-transitions': 'startViewTransition / activeViewTransition: View Transitions are not implemented',
      GeometryUtils: 'getBoxQuads / convert*FromNode (cssom-view) are not implemented',
      'font-metrics-api': 'measureElement / measureText: the Font Metrics API is not implemented',
      'permissions-policy': 'permissionsPolicy: Permissions Policy is not implemented',
      'sanitizer-api': 'parseHTML: the Sanitizer API is not implemented',
      'scroll-to-text-fragment': 'fragmentDirective: text fragments are not implemented',
      'trust-token-api': 'hasPrivateToken / hasRedemptionRecord: Private State Tokens are not implemented',
      ARIANotifyMixin: 'ariaNotify: no accessibility tree to announce to'
    },
    omitMembers: {
      caretPositionFromPoint: 'CaretPosition is not implemented',
      fullscreenEnabled: 'no fullscreen',
      fullscreen: 'no fullscreen',
      parseHTMLUnsafe: 'a static operation: not generated yet',
      all: 'HTMLAllCollection is not implemented',
      wasDiscarded: 'no discarding is modelled (Page Lifecycle)',
      pictureInPictureEnabled: 'no Picture-in-Picture',
      prerendering: 'no prerendering'
    }
  }],
  ['dom', 'ShadowRoot', { install: true, omit: { 'sanitizer-api': 'setHTML: the Sanitizer API is not implemented' } }]
];

// What the generated code imports from the runtime (webidl.js).
const RUNTIME = [
  'PLATFORM', 'EMPTY_DICTIONARY', 'rejectedPromise', 'brandKey', 'makeSlots', 'slotsOf', 'thisOf', 'thisIs', 'required', 'constructedBy', 'registerInterface', 'interfaceCheck',
  'toDOMString', 'toUSVString', 'toEnum', 'enumValue', 'toBoolean', 'toUnsignedShort', 'toUnsignedLong', 'toLong', 'toDouble',
  'toUnrestrictedDouble', 'toSequence', 'toObject', 'toInterface', 'toCallbackInterface', 'callUserObjectOperation', 'legacyCallbackInterfaceObject',
  'defineConstants', 'withIndexedGetter', 'defineValueIterator', 'defineClassString', 'enumerable', 'installMembers',
  'defineLength', 'defineUnscopables', 'unforgeableMembers'
];

const all = await parseAll();
// Every interface, callback interface, mixin and dictionary of every spec, by name: what an interface type, an
// `includes` or a dictionary type names. And what adds to one beside its definition — a mixin it includes, a partial
// of it — by the name of the mixin, or the spec of the partial.
const definitions = new Map(), mixins = new Map(), dictionaries = new Map(), typedefs = new Map(), enums = new Map();
const additions = new Map();
const add = (to, addition) => additions.set(to, [...(additions.get(to) || []), addition]);
for (const [spec, defs] of Object.entries(all)) {
  for (const d of defs) {
    if ((d.type === 'interface' || d.type === 'callback interface') && !d.partial) definitions.set(d.name, d);
    if (d.type === 'interface mixin' && !d.partial) mixins.set(d.name, d);
    if (d.type === 'dictionary' && !d.partial) dictionaries.set(d.name, d);
    if (d.type === 'typedef') typedefs.set(d.name, d.idlType);
    if (d.type === 'enum') enums.set(d.name, d.values.map((v) => v.value));
    if (d.type === 'includes') add(d.target, { mixin: d.includes });
    if ((d.type === 'interface' || d.type === 'interface mixin' || d.type === 'dictionary') && d.partial) add(d.name, { partial: spec, def: d });
  }
}

// The extended attributes a binding here makes what IDL says of, by where they stand; any other is an error.
// [CEReactions]: an implementation's writes run their reactions as each returns (handleAttributeChanges) — which is
// the operation's return where it writes once, as every one generated here does. [Reflect]: the implementation reflects
// the content attribute. [SameObject] / [NewObject]: what the implementation returns. [Exposed]: the global the
// interface object is put on, the Window's here. [SecureContext]: exposed, every realm here being a secure context
// (`isSecureContext`, platform-globals.js). The rest the generator makes as Web IDL says.
const HANDLED = {
  interface: ['Exposed', 'SecureContext'],
  member: [
    'SameObject', 'NewObject', 'CEReactions', 'Unscopable', 'PutForwards', 'Reflect', 'SecureContext', 'LegacyLenientSetter',
    'LegacyUnforgeable', 'LegacyLenientThis'
  ],
  type: ['LegacyNullToEmptyString']
};
function checkExtAttrs(extAttrs, where, label) {
  for (const e of extAttrs || []) {
    if (!HANDLED[where].includes(e.name)) throw new Error(`${label}: no binding makes [${e.name}] yet`);
  }
}

// What a conversion's TypeError says, by where the value comes from (Chrome's messages): an operation's argument
// (`index`, from 0), or an attribute's value.
// A conversion's TypeError message, as the JS expression of a string — Chrome's: the member's prefix, and in a
// dictionary's member, the dictionary member's after the prefix of what converts the dictionary (`prefix`, at run
// time) — then `text`.
function failure(where, text = '') {
  if (where.dictionary) return `prefix + ${JSON.stringify(`Failed to read the '${where.member}' property from '${where.dictionary}': ${text}`)}`;
  return JSON.stringify((where.index === undefined
    ? `Failed to set the '${where.member}' property on '${where.iface}': `
    : `Failed to execute '${where.member}' on '${where.iface}': `) + text);
}
function conversionError(where, what) {
  return failure(where, where.index === undefined
    ? `Failed to convert value to '${what}'.`
    : `parameter ${where.index + 1} is not of type '${what}'.`);
}

// The JS of converting `expr` to the IDL type `t` (an argument's, an attribute's), and the interfaces whose objects it
// takes, into `checks`.
// `extAttrs` are those on the type and, for an argument, the argument's own (where webidl2 puts `[EnforceRange] long x`'s).
function conversion(t, expr, where, checks, argExtAttrs = []) {
  const label = `${where.iface ?? where.dictionary}.${where.member}`;
  if (t.union) return unionConversion(t, expr, where, checks, argExtAttrs);
  const typedef = !t.generic && typedefs.get(t.idlType);
  if (typedef) return conversion(typeOf(typedef, t), expr, where, checks, argExtAttrs);
  if (t.generic === 'sequence' || t.generic === 'FrozenArray' || t.generic === 'ObservableArray') {
    // (Web IDL §3.2.21, §3.2.27, §3.2.28: the values its iterator gives, each converted; a frozen array frozen; an
    // observable array's setter given them, which its implementation's backing list is set to)
    const each = conversion(t.idlType[0], 'x', where, checks);
    const c = `toSequence(${expr}, (x) => ${each}, ${failure(where)})`;
    const value = t.generic === 'FrozenArray' ? `Object.freeze(${c})` : c;
    return t.nullable ? `(${expr} == null ? null : ${value})` : value;
  }
  if (t.generic) throw new Error(`${label}: no binding converts ${JSON.stringify(t.idlType)} yet`);
  const extAttrs = [...(t.extAttrs || []), ...argExtAttrs];
  checkExtAttrs(extAttrs, 'type', label);
  const legacyNull = extAttrs.some((e) => e.name === 'LegacyNullToEmptyString');
  let c;
  switch (t.idlType) {
    // (…CSSOMString, which CSSOM lets an implementation make either string type, DOMString — as Chrome does)
    case 'CSSOMString':
    case 'DOMString': c = `toDOMString(${expr}, ${legacyNull}, ${failure(where)})`; break;
    case 'USVString': c = `toUSVString(${expr}, ${failure(where)})`; break;
    case 'boolean': c = `toBoolean(${expr})`; break;
    case 'unsigned short': c = `toUnsignedShort(${expr}, ${failure(where)})`; break;
    case 'unsigned long': c = `toUnsignedLong(${expr}, ${failure(where)})`; break;
    case 'long': c = `toLong(${expr}, ${failure(where)})`; break;
    case 'double': c = `toDouble(${expr}, ${failure(where)})`; break;
    case 'unrestricted double': c = `toUnrestrictedDouble(${expr}, ${failure(where)})`; break;
    case 'any': c = expr; break;
    case 'object': c = `toObject(${expr}, ${conversionError(where, 'object')})`; break;
    default: {
      const def = definitions.get(t.idlType);
      if (ABSENT_INTERFACES.has(t.idlType)) {
        c = `(() => { throw new TypeError(${conversionError(where, t.idlType)}); })()`;
      } else if (def && def.type === 'interface') {
        checks.add(t.idlType);
        c = `toInterface(${expr}, IS_${t.idlType}, ${conversionError(where, t.idlType)})`;
      } else if (def && def.type === 'callback interface') {
        c = `toCallbackInterface(${expr}, ${conversionError(where, 'Object')})`;
      } else if (enums.has(t.idlType)) {
        // (…a string the enumeration has: Chrome's message for one it has not)
        const values = enums.get(t.idlType);
        c = `toEnum(${expr}, ${JSON.stringify(values)}, ${JSON.stringify(t.idlType)}, ${failure(where)})`;
      } else if (dictionaries.has(t.idlType)) {
        c = `${dictionaryConverter(t.idlType)}(${expr}, ${failure(where)})`;
      } else {
        throw new Error(`${label}: no binding converts ${t.idlType} yet`);
      }
    }
  }
  return t.nullable ? `(${expr} == null ? null : ${c})` : c;
}

// Interfaces of specs no implementation here answers, which no value is an object of — a union member of one is
// none (Trusted Types: with no policy, the string a page passes is what the API takes), a dictionary member of one
// no member, and anything else converted to one no such object: the Typed OM's values, Animation Triggers'.
const ABSENT_INTERFACES = new Set([
  'TrustedHTML', 'TrustedScript', 'TrustedScriptURL', 'CSSNumericValue', 'CSSKeywordValue', 'AnimationTrigger'
]);

// The type `t` names `u` as: `u`, with `t`'s extended attributes besides its own and nullable if either is. (Its
// fields read off it: webidl2's types answer them by getters, which a spread would drop.)
function typeOf(u, t) {
  return { idlType: u.idlType, union: u.union, generic: u.generic, extAttrs: [...(u.extAttrs || []), ...(t.extAttrs || [])], nullable: u.nullable || t.nullable };
}

// A union's flattened member types (Web IDL §2.13.32), its typedefs expanded and its absent interfaces dropped, none
// nullable — and whether it includes a nullable type, which one of them, or a union among them, was.
function flattenUnion(t) {
  let includesNullable = !!t.nullable;
  const flatten = (u) => {
    const def = !u.union && typedefs.get(u.idlType);
    const type = def ? typeOf(def, u) : u;
    if (type.nullable) includesNullable = true;
    return type.union ? type.idlType.flatMap(flatten) : [{ ...typeOf(type, {}), nullable: false }];
  };
  const members = t.idlType.flatMap(flatten).filter((u) => !ABSENT_INTERFACES.has(u.idlType));
  return { members, includesNullable };
}

// A union's conversion (Web IDL §3.2.25), for unions of interfaces, a dictionary, a string, a numeric type and boolean:
// null or undefined null where it includes a nullable type, else the dictionary's; an object of one of its interfaces
// as it is; any other object the dictionary's; a boolean or a number as itself where its type is a member; then the
// string type's conversion, else the numeric type's, else boolean's — and with none of them, a TypeError. A union
// that is one type once its absent interfaces are dropped is that type's conversion. Its extended attributes, and the
// argument's, are each member's.
const NUMERIC_TYPES = new Set(['unsigned short', 'unsigned long', 'long', 'double', 'unrestricted double']);
function unionConversion(t, expr, where, checks, argExtAttrs) {
  const label = `${where.iface ?? where.dictionary}.${where.member}`;
  const { members, includesNullable } = flattenUnion(t);
  const extAttrs = [...(t.extAttrs || []), ...argExtAttrs];
  if (members.length === 1) return conversion({ ...typeOf(members[0], { extAttrs }), nullable: includesNullable }, expr, where, checks);
  const name = `(${members.map((u) => u.generic ? `${u.generic}<…>` : u.idlType).join(' or ')})`;
  const unsupported = () => new Error(`${label}: no binding converts ${name} yet`);
  if (members.some((u) => u.generic)) throw unsupported();
  const of = (test) => members.filter(test);
  const ifaces = of((u) => definitions.get(u.idlType)?.type === 'interface');
  const dicts = of((u) => dictionaries.has(u.idlType));
  const strings = of((u) => ['DOMString', 'USVString'].includes(u.idlType));
  const numerics = of((u) => NUMERIC_TYPES.has(u.idlType));
  const booleans = of((u) => u.idlType === 'boolean');
  if (dicts.length > 1 || strings.length > 1 || numerics.length > 1 || ifaces.length + dicts.length + strings.length + numerics.length + booleans.length !== members.length) throw unsupported();
  const [dict] = dicts, [string] = strings, [numeric] = numerics, [boolean] = booleans;
  const convert = (u) => conversion(u, expr, where, checks, extAttrs);
  // (…the last conversion, which takes what no step before it did — so no step of its own)
  const last = string || numeric || boolean;
  const steps = [];
  if (includesNullable) steps.push([`${expr} == null`, 'null']);
  if (dict) steps.push([`${expr} == null`, convert(dict)]);
  for (const u of ifaces) {
    checks.add(u.idlType);
    steps.push([`IS_${u.idlType}(${expr})`, expr]);
  }
  if (dict) steps.push([`(typeof ${expr} === 'object' || typeof ${expr} === 'function')`, convert(dict)]);
  if (boolean && boolean !== last) steps.push([`typeof ${expr} === 'boolean'`, expr]);
  if (numeric && numeric !== last) steps.push([`typeof ${expr} === 'number'`, convert(numeric)]);
  const otherwise = last ? convert(last) : `(() => { throw new TypeError(${conversionError(where, name)}); })()`;
  return `(${steps.map(([test, value]) => `${test} ? ${value} : `).join('')}${otherwise})`;
}

// A dictionary's conversion (Web IDL §3.2.17): a function of its own, written once beside the interfaces — undefined
// or null an empty dictionary, any other non-object a TypeError; each member, its inherited dictionaries' first and
// each's (its partials' included) in lexicographic order, got from the object, converted, or its default where it is
// undefined (a required one missing a TypeError). Its messages follow `prefix`, what converts the dictionary's.
const dictionaryConverters = new Map();
function dictionaryConverter(name) {
  const fn = `to${name}`;
  if (dictionaryConverters.has(name)) return fn;
  dictionaryConverters.set(name, null);
  const chain = [];
  for (let d = dictionaries.get(name); d; d = d.inheritance && dictionaries.get(d.inheritance)) {
    if (d.inheritance && !dictionaries.has(d.inheritance)) throw new Error(`${d.name}: inherits ${d.inheritance}, which no spec defines`);
    chain.unshift(d);
  }
  const checks = new Set(), lines = [];
  let defaults = false;
  lines.push(`export function ${fn}(v, prefix) {`);
  lines.push(`  if (v !== undefined && v !== null && typeof v !== 'object' && typeof v !== 'function') throw new TypeError(prefix + ${JSON.stringify(`The provided value is not of type '${name}'.`)});`);
  const head = lines.length;
  lines.push(`  const dict = {};`);
  for (const d of chain) {
    // (…its partials' members among its own — but one whose type is an interface no implementation here answers, which is
    // no member here: `{trigger: x}` ignored, as in a browser without Animation Triggers)
    const members = [...d.members, ...(additions.get(d.name) || []).flatMap((a) => a.def.members)]
      .filter((m) => !(!m.idlType.union && ABSENT_INTERFACES.has(m.idlType.idlType)));
    for (const m of members.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const where = { dictionary: d.name, member: m.name };
      lines.push(`  {`);
      lines.push(`    const x = v == null ? undefined : v.${m.name};`);
      const missing = m.required ? `(() => { throw new TypeError(${failure(where, 'Required member is undefined.')}); })()`
        : m.default ? defaultValue(m.default, `${d.name}.${m.name}`) : null;
      if (missing !== null) defaults = true;
      const converted = conversion(m.idlType, 'x', where, checks, m.extAttrs);
      lines.push(missing === null
        ? `    if (x !== undefined) dict.${m.name} = ${converted};`
        : `    dict.${m.name} = x !== undefined ? ${converted} : ${missing};`);
      lines.push(`  }`);
    }
  }
  // (…the tests of the interfaces its members take, looked up as it converts — those are registered by then — and, for
  // a dictionary none of whose members has a default or is required, null or undefined the one empty dictionary: the
  // common call with no options allocates nothing)
  const lookups = [...checks].map((c) => `  const IS_${c} = interfaceCheck('${c}');`);
  lines.splice(head, 0, ...(defaults ? [] : ['  if (v == null) return EMPTY_DICTIONARY;']), ...lookups);
  lines.push(`  return dict;`);
  lines.push(`}`);
  dictionaryConverters.set(name, lines.join('\n'));
  return fn;
}

function constantValue(m, where) {
  if (m.value.type !== 'number') throw new Error(`${where}: no binding gives a constant of ${m.value.type} yet`);
  return m.value.value;
}

// An interface's members: its own, those of the mixins it includes, and those of the partials of either — but what
// `omit` and `omitMembers` name (and why). What no binding here makes of a definition yet, beside its members, is an
// error, as is an omission of something nothing adds.
function membersOf(def, omit = {}, omitMembers = {}) {
  const omitted = new Set();
  const gather = (d) => {
    checkExtAttrs(d.extAttrs, 'interface', d.name);
    const found = [...d.members];
    for (const a of additions.get(d.name) || []) {
      const key = a.mixin || a.partial;
      if (Object.hasOwn(omit, key)) { omitted.add(key); continue; }
      if (a.partial) { found.push(...a.def.members); continue; }
      const mixin = mixins.get(a.mixin);
      if (!mixin) throw new Error(`${def.name}: includes ${a.mixin}, which no spec defines`);
      found.push(...gather(mixin));
    }
    return found;
  };
  const members = gather(def).filter((m) => {
    if (!Object.hasOwn(omitMembers, m.name)) return true;
    omitted.add(m.name);
    return false;
  });
  const unknown = [...Object.keys(omit), ...Object.keys(omitMembers)].filter((k) => !omitted.has(k));
  if (unknown.length) throw new Error(`${def.name}: omits ${unknown.join(', ')}, which nothing adds to it`);
  for (const m of members) checkExtAttrs(m.extAttrs, 'member', `${def.name}.${m.name || m.type}`);
  return members;
}

function generateInterface(def, options = {}) {
  const name = def.name;
  if (def.inheritance && !options.install) throw new Error(`${name}: an inherited interface is not generated yet`);
  const members = [], constants = [], body = [], unforgeables = [], checks = new Set(), unscopables = [], handlers = [];
  // (…`this` checked: by its brand where the binding makes the object, by the test its class registered where it is
  // installed on that class)
  // (…`prefix` the message's, for an operation whose TypeError becomes its promise's rejection)
  const selfCheck = (prefix) => {
    const message = prefix ? `, ${JSON.stringify(prefix)}` : '';
    return options.install ? `thisIs(this, IS_SELF${message})` : `thisOf(this, KEY${message})`;
  };
  const self = selfCheck();
  let indexed = null, valueIterator = false, stringifier = null, constructor = null;
  const memberList = membersOf(def, options.omit, options.omitMembers);
  for (const m of memberList) {
    const label = `${name}.${m.name || m.type}`;
    if ((m.extAttrs || []).some((e) => e.name === 'Unscopable')) unscopables.push(m.name);
    if (m.type === 'constructor') { constructor = m; continue; }
    if (m.type === 'const') { constants.push([m.name, constantValue(m, label)]); continue; }
    if (m.type === 'iterable') {
      if (m.idlType.length !== 1) throw new Error(`${label}: a pair iterator is not generated yet`);
      valueIterator = true;
      continue;
    }
    if (m.type === 'attribute' && EVENT_HANDLER_TYPES.has(m.idlType.idlType)) {
      // (…[LegacyLenientThis] or not: the installing class's accessors answer any `this`)
      handlers.push(m.name);
      continue;
    }
    if (m.type === 'attribute') {
      // ([LegacyUnforgeable], Web IDL §3.4.10: an own property of each object, which cannot be reconfigured)
      const out = (m.extAttrs || []).some((e) => e.name === 'LegacyUnforgeable') ? unforgeables : body;
      if (m.special === 'stringifier') stringifier = m.name;
      else if (m.special) throw new Error(`${label}: a ${m.special} attribute is not generated yet`);
      members.push(m.name);
      // (…[LegacyLenientThis] only an event handler's here, whose accessors the installing class's are)
      if ((m.extAttrs || []).some((e) => e.name === 'LegacyLenientThis')) throw new Error(`${label}: a [LegacyLenientThis] attribute is not generated yet`);
      out.push(`    get ${m.name}() { return impl.get_${m.name}(${self}); }`);
      const forwards = (m.extAttrs || []).find((e) => e.name === 'PutForwards');
      if (forwards) {
        // [PutForwards=x] (Web IDL §3.7.6): a write to the attribute is a write of `x` on the object it answers
        // (`el.classList = 'a b'` sets the list's `value`).
        // (…the object no object — a document's `location` with no window — a TypeError)
        const target = forwards.rhs.value;
        const notObject = JSON.parse(failure({ iface: name, member: m.name }, 'The attribute value is not an object'));
        out.push(`    set ${m.name}(v) { const object = impl.get_${m.name}(${self}); if (object === null || (typeof object !== 'object' && typeof object !== 'function')) throw new TypeError(${JSON.stringify(notObject)}); object.${target} = v; }`);
      } else if ((m.extAttrs || []).some((e) => e.name === 'LegacyLenientSetter')) {
        // [LegacyLenientSetter] (Web IDL §3.4.2): a read-only attribute with a setter that does nothing — but check its
        // `this` — so a page's own assignment to it (an old polyfill's) is no error
        out.push(`    set ${m.name}(v) { ${self}; }`);
      } else if (!m.readonly && enums.has(m.idlType.idlType)) {
        // (…an enumeration's: a string it has not is ignored, not an error — Web IDL §3.7.6)
        const value = `enumValue(v, ${JSON.stringify(enums.get(m.idlType.idlType))}, ${failure({ iface: name, member: m.name })})`;
        const v = m.idlType.nullable ? `v == null ? null : ${value}` : value;
        out.push(`    set ${m.name}(v) { const self = ${self}; const value = ${v}; if (value !== undefined) impl.set_${m.name}(self, value); }`);
      } else if (!m.readonly) {
        const v = conversion(m.idlType, 'v', { iface: name, member: m.name }, checks);
        out.push(`    set ${m.name}(v) { impl.set_${m.name}(${self}, ${v}); }`);
      }
      continue;
    }
    if (m.type === 'operation') {
      if (m.special === 'getter' && m.arguments.length === 1 && m.arguments[0].idlType.idlType === 'DOMString' && options.namedProperties) {
        // (…a named property getter the installing class's objects answer themselves: `namedProperties` says how)
        continue;
      }
      if (m.special === 'getter') {
        if (m.arguments.length !== 1 || m.arguments[0].idlType.idlType !== 'unsigned long') throw new Error(`${label}: only an indexed getter is generated`);
        indexed = m.name;
      } else if (m.special) {
        throw new Error(`${label}: a ${m.special} operation is not generated yet`);
      }
      if (!m.name) throw new Error(`${label}: an anonymous operation is not generated yet`);
      // (…an overloaded one written once, where its first overload stands)
      if (members.includes(m.name)) continue;
      members.push(m.name);
      const group = memberList.filter((o) => o.type === 'operation' && o.name === m.name);
      body.push(`    ${group.length > 1 ? overloadedOperation(name, group, checks, selfCheck) : operation(name, m, checks, selfCheck)}`);
      continue;
    }
    throw new Error(`${label}: a ${m.type} member is not generated yet`);
  }
  if (indexed && !members.includes('length')) throw new Error(`${name}: an indexed getter with no \`length\` is not generated yet`);
  if (stringifier) body.push(`    toString() { return impl.get_${stringifier}(${self}); }`);
  const enumerated = JSON.stringify([...new Set(members)].concat(stringifier ? ['toString'] : []));
  if (options.install) {
    if (indexed || valueIterator) throw new Error(`${name}: an installed interface with an indexed getter or an iterator is not generated yet`);
    return installInterface(def, { body, unforgeables, checks, unscopables, constructor, constants, handlers });
  }
  if (unforgeables.length) throw new Error(`${name}: [LegacyUnforgeable] members of an interface the binding makes are not generated yet`);
  if (handlers.length) throw new Error(`${name}: event handlers of an interface the binding makes are not generated yet`);
  if (constructor) throw new Error(`${name}: a constructor is not generated yet`);

  const lines = [];
  lines.push(`// interface ${name} (${def.spec})`);
  lines.push(`export function define${name}(impl) {`);
  lines.push(`  const KEY = brandKey('${name}');`);
  // (…registered before the interfaces its members take are looked up: those may be its own)
  lines.push(`  registerInterface('${name}', (o) => slotsOf(o, KEY) !== undefined);`);
  for (const c of checks) lines.push(`  const IS_${c} = interfaceCheck('${c}');`);
  lines.push(`  // (…made by the platform alone: the interface has no constructor)`);
  lines.push(`  class ${name} {`);
  lines.push(`    constructor(...args) {`);
  lines.push(`      constructedBy(PLATFORM, args[0], '${name}');`);
  lines.push(`      impl.init(makeSlots(this, KEY), ...args.slice(1));`);
  lines.push(`    }`);
  lines.push(...body);
  lines.push(`  }`);
  if (constants.length) {
    const list = JSON.stringify(constants.map(([n]) => n));
    lines.push(`  defineConstants(${name}, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
    lines.push(`  defineConstants(${name}.prototype, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
  }
  lines.push(`  defineClassString(${name}.prototype, '${name}');`);
  lines.push(`  enumerable(${name}.prototype, ${enumerated});`);
  if (unscopables.length) lines.push(`  defineUnscopables(${name}.prototype, ${JSON.stringify(unscopables)});`);
  if (valueIterator) {
    if (!indexed) throw new Error(`${name}: a value iterator with no indexed getter is not generated yet`);
    lines.push(`  defineValueIterator(${name}.prototype);`);
  }
  // …and its objects, as the platform makes them (`create(...state)`), exotic where it has an indexed getter.
  const make = indexed
    ? `withIndexedGetter(new ${name}(PLATFORM, ...state), (s, i) => impl.${indexed}(s, i), (s) => impl.get_length(s))`
    : `new ${name}(PLATFORM, ...state)`;
  lines.push(`  return { interface: ${name}, create: (...state) => ${make} };`);
  lines.push(`}`);
  return lines.join('\n');
}

// An installed interface: its members generated in a class of their own, then put on the prototype of the hand-written
// class (`iface`) that makes its objects — their names, lengths and conversions IDL's, enumerable; the interface
// object's `length` its constructor's required arguments; its class string and @@unscopables.
// …its [LegacyUnforgeable] members, own properties of each object, defined on one by the function it returns, which the
// class's constructor calls.
function installInterface(def, { body, unforgeables, checks, unscopables, constructor, constants, handlers }) {
  const name = def.name;
  const length = constructor ? constructor.arguments.filter((a) => !a.optional && !a.variadic).length : 0;
  const lines = [];
  lines.push(`// interface ${name}${def.inheritance ? ` : ${def.inheritance}` : ''} (${def.spec}), installed on the class that makes its objects`);
  lines.push(`export function install${name}(iface, impl) {`);
  lines.push(`  const IS_SELF = interfaceCheck('${name}');`);
  for (const c of checks) lines.push(`  const IS_${c} = interfaceCheck('${c}');`);
  lines.push(`  class Members {`);
  lines.push(...body);
  lines.push(`  }`);
  lines.push(`  installMembers(iface.prototype, Members.prototype);`);
  if (handlers.length) lines.push(`  impl.installEventHandlers(iface.prototype, ${JSON.stringify(handlers)});`);
  if (constants.length) {
    const list = JSON.stringify(constants.map(([n]) => n));
    lines.push(`  defineConstants(iface, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
    lines.push(`  defineConstants(iface.prototype, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
  }
  lines.push(`  defineLength(iface, ${length});`);
  lines.push(`  defineClassString(iface.prototype, '${name}');`);
  if (unscopables.length) lines.push(`  defineUnscopables(iface.prototype, ${JSON.stringify(unscopables)});`);
  if (unforgeables.length) {
    lines.push(`  class Unforgeables {`, ...unforgeables, `  }`);
    lines.push(`  return unforgeableMembers(Unforgeables.prototype);`);
  }
  lines.push(`}`);
  return lines.join('\n');
}

// An event handler IDL attribute's types (HTML §8.1.8.1): what it is, the same for each — its handler stored and
// called as the event loop's — the installing class's (events.js), handed the names.
const EVENT_HANDLER_TYPES = new Set(['EventHandler', 'OnErrorEventHandler', 'OnBeforeUnloadEventHandler']);

// The JS name of an argument: its IDL name, but where strict code reserves that (`interface`, `arguments`, …) or the
// generated code names something of its own by it (`self`, `impl`, a conversion it calls, … — CSSMathSum's
// constructor takes `args`).
const RESERVED = new Set([
  'self', 'impl', 'KEY', 'PLATFORM', 'x', 'v', 'callback', 'args', ...RUNTIME,
  'arguments', 'eval', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield',
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with'
]);
function argName(a) {
  return RESERVED.has(a.name) || a.name.startsWith('IS_') ? `${a.name}_` : a.name;
}

// An operation: its required arguments its parameters (so its `length` is their count, Web IDL §3.7.7), the optional
// ones read from `arguments`, a variadic one the rest — each converted, and handed to the implementation.
function operation(iface, m, checks, selfCheck) {
  const args = m.arguments;
  const requiredCount = args.filter((a) => !a.optional && !a.variadic).length;
  if (args.some((a, i) => (a.optional || a.variadic) && i < requiredCount)) throw new Error(`${iface}.${m.name}: a required argument after an optional one`);
  if (args.some((a) => a.optional) && args.some((a) => a.variadic)) throw new Error(`${iface}.${m.name}: an optional argument beside a variadic one is not generated yet`);
  const params = args.filter((a) => !a.optional).map((a) => (a.variadic ? `...${argName(a)}` : argName(a))).join(', ');
  const converted = convertArguments(iface, m, checks, (a) => (a.variadic || !a.optional ? argName(a) : null));
  // (…`this` checked first, then the arguments counted — Web IDL's order, as Chrome's)
  const check = requiredCount ? `required(arguments, ${requiredCount}, '${m.name}', '${iface}'); ` : '';
  const steps = `const self = ${selfCheck(promiseOf(m) && `Failed to execute '${m.name}' on '${iface}': `)}; ${check}return impl.${m.name}(${['self', ...converted].join(', ')});`;
  return `${m.name}(${params}) { ${promiseOf(m) ? rejecting(steps) : steps} }`;
}

// Whether an operation returns a promise — which every exception its steps throw rejects instead, `this` and argument
// conversions' included (Web IDL §3.7.7: "an exception … converted to a rejected promise").
const promiseOf = (m) => m.idlType && m.idlType.generic === 'Promise';
const rejecting = (steps) => `try { ${steps} } catch (e) { return rejectedPromise(e); }`;

// Each argument of `m` converted to its type: a required one read as `named(a)` gives it, an optional one from
// `arguments` (one passed as undefined is one not passed, Web IDL §3.6 — but a dictionary, or one defaulting to `{}`,
// is converted from undefined: its members' defaults), a variadic one the rest.
function convertArguments(iface, m, checks, named) {
  return m.arguments.map((a, i) => {
    const where = { iface, member: m.name, index: i };
    const expr = named(a) ?? `arguments[${i}]`;
    if (a.variadic) return `${expr}.map((x) => ${conversion(a.idlType, 'x', where, checks, a.extAttrs)})`;
    if (a.optional) {
      if (dictionaries.has(a.idlType.idlType) || a.default?.type === 'dictionary') return conversion(a.idlType, expr, where, checks, a.extAttrs);
      const missing = a.default ? defaultValue(a.default, `${iface}.${m.name}(${a.name})`) : 'undefined';
      return `(${expr} !== undefined ? ${conversion(a.idlType, expr, where, checks, a.extAttrs)} : ${missing})`;
    }
    return conversion(a.idlType, expr, where, checks, a.extAttrs);
  });
}

// An overloaded operation (Web IDL §3.6 overload resolution): the overload chosen by how many arguments were passed
// (no more than the longest takes), each one's arguments converted to its own types and handed to an implementation
// of its own — named for its arguments, `scroll_options` / `scroll_x_y`. Overloads that one count of arguments could
// call more than one of (told apart by their arguments' types) are not generated yet. Its `length` is the shortest
// overload's required arguments.
function overloadedOperation(iface, group, checks, selfCheck) {
  const name = group[0].name;
  const promise = group.some(promiseOf);
  if (promise && !group.every(promiseOf)) throw new Error(`${iface}.${name}: overloads returning a promise and not are not generated`);
  if (group.some((m) => m.arguments.some((a) => a.variadic))) throw new Error(`${iface}.${name}: an overload with a variadic argument is not generated yet`);
  const least = (m) => m.arguments.filter((a) => !a.optional).length;
  const most = Math.max(...group.map((m) => m.arguments.length));
  const cases = [];
  for (let n = 0; n <= most; n++) {
    const takers = group.filter((m) => least(m) <= n && n <= m.arguments.length);
    if (takers.length > 1) throw new Error(`${iface}.${name}: overloads told apart by their arguments' types are not generated yet`);
    if (takers.length) cases.push([n, takers[0]]);
  }
  const shortest = group.reduce((a, b) => (least(b) < least(a) ? b : a));
  const required = least(shortest);
  const params = shortest.arguments.slice(0, required).map(argName).join(', ');
  const implName = (m) => `${name}_${m.arguments.length ? m.arguments.map((a) => a.name).join('_') : 'none'}`;
  const lines = [`const self = ${selfCheck(promise && `Failed to execute '${name}' on '${iface}': `)};`];
  if (required) lines.push(`required(arguments, ${required}, '${name}', '${iface}');`);
  lines.push(`switch (Math.min(arguments.length, ${most})) {`);
  // (…the counts one overload takes falling through to its one call)
  cases.forEach(([n, m], i) => {
    if (i + 1 < cases.length && cases[i + 1][1] === m) { lines.push(`  case ${n}:`); return; }
    const converted = convertArguments(iface, m, checks, () => null);
    lines.push(`  case ${n}: return impl.${implName(m)}(${['self', ...converted].join(', ')});`);
  });
  // (…a count of arguments no overload takes: Chrome's message)
  if (cases.length < most - required + 1) {
    const arities = `Failed to execute '${name}' on '${iface}': Valid arities are: [${cases.map(([n]) => n).join(', ')}], but `;
    lines.push(`  default: throw new TypeError(${JSON.stringify(arities)} + arguments.length + ' arguments provided.');`);
  }
  lines.push(`}`);
  const body = promise ? ['try {', ...lines.map((l) => `  ${l}`), '} catch (e) {', '  return rejectedPromise(e);', '}'] : lines;
  return [`${name}(${params}) {`, ...body.map((l) => `      ${l}`), `    }`].join('\n');
}

function defaultValue(d, where) {
  switch (d.type) {
    case 'string': return JSON.stringify(d.value);
    case 'boolean': return String(d.value);
    case 'number': return String(d.value);
    case 'null': return 'null';
    case 'sequence': return '[]';
    default: throw new Error(`${where}: no binding gives a default of ${d.type} yet`);
  }
}

// A callback interface: its legacy callback interface object where it has constants (Web IDL §3.11.1) — no constructor,
// its constants on it — and the call of its operation on a user object, its result converted to the operation's type.
function generateCallbackInterface(def) {
  const name = def.name;
  membersOf(def);
  const constants = [], operations = [];
  for (const m of def.members) {
    const label = `${name}.${m.name || m.type}`;
    if (m.type === 'const') constants.push([m.name, constantValue(m, label)]);
    else if (m.type === 'operation' && !m.special && m.name) operations.push(m);
    else throw new Error(`${label}: a ${m.type} member of a callback interface is not generated yet`);
  }
  if (operations.length !== 1) throw new Error(`${name}: a callback interface of ${operations.length} operations is not generated yet`);
  const op = operations[0];
  if (op.idlType.idlType !== 'unsigned short' || op.idlType.nullable) throw new Error(`${name}.${op.name}: no binding converts a result of ${op.idlType.idlType} yet`);
  const params = op.arguments.map(argName).join(', ');
  const lines = [];
  lines.push(`// callback interface ${name} (${def.spec})`);
  lines.push(`export function define${name}() {`);
  if (constants.length) {
    lines.push(`  const ${name} = legacyCallbackInterfaceObject('${name}');`);
    lines.push(`  defineConstants(${name}, ${JSON.stringify(constants.map(([n]) => n))}, [${constants.map(([, v]) => v).join(', ')}]);`);
  } else {
    lines.push(`  const ${name} = null;`);
  }
  lines.push(`  // (…the user object's \`${op.name}\`, or the object itself where it is callable)`);
  lines.push(`  const ${op.name} = (callback, ${params}) => toUnsignedShort(callUserObjectOperation(callback, '${op.name}', [${params}], '${name}'));`);
  lines.push(`  return { interface: ${name}, ${op.name} };`);
  lines.push(`}`);
  return lines.join('\n');
}

// Names listed two-space indented, wrapped at 120 columns.
function wrap(names) {
  const lines = [''];
  for (const n of names) {
    const item = `${n}, `;
    if (2 + lines.at(-1).length + item.length > 121) lines.push('');
    lines[lines.length - 1] += item;
  }
  return lines.map((l) => `  ${l}`.trimEnd()).join('\n').replace(/,$/, '');
}

const parts = [];
for (const [spec, name, options] of INTERFACES) {
  const def = (all[spec] || []).find((d) => (d.type === 'interface' || d.type === 'callback interface') && d.name === name && !d.partial);
  if (!def) throw new Error(`${spec}: no interface ${name}`);
  def.spec = spec;
  parts.push(def.type === 'interface' ? generateInterface(def, options) : generateCallbackInterface(def));
}
// The members of the element interfaces whose objects are hand-written (Element and those that extend it for a
// namespace), by name — their own, their mixins' and partials': what puts a member on the interface that has it
// (dom-class-aliases.js), the hand-written classes keeping every element member on Element.
const MEMBER_INTERFACES = ['Element', 'HTMLElement', 'SVGElement', 'MathMLElement'];
function memberNames(name) {
  const names = new Set();
  const add = (d) => { for (const m of d.members) if (m.name && m.type !== 'constructor') names.add(m.name); };
  const gather = (d) => {
    add(d);
    for (const a of additions.get(d.name) || []) {
      if (a.partial) add(a.def);
      else if (mixins.has(a.mixin)) gather(mixins.get(a.mixin));
    }
  };
  gather(definitions.get(name));
  return [...names].sort();
}
// …and the interface each HTML element interface inherits: what its interface object extends.
const htmlParents = [...definitions.values()]
  .filter((d) => d.type === 'interface' && /^HTML\w*Element$/.test(d.name) && d.inheritance)
  .map((d) => [d.name, d.inheritance])
  .sort(([a], [b]) => (a < b ? -1 : 1));
// …and the event handlers of GlobalEventHandlers (its own and its partials'): what the hand-written element and window
// classes install, an element's as content attributes too.
const globalHandlers = [mixins.get('GlobalEventHandlers'), ...(additions.get('GlobalEventHandlers') || []).map((a) => a.def)]
  .flatMap((d) => d.members).filter((m) => m.type === 'attribute' && EVENT_HANDLER_TYPES.has(m.idlType.idlType)).map((m) => m.name);
const memberTable = `// The members of the element interfaces, by name (each one's own, its mixins' and partials').
export const INTERFACE_MEMBERS = {
${MEMBER_INTERFACES.map((n) => `  ${n}: ${JSON.stringify(memberNames(n))}`).join(',\n')}
};

// GlobalEventHandlers' event handler attributes.
export const GLOBAL_EVENT_HANDLERS = ${JSON.stringify(globalHandlers)};

// The interface each HTML element interface inherits.
export const HTML_INTERFACE_PARENTS = {
${htmlParents.map(([n, p]) => `  ${n}: '${p}'`).join(',\n')}
};`;

const dictionaryParts = [...dictionaryConverters.values()];
const source = `// GENERATED by script/gen_bindings.mjs from @webref/idl — do not edit; run \`node script/gen_bindings.mjs\`.
// The bindings of the interfaces the driver implements: what Web IDL says of each, its implementation handed the
// converted values (webidl.js is their runtime).

import {
${wrap(RUNTIME)}
} from '../webidl.js';

${[...dictionaryParts, ...parts, memberTable].join('\n\n')}
`;

if (process.argv.includes('--check')) {
  const written = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (written !== source) {
    console.error('generated/bindings.js is not what the IDL makes now — run `node script/gen_bindings.mjs`');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, source);
}
