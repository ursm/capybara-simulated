# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A service worker's own `self.registration` and `self.serviceWorker` are objects of the registry as a client's are: told
# each state of every version as it happens (Update Worker State's every environment of the origin; Install's
# `updatefound`), reaching other versions' isolates, and its `update()` and `unregister()` the jobs a client's are. A
# worker's `navigator.serviceWorker` schedules them too, on its own thread, the rest on the main one.
RSpec.describe "a service worker's own view" do
  let(:scripts) { {} }
  let(:fetched) { [] }
  let(:app) {
    served = scripts
    log    = fetched
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        log << req.fullpath
        script = served[req.path_info]
        next [200, {'content-type' => 'text/javascript'}, [script.respond_to?(:call) ? script.call(req) : script]] if script

        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
      }
    }.to_app
  }

  # What a worker's `say(...)` told the page, as the page got it.
  let(:say) {
    <<~JS
      const say = (x) => self.clients.matchAll({includeUncontrolled: true}).then(cs => cs.forEach(c => c.postMessage(x)));
    JS
  }

  def session_listening
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__heard = [];
      navigator.serviceWorker.onmessage = e => globalThis.__heard.push(e.data);
    JS
    session
  end

  def heard(session) = session.evaluate_script('globalThis.__heard')

  def hear(session, count)
    poll_until { (h = heard(session)).size >= count && h } || heard(session)
  end

  def register(session, url, scope = '/s/')
    session.execute_script("globalThis.__reg = navigator.serviceWorker.register(#{url.to_json}, {scope: #{scope.to_json}});")
  end

  def wait_activated(session)
    expect(poll_until { session.evaluate_async_script("const d = arguments[0]; __reg.then(r => d(!!r.active && r.active.state === 'activated'));") }).to be(true)
  end

  it 'tells an outgoing worker of the next version: its updatefound, and each state of it' do
    scripts['/s/a.js'] = lambda {|req|
      next '// the next version' if req.params['v'] == '2'

      <<~JS
        #{say}
        self.registration.addEventListener('updatefound', () => {
          const next = self.registration.installing;
          if (next === self.serviceWorker) { say(['own updatefound', next.state]); return; }
          say(['updatefound', next.scriptURL.split('?')[1], next.state]);
          next.addEventListener('statechange', () => say(['next', next.state, self.serviceWorker.state]));
        });
      JS
    }
    session = session_listening
    register(session, '/s/a.js?v=1')
    wait_activated(session)
    # (…a client it controls, which keeps it the active worker, its thread there to say so, past the next version's install)
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.src = '/s/held';
      document.body.append(f);
    JS
    expect(poll_until { session.evaluate_script("document.querySelector('iframe').contentWindow.navigator.serviceWorker.controller !== null") }).to be(true)
    # (…a second registration of another script at the scope: an update, its worker told apart by its query)
    register(session, '/s/a.js?v=2')
    log = hear(session, 3)
    expect(log[0]).to eq(['own updatefound', 'installing'])
    expect(log[1]).to eq(%w[updatefound v=2 installing])
    expect(log[2]).to eq(%w[next installed activated])
  end

  it "shows the worker's registration as the registry has it: an installed version waits while another is active" do
    scripts['/s/a.js'] = 'self.addEventListener("fetch", () => {});'
    scripts['/s/b.js'] = <<~JS
      #{say}
      const view = () => ({
        own:        self.serviceWorker.state,
        installing: self.registration.installing && self.registration.installing.state,
        waiting:    self.registration.waiting && self.registration.waiting.state,
        active:     self.registration.active && self.registration.active.scriptURL.split('/').pop(),
        same:       self.registration.installing === self.serviceWorker
      });
      const atEvaluation = view();
      self.addEventListener('install', e => {
        const installing = view();
        e.waitUntil(say({atEvaluation, installing}));
      });
      self.addEventListener('message', e => say({later: view(), waitingIsMe: self.registration.waiting === self.serviceWorker}));
    JS
    session = session_listening
    register(session, '/s/a.js')
    wait_activated(session)
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.src = '/s/held';
      document.body.append(f);
    JS
    expect(poll_until { session.evaluate_script("document.querySelector('iframe').contentWindow.navigator.serviceWorker.controller !== null") }).to be(true)
    register(session, '/s/b.js')
    first = hear(session, 1)[0]
    expect(first['atEvaluation']).to eq('own' => 'parsed', 'installing' => nil, 'waiting' => nil, 'active' => 'a.js', 'same' => false)
    expect(first['installing']).to eq('own' => 'installing', 'installing' => 'installing', 'waiting' => nil, 'active' => 'a.js', 'same' => true)
    expect(poll_until { session.evaluate_async_script("const d = arguments[0]; __reg.then(r => d(!!r.waiting && r.waiting.state === 'installed'));") }).to be(true)
    session.execute_script('__reg.then(r => r.waiting.postMessage("look"));')
    later = hear(session, 2)[1]
    expect(later['later']).to eq('own' => 'installed', 'installing' => nil, 'waiting' => 'installed', 'active' => 'a.js', 'same' => false)
    expect(later['waitingIsMe']).to be(true)
  end

  it "runs Update for a worker's own update(): the script fetched, a new version found, the promise its registration" do
    version = 0
    scripts['/s/u.js'] = lambda {|_req|
      version += 1
      <<~JS
        #{say}
        const version = #{version};
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('message', e => {
          e.waitUntil(self.registration.update().then(r => say(['updated', version, r === self.registration, !!r.installing])));
        });
      JS
    }
    session = session_listening
    register(session, '/s/u.js')
    wait_activated(session)
    fetched.clear
    session.execute_script('__reg.then(r => r.active.postMessage("go"));')
    expect(hear(session, 1)[0]).to eq(['updated', 1, true, true])
    expect(fetched).to include('/s/u.js')
  end

  it "rejects an installing worker's own update(), and one with no worker yet to update" do
    scripts['/s/i.js'] = <<~JS
      #{say}
      const atEvaluation = self.registration.update().then(() => 'resolved', x => x.name);
      self.addEventListener('install', e => {
        e.waitUntil(Promise.all([atEvaluation, self.registration.update().then(() => 'resolved', x => x.name)]).then(say));
      });
    JS
    session = session_listening
    register(session, '/s/i.js')
    expect(hear(session, 1)[0]).to eq(%w[InvalidStateError InvalidStateError])
  end

  it 'gives a message between service workers its sender as `source`, a ServiceWorker, its own too' do
    scripts['/s/a.js'] = <<~JS
      #{say}
      self.addEventListener('message', e => {
        if (e.data === 'self') { self.serviceWorker.postMessage('from self'); return; }
        say([e.data, e.source && e.source.constructor.name, e.source === self.serviceWorker, e.source === self.registration.waiting, e.origin === location.origin]);
      });
    JS
    scripts['/s/b.js'] = <<~JS
      self.addEventListener('install', e => { e.waitUntil(Promise.resolve()); });
      self.addEventListener('message', () => self.registration.active.postMessage('from the next version'));
    JS
    session = session_listening
    register(session, '/s/a.js')
    wait_activated(session)
    session.execute_script('__reg.then(r => r.active.postMessage("self"));')
    expect(hear(session, 1)[0]).to eq(['from self', 'ServiceWorker', true, false, true])
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.src = '/s/held';
      document.body.append(f);
    JS
    expect(poll_until { session.evaluate_script("document.querySelector('iframe').contentWindow.navigator.serviceWorker.controller !== null") }).to be(true)
    register(session, '/s/b.js')
    expect(poll_until { session.evaluate_async_script("const d = arguments[0]; __reg.then(r => d(!!r.waiting && r.waiting.state === 'installed'));") }).to be(true)
    session.execute_script('__reg.then(r => r.waiting.postMessage("go"));')
    expect(hear(session, 2)[1]).to eq(['from the next version', 'ServiceWorker', false, true, true])
  end

  it "schedules a dedicated worker's jobs, and tells it how they went and each state of its objects" do
    scripts['/s/a.js'] = 'self.addEventListener("install", () => self.skipWaiting());'
    scripts['/w.js'] = <<~JS
      navigator.serviceWorker.register('/s/a.js', {scope: '/s/'}).then(r => {
        const w = r.installing;
        const states = [w.state];
        w.addEventListener('statechange', () => {
          states.push(w.state);
          if (w.state === 'activated') r.unregister().then(ok => postMessage({scope: new URL(r.scope).pathname, states, ok}));
        });
      }, x => postMessage({error: x.name}));
    JS
    session = session_listening
    session.execute_script(<<~JS)
      globalThis.__answer = null;
      new Worker('/w.js').onmessage = e => { globalThis.__answer = e.data; };
    JS
    answer = poll_until { session.evaluate_script('globalThis.__answer') }
    expect(answer).to eq('scope' => '/s/', 'states' => %w[installing installed activating activated], 'ok' => true)
  end

  it "moves a controlled worker client to its registration's next version as Activate does" do
    version = 0
    scripts['/s/a.js'] = lambda {|_req|
      version += 1
      "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('fetch', e => { if (e.request.url.endsWith('/version')) e.respondWith(new Response('#{version}')); });"
    }
    scripts['/s/w.js'] = <<~JS
      self.onmessage = async () => {
        const c = navigator.serviceWorker.controller;
        postMessage({controlled: !!c, version: await (await fetch('/s/version')).text()});
      };
      navigator.serviceWorker.addEventListener('controllerchange', () => postMessage({changed: true}));
    JS
    session = session_listening
    register(session, '/s/a.js')
    wait_activated(session)
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.src = '/s/page';
      f.onload = () => {
        globalThis.__answers = [];
        const worker = new f.contentWindow.Worker('/s/w.js');
        worker.onmessage = e => globalThis.__answers.push(e.data);
        globalThis.__worker = worker;
        worker.postMessage('ask');
      };
      document.body.append(f);
    JS
    expect(poll_until { session.evaluate_script('(globalThis.__answers || [])[0]') }).to eq('controlled' => true, 'version' => '1')
    session.execute_script('__reg.then(r => r.update());')
    expect(poll_until { session.evaluate_script('__answers.some(a => a.changed)') }).to be(true)
    session.execute_script('__worker.postMessage("ask");')
    expect(poll_until { session.evaluate_script('__answers.at(-1)')['version'] == '2' }).to be(true)
  end

  it "gives a message to a client the service worker's origin, whatever that client's location says" do
    scripts['/s/a.js'] = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('message', e => e.source.postMessage('hello'));
    JS
    session = session_listening
    session.execute_script(<<~JS)
      globalThis.__origin = null;
      const f = document.createElement('iframe');
      f.src = '/s/framed';
      f.onload = () => {
        const g = f.contentDocument.createElement('iframe');
        g.srcdoc = '<!doctype html><meta charset=utf-8>x';
        g.onload = () => {
          const c = g.contentWindow.navigator.serviceWorker;
          c.onmessage = e => { globalThis.__origin = [e.origin, e.source === c.controller]; };
          c.controller.postMessage('go');
        };
        f.contentDocument.body.append(g);
      };
      navigator.serviceWorker.register('/s/a.js', {scope: '/s/'}).then(r => {
        const w = r.installing;
        w.addEventListener('statechange', () => { if (w.state === 'activated') document.body.append(f); });
      });
    JS
    origin = poll_until { session.evaluate_script('globalThis.__origin') }
    expect(origin).to eq([session.evaluate_script('location.origin'), true])
  end

  # A worker gone between its evaluation and Install's step installs nothing: no phantom `installing` worker, its job over.
  it 'fails the install of a worker that dies before its install event' do
    scripts['/s/a.js'] = "globalThis.__csim_swRegistrationUpdateFound = 1;"
    session = session_listening
    register(session, '/s/a.js')
    state = poll_until { session.evaluate_async_script(<<~JS) }
      const d = arguments[0];
      __reg.then(r => { const w = r.installing; d(w === null || w.state === 'redundant'); }, () => d(true));
    JS
    expect(state).to be(true)
    session.execute_script("globalThis.__again = null; navigator.serviceWorker.register('/s/b.js', {scope: '/s/'}).then(() => { __again = 'ok'; }, e => { __again = e.name; });")
    scripts['/s/b.js'] = '// fine'
    expect(poll_until { session.evaluate_script('globalThis.__again') }).to eq('ok')
  end

  # (…a kill landing in the making of a worker's isolate left it no one's to dispose: 26.7 MB an iteration)
  it 'leaves no isolate behind a worker a reset ends as it boots', :aggregate_failures do
    scripts['/w.js'] = 'postMessage(1);'
    rss = -> { File.read('/proc/self/statm').split[1].to_i * 4096 / 1_048_576 }
    session = session_listening
    12.times do
      session.visit '/'
      session.execute_script("new Worker('/w.js');")
      session.reset_session!
    end
    before = rss.call
    30.times do
      session.visit '/'
      session.execute_script("new Worker('/w.js');")
      session.reset_session!
    end
    expect(rss.call - before).to be < 300
  end
end
