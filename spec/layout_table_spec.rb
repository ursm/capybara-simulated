# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Table layout. A table's geometry falls out of no other formatting context — a
# column is as wide as the widest cell in that column across EVERY row, and the
# table itself is shrink-to-fit — so before this it was approximated by laying each
# row out as an equal-share flex row, which got both wrong: every column the same
# width whatever it held, and the table always as wide as the page.
#
# The algorithm is CSS Tables 3 §"Distributing width to columns", the one Chrome
# implements, and every expectation below was derived from a Chrome 137 measurement
# of the same markup (headless, 1024x768). They are written as FORMULAS over widths
# measured in the page itself rather than as the pixel figures Chrome printed: the
# figures depend on which face fontconfig serves for Arial, the formulas don't, and
# it is the formula that this file exists to pin. (The pixel figures are in the
# comments, from Liberation Sans — what both Chrome and we get on Linux.)
RSpec.describe 'table layout' do
  include LayoutMeasure

  # The UA stylesheet's cell padding and table border-spacing, which are in every
  # figure a browser reports for a table.
  PAD     = 2   # 1px on each side of a cell
  SPACING = 2

  it 'sizes a column from the widest cell in it and shrinks the table to fit' do
    body = <<~HTML
      <table id="t"><tr id="r1"><td id="a">A</td><td id="b">Wider cell</td></tr>
      <tr id="r2"><td id="c">Another one</td><td id="d">B</td></tr></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#r1', '#a', '#b', '#r2', '#c'],
                                probes: ['A', 'Wider cell', 'Another one', 'B'])
    t, r1, a, b, r2, c = boxes
    # Column 1 comes from "Another one" in the SECOND row, not from the "A" above it.
    col1 = text['Another one'] + PAD          # Chrome: 89.19
    col2 = text['Wider cell']  + PAD          # Chrome: 72.23
    expect([a[2], c[2]]).to all(be_within(0.01).of(col1))
    expect(b[2]).to be_within(0.01).of(col2)
    # Shrink-to-fit: the table is its columns plus the spacing around and between
    # them — 167 wide, not the 1024 a block would have taken.
    expect(t[2]).to be_within(0.01).of(col1 + col2 + SPACING * 3)
    expect(t[3]).to eq(SPACING * 3 + (line + PAD) * 2)     # Chrome: 46
    expect([t[0], r1[0], r1[1], a[0]]).to eq([0, SPACING, SPACING, SPACING])
    expect(b[0]).to be_within(0.01).of(SPACING + col1 + SPACING)
    expect(r2[1]).to eq(SPACING + (line + PAD) + SPACING)
  end

  # Chrome measured: a 400px table whose two columns want 12.67 and 108.7 gives them
  # 41.13 and 352.88 — the surplus in proportion to what each column WANTS, neither
  # equally nor in proportion to what is left over.
  it 'shares a surplus over the columns in proportion to their max-content' do
    body = '<table id="t" style="width:400px"><tr><td id="a">A</td><td id="b">Wider cell here</td></tr></table>'
    boxes, text = measure(body, ['#t', '#a', '#b'], probes: ['A', 'Wider cell here'])
    t, a, b = boxes
    assignable = 400 - SPACING * 3
    max_a = text['A'] + PAD
    max_b = text['Wider cell here'] + PAD
    expect(t[2]).to eq(400)
    expect(a[2]).to be_within(0.01).of(assignable * max_a / (max_a + max_b))
    expect(b[2]).to be_within(0.01).of(assignable * max_b / (max_a + max_b))
  end

  # The middle branch of the same algorithm: too narrow for max-content, so every
  # column moves from its own min-content toward its own max by the SAME fraction.
  it 'interpolates from min-content toward max-content when the table is squeezed' do
    a_text = 'The quick brown fox jumps over'
    b_text = 'the lazy dog again and again'
    body = <<~HTML
      <div style="width:200px"><table id="t"><tr><td id="a">#{a_text}</td><td id="b">#{b_text}</td></tr></table></div>
    HTML
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: [a_text, b_text] + (a_text + ' ' + b_text).split)
    t, a, b = boxes
    assignable = 200 - SPACING * 3
    mins = [text.word(a_text) + PAD, text.word(b_text) + PAD]
    maxs = [text[a_text] + PAD, text[b_text] + PAD]
    ratio = (assignable - mins.sum) / (maxs.sum - mins.sum)
    expect(t[2]).to eq(200)
    expect(a[2]).to be_within(0.01).of(mins[0] + (maxs[0] - mins[0]) * ratio)   # Chrome: 101.81
    expect(b[2]).to be_within(0.01).of(mins[1] + (maxs[1] - mins[1]) * ratio)   # Chrome: 92.19
    expect(a[3]).to eq(line * (maxs[0] / a[2]).ceil + PAD)                      # wrapped, three lines
  end

  it 'grows the columns a cell spans only by what they are short of' do
    span_text = 'spanning both columns wide'
    body = <<~HTML
      <table id="t"><tr><td id="s" colspan="2">#{span_text}</td></tr>
      <tr><td id="x">x</td><td id="y">y</td></tr></table>
    HTML
    boxes, text = measure(body, ['#t', '#s', '#x', '#y'], probes: [span_text, 'x', 'y'])
    t, s, x, y = boxes
    # The spanning cell needs its width MINUS the spacing it swallows; the two
    # columns split the shortfall equally, because they wanted the same.
    each = (text[span_text] + PAD - SPACING) / 2
    expect([x[2], y[2]]).to all(be_within(0.01).of(each))                       # Chrome: 100.95
    expect(s[2]).to be_within(0.01).of(each * 2 + SPACING)                      # Chrome: 203.91
    expect(t[2]).to be_within(0.01).of(each * 2 + SPACING * 3)
  end

  it 'stretches a rowspan cell over the rows it covers' do
    body = <<~HTML
      <table id="t"><tr><td id="tall" rowspan="2">tall</td><td id="one">one</td></tr>
      <tr><td id="two">two</td></tr></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#tall', '#one', '#two'])
    t, tall, one, two = boxes
    row = line + PAD
    expect(tall[3]).to eq(row * 2 + SPACING)                                    # Chrome: 42
    expect(t[3]).to eq(row * 2 + SPACING * 3)
    # The spanning cell holds column 1 in BOTH rows, so the second row's only cell
    # sits in column 2 rather than at the table's left edge.
    expect(two[0]).to eq(one[0])
    expect(two[1]).to eq(one[1] + row + SPACING)
  end

  it 'halves the shared borders when the table collapses them' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr><td id="a" style="border:1px solid">A</td><td id="b" style="border:1px solid">B</td></tr>
      <tr><td id="c" style="border:1px solid">C</td><td id="d" style="border:1px solid">D</td></tr></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: %w[A C])
    t, a, b = boxes
    # A collapsed cell owns HALF of each shared border, and the border-spacing is
    # gone: 14.56 = the wider of the column's two letters + 2 padding + 0.5 + 0.5.
    col = [text['A'], text['C']].max + PAD + 1
    expect(a[2]).to be_within(0.01).of(col)                                     # Chrome: 14.56
    expect(a[0]).to eq(0.5)                                                     # the table holds the outer half
    expect(b[0]).to be_within(0.01).of(0.5 + col)
    expect(t[0]).to eq(0)
    expect(t[2]).to be_within(0.02).of(col * 2 + 1)                             # Chrome: 30.13
    expect(a[3]).to eq(line + PAD + 1)                                          # Chrome: 21
    expect(t[3]).to eq((line + PAD + 1) * 2 + 1)                                # Chrome: 43
  end

  # An inline-table collapses its borders exactly like a block-level table (§17.6 is indifferent to the table's
  # outer display): the table keeps only the OUTER HALF of its rim cells' collapsed borders, the inner half going
  # to the cell. (It used to keep the FULL border — laid out like a SEPARATE table — so its box, cell offset, and
  # client / scroll geometry were each a half-border off.)
  it 'collapses an inline-table border like a block table' do
    body = <<~HTML
      <table id="t" style="display:inline-table;border:10px solid;border-collapse:collapse">
      <tr><td id="a" style="width:40px;height:20px;padding:0">a</td></tr></table>
    HTML
    t, a = measure(body, ['#t', '#a']).first
    expect([a[0], a[1]]).to eq([5, 5])            # the cell is inset by the table's OUTER half (10/2), not the full 10
    expect([a[2], a[3]]).to eq([50, 30])          # the cell's border box carries the INNER half: 40 + 2*5 ; 20 + 2*5
    expect([t[2], t[3]]).to eq([60, 40])          # and the table box adds the outer halves: 50 + 2*5 ; 30 + 2*5
  end

  # A collapse table with NO grid to collapse (a display:table / inline-table element over bare text) has no
  # rim-cell borders to halve, so it keeps its OWN border rather than dropping the frame to zero — Chrome frames
  # it as if an anonymous cell held the inner halves, so the border box is content + the FULL border. Both outer
  # displays frame it identically. (Regression guard: routing inline-table through the collapse model must not
  # zero a grid-less table's frame.)
  it 'keeps the border on a grid-less collapse table' do
    body = <<~HTML
      <div id="blk" style="display:table;border:10px solid;border-collapse:collapse">hi</div>
      <span id="inl" style="display:inline-table;border:10px solid;border-collapse:collapse">hi</span>
    HTML
    boxes, _text, line = measure(body, ['#blk', '#inl'])
    blk, inl = boxes
    expect(inl[3]).to eq(blk[3])                       # inline-table frames a grid-less collapse table like display:table
    expect(inl[3]).to be_within(0.5).of(line + 20)    # content line + the full 10px border top+bottom, NOT dropped to 0
  end

  # Anonymous cells (CSS 2.1 §17.2.1): a table cannot leave content loose, so stray text and non-table
  # boxes are wrapped in anonymous table-cell boxes. A maximal RUN of consecutive stray content becomes
  # ONE anonymous cell laying the run out as block flow — two stray blocks STACK in one cell, they are
  # not two cells side by side. (Figures depend only on the explicit sizes, not the font.)
  it 'wraps a run of stray blocks in one anonymous cell' do
    body = <<~HTML
      <div id="t" style="display:table;border:1px solid">
      <div style="width:40px;height:20px"></div><div style="width:60px;height:10px"></div></div>
    HTML
    t, = measure(body, ['#t']).first
    expect([t[2], t[3]]).to eq([62, 32])      # one cell: 60 wide (the wider block), 30 tall (both stacked), + 1px border
  end

  # Stray content BESIDE a real cell is its own anonymous cell — a run is bounded by the real cells around it.
  it 'gives stray content beside a real cell its own anonymous cell' do
    body = <<~HTML
      <div id="t" style="display:table;border:1px solid">
      <div style="display:table-cell;width:20px;height:20px"></div><div style="width:30px;height:10px"></div></div>
    HTML
    t, = measure(body, ['#t']).first
    expect([t[2], t[3]]).to eq([52, 22])      # real cell (20) + an anonymous cell for the stray block (30), side by side
  end

  # In a border-collapse table the anonymous cell participates in the collapse like any cell: it carries
  # the INNER half of the table's rim border, so the table keeps only the outer half (clientLeft) and the
  # content sits inset by both halves. (This is the grid-less collapse case that used to keep the full border.)
  it 'lets an anonymous cell carry the inner half of a collapsed border' do
    body = '<div id="t" style="display:table;border:10px solid;border-collapse:collapse"><div id="b" style="width:20px;height:20px"></div></div>'
    boxes, _text, _line, session = measure(body, ['#t', '#b'])
    t, b = boxes
    expect([t[2], t[3]]).to eq([40, 40])      # block 20 + 2*5 inner halves (in the anon cell) + 2*5 outer halves (the table)
    expect([b[0], b[1]]).to eq([10, 10])      # the block is inset by the outer half (5) AND the anon cell's inner half (5)
    expect(session.evaluate_script("document.getElementById('t').clientLeft")).to eq(5)   # the table keeps only the outer half
  end

  # A cell's content is vertically aligned within its (row-tall) box (§17.5.3): the UA default is `middle`, and
  # `top` / `bottom` are honored, so a cell shorter than its row has its content pushed down. (Cross-cell baseline
  # alignment is a separate pass; a lone block's baseline resolves to the top.) The tall cell here makes the row
  # 40; the short cell's 10px block moves.
  def va_inner_y(va)
    body = %(<table id="t" style="border-spacing:0"><tr><td style="padding:0"><div style="width:20px;height:40px"></div></td>) +
           %(<td style="padding:0#{va == :default ? '' : ";vertical-align:#{va}"}"><div id="k" style="width:20px;height:10px"></div></td></tr></table>)
    boxes, = measure(body, ['#t', '#k'])
    boxes[1][1] - boxes[0][1]
  end
  it 'vertically aligns a short cell content within a taller row' do
    expect(va_inner_y(:default)).to eq(15)   # the UA default is middle: (40 - 10) / 2
    expect(va_inner_y('top')).to eq(0)
    expect(va_inner_y('middle')).to eq(15)
    expect(va_inner_y('bottom')).to eq(30)   # 40 - 10
  end

  it 'defaults a table cell to vertical-align: middle' do
    html = '<html><body><table><tr><td id="d">x</td><th id="h">y</th></tr></table></body></html>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script("getComputedStyle(document.getElementById('d')).verticalAlign")).to eq('middle')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('h')).verticalAlign")).to eq('middle')
  end

  # A cell's declared `height` is a MINIMUM (§17.5.3), not a fixed size like a block's: content taller than it
  # grows the cell (and its row), a declared height taller than the content is kept, and box-sizing is honored.
  def cell_h(style, inner)
    body = %(<table style="border-spacing:0"><tr><td id="c" style="#{style}">#{inner}</td></tr></table>)
    measure(body, ['#c']).first.first[3]
  end
  it 'treats a cell declared height as a minimum, growing to fit content' do
    expect(cell_h('height:10px;padding:0', '<div style="width:5px;height:30px"></div>')).to eq(30)   # content grows it
    expect(cell_h('height:50px;padding:0', '<div style="width:5px;height:12px"></div>')).to eq(50)   # declared kept as the floor
    expect(cell_h('height:40px;padding:5px;box-sizing:border-box', '<div style="width:5px;height:12px"></div>')).to eq(40)   # border-box floor
  end

  # A declared cell height is also a DEFINITE containing block for its percentage-height children — unlike a
  # block's `min-height`, which leaves the block auto-height so a `%` child there collapses. Chrome 137: a
  # `height: 50%` child of a `height: 100px` cell is 50, and a `height: 100%` child of an 80px cell is 80.
  def cell_and_child_h(cell_style, child_style)
    body = %(<table style="border-spacing:0"><tr><td id="c" style="padding:0;#{cell_style}"><div id="k" style="width:5px;#{child_style}"></div></td></tr></table>)
    boxes = measure(body, ['#c', '#k']).first
    [boxes[0][3], boxes[1][3]]
  end
  it 'resolves a percentage-height child against a declared cell height' do
    expect(cell_and_child_h('height:100px', 'height:50%')).to eq([100, 50])
    expect(cell_and_child_h('height:80px', 'height:100%')).to eq([80, 80])
  end

  # When a DECLARED-height cell GROWS past its declared height — from taller content or a row stretched by a
  # sibling — its percentage-height children resolve against the USED (row) height, not the declared floor, and
  # do NOT themselves inflate the cell (they are auto for sizing, §17.5.3 / CSS Sizing). A cell with NO declared
  # height stays indefinite: its percentage children resolve to 0 even when it grows. All Chrome 137-measured.
  def cell_child(cell_style, inner)
    body = %(<table style="border-spacing:0"><tr><td id="c" style="padding:0;#{cell_style}">#{inner}</td></tr></table>)
    boxes = measure(body, ['#c', '#k']).first
    [boxes[0][3], boxes[1][3]]
  end
  it 'resolves a percentage child against the used height of a cell that grew past its declared height' do
    # declared 10, sized by the 30px sibling to 30; the 50% child is 15 of that used 30 (was 5 of the floor).
    expect(cell_child('height:10px', '<div id="k" style="width:5px;height:50%"></div><div style="width:5px;height:30px"></div>')).to eq([30, 15])
    expect(cell_child('height:10px', '<div id="k" style="width:5px;height:100%"></div><div style="width:5px;height:30px"></div>')).to eq([30, 30])
    # a 200% child overflows the 30px used height (60) without growing the cell.
    expect(cell_child('height:10px', '<div id="k" style="width:5px;height:200%"></div><div style="width:5px;height:30px"></div>')).to eq([30, 60])
    # declared 80 > content: the child is 50% of 80, and the cell keeps 80.
    expect(cell_child('height:80px', '<div id="k" style="width:5px;height:50%"></div><div style="width:5px;height:30px"></div>')).to eq([80, 40])
  end
  it 'leaves a percentage child of an AUTO-height cell at 0 even when the cell grows' do
    # no declared height → indefinite CB; the 40px sibling grows the cell to 40 but the 50% child stays 0.
    expect(cell_child('', '<div id="k" style="width:5px;height:50%"></div><div style="width:5px;height:40px"></div>')).to eq([40, 0])
  end
  # A cell with NO declared height of its own is still a definite containing block when a declared TABLE height
  # stretches its row past the content (§17.5.3 / Chrome): the percentage child resolves against that imposed
  # height. A declared ROW height does NOT make Chrome resolve (that cell stays indefinite → child 0), and a
  # cell whose own CONTENT drives it taller than the table split is content-driven → child 0. Chrome 137.
  def tbl_cell_child(table_style, inner)
    body = %(<table style="border-spacing:0;#{table_style}"><tr><td id="c" style="padding:0">#{inner}</td></tr></table>)
    boxes = measure(body, ['#c', '#k']).first
    [boxes[0][3], boxes[1][3]]
  end
  it 'resolves a percentage child against a cell height imposed by a declared table height' do
    expect(tbl_cell_child('height:100px', '<div id="k" style="width:5px;height:50%"></div>')).to eq([100, 50])
    expect(tbl_cell_child('height:100px', '<div id="k" style="width:5px;height:100%"></div>')).to eq([100, 100])
    # a 20px sibling is below the table split → cell is table-imposed at 100, child 50 of it.
    expect(tbl_cell_child('height:100px', '<div id="k" style="width:5px;height:50%"></div><div style="width:5px;height:20px"></div>')).to eq([100, 50])
    # content (120) exceeds the table split → the cell is CONTENT-driven, so the child stays 0.
    expect(tbl_cell_child('height:100px', '<div id="k" style="width:5px;height:50%"></div><div style="width:5px;height:120px"></div>')).to eq([120, 0])
  end
  it 'leaves a percentage child of a declared-ROW-height (auto table) cell at 0' do
    body = '<table style="border-spacing:0"><tr style="height:100px"><td id="c" style="padding:0"><div id="k" style="width:5px;height:50%"></div></td></tr></table>'
    c, k = measure(body, ['#c', '#k']).first
    expect([c[3], k[3]]).to eq([100, 0])   # a declared row height does not make the cell a definite CB (Chrome)
  end

  it 'resolves a percentage MIN/MAX-height child against the cell height (auto-height child)' do
    # an auto-`height` child with a `%` min/max-height is sized height:0 (the clamp is deferred), so the cell's
    # second layout must re-lay it — not reuse its stale 0 — for the clamp to resolve against the used height.
    expect(cell_child('height:100px', '<div id="k" style="width:5px;min-height:50%"></div>')).to eq([100, 50])
    expect(cell_child('height:100px', '<div id="k" style="width:5px;height:80px;max-height:40%"></div>')).to eq([100, 40])
  end

  it 'resolves a percentage child against a cell stretched by a taller sibling cell' do
    body = <<~HTML
      <table style="border-spacing:0"><tr>
      <td id="c" style="height:10px;padding:0"><div id="k" style="width:5px;height:50%"></div></td>
      <td style="padding:0"><div style="width:5px;height:60px"></div></td></tr></table>
    HTML
    c, k = measure(body, ['#c', '#k']).first
    expect([c[3], k[3]]).to eq([60, 30])   # the row is 60; the 50% child resolves against that, not the declared 10
  end

  # A PERCENTAGE height on a <tr> resolves against the space the rows share (the table's content box minus the
  # border-spacing around and between them) when the table's height is definite, and is then a FIXED track like
  # a declared length — excluded from the surplus distribution, a MINIMUM its content can still grow past, and
  # squeezed in source order so percentage rows never overflow the table. With an auto-height table it has no
  # basis and is auto. All Chrome 137-measured.
  def pct_rows(table_style, markup)
    measure(%(<table style="border-spacing:#{table_style}">#{markup}</table>), ['#r1', '#r2']).first.map { it[3] }
  end
  it 'resolves a percentage <tr> height against the table height as a fixed track' do
    # row1 50% of the 100px table → 50; the auto row2 takes the rest.
    expect(pct_rows('0;height:100px', '<tr style="height:50%"><td id="r1" style="padding:0"><div style="width:5px;height:10px"></div></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:30px"></div></td></tr>')).to eq([50, 50])
    # two 50% rows → 50 / 50.
    expect(pct_rows('0;height:100px', '<tr style="height:50%"><td id="r1" style="padding:0"></td></tr><tr style="height:50%"><td id="r2" style="padding:0"></td></tr>')).to eq([50, 50])
    # two 60% rows cannot both fit: the later is squeezed into what is left → 60 / 40 (no overflow).
    expect(pct_rows('0;height:100px', '<tr style="height:60%"><td id="r1" style="padding:0"></td></tr><tr style="height:60%"><td id="r2" style="padding:0"></td></tr>')).to eq([60, 40])
    # a 20% row (20) whose content is 40 grows to 40 (the % is a minimum); the auto row takes the rest.
    expect(pct_rows('0;height:100px', '<tr style="height:20%"><td id="r1" style="padding:0"><div style="width:5px;height:40px"></div></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:10px"></div></td></tr>')).to eq([40, 60])
    # border-spacing:4 — the % resolves against the 88 the two rows share (3 gaps of 4) → 44 each.
    expect(pct_rows('4px;height:100px', '<tr style="height:50%"><td id="r1" style="padding:0"></td></tr><tr style="height:50%"><td id="r2" style="padding:0"></td></tr>')).to eq([44, 44])
  end
  it 'treats a percentage <tr> height as auto when the table height is indefinite' do
    # no table height → the % has no basis, so the rows are their content heights.
    expect(pct_rows('0', '<tr style="height:50%"><td id="r1" style="padding:0"><div style="width:5px;height:10px"></div></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:30px"></div></td></tr>')).to eq([10, 30])
  end

  # A cell whose OWN declared height exceeds its content still vertical-aligns that content within the (row-tall)
  # box — the slack is measured against the content's natural height, not the floored box. Chrome 137: a 12px
  # block in a `height: 50px` cell sits at 19 (middle) / 38 (bottom) from the cell top.
  def va_overtall_y(va)
    body = %(<table style="border-spacing:0"><tr><td id="c" style="padding:0;height:50px;vertical-align:#{va}"><div id="k" style="width:5px;height:12px"></div></td></tr></table>)
    boxes = measure(body, ['#c', '#k']).first
    boxes[1][1] - boxes[0][1]
  end
  it 'vertical-aligns content within a cell taller than the content by its own declared height' do
    expect(va_overtall_y('top')).to eq(0)
    expect(va_overtall_y('middle')).to eq(19)   # (50 - 12) / 2
    expect(va_overtall_y('bottom')).to eq(38)   # 50 - 12
  end

  # min-height / max-height have no effect on a table cell (CSS 2.2 §17.5.3 leaves them undefined; Chrome 137
  # treats both as auto): the cell's block size is only its `height` (a minimum) and its content. Only the
  # HEIGHT axis is ignored — min-width / max-width still feed the column width (a separate path).
  it 'ignores min-height / max-height on a table cell' do
    expect(cell_h('min-height:40px;padding:0', '<div style="width:5px;height:12px"></div>')).to eq(12)   # not 40
    expect(cell_h('max-height:20px;padding:0', '<div style="width:5px;height:30px"></div>')).to eq(30)   # not 20
    expect(cell_h('min-height:40px;padding:0', '')).to eq(0)                                             # not 40
    expect(cell_h('height:10px;min-height:40px;padding:0', '<div style="width:5px;height:12px"></div>')).to eq(12)   # height floor 10 < content 12; min-height inert
    expect(cell_h('height:60px;max-height:20px;padding:0', '<div style="width:5px;height:12px"></div>')).to eq(60)   # declared 60 kept; max-height inert
  end

  # …but a `display:table-cell` that is a FLEX / GRID item is BLOCKIFIED (CSS Display §2.7) — it is a block, not
  # a cell, so its min-height / max-height DO apply. Chrome 137: min-height:40 on a 12px-content flex-item cell
  # gives 40 (a genuine cell would give 12).
  it 'honors min-height / max-height on a table-cell that is a flex or grid item' do
    %w[flex grid].each do |mode|
      body = %(<div style="display:#{mode}"><div id="c" style="display:table-cell;min-height:40px"><div style="width:5px;height:12px"></div></div></div>)
      expect(measure(body, ['#c']).first.first[3]).to eq(40)
    end
  end

  # A cell's min-width / max-width DO size its column (CSS Tables 3 §4.1, unlike its min/max-height): min-width
  # raises the column, max-width caps it — even below the content's own min-content, and clamping a declared
  # `width` too. The cap is over the WHOLE column (the widest cell's constraint wins across rows).
  def col_w(sel, body) = measure(body, sel).first.map { it[2].round(2) }
  it 'lets a cell min-width / max-width size its column' do
    tbl = ->(cells) { %(<table style="border-spacing:0;font:16px monospace"><tr>#{cells}</tr></table>) }
    expect(col_w(['#c'], tbl['<td id="c" style="min-width:80px;padding:0">A</td>'])).to eq([80])              # raises past content
    expect(col_w(['#c'], tbl['<td id="c" style="max-width:3px;padding:0">wwww</td>'])).to eq([3])             # caps below min-content
    expect(col_w(['#c'], tbl['<td id="c" style="width:50px;min-width:80px;padding:0">A</td>'])).to eq([80])   # min-width beats a smaller width
    expect(col_w(['#c'], tbl['<td id="c" style="width:200px;max-width:40px;padding:0">A</td>'])).to eq([40])  # max-width beats a larger width
  end
  it 'raises the whole column to the widest cell min-width across rows' do
    body = <<~HTML
      <table style="border-spacing:0;font:16px monospace">
      <tr><td id="a" style="padding:0">A</td></tr><tr><td id="b" style="min-width:80px;padding:0">C</td></tr></table>
    HTML
    expect(col_w(['#a', '#b'], body)).to eq([80, 80])   # the 2nd row's min-width sizes the shared column
  end

  # max-width caps only the INTRINSIC contribution: a fixed table width still shares its surplus over the column,
  # which grows PAST the max-width (Chrome: a max-width:40 column in a 300px table grows to ~242).
  it 'grows a max-width column past its max when a fixed table width has a surplus' do
    body = <<~HTML
      <table style="border-spacing:0;width:300px;font:16px monospace">
      <tr><td id="g1" style="max-width:40px;padding:0">wwwwwwww</td><td id="g2" style="padding:0">B</td></tr></table>
    HTML
    g1, g2 = col_w(['#g1', '#g2'], body)
    expect(g1).to be > 40           # grew past its own max-width
    expect(g1 + g2).to be_within(0.01).of(300)   # the two columns fill the fixed table
  end

  # colspan / rowspan are HTML attributes only <td> / <th> carry; on any other element acting as a cell (a
  # display:table-cell div, an anonymous cell) a browser ignores them, so it stays a single 1x1 cell.
  it 'ignores colspan / rowspan on a non-td/th cell' do
    body = <<~HTML
      <div style="display:table;border-spacing:0">
      <div style="display:table-row"><div id="a" style="display:table-cell;width:20px;height:24px" colspan="2" rowspan="2"></div><div style="display:table-cell;width:20px;height:24px"></div></div>
      <div style="display:table-row"><div style="display:table-cell;width:20px;height:24px"></div><div style="display:table-cell;width:20px;height:24px"></div></div></div>
    HTML
    a, = measure(body, ['#a']).first
    expect([a[2], a[3]]).to eq([20, 24])   # one column, one row — the span attributes do nothing on a <div>
  end

  # §17.2.1 applies to a real table-ROW too, not just the table: stray content inside a row is wrapped in an
  # anonymous cell, not dropped. (It used to vanish — the table collapsed to its own border.)
  it 'wraps stray content inside a real table-row in an anonymous cell' do
    body = <<~HTML
      <div id="t" style="display:table;border:1px solid">
      <div style="display:table-row"><div style="width:40px;height:20px"></div></div></div>
    HTML
    t, = measure(body, ['#t']).first
    expect([t[2], t[3]]).to eq([42, 22])      # the stray block gets an anonymous cell in the row: 40 + 1px border each side
  end

  # A collapsed edge is resolved from the WHOLE grid, not one cell: a shared edge is as wide as
  # the widest of the two borders facing across it, an outer edge collapses with the table's own
  # border, and the two boxes sharing the edge own HALF each. With borders that differ per side
  # the old "max of this cell's own two sides" was wrong; these figures are Chrome 137 and depend
  # only on the explicit widths + border widths, not on the font.
  it 'splits each collapsed edge by the widest border meeting on it' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr><td id="a" style="border-left:2px solid;border-right:10px solid;width:60px;padding:0">a</td>
      <td id="b" style="border-left:6px solid;border-right:4px solid;width:80px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[0], a[2]]).to eq([1, 66])   # outer-left max(2,0)/2 + 60 + shared max(10,6)/2 = 1 + 60 + 5
    expect([b[0], b[2]]).to eq([67, 87])  # shared 5 + 80 + outer-right max(4,0)/2 = meets a at 67, 87 wide
    expect([t[0], t[2]]).to eq([0, 156])
  end

  it 'splits collapsed edges the same way down a column (top/bottom borders)' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr><td id="a" style="border-top:2px solid;border-bottom:10px solid;width:40px;height:20px;padding:0">a</td></tr>
      <tr><td id="b" style="border-top:6px solid;border-bottom:4px solid;width:40px;height:30px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[1], a[3]]).to eq([1, 26])   # outer-top 1 + 20 + shared max(10,6)/2 = 5
    expect([b[1], b[3]]).to eq([27, 37])  # shared 5 + 30 + outer-bottom max(4,0)/2 = 2
    expect(t[3]).to eq(66)
  end

  # border-style:hidden has the HIGHEST priority in the collapsing model (CSS 2.1 §17.6.2.1): it SUPPRESSES
  # the whole shared edge (width 0), beating any wider neighbour — unlike `none`, which merely contributes 0
  # and loses to a neighbour. Chrome 137: a 10px-hidden right on A facing a 10px-solid left on B collapses to
  # NOTHING between them (both cells 61 = 60 + the outer 1 + nothing shared).
  it 'suppresses a collapsed edge when either side is border-style:hidden' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr><td id="a" style="border:2px solid;border-right:10px hidden;width:60px;padding:0">a</td>
      <td id="b" style="border:2px solid;border-left:10px solid;width:60px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[0], a[2]]).to eq([1, 61])   # left outer 1 + 60 + shared SUPPRESSED (0)
    expect([b[0], b[2]]).to eq([62, 61])  # meets a with no border between; right outer 1
    expect([t[0], t[2]]).to eq([0, 124])
  end

  # hidden on a RIM cell's outer edge suppresses the whole shared edge INCLUDING the table's own border on
  # that rim — not just the cell's half (§17.6.2.1). Chrome: a 20px-bordered table around a cell whose left is
  # hidden puts the cell flush at x=0 and the table is 70 wide (50 + the right outer half 10), its left gone.
  it 'lets a rim cell border-style:hidden suppress the table\'s own border on that rim' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse;border:20px solid">
      <tr><td id="a" style="border:4px solid;border-left:4px hidden;width:50px;height:20px;padding:0">a</td></tr></table>
    HTML
    t, a = measure(body, ['#t', '#a']).first
    expect([a[0], a[2]]).to eq([0, 60])   # left edge SUPPRESSED (table's 20px gone) + 50 + shared... right outer max(4,20)/2=10
    expect([t[0], t[2]]).to eq([0, 70])
  end

  # A SPANNING cell shares one edge with several cells; a hidden on ONE of them suppresses only THAT segment,
  # not the spanning cell's whole edge (the widest surviving segment still sets its border). Chrome 137.
  it 'suppresses only the hidden segment of a spanning cell\'s collapsed edge' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr><td id="A" colspan="2" style="border:4px solid;width:80px;padding:0">A</td></tr>
      <tr><td id="b" style="border-top:20px hidden;width:40px;padding:0">b</td>
      <td id="c" style="border-top:10px solid;width:40px;padding:0">c</td></tr></table>
    HTML
    t, a, b, c = measure(body, ['#t', '#A', '#b', '#c']).first
    # A's bottom: the b-segment (hidden) is suppressed, the c-segment (max(4,10)/2=5) survives → A keeps a 5px bottom
    expect([a[0], a[2]]).to eq([2, 84])   # outer-left 2 + 80 + outer-right 2
    expect([b[0], b[2]]).to eq([2, 42])
    expect([c[0], c[2]]).to eq([44, 42])
    expect([t[0], t[2]]).to eq([0, 88])
  end

  # Not only CELLS meet on a collapsed grid line — a tr / row-group / col / colgroup border is resolved into it
  # too (widest wins, hidden suppresses; §17.6.2.1). Chrome 137, widths/heights pinned by the explicit sizes.
  it 'folds a row border into the inter-row collapsed edge' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr style="border-bottom:20px solid"><td id="a" style="border:2px solid;width:40px;height:20px;padding:0">a</td></tr>
      <tr><td id="b" style="border:2px solid;width:40px;height:20px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[1], a[3]]).to eq([1, 31])   # top outer 1 + 20 + shared max(2,20,2)/2 = 10
    expect([b[1], b[3]]).to eq([32, 31])
    expect(t[3]).to eq(64)
  end

  it 'folds a <col> border into the inter-column collapsed edge' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse"><colgroup><col style="border-right:20px solid"><col></colgroup>
      <tr><td id="a" style="border:2px solid;width:40px;padding:0">a</td>
      <td id="b" style="border:2px solid;width:40px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[0], a[2]]).to eq([1, 51])   # left outer 1 + 40 + shared max(2,20,2)/2 = 10
    expect([b[0], b[2]]).to eq([52, 51])
    expect(t[2]).to eq(104)
  end

  # A <col span=N> is N column boxes, each carrying the border — so the col's left/right reaches EVERY column
  # it covers, the internal edges inside the span included (Chrome renders it identically to N separate <col>s).
  it 'applies a spanning <col> border to every column it covers' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse"><colgroup><col span="2" style="border-left:14px solid"><col></colgroup>
      <tr><td id="a" style="border:2px solid;width:40px;padding:0">a</td>
      <td id="b" style="border:2px solid;width:40px;padding:0">b</td>
      <td id="c" style="border:2px solid;width:40px;padding:0">c</td></tr></table>
    HTML
    t, a, b, c = measure(body, ['#t', '#a', '#b', '#c']).first
    # col0.left AND col1.left = 14, so both the outer-left AND the col0|col1 internal edge grow to 14 (half 7)
    expect([a[0], a[2]]).to eq([7, 54])   # outer-left 7 + 40 + shared max(2,14)/2 = 7
    expect([b[0], b[2]]).to eq([61, 48])  # shared 7 + 40 + b|c shared 1
    expect([c[0], c[2]]).to eq([109, 42])
    expect(t[2]).to eq(152)
  end

  # A childless <colgroup span=N> is ONE box (unlike <col span=N> = N boxes): its left/right land only at the
  # group's OUTER rim, NOT on the internal edges inside the span. Chrome: with border-left:12/right:6 the
  # internal col edge stays cells-only (flush), so the cells are narrower than the <col span=2> case above.
  it 'applies a childless <colgroup span> border only at its outer rim' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse"><colgroup span="2" style="border-left:12px solid;border-right:6px solid"></colgroup>
      <tr><td id="a" style="border:2px solid;width:40px;height:20px;padding:0">a</td>
      <td id="b" style="border:2px solid;width:40px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[0], a[2]]).to eq([6, 47])   # outer-left max(2,12)/2=6 + 40 + internal cells-only 1 (colgroup does NOT reach it)
    expect([b[0], b[2]]).to eq([53, 44])  # internal 1 + 40 + outer-right max(2,6)/2=3
    expect(t[2]).to eq(100)
  end

  it 'folds a row-group border into the outer collapsed edge' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse"><tbody style="border-top:16px solid">
      <tr><td id="a" style="border:2px solid;width:40px;height:20px;padding:0">a</td></tr></tbody></table>
    HTML
    t, a = measure(body, ['#t', '#a']).first
    expect([a[1], a[3]]).to eq([8, 29])   # top outer max(2,16)/2 = 8 + 20 + bottom outer 1
    expect(t[3]).to eq(38)
  end

  # A collapse table has NO padding of its own and its border collapses with the edge cells: the
  # table box adds only the OUTER half of max(its own border, the rim cell's border) on each side.
  it 'ignores its own padding and collapses its own border with the edge cells' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse;padding:10px;border:4px solid">
      <tr><td id="a" style="border:2px solid;width:40px;padding:0">a</td>
      <td id="b" style="border:2px solid;width:40px;padding:0">b</td></tr></table>
    HTML
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect([a[0], a[2]]).to eq([2, 43])   # outer-left max(2,4)/2 = 2 (padding ignored) + 40 + shared 1
    expect([b[0], b[2]]).to eq([45, 43])
    expect([t[0], t[2]]).to eq([0, 90])   # 43 + 43 + the two outer halves (2 + 2)
  end

  it 'puts the declared border-spacing around and between every cell' do
    body = <<~HTML
      <table id="t" style="border-spacing:10px 5px">
      <tr><td id="a" style="border:2px solid">A</td><td id="b" style="border:2px solid">B</td></tr>
      <tr><td id="c" style="border:2px solid">C</td><td id="d" style="border:2px solid">D</td></tr></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#a', '#b', '#c'])
    t, a, b, c = boxes
    cell_h = line + PAD + 4          # the line, the UA padding, and both borders
    expect(a[0]).to eq(10)
    expect(a[1] - t[1]).to eq(5)
    expect(a[3]).to eq(cell_h)                                                  # Chrome: 24
    expect(b[0]).to be_within(0.01).of(10 + a[2] + 10)
    expect(c[1] - a[1]).to eq(cell_h + 5)
    expect(t[3]).to eq(cell_h * 2 + 15)                                         # Chrome: 63
  end

  it 'lays the caption above the rows and inside the table box' do
    body = <<~HTML
      <table id="t"><caption id="cap">The caption</caption>
      <thead id="head"><tr><th id="th">Header</th><th>Second</th></tr></thead>
      <tbody id="body"><tr><td id="td">body</td><td>cell</td></tr></tbody>
      <tfoot id="foot"><tr><td>foot</td><td>x</td></tr></tfoot></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#cap', '#head', '#th', '#body', '#td', '#foot'],
                                probes: ['body'], bold_probes: ['Header'])
    t, cap, head, th, body_group, td, foot = boxes
    row = line + PAD
    expect(cap[1]).to eq(t[1])                       # the caption's top IS the table's top
    expect(cap[2]).to be_within(0.01).of(t[2])       # and it is as wide as the whole table
    expect(cap[3]).to eq(line)
    expect(t[3]).to eq(line + SPACING * 4 + row * 3)                            # Chrome: 86
    # A row group's box wraps only its own rows, and it is the header's BOLD text
    # that sizes column 1 — the widest cell in a column is not the widest string.
    expect(head[1]).to eq(cap[1] + line + SPACING)
    expect(head[3]).to eq(row)
    expect(td[2]).to be_within(0.01).of(th[2])
    expect(th[2]).to be_within(0.01).of([text['Header', 'bold'], text['body']].max + PAD)   # Chrome: 56.25
    expect(foot[1] - body_group[1]).to eq(row + SPACING)
  end

  it 'sizes fixed-layout columns from the first row and wraps the content to them' do
    cell_text = 'a very long piece of text here'
    body = <<~HTML
      <table id="t" style="table-layout:fixed;width:300px">
      <tr><td id="a" style="width:100px">#{cell_text}</td><td id="b">b</td></tr></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: [cell_text])
    t, a, b = boxes
    expect(t[2]).to eq(300)
    expect(a[2]).to eq(100 + PAD)                    # the declared width plus the UA padding
    expect(b[2]).to eq(300 - SPACING * 3 - (100 + PAD))   # everything left, content unmeasured
    # The text wraps to the column instead of the column growing to the text.
    lines = (text[cell_text] / 100).ceil
    expect(lines).to be > 1
    expect([a[3], b[3]]).to all(eq(line * lines + PAD))                         # Chrome: 56
    expect(t[3]).to eq(line * lines + PAD + SPACING * 2)
  end

  it 'treats a declared row height as a minimum every cell in it fills' do
    body = <<~HTML
      <table id="t"><tr id="r" style="height:80px"><td id="a">a</td>
      <td id="b" style="height:30px">b</td></tr></table>
    HTML
    boxes, = measure(body, ['#t', '#r', '#a', '#b'])
    t, r, a, b = boxes
    expect(r[3]).to eq(80)
    expect([a[3], b[3]]).to all(eq(80))              # the row wins over the cell's own 30px
    expect(t[3]).to eq(80 + SPACING * 2)
  end

  it 'keeps a cell as wide as its column and as tall as the row beside it' do
    body = '<table id="t"><tr><td id="empty"></td><td id="box"><div style="height:60px;width:40px"></div></td></tr></table>'
    boxes, = measure(body, ['#t', '#empty', '#box'])
    t, empty, box = boxes
    expect(empty[2]).to eq(PAD)                      # nothing in it but the UA padding
    expect(empty[3]).to eq(60 + PAD)                 # …yet as tall as the cell beside it
    expect(box[2]).to eq(40 + PAD)                   # a block child's width sizes the column
    expect(t[2]).to eq(PAD + (40 + PAD) + SPACING * 3)
  end

  # `display: table` + `display: table-cell` with nothing between them — the "table
  # for layout" idiom — is a table whose rows a browser generates for it. Without
  # them the table has no rows at all, and reported a 0x0 box for itself and every
  # cell in it.
  it 'generates the row a table-cell needs when the markup has none' do
    body = '<div id="t" style="display:table"><div id="a" style="display:table-cell">first cell</div>' \
           '<div id="b" style="display:table-cell">second</div></div>'
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: ['first cell', 'second'])
    t, a, b = boxes
    # A CSS table has no UA border-spacing and its cells no UA padding — those are
    # `<table>` / `<td>` rules — so the cells sit flush against each other.
    expect(a[2]).to be_within(0.01).of(text['first cell'])
    expect(b[0]).to be_within(0.01).of(a[2])
    expect(t[2]).to be_within(0.01).of(text['first cell'] + text['second'])
    expect(t[3]).to eq(line)
  end

  # A `colspan` wider than the table is clamped to the columns that exist rather than
  # inventing them — Chrome gives the first table two columns and the second one.
  it 'clamps a colspan to the columns the table actually has' do
    wide = '<table id="t"><tr><td id="s" colspan="5">spanning wide text</td></tr>' \
           '<tr><td id="x">x</td><td id="y">y</td></tr></table>'
    boxes, text = measure(wide, ['#t', '#s', '#x', '#y'], probes: ['spanning wide text'])
    t, s, x, y = boxes
    each = (text['spanning wide text'] + PAD - SPACING) / 2
    expect([x[2], y[2]]).to all(be_within(0.01).of(each))
    expect(t[2]).to be_within(0.01).of(each * 2 + SPACING * 3)   # 3 gaps, not 6

    lone = '<table id="t2"><tr><td id="c" colspan="3">only row spans three</td></tr></table>'
    t2, c = measure(lone, ['#t2', '#c'], probes: ['only row spans three']).first
    expect(t2[2]).to be_within(0.01).of(c[2] + SPACING * 2)      # ONE column, so two gaps
  end

  it 'keeps a rowspan inside its own row group' do
    body = <<~HTML
      <table id="t"><tbody><tr><td id="s" rowspan="2">span</td><td id="one">one</td></tr></tbody>
      <tbody><tr><td id="two">two</td></tr></tbody></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#s', '#one', '#two'])
    _t, s, one, two = boxes
    expect(s[3]).to eq(line + PAD)          # one row tall: it cannot reach the next tbody
    expect(s[0]).to eq(SPACING)             # …so the next group's row starts at the FIRST
    expect(two[0]).to eq(SPACING)           # column, where the span would otherwise sit
    expect(one[0]).to be > two[0]
  end

  # Chrome renders a header group first and a footer group last whatever the source
  # order says. Getting this wrong also mis-picks the first row for fixed layout.
  it 'renders a footer group last however the markup orders it' do
    body = <<~HTML
      <table id="t"><tfoot id="foot"><tr><td>foot</td></tr></tfoot>
      <tbody id="body"><tr><td>body</td></tr></tbody></table>
    HTML
    _t, foot, body_group = measure(body, ['#t', '#foot', '#body']).first
    expect(body_group[1]).to be < foot[1]
  end

  it 'shares a declared table height out over its rows' do
    body = '<table id="t" style="height:200px"><tr><td id="a">A</td></tr><tr><td id="b">B</td></tr></table>'
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect(t[3]).to eq(200)
    expect([a[3], b[3]]).to all(eq((200 - SPACING * 3) / 2))     # Chrome: 97 each (equal content → equal share)
    expect(b[1]).to eq(a[1] + a[3] + SPACING)
  end

  # The surplus of a declared table height goes to the AUTO rows in proportion to their CONTENT, not equally
  # (Chrome 137): rows of 10 and 30 in a 100px table become 25 and 75. A row with a DECLARED height is a fixed
  # track and takes none; when every row is declared the surplus spreads over all of them by their heights.
  it 'distributes a table-height surplus to auto rows in proportion to their content' do
    rows = lambda { |markup|
      measure(%(<table style="border-spacing:0;height:100px">#{markup}</table>), ['#r1', '#r2']).first.map { it[3] }
    }
    # auto rows, content 10 / 30 → proportional 25 / 75 (not 50 / 50).
    expect(rows.call('<tr><td id="r1" style="padding:0"><div style="width:5px;height:10px"></div></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:30px"></div></td></tr>')).to eq([25, 75])
    # a 0-content auto row takes none of the surplus.
    expect(rows.call('<tr><td id="r1" style="padding:0"></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:30px"></div></td></tr>')).to eq([0, 100])
    # a declared-height row (r1) is fixed; all the surplus goes to the auto row (r2).
    expect(rows.call('<tr style="height:50px"><td id="r1" style="padding:0"></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:10px"></div></td></tr>')).to eq([50, 50])
    # every row declared (20 / 40) → surplus in proportion to their heights → 33.33 / 66.67 (Chrome) of the 100.
    r1, r2 = rows.call('<tr style="height:20px"><td id="r1" style="padding:0"></td></tr><tr style="height:40px"><td id="r2" style="padding:0"></td></tr>')
    expect(r1).to be_within(0.01).of(100.0 / 3)
    expect(r2).to be_within(0.01).of(200.0 / 3)
  end

  # A table's MIN-height taller than the grid shares its surplus over the rows exactly like a height does, and
  # is the basis a percentage row resolves against — the larger of a declared height and a min-height is the
  # imposed height. A min-height SMALLER than the content has no effect; a declared height still wins when it is
  # the larger. Chrome 137, border-spacing:0.
  it 'distributes a table min-height over its rows like a height' do
    mh = lambda { |style, markup|
      measure(%(<table style="border-spacing:0;#{style}">#{markup}</table>), ['#r1', '#r2']).first.map { it[3] }
    }
    two = '<tr><td id="r1" style="padding:0"><div style="width:5px;height:10px"></div></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:30px"></div></td></tr>'
    expect(mh.call('min-height:100px', two)).to eq([25, 75])                 # min-height distributes like height
    expect(mh.call('height:80px;min-height:100px', two)).to eq([25, 75])     # min-height (100) wins over the smaller height
    expect(mh.call('height:120px;min-height:100px', two)).to eq([30, 90])    # the larger declared height wins → shares 120
    # content taller than the min-height: no surplus, rows at their natural heights.
    expect(mh.call('min-height:50px', '<tr><td id="r1" style="padding:0"><div style="width:5px;height:60px"></div></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:60px"></div></td></tr>')).to eq([60, 60])
    # a min-height is a percentage row's basis too: a 50% row is 50 of the 100.
    expect(mh.call('min-height:100px', '<tr style="height:50%"><td id="r1" style="padding:0"></td></tr><tr><td id="r2" style="padding:0"><div style="width:5px;height:10px"></div></td></tr>')).to eq([50, 50])
  end

  # An imposed height sizes the ROW GRID; a caption sits OUTSIDE it (§17.4 wrapper) and adds ON TOP, so the rows
  # fill the whole imposed height and the table box grows by the caption. A too-small imposed height is just a
  # floor — the box grows to its tracks. Chrome 137, border-spacing:0, padding:0.
  it 'fills the rows to an imposed height and adds a caption on top' do
    body = <<~HTML
      <table id="t" style="border-spacing:0;height:100px"><caption style="height:16px">c</caption>
      <tr><td id="r1" style="padding:0"><div style="width:5px;height:10px"></div></td></tr>
      <tr><td id="r2" style="padding:0"><div style="width:5px;height:30px"></div></td></tr></table>
    HTML
    t, r1, r2 = measure(body, ['#t', '#r1', '#r2']).first
    expect([t[3], r1[3], r2[3]]).to eq([116, 25, 75])   # rows share the full 100; the 16 caption is on top
  end
  it 'grows a table box past a declared height too small for its content' do
    t = measure('<table id="t" style="border-spacing:0;height:10px"><tr><td style="padding:0"><div style="width:5px;height:50px"></div></td></tr></table>', ['#t']).first.first
    expect(t[3]).to eq(50)   # the declared height is a floor; the box grows to the 50px content
  end

  # A table's height / max-height are MINIMUMS, never clips: `max-height` caps a declared/preferred height but
  # never the CONTENT (a table is at least as tall as its rows), and `min-height` beats `max-height`. Chrome 137.
  it 'treats a table max-height as a cap on the declared height, never below the content' do
    th = lambda { |style, inner| measure(%(<table id="t" style="border-spacing:0;#{style}"><tr><td style="padding:0">#{inner}</td></tr></table>), ['#t']).first.first[3] }
    tall = '<div style="width:5px;height:50px"></div>'
    expect(th.call('max-height:10px', tall)).to eq(50)                              # max-height never clips content
    expect(th.call('height:200px;max-height:100px', tall)).to eq(100)              # caps the declared height
    expect(th.call('max-height:100px', '<div style="width:5px;height:200px"></div>')).to eq(200)   # content wins over max
    expect(th.call('min-height:100px;max-height:50px', '<div style="width:5px;height:10px"></div>')).to eq(100)  # min beats max
  end

  # An imposed height reaches the box even with NO rows to distribute over — an empty or caption-only table is
  # still as tall as its height / min-height (the imposed height floors the grid region directly). Chrome 137.
  it 'floors an empty table at its imposed height' do
    e = lambda { |style, inner = ''| measure(%(<table id="t" style="border-spacing:0;#{style}">#{inner}</table>), ['#t']).first.first[3] }
    expect(e.call('height:200px')).to eq(200)
    expect(e.call('min-height:100px')).to eq(100)
    expect(e.call('height:200px;max-height:10px')).to eq(10)     # capped
    expect(e.call('height:200px;border:5px solid;padding:7px')).to eq(200)   # border-box floor
    expect(e.call('height:200px', '<caption style="height:16px">c</caption>')).to eq(216)   # caption on top of the imposed grid
    expect(e.call('')).to eq(0)                                  # no imposed height → empty
  end

  # A table told to be narrower than its content grows instead of letting its own
  # cells overflow the box that is supposed to contain them.
  it 'grows past a declared width too narrow for its content' do
    body = '<table id="t" style="width:200px"><tr><td id="a"><div style="width:400px;height:10px"></div></td></tr></table>'
    t, a = measure(body, ['#t', '#a']).first
    expect(a[2]).to eq(400 + PAD)
    expect(t[2]).to eq(400 + PAD + SPACING * 2)                  # Chrome: 406
  end

  # A percentage column resolves against the width being SHARED OUT, not the table's
  # own box — and takes no part in the surplus, which its auto neighbour absorbs.
  it 'resolves a percentage column against the assignable width' do
    body = '<table id="t" style="width:400px"><tr><td id="a" style="width:25%">A</td><td id="b">B</td></tr></table>'
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    assignable = 400 - SPACING * 3
    expect(t[2]).to eq(400)
    expect(a[2]).to be_within(0.01).of(assignable * 0.25)        # Chrome: 98.5
    expect(b[2]).to be_within(0.01).of(assignable * 0.75)        # Chrome: 295.5
  end

  it 'puts a caption below the rows when caption-side says so' do
    body = '<table id="t" style="caption-side:bottom"><caption id="cap">cap</caption><tr><td id="a">A</td></tr></table>'
    t, cap, a = measure(body, ['#t', '#cap', '#a']).first
    expect(a[1]).to be < cap[1]
    expect(cap[1] + cap[3]).to eq(t[1] + t[3])
  end

  # A caption's containing block is the table's BORDER box, and it sits OUTSIDE the
  # table's own border and padding (§17.4 / the "table wrapper box") — so on a
  # bordered, padded table the caption spans the FULL border-box width at the
  # wrapper's top-left corner, ABOVE the border, not inset into the content box.
  # (Chrome, border:10 padding:7: caption [0,0,74,18], the first cell at [17,35].)
  it 'gives a caption the table border-box width, outside the border and padding' do
    body = <<~HTML
      <table id="t" style="border:10px solid;padding:7px;border-spacing:0">
      <caption id="cap">cap</caption><tr><td id="a" style="width:40px;padding:0">a</td></tr></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#cap', '#a'])
    t, cap, a = boxes
    expect([cap[0], cap[1]]).to eq([t[0], t[1]])         # the wrapper's top-left, above the border
    expect(cap[2]).to be_within(0.01).of(t[2])           # the WHOLE border box, not the 40px content
    expect(cap[3]).to eq(line)
    expect(a[0]).to eq(t[0] + 17)                        # the grid is inset by border+padding, below the caption
    expect(a[1]).to eq(cap[1] + cap[3] + 17)
  end

  # Auto horizontal margins centre a narrower caption over the border box (§10.3.3),
  # exactly like a block in its containing block. (Chrome, table 200 / caption 40:
  # caption x = (200-40)/2 = 80.)
  it 'centres a caption with auto margins over the border box' do
    body = <<~HTML
      <table id="t" style="width:200px;border-spacing:0">
      <caption id="cap" style="width:40px;margin:0 auto">cap</caption><tr><td id="a">a</td></tr></table>
    HTML
    t, cap = measure(body, ['#t', '#cap']).first
    expect(cap[2]).to eq(40)
    expect(cap[0]).to be_within(0.01).of(t[0] + (t[2] - cap[2]) / 2)
  end

  # A caption's own margins inset its margin box within the border box, and an AUTO
  # width then fills what is left. (Chrome, border:4 / caption margin:5: caption
  # [5,5,38,18] — width = border-box 48 minus the two 5px margins.)
  it 'insets an auto-width caption by its own margins' do
    body = <<~HTML
      <table id="t" style="border:4px solid;border-spacing:0">
      <caption id="cap" style="margin:5px">cap</caption><tr><td id="a" style="width:40px;padding:0">a</td></tr></table>
    HTML
    t, cap = measure(body, ['#t', '#cap']).first
    expect([cap[0], cap[1]]).to eq([t[0] + 5, t[1] + 5])
    expect(cap[2]).to be_within(0.01).of(t[2] - 10)
  end

  # A caption WIDER than the grid floors the table's BORDER-box width to the caption's
  # margin box (§17.5.2 / the caption spans the wrapper); the columns then distribute
  # over what is left inside the border+padding, NOT over the caption's full width.
  # (Chrome, border:10 / caption 300: table 300, the cell 280 = 300 - the two borders.)
  it 'floors the table border box to a wide caption, insetting the grid by the border' do
    body = <<~HTML
      <table id="t" style="border:10px solid;border-spacing:0">
      <caption id="cap" style="width:300px">cap</caption><tr><td id="a" style="width:40px;padding:0">a</td></tr></table>
    HTML
    t, cap, a = measure(body, ['#t', '#cap', '#a']).first
    expect(t[2]).to eq(300)                              # the border box grows to the caption, not caption+border
    expect(cap[2]).to eq(300)
    expect(a[2]).to eq(300 - 20)                         # the cell fills the content box: border box minus borders
  end

  # A caption's declared width is honored as-measured, box-sizing and all: a
  # border-box caption's border+padding come OUT of its declared width, they do not
  # grow it. (Chrome, caption width:100 box-sizing:border-box border:8 padding:5:
  # caption width stays 100.)
  it 'honors a border-box caption width' do
    body = <<~HTML
      <table id="t" style="width:200px;border-spacing:0">
      <caption id="cap" style="width:100px;box-sizing:border-box;border:8px solid;padding:5px">cap</caption>
      <tr><td id="a">a</td></tr></table>
    HTML
    t, cap = measure(body, ['#t', '#cap']).first
    expect(cap[0]).to eq(t[0])
    expect(cap[2]).to eq(100)
  end

  # Like any block in the table's width, a caption is placed from the inline-start edge: in an `rtl` table a
  # caption NARROWER than the border box sits flush against the RIGHT (§10.3.3 balances the leading — right —
  # margin). (Chrome: border:10 / caption width:40 over a 100px border box → caption x = 60, right edge at 100.)
  it 'places a narrow caption at the inline-start of an rtl table' do
    body = <<~HTML
      <table id="t" style="direction:rtl;border:10px solid;border-spacing:0">
      <caption id="cap" style="width:40px">cap</caption><tr><td id="a" style="width:40px;padding:0">a</td></tr></table>
    HTML
    t, cap = measure(body, ['#t', '#cap']).first
    expect(cap[2]).to eq(40)
    expect(cap[0] + cap[2]).to be_within(0.01).of(t[0] + t[2])   # flush against the border box's right edge
  end

  # A `<col span>` width is the width of EACH column it covers, not a total to split.
  it 'gives every column a col span covers the width it names' do
    body = <<~HTML
      <table id="t" style="table-layout:fixed;width:400px"><colgroup><col span="2" style="width:120px"><col></colgroup>
      <tr><td id="a">a</td><td id="b">b</td><td id="c">c</td></tr></table>
    HTML
    _t, a, b, c = measure(body, ['#t', '#a', '#b', '#c']).first
    expect([a[2], b[2]]).to all(eq(120))
    expect(c[2]).to eq(400 - SPACING * 4 - 240)                  # Chrome: 152
  end

  # The UA stylesheet is an origin above the initial value, so it has to answer a
  # resolved-value read too — and with the SAME number layout used, or the page and
  # the geometry disagree about a box that both of them are describing.
  it 'reports the UA cell padding and border-spacing through getComputedStyle' do
    html = '<html><body><table id="t"><tr><td id="d">x</td><th id="h">y</th></tr></table></body></html>'
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    read = JSON.parse(session.evaluate_script(<<~JS))
      JSON.stringify({
        pad:      getComputedStyle(document.getElementById('d')).paddingTop,
        th_pad:   getComputedStyle(document.getElementById('h')).paddingLeft,
        spacing:  getComputedStyle(document.getElementById('t')).borderSpacing,
        collapse: getComputedStyle(document.getElementById('t')).borderCollapse,
        laid_out: document.getElementById('d').getBoundingClientRect().height -
                  document.getElementById('d').clientHeight
      })
    JS
    # Chrome reports all four of these for a bare table.
    expect(read.values_at('pad', 'th_pad', 'spacing', 'collapse')).to eq(['1px', '1px', '2px', 'separate'])
    expect(read['laid_out']).to eq(0)   # no borders, so the border box IS the padding box
  end

  it 'stacks two tables as blocks, each shrunk to its own content' do
    body = '<table id="one"><tr><td>first</td></tr></table><table id="two"><tr><td>second</td></tr></table>'
    boxes, text = measure(body, ['#one', '#two'], probes: %w[first second])
    one, two = boxes
    expect(one[2]).to be_within(0.01).of(text['first'] + PAD + SPACING * 2)     # Chrome: 31.78
    expect(two[2]).to be_within(0.01).of(text['second'] + PAD + SPACING * 2)    # Chrome: 57.59
    expect(two[1]).to eq(one[1] + one[3])
  end
end
