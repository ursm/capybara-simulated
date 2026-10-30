# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A style sheet a controlling service worker answered is its link's request's answer: every reader of it — its load,
# the cascade, `.sheet` — has that one, whatever worker comes to control the document after (another version, claimed);
# the link's NEXT request, another link's, asks the worker then. Its integrity is judged against that answer.
RSpec.describe "a service worker's answer to a link's style sheet" do
  include PollUntil

  it "stays the link's request's, the next request asking the worker in control then" do
    version = 1
    good = "sha256-#{Digest::SHA256.base64digest('p { color: red }')}"
    worker = lambda {|v|
      <<~JS
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        let asked = 0;
        self.addEventListener('message', (e) => e.source.postMessage(asked));
        self.addEventListener('fetch', (e) => {
          if (!e.request.url.includes('/a.css')) return;
          asked++;
          e.respondWith(new Response('p { color: #{v == 1 ? 'red' : 'lime'} }', { headers: { 'content-type': 'text/css' } }));
        });
      JS
    }
    page = '<!DOCTYPE html><meta charset=utf-8><body><p>x</p><script>navigator.serviceWorker.register("/sw.js"); setInterval(() => {}, 50);</script>'
    asked = ->(s) { s.evaluate_async_script('const d = arguments[0]; navigator.serviceWorker.onmessage = (e) => d(e.data); navigator.serviceWorker.controller.postMessage(1);') }
    every_host_local do   # Service Workers are modeled only in a universal-server context
      s = simulated_session(lambda {|env|
        next [200, {'content-type' => 'text/javascript', 'cache-control' => 'no-store'}, [worker.(version)]] if env['PATH_INFO'] == '/sw.js'

        [200, {'content-type' => 'text/html'}, [page]]
      }).tap {|session| session.visit '/' }
      expect(poll_until { s.evaluate_script("navigator.serviceWorker.controller?.state === 'activated'") }).to be true
      s.execute_script("document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/a.css', integrity: '#{good}' }))")
      expect(poll_until { s.evaluate_script("getComputedStyle(document.querySelector('p')).color") == 'rgb(255, 0, 0)' }).to be true
      version = 2
      s.evaluate_async_script('const d = arguments[0]; navigator.serviceWorker.oncontrollerchange = () => d(1); navigator.serviceWorker.getRegistration().then((r) => r.update());')
      s.execute_script("document.body.className = 'x'; document.body.offsetWidth;")
      expect([s.evaluate_script('document.styleSheets[0].cssRules[0].cssText'), asked.(s)]).to eq(['p { color: red; }', 0])
      s.execute_script("document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/a.css' }))")
      expect(poll_until { s.evaluate_script("getComputedStyle(document.querySelector('p')).color") == 'rgb(0, 255, 0)' }).to be true
      expect(asked.(s)).to eq(1)
    end
  end
end
