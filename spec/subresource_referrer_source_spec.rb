# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What a subresource refers by: its document's referrer policy as the request is made — a `<meta name="referrer">` the
# parser inserted before an `<img>` sets it for that image's fetch (HTML: the meta's policy set as it is inserted, the
# image's fetch made at its stable state after) — and its document's referrer source, a srcdoc document's its container
# document's URL (Fetch "determine request's referrer": "environment's relevant global object's associated Document …
# while document is an iframe srcdoc document, let document be document's browsing context's container document"),
# whether a service worker answers it or the network.
RSpec.describe 'a subresource request\'s referrer' do
  let(:seen) { [] }
  let(:referers) { {} }
  let(:app) {
    log  = referers
    sw   = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      const seen = [];
      self.addEventListener('fetch', e => { const p = new URL(e.request.url).pathname; if (p.startsWith('/sw/t')) seen.push([p, e.request.referrer]); });
      self.addEventListener('message', e => e.ports[0].postMessage(seen));
    JS
    lambda {|env|
      path = env['PATH_INFO']
      log[path] = env['HTTP_REFERER']
      case path
      when '/sw/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/nr' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><meta name=referrer content=no-referrer><body><img id=i src="/i.png">']]
      when %r{\.js\z} then [200, {'content-type' => 'text/javascript'}, ['window.tran = true;']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
      end
    }
  }

  it "is none for a parsed image under a `<meta name=referrer content=no-referrer>` before it" do
    session = simulated_session(app)
    session.visit '/nr'
    expect(poll_until { session.evaluate_script("document.getElementById('i').complete") }).to be(true)
    expect(referers).to include('/i.png' => nil)
  end

  it "is a srcdoc document's container's URL, for its worker and its network leg alike" do
    session = simulated_session(app)
    session.visit '/sw/p'
    session.execute_script("navigator.serviceWorker.addEventListener('controllerchange', () => { globalThis.__c = true; }); navigator.serviceWorker.register('/sw/sw.js');")
    expect(poll_until { session.evaluate_script('globalThis.__c === true') }).to be(true)
    ran = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.createElement('iframe');
      f.srcdoc = '<script src="/sw/t.js"><' + '/script>';
      f.onload = () => done(f.contentWindow.tran === true);
      document.body.append(f);
    JS
    expect(ran).to be(true)
    page = "#{session.evaluate_script('location.origin')}/sw/p"
    worker = session.evaluate_async_script("const d = arguments[0]; const c = new MessageChannel(); c.port1.onmessage = e => d(e.data); navigator.serviceWorker.controller.postMessage(0, [c.port2]);")
    expect(worker).to include(['/sw/t.js', page])
    expect(referers.fetch('/sw/t.js')).to eq(page)
  end
end
