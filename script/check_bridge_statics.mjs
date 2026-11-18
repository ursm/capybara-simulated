// Every static of Reflect / Object / JSON / Array / Promise / Symbol / ArrayBuffer / Number / String / Math the bindings
// call — and every method of one's prototype — read as the bundle loads, never once a page runs; and no function of the
// bindings' handed to a method of Array.prototype's that takes one.

// (…`Date` is none of them: a bare `Date` in the bindings is the platform's own, the virtual clock's that timers.js
// installs, meant to be read as the global; `Intl`'s one constructor the bindings use, `DateTimeFormat`, is taken by
// tz-override.js as it loads)
//
// The namespaces themselves are the realm's own (build_bridge.mjs passes them into the bundle as they are before any page
// runs), but their members are the page's to replace: `Reflect.get = …` was handed the raw global of a cross-origin
// frame a WindowProxy read, `Object.keys = …` the target of a Proxy the bindings made, `Object.prototype
// .hasOwnProperty = …` the object asked about. So inside a function (which runs when a page may have replaced one) none
// is read: the bindings call the one lib/capybara/simulated/js/src/intrinsics.js captured, or one their module captured
// at its top level, as it loaded. A read at a module's top level is no call-time read, and a well-known symbol
// (`Symbol.iterator`) or a constructor's `prototype` is no member a page can replace.
import { readFileSync, readdirSync } from 'node:fs';
import { join }                      from 'node:path';
import * as acorn                    from 'acorn';

const SRC = 'lib/capybara/simulated/js/src';
const NAMESPACES = new Set(['Reflect', 'Object', 'JSON', 'Array', 'Promise', 'Symbol', 'ArrayBuffer', 'Number', 'String', 'Math']);
// (…what no page can replace: a well-known symbol, a constructor's `prototype`, a number constant — each non-writable)
const FIXED = new Set(['iterator', 'asyncIterator', 'hasInstance', 'isConcatSpreadable', 'match', 'matchAll', 'replace',
  'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables', 'prototype', 'MAX_SAFE_INTEGER',
  'MIN_SAFE_INTEGER', 'MAX_VALUE', 'MIN_VALUE', 'EPSILON', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY', 'NaN', 'PI', 'E',
  'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);
// The methods of Array.prototype's that take a function — called by the bindings, a page's replacement of one would be
// handed theirs, and the list it walks — and `push`, which would be handed the list and what it adds: engine.js's list
// helper of the name is called instead (`listMap`, `listSort`, `listPush`, …).
const CALLBACK_METHODS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'flatMap', 'reduce', 'reduceRight', 'sort', 'toSorted', 'push']);

const sources = readdirSync(SRC, { recursive: true }).filter((entry) => entry.endsWith('.js') && entry !== 'intrinsics.js').sort();
let failures = 0;
for (const entry of sources) {
  const path = join(SRC, entry);
  const text = readFileSync(path, 'utf8');
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  // (…a module's other names for a namespace — `const R = Reflect`, `IntrinsicPromise = Promise` — whose members a read
  // through one reads at call time as well)
  const aliases = new Set();
  const collect = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'Identifier' && NAMESPACES.has(node.init.name)) aliases.add(node.id.name);
    for (const key in node) {
      if (key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value.type === 'string') collect(value);
    }
  };
  collect(ast);
  const walk = (node, inFunction) => {
    if (!node || typeof node.type !== 'string') return;
    const inside = inFunction || /Function/.test(node.type) || node.type === 'StaticBlock' || node.type === 'PropertyDefinition';
    // (…a namespace destructured inside a function, which reads its members then)
    if (inFunction && node.type === 'VariableDeclarator' && node.init && node.init.type === 'Identifier'
        && NAMESPACES.has(node.init.name) && node.id.type === 'ObjectPattern') {
      console.error(`${path}:${node.loc.start.line}:${node.loc.start.column + 1}: \`${node.init.name}\` destructured at call time — take intrinsics.js's`);
      failures++;
    }
    // (…`impl`, a generated binding's implementation object, is none: its `sort` is URLSearchParams')
    if (inFunction && node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
        && CALLBACK_METHODS.has(node.callee.property.name)
        && !(node.callee.object.type === 'Identifier' && node.callee.object.name === 'impl')) {
      console.error(`${path}:${node.loc.start.line}:${node.loc.start.column + 1}: \`.${node.callee.property.name}(…)\` — call engine.js's list helper`);
      failures++;
    }
    if (inFunction && node.type === 'MemberExpression' && !node.computed) {
      const object = node.object;
      const holder = object.type === 'MemberExpression' && !object.computed && object.property.name === 'prototype' ? object.object : object;
      if (holder.type === 'Identifier' && (NAMESPACES.has(holder.name) || aliases.has(holder.name)) && !FIXED.has(node.property.name)) {
        const name = holder === object ? `${holder.name}.${node.property.name}` : `${holder.name}.prototype.${node.property.name}`;
        console.error(`${path}:${node.loc.start.line}:${node.loc.start.column + 1}: \`${name}\` read at call time — take intrinsics.js's`);
        failures++;
        return;
      }
    }
    for (const key in node) {
      if (key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => walk(child, inside));
      else if (value && typeof value.type === 'string') walk(value, inside);
    }
  };
  walk(ast, false);
}
if (failures) {
  console.error(`\n${failures} statics read at call time in ${SRC}.`);
  process.exit(1);
}
console.log(`${sources.length} bridge sources: no static of ${[...NAMESPACES].join(' / ')} read at call time`);
