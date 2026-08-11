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
      // WindowClient.navigate(): find the client whose url ends with `on` and send it to `navigate`.
      // Reports what the promise did — the spec resolves with the client (same-origin), with null
      // (cross-origin), or rejects with TypeError.
      self.addEventListener('message', e => {
        const nav = e.data && e.data.navigate;
        if (!nav) return;
        e.waitUntil(self.clients.matchAll({includeUncontrolled: true}).then(async cs => {
          const target = cs.find(c => c.url.endsWith(e.data.on));
          // `found` is reported so a rejection test can't pass vacuously: without it, a target that
          // simply isn't in matchAll() throws its own TypeError off `undefined.navigate` and looks
          // exactly like the rejection under test.
          let report = {found: !!target};
          try {
            const got = await target.navigate(nav);
            Object.assign(report, {resolved: true, isNull: got === null, url: got && got.url,
                                   id: got && got.id, isWindowClient: got instanceof WindowClient});
          } catch (err) {
            Object.assign(report, {resolved: false, name: err && err.constructor && err.constructor.name});
          }
          e.source.postMessage({navigateReport: report});
        }));
      });
      self.onmessage = e => {
        if (e.data && e.data.navigate) return;
        const cmd  = e.data && e.data.focus;
        const to   = e.data && e.data.postTo;
        const opts = (e.data && e.data.options) || undefined;
        e.waitUntil(self.clients.matchAll(opts).then(async cs => {
          if (cmd) { const t = cs.find(c => c.url.endsWith(cmd)); if (t) await t.focus(); }
          // Relay to another client — used to prove a `client.postMessage` aimed at a WORKER
          // client reaches that worker's own navigator.serviceWorker.
          if (to) {
            const all = await self.clients.matchAll({type: 'all', includeUncontrolled: true});
            const t   = all.find(c => c.url.endsWith(to));
            if (t) t.postMessage({relayed: to});
          }
          const after = (cmd || to) ? await self.clients.matchAll(opts) : cs;
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
        # Outside every scope used here — an UNCONTROLLED client.
        when '/outside.html' then [200, {'content-type' => 'text/html'}, ['<html><body>out</body></html>']]
        # A dedicated worker, in scope at /scope/ and out of it at the root. It relays anything
        # its OWN navigator.serviceWorker receives back to the page — a `client.postMessage` aimed
        # at a worker client belongs there, NOT on the worker's creator-facing `self.onmessage`.
        when '/scope/worker.js', '/outside-worker.js'
          body = 'navigator.serviceWorker.addEventListener("message", e => self.postMessage({fromSW: e.data}));' \
                 'self.onmessage = e => self.postMessage({own: e.data});'
          [200, {'content-type' => 'text/javascript'}, [body]]
        # An in-scope page that creates a worker from a BLOB URL — a script URL no registration
        # scope can ever match, so the worker's controller can only be inherited.
        when '/scope/blob-worker-page.html'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <script>
              globalThis.__ready = false;
              const url = URL.createObjectURL(new Blob(['self.onmessage = () => self.postMessage("ready");'],
                                                       {type: 'text/javascript'}));
              globalThis.__w = new Worker(url);
              globalThis.__w.onmessage = () => { globalThis.__ready = true; };
              globalThis.__w.postMessage('ping');
            </script>
          HTML
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
  def worker_report(session, via:, focus: nil, options: nil, post_to: nil)
    session.execute_script(<<~JS)
      globalThis.__report = null;
      const win = #{via == :top ? 'window' : "document.getElementById(#{via.inspect}).contentWindow"};
      win.navigator.serviceWorker.addEventListener('message', e => { globalThis.__report = e.data; }, {once: true});
      win.navigator.serviceWorker.controller.postMessage(#{JSON.generate({'focus' => focus, 'options' => options, 'postTo' => post_to}.compact)});
    JS
    20.times do
      break if session.evaluate_script('globalThis.__report !== null')

      sleep 0.02
    end
    session.evaluate_script('globalThis.__report') or raise 'the service worker never answered'
  end

  def match_all(session, via:, focus: nil, options: nil) = worker_report(session, via: via, focus: focus, options: options)['clients']

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

  # `WindowClient.focused` follows `document.hasFocus()`, which is true for the whole chain up
  # from the focused frame — a page CONTAINING the focused iframe is itself focused. So more
  # than one client reports focused at once, and matchAll puts all of them first.
  it 'reports the focused frame AND its ancestors as focused' do
    session = session_with_frames({'a' => '/scope/page.html#a'}, scope: '/')
    session.execute_script("document.getElementById('a').focus();")
    clients = match_all(session, via: 'a')
    by_url  = clients.to_h {|c| [c['url'], c['focused']] }

    expect(by_url.count {|_u, f| f }).to eq(2)
    expect(by_url.find {|u, _f| u.end_with?('#a') }&.last).to be(true)
    expect(by_url.find {|u, _f| u.end_with?('/') }&.last).to be(true)
  end

  # A context OUT of the worker's scope is still a client of the ORIGIN: matchAll() must hide it
  # by default and `includeUncontrolled: true` must reveal it. So the mirror carries every
  # same-origin context with a per-worker `controlled` flag, not only the controlled ones.
  it 'hides uncontrolled clients by default and reveals them on includeUncontrolled' do
    session    = session_with_frames({'out' => '/outside.html#out', 'a' => '/scope/page.html#a'})
    controlled = match_all(session, via: 'a').map {|c| c['url'] }
    every      = match_all(session, via: 'a', options: {'includeUncontrolled' => true}).map {|c| c['url'] }

    expect(controlled.grep(/#a\z/).size).to eq(1)
    expect(controlled.grep(/#out\z/)).to be_empty
    expect(every.grep(/#a\z/).size).to eq(1)
    expect(every.grep(/#out\z/).size).to eq(1)
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

  # A dedicated worker is a client of its ORIGIN, exactly like a browsing context: in scope it is
  # controlled and shows up by default, out of scope it is hidden until `includeUncontrolled`.
  # Registering only the CONTROLLED ones would leave the uncontrolled worker invisible to the very
  # option the `controlled` flag exists to serve.
  it 'lists a worker client, and hides an out-of-scope one until includeUncontrolled' do
    session = session_with_frames({'a' => '/scope/page.html#a'})
    session.execute_script("globalThis.__w1 = new Worker('/scope/worker.js'); globalThis.__w2 = new Worker('/outside-worker.js');")
    workers = ->(opts) { match_all(session, via: 'a', options: opts).select {|c| c['type'] == 'worker' }.map {|c| c['url'] } }

    expect(workers.call({'type' => 'all'})).to include(a_string_ending_with('/scope/worker.js'))
    expect(workers.call({'type' => 'all'})).not_to include(a_string_ending_with('/outside-worker.js'))
    every = workers.call({'type' => 'all', 'includeUncontrolled' => true})
    expect(every).to include(a_string_ending_with('/scope/worker.js'))
    expect(every).to include(a_string_ending_with('/outside-worker.js'))
  end

  # A blob: worker's script URL is a UUID no registration scope could ever cover, so scope-matching
  # it leaves it uncontrolled forever. Such a worker takes its service worker from the context that
  # CREATED it, exactly as an about:blank frame does. (A worker with a REAL url still scope-matches
  # — clients-matchall-client-types builds one from an uncontrolled page and expects it controlled.)
  #
  # The creator's controller must be read LIVE, when `new Worker(…)` runs. Here the page is claimed
  # at load, so a host-side snapshot taken when the realm was BUILT would still be empty and the
  # worker would come out uncontrolled.
  it 'gives a blob-URL worker the controller of the context that created it' do
    session = session_with_frames({'a' => '/scope/blob-worker-page.html'})
    40.times do
      break if session.evaluate_script("document.getElementById('a').contentWindow.__ready === true")

      sleep 0.02
    end
    # A barrier, not a nap: the client record is registered synchronously by worker_spawn, so
    # without this both specs below would pass even if the worker never ran at all.
    expect(session.evaluate_script("document.getElementById('a').contentWindow.__ready")).to be(true)
    urls = match_all(session, via: 'a', options: {'type' => 'worker'}).map {|c| c['url'] }

    expect(urls.size).to eq(1)
    expect(urls.first).to start_with('blob:')
  end

  # `WindowClient.navigate()` — how a service worker sends a client somewhere ("open the article
  # the notification was about"). Unlike focus(), the worker is waiting on the OUTCOME, so this is
  # a real worker→host→worker round trip: the host navigates and reports where the client LANDED.
  # A frame navigation rebuilds its realm, so reading the landing URL from the realm id we started
  # from gives '' — which the same-origin check then reads as cross-origin and resolves null.
  def navigate_report(session, via:, on:, to:)
    session.execute_script(<<~JS)
      globalThis.__nav = null;
      const win = document.getElementById(#{via.inspect}).contentWindow;
      win.navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.navigateReport) globalThis.__nav = e.data.navigateReport;
      }, {once: true});
      win.navigator.serviceWorker.controller.postMessage(#{JSON.generate({'navigate' => to, 'on' => on})});
    JS
    40.times do
      break if session.evaluate_script('globalThis.__nav !== null')

      sleep 0.02
    end
    session.evaluate_script('globalThis.__nav') or raise 'the worker never reported'
  end

  it 'navigates a controlled client and resolves with it' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    report  = navigate_report(session, via: 'b', on: '#a', to: '/scope/page.html?navigated')

    expect(report['found']).to be(true)
    expect(report['resolved']).to be(true)
    expect(report['isNull']).to be(false)
    expect(report['isWindowClient']).to be(true)
    expect(report['url']).to end_with('/scope/page.html?navigated')
    # The client really moved — not just the record the worker was handed.
    expect(session.evaluate_script("document.getElementById('a').contentWindow.location.search")).to eq('?navigated')
  end

  # The navigation REBUILDS the frame's realm, and client ids are realm-derived — so the client the
  # promise resolves with must be the context as it is NOW. Resolving with the pre-navigation id
  # hands the worker a client whose postMessage goes nowhere and whose focus() would aim the focus
  # chain at a discarded realm.
  it 'resolves with a client the worker can still reach afterwards' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    report  = navigate_report(session, via: 'b', on: '#a', to: '/scope/page.html?navigated')
    live    = match_all(session, via: 'b').map {|c| c['id'] }

    expect(report['id']).to be_a(String)
    expect(live).to include(report['id'])
  end

  # A client may not be navigated back to its initial about:blank document.
  it 'rejects a navigate to about:blank with a TypeError' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'b' => '/scope/page.html#b'})
    report  = navigate_report(session, via: 'b', on: '#a', to: 'about:blank')

    expect(report['found']).to be(true)
    expect(report['resolved']).to be(false)
    expect(report['name']).to eq('TypeError')
  end

  # navigate() is only for clients this worker CONTROLS — an out-of-scope one is a TypeError, even
  # though `includeUncontrolled` let the worker get hold of it.
  it 'rejects a navigate on a client it does not control' do
    session = session_with_frames({'out' => '/outside.html#out', 'b' => '/scope/page.html#b'})
    report  = navigate_report(session, via: 'b', on: '#out', to: '/outside.html?navigated')

    expect(report['found']).to be(true)
    expect(report['resolved']).to be(false)
    expect(report['name']).to eq('TypeError')
  end

  # Discarding a context must REAP its workers, not merely ask them to stop: the reply-pending
  # counters a worker still holds are released there, and the reset that zeroes them fires only
  # once the LAST worker is gone. Skip it and `worker_pending?` stays true for the rest of the
  # session — `polling?` never goes idle again, so every later negative Capybara assertion burns
  # the full wait. That cost is invisible to a pass/fail spec, so assert the predicate directly.
  it 'stops reporting pending work once a discarded frame’s workers are gone' do
    session = session_with_frames({'a' => '/scope/blob-worker-page.html'})
    40.times do
      break if session.evaluate_script("document.getElementById('a').contentWindow.__ready === true")

      sleep 0.02
    end
    expect(session.evaluate_script("document.getElementById('a').contentWindow.__ready")).to be(true)
    # A LISTEN-ONLY worker: it receives and never posts back, so nothing ever releases the
    # in-flight count this message takes out. That is the shape that pins the counter.
    session.execute_script(<<~JS)
      const win = document.getElementById('a').contentWindow;
      win.__mute = new win.Worker(URL.createObjectURL(new Blob(['self.onmessage = () => {};'], {type: 'text/javascript'})));
      win.__mute.postMessage('never answered');
    JS
    5.times { session.evaluate_script('1') }
    browser = session.driver.browser
    expect(browser.instance_variable_get(:@worker_in_flight)).to be > 0   # the leak is armed

    session.execute_script("document.getElementById('a').remove();")
    # Barrier on the effect itself, not a fixed number of ticks: a reply already on the outbox
    # makes `worker_pending?` legitimately true for a tick or two, and how many ticks that takes
    # is load-dependent (this failed on CI as a flat `5.times` drain). A LEAKED counter never
    # clears, so the loop simply runs out and the assertions below still catch it.
    50.times do
      break unless browser.worker_pending?

      session.evaluate_script('1')
      sleep 0.02
    end

    # Only the service worker may be left — the frame's workers are gone from @workers.
    expect(browser.instance_variable_get(:@workers).values.map {|w| w[:service] }).to all(be(true))
    expect(browser.instance_variable_get(:@worker_in_flight)).to eq(0)
    expect(browser.worker_pending?).to be(false)
  end

  # A dedicated worker is owned by the browsing context that created it: discarding the context
  # terminates the worker. Leaving it running leaks a thread AND leaves a client in matchAll that
  # nothing can ever reach.
  it 'terminates a frame’s workers when the frame is discarded' do
    session = session_with_frames({'a' => '/scope/blob-worker-page.html', 'b' => '/scope/page.html#b'})
    40.times do
      break if session.evaluate_script("document.getElementById('a').contentWindow.__ready === true")

      sleep 0.02
    end
    # A barrier, not a nap: the client record is registered synchronously by worker_spawn, so
    # without this both specs below would pass even if the worker never ran at all.
    expect(session.evaluate_script("document.getElementById('a').contentWindow.__ready")).to be(true)
    expect(match_all(session, via: 'b', options: {'type' => 'worker'}).size).to eq(1)

    session.execute_script("document.getElementById('a').remove();")

    expect(match_all(session, via: 'b', options: {'type' => 'worker'})).to be_empty
  end

  # `worker.terminate()` destroys the client, and matchAll must stop listing it — the same leak
  # a disposed frame realm is unregistered to avoid.
  it 'drops a worker client when the worker is terminated' do
    session = session_with_frames({'a' => '/scope/page.html#a'})
    session.execute_script("globalThis.__w = new Worker('/scope/worker.js');")
    listed = ->{ match_all(session, via: 'a', options: {'type' => 'all'}).map {|c| c['url'] } }
    expect(listed.call).to include(a_string_ending_with('/scope/worker.js'))

    session.execute_script('globalThis.__w.terminate();')

    expect(listed.call).not_to include(a_string_ending_with('/scope/worker.js'))
  end

  # `client.postMessage` to a WORKER client targets that worker's own `navigator.serviceWorker`
  # 'message' event — a worker has the container just as a document does. Landing it on the
  # worker's creator-facing `self.onmessage` instead would deliver a spurious message (and, since
  # that path expects a serialized string, a null one).
  it 'delivers a message to a worker client through its navigator.serviceWorker' do
    session = session_with_frames({'a' => '/scope/page.html#a'})
    session.execute_script(<<~JS)
      globalThis.__fromWorker = null;
      globalThis.__w = new Worker('/scope/worker.js');
      globalThis.__w.onmessage = e => { globalThis.__fromWorker = e.data; };
    JS
    worker_report(session, via: 'a', post_to: '/scope/worker.js')
    20.times do
      break if session.evaluate_script('globalThis.__fromWorker !== null')

      sleep 0.02
    end
    got = session.evaluate_script('globalThis.__fromWorker') or raise 'the worker never relayed'

    expect(got).to eq({'fromSW' => {'relayed' => '/scope/worker.js'}})
  end

  # A SECOND service worker registered later starts with an empty mirror, and every context that
  # already existed is one of its clients too. Gating the re-report on "the registry is empty"
  # rather than "this worker is new" left it blind to everything built before it.
  it 'gives a later-registered worker the clients that already existed' do
    session = session_with_frames({'a' => '/scope/page.html#a'}, scope: '/scope/')
    session.execute_script(<<~JS)
      globalThis.__ready2 = false;
      navigator.serviceWorker.register('/sw2.js', {scope: '/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        globalThis.__ready2 = true;
      });
    JS
    # `clients.claim()` rides the worker outbox, so activation resolving does not mean the top
    # page has a controller yet — wait for the handover itself, not for something near it.
    40.times do
      break if session.evaluate_script('globalThis.__ready2 === true && !!navigator.serviceWorker.controller')

      sleep 0.02
    end
    # Ask the SECOND worker (it controls the top page, which is outside '/scope/').
    urls = match_all(session, via: :top, options: {'includeUncontrolled' => true}).map {|c| c['url'] }

    expect(urls).to include(a_string_ending_with('#a'))
    expect(urls).to include(a_string_ending_with('/'))
  end

  # An auxiliary window is a top-level browsing context: focus inside it does NOT make its opener
  # focused (`document.hasFocus()` is false there). The focus chain walks PARENT frames, and a
  # window realm records parent 0 for "no parent frame" — which must not be read as "nested in
  # the main window".
  it 'does not focus the opener when an auxiliary window takes focus' do
    session = session_with_frames({'a' => '/scope/page.html#a'}, scope: '/')
    session.execute_script("document.getElementById('top').focus();")
    expect(match_all(session, via: 'a').find {|c| c['id'] == 'client-window' }['focused']).to be(true)

    session.execute_script(<<~JS)
      globalThis.__popup = window.open();
      globalThis.__popup.document.body.innerHTML = '<input id="p">';
      globalThis.__popup.document.getElementById('p').focus();
    JS
    clients = match_all(session, via: 'a', options: {'includeUncontrolled' => true})

    expect(clients.find {|c| c['id'] == 'client-window' }['focused']).to be(false)
    expect(clients.select {|c| c['focused'] }.map {|c| c['frameType'] }).to eq(['auxiliary'])
  end

  it 'includes a frame the CSP header sandboxes WITH allow-same-origin' do
    session = session_with_frames({'a' => '/scope/page.html#a', 'boxed' => '/scope/page.html?sandbox=allow-scripts+allow-same-origin#boxed'})
    urls    = match_all(session, via: 'a').map {|c| c['url'] }

    expect(urls.grep(/#boxed\z/).size).to eq(1)
  end
end
