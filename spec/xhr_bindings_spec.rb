# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# XMLHttpRequest, its upload and their event target, generated from their IDL: the progress handlers on
# XMLHttpRequestEventTarget, no constructor of its own, a body converted as its union says, no implementation on the
# prototype, a send aborted or opened again stale, and a response decoded natively whatever a page does to
# TextDecoder. The figures are headless Chrome's — but for a raw SharedArrayBuffer body, which Web IDL's union
# conversion stringifies (its ArrayBuffer step takes only a buffer IsSharedArrayBuffer is false of) where Chrome and
# Firefox throw.
RSpec.describe 'XMLHttpRequest bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/latin1'
        [200, {'content-type' => 'text/plain;charset=windows-1252'}, ["\x80 caf\xE9".b]]
      elsif env['REQUEST_METHOD'] == 'POST'
        [200, {'content-type' => 'text/plain'}, [env['rack.input'].read]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']]
      end
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const sab = new WebAssembly.Memory({shared: true, initial: 1, maximum: 1}).buffer;
        const opened = () => { const x = new XMLHttpRequest(); x.open('POST', '/x'); return x; };
        return [
          !!Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'onload'),
          !!Object.getOwnPropertyDescriptor(XMLHttpRequestEventTarget.prototype, 'onload'),
          !!Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'onreadystatechange'),
          error(() => opened().send(sab)),
          error(() => opened().send(new Uint8Array(sab))),
          error(() => new XMLHttpRequestEventTarget()),
          Object.prototype.toString.call(new XMLHttpRequest().upload),
          Object.getOwnPropertyNames(XMLHttpRequest.prototype).filter((k) => k.startsWith('_')).length
        ];
      })()
    JS
    expect(got).to eq([
      false, true, true,
      'none',
      "TypeError: Failed to execute 'send' on 'XMLHttpRequest': The provided ArrayBufferView value must not be shared.",
      "TypeError: Failed to construct 'XMLHttpRequestEventTarget': Illegal constructor",
      '[object XMLHttpRequestUpload]',
      0
    ])
  end

  it 'decodes a response natively, whatever a page does to TextDecoder' do
    session.execute_script(<<~JS)
      window.TextDecoder = function () { throw new Error('page'); };
      const x = new XMLHttpRequest();
      x.open('GET', '/latin1');
      x.onload = () => { window.got = x.responseText; };
      x.send();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq('€ café')
  end

  it 'answers only the send of its latest open()' do
    session.execute_script(<<~JS)
      const x = new XMLHttpRequest(), events = [];
      x.onreadystatechange = () => events.push('rsc' + x.readyState);
      x.onload = () => { events.push('load:' + x.responseText); window.got = events; };
      x.open('POST', '/echo');
      x.send('first');
      x.abort();
      x.open('POST', '/echo');
      x.send('second');
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got.join(" ")')).to eq('rsc1 rsc4 rsc1 rsc2 rsc3 rsc4 load:second')
  end
end
