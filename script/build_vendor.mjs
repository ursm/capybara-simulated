// Bundles the vendored libraries (vendor/src/vendor.entry.js) into vendor/js/vendor.bundle.js, which the snapshot loads
// before the bindings — inside a function whose parameters are the ECMAScript intrinsics as they are as it loads, as the
// bindings' bundle is (bundle_intrinsics.mjs): a bare `Promise` of the polyfill's is the realm's own. web-streams-polyfill
// keeps its queues as Arrays it grows with `push`; an element written into one would meet a setter a page put on
// Array.prototype's index, and hand it a stream's internal record — so each of its empty array literals is made an
// internal list as it is bundled (vendor/src/internal-list.js), its code otherwise untouched. A build that finds no file
// of the polyfill's to rewrite, or no literal in one, fails: a version that moved its files would otherwise go out with
// its lists the page's again.
import * as esbuild from 'esbuild';
import { parse } from 'acorn';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { INTRINSICS, intrinsicArguments } from './bundle_intrinsics.mjs';

const INTERNAL_LIST = fileURLToPath(new URL('../vendor/src/internal-list.js', import.meta.url));

const rewritten = new Map();
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
      rewritten.set(args.path, literals.length);
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
  banner:      { js: `globalThis.__csimVendor = ((${INTRINSICS.join(', ')}) => {` },
  footer:      { js: `return __csimVendor; })(${intrinsicArguments()});` },
  outfile:     'vendor/js/vendor.bundle.js',
  plugins:     [internalLists],
  logLevel:    'warning'
});

if (rewritten.size === 0) throw new Error('build_vendor: no file of web-streams-polyfill was loaded to rewrite its lists');
for (const [path, count] of rewritten) {
  if (count === 0) throw new Error(`build_vendor: ${path} has no empty array literal to make an internal list`);
}
