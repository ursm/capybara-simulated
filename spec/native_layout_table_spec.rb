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
# OWN box. In collapse the whole shared-border model (§17.6.2.1) is resolved by the oracle — spacing 0, each
# edge as wide as the WIDEST declaration meeting on it (cells AND tr / row-group / col / colgroup / table
# borders all participate), border-style:hidden SUPPRESSING the edge entirely, each cell's halved result in its
# pushed box, and the table's OWN border set to the outer half of its rim's borders with no padding — so native
# lays a collapse table out exactly like a separate one. A single CAPTION (top or bottom) makes the `<table>` box the WRAPPER:
# the caption is a NORMAL BLOCK in the table's BORDER box (§17.4 wrapper box), OUTSIDE the table's own border +
# padding — declared height / width / min-max / box-sizing / auto-margin centering honored, auto width fills the
# border box; a caption with a definite width WIDER than the grid floors the table's BORDER box (which stretches
# its columns to fill what is left inside the border, like an explicit table width) — stacked above (the grid
# offsets down past it) or below the grid, its own block / text subtree laid out normally.
# colspan/rowspan, ragged grids, border-collapse, thead/tbody/tfoot, table-layout:fixed, colgroup/<col> widths,
# a caption — its MARGINS included since 2026-09-23: the vertical pair is height the rows do not get, the
# LEADING horizontal one insets it from the wrapper's inline-start edge (the right edge in rtl), an `auto` pair
# centres it, and the basis-less pair floors the table's width beside the caption's min-content —
# a position:relative cell (offset ignored), an imposed table height TALLER than the grid (declared /
# attribute / min, shared out over the rows so the tracks fill the box), ANONYMOUS ROWS (a table-cell with
# no table-row parent), an OUT-OF-FLOW child of the table / a row group / a row (§9.7 takes it out of the
# table's structure: the oracle places every one at the grid's top-left corner, so the walk emits them all
# under the TABLE record), an EMPTY table (no rows and no columns — the clearfix pseudo: its edges, its
# declaration and its caption are the whole box) and a cell laid out TWICE for its PERCENTAGE-height
# descendants (§17.5.3: pass 1 sizes it with them treated as auto, pass 2 lays it out again at the final ROW
# height, which is the only basis they may have) ARE supported. Still DECLINES to JS — more than one caption,
# a HALF-empty table (columns with no rows), an
# imposed height the tracks DON'T fill (a min-height's empty space, a too-small height /
# max-height below the grid) or one alongside a caption / collapsed border,
# nested tables, an empty row group, and a column/row only
# spanning cells cover.
# (A column's visibility:collapse is a conformance gap the oracle itself doesn't model, so native matches it
# rather than bailing.) Each bail is an A/B: the feature-carrying input
# declines, a plain table stays native. A `display:table-cell` with no `display:table-row` parent is wrapped in
# an ANONYMOUS row (t9) and IS supported, and so is stray NON-cell content — the anonymous CELL a browser wraps
# it in gets the same sentinel: laid out, not compared, its real children compared as usual. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'
require_relative 'support/walk_refusals'

RSpec.describe 'native layout table parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # `opts` is the second argument of `__csimLayoutShadowRun`, as JS source (`{noOracle: true}` hides the oracle's stamps).
  def run_shadow(body, opts = '{}')
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script("globalThis.__csimLayoutShadowRun(undefined, #{opts})")
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect_no_dropped_records(r, body)
  end

  # An EMPTY table — `display: table` with nothing in it, which a `::before { content: ""; display: table }`
  # produces all over real stylesheets (the clearfix). It has no grid at all: its border box is its own edges
  # plus whatever it declares, a caption stacks on top of that, and an imposed height still makes the empty
  # grid REGION that tall (§17.5.3 — a table height is a minimum, with or without rows to share it out).
  # `border-spacing` says nothing without tracks to space. The figures are headless Chrome's, measured
  # 2026-09-22, because parity alone cannot tell a shared rule from a shared mistake.
  it 'matches an empty table, and sizes it as Chrome does' do
    {
      'display:table'                         => [0, 0],
      'display:table;border:2px solid;padding:3px' => [10, 10],
      'display:table;border-spacing:7px'      => [0, 0],
      'display:table;width:120px;height:30px' => [120, 30],
      'display:table;min-height:40px'         => [0, 40]
    }.each do |style, (w, h)|
      body = %(<div id="t" style="#{style}"></div>)
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      box = session.evaluate_script("(() => { const r = document.getElementById('t').getBoundingClientRect(); return [r.width, r.height]; })()")
      expect(box).to eq([w, h]), style
    end
  end

  it 'matches an empty table with a caption (the caption is the whole box)' do
    expect_parity('<div style="display:table"><div style="display:table-caption">cap</div></div>')
    expect_parity('<div style="display:table;height:100px"><div style="display:table-caption">cap</div></div>')
    expect_parity('<div style="display:table;table-layout:fixed;width:150px"></div>')
  end

  # …and an empty table on a LINE, which is the one shape where a table's BASELINE has nothing behind the
  # caption to answer first. A caption gives its table no baseline at all (§17.4 puts it outside the table box;
  # §10.8.1 reads an inline-table's from its first ROW), so an empty one hangs from its bottom margin edge and
  # the line is 22 — Chrome's figure, measured 2026-09-23, and the reason the ORACLE was the engine that moved:
  # it took the caption's baseline and made the line 18. Pinned to Chrome because both engines now agree.
  it 'gives an empty table with a caption NO baseline (Chrome: the line is 22, not 18)' do
    body = '<div id="l" style="width:300px">x <span style="display:inline-table"><span style="display:table-caption">cap</span></span> y</div>'
    expect_parity(body)
    session = simulated_session(page(body))
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('l').getBoundingClientRect().height")).to eq(22)
    # …and the same through a baseline-aligned CELL, which reaches the walk by a different route.
    expect_parity('<table style="border-spacing:0"><tr><td style="vertical-align:baseline"><div style="display:table"><div style="display:table-caption;height:16px">cap</div></div></td><td style="vertical-align:baseline;font-size:30px">Y</td></tr></table>')
    # …while a table WITH rows still answers from them (Chrome: 36 and 46).
    expect_parity('<div style="width:300px">x <span style="display:inline-table"><span style="display:table-caption">cap</span><span style="display:table-row"><span style="display:table-cell">a</span></span></span> y</div>')
  end

  # A caption is the one block-level box in the engine that does NOT go through `block_child_width`: the oracle
  # sizes it with `usedSize`, which honours an intrinsic-size KEYWORD and nothing else that makes a block size
  # from its own content. Native ran it through `used_width` alone, which knows no keyword, and filled the
  # wrapper — 300 where the oracle and Chrome say 37.33. The `auto` margins then had nothing left to centre.
  it 'matches a caption sized by an intrinsic-size keyword (Chrome: min-content is 37.33 in a 300px table)' do
    [
      'width:min-content', 'width:max-content', 'width:fit-content',
      'width:min-content;margin:0 auto', 'width:min-content;margin:0 10px',
      'width:max-content;padding:0 10%', 'width:min-content;box-sizing:border-box;padding:0 5px',
      'width:min-content;min-width:200px', 'width:fit-content;max-width:30px'
    ].each do |cap|
      ['width:300px;border-spacing:0', 'border-spacing:4px', 'width:60px;border-spacing:0'].each do |tbl|
        expect_parity(%(<table style="#{tbl}"><caption id="c" style="#{cap}">hello world</caption><tr><td style="width:40px;height:20px">a</td></tr></table>))
      end
    end
    body = '<table style="width:300px;border-spacing:0"><caption id="c" style="width:min-content;height:16px">hello world</caption><tr><td style="width:40px;height:20px">a</td></tr></table>'
    session = simulated_session(page(body))
    session.visit '/'
    box = session.evaluate_script("(() => { const r = document.getElementById('c').getBoundingClientRect(); return [r.x, r.width]; })()")
    expect(box).to eq([0, 37.328125])
  end

  # …but a VERTICAL writing mode's auto width is not one of them: `block_child_width` would shrink it and
  # `usedSize` does not, so a vertical-rl caption fills the wrapper in both engines. A divergence from Chrome
  # they SHARE, recorded rather than fixed while the port runs — and the reason the caption is not simply
  # routed through `block_child_width`.
  it 'keeps a vertical writing-mode caption filling the wrapper (shared with the oracle, not with Chrome)' do
    expect_parity('<table style="width:300px;border-spacing:0"><caption style="writing-mode:vertical-rl">hello world</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches an empty table as a flex item and in block flow (its margins still stack)' do
    expect_parity('<div style="display:flex;width:300px"><div style="display:table"></div><div>y</div></div>')
    expect_parity('<div style="width:400px"><div style="display:table;margin:10px;width:50px;height:20px"></div><p>after</p></div>')
  end

  # …and a HALF-empty table still declines: columns with no rows under them reach a grid native does not build.
  it('declines a table with columns but no rows') { a_bails_b_native('<table style="border-spacing:4px"><colgroup><col style="width:40px"><col style="width:60px"></colgroup></table>') }

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

  # vertical-align (§17.5.3): a short cell beside a taller one has its content pushed down — the UA default is
  # middle, and top/bottom are honored. Native lays cell content top-aligned then applies the oracle's pushed
  # offset, so the descendant boxes match.
  it 'matches vertical-aligned cell content in a taller row (middle default, and explicit top/bottom)' do
    expect_parity('<table style="border-spacing:4px"><tr><td style="width:20px;vertical-align:top"><div style="width:20px;height:40px"></div></td><td style="width:20px"><div style="width:20px;height:10px"></div></td><td style="width:20px;vertical-align:bottom"><div style="width:20px;height:12px"></div></td></tr></table>')
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

  # t8 — imposed table height. A declared or MIN height TALLER than the grid is shared out over the rows so the
  # tracks FILL the box (Chrome: two 22px rows in a 200px table become 94 each). Native reassembles those grown
  # rows and self-sizes to the same box (a too-small height / min-height just floors it — the box grows to the
  # tracks). A `max-height` below the grid, and a caption or collapsed border alongside an imposed height, bail.
  it 'matches a table height taller than the grid (shared out over the rows)' do
    expect_parity('<table style="border-spacing:4px;height:200px"><tr><td style="width:60px;height:20px">a</td></tr><tr><td style="height:20px">b</td></tr></table>')
  end

  it 'matches a MIN-height taller than the grid (shared out over the rows too)' do
    expect_parity('<table style="min-height:200px"><tr><td style="height:50px">a</td></tr></table>')
  end

  it 'matches a table whose declared height is BELOW its natural grid (the box grows to the tracks)' do
    expect_parity('<table style="height:10px;border-spacing:4px"><tr><td style="height:50px">a</td></tr></table>')
  end

  it 'matches a table whose MAX-height is below its natural grid (max-height never clips a table)' do
    expect_parity('<table style="max-height:10px;border-spacing:4px"><tr><td style="height:50px">a</td></tr></table>')
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

  # …and an anonymous row TAKES ITS SHARE of a declared table height's surplus, in proportion to its height like any
  # auto row: a `display: flex` `<tr>` is no row, so the table wraps it in an anonymous row and cell, and the rows
  # split 154 as 77 / 77 (content 24 / 24) or 104.05 / 49.95 (50 / 24). Native gave the anonymous row its content
  # height and the last row everything (130, 104) until 2026-09-25: the record left the row's PERCENTAGE slot at 0,
  # a declared `0%`, which is a fixed track. Chrome's boxes, and the oracle's.
  it 'shares a declared table height out over an anonymous row' do
    {
      '<tr style="display:flex"><td>c</td></tr><tr id="m"><td>b</td></tr>'                          => [81, 77],
      '<tr style="height:50%;display:flex;align-items:end"><td>c</td></tr><tr id="m"><td>b</td></tr>' => [81, 77],
      '<tr style="height:50px;display:flex"><td>c</td></tr><tr id="m"><td>b</td></tr>'                => [108.05, 49.95]
    }.each do |rows, (y, h)|
      body = %(<div style="font:16px monospace;width:300px"><table style="height:160px">#{rows}</table></div>)
      expect_parity(body)
      got = laid_out_rect(body)
      expect(got[1]).to be_within(0.01).of(y), body
      expect(got[3]).to be_within(0.01).of(h), body
    end
  end
  # …and so does an ATOMIC in an anonymous cell's MIXED run, whose record hangs under the run's anonymous group rather
  # than under the cell: its `height: 50%` rode the record resolved against the oracle's final cell (53.33), which the
  # cell's first pass could not treat as auto, and native's rows came out 123.84 / 36.16 where the oracle and Chrome
  # split 160 as 106.67 / 53.33. Chrome's boxes (53.33 tall at the row's top). Inside a flex item too, which the flex
  # gate pushed until 2026-09-25: a stray box under a table read as the walk's.
  it 'gives an atomic in an anonymous cell\'s mixed run the cell as its basis' do
    run = '<div style="display:table-row"><div style="display:table-cell">c</div>tx <span id="m" style="display:inline-block;height:50%">ib</span><div>blk</div></div>'
    body = %(<div style="font:16px monospace;width:300px"><div style="display:table;height:160px">#{run}<div style="display:table-row"><div style="display:table-cell">b</div></div></div></div>)
    expect_parity(body)
    expect(laid_out_rect(body)[3]).to be_within(0.01).of(53.33)
    r = run_shadow(%(<div style="font:16px monospace;display:flex;width:300px;height:250px"><div>#{body}</div><div>y</div></div>))
    expect(r).to include('ok' => true, 'mismatches' => 0), r.inspect
    expect(r['nativeFlexRows']).to eq(1), r.inspect
  end

  # A PUSHED table's box is the oracle's, and where the oracle laid it out at its own AUTO height (`pushed_h_indefinite`,
  # rec[65] bit 17) its percentage ROWS met no basis: native shared that figure out as the rows' basis, and a `height:
  # 50%` row of a 70px flex-item table came out 35 + 46 = 81 where the oracle and Chrome say 70 (24 + 46). A min-height
  # is still the basis, as it is an auto table's. The flex items here are pushed by the `%` row itself.
  it 'gives a pushed auto-height table\'s percentage rows no basis' do
    table = '<table id="m" style="border-spacing:0"><tr style="height:50%"><td>t</td></tr><tr><td>t2<br>t3</td></tr></table>'
    [
      %(<div style="font:16px monospace"><div style="display:flex;width:300px">#{table}</div></div>),
      %(<div style="font:16px monospace"><div style="display:flex;flex-direction:column;width:300px">#{table}</div></div>)
    ].each do |body|
      expect_parity(body)
      expect(laid_out_rect(body)[3]).to eq(70), body
    end
    expect_parity('<div style="font:16px monospace"><div style="display:flex;width:300px"><table style="border-spacing:2px;min-height:120px"><tr style="height:50%"><td>t</td></tr><tr><td>t2<br>t3</td></tr></table></div></div>')
  end

  # r2 — rtl tables (column reversal). The columns run RIGHT-to-LEFT: column 0 is at the right edge. The oracle
  # mirrors each cell within the table content box, and native reflects it within its row (row_w - ltr_rel -
  # cell_width); the row / group / table boxes span the whole grid and are direction-agnostic. A FULL-WIDTH
  # caption sits at the same left edge in either direction, and native mirrors a NARROWER rtl caption to the
  # inline-start = right (`wrapper_width - caption_width`), one LEADING margin — the right one — further in.
  it 'matches a 2-column rtl table (column 0 at the right)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches an rtl table with a FULL-WIDTH caption (a caption is left-flush both ways)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><caption style="height:16px">c</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches an rtl table with a NARROWER caption (at the inline-start = right edge)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><caption style="width:40px;height:16px">c</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
  end

  it 'matches an rtl table with a NARROWER bottom caption (inline-start = right, below the grid)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px;caption-side:bottom"><caption style="width:40px;height:16px">c</caption><tr><td style="width:60px;height:20px">a</td><td style="width:80px">b</td></tr></table>')
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

  it 'matches a rowspan cell joining its first row baseline group (its baseline is the deepest)' do
    expect_parity('<table style="border-collapse:collapse"><tr><td rowspan="2" style="vertical-align:baseline;font:40px monospace;padding:0">Ay</td><td style="vertical-align:baseline;font:16px monospace;padding:0">Ay</td></tr><tr><td style="padding:0">x</td></tr></table>')
  end

  it 'matches an rtl fixed-layout table (columns mirrored)' do
    expect_parity('<table dir="rtl" style="table-layout:fixed;width:300px;border-spacing:4px"><tr><td style="height:20px">a</td><td>b</td></tr></table>')
  end

  # An rtl border-COLLAPSE table resolves its frame with the columns mirrored: the physical `border-left`
  # collapses with the HIGHEST-index column and `border-right` with column 0, so an asymmetric left/right frame
  # (or asymmetric cell borders) lands the wide half on the opposite cell from LTR (§17.6.2). The oracle now
  # resolves that (matched to Chrome), and native reproduces the pushed edges.
  it 'matches an rtl border-collapse table with an asymmetric frame' do
    expect_parity('<table dir="rtl" style="border-collapse:collapse;border-left:10px solid;border-right:2px solid"><tr><td style="width:40px;height:20px">a</td><td style="width:60px">b</td></tr></table>')
  end

  it 'matches an rtl border-collapse table with asymmetric cell borders' do
    expect_parity('<table dir="rtl" style="border-collapse:collapse"><tr><td style="border-left:8px solid;border-right:1px solid;width:40px;height:20px">a</td><td style="border-left:1px solid;border-right:6px solid;width:60px">b</td></tr></table>')
  end

  it 'matches an rtl border-collapse table with a rowspan and an asymmetric frame' do
    expect_parity('<table dir="rtl" style="border-collapse:collapse;border-left:12px solid;border-right:2px solid"><tr><td rowspan="2" style="width:30px;height:20px">A</td><td style="width:50px">b</td></tr><tr><td style="height:20px">c</td></tr></table>')
  end

  it 'matches an rtl border-collapse table with a colspan and an asymmetric frame' do
    expect_parity('<table dir="rtl" style="border-collapse:collapse;border-left:10px solid;border-right:2px solid"><tr><td colspan="2" style="height:20px">A</td></tr><tr><td style="width:30px">d</td><td style="width:40px">e</td></tr></table>')
  end

  # A `<col>` / `<colgroup>` border participates in the collapse on its PHYSICAL grid line, which the rtl mirror
  # also flips: a `<col>`'s physical border-left / -right and a childless `<colgroup span=N>`'s outer rims land
  # on the opposite columns from LTR.
  it 'matches an rtl border-collapse table with a bordered <col>' do
    expect_parity('<table dir="rtl" style="border-collapse:collapse"><colgroup><col style="border-left:8px solid;border-right:2px solid"><col style="border-left:1px solid;border-right:6px solid"></colgroup><tr><td style="width:40px;height:20px">a</td><td style="width:50px">b</td></tr></table>')
  end

  it 'matches an rtl border-collapse table with a childless <colgroup span=2> frame' do
    expect_parity('<table dir="rtl" style="border-collapse:collapse"><colgroup span="2" style="border-left:10px solid;border-right:2px solid"></colgroup><tr><td style="width:40px;height:20px">a</td><td style="width:50px">b</td></tr></table>')
  end

  it 'matches a bordered <colgroup> that defines its columns through <col> children' do
    expect_parity('<table style="border-collapse:collapse"><colgroup style="border-left:8px solid;border-right:4px solid"><col><col></colgroup><tr><td style="width:40px;height:20px">a</td><td style="width:50px">b</td></tr></table>')
    expect_parity('<table dir="rtl" style="border-collapse:collapse"><colgroup style="border-left:8px solid;border-right:4px solid"><col><col></colgroup><tr><td style="width:40px;height:20px">a</td><td style="width:50px">b</td></tr></table>')
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

  # Structural (tr / row-group / col / colgroup) borders participate in the collapsed width (§17.6.2.1); native
  # reassembles from the oracle-resolved cell boxes + the outer-half frame, both of which fold them in.
  it 'matches a table with a row border on the inter-row edge' do
    expect_parity('<table style="border-collapse:collapse"><tr style="border-bottom:20px solid"><td style="border:2px solid;width:40px;height:20px;padding:0">a</td></tr><tr><td style="border:2px solid;width:40px;height:20px;padding:0">b</td></tr></table>')
  end

  it 'matches a table with a <col> border on the inter-column edge' do
    expect_parity('<table style="border-collapse:collapse"><colgroup><col style="border-right:20px solid"><col></colgroup><tr><td style="border:2px solid;width:40px;padding:0">a</td><td style="border:2px solid;width:40px;padding:0">b</td></tr></table>')
  end

  it 'matches a table with a row-group border and a row border on the outer rim' do
    expect_parity('<table style="border-collapse:collapse"><tbody style="border-top:16px solid"><tr style="border-left:12px solid"><td style="border:2px solid;width:40px;height:20px;padding:0">a</td><td style="border:2px solid;width:40px;padding:0">b</td></tr></tbody></table>')
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

  # A caption spans the table's BORDER box, OUTSIDE the table's own border+padding (§17.4 wrapper box) — so a
  # definite caption WIDER than the grid floors the BORDER box to the caption (the columns then fill what is
  # left inside the border+padding), not the content box to the caption plus the border on top.
  it 'matches a wide caption flooring a bordered table border box' do
    expect_parity('<table style="border-spacing:0;border:10px solid"><caption style="height:16px;width:300px">Wide</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  # A PERCENTAGE caption is a fraction of that border box, and floors nothing (it is indefinite while the table's
  # width is being decided): one over 100% overflows the table without growing it — by a sub-pixel amount too,
  # where a union with the caption's box would round the wrapper up to it.
  it 'matches a caption overflowing the table (a %-width wider than the border box — the table does not grow)' do
    expect_parity('<table style="border-spacing:4px"><caption style="width:120%">c</caption><tr><td style="width:40px">a</td></tr></table>')
    expect_parity('<table style="width:200px;border-spacing:0"><caption style="height:16px;width:100.2%">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
    expect_parity('<table dir="rtl" style="border-spacing:4px"><caption style="width:150%">c</caption><tr><td style="width:40px">a</td></tr></table>')
  end

  it 'matches a caption on a table carrying its own padding (spans the border box)' do
    expect_parity('<table style="border-spacing:0;padding:12px"><caption style="height:16px">c</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
  end

  it 'matches a bottom caption clearing a bordered table bottom border' do
    expect_parity('<table style="border-spacing:0;border:8px solid;caption-side:bottom"><caption style="height:16px">c</caption><tr><td style="width:60px;height:20px">a</td></tr></table>')
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

  # A caption's PERCENTAGE heights resolve against nothing — the table's height is not its containing block's —
  # whatever that height is, clamped or zero (Chrome: 18 tall, the content's, in every one of these). Parity alone
  # was blind here once both engines agreed on a basis, so the Chrome figure is pinned too.
  it 'keeps a percentage-height caption its content height (Chrome: 18)' do
    [
      '<table style="height:200px;border-spacing:2px"><caption id="c" style="height:50%">cap</caption><tr><td>a</td></tr></table>',
      '<table style="height:200px;max-height:100px;border-spacing:2px"><caption id="c" style="height:10%">cap</caption><tr><td>a</td></tr></table>',
      '<table style="height:0;border-spacing:2px"><caption id="c" style="height:50%;min-height:50%">cap</caption><tr><td>a</td></tr></table>',
      '<div style="height:300px"><table style="height:100%;border-spacing:2px"><caption id="c" style="min-height:40%">cap</caption><tr><td>a</td></tr></table></div>'
    ].each do |body|
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      expect(session.evaluate_script("document.getElementById('c').getBoundingClientRect().height")).to eq(18), body
    end
  end

  # A caption MARGIN (native's own since 2026-09-23). Three separate things come off it, and each of these
  # shapes is here because it is the only one that fails when its own half is missing:
  #   * the VERTICAL pair stacks — it is height the rows do not get, so a top caption's `margin-bottom` pushes
  #     the grid down and the wrapper grows by the whole margin box (`caption_h`);
  #   * the LEADING horizontal one insets the caption from the wrapper's inline-start edge, which is the right
  #     edge in rtl — so an rtl lead is measured from the other side and a full-width caption shows nothing;
  #   * an `auto` pair centres it in the wrapper and a single `auto` pushes it to the far side (§10.3.3), which
  #     is `auto_margin_split` and not the margin at all.
  # …and the basis-less pair floors the table beside the caption's min-content (`caption_floor`): the table can
  # be no narrower than the caption's MARGIN box, so margins on a caption already at the floor WIDEN the table.
  it 'matches a caption with a length margin (its margin box stacks, the lead insets it)' do
    expect_parity('<table style="border-spacing:4px"><caption style="height:16px;margin:5px 9px 7px 13px">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
    expect_parity('<table style="border-spacing:4px;caption-side:bottom"><caption style="height:16px;margin:5px 9px 7px 13px">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches a caption whose margin box WIDENS the table (the floor is the margin box)' do
    expect_parity('<table style="border-spacing:0"><caption style="height:16px;width:120px;margin:0 20px">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  it 'matches an auto-margin caption (centred, and pushed by a single auto)' do
    expect_parity('<table style="border-spacing:4px"><caption style="width:40px;height:16px;margin:0 auto">c</caption><tr><td style="width:200px;height:20px">a</td></tr></table>')
    expect_parity('<table style="border-spacing:4px"><caption style="width:40px;height:16px;margin-left:auto">c</caption><tr><td style="width:200px;height:20px">a</td></tr></table>')
  end

  it 'matches an rtl caption offset by a margin (the lead is the RIGHT margin)' do
    expect_parity('<table dir="rtl" style="border-spacing:4px"><caption style="width:20px;height:16px;margin-left:8px">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
    expect_parity('<table dir="rtl" style="border-spacing:4px"><caption style="width:20px;height:16px;margin-right:8px">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
    expect_parity('<table dir="rtl" style="border-spacing:4px"><caption style="width:20px;height:16px;margin:0 auto">c</caption><tr><td style="width:200px;height:20px">a</td></tr></table>')
  end

  # A PERCENTAGE margin resolves against the table's border box — the block the caption spans — which is the
  # record's own containing block either way: natively from the fraction the walk sent where the edges are
  # AFFINE, and off the oracle's basis (`recordCbW`) where a comparison function makes them piecewise. The floor
  # reads them basis-less (0 and 12 here), since the width they would resolve against is the one being decided.
  it 'matches a caption with a percentage / piecewise margin' do
    expect_parity('<table style="width:200px;border-spacing:0"><caption style="height:16px;margin:0 5%">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
    expect_parity('<table style="width:200px;border-spacing:0"><caption style="height:16px;margin:0 min(10%, 12px)">c</caption><tr><td style="width:40px;height:20px">a</td></tr></table>')
  end

  # An OUT-OF-FLOW child of a table (§9.7): it is no cell, no row and no caption — it leaves the table's
  # structure entirely — and the oracle places EVERY one at the same corner, the grid's top-left, whether it was
  # written in the table, in a row group or in a row. So the walk emits them all under the TABLE record and
  # `measure_table` records that one static corner; `place_out_of_flow` does the rest, as for any other box.
  # (Three parents, because `tableGrid` gathers them at three different sites and only the table's own used to
  # be reachable from a reading of the code.)
  #
  # Every shape here uses `display: table` and NOT `<table>`, and that is not a stylistic choice: HTML tree
  # construction FOSTER-PARENTS a `<div>` written inside a `<table>`, moving it out in FRONT of the table, so
  # `<table><div style="position:absolute">` never produces an out-of-flow table child at all. Four specs
  # written that way passed against the unchanged engine — they were testing a sibling of the table.
  def oof_table(inner_table: '', inner_group: '', inner_row: '', table: '', dir: nil)
    %(<div#{dir ? %( dir="#{dir}") : ''} style="display:table;border-spacing:4px;#{table}">#{inner_table}<div style="display:table-row-group">#{inner_group}<div style="display:table-row">#{inner_row}<div style="display:table-cell;width:40px;height:20px">a</div></div></div></div>)
  end

  OOF_BOX = '<div style="position:absolute;top:2px;left:3px;width:8px;height:6px"></div>'

  it 'matches an out-of-flow child of a table, of a row and of a row group' do
    expect_parity(oof_table(inner_table: OOF_BOX))
    expect_parity(oof_table(inner_group: OOF_BOX))
    expect_parity(oof_table(inner_row: OOF_BOX))
  end

  # …and its STATIC position is the grid's top-left corner — inside the table's own border + padding and PAST a
  # top caption — which only a box with no insets to override it can see. An RTL table leaves that corner at the
  # content's LEFT edge: `layoutTable` is the one flow that places its out-of-flow children with no aligned
  # static corner, where block flow and grid both hand `placeAbsolute` one. Chrome puts it at the right; both
  # engines agree on the left, so this is a recorded oracle divergence, not a parity break.
  it 'matches an out-of-flow table child at its static position (past the caption, inside the padding)' do
    static_box = '<div style="position:absolute;width:8px;height:6px"></div>'
    expect_parity(oof_table(table: 'border:5px solid;padding:3px',
                            inner_table: %(<div style="display:table-caption;height:16px">c</div>#{static_box})))
    expect_parity(oof_table(table: 'border:5px solid;padding:3px', inner_table: static_box, dir: 'rtl'))
  end

  it 'matches a shrink-to-fit out-of-flow table child (auto width, one inset)' do
    expect_parity(oof_table(inner_table: '<div style="position:absolute;top:2px">shrink to fit</div>'))
  end

  # A shrink-to-fit box whose content native cannot measure (`WalkRefusals::UNMEASURABLE`) is REPLAYED
  # instead: the oracle's border box pushed with its displacement from the table's origin. The only shape here that
  # takes that arm (`nativeOutOfFlow` stays 0), and it is a whole second code path. (A containing block with
  # PERCENTAGE edges was the shape until native placed against one itself: its padding box is its border box less
  # its borders, which no percentage is.)
  it 'matches a REPLAYED out-of-flow table child (content native cannot measure)' do
    unmeasured = %(<div style="position:absolute;top:2px">#{WalkRefusals::UNMEASURABLE}</div>)
    body = %(<div style="position:relative;width:300px">#{oof_table(inner_table: unmeasured)}</div>)
    expect_parity(body)
    expect(run_shadow(body)['nativeOutOfFlow']).to eq(0), 'expected the replay arm, not the native placement'
    # …and against a containing block with percentage edges, native's own now.
    body = %(<div style="position:relative;padding:5%;width:300px">#{oof_table(inner_table: OOF_BOX)}</div>)
    expect_parity(body)
    expect(run_shadow(body)['nativeOutOfFlow']).to eq(1)
  end

  # A caption is a normal block in the table's BORDER box (§17.4 wrapper box): declared height / width / min-max /
  # box-sizing / auto-margin centering honored, auto width fills the border box, and a caption with a definite
  # width wider than the grid floors the table (stretching its columns to fill what is left inside the border).
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

  # A POSITIONED or FLOATED table lays out natively. Neither enters the table's own layout — a positioned
  # table is sized and placed by its parent's out-of-flow path (natively, not a replayed box), a floated one
  # by its parent's float branch — so the gate that refused both, where the flex gate never did, only cost
  # declines: 159 of 168 positioned / floated tables in four containers, 57 after, none mismatching.
  it 'lays out a positioned or floated table' do
    tables = [
      '<table style="border-spacing:0;%s"><tr><td style="padding:0">a</td><td style="padding:0">bb cc</td></tr></table>',
      '<table style="border-spacing:4px;%s"><tr><td>aaa</td><td>b</td></tr><tr><td colspan="2">wide cell</td></tr></table>',
      '<table style="border-collapse:collapse;%s"><tr><td style="border:2px solid">a</td><td style="border:1px solid">b</td></tr></table>',
      '<table style="%s"><caption>cap</caption><thead><tr><th>h</th></tr></thead><tbody><tr><td>row one</td></tr></tbody></table>'
    ]
    ['position:absolute', 'position:absolute;right:0;bottom:0', 'position:fixed;top:0;left:0',
     'float:left', 'float:right', 'float:left;width:150px'].each do |pos|
      tables.each do |t|
        table = format(t, pos)
        r = run_shadow(%(<div style="position:relative;width:300px;height:200px;overflow:hidden">#{table}<div>after</div></div>))
        expect(r).to include('ok' => true), "#{pos}: harness bailed: #{r.inspect}"
        expect(r['mismatches']).to eq(0), "#{pos}: mismatch: #{r.inspect}"
        expect_no_dropped_records(r)
      end
    end
  end

  # …but never as the pass ROOT. The container gates do not ask a position, because an out-of-flow box is its
  # PARENT's to size and place — and the root has no parent in the pass, so native laid it out as an in-flow
  # block filling the width it was handed: an `absolute` table, flex or grid as the root came out 300 wide
  # where the oracle's shrink-to-fit says 66.4. It declines instead; a floated or static root stays native.
  it 'declines an out-of-flow container as the pass root' do
    root_run = lambda do |body, selector|
      session = simulated_session(page(body))
      session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      session.evaluate_script(%(globalThis.__csimLayoutShadowRun(document.querySelector(#{selector.inspect}))))
    end
    inner = {
      'table' => '<table id="r" style="%s"><tr><td>a</td><td>bb cc</td></tr></table>',
      'flex'  => '<div id="r" style="display:flex;%s"><div>a</div><div>bb cc</div></div>',
      'grid'  => '<div id="r" style="display:grid;grid-template-columns:auto auto;%s"><div>a</div><div>bb cc</div></div>'
    }
    inner.each do |kind, t|
      ['position:absolute;right:10px;bottom:5px', 'position:fixed;top:0;left:0'].each do |pos|
        r = root_run.call(%(<div style="position:relative;width:300px;height:200px">#{format(t, pos)}</div>), '#r')
        expect(r).to include('ok' => false, 'reason' => 'root unsupported'), "#{kind} #{pos}: #{r.inspect}"
      end
      r = root_run.call(%(<div style="width:300px">#{format(t, 'position:relative')}</div>), '#r')
      expect(r).to include('ok' => true), "#{kind} relative root: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "#{kind} relative root: #{r.inspect}"
      expect_no_dropped_records(r)
    end
  end

  # A/B bails — the feature declines; a plain table stays native.
  def a_bails_b_native(feature, plain = '<table style="border-spacing:4px"><tr><td style="width:40px">a</td><td style="width:40px">b</td></tr></table>')
    expect(run_shadow(feature)['ok']).to be(false), "expected #{feature.inspect} to bail"
    expect(run_shadow(plain)['ok']).to be(true), 'expected the plain table to stay native'
  end

  # SEVERAL captions stack as `layoutTable`'s `layCaption` stacks them — the top ones above the grid and the bottom
  # ones below it, each side in document order, their margin boxes the flow — and the widest floors the table. The
  # walk declined a second one until 2026-09-25 (an inline-table holding two was PUSHED, its baseline and box the
  # oracle's). Chrome's boxes.
  it 'stacks several captions on either side of the grid' do
    body = '<table style="border-spacing:4px;border:3px solid;padding:2px"><caption id="m" style="margin:4px">one</caption><caption>two two two two</caption>' \
           '<caption style="caption-side:bottom;margin-top:5px">b1</caption><caption id="b2" style="caption-side:bottom">b2</caption><tr><td style="width:40px">a</td></tr></table>'
    expect_parity(body)
    expect(laid_out_rect(body)).to eq([4, 4, 52, 18])
    expect(laid_out_rect(body, 'b2')).to eq([0, 123, 60, 18])
  end
  # ORACLE: a captioned table's box is its WRAPPER whichever height it was asked for — a DECLARED height is the rows',
  # an imposed one the wrapper's — so a reuse that found the same number asked as the box came to did not have the same
  # answer. A flex row measures the table at auto first; where that came to exactly the declared height (one 18px
  # caption over two rows, 76, or three captions, 186 in a 180 row), the declared-height layout reused it and the rows
  # kept their natural height: 76 / 120 where native and Chrome give the rows the declared height and the table 98 /
  # 186. (A flex COLUMN's main size is the wrapper's and still reuses — see `reuseSubtree`.)
  it 'lays a captioned table out again when its declared height meets its auto one' do
    {
      '<caption>t1</caption>'                                    => [76, 98],
      '<caption style="caption-side:bottom">b1</caption>'        => [76, 98],
      '<caption>t1</caption><caption>t2</caption><caption>t3</caption>' => [120, 186]
    }.each do |caps, (declared, chrome)|
      body = %(<div style="display:flex;width:300px;height:180px;font:16px monospace"><table id="m" style="height:#{declared}px;border-spacing:2px">) +
             %(#{caps}<tr><td>a</td></tr><tr><td>c</td></tr></table></div>)
      expect_parity(body)
      expect(laid_out_rect(body)[3]).to eq(chrome), caps
    end
    column = '<div style="display:flex;flex-direction:column;width:300px;font:16px monospace"><table id="m" style="height:76px;border-spacing:2px">' \
             '<caption>t1</caption><tr><td>a</td></tr><tr><td>c</td></tr></table></div>'
    expect_parity(column)
    expect(laid_out_rect(column)[3]).to eq(98)   # Chrome
  end
  # NATIVE: a captioned table in a definite flex COLUMN whose cells hold a percentage height is measured, and that
  # measure read the indefinite basis — which (§9.8) makes a flexed item impose its height again. Not a captioned
  # table's: the column's main size is the WRAPPER's, which `measure_table` reads as the rows' and stacks the caption
  # on — 72 where the oracle (its `mainImposed` exemption) and Chrome keep 50.
  it 'keeps a captioned table its measure in a definite column whose cells read a percentage height' do
    body = '<div style="display:flex;flex-direction:column;height:200px;width:300px;font:16px monospace"><table id="m" style="border-spacing:2px">' \
           '<caption>cap</caption><tr><td><div style="height:50%">p</div></td></tr></table><div>z</div></div>'
    expect_parity(body)
    expect(laid_out_rect(body)[3]).to eq(50)   # Chrome
  end
  # An inline-table is an ATOMIC inline in its parent's line — native replays its oracle box (its rows/cells are
  # covered via the parent), so a block holding one lays out rather than declining.
  # A table as a FLEX ITEM: the walk declined every flex container holding one. Native sizes it like any item
  # (its automatic minimum is the table's own min-content, a border-box figure), and a table that ends up TALLER
  # than the main size it was given — its height is a minimum (§17.5.3), and a caption stacks on top of it —
  # pushes the items after it down (Chrome: the table 138, the item after it at 138, the column 156).
  it 'matches a table as a flex item' do
    expect_parity('<div style="display:flex;width:300px"><table style="border-spacing:2px"><tr><td>a</td><td>bb cc</td></tr></table><div>y</div></div>')
    expect_parity('<div style="display:flex;width:300px"><table style="flex:1;border-spacing:2px"><tr><td>a</td><td>bb cc</td></tr></table><div style="width:40px">y</div></div>')
    expect_parity('<div style="display:flex;width:300px;flex-direction:column"><table style="flex:0 0 10px;border-spacing:2px"><tr><td>a</td></tr><tr><td>b</td></tr></table><div style="height:20px">y</div></div>')
    expect_parity('<div style="display:flex;width:300px;align-items:flex-end;height:90px"><table style="table-layout:fixed;width:150px"><tr><td>aaaa</td><td>b</td></tr></table><div style="width:40px">y</div></div>')
    body = '<div id="f" style="display:flex;width:300px;flex-direction:column"><table id="t" style="flex:0 0 120px;border-spacing:2px"><caption>cap</caption><tr><td>a</td></tr></table><div id="s" style="width:40px">y</div></div>'
    expect_parity(body)
    session = simulated_session(page(body))
    session.visit '/'
    expect(session.evaluate_script("['f', 't', 's'].map(id => { const b = document.getElementById(id).getBoundingClientRect(); return [b.y, b.height]; })"))
      .to eq([[0, 156], [0, 138], [138, 18]])
  end

  # A height IMPOSED on a table from outside — a flex line's cross size, a stretched item — is the WRAPPER's, so
  # its caption comes out of it and the rows share the rest; a DECLARED height is the rows' own and the caption
  # stacks on top of it. (Chrome: stretched to 100 the table is 100 with an 18px caption; `height: 120px` is 138,
  # in a flex row or not.)
  it 'holds a caption inside an imposed height and stacks it on a declared one' do
    [
      ['<div style="display:flex;width:300px"><table id="t" style="border-spacing:2px"><caption>cap</caption><tr><td>a</td></tr></table><div style="height:100px">y</div></div>', 100],
      ['<div style="display:flex;width:300px"><table id="t" style="border-spacing:2px;caption-side:bottom"><caption>cap</caption><tr><td>a</td></tr></table><div style="height:100px">y</div></div>', 100],
      ['<div style="display:flex;width:300px;height:150px"><table id="t" style="border-spacing:2px"><caption>cap</caption><tr><td>a</td></tr></table></div>', 150],
      ['<div style="display:flex;width:300px"><table id="t" style="border-spacing:2px"><caption style="height:50%">cap</caption><tr><td>a</td><td>bb cc</td></tr></table><div>y</div></div>', 42],
      ['<table id="t" style="border-spacing:2px;height:120px"><caption>cap</caption><tr><td>a</td></tr></table>', 138],
      ['<div style="display:flex;width:300px"><table id="t" style="border-spacing:2px;height:120px"><caption>cap</caption><tr><td>a</td></tr></table><div style="height:200px">y</div></div>', 138],
      # …a column whose height is definite leaves an unflexed item at the height its own measure produced — the
      # caption is inside that, not stacked on it (54, not 72)
      ['<div style="display:flex;flex-direction:column;width:300px;height:200px"><table id="t" style="border-spacing:2px"><caption>cap</caption><tr><td style="height:30px">a</td></tr></table></div>', 54],
      # …and this table's OWN min/max-height are the ROWS', applied after the caption comes out of the imposed
      # height: stretched to 100 under `min-height: 150px` the rows get 150 and the table is 168
      ['<div style="display:flex;width:300px;height:100px"><table id="t" style="border-spacing:2px;min-height:150px"><caption>cap</caption><tr><td style="height:30px">a</td></tr></table><div style="width:40px">y</div></div>', 168],
      ['<div style="display:flex;width:300px;height:100px"><table id="t" style="border-spacing:2px;max-height:40px"><caption>cap</caption><tr><td style="height:30px">a</td></tr></table><div style="width:40px">y</div></div>', 58]
    ].each do |body, height|
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      expect(session.evaluate_script("document.getElementById('t').getBoundingClientRect().height")).to eq(height), body
    end
  end

  # A box anchored to a `position: relative` TABLE is placed against the WRAPPER's final padding box: its
  # captions and its own rows grow it past the height it was given (§17.5.3), so it is deferred like any
  # containing block whose size is not settled yet (Chrome: a `bottom: 0` box in a 120px table with an 18px
  # caption sits at 118, where the pre-growth box put it at 100).
  it 'anchors a box to a relative table grown by its caption' do
    body = '<table style="position:relative;border-spacing:2px;width:200px;height:120px"><caption>cap</caption><tr><td style="height:30px"><div id="t" style="position:absolute;bottom:0;left:0;width:20px;height:20px"></div>a</td></tr></table>'
    expect_parity(body)
    session = simulated_session(page(body))
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('t').getBoundingClientRect().y")).to eq(118)
  end

  # A table flex item on a BASELINE-aligned line. This DECLINED until 2026-09-23 on a note reading "the oracle
  # takes a table's baseline from the first line inside it, native synthesises one from the margin box, and
  # Chrome's figure is neither (9 / 22 / 19)" — and every clause of it had stopped being true without anything
  # re-asking. Native has stamped a table's first and last baselines in `measure_table` since 2026-09-19, and a
  # CAPTION stopped being one of the oracle's baseline candidates the same day the refusal came out.
  #
  # The two engines agree on every shape below, and the page's geometry is byte-identical to what it was with
  # the refusal in place — the ORACLE was answering either way, so lifting it moved no box, only the decline
  # (`caption` sweep: 2,250 → 0).
  #
  # Chrome's figures are pinned too, because the gap is REAL and shared: a table hands a flex line a baseline
  # ~9px higher here than in Chrome. The plain-block CONTROL agrees exactly (13 in all three), which is what
  # says this is a table rule and not a font or a harness difference. Recorded, not fixed — moving it means
  # moving both engines, and that is its own increment.
  it 'matches a table flex item aligned on the baseline (Chrome: the marker is 9px lower)' do
    marker = '<b id="m" style="display:inline-block;width:4px;height:4px"></b>'
    row    = '<table style="border-spacing:2px"><tr><td style="height:30px">a</td></tr></table>'
    rows2  = '<table style="border-spacing:2px"><tr><td>a</td></tr><tr><td style="height:30px">b</td></tr></table>'
    {
      ['align-items:baseline', row]                                                              => [20, 29],
      ['align-items:baseline', '<table style="border-spacing:2px"><caption>cap</caption><tr><td style="height:30px">a</td></tr></table>'] => [42, 51],
      ['align-items:baseline', '<table style="border-spacing:2px;caption-side:bottom"><caption>cap</caption><tr><td style="height:30px">a</td></tr></table>'] => [20, 29],
      ['align-items:baseline', rows2]                                                            => [16, 21],
      ['align-items:last baseline', rows2]                                                       => [46, 55],
      ['align-items:baseline', '<table style="border-spacing:2px"></table>']                      => [0, 0]
    }.each do |(align, table), (shared_y, chrome_y)|
      body = %(<div style="display:flex;width:300px;font:16px monospace;#{align}">#{table}#{marker}</div>)
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      y = session.evaluate_script("document.getElementById('m').getBoundingClientRect().y")
      expect_shared_gap(y, shared: shared_y, chrome: chrome_y, what: "#{body}: marker y")
    end
    # …and a table whose ROW GROUPS are written out of source order, which is where the two engines' senses of
    # "the table's FIRST row" came apart. `tableGrid` sorts header / body / footer the way §17.2.1 renders
    # them and native takes its baseline off that sorted grid; `baselineCandidates` walked the DOM, so a
    # `<tfoot>` before its `<tbody>` gave the oracle the FOOTER's baseline — 46 where native (and Chrome, to
    # within the shared gap) say 16. HTML 4.01 REQUIRED that order, so this is legacy markup and not an edge.
    # Only this spec's own gate was hiding it: nothing else asks a table for a baseline.
    {
      ['align-items:baseline', :tfoot_first]      => [16, 21],
      ['align-items:last baseline', :tfoot_first] => [46, 55],
      ['align-items:baseline', :thead_last]       => [20, 29],
      ['align-items:last baseline', :thead_last]  => [50, 55],
      ['align-items:baseline', :thead_mid]        => [20, 29],
      ['align-items:last baseline', :thead_mid]   => [76, 81]
    }.each do |(align, which), (shared_y, chrome_y)|
      table = case which
              when :tfoot_first then '<table style="border-spacing:2px"><tfoot><tr><td style="height:30px">f</td></tr></tfoot><tbody><tr><td style="height:10px">b</td></tr></tbody></table>'
              when :thead_last  then '<table style="border-spacing:2px"><tbody><tr><td style="height:10px">b</td></tr></tbody><thead><tr><td style="height:30px">h</td></tr></thead></table>'
              else '<table style="border-spacing:2px"><tbody><tr><td style="height:10px">b1</td></tr></tbody><thead><tr><td style="height:30px">h</td></tr></thead><tbody><tr><td style="height:20px">b2</td></tr></tbody></table>'
              end
      body = %(<div style="display:flex;width:300px;font:16px monospace;#{align}">#{table}#{marker}</div>)
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      y = session.evaluate_script("document.getElementById('m').getBoundingClientRect().y")
      expect_shared_gap(y, shared: shared_y, chrome: chrome_y, what: "#{body}: marker y")
    end
    # …and the same table spelled with `display: table-*` divs, where all three engines agree EXACTLY (15 and
    # 39). That is the control that says the residual gap above is the `<td>` UA rule and not the ordering:
    # these divs carry no UA `vertical-align`, and with it gone so is the gap.
    divs = '<div style="display:table;border-spacing:2px"><div style="display:table-footer-group"><div style="display:table-row"><div style="display:table-cell;height:30px">f</div></div></div><div style="display:table-row-group"><div style="display:table-row"><div style="display:table-cell;height:10px">b</div></div></div></div>'
    {'align-items:baseline' => 15, 'align-items:last baseline' => 39}.each do |align, chrome_y|
      body = %(<div style="display:flex;width:300px;font:16px monospace;#{align}">#{divs}#{marker}</div>)
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      expect(session.evaluate_script("document.getElementById('m').getBoundingClientRect().y")).to be_within(0.05).of(chrome_y), body
    end
    # …and the CONTROL, where the item is a plain block: all three engines agree, so the gap above is the
    # table's baseline and nothing else.
    control = %(<div style="display:flex;width:300px;font:16px monospace;align-items:baseline"><div style="height:30px">a</div>#{marker}</div>)
    expect_parity(control)
    session = simulated_session(page(control))
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('m').getBoundingClientRect().y")).to be_within(0.05).of(13)
  end

  it('matches an inline-table as an atomic inline') { expect_parity('<div style="width:300px">x <span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">a</span></span></span> y</div>') }
  # …and an ANONYMOUS CELL is laid out now, which it was not until 2026-09-22. §17.2.1 wraps a table's stray
  # non-cell content in one, `anonTableCell` builds it, and it is no part of the DOM — so it has no `_nid`, and
  # the record stream had nothing to put in a record's node slot. It gets the sentinel an anonymous ROW and an
  # anonymous BLOCK GROUP already get: laid out, and skipped in the parity compare (its CHILDREN are real nodes
  # and are compared). This was the largest single cause behind `table-unsupported`, the campaign's biggest
  # decline — 1,440 sole blockers over the `pseudo` and `sticky` sweeps, and the reason the reason-string had to
  # be censused before it could be named.
  # The figures are Chrome 153's, and they are here because parity alone could not tell whether the box the two
  # engines now agree on is the right one.
  {
    'a run of text'                => ['stray text', [0, 0, 96.015625, 22]],
    'one atomic inline'            => ['<span style="display:inline-block;width:10px;height:9px"></span>', [0, 0, 10, 22]],
    'runs either side of a cell'   => ['a<div style="display:table-cell">b</div>c', [0, 0, 28.828125, 22]]
  }.each do |name, (content, chrome)|
    it "lays out the anonymous cell around #{name}" do
      body = %(<div style="width:400px"><div id="m" style="display:table;font:16px monospace">#{content}</div></div>)
      session = simulated_session(page(body))
      session.visit '/'
      session.evaluate_script 'document.body.offsetHeight'
      r = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
      expect(r).to include('ok' => true, 'mismatches' => 0), body
      # …`sample` rather than `compared`, which a wrapper div alone would satisfy: nothing mismatched, and
      # the table really was walked (a declined one comes back `ok: false`).
      expect(r['sample']).to be_nil, "#{body}: #{r.inspect}"
      got = session.evaluate_script("(b => [b.x, b.y, b.width, b.height])(document.getElementById('m').getBoundingClientRect())")
      got.each_with_index do |v, i|
        expect(v).to be_within(0.05).of(chrome[i]), "#{body}: #{got.inspect} vs Chrome #{chrome.inspect}"
      end
    end
  end
  # …and a real node INSIDE the anonymous cell is compared like any other, which is what says the cell is a box
  # in the tree and not a hole in it. Chrome 153: the inline-block sits at 57.609375, 8 on the cell's one line.
  it 'compares a real box inside the anonymous cell' do
    body = '<div style="width:400px"><div style="display:table;font:16px monospace">stray ' \
           '<span id="m" style="display:inline-block;width:10px;height:9px"></span> text</div></div>'
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    r = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(r).to include('ok' => true, 'mismatches' => 0), body
    got = session.evaluate_script("(b => [b.x, b.y, b.width, b.height])(document.getElementById('m').getBoundingClientRect())")
    [57.609375, 8, 10, 9].each_with_index do |v, i|
      expect(got[i]).to be_within(0.05).of(v), got.inspect
    end
  end

  # …and an anonymous box is NOT an element, so it generates no content of its own (CSS Pseudo-Elements 4 §2).
  # It matches `*` like anything else the flow enumerates, so a page carrying a universal `content` rule grew a
  # `::before` on the cell as well as on the table: 134.4 wide against Chrome 153's 115.21875, two copies of
  # `XX` against one. Pre-existing, and only reachable at all once the cell is laid out.
  it 'grows no generated content on the anonymous cell' do
    body = '<style>*::before{content:"XX"}</style>' \
           '<div id="m" style="display:table;font:16px monospace">stray text</div>'
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0)
    w = session.evaluate_script("document.getElementById('m').getBoundingClientRect().width")
    expect(w).to be_within(0.05).of(115.21875), "#{w}: a second XX means the anonymous cell generated one"
  end

  # …and a PERCENTAGE inside the anonymous cell resolves against the CELL, which is Chrome's own basis: a
  # `float: left; width: 50%` beside stray text in a 200px fixed table whose real cell takes 120 is 40 wide,
  # not 100. Both engines already agree with Chrome here, which is worth pinning rather than assuming: the
  # record stream currently pushes the anonymous cell as a `null` node, and the next increment — giving it an
  # arena node so its box can be COMPARED — is exactly the kind of change that could move a percentage basis
  # underneath this without anyone asking.
  it 'resolves a percentage inside the anonymous cell against the cell' do
    body = '<div id="t" style="display:table;table-layout:fixed;width:200px;font:16px monospace">t' \
           '<div id="f" style="float:left;width:50%;height:9px"></div>' \
           '<div style="display:table-cell;width:120px">c</div></div>'
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0), body
    w = session.evaluate_script("document.getElementById('f').getBoundingClientRect().width")
    expect(w).to be_within(0.05).of(40), "#{w}: 100 means it resolved against the TABLE, not the anonymous cell"
  end

  # KNOWN DIVERGENCE, both engines and older than this: an `inline-table` hangs from its FIRST row's baseline
  # (CSS 2.1 §10.8.1) and this engine hangs it from its LAST, because `atomicBaselineOffset` asks every atomic
  # inline for its last baseline and a table is not told apart. Chrome 153 puts the word beside a two-row
  # inline-table at 0 when the tall row is second and 23 when it is first; both engines say 41 and 47.
  # Pinned here because the anonymous-cell path was made to agree with the real-row path rather than
  # half-corrected — a shared divergence moved in one engine only is a parity break, which costs more.
  # Two of the four reach the anonymous-cell FALLBACK and two do not, which is the point: the shapes with
  # element children (`display:table-row`) never empty the candidate list, so they go the way they always did.
  # Written the other way round first — `<div>A</div><div>B</div>` for the anonymous pair — the fallback could
  # be deleted outright and all four still passed: a block child is not inline-level, so it survives the
  # filter and the list is never empty. A guard that cannot fail is the third one this campaign has shipped.
  [
    ['real rows, the tall one second', '<div style="display:table-row"><div style="display:table-cell">A</div></div>' \
                                       '<div style="display:table-row"><div style="display:table-cell;font-size:40px">B</div></div>', 41, 0],
    ['real rows, the tall one first',  '<div style="display:table-row"><div style="display:table-cell;font-size:40px">A</div></div>' \
                                       '<div style="display:table-row"><div style="display:table-cell">B</div></div>', 47, 23],
    ['anonymous, the tall one second', 'A<br><span style="font-size:40px">B</span>', 41, 0],
    ['anonymous, the tall one first',  '<span style="font-size:40px">A</span><br>B', 47, 23]
  ].each do |name, inner, ours, chrome|
    it "hangs a two-row inline-table from its LAST row, where Chrome uses the first: #{name}" do
      body = %(<div id="w" style="width:600px"><span style="display:inline-table;border-spacing:0">#{inner}</span><span id="p">p</span></div>)
      session = simulated_session(page(body))
      session.visit '/'
      session.evaluate_script 'document.body.offsetHeight'
      expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0), body
      off = session.evaluate_script(
        "document.getElementById('p').getBoundingClientRect().y - document.getElementById('w').getBoundingClientRect().y"
      )
      expect(off).to be_within(0.05).of(ours), "#{off}: Chrome 153 says #{chrome} — the FIRST row"
      # …and the table's own height IS Chrome's (65), so the divergence really is the baseline alone.
      h = session.evaluate_script("document.getElementById('w').getBoundingClientRect().height")
      expect(h).to be_within(0.05).of(65)
    end
  end
  # …and the one-line shape the fallback was written for: with no candidate at all the table had NO baseline,
  # so it hung from its bottom margin edge and the line grew. Chrome 153 and native say 18; the oracle said 22.
  # This is the arm that fails if the fallback goes.
  it 'gives a one-line inline-table of stray text the line height Chrome gives it' do
    body = '<div id="w" style="width:600px"><span style="display:inline-table;border-spacing:0">it</span><span>p</span></div>'
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0), body
    h = session.evaluate_script("document.getElementById('w').getBoundingClientRect().height")
    expect(h).to be_within(0.05).of(18), "#{h}: 22 means the table found no baseline and hung from its margin edge"
  end
  it('declines a same-display group NESTED in another (its rows interleave in render order)') { a_bails_b_native('<div style="display:table;border-spacing:4px"><div style="display:table-row-group"><div style="display:table-row"><div style="display:table-cell;width:40px;height:20px">r1</div></div><div style="display:table-row-group"><div style="display:table-row"><div style="display:table-cell;height:18px">r2</div></div></div><div style="display:table-row"><div style="display:table-cell;height:36px">r3</div></div></div></div>') }

  # ── Native COLUMN sizing ──────────────────────────────────────────────────────────────────────────────
  # The columns are native's own now (`table_columns` / `distribute_columns` / `fixed_column_widths`): each one
  # sized from the cells' own min/max-content widths, a spanning cell topping up whatever the columns it covers
  # are short of, a declared length or `%` constraining it, a `<col>` naming it — then the distribution ladder
  # (min-content → specified → max-content → the surplus over the unconstrained columns) over the width inside
  # the frame, and the table itself shrink-to-fitting that when its own width is auto.
  # A grid whose intrinsic tracks native measured itself (no oracle contribution).
  def expect_native_intrinsic(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect_no_dropped_records(r, body)
    expect(r['nativeIntrinsicGrids']).to be >= 1, "the track took the oracle's contribution: #{r.inspect}"
  end

  describe 'native column sizing' do
    it 'sizes columns from the cells\' content, the widest cell winning' do
      expect_parity('<table style="border-spacing:0"><tr><td>a</td><td>wider text</td></tr><tr><td>longer word</td><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td>aa</td><td>bbb</td></tr><tr><td>c</td><td>d</td></tr></table>')
      expect_parity('<table><tr><td>one two three four five six seven eight nine ten</td></tr></table>')
      expect_parity('<table style="width:600px"><tr><td>one two three</td><td>four five six seven eight</td></tr></table>')
      expect_parity('<table style="width:60px"><tr><td>one two three</td><td>four five six</td></tr></table>')
    end
    it 'lets a spanning cell top up only what the columns it covers are short of' do
      expect_parity('<table style="border-spacing:4px"><tr><td colspan="2">A very wide spanning cell</td><td>b</td></tr><tr><td>c</td><td>d</td><td>e</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td colspan="2">A</td><td style="width:20px">b</td></tr><tr><td style="width:30px">c</td><td colspan="2">DE</td></tr></table>')
      expect_parity('<table><tr><td colspan="3">one wide spanning row</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>')
    end
    it 'honours a declared cell width, a percentage, and min/max-width' do
      expect_parity('<table style="width:400px"><tr><td style="width:100px">a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><tr><td style="width:25%">a</td><td>b</td></tr></table>')
      expect_parity('<table><tr><td style="width:25%">a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><tr><td style="width:25%">a</td><td style="width:50%">b</td></tr></table>')
      expect_parity('<table style="width:400px"><tr><td style="min-width:200px">a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><tr><td style="max-width:40px">a longer text</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><tr><td style="width:100px;padding:10px;border:2px solid">a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><tr><td style="width:100px;box-sizing:border-box;padding:10px">a</td><td>b</td></tr></table>')
    end
    it 'reads a <col> / <colgroup> width and span' do
      expect_parity('<table><col style="width:120px"><col><tr><td>a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><col style="width:25%"><col><tr><td>a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px"><colgroup><col span="2" style="width:80px"><col></colgroup><tr><td>a</td><td>b</td><td>c</td></tr></table>')
      expect_parity('<table><col style="width:120px"><tr><td>a</td><td>b</td></tr></table>')
    end
    it 'sizes a fixed-layout table from its first row alone' do
      expect_parity('<table style="table-layout:fixed;width:300px"><tr><td>a</td><td>b</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px"><tr><td style="width:50px">a</td><td>b</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px"><tr><td style="width:50px">a</td><td style="width:100px">b</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px"><tr><td style="width:25%">a</td><td>b</td></tr></table>')
      # Chrome's own asymmetry: a `width: 0%` CELL really takes 0 of the width, a `<col style="width:0%">` is
      # ignored and the columns split it evenly.
      expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:0"><tr><td style="width:0%">a</td><td>b</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:0"><col style="width:0%"><col><tr><td>a</td><td>b</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px"><col style="width:40px"><tr><td>a</td><td style="width:100px">b</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px"><tr><td colspan="2" style="width:200px">a</td><td>b</td></tr><tr><td>x</td><td>y</td><td>z</td></tr></table>')
      expect_parity('<table style="table-layout:fixed"><tr><td style="width:50px">a</td><td>wide content here</td></tr></table>')
    end
    it 'shrink-to-fits an auto-width table, and grows past a width its columns overflow' do
      expect_parity('<div style="width:300px"><table><tr><td>one two three four five six seven</td></tr></table></div>')
      expect_parity('<div style="width:80px"><table><tr><td>one two three four</td><td>five six</td></tr></table></div>')
      expect_parity('<table style="width:20px"><tr><td>unbreakableword</td><td>another</td></tr></table>')
      expect_parity('<div style="width:300px"><table style="min-width:280px"><tr><td>a</td></tr></table></div>')
      expect_parity('<div style="width:300px"><table style="max-width:100px"><tr><td>one two three four five</td></tr></table></div>')
    end
    it 'takes the oracle\'s contribution for a cell it cannot measure, rather than declining the table' do
      # A control's chrome, a nested grid, a `%` edge an intrinsic measure has no basis for: the cell's resolved
      # min/max-content ride its record (rec[84..85]) and size its column, exactly as an un-measurable grid
      # track's contribution does. The table stays native either way.
      expect_parity('<table><tr><td><input type="text"></td><td>b</td></tr></table>')
      expect_parity('<table><tr><td><select><option>x</option></select></td><td>b</td></tr></table>')
      expect_parity('<table><tr><td><div style="display:grid;grid-template-columns:30px 40px"><div>x</div><div>y</div></div></td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px;border-spacing:0"><tr><td style="padding-left:10%">a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px;border-spacing:0"><tr><td><div style="padding-left:10%">a</div></td><td>b</td></tr></table>')
      expect_parity('<table><caption><input></caption><tr><td>a</td></tr></table>')
      expect_parity('<table style="width:100%"><thead><tr><th>Name</th><th>Actions</th></tr></thead><tbody><tr><td>x</td><td><input value="v"></td></tr></tbody></table>')
    end
    it 'takes the contribution for a cell whose atomic inline is PUSHED, not just one it cannot measure' do
      # A `justify` block spreads its spaces (positions native does not hold) and a MIXED block's anonymous
      # groups get no atomic hook, so both push every atomic — whose box is then not in the run stream
      # `text_intrinsic` reads. The gate says so, and the cell's contribution comes off its record.
      expect_parity('<table><tr><td style="text-align:justify">x <span style="display:inline-block">y</span></td><td>b</td></tr></table>')
      expect_parity('<table><tr><td><div>blk</div>p <span style="display:inline-block">ok</span> q</td><td>b</td></tr></table>')
      # …and two shapes that USED to be pushed and are measured now, kept as parity checks: an inline with a
      # `white-space` of its own, and an edged one whose font box exceeds its line-height (which the walk
      # refused until native's CLOSE learned to grow the line to that box).
      expect_parity('<table><tr><td>x <span style="display:inline-block">a <i style="white-space:pre">b  c</i></span></td><td>b</td></tr></table>')
      expect_parity('<table><tr><td>x <span style="display:inline-block"><b style="padding:0 5px;line-height:4px">y</b></span></td><td>b</td></tr></table>')
      # The fact is ONE per inline formatting context: a nested atomic is pushed too, however deep the inline
      # chain, so the gate threads it down (a link holding an icon beside a block is ordinary app markup).
      expect_parity('<table><tr><td style="text-align:justify">x <span>y <span style="display:inline-block">z</span></span></td><td>b</td></tr></table>')
      expect_parity('<table><tr><td style="text-align:justify">x <span>y <img width="10" height="10"></span></td><td>b</td></tr></table>')
      expect_parity('<table><tr><td><div>head</div>x <a href="#">link <img width="10" height="10"></a></td><td>b</td></tr></table>')
      # …while the same shapes with the hook LIVE still lay their atomic out natively.
      expect_parity('<table><tr><td>x <a href="#">link <img width="10" height="10"></a></td><td>b</td></tr></table>')
    end
    it 'counts the columns a <col> / <colgroup span> declares past the cells\' own reach' do
      expect_parity('<table style="width:400px;border-spacing:0"><col><col><col><tr><td>a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px;border-spacing:0"><colgroup span="3"></colgroup><tr><td>a</td><td>b</td></tr></table>')
      expect_parity('<table style="width:400px;border-spacing:0"><col span="2"><tr><td>a</td></tr></table>')
      expect_parity('<table style="table-layout:fixed;width:300px;border-spacing:0"><col><col><col><tr><td>a</td><td>b</td></tr></table>')
    end
    # A table in an INTRINSIC grid track is measured by native itself now (`nlIntrinsicMeasurable` admits one),
    # so the track sizes from the table's own columns rather than an oracle contribution.
    it 'measures a table in a grid track itself' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:max-content auto;width:400px"><table><tr><td>a</td><td>bb</td></tr></table><div>x</div></div>')
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:min-content auto;width:400px"><table><tr><td>aaa bbb</td><td>bb</td></tr></table><div>x</div></div>')
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:max-content auto;width:400px"><table style="border-spacing:4px"><caption>a wide caption here</caption><tr><td>a</td></tr></table><div>x</div></div>')
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:max-content auto;width:400px"><table><tr><td style="width:25%">a</td><td>b</td></tr></table><div>x</div></div>')
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:max-content auto;width:400px"><table><col style="width:120px"><tr><td>a</td><td>b</td></tr></table><div>x</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px 200px;width:400px"><table><tr><td>a</td><td>bb</td></tr></table><div>x</div></div>')
    end
  end

  # ── Native ROW sizing ─────────────────────────────────────────────────────────────────────────────────
  # The rows are native's own too: each is as tall as the tallest cell that does not span rows (a cell's declared
  # height being a MINIMUM its content grows past), a spanning cell tops up the last row it touches, a declared
  # row height floors it, a `%` one takes its share of what the rows have, and a declared TABLE height hands its
  # surplus to the body group's auto rows. Then each cell fills the rows it spans and its content sits within
  # that box per `vertical-align`.
  describe 'native row sizing' do
    it 'sizes a row from its tallest non-spanning cell, a declared cell height being a floor' do
      expect_parity('<table style="border-spacing:4px"><tr><td>one line</td><td>two<br>lines</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td style="height:50px">short</td><td>x</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td style="height:5px">taller content than five pixels</td><td>x</td></tr></table>')
      # min/max-height do not apply to a cell (measured: Chrome leaves both tables 28 tall).
      expect_parity('<table style="border-spacing:4px"><tr><td style="min-height:40px">x</td><td>y</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td style="max-height:5px">x</td><td>y</td></tr></table>')
      # …in its BLOCK axis, which in a vertical writing mode is its width: there its min-height clamps it (Chrome 80,
      # where native skipped every cell's min/max-height by the physical axis and said 18)
      body = '<table style="border-spacing:0"><tr><td id="m" style="padding:0;writing-mode:vertical-lr;min-height:80px">aa bb</td><td>x</td></tr></table>'
      expect_parity(body)
      expect(laid_out_rect(body)[3]).to eq(80)
      # …and its max-height with it, where Chrome ignores one under a declared height — the table's block-axis max,
      # which an ORTHOGONAL cell is the one to tell apart from its own (both engines 90, Chrome 200; the orthogonal
      # cell is a backlog item of its own: Chrome also applies its min/max-width, which both engines skip)
      capped = body.sub('min-height:80px', 'height:200px;max-height:90px')
      expect_parity(capped)
      expect_shared_gap(laid_out_rect(capped)[3], shared: 90, chrome: 200, what: "#{capped}: #m height")
      expect_parity('<table style="border-spacing:4px"><tr><td style="height:30px;box-sizing:border-box;padding:6px">x</td><td>y</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td><div style="height:10px;margin:5px"></div><div style="height:20px"></div></td><td style="height:50px">x</td></tr></table>')
    end
    it 'honours a declared row height, and shares a percentage one' do
      expect_parity('<table style="border-spacing:4px"><tr style="height:60px"><td>a</td></tr><tr><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr style="height:5px"><td>content taller than the row</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:60%"><td>a</td></tr><tr style="height:60%"><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:30%"><td>a</td></tr><tr><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:0"><tr style="height:30%"><td>a</td></tr><tr><td>b</td></tr></table>')
    end
    it 'hands a declared table height\'s surplus to the body group\'s auto rows' do
      expect_parity('<table style="border-spacing:0;height:100px"><tr><td style="height:10px">a</td></tr><tr><td style="height:30px">b</td></tr></table>')
      expect_parity('<table style="border-spacing:4px;height:200px"><thead><tr><td style="height:20px">h</td></tr></thead><tbody><tr><td style="height:10px">b1</td></tr><tr><td style="height:30px">b2</td></tr></tbody><tfoot><tr><td style="height:20px">f</td></tr></tfoot></table>')
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:20px"><td>fixed</td></tr><tr><td>auto</td></tr></table>')
      expect_parity('<table style="border-spacing:0;min-height:100px"><tr><td style="height:10px">a</td></tr><tr><td style="height:30px">b</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:200px;max-height:100px"><tr><td style="height:10px">a</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:20px"><tr><td style="height:40px">taller than the table</td></tr></table>')
      expect_parity('<table style="border-spacing:4px;height:200px"><caption style="height:16px">c</caption><tr><td style="height:20px">a</td></tr></table>')
      expect_parity('<table style="border-collapse:collapse;height:200px"><tr><td style="border:2px solid;height:20px">a</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:100px;box-sizing:border-box;padding:10px"><tr><td>a</td></tr></table>')
    end
    # NOTE (both engines vs Chrome, pre-existing): Chrome SPREADS a spanning cell's deficit over the rows it
    # covers (39/39 for a rowspan=2 80px cell over two auto rows); both engines give it all to the last row
    # (20/58). These expectations pin the driver's own model, not Chrome's — see the campaign's table backlog.
    it 'grows the last row a spanning cell touches by what the rows it covers are short of' do
      expect_parity('<table style="border-spacing:4px"><tr><td rowspan="2" style="height:80px">tall</td><td>a</td></tr><tr><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td rowspan="3" style="height:100px">tall</td><td>a</td></tr><tr><td style="height:20px">b</td></tr><tr><td>c</td></tr></table>')
      expect_parity('<table style="border-spacing:4px"><tr><td rowspan="2">short</td><td style="height:40px">a</td></tr><tr><td style="height:40px">b</td></tr></table>')
      expect_parity('<table style="border-spacing:4px;height:200px"><tr><td rowspan="2" style="height:60px">tall</td><td>a</td></tr><tr><td>b</td></tr></table>')
    end
    it 'places each cell\'s content in the row-tall box per vertical-align' do
      %w[top middle bottom baseline].each do |va|
        expect_parity(%(<table style="border-spacing:0"><tr><td style="vertical-align:#{va}"><div style="width:20px;height:10px"></div></td><td style="height:60px"><div style="height:60px"></div></td></tr></table>))
      end
      expect_parity('<table style="border-spacing:0"><tr><td><div style="height:10px"></div></td><td style="height:61px"><div style="height:61px"></div></td></tr></table>')
      expect_parity('<table style="border-spacing:0"><tr><td style="vertical-align:middle;height:80px"><div style="height:10px"></div></td><td><div style="height:20px"></div></td></tr></table>')
      expect_parity('<table style="border-collapse:collapse"><tr><td style="vertical-align:baseline;font:40px monospace;padding:0"><div>Ay</div></td><td style="vertical-align:baseline;font:16px monospace;padding:0"><div>Ay</div></td></tr></table>')
      expect_parity('<table style="border-spacing:0"><tr><td rowspan="2" style="vertical-align:bottom"><div style="height:10px"></div></td><td style="height:30px"><div style="height:30px"></div></td></tr><tr><td style="height:40px"><div style="height:40px"></div></td></tr></table>')
    end
    # A cell holding a PERCENTAGE-height descendant is laid out TWICE (§17.5.3): its used height is the ROW's,
    # known only once every row is placed, so pass 1 sizes it with those descendants treated as AUTO — they must
    # not inflate the box that is supposed to contain them — and pass 2 lays it out again at the final height,
    # where they finally have a basis. Native's own since 2026-09-23; it used to decline the shape.
    #
    # The bug was in pass ONE. Native handed the cell's own DECLARED height to its children as a basis, and the
    # cell's declared height is a MINIMUM, not a containing block: a `height: 150%` child of a `height: 80px`
    # cell came out 120 and took the row to 122 where the oracle says 82. Nothing else in the engine withholds a
    # basis it has, which is why the test is the IMPOSED height — only `measure_table`'s second pass sends one.
    it 'lays a cell with a percentage-height descendant out twice, at the final row height' do
      # Definite from the TABLE's height, from the cell's OWN height, and from neither.
      expect_parity('<table style="height:200px"><tr><td><div style="height:50%">a</div></td></tr></table>')
      expect_parity('<table><tr><td style="height:100px"><div style="min-height:50%">a</div></td></tr></table>')
      expect_parity('<table><tr><td><div style="height:50%">a</div></td></tr></table>')
      expect_parity('<table><tr><td><div style="height:100%">a</div></td><td>b</td></tr></table>')
      # …a child that OVERFLOWS the cell: the box stays the row's, it does not grow to fit (the shape that
      # caught the pass-1 basis — Chrome, the oracle and native all make this table 114 tall).
      body = '<table id="t" style="border-spacing:0"><tr><td style="height:80px"><div style="height:150%;width:20px">x</div></td></tr><tr><td style="height:30px">r2</td></tr></table>'
      expect_parity(body)
      session = simulated_session(page(body))
      session.visit '/'
      expect(session.evaluate_script("document.getElementById('t').getBoundingClientRect().height")).to eq(114)
      # …a row that is merely TALLER because a sibling cell is does NOT make the cell definite.
      expect_parity('<table style="border-spacing:0"><tr><td><div style="height:50%;width:20px">x</div></td><td style="height:90px">tall</td></tr></table>')
      # …the cell's content then sits in the row-tall box per `vertical-align`, off its SECOND-pass height.
      %w[top middle bottom baseline].each do |va|
        expect_parity(%(<table style="border-spacing:0;height:150px"><tr><td style="vertical-align:#{va}"><div style="height:50%;width:20px">x</div></td><td style="height:70px">s</td></tr></table>))
      end
      # …a cell that SPANS rows resolves against the rows it covers.
      expect_parity('<table style="border-spacing:0;height:150px"><tr><td rowspan="2"><div style="height:50%;width:20px">x</div></td><td style="height:40px">a</td></tr><tr><td style="height:50px">b</td></tr></table>')
      # …and the three subtrees that are their OWN percentages' containing block, so the cell never asks:
      # a definite-height child, a nested table, an out-of-flow box.
      expect_parity('<table style="height:150px"><tr><td><div style="height:40px"><div style="height:50%;width:20px">x</div></div></td></tr></table>')
      expect_parity('<table style="height:150px"><tr><td><table style="border-spacing:0"><tr><td style="height:50%">n</td></tr></table></td></tr></table>')
      expect_parity('<table style="height:150px"><tr><td style="position:relative"><div style="position:absolute;height:50%;width:10px"></div>own</td></tr></table>')
    end

    # A cell's own `min-height` / `max-height` do NOT apply in the block axis (§17.5.3 leaves their effect
    # undefined; Chrome and Firefox read both as `auto`), and native's BOX already knew that — but the content
    # height it hands the descendants as their pass-2 basis was clamped by them anyway. A `height: 50%` child of
    # a `max-height: 20px` cell in a 200px table came out 10, and of a `min-height: 500px` cell, 250. Chrome says
    # 97 for all three of these, the same as the cell with no clamp at all — which is what pins it: parity alone
    # cannot tell a shared rule from a shared mistake, and this is a figure only Chrome can settle.
    it 'ignores a cell min/max-height when resolving its percentage-height descendants (Chrome: 97 either way)' do
      [
        '<table style="height:200px"><tr><td style="max-height:20px"><div id="k" style="height:50%;width:10px">x</div></td></tr></table>',
        '<table style="height:200px"><tr><td style="min-height:500px"><div id="k" style="height:50%;width:10px">x</div></td></tr></table>',
        '<table style="height:200px"><tr><td><div id="k" style="height:50%;width:10px">x</div></td></tr></table>'
      ].each do |body|
        expect_parity(body)
        session = simulated_session(page(body))
        session.visit '/'
        expect(session.evaluate_script("document.getElementById('k').getBoundingClientRect().height")).to eq(97), body
      end
    end

    # A `display: contents` wrapper between the cell and the percentage box generates NO box, so for layout the
    # cell lays that box out directly and is its containing block (CSS Display 3 §3.1). The walk used to compare
    # the RECORD's parent — which looks through, because the record tree is built from `layoutChildren` — with
    # the FLAT-TREE parent, which does not; they disagreed here, the walk read that as "native has no basis for
    # this box", and sent the percentage RESOLVED against the oracle's own `_lbCbH`: the cell's height from the
    # PREVIOUS layout pass. Native then measured the cell against a figure derived from its own last answer.
    # (`layoutParent` is the fix, and it is the general rule — this is just the shape that reached it.)
    it 'resolves a percentage-height box under a box-less wrapper against the CELL' do
      expect_parity('<table style="height:150px;border-spacing:0"><tr><td><div style="display:contents"><div style="height:50%;width:20px">x</div></div></td></tr><tr><td style="height:30px">r2</td></tr></table>')
      expect_parity('<table style="height:150px;border-spacing:0"><tr><td><div style="display:contents"><div style="display:contents"><div style="min-height:50%;width:20px">x</div></div></div></td></tr><tr><td style="height:30px">r2</td></tr></table>')
      expect_parity('<table style="height:150px;border-spacing:0"><tr><td style="height:60px"><div style="display:contents"><div style="height:50%;width:20px">x</div></div></td><td style="vertical-align:baseline">s</td></tr></table>')
    end

    # A `vertical-align: baseline` cell aligns its FIRST baseline to the row's — and a percentage-height box in
    # it moves every line UNDER it when the second pass resolves that box. The oracle read the pass-1 baseline
    # under a comment claiming it is stable across the re-layout; it is not, and Chrome agrees with the pass-2
    # reading. Measured: an empty `height: 50%` div followed by text sits at y 1 (no shift — the cell's first
    # line is now below the row's baseline), while the same div WITH its own text in it sits at 30, and so does
    # a plain `height: 20px` one. The oracle is the engine that moved.
    it 'aligns a baseline cell on its SECOND-pass baseline (Chrome: y 1 with the line pushed down, 30 without)' do
      deep = '<td style="vertical-align:baseline;font:40px monospace">Ay</td>'
      {
        %(<div id="k" style="height:50%;width:20px"></div>x) => [1, 74],
        %(<div id="k" style="height:50%;width:20px">q</div>) => [30, 74],
        %(<div id="k" style="height:20px;width:20px">q</div>) => [30, 20]
      }.each do |inner, (y, h)|
        body = %(<table id="t" style="height:150px;border-spacing:0"><tr><td style="vertical-align:baseline">#{inner}</td>#{deep}</tr></table>)
        expect_parity(body)
        session = simulated_session(page(body))
        session.visit '/'
        got = session.evaluate_script("(() => { const e = document.getElementById('k'); const t = document.getElementById('t').getBoundingClientRect(); const r = e.getBoundingClientRect(); return [+(r.y - t.y).toFixed(2), +r.height.toFixed(2)]; })()")
        expect(got).to eq([y, h]), inner
      end
    end

    # A box anchored to a CELL resolves its insets against the ROW-tall box (measured: a `bottom: 0` overlay in a
    # 42px cell sits at 36, where the cell's own 12px content flow would put it at 6) — the oracle now defers
    # those until `layoutTable` has the row height, which is also when native places them.
    it 'places a box anchored to a cell against the row-tall box' do
      %w[middle top bottom].each do |va|
        expect_parity(%(<table style="border-spacing:0"><tr><td style="position:relative;vertical-align:#{va}"><div style="position:absolute;bottom:0;width:6px;height:6px"></div><div style="height:10px"></div></td><td style="height:40px"><div style="height:40px"></div></td></tr></table>))
      end
      expect_parity('<table style="border-spacing:0"><tr><td style="position:relative"><div style="position:absolute;height:100%;width:6px"></div><div style="height:10px"></div></td><td style="height:40px"><div style="height:40px"></div></td></tr></table>')
      # …including a cell with a DECLARED height, whose box looks definite but is still only a minimum until the
      # row speaks (measured: the overlay sits at 36 in a 42px row, not at 16 where the cell's own 20px would).
      expect_parity('<table style="border-spacing:0"><tr><td style="position:relative;height:20px"><div style="position:absolute;bottom:0;width:6px;height:6px"></div><div style="height:10px"></div></td><td style="height:40px"><div style="height:40px"></div></td></tr></table>')
      expect_parity('<table style="border-spacing:0"><tr><td style="position:relative;height:20px"><div style="position:absolute;height:100%;width:6px"></div><div style="height:10px"></div></td><td style="height:40px"><div style="height:40px"></div></td></tr></table>')
      # …and one still WAITING for an ancestor's size takes the same delta in its static position, so it lands
      # where the moved flow is (measured: 26 in a cell whose content the row centred, not 1).
      expect_parity('<div style="position:relative"><table style="border-spacing:0"><tr><td style="vertical-align:middle"><div style="position:absolute;width:6px;height:6px"></div><div style="height:10px"></div></td><td style="height:60px"><div style="height:60px"></div></td></tr></table></div>')
      expect_parity('<table style="position:relative;border-spacing:0"><tr><td style="vertical-align:middle"><div style="position:absolute;width:6px;height:6px"></div><div style="height:10px"></div></td><td style="height:60px"><div style="height:60px"></div></td></tr></table>')
      expect_parity('<div style="position:relative"><table style="border-spacing:0;height:200px"><tr><td style="height:20px">a</td></tr><tr><td style="vertical-align:top"><div style="position:absolute;width:6px;height:6px"></div><div style="height:10px"></div></td></tr></table></div>')
      # …while a STATIC-position one is placed in the flow and moves down with the content it follows.
      expect_parity('<table style="border-spacing:0"><tr><td style="vertical-align:middle"><div style="position:absolute;width:6px;height:6px"></div><div style="height:10px"></div></td><td style="height:60px"><div style="height:60px"></div></td></tr></table>')
      expect_parity('<table style="border-spacing:0"><tr><td style="vertical-align:bottom"><div style="position:absolute;top:5px;left:5px;width:6px;height:6px"></div><div style="height:10px"></div></td><td style="height:60px"><div style="height:60px"></div></td></tr></table>')
    end

    it 'reads a row height declaration the way Chrome does: a plain length or percentage, nothing else' do
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:0%"><td>a</td></tr><tr><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:0"><td>a</td></tr><tr><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:calc(50% + 10px)"><td>a</td></tr><tr><td>b</td></tr></table>')
      expect_parity('<table style="border-spacing:0;height:100px"><tr style="height:auto"><td>a</td></tr><tr style="height:40px"><td>b</td></tr></table>')
    end
  end
  # A CAPTION is the cell's twin: it floors the table's intrinsic width, and where native cannot measure it the
  # oracle's contribution rides rec[84..85] (`table_min_max_with_caption` reads that and never descends). So it
  # is the same measure BOUNDARY a pushed cell is — marked measured instead, a caption holding an atomic native
  # cannot lay out declined the whole pass.
  # WHICH of the two a cell is — measured, or a boundary contributing the oracle's figure — is decided by
  # TRYING: the walk is the only thing that knows what it can build, so a cell it declines under the measuring
  # obligation is rolled back and re-walked as a boundary. Every shape here holds content the walk refuses for a
  # reason `nlIntrinsicMeasurable` does not model, so under a predicate-decided gate each took its whole table
  # down; `table-layout: fixed` is here too, where native measures no cell at all and the obligation was never
  # real. The one thing that cannot be recovered is a subtree the walk cannot build EITHER way.
  describe 'a cell the walk declines to measure is re-walked as a boundary' do
    it 'lays out an auto, a fixed and a measured table around such a cell' do
      WalkRefusals::ATOMIC.each do |inner|
        # An AUTO table sizes its columns from the cells, so the contribution is asked for and pushed; a FIXED
        # one with a width sizes them from the first row and asks for nothing at all, so nothing is pushed.
        [[%{<div style="width:400px"><table><tr><td>a #{inner}</td></tr></table></div>}, 1],
         [%{<div style="width:400px"><table style="table-layout:fixed;width:300px"><tr><td>a #{inner}</td></tr></table></div>}, 0],
         [%{<div style="width:400px"><div style="writing-mode:vertical-lr"><table><tr><td>a #{inner}</td></tr></table></div></div>}, 1]].each do |body, pushed|
          r = run_shadow(body)
          expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
          expect(r['pushedContributions']).to eq(pushed), "the cell's contribution: #{r.inspect}"
        end
      end
    end
    # The rollback has to put EVERY stream back — records, runs, grids, the node/index maps, the statistics — so
    # where in the attempted subtree the refusal sits cannot change the outcome. A stream someone forgets to
    # restore shows up here as a differing node count or a double-counted grid.
    it 'leaves the same records behind wherever the refusal sits in the subtree' do
      refusal = WalkRefusals::POSITIONED   # (any of them; what is under test is the bookkeeping)
      inert = '<div style="width:3px;height:2px"></div>' * 4
      grid = '<div style="display:grid;grid-template-columns:min-content;width:50px"><div>g</div></div>'
      early = run_shadow(%{<div style="width:400px"><table><tr><td>#{grid}#{refusal}#{inert}</td></tr></table></div>})
      late  = run_shadow(%{<div style="width:400px"><table><tr><td>#{grid}#{inert}#{refusal}</td></tr></table></div>})
      expect(early).to include('ok' => true, 'mismatches' => 0), early.inspect
      expect(late['nodes']).to eq(early['nodes']), "#{early.inspect} vs #{late.inspect}"
      expect(late['compared']).to eq(early['compared']), "#{early.inspect} vs #{late.inspect}"
      %w[nativeIntrinsicGrids nativeFlexRows nativeOutOfFlow nativeAtomics pushedContributions].each do |k|
        expect(late[k]).to eq(early[k]), "#{k}: #{early.inspect} vs #{late.inspect}"
      end
      expect(early['nativeIntrinsicGrids']).to eq(1), "the grid inside the re-walk should be counted once: #{early.inspect}"
    end
    it 'still measures a cell it can, and still declines what no walk can build' do
      r = run_shadow('<table style="border-spacing:0"><tr><td style="padding:0">a <span style="display:inline-block">ok</span></td></tr></table>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'pushedContributions' => 0, 'nativeAtomics' => 1), r.inspect
      declined = run_shadow(%(<table style="border-spacing:0"><tr><td style="padding:0">#{WalkRefusals::POSITIONED_INNER}</td></tr></table>))
      expect(declined).to include('ok' => false, 'reason' => 'block-level-box-unplaceable'), declined.inspect
    end
  end

  describe 'a caption whose content native cannot lay out pushes its contribution' do
    # The tally counts a contribution native was ASKED for and could not produce — and a caption's always is: its
    # min-content floors the table's width on every layout (`caption_floor`), not only where the table's own
    # contribution is asked.
    def expect_pushed_contribution(body, count = 1)
      r = run_shadow(body)
      expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
      expect_no_dropped_records(r, body)
      expect(r['pushedContributions']).to eq(count), "expected the oracle's contribution to be pushed: #{r.inspect}"
    end

    it 'lays out a table whose caption holds an inline-block native cannot measure' do
      atomic = %(a #{WalkRefusals::POSITIONED})
      # asked for, and native cannot produce it: a vertical-writing-mode block child and a `min-content` track
      expect_pushed_contribution(%{<div style="width:400px"><div style="writing-mode:vertical-lr"><table><caption>#{atomic}</caption><tr><td>x</td></tr></table></div></div>})
      expect_pushed_contribution(%{<div style="display:grid;grid-template-columns:min-content;width:400px"><table style="border-spacing:0"><caption>#{atomic}</caption><tr><td style="padding:0">x</td></tr></table></div>})
      # …asked for and native CAN produce it, so nothing is pushed
      expect_pushed_contribution(%{<div style="display:grid;grid-template-columns:min-content;width:400px"><table style="border-spacing:0"><caption>cap</caption><tr><td style="padding:0">x</td></tr></table></div>}, 0)
      # …and a normal-flow table, which asks too
      expect_pushed_contribution(%{<table style="border-spacing:0"><caption>#{atomic}</caption><tr><td style="padding:0">x</td></tr></table>})
      expect_pushed_contribution(%{<table style="border-spacing:0"><caption>cap</caption><tr><td style="padding:0">x</td></tr></table>}, 0)
    end
    # Measuring the caption is TRIED (`walkAttempt`), never promised: each of these is a refusal
    # `nlIntrinsicMeasurable` does not model, and the walk rolls the caption back to a parked subtree whose
    # contribution the oracle pushes, rather than declining the table over it.
    it 'parks a caption whose content the walk refuses, rather than declining the table' do
      WalkRefusals::ATOMIC.each do |inner|
        expect_pushed_contribution(%{<div style="width:400px"><table><caption>a #{inner}</caption><tr><td>x</td></tr></table></div>})
      end
    end
  end

  # An ORPHAN `display: table-row` — one with no table around it — is not CSS Tables' anonymous table in this
  # engine. `layoutBox` says so in as many words ("a browser wraps it in an anonymous table and we don't") and
  # routes it to `layoutFlexRow` with `equalShare` and a PHYSICAL LTR plan. The walk emits it as a flex record
  # for exactly that reason, and it is 1,296 of the `pseudo` sweep's declines: every one a
  # `::before { display: table-row }`.
  #
  # ONLY AN EMPTY ONE, and the boundary is the whole of what these arms are about. For a row with content the
  # oracle is two things at once — it MEASURES through the block-stacking arm of `contentIntrinsicWidths` (its
  # display is `table-row`, so the flex arm there never runs) and LAYS OUT through `layoutFlexRow`, which sums
  # along the row and drops bare text — and one record cannot say both. Taking those made 249 `pseudo` shapes
  # mismatch. The equal-share arithmetic goes with them: not one shape in the corpus, the sweeps or these
  # specs is an orphan row with element children, so it would ship unexecuted.
  describe 'an orphan display: table-row' do
    def expect_declines(body, reason)
      r = run_shadow(body)
      expect(r).to include('ok' => false, 'reason' => reason), body
    end

    it 'lays an empty one out natively, whatever flex properties it declares' do
      ['', 'flex-direction:column', 'flex-wrap:wrap', 'direction:rtl', 'writing-mode:vertical-rl'].each do |extra|
        expect_parity(%(<div style="width:400px"><div style="display:table-row;#{extra}"></div><div style="height:4px"></div></div>))
      end
      # …a child that generates NO BOX leaves it empty: a comment, a `display: none` element.
      expect_parity('<div style="width:400px"><div style="display:table-row"><!--c--></div><div style="height:4px"></div></div>')
      expect_parity('<div style="width:400px"><div style="display:table-row"><span style="display:none">x</span></div>' \
                    '<div style="height:4px"></div></div>')
      # …and the shape the 1,296 actually were.
      expect_parity('<style>.p::before{content:"";display:table-row}</style>' \
                    '<div style="width:400px"><div class="p"></div><div style="height:4px"></div></div>')
    end

    # …and one of nothing but bare TEXT — the shape every orphan row in the sweeps is, a generated `content` — as the
    # two things a record can say at once: the layout drops the text (no item; the line-height floor in rec[52]) and
    # the MEASURE reads it off the record's own run stream (`NL_FLAG_MEASURES_RUNS`, the oracle's block-stacking arm).
    # 864 `pseudo` declines until 2026-09-26. Chrome's boxes around it (a float, an inline-block, `max-content`).
    it 'lays one of bare text out natively, measured by its text' do
      {
        '<style>.p::before{content:"a longer generated string";display:table-row}</style><div style="width:400px;font:16px monospace"><div id="m" class="p" style="float:left"></div></div>' => [240.016, 22],
        '<style>.p::before{content:"xx";display:table-row}</style><div style="width:400px;font:16px monospace"><div id="m" class="p" style="display:inline-block"></div>y</div>' => [19.2, 22],
        '<style>.p::before{content:"a longer generated string";display:table-row}</style><div style="width:400px;font:16px monospace"><div id="m" class="p" style="width:max-content">z</div></div>' => [240.016, 44]
      }.each do |body, (w, h)|
        expect_parity(body)
        rect = laid_out_rect(body)
        expect(rect[2]).to be_within(0.02).of(w), body
        expect(rect[3]).to eq(h), body
      end
      expect_parity('<div style="width:400px"><div style="display:table-row">x</div><div style="height:4px"></div></div>')
    end

    # …and one of BLOCK-LEVEL element children as the oracle's EQUAL-SHARE flex row (`NL_FLAG_EQUAL_SHARE`): each item
    # POSITIONED at `floor(available / n)` of the row — a table at its own width where that is wider — and laid out at
    # its own used width, a declared one kept; measured as the widest child. A cell in such a row is an orphan too, a
    # plain block. 72 `orphanpart` declines until 2026-09-26, and the 589 shapes of `rv47share` hold the multi-item
    # arithmetic. SHARED with Chrome, which wraps the row in an anonymous table: a block child after `aa` sits at
    # x 150 in both engines and under it (0, 22) in Chrome, a second cell at 150 where Chrome shrinks both to 19.2.
    it 'lays one of block children out natively, each at an equal share' do
      blocks = '<div style="width:300px;font:16px monospace"><div style="display:table-row"><div>aa</div><div id="m" style="width:50px">w</div></div></div>'
      cells = '<div style="width:300px;font:16px monospace"><div style="display:table-row"><div style="display:table-cell">aa</div><div id="m" style="display:table-cell">bb</div></div></div>'
      [blocks, cells].each {|body| expect_parity(body) }
      expect_shared_gap(laid_out_rect(blocks)[0], shared: 150, chrome: 0, what: "#{blocks}: #m x")
      expect_shared_gap(laid_out_rect(cells)[2], shared: 150, chrome: 19.2, what: "#{cells}: #m width")
      table = '<div style="width:300px;font:16px monospace"><div style="display:table-row"><table style="border-spacing:0"><tr><td>wideunbreakabletablecontent</td></tr></table>' \
              '<div id="m">b</div><div>c</div></div></div>'
      expect_parity(table)
      expect(laid_out_rect(table)[0]).to be_within(0.02).of(261.2)   # past its 100px share, at the table's own width (both engines)
      r = run_shadow(blocks, '{noOracle: true}')
      expect(r).to include('ok' => true, 'mismatches' => 0)
      expect(r['oracleReads'].to_h).to be_empty, r.inspect
    end

    # …and on that line in DOCUMENT order, left to right, whatever its `flex-direction` or its children's `order` say:
    # the oracle lays it out on `PHYSICAL_ROW_PLAN`, and an orphan row's children are no flex items (Chrome keeps them
    # in document order in its anonymous table). Review rv47: the walk sent the reverse bit and sorted by `order`, so
    # native ran the line from the right, and hung its baseline off the `order: -1` item where the oracle read the
    # first — body 41 against 48 in a baseline-aligned flex.
    it 'keeps one of block children in document order' do
      host = '<div style="display:flex;align-items:baseline;width:300px;font:16px monospace">%s<div style="font-size:30px">Z</div></div>'
      {
        '<div style="display:table-row;flex-direction:row-reverse"><div id="m">o1</div><div style="font-size:24px">big</div></div>' => 0,
        '<div style="display:table-row;flex-flow:column-reverse wrap"><div id="m">o1</div><div>o2</div></div>' => 0,
        '<div style="display:table-row"><div style="font-size:24px">big</div><div id="m" style="order:-1">o1</div></div>' => 21
      }.each do |row, x|
        body = format(host, row)
        expect_parity(body)
        expect(laid_out_rect(body)[0]).to eq(x), body
      end
    end

    # …and REFUSES one with an INLINE-level or floated element child, which the oracle's measure puts on a LINE where the
    # block walk stacks it. Without these the narrowing is a silent one: the gate could widen back to "any orphan row".
    it 'refuses one with inline-level children' do
      expect_declines('<div style="width:400px"><div style="display:table-row"><span>aaaa</span><span>bbbb</span></div></div>',
                      'flex-container-unsupported')
      # …a `<br>` is an element and so an item: the row is not empty.
      expect_declines('<div style="width:400px"><div style="display:table-row"><br></div></div>', 'flex-container-unsupported')
    end
  end

  # An EMPTY row group (a `<tbody>` with no rows — Discourse's topic list) is laid out natively where the oracle boxes it:
  # zero height at the grid's bottom edge, its trailing spacing included, the rows' width — the table's content box
  # where there is no column. It declined until 2026-09-26 (`table-group-empty`). SHARED: Chrome keeps it in DOCUMENT
  # order (y 0 before a populated `<tbody>`, where both engines say 28) and shares an imposed height out to it too.
  it 'lays an empty row group out natively' do
    [
      '<table style="width:300px"><thead><tr><th>Topic</th><th>Replies</th></tr></thead><tbody id="m"></tbody></table>',
      '<table style="width:300px"><tbody id="m"></tbody></table>',
      '<table style="width:300px;height:100px"><thead><tr><th>T</th></tr></thead><tbody id="m">  </tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
      '<table style="width:300px;border-collapse:collapse"><caption>cap</caption><tbody id="m"></tbody><tbody><tr><td style="border:3px solid">a</td></tr></tbody></table>',
      '<div style="display:table;width:200px"><div id="m" style="display:table-row-group"></div><div style="display:table-row"><div style="display:table-cell">x</div></div></div>'
    ].each {|body| expect_parity(body) }
    expect(laid_out_rect('<table style="width:300px"><tbody id="m"></tbody></table>')).to eq([0, 0, 300, 0])
    ordered = '<table style="width:300px;border-spacing:4px"><tbody id="m"></tbody><tbody><tr><td>a</td></tr></tbody></table>'
    expect_parity(ordered)
    expect_shared_gap(laid_out_rect(ordered)[1], shared: 28, chrome: 0, what: "#{ordered}: #m y")
  end

  # …and every OTHER table part with no table to lay it out — a cell, a row group, a caption — which the oracle
  # lays out as a plain BLOCK (`layoutElementInner`'s fallthrough) and the walk now takes as one: 1,100 declines of
  # `rv5nw` (`block-level-box-unplaceable`) until 2026-09-24. What still makes one a cell is what the DISPLAY says:
  # its block-axis min/max do not apply (Chrome agrees, 22 tall either way), where a percentage width is its own —
  # a table's cell hands that to its column instead — and resolved against the block native lays it out in, with
  # no oracle box read. Chrome wraps each in an ANONYMOUS table: shrink-to-fit (48 for "aa bb" where both engines
  # fill the 200; 96.03 for the 50% cell where both say 100) and consecutive cells side by side (the second at
  # x 19.2, y 0, where both stack it at y 22), with no margins. Shared, so pinned rather than fixed.
  # A CELL's width that is a `calc()` or a comparison of a percentage constrains no column — Chrome, the oracle and
  # native alike split the 400 as if nothing were declared — and reaches the cell's box no more than a plain one does:
  # the box is its column. So the walk sends none of it, with no oracle box read since 2026-09-26, where it resolved it
  # against the oracle's containing block for a figure nothing read. Chrome's width (377.75, its LayoutUnit of 377.78),
  # and the narrow column a wider declaration does not widen (10.27 in Chrome, 10.26 in both).
  it 'resolves a calc() or comparison cell width natively, constraining no column' do
    ['calc(40% + 10px)', 'clamp(30px, 50%, 200px)', 'min(90%, 250px)', 'max(60%, 40px)'].each do |w|
      body = %(<table style="width:400px;border-spacing:0;font:16px monospace"><tr><td id="m" style="width:#{w};padding:0">lorem ipsum dolor</td>) +
             '<td style="padding:0">x</td></tr></table>'
      expect_parity(body)
      expect(laid_out_rect(body)[2]).to be_within(0.05).of(377.75), w
      r = run_shadow(body, '{noOracle: true}')
      expect(r).to include('ok' => true, 'mismatches' => 0)
      expect(r['oracleReads'].to_h).to be_empty, "#{w}: #{r.inspect}"
    end
    ['calc(90% + 10px)', 'max(90%, 10px)'].each do |w|
      body = %(<table style="width:400px;border-spacing:0;font:16px monospace"><tr><td id="m" style="width:#{w};padding:0">a</td>) +
             '<td style="padding:0">lorem ipsum dolor sit amet consectetur</td></tr></table>'
      expect_parity(body)
      expect(laid_out_rect(body)[2]).to be_within(0.02).of(10.26), w
    end
  end
  # …and a horizontal cell's `min-width` / `max-width` percentage reaches its box no more than its width does — a 60%
  # minimum and a 10% maximum leave the column alone, in Chrome and in both engines — so the record carries none: the
  # walk resolved them against the oracle's table until 2026-09-26, and PUSHED every flex container holding such a
  # table for it (`descendant-walk-percentage: min-width route`). Chrome's widths.
  it 'lays out a cell\'s percentage min-width and max-width natively, reaching nothing' do
    {
      '<table style="width:400px;border-spacing:0;font:16px monospace"><tr><td id="m" style="min-width:60%;padding:0">a</td><td style="padding:0">b</td></tr></table>' => 200,
      '<table style="width:400px;border-spacing:0;font:16px monospace"><tr><td id="m" style="max-width:10%;padding:0">aaaa bbbb cccc dddd</td><td style="padding:0">b</td></tr></table>' => 379.97,
      '<table style="width:400px;border-spacing:0;font:16px monospace"><tr><td id="m" style="min-width:max(20%, calc(10% + 50px));padding:0">a</td><td style="padding:0">b</td></tr></table>' => 200,
      '<div style="display:flex;flex-direction:column;width:320px;height:200px;font:16px monospace"><table style="border-spacing:2px"><tr><td id="m" style="min-width:30%">aa bb</td><td>cc</td></tr>' \
      '<tr><td colspan="2">dd ee ff</td></tr></table><div style="width:40px">y</div></div>' => 220.48
    }.each do |body, w|
      expect_parity(body)
      expect(laid_out_rect(body)[2]).to be_within(0.05).of(w), body
      r = run_shadow(body, '{noOracle: true}')
      expect(r).to include('ok' => true, 'mismatches' => 0)
      expect(r['oracleReads'].to_h).to be_empty, "#{body}: #{r.inspect}"
    end
  end
  # A FIXED-layout table's first-row cell with a percentage padding: its column is its declared width plus its
  # horizontal edges resolved against the width being shared out, the oracle's `fixedColumnWidths` — native resolves
  # the cell's pairs and programs at that width, where the walk declined the table until 2026-09-26
  # (`table-fixed-pct-padding`, 72 sweep shapes). SHARED: Chrome counts a percentage padding as NOTHING in that
  # computation (`padding: 0 10%` beside `width: 100px` is a 100px column there, 180 in both engines; `max(5%, 30px)`
  # counts 30 in all three).
  it 'lays out a fixed table whose first-row cell has a percentage padding natively' do
    [
      ['<table style="table-layout:fixed;width:400px;border-spacing:0;font:16px monospace"><tr><td id="m" style="width:100px;padding:0 10%">a</td><td>b</td></tr></table>', 180, 100],
      ['<table style="table-layout:fixed;width:400px;border-spacing:0;font:16px monospace"><tr><td style="width:100px;padding:0 max(5%, 30px)">a</td><td id="m">b</td></tr></table>', 240, nil]
    ].each do |body, w, chrome|
      expect_parity(body)
      if chrome
        expect_shared_gap(laid_out_rect(body)[2], shared: w, chrome: chrome, what: body)
      else
        expect(laid_out_rect(body)[2]).to eq(w)   # Chrome
      end
      r = run_shadow(body, '{noOracle: true}')
      expect(r).to include('ok' => true, 'mismatches' => 0)
      expect(r['oracleReads'].to_h).to be_empty, "#{body}: #{r.inspect}"
    end
  end
  # A table may hold row GROUPS and BARE rows side by side (§17.2.1 wraps neither): the rows stack in render order —
  # header, then bodies and bare rows in document order, then footers — each group's box around its own. The walk
  # emits each group where its first row comes up and a bare row where it stands, where it declined the mix until
  # 2026-09-26 (`table-grouped-and-bare-rows`, 400 sweep shapes). Chrome's boxes, and no oracle read.
  it 'lays out a table holding row groups and bare rows side by side' do
    {
      '<div style="display:table;font:16px monospace;border-spacing:0"><div style="display:table-row-group"><div style="display:table-row"><div style="display:table-cell">a</div></div></div>' \
      '<div style="display:table-row"><div id="m" style="display:table-cell">bb</div></div></div>' => [0, 22, 19.2, 22],
      '<div style="display:table;font:16px monospace;border-spacing:0"><div style="display:table-footer-group"><div style="display:table-row"><div style="display:table-cell">f</div></div></div>' \
      '<div style="display:table-row"><div id="m" style="display:table-cell">bb</div></div><div style="display:table-header-group"><div style="display:table-row"><div style="display:table-cell">h</div></div></div></div>' => [0, 22, 19.2, 22],
      '<div style="display:table;font:16px monospace;border-spacing:2px"><div style="display:table-row"><div style="display:table-cell">x</div></div>' \
      '<div id="m" style="display:table-row-group">tx <span style="display:inline-block;width:20px;height:5px"></span></div><div style="display:table-row"><div style="display:table-cell">b</div></div></div>' => [2, 26, 48.8, 22]
    }.each do |body, rect|
      expect_parity(body)
      laid_out_rect(body).zip(rect).each {|g, w| expect(g).to be_within(0.02).of(w), body }
      r = run_shadow(body, '{noOracle: true}')
      expect(r).to include('ok' => true, 'mismatches' => 0)
      expect(r['oracleReads'].to_h).to be_empty, "#{body}: #{r.inspect}"
    end
  end
  describe 'an orphan cell, row group or caption' do
    it 'lays one out as a block whose block-axis min/max do not apply' do
      %w[min-height:40px max-height:5px].each do |style|
        body = %(<div style="width:200px;font:16px monospace"><div id="m" style="display:table-cell;#{style}">aa bb</div></div>)
        expect_parity(body)
        expect(laid_out_rect(body)[3]).to eq(22)
      end
      body = '<div style="width:200px;font:16px monospace"><div id="m" style="display:table-cell;width:50%">aa bb</div></div>'
      expect_parity(body)
      expect_shared_gap(laid_out_rect(body)[2], shared: 100, chrome: 96.03, what: "#{body}: #m width")
      # …with no oracle box read — and an orphan ROW native lays out itself (it holds no in-flow item) likewise
      [
        body,
        '<div style="width:200px"><div style="display:table-row;padding:10%;width:50%"></div><p>after</p></div>'
      ].each do |oracle_free|
        r = run_shadow(oracle_free, '{noOracle: true}')
        expect(r).to include('ok' => true, 'mismatches' => 0)
        expect(r['oracleReads'].to_h).to be_empty, r.inspect
      end
      %w[table-row-group table-header-group table-caption].each do |display|
        expect_parity(%(<div style="width:200px;font:16px monospace"><div style="display:#{display}">aa bb</div><p>after</p></div>))
      end
      # …through a row group with no table of its own, and in a vertical writing mode, where the width is the axis
      # that goes unclamped.
      expect_parity('<div style="width:200px;font:16px monospace"><div style="display:table-row-group"><div style="display:table-cell;max-height:5px">aa bb</div></div></div>')
      expect_parity('<div style="width:200px;font:16px monospace"><div style="writing-mode:vertical-lr;height:120px"><div style="display:table-cell;max-width:20px">aa bb cc dd</div></div></div>')
    end

    it 'fills the width and stacks where Chrome wraps it in an anonymous table' do
      {
        '<div id="m" style="display:table-cell">aa bb</div>'                                      => [2, 200, 48.02],
        '<div style="display:table-cell">aa</div><div id="m" style="display:table-cell">bb</div>' => [1, 22, 0],
        # …a cell's margins, which a table cell does not have (Chrome: y 0; both engines let it collapse to 10)
        '<div id="m" style="display:table-cell;margin:10px 0">aa bb</div>'                        => [1, 10, 0],
        # …and the other parts: a caption as wide as the words it wraps (19.2 by 44), a row group shrink-to-fit
        '<div id="m" style="display:table-caption">aa bb</div>'                                   => [2, 200, 19.2],
        '<div id="m" style="display:table-row-group">aa bb</div>'                                 => [2, 200, 48.02]
      }.each do |cells, (index, shared, chrome)|
        body = %(<div style="width:200px;font:16px monospace">#{cells}</div>)
        expect_parity(body)
        expect_shared_gap(laid_out_rect(body)[index], shared: shared, chrome: chrome, what: "#{body}: #m rect[#{index}]")
      end
    end
  end

end
