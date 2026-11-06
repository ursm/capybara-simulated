# frozen_string_literal: true

require 'base64'
require 'capybara/simulated'
require 'digest'
require 'json'
require 'openssl'
require_relative 'support/every_host_local'
require_relative 'support/session_teardown'

# Credential Management's CredentialsContainer and WebAuthn's PublicKeyCredential family, generated from their IDL:
# made by the platform alone (an Illegal constructor for a page), their state in slots, their arguments converted. An
# attestation response reads its authenticator data and SubjectPublicKeyInfo public key; a credential serializes to JSON
# and options parse from it, extension inputs too; `store` is a NotSupportedError for a public-key credential, as is a
# request without `publicKey`, and `store` of anything but a Credential a TypeError.
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
      const r = PublicKeyCredential.parseRequestOptionsFromJSON({challenge: '_-8', extensions: {prf: {eval: {first: 'AQ'}}, largeBlob: {write: 'Ag'}, appid: 'x'}});
      let bad;
      try { PublicKeyCredential.parseRequestOptionsFromJSON({challenge: 'a+b'}); } catch (e) { bad = e.name; }
      return [
        [...new Uint8Array(o.user.id)], [...new Uint8Array(o.challenge)], [...new Uint8Array(o.excludeCredentials[0].id)],
        [...new Uint8Array(r.challenge)], r.allowCredentials, bad, [...new Uint8Array(r.extensions.prf.eval.first)],
        [...new Uint8Array(r.extensions.largeBlob.write)], r.extensions.appid
      ];
    JS
    expect(out).to eq([[1, 2, 3], [4, 5, 6], [7], [255, 239], [], 'EncodingError', [1], [2], 'x'])
  end

  it 'registers and asserts through the virtual authenticator' do
    session = simulated_session(app)
    session.visit '/'
    session.driver.browser.webauthn.add_virtual_authenticator 'transport' => 'internal', 'hasResidentKey' => true
    out = run(session, <<~JS)
      const created = await navigator.credentials.create({publicKey: {
        rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array([2]),
        pubKeyCredParams: [{type: 'public-key', alg: -7}], authenticatorSelection: {residentKey: 'required'}, extensions: {credProps: true}
      }});
      const response = created.response;
      const json = created.toJSON();
      const key = await crypto.subtle.importKey('spki', response.getPublicKey(), {name: 'ECDSA', namedCurve: 'P-256'}, true, ['verify']);
      const got = await navigator.credentials.get({publicKey: {challenge: new Uint8Array([3]), allowCredentials: [{type: 'public-key', id: created.rawId}]}});
      return [
        created instanceof PublicKeyCredential, response instanceof AuthenticatorAttestationResponse, created.type,
        created.authenticatorAttachment, created.rawId === created.rawId, response.getTransports(),
        response.getAuthenticatorData().byteLength > 37, response.getAuthenticatorData() === response.getAuthenticatorData(),
        response.getPublicKeyAlgorithm(), key.type, created.getClientExtensionResults(), Object.keys(json), Object.keys(json.response), json.id === created.id, json.response.publicKeyAlgorithm, json.response.transports,
        got.id === created.id, got.response instanceof AuthenticatorAssertionResponse,
        [...new Uint8Array(got.response.userHandle)], JSON.parse(new TextDecoder().decode(got.response.clientDataJSON)).type,
        got.response.signature.byteLength > 0, await navigator.credentials.store(created).then(() => 'none', (e) => e.name)
      ];
    JS
    expect(out).to eq([
      true, true, 'public-key', 'platform', true, ['internal'], true, true, -7, 'public', {'credProps' => {'rk' => true}},
      %w[authenticatorAttachment clientExtensionResults id rawId response type],
      %w[attestationObject authenticatorData clientDataJSON publicKey publicKeyAlgorithm transports], true, -7, ['internal'],
      true, true, [1], 'webauthn.get', true, 'NotSupportedError'
    ])
  end

  # The relying party's signals: an id that is no base64url a TypeError before the RP ID is looked at, an RP ID that is no
  # suffix of the domain a SecurityError, and the authenticator's action taken — an unknown credential removed.
  it 'takes the signals' do
    session = simulated_session(app)
    session.visit '/'
    webauthn = session.driver.browser.webauthn
    handle = webauthn.add_virtual_authenticator('hasResidentKey' => true)
    out = run(session, <<~JS)
      const rejection = (p) => p.then(() => 'none', (e) => e.name);
      const created = await navigator.credentials.create({publicKey: {
        rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array([2]),
        pubKeyCredParams: [{type: 'public-key', alg: -7}]
      }});
      const before = await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array([3]), allowCredentials: [{type: 'public-key', id: created.rawId}]}}));
      return [
        await rejection(PublicKeyCredential.signalUnknownCredential({rpId: 'other.test', credentialId: 'a+b'})),
        await rejection(PublicKeyCredential.signalUnknownCredential({rpId: 'other.test', credentialId: created.id})),
        await rejection(PublicKeyCredential.signalUnknownCredential({rpId: 'com', credentialId: created.id})),
        before, await rejection(PublicKeyCredential.signalUnknownCredential({rpId: location.hostname, credentialId: created.id})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array([3]), allowCredentials: [{type: 'public-key', id: created.rawId}]}})),
        Object.keys(await PublicKeyCredential.getClientCapabilities()).join() === Object.keys(await PublicKeyCredential.getClientCapabilities()).sort().join()
      ];
    JS
    expect(out).to eq(['TypeError', 'SecurityError', 'SecurityError', 'none', 'none', 'NotAllowedError', true])
    expect(webauthn.get_credentials(handle)).to eq([])
  end

  # A request's order of checks (Credential Management §2.5): `get` looks at the signal before the credential types,
  # `create` the other way round; and an IP address is no valid domain to make a credential for (Chrome alike).
  it 'checks a request in order' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const rejection = (p) => p.then(() => 'none', (e) => e.name);
      const aborted = AbortSignal.abort(new RangeError('stop'));
      return [await rejection(navigator.credentials.get({signal: aborted})), await rejection(navigator.credentials.create({signal: aborted}))];
    JS
    expect(out).to eq(%w[RangeError NotSupportedError])
    session.visit 'http://127.0.0.1/'
    out = run(session, <<~JS)
      const rejection = (p) => p.then(() => 'none', (e) => e.name);
      return [await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array([1])}}))];
    JS
    expect(out).to eq(['SecurityError'])
  end

  # A credential that is not discoverable answers only a request naming it (Chrome's virtual authenticator alike); a
  # frame that inherits its creator's origin makes credentials for it; and the extension outputs are the platform's own.
  it 'finds a non-discoverable credential only by its id' do
    session = simulated_session(app)
    session.visit '/'
    session.driver.browser.webauthn.add_virtual_authenticator 'hasResidentKey' => true
    out = run(session, <<~JS)
      const rejection = (p) => p.then((c) => c.id, (e) => e.name);
      const frame = document.body.appendChild(document.createElement('iframe'));
      const created = await frame.contentWindow.navigator.credentials.create({publicKey: {
        rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array([2]),
        pubKeyCredParams: [{type: 'public-key', alg: -7}], authenticatorSelection: {residentKey: 'discouraged'}, extensions: {credProps: true}
      }});
      frame.contentWindow.structuredClone = () => 'hijacked';
      return [
        created.getClientExtensionResults(), JSON.parse(new TextDecoder().decode(created.response.clientDataJSON)).origin === location.origin,
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array([3])}})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array([3]), allowCredentials: [{type: 'public-key', id: created.rawId}]}})) === created.id
      ];
    JS
    expect(out).to eq([{'credProps' => {'rk' => false}}, true, 'NotAllowedError', true])
  end

  # What the page's script gets, base64url-encoded, for a verifier that shares nothing with the engine: Ruby's OpenSSL
  # and the small CBOR reader below, which reads just what WebAuthn's encodings hold.
  module WebauthnVerifier
    module_function

    def decode(text) = Base64.urlsafe_decode64(text)

    # One CBOR item at `at`: its value and where it ends.
    def cbor(bytes, at = 0)
      head   = bytes.getbyte(at)
      major  = head >> 5
      info   = head & 0x1f
      width  = {24 => 1, 25 => 2, 26 => 4, 27 => 8}.fetch(info, 0)
      length = width.zero? ? info : bytes.byteslice(at + 1, width).unpack1({1 => 'C', 2 => 'n', 4 => 'N', 8 => 'Q>'}.fetch(width))
      at    += 1 + width

      case major
      when 0 then [length, at]
      when 1 then [-1 - length, at]
      when 2 then [bytes.byteslice(at, length), at + length]
      when 3 then [bytes.byteslice(at, length).force_encoding('UTF-8'), at + length]
      when 5
        pairs = {}
        length.times do
          key, at        = cbor(bytes, at)
          pairs[key], at = cbor(bytes, at)
        end
        [pairs, at]
      else raise "no CBOR major type #{major} in WebAuthn's encodings"
      end
    end

    # Authenticator data (WebAuthn §6.1), with any attested credential data.
    def authenticator_data(bytes)
      data = {rp_id_hash: bytes.byteslice(0, 32), flags: bytes.getbyte(32), count: bytes.byteslice(33, 4).unpack1('N')}
      return data if bytes.bytesize == 37

      id_length = bytes.byteslice(53, 2).unpack1('n')
      data.merge(
        aaguid:        bytes.byteslice(37, 16),
        credential_id: bytes.byteslice(55, id_length),
        cose:          cbor(bytes, 55 + id_length).first,
        rest:          cbor(bytes, 55 + id_length).last
      )
    end

    # The P-256 public key of a COSE_Key.
    def cose_public_key(cose)
      point = OpenSSL::BN.new("\x04#{cose[-2]}#{cose[-3]}".b, 2)
      group = OpenSSL::PKey::EC::Group.new('prime256v1')
      der   = OpenSSL::ASN1::Sequence([
        OpenSSL::ASN1::Sequence([OpenSSL::ASN1::ObjectId('id-ecPublicKey'), OpenSSL::ASN1::ObjectId('prime256v1')]),
        OpenSSL::ASN1::BitString(OpenSSL::PKey::EC::Point.new(group, point).to_octet_string(:uncompressed))
      ]).to_der
      OpenSSL::PKey.read(der)
    end

    def signed?(key, signature, authenticator_data, client_data)
      key.verify('SHA256', signature, authenticator_data + Digest::SHA256.digest(client_data))
    end
  end

  let(:base64url) { <<~JS }
    const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const options = (extra) => ({publicKey: {
      rp: {name: 'x'}, user: {id: new Uint8Array([1, 2]), name: 'u', displayName: 'U'}, challenge: new Uint8Array([9, 8, 7]),
      pubKeyCredParams: [{type: 'public-key', alg: -7}], ...extra
    }});
    const attested = (c) => ({
      id: c.id, clientData: b64(c.response.clientDataJSON), attestationObject: b64(c.response.attestationObject),
      authenticatorData: b64(c.response.getAuthenticatorData()), publicKey: b64(c.response.getPublicKey()), algorithm: c.response.getPublicKeyAlgorithm()
    });
    const asserted = (c) => ({
      id: c.id, clientData: b64(c.response.clientDataJSON), authenticatorData: b64(c.response.authenticatorData),
      signature: b64(c.response.signature), userHandle: c.response.userHandle && b64(c.response.userHandle)
    });
    const rejection = (p) => p.then(() => 'none', (e) => e.name);
    const named = (c) => [{type: 'public-key', id: c.rawId}];
    const flags = (buffer) => new Uint8Array(buffer)[32];
  JS

  it 'answers with a registration and assertions another verifier accepts' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator 'hasResidentKey' => true, 'hasUserVerification' => true, 'isUserVerified' => true
    out = run(session, <<~JS)
      #{base64url}
      const created = await navigator.credentials.create(options({authenticatorSelection: {residentKey: 'required'}}));
      const first = await navigator.credentials.get({publicKey: {challenge: new Uint8Array([1, 1]), allowCredentials: named(created)}});
      const second = await navigator.credentials.get({publicKey: {challenge: new Uint8Array([2, 2])}});
      return [attested(created), asserted(first), asserted(second)];
    JS
    created, first, second = out
    v = WebauthnVerifier

    attestation, ends = v.cbor(v.decode(created['attestationObject']))
    expect(ends).to eq(v.decode(created['attestationObject']).bytesize)
    expect(attestation.keys).to eq(%w[fmt attStmt authData])
    expect(attestation.values_at('fmt', 'attStmt')).to eq(['none', {}])
    expect(attestation['authData']).to eq(v.decode(created['authenticatorData']))

    data = v.authenticator_data(attestation['authData'])
    expect(data[:rp_id_hash]).to eq(Digest::SHA256.digest('rp.example.test'))
    expect(data[:flags]).to eq(0x45)
    expect(data[:count]).to eq(0)
    expect(data[:aaguid]).to eq("\0".b * 16)
    expect(Base64.urlsafe_encode64(data[:credential_id], padding: false)).to eq(created['id'])
    expect(data[:rest]).to eq(attestation['authData'].bytesize)
    expect(data[:cose].keys).to eq([1, 3, -1, -2, -3])
    expect(data[:cose].values_at(1, 3, -1)).to eq([2, -7, 1])
    expect(created['algorithm']).to eq(-7)

    key = v.cose_public_key(data[:cose])
    expect(OpenSSL::PKey.read(v.decode(created['publicKey'])).public_to_der).to eq(key.public_to_der)
    expect(JSON.parse(v.decode(created['clientData']))).to eq(
      'type'        => 'webauthn.create',
      'challenge'   => 'CQgH',
      'origin'      => 'http://rp.example.test',
      'crossOrigin' => false
    )

    [[first, 'AQE', 1], [second, 'AgI', 2]].each do |assertion, challenge, count|
      bytes = v.decode(assertion['authenticatorData'])
      seen  = v.authenticator_data(bytes)
      expect(seen).to eq(rp_id_hash: Digest::SHA256.digest('rp.example.test'), flags: 0x05, count: count)
      expect(assertion['id']).to eq(created['id'])
      expect(assertion['userHandle']).to eq('AQI')
      expect(JSON.parse(v.decode(assertion['clientData'])).values_at('type', 'challenge')).to eq(['webauthn.get', challenge])
      expect(v.signed?(key, v.decode(assertion['signature']), bytes, v.decode(assertion['clientData']))).to be(true)
      expect(v.signed?(key, v.decode(assertion['signature']), bytes, "#{v.decode(assertion['clientData'])} ")).to be(false)
    end
  end

  it 'attests with the credential key where direct attestation is asked for, and to `none` otherwise' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      #{base64url}
      const direct = await navigator.credentials.create(options({attestation: 'direct'}));
      const none = await navigator.credentials.create(options({attestation: 'none', attestationFormats: ['packed']}));
      const preferred = await navigator.credentials.create(options({attestation: 'indirect', attestationFormats: ['fido-u2f', 'none', 'packed']}));
      const unknown = await navigator.credentials.create(options({attestation: 'bogus'}));
      return [attested(direct), attested(none), attested(preferred), attested(unknown)];
    JS
    v = WebauthnVerifier
    direct, *others = out.map {|created| [created, v.cbor(v.decode(created['attestationObject'])).first] }
    created, statement = direct

    expect(statement['fmt']).to eq('packed')
    expect(statement['attStmt'].keys).to eq(%w[alg sig])
    expect(statement['attStmt']['alg']).to eq(-7)
    data = v.authenticator_data(statement['authData'])
    expect(data[:aaguid]).to eq("\0".b * 16)
    key = v.cose_public_key(data[:cose])
    expect(v.signed?(key, statement['attStmt']['sig'], statement['authData'], v.decode(created['clientData']))).to be(true)
    expect(v.signed?(key, statement['attStmt']['sig'], "#{statement['authData']}x".b, v.decode(created['clientData']))).to be(false)
    expect(others.map {|_, object| [object['fmt'], object['attStmt']] }).to all(eq(['none', {}]))
  end

  it 'signs with a credential the driver added, base64 or base64url, counting from its count' do
    key     = OpenSSL::PKey::EC.generate('prime256v1')
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    webauthn = session.driver.browser.webauthn
    handle   = webauthn.add_virtual_authenticator('transport' => 'internal')
    raw_id   = "\xfb\xff\x01\x02".b

    expect(
      webauthn.add_credential(
        handle,
        'credentialId'         => Base64.strict_encode64(raw_id),
        'rpId'                 => 'rp.example.test',
        'privateKey'           => Base64.strict_encode64(key.private_to_der),
        'isResidentCredential' => false,
        'signCount'            => 41
      )
    ).to eq(raw_id)
    expect(webauthn.get_credentials(handle)).to eq([
      {
        'credentialId'         => '-_8BAg',
        'rpId'                 => 'rp.example.test',
        'isResidentCredential' => false,
        'signCount'            => 41,
        'userHandle'           => nil
      }
    ])

    out = run(session, <<~JS)
      #{base64url}
      return asserted(await navigator.credentials.get({publicKey: {challenge: new Uint8Array([5]), allowCredentials: [{type: 'public-key', id: new Uint8Array([0xfb, 0xff, 1, 2])}]}}));
    JS
    v    = WebauthnVerifier
    data = v.decode(out['authenticatorData'])
    expect(v.authenticator_data(data)[:count]).to eq(42)
    expect(out['userHandle']).to be_nil
    expect(v.signed?(key, v.decode(out['signature']), data, v.decode(out['clientData']))).to be(true)
    expect(webauthn.get_credentials(handle).first['signCount']).to eq(42)

    expect(webauthn.add_credential('no such authenticator', {})).to be_nil
    expect { webauthn.add_credential(handle, 'credentialId' => 'AQ', 'rpId' => 'a.test', 'privateKey' => 'AQ', 'signCount' => 0) }.to raise_error(ArgumentError, /PKCS#8/)
    webauthn.remove_credential(handle, '-_8BAg')
    expect(webauthn.get_credentials(handle)).to eq([])
  end

  # The refusals, every one a NotAllowedError but an excluded credential's and an unsupported type's (§5.1.3: a client
  # hides why an authenticator refused): Chrome and Firefox alike, measured, where the Ruby this replaced said
  # ConstraintError and NotSupportedError.
  it 'refuses what its authenticators cannot do, in the words the spec allows' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      #{base64url}
      const created = await navigator.credentials.create(options({pubKeyCredParams: []}));
      return [
        await rejection(navigator.credentials.create(options({authenticatorSelection: {residentKey: 'required'}}))),
        await rejection(navigator.credentials.create(options({authenticatorSelection: {requireResidentKey: true}}))),
        await rejection(navigator.credentials.create(options({authenticatorSelection: {userVerification: 'required'}}))),
        await rejection(navigator.credentials.create(options({authenticatorSelection: {authenticatorAttachment: 'platform'}}))),
        await rejection(navigator.credentials.create(options({authenticatorSelection: {authenticatorAttachment: 'bogus', residentKey: 'bogus', userVerification: 'bogus'}}))),
        await rejection(navigator.credentials.create(options({pubKeyCredParams: [{type: 'public-key', alg: -999}]}))),
        await rejection(navigator.credentials.create(options({pubKeyCredParams: [{type: 'bogus', alg: -7}]}))),
        await rejection(navigator.credentials.create(options({excludeCredentials: named(created)}))),
        await rejection(navigator.credentials.create(options({excludeCredentials: [{type: 'bogus', id: created.rawId}]}))),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: [{type: 'bogus', id: created.rawId}]}})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), userVerification: 'required', allowCredentials: named(created)}})),
        await rejection(navigator.credentials.create(options({user: {id: new Uint8Array(0), name: 'u', displayName: 'U'}}))),
        await rejection(navigator.credentials.create(options({user: {id: new Uint8Array(65), name: 'u', displayName: 'U'}})))
      ];
    JS
    expect(out).to eq(%w[
      NotAllowedError NotAllowedError NotAllowedError NotAllowedError none NotAllowedError NotSupportedError
      InvalidStateError none NotAllowedError NotAllowedError TypeError TypeError
    ])
  end

  # An exclude list and an allow list are of one RP ID (§6.3.2, §6.3.3), and a discoverable credential replaces the
  # user's last on the RP (§6.3.2 "credentials map"; Chrome alike, measured; Firefox keeps both).
  it 'keeps credentials by RP ID and user' do
    session = simulated_session(app)
    session.visit 'http://a.rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator 'hasResidentKey' => true
    out = run(session, <<~JS)
      #{base64url}
      const parent = await navigator.credentials.create(options({rp: {name: 'x', id: 'rp.example.test'}}));
      const required = {authenticatorSelection: {residentKey: 'required'}};
      const first = await navigator.credentials.create(options(required));
      const second = await navigator.credentials.create(options(required));
      return [
        await rejection(navigator.credentials.create(options({excludeCredentials: named(parent)}))),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(parent)}})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), rpId: 'rp.example.test', allowCredentials: named(parent)}})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(first)}})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(second)}}))
      ];
    JS
    expect(out).to eq(%w[none NotAllowedError none NotAllowedError none])
  end

  # User verification: the effective requirement of each ceremony (§5.1.3, §5.1.4.2), a registration verifying where it
  # can and an assertion only where it is asked to (Chrome and Firefox alike, measured). isUserVerified defaults to false
  # (§11.3), and the backup flags are the credential's from its authenticator's defaults (§11.2), not derived from it.
  it 'verifies the user as each ceremony requires' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    webauthn = session.driver.browser.webauthn
    handle   = webauthn.add_virtual_authenticator('hasResidentKey' => true, 'hasUserVerification' => true, 'automaticPresenceSimulation' => true)
    out = run(session, <<~JS)
      #{base64url}
      return [
        await rejection(navigator.credentials.create(options())),
        await rejection(navigator.credentials.create(options({authenticatorSelection: {userVerification: 'discouraged'}})))
      ];
    JS
    expect(out).to eq(%w[NotAllowedError NotAllowedError])
    webauthn.set_user_verified(handle, true)
    out = run(session, <<~JS)
      #{base64url}
      const created = await navigator.credentials.create(options({authenticatorSelection: {userVerification: 'discouraged'}}));
      const asked = (userVerification) => navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(created), userVerification}});
      globalThis.__created = created;
      return [flags(created.response.getAuthenticatorData()), flags((await asked('discouraged')).response.authenticatorData), flags((await asked('preferred')).response.authenticatorData), flags((await asked('bogus')).response.authenticatorData)];
    JS
    expect(out).to eq([0x45, 0x01, 0x05, 0x05])
    webauthn.set_user_verified(handle, false)
    out = run(session, <<~JS)
      #{base64url}
      return [
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(globalThis.__created)}})),
        await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(globalThis.__created), userVerification: 'discouraged'}}))
      ];
    JS
    expect(out).to eq(%w[NotAllowedError none])

    webauthn.add_virtual_authenticator('defaultBackupEligibility' => true, 'defaultBackupState' => true)
    webauthn.remove_virtual_authenticator(handle)
    out = run(session, <<~JS)
      #{base64url}
      const created = await navigator.credentials.create(options());
      const got = await navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(created)}});
      return [flags(created.response.getAuthenticatorData()), flags(got.response.authenticatorData)];
    JS
    expect(out).to eq([0x59, 0x19])
  end

  # A request is under way between the call and its task (Credential Management §2.5): an abort in between rejects with
  # its reason and leaves no credential; another request of the type is a NotAllowedError; a conditional get nothing can
  # answer stays pending till its abort (Firefox alike; Chrome's virtual authenticator refuses it) and one that can be
  # answered is, its virtual user choosing at once (Chrome alike); and a silent one is null (§2.5.1 "resolve p with null").
  it 'keeps a request pending as Credential Management says' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    webauthn = session.driver.browser.webauthn
    handle   = webauthn.add_virtual_authenticator('hasResidentKey' => true)
    out = run(session, <<~JS)
      #{base64url}
      const log = [];
      const controller = new AbortController();
      const aborted = navigator.credentials.create({...options(), signal: controller.signal});
      const during = navigator.credentials.get({publicKey: {challenge: new Uint8Array(1)}});
      controller.abort(new RangeError('stop'));
      const resolvedFirst = await Promise.race([Promise.resolve('microtask'), navigator.credentials.get({mediation: 'silent', publicKey: {challenge: new Uint8Array(1), rpId: 'not.this.test'}})]);

      const waiting = new AbortController();
      let settled = 'pending';
      const conditional = navigator.credentials.get({mediation: 'conditional', signal: waiting.signal, publicKey: {challenge: new Uint8Array(1)}});
      conditional.then(() => { settled = 'resolved'; }, (e) => { settled = e.name; });
      await new Promise((r) => setTimeout(r, 50));
      const whilePending = settled;
      const blocked = await rejection(navigator.credentials.create(options()));
      waiting.abort();
      await conditional.catch(() => {});

      const made = await navigator.credentials.create(options({authenticatorSelection: {residentKey: 'required'}}));
      const chosen = await navigator.credentials.get({mediation: 'conditional', publicKey: {challenge: new Uint8Array(1), allowCredentials: [{type: 'public-key', id: made.rawId}]}});
      const server = await navigator.credentials.create(options({user: {id: new Uint8Array([3]), name: 'v', displayName: 'V'}, authenticatorSelection: {residentKey: 'discouraged'}}));
      const unfiltered = new AbortController();
      let filtered = 'pending';
      navigator.credentials.get({mediation: 'conditional', signal: unfiltered.signal, publicKey: {challenge: new Uint8Array(1), allowCredentials: named(server)}}).then(() => { filtered = 'resolved'; }, () => {});
      await new Promise((r) => setTimeout(r, 50));
      const filteredOut = filtered;
      unfiltered.abort();
      const conditionalCreate = await rejection(navigator.credentials.create({...options(), mediation: 'conditional'}));
      return [
        await aborted.then(() => 'none', (e) => e.name), await rejection(during), resolvedFirst, await navigator.credentials.get({mediation: 'silent', publicKey: {challenge: new Uint8Array(1)}}),
        whilePending, blocked, settled, chosen.id === made.id, filteredOut, conditionalCreate,
        await rejection(navigator.credentials.get({uiMode: 'immediate', publicKey: {challenge: new Uint8Array(1)}}))
      ];
    JS
    expect(out).to eq(['RangeError', 'NotAllowedError', 'microtask', nil, 'pending', 'NotAllowedError', 'AbortError', true, 'pending', 'NotAllowedError', 'TypeError'])
    expect(webauthn.get_credentials(handle).size).to eq(2)
  end

  # A frame of another origin: its client data says so, its create takes (and uses up) a user activation (§5.1.3 step 2;
  # Chrome's clientDataJSON the same, measured), and a frame removed is no document to ask (Chrome alike).
  it 'says where a request comes from', :every_host_local do
    pages = lambda {|env|
      framed = '<!doctype html><meta charset="utf-8"><body><button id="go">go</button>'
      framing = '<!doctype html><meta charset="utf-8"><body><iframe id="f" src="http://b.rp.example.test/"></iframe>'
      [200, {'content-type' => 'text/html'}, [env['SERVER_NAME'].start_with?('b.') ? framed : framing]]
    }
    session = simulated_session(pages)
    session.visit 'http://a.rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    session.within_frame('f') do
      out = run(session, <<~JS)
        #{base64url}
        const first = await rejection(navigator.credentials.create(options()));
        document.getElementById('go').addEventListener('click', () => {
          globalThis.__made = navigator.credentials.create(options());
        });
        return first;
      JS
      expect(out).to eq('NotAllowedError')
      session.click_button 'go'
      out = run(session, <<~JS)
        #{base64url}
        const made = await globalThis.__made;
        const got = await navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(made)}});
        return [new TextDecoder().decode(made.response.clientDataJSON), new TextDecoder().decode(got.response.clientDataJSON), await rejection(navigator.credentials.create(options()))];
      JS
      expect(out).to eq([
        '{"type":"webauthn.create","challenge":"CQgH","origin":"http://b.rp.example.test","crossOrigin":true,"topOrigin":"http://a.rp.example.test"}',
        '{"type":"webauthn.get","challenge":"AA","origin":"http://b.rp.example.test","crossOrigin":true,"topOrigin":"http://a.rp.example.test"}',
        'NotAllowedError'
      ])
    end
    out = run(session, <<~JS)
      #{base64url}
      const frame = document.body.appendChild(document.createElement('iframe'));
      const container = frame.contentWindow.navigator.credentials;
      frame.remove();
      return [await rejection(container.create(options())), await rejection(container.get({publicKey: {challenge: new Uint8Array(1)}})), await rejection(container.preventSilentAccess())];
    JS
    expect(out).to eq(%w[InvalidStateError InvalidStateError InvalidStateError])
  end

  # The RP ID defaults to, and is checked against, the origin's effective domain (HTML §7.5.2 "if origin's domain is
  # non-null, then return origin's domain"), which a `document.domain` write sets. Chrome and Firefox both keep the host
  # here: the spec is explicit, so this follows it.
  it 'takes its RP ID from the effective domain' do
    session = simulated_session(app)
    session.visit 'http://a.rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      #{base64url}
      document.domain = 'rp.example.test';
      const made = await navigator.credentials.create(options());
      return [b64(made.response.getAuthenticatorData()), await rejection(navigator.credentials.create(options({rp: {name: 'x', id: 'a.rp.example.test'}}))), JSON.parse(new TextDecoder().decode(made.response.clientDataJSON)).origin];
    JS
    expect(WebauthnVerifier.authenticator_data(WebauthnVerifier.decode(out[0]))[:rp_id_hash]).to eq(Digest::SHA256.digest('rp.example.test'))
    expect(out[1..]).to eq(['SecurityError', 'http://a.rp.example.test'])
  end

  # What is on offer follows the authenticators the driver added (§5.1.6): a user-verifying platform one, or none. Chrome
  # and Firefox alike, measured; a conditional get is the client's own, so available regardless (Firefox alike).
  it 'tells what authenticators are available' do
    session = simulated_session(app)
    session.visit '/'
    available = <<~JS
      const capabilities = await PublicKeyCredential.getClientCapabilities();
      return [
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), await PublicKeyCredential.isConditionalMediationAvailable(),
        capabilities.userVerifyingPlatformAuthenticator, capabilities.passkeyPlatformAuthenticator, capabilities.conditionalGet, capabilities['extension:credProps'],
        Object.keys(capabilities).join() === Object.keys(capabilities).sort().join()
      ];
    JS
    expect(run(session, available)).to eq([false, true, false, false, true, true, true])
    webauthn = session.driver.browser.webauthn
    webauthn.add_virtual_authenticator('transport' => 'usb', 'hasUserVerification' => true, 'hasResidentKey' => true)
    expect(run(session, available)).to eq([false, true, false, false, true, true, true])
    webauthn.add_virtual_authenticator('transport' => 'internal', 'hasUserVerification' => true, 'hasResidentKey' => true)
    expect(run(session, available)).to eq([true, true, true, true, true, true, true])
  end

  # The session's database (§11.2): another window of it sees the authenticator, and a reset of the session forgets it.
  it 'keeps authenticators by session' do
    session = simulated_session(app)
    session.visit '/'
    webauthn = session.driver.browser.webauthn
    handle   = webauthn.add_virtual_authenticator('transport' => 'internal', 'hasUserVerification' => true)
    expect(handle).to eq('csim-auth-1')
    popup = session.window_opened_by { session.execute_script("window.open('/', '_blank')") }
    session.within_window(popup) do
      expect(run(session, 'return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();')).to be(true)
    end
    session.reset!
    session.visit '/'
    expect(session.driver.browser.webauthn.get_credentials(handle)).to eq([])
    expect(run(session, 'return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();')).to be(false)
  end
end
