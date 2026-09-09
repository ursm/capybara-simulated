# frozen_string_literal: true
# Native layout — CSS tables (§17), geometry shadow-parity. Increment t1: a border-collapse:SEPARATE,
# auto-layout `display:table` in normal flow — table > (table-row-group | table-row)* > table-cell*, a
# rectangular grid, LTR, no spans. Each cell's used border box (its column width × its unified row height) is
# resolved by the oracle and PUSHED (like a flex item); native reassembles the column/row tracks, prefix-sums
# them with border-spacing to position every cell, and derives every row, row-group and the table's OWN box
# (a table self-sizes from Σtracks + spacing). Still DECLINES to JS — colspan/rowspan, border-collapse:collapse,
# caption, <col>/<colgroup>, thead/tfoot (render reorder), table-layout:fixed, inline-table, ragged/anonymous
# grids, rtl, nested tables, and an imposed table height (declared / attribute / min / max — the track
# self-size can't reproduce the two-phase). A position:relative cell IS supported (the oracle ignores the
# offset, so the cell stays grid-positioned). Each bail is an A/B: the feature-carrying input declines, a
# plain table stays native. V8 only.
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

  # A/B bails — the feature declines; a plain table stays native.
  def a_bails_b_native(feature, plain = '<table style="border-spacing:4px"><tr><td style="width:40px">a</td><td style="width:40px">b</td></tr></table>')
    expect(run_shadow(feature)['ok']).to be(false), "expected #{feature.inspect} to bail"
    expect(run_shadow(plain)['ok']).to be(true), 'expected the plain table to stay native'
  end

  it('declines a colspan') { a_bails_b_native('<table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table>') }
  it('declines a rowspan') { a_bails_b_native('<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>') }
  it('declines border-collapse:collapse (half-borders)') { a_bails_b_native('<table style="border-collapse:collapse"><tr><td style="border:1px solid">a</td></tr></table>') }
  it('declines a caption') { a_bails_b_native('<table><caption>cap</caption><tr><td>a</td></tr></table>') }
  it('declines a colgroup/col') { a_bails_b_native('<table><colgroup><col></colgroup><tr><td>a</td></tr></table>') }
  it('declines thead/tfoot (render reorder)') { a_bails_b_native('<table><thead><tr><td>h</td></tr></thead><tbody><tr><td>b</td></tr></tbody></table>') }
  it('declines table-layout:fixed') { a_bails_b_native('<table style="table-layout:fixed;width:200px"><tr><td>a</td><td>b</td></tr></table>') }
  it('declines inline-table') { a_bails_b_native('<span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">a</span></span></span>') }
  it('declines a ragged grid (rows of unequal cell counts)') { a_bails_b_native('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>') }
  it('declines an rtl table (column reversal)') { a_bails_b_native('<table dir="rtl"><tr><td style="width:40px">a</td><td style="width:60px">b</td></tr></table>') }
  it('declines a table with a declared height below its natural grid height') { a_bails_b_native('<table style="height:10px;border-spacing:4px"><tr><td style="height:50px">a</td></tr></table>') }
  it('declines a table with a min-height floor') { a_bails_b_native('<table style="min-height:200px"><tr><td style="height:50px">a</td></tr></table>') }
  it('declines an empty row group (the oracle boxes it below the grid)') { a_bails_b_native('<table style="border-spacing:4px"><tbody></tbody><tbody><tr><td style="width:40px;height:20px">a</td></tr></tbody></table>') }
end
