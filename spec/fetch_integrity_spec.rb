# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A `fetch()` of integrity metadata is a network error where its response's body matches none of it (Fetch "main
# fetch"), the body read whole first: a service worker's answer streamed in chunks is checked against all of them, not
# against what it had read so far (none).
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
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    begin
      s = simulated_session(lambda {|env|
        env['PATH_INFO'] == '/sw.js' ? [200, {'content-type' => 'text/javascript'}, [worker]] : [200, {'content-type' => 'text/html'}, [page]]
      }).tap {|session| session.visit '/' }
      expect(poll_until { s.evaluate_script('!!navigator.serviceWorker.controller') }).to be true
      got = s.evaluate_async_script(<<~JS)
        const done = arguments[0];
        const attempt = (integrity) => fetch('/streamed', { integrity }).then((r) => r.text(), (e) => e.name);
        Promise.all([attempt('#{good}'), attempt('sha256-#{'A' * 43}=')]).then(done);
      JS
      expect(got).to eq([body, 'TypeError'])
    ensure
      ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
    end
  end
end
