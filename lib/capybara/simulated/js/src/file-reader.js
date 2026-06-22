// FileReader — apps that mount file pickers (image preview widgets) read the
// chosen File via readAsDataURL / readAsText / readAsArrayBuffer. We read the
// blob's RAW bytes (a latin-1 byte-string, one char per byte) and deliver the
// transformed result through the spec event sequence:
//   loadstart -> [progress] -> load -> loadend   (progress omitted for an empty
// blob), with `result` exposed only from the `load` event onward. Each step is
// queued as a task (setTimeout(0)) so the microtask queue drains between events
// and EventWatcher-style tests can await them one at a time, while abort fires
// abort+loadend synchronously and terminates the in-flight read.

import { ProgressEvent, EventTarget, dispatchWithOnHandler } from './events.js';
import { bytesToArrayBuffer, latin1ToBytes } from './bytes.js';
import { blobBytes } from './blob.js';

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

export class FileReader extends EventTarget {
  static EMPTY   = EMPTY;
  static LOADING = LOADING;
  static DONE    = DONE;

  constructor() {
    super();
    this.readyState  = EMPTY;
    this.result      = null;
    this.error       = null;
    this.onloadstart = null;
    this.onprogress  = null;
    this.onload      = null;
    this.onabort     = null;
    this.onerror     = null;
    this.onloadend   = null;
    // Read generation: a new read or an abort bumps it so the previous read's
    // still-queued tasks (loadstart/progress/load) bail instead of clobbering a
    // restarted read's state. Mirrors the spec's "terminate this read" flag.
    this._gen = 0;
  }
  // Instance copies of the state constants so `reader.LOADING` works.
  get EMPTY()   { return EMPTY; }
  get LOADING() { return LOADING; }
  get DONE()    { return DONE; }

  readAsText(blob, encoding) { this._read(blob, raw => decodeText(raw, encoding, blob && blob.type)); }
  readAsDataURL(blob)        { this._read(blob, raw => 'data:' + ((blob && blob.type) || 'application/octet-stream') + ';base64,' + globalThis.btoa(raw)); }
  readAsArrayBuffer(blob)    { this._read(blob, raw => bytesToArrayBuffer(raw)); }
  readAsBinaryString(blob)   { this._read(blob, raw => raw); }

  abort() {
    // Spec: if EMPTY or DONE, just clear the result and return — no events.
    if (this.readyState !== LOADING) { this.result = null; return; }
    this._gen++;                 // terminate the in-flight read's queued tasks
    this.readyState = DONE;
    this.result = null;
    this._fire('abort');         // abort + loadend dispatch synchronously
    this._fire('loadend');
  }

  _read(blob, transform) {
    // Starting a read while one is in progress is an InvalidStateError.
    if (this.readyState === LOADING) {
      throw new globalThis.DOMException(
        "Failed to execute read on 'FileReader': The object is already busy reading Blobs.",
        'InvalidStateError'
      );
    }
    this.readyState = LOADING;
    this.result = null;
    this.error  = null;
    const gen = ++this._gen;
    // RAW bytes (latin-1 byte-string), NOT blob.text() — text() UTF-8-decodes,
    // which would corrupt binary content for the array-buffer / data-URL / binary
    // readers. blobBytes honours _csimHost (attach_file-backed) blobs.
    const raw = blob && typeof blob === 'object' ? blobBytes(blob) : '';
    // Each step is queued as a TASK (spec "queue a task"), not a microtask, so
    // that between steps the microtask queue fully drains — letting an awaiting
    // EventWatcher resume and register its next wait_for() before the following
    // event fires. A step bails if a newer read/abort superseded it (gen mismatch).
    const step = (fn) => { globalThis.setTimeout(() => { if (this._gen === gen) fn(); }, 0); };
    step(() => {
      this._fire('loadstart');
      step(() => {
        if (raw.length) this._fire('progress');   // no progress for an empty blob
        step(() => {
          // load/error and loadend fire in SEPARATE tasks: a microtask
          // checkpoint between them lets an awaiting EventWatcher register its
          // next wait_for('loadend') before it arrives (back-to-back synchronous
          // dispatch would be seen as an unexpected event). abort() is the only
          // path that fires its terminal pair synchronously.
          try {
            this.result     = transform(raw);
            this.readyState = DONE;
            this._fire('load');
          } catch (e) {
            this.error      = e;
            this.result     = null;
            this.readyState = DONE;
            this._fire('error');
          }
          // loadend is committed once load/error has fired — schedule it in a
          // separate task (the EventWatcher checkpoint) but WITHOUT the gen guard,
          // so a fresh read started inside the load/error handler doesn't cancel
          // this read's terminal loadend.
          globalThis.setTimeout(() => this._fire('loadend'), 0);
        });
      });
    });
  }

  _fire(type) {
    dispatchWithOnHandler(this, new ProgressEvent(type, {}));
  }
}

globalThis.FileReader = FileReader;
