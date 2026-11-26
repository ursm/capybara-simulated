# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A script's fetch that joins one under way of the same request for its document (browser.rb `script_fetch_start`: the
# asset cache's flight, one fetch) lands as that fetch does: it waits what is left of the shared server's time, not all of
# it again from its own beginning.
RSpec.describe 'a script fetch that joins one under way' do
  it "waits for a parser-blocking script only what is left of the flight's server time" do
    app = ->(env) {
      case env['PATH_INFO']
      when '/b.js'
        sleep 0.15
        [200, {'content-type' => 'text/javascript'}, ['window.ran = (window.ran || 0) + 1']]
      when '/w.js'
        sleep 0.1
        [200, {'content-type' => 'text/javascript'}, ['']]
      else
        # (…an `async` fetch of /b.js begun at its end tag, a blocking one 100 ms later, written — no preload scanner's
        # dating it)
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset=utf-8><title>t</title><script>window.t0 = Date.now()</script>
          <script async src="/b.js"></script><script src="/w.js"></script>
          <script>document.write('<script src="/b.js"><\\/script>')</script><script>window.dt = Date.now() - t0</script>
        HTML
      end
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('window.dt')).to be_between(140, 220)
  end
end
