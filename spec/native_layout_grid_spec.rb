# frozen_string_literal: true
# Native layout — GRID (§12), geometry shadow-parity. Native COMPUTES every grid it admits (`nlGridSupported`):
# it sizes the columns itself — px / % / fr, and the intrinsic tracks from the items' min/max-content, which
# native measures natively where it can (`nlIntrinsicMeasurable`) and otherwise receives resolved from the
# oracle — runs the row-major placement (content rows or `grid-auto-rows`), and lays each item out at its track
# width; an out-of-flow item is replayed at its resolved box as a block's abspos child is. The former replay
# path (the oracle's item boxes pushed) is retired. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/walk_refusals'

RSpec.describe 'native layout grid parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
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

  # Parity, AND the intrinsic tracks were sized from native's own min/max-content measure (no oracle
  # contribution marshalled) — `nativeIntrinsicGrids` counts the computed grids that took that path.
  def expect_native_intrinsic(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeIntrinsicGrids']).to be >= 1, "intrinsic tracks fell back to the oracle's contribution: #{r.inspect}"
  end

  # Parity through the FALLBACK: the oracle's per-column contribution is marshalled resolved because an item's
  # content is not natively measurable yet.
  def expect_resolved_fallback(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeIntrinsicGrids']).to eq(0), "expected the oracle-resolved fallback: #{r.inspect}"
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

  # A grid item's horizontal auto margins are resolved by the oracle against its track (its record's margins),
  # so a centring auto margin needs no native distribution.
  it 'matches a grid item with a horizontal auto margin (centred in its track)' do
    expect_parity('<div style="display:grid;grid-template-columns:200px;width:220px"><div style="width:100px;height:20px;margin:0 auto">a</div></div>')
  end
  it 'matches two grid items each auto-margin-centred in their tracks' do
    expect_parity('<div style="display:grid;grid-template-columns:150px 150px;gap:10px;width:320px"><div style="width:80px;height:20px;margin:0 auto">a</div><div style="width:60px;height:20px;margin-left:auto">b</div></div>')
  end
  # A grid nested inside a flex container is a (blockified) grid flex item — computed within its pushed box.
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
  # …and an inline-grid FLEX ITEM is a grid: a flex item is blockified, so nothing here is inline. It used to
  # decline for the `position: sticky` on it, which is in flow and needs nothing of its own.
  it 'matches an inline-grid flex item, positioned or not' do
    ['position:sticky;top:0;', 'position:relative;', ''].each do |pos|
      expect_parity(%(<div style="display:flex;width:300px"><div style="display:inline-grid;#{pos}grid-template-columns:50px"><span>a</span></div></div>))
    end
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
    # A grid's own % padding resolves against its CONTAINING BLOCK's width, on both axes (§ CSS Box: a
    # percentage padding is always of the CB width) — which is what Chrome does and what the oracle does now, so
    # an explicitly-sized grid carrying one lays out natively.
    it 'resolves its own % vertical padding against its containing block' do
      expect_parity('<div style="display:grid;grid-template-columns:1fr 1fr;width:200px;padding:20% 0"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
      expect_parity('<div style="width:400px"><div style="display:grid;grid-template-columns:1fr;width:200px;padding:10%"><div style="height:20px">a</div></div></div>')
    end
  end

  # ── Intrinsic tracks ───────────────────────────────────────────────────────────────────────────────────
  # auto / min-content / max-content / minmax() / fit-content() need each column's content contribution (the
  # items' min/max-content). Native runs the §12.6 maximize + §12.7 fr distribution on the track specs, taking
  # the contribution from its own measure (below) or, for content it can't measure yet, resolved from the
  # oracle's gridColumnContent.
  describe 'native intrinsic-track compute' do
    it 'matches two auto columns sized to their content' do
      expect_parity('<div style="display:grid;grid-template-columns:auto auto;width:500px"><div style="height:20px">short</div><div style="height:30px">a much longer cell here</div></div>')
    end
    it 'matches auto beside fr (auto to content, fr fills the rest)' do
      expect_parity('<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div style="height:20px">label</div><div style="height:30px">value fills the rest of the row</div></div>')
    end
    it 'matches minmax(px, 1fr) beside a fixed column' do
      expect_parity('<div style="display:grid;grid-template-columns:minmax(100px,1fr) 200px;width:500px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches minmax(600px,1fr) 1fr with the fr floor refreezing' do
      expect_parity('<div style="display:grid;grid-template-columns:minmax(600px,1fr) 1fr;width:800px"><div style="height:20px">a</div><div style="height:30px">b</div></div>')
    end
    it 'matches min-content beside fr' do
      expect_parity('<div style="display:grid;grid-template-columns:min-content 1fr;width:400px"><div style="height:20px">wordwordword</div><div style="height:30px">rest</div></div>')
    end
    it 'matches max-content beside auto' do
      expect_parity('<div style="display:grid;grid-template-columns:max-content auto;width:500px"><div style="height:20px">some text here</div><div style="height:30px">more content in this column here</div></div>')
    end
    it 'matches fit-content(px) beside fr' do
      expect_parity('<div style="display:grid;grid-template-columns:fit-content(80px) 1fr;width:400px"><div style="height:20px">a longer piece of text than eighty px</div><div style="height:30px">rest</div></div>')
    end
    it 'matches repeat(auto-fit) collapsing to the item count' do
      expect_parity('<div style="display:grid;grid-template-columns:repeat(auto-fit,80px);gap:10px;width:300px"><div style="height:20px">1</div><div style="height:20px">2</div></div>')
    end
  end

  # ── Native min/max-content ─────────────────────────────────────────────────────────────────────────────
  # The items' intrinsic widths measured by native itself (layout.rs `intrinsic_widths` / `text_intrinsic` —
  # the oracle's intrinsicWidths / contentIntrinsicWidths on the record tree): a declared width pins, a text
  # block's pen-walk gives the widest line (max) and the widest unbreakable run (min), a block container is
  # its widest child's margin box, then the box's edges and min/max-width. Validated THROUGH the grid: the
  # column a track sizes to is only right when the measure is.
  describe 'native intrinsic measurement' do
    let(:two_auto) { 'display:grid;grid-template-columns:auto auto;width:600px' }
    let(:mc_auto) { 'display:grid;grid-template-columns:max-content auto;width:600px' }

    it 'measures a text item (auto columns: min-content floor, max-content ceiling)' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="height:20px">short</div><div style="height:30px">a much longer cell here</div></div>))
    end
    it 'measures min-content beside fr (the widest word)' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:min-content 1fr;width:400px"><div style="height:20px">wordwordword and more</div><div style="height:30px">rest</div></div>')
    end
    it 'measures max-content and fit-content(px) tracks' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:max-content auto;width:500px"><div style="height:20px">some text here</div><div style="height:30px">more content in this column here</div></div>')
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:fit-content(80px) 1fr;width:400px"><div style="height:20px">a longer piece of text than eighty px</div><div style="height:30px">rest</div></div>')
    end
    it 'measures minmax() sides that are intrinsic' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:minmax(auto,200px) minmax(min-content,max-content);width:600px"><div>some words in the first</div><div>and some more words in the second column</div></div>')
    end
    it 'pins a declared width (content-box and border-box), then adds the edges' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="width:150px;padding:0 10px;height:10px">declared</div><div style="box-sizing:border-box;width:150px;padding:0 10px;height:10px">declared</div></div>))
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:auto 1fr;width:300px"><div style="box-sizing:border-box;width:50px;padding:0 40px;height:10px">x</div><div style="height:10px">b</div></div>')
    end
    it 'clamps the contribution by max-width (below the widest word) and min-width' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="max-width:40px;height:10px">unbreakableword and more</div><div style="min-width:250px;height:10px">x</div></div>))
    end
    it 'adds an item\'s own padding and border, and counts an auto margin as zero' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="padding:0 15px;border:3px solid;height:10px">edged item</div><div style="margin:0 auto;height:10px">auto margins</div></div>))
    end
    it 'measures a block-container item by its widest child margin box (a negative margin narrows)' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><div style="margin:0 12px 0 5px;height:10px">nested block words here</div><div style="margin-right:-20px;height:10px">shorter</div></div><div style="height:30px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><div style="padding:0 7px;margin:0 9px">child with edges and a few words</div></div><div style="height:10px">b</div></div>))
    end
    it 'measures a mixed block item (anonymous text blocks around a block child — their declared sizing is auto)' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>text before<p style="margin:0 4px">a paragraph in the middle</p>and after</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>text before is long<p style="margin:0">para</p>and after</div><div>b</div></div>))
    end
    it 'skips an out-of-flow child of an item' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="position:relative"><p style="margin:0">a</p><div style="position:absolute;width:300px;height:5px">abs</div></div><div style="height:10px">b</div></div>))
    end
    it 'ends a line at <br> (the widest line, not the sum) and breaks at <wbr>' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>one line<br>a much longer second line here<br>three</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>averyveryverylongword<wbr>splithere and more</div><div style="height:10px">b</div></div>))
    end
    it 'takes a pending space once: a multi-word run glued to the next run (review finding 1)' do
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:max-content auto;width:600px"><div>aa bb<b>cc</b></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:max-content auto;width:600px"><div style="white-space:nowrap">aa bb<b>cc</b></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:max-content auto;width:600px"><div>aa bb<wbr>cc</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:max-content auto;width:600px"><div>aa<b> bb cc</b>dd</div><div>b</div></div>))
    end
    it 'measures an item holding only a no-break space as that space (content, not white space)' do
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:max-content auto;width:600px"><div>&nbsp;</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:max-content auto;width:600px"><div>x<p style="margin:0">y</p>&nbsp;</div><div>b</div></div>))
    end
    it 'continues a word across edgeless inline boundaries (mixed-font glued word)' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>foo<b>bar</b> baz <i>qux</i>quux</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="font-size:24px">bigger <small>and smaller</small> text</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><span>nested <span>inline <b>deep</b></span></span></div><div style="height:10px">b</div></div>))
    end
    it 'collapses white space: leading / trailing / newlines, and a later run\'s pending space wins' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>   leading and trailing   </div><div>\n   newlines\n   collapse   </div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>foo <span style="font-size:40px"> </span> bar</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>a&nbsp;b&nbsp;c glued</div><div style="height:10px">b</div></div>))
    end
    it 'measures letter-spacing and word-spacing into the words' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="letter-spacing:2px;word-spacing:5px">spaced out letters</div><div style="height:10px">b</div></div>))
    end
    it 'pins a nowrap text item\'s min-content to its max-content' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="white-space:nowrap;height:10px">never wraps these words</div><div style="height:10px">wraps these words fine</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="white-space:nowrap">plain<br>nowrap<wbr>lines</div><div style="height:10px">b</div></div>))
    end
    it 'measures empty and whitespace-only items as zero' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div></div><div>   </div></div>))
    end
    it 'splits a spanning item evenly over its columns and honours an explicit column start' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:auto auto auto;width:600px"><div style="grid-column:span 2">spans two columns with lots of text</div><div>c</div><div style="grid-column:3">explicit third</div><div>x</div><div>yy</div></div>')
    end
    it 'takes the widest item from a later row' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>a</div><div>b</div><div>the widest item sits in the second row</div><div>c</div></div>))
    end

    # What native does not measure yet falls back to the oracle's resolved contribution — with parity.
    it 'reads a percentage width / min-width / calc as auto (no basis in an intrinsic measure), from the declared sizing' do
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="width:50%;height:10px">pct width</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="min-width:50%;height:10px">pct min</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="width:calc(50% - 10px);height:10px">calc pct</div><div>b</div></div>))
    end
    # A PERCENTAGE padding / margin resolves to nothing in an intrinsic measure (CSS Sizing 3), and the record
    # carries those basis-less edges beside its cbW-resolved ones, so native measures such a box itself.
    it 'measures a percentage padding / margin itself (the basis-less edges ride the record)' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="padding-left:10%;height:10px">pct pad</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="margin:0 10%;height:10px">pct margin</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="height:10px">a <span style="padding:0 10%">pct</span> b</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="display:flex"><div style="padding:0 10%;min-width:50px;width:20px;height:10px"></div></div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><table style="padding:0 10%"><tr><td>hello</td></tr></table></div><div style="height:10px">b</div></div>))
    end
    it 'falls back for a nowrap / pre block container (the oracle pins the whole box, children included)' do
      expect_resolved_fallback(%(<div style="#{two_auto}"><div style="white-space:nowrap"><p style="margin:0">block child under nowrap</p></div><div style="height:10px">b</div></div>))
      expect_resolved_fallback(%(<div style="#{two_auto}"><div style="white-space:pre"><p style="margin:0">block child under pre</p></div><div style="height:10px">b</div></div>))
    end
    it 'puts an edged inline\'s open / close edges on the line and in the word, taking the pending space at its open' do
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>with <span style="padding:0 8px">padded span</span> here</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>aa <span style="margin:0 3px;border:1px solid">bb</span>cc</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>aa<span style="padding-right:8px"> bb</span> cc</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>aa <span style="padding:0 4px"><span style="padding:0 2px">deep</span> x</span></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="white-space:nowrap">aa <span style="padding:0 5px">bb</span> cc</div><div>b</div></div>))
      # "any edge" is decided by the same open+close float sum in both engines (sub-pixel cancelling margins)
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>aa <span style="margin-left:-1px;padding-right:0.7px;margin-right:0.3px"> bb</span> cc</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div>aa <span style="margin-left:5px;margin-right:-5px"> bb</span> cc</div><div>b</div></div>))
    end
    it 'breaks between characters for the min-content under break-all / anywhere, not break-word (unspaced advances)' do
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="word-break:break-all">breakallword here</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="overflow-wrap:anywhere">anywhereword here</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="overflow-wrap:break-word">breakword words here</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="word-break:break-all;letter-spacing:3px;word-spacing:4px">spaced break all</div><div>b</div></div>))
    end
    it 'measures preserved white-space (pre / pre-wrap: spaces are content, a newline ends the line) and pre-line' do
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="white-space:pre">pre   spaced\nsecond longer line   </div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="white-space:pre-wrap">  wrap   spaced\nsecond longer line   </div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="white-space:pre-wrap">aa <span style="padding:0 5px">bb</span>   cc</div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="white-space:pre-line">aa bb\ncc dd ee\n\nff</div><div>b</div></div>))
    end
    it 'packs floats on a line inside a block-container item (max sums, min stands alone)' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><div style="float:left;width:40px;height:10px"></div><div style="float:left;width:70px;height:10px;margin:0 5px"></div><p style="margin:0">beside floats</p></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><div style="float:left;width:40px;height:10px"></div><div style="float:right;width:70px;height:10px"></div></div><div>b</div></div>))
    end
    it 'measures an atomic inline native lays out itself, and falls back for one whose box is pushed' do
      expect_native_intrinsic(%(<div style="#{two_auto}"><div><span style="display:inline-block;width:80px;height:10px"></span> after</div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div>an <img style="width:30px"> image</div><div style="height:10px">b</div></div>))
      expect_resolved_fallback(%(<div style="#{two_auto}"><div><span style="display:inline-block;vertical-align:middle;width:80px;height:10px"></span> after</div><div style="height:10px">b</div></div>))
    end
    it 'measures a flex-container item: a row sums its items (gap + margins), a wrapping row\'s min is one item, a column takes the widest' do
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex"><div style="width:40px;height:10px"></div><div style="width:60px;height:10px"></div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex;gap:10px"><div>alpha beta</div><div style="margin:0 4px">gamma</div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="display:grid;grid-template-columns:min-content 1fr;width:600px"><div style="display:flex;flex-wrap:wrap;gap:6px"><div>alpha beta</div><div>gamma delta</div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex;flex-direction:column"><div>alpha beta gamma</div><div style="margin:0 20px">short</div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex;flex-direction:row-reverse"><div style="width:40px;height:10px"></div><div>rev words</div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex"><div style="display:flex;gap:3px"><div>nested</div><div>flex</div></div><div>outer</div></div><div>b</div></div>))
    end
    it 'reads a flex item\'s DECLARED sizing (not its pushed used box): flex-basis pins or, when it grows, raises the max; min/max-width clamp' do
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex"><div style="flex:0 0 30px;width:60px;height:10px">x</div><div style="flex:1 0 0">grows from zero basis text</div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex"><div style="flex-basis:50px;flex-grow:1;padding:0 5px">grow basis</div><div style="min-width:120px">min</div><div style="max-width:20px">capped words</div></div><div>b</div></div>))
      expect_native_intrinsic(%(<div style="#{mc_auto}"><div style="display:flex"><div style="box-sizing:border-box;flex-basis:50px;padding:0 10px">bb</div><div style="width:50%">pct</div><div style="flex-basis:50%">half</div></div><div>b</div></div>))
    end
    it 'falls back for a flex container with a percentage main gap, and for a grid holding inline content' do
      expect_resolved_fallback(%(<div style="#{mc_auto}"><div style="display:flex;column-gap:5%"><div>a</div><div>b</div></div><div>b</div></div>))
      # …a grid whose items are BLOCKS is measured natively now (as a block, which is what the oracle does with
      # one); only its INLINE-LEVEL content still falls back, where the oracle walks a pen the records cannot
      # reproduce — see `nlIntrinsicMeasurableOf`.
      expect_resolved_fallback(%(<div style="#{two_auto}"><div style="display:grid;grid-template-columns:50px 50px"><span>nested grid words</span><span>x</span></div><div style="height:10px">b</div></div>))
      expect_native_intrinsic(%(<div style="#{two_auto}"><div style="display:grid;grid-template-columns:50px 50px"><div>nested grid words</div><div>x</div></div><div style="height:10px">b</div></div>))
    end
  end

  # ── Replay retired ─────────────────────────────────────────────────────────────────────────────────────
  # Every shape the compute path once handed to the oracle-box replay is computed now: a grid that is itself
  # a flex / grid / out-of-flow box (its parent pushes its box, the tracks compute within it), `grid-auto-rows`
  # (rows advance by the declared height; an auto-height item IS that height, clamped by its own min/max),
  # bare text (an anonymous item that only floors the auto height), an rtl grid (the oracle lays columns out
  # LTR regardless), an empty / invalid template (one full-width column), and an out-of-flow item.
  describe 'computed grids that used to replay' do
    it 'computes a grid that is a flex item, stretched or not' do
      expect_native_intrinsic('<div style="display:flex;width:400px"><div style="display:grid;grid-template-columns:auto 1fr;flex:1"><div style="height:10px">a</div><div style="height:20px">b</div></div><div style="width:50px;height:60px"></div></div>')
      expect_native_intrinsic('<div style="display:flex;width:400px;align-items:flex-start"><div style="display:grid;grid-template-columns:auto 1fr;flex:1"><div style="height:10px">a</div><div style="height:20px">b</div></div><div style="width:50px;height:60px"></div></div>')
    end
    it 'computes a grid nested as a grid item, and an absolutely positioned grid' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:100px 100px;width:400px"><div style="display:grid;grid-template-columns:auto auto"><div>n1</div><div>n2</div></div><div style="height:20px">b</div></div>')
      expect_native_intrinsic('<div style="position:relative;width:400px;height:200px"><div style="position:absolute;top:10px;left:20px;width:200px;display:grid;grid-template-columns:auto 1fr"><div style="height:10px">a</div><div style="height:20px">b</div></div></div>')
    end
    it 'computes grid-auto-rows: rows advance by the declared height, an auto-height item is that height' do
      expect_parity('<div style="display:grid;grid-template-columns:100px 1fr;grid-auto-rows:40px;width:400px"><div style="height:50%">pct h</div><div>b</div><div style="height:60px">tall</div><div>d</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:60px;width:400px;height:300px"><div style="height:50%">pct</div><div style="padding:5px;border:2px solid">edged auto</div><div style="box-sizing:border-box;padding:5px">bb auto</div><div style="min-height:100px">minh</div><div style="max-height:10px">maxh</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:60px;gap:7px;width:400px"><div><p style="margin:20px 0">inner margins</p></div><div style="margin:8px 0">m</div><img style="display:block;width:30px;height:30px"></div>')
    end
    it 'lays a flex-container / nested-grid / table item out within its declared row height' do
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:60px;width:400px"><div style="display:flex;align-items:center"><div style="width:10px;height:10px"></div></div><div>b</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:60px;width:400px"><div style="display:flex;flex-direction:column;justify-content:flex-end"><div style="width:10px;height:10px"></div></div></div>')
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:60px;width:400px"><div style="display:grid;grid-template-columns:auto"><div>nested in row</div></div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:200px;grid-auto-rows:60px;width:400px"><table><tr><td>cell</td></tr></table></div>')
    end
    it 'declines a row shorter than an item\'s vertical edges, and a flex-container item with a min/max-height under declared rows' do
      expect_bail('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:20px;width:400px"><div style="padding:30px">padding taller than row</div></div>')
      expect_bail('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:60px;width:400px"><div style="display:flex;align-items:center;min-height:100px"><div style="width:10px;height:10px"></div></div></div>')
    end
    it 'keeps an auto-height item content-sized under grid-auto-rows: 0 (a 0 height is the oracle\'s auto placeholder)' do
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:0px;width:400px"><div><p style="margin:0">text</p></div><div>b</div></div>')
    end
    it 'resolves a % gap inside an item against the row height it was given (definite at gap time)' do
      expect_native_intrinsic('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:100px;width:400px"><div style="display:grid;grid-template-columns:auto;row-gap:10%"><div>a</div><div>b</div></div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:100px;width:400px"><div style="display:flex;flex-direction:column;row-gap:10%"><div style="height:10px"></div><div style="height:10px"></div></div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px;grid-auto-rows:100px;width:400px"><div style="display:flex;flex-wrap:wrap;row-gap:10%"><div style="width:60px;height:10px"></div><div style="width:60px;height:10px"></div></div></div>')
    end
    it 'shifts a relative item by its insets (as Chrome does — the oracle now applies flowShift to grid items)' do
      expect_parity('<div style="display:grid;grid-template-columns:100px 100px;width:400px"><div style="position:relative;top:10px;left:5px;height:20px">rel</div><div style="height:20px">b</div></div>')
    end
    # A DROPDOWN is a leaf to native — the oracle takes its border box from its intrinsic size, never by
    # stacking its `<option>`s, which have no box in Chrome at all — so it is laid out like any replaced item.
    # A LIST BOX showing rows is a block container instead (native stacks those rows itself, see
    # native_layout_replaced_spec), and a grid item that IS one still declines: the grid path does not take a
    # container whose box is pinned that way. It stays on the decline census, which is where the remaining
    # work belongs.
    it 'lays out a dropdown item, and declines a list box item' do
      expect_parity('<div style="display:grid;grid-template-columns:100px;width:400px"><select><option>o</option></select></div>')
      expect_bail('<div style="display:grid;grid-template-columns:100px;width:400px"><select multiple><option>a</option><option>b</option></select></div>')
    end
    it 'floors an auto height at bare text (an anonymous item the oracle never places)' do
      expect_parity('<div style="display:grid;grid-template-columns:100px 1fr;width:400px">bare text<div style="height:10px">a</div><div style="height:20px">b</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px 1fr;width:400px">bare<div style="height:10px">a</div></div>')
    end
    it 'computes an rtl grid (columns laid out LTR, as the oracle does), and a missing / invalid template as one column' do
      expect_parity('<div style="display:grid;grid-template-columns:100px 1fr;width:400px;direction:rtl"><div style="height:10px">a</div><div style="height:20px">b</div></div>')
      expect_parity('<div style="display:grid;width:400px"><div style="height:10px">a</div><div style="height:20px">b</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:foo;width:400px"><div style="height:10px">a</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:[a] 1fr;width:400px"><div style="height:10px">a</div></div>')
    end
    it 'replays an out-of-flow item at its resolved box while the in-flow items compute' do
      expect_parity('<div style="display:grid;position:relative;grid-template-columns:100px 100px;gap:10px;width:220px"><div style="height:20px">a</div><div style="height:20px">b</div><div style="position:absolute;width:30px;height:30px">p</div><div style="height:20px">c</div></div>')
      expect_native_intrinsic('<div style="display:grid;position:relative;grid-template-columns:auto 1fr;width:300px"><div style="position:absolute;right:0;top:0;width:30px;height:30px">p</div><div>label text</div><div style="height:20px">b</div></div>')
    end
  end
  # Native measures the items' own min/max-content for an intrinsic track only if it can measure EVERY item, and
  # which it is, the WALK decides: where it declines one item's subtree under that promise the whole grid — the
  # tracks it marshalled included — is rolled back and re-emitted with the oracle's column contributions. Under a
  # predicate-decided gate each of these shapes took the whole pass down, because the refusal is one
  # `nlIntrinsicMeasurable` does not model.
  describe 'a grid whose item the walk declines to measure re-emits with the oracle contributions' do
    WalkRefusals::ATOMIC.each_with_index do |inner, i|
      it "lays out a min-content and a fit-content track around refused content #{i}" do
        [
          %{<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a #{inner}</div><div>x</div></div>},
          %{<div style="display:grid;grid-template-columns:fit-content(200px);width:400px"><div>a #{inner}</div></div>}
        ].each do |body|
          r = run_shadow(body)
          expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
          expect(r['nativeIntrinsicGrids']).to eq(0), "the grid should have used the oracle's contributions: #{r.inspect}"
        end
      end
    end
    it 'still measures the tracks itself where every item allows it, and counts the grid once' do
      r = run_shadow('<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a <span style="display:inline-block">ok</span></div><div>x</div></div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeIntrinsicGrids' => 1), r.inspect
    end
    # The rollback has to put the container's OWN marshalled data back too, not just its items' records: a grid
    # pushes its tracks and placements before them, and rec[55] points at that offset. These pin it — a stale
    # offset would have native reading the neighbouring table's column data as track specs, and a leaked push
    # would double or lose the grid count.
    it 'rolls its own marshalled tracks back, whatever else is in the stream' do
      refusal = WalkRefusals::ATOMIC.first
      nested = '<div style="display:grid;grid-template-columns:min-content;width:60px"><div>n</div></div>'
      cols = '<table style="border-spacing:0"><colgroup><col style="width:20px"><col></colgroup><tr><td style="padding:0">c</td><td style="padding:0">d</td></tr></table>'
      [
        # the falling-back grid holds a NESTED grid, before and after the refusal: the outer takes the oracle's
        # contributions, the inner still measures its own tracks — one count, neither doubled nor lost
        [%{<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>#{nested}a #{refusal}</div><div>x</div></div>}, 1],
        [%{<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a #{refusal}</div><div>#{nested}</div></div>}, 1],
        # …and a `<colgroup>` table inside it, whose column data shares the same stream rec[55] indexes into
        [%{<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>#{cols}a #{refusal}</div><div>x</div></div>}, 0],
        [%{<div style="width:400px">#{cols}<div style="display:grid;grid-template-columns:min-content;width:200px"><div>a #{refusal}</div></div></div>}, 0],
        # …and two sibling grids where only one falls back
        [%{<div style="width:400px"><div style="display:grid;grid-template-columns:min-content"><div>a #{refusal}</div></div><div style="display:grid;grid-template-columns:min-content"><div>a <span style="display:inline-block">ok</span></div></div></div>}, 1]
      ].each do |body, measured|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
        expect(r['nativeIntrinsicGrids']).to eq(measured), "#{body}: #{r.inspect}"
      end
    end
  end
  # A GRID has an intrinsic width of its own now — every context that asks a box what it wants can ask one.
  # The answer is a BLOCK's, measured over the grid's item records, because that is what the ORACLE answers:
  # `intrinsicWidths` has no grid arm (it tests flex and table only) and `contentIntrinsicWidths` blockifies
  # only a FLEX container's children. So the tracks and the gaps enter neither figure in either engine — a
  # conformance gap they SHARE, which the port neither widens nor closes.
  describe 'a grid answers for its own intrinsic width' do
    # …in every context that asks one: a shrink-to-fit float, an abspos box, a table column, a flex item both
    # ways, an outer grid's `min-content` track, an inline-block, a vertical writing mode, and the keyword
    # widths themselves.
    it 'is measured wherever a box is asked what it wants' do
      g = '<div style="display:grid;grid-template-columns:40px 60px"><div style="width:40px;height:10px"></div><div style="width:70px;height:10px"></div></div>'
      [
        %(<div style="width:max-content">#{g}</div>),
        %(<div style="width:min-content">#{g}</div>),
        %(<div style="width:fit-content">#{g}</div>),
        %(<div style="width:400px"><div style="float:left">#{g}</div></div>),
        %(<div style="width:400px;position:relative"><div style="position:absolute;left:0">#{g}</div><p>x</p></div>),
        %(<table style="border-spacing:0"><tr><td style="padding:0">#{g}</td><td style="padding:0">b</td></tr></table>),
        %(<div style="display:flex;width:400px">#{g}<div style="width:30px;height:10px"></div></div>),
        %(<div style="display:flex;flex-direction:column;width:400px">#{g}</div>),
        %(<div style="display:grid;grid-template-columns:min-content auto;width:400px">#{g}<div>x</div></div>),
        %(<div style="width:400px">text <span style="display:inline-block">#{g}</span> after</div>),
        %(<div style="width:400px"><div style="writing-mode:vertical-lr">#{g}</div></div>)
      ].each {|body| expect_parity(body) }
    end
    # …and the block arm's own branches: a float packs onto a line, an out-of-flow item sizes nothing, a
    # replaced item brings its intrinsic width, a nested grid answers in turn, a negative margin narrows.
    it 'measures the grid items the way it measures a block child' do
      [
        '<div style="float:left;width:30px;height:8px"></div><div style="float:left;width:35px;height:8px"></div>',
        '<div style="position:absolute;width:300px;height:10px"></div><div style="width:20px;height:10px"></div>',
        %(<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="display:block;width:24px;height:10px">),
        '<div style="display:grid;grid-template-columns:25px"><div style="height:6px"></div></div>',
        '<div style="margin-left:-6px;width:30px;height:10px"></div>'
      ].each {|items| expect_parity(%(<div style="width:max-content"><div style="display:grid">#{items}</div></div>)) }
      # …while a `display: contents` child is refused before this test is reached at all (the walk does not
      # flatten one — its own arm above), and a NON-WRAPPING mode over a grid with block children is refused
      # by the pin that predates grids (`!(hasBlock && nowrap|pre)`).
      expect_bail('<div style="width:max-content"><div style="display:grid"><div style="display:contents"><div style="width:30px;height:10px"></div></div></div></div>')
      expect_bail('<div style="width:max-content"><div style="display:grid;white-space:nowrap"><div style="width:20px;height:10px"></div></div></div>')
    end
    # …while INLINE-LEVEL content still declines, because there the two engines do different things: the
    # oracle walks it with a PEN — two `<span>` items land on ONE line and sum for max-content (48.41 against
    # the widest item's 34.2) — and the walk hands native one blockified record per item.
    it 'declines a grid holding inline-level content, and takes the same grid with block items' do
      {
        '<span>aa bb</span><span>cc</span>'                        => '<div>aa bb</div><div>cc</div>',
        'aa bb'                                                    => '<div>aa bb</div>',
        '<span style="display:inline-block;width:20px;height:9px"></span>' => '<div style="width:20px;height:9px"></div>',
        '<div style="width:9px;height:4px"></div><br>'             => '<div style="width:9px;height:4px"></div>'
      }.each do |inline, block|
        expect_bail(%(<div style="width:max-content"><div style="display:grid">#{inline}</div></div>))
        expect_parity(%(<div style="width:max-content"><div style="display:grid">#{block}</div></div>))
      end
    end
    # …and a run of pure SPACES is inline content too, but only where the mode PRESERVES it: the oracle
    # measures every character of it (a grid of ten spaces under `pre` is 40 wide there and 0 to native, which
    # has neither a record nor a run stream for the anonymous item they form), while a collapsible run sets no
    # `inlineOnLine` and contributes nothing to either engine. This is the shape a spec written from the
    # element side alone would miss.
    it 'declines whitespace the mode preserves, and keeps a grid whose whitespace collapses' do
      ['white-space:pre', 'white-space:pre-wrap'].each do |ws|
        expect_bail(%(<div style="width:max-content"><div style="display:grid;#{ws}">          </div></div>))
        expect_bail(%(<div style="width:max-content"><div style="display:grid;#{ws}">          <div style="width:20px;height:10px"></div></div></div>))
      end
      ['', 'white-space:normal'].each do |ws|
        expect_parity(%(<div style="width:max-content"><div style="display:grid;#{ws}">          <div style="width:20px;height:10px"></div></div></div>))
      end
    end
  end

end
