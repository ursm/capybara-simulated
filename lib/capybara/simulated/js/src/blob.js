// Blob / File + byte helpers + URL.createObjectURL / revokeObjectURL +
// multipart/form-data serializer.

import { bytesToLatin1, exactBuffer } from './bytes.js';
import { hasWorkers }                        from './workers.js';
import { convertBlobArguments, convertFileArguments, installBlob, installFile } from './generated/bindings.js';
import { makeSlots, registerInterface, rejectedPromise, resolvedPromise, slotsOf } from './webidl.js';
import { DOMException } from './dom-exception.js';
import { documentOrigin } from './platform-globals.js';
import { ReadableStream } from './streams.js';
import { platformDateNow } from './timers.js';
//
// A blob's bytes are the engine's (blob_data.rs): an object its slots hold (`data`), made of its parts once and sliced
// without a copy. A host-backed File (uploaded via `attach_file`) holds the range of the Ruby `read_file_pick` slot
// instead (its slots' `host`) — text / arrayBuffer / slice resolve through `__csimReadFilePick`.
//
// URL.createObjectURL also registers the bytes with the Ruby-side
// `blob_register` host fn so Worker isolates (which see none of this
// isolate's blob URL store) can resolve `blob:` URLs via the fallback in
// `resolveBlobBytes`. The bytes are left out when no other context
// could resolve the URL, saving a copy per File pick on the hot path.

// The blob URL store — the blob each URL a realm of this isolate made names, whichever realm asks — the engine's
// (blob_urls.rs): `get` the blob a URL resolves to (its fragment no part of it), `set` its entry, `delete` the entry a
// URL names as it is (revoking `<url>#frag` removes none).
const blobs = {
  get: (url) => globalThis.__dom.blobUrlGet(url),
  set: (url, blob) => globalThis.__dom.blobUrlSet(url, blob),
  delete: (url) => globalThis.__dom.blobUrlDelete(url)
};

// A Blob's bytes: its own — the engine's (`data`) — or, for a File the user picked (`attach_file`'s, a `drop`'s), the
// range of the pick the Ruby side holds (`host`: {handle, index, start, end}), read when asked for
// (`__csimReadFilePick`), as a Uint8Array.
// (…null where the pick cannot be read — the file gone from the disk)
function readHostFile(host) {
  if (typeof globalThis.__csimReadFilePick !== 'function') return null;
  return globalThis.__csimReadFilePick(host.handle, host.index, host.start, host.end) ?? null;
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

// The bytes of a blob of any realm, as a Uint8Array of a copy of them, a script's to keep — or null where they cannot be
// read (a picked file gone from the disk), which a FileReader reports as a NotReadableError.
export function readBlob(blob) {
  const s = blobOf(blob);
  if (!s) return new Uint8Array(0);
  return s.host ? readHostFile(s.host) : globalThis.__dom.blobBytes(s.data);
}
// …an empty one where they cannot be.
export const blobByteArray = (blob) => readBlob(blob) ?? new Uint8Array(0);
// …as a latin-1 byte string, for the modules that still take one.
function blobBytes(blob) {
  const s = blobOf(blob);
  if (s && !s.host) return globalThis.__dom.blobLatin1(s.data);
  return bytesToLatin1(blobByteArray(blob));
}
// …and as the engine's ops take them (blob_data.rs `bytes_arg`): its bytes object, or a picked file's bytes read for it
// — none where they cannot be.
export function engineBytes(blob) {
  const s = blobOf(blob);
  return s.host ? readHostFile(s.host) ?? new Uint8Array(0) : s.data;
}
// …and the picked file's range a blob reads, or null for one whose bytes are its own: what a form submission names
// to the Ruby side rather than copy (form-fields.js).
export function blobHost(blob) {
  const s = blobOf(blob);
  return s ? s.host : null;
}

// The Blob construction steps (§3.1) over the converted parts — the engine's (blob_data.rs `blobMake`): a string's
// bytes UTF-8, its line endings the native ones where `endings` is "native"; a buffer's bytes and a blob's taken as
// they are — a detached buffer's, a view's over one, none; a picked file's read for it.
function processBlobParts(parts, endings) {
  const given = [];
  for (const part of parts) {
    given.push(typeof part === 'object' && isBlob(part) ? engineBytes(part) : part);
  }
  return globalThis.__dom.blobMake(given, endings === 'native');
}

// (…File's hand-off of its arguments converted already: `super(CONVERTED, fileBits, options)`)
const CONVERTED = {};
// A blob's slots name the Blob.prototype of the realm that made it (`proto`), where a slice of it is made (§3.3.3: "a
// new Blob in this's relevant realm") — and always a Blob, never a File.
export class Blob {
  constructor(blobParts, options) {
    if (blobParts !== CONVERTED) [blobParts, options] = convertBlobArguments(arguments);
    else [blobParts, options] = [options, arguments[2]];
    const data = processBlobParts(blobParts || [], options.endings);
    makeSlots(this, 'Blob', { data, host: null, size: globalThis.__dom.blobSize(data), type: globalThis.__dom.blobType(options.type), proto: Blob.prototype });
  }
}
registerInterface('Blob', (o) => blobOf(o) !== undefined);

// A blob of the engine's bytes `data` (a slice's, a host's) under `proto` — the Blob.prototype of the realm making it.
function blobOfData(proto, data, type) {
  const blob = Object.create(proto);
  makeSlots(blob, 'Blob', { data, host: null, size: globalThis.__dom.blobSize(data), type: globalThis.__dom.blobType(type), proto });
  return blob;
}

// The blob's text: its bytes UTF-8-decoded, a BOM removed — whatever charset its type names.
export function blobText(blob) {
  return textOf(blobByteArray(blob));
}
const textOf = (bytes) => globalThis.__dom.textDecode('UTF-8', bytes, false, false);
// …and what a read of them fails with (§3.3.1's read of its stream, FileReader's read operation): a picked file gone from
// the disk.
export const notReadable = () => new DOMException('The requested file could not be read.', 'NotReadableError');
// A promise of what `steps` makes of the blob's bytes, rejected where they cannot be read.
function readBytes(blob, steps) {
  const bytes = readBlob(blob);
  return bytes === null ? rejectedPromise(notReadable()) : resolvedPromise(steps(bytes));
}
// A stream of the blob's bytes, or of `steps`'s chunk of them — a byte stream's (`type` 'bytes') nothing for none — in one
// chunk, then closed; errored where they cannot be read.
function oneChunkStream(blob, type, steps) {
  return new ReadableStream({
    type,
    pull(controller) {
      const bytes = readBlob(blob);
      if (bytes === null) return controller.error(notReadable());
      const chunk = steps(bytes);
      if (chunk.length) controller.enqueue(chunk);
      controller.close();
      // (…a BYOB read of nothing answered done: closing leaves its pull-into pending, which a respond of 0 settles)
      if (type === 'bytes') controller.byobRequest?.respond(0);
    }
  });
}

installBlob(Blob, {
  get_size: (blob) => blobOf(blob).size,
  get_type: (blob) => blobOf(blob).type,
  // (…relative indexes, negative ones from the end, clamped to the blob; its type the one given, or none)
  slice(blob, start, end, contentType) {
    const s = blobOf(blob);
    const [from, span] = globalThis.__dom.blobSliceRange(s.size, start, end);
    if (s.host) {
      const sliced = Object.create(s.proto);
      const host = { ...s.host, start: s.host.start + from, end: s.host.start + from + span };
      makeSlots(sliced, 'Blob', { data: null, host, size: span, type: globalThis.__dom.blobType(contentType), proto: s.proto });
      return sliced;
    }
    return blobOfData(s.proto, globalThis.__dom.blobSlice(s.data, from, span), contentType);
  },
  // (…a byte stream of its bytes — a BYOB reader's too — and one of its text)
  stream: (blob) => oneChunkStream(blob, 'bytes', (bytes) => bytes),
  textStream: (blob) => oneChunkStream(blob, undefined, textOf),
  text: (blob) => readBytes(blob, textOf),
  arrayBuffer: (blob) => readBytes(blob, exactBuffer),
  bytes: (blob) => readBytes(blob, (bytes) => bytes)
});

export class File extends Blob {
  constructor(fileBits, fileName, options) {
    [fileBits, fileName, options] = convertFileArguments(arguments);
    super(CONVERTED, fileBits, options);
    makeSlots(this, 'File', { name: fileName, lastModified: options.lastModified ?? platformDateNow() });
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
  Object.assign(blobOf(copy), { data: b.data, host: b.host && { ...b.host }, size: b.size });
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

// An entry list (a FormData's: [name, value] pairs, a value a string or a File) as multipart/form-data in UTF-8, as
// fetch and XHR send it — the engine's (multipart.rs `encode`).
export function serializeMultipart(entries) {
  const boundary = '----csimFormBoundary' + globalThis.__dom.cryptoRandomUUID().replaceAll('-', '');
  const flat = [];
  for (const [key, value] of entries) {
    flat.push(key, blobOf(value) ? [isFile(value) ? fileName(value) : 'blob', blobType(value), engineBytes(value)] : value);
  }
  return { body: globalThis.__dom.multipartEncode(flat, boundary), boundary };
}

globalThis.__csimResolveBlobBytes = (url) => resolveBlobBytes(url);
export function resolveBlobBytes(url) {
  // A blob: URL's fragment is not part of the resource identity (fetching
  // `<blobURL>#frag` succeeds), but a query string or extra path is — those make
  // it a different, unregistered URL that must NOT resolve: the store's key the
  // engine's (blob_urls.rs `entry_key`), the host registry's too.
  const key = globalThis.__dom.blobUrlKey(String(url));
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

// The response Fetch's scheme fetch makes of the `blob:` URL `url` whose blob `snapshot` names (`resolveBlobBytes`: its
// bytes and type, null for none) for a request of `method` and `range` (its `Range` header's value, or null) — a raw
// response, its body a byte string, or null for a network error: the engine's rules (fetch_rules.rs `blob_response`),
// which fetch() and XHR share.
export function blobResponse(url, snapshot, method, range) {
  if (!snapshot) return null;
  const r = globalThis.__dom.blobResponse(method, range, snapshot.type || '', snapshot.bytes.length);
  if (r === null) return null;
  const [status, contentType, first, end, contentRange] = r;
  const body = first === 0 && end === snapshot.bytes.length ? snapshot.bytes : snapshot.bytes.slice(first, end);
  const headers = { 'content-type': contentType, 'content-length': String(body.length) };
  if (contentRange !== null) headers['content-range'] = contentRange;
  return { status, statusText: status === 206 ? 'Partial Content' : 'OK', url: String(url), headers, body };
}

// URL.createObjectURL / revokeObjectURL (File API §8), the static operations the URL binding answers with (url.js).
// (…`blob` any realm's Blob — the binding's `(Blob or MediaSource)`, and no MediaSource is made here)
export function createObjectURL(blob) {
  // Spec format: `blob:` + the settings object's origin + `/` + a UUID — a document's own, which an about:blank or
  // srcdoc one inherits. Parsing it back yields protocol "blob:", an empty host, and that origin.
  const origin = documentOrigin() || 'null';
  const url = 'blob:' + origin + '/' + globalThis.__dom.cryptoRandomUUID();
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
  try { globalThis.__csim_blobRegister(url, crossCtx ? blobByteArray(blob) : null, ownerRealm); } catch (_) {}
  return url;
}
export function revokeObjectURL(url) {
  // Revocation matches the entry EXACTLY (fragment included), so revoking
  // `<blobURL>#frag` does NOT revoke the base entry — only fetch *resolution*
  // ignores the fragment (see resolveBlobBytes).
  const key = globalThis.__dom.blobUrlKey(String(url), true);
  // Blob URLs are origin-partitioned: a `blob:<origin>/<uuid>` may only be revoked from a context of its origin — a
  // revoke from a CONCRETE cross-origin one a no-op, which must not touch the creating origin's blob (FileAPI
  // url/cross-global-revoke); an opaque origin on either side revokes (blob_rules.rs `revocable`, by the document's
  // origin, which a srcdoc / about:blank one inherits).
  if (!globalThis.__dom.blobUrlRevocable(key)) return;
  blobs.delete(key);
  try { globalThis.__csim_blobUnregister(key); } catch (_) {}
}

// `__csimReadBlobBytes` is a Ruby-side reachable global — Browser#
// host calls it to extract a blob URL's bytes when serving downloads.
globalThis.__csimReadBlobBytes = function (url) {
  // (…its fragment no part of the blob's identity: the store resolves it as resolveBlobBytes does)
  const blob = blobs.get(String(url));
  return blob ? blobByteArray(blob) : null;
};

// Read a blob URL's bytes AND content type from the isolate's store — used by the Driver to load a blob: document into a
// fresh aux WINDOW (a separate isolate) opened via `window.open(blobURL)` / `<a target=_blank>`, resolving the bytes
// from the OPENER's isolate, whichever of its realms — a frame's too — created the blob.
globalThis.__csimReadBlobForWindow = function (url) {
  const blob = blobs.get(String(url));
  return blob ? { bytes: blobByteArray(blob), type: blobType(blob) || 'text/html' } : null;
};

// Register a blob URL's bytes into THIS realm's local store — used by the Driver
// after loading a blob: document into a window (window.open(blobURL) / navigation),
// so the loaded document can fetch the blob URL as a first-party resource (the blob
// URL entry stays valid in the document it was navigated to). The blob is made of
// `bytes` (a Uint8Array) as they are. No host re-registration —
// the blob keeps its original partition entry.
globalThis.__csimAdoptBlobBytes = function (url, bytes, type) {
  blobs.set(String(url), blobOfData(Blob.prototype, globalThis.__dom.blobMake([bytes], false), type));
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
