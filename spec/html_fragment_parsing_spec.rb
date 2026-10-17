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

  # …and in an ELEMENT's name, which the engine builds exactly beside its interned name: Chrome and Firefox both give
  # `<a\uD800>` the local name `a` U+D800, in a fragment and in a document parse alike, the text after it whole.
  it 'keeps a lone surrogate in an element name' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const units = (t) => [...t].map((c) => c.charCodeAt(0));
        const d = document.createElement('div');
        d.innerHTML = '<a\\uD800>x</a\\uD800>';
        const doc = Document.parseHTMLUnsafe(`<p\\uDC00>\\uD800${'a '.repeat(10000)}</p\\uDC00>`);
        const p = doc.body.firstChild;
        return [units(d.firstChild.localName), d.childNodes.length, units(p.localName), p.textContent.length, p.textContent.charCodeAt(0)];
      })()
    JS
    expect(got).to eq([[0x61, 0xD800], 1, [0x70, 0xDC00], 20_001, 0xD800])
  end

  # The foreign elements HTML counts as "special" — MathML mi, mo, mn, ms, mtext, annotation-xml; SVG foreignObject,
  # desc, title — bound every scope: an end tag or a list item inside one does not reach past it. Chrome, all three.
  it 'stops at a foreign element that bounds the scope' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const p = new DOMParser();
        const tree = (h) => {
          const ns = (n) => n.namespaceURI && n.namespaceURI.endsWith('svg') ? '@svg' : n.namespaceURI && n.namespaceURI.endsWith('MathML') ? '@m' : '';
          const w = (n) => n.nodeType === 3 ? JSON.stringify(n.data) : n.localName + ns(n) + '(' + Array.from(n.childNodes).map(w).join(',') + ')';
          return w(p.parseFromString(h, 'text/html').body);
        };
        return [tree('<li>a<svg><title><li>x'), tree('<p>q<math><annotation-xml encoding=text/html><div>w'), tree('<span><math><mi></span>q')];
      })()
    JS
    expect(got).to eq(['body(li("a",svg@svg(title@svg(li("x")))))', 'body(p("q",math@m(annotation-xml@m(div("w")))))',
                       'body(span(math@m(mi@m("q"))))'])
  end

  # The form element pointer a fragment parse starts with is the context's nearest inclusive ancestor `<form>` (HTML
  # "parsing HTML fragments" step 11, "going straight up the ancestor chain"): a `<form>` in the markup is dropped under
  # one — and not across a shadow root, whose host's form is no ancestor of its tree's. Chrome, both.
  it "starts with the context's form, but none across a shadow root" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const outer = document.createElement('form');
        const div = outer.appendChild(document.createElement('div'));
        const host = outer.appendChild(document.createElement('span'));
        const inner = host.attachShadow({mode: 'open'}).appendChild(document.createElement('div'));
        div.innerHTML = '<form id="a"><input></form>';
        inner.innerHTML = '<form id="b"><input></form>';
        return [div.innerHTML, inner.innerHTML];
      })()
    JS
    expect(got).to eq(['<input>', '<form id="b"><input></form>'])
  end
end
