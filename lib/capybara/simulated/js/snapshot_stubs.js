// Stub host fns so bridge.js can be baked into a Snapshot (V8) /
// compiled to bytecode (QuickJS) without the real Ruby-side hosts
// being attached yet. Real implementations land at Context build
// time via the engine's attach API. Only the host fns bridge.js
// actually invokes appear here — if you add a new host fn, add the
// matching stub here too.
Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window' });
globalThis.__csim_parseUrl = function (input, base) {
  return {
    href: 'http://placeholder/', protocol: 'http:',
    username: '', password: '', host: 'placeholder',
    hostname: 'placeholder', port: '', pathname: '/',
    search: '', hash: '', origin: 'http://placeholder'
  };
};
globalThis.__csim_randomUUID  = function () { return '00000000-0000-0000-0000-000000000000'; };
globalThis.__csim_randomBytes = function (n) { return new Array(n).fill(0); };
globalThis.__csim_atob        = function (s) { return ''; };
globalThis.__csim_btoa        = function (s) { return ''; };
globalThis.__csim_utf8Encode  = function (s) { return []; };
globalThis.__csim_utf8Decode  = function (a) { return ''; };
globalThis.__rackFetch              = function () { return null; };
globalThis.__locationAssign         = function () { return null; };
globalThis.__locationReload         = function () { return null; };
globalThis.__setTimersActive        = function () { return null; };
globalThis.__setCurrentUrl          = function () { return null; };
globalThis.__pushHistoryEntry       = function () { return null; };
globalThis.__csimReadFilePick       = function () { return null; };
globalThis.__getDocumentCookie      = function () { return ''; };
globalThis.__setDocumentCookie      = function () { return null; };
globalThis.__csim_storageGet        = function () { return null; };
globalThis.__csim_storageSet        = function () { return null; };
globalThis.__csim_storageRemove     = function () { return null; };
globalThis.__csim_storageClear      = function () { return null; };
globalThis.__csim_storageKey        = function () { return null; };
globalThis.__csim_storageLength     = function () { return 0; };
globalThis.__modalDialog            = function () { return null; };
globalThis.__csim_fetchModuleSource = function () { return null; };
globalThis.__csim_pushImportmap     = function () { return null; };
globalThis.__csim_logConsole        = function () { return null; };
// `__csim_evalEsmEntry` is *intentionally not stubbed* — its
// presence on the live VM is the capability signal `bridge.js`'s
// `runModuleScript` checks to decide between native ESM (QuickJS)
// and the lexical-rewrite loader (V8).
// Default JS-side fallback: indirect-eval the body at global scope.
// QuickJSRuntime overrides this with a `Runnable`-cached version
// (process-wide bytecode reuse); V8Runtime keeps the fallback until
// mini_racer exposes `ScriptCompiler::CachedData`. The fallback
// matches what bridge.js used to inline at every call site, so V8
// pays no round-trip until it has caching to offset it.
// `//# sourceURL=…` directive labels eval'd content so V8 stack
// traces report the module URL instead of `<anonymous>`. Keeps the
// indirect-eval (global-scope) semantics intact.
globalThis.__csim_runScript         = function (label, body) {
  (0, eval)(body + '\n//# sourceURL=' + (label || 'csim-eval'));
};
