// Generate the JS bindings of the interfaces the driver implements from their Web IDL (@webref/idl, the curated IDL of
// every web platform spec): per interface a `define<Name>(impl)` that makes its interface object — its members' argument
// counts, the conversion of each argument to its IDL type, the brand check of `this`, its class string, its indexed
// getter, stringifier and iterator — and hands the converted values to the implementation, `impl`, whose functions take
// the object first. What an interface does is its implementation's; the binding is what IDL says of it.
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
  ['dom', 'DOMTokenList']
];

// The JS of converting `expr` to the IDL type `t` (an argument's, an attribute's).
function conversion(t, expr, where) {
  if (t.union || t.generic) throw new Error(`${where}: no binding converts ${JSON.stringify(t.idlType)} yet`);
  const legacyNull = (t.extAttrs || []).some((e) => e.name === 'LegacyNullToEmptyString');
  let c;
  switch (t.idlType) {
    case 'DOMString': c = `toDOMString(${expr}${legacyNull ? ', true' : ''})`; break;
    case 'USVString': c = `toUSVString(${expr})`; break;
    case 'boolean': c = `toBoolean(${expr})`; break;
    case 'unsigned long': c = `toUnsignedLong(${expr})`; break;
    case 'long': c = `toLong(${expr})`; break;
    case 'unrestricted double': c = `toUnrestrictedDouble(${expr})`; break;
    case 'any': c = expr; break;
    default: throw new Error(`${where}: no binding converts ${t.idlType} yet`);
  }
  return t.nullable ? `(${expr} == null ? null : ${c})` : c;
}

function generateInterface(def) {
  const name = def.name;
  if (def.inheritance) throw new Error(`${name}: an inherited interface is not generated yet`);
  const lines = [];
  const members = [];
  let indexed = null, valueIterator = false, stringifier = null, constructor = null;
  const body = [];
  for (const m of def.members) {
    const where = `${name}.${m.name || m.type}`;
    if (m.type === 'constructor') { constructor = m; continue; }
    if (m.type === 'iterable') {
      if (m.idlType.length !== 1) throw new Error(`${where}: a pair iterator is not generated yet`);
      valueIterator = true;
      continue;
    }
    if (m.type === 'attribute') {
      if (m.special === 'stringifier') stringifier = m.name;
      else if (m.special) throw new Error(`${where}: a ${m.special} attribute is not generated yet`);
      members.push(m.name);
      body.push(`    get ${m.name}() { return impl.get_${m.name}(thisOf(this, KEY, '${name}', '${m.name}')); }`);
      if (!m.readonly) {
        body.push(`    set ${m.name}(v) { impl.set_${m.name}(thisOf(this, KEY, '${name}', '${m.name}'), ${conversion(m.idlType, 'v', where)}); }`);
      }
      continue;
    }
    if (m.type === 'operation') {
      if (m.special === 'getter') {
        if (m.arguments.length !== 1 || m.arguments[0].idlType.idlType !== 'unsigned long') throw new Error(`${where}: only an indexed getter is generated`);
        indexed = m.name;
      } else if (m.special) {
        throw new Error(`${where}: a ${m.special} operation is not generated yet`);
      }
      if (!m.name) throw new Error(`${where}: an anonymous operation is not generated yet`);
      members.push(m.name);
      const args = m.arguments;
      const requiredCount = args.filter((a) => !a.optional && !a.variadic).length;
      const params = args.map((a) => (a.variadic ? `...${a.name}` : a.name)).join(', ');
      const converted = args.map((a, i) => {
        const w = `${where}(${a.name})`;
        if (a.variadic) return `${a.name}.map((x) => ${conversion(a.idlType, 'x', w)})`;
        if (a.optional) {
          // (…an optional argument passed as undefined is one not passed, Web IDL §3.6.8)
          const missing = a.default ? defaultValue(a.default, w) : 'undefined';
          return `(arguments.length > ${i} && ${a.name} !== undefined ? ${conversion(a.idlType, a.name, w)} : ${missing})`;
        }
        return conversion(a.idlType, a.name, w);
      });
      const call = `impl.${m.name}(${['thisOf(this, KEY, \'' + name + '\', \'' + m.name + '\')', ...converted].join(', ')})`;
      const check = requiredCount ? `required(arguments, ${requiredCount}, '${m.name}', '${name}'); ` : '';
      body.push(`    ${m.name}(${params}) { ${check}return ${call}; }`);
      continue;
    }
    throw new Error(`${where}: a ${m.type} member is not generated yet`);
  }
  if (constructor) throw new Error(`${name}: a constructor is not generated yet`);

  lines.push(`// interface ${name} (${def.spec})`);
  lines.push(`export function define${name}(impl) {`);
  lines.push(`  const KEY = brandKey('${name}');`);
  lines.push(`  // (…made by the platform alone: the interface has no constructor)`);
  lines.push(`  class ${name} {`);
  lines.push(`    constructor(token, ...state) {`);
  lines.push(`      constructedBy(PLATFORM, token, '${name}');`);
  lines.push(`      brand(this, KEY);`);
  lines.push(`      impl.init(this, ...state);`);
  lines.push(`    }`);
  lines.push(...body);
  if (stringifier) lines.push(`    toString() { return impl.get_${stringifier}(thisOf(this, KEY, '${name}', 'toString')); }`);
  lines.push(`  }`);
  lines.push(`  defineClassString(${name}.prototype, '${name}');`);
  lines.push(`  enumerable(${name}.prototype, ${JSON.stringify([...new Set(members)].concat(stringifier ? ['toString'] : []))});`);
  if (valueIterator) {
    if (!indexed) throw new Error(`${name}: a value iterator with no indexed getter is not generated yet`);
    lines.push(`  defineValueIterator(${name}.prototype);`);
  }
  // …and its objects, as the platform makes them (`create(...state)`), exotic where it has an indexed getter.
  const make = indexed
    ? `withIndexedGetter(new ${name}(PLATFORM, ...state), (o, i) => impl.${indexed}(o, i), (o) => impl.get_length(o))`
    : `new ${name}(PLATFORM, ...state)`;
  lines.push(`  return { interface: ${name}, create: (...state) => ${make} };`);
  lines.push(`}`);
  return lines.join('\n');
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

const all = await parseAll();
const parts = [];
for (const [spec, name] of INTERFACES) {
  const def = (all[spec] || []).find((d) => d.type === 'interface' && d.name === name && !d.partial);
  if (!def) throw new Error(`${spec}: no interface ${name}`);
  def.spec = spec;
  parts.push(generateInterface(def));
}
const source = `// GENERATED by script/gen_bindings.mjs from @webref/idl — do not edit; run \`node script/gen_bindings.mjs\`.
// The bindings of the interfaces the driver implements: what Web IDL says of each, its implementation handed the
// converted values (webidl.js is their runtime).

import {
  brandKey, brand, thisOf, required, constructedBy, toDOMString, toUSVString, toBoolean, toUnsignedLong, toLong,
  toUnrestrictedDouble, withIndexedGetter, defineValueIterator, defineClassString, enumerable
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
