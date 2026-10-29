# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `clients.claim()` claims for an active worker alone (Service Workers §4.3.4): one evaluating or installing is no
# active worker yet — an InvalidStateError — where one activating is its registration's active worker already.
RSpec.describe 'Service Worker clients.claim()' do
  include PollUntil

  let(:app) {
    worker = <<~JS
      const outcome = (p) => p.then(() => 'claimed', (e) => e.name);
      const seen = {evaluation: outcome(self.clients.claim())};
      self.addEventListener('install', (e) => { seen.install = outcome(self.clients.claim()); });
      self.addEventListener('activate', (e) => { seen.activate = outcome(self.clients.claim()); e.waitUntil(seen.activate); });
      self.addEventListener('message', async (e) => {
        e.source.postMessage({evaluation: await seen.evaluation, install: await seen.install, activate: await seen.activate});
      });
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>page']]
      end
    }
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'claims for an active worker alone' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__out = null;
      navigator.serviceWorker.register('/sw.js').then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        navigator.serviceWorker.onmessage = (e) => { globalThis.__out = e.data; };
        reg.active.postMessage('tell');
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__out') }).to eq(
      'evaluation' => 'InvalidStateError', 'install' => 'InvalidStateError', 'activate' => 'claimed'
    )
  end
end
