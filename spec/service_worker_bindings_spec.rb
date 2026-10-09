# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer and NavigationPreloadManager, generated from their
# IDL: made by the platform alone, their state in slots — the client's objects and the service worker's own view of
# itself and its registration alike, which are the same interfaces' objects.
RSpec.describe 'Service Worker bindings' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case env['PATH_INFO']
        when '/' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
        when '/sw.js'
          [200, {'content-type' => 'text/javascript'}, [<<~JS]]
            self.onmessage = (e) => e.source.postMessage({
              registration: [self.registration instanceof ServiceWorkerRegistration, Object.prototype.toString.call(self.registration),
                             Object.keys(self.registration), self.registration.updateViaCache, self.registration.scope],
              worker: [self.serviceWorker instanceof ServiceWorker, self.serviceWorker.state, self.registration.active === self.serviceWorker],
              preload: self.registration.navigationPreload === self.registration.navigationPreload
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
                   Object.isFrozen(regs), await rej(reg.navigationPreload.setHeaderValue('\\u0100')), buffer.byteLength],
          worker: await reply
        };
      })().catch((e) => { globalThis.__out = String(e); });
    JS
    poll_until { session.evaluate_script('globalThis.__out !== null') }
    got = session.evaluate_script('globalThis.__out')
    scope = "#{session.evaluate_script('location.origin')}/"
    expect(got).to eq(
      'surface' => ['TypeError', 'TypeError', 'TypeError', 'TypeError', true, 'TypeError'],
      'client' => [true, [], true, true, 'TypeError', 0],
      'worker' => {
        'registration' => [true, '[object ServiceWorkerRegistration]', [], 'imports', scope],
        'worker' => [true, 'activated', true],
        'preload' => true
      }
    )
  end
end
