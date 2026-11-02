# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# A service worker outlives the page that started it, and its clock follows the window's event loop on into the next
# page. The window's virtual clock runs on across the navigation, so the worker's timers keep their pace. The next
# page's `Date` begins again at the wall clock, behind where the last page's had run; the worker keeps its own `Date`
# and stamps its messages on the page's, so they land at the page's time.
#
# Before: the host read the next page's clock as 0 until its first step, the worker's clock went back with it, and its
# next tick moved it on by the whole session's time (an interval started 5 s in had ticked 50 times a second later, not
# 10). And a message of the worker's landed 4.8 s on the next page's `performance.now()`, lifted to the last page's
# `Date`. The page asks 10 ms after it loads and again at 1,000.
# (…service workers are modeled only in a universal-server context)
RSpec.describe 'a service worker across a navigation', :every_host_local do
  let(:app) {
    sw = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      let start = 0, ticks = 0;
      self.addEventListener('message', (e) => {
        if (e.data === 'start') { start = Date.now(); setInterval(() => ticks++, 100); return; }
        e.source.postMessage([ticks, Date.now() - start]);
      });
    JS
    first = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><title>a</title>
      <script>
        navigator.serviceWorker.register('/sw.js').then(async () => {
          const reg = await navigator.serviceWorker.ready;
          setTimeout(() => {
            reg.active.postMessage('start');
            setTimeout(() => { location.href = '/b'; }, 1000);
          }, 5000);
        });
      </script>
    HTML
    second = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><title>b</title><pre id="out"></pre>
      <script>
        const log = [];
        navigator.serviceWorker.onmessage = (e) => {
          log.push([...e.data, Math.round(performance.now())]);
          if (log.length === 2) { document.getElementById('out').textContent = JSON.stringify(log); document.title = 'done'; }
        };
        setTimeout(() => navigator.serviceWorker.controller.postMessage('q'), 10);
        setTimeout(() => navigator.serviceWorker.controller.postMessage('q'), 1000);
      </script>
    HTML
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/b' then [200, {'content-type' => 'text/html'}, [second]]
      else [200, {'content-type' => 'text/html'}, [first]]
      end
    }
  }

  it "keeps the worker's timers on the window's clock and lands its messages on the next page's" do
    s = simulated_session(app)
    s.visit '/'
    expect(s).to have_title('done', wait: 20)
    first, second = JSON.parse(s.find('#out', visible: :all).text(:all))
    expect(first[0]).to be_between(9, 11)
    expect(first[1]).to be_between(990, 1030)
    expect(first[2]).to be_between(10, 40)
    expect(second[0]).to be_between(19, 21)
    expect(second[2]).to be_between(1000, 1030)
  end
end
