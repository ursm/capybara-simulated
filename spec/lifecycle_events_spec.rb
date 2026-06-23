require 'capybara/simulated'

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
            window.addEventListener('load', () => {
              window.__lifecycleEvents.push('load@' + document.readyState);
            });
          </script>
        </body></html>
      HTML
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  it 'dispatches readystatechange when document.readyState transitions' do
    transitions = session.evaluate_script('window.__readyTransitions')
    expect(transitions).to eq(%w[interactive complete])
  end

  it 'still fires DOMContentLoaded and load alongside readystatechange' do
    pending 'window `load` not yet emitted on a top-level visit ' \
            '(DOMContentLoaded@interactive now works)'
    events = session.evaluate_script('window.__lifecycleEvents')
    expect(events).to eq(['DOMContentLoaded@interactive', 'load@complete'])
  end
end
