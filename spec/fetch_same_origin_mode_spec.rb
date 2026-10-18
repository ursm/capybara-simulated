# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Fetch "main fetch" refuses a `same-origin` request for an http(s) URL of another origin than its CLIENT's — the
# document's origin, which a srcdoc or about:blank frame inherits whatever its location says (fetch_rules.rs
# `same_origin_mode_refused`): such a frame of a controlled page fetches its own origin through the service worker, and
# is refused another.
RSpec.describe 'a same-origin request' do
  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => { if (new URL(e.request.url).pathname === '/scope/t') e.respondWith(new Response('sw-ok')); });
    JS
    lambda { |env|
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

  it 'is its client document\'s origin\'s, in a srcdoc or about:blank frame of a controlled page' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.out = null;
      navigator.serviceWorker.register('/sw.js', { scope: '/scope/' }).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const page = document.body.appendChild(document.createElement('iframe'));
        page.src = '/scope/page.html';
        page.onload = async () => {
          const inner = page.contentDocument.body.appendChild(page.contentDocument.createElement('iframe'));
          inner.srcdoc = '<p>inner';
          inner.onload = async () => {
            const w = inner.contentWindow;
            const attempt = (u) => w.fetch(u, { mode: 'same-origin' }).then((r) => r.text(), (e) => e.name);
            window.out = [w.location.origin, w.origin, await attempt(location.origin + '/scope/t'), await attempt('http://other.test/scope/t')];
          };
        };
      });
    JS
    expect(poll_until(timeout: 10) { session.evaluate_script('window.out') }).to eq(['null', 'http://www.example.com', 'sw-ok', 'TypeError'])
  end
end
