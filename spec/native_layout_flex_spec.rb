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

  # A/B bails — the feature declines; the same shape without it stays native.
  def a_bails_b_native(feature, plain = '<div style="display:flex;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
    expect(run_shadow(feature)['ok']).to be(false), "expected #{feature.inspect} to bail"
    expect(run_shadow(plain)['ok']).to be(true), 'expected the plain flex to stay native'
  end

  it('declines flex-wrap:wrap') { a_bails_b_native('<div style="display:flex;flex-wrap:wrap;width:120px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines flex-direction:column') { a_bails_b_native('<div style="display:flex;flex-direction:column;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines row-reverse') { a_bails_b_native('<div style="display:flex;flex-direction:row-reverse;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines direction:rtl') { a_bails_b_native('<div style="display:flex;direction:rtl;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines align-items:baseline') { a_bails_b_native('<div style="display:flex;align-items:baseline;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines min-height on the container') { a_bails_b_native('<div style="display:flex;min-height:200px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an auto item margin') { a_bails_b_native('<div style="display:flex;width:400px"><div style="width:80px;height:30px;margin-left:auto"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines a position:relative item') { a_bails_b_native('<div style="display:flex;width:400px"><div style="width:80px;height:30px;position:relative;top:5px"></div><div style="width:80px;height:30px"></div></div>') }
  it('declines an inline-block item') { a_bails_b_native('<div style="display:flex;width:400px"><span style="display:inline-block;width:80px;height:30px"></span><div style="width:80px;height:30px"></div></div>') }
  it('declines a nested flex item') { a_bails_b_native('<div style="display:flex;width:400px"><div style="display:flex;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
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
