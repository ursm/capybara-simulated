// Catch-all stub for Node modules happy-dom imports but our driver never
// actually exercises (fs, http, https, child_process, ws, zlib, ...). The
// values are just enough to satisfy `import default` and named-import shapes.
const noop = () => undefined;
const stub = new Proxy(function () {}, {
  get(target, prop) {
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === 'default') return stub;
    return stub;
  },
  apply() { return undefined; },
  construct() { return {}; }
});

export default stub;
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const isIP = () => 0;
export const Readable = stub;
export const Writable = stub;
export const Duplex = stub;
export const Transform = stub;
export const PassThrough = stub;
export const pipeline = noop;
export const finished = noop;
export const promisify = (fn) => (...args) => Promise.resolve(fn && fn(...args));
export const inherits = noop;
export const debuglog = () => noop;
export const types = {};
export const ReadableStream = globalThis.ReadableStream || stub;
export const WritableStream = globalThis.WritableStream || stub;
export const TransformStream = globalThis.TransformStream || stub;
export const webcrypto = globalThis.crypto || stub;
export const randomBytes = (n) => new Uint8Array(n);
export const randomUUID = () => globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : '00000000-0000-0000-0000-000000000000';
export const subtle = (globalThis.crypto && globalThis.crypto.subtle) || stub;
export const constants = {};
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
class StubObserver {
  constructor() {}
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
  unobserve() {}
}
export const PerformanceObserver = globalThis.PerformanceObserver || StubObserver;
export const PerformanceEntry = globalThis.PerformanceEntry || class PerformanceEntry {};
export const performance = globalThis.performance || {now: () => Date.now()};
