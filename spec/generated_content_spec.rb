# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `::before` / `::after` with a `content` are boxes in the flow (CSS Pseudo-Elements 4 §4): an inline
# by default holding the text the `content` names, sized, placed and painted like any other. They
# are no DOM nodes — nothing that walks the DOM sees them, `innerText` and `textContent` leave them
# out, and a hit over one answers its originating element. The driver laid out none of them, so
# every icon-font glyph, list bullet, clearfix and badge written as generated content took no
# space at all.
#
# The rules, Chrome-measured (16 + 18 cases at 16px monospace, all matched but `counter()`):
#   - `getComputedStyle(el, '::before')` resolves on the pseudo: `content` as written, an `attr()`
#     resolved and adjacent strings joined (`"a" "b"` reads `"ab"`), `none` when it generates
#     nothing; `width` is `auto` for an inline pseudo and the used px otherwise
#   - `display`, `float`, `position`, `white-space`, the font — every property — comes from the
#     pseudo-element rules, the inherited ones from the element
#   - a replaced element (`<img>`, `<input>`, `<select>`, `<textarea>`) generates none; a
#     `<button>` or an `<hr>` does
#
# Every x is a formula over runs measured on the same page.
RSpec.describe 'generated content' do
  def page(body, css = '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { margin: 0; font: 16px monospace }
          .w { width: 300px }
          #{css}
        </style></head><body>#{body}<span id="__w" style="white-space:pre"></span></body></html>
      HTML
    })
    session.visit '/'
    session
  end

  # `[x, y, width, height]` of `#t`'s rect, and a measurer for runs in the page's font.
  def measure(body, css = '')
    s = page(body, css)
    r = s.evaluate_script("(function () { var r = document.getElementById('t').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
    w = ->(text) { s.evaluate_script("(function () { var p = document.getElementById('__w'); p.textContent = #{text.to_json}; return p.getBoundingClientRect().width; })()") }
    [r, w, s]
  end

  it 'puts a ::before in front of the content' do
    (x, _), w = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "x" }')
    expect(x).to be_within(0.01).of(w.call('x'))
  end

  it 'puts an ::after behind it' do
    _, w, s = measure('<div class=w id=h><span id=t>T</span></div>', '#h::after { content: "yz" }')
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")).to eq(0)
    expect(s.evaluate_script("document.getElementById('h').innerText")).to eq('T')
    expect(s.evaluate_script("document.getElementById('h').textContent")).to eq('T')
  end

  it 'joins the strings of a content and resolves attr()' do
    (x, _), w, s = measure('<div class=w id=h data-x="dd"><span id=t>T</span></div>', '#h::before { content: attr(data-x) "-" "e" }')
    expect(x).to be_within(0.01).of(w.call('dd-e'))
    expect(s.evaluate_script("getComputedStyle(document.getElementById('h'), '::before').content")).to eq('"dd-e"')
  end

  it 'generates nothing for none, normal, or no content at all' do
    %w[none normal].each do |v|
      (x, _), _, s = measure('<div class=w id=h><span id=t>T</span></div>', "#h::before { content: #{v} }")
      expect(x).to eq(0)
      expect(s.evaluate_script("getComputedStyle(document.getElementById('h'), '::before').content")).to eq('none')
    end
    _, _, s = measure('<div class=w id=h><span id=t>T</span></div>')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('h'), '::before').content")).to eq('none')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('h'), '::before').width")).to eq('auto')
  end

  it 'decodes CSS escapes, a newline included' do
    (x, y, _, _), w = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "a\A b"; white-space: pre }')
    expect(x).to be_within(0.01).of(w.call('b'))
    expect(y).to be_within(0.01).of(measure('<div id=t>a</div>')[0][3])          # the second line
    (x2, _), w2 = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "\41\42" }')
    expect(x2).to be_within(0.01).of(w2.call('AB'))
  end

  it 'sizes an empty inline-block pseudo from its own width' do
    (x, _), = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: ""; display: inline-block; width: 16px; height: 10px }')
    expect(x).to eq(16)
  end

  it 'lays a block pseudo out as a block' do
    (x, y, _, _), = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "blk"; display: block }')
    expect(x).to eq(0)
    expect(y).to be_within(0.01).of(measure('<div id=t>a</div>')[0][3])
  end

  it 'floats a pseudo' do
    (x, _), _, s = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "fl"; float: left; width: 50px }')
    expect(x).to eq(50)
    expect(s.evaluate_script("getComputedStyle(document.getElementById('h'), '::before').width")).to eq('50px')
  end

  it 'takes a positioned pseudo out of the flow' do
    (x, _), = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "abs"; position: absolute; left: 100px }')
    expect(x).to eq(0)
  end

  it 'renders the quote keywords from the default quotes' do
    (x, _), w = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: open-quote } #h::after { content: close-quote }')
    expect(x).to be_within(0.01).of(w.call("“"))
  end

  it 'takes its own font from the pseudo rules and inherits the rest' do
    (x, _), w, s = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "big"; font-size: 32px }')
    expect(x).to be_within(0.01).of(2 * w.call('big'))
    expect(s.evaluate_script("getComputedStyle(document.getElementById('h'), '::before').fontFamily")).to eq('monospace')
  end

  it 'counts the pseudo\'s margins and padding' do
    (x, _), w = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "i"; margin-right: 10px; padding: 0 3px }')
    expect(x).to be_within(0.01).of(w.call('i') + 16)
  end

  it 'keeps a pseudo inside its inline originating element' do
    (x, _), w = measure('<div class=w><span id=t>T</span><span id=h>U</span></div>', '#h::before { content: "p" }')
    expect(x).to eq(0)
    x2 = measure('<div class=w><span id=h>U</span><span id=t>T</span></div>', '#h::before { content: "p" }')[0][0]
    expect(x2).to be_within(0.01).of(w.call('pU'))
  end

  it 'generates nothing on a replaced element' do
    _, _, s = measure('<div class=w><img id=t width=20 height=10><input id=i></div>', 'img::before, input::before { content: "x" }')
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().width")).to eq(20)
    expect(s.evaluate_script("document.getElementById('i').getBoundingClientRect().width")).to eq(measure('<input id=t>')[0][2])
  end

  it 'clears the floats a clearfix ::after is written for' do
    _, _, s = measure('<div id=t><div style="float:left;width:50px;height:30px"></div></div>', '#t::after { content: ""; display: table; clear: both }')
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().height")).to eq(30)
  end

  it 'makes a pseudo a flex item of a flex container' do
    (x, _), w = measure('<div id=h style="display:flex"><div id=t style="width:40px">i</div></div>', '#h::before { content: "fb" }')
    expect(x).to be_within(0.01).of(w.call('fb'))
  end

  it 'hides a display: none pseudo and keeps a visibility: hidden one in the flow' do
    (x, _), = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "gone"; display: none }')
    expect(x).to eq(0)
    (x2, _), w = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "hid"; visibility: hidden }')
    expect(x2).to be_within(0.01).of(w.call('hid'))
  end

  it 'answers the originating element for a hit over the pseudo' do
    _, w, s = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "xx" }')
    expect(s.evaluate_script("document.elementFromPoint(#{w.call('x')}, 5).id")).to eq('h')
  end

  it 'follows a change of the rule that generates it' do
    _, w, s = measure('<div class=w id=h><span id=t>T</span></div>', '.on::before { content: "x" }')
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")).to eq(0)
    s.execute_script("document.getElementById('h').classList.add('on')")
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")).to be_within(0.01).of(w.call('x'))
    s.execute_script("document.getElementById('h').classList.remove('on')")
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")).to eq(0)
  end

  it 'follows a state flip — a checked box shows the label\'s ::before' do
    _, w, s = measure('<div class=w><input type=checkbox id=c><label id=h for=c><span id=t>L</span></label></div>', '#c:checked + label::before { content: "ck" }')
    x0 = s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")
    s.check('c')
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")).to be_within(0.01).of(x0 + w.call('ck'))
    s.uncheck('c')
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().x")).to be_within(0.01).of(x0)
  end

  it 'renders a shadow tree\'s own pseudo rules and keeps the document\'s out' do
    _, _, s = measure('<div id=host></div><span id=t></span>', 'span.lk::before { content: "leak" }')
    s.execute_script(<<~JS)
      var root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.s::before { content: "sh" }</style><span class="s" id="in">T</span><span class="lk" id="in2">T</span>';
    JS
    content = ->(id) { s.evaluate_script("getComputedStyle(document.getElementById('host').shadowRoot.getElementById(#{id.to_json}), '::before').content") }
    expect(content.call('in')).to eq('"sh"')
    expect(content.call('in2')).to eq('none')
    inner = ->(id) { s.evaluate_script("document.getElementById('host').shadowRoot.getElementById(#{id.to_json}).getBoundingClientRect().width") }
    expect(inner.call('in')).to be > inner.call('in2')                  # the in-tree pseudo renders, the leak does not
  end

  it 'answers the element for a hit over a pseudo positioned outside its box' do
    _, _, s = measure('<div class=w style="position:relative"><span id=h style="position:relative"><span id=t>T</span></span></div>',
                      '#h::after { content: "badge"; position: absolute; left: 100px; top: 0 }')
    expect(s.evaluate_script('document.elementFromPoint(110, 5).id')).to eq('h')
  end

  it 'is not in the text Capybara reads' do
    _, _, s = measure('<div class=w id=h><span id=t>T</span></div>', '#h::before { content: "hidden-" }')
    expect(s).to have_text('T')
    expect(s).not_to have_text('hidden-')
  end
end
