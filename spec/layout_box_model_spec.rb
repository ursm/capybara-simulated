# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The box model: padding, border and margin participate in geometry. Before this
# the layout produced content-only boxes — a padded block measured its text and
# nothing else, margins moved nothing, and `width` was taken as the border box
# whatever `box-sizing` said. Every expectation below is Chrome 137-measured
# (headless, 1024x768) and noted where we deliberately land within a pixel of it
# (our line box is derived from font-size rather than real glyph metrics).
RSpec.describe 'layout box model' do
  def boxes(body, selectors)
    html = %(<html><body style="margin:0">#{body}</body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    js = <<~JS
      JSON.stringify(#{selectors.to_json}.map(function (sel) {
        var r = document.querySelector(sel).getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }))
    JS
    JSON.parse(session.evaluate_script(js))
  end

  it 'grows a box by its padding and borders' do
    # Chrome: 1024 x 58 (20 + ~18 line + 20).
    x, _y, w, h = boxes('<div id="a" style="padding:20px">x</div>', ['#a']).first
    expect([x, w]).to eq([0, 1024])
    expect(h).to be_within(1).of(58)
  end

  it 'treats a declared size as the content box unless box-sizing says otherwise' do
    body = '<div id="c" style="width:200px;height:100px;padding:20px"></div>' \
           '<div id="b" style="width:200px;height:100px;padding:20px;box-sizing:border-box"></div>'
    content, border = boxes(body, ['#c', '#b'])
    expect(content[2..]).to eq([240, 140])   # Chrome: 200 + 20 + 20
    expect(border[2..]).to eq([200, 100])    # border-box: the padding is inside
  end

  it 'offsets a box by its margins and advances the flow past them' do
    # Chrome: #m at x=30 y=30, and #after starts below it.
    body = '<div id="m" style="margin:30px;height:40px"></div><div id="after" style="height:10px"></div>'
    m, after = boxes(body, ['#m', '#after'])
    expect(m[0, 2]).to eq([30, 30])
    expect(after[1]).to eq(100)             # 30 (top margin) + 40 (height) + 30 (bottom margin)
  end

  it 'collapses adjacent vertical margins to the larger of the two' do
    # Chrome: the gap between the two boxes is 30, not 20 + 30.
    body = '<div id="one" style="height:20px;margin-bottom:20px"></div>' \
           '<div id="two" style="height:20px;margin-top:30px"></div>'
    one, two = boxes(body, ['#one', '#two'])
    expect(two[1] - (one[1] + one[3])).to eq(30)
  end

  it 'derives the line box from the font size rather than a fixed height' do
    # Chrome: 13px text -> 15 tall, 20px text -> 23 tall.
    body = '<div id="small" style="font-size:13px">x</div><div id="big" style="font-size:20px">x</div>'
    small, big = boxes(body, ['#small', '#big'])
    expect(small[3]).to be_within(1).of(15)
    expect(big[3]).to be_within(1).of(23)
  end

  # WHICH FACE a CSS family resolves to decides every width on the page, and
  # fontconfig makes that harder than it looks: it answers every name, so a name it
  # SUBSTITUTED (`Arial` → the metric-compatible Liberation Sans, which is what a
  # browser on the same machine draws) is indistinguishable from a name it ignored
  # unless you ask it. Getting that wrong is silent — text is simply measured in the
  # fallback serif — so these are relationships rather than pixel figures, and hold
  # whatever faces happen to be installed.
  it 'resolves a font stack to the face a browser would use' do
    body = %w[Arial sans-serif serif].each_with_index.map {|f, i| %(<span id="f#{i}" style="font-family:#{f}">Wm second</span><br>) }.join +
           %(<span id="fall" style="font-family:'No Such Family XY', Arial">Wm second</span><br>) +
           %(<span id="none" style="font-family:'No Such Family XY'">Wm second</span>)
    arial, sans, serif, fallthrough, unknown = boxes(body, ['#f0', '#f1', '#f2', '#fall', '#none']).map {|b| b[2] }
    # A browser's default sans IS Arial (Chrome asks fontconfig for exactly that),
    # and a substituted face measures as itself — not as the serif fallback.
    expect(arial).to eq(sans)
    expect(arial).not_to eq(serif)
    # An unknown family is skipped and the NEXT one in the stack answers…
    expect(fallthrough).to eq(arial)
    # …while a stack of nothing but unknowns lands on the standard font, a serif.
    expect(unknown).to eq(serif)
  end

  # An inline box's padding grows its border box but NOT the line box it sits on
  # (Chrome: a 12px-font pill with 4px vertical padding measures 22 tall inside a
  # ~14px line).
  it 'keeps inline padding out of the line box' do
    body = '<div id="line" style="font-size:12px">before <span id="pill" style="padding:4px 10px">tag</span></div>'
    line, pill = boxes(body, ['#line', '#pill'])
    expect(pill[3]).to be_within(1).of(22)
    expect(line[3]).to be_within(2).of(14)
  end

  # clientHeight is the PADDING box, and the scrollable range is measured against
  # it — a bordered scroller must reach scrollHeight - clientHeight exactly.
  it 'measures the client box and scroll range inside the borders' do
    html = <<~HTML
      <html><body style="margin:0">
        <div id="s" style="height:50px;width:50px;overflow:scroll;border:1px solid black">
          <div style="height:200px;width:200px"></div>
        </div>
      </body></html>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    m = JSON.parse(session.evaluate_script(<<~JS))
      (function () {
        var e = document.getElementById('s');
        return JSON.stringify({
          rect: Math.round(e.getBoundingClientRect().height),
          client: e.clientHeight, scroll: e.scrollHeight
        });
      })()
    JS
    expect(m['rect']).to eq(52)      # 50 content + 2 borders
    expect(m['client']).to eq(50)    # padding box
    expect(m['scroll']).to eq(200)   # measured from the padding box origin
    # scrollHeight - clientHeight = 150 is what a scroll_to(:bottom) reaches; the
    # scrollTop SETTER doesn't clamp yet (see the note in dom-nodes.js).
  end
  describe 'offsetLeft / offsetTop' do
    # CSSOM-View measures them from the offsetParent's PADDING edge, not its border edge. Reading
    # from the border box put every offset inside a bordered positioned ancestor out by that
    # border — 9 where Chrome says 4 for a 5px one — and WPT's own layout oracle
    # (`check-layout-th.js`, `data-offset-x` / `-y`) is written against exactly this value.
    it 'measures from the padding edge of the offsetParent' do
      body = <<~HTML
        <div id="p" style="position:relative;padding:3px 4px;border:5px solid;width:60px;height:40px">
          <div id="flow" style="height:6px"></div>
          <div id="abs" style="position:absolute;left:0;top:0;height:6px;width:8px"></div>
        </div>
      HTML
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<body style="margin:0">#{body}</body>)]] })
      s.visit '/'
      # Chrome: the in-flow child sits at the content origin — 4 / 3 from the padding edge — and
      # the abspos one, whose insets place it AT that padding edge, at 0 / 0.
      expect(s.evaluate_script("(e => [e.offsetLeft, e.offsetTop])(document.getElementById('flow'))")).to eq([4, 3])
      expect(s.evaluate_script("(e => [e.offsetLeft, e.offsetTop])(document.getElementById('abs'))")).to eq([0, 0])
    end

    # CSSOM-View: a `position: fixed` element's offsetParent is null. The verdict must come from
    # the LIVE cascade: nothing on a bare `offsetParent` read forces a layout pass, so a verdict
    # read off the last pass's box (`_lb.fixed`) answers with the position the element HAD — the
    # gBCR here warms exactly that stale state before the style write flips it.
    it 'answers offsetParent null the moment an element becomes position: fixed' do
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<body><div id="t">x</div></body>'] ] })
      s.visit '/'
      expect(s.evaluate_script(<<~JS)).to eq(['BODY', nil])
        (() => {
          const t = document.getElementById('t');
          t.getBoundingClientRect();
          const before = t.offsetParent && t.offsetParent.tagName;
          t.style.position = 'fixed';
          return [before, t.offsetParent && t.offsetParent.tagName];
        })()
      JS
    end
  end

  # `overflow` clips per AXIS. After the CSS Overflow 3 computed-value rule the only box that clips
  # one axis and not the other is `clip` beside `visible` — but that one is real, and asking "does
  # this box clip at all" made a child hanging off the SIDE of an `overflow-y: clip` box invisible
  # to the hit test, i.e. unclickable. Chrome 137-measured.
  describe 'single-axis overflow' do
    def page(body)
      html = %(<html><body style="margin:0">#{body}</body></html>)
      session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      session.visit '/'
      session
    end

    it 'hit-tests a child beside an overflow-y: clip box, but not one below it' do
      s = page(<<~HTML)
        <div id="p" style="width: 100px; height: 100px; overflow-y: clip">
          <div id="side" style="position: relative; left: 200px; width: 60px; height: 20px">x</div>
          <div id="under" style="position: relative; top: 200px; width: 60px; height: 20px">y</div>
        </div>
      HTML
      got = s.evaluate_script(<<~JS)
        [document.elementFromPoint(230, 10), document.elementFromPoint(10, 300)]
          .map(e => (e && e.id) || (e && e.tagName) || null)
      JS
      expect(got).to eq(['side', 'HTML'])
    end

    it 'reports the computed overflow the paired axis forces' do
      s = page('<div id="a" style="overflow-x: hidden"></div><div id="b" style="overflow-y: clip"></div>')
      got = s.evaluate_script(<<~JS)
        ['a', 'b'].map(id => {
          const cs = getComputedStyle(document.getElementById(id));
          return [cs.overflowX, cs.overflowY];
        })
      JS
      # `visible` becomes `auto` beside a scrolling value; beside `clip` it stays `visible`.
      expect(got).to eq([%w[hidden auto], %w[visible clip]])
    end

    it 'pairs an axis whose value is a CSS-wide keyword' do
      # `inherit` takes the parent's computed value — and the pairing rule then applies to THAT, so
      # the read has to go through the same resolution the layout engine uses rather than short-
      # circuiting on "this declares a CSS-wide keyword". Chrome: auto / hidden.
      s = page('<div style="overflow: visible"><div id="c" style="overflow-x: inherit; overflow-y: hidden"></div></div>')
      got = s.evaluate_script("(() => { const cs = getComputedStyle(document.getElementById('c')); return [cs.overflowX, cs.overflowY] })()")
      expect(got).to eq(%w[auto hidden])
    end

    it 'does not clip for a CSS-wide keyword or an invalid value' do
      # The keyword set is a WHITELIST: `initial` / `unset` / `revert` all compute to `visible`, and
      # an invalid declaration produces no used value at all. Treating "not the string `visible`"
      # as clipping made every one of them swallow a child that hangs outside the box.
      got = %w[initial unset revert bogus].map {|v|
        s = page(%(<div style="width: 100px; height: 100px; overflow: #{v}"><div id="side" style="position: relative; left: 300px; width: 60px; height: 20px">x</div></div>))
        s.evaluate_script("(() => { const e = document.elementFromPoint(330, 10); return (e && e.id) || (e && e.tagName) })()")
      }
      expect(got).to eq(['side'] * 4)
    end

    it 'does not scroll an overflow: clip box' do
      # `clip` clips AND forbids all scrolling, script included (CSS Overflow 3) — it is not a
      # scroll container, so neither a stored offset nor `scrollIntoView` moves what is inside it.
      s = page('<div id="p" style="width: 100px; height: 100px; overflow: clip"><div id="t" style="margin-top: 400px; height: 20px">t</div></div>')
      got = s.evaluate_script(<<~JS)
        (() => {
          const t = document.getElementById('t');
          const before = t.getBoundingClientRect().y;
          document.getElementById('p').scrollTop = 300;
          t.scrollIntoView();
          return [before, t.getBoundingClientRect().y];
        })()
      JS
      expect(got).to eq([400, 400])
    end

    it 'keeps a sideways overflow in the document scroll range' do
      # The extent union clips per axis too, or the page refuses to scroll to a box the hit test
      # says is visible. Chrome: scrollWidth 1260.
      s = page('<div style="width: 100px; height: 100px; overflow-y: clip"><div style="position: relative; left: 1200px; width: 60px; height: 20px">x</div></div>')
      expect(s.evaluate_script('document.documentElement.scrollWidth')).to eq(1260)
    end
  end

end
