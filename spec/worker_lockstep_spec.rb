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

  # (…and a worker inside a long call — ~300 ms of CPU a message — waited for, its own `Date.now()` moving on: only one
  # that leaves a tick unanswered a round-trip budget (an endless loop) runs on its own, out of the lockstep. What it
  # posts after a long call carries its time, 300 ms on, and lands on the page then, after the page's timers due before
  # it (timers.js `atItsTime`): its interval's ticks heard as late as its calls held them up, its echoes 300 ms after
  # each post — no longer as if its calls took no time.)
  it "hears a worker busy in a long call at its times" do
    session = simulated_session(lambda {|env|
      worker = "let i = 0; setInterval(() => postMessage('t' + i++), 100);" \
               'onmessage = (e) => { const end = Date.now() + 300; while (Date.now() < end) {} postMessage(`e${e.data}`); };'
      next [200, {'content-type' => 'text/javascript'}, [worker]] if env['PATH_INFO'] == '/w.js'

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset=utf-8><script>
        globalThis.log = []; let last = null, echoes = 0;
        const w = new Worker('/w.js');
        w.onmessage = (e) => { if (String(e.data)[0] === 'e') echoes++; else last = e.data; };
        [100, 400, 700].forEach((t) => setTimeout(() => w.postMessage(t), t));
        [250, 550, 1050, 2050, 4050].forEach((t) => setTimeout(() => log.push(`${t}:${last}:${echoes}`), t));
        </script>
      HTML
    })
    session.visit '/a'
    expect(poll_until(timeout: 20) { l = session.evaluate_script('log'); l.size == 5 && l }).to eq(%w[250:t0:0 550:t2:1 1050:t5:2 2050:t13:3 4050:t33:3])
  end

  # (…and what a service worker posts while the window waits on its answer in place — a frame's navigation it answers off
  # a 300 ms timer — heard after the page's timers due before it and before those due after, an unrelated worker's clock
  # no part of it)
  [false, true].each do |extra|
    it "orders a service worker's message posted while the window waited on it#{' beside another worker' if extra}" do
      sw = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));" \
           "self.addEventListener('fetch', e => { if (!e.request.url.includes('/slow')) return;" \
           "setTimeout(() => self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('m200'))), 200);" \
           "e.respondWith(new Promise(r => setTimeout(() => r(new Response('<p>ok', {headers: {'content-type': 'text/html'}})), 300))); });"
      page = <<~HTML
        <!doctype html><meta charset=utf-8><script>globalThis.log = []; navigator.serviceWorker.onmessage = (e) => log.push(e.data);</script>
        <button onclick="if (#{extra}) new Worker('/dw.js'); [50, 100, 400].forEach((t) => setTimeout(() => log.push('t' + t), t));
          setTimeout(() => { const f = document.createElement('iframe'); f.src = '/slow'; f.onload = () => log.push('frame'); document.body.append(f); }, 10)">b</button>
      HTML
      session = simulated_session(lambda {|env|
        next [200, {'content-type' => 'text/javascript'}, [sw]] if env['PATH_INFO'] == '/sw.js'
        next [200, {'content-type' => 'text/javascript'}, ['let i = 0; setInterval(() => postMessage(i++), 1000);']] if env['PATH_INFO'] == '/dw.js'

        [200, {'content-type' => 'text/html'}, [page]]
      })
      session.visit '/a'
      session.execute_script("navigator.serviceWorker.register('/sw.js')")
      poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
      session.visit '/a'
      session.click_button 'b'
      expect(poll_until { l = session.evaluate_script('log'); l.size == 5 && l }).to eq(%w[t50 t100 m200 frame t400])
    end
  end

  # (…and a dedicated worker's main script a service worker answers off a 300 ms timer, which the worker's own thread
  # waits on in place (Browser#await_worker_reply off the window's thread): the service worker's timers run at the
  # window's times all the same, what it posts meanwhile reaches the page at its time, nothing of the page's touched from
  # the worker's thread, and the worker, waiting, holds up no step of the window's)
  it "hears a worker whose main script a service worker answers late at its times" do
    sw = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));" \
         "self.addEventListener('fetch', e => { if (!e.request.url.endsWith('/w.js')) return;" \
         "setTimeout(() => self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('m100'))), 100);" \
         "e.respondWith(new Promise(r => setTimeout(() => r(new Response(\"postMessage('w')\", {headers: {'content-type': 'text/javascript'}})), 300))); });"
    page = <<~HTML
      <!doctype html><meta charset=utf-8><script>globalThis.log = []; navigator.serviceWorker.onmessage = (e) => log.push(e.data);</script>
      <button onclick="[50, 200, 500].forEach((t) => setTimeout(() => log.push('t' + t), t)); new Worker('/w.js').onmessage = (e) => log.push(e.data)">b</button>
    HTML
    session = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/javascript'}, [sw]] if env['PATH_INFO'] == '/sw.js'

      [200, {'content-type' => 'text/html'}, [page]]
    })
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    session.visit '/a'
    session.click_button 'b'
    expect(poll_until { l = session.evaluate_script('log'); l.size == 5 && l }).to eq(%w[t50 m100 t200 w t500])
  end

  # (…and its sync XHR, which the service worker answers off a 300 ms timer of its own: a request one worker waits on in
  # place is taken by the other at the time it was made, the window going no further meanwhile — so the timer starts
  # then, however late the service worker's thread gets to it on a loaded machine (Browser#worker_due_at, `:asked`))
  it "hears a worker whose sync XHR a service worker answers late at its time" do
    sw = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));" \
         "self.addEventListener('fetch', e => { const path = new URL(e.request.url).pathname;" \
         "if (path === '/w.js') { setTimeout(() => self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('m100'))), 100);" \
         "e.respondWith(new Response(\"const x = new XMLHttpRequest(); x.open('GET', '/x', false); x.send(); postMessage('w:' + x.responseText)\", {headers: {'content-type': 'text/javascript'}})); }" \
         "if (path === '/x') e.respondWith(new Promise(r => setTimeout(() => r(new Response('sw')), 300))); });"
    page = <<~HTML
      <!doctype html><meta charset=utf-8>
      <script>globalThis.log = []; const at = (l) => log.push(`${l}@${Math.round(__virtualNow() - t0)}`); navigator.serviceWorker.onmessage = (e) => at(e.data);</script>
      <button onclick="globalThis.t0 = __virtualNow(); [50, 200, 500, 900].forEach((t) => setTimeout(() => at('t' + t), t)); new Worker('/w.js').onmessage = (e) => at(e.data)">b</button>
    HTML
    session = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/javascript'}, [sw]] if env['PATH_INFO'] == '/sw.js'

      [200, {'content-type' => 'text/html'}, [page]]
    })
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    session.visit '/a'
    session.click_button 'b'
    expect(poll_until { l = session.evaluate_script('log'); l.size == 6 && l }).to eq(%w[t50@50 m100@112 t200@200 w:sw@304 t500@500 t900@900])
  end
end
