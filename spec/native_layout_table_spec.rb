# frozen_string_literal: true
# Native layout — CSS tables (§17), geometry shadow-parity. Increments t1 (base) + t2 (spans) + t3 (collapse) +
# t4 (caption) + t5 (thead/tfoot) + t6 (table-layout:fixed) + t7 (colgroup/<col>) + t8 (imposed height) +
# t9 (anonymous rows) + r2 (rtl tables):
# an auto-layout `display:table` in normal flow, border-collapse SEPARATE or COLLAPSE, LTR or RTL (an rtl table
# MIRRORS its columns — column 0 at the right) — table >
# (table-header-group | table-row-group | table-footer-group | table-row)* > table-cell*. thead / tbody /
# tfoot are sorted into RENDER order (header, body, footer) regardless of source order. Each cell's used border
# box (its spanned column width ×
# row height, halved borders in collapse) is resolved by the oracle and PUSHED (like a flex item); native
# reassembles the column/row tracks from the NON-spanning cells, prefix-sums them with border-spacing to
# position every cell at its (pushed) starting column/row, and derives every row, row-group and the table's
# OWN box. In collapse the whole shared-border model is resolved by the oracle — spacing 0, each cell's halved
# borders in its pushed box, and the table's OWN border set to the outer half of its rim cells' borders with no
# padding — so native lays a collapse table out exactly like a separate one. A single CAPTION (top or bottom) makes the `<table>` box the WRAPPER:
# the caption is a NORMAL BLOCK in the table's content width (§17.4) — declared height / width / min-max /
# box-sizing / auto-margin centering honored, auto width fills the table; a caption with a definite width WIDER
# than the grid floors the table (which stretches its columns to fill it, like an explicit table width) —
# stacked above (the grid offsets down) or below the grid, its own block / text subtree laid out normally.
# colspan/rowspan, ragged grids, border-collapse, thead/tbody/tfoot, table-layout:fixed, colgroup/<col> widths,
# a caption, a position:relative cell (offset ignored), an imposed table height TALLER than the grid (declared /
# attribute / min, shared out over the rows so the tracks fill the box), and ANONYMOUS ROWS (a table-cell with
# no table-row parent) ARE supported. Still DECLINES to JS — a caption with a MARGIN or one that OVERFLOWS the
# table (a %-width wider than the grid; the oracle lays both out correctly, native just declines) or more than
# one caption, an imposed height the tracks DON'T fill (a min-height's empty space, a too-small height /
# max-height below the grid) or one alongside a caption / collapsed border, an anonymous CELL (stray non-cell
# content), an rtl table with a caption or collapsed border (the caption's rtl placement / the frame's
# left-right swap aren't reflected yet), inline-table, nested tables, an empty row group, and a column/row only
# spanning cells cover.
# (A column's visibility:collapse is a conformance gap the oracle itself doesn't model, so native matches it
# rather than bailing.) Each bail is an A/B: the feature-carrying input
# declines, a plain table stays native. A `display:table-cell` with no `display:table-row` parent is wrapped in
# an ANONYMOUS row (t9) and IS supported; stray NON-cell content (which a browser wraps in an anonymous CELL, a
# box the oracle doesn't model) still declines. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout table parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def run_shadow(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a 2x2 table with border-spacing (cells placed by prefix sums)' do
    expect_parity('<table style="border-spacing:4px"><tr><td style="width:60px;height:20px">a</td><td style="width:80px;height:30px">bb</td></tr><tr><td>ccc</td><td style="height:40px">d</td></tr></table>')
  end

  it 'matches a plain 2x2 table (UA border-spacing)' do
    expect_parity('<table><tr><td>a</td><td>bb</td></tr><tr><td>ccc</td><td>d</td></tr></table>')
  end

  it 'matches a single row of three cells with asymmetric border-spacing' do
    expect_parity('<table style="border-spacing:2px 6px"><tr><td style="width:30px">x</td><td style="width:40px">y</td><td style="width:50px">z</td></tr></table>')
  end

  it "matches a table carrying its own padding and border" do
    expect_parity('<table style="border-spacing:4px;padding:10px;border:2px solid"><tr><td style="width:50px">a</td></tr></table>')
  end

  it 'matches a display:table div with bare table-row children (no row group)' do
    expect_parity('<div style="display:table;border-spacing:3px"><div style="display:table-row"><div style="display:table-cell;width:40px">a</div><div style="display:table-cell;width:60px">b</div></div></div>')
  end

  it 'matches a table nested inside a block' do
    expect_parity('<div style="padding:8px"><table style="border-spacing:5px"><tr><td style="width:40px">a</td><td style="width:40px">b</td></tr></table></div>')
  end

  it 'matches a header row of th cells plus a data row' do
    expect_parity('<table style="border-spacing:3px"><tr><th style="width:50px">H1</th><th style="width:70px">H2</th></tr><tr><td>data one</td><td>two</td></tr></table>')
  end

  it 'matches a cell holding its own block subtree (descendant boxes)' do
    expect_parity('<table style="border-spacing:4px"><tr><td style="width:100px"><div style="height:10px;margin:5px"></div><div style="height:20px"></div></td><td style="width:60px;height:50px">x</td></tr></table>')
  end

  it 'matches a table with a declared width (distributed into the columns by the oracle)' do
    expect_parity('<table style="width:300px;border-spacing:4px"><tr><td>a</td><td>b</td></tr></table>')
  end

  it 'matches cells carrying their own padding and border' do
    expect_parity('<table style="border-spacing:4px"><tr><td style="padding:6px;border:2px solid;width:40px">a</td></tr></table>')
  end

  it 'matches a position:relative cell (the offset is ignored, grid-positioned)' do
    expect_parity('<table style="border-spacing:4px"><tr><td style="position:relative;left:10px;top:5px;width:50px;height:30px">a</td><td style="width:60px">b</td></tr></table>')
  end

  # t2 — spans.
  it 'matches a colspan=2 cell over a three-column table' do
    expect_parity('<table style="border-spacing:4px"><tr><td colspan="2" style="height:20px">A</td><td style="width:50px">B</td></tr><tr><td style="width:30px">c</td><td style="width:40px">d</td><td>e</td></tr></table>')
  end

  it 'matches a rowspan=2 cell' do
    expect_parity('<table style="border-spacing:4px"><tr><td rowspan="2" style="width:30px">A</td><td style="width:50px;height:20px">b</td></tr><tr><td style="height:35px">c</td></tr></table>')
  end

  it 'matches a combined colspan=2 rowspan=2 corner cell' do
    expect_parity('<table style="border-spacing:4px"><tr><td colspan="2" rowspan="2" style="width:60px;height:40px">A</td><td style="width:30px">b</td></tr><tr><td style="height:25px">c</td></tr><tr><td style="width:20px">d</td><td>e</td><td>f</td></tr></table>')
  end

  it 'matches a ragged grid (a row missing a trailing cell)' do
    expect_parity('<table style="border-spacing:4px"><tr><td style="width:40px">a</td><td style="width:50px">b</td></tr><tr><td>c</td></tr></table>')
  end

  # t5 — thead / tbody / tfoot. tableGrid sorts the rows into RENDER order (header, body, footer) regardless of
  # source order, and the walk emits the groups in that order; native stacks them like any row groups.
  it 'matches thead / tbody / tfoot in normal source order' do
    expect_parity('<table style="border-spacing:4px"><thead><tr><td style="width:60px;height:10px">h</td></tr></thead><tbody><tr><td style="height:30px">b</td></tr></tbody><tfoot><tr><td style="height:20px">f</td></tr></tfoot></table>')
  end

  it 'matches a tfoot / tbody / thead written OUT of order (rendered header, body, footer)' do
    expect_parity('<table style="border-spacing:4px"><tfoot><tr><td style="width:60px;height:20px">foot</td></tr></tfoot><tbody><tr><td style="height:30px">body</td></tr></tbody><thead><tr><td style="height:10px">head</td></tr></thead></table>')
  end

  it 'matches a thead over two tbody groups' do
    expect_parity('<table style="border-spacing:4px"><thead><tr><td style="width:50px;height:10px">h</td></tr></thead><tbody><tr><td style="height:20px">b1</td></tr></tbody><tbody><tr><td style="height:25px">b2</td></tr></tbody></table>')
  end

  it 'matches thead / tfoot carrying colspans' do
    expect_parity('<table style="border-spacing:4px"><thead><tr><td colspan="2" style="height:10px">H</td></tr></thead><tbody><tr><td style="width:30px">a</td><td style="width:40px">b</td></tr></tbody><tfoot><tr><td colspan="2" style="height:15px">F</td></tr></tfoot></table>')
  end

  # t6 — table-layout:fixed. Columns are sized from the FIRST row (+ the table width), ignoring later rows'
  # content and any cell min/max-width; the whole assignable width is distributed so the columns FILL the table
  # (auto columns split the remainder; with none, it is spread proportionally over the fixed widths). Native
  # reassembles those pushed widths and self-sizes to the same box, as for an auto table.
  it 'matches a fixed-layout table with all-auto columns (equal split of the declared width)' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:4px"><tr><td style="height:20px">a</td><td>b</td></tr></table>')
  end

  it 'matches a fixed-layout table whose fixed columns fill the remainder proportionally (no auto column)' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:4px"><tr><td style="width:50px;height:20px">a</td><td style="width:100px">b</td></tr></table>')
  end

  it 'matches a fixed-layout table with a fixed column and an auto column (auto absorbs the remainder)' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:4px"><tr><td style="width:50px;height:20px">a</td><td>b</td></tr></table>')
  end

  it 'matches a fixed-layout table with percentage column widths (resolved against the assignable width)' do
    expect_parity('<table style="table-layout:fixed;width:304px;border-spacing:0"><tr><td style="width:25%;padding:0;height:20px">a</td><td style="width:75%;padding:0">b</td></tr></table>')
  end

  it 'matches a fixed-layout table whose first row sets the columns (a wider cell in row 2 is ignored)' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:4px"><tr><td style="width:80px;height:20px">a</td><td style="width:120px">b</td></tr><tr><td style="width:500px">x</td><td>y</td></tr></table>')
  end

  it 'matches a fixed-layout table narrower than its columns (it grows to fit them)' do
    expect_parity('<table style="table-layout:fixed;width:50px;border-spacing:4px"><tr><td style="width:100px;height:20px">a</td><td style="width:100px">b</td></tr></table>')
  end

  it 'matches a fixed-layout table with a colspan in the first row setting two columns' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:0"><tr><td colspan="2" style="width:200px;padding:0;height:20px">A</td><td style="width:40px;padding:0">b</td></tr><tr><td>x</td><td>y</td><td>z</td></tr></table>')
  end

  it 'matches a fixed-layout table whose columns all declare width:0 (the width splits equally, Chrome fills)' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:0"><tr><td style="width:0;padding:0;height:20px">a</td><td style="width:0;padding:0">b</td></tr></table>')
  end

  # t7 — colgroup / <col>. A column's declared width / span constrains its track: the oracle folds it into the
  # table's intrinsic width AND the column distribution, so the auto table grows to hold a wide <col> and the
  # cells fill their columns — native reassembles those pushed widths as usual.
  it 'matches an auto-layout table with a <col> width (the table grows to it)' do
    expect_parity('<table style="border-spacing:4px"><colgroup><col style="width:120px"><col></colgroup><tr><td style="height:20px">a</td><td>bbbb</td></tr></table>')
  end

  it 'matches a <colgroup span="2"> width applied to both columns' do
    expect_parity('<table style="border-spacing:4px"><colgroup span="2" style="width:90px"></colgroup><tr><td style="height:20px">a</td><td>b</td></tr></table>')
  end

  it 'matches a <col span="2"> width applied to both columns' do
    expect_parity('<table style="border-spacing:4px"><col span="2" style="width:70px"><tr><td style="height:20px">a</td><td>b</td></tr></table>')
  end

  it 'matches a <col> width overridden by a wider cell width (the larger wins)' do
    expect_parity('<table style="border-spacing:4px"><col style="width:50px"><col><tr><td style="width:150px;height:20px">a</td><td>b</td></tr></table>')
  end

  it 'matches <col> widths in a fixed-layout table' do
    expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:4px"><colgroup><col style="width:80px"><col></colgroup><tr><td style="height:20px">a</td><td>b</td></tr></table>')
  end

  # t8 — imposed table height. A declared / min height TALLER than the grid is shared out over the rows so the
  # tracks FILL the box (Chrome: two 22px rows in a 200px table become 94 each). Native reassembles those grown
  # rows and self-sizes to the same box. Cases where the tracks DON'T fill (min-height empty space, a too-small
  # height / max-height below the grid) — and a caption or collapsed border alongside an imposed height — bail.
  it 'matches a table height taller than the grid (shared out over the rows)' do
    expect_parity('<table style="border-spacing:4px;height:200px"><tr><td style="width:60px;height:20px">a</td></tr><tr><td style="height:20px">b</td></tr></table>')
  end

  it 'matches a table height from the height attribute' do
    expect_parity('<table height="200" style="border-spacing:4px"><tr><td style="width:60px;height:20px">a</td></tr><tr><td style="height:20px">b</td></tr></table>')
  end

  it 'matches a taller declared height distributed over a colspan grid' do
    expect_parity('<table style="border-spacing:4px;height:300px"><tr><td colspan="2" style="height:20px">A</td></tr><tr><td style="width:30px">a</td><td style="width:40px">b</td></tr></table>')
  end

  it 'matches a max-height that exceeds the grid (no effect, rows still fill)' do
    expect_parity('<table style="border-spacing:4px;max-height:300px"><tr><td style="width:60px;height:20px">a</td></tr><tr><td style="height:20px">b</td></tr></table>')
  end

  # t9 — anonymous rows. A `display:table-cell` with no `display:table-row` parent is wrapped in an ANONYMOUS
  # row (consecutive such cells share one row; a real row resets the run). The row has no element/box — the walk
  # emits it with a sentinel nid and the parity compare skips it — but its cells are real and matched.
  it 'matches two table-cells with no row (one anonymous row wraps both)' do
    expect_parity('<div style="display:table;border-spacing:4px"><div style="display:table-cell;width:60px;height:20px">a</div><div style="display:table-cell;width:80px;height:30px">b</div></div>')
  end

  it 'matches a single table-cell with no row' do
    expect_parity('<div style="display:table;border-spacing:4px"><div style="display:table-cell;width:60px;height:20px">a</div></div>')
  end

  it 'matches a real row followed by a stray cell (its own anonymous row)' do
    expect_parity('<div style="display:table;border-spacing:4px"><div style="display:table-row"><div style="display:table-cell;width:60px;height:20px">a</div></div><div style="display:table-cell;width:80px;height:25px">b</div></div>')
  end

  it 'matches a table-cell with no row inside a row-group' do
    expect_parity('<div style="display:table;border-spacing:4px"><div style="display:table-row-group"><div style="display:table-cell;width:60px;height:20px">a</div></div></div>')
  end

  it 'matches anonymous-row cells in a border-collapse table' do
    expect_parity('<div style="display:table;border-collapse:collapse"><div style="display:table-cell;width:60px;height:20px;border:4px solid">a</div><div style="display:table-cell;width:80px;height:20px;border:4px solid">b</div></div>')
  end

  it 'matches cells split into two anonymous rows by a caption / column between them (a proper table child breaks the run)' do
    expect_parity('<div style="display:table;border-spacing:0"><div style="display:table-cell;width:30px;height:40px">a</div><div style="display:table-caption">cap</div><div style="display:table-cell;width:30px;height:40px">b</div></div>')
    expect_parity('<div style="display:table;border-spacing:0"><div style="display:table-cell;width:30px;height:40px">a</div><div style="display:table-column"></div><div style="display:table-cell;width:30px;height:40px">b</div></div>')
  end

  # r2 — rtl tables (column reversal). The columns run RIGHT-to-LEFT: column 0 is at the right edge. The oracle
  # mirrors each cell within the table content box, and native reflects it within its row (row_w - ltr_rel -
  # cell_width); the row / group / table boxes span the whole grid and are direction-agnostic. (An rtl caption
  # or collapsed border still declines — the caption's own rtl placement and the frame's left/right swap aren't
  # reflected yet.)
  it 'matches a 2-column rtl table (column 0 at the right)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches a 3-column rtl table' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><tr><td style="width:30px;height:20px">a</td><td style="width:40px">b</td><td style="width:50px">c</td></tr></table>')
  end

  it 'matches an rtl table with a colspan (reflected by its spanned width)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><tr><td colspan="2" style="height:20px">A</td><td style="width:50px">c</td></tr><tr><td style="width:30px">d</td><td style="width:40px">e</td><td style="width:50px">f</td></tr></table>')
  end

  it 'matches an rtl table with a rowspan' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><tr><td rowspan="2" style="width:30px">A</td><td style="width:50px;height:20px">b</td></tr><tr><td style="height:25px">c</td></tr></table>')
  end

  it 'matches an rtl fixed-layout table (columns mirrored)' do
    expect_parity('<table dir="rtl" style="table-layout:fixed;width:300px;border-spacing:4px"><tr><td style="height:20px">a</td><td>b</td></tr></table>')
  end

  # t3 — border-collapse:collapse (half-borders, spacing 0, the outer half-border frame).
  it 'matches a border-collapse 2x2 with bordered cells' do
    expect_parity('<table style="border-collapse:collapse"><tr><td style="border:4px solid;width:40px;height:20px">a</td><td style="border:4px solid;width:50px">b</td></tr><tr><td style="border:4px solid">c</td><td style="border:4px solid;height:30px">d</td></tr></table>')
  end

  it 'matches a collapsed table with its own border (outer frame inside the table border)' do
    expect_parity('<table style="border-collapse:collapse;border:10px solid"><tr><td style="border:2px solid;width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches a collapsed table with padding' do
    expect_parity('<table style="border-collapse:collapse;padding:10px"><tr><td style="border:4px solid;width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches collapsed cells with unequal borders (shared border = the widest)' do
    expect_parity('<table style="border-collapse:collapse"><tr><td style="border:2px solid;width:40px;height:20px">a</td><td style="border:8px solid;width:50px">b</td></tr></table>')
  end

  # Borders that differ per SIDE — the collapsed edge is grid-aware (widest of the two facing
  # borders across a shared edge, the table's own border at the rim), which the oracle resolves and
  # native reassembles from the pushed halved cell edges + the pushed outer-half table border.
  it 'matches collapsed cells whose borders differ per side' do
    expect_parity('<table style="border-collapse:collapse"><tr><td style="border-left:2px solid;border-right:10px solid;width:60px;height:20px;padding:0">a</td><td style="border-left:6px solid;border-right:4px solid;width:80px;padding:0">b</td></tr></table>')
  end

  it 'matches per-side collapsed borders down a column (top/bottom)' do
    expect_parity('<table style="border-collapse:collapse"><tr><td style="border-top:2px solid;border-bottom:10px solid;width:40px;height:20px;padding:0">a</td></tr><tr><td style="border-top:6px solid;border-bottom:4px solid;width:40px;height:30px;padding:0">b</td></tr></table>')
  end

  it 'matches a collapsed rowspan cell facing two different neighbours (widest wins)' do
    expect_parity('<table style="border-collapse:collapse"><tr><td rowspan="2" style="border-left:2px solid;border-right:4px solid;width:30px;padding:0">a</td><td style="border-left:20px solid;border-right:6px solid;width:40px;padding:0">b</td></tr><tr><td style="border-left:8px solid;border-right:6px solid;width:40px;padding:0">c</td></tr></table>')
  end

  it 'matches a collapse table that ignores its own padding and collapses its own border' do
    expect_parity('<table style="border-collapse:collapse;padding:10px;border:4px solid"><tr><td style="border:2px solid;width:40px;padding:0">a</td><td style="border:2px solid;width:40px;padding:0">b</td></tr></table>')
  end

  # border-style:hidden SUPPRESSES a collapsed edge (§17.6.2.1) — a cell hidden edge, and the table's own.
  it 'matches a collapse table with a border-style:hidden cell edge' do
    expect_parity('<table style="border-collapse:collapse"><tr><td style="border:2px solid;border-right:10px hidden;width:60px;padding:0">a</td><td style="border:2px solid;border-left:10px solid;width:60px;padding:0">b</td></tr></table>')
  end

  it 'matches a collapse table whose own border is border-style:hidden' do
    expect_parity('<table style="border-collapse:collapse;border-left:20px hidden"><tr><td style="border:4px solid;width:40px;padding:0">a</td></tr></table>')
  end

  it 'matches a rim cell whose hidden edge suppresses the table border' do
    expect_parity('<table style="border-collapse:collapse;border:20px solid"><tr><td style="border:4px solid;border-left:4px hidden;width:50px;height:20px;padding:0">a</td></tr></table>')
  end

  it 'matches a spanning cell with one hidden facing segment' do
    expect_parity('<table style="border-collapse:collapse"><tr><td colspan="2" style="border:4px solid;width:80px;padding:0">A</td></tr><tr><td style="border-top:20px hidden;width:40px;padding:0">b</td><td style="border-top:10px solid;width:40px;padding:0">c</td></tr></table>')
  end

  it 'matches border-collapse with a colspan' do
    expect_parity('<table style="border-collapse:collapse"><tr><td colspan="2" style="border:3px solid">A</td></tr><tr><td style="border:3px solid;width:30px">b</td><td style="border:3px solid;width:40px">c</td></tr></table>')
  end

  it 'matches border-collapse with a rowspan' do
    expect_parity('<table style="border-collapse:collapse"><tr><td rowspan="2" style="border:3px solid;width:30px">A</td><td style="border:3px solid;height:20px">b</td></tr><tr><td style="border:3px solid;height:25px">c</td></tr></table>')
  end

  # t4 — the caption (a single block box, top or bottom). The `<table>` el._lb is the WRAPPER (caption + grid):
  # a top caption offsets the grid down by its own height, a bottom one sits below it, and a wider caption
  # widens the wrapper. The caption's own block / text subtree lays out normally.
  it 'matches a caption above the grid (default caption-side)' do
    expect_parity('<table style="border-spacing:4px"><caption style="height:16px">Cap</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches a caption below the grid (caption-side:bottom)' do
    expect_parity('<table style="border-spacing:4px;caption-side:bottom"><caption style="height:16px">Cap</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches a caption wider than the grid (the wrapper widens to the caption)' do
    expect_parity('<table style="border-spacing:4px"><caption style="height:16px;width:300px">Wide</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption on a table carrying its own border' do
    expect_parity('<table style="border-spacing:4px;border:6px solid"><caption style="height:16px">c</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption on a border-collapse table' do
    expect_parity('<table style="border-collapse:collapse"><caption style="height:16px">c</caption><tr><td style="border:4px solid;width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption with a wrapping text / block subtree of its own' do
    expect_parity('<table style="border-spacing:4px"><caption><div style="height:10px;margin:3px"></div><div style="height:8px"></div></caption><tr><td style="width:50px;height:20px">x</td></tr></table>')
  end

  it 'matches a position:relative caption (its paint-time offset shifts the box, Chrome: top:5/left:7 -> {7,5})' do
    expect_parity('<table style="border-spacing:4px"><caption style="height:16px;position:relative;top:5px;left:7px">c</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  it 'matches a position:relative caption below the grid' do
    expect_parity('<table style="border-spacing:4px;caption-side:bottom"><caption style="height:16px;position:relative;left:11px">c</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  # A caption is a normal block in the table's content width (§17.4): declared height / width / min-max /
  # box-sizing / auto-margin centering honored, auto width fills the table, and a caption with a definite width
  # wider than the grid floors the table (stretching its columns to fill it).
  it 'matches a caption honoring a declared height (content overflows the box)' do
    expect_parity('<table style="border-spacing:4px"><caption style="height:40px">Cap</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption floored by min-height and capped by max-height' do
    expect_parity('<table style="border-spacing:4px"><caption style="min-height:50px">Cap</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
    expect_parity('<table style="border-spacing:4px"><caption style="max-height:8px">Cap</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption narrower than the grid (declared width honored, table unchanged)' do
    expect_parity('<table style="border-spacing:4px"><caption style="width:20px">Cap</caption><tr><td style="width:200px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption wider than the grid (the table grows and its columns stretch to fill it)' do
    # A definite (length / min-width) caption width floors the table via tableIntrinsicWidths, so the columns
    # STRETCH to fill it (Chrome: a 300px caption over a 156px grid stretches the two columns to 124/164).
    expect_parity('<table style="border-spacing:4px"><caption style="width:300px">Cap</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
    expect_parity('<table style="border-spacing:4px"><caption style="min-width:300px">Cap</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches a caption whose max-width caps both the caption and the table it floors' do
    expect_parity('<table style="border-spacing:4px"><caption style="width:300px;max-width:200px">Cap</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches a caption where min-width beats a smaller max-width (§10.4: min wins the contradiction)' do
    expect_parity('<table style="border-spacing:4px"><caption style="min-width:300px;max-width:200px">Cap</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches a caption wider than an explicitly-narrow table (the table grows past its declared width, §17.5.2)' do
    expect_parity('<table style="width:100px;border-spacing:4px"><caption style="width:300px">Cap</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption with a percentage width narrower than the table (resolved against the table width)' do
    expect_parity('<table style="border-spacing:4px"><caption style="width:50%">Cap</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption with box-sizing and its own padding' do
    expect_parity('<table style="border-spacing:4px"><caption style="box-sizing:border-box;width:100px;padding:10px">Cap</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
    expect_parity('<table style="border-spacing:4px"><caption style="width:100px;padding:10px">Cap</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  # A/B bails — the feature declines; a plain table stays native.
  def a_bails_b_native(feature, plain = '<table style="border-spacing:4px"><tr><td style="width:40px">a</td><td style="width:40px">b</td></tr></table>')
    expect(run_shadow(feature)['ok']).to be(false), "expected #{feature.inspect} to bail"
    expect(run_shadow(plain)['ok']).to be(true), 'expected the plain table to stay native'
  end

  it('declines a caption with a margin (folds into the stacking)') { a_bails_b_native('<table style="border-spacing:4px"><caption style="height:16px;margin:5px">c</caption><tr><td style="width:40px">a</td></tr></table>') }
  it('declines a caption that overflows the table (a %-width wider than the grid — the table does not grow)') { a_bails_b_native('<table style="border-spacing:4px"><caption style="width:120%">c</caption><tr><td style="width:40px">a</td></tr></table>') }
  it('declines two captions') { a_bails_b_native('<table style="border-spacing:4px"><caption>top</caption><caption style="caption-side:bottom">bottom</caption><tr><td style="width:40px">a</td></tr></table>') }
  it('declines inline-table') { a_bails_b_native('<span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">a</span></span></span>') }
  it('declines an rtl table with a caption (the caption\'s own rtl placement is not reflected yet)') { a_bails_b_native('<table dir="rtl" style="border-spacing:4px"><caption style="height:16px">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>') }
  it('declines an rtl border-collapse table (the outer frame left/right swap is not reflected yet)') { a_bails_b_native('<table dir="rtl" style="border-collapse:collapse"><tr><td style="border:2px solid;width:40px;height:20px">a</td></tr></table>') }
  it('declines a table with a declared height below its natural grid (the tracks overflow it)') { a_bails_b_native('<table style="height:10px;border-spacing:4px"><tr><td style="height:50px">a</td></tr></table>') }
  it('declines a table with a min-height that leaves empty space below the tracks') { a_bails_b_native('<table style="min-height:200px"><tr><td style="height:50px">a</td></tr></table>') }
  it('declines a table with a max-height below its natural grid') { a_bails_b_native('<table style="max-height:10px;border-spacing:4px"><tr><td style="height:50px">a</td></tr></table>') }
  it('declines an imposed table height alongside a caption') { a_bails_b_native('<table style="border-spacing:4px;height:200px"><caption style="height:16px">c</caption><tr><td style="height:20px">a</td></tr></table>') }
  it('declines an imposed table height on a collapsed table') { a_bails_b_native('<table style="border-collapse:collapse;height:200px"><tr><td style="border:2px solid;height:20px">a</td></tr></table>') }
  it('declines an empty row group (the oracle boxes it below the grid)') { a_bails_b_native('<table style="border-spacing:4px"><tbody></tbody><tbody><tr><td style="width:40px;height:20px">a</td></tr></tbody></table>') }
  it('declines stray non-cell content in a table (an anonymous CELL, which the oracle does not model)') { a_bails_b_native('<div style="display:table;border-spacing:4px"><div style="display:block;width:60px;height:20px">a</div></div>') }
  it('declines a same-display group NESTED in another (its rows interleave in render order)') { a_bails_b_native('<div style="display:table;border-spacing:4px"><div style="display:table-row-group"><div style="display:table-row"><div style="display:table-cell;width:40px;height:20px">r1</div></div><div style="display:table-row-group"><div style="display:table-row"><div style="display:table-cell;height:18px">r2</div></div></div><div style="display:table-row"><div style="display:table-cell;height:36px">r3</div></div></div></div>') }
  it('declines a column that only spanning cells cover (no single-column cell to size it)') { a_bails_b_native('<table style="border-spacing:4px"><tr><td colspan="2">A</td><td style="width:20px">b</td></tr><tr><td style="width:30px">c</td><td colspan="2">DE</td></tr></table>') }
end
