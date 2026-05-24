// `navigator` global stub + `sendBeacon` (analytics fire-and-forget
// POST) + a Promise-shaped `navigator.clipboard`. The clipboard
// buffer lives module-local and is reachable from the Ruby paste /
// copy paths via `__csimClipboardGet` / `__csimClipboardSet`.

import { serializeRequestBody } from './request-body.js';

// Keyed by MIME type. `text/plain` is the legacy back-compat slot
// (kept primary for `writeText` / `readText`); `text/html` is what
// rich-text editors (ProseMirror, Tiptap) read for paste-as-rich.
let clipboardEntries = {};

export const navigator = {
  // Lead with `Mozilla/5.0` so server-side bot detectors (`browser`
  // gem, ahoy_matey's `Browser.new(ua).bot?`) recognise us as a
  // regular client rather than a crawler. Without it Ahoy's exclude
  // path drops every visit/event we POST. Keep in sync with
  // `Browser::USER_AGENT` in `lib/capybara/simulated/browser.rb`,
  // which sets the same string as `HTTP_USER_AGENT` on the Rack env.
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64; Rails Testing) capybara-simulated (V8-resident DOM)',
  appName:    'Netscape',
  appVersion: '5.0',
  platform:   'Linux',
  language:   'en-US',
  languages:  ['en-US', 'en'],
  onLine:     true,
  cookieEnabled: true,
  // Stimulus `navigator.clipboard.writeText(...)` from
  // `copyToClipboard` / `clipboard#copyPre` resolves cleanly. The
  // buffer is in-process and survives across visits in the same
  // Browser — real browsers share a system clipboard; we just need
  // round-trip parity for the copy-then-paste flow tested by
  // `copy_*_to_clipboard`.
  clipboard: {
    writeText(text) {
      clipboardEntries = { 'text/plain': String(text == null ? '' : text) };
      return Promise.resolve();
    },
    readText() {
      return Promise.resolve(clipboardEntries['text/plain'] || '');
    },
    // ClipboardItem-based write: ProseMirror / Tiptap paste tests
    // round-trip rich content via
    // `navigator.clipboard.write([new ClipboardItem({'text/html': blob, 'text/plain': blob})])`.
    // Capture each MIME slot so the subsequent paste event can
    // surface the right `clipboardData.getData('text/html')`.
    write(items) {
      const next = {};
      const list = Array.isArray(items) ? items : [];
      const pending = [];
      for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const types = Array.isArray(it.types) ? it.types : [];
        for (const t of types) {
          pending.push(
            it.getType(t).then(b => b && typeof b.text === 'function' ? b.text() : '')
              .then(txt => { next[String(t)] = String(txt == null ? '' : txt); })
              .catch(() => {})
          );
        }
      }
      return Promise.all(pending).then(() => {
        clipboardEntries = next;
      });
    },
    read() { return Promise.resolve([]); }
  },
  // PWA registration probes — apps test `'serviceWorker' in navigator`
  // before calling `register(...)`. We return a rejected Promise so the
  // application's "registration failed" branch runs rather than a
  // half-implemented success path.
  serviceWorker: {
    register()         { return Promise.reject(new Error('Service Workers not supported')); },
    getRegistration()  { return Promise.resolve(undefined); },
    getRegistrations() { return Promise.resolve([]); },
    ready: Promise.reject(new Error('Service Workers not supported')),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
  },
  // Permissions API — `navigator.permissions.query({name: …})` is
  // commonly probed before reading the clipboard / using geolocation.
  // Returning `{state: 'prompt'}` lets apps proceed with the request
  // and rely on the request path's own granted/denied feedback.
  permissions: {
    query() { return Promise.resolve({state: 'prompt', addEventListener() {}, removeEventListener() {}, dispatchEvent() {}}); }
  },
  hardwareConcurrency: 4,
  maxTouchPoints: 0,
  doNotTrack: null,
  pdfViewerEnabled: false,
  // `sendBeacon` is what analytics libraries (Ahoy.js, Segment) use
  // to POST a payload at page-unload time without blocking
  // navigation. Real browsers queue the request and fire it
  // asynchronously; we route through `__rackFetch` synchronously
  // which is fine for tests — the assertion that follows the click
  // sees the POST through. Without this method,
  // `typeof navigator.sendBeacon === "undefined"` makes Ahoy.js's
  // `canTrackNow()` return false and the code falls back to
  // `setTimeout(trackEvent, 1000)`, which a fast synchronous test
  // never advances past.
  sendBeacon(url, data) {
    try {
      const headers = {};
      const { body, b64 } = serializeRequestBody(data, headers);
      // Raw-string default: spec says text/plain for `sendBeacon(url, "…")`;
      // `serializeRequestBody` leaves strings as-is without setting a CT.
      if (typeof data === 'string' && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'text/plain;charset=UTF-8';
      }
      if (b64) headers['X-Csim-Body-B64'] = '1';
      const resp = globalThis.__rackFetch('POST', String(url), body, headers, 'follow');
      return !!resp;
    } catch (_) { return false; }
  }
};

// Bridge-internal getters/setters for the paste/copy event paths
// — they live on `globalThis` so the dispatch IIFE can reach them
// without an explicit import.
globalThis.__csimClipboardGet = function (kind) {
  // Default: text/plain (legacy callers passed no arg).
  const t = String(kind || 'text/plain');
  return clipboardEntries[t] || (t === 'text' ? (clipboardEntries['text/plain'] || '') : '');
};
globalThis.__csimClipboardSet = function (text) {
  clipboardEntries = { 'text/plain': String(text == null ? '' : text) };
};
globalThis.__csimClipboardTypes = function () { return Object.keys(clipboardEntries); };

globalThis.navigator = navigator;

// `ClipboardItem` is the global ctor that `navigator.clipboard.write(...)`
// callers wrap each MIME slot in (Discourse's `cdp.copy_test_image`,
// every rich-text editor's paste-an-image-from-clipboard probe).
// Real browsers store a {type → blob} map and expose `types` + an
// async `getType(t)` that returns the Blob. Minimum-viable impl
// keeps `clipboard.write` working without needing real binary support.
globalThis.ClipboardItem = class ClipboardItem {
  constructor(map) {
    this._map = {};
    if (map && typeof map === 'object') {
      for (const k of Object.keys(map)) this._map[String(k)] = map[k];
    }
  }
  get types() { return Object.keys(this._map); }
  getType(type) {
    const v = this._map[String(type)];
    return v ? Promise.resolve(v) : Promise.reject(new Error('NotFoundError'));
  }
};
