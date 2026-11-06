# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A client `clients.claim()` takes in its worker's `activate` event is controlled while the worker is still activating,
# and Handle Fetch waits for the worker to become activated before it dispatches the client's request to it
# ("If activeWorker's state is activating, wait for activeWorker's state to become activated"). A synchronous XHR waits
# with it. Before, it went to the network, bypassing the worker. The page's test of its control and its XHR fell
# between the claim and the end of `activate`, a race a loaded machine lost about once in forty runs of
# sw_sync_xhr_spec; here `activate` stays open 300 ms after the claim, so the race is lost every time.
RSpec.describe 'a controlled client’s synchronous XHR while its worker activates' do
  include PollUntil

  let(:app) {
    sw = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim().then(() => new Promise((r) => setTimeout(r, 300)))));
      self.addEventListener('fetch', (e) => {
        if (new URL(e.request.url).searchParams.has('sw')) e.respondWith(new Response('sw'));
      });
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js'    then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/data.txt' then [200, {'content-type' => 'text/plain'}, ['network']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  it 'waits for the worker to activate and is answered by it' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.result = null;
      navigator.serviceWorker.register('/sw.js');
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        const state = navigator.serviceWorker.controller.state;
        const x = new XMLHttpRequest();
        x.open('GET', '/data.txt?sw', false);
        x.send();
        window.result = [state, x.responseText];
      });
    JS
    expect(poll_until { s.evaluate_script('window.result') }).to eq(%w[activating sw])
  end

  # …and one whose `activate` waits on the page — polling with a timer for a message the page, its script waiting in
  # place, cannot send — is given up on after a second of the worker's time, the request the network's. The page is
  # charged that second, as a browser's would have been held for it: left uncharged, the worker's next answer lifted the
  # page's clock by it (`[1315, 1315]`, its `Date` that far ahead of the page's).
  context 'a worker whose activate waits on the page' do
    let(:app) {
      sw = <<~JS
        self.addEventListener('install', () => self.skipWaiting());
        let got = false;
        self.addEventListener('message', (e) => { if (e.data === 'when') e.source.postMessage(Date.now()); else got = true; });
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim().then(() => new Promise((r) => {
          const t = () => (got ? r() : setTimeout(t, 50));
          t();
        }))));
        self.addEventListener('fetch', (e) => {
          if (new URL(e.request.url).searchParams.has('sw')) e.respondWith(new Response('sw'));
        });
      JS
      lambda {|env|
        case env['PATH_INFO']
        when '/sw.js'    then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/data.txt' then [200, {'content-type' => 'text/plain'}, ['network']]
        else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
        end
      }
    }

    it "gives up, the page charged the worker's time, and the worker's next answer at the page's time" do
      s = simulated_session(app)
      s.visit '/'
      s.execute_script(<<~JS)
        window.result = null;
        navigator.serviceWorker.register('/sw.js');
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          const t0 = performance.now();
          const x = new XMLHttpRequest();
          x.open('GET', '/data.txt?sw', false);
          x.send();
          window.result = [x.responseText, Math.round(performance.now() - t0)];
        });
      JS
      text, waited = poll_until { s.evaluate_script('window.result') }
      expect(text).to eq('network')
      expect(waited).to be_between(900, 1200)
      s.execute_script(<<~JS)
        window.skew = null;
        const d0 = Date.now(), p0 = performance.now();
        navigator.serviceWorker.onmessage = (e) => { window.skew = [e.data - d0, Math.round(performance.now() - p0)]; };
        navigator.serviceWorker.controller.postMessage('when');
      JS
      expect(poll_until { s.evaluate_script('window.skew') }.map(&:abs)).to all(be < 50)
    end
  end
end
