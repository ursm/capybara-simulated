// `navigator` global stub + `sendBeacon` (analytics fire-and-forget
// POST) + a Promise-shaped `navigator.clipboard`. The clipboard
// buffer lives module-local and is reachable from the Ruby paste /
// copy paths via `__csimClipboardGet` / `__csimClipboardSet`.

import { serializeRequestBody } from './request-body.js';
import { latin1ToBytes } from './bytes.js';
import { serviceWorkerContainer } from './sw-client.js';

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
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 capybara-simulated',
  appName:    'Netscape',
  appVersion: '5.0',
  platform:   'Linux',
  language:   'en-US',
  languages:  ['en-US', 'en'],
  // Tests flip this via `__csimSetOnline(false)` from the CDP
  // `Network.emulateNetworkConditions(offline:true)` shim — fires
  // `online`/`offline` on window so app-level connectivity services
  // (Discourse's NetworkConnectivity) react.
  get onLine() { return globalThis.__csimOnline !== false; },
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
  // navigator.serviceWorker — a real ServiceWorkerContainer (registration +
  // lifecycle) modeled ONLY in a universal-server context (the WPT runner). In a
  // real app, register() rejects (SecurityError) so the app's registration-failed
  // branch runs rather than a half-modeled success path. See sw-client.js.
  serviceWorker: serviceWorkerContainer,
  // Permissions API — `navigator.permissions.query({name: …})` is
  // commonly probed before reading the clipboard / using geolocation.
  // Returning `{state: 'prompt'}` lets apps proceed with the request
  // and rely on the request path's own granted/denied feedback.
  permissions: {
    query(descriptor) {
      let state = 'prompt';
      if (descriptor && descriptor.name === 'geolocation') {
        const cfg = __csimReadGeolocationState();
        if (cfg && cfg.denied) {
          state = 'denied';
        } else if (cfg && (cfg.coords || typeof cfg.latitude === 'number')) {
          state = 'granted';
        }
      }
      return Promise.resolve({state, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}});
    },
    // Proposed `permissions.request(descriptor)` resolves a
    // PermissionStatus the same way `query` does — same shape, same
    // geolocation-aware state — since we have no real prompt UI.
    request(descriptor) { return this.query(descriptor); },
    // Legacy `permissions.revoke({name})` resets a permission back to
    // its default prompt state and resolves with the new status. We
    // have no persistent grant store, so report `prompt` unconditionally.
    revoke() { return Promise.resolve({state: 'prompt'}); }
  },
  // Geolocation API. The configured position / denial state is Ruby-backed
  // (set via `page.driver.set_geolocation(...)`) and read on every call
  // through the `__csimGeolocationState` host fn — this survives the per-call
  // VM rebuilds, the way web storage does.
  //
  // Delivery is SYNCHRONOUS, a deliberate parity trade-off. Real browsers
  // fire the callback asynchronously (a task after the current script). We
  // cannot defer through the virtual clock here: a 0-delay timer only fires
  // when `tick_real_time` advances the clock, and the wall-clock step between
  // the `execute_script` that calls getCurrentPosition and the follow-up
  // `evaluate_script` that reads the result rounds to 0 ms on a warm run, so
  // the callback would non-deterministically not have fired yet (flaky). The
  // hot-path alternatives (always draining ready timers, or a per-tick
  // ready-timer probe) regress the find path. Synchronous delivery is
  // deterministic and observationally identical for the only thing that reads
  // a geolocation result here — Capybara, after the call returns. The single
  // observable difference (app code reading state between the call and the end
  // of the current task, expecting the callback NOT to have run) is a pattern
  // no realistic page depends on, and matches the driver's other pragmatic
  // sync shims (sendBeacon, fetch-via-Rack).
  geolocation: {
    getCurrentPosition(success, error) {
      __csimDeliverGeolocation(success, error);
    },
    watchPosition(success, error) {
      const id = ++__csimGeoWatchSeq;
      __csimGeoWatches.set(id, {id, success, error});
      __csimDeliverGeolocation(success, error);
      return id;
    },
    clearWatch(id) {
      __csimGeoWatches.delete(id);
    }
  },
  hardwareConcurrency: 4,
  maxTouchPoints: 0,
  doNotTrack: null,
  pdfViewerEnabled: false,
  // Device Memory API — a coarse RAM hint in GiB, capped at 8 by the
  // spec. Static value; some analytics / adaptive-loading libraries
  // read it before deciding how much to prefetch.
  deviceMemory: 8,
  // Global Privacy Control — a boolean opt-out signal. We are not a
  // GPC-enabled client, so report `false`.
  globalPrivacyControl: false,
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
    const u = String(url == null ? '' : url);
    // Spec: parse `url` against the document base; a parse FAILURE throws a
    // TypeError synchronously (before the fire-and-forget fetch) — must be
    // OUTSIDE the catch below, which swallows network errors into `false`.
    const base = (globalThis.location && globalThis.location.href) || undefined;
    if (globalThis.__csim_urlIsMalformed(u, base)) {
      throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Invalid URL");
    }
    try {
      const headers = {};
      const { body, b64 } = serializeRequestBody(data, headers);
      // serializeRequestBody applies the spec default Content-Type per body type —
      // text/plain;charset=UTF-8 for a `sendBeacon(url, "…")` string, etc.
      if (b64) headers['X-Csim-Body-B64'] = '1';
      const resp = globalThis.__rackFetch('POST', String(url), body, headers, 'follow');
      return !!resp;
    } catch (_) { return false; }
  },
  // `registerProtocolHandler` / `unregisterProtocolHandler`: we don't maintain a
  // protocol-handler registry, but the methods must exist and accept their
  // USVString `url` (unpaired surrogates → U+FFFD) without throwing for a
  // well-formed call (custom scheme + a `%s`-bearing URL).
  registerProtocolHandler(_scheme, _url, _title) {
    if (globalThis.__csimToUSVString && _url != null) globalThis.__csimToUSVString(_url);
  },
  unregisterProtocolHandler(_scheme, _url) {
    if (globalThis.__csimToUSVString && _url != null) globalThis.__csimToUSVString(_url);
  },
  // Legacy `navigator.vibrate(pattern)` — no haptics; report that the
  // request was not honoured.
  vibrate() { return false; },
  // Long-deprecated `javaEnabled()` / `taintEnabled()` — always false.
  javaEnabled() { return false; },
  taintEnabled() { return false; },
  // Gamepad API — no connected gamepads.
  getGamepads() { return []; },
  // NetworkInformation stub. `navigator.connection.effectiveType` is
  // read by adaptive-loading / lazy-image libraries to decide quality;
  // report a fast, unmetered connection.
  connection: {
    effectiveType: '4g',
    rtt:           50,
    downlink:      10,
    downlinkMax:   Infinity,
    saveData:      false,
    type:          'wifi',
    onchange:      null,
    addEventListener()    {},
    removeEventListener() {},
    dispatchEvent()       { return true; }
  },
  // UserActivation — `isActive` is the transient activation flag (granted by
  // test_driver.bless, consumed by activation-gated APIs like showPicker);
  // `hasBeenActive` the sticky one (a real visited page).
  userActivation: {
    get isActive()      { return !!globalThis.__csimTransientActivation; },
    get hasBeenActive() { return true; }
  },
  // MediaDevices stub — no camera / microphone. Enumerate yields an
  // empty list and capture requests reject with NotAllowedError, the
  // same as a headless browser with no media permissions.
  mediaDevices: {
    enumerateDevices() { return Promise.resolve([]); },
    getUserMedia()     { return Promise.reject(new globalThis.DOMException('Permission denied', 'NotAllowedError')); },
    getDisplayMedia()  { return Promise.reject(new globalThis.DOMException('Permission denied', 'NotAllowedError')); },
    getSupportedConstraints() { return {}; },
    addEventListener()    {},
    removeEventListener() {},
    dispatchEvent()       { return true; },
    ondevicechange: null
  },
  // Media Capabilities — report nothing as supported / smooth / power
  // efficient so apps fall back to their baseline codec path.
  mediaCapabilities: {
    decodingInfo() { return Promise.resolve({supported: false, smooth: false, powerEfficient: false}); },
    encodingInfo() { return Promise.resolve({supported: false, smooth: false, powerEfficient: false}); }
  },
  // Web Locks API. `request(name, opts?, cb)` grants the lock
  // immediately (no contention in a single VM) and runs the callback
  // on a microtask; `query()` reports no held / pending locks.
  locks: {
    request(name, optsOrCb, maybeCb) {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      // Echo the requested mode ('shared' / 'exclusive') back on the granted
      // lock — SDKs that branch reader-vs-writer on `lock.mode` need parity.
      const opts = (optsOrCb && typeof optsOrCb === 'object') ? optsOrCb : {};
      const mode = opts.mode === 'shared' ? 'shared' : 'exclusive';
      return Promise.resolve().then(() => cb({name: name, mode: mode}));
    },
    query() { return Promise.resolve({held: [], pending: []}); }
  }
};

// Bridge-internal getters/setters for the paste/copy event paths
// — they live on `globalThis` so the dispatch IIFE can reach them
// without an explicit import.
// Synchronous text accessor for the paste-event default-action path.
// `Blob.text()` is async per spec, so we peek at `_parts` (our Blob's
// internal storage) for the sync read. `_parts` hold UTF-8-encoded bytes
// (latin-1 byte-strings), so concatenate and UTF-8-decode to recover the
// original text — without decoding, non-ASCII text pastes as mojibake.
// Binary Blobs (image/*) don't reach this path (only text/* entries do).
globalThis.__csimClipboardGet = function (kind) {
  const t = String(kind || 'text/plain');
  const b = clipboardEntries[t] || (t === 'text' ? clipboardEntries['text/plain'] : null);
  if (!b) return '';
  if (typeof b === 'string') return b;  // legacy callers may have set a string
  if (b._parts && b._parts.length) {
    let bytes = '';
    for (const p of b._parts) {
      if (typeof p === 'string') bytes += p;
    }
    try {
      return new globalThis.TextDecoder().decode(latin1ToBytes(bytes));
    } catch (_) {
      return bytes;
    }
  }
  return '';
};
globalThis.__csimClipboardSet = function (text) {
  const s = String(text == null ? '' : text);
  clipboardEntries = { 'text/plain': new globalThis.Blob([s], {type: 'text/plain'}) };
};
// Multi-flavor write: a rich (contenteditable) cut / copy stores both text/plain
// and text/html, so a later paste's dataTransfer can round-trip the original
// markup (input-events-cut-paste asserts `getData('text/html')` recovers the
// copied `<b>rich</b>`). Empty flavors are skipped so a plain-text selection
// never leaves a spurious empty text/html entry on the clipboard.
globalThis.__csimClipboardSetData = function (map) {
  const next = {};
  const m = map || {};
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (v == null || v === '') continue;
    next[String(k)] = new globalThis.Blob([String(v)], {type: String(k)});
  }
  // Copying an empty selection is a no-op — leave the existing clipboard intact
  // rather than wiping it (real browsers don't clear the clipboard when there's
  // nothing to copy).
  if (Object.keys(next).length === 0) return;
  clipboardEntries = next;
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

// --- Geolocation state + delivery -----------------------------------------
//
// The override state is Ruby-backed (set via `page.driver.set_geolocation`)
// and read on every call through the `__csimGeolocationState` host fn, which
// returns a JSON string of `{coords: {...}} | {denied: true} | null`. Reading
// it fresh each call means it survives the per-call VM rebuilds and always
// reflects the latest `set_geolocation`. With nothing configured (null),
// getCurrentPosition / watchPosition report POSITION_UNAVAILABLE (code 2) —
// what a headless browser with no location source does; `{denied: true}`
// reports PERMISSION_DENIED (code 1).
const __CSIM_GEO_PERMISSION_DENIED = 1;
const __CSIM_GEO_POSITION_UNAVAILABLE = 2;
const __CSIM_GEO_TIMEOUT = 3;

let __csimGeoWatchSeq = 0;
const __csimGeoWatches = new Map();

function __csimReadGeolocationState() {
  try {
    const json = globalThis.__csimGeolocationState();
    return json ? JSON.parse(json) : null;
  } catch (_) {
    return null;
  }
}

// Build a fresh GeolocationPosition from the configured override, filling
// spec defaults for any unset coordinate field. Returns null when nothing
// usable is configured.
function __csimMakeGeolocationPosition(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.denied) return null;
  const c = cfg.coords || cfg;
  if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return null;
  return {
    coords: {
      latitude:         c.latitude,
      longitude:        c.longitude,
      accuracy:         typeof c.accuracy === 'number' ? c.accuracy : 10,
      altitude:         typeof c.altitude === 'number' ? c.altitude : null,
      altitudeAccuracy: typeof c.altitudeAccuracy === 'number' ? c.altitudeAccuracy : null,
      heading:          typeof c.heading === 'number' ? c.heading : null,
      speed:            typeof c.speed === 'number' ? c.speed : null
    },
    timestamp: typeof cfg.timestamp === 'number' ? cfg.timestamp : Date.now()
  };
}

function __csimMakeGeolocationError(code, message) {
  return {
    code,
    message,
    PERMISSION_DENIED:    __CSIM_GEO_PERMISSION_DENIED,
    POSITION_UNAVAILABLE: __CSIM_GEO_POSITION_UNAVAILABLE,
    TIMEOUT:              __CSIM_GEO_TIMEOUT
  };
}

// Resolve the current Ruby-backed state into a success position or an error.
function __csimDeliverGeolocation(success, error) {
  const cfg = __csimReadGeolocationState();
  if (cfg && cfg.denied) {
    if (typeof error === 'function') {
      error(__csimMakeGeolocationError(__CSIM_GEO_PERMISSION_DENIED, 'User denied Geolocation'));
    }
    return;
  }
  const position = __csimMakeGeolocationPosition(cfg);
  if (position) {
    if (typeof success === 'function') success(position);
    return;
  }
  if (typeof error === 'function') {
    error(__csimMakeGeolocationError(__CSIM_GEO_POSITION_UNAVAILABLE, 'Position unavailable'));
  }
}

// Called from the Ruby `set_geolocation` (via execute_script) after the
// override changes, so active watches re-deliver — mirroring a real browser
// firing watchPosition again when the location updates. Delivery is
// synchronous because this runs inside the test-control call (CDP-ish, like
// `Emulation.setGeolocationOverride`), not app code, so the new value is
// observable as soon as `set_geolocation` returns.
globalThis.__csimGeoRefireWatches = function () {
  for (const w of Array.from(__csimGeoWatches.values())) {
    if (__csimGeoWatches.has(w.id)) __csimDeliverGeolocation(w.success, w.error);
  }
};

globalThis.__csimSetOnline = function (online) {
  const next = !!online;
  const prev = globalThis.__csimOnline !== false;
  if (next === prev) return;
  globalThis.__csimOnline = next;
  try {
    const evt = new globalThis.Event(next ? 'online' : 'offline', { bubbles: false, cancelable: false });
    globalThis.dispatchEvent(evt);
  } catch (_) {}
};

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
