# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A script's fetch is made in the event loop's order and lands as far after it began as its server took (script_fetch.rs):
# the Set-Cookie of its response is stored as it lands — Fetch processes its headers as its response comes in — so a script
# that runs before then reads none of it, whatever real time the server spent working (Chrome and Firefox: `inl:` empty,
# the script's own read `s=1`).
RSpec.describe 'a script fetch and cookies' do
  def log_with(busy_ms)
    app = ->(env) {
      if env['PATH_INFO'] == '/sc.js'
        t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        nil while Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0 < busy_ms / 1000.0
        next [200, {'content-type' => 'text/javascript', 'set-cookie' => 's=1; path=/'}, ['R.push("sc:" + document.cookie)']]
      end
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>t</title><script async src="/sc.js"></script><script>window.R = ["inl:" + document.cookie]</script>']]
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script('R.join(" ")')
  end

  # …each redirect hop's stored as its response comes, which the next hop's request carries (Fetch "HTTP-redirect fetch"),
  # the last one's as the script lands.
  it "sends a redirect hop's cookie with the next hop of an `async` script's fetch" do
    app = ->(env) {
      case env['PATH_INFO']
      when '/r' then [302, {'location' => '/sc.js', 'set-cookie' => 'hop=1; path=/'}, []]
      when '/sc.js' then [200, {'content-type' => 'text/javascript', 'set-cookie' => 'last=1; path=/'}, ["R.push('sent:' + #{'%p'} + ' doc:' + document.cookie)".sub('%p', (env['HTTP_COOKIE'] || '').inspect)]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>t</title><script async src="/r"></script><script>window.R = ["inl:" + document.cookie]</script>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('R.join(" ")')).to eq('inl: sent:hop=1 doc:hop=1; last=1')
  end

  # …and the requests made in the order the fetches began, each Cookie header the jar's then (Chrome and Firefox,
  # rv-r13-probe `r3_ck5`, `r3_ck3`): no `async` script's request carries a cookie an earlier one's response set, nor one a
  # deferred script's redirect set, which "the end" waits on first.
  def log_of(markup)
    app = ->(env) {
      if (m = env['PATH_INFO'].match(%r{\A/(ck|echo|rd)/(\w+)\.js\z}))
        kind, name = m[1], m[2]
        next [302, {'location' => "/echo/#{name}x.js", 'set-cookie' => "rd#{name}=1; path=/"}, []] if kind == 'rd'
        headers = {'content-type' => 'text/javascript'}
        headers['set-cookie'] = "#{name}=1; path=/" if kind == 'ck'
        next [200, headers, [kind == 'ck' ? "R.push('#{name}:' + document.cookie)" : "R.push('#{name}<' + #{(env['HTTP_COOKIE'] || '').inspect} + '>')"]]
      end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><title>t</title><script>window.R = []</script>#{markup}"]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(R.join(" ")), 50)')
  end

  it 'makes the requests of `async` scripts in the order their fetches began' do
    expect(log_of('<script async src="/echo/e1.js"></script><script async src="/ck/c.js"></script><script async src="/echo/e2.js"></script>')).to eq('e1<> c:c=1 e2<>')
  end

  it "makes an `async` script's request ahead of a deferred one's after it" do
    expect(log_of('<script async src="/echo/e1.js"></script><script defer src="/rd/r.js"></script>')).to eq('e1<> rx<rdr=1>')
  end

  [0, 150].each do |busy|
    it "stores an `async` script's cookie as it lands, its server busy #{busy} ms" do
      expect(log_with(busy)).to eq('inl: sc:s=1')
    end
  end

  # …a parser-blocking script's too: its fetch begun as it is prepared, in parallel, a timer the parser's wait runs as its
  # server takes its time reads none of it (Chrome and Firefox `t50: b:b=1 inl:b=1`, csim-bench theend5 `t5_ckblk`).
  it "stores a parser-blocking script's cookie as it lands, not as its server works" do
    app = ->(env) {
      if env['PATH_INFO'] == '/b.js'
        sleep 0.15
        next [200, {'content-type' => 'text/javascript', 'set-cookie' => 'b=1; path=/'}, ['R.push("b:" + document.cookie)']]
      end
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>t</title><script>window.R = []; setTimeout(() => R.push("t50:" + document.cookie), 50)</script><script src="/b.js"></script><script>R.push("inl:" + document.cookie)</script>']]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('R.join(" ")')).to eq('t50: b:b=1 inl:b=1')
  end

  # …and none of a fetch the parser's wait gave up: a `stop()` in a timer its wait ran cancels it before its response is in
  # (Chrome and Firefox `stop: t300:`, rv-end-probe `a11_stop_cookie`).
  it "stores no cookie of a parser-blocking script whose fetch a `stop()` cancelled" do
    app = ->(env) {
      if env['PATH_INFO'] == '/b.js'
        sleep 0.15
        next [200, {'content-type' => 'text/javascript', 'set-cookie' => 'b=1; path=/'}, ['R.push("ran")']]
      end
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>t</title><script>window.R = []; setTimeout(() => { stop(); R.push("stop:" + document.cookie) }, 20); setTimeout(() => R.push("t300:" + document.cookie), 300)</script><script src="/b.js"></script>']]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(R.join(" ")), 400)')).to eq('stop: t300:')
  end
end
