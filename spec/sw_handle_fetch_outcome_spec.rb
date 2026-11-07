# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What a service worker's Handle Fetch comes to: `event.handled`'s rejection (Create Fetch Event and Dispatch: a
# "NetworkError" DOMException — Chrome and Firefox, measured), `event.clientId` of a navigation — the document that began
# it, HTML's source snapshot params' fetch client (w3c/ServiceWorker#1832, merged 2026-07: "clientId reflects the
# initiating client whenever one exists") — and a raced route, which is a GET's alone.
RSpec.describe 'Handle Fetch outcomes' do
  let(:worker) {
    <<~JS
      self.addEventListener('install', e => {
        e.addRoutes({condition: {urlPattern: new URLPattern({pathname: '/raced*'})}, source: 'race-network-and-fetch-handler'});
        self.skipWaiting();
      });
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      const handled = {}, ids = {};
      const note = (e, name) => e.handled.then(() => { handled[name] = 'resolved'; }, x => { handled[name] = [x.constructor.name, x.name]; });
      self.addEventListener('fetch', e => {
        const path = new URL(e.request.url).pathname;
        if (e.request.mode === 'navigate') ids[path] = [e.clientId, e.resultingClientId];
        if (path === '/cancel') { e.preventDefault(); note(e, 'cancel'); }
        if (path === '/reject') { e.respondWith(Promise.reject(new Error('no'))); note(e, 'reject'); }
        if (path === '/nothing') { e.respondWith(Promise.resolve(1)); note(e, 'nothing'); }
        if (path === '/error') { e.respondWith(Response.error()); note(e, 'error'); }
        if (path === '/good') { e.respondWith(new Response('good')); note(e, 'good'); }
        if (path === '/fall') note(e, 'fall');
        if (path === '/raced') e.respondWith(new Response('handler'));
      });
      self.addEventListener('message', e => e.ports[0].postMessage({me: e.source.id, handled, ids}));
    JS
  }
  let(:requests) { [] }
  let(:app) {
    sw  = worker
    log = requests
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        log << "#{req.request_method} #{req.path_info}"
        case req.path_info
        when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
        else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
        end
      }
    }.to_app
  }

  def controlled_session
    session = simulated_session(app)
    session.visit '/'
    session.execute_script("navigator.serviceWorker.addEventListener('controllerchange', () => { globalThis.__controlled = true; }); navigator.serviceWorker.register('/sw.js');")
    expect(poll_until { session.evaluate_script('globalThis.__controlled === true') }).to be(true)
    session
  end

  # The worker's report, asked by the page.
  def ask(session)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const channel = new MessageChannel();
      channel.port1.onmessage = e => done(e.data);
      navigator.serviceWorker.controller.postMessage(null, [channel.port2]);
    JS
  end

  it 'rejects `handled` with a NetworkError DOMException for a network error, and resolves it otherwise' do
    session = controlled_session
    outcome = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      Promise.all(['/cancel', '/reject', '/nothing', '/error', '/good', '/fall'].map(p => fetch(p).then(r => r.status, x => x.name))).then(done);
    JS
    expect(outcome).to eq(%w[TypeError TypeError TypeError TypeError].push(200, 200))
    handled = poll_until { (h = ask(session)['handled']).size == 6 && h }
    network_error = %w[DOMException NetworkError]
    expect(handled).to eq(
      'cancel'  => network_error,
      'reject'  => network_error,
      'nothing' => network_error,
      'error'   => network_error,
      'good'    => 'resolved',
      'fall'    => 'resolved'
    )
  end

  it "gives a navigation the document that began it as its client: a frame's own, its parent's, none of an address bar's" do
    session = controlled_session
    frame = lambda {|code|
      session.evaluate_async_script(<<~JS)
        const done = arguments[0];
        const f = document.querySelector('iframe') || document.body.appendChild(document.createElement('iframe'));
        f.addEventListener('load', () => done(true), {once: true});
        #{code}
      JS
    }
    frame.call("f.src = '/framed';")
    frame.call("f.contentWindow.location.href = '/itself';")
    frame.call("f.src = '/parent';")
    report = ask(session)
    me = report['me']
    expect(report['ids'].fetch('/framed')[0]).to eq(me)
    expect(report['ids'].fetch('/parent')[0]).to eq(me)
    expect(report['ids'].fetch('/parent')[1]).not_to eq(me)
    itself = report['ids'].fetch('/itself')
    expect(itself[0]).to eq(report['ids'].fetch('/framed')[1])
    expect(itself[1]).not_to eq(itself[0])

    session.visit '/typed'
    expect(ask(session)['ids'].fetch('/typed')[0]).to eq('')
  end

  it 'gives a page-begun top-level navigation that page as its client' do
    session = controlled_session
    me = ask(session)['me']
    session.execute_script("location.href = '/next';")
    expect(poll_until { session.evaluate_script('location.pathname') == '/next' }).to be(true)
    report = ask(session)
    expect(report['ids'].fetch('/next')).to eq([me, report['me']])
  end

  it 'races a GET alone: a HEAD goes to the fetch event, no network leg sent for it' do
    session = controlled_session
    requests.clear
    answered = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      fetch('/raced', {method: 'HEAD'}).then(r => done(r.status));
    JS
    expect(answered).to eq(200)
    expect(requests).not_to include('HEAD /raced')
    session.evaluate_async_script("const done = arguments[0]; fetch('/raced').then(r => done(r.status));")
    expect(requests).to include('GET /raced')
  end

  context 'with a navigation its worker answers late, or never' do
    let(:worker) {
      <<~JS
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', e => {
          const path = new URL(e.request.url).pathname;
          if (path === '/late') e.respondWith(new Promise(r => setTimeout(() => r(new Response('<!doctype html><body>late answer', {headers: {'content-type': 'text/html'}})), 5000)));
          if (path === '/never') e.respondWith(new Promise(() => {}));
          if (path === '/polled') { setInterval(() => {}, 100); }
          if (path === '/own') {
            e.respondWith(self.clients.get(e.resultingClientId).then(c => new Response(`<!doctype html><body>own ${c && c.url}`, {headers: {'content-type': 'text/html'}})));
          }
        });
      JS
    }

    it 'waits for the answer, its timer run on the time the visit waits' do
      session = controlled_session
      began = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      session.visit '/late'
      expect(session.text).to eq('late answer')
      expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - began).to be < 4
      expect(requests).not_to include('GET /late')
    end

    # (…SW waits as long as that takes; Chrome after 310 s and Firefox after 60 s load the network's page, measured)
    it 'loads from the network where the answer can never come, the wait no longer than it takes to know that' do
      session = controlled_session
      began = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      session.visit '/never'
      expect(session.status_code).to eq(200)
      expect(session.text).to eq('page')
      expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - began).to be < 0.9
    end

    it "answers a handler's wait on its own reserved client past an interval another event left running" do
      session = controlled_session
      session.visit '/polled'
      session.visit '/own'
      expect(session.text).to eq('own about:blank')
    end
  end
end
