# frozen_string_literal: true
# Native layout — GRID (§12) REPLAY, geometry shadow-parity. The oracle resolves the whole track layout (column
# sizing, row heights, spans, gaps, item margins — a coarse grid pass) and every item's box; native holds the
# container's box and positions each item at its resolved offset (an out-of-flow displacement), re-laying-out
# only the item's own subtree. The track math is never re-derived. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout grid parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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

  def expect_bail(body)
    expect(run_shadow(body)).to include('ok' => false)
  end

  it 'matches a fixed 2-column grid with a gap' do
    expect_parity('<div style="display:grid;grid-template-columns:100px 100px;gap:10px;width:300px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
  end
  it 'matches fr-unit columns' do
    expect_parity('<div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;width:320px"><div style="height:25px">a</div><div style="height:25px">b</div></div>')
  end
  it 'matches three columns wrapping to a second row (auto row heights)' do
    expect_parity('<div style="display:grid;grid-template-columns:80px 80px 80px;gap:6px;width:260px"><div style="height:20px">1</div><div style="height:40px">2</div><div style="height:15px">3</div><div style="height:30px">4</div></div>')
  end
  it 'matches a column-spanning item' do
    expect_parity('<div style="display:grid;grid-template-columns:60px 60px 60px;gap:10px;width:220px"><div style="grid-column:span 2;height:20px">wide</div><div style="height:20px">c</div><div style="height:20px">d</div></div>')
  end
  it 'matches items carrying margins' do
    expect_parity('<div style="display:grid;grid-template-columns:100px 100px;width:220px"><div style="height:20px;margin:6px 8px">a</div><div style="height:20px">b</div></div>')
  end
  it 'matches items with block-flow subtrees' do
    expect_parity('<div style="display:grid;grid-template-columns:120px 120px;gap:10px;width:260px"><div><div style="height:20px;margin:5px"></div><div style="height:30px"></div></div><div style="height:40px">x</div></div>')
  end
  it 'matches a row-gap distinct from the column-gap' do
    expect_parity('<div style="display:grid;grid-template-columns:70px 70px;gap:4px 24px;width:200px"><div style="height:20px">a</div><div style="height:20px">b</div><div style="height:20px">c</div><div style="height:20px">d</div></div>')
  end
  it 'matches an explicit grid row height' do
    expect_parity('<div style="display:grid;grid-template-columns:80px 80px;grid-auto-rows:50px;gap:6px;width:180px"><div>a</div><div>b</div><div>c</div><div>d</div></div>')
  end
  it 'matches a grid nested as a block child' do
    expect_parity('<div style="width:400px;padding:8px"><div style="height:15px"></div><div style="display:grid;grid-template-columns:90px 90px;gap:10px"><div style="height:20px">a</div><div style="height:30px">b</div></div></div>')
  end
  it 'matches a grid item that is itself a flex container' do
    expect_parity('<div style="display:grid;grid-template-columns:150px 150px;gap:10px;width:320px"><div style="display:flex;gap:5px"><div style="width:40px;height:20px"></div><div style="width:40px;height:30px"></div></div><div style="height:40px">y</div></div>')
  end
  it 'matches an absolutely-positioned grid child placed at the static corner' do
    expect_parity('<div style="display:grid;position:relative;grid-template-columns:100px 100px;gap:10px;width:220px;height:120px"><div style="height:20px">a</div><div style="height:20px">b</div><div style="position:absolute;top:5px;left:5px;width:30px;height:30px">p</div></div>')
  end

  # A grid item's auto margins are resolved by the oracle and replayed at its _lb, so a centring auto margin
  # needs no native handling (review finding 2).
  it 'matches a grid item with a horizontal auto margin (centred in its track)' do
    expect_parity('<div style="display:grid;grid-template-columns:200px;width:220px"><div style="width:100px;height:20px;margin:0 auto">a</div></div>')
  end
  it 'matches two grid items each auto-margin-centred in their tracks' do
    expect_parity('<div style="display:grid;grid-template-columns:150px 150px;gap:10px;width:320px"><div style="width:80px;height:20px;margin:0 auto">a</div><div style="width:60px;height:20px;margin-left:auto">b</div></div>')
  end
  # A grid nested inside a flex container is a (blockified) grid flex item — walked and replayed (review finding 3).
  it 'matches a grid nested inside a flex container (grid flex item)' do
    expect_parity('<div style="display:flex;gap:10px;width:420px"><div style="display:grid;grid-template-columns:80px 80px;gap:6px;width:180px"><div style="height:20px">a</div><div style="height:30px">b</div></div><div style="width:100px;height:40px">z</div></div>')
  end

  it 'declines an absolutely-positioned grid CONTAINER as the root' do
    expect_bail('<div style="position:absolute;display:grid;grid-template-columns:50px 50px;width:120px"><div style="height:20px">a</div></div>')
  end
  it 'declines a floated grid container' do
    expect_bail('<div style="width:400px"><div style="float:left;display:grid;grid-template-columns:50px 50px"><div style="height:20px">a</div></div><div style="height:20px"></div></div>')
  end
end
