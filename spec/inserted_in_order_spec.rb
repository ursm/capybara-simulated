# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML's "list of scripts that will execute in order as soon as possible": inserted scripts of `async` false run in the
# order they were inserted, each once those before it have — a long chain landing together run as a loop
# (script_lists.rs `in_order_next`, bridge.entry.js `landingSteps`), no frame of the stack per script.
RSpec.describe 'inserted scripts in order' do
  it 'runs a chain of 2000 that land before their head, in order' do
    app = ->(env) {
      if (m = env['PATH_INFO'].match(%r{\A/s/(\d+)\.js\z}))
        # (…the first one's server slowest: the rest land before it, the whole chain run as it lands)
        sleep 0.1 if m[1] == '0'
        next [200, {'content-type' => 'text/javascript'}, ["R.push(#{m[1]})"]]
      end
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8><title>t</title>
        <script>window.R = []; for (let i = 0; i < 2000; i++) { const s = document.createElement('script'); s.src = '/s/' + i + '.js'; s.async = false; document.head.append(s); }</script>
      HTML
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done([R.length, R.every((n, i) => n === i)]), 300)')
    expect(got).to eq([2000, true])
  end
end
