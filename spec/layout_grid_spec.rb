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

  # An auto repeat makes the template an `<auto-track-list>` (§7.2.3), every track of which is a FIXED size: a
  # `fit-content()` beside one invalidates the whole declaration, which is then `none` — one column the full width.
  it 'takes a template whose auto repeat sits beside an intrinsic track as none' do
    expect(widths_of('repeat(auto-fill, 100px) fit-content(50px)')).to eq([1000, 1000])
    expect(widths_of('repeat(auto-fill, 100px) 50px', items: 1)).to eq([100])
  end

  # A `grid-auto-rows` that is not one length — `minmax(1em, auto)` — is a content row: its literal is only a floor,
  # and advancing by it clipped a taller item (Chrome: a two-line item is 40 tall at 20px lines, not 16).
  it 'sizes a minmax() auto row by its content' do
    boxes, = measure('<div id="g" style="display:grid;grid-auto-rows:minmax(1em,auto);font:16px/20px monospace"><div>c<br>c2</div></div>', ['#g'], style: 'margin:0')
    expect(boxes[0][3]).to eq(40)
  end

  # …but `minmax(<length>, auto)` keeps its length as a FLOOR: rows at least that tall, a one-line item stretched to it,
  # a taller item growing its row (Chrome: 100 around one line, 120 around six 20px lines, and 220 for the grid).
  it 'keeps a minmax() row floor and grows past it' do
    body = '<div id="g" style="display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:minmax(100px,auto);font:16px/20px monospace">' \
           '<div id="a">a</div><div>b</div><div>c<br>c<br>c<br>c<br>c<br>c</div><div>d</div></div>'
    boxes, = measure(body, ['#g', '#a'], style: 'margin:0')
    expect(boxes.map {|b| b[3] }).to eq([220, 100])
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
    # `none` — one implicit column the full width (Chrome). The 200px track in the
    # middle is what makes this discriminate: merely SKIPPING the bad token would
    # leave `200px 1fr` and answer 200/800.
    expect(widths_of('bogus-token 200px 1fr', items: 3)).to eq([1000, 1000, 1000])
    # …but a LINE NAME is part of a valid track list and names no track of its own.
    expect(widths_of('[a] 200px [b] 1fr [c]')).to eq([200, 800])
    expect(widths_of('repeat(2, [c] 1fr)')).to eq([500, 500])
  end

  it 'refreezes an fr track whose floor beats its share' do
    # §12.7.1. Chrome, 800px: `minmax(600px, 1fr) 1fr` is 600 + 200 — the frozen
    # track leaves only 200 for the other, so distributing the ORIGINAL free space
    # (600 + 400) put the second item 200px outside the container.
    expect(widths_of('minmax(600px, 1fr) 1fr', width: 800)).to eq([600, 200])
    expect(widths_of('minmax(800px, 1fr) 1fr 1fr', items: 3)).to eq([800, 100, 100])
  end

  it 'leaves the free space alone when the fr weights sum to less than 1' do
    # Chrome: 500 / 250, not 667 / 333 — a sum below 1 is a FRACTION of the free
    # space, not a ratio to normalise.
    expect(widths_of('0.5fr 0.25fr')).to eq([500, 250])
  end

  it 'takes the COLUMN gap from the second half of a two-value gap' do
    # `gap: <row> <column>`. Reading the first token took the row gap — which fed
    # the track widths, the item offsets and the auto-fill count alike.
    expect(widths_of('1fr 1fr', style: 'gap:10px 40px')).to eq([480, 480])
    expect(widths_of('1fr 1fr', style: 'column-gap:40px;row-gap:10px')).to eq([480, 480])
  end

  it 'treats repeat(0, …) and a negative track size as invalid' do
    # Chrome computes all three to `none`: one full-width column.
    expect(widths_of('repeat(0, 100px) 1fr')).to eq([1000, 1000])
    expect(widths_of('-100px 1fr')).to eq([1000, 1000])
    expect(widths_of('-1fr 1fr')).to eq([1000, 1000])
  end

  it 'takes the gap out of the space the tracks divide' do
    # Chrome: (1000 - 2 * 10) / 3 = 326.67 each.
    expect(widths_of('repeat(3, 1fr)', items: 3, style: 'gap:10px')).to eq([327, 327, 327])
    expect(widths_of('50px 1fr 50px', items: 3, style: 'gap:5px')).to eq([50, 890, 50])
  end

  it 'spans an item to the end line and starts it where it asks' do
    def spanning(item_style, template: 'repeat(4, 1fr)')
      body = <<~HTML
        <div id="g" style="display:grid;grid-template-columns:#{template};width:1000px">
          <div id="i" style="#{item_style}">wide</div>
        </div>
      HTML
      boxes, = measure(body, ['#i'], style: 'margin:0;font:16px Arial')
      boxes.first.values_at(0, 2).map(&:round)
    end

    # `1 / -1` — the full-bleed idiom — is every column there is; `-1` counts back
    # from the end, which the span regex used to read as the line number 1.
    expect(spanning('grid-column: 1 / -1', template: 'repeat(3, 1fr)')).to eq([0, 1000])
    # …and an explicit START line places the item there rather than at the next
    # free column: Chrome puts `2 / -1` at x=250 of a four-column grid.
    expect(spanning('grid-column: 2 / -1')).to eq([250, 750])
    # The longhands say the same thing as the shorthand.
    expect(spanning('grid-column-start: 1; grid-column-end: -1', template: 'repeat(3, 1fr)')).to eq([0, 1000])
  end

  it 'lets a grid item size itself inside the track it was given' do
    body = <<~HTML
      <div id="g" style="display:grid;grid-template-columns:1fr 1fr;width:1000px">
        <div id="a" style="width:300px">a</div><div id="b" style="margin:0 20px">b</div>
      </div>
    HTML
    boxes, = measure(body, ['#a', '#b'], style: 'margin:0;font:16px Arial')
    a, b = boxes
    # Chrome: the declared width wins over the track's 500…
    expect(a[2].round).to eq(300)
    # …and margins come out of the track before an auto width fills what is left.
    expect([b[0].round, b[2].round]).to eq([520, 460])
  end

  it 'sizes a fit-content track by its content, capped' do
    # `fit-content(10em)` = min(160px, max-content). The text is far wider than the
    # cap, so the cap binds and the figure is font-independent (Chrome: 160/840).
    body = <<~HTML
      <div id="g" style="display:grid;grid-template-columns:fit-content(10em) 1fr;width:1000px">
        <div id="a">#{'a fairly long run of words ' * 4}</div><div id="b">b</div>
      </div>
    HTML
    boxes, = measure(body, ['#a', '#b'], style: 'margin:0;font:16px Arial')
    expect(boxes.map {|x| x[2].round }).to eq([160, 840])
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
    HTML
    boxes, text = measure(body, ['#a', '#b'], probes: %w[word wrapping here], style: 'margin:0;font:16px Arial')
    a, b = boxes
    expect(a[2].round).to eq(text.word('word wrapping here').round)   # the widest word
    expect((a[2] + b[2]).round).to eq(1000)                           # …and `1fr` takes the rest
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

  # A `position: relative` grid item is shifted by its insets at paint time (Chrome moves it; the row and the
  # track it sits in are computed from the unshifted place), as every other flow's relative box is.
  it 'shifts a relative grid item by its insets without moving its neighbours' do
    body = <<~HTML
      <div id="g" style="display:grid;grid-template-columns:100px 100px;width:400px">
        <div id="a" style="position:relative;top:10px;left:5px;height:20px">a</div><div id="b" style="height:20px">b</div>
      </div>
    HTML
    boxes, = measure(body, ['#g', '#a', '#b'], style: 'margin:0;font:16px Arial')
    g, a, b = boxes
    expect([a[0] - g[0], a[1] - g[1]]).to eq([5, 10])
    expect([b[0] - g[0], b[1] - g[1]]).to eq([100, 0])
    expect(g[3]).to eq(20)                            # the row is as tall as the unshifted item
  end

  # A `subgrid` column template takes the tracks its item spans in the parent grid, and the parent's gap where its own
  # is `normal` (CSS Grid 2 §9) — not its fallback `1fr 1fr`, nor one implicit column. A gap of its own moves the lines
  # between its tracks by half the difference each way. Chrome and Firefox lay out every box below alike:
  # (0, 100) (110, 200) · (110, 203) (317, 53) · (0, 100) (100, 300), as (left, width) from the body.
  it 'lays a subgrid out on the tracks it spans in its parent' do
    body = <<~HTML
      <style>
        #p { display: grid; grid-template-columns: 100px 200px 50px; width: 400px; column-gap: 10px }
        #c { grid-column: 1 / 3; display: grid; grid-template-columns: 1fr 1fr; grid-template-columns: subgrid }
        #d { grid-column: 2 / span 2; display: grid; grid-template-columns: subgrid; column-gap: 4px }
        #q { display: grid; grid-template-columns: 1fr 3fr; width: 400px }
        #r { grid-column: span 2; display: grid; grid-template-columns: subgrid }
        #c > div, #d > div, #r > div { height: 10px }
      </style>
      <div id="p"><div id="c"><div id="c1"></div><div id="c2"></div></div><div id="d"><div id="d1"></div><div id="d2"></div></div></div>
      <div id="q"><div id="r"><div id="r1"></div><div id="r2"></div></div></div>
    HTML
    boxes, = measure(body, %w[#c1 #c2 #d1 #d2 #r1 #r2], style: 'margin:0;font:16px Arial')
    expect(boxes.map {|b| [b[0], b[2]] }).to eq([[0, 100], [110, 200], [110, 203], [317, 53], [0, 100], [100, 300]])
  end

  # An auto-placed subgrid takes the tracks where the grid places it — here the second (Chrome: 50px from the left,
  # 100px wide, both children stacked in that one column).
  it 'lays an auto-placed subgrid out on the track it is placed in' do
    body = <<~HTML
      <style>
        #g { display: grid; grid-template-columns: 50px 100px 150px; width: 300px }
        #s { display: grid; grid-template-columns: subgrid }
        #s > div { height: 10px }
      </style>
      <div id="g"><div></div><div id="s"><div id="s1"></div><div id="s2"></div></div></div>
    HTML
    boxes, = measure(body, %w[#s1 #s2], style: 'margin:0;font:16px Arial')
    expect(boxes.map {|b| [b[0], b[1], b[2]] }).to eq([[50, 0, 100], [50, 10, 100]])
  end
end
