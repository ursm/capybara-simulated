# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An EventSource a service worker answers is announced at its response's head (HTML "announce the connection": open and
# its `open` in one task) — never OPEN with no `open` fired while the body is read — and a status other than 200, or no
# `text/event-stream`, fails it (event_source_state.rs `served`).
RSpec.describe 'an EventSource a service worker answers' do
  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        const path = new URL(e.request.url).pathname;
        if (path === '/scope/stream') {
          const enc = new TextEncoder();
          const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('data: one\\n\\n')); setTimeout(() => { c.enqueue(enc.encode('data: two\\n\\n')); c.close(); }, 400); } });
          e.respondWith(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
        } else if (path === '/scope/plain') {
          e.respondWith(new Response('data: x\\n\\n', { headers: { 'content-type': 'text/plain' } }));
        }
      });
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>in scope']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>main']]
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

  it 'opens at the response head, and fails on a response that is no event stream' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      navigator.serviceWorker.register('/sw.js', { scope: '/scope/' }).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const page = document.body.appendChild(document.createElement('iframe'));
        page.src = '/scope/page.html';
        page.onload = () => {
          const W = page.contentWindow;
          const stream = new W.EventSource('/scope/stream');
          let opened = false;
          stream.onopen = () => { opened = true; log.push('open ' + stream.readyState); };
          stream.onmessage = (e) => log.push('message ' + e.data);
          // (…every 10 ms, so the check holds whenever the head comes)
          const watch = setInterval(() => { if (stream.readyState === 1 && !opened && !log.includes('open unannounced')) log.push('open unannounced'); }, 10);
          setTimeout(() => clearInterval(watch), 800);
          const plain = new W.EventSource('/scope/plain');
          plain.onerror = () => log.push('plain error ' + plain.readyState);
          setTimeout(() => { window.done = true; }, 900);
        };
      });
    JS
    poll_until(timeout: 15) { session.evaluate_script('window.done') }
    log = session.evaluate_script('window.log')
    expect(log).to include('open 1', 'plain error 2', 'message one', 'message two')
    expect(log).not_to include('open unannounced')
    expect(log.index('open 1')).to be < log.index('message one')
  end

  # The unloading document cleanup steps close a source a service worker answers, as they close a fetched one: a frame
  # removed in its `open` handler delivers no more of its messages.
  it 'is closed with its document' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      navigator.serviceWorker.register('/sw.js', { scope: '/scope/' }).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const page = document.body.appendChild(document.createElement('iframe'));
        page.src = '/scope/page.html';
        page.onload = () => {
          const stream = new page.contentWindow.EventSource('/scope/stream');
          stream.onopen = () => { page.remove(); log.push('removed ' + stream.readyState); };
          stream.onmessage = (e) => log.push('message ' + e.data);
          setTimeout(() => { window.done = true; }, 900);
        };
      });
    JS
    poll_until(timeout: 15) { session.evaluate_script('window.done') }
    expect(session.evaluate_script('window.log')).to eq(['removed 2'])
  end
end
