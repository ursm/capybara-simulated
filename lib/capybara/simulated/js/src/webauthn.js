// Credential Management's `navigator.credentials` and WebAuthn's PublicKeyCredential, generated from their IDL, for
// security-key / passkey flows. Ruby owns the crypto (ECDSA P-256 + CBOR-encoded attestation in `webauthn_state.rb`);
// tests configure their virtual authenticator via `cdp.with_virtual_authenticator`, monkey-patched in `csim_rspec.rb`
// to route through the host fns below. Every object here is made by the platform alone; its state is in slots.

import { signalOf } from './abort.js';
import { bytesToLatin1, latin1ToBytes } from './bytes.js';
import { documentOrigin } from './platform-globals.js';
import {
  installAuthenticatorAssertionResponse,
  installAuthenticatorAttestationResponse,
  installAuthenticatorResponse,
  installCredential,
  installCredentialsContainer,
  installPublicKeyCredential
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, resolvedPromise, slotsOf } from './webidl.js';

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
// …where a signal names an id: a TypeError (WebAuthn §5.1.10), before anything else of it is looked at.
function signalledId(member, name, text) {
  try {
    return fromBase64Url(text);
  } catch {
    throw new TypeError(`Failed to execute '${member}' on 'PublicKeyCredential': Invalid base64url string for ${name}.`);
  }
}

// The host's answer — the success payload, or `{error, name}` (the DOMException name a caller branches on, which
// `safe_call` in runtime_shared.rb keeps), or nothing (no virtual authenticator): the error, or null for a success.
function hostError(raw) {
  if (raw == null) return new DOMException('No virtual authenticator', 'NotAllowedError');
  if (typeof raw === 'object' && raw.error) return new DOMException(String(raw.error), raw.name || 'NotAllowedError');
  return null;
}

// The caller's origin — its document's, an about:blank or srcdoc frame's its creator's — and its effective domain,
// which every ceremony and signal is for (WebAuthn §5.1.3, §5.1.4.1, §5.1.10.1): an opaque origin a NotAllowedError, a
// host that is no valid domain — an IP address, as Chrome says too — a SecurityError. An RP ID, where one is given,
// must be the domain or a registrable domain suffix of it — here, with no public suffix list, any suffix of it of more
// than one label.
function effectiveDomain() {
  const origin = documentOrigin();
  if (origin === 'null' || origin === '') throw new DOMException('The origin is opaque.', 'NotAllowedError');
  // (…its host: the serialized origin past its scheme, less its port)
  const host = origin.slice(origin.indexOf('//') + 2).replace(/:\d+$/, '');
  if (host === '' || host.startsWith('[') || /^[0-9.]+$/.test(host)) throw new DOMException('This is an invalid domain.', 'SecurityError');
  return host;
}
function checkRpId(rpId) {
  const host = effectiveDomain();
  if (rpId === undefined || rpId === host || (rpId.includes('.') && host.endsWith('.' + rpId))) return;
  throw new DOMException(`The relying party ID '${rpId}' is not a registrable domain suffix of, nor equal to the current domain.`, 'SecurityError');
}

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
// its authenticator data, signature and user handle. Each ArrayBuffer is the response's own, the same one every time.
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
      authenticatorData: fromBase64Url(result.authenticatorData),
      publicKey: result.publicKey ? fromBase64Url(result.publicKey) : null,
      transports: result.transports
    });
  }
}
// (…ES256, the one algorithm the virtual authenticator makes keys of)
const ES256 = -7;
installAuthenticatorAttestationResponse(AuthenticatorAttestationResponse, {
  get_attestationObject: (response) => responseOf(response).attestationObject,
  getTransports: (response) => responseOf(response).transports.slice(),
  getAuthenticatorData: (response) => responseOf(response).authenticatorData,
  getPublicKey: (response) => responseOf(response).publicKey,
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
// A credential's slots, beyond Credential's: its raw id and response, the attachment of the authenticator that made
// it — from the host's result, as its response is — and whether it is discoverable, where credProps asked (the one
// client extension the virtual authenticator answers).
registerInterface('PublicKeyCredential', (o) => slotsOf(o, 'PublicKeyCredential') !== undefined);
class PublicKeyCredential extends Credential {
  constructor(token, result, response, residentKey) {
    super(token);
    makeSlots(this, 'Credential', { id: result.credentialId, type: 'public-key' });
    makeSlots(this, 'PublicKeyCredential', {
      rawId: fromBase64Url(result.credentialId),
      response,
      authenticatorAttachment: result.authenticatorAttachment,
      residentKey
    });
  }
}
// (…a fresh object each time, as the dictionary converts to one)
const extensionOutputs = (p) => (p.residentKey === undefined ? {} : { credProps: { rk: p.residentKey } });
// The JSON of a response (WebAuthn §5.1.8) — a RegistrationResponseJSON's or AuthenticationResponseJSON's, its members in
// the dictionary's (lexicographical) order: its buffers base64url, and an attestation's transports, public key and
// algorithm beside them.
function responseJSON(response) {
  const r = responseOf(response);
  if (r.attestationObject) {
    const json = {
      attestationObject: toBase64Url(r.attestationObject),
      authenticatorData: toBase64Url(r.authenticatorData),
      clientDataJSON: toBase64Url(r.clientDataJSON)
    };
    if (r.publicKey !== null) json.publicKey = toBase64Url(r.publicKey);
    json.publicKeyAlgorithm = ES256;
    json.transports = r.transports.slice();
    return json;
  }
  const json = {
    authenticatorData: toBase64Url(r.authenticatorData),
    clientDataJSON: toBase64Url(r.clientDataJSON),
    signature: toBase64Url(r.signature)
  };
  if (r.userHandle !== null) json.userHandle = toBase64Url(r.userHandle);
  return json;
}
// The client extension inputs of options a server sent as JSON, their base64url members ArrayBuffers again (WebAuthn
// §5.1.8-9: "this conversion MUST also apply to any client extension inputs"): `prf`'s salts and `largeBlob`'s write,
// the rest as they are.
function extensionsFromJSON(extensions) {
  const parsed = Object.assign({}, extensions);
  const values = (v) => {
    const out = { first: fromBase64Url(v.first) };
    if (v.second !== undefined) out.second = fromBase64Url(v.second);
    return out;
  };
  if (extensions.prf !== undefined) {
    const prf = {};
    if (extensions.prf.eval !== undefined) prf.eval = values(extensions.prf.eval);
    if (extensions.prf.evalByCredential !== undefined) {
      prf.evalByCredential = {};
      for (const [id, v] of Object.entries(extensions.prf.evalByCredential)) prf.evalByCredential[id] = values(v);
    }
    parsed.prf = prf;
  }
  if (extensions.largeBlob !== undefined) {
    parsed.largeBlob = Object.assign({}, extensions.largeBlob);
    if (extensions.largeBlob.write !== undefined) parsed.largeBlob.write = fromBase64Url(extensions.largeBlob.write);
  }
  return parsed;
}
const descriptorsFromJSON = (descriptors) => descriptors.map((c) => Object.assign({}, c, { id: fromBase64Url(c.id) }));
installPublicKeyCredential(PublicKeyCredential, {
  get_rawId: (credential) => slotsOf(credential, 'PublicKeyCredential').rawId,
  get_response: (credential) => slotsOf(credential, 'PublicKeyCredential').response,
  get_authenticatorAttachment: (credential) => slotsOf(credential, 'PublicKeyCredential').authenticatorAttachment,
  getClientExtensionResults: (credential) => extensionOutputs(slotsOf(credential, 'PublicKeyCredential')),
  toJSON(credential) {
    const c = credentialOf(credential), p = slotsOf(credential, 'PublicKeyCredential');
    return {
      authenticatorAttachment: p.authenticatorAttachment,
      clientExtensionResults: extensionOutputs(p),
      id: c.id,
      rawId: c.id,
      response: responseJSON(p.response),
      type: c.type
    };
  },
  isConditionalMediationAvailable: () => resolvedPromise(true),
  isUserVerifyingPlatformAuthenticatorAvailable: () => resolvedPromise(true),
  // What the virtual authenticator can do (WebAuthn §5.1.7, its keys in lexicographical order): a conditional get and a
  // user-verifying authenticator, and the signals — no conditional create, hybrid transport, platform passkeys or
  // related origins.
  getClientCapabilities: () => resolvedPromise({
    conditionalCreate: false,
    conditionalGet: true,
    hybridTransport: false,
    passkeyPlatformAuthenticator: false,
    relatedOrigins: false,
    signalAllAcceptedCredentials: true,
    signalCurrentUserDetails: true,
    signalUnknownCredential: true,
    userVerifyingPlatformAuthenticator: true
  }),
  // The options a server sent as JSON, their base64url members ArrayBuffers again (WebAuthn §5.1.9).
  parseCreationOptionsFromJSON(_, options) {
    const parsed = Object.assign({}, options, {
      user: Object.assign({}, options.user, { id: fromBase64Url(options.user.id) }),
      challenge: fromBase64Url(options.challenge),
      excludeCredentials: descriptorsFromJSON(options.excludeCredentials)
    });
    if (options.extensions !== undefined) parsed.extensions = extensionsFromJSON(options.extensions);
    return parsed;
  },
  parseRequestOptionsFromJSON(_, options) {
    const parsed = Object.assign({}, options, {
      challenge: fromBase64Url(options.challenge),
      allowCredentials: descriptorsFromJSON(options.allowCredentials)
    });
    if (options.extensions !== undefined) parsed.extensions = extensionsFromJSON(options.extensions);
    return parsed;
  },
  // A relying party's signals about its credentials (WebAuthn §5.1.10): their ids decoded, the RP ID validated, then
  // the authenticator's action — the unknown credential removed, the user's credentials outside the accepted ones
  // removed. (A user's details are no state the virtual authenticator keeps.)
  signalUnknownCredential(_, options) {
    signalledId('signalUnknownCredential', 'credentialId', options.credentialId);
    checkRpId(options.rpId);
    globalThis.__csimWebauthnSignalUnknownCredential(options.rpId, options.credentialId);
    return resolvedPromise(undefined);
  },
  signalAllAcceptedCredentials(_, options) {
    signalledId('signalAllAcceptedCredentials', 'userId', options.userId);
    for (const id of options.allAcceptedCredentialIds) signalledId('signalAllAcceptedCredentials', 'allAcceptedCredentialIds', id);
    checkRpId(options.rpId);
    globalThis.__csimWebauthnSignalAllAcceptedCredentials(options.rpId, options.userId, options.allAcceptedCredentialIds);
    return resolvedPromise(undefined);
  },
  signalCurrentUserDetails(_, options) {
    signalledId('signalCurrentUserDetails', 'userId', options.userId);
    checkRpId(options.rpId);
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
// A request's steps, in Credential Management's order (§2.5.1-2): `create` refuses options with no credential type it
// knows before it looks at the signal, `get` the other way round — `publicKey` the one type here, a NotSupportedError
// without it, an aborted signal its reason.
function checkSignal(options) {
  if (options.signal === undefined) return;
  const signal = signalOf(options.signal);
  if (signal.aborted) throw signal.reason;
}
function checkPublicKey(options) {
  if (options.publicKey === undefined) throw new DOMException('Only public-key credentials are supported.', 'NotSupportedError');
}
// The host's result, or the error it reports.
function hostResult(result) {
  const error = hostError(result);
  if (error) throw error;
  return result;
}
installCredentialsContainer(CredentialsContainer, {
  create(_, options) {
    checkPublicKey(options);
    checkSignal(options);
    const pk = options.publicKey;
    if (pk.user.id.byteLength < 1 || pk.user.id.byteLength > 64) {
      throw new TypeError("Failed to execute 'create' on 'CredentialsContainer': The `user.id` attribute must be between 1 and 64 bytes long.");
    }
    checkRpId(pk.rp.id);
    const result = hostResult(globalThis.__csimWebauthnCreate(JSON.stringify({
      rp: { id: pk.rp.id ?? effectiveDomain(), name: pk.rp.name },
      user: { id: toBase64Url(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      challenge: toBase64Url(pk.challenge),
      pubKeyCredParams: pk.pubKeyCredParams.map((p) => ({ type: p.type, alg: p.alg })),
      excludeCredentials: pk.excludeCredentials.map((c) => ({ type: c.type, id: toBase64Url(c.id) })),
      authenticatorSelection: pk.authenticatorSelection ?? {},
      attestation: pk.attestation,
      origin: documentOrigin()
    })));
    const response = new AuthenticatorAttestationResponse(PLATFORM, result);
    return resolvedPromise(new PublicKeyCredential(PLATFORM, result, response, pk.extensions?.credProps ? result.residentKey : undefined));
  },
  get(_, options) {
    checkSignal(options);
    checkPublicKey(options);
    const pk = options.publicKey;
    checkRpId(pk.rpId);
    const result = hostResult(globalThis.__csimWebauthnGet(JSON.stringify({
      rpId: pk.rpId ?? effectiveDomain(),
      challenge: toBase64Url(pk.challenge),
      allowCredentials: pk.allowCredentials.map((c) => ({ type: c.type, id: toBase64Url(c.id) })),
      userVerification: pk.userVerification,
      origin: documentOrigin()
    })));
    return resolvedPromise(new PublicKeyCredential(PLATFORM, result, new AuthenticatorAssertionResponse(PLATFORM, result), undefined));
  },
  // (…a public-key credential is stored by its authenticator, never by `store`: a NotSupportedError)
  store() {
    throw new DOMException('Public-key credentials cannot be stored.', 'NotSupportedError');
  },
  preventSilentAccess: () => resolvedPromise(undefined)
});

for (const iface of [Credential, PublicKeyCredential, AuthenticatorResponse, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse, CredentialsContainer]) {
  globalThis[iface.name] = iface;
}

// (…the page's credentials container, Navigator's `credentials` (navigator.js))
export const credentials = new CredentialsContainer(PLATFORM);
