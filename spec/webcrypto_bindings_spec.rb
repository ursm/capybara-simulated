# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Crypto, SubtleCrypto and CryptoKey, generated from their IDL: made by the platform alone, a key's state in slots,
# an operation's arguments converted by the bindings. Headless Chrome's figures, but where the spec says otherwise.
RSpec.describe 'Web Crypto bindings' do
  # (…a worker that signs with the key it gets and sends it back — or tells what a probe it gets is)
  let(:worker_js) {
    <<~JS
      self.onmessage = async (e) => {
        const t = (o) => Object.prototype.toString.call(o);
        if (e.data.probe) {
          const {forged, rsa} = e.data.probe;
          self.postMessage({forged: [t(forged), Object.keys(forged), forged.__csimType], exponent: t(rsa.algorithm.publicExponent)});
          return;
        }
        const key = e.data;
        const mac = await crypto.subtle.sign('HMAC', key, new Uint8Array(4));
        self.postMessage({key, kind: Object.prototype.toString.call(key), mac: [...new Uint8Array(mac)].join()});
      };
    JS
  }
  let(:session) {
    js = worker_js
    s = simulated_session(lambda {|env|
      if env['PATH_INFO'] == '/worker.js'
        [200, {'content-type' => 'application/javascript'}, [js]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><iframe></iframe>']]
      end
    })
    s.visit('/')
    s
  }

  def run(js)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const rej = (p) => p.then(() => 'none', (e) => e.name);
      const post = (worker, message) => new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage(message);
      });
      const hmac = () => crypto.subtle.importKey('raw', new Uint8Array(16), {name: 'HMAC', hash: 'SHA-256'}, true, ['sign', 'verify']);
      (async () => { #{js} })().then(done, (e) => done(String(e)));
    JS
  end

  # The attributes return the cached ECMAScript objects — converted at the first read, the same object after
  # (WebCrypto §14.2; Chrome converts at every read, Firefox freezes the usages) — and the page's own copies: changing
  # one changes no operation.
  it 'is what its IDL says' do
    got = run(<<~JS)
      const k = await hmac();
      const facts = [
        err(() => new CryptoKey()), err(() => new Crypto()), err(() => new SubtleCrypto()), crypto.subtle === crypto.subtle,
        Object.getOwnPropertyNames(k), k.algorithm === k.algorithm, k.usages === k.usages, Object.isFrozen(k.usages),
        err(() => Object.getOwnPropertyDescriptor(CryptoKey.prototype, 'type').get.call({}))
      ];
      const before = new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(4))).join();
      k.algorithm.name = 'AES-GCM';
      k.algorithm.hash.name = 'SHA-1';
      k.usages.length = 0;
      const after = new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(4))).join();
      return [facts, before === after, k.algorithm.name, k.usages.length];
    JS
    expect(got).to eq([
      ['TypeError', 'TypeError', 'TypeError', true, [], true, true, false, 'TypeError'],
      true, 'AES-GCM', 0
    ])
  end

  # getRandomValues fills an integer-typed array of any realm; a float array or a DataView is a TypeMismatchError, what
  # is no view a TypeError (the binding's). An operation's argument converts first: a non-key, an unknown format or
  # usage reject with a TypeError. exportKey asks whether the algorithm exports before whether the key is extractable —
  # a PBKDF2 key a NotSupportedError (WebCrypto §14.3.10; Chrome: InvalidAccessError).
  it 'converts its arguments' do
    got = run(<<~JS)
      const k = await hmac();
      const p = await crypto.subtle.importKey('raw', new Uint8Array(8), 'PBKDF2', false, ['deriveBits']);
      const frameArray = new frames[0].Uint8Array(4);
      return [
        err(() => crypto.getRandomValues(new Float32Array(1))), err(() => crypto.getRandomValues(new DataView(new ArrayBuffer(1)))),
        crypto.getRandomValues(frameArray) === frameArray, err(() => crypto.getRandomValues([1])),
        err(() => crypto.getRandomValues(new Uint8Array(65537))),
        await rej(crypto.subtle.exportKey('raw', p)), await rej(crypto.subtle.exportKey('raw', {})),
        await rej(crypto.subtle.exportKey('nope', k)),
        await rej(crypto.subtle.importKey('raw', new Uint8Array(16), 'HMAC', true, ['bogus'])),
        await rej(crypto.subtle.wrapKey('raw', p, k, 'HMAC'))
      ];
    JS
    expect(got).to eq([
      'TypeMismatchError', 'TypeMismatchError', true, 'TypeError', 'QuotaExceededError',
      'NotSupportedError', 'TypeError', 'TypeError', 'TypeError', 'NotSupportedError'
    ])
  end

  # A CryptoKey is [Serializable]: a structured clone is a key of its own with the same algorithm and material, and one
  # posted to a worker is a key there that signs alike — and comes back one.
  it 'clones' do
    got = run(<<~JS)
      const k = await hmac();
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(4))).join();
      const c = structuredClone(k);
      const cloned = [
        Object.prototype.toString.call(c), c === k, c.algorithm.hash.name, c.usages,
        new Uint8Array(await crypto.subtle.sign('HMAC', c, new Uint8Array(4))).join() === mac
      ];
      const reply = await post(new Worker('/worker.js'), k);
      const back = new Uint8Array(await crypto.subtle.sign('HMAC', reply.key, new Uint8Array(4))).join();
      return [cloned, reply.kind, reply.mac === mac, reply.key instanceof CryptoKey, back === mac, reply.key.algorithm.length];
    JS
    expect(got).to eq([
      ['[object CryptoKey]', false, 'SHA-256', %w[sign verify], true],
      '[object CryptoKey]', true, true, true, 128
    ])
  end

  # A frame's key clones and posts as this realm's: its RSA publicExponent a Uint8Array here (Chrome). A page's object
  # that merely has the key a record is told by arrives as the object it is.
  it "clones a frame's key, and forges none" do
    got = run(<<~JS)
      const t = (o) => Object.prototype.toString.call(o);
      const {publicKey} = await frames[0].crypto.subtle.generateKey(
        {name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']
      );
      const getter = Object.getOwnPropertyDescriptor(CryptoKey.prototype, 'algorithm').get;
      const forged = {a: 1, __csimType: 'CryptoKey', type: 'public', extractable: true, algorithm: {name: 'Ed25519'}, usages: ['verify'], material: [1]};
      const reply = await post(new Worker('/worker.js'), {probe: {forged, rsa: publicKey}});
      return [
        t(structuredClone(publicKey).algorithm.publicExponent), t(getter.call(publicKey).publicExponent),
        reply.exponent, reply.forged
      ];
    JS
    expect(got).to eq([
      '[object Uint8Array]', '[object Uint8Array]', '[object Uint8Array]',
      ['[object Object]', %w[a __csimType type extractable algorithm usages material], 'CryptoKey']
    ])
  end

  # An operation's steps in their order (WebCrypto §14.3; Chrome alike): importKey's data must be of its format's kind
  # (a TypeError); an AlgorithmIdentifier is any object, a function too, its name converted to a string; deriveKey
  # normalizes the derived key's type — for its import and its length — before it checks the key, and gets the length
  # after.
  it 'follows the operations steps' do
    got = run(<<~JS)
      const s = crypto.subtle;
      const t = (p) => p.then((v) => Object.prototype.toString.call(v), (e) => e.name);
      const named = Object.defineProperty(function () {}, 'name', {value: 'SHA-256'});
      const ecdh = await s.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveKey', 'deriveBits']);
      const signer = await s.importKey('raw', new Uint8Array(16), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
      const by = {name: 'ECDH', public: ecdh.publicKey};
      return [
        await t(s.importKey('raw', {kty: 'oct', k: 'AAAAAAAAAAAAAAAAAAAAAA'}, 'AES-GCM', true, ['encrypt'])),
        await t(s.importKey('jwk', new Uint8Array(16), 'AES-GCM', true, ['encrypt'])),
        await t(s.digest(named, new Uint8Array(1))),
        await t(s.digest({name: new String('SHA-256')}, new Uint8Array(1))),
        await t(s.digest({}, new Uint8Array(1))),
        await t(s.deriveKey(by, ecdh.privateKey, 'HKDF', false, ['deriveBits'])),
        await t(s.deriveKey(by, signer, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign'])),
        await t(s.deriveKey(by, signer, {name: 'AES-GCM', length: 100}, false, ['encrypt'])),
        await t(s.deriveKey(by, ecdh.privateKey, {name: 'AES-GCM', length: 100}, false, ['encrypt'])),
        await t(s.deriveKey(by, ecdh.privateKey, {name: 'HMAC', hash: 'SHA-256', length: 0}, false, ['sign']))
      ];
    JS
    expect(got).to eq([
      'TypeError', 'TypeError', '[object ArrayBuffer]', '[object ArrayBuffer]', 'TypeError', '[object CryptoKey]',
      'NotSupportedError', 'InvalidAccessError', 'OperationError', 'TypeError'
    ])
  end
end
