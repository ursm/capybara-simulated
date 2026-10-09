# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Worker and SharedWorker, generated from their IDL: their state in slots (no `url` of their own, which no browser
# has), their arguments converted; a SharedWorker's port a real MessagePort, entangled with the inside port its worker's
# `connect` carries (and is the source of); a worker's global scope at its script's URL after redirects, which its
# location and its requests' referrer read — only through same-origin redirects: a script fetch is in mode
# 'same-origin', so a cross-origin redirect is a network error, the worker's `error` (Chrome alike). A URL that does not
# parse is a SyntaxError, and the interface objects are not enumerable.
RSpec.describe 'Worker bindings' do
  let(:app) {
    lambda do |env|
      case env['PATH_INFO']
      when '/shared.js'
        body = 'let ref = null; const x = new XMLHttpRequest(); x.onload = () => { ref = x.responseText; }; x.open("GET", "/ref"); x.send();' \
               'onconnect = (e) => { const p = e.ports[0]; const go = () => ref === null ? setTimeout(go, 10) : ' \
               'p.postMessage([location.href, ref, e.source === p, p instanceof MessagePort]); go(); };'
        [200, {'content-type' => 'text/javascript'}, [body]]
      when '/redirect' then [302, {'location' => '/shared.js'}, []]
      when '/away' then [302, {'location' => 'http://other.example/echo.js'}, []]
      when '/echo.js' then [200, {'content-type' => 'text/javascript'}, ['onmessage = (e) => postMessage(e.data);']]
      when '/ref' then [200, {'content-type' => 'text/plain'}, [env['HTTP_REFERER'].to_s]]
      when '/nest.js'
        [200, {'content-type' => 'text/javascript'}, ['const w = new Worker("echo.js"); w.onmessage = (e) => postMessage(["nested", e.data]); ' \
                                                      'w.onerror = () => postMessage("nested-error"); onmessage = (e) => w.postMessage(e.data);']]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>frame']]
      when '/framed' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><iframe src="http://other.example/frame"></iframe>']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
      end
    end
  }

  it 'is what their IDL says' do
    session = simulated_session(app)
    session.visit '/page'
    session.execute_script(<<~JS)
      globalThis.__out = null;
      (async () => {
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const worker = new Worker('/echo.js');
        const echoed = await new Promise((res) => { worker.onmessage = (e) => res(e.data); worker.postMessage({hi: 1}, {transfer: []}); });
        const shared = new SharedWorker('/redirect');
        const reply = await new Promise((res) => { shared.port.onmessage = (e) => res(e.data); });
        const away = await new Promise((res) => { const w = new Worker('/away'); w.onerror = () => res('error'); w.onmessage = () => res('ran'); w.postMessage(1); });
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
        globalThis.__out = [
          err(() => new Worker()), err(() => new Worker('/echo.js', {type: 'bogus'})), Object.keys(worker), echoed,
          err(() => Worker.prototype.terminate.call({})), shared.port instanceof MessagePort, shared.port === shared.port,
          Object.keys(shared), reply, away, descriptor.enumerable, err(() => new Worker('http://[bad')), err(() => new SharedWorker('http://[bad'))
        ];
      })().catch((e) => { globalThis.__out = String(e); });
    JS
    poll_until { session.evaluate_script('globalThis.__out !== null') }
    expect(session.evaluate_script('globalThis.__out')).to eq([
      'TypeError', 'TypeError', [], {'hi' => 1}, 'TypeError', true, true, [],
      ['http://www.example.com/shared.js', 'http://www.example.com/shared.js', true, true], 'error', false, 'SyntaxError', 'SyntaxError'
    ])
  end

  # A nested worker's script is judged against its parent worker's URL: in a frame of another origin, its worker's
  # same-origin child runs.
  it "judges a nested worker's script against its parent" do
    session = simulated_session(app)
    session.visit '/framed'
    session.within_frame(0) do
      session.execute_script(<<~JS)
        globalThis.__out = null;
        const w = new Worker('/nest.js');
        w.onmessage = (e) => { globalThis.__out = e.data; };
        w.onerror = () => { globalThis.__out = 'error'; };
        w.postMessage('hi');
      JS
      poll_until { session.evaluate_script('globalThis.__out !== null') }
      expect(session.evaluate_script('globalThis.__out')).to eq(['nested', 'hi'])
    end
  end
end
