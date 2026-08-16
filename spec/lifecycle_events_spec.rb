require 'capybara/simulated'
require_relative 'support/session_teardown'

# Document lifecycle: as the page transitions from `loading` →
# `interactive` → `complete`, the browser dispatches a
# `readystatechange` event on each step alongside DOMContentLoaded /
# load. Turbo Drive's PageObserver hooks `readystatechange` (not
# DOMContentLoaded) to fire `turbo:load`, so anything chained off
# that (Avo's tippy init, ahoy.js, etc.) only runs once we emit the
# transition events.
RSpec.describe 'document lifecycle events' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <script>
            window.__readyTransitions = [];
            window.__lifecycleEvents  = [];
            document.addEventListener('readystatechange', () => {
              window.__readyTransitions.push(document.readyState);
            });
            document.addEventListener('DOMContentLoaded', () => {
              window.__lifecycleEvents.push('DOMContentLoaded@' + document.readyState);
            });
            window.addEventListener('load', (e) => {
              window.__lifecycleEvents.push('load@' + document.readyState);
              window.__loadEvent = {
                target:  e.target === document,
                current: e.currentTarget === window,
                trusted: e.isTrusted
              };
            });
          </script>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  it 'dispatches readystatechange when document.readyState transitions' do
    transitions = session.evaluate_script('window.__readyTransitions')
    expect(transitions).to eq(%w[interactive complete])
  end

  it 'still fires DOMContentLoaded and load alongside readystatechange' do
    events = session.evaluate_script('window.__lifecycleEvents')
    expect(events).to eq(['DOMContentLoaded@interactive', 'load@complete'])
  end

  # The window `load` event carries the "legacy target override flag": HTML fires
  # it AT the window, but its `target` is the DOCUMENT (Chrome-measured — page code
  # routes on it), and it is a UA event, so it is trusted.
  it 'targets the document, is trusted, and fires exactly once' do
    expect(session.evaluate_script('window.__loadEvent')).to eq(
      'target' => true, 'current' => true, 'trusted' => true
    )
    # Several places can be the one to fire it (the driver here, the realm builder
    # for a frame, the WPT harness for a test file) — whoever gets there first
    # does, and the rest are no-ops.
    again = session.evaluate_script('__csimFireWindowLoad()')
    expect(again).to be(false)
    expect(session.evaluate_script('window.__lifecycleEvents')).to eq(['DOMContentLoaded@interactive', 'load@complete'])
  end
end
