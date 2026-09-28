# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A `supports()` condition — `@supports` and an `@import`'s — evaluated as a browser does: a FUNCTION (`selector(…)`)
# is one test, its parentheses and all (split at its `(`, `selector()` was never asked and `@supports selector(:has(a))`
# applied nothing), and a condition the end of the text leaves unclosed is closed there. Chrome applies every rule
# below.
RSpec.describe 'supports() conditions' do
  def colors(css, sheets = {})
    app = lambda {|env|
      body = sheets[env['PATH_INFO']]
      next [200, {'content-type' => 'text/css'}, [body]] if body
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><style>#{css}</style><p id=\"a\">a</p><p id=\"b\">b</p>"]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script("['a', 'b'].map((id) => getComputedStyle(document.getElementById(id)).color)")
  end

  it 'asks selector() of an @supports block and of an @import' do
    got = colors('@import url(/i.css) supports(selector(:has(a))); @supports selector(:has(a)) { #a { color: rgb(0, 128, 0) } }',
                 '/i.css' => '#b { color: rgb(0, 128, 0) }')
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 128, 0)'])
  end

  it 'closes an @import supports() the end of the sheet leaves open' do
    expect(colors('@import url(/i.css) supports(display: grid', '/i.css' => '#a { color: rgb(0, 128, 0) }').first).to eq('rgb(0, 128, 0)')
  end
end
