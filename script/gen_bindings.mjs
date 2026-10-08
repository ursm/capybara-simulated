// Generate the JS bindings of the interfaces the driver implements from their Web IDL (@webref/idl, the curated IDL of
// every web platform spec): per interface a `define<Name>(impl)` that makes its interface object — its members' argument
// counts, the conversion of each argument to its IDL type, the brand check of `this`, its constants, its class string,
// its indexed getter, stringifier and iterator — and hands the converted values to the implementation, `impl`, whose
// functions take the object first. Per callback interface, its legacy callback interface object and the call of each of
// its operations on a user object. What an interface does is its implementation's; the binding is what IDL says of it.
//
//   node script/gen_bindings.mjs           # write lib/capybara/simulated/js/src/generated/bindings.js
//   node script/gen_bindings.mjs --check   # fail where the written file is not what the IDL makes now
//
// An interface is generated once listed in INTERFACES; a construct of IDL no binding here makes yet is an error, not a
// silent gap.

import { parseAll } from '@webref/idl';
import { parse as parseIdl } from 'webidl2';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'lib', 'capybara', 'simulated', 'js', 'src', 'generated', 'bindings.js');

// The interfaces generated, by spec. `install`: an interface whose objects a hand-written class makes, its members
// generated onto that class's prototype (`install<Name>(iface, impl)`) — the class, its constructor and the objects it
// makes stay the hand-written code's, which registers the test that tells its objects apart. `omit`: what another spec
// adds to it that no implementation here answers yet, and why — a mixin it includes, by name; a partial interface of
// it, or a partial of a mixin it includes, by the spec's name. Anything else added is merged. `omitMembers`: single
// members no implementation answers, by name (and why). `namedProperties`: how an installed interface's objects answer
// its named property getter themselves (a Proxy of the class's).
// GlobalEventHandlers' touch handlers, which a desktop with no touch screen — headless Chrome's and Firefox's, measured —
// exposes on no object: feature detection reads them (flatpickr binds `touchstart` instead of `mousedown` where
// `window.ontouchstart` is defined).
const NO_TOUCH = { 'touch-events': 'ontouch*: no touch screen, whose handlers a desktop browser exposes nowhere' };
const INTERFACES = [
  ['dom', 'DOMTokenList'],
  ['dom', 'NodeFilter'],
  ['dom', 'NodeIterator'],
  ['dom', 'TreeWalker'],
  ['dom', 'Node', { install: true }],
  ['dom', 'CharacterData', { install: true }],
  ['dom', 'Text', { install: true, omit: { GeometryUtils: 'getBoxQuads / convert*FromNode (cssom-view) are not implemented' } }],
  ['dom', 'Comment', { install: true }],
  ['dom', 'CDATASection', { install: true }],
  ['dom', 'ProcessingInstruction', { install: true }],
  ['dom', 'DocumentType', { install: true }],
  ['dom', 'Attr', { install: true }],
  ['dom', 'DocumentFragment', { install: true }],
  ['dom', 'Element', {
    install: true,
    omit: {
      'css-nav': 'spatial navigation is not implemented',
      'css-pseudo': 'pseudo(): CSSPseudoElement is not implemented',
      'css-typed-om': 'computedStyleMap(): the Typed OM is not implemented',
      'css-view-transitions': 'startViewTransition / activeViewTransition: View Transitions are not implemented',
      'element-timing': 'elementTiming: Element Timing is not implemented',
      pointerlock: 'requestPointerLock: Pointer Lock is not implemented',
      Region: 'regionOverset / getRegionFlowRanges: CSS Regions are not implemented',
      GeometryUtils: 'getBoxQuads / convert*FromNode (cssom-view) are not implemented',
      ARIANotifyMixin: 'ariaNotify: no accessibility tree to announce to'
    },
    omitMembers: {
      currentCSSZoom: 'the effective zoom is not computed',
      requestFullscreen: 'no fullscreen',
      setHTML: 'the Sanitizer API is not implemented'
    }
  }],
  ['dom', 'Document', {
    install: true,
    namedProperties: 'the DocumentNamedProps Proxy spliced into its prototype chain (dom-nodes.js)',
    omit: {
      ...NO_TOUCH,
      SVG: 'rootElement: the SVG document is not modelled',
      'css-regions': 'namedFlows: CSS Regions are not implemented',
      'css-view-transitions': 'startViewTransition / activeViewTransition: View Transitions are not implemented',
      GeometryUtils: 'getBoxQuads / convert*FromNode (cssom-view) are not implemented',
      'font-metrics-api': 'measureElement / measureText: the Font Metrics API is not implemented',
      'permissions-policy': 'permissionsPolicy: Permissions Policy is not implemented',
      'scroll-to-text-fragment': 'fragmentDirective: text fragments are not implemented',
      'trust-token-api': 'hasPrivateToken / hasRedemptionRecord: Private State Tokens are not implemented',
      webmcp: 'modelContext: WebMCP is not implemented',
      ARIANotifyMixin: 'ariaNotify: no accessibility tree to announce to'
    },
    omitMembers: {
      caretPositionFromPoint: 'CaretPosition is not implemented',
      fullscreenEnabled: 'no fullscreen',
      fullscreen: 'no fullscreen',
      parseHTML: 'the Sanitizer API is not implemented',
      parseHTMLUnsafe: 'a static operation: not generated yet',
      all: 'HTMLAllCollection is not implemented',
      wasDiscarded: 'no discarding is modelled (Page Lifecycle)',
      pictureInPictureEnabled: 'no Picture-in-Picture',
      prerendering: 'no prerendering'
    }
  }],
  ['html', 'HTMLElement', {
    install: true,
    omit: {
      ...NO_TOUCH,
      'container-timing': 'containerTiming / containerTimingIgnore: Container Timing is not implemented (a WICG proposal)',
      'css-typed-om': 'attributeStyleMap: the Typed OM is not implemented',
      'edit-context': 'editContext: EditContext is not implemented'
    },
    omitMembers: {
      headingOffset: 'heading levels are not computed',
      headingReset: 'heading levels are not computed',
      scrollParent: 'the scroll container is not exposed'
    }
  }],
  ['SVG', 'SVGElement', { install: true, omit: { ...NO_TOUCH, 'css-typed-om': 'attributeStyleMap: the Typed OM is not implemented' } }],
  ['mathml-core', 'MathMLElement', { install: true, omit: { ...NO_TOUCH, 'css-typed-om': 'attributeStyleMap: the Typed OM is not implemented' } }],
  ['html', 'Window', {
    install: true,
    namedProperties: true,
    omit: {
      ...NO_TOUCH,
      'anonymous-iframe': 'credentialless: credentialless iframes are not implemented',
      compat: 'orientation / onorientationchange: a mobile-only legacy, which a desktop browser has not',
      cookiestore: 'cookieStore: the Cookie Store API is not implemented',
      'crash-reporting': 'crashReport: crash reporting is not implemented',
      'css-nav': 'navigate: spatial navigation is not implemented',
      'css-sizing-4': 'requestResize: not implemented',
      'css-viewport': 'viewport: the Viewport segments API is not implemented',
      'digital-goods': 'getDigitalGoodsService: the Digital Goods API is not implemented',
      'document-picture-in-picture': 'documentPictureInPicture: Document Picture-in-Picture is not implemented',
      'fenced-frame': 'fence: fenced frames are not implemented',
      fetch: 'fetch / fetchLater: the Fetch polyfill converts its own arguments; fetchLater is not implemented',
      'file-system-access': 'show*Picker: the File System Access pickers are not implemented',
      gamepad: 'ongamepad*: the Gamepad API is not implemented',
      'local-font-access': 'queryLocalFonts: Local Font Access is not implemented',
      'manifest-incubations': 'onappinstalled / onbeforeinstallprompt: app installation is not implemented',
      'orientation-event': 'ondevice*: device orientation and motion are not implemented',
      portals: 'portalHost / onportalactivate: portals are not implemented',
      PushManagerAttribute: 'pushManager: the Push API is not implemented',
      'scheduling-apis': 'scheduler: the Prioritized Task Scheduling API is not implemented',
      'speech-api': 'speechSynthesis: the Web Speech API is not implemented',
      'trusted-types': 'trustedTypes: Trusted Types are not implemented',
      'web-app-launch': 'launchQueue: app launch handling is not implemented',
      'window-management': 'getScreenDetails: multi-screen window placement is not implemented'
    },
    omitMembers: {
      navigation: 'the Navigation API is not implemented'
    }
  }],
  ['dom', 'EventTarget', { install: true, omit: { observable: 'when: Observables are not implemented' } }],
  ['dom', 'Event', { install: true }],
  ['dom', 'CustomEvent', { install: true }],
  ['uievents', 'UIEvent', { install: true, omit: { 'input-device-capabilities': 'sourceCapabilities: InputDeviceCapabilities is not implemented (a WICG proposal; Firefox has none)' } }],
  ['uievents', 'FocusEvent', { install: true }],
  ['pointerevents', 'MouseEvent', { install: true }],
  ['pointerevents', 'WheelEvent', { install: true, omitMembers: { momentum: 'a draft of Pointer Events neither Chrome nor Firefox has' } }],
  ['uievents', 'TextEvent', { install: true }],
  ['uievents', 'InputEvent', { install: true }],
  ['uievents', 'KeyboardEvent', { install: true }],
  ['uievents', 'CompositionEvent', { install: true }],
  ['pointerevents', 'PointerEvent', { install: true }],
  ['touch-events', 'Touch', { install: true }],
  ['touch-events', 'TouchList'],
  ['touch-events', 'TouchEvent', {
    install: true,
    namedProperties: 'none: getModifierState is the plain operation Chrome and Firefox have, no named property of the event'
  }],
  ['html', 'DataTransfer', { install: true }],
  ['html', 'DataTransferItemList'],
  ['html', 'DataTransferItem', {
    omit: {
      'entries-api': 'webkitGetAsEntry: the File and Directory Entries API is not implemented',
      'file-system-access': 'getAsFileSystemHandle: the File System Access API is not implemented'
    }
  }],
  ['css-font-loading', 'FontFace', {
    install: true,
    omitMembers: {
      features: 'FontFaceFeatures is empty in the draft ("the CSSWG is still discussing what goes in here")',
      variations: 'a face\'s variation axes are not read from its file',
      palettes: 'a face\'s color palettes are not read from its file'
    }
  }],
  ['css-font-loading', 'FontFaceSet', { install: true }],
  ['html', 'MediaError'],
  ['html', 'ImageData', { install: true }],
  ['html', 'ImageBitmap'],
  ['html', 'BarProp'],
  ['html', 'External'],
  ['html', 'CanvasGradient'],
  ['html', 'CanvasPattern'],
  ['html', 'Path2D', { install: true }],
  ['html', 'CanvasRenderingContext2D', { install: true }],
  ['html', 'OffscreenCanvasRenderingContext2D', { install: true }],
  ['html', 'OffscreenCanvas', { install: true }],
  ['SVG', 'SVGAnimatedString'],
  ['clipboard-apis', 'ClipboardItem', { install: true }],
  ['clipboard-apis', 'Clipboard', { install: true }],
  ['screen-orientation', 'ScreenOrientation', { install: true }],
  ['html', 'MessageChannel', { install: true }],
  ['html', 'MessagePort', {
    install: true,
    omitMembers: { onclose: 'withdrawn from the HTML Standard — no close event is fired at a port; Chrome and Firefox have none' }
  }],
  ['html', 'BroadcastChannel', { install: true }],
  ['html', 'EventSource', { install: true }],
  ['websockets', 'WebSocket', { install: true }],
  ['html', 'DragEvent', { install: true }],
  ['html', 'PopStateEvent', { install: true }],
  ['html', 'HashChangeEvent', { install: true }],
  ['html', 'PageTransitionEvent', { install: true }],
  ['html', 'BeforeUnloadEvent', { install: true }],
  ['html', 'ErrorEvent', { install: true }],
  ['html', 'PromiseRejectionEvent', { install: true }],
  ['html', 'SubmitEvent', { install: true }],
  ['html', 'FormDataEvent', { install: true }],
  ['html', 'ToggleEvent', { install: true }],
  ['html', 'StorageEvent', { install: true }],
  ['html', 'MessageEvent', { install: true }],
  ['xhr', 'ProgressEvent', { install: true }],
  ['websockets', 'CloseEvent', { install: true }],
  ['css-animations', 'AnimationEvent', { install: true }],
  ['css-transitions', 'TransitionEvent', { install: true }],
  ['web-animations-2', 'AnimationPlaybackEvent', { install: true }],
  ['clipboard-apis', 'ClipboardEvent', { install: true }],
  ['cssom-view', 'MediaQueryListEvent', { install: true }],
  ['IndexedDB', 'IDBVersionChangeEvent', { install: true }],
  ['css-font-loading', 'FontFaceSetLoadEvent', { install: true }],
  ['gamepad', 'GamepadEvent', { install: true }],
  ['orientation-event', 'DeviceMotionEventAcceleration'],
  ['orientation-event', 'DeviceMotionEventRotationRate'],
  ['orientation-event', 'DeviceMotionEvent', { install: true }],
  ['orientation-event', 'DeviceOrientationEvent', { install: true }],
  ['webidl', 'DOMException', { install: true }],
  ['webidl', 'QuotaExceededError', { install: true }],
  ['dom', 'DOMImplementation', { install: true }],
  ['geometry', 'DOMPointReadOnly', { install: true }],
  ['geometry', 'DOMPoint', { install: true }],
  ['geometry', 'DOMRectReadOnly', { install: true }],
  ['geometry', 'DOMRect', { install: true }],
  ['geometry', 'DOMRectList'],
  ['geometry', 'DOMQuad', { install: true }],
  ['geometry', 'DOMMatrixReadOnly', { install: true }],
  ['geometry', 'DOMMatrix', { install: true }],
  ['url', 'URL', { install: true }],
  ['url', 'URLSearchParams', { install: true }],
  ['fetch', 'Headers', { install: true }],
  ['xhr', 'FormData', { install: true }],
  ['html', 'Storage', { install: true, namedProperties: 'the Proxy each storage area is (storage.js)' }],
  ['html', 'DOMParser', { install: true }],
  ['html', 'XMLSerializer', { install: true }],
  ['intersection-observer', 'IntersectionObserver', { install: true }],
  ['intersection-observer', 'IntersectionObserverEntry', { install: true }],
  ['hr-time', 'Performance', {
    install: true,
    omit: {
      'navigation-timing': 'timing, navigation: Navigation Timing is not modelled (performance.js says why a partial one is worse)',
      'event-timing': 'eventCounts, interactionCount: Event Timing is not implemented',
      'performance-measure-memory': 'measureUserAgentSpecificMemory: memory measurement is not implemented'
    }
  }],
  ['performance-timeline', 'PerformanceEntry', { install: true }],
  ['user-timing', 'PerformanceMark', { install: true }],
  ['user-timing', 'PerformanceMeasure', { install: true }],
  ['server-timing', 'PerformanceServerTiming', { install: true }],
  ['resource-timing', 'PerformanceResourceTiming', { install: true }],
  ['performance-timeline', 'PerformanceObserver', { install: true }],
  ['performance-timeline', 'PerformanceObserverEntryList', { install: true }],
  ['resize-observer', 'ResizeObserver', { install: true }],
  ['resize-observer', 'ResizeObserverEntry', { install: true }],
  ['resize-observer', 'ResizeObserverSize', { install: true }],
  ['xhr', 'XMLHttpRequestEventTarget', { install: true }],
  ['xhr', 'XMLHttpRequestUpload', { install: true }],
  ['xhr', 'XMLHttpRequest', { install: true, omit: { 'trust-token-api': 'setPrivateToken: Private State Tokens are not implemented (a WICG proposal)' } }],
  ['fetch', 'Request', {
    install: true,
    omit: { 'local-network-access': 'targetAddressSpace: Local Network Access is not implemented (a WICG proposal)' }
  }],
  ['fetch', 'Response', { install: true }],
  ['encoding', 'TextEncoder', { install: true }],
  ['encoding', 'TextDecoder', { install: true }],
  ['encoding', 'TextDecoderStream', { install: true }],
  ['encoding', 'TextEncoderStream', { install: true }],
  ['FileAPI', 'Blob', { install: true }],
  ['FileAPI', 'File', { install: true }],
  ['FileAPI', 'FileList'],
  ['FileAPI', 'FileReader', { install: true }],
  ['FileAPI', 'FileReaderSync', { install: true }],
  ['dom', 'XPathResult', { install: true }],
  ['dom', 'XPathExpression', { install: true }],
  ['dom', 'XPathEvaluator', { install: true }],
  ['dom', 'AbstractRange', { install: true }],
  ['dom', 'StaticRange', { install: true }],
  ['dom', 'Range', { install: true }],
  ['dom', 'MutationObserver', { install: true }],
  ['cssom-view', 'MediaQueryList', { install: true }],
  ['dom', 'MutationRecord', { install: true }],
  ['dom', 'AbortController', { install: true }],
  ['dom', 'AbortSignal', { install: true }],
  ['dom', 'ShadowRoot', { install: true, omitMembers: { setHTML: 'the Sanitizer API is not implemented' } }],
  ['html', 'WorkerGlobalScope', {
    install: true,
    omit: {
      fetch: 'fetch: the Fetch polyfill converts its own arguments',
      'scheduling-apis': 'scheduler: the Prioritized Task Scheduling API is not implemented',
      'trusted-types': 'trustedTypes: Trusted Types are not implemented'
    }
  }],
  ['html', 'DedicatedWorkerGlobalScope', { install: true, omit: { 'webrtc-encoded-transform': 'onrtctransform: WebRTC encoded transforms are not implemented' } }],
  ['html', 'SharedWorkerGlobalScope', { install: true }],
  ['html', 'Navigator', {
    install: true,
    omit: {
      attribution: 'attribution: the Attribution Reporting API is not implemented',
      'audio-session': 'audioSession: the Audio Session API is not implemented',
      'autoplay-detection': 'getAutoplayPolicy: autoplay detection is not implemented',
      NavigatorBadge: 'setAppBadge / clearAppBadge: the Badging API is not implemented',
      'battery-status': 'getBattery: the Battery Status API is not implemented',
      'contact-picker': 'contacts: the Contact Picker API is not implemented',
      NavigatorCrossOriginStorage: 'crossOriginStorage: Cross-Origin Storage is not implemented (a WICG proposal)',
      'cpu-performance': 'cpuPerformance: the CPU Performance API is not implemented (a WICG proposal)',
      'device-posture': 'devicePosture: not implemented',
      'encrypted-media': 'requestMediaKeySystemAccess: Encrypted Media Extensions are not implemented',
      'fenced-frame': 'deprecatedReplaceInURN / adAuctionComponents: fenced frames are not implemented',
      'get-installed-related-apps': 'getInstalledRelatedApps: not implemented',
      'handwriting-recognition': 'createHandwritingRecognizer: not implemented',
      'ink-enhancement': 'ink: not implemented',
      'install-element': 'install: Web Install is not implemented (a WICG proposal)',
      'is-input-pending': 'scheduling: not implemented',
      'keyboard-lock': 'keyboard: the Keyboard Lock API is not implemented',
      'login-status': 'login: not implemented',
      'managed-configuration': 'managed: not implemented',
      'mediaqueries-5': 'preferences: not implemented',
      mediasession: 'mediaSession: the Media Session API is not implemented',
      'presentation-api': 'presentation: the Presentation API is not implemented',
      'screen-wake-lock': 'wakeLock: the Screen Wake Lock API is not implemented',
      serial: 'serial: Web Serial is not implemented',
      NavigatorStorageBuckets: 'storageBuckets: not implemented',
      NavigatorStorage: 'storage: the Storage API is not implemented',
      NavigatorUA: 'userAgentData: User-Agent Client Hints are not implemented',
      'virtual-keyboard': 'virtualKeyboard: not implemented',
      bluetooth: 'bluetooth: Web Bluetooth is not implemented',
      NavigatorAutomationInformation: 'webdriver: no WebDriver drives the page',
      NavigatorGPU: 'gpu: WebGPU is not implemented',
      hid: 'hid: WebHID is not implemented',
      webmidi: 'requestMIDIAccess: Web MIDI is not implemented',
      NavigatorML: 'ml: WebNN is not implemented',
      'web-share': 'share / canShare: Web Share is not implemented',
      usb: 'usb: WebUSB is not implemented',
      webxr: 'xr: WebXR is not implemented',
      'window-controls-overlay': 'windowControlsOverlay: not implemented'
    },
    omitMembers: {
      plugins: 'the PluginArray interface is not implemented',
      mimeTypes: 'the MimeTypeArray interface is not implemented',
      oscpu: "NavigatorID's Gecko compatibility mode: the navigator answers in Chrome's (HTML §8.9.1.1)",
      taintEnabled: "NavigatorID's Gecko compatibility mode: the navigator answers in Chrome's (HTML §8.9.1.1)"
    }
  }],
  ['service-workers', 'ServiceWorkerGlobalScope', {
    install: true,
    omit: {
      'background-fetch': 'onbackgroundfetch*: Background Fetch is not implemented',
      'background-sync': 'onsync: Background Sync is not implemented',
      'content-index': 'oncontentdelete: the Content Index API is not implemented',
      cookiestore: 'cookieStore / oncookiechange: the Cookie Store API is not implemented',
      notifications: 'onnotification*: notifications are not implemented',
      'periodic-background-sync': 'onperiodicsync: Periodic Background Sync is not implemented',
      'push-api': 'onpush*: the Push API is not implemented',
      'web-based-payment-handler': 'oncanmakepayment / onpaymentrequest: payment handlers are not implemented'
    }
  }],
  ['html', 'WorkerNavigator', {
    install: true,
    omit: {
      NavigatorBadge: 'setAppBadge / clearAppBadge: the Badging API is not implemented',
      NavigatorCrossOriginStorage: 'crossOriginStorage: Cross-Origin Storage is not implemented (a WICG proposal)',
      serial: 'serial: Web Serial is not implemented',
      NavigatorStorageBuckets: 'storageBuckets: not implemented',
      NavigatorStorage: 'storage: the Storage API is not implemented',
      NavigatorUA: 'userAgentData: User-Agent Client Hints are not implemented',
      NavigatorGPU: 'gpu: WebGPU is not implemented',
      hid: 'hid: WebHID is not implemented',
      NavigatorML: 'ml: WebNN is not implemented',
      usb: 'usb: WebUSB is not implemented'
    }
  }],
  ['html', 'WorkerLocation', { install: true }]
];

// What the generated code imports from the runtime (webidl.js).
const RUNTIME = [
  'PLATFORM', 'EMPTY_DICTIONARY', 'rejectedPromise', 'promiseResolvedWith', 'brandKey', 'makeSlots', 'slotsOf', 'thisOf', 'thisIs', 'required', 'constructedBy', 'registerInterface', 'interfaceCheck',
  'isBufferOf', 'toBuffer', 'checkBuffer', 'toDOMString', 'toUSVString', 'toByteString', 'toEnum', 'enumValue', 'toBoolean', 'toUnsignedShort', 'toUnsignedLong', 'toShort', 'toLong', 'toUnsignedLongLong', 'toLongLong', 'toEnforcedInteger', 'toClampedInteger', 'toDouble', 'toFloat', 'toUnrestrictedFloat',
  'toUnrestrictedDouble', 'toSequence', 'toRecord', 'isIterable', 'toObject', 'toInterface', 'toCallbackInterface', 'toCallbackFunction', 'restOf', 'callUserObjectOperation', 'legacyCallbackInterfaceObject',
  'defineConstants', 'withIndexedGetter', 'defineValueIterator', 'defineIndexedIterator', 'definePairIterator', 'defineClassString', 'enumerable', 'installMembers',
  'defineLength', 'defineUnscopables', 'unforgeableMembers', 'defaultJSONOf', 'defineSetlike'
];

const all = await parseAll();
// What an editor's draft says that @webref/idl's snapshot of it does not yet — each its draft's IDL, word for word, with
// the draft it is from; one a later @webref/idl has too is an error (below), and the entry goes.
const EDITORS_DRAFT_ADDITIONS = {
  // https://drafts.csswg.org/css-font-loading-3/#fontface-interface (and the WPT's fontface-size-adjust-descriptor)
  'css-font-loading-ed': `
    partial dictionary FontFaceDescriptors { CSSOMString sizeAdjust = "100%"; };
    partial interface FontFace { attribute CSSOMString sizeAdjust; };`
};
for (const [spec, text] of Object.entries(EDITORS_DRAFT_ADDITIONS)) all[spec] = parseIdl(text);
// Every interface, callback interface, mixin and dictionary of every spec, by name: what an interface type, an
// `includes` or a dictionary type names. And what adds to one beside its definition — a mixin it includes, a partial
// of it — by the name of the mixin, or the spec of the partial.
const definitions = new Map(), mixins = new Map(), dictionaries = new Map(), typedefs = new Map(), enums = new Map();
const additions = new Map();
const add = (to, addition) => additions.set(to, [...(additions.get(to) || []), addition]);
for (const [spec, defs] of Object.entries(all)) {
  for (const d of defs) {
    if ((d.type === 'interface' || d.type === 'callback interface' || d.type === 'callback') && !d.partial) definitions.set(d.name, d);
    if (d.type === 'interface mixin' && !d.partial) mixins.set(d.name, d);
    if (d.type === 'dictionary' && !d.partial) dictionaries.set(d.name, d);
    if (d.type === 'typedef') typedefs.set(d.name, d.idlType);
    if (d.type === 'enum') enums.set(d.name, d.values.map((v) => v.value));
    if (d.type === 'includes') add(d.target, { mixin: d.includes });
    if ((d.type === 'interface' || d.type === 'interface mixin' || d.type === 'dictionary') && d.partial) add(d.name, { partial: spec, def: d });
  }
}
// (…an editor's-draft addition @webref/idl has caught up with is an error: the entry goes)
for (const spec of Object.keys(EDITORS_DRAFT_ADDITIONS)) {
  for (const d of all[spec]) {
    const others = [definitions.get(d.name) || dictionaries.get(d.name), ...(additions.get(d.name) || []).filter((a) => a.partial && a.partial !== spec).map((a) => a.def)];
    for (const m of d.members) {
      if (others.some((o) => o && o.members.some((x) => x.name === m.name))) {
        throw new Error(`${d.name}.${m.name}: @webref/idl has it now — remove it from EDITORS_DRAFT_ADDITIONS`);
      }
    }
  }
}

// The extended attributes a binding here makes what IDL says of, by where they stand; any other is an error.
// [CEReactions]: an implementation's writes run their reactions as each returns (handleAttributeChanges) — which is
// the operation's return where it writes once, as every one generated here does. [Reflect]: the implementation reflects
// the content attribute. [SameObject] / [NewObject]: what the implementation returns. [Exposed]: the global the
// interface object is put on — and, of a member, whether its interface's has it at all (membersOf). [SecureContext]: exposed, every realm here being a secure context
// (`isSecureContext`, platform-globals.js). The rest the generator makes as Web IDL says.
const HANDLED = {
  // ([Serializable] / [Transferable]: the structured clone's to honour — platform-globals.js `cloneInto` — no member's;
  // [LegacyWindowAlias]: the Window's other names for the interface object, its implementation's to put there)
  interface: ['Exposed', 'SecureContext', 'Global', 'LegacyUnenumerableNamedProperties', 'Serializable', 'Transferable', 'LegacyWindowAlias'],
  member: [
    'SameObject', 'NewObject', 'CEReactions', 'Unscopable', 'PutForwards', 'Reflect', 'SecureContext', 'LegacyLenientSetter',
    'LegacyUnforgeable', 'LegacyLenientThis', 'Replaceable', 'HTMLConstructor', 'ReflectSetter', 'ReflectURL', 'ReflectNonNegative',
    'ReflectRange', 'ReflectDefault', 'Exposed', 'Default'
  ],
  type: ['LegacyNullToEmptyString', 'EnforceRange', 'Clamp', 'AllowShared', 'AllowResizable']
};
// The globals a definition or member is [Exposed] in — a worker's three where it names Worker — or null where it names
// none (a member then exposed wherever its interface is).
const WORKER_GLOBALS = ['DedicatedWorker', 'SharedWorker', 'ServiceWorker'];
function exposureOf(d) {
  const e = (d.extAttrs || []).find((x) => x.name === 'Exposed');
  if (!e) return null;
  const names = e.rhs.type === '*' ? ['*'] : e.rhs.type === 'identifier' ? [e.rhs.value] : e.rhs.value.map((v) => v.value);
  const set = new Set(names.flatMap((n) => (n === 'Worker' ? WORKER_GLOBALS : n === '*' ? ['Window', ...WORKER_GLOBALS] : [n])));
  return set;
}
function checkExtAttrs(extAttrs, where, label) {
  for (const e of extAttrs || []) {
    if (!HANDLED[where].includes(e.name)) throw new Error(`${label}: no binding makes [${e.name}] yet`);
  }
}

// What a conversion's TypeError says, by where the value comes from (Chrome's messages): an operation's argument
// (`index`, from 0), or an attribute's value.
// A conversion's TypeError message, as the JS expression of a string — Chrome's: the member's prefix, and in a
// dictionary's member, the dictionary member's after the prefix of what converts the dictionary (`prefix`, at run
// time) — then `text`.
function failure(where, text = '') {
  if (where.dictionary) return `prefix + ${JSON.stringify(`Failed to read the '${where.member}' property from '${where.dictionary}': ${text}`)}`;
  return JSON.stringify((where.index === undefined
    ? `Failed to set the '${where.member}' property on '${where.iface}': `
    : where.member === undefined
      ? `Failed to construct '${where.iface}': `
      : `Failed to execute '${where.member}' on '${where.iface}': `) + text);
}
// An IDL type written out: `sequence<sequence<ByteString>>`, `(Blob or USVString)?`.
function typeName(t) {
  const name = t.union ? `(${t.idlType.map(typeName).join(' or ')})`
    : t.generic ? `${t.generic}<${t.idlType.map(typeName).join(', ')}>`
    : t.idlType;
  return t.nullable ? `${name}?` : name;
}
function conversionError(where, what) {
  return failure(where, where.index === undefined
    ? `Failed to convert value to '${what}'.`
    : `parameter ${where.index + 1} is not of type '${what}'.`);
}

// The JS of converting `expr` to the IDL type `t` (an argument's, an attribute's), and the interfaces whose objects it
// takes, into `checks`.
// `extAttrs` are those on the type and, for an argument, the argument's own (where webidl2 puts `[EnforceRange] long x`'s).
function conversion(t, expr, where, checks, argExtAttrs = []) {
  const label = `${where.iface ?? where.dictionary}.${where.member}`;
  if (t.union) return unionConversion(t, expr, where, checks, argExtAttrs);
  const typedef = !t.generic && typedefs.get(t.idlType);
  if (typedef) return conversion(typeOf(typedef, t), expr, where, checks, argExtAttrs);
  if (t.generic === 'sequence' || t.generic === 'FrozenArray' || t.generic === 'ObservableArray') {
    // (Web IDL §3.2.21, §3.2.27, §3.2.28: the values its iterator gives, each converted; a frozen array frozen; an
    // observable array's setter given them, which its implementation's backing list is set to)
    const each = conversion(t.idlType[0], 'x', where, checks);
    const c = `toSequence(${expr}, (x) => ${each}, ${failure(where)})`;
    const value = t.generic === 'FrozenArray' ? `Object.freeze(${c})` : c;
    return t.nullable ? `(${expr} == null ? null : ${value})` : value;
  }
  if (t.generic === 'record') {
    // (Web IDL §3.2.24: the object's own enumerable keys, each converted — a symbol one a TypeError — with its value,
    // an ordered map of them: the implementation's an array of [key, value] pairs)
    const k = conversion(t.idlType[0], 'k', where, checks);
    const v = conversion(t.idlType[1], 'x', where, checks);
    const c = `toRecord(${expr}, (k) => ${k}, (x) => ${v}, ${failure(where)})`;
    return t.nullable ? `(${expr} == null ? null : ${c})` : c;
  }
  if (t.generic === 'Promise') {
    // (Web IDL §3.2.23: a new promise of %Promise% resolved with the value — its resolution converted to T where the
    // implementation reacts to it, not here)
    return `promiseResolvedWith(${expr})`;
  }
  if (t.generic) throw new Error(`${label}: no binding converts ${JSON.stringify(t.idlType)} yet`);
  const extAttrs = [...(t.extAttrs || []), ...argExtAttrs];
  checkExtAttrs(extAttrs, 'type', label);
  const legacyNull = extAttrs.some((e) => e.name === 'LegacyNullToEmptyString');
  const enforceRange = extAttrs.some((e) => e.name === 'EnforceRange');
  const clamp = extAttrs.some((e) => e.name === 'Clamp');
  const ranged = ['unsigned short', 'unsigned long', 'long', 'unsigned long long', 'long long'];
  if ((enforceRange || clamp) && !ranged.includes(t.idlType)) throw new Error(`${label}: no binding enforces or clamps the range of ${t.idlType} yet`);
  let c;
  // (…a buffer source type (Web IDL §3.2.26): an object of the type, its buffer not shared but where [AllowShared], not
  // resizable but where [AllowResizable])
  if (BUFFER_TYPES.has(t.idlType)) {
    const allowShared = extAttrs.some((e) => e.name === 'AllowShared');
    const allowResizable = extAttrs.some((e) => e.name === 'AllowResizable');
    // (…`checked`: a union's step has found it of the type)
    c = t.checked
      ? `checkBuffer(${expr}, ${JSON.stringify(t.idlType)}, ${allowShared}, ${allowResizable}, ${failure(where)})`
      : `toBuffer(${expr}, ${JSON.stringify(t.idlType)}, ${allowShared}, ${allowResizable}, ${conversionError(where, t.idlType)}, ${failure(where)})`;
    return t.nullable ? `(${expr} == null ? null : ${c})` : c;
  }
  switch (enforceRange ? 'EnforceRange' : clamp ? 'Clamp' : t.idlType) {
    case 'EnforceRange': c = `toEnforcedInteger(${expr}, ${JSON.stringify(t.idlType)}, ${failure(where)})`; break;
    case 'Clamp': c = `toClampedInteger(${expr}, ${JSON.stringify(t.idlType)}, ${failure(where)})`; break;
    // (…CSSOMString, which CSSOM lets an implementation make either string type, DOMString — as Chrome does)
    case 'CSSOMString':
    case 'DOMString': c = `toDOMString(${expr}, ${legacyNull}, ${failure(where)})`; break;
    case 'USVString': c = `toUSVString(${expr}, ${failure(where)})`; break;
    case 'ByteString': c = `toByteString(${expr}, ${failure(where)})`; break;
    case 'boolean': c = `toBoolean(${expr})`; break;
    case 'unsigned short': c = `toUnsignedShort(${expr}, ${failure(where)})`; break;
    case 'unsigned long': c = `toUnsignedLong(${expr}, ${failure(where)})`; break;
    case 'short': c = `toShort(${expr}, ${failure(where)})`; break;
    case 'long': c = `toLong(${expr}, ${failure(where)})`; break;
    case 'unsigned long long': c = `toUnsignedLongLong(${expr}, ${failure(where)})`; break;
    case 'long long': c = `toLongLong(${expr}, ${failure(where)})`; break;
    case 'double': c = `toDouble(${expr}, ${failure(where)})`; break;
    case 'unrestricted double': c = `toUnrestrictedDouble(${expr}, ${failure(where)})`; break;
    case 'float': c = `toFloat(${expr}, ${failure(where)})`; break;
    case 'unrestricted float': c = `toUnrestrictedFloat(${expr}, ${failure(where)})`; break;
    case 'any': c = expr; break;
    case 'object': c = `toObject(${expr}, ${conversionError(where, 'object')})`; break;
    // (…WindowProxy, which no IDL defines: HTML's name for what a Window is reached through — Window's test)
    case 'WindowProxy':
      checks.add('Window');
      c = `toInterface(${expr}, IS_Window, ${conversionError(where, 'Window')})`;
      break;
    default: {
      const def = definitions.get(t.idlType);
      if (ABSENT_INTERFACES.has(t.idlType)) {
        c = `(() => { throw new TypeError(${conversionError(where, t.idlType)}); })()`;
      } else if (def && def.type === 'interface') {
        checks.add(t.idlType);
        c = `toInterface(${expr}, IS_${t.idlType}, ${conversionError(where, t.idlType)})`;
      } else if (def && def.type === 'callback') {
        // (…a callback function type: a callable object, kept as it is — Web IDL §3.2.20; not one a 'Function', Chrome)
        c = `toCallbackFunction(${expr}, ${conversionError(where, 'Function')})`;
      } else if (def && def.type === 'callback interface') {
        c = `toCallbackInterface(${expr}, ${conversionError(where, 'Object')})`;
      } else if (enums.has(t.idlType)) {
        // (…a string the enumeration has: Chrome's message for one it has not)
        const values = enums.get(t.idlType);
        c = `toEnum(${expr}, ${JSON.stringify(values)}, ${JSON.stringify(t.idlType)}, ${failure(where)})`;
      } else if (dictionaries.has(t.idlType)) {
        c = `${dictionaryConverter(t.idlType)}(${expr}, ${failure(where)})`;
      } else {
        throw new Error(`${label}: no binding converts ${t.idlType} yet`);
      }
    }
  }
  return t.nullable ? `(${expr} == null ? null : ${c})` : c;
}

// Interfaces of specs no implementation here answers, which no value is an object of — a union member of one is
// none (Trusted Types: with no policy, the string a page passes is what the API takes), a dictionary member of one
// no member, and anything else converted to one no such object: the Typed OM's values, Animation Triggers', WebCodecs'
// VideoFrame, InputDeviceCapabilities (a UI event init's `sourceCapabilities` no member, as in Firefox), and Media Source
// Extensions' MediaSource (`URL.createObjectURL` takes a Blob alone).
const ABSENT_INTERFACES = new Set([
  'TrustedHTML', 'TrustedScript', 'TrustedScriptURL', 'CSSNumericValue', 'CSSKeywordValue', 'AnimationTrigger', 'VideoFrame',
  'InputDeviceCapabilities', 'Sanitizer', 'MediaSource'
]);
// …and the dictionaries and enums of an API none answers, which a member names beside its interface: the Sanitizer's,
// and two WICG proposals' a RequestInit names — Private State Tokens' `privateToken`, Local Network Access's
// `targetAddressSpace`.
const ABSENT_TYPES = new Set(['SanitizerConfig', 'SanitizerPresets', 'PrivateToken', 'IPAddressSpace']);

// The type `t` names `u` as: `u`, with `t`'s extended attributes besides its own and nullable if either is. (Its
// fields read off it: webidl2's types answer them by getters, which a spread would drop.)
function typeOf(u, t) {
  return { idlType: u.idlType, union: u.union, generic: u.generic, extAttrs: [...(u.extAttrs || []), ...(t.extAttrs || [])], nullable: u.nullable || t.nullable };
}

// A union's flattened member types (Web IDL §2.13.32), its typedefs expanded and its absent interfaces dropped, none
// nullable — and whether it includes a nullable type, which one of them, or a union among them, was.
function flattenUnion(t) {
  let includesNullable = !!t.nullable;
  const flatten = (u) => {
    const def = !u.union && typedefs.get(u.idlType);
    const type = def ? typeOf(def, u) : u;
    if (type.nullable) includesNullable = true;
    // (…a union's extended attributes each member's: `[AllowShared] ArrayBufferView` is each typed array's)
    return type.union ? type.idlType.flatMap((m) => flatten(typeOf(m, { extAttrs: type.extAttrs }))) : [{ ...typeOf(type, {}), nullable: false }];
  };
  const members = t.idlType.flatMap(flatten).filter((u) => !ABSENT_INTERFACES.has(u.idlType));
  return { members, includesNullable };
}

// A union's conversion (Web IDL §3.2.25), for unions of interfaces, a callback function, a dictionary, a string, a
// numeric type and boolean (a callable value the callback function's):
// null or undefined null where it includes a nullable type, else the dictionary's; an object of one of its interfaces
// as it is; any other object the dictionary's; a boolean or a number as itself where its type is a member; then the
// string type's conversion, else the numeric type's, else boolean's — and with none of them, a TypeError. A union
// that is one type once its absent interfaces are dropped is that type's conversion. Its extended attributes, and the
// argument's, are each member's.
const BUFFER_TYPES = new Set([
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array',
  'Uint32Array', 'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array', 'Float16Array', 'Float32Array', 'Float64Array'
]);
const STRING_TYPES = new Set(['DOMString', 'USVString', 'ByteString', 'CSSOMString']);
const NUMERIC_TYPES = new Set(['unsigned short', 'short', 'unsigned long', 'long', 'unsigned long long', 'long long', 'double', 'unrestricted double', 'float', 'unrestricted float']);
function unionConversion(t, expr, where, checks, argExtAttrs) {
  const label = `${where.iface ?? where.dictionary}.${where.member}`;
  const { members, includesNullable } = flattenUnion(t);
  const extAttrs = [...(t.extAttrs || []), ...argExtAttrs];
  if (members.length === 1) return conversion({ ...typeOf(members[0], { extAttrs }), nullable: includesNullable }, expr, where, checks);
  // (…its name as Chrome writes it: each member's type in full, in alphabetical order)
  const name = `(${members.map(typeName).sort().join(' or ')})`;
  const unsupported = () => new Error(`${label}: no binding converts ${name} yet`);
  if (members.some((u) => u.generic && u.generic !== 'sequence' && u.generic !== 'record')) throw unsupported();
  const of = (test) => members.filter(test);
  // (…a WindowProxy among them the Window it is a proxy of: the Window's test, as for one alone)
  const ifaces = of((u) => u.idlType === 'WindowProxy' || definitions.get(u.idlType)?.type === 'interface');
  const dicts = of((u) => dictionaries.has(u.idlType));
  const strings = of((u) => STRING_TYPES.has(u.idlType));
  const numerics = of((u) => NUMERIC_TYPES.has(u.idlType));
  const booleans = of((u) => u.idlType === 'boolean');
  const callbacks = of((u) => definitions.get(u.idlType)?.type === 'callback');
  const buffers = of((u) => BUFFER_TYPES.has(u.idlType));
  const sequences = of((u) => u.generic === 'sequence');
  const records = of((u) => u.generic === 'record');
  if (dicts.length > 1 || strings.length > 1 || numerics.length > 1 || callbacks.length > 1 || sequences.length > 1 || records.length > 1 ||
      (records.length && dicts.length) ||
      ifaces.length + buffers.length + sequences.length + records.length + dicts.length + strings.length + numerics.length + booleans.length + callbacks.length !== members.length) throw unsupported();
  const [dict] = dicts, [string] = strings, [numeric] = numerics, [boolean] = booleans, [record] = records;
  const convert = (u) => conversion(u, expr, where, checks, extAttrs);
  // (…the last conversion, which takes what no step before it did — so no step of its own)
  const last = string || numeric || boolean;
  const steps = [];
  if (includesNullable) steps.push([`${expr} == null`, 'null']);
  // (…a string the string type's at once — every test before its would fail on one: the common BlobPart, the common
  // string-or-options argument, asks nothing else)
  if (string && ifaces.length + buffers.length + sequences.length + records.length + callbacks.length + dicts.length) {
    steps.push([`typeof ${expr} === 'string'`, convert(string)]);
  }
  if (dict) steps.push([`${expr} == null`, convert(dict)]);
  for (const u of ifaces) {
    const check = u.idlType === 'WindowProxy' ? 'Window' : u.idlType;
    checks.add(check);
    steps.push([`IS_${check}(${expr})`, expr]);
  }
  // (…a buffer source of one of its types its conversion: an ArrayBuffer, a SharedArrayBuffer, a DataView, a typed
  // array — whose sharing and resizing that refuses)
  for (const u of buffers) steps.push([`isBufferOf(${expr}, ${JSON.stringify(u.idlType)})`, convert({ ...u, checked: true })]);
  // (…an object with an @@iterator the sequence's)
  for (const u of sequences) {
    steps.push([`isIterable(${expr}, ${failure(where)})`, convert(u)]);
  }
  // (…any other object the record type's — Web IDL's union step after the sequence's)
  if (record) steps.push([`(${expr} !== null && (typeof ${expr} === 'object' || typeof ${expr} === 'function'))`, convert(record)]);
  // (…a callable one the callback function type's, before a dictionary would take it)
  if (callbacks.length) steps.push([`typeof ${expr} === 'function'`, expr]);
  if (dict) steps.push([`(typeof ${expr} === 'object' || typeof ${expr} === 'function')`, convert(dict)]);
  if (boolean && boolean !== last) steps.push([`typeof ${expr} === 'boolean'`, expr]);
  if (numeric && numeric !== last) steps.push([`typeof ${expr} === 'number'`, convert(numeric)]);
  const otherwise = last ? convert(last) : `(() => { throw new TypeError(${failure(where, `The provided value is not of type '${name}'.`)}); })()`;
  return `(${steps.map(([test, value]) => `${test} ? ${value} : `).join('')}${otherwise})`;
}

// A dictionary's conversion (Web IDL §3.2.17): a function of its own, written once beside the interfaces — undefined
// or null an empty dictionary, any other non-object a TypeError; each member, its inherited dictionaries' first and
// each's (its partials' included) in lexicographic order, got from the object, converted, or its default where it is
// undefined (a required one missing a TypeError). Its messages follow `prefix`, what converts the dictionary's.
const dictionaryConverters = new Map();
function dictionaryConverter(name) {
  const fn = `to${name}`;
  if (dictionaryConverters.has(name)) return fn;
  dictionaryConverters.set(name, null);
  const chain = [];
  for (let d = dictionaries.get(name); d; d = d.inheritance && dictionaries.get(d.inheritance)) {
    if (d.inheritance && !dictionaries.has(d.inheritance)) throw new Error(`${d.name}: inherits ${d.inheritance}, which no spec defines`);
    chain.unshift(d);
  }
  const lines = [];
  let defaults = false;
  lines.push(`export function ${fn}(v, prefix) {`);
  lines.push(`  if (v !== undefined && v !== null && typeof v !== 'object' && typeof v !== 'function') throw new TypeError(prefix + ${JSON.stringify(`The provided value is not of type '${name}'.`)});`);
  const head = lines.length;
  lines.push(`  const dict = {};`);
  for (const d of chain) {
    // (…its partials' members among its own — but one whose type is of an API no implementation here answers, every one
    // of a union's, which is no member here: `{trigger: x}` ignored, as in a browser without Animation Triggers;
    // `{sanitizer: x}`, without the Sanitizer API)
    const absent = (t) => (t.union ? t.idlType.every(absent) : ABSENT_INTERFACES.has(t.idlType) || ABSENT_TYPES.has(t.idlType));
    const members = [...d.members, ...(additions.get(d.name) || []).flatMap((a) => a.def.members)]
      .filter((m) => !absent(m.idlType));
    for (const m of members.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const where = { dictionary: d.name, member: m.name };
      lines.push(`  {`);
      lines.push(`    const x = v == null ? undefined : v.${m.name};`);
      const missing = m.required ? `(() => { throw new TypeError(${failure(where, 'Required member is undefined.')}); })()`
        : m.default ? defaultValue(m.default, `${d.name}.${m.name}`) : null;
      if (missing !== null) defaults = true;
      const checks = new Set();
      const converted = conversion(m.idlType, 'x', where, checks, m.extAttrs);
      if (checks.size) {
        // (…the tests of the interfaces it takes looked up only when it is given — registered by then — so the common
        // call that leaves it out looks nothing up)
        lines.push(`    if (x !== undefined) {`);
        for (const c of checks) lines.push(`      const IS_${c} = interfaceCheck('${c}');`);
        lines.push(`      dict.${m.name} = ${converted};`);
        lines.push(missing === null ? `    }` : `    } else dict.${m.name} = ${missing};`);
      } else {
        lines.push(missing === null
          ? `    if (x !== undefined) dict.${m.name} = ${converted};`
          : `    dict.${m.name} = x !== undefined ? ${converted} : ${missing};`);
      }
      lines.push(`  }`);
    }
  }
  // (…and, for a dictionary none of whose members has a default or is required, null or undefined the one empty
  // dictionary: the common call with no options allocates nothing)
  if (!defaults) lines.splice(head, 0, '  if (v == null) return EMPTY_DICTIONARY;');
  lines.push(`  return dict;`);
  lines.push(`}`);
  dictionaryConverters.set(name, lines.join('\n'));
  return fn;
}

function constantValue(m, where) {
  if (m.value.type !== 'number') throw new Error(`${where}: no binding gives a constant of ${m.value.type} yet`);
  return m.value.value;
}

// An interface's members: its own, those of the mixins it includes, and those of the partials of either — but what
// `omit` and `omitMembers` name (and why). What no binding here makes of a definition yet, beside its members, is an
// error, as is an omission of something nothing adds.
// The members, of an interface a worker has too, exposed in a Window alone — which a worker's realm takes off its
// prototype (worker-globals.js): DOMMatrixReadOnly's stringifier, which parses CSS.
const windowOnlyMembers = {};
// The options the table gives an interface ({} for one it does not list).
function interfaceOptions(name) {
  const entry = INTERFACES.find(([, n]) => n === name);
  return (entry && entry[2]) || {};
}

function membersOf(def, omit = {}, omitMembers = {}) {
  const omitted = new Set();
  const gather = (d) => {
    checkExtAttrs(d.extAttrs, 'interface', d.name);
    const found = [...d.members];
    for (const a of additions.get(d.name) || []) {
      const key = a.mixin || a.partial;
      if (Object.hasOwn(omit, key)) { omitted.add(key); continue; }
      if (a.partial) { found.push(...a.def.members); continue; }
      const mixin = mixins.get(a.mixin);
      if (!mixin) throw new Error(`${def.name}: includes ${a.mixin}, which no spec defines`);
      found.push(...gather(mixin));
    }
    return found;
  };
  // (…but a member exposed only where the interface is not — a WorkerNavigator's NavigatorID members of a Window's)
  const exposedIn = exposureOf(def) && [...exposureOf(def)];
  const members = gather(def).filter((m) => {
    const own = exposureOf(m);
    if (own && exposedIn && !exposedIn.some((g) => own.has(g))) return false;
    if (own && exposedIn && exposedIn.some((g) => !own.has(g))) {
      if (own.size !== 1 || !own.has('Window')) throw new Error(`${def.name}.${m.name}: a member exposed in fewer of its interface's globals is not generated yet`);
      (windowOnlyMembers[def.name] ||= []).push(m.special === 'stringifier' && !m.name ? 'toString' : m.name);
    }
    if (!Object.hasOwn(omitMembers, m.name)) return true;
    omitted.add(m.name);
    return false;
  });
  const unknown = [...Object.keys(omit), ...Object.keys(omitMembers)].filter((k) => !omitted.has(k));
  if (unknown.length) throw new Error(`${def.name}: omits ${unknown.join(', ')}, which nothing adds to it`);
  for (const m of members) checkExtAttrs(m.extAttrs, 'member', `${def.name}.${m.name || m.type}`);
  return members;
}

function generateInterface(def, options = {}) {
  const name = def.name;
  if (def.inheritance && !options.install) throw new Error(`${name}: an inherited interface is not generated yet`);
  const members = [], constants = [], body = [], statics = [], unforgeables = [], checks = new Set(), unscopables = [], handlers = [], preamble = [];
  // (…`this` checked: by its brand where the binding makes the object, by the test its class registered where it is
  // installed on that class)
  // (…a null or undefined `this` the realm's global — Web IDL's operation and attribute steps: a bare
  // `addEventListener(…)` is the window's — and `prefix` the message's, for an operation whose TypeError becomes its
  // promise's rejection)
  const selfCheck = (prefix) => {
    const message = prefix ? `, ${JSON.stringify(prefix)}` : '';
    return options.install ? `thisIs(this ?? globalThis, IS_SELF${message})` : `thisOf(this ?? globalThis, KEY${message})`;
  };
  const self = selfCheck();
  let indexed = null, valueIterator = false, pairIterator = false, setlike = null, stringifier = null;
  const constructors = [];
  const memberList = membersOf(def, options.omit, options.omitMembers);
  for (const m of memberList) {
    const label = `${name}.${m.name || m.type}`;
    if ((m.extAttrs || []).some((e) => e.name === 'Unscopable')) unscopables.push(m.name);
    if (m.type === 'constructor') { constructors.push(m); continue; }
    if (m.type === 'const') { constants.push([m.name, constantValue(m, label)]); continue; }
    if (m.type === 'setlike') {
      // (…a setlike declaration, Web IDL §3.7.12: the members over the implementation's backing set, `impl.setOf(self)`
      // — a JS Set — add / delete / clear only where it is not readonly and the interface declares none of its own)
      if (!options.install) throw new Error(`${label}: a setlike interface the binding makes is not generated yet`);
      const valueType = m.idlType[0].idlType;
      if (definitions.get(valueType)?.type !== 'interface') throw new Error(`${label}: a setlike of other than an interface type is not generated yet`);
      checks.add(valueType);
      setlike = { readonly: !!m.readonly, valueType };
      continue;
    }
    if (m.type === 'iterable') {
      // (…a pair iterator, Web IDL §3.7.10: the implementation's pairs, `impl.pairs(self)`, read live)
      if (m.idlType.length === 2) {
        if (!options.install) throw new Error(`${label}: a pair iterator of an interface the binding makes is not generated yet`);
        pairIterator = true;
        continue;
      }
      valueIterator = true;
      continue;
    }
    if (m.type === 'attribute' && EVENT_HANDLER_TYPES.has(m.idlType.idlType)) {
      // (…[LegacyLenientThis] or not: the installing class's accessors answer any `this`)
      handlers.push(m.name);
      continue;
    }
    if (m.type === 'attribute' && m.special === 'static') {
      // (…a static attribute the interface object's own accessor, of no object: PerformanceObserver.supportedEntryTypes)
      if (!options.install) throw new Error(`${label}: a static attribute of an interface the binding makes is not generated yet`);
      if (!m.readonly) throw new Error(`${label}: a writable static attribute is not generated yet`);
      const shared = memberList.some((o) => o.name === m.name && o.special !== 'static');
      statics.push(`    get ${m.name}() { return impl.${shared ? 'static_' : ''}get_${m.name}(null); }`);
      continue;
    }
    if (m.type === 'attribute') {
      // ([LegacyUnforgeable], Web IDL §3.4.10: an own property of each object, which cannot be reconfigured)
      const out = (m.extAttrs || []).some((e) => e.name === 'LegacyUnforgeable') ? unforgeables : body;
      // (…an `inherit` one, Web IDL §2.5.2, its inherited getter's value and a setter of its own: DOMPoint's coordinates)
      if (m.special === 'stringifier') stringifier = m.name;
      else if (m.special && m.special !== 'inherit') throw new Error(`${label}: a ${m.special} attribute is not generated yet`);
      members.push(m.name);
      // (…[LegacyLenientThis] only an event handler's here, whose accessors the installing class's are)
      if ((m.extAttrs || []).some((e) => e.name === 'LegacyLenientThis')) throw new Error(`${label}: a [LegacyLenientThis] attribute is not generated yet`);
      // (…a promise-typed one's exception its promise's rejection, as its getter steps say)
      const getter = `return impl.get_${m.name}(${self});`;
      out.push(`    get ${m.name}() { ${promiseOf(m) ? rejecting(getter) : getter} }`);
      const forwards = (m.extAttrs || []).find((e) => e.name === 'PutForwards');
      if (forwards) {
        // [PutForwards=x] (Web IDL §3.7.6): a write to the attribute is a write of `x` on the object it answers
        // (`el.classList = 'a b'` sets the list's `value`).
        // (…the object no object — a document's `location` with no window — a TypeError)
        const target = forwards.rhs.value;
        const notObject = JSON.parse(failure({ iface: name, member: m.name }, 'The attribute value is not an object'));
        out.push(`    set ${m.name}(v) { const object = impl.get_${m.name}(${self}); if (object === null || (typeof object !== 'object' && typeof object !== 'function')) throw new TypeError(${JSON.stringify(notObject)}); object.${target} = v; }`);
      } else if ((m.extAttrs || []).some((e) => e.name === 'Replaceable')) {
        // [Replaceable] (Web IDL §3.7.6): a write to the read-only attribute replaces it with a data property of the
        // object — a page's `innerWidth = 1024` keeps its own value, and the attribute is gone for it
        out.push(`    set ${m.name}(v) { const self = ${self}; Object.defineProperty(self, '${m.name}', { value: v, writable: true, enumerable: true, configurable: true }); }`);
      } else if ((m.extAttrs || []).some((e) => e.name === 'LegacyLenientSetter')) {
        // [LegacyLenientSetter] (Web IDL §3.4.2): a read-only attribute with a setter that does nothing — but check its
        // `this` — so a page's own assignment to it (an old polyfill's) is no error
        out.push(`    set ${m.name}(v) { ${self}; }`);
      } else if (!m.readonly && enums.has(m.idlType.idlType)) {
        // (…an enumeration's: a string it has not is ignored, not an error — Web IDL §3.7.6)
        const value = `enumValue(v, ${JSON.stringify(enums.get(m.idlType.idlType))}, ${failure({ iface: name, member: m.name })})`;
        const v = m.idlType.nullable ? `v == null ? null : ${value}` : value;
        out.push(`    set ${m.name}(v) { const self = ${self}; const value = ${v}; if (value !== undefined) impl.set_${m.name}(self, value); }`);
      } else if (!m.readonly) {
        const v = conversion(m.idlType, 'v', { iface: name, member: m.name }, checks);
        out.push(`    set ${m.name}(v) { impl.set_${m.name}(${self}, ${v}); }`);
      }
      continue;
    }
    if (m.type === 'operation') {
      // (…a named property getter / setter / deleter the installing class's objects answer themselves: `namedProperties`
      // says how — but one with a name is an ordinary operation too: Storage's getItem / setItem / removeItem)
      const namedProperty = options.namedProperties && ['getter', 'setter', 'deleter'].includes(m.special) &&
        m.arguments.length >= 1 && m.arguments[0].idlType.idlType === 'DOMString';
      if (namedProperty && !m.name) continue;
      if (m.special === 'static') {
        // (…a static operation the interface object's own, of no object: `DeviceMotionEvent.requestPermission()`)
        if (!options.install) throw new Error(`${label}: a static operation of an interface the binding makes is not generated yet`);
        if (statics.some((line) => line.startsWith(`    ${m.name}(`))) continue;
        // (…its implementation `static_<name>` where an object's member has the name: Response's json())
        const shared = memberList.some((o) => o.name === m.name && o.special !== 'static');
        statics.push(`    ${operation(name, m, checks, () => 'null', shared ? `static_${m.name}` : m.name)}`);
        continue;
      }
      if (m.special === 'stringifier') {
        // (…`stringifier;`: a toString the implementation's `stringify` answers — Range's text)
        if (m.name || m.arguments.length) throw new Error(`${label}: only an anonymous stringifier operation is generated`);
        body.push(`    toString() { return impl.stringify(${self}); }`);
        stringifier = 'toString';
        continue;
      }
      if ((m.extAttrs || []).some((e) => e.name === 'Default')) {
        // [Default] toJSON (Web IDL "default toJSON steps"): an object of the interface's regular attributes, each its
        // getter's value — an interface type's the object, which JSON.stringify asks its own toJSON
        if (m.name !== 'toJSON') throw new Error(`${label}: only a [Default] toJSON is generated`);
        // (…every inherited interface's with a [Default] toJSON first, the topmost first — "collect attribute values of
        // an inheritance stack" — each read by its own getter, as the install found it)
        const stack = [];
        for (let d = definitions.get(def.inheritance); d; d = definitions.get(d.inheritance)) {
          if (d.members.some((x) => x.name === 'toJSON' && (x.extAttrs || []).some((e) => e.name === 'Default'))) stack.unshift(d);
        }
        if (stack.length && !options.install) throw new Error(`${label}: an inherited [Default] toJSON of an interface the binding makes is not generated yet`);
        const regular = (list) => list.filter((a) => a.type === 'attribute' && (!a.special || a.special === 'inherit') && !EVENT_HANDLER_TYPES.has(a.idlType.idlType));
        const inherited = stack.flatMap((d) => {
          const o = interfaceOptions(d.name);
          return regular(membersOf(d, o.omit, o.omitMembers)).map((a) => a.name);
        });
        if (inherited.length) preamble.push(`  const inheritedJSON = defaultJSONOf(Object.getPrototypeOf(iface.prototype), ${JSON.stringify(inherited)});`);
        const attrs = regular(memberList);
        members.push('toJSON');
        const own = attrs.map((a) => `${a.name}: impl.get_${a.name}(self)`);
        body.push(`    toJSON() { const self = ${self}; return { ${(inherited.length ? ['...inheritedJSON(self)'] : []).concat(own).join(', ')} }; }`);
        continue;
      }
      if (namedProperty) {
        // (…its ordinary operation below)
      } else if (m.special === 'getter') {
        if (m.arguments.length !== 1 || m.arguments[0].idlType.idlType !== 'unsigned long') throw new Error(`${label}: only an indexed getter is generated`);
        // (…an anonymous one the object's indices alone, which the implementation's `getter` answers: DataTransferItemList)
        indexed = m.name || 'getter';
        if (!m.name) continue;
      } else if (m.special) {
        throw new Error(`${label}: a ${m.special} operation is not generated yet`);
      }
      if (!m.name) throw new Error(`${label}: an anonymous operation is not generated yet`);
      // (…an overloaded one written once, where its first overload stands)
      if (members.includes(m.name)) continue;
      members.push(m.name);
      const group = memberList.filter((o) => o.type === 'operation' && o.name === m.name && o.special !== 'static');
      body.push(`    ${group.length > 1 ? overloadedOperation(name, group, checks, selfCheck) : operation(name, m, checks, selfCheck)}`);
      continue;
    }
    throw new Error(`${label}: a ${m.type} member is not generated yet`);
  }
  // (…and an integer-typed `length` beside it, which the exotic object's indices and its @@iterator read — Web IDL §3.9,
  // §3.7.10)
  const lengthAttr = indexed && def.members.find((m) => m.type === 'attribute' && m.name === 'length');
  if (indexed && !(lengthAttr && /^(?:unsigned )?(?:short|long|long long)$/.test(lengthAttr.idlType.idlType))) {
    throw new Error(`${name}: an indexed getter with no integer-typed \`length\` is not generated yet`);
  }
  if (stringifier && stringifier !== 'toString') body.push(`    toString() { return impl.get_${stringifier}(${self}); }`);
  const enumerated = JSON.stringify([...new Set(members)].concat(stringifier ? ['toString'] : []));
  if (options.install) {
    if (indexed || valueIterator) throw new Error(`${name}: an installed interface with an indexed getter or an iterator is not generated yet`);
    if (setlike) setlike.declared = memberList.filter((o) => o.type === 'operation' && ['add', 'delete', 'clear'].includes(o.name)).map((o) => o.name);
    return installInterface(def, { body, statics, unforgeables, checks, unscopables, constructors, constants, handlers, pairIterator, setlike, preamble });
  }
  if (unforgeables.length) throw new Error(`${name}: [LegacyUnforgeable] members of an interface the binding makes are not generated yet`);
  if (handlers.length) throw new Error(`${name}: event handlers of an interface the binding makes are not generated yet`);
  if (constructors.length) throw new Error(`${name}: a constructor is not generated yet`);

  const lines = [];
  lines.push(`// interface ${name} (${def.spec})`);
  lines.push(`export function define${name}(impl) {`);
  lines.push(`  const KEY = brandKey('${name}');`);
  // (…registered before the interfaces its members take are looked up: those may be its own)
  lines.push(`  registerInterface('${name}', (o) => slotsOf(o, KEY) !== undefined);`);
  for (const c of checks) lines.push(`  const IS_${c} = interfaceCheck('${c}');`);
  lines.push(`  // (…made by the platform alone: the interface has no constructor)`);
  lines.push(`  class ${name} {`);
  lines.push(`    constructor(...args) {`);
  lines.push(`      constructedBy(PLATFORM, args[0], '${name}');`);
  lines.push(`      impl.init(makeSlots(this, KEY), ...args.slice(1));`);
  lines.push(`    }`);
  lines.push(...body);
  lines.push(`  }`);
  if (constants.length) {
    const list = JSON.stringify(constants.map(([n]) => n));
    lines.push(`  defineConstants(${name}, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
    lines.push(`  defineConstants(${name}.prototype, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
  }
  lines.push(`  defineClassString(${name}.prototype, '${name}');`);
  lines.push(`  enumerable(${name}.prototype, ${enumerated});`);
  if (unscopables.length) lines.push(`  defineUnscopables(${name}.prototype, ${JSON.stringify(unscopables)});`);
  if (valueIterator) {
    if (!indexed) throw new Error(`${name}: a value iterator with no indexed getter is not generated yet`);
    lines.push(`  defineValueIterator(${name}.prototype);`);
  } else if (indexed) {
    lines.push(`  defineIndexedIterator(${name}.prototype);`);
  }
  // …and its objects, as the platform makes them (`create(...state)`), exotic where it has an indexed getter.
  const make = indexed
    ? `withIndexedGetter(new ${name}(PLATFORM, ...state), (s, i) => impl.${indexed}(s, i), (s) => impl.get_length(s))`
    : `new ${name}(PLATFORM, ...state)`;
  lines.push(`  return { interface: ${name}, create: (...state) => ${make} };`);
  lines.push(`}`);
  return lines.join('\n');
}

// An installed interface: its members generated in a class of their own, then put on the prototype of the hand-written
// class (`iface`) that makes its objects — their names, lengths and conversions IDL's, enumerable; the interface
// object's `length` its constructor's required arguments; its class string and @@unscopables.
// …its [LegacyUnforgeable] members, own properties of each object, defined on one by the function it returns, which the
// class's constructor calls.
// …a [Global] interface's (Window's) on the global object itself (Web IDL §3.7.5), its [LegacyUnforgeable] ones too —
// by the two functions it returns, which define them on a global: its members (configurable, made once where the
// snapshot is, which a realm made from it has already), and its [LegacyUnforgeable] ones, as each realm is made.
function installInterface(def, { body, statics, unforgeables, checks, unscopables, constructors, constants, handlers, pairIterator, setlike, preamble }) {
  const name = def.name;
  const global = (def.extAttrs || []).some((e) => e.name === 'Global');
  const holder = global ? 'members' : 'iface.prototype';
  const length = constructors.length ? Math.min(...constructors.map((m) => m.arguments.filter((a) => !a.optional && !a.variadic).length)) : 0;
  const lines = [];
  lines.push(global
    ? `// interface ${name}${def.inheritance ? ` : ${def.inheritance}` : ''} (${def.spec}), [Global]: installed on the global object`
    : `// interface ${name}${def.inheritance ? ` : ${def.inheritance}` : ''} (${def.spec}), installed on the class that makes its objects`);
  lines.push(`export function install${name}(iface, impl) {`);
  lines.push(`  const IS_SELF = interfaceCheck('${name}');`);
  for (const c of checks) lines.push(`  const IS_${c} = interfaceCheck('${c}');`);
  lines.push(...preamble);
  lines.push(`  class Members {`);
  lines.push(...body);
  lines.push(`  }`);
  if (global) lines.push(`  const members = {};`);
  lines.push(`  installMembers(${holder}, Members.prototype);`);
  if (statics.length) lines.push(`  class Statics {`, ...statics, `  }`, `  installMembers(iface, Statics.prototype);`);
  if (handlers.length) lines.push(`  impl.installEventHandlers(${holder}, ${JSON.stringify(handlers)}, IS_SELF);`);
  if (pairIterator) lines.push(`  definePairIterator(iface.prototype, '${name}', (self) => impl.pairs(self), IS_SELF);`);
  if (setlike) {
    const own = setlike.readonly ? [] : ['add', 'delete', 'clear'].filter((n) => !setlike.declared.includes(n));
    lines.push(`  defineSetlike(iface.prototype, '${name}', (self) => impl.setOf(self), IS_SELF, ${JSON.stringify(own)}, IS_${setlike.valueType}, '${setlike.valueType}');`);
  }
  if (constants.length) {
    const list = JSON.stringify(constants.map(([n]) => n));
    lines.push(`  defineConstants(iface, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
    lines.push(`  defineConstants(iface.prototype, ${list}, [${constants.map(([, v]) => v).join(', ')}]);`);
  }
  lines.push(`  defineLength(iface, ${length});`);
  lines.push(`  defineClassString(iface.prototype, '${name}');`);
  if (unscopables.length) lines.push(`  defineUnscopables(iface.prototype, ${JSON.stringify(unscopables)});`);
  if (unforgeables.length) lines.push(`  class Unforgeables {`, ...unforgeables, `  }`);
  if (constructors.length > 1) lines.unshift(overloadedConstructorArguments(name, constructors), '');
  else if (constructors.length && constructors[0].arguments.length) lines.unshift(constructorArguments(name, constructors[0]), '');
  if (global) {
    lines.push(`  const descriptors = Object.getOwnPropertyDescriptors(members);`);
    lines.push(`  return {`);
    lines.push(`    names: Object.keys(descriptors),`);
    lines.push(`    defineMembers: (global) => Object.defineProperties(global, descriptors),`);
    lines.push(`    defineUnforgeables: ${unforgeables.length ? 'unforgeableMembers(Unforgeables.prototype)' : '() => {}'}`);
    lines.push(`  };`);
  } else if (unforgeables.length) {
    lines.push(`  return unforgeableMembers(Unforgeables.prototype);`);
  }
  lines.push(`}`);
  return lines.join('\n');
}

// An installed interface's constructor arguments, converted as Web IDL's constructor steps would (Chrome's messages):
// the hand-written class's constructor calls `convert<Name>Arguments(arguments)` for them.
function constructorArguments(name, m) {
  const required = m.arguments.filter((a) => !a.optional && !a.variadic).length;
  const checks = new Set();
  const converted = convertArguments(name, m, checks, () => null, 'args');
  const lines = [`export function convert${name}Arguments(args) {`];
  if (required) {
    const message = `Failed to construct '${name}': ${required} argument${required === 1 ? '' : 's'} required, but only `;
    lines.push(`  if (args.length < ${required}) throw new TypeError(${JSON.stringify(message)} + args.length + ' present.');`);
  }
  for (const c of checks) lines.push(`  const IS_${c} = interfaceCheck('${c}');`);
  lines.push(`  return [${converted.join(', ')}];`, `}`);
  return lines.join('\n');
}

// …and an overloaded constructor's (Web IDL §3.6 overload resolution, as an overloaded operation's): the overload's
// name — its arguments', `sw_sh_settings` / `data_sw_sh_settings` — then its arguments converted to its own types.
function overloadedConstructorArguments(name, group) {
  const checks = new Set();
  const overloads = overloadsOf(name, 'constructor', group);
  const implName = (m) => m.arguments.map((a) => a.name).join('_') || 'none';
  const call = (m) => `return [${[`'${implName(m)}'`, ...convertArguments(name, m, checks, () => null, 'args')].join(', ')}];`;
  const lines = [`export function convert${name}Arguments(args) {`];
  if (overloads.required) {
    const message = `Failed to construct '${name}': ${overloads.required} argument${overloads.required === 1 ? '' : 's'} required, but only `;
    lines.push(`  if (args.length < ${overloads.required}) throw new TypeError(${JSON.stringify(message)} + args.length + ' present.');`);
  }
  const body = overloadSwitch(name, 'constructor', overloads, 'args', checks, call, `Failed to construct '${name}': `);
  for (const c of checks) lines.push(`  const IS_${c} = interfaceCheck('${c}');`);
  lines.push(...body.map((l) => `  ${l}`), `}`);
  return lines.join('\n');
}

// An event handler IDL attribute's types (HTML §8.1.8.1): what it is, the same for each — its handler stored and
// called as the event loop's — the installing class's (events.js), handed the names.
const EVENT_HANDLER_TYPES = new Set(['EventHandler', 'OnErrorEventHandler', 'OnBeforeUnloadEventHandler']);

// The JS name of an argument: its IDL name, but where strict code reserves that (`interface`, `arguments`, …) or the
// generated code names something of its own by it (`self`, `impl`, a conversion it calls, … — CSSMathSum's
// constructor takes `args`).
const RESERVED = new Set([
  'self', 'impl', 'KEY', 'PLATFORM', 'x', 'v', 'callback', 'args', ...RUNTIME,
  'arguments', 'eval', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield',
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with'
]);
function argName(a) {
  return RESERVED.has(a.name) || a.name.startsWith('IS_') ? `${a.name}_` : a.name;
}

// An operation: its required arguments its parameters (so its `length` is their count, Web IDL §3.7.7), the optional
// ones read from `arguments`, a variadic one the rest — each converted, and handed to the implementation.
function operation(iface, m, checks, selfCheck, implName = m.name) {
  const args = m.arguments;
  const requiredCount = args.filter((a) => !a.optional && !a.variadic).length;
  if (args.some((a, i) => (a.optional || a.variadic) && i < requiredCount)) throw new Error(`${iface}.${m.name}: a required argument after an optional one`);
  // (…a variadic one after optional ones the rest of `arguments`, past them: `setTimeout(handler, timeout, ...arguments)`)
  const rest = !args.some((a) => a.optional);
  const params = args.filter((a) => !a.optional && (rest || !a.variadic)).map((a) => (a.variadic ? `...${argName(a)}` : argName(a))).join(', ');
  const converted = convertArguments(iface, m, checks, (a) => ((a.variadic && rest) || (!a.optional && !a.variadic) ? argName(a) : null));
  // (…`this` checked first, then the arguments counted — Web IDL's order, as Chrome's)
  const check = requiredCount ? `required(arguments, ${requiredCount}, '${m.name}', '${iface}'); ` : '';
  const steps = `const self = ${selfCheck(promiseOf(m) && `Failed to execute '${m.name}' on '${iface}': `)}; ${check}return impl.${implName}(${['self', ...converted].join(', ')});`;
  return `${m.name}(${params}) { ${promiseOf(m) ? rejecting(steps) : steps} }`;
}

// Whether an operation returns a promise — which every exception its steps throw rejects instead, `this` and argument
// conversions' included (Web IDL §3.7.7: "an exception … converted to a rejected promise").
const promiseOf = (m) => m.idlType && m.idlType.generic === 'Promise';
const rejecting = (steps) => `try { ${steps} } catch (e) { return rejectedPromise(e); }`;

// Each argument of `m` converted to its type: a required one read as `named(a)` gives it, an optional one from
// `arguments` (one passed as undefined is one not passed, Web IDL §3.6 — but a dictionary, or one defaulting to `{}`,
// is converted from undefined: its members' defaults), a variadic one the rest.
function convertArguments(iface, m, checks, named, source = 'arguments') {
  return m.arguments.map((a, i) => {
    const where = { iface, member: m.name, index: i };
    const expr = named(a) ?? (a.variadic ? `restOf(${source}, ${i})` : `${source}[${i}]`);
    if (a.variadic) return `${expr}.map((x) => ${conversion(a.idlType, 'x', where, checks, a.extAttrs)})`;
    if (a.optional) {
      if (dictionaries.has(a.idlType.idlType) || a.default?.type === 'dictionary') return conversion(a.idlType, expr, where, checks, a.extAttrs);
      const missing = a.default ? defaultValue(a.default, `${iface}.${m.name}(${a.name})`) : 'undefined';
      return `(${expr} !== undefined ? ${conversion(a.idlType, expr, where, checks, a.extAttrs)} : ${missing})`;
    }
    return conversion(a.idlType, expr, where, checks, a.extAttrs);
  });
}

// An overloaded operation (Web IDL §3.6 overload resolution): the overload chosen by how many arguments were passed
// (no more than the longest takes), each one's arguments converted to its own types and handed to an implementation
// of its own — named for its arguments, `scroll_options` / `scroll_x_y` — where one count of arguments could call two,
// the one their distinguishing argument's type chooses (`distinguished`). Its `length` is the shortest overload's
// required arguments.
function overloadedOperation(iface, group, checks, selfCheck) {
  const name = group[0].name;
  const promise = group.some(promiseOf);
  if (promise && !group.every(promiseOf)) throw new Error(`${iface}.${name}: overloads returning a promise and not are not generated`);
  const overloads = overloadsOf(iface, name, group);
  const params = overloads.shortest.arguments.slice(0, overloads.required).map(argName).join(', ');
  const implName = (m) => `${name}_${m.arguments.length ? m.arguments.map((a) => a.name).join('_') : 'none'}`;
  const lines = [`const self = ${selfCheck(promise && `Failed to execute '${name}' on '${iface}': `)};`];
  if (overloads.required) lines.push(`required(arguments, ${overloads.required}, '${name}', '${iface}');`);
  const call = (m) => `return impl.${implName(m)}(${['self', ...convertArguments(iface, m, checks, () => null)].join(', ')});`;
  lines.push(...overloadSwitch(iface, name, overloads, 'arguments', checks, call, `Failed to execute '${name}' on '${iface}': `));
  const body = promise ? ['try {', ...lines.map((l) => `  ${l}`), '} catch (e) {', '  return rejectedPromise(e);', '}'] : lines;
  return [`${name}(${params}) {`, ...body.map((l) => `      ${l}`), `    }`].join('\n');
}

// An overload set's cases: for each count of arguments up to the longest overload's, the one overload that count
// calls, or the two it is told apart between (`distinguished`); and its shortest overload, whose required arguments
// are the set's.
function overloadsOf(iface, name, group) {
  if (group.some((m) => m.arguments.some((a) => a.variadic))) throw new Error(`${iface}.${name}: an overload with a variadic argument is not generated yet`);
  const least = (m) => m.arguments.filter((a) => !a.optional).length;
  const most = Math.max(...group.map((m) => m.arguments.length));
  const cases = [];
  let pair = null;   // (…the same two at successive counts the same case, which falls through)
  for (let n = 0; n <= most; n++) {
    const takers = group.filter((m) => least(m) <= n && n <= m.arguments.length);
    if (takers.length > 2) throw new Error(`${iface}.${name}: more than two overloads of one count are not generated yet`);
    if (takers.length === 2) {
      if (!pair || pair.takers.some((m, i) => m !== takers[i])) pair = { takers, resolved: distinguished(iface, name, takers) };
      cases.push([n, pair.resolved]);
    } else if (takers.length) cases.push([n, takers[0]]);
  }
  const shortest = group.reduce((a, b) => (least(b) < least(a) ? b : a));
  return { cases, most, required: least(shortest), shortest };
}

// …and the switch that resolves it over `source` (`arguments`, or a constructor's `args`), `call(m)` the statement
// that runs overload `m`: a count of arguments no overload takes a TypeError after `prefix` (Chrome's message).
function overloadSwitch(iface, name, { cases, most, required }, source, checks, call, prefix) {
  const lines = [`switch (Math.min(${source}.length, ${most})) {`];
  // (…the counts one overload takes falling through to its one call)
  cases.forEach(([n, m], i) => {
    if (i + 1 < cases.length && cases[i + 1][1] === m) { lines.push(`  case ${n}:`); return; }
    const v = `${source}[${m.index}]`;
    if (m.dictionary) {
      // (…two of the count told apart by the distinguishing argument: undefined, null or an object the dictionary's)
      lines.push(`  case ${n}: if (${v} == null || typeof ${v} === 'object' || typeof ${v} === 'function') ${call(m.dictionary)}`);
      lines.push(`    ${call(m.other)}`);
      return;
    }
    if (m.sequence) {
      // (…or an object with an @@iterator the sequence's — GetMethod's word, as a union's step takes it: one whose
      // @@iterator is no function a TypeError — anything else the dictionary's)
      lines.push(`  case ${n}: if (isIterable(${v}, ${failure({ iface, member: name, index: m.index })})) ${call(m.sequence)}`);
      lines.push(`    ${call(m.other)}`);
      return;
    }
    if (m.platformObject) {
      // (…an object of the interface the interface's overload — anything else the string's or the number's)
      checks.add(m.type);
      lines.push(`  case ${n}: if (IS_${m.type}(${v})) ${call(m.platformObject)}`);
      lines.push(`    ${call(m.other)}`);
      return;
    }
    if (m.buffer) {
      // (…an object of one of the buffer types the buffer's overload — anything else, another object too, the numeric
      // type's, which converts it)
      lines.push(`  case ${n}: if (${m.bufferTypes.map((t) => `isBufferOf(${v}, ${JSON.stringify(t)})`).join(' || ')}) ${call(m.buffer)}`);
      lines.push(`    ${call(m.other)}`);
      return;
    }
    lines.push(`  case ${n}: ${call(m)}`);
  });
  if (cases.length < most - required + 1) {
    const arities = `${prefix}Valid arities are: [${cases.map(([n]) => n).join(', ')}], but `;
    lines.push(`  default: throw new TypeError(${JSON.stringify(arities)} + ${source}.length + ' arguments provided.');`);
  }
  lines.push(`}`);
  return lines;
}

// Web IDL's overload resolution (§3.6.3) for two overloads taking the same count, where it is generated: the first
// argument whose types differ — a dictionary's in one and a string's (an enumeration's too) or a sequence's in the other,
// an interface's in one and a string's or a numeric type's in the other, or a buffer source's in one and a numeric
// type's in the other — tells them apart.
function distinguished(iface, name, [a, b]) {
  const index = a.arguments.findIndex((arg, i) => !b.arguments[i] || arg.idlType.idlType !== b.arguments[i].idlType.idlType);
  const typeOf = (m) => m.arguments[index] && m.arguments[index].idlType;
  const isDictionary = (t) => t && !t.union && dictionaries.has(t.idlType);
  const isString = (t) => t && !t.union && (STRING_TYPES.has(t.idlType) || enums.has(t.idlType));
  const isSequence = (t) => t && t.generic === 'sequence';
  // (…not a nullable one, whose overload null and undefined would choose — which the interface's test does not ask)
  const isInterface = (t) => t && !t.union && !t.nullable && definitions.get(t.idlType)?.type === 'interface';
  if (isDictionary(typeOf(a)) && isString(typeOf(b))) return { index, dictionary: a, other: b };
  if (isDictionary(typeOf(b)) && isString(typeOf(a))) return { index, dictionary: b, other: a };
  if (isSequence(typeOf(a)) && isDictionary(typeOf(b))) return { index, sequence: a, other: b };
  if (isSequence(typeOf(b)) && isDictionary(typeOf(a))) return { index, sequence: b, other: a };
  const isNumeric = (t) => t && !t.union && !t.nullable && NUMERIC_TYPES.has(t.idlType);
  // (…an object of the interface the interface's overload, anything else the string's or the number's, which converts it)
  const stringOrNumber = (t) => isString(t) || isNumeric(t);
  // (…the interface's argument required: an optional one would take undefined, which §3.6.3 resolves first and the
  // interface's test does not ask)
  const optionalAt = (m) => m.arguments[index]?.optional;
  if ((isInterface(typeOf(a)) && optionalAt(a)) || (isInterface(typeOf(b)) && optionalAt(b))) {
    throw new Error(`${iface}.${name}: overloads told apart by an optional interface argument are not generated yet`);
  }
  if (isInterface(typeOf(a)) && stringOrNumber(typeOf(b))) return { index, platformObject: a, other: b, type: typeOf(a).idlType };
  if (isInterface(typeOf(b)) && stringOrNumber(typeOf(a))) return { index, platformObject: b, other: a, type: typeOf(b).idlType };
  // (…a buffer source type, or a union of them — ImageData's ImageDataArray — and a numeric type)
  const bufferTypes = (t) => {
    if (!t) return null;
    if (t.nullable) throw new Error(`${iface}.${name}: overloads told apart by a nullable buffer source type are not generated yet`);
    const members = flattenUnion({ ...t, union: true, idlType: [t] }).members;
    return members.every((u) => !u.union && BUFFER_TYPES.has(u.idlType)) ? members.map((u) => u.idlType) : null;
  };
  if (bufferTypes(typeOf(a)) && isNumeric(typeOf(b))) return { index, buffer: a, other: b, bufferTypes: bufferTypes(typeOf(a)) };
  if (bufferTypes(typeOf(b)) && isNumeric(typeOf(a))) return { index, buffer: b, other: a, bufferTypes: bufferTypes(typeOf(b)) };
  throw new Error(`${iface}.${name}: overloads told apart by other than a dictionary and a string or a sequence, an interface and a string or a number, or a buffer source and a number, are not generated yet`);
}

function defaultValue(d, where) {
  switch (d.type) {
    case 'string': return JSON.stringify(d.value);
    case 'boolean': return String(d.value);
    case 'number': return String(d.value);
    case 'null': return 'null';
    case 'sequence': return '[]';
    default: throw new Error(`${where}: no binding gives a default of ${d.type} yet`);
  }
}

// A callback interface: its legacy callback interface object where it has constants (Web IDL §3.11.1) — no constructor,
// its constants on it — and the call of its operation on a user object, its result converted to the operation's type.
function generateCallbackInterface(def) {
  const name = def.name;
  membersOf(def);
  const constants = [], operations = [];
  for (const m of def.members) {
    const label = `${name}.${m.name || m.type}`;
    if (m.type === 'const') constants.push([m.name, constantValue(m, label)]);
    else if (m.type === 'operation' && !m.special && m.name) operations.push(m);
    else throw new Error(`${label}: a ${m.type} member of a callback interface is not generated yet`);
  }
  if (operations.length !== 1) throw new Error(`${name}: a callback interface of ${operations.length} operations is not generated yet`);
  const op = operations[0];
  if (op.idlType.idlType !== 'unsigned short' || op.idlType.nullable) throw new Error(`${name}.${op.name}: no binding converts a result of ${op.idlType.idlType} yet`);
  const params = op.arguments.map(argName).join(', ');
  const lines = [];
  lines.push(`// callback interface ${name} (${def.spec})`);
  lines.push(`export function define${name}() {`);
  if (constants.length) {
    lines.push(`  const ${name} = legacyCallbackInterfaceObject('${name}');`);
    lines.push(`  defineConstants(${name}, ${JSON.stringify(constants.map(([n]) => n))}, [${constants.map(([, v]) => v).join(', ')}]);`);
  } else {
    lines.push(`  const ${name} = null;`);
  }
  lines.push(`  // (…the user object's \`${op.name}\`, or the object itself where it is callable)`);
  lines.push(`  const ${op.name} = (callback, ${params}) => toUnsignedShort(callUserObjectOperation(callback, '${op.name}', [${params}], '${name}'));`);
  lines.push(`  return { interface: ${name}, ${op.name} };`);
  lines.push(`}`);
  return lines.join('\n');
}

// Names listed two-space indented, wrapped at 120 columns.
function wrap(names) {
  const lines = [''];
  for (const n of names) {
    const item = `${n}, `;
    if (2 + lines.at(-1).length + item.length > 121) lines.push('');
    lines[lines.length - 1] += item;
  }
  return lines.map((l) => `  ${l}`.trimEnd()).join('\n').replace(/,$/, '');
}

const parts = [];
for (const [spec, name, options] of INTERFACES) {
  const def = (all[spec] || []).find((d) => (d.type === 'interface' || d.type === 'callback interface') && d.name === name && !d.partial);
  if (!def) throw new Error(`${spec}: no interface ${name}`);
  def.spec = spec;
  parts.push(def.type === 'interface' ? generateInterface(def, options) : generateCallbackInterface(def));
}
// The interfaces, of every spec, exposed in a Window alone — whose interface objects a worker's global has none of,
// whoever made them (worker-globals.js).
const windowOnly = [...definitions.values()].filter((d) => {
  if (d.type !== 'interface' && d.type !== 'callback interface') return false;
  const exposed = (d.extAttrs || []).find((e) => e.name === 'Exposed');
  return exposed && exposed.rhs.type === 'identifier' && exposed.rhs.value === 'Window';
}).map((d) => d.name);
// …and an interface's [LegacyWindowAlias] names.
const legacyWindowAliases = Object.fromEntries([...definitions.values()].flatMap((d) => {
  const alias = d.type === 'interface' && (d.extAttrs || []).find((e) => e.name === 'LegacyWindowAlias');
  if (!alias) return [];
  return [[d.name, alias.rhs.type === 'identifier' ? [alias.rhs.value] : alias.rhs.value.map((v) => v.value)]];
}).sort(([a], [b]) => (a < b ? -1 : 1)));
// The interface each HTML element interface inherits: what its interface object extends.
const htmlParents = [...definitions.values()]
  .filter((d) => d.type === 'interface' && /^HTML\w*Element$/.test(d.name) && d.inheritance)
  .map((d) => [d.name, d.inheritance])
  .sort(([a], [b]) => (a < b ? -1 : 1));
// …and the event handlers of WindowEventHandlers (its own and its partials' — but those of specs the Window omits):
// what `<body>` / `<frameset>` reflect to their Window (events.js).
const windowOptions = INTERFACES.find(([, n]) => n === 'Window')[2];
const windowHandlers = [mixins.get('WindowEventHandlers'), ...(additions.get('WindowEventHandlers') || [])
  .filter((a) => !Object.hasOwn(windowOptions.omit, a.partial)).map((a) => a.def)]
  .flatMap((d) => d.members).filter((m) => m.type === 'attribute' && EVENT_HANDLER_TYPES.has(m.idlType.idlType)).map((m) => m.name);
const parentTable = `// WindowEventHandlers' event handler attributes.
export const WINDOW_EVENT_HANDLERS = ${JSON.stringify(windowHandlers)};

// The interface each HTML element interface inherits.
export const HTML_INTERFACE_PARENTS = {
${htmlParents.map(([n, p]) => `  ${n}: '${p}'`).join(',\n')}
};`;

// The dictionaries an implementation converts itself — an `any` argument's, as the type its steps name: a canvas's
// getContext('2d') options a CanvasRenderingContext2DSettings.
for (const name of ['CanvasRenderingContext2DSettings']) dictionaryConverter(name);
const dictionaryParts = [...dictionaryConverters.values()];
const body = [...dictionaryParts, ...parts, parentTable].join('\n\n');
// (…every interface whose test some binding asks for, which the runtime holds registered once the bundle has run:
// webidl.js assertInterfacesRegistered)
const taken = [...new Set([...body.matchAll(/interfaceCheck\('([A-Za-z]+)'\)/g)].map((m) => m[1]))].sort();
const source = `// GENERATED by script/gen_bindings.mjs from @webref/idl — do not edit; run \`node script/gen_bindings.mjs\`.
// The bindings of the interfaces the driver implements: what Web IDL says of each, its implementation handed the
// converted values (webidl.js is their runtime).

import {
${wrap(RUNTIME)}
} from '../webidl.js';

${body}

// The interfaces the bindings take: each must be registered by the time the bundle has run.
export const INTERFACES_TAKEN = ${JSON.stringify(taken)};

// The interfaces exposed in a Window alone.
export const WINDOW_ONLY_INTERFACES = ${JSON.stringify(windowOnly.sort())};

// …and the members exposed in a Window alone, of an interface a worker has too.
export const WINDOW_ONLY_MEMBERS = ${JSON.stringify(windowOnlyMembers)};

// The Window's other names for an interface object ([LegacyWindowAlias]), of every spec.
export const LEGACY_WINDOW_ALIASES = ${JSON.stringify(legacyWindowAliases)};
`;

if (process.argv.includes('--check')) {
  const written = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (written !== source) {
    console.error('generated/bindings.js is not what the IDL makes now — run `node script/gen_bindings.mjs`');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, source);
}
