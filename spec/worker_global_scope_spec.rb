require 'capybara/simulated'
require_relative 'support/session_teardown'

# A worker's global is its kind's global scope (HTML §10.2.1), generated from the IDL: its prototype chain
# DedicatedWorkerGlobalScope's → WorkerGlobalScope's (WindowOrWorkerGlobalScope's members there) → EventTarget's, no
# interface object of one exposed in a Window alone, a WorkerNavigator and a WorkerLocation of the worker's script. And
# a window's navigator a Navigator, its members the interface's, none of them its own, in Chrome's compatibility mode —
# and both of them the user agent a test sets.
RSpec.describe 'Worker global scope' do
  let(:app) {
    lambda do |env|
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x']]
      when '/w.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          postMessage([
            Object.getPrototypeOf(self) === DedicatedWorkerGlobalScope.prototype,
            Object.getPrototypeOf(DedicatedWorkerGlobalScope.prototype) === WorkerGlobalScope.prototype,
            self instanceof EventTarget,
            Object.getOwnPropertyNames(WorkerGlobalScope.prototype).includes('setTimeout'),
            typeof Node, typeof Window, typeof SharedWorkerGlobalScope,
            navigator instanceof WorkerNavigator, location instanceof WorkerLocation, location.pathname,
            typeof importScripts, 'onmessage' in self, Object.prototype.toString.call(self),
            self.constructor.name, self.hasOwnProperty('addEventListener'), self.name, typeof navigator.permissions,
            navigator.userAgent,
            (() => { try { postMessage(() => 1); return 'posted'; } catch (e) { return e.name; } })()
          ]);
        JS
      else [404, {'content-type' => 'text/plain'}, ['nope']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'makes a dedicated worker a DedicatedWorkerGlobalScope' do
    session.driver.browser.default_user_agent = 'MyUA/1.0'
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      new Worker('/w.js', { name: 'nm' }).onmessage = (e) => done(e.data);
    JS
    expect(got).to eq([
      true, true, true, true,
      'undefined', 'undefined', 'undefined',
      true, true, '/w.js',
      'function', true, '[object DedicatedWorkerGlobalScope]',
      'DedicatedWorkerGlobalScope', false, 'nm', 'object',
      'MyUA/1.0',
      'DataCloneError'
    ])
  end

  it "makes a window's navigator a Navigator" do
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq([true, [], 'Mozilla', 'Gecko', true, 'undefined', false, true, 'Linux x86_64', true, 'TypeError'])
      [navigator instanceof Navigator, Object.getOwnPropertyNames(navigator), navigator.appCodeName, navigator.product,
       Object.getOwnPropertyNames(Navigator.prototype).includes('userAgent'), typeof WorkerGlobalScope,
       'oscpu' in navigator, navigator.appVersion.startsWith('5.0 (X11'), navigator.platform, Object.isFrozen(navigator.languages),
       (() => { try { return Navigator.prototype.doNotTrack; } catch (e) { return e.name; } })()]
    JS
  end
end
