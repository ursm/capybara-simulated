# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element serializes under its LOCAL name when it is an HTML, SVG or MathML element and under its qualified name
# otherwise (HTML "serializing HTML fragments") — `foreignObject` keeps its case, as `localName` does — and only an
# HTML element whose local name is a void element serializes as void: `createElementNS(HTML, 'BR')` is `<BR></BR>`.
# The serializer had written the lowercased matching key for all of them. Chrome-measured.
RSpec.describe 'HTML serialization names' do
  it 'serializes each element under the name the spec gives it' do
    html = <<~HTML
      <!DOCTYPE html><div id="d"><svg viewBox="0 0 1 1"><foreignObject><p>x</p></foreignObject><clipPath></clipPath></svg><math><mi>x</mi></math></div>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        d.appendChild(document.createElementNS('urn:x', 'p:Foo'));
        d.appendChild(document.createElementNS('http://www.w3.org/1999/xhtml', 'BR'));
        return d.innerHTML;
      })()
    JS
    expect(got).to eq('<svg viewBox="0 0 1 1"><foreignObject><p>x</p></foreignObject><clipPath></clipPath></svg>' \
                      '<math><mi>x</mi></math><p:Foo></p:Foo><BR></BR>')
  end
end
