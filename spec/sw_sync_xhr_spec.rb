# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/engine_global'

# Handle Fetch applies to a controlled client's every request, a synchronous one's too: Fetch's "HTTP fetch" asks the
# service worker whatever the caller waits on — XHR's synchronous flag only makes `send()` wait for the response. So a
# controlled page's sync XHR and a controlled dedicated worker's are its service worker's to answer, as their async XHR,
# fetch() and importScripts() are. Firefox answers all of them from the worker; Chrome all but the page's sync XHR
# (measured 2026-11-02, Chrome 156 / Firefox 159) — a Blink departure from Fetch, which the spec outranks.
RSpec.describe 'a controlled client’s synchronous XHR', engine_global: true do
  include PollUntil

  let(:app) {
    sw = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        const tag = new URL(e.request.url).searchParams.get('tag');
        if (!tag) return;
        if (tag === 'imp') return e.respondWith(new Response('self.imp = "sw"', { headers: { 'content-type': 'text/javascript' } }));
        if (tag === 'stream-error') {
          return e.respondWith(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([104])); c.error(new Error('x')); } })));
        }
        if (tag === 'redirect') return e.respondWith(Response.redirect('/data.txt?tag=after', 302));
        if (tag === 'net') return;
        if (tag === 'slow') {
          setTimeout(() => self.clients.get(e.clientId).then((c) => c.postMessage('from-sw')), 100);
          return e.respondWith(new Promise((res) => setTimeout(() => res(new Response('sw-slow')), Number(new URL(e.request.url).searchParams.get('ms')))));
        }
        if (tag === 'hops') {
          const n = Number(new URL(e.request.url).searchParams.get('n'));
          return e.respondWith(new Promise((res) => setTimeout(() => res(n > 0 ? Response.redirect(`/data.txt?tag=hops&n=${n - 1}`, 302) : new Response('hopped')), 80)));
        }
        if (tag === 'wait-page') {
          // (…an answer only the page can give, which it cannot while its send() waits: a deadlock)
          return e.respondWith(self.clients.get(e.clientId).then((c) => {
            c.postMessage('ping');
            return new Promise((res) => { self.pong = () => res(new Response('unblocked')); });
          }));
        }
        e.respondWith(new Response(`sw:${tag}:${e.request.mode}:${e.clientId ? 'client' : 'none'}`));
      });
    JS
    worker = <<~JS
      function xhr(url, async) {
        return new Promise((res) => {
          const x = new XMLHttpRequest();
          x.open('GET', url, async);
          if (async) { x.onload = () => res(x.responseText); x.onerror = () => res('error'); x.send(); return; }
          try { x.send(); res(x.responseText); } catch (e) { res(e.name); }
        });
      }
      (async () => {
        const out = [];
        out.push(await xhr('/data.txt?tag=w-sync', false));
        out.push(await xhr('/data.txt?tag=w-async', true));
        out.push(await fetch('/data.txt?tag=w-fetch').then((r) => r.text()));
        importScripts('/imp.js?tag=imp');
        out.push(self.imp);
        out.push(await xhr('/data.txt?tag=redirect', false));
        out.push(await xhr('/data.txt?tag=net', false));
        out.push(await xhr('/data.txt?tag=stream-error', false));
        postMessage(out);
      })();
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js'     then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/worker.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/imp.js'    then [200, {'content-type' => 'text/javascript'}, ['self.imp = "network"']]
      when '/data.txt'  then [200, {'content-type' => 'text/plain'}, ['network']]
      when '/delayed.txt'
        # (…a server that takes real time, and a modeled delay of its own: X-Csim-Server-Delay-Ms, a time.sleep's)
        sleep 0.03
        [200, {'content-type' => 'text/plain', 'x-csim-server-delay-ms' => '95'}, ['delayed']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  def controlled_session
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.controlled = false;
      navigator.serviceWorker.register('/sw.js').then(() => {
        if (navigator.serviceWorker.controller) window.controlled = true;
        else navigator.serviceWorker.addEventListener('controllerchange', () => { window.controlled = true; });
      });
    JS
    poll_until { session.evaluate_script('window.controlled') }
    session
  end

  it 'is answered by the service worker from a page' do
    session = controlled_session
    got = session.evaluate_script(<<~JS)
      ['sync', 'redirect', 'net', 'stream-error'].map((tag) => {
        const x = new XMLHttpRequest();
        x.open('GET', `/data.txt?tag=${tag}`, false);
        try { x.send(); } catch (e) { return e.name; }
        return `${x.responseText}${x.responseURL.endsWith('tag=after') ? ' (redirected)' : ''}`;
      })
    JS
    expect(got).to eq(['sw:sync:cors:client', 'sw:after:cors:client (redirected)', 'network', 'NetworkError'])
  end

  # Synchronous for the script that sent it, not a turn of the event loop: the page's microtasks, and a message the worker
  # posted while it answered, run after the script that called send() — and the answer is waited for however long the
  # worker takes, the request never made again on the network behind it.
  it "runs nothing of the page's inside send(), and waits out a slow answer" do
    session = controlled_session
    session.execute_script(<<~JS)
      window.log = [];
      navigator.serviceWorker.onmessage = (e) => log.push(`message ${e.data}`);
      Promise.resolve().then(() => log.push('microtask'));
      for (const ms of [300, 1500]) {
        const x = new XMLHttpRequest();
        x.open('GET', `/data.txt?tag=slow&ms=${ms}`, false);
        x.send();
        log.push(x.responseText);
      }
    JS
    expect(poll_until { l = session.evaluate_script('log'); l.size == 5 && l }).to eq(['sw-slow', 'sw-slow', 'microtask', 'message from-sw', 'message from-sw'])
  end

  # The wait is the worker's own time, nothing of the page's running meanwhile: a 15 s timer of its answers at once in
  # real time, the page's clock on by those 15 s — not paced on the wall clock, the page then following a doubled one —
  # and a second window's clock moved by that time too, never to the host window's.
  it "waits the worker's own time, the waiting window's clock moved by it" do
    session = controlled_session
    sync = <<~JS
      (() => {
        const v0 = RustyRacer.steps.virtualNow(), x = new XMLHttpRequest();
        x.open('GET', '/data.txt?tag=slow&ms=15000', false);
        x.send();
        return [x.responseText, Math.round(RustyRacer.steps.virtualNow() - v0)];
      })()
    JS
    t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    expect(session.evaluate_script(sync)).to eq(['sw-slow', 15_000])
    expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - t).to be < 5
    session.execute_script('window.later = false; setTimeout(() => { window.later = true; }, 20000)')
    poll_until { session.evaluate_script('window.later') }
    session.within_window(session.open_new_window) do
      session.visit '/'
      poll_until { session.evaluate_script('!!navigator.serviceWorker.controller') }
      expect(session.evaluate_script(sync)).to eq(['sw-slow', 15_000])
    end
  end

  # A worker that waits on the page — a deadlock, the page's send() holding what it waits for — can answer nothing: the
  # request is a network error at once (Chrome 156 sends no page's sync XHR to its worker; Firefox 159 runs the page's
  # events inside send(), where XHR's "pause" lets none run — measured 2026-11-02).
  it 'fails at once a request its worker can only answer with what the waiting page gives it' do
    session = controlled_session
    session.execute_script("navigator.serviceWorker.onmessage = (e) => { window.pinged = e.data; navigator.serviceWorker.controller.postMessage('pong'); }")
    t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    got = session.evaluate_script(<<~JS)
      (() => {
        const x = new XMLHttpRequest();
        x.open('GET', '/data.txt?tag=wait-page', false);
        try { x.send(); return x.responseText; } catch (e) { return e.name; }
      })()
    JS
    expect([got, Process.clock_gettime(Process::CLOCK_MONOTONIC) - t < 2]).to eq(['NetworkError', true])
  end

  # A worker's sync XHR keeps its `timeout`, one from send() for the whole fetch — every hop of a redirect chain the worker
  # answers — of the answering worker's time: a TimeoutError where the answer comes later. And the clock the waiting
  # worker's script reads (`performance.now()`) moves on by the time the answer took, as a waiting window's does —
  # neither less nor, the wall's share counted twice, more.
  it "times a worker's sync XHR out by its timeout, its clock moved by the wait" do
    session = controlled_session
    session.execute_script(<<~JS)
      window.got = null;
      const src = `const out = [];
        for (const [q, timeout] of [['slow&ms=300', 100], ['slow&ms=300', 500], ['hops&n=2', 100], ['hops&n=2', 500]]) {
          const x = new XMLHttpRequest();
          x.open('GET', '${location.origin}/data.txt?tag=' + q, false);
          x.timeout = timeout;
          const p0 = performance.now();
          try { x.send(); out.push(x.responseText); } catch (e) { out.push(e.name); }
          out.push(Math.round(performance.now() - p0));
        }
        // (…and its Date a time value still: an integer, as a new Date's is — the two a whole number of ms apart, the
        // clock free to tick between the reads)
        postMessage([out, Number.isInteger(Date.now()), Number.isInteger(new Date().getTime() - Date.now())]);`;
      new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))).onmessage = (e) => { window.got = e.data; };
    JS
    got, integral, consistent = poll_until { session.evaluate_script('window.got') }
    expect([integral, consistent]).to eq([true, true])
    expect(got.each_slice(2).map(&:first)).to eq(%w[TimeoutError sw-slow TimeoutError hopped])
    # (…about: the wall clock's share of the wait is real time, as long as the machine takes)
    got.each_slice(2).map(&:last).zip([100, 300, 100, 240]) {|ms, want| expect(ms).to be_within(40).of(want) }
  end

  # …judged on the model's time alone — the server's modeled delay, which the waiting script's clock moves by — never the
  # real time the app took to answer, which would time a request out by how fast this machine runs its server.
  it "times a worker's sync XHR out by the server's modeled delay, not the app's real time" do
    session = controlled_session
    session.execute_script(<<~JS)
      window.got = null;
      const src = `const out = [];
        for (const timeout of [100, 90]) {
          const x = new XMLHttpRequest();
          x.open('GET', '${location.origin}/delayed.txt', false);
          x.timeout = timeout;
          const v0 = RustyRacer.steps.virtualNow();
          try { x.send(); out.push(x.responseText, Math.round(RustyRacer.steps.virtualNow() - v0)); } catch (e) { out.push(e.name); }
        }
        postMessage(out);`;
      new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))).onmessage = (e) => { window.got = e.data; };
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq(['delayed', 95, 'TimeoutError'])
  end

  it 'is answered by the service worker from a dedicated worker, as its other requests are' do
    session = controlled_session
    session.execute_script(<<~JS)
      window.got = null;
      new Worker('/worker.js').onmessage = (e) => { window.got = e.data; };
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq(
      [
        'sw:w-sync:cors:client',
        'sw:w-async:cors:client',
        'sw:w-fetch:cors:client',
        'sw',
        'sw:after:cors:client',
        'network',
        'NetworkError'
      ]
    )
  end
end
