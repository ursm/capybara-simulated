// Closure-free Web platform stubs. Just enough surface that
// feature-detection ("typeof CSS !== 'undefined'", "performance.now",
// "navigator.crypto.randomUUID") returns truthy and modern code paths
// don't crash on a missing global.

import {
  ErrorEvent, Event, EventTarget, PageTransitionEvent, createBeforeUnloadEvent, createMessageEvent,
  dispatchWithOnHandler, eventState, installEventHandlerAttrs, listenersOf
} from './events.js';
import { parseURL } from './url-parse.js';
import { documentOrigin } from './document-origin.js';
import {
  CROSS_ORIGIN_LOCATION_KINDS, CROSS_ORIGIN_LOCATION_PROPERTIES, CROSS_ORIGIN_WINDOW_KINDS, CROSS_ORIGIN_WINDOW_PROPERTIES,
  installScreenOrientation
} from './generated/bindings.js';
import { transferListFrom } from './bytes.js';
import { decodeMessage, encodeMessage, messageEventType } from './workers.js';
import { cryptoKeyFromRecord, cryptoKeyRecord, installWebCrypto } from './webcrypto.js';
import {
  OPEN_NOOPENER, OPEN_NOREFERRER, openFeaturesOf, settledScrollOffsetOf
} from './native-query-shadow.js';
import { focusRealm, frameRealmOf } from './handles.js';
import { geometryFromRecord, geometryRecord } from './geometry.js';
import {
  checkOffscreenCanvasTransfer, cloneImageBitmap, closeImageBitmap, detachOffscreenCanvas, imageBitmapClosed,
  transferredOffscreenCanvas
} from './canvas.js';
import {
  PLATFORM,
  constructedBy,
  hasSlots,
  interfaceCheck,
  isBufferOf,
  makeSlots,
  promiseThen,
  registerInterface,
  rejectedPromise,
  required,
  resolvedPromise,
  slotsOf,
  toUSVString
} from './webidl.js';
import { childNavigableContainers, frameContentWindow, logPopupRefused, scrollBox } from './dom-nodes.js';
import { documentElementOf } from './document-tree.js';
import { documentBaseURL, parseDocumentURL } from './base-url.js';
import { hostTask, queueTask } from './timers.js';
import { fireEvent } from './dispatch.js';
import { location } from './location.js';
import { createFileList, filesOf } from './file-list.js';
import { acceptSerialized, closePort, installPorts, isMessagePort, movePort, peerOf, portDetached, postRemote } from './message-port.js';
import { ReadableStream } from './streams.js';
import { Blob, File, blobByteArray, blobType, fileLastModified, fileName, isBlob, isFile } from './blob.js';
import { DOMException, deserializeException, serializeException } from './dom-exception.js';
import { logError } from './console.js';

const isImageBitmap = interfaceCheck('ImageBitmap');
const isOffscreenCanvas = interfaceCheck('OffscreenCanvas');

// Web Crypto API — `crypto` (getRandomValues / randomUUID), `crypto.subtle`
// (SubtleCrypto), and CryptoKey, backed by Ruby's OpenSSL. In browsers `crypto`
// is a WindowOrWorkerGlobalScope member on `globalThis`, so apps don't
// feature-detect it: Tagify's `getUID`, ActiveStorage's DirectUpload, and every
// auth stack call it directly. See js/src/webcrypto.js for the operation set.
installWebCrypto(globalThis);

// `screen.orientation` (Screen Orientation), generated from its IDL — an EventTarget (it announces `change` as the
// device rotates). A fixed viewport never rotates, so `change` never fires — but the EventTarget surface has to exist
// regardless, because listening is unconditional in the wild and an object that is truthy-but-not-an-EventTarget passes
// an `if (screen.orientation)` guard and then throws on addEventListener. Values match headless Chrome on a desktop
// profile, down to `lock()` rejecting NotSupportedError (a desktop's orientation cannot be locked) and `unlock()` being
// a no-op. Made by the platform alone: the one `screen` has.
class ScreenOrientation extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'ScreenOrientation');
    super();
    makeSlots(this, 'ScreenOrientation', {});
  }
}
registerInterface('ScreenOrientation', (o) => slotsOf(o, 'ScreenOrientation') !== undefined);
installScreenOrientation(ScreenOrientation, {
  get_type: () => 'landscape-primary',
  get_angle: () => 0,
  lock: () => rejectedPromise(new DOMException('screen.orientation.lock() is not available on this device.', 'NotSupportedError')),
  unlock() {},
  installEventHandlers: installEventHandlerAttrs
});
globalThis.ScreenOrientation = ScreenOrientation;

// `screen` is the DISPLAY, not the window: it stays put while `resize_to` moves the viewport,
// exactly as a real browser's does, and it is what `maximize` / `fullscreen` resize back to.
// Libraries probe it for HiDPI / responsive decisions and we fall to the "small desktop" branch.
// (The Window's, window.js.)
// Its size is the engine's (viewport.rs `SCREEN`), which the Ruby side's `Browser::SCREEN_SIZE` reads too.
export const screen = {
  get width()       { return globalThis.__dom.screenSize(0); },
  get height()      { return globalThis.__dom.screenSize(1); },
  get availWidth()  { return globalThis.__dom.screenSize(0); },
  get availHeight() { return globalThis.__dom.screenSize(1); },
  colorDepth:  24,
  pixelDepth:  24,
  orientation: new ScreenOrientation(PLATFORM)
};

// …and the container the driver reads, whatever the page may see — its navigable's (navigables.rs `ownContainer`): its
// realm is linked to it as it is made, before its document's first script runs (Chrome: `frameElement` there already);
// none for a top-level document, nor a frame's removed.
Object.defineProperty(globalThis, '__csimFrameContainer', {
  configurable: true,
  get() { return globalThis.__dom ? globalThis.__dom.ownContainer() : null; }
});

// The current settings object's API base URL: the realm's document base URI (which honours `<base href>`, and which a
// srcdoc document inherits), falling back to its location — NOT a fixed top-level URL, so `new otherRealm.Request("rel")`
// resolves against otherRealm's base (request/multi-globals url-parsing).
export function apiBaseURL() {
  return globalThis.document ? documentBaseURL(globalThis.document) : location.href;
}

// The origin KEY — what makes two origins the same one: what a BroadcastChannel is scoped to, and what postMessage's
// target origin is matched by — the engine's (realm_location.rs `originKey`). For a tuple (non-opaque) origin it's the
// serialized origin string. For an OPAQUE origin (serialized as "null" — a sandboxed / data: / srcdoc context) every
// context has its OWN unique opaque origin, so a bare "null" can't be the key: two unrelated opaque contexts would
// collide and cross-talk. A stable per-realm token instead (made on first use), so this context's channel only reaches
// peers sharing its EXACT opaque origin — its own realm, plus any worker that INHERITED it (a blob: worker created
// here: the agent cluster) and any frame that did (an about:blank / srcdoc child, `__csimSetDocumentOrigin`). A worker
// is handed its key explicitly at spawn (`setOriginKey`), so it never makes one.
globalThis.__csimBcOriginKey = () => globalThis.__dom.originKey();
// Serialize an origin key back to what MessageEvent.origin exposes: an opaque token → "null";
// a tuple origin is itself.
export const serializeOriginKey = (key) => globalThis.__dom.keyOrigin(key);

// `window.frames` is the window itself, but indexable by frame number: a
// numeric `frames[i]` is the i-th nested browsing context's window — for us the
// i-th `<iframe>`/`<frame>`'s `contentWindow` (a real per-frame realm global) —
// and `frames.length` their count. Everything else delegates to the window. (The
// global can't be indexed itself, so this is a Proxy of it, which `frames ===
// window` tells apart — the Window's, window.js.)
export function childFrameCount() {
  return childNavigableContainers().length;
}
export const frames = new Proxy(globalThis, {
  get(target, prop) {
    if (typeof prop === 'string' && /^(0|[1-9][0-9]*)$/.test(prop)) {
      const el = childNavigableContainers(Number(prop) + 1)[Number(prop)];
      return el ? frameContentWindow(el) : undefined;
    }
    if (prop === 'length') return childFrameCount();
    return Reflect.get(target, prop, globalThis);
  }
});

// scrollX / scrollY (and the deprecated pageXOffset / pageYOffset
// aliases) reflect the scrolling element's offsets. Discourse's
// `route-scroll-manager` service reads `window.scrollY` to assert
// scroll position before/after route transitions; without live
// getters every poll lands on 0 even after a `scrollIntoView`.
export function windowScrollX() {
  const root = globalThis.document && documentElementOf(globalThis.document);
  return root ? settledScrollOffsetOf(root, 0) : 0;
}
export function windowScrollY() {
  const root = globalThis.document && documentElementOf(globalThis.document);
  return root ? settledScrollOffsetOf(root, 1) : 0;
}

// `visualViewport` — modern mobile-keyboard / pinch-zoom aware
// viewport. Apps subscribe to its `resize` / `scroll` events to
// reflow when the soft keyboard appears (Mastodon's composer, chat
// UIs). Static values match the layout viewport; listeners are
// stored but never invoked because we don't model layout shifts.
export const visualViewport = {
  get offsetLeft() { return 0; },
  get offsetTop()  { return 0; },
  get pageLeft()   { return windowScrollX(); },
  get pageTop()    { return windowScrollY(); },
  get width()      { return globalThis.__dom.viewport(0); },
  get height()     { return globalThis.__dom.viewport(1); },
  get scale()      { return 1; },
  onresize: null,
  onscroll: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
};
// The window's scrolls (CSSOM View): the VIEWPORT's, kept on the root — which is what `window.scrollY` reads:
// `page.execute_script("window.scrollTo(0, 0)")` and Discourse's logo-refresh path scroll the page so — whatever element
// is the scrolling element, a quirks page with none among them. `scroll` and `scrollTo` to a position, `scrollBy` by an
// offset — a promise of the scroll's completion. (The Window's, window.js, which converted the arguments.)
export function scrollWindow(x, y, by) {
  const root = globalThis.document && documentElementOf(globalThis.document);
  return root ? scrollBox(root, x, y, by) : resolvedPromise();
}
// This realm's own id, as the host knows it — 0 for the main realm. Every JS→host call that
// names a browsing context (port endpoints, the focus chain) identifies itself through this.
// (…the one its engine ops are bound to, which a realm whose frame was removed keeps: its context's lookup answers none
// then, which named it the top page's)
globalThis.__csimRealmId = function () {
  return globalThis.__dom ? globalThis.__dom.realmId : globalThis.RustyRacer.contextOf(globalThis) || 0;
};
// `window.focus()` — HTML "focusing steps" applied to a BROWSING CONTEXT rather than an
// element: it moves the focus chain to this window without touching its activeElement (the
// engine's: `focusRealm`). There is no window manager to raise, so nothing else happens. (The
// Window's, window.js, whose `blur()` is the no-op it is in every modern browser: the spec
// says user agents may ignore it.)
export function focusWindow() {
  focusRealm(globalThis.__csimRealmId());
}

// `CSS.escape(s)` per CSSOM — serialise `s` as a CSS identifier
// (control chars become `\xx ` hex escapes, leading digits / `-`
// get escaped, etc.). Turbo Drive's `extractForeignFrameElement`
// builds `\`turbo-frame#${CSS.escape(this.id)}\`` to scope its
// `querySelector` to the right frame; without `CSS` the whole
// chain throws and `turbo-frame[loading=lazy]` content never
// renders. `supports()` defaults to `true` so feature gates take
// the modern path; tests that rely on the legacy fallback would
// need a real cascade to verify anyway.
globalThis.CSS = {
  // (…CSSOM's "serialize an identifier", the engine's: dom.rs `cssEscape`)
  escape(value) {
    if (arguments.length === 0) throw new TypeError('CSS.escape requires an argument.');
    return globalThis.__dom.cssEscape(String(value));
  },
  // Both forms are the style engine's (cssom_decl.rs): does the declaration `property: value` parse as one the engine
  // implements — the judgement the declaration setter makes, so `CSS.supports('line-height', '-1')` and
  // `el.style.lineHeight = '-1'` cannot disagree — and, given one argument, a `<supports-condition>` or a bare
  // declaration (`CSS.supports('display: grid')`), evaluated as an `@supports` rule evaluates it.
  supports(property, value) {
    if (arguments.length < 2) return globalThis.__dom.declSupportsCondition(String(property));
    return globalThis.__dom.declSupports(String(property), String(value));
  }
};
// `CSS` is a namespace object: `Object.prototype.toString.call(CSS)` is
// `[object CSS]` via a configurable, non-writable, non-enumerable @@toStringTag.
Object.defineProperty(globalThis.CSS, Symbol.toStringTag, { value: 'CSS', configurable: true });

// ── The structured clone (clone.rs) ──────────────────────────────────────────────────────────────────────────────────
// V8's own serializer writes the JavaScript values — primitives and their wrappers, Dates, RegExps, Maps, Sets,
// ArrayBuffers and their views, errors, arrays and ordinary objects, cycles and shared references kept — and the
// bindings say what each platform object serializes to (`serializePlatformObject`) and make the one a serialization
// makes (`deserializePlatformObjects`).

// (…what no structured clone takes: any realm's EventTarget or Event — whose state is no slots yet; and the exception
// it takes as one)
const IS_EVENT_TARGET    = interfaceCheck('EventTarget');
const IS_EVENT           = interfaceCheck('Event');
const IS_DOM_EXCEPTION   = interfaceCheck('DOMException');
const IS_READABLE_STREAM = interfaceCheck('ReadableStream');
// (…and the polyfill's own members a transfer reads, not ones a page may replace)
const streamLocked = (t) => Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'locked').get.call(t);
const streamReader = (t) => ReadableStream.prototype.getReader.call(t);
const isArrayBuffer = (v) => isBufferOf(v, 'ArrayBuffer');
const uncloneable = (what) => dataCloneError(`${what} could not be cloned.`);
function dataCloneError(msg) {
  return new DOMException(msg || 'An object could not be cloned.', 'DataCloneError');
}

// The structured clone in progress, or null: its transfer list (null for none), each transferable's moved counterpart,
// the steps that detach the sources once all of them are moved — and the records of the Blobs serialized so far, each
// once, so a File a FileList holds and the File itself are one object again.
let currentClone = null;

// Whether `t` is a transferable object in a usable (non-detached) state — WITHOUT neutering it: a DataCloneError
// otherwise (StructuredSerializeWithTransfer's checks, made before the value is serialized and again after, a getter
// having moved one meanwhile). Any realm's, by its brand. (One that cannot be detached is the transfer's to find:
// `serializeWithTransfer`.)
function validateTransferable(t) {
  if (isArrayBuffer(t)) {
    if (t.detached) throw dataCloneError('An ArrayBuffer is detached and could not be transferred.');
    return;
  }
  if (isMessagePort(t))               { if (portDetached(t)) throw dataCloneError('A detached MessagePort could not be transferred.'); return; }
  if (isImageBitmap(t)) { if (imageBitmapClosed(t)) throw dataCloneError('An ImageBitmap is detached and could not be transferred.'); return; }
  if (isOffscreenCanvas(t)) { checkOffscreenCanvasTransfer(t); return; }
  if (IS_READABLE_STREAM(t)) { if (streamLocked(t)) throw dataCloneError('A locked ReadableStream could not be transferred.'); return; }
  throw dataCloneError('Value is not a transferable object.');
}

// Transfer a transferable other than an ArrayBuffer to its moved counterpart, the source NEUTERED once every one is
// moved (`currentClone.pendingDetach`).
function transferValue(t) {
  // (…a MessagePort onto a fresh entangled one, its held messages and enabled state with it)
  if (isMessagePort(t)) return movePort(t);
  if (isImageBitmap(t)) {
    currentClone.pendingDetach.push(() => closeImageBitmap(t));
    return cloneImageBitmap(t);
  }
  if (isOffscreenCanvas(t)) {
    currentClone.pendingDetach.push(() => detachOffscreenCanvas(t));
    return transferredOffscreenCanvas(t);
  }
  if (IS_READABLE_STREAM(t)) return { [TRANSFERRED_STREAM]: streamReader(t) };
  throw dataCloneError('Value is not a transferable object.');
}
// (…a ReadableStream, single-isolate: a reader of the source — which it locks, neutering it — that the realm reading the
// value back pipes through a fresh base ReadableStream of its own (`pipedStream`), a subclass thus received as its
// closest transferable superclass; told by a key every realm of the isolate shares, its own)
const TRANSFERRED_STREAM = Symbol.for('csim.transferredStream');
function pipedStream(reader) {
  return new ReadableStream({
    pull(c)    { return promiseThen.call(reader.read(), ({ done, value }) => { if (done) c.close(); else c.enqueue(value); }); },
    cancel(r)  { return reader.cancel(r); }
  });
}
// A moved counterpart another realm of the isolate made, received by this one: made this realm's again, as the
// transfer-receiving steps make it in the realm that reads the value back.
function receiveTransferred(moved) {
  if (isMessagePort(moved)) return movePort(moved);
  if (isImageBitmap(moved)) {
    const received = cloneImageBitmap(moved);
    closeImageBitmap(moved);
    return received;
  }
  if (isOffscreenCanvas(moved)) {
    const received = transferredOffscreenCanvas(moved);
    detachOffscreenCanvas(moved);
    return received;
  }
  // (…a stream's reader, which `deserializeWithTransfer` pipes through one of this realm's)
  return moved;
}

// What a platform object serializes to, as plain data — a record, told by its `__csimType` — for StructuredSerialize to
// write in its place: a transferable being transferred its place in the transfer list, a Blob's or a File's bytes and
// attributes, a FileList's files' records, a DOMException's name and message, a geometry object's numbers, an
// ImageData's or an ImageBitmap's pixels, a CryptoKey's slots — any realm's, by its slots. Undefined for an object that
// is no platform object (a page's class instance, an error: V8 serializes those), and a DataCloneError for one no
// structured clone takes.
function blobRecord(v) {
  const records = currentClone.records ??= new Map();
  let record = records.get(v);
  if (record === undefined) {
    record = { __csimType: isFile(v) ? 'File' : 'Blob', type: blobType(v), bytes: blobByteArray(v) };
    if (isFile(v)) Object.assign(record, { name: fileName(v), lastModified: fileLastModified(v) });
    records.set(v, record);
  }
  return record;
}
export function serializePlatformObject(v) {
  if (currentClone.transfer !== null && currentClone.transfer.has(v)) return { __csimType: 'Transferred', place: currentClone.list.indexOf(v) };
  if (isBlob(v)) return blobRecord(v);
  const files = filesOf(v);
  if (files !== undefined) return { __csimType: 'FileList', files: files.map(blobRecord) };
  if (IS_DOM_EXCEPTION(v)) return { __csimType: 'DOMException', ...serializeException(v), stack: v.stack };
  if (hasSlots(v)) {
    const record = geometryRecord(v) ?? globalThis.__csimCanvasSerialization?.record(v) ?? cryptoKeyRecord(v);
    if (record !== undefined) return record;
  }
  if (IS_EVENT_TARGET(v) || IS_EVENT(v) || hasSlots(v)) throw uncloneable(`${Object.prototype.toString.call(v).slice(8, -1)} object`);
  if (IS_READABLE_STREAM(v)) throw dataCloneError('A ReadableStream could not be cloned because it was not transferred.');
  return undefined;
}
// …and the platform objects of this realm's that records make: an array of them, in the records' order — a record the
// value names twice (a File, and the FileList that holds it) one object.
export function deserializePlatformObjects(records) {
  const made = new Map();
  const of = (r) => {
    let o = made.get(r);
    if (o === undefined) made.set(r, o = platformObjectOf(r, of));
    return o;
  };
  return records.map(of);
}
function platformObjectOf(r, of) {
  switch (r.__csimType) {
    case 'Transferred': return currentClone.moved.get(currentClone.list[r.place]);
    case 'Blob': return new Blob([r.bytes], { type: r.type });
    case 'File': return new File([r.bytes], r.name, { type: r.type, lastModified: r.lastModified });
    case 'FileList': return createFileList(r.files.map(of));
    case 'DOMException': {
      const e = deserializeException(r);
      if (typeof r.stack === 'string') { try { e.stack = r.stack; } catch (_) {} }
      return e;
    }
    case 'Geometry': return geometryFromRecord(r);
    case 'CryptoKey': return cryptoKeyFromRecord(r);
    default: return globalThis.__csimCanvasSerialization.fromRecord(r);
  }
}

// The realm's cross-origin isolated capability (HTML): a window's, its top-level document served
// `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) —
// `__csimInitRealm`'s, as the browser says, a frame's its top-level document's; a dedicated or shared worker's, its
// creating window's, and a service worker's never (`__csim_installWorkerScope`). Without it the realm has no
// SharedArrayBuffer constructor — Chrome 154's and Firefox 157's have none (measured): a page feature-detecting one
// took its buffers for shared ones — and shares none it posts; its shared buffers (a shared WebAssembly.Memory's) are
// shared all the same.
let crossOriginIsolated = false;
export const isCrossOriginIsolated = () => crossOriginIsolated;
// (…the browsing context group of this isolate's window, and the window, the host's to say: realm_location.rs
// `agent_cluster_key`)
globalThis.__csimSetBrowsingContextGroup = (group, window) => globalThis.__dom.setBrowsingContextGroup(String(group), String(window));
// (…and its session history, the host's: session_history.rs `HISTORIES`)
globalThis.__csimSetSessionHistory = (id) => globalThis.__dom.setSessionHistory(id);
export function setCrossOriginIsolated(isolated) {
  crossOriginIsolated = isolated === true;
  // (…and its agent cluster keyed by its origin, not its site: HTML "obtain a similar-origin window agent")
  globalThis.__dom.setOriginKeyedCluster(crossOriginIsolated);
  if (!crossOriginIsolated) delete globalThis.SharedArrayBuffer;
}

// StructuredSerializeWithTransfer `value`: the transfer list checked (a transferable listed twice, or detached, or an
// ArrayBuffer that cannot be detached, a DataCloneError), the value serialized, the list checked again, then every
// transferable moved — the value reached it or not — and only then the sources detached. Returns what
// `deserializeWithTransfer` reads back in the realm that receives it: the serialization (the isolate's, any realm of it
// may read it), the transfer list, and each transferable but an ArrayBuffer's moved counterpart. Its SharedArrayBuffers
// shared where `mayShare` (a cross-origin isolated agent cluster's, and within the isolate), else a DataCloneError; its
// WebAssembly.Modules as `modules` says (clone.rs `ModuleRule`): shared, or refused 'storage'
// (StructuredSerializeForStorage).
const NO_TRANSFER = Object.freeze([]);
export function serializeWithTransfer(value, transferList, mayShare = crossOriginIsolated, modules = 'share') {
  let transfer = null;
  if (transferList.length !== 0) {
    transfer = new Set(transferList);
    if (transfer.size !== transferList.length) throw dataCloneError('A transferable was listed more than once.');
    for (const t of transfer) validateTransferable(t);
  }
  const saved = currentClone;
  currentClone = { transfer, list: transferList, moved: null, pendingDetach: null, records: null };
  let serialized = -1;
  try {
    const buffers = transfer === null ? NO_TRANSFER : transferList.filter(isArrayBuffer);
    serialized = globalThis.__dom.structuredSerialize(value, serializePlatformObject, mayShare, buffers, modules);
    const moved = new Map();
    if (transfer !== null) {
      // (…every one usable still, so none of the moves below fails: a MessagePort is neutered as it moves — but for an
      // ArrayBuffer that cannot be detached, a WebAssembly.Memory's, which is DetachArrayBuffer's TypeError as the
      // transfer reaches it, in the list's order: those before it moved, those after it not)
      for (const t of transfer) validateTransferable(t);
      const stuck = transferList.findIndex((t) => isArrayBuffer(t) && !globalThis.__dom.isDetachable(t));
      const moving = stuck === -1 ? transferList : transferList.slice(0, stuck);
      currentClone.pendingDetach = [];
      for (const t of moving) if (!isArrayBuffer(t)) moved.set(t, transferValue(t));
      globalThis.__dom.structuredTransfer(serialized, moving.filter(isArrayBuffer).length);
      for (const detach of currentClone.pendingDetach) { try { detach(); } catch (_) {} }
      if (stuck !== -1) throw new TypeError('An ArrayBuffer that cannot be detached could not be transferred.');
    }
    const result = { serialized, list: transferList, moved };
    serialized = -1;
    return result;
  } finally {
    if (serialized !== -1) globalThis.__dom.structuredDiscard(serialized);
    currentClone = saved;
  }
}
// …and StructuredDeserializeWithTransfer it in this realm: the value, and the moved MessagePorts in the transfer list's
// order — a message event's `ports`.
export function deserializeWithTransfer({ serialized, list, moved }) {
  const saved = currentClone;
  currentClone = { transfer: null, list, moved, pendingDetach: null, records: null };
  try {
    for (const [t, m] of moved) if (Object.hasOwn(m, TRANSFERRED_STREAM)) moved.set(t, pipedStream(m[TRANSFERRED_STREAM]));
    const data = globalThis.__dom.structuredDeserialize(serialized, deserializePlatformObjects);
    const ports = [];
    for (const t of list) {
      const m = moved.get(t);
      if (m !== undefined && isMessagePort(m)) ports.push(m);
    }
    return { data, ports };
  } finally {
    currentClone = saved;
  }
}
// Both, in this realm — one isolate, so a moved value IS the received one.
// …or a serialization no realm will read (a message the target origin turns away).
const discardSerialization = ({ serialized }) => globalThis.__dom.structuredDiscard(serialized);
const cloneWithTransfer = (value, transferList) => deserializeWithTransfer(serializeWithTransfer(value, transferList));

// WindowOrWorkerGlobalScope's `structuredClone` (window.js, which converted `options`; a worker's scope).
export function structuredClone(v, options) {
  return cloneWithTransfer(v, options && options.transfer ? Array.from(options.transfer) : NO_TRANSFER).data;
}
globalThis.__csimStructuredClone = structuredClone;
// …as an operation the bindings expose clones: a DataCloneError in its words (`Failed to execute 'structuredClone' on
// 'Window': ` and then V8's or the bindings' message, Chrome's).
export const cloneFor = (prefix, value, options) => inWordsOf(prefix, () => structuredClone(value, options));
function inWordsOf(prefix, clone) {
  try {
    return clone();
  } catch (e) {
    if (e && e.name === 'DataCloneError') throw new DOMException(prefix + e.message, 'DataCloneError');
    throw e;
  }
}
// The ArrayBuffer of exactly the bytes `bytes` views, which `__dom.structuredImport` reads whole: its own, or a copy of
// the window it views on a larger one.
export const exactBuffer = (bytes) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
// StructuredSerializeForStorage `value` (HTML): a serialization kept past the realm that made it — a session history
// entry's classic history API state, a document's persisted form state — as the bytes the host keeps, which share no
// SharedArrayBuffer (a DataCloneError) and transfer nothing; a DataCloneError in `prefix`'s words. …and
// StructuredDeserialize of such bytes, in this realm.
export function serializeForStorage(value, prefix = '') {
  const { serialized } = inWordsOf(prefix, () => serializeWithTransfer(value, NO_TRANSFER, false, 'storage'));
  return new Uint8Array(globalThis.__dom.structuredExport(serialized)[0]);
}
// …and both in this realm, a value as storage would keep it (IndexedDB "clone a value"), a DataCloneError in `prefix`'s
// words.
export const cloneForStorage = (value, prefix = '') =>
  deserializeWithTransfer(inWordsOf(prefix, () => serializeWithTransfer(value, NO_TRANSFER, false, 'storage'))).data;
export function deserializeFromStorage(bytes) {
  const serialized = globalThis.__dom.structuredImport(exactBuffer(bytes), NO_TRANSFER);
  return deserializeWithTransfer({ serialized, list: NO_TRANSFER, moved: new Map() }).data;
}

// `reportError(error)` — HTML "report the exception": fire a cancelable `error`
// ErrorEvent on the global, then, only if no listener cancelled it, log to the
// console. This is also the channel a throwing event-loop callback surfaces
// through (e.g. queueMicrotask), so it must fire the `error` event — NOT the
// promise-rejection channel — to match real-browser behavior.
let __csimReportingError = false;
// (…`callback` the callback that threw it, where one did)
export function reportError(e, callback = null) {
  globalThis.__csimReportException(e, () => logError(e && e.stack ? e.stack : String(e)), null, callback);
}
globalThis.__csimReportError = reportError;
// …a script's own exception, `filename` where it was run: the location of an exception that carries none of its own — a
// SyntaxError its source threw as it compiled, a thrown value that is no Error — line 1, column 1 of it (Chrome, for a
// javascript: URL's).
globalThis.__csimReportScriptError = function (e, filename) {
  globalThis.__csimReportException(e, () => logError(e && e.stack ? e.stack : String(e)), { filename, lineno: 1, colno: 1 });
};
// …the same steps for the driver's own callers, which log in their own words (`log`, run only where no listener
// cancelled the event): a script the PARSER ran, whose exception reached no `window.onerror` at all before.
// An Error of ANY realm (the brand, not `instanceof`: a cross-realm callback's error is no instance of this realm's
// Error), or a DOMException of any realm (its slots: its class string is its own) — asked of nothing of the page's.
function isErrorObject(e) {
  return globalThis.__dom.isNativeError(e) || IS_DOM_EXCEPTION(e);
}
// …its text: an Error's "Name: message", anything else thrown its string — or, where reading it throws (a revoked
// proxy, a `name` getter that throws), as V8 says it.
function thrownString(e) {
  try { return isErrorObject(e) ? e.name + ': ' + e.message : String(e); } catch (_) { return globalThis.__dom.thrownText(e); }
}
// The driver's log of a thrown value, running nothing of the page's: the text its report made, and an Error's stack by
// the realm's own `stack` getter alone (one a page redefined, or another realm's, is not called).
const STACK_GETTER = Reflect.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
export function thrownDetail(e, ev) {
  const text = ev ? ev.message : globalThis.__dom.thrownText(e);
  if (!globalThis.__dom.isNativeError(e) || STACK_GETTER === undefined) return text;
  const own = Reflect.getOwnPropertyDescriptor(e, 'stack');
  const stack = own?.get === STACK_GETTER ? Reflect.apply(STACK_GETTER, e, []) : undefined;
  return typeof stack === 'string' ? stack : text;
}
globalThis.__csimReportException = function reportException(e, log, where = null, callback = null) {
  // Re-entrancy guard: an `error` handler (`window.onerror` / an `error`
  // listener) that itself throws is reported too — but firing ANOTHER `error`
  // event for it would recurse unboundedly. While already reporting, skip the
  // event and just log, matching browsers (error reporting is not re-entrant).
  if (__csimReportingError) {
    try { log(); } catch (_) {}
    return;
  }
  let cancelled = false, ev = null;
  __csimReportingError = true;
  try {
    // (…where it was thrown, and none of it for a classic script whose errors are muted — HTML "report an exception",
    // the engine's: script.rs `exceptionSite` — an inline script's or other code the page's document compiled at the
    // document's URL, as Chrome reports it)
    const [muted, ofDocument, url, lineno, colno] = globalThis.__dom.exceptionSite(e, isErrorObject(e), where?.filename ?? '', callback);
    const at = ofDocument === undefined ? where : { filename: ofDocument ? location.href : url, lineno, colno };
    ev = new ErrorEvent('error', muted ? MUTED_ERROR : {
      cancelable: true,
      // Duck-type, not `instanceof Error`: a cross-realm Error (reported on the
      // callback's realm via `__csimReportCallbackError`) isn't an instance of
      // THIS realm's Error, but still has a string `message` to surface.
      // …as "Name: message" for an Error or a DOMException: the spec leaves the text open, and it is what Chrome
      // ("Uncaught Error: x") and Firefox ("Error: x") share — bare "x" was neither's. Anything else thrown is its
      // string (Firefox's "[object Object]" half; a `{name, message}` object is no Error).
      message:    thrownString(e),
      error:      e,
      ...at
    });
    cancelled = !fireEvent(globalThis, ev);
  } catch (_) {} finally { __csimReportingError = false; }
  if (!cancelled) {
    // (…and, in a dedicated worker, reported on at its Worker: workers.js)
    if (ev && globalThis.__csimForwardUnhandledError) globalThis.__csimForwardUnhandledError(ev);
    try { log(ev); } catch (_) {}
  }
};
// …the ErrorEvent such an exception's report fires: "Script error.", no URL, line or column, and no error.
const MUTED_ERROR = Object.freeze({ cancelable: true, message: 'Script error.', filename: '', lineno: 0, colno: 0, error: null });

// "Report the exception" of an error the platform raises with no exception object — ResizeObserver's loop error: an
// ErrorEvent of `message` alone, its `error` null and its location the document at 0:0 (Chrome), then the console where
// no listener cancelled it.
globalThis.__csimReportLoopError = function (message) {
  if (__csimReportingError) return;
  let cancelled = false;
  __csimReportingError = true;
  try {
    const ev = new ErrorEvent('error', { cancelable: true, message, filename: location.href, lineno: 0, colno: 0, error: null });
    cancelled = !fireEvent(globalThis, ev);
  } catch (_) {} finally { __csimReportingError = false; }
  if (!cancelled) logError(message);
};

// The cross-realm global associated with `anchor` (its [[Realm]]), or null when
// same-realm / no realm info / no realm support. rusty_racer's
// `RustyRacer.contextOf(value)` maps ANY value (function or object) to its
// realm id; `contextGlobal(id)` is that realm's global.
//
// The callback paths below call it, where the OVERWHELMING majority of callbacks
// are same-realm (the event dispatch keeps its own copy of this, events.js
// `invokeEntries`, which records the id as well). `__csimSelfRealmId` memoizes THIS realm's own id (constant per realm) so the
// same-realm case is a single `contextOf` + integer compare — it never pays the
// second `contextGlobal` native crossing (rule 3).
let __csimSelfRealmId;
function __csimRealmGlobalOf(anchor) {
  try {
    const NS = globalThis.RustyRacer;
    if (anchor) {
      if (__csimSelfRealmId === undefined) __csimSelfRealmId = globalThis.__csimRealmId();
      const id = NS.contextOf(anchor);
      if (id != null && id !== __csimSelfRealmId) {
        const g = NS.contextGlobal(id);
        if (g && g !== globalThis) return g;
      }
    }
  } catch (_) {}
  return null;
}

// ── WindowProxy (cross-realm window references) ──
// A reference from THIS realm (the observer) to ANOTHER same-page realm's window
// is a Proxy over that realm's raw global. It exists so cross-realm postMessage
// sets `event.source` correctly: the proxy bakes in the OBSERVER realm (= the
// holder = the sender when it calls `proxy.postMessage`), captured here at
// creation time — immune to caching / async continuations (unlike an "incumbent"
// slot, which can't recover a cached-ref sender). Transparent for everything else
// (reads/writes/getters/constructors forward to the raw global). Cached per
// target realm so identity holds: `iframe.contentWindow` === a later `e.source`
// from that frame === `parent` seen from inside it.
const __winProxyByTarget = new Map();   // targetRealmId -> this realm's proxy for it
const __winProxyRaw      = new WeakMap();   // proxy -> raw target global (for unwrap)
const __winProxyRetarget = new WeakMap();   // proxy -> its retargeting: (realmId, rawGlobal) => void
// EventTarget methods (events.js) call this so add/removeEventListener/dispatch
// operate on the REAL window (listeners must live where events actually fire).
globalThis.__csimUnwrapWindow = function (o) {
  if (o && typeof o === 'object') { const raw = __winProxyRaw.get(o); if (raw) return raw; }
  return o;
};
function __csimSelfId() {
  if (__csimSelfRealmId === undefined) {
    try { __csimSelfRealmId = globalThis.__csimRealmId(); } catch (_) {}
  }
  return __csimSelfRealmId;
}
// What a cross-origin Window and Location expose (HTML CrossOriginProperties, generated from the table in
// script/gen_bindings.mjs, its names checked against the IDL): what a WindowProxy of another origin's window answers
// to — of this isolate's (`frameWindowProxyFor`) and of another's (`csimWindowProxy`) — and the members of another
// realm's window that may be called on it (window.js). Reading anything else (most notably `document`) throws a
// SecurityError; these stay reachable so postMessage / frame-navigation / opener handshakes keep working across origins.
function crossOriginSecurityError() {
  return new DOMException("Blocked a frame from accessing a cross-origin frame.", 'SecurityError');
}
// The driver's own keys that its scripts reach on another window through a WindowProxy of it, whatever its origin:
// testdriver's (spec/wpt/resources/testdriver-vendor.js — a user's gesture at an element of that window) and the
// realm plumbing the driver reaches a frame's ancestors by (`__csimParent` / `__csimTop`, which hold their WindowProxies):
// the walk up them, the realm whose listener runs (events.js `invokeEntries`), a frame's name registered with its
// parent (window.js `set_name`), the page's source maps (bridge.entry.js `noteSourceMap`), a frame's blob snapshot
// (location.js). No other — measured, the whole suite and the WPT gate — any other `__csim*` member of a window is its
// own, gated as its page's members are: a cross-origin window's `__csimDocumentHtml()` would hand over its document.
// A bounded gap remains, on this isolate's WindowProxy (`frameWindowProxyFor`): `__csimRawWindow` hands over the raw
// global behind it (`frames[0].__csimRawWindow.secret`), and a function-valued key here is that realm's function, whose
// constructor runs code there (`frames[0].__csimRegisterNavigableName.constructor('return window.secret')()`). Only a
// script naming the driver's own keys reaches either — the driver's surface (`__dom`) is a page's to reach anyway —
// and closing it means moving the ~10 sites that unwrap through `__csimRawWindow` (events.js, location.js,
// style-proxy.js, bridge.entry.js, `seenHere` here) to a native or WeakMap unwrap.
const DRIVER_WINDOW_KEYS = new Set([
  '__csimActivationNotify', '__csimRegisterNode', '__csimSendKeys', '__csimClickResolve', '__csimParent', '__csimTop',
  '__csimRegisterNavigableName', '__csimSourceMaps', '__csimSnapshotFrameNavBlob'
]);
const isInternalKey = (prop) => DRIVER_WINDOW_KEYS.has(prop);
// Which keys a cross-origin WindowProxy still exposes to `[[Get]]` / `[[Has]]` /
// `[[OwnPropertyKeys]]`: the CrossOriginProperties, indexed-frame keys, the fallback keys
// (@@toStringTag etc.), and the driver's keys above. Everything else is hidden.
function crossOriginWindowAccessible(prop) {
  if (typeof prop === 'symbol') return CROSS_ORIGIN_FALLBACK_SYMBOLS.has(prop);
  if (typeof prop !== 'string') return false;
  return isInternalKey(prop) || prop === 'then' || CROSS_ORIGIN_WINDOW_PROPERTIES.has(prop);
}
// HTML's CrossOriginPropertyFallback: what a cross-origin object answers `undefined` for, where any other key is a
// SecurityError — so a promise resolving to a cross-origin window resolves (`then`), and @@toStringTag and friends ask
// nothing of the other origin.
const CROSS_ORIGIN_FALLBACK_SYMBOLS = new Set([Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable]);
const isCrossOriginFallback = (prop) => prop === 'then' || CROSS_ORIGIN_FALLBACK_SYMBOLS.has(prop);
// HTML's CrossOriginGetOwnPropertyHelper: the descriptor of a cross-origin property of kind `kind` (the generated
// table's) — unenumerable and configurable, an operation's its function `value`, an attribute's the accessors its kind
// exposes of `get` and `set` — each of them this realm's, made once per object, never the target's own.
function crossOriginDescriptor(kind, value, get, set) {
  if (kind === 'method') return { value, writable: false, enumerable: false, configurable: true };
  return { get: kind === 'set' ? undefined : get, set: kind === 'get' ? undefined : set, enumerable: false, configurable: true };
}
// …a WindowProxy's (`proxyOf()`), its methods `methods`: a getter reads the property off the window it is called on (or
// this proxy, called on none), a setter — `location`'s alone — sets it on this proxy.
function crossOriginWindowDescriptors(proxyOf, methods) {
  const accessors = new Map();
  return (prop) => {
    const kind = CROSS_ORIGIN_WINDOW_KINDS[prop];
    if (kind === 'method') return crossOriginDescriptor(kind, methods[prop]);
    let pair = accessors.get(prop);
    if (!pair) {
      pair = {
        get: Object.getOwnPropertyDescriptor({ get [prop]() { return (this == null ? proxyOf() : this)[prop]; } }, prop).get,
        set: Object.getOwnPropertyDescriptor({ set [prop](v) { proxyOf()[prop] = v; } }, prop).set
      };
      accessors.set(prop, pair);
    }
    return crossOriginDescriptor(kind, undefined, pair.get, pair.set);
  };
}
// …and a WindowProxy's indexed keys: array indices, which name its child navigables (HTML §7.2.3.3).
const isArrayIndex = (prop) => typeof prop === 'string' && /^(0|[1-9][0-9]*)$/.test(prop) && Number(prop) < 4294967295;
// A cross-origin `Location` exposes ONLY the `href` SETTER and `replace()` (HTML
// CrossOriginProperties for Location); every other member — the `href` getter,
// `assign`, `protocol`, `reload`, … — throws SecurityError. `location` itself IS a
// cross-origin-readable Window property, so `frame.location` returns this wrapper rather
// than throwing; the wrapper then guards the members. Proxied over a shadow object, not the
// raw Location — whose members are its own unforgeable (non-configurable) properties, which a
// Proxy over it could neither hide nor answer with a function of its own — the descriptors it
// reports configurable, as HTML's cross-origin [[GetOwnProperty]] has them. Cached per raw
// Location so identity is stable across reads.
const __crossLocByRaw = new WeakMap();
// A Location-object navigation of window `raw` this realm's script makes — this realm its incumbent and entry, HTML's: the
// URL resolved here, against its document, and its document the navigation's initiator, whose transient activation and
// referrer the navigation's are; where its sandboxing does not allow it to navigate the window, a SecurityError (HTML
// "navigate" with exceptions enabled, as a Location's navigation is: Chrome). A javascript: URL of another origin's
// navigates nowhere — HTML's navigate returns early for an initiator not same origin-domain with the document. What it
// throws — its value's conversion's TypeError too — is of the realm `errors` names: the window's own for its Location's
// setter, this one's for a cross-origin Location's, whose functions are this realm's (HTML
// CrossOriginGetOwnPropertyHelper).
// (…only where this realm's script reaches the Location through the window's WindowProxy: a Location member another
// realm's script calls directly runs as the window's own, its caller — the incumbent — not known to a JS function. The
// open gap: a member made a native function would have V8's incumbent context the caller's.)
function navigateLocationFrom(raw, value, words, replace, errors) {
  const input = toUSVString(value, `Failed to ${words} on 'Location': `, errors);
  const parsed = parseDocumentURL(globalThis.document, input);
  if (parsed === null) {
    throw new errors.DOMException(`Failed to ${words} on 'Location': '${input}' is not a valid URL.`, 'SyntaxError');
  }
  const target = globalThis.RustyRacer.contextOf(raw);
  // (…none where this document may not navigate it, a javascript: URL none across origins: navigables.rs
  // `navigationVerdict`)
  const verdict = globalThis.__dom.navigationVerdict(globalThis.__csimRealmId(), target, parsed, true);
  if (verdict === 'refused') {
    throw new errors.DOMException(`Failed to ${words} on 'Location': The current window does not have permission to navigate the target frame to '${parsed}'.`, 'SecurityError');
  }
  if (verdict === 'navigate') raw.__csimLocationNavigateFrom(parsed, replace, globalThis.__csimRealmId());
}
function crossOriginLocation(rawLoc, raw) {
  let w = __crossLocByRaw.get(rawLoc);
  if (w) return w;
  // (…a symbol, @@toStringTag and the like, and the driver's own keys the Location's)
  w = crossOriginLocationOf((value, words, replace) => navigateLocationFrom(raw, value, words, replace, globalThis),
    (prop) => Reflect.get(rawLoc, prop, rawLoc));
  __crossLocByRaw.set(rawLoc, w);
  return w;
}
// …a cross-origin Location whose navigations `navigate(value, words, replace)` makes — its `href` setter's and
// `replace()`'s, the members of its CrossOriginProperties — and what it answers for a symbol or a driver key `inner`'s.
// The steps of each member of the table, by name: an operation's function, an attribute's setter (none has a getter) —
// the table's members those it has steps for, which a member added to it without them is an error of, at load.
const CROSS_ORIGIN_LOCATION_STEPS = ['href', 'replace'];
if ([...CROSS_ORIGIN_LOCATION_PROPERTIES].join() !== CROSS_ORIGIN_LOCATION_STEPS.join()) {
  throw new Error(`Location's CrossOriginProperties are ${[...CROSS_ORIGIN_LOCATION_PROPERTIES]}, its steps ${CROSS_ORIGIN_LOCATION_STEPS}`);
}
function crossOriginLocationOf(navigate, inner) {
  // (…each function its name its member's, `replace` and `set href`: HTML's CrossOriginGetOwnPropertyHelper)
  const steps = {
    href:    Object.getOwnPropertyDescriptor({ set href(value) { navigate(value, "set the 'href' property", false); } }, 'href'),
    replace: {
      value: function replace(url) {
        required(arguments, 1, 'replace', 'Location');
        navigate(url, "execute 'replace'", true);
      }
    }
  };
  const kindOf = (prop) => (typeof prop === 'string' ? CROSS_ORIGIN_LOCATION_KINDS[prop] : undefined);
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (typeof prop === 'symbol' || isInternalKey(prop)) return inner(prop);
      const kind = kindOf(prop);
      if (kind === 'method') return steps[prop].value;
      if (kind === 'get' || kind === 'get set') return steps[prop].get();
      if (isCrossOriginFallback(prop)) return undefined;
      throw crossOriginSecurityError();                                     // href GETTER + everything else
    },
    set(_t, prop, val) {
      const kind = kindOf(prop);
      if (kind === 'set' || kind === 'get set') { steps[prop].set(val); return true; }
      throw crossOriginSecurityError();
    },
    // (…HTML's [[HasProperty]] by its [[GetOwnProperty]]: a CrossOriginProperty or a fallback key present, anything else
    // a SecurityError — `'pathname' in location` throws, as Chrome and Firefox do)
    has(_t, prop) {
      if (CROSS_ORIGIN_LOCATION_PROPERTIES.has(prop) || isCrossOriginFallback(prop) || isInternalKey(prop)) return true;
      throw crossOriginSecurityError();
    },
    ownKeys()      { return [...CROSS_ORIGIN_LOCATION_PROPERTIES]; },
    getOwnPropertyDescriptor(_t, prop) {
      const kind = kindOf(prop);
      if (kind) return crossOriginDescriptor(kind, steps[prop].value, steps[prop].get, steps[prop].set);
      if (isCrossOriginFallback(prop)) return { value: undefined, writable: false, enumerable: false, configurable: true };
      throw crossOriginSecurityError();
    },
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; }
  });
}
// The realm whose window global `o` is — a raw window, not a WindowProxy (a JS Proxy is its creator's, the observer's) —
// or null for anything else, a realm reset away included…
function globalRealmOf(o) {
  if (!o || typeof o !== 'object') return null;
  if (o === globalThis) return __csimSelfId();
  const NS = globalThis.RustyRacer;
  try {
    const id = NS.contextOf(o);
    return id != null && NS.contextGlobal(id) === o ? id : null;
  } catch (_) { return null; }
}
// …and the realm a window's document is of: its global's, or — a frame past the nesting limit, which no realm is built
// for (bridge.entry.js `makeFrameWindow`: a window over its parent realm's global, branded `OWN_FRAME_WINDOW` in every
// realm's sight) — the realm that made it.
export const OWN_FRAME_WINDOW = Symbol.for('csim.ownFrameWindow');
function realmOfWindow(o) {
  const realm = globalRealmOf(o);
  if (realm !== null || !o || typeof o !== 'object') return realm;
  try { return o[OWN_FRAME_WINDOW] === true ? globalThis.RustyRacer.contextOf(o) ?? null : null; } catch (_) { return null; }
}
globalThis.__csimRealmOfWindow = realmOfWindow;
// Same-origin iff the realm of the raw window `rawWindow` has THIS realm's document origin — by their keys, the
// engine's (realm_location.rs `sameOriginRealm`), as contentDocument's SOP: an opaque origin same with the windows that
// share it alone (a child that inherited it), never with another opaque one. Fail CLOSED (cross-origin) for what is no
// raw window, and for a realm dropped.
function isSameOriginAs(rawWindow) {
  const realm = realmOfWindow(rawWindow);
  return realm != null && globalThis.__dom.sameOriginRealm(realm);
}
globalThis.__csimIsSameOriginWindow = isSameOriginAs;

function frameWindowProxyFor(targetRealmId) {
  if (targetRealmId == null) return null;
  let raw;
  try { raw = globalThis.RustyRacer.contextGlobal(targetRealmId); } catch (_) { return null; }
  if (!raw) return null;
  // Same realm → the real global (`window === self === globalThis`, never a proxy).
  const selfId = __csimSelfId();
  if (raw === globalThis || targetRealmId === selfId) return globalThis;
  let p = __winProxyByTarget.get(targetRealmId);
  if (p) return p;
  const observerId = selfId;
  let targetId = targetRealmId;
  // (…`postMessage`, its length and name the IDL operation's)
  const pmsg = Object.defineProperties(function (message, targetOriginOrOptions, transfer) {
    // A bad targetOrigin is a SyntaxError thrown SYNCHRONOUSLY before the cross-realm hand-off, minted in the method's
    // realm — the target window's (`raw`) for a same-origin one, its own; this realm's for a cross-origin one, whose
    // functions are this realm's (HTML CrossOriginGetOwnPropertyHelper). Accept both the WindowPostMessageOptions
    // dictionary and the legacy (targetOrigin, transfer) form.
    live();
    validatePostMessageTargetOrigin(targetOriginOrOptions, sameOrigin() ? raw : globalThis);
    const to   = postMessageTargetOriginOf(targetOriginOrOptions);
    const xfer = isPostMessageOptions(targetOriginOrOptions) && targetOriginOrOptions != null
      ? targetOriginOrOptions.transfer : transfer;
    return globalThis.__csimPostMessageRealm(observerId, targetId, message, to, xfer);
  }, { length: { value: 1 }, name: { value: 'postMessage' } });
  // Same-origin-ness of this proxy (over a fixed target `raw`) can only change when the OBSERVER
  // realm's origin changes — and a freshly built child realm is created with an INHERITED
  // (about:blank) origin, then `__csimUpdateLocation` sets its real one AFTER its parent/top proxies
  // exist. A plain "memoize true" cache captured that transient inherited origin: a cross-origin
  // child whose parent proxy was touched pre-navigation (parent === child origin then) memoized
  // same-origin=true and never re-evaluated, leaving `parent.document` readable for the frame's life
  // (a cross-origin SOP hole). Key the cache on the observer's CURRENT origin instead: the hot
  // stable-origin path still returns the cached result (rule 3), but the first read after the origin
  // is finalized recomputes. The target's origin changes only where its window goes on to another
  // document, which retargets the proxy (`__csimRetargetWindowProxy`) and resets the memo with it.
  let memoOrigin = null, memoResult = false;
  // (…frozen once its window is gone — its realm disposed, its arena dropped (`gone`): what it last was, the global it
  // pins answering the same-origin reads as a discarded window's do)
  let gone = false;
  const sameOrigin = () => {
    if (gone) return memoResult;
    const cur = documentOrigin();
    if (memoOrigin !== cur) { memoResult = globalThis.__dom.sameOriginRealm(targetId); memoOrigin = cur; }
    return memoResult;
  };
  // The proxy's target is no window but an object of its own, as HTML's WindowProxy is no JS Proxy of one: a window's
  // [LegacyUnforgeable] members are non-configurable, which a Proxy of it could neither hide cross-origin (`'document'
  // in frame` false) nor report configurable, as a WindowProxy does ([[GetOwnProperty]]) — the target holds only what
  // was defined non-configurable through the proxy, which its invariants then ask of it.
  // Observer-relative IDENTITY for a window the target names (`parent`, `top`, `opener`, a child frame): that window as
  // THIS realm sees it — its own window `globalThis` itself (`frames[0].parent === window`, a cross-origin child's
  // `parent` read from its actual parent, event.source / opener reply patterns), another realm's window this realm's
  // WindowProxy of it — where the target's resolution is the TARGET realm's object, no object of this realm's. (Each is
  // one of the CrossOriginProperties, so this bypasses nothing the SOP gate below would have blocked.) A window no realm
  // is found for — a frame past the nesting limit — is the object the target has for it, no realm's global (which always
  // has its realm); a window of another isolate — an opener in another Browser — THIS realm's WindowProxy of it, whose
  // origin check is this realm's document's, not the target's.
  const seenHere = (inner) => {
    const innerRaw = (inner && inner.__csimRawWindow) || inner;
    if (innerRaw === globalThis) return globalThis;
    if (innerRaw == null) return inner;
    // (…a frame past the nesting limit a window over its parent realm's global — its realm's, as that one's is)
    const realm = realmOfWindow(innerRaw);
    if (realm !== null) return frameWindowProxyFor(realm) || inner;
    const handle = typeof inner === 'object' ? inner.__csimWindowHandle : undefined;
    return typeof handle === 'string' ? windowSeenHere(handle) : inner;
  };
  // The window the target names — cross-origin as its IDL getter has it, not a property its page set in its place
  // (`opener` is replaceable): `windowSteps` (window.js), its realm's own.
  const named = (prop) => {
    let inner;
    try { inner = sameOrigin() ? Reflect.get(raw, prop, raw) : raw.__csimWindowSteps[`get_${prop}`](raw); } catch (_) {}
    return seenHere(inner);
  };
  // …and its child frames by index, through the target's `frames` (the global itself is not indexable): undefined for
  // an index naming none.
  const childFrame = (prop) => {
    let inner;
    try { inner = Reflect.get(raw, 'frames', raw)[prop]; } catch (_) {}
    return seenHere(inner);
  };
  // HTML's cross-origin functions (CrossOriginGetOwnPropertyHelper): made in this realm, cached per proxy, none
  // constructible — `close`, `focus` and `blur` the target window's own steps (`windowSteps`), not what its page put in
  // their place; `postMessage`; each property's getter, of the window it is called on; `location`'s setter, which
  // navigates as a cross-origin Location's `href` does.
  const crossMethod = (name) => Object.defineProperty(() => { raw.__csimWindowSteps[name](raw); }, 'name', { value: name });
  const crossMethods = { postMessage: pmsg, close: crossMethod('close'), focus: crossMethod('focus'), blur: crossMethod('blur') };
  const crossDescriptor = crossOriginWindowDescriptors(() => p, crossMethods);
  const crossLocation = () => {
    const loc = Reflect.get(raw, 'location', raw);
    return loc ? crossOriginLocation(loc, raw) : loc;
  };
  // The window used is the navigable's active document's: one between two documents, no build coming for the next (a
  // frame built when it is next touched), has it made now, as its container's `contentWindow` read would — its
  // container's document's realm's to make, which retargets this proxy over it (`__csimRetargetWindowProxy`).
  const live = () => {
    if (globalThis.__dom.parkedNavigables[0] === 0) return;
    const parent = globalThis.__dom.parkedNavigableRealm(targetId);
    if (parent < 0) return;
    try { globalThis.RustyRacer.contextGlobal(parent).__csimMakeParkedFrame(targetId); } catch (_) {}
  };
  // A property defined non-configurable through the proxy is held by its target, whose invariants then ask for it — the
  // window's own while the window is the one it was defined on. Over the next window, which HTML's WindowProxy reports
  // without it (a willful violation of the invariants, tc39/ecma262#672, which no JS Proxy can commit), it is the
  // target's still: those of a window gone (`stale`), answered from the target as they were defined — a bounded gap,
  // where a trap of the proxy would otherwise throw on every use of it.
  let stale = null;
  const shadow = {};
  p = new Proxy(shadow, {
    get(t, prop) {
      if (prop === '__csimRawWindow') { live(); return raw; }   // unwrap hook (also used cross-realm)
      live();
      if (stale !== null && stale.has(prop)) return Reflect.get(t, prop, p);
      if (prop === 'postMessage') return pmsg;
      if (prop === 'window' || prop === 'self') return p;
      // (…a window whose browsing context is gone: `closed`, and none of the windows it had — HTML's getters, its own
      // window no more to ask)
      if (gone && prop === 'closed') return true;
      if (gone && (prop === 'parent' || prop === 'top' || prop === 'opener')) return null;
      if (prop === 'parent' || prop === 'top' || prop === 'opener') return named(prop);
      const same = sameOrigin();
      if (isArrayIndex(prop)) {
        const child = childFrame(prop);
        if (child === undefined && !same) throw crossOriginSecurityError();
        return child;
      }
      // (…`frames` the WindowProxy itself, as its getter has it — not the target realm's own indexable stand-in for its
      // global, whose frames would be that realm's objects, `w.frames[0] !== w[0]` — but a value its page put in its
      // place, a [Replaceable] attribute's, same origin)
      if (prop === 'frames') {
        const own = same ? Object.getOwnPropertyDescriptor(raw, 'frames') : undefined;
        return own && 'value' in own ? own.value : p;
      }
      if (same) return Reflect.get(raw, prop, raw);   // getters/methods resolve against the real window
      // SOP, HTML's CrossOriginGet: a cross-origin WindowProxy answers the CrossOriginProperties alone — `frames` the
      // WindowProxy itself, its methods and `location` this realm's objects, none the target realm's own, whose
      // properties no gate would then guard — `then` and the fallback symbols with undefined, anything else (most
      // notably `document`) a SecurityError. (Internal driver bookkeeping, `__csim*`, is the driver's to read.)
      if (prop === 'close' || prop === 'focus' || prop === 'blur') return crossMethods[prop];
      if (prop === 'location') return crossLocation();
      if (isCrossOriginFallback(prop)) return undefined;
      if (typeof prop === 'symbol' || !(isInternalKey(prop) || CROSS_ORIGIN_WINDOW_PROPERTIES.has(prop))) throw crossOriginSecurityError();
      return Reflect.get(raw, prop, raw);
    },
    // (…a setter that throws throws to the assigner: `frame.contentWindow.location = 'http://foo:-80/'` is a SyntaxError
    // in the frame's realm, as `location.href = …` is). Cross-origin only `location` is settable (HTML CrossOriginSet),
    // as a cross-origin Location's `href` is — resolved against the caller's document, a javascript: URL navigating
    // nowhere; anything else is a SecurityError, as deleting anything is ([[Delete]]).
    set(t, prop, val) {
      live();
      if (stale !== null && stale.has(prop)) return Reflect.set(t, prop, val);
      // (…`location`, [PutForwards=href]: its Location's `href` set by this realm's script, its incumbent — not the
      // window's, as Reflect.set would have it: `navigateLocationFrom`)
      if (prop === 'location' && sameOrigin()) { navigateLocationFrom(raw, val, "set the 'href' property", false, raw); return true; }
      if (sameOrigin() || isInternalKey(prop)) return Reflect.set(raw, prop, val, raw);
      if (prop !== 'location') throw crossOriginSecurityError();
      const loc = crossLocation();
      if (loc) loc.href = val;
      return true;
    },
    // `[[Has]]` / `[[OwnPropertyKeys]]` / `[[GetOwnProperty]]` are SOP-gated cross-origin so the
    // same-origin surface (`'document' in frame`, `Object.keys(frame)`, a descriptor probe) doesn't
    // leak: `in` reports absent (false); a direct descriptor probe throws SecurityError, matching
    // browsers. A descriptor reported is configurable, as a WindowProxy's is, but for what the
    // target holds.
    has(_t, prop) {
      live();
      if (stale !== null && stale.has(prop)) return true;
      if (sameOrigin()) return Reflect.has(raw, prop);
      // (…cross-origin, HTML's [[HasProperty]] by its [[GetOwnProperty]]: a child frame's index, a CrossOriginProperty or a
      // fallback key present, anything else a SecurityError — `'document' in frame` throws, as Chrome and Firefox do)
      if (isArrayIndex(prop) && childFrame(prop) !== undefined) return true;
      if (isInternalKey(prop)) return Reflect.has(raw, prop);
      if (crossOriginWindowAccessible(prop)) return true;
      throw crossOriginSecurityError();
    },
    deleteProperty(_t, prop) {
      live();
      if (stale !== null && stale.has(prop)) return false;
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      return Reflect.deleteProperty(raw, prop);
    },
    // (…and [[DefineOwnProperty]] likewise, HTML's WindowProxy: a cross-origin one defines nothing)
    defineProperty(t, prop, desc) {
      live();
      if (stale !== null && stale.has(prop)) return Reflect.defineProperty(t, prop, desc);
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      const defined = Reflect.defineProperty(raw, prop, desc);
      if (defined && desc.configurable === false) Reflect.defineProperty(t, prop, desc);
      return defined;
    },
    // (…cross-origin, HTML's CrossOriginGetOwnPropertyHelper and WindowProxy [[GetOwnProperty]]: a child frame by index
    // its WindowProxy, enumerable; the rest unenumerable and configurable, its value or accessors this realm's
    // cross-origin functions — the target's own never; the fallback keys undefined values)
    getOwnPropertyDescriptor(t, prop) {
      live();
      if (stale !== null && stale.has(prop)) return Reflect.getOwnPropertyDescriptor(t, prop);
      const same = sameOrigin();
      if (isArrayIndex(prop)) {
        const child = childFrame(prop);
        if (child === undefined) {
          if (!same) throw crossOriginSecurityError();
          return undefined;
        }
        return { value: child, writable: false, enumerable: true, configurable: true };
      }
      if (!same && !Reflect.getOwnPropertyDescriptor(t, prop)) {
        if (isCrossOriginFallback(prop)) return { value: undefined, writable: false, enumerable: false, configurable: true };
        if (typeof prop === 'symbol' || !(isInternalKey(prop) || CROSS_ORIGIN_WINDOW_PROPERTIES.has(prop))) throw crossOriginSecurityError();
        if (!isInternalKey(prop)) return crossDescriptor(prop);
      }
      const d = Reflect.getOwnPropertyDescriptor(raw, prop);
      if (d && !d.configurable && !Reflect.getOwnPropertyDescriptor(t, prop)) d.configurable = true;
      return d;
    },
    // (…cross-origin, HTML's CrossOriginOwnPropertyKeys: its child frames' indices, the CrossOriginProperties' names and
    // the fallback keys — none of the driver's own)
    ownKeys(t) {
      live();
      const indices = [];
      for (let i = 0; childFrame(String(i)) !== undefined; i++) indices.push(String(i));
      if (sameOrigin()) return [...new Set([...indices, ...Reflect.ownKeys(raw), ...(stale ?? [])])];
      return [...new Set([
        ...indices, ...CROSS_ORIGIN_WINDOW_PROPERTIES, 'then', ...CROSS_ORIGIN_FALLBACK_SYMBOLS, ...Reflect.ownKeys(t)
      ])];
    },
    getPrototypeOf()                  { live(); return sameOrigin() ? Reflect.getPrototypeOf(raw) : null; },
    setPrototypeOf()                  { return false; },
    preventExtensions()               { return false; }
  });
  __winProxyByTarget.set(targetId, p);
  __winProxyRaw.set(p, raw);
  // (…or, `id` null, its window gone: `gone`)
  __winProxyRetarget.set(p, (id, global) => {
    if (id === null) {
      sameOrigin();
      gone = true;
      return;
    }
    targetId = id; raw = global; memoOrigin = null;
    const held = Reflect.ownKeys(shadow);
    if (held.length) stale = new Set(held);
  });
  return p;
}
globalThis.__csimFrameWindowProxyFor = frameWindowProxyFor;
// Drop a disposed realm's cached WindowProxy (and unpin its raw global) so it doesn't linger after its window is gone —
// in every realm, as the host disposes the realm (`dispose_frame_realm`), or destroys a navigable between two documents.
// Cheap; no-op if not cached here.
// (…the proxy a script still holds answering as a WindowProxy of a browsing context gone: `gone` above)
globalThis.__csimEvictWindowProxy = function (targetRealmId) {
  const p = __winProxyByTarget.get(targetRealmId);
  if (!p) return;
  __winProxyRetarget.get(p)(null, null);
  __winProxyByTarget.delete(targetRealmId);
  __winProxyRaw.delete(p);
};
// …and THIS realm's proxy for a window whose navigable went on to another document — realm `oldId`'s, now realm
// `newId`'s — the same object over the new one (HTML: a browsing context's WindowProxy is one however its active
// document changes): `window.open()`'s `w` the window its navigation made, `e.source` of a message from that one `w`.
globalThis.__csimRetargetWindowProxy = function (oldId, newId) {
  const p = __winProxyByTarget.get(oldId);
  if (!p) return;
  let global;
  try { global = globalThis.RustyRacer.contextGlobal(newId); } catch (_) { return; }
  if (!global) return;
  __winProxyByTarget.delete(oldId);
  __winProxyByTarget.set(newId, p);
  __winProxyRaw.set(p, global);
  __winProxyRetarget.get(p)(newId, global);
};
// …and both in each of realms `realms` — the host's list of every live one, any of which may hold a proxy of the window
// — in one crossing however many there are.
const inRealms = (realms, name, ...args) => {
  const NS = globalThis.RustyRacer, own = globalThis.__csimRealmId();
  for (const id of realms) {
    try { (id === own ? globalThis : NS.contextGlobal(id))?.[name](...args); } catch (_) {}
  }
};
globalThis.__csimEvictWindowProxies    = (realms, id) => inRealms(realms, '__csimEvictWindowProxy', id);
globalThis.__csimRetargetWindowProxies = (realms, from, to) => inRealms(realms, '__csimRetargetWindowProxy', from, to);
// …and those of the navigables destroyed between two documents since last asked (navigables.rs `lost`).
globalThis.__csimEvictLostWindowProxies = (realms) => {
  for (const id of globalThis.__dom.takeLostNavigables()) inRealms(realms, '__csimEvictWindowProxy', id);
};
// True iff this is a multi-realm page (owns child realms, or is itself a frame) —
// the only case where cross-realm WindowProxy retargeting can apply. Lets the hot
// single-realm dispatch / composedPath paths short-circuit (rule 3). Property
// reads only (no native crossing).
globalThis.__csimMultiRealm = function () {
  return (globalThis.__dom !== undefined && globalThis.__dom.childFrames[0] !== 0) ||
         !!(globalThis.__csimTop && globalThis.__csimTop !== globalThis);
};
// True if `o` is a realm's global object (a Window) — used by event dispatch to
// retarget a window event-target to the observing listener's own WindowProxy.
globalThis.__csimGlobalRealmOf = globalRealmOf;
globalThis.__csimIsWindowGlobal = (o) => globalRealmOf(o) !== null;
// Whether a service worker may control a navigation of this realm's own navigable — the engine's (navigables.rs
// `sw_may_control_navigation`: a secure context by its top-level creation URL, no origin a sandbox makes opaque) —
// which the host asks of a frame's reload, traversal and self-navigation.
globalThis.__csimSwMayControlNavigation = () => globalThis.__dom.swMayControlNavigation(null);
globalThis.__csimRealmGlobalById = function (id) {
  if (id == null) return null;
  try { return globalThis.RustyRacer.contextGlobal(id) || null; } catch (_) { return null; }
};
// Iterate this realm's direct child realms' globals, calling `cb(childGlobal)`. If a
// call returns a value !== undefined, iteration stops and returns it (a "first hit"
// search); otherwise returns undefined after visiting all. Keeps the child-realm
// fan-out guard (set presence + contextGlobal availability) in ONE place for the
// blob-store / worker-delivery searches. (timers.js drainChildRealms keeps its own
// hot-path loop — it gates per child and folds results differently.)
globalThis.__csimEachChildRealm = function (cb) {
  if (globalThis.__dom.childFrames[0] === 0) return undefined;
  for (const id of globalThis.__dom.steppedRealms()) {
    const g = globalThis.__csimRealmGlobalById(id);
    if (!g) continue;
    let r;
    try { r = cb(g); } catch (_) { r = undefined; }
    if (r !== undefined) return r;
  }
  return undefined;
};
// The entry realm — the realm of the event listener currently running, which the dispatch paths enter (events.js
// `invokeEntries`), or of the script the host runs — so `composedPath()` (which runs in the EVENT's realm) can present
// the window entry as that realm's WindowProxy: the engine's, the isolate's one (navigables.rs `entryRealm`), undefined
// for none.
globalThis.__csimGetActiveListenerRealm = function () {
  const realm = globalThis.__dom.entryRealm();
  return realm < 0 ? undefined : realm;
};
// Map a window global to the active-listener realm's WindowProxy (for
// composedPath / any post-dispatch window-in-path read). No-op same-realm.
globalThis.__csimRetargetWindow = function (win) {
  if (!win) return win;
  const obsId = globalThis.__csimGetActiveListenerRealm();
  if (obsId == null) return win;
  let winId; try { winId = globalThis.RustyRacer.contextOf(win); } catch (_) { return win; }
  if (obsId === winId) return win;
  const obs = globalThis.__csimRealmGlobalById(obsId);
  if (obs && typeof obs.__csimFrameWindowProxyFor === 'function') {
    try { return obs.__csimFrameWindowProxyFor(winId) || win; } catch (_) {}
  }
  return win;
};
// A realm's document's origin, and its origin's key — the engine's, whichever realm's (realm_location.rs `realmOrigin`,
// `realmOriginKey`): '' for a realm dropped.
const realmOrigin = (realmId) => (realmId == null ? '' : globalThis.__dom.realmOrigin(realmId));
const realmOriginKey = (realmId) => (realmId == null ? '' : globalThis.__dom.realmOriginKey(realmId));
// Deliver a cross-realm same-page postMessage. Called (in the SENDER realm) by a
// WindowProxy's postMessage; routes into the TARGET realm so the payload is cloned
// there and the message task queued there with `event.source` = the target's own
// proxy for the sender.
globalThis.__csimPostMessageRealm = function (senderId, targetId, message, targetOrigin, transfer) {
  const g = globalThis.__csimRealmGlobalById(targetId);
  const D = (g && g.__csimDOMException) || DOMException;
  const tf = Array.isArray(transfer) ? transfer : [];
  // StructuredSerializeWithTransfer in the SENDER realm, NOW (HTML transfers at post time, before the origin check can
  // discard a mis-targeted message): a value that cannot be serialized, or a transfer list that cannot be transferred,
  // throws a DataCloneError SYNCHRONOUSLY — the METHOD's realm's, the target's — which is what
  // `assert_throws(() => frame.postMessage(…))` checks. The target reads it back (__csimDeliverFrameMessage).
  let serialized;
  try { serialized = serializeWithTransfer(message, tf); }
  catch (e) {
    if (e && e.name === 'DataCloneError') throw new D(e.message, 'DataCloneError');
    throw e;
  }
  if (!g || typeof g.__csimDeliverFrameMessage !== 'function') return discardSerialization(serialized);
  // HTML "window post message": the targetOrigin gates delivery (url_ops.rs `post_message_reaches`) — "*" always, "/"
  // a target same-origin with the SENDER, any other value one of the origin it names — matched by the origins' keys: an
  // opaque one same-origin with the windows that share it alone.
  const to = targetOrigin == null ? '*' : String(targetOrigin);
  const senderOrigin = realmOrigin(senderId);
  if (globalThis.__dom.postMessageReaches(to, realmOriginKey(senderId), realmOriginKey(targetId)) !== 1) return discardSerialization(serialized);
  // event.origin in the receiver is the SENDER's origin (not '').
  try {
    g.__csimDeliverFrameMessage(senderId, serialized, senderOrigin);
  } catch (e) {
    discardSerialization(serialized);
    throw e;
  }
};
// A message another realm of the isolate serialized, read back in THIS one — the realm whose event it is: the
// StructuredDeserializeWithTransfer — its values made this realm's, each MessagePort it transferred moved onto a port of
// this realm (`movePort`), whose messages are this realm's tasks and events, and every other transferable made this
// realm's (`receiveTransferred`) — or, one that cannot be read back here (a WebAssembly.Module of another agent
// cluster), `failed`: its event a `messageerror` with no data and no ports (HTML) — the ports it moved, which no one
// receives, closed (else each held on to what its peer is sent, unread).
const FAILED_READ = Object.freeze({ data: null, ports: Object.freeze([]), failed: true });
function readMessage(serialized) {
  for (const [t, moved] of serialized.moved) serialized.moved.set(t, receiveTransferred(moved));
  try {
    return deserializeWithTransfer(serialized);
  } catch (e) {
    if (!e || e.name !== 'DataCloneError') throw e;
    for (const moved of serialized.moved.values()) if (isMessagePort(moved)) closePort(moved);
    return FAILED_READ;
  }
}
globalThis.__csimReadMessage = readMessage;
// Runs in the TARGET realm: the message the sender serialized read back (`readMessage`), and its event task queued, its
// source this realm's proxy for the sender — a task that runs no event once its window's browsing context is discarded
// (a window whose close task ran first: HTML's tasks of a document not fully active are not runnable).
globalThis.__csimDeliverFrameMessage = function (senderId, serialized, senderOrigin) {
  const { data, ports, failed } = readMessage(serialized);
  queueTask(() => {
    if (globalThis.__dom.discardedRealms[0] !== 0 && globalThis.__dom.browsingContextDiscarded()) return;
    let source = null;
    try { source = frameWindowProxyFor(senderId); } catch (_) {}
    try {
      dispatchWithOnHandler(globalThis, createMessageEvent(failed ? 'messageerror' : 'message', {
        data, origin: senderOrigin || '', source, lastEventId: '', ports
      }));
    } catch (_) {}
  });
};

// Re-create `e` as a TypeError of realm `g` when it is a TypeError not already
// belonging to `g`. WebIDL "invoke a callback function" runs with the callback's
// [[Realm]] current, so a TypeError it raises (non-callable operation, revoked
// Proxy) is of THAT realm — but we can't switch V8's active realm from JS, so the
// caught error is in the wrong realm. Rebuilding it under `g.TypeError` makes
// cross-realm `error.constructor === g.TypeError` / `instanceof g.TypeError`
// hold. ONLY TypeErrors are rebuilt: a filter/listener that throws a DOMException
// or a custom error must propagate UNCHANGED (rebuilding would erase its type).
function __csimRealmizeError(g, e) {
  try {
    if (g && e && e.name === 'TypeError' && typeof g.TypeError === 'function' && !(e instanceof g.TypeError)) {
      return new g.TypeError(e.message != null ? String(e.message) : String(e));
    }
  } catch (_) {}
  return e;
}

// "Report the exception" for a CALLBACK that threw (timer / microtask /
// observer). Per WebIDL "invoke a callback function", the exception is reported
// on the callback's [[Realm]] global — NOT the realm that scheduled it. We fire
// that realm's OWN report-the-exception (so its ErrorEvent + window.onerror run in
// the right global) — its platform's, not a `reportError` its page replaced.
// Same-realm / no realm support → the local `reportError`.
globalThis.__csimReportCallbackError = function (cb, e) {
  const g = (typeof cb === 'function') ? __csimRealmGlobalOf(cb) : null;
  if (g && typeof g.__csimReportError === 'function') {
    try { g.__csimReportError(e, cb); return; } catch (_) {}
  }
  reportError(e, cb);
};

// "Report the exception" for an EVENT LISTENER invocation that failed — a
// missing/non-callable `handleEvent` or a throw from the call. Like
// __csimReportCallbackError, but ALSO re-creates the error in the listener
// realm so `error.constructor === otherRealm.TypeError` holds. `anchor` is the
// listener object/function (the callback realm), distinct from the thrown
// error's realm (e.g. a same-realm revoked Proxy used as a cross-realm
// listener's handleEvent). Same-realm → identical to reportError.
// (…`cb` the function it called, where it got one: the listener's `handleEvent` for an object)
// (…another isolate's window's, where the listener is a function of its: `__csimReportRemoteListener`)
globalThis.__csimReportListenerError = function (anchor, e, cb = anchor) {
  if (globalThis.__csimReportRemoteListener(cb, e)) return;
  const g = __csimRealmGlobalOf(anchor);
  if (g && typeof g.__csimReportError === 'function') {
    try { g.__csimReportError(__csimRealmizeError(g, e), cb); return; } catch (_) {}
  }
  reportError(e, cb);
};

// Realm-correct an exception that PROPAGATES to the caller rather than being
// reported — a NodeFilter `acceptNode` failure in TreeWalker / NodeIterator,
// where `assert_throws_js(otherRealm.TypeError, …)` checks the thrown error's
// realm. Returns the error re-created in `anchor`'s realm (or `e` unchanged
// same-realm). The caller throws the result.
globalThis.__csimRealmizeCallbackError = function (anchor, e) {
  return __csimRealmizeError(__csimRealmGlobalOf(anchor), e);
};

// Is `cb` still "runnable" — i.e. does it belong to a browsing context that
// hasn't been destroyed? A callback whose realm is a DISPOSED child frame realm
// (the frame was removed from the document) is no longer runnable, and per HTML
// "invoke a callback function" the caller throws instead of calling it (e.g.
// NodeIterator/TreeWalker filtering after `iframe.remove()`). Returns true for a
// same-realm callback or an object-shaped callback with no realm — only a callback
// of a realm in no live browsing-context tree (navigables.rs `realmInTree`) is dead.
// (dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html)
globalThis.__csimCallbackRunnable = function (cb) {
  try {
    const NS = globalThis.RustyRacer;
    if (!cb) return true;
    const id = NS.contextOf(cb);
    if (id == null) return true;
    if (id === globalThis.__csimRealmId()) return true;  // this realm
    // …or any realm of the live browsing-context tree — a parent's filter handed to a frame's document: a removed
    // frame's realm, and those below it, are in it no more
    return globalThis.__dom.realmInTree(id);
  } catch (_) { return true; }
};

// A MessagePort's message (HTML §9.4.4 "message port post message steps"): StructuredSerializeWithTransfer at post
// time — an uncloneable message (a DOM node, the global, a function, a non-transferred transferable) throws
// DataCloneError synchronously, each listed transferable is MOVED (a port onto a fresh entangled one delivered in
// `ports`, an ArrayBuffer detached) — and the peer reads it back in its own realm (message-port.js `acceptSerialized`,
// `readMessage`): a distinct clone of that realm's, or a `messageerror` where it cannot be read back there. The port
// it is posted through is no transferable of its own message. A remote port's goes serialized through the host to the
// other end of its channel.
function postPortMessage(port, message, transfer) {
  const tf = transferListFrom(transfer);
  if (tf.indexOf(port) !== -1) throw dataCloneError('The source port could not be transferred.');
  if (postRemote(port, message, tf)) return;
  const serialized = serializeWithTransfer(message, tf);
  const peer = peerOf(port);
  if (peer) acceptSerialized(peer, serialized);
  else discardSerialization(serialized);
}
installPorts(postPortMessage);

// Release a batch of zero-copy postMessage transfer tokens
// (`RustyRacer.transferOut`). Called from Ruby on `reset!` to free any backing
// store whose token was never imported; `transferDrop` no-ops on an
// already-imported token, so over-dropping is safe.
globalThis.__csimTransferDropAll = function (tokens) {
  const NS = globalThis.RustyRacer;
  if (!tokens) return;
  for (let i = 0; i < tokens.length; i++) NS.transferDrop(tokens[i]);
};

// ── Cross-window references: window.open / window.opener / postMessage ──
// Each browsing context (window/tab) is a SEPARATE isolate, so a reference to
// another window can't be a live JS object — it's a proxy that forwards every
// operation to the host, which routes to that window's VM. The host fns
// (`__csimWindow*`, wired per-window by the Ruby Driver) only exist post-
// snapshot, so resolve them at call time rather than guarding at module eval.
const __csimWindowProxies = new Map();   // handle -> proxy (stable identity)
const __csimWindowProxyHandles = new WeakMap();   // proxy -> handle

// ── Cross-window remote-ref proxy (SOURCE side) ────────────────────────────
// Wraps a ref id from another window's VM (a DOM node, a non-node object, or the
// window itself = id 0) in a Proxy that forwards every get/set/method-call across
// the host boundary (__csimWindowRef{Get,Set,Call}). Returned nodes/objects come
// back as `{__csimRef:id}` markers and are wrapped into further proxies; a
// member read that is a function comes back as `{__csimRefFn:true}` and is exposed
// as a local function that re-invokes it as a method call on the owning ref.
//
// Scope is single-hop scripting (the patterns real cross-window tests/apps use:
// read/write a property, call a method, chain through returned nodes/objects).
// Deliberately NOT modelled — each only matters for exotic cross-window use no
// test/app exercises, and each needs a heavier mechanism:
//   - passing a ref-proxy owned by window A into a method on window B (the id is
//     resolved in B's registry — node identity is per-window);
//   - iterating a returned collection (Symbol.iterator isn't forwarded).
// (A function handed across either way — an argument, a value set, a call's result — is a callback handle:
// `csimPackArg`, `__csimRemoteCallback`.)
// The target-side object registry (host-queries) holds non-node objects for the
// window's VM lifetime (dropped when the window/VM is disposed).
const __csimRefProxies = new Map();   // `${winHandle}:${id}` -> proxy
// (…a window comes back as `{__csimWindow: handle}` — the window the ref is of '' — and is the WindowProxy this realm
// has of it: `w.opener` this window itself, as `w.opener === window` is in Chrome and Firefox, `w.self` `w`)
// (…and an exception the access threw there thrown here: `remoteError`)
function csimWrapRef(winHandle, v) {
  if (!v || typeof v !== 'object') return v;
  if (v.__csimUndefined === true) return undefined;
  if (v.__csimThrow != null) throw remoteError(v.__csimThrow);
  if (v.__csimWindow != null) return v.__csimWindow === '' ? csimWindowProxy(winHandle) : windowSeenHere(v.__csimWindow);
  if (v.__csimFn != null) return globalThis.__csimRemoteCallback(v.__csimFrom, v.__csimRealm, v.__csimFn);
  return v.__csimRef != null ? csimRemoteRefProxy(winHandle, v.__csimRef) : v;
}
// The window of handle `handle` as this realm sees it: this window's own page's — this realm's global, or a frame's
// WindowProxy of its top — or this realm's WindowProxy of another's.
let ownWindowHandle;
function windowSeenHere(handle) {
  ownWindowHandle ??= globalThis.__csimOwnWindowHandle();
  return handle === ownWindowHandle ? frameWindowProxyFor(0) : csimWindowProxy(handle);
}
// (…the RPC's target side's too, for a window passed to it: host-queries.js `__remoteDeserialize`)
globalThis.__csimWindowSeenHere = windowSeenHere;
// A ref-proxy passed back as an argument round-trips by its id; a window by its handle — this realm's page's its own,
// another isolate's the one its WindowProxy here is of — which the receiving window sees as its own WindowProxy of it.
// (…undefined its marker, as a value coming back is: the host carries it as null)
// A function of this realm's a callback handle (host-queries.js `__remoteCallbackOf`) for the realm it is handed to,
// `receiver` (`handle:realm`); a ref-proxy, which is a function too, by its id.
function csimPackArg(a, receiver) {
  if (a === undefined) return { __csimUndefined: true };
  if (typeof a === 'function') {
    if (a.__csimRefId != null) return { __csimRef: a.__csimRefId };
    return globalThis.__csimRemoteCallbackOf(a, receiver);
  }
  if (!a || typeof a !== 'object') return a;
  if (a === globalThis || a === frameWindowProxyFor(0)) return { __csimWindow: (ownWindowHandle ??= globalThis.__csimOwnWindowHandle()) };
  const handle = __csimWindowProxyHandles.get(a);
  if (handle !== undefined) return { __csimWindow: handle };
  return a.__csimRefId != null ? { __csimRef: a.__csimRefId } : a;
}
// …the arguments of a call into the window of `handle`, its page's realm the one that receives them
const packArgsFor = (handle, args) => args.map((a) => csimPackArg(a, `${handle}:0`));
// …and this realm, as the realm a call's result is for (`__remoteResult`)
const ownReceiver = () => `${ownWindowHandle ??= globalThis.__csimOwnWindowHandle()}:${globalThis.__csimRealmId()}`;
// An exception another isolate's window threw as this realm's script reached into it (host-queries.js `__remoteThrow`),
// thrown here: an Error of its kind, of this realm's — a DOMException of its name, a TypeError, a RangeError … — its
// message and its stack the thrower's; any other value as it was thrown. (…kept by the error it is, for the listener it
// may be thrown out of to report the thrower's: `__csimReportRemoteListener`)
const ERROR_KINDS = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
const __csimRemoteThrows = new WeakMap();   // error -> {name, message, stack}
function remoteError(thrown) {
  if ('value' in thrown) return thrown.value;
  const e = Object.hasOwn(ERROR_KINDS, thrown.name) ? new ERROR_KINDS[thrown.name](thrown.message) : new DOMException(thrown.message, thrown.name);
  try { Object.defineProperty(e, 'stack', { value: thrown.stack, writable: true, configurable: true }); } catch (_) {}
  __csimRemoteThrows.set(e, thrown);
  return e;
}
// A function another isolate's window handed this one — an argument of a method its script called on this one, a value
// it set here (`w.onload = f`, `w.addEventListener('load', f)`), a call's result — the function of its realm `realm` by
// its id: the one function here that calls it back there through the host, synchronously, with this call's `this` and
// arguments as this realm's RPC serializes them (refs of its own, which that window's script reaches through it) — no
// function crosses an isolate, a call of one does, as a browser's one event loop calls a listener another window's
// script added, in the task that dispatches the event (Driver#window_ref_apply). Its result that window's, as one of its
// members read is; what it throws thrown here (`remoteError`) — reported there, where it is a listener's
// (`__csimReportRemoteListener`). Held weakly: once this realm lets it go, that window lets its id go
// (`__csimWindowRefRelease`).
const __csimRemoteCallbacks = new Map();   // `${from}:${realm}:${id}` -> WeakRef(function)
const __csimRemoteCallbackIds = new WeakMap();   // function -> {from, realm}
const __csimRemoteCallbackGone = new FinalizationRegistry(({ key, from, realm, id }) => {
  if (__csimRemoteCallbacks.get(key)?.deref() === undefined) {
    __csimRemoteCallbacks.delete(key);
    try { globalThis.__csimWindowRefRelease(from, realm, id); } catch (_) {}
  }
});
globalThis.__csimRemoteCallback = (from, realm, id) => {
  // (…one of this realm's own handed back: itself)
  ownWindowHandle ??= globalThis.__csimOwnWindowHandle();
  if (from === ownWindowHandle && realm === globalThis.__csimRealmId()) return globalThis.__csimRemoteCallbackTarget(id);
  const key = `${from}:${realm}:${id}`;
  let fn = __csimRemoteCallbacks.get(key)?.deref();
  if (fn) return fn;
  const serialize = globalThis.__csimRemoteSerialize;
  fn = function (...args) {
    return csimWrapRef(from, globalThis.__csimWindowRefApply(from, realm, id, serialize(this), args.map(serialize), ownReceiver()));
  };
  __csimRemoteCallbacks.set(key, new WeakRef(fn));
  __csimRemoteCallbackIds.set(fn, { from, realm });
  __csimRemoteCallbackGone.register(fn, { key, from, realm, id });
  return fn;
};
// …and a function of this realm's another window calls back so (`__csimRemoteCallback`, its window that of `caller`),
// called: `this` and its arguments that window's refs, its result serialized here for `receiver` — an exception it
// throws that window's to throw (`__remoteThrow`), undefined for a function this realm let go of — or a document before it gave.
globalThis.__csimRemoteRefApply = (id, thisArg, args, caller, receiver) => {
  const fn = globalThis.__csimRemoteCallbackTarget(id);
  if (typeof fn !== 'function') return { __csimUndefined: true };
  try {
    return globalThis.__csimRemoteResult(fn.apply(csimWrapRef(caller, thisArg), args.map((a) => csimWrapRef(caller, a))), receiver);
  } catch (e) {
    return globalThis.__csimRemoteThrow(e);
  }
};
// An exception a listener threw out of its dispatch here, where that listener is another window's function
// (`__csimRemoteCallback`) that threw it there: reported in that window's realm, the callback's own (HTML "report the
// exception" — the realm of the callback, not of the event) — whether it was (true), or is this realm's to report.
globalThis.__csimReportRemoteListener = (cb, e) => {
  const owner = typeof cb === 'function' && __csimRemoteCallbackIds.get(cb);
  const thrown = owner && e !== null && typeof e === 'object' && __csimRemoteThrows.get(e);
  if (!thrown) return false;
  globalThis.__csimWindowRefReport(owner.from, owner.realm, thrown);
  return true;
};
// …the one this realm reports so, of a callback of its own another window's dispatch called.
globalThis.__csimReportRemoteException = (thrown) => reportError(remoteError(thrown));
function csimRemoteRefProxy(winHandle, id) {
  if (id == null) return null;
  const key = winHandle + ':' + id;
  let p = __csimRefProxies.get(key);
  if (p) return p;
  p = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === '__csimRefId') return id;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const v = globalThis.__csimWindowRefGet(winHandle, id, String(prop));
      if (v && typeof v === 'object' && v.__csimRefFn) {
        return (...args) => csimWrapRef(winHandle, globalThis.__csimWindowRefCall(winHandle, id, String(prop), packArgsFor(winHandle, args), ownReceiver()));
      }
      return csimWrapRef(winHandle, v);
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return true;
      csimWrapRef(winHandle, globalThis.__csimWindowRefSet(winHandle, id, String(prop), csimPackArg(value, `${winHandle}:0`)));
      return true;
    }
  });
  __csimRefProxies.set(key, p);
  return p;
}

// A window of another isolate — a top-level traversable another Browser hosts: one `window.open` opened at a URL, this
// window's opener, the source of a message from one — by its host handle: its WindowProxy here, one per window however
// its document changes (`w` the same object across its navigations). HTML's WindowProxy, whose same-origin check
// (IsPlatformObjectSameOrigin) is the engine's (session_history.rs `traversableSameOrigin`): this realm's document
// against the origin the window's traversable published for its active document, asked as each member is reached — that
// document changes with no word to this isolate.
//   - Same origin, a member is its Window's own, reached through the remote-ref RPC (`remote`): `document`, `history`,
//     whatever its page put on its global; and its Location (`location`) the real one's.
//   - Cross-origin, the CrossOriginProperties alone (HTML CrossOriginGet / CrossOriginSet /
//     CrossOriginGetOwnPropertyHelper / CrossOriginOwnPropertyKeys, the generated table): `then` and the fallback symbols
//     undefined, anything else a SecurityError — its Location's `href` setter and `replace()` alone — as a WindowProxy of
//     this isolate's is (`frameWindowProxyFor`). (A child frame by index is a SecurityError too, where HTML has its
//     WindowProxy: one of another isolate's window is the remote-ref RPC's, which no origin gates — a gap until the
//     windows of a group share an isolate.)
// Either way what the host does for the window is this realm's: its `closed`, `close()`, `focus()`, `blur()` and
// `postMessage()`; its navigation (`navigate`); its `window`, `self`, `frames`, `top` and `parent`, a top-level window's
// every one this proxy. (…its listeners those of its Window, which a function of this realm's set as one is a callback
// handle of: `csimPackArg`)
const LOCATION_URL_PARTS = new Set(['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);
// …and a Location's own members, its [LegacyUnforgeable] ones: the set Chrome and Firefox list, in the IDL's order and
// the stringifier last — neither browser's order (Chrome lists `ancestorOrigins` first, Firefox after `hash`). (Both
// also serialize `"ancestorOrigins":{}` in `JSON.stringify(location)`, which this omits: its value a ref of the other
// window's, a function proxy, which JSON skips.)
const LOCATION_MEMBERS = Object.freeze([
  'href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'assign', 'replace', 'reload',
  'ancestorOrigins', 'toString'
]);
function csimWindowProxy(handle) {
  if (handle == null || handle === '') return null;
  let proxy = __csimWindowProxies.get(handle);
  if (proxy) return proxy;
  // (…by the number of its traversable, the host's to say — none for a window gone, which is of no origin)
  const traversable = globalThis.__csimWindowTraversable(handle);
  const sameOrigin = () => traversable != null && globalThis.__dom.traversableSameOrigin(traversable);
  // A Location-object navigation of the window by this realm's script (its `location` set, its Location's `href` set,
  // `assign()`, `replace()`), HTML's: the URL resolved here — against this document, the entry settings object's, as a
  // `location.href` set by this realm's script is (`navigateLocationFrom`) — a SyntaxError for no URL; with this window's
  // transient activation as it begins (its source snapshot's, location.js `dispatchNav`), `replace` with history handling
  // "replace" — planned, the window beginning it as a task of its own (session_history.rs `Asked`), whose document fires
  // its own load; a javascript: URL's likewise, run in the window's document where that is same origin with this one as
  // the task runs, as HTML navigates to one (no document of its own, no load: `traversablePlanJavascript`).
  const navigate = (value, words, replace) => {
    const input = toUSVString(value, `Failed to ${words} on 'Location': `);
    const url = parseDocumentURL(globalThis.document, input);
    if (url === null) throw new DOMException(`Failed to ${words} on 'Location': '${input}' is not a valid URL.`, 'SyntaxError');
    if (url.startsWith('javascript:')) {
      if (traversable != null) globalThis.__dom.traversablePlanJavascript(traversable, url);
      return;
    }
    // (…one to a fragment of its document navigated within it, HTML "navigate to a fragment" — its own steps
    // (location.js `tryFragmentNavigate`): `hashchange`, no document, no load — not a new document at its URL)
    if (globalThis.__dom.urlIsFragmentNavigation(href(), url)) {
      remote('__csimFragmentNavigate')(url, replace);
      return;
    }
    globalThis.__csimWindowSetLocation(handle, url, globalThis.__dom.sourceActivation(-1), replace, globalThis.__csimRealmId());
  };
  // A member of its Window, the remote-ref RPC's ref 0, read there: a function one called on the window, an object a ref
  // proxy of it (`history`, `location` and `document` re-read as each is reached: a ref names an object of the document
  // it was read in, which a navigation of the window replaces).
  const remote = (prop) => {
    const v = globalThis.__csimWindowRefGet(handle, 0, prop);
    if (v && typeof v === 'object' && v.__csimRefFn) {
      return (...args) => csimWrapRef(handle, globalThis.__csimWindowRefCall(handle, 0, prop, packArgsFor(handle, args), ownReceiver()));
    }
    return csimWrapRef(handle, v);
  };
  // Its History's `back()` / `forward()` / `go(n)`: a traversal of its session history, appended to its traversal queue
  // (HTML "traverse the history by a delta", `go(0)` a reload), which the window applies as a task of its own — none
  // while this script runs — its document, one the traversal makes again, firing its own load
  // (session_history.rs `traversableTraverse`).
  // Its History is its document's (`traversableDocument`): `w.history` a new one as the window shows another document, the
  // one read before not fully active then — every member of it a SecurityError, in the words of the member it is.
  const shownDocument = () => (traversable == null ? -1 : globalThis.__dom.traversableDocument(traversable));
  const notFullyActive = (words) =>
    new DOMException(`${words} on 'History': May not use a History object associated with a Document that is not fully active`, 'SecurityError');
  const makeHistory = (shown) => new Proxy({}, {
    get(_t, prop) {
      const active = shown === shownDocument();
      const traverse = (delta, method) => {
        if (shown !== shownDocument()) throw notFullyActive(`Failed to execute '${method}'`);
        globalThis.__dom.traversableTraverse(traversable, delta);
      };
      if (prop === 'back')    return () => traverse(-1, 'back');
      if (prop === 'forward') return () => traverse(1, 'forward');
      if (prop === 'go')      return (d) => traverse(d == null ? 0 : (Math.trunc(Number(d)) || 0), 'go');
      if (!active && typeof prop === 'string') {
        if (prop === 'pushState' || prop === 'replaceState') return () => { throw notFullyActive(`Failed to execute '${prop}'`); };
        throw notFullyActive(`Failed to read the '${prop}' property from`);
      }
      // length / state / scrollRestoration / push/replaceState — re-resolve the
      // aux history ref per access: its remote-ref id is invalidated when the
      // aux navigates (VM rebuild); the traversal methods above don't need it.
      const ref = remote('history');
      return ref ? ref[prop] : undefined;
    }
  });
  let history, historyShown;   // memoized so `w.history` keeps a stable identity while it shows one document
  const historyOf = () => {
    const shown = shownDocument();
    if (!history || historyShown !== shown) [history, historyShown] = [makeHistory(shown), shown];
    return history;
  };

  // Its Location: one object, which answers as the window's origin is to this realm's as each member is reached. Same
  // origin, its URL's parts read off the URL its host holds (`__csimWindowLocation` — no call into its isolate, which may
  // be the one waiting on this script: a popup's boot reading `opener.location`), its navigations this realm's
  // (`navigate`) and its reload, every other member — a part's setter, `ancestorOrigins` — the real Location's;
  // cross-origin, its CrossOriginProperties (`crossOriginLocationOf`).
  const href = () => {
    const h = globalThis.__csimWindowLocation(handle);
    return parseURL(h)?.href || h;
  };
  const locationMethods = {
    assign(url) {
      required(arguments, 1, 'assign', 'Location');
      navigate(url, "execute 'assign'", false);
    },
    replace(url) {
      required(arguments, 1, 'replace', 'Location');
      navigate(url, "execute 'replace'", true);
    },
    // (…HTML "reload": the reload history step appended to its traversal queue — `history.go(0)` — which the window
    // applies as a task of its own, its document made again firing its own load: none while this script runs, the
    // document this realm reads the same until then, as in Chrome and Firefox)
    reload() {
      if (traversable != null) globalThis.__dom.traversableTraverse(traversable, 0);
    },
    toString() { return href(); }
  };
  const crossLocation = crossOriginLocationOf(navigate, () => undefined);
  const location = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (!sameOrigin()) return Reflect.get(crossLocation, prop);
      if (typeof prop === 'symbol') return undefined;
      if (LOCATION_URL_PARTS.has(prop)) return prop === 'href' ? href() : parseURL(href())?.[prop] ?? '';
      if (Object.hasOwn(locationMethods, prop)) return locationMethods[prop];
      return remote('location')?.[prop];
    },
    set(_t, prop, value) {
      if (!sameOrigin()) return Reflect.set(crossLocation, prop, value);
      if (prop === 'href') navigate(value, "set the 'href' property", false);
      else if (typeof prop !== 'symbol') { const ref = remote('location'); if (ref) ref[prop] = value; }
      return true;
    },
    has(_t, prop) {
      if (!sameOrigin()) return Reflect.has(crossLocation, prop);
      return LOCATION_MEMBERS.includes(prop) || (typeof prop === 'string' && remote('location')?.[prop] != null);
    },
    // (…same origin, its members its own, unforgeable — enumerable, so `Object.keys(w.location)` lists them and
    // `JSON.stringify(w.location)` has its URL's parts — reported configurable, as the target holds none of them)
    ownKeys() { return sameOrigin() ? [...LOCATION_MEMBERS] : Reflect.ownKeys(crossLocation); },
    getOwnPropertyDescriptor(_t, prop) {
      if (!sameOrigin()) return Reflect.getOwnPropertyDescriptor(crossLocation, prop);
      if (!LOCATION_MEMBERS.includes(prop)) return undefined;
      return { value: this.get(_t, prop), writable: !Object.hasOwn(locationMethods, prop), enumerable: true, configurable: true };
    },
    getPrototypeOf()                   { return null; },
    setPrototypeOf()                   { return false; },
    defineProperty()                   { return false; },
    deleteProperty()                   { return false; }
  });

  const methods = {
    // (…closing at once, its close a task of the window's own: the host's, as it judges the window script-closable)
    close() { globalThis.__csimWindowClose(handle); },
    focus() {},
    blur()  {},
    // Cross-window postMessage: another window is another isolate, so the message crosses as a worker's does
    // (workers.js `encodeMessage`) — serialized here, a DataCloneError the caller's, its transfer list moved — posted to
    // the window's traversable (session_history.rs `traversablePost`), a task of its event loop, with this window as
    // its source.
    // The targetOrigin is validated here (SyntaxError, sender-side per spec) and
    // GATES delivery on the target side; `/` resolves to the SENDER's origin
    // now, since the target can't recover it. event.origin carries the sender's
    // origin — the receiving page's origin check (`e.origin != expected`) is
    // the whole point of the field.
    postMessage(data, targetOrigin, transfer) {
      // Absent / dictionary targetOrigin resolves through the shared resolver ("/" default,
      // matching the in-page frame path) — not the old always-'*'.
      let to = validatePostMessageTargetOrigin(targetOrigin);
      const sender = documentOrigin();
      // Reduce a URL-shaped targetOrigin to its ORIGIN before it travels — the delivery
      // gate compares against the target's serialized origin, and Chrome accepts
      // 'https://a.com/path' / trailing slashes / default ports (mirrors the in-page
      // frame path at __csimPostMessageRealm).
      if (to === '/') to = sender;
      else if (to !== '*') to = globalThis.__dom.postMessageTarget(to);
      const message = encodeMessage(data, transfer);
      // (…one posted as the task that opened it runs reaching its initial about:blank, which no listener of the document
      // its navigation makes hears: HTML's task, of a document that is never fully active again)
      if (traversable != null) {
        globalThis.__dom.traversablePost(traversable, message, to, sender, ownWindowHandle ??= globalThis.__csimOwnWindowHandle());
      }
    }
  };
  // What this realm answers for the window whatever its origin, by name — the CrossOriginProperties this realm's, and the
  // driver's own: the window's handle, its raw window none (no global of this isolate's: `seenHere` asks).
  const own = {
    window:             () => proxy,
    self:               () => proxy,
    frames:             () => proxy,
    top:                () => proxy,
    parent:             () => proxy,
    closed:             () => traversable == null || globalThis.__dom.traversableClosing(traversable),
    location:           () => location,
    __csimWindowHandle: () => handle,
    __csimRawWindow:    () => undefined
  };
  for (const [name, fn] of Object.entries(methods)) own[name] = () => fn;
  const isOwn = (prop) => typeof prop === 'string' && Object.hasOwn(own, prop);
  // (…the rest the window's own: same origin, any but a symbol, which the RPC carries none of; cross-origin `length` and
  // `opener`, the CrossOriginProperties not this realm's — and the driver's keys another window's script reaches,
  // either way: testdriver's `bless(…, popup)`)
  const get = (prop) => {
    if (isOwn(prop)) return own[prop]();
    if (isInternalKey(prop)) return remote(prop);
    if (isCrossOriginFallback(prop)) return undefined;
    if (!sameOrigin() && (typeof prop === 'symbol' || !CROSS_ORIGIN_WINDOW_PROPERTIES.has(prop))) throw crossOriginSecurityError();
    if (typeof prop === 'symbol') return undefined;
    return prop === 'history' ? historyOf() : remote(prop);
  };
  // (…cross-origin, HTML's [[HasProperty]] by its [[GetOwnProperty]]: a CrossOriginProperty or a fallback key present,
  // anything else a SecurityError — `'document' in w` throws, as Chrome and Firefox do)
  const has = (prop) => {
    if (isOwn(prop) || isInternalKey(prop)) return true;
    if (!sameOrigin()) {
      if (CROSS_ORIGIN_WINDOW_PROPERTIES.has(prop) || isCrossOriginFallback(prop)) return true;
      throw crossOriginSecurityError();
    }
    // (…same origin, the window's own [[HasProperty]], asked there: a member it holds undefined is one)
    if (prop === 'history') return true;
    return typeof prop === 'string' && globalThis.__csimWindowRefHas(handle, 0, prop) === true;
  };
  const crossDescriptor = crossOriginWindowDescriptors(() => proxy, methods);
  proxy = new Proxy({}, {
    get(_t, prop) { return get(prop); },
    // (…`location` set, [PutForwards=href], the one CrossOriginSet allows: its Location's `href` set by this realm's
    // script; anything else the window's own, same origin — a function a callback handle of this realm's (`csimPackArg`)
    // — and a SecurityError cross-origin)
    set(_t, prop, value) {
      if (prop === 'location') { navigate(value, "set the 'href' property", false); return true; }
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      if (!isOwn(prop) && typeof prop !== 'symbol' && prop !== 'history') {
        csimWrapRef(handle, globalThis.__csimWindowRefSet(handle, 0, prop, csimPackArg(value, `${handle}:0`)));
      }
      return true;
    },
    has(_t, prop) { return has(prop); },
    ownKeys() {
      if (sameOrigin()) return Object.keys(own).filter((k) => !k.startsWith('__csim'));
      return [...CROSS_ORIGIN_WINDOW_PROPERTIES, 'then', ...CROSS_ORIGIN_FALLBACK_SYMBOLS];
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (sameOrigin()) return has(prop) ? { value: get(prop), writable: true, enumerable: true, configurable: true } : undefined;
      if (isCrossOriginFallback(prop)) return { value: undefined, writable: false, enumerable: false, configurable: true };
      if (typeof prop === 'symbol' || !CROSS_ORIGIN_WINDOW_PROPERTIES.has(prop)) throw crossOriginSecurityError();
      return crossDescriptor(prop);
    },
    // (…same origin, a property of the window's own defined or deleted there — a data property's value alone crosses,
    // an accessor's functions cannot; cross-origin, nothing, HTML's [[DefineOwnProperty]] / [[Delete]])
    defineProperty(_t, prop, desc) {
      if (!sameOrigin()) throw crossOriginSecurityError();
      if (typeof prop === 'symbol' || isOwn(prop) || !('value' in desc)) return false;
      csimWrapRef(handle, globalThis.__csimWindowRefSet(handle, 0, prop, csimPackArg(desc.value, `${handle}:0`)));
      return true;
    },
    deleteProperty(_t, prop) {
      if (!sameOrigin()) throw crossOriginSecurityError();
      if (typeof prop === 'symbol' || isOwn(prop)) return false;
      return globalThis.__csimWindowRefDelete(handle, 0, prop) === true;
    },
    getPrototypeOf()    { return sameOrigin() ? Object.prototype : null; },
    setPrototypeOf()    { return false; },
    preventExtensions() { return false; }
  });
  __csimWindowProxies.set(handle, proxy);
  __csimWindowProxyHandles.set(proxy, handle);
  return proxy;
}

// Consume user activation — a new top-level traversable chosen (`window.open`, a `target=_blank` link or form) consumes
// that of the window choosing it, per HTML (user_activation.rs): the host's call as it makes one (`consume_user_activation`),
// told whether the window had it — what the navigation of the new one carries.
globalThis.__csimConsumeTransientActivation = () => globalThis.__dom.consumeActivation();
// …and whether it has it, unconsumed: the host's, as a window this one navigates begins its navigation (`source_activated?`).
globalThis.__csimSourceActivation = () => globalThis.__dom.sourceActivation(-1);

// `window.open(url, name, features)` opens (or, by name, reuses) a real
// auxiliary window via the Driver and returns a proxy for it (null if the
// host can't open one, e.g. no Driver).
// (The Window's, window.js, which converted its arguments: `url` a USVString, `name` the target, '_blank' unsaid,
// `features` a DOMString.)
// With `noopener` — or `noreferrer`, which implies it, and sends no Referer — the window it opens is no auxiliary one:
// it has no opener, its about:blank a new opaque origin, and the call returns null (HTML window open steps 15-17).
export function openWindow(url, name, features = '') {
  return windowOpenSteps(url, name, features);
}
// …for a hyperlink to a javascript: URL whose target chooses another navigable too (dom-nodes.js `followHyperlink`),
// which imports nothing of this module.
globalThis.__csimWindowOpenSteps = (url, name, features) => windowOpenSteps(url, name, features);
function windowOpenSteps(url, name, features) {
  // HTML "window open steps" step 5: a NON-empty url parsed against the entry settings object's API base URL once, the
  // navigation taking the URL it parsed to; a parse FAILURE a SyntaxError DOMException, synchronously. An empty url
  // opens about:blank (no parse). (…this window's document's base standing in for the entry one's: the two differ only
  // where another realm's script calls this window's `open`)
  let u = url;
  if (url !== '') {
    u = parseURL(url, apiBaseURL())?.href;
    if (u === undefined) {
      throw new DOMException(
        "Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '" + url + "'.", 'SyntaxError');
    }
  }
  // (…none from a window whose document is not fully active — its frame navigated away or removed, a script of its still
  // running: it has no browsing context to choose a navigable from)
  if (!globalThis.__dom.documentFullyActive()) return null;
  const set = openFeaturesOf(features);
  // The navigable its target chooses (HTML "the rules for choosing a navigable": navigables.rs `openRoute`; an empty
  // target `_blank`, where a link's empty target is its own browsing context): this window's own — navigated as its
  // location is, its own proxy returned (where the 3-argument `document.open(url, name, features)` lands too) — another
  // navigable, navigated as its own location would be (a javascript: URL, a fragment, a frame's, a window's — this
  // document its initiator) and its window returned — this realm's `top` or `parent`, a frame's the one its container's
  // realm hands out (as `frames[name]` there is: one WindowProxy per realm, not per navigable), another window's — none
  // where this document's sandbox does not let it navigate it, nor a new one it refuses (no `allow-popups`); else a new
  // window.
  const [route, at, window, container] = globalThis.__dom.openRoute(name);
  if (route === 'none') return null;
  if (route === 'own') {
    // (…navigated with history handling "auto" — a new entry, even as its document loads, where a `location.href` set
    // replaces it — a `javascript:` URL run in THIS global)
    if (u !== '') globalThis.__csimNavigateFrom(u, globalThis.__csimRealmId());
    return set & OPEN_NOOPENER ? null : globalThis;
  }
  if (route === 'navigable') {
    // (…a frame with no document yet made one now)
    const chosen = window === 'top' ? globalThis.top : window === 'parent' ? globalThis.parent
      : window === 'window' ? frameWindowProxyFor(at) : container.contentWindow;
    const realm = at >= 0 ? at : container ? frameRealmOf(container) ?? -1 : -1;
    if (u !== '' && realm >= 0) globalThis.RustyRacer.contextGlobal(realm).__csimNavigateFrom(u, globalThis.__csimRealmId());
    return set & OPEN_NOOPENER ? null : chosen;
  }
  if (route === 'refused') {
    logPopupRefused(u || 'about:blank');
    return null;
  }
  const fn = globalThis.__csimWindowOpen;
  if (typeof fn !== 'function') return null;
  // Pass the OPENER's realm id so a same-isolate window realm can wire window.opener
  // to a WindowProxy for it (0 = the main realm, a valid opener — distinct from "no
  // opener").
  const callerRealmId = globalThis.__csimRealmId();
  // An about:blank popup's URL is opaque, but its ORIGIN and its BASE URL — what its relative
  // URLs resolve against — are both INHERITED from this document, exactly as an empty
  // <iframe>'s are. Hand them over so the new realm can be seeded with them; without the
  // origin the popup would be cross-origin to its own opener.
  let aboutBase = '';
  if (globalThis.document) aboutBase = documentBaseURL(globalThis.document);
  // (…the document's, not `origin`, which a page may have replaced — the engine's (realm_location.rs `popup_origins`):
  // a new opaque one where this document's sandbox propagates to its popups, else this document's, an opaque one's
  // inherited with its key, so the popup is same-origin to its opener. A popup of this isolate takes them from this
  // realm itself; this is a separate window's, which an opaque one it cannot share)
  const aboutOrigin = globalThis.__dom.popupOrigins()[0];
  // (…`_blank` no name: a new window, never one the host finds by name)
  // (…a javascript: URL the window's document runs where it is of this document's origin — a new window's about:blank,
  // opened at no URL, or one of another isolate the host finds by name — as the navigation to one is: no document of
  // its own, no load)
  const javascript = u.startsWith('javascript:');
  const handle = fn(javascript ? '' : u, at, callerRealmId, aboutBase, aboutOrigin, (set & OPEN_NOOPENER) !== 0, (set & OPEN_NOREFERRER) !== 0);
  if (!handle || set & OPEN_NOOPENER) return null;
  if (javascript) {
    // (…a window of this isolate's where it is of this document's origin, by the keys: navigables.rs `navigationVerdict`)
    if (typeof handle === 'number') {
      const verdict = globalThis.__dom.navigationVerdict(callerRealmId, handle, u, false);
      if (verdict === 'navigate') globalThis.RustyRacer.contextGlobal(handle).__csimRunJavascriptURL(u);
    } else {
      const traversable = globalThis.__csimWindowTraversable(handle);
      if (traversable != null) globalThis.__dom.traversablePlanJavascript(traversable, u);
    }
  }
  // A NUMERIC handle is a same-origin window realm in this isolate → a native
  // WindowProxy (like iframe.contentWindow): `popup.document` is a real
  // same-isolate Document. A STRING handle is a separate-isolate aux window →
  // the cross-isolate RPC proxy.
  const proxy = (typeof handle === 'number' && typeof globalThis.__csimFrameWindowProxyFor === 'function')
    ? globalThis.__csimFrameWindowProxyFor(handle)
    : csimWindowProxy(handle);
  if (!proxy) return null;
  return proxy;
}

// `window.opener` — the window that opened this one (or null), resolved from the host each read (window.js keeps
// what a page or the driver sets instead).
export function hostOpener() {
  const fn = globalThis.__csimWindowOpener;
  const handle = typeof fn === 'function' ? fn() : null;
  return handle ? csimWindowProxy(handle) : null;
}

// Deliver a cross-window postMessage the host took for THIS window (browser.rb `deliver_posted_messages`), a task of its
// own: a `message` event carrying `.data` / `.origin` / `.source` (the sender's WindowProxy here). The targetOrigin gate
// is evaluated HERE because only the target VM knows its own current origin (HTML "window post message" step 7.2,
// url_ops.rs `post_message_reaches`): '*' delivers to anyone; anything else must name this window's origin, by its key,
// or the message is silently dropped. A '/' was already resolved to the sender's origin on the sending side — an opaque
// one's "null", which names no origin (no opaque origin spans two windows here).
function deliverWindowMessage(data, origin, targetOrigin, sourceHandle) {
  // (…`data` the sender's serialization, workers.js `encodeMessage`)
  if (targetOrigin && globalThis.__dom.postMessageReaches(targetOrigin, '', globalThis.__csimBcOriginKey()) !== 1) return;
  const m = decodeMessage(data);
  dispatchWithOnHandler(globalThis, createMessageEvent(messageEventType(m), {
    data:        m.data,
    origin:      origin || '',
    source:      sourceHandle ? csimWindowProxy(sourceHandle) : null,
    lastEventId: '',
    ports:       m.ports
  }));
}
globalThis.__csim_deliverWindowMessage = hostTask(deliverWindowMessage);

// Resolve + validate a `Window.postMessage` second argument's targetOrigin — either the legacy
// USVString form or a WindowPostMessageOptions dictionary's `targetOrigin` (default "/"). `*` (any)
// and `/` (same origin) are special; any other value must parse as an absolute URL, else the whole
// call is a SyntaxError (HTML "window post message" step 4). Shared by the same-realm self-post and
// the cross-realm WindowProxy post so both reject a bad origin synchronously in the sender.
// A `Window.postMessage` second argument is EITHER a WindowPostMessageOptions dictionary OR a legacy
// targetOrigin USVString. Per WebIDL overload resolution, `null`/`undefined`/an object at that
// position is the dictionary (targetOrigin default "/"); any other primitive is the string form.
function isPostMessageOptions(arg) { return arg == null || typeof arg === 'object'; }
// Resolve the targetOrigin from that argument.
function postMessageTargetOriginOf(arg) {
  if (isPostMessageOptions(arg)) return (arg != null && arg.targetOrigin !== undefined) ? String(arg.targetOrigin) : '/';
  return String(arg);
}
// Validate a resolved targetOrigin: `*` (any) and `/` (same origin) are special; any other value must
// parse as an absolute URL, else the call is a SyntaxError (HTML "window post message" step). The
// exception is minted in `realm` (the TARGET window for a cross-realm post — a method's exceptions
// belong to its own realm), defaulting to this realm.
function validatePostMessageTargetOrigin(arg, realm) {
  realm = realm || globalThis;
  const to = postMessageTargetOriginOf(arg);
  if (globalThis.__dom.postMessageTarget(to) === null) {
    throw new (realm.__csimDOMException || DOMException)(
      "Failed to execute 'postMessage' on 'Window': Invalid target origin '" + to + "' in a call to 'postMessage'.", 'SyntaxError');
  }
  return to;
}
// A same-realm self-post (`window.postMessage(x)` — the Window's, window.js, which converted the arguments and took
// `targetOrigin` / `transfer` out of the options): serialized (DataCloneError for what cannot be, a transferred
// MessagePort delivered in `event.ports` as its moved counterpart), then the target origin validated (SyntaxError) —
// browsers' order. The targetOrigin gates delivery exactly as it does cross-realm (__csimPostMessageRealm): sender and
// target are the SAME window here, so "*" always delivers, "/" and any explicit origin require it to equal THIS
// window's origin, else the message is silently dropped. And event.origin is this window's own origin (a same-window
// post is same-origin), never ''.
export function postMessageToSelf(message, targetOrigin, transfer) {
  // (…the target origin parsed before the message is serialized — HTML "window post message steps" 4 before 6, as a
  // frame's does: a malformed one a SyntaxError whatever the message is)
  validatePostMessageTargetOrigin(targetOrigin);
  const { data, ports } = cloneWithTransfer(message, transfer);
  const myOrigin = documentOrigin(), myKey = globalThis.__csimBcOriginKey();
  if (globalThis.__dom.postMessageReaches(postMessageTargetOriginOf(targetOrigin), myKey, myKey) !== 1) return;
  queueTask(() => {
    try {
      dispatchWithOnHandler(globalThis, createMessageEvent('message', {
        data, origin: myOrigin, source: globalThis, lastEventId: '', ports
      }));
    } catch (_) {}
  }, 0);
}

// Fire `pagehide`, its document hidden, then `unload` on THIS window — HTML "unload a document": the teardown a
// navigating or removed frame's document, or the page's, dispatches before its realm dies (dom-nodes.js
// `unloadDocumentTree`, which raises its unload counter around it). Self-gates on any handler being present, like
// beforeunload, so a handler-less teardown pays only the property reads. `pagehide.persisted` is false (no bfcache
// model). The primary consumers are `fetch(…, {keepalive})` and `sendBeacon` issued from these handlers (the
// keepalive WPT family), dispatched synchronously inside the handler, before the realm is neutered.
// (…`pagehide` and the hiding only where its page was showing — an initial about:blank, whose Window a navigation may
// keep, or a document left before its load, has its `unload` alone: HTML "unload a document" step 10, over Chrome and
// Firefox, which fire all three at an initial about:blank, measured 2026-10-31)
globalThis.__csimFireWindowUnload = function () {
  if (globalThis.__csimEndPageShowing()) {
    const pagehide = listenersOf(globalThis)?.pagehide;
    if (pagehide && pagehide.length) dispatchWithOnHandler(globalThis, new PageTransitionEvent('pagehide', { persisted: false }));
    globalThis.__csimHideDocument();
  }
  const unload = listenersOf(globalThis)?.unload;
  if (unload && unload.length) dispatchWithOnHandler(globalThis, new Event('unload'));
};

// Fire `beforeunload` on THIS window when it is being navigated away (a frame's
// document is about to be unloaded). Called by the frame-navigation / src-
// reassignment path BEFORE the realm is disposed, IN this realm (so window.event,
// the handler, and a custom toString all see this realm's globals). Gated on a
// listener being present to bound the blast radius (Turbo frame src swaps). The
// handler's value becomes the event's returnValue — coerced to a string while
// `window.event` is still the beforeunload event (the event handler processing
// algorithm, events.js; event-global-is-still-set-when-coercing-beforeunload-result).
globalThis.__csimFireBeforeUnload = function () {
  const list = listenersOf(globalThis)?.beforeunload;
  if (!list || !list.length) return;
  dispatchWithOnHandler(globalThis, createBeforeUnloadEvent('beforeunload', true));
};

// Seed a frame realm's document origin (opaque "null" / inherited parent origin)
// BEFORE its document loads, so the frame's load-time scripts read the right
// self.origin. Real-URL frames don't call this (origin = location.origin).
// (`null|<key>`: an opaque origin INHERITED — the creator's, its key with it — where a plain "null" is a new one: a
// sandboxed document's, whose sandboxing every frame it makes inherits: the engine's, realm_location.rs `frame_origins`)
globalThis.__csimSetDocumentOrigin = function (o) {
  globalThis.__dom.setDocumentOrigin(o == null ? null : String(o));
};

// Seed a frame realm's `location.origin` BEFORE its document loads. Set to the
// opaque "null" for a frame whose URL is opaque (about:blank / srcdoc /
// javascript:) — its location origin differs from the inherited document origin
// (`__csimSetDocumentOrigin`). Real-URL frames don't call this (location.origin =
// the URL's own origin). See the Location `origin` getter in location.js (`locationSteps.get_origin`).
globalThis.__csimSetLocationOrigin = function (o) {
  globalThis.__dom.setLocationOrigin(o == null ? null : String(o));
};

