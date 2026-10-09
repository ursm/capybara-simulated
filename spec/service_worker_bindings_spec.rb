# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer and NavigationPreloadManager, generated from their
# IDL: made by the platform alone, their state in slots — the client's objects and the service worker's own view of
# itself and its registration alike, which are the same interfaces' objects. A service worker posting to itself gets
# the message, from its own ServiceWorker; a registration with no active worker yet has no navigation preload to enable
# (an InvalidStateError, Service Workers §3.5), and a header value has no leading or trailing whitespace (Fetch).
RSpec.describe 'Service Worker bindings' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case env['PATH_INFO']
        when '/' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
        when '/sw.js'
          [200, {'content-type' => 'text/javascript'}, [<<~JS]]
            // A message to itself, during startup; and the navigation preload of a registration with no active worker yet.
            let fromSelf = null;
            let preloadWhileInstalling = null;
            self.addEventListener('message', (e) => { if (e.data === 'self') fromSelf = e.source === self.serviceWorker; });
            self.serviceWorker.postMessage('self');
            self.addEventListener('install', (e) => {
              e.waitUntil(self.registration.navigationPreload.enable().then(() => 'ok', (err) => err.name).then((r) => { preloadWhileInstalling = r; }));
            });
            self.onmessage = (e) => e.data !== 'self' && e.source.postMessage({
              fromSelf, preloadWhileInstalling,
              registration: [self.registration instanceof ServiceWorkerRegistration, Object.prototype.toString.call(self.registration),
                             Object.keys(self.registration), self.registration.updateViaCache, self.registration.scope],
              worker: [self.serviceWorker instanceof ServiceWorker, self.serviceWorker.state, self.registration.active === self.serviceWorker],
              preload: self.registration.navigationPreload === self.registration.navigationPreload
            });
          JS
        # (…a worker that reports its scope's client and event interfaces)
        when '/surface.js'
          [200, {'content-type' => 'text/javascript'}, [<<~JS]]
            const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
            const rej = (p) => p.then(() => 'ok', (e) => e.name);
            let routes = null;
            self.addEventListener('install', (e) => { routes = rej(e.addRoutes({ condition: {}, source: 'network' })); });
            self.onmessage = async (e) => {
              const extended = err(() => e.waitUntil(Promise.resolve()));   // (…while it is dispatched, not after an await)
              const message = new ExtendableMessageEvent('message', { ports: [] });
              e.source.postMessage({
                clients: [self.clients instanceof Clients, Object.keys(Clients.prototype).includes('matchAll'),
                          e.source instanceof WindowClient, e.source.focused, e.source.visibilityState,
                          await rej(self.clients.openWindow('/x')), err(() => new Client())],
                events: [err(() => new ExtendableEvent('x').waitUntil(Promise.resolve())), err(() => new FetchEvent('fetch')),
                         Object.isFrozen(message.ports), message.ports === message.ports, message.data,
                         extended, await routes]
              });
            };
          JS
        # (…a version that sets its registration's navigation preload header while it installs, and takes over)
        when '/update.js'
          [200, {'content-type' => 'text/javascript'}, [<<~JS]]
            self.addEventListener('install', (e) => {
              e.waitUntil(self.registration.navigationPreload.setHeaderValue(new URL(location).searchParams.get('v'))
                .catch(() => {}).then(() => self.skipWaiting()));
            });
          JS
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'is what their IDL says, on both sides' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__out = null;
      (async () => {
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const rej = (p) => p.then(() => 'ok', (e) => e.name);
        const surface = [
          err(() => new ServiceWorker()), err(() => new ServiceWorkerRegistration()), err(() => new ServiceWorkerContainer()),
          err(() => new NavigationPreloadManager()), Object.keys(ServiceWorkerRegistration.prototype).includes('update'),
          await rej(navigator.serviceWorker.register('/sw.js', {updateViaCache: 'bogus'}))
        ];
        const reg = await navigator.serviceWorker.register('/sw.js', {scope: '/'});
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const regs = await navigator.serviceWorker.getRegistrations();
        const buffer = new ArrayBuffer(8);
        const reply = new Promise((res) => { navigator.serviceWorker.onmessage = (e) => res(e.data); });
        reg.active.postMessage({}, {transfer: [buffer]});
        globalThis.__out = {
          surface,
          client: [reg instanceof ServiceWorkerRegistration, Object.keys(reg), reg.navigationPreload === reg.navigationPreload,
                   Object.isFrozen(regs), await rej(reg.navigationPreload.setHeaderValue('\\u0100')),
                   await rej(reg.navigationPreload.setHeaderValue(' x')), buffer.byteLength],
          worker: await reply
        };
      })().catch((e) => { globalThis.__out = String(e); });
    JS
    poll_until { session.evaluate_script('globalThis.__out !== null') }
    got = session.evaluate_script('globalThis.__out')
    scope = "#{session.evaluate_script('location.origin')}/"
    expect(got).to eq(
      'surface' => ['TypeError', 'TypeError', 'TypeError', 'TypeError', true, 'TypeError'],
      'client' => [true, [], true, true, 'TypeError', 'TypeError', 0],
      'worker' => {
        'fromSelf' => true,
        'preloadWhileInstalling' => 'InvalidStateError',
        'registration' => [true, '[object ServiceWorkerRegistration]', [], 'imports', scope],
        'worker' => [true, 'activated', true],
        'preload' => true
      }
    )
  end

  # Navigation preload state is the registration's (§3.5): what a new version sets while it installs is still its
  # registration's once it is active — and before, while the registration had no active worker, there was none to set.
  it "keeps a registration's navigation preload across an update" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__out = null;
      const until = (w, s) => new Promise((res) => { if (w.state === s) return res(); w.addEventListener('statechange', () => { if (w.state === s) res(); }); });
      (async () => {
        const reg = await navigator.serviceWorker.register('/update.js?v=one', {scope: '/'});
        await until(reg.installing || reg.waiting || reg.active, 'activated');
        const first = (await reg.navigationPreload.getState()).headerValue;
        const again = await navigator.serviceWorker.register('/update.js?v=two', {scope: '/'});
        await until(again.installing, 'activated');
        globalThis.__out = [first, (await reg.navigationPreload.getState()).headerValue];
      })().catch((e) => { globalThis.__out = String(e); });
    JS
    poll_until { session.evaluate_script('globalThis.__out !== null') }
    expect(session.evaluate_script('globalThis.__out')).to eq(%w[true two])
  end

  # A service worker's clients and events, generated from their IDL: its scope's Clients and the WindowClient a page is
  # to it; a window opened only on a user's activation, which a worker here never has (InvalidAccessError); an event a
  # page made is untrusted, so it extends nothing (InvalidStateError, §4.5.1), where the platform's message event does
  # while it is dispatched; a FetchEvent needs its request; a router condition needs a member.
  it "is what a service worker's clients and events are" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__out = null;
      (async () => {
        const reg = await navigator.serviceWorker.register('/surface.js', {scope: '/'});
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const reply = new Promise((res) => { navigator.serviceWorker.onmessage = (e) => res(e.data); });
        reg.active.postMessage('go');
        globalThis.__out = await reply;
      })().catch((e) => { globalThis.__out = String(e); });
    JS
    poll_until { session.evaluate_script('globalThis.__out !== null') }
    expect(session.evaluate_script('globalThis.__out')).to eq(
      'clients' => [true, true, true, false, 'visible', 'InvalidAccessError', 'TypeError'],
      'events' => ['InvalidStateError', 'TypeError', true, true, nil, 'none', 'TypeError']
    )
  end
end
