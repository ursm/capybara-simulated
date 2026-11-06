// Credential Management's `navigator.credentials` and WebAuthn's PublicKeyCredential, generated from their IDL, for
// security-key / passkey flows. The client and its virtual authenticators are the engine's (webauthn.rs); a test adds
// them by `Browser#webauthn`. Here is what is a JS value: a request's promise and abort signal, and the objects an
// answer is made into, their state in slots, each made by the platform alone.

import { signalAborted, signalReason } from './abort.js';
import { addAbortAlgorithm, removeAbortAlgorithm } from './events.js';
import {
  installAuthenticatorAssertionResponse,
  installAuthenticatorAttestationResponse,
  installAuthenticatorResponse,
  installCredential,
  installCredentialsContainer,
  installPublicKeyCredential
} from './generated/bindings.js';
import {
  IntrinsicPromise, PLATFORM, constructedBy, makeSlots, registerInterface, resolvedPromise, slotsOf
} from './webidl.js';
import { DOMException } from './dom-exception.js';
import { queueTask } from './timers.js';

// The bytes of a BufferSource, base64url-encoded without padding — a JSON serialization's form.
const toBase64Url = (source) => globalThis.__dom.base64UrlEncode(source);
// …and back, to a fresh ArrayBuffer: anything that is no base64url an EncodingError (WebAuthn's "base64url decoding"
// failing, as parse*FromJSON reports it).
function fromBase64Url(text) {
  const buffer = globalThis.__dom.base64UrlDecode(text);
  if (buffer === null) throw new DOMException('The string is not valid base64url.', 'EncodingError');
  return buffer;
}
// The session the page's authenticators are of.
let sessionPartition = null;
const session = () => (sessionPartition ??= globalThis.__csimSessionPartition());

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
// (the authenticator data, the credential public key as SubjectPublicKeyInfo and its algorithm, the transports), or — an
// assertion's — its authenticator data, signature and user handle. Each ArrayBuffer is the response's own, made by the
// engine in this realm, the same one every time.
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
  constructor(token, answer) {
    super(token, answer.clientDataJSON);
    makeSlots(this, 'AuthenticatorAttestationResponse', {
      attestationObject: answer.attestationObject,
      authenticatorData: answer.authenticatorData,
      publicKey: answer.publicKey,
      publicKeyAlgorithm: answer.publicKeyAlgorithm,
      transports: answer.transports
    });
  }
}
installAuthenticatorAttestationResponse(AuthenticatorAttestationResponse, {
  get_attestationObject: (response) => responseOf(response).attestationObject,
  getTransports: (response) => responseOf(response).transports.slice(),
  getAuthenticatorData: (response) => responseOf(response).authenticatorData,
  getPublicKey: (response) => responseOf(response).publicKey,
  getPublicKeyAlgorithm: (response) => responseOf(response).publicKeyAlgorithm
});
class AuthenticatorAssertionResponse extends AuthenticatorResponse {
  constructor(token, answer) {
    super(token, answer.clientDataJSON);
    makeSlots(this, 'AuthenticatorAssertionResponse', {
      authenticatorData: answer.authenticatorData,
      signature: answer.signature,
      userHandle: answer.userHandle
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
// it, and whether it is discoverable, where credProps asked (the one client extension the client answers).
registerInterface('PublicKeyCredential', (o) => slotsOf(o, 'PublicKeyCredential') !== undefined);
class PublicKeyCredential extends Credential {
  constructor(token, answer, response) {
    super(token);
    makeSlots(this, 'Credential', { id: answer.credentialId, type: 'public-key' });
    makeSlots(this, 'PublicKeyCredential', {
      rawId: answer.rawId,
      response,
      authenticatorAttachment: answer.authenticatorAttachment,
      residentKey: answer.residentKey
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
    return {
      attestationObject: toBase64Url(r.attestationObject),
      authenticatorData: toBase64Url(r.authenticatorData),
      clientDataJSON: toBase64Url(r.clientDataJSON),
      publicKey: toBase64Url(r.publicKey),
      publicKeyAlgorithm: r.publicKeyAlgorithm,
      transports: r.transports.slice()
    };
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
  isUserVerifyingPlatformAuthenticatorAvailable: () => resolvedPromise(globalThis.__dom.webauthnPlatformAuthenticatorAvailable(session())),
  getClientCapabilities: () => resolvedPromise(globalThis.__dom.webauthnClientCapabilities(session())),
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
  // A relying party's signals about its credentials (WebAuthn §5.1.10): the engine's, its refusals their rejections.
  signalUnknownCredential(_, options) {
    globalThis.__dom.webauthnSignalUnknownCredential(session(), options);
    return resolvedPromise(undefined);
  },
  signalAllAcceptedCredentials(_, options) {
    globalThis.__dom.webauthnSignalAllAcceptedCredentials(session(), options);
    return resolvedPromise(undefined);
  },
  signalCurrentUserDetails(_, options) {
    globalThis.__dom.webauthnSignalCurrentUserDetails(options);
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
// Credential Management's steps (§2.5), in each algorithm's order, around the one credential type here: a document not
// fully active an InvalidStateError; no `publicKey` a NotSupportedError; a document not allowed to use the feature a
// NotAllowedError (webauthn.rs `allowed_to_use`); an aborted signal its reason; and a request of the type already under
// way (its settings' "active credential types") a NotAllowedError.
function checkFullyActive() {
  if (!globalThis.__dom.documentFullyActive()) throw new DOMException('The document is not fully active.', 'InvalidStateError');
}
function checkSignal(options) {
  if (options.signal === undefined) return;
  if (signalAborted(options.signal)) throw signalReason(options.signal);
}
function checkPublicKey(options) {
  if (options.publicKey === undefined) throw new DOMException('Only public-key credentials are supported.', 'NotSupportedError');
}
let requestActive = false;
function checkNotActive() {
  if (requestActive) throw new DOMException('A request is already pending.', 'NotAllowedError');
}
// A request made, its type active till it settles: the options snapshotted and the client's steps run now (`begin`), what
// they throw rejecting it in its task, as the authenticators' answer settles it — an abort before then having cancelled
// them, its reason what it rejects with, and `credential` making the answer a Credential. A conditional request nothing
// can answer yet is settled by nothing but an abort. (`begin` null: "silent", which no credential answers.)
function makeRequest(options, begin, credential) {
  requestActive = true;
  const partition = session();
  const signal = options.signal;
  return new IntrinsicPromise((resolve, reject) => {
    let number, refused = false, refusal, settled = false;
    if (begin !== null) {
      try {
        number = begin(partition, options.publicKey, options.mediation);
      } catch (e) {
        refused = true;
        refusal = e;
      }
    }
    const settle = (how, value) => {
      settled = true;
      requestActive = false;
      if (signal !== undefined) removeAbortAlgorithm(signal, aborted);
      how(value);
    };
    const aborted = () => {
      if (number !== undefined) globalThis.__dom.webauthnCancel(partition, number);
      settle(reject, signalReason(signal));
    };
    if (signal !== undefined) addAbortAlgorithm(signal, aborted);
    queueTask(() => {
      if (settled) return;
      if (refused) return settle(reject, refusal);
      if (begin === null) return settle(resolve, null);
      let answer;
      try {
        answer = globalThis.__dom.webauthnFinish(partition, number);
      } catch (e) {
        return settle(reject, e);
      }
      if (answer !== undefined) settle(resolve, credential(answer));
    });
  });
}
installCredentialsContainer(CredentialsContainer, {
  create(_, options) {
    checkFullyActive();
    checkPublicKey(options);
    globalThis.__dom.webauthnCheckPermission('publickey-credentials-create');
    checkSignal(options);
    checkNotActive();
    return makeRequest(options, globalThis.__dom.webauthnBeginCreate, (answer) => new PublicKeyCredential(PLATFORM, answer, new AuthenticatorAttestationResponse(PLATFORM, answer)));
  },
  get(_, options) {
    checkFullyActive();
    checkSignal(options);
    checkPublicKey(options);
    // (…no immediate mediation here: §2.5.1's TypeError for an interface without it)
    if (options.uiMode === 'immediate') throw new TypeError("Failed to execute 'get' on 'CredentialsContainer': Immediate mediation is not supported.");
    checkNotActive();
    globalThis.__dom.webauthnCheckPermission('publickey-credentials-get');
    // (…"silent": a public key credential always takes a gesture, so none, before any WebAuthn step looks at the options)
    return makeRequest(options, options.mediation === 'silent' ? null : globalThis.__dom.webauthnBeginGet, (answer) => new PublicKeyCredential(PLATFORM, answer, new AuthenticatorAssertionResponse(PLATFORM, answer)));
  },
  // (…a public-key credential is stored by its authenticator, never by `store`: a NotSupportedError)
  store() {
    checkFullyActive();
    throw new DOMException('Public-key credentials cannot be stored.', 'NotSupportedError');
  },
  preventSilentAccess() {
    checkFullyActive();
    return resolvedPromise(undefined);
  }
});

for (const iface of [Credential, PublicKeyCredential, AuthenticatorResponse, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse, CredentialsContainer]) {
  globalThis[iface.name] = iface;
}

// (…the page's credentials container, Navigator's `credentials` (navigator.js))
export const credentials = new CredentialsContainer(PLATFORM);
