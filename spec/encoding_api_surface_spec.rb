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

  # A realm that is not cross-origin isolated has no SharedArrayBuffer constructor — Chrome 154's and Firefox 157's
  # have none (measured) — a window's, a frame's, a worker's. A snapshot stub's alias (ArrayBuffer itself) sat over the
  # engine's own one, so a page found a "SharedArrayBuffer" either way.
  it 'exposes no SharedArrayBuffer in a realm that is not cross-origin isolated' do
    session.execute_script(<<~JS)
      window.got = null;
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage(typeof SharedArrayBuffer)'], {type: 'text/javascript'})));
      w.onmessage = (e) => { window.got = [crossOriginIsolated, typeof SharedArrayBuffer, typeof frames[1].SharedArrayBuffer, e.data]; };
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq([false, 'undefined', 'undefined', 'undefined'])
  end

  # …and one whose top-level document is served COOP same-origin + COEP require-corp is: `crossOriginIsolated`, and its
  # SharedArrayBuffer — its frames' and its dedicated workers' too.
  it 'is cross-origin isolated, SharedArrayBuffer and all, where its document is served COOP and COEP' do
    headers = {'content-type' => 'text/html', 'cross-origin-opener-policy' => 'same-origin', 'cross-origin-embedder-policy' => 'require-corp'}
    isolated = simulated_session(->(env) { [200, headers, [env['PATH_INFO'] == '/' ? '<iframe src="/child"></iframe>' : '<p>child</p>']] })
    isolated.visit '/'
    isolated.execute_script(<<~JS)
      window.got = null;
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage([crossOriginIsolated, typeof SharedArrayBuffer])'], {type: 'text/javascript'})));
      w.onmessage = (e) => { window.got = [crossOriginIsolated, typeof SharedArrayBuffer, typeof frames[0].SharedArrayBuffer, ...e.data]; };
    JS
    poll_until { isolated.evaluate_script('window.got') }
    expect(isolated.evaluate_script('window.got')).to eq([true, 'function', 'function', true, 'function'])
  end

  # An about:blank pop-up its opener keeps is in its browsing context group, cross-origin isolated as it is (its
  # creator's policy container; Chrome 154 too, measured) — and the session's next page, after a reset, is not.
  it "isolates an about:blank pop-up as its opener, and forgets it at the session's reset" do
    headers = {'content-type' => 'text/html', 'cross-origin-opener-policy' => 'same-origin', 'cross-origin-embedder-policy' => 'require-corp'}
    isolated = simulated_session(->(_env) { [200, headers, ['<p>isolated</p>']] })
    isolated.visit '/'
    popup = isolated.window_opened_by { isolated.execute_script("window.open('about:blank', 'p')") }
    got = isolated.within_window(popup) { isolated.evaluate_script('[crossOriginIsolated, typeof SharedArrayBuffer]') }
    expect(got).to eq([true, 'function'])
    isolated.reset!
    expect(isolated.evaluate_script('[crossOriginIsolated, typeof SharedArrayBuffer]')).to eq([false, 'undefined'])
  end
end
