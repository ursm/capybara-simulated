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
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      // Every in-scope page pings on load, tagged with which frame it is. Only a CONTROLLED
      // document's fetch reaches here, so `pinged` is the record of who the SW actually
      // controls — independent of who the client registry happens to list.
      const pinged = [];
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname === '/scope/ping') {
          pinged.push(u.searchParams.get('from'));
          e.respondWith(new Response('pong', {headers: {'content-type': 'text/plain'}}));
        }
      });
      const describe = c => ({
        url: c.url, id: c.id, type: c.type, frameType: c.frameType,
        focused: c.focused, visibilityState: c.visibilityState, canFocus: 'focus' in c,
        // ServiceWorkerGlobalScope must EXPOSE these — real worker code brand-checks with them.
        isClient: c instanceof Client, isWindowClient: c instanceof WindowClient
      });
      self.onmessage = e => {
        const cmd = e.data && e.data.focus;
        e.waitUntil(self.clients.matchAll().then(async cs => {
          if (cmd) { const t = cs.find(c => c.url.endsWith(cmd)); if (t) await t.focus(); }
          const after = cmd ? await self.clients.matchAll() : cs;
          e.source.postMessage({clients: after.map(describe), pinged: pinged.slice(),
                                clientsIsClients: self.clients instanceof Clients});
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
        when '/'
          # Deliberately NO fetch here: the top page must never talk to the worker, so every
          # assertion about it as a client rests on becoming CONTROLLED and nothing else.
          [200, {'content-type' => 'text/html'}, ['<html><body>main<input id="top"></body></html>']]
        when '/sw.js', '/sw2.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/scope/ping' then [200, {'content-type' => 'text/plain'}, ['from-network']]
        when '/scope/page.html'
          # `?sandbox=…` mirrors the WPT handler: the frame is sandboxed by a CSP RESPONSE
          # header rather than by the container's attribute. Every in-scope page fetches a
          # subresource on load — a CONTROLLED document's fetch reaches the service worker,
          # which registers it as a client even when nothing mirrored it.
          headers = {'content-type' => 'text/html'}
          headers['content-security-policy'] = "sandbox #{req.params['sandbox']}" if req.params['sandbox']
          # Also answers a `report` probe with its OWN service-worker state — the only way to
          # observe a cross-origin (sandboxed) frame, whose contentWindow we may not touch. The
          # promise-shaped bits are latched at load so the reply itself stays synchronous; a
          # `ready` that never settles simply leaves its flag false, which is the assertion.
          body = '<html><body>in-scope<script>' \
                 'var __reg = false, __rdy = false;' \
                 'fetch("/scope/ping?from=" + encodeURIComponent(location.hash.slice(1)));' \
                 'try { navigator.serviceWorker.getRegistration().then(r => { __reg = !!r; }); } catch (_) {}' \
                 'try { navigator.serviceWorker.ready.then(() => { __rdy = true; }); } catch (_) {}' \
                 'window.addEventListener("message", e => {' \
                 '  e.source.postMessage({origin: self.origin, controller: !!navigator.serviceWorker.controller,' \
                 '                        registration: __reg, ready: __rdy}, "*");' \
                 '});' \
                 '</script></body></html>'
          [200, headers, [body]]
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
  def session_with_frames(frames, scope: '/scope/')
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__ready = false;
      navigator.serviceWorker.register('/sw.js', {scope: #{JSON.generate(scope)}}).then(async reg => {
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
    40.times do
      break if session.evaluate_script('globalThis.__ready === true')

      sleep 0.02
    end
    session
  end

  # Ask the worker — through a frame it controls — for its client list and its record of who
  # fetched through it. `focus:` names a client URL suffix for the worker to `WindowClient
  # .focus()` before answering.
  def worker_report(session, via:, focus: nil)
    session.execute_script(<<~JS)
      globalThis.__report = null;
      const win = #{via == :top ? 'window' : "document.getElementById(#{via.inspect}).contentWindow"};
      win.navigator.serviceWorker.addEventListener('message', e => { globalThis.__report = e.data; }, {once: true});
      win.navigator.serviceWorker.controller.postMessage(#{JSON.generate(focus.nil? ? 'list' : {'focus' => focus})});
    JS
    20.times do
      break if session.evaluate_script('globalThis.__report !== null')

      sleep 0.02
    end
    session.evaluate_script('globalThis.__report') or raise 'the service worker never answered'
  end

  def match_all(session, via:, focus: nil) = worker_report(session, via: via, focus: focus)['clients']

  it 'enumerates every controlled frame, not only the one that messaged the worker' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    urls = match_all(session, via: 'b').map {|c| c['url'] }

    expect(urls.grep(/#a\z/).size).to eq(1)
    expect(urls.grep(/#b\z/).size).to eq(1)
  end

  it 'gives each client a distinct, stable id' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    first  = match_all(session, via: 'b').map {|c| c['id'] }
    second = match_all(session, via: 'b').map {|c| c['id'] }

    expect(first.uniq.size).to eq(2)
    expect(second).to eq(first)
  end

  it 'reports each nested frame as a visible window client' do
    session = session_with_frames({'a' => '/scope/page.html#a'})
    client  = match_all(session, via: 'a').first

    expect(client['type']).to eq('window')
    expect(client['frameType']).to eq('nested')
    expect(client['visibilityState']).to eq('visible')
  end

  it 'follows the focus chain into the focused frame, and sorts it first' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    session.execute_script("document.getElementById('a').focus();")
    clients = match_all(session, via: 'b')

    expect(clients.map {|c| c['focused'] }).to eq([true, false])
    expect(clients.first['url']).to end_with('#a')
  end

  it 'moves focus with window.focus() on a frame, which focuses its browsing context' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    session.execute_script("document.getElementById('a').focus(); document.getElementById('b').contentWindow.focus();")
    focused = match_all(session, via: 'b').select {|c| c['focused'] }.map {|c| c['url'] }

    expect(focused.size).to eq(1)
    expect(focused.first).to end_with('#b')
  end

  # `ServiceWorkerGlobalScope` exposes the client interfaces, and real worker code brand-checks
  # against them — clients-get-worker.js filters its results with `client instanceof Client`,
  # which throws a bare ReferenceError inside a waitUntil (swallowed, so the test just hangs)
  # when the name is missing.
  it 'exposes Client, WindowClient and Clients on the worker global' do
    session = session_with_frames({'a' => '/scope/page.html#a'})
    report  = worker_report(session, via: 'a')

    expect(report['clientsIsClients']).to be(true)
    expect(report['clients'].map {|c| c['isClient'] }).to all(be(true))
    expect(report['clients'].map {|c| c['isWindowClient'] }).to all(be(true))
  end

  # The point of registering at the moment control is installed: a controlled page is a client
  # straight away, with no traffic of its own. `clients.matchAll()` run from a FRAME must already
  # see the top page — the PWA shape ("raise the existing window") reads matchAll cold.
  it 'lists a controlled top-level page that has never talked to the worker' do
    session = session_with_frames({'a' => '/scope/page.html#a'}, scope: '/')
    top     = match_all(session, via: 'a').find {|c| c['id'] == 'client-window' }

    expect(top).not_to be_nil
    expect(top['url']).to end_with('/')
    expect(top['frameType']).to eq('top-level')
  end

  # The TOP-LEVEL context's client id is 'client-window', not `client-<realm>` — the main realm
  # is realm 0, and both the JS side (sw-client.js, the FetchEvent client key) and the browser's
  # client-message router spell it that way. Focus reported for realm 0 has to mint the same id
  # or the top page can never be the focused client.
  it 'focuses the top-level window, whose client id is not realm-numbered' do
    session = session_with_frames({'a' => '/scope/page.html#a'}, scope: '/')
    session.execute_script("document.getElementById('top').focus();")
    clients = match_all(session, via: :top)
    top     = clients.find {|c| c['id'] == 'client-window' }

    expect(top).not_to be_nil
    expect(top['focused']).to be(true)
    expect(clients.first['id']).to eq('client-window')
  end

  # Blurring an `<iframe>` takes focus out of its nested context, so it falls back to the
  # document that contains the frame — the mirror image of focus() handing it down.
  it 'hands focus back to the container when a frame is blurred' do
    session = session_with_frames({'a' => '/scope/page.html#a'}, scope: '/')
    session.execute_script("document.getElementById('a').focus();")
    expect(match_all(session, via: :top).find {|c| c['url'].end_with?('#a') }['focused']).to be(true)

    session.execute_script("document.getElementById('a').blur();")
    clients = match_all(session, via: :top)

    expect(clients.find {|c| c['url'].end_with?('#a') }['focused']).to be(false)
    expect(clients.find {|c| c['id'] == 'client-window' }['focused']).to be(true)
  end

  # `clients.matchAll().then(cs => cs[0].focus())` — how a notificationclick handler raises the
  # existing tab. The worker asks the browser to move the focus chain and sees the result.
  it 'moves focus from the worker via WindowClient.focus()' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    session.execute_script("document.getElementById('a').focus();")
    clients = match_all(session, via: 'b', focus: '#b')

    expect(clients.map {|c| c['canFocus'] }).to all(be(true))
    expect(clients.select {|c| c['focused'] }.map {|c| c['url'] }).to eq([clients.first['url']])
    expect(clients.first['url']).to end_with('#b')

    # A second, plain matchAll: the worker applied the move to its own mirror synchronously,
    # so this only stays true if the BROWSER applied it too when it drained the request.
    expect(match_all(session, via: 'b').first['url']).to end_with('#b')
  end

  # Registration now FOLLOWS control, so a client can move between workers at runtime: a
  # longer-scoped registration activating and claim()ing it away from a shorter one. The worker
  # that lost it must be told, or its matchAll() keeps listing a context it no longer controls
  # and `client.postMessage` still routes there.
  it 'drops a client from the worker that loses it to a longer scope' do
    session = simulated_session(app)
    session.visit '/'
    # Register the '/' worker first and let it claim everything, THEN the '/scope/' one, which
    # takes the in-scope frame away from it (longest matching registration wins).
    session.execute_script(<<~JS)
      globalThis.__ready = false;
      const activated = reg => new Promise(res => {
        const w = reg.installing || reg.waiting || reg.active;
        if (w.state === 'activated') return res();
        w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
      });
      (async () => {
        await activated(await navigator.serviceWorker.register('/sw.js', {scope: '/'}));
        await new Promise(res => {
          const f = document.createElement('iframe');
          f.id = 'a'; f.src = '/scope/page.html#a';
          f.addEventListener('load', res, {once: true});
          document.body.appendChild(f);
        });
        await activated(await navigator.serviceWorker.register('/sw2.js', {scope: '/scope/'}));
        globalThis.__ready = true;
      })();
    JS
    40.times do
      break if session.evaluate_script('globalThis.__ready === true')

      sleep 0.02
    end

    # The top page is outside '/scope/', so it is still controlled by the FIRST worker — asking
    # through it asks the worker that lost the frame.
    # `claim()` rides the worker outbox, so activation resolving does NOT mean the frame has
    # changed hands yet. Wait for the handover itself — otherwise this asserts on whichever
    # order the drain happened to take.
    20.times do
      break if session.evaluate_script("((document.getElementById('a').contentWindow.navigator.serviceWorker.controller || {}).scriptURL || '').endsWith('/sw2.js')")

      sleep 0.02
    end
    urls = match_all(session, via: :top).map {|c| c['url'] }

    expect(urls).to include(a_string_ending_with('/'))
    expect(urls.grep(/#a\z/)).to be_empty
  end

  # An opaque-origin document gets no service-worker container at all in a real browser, so
  # `ready` must never resolve for it — not merely "controller stays null". The registration
  # synthesis sits AFTER the controller install on the same path, so guarding only the install
  # left it with a registration it must not have.
  it 'gives an opaque-origin frame no registration and never resolves its ready' do
    session = session_with_frames({'boxed' => '/scope/page.html?sandbox=allow-scripts#boxed'}, scope: '/')
    # The frame is cross-origin to us, so it has to report on itself.
    session.execute_script(<<~JS)
      globalThis.__boxed = null;
      window.addEventListener('message', e => { globalThis.__boxed = e.data; }, {once: true});
      document.getElementById('boxed').contentWindow.postMessage('report', '*');
    JS
    20.times do
      break if session.evaluate_script('globalThis.__boxed !== null')

      sleep 0.02
    end
    report = session.evaluate_script('globalThis.__boxed') or raise 'the sandboxed frame never reported'

    expect(report['origin']).to eq('null')
    expect(report['controller']).to be(false)
    expect(report['registration']).to be(false)
    expect(report['ready']).to be(false)
  end

  # A frame sandboxed WITHOUT allow-same-origin has an opaque origin, so it is NOT CONTROLLED
  # — even though the service worker answered its navigation request, which is the only point
  # at which a CSP-header sandbox could have been known. Keeping it merely out of the client
  # registry would not hold: a controlled frame's first subresource fetch re-registers it from
  # the fetch event. So the load-bearing assertion is that its ping never reaches the worker.
  # `boxed` is built FIRST, so by the time `a`'s ping has arrived, a controlled `boxed` would
  # already have pinged — the ordering is what makes the absence meaningful rather than a race.
  it 'does not control an opaque-origin frame sandboxed by a CSP response header' do
    session = session_with_frames({'boxed' => '/scope/page.html?sandbox=allow-scripts#boxed', 'a' => '/scope/page.html#a'})
    report  = worker_report(session, via: 'a')

    expect(report['pinged']).to include('a')
    expect(report['pinged']).not_to include('boxed')
    expect(report['clients'].map {|c| c['url'] }.grep(/sandbox=/)).to be_empty
  end

  it 'includes a frame the CSP header sandboxes WITH allow-same-origin' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'boxed' => '/scope/page.html?sandbox=allow-scripts+allow-same-origin#boxed'})
    urls    = match_all(session, via: 'a').map {|c| c['url'] }

    expect(urls.grep(/#boxed\z/).size).to eq(1)
  end
end
