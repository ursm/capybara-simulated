# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An absolutely positioned child of a flex container is not a flex item, but its STATIC POSITION is
# where it would sit if it were the sole item of the line (CSS Flexbox §4.1) — the container's
# `justify-content` along the main axis, the child's `align-self` across it. Which PHYSICAL edge
# each axis starts at is the part that was missing: the flex pass assumed an LTR horizontal writing
# mode and fell back to the content origin for everything else, so an RTL toolbar's dropdown opened
# on the wrong side and a `vertical-rl` container placed nothing at all.
#
# `flowSides` already resolves writing-mode and direction into physical sides — the same map behind
# `margin-inline-start` — so `row` is the inline axis whichever way it runs, `column` is the block
# axis, `-reverse` takes the far edge, and `wrap-reverse` does the same to the cross axis.
#
# Every offset below is measured in Chrome 151.0.7922.169 on the same markup.
RSpec.describe 'the static position of an abspos child of a flex container' do
  def offsets(container_style, child_style = '')
    s = simulated_session(->(_env) do
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head><style>body { margin: 0 }' \
        '.f { display: flex; position: relative; width: 100px; height: 100px }' \
        '.a { position: absolute; width: 50px; height: 50px }' \
        "</style></head><body><div class=\"f\" style=\"#{container_style}\">" \
        "<div class=\"a\" id=\"t\" style=\"#{child_style}\"></div></div></body></html>"]]
    end)
    s.visit '/'
    s.evaluate_script("(() => { const e = document.getElementById('t'); return [e.offsetLeft, e.offsetTop]; })()")
  end

  # `direction: rtl` makes the inline axis run right-to-left, so a row's main-start is the RIGHT
  # edge and the sole hypothetical item packs against it.
  it 'starts a row at the right edge in an RTL container' do
    expect(offsets('direction: rtl')).to eq([50, 0])
  end

  # A vertical writing mode makes the INLINE axis vertical, so `flex-direction: row` runs down the
  # page — main-start is the top, and the cross axis is horizontal, running right-to-left. The
  # ASYMMETRIC pair is the point: a symmetric one cannot tell a correct mapping from one that has
  # swapped the two axes.
  it 'runs a row down the page in a vertical writing mode' do
    expect(offsets('writing-mode: vertical-rl')).to eq([50, 0])
    expect(offsets('writing-mode: vertical-rl; justify-content: flex-end; align-items: center'))
      .to eq([25, 50])
    expect(offsets('writing-mode: vertical-rl; justify-content: center; align-items: flex-end'))
      .to eq([0, 25])
  end

  # `left` / `right` are PHYSICAL, so which END of the main axis they name depends on where the axis
  # runs: in an RTL row main-start is the right edge, and `left` is therefore its far end.
  it 'resolves justify-content left against the physical axis' do
    expect(offsets('direction: rtl; justify-content: left')).to eq([0, 0])
  end

  # §4.1 aligns the hypothetical item's MARGIN box, so the margin that leads is the one on the
  # axis's start side — the RIGHT margin in a reversed row, not the left.
  it 'takes the lead margin from the side the axis starts at' do
    expect(offsets('flex-direction: row-reverse', 'margin-right: 20px')).to eq([30, 0])
  end

  # The container's CONTENT box is what the item is aligned in, so its padding and border shift the
  # whole thing — the far edge of an RTL row is the content box's right edge, not the border box's.
  it 'aligns inside the content box, not the border box' do
    expect(offsets('direction: rtl; padding: 10px 20px 30px 40px')).to eq([90, 10])
  end

  # `-reverse` takes the far edge of its own axis, independently of the flow.
  it 'starts a reversed row at the far edge' do
    expect(offsets('flex-direction: row-reverse')).to eq([50, 0])
  end

  # …and the two compose: an RTL row starts at the right, so `justify-content: flex-end` packs at
  # the left. Reading `flex-end` as "the physical right" is what the LTR-only mapping did.
  it 'composes the flow with justify-content' do
    expect(offsets('direction: rtl; justify-content: flex-end')).to eq([0, 0])
  end

  # `wrap-reverse` reverses the CROSS axis, so cross-start is the bottom and `align-items:
  # flex-start` puts the item there.
  it 'reverses the cross axis for wrap-reverse' do
    expect(offsets('flex-flow: row wrap-reverse; align-items: flex-start')).to eq([0, 50])
  end

  # But only the FLEX-relative keywords follow that reversal. `start` / `end` / `self-start` /
  # `self-end` / `baseline` are WRITING-MODE relative and stay put — the same distinction the main
  # axis makes between `flex-start` and `start`.
  it 'leaves a writing-mode keyword where the writing mode puts it' do
    expect(offsets('flex-flow: row wrap-reverse', 'align-self: start')).to eq([0, 0])
    expect(offsets('flex-flow: row wrap-reverse', 'align-self: baseline')).to eq([0, 0])
    expect(offsets('flex-flow: row wrap-reverse', 'align-self: flex-start')).to eq([0, 50])
  end

  # …and `self-start` / `self-end` are relative to the ITEM's own writing mode rather than the
  # container's, which is the one place the two can disagree: a horizontal child of a vertical
  # container calls its own top self-start, where `start` follows the container's flow.
  it 'reads self-start in the item own writing mode' do
    expect(offsets('writing-mode: vertical-rl', 'writing-mode: horizontal-tb; align-self: self-start'))
      .to eq([0, 0])
    expect(offsets('writing-mode: vertical-rl', 'writing-mode: horizontal-tb; align-self: start'))
      .to eq([50, 0])
  end

  # Both axes at once, in a writing mode where the main axis is vertical and the cross axis runs
  # left-to-right.
  it 'places on both axes of a vertical container' do
    expect(offsets('writing-mode: vertical-lr; justify-content: flex-end; align-items: flex-end'))
      .to eq([50, 50])
  end
end
