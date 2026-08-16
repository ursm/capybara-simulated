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
end
