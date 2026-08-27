// Every free identifier in the bridge's JavaScript, checked against the globals that really exist.
//
// esbuild resolves IMPORTS, and nothing else: a name that is neither declared in its file nor
// imported into it compiles to a global lookup, and the failure surfaces as a runtime
// `ReferenceError` on whatever code path happens to touch it. That has cost a full WPT gate run
// three times — `FALLBACK_ONLY_TAGS` and `flowSides` used in layout.js without an import, and
// `names` read by a function lifted out of the closure that declared it. Worse than a crash is a
// name the WINDOW happens to carry: a stray `name`, `event`, `top` or `parent` resolves to a real
// window property and the code quietly does the wrong thing.
//
// So the allowlist is deliberately SMALL and explicit. The bridge spells a global `globalThis.X`
// almost everywhere; the handful of bare ones are listed below, and a new one costs a line here.
// (Deriving the list instead — from `globalThis.X = …` assignments and the host functions Ruby
// attaches — admitted 872 names to cover these 16, including `name`, `event` and every worker-only
// global, which is the bug class this exists to catch.)
import { readFileSync, readdirSync } from 'node:fs';
import { join }                      from 'node:path';
import { runInNewContext }           from 'node:vm';
import * as acorn                    from 'acorn';
import { analyze }                   from 'eslint-scope';

const SRC = 'lib/capybara/simulated/js';
// acorn takes the moving target; eslint-scope wants a number before it will treat a file as a
// module at all.
const PARSE_VERSION = 'latest';
const SCOPE_VERSION = 2025;

// Globals the bridge installs and then reads WITHOUT the `globalThis.` prefix.
const BARE_GLOBALS = [
  // Web platform classes and functions it defines for the page, and uses itself.
  'URL', 'DOMException', 'queueMicrotask', 'setTimeout', 'structuredClone', 'document',
  // Host functions Ruby attaches to the realm (runtime_shared.rb / v8_runtime.rb).
  '__rackFetch', '__csim_runScript', '__csim_evalEsmEntry', '__csim_asyncIoPending',
  // Bridge internals one module installs for another — and for the Ruby side to call.
  '__csimHasPendingRAF', '__nextTimerDelay', '__csimSecureAncestorChain', '__isVisibleNode',
  '__csimClickResolve', '__csimNeuterDetachedWindow'
];

// esbuild substitutes these at build time, so they resolve to nothing at parse. Read from the build
// command rather than repeated here, so adding a `--define:` does not fail the build it defines.
const BUILD = JSON.parse(readFileSync('package.json', 'utf8')).scripts['build:bridge'];
const DEFINES = [...BUILD.matchAll(/--define:([A-Za-z_$][\w$]*)=/g)].map(([, name]) => name);

// The JS builtins, from a bare VM context — the host's V8, which is the engine the bridge targets.
// A name QuickJS lacks would pass here and fail there; its own gate run is what catches that.
const builtins = runInNewContext('Object.getOwnPropertyNames(globalThis)');
const known    = new Set([...builtins, ...BARE_GLOBALS, ...DEFINES]);

// Recursive, so a source moved into a subdirectory keeps being checked rather than quietly dropping
// out of the walk. The built bundle is generated FROM these and is not itself a source.
const sources = readdirSync(SRC, { recursive: true })
  .filter(entry => entry.endsWith('.js') && !entry.endsWith('.bundle.js')).sort()
  .map(entry => ({ path: join(SRC, entry), text: readFileSync(join(SRC, entry), 'utf8') }));

let failures = 0;
for (const { path, text } of sources) {
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: PARSE_VERSION, sourceType: 'module', locations: true, ranges: true });
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    failures++;
    continue;
  }
  const { globalScope } = analyze(ast, { ecmaVersion: SCOPE_VERSION, sourceType: 'module' });
  // `through` is every reference the analyzer could not bind to a declaration in any enclosing
  // scope — exactly "this name is not from around here".
  for (const { identifier, from } of globalScope.through) {
    if (known.has(identifier.name)) continue;
    // `typeof X` is how you ASK whether a global exists; it never throws, so it is never a bug.
    if (isTypeofOperand(identifier, from)) continue;
    const { line, column } = identifier.loc.start;
    console.error(`${path}:${line}:${column + 1}: \`${identifier.name}\` is not declared, imported, ` +
                  'or a known global');
    failures++;
  }
}

// eslint-scope hands back the reference, not its parent, so ask the enclosing scope's AST for the
// `typeof` that wraps it.
function isTypeofOperand(identifier, scope) {
  let found = false;
  (function walk(node) {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument === identifier) {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) if (key !== 'loc' && key !== 'range') walk(node[key]);
  })(scope.block);
  return found;
}

if (failures) {
  console.error(`\n${failures} undefined reference${failures === 1 ? '' : 's'} in ${SRC}.\n` +
                'Import it, spell it `globalThis.X`, or — if it really is a bare global the bridge ' +
                'installs — add it to BARE_GLOBALS in script/check_bridge_globals.mjs.');
  process.exit(1);
}
console.log(`${sources.length} bridge sources: no undefined references ` +
            `(${builtins.length} builtins, ${BARE_GLOBALS.length} bare globals)`);
