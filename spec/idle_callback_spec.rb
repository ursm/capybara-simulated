require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# requestIdleCallback's callbacks are the event loop's work as its timers are: one requested on a page with nothing else
# pending wakes the driver's loop (an animation frame's does), so neither it nor a timer set after it is left unrun.
# And a deadline is its own idle period's: kept past that period, it has no time remaining.
RSpec.describe 'requestIdleCallback' do
  it 'keeps the event loop stepping, the idle callback and a later timer alike' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        window.n = 0;
        requestIdleCallback(() => { n++; });
        setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p id="late">late</p>'); }, 300);
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(s).to have_css('#late', wait: 2)
    expect(s.evaluate_script('n')).to eq(1)
  end

  it "reads no time remaining off a deadline kept past its idle period" do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        window.got = null;
        requestIdleCallback((d) => {
          const first = d.timeRemaining() > 0;
          setTimeout(() => { requestIdleCallback(() => { got = [first, d.timeRemaining()]; }); }, 60);
        });
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(poll_until { s.evaluate_script('got') }).to eq([true, 0])
  end
end
