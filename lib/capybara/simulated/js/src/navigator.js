// `navigator` global stub + `sendBeacon` (analytics fire-and-forget
// POST) + a Promise-shaped `navigator.clipboard`. The clipboard
// buffer lives module-local and is reachable from the Ruby paste /
// copy paths via `__csimClipboardGet` / `__csimClipboardSet`.

import { serializeRequestBody } from './request-body.js';

// Keyed by MIME type. Values are Blobs so we can keep both text
// content (text/plain, text/html via `.text()`) and binary content
// (image/png etc. via `.arrayBuffer()` / files) in one map.
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
      const s = String(text == null ? '' : text);
      clipboardEntries = { 'text/plain': new globalThis.Blob([s], {type: 'text/plain'}) };
      return Promise.resolve();
    },
    readText() {
      const b = clipboardEntries['text/plain'];
      return b ? b.text() : Promise.resolve('');
    },
    // ClipboardItem-based write: ProseMirror / Tiptap paste tests
    // round-trip rich content via
    // `navigator.clipboard.write([new ClipboardItem({'text/html': blob, 'text/plain': blob})])`,
    // and Discourse's `cdp.copy_test_image` writes an `image/png`
    // Blob alongside a `text/html` placeholder for image-paste
    // tests. Store the Blob directly so binary MIMEs (image/*) are
    // surfaced through `clipboardData.files` while text MIMEs stay
    // readable via `Blob.text()`.
    write(items) {
      const next = {};
      const list = Array.isArray(items) ? items : [];
      const pending = [];
      for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const types = Array.isArray(it.types) ? it.types : [];
        for (const t of types) {
          pending.push(
            it.getType(t).then(b => { next[String(t)] = b; }).catch(() => {})
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
// Synchronous text accessor for the paste-event default-action path.
// `Blob.text()` is async per spec, so we peek at `_parts` (our
// Blob's internal storage of the string fragments it was created
// from) for the sync read. Binary Blobs (image/*) return ''.
globalThis.__csimClipboardGet = function (kind) {
  const t = String(kind || 'text/plain');
  const b = clipboardEntries[t] || (t === 'text' ? clipboardEntries['text/plain'] : null);
  if (!b) return '';
  if (typeof b === 'string') return b;  // legacy callers may have set a string
  if (b._parts && b._parts.length) {
    let out = '';
    for (const p of b._parts) {
      if (typeof p === 'string') out += p;
    }
    return out;
  }
  return '';
};
globalThis.__csimClipboardSet = function (text) {
  const s = String(text == null ? '' : text);
  clipboardEntries = { 'text/plain': new globalThis.Blob([s], {type: 'text/plain'}) };
};
globalThis.__csimClipboardTypes = function () { return Object.keys(clipboardEntries); };
// Return Files (only entries with non-text MIME types) for the
// `clipboardData.files` slot in the paste event. Real browsers give
// each clipboard binary a `File` (not a `Blob`), with a synthesised
// name like "image.png". Discourse's PM paste handler filters by
// `file.name` / `file.type` to decide between processing the binary
// vs. falling back to text/html — naming the entries is required
// for the file-precedes-html branch to fire.
const __EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'application/zip': 'zip',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm'
};
globalThis.__csimClipboardFiles = function () {
  const out = [];
  for (const t of Object.keys(clipboardEntries)) {
    if (t === 'text/plain' || t === 'text/html' || t === 'text/uri-list') continue;
    const b = clipboardEntries[t];
    if (!b) continue;
    if (b instanceof globalThis.File) { out.push(b); continue; }
    const kind = String(t).split('/')[0] || 'file';
    const ext  = __EXT_BY_MIME[t] || 'bin';
    const name = `${kind}.${ext}`;
    out.push(new globalThis.File([b], name, { type: t }));
  }
  return out;
};

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
