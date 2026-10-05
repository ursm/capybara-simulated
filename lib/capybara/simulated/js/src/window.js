// The Window interface (HTML §7.2.2), [Global]: its members are the global object's own (Web IDL §3.7.5), generated
// from its IDL (generated/bindings.js `installWindow`) and defined where the snapshot is — but the [LegacyUnforgeable]
// ones, defined as a window realm is made (`__csimInitRealm`): a worker's global is made from the same snapshot, and
// drops the rest (worker-globals.js). Each member answers for the window its `this` is: this realm's global, or —
// through a WindowProxy, or another realm's member called on it — another window, whose realm's own steps it goes on to.
//
// A window's state the driver and the other realms set lives on its global, as the rest of the driver's does
// (`__csim*`, unenumerable): its `top` and `parent` (a frame's, which the realm builder wires), its name, status and
// opener, whether a script may close it, and the current event.

import { installWindow } from './generated/bindings.js';
import { installEventHandlerAttrs } from './events.js';
import {
  cancelIdleCallback, childFrameCount, documentOrigin, focusWindow, frames, hostOpener, openWindow, performance,
  postMessageToSelf, reportError, requestIdleCallback, screen, scrollWindow, structuredClone, visualViewport,
  windowScrollX, windowScrollY
} from './platform-globals.js';
import {
  cancelAnimationFrame, clearTimer, queueMicrotask, requestAnimationFrame, setInterval, setTimeout
} from './timers.js';
import { alert, confirm, prompt } from './dialogs.js';
import { atob, btoa } from './encoding.js';
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

// BarProp (HTML §7.2.2.5): whether a part of the window's chrome is visible — every one of a window that is no popup.
class BarProp {
  get visible() { return true; }
}
// External (HTML §11.3.4): the search-provider operations, which do nothing.
class External {
  AddSearchProvider() {}
  IsSearchProviderInstalled() {}
}
const bars = {
  locationbar: new BarProp(), menubar: new BarProp(), personalbar: new BarProp(),
  scrollbars: new BarProp(), statusbar: new BarProp(), toolbar: new BarProp()
};
const external = new External();

// The member steps, for the window `win` — this realm's global, which the generated binding's check found `this` to be
// (or a WindowProxy of it).
const windowSteps = {
  // ── Its browsing context
  get_window: (win) => win,
  get_self: (win) => win,
  get_document: (win) => win.__csimDocument,
  get_name: (win) => win.__csimWindowName,
  set_name(win, value) { win.__csimWindowName = value; },
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
  // A window a script opened closes when asked (its realm lingers, inert, a closed window's proxy reporting it); any
  // other ignores it, as a browser does a tab the user opened.
  close(win) { if (win.__csimScriptClosable) win.__csimWindowClosedFlag = true; },
  get_closed: (win) => win.__csimBrowsingContextDiscarded === true || win.__csimWindowClosedFlag === true,
  stop() {},
  focus: () => focusWindow(),
  blur() {},
  // ── Other browsing contexts
  get_frames: () => frames,
  get_length: () => childFrameCount(),
  get_top: (win) => win.__csimTop,
  // The opener a page or the driver set (`opener = null` disowns it), else the host's.
  get_opener: (win) => win.__csimOpener !== undefined ? win.__csimOpener : hostOpener(),
  set_opener(win, value) {
    if (value === null) win.__csimOpener = null;
    else Object.defineProperty(win, 'opener', { value, writable: true, enumerable: true, configurable: true });
  },
  get_parent: (win) => win.__csimParent,
  // The container — null to a document not of its origin, a cross-origin or sandboxed one (HTML §7.2.3.4).
  get_frameElement(win) {
    const el = win.__csimFrameContainer;
    const parent = win.__csimParent;
    if (!el || parent === win) return null;
    const origin = documentOrigin();
    return origin !== 'null' && origin === (parent.__csimRawWindow || parent).__csimOrigin() ? el : null;
  },
  open: (win, url, target) => openWindow(url, target),
  get_navigator: () => navigator,
  get_clientInformation: () => navigator,
  get_originAgentCluster: () => false,
  // ── User prompts
  alert_none: () => alert(''),
  alert_message: (win, message) => alert(message),
  confirm: (win, message) => confirm(message),
  prompt: (win, message, value) => prompt(message, value),
  print() {},
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
  get_innerWidth: (win) => win.__csimViewport.width,
  get_innerHeight: (win) => win.__csimViewport.height,
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
  get_outerWidth: (win) => win.__csimViewport.width,
  get_outerHeight: (win) => win.__csimViewport.height,
  get_devicePixelRatio: () => 1,
  getComputedStyle: (win, elt, pseudoElt) => getComputedStyle(elt, pseudoElt),
  get_event: (win) => win.__csimCurrentEvent,
  getSelection: () => getSelection(),
  // ── WindowOrWorkerGlobalScope
  get_origin: () => documentOrigin(),
  get_isSecureContext: () => true,
  // (…no document here is served COOP + COEP, the only way one becomes cross-origin isolated)
  get_crossOriginIsolated: () => false,
  reportError: (win, e) => reportError(e),
  btoa: (win, data) => btoa(data),
  atob: (win, data) => atob(data),
  setTimeout: (win, handler, timeout, args) => setTimeout(handler, timeout, args),
  clearTimeout: (win, id) => clearTimer(id),
  setInterval: (win, handler, timeout, args) => setInterval(handler, timeout, args),
  clearInterval: (win, id) => clearTimer(id),
  queueMicrotask: (win, callback) => queueMicrotask(callback),
  createImageBitmap_image_options: (win, image, options) => createImageBitmap(image, options),
  createImageBitmap_image_sx_sy_sw_sh_options: (win, image, sx, sy, sw, sh, options) => createImageBitmap(image, sx, sy, sw, sh, options),
  structuredClone: (win, value, options) => structuredClone(value, options),
  get_indexedDB: () => indexedDB,
  get_performance: () => performance,
  get_caches: () => caches,
  get_crypto: () => crypto,
  requestAnimationFrame: (win, callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (win, handle) => cancelAnimationFrame(handle),
  get_sessionStorage: () => sessionStorage,
  get_localStorage: () => localStorage,
  // ── Obsolete
  captureEvents() {},
  releaseEvents() {},
  get_external: () => external,
  requestIdleCallback: (win, callback) => requestIdleCallback(callback),
  cancelIdleCallback: (win, handle) => cancelIdleCallback(handle)
};

// …each the steps of `this` window's realm: a member of this realm called on another window (`frames[0].scrollTo`
// read off this realm's global and called on the frame's) is the other window's, which its own realm's steps answer —
// after Web IDL's security check: on a window of another origin, only HTML's CrossOriginProperties may be called (a
// SecurityError for the rest, `Object.getOwnPropertyDescriptor(window, 'document').get.call(frame)`).
// (…an attribute's getter, the hot `document` among them, with no rest of arguments to gather)
const CROSS_ORIGIN_MEMBERS = new Set([
  'window', 'self', 'location', 'close', 'closed', 'focus', 'blur', 'frames', 'length', 'top', 'opener', 'parent', 'postMessage'
]);
function otherWindow(win, crossOrigin) {
  const raw = win.__csimRawWindow || win;
  if (!crossOrigin && raw !== globalThis && !globalThis.__csimIsSameOriginWindow(raw)) {
    throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
  }
  return raw;
}
const impl = { installEventHandlers(global, names) { installEventHandlerAttrs(global, names, null); } };
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
  const crossOrigin = !name.startsWith('set_') && CROSS_ORIGIN_MEMBERS.has(name.replace(/^get_/, '').split('_')[0]);
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

// The frame realm builder names the window after its container's `name` attribute before the document loads (a
// frame's load handler reading `window.name` identifies itself by it: declarative-child-frame).
globalThis.__csimSetWindowName = function (n) {
  globalThis.__csimWindowName = n == null ? '' : String(n);
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
    __csimWindowName: '',
    __csimWindowStatus: '',
    __csimOpener: undefined,
    __csimScriptClosable: false,
    __csimWindowClosedFlag: false,
    __csimCurrentEvent: undefined,
    __csimOrigin: documentOrigin
  };
  for (const [key, value] of Object.entries(state)) {
    Object.defineProperty(globalThis, key, { value, writable: true, enumerable: false, configurable: true });
  }
  windowInterface = installWindow(globalThis.Window, impl);
  windowInterface.defineMembers(globalThis);
}
export function windowMemberNames() {
  return windowInterface.names;
}

// …and as a window realm is made from it, its document and its [LegacyUnforgeable] members — `window`, `document`,
// `location`, `top` — which no worker's realm may have: non-configurable, they could not be dropped.
export function installWindowInterface(document) {
  globalThis.__csimDocument = document;
  windowInterface.defineUnforgeables(globalThis);
}

