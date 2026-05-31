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
globalThis.__historyLength          = function () { return 1; };
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
globalThis.__csim_pushImportmap     = function () { return null; };
globalThis.__csim_logConsole        = function () { return null; };
globalThis.__csim_eventSourceOpen   = function () { return 0; };
globalThis.__csim_eventSourceClose  = function () { return null; };
globalThis.__csim_workerSpawn       = function () { return 0; };
globalThis.__csim_workerPostToWorker= function () { return null; };
globalThis.__csim_workerTerminate   = function () { return null; };
globalThis.__csim_workerPostMessage = function () { return null; };
globalThis.__csim_decodeImage       = function () { return null; };
globalThis.__csim_blobRegister      = function () { return null; };
globalThis.__csim_blobResolve       = function () { return null; };
globalThis.__csim_blobUnregister    = function () { return null; };
// Default classic-script runner: indirect-eval at global scope. Both
// runtimes override this with a bytecode-caching host fn at attach
// time. `//# sourceURL=…` labels eval'd content so stack traces
// report the script URL instead of `<anonymous>`.
globalThis.__csim_runScript         = function (label, body) {
  (0, eval)(body + '\n//# sourceURL=' + (label || 'csim-eval'));
};
