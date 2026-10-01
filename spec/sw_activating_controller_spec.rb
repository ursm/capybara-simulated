# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame navigated into a scope while its registration is still ACTIVATING its worker. Handle Fetch sets the frame's
# active service worker to the registration's active worker before it asks whether that worker handles fetches — a
# worker with no fetch handler makes the navigation wait for nothing, so the frame is built while the worker activates,
# and controlled by it all the same. Matched against the activated registrations alone, it was left uncontrolled (WPT
# unregister-then-register "does not resurrect the registration", 2 runs in 10). And its controller is the worker as it
# is: 'activating', then 'activated' with the `statechange` the page waits on — a worker the frame only knows as its
# controller was minted 'activated' and never moved.
RSpec.describe 'a frame a still-activating service worker controls' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case env['PATH_INFO']
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>in-scope</body></html>']]
        # No fetch handler; its activation holds until the page lets it go.
        when '/scope/sw.js'
          [200, {'content-type' => 'text/javascript'},
           ['self.addEventListener("activate", (e) => e.waitUntil(new Promise((res) => { self.addEventListener("message", res); })));']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'is controlled by it, activating, and hears it activate' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__got = null;
      (async () => {
        const reg = await navigator.serviceWorker.register('/scope/sw.js', {scope: '/scope/'});
        const w = reg.installing;
        await new Promise((res) => {
          if (w.state === 'activating') return res();
          w.addEventListener('statechange', () => { if (w.state === 'activating') res(); });
        });
        const frame = await new Promise((res) => {
          const f = document.createElement('iframe');
          f.src = '/scope/page.html';
          f.addEventListener('load', () => res(f), {once: true});
          document.body.appendChild(f);
        });
        const controller = frame.contentWindow.navigator.serviceWorker.controller;
        const during = controller && controller.state;
        const activated = new Promise((res) => controller.addEventListener('statechange', () => res(controller.state)));
        w.postMessage('go');
        globalThis.__got = [!!controller, during, await activated];
      })();
    JS
    poll_until { session.evaluate_script('globalThis.__got') }
    expect(session.evaluate_script('globalThis.__got')).to eq([true, 'activating', 'activated'])
  end
end
