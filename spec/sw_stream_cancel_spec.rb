require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A service worker's streamed response is open from its head to its terminal frame — its chunks between keep it open
# (WorkerHost streams): a client's `reader.cancel()` after a chunk reaches the worker's source stream's `cancel()`.
RSpec.describe "a service worker's streamed response" do
  include PollUntil
  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      let cancelled = 'no';
      self.addEventListener('message', (e) => e.source.postMessage('cancelled:' + cancelled));
      self.addEventListener('fetch', (e) => {
        const path = new URL(e.request.url).pathname;
        if (path === '/scope/stream') {
          const enc = new TextEncoder();
          let i = 0, t;
          const body = new ReadableStream({
            start(c) { c.enqueue(enc.encode('a')); t = setInterval(() => { try { c.enqueue(enc.encode('b')); } catch (_) {} }, 100); },
            cancel() { cancelled = 'yes'; clearInterval(t); }
          });
          e.respondWith(new Response(body));
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

  it "routes a client's cancel after a chunk to the worker's source stream" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      navigator.serviceWorker.register('/sw.js', { scope: '/scope/' }).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const page = document.body.appendChild(document.createElement('iframe'));
        page.src = '/scope/page.html';
        page.onload = async () => {
          const W = page.contentWindow;
          const r = await W.fetch('/scope/stream');
          const reader = r.body.getReader();
          const a = await reader.read(); log.push('read1 ' + a.value.length);
          const b = await reader.read(); log.push('read2 ' + b.value.length);
          await reader.cancel(); log.push('cancelled');
          setTimeout(() => {
            W.navigator.serviceWorker.onmessage = (e) => log.push(e.data);
            W.navigator.serviceWorker.controller.postMessage('q');
          }, 500);
        };
      });
    JS
    poll_until(timeout: 8) { session.evaluate_script('log').any? {|l| l.start_with?('cancelled:') } }
    expect(session.evaluate_script('log')).to eq(['read1 1', 'read2 1', 'cancelled', 'cancelled:yes'])
  end
end
