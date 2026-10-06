// FileReader (File API §6), generated from its IDL — apps that mount file pickers (image preview widgets) read the
// chosen File via readAsDataURL / readAsText / readAsArrayBuffer. A read takes the blob's RAW bytes (a latin-1 byte
// string, one char per byte) and delivers the transformed result through the spec event sequence:
//   loadstart -> [progress] -> load -> [loadend]   (progress omitted for an empty blob; loadend none where a handler
// of load started another read), with `result` exposed only from the `load` event onward. Each step is queued as a task
// so the microtask queue drains between events and EventWatcher-style tests can await them one at a time, while abort
// fires abort (+ loadend) synchronously and terminates the in-flight read.

import { EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { latin1ToBytes } from './bytes.js';
import { blobSize, blobType, readBlob } from './blob.js';
import { getEncoding } from './encodings.js';
import { installFileReader, installFileReaderSync } from './generated/bindings.js';
import { parseMimeType } from './mime.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

const EMPTY = 0, LOADING = 1, DONE = 2;

// readAsText's encoding (§6.4.3 "package data", Text): the label's encoding where it names one, else the blob type's
// charset parameter's, else UTF-8 — and then the Encoding Standard's "decode", whose BOM sniff overrides it. The
// replacement encoding decodes anything but nothing to a single U+FFFD.
function decodeText(raw, label, type) {
  const bytes = latin1ToBytes(raw);
  let encoding = label === undefined ? null : getEncoding(label);
  if (!encoding) {
    const mime = parseMimeType(type);
    const charset = mime && mime.parameters.get('charset');
    encoding = (charset && getEncoding(charset)) || 'UTF-8';
  }
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) encoding = 'UTF-8';
  else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'UTF-16BE';
  else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'UTF-16LE';
  if (encoding === 'replacement') return bytes.length ? '�' : '';
  return new globalThis.TextDecoder(encoding).decode(bytes);
}

// A reader's state — the ready state, the result and the error of its read, the generation a new read or an abort
// moves (the spec's "terminate this read": the previous read's queued tasks bail), and its own realm's global, through
// which its tasks are queued, its events made and its results built, whichever realm's members it is read through —
// its internal slots.
export class FileReader extends EventTarget {
  constructor() {
    super();
    makeSlots(this, 'FileReader', { readyState: EMPTY, result: null, error: null, gen: 0, global: globalThis });
  }
}
const readerOf = (o) => slotsOf(o, 'FileReader');
registerInterface('FileReader', (o) => readerOf(o) !== undefined);

// A read of `blob` — a Blob of any realm, the binding's conversion — its raw bytes (not `text()`'s decoding, which
// would corrupt the binary readers' results; a picked file's too) handed to `transform`, with the reader's realm's
// global; a picked file gone from the disk a NotReadableError.
function read(reader, blob, transform) {
  const s = readerOf(reader), g = s.global;
  // Starting a read while one is in progress is an InvalidStateError.
  if (s.readyState === LOADING) {
    throw new globalThis.DOMException("Failed to execute read on 'FileReader': The object is already busy reading Blobs.", 'InvalidStateError');
  }
  s.readyState = LOADING;
  s.result = null;
  s.error = null;
  const gen = ++s.gen, size = blobSize(blob);
  // Each step is queued as a TASK (spec "queue a task"), not a microtask, so that between steps the microtask queue
  // fully drains — letting an awaiting EventWatcher resume and register its next wait_for() before the following event
  // fires. A step bails if a newer read/abort superseded it (gen mismatch).
  const step = (fn) => { g.__csimSetTimeout(() => { if (s.gen === gen) fn(); }, 0); };
  step(() => {
    fire(reader, 'loadstart', 0, size);
    step(() => {
      if (size) fire(reader, 'progress', size, size);   // no progress for an empty blob
      step(() => {
        const raw = readBlob(blob);
        if (raw === null) {
          s.error = new g.DOMException('The requested file could not be read.', 'NotReadableError');
          s.readyState = DONE;
          fire(reader, 'error', 0, size);
        } else {
          try {
            s.result = transform(raw, g);
            s.readyState = DONE;
            fire(reader, 'load', size, size);
          } catch (e) {
            s.error = e;
            s.result = null;
            s.readyState = DONE;
            fire(reader, 'error', 0, size);
          }
        }
        // loadend only where no handler of load / error started another read (§6.4.2, the read operation's last
        // step), in a task of its own — the EventWatcher checkpoint — without the gen guard, the read it ends committed.
        if (s.readyState !== LOADING) g.__csimSetTimeout(() => fire(reader, 'loadend', s.error ? 0 : size, size), 0);
      });
    });
  });
}
// (…a ProgressEvent of the reader's realm: the bytes read of the blob's — lengths computable, as Chrome's are, but for
// an abort's, which has none)
function fire(reader, type, loaded, total, lengthComputable = true) {
  const g = readerOf(reader).global;
  dispatchWithOnHandler(reader, new g.ProgressEvent(type, { lengthComputable, loaded, total }));
}
// What each read makes of the blob's raw bytes (§6.4.3 "package data") — an ArrayBuffer of the reader's realm, the
// bytes as a binary string, their text, a data: URL of them.
const arrayBufferOf = (raw, g) => new g.Uint8Array(latin1ToBytes(raw)).buffer;
const binaryStringOf = (raw) => raw;
const textOf = (blob, encoding) => (raw) => decodeText(raw, encoding, blobType(blob));
const dataURLOf = (blob) => (raw) => 'data:' + (blobType(blob) || 'application/octet-stream') + ';base64,' + latin1ToBytes(raw).toBase64();

installFileReader(FileReader, {
  readAsArrayBuffer: (reader, blob) => read(reader, blob, arrayBufferOf),
  readAsBinaryString: (reader, blob) => read(reader, blob, binaryStringOf),
  readAsText: (reader, blob, encoding) => read(reader, blob, textOf(blob, encoding)),
  readAsDataURL: (reader, blob) => read(reader, blob, dataURLOf(blob)),
  // (…EMPTY or DONE: its result cleared, and no events; LOADING: the read terminated, abort fired at once — and loadend,
  // where no handler of abort started another read)
  abort(reader) {
    const s = readerOf(reader);
    if (s.readyState !== LOADING) {
      s.result = null;
      return;
    }
    s.gen++;
    s.readyState = DONE;
    s.result = null;
    fire(reader, 'abort', 0, 0, false);
    if (s.readyState !== LOADING) fire(reader, 'loadend', 0, 0, false);
  },
  get_readyState: (reader) => readerOf(reader).readyState,
  get_result: (reader) => readerOf(reader).result,
  get_error: (reader) => readerOf(reader).error,
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.FileReader = FileReader;

// FileReaderSync (§7), a dedicated or shared worker's: the same reads, their result returned — and their failure thrown,
// a picked file gone from the disk a NotReadableError — at once (worker-globals.js exposes it). Stateless: a read is the
// call.
export class FileReaderSync {
  constructor() { makeSlots(this, 'FileReaderSync'); }
}
registerInterface('FileReaderSync', (o) => slotsOf(o, 'FileReaderSync') !== undefined);
function readSync(blob, transform) {
  const raw = readBlob(blob);
  if (raw === null) throw new globalThis.DOMException('The requested file could not be read.', 'NotReadableError');
  return transform(raw, globalThis);
}
installFileReaderSync(FileReaderSync, {
  readAsArrayBuffer: (reader, blob) => readSync(blob, arrayBufferOf),
  readAsBinaryString: (reader, blob) => readSync(blob, binaryStringOf),
  readAsText: (reader, blob, encoding) => readSync(blob, textOf(blob, encoding)),
  readAsDataURL: (reader, blob) => readSync(blob, dataURLOf(blob))
});
