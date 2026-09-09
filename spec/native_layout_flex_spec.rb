# frozen_string_literal: true
# Native layout — flex (§9.7), geometry shadow-parity. The item SIZING is resolved JS-side (each item's used
# main+cross size rides its record, like a float's shrink-to-fit width); native does only the PLACEMENT —
# main-axis distribution (justify-content + gap + main-axis auto margins), cross-axis alignment
# (align-items/self + cross-axis auto margins + first/last baseline), and the container's own box. Supported:
# row / column, nowrap / wrap, main-axis reverse, nested flex, position:relative offsets, main- and cross-axis
# auto item margins, row & column min/max-height (incl. declared-height wrapping columns) + a column's cross
# min/max-width, align-items/self:baseline & last baseline, out-of-flow (absolute / fixed) items placed at
# their oracle-resolved box. Still DECLINES to JS — rtl / vertical writing modes, a WRAPPING AUTO-height
# column with a max-height (it breaks its lines against that capacity), wrap-reverse, inline-flex,
# position:sticky items, replaced / inline-block items, bare text. Each bail is an A/B: the feature-carrying
# input declines, a sibling without it stays native. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout flex parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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

  it 'matches justify-content:space-between across three items' do
    expect_parity('<div style="display:flex;justify-content:space-between;width:600px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches justify-content:center with a column gap' do
    expect_parity('<div style="display:flex;justify-content:center;gap:20px;width:600px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches align-items:center with mixed item heights' do
    expect_parity('<div style="display:flex;align-items:center;height:100px;width:400px"><div style="width:50px;height:30px"></div><div style="width:50px;height:60px"></div></div>')
  end

  it 'matches align-items:flex-end and a per-item align-self' do
    expect_parity('<div style="display:flex;align-items:flex-end;height:100px;width:400px"><div style="width:50px;height:30px"></div><div style="width:50px;height:40px;align-self:center"></div></div>')
  end

  it 'matches align-items:baseline across text items of different font sizes' do
    expect_parity('<div style="display:flex;align-items:baseline;width:400px;font-size:16px"><div style="font-size:32px">Ag</div><div>xy</div></div>')
  end

  it 'matches align-items:baseline with a text-less box (synthesised bottom-edge baseline grows the line)' do
    expect_parity('<div style="display:flex;align-items:baseline;width:400px"><div style="font-size:32px">Ag</div><div style="width:40px;height:60px"></div></div>')
  end

  it 'matches a single align-self:baseline item beside flex-start items' do
    expect_parity('<div style="display:flex;align-items:flex-start;height:100px;width:400px"><div style="font-size:32px">Ag</div><div style="align-self:baseline">xy</div></div>')
  end

  it 'matches align-items:baseline with a top margin folded into the ascent' do
    expect_parity('<div style="display:flex;align-items:baseline;width:400px;font-size:16px"><div style="font-size:32px;margin-top:10px">Ag</div><div>xy</div></div>')
  end

  it 'matches align-items:baseline where an item has no text (box baseline) and another does' do
    expect_parity('<div style="display:flex;align-items:baseline;height:120px;width:400px"><div style="width:30px;height:40px"></div><div style="font-size:24px">Mg</div><div style="width:30px;height:20px"></div></div>')
  end

  it 'matches align-items:last baseline anchoring the group at the cross-end' do
    expect_parity('<div style="display:flex;align-items:last baseline;height:80px;width:400px;font-size:16px"><div style="font-size:32px">Ag</div><div>xy</div></div>')
  end

  it 'matches align-items:last baseline with a text-less box (bottom-edge baseline)' do
    expect_parity('<div style="display:flex;align-items:last baseline;height:90px;width:400px"><div style="font-size:32px">Ag</div><div style="width:40px;height:60px"></div></div>')
  end

  it 'matches coexisting first- and last-baseline groups (align-self per item)' do
    expect_parity('<div style="display:flex;height:80px;width:400px;font-size:16px"><div style="align-self:baseline;font-size:32px">Ag</div><div style="align-self:last baseline">xy</div></div>')
  end

  it 'matches the default stretch (items with no cross size fill the line)' do
    expect_parity('<div style="display:flex;height:80px;width:400px"><div style="width:60px"></div><div style="width:60px"></div></div>')
  end

  it 'matches items carrying block-flow subtrees (descendant boxes)' do
    expect_parity('<div style="display:flex;gap:10px;width:500px"><div style="width:120px"><div style="height:20px;margin:5px"></div><div style="height:30px"></div></div><div style="width:120px;height:40px"></div></div>')
  end

  it 'matches a text-block item wrapping at its flex-resolved width' do
    expect_parity('<div style="display:flex;width:400px"><div style="width:150px">some wrapping words that run onto a couple of lines here inside the item</div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches item horizontal margins folded into the main axis' do
    expect_parity('<div style="display:flex;width:600px"><div style="width:100px;height:30px;margin:0 15px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches a main-axis auto margin pushing an item (and the rest) apart' do
    expect_parity('<div style="display:flex;width:600px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px;margin-left:auto"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches two main-axis auto margins splitting the free space' do
    expect_parity('<div style="display:flex;width:600px"><div style="width:100px;height:30px;margin-right:auto"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches a main-axis auto margin on a row-reverse item' do
    expect_parity('<div style="display:flex;flex-direction:row-reverse;width:600px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px;margin-right:auto"></div></div>')
  end

  it 'matches a cross-axis auto margin centring a row item vertically (margin:auto on the cross)' do
    expect_parity('<div style="display:flex;height:90px;width:400px"><div style="width:100px;height:30px;margin-top:auto;margin-bottom:auto"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches a single cross-axis auto margin pushing a row item to the far edge' do
    expect_parity('<div style="display:flex;height:90px;width:400px"><div style="width:100px;height:30px;margin-top:auto"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches a cross-axis auto margin centring a column item horizontally' do
    expect_parity('<div style="display:flex;flex-direction:column;width:200px"><div style="width:50px;height:30px;margin-left:auto;margin-right:auto"></div></div>')
  end

  it 'matches an over-constrained cross-axis auto margin (item taller than the line sits flush)' do
    expect_parity('<div style="display:flex;height:20px;width:400px"><div style="width:100px;height:30px;margin-top:auto"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches margin:auto on one item (both axes) centring it in a definite row' do
    expect_parity('<div style="display:flex;height:90px;width:400px"><div style="width:100px;height:30px;margin:auto"></div></div>')
  end

  it 'matches a row whose min-height grows the cross the items align in (the app-shell min-height)' do
    expect_parity('<div style="display:flex;align-items:center;min-height:100px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div>')
  end

  it 'matches a row whose max-height caps the box while the taller content overflows it' do
    expect_parity('<div style="display:flex;align-items:center;max-height:20px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div>')
  end

  it 'matches a declared row height clamped up by min-height' do
    expect_parity('<div style="display:flex;align-items:flex-end;height:40px;min-height:90px;width:400px"><div style="width:80px;height:30px"></div></div>')
  end

  it 'matches align-items:stretch filling a row grown by min-height' do
    expect_parity('<div style="display:flex;min-height:120px;width:400px"><div style="width:80px"></div><div style="width:80px"></div></div>')
  end

  it 'matches a wrapping row whose min-height grows the cross for align-content to distribute' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;align-content:center;min-height:200px;width:180px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
  end

  it 'matches a column whose min-height floors the main extent for justify-content (page-shell min-h-screen)' do
    expect_parity('<div style="display:flex;flex-direction:column;justify-content:center;min-height:200px;width:100px"><div style="height:30px"></div><div style="height:30px"></div></div>')
  end

  it 'matches a column whose max-height shrinks flex items to fit the capacity' do
    expect_parity('<div style="display:flex;flex-direction:column;max-height:40px;width:100px"><div style="height:30px"></div><div style="height:30px"></div><div style="height:30px"></div></div>')
  end

  it 'matches a column whose max-height caps the box while non-shrinking items overflow it' do
    expect_parity('<div style="display:flex;flex-direction:column;max-height:40px;width:100px"><div style="height:30px;flex-shrink:0"></div><div style="height:30px;flex-shrink:0"></div><div style="height:30px;flex-shrink:0"></div></div>')
  end

  it 'matches a column whose declared height is clamped up by min-height' do
    expect_parity('<div style="display:flex;flex-direction:column;justify-content:flex-end;height:40px;min-height:90px;width:100px"><div style="height:30px"></div></div>')
  end

  it 'matches a column-reverse grown by min-height (items run up from the bottom)' do
    expect_parity('<div style="display:flex;flex-direction:column-reverse;min-height:200px;width:100px"><div style="height:30px"></div><div style="height:30px"></div></div>')
  end

  it 'matches a % main-gap in a min-height column resolving against the floor' do
    expect_parity('<div style="display:flex;flex-direction:column;min-height:200px;row-gap:10%;width:100px"><div style="height:30px"></div><div style="height:30px"></div></div>')
  end

  it 'matches a wrapping row with min-height and a % row-gap (cross-gap basis is content height = 0, not the floor)' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;min-height:200px;row-gap:50%;width:100px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
  end

  it 'matches a column clamped by min-width on its cross axis (width resolved before layout)' do
    expect_parity('<div style="display:flex;flex-direction:column;min-width:200px;width:100px;align-items:center"><div style="width:40px;height:30px"></div><div style="width:60px;height:30px"></div></div>')
  end

  it 'matches a column clamped by max-width on its cross axis' do
    expect_parity('<div style="display:flex;flex-direction:column;max-width:80px;width:200px"><div style="height:30px"></div><div style="height:30px"></div></div>')
  end

  it 'matches a declared-height wrapping column (lines break + justify within the declared height)' do
    expect_parity('<div style="display:flex;flex-direction:column;flex-wrap:wrap;justify-content:center;height:100px;min-height:80px;width:300px"><div style="width:40px;height:30px"></div><div style="width:40px;height:30px"></div><div style="width:40px;height:30px"></div><div style="width:40px;height:30px"></div></div>')
  end

  it 'matches a wrapping auto-height column with only a min-height (no capacity, stays one line)' do
    expect_parity('<div style="display:flex;flex-direction:column;flex-wrap:wrap;min-height:200px;width:100px"><div style="width:40px;height:30px"></div><div style="width:40px;height:30px"></div></div>')
  end

  it 'matches percentage vertical padding on a flex container that fills its parent (width == cb, no basis divergence)' do
    expect_parity('<div style="width:400px"><div style="display:flex;padding:10% 5%"><div style="width:50px;height:30px"></div><div style="width:50px;height:40px"></div></div></div>')
  end

  it 'matches a % main-gap in a cross-stretched column (height definite via stretch, not declared)' do
    expect_parity('<div style="display:flex;height:200px;align-items:stretch;width:100px"><div style="display:flex;flex-direction:column;row-gap:50%"><div style="width:30px;height:20px"></div><div style="width:30px;height:20px"></div></div></div>')
  end

  it 'matches a flex container nested inside a block' do
    expect_parity('<div style="padding:8px"><div style="display:flex;gap:10px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div></div>')
  end

  it 'matches a nested flex row (a flex item that is itself a flex container, f2)' do
    expect_parity('<div style="display:flex;gap:20px;align-items:center;height:120px;width:500px"><div style="display:flex;justify-content:space-between;width:200px;height:40px"><div style="width:50px;height:30px"></div><div style="width:50px;height:30px"></div></div><div style="width:100px;height:60px"></div></div>')
  end

  it 'matches an out-of-flow (absolute) flex child positioned by its insets' do
    expect_parity('<div style="position:relative;display:flex;width:300px;height:100px"><div style="width:50px;height:20px"></div><div style="position:absolute;top:10px;left:20px;width:40px;height:30px"></div></div>')
  end

  it 'matches an out-of-flow flex child at its justify/align static position (no insets)' do
    expect_parity('<div style="position:relative;display:flex;justify-content:center;align-items:center;width:300px;height:100px"><div style="width:50px;height:20px"></div><div style="position:absolute;width:40px;height:30px"></div></div>')
  end

  it 'matches an absolute flex child with its own block subtree' do
    expect_parity('<div style="position:relative;display:flex;width:300px;height:100px"><div style="width:50px;height:20px"></div><div style="position:absolute;top:5px;right:5px;width:80px;height:60px"><div style="height:10px;margin:4px"></div><div style="height:20px"></div></div></div>')
  end

  it 'matches an out-of-flow child excluded from an auto-height row sizing and justify' do
    expect_parity('<div style="position:relative;display:flex;justify-content:center;width:300px"><div style="width:50px;height:20px"></div><div style="position:absolute;inset:0;height:80px"></div></div>')
  end

  it 'matches an absolute flex child in a column' do
    expect_parity('<div style="position:relative;display:flex;flex-direction:column;width:200px;height:300px"><div style="width:60px;height:40px"></div><div style="position:absolute;bottom:10px;right:10px;width:50px;height:50px"></div></div>')
  end

  it 'matches a fixed-position flex child' do
    expect_parity('<div style="display:flex;width:300px;height:100px"><div style="width:50px;height:20px"></div><div style="position:fixed;top:30px;left:40px;width:40px;height:30px"></div></div>')
  end

  it 'matches a flex column stacking items (auto height)' do
    expect_parity('<div style="display:flex;flex-direction:column;width:200px"><div style="width:80px;height:30px"></div><div style="width:120px;height:50px"></div></div>')
  end

  it 'matches a column with a row gap and align-items:center (cross on X)' do
    expect_parity('<div style="display:flex;flex-direction:column;align-items:center;gap:12px;width:300px"><div style="width:80px;height:30px"></div><div style="width:140px;height:40px"></div></div>')
  end

  it 'matches a column with justify-content:space-between at a definite height' do
    expect_parity('<div style="display:flex;flex-direction:column;justify-content:space-between;height:300px;width:200px"><div style="width:80px;height:30px"></div><div style="width:80px;height:40px"></div><div style="width:80px;height:30px"></div></div>')
  end

  it 'matches a column with block-flow item subtrees (descendant boxes)' do
    expect_parity('<div style="display:flex;flex-direction:column;gap:8px;width:300px"><div style="width:200px"><div style="height:20px;margin:4px"></div></div><div style="width:150px;height:40px"></div></div>')
  end

  it 'matches a row nested inside a column' do
    expect_parity('<div style="display:flex;flex-direction:column;gap:10px;width:400px"><div style="display:flex;justify-content:center;gap:6px;width:300px;height:40px"><div style="width:60px;height:30px"></div><div style="width:60px;height:30px"></div></div><div style="width:120px;height:50px"></div></div>')
  end

  it 'matches a column with justify-content:right (physical keyword → start on the block axis)' do
    expect_parity('<div style="display:flex;flex-direction:column;justify-content:right;height:200px;width:200px"><div style="width:50px;height:30px"></div><div style="width:50px;height:30px"></div></div>')
  end

  it 'matches an auto-height column with a percentage row-gap (resolves to 0)' do
    expect_parity('<div style="display:flex;flex-direction:column;width:200px;row-gap:10%"><div style="width:50px;height:30px"></div><div style="width:50px;height:30px"></div></div>')
  end

  it 'matches a wrapping row (items break onto a second line, auto height stacks them)' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;width:250px"><div style="width:100px;height:30px"></div><div style="width:100px;height:40px"></div><div style="width:100px;height:20px"></div></div>')
  end

  it 'matches a wrapping row with a column-gap, row-gap, and align-items:center' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;column-gap:10px;row-gap:12px;align-items:center;width:260px"><div style="width:100px;height:30px"></div><div style="width:100px;height:50px"></div><div style="width:100px;height:20px"></div></div>')
  end

  it 'matches a wrapping row with align-content:space-between at a definite height' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;align-content:space-between;height:200px;width:250px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches a wrapping row with align-content:center' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;align-content:center;height:200px;width:250px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches a wrapping column (items break into a second column)' do
    expect_parity('<div style="display:flex;flex-direction:column;flex-wrap:wrap;height:80px;width:300px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div><div style="width:120px;height:30px"></div></div>')
  end

  it 'keeps an auto-height wrapping column as a single line (no FP split, matches the oracle)' do
    expect_parity('<div style="display:flex;flex-direction:column;flex-wrap:wrap;row-gap:0.13px"><div>one</div><div>two</div><div>three</div><div>four</div><div>five</div><div>six</div></div>')
  end

  it 'matches a uniform all-stretch wrapping row under align-content:stretch' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;width:250px;height:200px"><div style="width:100px"></div><div style="width:100px"></div><div style="width:100px"></div></div>')
  end

  it 'matches a uniform all-explicit wrapping row under align-content:stretch' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;width:250px;height:200px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches row-reverse (items packed from the right, first item rightmost)' do
    expect_parity('<div style="display:flex;flex-direction:row-reverse;width:600px"><div style="width:100px;height:30px;margin-right:20px"></div><div style="width:100px;height:40px"></div><div style="width:100px;height:20px"></div></div>')
  end

  it 'matches row-reverse with justify-content and a gap' do
    expect_parity('<div style="display:flex;flex-direction:row-reverse;justify-content:space-between;gap:10px;width:600px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>')
  end

  it 'matches column-reverse at a definite height (items from the bottom)' do
    expect_parity('<div style="display:flex;flex-direction:column-reverse;height:200px;width:200px"><div style="width:50px;height:30px"></div><div style="width:50px;height:40px"></div></div>')
  end

  it 'matches row-reverse with justify-content:left (physical keyword → the reversed main-end)' do
    expect_parity('<div style="display:flex;flex-direction:row-reverse;justify-content:left;width:500px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
  end

  # A/B bails — the feature declines; the same shape without it stays native.
  def a_bails_b_native(feature, plain = '<div style="display:flex;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
    expect(run_shadow(feature)['ok']).to be(false), "expected #{feature.inspect} to bail"
    expect(run_shadow(plain)['ok']).to be(true), 'expected the plain flex to stay native'
  end

  it('declines flex-wrap:wrap-reverse') { a_bails_b_native('<div style="display:flex;flex-wrap:wrap-reverse;width:120px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  # align-content:stretch with lines that MIX stretch-filled and explicit cross sizes can't be recovered
  # from the pushed final sizes → decline; a uniform (all-explicit) one stays native.
  it('declines a mixed stretch/explicit wrap under align-content:stretch') { a_bails_b_native('<div style="display:flex;flex-wrap:wrap;width:250px;height:200px"><div style="width:100px"></div><div style="width:100px"></div><div style="width:100px;height:50px"></div></div>', '<div style="display:flex;flex-wrap:wrap;width:250px;height:200px"><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div><div style="width:100px;height:30px"></div></div>') }
  it('declines an rtl flex row (rtl propagates to items — deferred)') { a_bails_b_native('<div style="display:flex;direction:rtl;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an rtl flex column (cross axis runs right→left)') { a_bails_b_native('<div style="display:flex;flex-direction:column;direction:rtl;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines max-height on a WRAPPING column (breaks lines against the capacity)') { a_bails_b_native('<div style="display:flex;flex-direction:column;flex-wrap:wrap;max-height:40px;width:300px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>', '<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:300px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  # A flex container's % VERTICAL padding resolves against its OWN box.width in the oracle but the CB width in
  # native — diverges only when those widths differ, so an explicitly-sized container with % padding declines.
  it('declines percentage vertical padding on an explicitly-sized flex container') { a_bails_b_native('<div style="display:flex;flex-direction:column;width:100px;padding-top:10%"><div style="width:80px;height:30px"></div></div>', '<div style="display:flex;flex-direction:column;width:100px;padding-top:12px"><div style="width:80px;height:30px"></div></div>') }
  it('declines an inline-block item') { a_bails_b_native('<div style="display:flex;width:400px"><span style="display:inline-block;width:80px;height:30px"></span><div style="width:80px;height:30px"></div></div>') }
  it('declines a nested UNSUPPORTED flex item (wrap-reverse)') { a_bails_b_native('<div style="display:flex;width:400px"><div style="display:flex;flex-wrap:wrap-reverse;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines a flex container with min-height AND percentage vertical padding (floor edge basis diverges)') { a_bails_b_native('<div style="display:flex;flex-direction:column;min-height:100px;padding-top:10%;width:100px"><div style="width:80px;height:30px"></div></div>', '<div style="display:flex;flex-direction:column;width:100px"><div style="width:80px;height:30px"></div></div>') }
  it('declines a cross-stretched column clamped by max-height (oracle sizes against the pre-clamp room native lacks)') { a_bails_b_native('<div style="display:flex;height:300px;width:400px"><div style="display:flex;flex-direction:column;max-height:100px;row-gap:20%;width:100px"><div style="height:20px"></div><div style="height:30px"></div></div></div>', '<div style="display:flex;height:300px;width:400px"><div style="display:flex;flex-direction:column;row-gap:20%;width:100px"><div style="height:20px"></div><div style="height:30px"></div></div></div>') }
  it('declines an auto-height min-height ROW that is itself a flex item (item-push collapses its two-phase clamp)') { a_bails_b_native('<div style="display:flex;flex-direction:column;width:300px"><div style="display:flex;align-items:center;min-height:120px;width:200px"><div style="width:50px;height:30px"></div></div></div>', '<div style="display:flex;flex-direction:column;width:300px"><div style="display:flex;align-items:center;width:200px"><div style="width:50px;height:30px"></div></div></div>') }
  it('declines an inline-flex container') { a_bails_b_native('<div style="display:inline-flex;width:400px"><div style="width:80px;height:30px"></div></div>') }
  it('declines bare text in the container') { a_bails_b_native('<div style="display:flex;width:400px">loose text<div style="width:80px;height:30px"></div></div>') }
  it('declines a replaced (img) item') { a_bails_b_native('<div style="display:flex;width:400px"><img src="x.png" style="width:80px;height:30px"><div style="width:80px;height:30px"></div></div>') }
  it('declines a position:sticky flex item') { a_bails_b_native('<div style="display:flex;width:400px"><div style="position:sticky;top:0;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an absolute replaced (img) flex child') { a_bails_b_native('<div style="position:relative;display:flex;width:400px;height:100px"><div style="width:80px;height:30px"></div><img src="x.png" style="position:absolute;top:0;left:0;width:40px;height:30px"></div>') }

  # A `position: relative` inset shifts the box and its subtree (the oracle folds it into el._lb); native
  # now applies the pushed shift in place(), so these lay out rather than decline.
  it 'matches a relative flex container with an inset (shifts the whole subtree)' do
    expect_parity('<div style="display:flex;position:relative;top:20px;left:30px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
  end

  it 'matches a relative BLOCK with an inset (shifts the whole subtree)' do
    expect_parity('<div style="position:relative;top:15px;left:25px;width:400px"><div style="height:30px"></div></div>')
  end

  it 'matches a relative flex ITEM with an inset (moves the item, not its siblings)' do
    expect_parity('<div style="display:flex;gap:10px;width:400px"><div style="width:80px;height:30px;position:relative;top:8px;left:12px"></div><div style="width:80px;height:30px"></div></div>')
  end

  it 'matches a relative block whose relative child shifts under it' do
    expect_parity('<div style="position:relative;left:20px;width:300px"><div style="height:20px"></div><div style="position:relative;top:5px;left:10px;height:20px"></div></div>')
  end
end
