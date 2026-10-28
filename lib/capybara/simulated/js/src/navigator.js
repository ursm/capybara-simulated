// `navigator` + `sendBeacon` (analytics fire-and-forget POST); its `clipboard` is clipboard.js's.

import { Event } from './events.js';
import { fireEvent } from './dispatch.js';
import { serviceWorkerContainer } from './sw-client.js';
import { clipboard } from './clipboard.js';
import { beacon } from './fetch.js';
import { credentials } from './webauthn.js';
import { lockManager } from './locks.js';
import { geolocation, permissions } from './geolocation.js';
import { defineMimeType, defineMimeTypeArray, definePlugin, definePluginArray, installNavigator } from './generated/bindings.js';
import {
  PLATFORM, constructedBy, interfaceCheck, makeSlots, ownRealm, registerInterface, rejectedPromise, resolvedPromise,
  slotsOf, thisIs
} from './webidl.js';
import { DOMException } from './dom-exception.js';
import { apiBaseURL } from './platform-globals.js';
import { opaqueOriginRefusal } from './document-origin.js';
import { parseURL } from './url-parse.js';

// (…a stream of any realm's, by its brand: not the `ReadableStream` its page may have replaced)
const isReadableStream = interfaceCheck('ReadableStream');

// What `__dom.userActivation` asks of the window (user_activation.rs).
const ACTIVATION_STICKY = 0, ACTIVATION_TRANSIENT = 1;

// What the navigator says of the user agent, the engine's (navigator.rs): its user agent string and the `appVersion`
// taken from it, and whether it is online.
const USER_AGENT_STRING = 0, APP_VERSION = 1;
const navigatorState = {
  appName:    'Netscape',
  platform:   'Linux x86_64',
  language:   'en-US',
  languages:  Object.freeze(['en-US', 'en']),   // (…a FrozenArray, the same each time)
  cookieEnabled: true,
  clipboard,
  // navigator.serviceWorker — a real ServiceWorkerContainer (registration +
  // lifecycle) modeled ONLY in a universal-server context (the WPT runner). In a
  // real app, register() rejects (SecurityError) so the app's registration-failed
  // branch runs rather than a half-modeled success path. See sw-client.js.
  serviceWorker: serviceWorkerContainer,
  // (…the Permissions API's and the Geolocation API's, geolocation.js)
  permissions,
  geolocation,
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
    // Spec: parse `url` against the relevant settings object's API base URL (its document's base URL); a parse FAILURE
    // throws a TypeError synchronously (before the fire-and-forget fetch) — must be OUTSIDE the catch below, which
    // swallows network errors into `false`.
    if (parseURL(u, apiBaseURL()) === null) {
      throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Invalid URL");
    }
    // A ReadableStream body is not a valid beacon payload (spec: TypeError,
    // synchronously — before any quota/queue decision).
    if (isReadableStream(data)) {
      throw new TypeError("Failed to execute 'sendBeacon' on 'Navigator': Streams are not supported");
    }
    try {
      return beacon(u, data);
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
  // UserActivation: whether the window has transient activation (which an activation-gated API like showPicker
  // consumes) and sticky activation — the engine's (user_activation.rs).
  userActivation: {
    get isActive()      { return globalThis.__dom.userActivation(ACTIVATION_TRANSIENT); },
    get hasBeenActive() { return globalThis.__dom.userActivation(ACTIVATION_STICKY); }
  },
  // MediaDevices stub — no camera / microphone. Enumerate yields an
  // empty list and capture requests reject with NotAllowedError, the
  // same as a headless browser with no media permissions.
  mediaDevices: {
    enumerateDevices() { return resolvedPromise([]); },
    getUserMedia()     { return rejectedPromise(new DOMException('Permission denied', 'NotAllowedError')); },
    getDisplayMedia()  { return rejectedPromise(new DOMException('Permission denied', 'NotAllowedError')); },
    getSupportedConstraints() { return {}; },
    addEventListener()    {},
    removeEventListener() {},
    dispatchEvent()       { return true; },
    ondevicechange: null
  },
  // Media Capabilities — report nothing as supported / smooth / power
  // efficient so apps fall back to their baseline codec path.
  mediaCapabilities: {
    decodingInfo() { return resolvedPromise({supported: false, smooth: false, powerEfficient: false}); },
    encodingInfo() { return resolvedPromise({supported: false, smooth: false, powerEfficient: false}); }
  },
};

// What a user agent says of itself — NavigatorID's, in Chrome's compatibility mode (HTML §8.9.1.1: no Gecko `oscpu` or
// `taintEnabled`), its languages, connectivity and hardware — for a window's Navigator and a worker's WorkerNavigator
// alike (worker-globals.js), from the state above: `appVersion` the user agent after its `Mozilla/`, as Chrome's is.
export const navigatorIdentity = {
  get_appCodeName: () => 'Mozilla',
  get_appName: () => navigatorState.appName,
  get_appVersion: () => globalThis.__dom.userAgent(APP_VERSION),
  get_platform: () => navigatorState.platform,
  get_product: () => 'Gecko',
  get_userAgent: () => globalThis.__dom.userAgent(USER_AGENT_STRING),
  get_language: () => navigatorState.language,
  get_languages: () => navigatorState.languages,
  get_onLine: () => globalThis.__dom.onLine(),
  get_hardwareConcurrency: () => navigatorState.hardwareConcurrency,
  get_deviceMemory: () => navigatorState.deviceMemory,
  get_globalPrivacyControl: () => navigatorState.globalPrivacyControl,
  get_connection: () => navigatorState.connection,
  get_locks: () => lockManager(),
  get_permissions: () => navigatorState.permissions,
  get_mediaCapabilities: () => navigatorState.mediaCapabilities,
  // (…none for a document of an opaque origin, a SecurityError: the spec silent, Chrome's words, measured — a `data:`
  // document's undefined there, as it is no secure context, which here every document is)
  get_serviceWorker() {
    const why = opaqueOriginRefusal({
      sandboxed: "Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
      other:     'Access to service workers is denied in this document origin.'
    });
    if (why) throw new DOMException(`Failed to read the 'serviceWorker' property from 'Navigator': ${why}`, 'SecurityError');
    return navigatorState.serviceWorker;
  }
};
// …and the user agent a test sets (Capybara's `default_user_agent`, browser.rb), which the driver tells every realm it
// makes — each window's, frame's and worker's navigator answers it, as its requests send it.
globalThis.__csimSetUserAgent = (ua) => globalThis.__dom.setUserAgent(String(ua));

// The Navigator interface (HTML §8.9.1), generated from its IDL with the partials implemented here: the page's one
// navigator — any realm's, by its slots, which carry the realm it is of (`ownRealm` below).
class Navigator {
  constructor(token) { constructedBy(PLATFORM, token, 'Navigator'); }
}
registerInterface('Navigator', (o) => slotsOf(o, 'Navigator') !== undefined);
const REALM = {};
export const navigator = new Navigator(PLATFORM);
makeSlots(navigator, 'Navigator', { realm: REALM });
// `navigator.plugins` and `navigator.mimeTypes` (HTML §8.9.1.6 "PDF viewing support"), generated from their IDL: the PDF
// viewer plugins and their MIME types where the user agent views PDFs inline — none here (`pdfViewerEnabled` false), so
// each list is empty, one object for the navigator's life ([SameObject]), and no Plugin or MimeType is ever made.
const EMPTY_LIST = { init() {}, get_length: () => 0, item: () => null, namedItem: () => null };
const pluginArray = definePluginArray({ ...EMPTY_LIST, refresh() {} });
const mimeTypeArray = defineMimeTypeArray(EMPTY_LIST);
const plugins = pluginArray.create(), mimeTypes = mimeTypeArray.create();
globalThis.PluginArray = pluginArray.interface;
globalThis.MimeTypeArray = mimeTypeArray.interface;
globalThis.Plugin = definePlugin(EMPTY_LIST).interface;
globalThis.MimeType = defineMimeType({ init() {} }).interface;
const NAVIGATOR_IMPL = {
  ...navigatorIdentity,
  get_productSub: () => '20030107',
  get_vendor: () => 'Google Inc.',
  get_vendorSub: () => '',
  get_cookieEnabled: () => navigatorState.cookieEnabled,
  get_pdfViewerEnabled: () => navigatorState.pdfViewerEnabled,
  get_plugins: () => plugins,
  get_mimeTypes: () => mimeTypes,
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
};
// (…its members its realm's, whichever realm's member is called on it — HTML's "this's relevant global object's":
// webidl.js `ownRealm` — a frame's getter called on the page's navigator answering the page's objects, the page's on a
// detached frame's the frame's)
installNavigator(Navigator, ownRealm(REALM, 'Navigator', (o) => slotsOf(o, 'Navigator'), NAVIGATOR_IMPL));
// (…and `doNotTrack`, which the spec dropped and Chrome still answers: null, no preference)
Object.defineProperty(Navigator.prototype, 'doNotTrack', {
  ...Object.getOwnPropertyDescriptor(class { get doNotTrack() { thisIs(this, interfaceCheck('Navigator')); return null; } }.prototype, 'doNotTrack'),
  enumerable: true
});
globalThis.Navigator = Navigator;

// The driver's flip of it — the CDP `Network.emulateNetworkConditions(offline: true)` shim's — fires `online` / `offline` at
// the window where it changed, so app-level connectivity services (Discourse's NetworkConnectivity) react.
globalThis.__csimSetOnline = function (online) {
  if (globalThis.__dom.setOnLine(!!online)) fireEvent(globalThis, new Event(online ? 'online' : 'offline'));
};
