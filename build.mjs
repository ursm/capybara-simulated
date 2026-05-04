// Custom esbuild configuration that maps Node built-in imports (including
// subpaths like `stream/web`) to small browser-compatible shims so that
// happy-dom can be bundled for mini_racer's V8 isolate.
import * as esbuild from 'esbuild';
import {fileURLToPath} from 'url';
import {resolve, dirname} from 'path';

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
