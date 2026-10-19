// Web Crypto API — `crypto` (Crypto), `crypto.subtle` (SubtleCrypto) and CryptoKey: their bindings. The engine
// (webcrypto.rs) holds the algorithms — each registered one's steps, the checks an operation makes of the keys it is
// handed, the DOMException each failure is — and a key's material. This side converts the arguments ("normalize an
// algorithm" converts its dictionary to the type the engine's registry names, by the converter generated from the IDL),
// keeps each CryptoKey's slots and settles the promises.
//
// App value: JWT (jose, HS/RS/ES256), OIDC (oidc-client-ts), and Web Push (ECDH + HKDF + AES-GCM) all ride on
// SubtleCrypto.

import {
  installCrypto,
  installCryptoKey,
  installSubtleCrypto,
  toAesCbcParamsMembersAfterAlgorithm,
  toAesCtrParamsMembersAfterAlgorithm,
  toAesDerivedKeyParamsMembersAfterAlgorithm,
  toAesGcmParamsMembersAfterAlgorithm,
  toAesKeyGenParamsMembersAfterAlgorithm,
  toAlgorithm,
  toEcKeyGenParamsMembersAfterAlgorithm,
  toEcKeyImportParamsMembersAfterAlgorithm,
  toEcdhKeyDeriveParamsMembersAfterAlgorithm,
  toEcdsaParamsMembersAfterAlgorithm,
  toHkdfParamsMembersAfterAlgorithm,
  toHmacImportParamsMembersAfterAlgorithm,
  toHmacKeyGenParamsMembersAfterAlgorithm,
  toJsonWebKey,
  toPbkdf2ParamsMembersAfterAlgorithm,
  toRsaHashedImportParamsMembersAfterAlgorithm,
  toRsaHashedKeyGenParamsMembersAfterAlgorithm,
  toRsaOaepParamsMembersAfterAlgorithm,
  toRsaPssParamsMembersAfterAlgorithm
} from './generated/bindings.js';
import {
  PLATFORM,
  constructedBy,
  isBufferOf,
  makeSlots,
  registerInterface,
  rejectedPromise,
  resolvedPromise,
  slotsOf
} from './webidl.js';
import { DOMException, QuotaExceededError } from './dom-exception.js';

function domError(message, name) {
  return new DOMException(message, name);
}

// ── CryptoKey ───────────────────────────────────────────────────────────────
// The opaque handle to keying material, generated from its IDL and made by the platform alone. Its key — [[type]],
// [[extractable]], [[algorithm]], [[usages]] and the material page script never sees — is the engine's, on the state
// its slots keep (webcrypto.rs `KeyHandle`), which every operation is handed (`stateOf`) and a key the engine makes
// comes back as (`keyFrom`). The slots keep what the attributes return besides, read off the key once (`infoOf`): its
// type, its extractable flag, and its algorithm and usages as the ECMAScript objects every read after returns
// (WebCrypto's "cached ECMAScript object": Chrome converts at every read, Firefox freezes the usages, the spec does
// neither) — the page's own copies, so one it changes changes no operation.
const keyOf = (o) => slotsOf(o, 'CryptoKey');
const stateOf = (o) => keyOf(o)?.state;
registerInterface('CryptoKey', (o) => keyOf(o) !== undefined);
class CryptoKey {
  constructor(token, state) {
    constructedBy(PLATFORM, token, 'CryptoKey');
    makeSlots(this, 'CryptoKey', { state, info: undefined });
  }
}
// (…`{type, extractable, algorithm, usages}`, the engine's, made in the realm that first reads them)
const infoOf = (key) => (keyOf(key).info ??= globalThis.__dom.cryptoKeyInfo(stateOf(key)));
installCryptoKey(CryptoKey, {
  get_type:        (key) => infoOf(key).type,
  get_extractable: (key) => infoOf(key).extractable,
  get_algorithm:   (key) => infoOf(key).algorithm,
  get_usages:      (key) => infoOf(key).usages
});
const keyFrom = (state) => new CryptoKey(PLATFORM, state);

// CryptoKey is [Serializable]: its serialization — a structured clone's (platform-globals.js `serializePlatformObject`)
// and a worker message's (workers.js) — the engine's record of its key, its material among it (`cryptoKeyRecord`),
// whose typed arrays the serialization carries; undefined for an object that is no key.
export function cryptoKeyRecord(v) {
  const state = stateOf(v);
  if (state === undefined) return undefined;
  return { __csimType: 'CryptoKey', ...globalThis.__dom.cryptoKeyRecord(state) };
}
export const cryptoKeyFromRecord = (record) => keyFrom(globalThis.__dom.cryptoKeyFromRecord(record));

// ── Algorithm normalization ─────────────────────────────────────────────────
// The dictionary types the engine's registry names an algorithm's parameters by, each the generated conversion of its
// members beyond the Algorithm's `name` (an Algorithm alone has none).
const ALGORITHM_DICTIONARIES = {
  Algorithm:             () => ({}),
  AesCbcParams:          toAesCbcParamsMembersAfterAlgorithm,
  AesCtrParams:          toAesCtrParamsMembersAfterAlgorithm,
  AesDerivedKeyParams:   toAesDerivedKeyParamsMembersAfterAlgorithm,
  AesGcmParams:          toAesGcmParamsMembersAfterAlgorithm,
  AesKeyGenParams:       toAesKeyGenParamsMembersAfterAlgorithm,
  EcKeyGenParams:        toEcKeyGenParamsMembersAfterAlgorithm,
  EcKeyImportParams:     toEcKeyImportParamsMembersAfterAlgorithm,
  EcdhKeyDeriveParams:   toEcdhKeyDeriveParamsMembersAfterAlgorithm,
  EcdsaParams:           toEcdsaParamsMembersAfterAlgorithm,
  HkdfParams:            toHkdfParamsMembersAfterAlgorithm,
  HmacImportParams:      toHmacImportParamsMembersAfterAlgorithm,
  HmacKeyGenParams:      toHmacKeyGenParamsMembersAfterAlgorithm,
  Pbkdf2Params:          toPbkdf2ParamsMembersAfterAlgorithm,
  RsaHashedImportParams: toRsaHashedImportParamsMembersAfterAlgorithm,
  RsaHashedKeyGenParams: toRsaHashedKeyGenParamsMembersAfterAlgorithm,
  RsaOaepParams:         toRsaOaepParamsMembersAfterAlgorithm,
  RsaPssParams:          toRsaPssParamsMembersAfterAlgorithm
};

// "Normalize an algorithm" for `op` (WebCrypto §18.4.4): a string the dictionary {name: it}; an object converted to an
// Algorithm for its name, which the engine's registry looks up for the operation (none registered a NotSupportedError),
// then converted to the type it names — the name the registered one, the hash normalized as a digest, a CryptoKey
// member that key's slots and each BufferSource member a copy of its bytes. The `name` is read ONCE: the spec's steps
// convert the object to the Algorithm and then again to the type, reading it twice, but the WPT has a getter of it
// detach the operation's data and expects that to count once (WebCryptoAPI/*/… "with transferred … during call",
// some 500 subtests), and Chrome reads it once — a second read's detach throws.
function normalizeAlgorithm(op, alg, prefix) {
  if (typeof alg === 'string') return normalizeAlgorithm(op, { name: alg }, prefix);
  const { name } = toAlgorithm(alg, prefix);
  const registered = globalThis.__dom.cryptoRegistered(op, name);
  if (registered === null) throw domError(`Unrecognized algorithm name "${name}" for operation "${op}"`, 'NotSupportedError');
  const dict = ALGORITHM_DICTIONARIES[registered[1]](alg, prefix);
  dict.name = registered[0];
  for (const member of Object.keys(dict)) {
    const v = dict[member];
    if (member === 'hash') dict.hash = normalizeAlgorithm('digest', v, prefix);
    else if (member === 'public') dict.public = stateOf(v);
    else if (ArrayBuffer.isView(v) || isBufferOf(v, 'ArrayBuffer')) dict[member] = bytesOf(v);
  }
  return dict;
}
// …wrapKey's and unwrapKey's: the algorithm's wrap where one is registered, else (whatever failed) its encrypt /
// decrypt.
function normalizeWrapAlgorithm(op, fallback, alg, prefix) {
  try {
    return normalizeAlgorithm(op, alg, prefix);
  } catch (_) {
    return normalizeAlgorithm(fallback, alg, prefix);
  }
}

// A copy of the bytes a BufferSource holds — a detached one's none.
function bytesOf(source) {
  if (source.byteLength === 0) return new Uint8Array(0);
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();
}

// "Parse a JWK" from bytes (unwrapKey's "jwk"): their UTF-8 text through JSON.parse, converted to a JsonWebKey — one
// with no `kty` a DataError. Text that is no JSON is JSON.parse's SyntaxError, which the spec's steps let through
// (Chrome and Firefox both reject with a DataError).
function parseJwk(bytes, prefix) {
  const jwk = toJsonWebKey(JSON.parse(globalThis.__dom.decodeBytes(bytes, 'utf-8')), prefix);
  if (jwk.kty === undefined) throw domError('JWK has no "kty" member', 'DataError');
  return jwk;
}

// ── SubtleCrypto ────────────────────────────────────────────────────────────
// Generated from its IDL, made by the platform alone — a Crypto's `subtle`. The bindings convert the arguments (a key a
// CryptoKey, data a BufferSource, a format a KeyFormat), rejecting the promise where one is none; every operation then
// normalizes its algorithms and hands the engine the rest. A failure (a bad algorithm, a missing name, a usage error)
// rejects rather than throws, per the spec's "return a promise rejected with" — so callers only ever need a single
// `.catch`.
function promised(fn) {
  try {
    return resolvedPromise(fn());
  } catch (e) {
    return rejectedPromise(e);
  }
}
const prefixOf = (op) => `Failed to execute '${op}' on 'SubtleCrypto': `;

registerInterface('SubtleCrypto', (o) => slotsOf(o, 'SubtleCrypto') !== undefined);
class SubtleCrypto {
  constructor(token) {
    constructedBy(PLATFORM, token, 'SubtleCrypto');
    makeSlots(this, 'SubtleCrypto');
  }
}
installSubtleCrypto(SubtleCrypto, {
  digest: (subtle, algorithm, data) => promised(() => {
    return globalThis.__dom.cryptoDigest(normalizeAlgorithm('digest', algorithm, prefixOf('digest')), data);
  }),
  sign: (subtle, algorithm, key, data) => promised(() => {
    return globalThis.__dom.cryptoSign(normalizeAlgorithm('sign', algorithm, prefixOf('sign')), stateOf(key), data);
  }),
  verify: (subtle, algorithm, key, signature, data) => promised(() => {
    return globalThis.__dom.cryptoVerify(normalizeAlgorithm('verify', algorithm, prefixOf('verify')), stateOf(key), signature, data);
  }),
  encrypt: (subtle, algorithm, key, data) => promised(() => {
    return globalThis.__dom.cryptoEncrypt(normalizeAlgorithm('encrypt', algorithm, prefixOf('encrypt')), stateOf(key), data);
  }),
  decrypt: (subtle, algorithm, key, data) => promised(() => {
    return globalThis.__dom.cryptoDecrypt(normalizeAlgorithm('decrypt', algorithm, prefixOf('decrypt')), stateOf(key), data);
  }),

  // (…"jwk" data a JsonWebKey, any other format's a BufferSource: the other a TypeError, §14.3.9 step 4)
  importKey: (subtle, format, keyData, algorithm, extractable, usages) => promised(() => {
    const alg = normalizeAlgorithm('importKey', algorithm, prefixOf('importKey'));
    if ((format === 'jwk') === (ArrayBuffer.isView(keyData) || isBufferOf(keyData, 'ArrayBuffer'))) {
      throw new TypeError(format === 'jwk' ? 'importKey: a JsonWebKey is required' : 'importKey: a BufferSource is required');
    }
    return keyFrom(globalThis.__dom.cryptoImportKey(format, keyData, alg, extractable, usages));
  }),
  exportKey: (subtle, format, key) => promised(() => globalThis.__dom.cryptoExportKey(format, stateOf(key))),
  generateKey: (subtle, algorithm, extractable, usages) => promised(() => {
    const alg = normalizeAlgorithm('generateKey', algorithm, prefixOf('generateKey'));
    const made = globalThis.__dom.cryptoGenerateKey(alg, extractable, usages);
    // (…a key pair's two states as an array, read by no member a page's Object.prototype may answer)
    return Array.isArray(made) ? { publicKey: keyFrom(made[0]), privateKey: keyFrom(made[1]) } : keyFrom(made);
  }),

  deriveBits: (subtle, algorithm, baseKey, length) => promised(() => {
    const alg = normalizeAlgorithm('deriveBits', algorithm, prefixOf('deriveBits'));
    return globalThis.__dom.cryptoDeriveBits(alg, stateOf(baseKey), length ?? null);
  }),
  // (…the derived key's type normalized for its import and for its length — "get key length" — before the base key
  // is checked)
  deriveKey: (subtle, algorithm, baseKey, derivedKeyType, extractable, usages) => promised(() => {
    const prefix = prefixOf('deriveKey');
    const alg = normalizeAlgorithm('deriveBits', algorithm, prefix);
    const imported = normalizeAlgorithm('importKey', derivedKeyType, prefix);
    const length = normalizeAlgorithm('get key length', derivedKeyType, prefix);
    return keyFrom(globalThis.__dom.cryptoDeriveKey(alg, stateOf(baseKey), imported, length, extractable, usages));
  }),

  wrapKey: (subtle, format, key, wrappingKey, wrapAlgorithm) => promised(() => {
    const alg = normalizeWrapAlgorithm('wrapKey', 'encrypt', wrapAlgorithm, prefixOf('wrapKey'));
    return globalThis.__dom.cryptoWrapKey(format, stateOf(key), stateOf(wrappingKey), alg);
  }),
  // (…both algorithms normalized and the wrapped bytes copied before the key is checked; the unwrapped bytes a JWK's
  // JSON for "jwk")
  unwrapKey: (subtle, format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, usages) => promised(() => {
    const prefix = prefixOf('unwrapKey');
    const alg = normalizeWrapAlgorithm('unwrapKey', 'decrypt', unwrapAlgorithm, prefix);
    const imported = normalizeAlgorithm('importKey', unwrappedKeyAlgorithm, prefix);
    const bytes = globalThis.__dom.cryptoUnwrapBytes(alg, stateOf(unwrappingKey), wrappedKey);
    const keyData = format === 'jwk' ? parseJwk(bytes, prefix) : bytes;
    return keyFrom(globalThis.__dom.cryptoImportKey(format, keyData, imported, extractable, usages));
  })
});

// ── Crypto ──────────────────────────────────────────────────────────────────
// Generated from its IDL, made by the platform alone — a global's `crypto`, whose `subtle` is its own ([SameObject]).
// `getRandomValues` fills an integer-typed array only — any realm's, by its typed-array name: a float array or a
// DataView is a TypeMismatchError, a byte length over 65536 a QuotaExceededError. Both checks operate on the underlying
// bytes, so BigInt64 / BigUint64 arrays fill uniformly.
const RANDOM_INTEGER_TYPES = [
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'BigInt64Array',
  'BigUint64Array'
];

const MAX_RANDOM_BYTES = 65536;

const cryptoOf = (o) => slotsOf(o, 'Crypto');
registerInterface('Crypto', (o) => cryptoOf(o) !== undefined);
class Crypto {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Crypto');
    makeSlots(this, 'Crypto', { subtle: new SubtleCrypto(PLATFORM) });
  }
}
installCrypto(Crypto, {
  get_subtle: (c) => cryptoOf(c).subtle,

  getRandomValues(c, typedArray) {
    if (!RANDOM_INTEGER_TYPES.some((type) => isBufferOf(typedArray, type))) {
      throw domError('getRandomValues: an integer-typed array is required', 'TypeMismatchError');
    }
    if (typedArray.byteLength > MAX_RANDOM_BYTES) {
      throw new QuotaExceededError(`getRandomValues: length exceeds ${MAX_RANDOM_BYTES} bytes`);
    }
    globalThis.__dom.cryptoRandomFill(typedArray);
    return typedArray;
  },

  randomUUID: () => globalThis.__dom.cryptoRandomUUID()
});

// WindowOrWorkerGlobalScope's `crypto` (window.js, and a worker's scope).
export const crypto = new Crypto(PLATFORM);
export function installWebCrypto(g) {
  g.Crypto = Crypto;
  g.SubtleCrypto = SubtleCrypto;
  g.CryptoKey = CryptoKey;
}
