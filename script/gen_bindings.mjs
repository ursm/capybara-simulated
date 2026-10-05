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

// The interfaces generated, by spec.
const INTERFACES = [
  ['dom', 'DOMTokenList'],
  ['dom', 'NodeFilter'],
  ['dom', 'NodeIterator'],
  ['dom', 'TreeWalker']
];

// What the generated code imports from the runtime (webidl.js).
const RUNTIME = [
  'brandKey', 'makeSlots', 'slotsOf', 'thisOf', 'required', 'constructedBy', 'registerInterface', 'interfaceCheck',
  'toDOMString', 'toUSVString', 'toBoolean', 'toUnsignedShort', 'toUnsignedLong', 'toLong', 'toDouble',
  'toUnrestrictedDouble', 'toInterface', 'toCallbackInterface', 'callUserObjectOperation', 'legacyCallbackInterfaceObject',
  'defineConstants', 'withIndexedGetter', 'defineValueIterator', 'defineClassString', 'enumerable'
];

const all = await parseAll();
// Every interface and callback interface of every spec, by name: what an interface type names. And what adds to one
// beside its definition — a partial interface, a mixin it includes — which no binding here merges yet.
const definitions = new Map(), additions = new Map();
for (const [spec, defs] of Object.entries(all)) {
  for (const d of defs) {
    if ((d.type === 'interface' || d.type === 'callback interface') && !d.partial) definitions.set(d.name, d);
    const to = d.type === 'includes' ? d.target : d.partial ? d.name : null;
    if (to) additions.set(to, [...(additions.get(to) || []), `${d.type === 'includes' ? `includes ${d.includes}` : 'a partial'} (${spec})`]);
  }
}

// The extended attributes a binding here makes what IDL says of, by where they stand; any other is an error.
// [CEReactions]: an implementation's writes run their reactions as each returns (handleAttributeChanges) — which is
// the operation's return where it writes once, as every one generated here does. [SameObject] / [NewObject]: what the
// implementation returns. [Exposed]: the global the interface object is put on, the Window's here.
const HANDLED = {
  interface: ['Exposed'],
  member: ['SameObject', 'NewObject', 'CEReactions'],
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
  if (t.union || t.generic) throw new Error(`${label}: no binding converts ${JSON.stringify(t.idlType)} yet`);
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
      } else {
        throw new Error(`${label}: no binding converts ${t.idlType} yet`);
      }
    }
  }
  return t.nullable ? `(${expr} == null ? null : ${c})` : c;
}

function constantValue(m, where) {
  if (m.value.type !== 'number') throw new Error(`${where}: no binding gives a constant of ${m.value.type} yet`);
  return m.value.value;
}

// What no binding here makes of a definition yet, beside its members: an error.
function checkDefinition(def) {
  checkExtAttrs(def.extAttrs, 'interface', def.name);
  if (additions.has(def.name)) throw new Error(`${def.name}: no binding merges ${additions.get(def.name).join(', ')} yet`);
  const names = def.members.filter((m) => m.type === 'operation' && m.name).map((m) => m.name);
  const overloaded = names.find((n, i) => names.indexOf(n) !== i);
  if (overloaded) throw new Error(`${def.name}.${overloaded}: an overloaded operation is not generated yet`);
  for (const m of def.members) checkExtAttrs(m.extAttrs, 'member', `${def.name}.${m.name || m.type}`);
}

function generateInterface(def) {
  const name = def.name;
  if (def.inheritance) throw new Error(`${name}: an inherited interface is not generated yet`);
  checkDefinition(def);
  const members = [], constants = [], body = [], checks = new Set();
  let indexed = null, valueIterator = false, stringifier = null, constructor = null;
  for (const m of def.members) {
    const label = `${name}.${m.name || m.type}`;
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
      body.push(`    get ${m.name}() { return impl.get_${m.name}(thisOf(this, KEY)); }`);
      if (!m.readonly) {
        const v = conversion(m.idlType, 'v', { iface: name, member: m.name }, checks);
        body.push(`    set ${m.name}(v) { impl.set_${m.name}(thisOf(this, KEY), ${v}); }`);
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
      body.push(`    ${operation(name, m, checks)}`);
      continue;
    }
    throw new Error(`${label}: a ${m.type} member is not generated yet`);
  }
  if (constructor) throw new Error(`${name}: a constructor is not generated yet`);
  if (indexed && !members.includes('length')) throw new Error(`${name}: an indexed getter with no \`length\` is not generated yet`);

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
  if (stringifier) lines.push(`    toString() { return impl.get_${stringifier}(thisOf(this, KEY)); }`);
  lines.push(`  }`);
  if (constants.length) {
    const list = JSON.stringify(constants.map(([n]) => n));
    lines.push(`  defineConstants(${name}, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
    lines.push(`  defineConstants(${name}.prototype, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
  }
  lines.push(`  defineClassString(${name}.prototype, '${name}');`);
  lines.push(`  enumerable(${name}.prototype, ${JSON.stringify([...new Set(members)].concat(stringifier ? ['toString'] : []))});`);
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
function operation(iface, m, checks) {
  const args = m.arguments;
  const requiredCount = args.filter((a) => !a.optional && !a.variadic).length;
  if (args.some((a, i) => (a.optional || a.variadic) && i < requiredCount)) throw new Error(`${iface}.${m.name}: a required argument after an optional one`);
  if (args.some((a) => a.optional) && args.some((a) => a.variadic)) throw new Error(`${iface}.${m.name}: an optional argument beside a variadic one is not generated yet`);
  const params = args.filter((a) => !a.optional).map((a) => (a.variadic ? `...${argName(a)}` : argName(a))).join(', ');
  const converted = args.map((a, i) => {
    const where = { iface, member: m.name, index: i };
    if (a.variadic) return `${argName(a)}.map((x) => ${conversion(a.idlType, 'x', where, checks, a.extAttrs)})`;
    if (a.optional) {
      // (…an optional argument passed as undefined is one not passed, Web IDL §3.6.8)
      const missing = a.default ? defaultValue(a.default, `${iface}.${m.name}(${a.name})`) : 'undefined';
      return `(arguments[${i}] !== undefined ? ${conversion(a.idlType, `arguments[${i}]`, where, checks, a.extAttrs)} : ${missing})`;
    }
    return conversion(a.idlType, argName(a), where, checks, a.extAttrs);
  });
  // (…`this` checked first, then the arguments counted — Web IDL's order, as Chrome's)
  const self = `const self = thisOf(this, KEY); `;
  const check = requiredCount ? `required(arguments, ${requiredCount}, '${m.name}', '${iface}'); ` : '';
  return `${m.name}(${params}) { ${self}${check}return impl.${m.name}(${['self', ...converted].join(', ')}); }`;
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
  checkDefinition(def);
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
for (const [spec, name] of INTERFACES) {
  const def = (all[spec] || []).find((d) => (d.type === 'interface' || d.type === 'callback interface') && d.name === name && !d.partial);
  if (!def) throw new Error(`${spec}: no interface ${name}`);
  def.spec = spec;
  parts.push(def.type === 'interface' ? generateInterface(def) : generateCallbackInterface(def));
}
const source = `// GENERATED by script/gen_bindings.mjs from @webref/idl — do not edit; run \`node script/gen_bindings.mjs\`.
// The bindings of the interfaces the driver implements: what Web IDL says of each, its implementation handed the
// converted values (webidl.js is their runtime).

import {
${wrap(RUNTIME)}
} from '../webidl.js';

// What the platform passes its own constructions, which a script's \`new\` cannot.
const PLATFORM = Symbol('platform');

${parts.join('\n\n')}
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
