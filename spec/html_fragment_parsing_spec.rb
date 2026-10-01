# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML's fragment parsing algorithm parses in its CONTEXT element's place: an `<svg>`'s `innerHTML` is foreign
# content, its `<circle/>` an SVG element whose self-closing tag is honoured (icon libraries set `svg.innerHTML`), where
# a context rewritten to `<body>` made one HTML `circle` holding the `<g>`. And a page's string is UTF-16, a lone
# surrogate included: Chrome keeps `\uD800` in an attribute and `\uDC00` in text, where the parser's own text has no room
# for one.
RSpec.describe 'HTML fragment parsing' do
  def session
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><svg></svg><p>x</p>']] }).tap {|s| s.visit '/' }
  end

  it 'parses an <svg>\'s innerHTML as foreign content' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const svg = document.querySelector('svg');
        svg.innerHTML = '<circle r="1"/><g><rect/></g><foreignObject><p>html</p></foreignObject>';
        return [svg.childNodes.length, svg.firstChild.namespaceURI, svg.childNodes[1].localName,
                svg.querySelector('p').namespaceURI];
      })()
    JS
    expect(got).to eq([3, 'http://www.w3.org/2000/svg', 'g', 'http://www.w3.org/1999/xhtml'])
  end

  it 'keeps a lone surrogate in text and in an attribute value' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div');
        d.innerHTML = '<b title="\\uD800">a\\uDC00b\\uD83D\\uDE00</b>';
        const b = d.firstChild;
        return [b.title.charCodeAt(0), b.textContent.charCodeAt(1), b.textContent.length, b.textContent.codePointAt(3)];
      })()
    JS
    expect(got).to eq([0xD800, 0xDC00, 5, 0x1F600])
  end
end
