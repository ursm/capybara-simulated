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

  # A box that declares nothing of its own still rises with the inline around it (Chrome: the `<a>` in a
  # `<sup>`, and the `<b>` and the inline-block inside a `vertical-align: 5px` span, move by the parent's
  # shift, and the line grows for them).
  it 'carries a shift into a box that declares none' do
    body = %(<div id="c" style="width:400px">t#{ruler}<span style="vertical-align:5px">o<span id="n">n</span><span id="i" style="display:inline-block;width:10px;height:10px"></span></span></div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#n', '#i'])
    line, ruler_box, nested, ib = boxes
    baseline = ruler_box[1] - line[1]
    expect(nested[1] - line[1] + font_box[:ascent]).to be_within(0.02).of(baseline - 5)
    expect(ib[1] - line[1] + ib[3]).to be_within(0.02).of(baseline - 5)
  end

  # `middle` / `text-top` / `text-bottom` place the box against the PARENT's font box — which sits wherever the
  # parent's own shift put it (Chrome: a `text-top` box inside a `vertical-align: 5px` span tops out 5 higher
  # than beside it).
  it 'places a font-box-aligned box against a shifted parent' do
    %w[text-top text-bottom middle].each do |mode|
      body = %(<div id="c" style="width:400px">t#{ruler}<span id="p" style="vertical-align:5px">o<span id="i" style="display:inline-block;width:10px;height:10px;vertical-align:#{mode}"></span></span><span id="f" style="display:inline-block;width:10px;height:10px;vertical-align:#{mode}"></span></div>)
      boxes, = measure(body, ['#c', '#i', '#f'])
      shifted, flat = boxes[1], boxes[2]
      expect(flat[1] - shifted[1]).to be_within(0.02).of(5), mode
    end
  end

  # A text-drawing CONTROL's baseline is its font's, wherever it sits: a block-level `<input>` gives the
  # inline-block around it that baseline (Chrome: a 21px input's line is 21 tall, hanging from the input's text
  # rather than its bottom edge), and a flex item holding one aligns on it too (measured: the input lands at 14
  # beside a 32px word). A `<textarea>` scrolls, so it keeps its bottom edge.
  it 'reads a block-level control child as a font baseline' do
    body = %(<div id="c" style="width:400px">t#{ruler}<span id="i" style="display:inline-block"><input id="n" style="display:block"></span></span></div>)
    boxes, = measure(body, ['#c', '#c > span:nth-of-type(1)', '#n'])
    line, ruler_box, input = boxes
    baseline = ruler_box[1] - line[1]
    expect(input[1] + input[3] - line[1]).to be > baseline          # its bottom edge is BELOW the baseline…
    expect(line[3]).to be_within(0.02).of(input[3])                 # …and the line is exactly the input tall

    body = %(<div style="display:flex;align-items:baseline;width:400px"><div><input id="n" style="display:block"></div><div id="b" style="font-size:32px">BIG#{ruler}</div></div>)
    boxes, = measure(body, ['#n', '#b span'])
    expect(boxes[0][1]).to be > 0                                   # the input drops to the big word's baseline

    # …but a BLOCK-LEVEL list box stacking real rows reads its baseline off those rows' lines (Chrome: the big
    # word stays at 0 and the 53px `size=3` box drops to 16, its first row's line on the word's baseline), while
    # a DROPDOWN keeps the control rule — its `<option>`s have no box at all in Chrome, so the ones the driver
    # lays out inside it must not answer for it (Chrome: the select drops to 15, not 16).
    body = %(<div style="display:flex;align-items:baseline;width:400px"><div><select id="n" style="display:block" size="3"><option>a</option><option>b</option></select></div><div id="b" style="font-size:32px">BIG</div></div>)
    boxes, = measure(body, ['#n', '#b'])
    expect(boxes[1][1]).to eq(0)
    expect(boxes[0][1]).to be > 10

    body = %(<div style="display:flex;align-items:baseline;width:400px"><div><select id="n" style="display:block"><option>a</option></select></div><div id="b" style="font-size:32px">BIG</div></div>)
    boxes, = measure(body, ['#n', '#b'])
    expect(boxes[1][1]).to eq(0)
    expect(boxes[0][1]).to be_within(0.02).of(15)
  end

  # An INLINE-LEVEL child sits on one of the block's own lines, which already carries its baseline — reading it
  # as a child too would let it win against its own line (Chrome: a `<select multiple>` hands its line the
  # list-box baseline at 67, while its option rows sit at 13).
  it 'reads an inline-level child through its line, not as a child box' do
    body = %(<div style="display:flex;align-items:baseline;width:400px"><div id="i"><select multiple><option>a</option><option>b</option></select></div><div id="b" style="font-size:32px">BIG</div></div>)
    boxes, = measure(body, ['#i', '#b'])
    expect(boxes[0][1]).to eq(0)
    expect(boxes[1][1]).to be > 30
  end

  # An inline-block hangs from its last line — except that a SCROLL CONTAINER inside it has no line to give and
  # hands its bottom MARGIN edge instead (CSS2 §10.8.1 as Blink applies it down the tree; Chrome: 36 for a text
  # line over an `overflow: hidden` one, 46 with `margin-bottom: 10px` on it, and a trailing empty block reads
  # past to it). A text line after it takes over, and a flex item's baseline still reads the scroll container's
  # line.
  it 'hangs an inline-block from a scroll-container child by its margin edge' do
    ib = ->(kids) { %(<div id="c" style="width:400px">t#{ruler}<span id="i" style="display:inline-block">#{kids}</span></div>) }
    boxes, = measure(ib.call('<div>t</div><div style="overflow:hidden;margin-bottom:10px">oh</div>'), ['#c', '#c > span:nth-of-type(1)', '#i'])
    line, ruler_box, box = boxes
    expect(box[1] + box[3] - line[1]).to be_within(0.02).of(ruler_box[1] - line[1])

    boxes, = measure(ib.call('<div>t</div><div id="s" style="overflow:hidden">oh</div><div style="height:5px"></div>'), ['#c', '#c > span:nth-of-type(1)', '#s'])
    line, ruler_box, scroller = boxes
    expect(scroller[1] + scroller[3] - line[1]).to be_within(0.02).of(ruler_box[1] - line[1])

    boxes, = measure(ib.call("<div style=\"overflow:hidden\">oh</div><div>t#{ruler}</div>"), ['#c > span:nth-of-type(1)', '#i span'])
    expect(boxes[1][1]).to be_within(0.02).of(boxes[0][1])

    body = %(<div style="display:flex;align-items:last baseline;width:400px"><div><div>t</div><div style="overflow:hidden;height:40px;margin-bottom:6px">oh#{ruler}</div></div><div style="font-size:32px">BIG#{ruler}</div></div>)
    boxes, = measure(body, ['div > div > div > span', 'div > div:nth-of-type(2) > span'])
    expect(boxes[1][1]).to be_within(0.02).of(boxes[0][1])
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
