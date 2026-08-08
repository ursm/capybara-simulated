# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/js_engine'
require 'rack'
require 'json'
require_relative 'support/session_teardown'

# `clients.matchAll()` enumerates the service worker's CONTROLLED clients — every in-scope
# browsing context, not merely the ones that happened to postMessage the worker — with each
# window client's live focus state. (WPT: service-workers/service-worker/client-id +
# clients-matchall + sandboxed-iframe-fetch-event; this pins the mechanism directly.)
RSpec.describe 'Service Worker client enumeration' do
  let(:worker) {
    <<~JS
      self.onmessage = e => {
        e.waitUntil(self.clients.matchAll().then(cs => {
          e.source.postMessage(cs.map(c => ({
            url: c.url, id: c.id, type: c.type, frameType: c.frameType,
            focused: c.focused, visibilityState: c.visibilityState
          })));
        }));
      };
    JS
  }
  let(:app) {
    sw = worker
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        case req.path_info
        when '/'      then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/scope/page.html'
          # `?sandbox=…` mirrors the WPT handler: the frame is sandboxed by a CSP RESPONSE
          # header rather than by the container's attribute.
          headers = {'content-type' => 'text/html'}
          headers['content-security-policy'] = "sandbox #{req.params['sandbox']}" if req.params['sandbox']
          [200, headers, ['<html><body>in-scope</body></html>']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { skip 'Service Worker clients need per-frame realms (V8 engine)' unless CsimEngine.v8? }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  # Register the SW at /scope/, wait for activation, then build one frame per entry in
  # `frames` — a Hash of frame id => src. Returns the loaded session.
  def session_with_frames(frames)
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__ready = false;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        for (const [id, src] of Object.entries(#{JSON.generate(frames)})) {
          await new Promise(res => {
            const f = document.createElement('iframe');
            f.id = id; f.src = src;
            f.addEventListener('load', res, {once: true});
            document.body.appendChild(f);
          });
        }
        globalThis.__ready = true;
      });
    JS
    40.times { break if session.evaluate_script('globalThis.__ready === true'); sleep 0.02 }
    session
  end

  # Ask the worker (through the frame it controls) for its client list.
  def match_all(session, via:)
    session.execute_script(<<~JS)
      globalThis.__clients = null;
      const win = document.getElementById(#{via.inspect}).contentWindow;
      win.navigator.serviceWorker.addEventListener('message', e => { globalThis.__clients = e.data; }, {once: true});
      win.navigator.serviceWorker.controller.postMessage('list');
    JS
    20.times { break if session.evaluate_script('globalThis.__clients !== null'); sleep 0.02 }
    session.evaluate_script('globalThis.__clients')
  end

  it 'enumerates every controlled frame, not only the one that messaged the worker' do
    session = session_with_frames('a' => '/scope/page.html#a', 'b' => '/scope/page.html#b')
    urls = match_all(session, via: 'b').map {|c| c['url'] }

    expect(urls.grep(/#a\z/).size).to eq(1)
    expect(urls.grep(/#b\z/).size).to eq(1)
  end

  it 'gives each client a distinct, stable id' do
    session = session_with_frames('a' => '/scope/page.html#a', 'b' => '/scope/page.html#b')
    first  = match_all(session, via: 'b').map {|c| c['id'] }
    second = match_all(session, via: 'b').map {|c| c['id'] }

    expect(first.uniq.size).to eq(2)
    expect(second).to eq(first)
  end

  it 'reports each nested frame as a visible window client' do
    session = session_with_frames('a' => '/scope/page.html#a')
    client  = match_all(session, via: 'a').first

    expect(client['type']).to eq('window')
    expect(client['frameType']).to eq('nested')
    expect(client['visibilityState']).to eq('visible')
  end

  it 'follows the focus chain into the focused frame, and sorts it first' do
    session = session_with_frames('a' => '/scope/page.html#a', 'b' => '/scope/page.html#b')
    session.execute_script("document.getElementById('a').focus();")
    clients = match_all(session, via: 'b')

    expect(clients.map {|c| c['focused'] }).to eq([true, false])
    expect(clients.first['url']).to end_with('#a')
  end

  it 'moves focus with window.focus() on a frame, which focuses its browsing context' do
    session = session_with_frames('a' => '/scope/page.html#a', 'b' => '/scope/page.html#b')
    session.execute_script("document.getElementById('a').focus(); document.getElementById('b').contentWindow.focus();")
    focused = match_all(session, via: 'b').select {|c| c['focused'] }.map {|c| c['url'] }

    expect(focused.size).to eq(1)
    expect(focused.first).to end_with('#b')
  end

  # A frame sandboxed WITHOUT allow-same-origin has an opaque origin, so it is not controlled
  # — even though the service worker answered its navigation request, which is the only point
  # at which a CSP-header sandbox could have been known.
  it 'excludes an opaque-origin frame sandboxed by a CSP response header' do
    session = session_with_frames('a' => '/scope/page.html#a', 'boxed' => '/scope/page.html?sandbox=allow-scripts#boxed')
    urls    = match_all(session, via: 'a').map {|c| c['url'] }

    expect(urls.grep(/#a\z/).size).to eq(1)
    expect(urls.grep(/#boxed\z/)).to be_empty
  end

  it 'includes a frame the CSP header sandboxes WITH allow-same-origin' do
    session = session_with_frames('a' => '/scope/page.html#a', 'boxed' => '/scope/page.html?sandbox=allow-scripts+allow-same-origin#boxed')
    urls    = match_all(session, via: 'a').map {|c| c['url'] }

    expect(urls.grep(/#boxed\z/).size).to eq(1)
  end
end
