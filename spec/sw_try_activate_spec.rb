# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# Try Activate (Service Workers §8) holds a waiting worker while the active worker is still ACTIVATING, and tries it
# again once that one's activate event's extend lifetime promises settled (Install's note) — an update installed during
# the old version's activation activates right after it, with no client left to unload (Chrome measured 2026-10-30:
# `w2=activated w1=redundant`).
# (…service Workers are modeled only in a universal-server context)
RSpec.describe 'Service Worker Try Activate', :every_host_local do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        case req.path_info
        when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>main</body>']]
        when '/scope/sw.js'
          # v1's activation waits for a release over a BroadcastChannel.
          body = <<~JS
            const version = #{req.params['v'].inspect};
            let release;
            const released = new Promise((r) => { release = r; });
            new BroadcastChannel('release').onmessage = () => release();
            self.addEventListener('activate', (e) => { if (version === '1') e.waitUntil(released); });
          JS
          [200, {'content-type' => 'text/javascript'}, [body]]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  it 'activates an update installed while the active worker was still activating, once that one is activated' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      const reached = (w, state) => new Promise((resolve) => {
        if (w.state === state) return resolve();
        w.addEventListener('statechange', () => { if (w.state === state) resolve(); });
      });
      (async () => {
        const r1 = await navigator.serviceWorker.register('/scope/sw.js?v=1', {scope: '/scope/'});
        const w1 = r1.installing;
        await reached(w1, 'activating');
        const r2 = await navigator.serviceWorker.register('/scope/sw.js?v=2', {scope: '/scope/'});
        const w2 = r2.installing;
        await reached(w2, 'installed');
        log.push(`installed while ${w1.state}`);
        new BroadcastChannel('release').postMessage('go');
        await reached(w2, 'activated');
        log.push(`${w1.state} ${w2.state}`);
      })().catch((e) => log.push(String(e)));
    JS
    expect(poll_until { session.evaluate_script('log.length >= 2 && log') }).to eq([
      'installed while activating',
      'redundant activated'
    ])
  end
end
