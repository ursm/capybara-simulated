# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A `fetch()` of integrity metadata is a network error where its response's body matches none of it (Fetch "main
# fetch"), the body read whole first: a service worker's answer streamed in chunks is checked against all of them, not
# against what it had read so far (none). An opaque response is refused by any metadata — its body is null, which main
# fetch refuses before SRI's matching would let metadata of no algorithm it knows through (Chrome and Firefox alike).
RSpec.describe 'fetch() integrity' do
  include PollUntil

  it "checks a worker's streamed answer against its whole body" do
    body = 'streamed body'
    good = "sha256-#{Digest::SHA256.base64digest(body)}"
    worker = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        if (!e.request.url.includes('/streamed')) return;
        const chunks = ['streamed ', 'body'].map((c) => new TextEncoder().encode(c));
        e.respondWith(new Response(new ReadableStream({ pull(c) { const next = chunks.shift(); next ? c.enqueue(next) : c.close(); } })));
      });
    JS
    page = '<!DOCTYPE html><meta charset=utf-8><body><script>navigator.serviceWorker.register("/sw.js"); setInterval(() => {}, 50);</script>'
    every_host_local do   # Service Workers are modeled only in a universal-server context
      s = simulated_session(lambda {|env|
        env['PATH_INFO'] == '/sw.js' ? [200, {'content-type' => 'text/javascript'}, [worker]] : [200, {'content-type' => 'text/html'}, [page]]
      }).tap {|session| session.visit '/' }
      expect(poll_until { s.evaluate_script("navigator.serviceWorker.controller?.state === 'activated'") }).to be true
      got = s.evaluate_async_script(<<~JS)
        const done = arguments[0];
        const attempt = (integrity) => fetch('/streamed', { integrity }).then((r) => r.text(), (e) => e.name);
        Promise.all([attempt('#{good}'), attempt('sha256-#{'A' * 43}=')]).then(done);
      JS
      expect(got).to eq([body, 'TypeError'])
    end
  end

  # (…another origin served in-process)
  it "refuses an opaque response by any metadata, one of no algorithm SRI knows too", :every_host_local do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const attempt = (integrity) => fetch('http://other.example.com/x', { mode: 'no-cors', integrity }).then((r) => r.type, (e) => e.name);
      Promise.all([attempt('sha256-#{'A' * 43}='), attempt('sha999-abc')]).then(done);
    JS
    expect(got).to eq(%w[TypeError TypeError])
  end

  # (…and an element's — a no-cors `<script>` of another origin — the same main fetch's: Firefox fires `error`; Chrome
  # loads it, a Blink departure from the spec)
  it "refuses an element's opaque response by any metadata", :every_host_local do
    s = simulated_session(lambda {|env|
      if env['PATH_INFO'] == '/x.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const load = (integrity) => new Promise((res) => {
        const el = Object.assign(document.createElement('script'), { src: 'http://other.example.com/x.js', integrity });
        el.onload = () => res('load');
        el.onerror = () => res('error');
        document.body.append(el);
      });
      Promise.all([load('sha999-abc'), load('')]).then(done);
    JS
    expect(got).to eq(%w[error load])
  end
end
