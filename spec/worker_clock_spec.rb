# frozen_string_literal: true

require 'capybara/simulated'
require 'cgi'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A worker's clock follows the window's (`Browser#run_worker`'s `worker_clock_step`): a timer it sets waits for the
# window's clock to reach it — not fired at once by the message's quiescence drive, not owed whatever the window moved
# before it was set (while the worker had no timer, or earlier in the step that posted the message), and not run ahead
# by a burst of messages that moved the window nowhere.
RSpec.describe 'Worker clock' do
  def page(worker_js, script = '')
    <<~HTML
      <!doctype html><meta charset="utf-8"><body><script>
      window.log = [];
      const w = new Worker(URL.createObjectURL(new Blob([#{worker_js.to_json}], {type: 'text/javascript'})));
      window.w = w;
      w.onmessage = (e) => window.log.push([e.data, performance.now()]);
      #{script}
      </script></body>
    HTML
  end

  def visit_page(worker_js, script = '')
    html    = page(worker_js, script)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit('/')
    poll_until { session.evaluate_script('window.log.length') >= 1 }
    session
  end

  # (…the window's clock from the post to the worker's message back)
  def waited(session)
    poll_until(timeout: 10) { session.evaluate_script('window.log.length') >= 2 }
    late, at = session.evaluate_script('window.log[1]')
    expect(late).to eq('late')
    at - session.evaluate_script('window.posted')
  end

  # The window moves on 30 s while the worker has no timer, and posts to it — each way a window posts to a worker — as
  # a timer of its 30 s step fires; the 2 s timer the worker then sets fires once the window's clock has moved about
  # that far, not at once.
  {
    'Worker#postMessage' => [
      'onmessage = () => late();',
      'const post = () => w.postMessage(1);'
    ],
    'a transferred MessagePort' => [
      'onmessage = (e) => { e.ports[0].onmessage = () => late(); };',
      'const ch = new MessageChannel(); w.postMessage(0, [ch.port2]); const post = () => ch.port1.postMessage(1);'
    ],
    'a BroadcastChannel' => [
      "new BroadcastChannel('c').onmessage = () => late();",
      "const bc = new BroadcastChannel('c'); const post = () => bc.postMessage(1);"
    ]
  }.each do |route, (worker_js, script)|
    it "waits a timer set from #{route} out on the window's clock" do
      session = visit_page(<<~JS, <<~SCRIPT)
        const late = () => setTimeout(() => postMessage('late'), 2000);
        setTimeout(() => postMessage('ready'), 100);
        #{worker_js}
      JS
        #{script}
        window.arm = () => setTimeout(() => { window.posted = performance.now(); post(); }, 30000);
      SCRIPT
      session.execute_script('window.arm()')
      session.driver.browser.advance_virtual_clock_ms(30_000)
      expect(waited(session)).to be >= 1500
    end
  end

  # …and a frame's: its tasks run after the window's in a step, and its post reads the step's end.
  it "waits a timer set from a frame's post out on the window's clock" do
    worker_js = <<~JS
      setTimeout(() => postMessage('ready'), 100);
      onmessage = () => setTimeout(() => postMessage('late'), 2000);
    JS
    frame = <<~HTML
      <!doctype html><meta charset="utf-8"><script>
      const w = new Worker(URL.createObjectURL(new Blob([#{worker_js.to_json}], {type: 'text/javascript'})));
      w.onmessage = (e) => parent.log.push([e.data, parent.performance.now()]);
      window.arm = () => setTimeout(() => { parent.posted = parent.performance.now(); w.postMessage(1); }, 30000);
      </script>
    HTML
    html = <<~HTML
      <!doctype html><meta charset="utf-8"><body><script>window.log = [];</script>
      <iframe srcdoc="#{CGI.escapeHTML(frame)}"></iframe></body>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit('/')
    poll_until { session.evaluate_script('window.log.length') >= 1 }
    session.execute_script('frames[0].arm()')
    session.driver.browser.advance_virtual_clock_ms(30_000)
    expect(waited(session)).to be >= 1500
  end

  it 'runs a pending timer no faster for a burst of messages' do
    session = visit_page(<<~JS)
      setTimeout(() => postMessage('ready'), 100);
      onmessage = (e) => { if (e.data === 'arm') setTimeout(() => postMessage('late'), 3000); };
    JS
    session.execute_script("window.posted = performance.now(); w.postMessage('arm')")
    200.times { session.execute_script("w.postMessage('x')") }
    expect(waited(session)).to be >= 2500
  end

  # …and its `Date` and `performance.now()` read that clock, not the real time between the window's steps beside it as
  # well: a worker's `setTimeout(…, 3000)` on a page at rest read 6,000 ms of either.
  it "reads its timer's time on its clock" do
    session = visit_page(<<~JS)
      postMessage('ready');
      onmessage = () => {
        const t0 = performance.now(), d0 = Date.now();
        setTimeout(() => postMessage([performance.now() - t0, Date.now() - d0]), 3000);
      };
    JS
    session.execute_script("w.postMessage('go')")
    poll_until(timeout: 20) {
      sleep 0.25
      session.evaluate_script('window.log.length') >= 2
    }
    perf, date = session.evaluate_script('window.log[1][0]')
    expect(perf).to be_between(3000, 3050)
    expect(date).to be_between(2999, 3050)
  end

  # Its time origin is the time it was made at, on the window's clock: its `timeOrigin + now()` reads what the window's
  # does, as its `Date` does (HR-Time §5: one shared monotonic clock) — but for the time each agent's own scripts ran
  # for, a few milliseconds of the window's, tens on a loaded machine; and ahead by little more than the real time its
  # start took, which its clock begins with. (It read a poll step behind: an idle worker's clock moved only with a timer
  # to run.)
  it "reads the window's time" do
    session = visit_page(<<~JS)
      postMessage('ready');
      onmessage = () => postMessage([performance.timeOrigin + performance.now(), Date.now()]);
    JS
    session.execute_script("window.posted = [performance.timeOrigin + performance.now(), Date.now()]; w.postMessage('go')")
    poll_until { session.evaluate_script('window.log.length') >= 2 }
    worker = session.evaluate_script('window.log[1][0]')
    window = session.evaluate_script('window.posted')
    expect(worker[0] - window[0]).to be_between(-50, 500)
    expect(worker[1] - window[1]).to be_between(-50, 500)
  end

  # A message reaches the window no earlier than the worker's time as it posted it: model time the worker spent that the
  # window's clock did not follow — a synchronous request's modeled server delay — is on the window's clock as the
  # message lands — less what the window's clock was ahead of the worker's by as it posted to it, the time the page's own
  # scripts ran for, a few milliseconds, tens on a loaded machine. (Its page read the message before the worker's 300 ms
  # wait was over.)
  it 'delivers a message no earlier than the time it was posted at' do
    html = <<~HTML
      <!doctype html><meta charset="utf-8"><body><script>
      window.log = [];
      const src = "onmessage = () => { const x = new XMLHttpRequest(); x.open('GET', '" + location.origin + "/slow', false); x.send(); postMessage(Date.now()); };";
      window.w = new Worker(URL.createObjectURL(new Blob([src], {type: 'text/javascript'})));
      w.onmessage = (e) => log.push(Date.now() - window.sent);
      </script></body>
    HTML
    session = simulated_session(lambda {|env|
      if env['PATH_INFO'] == '/slow'
        [200, {'content-type' => 'text/plain', 'x-csim-server-delay-ms' => '300'}, ['slow']]
      else
        [200, {'content-type' => 'text/html'}, [html]]
      end
    })
    session.visit('/')
    session.execute_script("window.sent = Date.now(); w.postMessage('go')")
    expect(poll_until { session.evaluate_script('log[0]') }).to be_between(250, 400)
  end

  # A worker busy on its own — spinning, crunching — while the window rests is none of the window's time: the window's
  # clock moves as the host steps it, and counting the worker's run beside that ran it at twice its pace.
  it "leaves the window's clock to its own pace while it is busy" do
    session = visit_page(<<~JS)
      postMessage('ready');
      onmessage = () => { const a = Date.now(); while (Date.now() - a < 2000); postMessage('spun'); };
    JS
    session.execute_script(<<~JS)
      window.r = null;
      const t0 = performance.now();
      w.postMessage('go');
      setTimeout(() => { r = performance.now() - t0; }, 1000);
    JS
    r = poll_until(timeout: 20) {
      sleep 0.1
      session.evaluate_script('r')
    }
    expect(r).to be_between(1000, 1200)
  end

  # Every message from another agent lands no earlier than its sender's time as it sent it, whatever carries it — a
  # transferred MessagePort, a BroadcastChannel, a SharedWorker's port, as a worker's own postMessage: a worker spinning
  # 500 ms before posting on a port read 0 ms on its page; a SharedWorker's 101 (Chrome: 504 each). (…a spin on the whole
  # milliseconds `Date.now()` reads ends as much as one short of 500 of `performance.now()`)
  {
    'a transferred MessagePort' => [
      "onmessage = () => { const ch = new MessageChannel(); postMessage('port', [ch.port2]); spin(); ch.port1.postMessage('done'); };",
      "w.onmessage = (e) => { e.ports[0].onmessage = () => { window.took = performance.now() - t0; }; };"
    ],
    'a BroadcastChannel' => [
      "onmessage = () => { const bc = new BroadcastChannel('c'); spin(); bc.postMessage('done'); };",
      "new BroadcastChannel('c').onmessage = () => { window.took = performance.now() - t0; };"
    ],
    "a dedicated worker's postMessage" => [
      "onmessage = () => { spin(); postMessage('done'); };",
      "w.onmessage = () => { window.took = performance.now() - t0; };"
    ]
  }.each do |route, (worker_js, listen)|
    it "lands a message on #{route} at its sender's time" do
      src = "const spin = () => { const a = Date.now(); while (Date.now() - a < 500); }; #{worker_js}"
      html = <<~HTML
        <!doctype html><meta charset="utf-8"><body><script>
        window.took = null;
        const w = new Worker(URL.createObjectURL(new Blob([#{src.to_json}], {type: 'text/javascript'})));
        let t0 = 0;
        #{listen}
        setTimeout(() => { t0 = performance.now(); w.postMessage('go'); }, 10);
        </script></body>
      HTML
      session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      session.visit('/')
      expect(poll_until(timeout: 20) { session.evaluate_script('window.took') }).to be_between(499, 650)
    end
  end

  it "lands a SharedWorker's message at its time" do
    src = "onconnect = (e) => { const p = e.ports[0]; p.onmessage = () => { const a = Date.now(); while (Date.now() - a < 500); p.postMessage('done'); }; };"
    html = <<~HTML
      <!doctype html><meta charset="utf-8"><body><script>
      window.took = null;
      const w = new SharedWorker(URL.createObjectURL(new Blob([#{src.to_json}], {type: 'text/javascript'})));
      let t0 = 0;
      w.port.onmessage = () => { window.took = performance.now() - t0; };
      setTimeout(() => { t0 = performance.now(); w.port.postMessage('go'); }, 10);
      </script></body>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit('/')
    expect(poll_until(timeout: 20) { session.evaluate_script('window.took') }).to be_between(499, 650)
  end

  # A post on a BroadcastChannel a worker listens on is taken at the time it was posted at, the window's step waiting for
  # it — where the host knows the worker listens on the name (`Browser#broadcast_external`). A second close() of a
  # channel is no close (HTML: it sets the closed flag again), and its host counted the name's listeners gone twice: the
  # worker's other channel of the name counted nowhere, its posts taken a step of the window's later, as the thread got
  # to them. (What the host counts is read here directly: which step a worker's thread wins is a race this spec cannot
  # pin.)
  it "counts a channel closed twice as closed once" do
    session = visit_page(<<~JS)
      const a = new BroadcastChannel('p'), b = new BroadcastChannel('p');
      a.close();
      a.close();
      postMessage('ready');
    JS
    workers = session.driver.browser.instance_variable_get(:@workers).values
    expect(workers.map {|w| w[:bc_names]&.fetch('p', 0) }).to eq([1])
  end

  # A worker's clock is its window's: one whose script set a timer reads the window's `Date` (it read 50 ms ahead for good:
  # the drain that ran its first timers moved its clock on by a step of its own).
  it "reads its window's Date after setting a timer as it began" do
    session = visit_page(<<~JS)
      setTimeout(() => {}, 0);
      onmessage = (e) => postMessage(Date.now() - e.data);
      postMessage('ready');
    JS
    session.execute_script("setTimeout(() => w.postMessage(Date.now()), 500)")
    poll_until { session.evaluate_script('window.log.length') >= 2 }
    expect(session.evaluate_script('window.log[1][0]')).to be_between(-1, 5)
  end

  # A worker's clock is its window's as it last caught up with it, and its own time since — not its scripts' time from
  # before then on top, which the window's clock went on through as well: a worker spinning 20 ms of every 50 read its
  # page's `Date` 187, 386, 586 and 1186 ms ahead at 0.5, 1.5, 3 and 6 s (Chrome: 0 each). It reads no further ahead
  # than the tick it is in.
  it "keeps a busy worker's Date on its window's" do
    session = visit_page(<<~JS)
      setInterval(() => { const e = performance.now() + 20; while (performance.now() < e); }, 50);
      onmessage = (e) => postMessage(Date.now() - e.data);
      postMessage('ready');
    JS
    session.execute_script('for (const t of [500, 1500, 3000]) setTimeout(() => w.postMessage(Date.now()), t);')
    poll_until(timeout: 30) {
      sleep 0.1
      session.evaluate_script('window.log.length') >= 4
    }
    gaps = session.evaluate_script('window.log.slice(1).map((l) => l[0])')
    expect(gaps).to all(be_between(-1, 60))
    expect(gaps.last - gaps.first).to be < 20
  end

  # …from its first statement: its clock begins just past its time origin, not at the real time its start took (its
  # script fetched, its isolate made), and a timer it sets as it begins runs its timeout after on its clock, never before.
  it 'begins its clock at its first statement' do
    session = visit_page(<<~JS)
      const start = performance.now();
      setTimeout(() => postMessage([start, performance.now() - start]), 300);
    JS
    start, waited = session.evaluate_script('window.log[0][0]')
    expect(start).to be_between(0, 5)
    expect(waited).to be_between(300, 400)
  end

  # A busy worker's answer is run at the time it was sent at, on the page's virtual clock: the page's own timers due
  # before then run first, and every later one at its time. It ran as it came, the page's `Date` lifted 1 s by it — ahead
  # of the page's `setTimeout(…, 300)` and `(…, 600)`, which then ran 1 s late, and its `(…, 1500)` read 2502 (Chrome:
  # 300, 600, the answer at 1101, 1500).
  it "runs a busy worker's answer at its time, among the page's timers" do
    session = visit_page(<<~JS)
      onmessage = () => { const a = Date.now(); while (Date.now() - a < 1000); postMessage('crunched'); };
      postMessage('ready');
    JS
    session.execute_script(<<~JS)
      window.order = [];
      const t0 = performance.now();
      const at = (what) => order.push([what, Math.round(performance.now() - t0)]);
      w.onmessage = () => at('crunched');
      setTimeout(() => w.postMessage('go'), 100);
      for (const ms of [300, 600, 1500]) setTimeout(() => at(ms), ms);
    JS
    order = poll_until(timeout: 30) {
      sleep 0.1
      session.evaluate_script('order.length == 4 && order')
    }
    expect(order.map(&:first)).to eq([300, 600, 'crunched', 1500])
    expect(order.last[1]).to be_between(1500, 1550)
  end

  # A worker busy on its own while the window waits on nothing of it is none of the window's time, however the host
  # waits for the worker's ticks: a page's `setTimeout(…, 3000)` beside a worker spinning 20 ms of every 50 read 3605.
  it "keeps a busy worker's ticks out of the window's time" do
    session = visit_page(<<~JS)
      postMessage('ready');
      setInterval(() => { const e = Date.now() + 20; while (Date.now() < e); }, 50);
    JS
    session.execute_script('window.r = null; const t0 = performance.now(); setTimeout(() => { r = performance.now() - t0; }, 3000);')
    r = poll_until(timeout: 30) {
      sleep 0.1
      session.evaluate_script('r')
    }
    expect(r).to be_between(3000, 3100)
  end

  # A worker's `Date` is its window's host clock's: a test's `travel_to` moves it as it moves the page's, and its time
  # origin with it.
  it "reads the host's travelled clock" do
    later = Time.now + 86_400 * 400
    allow(Time).to receive(:now).and_return(later)
    session = visit_page("postMessage([Date.now(), performance.timeOrigin, new Date().getFullYear()]);")
    worker = session.evaluate_script('window.log[0][0]')
    page = session.evaluate_script('[Date.now(), performance.timeOrigin]')
    expect(worker[2]).to eq(later.year)
    expect((worker[0] - page[0]).abs).to be < 1000
    expect((worker[1] - page[1]).abs).to be < 1000
  end
end
