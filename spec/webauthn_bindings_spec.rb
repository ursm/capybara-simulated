# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Credential Management's CredentialsContainer and WebAuthn's PublicKeyCredential family, generated from their IDL:
# made by the platform alone (an Illegal constructor for a page), their state in slots, their arguments converted. An
# attestation response reads its authenticator data and SubjectPublicKeyInfo public key; a credential serializes to JSON
# and options parse from it; `store` is a NotSupportedError for a public-key credential, as is a request without
# `publicKey`, and `store` of anything but a Credential a TypeError.
RSpec.describe 'WebAuthn bindings' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']] } }

  def run(session, script)
    session.execute_script(<<~JS)
      globalThis.__out = null;
      (async () => { #{script} })().then((v) => { globalThis.__out = v; }, (e) => { globalThis.__out = 'threw ' + e.name; });
    JS
    session.evaluate_script('globalThis.__out')
  end

  it 'is what their IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const rejection = (p) => p.then(() => 'none', (e) => e.name);
      return [
        err(() => new PublicKeyCredential()), err(() => new CredentialsContainer()), err(() => new AuthenticatorResponse()),
        navigator.credentials === navigator.credentials, navigator.credentials instanceof CredentialsContainer,
        Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential').enumerable,
        Object.getPrototypeOf(PublicKeyCredential.prototype) === Credential.prototype,
        await rejection(navigator.credentials.store(null)), await rejection(navigator.credentials.create({})),
        await rejection(navigator.credentials.get()), await rejection(navigator.credentials.create({publicKey: {}})),
        await Credential.isConditionalMediationAvailable(), await PublicKeyCredential.isConditionalMediationAvailable()
      ];
    JS
    expect(out).to eq([
      'TypeError', 'TypeError', 'TypeError', true, true, false, true,
      'TypeError', 'NotSupportedError', 'NotSupportedError', 'TypeError', false, true
    ])
  end

  it 'parses options from JSON, base64url members ArrayBuffers again' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const o = PublicKeyCredential.parseCreationOptionsFromJSON({
        rp: {name: 'x'}, user: {id: 'AQID', name: 'u', displayName: 'U'}, challenge: 'BAUG',
        pubKeyCredParams: [{type: 'public-key', alg: -7}], excludeCredentials: [{type: 'public-key', id: 'Bw'}]
      });
      const r = PublicKeyCredential.parseRequestOptionsFromJSON({challenge: '_-8'});
      let bad;
      try { PublicKeyCredential.parseRequestOptionsFromJSON({challenge: 'a+b'}); } catch (e) { bad = e.name; }
      return [
        [...new Uint8Array(o.user.id)], [...new Uint8Array(o.challenge)], [...new Uint8Array(o.excludeCredentials[0].id)],
        [...new Uint8Array(r.challenge)], r.allowCredentials, bad
      ];
    JS
    expect(out).to eq([[1, 2, 3], [4, 5, 6], [7], [255, 239], [], 'EncodingError'])
  end

  it 'registers and asserts through the virtual authenticator' do
    session = simulated_session(app)
    session.visit '/'
    session.driver.browser.webauthn.add_virtual_authenticator('transport' => 'internal', 'hasResidentKey' => true)
    out = run(session, <<~JS)
      const created = await navigator.credentials.create({publicKey: {
        rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array([2]),
        pubKeyCredParams: [{type: 'public-key', alg: -7}], authenticatorSelection: {residentKey: 'required'}
      }});
      const response = created.response;
      const json = created.toJSON();
      const key = await crypto.subtle.importKey('spki', response.getPublicKey(), {name: 'ECDSA', namedCurve: 'P-256'}, true, ['verify']);
      const got = await navigator.credentials.get({publicKey: {challenge: new Uint8Array([3]), allowCredentials: [{type: 'public-key', id: created.rawId}]}});
      return [
        created instanceof PublicKeyCredential, response instanceof AuthenticatorAttestationResponse, created.type,
        created.authenticatorAttachment, created.rawId === created.rawId, response.getTransports(),
        response.getAuthenticatorData().byteLength > 37, response.getPublicKeyAlgorithm(), key.type,
        Object.keys(json), json.id === created.id, json.response.publicKeyAlgorithm, json.response.transports,
        got.id === created.id, got.response instanceof AuthenticatorAssertionResponse,
        [...new Uint8Array(got.response.userHandle)], JSON.parse(new TextDecoder().decode(got.response.clientDataJSON)).type,
        got.response.signature.byteLength > 0, await navigator.credentials.store(created).then(() => 'none', (e) => e.name)
      ];
    JS
    expect(out).to eq([
      true, true, 'public-key', 'platform', true, ['internal'], true, -7, 'public',
      %w[id rawId response authenticatorAttachment clientExtensionResults type], true, -7, ['internal'],
      true, true, [1], 'webauthn.get', true, 'NotSupportedError'
    ])
  end
end
