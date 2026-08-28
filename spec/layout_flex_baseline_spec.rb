# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# `align-items: baseline` was not modelled: a baseline item was placed where `flex-start` puts it,
# so a 32px heading beside a 16px label sat on the label's top edge instead of on its baseline —
# every toolbar, badge and figure-with-caption that lines its text up.
#
# The figures here are derived rather than pinned, because an item's ascent is the FACE's, not the
# spec's. The measuring device is a zero-height item: §8.3 synthesises its baseline at its own
# margin edge, so a group of it and one text item has the text item's baseline — and the ruler's y
# IS that item's ascent. (Chrome answers 14 / 29 / 24 for the three fixtures below, and so do we;
# what the examples assert is the arithmetic those numbers have to satisfy.)
RSpec.describe 'flex baseline alignment' do
  include LayoutMeasure

  # `[x, y, width, height]` per item, then the container's own box.
  def flex(container, items)
    body = <<~HTML
      <div id="c" style="display:flex;width:400px;#{container}">
        #{items.map {|inner| %(<div style="#{inner[:style]}">#{inner[:html]}</div>) }.join}
      </div>
    HTML
    boxes, _text, line = measure(body, (1..items.size).map {|i| "#c > div:nth-child(#{i})" } + ['#c'])
    [boxes.map {|b| b.map {|n| n.round(2) } }, line]
  end

  def item(html, style = '') = {html: html, style: style}
  # A zero-height item's synthesised baseline is its own top edge, so it lands exactly on the
  # group's baseline: this reads back the OTHER item's ascent.
  def ruler = item('', 'width:5px;height:0')

  def ascent_of(subject)
    boxes, = flex('align-items:baseline', [subject, ruler])
    boxes[1][1]
  end

  it 'puts items of different sizes on one baseline' do
    small = item('small')
    big   = item('big', 'font-size:32px')
    boxes, = flex('align-items:baseline', [small, big])

    expect(boxes[0][1] + ascent_of(small)).to eq(boxes[1][1] + ascent_of(big))
    # The line is the deepest ascent plus the deepest descent below that baseline — here both come
    # from the taller item, so the container is exactly its height.
    expect(boxes.last[3]).to eq(boxes[1][3])
  end

  # The alignment is of the MARGIN box: padding and border push the first line down inside the item,
  # and a margin moves the whole thing.
  it 'measures the baseline from the margin box' do
    padded = item('pad', 'padding:10px;border:2px solid')
    plain  = item('plain')
    boxes, = flex('align-items:baseline', [padded, plain])
    expect(boxes[0][1] + ascent_of(padded)).to eq(boxes[1][1] + ascent_of(plain))

    moved, = flex('align-items:baseline', [item('m8', 'margin-top:8px'), plain])
    expect(moved[1][1]).to eq(8)
    expect(ascent_of(item('m8', 'margin-top:8px'))).to eq(8 + ascent_of(plain))
  end

  # §8.3: an item with nothing on a line anywhere inside it aligns as if its baseline were its
  # margin box's far edge — which is what drops the text beside a plain box.
  it 'synthesises a baseline from the box of an item that has no line' do
    text = item('text')
    boxes, = flex('align-items:baseline', [text, item('', 'width:40px;height:40px')])

    expect(boxes[0][1]).to eq(40 - ascent_of(text))
    expect(boxes[1][1]).to eq(0)
    expect(boxes.last[3]).to eq(40 + (boxes[0][3] - ascent_of(text)))
  end

  # The baseline comes from the first LINE in the item, however deep it sits…
  it 'takes the first line from anywhere inside the item' do
    deep = item('<div style="height:30px"></div><div>deep</div>')
    expect(ascent_of(deep)).to eq(30 + ascent_of(item('deep')))
  end

  # …and a nested flex container answers with the baseline of its own item.
  it 'reads through a nested flex container' do
    nested = item('<div style="display:flex"><div>inner</div></div>')
    expect(ascent_of(nested)).to eq(ascent_of(item('inner')))
  end

  # A bigger font on the item's first line moves the LINE's baseline: the line is as tall as its
  # tallest box, and each box's half-leading is measured against that height.
  it 'follows the deepest box on the line' do
    mixed = item('x <span style="font-size:32px">BIG</span>')
    expect(ascent_of(mixed)).to eq(ascent_of(item('BIG', 'font-size:32px')))
  end

  # `last baseline` aligns the items' LAST lines, and hangs the group from the line's far edge
  # rather than its near one.
  it 'aligns the last lines, from the end of the line' do
    two = item('a<br>b')
    big = item('big', 'font-size:32px')
    boxes, line = flex('align-items:last baseline;height:80px', [two, big])

    # Both items' last baselines coincide: the two-line item's is one line below its first.
    expect(boxes[0][1] + ascent_of(two) + line).to eq(boxes[1][1] + ascent_of(big))
    # …and the group hangs from the bottom of the line, where `baseline` puts it at the top.
    expect(boxes[0, 2].map {|b| b[1] + b[3] }.max).to eq(80)
    first, = flex('align-items:baseline;height:80px', [two, big])
    expect(first[0, 2].map {|b| b[1] }.min).to eq(0)
  end

  # A `wrap-reverse` container runs its cross axis backwards, so the group hangs from the line's far
  # edge — and the items still share one baseline inside it.
  it 'anchors the group at the cross-start under wrap-reverse' do
    small = item('small')
    big   = item('big', 'font-size:32px')
    boxes, = flex('align-items:baseline;flex-wrap:wrap-reverse;height:60px', [small, big])

    expect(boxes[0][1] + ascent_of(small)).to eq(boxes[1][1] + ascent_of(big))
    expect(boxes[0, 2].map {|b| b[1] + b[3] }.max).to eq(60)
  end

  # Where the baseline COMES FROM is the half these examples have to pin, because the group
  # placement above is satisfied by any consistent answer.
  describe 'where the baseline comes from' do
    # An item that is itself a flex container answers with the baseline of the item INSIDE it,
    # wherever that item's own alignment put it — so centring a line in a 60px box moves the
    # baseline down by the half it was centred by.
    it 'follows an item aligned inside a nested container' do
      _boxes, line = flex('align-items:baseline', [item('plain')])
      nested = item('<div>a</div>', 'display:flex;align-items:center;height:60px')
      expect(ascent_of(nested)).to eq(((60 - line) / 2).floor + ascent_of(item('a')))
    end

    # …and the baseline is the box's OWN, so it survives being moved: a mutation that re-lays the
    # container without re-laying its items must not change where anything sits.
    it 'survives a mutation that reuses the items' do
      body = <<~HTML
        <div id="c" style="display:flex;align-items:baseline;width:400px">
          <div>small</div><div style="font-size:32px">big</div>
        </div>
      HTML
      before, _text, _line, session = measure(body, ['#c > div:nth-child(1)', '#c > div:nth-child(2)', '#c'])
      session.execute_script(<<~JS)
        const c = document.getElementById('c');
        c.appendChild(Object.assign(document.createElement('div'), {textContent: 'more'}));
        c.lastElementChild.remove();
      JS
      after = session.evaluate_script(<<~JS)
        ['#c > div:nth-child(1)', '#c > div:nth-child(2)', '#c'].map(s => {
          const r = document.querySelector(s).getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        })
      JS
      expect(after.map {|b| b.map {|n| n.round(2) } }).to eq(before.map {|b| b.map {|n| n.round(2) } })
    end

    # A float has no line in the block that contains it, so the baseline is read past it.
    it 'reads past a float' do
      floated = item('<div style="float:left;width:20px;height:40px">f</div><div>after</div>')
      expect(ascent_of(floated)).to eq(40 + ascent_of(item('after')))
    end

    # A line a `<br>` left empty is still a line, and still has a baseline.
    it 'reads a line a break left empty' do
      expect(ascent_of(item('<br>'))).to eq(ascent_of(item('x')))
    end

    # Each box's half-leading is measured against its OWN `line-height`, so a taller one lowers the
    # baseline by half of what it added — and a `line-height` SHORTER than the font box raises it,
    # which a half-leading clamped at zero could not express.
    it 'follows the item\'s own line-height' do
      _boxes, line = flex('align-items:baseline', [item('plain')])
      expect(ascent_of(item('tall', 'line-height:60px')) - ascent_of(item('plain')))
        .to eq(((60 - line) / 2).floor)
      expect(ascent_of(item('short', 'line-height:10px')) - ascent_of(item('plain')))
        .to eq(((10 - line) / 2).floor)
    end

    # A scroll container's baselines come from its own border box (CSS Align §9), which is what
    # keeps a clipped box's baseline inside it.
    it 'keeps a scroll container baseline inside its box' do
      clipped = item('t', 'overflow:hidden;height:8px')
      expect(ascent_of(clipped)).to eq(8)
      expect(ascent_of(item('t', 'height:8px'))).to eq(ascent_of(item('t')))
    end

    # `first baseline` is the long spelling of `baseline`; `safe` and `unsafe` take a
    # <self-position>, which a baseline is not, so Chrome drops that declaration entirely.
    it 'reads the long and the invalid spellings' do
      long, = flex('align-items:first baseline', [item('small'), item('big', 'font-size:32px')])
      plain, = flex('align-items:baseline', [item('small'), item('big', 'font-size:32px')])
      expect(long).to eq(plain)

      dropped, = flex('align-items:safe baseline;height:60px', [item('small'), item('big', 'font-size:32px')])
      stretched, = flex('height:60px', [item('small'), item('big', 'font-size:32px')])
      expect(dropped).to eq(stretched)
    end
  end

  # A COLUMN's cross axis is the inline one, where horizontal text has no baseline to align on:
  # Chrome leaves such items at the start, and so do we.
  it 'falls back to the start in a column' do
    boxes, = flex('align-items:baseline;flex-direction:column;height:80px',
                  [item('small'), item('big', 'font-size:32px')])
    expect(boxes[0, 2].map {|b| b[0] }).to eq([0, 0])
  end
end
