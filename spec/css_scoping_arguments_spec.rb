# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# css-scoping takes a `<compound-selector>` as the argument of `::slotted()` and `:host()`: an argument with a
# combinator or a list makes the selector invalid, and it matches nothing. Both were applied as written — the slotted
# `li` and the host moved 40px where Chrome leaves them at 0.
RSpec.describe 'css-scoping pseudo arguments' do
  it 'ignores ::slotted() and :host() whose argument is not one compound selector' do
    html = '<!DOCTYPE html><body style="margin:0"><div id="h"><li class="x">x</li><li id="b">y</li></div>' \
           '<div id="h2" class="b"><p id="q" style="margin:0">q</p></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = '<style>::slotted(.x + li) { margin-left: 40px }</style><slot></slot>';
        document.getElementById('h2').attachShadow({mode: 'open'}).innerHTML = '<style>:host(div, .b) { margin-left: 40px }</style><slot></slot>';
        return ['b', 'q'].map((id) => document.getElementById(id).getBoundingClientRect().x);
      })()
    JS
    expect(got).to eq([0, 0])
  end
end
