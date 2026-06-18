// Stub host fns so bridge.js can be baked into a Snapshot (V8) /
// compiled to bytecode (QuickJS) without the real Ruby-side hosts
// being attached yet. Real implementations land at Context build
// time via the engine's attach API. Only the host fns bridge.js
// actually invokes appear here — if you add a new host fn, add the
// matching stub here too.
Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window' });

// The vendored whatwg-url engine captures `SharedArrayBuffer` and a
// `TextEncoder`/`TextDecoder` at module-load time = snapshot-BUILD time here —
// and the V8 snapshot context exposes neither (SharedArrayBuffer is
// Spectre-disabled; our real TextEncoder lives in bridge's encoding.js, which
// loads AFTER the vendor bundle). Provide them before the vendor bundle so
// whatwg-url bakes cleanly. SharedArrayBuffer is only touched by whatwg-url's
// (unused-for-URL) WebIDL buffer-type guard, so aliasing it to ArrayBuffer is
// fine. The TextEncoder/TextDecoder MUST be real UTF-8 — whatwg-url captures
// them in a module closure and uses them for percent-encoding at runtime (the
// bridge's full encoding.js later overrides `globalThis.TextEncoder` for app
// code, but whatwg-url keeps the instance it captured here).
globalThis.SharedArrayBuffer = globalThis.SharedArrayBuffer || globalThis.ArrayBuffer;
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(str) {
      str = String(str === undefined ? '' : str);
      const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.codePointAt(i);
        if (c > 0xffff) i++;                            // surrogate pair — skip the low half
        else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // unpaired surrogate → U+FFFD (WHATWG)
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return new Uint8Array(out);
    }
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    constructor() {}
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (!input) return '';
      const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input);
      let s = '';
      for (let i = 0; i < b.length;) {
        let c = b[i++];
        if (c >= 0xf0)      c = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        else if (c >= 0xe0) c = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        else if (c >= 0xc0) c = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
        s += String.fromCodePoint(c);
      }
      return s;
    }
  };
}
// parse5 unpacks its base64-packed named-character-reference table with `atob`
// AT MODULE-LOAD = snapshot-BUILD time here, and the V8 snapshot context has no
// `atob`. Provide a correct RFC 4648 base64 decoder (+ encoder) before the
// vendor bundle so parse5's table bakes correctly. The bridge's encoding.js
// later overrides `globalThis.atob`/`btoa` for app code; parse5 keeps only the
// decoded table (no reference to atob), so this stub only matters at build time.
if (typeof globalThis.atob === 'undefined') {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.atob = function (input) {
    const s = String(input).replace(/[ \t\n\f\r=]/g, '');
    let out = '', acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64.indexOf(s[i]);
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
    }
    return out;
  };
  globalThis.btoa = function (input) {
    const s = String(input); let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i);
      const b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      const c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      const e1 = a >> 2;
      const e2 = ((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4);
      const e3 = isNaN(b) ? 64 : (((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6));
      const e4 = isNaN(c) ? 64 : c & 63;
      out += B64[e1] + B64[e2] + (e3 === 64 ? '=' : B64[e3]) + (e4 === 64 ? '=' : B64[e4]);
    }
    return out;
  };
}
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
// Geolocation override state; JSON string ('null' = no override configured).
globalThis.__csimGeolocationState   = function () { return 'null'; };
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
