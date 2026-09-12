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

  # A GRID ITEM that is itself an auto-height flex container with min/max-height two-phases its OWN clamp: the
  # grid item-push keeps its min/max-height (rec[8]/rec[9]) and its autoHeight (rec[54]), so native recomputes the
  # box from the container's content and aligns its items in the pre-clamp content, box floors/caps to the track —
  # NOT in the track-fitted box (which would be a silent-wrong: the child centres one place too low).
  it 'matches a grid-item flex row whose min-height floors it, items centred in the pre-floor content' do
    expect_parity('<div style="display:grid;grid-template-columns:100px;width:100px"><div style="display:flex;align-items:center;min-height:30px"><div style="width:30px;height:20px"></div></div></div>')
  end
  it 'matches a grid-item flex row whose max-height caps it while its taller content overflows' do
    expect_parity('<div style="display:grid;grid-template-columns:100px;width:100px"><div style="display:flex;align-items:center;max-height:20px"><div style="width:30px;height:60px"></div></div></div>')
  end

  # An absolute / fixed grid container is out of flow — its parent replays its oracle-resolved box and native
  # replays its items within it (grid is pure replay), so the position never enters layout. It lays out natively.
  it 'matches an absolutely-positioned grid container in a relative parent' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:10px;left:10px;display:grid;grid-template-columns:50px 50px;gap:6px"><div style="height:20px">a</div><div style="height:30px">b</div></div></div>')
  end
  it 'declines a floated grid container' do
    expect_bail('<div style="width:400px"><div style="float:left;display:grid;grid-template-columns:50px 50px"><div style="height:20px">a</div></div><div style="height:20px"></div></div>')
  end

  # An `inline-grid` that is a flex / grid ITEM is BLOCKIFIED to `grid` (§4), so it lays out as a block-level
  # grid container — its oracle-resolved box pushed, its items replayed within it. Mirrors the inline-flex item.
  it 'matches an inline-grid flex item' do
    expect_parity('<div style="display:flex;width:300px"><div style="display:inline-grid;grid-template-columns:60px 60px;gap:4px"><span>a</span><span>b</span><span>c</span><span>d</span></div><div>sibling</div></div>')
  end
  it 'matches an inline-grid item nested in a grid' do
    expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;width:300px"><div style="display:inline-grid;grid-template-columns:40px 40px"><span>x</span><span>y</span></div><div>b</div></div>')
  end
  it 'matches an inline-grid flex item in a column container' do
    expect_parity('<div style="display:flex;flex-direction:column;width:200px;height:200px"><div style="display:inline-grid;grid-template-columns:50px 50px"><span>a</span><span>b</span></div></div>')
  end
  # A STANDALONE inline-grid (not a flex/grid item) stays an atomic inline — it must NOT be admitted as a grid.
  it 'keeps a standalone inline-grid an atomic inline (unchanged)' do
    expect_parity('<div style="width:300px">text <span style="display:inline-grid;grid-template-columns:30px 30px"><span>x</span><span>y</span></span> more text wrapping onward past the edge</div>')
  end
  it 'declines a sticky inline-grid flex item' do
    expect_bail('<div style="display:flex;width:300px"><div style="display:inline-grid;position:sticky;grid-template-columns:50px"><span>a</span></div></div>')
  end

  # ── Native COMPUTE path (Phase 1a) ──────────────────────────────────────────────────────────────────────
  # measure_grid sizes the columns itself (fixed / % / plain fr) from the marshalled template + gaps, runs the
  # row-major placement, and lays each item out at its track width (rows are content-height) — NO replay of the
  # oracle's item boxes. A grid outside this subset (intrinsic tracks, out-of-flow items, rtl, …) still parity-
  # matches via the replay fallback, covered above.
  describe 'native column-track compute' do
    it 'matches fixed-px columns' do
      expect_parity('<div style="display:grid;grid-template-columns:100px 100px;width:300px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches fr columns splitting the free space' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;width:300px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches a fixed column beside an fr column' do
      expect_parity('<div style="display:grid;grid-template-columns:200px 1fr;width:500px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches weighted fr columns' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;width:320px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches percentage columns' do
      expect_parity('<div style="display:grid;grid-template-columns:25% 75%;width:400px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches three columns wrapping to a second row with independent row/column gaps' do
      expect_parity('<div style="display:grid;grid-template-columns:80px 80px 80px;gap:10px 20px;width:280px"><div style="height:20px">1</div><div style="height:40px">2</div><div style="height:15px">3</div><div style="height:30px">4</div></div>')
    end
    it 'matches a spanning item (grid-column: span 2)' do
      expect_parity('<div style="display:grid;grid-template-columns:60px 60px 60px;gap:10px;width:200px"><div style="grid-column:span 2;height:20px">wide</div><div style="height:20px">c</div><div style="height:25px">d</div></div>')
    end
    it 'matches an explicit column-start placement' do
      expect_parity('<div style="display:grid;grid-template-columns:50px 50px 50px;width:150px"><div style="grid-column-start:2;height:20px">b</div><div style="height:30px">c</div></div>')
    end
    it 'matches repeat() fr columns' do
      expect_parity('<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:320px"><div style="height:20px">1</div><div style="height:30px">2</div><div style="height:15px">3</div></div>')
    end
    it 'matches repeat(auto-fill) fixed columns' do
      expect_parity('<div style="display:grid;grid-template-columns:repeat(auto-fill,80px);gap:10px;width:300px"><div style="height:20px">1</div><div style="height:20px">2</div><div style="height:20px">3</div></div>')
    end
    it 'matches item margins pulled out of the track' do
      expect_parity('<div style="display:grid;grid-template-columns:100px 100px;width:200px"><div style="height:20px;margin:5px 8px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches a declared container height' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;width:300px;height:100px"><div>a</div><div>b</div></div>')
    end
    it 'matches a text-block item sized to its track width (content height)' do
      expect_parity('<div style="display:grid;grid-template-columns:120px 1fr;width:400px"><div>The quick brown fox jumps over the lazy dog repeatedly today</div><div style="height:20px">side</div></div>')
    end
    it 'matches a grid with its own padding and border' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;width:300px;padding:15px;border:2px solid"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches an empty grid (container box from edges only)' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;width:300px;padding:12px"></div>')
    end
    it 'matches a border-box item narrower than its own padding (width floored at edges)' do
      expect_parity('<div style="display:grid;grid-template-columns:20px 1fr;width:300px"><div style="box-sizing:border-box;padding:40px">a</div><div style="height:10px">b</div></div>')
    end
    it 'matches horizontal % padding on an explicitly-sized grid (resolved against cbW by both)' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;width:200px;padding:0 10%"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches % vertical padding when the grid width equals its containing block' do
      expect_parity('<div style="width:200px"><div style="display:grid;grid-template-columns:1fr 1fr;padding:10% 0"><div style="height:20px">a</div><div style="height:30px">b</div></div></div>')
    end
    # % VERTICAL padding on an explicitly-sized grid (width ≠ cbW): the oracle resolves the grid's own top/bottom
    # % padding against box.width for its auto-height, native's edges against cbW — they diverge, so decline.
    it 'declines % vertical padding on a grid whose width differs from its containing block' do
      expect_bail('<div style="display:grid;grid-template-columns:1fr 1fr;width:200px;padding:20% 0"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
  end
end
