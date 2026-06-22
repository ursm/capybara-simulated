// Minimal FileReader — apps that mount file pickers (image preview
// widgets) read the chosen File via `reader.readAsDataURL` /
// `readAsText`. We read the blob's RAW bytes (a latin-1 byte-string,
// one char per byte) synchronously and deliver the transformed result
// via an event in the next microtask. Only `readAsText` decodes (the
// bytes are UTF-8 by default, or the label passed as the 2nd argument);
// the binary readers must keep the raw bytes intact.

import { Event, EventTarget, dispatchWithOnHandler } from './events.js';
import { bytesToArrayBuffer, latin1ToBytes } from './bytes.js';
import { blobBytes } from './blob.js';

// Decode a raw latin-1 byte-string as text via the requested encoding label
// (default UTF-8); an unknown label falls back to UTF-8 rather than throwing.
function decodeText(raw, label) {
  const bytes = latin1ToBytes(raw);
  try {
    return new globalThis.TextDecoder(label || 'utf-8').decode(bytes);
  } catch (_) {
    return new globalThis.TextDecoder('utf-8').decode(bytes);
  }
}

export class FileReader extends EventTarget {
  constructor() {
    super();
    this.result     = null;
    this.readyState = 0;
    this.error      = null;
  }
  readAsText(blob, encoding) { this._read(blob, raw => decodeText(raw, encoding)); }
  readAsDataURL(blob)        { this._read(blob, raw => 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + globalThis.btoa(raw)); }
  readAsArrayBuffer(blob)    { this._read(blob, raw => bytesToArrayBuffer(raw)); }
  readAsBinaryString(blob)   { this._read(blob, raw => raw); }
  abort()                    { this.readyState = 2; this._fire('abort'); }
  _read(blob, transform) {
    this.readyState = 1;
    // RAW bytes (latin-1 byte-string), NOT blob.text() — text() UTF-8-decodes,
    // which would corrupt binary content for the array-buffer / data-URL / binary
    // readers. blobBytes honours _csimHost (attach_file-backed) blobs.
    const raw = blob && typeof blob === 'object' ? blobBytes(blob) : '';
    Promise.resolve(raw).then(t => {
      try {
        this.result = transform(t);
        this.readyState = 2;
        this._fire('load');
        this._fire('loadend');
      } catch (e) {
        this.error = e;
        this.readyState = 2;
        this._fire('error');
        this._fire('loadend');
      }
    });
  }
  _fire(type) {
    dispatchWithOnHandler(this, new Event(type));
  }
}

globalThis.FileReader = FileReader;
