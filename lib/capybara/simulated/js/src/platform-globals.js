// Closure-free Web platform stubs. Just enough surface that
// feature-detection ("typeof CSS !== 'undefined'", "performance.now",
// "navigator.crypto.randomUUID") returns truthy and modern code paths
// don't crash on a missing global.

import {
  ErrorEvent, Event, EventTarget, PageTransitionEvent, createBeforeUnloadEvent, createMessageEvent, deserializeException,
  dispatchWithOnHandler, eventState, installEventHandlerAttrs, serializeException
} from './events.js';
import { installScreenOrientation } from './generated/bindings.js';
import { transferListFrom } from './bytes.js';
import { decodeMessage, encodeMessage, messageEventType } from './workers.js';
import { cryptoKeyFromRecord, cryptoKeyRecord, installWebCrypto } from './webcrypto.js';
import { settledScrollOffsetOf } from './native-query-shadow.js';
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
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf
} from './webidl.js';
import { childNavigableContainers, scrollElement } from './dom-nodes.js';
import { documentElementOf } from './document-tree.js';
import { clearTimer, hostTask, queueTask } from './timers.js';
import { fireEvent } from './dispatch.js';
import { location } from './location.js';
import { createFileList, filesOf } from './file-list.js';
import { acceptMessage, installPorts, isMessagePort, movePort, peerOf, portDetached, postRemote } from './message-port.js';
import { ReadableStream } from './streams.js';
import { Blob, File, blobBytes, blobType, fileLastModified, fileName, isBlob, isFile } from './blob.js';
import { latin1ToBytes } from './bytes.js';

const isImageBitmap = interfaceCheck('ImageBitmap');
const isOffscreenCanvas = interfaceCheck('OffscreenCanvas');

// The display. The window starts out filling it, `resize_to` moves the window off it, and
// `maximize` / `fullscreen` restore it. Mirrored Ruby-side as `Browser::SCREEN_SIZE`
// (spec/viewport_resize_spec.rb asserts the two agree, so they can't drift apart).
const SCREEN_W = 1024;
const SCREEN_H = 768;

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
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.ScreenOrientation = ScreenOrientation;

// `screen` is the DISPLAY, not the window: it stays put while `resize_to` moves the viewport,
// exactly as a real browser's does, and it is what `maximize` / `fullscreen` resize back to.
// Libraries probe it for HiDPI / responsive decisions and we fall to the "small desktop" branch.
// (The Window's, window.js.)
export const screen = {
  width: SCREEN_W,      height: SCREEN_H,
  availWidth: SCREEN_W, availHeight: SCREEN_H,
  colorDepth: 24,         pixelDepth: 24,
  orientation: new ScreenOrientation(PLATFORM)
};

// …and the container the driver reads, whatever the page may see (a frame realm redefines it).
Object.defineProperty(globalThis, '__csimFrameContainer', { configurable: true, writable: true, value: null });

// `self.origin` / `window.origin` — the document's origin. For a normal page /
// real-URL frame it's the serialized location origin; a frame whose document
// origin differs from its location origin carries it in `__csimDocumentOrigin`
// (set at frame build): an opaque-URL frame (about:blank / srcdoc / javascript:)
// inherits its parent's origin, and a sandboxed-without-allow-same-origin frame
// is the opaque "null". Read for CORS / postMessage-target checks.
// (self-origin.sub.) The Window's (window.js) and a worker's scope's.
export function documentOrigin() {
  if (globalThis.__csimDocumentOrigin != null) return globalThis.__csimDocumentOrigin;
  try { return location.origin || ''; } catch (_) { return ''; }
}

// The origin KEY a BroadcastChannel is scoped to. For a tuple (non-opaque) origin it's the
// serialized origin string. For an OPAQUE origin (serialized as "null" — a sandboxed / data: /
// srcdoc context) every context has its OWN unique opaque origin, so a bare "null" can't be the
// key: two unrelated opaque contexts would collide and cross-talk. Mint a stable per-realm token
// instead (cached on first use) so this context's channel only reaches peers sharing its EXACT
// opaque origin — its own realm, plus any worker that INHERITED it (a blob: worker created here:
// the agent cluster). A worker is handed its key explicitly at spawn (`__csimOriginKey`), so it
// never mints one here.
globalThis.__csimBcOriginKey = function () {
  if (globalThis.__csimOriginKey != null) return globalThis.__csimOriginKey;
  const o = documentOrigin();
  if (o !== 'null') return o;
  return (globalThis.__csimOriginKey = 'opaque:realm' + globalThis.RustyRacer.contextOf(globalThis));
};
// Serialize an origin key back to what MessageEvent.origin exposes: an opaque token → "null";
// a tuple origin is itself.
export function serializeOriginKey(key) {
  return (typeof key === 'string' && key.startsWith('opaque:')) ? 'null' : (key || '');
}

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
    if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) {
      const el = childNavigableContainers()[Number(prop)];
      return el ? el.contentWindow : undefined;
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
// THE viewport — one value, owned by the driver (`Browser#set_viewport`, i.e. Capybara's
// `current_window.resize_to`), read by `innerWidth` / `innerHeight`, by the `@media` cascade and
// `matchMedia` (media-query.js `currentViewport`), and by the layout engine. Page script reaches it
// only through the Window's `[Replaceable]` attributes, so an assignment shadows the getter for that
// page without repointing layout — which is exactly what a real browser does. (The window's OUTER
// size is the same: we model no window chrome, where a real browser's is a title bar and borders
// larger.)
globalThis.__csimViewport = {width: SCREEN_W, height: SCREEN_H};

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
  get width()      { return globalThis.__csimViewport.width; },
  get height()     { return globalThis.__csimViewport.height; },
  get scale()      { return 1; },
  onresize: null,
  onscroll: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
};
// The window's scrolls (CSSOM View): its document's scrolling element's — the body in quirks mode, whose offset IS
// the viewport's there — which is what `window.scrollY` reads through: `page.execute_script("window.scrollTo(0, 0)")`
// and Discourse's logo-refresh path scroll the page so. `scroll` and `scrollTo` to a position, `scrollBy` by an offset
// — a promise of the scroll's completion. (The Window's, window.js, which converted the arguments.)
export function scrollWindow(x, y, by) {
  const doc = globalThis.document;
  const el = doc && (doc.scrollingElement || documentElementOf(doc));
  return el ? scrollElement(el, x, y, by) : resolvedPromise();
}
// This realm's own id, as the host knows it — 0 for the main realm. Every JS→host call that
// names a browsing context (port endpoints, the focus chain) identifies itself through this.
globalThis.__csimRealmId = function () {
  return globalThis.RustyRacer.contextOf(globalThis) || 0;
};
// `window.focus()` — HTML "focusing steps" applied to a BROWSING CONTEXT rather than an
// element: it moves the focus chain to this window without touching its activeElement. Only
// the host tracks which context holds focus (it is cross-realm state), so this is purely a
// report. There is no window manager to raise, so nothing else happens. (The Window's,
// window.js, whose `blur()` is the no-op it is in every modern browser: the spec says user
// agents may ignore it.)
export function focusWindow() {
  const note = globalThis.__csimNoteFocusedRealm;
  if (typeof note !== 'function') return;
  try { note(globalThis.__csimRealmId()); } catch (_) {}
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
  escape(value) {
    if (arguments.length === 0) throw new TypeError('CSS.escape requires an argument.');
    const s = String(value);
    const len = s.length;
    const first = s.charCodeAt(0);
    if (len === 1 && first === 0x002D) return '\\-';
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c === 0) { out += '�'; continue; }
      if ((c >= 0x0001 && c <= 0x001F) || c === 0x007F ||
          (i === 0 && c >= 0x0030 && c <= 0x0039) ||
          (i === 1 && c >= 0x0030 && c <= 0x0039 && first === 0x002D)) {
        out += '\\' + c.toString(16) + ' ';
        continue;
      }
      if (c >= 0x0080 || c === 0x002D || c === 0x005F ||
          (c >= 0x0030 && c <= 0x0039) ||
          (c >= 0x0041 && c <= 0x005A) ||
          (c >= 0x0061 && c <= 0x007A)) {
        out += s.charAt(i);
        continue;
      }
      out += '\\' + s.charAt(i);
    }
    return out;
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
  return new globalThis.DOMException(msg || 'An object could not be cloned.', 'DataCloneError');
}

// The structured clone in progress, or null: its transfer list (null for none), each transferable's moved counterpart,
// the steps that detach the sources once all of them are moved — and the records of the Blobs serialized so far, each
// once, so a File a FileList holds and the File itself are one object again.
let currentClone = null;

// Whether `t` is a transferable object in a usable (non-detached) state — WITHOUT neutering it: a DataCloneError
// otherwise (StructuredSerializeWithTransfer's checks, made before the value is serialized and again after, a getter
// having moved one meanwhile). Any realm's, by its brand.
function validateTransferable(t) {
  if (isArrayBuffer(t)) {
    if (t.detached) throw dataCloneError('An ArrayBuffer is detached and could not be transferred.');
    if (!globalThis.__dom.isDetachable(t)) throw dataCloneError('An ArrayBuffer that cannot be detached could not be transferred.');
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
    pull(c)    { return reader.read().then(({ done, value }) => { if (done) c.close(); else c.enqueue(value); }); },
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
    record = { __csimType: isFile(v) ? 'File' : 'Blob', type: blobType(v), bytes: latin1ToBytes(blobBytes(v)) };
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

// StructuredSerializeWithTransfer `value`: the transfer list checked (a transferable listed twice, or detached, or an
// ArrayBuffer that cannot be detached, a DataCloneError), the value serialized, the list checked again, then every
// transferable moved — the value reached it or not — and only then the sources detached. Returns what
// `deserializeWithTransfer` reads back in the realm that receives it: the serialization (the isolate's, any realm of it
// may read it), the transfer list, and each transferable but an ArrayBuffer's moved counterpart. Its SharedArrayBuffers
// shared where `mayShare` (a cross-origin isolated agent cluster's, and within the isolate), else a DataCloneError.
const NO_TRANSFER = Object.freeze([]);
export function serializeWithTransfer(value, transferList, mayShare = globalThis.crossOriginIsolated === true) {
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
    serialized = globalThis.__dom.structuredSerialize(value, serializePlatformObject, mayShare, buffers);
    const moved = new Map();
    if (transfer !== null) {
      // (…every one usable still, so none of the moves below fails: a MessagePort is neutered as it moves)
      for (const t of transfer) validateTransferable(t);
      currentClone.pendingDetach = [];
      for (const t of transferList) if (!isArrayBuffer(t)) moved.set(t, transferValue(t));
      globalThis.__dom.structuredTransfer(serialized);
      for (const detach of currentClone.pendingDetach) { try { detach(); } catch (_) {} }
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
export function cloneFor(prefix, value, options) {
  try {
    return structuredClone(value, options);
  } catch (e) {
    if (e && e.name === 'DataCloneError') throw new DOMException(prefix + e.message, 'DataCloneError');
    throw e;
  }
}

// `reportError(error)` — HTML "report the exception": fire a cancelable `error`
// ErrorEvent on the global, then, only if no listener cancelled it, log to the
// console. This is also the channel a throwing event-loop callback surfaces
// through (e.g. queueMicrotask), so it must fire the `error` event — NOT the
// promise-rejection channel — to match real-browser behavior.
let __csimReportingError = false;
export function reportError(e) {
  globalThis.__csimReportException(e, () => console.error(e && e.stack ? e.stack : String(e)));
}
globalThis.__csimReportError = reportError;
// …the same steps for the driver's own callers, which log in their own words (`log`, run only where no listener
// cancelled the event): a script the PARSER ran, whose exception reached no `window.onerror` at all before.
// An Error of ANY realm (the brand, not `instanceof`: a cross-realm callback's error is no instance of this realm's
// Error), or a DOMException of any realm (its slots: its class string is its own).
function isErrorObject(e) {
  return !!e && typeof e === 'object' && (Object.prototype.toString.call(e) === '[object Error]' || IS_DOM_EXCEPTION(e));
}
globalThis.__csimReportException = function reportException(e, log) {
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
    ev = new ErrorEvent('error', {
      cancelable: true,
      // Duck-type, not `instanceof Error`: a cross-realm Error (reported on the
      // callback's realm via `__csimReportCallbackError`) isn't an instance of
      // THIS realm's Error, but still has a string `message` to surface.
      // …as "Name: message" for an Error or a DOMException: the spec leaves the text open, and it is what Chrome
      // ("Uncaught Error: x") and Firefox ("Error: x") share — bare "x" was neither's. Anything else thrown is its
      // string (Firefox's "[object Object]" half; a `{name, message}` object is no Error).
      message:    isErrorObject(e) ? e.name + ': ' + e.message : String(e),
      error:      e,
      ...errorLocation(e)
    });
    cancelled = !fireEvent(globalThis, ev);
  } catch (_) {} finally { __csimReportingError = false; }
  if (!cancelled) {
    // (…and, in a dedicated worker, reported on at its Worker: workers.js)
    if (ev && globalThis.__csimForwardUnhandledError) globalThis.__csimForwardUnhandledError(ev);
    try { log(ev); } catch (_) {}
  }
};
// Where an exception was thrown, for its ErrorEvent: the script, line and column of its stack's top frame (V8's
// `at f (url:line:col)` / `at url:line:col`) — an inline script's the document's URL, as Chrome reports it, not the
// label the driver ran it under — none for a value with no stack.
// (…the page's frame the error was thrown in: the driver's own — the snapshot's, where a binding threw it for the
// page's call — skipped, as a browser's bindings are no frame of a stack. Code the page's document compiled — an
// inline script, an event handler content attribute, a string handed to setTimeout, `new Function`, `eval`: V8's
// `eval at …, <anonymous>:L:C` — is the document's.)
const STACK_FRAME = /^\s+at (?:.*?\()?(\S+?):(\d+):(\d+)\)?$/;
const EVAL_FRAME = /^\s+at .*\(eval at .*, <anonymous>:(\d+):(\d+)\)$/;
function errorLocation(e) {
  const stack = isErrorObject(e) && typeof e.stack === 'string' ? e.stack : '';
  for (const line of stack.split('\n')) {
    const evaluated = EVAL_FRAME.exec(line);
    if (evaluated) return { filename: location.href, lineno: Number(evaluated[1]), colno: Number(evaluated[2]) };
    const frame = STACK_FRAME.exec(line);
    if (!frame || frame[1] === '<snapshot>') continue;
    const inline = /^(?:inline:\/\/|csim-eval)/.test(frame[1]);
    return { filename: inline ? location.href : frame[1], lineno: Number(frame[2]), colno: Number(frame[3]) };
  }
  return {};
}

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
  if (!cancelled) console.error(message);
};

// The cross-realm global associated with `anchor` (its [[Realm]]), or null when
// same-realm / no realm info / no realm support. rusty_racer's
// `RustyRacer.contextOf(value)` maps ANY value (function or object) to its
// realm id; `contextGlobal(id)` is that realm's global.
//
// This is on the event-dispatch hot path on multi-realm pages (events.js calls
// it per listener), where the OVERWHELMING majority of callbacks are same-realm.
// `__csimSelfRealmId` memoizes THIS realm's own id (constant per realm) so the
// same-realm case is a single `contextOf` + integer compare — it never pays the
// second `contextGlobal` native crossing (rule 3).
let __csimSelfRealmId;
function __csimRealmGlobalOf(anchor) {
  try {
    const NS = globalThis.RustyRacer;
    if (anchor) {
      if (__csimSelfRealmId === undefined) {
        const self = NS.contextOf(globalThis);
        if (self != null) __csimSelfRealmId = self;
      }
      const id = NS.contextOf(anchor);
      if (id != null && id !== __csimSelfRealmId) {
        const g = NS.contextGlobal(id);
        if (g && g !== globalThis) return g;
      }
    }
  } catch (_) {}
  return null;
}
// Exposed so the event-dispatch path (events.js) can route the legacy
// `window.event` current-event to a cross-realm listener / on-handler's own
// global per DOM "inner invoke" (event-global-is-still-set-*).
globalThis.__csimRealmGlobalOf = __csimRealmGlobalOf;

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
// EventTarget methods (events.js) call this so add/removeEventListener/dispatch
// operate on the REAL window (listeners must live where events actually fire).
globalThis.__csimUnwrapWindow = function (o) {
  if (o && typeof o === 'object') { const raw = __winProxyRaw.get(o); if (raw) return raw; }
  return o;
};
globalThis.__csimIsWindowProxy = function (o) {
  return !!(o && typeof o === 'object' && __winProxyRaw.has(o));
};
function __csimSelfId() {
  if (__csimSelfRealmId === undefined) {
    try { __csimSelfRealmId = globalThis.RustyRacer.contextOf(globalThis); } catch (_) {}
  }
  return __csimSelfRealmId;
}
// The properties a cross-origin Window exposes (HTML "CrossOriginProperties").
// Reading anything else (most notably `document`) on a cross-origin WindowProxy
// throws a SecurityError; these stay readable so postMessage / frame-navigation /
// opener handshakes keep working across origins.
const CROSS_ORIGIN_WINDOW_PROPS = new Set([
  'window', 'self', 'location', 'close', 'closed', 'focus', 'blur',
  'frames', 'length', 'top', 'opener', 'parent', 'postMessage'
]);
function crossOriginSecurityError() {
  return new globalThis.DOMException("Blocked a frame from accessing a cross-origin frame.", 'SecurityError');
}
// The driver's own `__csim*` bookkeeping — never web-observable, so no origin gates it.
function isInternalKey(prop) {
  return typeof prop === 'string' && prop.lastIndexOf('__csim', 0) === 0 && !WINDOW_STATE_KEYS.has(prop);
}
// (…but a window's own state — its document, its name, its steps (window.js) — which is a page's to see as its members
// let it, so no more than they do cross-origin)
const WINDOW_STATE_KEYS = new Set([
  '__csimDocument', '__csimWindowSteps', '__csimWindowName', '__csimWindowStatus', '__csimOpener', '__csimCurrentEvent'
]);
// Which keys a cross-origin WindowProxy still exposes to `[[Get]]` / `[[Has]]` /
// `[[OwnPropertyKeys]]`: the CrossOriginProperties, indexed-frame keys, any Symbol
// (@@toStringTag etc.), and internal `__csim*` bookkeeping (never web-observable — the
// blob-nav snapshot walk reads it on a cross-origin parent/top). Everything else is hidden.
function crossOriginWindowAccessible(prop) {
  if (typeof prop === 'symbol') return true;
  if (typeof prop !== 'string') return false;
  return isInternalKey(prop) || /^[0-9]+$/.test(prop) || CROSS_ORIGIN_WINDOW_PROPS.has(prop);
}
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
function crossOriginLocation(rawLoc) {
  let w = __crossLocByRaw.get(rawLoc);
  if (w) return w;
  const allowed = (prop) => prop === 'href' || prop === 'replace';
  const hrefSetter = function (value) { rawLoc.href = value; };
  // (…the one allowed method, its arguments as the caller passed them: `replace()` an arity TypeError)
  const replace = function () { return rawLoc.replace(...arguments); };
  w = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(rawLoc, prop, rawLoc);   // @@toStringTag etc.
      if (isInternalKey(prop)) return Reflect.get(rawLoc, prop, rawLoc);
      if (prop === 'replace') return replace;
      throw crossOriginSecurityError();                                     // href GETTER + everything else
    },
    set(_t, prop, val) {
      if (prop === 'href') { rawLoc.href = val; return true; }   // the one allowed setter
      throw crossOriginSecurityError();
    },
    has(_t, prop)  { return allowed(prop) || typeof prop === 'symbol'; },
    ownKeys()      { return ['href', 'replace']; },
    getOwnPropertyDescriptor(_t, prop) {
      if (!allowed(prop)) return undefined;
      // (…`href` its setter alone, `replace` its function — HTML's CrossOriginGetOwnPropertyHelper)
      if (prop === 'href') return { configurable: true, enumerable: false, get: undefined, set: hrefSetter };
      return { configurable: true, enumerable: false, value: replace, writable: false };
    },
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; }
  });
  __crossLocByRaw.set(rawLoc, w);
  return w;
}
// Same-origin iff the target realm's document origin equals THIS realm's. Read the
// origin off the raw child global (not the proxy) — same serialized-compare rule as
// contentDocument's SOP: distinct opaque origins both serialize to "null", and the
// only "null" === "null" hit is a child that inherited this realm's opaque origin
// (about:blank / srcdoc under an opaque parent). Fail CLOSED (cross-origin) if the
// origin can't be read.
function isSameOriginAs(rawWindow) {
  let o, read = false;
  try { o = rawWindow.__csimOrigin(); read = true; } catch (_) {}
  return read && o === documentOrigin();
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
  const observerId = selfId, targetId = targetRealmId;
  const pmsg = function (message, targetOriginOrOptions, transfer) {
    // A bad targetOrigin is a SyntaxError thrown SYNCHRONOUSLY before the cross-realm hand-off, minted
    // in the TARGET window's realm (`raw`) — a method's exceptions belong to its own realm. Accept
    // both the WindowPostMessageOptions dictionary and the legacy (targetOrigin, transfer) form.
    validatePostMessageTargetOrigin(targetOriginOrOptions, raw);
    const to   = postMessageTargetOriginOf(targetOriginOrOptions);
    const xfer = isPostMessageOptions(targetOriginOrOptions) && targetOriginOrOptions != null
      ? targetOriginOrOptions.transfer : transfer;
    return globalThis.__csimPostMessageRealm(observerId, targetId, message, to, xfer);
  };
  // Same-origin-ness of this proxy (over a fixed target `raw`) can only change when the OBSERVER
  // realm's origin changes — and a freshly built child realm is created with an INHERITED
  // (about:blank) origin, then `__csimUpdateLocation` sets its real one AFTER its parent/top proxies
  // exist. A plain "memoize true" cache captured that transient inherited origin: a cross-origin
  // child whose parent proxy was touched pre-navigation (parent === child origin then) memoized
  // same-origin=true and never re-evaluated, leaving `parent.document` readable for the frame's life
  // (a cross-origin SOP hole). Key the cache on the observer's CURRENT origin instead: the hot
  // stable-origin path still returns the cached result (rule 3), but the first read after the origin
  // is finalized recomputes. The target's origin is stable — a target re-navigation disposes
  // its realm and evicts this proxy — so only the observer origin varies.
  let memoOrigin = null, memoResult = false;
  const sameOrigin = () => {
    const cur = documentOrigin();
    if (memoOrigin !== cur) { memoResult = isSameOriginAs(raw); memoOrigin = cur; }
    return memoResult;
  };
  // The proxy's target is no window but an object of its own, as HTML's WindowProxy is no JS Proxy of one: a window's
  // [LegacyUnforgeable] members are non-configurable, which a Proxy of it could neither hide cross-origin (`'document'
  // in frame` false) nor report configurable, as a WindowProxy does ([[GetOwnProperty]]) — the target holds only what
  // was defined non-configurable through the proxy, which its invariants then ask of it.
  const shadow = {};
  p = new Proxy(shadow, {
    get(_t, prop) {
      if (prop === '__csimRawWindow') return raw;   // unwrap hook (also used cross-realm)
      if (prop === 'postMessage') return pmsg;
      if (prop === 'window' || prop === 'self') return p;
      // Observer-relative IDENTITY for `parent` / `top`, narrowest form: when the target's own
      // parent/top IS this (observer) realm's window, hand back the raw `globalThis` so a cross-
      // origin child's `parent`, read from its actual parent, is `window` itself (event.source /
      // opener reply patterns). Any OTHER target — a different window — returns the raw resolution
      // unchanged, so internal frame/SW walks that depend on the raw parent/top chain are untouched.
      // (parent/top are CrossOriginProperties, so this bypasses nothing the SOP gate below would
      // have blocked.)
      if ((prop === 'parent' || prop === 'top') && !sameOrigin()) {
        let inner; try { inner = Reflect.get(raw, prop, raw); } catch (_) {}
        const innerRaw = (inner && inner.__csimRawWindow) || inner;
        return innerRaw === globalThis ? globalThis : inner;
      }
      // SOP: a cross-origin WindowProxy exposes only the CrossOriginProperties;
      // reading anything else (e.g. `document`) throws SecurityError. Internal
      // driver bookkeeping (`__csim*`) is never web-observable so it bypasses the
      // gate (the blob-nav snapshot walk reads it on cross-origin parent/top);
      // Symbols and numeric (indexed-frame) keys pass through too.
      if (typeof prop === 'string' && !isInternalKey(prop) &&
          !/^[0-9]+$/.test(prop) && !CROSS_ORIGIN_WINDOW_PROPS.has(prop) && !sameOrigin()) {
        throw crossOriginSecurityError();
      }
      // `location` is cross-origin-readable, but the returned Location is itself SOP-gated:
      // only its `href` setter + `replace()` work cross-origin (so `frame.location.href`
      // GETTER throws, not leaks the URL). Same-origin returns the raw Location unchanged.
      if (prop === 'location' && !sameOrigin()) {
        const loc = Reflect.get(raw, prop, raw);
        return loc ? crossOriginLocation(loc) : loc;
      }
      return Reflect.get(raw, prop, raw);   // getters/methods resolve against the real window
    },
    // (…a setter that throws throws to the assigner: `frame.contentWindow.location = 'http://foo:-80/'` is a SyntaxError
    // in the frame's realm, as `location.href = …` is). Cross-origin only `location` is settable (HTML CrossOriginSet);
    // anything else is a SecurityError, as deleting anything is ([[Delete]]).
    set(_t, prop, val) {
      if (prop !== 'location' && !isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      return Reflect.set(raw, prop, val, raw);
    },
    // `[[Has]]` / `[[OwnPropertyKeys]]` / `[[GetOwnProperty]]` are SOP-gated cross-origin so the
    // same-origin surface (`'document' in frame`, `Object.keys(frame)`, a descriptor probe) doesn't
    // leak: `in` reports absent (false); a direct descriptor probe throws SecurityError, matching
    // browsers. A descriptor reported is configurable, as a WindowProxy's is, but for what the
    // target holds.
    has(_t, prop) {
      return (sameOrigin() || crossOriginWindowAccessible(prop)) && Reflect.has(raw, prop);
    },
    deleteProperty(_t, prop) {
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      return Reflect.deleteProperty(raw, prop);
    },
    // (…and [[DefineOwnProperty]] likewise, HTML's WindowProxy: a cross-origin one defines nothing)
    defineProperty(t, prop, desc) {
      if (!isInternalKey(prop) && !sameOrigin()) throw crossOriginSecurityError();
      const defined = Reflect.defineProperty(raw, prop, desc);
      if (defined && desc.configurable === false) Reflect.defineProperty(t, prop, desc);
      return defined;
    },
    // (…cross-origin, unenumerable — HTML's CrossOriginGetOwnPropertyHelper)
    getOwnPropertyDescriptor(t, prop) {
      const same = sameOrigin();
      if (!same && !crossOriginWindowAccessible(prop)) throw crossOriginSecurityError();
      const d = Reflect.getOwnPropertyDescriptor(raw, prop);
      if (d && !d.configurable && !Reflect.getOwnPropertyDescriptor(t, prop)) d.configurable = true;
      if (d && !same && !Reflect.getOwnPropertyDescriptor(t, prop)) d.enumerable = false;
      return d;
    },
    ownKeys(t) {
      if (sameOrigin()) return Reflect.ownKeys(raw);
      return [...new Set([...Reflect.ownKeys(raw).filter((k) => crossOriginWindowAccessible(k)), ...Reflect.ownKeys(t)])];
    },
    getPrototypeOf()                  { return sameOrigin() ? Reflect.getPrototypeOf(raw) : null; },
    setPrototypeOf()                  { return false; },
    preventExtensions()               { return false; }
  });
  __winProxyByTarget.set(targetId, p);
  __winProxyRaw.set(p, raw);
  return p;
}
globalThis.__csimFrameWindowProxyFor = frameWindowProxyFor;
// Drop a disposed frame realm's cached WindowProxy (and unpin its raw global) so
// it doesn't linger after the iframe is removed — called from the realm that owns
// the iframe when it disposes the child realm. Cheap; no-op if not cached here.
globalThis.__csimEvictWindowProxy = function (targetRealmId) {
  const p = __winProxyByTarget.get(targetRealmId);
  if (p) { __winProxyByTarget.delete(targetRealmId); __winProxyRaw.delete(p); }
};
// True iff this is a multi-realm page (owns child realms, or is itself a frame) —
// the only case where cross-realm WindowProxy retargeting can apply. Lets the hot
// single-realm dispatch / composedPath paths short-circuit (rule 3). Property
// reads only (no native crossing).
globalThis.__csimMultiRealm = function () {
  return !!((globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.size) ||
            (globalThis.__csimTop && globalThis.__csimTop !== globalThis));
};
// True if `o` is a realm's global object (a Window) — used by event dispatch to
// retarget a window event-target to the observing listener's own WindowProxy.
globalThis.__csimIsWindowGlobal = function (o) {
  if (!o || typeof o !== 'object') return false;
  if (o === globalThis) return true;
  const NS = globalThis.RustyRacer;
  try { const id = NS.contextOf(o); return id != null && NS.contextGlobal(id) === o; } catch (_) { return false; }
};
// Is this realm's WHOLE window chain (self → top) free of insecure (http:)
// documents? A service worker only controls a client ALL of whose ancestors are
// secure contexts (HTML "secure context"), so a navigation initiated from — or a
// frame built under — an http document bypasses SW interception
// (secure-context.https). Walks the raw parent chain (the `__csimRawWindow`
// unwrap is SOP-exempt), so a cross-origin ancestor doesn't throw.
globalThis.__csimSecureAncestorChain = function () {
  try {
    let w = globalThis;
    for (let hops = 0; hops < 64; hops++) {
      if (((w.location && w.location.protocol) || '') === 'http:') return false;
      const p = w.parent;
      const raw = (p && p.__csimRawWindow) || p;
      if (!raw || raw === w) return true;
      w = raw;
    }
  } catch (_) {}
  return true;
};
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
  const ids = globalThis.__csimChildRealmIds;
  if (!ids || !ids.size) return undefined;
  for (const id of ids) {
    const g = globalThis.__csimRealmGlobalById(id);
    if (!g) continue;
    let r;
    try { r = cb(g); } catch (_) { r = undefined; }
    if (r !== undefined) return r;
  }
  return undefined;
};
// The realm of the event listener currently running, recorded by the dispatch
// paths so `composedPath()` (which runs in the EVENT's realm) can present the
// window entry as the LISTENER realm's WindowProxy. Slot lives on the shared main
// global (reachable cross-realm via `top`).
globalThis.__csimSetActiveListenerRealm = function (handler) {
  const root = globalThis.__csimTop || globalThis;
  let id;
  if (handler != null) { try { id = globalThis.RustyRacer.contextOf(handler); } catch (_) {} }
  try { root.__csimActiveListenerRealmId = id; } catch (_) {}
  return id;
};
globalThis.__csimGetActiveListenerRealm = function () {
  const root = globalThis.__csimTop || globalThis;
  try { return root.__csimActiveListenerRealmId; } catch (_) { return undefined; }
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
// Deliver a cross-realm same-page postMessage. Called (in the SENDER realm) by a
// WindowProxy's postMessage; routes into the TARGET realm so the payload is cloned
// there and the message task queued there with `event.source` = the target's own
// proxy for the sender.
// Parse the origin of a postMessage targetOrigin argument (an absolute URL or a
// bare origin); '' if unparseable.
function originOfTarget(s) {
  try { return new globalThis.URL(String(s)).origin; } catch (_) { return ''; }
}
function realmOrigin(realmId) {
  try { const g = globalThis.__csimRealmGlobalById(realmId); return g ? g.__csimOrigin() : ''; } catch (_) { return ''; }
}
globalThis.__csimPostMessageRealm = function (senderId, targetId, message, targetOrigin, transfer) {
  const g = globalThis.__csimRealmGlobalById(targetId);
  const D = (g && g.DOMException) || globalThis.DOMException;
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
  // HTML "window post message": the targetOrigin gates delivery. "*" always
  // delivers; "/" requires the target be same-origin as the SENDER; any other
  // value must equal the TARGET's origin or the message is silently dropped.
  const to = targetOrigin == null ? '*' : String(targetOrigin);
  const senderOrigin = realmOrigin(senderId);
  if (to !== '*') {
    let targetOrig = ''; try { targetOrig = g.__csimOrigin(); } catch (_) {}
    const wanted = to === '/' ? senderOrigin : originOfTarget(to);
    if (targetOrig !== wanted) return discardSerialization(serialized);
  }
  // event.origin in the receiver is the SENDER's origin (not '').
  try {
    g.__csimDeliverFrameMessage(senderId, serialized, senderOrigin);
  } catch (e) {
    discardSerialization(serialized);
    throw e;
  }
};
// Runs in the TARGET realm: StructuredDeserializeWithTransfer the message the sender serialized — its values made this
// realm's, each MessagePort it transferred moved onto a port of this realm (`movePort`), whose messages are this realm's
// tasks and events, and every other transferable made this realm's (`receiveTransferred`) — and queue the `message`
// event task, its source this realm's proxy for the sender.
globalThis.__csimDeliverFrameMessage = function (senderId, serialized, senderOrigin) {
  for (const [t, moved] of serialized.moved) serialized.moved.set(t, receiveTransferred(moved));
  const { data, ports } = deserializeWithTransfer(serialized);
  setTimeout(() => {
    let source = null;
    try { source = frameWindowProxyFor(senderId); } catch (_) {}
    try {
      dispatchWithOnHandler(globalThis, createMessageEvent('message', {
        data, origin: senderOrigin || '', source, lastEventId: '', ports
      }));
    } catch (_) {}
  }, 0);
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
// that realm's OWN `reportError` (so its ErrorEvent + window.onerror run in the
// right global). Same-realm / no realm support → the local `reportError`.
globalThis.__csimReportCallbackError = function (cb, e) {
  const g = (typeof cb === 'function') ? __csimRealmGlobalOf(cb) : null;
  if (g && typeof g.reportError === 'function') {
    try { g.reportError(e); return; } catch (_) {}
  }
  reportError(e);
};

// "Report the exception" for an EVENT LISTENER invocation that failed — a
// missing/non-callable `handleEvent` or a throw from the call. Like
// __csimReportCallbackError, but ALSO re-creates the error in the listener
// realm so `error.constructor === otherRealm.TypeError` holds. `anchor` is the
// listener object/function (the callback realm), distinct from the thrown
// error's realm (e.g. a same-realm revoked Proxy used as a cross-realm
// listener's handleEvent). Same-realm → identical to reportError.
globalThis.__csimReportListenerError = function (anchor, e) {
  const g = __csimRealmGlobalOf(anchor);
  if (g && typeof g.reportError === 'function') {
    try { g.reportError(__csimRealmizeError(g, e)); return; } catch (_) {}
  }
  reportError(e);
};

// Realm-correct an exception that PROPAGATES to the caller rather than being
// reported — a NodeFilter `acceptNode` failure in TreeWalker / NodeIterator,
// where `assert_throws_js(otherRealm.TypeError, …)` checks the thrown error's
// realm. Returns the error re-created in `anchor`'s realm (or `e` unchanged
// same-realm). The caller throws the result.
globalThis.__csimRealmizeCallbackError = function (anchor, e) {
  return __csimRealmizeError(__csimRealmGlobalOf(anchor), e);
};

// Whether the window's browsing context is discarded — a removed frame's (`__csimNeuterDetachedWindow` marks it),
// which `window.closed` reads (window.js) through a reference captured before the removal.
// (…defined, false, from the start: every `defaultView` read asks it, and a miss on the global is a slow lookup)
Object.defineProperty(globalThis, '__csimBrowsingContextDiscarded', { value: false, writable: true, configurable: true, enumerable: false });

// Is `cb` still "runnable" — i.e. does it belong to a browsing context that
// hasn't been destroyed? A callback whose realm is a DISPOSED child frame realm
// (the frame was removed from the document) is no longer runnable, and per HTML
// "invoke a callback function" the caller throws instead of calling it (e.g.
// NodeIterator/TreeWalker filtering after `iframe.remove()`). Returns true for a
// same-realm callback or an object-shaped callback with no realm — only a callback
// of a realm in no live browsing-context tree (no realm's `__csimChildRealmIds`) is dead.
// (dom/traversal/TreeWalker-acceptNode-filter-cross-realm-null-browsing-context.html)
globalThis.__csimCallbackRunnable = function (cb) {
  try {
    const NS = globalThis.RustyRacer;
    if (!cb) return true;
    const id = NS.contextOf(cb);
    if (id == null) return true;
    if (id === NS.contextOf(globalThis)) return true;  // this realm
    if (globalThis.__csimChildRealmIds && globalThis.__csimChildRealmIds.has(id)) return true;
    // …or any realm of the live browsing-context tree — a parent's filter handed to a frame's document — found from the
    // page's realm (context 0) down: a removed frame's realm is in no realm's child set any more
    if (id === 0) return true;
    const queue = [0];
    while (queue.length) {
      const kids = NS.contextGlobal(queue.pop()).__csimChildRealmIds;
      if (!kids) continue;
      if (kids.has(id)) return true;
      kids.forEach((kid) => queue.push(kid));
    }
    return false;
  } catch (_) { return true; }
};

// `requestIdleCallback` / `cancelIdleCallback` — fall back to
// `setTimeout(0)` so libraries that defer expensive setup to idle
// (Turbo Drive prefetch, Stimulus debounced renders) make progress.
// Their identifiers are their own (HTML: the window's idle callback identifier), each naming the task it queued: a
// page's `clearTimeout` reaches no idle callback, nor `cancelIdleCallback` a timer (Chrome: both counts start at 1).
// (The Window's, window.js.)
const idleCallbacks = new Map();
let idleCallbackId = 0;
export function requestIdleCallback(cb) {
  const id = ++idleCallbackId;
  idleCallbacks.set(id, queueTask(() => {
    idleCallbacks.delete(id);
    cb({ didTimeout: false, timeRemaining: () => 0 });
  }));
  return id;
}
export function cancelIdleCallback(id) {
  const task = idleCallbacks.get(id);
  if (task === undefined) return;
  idleCallbacks.delete(id);
  clearTimer(task);
}

// A MessagePort's message (HTML §9.4.4 "message port post message steps"): StructuredSerializeWithTransfer at post
// time — an uncloneable message (a DOM node, the global, a function, a non-transferred transferable) throws
// DataCloneError synchronously, each listed transferable is MOVED (a port onto a fresh entangled one delivered in
// `ports`, an ArrayBuffer detached) — and the peer receives a distinct clone. The port it is posted through is no
// transferable of its own message. A remote port's goes serialized through the host to the other end of its channel.
// LIMITATION: a `port.postMessage` clones its payload in the SENDER's realm and the peer dispatches it as it is, so across
// realms `event.data` is a foreign-realm object graph — fine for plain/JSON payloads (property reads + @@toStringTag
// brand checks work), off for receiver-realm `instanceof Object` identity. (A frame's postMessage reads its message back
// in the receiving realm: __csimDeliverFrameMessage.)
function postPortMessage(port, message, transfer) {
  const tf = transferListFrom(transfer);
  if (tf.indexOf(port) !== -1) throw dataCloneError('The source port could not be transferred.');
  if (postRemote(port, message, tf)) return;
  const { data, ports } = cloneWithTransfer(message, tf);
  const peer = peerOf(port);
  if (peer) acceptMessage(peer, data, ports);
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


// ── Cross-window remote-ref proxy (SOURCE side) ────────────────────────────
// Wraps a ref id from another window's VM (a DOM node, a non-node object, or the
// window itself = id 0) in a Proxy that forwards every get/set/method-call across
// the host boundary (__csimWindowRef{Get,Set,Call}). Returned nodes/objects come
// back as `{__csimRef:id}` markers and are wrapped into further proxies; a
// returned function comes back as `{__csimRefFn:true}` and is exposed as a local
// function that re-invokes it as a method call on the owning ref.
//
// Scope is single-hop scripting (the patterns real cross-window tests/apps use:
// read/write a property, call a method, chain through returned nodes/objects).
// Deliberately NOT modelled — each only matters for exotic cross-window use no
// test/app exercises, and each needs a heavier mechanism:
//   - passing a source FUNCTION as an argument (callbacks can't cross isolates);
//   - passing a ref-proxy owned by window A into a method on window B (the id is
//     resolved in B's registry — node identity is per-window);
//   - iterating a returned collection (Symbol.iterator isn't forwarded);
//   - a method whose RETURN value is itself a function.
// The target-side object registry (host-queries) holds non-node objects for the
// window's VM lifetime (dropped when the window/VM is disposed).
const __csimRefProxies = new Map();   // `${winHandle}:${id}` -> proxy
function csimWrapRef(winHandle, v) {
  return (v && typeof v === 'object' && v.__csimRef != null)
    ? csimRemoteRefProxy(winHandle, v.__csimRef) : v;
}
function csimPackArg(a) {
  // A ref-proxy passed back as an argument round-trips by its id.
  return (a && typeof a === 'object' && a.__csimRefId != null) ? { __csimRef: a.__csimRefId } : a;
}
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
        return (...args) => csimWrapRef(winHandle, globalThis.__csimWindowRefCall(winHandle, id, String(prop), args.map(csimPackArg)));
      }
      return csimWrapRef(winHandle, v);
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return true;
      globalThis.__csimWindowRefSet(winHandle, id, String(prop), csimPackArg(value));
      return true;
    }
  });
  __csimRefProxies.set(key, p);
  return p;
}

function csimWindowProxy(handle) {
  if (handle == null || handle === '') return null;
  let proxy = __csimWindowProxies.get(handle);
  if (proxy) return proxy;
  // `location.href`/`assign`/`replace` take a USVString (unpaired surrogates →
  // U+FFFD before navigation). The getter serializes the stored URL (idempotent
  // for well-formed URLs) so a U+FFFD reads back percent-encoded as %EF%BF%BD;
  // `hash` is the serialized URL's fragment.
  const usv = (v) => globalThis.__csimToUSVString ? globalThis.__csimToUSVString(v) : String(v);
  // Fire the aux window's OWN `load` on the next task (deferred, like window.open)
  // so the newly-loaded child's `window.onload` runs AFTER the opener's current
  // task — e.g. the loadResolver-reports-back form-restore pattern. Deferring
  // also sidesteps cross-VM re-entrancy: the child's `window.opener.foo()` runs
  // when the opener's VM is idle (next task), not while it is blocked in the
  // host call that triggered the navigation.
  const fireAuxLoadSoon = () => {
    setTimeout(() => { try { if (typeof globalThis.__csimFireAuxWindowLoad === 'function') globalThis.__csimFireAuxWindowLoad(handle); } catch (_) {} }, 0);
  };
  // Navigate the aux window, then fire its load deferred.
  const navAux = (v) => {
    globalThis.__csimWindowSetLocation(handle, usv(v));
    fireAuxLoadSoon();
  };
  // `w.history.back()/forward()/go(n)` from the opener. The traversal runs in the
  // (non-active) target window eagerly; a CROSS-document traversal loads a
  // different document, so fire its deferred `load` like navAux. A same-document
  // (pushState) traversal fires popstate in the target and needs no load.
  const histGo = (delta) => {
    const crossDoc = (typeof globalThis.__csimWindowHistoryGo === 'function')
      ? globalThis.__csimWindowHistoryGo(handle, delta) : false;
    if (crossDoc) fireAuxLoadSoon();
  };
  let historyProxy;   // memoized so `w.history` keeps a stable identity
  const serializedHref = () => {
    const h = globalThis.__csimWindowLocation(handle);
    try { const u = globalThis.__csim_parseUrl(h); return (u && !u.error && u.href) ? u.href : h; }
    catch (_) { return h; }
  };
  const location = {
    get href()   { return serializedHref(); },
    set href(v)  { navAux(v); },
    assign(v)    { navAux(v); },
    replace(v)   { navAux(v); },
    get hash()   { const h = serializedHref(); const i = h.indexOf('#'); return i >= 0 ? h.slice(i) : ''; },
    toString()   { return serializedHref(); }
  };
  const loadListeners = [];
  const base = {
    get closed() { return !!globalThis.__csimWindowClosed(handle); },
    close()      { globalThis.__csimWindowClose(handle); },
    focus()      {},
    blur()       {},
    onload:      null,
    onmessage:   null,
    // Cross-window postMessage: another window is another isolate, so the message crosses as a worker's does
    // (workers.js `encodeMessage`) — serialized here, a DataCloneError the caller's, its transfer list moved.
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
      else if (to !== '*') to = originOfTarget(to);
      globalThis.__csimWindowPostMessage(handle, encodeMessage(data, transfer), to, sender);
    },
    addEventListener(type, fn)    { if (type === 'load' && typeof fn === 'function') loadListeners.push(fn); },
    removeEventListener(type, fn) { if (type === 'load') { const i = loadListeners.indexOf(fn); if (i >= 0) loadListeners.splice(i, 1); } },
    // Fire the aux window's `load` at the opener — scheduled by `open()` once the
    // aux document has loaded, on a task so an `onload` set right after window.open
    // still catches it.
    // (…an Event, trusted, at the proxy — at its target while the handlers registered here, this realm's, run)
    __csimFireLoad() {
      const ev = new Event('load');
      eventState(ev).isTrusted = true;
      eventState(ev).target = eventState(ev).currentTarget = proxy;
      eventState(ev).eventPhase = 2;
      if (typeof base.onload === 'function') { try { base.onload(ev); } catch (_) {} }
      for (const fn of loadListeners.slice()) { try { fn(ev); } catch (_) {} }
      eventState(ev).eventPhase = 0;
      eventState(ev).currentTarget = null;
    },
    get location() { return location; },
    set location(v) { location.href = v; },
    // `w.history` — back/forward/go traverse the target window and fire its
    // deferred `load` (cross-document) via histGo; every other member (length,
    // state, scrollRestoration, push/replaceState) forwards to the target
    // window's real History through the remote-ref RPC.
    get history() {
      return historyProxy || (historyProxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'back')    return () => histGo(-1);
          if (prop === 'forward') return () => histGo(1);
          if (prop === 'go')      return (d) => histGo(d == null ? 0 : (Math.trunc(Number(d)) || 0));
          // length / state / scrollRestoration / push/replaceState — re-resolve the
          // aux history ref per access: its remote-ref id is invalidated when the
          // aux navigates (VM rebuild); the traversal methods above don't need it.
          const ref = csimWrapRef(handle, globalThis.__csimWindowRefGet(handle, 0, 'history'));
          return ref ? ref[prop] : undefined;
        }
      }));
    },
    // `win.document` (and any other cross-window object: navigator, history, a
    // queried node, …) resolves through the remote-ref RPC with the target window
    // as ref id 0 — so `win.document.querySelector('input').value = x` and
    // `win.navigator.userActivation.isActive` forward into the aux window's VM.
    get document() { return csimWrapRef(handle, globalThis.__csimWindowRefGet(handle, 0, 'document')); },
    get __csimWindowHandle() { return handle; }
  };
  // A Proxy so an arbitrary cross-window property read (`win.test_result`) is
  // forwarded to the aux window's VM; known members (close / postMessage / onload
  // / location / document / …) resolve locally.
  proxy = new Proxy(base, {
    get(t, prop, _recv) {
      if (prop === 'window' || prop === 'self') return proxy;
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const v = globalThis.__csimWindowRefGet(handle, 0, String(prop));
      if (v && typeof v === 'object' && v.__csimRefFn) {
        return (...args) => csimWrapRef(handle, globalThis.__csimWindowRefCall(handle, 0, String(prop), args.map(csimPackArg)));
      }
      return csimWrapRef(handle, v);
    },
    // Known members (getter-only closed/document/window/self, settable onload/…)
    // resolve locally; any other assignment forwards into the target window's VM.
    set(t, prop, v) {
      if (prop in t) { try { t[prop] = v; } catch (_) {} return true; }
      if (typeof prop !== 'symbol') globalThis.__csimWindowRefSet(handle, 0, String(prop), csimPackArg(v));
      return true;
    }
  });
  __csimWindowProxies.set(handle, proxy);
  return proxy;
}

// Read a PRIMITIVE property off THIS window's globalThis (onDoc false) or its
// document (onDoc true) — the Driver calls it on an aux Browser's VM to serve a
// cross-window proxy read (`win.test_result` / `win.document.charset`). Only
// primitives cross the host boundary; objects/functions → null.
globalThis.__csimReadWindowProp = function (onDoc, prop) {
  try {
    const obj = onDoc ? globalThis.document : globalThis;
    if (!obj) return null;
    const v = obj[prop];
    const t = typeof v;
    return (t === 'string' || t === 'number' || t === 'boolean') ? v : null;
  } catch (_) { return null; }
};

// Consume transient user activation — opening a new top-level browsing context
// (window.open / a `<form target=_blank>` submit) consumes it per HTML. Called
// from the Ruby form-submit path when it opens an aux window.
globalThis.__csimConsumeTransientActivation = function () {
  globalThis.__csimTransientActivation = false;
};

// `window.open(url, name, features)` opens (or, by name, reuses) a real
// auxiliary window via the Driver and returns a proxy for it (null if the
// host can't open one, e.g. no Driver).
// (The Window's, window.js, which converted its arguments: `url` a USVString, `name` the target, '_blank' unsaid.)
export function openWindow(u, name) {
  // Spec: a NON-empty url is parsed against the document base; a parse FAILURE
  // throws a SyntaxError DOMException synchronously — before the host
  // open_aux_window path (which would otherwise drain on a malformed URL).
  // An empty url opens about:blank (no parse).
  if (u !== '') {
    const base = location.href || undefined;
    if (globalThis.__csim_urlIsMalformed(u, base)) {
      throw new globalThis.DOMException(
        "Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '" + u + "'.", 'SyntaxError');
    }
  }
  // Target '_self' targets THIS browsing context (HTML window-open steps via
  // "the rules for choosing a navigable"; keyword match is ASCII
  // case-insensitive): navigate self and return the window's own proxy — no
  // new window. This is also where the 3-argument
  // `document.open(url, name, features)` overload lands.
  if (name.toLowerCase() === '_self') {
    if (u !== '') {
      // (…a `javascript:` URL run in THIS global, the location.href setter's navigation any other)
      if (!globalThis.__csimNavigateJavascriptURL(u, location.href)) location.href = u;
    }
    return globalThis;
  }
  const fn = globalThis.__csimWindowOpen;
  if (typeof fn !== 'function') return null;
  // Pass the OPENER's realm id so a same-isolate window realm can wire window.opener
  // to a WindowProxy for it (0 = the main realm, a valid opener — distinct from "no
  // opener").
  const callerRealmId = globalThis.RustyRacer.contextOf(globalThis);
  // An about:blank popup's URL is opaque, but its ORIGIN and its BASE URL — what its relative
  // URLs resolve against — are both INHERITED from this document, exactly as an empty
  // <iframe>'s are. Hand them over so the new realm can be seeded with them; without the
  // origin the popup would be cross-origin to its own opener.
  let aboutBase = '', aboutOrigin = '';
  try { aboutBase = (globalThis.document && globalThis.document.baseURI) || ''; } catch (_) {}
  // (…the document's, not `origin`, which a page may have replaced)
  aboutOrigin = documentOrigin();
  // (…`_blank` no name: a new window, never one the host finds by name)
  const handle = fn(u, name.toLowerCase() === '_blank' ? '' : name, callerRealmId, aboutBase, aboutOrigin);
  if (!handle) return null;
  // A NUMERIC handle is a same-origin window realm in this isolate → a native
  // WindowProxy (like iframe.contentWindow): `popup.document` is a real
  // same-isolate Document. A STRING handle is a separate-isolate aux window →
  // the cross-isolate RPC proxy.
  const proxy = (typeof handle === 'number' && typeof globalThis.__csimFrameWindowProxyFor === 'function')
    ? globalThis.__csimFrameWindowProxyFor(handle)
    : csimWindowProxy(handle);
  if (!proxy) return null;
  // The aux document loads during the host open() call (synchronously). Fire the
  // load events on the NEXT task so an `onload` assigned right after window.open()
  // (here AND in the child, which reports back via `window.opener`) is registered
  // first (url-charset / url-in-tags-revoke; the form-restore loadResolver pattern):
  //   - the aux window's OWN `load` (in its VM, so the child's window.onload runs),
  //   - then the proxy's `load` at this opener (the `w.onload` the opener set).
  if (u !== '' && proxy && typeof proxy.__csimFireLoad === 'function') {
    setTimeout(() => {
      try { if (typeof globalThis.__csimFireAuxWindowLoad === 'function') globalThis.__csimFireAuxWindowLoad(handle); } catch (_) {}
      try { proxy.__csimFireLoad(); } catch (_) {}
    }, 0);
  }
  return proxy;
}

// `window.opener` — the window that opened this one (or null), resolved from the host each read (window.js keeps
// what a page or the driver sets instead).
export function hostOpener() {
  const fn = globalThis.__csimWindowOpener;
  const handle = typeof fn === 'function' ? fn() : null;
  return handle ? csimWindowProxy(handle) : null;
}

// Deliver cross-window postMessage payloads the host queued for THIS window:
// fire a `message` event carrying `.data` / `.origin` / `.source` (a proxy for
// the sender). Called from Ruby's settle/tick drain.
globalThis.__csim_deliverWindowMessages = hostTask(function (events) {
  if (!events || !events.length) return;
  for (const ev of events) {
    // targetOrigin gate, evaluated HERE because only the target VM knows its own
    // current origin: '*' delivers to anyone; anything else must match this
    // window's origin or the message is silently dropped (HTML "window post
    // message" step 7.2). A '/' was already resolved to the sender's origin on
    // the sending side. Legacy inbox entries without the field deliver.
    const to = ev && ev.targetOrigin;
    if (to && to !== '*' && to !== documentOrigin()) continue;
    const source = ev && ev.sourceHandle ? csimWindowProxy(ev.sourceHandle) : null;
    const m = decodeMessage(ev.data);
    dispatchWithOnHandler(globalThis, createMessageEvent(messageEventType(m), {
      data:        m.data,
      origin:      (ev && ev.origin) || '',
      source:      source,
      lastEventId: '',
      ports:       m.ports
    }));
  }
});

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
  if (to !== '*' && to !== '/') {
    let ok = false;
    try { new (realm.URL || globalThis.URL)(to); ok = true; } catch (_) {}
    if (!ok) throw new (realm.DOMException || globalThis.DOMException)(
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
  const { data, ports } = cloneWithTransfer(message, transfer);
  validatePostMessageTargetOrigin(targetOrigin);
  const myOrigin = documentOrigin();
  const to = postMessageTargetOriginOf(targetOrigin);
  if (to !== '*' && myOrigin !== (to === '/' ? myOrigin : originOfTarget(to))) return;
  queueTask(() => {
    try {
      dispatchWithOnHandler(globalThis, createMessageEvent('message', {
        data, origin: myOrigin, source: globalThis, lastEventId: '', ports
      }));
    } catch (_) {}
  }, 0);
}

// Fire `pagehide` then `unload` on THIS window — the document-teardown pair a
// navigating/removed frame dispatches before its realm dies (HTML "unload a
// document"). Self-gates on any handler being present, like beforeunload, so a
// handler-less teardown pays only the property reads. `pagehide.persisted` is
// false (no bfcache model). The primary consumer is `fetch(…, {keepalive})`
// issued from these handlers (the keepalive WPT family) — the eager keepalive
// dispatch runs synchronously inside the handler, before the realm is neutered.
globalThis.__csimFireWindowUnload = function () {
  for (const type of ['pagehide', 'unload']) {
    const list = globalThis._listeners && globalThis._listeners[type];
    if (!list || !list.length) continue;
    dispatchWithOnHandler(globalThis, type === 'pagehide' ? new PageTransitionEvent(type, { persisted: false }) : new Event(type));
  }
};

// The whole-tree variant: this window's teardown pair, then every descendant
// frame realm's, parent-first (the order Chrome fires them on window close /
// removal). Driven by the host when an aux window is closed — its nested
// iframes' unload handlers (a keepalive beacon, redirect-keepalive's
// "[new window][unload]" family) must run before the VM is disposed.
globalThis.__csimFireWindowUnloadDeep = function () {
  try { globalThis.__csimFireWindowUnload(); } catch (_) {}
  const NS   = globalThis.RustyRacer;
  const kids = globalThis.__csimChildRealmIds;
  if (!kids) return;
  Array.from(kids).forEach((id) => {
    try {
      const w = NS.contextGlobal(id);
      if (w && typeof w.__csimFireWindowUnloadDeep === 'function') w.__csimFireWindowUnloadDeep();
    } catch (_) {}
  });
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
  const list = globalThis._listeners && globalThis._listeners.beforeunload;
  if (!list || !list.length) return;
  dispatchWithOnHandler(globalThis, createBeforeUnloadEvent('beforeunload', true));
};

// Seed a frame realm's document origin (opaque "null" / inherited parent origin)
// BEFORE its document loads, so the frame's load-time scripts read the right
// self.origin. Real-URL frames don't call this (origin = location.origin).
globalThis.__csimSetDocumentOrigin = function (o) {
  try { globalThis.__csimDocumentOrigin = (o == null ? null : String(o)); } catch (_) {}
};

// Seed a frame realm's `location.origin` BEFORE its document loads. Set to the
// opaque "null" for a frame whose URL is opaque (about:blank / srcdoc /
// javascript:) — its location origin differs from the inherited document origin
// (`__csimSetDocumentOrigin`). Real-URL frames don't call this (location.origin =
// the URL's own origin). See the Location `origin` getter in location.js (`locationSteps.get_origin`).
globalThis.__csimSetLocationOrigin = function (o) {
  try { globalThis.__csimLocationOriginOverride = (o == null ? null : String(o)); } catch (_) {}
};

// (…the ordinary prototype-chain test, not a `Symbol.hasInstance` a page may have put on a class)
const hasInstance = Function.prototype[Symbol.hasInstance];
// URLPattern (the URL Pattern standard) — backed by the reference polyfill in
// the vendor bundle (urlpattern-polyfill; pure subpath import, the bridge owns
// the exposure). Exposed on Window AND worker scopes per the IDL. First
// consumer: the ServiceWorker Static Routing API's `urlPattern` conditions.
{
  const VP = globalThis.__csimVendor && globalThis.__csimVendor.URLPattern;
  if (VP && !globalThis.URLPattern) globalThis.URLPattern = VP;
  // (…the class of the realm's polyfill, which tells its objects apart for an IDL conversion to one: a RouterCondition's
  // urlPattern)
  if (VP) registerInterface('URLPattern', (o) => hasInstance.call(VP, o));
}
