// The Window interface (HTML §7.2.2), [Global]: its members are the global object's own (Web IDL §3.7.5), generated
// from its IDL (generated/bindings.js `installWindow`) and defined where the snapshot is — but the [LegacyUnforgeable]
// ones, defined as a window realm is made (`__csimInitRealm`): a worker's global is made from the same snapshot, and
// drops the rest (worker-globals.js). Each member answers for the window its `this` is: this realm's global, or —
// through a WindowProxy, or another realm's member called on it — another window, whose realm's own steps it goes on to.
//
// A window's state the driver and the other realms set lives on its global, as the rest of the driver's does
// (`__csim*`, unenumerable): its `top` and `parent` (a frame's, which the realm builder wires), its name, status and
// opener, whether a script may close it, and the current event.

import { CROSS_ORIGIN_WINDOW_PROPERTIES, defineBarProp, defineExternal, installWindow } from './generated/bindings.js';
import { EventTarget, installEventHandlerAttrs } from './events.js';
import {
  childFrameCount, cloneFor, focusWindow, isCrossOriginIsolated,
  openWindow, postMessageToSelf, reportError, screen, scrollWindow, visualViewport, windowScrollX, windowScrollY
} from './platform-globals.js';
import { STATE_INITIAL_ABOUT_BLANK, hasState } from './native-query-shadow.js';
import { documentOrigin, opaqueOriginRefusal } from './document-origin.js';
import { parseURL } from './url-parse.js';
import { performance } from './performance.js';
import { cancelIdleCallback, requestIdleCallback } from './idle.js';
import {
  cancelAnimationFrame, clearTimer, queueMicrotask, queueTask, requestAnimationFrame, setInterval, setTimeout
} from './timers.js';
import { alert, confirm, print, prompt } from './dialogs.js';
import { atob, btoa } from './encoding.js';
import { focusChanged } from './handles.js';
import { createImageBitmap } from './canvas.js';
import { history } from './history.js';
import { location } from './location.js';
import { navigator } from './navigator.js';
import { indexedDB } from './idb.js';
import { caches } from './cache-storage.js';
import { crypto } from './webcrypto.js';
import { localStorage, sessionStorage } from './storage.js';
import { customElements } from './custom-elements.js';
import { matchMedia } from './media-query.js';
import { getComputedStyle } from './style-proxy.js';
import { getSelection } from './selection.js';
import { DOMException } from './dom-exception.js';

// BarProp (HTML §7.2.2.5), generated from its IDL: whether a part of the window's chrome is visible — every one of a
// window that is no popup.
// A Window's storage areas, where its document has a storage key — none for an opaque origin (HTML "obtain a storage
// key" fails).
function storageOfDocument(name, area) {
  const why = opaqueOriginRefusal({ data: "Storage is disabled inside 'data:' URLs." });
  if (why) throw new DOMException(`Failed to read the '${name}' property from 'Window': ${why}`, 'SecurityError');
  return area;
}
const BarProp = defineBarProp({ init() {}, get_visible: () => true });
// External (HTML §11.3.4), generated from its IDL: the search-provider operations, which do nothing.
const External = defineExternal({ init() {}, AddSearchProvider() {}, IsSearchProviderInstalled() {} });
const bars = {
  locationbar: BarProp.create(), menubar: BarProp.create(), personalbar: BarProp.create(),
  scrollbars: BarProp.create(), statusbar: BarProp.create(), toolbar: BarProp.create()
};
const external = External.create();
globalThis.BarProp = BarProp.interface;
globalThis.External = External.interface;

// The member steps, for the window `win` — this realm's global, which the generated binding's check found `this` to be
// (or a WindowProxy of it).
// Which window `win` is to the engine's window state (navigables.rs `window_keys`): the key the host gave a window
// `window.open` made — the realm of its first document, which outlives the realms its navigations replace it with, so a
// reference held across one still asks about the window it is — else its realm's id.
// (…asked of its own realm's engine bindings, as its steps ask the rest)
const windowKey = (win) => win.__dom.realmWindowKey() ?? win.__csimRealmId();
// The realm whose script calls a method of a window: the entry realm — the entered context's where none is entered by
// name (navigables.rs `entryRealm`, `enteredGlobal`) — this realm's for none known.
function callerRealm() {
  const entry = globalThis.__dom.entryRealm();
  if (entry >= 0) return entry;
  try { return globalThis.RustyRacer.contextOf(globalThis.__dom.enteredGlobal()) ?? globalThis.__csimRealmId(); } catch (_) { return globalThis.__csimRealmId(); }
}
// …and whether its browsing context is gone, its frame removed (navigables.rs `browsingContextDiscarded`): asked of the
// engine only where some realm is discarded, none is the common page's.
const discarded = (win) => win.__dom.discardedRealms[0] !== 0 && win.__dom.browsingContextDiscarded();
// …and whether it is the isolate's page, the top-level window the host made it for (realm 0's), not a window
// `window.open` made in it nor a frame.
const ownPage = (win) => windowKey(win) === 0 && win.__csimParent === win;
// The driver's: whether this window `window.open` made in this isolate is gone — its browsing context discarded, 2 —
// or closing, 1, or neither, 0 (RealmWindow) — and its close by the user (Capybara's `Window#close`), at once: its
// document unloaded, its frames' with it, and its browsing context discarded (HTML "close a top-level traversable", no
// page asked whether it may be: the driver's own windows' close fires no `beforeunload` either,
// Browser#fire_document_teardown).
globalThis.__csimWindowState = () => (discarded(globalThis) ? 2 : globalThis.__dom.windowClosed(windowKey(globalThis)) ? 1 : 0);
// Whether the document a navigation of this window to `url` makes keeps its Window — that of its initial about:blank, of
// the origin the document will be of (HTML "create and initialize a Document object": the Window reused) — not where
// the response's `csp` sandboxes it, an opaque origin of its own (v8_runtime.rb `reuse_window_realm`). (…`origin` the
// document's where its URL does not say it: an about:blank one's, its initiator's — WPT
// navigate-to-about-blank-while-initial-load-pending.html)
globalThis.__csimKeepsWindowFor = function (url, csp, origin = parseURL(url)?.origin) {
  if (!hasState(globalThis.document, STATE_INITIAL_ABOUT_BLANK)) return false;
  if (csp && globalThis.__dom.cspSandboxing(csp) !== 0) return false;
  const own = documentOrigin();
  return own !== 'null' && own === origin;
};
// …whether its document is its initial about:blank, its name, and the sandboxing flags its navigable's documents are made
// with — what a navigation of it that leaves its browsing context group carries (browser.rb `coop_switch?`).
globalThis.__csimInitialAboutBlank = () => hasState(globalThis.document, STATE_INITIAL_ABOUT_BLANK);
globalThis.__csimWindowName = () => globalThis.__dom.windowName();
globalThis.__csimPopupSandbox = () => globalThis.__dom.pageSandbox(null);
// …and its page's browsing context left for another group: the windows its documents opened none of its from then on.
globalThis.__csimForgetPageOpenings = () => globalThis.__dom.forgetPageOpenings();
globalThis.__csimCloseWindowNow = function () {
  const key = windowKey(globalThis);
  if (discarded(globalThis)) return;
  globalThis.__dom.closeWindow(key);
  focusChanged();
  discardWindow(globalThis, key);
};
// The load of the document a navigation made in the window of realm `realm` — one `window.open` made in this isolate —
// fired as a task of the page's event loop, the isolate's one (HTML: one event loop for an agent's windows; "the end"
// queues it once the parse is done): after the tasks queued before it — a message its script posted to its opener, which
// that one hears before the load (WPT replace-before-load/form-submit-popup.html) — none of them run under its parse.
// None of a document replaced since: its realm gone. (…the window's own, where the page's document is destroyed — its
// window closed, the isolate kept as the host of the windows it made (browser.rb `destroy_page`) — whose tasks run no
// more: the window's event loop the one that goes on)
// (…set as the page's document is destroyed: `__csimDiscardRealms`)
let pageDestroyed = false;
globalThis.__csimQueueWindowLoad = (realm) => {
  const fire = () => {
    let win = null;
    try { win = globalThis.RustyRacer.contextGlobal(realm); } catch (_) {}
    win?.__csimFireWindowLoad?.();
  };
  if (pageDestroyed !== true) return queueTask(fire);
  globalThis.RustyRacer.contextGlobal(realm)?.__csimQueueTask?.(fire);
};
// …a task of this realm's event loop, queued for another realm (`__csimQueueWindowLoad`).
globalThis.__csimQueueTask = (fn) => queueTask(fn);
// …and realms `realms` — a closed page's and its frames', its isolate the host of the windows it made (browser.rb
// `destroy_page`) — discarded: inert, no task of theirs runnable (HTML "destroy a document").
globalThis.__csimDiscardRealms = (realms) => {
  for (const realm of realms) globalThis.__dom.discardRealm(realm);
  if (realms.includes(globalThis.__csimRealmId())) pageDestroyed = true;
};
// …a task of its own event loop, queued on its global whichever realm's `close()` asked (HTML "queue a global task …
// given thisArg's relevant global object"): after what it was asked before, before what it is asked after — a message
// posted to it after its close is never delivered.
globalThis.__csimQueueWindowClose = (key) => queueTask(() => {
  globalThis.__csimPromptToUnload();
  discardWindow(globalThis, key);
});
// …its document unloaded, then its browsing context discarded: its realm inert — no task of it runs after, a message
// posted to it after its close among them (HTML: a task whose document is not fully active is not runnable).
function discardWindow(win, key) {
  win.__csimFireWindowUnloadDeep();
  win.__dom.discardWindow(key);
  win.__dom.discardRealm(win.__csimRealmId());
  globalThis.__csimWindowRealmsChanged?.();
}

const windowSteps = {
  // ── Its browsing context
  get_window: (win) => win,
  get_self: (win) => win,
  get_document: (win) => win.__csimDocument,
  get_name: (win) => win.__dom.windowName(),
  set_name(win, value) {
    win.__dom.setWindowName(value);
    // (…a frame's, which its parent's window finds it by: the gate of its named access)
    const parent = win.__csimParent;
    if (parent && parent !== win) parent.__csimRegisterNavigableName(value);
  },
  get_location: () => location,
  get_history: () => history,
  get_customElements: () => customElements,
  get_locationbar: () => bars.locationbar,
  get_menubar: () => bars.menubar,
  get_personalbar: () => bars.personalbar,
  get_scrollbars: () => bars.scrollbars,
  get_statusbar: () => bars.statusbar,
  get_toolbar: () => bars.toolbar,
  get_status: (win) => win.__csimWindowStatus,
  set_status(win, value) { win.__csimWindowStatus = value; },
  // A window a script opened closes when asked: closing at once — `closed`, no window its name finds, nor the one with
  // system focus, which goes back to the page (navigables.rs `focus_chain`) — and closed as a task of its event loop
  // (HTML "close a top-level traversable"): its document asked whether it may be unloaded (`beforeunload`, which goes
  // on whatever a handler says, as a navigation's does: browser.rb `prompt_page_to_unload`), then unloaded, its browsing
  // context then discarded, its realm lingering inert. Any other ignores it, as a browser does a tab the user opened.
  // The isolate's page — a window of a browsing context group of its own — is the host's to close the same way, where
  // it is script-closable (Browser#script_close). A frame's closes nothing. None but where the calling script's
  // browsing context is familiar with the window's and allowed by sandboxing to navigate it (navigables.rs
  // `close_allowed`): the caller the entry realm (`callerRealm`).
  close(win) {
    if (!win.__dom.closeAllowed(callerRealm(), win.__csimRealmId())) return;
    const key = windowKey(win);
    if (win.__dom.closeWindow(key)) {
      focusChanged();
      globalThis.__csimWindowRealmsChanged?.();
      win.__csimQueueWindowClose(key);
    } else if (ownPage(win)) globalThis.__csimWindowClose?.();
  },
  get_closed: (win) => discarded(win) || win.__dom.windowClosed(windowKey(win)) || (ownPage(win) && win.__dom.traversableClosing()),
  // HTML "stop document loading": its document's loading aborted — what of that is modeled, its event sources' fetches
  // (`__csimAbortEventSources`); the parser and the other loads of its document and of its frames' are not
  stop(win) { win.__csimAbortEventSources(); },
  focus: () => focusWindow(),
  blur() {},
  // ── Other browsing contexts
  // (…the window itself — HTML's `frames` getter returns this's relevant realm's WindowProxy — whose child frames by index
  // its named properties object answers: dom-nodes.js `WindowNamedProps`)
  get_frames: (win) => win,
  get_length: () => childFrameCount(),
  // (…none for a window whose browsing context is gone: HTML's `top`, `parent`, `opener` and `frameElement` getters)
  get_top: (win) => (discarded(win) ? null : win.__csimTop),
  // The window that opened it — a realm of this isolate, as every window of its browsing context group is (the
  // engine's) — none once its page disowned it (`opener = null`), and a top-level window's alone: a frame's browsing
  // context has no opener (HTML §7.2.2.1), whatever window its top-level one was opened by. Any other value a page sets
  // replaces the member ([Replaceable]).
  get_opener(win) {
    if (win.__csimParent !== win || discarded(win)) return null;
    const opener = win.__dom.windowOpener(windowKey(win));
    return opener >= 0 ? globalThis.__csimFrameWindowProxyFor(opener) : null;
  },
  set_opener(win, value) {
    if (value !== null) Object.defineProperty(win, 'opener', { value, writable: true, enumerable: true, configurable: true });
    else if (win.__csimParent === win) win.__dom.disownOpener(windowKey(win));
  },
  get_parent: (win) => (discarded(win) ? null : win.__csimParent),
  // The container — null to a document not of its origin, a cross-origin or sandboxed one (HTML §7.2.3.4).
  get_frameElement(win) {
    const el = win.__csimFrameContainer;
    const parent = win.__csimParent;
    if (!el || parent === win || discarded(win)) return null;
    // (…of its origin by the origins' keys: an opaque one shared — a child that inherited it — same, a new one not)
    return globalThis.__csimIsSameOriginWindow(parent.__csimRawWindow || parent) ? el : null;
  },
  open: (win, url, target, features) => openWindow(url, target, features),
  get_navigator: () => navigator,
  get_clientInformation: () => navigator,
  get_originAgentCluster: () => false,
  // ── User prompts
  alert_none: () => alert(''),
  alert_message: (win, message) => alert(message),
  confirm: (win, message) => confirm(message),
  prompt: (win, message, value) => prompt(message, value),
  print: () => print(),
  // (…to this window: another's is this realm's post to it, its source this window — `postMessage` below)
  postMessage_message_targetOrigin_transfer: (win, message, targetOrigin, transfer) => postMessageToSelf(message, targetOrigin, transfer),
  postMessage_message_options: (win, message, options) => postMessageToSelf(message, options.targetOrigin, options.transfer),
  // ── CSSOM View
  matchMedia: (win, query) => matchMedia(query),
  get_screen: () => screen,
  get_visualViewport: () => visualViewport,
  moveTo() {},
  moveBy() {},
  resizeTo() {},
  resizeBy() {},
  get_innerWidth: () => globalThis.__dom.viewport(0),
  get_innerHeight: () => globalThis.__dom.viewport(1),
  get_scrollX: () => windowScrollX(),
  get_pageXOffset: () => windowScrollX(),
  get_scrollY: () => windowScrollY(),
  get_pageYOffset: () => windowScrollY(),
  scroll_options: (win, options) => scrollWindow(options.left, options.top, false),
  scroll_x_y: (win, x, y) => scrollWindow(x, y, false),
  scrollTo_options: (win, options) => scrollWindow(options.left, options.top, false),
  scrollTo_x_y: (win, x, y) => scrollWindow(x, y, false),
  scrollBy_options: (win, options) => scrollWindow(options.left, options.top, true),
  scrollBy_x_y: (win, x, y) => scrollWindow(x, y, true),
  // (…no window chrome and no screen offset: the window fills the display's corner, its outer size its inner one)
  get_screenX: () => 0,
  get_screenLeft: () => 0,
  get_screenY: () => 0,
  get_screenTop: () => 0,
  get_outerWidth: () => globalThis.__dom.viewport(0),
  get_outerHeight: () => globalThis.__dom.viewport(1),
  get_devicePixelRatio: () => globalThis.__dom.devicePixelRatio(),
  getComputedStyle: (win, elt, pseudoElt) => getComputedStyle(elt, pseudoElt),
  get_event: (win) => win.__csimCurrentEvent,
  getSelection: () => getSelection(),
  // ── WindowOrWorkerGlobalScope
  get_origin: () => documentOrigin(),
  get_isSecureContext: () => true,
  get_crossOriginIsolated: () => isCrossOriginIsolated(),
  reportError: (win, e) => reportError(e),
  btoa: (win, data) => btoa(data),
  atob: (win, data) => atob(data),
  setTimeout: (win, handler, timeout, args) => setTimeout(handler, timeout, args),
  clearTimeout: (win, id) => clearTimer(id),
  setInterval: (win, handler, timeout, args) => setInterval(handler, timeout, args),
  clearInterval: (win, id) => clearTimer(id),
  queueMicrotask: (win, callback) => queueMicrotask(callback),
  createImageBitmap_image_options: (win, image, options) => createImageBitmap(image, null, options),
  createImageBitmap_image_sx_sy_sw_sh_options: (win, image, sx, sy, sw, sh, options) =>
    createImageBitmap(image, [sx, sy, sw, sh], options),
  structuredClone: (win, value, options) => cloneFor("Failed to execute 'structuredClone' on 'Window': ", value, options),
  get_indexedDB: () => indexedDB,
  get_performance: () => performance,
  get_caches: () => caches,
  get_crypto: () => crypto,
  requestAnimationFrame: (win, callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (win, handle) => cancelAnimationFrame(handle),
  get_sessionStorage: () => storageOfDocument('sessionStorage', sessionStorage),
  get_localStorage: () => storageOfDocument('localStorage', localStorage),
  // ── Obsolete
  captureEvents() {},
  releaseEvents() {},
  get_external: () => external,
  requestIdleCallback: (win, callback, options) => requestIdleCallback(callback, options),
  cancelIdleCallback: (win, handle) => cancelIdleCallback(handle)
};

// …each the steps of `this` window's realm: a member of this realm called on another window (`frames[0].scrollTo`
// read off this realm's global and called on the frame's) is the other window's, which its own realm's steps answer —
// after Web IDL's security check: on a window of another origin, only HTML's CrossOriginProperties may be called (a
// SecurityError for the rest, `Object.getOwnPropertyDescriptor(window, 'document').get.call(frame)`).
// (…an attribute's getter, the hot `document` among them, with no rest of arguments to gather)
function otherWindow(win, crossOrigin) {
  const raw = win.__csimRawWindow || win;
  if (!crossOrigin && raw !== globalThis && !globalThis.__csimIsSameOriginWindow(raw)) {
    throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
  }
  return raw;
}
const impl = { installEventHandlers: installEventHandlerAttrs };
// A post to another window is this realm's, through its WindowProxy here: the message's source this window, its origin
// this window's (`postMessage.call(frame, …)` as `frame.postMessage(…)`).
const POST_MESSAGE = new Set(['postMessage_message_targetOrigin_transfer', 'postMessage_message_options']);
function postMessageTo(raw, message, targetOriginOrOptions, transfer) {
  const proxy = globalThis.__csimFrameWindowProxyFor(globalThis.RustyRacer.contextOf(raw));
  return proxy.postMessage(message, targetOriginOrOptions, transfer);
}
for (const [name, steps] of Object.entries(windowSteps)) {
  if (POST_MESSAGE.has(name)) {
    impl[name] = (win, ...args) => {
      const raw = otherWindow(win, true);
      return raw === globalThis ? steps(raw, ...args) : postMessageTo(raw, ...args);
    };
    continue;
  }
  // (…a getter or an operation: no setter but `location`'s, which is no step here, is one cross-origin)
  const crossOrigin = !name.startsWith('set_') && CROSS_ORIGIN_WINDOW_PROPERTIES.has(name.replace(/^get_/, '').split('_')[0]);
  const stepsOf = (raw) => (raw === globalThis ? steps : raw.__csimWindowSteps[name]);
  impl[name] = name.startsWith('get_')
    ? (win) => {
      if (win === globalThis) return steps(win);
      const raw = otherWindow(win, crossOrigin);
      return stepsOf(raw)(raw);
    }
    : (win, ...args) => {
      if (win === globalThis) return steps(win, ...args);
      const raw = otherWindow(win, crossOrigin);
      return stepsOf(raw)(raw, ...args);
    };
}

// The host names a new top-level window (`window.open`'s target name, a named form or link target) before its document
// loads. (A frame's navigable is named by its container: navigables.rs.)
globalThis.__csimSetWindowName = function (n) {
  globalThis.__dom.setWindowName(n == null ? '' : String(n));
};
// …and the target name a window of this isolate's next document, at `url`, keeps (`csp` its response's, whose `sandbox`
// makes its origin an opaque one of its own; `origin` its origin where its URL does not say it — both as
// `__csimKeepsWindowFor` takes them): its own — HTML keeps it in the navigable's active document state,
// which a navigation hands on (WPT choose-_top-001.html: `window.name = 'n'; open(url, '_top')`, `url`'s reads 'n') —
// but cleared where that origin is another than the one it leaves, unless it is an auxiliary window whose opener is
// still there, not disowned (HTML "finalize a cross-document navigation"; WPT clear-window-name.https.html); its initial
// about:blank leaves it as it is (browser.rb `clear_navigable_name`, the page's).
globalThis.__csimWindowNameFor = function (url, csp, origin = parseURL(url)?.origin) {
  const name = globalThis.__dom.windowName();
  if (hasState(globalThis.document, STATE_INITIAL_ABOUT_BLANK)) return name;
  const own = documentOrigin();
  const opaque = csp && globalThis.__dom.cspSandboxing(csp) !== 0;
  if (!opaque && own !== 'null' && own === origin) return name;
  return globalThis.__dom.windowOpener(windowKey(globalThis)) >= 0 ? name : '';
};

// Make the global a Window, where the snapshot is — once every interface the members take is registered (bridge.entry.js,
// after the element interfaces): its state, then its members (GlobalEventHandlers' and WindowEventHandlers' among them,
// its listeners as an element's handlers are), configurable, which every realm made from the snapshot has already. A
// worker's realm drops them (`windowMemberNames`, worker-globals.js).
let windowInterface = null;
export function prepareWindowInterface() {
  const state = {
    __csimWindowSteps: windowSteps,
    __csimDocument: null,
    __csimTop: globalThis,
    __csimParent: globalThis,
    __csimWindowStatus: '',
    __csimCurrentEvent: undefined
  };
  for (const [key, value] of Object.entries(state)) {
    Object.defineProperty(globalThis, key, { value, writable: true, enumerable: false, configurable: true });
  }
  windowInterface = installWindow(globalThis.Window, impl);
  windowInterface.defineMembers(globalThis);
  // (…and the global's prototype chain Web IDL's for a [Global] interface: Window.prototype, the named properties object
  // (WindowProperties), EventTarget.prototype — its members its own, its EventTarget methods inherited. The named
  // properties object is the global's prototype dom-nodes.js made it, `WindowNamedProps`, which answers a window's named
  // properties — an element's id or name — and its child navigables by index.)
  const windowProperties = Object.getPrototypeOf(globalThis);
  if (Object.prototype.hasOwnProperty.call(windowProperties, 'constructor')) delete windowProperties.constructor;
  Object.defineProperty(windowProperties, Symbol.toStringTag, { value: 'WindowProperties', configurable: true });
  Object.setPrototypeOf(windowProperties, EventTarget.prototype);
  Object.setPrototypeOf(globalThis.Window.prototype, windowProperties);
  Object.setPrototypeOf(globalThis, globalThis.Window.prototype);
}
export function windowMemberNames() {
  return windowInterface.names;
}

// …and as a window realm is made from it, its document and its [LegacyUnforgeable] members — `window`, `document`,
// `location`, `top` — which no worker's realm may have: non-configurable, they could not be dropped.
export function installWindowInterface(document) {
  globalThis.__csimDocument = document;
  globalThis.__dom.setRealmDocument(document._nid);
  windowInterface.defineUnforgeables(globalThis);
}

