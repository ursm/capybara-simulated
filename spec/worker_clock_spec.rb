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
end
