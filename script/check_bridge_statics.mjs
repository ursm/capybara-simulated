// Every static of Reflect / Object / JSON / Array / Promise / Symbol / ArrayBuffer / Number / String / Math / the typed
// arrays the bindings call — and every method of one's prototype — read as the bundle loads, never once a page runs; and
// nothing of the bindings' — a function, a list, a typed array — handed to a method of Array.prototype's, of
// %TypedArray%.prototype's or of %ArrayIteratorPrototype%'s: no such method called by name, and no for…of, spread or
// array destructuring, which walk an array by `Array.prototype[Symbol.iterator]` and the iterator's `next`.

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
const TYPED_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
const NAMESPACES = new Set(['Reflect', 'Object', 'JSON', 'Array', 'Promise', 'Symbol', 'ArrayBuffer', 'Number', 'String', 'Math', ...TYPED_ARRAYS]);
// (…what no page can replace: a well-known symbol, a constructor's `prototype`, a number constant — each non-writable)
const FIXED = new Set(['iterator', 'asyncIterator', 'hasInstance', 'isConcatSpreadable', 'match', 'matchAll', 'replace',
  'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables', 'prototype', 'MAX_SAFE_INTEGER',
  'MIN_SAFE_INTEGER', 'MAX_VALUE', 'MIN_VALUE', 'EPSILON', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY', 'NaN', 'PI', 'E',
  'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2', 'BYTES_PER_ELEMENT']);
// The methods of Array.prototype's that take a function — called by the bindings, a page's replacement of one would be
// handed theirs, and the list it walks — and `push`, which would be handed the list and what it adds: engine.js's list
// helper of the name is called instead (`listMap`, `listSort`, `listPush`, …).
const CALLBACK_METHODS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'flatMap', 'reduce', 'reduceRight', 'sort', 'toSorted', 'push']);
// …and the methods of theirs that take none, each called by name on a list the bindings hold handed the list: engine.js's
// list helper, or for a typed array intrinsics.js's (`listSlice`, `listIncludes`, `typedArraySubarray`, …). Some are a
// string's too, by the same name — no build check tells a string from a list — and a string's is called through
// intrinsics.js's (`stringSlice`, `stringIndexOf`, …); a Map's `keys` / `values` / `entries` through engine.js's
// `keysOf` / `valuesOf` / `entriesOf`, which make a list of them.
const LIST_METHODS = new Set(['at', 'concat', 'copyWithin', 'entries', 'fill', 'flat', 'includes', 'indexOf', 'join', 'keys',
  'lastIndexOf', 'pop', 'reverse', 'shift', 'slice', 'splice', 'subarray', 'toReversed', 'toSpliced', 'unshift', 'values',
  'with']);
// (…and the statics that walk a list by its iterator: `arrayFrom` — engine.js's `listFrom` is called instead)
const ITERATING_CALLS = new Set(['arrayFrom', 'objectFromEntries']);

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
    const at = `${path}:${node.loc.start.line}:${node.loc.start.column + 1}`;
    // (…`impl`, a generated binding's implementation object, is none: its `sort` is URLSearchParams'; nor an engine's —
    // `engineOf(…)`, a canvas's context's ops — whose `fill` is a 2D context's)
    const receiver = node.type === 'CallExpression' && node.callee.type === 'MemberExpression' ? node.callee.object : null;
    if (inFunction && receiver && !node.callee.computed
        && (CALLBACK_METHODS.has(node.callee.property.name) || LIST_METHODS.has(node.callee.property.name))
        && !(receiver.type === 'Identifier' && receiver.name === 'impl')
        && !(receiver.type === 'CallExpression' && receiver.callee.type === 'Identifier' && receiver.callee.name === 'engineOf')) {
      console.error(`${at}: \`.${node.callee.property.name}(…)\` — call engine.js's list helper`);
      failures++;
    }
    if (inFunction && node.type === 'CallExpression' && node.callee.type === 'Identifier' && ITERATING_CALLS.has(node.callee.name)) {
      console.error(`${at}: \`${node.callee.name}(…)\` walks its argument by its iterator — call engine.js's list helper`);
      failures++;
    }
    if (inFunction && node.type === 'ForOfStatement') {
      console.error(`${at}: for…of — walk the list by index`);
      failures++;
    }
    if (inFunction && node.type === 'YieldExpression' && node.delegate) {
      console.error(`${at}: yield* — yield the list's elements by index`);
      failures++;
    }
    if (inFunction && node.type === 'ArrayPattern') {
      console.error(`${at}: array destructuring — read the list by index`);
      failures++;
    }
    if (inFunction && (node.type === 'ArrayExpression' || node.type === 'CallExpression' || node.type === 'NewExpression')) {
      const elements = node.type === 'ArrayExpression' ? node.elements : node.arguments;
      for (const element of elements) {
        if (element?.type !== 'SpreadElement') continue;
        console.error(`${path}:${element.loc.start.line}:${element.loc.start.column + 1}: a spread — engine.js's \`listConcat\` / \`listFrom\`, or \`reflectApply\``);
        failures++;
      }
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
  console.error(`\n${failures} statics read, or lists walked through a page's methods, at call time in ${SRC}.`);
  process.exit(1);
}
console.log(`${sources.length} bridge sources: no static of ${[...NAMESPACES].join(' / ')} read at call time, no list walked through a page's methods`);
