// The structured clone's bindings. StructuredSerializeWithTransfer and StructuredDeserializeWithTransfer are the
// engine's (clone.rs): V8's serializer writes the JavaScript values, and the transfer list is checked and moved there.
// What is the bindings' is each platform object's own steps, which the engine calls (`hostSteps`): its serialization
// steps — what a [Serializable] object is as plain data, a DataCloneError for one that is not — and its deserialization
// steps; and a [Transferable] object's checks, its transfer steps and its transfer-receiving steps, and the form it
// crosses to another isolate in.

import { createFileList, filesOf } from './file-list.js';
import { Blob, File, blobByteArray, blobType, fileLastModified, fileName, isBlob, isFile } from './blob.js';
import { DOMException, deserializeException, serializeException } from './dom-exception.js';
import { geometryFromRecord, geometryRecord } from './geometry.js';
import { cryptoKeyFromRecord, cryptoKeyRecord } from './webcrypto.js';
import {
  checkImageBitmapClone, checkOffscreenCanvasTransfer, cloneImageBitmap, closeImageBitmap, detachOffscreenCanvas,
  transferredOffscreenCanvas
} from './canvas.js';
import { closePort, isMessagePort, movePort, portDetached } from './message-port.js';
import { ReadableStream } from './streams.js';
import { Stamp, hasSlots, interfaceCheck, promiseThen } from './webidl.js';
import { dom, hostSteps, listFrom, NO_ARGUMENTS, realmHooks } from './engine.js';
import {
  InternalSet, objectAssign, objectGetOwnPropertyDescriptor, objectToString, reflectApply, reflectGetOwnPropertyDescriptor, stringSlice
} from './intrinsics.js';

// What a serialization is for (clone.rs `Mode`): a value read back within its agent, a message to another agent (a
// worker's or another window's isolate), or StructuredSerializeForStorage.
export const WITHIN_AGENT = 0, ACROSS_AGENTS = 1, FOR_STORAGE = 2;
const NO_TRANSFER = Object.freeze([]);

const IS_EVENT_TARGET    = interfaceCheck('EventTarget');
const IS_EVENT           = interfaceCheck('Event');
const IS_DOM_EXCEPTION   = interfaceCheck('DOMException');
const IS_READABLE_STREAM = interfaceCheck('ReadableStream');
const isImageBitmap      = interfaceCheck('ImageBitmap');
const isOffscreenCanvas  = interfaceCheck('OffscreenCanvas');
// (…and the polyfill's own members a transfer reads, not ones a page may replace)
const streamLocked = (t) => reflectApply(objectGetOwnPropertyDescriptor(ReadableStream.prototype, 'locked').get, t, NO_ARGUMENTS);
const streamReader = (t) => reflectApply(ReadableStream.prototype.getReader, t, NO_ARGUMENTS);
const dataCloneError = (message) => new DOMException(message, 'DataCloneError');
// (…an exception's stack as its own: V8's own `stack` getter's answer, or a string it holds — nothing of a page's run)
const STACK_GETTER = reflectGetOwnPropertyDescriptor(new Error(), 'stack')?.get;
function ownStack(e) {
  const own = reflectGetOwnPropertyDescriptor(e, 'stack');
  if (own === undefined) return undefined;
  const stack = own.get !== undefined && own.get === STACK_GETTER ? reflectApply(STACK_GETTER, e, NO_ARGUMENTS) : own.value;
  return typeof stack === 'string' ? stack : undefined;
}

// ── The serialization steps ──────────────────────────────────────────────────────────────────────────────────────────
// What a platform object of any realm serializes to, as plain data the engine writes in its place — a record told by its
// `__csimType`: a Blob's or a File's bytes and attributes, a FileList's files (each written in its own place, so a File
// the value holds besides is one object read back), a DOMException's name, message and stack, a geometry object's
// numbers, an ImageData's or an ImageBitmap's pixels, a CryptoKey's slots. Undefined for an object that is no platform
// object (a page's class instance, another realm's ordinary object: the engine writes those), and a DataCloneError for
// one no structured clone takes: an EventTarget, an Event, a Range, any other the bindings made — whose state is no
// [Serializable] interface's — and a ReadableStream not being transferred.
hostSteps.cloneDescribe = function (v) {
  if (isBlob(v)) {
    const record = { __csimType: isFile(v) ? 'File' : 'Blob', type: blobType(v), bytes: blobByteArray(v) };
    return isFile(v) ? objectAssign(record, { name: fileName(v), lastModified: fileLastModified(v) }) : record;
  }
  const files = filesOf(v);
  if (files !== undefined) return { __csimType: 'FileList', files: listFrom(files) };
  if (IS_DOM_EXCEPTION(v)) return { __csimType: 'DOMException', ...serializeException(v), stack: ownStack(v) };
  if (hasSlots(v)) {
    const record = geometryRecord(v) ?? realmHooks.canvasSerialization.record(v) ?? cryptoKeyRecord(v);
    if (record !== undefined) return record;
  }
  if (IS_EVENT_TARGET(v) || IS_EVENT(v) || hasSlots(v) || dom.isRange(v)) {
    throw dataCloneError(`${stringSlice(reflectApply(objectToString, v, NO_ARGUMENTS), 8, -1)} object could not be cloned.`);
  }
  if (IS_READABLE_STREAM(v)) throw dataCloneError('A ReadableStream could not be cloned because it was not transferred.');
  return undefined;
};
// …and the deserialization steps: the platform object of this realm a record makes, its files made already.
hostSteps.cloneMake = function (r) {
  switch (r.__csimType) {
    case 'Blob': return new Blob([r.bytes], { type: r.type });
    case 'File': return new File([r.bytes], r.name, { type: r.type, lastModified: r.lastModified });
    case 'FileList': return createFileList(listFrom(r.files));
    case 'DOMException': {
      const e = deserializeException(r);
      if (typeof r.stack === 'string') { try { e.stack = r.stack; } catch (_) {} }
      return e;
    }
    case 'Geometry': return geometryFromRecord(r);
    case 'CryptoKey': return cryptoKeyFromRecord(r);
    default: return realmHooks.canvasSerialization.fromRecord(r);
  }
};

// ── The transfer steps ───────────────────────────────────────────────────────────────────────────────────────────────
// Whether `t`, a transferable of the bindings' of any realm, is one in a usable (non-detached) state — PORT for a
// MessagePort, which a message event lists, OTHER for another — a DataCloneError otherwise (an ArrayBuffer is the
// engine's own): StructuredSerializeWithTransfer's checks, before the value is serialized and again after, a getter
// having moved one meanwhile. A ReadableStream crosses to no other agent here.
const PORT = 1, OTHER = 2;
hostSteps.transferCheck = function (t, across) {
  if (isMessagePort(t)) {
    if (portDetached(t)) throw dataCloneError('A detached MessagePort could not be transferred.');
    return PORT;
  }
  if (isImageBitmap(t)) {
    checkImageBitmapClone(t, 'transferred');
    return OTHER;
  }
  if (isOffscreenCanvas(t)) {
    checkOffscreenCanvasTransfer(t);
    return OTHER;
  }
  if (IS_READABLE_STREAM(t)) {
    if (across) throw dataCloneError('A ReadableStream could not be transferred to another agent.');
    if (streamLocked(t)) throw dataCloneError('A locked ReadableStream could not be transferred.');
    return OTHER;
  }
  throw dataCloneError('Value is not a transferable object.');
};
// …its transfer steps: the counterpart it is moved onto, the source detached — a MessagePort onto a fresh entangled one,
// its held messages and enabled state with it; an ImageBitmap's pixels into a new one, and an OffscreenCanvas's size, the
// source closed; a ReadableStream onto a reader of it, which locks it.
hostSteps.transferMove = function (t) {
  if (isMessagePort(t)) return movePort(t);
  if (isImageBitmap(t)) {
    const moved = cloneImageBitmap(t);
    closeImageBitmap(t);
    return moved;
  }
  if (isOffscreenCanvas(t)) {
    const moved = transferredOffscreenCanvas(t);
    detachOffscreenCanvas(t);
    return moved;
  }
  return new TransferredStream({}, streamReader(t));
};
// (…a ReadableStream's, single-isolate: the reader of the source that the realm reading the value back pipes through a
// fresh base ReadableStream of its own (`pipedStream`), a subclass thus received as its closest transferable
// superclass; told by a private field every realm of the isolate shares — the snapshot's — and no page can give an
// object)
class TransferredStream extends Stamp {
  #reader;
  constructor(o, reader) {
    super(o);
    this.#reader = reader;
  }
  static readerOf(o) { return #reader in o ? o.#reader : undefined; }
}
function pipedStream(reader) {
  return new ReadableStream({
    pull(c)   { return reflectApply(promiseThen, reader.read(), [({ done, value }) => { if (done) c.close(); else c.enqueue(value); }]); },
    cancel(r) { return reader.cancel(r); }
  });
}
// …its transfer-receiving steps: the counterpart made this realm's — moved again where another realm of the isolate
// moved it (`here` false), and a stream's reader piped through one of this realm's.
hostSteps.transferReceive = function (moved, here) {
  const reader = TransferredStream.readerOf(moved);
  if (reader !== undefined) return pipedStream(reader);
  if (here) return moved;
  if (isMessagePort(moved)) return movePort(moved);
  if (isImageBitmap(moved)) {
    const received = cloneImageBitmap(moved);
    closeImageBitmap(moved);
    return received;
  }
  const received = transferredOffscreenCanvas(moved);
  detachOffscreenCanvas(moved);
  return received;
};
// …a MessagePort a message moved that no realm will read: closed, else it held on to what its peer is sent, unread.
hostSteps.transferAbandon = (port) => closePort(port);
// …and the form a counterpart crosses to another isolate in, as data — a MessagePort its channel end (message-port.js
// `portToEnd`), an ImageBitmap or an OffscreenCanvas its record, pixels and all — and the object of this realm a form
// makes.
hostSteps.transferForm = function (moved) {
  if (isMessagePort(moved)) return { port: realmHooks.portToEnd(moved) };
  return { record: realmHooks.canvasSerialization.record(moved, new InternalSet([moved])) };
};
hostSteps.transferFromForm = (form) =>
  (form.port != null ? realmHooks.endToPort(form.port) : realmHooks.canvasSerialization.fromRecord(form.record));

// ── The operations ───────────────────────────────────────────────────────────────────────────────────────────────────
// StructuredSerializeWithTransfer `value` with `transferList` (none where it is no array), for `mode`: the
// serialization's number, which any realm of the isolate reads back (`deserializeWithTransfer`) or lets go of
// (`discardSerialization`).
export const serializeWithTransfer = (value, transferList, mode = WITHIN_AGENT) => dom.structuredSerialize(value, transferList, mode);
// …StructuredDeserializeWithTransfer it in this realm: the value, and the MessagePorts it transferred — a message
// event's `ports`. A DataCloneError where it cannot be read back here, the ports it moved closed.
export function deserializeWithTransfer(serialized) {
  const read = dom.structuredDeserialize(serialized, true);
  return { data: read[0], ports: read[1] };
}
export const discardSerialization = (serialized) => dom.structuredDiscard(serialized);
// …a message read back in this realm — or, one that cannot be (a WebAssembly.Module of another agent cluster), `failed`:
// its event a `messageerror` with no data and no ports (HTML).
export const FAILED_READ = Object.freeze({ data: null, ports: Object.freeze([]), failed: true });
export function readMessage(serialized) {
  try {
    return deserializeWithTransfer(serialized);
  } catch (e) {
    if (!e || e.name !== 'DataCloneError') throw e;
    return FAILED_READ;
  }
}
realmHooks.readMessage = readMessage;
// Both, in this realm.
export const cloneWithTransfer = (value, transferList) => deserializeWithTransfer(serializeWithTransfer(value, transferList));

// WindowOrWorkerGlobalScope's `structuredClone` (window.js, which converted `options`; a worker's scope).
export const structuredClone = (v, options) =>
  dom.structuredDeserialize(dom.structuredSerialize(v, options && options.transfer, WITHIN_AGENT), false);
realmHooks.structuredClone = structuredClone;
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
// StructuredSerializeForStorage `value` (HTML): a serialization kept past the realm that made it — a session history
// entry's classic history API state, a document's persisted form state — as the bytes the host keeps; a DataCloneError in
// `prefix`'s words. …and StructuredDeserialize of such bytes, in this realm.
export const serializeForStorage = (value, prefix = '') =>
  dom.structuredBytes(inWordsOf(prefix, () => dom.structuredSerialize(value, NO_TRANSFER, FOR_STORAGE)));
export const deserializeFromStorage = (bytes) => dom.structuredDeserialize(dom.structuredFromBytes(bytes), false);
// …and both in this realm, a value as storage would keep it (IndexedDB "clone a value"), a DataCloneError in `prefix`'s
// words.
export const cloneForStorage = (value, prefix = '') =>
  dom.structuredDeserialize(inWordsOf(prefix, () => dom.structuredSerialize(value, NO_TRANSFER, FOR_STORAGE)), false);
