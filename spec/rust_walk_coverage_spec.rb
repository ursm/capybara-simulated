# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_golden'
require_relative 'support/chrome_figures'

# Shapes the Rust walk used to decline: it lays each out itself, held to Chrome's figures where a shape names them and
# to its recorded geometry (`expect_layout_golden`) for the rest of the page.
RSpec.describe 'Rust walk coverage' do
  def app(body)
    ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] }
  end

  def page(body)
    s = simulated_session(app(body))
    s.visit '/'
    s
  end

  # An element of no namespace the walk knows is the box its style makes it (an `inline` one here — Chrome: 28.81 x 22
  # for "abc" in 16px monospace), where the walk refused every element outside HTML and the svg root.
  it 'lays a foreign element out as the box its style makes it' do
    s = page('<div id="b" style="font: 16px monospace"></div>')
    s.execute_script(<<~'JS')
      const u = document.createElementNS('urn:x', 'thing');
      u.textContent = 'abc';
      document.getElementById('b').appendChild(u);
    JS
    expect(s.evaluate_script("(r => [r.width, r.height])(document.querySelector('#b > *').getBoundingClientRect())")).to match([be_within(0.02).of(28.81), 22])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and so is one NAMED as an HTML element: a `urn:x` `<img>`, `<br>`, `<div>` or `<option>` is an inline holding its
  # text (Chrome: four 28.81 x 22 boxes on one line), where the JS model, keying its rules on the local name in any
  # namespace, takes each for the HTML element — the walk declined them rather than answer differently from it.
  it 'lays out a foreign element named as an HTML one as the box its style makes it' do
    s = page('<div id="b" style="font: 16px monospace"></div>')
    s.execute_script(<<~'JS')
      const b = document.getElementById('b');
      for (const n of ['img', 'br', 'div', 'option']) { const u = document.createElementNS('urn:x', n); u.textContent = 'abc'; b.appendChild(u); }
    JS
    boxes = s.evaluate_script("[...document.getElementById('b').children].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x * 100) / 100, r.y, Math.round(r.width * 100) / 100, r.height]; })")
    [[8, 8, 28.81, 22], [36.81, 8, 28.81, 22], [65.63, 8, 28.81, 22], [94.44, 8, 28.81, 22]].zip(boxes) do |chrome, box|
      expect(box[1]).to eq(chrome[1])
      expect(box[3]).to eq(chrome[3])
      [0, 2].each {|i| expect(box[i]).to be_within(0.05).of(chrome[i]) }
    end
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # Table boxes a block holds with no table around them are wrapped in an ANONYMOUS table (CSS 2.1 §17.2.1): a block's
  # consecutive orphan rows are ONE table sharing their columns, and a row's content that is no cell one anonymous cell —
  # where the JS model laid each row out as an equal-share flex row and dropped its text. Every figure here is Chrome's.
  it 'wraps orphan table boxes in an anonymous table', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="width: 300px">' \
      '<div id="r1" style="display: table-row"><div>aa</div><div>bbbb</div></div>' \
      '<div id="r2" style="display: table-row">text<div>box</div></div>' \
      '<div id="r4" style="display: table-row">a<br>b</div>' \
      '<div id="r5" style="display: table-row"><div style="display: table-cell">c1</div><div style="display: table-cell">cell2</div></div>' \
      '<div id="r6" style="display: table-row">xx<div style="display: table-cell">cell</div>yy</div>' \
      '<div id="r7" style="display: table-row"></div></div>' \
      '<div style="width: 300px">before <div id="c1" style="display: table-cell">cell</div> after</div>' \
      '<div style="width: 300px; border-spacing: 3px"><div id="c2" style="display: table-cell; padding: 2px; border: 1px solid">a</div>' \
      '<div id="c3" style="display: table-cell">bb</div></div>' \
      '<div style="width: 300px"><div style="display: table-column; width: 50px"></div><div id="c4" style="display: table-cell">x</div></div></body>'
    )
    rect = ->(id) { s.evaluate_script("(() => { const r = document.getElementById('#{id}').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10); })()") }
    got = %w[r1 r2 r4 r5 r6 r7 c1 c2 c3 c4].to_h {|id| [id, rect.call(id)] }
    expect(got).to eq(
      'r1' => [0, 0, 105.6, 44], 'r2' => [0, 44, 105.6, 44], 'r4' => [0, 88, 105.6, 44], 'r5' => [0, 132, 105.6, 22],
      'r6' => [0, 154, 105.6, 22], 'r7' => [0, 176, 105.6, 0], 'c1' => [0, 198, 38.4, 22], 'c2' => [3, 245, 15.6, 28],
      'c3' => [21.6, 245, 19.2, 28], 'c4' => [0, 276, 50, 22]
    )
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and what makes no table box stays out of it: a replaced element or a control with a table display is an inline-level
  # box on the line (CSS Tables 3 §2.1; Firefox — Chrome blocks an `<img>`), a row inside an orphan row is the anonymous
  # cell's own anonymous table, and columns over no row are as wide as they declare (Chrome: 19.2 for the nested cell,
  # 50 for the column — whose own box reads 0, as a real table's `<col>` does here). (A row group of NO row is as tall as
  # it declares in Chrome — 0 x 30, with no spacing slot of its own — and no height at all in Firefox; it is Firefox's
  # here, recorded.)
  it 'keeps replaced elements out of an anonymous table and lays out its edge cases', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0">' \
      '<div id="w6" style="width: 300px"><img id="i1" style="display: table-cell; width: 20px; height: 20px"><canvas id="i2" style="display: table-cell" width="30" height="10"></canvas></div>' \
      '<div style="width: 300px"><div style="display: table-row"><div style="display: table-row"><div id="x3" style="display: table-cell">xx</div></div></div></div>' \
      '<div id="w1" style="width: 300px"><div style="display: table-column; width: 50px"></div>after</div></body>'
    )
    rect = ->(id) { s.evaluate_script("(() => { const r = document.getElementById('#{id}').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10); })()") }
    expect(rect.call('i1')[0, 1] + rect.call('i2')[0, 1]).to eq([0, 20])       # (…side by side: img at 0, canvas at 20)
    expect(rect.call('x3')[2]).to eq(19.2)
    expect(rect.call('w1')[3]).to eq(22)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A row whose cells all span rows is as tall as it declares, or nothing, and what the spanning cells need past it goes
  # to the last row they cover (Chrome: two `rowspan=2` cells over an empty row leave the first row 0 tall, the second 24)
  # — where the walk declined the table.
  it 'lays out a row of nothing but spanning cells' do
    s = page('<body style="font: 16px monospace; margin: 0"><table style="border-spacing: 0"><tr id="a"><td rowspan="2">a</td><td rowspan="2">b</td></tr><tr id="b"></tr></table></body>')
    expect(s.evaluate_script('[a.getBoundingClientRect().height, b.getBoundingClientRect().height]')).to eq([0, 24])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and a table of rows holding no cell at all has no columns, and spaces nothing (Chrome: a `border-spacing: 5px` table
  # bordered 3px around one 20px row is 6 x 26; two empty rows are 0 x 0).
  it 'lays out a table of empty rows with no spacing' do
    s = page(
      '<body style="margin: 0"><table id="b"><tr></tr><tr></tr></table>' \
      '<table id="c" style="border: 3px solid; border-spacing: 5px"><tr style="height: 20px"></tr></table></body>'
    )
    expect(s.evaluate_script("['b', 'c'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.width, r.height]; })")).to eq([[0, 0], [6, 26]])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # An `<object>` is the default object size where it shows a resource and the box its style makes it where it shows its
  # fallback; an `<embed>` with no resource is no box at all (Chrome, `uaNotRendered`).
  it 'lays out an object, its fallback, and no src-less embed' do
    body = '<div style="font: 16px monospace"><object data="x.png"></object><object><span>fallback</span></object>' \
           '<embed type="text/plain"><object id="nbsp">&nbsp;</object><p>after</p></div>'
    expect_layout_golden(body, app: app(body))
    s = page(body)
    expect(s.evaluate_script("(r => [r.width, r.height])(document.querySelector('embed').getBoundingClientRect())")).to eq([0, 0])
    # (…an NBSP is fallback content, not white space: an inline 9.61 wide in Chrome, where the JS model's `\S` made it
    # the 300 x 150 replaced box)
    expect(s.evaluate_script('nbsp.getBoundingClientRect().width')).to be_within(0.02).of(9.61)
  end

  # An intrinsic-size keyword on a replaced element is its intrinsic width; `stretch` is an auto width, a block's filling
  # its containing block.
  it 'lays out keyword widths on controls and a stretch width' do
    body = '<div style="width: 300px; font: 16px monospace"><input type="date" style="width: min-content">' \
           '<input type="range" style="display: block; width: max-content"><div style="width: stretch; margin: 0 7px">x</div></div>'
    expect_layout_golden(body, app: app(body))
  end

  # A fixed box inside a TRANSFORMED row or row group has that part for its containing block (Chrome: 11,115 and
  # 53.2,152 for these two), which the walk could not name: a table part's record was in no index.
  it 'lays out a fixed box inside a transformed table part' do
    body = '<body style="margin: 0; font: 16px monospace"><div style="height: 50px"></div><table style="border-spacing: 4px"><thead><tr><td>head</td></tr></thead>' \
           '<tbody style="transform: translate(0)"><tr><td>row one</td></tr><tr style="transform: translateX(0)"><td>two' \
           '<div id="f1" style="position: fixed; top: 5px; left: 7px; width: 20px; height: 10px"></div></td></tr></tbody>' \
           '<tfoot style="transform: translate(0)"><tr><td>foot<div id="f2" style="position: fixed; bottom: 0; right: 0; width: 20px; height: 10px"></div>' \
           '</td></tr></tfoot></table></body>'
    expect_layout_golden(body, app: app(body))
    fixed = page(body).evaluate_script("['f1', 'f2'].map((id) => (r => [Math.round(r.x * 100) / 100, r.y])(document.getElementById(id).getBoundingClientRect()))")
    expect(fixed).to eq([[11, 115], [53.2, 152]])
  end

  # A `<ruby>` is an inline box, its annotation on the line beside its base (Chrome puts the annotation above: a
  # divergence recorded).
  it 'lays out ruby markup' do
    body = '<p style="font: 16px monospace; width: 120px">some text <ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby> more text</p>'
    expect_layout_golden(body, app: app(body))
  end

  # A ruby display an AUTHOR gives is laid out natively, where the walk declined every one but the UA's own: an inline
  # box (the spec and Chrome; the JS model made it a block) — a `<fieldset>` so displayed is the inline-block HTML makes
  # an inline-level widget — but an internal ruby display on a `<button>` is the flow-root block HTML's button layout
  # makes it (`button-layout/display-other`, `fieldset-display-ruby`).
  it 'lays out an author ruby display', :aggregate_failures do
    s = page(
      '<div style="font: 16px monospace"><div id="r" style="display: ruby">ruby</div>' \
      '<fieldset id="f" style="display: ruby-base">x</fieldset><fieldset id="fi" style="display: inline-block">x</fieldset>' \
      '<div style="float: left; width: 100px; height: 100px; margin: 10px"></div><button id="b" style="display: ruby-base"><div style="float: left; width: 100px; height: 100px; margin: 10px"></div></button><span id="a">after</span></div>'
    )
    rect = ->(id) { s.evaluate_script("(() => { const r = document.getElementById('#{id}').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()") }
    expect(rect.call('r')[2]).to be_within(0.01).of(38.4)
    expect(rect.call('f')[2]).to eq(rect.call('fi')[2])
    expect(s.evaluate_script('[b.offsetLeft, b.clientWidth >= 120, a.offsetLeft, a.offsetTop >= 120]')).to eq([128, true, 8, true])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and the viewport scrolls from where the root sits: a `vertical-rl` page wider than the viewport, or an rtl one, is
  # reached by NEGATIVE offsets (CSSOM View §6), where the left of it was out of reach — Chrome: scrollWidth 2016,
  # `scrollTo(-500, 0)` at -500, `scrollIntoView` of a box at the far left at -984 (the box then at 0); rtl 2008 / -500.
  it 'scrolls a page that starts at the right with negative offsets', :aggregate_failures do
    probe = lambda {|html_attrs|
      s = page(
        "<html #{html_attrs}><body><div style=\"width: 2000px; height: 30px; writing-mode: horizontal-tb\">" \
        '<span id="m" style="display: inline-block; width: 10px; height: 10px"></span></div></body></html>'
      )
      s.evaluate_script(<<~'JS')
        (() => {
          const r = [document.scrollingElement.scrollWidth];
          window.scrollTo(-500, 0); r.push(window.scrollX);
          window.scrollTo(0, 0);
          m.scrollIntoView(); r.push(window.scrollX, Math.round(m.getBoundingClientRect().x));
          return r;
        })()
      JS
    }
    expect(probe.call('style="writing-mode: vertical-rl; font: 16px monospace"')).to eq([2016, -500, -984, 0])
    expect(probe.call('dir="rtl" style="font: 16px monospace"')).to eq([2008, -500, 0, 1006])
  end

  # A fieldset's RENDERED legend is a block box to the readers whatever inline-level display it declares (HTML blockifies
  # it): transformed, with a client box and a transform origin (Chrome: x 23, clientWidth 23, `11.6px 11px`).
  it 'reads a rendered legend as the block it is laid out as' do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><fieldset><legend id="l" style="display: ruby; transform: translateX(7px)">lg</legend>c</fieldset></body>'
    )
    expect(s.evaluate_script('[Math.round(l.getBoundingClientRect().x), l.clientWidth, getComputedStyle(l).transformOrigin]')).to eq([23, 23, '11.6px 11px'])
  end

  # …and the walk lays it out as one: its own width and `auto` margins apply whatever inline-level display it declares
  # (Chrome: 104 wide for `width: 100px` under `display: inline` or `ruby`, pushed to 976.8 by `margin-left: auto`), where
  # the walk sized it from its text.
  it 'lays a rendered legend with an inline-level display out as a block' do
    s = page(
      '<body style="font: 16px monospace"><fieldset><legend id="a" style="display: inline; width: 100px">pd</legend>c</fieldset>' \
      '<fieldset><legend id="c" style="display: ruby; width: 100px">pd</legend>c</fieldset>' \
      '<fieldset><legend id="d" style="display: inline; margin-left: auto">rt</legend>c</fieldset></body>'
    )
    expect(s.evaluate_script("[a, c, d].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x * 10) / 10, Math.round(r.width * 10) / 10]; })")).to eq([[24, 104], [24, 104], [976.8, 23.2]])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and the JS side's geometry readers take a ruby display for the inline box the walk lays it out as: a transform does
  # not apply to it and it has no client box (Chrome: x 19.2, clientWidth 0 for a `display: ruby` span after "xx" with
  # `transform: translateX(50px)` and `overflow: hidden`), where they took it for a block (69.2, 77). A `<button>` with
  # `display: table-row` is no orphan row but the flow-root of HTML's button layout (`button-layout/shrink-wrap`: 100
  # wide in 50px of room, its widest inline-block's).
  it 'reads a ruby display as an inline box, and a table-row button as a button', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div>xx<span id="t" style="display: ruby; transform: translateX(50px); ' \
      'overflow: hidden; width: 5px">ruby</span></div><div style="width: 50px"><button id="b" style="display: table-row; border: none; ' \
      'padding: 0"><span style="display: inline-block; width: 100px">x</span><span style="display: inline-block; width: 50px">x</span></button></div></body>'
    )
    expect(s.evaluate_script('[t.getBoundingClientRect().x, t.clientWidth, b.clientWidth]')).to eq([19.2, 0, 100])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and an element of another namespace named like an image, a video or an input is none of them to those readers
  # either: no replaced box a transform moves (Chrome: a `urn:x` `<img class=t>` stays at 19.2 under
  # `x|*.t { transform: translateX(50px) }`, its clientWidth 0).
  it 'reads a foreign element named as a replaced one as the inline box it is', :aggregate_failures do
    s = page(
      '<style>@namespace x url(urn:x); x|*.t { transform: translateX(50px) }</style><body style="font: 16px monospace; margin: 0">' \
      '<div id="host">aa</div></body>'
    )
    s.execute_script(<<~'JS')
      for (const n of ['img', 'video', 'input']) {
        const e = document.createElementNS('urn:x', n); e.id = n; e.setAttribute('class', 't'); e.textContent = n;
        const d = document.createElement('div'); d.append('aa', e); document.body.append(d);
      }
    JS
    expect(s.evaluate_script("['img', 'video', 'input'].map((n) => [Math.round(document.getElementById(n).getBoundingClientRect().x * 100) / 100, document.getElementById(n).clientWidth])")).to eq([[19.2, 0]] * 3)
  end

  # MathML is laid out natively, where the walk declined every MathML element: `display: math` is no value the style
  # engine has, so an inline `<math>` is the inline its style makes it, its row along the line (Chrome: at 19.1, 33.4
  # wide), and a `display=block` one a block of its own (1008 wide, on a line of its own).
  it 'lays out MathML as inline rows and block math', :aggregate_failures do
    s = page(
      '<body style="font: 16px serif"><p>a <math id="m1"><mi>x</mi><mo>+</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></math> b</p>' \
      '<math id="m2" display="block"><mi>y</mi><msup><mi>e</mi><mn>2</mn></msup></math></body>'
    )
    m1, m2 = s.evaluate_script("[m1, m2].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x * 10) / 10, Math.round(r.width * 10) / 10]; })")
    expect(m1[0]).to eq(19.1)
    expect(m1[1]).to be_within(1).of(33.4)
    expect(m2).to eq([8, 1008])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and MathML Core's user-agent sheet as far as the style engine has its values: only the first child of a `semantics`
  # or an `maction` renders (the TeX a converter annotates its markup with is no text: Chrome's innerText has no `x^2`),
  # a phantom is hidden, a table a table.
  it "renders MathML by MathML Core's user-agent sheet", :aggregate_failures do
    s = page(
      '<p id="p">a <math><semantics><mrow><mi>x</mi><mphantom id="ph"><mi>p</mi></mphantom></mrow><annotation id="an">x^2</annotation></semantics>' \
      '<maction><mi>A</mi><mi id="mb">B</mi></maction><mtable id="t"><mtr><mtd><mi>t</mi></mtd></mtr></mtable></math> b</p>'
    )
    expect(s.evaluate_script('[getComputedStyle(an).display, getComputedStyle(mb).display, getComputedStyle(ph).visibility, getComputedStyle(t).display]')).to eq(%w[none none hidden inline-table])
    expect(s.evaluate_script('p.innerText')).not_to include('x^2', 'B')
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A value the walk has no model for is the one it falls back to, where the walk declined the page: an `anchor()` inset
  # and an `anchor-size()` margin with no anchor are invalid at computed-value time (`auto`, 0), a `subgrid` on no grid
  # item of a grid is `none`, and a `flex-basis: stretch` fills the row before the line shrinks it (Chrome: 10,0 for the
  # anchored box, 50 down for the margin, 290.4 for the basis beside a 9.6 item, 300 for the grid's one column).
  it 'answers values it has no model for with their fallback', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="position: relative; width: 300px; height: 50px">' \
      '<div id="a1" style="position: absolute; top: anchor(--a top); left: 10px">x</div></div>' \
      '<div id="a2" style="margin-top: anchor-size(--a height); width: 50px">y</div>' \
      '<div style="display: flex; width: 300px"><div id="a3" style="flex-basis: stretch">fb</div><div>z</div></div>' \
      '<div style="display: grid; grid-template-columns: subgrid; width: 300px"><div id="a4">g</div></div></body>'
    )
    rect = ->(id) { s.evaluate_script("(() => { const r = document.getElementById('#{id}').getBoundingClientRect(); return [r.x, r.y, r.width].map((v) => Math.round(v * 10) / 10); })()") }
    expect(%w[a1 a2 a3 a4].map(&rect)).to eq([[10, 0, 9.6], [0, 50, 50], [0, 72, 290.4], [0, 94, 300]])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and an anchor function's FALLBACK where it gives one (Chrome: `top: anchor(--a bottom, 30px); left: anchor(--a
  # right, 40px)` at 40,30; a relative box's 15 down; a margin's 25 across), a `fit-content(<length>)` width the `auto`
  # the walk takes it for, and a `nowrap` keeping its breaks two unwrapped lines (44 tall in 50px).
  it 'answers anchor fallbacks and odd sizes', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="position: relative; width: 300px; height: 60px">' \
      '<div id="a" style="position: absolute; top: anchor(--a bottom, 30px); left: anchor(--a right, 40px)">x</div></div>' \
      '<div id="b" style="position: relative; top: anchor(--a bottom, 15px); width: 50px">y</div>' \
      '<div id="c" style="margin-left: anchor-size(--a width, 25px); width: 50px">z</div>' \
      '<div style="width: 300px"><div id="d" style="width: fit-content(500px)">short</div></div>' \
      "<div id=\"e\" style=\"white-space-collapse: preserve-breaks; text-wrap-mode: nowrap; width: 50px\">aaaa bbbb cccc\ndd</div></body>"
    )
    rect = ->(id) { s.evaluate_script("(() => { const r = document.getElementById('#{id}').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10); })()") }
    expect(%w[a b c].map {|id| rect.call(id)[0, 2] }).to eq([[40, 30], [0, 75], [25, 82]])
    expect(rect.call('d')[2]).to eq(300)
    expect(rect.call('e')[3]).to eq(44)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and every `vertical-align` the style engine computes is a box the walk places: `central` / `center` the middle, the
  # other baselines the one a face's metrics give, an alignment with a shift aligned and then shifted (CSS Inline 3;
  # Chrome knows none of them on an HTML box and computes `baseline`).
  it 'places every vertical-align' do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div>a<span style="alignment-baseline: central">b</span>' \
      '<span style="alignment-baseline: alphabetic">d</span><span style="vertical-align: center">e</span>' \
      '<span style="alignment-baseline: middle; baseline-shift: 3px">f</span></div></body>'
    )
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A COMPRESSIBLE replaced box contributes nothing to min-content (CSS Sizing 3 §5.2.2): one sized by a percentage width,
  # and an image-like one by a percentage max-width too, whatever width it declares — a control's `max-width: 100%` is
  # no such thing (Chrome: a float around a `max-width: 100%` input is 185 in 100px of room, around a `width: 100%` one,
  # a canvas, a `width: 300px; max-width: 100%` image, a src-less `width=300` one or a video 100, around a textarea 201,
  # a list box 122.5, a 150px meter 150, a progress 160).
  # A ZWJ joins two pictographs into one cluster (UAX #29 GB11) and nothing else, and `word-break: break-all` text holding
  # one is laid out natively.
  it 'squeezes compressible replaced boxes and keeps ZWJ sequences whole', :aggregate_failures do
    boxes = [
      '<input style="max-width: 100%">',
      '<input style="width: 100%">',
      '<canvas width="300" height="10" style="max-width: 100%"></canvas>',
      '<img style="max-width: 100%; width: 300px; height: 10px">',
      '<img width="300" height="10" style="max-width: 100%">',
      '<video style="max-width: 100%"></video>',
      '<textarea style="max-width: 100%"></textarea>',
      '<select size="3" style="max-width: 100%"><option>a long option text</option></select>',
      '<meter style="max-width: 100%; width: 150px"></meter>',
      '<progress style="max-width: 100%"></progress>'
    ]
    floats = boxes.each_with_index.map {|el, i| %(<div style="width: 100px"><div id="f#{i}" style="float: left">#{el}</div></div><div style="clear: both"></div>) }
    s = page(
      %(<body style="font: 16px monospace; margin: 0">#{floats.join}) +
      '<div style="width: 30px; word-break: break-all"><span id="z">ab&zwj;cd&zwj;ef</span></div>' \
      '<span id="y">abc&zwj;def</span><div style="width: 30px; word-break: break-all"><span id="x">&#x1F468;&zwj;&#x1F469;&zwj;&#x1F467; x</span></div></body>'
    )
    expect(s.evaluate_script("[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => Math.round(document.getElementById('f' + i).getBoundingClientRect().width * 10) / 10)")).to eq([185, 100, 100, 100, 100, 100, 201, 122.6, 150, 160])
    # (…a ZWJ between letters joins nothing — `abc‍def` keeps every advance, 57.6, and break-all breaks around one — where
    # one between pictographs binds the family into one unit, on one line, `x` on the next: Chrome's 2, 57.6, 2)
    expect(s.evaluate_script('[z.getClientRects().length, Math.round(y.getBoundingClientRect().width * 10) / 10, x.getClientRects().length]')).to eq([2, 57.6, 2])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and the two rules a joiner is broken by: LINE breaking never breaks after one (UAX #14 LB8a — `漢‍字‍か` and `c‍d` are
  # units under break-all, as Chrome makes them: 48 and 19.2 wide at min-content), an emergency break inside a word
  # (`overflow-wrap: anywhere`) falls between grapheme clusters, where a joiner joins only pictographs, through any
  # modifier or selector after the first (UAX #29 GB9 / GB11: `c‍d` breaks, 9.6; `👩🏽‍💻` and `🏳️‍🌈` stay whole).
  it 'breaks text holding a joiner as line breaking and grapheme clusters do', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="width: min-content" id="a">漢&zwj;字&zwj;か な</div>' \
      '<div style="width: min-content; word-break: break-all" id="b">abc&zwj;def ghi&zwj;jkl</div>' \
      '<div style="width: min-content; overflow-wrap: anywhere" id="c">abc&zwj;def ghi&zwj;jkl</div>' \
      '<div style="width: 30px; word-break: break-all" id="d">ab 👋🏽 👩🏽&zwj;💻 cd</div></body>'
    )
    sizes = s.evaluate_script("['a', 'b', 'c', 'd'].map((i) => { const r = document.getElementById(i).getBoundingClientRect(); return [Math.round(r.width * 10) / 10, r.height]; })")
    expect(sizes.map(&:first)).to eq([48, 19.2, 9.6, 30])
    expect(sizes.drop(1).map(&:last)).to eq([132, 264, 88])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …an emergency break falls at a grapheme boundary however the unit is cut — `漢‍字‍か な` under `overflow-wrap: anywhere`
  # breaks into 4 lines in 20px, 16 at min-content — and a word broken per character is measured SPACED, as the line
  # lays it out: letter-spacing follows every character, an emoji's modifier joining its glyph (Chrome: `r abc s` under
  # `letter-spacing: 3px; word-break: break-all` is one 88.2-wide line, which unspaced units measured at 73.2 and wrapped).
  it 'breaks and spaces per-character text as the line lays it out', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="width: 20px; overflow-wrap: anywhere"><span id="a">漢&zwj;字&zwj;か な</span></div>' \
      '<div style="width: min-content; overflow-wrap: anywhere" id="b">漢&zwj;字&zwj;か な</div>' \
      '<div style="float: left; letter-spacing: 3px; word-break: break-all" id="c">r abc s</div></body>'
    )
    expect(s.evaluate_script('[a.getClientRects().length, b.getBoundingClientRect().width, Math.round(c.getBoundingClientRect().width * 10) / 10, c.getBoundingClientRect().height]')).to eq([4, 16, 88.2, 22])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A LIST BOX is a flex item like any control — its own box from the control's data, its rows inside it, the width the
  # flex container gives it (Chrome: 43.3 in a row; stretched to 300 across a column) — where the walk declined it.
  it 'lays out a list box as a flex item' do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="display: flex; width: 300px"><select id="a" size="3"><option>aaa</option><option>b</option></select><div>x</div></div>' \
      '<div style="display: flex; flex-direction: column; width: 300px"><select id="b" size="2"><option>one</option><option>two</option></select></div></body>'
    )
    expect(s.evaluate_script('[Math.round(a.getBoundingClientRect().width * 10) / 10, b.getBoundingClientRect().width]')).to eq([43.2, 300])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A word running through an inline element is ONE word: under `word-break: break-all`, where every boundary between
  # characters is an ordinary opportunity, its characters break wherever the whole word's would, the element's edge
  # included (Chrome: `ab<b>cd</b>ef` is three 19.2 lines in 20px, 9.6 at min-content) — where the glued piece overflowed
  # its line whole. (`anywhere` / `break-word` break inside a word only as a last resort, taking an earlier opportunity on
  # the line first and carrying the word's placed head down with it — which a greedy line cannot take back: recorded.)
  it 'breaks a word running through an inline element under break-all', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="width: 20px; word-break: break-all"><span id="a">ab<b>cd</b>ef</span></div>' \
      '<div style="width: min-content; word-break: break-all" id="b"><span>ab<b>cd</b>ef</span></div></body>'
    )
    expect(s.evaluate_script('[a.getClientRects().length, b.getBoundingClientRect().width]')).to eq([3, 9.6])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and a word that fits the band but not the ROOM left on the line is cut there too, filling the line: break-all never
  # needs a fresh line (Chrome: `aa bbbc` in 50px is "aa bb" / "bc", and `aa bbb<b>cdef</b>` is two lines, where the head
  # moved down whole and the tail took a third). The room is what is left past the edges the word opens: `abc<b
  # style="padding-left:5px">d</b>` in 40px puts the `d` on the second line (y 110 below the first two), where it
  # overflowed the first.
  it 'fills the line with a break-all word the room left on it does not hold', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="word-break: break-all">' \
      '<div style="width: 50px"><b id="a">aa bbbc</b></div>' \
      '<div style="width: 50px" id="b">aa bbb<b>cdef</b></div>' \
      '<div style="width: 40px">abc<b id="c" style="padding-left: 5px">d</b></div></div></body>'
    )
    expect(s.evaluate_script(<<~JS)).to eq([[48, 19.2], 44, [0, 110]])
      [[...a.getClientRects()].map((r) => +r.width.toFixed(2)), b.getBoundingClientRect().height, [c.getBoundingClientRect().x, c.getBoundingClientRect().y]]
    JS
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # break-all makes letters breakable, not punctuation (UAX #14 as CSS Text 3 §5.2 applies it): no break before a closing
  # mark or after an opening one, none on either side of a quotation mark. Chrome: `abc.` in 30px is "ab" / "c.", `ab"cd`
  # is "a" / `b"c` / "d", and the min-content of `ab.` and `(ab)` is 19.2 — where each character was a unit of its own.
  it 'keeps punctuation with the letter it belongs to under break-all', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="word-break: break-all">' \
      '<div style="width: 30px"><b id="a">abc.</b></div>' \
      '<div style="width: 30px"><b id="b">ab&quot;cd</b></div>' \
      '<div style="width: min-content" id="c">ab.</div><div style="width: min-content" id="d">(ab)</div></div></body>'
    )
    expect(s.evaluate_script(<<~JS)).to eq([[19.2, 19.2], [9.6, 28.8, 9.6], 19.2, 19.2])
      [
        [...a.getClientRects()].map((r) => +r.width.toFixed(2)),
        [...b.getClientRects()].map((r) => +r.width.toFixed(2)),
        +c.getBoundingClientRect().width.toFixed(2),
        +d.getBoundingClientRect().width.toFixed(2)
      ]
    JS
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A line breaks after no no-break space — U+00A0, U+2007, U+202F — across an element's edge either (Chrome keeps
  # `ab&nbsp;<b>cd</b>` on one 22-tall line in 30px), and a word joiner
  # or a bidi isolate has no advance (Chrome: `a&#x2060;b&#x2066;c` is 28.8 wide, where each drew a 9.6 glyph).
  it 'breaks after no no-break space and draws no format character', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0">' \
      '<div style="width: 30px" id="a">ab&nbsp;<b>cd</b></div><div style="width: 30px" id="b">ab&#x202F;<b>cd</b></div>' \
      '<span id="c">a&#x2060;b&#x2066;c</span></body>'
    )
    expect(s.evaluate_script(<<~JS)).to eq([22, 22, 28.8])
      [a.getBoundingClientRect().height, b.getBoundingClientRect().height, +c.getBoundingClientRect().width.toFixed(2)]
    JS
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # What break-all glues it glues by the character a mark ATTACHES to (LB9: `"&#x301;` is a quotation mark), and a
  # currency sign to what follows and a `%` to what precedes (LB23a / LB25); a run ENDING in a zero width space leaves an
  # opportunity like any space. And a declared `overflow-wrap` still breaks a glued unit wider than the band: `.......`
  # under break-all + anywhere is three lines in Chrome (one, overflowing, under break-all alone), and its min-content
  # counts those emergency breaks (`ab.` is 9.6) — taken on a fresh line, as an emergency break is taken only where the
  # line has no other: `ab.......` is "a" / "b.." / "..." / "..". Chrome: 66 for `ab"&#x301;cd` in 30px, "ab" / "$cd",
  # "ab" / "c%d", 66 for `xx ab&#x200B;<b>cdcd</b>` in 40px.
  it 'glues by the base character, and lets overflow-wrap break what break-all glues', :aggregate_failures do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div style="word-break: break-all">' \
      '<div style="width: 30px" id="a">ab"&#x301;cd</div>' \
      '<div style="width: 30px"><b id="b">ab$cd</b></div><div style="width: 30px"><b id="c">abc%d</b></div>' \
      '<div style="width: 30px; overflow-wrap: anywhere"><b id="d">.......</b></div>' \
      '<div style="width: 30px; overflow-wrap: anywhere"><b id="g">ab.......</b></div>' \
      '<div style="width: min-content; overflow-wrap: anywhere" id="e">ab.</div></div>' \
      '<div style="width: 40px" id="f">xx ab&#x200B;<b>cdcd</b></div></body>'
    )
    expect(s.evaluate_script(<<~JS)).to eq([66, [19.2, 28.8], [19.2, 28.8], [28.8, 28.8, 9.6], [9.6, 28.8, 28.8, 19.2], 9.6, 66])
      [
        a.getBoundingClientRect().height,
        [...b.getClientRects()].map((r) => +r.width.toFixed(2)),
        [...c.getClientRects()].map((r) => +r.width.toFixed(2)),
        [...d.getClientRects()].map((r) => +r.width.toFixed(2)),
        [...g.getClientRects()].map((r) => +r.width.toFixed(2)),
        +e.getBoundingClientRect().width.toFixed(2),
        f.getBoundingClientRect().height
      ]
    JS
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A node of nothing but soft hyphens under `hyphens: none` is a zero-wide word that still makes its line (Chrome: 22
  # tall), and a preserved node of nothing but a CR under a text indent is laid out as nothing (Chrome measures the indent
  # into a shrink-to-fit width — 20 — which goes unmeasured here) — where the walk declined both.
  it 'lays out text made of characters that are not there' do
    s = page(
      '<body style="font: 16px monospace; margin: 0"><div id="a" style="hyphens: none">&shy;</div>' \
      '<div style="float: left"><pre style="text-indent: 20px; margin: 0">&#13;</pre></div></body>'
    )
    expect(s.evaluate_script('a.getBoundingClientRect().height')).to eq(22)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A root element in a vertical writing mode is sized as every vertical block is — its auto width from its content —
  # and placed at its margins, not given the initial containing block's width at 0,0 whatever its margins say. Chrome
  # (800px window): `vertical-lr` puts the html at 7,5 and 109 wide, its columns'; a `vertical-rl` one sits at the RIGHT
  # edge (684), which no box here does — vertical flow is not laid out.
  it 'lays out a root element in a vertical writing mode' do
    s = page(
      '<html style="writing-mode: vertical-lr; margin: 5px 7px; font: 16px monospace"><body style="margin: 3px">' \
      '<div>abc</div><div style="width: 30px; height: 40px"></div><p>hello world</p></body></html>'
    )
    html, body = s.evaluate_script("['html', 'body'].map((t) => { const r = document.querySelector(t).getBoundingClientRect(); return [r.x, r.y, r.width]; })")
    expect(html[0, 2]).to eq([7, 5])
    expect(html[2]).to eq(body[2] + 6)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …where it STARTS: a `vertical-rl` root against the right edge of the initial containing block (Chrome: 979 for a
  # 45-wide html), a `vertical-lr` one against the left whatever its `direction` says (in a vertical mode the horizontal
  # axis is the block axis) — and a root with a child ORTHOGONAL to it as wide as the initial containing block: a
  # horizontal body's inline size is the ICB's (CSS Writing Modes 3 §7.3; Chrome: html 1024, body and its blocks 1008, a
  # 50% one 504), where the root's own content width made it 38.4.
  it 'places a vertical root at its start edge and fills it for an orthogonal child', :aggregate_failures do
    boxes = lambda {|html|
      s = page(html)
      expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
      s.evaluate_script("[...document.querySelectorAll('html, body, div')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x * 100) / 100, Math.round(r.width * 100) / 100]; })")
    }
    expect(boxes.call('<html style="writing-mode: vertical-rl; font: 16px monospace"><body>abc</body></html>')).to eq([[979.2, 44.8], [987.2, 28.8]])
    expect(boxes.call('<html dir="rtl" style="writing-mode: vertical-lr; font: 16px monospace"><body>abc</body></html>')).to eq([[0, 44.8], [8, 28.8]])
    expect(boxes.call(
      '<html style="writing-mode: vertical-lr; font: 16px monospace"><body style="writing-mode: horizontal-tb">' \
      '<div style="text-align: center">abc</div><div style="width: 50%">half</div></body></html>'
    )).to eq([[0, 1024], [8, 1008], [8, 1008], [8, 504]])
  end

  # A face the page adds through the `FontFace` API is measured natively: its `size-adjust` reads 100% — the identity —
  # where it sets none, which was taken for a metric descriptor and declined every such face.
  it 'lays out text in a FontFace face' do
    ahem = File.binread(File.join(__dir__, 'wpt/fonts/Ahem.ttf'))
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [ahem]] if env['PATH_INFO'] == '/Ahem.ttf'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><span id="t" style="font: 20px custom-font, monospace">abc</span>']]
    })
    s.visit '/'
    s.execute_script("document.fonts.add(new FontFace('custom-font', 'url(/Ahem.ttf)')); document.getElementById('t').style.color = 'red';")
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().width")).to eq(60)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and an `@font-face` with metric descriptors: its `size-adjust` scales every advance (a face of its own natively,
  # `registerFontScaled`), its overrides the line box — 6 Ahem characters at 20px x 150% are 180 wide.
  it 'lays out text in a face with metric descriptors' do
    ahem = File.binread(File.join(__dir__, 'wpt/fonts/Ahem.ttf'))
    css = '@font-face { font-family: a150; src: url(/Ahem.ttf); size-adjust: 150%; ascent-override: 90%; }'
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [ahem]] if env['PATH_INFO'] == '/Ahem.ttf'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><style>#{css}</style><span id=\"t\" style=\"font: 20px a150, monospace\">abc de</span>"]]
    })
    s.visit '/'
    s.execute_script("document.body.style.color = 'red'")
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().width")).to eq(180)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A family whose `@font-face`s split a run by `unicode-range` — Ahem for A–Z, Lato at 120% for a–z, the system font for
  # the rest — is one face natively (`registerFontStack`), each character measured by the first face covering it.
  it 'lays out text in a unicode-range split' do
    dir = File.join(__dir__, 'wpt/fonts')
    files = {'/Ahem.ttf' => File.binread("#{dir}/Ahem.ttf"), '/Lato.ttf' => File.binread("#{dir}/Lato-Medium.ttf")}
    css = '@font-face { font-family: F; src: url(/Ahem.ttf); unicode-range: U+0041-005A; } ' \
          '@font-face { font-family: F; src: url(/Lato.ttf); unicode-range: U+0061-007A; size-adjust: 120%; }'
    body = %w[ABC abc AbC].map {|t| %(<div style="font: 20px F, monospace; width: 300px"><span>#{t} #{t}</span></div>) }.join
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [files[env['PATH_INFO']]]] if files.key?(env['PATH_INFO'])

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><style>#{css}</style>#{body}"]]
    })
    s.visit '/'
    s.execute_script("document.body.style.color = 'red'")
    widths = s.evaluate_script("[...document.querySelectorAll('span')].map((e) => Math.round(e.getBoundingClientRect().width * 100) / 100)")
    expect(widths).to eq([132, 85.92, 118.98])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and a split's faces RAISE the line a run's characters select them on, each laid out as a face of its own would be,
  # where the walk took the line box from the primary face alone: Ahem at 150% for A–Z, under a Lato primary for a–z,
  # puts "ab ABC cd ef gh ij kl" on two 30px lines (Chrome 55: it raises only the LINE the tall face is on, where this
  # driver raises every line of the text node — a divergence recorded). A `ch`
  # is the primary face's — Lato at 120%, the face covering `0` — not the system font a character no face covers falls to
  # (Chrome: 139.19 for 10ch, where the system font's `0` gave 120).
  it "raises a split's line box to the faces its characters select", :aggregate_failures do
    dir = File.join(__dir__, 'wpt/fonts')
    files = {'/Ahem.ttf' => File.binread("#{dir}/Ahem.ttf"), '/Lato.ttf' => File.binread("#{dir}/Lato-Medium.ttf")}
    css = '@font-face { font-family: F; src: url(/Ahem.ttf); unicode-range: U+0041-005A; size-adjust: 150%; } ' \
          '@font-face { font-family: F; src: url(/Lato.ttf); unicode-range: U+0061-007A; } ' \
          '@font-face { font-family: G; src: url(/Lato.ttf); unicode-range: U+0000-00FF; size-adjust: 120%; }'
    body = '<div style="font: 20px F, sans-serif; width: 120px">ab ABC cd ef gh ij kl</div>' \
           '<div style="font: 20px G, sans-serif; width: 300px">abc → 漢字 def</div><div style="font: 20px G, sans-serif; width: 10ch"></div>'
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [files[env['PATH_INFO']]]] if files.key?(env['PATH_INFO'])

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><style>#{css}</style><body style=\"margin: 0\">#{body}</body>"]]
    })
    s.visit '/'
    s.execute_script("document.body.style.color = 'red'")
    sizes = s.evaluate_script("[...document.querySelectorAll('div')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width * 100) / 100, r.height]; })")
    expect(sizes).to eq([[120, 60], [300, 29], [139.2, 0]])
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …asked of each text node of its data as WRITTEN (a preserved CR, a soft hyphen under `hyphens:
  # none` — characters the line never lays out — still select their face), and never of white space that collapses to a
  # gap between two boxes (one space on the owner's own line box). The `ch` of a stack whose own face is a `local()` one
  # with a metric descriptor is that face's.
  it 'asks a split for the line box of each text node as written', :aggregate_failures do
    dir = File.join(__dir__, 'wpt/fonts')
    files = {'/Ahem.ttf' => File.binread("#{dir}/Ahem.ttf"), '/Lato.ttf' => File.binread("#{dir}/Lato-Medium.ttf")}
    css = '@font-face { font-family: F; src: url(/Ahem.ttf); unicode-range: U+0041-005A; size-adjust: 150%; } ' \
          '@font-face { font-family: F; src: url(/Lato.ttf); unicode-range: U+0061-007A; } ' \
          '@font-face { font-family: C; src: url(/Ahem.ttf); unicode-range: U+000D; size-adjust: 300%; } ' \
          '@font-face { font-family: C; src: url(/Lato.ttf); unicode-range: U+0000-000C, U+000E-00FF; } ' \
          '@font-face { font-family: H; src: url(/Lato.ttf); unicode-range: U+00AD; size-adjust: 200%; } ' \
          '@font-face { font-family: H; src: url(/Ahem.ttf); unicode-range: U+0061-007A; } ' \
          '@font-face { font-family: L; src: local("Liberation Serif"); unicode-range: U+0000-00FF; size-adjust: 150%; }'
    body = '<div style="font: 20px F, sans-serif; width: 300px"><span>ab</span> <span>cd</span></div>' \
           '<pre style="font: 20px C, sans-serif">ab&#13;cd</pre>' \
           '<div style="font: 20px H, sans-serif; hyphens: none">ab&shy;cd</div>' \
           '<div style="font: 20px L, sans-serif; width: 10ch">abc</div>'
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [files[env['PATH_INFO']]]] if files.key?(env['PATH_INFO'])

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><style>#{css}</style><body style=\"margin: 0\">#{body}</body>"]]
    })
    s.visit '/'
    s.execute_script("document.body.style.color = 'red'")
    sizes = s.evaluate_script("[...document.body.children].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width * 100) / 100, r.height]; })")
    expect(sizes.map(&:last)[0, 3]).to eq([24, 60, 48])
    expect(sizes.last.first).to eq(150)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A face whose descriptors change after the first layout is the new face to the style engine's `ch` / `ex` too: the
  # faces it computed a metric from are asked for again once the faces' generation moves, where it kept the old one's.
  it "follows a face's size-adjust into ch and ex when it changes" do
    ahem = File.binread(File.join(__dir__, 'wpt/fonts/Ahem.ttf'))
    html = '<style id="ff">@font-face { font-family: F; src: url(/Ahem.ttf); size-adjust: 150%; }</style>' \
           '<div style="font: 20px F, monospace"><div id="x" style="width: 10ch; height: 3ex"></div><span>abc</span></div>'
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [ahem]] if env['PATH_INFO'] == '/Ahem.ttf'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body style=\"margin: 0\">#{html}</body>"]]
    })
    s.visit '/'
    read = "(() => { const cs = getComputedStyle(document.getElementById('x')); return [cs.width, cs.height]; })()"
    expect(s.evaluate_script(read)).to eq(%w[300px 72px])
    s.execute_script("document.getElementById('ff').textContent = '@font-face { font-family: F; src: url(/Ahem.ttf); size-adjust: 50%; }'")
    expect(s.evaluate_script(read)).to eq(%w[100px 24px])
  end

  # What the walk declined, with no layout behind it, blanked the page: every element 0 x 0. Each of these declined and
  # now lays out as Chrome does — a cell pushed by a row span to start past the columns makes a column of its own (its
  # span clamped to it), a percentage under `round()` / `mod()` / `hypot()` resolves, and a floated or positioned ROOT is
  # sized shrink-to-fit and placed at its `top` / `left` (Chrome: 53.2 wide, its `b` at 31.6; 147, 30, 98.49; the root
  # 121.6 wide at (20, 10)).
  it 'lays out the shapes it once declined, as Chrome does', :aggregate_failures do
    table = '<table id="t" cellspacing="10" style="font: 16px monospace"><tr><td rowspan="2">a</td></tr><tr><td id="b" colspan="2">b</td></tr></table>'
    math = %w[round(50%,7px) mod(50%,40px) hypot(30%,40px)].map {|v| %(<div class="m" style="width: #{v}">x</div>) }.join
    s = page(%(<body style="margin: 0">#{table}<div style="width: 300px">#{math}</div></body>))
    expect(s.evaluate_script(<<~JS)).to eq([53.2, 31.6, 147, 30, 98.49])
      [
        +t.getBoundingClientRect().width.toFixed(2),
        +b.getBoundingClientRect().x.toFixed(2),
        ...[...document.querySelectorAll('.m')].map((e) => +e.getBoundingClientRect().width.toFixed(2))
      ]
    JS
    root = page(
      '<html style="position: absolute; top: 10px; left: 20px"><body style="margin: 8px; font: 16px monospace">' \
      '<div>hello world</div></body></html>'
    )
    expect(root.evaluate_script('(r => [r.x, r.y, +r.width.toFixed(2)])(document.documentElement.getBoundingClientRect())')).to eq([20, 10, 121.6])
    # …and a face the walk cannot measure — a colour emoji font maps no letters — lays its text out in the face it falls
    # back to, sans-serif; Chrome keeps the emoji face's own space and line box (62.6 x 19 for `abc def`).
    emoji = page('<body><span id="e" style="font-family: emoji">abc def</span></body>')
    expect_shared_gap(emoji.evaluate_script('+e.getBoundingClientRect().width.toFixed(1)'), shared: 52.5, chrome: 62.6, what: 'emoji face')
  end

  # A document whose root the walk lays nothing out for — an SVG one — has the root's box alone, and keeps it after a
  # style read reaches the root (the read declared its memos and wiped the box the root-alone layout had written).
  it "keeps an SVG document's root box after a read reaches the root" do
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect id="r" width="10" height="10"/></svg>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'image/svg+xml'}, [svg]] })
    s.visit '/'
    s.evaluate_script("document.getElementById('r').getBoundingClientRect().width")
    expect(s.evaluate_script('(r => [r.width, r.height])(document.documentElement.getBoundingClientRect())')).to eq([200, 100])
  end

  # …and what they reached past the one-line shapes: a FIXED table keeps every column a span covers (Chrome and Firefox:
  # `<td colspan=3>` under a one-cell row of a fixed 300px table is three columns of 100); a grid track over a percentage
  # under a comparison or stepped function is a track, the `auto-fill` count included (`repeat(auto-fill, min(30%,
  # 150px))` in 400px is three of 120), where the whole template was dropped; a function nested deeper than the
  # evaluator's stack is a value; and a positioned root stretches between both insets, centres in them on `auto`
  # margins, and sits at its right / bottom ones (Chrome: `inset: 0` is the viewport; `left: 0; right: 0; width: 200px;
  # margin: 0 auto` puts it at 412; `right: 30px; bottom: 20px` at the viewport's corner less its size); and a
  # `fit-content()` track capped by such a function is a track too.
  it 'lays out what the declined shapes reached, as Chrome does', :aggregate_failures do
    deep = "#{'min(' * 20}50%#{', 400px)' * 20}"
    s = page(
      '<body style="margin: 0; font: 16px monospace">' \
      '<table style="table-layout: fixed; width: 300px; border-spacing: 0"><tr><td id="f" style="padding: 0">a</td></tr><tr><td colspan="3">b</td></tr></table>' \
      '<div style="width: 400px"><div style="display: grid; grid-template-columns: min(20%, 50px) 1fr"><div id="g">a</div><div>b</div></div>' \
      '<div style="display: grid; grid-template-columns: repeat(auto-fill, min(30%, 150px))"><div>a</div><div id="h">b</div></div>' \
      "<div id=\"n\" style=\"width: #{deep}\">x</div></div></body>"
    )
    expect(s.evaluate_script(<<~JS)).to eq([100, 50, [120, true], 200])
      [
        f.getBoundingClientRect().width,
        g.getBoundingClientRect().width,
        [h.getBoundingClientRect().x, h.getBoundingClientRect().y === h.previousElementSibling.getBoundingClientRect().y],
        n.getBoundingClientRect().width
      ]
    JS
    root = ->(style) { page(%(<html style="#{style}"><body style="margin: 8px; font: 16px monospace"><div>hello world</div></body></html>)) }
    read = '(r => [r.x, r.y, +r.width.toFixed(1), r.height])(document.documentElement.getBoundingClientRect())'
    expect(root['position: fixed; inset: 0'].evaluate_script(read)).to eq([0, 0, 1024, 768])
    expect(root['position: absolute; left: 0; right: 0; width: 200px; margin: 0 auto'].evaluate_script(read)).to eq([412, 0, 200, 38])
    expect(root['position: absolute; right: 30px; bottom: 20px'].evaluate_script(read)).to eq([872.4, 710, 121.6, 38])
    expect(root['float: right'].evaluate_script(read)).to eq([902.4, 0, 121.6, 38])
    # (…clamped by its max-width between both insets, and centred there on `auto` margins: Chrome's 500 at 262)
    expect(root['position: absolute; top: 0; left: 0; right: 0; max-width: 500px; margin: auto'].evaluate_script(read)).to eq([262, 0, 500, 38])
    # (…and as tall as the room between both vertical insets, clamped by its min / max-height and centred on `auto`
    # margins — which, on this axis, may go negative: a 1000 tall root in the 768 viewport sits at -116, as in Chrome)
    expect(root['position: fixed; inset: 0; max-width: 300px; max-height: 200px; margin: auto'].evaluate_script(read)).to eq([362, 284, 300, 200])
    expect(root['position: absolute; top: 0; bottom: 0; min-height: 1000px; margin: auto 0'].evaluate_script(read)[1]).to eq(-116)
    # (…and a `fit-content()` track capped by a function over a percentage: Chrome's 160 | 240)
    fit = page('<body style="margin: 0"><div style="width: 400px; display: grid; grid-template-columns: fit-content(min(40%, 300px)) 1fr">' \
               '<div>aaaa bbbb cccc dddd eeee ffff</div><div id="k">b</div></div></body>')
    expect(fit.evaluate_script('(r => [r.x, r.width])(k.getBoundingClientRect())')).to eq([160, 240])
    # (…and a face the walk cannot measure falls back to the next family of the stack: `emoji, monospace` sets the
    # letters in monospace, seven of them 67.2 wide — Chrome's 77.6 keeps the emoji face's own space)
    emoji = page('<body><span id="e" style="font-family: emoji, monospace">abc def</span></body>')
    expect_shared_gap(emoji.evaluate_script('+e.getBoundingClientRect().width.toFixed(1)'), shared: 67.2, chrome: 77.6, what: 'emoji, monospace')
  end
end
