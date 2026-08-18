# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# `ch` and `ex` are FONT metrics, not fractions of the font size: `1ch` is the
# advance of the font's `0` and `1ex` its x-height. Both used to answer a flat
# 0.5em — which is only what the spec says to fall back to when the metric can't
# be read — so `width: 60ch` came out 480px where Chrome renders 534, and the
# engine had the numbers all along (it measures runs from the same font file).
#
# The figures are asserted as RELATIONS to text measured in the page, not as the
# pixels Chrome printed: those depend on which face fontconfig serves. For the
# record, Chrome 151 on this box (16px Arial → Liberation Sans): 1ch = 8.891,
# 1ex = 8.453; Liberation Serif 1ch = 8, 1ex = 7.344; the monospace default
# 1ch = 9.6.
#
# These are LAYOUT assertions. `getComputedStyle().width` doesn't report a
# font-relative length in px yet — it answers `10ch`, and `10em` and `50%` and
# `auto` the same way, where Chrome resolves all four (CSSOM's resolved value is
# the USED value for width/height). That gap is older and wider than this unit,
# and belongs to its own increment.
RSpec.describe 'font-relative units' do
  include LayoutMeasure

  # A `ch` is defined as the advance of `0`, so ten of them are exactly as wide as
  # the string "0000000000" set in the same font — which is how a page uses the
  # unit (`width: 60ch` to hold sixty digits).
  it 'measures ch as the advance of the font zero' do
    body = <<~HTML
      <div id="ten" style="width:10ch"></div>
      <div id="one" style="width:1ch"></div>
    HTML
    boxes, text = measure(body, ['#ten', '#one'], probes: ['0000000000'], style: 'margin:0;font:16px Arial')
    ten, one = boxes
    expect(ten[2].round(3)).to eq(text['0000000000'].round(3))
    expect((one[2] * 10).round(3)).to eq(ten[2].round(3))
  end

  # …and it follows the FONT, not the size: each family answers with its own `0`.
  # The equalities hold in ANY environment — a box with no usable font metrics
  # estimates the run and the unit from the same figure, which is the point of
  # `build_font_advance_table` refusing a table it got nothing out of.
  it 'reads ch from whichever font the element resolves to' do
    body = <<~HTML
      <div id="sans" style="font-family:Arial;width:10ch"></div>
      <div id="serif" style="font-family:'Liberation Serif',serif;width:10ch"></div>
      <div id="mono" style="font-family:monospace;width:10ch"></div>
      <span id="p-sans" style="white-space:pre;font-family:Arial">0000000000</span>
      <span id="p-serif" style="white-space:pre;font-family:'Liberation Serif',serif">0000000000</span>
      <span id="p-mono" style="white-space:pre;font-family:monospace">0000000000</span>
    HTML
    boxes, = measure(body, ['#sans', '#serif', '#mono', '#p-sans', '#p-serif', '#p-mono'], style: 'margin:0;font-size:16px')
    sans, serif, mono, p_sans, p_serif, p_mono = boxes
    expect(sans[2].round(3)).to eq(p_sans[2].round(3))
    expect(serif[2].round(3)).to eq(p_serif[2].round(3))
    expect(mono[2].round(3)).to eq(p_mono[2].round(3))

    # …and where the faces DO resolve, they differ — without that the equalities
    # above would also hold for the flat 0.5em this replaced. Skipped rather than
    # weakened on a box with no font metrics (a CI image without fontconfig): every
    # family estimates 8px per character there, so there is nothing to tell apart.
    widths = [sans[2], serif[2], mono[2]]
    skip 'no font metrics on this box — every family falls back to the estimate' if widths.uniq == [FALLBACK_10CH_PX]

    expect(widths.uniq.size).to be > 1
  end

  # 10ch of the 0.5em fallback at the 16px these examples use.
  FALLBACK_10CH_PX = 80

  # `ex` is the x-height, which is smaller than the `0` advance in every face here
  # and — the point — is NOT half the font size.
  it 'measures ex as the font x-height rather than half the em' do
    body = <<~HTML
      <div id="ex" style="width:10ex"></div>
      <div id="ch" style="width:10ch"></div>
      <div id="em" style="width:10em"></div>
    HTML
    boxes, = measure(body, ['#ex', '#ch', '#em'], style: 'margin:0;font:16px Arial')
    ex, ch, em = boxes
    expect(em[2]).to eq(160)                      # 10em at 16px, by definition
    expect(ex[2]).to be_between(0.4 * em[2], 0.6 * em[2])
    # The x-height is under the `0` advance in every face — but only a box that HAS
    # the metrics can say so; without them both are the same 0.5em estimate.
    skip 'no font metrics on this box' if [ex[2], ch[2]] == [FALLBACK_10CH_PX, FALLBACK_10CH_PX]

    expect(ex[2]).not_to eq(em[2] / 2)            # …and not 10 * 8px
    expect(ex[2]).to be < ch[2]
  end

  # Both scale with the font size, which is what makes them useful in a shorthand
  # like `font: 32px/1 Arial`.
  it 'scales ch and ex with the font size' do
    body = <<~HTML
      <div style="font:16px Arial"><div id="small-ch" style="width:10ch"></div><div id="small-ex" style="width:10ex"></div></div>
      <div style="font:32px Arial"><div id="big-ch" style="width:10ch"></div><div id="big-ex" style="width:10ex"></div></div>
    HTML
    boxes, = measure(body, ['#small-ch', '#small-ex', '#big-ch', '#big-ex'], style: 'margin:0')
    small_ch, small_ex, big_ch, big_ex = boxes
    expect(big_ch[2].round(3)).to eq((small_ch[2] * 2).round(3))
    expect(big_ex[2].round(3)).to eq((small_ex[2] * 2).round(3))
  end
end
