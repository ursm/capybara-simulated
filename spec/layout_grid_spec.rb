# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Grid COLUMN track sizing — CSS Grid §12, as much of it as the track lists real
# stylesheets are written in need. Before this, the pass counted the tracks and
# divided the container evenly, which got two things wrong at once: a fixed track
# didn't keep its size, and the count itself was taken by splitting the list on
# whitespace — so `minmax(0, 1fr)` read as TWO tracks. Discourse's shell is
# `17em minmax(0, 1fr)`; it read as three even columns, the main one came out a
# third of the page instead of three quarters, and every post wrapped into a column
# narrow enough that the topic ran three times too tall.
#
# Every figure below is a Chrome 151 measurement of the same markup (headless,
# 1024x768), and the fixed-length cases are exact px because nothing about them
# depends on the font.
RSpec.describe 'grid track sizing' do
  include LayoutMeasure

  # `width` on the body rather than the viewport's own 1024, so the arithmetic in
  # each expectation is visible.
  def widths_of(template, items: 2, style: '', width: 1000)
    body = <<~HTML
      <div id="g" style="display:grid;grid-template-columns:#{template};#{style}">
        #{(1..items).map {|i| %(<div id="i#{i}">item#{i}</div>) }.join}
      </div>
    HTML
    boxes, = measure(body, (1..items).map {|i| "#i#{i}" }, style: "margin:0;width:#{width}px;font:16px Arial")
    boxes.map {|b| b[2].round }
  end

  it 'gives a fixed track its size and the rest to fr' do
    # Chrome: 250 / 750. The percentage resolves against the container, and `1fr`
    # takes what is left — not half each.
    expect(widths_of('25% 1fr')).to eq([250, 750])
    expect(widths_of('200px 1fr')).to eq([200, 800])
  end

  it 'reads minmax() as ONE track, not as its comma' do
    # The regression this file exists for: `17em minmax(0, 1fr)` at 16px/em is
    # 272 + 728 in a 1000px container (Chrome). Split on whitespace it was three
    # tracks of 333.
    expect(widths_of('17em minmax(0, 1fr)')).to eq([272, 728])
  end

  it 'weights fr shares and lets fr take the space a floor does not reserve' do
    # Chrome: 1fr/2fr split 333/667, and `minmax(300px, 1fr) 100px` gives the
    # flexible track 900 — its own floor is not subtracted from what it may take.
    expect(widths_of('1fr 2fr')).to eq([333, 667])
    expect(widths_of('minmax(300px, 1fr) 100px')).to eq([900, 100])
    # …but the floor holds when the free space is smaller than it.
    expect(widths_of('minmax(300px, 1fr) 800px')).to eq([300, 800])
  end

  it 'sizes a fixed-size minmax by its max and clamps it to its min' do
    expect(widths_of('minmax(100px, 200px) 1fr')).to eq([200, 800])
  end

  it 'expands repeat(), including auto-fill against a fixed track size' do
    # 4 x 200px + 3 x 20px gap = 860 fits 1000; a fifth would need 1080.
    expect(widths_of('repeat(auto-fill, 200px)', items: 4, style: 'gap:20px')).to eq([200, 200, 200, 200])
    expect(widths_of('repeat(2, 100px 1fr)', items: 4)).to eq([100, 400, 100, 400])
  end

  it 'counts an auto-fill repetition against the track MINIMUM, and collapses auto-fit' do
    # `repeat(auto-fill, minmax(200px, 1fr))` — the card-grid idiom — fits five 200px
    # tracks in 1000px, so four items sit in four of them (Chrome). `auto-fit` instead
    # collapses the tracks left empty: three items in a 250px-minimum grid become
    # three tracks of 1000/3, not four of 250.
    expect(widths_of('repeat(auto-fill, minmax(200px, 1fr))', items: 4)).to eq([200, 200, 200, 200])
    expect(widths_of('repeat(auto-fit, minmax(250px, 1fr))', items: 3)).to eq([333, 333, 333])
  end

  it 'resolves a var() track list and falls back to one column when a token is not a track' do
    # Forem's shell is `grid-template-columns: var(--layout)`.
    expect(widths_of('var(--layout)', style: '--layout:240px 1fr')).to eq([240, 760])
    # An unparseable token invalidates the whole declaration, which computes to
    # `none` — one implicit column the full width (Chrome). Sizing the unknown token
    # as a zero-width track instead collapsed every item in it out of the page.
    expect(widths_of('bogus-token 1fr')).to eq([1000, 1000])
  end

  it 'takes the gap out of the space the tracks divide' do
    # Chrome: (1000 - 2 * 10) / 3 = 326.67 each.
    expect(widths_of('repeat(3, 1fr)', items: 3, style: 'gap:10px')).to eq([327, 327, 327])
    expect(widths_of('50px 1fr 50px', items: 3, style: 'gap:5px')).to eq([50, 890, 50])
  end

  # The content-based keywords need the font, so these assert the RELATION Chrome
  # holds rather than its pixel figures: `min-content` is the widest word, and an
  # `auto` track that shares a row with another takes what its content asks for
  # rather than a fixed half.
  it 'sizes min-content from the content and gives the rest to fr' do
    body = <<~HTML
      <div id="g" style="display:grid;grid-template-columns:min-content 1fr;width:1000px">
        <div id="a">word wrapping here</div><div id="b">b</div>
      </div>
      <span id="probe" style="white-space:pre">wrapping</span>
    HTML
    boxes, = measure(body, ['#a', '#b', '#probe'], style: 'margin:0;font:16px Arial')
    a, b, probe = boxes
    expect(a[2].round).to eq(probe[2].round)          # the widest word
    expect((a[2] + b[2]).round).to eq(1000)           # …and `1fr` takes the rest
  end

  it 'holds an auto track to the container when its content wants more' do
    # Two auto tracks whose content is far wider than the container: Chrome does
    # NOT let them keep their max-content — they share the container. Before this
    # they kept it, and the second item landed outside the page entirely, which is
    # what put Discourse's post stream at x=1075 of a 1024px viewport.
    long = 'a fairly long run of words that will not fit ' * 3
    body = <<~HTML
      <div id="g" style="display:grid;grid-template-columns:auto auto;width:400px">
        <div id="a">#{long}</div><div id="b">#{long}</div>
      </div>
    HTML
    boxes, = measure(body, ['#g', '#a', '#b'], style: 'margin:0;font:16px Arial')
    g, a, b = boxes
    expect((a[2] + b[2]).round).to eq(400)
    expect(b[0].round).to eq((g[0] + a[2]).round)     # …and the second starts where the first ends
    expect(a[0] + a[2]).to be <= g[0] + g[2]          # both inside the container
  end
end
