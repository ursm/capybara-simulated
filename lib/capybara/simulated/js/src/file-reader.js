// FileReader — apps that mount file pickers (image preview widgets) read the
// chosen File via readAsDataURL / readAsText / readAsArrayBuffer. We read the
// blob's RAW bytes (a latin-1 byte-string, one char per byte) and deliver the
// transformed result through the spec event sequence:
//   loadstart -> [progress] -> load -> loadend   (progress omitted for an empty
// blob), with `result` exposed only from the `load` event onward. Each step is
// queued as a task (setTimeout(0)) so the microtask queue drains between events
// and EventWatcher-style tests can await them one at a time, while abort fires
// abort+loadend synchronously and terminates the in-flight read.

import { ProgressEvent, EventTarget, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { bytesToArrayBuffer, latin1ToBytes } from './bytes.js';
import { blobBytes, blobType } from './blob.js';
import { installFileReader } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';

const EMPTY = 0, LOADING = 1, DONE = 2;

// FileReader "encoding determination" for readAsText: use the explicit label if
// given, else the charset parameter of the Blob's MIME type, else sniff a leading
// BOM (UTF-8 / UTF-16BE / UTF-16LE), else default to UTF-8. TextDecoder strips a
// matching BOM itself. An unknown encoding falls back to UTF-8 (never throws).
function decodeText(raw, label, blobType) {
  const bytes = latin1ToBytes(raw);
  let enc = label;
  if (!enc && blobType) {
    const m = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(String(blobType));
    if (m) enc = m[1].trim();
  }
  if (!enc) {
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) enc = 'utf-8';
    else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
    else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
  }
  try {
    return new globalThis.TextDecoder(enc || 'utf-8').decode(bytes);
  } catch (_) {
    return new globalThis.TextDecoder('utf-8').decode(bytes);
  }
}

// FileReader (File API §6), generated from its IDL: its state — the ready state, the result and the error of its read,
// and the generation a new read or an abort moves (the spec's "terminate this read": the previous read's queued tasks
// bail) — its internal slots.
export class FileReader extends EventTarget {
  constructor() {
    super();
    makeSlots(this, 'FileReader', { readyState: EMPTY, result: null, error: null, gen: 0 });
  }
}
const readerOf = (o) => slotsOf(o, 'FileReader');
registerInterface('FileReader', (o) => readerOf(o) !== undefined);

// A read of `blob` — a Blob of any realm, the binding's conversion — its raw bytes (a latin-1 byte string, not
// `text()`'s decoding, which would corrupt the binary readers' results; a picked file's too) handed to `transform`.
function read(reader, blob, transform) {
  const s = readerOf(reader);
  // Starting a read while one is in progress is an InvalidStateError.
  if (s.readyState === LOADING) {
    throw new globalThis.DOMException("Failed to execute read on 'FileReader': The object is already busy reading Blobs.", 'InvalidStateError');
  }
  s.readyState = LOADING;
  s.result = null;
  s.error = null;
  const gen = ++s.gen;
  const raw = blobBytes(blob);
  // Each step is queued as a TASK (spec "queue a task"), not a microtask, so that between steps the microtask queue
  // fully drains — letting an awaiting EventWatcher resume and register its next wait_for() before the following event
  // fires. A step bails if a newer read/abort superseded it (gen mismatch).
  const step = (fn) => { globalThis.__csimSetTimeout(() => { if (s.gen === gen) fn(); }, 0); };
  step(() => {
    fire(reader, 'loadstart');
    step(() => {
      if (raw.length) fire(reader, 'progress');   // no progress for an empty blob
      step(() => {
        // load/error and loadend fire in SEPARATE tasks: a microtask checkpoint between them lets an awaiting
        // EventWatcher register its next wait_for('loadend') before it arrives. abort() is the only path that fires its
        // terminal pair synchronously.
        try {
          s.result = transform(raw);
          s.readyState = DONE;
          fire(reader, 'load');
        } catch (e) {
          s.error = e;
          s.result = null;
          s.readyState = DONE;
          fire(reader, 'error');
        }
        // loadend is committed once load/error has fired — scheduled in a separate task (the EventWatcher checkpoint)
        // but WITHOUT the gen guard, so a fresh read started inside the load/error handler doesn't cancel this read's
        // terminal loadend.
        globalThis.__csimSetTimeout(() => fire(reader, 'loadend'), 0);
      });
    });
  });
}
function fire(reader, type) {
  dispatchWithOnHandler(reader, new ProgressEvent(type, {}));
}

installFileReader(FileReader, {
  readAsArrayBuffer: (reader, blob) => read(reader, blob, (raw) => bytesToArrayBuffer(raw)),
  readAsBinaryString: (reader, blob) => read(reader, blob, (raw) => raw),
  readAsText: (reader, blob, encoding) => read(reader, blob, (raw) => decodeText(raw, encoding, blobType(blob))),
  readAsDataURL: (reader, blob) => read(reader, blob, (raw) => 'data:' + (blobType(blob) || 'application/octet-stream') + ';base64,' + latin1ToBytes(raw).toBase64()),
  // (…EMPTY or DONE: its result cleared, and no events; LOADING: the read terminated, and abort + loadend fired at once)
  abort(reader) {
    const s = readerOf(reader);
    if (s.readyState !== LOADING) {
      s.result = null;
      return;
    }
    s.gen++;
    s.readyState = DONE;
    s.result = null;
    fire(reader, 'abort');
    fire(reader, 'loadend');
  },
  get_readyState: (reader) => readerOf(reader).readyState,
  get_result: (reader) => readerOf(reader).result,
  get_error: (reader) => readerOf(reader).error,
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.FileReader = FileReader;
