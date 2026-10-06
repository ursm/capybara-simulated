# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A worker's clock follows the window's (`Browser#run_worker`'s `worker_clock_step`): a timer it sets waits for the
# window's clock to reach it — not fired at once by the message's quiescence drive, and not owed whatever the window
# moved before it was set, while the worker had no timer or before the message that set it.
RSpec.describe 'Worker clock' do
  worker_js = <<~JS
    setTimeout(() => postMessage('ready'), 100);
    onmessage = () => setTimeout(() => postMessage('late'), 2000);
  JS
  page = <<~HTML
    <!doctype html><meta charset="utf-8"><body><script>
    window.log = [];
    const w = new Worker(URL.createObjectURL(new Blob([#{worker_js.to_json}], {type: 'text/javascript'})));
    window.w = w;
    w.onmessage = (e) => window.log.push([e.data, performance.now()]);
    window.arm = () => setTimeout(() => { window.posted = performance.now(); w.postMessage(1); }, 30000);
    </script></body>
  HTML

  it "waits a timer set after an idle stretch out on the window's clock" do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit('/')
    poll_until { session.evaluate_script('window.log.length') >= 1 }
    # The window moves on 30 s while the worker has no timer, and posts to it as it gets there…
    session.execute_script('window.arm()')
    session.driver.browser.advance_virtual_clock_ms(30_000)
    poll_until(timeout: 10) { session.evaluate_script('window.log.length') >= 2 }
    posted = session.evaluate_script('window.posted')
    late, at = session.evaluate_script('window.log[1]')
    expect(late).to eq('late')
    # …and the 2 s timer it then sets fires once the window's clock has moved about that far, not at once.
    expect(at - posted).to be >= 1500
  end
end
