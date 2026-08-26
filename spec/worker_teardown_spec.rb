require 'capybara/simulated'
require_relative 'support/session_teardown'

# Stopping a worker that is INSIDE a call.
#
# `Thread#kill` cannot do it. A kill that lands while the thread is in V8 running JavaScript is not
# delivered until that call returns, and a kill that lands inside a HOST FUNCTION does not kill the
# thread at all — it surfaces as `Error: Fatal` from the call in flight and the thread runs on, with
# CRuby already treating it as killed so a second kill is a no-op (rusty_racer 0.2.3's contract).
#
# So the session boundary asks twice: a flag the worker's own loop reads before it commits to
# another long call, and `Isolate#terminate` for the call already running — re-asked for one grace
# period, because terminate only bites while the isolate is actually executing.
#
# Measured before this: a worker inside a 400 ms spin on a repeating timer made `reset!` take 4.0 s
# every time, because one `drain_timers` call overruns its 50 ms budget by seconds (the budget is
# checked BETWEEN timer callbacks). After: 0.0-0.01 s, 20 runs out of 20.
#
# Whether a given example catches a REVERT depends on whether its worker happens to be inside a
# call at that instant, so the examples below are a guard as a SET rather than one at a time —
# reverted, the file fails every run (1-2 of the 3), and each covers a different door: `reset!`
# (the session boundary) and `Worker#terminate()`. A spin long enough to make each one
# deterministic on its own would be a spin every green run has to wait out at `visit`.
RSpec.describe 'worker teardown' do
  def spinning_worker_page
    <<~HTML
      <!DOCTYPE html><html><body><script>
        const src = 'setInterval(() => { const end = Date.now() + 400; while (Date.now() < end) {} }, 5);';
        const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
        window.__spun = true;
      </script></body></html>
    HTML
  end

  def elapsed
    t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    yield
    Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0
  end

  # The worker threads THIS example started. Scoped by difference, not by a global count of
  # `[:csim_worker_handle]` threads: other sessions in this process legitimately hold parked
  # workers of their own, and counting those made the assertion depend on the file order.
  def worker_threads_since(before)
    (Thread.list - before).select {|t| t[:csim_worker_handle] }
  end

  it 'does not wait on a worker that is busy in JS' do
    page = spinning_worker_page
    before = Thread.list
    s = simulated_session(lambda {|_env| [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(s.evaluate_script('window.__spun')).to be true
    mine = worker_threads_since(before)
    # Generous against the 4.0 s this used to take, and against a loaded CI box: what it must not
    # do is wait for the worker's own JavaScript to finish.
    expect(elapsed { s.driver.reset! }).to be < 2
    # …and its thread is actually gone, not left running into the next example.
    expect(mine.select(&:alive?)).to be_empty
  end

  it 'terminates a busy worker on request, without waiting for it either' do
    # The OTHER half of the escalation: `Worker#terminate()` → `worker_terminate`, which the
    # reset path does not go through. Same hazard — the worker is inside a call, so neither its
    # inbox nor a kill can reach it — and the same answer.
    page = <<~HTML
      <!DOCTYPE html><html><body><script>
        const src = 'setInterval(() => { const end = Date.now() + 400; while (Date.now() < end) {} }, 5);';
        window.__w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
        window.__spun = true;
      </script></body></html>
    HTML
    before = Thread.list
    s = simulated_session(lambda {|_env| [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(s.evaluate_script('window.__spun')).to be true
    mine = worker_threads_since(before)
    expect(elapsed { s.evaluate_script('window.__w.terminate()') }).to be < 2
    expect(mine.select(&:alive?)).to be_empty
  end

  it 'still stops an idle worker cleanly' do
    page = <<~HTML
      <!DOCTYPE html><html><body><script>
        const src = 'onmessage = (e) => postMessage(e.data + "!");';
        const w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
        w.onmessage = (e) => { document.body.appendChild(document.createTextNode(e.data)) };
        w.postMessage('hi');
      </script></body></html>
    HTML
    before = Thread.list
    s = simulated_session(lambda {|_env| [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    # …through the DOM, so Capybara waits for the round trip rather than reading before it lands.
    expect(s).to have_text('hi!')
    mine = worker_threads_since(before)
    expect(elapsed { s.driver.reset! }).to be < 2
    expect(mine.select(&:alive?)).to be_empty
  end
end
