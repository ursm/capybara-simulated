// Driver for on-the-fly bundling of a Rails-style importmap'd page.
//
// Reads a JSON payload on stdin describing an importmap, the entry
// scripts (inline source and/or URLs), and a virtual filesystem mapping
// resolved-URL → source. Resolves bare specifiers via the importmap,
// follows relative imports, and produces a single IIFE bundle on stdout.
//
// Ruby is responsible for pre-fetching all reachable URLs and handing
// them in via `sources`. Anything not in `sources` is treated as a
// missing module and aborts the build with a descriptive error so the
// caller can surface it without a silent partial bundle.
//
// Dynamic `import(specifier)` is rewritten to `globalThis.__csim_import`
// at load-time, and every importmap entry is statically pre-bundled
// into a `globalThis.__csim_modules` registry so the rewritten lookup
// can resolve synchronously. mini_racer has no real ES module loader,
// so without this rewrite, libraries like stimulus-loading silently
// fail to register controllers.
//
// Payload shape:
//   {
//     "importmap": { "imports": { "spec": "url", ... } },
//     "baseUrl":   "http://www.example.com/",
//     "entries":   [ {"inline": "import 'application'"}, {"src": "/x.js"} ],
//     "sources":   { "http://...": "...source..." }
//   }
//
// On success: the bundle text on stdout, exit 0.
// On failure: a JSON `{error: ...}` on stderr, exit 1.

// We import the vendored esbuild-wasm so the published gem doesn't need
// a runtime `npm install` step. Native esbuild is used at gem build time
// only — see build.mjs. The Node entry (`lib/main.js`) requires its own
// directory to be named `lib` and looks for sibling `bin/esbuild` +
// `esbuild.wasm`, so the import path has to follow that layout.
import * as esbuild from '../esbuild-wasm/lib/main.js';
await esbuild.initialize({});

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function resolveBare(importmap, spec) {
  const imports = (importmap && importmap.imports) || {};
  if (Object.prototype.hasOwnProperty.call(imports, spec)) return imports[spec];
  for (const k of Object.keys(imports)) {
    if (k.endsWith('/') && spec.startsWith(k)) {
      return imports[k] + spec.slice(k.length);
    }
  }
  return null;
}

function isUrl(s) {
  return /^https?:\/\//.test(s);
}

function resolveSpec(spec, importer, importmap, baseUrl) {
  if (isUrl(spec)) return spec;
  if (spec.startsWith('/')) return new URL(spec, baseUrl).href;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return new URL(spec, importer || baseUrl).href;
  }
  const mapped = resolveBare(importmap, spec);
  if (mapped) return resolveSpec(mapped, importer, importmap, baseUrl);
  return null;
}

const payload = JSON.parse(await readStdin());
const {importmap = {}, baseUrl, entries = [], sources = {}} = payload;
const NS = 'csim-rack';

// Rewriting `import(...)` → `globalThis.__csim_import(...)`. The regex
// avoids matching `import` statements (followed by whitespace/quote/name)
// by requiring the next non-space character to be `(`. Comments and
// strings can produce false positives in pathological code, but the
// pattern is conservative enough for the conventions used by Turbo,
// Stimulus, stimulus-loading, and the Rails import-map ecosystem.
const DYNAMIC_IMPORT_RX = /\bimport\s*\(/g;

function rewriteDynamicImports(source) {
  return source.replace(DYNAMIC_IMPORT_RX, 'globalThis.__csim_import(');
}

// Modules listed in the importmap that should be pre-bundled even when
// no static `import` reaches them, so dynamic `import("controllers/...")`
// can find them. Skip aliases that don't have a corresponding source —
// e.g. importmap pins to a CDN URL we never fetched.
function preloadEntries(importmap, sources, baseUrl) {
  const imports = (importmap && importmap.imports) || {};
  const out = [];
  for (const spec of Object.keys(imports)) {
    if (spec.endsWith('/')) continue;
    const resolved = resolveSpec(spec, baseUrl, importmap, baseUrl);
    if (!resolved) continue;
    if (!Object.prototype.hasOwnProperty.call(sources, resolved)) continue;
    out.push({spec, resolved});
  }
  return out;
}

const preload = preloadEntries(importmap, sources, baseUrl);
// Statically `import * as` each importmap entry so esbuild bundles them
// all, then register under the original specifier. The runtime side
// installs `globalThis.__csim_modules` and `__csim_import` *before* the
// bundle evaluates, so the registry already exists by the time these
// lines execute. (Import declarations hoist above any executable code,
// so we can't define the registry from within the bundle itself.)
const preludeLines = [];
preload.forEach((p, i) => {
  const local = `__csim_m_${i}`;
  preludeLines.push(`import * as ${local} from ${JSON.stringify(p.spec)};`);
});
preload.forEach((p, i) => {
  const local = `__csim_m_${i}`;
  preludeLines.push(`globalThis.__csim_modules[${JSON.stringify(p.spec)}] = ${local};`);
});

const userEntry = entries.map((e) => {
  if (e.src) return `import ${JSON.stringify(e.src)};`;
  if (e.inline != null) return e.inline;
  return '';
}).join('\n');

const entrySource = preludeLines.join('\n') + '\n' + userEntry;

const plugin = {
  name: 'csim-rack',
  setup(build) {
    build.onResolve({filter: /.*/}, (args) => {
      if (args.kind === 'entry-point') return null;
      const importer = args.importer && args.namespace === NS ? args.importer : baseUrl;
      const resolved = resolveSpec(args.path, importer, importmap, baseUrl);
      if (!resolved) {
        return {errors: [{text: `unresolved import "${args.path}" from ${args.importer || '<entry>'}`}]};
      }
      if (!Object.prototype.hasOwnProperty.call(sources, resolved)) {
        return {errors: [{text: `module not pre-fetched: ${resolved} (imported by ${args.importer || '<entry>'})`}]};
      }
      return {path: resolved, namespace: NS};
    });
    build.onLoad({filter: /.*/, namespace: NS}, (args) => {
      return {contents: rewriteDynamicImports(sources[args.path]), loader: 'js'};
    });
  }
};

try {
  const result = await esbuild.build({
    stdin: {contents: entrySource, resolveDir: '/', loader: 'js'},
    bundle: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    plugins: [plugin],
    logLevel: 'silent'
  });
  if (result.errors && result.errors.length) {
    process.stderr.write(JSON.stringify({error: result.errors.map((e) => e.text).join('; ')}));
    process.exit(1);
  }
  process.stdout.write(result.outputFiles[0].text);
} catch (e) {
  process.stderr.write(JSON.stringify({error: String((e && e.message) || e)}));
  process.exit(1);
}
