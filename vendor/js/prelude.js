// Prelude evaluated before the happy-dom bundle. mini_racer's V8 isolate
// is bare ECMA — every Web Platform API needed by happy-dom must be
// provided here. The bundle imports its own URL implementation from the
// `url` shim, so the polyfills below only cover the truly global APIs.

(function () {
  // ---- TextEncoder / TextDecoder (UTF-8 only) ---------------------------
  if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
      get encoding() { return 'utf-8'; }
      encode(str) {
        const s = String(str || '');
        const bytes = [];
        for (let i = 0; i < s.length; i++) {
          let cp = s.charCodeAt(i);
          if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
            cp = ((cp - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00) + 0x10000;
          }
          if (cp < 0x80) bytes.push(cp);
          else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
          else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        }
        return new Uint8Array(bytes);
      }
    };
  }
  if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
      constructor(encoding = 'utf-8') { this.encoding = String(encoding).toLowerCase(); }
      decode(buf) {
        if (buf == null) return '';
        const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
        let out = '';
        let i = 0;
        while (i < arr.length) {
          const b1 = arr[i++];
          if (b1 < 0x80) out += String.fromCharCode(b1);
          else if (b1 < 0xc0) continue;
          else if (b1 < 0xe0) {
            const b2 = arr[i++] & 0x3f;
            out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
          } else if (b1 < 0xf0) {
            const b2 = arr[i++] & 0x3f;
            const b3 = arr[i++] & 0x3f;
            out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
          } else {
            const b2 = arr[i++] & 0x3f;
            const b3 = arr[i++] & 0x3f;
            const b4 = arr[i++] & 0x3f;
            let cp = ((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4;
            cp -= 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          }
        }
        return out;
      }
    };
  }

  // ---- atob / btoa ------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (typeof globalThis.atob === 'undefined') {
    globalThis.atob = (input) => {
      const str = String(input).replace(/[\t\n\f\r ]+/g, '').replace(/=+$/, '');
      if (str.length % 4 === 1) throw new Error('Invalid base64');
      let out = '', buffer = 0, bits = 0;
      for (const ch of str) {
        const idx = B64.indexOf(ch);
        if (idx === -1) throw new Error('Invalid base64 character');
        buffer = (buffer << 6) | idx;
        bits += 6;
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 0xff); }
      }
      return out;
    };
  }
  if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = (input) => {
      const str = String(input);
      let out = '', buffer = 0, bits = 0;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code > 0xff) throw new Error('btoa: non-Latin1 character');
        buffer = (buffer << 8) | code;
        bits += 8;
        while (bits >= 6) { bits -= 6; out += B64[(buffer >> bits) & 0x3f]; }
      }
      if (bits > 0) out += B64[(buffer << (6 - bits)) & 0x3f];
      while (out.length % 4) out += '=';
      return out;
    };
  }

  // ---- crypto (subset) --------------------------------------------------
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 0x100000000) >>> 0;
        return arr;
      },
      randomUUID() {
        const r = (n) => Math.floor(Math.random() * (1 << n)).toString(16).padStart(n / 4, '0');
        return `${r(32)}-${r(16)}-${r(16)}-${r(16)}-${r(48)}`;
      },
      subtle: {}
    };
  }

  // ---- timers (no real event loop) -------------------------------------
  const _timers = new Map();
  let _nextTimer = 0;
  let _virtualClock = 0;

  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = ++_nextTimer;
    const delay = Math.max(0, Number(ms) || 0);
    _timers.set(id, {fn: () => fn.apply(null, args), at: _virtualClock + delay});
    return id;
  };
  globalThis.clearTimeout = (id) => _timers.delete(id);
  globalThis.setInterval = globalThis.setTimeout;
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = globalThis.clearTimeout;
  globalThis.queueMicrotask = globalThis.queueMicrotask || ((fn) => Promise.resolve().then(fn));

  // Advance the virtual clock by `ms` and run any timer whose deadline has
  // passed. Iteratively flushes nested setTimeout(0) chains so a callback
  // that schedules another runs in the same tick.
  globalThis.__csim_runTimers = function (ms) {
    const advance = (typeof ms === 'number') ? Math.max(0, ms) : Infinity;
    _virtualClock += advance;
    while (true) {
      let fired = false;
      const due = [];
      for (const [id, t] of _timers) if (t.at <= _virtualClock) due.push([id, t]);
      due.sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        if (!_timers.has(id)) continue;
        _timers.delete(id);
        try { t.fn(); } catch (_) {}
        fired = true;
      }
      if (!fired) break;
    }
  };
  globalThis.__csim_clearTimers = function () {
    _timers.clear();
    _virtualClock = 0;
  };

  globalThis.navigator = globalThis.navigator || {userAgent: 'Mozilla/5.0 capybara-simulated'};

  if (typeof globalThis.performance === 'undefined') {
    globalThis.performance = {
      now: () => Date.now(),
      timeOrigin: Date.now(),
      mark() {}, measure() {}, clearMarks() {}, clearMeasures() {},
      getEntries: () => [], getEntriesByName: () => [], getEntriesByType: () => []
    };
  }
  if (typeof globalThis.location === 'undefined') {
    globalThis.location = {
      href: 'http://www.example.com/', origin: 'http://www.example.com',
      protocol: 'http:', host: 'www.example.com', hostname: 'www.example.com',
      port: '', pathname: '/', search: '', hash: '',
      assign() {}, replace() {}, reload() {}, toString() { return this.href; }
    };
  }

  // happy-dom and many polyfills assume `process` exists.
  if (typeof globalThis.process === 'undefined') {
    globalThis.process = {
      env: {NODE_ENV: 'production'},
      platform: 'browser',
      version: 'v20.0.0',
      versions: {node: '20.0.0'},
      nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
      cwd: () => '/',
      argv: []
    };
  }

  if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;
})();
