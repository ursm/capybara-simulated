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
    got = s.evaluate_script('[typeof Date(), Date.name, Date.length, Date.prototype.constructor === Date, new Date() instanceof Date, new Date().getFullYear(), Object.keys(Date).length]')
    expect(got).to eq(['string', 'Date', 7, true, true, later.year, 0])
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
  # reads a small `performance.now()`, and a frame's is its own, its `Date` the page's.
  it 'begins performance.now() at the document, a frame at its own' do
    s = blank_session
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.createElement('iframe');
      f.onload = () => done([performance.now(), f.contentWindow.performance.now(), f.contentWindow.Date.now() - Date.now()]);
      document.body.append(f);
    JS
    expect(got[0]).to be_between(0, 1000)
    expect(got[1]).to be_between(0, got[0])
    expect(got[2].abs).to be <= 1
  end

  # A session's `Date` never goes back across a navigation: the next document's time origin is the last one's `Date`
  # where that ran ahead of the wall clock — its virtual clock fast-forwarded to a timer, its scripts' time beside it.
  it 'goes on across a navigation' do
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body>#{env['PATH_INFO']}"]] })
    s.visit '/a'
    s.execute_script('window.r = null; setTimeout(() => { r = 1; }, 1500)')
    poll_until(timeout: 20) { s.evaluate_script('r') }
    last = s.evaluate_script('(() => { const a = Date.now(); while (Date.now() - a < 300); return Date.now(); })()')
    s.execute_script("location.href = '/b'")
    poll_until { s.has_text?('/b', wait: 0) }
    expect(s.evaluate_script('Date.now()')).to be >= last
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
end
