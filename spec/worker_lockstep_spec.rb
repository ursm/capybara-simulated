# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A worker's timers run on the window's virtual time (Browser#worker_due_within, `worker_now`): its clock starts where
# the window's stands as `new Worker()` runs, a window step stops at a worker's timer, the worker runs it at that time,
# the window goes on to the step's end (V8Runtime#run_loop_step) — so a page timer fires at its own virtual time however
# busy a worker's interval is, and what a worker posts on its interval reaches the page between the page's timers in the
# same order every run, however loaded the machine. (Virtual time read as the driver keeps it, `__virtualNow`: a page's
# `performance.now()` adds the real time the driver spent too — timers.js `platformDateNow`.)
RSpec.describe 'a worker beside a page timer, on one virtual time', :every_host_local do
  def fire_time(interval, delay)
    sw = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));" +
         (interval ? "setInterval(() => { self.n = (self.n || 0) + 1; }, #{interval});" : '')
    page = '<!doctype html><meta charset=utf-8><body>' \
           "<button onclick=\"const v0 = __virtualNow(); setTimeout(() => { const i = document.createElement('i'); i.id = 'done'; i.textContent = Math.round(__virtualNow() - v0); document.body.append(i); }, #{delay})\">b</button>"
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

  [nil, 0, 4, 16].each do |interval|
    [300, 3000].each do |delay|
      it "fires a #{delay} ms page timer at its time beside #{interval ? "a #{interval} ms service worker interval" : 'a service worker'}" do
        expect(fire_time(interval, delay)).to eq(delay)
      end
    end
  end

  # (…a dedicated and a shared worker's 100 ms intervals, each from the time it was made, read by the page's timers)
  it "hears a dedicated and a shared worker's interval at their times" do
    session = simulated_session(lambda {|env|
      interval = 'setInterval(() => (globalThis.out || self).postMessage(i++), 100);'
      next [200, {'content-type' => 'text/javascript'}, ["let i = 0; #{interval}"]] if env['PATH_INFO'] == '/w.js'
      next [200, {'content-type' => 'text/javascript'}, ["let i = 0; onconnect = (e) => { globalThis.out = e.ports[0]; #{interval} };"]] if env['PATH_INFO'] == '/s.js'

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset=utf-8><script>
        globalThis.log = []; let last = null, shared = null;
        new Worker('/w.js').onmessage = (e) => { last = e.data; };
        new SharedWorker('/s.js').port.onmessage = (e) => { shared = e.data; };
        [250, 550, 1050, 2050].forEach((t) => setTimeout(() => log.push(`${t}:${last}/${shared}`), t));
        </script>
      HTML
    })
    session.visit '/a'
    expect(poll_until { l = session.evaluate_script('log'); l.size == 4 && l }).to eq(%w[250:1/1 550:4/4 1050:9/9 2050:19/19])
  end
end
