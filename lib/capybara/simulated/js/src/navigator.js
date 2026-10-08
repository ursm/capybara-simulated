// `navigator` + `sendBeacon` (analytics fire-and-forget POST); its `clipboard` is clipboard.js's.

import { Event } from './events.js';
import { fireEvent } from './dispatch.js';
import { serviceWorkerContainer } from './sw-client.js';
import { clipboard } from './clipboard.js';
import { beacon } from './fetch.js';
import { credentials } from './webauthn.js';
import { installNavigator } from './generated/bindings.js';
import { PLATFORM, brandPrototype, constructedBy, interfaceCheck, registerInterface, thisIs } from './webidl.js';

const navigatorState = {
  // Lead with `Mozilla/5.0` so server-side bot detectors (`browser`
  // gem, ahoy_matey's `Browser.new(ua).bot?`) recognise us as a
  // regular client rather than a crawler. Without it Ahoy's exclude
  // path drops every visit/event we POST. Keep in sync with
  // `Browser::USER_AGENT` in `lib/capybara/simulated/browser.rb`,
  // which sets the same string as `HTTP_USER_AGENT` on the Rack env.
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 capybara-simulated',
  appName:    'Netscape',
  platform:   'Linux x86_64',
  language:   'en-US',
  languages:  Object.freeze(['en-US', 'en']),   // (…a FrozenArray, the same each time)
  // Tests flip this via `__csimSetOnline(false)` from the CDP
  // `Network.emulateNetworkConditions(offline:true)` shim — fires
  // `online`/`offline` on window so app-level connectivity services
  // (Discourse's NetworkConnectivity) react.
  get onLine() { return globalThis.__csimOnline !== false; },
  cookieEnabled: true,
  clipboard,
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
  // navigation. Routed through fetch()'s keepalive path: the eager
  // dispatch happens inside the fetch() call itself (the detached
  // thread only OUTLIVES teardown), and the settle loop drains its
  // completion — so the assertion that follows a click still sees
  // the POST through, and a controlling service worker observes the
  // request (destination ''). Without this method,
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
    // A ReadableStream body is not a valid beacon payload (spec: TypeError,
    // synchronously — before any quota/queue decision).
    if (typeof globalThis.ReadableStream === 'function' && data instanceof globalThis.ReadableStream) {
      throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Streams are not supported");
    }
    try {
      const p = beacon(u, data);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return true;
    } catch (_) { return false; }
  },
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

// What a user agent says of itself — NavigatorID's, in Chrome's compatibility mode (HTML §8.9.1.1: no Gecko `oscpu` or
// `taintEnabled`), its languages, connectivity and hardware — for a window's Navigator and a worker's WorkerNavigator
// alike (worker-globals.js), from the state above: `appVersion` the user agent after its `Mozilla/`, as Chrome's is.
export const navigatorIdentity = {
  get_appCodeName: () => 'Mozilla',
  get_appName: () => navigatorState.appName,
  get_appVersion: () => navigatorState.userAgent.replace(/^Mozilla\//, ''),
  get_platform: () => navigatorState.platform,
  get_product: () => 'Gecko',
  get_userAgent: () => navigatorState.userAgent,
  get_language: () => navigatorState.language,
  get_languages: () => navigatorState.languages,
  get_onLine: () => navigatorState.onLine,
  get_hardwareConcurrency: () => navigatorState.hardwareConcurrency,
  get_deviceMemory: () => navigatorState.deviceMemory,
  get_globalPrivacyControl: () => navigatorState.globalPrivacyControl,
  get_connection: () => navigatorState.connection,
  get_locks: () => navigatorState.locks,
  get_permissions: () => navigatorState.permissions,
  get_mediaCapabilities: () => navigatorState.mediaCapabilities,
  get_serviceWorker: () => navigatorState.serviceWorker
};
// …and the user agent a test sets (Capybara's `default_user_agent`, browser.rb), which the driver tells every realm it
// makes — each window's, frame's and worker's navigator answers it, as its requests send it.
globalThis.__csimSetUserAgent = function (ua) { navigatorState.userAgent = String(ua); };

// The Navigator interface (HTML §8.9.1), generated from its IDL with the partials implemented here: the page's one
// navigator — any realm's, by the brand its prototype carries, which no prototype is itself.
class Navigator {
  constructor(token) { constructedBy(PLATFORM, token, 'Navigator'); }
}
const NAVIGATOR = brandPrototype(Navigator, 'Navigator');
registerInterface('Navigator', (o) => o !== null && typeof o === 'object' && o[NAVIGATOR] === true && !Object.hasOwn(o, NAVIGATOR));
export const navigator = new Navigator(PLATFORM);
installNavigator(Navigator, {
  ...navigatorIdentity,
  get_productSub: () => '20030107',
  get_vendor: () => 'Google Inc.',
  get_vendorSub: () => '',
  get_cookieEnabled: () => navigatorState.cookieEnabled,
  get_pdfViewerEnabled: () => navigatorState.pdfViewerEnabled,
  javaEnabled: () => false,
  get_maxTouchPoints: () => navigatorState.maxTouchPoints,
  get_userActivation: () => navigatorState.userActivation,
  get_clipboard: () => navigatorState.clipboard,
  get_geolocation: () => navigatorState.geolocation,
  get_mediaDevices: () => navigatorState.mediaDevices,
  get_credentials: () => credentials,
  getGamepads: () => [],
  vibrate: () => false,
  sendBeacon: (self, url, data) => navigatorState.sendBeacon(url, data),
  // (…no protocol-handler registry: the call is taken, its arguments converted, and nothing kept)
  registerProtocolHandler: () => {},
  unregisterProtocolHandler: () => {}
});
// (…and `doNotTrack`, which the spec dropped and Chrome still answers: null, no preference)
Object.defineProperty(Navigator.prototype, 'doNotTrack', {
  ...Object.getOwnPropertyDescriptor(class { get doNotTrack() { thisIs(this, interfaceCheck('Navigator')); return null; } }.prototype, 'doNotTrack'),
  enumerable: true
});
globalThis.Navigator = Navigator;

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
  fireEvent(globalThis, new Event(next ? 'online' : 'offline'));
};
