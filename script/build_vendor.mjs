// Bundles the vendored libraries (vendor/src/vendor.entry.js) into vendor/js/vendor.bundle.js, which the snapshot loads
// before the bindings. web-streams-polyfill keeps its queues as Arrays it grows with `push`; an element written into one
// would meet a setter a page put on Array.prototype's index, and hand it a stream's internal record — so each of its empty
// array literals is made an internal list as it is bundled (vendor/src/internal-list.js), its code otherwise untouched.
import * as esbuild from 'esbuild';
import { parse } from 'acorn';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const INTERNAL_LIST = fileURLToPath(new URL('../vendor/src/internal-list.js', import.meta.url));

const internalLists = {
  name: 'internal-lists',
  setup(build) {
    build.onLoad({ filter: /web-streams-polyfill[\\/]dist[\\/].*\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const literals = [];
      const walk = (node) => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'ArrayExpression' && node.elements.length === 0) literals.push(node);
        for (const key in node) {
          const value = node[key];
          if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value.type === 'string') walk(value);
        }
      };
      walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
      let contents = source;
      for (const node of literals.sort((a, b) => b.start - a.start)) {
        contents = `${contents.slice(0, node.start)}__csimInternalList()${contents.slice(node.end)}`;
      }
      return { contents: `import { internalList as __csimInternalList } from ${JSON.stringify(INTERNAL_LIST)};\n${contents}`, loader: 'js' };
    });
  }
};

await esbuild.build({
  entryPoints: ['vendor/src/vendor.entry.js'],
  bundle:      true,
  format:      'iife',
  keepNames:   true,
  minify:      true,
  globalName:  '__csimVendor',
  banner:      { js: 'globalThis.__csimVendor = (() => {' },
  footer:      { js: 'return __csimVendor; })();' },
  outfile:     'vendor/js/vendor.bundle.js',
  plugins:     [internalLists],
  logLevel:    'warning'
});
