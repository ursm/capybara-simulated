# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A page of a host whose clock is moved (a test's `travel_to`) reads that clock through `Date` — a Date as ECMA-262 has
# it all the same: called as a function, the string of now; constructed with no argument, now; its `name`, `length` and
# `prototype.constructor` the constructor's own.
RSpec.describe 'the virtual clock’s Date' do
  def blank_session
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    s
  end

  it 'is a Date as ECMA-262 has it' do
    later = Time.now + 86_400 * 400
    allow(Time).to receive(:now).and_return(later)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      [typeof Date(), Date.name, Date.length, Date.prototype.constructor === Date, new Date() instanceof Date,
       new Date().getFullYear(), Object.keys(Date).length, Function.prototype.toString.call(Date).includes('[native code]'),
       Object.getPrototypeOf(Date) === Function.prototype, typeof Date.UTC, new (class extends Date {})(0).getTime()]
    JS
    expect(got).to eq(['string', 'Date', 7, true, true, later.year, 0, true, true, 'function', 0])
  end

  # `Date` and `performance.now()` read the virtual clock the timers run on, and beside it only the time the page's
  # scripts ran for (agent_clock.rs) — not the real time between the host's polls as well, which the virtual clock
  # already stands for: a page polled at rest ran both at twice its timers' pace, a `setTimeout(…, 3000)` reading 5,400
  # ms of `performance.now()`.
  it 'runs at the pace of the timers on a page at rest' do
    s = blank_session
    s.execute_script(<<~JS)
      window.r = null;
      const t0 = performance.now(), d0 = Date.now();
      setTimeout(() => { r = [performance.now() - t0, Date.now() - d0]; }, 3000);
    JS
    r = poll_until(timeout: 20) {
      sleep 0.25
      s.evaluate_script('r')
    }
    expect(r[0]).to be_between(3000, 3050)
    expect(r[1]).to be_between(2999, 3050)
  end

  # …and a test's `sleep` passes for a page with nothing to run as well: no wall clock beside the virtual one shows it.
  it 'shows the time a test sleeps on an idle page' do
    s = blank_session
    s.execute_script('window.d0 = Date.now(); window.p0 = performance.now()')
    sleep 0.5
    got = s.evaluate_script('[Date.now() - d0, performance.now() - p0]')
    expect(got[0]).to be_between(500, 550)
    expect(got[1]).to be_between(500, 550)
  end

  # HR-Time §4 "coarsen time": a DOMHighResTimeStamp to 100 microseconds where the realm is not cross-origin isolated —
  # finer than the millisecond `Date` keeps, so a frame's delta or a benchmark's loop measures something — and a script
  # that spins on the clock sees it move, as no event loop step does inside one.
  it 'reads performance.now() to 100 microseconds, and moves it inside a script' do
    s = blank_session
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = performance.now(), d = Date.now();
        const seen = new Set();
        while (seen.size < 50 && performance.now() - a < 1000) seen.add(performance.now());
        const grid = [...seen].every((t) => Math.abs(t * 10 - Math.round(t * 10)) < 1e-6);
        return [[...seen].some((t) => !Number.isInteger(t)), grid, Number.isInteger(Date.now()), Math.abs(performance.timeOrigin + performance.now() - Date.now()) < 1, Date.now() >= d];
      })()
    JS
    expect(got).to eq([true, true, true, true, true])
  end

  # The time origin is the document's, not the moment the driver's script bundle was built: a page that has just loaded
  # reads a small `performance.now()`, and a frame's is its own, its `Date` the page's. (…a frame's no more than a frame's
  # interval past the page's, its scripts' time beside it: its event loop's clock, which its own steps move after the
  # page's, may stand that far ahead of the page's)
  it 'begins performance.now() at the document, a frame at its own' do
    s = blank_session
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.createElement('iframe');
      f.onload = () => done([performance.now(), f.contentWindow.performance.now(), f.contentWindow.Date.now() - Date.now()]);
      document.body.append(f);
    JS
    expect(got[0]).to be_between(0, 1000)
    expect(got[1]).to be_between(0, got[0] + 50)
    expect(got[2]).to be_between(-1, 50)
  end

  # Each document's `Date` begins at the wall clock, as its server's `Time.now` does — not where the last document's had
  # gone on to, however far its virtual clock ran ahead of real time: a page reading 30 s ahead of its server misreads
  # every "x minutes ago" and every expiry it is sent. (A document's `performance.now()` restarts at 0 anyway.)
  it "begins each document's Date at the wall clock" do
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body>#{env['PATH_INFO']}"]] })
    s.visit '/a'
    s.execute_script('window.r = null; setTimeout(() => { r = 1; }, 30000)')
    poll_until(timeout: 20) { s.evaluate_script('r') }
    s.execute_script("location.href = '/b'")
    poll_until { s.has_text?('/b', wait: 0) }
    expect(s.evaluate_script('Date.now()') - (Time.now.to_f * 1000)).to be_between(-1000, 1000)
  end

  # A parser-blocking script whose fetch the server took a second over — a `sleep` the host's clock moves by — reads
  # that second once: the virtual clock shows it, and the real time its script waited for it is none of its own.
  it 'shows the time a parser-blocking fetch took once' do
    s = simulated_session(->(env) {
      if env['PATH_INFO'] == '/slow.js'
        sleep 1
        [200, {'content-type' => 'text/javascript'}, ['window.ran = performance.now();']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><script src="/slow.js"></script>']]
      end
    })
    s.visit '/'
    expect(s.evaluate_script('window.ran')).to be_between(1000, 1200)
  end

  # A script turn runs to the end of its microtask checkpoint: work after an `await` in it is the turn's time, which a
  # read after it shows — not closed at the first microtask after the read (Chrome: 67.7 for 66 ms of work).
  it 'shows the work after an await in the same turn' do
    s = blank_session
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const work = () => { const e = performance.now() + 30; let x = 0; while (performance.now() < e) x++; return x; };
      setTimeout(async () => {
        const t0 = performance.now();
        await null;
        const w0 = __dom.nowNanos(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i);
        const wall = (__dom.nowNanos() - w0) / 1e6;
        done([performance.now() - t0, wall, x > 0, typeof work]);
      }, 0);
    JS
    expect(got[0]).to be >= got[1] - 1
  end

  # The window realms of one agent read one clock: a frame's `Date` is its parent's, though its event loop's steps run
  # after the parent's tasks (it read 100 behind inside them, 400 after a navigation of it; Chrome: 0).
  it "reads a frame's Date as its parent's" do
    s = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/f' ? 'f' : '<iframe src="/f"></iframe>'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body>#{body}"]]
    })
    s.visit '/'
    poll_until { s.evaluate_script("document.querySelector('iframe').contentDocument?.body?.textContent == 'f'") }
    s.execute_script(<<~JS)
      window.got = [];
      const fw = document.querySelector('iframe').contentWindow;
      const tick = () => { got.push(Date.now() - fw.Date.now()); if (got.length < 3) setTimeout(tick, 1000); };
      setTimeout(tick, 1000);
    JS
    # (…to the millisecond each `Date` is whole in, read a few microseconds apart)
    got = poll_until(timeout: 20) { s.evaluate_script('got.length == 3 && got') }
    expect(got.map(&:abs).max).to be <= 2
  end

  # …and on that one clock a frame's timer falls due: one its parent's task sets in it, at whatever offset in the
  # parent's step, runs its timeout after on the frame's `Date` and `performance.now()` alike, never before (HTML timer
  # initialization) — the frame scheduled on its own clock a step behind the parent's while reading the parent's, and a
  # `setTimeout(…, 50)` ran at once (Chrome: 50.2, 100.2, 250.4).
  it "runs a timer a parent's task sets in its frame after its timeout" do
    s = simulated_session(lambda {|env|
      if env['PATH_INFO'] == '/f'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><script>window.go = (ms, cb) => { const p0 = performance.now(), d0 = Date.now(); setTimeout(() => cb([ms, performance.now() - p0, Date.now() - d0]), ms); };</script>']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><iframe src="/f"></iframe>']]
      end
    })
    s.visit '/'
    poll_until { s.evaluate_script("typeof document.querySelector('iframe').contentWindow.go == 'function'") }
    s.execute_script(<<~JS)
      window.got = [];
      const fw = document.querySelector('iframe').contentWindow;
      const cases = [1, 4, 10, 16, 50, 100, 250];
      let i = 0;
      const next = () => {
        if (i >= cases.length) return;
        const ms = cases[i++];
        setTimeout(() => fw.go(ms, (r) => { got.push(r); next(); }), (37 * i) % 90);
      };
      next();
    JS
    got = poll_until(timeout: 30) { s.evaluate_script('got.length == 7 && got') }
    got.each do |ms, perf, date|
      expect(perf).to be >= ms - 0.1
      expect(date).to be >= ms - 1
      expect(perf).to be < ms + 20
    end
  end
end
