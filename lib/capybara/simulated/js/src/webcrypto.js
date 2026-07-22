// Web Crypto API — `crypto` (Crypto), `crypto.subtle` (SubtleCrypto), and
// CryptoKey. The JS side owns the *contract* (algorithm normalization, CryptoKey
// objects, key-usage validation, the DOMException error grammar, Promise
// wrapping); the raw primitives are delegated to Ruby's OpenSSL through host
// functions (the same model as the original `__csim_subtleDigest`). Splitting it
// this way keeps every spec subtlety — case-insensitive algorithm names, the
// "normalize algorithm, THEN copy the data bytes" ordering, NotSupportedError vs
// TypeError vs InvalidAccessError vs OperationError — in one auditable place,
// matched against the vendored WebCryptoAPI web-platform-tests.
//
// Each algorithm is a self-contained object in ALGORITHMS keyed by canonical
// name, declaring which operations it supports (`normalize.<op>` present) and how
// to perform them. SubtleCrypto's methods are thin: normalize, validate, dispatch
// to the algorithm object. Adding an algorithm (AES / RSA / EC) is adding one
// entry, never touching the dispatch.
//
// App value: JWT (jose, HS/RS/ES256), OIDC (oidc-client-ts), and Web Push (ECDH +
// HKDF + AES-GCM) all ride on SubtleCrypto.

import { QuotaExceededError } from './events.js';

function domError(message, name) {
  return new globalThis.DOMException(message, name);
}

// ── BufferSource helpers ────────────────────────────────────────────────────
// Snapshot the bytes held by a BufferSource (ArrayBuffer / typed-array view /
// DataView) into a plain Array the host functions can pack. Per the Web Crypto
// spec every operation "gets a copy of the bytes" of its input, so later mutation
// of the caller's buffer can't affect an in-flight call. A *detached* buffer
// (transferred mid-call) holds zero bytes — reading it must yield an empty array,
// never throw, which is what the digest/HMAC transferred-buffer subtests assert.
function copyBytes(src) {
  if (src == null) return [];
  let view;
  if (src instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && src instanceof SharedArrayBuffer)) {
    if (src.byteLength === 0) return [];
    view = new Uint8Array(src);
  } else if (ArrayBuffer.isView(src)) {
    if (src.byteLength === 0) return [];   // detached view → empty (never throw)
    view = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  } else {
    return [];
  }
  const out = new Array(view.length);
  for (let i = 0; i < view.length; i++) out[i] = view[i];
  return out;
}

// Wrap a byte Array coming back from a host function as a fresh ArrayBuffer, the
// return type every SubtleCrypto data operation resolves to.
function bytesToArrayBuffer(bytes) {
  const arr = Array.isArray(bytes) ? bytes : [];
  const buf = new ArrayBuffer(arr.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) view[i] = arr[i] & 0xff;
  return buf;
}

// Constant-time-ish byte-array equality (length-checked first; the tests only
// need the correct boolean, and HMAC verify is not a timing-oracle target here).
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// base64url <-> bytes, for JWK `k` / `n` / `e` / … fields. btoa/atob operate on a
// binary string (one char per byte); JWK uses the URL-safe alphabet with padding
// stripped.
function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] & 0xff);
  return globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = globalThis.atob(s);
  const out = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

// ── CryptoKey ───────────────────────────────────────────────────────────────
// The opaque handle to keying material. Public surface is the four read-only
// attributes (type / extractable / algorithm / usages); the raw material lives in
// a Symbol-keyed internal slot so page script can't read it off the object.
const KEY_MATERIAL = Symbol('[[material]]');

class CryptoKey {
  constructor(type, extractable, algorithm, usages, material) {
    Object.defineProperty(this, 'type', { value: type, enumerable: true });
    Object.defineProperty(this, 'extractable', { value: !!extractable, enumerable: true });
    Object.defineProperty(this, 'algorithm', { value: algorithm, enumerable: true });
    Object.defineProperty(this, 'usages', { value: Object.freeze(usages.slice()), enumerable: true });
    Object.defineProperty(this, KEY_MATERIAL, { value: material });
  }

  get [Symbol.toStringTag]() { return 'CryptoKey'; }
}

function keyMaterial(key) { return key[KEY_MATERIAL]; }

// Deep-copy a key's algorithm dictionary, preserving the typed arrays it may hold
// (RSA's publicExponent). Used when structured-cloning a CryptoKey.
function cloneKeyAlgorithm(a) {
  if (a instanceof Uint8Array) return a.slice();
  if (Array.isArray(a)) return a.map(cloneKeyAlgorithm);
  if (a && typeof a === 'object') {
    const out = {};
    for (const k of Object.keys(a)) out[k] = cloneKeyAlgorithm(a[k]);
    return out;
  }
  return a;
}

// CryptoKey is [Serializable]: structuredClone / postMessage / IndexedDB duplicate
// it into a fresh key with copies of the algorithm and key material. Exposed as a
// host-visible hook so the structured-clone walker (platform-globals.js) can reach
// the Symbol-slotted material without a circular import.
function cloneCryptoKey(key) {
  const material = keyMaterial(key);
  return new CryptoKey(
    key.type, key.extractable, cloneKeyAlgorithm(key.algorithm), key.usages.slice(),
    Array.isArray(material) ? material.slice() : material
  );
}

// A JWK marked non-extractable (`ext: false`) may not be imported as an extractable
// key — a DataError. Shared across every algorithm's jwk import path.
function checkJwkExtractable(jwk, extractable) {
  if (jwk.ext === false && extractable) throw domError('JWK is not extractable', 'DataError');
}

// Normalize a caller's key `usages` sequence: reject anything outside the
// algorithm's allowed set (SyntaxError, per spec), de-duplicate, and keep the
// canonical order. An empty set for a key that requires usages is the caller's
// concern (checked per-algorithm).
const USAGE_ORDER = ['encrypt', 'decrypt', 'sign', 'verify', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey'];
function normalizeUsages(usages, allowed) {
  const seq = Array.from(usages || []);
  for (const u of seq) {
    if (allowed.indexOf(u) === -1) {
      throw domError(`Unsupported key usage "${u}" for this algorithm`, 'SyntaxError');
    }
  }
  return USAGE_ORDER.filter((u) => seq.indexOf(u) !== -1);
}

// ── Algorithm normalization ─────────────────────────────────────────────────
// "Normalize an algorithm" maps the caller's argument (a string or a dictionary)
// for a given operation to a canonical, validated dictionary. An unrecognized
// name for the operation is a NotSupportedError; a non-object / missing-name
// argument is a TypeError. Names are case-insensitive.
function normalizeAlgorithm(op, alg) {
  let dict;
  if (typeof alg === 'string') {
    dict = { name: alg };
  } else if (alg && typeof alg === 'object') {
    dict = alg;
  } else {
    throw new TypeError('Algorithm: must be a string or an object');
  }
  const name = dict.name;   // may run a caller getter (spec-observable ordering)
  if (typeof name !== 'string') {
    throw new TypeError('Algorithm: a name is required');
  }
  const entry = ALGORITHMS[name.toUpperCase()];
  if (!entry || !entry.normalize || typeof entry.normalize[op] !== 'function') {
    throw domError(`Unrecognized algorithm name "${name}" for operation "${op}"`, 'NotSupportedError');
  }
  const params = entry.normalize[op](dict) || {};
  params.name = entry.name;
  return params;
}

// ── Digest (SHA-*) ──────────────────────────────────────────────────────────
function shaAlgorithm(name) {
  return { name, normalize: { digest: () => ({}) } };
}

function hostDigest(hashName, bytes) {
  const fn = globalThis.__csim_subtleDigest;
  if (typeof fn !== 'function') throw domError('digest unavailable', 'OperationError');
  return fn(hashName, bytes);
}

// ── HMAC ────────────────────────────────────────────────────────────────────
// The input block size (in bits) of each hash — HMAC's default key length when
// `length` is omitted, which is what generateKey and importKey report.
const HMAC_BLOCK_BITS = { 'SHA-1': 512, 'SHA-256': 512, 'SHA-384': 1024, 'SHA-512': 1024 };
const HMAC_USAGES = ['sign', 'verify'];

const HMAC = {
  name: 'HMAC',
  normalize: {
    sign:        () => ({}),
    verify:      () => ({}),
    importKey:   (d) => ({ hash: normalizeAlgorithm('digest', d.hash), length: d.length }),
    generateKey: (d) => ({ hash: normalizeAlgorithm('digest', d.hash), length: d.length }),
  },

  importKey(format, keyData, params, extractable, usages) {
    const use = normalizeUsages(usages, HMAC_USAGES);
    if (use.length === 0) throw domError('HMAC key import requires at least one usage', 'SyntaxError');
    let raw;
    if (format === 'raw') {
      raw = copyBytes(keyData);
    } else if (format === 'jwk') {
      const jwk = keyData;
      if (!jwk || jwk.kty !== 'oct' || typeof jwk.k !== 'string') throw domError('Invalid HMAC JWK', 'DataError');
      checkJwkExtractable(jwk, extractable);
      raw = base64UrlToBytes(jwk.k);
    } else {
      throw domError(`Unsupported key format "${format}" for HMAC`, 'NotSupportedError');
    }
    let length = raw.length * 8;
    if (params.length !== undefined && params.length !== null) {
      // A specified length must match the supplied key material (spec: DataError
      // if it is not a whole-byte truncation of it). We only support byte-aligned.
      if (params.length > length || params.length <= length - 8) throw domError('Invalid HMAC key length', 'DataError');
      length = params.length;
    }
    if (length === 0) throw domError('HMAC key data must not be empty', 'DataError');
    const algorithm = { name: 'HMAC', hash: { name: params.hash.name }, length };
    return new CryptoKey('secret', extractable, algorithm, use, raw);
  },

  exportKey(format, key) {
    const raw = keyMaterial(key);
    if (format === 'raw') return bytesToArrayBuffer(raw);
    if (format === 'jwk') {
      return {
        kty: 'oct',
        k: bytesToBase64Url(raw),
        alg: 'HS' + key.algorithm.hash.name.slice(4),   // SHA-256 -> HS256
        key_ops: key.usages.slice(),
        ext: key.extractable,
      };
    }
    throw domError(`Unsupported export format "${format}" for HMAC`, 'NotSupportedError');
  },

  generateKey(params, extractable, usages) {
    const use = normalizeUsages(usages, HMAC_USAGES);
    if (use.length === 0) throw domError('HMAC key generation requires at least one usage', 'SyntaxError');
    const hashName = params.hash.name;
    let length = params.length;
    if (length === undefined || length === null) length = HMAC_BLOCK_BITS[hashName];
    if (length === 0) throw domError('HMAC key length must not be zero', 'OperationError');
    const nbytes = Math.ceil(length / 8);
    const bytesFn = globalThis.__csim_randomBytes;
    const raw = typeof bytesFn === 'function' ? bytesFn(nbytes) : new Array(nbytes).fill(0);
    const algorithm = { name: 'HMAC', hash: { name: hashName }, length };
    return new CryptoKey('secret', extractable, algorithm, use, Array.from(raw));
  },

  sign(params, key, dataBytes) {
    const fn = globalThis.__csim_hmacSign;
    if (typeof fn !== 'function') throw domError('HMAC unavailable', 'OperationError');
    const hashName = key.algorithm.hash.name.toUpperCase().replace('-', '');
    return bytesToArrayBuffer(fn(hashName, keyMaterial(key), dataBytes));
  },

  verify(params, key, signatureBytes, dataBytes) {
    const fn = globalThis.__csim_hmacSign;
    if (typeof fn !== 'function') throw domError('HMAC unavailable', 'OperationError');
    const hashName = key.algorithm.hash.name.toUpperCase().replace('-', '');
    const mac = fn(hashName, keyMaterial(key), dataBytes);
    return bytesEqual(mac, signatureBytes);
  },
};

// ── AES (CBC / CTR / GCM) ───────────────────────────────────────────────────
// The three block-cipher modes share key import / export / generation and differ
// only in their per-operation parameters (iv / counter+length / iv+aad+tagLength)
// and OpenSSL cipher suffix. `aesAlgorithm(name, mode)` builds one registry entry
// per mode; AES-KW (key wrapping) is a later increment.
// AES-CBC/CTR/GCM keys may encrypt/decrypt and wrap; an AES-KW key only wraps.
function aesAllowedUsages(name) {
  return name === 'AES-KW' ? ['wrapKey', 'unwrapKey'] : ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'];
}
const AES_KEY_BITS = { 16: 128, 24: 192, 32: 256 };
const GCM_TAG_LENGTHS = [32, 64, 96, 104, 112, 120, 128];

function aesCipherName(keyByteLen, mode) {
  const bits = AES_KEY_BITS[keyByteLen];
  return `aes-${bits}-${mode}`;
}

function aesJwkAlg(mode, bits) {
  return 'A' + bits + { cbc: 'CBC', ctr: 'CTR', gcm: 'GCM', kw: 'KW' }[mode];
}

function aesImportKey(name, mode, format, keyData, extractable, usages) {
  const use = normalizeUsages(usages, aesAllowedUsages(name));
  if (use.length === 0) throw domError('AES key import requires at least one usage', 'SyntaxError');
  let raw;
  if (format === 'raw') {
    raw = copyBytes(keyData);
  } else if (format === 'jwk') {
    const jwk = keyData;
    if (!jwk || jwk.kty !== 'oct' || typeof jwk.k !== 'string') throw domError('Invalid AES JWK', 'DataError');
    checkJwkExtractable(jwk, extractable);
    raw = base64UrlToBytes(jwk.k);
  } else {
    throw domError(`Unsupported key format "${format}" for ${name}`, 'NotSupportedError');
  }
  const bits = AES_KEY_BITS[raw.length];
  if (!bits) throw domError('AES key data must be 128, 192, or 256 bits', 'DataError');
  return new CryptoKey('secret', extractable, { name, length: bits }, use, raw);
}

function aesExportKey(name, mode, format, key) {
  const raw = keyMaterial(key);
  if (format === 'raw') return bytesToArrayBuffer(raw);
  if (format === 'jwk') {
    return {
      kty: 'oct',
      k: bytesToBase64Url(raw),
      alg: aesJwkAlg(mode, key.algorithm.length),
      key_ops: key.usages.slice(),
      ext: key.extractable,
    };
  }
  throw domError(`Unsupported export format "${format}" for ${name}`, 'NotSupportedError');
}

function aesGenerateKey(name, params, extractable, usages) {
  const use = normalizeUsages(usages, aesAllowedUsages(name));
  if (use.length === 0) throw domError('AES key generation requires at least one usage', 'SyntaxError');
  const bits = params.length;
  if (!AES_KEY_BITS[bits / 8]) throw domError('AES key length must be 128, 192, or 256 bits', 'OperationError');
  const bytesFn = globalThis.__csim_randomBytes;
  const raw = typeof bytesFn === 'function' ? bytesFn(bits / 8) : new Array(bits / 8).fill(0);
  return new CryptoKey('secret', extractable, { name, length: bits }, use, Array.from(raw));
}

function aesCryptParams(mode, dict) {
  if (mode === 'cbc') return { iv: dict.iv };
  if (mode === 'ctr') return { counter: dict.counter, length: dict.length };
  return { iv: dict.iv, additionalData: dict.additionalData, tagLength: dict.tagLength };
}

// Run an AES encrypt/decrypt through the host cipher, mapping the normalized
// per-mode parameters to the host argument list (cipher, key, iv, data, aad,
// tagBytes). CBC/CTR carry no AEAD tag (tagBytes 0, empty aad); GCM validates the
// tag length and passes the additional data. All BufferSource parameters are
// copied here (after algorithm normalization) so a mid-call mutation can't affect
// the operation.
function aesRun(hostFn, mode, key, params, dataBytes) {
  const keyBytes = keyMaterial(key);
  const cipher = aesCipherName(keyBytes.length, mode);
  if (mode === 'cbc') {
    const iv = copyBytes(params.iv);
    if (iv.length !== 16) throw domError('AES-CBC iv must be 16 bytes', 'OperationError');
    return bytesToArrayBuffer(hostFn(cipher, keyBytes, iv, dataBytes, [], 0));
  }
  if (mode === 'ctr') {
    if (params.length === 0 || params.length > 128) {
      throw domError('AES-CTR length must be between 1 and 128', 'OperationError');
    }
    return bytesToArrayBuffer(hostFn(cipher, keyBytes, copyBytes(params.counter), dataBytes, [], 0));
  }
  // gcm
  const tagLen = params.tagLength === undefined ? 128 : params.tagLength;
  if (GCM_TAG_LENGTHS.indexOf(tagLen) === -1) throw domError('Invalid AES-GCM tag length', 'OperationError');
  const aad = params.additionalData != null ? copyBytes(params.additionalData) : [];
  return bytesToArrayBuffer(hostFn(cipher, keyBytes, copyBytes(params.iv), dataBytes, aad, tagLen / 8));
}

function aesAlgorithm(name, mode) {
  const normParams = (dict) => aesCryptParams(mode, dict);
  return {
    name,
    mode,
    normalize: {
      encrypt: normParams,
      decrypt: normParams,
      wrapKey: normParams,
      unwrapKey: normParams,
      importKey: () => ({}),
      generateKey: (d) => ({ length: d.length }),
    },
    importKey: (format, keyData, params, extractable, usages) =>
      aesImportKey(name, mode, format, keyData, extractable, usages),
    exportKey: (format, key) => aesExportKey(name, mode, format, key),
    generateKey: (params, extractable, usages) => aesGenerateKey(name, params, extractable, usages),
    encrypt: (params, key, dataBytes) => aesRun(globalThis.__csim_aesEncrypt, mode, key, params, dataBytes),
    decrypt(params, key, dataBytes) {
      try {
        return aesRun(globalThis.__csim_aesDecrypt, mode, key, params, dataBytes);
      } catch (e) {
        if (e && e.name && e.name !== 'Error') throw e;   // DOMException (bad tag length) → propagate
        throw domError(`decryption failed: ${e && e.message}`, 'OperationError');
      }
    },
  };
}

// AES-KW (RFC 3394 key wrap). Unlike the other AES modes it has no encrypt/decrypt
// surface — it exists only to wrap and unwrap other keys, via a dedicated host
// primitive. `wrapBytes` / `unwrapBytes` are the hooks SubtleCrypto.wrapKey /
// unwrapKey reach for in place of encrypt / decrypt.
const AES_KW = {
  name: 'AES-KW',
  normalize: {
    wrapKey: () => ({}),
    unwrapKey: () => ({}),
    importKey: () => ({}),
    generateKey: (d) => ({ length: d.length }),
  },
  importKey: (format, keyData, params, extractable, usages) =>
    aesImportKey('AES-KW', 'kw', format, keyData, extractable, usages),
  exportKey: (format, key) => aesExportKey('AES-KW', 'kw', format, key),
  generateKey: (params, extractable, usages) => aesGenerateKey('AES-KW', params, extractable, usages),
  wrapBytes(params, key, bytes) {
    try {
      return bytesToArrayBuffer(hostCall('__csim_aesKwWrap', keyMaterial(key), bytes));
    } catch (e) {
      if (e && e.name && e.name !== 'Error') throw e;
      throw domError(`key wrap failed: ${e && e.message}`, 'OperationError');   // e.g. data not a multiple of 8 bytes
    }
  },
  unwrapBytes(params, key, bytes) {
    try {
      return bytesToArrayBuffer(hostCall('__csim_aesKwUnwrap', keyMaterial(key), bytes));
    } catch (e) {
      if (e && e.name && e.name !== 'Error') throw e;
      throw domError(`key unwrap failed: ${e && e.message}`, 'OperationError');
    }
  },
};

// ── RSA (RSASSA-PKCS1-v1_5 / RSA-PSS / RSA-OAEP) ─────────────────────────────
// The three RSA families share key import / export / generation; they differ in
// the operation (sign+verify vs encrypt+decrypt), the per-call parameters
// (saltLength for PSS, label for OAEP), and the usages a key of each type may
// hold. Keys carry their DER encoding (SPKI public / PKCS#8 private) as material;
// the host re-parses per call. `kind` is 'sign' (PKCS1/PSS) or 'crypt' (OAEP).
const RSA_USAGES = {
  sign:  { public: ['verify'],           private: ['sign'] },
  crypt: { public: ['encrypt', 'wrapKey'], private: ['decrypt', 'unwrapKey'] },
};

// Invoke a host crypto primitive by name, surfacing a missing binding as an
// OperationError rather than a bare TypeError.
function hostCall(fn, ...args) {
  const f = globalThis[fn];
  if (typeof f !== 'function') throw domError(`${fn} unavailable`, 'OperationError');
  return f(...args);
}

// The OpenSSL digest name for a key's hash: 'SHA-256' → 'SHA256'.
function rsaHashName(key) {
  return key.algorithm.hash.name.toUpperCase().replace(/-/g, '');
}

function rsaJwkAlg(name, hashName) {
  const suffix = hashName === 'SHA-1' ? '1' : hashName.slice(4);   // SHA-256 -> 256
  if (name === 'RSASSA-PKCS1-v1_5') return 'RS' + suffix;
  if (name === 'RSA-PSS') return 'PS' + suffix;
  return hashName === 'SHA-1' ? 'RSA-OAEP' : 'RSA-OAEP-' + suffix;   // RSA-OAEP
}

function rsaKeyAlgorithm(name, hashName, der) {
  const info = hostCall('__csim_rsaKeyInfo', der);
  return {
    name,
    modulusLength: info.modulusLength,
    publicExponent: Uint8Array.from(info.publicExponent),
    hash: { name: hashName },
  };
}

function rsaImportKey(name, kind, format, keyData, params, extractable, usages) {
  const hashName = params.hash.name;
  let der, type;
  if (format === 'spki') {
    der = copyBytes(keyData);
    type = 'public';
  } else if (format === 'pkcs8') {
    der = copyBytes(keyData);
    type = 'private';
  } else if (format === 'jwk') {
    const jwk = keyData;
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
      throw domError('Invalid RSA JWK', 'DataError');
    }
    checkJwkExtractable(jwk, extractable);
    const b = (s) => base64UrlToBytes(s);
    if (jwk.d !== undefined) {
      type = 'private';
      der = hostCall('__csim_rsaImportJwk', true, b(jwk.n), b(jwk.e), b(jwk.d), b(jwk.p), b(jwk.q), b(jwk.dp), b(jwk.dq), b(jwk.qi));
    } else {
      type = 'public';
      der = hostCall('__csim_rsaImportJwk', false, b(jwk.n), b(jwk.e));
    }
  } else {
    throw domError(`Unsupported key format "${format}" for ${name}`, 'NotSupportedError');
  }
  const use = normalizeUsages(usages, RSA_USAGES[kind][type]);
  if (type === 'private' && use.length === 0) throw domError('RSA private key import requires a usage', 'SyntaxError');
  let algorithm;
  try {
    algorithm = rsaKeyAlgorithm(name, hashName, der);
  } catch (e) {
    throw domError(`Invalid RSA key data: ${e && e.message}`, 'DataError');
  }
  return new CryptoKey(type, extractable, algorithm, use, der);
}

function rsaExportKey(name, format, key) {
  const der = keyMaterial(key);
  if (format === 'spki') return bytesToArrayBuffer(hostCall('__csim_rsaExport', der, 'spki'));
  if (format === 'pkcs8') return bytesToArrayBuffer(hostCall('__csim_rsaExport', der, 'pkcs8'));
  if (format === 'jwk') {
    const j = hostCall('__csim_rsaExportJwk', der);
    const jwk = {
      kty: 'RSA',
      n: bytesToBase64Url(j.n),
      e: bytesToBase64Url(j.e),
      alg: rsaJwkAlg(name, key.algorithm.hash.name),
      key_ops: key.usages.slice(),
      ext: key.extractable,
    };
    if (j.d) {
      jwk.d = bytesToBase64Url(j.d);
      jwk.p = bytesToBase64Url(j.p);
      jwk.q = bytesToBase64Url(j.q);
      jwk.dp = bytesToBase64Url(j.dp);
      jwk.dq = bytesToBase64Url(j.dq);
      jwk.qi = bytesToBase64Url(j.qi);
    }
    return jwk;
  }
  throw domError(`Unsupported export format "${format}" for ${name}`, 'NotSupportedError');
}

function rsaGenerateKey(name, kind, params, extractable, usages) {
  const pub = RSA_USAGES[kind].public;
  const priv = RSA_USAGES[kind].private;
  const use = normalizeUsages(usages, pub.concat(priv));
  const pubUse = use.filter((u) => pub.indexOf(u) !== -1);
  const privUse = use.filter((u) => priv.indexOf(u) !== -1);
  if (privUse.length === 0) throw domError('RSA key generation requires a private-key usage', 'SyntaxError');
  const privDer = hostCall('__csim_rsaGenerate', params.modulusLength, Array.from(copyBytes(params.publicExponent)));
  const pubDer = hostCall('__csim_rsaExport', privDer, 'spki');
  const publicKey = new CryptoKey('public', true, rsaKeyAlgorithm(name, params.hash.name, pubDer), pubUse, pubDer);
  const privateKey = new CryptoKey('private', extractable, rsaKeyAlgorithm(name, params.hash.name, privDer), privUse, privDer);
  return { publicKey, privateKey };
}

function rsaAlgorithm(name, kind) {
  const isPss = name === 'RSA-PSS';
  const base = {
    name,
    normalize: {
      importKey: (d) => ({ hash: normalizeAlgorithm('digest', d.hash) }),
      generateKey: (d) => ({
        modulusLength: d.modulusLength,
        publicExponent: d.publicExponent,
        hash: normalizeAlgorithm('digest', d.hash),
      }),
    },
    importKey: (format, keyData, params, extractable, usages) =>
      rsaImportKey(name, kind, format, keyData, params, extractable, usages),
    exportKey: (format, key) => rsaExportKey(name, format, key),
    generateKey: (params, extractable, usages) => rsaGenerateKey(name, kind, params, extractable, usages),
  };
  if (kind === 'sign') {
    const norm = (d) => (isPss ? { saltLength: d.saltLength } : {});
    base.normalize.sign = norm;
    base.normalize.verify = norm;
    base.sign = (params, key, dataBytes) => bytesToArrayBuffer(
      hostCall('__csim_rsaSign', keyMaterial(key), rsaHashName(key), dataBytes, isPss ? 'pss' : 'pkcs1', params.saltLength | 0)
    );
    base.verify = (params, key, sigBytes, dataBytes) =>
      hostCall('__csim_rsaVerify', keyMaterial(key), rsaHashName(key), dataBytes, sigBytes, isPss ? 'pss' : 'pkcs1', params.saltLength | 0);
  } else {
    const oaepParams = (d) => ({ label: d.label });
    base.normalize.encrypt = oaepParams;
    base.normalize.decrypt = oaepParams;
    base.normalize.wrapKey = oaepParams;
    base.normalize.unwrapKey = oaepParams;
    base.encrypt = (params, key, dataBytes) => {
      try {
        return bytesToArrayBuffer(
          hostCall('__csim_rsaEncrypt', keyMaterial(key), rsaHashName(key), dataBytes, params.label != null ? copyBytes(params.label) : [])
        );
      } catch (e) {
        if (e && e.name && e.name !== 'Error') throw e;
        throw domError(`encryption failed: ${e && e.message}`, 'OperationError');   // e.g. plaintext too long
      }
    };
    base.decrypt = (params, key, dataBytes) => {
      try {
        return bytesToArrayBuffer(
          hostCall('__csim_rsaDecrypt', keyMaterial(key), rsaHashName(key), dataBytes, params.label != null ? copyBytes(params.label) : [])
        );
      } catch (e) {
        if (e && e.name && e.name !== 'Error') throw e;
        throw domError(`decryption failed: ${e && e.message}`, 'OperationError');
      }
    };
  }
  return base;
}

// ── Elliptic curve (ECDSA / ECDH) ───────────────────────────────────────────
// ECDSA (sign/verify) and ECDH (key agreement) share the EC key surface — import
// / export / generation over the three NIST curves — and a key carries only its
// curve (the hash is a per-call parameter for ECDSA). deriveBits/deriveKey for
// ECDH lands in a later increment; this ships the keys and ECDSA. Signatures cross
// as the WebCrypto IEEE-P1363 r‖s form (the host converts to/from OpenSSL's DER).
const EC_CURVES = {
  'P-256': { ossl: 'prime256v1', bytes: 32 },
  'P-384': { ossl: 'secp384r1', bytes: 48 },
  'P-521': { ossl: 'secp521r1', bytes: 66 },
};
const EC_OSSL_TO_NAME = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };
const EC_USAGES = {
  ecdsa: { public: ['verify'], private: ['sign'] },
  ecdh:  { public: [],         private: ['deriveKey', 'deriveBits'] },
};

function ecImportKey(name, kind, format, keyData, params, extractable, usages) {
  const curve = params.namedCurve;
  const c = EC_CURVES[curve];
  if (!c) throw domError(`Unsupported named curve "${curve}"`, 'NotSupportedError');
  let der, type;
  if (format === 'spki') {
    der = copyBytes(keyData);
    type = 'public';
  } else if (format === 'pkcs8') {
    der = copyBytes(keyData);
    type = 'private';
  } else if (format === 'raw') {
    der = hostCall('__csim_ecImportRaw', c.ossl, copyBytes(keyData));
    type = 'public';
  } else if (format === 'jwk') {
    const jwk = keyData;
    if (!jwk || jwk.kty !== 'EC' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      throw domError('Invalid EC JWK', 'DataError');
    }
    checkJwkExtractable(jwk, extractable);
    if (jwk.crv !== undefined && jwk.crv !== curve) {
      throw domError(`JWK curve "${jwk.crv}" does not match "${curve}"`, 'DataError');
    }
    const b = (s) => base64UrlToBytes(s);
    if (jwk.d !== undefined) {
      type = 'private';
      der = hostCall('__csim_ecImportJwk', c.ossl, true, b(jwk.x), b(jwk.y), b(jwk.d), c.bytes);
    } else {
      type = 'public';
      der = hostCall('__csim_ecImportJwk', c.ossl, false, b(jwk.x), b(jwk.y));
    }
  } else {
    throw domError(`Unsupported key format "${format}" for ${name}`, 'NotSupportedError');
  }
  const use = normalizeUsages(usages, EC_USAGES[kind][type]);
  if (type === 'private' && use.length === 0) throw domError('EC private key import requires a usage', 'SyntaxError');
  let detected;
  try {
    detected = EC_OSSL_TO_NAME[hostCall('__csim_ecKeyInfo', der).curve];
  } catch (e) {
    throw domError(`Invalid EC key data: ${e && e.message}`, 'DataError');
  }
  // The key's own curve must match the requested one (spki/pkcs8 carry it in the DER).
  if (detected && detected !== curve) {
    throw domError(`Key curve "${detected}" does not match "${curve}"`, 'DataError');
  }
  return new CryptoKey(type, extractable, { name, namedCurve: curve }, use, der);
}

function ecExportKey(name, format, key) {
  const der = keyMaterial(key);
  const c = EC_CURVES[key.algorithm.namedCurve];
  if (format === 'spki') return bytesToArrayBuffer(hostCall('__csim_ecExport', der, 'spki'));
  if (format === 'pkcs8') return bytesToArrayBuffer(hostCall('__csim_ecExport', der, 'pkcs8'));
  if (format === 'raw') return bytesToArrayBuffer(hostCall('__csim_ecExport', der, 'raw'));
  if (format === 'jwk') {
    const j = hostCall('__csim_ecExportJwk', der, c ? c.bytes : 0);
    const jwk = {
      kty: 'EC',
      crv: key.algorithm.namedCurve,
      x: bytesToBase64Url(j.x),
      y: bytesToBase64Url(j.y),
      key_ops: key.usages.slice(),
      ext: key.extractable,
    };
    if (j.d) jwk.d = bytesToBase64Url(j.d);
    return jwk;
  }
  throw domError(`Unsupported export format "${format}" for ${name}`, 'NotSupportedError');
}

function ecGenerateKey(name, kind, params, extractable, usages) {
  const curve = params.namedCurve;
  const c = EC_CURVES[curve];
  if (!c) throw domError(`Unsupported named curve "${curve}"`, 'NotSupportedError');
  const pub = EC_USAGES[kind].public;
  const priv = EC_USAGES[kind].private;
  const use = normalizeUsages(usages, pub.concat(priv));
  const privUse = use.filter((u) => priv.indexOf(u) !== -1);
  if (privUse.length === 0) throw domError('EC key generation requires a private-key usage', 'SyntaxError');
  const privDer = hostCall('__csim_ecGenerate', c.ossl);
  const pubDer = hostCall('__csim_ecExport', privDer, 'spki');
  const algorithm = { name, namedCurve: curve };
  const publicKey = new CryptoKey('public', true, algorithm, use.filter((u) => pub.indexOf(u) !== -1), pubDer);
  const privateKey = new CryptoKey('private', extractable, algorithm, privUse, privDer);
  return { publicKey, privateKey };
}

function ecAlgorithm(name, kind) {
  const base = {
    name,
    normalize: {
      importKey: (d) => ({ namedCurve: d.namedCurve }),
      generateKey: (d) => ({ namedCurve: d.namedCurve }),
    },
    importKey: (format, keyData, params, extractable, usages) =>
      ecImportKey(name, kind, format, keyData, params, extractable, usages),
    exportKey: (format, key) => ecExportKey(name, format, key),
    generateKey: (params, extractable, usages) => ecGenerateKey(name, kind, params, extractable, usages),
  };
  if (kind === 'ecdsa') {
    const norm = (d) => ({ hash: normalizeAlgorithm('digest', d.hash) });
    base.normalize.sign = norm;
    base.normalize.verify = norm;
    base.sign = (params, key, dataBytes) => {
      const c = EC_CURVES[key.algorithm.namedCurve];
      const hash = params.hash.name.toUpperCase().replace(/-/g, '');
      return bytesToArrayBuffer(hostCall('__csim_ecdsaSign', keyMaterial(key), hash, dataBytes, c.bytes));
    };
    base.verify = (params, key, sigBytes, dataBytes) => {
      const c = EC_CURVES[key.algorithm.namedCurve];
      const hash = params.hash.name.toUpperCase().replace(/-/g, '');
      return hostCall('__csim_ecdsaVerify', keyMaterial(key), hash, dataBytes, sigBytes, c.bytes);
    };
  } else {
    // ECDH key agreement — `public` is the peer's public CryptoKey; the shared
    // secret is the full field-size value, which deriveBits() then trims. `public`
    // is an IDL CryptoKey member, so a missing / non-CryptoKey value is a TypeError
    // (thrown at normalization); a wrong key type / curve is an InvalidAccessError.
    const norm = (d) => {
      if (!(d.public instanceof CryptoKey)) throw new TypeError('ECDH: "public" must be a CryptoKey');
      return { public: d.public };
    };
    base.normalize.deriveBits = norm;
    base.normalize.deriveKey = norm;
    base.deriveBits = (params, key, length) => {
      const peer = params.public;
      if (peer.algorithm.name !== 'ECDH' || peer.type !== 'public') {
        throw domError('ECDH requires a public ECDH key in "public"', 'InvalidAccessError');
      }
      if (peer.algorithm.namedCurve !== key.algorithm.namedCurve) {
        throw domError('ECDH peer key is on a different curve', 'InvalidAccessError');
      }
      return hostCall('__csim_ecdhDerive', keyMaterial(key), keyMaterial(peer));
    };
  }
  return base;
}

// ── Key derivation (HKDF / PBKDF2 / ECDH) ───────────────────────────────────
// deriveBits produces exactly `length` bits: the algorithm yields whole bytes and
// this trims to the requested bit count, masking the low bits of the final byte
// (WebCrypto allows a non-byte-aligned length, e.g. ECDH `8*size - 11`).
function bitsToBuffer(bytes, lengthBits) {
  if (lengthBits == null) return bytesToArrayBuffer(bytes);
  if (lengthBits === 0) return new ArrayBuffer(0);
  const nbytes = Math.ceil(lengthBits / 8);
  if (bytes.length < nbytes) throw domError('Not enough bits available to derive', 'OperationError');
  const out = bytes.slice(0, nbytes);
  const rem = lengthBits % 8;
  if (rem !== 0) out[nbytes - 1] &= (0xff << (8 - rem)) & 0xff;
  return bytesToArrayBuffer(out);
}

// HKDF and PBKDF2 base keys hold raw input keying material (never extractable) and
// exist only to derive. The KDF runs host-side; the wrapper trims to `length`.
function kdfAlgorithm(name, hostFn, extraParams) {
  return {
    name,
    normalize: {
      deriveBits: extraParams,
      deriveKey: extraParams,
      importKey: () => ({}),
    },
    importKey(format, keyData, params, extractable, usages) {
      if (format !== 'raw') throw domError(`${name} keys can only be imported in "raw" format`, 'NotSupportedError');
      if (extractable) throw domError(`${name} keys are not extractable`, 'SyntaxError');
      const use = normalizeUsages(usages, ['deriveBits', 'deriveKey']);
      return new CryptoKey('secret', false, { name }, use, copyBytes(keyData));
    },
    deriveBits(params, key, length) {
      // HKDF / PBKDF2 require a non-null length that is a whole number of bytes.
      if (length == null || length % 8 !== 0) throw domError(`${name} length must be a non-null multiple of 8`, 'OperationError');
      if (length === 0) return [];
      const nbytes = length / 8;
      const hash = params.hash.name.toUpperCase().replace(/-/g, '');
      if (hostFn === '__csim_hkdf') {
        return hostCall(hostFn, hash, keyMaterial(key), copyBytes(params.salt), copyBytes(params.info), nbytes);
      }
      // PBKDF2 "derive bits" step 2: zero iterations is invalid — throw OperationError
      // (both deriveBits and deriveKey, which routes through here, must reject).
      const iterations = params.iterations | 0;
      if (iterations === 0) throw domError('PBKDF2 iterations must be a positive integer', 'OperationError');
      return hostCall(hostFn, hash, keyMaterial(key), copyBytes(params.salt), iterations, nbytes);
    },
  };
}

const HKDF = kdfAlgorithm('HKDF', '__csim_hkdf', (d) => ({
  hash: normalizeAlgorithm('digest', d.hash), salt: d.salt, info: d.info,
}));
const PBKDF2 = kdfAlgorithm('PBKDF2', '__csim_pbkdf2', (d) => ({
  hash: normalizeAlgorithm('digest', d.hash), salt: d.salt, iterations: d.iterations,
}));

// "Get key length" for a deriveKey target — how many bits deriveBits must produce
// before importing the result as a key of that type.
function derivedKeyLengthBits(derivedKeyType) {
  const name = String(derivedKeyType.name).toUpperCase();
  if (name.startsWith('AES-')) return derivedKeyType.length;
  if (name === 'HMAC') {
    if (derivedKeyType.length) return derivedKeyType.length;
    return HMAC_BLOCK_BITS[normalizeAlgorithm('digest', derivedKeyType.hash).name];
  }
  throw domError(`Cannot derive a ${derivedKeyType.name} key`, 'NotSupportedError');
}

// ── OKP curves (Ed25519 signatures / X25519 key agreement) ──────────────────
// The CFRG "octet key pair" family: a key carries only its name (no curve
// parameter, no hash), the public key is a 32-byte octet string, and jwk uses
// kty "OKP". Ed25519 signs; X25519 does ECDH-style agreement.
const OKP_USAGES = {
  Ed25519: { public: ['verify'], private: ['sign'] },
  X25519:  { public: [],         private: ['deriveKey', 'deriveBits'] },
};

function okpImportKey(name, format, keyData, extractable, usages) {
  let der, type;
  if (format === 'spki') {
    der = copyBytes(keyData);
    type = 'public';
  } else if (format === 'pkcs8') {
    der = copyBytes(keyData);
    type = 'private';
  } else if (format === 'raw') {
    der = hostCall('__csim_okpImportRaw', name.toUpperCase(), copyBytes(keyData));
    type = 'public';
  } else if (format === 'jwk') {
    const jwk = keyData;
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== name || typeof jwk.x !== 'string') throw domError('Invalid OKP JWK', 'DataError');
    checkJwkExtractable(jwk, extractable);
    const b = (s) => base64UrlToBytes(s);
    type = jwk.d !== undefined ? 'private' : 'public';
    der = hostCall('__csim_okpImportJwk', name.toUpperCase(), type === 'private', b(jwk.x), type === 'private' ? b(jwk.d) : []);
  } else {
    throw domError(`Unsupported key format "${format}" for ${name}`, 'NotSupportedError');
  }
  const use = normalizeUsages(usages, OKP_USAGES[name][type]);
  if (type === 'private' && use.length === 0) throw domError('OKP private key import requires a usage', 'SyntaxError');
  return new CryptoKey(type, extractable, { name }, use, der);
}

function okpExportKey(name, format, key) {
  const der = keyMaterial(key);
  if (format === 'spki') return bytesToArrayBuffer(hostCall('__csim_okpExport', der, 'spki'));
  if (format === 'pkcs8') return bytesToArrayBuffer(hostCall('__csim_okpExport', der, 'pkcs8'));
  if (format === 'raw') return bytesToArrayBuffer(hostCall('__csim_okpExport', der, 'raw'));
  if (format === 'jwk') {
    const j = hostCall('__csim_okpExportJwk', der, key.type === 'private');
    const jwk = { kty: 'OKP', crv: name, x: bytesToBase64Url(j.x) };
    if (name === 'Ed25519') jwk.alg = 'Ed25519';   // signing OKP carries a JWK alg; X25519 does not
    if (j.d) jwk.d = bytesToBase64Url(j.d);
    jwk.key_ops = key.usages.slice();
    jwk.ext = key.extractable;
    return jwk;
  }
  throw domError(`Unsupported export format "${format}" for ${name}`, 'NotSupportedError');
}

function okpGenerateKey(name, extractable, usages) {
  const pub = OKP_USAGES[name].public;
  const priv = OKP_USAGES[name].private;
  const use = normalizeUsages(usages, pub.concat(priv));
  const privUse = use.filter((u) => priv.indexOf(u) !== -1);
  if (privUse.length === 0) throw domError('OKP key generation requires a private-key usage', 'SyntaxError');
  const privDer = hostCall('__csim_okpGenerate', name.toUpperCase());
  const pubDer = hostCall('__csim_okpExport', privDer, 'spki');
  const publicKey = new CryptoKey('public', true, { name }, use.filter((u) => pub.indexOf(u) !== -1), pubDer);
  const privateKey = new CryptoKey('private', extractable, { name }, privUse, privDer);
  return { publicKey, privateKey };
}

function okpAlgorithm(name) {
  const base = {
    name,
    normalize: {
      importKey: () => ({}),
      generateKey: () => ({}),
    },
    importKey: (format, keyData, params, extractable, usages) => okpImportKey(name, format, keyData, extractable, usages),
    exportKey: (format, key) => okpExportKey(name, format, key),
    generateKey: (params, extractable, usages) => okpGenerateKey(name, extractable, usages),
  };
  if (name === 'Ed25519') {
    base.normalize.sign = () => ({});
    base.normalize.verify = () => ({});
    base.sign = (params, key, dataBytes) => bytesToArrayBuffer(hostCall('__csim_ed25519Sign', keyMaterial(key), dataBytes));
    base.verify = (params, key, sigBytes, dataBytes) => hostCall('__csim_ed25519Verify', keyMaterial(key), dataBytes, sigBytes);
  } else {
    const norm = (d) => {
      if (!(d.public instanceof CryptoKey)) throw new TypeError('X25519: "public" must be a CryptoKey');
      return { public: d.public };
    };
    base.normalize.deriveBits = norm;
    base.normalize.deriveKey = norm;
    base.deriveBits = (params, key, length) => {
      const peer = params.public;
      if (peer.algorithm.name !== 'X25519' || peer.type !== 'public') {
        throw domError('X25519 requires a public X25519 key in "public"', 'InvalidAccessError');
      }
      try {
        return hostCall('__csim_x25519Derive', keyMaterial(key), keyMaterial(peer));
      } catch (e) {
        if (e && e.name && e.name !== 'Error') throw e;
        throw domError(`X25519 derivation failed: ${e && e.message}`, 'OperationError');   // e.g. low-order (all-zero) result
      }
    };
  }
  return base;
}

// ── Algorithm registry ──────────────────────────────────────────────────────
const ALGORITHMS = {
  'SHA-1': shaAlgorithm('SHA-1'),
  'SHA-256': shaAlgorithm('SHA-256'),
  'SHA-384': shaAlgorithm('SHA-384'),
  'SHA-512': shaAlgorithm('SHA-512'),
  'HMAC': HMAC,
  'AES-CBC': aesAlgorithm('AES-CBC', 'cbc'),
  'AES-CTR': aesAlgorithm('AES-CTR', 'ctr'),
  'AES-GCM': aesAlgorithm('AES-GCM', 'gcm'),
  'AES-KW': AES_KW,
  'RSASSA-PKCS1-V1_5': rsaAlgorithm('RSASSA-PKCS1-v1_5', 'sign'),
  'RSA-PSS': rsaAlgorithm('RSA-PSS', 'sign'),
  'RSA-OAEP': rsaAlgorithm('RSA-OAEP', 'crypt'),
  'ECDSA': ecAlgorithm('ECDSA', 'ecdsa'),
  'ECDH': ecAlgorithm('ECDH', 'ecdh'),
  'HKDF': HKDF,
  'PBKDF2': PBKDF2,
  'ED25519': okpAlgorithm('Ed25519'),
  'X25519': okpAlgorithm('X25519'),
};

function algorithmFor(name) { return ALGORITHMS[String(name).toUpperCase()]; }

// ── SubtleCrypto ────────────────────────────────────────────────────────────
// Every method returns a Promise. Synchronous validation failures (bad algorithm,
// missing name, usage errors) reject rather than throw, per the spec's "return a
// promise rejected with" phrasing — so callers only ever need a single `.catch`.
function promised(fn) {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

// Export a key's material as raw bytes for wrapping: a jwk export is serialized to
// its UTF-8 JSON, every other format is already a byte buffer. (No extractability
// check here — wrapKey does it, since the key never leaves the agent.)
function exportKeyToBytes(format, key) {
  const impl = algorithmFor(key.algorithm.name);
  if (!impl || !impl.exportKey) throw domError(`Cannot wrap a ${key.algorithm.name} key`, 'NotSupportedError');
  const exported = impl.exportKey(format, key);
  if (format === 'jwk') {
    const json = JSON.stringify(exported);
    return typeof globalThis.__csim_utf8Encode === 'function' ? globalThis.__csim_utf8Encode(json) : copyBytes(new Uint8Array([]));
  }
  return copyBytes(exported);
}

function utf8Decode(u8) {
  const bytes = Array.from(u8);
  if (typeof globalThis.__csim_utf8Decode === 'function') return globalThis.__csim_utf8Decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function requireKeyOp(algName, key, usage) {
  if (algName !== key.algorithm.name) {
    throw domError(`Key algorithm "${key.algorithm.name}" does not match operation algorithm "${algName}"`, 'InvalidAccessError');
  }
  if (key.usages.indexOf(usage) === -1) {
    throw domError(`Key does not support the "${usage}" operation`, 'InvalidAccessError');
  }
}

class SubtleCrypto {
  digest(algorithm, data) {
    return promised(() => {
      const alg = normalizeAlgorithm('digest', algorithm);   // normalize FIRST…
      const bytes = copyBytes(data);                         // …THEN snapshot bytes
      let out;
      try {
        out = hostDigest(alg.name, bytes);
      } catch (e) {
        throw domError(`digest failed: ${e && e.message}`, 'OperationError');
      }
      return bytesToArrayBuffer(out);
    });
  }

  sign(algorithm, key, data) {
    return promised(() => {
      const alg = normalizeAlgorithm('sign', algorithm);
      const bytes = copyBytes(data);
      requireKeyOp(alg.name, key, 'sign');
      return algorithmFor(alg.name).sign(alg, key, bytes);
    });
  }

  verify(algorithm, key, signature, data) {
    return promised(() => {
      const alg = normalizeAlgorithm('verify', algorithm);
      const sig = copyBytes(signature);
      const bytes = copyBytes(data);
      requireKeyOp(alg.name, key, 'verify');
      return algorithmFor(alg.name).verify(alg, key, sig, bytes);
    });
  }

  importKey(format, keyData, algorithm, extractable, usages) {
    return promised(() => {
      const alg = normalizeAlgorithm('importKey', algorithm);
      const impl = algorithmFor(alg.name);
      if (!impl.importKey) throw domError(`importKey unsupported for ${alg.name}`, 'NotSupportedError');
      // JWK arrives as a plain object; every other format is a BufferSource the
      // algorithm copies itself (so it can honour the copy-then-use ordering).
      return impl.importKey(format, keyData, alg, extractable, usages);
    });
  }

  exportKey(format, key) {
    return promised(() => {
      if (!(key instanceof CryptoKey)) throw new TypeError('exportKey: a CryptoKey is required');
      if (!key.extractable) throw domError('Key is not extractable', 'InvalidAccessError');
      const impl = algorithmFor(key.algorithm.name);
      if (!impl || !impl.exportKey) throw domError(`exportKey unsupported for ${key.algorithm.name}`, 'NotSupportedError');
      return impl.exportKey(format, key);
    });
  }

  generateKey(algorithm, extractable, usages) {
    return promised(() => {
      const alg = normalizeAlgorithm('generateKey', algorithm);
      const impl = algorithmFor(alg.name);
      if (!impl.generateKey) throw domError(`generateKey unsupported for ${alg.name}`, 'NotSupportedError');
      return impl.generateKey(alg, extractable, usages);
    });
  }

  encrypt(algorithm, key, data) {
    return promised(() => {
      const alg = normalizeAlgorithm('encrypt', algorithm);
      const bytes = copyBytes(data);
      requireKeyOp(alg.name, key, 'encrypt');
      return algorithmFor(alg.name).encrypt(alg, key, bytes);
    });
  }

  decrypt(algorithm, key, data) {
    return promised(() => {
      const alg = normalizeAlgorithm('decrypt', algorithm);
      const bytes = copyBytes(data);
      requireKeyOp(alg.name, key, 'decrypt');
      return algorithmFor(alg.name).decrypt(alg, key, bytes);
    });
  }

  deriveBits(algorithm, baseKey, length) {
    return promised(() => {
      const alg = normalizeAlgorithm('deriveBits', algorithm);
      requireKeyOp(alg.name, baseKey, 'deriveBits');
      return bitsToBuffer(algorithmFor(alg.name).deriveBits(alg, baseKey, length), length);
    });
  }

  deriveKey(algorithm, baseKey, derivedKeyType, extractable, usages) {
    return promised(() => {
      const alg = normalizeAlgorithm('deriveKey', algorithm);
      requireKeyOp(alg.name, baseKey, 'deriveKey');
      const target = normalizeAlgorithm('importKey', derivedKeyType);
      const bits = derivedKeyLengthBits(derivedKeyType);
      const derived = bitsToBuffer(algorithmFor(alg.name).deriveBits(alg, baseKey, bits), bits);
      const impl = algorithmFor(target.name);
      if (!impl.importKey) throw domError(`Cannot derive a ${target.name} key`, 'NotSupportedError');
      return impl.importKey('raw', derived, target, extractable, usages);
    });
  }

  wrapKey(format, key, wrappingKey, wrapAlgorithm) {
    return promised(() => {
      const alg = normalizeAlgorithm('wrapKey', wrapAlgorithm);
      requireKeyOp(alg.name, wrappingKey, 'wrapKey');
      if (!key.extractable) throw domError('key to wrap is not extractable', 'InvalidAccessError');
      const bytes = exportKeyToBytes(format, key);
      const impl = algorithmFor(alg.name);
      return impl.wrapBytes ? impl.wrapBytes(alg, wrappingKey, bytes) : impl.encrypt(alg, wrappingKey, bytes);
    });
  }

  unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, usages) {
    return promised(() => {
      const alg = normalizeAlgorithm('unwrapKey', unwrapAlgorithm);
      requireKeyOp(alg.name, unwrappingKey, 'unwrapKey');
      const wrapped = copyBytes(wrappedKey);
      const impl = algorithmFor(alg.name);
      const decrypted = impl.unwrapBytes ? impl.unwrapBytes(alg, unwrappingKey, wrapped) : impl.decrypt(alg, unwrappingKey, wrapped);
      const target = normalizeAlgorithm('importKey', unwrappedKeyAlgorithm);
      const targetImpl = algorithmFor(target.name);
      if (!targetImpl.importKey) throw domError(`Cannot unwrap a ${target.name} key`, 'NotSupportedError');
      const keyData = format === 'jwk'
        ? JSON.parse(utf8Decode(new Uint8Array(decrypted)))
        : decrypted;
      return targetImpl.importKey(format, keyData, target, extractable, usages);
    });
  }

  get [Symbol.toStringTag]() { return 'SubtleCrypto'; }
}

// ── Crypto ──────────────────────────────────────────────────────────────────
// The integer-typed-array kinds `getRandomValues` may fill. Float arrays and
// DataView are a TypeMismatchError; a byte length over 65536 is a
// QuotaExceededError. Both checks operate on the underlying bytes, so BigInt64 /
// BigUint64 arrays fill uniformly.
const RANDOM_INTEGER_TYPES = [
  Int8Array, Int16Array, Int32Array,
  Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  typeof BigInt64Array !== 'undefined' ? BigInt64Array : null,
  typeof BigUint64Array !== 'undefined' ? BigUint64Array : null
].filter(Boolean);

const MAX_RANDOM_BYTES = 65536;

class Crypto {
  getRandomValues(typedArray) {
    const isIntegerArray = RANDOM_INTEGER_TYPES.some((ctor) => typedArray instanceof ctor);
    if (!isIntegerArray) {
      throw domError('getRandomValues: an integer-typed array is required', 'TypeMismatchError');
    }
    if (typedArray.byteLength > MAX_RANDOM_BYTES) {
      throw new QuotaExceededError(`getRandomValues: length exceeds ${MAX_RANDOM_BYTES} bytes`);
    }
    const bytesFn = globalThis.__csim_randomBytes;
    const rnd = typeof bytesFn === 'function' ? bytesFn(typedArray.byteLength) : null;
    const view = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = rnd ? (rnd[i] | 0) & 0xff : 0;
    return typedArray;
  }

  randomUUID() {
    return typeof globalThis.__csim_randomUUID === 'function'
      ? String(globalThis.__csim_randomUUID())
      : '00000000-0000-0000-0000-000000000000';
  }

  get subtle() { return SUBTLE; }

  get [Symbol.toStringTag]() { return 'Crypto'; }
}

const SUBTLE = new SubtleCrypto();

export function installWebCrypto(g) {
  g.Crypto = Crypto;
  g.SubtleCrypto = SubtleCrypto;
  g.CryptoKey = CryptoKey;
  g.crypto = new Crypto();
  // Structured-clone hook: the walker detects a CryptoKey by its brand tag and calls
  // this to duplicate it (same-realm — the material lives in a realm-local slot).
  g.__csimCloneCryptoKey = cloneCryptoKey;
}
