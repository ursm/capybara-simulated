// Credential Management's `navigator.credentials` and WebAuthn's PublicKeyCredential, generated from their IDL, for
// security-key / passkey flows. The client and its virtual authenticators are the engine's (webauthn.rs); a test adds
// them by `Browser#webauthn`. Here is what is a JS value: a request's promise and abort signal, and the objects an
// answer is made into, their state in slots, each made by the platform alone.

import { signalAborted, signalReason } from './abort.js';
import { joinAgent } from './engine-notices.js';
import { addAbortAlgorithm, removeAbortAlgorithm } from './events.js';
import {
  defineCredentialsContainer,
  defineAuthenticatorAssertionResponse,
  defineAuthenticatorAttestationResponse,
  defineAuthenticatorResponse,
  defineCredential,
  definePublicKeyCredential
} from './generated/bindings.js';
import {
  IntrinsicPromise,
  PLATFORM,
  registerInterface,
  resolvedPromise,
  slotsOf
} from './webidl.js';
import { DOMException } from './dom-exception.js';
import { cancelTask, queueTask } from './timers.js';

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
const Credential = defineCredential({
  init() {},
  // (…a credential type with no conditional mediation of its own: none)
  isConditionalMediationAvailable: () => resolvedPromise(false)
});

// ── AuthenticatorResponse and its two kinds (WebAuthn §5.2) ─────────────────────────────────────────────────────────────
// A response's slots: its client data, and — an attestation's — its attestation object with what is read out of it
// (the authenticator data, the credential public key as SubjectPublicKeyInfo and its algorithm, the transports), or — an
// assertion's — its authenticator data, signature and user handle. Each ArrayBuffer is the response's own, made by the
// engine in this realm, the same one every time.
const responseOf = (o) => slotsOf(o, 'AuthenticatorResponse');
const AuthenticatorResponse = defineAuthenticatorResponse({ init() {} });
const AuthenticatorAttestationResponse = defineAuthenticatorAttestationResponse(AuthenticatorResponse, {
  init(s, answer) {
    s.clientDataJSON = answer.clientDataJSON;
    s.attestationObject = answer.attestationObject;
    s.authenticatorData = answer.authenticatorData;
    s.publicKey = answer.publicKey;
    s.publicKeyAlgorithm = answer.publicKeyAlgorithm;
    s.transports = answer.transports;
  },
  getTransports: (response) => responseOf(response).transports.slice(),
  getAuthenticatorData: (response) => responseOf(response).authenticatorData,
  getPublicKey: (response) => responseOf(response).publicKey,
  getPublicKeyAlgorithm: (response) => responseOf(response).publicKeyAlgorithm
});
const AuthenticatorAssertionResponse = defineAuthenticatorAssertionResponse(AuthenticatorResponse, {
  init(s, answer) {
    s.clientDataJSON = answer.clientDataJSON;
    s.authenticatorData = answer.authenticatorData;
    s.signature = answer.signature;
    s.userHandle = answer.userHandle;
  }
});

// ── PublicKeyCredential (WebAuthn §5.1) ─────────────────────────────────────────────────────────────────────────────────
// A credential's slots, beyond Credential's: its raw id and response, the attachment of the authenticator that made
// it, and whether it is discoverable, where credProps asked (the one client extension the client answers).
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
const PublicKeyCredential = definePublicKeyCredential(Credential, {
  init(s, answer, response) {
    s.id = answer.credentialId;
    s.type = 'public-key';
    s.rawId = answer.rawId;
    s.response = response;
    s.authenticatorAttachment = answer.authenticatorAttachment;
    s.residentKey = answer.residentKey;
  },
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
  isConditionalMediationAvailable: () => resolvedPromise(globalThis.__dom.webauthnClientCapabilities(session()).conditionalGet),
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
// A request's promise, its steps the engine's (webauthn.rs): `number` the one it made, undefined for a signal already
// aborted, whose reason it rejects with. The authenticators are asked in a task, and again as one becomes available, till
// one answers, its lifetime timer ends it, or its signal does. `credential` makes an answer a Credential.
const AUTHENTICATOR_AVAILABLE = 33;
let askAgain = null;
const authenticatorAvailable = () => { askAgain?.(); };
function signalled(options) {
  return options.signal !== undefined && signalAborted(options.signal);
}
function makeRequest(options, number, credential) {
  if (number === undefined) throw signalReason(options.signal);
  const signal = options.signal, partition = session();
  joinAgent(AUTHENTICATOR_AVAILABLE, AUTHENTICATOR_AVAILABLE, authenticatorAvailable);
  return new IntrinsicPromise((resolve, reject) => {
    const lifetime = globalThis.__dom.webauthnLifetime(number);
    let timer;
    const settle = (how, value) => {
      if (askAgain === ask) askAgain = null;
      if (timer !== undefined) cancelTask(timer);
      if (signal !== undefined) removeAbortAlgorithm(signal, aborted);
      how(value);
    };
    const aborted = () => {
      globalThis.__dom.webauthnCancel(number);
      settle(reject, signalReason(signal));
    };
    const ending = (step) => {
      try {
        return step();
      } catch (e) {
        settle(reject, e);
        return undefined;
      }
    };
    const ask = () => {
      const answer = ending(() => globalThis.__dom.webauthnAsk(partition, number));
      if (answer !== undefined) settle(resolve, answer === null ? null : credential(answer));
    };
    if (signal !== undefined) addAbortAlgorithm(signal, aborted);
    askAgain = ask;
    queueTask(ask);
    if (lifetime !== undefined) timer = queueTask(() => { ending(() => globalThis.__dom.webauthnExpire(number)); }, lifetime);
  });
}
function checkFullyActive() {
  if (!globalThis.__dom.documentFullyActive()) throw new DOMException('The document is not fully active.', 'InvalidStateError');
}
const CredentialsContainer = defineCredentialsContainer({
  init() {},
  create(_, options) {
    const number = globalThis.__dom.webauthnCreate(options, signalled(options));
    return makeRequest(options, number, (answer) => new PublicKeyCredential(PLATFORM, answer, new AuthenticatorAttestationResponse(PLATFORM, answer)));
  },
  get(_, options) {
    const number = globalThis.__dom.webauthnGet(options, signalled(options));
    return makeRequest(options, number, (answer) => new PublicKeyCredential(PLATFORM, answer, new AuthenticatorAssertionResponse(PLATFORM, answer)));
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
