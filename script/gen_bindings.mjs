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
// it, or a partial of a mixin it includes, by the spec's name. Anything else added is merged.
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
  ['dom', 'DocumentFragment', { install: true }]
];

// What the generated code imports from the runtime (webidl.js).
const RUNTIME = [
  'PLATFORM', 'brandKey', 'makeSlots', 'slotsOf', 'thisOf', 'thisIs', 'required', 'constructedBy', 'registerInterface', 'interfaceCheck',
  'toDOMString', 'toUSVString', 'toBoolean', 'toUnsignedShort', 'toUnsignedLong', 'toLong', 'toDouble',
  'toUnrestrictedDouble', 'toInterface', 'toCallbackInterface', 'callUserObjectOperation', 'legacyCallbackInterfaceObject',
  'defineConstants', 'withIndexedGetter', 'defineValueIterator', 'defineClassString', 'enumerable', 'installMembers',
  'defineLength', 'defineUnscopables'
];

const all = await parseAll();
// Every interface, callback interface and mixin of every spec, by name: what an interface type, or an `includes`,
// names. And what adds to an interface or a mixin beside its definition — a mixin it includes, a partial of it — by
// the name of the mixin, or the spec of the partial.
const definitions = new Map(), mixins = new Map(), dictionaries = new Map(), additions = new Map();
const add = (to, addition) => additions.set(to, [...(additions.get(to) || []), addition]);
for (const [spec, defs] of Object.entries(all)) {
  for (const d of defs) {
    if ((d.type === 'interface' || d.type === 'callback interface') && !d.partial) definitions.set(d.name, d);
    if (d.type === 'interface mixin' && !d.partial) mixins.set(d.name, d);
    if (d.type === 'dictionary' && !d.partial) dictionaries.set(d.name, d);
    if (d.type === 'includes') add(d.target, { mixin: d.includes });
    if ((d.type === 'interface' || d.type === 'interface mixin') && d.partial) add(d.name, { partial: spec, def: d });
  }
}

// The extended attributes a binding here makes what IDL says of, by where they stand; any other is an error.
// [CEReactions]: an implementation's writes run their reactions as each returns (handleAttributeChanges) — which is
// the operation's return where it writes once, as every one generated here does. [SameObject] / [NewObject]: what the
// implementation returns. [Exposed]: the global the interface object is put on, the Window's here.
const HANDLED = {
  interface: ['Exposed'],
  member: ['SameObject', 'NewObject', 'CEReactions', 'Unscopable'],
  type: ['LegacyNullToEmptyString']
};
function checkExtAttrs(extAttrs, where, label) {
  for (const e of extAttrs || []) {
    if (!HANDLED[where].includes(e.name)) throw new Error(`${label}: no binding makes [${e.name}] yet`);
  }
}

// What a conversion's TypeError says, by where the value comes from (Chrome's messages): an operation's argument
// (`index`, from 0), or an attribute's value.
function failure(where) {
  return where.index === undefined
    ? `Failed to set the '${where.member}' property on '${where.iface}': `
    : `Failed to execute '${where.member}' on '${where.iface}': `;
}
function conversionError(where, what) {
  return failure(where) + (where.index === undefined
    ? `Failed to convert value to '${what}'.`
    : `parameter ${where.index + 1} is not of type '${what}'.`);
}

// The JS of converting `expr` to the IDL type `t` (an argument's, an attribute's), and the interfaces whose objects it
// takes, into `checks`.
// `extAttrs` are those on the type and, for an argument, the argument's own (where webidl2 puts `[EnforceRange] long x`'s).
function conversion(t, expr, where, checks, argExtAttrs = []) {
  const label = `${where.iface}.${where.member}`;
  if (t.union) return unionConversion(t, expr, where, checks);
  if (t.generic) throw new Error(`${label}: no binding converts ${JSON.stringify(t.idlType)} yet`);
  const extAttrs = [...(t.extAttrs || []), ...argExtAttrs];
  checkExtAttrs(extAttrs, 'type', label);
  const legacyNull = extAttrs.some((e) => e.name === 'LegacyNullToEmptyString');
  let c;
  switch (t.idlType) {
    case 'DOMString': c = `toDOMString(${expr}${legacyNull ? ', true' : ''})`; break;
    case 'USVString': c = `toUSVString(${expr})`; break;
    case 'boolean': c = `toBoolean(${expr})`; break;
    case 'unsigned short': c = `toUnsignedShort(${expr})`; break;
    case 'unsigned long': c = `toUnsignedLong(${expr})`; break;
    case 'long': c = `toLong(${expr})`; break;
    case 'double': c = `toDouble(${expr}, ${JSON.stringify(failure(where) + 'The provided double value is non-finite.')})`; break;
    case 'unrestricted double': c = `toUnrestrictedDouble(${expr})`; break;
    case 'any': c = expr; break;
    default: {
      const def = definitions.get(t.idlType);
      if (def && def.type === 'interface') {
        checks.add(t.idlType);
        c = `toInterface(${expr}, IS_${t.idlType}, ${JSON.stringify(conversionError(where, t.idlType))})`;
      } else if (def && def.type === 'callback interface') {
        c = `toCallbackInterface(${expr}, ${JSON.stringify(conversionError(where, 'Object'))})`;
      } else if (dictionaries.has(t.idlType)) {
        c = `${dictionaryConverter(t.idlType)}(${expr}, ${JSON.stringify(failure(where) + `The provided value is not of type '${t.idlType}'.`)})`;
      } else {
        throw new Error(`${label}: no binding converts ${t.idlType} yet`);
      }
    }
  }
  return t.nullable ? `(${expr} == null ? null : ${c})` : c;
}

// A union of interface types and one string type (`(Node or DOMString)`): an object of one of its interfaces as it is,
// anything else converted to the string type (Web IDL §3.2.24 — the string type the last step takes).
function unionConversion(t, expr, where, checks) {
  const label = `${where.iface}.${where.member}`;
  const strings = t.idlType.filter((u) => ['DOMString', 'USVString'].includes(u.idlType));
  const ifaces = t.idlType.filter((u) => definitions.get(u.idlType)?.type === 'interface' && !u.nullable && !u.union);
  if (t.nullable || strings.length !== 1 || ifaces.length + 1 !== t.idlType.length) {
    throw new Error(`${label}: no binding converts ${JSON.stringify(t.idlType.map((u) => u.idlType))} yet`);
  }
  for (const u of ifaces) checks.add(u.idlType);
  const test = ifaces.map((u) => `IS_${u.idlType}(${expr})`).join(' || ');
  return `(${test} ? ${expr} : ${conversion(strings[0], expr, where, checks)})`;
}

// A dictionary's conversion (Web IDL §3.2.20): a function of its own, written once beside the interfaces — undefined
// or null an empty dictionary, any other non-object a TypeError (`message`); each member, its inherited dictionaries'
// first and each's in lexicographic order, got from the object, converted, or its default where it is undefined (a
// required one missing a TypeError).
const dictionaryConverters = new Map();
function dictionaryConverter(name) {
  const fn = `to${name}`;
  if (dictionaryConverters.has(name)) return fn;
  dictionaryConverters.set(name, null);
  const chain = [];
  for (let d = dictionaries.get(name); d; d = d.inheritance && dictionaries.get(d.inheritance)) {
    if (d.inheritance && !dictionaries.has(d.inheritance)) throw new Error(`${d.name}: inherits ${d.inheritance}, which no spec defines`);
    if ((additions.get(d.name) || []).length) throw new Error(`${d.name}: no binding merges a partial dictionary yet`);
    chain.unshift(d);
  }
  const checks = new Set(), lines = [];
  lines.push(`function ${fn}(v, message) {`);
  lines.push(`  if (v !== undefined && v !== null && typeof v !== 'object' && typeof v !== 'function') throw new TypeError(message);`);
  lines.push(`  const dict = {};`);
  for (const d of chain) {
    for (const m of [...d.members].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const where = { iface: d.name, member: m.name };
      lines.push(`  {`);
      lines.push(`    const x = v == null ? undefined : v.${m.name};`);
      const missing = m.required ? `(() => { throw new TypeError(${JSON.stringify(`Failed to read the '${m.name}' property from '${d.name}': Required member is undefined.`)}); })()`
        : m.default ? defaultValue(m.default, `${d.name}.${m.name}`) : null;
      const converted = conversion(m.idlType, 'x', where, checks, m.extAttrs);
      lines.push(missing === null
        ? `    if (x !== undefined) dict.${m.name} = ${converted};`
        : `    dict.${m.name} = x !== undefined ? ${converted} : ${missing};`);
      lines.push(`  }`);
    }
  }
  if (checks.size) throw new Error(`${name}: a dictionary member of an interface type is not converted yet`);
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
// `omit` names (and why). What no binding here makes of a definition yet, beside its members, is an error.
function membersOf(def, omit = {}) {
  const omitted = new Set();
  const gather = (d) => {
    checkExtAttrs(d.extAttrs, 'interface', d.name);
    const found = [...d.members];
    for (const a of additions.get(d.name) || []) {
      const key = a.mixin || a.partial;
      if (key in omit) { omitted.add(key); continue; }
      if (a.partial) { found.push(...a.def.members); continue; }
      const mixin = mixins.get(a.mixin);
      if (!mixin) throw new Error(`${def.name}: includes ${a.mixin}, which no spec defines`);
      found.push(...gather(mixin));
    }
    return found;
  };
  const members = gather(def);
  const unknown = Object.keys(omit).filter((k) => !omitted.has(k));
  if (unknown.length) throw new Error(`${def.name}: omits ${unknown.join(', ')}, which nothing adds to it`);
  const names = members.filter((m) => m.type === 'operation' && m.name).map((m) => m.name);
  const overloaded = names.find((n, i) => names.indexOf(n) !== i);
  if (overloaded) throw new Error(`${def.name}.${overloaded}: an overloaded operation is not generated yet`);
  for (const m of members) checkExtAttrs(m.extAttrs, 'member', `${def.name}.${m.name || m.type}`);
  return members;
}

function generateInterface(def, options = {}) {
  const name = def.name;
  if (def.inheritance && !options.install) throw new Error(`${name}: an inherited interface is not generated yet`);
  const members = [], constants = [], body = [], checks = new Set(), unscopables = [];
  // (…`this` checked: by its brand where the binding makes the object, by the test its class registered where it is
  // installed on that class)
  const self = options.install ? 'thisIs(this, IS_SELF)' : 'thisOf(this, KEY)';
  let indexed = null, valueIterator = false, stringifier = null, constructor = null;
  for (const m of membersOf(def, options.omit)) {
    const label = `${name}.${m.name || m.type}`;
    if ((m.extAttrs || []).some((e) => e.name === 'Unscopable')) unscopables.push(m.name);
    if (m.type === 'constructor') { constructor = m; continue; }
    if (m.type === 'const') { constants.push([m.name, constantValue(m, label)]); continue; }
    if (m.type === 'iterable') {
      if (m.idlType.length !== 1) throw new Error(`${label}: a pair iterator is not generated yet`);
      valueIterator = true;
      continue;
    }
    if (m.type === 'attribute') {
      if (m.special === 'stringifier') stringifier = m.name;
      else if (m.special) throw new Error(`${label}: a ${m.special} attribute is not generated yet`);
      members.push(m.name);
      body.push(`    get ${m.name}() { return impl.get_${m.name}(${self}); }`);
      if (!m.readonly) {
        const v = conversion(m.idlType, 'v', { iface: name, member: m.name }, checks);
        body.push(`    set ${m.name}(v) { impl.set_${m.name}(${self}, ${v}); }`);
      }
      continue;
    }
    if (m.type === 'operation') {
      if (m.special === 'getter') {
        if (m.arguments.length !== 1 || m.arguments[0].idlType.idlType !== 'unsigned long') throw new Error(`${label}: only an indexed getter is generated`);
        indexed = m.name;
      } else if (m.special) {
        throw new Error(`${label}: a ${m.special} operation is not generated yet`);
      }
      if (!m.name) throw new Error(`${label}: an anonymous operation is not generated yet`);
      members.push(m.name);
      body.push(`    ${operation(name, m, checks, self)}`);
      continue;
    }
    throw new Error(`${label}: a ${m.type} member is not generated yet`);
  }
  if (indexed && !members.includes('length')) throw new Error(`${name}: an indexed getter with no \`length\` is not generated yet`);
  if (stringifier) body.push(`    toString() { return impl.get_${stringifier}(${self}); }`);
  const enumerated = JSON.stringify([...new Set(members)].concat(stringifier ? ['toString'] : []));
  if (options.install) {
    if (indexed || valueIterator) throw new Error(`${name}: an installed interface with an indexed getter or an iterator is not generated yet`);
    return installInterface(def, { body, checks, unscopables, constructor, constants });
  }
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
function installInterface(def, { body, checks, unscopables, constructor, constants }) {
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
  if (constants.length) {
    const list = JSON.stringify(constants.map(([n]) => n));
    lines.push(`  defineConstants(iface, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
    lines.push(`  defineConstants(iface.prototype, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
  }
  lines.push(`  defineLength(iface, ${length});`);
  lines.push(`  defineClassString(iface.prototype, '${name}');`);
  if (unscopables.length) lines.push(`  defineUnscopables(iface.prototype, ${JSON.stringify(unscopables)});`);
  lines.push(`}`);
  return lines.join('\n');
}

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
function operation(iface, m, checks, self) {
  const args = m.arguments;
  const requiredCount = args.filter((a) => !a.optional && !a.variadic).length;
  if (args.some((a, i) => (a.optional || a.variadic) && i < requiredCount)) throw new Error(`${iface}.${m.name}: a required argument after an optional one`);
  if (args.some((a) => a.optional) && args.some((a) => a.variadic)) throw new Error(`${iface}.${m.name}: an optional argument beside a variadic one is not generated yet`);
  const params = args.filter((a) => !a.optional).map((a) => (a.variadic ? `...${argName(a)}` : argName(a))).join(', ');
  const converted = args.map((a, i) => {
    const where = { iface, member: m.name, index: i };
    if (a.variadic) return `${argName(a)}.map((x) => ${conversion(a.idlType, 'x', where, checks, a.extAttrs)})`;
    if (a.optional) {
      // (…an optional argument passed as undefined is one not passed, Web IDL §3.6.8 — but a dictionary is converted
      // from undefined, its members' defaults)
      if (dictionaries.has(a.idlType.idlType)) return conversion(a.idlType, `arguments[${i}]`, where, checks, a.extAttrs);
      const missing = a.default ? defaultValue(a.default, `${iface}.${m.name}(${a.name})`) : 'undefined';
      return `(arguments[${i}] !== undefined ? ${conversion(a.idlType, `arguments[${i}]`, where, checks, a.extAttrs)} : ${missing})`;
    }
    return conversion(a.idlType, argName(a), where, checks, a.extAttrs);
  });
  // (…`this` checked first, then the arguments counted — Web IDL's order, as Chrome's)
  const check = requiredCount ? `required(arguments, ${requiredCount}, '${m.name}', '${iface}'); ` : '';
  return `${m.name}(${params}) { const self = ${self}; ${check}return impl.${m.name}(${['self', ...converted].join(', ')}); }`;
}

function defaultValue(d, where) {
  switch (d.type) {
    case 'string': return JSON.stringify(d.value);
    case 'boolean': return String(d.value);
    case 'number': return String(d.value);
    case 'null': return 'null';
    default: throw new Error(`${where}: no binding gives a default of ${d.type} yet`);
  }
}

// A callback interface: its legacy callback interface object where it has constants (Web IDL §3.7.2) — no constructor,
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
const dictionaryParts = [...dictionaryConverters.values()];
const source = `// GENERATED by script/gen_bindings.mjs from @webref/idl — do not edit; run \`node script/gen_bindings.mjs\`.
// The bindings of the interfaces the driver implements: what Web IDL says of each, its implementation handed the
// converted values (webidl.js is their runtime).

import {
${wrap(RUNTIME)}
} from '../webidl.js';

${[...dictionaryParts, ...parts].join('\n\n')}
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
