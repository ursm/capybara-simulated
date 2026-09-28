# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `innerHTML` is LINEAR in the nodes it parses. It was quadratic twice over: parse5's `getFragment()` moved the parsed
# nodes into a fragment one `detachNode` at a time (an `indexOf` + `splice` off the front of the list, and a child-list
# effect over every remaining sibling), and the insertion asked whether the target's `:empty` could have flipped with an
# `indexOf` into the batch per child. 60,000 nodes took 4 s; 200 ms now. A RATIO, taken as the best of three: a 4x
# larger fragment takes ~4x as long, where a quadratic one took ~16x.
RSpec.describe 'innerHTML scaling' do
  it 'parses and inserts a fragment in time linear in its size' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><div id="h"></div>']] })
    s.visit '/'
    time = lambda do |n|
      s.evaluate_script(<<~JS)
        (() => {
          let best = Infinity;
          for (let i = 0; i < 3; i++) {
            const t = __dom.nowNanos();
            document.getElementById('h').innerHTML = '<p><span>x</span><b>y</b></p>'.repeat(#{n});
            best = Math.min(best, __dom.nowNanos() - t);
          }
          return best;
        })()
      JS
    end
    small = time.call(2500)
    expect(time.call(10_000) / small).to be < 8
  end
end
