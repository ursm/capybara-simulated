# frozen_string_literal: true

require 'capybara/simulated'
require 'vips'
require_relative 'support/session_teardown'

# `save_screenshot` rasters the laid-out page (js/src/paint.js) rather than serializing it. There
# is no second geometry: the painter reads the same boxes every geometry query reads, so these
# assert that what the driver BELIEVES about a box is what lands in the pixels.
RSpec.describe 'save_screenshot' do
  # A small viewport on purpose. Every assertion here is about a handful of pixels at known
  # coordinates, so the raster's SIZE proves nothing — but it costs: a typed array crosses to the
  # host as an ASCII-8BIT string under rusty_racer and as a Hash of index => byte under quickjs,
  # and at 1024x768 that Hash is 3.1M entries, which took this file from 0.6 s to 37 s there.
  #
  # A METHOD, not a constant: a constant assigned inside an `RSpec.describe` block lands at TOP
  # LEVEL, so `VIEWPORT` here collided with the one in scroll_into_view_spec.rb — and did it
  # invisibly, because the size assertion compares the raster against the same constant it was
  # rendered from. The suite failed only on the example that actually depends on the number.
  def viewport = [320, 240]

  def page_with(body, css: '')
    html = %(<!DOCTYPE html><html><head><style>body{margin:0;background:#fff;font:16px sans-serif}#{css}</style></head><body>#{body}</body></html>)
    Capybara.register_driver(:sim_shot) {|app| Capybara::Simulated::Driver.new(app, viewport: viewport) }
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }, mode: :sim_shot)
    s.visit '/'
    s
  end

  PNG_MAGIC = "\x89PNG\r\n\x1A\n".b

  def shot(session, **opts)
    path = File.join(Dir.tmpdir, "csim-shot-#{Process.pid}-#{rand(1 << 32)}.png")
    session.driver.save_screenshot(path, **opts)
    img = Vips::Image.new_from_file(path)
    # The whole raster once, then plain string indexing. `getpoint` is a full Vips operation per
    # call — fine for a handful, but the ink scan below asks thousands, which took this file past
    # its 60s budget on CI while passing locally.
    raw   = img.write_to_memory
    bands = img.bands
    px = lambda do |x, y|
      # Bounds-checked: the offset arithmetic would otherwise wrap an out-of-range x onto the NEXT
      # ROW and answer with a real pixel from the wrong place — which is exactly how a stale
      # coordinate passed here once, reading red where the assertion wanted white.
      raise ArgumentError, "(#{x}, #{y}) is outside the #{img.width}x#{img.height} raster" \
        unless x.between?(0, img.width - 1) && y.between?(0, img.height - 1)

      off = ((y * img.width) + x) * bands
      raw.byteslice(off, 3).bytes
    end
    yield img, px, path
  ensure
    File.delete(path) if path && File.exist?(path)
  end

  it 'writes a real PNG the size of the viewport' do
    s = page_with('<div></div>')
    shot(s) do |img, _px, path|
      expect(File.binread(path, 8)).to eq(PNG_MAGIC)
      expect([img.width, img.height]).to eq([320, 240])
    end
  end

  it 'paints a box where the layout puts it, with its background and border' do
    s = page_with('<div class="box"></div>',
                  css: '.box{width:200px;height:80px;background:rgb(255,0,0);border:4px solid rgb(0,0,255)}')
    shot(s) do |_img, px, _path|
      expect(px.call(2, 40)).to   eq([0, 0, 255])       # inside the 4px border
      expect(px.call(100, 40)).to eq([255, 0, 0])       # the background
      expect(px.call(250, 40)).to eq([255, 255, 255])   # past the box: the page
      expect(px.call(100, 150)).to eq([255, 255, 255])  # below it
    end
  end

  it 'paints text in its own colour, on the line the flow put it on' do
    # The run positions come from the flow itself (`recordingRuns`), so the ink has to land inside
    # the paragraph's own box — which is what a painter that re-derived line breaking would miss.
    s = page_with('<p>Hello painter</p>', css: 'p{color:rgb(0,128,0);margin:0;height:20px}')
    shot(s) do |_img, px, _path|
      inked = (0...320).select {|x| (0...20).any? {|y| c = px.call(x, y); c[1] > 90 && c[0] < 120 && c[2] < 120 } }
      expect(inked).not_to be_empty
      expect(inked.max).to be < 200                     # a 12-character run, not the whole width
      expect(px.call(300, 10)).to eq([255, 255, 255])   # nothing painted past the text
    end
  end

  # …and an ANONYMOUS box has to take a shift like any other, which only a painter can say. CSS Grid §4 wraps
  # a grid's contiguous run of bare text in an anonymous block container item; it is in nobody's child list,
  # so the `shiftSubtree` walk reaches the TEXT NODES inside it and never the box that holds their runs.
  # Measured, with the arm removed: the ink lands at rows 2..13 while the item's box sits at 60 — the same
  # failure `shiftSubtree`'s table arm records for `anonTableCell` ("painted its text at the unshifted
  # origin"), one spec over. Geometry cannot see it: `getBoundingClientRect` on the grid answers 60 either way,
  # and the anonymous item has no element to ask.
  it 'shifts an anonymous grid item\'s runs with the box that moved' do
    s = page_with('<div class="rel"><div class="g">XXXXXX</div></div>',
                  css: '.rel{position:relative;top:60px;width:300px}.g{display:grid;color:rgb(0,0,0)}')
    shot(s) do |_img, px, _path|
      inked = (0...120).select {|y| (0...200).any? {|x| px.call(x, y).sum < 600 } }
      expect(inked).not_to be_empty
      expect(inked.min).to be >= 55, "the run painted at row #{inked.min}, above the shifted box"
      expect(inked.max).to be < 90
    end
  end

  it 'paints the whole document with full: true' do
    s = page_with('<div class="tall"></div>', css: '.tall{height:2000px;background:rgb(0,0,255)}')
    shot(s) {|img, _px, _path| expect(img.height).to eq(240) }
    shot(s, full: true) do |img, px, _path|
      expect(img.height).to be >= 2000
      expect(px.call(10, 1900)).to eq([0, 0, 255])      # past the viewport, still painted
    end
  end

  it 'follows a scroll offset' do
    s = page_with('<div class="a"></div><div class="b"></div>',
                  css: '.a{height:300px;background:rgb(255,0,0)}.b{height:300px;background:rgb(0,0,255)}')
    s.execute_script('window.scrollTo(0, 300)')
    shot(s) {|_img, px, _path| expect(px.call(10, 10)).to eq([0, 0, 255]) }
  end

  it 'draws a replaced element into its content box' do
    # A 40x40 magenta PNG, inline so the fetch is synchronous.
    png = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAALElEQVR4nO3NMQkAAAwDsPo33Zko7AnkT5q+iFgsFo" \
          "vFYrFYLBaLxWKxWLxzzs50NT7y1u0AAAAASUVORK5CYII="
    s = page_with(%(<img src="data:image/png;base64,#{png}" style="width:100px;height:60px;border:5px solid rgb(0,0,0)">))
    shot(s) do |_img, px, _path|
      expect(px.call(2, 30)).to  eq([0, 0, 0])          # the border
      expect(px.call(50, 30)).to eq([255, 0, 255])      # the bitmap, inside it
      expect(px.call(200, 30)).to eq([255, 255, 255])   # past the element
    end
  end

  it 'clips a box to its scroll container' do
    s = page_with('<div class="sc"><div class="in"></div></div>',
                  css: '.sc{width:100px;height:100px;overflow:hidden}.in{width:400px;height:40px;background:rgb(0,200,0)}')
    shot(s) do |_img, px, _path|
      expect(px.call(50, 20)).to  eq([0, 200, 0])       # inside the scroller
      expect(px.call(200, 20)).to eq([255, 255, 255])   # the 400px child, clipped away
    end
  end

  it 'follows an inner scroller offset' do
    s = page_with('<div class="sc" id="sc"><div class="a"></div><div class="b"></div></div>',
                  css: '.sc{width:100px;height:100px;overflow:auto}' \
                       '.a{height:100px;background:rgb(255,0,0)}.b{height:100px;background:rgb(0,0,255)}')
    s.execute_script("document.getElementById('sc').scrollTop = 100")
    shot(s) {|_img, px, _path| expect(px.call(50, 20)).to eq([0, 0, 255]) }
  end

  it 'paints positioned content above in-flow content, by z-index' do
    # `.over` comes FIRST in the DOM, so tree order alone would bury it.
    s = page_with('<div class="over"></div><div class="under"></div><div class="flow"></div>',
                  css: '.over,.under{position:absolute;left:0;top:0;width:100px;height:100px}' \
                       '.over{background:rgb(0,0,255);z-index:2}.under{background:rgb(255,0,0);z-index:1}' \
                       '.flow{width:100px;height:100px;background:rgb(0,200,0)}')
    shot(s) {|_img, px, _path| expect(px.call(50, 50)).to eq([0, 0, 255]) }
  end

  it 'gives each run the advance the flow reserved, so words keep their gaps' do
    # The rasteriser measures a run differently from the flow — for a system font it reports the
    # rounded ink width, where layout sums the face's own `hmtx` advances. Drawing at the
    # rasteriser's width made words overrun the space after them; the painter condenses to the
    # flow's figure instead. What this pins is that the figure travels with the run at all.
    s = page_with('<p id="p">The painter reads the same boxes</p>', css: 'p{margin:0;font:14px sans-serif}')
    runs = s.evaluate_script('globalThis.__csimPaintRuns()')
    words = runs.map {|r| r['text'] }
    expect(words).to eq(%w[The painter reads the same boxes])
    expect(runs.map {|r| r['width'] }).to all(be > 0)
    # …and each run starts past the end of the one before it: a gap, never an overlap.
    runs.each_cons(2) do |a, b|
      expect(b['x']).to be >= (a['x'] + a['width'])
    end
  end

  # A float whose height is AUTO is laid out TWICE — once to learn the height its band search needs, then
  # again where that search puts it — and only the second placement is real. The first left its text runs
  # behind at the position the float was about to leave: a wrapped row of `float: left` columns painted every
  # label on the row above, piled at the right edge, with the boxes in the right places all along. Geometry
  # cannot see this; only the painter can.
  it 'paints an auto-height float where its second placement put it' do
    s = page_with('<div style="width:200px">' + (1..6).map {|i| %(<div style="float:left;width:60px">c#{i}</div>) }.join + '</div>')
    recorded = s.evaluate_script('globalThis.__csimPaintRuns()').map {|r| [r['text'], [r['x'].round, r['y'].round]] }
    runs = recorded.to_h
    boxes = s.evaluate_script(<<~JS).to_h {|t, x, y| [t, [x.round, y.round]] }
      [...document.querySelectorAll('div div')].map(e => {
        const r = e.getBoundingClientRect(); return [e.textContent, r.x, r.y];
      })
    JS
    expect(recorded.map(&:first).sort).to eq(%w[c1 c2 c3 c4 c5 c6])   # each recorded ONCE — the probe's
                                                                      # placement must leave no ghost behind
    expect(runs).to eq(boxes)                             # …and where its own box is
    expect(boxes['c4'][1]).to be > boxes['c1'][1]         # …with the row that wrapped genuinely below
  end

  # ONE INVARIANT, everywhere a box moves after it is laid out: its recorded GLYPHS move with it. A flex item
  # is placed on the main axis first and aligned on the cross axis only once its line's size is known; an
  # out-of-flow box is placed against a height nobody knows until its own flow has run; an atomic drops to its
  # line's baseline; a cell takes `vertical-align`; a relative inline carries its content. Each of those left
  # the glyphs behind — `align-items: center` painted its label at the top of the row, a `bottom`-anchored
  # tooltip painted its text below itself, a `left: 30px` span left its word — and GEOMETRY SAW NOTHING WRONG,
  # because every box was right. A box laid out TWICE has the mirror problem: the first layout's runs are a
  # second copy of every glyph, and dropping them by index moved every other box's.
  #
  # So a run belongs to the box that laid it out, `shiftSubtree` carries each box's own runs as it walks (which
  # is what keeps a `fixed` descendant's glyphs still, since the walk deliberately does not move its box), and
  # a box laid out again marks what it recorded before as dead.
  it 'paints every box that moves after layout where it ended up' do
    {
      'align-items:center'    => '<div style="display:flex;align-items:center;height:60px;width:200px"><div>hi</div></div>',
      'align-items:flex-end'  => '<div style="display:flex;align-items:flex-end;height:60px;width:200px"><div>hi</div></div>',
      'flex-wrap second line' => '<div style="display:flex;flex-wrap:wrap;width:100px"><div style="width:60px">a</div><div style="width:60px">b</div></div>',
      'stretch that grows'    => '<div style="display:flex;align-items:stretch;height:60px;width:200px"><div>hi</div></div>',
      'two stretch items'     => '<div style="display:flex;height:60px;width:200px"><div>aa</div><div>bb</div></div>',
      'stretch + self:center' => '<div style="display:flex;height:60px;width:200px"><div>aa</div><div style="align-self:center">bb</div></div>',
      'plain column'          => '<div style="display:flex;flex-direction:column;width:200px"><div>aa</div><div>bb</div></div>',
      'column flex:1'         => '<div style="display:flex;flex-direction:column;height:60px;width:200px"><div style="flex:1">a</div><div style="flex:1">b</div></div>',
      'column flex:1 + auto'  => '<div style="display:flex;flex-direction:column;height:100px;width:200px"><div style="flex:1">aa</div><div>bb</div></div>',
      'bottom-anchored'       => '<div style="position:relative;height:100px;width:200px"><div style="position:absolute;bottom:10px">tip</div></div>',
      'flex-aligned abspos'   => '<div style="display:flex;align-items:center;height:100px;width:200px;position:relative"><div style="position:absolute">dd</div></div>',
      'fixed in centred item' => '<div style="display:flex;align-items:center;height:60px;width:200px"><div><span style="position:fixed;top:5px;left:100px">fx</span></div></div>',
      'relative inline'       => '<div style="width:200px"><span style="position:relative;left:30px;top:10px">aa</span></div>',
      # …the two shifts this model replaced an index range for, both A/B-proven: an ATOMIC inline drops to its
      # line's baseline after it is laid out (without the per-box shift its glyphs stay at the line's top, 0
      # where the box is at 2), and an out-of-flow box takes its static position from a line `text-align`
      # then moves (run at 14 where the box is at 107). The second needs its containing block already SIZED —
      # with `position: relative` on the line's own block the box is held back instead, and the alignment
      # nudges a static position rather than anything recorded.
      'atomic on a baseline'  => '<div style="width:200px;font-size:24px;line-height:40px">' \
                                 '<span style="display:inline-block;font-size:10px;vertical-align:middle">at</span></div>',
      'static on a centred line' => '<div style="width:200px;text-align:center">' \
                                    '<b>hi</b><span style="position:absolute">st</span></div>',
      # …and a TABLE inside a subtree that moves. Its anonymous cell holds the runs and is in nobody's child
      # list — `anonTableCell` wraps the table's own DOM children, so a walk over the child list reaches
      # those children and never the cell around them, and the cell's own box and runs stayed behind. That
      # hole was FIVE movers wide (measured: each of the shapes below painted its text at the origin while
      # its box sat where the mover put it); the `position: relative` one is the odd case that worked, since
      # a relative block used to be laid out already-shifted. These are the only instrument that can see it —
      # every one of them declines natively, so the parity harness is blind to all of them.
      'table in a relative block' => '<div style="width:200px"><div style="position:relative;left:30px;top:10px">' \
                                     '<div style="display:table">tt</div></div></div>',
      'table under a relative grandparent' => '<div style="width:200px"><div style="position:relative;top:12px">' \
                                              '<div><div style="display:table">gg</div></div></div></div>',
      'table in an auto-height float' => '<div style="width:200px;overflow:hidden">' \
                                         '<div style="float:left"><div style="display:table">ff</div></div></div>',
      'table in a centred flex item' => '<div style="display:flex;align-items:center;height:60px;width:200px">' \
                                        '<div><div style="display:table">hh</div></div></div>',
      'table on a flex-wrap second line' => '<div style="display:flex;flex-wrap:wrap;width:100px">' \
                                            '<div style="width:60px">a</div><div style="width:60px">' \
                                            '<div style="display:table">bb</div></div></div>',
      'table in a bottom-anchored abspos' => '<div style="position:relative;height:100px;width:200px">' \
                                             '<div style="position:absolute;bottom:10px">' \
                                             '<div style="display:table">cc</div></div></div>',
      'table in an atomic on a baseline' => '<div style="width:200px;font-size:24px;line-height:40px">' \
                                            '<span style="display:inline-block;font-size:10px;vertical-align:middle">' \
                                            '<div style="display:table">dd</div></span></div>',
      # …(the box query below is `div div`, so the table under test is wrapped in a plain div here)
      'table in a middle-aligned cell' => '<table style="border-spacing:0"><tr style="height:60px">' \
                                          '<td style="vertical-align:middle;padding:0"><div>' \
                                          '<div style="display:table">jj</div></div></td></tr></table>'
    }.each do |label, body|
      s = page_with(body)
      runs = s.evaluate_script('globalThis.__csimPaintRuns()').map {|r| [r['text'], r['x'].round, r['y'].round] }
      boxes = s.evaluate_script(<<~JS).map {|t, x, y| [t, x.round, y.round] }
        [...document.querySelectorAll('div div, span, b')].filter(e => !e.children.length)
          .map(e => { const r = e.getBoundingClientRect(); return [e.textContent, r.x, r.y]; })
      JS
      # Sorted, because the painter's order is PAINT order and the query's is DOM order — a wrapped or
      # aligned line puts them in different sequences. What is asserted is that each glyph run exists exactly
      # ONCE and sits on its own box: a doubled run or one piled on a neighbour fails either way. (Every
      # shape uses DISTINCT labels, which is what the sort rests on — two runs reading the same text could
      # swap boxes and still sort equal. And these pages neither scroll nor transform, so the painter's
      # DOCUMENT coordinates and `getBoundingClientRect`'s viewport ones are the same numbers.)
      expect([label, runs.sort]).to eq([label, boxes.sort])
    end
  end

  # …and the runs a relative inline carries are bucketed onto it as they are RECORDED, by walking from the
  # run's owner up the FLAT tree — the chain of boxes that actually laid it out. Walking `_parent` climbs out
  # of a shadow tree instead: a relative inline in the shadow, wrapping a `<slot>`, never matched the
  # light-DOM run's ancestors, so the box moved and the word stayed.
  it "moves a relative inline's slotted text with it" do
    s = page_with('<div id="h"><b>bb</b></div>')
    s.evaluate_script(<<~JS)
      document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML =
        '<div style="width:200px"><span style="position:relative;left:40px;top:12px"><slot></slot></span></div>'
    JS
    s.evaluate_script('document.body.offsetHeight')
    runs = s.evaluate_script('globalThis.__csimPaintRuns()').map {|r| [r['text'], r['x'].round, r['y'].round] }
    box  = s.evaluate_script("(r => [r.x, r.y])(document.querySelector('b').getBoundingClientRect())").map(&:round)
    expect(box).to eq([40, 12])          # …the shadow's relative inline moved the slotted box
    expect(runs).to eq([['bb', 40, 12]]) # …and its glyphs went with it
  end

  # A cell's bare TEXT is vertically aligned in the paint like its block children (§17.5.3) — the UA default is
  # middle. Cell text carries no DOM geometry in this driver (getBoundingClientRect / Range see nothing), so the
  # alignment is observable ONLY through the painter's recorded runs.
  def cell_text_y(va)
    s = page_with(%(<table id="t"><tr><td style="padding:0"><div style="width:20px;height:80px"></div></td>) +
                  %(<td style="padding:0;vertical-align:#{va}">Hi</td></tr></table>), css: 'table{border-spacing:0}')
    runs = s.evaluate_script('globalThis.__csimPaintRuns()')
    top  = s.evaluate_script("document.getElementById('t').getBoundingClientRect().y")
    hi   = runs.find {|r| r['text'].to_s.include?('Hi') }
    (hi['y'] - top).round(2)
  end
  it 'vertically aligns a cell bare text in the paint (middle default / top / bottom)' do
    top, mid, bot = cell_text_y('top'), cell_text_y('middle'), cell_text_y('bottom')
    expect(top).to eq(0)                                        # top: at the cell content top
    expect(bot - top).to be > 30                                # bottom: pushed to the bottom of the 80px row
    expect(mid - top).to be_within(0.5).of((bot - top) / 2.0)   # middle: exactly halfway (the UA default)
  end

  # A cell's text follows the cell to its final row in the paint: a declared table height makes the rows taller
  # than their content and shifts them down, and the text (recorded runs) moves with the row, not left behind up
  # in the first row.
  it 'paints a cell text on the row the flow placed it (declared-height table)' do
    s = page_with('<table id="t" style="height:200px"><tr><td style="padding:0">R1</td></tr><tr><td style="padding:0">R2</td></tr></table>', css: 'table{border-spacing:0}')
    runs = s.evaluate_script('globalThis.__csimPaintRuns()')
    top  = s.evaluate_script("document.getElementById('t').getBoundingClientRect().y")
    y = ->(t) { r = runs.find {|x| x['text'].to_s.include?(t) }; (r['y'] - top).round(2) }
    expect(y.('R2')).to be > 90                 # the second row sits in the lower half of the 200px table
    expect(y.('R2') - y.('R1')).to be > 90      # a full row below the first, not stacked at the top
  end

  # ── Transforms ────────────────────────────────────────────────────────────────────────────
  # The painter hands the canvas the matrix and draws in the coordinates layout gave it, so the
  # box, its borders, its bitmap and its text runs all move together. What these pin is that the
  # picture agrees with what `getBoundingClientRect` reports — there is one geometry.

  it 'moves a box and the text inside it together' do
    s = page_with('<div class="t">Hi</div>',
                  css: '.t{width:60px;height:20px;background:rgb(255,0,0);color:rgb(0,0,255);' \
                       'margin:0;transform:translateX(100px)}')
    shot(s) do |_img, px, _path|
      expect(px.call(10, 10)).to  eq([255, 255, 255])   # where the box was laid out
      expect(px.call(130, 10)).to eq([255, 0, 0])       # where the transform puts it
      inked = (0...320).select {|x| (0...20).any? {|y| px.call(x, y)[2] > 150 && px.call(x, y)[0] < 120 } }
      expect(inked).not_to be_empty
      expect(inked.min).to be >= 100                    # the ink travelled with its box
    end
  end

  it 'scales about the transform-origin' do
    # `transform-origin: 0 0` keeps the top-left corner still, so a 2x box covers twice the extent.
    s = page_with('<div class="t"></div>',
                  css: '.t{width:50px;height:50px;background:rgb(0,200,0);' \
                       'transform:scale(2);transform-origin:0 0}')
    shot(s) do |_img, px, _path|
      expect(px.call(2, 2)).to    eq([0, 200, 0])
      expect(px.call(95, 95)).to  eq([0, 200, 0])       # inside the scaled box
      expect(px.call(105, 105)).to eq([255, 255, 255])  # past it
    end
  end

  it 'rotates a box into the quad it is, not into its bounding rectangle' do
    # 90deg about the centre turns a 100x20 bar into a 20x100 one. A painter that drew the
    # bounding rect would fill the whole 100x100 square instead.
    s = page_with('<div class="t"></div>',
                  css: '.t{width:100px;height:20px;background:rgb(255,0,0);transform:rotate(90deg)}')
    shot(s) do |_img, px, _path|
      expect(px.call(50, 50)).to eq([255, 0, 0])        # the bar, stood up
      expect(px.call(10, 10)).to eq([255, 255, 255])    # a corner of the bounding square
      expect(px.call(90, 90)).to eq([255, 255, 255])
    end
  end

  it 'composes a nested transform exactly once' do
    s = page_with('<div class="o"><div class="i"></div></div>',
                  css: '.o{transform:translateX(100px)}' \
                       '.i{width:20px;height:20px;background:rgb(0,0,255);transform:translateX(20px)}')
    shot(s) do |_img, px, _path|
      expect(px.call(130, 10)).to eq([0, 0, 255])       # 100 + 20, applied once
      expect(px.call(110, 10)).to eq([255, 255, 255])   # not the parent's shift alone
      expect(px.call(150, 10)).to eq([255, 255, 255])   # and not applied twice
    end
  end

  # The clip belongs to the CLIPPER, not to what it clips. Drawn under the clipped element's own
  # matrix the scrollport travelled with its child, and ink appeared where a browser paints none.
  it 'holds an overflow clip still while its child transforms out of it' do
    s = page_with('<div class="sc"><div class="in"></div></div>',
                  css: '.sc{width:100px;height:100px;overflow:hidden}' \
                       '.in{width:50px;height:50px;background:rgb(255,0,0);transform:translateX(150px)}')
    shot(s) do |_img, px, _path|
      expect(px.call(170, 25)).to eq([255, 255, 255])   # where the transform sends it: clipped away
      expect(px.call(25, 25)).to  eq([255, 255, 255])   # and it did not stay behind either
    end
  end

  it 'clips in the clipper own space when the clipper is the transformed one' do
    s = page_with('<div class="sc"><div class="in"></div></div>',
                  css: '.sc{width:100px;height:100px;overflow:hidden;transform:translateX(100px)}' \
                       '.in{width:400px;height:40px;background:rgb(0,200,0)}')
    shot(s) do |_img, px, _path|
      expect(px.call(150, 20)).to eq([0, 200, 0])       # inside the moved scrollport
      expect(px.call(50, 20)).to  eq([255, 255, 255])   # the scrollport is not where it was laid out
      expect(px.call(250, 20)).to eq([255, 255, 255])   # the 400px child, still clipped
    end
  end

  # Reading a transform reaches `documentBoxOf`, and a style read can move the keys `ensureLayout`
  # gates on — so the paint laid the page out a second time. With the run recorder still armed that
  # pass re-offered every run and the painter drew each of them twice, compositing the text darker.
  # The ink SUM, not the darkest pixel: a run's core is already saturated at its own colour, so a
  # second pass over it changes nothing there. The doubling shows up in the antialiased edges.
  it 'paints each text run once even when the page has a transform on it' do
    css = 'div{margin:0;color:rgb(80,80,80)}' \
          '.t{position:absolute;left:250px;top:0;width:10px;height:10px;transform:scale(3)}'
    plain  = page_with('<div>Test Text</div>', css: css)
    withtf = page_with('<div>Test Text<span class="t"></span></div>', css: css)
    ink = lambda do |session|
      shot(session) do |_img, px, _path|
        (0...200).sum {|x| (0...30).sum {|y| 255 - px.call(x, y)[0] } }
      end
    end
    expect(ink.call(plain)).to be > 0
    expect(ink.call(withtf)).to eq(ink.call(plain))
  end

  # The matrix is in viewport coordinates; a full-page shot moves the whole picture by the root
  # scroll. Testing the cull in the wrong one of those two spaces is off by `(A - I)` times the
  # scroll — zero for a translate, and enough to cull a scaled box unpainted for anything else.
  it 'paints a scaled box on a full-page shot of a scrolled page' do
    s = page_with('<div class="sp"></div><div class="t"></div>',
                  css: '.sp{height:1500px}' \
                       '.t{width:50px;height:50px;background:rgb(255,0,0);transform:scale(2)}')
    s.execute_script('window.scrollTo(0, 1000)')
    shot(s, full: true) {|_img, px, _path| expect(px.call(25, 1525)).to eq([255, 0, 0]) }
  end

  # `documentElement.remove()` is legal, and a browser answers it with a blank page rather than
  # with nothing at all. The painter used to bail on a rootless document and return no image, so
  # `save_screenshot` produced no file — and a WPT reftest that removes the root took the whole
  # file down as a harness error. The one thing to pin is that a raster still comes back.
  it 'paints a blank page for a document with no root element' do
    s = page_with('<p>gone in a moment</p>')
    s.execute_script('document.documentElement.remove()')
    shot(s) do |img, px, path|
      expect(File.binread(path, 8)).to eq(PNG_MAGIC)
      expect([img.width, img.height]).to eq(viewport)
      expect(px.call(10, 10)).to eq([255, 255, 255])
      expect(px.call(160, 120)).to eq([255, 255, 255])
    end
  end
end
