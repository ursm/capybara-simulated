# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A request a service worker answers is answered at the time its `fetch` event's work takes on the window's clock — one
# virtual time for the window's event loop and its workers' (Browser#worker_due_within) — and a timeout the client set
# on it (an AbortSignal's, an XHR's `timeout`) is judged on that clock too. The event is dispatched at the time the
# request was made, and a message a page posts to a worker is taken at the time it was posted: the window's step ends at
# the task that asked (timers.js `askedWorker`) and the worker runs to that time before the window goes on. Its answer,
# posted at a timer of the worker's, is delivered before the window goes past that time. A fetch() whose signal aborts
# while the worker works on it rejects as it aborts (Fetch's fetch() abort steps), not at the worker's next answer.
# Before, the worker's thread took the request whenever it got to it, the window's clock run on meanwhile — a
# fast-forward to the request's own timeout among it — and an answer due in 50 ms of a timeout of 100 came at 100, the
# request aborted, or by however much a loaded machine's scheduler made it: 141, 100, 1016.
# (…service workers are modeled only in a universal-server context)
RSpec.describe 'a request a service worker answers, on the clock', :every_host_local do
  include PollUntil

  let(:app) {
    sw = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        const u = new URL(e.request.url);
        if (u.searchParams.has('spin')) {
          const a = Date.now();
          while (Date.now() - a < Number(u.searchParams.get('spin')));
          return;
        }
        if (u.searchParams.has('date')) return e.respondWith(new Response(String(Date.now())));
        if (!u.searchParams.has('ms')) return;
        const ms = Number(u.searchParams.get('ms')), hops = Number(u.searchParams.get('hops') || 0);
        const answer = () => hops > 0 ? Response.redirect(`/d.txt?ms=${ms}&hops=${hops - 1}`, 302) : new Response('sw');
        e.respondWith(new Promise((res) => setTimeout(() => res(answer()), ms)));
      });
    JS
    worker = <<~JS
      onmessage = (e) => {
        const [query, timeout] = e.data;
        const x = new XMLHttpRequest();
        x.open('GET', '/d.txt?' + query);
        x.timeout = timeout;
        const t0 = performance.now(), v0 = __virtualNow();
        x.onload = () => postMessage(['load', performance.now() - t0, __virtualNow() - v0]);
        x.ontimeout = () => postMessage(['timeout', performance.now() - t0, __virtualNow() - v0]);
        x.send();
      };
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/w.js'  then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/d.txt' then [200, {'content-type' => 'text/plain'}, ['network']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  def controlled_session
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.controlled = false;
      navigator.serviceWorker.register('/sw.js').then(() => {
        if (navigator.serviceWorker.controller) controlled = true;
        else navigator.serviceWorker.oncontrollerchange = () => { controlled = true; };
      });
    JS
    poll_until { s.evaluate_script('controlled') }
    s
  end

  # (…the outcome, and the time it took on the page's clock and on the virtual clock alone, of a fetch() and an XHR made
  # in the same task)
  def page_requests(s, query, timeout)
    s.execute_script(<<~JS)
      window.got = {};
      const t0 = performance.now(), v0 = __virtualNow();
      fetch('/d.txt?#{query}', { signal: AbortSignal.timeout(#{timeout}) }).then((r) => r.text()).then(
        (t) => { got.fetch = [t, performance.now() - t0, __virtualNow() - v0]; },
        (e) => { got.fetch = [e.name, performance.now() - t0, __virtualNow() - v0]; });
      const x = new XMLHttpRequest();
      x.open('GET', '/d.txt?#{query}');
      x.timeout = #{timeout};
      x.onload = () => { got.xhr = [x.responseText, performance.now() - t0, __virtualNow() - v0]; };
      x.ontimeout = () => { got.xhr = ['timeout', performance.now() - t0, __virtualNow() - v0]; };
      x.send();
    JS
    poll_until(timeout: 20) { s.evaluate_script('got.fetch && got.xhr ? got : null') }
  end

  # (…`got` came `at` ms of the virtual clock after the request — exactly, however loaded the machine — and as long or
  # longer on `performance.now()`, which shows the time the scripts ran for beside it — the page's and the worker's that
  # answered, which its answer carries — hundreds of milliseconds of it on a machine under 64 CPU burners)
  def expect_at(got, at, what)
    expect(got[2]).to be_between(at, at + 1), "#{what}: #{got.inspect}"
    expect(got[1]).to be_between(at, at + 300), "#{what}: #{got.inspect}"
  end

  it "resolves a page's fetch and XHR when the worker answers, before their timeout" do
    s = controlled_session
    {'ms=0' => 0, 'ms=50' => 50, 'ms=300' => 300, 'ms=1000' => 1000}.each do |query, ms|
      got = page_requests(s, query, ms + 50)
      expect(got['fetch'][0]).to eq('sw'), "#{query}: #{got.inspect}"
      expect_at(got['fetch'], ms, query)
      expect(got['xhr'][0]).to eq('sw'), "#{query}: #{got.inspect}"
      expect_at(got['xhr'], ms, query)
    end
  end

  it 'times a request out when the worker answers after its timeout' do
    s = controlled_session
    got = page_requests(s, 'ms=80&hops=2', 100)
    expect(got['fetch'][0]).to eq('TimeoutError')
    expect_at(got['fetch'], 100, 'fetch')
    expect(got['xhr'][0]).to eq('timeout')
    expect_at(got['xhr'], 100, 'xhr')
  end

  # A step that ends at a task that asked a worker something ends there for the window's frames too, and renders no frame
  # of its own: a frame's interval runs at the page's times, its clock with the page's, and animation frames come at
  # their 60 a second, however often the page posts.
  it "keeps a frame's timers and the animation frames to their times while the page posts to a worker" do
    s = simulated_session(->(env) {
      case env['PATH_INFO']
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ['onmessage = () => {};']]
      when '/f'    then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>f']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><iframe src="/f"></iframe>']]
      end
    })
    s.visit '/'
    poll_until { s.evaluate_script("document.querySelector('iframe').contentDocument.body?.textContent == 'f'") }
    s.execute_script(<<~JS)
      const w = new Worker('/w.js'), fw = frames[0];
      const p0 = __virtualNow(), f0 = fw.__virtualNow();
      fw.eval('window.ticks = 0; setInterval(() => ticks++, 100)');
      let rendered = 0;
      const frame = () => { rendered++; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      window.r = null;
      const iv = setInterval(() => w.postMessage(1), 4);
      setTimeout(() => { clearInterval(iv); r = [__virtualNow() - p0, fw.__virtualNow() - f0, fw.ticks, rendered]; }, 1000);
    JS
    r = poll_until(timeout: 30) {
      sleep 0.05
      s.evaluate_script('r')
    }
    expect(r[0]).to eq(1000)
    expect(r[1]).to be_between(980, 1000)
    expect(r[2]).to be_between(9, 10)
    expect(r[3]).to be_between(58, 62)
  end

  # An answer comes at the time the worker gave it — its clock's, its scripts' time among it: a fetch event that spins
  # 2 s on `Date.now()` before it falls through is 2 s on the page's clock as the answer lands, however long the page
  # waited for it in real time — its lockstep wait bounded at 1 s, after which the worker ran on alone. (The page read
  # 1100.)
  it "lands an answer at the worker's time, its scripts' time among it" do
    s = controlled_session
    s.execute_script(<<~JS)
      window.got = null;
      const t0 = performance.now();
      fetch('/d.txt?spin=2000').then((r) => r.text()).then((t) => { got = [t, performance.now() - t0]; });
    JS
    got = poll_until(timeout: 20) { s.evaluate_script('got') }
    expect(got[0]).to eq('network')
    expect(got[1]).to be_between(2000, 2500)
  end

  # …once: the time the page waited for it with its clock held is that same time, which it does not add again — a 0 ms
  # timer set after the answer read 1001 in some runs and 0 in others (Chrome: 1).
  it 'lands a spinning answer once, the same every run' do
    s = controlled_session
    s.execute_script(<<~JS)
      window.got = null;
      const t0 = performance.now();
      fetch('/d.txt?spin=1000').then((r) => r.text()).then(() => {
        const t1 = performance.now();
        setTimeout(() => { got = [t1 - t0, performance.now() - t1]; }, 0);
      });
    JS
    got = poll_until(timeout: 20) { s.evaluate_script('got') }
    expect(got[0]).to be_between(1000, 1200)
    expect(got[1]).to be_between(0, 20)
  end

  # …and one it takes after another it was busy with, at the time it gave it: after that one's time too, not the time
  # the page asked it plus its own. Each `fetch` event is a task of the worker's one event loop (Handle Fetch), so the
  # second's 300 ms timer starts as the first's 500 ms spin ends — it landed ahead of T600, before.
  it 'lands an answer behind the request the worker was busy with' do
    s = controlled_session
    s.execute_script(<<~JS)
      window.log = [];
      const t0 = performance.now();
      const at = (what) => log.push([what, performance.now() - t0]);
      fetch('/d.txt?spin=500').then(() => at('spin'));
      fetch('/d.txt?ms=300').then(() => at('ms300'));
      for (const t of [600, 900]) setTimeout(() => at('T' + t), t);
    JS
    log = poll_until(timeout: 20) { l = s.evaluate_script('log'); l.size == 4 && l }
    expect(log.map(&:first)).to eq(%w[spin T600 ms300 T900])
    # (…the spin on whole milliseconds of `Date.now()`, as much as one short)
    expect(log[2][1]).to be_between(799, 900)
  end

  # …and the worker's clock on with the page's after it: a quick answer at once, the worker's `Date` the page's, however
  # long the page's clock stood held at the busy answer's time — the worker's ran on beneath it by every step of the
  # page's virtual clock, and a step further where its own scripts ran past the window's: its `Date` 32 ms ahead, before.
  it "keeps the worker's clock on the page's after a busy answer" do
    s = controlled_session
    s.execute_script(<<~JS)
      window.got = null;
      const quick = async () => {
        const d = Date.now(), v = __virtualNow();
        const sw = Number(await (await fetch('/d.txt?date')).text());
        return [sw - d, Date.now() - d, __virtualNow() - v];
      };
      (async () => {
        await fetch('/d.txt?spin=1000');
        const a = await quick();
        await new Promise((r) => setTimeout(r, 1500));
        got = [a, await quick()];
      })();
    JS
    got = poll_until(timeout: 20) { s.evaluate_script('got') }
    got.each do |sw, page, virtual|
      expect(sw).to be_between(-20, 20), got.inspect
      expect(page).to be_between(0, 20), got.inspect
      expect(virtual).to eq(0), got.inspect
    end
  end

  # …and on the asking window's clock, whichever window's clock the worker runs on: each window's `Date` is its own
  # virtual clock's, one that ran a 10 s timer chain 10 s from another's, and an answer carries the time it took, from
  # the asking window's own ask (sw-client.js `answeredAt`). The time it was given at, carried as it was, read 9.1 s for
  # a second window's quick answer after the first window's 10 s chain, its timers after it pushed out as far. (The
  # answer reads 0 run alone, and 101 after this file's other examples: delivered a 100 ms step on, as before.)
  it "lands an answer on the asking window's clock, not the worker's window's" do
    s = controlled_session
    s.execute_script('window.chained = false; let n = 0; const f = () => (++n < 20 ? setTimeout(f, 500) : (chained = true)); f();')
    poll_until(timeout: 20) { s.evaluate_script('chained') }
    expect(s.evaluate_script('Date.now()') - (Time.now.to_f * 1000)).to be > 5000
    s.switch_to_window(s.open_new_window)
    s.visit '/'
    poll_until { s.evaluate_script('!!navigator.serviceWorker.controller') }
    s.execute_script(<<~JS)
      window.got = null;
      const t0 = performance.now();
      fetch('/d.txt?date').then(() => {
        const fetched = performance.now() - t0;
        setTimeout(() => { got = [fetched, performance.now() - t0]; }, 100);
      });
    JS
    got = poll_until(timeout: 20) { s.evaluate_script('got') }
    expect(got[0]).to be_between(0, 150), got.inspect
    expect(got[1] - got[0]).to be_between(100, 150), got.inspect
  end

  it "resolves a dedicated worker's XHR when the service worker answers, before its timeout" do
    s = controlled_session
    s.execute_script("window.log = []; window.w = new Worker('/w.js'); w.onmessage = (e) => log.push(e.data)")
    cases = [
      ['ms=50', 100, 'load', 50],
      ['ms=2000', 100, 'timeout', 100],
      ['ms=80&hops=2', 100, 'timeout', 100],
      ['ms=80&hops=2', 500, 'load', 240]
    ]
    cases.each_with_index do |(query, timeout, outcome, at), i|
      s.execute_script("w.postMessage(#{[query, timeout].to_json})")
      poll_until(timeout: 20) { s.evaluate_script('log.length') > i }
      got = s.evaluate_script("log[#{i}]")
      expect(got[0]).to eq(outcome), "#{query} / #{timeout}: #{got.inspect}"
      expect_at(got, at, "#{query} / #{timeout}")
    end
  end
end
