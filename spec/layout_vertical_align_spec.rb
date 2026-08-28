# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# `vertical-align` was ignored: an icon, a badge or a `<sup>` sat wherever the line's baseline
# happened to put it. Now that a line box HAS a baseline (`layout_inline_flow_spec` covers that),
# each value is an offset from it — and the two that are not, `top` and `bottom`, hang from the
# line's own edges once it knows how tall it is.
#
# The device here is a zero-height `inline-block`: it has no line of its own, so its synthesised
# baseline is its own top edge and it lands exactly ON the line's baseline. Every figure is derived
# from that ruler and from the font box a `<span>` reports, so the examples hold whatever face
# fontconfig serves — except the `sub` / `super` offsets, which are fractions of the font SIZE and
# so are figures in their own right (Chrome: `font-size / 3 + 1` up, `font-size / 5 + 1` down,
# measured at 10, 15, 16, 20, 32 and 64px).
RSpec.describe 'vertical-align' do
  include LayoutMeasure

  # A method, not a constant: a constant assigned inside a `describe` block lands at TOP LEVEL and
  # leaks across the suite (`layout_inline_flow_spec` carries the same note).
  def ruler = '<span style="display:inline-block;width:0;height:0"></span>'

  # `[line height, the line's baseline, the box's top, the box's height]` for one aligned box.
  def aligned(value, box = 'width:20px;height:10px')
    body = %(<div id="c" style="width:400px">t#{ruler}<span id="b" style="display:inline-block;#{box};vertical-align:#{value}"></span>x</div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#b'])
    line, ruler, aligned_box = boxes
    [line[3], (ruler[1] - line[1]).round(2), (aligned_box[1] - line[1]).round(2), aligned_box[3]]
  end

  # The parent's font box, which `text-top` and `text-bottom` align against, and its ascent.
  def font_box
    body = %(<div id="c" style="width:400px">t#{ruler}<span id="f">x</span></div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#f'])
    {ascent: (boxes[1][1] - boxes[0][1]).round(2), box: boxes[2][3]}
  end

  it 'sits a box on the baseline by default' do
    height, baseline, top, box = aligned('baseline')
    expect(top + box).to eq(baseline)
    expect(height).to eq(font_box[:ascent] + (height - baseline))
  end

  # `top` and `bottom` are the line's, not the baseline's: the box hangs from an edge, and the line
  # grows on the side AWAY from it when the box does not fit.
  it 'hangs a box from the line edges' do
    _h, _b, top, = aligned('top')
    expect(top).to eq(0)

    height, _b2, bottom_top, box = aligned('bottom')
    expect(bottom_top + box).to eq(height)

    tall_top = aligned('top', 'width:20px;height:40px')
    expect(tall_top[0]).to eq(40)             # the line grew DOWN: its baseline stayed put
    expect(tall_top[1]).to eq(font_box[:ascent])
    expect(tall_top[2]).to eq(0)

    tall_bottom = aligned('bottom', 'width:20px;height:40px')
    expect(tall_bottom[0]).to eq(40)          # …and here it grew UP, taking the baseline with it
    expect(tall_bottom[1]).to be > font_box[:ascent]
    expect(tall_bottom[2]).to eq(0)
  end

  # `middle` puts the box's own centre half an x-height above the baseline.
  it 'centres a box against the x-height' do
    body = %(<div id="c" style="width:400px">t#{ruler}<span id="b" style="display:inline-block;width:20px;height:10px;vertical-align:middle"></span><span id="ex" style="display:inline-block;width:1ex;height:0"></span></div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#b', '#ex'])
    line, ruler, box, ex = boxes
    baseline = ruler[1] - line[1]
    centre = (box[1] - line[1]) + box[3] / 2.0
    expect(centre).to be_within(0.01).of(baseline - ex[2] / 2.0)
  end

  # `text-top` and `text-bottom` align against the PARENT's font box, not the line.
  it 'aligns against the parent font box' do
    f = font_box
    _h, baseline, top, = aligned('text-top')
    expect(top).to eq(baseline - f[:ascent])

    _h2, baseline2, top2, box2 = aligned('text-bottom')
    expect(top2 + box2).to eq(baseline2 + (f[:box] - f[:ascent]))
  end

  # `sub` and `super` shift by a fraction of the PARENT's font size — the one CSS 2.1 calls "the
  # appropriate superscript position of the parent's font".
  it 'raises and lowers by the parent font size' do
    _h, baseline, top, box = aligned('super')
    expect(baseline - (top + box)).to be_within(0.01).of(16 / 3.0 + 1)

    _h2, baseline2, top2, box2 = aligned('sub')
    expect((top2 + box2) - baseline2).to be_within(0.01).of(16 / 5.0 + 1)
  end

  # A length raises the box by itself; a percentage by that much of its own `line-height`.
  it 'reads a length and a percentage' do
    _h, baseline, top, box = aligned('10px')
    expect(baseline - (top + box)).to eq(10)

    body = %(<div id="c" style="width:400px;line-height:20px">t#{ruler}<span id="b" style="display:inline-block;width:20px;height:10px;line-height:20px;vertical-align:50%"></span>x</div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#b'])
    line, ruler, pct = boxes
    expect((ruler[1] - line[1]) - ((pct[1] - line[1]) + pct[3])).to eq(10)
  end

  # `vertical-align` is about where a box sits on ITS parent's line. On the box that establishes a
  # formatting context — a block, a table cell, a flex item — it says nothing about the lines
  # INSIDE it, and applying it there inflated every `td { vertical-align: middle }` row.
  it 'says nothing about the lines inside the box' do
    %w[super middle text-top sub].each do |value|
      plain, = measure(%(<div id="c">text</div>), ['#c'])
      aligned_block, = measure(%(<div id="c" style="vertical-align:#{value}">text</div>), ['#c'])
      expect(aligned_block[0][3]).to eq(plain[0][3])
    end

    rows = %(<table id="t"><tr><td>a</td></tr><tr><td>b</td></tr></table>)
    plain, = measure(rows, ['#t'])
    middled, = measure(%(<style>td{vertical-align:middle}</style>#{rows}), ['#t'])
    expect(middled[0][3]).to eq(plain[0][3])
  end

  # `top` and `bottom` on one line: the line grows away from whichever edge asked for the most
  # room, so a taller `top` box leaves the baseline where the text put it.
  it 'grows the line away from the taller of top and bottom' do
    body = %(<div id="c" style="width:400px">t#{ruler}) +
           %(<span style="display:inline-block;width:10px;height:40px;vertical-align:top"></span>) +
           %(<span style="display:inline-block;width:10px;height:30px;vertical-align:bottom"></span>x</div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)'])
    line, ruler_box = boxes
    expect(line[3]).to eq(40)
    expect(ruler_box[1] - line[1]).to eq(font_box[:ascent])
  end

  # The `align` ATTRIBUTE feeds the same property — and it has to reach LAYOUT, not just
  # `getComputedStyle`: a presentational hint is in neither the stylesheet index nor the inline map,
  # so the gate in front of the cascade read has to know about it.
  it 'moves a box the align attribute aligned' do
    img = '<img align="top" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width:20px;height:40px">'
    boxes, = measure(%(<div id="c" style="width:400px">t#{ruler}#{img}</div>), ['#c', '#c > span'])
    line, ruler_box = boxes
    expect(line[3]).to eq(40)
    expect(ruler_box[1] - line[1]).to eq(font_box[:ascent])
  end

  # A shift is relative to the PARENT's baseline, so nested ones compound.
  it 'compounds a shift with the one around it' do
    body = %(<div id="c" style="width:400px">t#{ruler}<span style="vertical-align:super">o<span id="i" style="vertical-align:super">i</span></span></div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#i'])
    line, ruler_box, inner = boxes
    one = 16 / 3.0 + 1
    expect((ruler_box[1] - line[1]) - (inner[1] - line[1] + font_box[:ascent])).to be_within(0.02).of(2 * one)
  end

  # HTML's own sheet raises and shrinks `<sup>` and `<sub>`, and both halves show.
  it 'gives sup and sub their UA rules' do
    body = %(<div id="c" style="width:400px">x#{ruler}<sup id="s">2</sup></div>)
    boxes, = measure(body, ['#c', '#c > span', '#s'])
    line, ruler, sup = boxes
    plain, = measure('<div id="p">x<span id="f">x</span></div>', ['#p', '#f'])
    expect(sup[3]).to be < plain[1][3]                        # `font-size: smaller`
    expect((ruler[1] - line[1])).to be > plain[1][3] - 2      # …and the line grew for the raise
  end
end
