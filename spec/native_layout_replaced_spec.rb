# frozen_string_literal: true
# Native layout — REPLACED LEAF sizing, geometry shadow-parity. A replaced element (svg / img / canvas /
# input / …) lays out no CSS-box children of its own; its INTRINSIC size is data the walk hands native (a
# decoded image's natural size, a control's chrome, an svg's viewBox), and native sizes the box from it as
# the oracle's `usedSize` does (`replaced_box`: declared sizes win, an intrinsic ratio derives the other axis,
# min/max clamp through the ratio, a border box floors at its edges). Handled as a BLOCK-LEVEL child, a FLEX
# ITEM (row and column, sized natively) and a GRID ITEM. Still DECLINES: an INLINE replaced element (an atomic
# inline in a text line) and a control that lays out its own content (a child carries an `_lb`). V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout replaced-leaf parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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

  # BLOCK-LEVEL replaced children of a block.
  it 'matches a block-level svg among block siblings' do
    expect_parity('<div style="width:300px"><div style="height:20px"></div><svg width="40" height="30" style="display:block"></svg><div style="height:15px"></div></div>')
  end
  it 'matches a block-level img with margins (flow positioning)' do
    expect_parity('<div style="width:300px"><img width="50" height="20" style="display:block;margin:12px 0 8px"><div style="height:10px"></div></div>')
  end
  it 'matches a block-level canvas' do
    expect_parity('<div style="width:300px"><canvas width="60" height="40" style="display:block"></canvas></div>')
  end
  it 'matches a block-level text input sized by CSS' do
    expect_parity('<div style="width:300px"><input type="text" style="display:block;width:120px;height:24px"></div>')
  end

  # Replaced elements as FLEX ITEMS (blockified — computed display doesn't matter).
  it 'matches a block-display svg flex item beside a plain item' do
    expect_parity('<div style="display:flex;gap:10px;width:400px"><svg width="24" height="24" style="display:block"></svg><div style="width:80px;height:24px"></div></div>')
  end
  it 'matches an INLINE-display svg flex item (blockified in the flex line)' do
    expect_parity('<div style="display:flex;align-items:center;width:400px"><svg width="24" height="24"></svg><div style="width:80px;height:40px"></div></div>')
  end
  it 'matches an img and an input as flex items with justify-content' do
    expect_parity('<div style="display:flex;justify-content:space-between;width:400px"><img width="30" height="30"><input type="text" style="width:100px;height:24px"></div>')
  end

  # A replaced element carrying explicit border+padding (its _lb is the border box; native replays it whole).
  it 'matches a bordered, padded block-level svg' do
    expect_parity('<div style="width:300px"><svg width="40" height="30" style="display:block;border:3px solid;padding:5px"></svg></div>')
  end

  # A block svg with INTERNAL content (<path>/<g>/…): SVG paints its subtree through the SVG model, not the CSS
  # box model — the oracle stamps a degenerate _lb on those descendants, but they must NOT make the svg a
  # non-leaf (native would otherwise lay them out as CSS boxes and mismatch). A sized svg is always a leaf; native
  # replays its viewBox-sized box and emits no subtree. (This icon-with-a-path shape is pervasive in real apps.)
  it 'matches a block svg with internal path/g content (leaf — svg descendants are painted, not laid out)' do
    expect_parity('<div style="width:200px"><svg viewBox="0 0 24 24" style="height:16px;display:block"><path d="M4 4h16v16H4z"/><g><circle cx="5" cy="5" r="2"/></g></svg></div>')
  end
  it 'matches a flex-item svg icon with internal content (leaf)' do
    expect_parity('<div style="display:flex;align-items:center;width:200px"><svg viewBox="0 0 20 20" style="height:16px"><path d="M0 0h20v20z"/></svg><div style="width:40px;height:16px"></div></div>')
  end

  # STILL DECLINES.
  it 'lays out an INLINE svg in a block (atomic inline — see native_layout_inline_atomic_spec)' do
    expect_parity('<div style="width:300px">text <svg width="16" height="16"></svg> more</div>')
  end
  it 'lays out an inline-block img in a block (atomic inline — see native_layout_inline_atomic_spec)' do
    expect_parity('<div style="width:300px"><img width="20" height="20" style="display:inline-block"></div>')
  end
  # A control that lays out its OWN content (a display:block <select> whose options carry _lb) is NOT a leaf:
  # the oracle sizes it from its intrinsic (one-row) size, so native must decline rather than stack the options.
  it 'declines a display:block <select> that lays out its options (sized by intrinsic, not child flow)' do
    expect_bail('<div style="width:300px"><select style="display:block"><option>aaaa</option><option>bb</option></select></div>')
  end

  # ── Sized natively from the intrinsic data ─────────────────────────────────────────────────────────────
  describe 'native replaced sizing' do
    it 'sizes an undecoded img at its 16x16 placeholder, a declared axis deriving the other through the ratio' do
      expect_parity('<div style="width:400px"><img><div style="height:10px"></div></div>')
      expect_parity('<div style="width:400px"><img style="display:block;width:100px"><img style="display:block;height:40px"><img style="display:block;width:100px;height:40px"></div>')
      expect_parity('<div style="width:400px"><img style="display:block;width:50%"><img style="display:block;height:10%"></div>')
    end
    it 'adds edges to a content-box replaced size and floors a border box at its edges' do
      expect_parity('<div style="width:400px"><img style="display:block;width:100px;padding:5px;border:2px solid"><img style="display:block;width:100px;padding:5px;box-sizing:border-box"></div>')
    end
    it 'clamps through the ratio: the binding clamp scales the content box and the other axis follows' do
      expect_parity('<div style="width:400px"><img style="display:block;width:100px;max-height:20px"><img style="display:block;width:100px;min-height:80px"><img style="display:block;height:64px;max-width:20px"></div>')
      expect_parity('<div style="width:400px"><img style="display:block;max-width:8px;max-height:20px"><img style="display:block;min-width:30px;min-height:50px"></div>')
    end
    it 'sizes a ratio-only svg (viewBox) from the room on offer, or from a declared axis' do
      expect_parity('<div style="width:400px"><svg viewBox="0 0 4 3" style="display:block"></svg><div style="height:5px"></div></div>')
      expect_parity('<div style="width:400px"><svg viewBox="0 0 4 3" style="display:block;height:60px"></svg><svg viewBox="0 0 4 3" style="display:block;width:80px"></svg><svg style="display:block"></svg></div>')
    end
    it 'sizes controls and other replaced elements from their intrinsic size' do
      expect_parity('<div style="width:400px"><input type="checkbox" style="display:block"><input type="range" style="display:block"><input type="file" style="display:block"><iframe style="display:block"></iframe><canvas style="display:block"></canvas><video style="display:block"></video></div>')
      expect_parity('<div style="width:400px"><img style="display:block;margin:5px 10px"><div style="height:10px"></div><img style="display:block;margin-top:8px"></div>')
    end
    it 'sizes replaced flex items natively: intrinsic base, no ratio stretches, a ratio keeps its own' do
      expect_parity('<div style="display:flex;width:400px"><img><div style="flex:1">text</div></div>')
      expect_parity('<div style="display:flex;width:400px"><input><div style="flex:1;height:60px">text</div></div>')
      expect_parity('<div style="display:flex;width:400px"><img style="width:100px"><img style="flex:1;width:100px"><div style="width:50px;height:80px"></div></div>')
      expect_parity('<div style="display:flex;width:400px"><svg viewBox="0 0 4 3"></svg><div style="width:100px;height:20px"></div></div>')
      expect_parity('<div style="display:flex;width:100px"><img style="width:300px"><div style="width:300px">shrink</div></div>')
      expect_parity('<div style="display:flex;width:100px"><img><input><textarea></textarea></div>')
      expect_parity('<div style="display:flex;width:400px"><button>a button</button><div style="flex:1">x</div></div>')
    end
    it 'sizes replaced column items natively (stretch fills a no-ratio control, a ratio box keeps its width)' do
      expect_parity('<div style="display:flex;flex-direction:column;width:300px"><img><input><div>text</div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;align-items:flex-start"><img><input><svg viewBox="0 0 4 3"></svg></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:200px"><img style="flex:1"><input style="flex:1"><div style="height:30px"></div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:100px;flex-wrap:wrap"><img style="height:60px"><input style="height:60px"><div style="height:60px;width:30px"></div></div>')
    end
    # A replaced column item's automatic minimum (review finding, Chrome-measured in both engines): a RATIO box
    # (img, viewBox svg) may shrink to nothing, a ratio-less control keeps its intrinsic height; a stretching
    # ratio box in a multi-line column takes the container's width for its measure.
    it 'lets a ratio item shrink below its intrinsic height in a column but floors a control at its own' do
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:20px"><img style="height:100px"><div style="height:50px"></div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:20px"><input style="height:100px"><div style="height:50px"></div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:20px"><img><input><div style="height:50px"></div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:20px"><img style="flex:1"><input style="flex:1"><div style="height:50px"></div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;width:300px;height:100px"><svg viewBox="0 0 4 3" style="flex:1"></svg><div style="height:30px"></div></div>')
      expect_parity('<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:300px;height:100px"><svg viewBox="0 0 4 3"></svg><div style="height:60px;width:30px"></div></div>')
    end
    it 'declines a block-level button (the oracle shrink-wraps it to its content)' do
      expect_bail('<div style="width:400px"><button style="display:block">a long button label</button><div style="height:10px"></div></div>')
    end
    it 'sizes replaced grid items natively, contributing their intrinsic width to intrinsic tracks' do
      expect_parity('<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><img><div style="height:20px">b</div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px 100px;width:400px"><img><input><svg viewBox="0 0 4 3"></svg><canvas></canvas></div>')
      expect_parity('<div style="display:grid;grid-template-columns:max-content 1fr;width:400px"><input><div>b</div></div>')
    end
    it 'gives a replaced item no baseline of its own (its bottom margin edge), and skips a block-level one as a candidate' do
      expect_parity('<div style="display:flex;align-items:baseline;width:400px"><img><div style="font-size:32px">BIG</div></div>')
      expect_parity('<div style="display:flex;align-items:baseline;width:400px"><div><img style="display:block"><p style="margin:0">after img</p></div><div style="font-size:32px">BIG</div></div>')
    end
  end
end
