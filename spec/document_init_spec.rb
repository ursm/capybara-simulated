# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What the document a navigation commits is made of is decided once, for the page and a window `window.open` made alike
# (document_init.rs, HTML "create and initialize a Document object"): here, the service worker that controls it — the one
# its fetch matched (Service Workers §2.5.1), none for a document whose response's Content-Security-Policy sandboxes it
# into an opaque origin, though the worker answered its navigation ("Sandboxed iframes … result in having the active
# service worker value of null as their origin is an opaque origin"; Chrome 157 and Firefox 159, measured 2026-11-25: a
# top-level `sandbox allow-scripts` document's fetch goes to the network, a plain one's to the worker).
RSpec.describe 'a document a navigation commits' do
  include PollUntil

  let(:worker) {
    <<~JS
      self.addEventListener('install', e => self.skipWaiting());
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        if (new URL(e.request.url).pathname === '/probe') e.respondWith(new Response('worker'));
      });
    JS
  }
  let(:app) {
    sw = worker
    show = "<script>fetch('/probe').then(r => r.text()).then(t => { document.title = t; })</script>"
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/probe' then [200, {'content-type' => 'text/plain', 'access-control-allow-origin' => '*'}, ['network']]
        when '/sandboxed' then [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts'}, ["<!doctype html>#{show}"]]
        when '/plain' then [200, {'content-type' => 'text/html'}, ["<!doctype html>#{show}"]]
        else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
        end
      }
    }.to_app
  }

  def registered(session)
    session.visit '/'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
  end

  it "is the page's, controlled by no worker where its response's CSP sandboxes it" do
    session = simulated_session(app)
    registered(session)
    session.visit '/plain'
    expect(poll_until { session.evaluate_script('document.title').then {|t| t.empty? ? nil : t } }).to eq('worker')
    session.visit '/sandboxed'
    expect(poll_until { session.evaluate_script('document.title').then {|t| t.empty? ? nil : t } }).to eq('network')
  end

  it "is a window's, controlled by no worker where its response's CSP sandboxes it" do
    session = simulated_session(app)
    registered(session)
    session.execute_script("window.w = open('/plain')")
    expect(poll_until { session.evaluate_script('w.document.title').then {|t| t.empty? ? nil : t } }).to eq('worker')
    session.execute_script("w.location = '/sandboxed'")
    session.switch_to_window(session.windows.last)
    expect(poll_until { session.evaluate_script('document.title').then {|t| t.empty? ? nil : t } }).to eq('network')
  end
end
