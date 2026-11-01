# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A service worker's timers run on the window's virtual time (Browser#worker_due_within): a window step stops at a
# worker's timer, the worker runs it, the window goes on to the step's end (V8Runtime#run_loop_step) — so a page's timer
# fires at its own time however busy a worker's interval is, and the page's clock and its timer queue move together:
# when it would beside a worker with no timer at all (about the same virtual ms from the click, the action's own drain in
# it, which a poll's real-time cadence moves by a frame or a few).
RSpec.describe 'a service worker interval beside a page timer', :every_host_local do
  def fire_time(interval, delay)
    sw = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));" +
         (interval ? "setInterval(() => { self.n = (self.n || 0) + 1; }, #{interval});" : '')
    page = '<!doctype html><meta charset=utf-8><body>' \
           "<button onclick=\"const t0 = performance.now(); setTimeout(() => { const i = document.createElement('i'); i.id = 'done'; i.textContent = Math.round(performance.now() - t0); document.body.append(i); }, #{delay})\">b</button>"
    session = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/javascript'}, [sw]] if env['PATH_INFO'] == '/sw.js'

      [200, {'content-type' => 'text/html'}, [page]]
    })
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    session.visit '/a'
    session.click_button 'b'
    session.find('#done', wait: 10).text.to_i
  end

  [0, 4, 16].each do |interval|
    [300, 3000].each do |delay|
      it "lets a #{delay} ms page timer fire on time beside a #{interval} ms worker interval" do
        expect(fire_time(interval, delay)).to be_within(200).of(fire_time(nil, delay))
      end
    end
  end
end
