# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The WebIDL edges of TextDecoder / TextEncoder / URL / FormData, and a cross-origin WindowProxy's [[Set]] / [[Delete]]:
# what Chrome throws or keeps, held here because no vendored WPT file asserts it.
RSpec.describe 'Encoding API surface' do
  # frames[0] is cross-origin (sandboxed without allow-same-origin), frames[1] same-origin.
  let(:session) do
    page = '<!DOCTYPE html><iframe sandbox="allow-scripts" src="/child"></iframe><iframe src="/child"></iframe>'
    s = simulated_session(lambda {|env|
      [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/' ? page : '<p>child</p>']]
    })
    s.visit '/'
    s
  end

  def throws(js) = "(() => { try { #{js}; return 'ok'; } catch (e) { return e.name; } })()"

  it 'takes only a non-resizable BufferSource, any realm' do
    got = session.evaluate_script(<<~JS)
      [
        #{throws("new TextDecoder().decode('AB')")},
        #{throws('new TextDecoder().decode([65, 66])')},
        #{throws('new TextDecoder().decode(new ArrayBuffer(2, {maxByteLength: 4}))')},
        #{throws('new TextEncoder().encodeInto("a", new Uint8Array(new ArrayBuffer(2, {maxByteLength: 4})))')},
        new TextDecoder().decode(),
        new TextEncoder().encodeInto('a', new (frames[1].Uint8Array)(2)).written
      ]
    JS
    expect(got).to eq(['TypeError', 'TypeError', 'TypeError', 'TypeError', '', 1])
  end

  it 'keeps its state out of reach' do
    got = session.evaluate_script(<<~JS)
      [
        Object.keys(new TextDecoder()).length,
        Object.getOwnPropertyNames(new URL('http://h/?a=1')).length,
        Object.getOwnPropertyNames(TextDecoder.prototype).sort().join(),
        new TextDecoder('Shift_JIS', {fatal: true}).encoding
      ]
    JS
    expect(got).to eq([0, 0, 'constructor,decode,encoding,fatal,ignoreBOM', 'shift_jis'])
  end

  it 'sets a FormData entry in place' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const fd = new FormData();
        fd.append('a', '1'); fd.append('b', '2'); fd.append('a', '3');
        fd.set('a', '4');
        return [...fd].map((e) => e.join('=')).join('&');
      })()
    JS
    expect(got).to eq('a=4&b=2')
  end

  it 'refuses to write or delete on a cross-origin window, save its location' do
    got = session.evaluate_script(<<~JS)
      [#{throws('frames[0].foo = 1')}, #{throws('delete frames[0].foo')}, #{throws('frames[0].location = "/child"')}]
    JS
    expect(got).to eq(%w[SecurityError SecurityError ok])
  end
end
