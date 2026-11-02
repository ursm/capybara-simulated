# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A message leaving a window carries the time of the agent's `Date` scale, not its document's (timers.js `agentShift`):
# a next page's `Date` begins again at the wall clock, behind where the last page's had gone after a fast-forward, while
# a pop-up's document — and the workers it made — go on from where they were. The page, its frames and the pop-ups of
# one agent convert at the boundary, so a worker reads every document's messages on one scale.
#
# Before, a worker took the main page's next document as its own scale's change (`anew`) whoever made it. A pop-up's
# dedicated worker, its opener navigated after 20 s, read the pop-up's messages 18 s ahead, and answered them that far
# its own `Date` 18 s ahead of the pop-up's (dDate 38,204 where the pop-up's read 20,301). Each shape here waits 5 s on
# the opener before it navigates, and then measures, on the pop-up's clock, the round trip of a message to the worker and
# how far the worker's `Date` stood from the pop-up's as it answered.
# (…service workers are modeled only in a universal-server context)
RSpec.describe "a worker's messages across an opener's navigation", :every_host_local do
  include PollUntil

  def app(popup_script, page_script = '')
    sw = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('message', (e) => e.source.postMessage(Date.now()));
    JS
    shared = "onconnect = (e) => { const p = e.ports[0]; p.onmessage = () => p.postMessage(Date.now()); };"
    opener = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><title>a</title>
      <script>#{page_script}
        window.pop = window.open('/pop', 'p');
        setTimeout(() => { location.href = '/b'; }, 5000);
      </script>
    HTML
    popup = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><title>pop</title>
      <script>
        window.R = null;
        // (…the round trip on this window's clock, and the worker's `Date` as it answered against this window's then)
        window.timed = () => {
          const t0 = performance.now();
          return (e) => { window.R = [Math.round(performance.now() - t0), Math.round(e.data - Date.now())]; };
        };
        #{popup_script}
      </script>
    HTML
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/shared.js' then [200, {'content-type' => 'text/javascript'}, [shared]]
      when '/pop' then [200, {'content-type' => 'text/html'}, [popup]]
      when '/b' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><title>b</title>']]
      else [200, {'content-type' => 'text/html'}, [opener]]
      end
    }
  end

  def round_trip(session)
    expect(session).to have_title('b', wait: 20)
    popup = session.windows.find {|w| session.within_window(w) { session.title } == 'pop' }
    session.within_window(popup) do
      session.execute_script('ask()')
      poll_until(timeout: 10) { session.evaluate_script('window.R') }
    end
  end

  it "answers a pop-up's dedicated worker at the pop-up's time" do
    s = simulated_session(app(<<~JS))
      const w = new Worker(URL.createObjectURL(new Blob(["onmessage = () => postMessage(Date.now());"], { type: 'text/javascript' })));
      window.ask = () => { const done = timed(); w.onmessage = done; w.postMessage('ping'); };
    JS
    s.visit '/'
    trip, ahead = round_trip(s)
    expect([trip, ahead.abs]).to all(be < 100)
  end

  it 'answers a pop-up from the service worker that controls it and the page' do
    s = simulated_session(app(<<~JS, "navigator.serviceWorker.register('/sw.js');"))
      window.ask = () => {
        const done = timed();
        navigator.serviceWorker.onmessage = done;
        navigator.serviceWorker.ready.then((r) => r.active.postMessage('ping'));
      };
    JS
    s.visit '/'
    trip, ahead = round_trip(s)
    expect([trip, ahead.abs]).to all(be < 100)
  end

  it 'answers a pop-up from the shared worker it shares with the page' do
    s = simulated_session(app(<<~JS, "window.sw = new SharedWorker('/shared.js'); sw.port.start();"))
      const w = new SharedWorker('/shared.js');
      window.ask = () => { const done = timed(); w.port.onmessage = done; w.port.postMessage('ping'); };
    JS
    s.visit '/'
    trip, ahead = round_trip(s)
    expect([trip, ahead.abs]).to all(be < 100)
  end
end
