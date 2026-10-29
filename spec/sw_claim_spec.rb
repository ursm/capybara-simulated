# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `clients.claim()` claims for an active worker alone (Service Workers §4.3.4): one evaluating or installing is no
# active worker yet — an InvalidStateError — where one activating is its registration's active worker already. And a
# worker's activate event is Activate's to fire (§8): an update waiting while the worker before it controls a client runs
# no activate handler — a cache cleanup the old version still serves from — and claims nothing.
RSpec.describe 'Service Worker clients.claim()' do
  include PollUntil

  let(:app) {
    gated = <<~JS
      let open;
      self.addEventListener('activate', (e) => e.waitUntil(new Promise((res) => { open = res; })));
      self.addEventListener('message', () => open && open());
    JS
    versioned = <<~JS
      self.addEventListener('activate', (e) => { self.activated = true; e.waitUntil(self.clients.claim()); });
      self.addEventListener('message', async (e) => {
        e.source.postMessage({activated: !!self.activated, state: self.serviceWorker.state, claim: await self.clients.claim().then(() => 'claimed', (x) => x.name)});
      });
    JS
    worker = <<~JS
      const outcome = (p) => p.then(() => 'claimed', (e) => e.name);
      const seen = {evaluation: outcome(self.clients.claim())};
      self.addEventListener('install', (e) => { seen.install = outcome(self.clients.claim()); });
      self.addEventListener('activate', (e) => { seen.activate = outcome(self.clients.claim()); e.waitUntil(seen.activate); });
      self.addEventListener('message', async (e) => {
        e.source.postMessage({evaluation: await seen.evaluation, install: await seen.install, activate: await seen.activate});
      });
    JS
    version = 0
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/versioned.js'
        version += 1
        [200, {'content-type' => 'text/javascript'}, ["// v#{version}\n#{versioned}"]]
      when '/gated.js' then [200, {'content-type' => 'text/javascript'}, [gated]]
      when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>in scope']]
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

  it 'runs no activate handler of an update waiting for the worker before it' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__out = null;
      const settled = (w, state) => new Promise((res) => { const step = () => (w.state === state ? res() : w.addEventListener('statechange', step, {once: true})); step(); });
      navigator.serviceWorker.register('/versioned.js', {scope: '/scope/'}).then(async (reg) => {
        await settled(reg.installing || reg.waiting || reg.active, 'activated');
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        await new Promise((res) => { f.onload = res; document.body.appendChild(f); });
        await reg.update();
        await settled(reg.installing || reg.waiting, 'installed');
        await new Promise((res) => setTimeout(res, 200));
        navigator.serviceWorker.onmessage = (e) => { globalThis.__out = e.data; };
        reg.waiting.postMessage('tell');
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__out') }).to eq('activated' => false, 'state' => 'installed', 'claim' => 'InvalidStateError')
  end

  # A registration unregistered while its worker's activate event is pending is cleared once that event's lifetime
  # promises settle (Service Workers "Try Clear Registration": no version with a pending event; `waitUntil`'s steps
  # try again as the last promise settles) — its activation completing first — not at once, its worker made redundant
  # mid-activation.
  it 'clears a registration unregistered mid-activation once its activate event settles' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__states = [];
      navigator.serviceWorker.register('/gated.js', {scope: '/gated/'}).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        w.addEventListener('statechange', () => __states.push(w.state));
        await new Promise((res) => { const step = () => (w.state === 'activating' ? res() : w.addEventListener('statechange', step, {once: true})); step(); });
        await reg.unregister();
        await new Promise((res) => setTimeout(res, 200));
        __states.push('released');
        w.postMessage('open');
      });
    JS
    expect(poll_until { session.evaluate_script("globalThis.__states.includes('redundant') && globalThis.__states") }).to eq(%w[installed activating released activated redundant])
  end
end
