// Blob / File + byte helpers + URL.createObjectURL / revokeObjectURL +
// multipart/form-data serializer.

import { bytesToLatin1, latin1ToBytes, bytesToArrayBuffer } from './bytes.js';
import { hasWorkers }                        from './workers.js';
import { convertBlobArguments, convertFileArguments, installBlob, installFile } from './generated/bindings.js';
import { makeSlots, registerInterface, resolvedPromise, slotsOf } from './webidl.js';
import { location } from './location.js';
//
// Blob bodies are stored as latin-1 byte strings (one char per byte,
// 0-255) so the engine marshalling boundary survives
// arbitrary binary payloads. A host-backed File (uploaded via
// `attach_file`) holds the range of the Ruby `read_file_pick` slot instead
// (its slots' `host`) — text / arrayBuffer / slice resolve through
// `__csimReadFilePick`.
//
// URL.createObjectURL also registers the bytes with the Ruby-side
// `blob_register` host fn so Worker isolates (which see an empty
// `__csimBlobs` Map) can resolve `blob:` URLs via the fallback in
// `resolveBlobBytes`. The bytes are left out when no other context
// could resolve the URL, saving a copy per File pick on the hot path.

// Local Map keyed by blob: URLs created in this isolate. Lives on
// `globalThis` so subsequent installs (visit() rebuilds the VM) share
// the same table.
const blobs = globalThis.__csimBlobs = globalThis.__csimBlobs || new Map();
globalThis.__csimBlobCounter = globalThis.__csimBlobCounter || { n: 0 };

// A Blob's bytes: its own — a latin-1 byte string — or, for a File the user picked (`attach_file`'s, a `drop`'s), the
// range of the pick the Ruby side holds (`host`: {handle, index, start, end}), read when asked for
// (`__csimReadFilePick`).
// (…null where the pick cannot be read — the file gone from the disk)
function readHostFile(host) {
  if (typeof globalThis.__csimReadFilePick !== 'function') return null;
  const bytes = globalThis.__csimReadFilePick(host.handle, host.index, host.start, host.end);
  return bytes == null ? null : bytesToLatin1(bytes);
}

// Blob and File (File API §3-4), generated from their IDL: a blob's state its internal slots — its bytes or the
// picked file's range, its size and type; a file's its name and last-modified time besides — any realm's code's to
// read (`blobOf`, `fileOf`).
export const blobOf = (o) => slotsOf(o, 'Blob');
const fileOf = (o) => slotsOf(o, 'File');
// …what the modules that take a blob ask of one, of its slots — not of properties a page could shadow on it.
export const isBlob = (o) => blobOf(o) !== undefined;
export const isFile = (o) => fileOf(o) !== undefined;
export const blobType = (blob) => blobOf(blob).type;
export const blobSize = (blob) => blobOf(blob).size;
export const fileName = (file) => fileOf(file).name;
export const fileLastModified = (file) => fileOf(file).lastModified;

// The bytes of a blob of any realm, as a latin-1 byte string ('' for anything else).
export function blobBytes(blob) {
  return readBlob(blob) ?? '';
}
// …or null where they cannot be read — a picked file gone from the disk — which a FileReader reports as a
// NotReadableError.
export function readBlob(blob) {
  const s = blobOf(blob);
  if (!s) return '';
  return s.host ? readHostFile(s.host) : s.bytes;
}
// …and the picked file's range a blob reads, or null for one whose bytes are its own: what a form submission names
// to the Ruby side rather than copy (form-fields.js).
export function blobHost(blob) {
  const s = blobOf(blob);
  return s ? s.host : null;
}

// The Blob construction steps (§3.1) over the converted parts: a string UTF-8 encoded, its line endings the native
// ones where `endings` is "native" (\n here); a buffer's bytes and a blob's taken as they are — a detached buffer's, a
// view's over one, none.
function processBlobParts(parts, endings) {
  let bytes = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part === 'string') {
      bytes += utf8Latin1(endings === 'native' ? part.replace(/\r\n|\r|\n/g, '\n') : part);
    } else if (blobOf(part)) {
      bytes += blobBytes(part);
    } else if (ArrayBuffer.isView(part)) {
      if (!part.buffer.detached) bytes += bytesToLatin1(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    } else if (!part.detached) {
      bytes += bytesToLatin1(new Uint8Array(part));
    }
  }
  return bytes;
}

// A blob's `type`: ASCII-lowercased, but the empty string where any code point is outside U+0020..U+007E.
function normalizeBlobType(t) {
  if (t === undefined) return '';
  return /^[ -~]*$/.test(t) ? t.toLowerCase() : '';
}

// (…File's hand-off of its arguments converted already: `super(CONVERTED, fileBits, options)`)
const CONVERTED = {};
// A blob's slots name the Blob.prototype of the realm that made it (`proto`), where a slice of it is made (§3.3.3: "a
// new Blob in this's relevant realm") — and always a Blob, never a File.
export class Blob {
  constructor(blobParts, options) {
    if (blobParts !== CONVERTED) [blobParts, options] = convertBlobArguments(arguments);
    else [blobParts, options] = [options, arguments[2]];
    const bytes = processBlobParts(blobParts || [], options.endings);
    makeSlots(this, 'Blob', { bytes, host: null, size: bytes.length, type: normalizeBlobType(options.type), proto: Blob.prototype });
  }
}
registerInterface('Blob', (o) => blobOf(o) !== undefined);

// A blob made of `bytes` verbatim (a latin-1 byte string, no UTF-8 encoding: a slice's, a host's) under `proto` — the
// Blob.prototype of the realm making it.
function blobFromBytes(proto, bytes, type) {
  const blob = Object.create(proto);
  makeSlots(blob, 'Blob', { bytes, host: null, size: bytes.length, type: normalizeBlobType(type), proto });
  return blob;
}

// The blob's text: its bytes UTF-8-decoded — whatever charset its type names.
function blobText(blob) {
  return new globalThis.TextDecoder().decode(latin1ToBytes(blobBytes(blob)));
}

installBlob(Blob, {
  get_size: (blob) => blobOf(blob).size,
  get_type: (blob) => blobOf(blob).type,
  // (…relative indexes, negative ones from the end, clamped to the blob; its type the one given, or none)
  slice(blob, start, end, contentType) {
    const s = blobOf(blob), size = s.size;
    const from = start === undefined ? 0 : start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    const to = end === undefined ? size : end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
    const span = Math.max(to - from, 0);
    if (s.host) {
      const sliced = Object.create(s.proto);
      const host = { ...s.host, start: s.host.start + from, end: s.host.start + from + span };
      makeSlots(sliced, 'Blob', { bytes: '', host, size: span, type: normalizeBlobType(contentType), proto: s.proto });
      return sliced;
    }
    return blobFromBytes(s.proto, s.bytes.substr(from, span), contentType);
  },
  // (…a byte stream of its bytes — a BYOB reader's too — in one chunk, then closed)
  stream(blob) {
    const bytes = latin1ToBytes(blobBytes(blob));
    let pulled = false;
    return new globalThis.ReadableStream({
      type: 'bytes',
      pull(controller) {
        if (!pulled) { pulled = true; if (bytes.length) controller.enqueue(bytes); }
        controller.close();
      }
    });
  },
  text: (blob) => resolvedPromise(blobText(blob)),
  arrayBuffer: (blob) => resolvedPromise(bytesToArrayBuffer(blobBytes(blob))),
  bytes: (blob) => resolvedPromise(latin1ToBytes(blobBytes(blob))),
  // (…a stream of its text, in one chunk, then closed)
  textStream(blob) {
    const text = blobText(blob);
    let pulled = false;
    return new globalThis.ReadableStream({
      pull(controller) {
        if (!pulled) { pulled = true; if (text.length) controller.enqueue(text); }
        controller.close();
      }
    });
  }
});

export class File extends Blob {
  constructor(fileBits, fileName, options) {
    [fileBits, fileName, options] = convertFileArguments(arguments);
    super(CONVERTED, fileBits, options);
    makeSlots(this, 'File', { name: fileName, lastModified: options.lastModified ?? Date.now() });
  }
}
registerInterface('File', (o) => fileOf(o) !== undefined);
installFile(File, {
  get_name: (file) => fileOf(file).name,
  get_lastModified: (file) => fileOf(file).lastModified,
  // (…no directory is picked: a file's path within one is the empty string)
  get_webkitRelativePath: () => ''
});

// A new File object over `file`'s data — a picked file's still the pick's, unread (DataTransferItem's getAsFile()).
export function copyFile(file) {
  const f = fileOf(file), b = blobOf(file);
  const copy = new File([], f.name, { type: b.type, lastModified: f.lastModified });
  Object.assign(blobOf(copy), { bytes: b.bytes, host: b.host && { ...b.host }, size: b.size });
  return copy;
}

// A File the user picked from disk — `attach_file`'s, a `drop`'s — from the Ruby side's {name, size, type,
// lastModified}: its bytes read when asked for from the pick `handle` names (ActiveStorage's DirectUpload MD5-chunks it
// through `slice` + `FileReader.readAsArrayBuffer`, so it slices and reads as any blob does).
export function hostBackedFile(info, handle, index) {
  const size = Number(info.size || 0);
  const file = new File([], String(info.name || ''), { type: String(info.type || ''), lastModified: Number(info.lastModified || 0) });
  Object.assign(blobOf(file), { host: { handle, index, start: 0, end: size }, size });
  return file;
}

// Encode a JS string as UTF-8 bytes returned as a latin-1 byte-string, so field
// names / values / filenames with non-ASCII characters (Japanese labels, emoji,
// the submit button's localized value) keep the whole multipart body in the
// 0-255 range — one byte per char, as the latin-1 byte string it is.
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

// An entry list (a FormData's: [name, value] pairs, a value a string or a File) as
// multipart/form-data. `toBytes(str)` converts a field name / filename / string
// value to its output byte string. It defaults to the UTF-8 encoder (the only
// encoding fetch / FormData.send use); the form-submission path passes a legacy
// single-byte encoder when the form's accept-charset selects one (unrepresentable
// code points → `&#N;`). The structural bytes (boundary, CRLF, headers) are ASCII.
export function serializeMultipart(entries, toBytes) {
  toBytes = toBytes || utf8Latin1;
  const boundary = '----csimFormBoundary' + Math.random().toString(36).slice(2);
  let body = '';
  for (const [key, value] of entries) {
    const name = toBytes(escapeFormField(normalizeNewlines(key)));
    body += '--' + boundary + '\r\n';
    if (blobOf(value)) {
      const filename    = toBytes(escapeFormField(isFile(value) ? fileName(value) : 'blob'));
      const contentType = blobType(value) || 'application/octet-stream';
      body += 'Content-Disposition: form-data; name="' + name + '"; filename="' + filename + '"\r\n';
      body += 'Content-Type: ' + contentType + '\r\n\r\n';
      body += blobBytes(value);   // already a latin-1 byte-string
      body += '\r\n';
    } else {
      body += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n';
      body += toBytes(normalizeNewlines(value)) + '\r\n';
    }
  }
  body += '--' + boundary + '--\r\n';
  return { body, boundary };
}

globalThis.__csimResolveBlobBytes = (url) => resolveBlobBytes(url);
export function resolveBlobBytes(url) {
  // A blob: URL's fragment is not part of the resource identity (fetching
  // `<blobURL>#frag` succeeds), but a query string or extra path is — those make
  // it a different, unregistered URL that must NOT resolve. So strip only the
  // fragment before the registry lookup.
  const key = String(url).split('#')[0];
  // The host registry is the CROSS-REALM authority for a blob URL's validity: a
  // revoke in another frame/worker removes the entry there, so a URL the local
  // realm still has cached must be treated as gone. Query it first; only if the
  // host call itself fails do we fall back to the local map (so a missing host fn
  // never silently breaks same-realm blob URLs).
  let hostVal, hostOk = true;
  try { hostVal = globalThis.__csim_blobResolve(key); } catch (_) { hostOk = false; }
  if (hostOk && hostVal == null) return null;   // revoked (here or in another realm) / never created
  const blob = blobs.get(key);
  if (blob) return { bytes: blobBytes(blob), type: blobType(blob) };   // the blob's own type ('' when untyped)
  if (hostVal == null || hostVal.length === 0) return null;   // existence marker only, no cross-realm bytes
  return { bytes: bytesToLatin1(hostVal), type: 'application/octet-stream' };
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

// URL.createObjectURL / revokeObjectURL (File API §8), the static operations the URL binding answers with (url.js).
// (…`blob` any realm's Blob — the binding's `(Blob or MediaSource)`, and no MediaSource is made here)
export function createObjectURL(blob) {
  // Spec format: `blob:` + the settings object's origin + `/` + a UUID. Parsing
  // it back yields protocol "blob:", an empty host, and the document origin.
  const origin = location.origin || 'null';
  const url = 'blob:' + origin + '/' + blobUuid();
  blobs.set(url, blob);
  // Register the URL's existence with the cross-context host registry so a revoke
  // in ANY realm/isolate is visible everywhere (resolveBlobBytes treats host-
  // absence as revoked). Carry the bytes when ANOTHER context might resolve
  // them: a worker (cross-isolate) OR a frame realm (cross-realm — the parent
  // fetches a blob URL the iframe created); otherwise a cheap existence marker
  // keeps single-realm createObjectURL from copying them. A blob URL
  // created INSIDE a frame realm is tagged with that realm id so it's revoked
  // when the iframe is removed (url-lifetime "Removing an iframe").
  const crossCtx = hasWorkers() || (globalThis.__csimMultiRealm && globalThis.__csimMultiRealm());
  let ownerRealm = null;
  if (globalThis.__csimTop && globalThis.__csimTop !== globalThis) {
    try { ownerRealm = globalThis.RustyRacer.contextOf(globalThis); } catch (_) {}
  }
  try { globalThis.__csim_blobRegister(url, crossCtx ? latin1ToBytes(blobBytes(blob)) : null, ownerRealm); } catch (_) {}
  return url;
}
export function revokeObjectURL(url) {
  // Revocation matches the entry EXACTLY (fragment included), so revoking
  // `<blobURL>#frag` does NOT revoke the base entry — only fetch *resolution*
  // ignores the fragment (see resolveBlobBytes).
  const key = String(url);
  // Blob URLs are origin-partitioned: a `blob:<origin>/<uuid>` may only be revoked
  // from a context whose origin matches the URL's. Revoking from a CONCRETE
  // cross-origin context is a no-op — it must not touch the creating origin's blob
  // (FileAPI url/cross-global-revoke). The origin sits between `blob:` and the final
  // `/<uuid>` (fragment stripped first — a `#a/b` frag must not be read as the path).
  // Only block when BOTH origins are concrete and differ: an opaque "null" on either
  // side (a srcdoc / about:blank frame reads location.origin as "null" though its
  // document origin is the inherited parent's) falls through and still revokes, as it
  // did before — we don't model opaque-origin partitioning.
  const base = key.split('#')[0];
  const slash = base.lastIndexOf('/');
  const urlOrigin = slash > 5 ? base.slice(5, slash) : '';
  const here = location.origin || 'null';
  if (urlOrigin && urlOrigin !== 'null' && here !== 'null' && urlOrigin !== here) return;
  blobs.delete(key);
  try { globalThis.__csim_blobUnregister(key); } catch (_) {}
}

// `__csimReadBlobBytes` is a Ruby-side reachable global — Browser#
// host calls it to extract a blob URL's bytes when serving downloads.
globalThis.__csimReadBlobBytes = function (url) {
  // Fragment is not part of the blob resource identity (matches resolveBlobBytes).
  const blob = blobs.get(String(url).split('#')[0]);
  return blob ? latin1ToBytes(blobBytes(blob)) : null;
};

// Read a blob URL's bytes AND content type from THIS realm's local
// store — used by the Driver to load a blob: document into a fresh aux WINDOW (a
// separate isolate) opened via `window.open(blobURL)` / `<a target=_blank>`,
// resolving the bytes from the OPENER that created the blob.
globalThis.__csimReadBlobForWindow = function (url) {
  const blob = blobs.get(String(url).split('#')[0]);
  if (blob) return { bytes: latin1ToBytes(blobBytes(blob)), type: blobType(blob) || 'text/html' };
  // Not in this realm: a blob created in a CHILD frame realm (e.g. an iframe that
  // built it) lives in that realm's store. Search descendants so the Driver can
  // resolve a frame-realm-created blob when loading it into another window. The
  // child's own __csimReadBlobForWindow recurses, so grandchildren are covered.
  return globalThis.__csimEachChildRealm(g =>
    (typeof g.__csimReadBlobForWindow === 'function' ? g.__csimReadBlobForWindow(url) : null) || undefined
  ) || null;
};

// Register a blob URL's bytes into THIS realm's local store — used by the Driver
// after loading a blob: document into a window (window.open(blobURL) / navigation),
// so the loaded document can fetch the blob URL as a first-party resource (the blob
// URL entry stays valid in the document it was navigated to). The blob is rebuilt
// from `bytes` verbatim (latin-1, no UTF-8 re-encode). No host re-registration —
// the blob keeps its original partition entry.
globalThis.__csimAdoptBlobBytes = function (url, bytes, type) {
  blobs.set(String(url).split('#')[0], blobFromBytes(Blob.prototype, bytesToLatin1(bytes), type));
};

// Forget a blob URL's bytes in THIS realm's local store — the Driver calls it on the
// creating isolate when another same-partition window revokes a blob this isolate
// created, so this realm stops resolving it (the @blob_registry validity marker is
// dropped Ruby-side alongside).
globalThis.__csimDropBlob = function (url) {
  // EXACT match incl. fragment — revoking `blob:…#frag` must NOT drop the base
  // `blob:…` entry (FileAPI/url "Only exact matches should revoke URLs").
  blobs.delete(String(url));
};
