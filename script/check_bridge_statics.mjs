// Every static of Reflect / Object / JSON / Array / Promise / Symbol the bindings call — and every method of one's
// prototype — read as the bundle loads, never once a page runs.
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
const NAMESPACES = new Set(['Reflect', 'Object', 'JSON', 'Array', 'Promise', 'Symbol']);
const FIXED = new Set(['iterator', 'asyncIterator', 'hasInstance', 'isConcatSpreadable', 'match', 'matchAll', 'replace',
  'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables', 'prototype']);

const sources = readdirSync(SRC, { recursive: true }).filter((entry) => entry.endsWith('.js') && entry !== 'intrinsics.js').sort();
let failures = 0;
for (const entry of sources) {
  const path = join(SRC, entry);
  const text = readFileSync(path, 'utf8');
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const walk = (node, inFunction) => {
    if (!node || typeof node.type !== 'string') return;
    const inside = inFunction || /Function/.test(node.type) || node.type === 'StaticBlock' || node.type === 'PropertyDefinition';
    if (inFunction && node.type === 'MemberExpression' && !node.computed) {
      const object = node.object;
      const holder = object.type === 'MemberExpression' && !object.computed && object.property.name === 'prototype' ? object.object : object;
      if (holder.type === 'Identifier' && NAMESPACES.has(holder.name) && !FIXED.has(node.property.name)) {
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
