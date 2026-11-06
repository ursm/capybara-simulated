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

  # A script's result, the virtual clock taken past the lifetime timer of each request it waits on (§15.1's five minutes).
  def run(session, script)
    session.execute_script(<<~JS)
      globalThis.__out = '(pending)';
      (async () => { #{script} })().then((v) => { globalThis.__out = v; }, (e) => { globalThis.__out = 'threw ' + e.name; });
    JS
    20.times do
      out = session.evaluate_script('globalThis.__out')
      return out unless out == '(pending)'

      session.driver.browser.advance_virtual_clock_ms(300_000)
    end
    '(pending)'
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
  # hides why an authenticator refused), as Chrome's are, measured. (Firefox lets a request requiring user verification
  # through an authenticator that has none, where §5.1.3 skips it.)
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
      const controller = new AbortController();
      const aborted = navigator.credentials.create({...options(), signal: controller.signal});
      const during = navigator.credentials.get({publicKey: {challenge: new Uint8Array(1)}});
      controller.abort(new RangeError('stop'));
      const sameTick = [
        navigator.credentials.create(options({rp: {name: 'x', id: 'not.this.test'}})),
        navigator.credentials.get({publicKey: {challenge: new Uint8Array(1)}})
      ];
      const refusedInOrder = [await rejection(sameTick[0]), await rejection(sameTick[1])];
      const silent = await navigator.credentials.get({mediation: 'silent', publicKey: {challenge: new Uint8Array(1), rpId: 'not.this.test'}});

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
        await aborted.then(() => 'none', (e) => e.name), await rejection(during), refusedInOrder, silent,
        whilePending, blocked, settled, chosen.id === made.id, filteredOut, conditionalCreate,
        await rejection(navigator.credentials.get({uiMode: 'immediate', publicKey: {challenge: new Uint8Array(1)}}))
      ];
    JS
    expect(out).to eq(['RangeError', 'NotAllowedError', %w[SecurityError NotAllowedError], nil, 'pending', 'NotAllowedError', 'AbortError', true, 'pending', 'NotAllowedError', 'TypeError'])
    expect(webauthn.get_credentials(handle).size).to eq(2)
  end

  # A frame of another origin: its `allow` attribute delegates the features or it may use neither (§5.9; Chrome and Firefox
  # alike, measured), its client data says where it is, its create takes (and uses up) a user activation (§5.1.3 step 2;
  # Chrome's clientDataJSON the same, measured), and a frame removed is no document to ask (Chrome alike).
  it 'says where a request comes from', :every_host_local do
    pages = lambda {|env|
      framed = '<!doctype html><meta charset="utf-8"><body><button id="go">go</button>'
      framing = <<~HTML
        <!doctype html><meta charset="utf-8"><body>
        <iframe id="f" src="http://b.rp.example.test/" allow="publickey-credentials-create; publickey-credentials-get"></iframe>
        <iframe id="plain" src="http://b.rp.example.test/"></iframe>
        <iframe id="narrowed" src="/leaf" allow="publickey-credentials-get 'none'"></iframe>
      HTML
      [200, {'content-type' => 'text/html'}, [env['SERVER_NAME'].start_with?('b.') || env['PATH_INFO'] == '/leaf' ? framed : framing]]
    }
    session = simulated_session(pages)
    session.visit 'http://a.rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    session.within_frame('plain') do
      out = run(session, <<~JS)
        #{base64url}
        return [await rejection(navigator.credentials.create(options())), await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1)}}))];
      JS
      expect(out).to eq(%w[NotAllowedError NotAllowedError])
    end
    session.within_frame('narrowed') do
      out = run(session, <<~JS)
        #{base64url}
        const made = await navigator.credentials.create(options());
        return [typeof made.id, await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: named(made)}}))];
      JS
      expect(out).to eq(['string', 'NotAllowedError'])
    end
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
  # non-null, then return origin's domain"), which a `document.domain` write sets. Firefox keeps the host here; Chrome's
  # setter does nothing by default (its documents are origin-keyed), and with `Origin-Agent-Cluster: ?0` it follows the
  # effective domain, as the spec says.
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
    popup = session.window_opened_by { session.execute_script("window.open('/', '_blank')") }
    session.within_window(popup) do
      expect(run(session, 'return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();')).to be(true)
    end
    session.reset!
    session.visit '/'
    webauthn = session.driver.browser.webauthn
    expect(webauthn.get_credentials(handle)).to eq([])
    expect(run(session, 'return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();')).to be(false)
    # (…a handle from before the reset names no authenticator made since)
    expect(webauthn.add_virtual_authenticator({})).not_to eq(handle)
  end

  # Permissions Policy's declared origin, the frame path itself: a same-origin frame with a bare `allow` is allowed
  # whether it has a `src`, none or a `srcdoc` (Chrome and Firefox alike, measured), and a `src` is relative to its
  # document's base URL.
  it 'declares a frame origin as Permissions Policy says', :every_host_local do
    based = lambda {|env|
      body = env['SERVER_NAME'].start_with?('b.') ? '<!doctype html><meta charset="utf-8"><p>b' : '<!doctype html><meta charset="utf-8"><base href="http://b.rp.example.test/"><body>'
      [200, {'content-type' => 'text/html'}, [body]]
    }
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      #{base64url}
      const made = async (setup) => {
        const frame = document.createElement('iframe');
        setup(frame);
        const loaded = new Promise((r) => { frame.onload = r; });
        document.body.append(frame);
        await loaded;
        const answer = await rejection(frame.contentWindow.navigator.credentials.create(options()));
        frame.remove();
        return answer;
      };
      const both = 'publickey-credentials-create; publickey-credentials-get';
      return [
        await made((f) => {}),
        await made((f) => { f.allow = both; }),
        await made((f) => { f.allow = both; f.srcdoc = '<p>x'; }),
        await made((f) => { f.allow = both; f.src = '/x'; }),
        await made((f) => { f.allow = "publickey-credentials-create 'src'"; f.srcdoc = '<p>x'; }),
        await made((f) => { f.allow = "publickey-credentials-create 'self'"; }),
        await made((f) => { f.allow = "publickey-credentials-create 'none'"; })
      ];
    JS
    expect(out).to eq(%w[none none none none none none NotAllowedError])

    session = simulated_session(based)
    session.visit 'http://a.rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    session.execute_script(<<~JS)
      const frame = document.createElement('iframe');
      frame.id = 'f';
      frame.allow = 'publickey-credentials-get';
      frame.src = 'x';
      document.body.append(frame);
    JS
    session.within_frame('f') do
      out = run(session, 'return [location.hostname, await navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), allowCredentials: [{type: "public-key", id: new Uint8Array(1)}]}}).then(() => "none", (e) => e.message)];')
      expect(out.first).to eq('b.rp.example.test')
      expect(out.last).not_to include('not enabled')
    end
  end

  # A `data:` frame's declared origin is opaque, matching no origin, its own either, for all both serialize to "null": a
  # bare `allow` delegates nothing to it (Firefox alike, measured; Chrome's document never answered), and `*` gets as far as
  # §5.1.4.1's opaque origin.
  it 'declares no origin for a data: frame' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      const inner = `<!doctype html><meta charset="utf-8"><script>
        navigator.credentials.get({publicKey: {challenge: new Uint8Array(1)}}).then(() => 'none', (e) => e.name + ': ' + e.message).then((m) => parent.postMessage(m, '*'));
      <\\/script>`;
      const asked = (allow) => new Promise((resolve) => {
        const frame = document.createElement('iframe');
        addEventListener('message', (e) => { if (e.source === frame.contentWindow) resolve(e.data); });
        frame.allow = allow;
        frame.src = 'data:text/html,' + encodeURIComponent(inner);
        document.body.append(frame);
      });
      return [await asked('publickey-credentials-get'), await asked('publickey-credentials-get *')];
    JS
    expect(out).to eq([
      "NotAllowedError: The 'publickey-credentials-get' feature is not enabled in this document.",
      'NotAllowedError: The origin is opaque.'
    ])
  end

  # An RP ID is a valid domain string (§4; URL's strict domain parser), and HTML "is a registrable domain suffix of or is
  # equal to" compares what it parses to: capitals pass, and stay as given (Chrome and Firefox both say SecurityError,
  # measured: the rule is explicit), where a percent sign and a tab are no such string (both browsers alike), nor an
  # underscore, in the page's own host either (both browsers take it, measured: UseSTD3ASCIIRules is explicit).
  it 'checks the host an RP ID parses to' do
    session = simulated_session(app)
    session.visit 'http://a.rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      #{base64url}
      const made = await navigator.credentials.create(options({rp: {name: 'x', id: 'RP.Example.TEST'}}));
      const refused = (id) => rejection(navigator.credentials.create(options({rp: {name: 'x', id}})));
      return [b64(made.response.getAuthenticatorData()), await refused('a b'), await refused('rp%2eexample.test'), await refused('%72p.example.test'), await refused('rp.example.test\t')];
    JS
    expect(WebauthnVerifier.authenticator_data(WebauthnVerifier.decode(out[0]))[:rp_id_hash]).to eq(Digest::SHA256.digest('RP.Example.TEST'))
    expect(out[1..]).to eq(%w[SecurityError SecurityError SecurityError SecurityError])

    session.visit 'http://foo_bar.example.test/'
    out = run(session, <<~JS)
      #{base64url}
      return [location.hostname, await rejection(navigator.credentials.create(options())), await rejection(navigator.credentials.get({publicKey: {challenge: new Uint8Array(1)}}))];
    JS
    expect(out).to eq(%w[foo_bar.example.test SecurityError SecurityError])
  end

  # Active credential types are the settings object's: a document renewed in its realm (a frame's or a window's initial
  # about:blank, read before its navigation lands) has none, and the old one's request is nothing to the new one.
  it 'forgets a request with its document' do
    pages = ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']] }
    session = simulated_session(pages)
    session.visit 'http://rp.example.test/'
    session.driver.browser.webauthn.add_virtual_authenticator({})
    out = run(session, <<~JS)
      #{base64url}
      const conditional = (w) => { w.navigator.credentials.get({mediation: 'conditional', publicKey: {challenge: new Uint8Array(1)}}); };
      const frame = document.createElement('iframe');
      frame.src = '/next';
      document.body.append(frame);
      conditional(frame.contentWindow);
      await new Promise((r) => { frame.onload = r; });
      const framed = await rejection(frame.contentWindow.navigator.credentials.create(options()));

      const opened = window.open('');
      conditional(opened);
      opened.location = '/next';
      await new Promise((r) => { const poll = () => { opened.location.pathname === '/next' && opened.document.readyState === 'complete' ? r() : setTimeout(poll, 10); }; poll(); });
      return [framed, await rejection(opened.navigator.credentials.create(options()))];
    JS
    expect(out).to eq(%w[none none])

    run(session, "navigator.credentials.get({mediation: 'conditional', publicKey: {challenge: new Uint8Array(1)}}); return 1;")
    session.visit 'http://rp.example.test/again'
    out = run(session, <<~JS)
      #{base64url}
      return rejection(navigator.credentials.create(options()));
    JS
    expect(out).to eq('none')
  end

  # What a click's ceremony shows under `find`, with the clock only where a page's own timer would have it. An authenticator
  # that could be asked and refuses is a NotAllowedError at once (§5.1.3 "cancel the process"), and no authenticator to ask
  # waits for its timer (§5.1.3 "If an authenticator becomes available"). Measured, ms to the rejection, Chrome / Firefox:
  [
    ['resident key required on one without', {},                         "create(pk({authenticatorSelection: {residentKey: 'required'}}))",           'NotAllowedError'], # 5 / 11
    ['requireResidentKey on one without',    {},                         'create(pk({authenticatorSelection: {requireResidentKey: true}}))',          'NotAllowedError'], # 0 / 0
    ['no discoverable credential',           {},                         'get(gk())',                                                                 'NotAllowedError'], # 1 / 4
    ['user verification on one without',     {},                         "create(pk({authenticatorSelection: {userVerification: 'required'}}))",      'NotAllowedError'], # 1 / F created it
    ['user not verified',                    {'hasUserVerification' => true}, 'create(pk())',                                                         'NotAllowedError'], # 0 / 0
    ['unknown algorithm',                    {},                         "create(pk({pubKeyCredParams: [{type: 'public-key', alg: -999}]}))",         'NotAllowedError'], # 0 / 0
    ['allow list missed',                    {},                         "get(gk({allowCredentials: [{type: 'public-key', id: new Uint8Array(4)}]}))", 'NotAllowedError'], # 0 / 0
    ['wrong attachment, timeout 1000',       {},                         "create(pk({timeout: 1000, authenticatorSelection: {authenticatorAttachment: 'platform'}}))", 'NotAllowedError'], # 1501 at the timer / 1
    ['no authenticator, timeout 1000',       nil,                        'create(pk({timeout: 1000}))',                                               'NotAllowedError'], # 1006 / 5
    ['no authenticator, get, timeout 1000',  nil,                        'get(gk({timeout: 1000}))',                                                  'NotAllowedError'], # 1000 / 4
    ['no authenticator, allow list',         nil,                        "get(gk({timeout: 1000, allowCredentials: [{type: 'public-key', id: new Uint8Array(4)}]}))", 'NotAllowedError'], # 1000 / 0
    ['no authenticator, default timeout',    nil,                        'create(pk())',                                                              nil]                # past a find's horizon
  ].each do |name, authenticator, ceremony, expected|
    it "shows #{name} under a find" do
      page = <<~HTML
        <!doctype html><meta charset="utf-8"><body><button id="go">go</button><script>
          const pk = (extra) => ({publicKey: {rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array(1), pubKeyCredParams: [{type: 'public-key', alg: -7}], ...extra}});
          const gk = (extra) => ({publicKey: {challenge: new Uint8Array(1), ...extra}});
          document.getElementById('go').onclick = () => navigator.credentials.#{ceremony}.then(() => 'created', (e) => e.name).then((text) => {
            document.body.append(Object.assign(document.createElement('p'), {id: 'res', textContent: text}));
          });
        </script>
      HTML
      session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
      session.visit 'http://rp.example.test/'
      session.driver.browser.webauthn.add_virtual_authenticator(authenticator) if authenticator
      session.click_button 'go'
      if expected
        expect(session.find('#res', wait: 2).text).to eq(expected)
      else
        expect(session).to have_no_css('#res', wait: 0.5)
      end
    end
  end

  # An authenticator becoming available answers what is pending (§5.1.3, §5.1.4.1: "If an authenticator becomes
  # available"), a conditional get holding the type till then (Credential Management §2.5.1; Chrome and Firefox let the
  # next request through, each its own way: the rule is explicit). Chrome answers a modal create so too, measured.
  it 'asks the authenticators again as they become available' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    webauthn = session.driver.browser.webauthn
    session.execute_script(<<~JS)
      globalThis.__conditional = 'pending';
      navigator.credentials.get({mediation: 'conditional', publicKey: {challenge: new Uint8Array(1)}}).then((c) => { globalThis.__conditional = c.id; }, (e) => { globalThis.__conditional = e.name; });
    JS
    out = run(session, <<~JS)
      #{base64url}
      return [globalThis.__conditional, await rejection(navigator.credentials.create(options()))];
    JS
    expect(out).to eq(%w[pending NotAllowedError])

    handle = webauthn.add_virtual_authenticator('hasResidentKey' => true)
    expect(run(session, 'return globalThis.__conditional;')).to eq('pending')
    key = OpenSSL::PKey::EC.generate('prime256v1')
    webauthn.add_credential(
      handle,
      'credentialId'         => 'AQID',
      'rpId'                 => 'rp.example.test',
      'privateKey'           => Base64.strict_encode64(key.private_to_der),
      'isResidentCredential' => true,
      'userHandle'           => 'AQ',
      'signCount'            => 0
    )
    expect(run(session, 'return globalThis.__conditional;')).to eq('AQID')

    webauthn.remove_virtual_authenticator(handle)
    session.execute_script(<<~JS)
      globalThis.__made = 'pending';
      navigator.credentials.create({publicKey: {
        rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array(1),
        pubKeyCredParams: [{type: 'public-key', alg: -7}]
      }}).then((c) => { globalThis.__made = typeof c.id; }, (e) => { globalThis.__made = e.name; });
    JS
    expect(session.evaluate_script('globalThis.__made')).to eq('pending')
    webauthn.add_virtual_authenticator({})
    session.evaluate_script('1')
    expect(session.evaluate_script('globalThis.__made')).to eq('string')
  end

  # With no authenticator to ask, a request lives till its lifetime timer (§5.1.3, §5.1.4.1): the page's `timeout`, up to
  # §15.1's longest; or till an abort.
  it 'runs a lifetime timer' do
    session = simulated_session(app)
    session.visit 'http://rp.example.test/'
    start = lambda {|name, call|
      session.execute_script(<<~JS)
        globalThis.#{name} = 'pending';
        #{call}.then(() => { globalThis.#{name} = 'none'; }, (e) => { globalThis.#{name} = e.name; });
      JS
    }
    read = ->(name) { session.evaluate_script("globalThis.#{name}") }
    creation = "{rp: {name: 'x'}, user: {id: new Uint8Array([1]), name: 'u', displayName: 'U'}, challenge: new Uint8Array(1), pubKeyCredParams: [{type: 'public-key', alg: -7}]"
    clock = session.driver.browser

    start.call('a', "navigator.credentials.create({publicKey: #{creation}, timeout: 60000}})")
    clock.advance_virtual_clock_ms(50_000)
    expect(read.call('a')).to eq('pending')
    clock.advance_virtual_clock_ms(11_000)
    expect(read.call('a')).to eq('NotAllowedError')

    start.call('b', "navigator.credentials.get({publicKey: {challenge: new Uint8Array(1), timeout: 9000000}})")
    clock.advance_virtual_clock_ms(599_000)
    expect(read.call('b')).to eq('pending')
    clock.advance_virtual_clock_ms(2_000)
    expect(read.call('b')).to eq('NotAllowedError')

    start.call('d', "(globalThis.__ac = new AbortController(), navigator.credentials.create({publicKey: #{creation}}, signal: globalThis.__ac.signal}))")
    expect(read.call('d')).to eq('pending')
    session.execute_script('globalThis.__ac.abort()')
    expect(read.call('d')).to eq('AbortError')
    expect(run(session, 'return await navigator.credentials.create({publicKey: {rp: {name: "x"}, user: {id: new Uint8Array([1]), name: "u", displayName: "U"}, challenge: new Uint8Array(1), pubKeyCredParams: [{type: "public-key", alg: -7}]}}).then(() => "none", (e) => e.name);')).to eq('NotAllowedError')
  end
end
