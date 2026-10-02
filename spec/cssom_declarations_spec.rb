# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSSOM's declaration blocks are the style engine's (cssom_decl.rs): what `el.style` and `rule.style` parse, accept and
# serialize is what the page is styled with.
RSpec.describe 'CSSOM declaration blocks' do
  def page(head = '')
    html = "<!DOCTYPE html><html><head>#{head}</head><body></body></html>"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  # A write keeps the block it made, and the element's style is computed from THAT block — its serialization in the
  # attribute rounds a number to six significant digits. Through `setProperty` and through `cssText` alike; an element
  # merely given the same TEXT parses its own.
  it 'computes an element style from the block a write made, not from its text' do
    got = page.evaluate_script(<<~JS)
      (() => {
        const mk = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
        const a = mk(), b = mk(), c = mk();
        a.style.width = '123.4567891px';
        b.setAttribute('style', a.getAttribute('style'));
        c.style.cssText = 'width: 123.4567891px';
        return [a.getAttribute('style'), getComputedStyle(a).width, getComputedStyle(b).width, getComputedStyle(c).width];
      })()
    JS
    expect(got).to eq(['width: 123.457px;', '123.4568px', '123.457px', '123.4568px'])
  end

  # A rule's own text and its `style` are one block, as the engine parses it: what the engine does not implement is in
  # neither (Chrome: identical text for both).
  it 'serializes a rule and its style alike' do
    got = page('<style>#a { width: 1.23456789px; -moz-default-appearance: button }</style>').evaluate_script(<<~JS)
      (() => { const r = document.styleSheets[0].cssRules[0]; return [r.cssText, r.style.cssText]; })()
    JS
    expect(got).to eq(['#a { width: 1.23457px; }', 'width: 1.23457px;'])
  end

  # Each rule's block takes what that rule may declare: a keyframe no animation property, a page its `size`, a face its
  # descriptors (Chrome: `opacity: 0;`, `size: a4;`, `font-family: Foo; src: url("foo.woff");`).
  it 'holds what each kind of rule may declare' do
    head = '<style>@keyframes k { from { opacity: 0 } } @page { size: A4 } @font-face { font-family: Foo; src: url(foo.woff) }</style>'
    got = page(head).evaluate_script(<<~JS)
      (() => {
        const rules = document.styleSheets[0].cssRules, frame = rules[0].cssRules[0], pg = rules[1], face = rules[2];
        frame.style.animationName = 'x';
        frame.style.setProperty('color', 'red');
        return [frame.style.cssText, pg.style.cssText, face.style.cssText, face.style.getPropertyValue('font-family')];
      })()
    JS
    expect(got).to eq(['opacity: 0; color: red;', 'size: a4;', 'font-family: Foo; src: url("foo.woff");', 'Foo'])
  end

  # The engine's internal properties are no page's to see — not to `CSS.supports`, not in a block (Chrome has none).
  it 'keeps the engine internal properties out of the page' do
    got = page.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div');
        d.setAttribute('style', '-moz-default-appearance: button; color: red');
        return [CSS.supports('-moz-default-appearance', 'none'), CSS.supports('display', 'grid'), d.style.length, d.style.cssText];
      })()
    JS
    expect(got).to eq([false, true, 1, 'color: red;'])
  end

  # The block a write made stops being the element's once its attribute holds any other text — set back to the text it
  # had, the attribute is parsed afresh.
  it 'lets the written block go when the attribute is written over' do
    got = page.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div');
        document.body.appendChild(d);
        d.style.width = '123.4567891px';
        const t = d.getAttribute('style');
        d.setAttribute('style', 'width: 5px');
        d.setAttribute('style', t);
        return getComputedStyle(d).width;
      })()
    JS
    expect(got).to eq('123.457px')
  end

  # Editing one rule rebuilds the sheet the engine cascades from, and every OTHER rule goes back as it was written — not
  # as CSSOM serializes it, which rounds its numbers.
  it 'leaves the rules an edit did not touch as they were written' do
    head = '<style>#a { width: 123.4567891px; border-block-start: 3px solid red; border-block-end: 7px dashed blue } #c { color: red }</style>'
    got = page(head).evaluate_script(<<~JS)
      (() => {
        const a = document.createElement('div'); a.id = 'a'; document.body.appendChild(a);
        const read = () => [getComputedStyle(a).width, getComputedStyle(a).borderBottomWidth];
        const before = read();
        document.styleSheets[0].cssRules[1].style.color = 'blue';
        document.styleSheets[0].insertRule('#b { color: green }', 2);
        return [before, read()];
      })()
    JS
    expect(got).to eq([['123.4568px', '7px'], ['123.4568px', '7px']])
  end

  # The written block is the element's only in a document of the base and mode it was written in: one made in a
  # template's contents, whose base is `about:blank`, does not keep its `url()` unresolved once the element is in the
  # page (Chrome and Firefox resolve it against the page).
  it 'resolves a block written in another document against the one its element is in' do
    got = page.evaluate_script(<<~JS)
      (() => {
        const t = document.createElement('template');
        t.innerHTML = '<p></p>';
        const e = t.content.firstElementChild;
        e.style.backgroundImage = 'url(tw.png)';
        document.body.appendChild(e);
        return getComputedStyle(e).backgroundImage;
      })()
    JS
    expect(got).to eq('url("http://www.example.com/tw.png")')
  end

  # The shorthands of the longhands a page has (Chrome: each takes its value and serializes it back) — written from an
  # inline script, which runs before any style is computed: what the engine parses must not wait for it.
  it 'takes the container, offset, timeline and position-try shorthands' do
    html = <<~HTML
      <!DOCTYPE html><html><body><div id="d"></div><script>
        const d = document.getElementById('d'), out = [];
        for (const [p, v] of [['container', 'card / inline-size'], ['offset', 'path("M0 0 L 100 0") 20px auto 30deg'], ['scroll-timeline', '--t x'],
                              ['view-timeline', '--v block'], ['animation-range', 'entry 10% exit 90%'],
                              ['position-try', 'most-height flip-block']]) {
          d.removeAttribute('style');
          d.style.setProperty(p, v);
          out.push(d.style.cssText);
        }
        window.got = out;
      </script></body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script('window.got')).to eq([
      'container: card / inline-size;', 'offset: path("M 0 0 L 100 0") 20px auto 30deg;', 'scroll-timeline: --t x;', 'view-timeline: --v;',
      'animation-range: entry 10% exit 90%;', 'position-try: most-height flip-block;'
    ])
  end

  # A keyframe holds no `!important` declaration, so an important write to one is no write at all — not one that takes
  # the property out of the block.
  it 'writes nothing important into a keyframe' do
    head = '<style>@keyframes k { from { opacity: 0; animation-timing-function: linear } }</style>'
    got = page(head).evaluate_script(<<~JS)
      (() => {
        const frame = document.styleSheets[0].cssRules[0].cssRules[0];
        frame.style.setProperty('opacity', '0.5', 'important');
        return frame.style.cssText;
      })()
    JS
    expect(got).to eq('opacity: 0; animation-timing-function: linear;')
  end

  # `border-block` sets one value for both sides, so two different sides serialize as their longhands — not as the
  # start side alone (Chrome: `border-block-start: 1px solid red; border-block-end: 2px dashed blue;`, and `border-block:
  # 3px solid red;` for two equal ones).
  it 'serializes border-block only where both sides agree' do
    got = page.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div');
        d.style.cssText = 'border-block-start: 1px solid red; border-block-end: 2px dashed blue';
        const e = document.createElement('div');
        e.style.cssText = 'border-block-start: 3px solid red; border-block-end: 3px solid red';
        return [d.style.cssText, d.style.borderBlock, e.style.cssText];
      })()
    JS
    expect(got).to eq(['border-block-start: 1px solid red; border-block-end: 2px dashed blue;', '', 'border-block: 3px solid red;'])
  end

  # `subgrid` is a track list the engine parses, so `@supports` says so (Discourse refuses to boot without it).
  it 'parses subgrid' do
    got = page.evaluate_script("[CSS.supports('(grid-template-rows: subgrid)'), CSS.supports('grid-template-columns', 'subgrid [a] [b]')]")
    expect(got).to eq([true, true])
  end
end
