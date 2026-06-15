// Blob / File + byte helpers + URL.createObjectURL / revokeObjectURL +
// multipart/form-data serializer.

import { bytesToLatin1, bytesToArrayBuffer } from './bytes.js';
import { hasWorkers }                        from './workers.js';
//
// Blob bodies are stored as latin-1 byte strings (one char per byte,
// 0-255) so the engine marshalling boundary survives
// arbitrary binary payloads. Host-backed Files (uploaded via
// `attach_file`) carry `_csimHost = true` plus `_handle`/`_index`/
// `_start`/`_end` referring to the Ruby `read_file_pick` slot — text /
// arrayBuffer / slice resolve through `__csimReadFilePick`.
//
// URL.createObjectURL also registers the bytes with the Ruby-side
// `blob_register` host fn so Worker isolates (which see an empty
// `__csimBlobs` Map) can resolve `blob:` URLs via the fallback in
// `resolveBlobBytes`. The registration is skipped when no Worker
// isolate exists, saving a btoa+IPC per File pick on the hot path.

// Local Map keyed by blob: URLs created in this isolate. Lives on
// `globalThis` so subsequent installs (visit() rebuilds the VM) share
// the same table.
const blobs = globalThis.__csimBlobs = globalThis.__csimBlobs || new Map();
globalThis.__csimBlobCounter = globalThis.__csimBlobCounter || { n: 0 };

function readHostFile(blob) {
  if (typeof globalThis.__csimReadFilePick !== 'function') return '';
  const b64 = globalThis.__csimReadFilePick(blob._handle, blob._index, blob._start, blob._end);
  if (!b64) return '';
  try { return globalThis.atob(String(b64)); } catch (_) { return ''; }
}

// Unifies host-backed (Ruby slot) vs in-memory (`_parts`) byte access.
export function blobBytes(blob) {
  if (!blob) return '';
  if (blob._csimHost) return readHostFile(blob);
  return blob._parts ? blob._parts.join('') : '';
}

export class Blob {
  constructor(parts, opts) {
    const i = opts || {};
    this._parts = (parts || []).map(p => {
      if (typeof p === 'string')     return p;
      if (p instanceof Blob)         return blobBytes(p);
      if (p instanceof ArrayBuffer)  return bytesToLatin1(new Uint8Array(p));
      // Typed-array views (Uint8Array, Int8Array, …). file-saver
      // builds the download Blob from a `Uint8Array` so we have to
      // serialize the underlying bytes, not `String(typedArray)`
      // (which gives a comma-joined decimal repr).
      if (p && typeof p === 'object' && typeof p.byteLength === 'number' && p.buffer instanceof ArrayBuffer) {
        return bytesToLatin1(new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength));
      }
      return String(p);
    });
    this.size = this._parts.reduce((s, p) => s + (p ? p.length : 0), 0);
    this.type = i.type || '';
  }
  text() {
    if (this._csimHost) return Promise.resolve(readHostFile(this));
    return Promise.resolve(this._parts.join(''));
  }
  arrayBuffer() {
    return this.text().then(bytesToArrayBuffer);
  }
  slice(start, end, type) {
    if (this._csimHost) {
      const s = Math.max(0, start || 0);
      const e = end == null ? this.size : Math.min(this.size, end);
      const next = Object.create(Object.getPrototypeOf(this));
      next._csimHost = true;
      next._handle   = this._handle;
      next._index    = this._index;
      next._start    = this._start + s;
      next._end      = this._start + e;
      next.size      = Math.max(0, next._end - next._start);
      next.type      = type == null ? this.type : String(type);
      next._parts    = [];
      return next;
    }
    const all = this._parts.join('');
    return new Blob([all.slice(start || 0, end == null ? undefined : end)], { type: type || this.type });
  }
  stream() { return null; }
}

export class File extends Blob {
  constructor(parts, name, opts) {
    super(parts, opts);
    const i = opts || {};
    this.name = String(name == null ? '' : name);
    this.lastModified = i.lastModified || Date.now();
  }
}

// Encode a JS string as UTF-8 bytes returned as a latin-1 byte-string, so field
// names / values / filenames with non-ASCII characters (Japanese labels, emoji,
// the submit button's localized value) keep the whole multipart body in the
// 0-255 range — the caller base64s it via `btoa`, which rejects code units > 255.
function utf8Latin1(s) {
  return bytesToLatin1(new globalThis.TextEncoder().encode(String(s)));
}

export function serializeMultipart(formData) {
  const boundary = '----csimFormBoundary' + Math.random().toString(36).slice(2);
  let body = '';
  formData.forEach((value, key) => {
    body += '--' + boundary + '\r\n';
    if (value instanceof Blob) {
      const filename    = value.name != null ? String(value.name) : 'blob';
      const contentType = value.type || 'application/octet-stream';
      body += 'Content-Disposition: form-data; name="' + utf8Latin1(key) + '"; filename="' + utf8Latin1(filename) + '"\r\n';
      body += 'Content-Type: ' + contentType + '\r\n\r\n';
      body += blobBytes(value);   // already a latin-1 byte-string
      body += '\r\n';
    } else {
      body += 'Content-Disposition: form-data; name="' + utf8Latin1(key) + '"\r\n\r\n';
      body += utf8Latin1(value) + '\r\n';
    }
  });
  body += '--' + boundary + '--\r\n';
  return { body, boundary };
}

export function resolveBlobBytes(url) {
  const blob = blobs.get(String(url));
  if (blob) return { bytes: blobBytes(blob), type: blob.type || 'application/octet-stream' };
  let b64;
  try { b64 = globalThis.__csim_blobResolve(url); } catch (_) { b64 = null; }
  if (b64 == null) return null;
  let bytes = '';
  try { bytes = globalThis.atob(String(b64)); } catch (_) {}
  return { bytes, type: 'application/octet-stream' };
}

export function installBlobURL() {
  if (!globalThis.URL || globalThis.URL.__csimBlobInstalled) return;
  globalThis.URL.createObjectURL = function (blob) {
    const url = 'blob:csim-' + (++globalThis.__csimBlobCounter.n);
    blobs.set(url, blob);
    if (hasWorkers()) {
      try { globalThis.__csim_blobRegister(url, globalThis.btoa(blobBytes(blob) || '')); } catch (_) {}
    }
    return url;
  };
  globalThis.URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    try { globalThis.__csim_blobUnregister(url); } catch (_) {}
  };
  globalThis.URL.__csimBlobInstalled = true;
}

// `__csimReadBlobBase64` is a Ruby-side reachable global — Browser#
// host calls it to extract a blob URL's bytes when serving downloads.
globalThis.__csimReadBlobBase64 = function (url) {
  const blob = blobs.get(String(url));
  if (!blob) return null;
  try { return globalThis.btoa(blobBytes(blob)); } catch (_) { return null; }
};
