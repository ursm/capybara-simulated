# frozen_string_literal: true
# Native layout — flex (§9.7), geometry shadow-parity. Increment f1: a plain LTR horizontal `row`,
# `nowrap`. The item SIZING is resolved JS-side (each item's used main+cross size rides its record, like a
# float's shrink-to-fit width); native does only the PLACEMENT — main-axis distribution (justify-content +
# gap + margins), cross-axis alignment (align-items/self), and the container's own box. Everything native
# can't place yet — column / wrap / reverse / rtl / vertical / baseline / min-max-height / auto item
# margins / relative or out-of-flow items / replaced items / nested flex — DECLINES to JS. Each bail is an
# A/B: the feature-carrying input declines, a sibling without it stays native. V8 only.
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

  it 'matches a flex container nested inside a block' do
    expect_parity('<div style="padding:8px"><div style="display:flex;gap:10px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div></div>')
  end

  it 'matches a nested flex row (a flex item that is itself a flex container, f2)' do
    expect_parity('<div style="display:flex;gap:20px;align-items:center;height:120px;width:500px"><div style="display:flex;justify-content:space-between;width:200px;height:40px"><div style="width:50px;height:30px"></div><div style="width:50px;height:30px"></div></div><div style="width:100px;height:60px"></div></div>')
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
  it('declines align-items:baseline') { a_bails_b_native('<div style="display:flex;align-items:baseline;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines min-height on the container') { a_bails_b_native('<div style="display:flex;min-height:200px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an auto item margin') { a_bails_b_native('<div style="display:flex;width:400px"><div style="width:80px;height:30px;margin-left:auto"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines a position:relative item') { a_bails_b_native('<div style="display:flex;width:400px"><div style="width:80px;height:30px;position:relative;top:5px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an inline-block item') { a_bails_b_native('<div style="display:flex;width:400px"><span style="display:inline-block;width:80px;height:30px"></span><div style="width:80px;height:30px"></div></div>') }
  it('declines a nested UNSUPPORTED flex item (wrap-reverse)') { a_bails_b_native('<div style="display:flex;width:400px"><div style="display:flex;flex-wrap:wrap-reverse;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines min-width on a column container (cross clamp)') { a_bails_b_native('<div style="display:flex;flex-direction:column;min-width:200px;width:100px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>', '<div style="display:flex;flex-direction:column;width:100px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an inline-flex container') { a_bails_b_native('<div style="display:inline-flex;width:400px"><div style="width:80px;height:30px"></div></div>') }
  it('declines bare text in the container') { a_bails_b_native('<div style="display:flex;width:400px">loose text<div style="width:80px;height:30px"></div></div>') }
  it('declines a replaced (img) item') { a_bails_b_native('<div style="display:flex;width:400px"><img src="x.png" style="width:80px;height:30px"><div style="width:80px;height:30px"></div></div>') }

  # A relative box with a NON-ZERO inset shifts its whole subtree in the oracle; native carries no inset,
  # so it must decline. A zero-inset relative (containing-block only) is the common case and stays native.
  it 'declines a relative flex container with an inset, keeps a zero-inset relative one' do
    expect(run_shadow('<div style="display:flex;position:relative;top:20px;left:30px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="display:flex;position:relative;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')['ok']).to be true
  end

  it 'declines a relative BLOCK with an inset (pre-existing gap), keeps a zero-inset relative one' do
    expect(run_shadow('<div style="position:relative;top:15px;left:25px;width:400px"><div style="height:30px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="position:relative;width:400px"><div style="height:30px"></div></div>')['ok']).to be true
  end
end
