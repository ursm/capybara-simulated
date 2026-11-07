# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# SW "Update", its byte check (service_worker.rs `ServiceWorkerUpdate`): a new version installs where the main script's bytes
# differ from the newest worker's, or those of a script that worker imported — judged against its script resource map, which
# the registry keeps (sw_registry.rs `ScriptResources`), whether the worker's thread is still there or not.
RSpec.describe 'a service worker update', :every_host_local do
  let(:scripts) { {} }
  let(:requests) { Hash.new {|h, k| h[k] = [] } }
  let(:session) {
    scripts  = self.scripts
    requests = self.requests
    simulated_session(lambda {|env|
      path = env['PATH_INFO']
      requests[path] << env['HTTP_SEC_FETCH_DEST']
      next [200, {'content-type' => 'text/html'}, ['<!doctype html><title>page</title>']] if path == '/'

      type, body, headers = scripts.fetch(path) { next [nil, nil] }
      type ? [200, {'content-type' => type, **headers.to_h}, [body]] : [404, {'content-type' => 'text/plain'}, ['nope']]
    })
  }
  after { session.reset_session! }

  def script(path, body, type: 'text/javascript', headers: {}) = scripts[path] = [type, body, headers]

  def register(options = '{}')
    session.visit('https://a.test/')
    outcome = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      navigator.serviceWorker.register('/sw.js', #{options}).then((r) => {
        window.reg = r;
        const w = r.installing || r.waiting || r.active;
        if (w.state === 'activated') return done('activated');
        w.addEventListener('statechange', () => { if (w.state === 'activated') done('activated'); });
      }, (e) => done(String(e)));
    JS
    expect(outcome).to eq('activated')
  end

  # Whether the update found a new version.
  def update = session.evaluate_async_script('const done = arguments[0]; reg.update().then((r) => done(r.installing !== null || r.waiting !== null));')

  # (…SW "stale": a day past its last update check — "no-cache" whatever its mode, in the Update fetch's hook)
  it 'asks the network, past the HTTP cache, for a stale registration' do
    script('/sw.js', '// one', headers: {'cache-control' => 'max-age=31536000'})
    register("{updateViaCache: 'all'}")
    asked = requests['/sw.js'].size
    expect(update).to be(false)
    expect(requests['/sw.js'].size).to eq(asked)
    allow(Time).to receive(:now).and_wrap_original {|now| now.call + 90_000 }
    expect(update).to be(false)
    expect(requests['/sw.js'].size).to eq(asked + 1)
    # (…the check it made its last: a day from then, not stale)
    expect(update).to be(false)
    expect(requests['/sw.js'].size).to eq(asked + 1)
  end

  # (…SW Handle Fetch: "If shouldSoftUpdate is true, then in parallel run the Soft Update algorithm" — a non-subresource
  # request's, whatever it comes to; a subresource's where the registration is stale)
  context 'with a Soft Update' do
    def in_scope(path) = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.createElement('iframe');
      f.src = #{path.to_json};
      f.onload = () => setTimeout(() => done(true), 1200);
      document.body.append(f);
    JS

    it "checks the script a second after a navigation in scope, a listener's or not, a new version found" do
      script('/sw.js', '// one')
      register
      asked = requests['/sw.js'].size
      script('/page', '<!doctype html>page', type: 'text/html')
      in_scope('/page')
      expect(requests['/sw.js'].size).to eq(asked + 1)
      expect(session.evaluate_script('reg.waiting === null && reg.installing === null')).to be(true)
      script('/sw.js', '// two')
      in_scope('/page?again')
      expect(requests['/sw.js'].size).to eq(asked + 2)
      expect(session.evaluate_script('reg.active.scriptURL.endsWith("/sw.js") && (reg.installing || reg.waiting || reg.active.state) !== null')).to be(true)
    end

    it 'checks it for a subresource only where the registration is stale' do
      script('/sw.js', "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', () => {});")
      register
      session.evaluate_async_script('const done = arguments[0]; const c = () => navigator.serviceWorker.controller ? done(true) : setTimeout(c, 10); c();')
      asked = requests['/sw.js'].size
      fetch_after_a_while = "const done = arguments[0]; fetch('/data').then(() => setTimeout(() => done(true), 50));"
      session.evaluate_async_script(fetch_after_a_while)
      expect(requests['/sw.js'].size).to eq(asked)
      allow(Time).to receive(:now).and_wrap_original {|now| now.call + 90_000 }
      session.evaluate_async_script(fetch_after_a_while)
      expect(requests['/sw.js'].size).to eq(asked + 1)
    end
  end

  it 'installs nothing for a byte-identical script' do
    script('/sw.js', "importScripts('/a.js');")
    script('/a.js', 'self.a = 1;')
    register
    expect(update).to be(false)
  end

  it 'installs a new version for a main script or an import of other bytes' do
    script('/sw.js', "importScripts('/a.js');")
    script('/a.js', 'self.a = 1;')
    register
    script('/a.js', 'self.a = 2;')
    expect(update).to be(true)
  end

  # (…a worker whose thread is gone is no worker to compare with: nothing here runs one again on demand, as SW's "Run Service
  # Worker" does, so an update is what brings the registration back, and a register's the same)
  ['update', 'register'].each do |how|
    it "brings a registration back by #{how} where the newest worker's thread is gone" do
      script('/sw.js', "addEventListener('fetch', (e) => e.respondWith(new Response('from sw')));")
      register
      browser = session.driver.browser
      browser.instance_variable_get(:@workers).keys.each {|handle| browser.send(:worker_terminate, handle) }
      how == 'update' ? expect(update).to(be(true)) : register
      session.evaluate_async_script(<<~JS)
        const done = arguments[0];
        navigator.serviceWorker.getRegistration().then((r) => {
          const w = r.installing || r.waiting || r.active;
          if (w.state === 'activated') return done();
          w.addEventListener('statechange', () => { if (w.state === 'activated') done(); });
        });
      JS
      session.visit('https://a.test/ans')
      expect(session.evaluate_script('document.body.textContent')).to eq('from sw')
    end
  end

  # ("If importUrl is url, then continue", the new version's own import of it answered from the map all the same)
  it 'probes its own main script no second time, its new version importing it from the map' do
    script('/sw.js', "if (!self.once) { self.once = true; importScripts('/a.js', '/sw.js'); }")
    script('/a.js', 'self.a = 1;')
    register
    expect(requests['/sw.js'].size).to eq(2)
    expect(update).to be(false)
    expect(requests['/sw.js'].size).to eq(3)
    script('/a.js', 'self.a = 2;')
    expect(update).to be(true)
    # (…its new version evaluated, its install reached: nothing of it fetched that the map held)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const w = reg.installing || reg.waiting;
      if (w.state !== 'installing') done();
      else w.addEventListener('statechange', () => done());
    JS
    expect(requests['/sw.js'].size).to eq(4)
  end

  # ("The control does not break the loop in this step to continue with all the imported scripts to populate the cache")
  it 'goes on over every import once one differs' do
    script('/sw.js', "importScripts('/a.js'); if (self.more) importScripts('/b.js');")
    script('/a.js', 'self.more = true;')
    script('/b.js', 'self.b = 1;')
    register
    script('/a.js', 'self.more = false;')
    expect(update).to be(true)
    expect(requests['/b.js'].size).to eq(2)
  end

  # ("If fetchedResponse is a bad import script response, continue")
  it 'takes an import of no JavaScript MIME type for no change, whatever its bytes' do
    script('/sw.js', "importScripts('/a.js');")
    script('/a.js', 'self.a = 1;')
    register
    script('/a.js', '<p>gone', type: 'text/html')
    expect(update).to be(false)
  end

  it 'takes a missing import for no change' do
    script('/sw.js', "importScripts('/a.js');")
    script('/a.js', 'self.a = 1;')
    register
    scripts.delete('/a.js')
    expect(update).to be(false)
  end

  # (…a module worker's graph of its destination, its update's probe the same request as its first fetch)
  it "probes a module worker's graph as its graph was first fetched" do
    script('/sw.js', "import '/dep.js';")
    script('/dep.js', 'self.d = 1;')
    register("{type: 'module'}")
    expect(update).to be(false)
    expect(requests['/dep.js']).to eq(%w[serviceworker serviceworker])
  end
end
