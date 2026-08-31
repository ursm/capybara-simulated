# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Which way a flex line RUNS. `flex-direction` names the axes in flow terms — `row` is the inline
# axis, `column` the block one — and the layout took them physically: `row` ran left-to-right and
# `column` top-to-bottom whatever the container's `writing-mode` and `direction` said. So a
# `vertical-rl` row stacked its items across the page instead of down it, and an RTL row packed
# them from the left. Two thirds of Chrome's writing-mode matrix disagreed with us.
#
# Three reversals live on these axes and they are NOT the same question, which is most of what this
# file pins:
#   - where the main axis physically points (`rtl`, `-reverse`, a vertical mode);
#   - where the cross axis physically points (a vertical mode, `wrap-reverse`);
#   - and `flex-direction: -reverse` by itself, which is the only one `justify-content: start` — a
#     FLOW-relative keyword — follows.
#
# Every figure is Chrome 151-measured on this machine, in a 200x120 container with `gap: 10px` and
# three 40x30 items unless the example says otherwise.
RSpec.describe 'flex axes' do
  include LayoutMeasure

  # The three items' `[x, y]` inside the container, as offsets from its own origin.
  def axes(container, items: 3, item: 'width:40px;height:30px')
    body = %(<div id="c" style="width:200px;height:120px;display:flex;gap:10px;#{container}">) +
           (0...items).map {|i| %(<div id="i#{i}" style="#{item}">#{i}</div>) }.join + '</div>'
    boxes, = measure(body, ['#c'] + (0...items).map {|i| "#i#{i}" })
    c = boxes.shift
    boxes.map {|b| [(b[0] - c[0]).round, (b[1] - c[1]).round] }
  end

  # The baseline: an LTR horizontal row runs across the page, and its cross axis down it.
  it 'runs a horizontal-tb row across the page' do
    expect(axes('')).to eq([[0, 0], [50, 0], [100, 0]])
  end

  # `direction: rtl` puts the inline axis's start at the RIGHT, so the row packs from there — and
  # this is a `row`, not a `row-reverse`: the items are still in source order along the axis.
  it 'packs an RTL row from the right' do
    expect(axes('direction:rtl')).to eq([[160, 0], [110, 0], [60, 0]])
  end

  # `row-reverse` reverses the axis inside the flow, so an RTL one runs left-to-right again.
  it 'un-reverses an RTL row-reverse' do
    expect(axes('direction:rtl;flex-direction:row-reverse')).to eq([[0, 0], [50, 0], [100, 0]])
  end

  # A vertical writing mode turns the inline axis DOWN the page, so a `row` stacks — and the cross
  # axis is the block one, which `vertical-rl` runs right-to-left, putting the items at the far edge.
  it 'runs a vertical-rl row down the page' do
    expect(axes('writing-mode:vertical-rl')).to eq([[160, 0], [160, 40], [160, 80]])
  end

  it 'runs a vertical-lr row down the page against the near edge' do
    expect(axes('writing-mode:vertical-lr')).to eq([[0, 0], [0, 40], [0, 80]])
  end

  # …and a `column` in that mode runs across the page, from the block-start edge.
  it 'runs a vertical-rl column across the page from the right' do
    expect(axes('writing-mode:vertical-rl;flex-direction:column')).to eq([[160, 0], [110, 0], [60, 0]])
  end

  # Both reversals at once: `vertical-rl` + `rtl` + `row` runs UP the page (the inline axis is
  # bottom-to-top) with its cross at the right.
  it 'stacks a vertical-rl RTL row from the bottom' do
    expect(axes('writing-mode:vertical-rl;direction:rtl')).to eq([[160, 90], [160, 50], [160, 10]])
  end

  # The GAPS stay flow-relative: `column-gap` is the gap along the INLINE axis whatever direction
  # that axis points, so it spaces a vertical-rl row's items vertically — and `row-gap` does not.
  it 'takes the main gap from column-gap in a vertical row' do
    expect(axes('writing-mode:vertical-rl;column-gap:20px', item: 'width:40px;height:30px;flex:none'))
      .to eq([[160, 0], [160, 50], [160, 100]])
    # …and `row-gap` leaves the main axis on the `gap: 10px` shorthand's figure.
    expect(axes('writing-mode:vertical-rl;row-gap:20px', item: 'width:40px;height:30px;flex:none'))
      .to eq([[160, 0], [160, 40], [160, 80]])
  end

  # `justify-content` distributes along the main axis wherever it points.
  it 'centres along a vertical main axis' do
    expect(axes('writing-mode:vertical-rl;justify-content:center')).to eq([[160, 5], [160, 45], [160, 85]])
  end

  # `align-items` places across it: `center` is symmetric, but `flex-end` is the far end of the
  # CROSS axis, which `vertical-rl` points left.
  it 'aligns across a horizontal cross axis' do
    expect(axes('writing-mode:vertical-rl;align-items:center')).to eq([[80, 0], [80, 40], [80, 80]])
    expect(axes('writing-mode:vertical-rl;align-items:flex-end')).to eq([[0, 0], [0, 40], [0, 80]])
  end

  # `start` / `end` are FLOW relative and do not follow the physical direction of the axis: an RTL
  # row's main-start IS its right edge, so `justify-content: start` leaves the items there — where
  # `flex-start` on a `row-reverse` follows the reversal instead.
  it 'keeps justify-content: start at the flow start of an RTL row' do
    expect(axes('direction:rtl;justify-content:start')).to eq([[160, 0], [110, 0], [60, 0]])
    # …and a `row-reverse` in the same flow runs left-to-right, so its flow start is the FAR end of
    # where it runs: the items pack against the right edge in source order.
    expect(axes('direction:rtl;flex-direction:row-reverse;justify-content:start')).to eq([[60, 0], [110, 0], [160, 0]])
  end

  # …and `align-self: start` is the cross axis's flow start, which in `vertical-rl` is the right
  # edge — the far physical one.
  it 'puts align-items: start at the cross flow start' do
    expect(axes('writing-mode:vertical-rl;align-items:start')).to eq([[160, 0], [160, 40], [160, 80]])
  end
end
