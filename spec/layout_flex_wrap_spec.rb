# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# `flex-wrap` was not modelled at all: the row algorithm laid every item on ONE line and shrank them
# to fit it, so three 60px items in a 100px container came out 33.3px wide side by side where a
# browser puts them at 60px on three lines. That is not a rounding difference — it is the wrong box
# for every item, and a wrapping toolbar or tag list is an ordinary thing for a page to have.
#
# §9.3 breaks the items into lines by their hypothetical outer main size (the same figures the
# distribution then flexes, so the breaker and the sizer cannot disagree), each line is laid out by
# the algorithm that already existed, and §9.6 `align-content` places the lines in the container's
# cross size.
#
# Every figure below is measured in Chrome 151.0.7922.169 on the same markup, in a 100x90 container
# of three 60x20 items.
RSpec.describe 'a wrapping flex container' do
  include LayoutMeasure

  # A plain item, which three of cannot share the container's 100px line — what makes it wrap.
  def item(extra = '') = "width:60px;height:20px;#{extra}"

  # One container of `items`, and the `[x, y, width, height]` of each with the container's own box
  # last.
  def wrap(container, items = Array.new(3) { item })
    body = <<~HTML
      <div id="c" style="display:flex;flex-wrap:wrap;width:100px;height:90px;#{container}">
        #{items.map {|style| %(<div style="#{style}"></div>) }.join}
      </div>
    HTML
    boxes, = measure(body, (1..items.size).map {|i| "#c > div:nth-child(#{i})" } + ['#c'])
    boxes.map {|b| b.map {|n| n.round(2) } }
  end

  # Which line each item landed on, as its y — the whole question for breaking and `align-content`.
  def ys(container, items = Array.new(3) { item }) = wrap(container, items)[..-2].map {|b| b[1] }
  def xs(container, items = Array.new(3) { item }) = wrap(container, items)[..-2].map {|b| b[0] }

  describe 'breaking the line' do
    # Three 60px items cannot share a 100px line, so each takes one — at its own width, not squeezed
    # to a third of the container. The lines then STRETCH to fill the 90px cross size
    # (`align-content` is `normal`), which is what puts them 30px apart while each item stays 20 tall.
    it 'breaks items onto their own lines instead of shrinking them' do
      boxes = wrap('')
      expect(boxes[..-2]).to eq([[0, 0, 60, 20], [0, 30, 60, 20], [0, 60, 60, 20]])
      expect(boxes.last[3]).to eq(90)
    end

    # A `nowrap` container is still ONE line however far it overflows, with the items shrunk into it
    # — the behaviour every existing toolbar depends on, and the reason this could not simply always
    # wrap. Asserted as a shape rather than as three exact thirds: Chrome snaps used lengths to
    # 1/64px (33.34, then 33.33 twice) and we do not, which is a rounding gap of its own — so the
    # tolerance here is the two decimal places these boxes are read to, not a slack in the rule.
    it 'leaves a nowrap container on one line' do
      (x1, y1, w1), (x2, y2, w2), (x3, y3, w3) = wrap('flex-wrap:nowrap')[..-2]
      expect([y1, y2, y3]).to eq([0, 0, 0])
      expect(x1).to eq(0)
      expect([x2 - w1, x3 - w1 - w2]).to all(be_within(0.02).of(0))
      expect(w1 + w2 + w3).to be_within(0.02).of(100)
    end

    # What a line has room for counts the gaps and the items' own margins, not just their widths:
    # 45 + 10 + 45 fits a 100px line exactly, and one more pixel of either does not.
    it 'counts the gap and the margins in what fits' do
      pair = Array.new(2) { 'width:45px;height:20px' }
      expect(xs('column-gap:10px', pair)).to eq([0, 55])
      expect(ys('column-gap:11px', pair)).to eq([0, 45])
      expect(ys('', ['width:45px;height:20px;margin-right:12px', 'width:45px;height:20px'])).to eq([0, 45])
    end

    # An item too wide for a line on its own still gets one — and is then shrunk into it like any
    # other overflowing line, which is what keeps the breaker terminating.
    it 'gives an item wider than the line one of its own' do
      boxes = wrap('', ['width:140px;height:20px', item])
      expect(boxes[..-2]).to eq([[0, 0, 100, 20], [0, 45, 60, 20]])
    end

    # A percentage basis resolves against the container's main size before the break is decided, so
    # two 60% items need a line each where two 40% ones share one.
    it 'breaks on the resolved basis, not the declared one' do
      expect(ys('', Array.new(2) { 'flex:0 0 60%;height:20px' })).to eq([0, 45])
      expect(ys('', Array.new(2) { 'flex:0 0 40%;height:20px' })).to eq([0, 0])
    end

    # …and the shorthand reaches the same breaker as the longhand.
    it 'reads flex-flow' do
      expect(ys('flex-wrap:nowrap;flex-flow:row wrap')).to eq([0, 30, 60])
    end

    # Each line resolves its own widths, so a grower fills the line it is ON rather than sharing the
    # row with items it never sits beside.
    it 'grows the items on each line to fill it' do
      boxes = wrap('', Array.new(3) { 'flex:1 0 60px;height:20px' })
      expect(boxes[..-2]).to eq([[0, 0, 100, 20], [0, 30, 100, 20], [0, 60, 100, 20]])
    end
  end

  describe 'align-content' do
    it 'packs the lines where the keyword says' do
      expect(ys('align-content:flex-end')).to eq([30, 50, 70])
      expect(ys('align-content:center')).to eq([15, 35, 55])
      expect(ys('align-content:space-between')).to eq([0, 35, 70])
    end

    # `left` / `right` are not <content-position> values (CSS Align 3 §6.2), so the declaration is
    # dropped and the lines stretch as `normal` does.
    it 'drops left and right' do
      expect(ys('align-content:right')).to eq([0, 30, 60])
    end

    # `row-gap` is the CROSS gap of a row container, so it sits between the lines.
    it 'puts row-gap between the lines' do
      expect(ys('row-gap:6px;align-content:flex-start')).to eq([0, 26, 52])
    end

    # `stretch` — the initial value — hands the free space to the LINES, and the items stretch to
    # the line they are on.
    it 'stretches the lines to fill the container' do
      boxes = wrap('height:40px', Array.new(3) { 'width:60px' })
      expect(boxes[..-2].map {|b| b[1] }).to eq([0, 13.33, 26.67])
      expect(boxes[..-2].map {|b| b[3] }.sum).to be_within(0.01).of(40)
    end

    # An auto cross size wraps every line rather than the tallest item.
    it 'grows an auto height to hold every line' do
      boxes = wrap('height:auto')
      expect(boxes.last[3]).to eq(60)
      expect(boxes[..-2].map {|b| b[1] }).to eq([0, 20, 40])
    end

    # With the lines overflowing there is nothing to distribute, and every keyword that distributes
    # falls back to packing them at the start.
    it 'packs overflowing lines at the start' do
      expect(ys('height:40px')).to eq([0, 20, 40])
      expect(ys('height:40px;align-content:space-between')).to eq([0, 20, 40])
      expect(ys('height:40px;align-content:space-around')).to eq([0, 20, 40])
    end

    # `align-content` applies to a container that SAYS `wrap`, not to one that needed a second line:
    # a single-line `wrap` container's line is as tall as what is on it and is aligned like any
    # other, where a `nowrap` container hands its line the whole cross size and ignores the keyword.
    it 'applies to a wrap container holding a single line' do
      expect(wrap('align-content:center', [item])[0][1]).to eq(35)
      expect(wrap('flex-wrap:nowrap;align-content:center', [item])[0][1]).to eq(0)
      expect(wrap('align-content:flex-start', ['width:60px'])[0][3]).to eq(0)
      expect(wrap('flex-wrap:nowrap;align-content:flex-start', ['width:60px'])[0][3]).to eq(90)
    end
  end

  describe 'wrap-reverse' do
    # The lines stack from the far edge — the first line last — while each still runs left to right
    # inside itself.
    it 'stacks the lines from the far edge' do
      expect(ys('flex-wrap:wrap-reverse')).to eq([70, 40, 10])
      expect(ys('flex-wrap:wrap-reverse;align-content:flex-start')).to eq([70, 50, 30])
      expect(ys('flex-wrap:wrap-reverse;align-content:flex-end')).to eq([40, 20, 0])
    end

    # `flex-start` / `flex-end` follow the reversed cross axis; `start` / `end` are flow-relative and
    # stay where the writing mode put them.
    it 'follows the reversed axis for the flex keywords only' do
      expect(ys('flex-wrap:wrap-reverse;align-content:start')).to eq([40, 20, 0])
      expect(ys('flex-wrap:wrap-reverse;align-content:end')).to eq([70, 50, 30])
    end

    # …and the same split decides where an ITEM sits across its line.
    it 'follows it for the items across their line too' do
      expect(ys('flex-wrap:wrap-reverse;align-items:flex-start')).to eq([70, 40, 10])
      expect(ys('flex-wrap:wrap-reverse;align-items:start')).to eq([60, 30, 0])
      expect(ys('flex-wrap:wrap-reverse;align-items:center')).to eq([65, 35, 5])
    end

    # Overflowing, the two distribution keywords fall back differently: `space-between` to
    # `flex-start`, which is the container's BOTTOM here, and `space-around` to a safe `center`,
    # which under overflow is the physical top.
    it 'falls back to opposite ends when the lines overflow' do
      expect(ys('height:40px;flex-wrap:wrap-reverse')).to eq([20, 0, -20])
      expect(ys('height:40px;flex-wrap:wrap-reverse;align-content:space-around')).to eq([40, 20, 0])
    end
  end

  # `row-reverse` runs each line from the right; the lines themselves still stack downwards.
  it 'breaks a row-reverse container from the right' do
    expect(xs('flex-direction:row-reverse')).to eq([40, 40, 40])
    expect(ys('flex-direction:row-reverse')).to eq([0, 30, 60])
  end
end
