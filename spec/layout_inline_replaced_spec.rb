# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Embedded content — `<canvas>`, `<iframe>`, `<svg>`, `<video>`, `<object>`, `<embed>` — was laid
# out BLOCK-level, so `a<canvas>b` took three lines where a browser takes one, and every inline SVG
# icon pushed the words around it onto lines of their own. They are inline-level replaced boxes:
# they sit ON the line, hanging from its baseline like an image.
#
# Figures measured in Chrome 151.0.7922.169; the ones that are the UA's own defaults (300x150, the
# iframe's 2px frame) are figures in their own right, and the rest are derived from them.
RSpec.describe 'inline replaced elements' do
  include LayoutMeasure

  # `[line height, the line's baseline, the box]` for one embedded element on a line of text.
  def on_a_line(html)
    boxes, = measure(%(<div id="c" style="width:600px">a#{ruler}#{html}b</div>),
                     ['#c', '#c > span', '#c > :nth-child(2)'])
    line, mark, box = boxes
    [line[3], (mark[1] - line[1]).round(2), box.map {|n| n.round(2) }]
  end

  it 'puts embedded content on the line, not on lines of its own' do
    {
      '<canvas style="width:20px;height:30px"></canvas>' => [20, 30],
      '<svg style="width:20px;height:30px"></svg>'       => [20, 30],
      '<video style="width:20px;height:30px"></video>'   => [20, 30],
      '<object style="width:20px;height:30px"></object>' => [20, 30],
      '<embed src="data:text/plain,hi" style="width:20px;height:30px">' => [20, 30]
    }.each do |html, (w, h)|
      height, baseline, box = on_a_line(html)
      expect(box[2, 2]).to eq([w, h])
      # It hangs from the line's baseline by its own bottom edge, so the line is the box plus what
      # the text still leaves under that baseline.
      expect(baseline).to eq(h)
      expect(height).to be > h
    end
  end

  # The UA's own default size for embedded content that has none of its own.
  it 'gives them the default object size' do
    ['<canvas></canvas>', '<svg></svg>', '<video></video>'].each do |html|
      _h, _b, box = on_a_line(html)
      expect(box[2, 2]).to eq([300, 150])
    end
  end

  # …and an `<iframe>` carries HTML's own 2px frame around it, which is part of its box.
  it 'draws the frame HTML gives an iframe' do
    _h, _b, box = on_a_line('<iframe></iframe>')
    expect(box[2, 2]).to eq([304, 154])

    _h2, _b2, sized = on_a_line('<iframe style="width:20px;height:30px"></iframe>')
    expect(sized[2, 2]).to eq([24, 34])
  end

  # An `<svg>` with only a `viewBox` has a RATIO and no size: SVG's own sheet gives it the width of
  # the block it is in, and the ratio decides the other axis.
  # The box one replaced element ends up with inside a container of its own.
  def box_in(container, html, tag = 'svg')
    boxes, = measure(%(<div style="#{container};position:relative">#{html}</div>), ["div > #{tag}"])
    boxes[0].map {|n| n.round(2) }
  end

  it 'sizes a ratio-only svg from its container and its ratio' do
    expect(box_in('width:800px;height:600px', '<svg viewBox="0 0 100 200"></svg>')[2, 2]).to eq([800, 1600])
    expect(box_in('width:400px;height:600px', '<svg viewBox="0 0 100 200"></svg>')[2, 2]).to eq([400, 800])
    # A given size on either axis wins, and the ratio supplies the other.
    expect(box_in('width:800px;height:600px', '<svg viewBox="0 0 100 200" height="25%"></svg>')[2, 2]).to eq([75, 150])
    expect(box_in('width:800px;height:600px', '<svg viewBox="0 0 100 200" width="50"></svg>')[2, 2]).to eq([50, 100])
    # …and with no ratio at all it is the default object size.
    expect(box_in('width:800px;height:600px', '<svg></svg>')[2, 2]).to eq([300, 150])
  end

  # That width is a BORDER box, so the element's own padding and border stay INSIDE it and only its
  # margins come off — the ratio then applies to what is left.
  it 'keeps a ratio-only box border-box wide' do
    padded = box_in('width:800px', '<svg viewBox="0 0 100 200" style="padding:10px;border:5px solid"></svg>')
    expect(padded[2, 2]).to eq([800, 1570])

    margined = box_in('width:800px', '<svg viewBox="0 0 100 200" style="margin:0 20px"></svg>')
    expect(margined).to eq([20, 0, 760, 1520])
  end

  # An atomic inline's horizontal MARGINS advance the line like anything else — they were dropped,
  # which put an `ml-2` icon hard against the word before it.
  it 'reserves an atomic box margins on the line' do
    boxes, = measure('<div id="c" style="width:800px"><canvas style="width:100px;height:50px;margin-left:40px"></canvas></div>',
                     ['#c > canvas'])
    expect(boxes[0][0]).to eq(40)
  end

  it 'reserves them on the far side too' do
    boxes, = measure('<div id="c" style="width:800px"><canvas style="width:100px;height:50px;margin-right:40px"></canvas>' \
                     '<canvas style="width:100px;height:50px"></canvas></div>',
                     ['#c > canvas:nth-of-type(2)'])
    expect(boxes[0][0]).to eq(140)
  end

  # The frame is the UA's, so an author border beats it — `border: 0` on an embed is the everyday
  # idiom — and `frameborder` turns it off from markup. That attribute is read as an integer PREFIX,
  # which is why `1abc` keeps the frame and `0x1` is 0 rather than 1.
  it 'lets the page turn the frame off' do
    expect(iframe_width('style="border:0"')).to eq(300)
    expect(iframe_width('style="border:5px solid"')).to eq(310)

    {
      '0'    => 300,
      'no'   => 300,
      '0.5'  => 300,
      ''     => 300,
      'abc'  => 300,
      '0x1'  => 300,
      '1'    => 304,
      '-1'   => 304,
      '1abc' => 304
    }.each do |value, width|
      expect(iframe_width(%(frameborder="#{value}"))).to eq(width)
    end
  end

  def iframe_width(attrs)
    boxes, = measure(%(<div id="c" style="width:800px"><iframe #{attrs}></iframe></div>), ['#c > iframe'])
    boxes[0][2]
  end

  # A clamp on a box with a ratio SCALES it: `img, svg { max-width: 100% }` — in every CSS reset —
  # has to shrink a too-wide box, not squash it. CSS 2.1 §10.4's constraint table is that rule and
  # its corners: the clamp that binds hardest wins, the other axis follows the ratio, and two clamps
  # pulling opposite ways is the one case no ratio can satisfy.
  it 'scales a ratio box to fit a min/max clamp' do
    expect(box_in('width:80px', '<canvas width="200" height="100" style="max-width:100%"></canvas>', 'canvas')[2, 2])
      .to eq([80, 40])
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="max-width:100px"></svg>')[2, 2]).to eq([100, 200])
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="max-height:100px"></svg>')[2, 2]).to eq([50, 100])
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="min-width:900px"></svg>')[2, 2]).to eq([900, 1800])
    # Too wide AND too short: both clamps hold and the ratio breaks.
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="max-width:100px;min-height:900px"></svg>')[2, 2])
      .to eq([100, 900])
  end

  # The ratio relates the two CONTENT boxes, so a given axis is the box the OTHER one grows from —
  # padding and border included, whichever box-sizing the page asked for.
  it 'applies the ratio to the content box' do
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="width:50px;padding:10px;border:5px solid"></svg>')[2, 2])
      .to eq([80, 130])
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="height:200px;padding:10px"></svg>')[2, 2])
      .to eq([120, 220])
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="width:50px;padding:10px;box-sizing:border-box"></svg>')[2, 2])
      .to eq([50, 80])
  end

  # A ratio-only box has no width of ITS own, so it takes whatever space the box around it offers:
  # the whole containing block when it is absolutely positioned, its share of a flex line, and
  # nothing at all where the space is itself content-derived.
  it 'stretches a ratio-only box to the space on offer' do
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="position:absolute"></svg>')[2, 2])
      .to eq([800, 1600])
    expect(box_in('width:800px', '<svg viewBox="0 0 100 200" style="position:absolute;left:10px"></svg>')[2, 2])
      .to eq([790, 1580])
    expect(box_in('width:800px;display:flex', '<svg viewBox="0 0 100 200"></svg>')[2, 2]).to eq([800, 1600])
    expect(box_in('display:inline-block;border:1px solid', '<svg viewBox="0 0 100 200"></svg>')[2, 2]).to eq([0, 0])
  end

  # An `<audio>` is HTML's `audio:not([controls]) { display: none }`, which Chrome marks
  # `!important`: no box, no space, and nothing the page declares brings it back.
  it 'gives an audio element a box only while it shows controls' do
    _h, _b, box = on_a_line('<audio controls></audio>')
    expect(box[2, 2]).to eq([300, 54])

    ['<audio></audio>', '<audio style="display:block;width:100px;height:100px"></audio>'].each do |html|
      boxes, _text, _line, session = measure(%(<div id="c" style="width:800px">a#{html}b</div>), ['#c', '#c > audio'])
      expect(boxes[1][2, 2]).to eq([0, 0])
      expect(boxes[0][3]).to eq(measure('x', ['body'])[2])
      expect(session.evaluate_script("getComputedStyle(document.querySelector('audio')).display")).to eq('none')
      expect(session).to have_no_css('audio', visible: true)
    end
  end

  # `<embed>` and `<object>` are replaced only while they HAVE a resource to render. An `<embed>`
  # with none gets no box at all (though its computed `display` stays `inline` — it is a missing
  # box, not a hide), and an `<object>` with none renders its CHILDREN, which `width` / `height`
  # then do not apply to at all.
  it 'gives embedded content a box only while it has a resource' do
    _h, _b, embed = on_a_line('<embed>')
    expect(embed[2, 2]).to eq([0, 0])

    _h2, _b2, sourced = on_a_line('<embed src="data:text/plain,hi">')
    expect(sourced[2, 2]).to eq([300, 150])

    _h3, _b3, resourced = on_a_line('<object data="data:text/plain,hi"></object>')
    expect(resourced[2, 2]).to eq([300, 150])

    fallback, text = measure('<div id="c" style="width:800px">a<object id="o">hello</object>b</div>',
                             ['#o'], probes: ['hello'])
    expect(fallback[0][2]).to be_within(0.01).of(text['hello'])

    # …and `width` / `height` do not apply to it, because it is not a replaced element at all.
    sized, = measure('<div id="c" style="width:800px">a<object id="o" style="width:20px;height:30px">hello</object>b</div>',
                     ['#o'])
    expect(sized[0]).to eq(fallback[0])
  end

  it 'gives a meter and a progress bar their UA widget size' do
    _h, _b, meter = on_a_line('<meter value="0.5"></meter>')
    expect(meter[2, 2]).to eq([80, 16])

    _h2, _b2, progress = on_a_line('<progress value="0.5"></progress>')
    expect(progress[2, 2]).to eq([160, 16])
  end
end
