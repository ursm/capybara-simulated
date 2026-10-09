// Credential Management's `navigator.credentials` and WebAuthn's PublicKeyCredential, generated from their IDL, for
// security-key / passkey flows. Ruby owns the crypto (ECDSA P-256 + CBOR-encoded attestation in `webauthn_state.rb`);
// tests configure their virtual authenticator via `cdp.with_virtual_authenticator`, monkey-patched in `csim_rspec.rb`
// to route through the host fns below. Every object here is made by the platform alone; its state is in slots.

import { bytesToLatin1, latin1ToBytes } from './bytes.js';
import {
  installAuthenticatorAssertionResponse,
  installAuthenticatorAttestationResponse,
  installAuthenticatorResponse,
  installCredential,
  installCredentialsContainer,
  installPublicKeyCredential
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, rejectedPromise, resolvedPromise, slotsOf } from './webidl.js';

// The bytes of a BufferSource (the bindings converted it), base64url-encoded without padding — the wire form the host
// takes, and a JSON serialization's.
function toBase64Url(source) {
  const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  return globalThis.__csimBtoa(bytesToLatin1(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// …and back, to a fresh ArrayBuffer: anything that is no base64url an EncodingError (WebAuthn's "base64url decoding"
// failing, as parse*FromJSON reports it).
function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new DOMException('The string is not valid base64url.', 'EncodingError');
  }
  let s = text.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return latin1ToBytes(globalThis.__csimAtob(s)).buffer;
}

// The host's answer — the success payload, or `{error, name}` (the DOMException name a caller branches on, which
// `safe_call` in runtime_shared.rb keeps), or nothing (no virtual authenticator): the error, or null for a success.
function hostError(raw) {
  if (raw == null) return new DOMException('No virtual authenticator', 'NotAllowedError');
  if (typeof raw === 'object' && raw.error) return new DOMException(String(raw.error), raw.name || 'NotAllowedError');
  return null;
}

const origin = () => (globalThis.location && globalThis.location.origin) || '';

// ── Credential (Credential Management §2.2) ─────────────────────────────────────────────────────────────────────────────
const credentialOf = (o) => slotsOf(o, 'Credential');
registerInterface('Credential', (o) => credentialOf(o) !== undefined);
class Credential {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Credential');
  }
}
installCredential(Credential, {
  get_id: (credential) => credentialOf(credential).id,
  get_type: (credential) => credentialOf(credential).type,
  // (…a credential type with no conditional mediation of its own: none)
  isConditionalMediationAvailable: () => resolvedPromise(false)
});

// ── AuthenticatorResponse and its two kinds (WebAuthn §5.2) ─────────────────────────────────────────────────────────────
// A response's slots: its client data, and — an attestation's — its attestation object with what is read out of it
// (the authenticator data, the credential public key as SubjectPublicKeyInfo, the transports), or — an assertion's —
// its authenticator data, signature and user handle. Each ArrayBuffer an attribute returns is [SameObject].
const responseOf = (o) => slotsOf(o, 'AuthenticatorResponse');
registerInterface('AuthenticatorResponse', (o) => responseOf(o) !== undefined);
registerInterface('AuthenticatorAttestationResponse', (o) => slotsOf(o, 'AuthenticatorAttestationResponse') !== undefined);
registerInterface('AuthenticatorAssertionResponse', (o) => slotsOf(o, 'AuthenticatorAssertionResponse') !== undefined);
class AuthenticatorResponse {
  constructor(token, clientDataJSON) {
    constructedBy(PLATFORM, token, 'AuthenticatorResponse');
    makeSlots(this, 'AuthenticatorResponse', { clientDataJSON });
  }
}
installAuthenticatorResponse(AuthenticatorResponse, { get_clientDataJSON: (response) => responseOf(response).clientDataJSON });
class AuthenticatorAttestationResponse extends AuthenticatorResponse {
  constructor(token, result) {
    super(token, fromBase64Url(result.clientDataJSON));
    makeSlots(this, 'AuthenticatorAttestationResponse', {
      attestationObject: fromBase64Url(result.attestationObject),
      authenticatorData: result.authenticatorData,
      publicKey: result.publicKey,
      transports: result.transports
    });
  }
}
// (…ES256, the one algorithm the virtual authenticator makes keys of)
const ES256 = -7;
installAuthenticatorAttestationResponse(AuthenticatorAttestationResponse, {
  get_attestationObject: (response) => responseOf(response).attestationObject,
  getTransports: (response) => responseOf(response).transports.slice(),
  getAuthenticatorData: (response) => fromBase64Url(responseOf(response).authenticatorData),
  getPublicKey: (response) => fromBase64Url(responseOf(response).publicKey),
  getPublicKeyAlgorithm: () => ES256
});
class AuthenticatorAssertionResponse extends AuthenticatorResponse {
  constructor(token, result) {
    super(token, fromBase64Url(result.clientDataJSON));
    makeSlots(this, 'AuthenticatorAssertionResponse', {
      authenticatorData: fromBase64Url(result.authenticatorData),
      signature: fromBase64Url(result.signature),
      userHandle: result.userHandle ? fromBase64Url(result.userHandle) : null
    });
  }
}
installAuthenticatorAssertionResponse(AuthenticatorAssertionResponse, {
  get_authenticatorData: (response) => responseOf(response).authenticatorData,
  get_signature: (response) => responseOf(response).signature,
  get_userHandle: (response) => responseOf(response).userHandle
});

// ── PublicKeyCredential (WebAuthn §5.1) ─────────────────────────────────────────────────────────────────────────────────
// A credential's slots, beyond Credential's: its raw id and response ([SameObject]), and the attachment of the
// authenticator that made it — from the host's result, as its response is.
registerInterface('PublicKeyCredential', (o) => slotsOf(o, 'PublicKeyCredential') !== undefined);
class PublicKeyCredential extends Credential {
  constructor(token, result, response) {
    super(token);
    makeSlots(this, 'Credential', { id: result.credentialId, type: 'public-key' });
    makeSlots(this, 'PublicKeyCredential', { rawId: fromBase64Url(result.credentialId), response, authenticatorAttachment: result.authenticatorAttachment });
  }
}
// The JSON of a response (WebAuthn §5.1.8): its buffers base64url, and an attestation's transports, public key and
// algorithm beside them.
function responseJSON(response) {
  const r = responseOf(response);
  const json = { clientDataJSON: toBase64Url(r.clientDataJSON) };
  if (r.attestationObject) {
    return Object.assign(json, {
      authenticatorData: r.authenticatorData,
      transports: r.transports.slice(),
      publicKey: r.publicKey,
      publicKeyAlgorithm: ES256,
      attestationObject: toBase64Url(r.attestationObject)
    });
  }
  Object.assign(json, { authenticatorData: toBase64Url(r.authenticatorData), signature: toBase64Url(r.signature) });
  if (r.userHandle) json.userHandle = toBase64Url(r.userHandle);
  return json;
}
// An RP ID a signal names must be this origin's host or a registrable suffix of it (WebAuthn §5.1.10): a SecurityError
// otherwise.
function checkRpId(rpId) {
  const host = (globalThis.location && globalThis.location.hostname) || '';
  if (rpId !== host && !host.endsWith('.' + rpId)) {
    throw new DOMException(`The RP ID "${rpId}" is not a registrable domain suffix of the origin.`, 'SecurityError');
  }
}
installPublicKeyCredential(PublicKeyCredential, {
  get_rawId: (credential) => slotsOf(credential, 'PublicKeyCredential').rawId,
  get_response: (credential) => slotsOf(credential, 'PublicKeyCredential').response,
  get_authenticatorAttachment: (credential) => slotsOf(credential, 'PublicKeyCredential').authenticatorAttachment,
  // (…no extension the virtual authenticator answers)
  getClientExtensionResults: () => ({}),
  toJSON(credential) {
    const c = credentialOf(credential), p = slotsOf(credential, 'PublicKeyCredential');
    return {
      id: c.id,
      rawId: c.id,
      response: responseJSON(p.response),
      authenticatorAttachment: p.authenticatorAttachment,
      clientExtensionResults: {},
      type: c.type
    };
  },
  isConditionalMediationAvailable: () => resolvedPromise(true),
  isUserVerifyingPlatformAuthenticatorAvailable: () => resolvedPromise(true),
  // (…what the virtual authenticator can do: a conditional get and a user-verifying authenticator, the signals — no
  // conditional create, hybrid transport, platform passkeys or related origins)
  getClientCapabilities: () => resolvedPromise({
    conditionalCreate: false,
    conditionalGet: true,
    hybridTransport: false,
    passkeyPlatformAuthenticator: false,
    userVerifyingPlatformAuthenticator: true,
    relatedOrigins: false,
    signalAllAcceptedCredentials: true,
    signalCurrentUserDetails: true,
    signalUnknownCredential: true
  }),
  // The options a server sent as JSON, their base64url members ArrayBuffers again (WebAuthn §5.1.9).
  parseCreationOptionsFromJSON(_, options) {
    const user = Object.assign({}, options.user, { id: fromBase64Url(options.user.id) });
    const parsed = Object.assign({}, options, { user, challenge: fromBase64Url(options.challenge) });
    parsed.excludeCredentials = options.excludeCredentials.map((c) => Object.assign({}, c, { id: fromBase64Url(c.id) }));
    return parsed;
  },
  parseRequestOptionsFromJSON(_, options) {
    const parsed = Object.assign({}, options, { challenge: fromBase64Url(options.challenge) });
    parsed.allowCredentials = options.allowCredentials.map((c) => Object.assign({}, c, { id: fromBase64Url(c.id) }));
    return parsed;
  },
  // A relying party's signal about its credentials (WebAuthn §5.1.10): checked — its RP ID, its ids base64url — and
  // taken; the virtual authenticator keeps no user-facing credential list it would change.
  signalUnknownCredential(_, options) {
    checkRpId(options.rpId);
    fromBase64Url(options.credentialId);
    return resolvedPromise(undefined);
  },
  signalAllAcceptedCredentials(_, options) {
    checkRpId(options.rpId);
    fromBase64Url(options.userId);
    for (const id of options.allAcceptedCredentialIds) fromBase64Url(id);
    return resolvedPromise(undefined);
  },
  signalCurrentUserDetails(_, options) {
    checkRpId(options.rpId);
    fromBase64Url(options.userId);
    return resolvedPromise(undefined);
  }
});

// ── CredentialsContainer (Credential Management §2.3) — Navigator's `credentials` ───────────────────────────────────────
registerInterface('CredentialsContainer', (o) => slotsOf(o, 'CredentialsContainer') !== undefined);
class CredentialsContainer {
  constructor(token) {
    constructedBy(PLATFORM, token, 'CredentialsContainer');
    makeSlots(this, 'CredentialsContainer');
  }
}
// The request's options — a CredentialCreationOptions / CredentialRequestOptions the bindings converted — taken only
// with a `publicKey` member, the one credential type here (else a NotSupportedError), and an aborted signal its reason.
function publicKeyOf(options) {
  if (options.publicKey === undefined) throw new DOMException('Only public-key credentials are supported.', 'NotSupportedError');
  if (options.signal !== undefined && options.signal.aborted) throw options.signal.reason;
  return options.publicKey;
}
installCredentialsContainer(CredentialsContainer, {
  create(_, options) {
    let request;
    try {
      const pk = publicKeyOf(options);
      request = {
        rp: { id: pk.rp.id ?? '', name: pk.rp.name },
        user: { id: toBase64Url(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        challenge: toBase64Url(pk.challenge),
        pubKeyCredParams: pk.pubKeyCredParams.map((p) => ({ type: p.type, alg: p.alg })),
        excludeCredentials: pk.excludeCredentials.map((c) => ({ type: c.type, id: toBase64Url(c.id) })),
        authenticatorSelection: pk.authenticatorSelection ?? {},
        attestation: pk.attestation,
        origin: origin()
      };
    } catch (e) { return rejectedPromise(e); }
    const result = globalThis.__csimWebauthnCreate(JSON.stringify(request));
    const error = hostError(result);
    if (error) return rejectedPromise(error);
    return resolvedPromise(new PublicKeyCredential(PLATFORM, result, new AuthenticatorAttestationResponse(PLATFORM, result)));
  },
  get(_, options) {
    let request;
    try {
      const pk = publicKeyOf(options);
      request = {
        rpId: pk.rpId ?? ((globalThis.location && globalThis.location.hostname) || ''),
        challenge: toBase64Url(pk.challenge),
        allowCredentials: pk.allowCredentials.map((c) => ({ type: c.type, id: toBase64Url(c.id) })),
        userVerification: pk.userVerification,
        origin: origin()
      };
    } catch (e) { return rejectedPromise(e); }
    const result = globalThis.__csimWebauthnGet(JSON.stringify(request));
    const error = hostError(result);
    if (error) return rejectedPromise(error);
    return resolvedPromise(new PublicKeyCredential(PLATFORM, result, new AuthenticatorAssertionResponse(PLATFORM, result)));
  },
  // (…a public-key credential is stored by its authenticator, never by `store`: a NotSupportedError)
  store: () => rejectedPromise(new DOMException('Public-key credentials cannot be stored.', 'NotSupportedError')),
  preventSilentAccess: () => resolvedPromise(undefined)
});

for (const iface of [Credential, PublicKeyCredential, AuthenticatorResponse, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse, CredentialsContainer]) {
  globalThis[iface.name] = iface;
}

// (…the page's credentials container, Navigator's `credentials` (navigator.js))
export const credentials = new CredentialsContainer(PLATFORM);
