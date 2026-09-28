# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Two case rules that hold only for "an HTML element in an HTML document" (Selectors 4 §5.1 / §6.3): a type selector
# is compared lowercased with the element's LOCAL name — so an XHTML `DIV` from createElementNS is neither `div` nor
# `DIV` — and HTML's case-insensitive attribute values (`[type=CHECKBOX]`) are so only for such an element, not an
# SVG one. A namespaced attribute is a different attribute from the one in no namespace: an unprefixed `urn:x`
# `type` does not change `input.type`. Chrome-measured.
RSpec.describe 'selector case rules for HTML elements' do
  it 'applies the HTML-only case rules to HTML elements only' do
    html = '<!DOCTYPE html><svg><rect id="r" type="checkbox"></rect></svg><input id="i" type="checkbox">'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const D = document.createElementNS('http://www.w3.org/1999/xhtml', 'DIV');
        document.body.appendChild(D);
        const ni = document.createElement('input');
        ni.setAttributeNS('urn:x', 'type', 'checkbox');
        return [document.querySelectorAll('[type=CHECKBOX]').length, document.getElementById('r').matches('[type=CHECKBOX]'),
                D.matches('div'), D.matches('DIV'), ni.type, ni.getAttribute('type'), ni.getAttributeNS('urn:x', 'type')];
      })()
    JS
    expect(got).to eq([1, false, false, false, 'text', 'checkbox', 'checkbox'])
  end
end
