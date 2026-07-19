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
const AES_USAGES = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'];
const AES_KEY_BITS = { 16: 128, 24: 192, 32: 256 };
const GCM_TAG_LENGTHS = [32, 64, 96, 104, 112, 120, 128];

function aesCipherName(keyByteLen, mode) {
  const bits = AES_KEY_BITS[keyByteLen];
  return `aes-${bits}-${mode}`;
}

function aesJwkAlg(mode, bits) {
  return 'A' + bits + { cbc: 'CBC', ctr: 'CTR', gcm: 'GCM' }[mode];
}

function aesImportKey(name, mode, format, keyData, extractable, usages) {
  const use = normalizeUsages(usages, AES_USAGES);
  if (use.length === 0) throw domError('AES key import requires at least one usage', 'SyntaxError');
  let raw;
  if (format === 'raw') {
    raw = copyBytes(keyData);
  } else if (format === 'jwk') {
    const jwk = keyData;
    if (!jwk || jwk.kty !== 'oct' || typeof jwk.k !== 'string') throw domError('Invalid AES JWK', 'DataError');
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
  const use = normalizeUsages(usages, AES_USAGES);
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

function hostRsa(fn, ...args) {
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
  const info = hostRsa('__csim_rsaKeyInfo', der);
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
    const b = (s) => base64UrlToBytes(s);
    if (jwk.d !== undefined) {
      type = 'private';
      der = hostRsa('__csim_rsaImportJwk', true, b(jwk.n), b(jwk.e), b(jwk.d), b(jwk.p), b(jwk.q), b(jwk.dp), b(jwk.dq), b(jwk.qi));
    } else {
      type = 'public';
      der = hostRsa('__csim_rsaImportJwk', false, b(jwk.n), b(jwk.e));
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
  if (format === 'spki') return bytesToArrayBuffer(hostRsa('__csim_rsaExport', der, 'spki'));
  if (format === 'pkcs8') return bytesToArrayBuffer(hostRsa('__csim_rsaExport', der, 'pkcs8'));
  if (format === 'jwk') {
    const j = hostRsa('__csim_rsaExportJwk', der);
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
  const privDer = hostRsa('__csim_rsaGenerate', params.modulusLength, Array.from(copyBytes(params.publicExponent)));
  const pubDer = hostRsa('__csim_rsaExport', privDer, 'spki');
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
      hostRsa('__csim_rsaSign', keyMaterial(key), rsaHashName(key), dataBytes, isPss ? 'pss' : 'pkcs1', params.saltLength | 0)
    );
    base.verify = (params, key, sigBytes, dataBytes) =>
      hostRsa('__csim_rsaVerify', keyMaterial(key), rsaHashName(key), dataBytes, sigBytes, isPss ? 'pss' : 'pkcs1', params.saltLength | 0);
  } else {
    base.normalize.encrypt = (d) => ({ label: d.label });
    base.normalize.decrypt = (d) => ({ label: d.label });
    base.encrypt = (params, key, dataBytes) => {
      try {
        return bytesToArrayBuffer(
          hostRsa('__csim_rsaEncrypt', keyMaterial(key), rsaHashName(key), dataBytes, params.label != null ? copyBytes(params.label) : [])
        );
      } catch (e) {
        if (e && e.name && e.name !== 'Error') throw e;
        throw domError(`encryption failed: ${e && e.message}`, 'OperationError');   // e.g. plaintext too long
      }
    };
    base.decrypt = (params, key, dataBytes) => {
      try {
        return bytesToArrayBuffer(
          hostRsa('__csim_rsaDecrypt', keyMaterial(key), rsaHashName(key), dataBytes, params.label != null ? copyBytes(params.label) : [])
        );
      } catch (e) {
        if (e && e.name && e.name !== 'Error') throw e;
        throw domError(`decryption failed: ${e && e.message}`, 'OperationError');
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
  'RSASSA-PKCS1-V1_5': rsaAlgorithm('RSASSA-PKCS1-v1_5', 'sign'),
  'RSA-PSS': rsaAlgorithm('RSA-PSS', 'sign'),
  'RSA-OAEP': rsaAlgorithm('RSA-OAEP', 'crypt'),
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

  deriveBits() { return Promise.reject(domError('deriveBits is not yet implemented', 'NotSupportedError')); }
  deriveKey()  { return Promise.reject(domError('deriveKey is not yet implemented', 'NotSupportedError')); }
  wrapKey()    { return Promise.reject(domError('wrapKey is not yet implemented', 'NotSupportedError')); }
  unwrapKey()  { return Promise.reject(domError('unwrapKey is not yet implemented', 'NotSupportedError')); }

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
}
