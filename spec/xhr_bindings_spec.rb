# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# XMLHttpRequest, its upload and their event target, generated from their IDL: the progress handlers on
# XMLHttpRequestEventTarget, no constructor of its own, a SharedArrayBuffer body refused by the union's conversion, no
# implementation on the prototype, and a response decoded natively whatever a page does to TextDecoder. The figures are
# headless Chrome's.
RSpec.describe 'XMLHttpRequest bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/latin1'
        [200, {'content-type' => 'text/plain;charset=windows-1252'}, ["\x80 caf\xE9".b]]
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
      "TypeError: Failed to execute 'send' on 'XMLHttpRequest': Failed to convert value to 'ArrayBuffer'.",
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
end
