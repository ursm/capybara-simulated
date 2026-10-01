# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element in the HTML namespace is an HTML element whatever document holds it: an XML parse's `<h:form>` (the XHTML
# namespace under a prefix) is an HTMLFormElement — its `elements`, its named controls — and `<h:select>` indexes its
# options. Its interface follows its LOCAL name, case and all: `createElementNS(HTML_NS, 'DIV')` is no div.
RSpec.describe 'HTML elements in an XML document' do
  it 'gives a prefixed XHTML element its interface by local name' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><p>x</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const xml = '<h:div xmlns:h="http://www.w3.org/1999/xhtml"><h:form><h:input name="q"/></h:form>' +
                    '<h:select><h:option>a</h:option><h:option>b</h:option></h:select></h:div>';
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const form = doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'form')[0];
        const select = doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'select')[0];
        const upper = document.createElementNS('http://www.w3.org/1999/xhtml', 'DIV');
        return [form instanceof HTMLFormElement, 'elements' in form, form.elements.length, form.elements[0].localName,
                select[1] && select[1].textContent, Object.getPrototypeOf(upper) === Element.prototype];
      })()
    JS
    expect(got).to eq([true, true, 1, 'input', 'b', true])
  end
end
