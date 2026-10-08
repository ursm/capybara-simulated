# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

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

  # A TextDecoderStream's chunk is converted as an AllowSharedBufferSource — any realm's buffer, a shared one — where an
  # `instanceof` of this realm's refused a frame's, and a shared memory's; and it is no optional argument: undefined is
  # the TypeError that errors the stream.
  it "decodes a TextDecoderStream chunk of any realm's buffer, a shared one, and refuses undefined" do
    session.execute_script(<<~JS)
      window.got = null;
      (async () => {
        const decode = async (chunk) => {
          const stream = new TextDecoderStream(), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
          try {
            writer.write(chunk);
            writer.close();
            let text = '';
            for (let r = await reader.read(); !r.done; r = await reader.read()) text += r.value;
            return text;
          } catch (e) { return e.name; }
        };
        const shared = new Uint8Array(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer, 0, 1);
        shared[0] = 67;
        window.got = [await decode(new (frames[1].Uint8Array)([65]).buffer), await decode(shared), await decode(undefined)];
      })();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq(%w[A C TypeError])
  end

  # Web Crypto takes a copy of any realm's buffer: a frame's ArrayBuffer failed this realm's `instanceof` and digested as
  # no bytes at all.
  it "digests a frame's ArrayBuffer as its bytes" do
    session.execute_script(<<~JS)
      window.got = null;
      (async () => {
        const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
        const theirs = await crypto.subtle.digest('SHA-256', new (frames[1].Uint8Array)([97]).buffer);
        const ours = await crypto.subtle.digest('SHA-256', new Uint8Array([97]).buffer);
        window.got = [hex(theirs) === hex(ours)];
      })();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq([true])
  end
end
