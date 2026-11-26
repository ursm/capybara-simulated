# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What a service-worker client is, the engine's (sw_registry.rs `swClientFacts`, navigables.rs `client_frame_type`): its
# URL the CREATION URL, which `history.pushState` leaves (Chrome 158 measured: a client that pushed /pushed still
# `http://…/`); its frame type "nested" in a frame, "auxiliary" for a window a page opened (Service Workers `frameType`
# — Chrome 158 reports a pop-up "top-level", against the spec's "auxiliary browsing context"), else "top-level".
RSpec.describe 'a service-worker client, as the engine has it' do
  let(:worker) {
    <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('message', e => e.waitUntil(self.clients.matchAll({includeUncontrolled: true}).then(cs => {
        e.source.postMessage(cs.map(c => [new URL(c.url).pathname, c.frameType]));
      })));
    JS
  }
  let(:app) {
    sw = worker
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
      end
    }
  }

  def clients(session)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      navigator.serviceWorker.onmessage = (e) => done(e.data);
      navigator.serviceWorker.controller.postMessage('go');
    JS
  end

  it "has its creation URL, a frame's frame type nested, a pop-up's auxiliary" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.addEventListener('controllerchange', () => { globalThis.__controlled = true; });
      navigator.serviceWorker.register('/sw.js');
    JS
    expect(poll_until { session.evaluate_script('globalThis.__controlled === true') }).to be(true)
    session.execute_script(<<~JS)
      history.pushState(null, '', '/pushed');
      const f = document.createElement('iframe'); f.src = '/frame'; document.body.append(f);
      window.open('/popup');
    JS
    poll_until { session.windows.length == 2 && session.evaluate_script("document.querySelector('iframe').contentDocument?.readyState") == 'complete' }
    got = poll_until { (c = clients(session)).length >= 3 && c }
    expect(got).to contain_exactly(['/', 'top-level'], ['/frame', 'nested'], ['/popup', 'auxiliary'])
  end
end
