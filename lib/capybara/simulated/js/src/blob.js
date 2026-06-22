// Blob / File + byte helpers + URL.createObjectURL / revokeObjectURL +
// multipart/form-data serializer.

import { bytesToLatin1, latin1ToBytes, bytesToArrayBuffer } from './bytes.js';
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

// WebIDL `sequence<BlobPart>` conversion of the `blobParts` argument. This is
// argument-0 conversion and per WebIDL runs to completion BEFORE the options
// dictionary is read (left-to-right argument evaluation), and the value's
// @@iterator is fetched EXACTLY ONCE (a manual iterator walk, not `for…of`,
// which would re-read @@iterator). Each element is converted to its raw IDL
// form right here — a BufferSource → bytes, a Blob → its bytes, anything else
// → USVString (`String(p)`, calling `toString`). Line-ending normalisation and
// UTF-8 encoding are deferred to the Blob construction algorithm (they depend on
// `options.endings`, read afterwards). `parts === undefined` (omitted optional
// arg) → empty; a primitive / null / object without @@iterator is a sequence
// conversion failure → TypeError. Returns intermediate items: {bytes} or {text}.
function convertBlobParts(parts) {
  if (parts === undefined) return [];
  if (parts === null || typeof parts !== 'object') {
    throw new TypeError("Failed to construct 'Blob': The provided value cannot be converted to a sequence.");
  }
  const itFn = parts[Symbol.iterator];
  if (typeof itFn !== 'function') {
    throw new TypeError("Failed to construct 'Blob': The provided value cannot be converted to a sequence.");
  }
  const iterator = itFn.call(parts);
  const out = [];
  for (;;) {
    const next = iterator.next();
    if (!next || typeof next !== 'object') {
      throw new TypeError("Failed to construct 'Blob': iterator result is not an object.");
    }
    if (next.done) break;
    const p = next.value;
    if (p instanceof Blob) { out.push({ bytes: blobBytes(p) }); continue; }
    if (p instanceof ArrayBuffer) { out.push({ bytes: bytesToLatin1(new Uint8Array(p)) }); continue; }
    // Typed-array views / DataView (Uint8Array, Int8Array, …): serialize the
    // underlying bytes (file-saver builds a download Blob from a Uint8Array).
    if (p && typeof p === 'object' && typeof p.byteLength === 'number' && p.buffer instanceof ArrayBuffer) {
      out.push({ bytes: bytesToLatin1(new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength)) }); continue;
    }
    out.push({ text: String(p) });   // USVString conversion (calls toString)
  }
  return out;
}

// Blob construction algorithm, applied to the already-converted intermediate
// items: a STRING blobPart is UTF-8, NOT latin-1 (`new Blob(['€']).size === 3`),
// with `endings === 'native'` normalising line endings to the host native ending
// (\n here); a BufferSource/Blob's bytes are taken verbatim.
function partsToBytes(raw, endings) {
  return raw.map((it) => {
    if (it.bytes !== undefined) return it.bytes;
    let s = it.text;
    if (endings === 'native') s = s.replace(/\r\n|\r|\n/g, '\n');
    return utf8Latin1(s);   // a string blobPart is UTF-8 encoded
  });
}

// WHATWG Blob `type`: ASCII-lowercased, but the empty string if any code point
// is outside U+0020..U+007E.
function normalizeBlobType(t) {
  // UNDEFINED (absent dictionary member / omitted slice contentType) → empty
  // string. A PRESENT value — including an explicit null — is converted to a
  // DOMString first (null → "null"), then ASCII-lowercased, or "" if any code
  // point is outside U+0020..U+007E.
  if (t === undefined) return '';
  const s = String(t);
  return /^[ -~]*$/.test(s) ? s.toLowerCase() : '';
}

// Validate + read the BlobPropertyBag (the optional `options` dictionary). Per
// WebIDL: undefined / null → an empty dictionary; any other non-object value
// (123 / true / "abc") → TypeError. `endings` is an EndingType enum — anything
// but the omitted value / "transparent" / "native" → TypeError. Members are read
// in lexicographic order (endings before type).
function blobOptions(opts) {
  if (opts === undefined || opts === null) return { type: undefined, endings: 'transparent' };
  if (Object(opts) !== opts) {
    throw new TypeError("Failed to construct 'Blob': The provided value is not of type 'BlobPropertyBag'.");
  }
  // EndingType enum conversion is ToString-then-check (so a boxed String / a
  // proxy returning a stringifiable value works); only an OMITTED value defaults.
  let endings = opts.endings;
  if (endings === undefined) {
    endings = 'transparent';
  } else {
    endings = String(endings);
    if (endings !== 'transparent' && endings !== 'native') {
      throw new TypeError(`Failed to construct 'Blob': The provided value '${endings}' is not a valid enum value of type EndingType.`);
    }
  }
  return { type: opts.type, endings };
}

// Build a Blob directly from an already-encoded latin-1 byte-string, bypassing
// the string→UTF-8 re-encoding in processBlobParts (slice / internal callers
// hand over raw bytes, which must NOT be re-encoded).
function blobFromBytes(BlobCtor, bytes, type) {
  const out = Object.create(BlobCtor.prototype);
  out._parts = [bytes];
  out.size   = bytes.length;
  out.type   = normalizeBlobType(type);
  return out;
}

export class Blob {
  // `...args` so `Blob.length === 0` (both blobParts and options are optional).
  constructor(...args) {
    // Argument order matters: blobParts (arg 0) is sequence-converted FIRST,
    // then the options dictionary (arg 1) is read (endings, then type), then the
    // construction algorithm applies endings + UTF-8 encoding.
    const raw = convertBlobParts(args[0]);
    const o = blobOptions(args[1]);
    this._parts = partsToBytes(raw, o.endings);
    this.size = this._parts.reduce((s, p) => s + (p ? p.length : 0), 0);
    this.type = normalizeBlobType(o.type);
  }
  get [Symbol.toStringTag]() { return 'Blob'; }   // Object.prototype.toString → "[object Blob]"
  bytes() { return Promise.resolve(latin1ToBytes(blobBytes(this))); }
  text() {
    // The bytes are UTF-8; `text()` returns the DECODED string (not the raw
    // byte-string). arrayBuffer()/slice operate on the raw bytes instead.
    const bytes = this._csimHost ? readHostFile(this) : this._parts.join('');
    return Promise.resolve(new globalThis.TextDecoder().decode(latin1ToBytes(bytes)));
  }
  arrayBuffer() {
    return Promise.resolve(bytesToArrayBuffer(blobBytes(this)));
  }
  slice(start, end, type) {
    // WHATWG Blob.slice: relative-index start/end (negative = from the end),
    // clamped to [0, size]; a missing/undefined contentType is the EMPTY string
    // (NOT inherited from this); the result is always a Blob (never a File).
    const [s, span] = sliceRange(start, end, this.size);
    if (this._csimHost) {
      const next = Object.create(Blob.prototype);
      next._csimHost = true;
      next._handle   = this._handle;
      next._index    = this._index;
      next._start    = this._start + s;
      next._end      = this._start + s + span;
      next.size      = span;
      next.type      = normalizeBlobType(type);
      next._parts    = [];
      return next;
    }
    return blobFromBytes(Blob, this._parts.join('').substr(s, span), type);
  }
  stream() {
    // A byte ReadableStream of the blob's bytes — supports both default and BYOB
    // readers (the WPT test reads via getReader({mode:'byob'})). The whole body
    // is enqueued in one chunk (blobs are in-memory here), then the stream closes.
    const bytes = latin1ToBytes(blobBytes(this));
    let pulled = false;
    return new globalThis.ReadableStream({
      type: 'bytes',
      pull(controller) {
        if (!pulled) { pulled = true; if (bytes.length) controller.enqueue(bytes); }
        controller.close();
      }
    });
  }
}

// Blob.slice index resolution. start/end are WebIDL `[Clamp] long long`, so a
// fractional value rounds to the NEAREST integer, ties to EVEN (0.5→0, 1.5→2,
// 2.5→2, 3.5→4) — not truncation. Then negatives are taken relative to size and
// the result is clamped to [0, size]; returns [absoluteStart, span].
function clampToInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = Math.floor(n);
  const d = n - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;   // exactly .5 → round to even
}
function sliceRange(start, end, size) {
  let s = start === undefined ? 0 : clampToInt(start);
  let e = end   === undefined ? size : clampToInt(end);
  s = s < 0 ? Math.max(size + s, 0) : Math.min(s, size);
  e = e < 0 ? Math.max(size + e, 0) : Math.min(e, size);
  return [s, Math.max(e - s, 0)];
}

export class File extends Blob {
  constructor(parts, name, opts) {
    // File(fileBits, fileName, options): fileName is REQUIRED.
    if (arguments.length < 2) {
      throw new TypeError(`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`);
    }
    super(parts, opts);
    const i = opts || {};
    this.name = String(name);   // null → "null", an object → "[object Object]"
    // lastModified defaults to "now" only when absent — an explicit 0 is valid.
    this.lastModified = i.lastModified != null ? Number(i.lastModified) : Date.now();
  }
  get [Symbol.toStringTag]() { return 'File'; }   // Object.prototype.toString → "[object File]"
}

// Encode a JS string as UTF-8 bytes returned as a latin-1 byte-string, so field
// names / values / filenames with non-ASCII characters (Japanese labels, emoji,
// the submit button's localized value) keep the whole multipart body in the
// 0-255 range — the caller base64s it via `btoa`, which rejects code units > 255.
function utf8Latin1(s) {
  return bytesToLatin1(new globalThis.TextEncoder().encode(String(s)));
}

// multipart/form-data field encoding (fetch "multipart/form-data encoding
// algorithm"). A field VALUE has its newlines normalised to CRLF; a Content-
// Disposition NAME / FILENAME escapes CR / LF / `"` as %0D / %0A / %22 (a name is
// additionally newline-normalised first). The result is then UTF-8 encoded.
function normalizeNewlines(s) {
  return String(s).replace(/\r\n|\r|\n/g, '\r\n');
}
function escapeFormField(s) {
  return String(s).replace(/[\r\n"]/g, (c) => (c === '"' ? '%22' : c === '\r' ? '%0D' : '%0A'));
}

export function serializeMultipart(formData) {
  const boundary = '----csimFormBoundary' + Math.random().toString(36).slice(2);
  let body = '';
  formData.forEach((value, key) => {
    const name = utf8Latin1(escapeFormField(normalizeNewlines(key)));
    body += '--' + boundary + '\r\n';
    if (value instanceof Blob) {
      const filename    = utf8Latin1(escapeFormField(value.name != null ? String(value.name) : 'blob'));
      const contentType = value.type || 'application/octet-stream';
      body += 'Content-Disposition: form-data; name="' + name + '"; filename="' + filename + '"\r\n';
      body += 'Content-Type: ' + contentType + '\r\n\r\n';
      body += blobBytes(value);   // already a latin-1 byte-string
      body += '\r\n';
    } else {
      body += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n';
      body += utf8Latin1(normalizeNewlines(value)) + '\r\n';
    }
  });
  body += '--' + boundary + '--\r\n';
  return { body, boundary };
}

export function resolveBlobBytes(url) {
  // A blob: URL's fragment is not part of the resource identity (fetching
  // `<blobURL>#frag` succeeds), but a query string or extra path is — those make
  // it a different, unregistered URL that must NOT resolve. So strip only the
  // fragment before the registry lookup.
  const key = String(url).split('#')[0];
  const blob = blobs.get(key);
  if (blob) return { bytes: blobBytes(blob), type: blob.type || 'application/octet-stream' };
  let b64;
  try { b64 = globalThis.__csim_blobResolve(key); } catch (_) { b64 = null; }
  if (b64 == null) return null;
  let bytes = '';
  try { bytes = globalThis.atob(String(b64)); } catch (_) {}
  return { bytes, type: 'application/octet-stream' };
}

// A v4 UUID (random, with the version/variant nibbles fixed) — the path segment
// of a blob: URL per the spec: `blob:<origin>/<uuid>`.
function blobUuid() {
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += (8 + Math.floor(Math.random() * 4)).toString(16);
    else s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

export function installBlobURL() {
  if (!globalThis.URL || globalThis.URL.__csimBlobInstalled) return;
  globalThis.URL.createObjectURL = function (blob) {
    // Spec format: `blob:` + the settings object's origin + `/` + a UUID. Parsing
    // it back yields protocol "blob:", an empty host, and the document origin.
    const origin = (globalThis.location && globalThis.location.origin) || 'null';
    const url = 'blob:' + origin + '/' + blobUuid();
    blobs.set(url, blob);
    if (hasWorkers()) {
      try { globalThis.__csim_blobRegister(url, globalThis.btoa(blobBytes(blob) || '')); } catch (_) {}
    }
    return url;
  };
  globalThis.URL.revokeObjectURL = function (url) {
    // Revocation matches the entry EXACTLY (fragment included), so revoking
    // `<blobURL>#frag` does NOT revoke the base entry — only fetch *resolution*
    // ignores the fragment (see resolveBlobBytes).
    const key = String(url);
    blobs.delete(key);
    try { globalThis.__csim_blobUnregister(key); } catch (_) {}
  };
  globalThis.URL.__csimBlobInstalled = true;
}

// `__csimReadBlobBase64` is a Ruby-side reachable global — Browser#
// host calls it to extract a blob URL's bytes when serving downloads.
globalThis.__csimReadBlobBase64 = function (url) {
  // Fragment is not part of the blob resource identity (matches resolveBlobBytes).
  const blob = blobs.get(String(url).split('#')[0]);
  if (!blob) return null;
  try { return globalThis.btoa(blobBytes(blob)); } catch (_) { return null; }
};
