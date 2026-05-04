// Custom esbuild configuration that maps Node built-in imports (including
// subpaths like `stream/web`) to small browser-compatible shims so that
// happy-dom can be bundled for mini_racer's V8 isolate.
//
// Also vendors esbuild-wasm into vendor/esbuild-wasm/ — that copy is what
// the published gem uses at runtime to bundle Rails importmap modules.
// The local (native) `esbuild` is used here at build time only.
import * as esbuild from 'esbuild';
import {fileURLToPath} from 'url';
import {resolve, dirname, join} from 'path';
import {copyFileSync, mkdirSync} from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const SHIMS = `${here}/vendor/js/shims`;

const NODE_BUILTIN_TO_SHIM = {
  url:          `${SHIMS}/url.js`,
  buffer:       `${SHIMS}/buffer.js`,
  vm:           `${SHIMS}/vm.js`,
  path:         `${SHIMS}/path.js`,
  fs:           `${SHIMS}/empty.js`,
  http:         `${SHIMS}/empty.js`,
  https:        `${SHIMS}/empty.js`,
  net:          `${SHIMS}/empty.js`,
  tls:          `${SHIMS}/empty.js`,
  stream:       `${SHIMS}/empty.js`,
  zlib:         `${SHIMS}/empty.js`,
  child_process:`${SHIMS}/empty.js`,
  crypto:       `${SHIMS}/empty.js`,
  ws:           `${SHIMS}/empty.js`,
  perf_hooks:   `${SHIMS}/empty.js`,
  util:         `${SHIMS}/empty.js`,
  os:           `${SHIMS}/empty.js`,
  querystring:  `${SHIMS}/empty.js`,
  assert:       `${SHIMS}/empty.js`,
  events:       `${SHIMS}/empty.js`
};

const NODE_PROTOCOL_RX = /^node:(.+)$/;

const nodeBuiltinShim = {
  name: 'node-builtin-shim',
  setup(build) {
    build.onResolve({filter: /.*/}, (args) => {
      let id = args.path;
      const m = id.match(NODE_PROTOCOL_RX);
      if (m) id = m[1];
      const root = id.split('/')[0];
      if (NODE_BUILTIN_TO_SHIM[root]) {
        return {path: NODE_BUILTIN_TO_SHIM[root]};
      }
      return null;
    });
  }
};

await esbuild.build({
  entryPoints: ['vendor/js/entry.mjs'],
  outfile: 'vendor/js/csim.bundle.js',
  bundle: true,
  format: 'iife',
  globalName: '__csim_bundle',
  target: 'es2022',
  platform: 'browser',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  inject: [`${SHIMS}/process-inject.js`],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.HAPPY_DOM_NODE_ENV': JSON.stringify('production')
  },
  plugins: [nodeBuiltinShim],
  logLevel: 'info'
});

// Vendor esbuild-wasm so the published gem can bundle Rails importmaps
// without a runtime npm dependency. The Node entry (`lib/main.js`) checks
// its own __dirname and spawns `node ../bin/esbuild`, which then loads
// `../wasm_exec_node.js` + `../esbuild.wasm`. So we have to preserve the
// original directory layout — flattening breaks the runtime sanity check.
const wasmSrc = `${here}/node_modules/esbuild-wasm`;
const wasmDst = `${here}/vendor/esbuild-wasm`;
mkdirSync(`${wasmDst}/lib`, {recursive: true});
mkdirSync(`${wasmDst}/bin`, {recursive: true});
copyFileSync(`${wasmSrc}/lib/main.js`,        `${wasmDst}/lib/main.js`);
copyFileSync(`${wasmSrc}/bin/esbuild`,        `${wasmDst}/bin/esbuild`);
copyFileSync(`${wasmSrc}/esbuild.wasm`,       `${wasmDst}/esbuild.wasm`);
copyFileSync(`${wasmSrc}/wasm_exec.js`,       `${wasmDst}/wasm_exec.js`);
copyFileSync(`${wasmSrc}/wasm_exec_node.js`,  `${wasmDst}/wasm_exec_node.js`);
copyFileSync(`${wasmSrc}/LICENSE.md`,         `${wasmDst}/LICENSE.md`);
console.log(`vendored esbuild-wasm → ${wasmDst}`);
