# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element serializes under its LOCAL name when it is an HTML, SVG or MathML element and under its qualified name
# otherwise (HTML "serializing HTML fragments") — `foreignObject` keeps its case, as `localName` does — and only an
# HTML element whose local name is a void element serializes as void: `createElementNS(HTML, 'BR')` is `<BR></BR>`.
# The serializer had written the lowercased matching key for all of them. Chrome-measured.
RSpec.describe 'HTML serialization' do
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

  # A `<template>` serializes its CONTENTS (its own child list is empty — it had serialized as `<template></template>`,
  # `page.html` included); the obsolete void elements are void too; an element in no namespace is never void; and
  # `&`, U+00A0, `<` and `>` are escaped in text and attribute values alike, `"` in an attribute. Chrome-measured.
  it 'serializes template contents, void elements and escapes as a browser does' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><div id="d"></div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.createElement('template');
        t.innerHTML = '<p>x</p><keygen>';
        const d = document.getElementById('d');
        d.setAttribute('title', 'a<b>c&d"e\u00A0f\\'');
        d.textContent = 'x<y>z&w\u00A0v"q\\'';
        return [t.outerHTML, t.innerHTML, document.createElementNS(null, 'br').outerHTML, d.outerHTML];
      })()
    JS
    expect(got).to eq(['<template><p>x</p><keygen></template>', '<p>x</p><keygen>', '<br></br>',
                       %q(<div id="d" title="a&lt;b&gt;c&amp;d&quot;e&nbsp;f'">x&lt;y&gt;z&amp;w&nbsp;v"q'</div>)])
  end
end
