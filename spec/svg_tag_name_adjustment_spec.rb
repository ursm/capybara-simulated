# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The HTML parser hands foreign content its ADJUSTED name ("adjust SVG tag name": `foreignobject` → `foreignObject`),
# and the element keeps it as its `localName`. It had been lowercased with the element's matching key, so a parsed
# `<foreignObject>` read `foreignobject` and a `foreignObject { … }` rule never applied. A type selector matches a
# non-HTML element case-sensitively (Selectors 4 §5.1): the lowercase `svg foreignobject` styles nothing — Firefox
# agrees; Chrome is the engine that matches it anyway.
RSpec.describe 'SVG tag name adjustment' do
  it 'keeps the adjusted name and matches it case-sensitively' do
    html = <<~HTML
      <!DOCTYPE html>
      <style>svg foreignObject { margin-left: 5px } foreignObject { margin-top: 3px } svg foreignobject { margin-right: 2px }</style>
      <svg><foreignObject id="fo" width="10" height="10"></foreignObject><clipPath id="cp"></clipPath></svg>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const fo = document.getElementById('fo'), cs = getComputedStyle(fo);
        return [fo.localName, fo.tagName, document.getElementById('cp').localName, cs.marginLeft, cs.marginTop, cs.marginRight];
      })()
    JS
    expect(got).to eq(%w[foreignObject foreignObject clipPath 5px 3px 0px])
  end

  # …and a query agrees with the cascade: `svg foreignobject` finds nothing, `svg foreignObject` the element (Firefox;
  # Chrome finds both).
  it 'queries the adjusted name case-sensitively too' do
    html = '<!DOCTYPE html><svg><foreignObject id="fo"></foreignObject></svg>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      [document.querySelectorAll('svg foreignobject').length, document.querySelectorAll('svg foreignObject').length,
       document.getElementById('fo').matches('foreignobject')]
    JS
    expect(got).to eq([0, 1, false])
  end
end
