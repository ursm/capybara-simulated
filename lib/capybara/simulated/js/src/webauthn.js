// `navigator.credentials.create/get` + `PublicKeyCredential` for
// security-key / passkey flows. Ruby owns the crypto (ECDSA P-256 +
// CBOR-encoded attestation in `webauthn_state.rb`); tests configure
// their virtual authenticator via `cdp.with_virtual_authenticator`,
// monkey-patched in `csim_rspec.rb` to route through the host fns
// below.

import { bytesToLatin1, latin1ToBytes } from './bytes.js';

function bytesToB64Url(buf) {
  const u8 = toUint8(buf);
  return globalThis.btoa(bytesToLatin1(u8))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ToBytes(b64) {
  let s = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return latin1ToBytes(globalThis.atob(s));
}

function b64ToBuffer(b64) {
  return b64ToBytes(b64).buffer;
}

function toUint8(buf) {
  if (!buf) return new Uint8Array(0);
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (Array.isArray(buf)) return new Uint8Array(buf);
  return new Uint8Array(0);
}

function namedError(message, name) {
  const err = new Error(String(message || ''));
  err.name = name || 'NotAllowedError';
  return err;
}

// Host fn returns either the success payload or
// `{error: msg, name: 'InvalidStateError' | …}`. Discourse + most
// WebAuthn callers branch on `err.name` so the DOMException name
// must survive the round-trip — see the `safe_call` workaround in
// `runtime_shared.rb`.
function parseHostError(raw) {
  if (raw == null) return namedError('No virtual authenticator', 'NotAllowedError');
  if (typeof raw === 'object' && raw.error) {
    return namedError(raw.error, raw.name);
  }
  return null;
}

function abortIfNeeded(signal) {
  if (signal && signal.aborted) {
    throw namedError('The operation was aborted.', 'AbortError');
  }
}

class AuthenticatorResponse {
  constructor(clientDataJSON) {
    this.clientDataJSON = clientDataJSON;
  }
}

class AuthenticatorAttestationResponse extends AuthenticatorResponse {
  constructor(clientDataJSON, attestationObject) {
    super(clientDataJSON);
    this.attestationObject = attestationObject;
  }
  getTransports()        { return ['usb']; }
  getAuthenticatorData() { return this.attestationObject; }
  getPublicKey()         { return null; }
  getPublicKeyAlgorithm(){ return -7; }
}

class AuthenticatorAssertionResponse extends AuthenticatorResponse {
  constructor(clientDataJSON, authenticatorData, signature, userHandle) {
    super(clientDataJSON);
    this.authenticatorData = authenticatorData;
    this.signature = signature;
    this.userHandle = userHandle;
  }
}

class PublicKeyCredential {
  constructor({ id, rawId, response, type, authenticatorAttachment }) {
    this.id = id;
    this.rawId = rawId;
    this.response = response;
    this.type = type || 'public-key';
    this.authenticatorAttachment = authenticatorAttachment || 'cross-platform';
  }
  getClientExtensionResults() { return {}; }
}

PublicKeyCredential.isConditionalMediationAvailable = function () {
  return Promise.resolve(true);
};
PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () {
  return Promise.resolve(true);
};

class CredentialsContainer {
  create(options) {
    if (!options || !options.publicKey) {
      return Promise.reject(namedError('publicKey option required', 'NotSupportedError'));
    }
    const pk = options.publicKey;
    let req;
    try {
      abortIfNeeded(options.signal);
      req = {
        rp: { id: (pk.rp && pk.rp.id) || '', name: (pk.rp && pk.rp.name) || '' },
        user: {
          id:          bytesToB64Url(pk.user && pk.user.id),
          name:        (pk.user && pk.user.name) || '',
          displayName: (pk.user && pk.user.displayName) || ''
        },
        challenge:           bytesToB64Url(pk.challenge),
        pubKeyCredParams:    (pk.pubKeyCredParams || []).map(p => ({ type: p.type, alg: p.alg | 0 })),
        excludeCredentials:  (pk.excludeCredentials || []).map(c => ({
          type: c.type, id: bytesToB64Url(c.id)
        })),
        authenticatorSelection: pk.authenticatorSelection || {},
        attestation:            pk.attestation || 'none',
        origin:                 (globalThis.location && globalThis.location.origin) || ''
      };
    } catch (e) { return Promise.reject(e); }
    const result = globalThis.__csimWebauthnCreate(JSON.stringify(req));
    const err = parseHostError(result);
    if (err) return Promise.reject(err);
    return Promise.resolve(new PublicKeyCredential({
      id:    result.credentialId,
      rawId: b64ToBuffer(result.credentialId),
      response: new AuthenticatorAttestationResponse(
        b64ToBuffer(result.clientDataJSON),
        b64ToBuffer(result.attestationObject)
      ),
      type: 'public-key'
    }));
  }

  get(options) {
    if (!options || !options.publicKey) {
      return Promise.reject(namedError('publicKey option required', 'NotSupportedError'));
    }
    const pk = options.publicKey;
    let req;
    try {
      abortIfNeeded(options.signal);
      req = {
        rpId:             pk.rpId || (globalThis.location && globalThis.location.hostname) || '',
        challenge:        bytesToB64Url(pk.challenge),
        allowCredentials: (pk.allowCredentials || []).map(c => ({
          type: c.type, id: bytesToB64Url(c.id)
        })),
        userVerification: pk.userVerification || 'preferred',
        origin:           (globalThis.location && globalThis.location.origin) || ''
      };
    } catch (e) { return Promise.reject(e); }
    const result = globalThis.__csimWebauthnGet(JSON.stringify(req));
    const err = parseHostError(result);
    if (err) return Promise.reject(err);
    return Promise.resolve(new PublicKeyCredential({
      id:    result.credentialId,
      rawId: b64ToBuffer(result.credentialId),
      response: new AuthenticatorAssertionResponse(
        b64ToBuffer(result.clientDataJSON),
        b64ToBuffer(result.authenticatorData),
        b64ToBuffer(result.signature),
        result.userHandle ? b64ToBuffer(result.userHandle) : null
      ),
      type: 'public-key'
    }));
  }

  store()               { return Promise.resolve(); }
  preventSilentAccess() { return Promise.resolve(); }
}

globalThis.PublicKeyCredential              = PublicKeyCredential;
globalThis.AuthenticatorAttestationResponse = AuthenticatorAttestationResponse;
globalThis.AuthenticatorAssertionResponse   = AuthenticatorAssertionResponse;
globalThis.AuthenticatorResponse            = AuthenticatorResponse;

if (globalThis.navigator) {
  globalThis.navigator.credentials = new CredentialsContainer();
}
