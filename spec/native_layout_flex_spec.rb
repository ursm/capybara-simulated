# frozen_string_literal: true
# Native layout — flex (§9.7), geometry shadow-parity. The item SIZING is resolved JS-side (each item's used
# main+cross size rides its record, like a float's shrink-to-fit width); native does only the PLACEMENT —
# main-axis distribution (justify-content + gap + main-axis auto margins), cross-axis alignment
# (align-items/self + cross-axis auto margins + first/last baseline), and the container's own box. Supported:
# row / column in ANY writing mode (a vertical mode's row lays out along Y — `plan.mainIsX` already said so,
# and the gate that refused it was left over from when native's flex axes were physical), nowrap / wrap /
# wrap-reverse, main-axis reverse (row-reverse / column-reverse / rtl ROW), a cross axis running back from the
# far physical edge in EITHER direction (an rtl COLUMN, a `*-rl` mode's ROW, a `sideways-lr` COLUMN, anything
# under `wrap-reverse`), nested flex, position:relative offsets, main- and cross-axis auto item margins, row &
# column min/max-height (incl. declared-height wrapping columns) + a column's cross min/max-width,
# align-items/self:baseline & last baseline, out-of-flow (absolute / fixed) items placed at their
# oracle-resolved box.
#
# A reversed cross axis is ONE mechanism: native mirrors three things within the container cross — the order
# the lines stack in, where the stack starts, and a `stretch` line's far edge — while each line still runs
# cross-start to cross-end inside itself, because the item keywords arrive physical from the walk. Which
# containers have one is a question about the writing mode, the direction AND the wrap together, and the
# measured table below is the statement of it. `wrap-reverse` is a SECOND flag, not the same one: it is what
# the flow-relative `start` / `end` follow, and a `vertical-rl` row has a reversed cross without it.
#
# Still DECLINES to JS: a WRAPPING AUTO-height column with a max-height (it breaks its lines against that
# capacity), a float, inline-block
# items. A REPLACED item (svg / img / input …) is now replayed as a leaf box (see native_layout_replaced_spec).
# Each bail is an A/B: the feature-carrying input declines, a sibling without it stays native. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/walk_refusals'

RSpec.describe 'native layout flex parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # …in a session DISPOSED at once, not at the end of the example. These examples sweep a table of shapes,
  # and `simulated_session` defers disposal: the align-content one held 576 live V8 isolates and took the
  # file's peak RSS to 9.52 GB (measured), where the gate runs it under flatware beside six sweeps and has
  # been taken down by the OOM killer once already. Same 195 examples at 229 MB.
  def run_shadow(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    end
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  # Parity, AND the row's item widths were resolved by the native engine (`flex_row_sizes`), not pushed —
  # `nativeFlexRows` counts the flex rows that took that path.
  def expect_native_flex(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeFlexRows']).to be >= 1, "the row's item widths were pushed, not native: #{r.inspect}"
  end

  # Every item's box relative to its container, for an example that has to say WHERE the boxes landed and
  # not only that the two engines agree about it.
  def item_boxes(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script(<<~JS)
        (function () {
          var c = document.body.firstElementChild, o = c.getBoundingClientRect();
          return Array.prototype.map.call(c.children, function (e) {
            var r = e.getBoundingClientRect();
            return [r.x - o.x, r.y - o.y, r.width, r.height];
          });
        })()
      JS
    end
  end

  def first_item_box(body) = item_boxes(body).first

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

  # A flex ITEM that is itself a flex container with an AUTO height + min/max-height: the parent-push overwrites
  # its height with the final (clamped) box, so native carries the item's autoHeight on rec[54] and recomputes
  # the box from the container's own content — a min-height FLOOR aligns the items in the pre-floor content
  # (the Avo `field-wrapper` row), a max-height CAP lets a taller row overflow. Only a box the FLOW made DEFINITE
  # (stretch / abspos) that a clamp then BINDS still declines (native holds no pre-clamp extent).
  it 'matches a flex-item row whose min-height floors its content, items centered in the pre-floor content' do
    expect_parity('<div style="display:flex;width:400px"><div style="display:flex;align-items:center;min-height:80px;flex:1"><div style="width:50px;height:30px"></div></div></div>')
  end
  it 'matches a flex-item row whose min-height floors its content, items at flex-end of the pre-floor content' do
    expect_parity('<div style="display:flex;width:400px"><div style="display:flex;align-items:flex-end;min-height:80px;flex:1"><div style="width:50px;height:30px"></div></div></div>')
  end
  it 'matches a flex-item row whose max-height caps the box while its taller content overflows' do
    expect_parity('<div style="display:flex;width:400px"><div style="display:flex;align-items:center;max-height:20px;flex:1"><div style="width:50px;height:50px"></div></div></div>')
  end
  it 'matches a flex-item column whose min-height floors the main extent for justify-content' do
    expect_parity('<div style="display:flex;width:400px"><div style="display:flex;flex-direction:column;justify-content:space-between;min-height:120px;flex:1"><div style="width:40px;height:20px"></div><div style="width:40px;height:20px"></div></div></div>')
  end
  it 'matches a cross-stretched flex-item row with a NON-binding min-height (box on the stretch extent)' do
    expect_parity('<div style="display:flex;height:200px;width:400px"><div style="display:flex;flex-direction:column;justify-content:space-between;min-height:100px;flex:1"><div style="width:40px;height:20px"></div><div style="width:40px;height:20px"></div></div></div>')
  end
  # DECLINES: a box the FLOW made definite (stretch) then a clamp BINDS away from the pre-clamp extent — native
  # holds only the post-clamp box, so it cannot recover where the items sit. A/B: drop the clamp → native.
  it 'declines a cross-stretched flex row clamped BELOW the stretch by max-height (items placed against the pre-clamp stretch)' do
    a_bails_b_native('<div style="display:flex;height:120px;align-items:stretch;width:400px"><div style="display:flex;max-height:80px;align-items:center"><div style="width:50px;height:20px"></div></div></div>',
                     '<div style="display:flex;height:120px;align-items:stretch;width:400px"><div style="display:flex;align-items:center"><div style="width:50px;height:20px"></div></div></div>')
  end
  it 'declines a cross-stretched flex row whose min-height floors ABOVE the stretch (items placed against the smaller stretch)' do
    a_bails_b_native('<div style="display:flex;height:40px;align-items:stretch;width:400px"><div style="display:flex;min-height:120px;align-items:center"><div style="width:50px;height:20px"></div></div></div>',
                     '<div style="display:flex;height:40px;align-items:stretch;width:400px"><div style="display:flex;align-items:center"><div style="width:50px;height:20px"></div></div></div>')
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

  # An abspos / fixed flex CONTAINER is out of flow: its parent replays its oracle-resolved box (insets / static
  # position) and native lays out its items within it — the position never enters the flex sizing. A STICKY one
  # is in flow and lays out like a static one. (Before this, the flex gate rejected any non-static position.)
  it 'matches an absolutely-positioned flex container placed by insets' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:10px;left:20px;display:flex;gap:8px"><div style="width:40px;height:30px"></div><div style="width:40px;height:50px"></div></div></div>')
  end
  it 'matches an absolutely-positioned flex container sized by left+right insets' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;left:10px;right:40px;top:5px;display:flex;justify-content:space-between"><div style="width:40px;height:30px"></div><div style="width:40px;height:30px"></div></div></div>')
  end
  it 'matches a fixed-position flex container' do
    expect_parity('<div style="width:300px;height:100px"><div style="position:fixed;top:5px;left:5px;display:flex"><div style="width:30px;height:30px"></div><div style="width:30px;height:30px"></div></div></div>')
  end
  it 'matches a sticky flex container' do
    expect_parity('<div style="width:300px;height:400px"><div style="position:sticky;top:0;display:flex"><div style="width:30px;height:30px"></div></div></div>')
  end
  # An abspos flex container is SELF-SIZED (autoHeight true) but its oof replay pushes the clamped box + clears
  # rec[54], so measure_flex can't two-phase — a binding min/max-height would mislay the items in the clamped
  # cross. Decline it (mirroring the autoHeight===false in-flow case); a NON-binding clamp stays native.
  it 'declines an abspos flex row whose min-height binds (no two-phase after the oof replay)' do
    a_bails_b_native('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:0;left:0;display:flex;align-items:center;min-height:80px"><div style="width:40px;height:30px"></div></div></div>',
                     '<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:0;left:0;display:flex;align-items:center"><div style="width:40px;height:30px"></div></div></div>')
  end
  it 'matches an abspos flex row with a NON-binding min-height (box on its content extent)' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:0;left:0;display:flex;align-items:center;min-height:20px"><div style="width:40px;height:60px"></div></div></div>')
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

  # `wrap-reverse` turns the cross axis round, which native mirrors: the stack order, where it starts, and a
  # `stretch` line's far edge. Measured in Chrome, three 20px items one per line in a 90px container — each
  # line grown to 30 by the default `align-content: stretch` — the first item sits at 70 where a plain `wrap`
  # leaves it at 0. Both halves of that move: the FIRST line is the lowest (its line spans 60..90), and an
  # unstretchable `stretch` item sits at its line's cross-START, which is that line's BOTTOM edge.
  it('matches flex-wrap:wrap-reverse') { expect_parity('<div style="display:flex;flex-wrap:wrap-reverse;width:120px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it 'stacks a wrap-reverse row from the far edge' do
    rows = '<div style="width:60px;height:20px"></div>' * 3
    expect(first_item_box(%(<div style="display:flex;flex-wrap:wrap-reverse;width:100px;height:90px">#{rows}</div>))[1]).to eq(70)
    expect(first_item_box(%(<div style="display:flex;flex-wrap:wrap;width:100px;height:90px">#{rows}</div>))[1]).to eq(0)
    # …and `align-items: flex-start`, which follows the AXIS, puts it at the same 70 without the line grow
    expect(first_item_box(%(<div style="display:flex;flex-wrap:wrap-reverse;align-items:flex-start;width:100px;height:90px">#{rows}</div>))[1]).to eq(70)
  end
  # align-content:stretch with lines that MIX stretch-filled and explicit cross sizes: a natively-sized row
  # grows its lines from their NATURAL crosses, so the mix is computed (it declined while item boxes were pushed).
  it 'matches a mixed stretch/explicit wrap under align-content:stretch' do
    expect_native_flex('<div style="display:flex;flex-wrap:wrap;width:250px;height:200px"><div style="width:100px"></div><div style="width:100px"></div><div style="width:100px;height:50px"></div></div>')
  end
  # An rtl flex ROW reverses the main axis (first item at the right); once rtl blocks lay out natively (r1) its
  # items no longer decline, so the whole row is native.
  it 'matches an rtl flex row (main axis reversed, first item at the right)' do
    expect_parity('<div style="display:flex;direction:rtl;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>')
  end
  # An rtl flex COLUMN packs its items from the RIGHT edge (its cross axis runs right→left). `crossAlignPhysical`
  # flips each item's align onto the physical cross, so native's forward-frame placement lands them correctly —
  # a non-stretching `stretch` item at the right too. A cross (horizontal) auto MARGIN or a WRAP still declines.
  it 'matches an rtl flex column (items packed from the right)' do
    expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;width:200px;height:120px"><div style="height:30px"></div><div style="width:60px;height:40px"></div></div>')
    expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;align-items:center;width:200px;height:120px"><div style="width:50px;height:30px"></div><div style="width:70px;height:40px"></div></div>')
    expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;align-items:flex-end;width:200px;height:120px"><div style="width:50px;height:30px"></div><div style="width:70px;height:40px"></div></div>')
  end
  # A `stretch` item that can't fill its line sits at the cross-start — the RIGHT edge here — whether it's short
  # of the width (a max-width, or an explicit width), OVER it (a min-width), or aligned by self. The oracle maps
  # `stretch` → flex-end on a reversed cross unconditionally, so native's code-2 placement must too (it once only
  # flipped an explicitly-sized item, leaving a min/max-clamped one wrongly at the LEFT).
  it 'matches an rtl flex column whose stretch item is clamped short of / past its line' do
    expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;width:200px;height:120px"><div style="max-width:60px;height:30px"></div><div style="height:30px"></div></div>')
    expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;width:200px;height:120px"><div style="min-width:300px;height:30px"></div></div>')
    expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;align-items:stretch;width:200px;height:120px"><div style="max-width:40px;height:30px;align-self:stretch"></div></div>')
  end
  # A baseline GROUP is anchored as a whole — `baseline` at its line's cross-START, `last baseline` at its
  # cross-END — so WHICH PHYSICAL EDGE each of those is swaps on a reversed cross. Measured in Chrome, a 90px
  # row of a 12px and a 32px item (a 37px group): `baseline` puts them at 18/0 and, under `wrap-reverse`, at
  # 71/53 — and `last baseline` is the same pair the other way round.
  it 'anchors a baseline group at the end of the cross axis it actually has' do
    items = '<div style="font-size:12px">a</div><div style="font-size:32px">A</div>'
    ['baseline', 'last baseline'].each do |a|
      ['', 'flex-wrap:wrap-reverse;'].each do |w|
        expect_parity(%(<div style="display:flex;#{w}align-items:#{a};width:400px;height:90px">#{items}</div>))
      end
    end
    # …and the swap itself, which parity alone cannot see: the group moves to the other edge of the line.
    plain = first_item_box(%(<div style="display:flex;align-items:baseline;width:400px;height:90px">#{items}</div>))[1]
    flipped = first_item_box(%(<div style="display:flex;flex-wrap:wrap-reverse;align-items:baseline;width:400px;height:90px">#{items}</div>))[1]
    expect([plain, flipped]).to eq([18, 71])
  end
  # `align-content` takes a BASELINE keyword that lines have no baseline to share for, so it falls back —
  # and the two spellings fall back differently. Chrome, three 20px lines in a 90px row: `baseline` /
  # `first baseline` land where `flex-start` does (0/20/40, no line grow) and `last baseline` where `normal`
  # does (0/30/60); under `wrap-reverse`, 70/50/30 against 70/40/10. The two engines disagreed here — each
  # was right about one of the pair — for 96 shapes of a 7296-case sweep.
  it 'falls a baseline align-content back the way each spelling does' do
    lines = '<div style="width:60px;height:20px"></div>' * 3
    stack = ->(wrap, k) {
      item_boxes(%(<div style="display:flex;flex-wrap:#{wrap};width:100px;height:90px;align-content:#{k}">#{lines}</div>)).map { it[1] }
    }
    # Chrome, measured. The two fallbacks are different places, which is what makes the pairing below a claim.
    {'wrap' => [[0, 20, 40], [0, 30, 60]], 'wrap-reverse' => [[70, 50, 30], [70, 40, 10]]}.each do |wrap, (first, last)|
      expect(stack.call(wrap, 'baseline')).to eq(first), wrap
      expect(stack.call(wrap, 'first baseline')).to eq(first), wrap
      expect(stack.call(wrap, 'last baseline')).to eq(last), wrap
      # …which are exactly where each spelling's twin lands
      expect(stack.call(wrap, 'flex-start')).to eq(first), wrap
      expect(stack.call(wrap, 'normal')).to eq(last), wrap
      ['baseline', 'first baseline', 'last baseline'].each do |k|
        expect_parity(%(<div style="display:flex;flex-wrap:#{wrap};width:100px;height:90px;align-content:#{k}">#{lines}</div>))
      end
    end
  end
  it('matches an rtl flex column with a cross auto margin') { expect_parity('<div style="display:flex;flex-direction:column;direction:rtl;width:200px;height:120px"><div style="width:50px;height:30px;margin-left:auto"></div></div>') }
  it('matches an rtl WRAPPING flex column') { expect_parity('<div style="display:flex;flex-direction:column;flex-wrap:wrap;direction:rtl;width:200px;height:60px"><div style="width:40px;height:30px"></div><div style="width:50px;height:40px"></div></div>') }
  it('declines max-height on a WRAPPING column (breaks lines against the capacity)') { a_bails_b_native('<div style="display:flex;flex-direction:column;flex-wrap:wrap;max-height:40px;width:300px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>', '<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:300px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  # A flex container's own % padding resolves against its CONTAINING BLOCK's width on both axes (§ CSS Box),
  # which is Chrome's rule and the oracle's now — so an explicitly-sized container carrying one lays out
  # natively, and so does an item whose own % padding joins its flex base.
  it('matches percentage vertical padding on an explicitly-sized flex container') { expect_parity('<div style="width:400px"><div style="display:flex;flex-direction:column;width:100px;padding-top:10%"><div style="width:80px;height:30px"></div></div></div>') }
  it('matches a flex item whose own percentage padding joins its base') { expect_parity('<div style="display:flex;width:400px"><div style="padding:0 10%">a b</div><div style="flex:1">x</div></div>') }
  # A ROW's own % vertical padding reaches its cross size too (the container's content box, which decides where
  # its items align and how tall an auto-height one is).
  it('matches percentage vertical padding on a flex ROW whose width differs from its containing block') { expect_parity('<div style="width:400px"><div style="display:flex;width:200px;padding:10% 0"><div>a</div></div></div>') }
  it('matches a percentage-padded ROW aligning its items in the cross axis') { expect_parity('<div style="width:400px"><div style="display:flex;width:200px;padding:10% 0;align-items:center;height:200px"><div>a</div><div style="height:60px">b</div></div></div>') }
  it('matches a percentage-padded WRAPPING row distributing its lines') { expect_parity('<div style="width:400px"><div style="display:flex;width:200px;padding:10% 0;flex-wrap:wrap;align-content:center;height:200px"><div>a</div></div></div>') }
  # An item MEASURED inside another container converts its flex-basis / min / max-width with the BASIS-LESS
  # edges, as every intrinsic figure does — and an `auto` margin is zero per SIDE, not for both.
  it('matches a percentage-padded item inside an intrinsically measured flex container') { expect_parity('<div style="display:flex;width:400px"><div style="display:flex"><div style="padding:0 10%;min-width:50px;width:20px;height:10px"></div></div><div>x</div></div>') }
  it('matches an auto margin beside a real one on a measured item') { expect_parity('<div style="display:flex;width:400px"><div style="display:flex"><div style="margin-left:auto;margin-right:30px;width:50px;height:10px"></div></div><div>x</div></div>') }
  it('matches a percentage-padded TABLE measured inside a flex item') { expect_parity('<div style="display:flex;width:400px"><div><table style="padding:0 10%"><tr><td>hello</td></tr></table></div><div>x</div></div>') }
  # A shrink-to-fit COLUMN item and a row item's automatic MINIMUM both carry the item's own percentage padding
  # (the mirror of the row base's correction; Chrome floors the shrinking item at 52 in a 100px row).
  it('matches a percentage-padded shrink-to-fit column item') { expect_parity('<div style="width:400px"><div style="display:flex;flex-direction:column;align-items:flex-start"><div style="padding:0 10%">hello there</div></div></div>') }
  it('matches a percentage-padded item floored by its automatic minimum') { expect_parity('<div style="display:flex;width:100px"><div style="padding:0 10%;flex-shrink:1">hello there</div><div style="width:90px;flex-shrink:0">x</div></div>') }
  it('matches a percentage padding item beside a fixed one') { expect_parity('<div style="display:flex;width:400px"><div style="padding-left:10%">a</div><div style="width:80px">b</div></div>') }
  it('matches an inline-block item with an explicit size (blockified)') { expect_parity('<div style="display:flex;width:400px"><span style="display:inline-block;width:80px;height:30px"></span><div style="width:80px;height:30px"></div></div>') }
  # An INLINE-FLEX flex item is BLOCKIFIED (§4: inline-flex → flex): it lays out as a block-level flex container
  # (its flex-resolved box pushed, its own items flexed within it), not as an atomic inline. The pervasive #1
  # bail before this. (An atomic inline-flex is native's own now too -- see native_layout_inline_atomic_spec.)
  it('matches an inline-flex flex item (blockified to flex — items flexed within it)') { expect_parity('<div style="display:flex;width:400px"><div style="display:inline-flex;gap:8px;align-items:center"><div style="width:30px;height:30px"></div><div style="width:20px;height:40px"></div></div><div style="width:50px;height:20px"></div></div>') }
  it('matches an inline-flex flex item with justify-content:space-between') { expect_parity('<div style="display:flex;width:400px"><div style="display:inline-flex;justify-content:space-between;width:200px"><div style="width:30px;height:30px"></div><div style="width:20px;height:30px"></div></div></div>') }
  it('matches an inline-flex COLUMN flex item') { expect_parity('<div style="display:flex;width:400px"><div style="display:inline-flex;flex-direction:column"><div style="width:30px;height:30px"></div><div style="width:30px;height:20px"></div></div></div>') }
  it('matches an inline-flex GRID item (blockified to flex)') { expect_parity('<div style="display:grid;grid-template-columns:200px;width:200px"><div style="display:inline-flex;gap:6px;align-items:center"><div style="width:30px;height:30px"></div><div style="width:20px;height:40px"></div></div></div>') }
  # `float` does not apply to a flex item (§4): it neither floats nor goes out of flow — the item is laid out as
  # an ordinary flex item with its float ignored, so native places it as one rather than declining.
  it('matches a floated flex item (float ignored — laid out as an ordinary item)') { expect_parity('<div style="display:flex;width:400px"><div style="float:left;width:80px;height:30px"></div><div style="width:80px;height:40px"></div></div>') }
  it('matches a floated flex item with align-items:center (float ignored)') { expect_parity('<div style="display:flex;align-items:center;width:400px;height:100px"><div style="float:left;width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div>') }
  it('matches a floated flex item with flex-grow (float ignored, grows to fill)') { expect_parity('<div style="display:flex;width:400px"><div style="float:left;flex:1;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('matches a nested wrap-reverse flex item') { expect_parity('<div style="display:flex;width:400px"><div style="display:flex;flex-wrap:wrap-reverse;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('matches a flex container with min-height AND percentage vertical padding') { expect_parity('<div style="width:400px"><div style="display:flex;flex-direction:column;min-height:100px;padding-top:10%;width:100px"><div style="width:80px;height:30px"></div></div></div>') }
  it('declines a cross-stretched column clamped by max-height (oracle sizes against the pre-clamp room native lacks)') { a_bails_b_native('<div style="display:flex;height:300px;width:400px"><div style="display:flex;flex-direction:column;max-height:100px;row-gap:20%;width:100px"><div style="height:20px"></div><div style="height:30px"></div></div></div>', '<div style="display:flex;height:300px;width:400px"><div style="display:flex;flex-direction:column;row-gap:20%;width:100px"><div style="height:20px"></div><div style="height:30px"></div></div></div>') }
  # A flex-ITEM flex ROW whose min-height floors its own (auto) content lays out natively: the item's autoHeight
  # rides rec[54] past the parent-push, so native recomputes the cross from content and two-phases the clamp —
  # the child aligns in the PRE-floor content (align-items:center in a 30px content → 0), box grows to min-height.
  it('matches an auto-height min-height ROW that is itself a flex item (two-phase floor, align in pre-floor content)') { expect_parity('<div style="display:flex;flex-direction:column;width:300px"><div style="display:flex;align-items:center;min-height:120px;width:200px"><div style="width:50px;height:30px"></div></div></div>') }
  # An inline-flex container is an ATOMIC inline in its parent's line, and native lays it out ITSELF now -- at
  # the line's shrink-to-fit, which is its intrinsic width.
  it('matches an inline-flex container as an atomic inline') { expect_parity('<div style="display:inline-flex;width:400px"><div style="width:80px;height:30px"></div></div>') }
  # Bare (non-whitespace) text directly in a flex container is an anonymous flex item. The oracle does not lay
  # it out as a real item (siblings ignore it), it only floors the container's AUTO cross size at the text's
  # line-height; native reproduces both. These lay out rather than decline.
  it 'matches bare text beside a SHORT item (line-height floors the auto row height)' do
    expect_parity('<div style="display:flex;width:400px">loose text<div style="width:80px;height:10px"></div></div>')
  end
  it 'matches bare text beside a TALL item (the item, not the line-height, sets the row height)' do
    expect_parity('<div style="display:flex;width:400px">loose text<div style="width:80px;height:40px"></div></div>')
  end
  it 'matches bare text BETWEEN two items with justify-content (siblings ignore the text)' do
    expect_parity('<div style="display:flex;justify-content:space-between;width:400px"><div style="width:80px;height:20px"></div>middle<div style="width:80px;height:20px"></div></div>')
  end
  it 'matches bare text in an auto-height COLUMN (line-height floors the column main size)' do
    expect_parity('<div style="display:flex;flex-direction:column;width:200px">only text</div>')
  end
  it 'matches bare text with a DECLARED height (line-height does not grow a fixed box)' do
    expect_parity('<div style="display:flex;height:50px;width:400px">text<div style="width:80px;height:10px"></div></div>')
  end
  it 'matches bare text with a main gap between the real items' do
    expect_parity('<div style="display:flex;gap:15px;width:400px">lead<div style="width:60px;height:20px"></div><div style="width:60px;height:20px"></div></div>')
  end
  # The line-height floor grows the LINE the items align within (not just the box): a short item under a
  # non-stretch alignment sits inside that grown line, so its cross position depends on the floor.
  it 'matches bare text taller than a CENTER-aligned short item (item centres in the grown line)' do
    expect_parity('<div style="display:flex;align-items:center;width:400px">text<div style="width:80px;height:10px"></div></div>')
  end
  it 'matches bare text taller than a FLEX-END-aligned short item' do
    expect_parity('<div style="display:flex;align-items:flex-end;width:400px">text<div style="width:80px;height:10px"></div></div>')
  end
  it 'matches bare text with a BASELINE-aligned short item' do
    expect_parity('<div style="display:flex;align-items:baseline;width:400px">text<div style="width:80px;height:10px"></div></div>')
  end
  it 'matches a WRAPPING row where the line-height floor exceeds the stacked line (align-content shares the surplus)' do
    expect_parity('<div style="display:flex;flex-wrap:wrap;align-content:center;width:400px">text<div style="width:60px;height:8px"></div></div>')
  end
  # A flex item is BLOCKIFIED (§4): an inline / inline-block item lays out as a block-level flex item.
  it('matches an inline element as a flex item (blockified)') { expect_parity('<div style="display:flex;gap:10px;width:400px"><label>Save changes</label><div style="width:80px;height:20px"></div></div>') }
  it('matches an inline-block element as a flex item') { expect_parity('<div style="display:flex;gap:10px;width:400px"><span style="display:inline-block">a tag here</span><div style="width:80px;height:20px"></div></div>') }
  it('matches an auto-width inline flex item whose text sets its size') { expect_parity('<div style="display:flex;width:500px"><label>one two three four</label><div style="width:100px;height:20px"></div></div>') }
  it('matches an inline flex item with an explicit width and block content') { expect_parity('<div style="display:flex;gap:8px;width:400px"><span style="display:inline-block;width:120px"><div style="height:20px;margin:4px"></div></span><div style="width:80px;height:30px"></div></div>') }
  it('matches several inline items with justify-content') { expect_parity('<div style="display:flex;justify-content:space-between;width:500px"><label>alpha</label><label>beta</label><label>gamma</label></div>') }
  it('matches an AUTO-width inline-block item carrying block children') { expect_parity('<div style="display:flex;width:400px"><span style="display:inline-block"><div style="height:20px">aaa</div><div style="width:60px;height:30px"></div></span><div style="width:80px;height:20px"></div></div>') }
  it('matches an inline flex item alongside align-items:center') { expect_parity('<div style="display:flex;align-items:center;height:80px;width:400px"><label>centered label</label><div style="width:60px;height:40px"></div></div>') }

  # A replaced element is a LEAF native replays (its box is oracle-resolved) — as an in-flow item and as an
  # out-of-flow (abspos) one — so these lay out rather than decline.
  it('matches a replaced (img) item') { expect_parity('<div style="display:flex;width:400px"><img src="x.png" style="width:80px;height:30px"><div style="width:80px;height:30px"></div></div>') }
  it('matches an absolute replaced (img) flex child') { expect_parity('<div style="position:relative;display:flex;width:400px;height:100px"><div style="width:80px;height:30px"></div><img src="x.png" style="position:absolute;top:0;left:0;width:40px;height:30px"></div>') }
  it('matches a position:sticky flex item') { expect_parity('<div style="display:flex;width:400px"><div style="position:sticky;top:0;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }

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

  # A content-box flex item's min/max-height are pushed as BORDER-box figures once its record says border-box
  # (the flex push): a `max-height: 50px; padding: 10px` item is a 70px box, not 50 (review finding, grid Phase 3).
  it 'clamps a content-box item with vertical edges by its max/min-height as border-box figures' do
    expect_parity('<div style="display:flex;align-items:flex-start;width:400px"><div style="max-height:50px;padding:10px"><div style="height:100px"></div></div></div>')
    expect_parity('<div style="display:flex;align-items:flex-start;width:400px"><div style="min-height:50px;padding:10px"><div style="height:10px"></div></div></div>')
    expect_parity('<div style="display:flex;align-items:flex-start;width:400px"><div style="display:grid;grid-template-columns:50px;max-height:50px;padding:10px"><div style="height:100px"></div></div></div>')
  end

  # ── Native ROW sizing ─────────────────────────────────────────────────────────────────────────────────
  # The items' widths resolved by the native engine (layout.rs `flex_row_sizes`, the oracle's flexRowMetrics +
  # resolveFlexibleLengths): flex base (basis / width / content), the automatic minimum (min-content, zero when
  # the item scrolls), declared min/max, line breaking on hypothetical sizes, grow / shrink with freezing, the
  # equal-share fallback for an item that measured nothing, then stretch as an imposed height.
  describe 'native row sizing' do
    let(:row) { 'display:flex;width:400px' }

    it 'grows in proportion to flex-grow and shrinks declared widths to fit' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:1">one</div><div style="flex:2">two words</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="width:300px">a</div><div style="width:300px">b</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="width:100px;flex-shrink:0">fixed</div><div style="width:500px">shrinks a lot of text</div></div>))
    end
    it 'bases an item on its content (max-content) and floors it at its min-content unless min-width says otherwise' do
      expect_native_flex(%(<div style="#{row}"><div>short</div><div>a somewhat longer text item here</div><div style="flex:1">grow</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1">verylongunbreakablewordthatoverflowsthecontainerwidth</div><div style="flex:1">short</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;min-width:0">verylongunbreakablewordthatoverflows</div><div style="flex:1">short</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;overflow-x:hidden">verylongunbreakablewordthatoverflowsthecontainerwidth</div><div style="flex:1">short</div></div>))
    end
    it 'clamps by min/max-width, freezing the clamped item and re-sharing what it gave up' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;max-width:80px">capped</div><div style="flex:1">rest</div><div style="flex:1;min-width:200px">floor</div></div>))
    end
    it 'reads flex-basis as a content-box length (border-box per box-sizing), a percentage, and the intrinsic keywords' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:0 0 100px;padding:0 10px">basis pad</div><div style="flex:0 0 100px;box-sizing:border-box;padding:0 10px">bb</div><div style="flex:1 1 0%">z</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex-basis:content;width:300px">content basis</div><div style="flex-basis:max-content">max</div><div style="flex-basis:min-content">min content basis</div><div style="flex-basis:fit-content">fit here</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;width:50%">pct</div><div style="flex:none;width:25%">quarter</div></div>))
    end
    it 'scales flex factors below one against the initial free space' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:1 0.25 200px">quarter</div><div style="flex:1 0.25 200px">quarter</div><div style="width:100px">x</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:0.5">half grow</div></div>))
    end
    it 'breaks lines on the hypothetical sizes and stacks them by align-content' do
      expect_native_flex(%(<div style="#{row};flex-wrap:wrap;gap:10px"><div style="width:150px;height:10px"></div><div style="width:150px;height:20px"></div><div style="width:150px;height:30px"></div></div>))
      expect_native_flex(%(<div style="#{row};flex-wrap:wrap;gap:10px;align-content:center;height:200px"><div style="width:150px;height:10px"></div><div style="width:150px;height:20px"></div><div style="width:150px;height:30px"></div></div>))
      expect_native_flex(%(<div style="#{row};flex-wrap:wrap"><div style="flex:1 1 150px;height:10px"></div><div style="flex:1 1 150px;height:20px"></div><div style="flex:1 1 150px;height:30px"></div></div>))
      expect_native_flex(%(<div style="#{row};flex-wrap:wrap;height:150px;align-content:stretch"><div style="width:300px;height:10px"></div><div style="width:300px">stretchy</div></div>))
    end
    it 'stretches an auto-height item to its line as an imposed height, its own min/max-height still clamping' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:1"><div style="height:10px"></div></div><div style="flex:1"><div style="height:30px"></div></div></div>))
      expect_native_flex(%(<div style="#{row};align-items:center"><div style="flex:1;height:10px"></div><div style="flex:1;height:30px"></div></div>))
      expect_native_flex(%(<div style="#{row};height:100px"><div style="flex:1"><div style="height:10px"></div></div><div style="flex:1;max-height:30px"><div style="height:50px"></div></div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;display:flex;align-items:center;min-height:50px"><div style="width:10px;height:10px"></div></div><div style="width:50px;height:80px">y</div></div>))
    end
    it 'gives an item that measured nothing an equal share, but an all-out-of-flow item its real zero' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:1"></div><div style="flex:1"><div></div></div><div style="width:50px">y</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1"><div style="position:absolute;width:30px;height:30px"></div></div><div style="width:50px">y</div></div>))
    end
    # A nested flex container's items are BLOCKIFIED for its content measure (CSS Flexbox §4): inline items do
    # not join into one word, inline-blocks are not atomics, and the container's own `white-space` pins nothing
    # (review finding — the oracle's contentIntrinsicWidths now blockifies flex items, as native does).
    it 'measures a nested flex item\'s keyword basis and automatic minimum with its items blockified' do
      expect_native_flex('<div style="display:flex;width:100px"><div style="flex:1;display:flex"><span>aaaa</span><span>bbbb</span></div><div style="width:90px">y</div></div>')
      expect_native_flex('<div style="display:flex;width:100px"><div style="flex:1;display:flex;flex-basis:max-content"><span>aaaa</span> <span>bbbb</span></div><div style="width:90px">y</div></div>')
      expect_native_flex('<div style="display:flex;width:100px"><div style="flex:1;display:flex;flex-basis:content"><span style="display:inline-block">aaaa</span><span style="display:inline-block">bbbb</span></div><div style="width:90px">y</div></div>')
      expect_native_flex('<div style="display:flex;width:120px"><a style="display:flex;gap:8px"><span>Brand</span><span>tagline</span></a><div style="display:flex;gap:12px"><a>One</a><a>Two</a></div></div>')
      expect_native_flex('<div style="display:flex;width:100px"><div style="flex:1;display:flex;white-space:nowrap"><div style="white-space:normal">aa bb cc dd</div></div><div style="width:90px">y</div></div>')
    end
    it 'keeps margins, gaps, auto margins, order, reverse and relative offsets on the native path' do
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;margin:5px 8px">m</div><div style="flex:1;margin-left:auto;width:50px">auto</div></div>))
      expect_native_flex(%(<div style="#{row};gap:20px"><div style="flex:1">a</div><div style="flex:1">b</div><div style="flex:1">c</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="order:2;flex:1">second</div><div style="order:1;width:50px">first</div></div>))
      expect_native_flex(%(<div style="#{row};flex-direction:row-reverse"><div style="flex:1">a</div><div style="width:50px">b</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;position:relative;top:3px">rel</div><div style="width:50px">y</div></div>))
      expect_native_flex(%(<div style="#{row}"><div style="flex:1;display:flex"><div style="flex:1">nested</div><div>x</div></div><div style="width:50px">y</div></div>))
    end
  end

  # ── Native COLUMN sizing ──────────────────────────────────────────────────────────────────────────────
  # The items' sizes resolved by the native engine (layout.rs `flex_column_sizes`, the oracle's
  # layoutFlexColumn up to placement): the cross (width) first — declared, stretched to the line, or
  # shrink-to-fit — then each item's flex base (basis / declared height / its content height MEASURED at that
  # width, the declared height set aside), the automatic minimum, line breaking against a definite height or a
  # max-height cap, `align-content` growing the lines and re-stretching their items, and the heights shared
  # against the definite height, a min-height floor the items underrun, or a max-height cap they overrun.
  describe 'native column sizing' do
    let(:col) { 'display:flex;flex-direction:column;width:300px' }

    it 'measures content heights for the bases and shares a definite height by flex-grow' do
      expect_native_flex(%(<div style="#{col}"><div>one line</div><div>two lines of text that wrap around here in the column</div></div>))
      expect_native_flex(%(<div style="#{col};height:300px"><div style="flex:1">a</div><div style="flex:2">b</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px;gap:10px"><div style="flex:1">a</div><div style="flex:1">b</div></div>))
    end
    it 'shrinks a declared-height item (its automatic minimum is its content, capped by the declaration)' do
      expect_native_flex(%(<div style="#{col};height:100px"><div style="flex:1">a</div><div style="height:200px">tall</div><div style="flex:1">c</div></div>))
      expect_native_flex(%(<div style="#{col};height:100px"><div style="flex:1"><p style="margin:0">a</p><p style="margin:0">b</p><p style="margin:0">c</p></div><div style="height:80px">tall</div></div>))
      expect_native_flex(%(<div style="#{col};height:100px"><div style="flex:1;min-height:0"><p style="margin:0">a</p><p style="margin:0">b</p><p style="margin:0">c</p></div><div style="height:80px">tall</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1"><div style="height:500px"></div></div><div style="height:30px">footer</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1;overflow-y:auto"><div style="height:500px"></div></div><div style="height:30px">footer</div></div>))
    end
    it 'divides a min-height floor the items underrun and a max-height cap they overrun' do
      expect_native_flex(%(<div style="#{col};min-height:200px"><div style="flex:1">a</div><div>b</div></div>))
      expect_native_flex(%(<div style="#{col};min-height:40px"><div style="height:20px"></div><div style="height:20px"></div><div style="height:20px"></div></div>))
      expect_native_flex(%(<div style="#{col};max-height:100px"><div style="height:200px;flex-shrink:1">shrinks</div></div>))
      expect_native_flex(%(<div style="#{col};max-height:100px"><div style="height:200px;min-height:150px">cannot</div></div>))
    end
    it 'sizes the cross axis: stretch fills, an aligned item shrinks to fit, declared / min / max widths clamp' do
      expect_native_flex(%(<div style="#{col};align-items:flex-start"><div>start aligned</div><div style="width:50px">fixed</div></div>))
      expect_native_flex(%(<div style="#{col};align-items:center"><div>centered text</div><div style="margin:0 auto">auto</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1;width:100px">declared width</div><div style="height:30px;width:400px">wide</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1;max-width:60px">capped width text</div><div style="height:30px;min-width:350px">min</div></div>))
    end
    it 'reads flex-basis as a length (content-box per box-sizing) or a percentage of the definite main size' do
      expect_native_flex(%(<div style="#{col}"><div style="flex:0 0 120px;padding:10px">basis pad</div><div style="flex:0 0 120px;box-sizing:border-box;padding:10px">bb</div><div style="flex-basis:50%">half</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex-basis:50%">half</div><div style="flex:1;max-height:30px"><div style="height:60px"></div></div><div style="flex:1;min-height:80px">min</div></div>))
      expect_native_flex(%(<div style="#{col}"><div style="flex:1 1 0;min-height:auto">zero basis text</div><div>b</div></div>))
    end
    it 'wraps against a definite height, sizes each line to its widest item, and re-stretches to the grown line' do
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap"><div style="height:60px;width:50px"></div><div style="height:60px;width:70px"></div><div style="height:60px;width:30px"></div></div>))
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap"><div style="height:60px">stretch me</div><div style="height:60px">and me too</div><div style="height:60px">x</div></div>))
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap;align-content:center"><div style="height:60px;width:50px"></div><div style="height:60px;width:70px"></div></div>))
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap;gap:5px 20px"><div style="height:60px;width:50px"></div><div style="height:60px;width:70px"></div><div style="height:60px;width:30px"></div></div>))
    end
    it 'keeps justify, reverse, auto margins, relative offsets, out-of-flow children and nesting on the native path' do
      expect_native_flex(%(<div style="#{col};height:200px;flex-direction:column-reverse"><div style="flex:1">a</div><div style="height:30px">b</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px;justify-content:center"><div style="height:30px">a</div><div style="height:30px">b</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="margin-top:auto;height:30px">pushed down</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1;position:relative;left:10px">rel</div><div style="height:30px">b</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1">a</div><div style="position:absolute;width:30px;height:30px"></div><div style="height:30px">b</div></div>))
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1;display:flex;flex-direction:column"><div style="flex:1">nested col</div><div>x</div></div><div>b</div></div>))
      expect_native_flex(%(<div style="display:flex;width:400px"><div style="flex:1;display:flex;flex-direction:column"><div style="flex:1">col in row</div><div>x</div></div><div style="width:50px;height:120px"></div></div>))
    end
    # A descendant declaring a % height / (for a column) % width or edge keeps the item on the pushed path: native
    # measures the item at a provisional size the records' resolved percentages don't know (review finding).
    it 'falls back for an item whose subtree declares a percentage size the measure would misread' do
      r = run_shadow(%(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div style="height:50%">pct</div></div><div style="flex:1 1 auto">plain</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
      r = run_shadow('<div style="display:flex;width:400px"><div><div style="height:150%">pct</div></div><div style="height:40px;width:50px"></div></div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
      r = run_shadow(%(<div style="#{col};flex-wrap:wrap"><div><div style="width:50%">some text words here to wrap</div></div><div>two</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
    end
    # Review findings: a base-measured item shrunk below its measure keeps its floor; a `wrap` column that never
    # breaks still shrinks its items to fit and places its line by align-content; a multi-line column stacks its
    # lines from their NATURAL crosses (a clamped stretch item does not shrink its line); a border-box container
    # is never shorter than its own edges.
    it 'floors a base-measured item at its measure when the line shrinks it' do
      expect_native_flex(%(<div style="#{col};height:50px"><div>a<br>b<br>c</div><div style="height:40px">b</div></div>))
      expect_native_flex(%(<div style="#{col};height:50px"><div style="flex-basis:content;height:70px">a<br>b<br>c</div></div>))
      expect_native_flex(%(<div style="#{col};height:50px"><div style="flex-shrink:1">a<br>b<br>c<br>d</div><div style="flex-shrink:1">a<br>b<br>c<br>d</div></div>))
      expect_native_flex(%(<div style="#{col};height:50px"><div style="flex:1 1 auto">a<br>b<br>c<br>d<br>e</div></div>))
    end
    it 'treats a wrap column as multi-line even when it never breaks (shrink-to-fit items, align-content placement)' do
      expect_native_flex(%(<div style="#{col};flex-wrap:wrap;align-content:center"><div>one</div><div>two</div></div>))
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap;align-content:center"><div>one</div></div>))
      expect_native_flex(%(<div style="#{col};flex-wrap:wrap;align-content:flex-end;min-height:100px"><div>one</div><div>two</div></div>))
    end
    it 'stacks a multi-line column\'s lines from their natural crosses and closes the last stretched line at the edge' do
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap;width:200px"><div style="height:60px;max-width:20px">text here</div><div style="height:60px">b</div><div style="height:60px">c</div></div>))
      expect_native_flex(%(<div style="#{col};height:100px;flex-wrap:wrap;width:200px"><div style="height:60px;width:20px"></div><div style="height:60px;width:20px"></div><div style="height:60px;width:20px"></div><div style="height:60px;width:20px"></div><div style="height:60px;width:20px"></div></div>))
    end
    it 'floors a flex-basis below a declared height at the item\'s content (the floor binds at the base, on any line)' do
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex-basis:20px;height:100px">a<br>b<br>c</div><div style="height:30px">b</div></div>))
      expect_native_flex(%(<div style="#{col}"><div style="flex-basis:20px;height:100px">a<br>b<br>c</div><div style="height:30px">b</div></div>))
      expect_native_flex(%(<div style="#{col};flex-wrap:wrap;height:70px"><div style="flex-basis:20px;height:100px">a<br>b<br>c</div><div style="height:30px">b</div></div>))
    end
    it 'falls back for a wrap column\'s stretching item whose subtree declares any percentage (measured at a provisional width)' do
      r = run_shadow(%(<div style="#{col};flex-wrap:wrap"><div><div style="padding-top:50%">x</div></div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
    end
    it 'floors a border-box flex container at its own border and padding' do
      expect_native_flex(%(<div style="#{col};box-sizing:border-box;height:5px;padding:10px"><div>x</div></div>))
      expect_native_flex('<div style="display:flex;width:400px;box-sizing:border-box;height:5px;padding:10px"><div>x</div></div>')
    end
  end

  # ── Native BASELINES ──────────────────────────────────────────────────────────────────────────────────
  # A baseline-aligned item hangs from its own first (or last) baseline, which native now reads from its
  # laid-out lines (`Box::first_baseline`, the oracle's boxBaselineOffset): a text block's line top + ascent,
  # a block / grid / flex container's from its first in-flow child that has one (flex items in flex order,
  # reversed for a *-reverse direction), a scrolling item's clamped into its box, and the bottom margin edge
  # where no line is there to give one. Items with a shape the line ascent does not reproduce (an atomic
  # inline, a vertical-align, a replaced element, a table) keep the pushed path.
  describe 'native baselines' do
    let(:base) { 'display:flex;align-items:baseline;width:400px' }

    it 'aligns text items of different sizes on their first line baselines' do
      expect_native_flex(%(<div style="#{base}"><div>small text</div><div style="font-size:32px">BIG</div><div style="font-size:12px">tiny</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="line-height:40px">tall line</div><div style="font-size:32px;line-height:1">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div>text <b style="font-size:28px">bold big</b> more</div><div>x</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="white-space:pre">pre\nsecond</div><div style="font-size:32px">BIG</div></div>))
    end
    it 'takes a block item\'s baseline from its first in-flow child with a line, skipping empty blocks' do
      expect_native_flex(%(<div style="#{base}"><div><p style="margin:0">first para</p><p style="margin:0;font-size:24px">second</p></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div><div style="height:20px"></div><p style="margin:0">after empty block</p></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="position:relative"><p style="margin:0">a</p><div style="position:absolute;font-size:40px">abs</div></div><div style="font-size:32px">BIG</div></div>))
    end
    it 'synthesises the bottom margin edge for an item with no line, and counts a <br>\'s empty line' do
      expect_native_flex(%(<div style="#{base}"><div style="height:40px;width:40px"></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div><div></div></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div><br>after br</div><div style="font-size:32px">BIG</div></div>))
    end
    it 'adds the item\'s top margin and edges, clamps a scrolling item\'s baseline into its box' do
      expect_native_flex(%(<div style="#{base}"><div style="padding:10px;border:2px solid;margin-top:7px">padded</div><div style="font-size:32px;margin-bottom:9px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="overflow:hidden;height:8px">clipped text</div><div style="font-size:32px">BIG</div></div>))
    end
    it 'aligns last baselines on the last line' do
      expect_native_flex('<div style="display:flex;align-items:last baseline;width:400px"><div>line one<br>line two<br>line three</div><div style="font-size:32px">BIG</div></div>')
      expect_native_flex(%(<div style="#{base}"><div>two lines of wrapping text in a narrow item here we go</div><div style="font-size:32px;width:250px">BIG</div></div>))
    end
    it 'reads a nested flex / grid container\'s baseline from its items in flex order, reversed for *-reverse' do
      expect_native_flex(%(<div style="#{base}"><div style="display:flex"><div style="font-size:24px">nested</div><div>row</div></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="display:flex;flex-direction:row-reverse"><div style="font-size:24px">a</div><div>b</div></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="display:flex;flex-direction:column"><div style="font-size:24px">col a</div><div>col b</div></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="display:flex;flex-direction:column-reverse"><div style="font-size:24px">col a</div><div>col b</div></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base};direction:rtl"><div><div style="font-size:24px">rtl a</div></div><div style="font-size:32px">BIG</div></div>))
    end
    # A grid ITEM is measurable now — a grid is measured as a block, which is what the oracle does with one —
    # so a grid baseline item takes the NATIVE path. One holding inline-level content still pushes: there the
    # oracle walks a pen the blockified records cannot reproduce.
    it 'keeps parity for a nested grid baseline item' do
      r = run_shadow(%(<div style="#{base}"><div style="display:grid;grid-template-columns:1fr 1fr"><div>g1</div><div style="font-size:24px">g2</div></div><div style="font-size:32px">BIG</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 1)
      r = run_shadow(%(<div style="#{base}"><div style="display:grid;grid-template-columns:1fr 1fr"><span>g1</span><span style="font-size:24px">g2</span></div><div style="font-size:32px">BIG</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
    end
    # Review findings, oracle side (native and Chrome agreed): a block holding both inline content and block
    # children reads whichever comes first / last DOWN THE FLOW; a `position: relative` child's offset moves the
    # box, not its baseline; a preserved newline's empty line is a line a baseline reads from; and the line's
    # baseline is the ascent the flow grew it to, not a second scan of what sits on it.
    it 'merges a block\'s own lines and its block children in flow order' do
      expect_native_flex('<div style="display:flex;align-items:last baseline;width:400px"><div>text<p style="margin:0">para</p></div><div style="font-size:32px">BIG</div></div>')
      expect_native_flex(%(<div style="#{base}"><div><p style="margin:0">para</p>text</div><div style="font-size:32px">BIG</div></div>))
    end
    it 'orders by flow, not by y: a negative margin does not make a later block come first' do
      expect_native_flex(%(<div style="#{base}"><div>text<p style="margin:-30px 0 0">para</p></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex('<div style="display:flex;align-items:last baseline;width:400px"><div><p style="margin:0 0 -30px">para</p>text</div><div style="font-size:32px">BIG</div></div>')
      expect_native_flex(%(<div style="#{base}"><div><p style="margin:0">para</p><p style="margin:-40px 0 0">up</p></div><div style="font-size:32px">BIG</div></div>))
    end
    it 'ignores a relative child\'s offset for the baseline' do
      expect_native_flex(%(<div style="#{base}"><div><p style="position:relative;top:10px;margin:0">a</p></div><div style="font-size:32px">BIG</div></div>))
    end
    it 'reads a baseline from the empty line a preserved newline leaves' do
      expect_native_flex(%(<div style="display:flex;align-items:last baseline;width:400px"><div style="white-space:pre">a\n\n</div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="white-space:pre">\n\na</div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="white-space:pre-line">\n\na</div><div style="font-size:32px">BIG</div></div>))
    end
    it 'takes the line\'s baseline from the ascent the flow used (an empty inline, an open edge, a <br> in a larger inline)' do
      expect_native_flex(%(<div style="#{base}"><div>a<span style="font-size:40px"></span>b</div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="width:120px">aaaa aaaa aaaa<span style="font-size:40px;padding-left:5px"> bbbbb</span></div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div><span style="font-size:40px"><br></span>text</div><div style="font-size:32px">BIG</div></div>))
      expect_native_flex('<div style="display:flex;align-items:last baseline;width:400px"><div>text<span style="font-size:40px"><br></span></div><div style="font-size:32px">BIG</div></div>')
    end
    it 'keeps wrapped and mixed-alignment rows native' do
      expect_native_flex(%(<div style="#{base};flex-wrap:wrap"><div style="width:300px">wrapped one</div><div style="font-size:32px;width:300px">BIG</div></div>))
      expect_native_flex(%(<div style="#{base}"><div style="align-self:flex-start;height:50px">start</div><div>base</div><div style="font-size:32px">BIG</div></div>))
    end
    it 'falls back for a baseline item holding a vertical-align or an atomic inline' do
      r = run_shadow(%(<div style="#{base}"><div>text <sup>sup</sup> more</div><div>x</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
      r = run_shadow(%(<div style="#{base}"><div>text <span style="display:inline-block;height:30px;width:10px"></span> more</div><div>x</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
    end
  end
  # Native sizing is a promise about every item at once, and the WALK decides whether it holds: where it declines
  # one item's subtree the whole set is rolled back and re-emitted with the oracle's boxes pushed. Each shape
  # here holds content the walk refuses for a reason `nlFlexNativeSizable`'s predicate does not model, and under
  # a predicate-decided gate each took the whole pass down.
  describe 'a flex container whose item the walk declines to size re-emits with pushed boxes' do
    WalkRefusals::ATOMIC.each_with_index do |inner, i|
      it "lays out a row and a column around refused content #{i}" do
        [
          %{<div style="display:flex;width:300px"><div>a #{inner}</div><div style="flex:1">x</div></div>},
          %{<div style="display:flex;flex-direction:column;width:300px;height:200px"><div>a #{inner}</div><div>x</div></div>}
        ].each do |body|
          r = run_shadow(body)
          expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
          expect(r['nativeFlexRows']).to eq(0), "the container should have pushed its item boxes: #{r.inspect}"
        end
      end
    end
    it 'still resolves the item sizes itself where every item allows it' do
      r = run_shadow('<div style="display:flex;width:300px"><div>a <span style="display:inline-block">ok</span></div><div style="flex:1">x</div></div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 1), r.inspect
    end
  end

  # A VERTICAL writing mode's flex container lays out along the axes `flexAxisPlan` already computes — a `row`
  # there runs down Y, which is the COLUMN routine on both sides — so it needed no new geometry, only the gate
  # to stop refusing it (it was left over from when native's flex axes were physical). It came off the frozen
  # corpus's decline list whole: 60 shapes, a quarter of what was left, all on that one line.
  #
  # What still declines there is the CROSS axis running backwards, which is the same rule a horizontal mode has
  # and not a vertical one of its own — and WHICH containers those are depends on the `direction` as much as on
  # the mode, so the table below is the statement of it rather than a sentence here.
  describe 'a vertical writing mode' do
    WRITING_MODES = %w[vertical-rl vertical-lr sideways-rl sideways-lr].freeze

    # WHICH WAY the cross axis runs, spelled OUT rather than recomputed: a spec that re-derives the rule
    # agrees with the implementation even when both are wrong. `+` runs from the near physical edge; `←` runs
    # back from the FAR one — an rtl COLUMN (cross = the inline axis), a `*-rl` mode's ROW (cross = a block
    # axis pointing left), a `sideways-lr` ROW (pointing up). Every one of them is placed natively; the table
    # is here because it is the input native mirrors within, and because which containers those are is a
    # question about the mode AND the direction together, never the mode alone.
    #
    #                         row  row-rev  column  column-rev
    VERTICAL_CROSS = {
      %w[vertical-rl ltr] => %w[←   ←        +       +],
      %w[vertical-rl rtl] => %w[←   ←        ←       ←],
      %w[vertical-lr ltr] => %w[+   +        +       +],
      %w[vertical-lr rtl] => %w[+   +        ←       ←],
      %w[sideways-rl ltr] => %w[←   ←        +       +],
      %w[sideways-rl rtl] => %w[←   ←        ←       ←],
      %w[sideways-lr ltr] => %w[+   +        ←       ←],
      %w[sideways-lr rtl] => %w[+   +        +       +]
    }.freeze
    FLEX_DIRECTIONS = %w[row row-reverse column column-reverse].freeze

    it 'places a row and a column in every vertical mode, whichever way the cross axis runs' do
      VERTICAL_CROSS.each do |(wm, dir), cells|
        FLEX_DIRECTIONS.each_with_index do |fd, i|
          %w[nowrap wrap wrap-reverse].each do |wrap|
            expect_parity(%(<div style="writing-mode:#{wm};direction:#{dir};display:flex;flex-direction:#{fd};flex-wrap:#{wrap};width:200px;height:150px"><div style="width:30px;height:20px"></div><div style="width:40px;height:50px"></div></div>))
          end
        end
      end
    end

    # …and the table is a GEOMETRY claim, not a description of a gate: `align-items: flex-start` follows the
    # cross AXIS, so it puts a lone item at the far physical edge exactly where the table says `←`. Reading it
    # off the laid-out page is what keeps the table honest — the parity example above passes whether or not
    # either engine has the direction right.
    it 'starts the cross axis at the edge the table names' do
      VERTICAL_CROSS.each do |(wm, dir), cells|
        FLEX_DIRECTIONS.each_with_index do |fd, i|
          body = %(<div style="writing-mode:#{wm};direction:#{dir};display:flex;flex-direction:#{fd};align-items:flex-start;width:200px;height:150px"><div style="width:30px;height:20px"></div></div>)
          x, y, = first_item_box(body)
          # Every mode here is VERTICAL, so a row lays out along Y and its cross is X; a column the other way.
          at, far_edge = fd.start_with?('column') ? [y, 130] : [x, 170]
          expect(at).to eq(cells[i] == '←' ? far_edge : 0), "#{wm} #{dir} #{fd} (#{cells[i]}): #{[x, y].inspect}"
        end
      end
    end

    # `wrap-reverse` turns the cross axis round on top of whatever the flow already did, which is why the two
    # cannot be one flag: a `vertical-rl` ROW's cross runs backwards with no wrap keyword in sight, and
    # `wrap-reverse` there makes it FORWARD. Measured in Chrome over the whole table above: every cell
    # inverts. What follows the WRAP REVERSAL rather than the physical direction is the flow-relative
    # `start` / `end` pair, which the align-content example below is the statement of.
    it 'takes wrap-reverse and the flow apart' do
      shell = '<div style="writing-mode:vertical-rl;display:flex;align-items:flex-start;width:200px;height:150px'
      expect(first_item_box(%(#{shell}"><div style="width:30px;height:20px"></div></div>))[0]).to eq(170)
      expect(first_item_box(%(#{shell};flex-wrap:wrap-reverse"><div style="width:30px;height:20px"></div></div>))[0]).to eq(0)
    end

    # …and an OUT-OF-FLOW child, whose static position is measured ALONG the cross axis rather than flipped
    # onto it by `crossAlignPhysical` — so it is the one thing that needs the axis's physical direction as its
    # own input. Native read it off `direction` alone, which is right only while every vertical container is
    # declined: a `vertical-rl` row's cross runs right→left with no `rtl` in sight, and the box landed the
    # whole cross free space away (x=0 against the oracle's 170). Nothing refused it.
    it 'places an out-of-flow child against the cross axis it actually has' do
      VERTICAL_CROSS.each do |(wm, dir), cells|
        ['', 'align-self:center', 'align-self:flex-end'].each do |a|
          FLEX_DIRECTIONS.each_with_index do |fd, i|
            next if cells[i] == '-'

            expect_parity(%(<div style="writing-mode:#{wm};direction:#{dir};display:flex;flex-direction:#{fd};position:relative;width:200px;height:150px"><div style="position:absolute;#{a};width:30px;height:20px"></div><div style="width:10px;height:10px"></div></div>))
          end
        end
      end
    end

    # A cross-axis auto margin is PHYSICAL on both sides — it splits the room left inside the item's own line,
    # which has no direction — so what the walk owes native is the physical near/far pair and not the axis's.
    # Naming the axis-start side made `margin-left: auto` on a right-to-left cross read as the trailing one.
    it 'splits a cross auto margin on the physical sides, whichever way the axis runs' do
      VERTICAL_CROSS.each do |(wm, dir), cells|
        FLEX_DIRECTIONS.each_with_index do |fd, i|
          shell = %(<div style="writing-mode:#{wm};direction:#{dir};display:flex;flex-direction:#{fd};width:200px;height:150px">)
          ['margin-left:auto', 'margin-right:auto', 'margin-top:auto', 'margin-bottom:auto', 'margin:auto'].each do |m|
            expect_parity(%(#{shell}<div style="#{m};width:30px;height:20px"></div></div>))
          end
        end
      end
    end

    it 'distributes and aligns in a vertical mode' do
      WRITING_MODES.each do |wm|
        %w[flex-start center space-between space-around flex-end].each do |j|
          expect_parity(%(<div style="writing-mode:#{wm};display:flex;justify-content:#{j};gap:8px;width:200px;height:150px"><div style="width:80px;height:20px"></div><div style="width:80px;height:20px"></div></div>))
        end
        %w[flex-start center stretch flex-end].each do |a|
          expect_parity(%(<div style="writing-mode:#{wm};display:flex;align-items:#{a};width:200px;height:150px"><div style="width:30px;height:20px"></div><div>ab</div></div>))
        end
      end
    end

    # …and the ONE thing that did need a rule. A baseline has geometry only where the cross axis is the block
    # axis its glyphs sit on. A vertical ROW keeps the keyword (`plan.baselineMode` is `keep` — its items do
    # sit side by side along the inline axis) and then lays out along Y, where the oracle's own column routine
    # ignores it: `crossOffset` answers 0, and a line's cross size is its WIDEST item's margin box (where it
    # wraps at all — a nowrap column's one line is the container's content box) rather than a shared
    # baseline's extent. The walk
    # sends native `flex-start` for exactly that case. Without it native did real baseline placement AND real
    # baseline line-sizing, and NOTHING declined: 400 of a 12000-case sweep, then 96 more of an 8000-case one
    # that varied `align-self` rather than `align-items` — the corpus held neither shape.
    it 'gives a vertical row no baseline geometry, as the oracle does' do
      ['baseline', 'first baseline', 'last baseline'].each do |a|
        WRITING_MODES.each do |wm|
          expect_parity(%(<div style="writing-mode:#{wm};display:flex;align-items:#{a};width:200px;height:150px"><div style="font-size:24px">Ag</div><div>x</div></div>))
          expect_parity(%(<div style="writing-mode:#{wm};display:flex;width:200px;height:150px"><div style="align-self:#{a}"><div style="height:30px">a</div><div>b</div></div><div style="align-self:#{a}">y</div></div>))
          expect_parity(%(<div style="writing-mode:#{wm};display:flex;flex-direction:row-reverse;width:150px;height:150px"><div style="align-self:#{a};width:30px;height:20px"></div><div style="align-self:#{a};width:20px;height:40px"></div></div>))
        end
        # …while a HORIZONTAL row still aligns on real baselines, which is the half of the rule that has one.
        expect_parity(%(<div style="display:flex;align-items:#{a};width:200px"><div style="font-size:24px">Ag</div><div>x</div></div>))
      end
    end

    # `align-content` is the other reader of the reversed cross, and its three steps each see a different
    # keyword: a DISTRIBUTION with no free space falls back to its own alignment first (`space-between` to
    # `flex-start`, which follows the axis; `space-around` / `-evenly` to safe centre, which is flow `start`
    # and does not), the flow-relative pair resolves onto the axis second, and only the result is mirrored.
    it 'stacks lines by align-content in every vertical mode, overflowing or not' do
      %w[flex-start flex-end start end center space-between space-around space-evenly stretch].each do |ac|
        WRITING_MODES.each do |wm|
          %w[ltr rtl].each do |dir|
            %w[wrap wrap-reverse].each do |wrap|
              shell = %(<div style="writing-mode:#{wm};direction:#{dir};display:flex;flex-wrap:#{wrap};align-content:#{ac};width:100px;height:90px">)
              expect_parity(%(#{shell}<div style="width:60px;height:20px"></div><div style="width:60px;height:20px"></div><div style="width:60px;height:20px"></div></div>))
              # …and the same lines OVERFLOWING their container, which is where the two fallbacks part
              expect_parity(%(#{shell}<div style="width:60px;height:40px"></div><div style="width:60px;height:40px"></div><div style="width:60px;height:40px"></div></div>))
            end
          end
        end
      end
    end
  end

  # Whether a flex container's height is its CONTENT's (rec[54]) needs saying only where a parent PUSHES the
  # container's final box over its declared height; everywhere else the declaration says it, and native clears it
  # where it imposes one. It used to be read off the oracle's box (`autoHeight`) for every flex container on the
  # page: without that figure a vertical-mode container with a DECLARED height recomputed its cross from its
  # content (4800 of the vflex sweep's shapes).
  describe 'the auto-height flag' do
    def no_oracle(body)
      with_simulated_session(page(body)) do |session|
        session.visit '/'
        session.evaluate_script('document.body.offsetHeight')
        session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      end
    end

    it 'is not read off the oracle box where nothing was pushed' do
      items = '<div style="width:30px;height:20px"></div><div style="width:40px;height:50px"></div>'
      [
        %(<div style="writing-mode:vertical-rl;display:flex;align-items:flex-end;width:60px;height:60px;align-content:center">#{items}</div>),
        %(<div style="display:flex;flex-wrap:wrap;align-content:space-between;width:60px;height:120px">#{items}</div>),
        %(<div style="display:flex;min-height:90px;align-items:center">#{items}</div>),
        %(<div style="display:flex;height:40px"><div style="display:flex;align-items:flex-end">#{items}</div></div>)
      ].each do |body|
        expect_parity(body)
        r = no_oracle(body)
        expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
        # (a min/max-height container still asks the oracle whether a clamp binds an imposed box — a decline
        # guard of its own, not this flag)
        next if body.include?('min-height')

        expect(r['oracleReads'].keys).not_to include('walkRecord _lb.autoHeight'), body
      end
    end
  end

  # A percentage FLEX-BASIS (and `flex: 1`, whose basis is 0%) and percentage GAPS go to native unresolved and are
  # resolved against the sizes it lays the container out at: a row's content width, a column's definite main size
  # or its min-height floor, the definite content height across a row. The walk resolved them against the ORACLE's
  # box — without it a wrapping column of `flex: 1` items lost its basis (1280 of the colwrap sweep's shapes).
  describe 'percentage bases and gaps' do
    def no_oracle(body)
      with_simulated_session(page(body)) do |session|
        session.visit '/'
        session.evaluate_script('document.body.offsetHeight')
        session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      end
    end

    it 'resolves them against native\'s own sizes' do
      items = '<div style="flex:1;width:40px;height:30px">a</div><div style="flex-basis:30%;width:60px;height:20px"></div><div style="width:50px;height:25px"></div>'
      ['flex-direction:column;flex-wrap:wrap;height:60px;width:200px', 'flex-direction:column;min-height:90px;gap:10%;width:200px',
       'flex-direction:row;gap:5px 12%;width:300px;height:120px', 'flex-direction:row;flex-wrap:wrap;row-gap:15%;width:120px;height:200px;max-height:100px',
       'flex-direction:column;row-gap:20%;width:200px'].each do |container|
        body = %(<div style="display:flex;#{container}">#{items}</div>)
        expect_parity(body)
        r = no_oracle(body)
        expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
        # (an item's own EDGES still resolve against the oracle's width, `contentW` — a dependency of their own)
        expect(r['oracleReads'].keys.grep(/\AcolMain /)).to eq([]), "#{body}: #{r['oracleReads'].keys.inspect}"
      end
    end
    # …where a parent PUSHES the container's final box over its record, that height was not necessarily definite
    # when the percentages resolved (an auto-height out-of-flow box replayed from the oracle: its row gap is nothing
    # and a percentage basis auto there), so the push says which; and a basis that is a percentage only after
    # `inherit` resolves is still one.
    # A container whose own padding is a percentage NATIVE resolves still hands a `calc()` basis the oracle's figures
    # (its main size off the oracle's box, less that padding) — so the padding subtracted there has to be the one the
    # oracle resolved, not the length part the record carries.
    it 'resolves a calc() basis against the container as the oracle padded it' do
      expect_parity('<div style="width:400px;height:300px"><div style="display:flex;flex-direction:column;padding:5% 0;height:50%"><div style="flex-basis:calc(20% + 5px)">a</div></div></div>')
    end
    it 'keeps a pushed auto height indefinite, and a percentage inherited' do
      two = '<div style="width:300px;height:20px"></div><div style="width:300px;height:20px"></div>'
      expect_parity(%(<div style="position:relative;padding:5%;width:400px;height:400px"><div style="position:absolute;display:flex;flex-wrap:wrap;row-gap:20%;width:300px">#{two}</div></div>))
      expect_parity(%(<div style="position:relative;padding:5%;width:400px;height:400px"><div style="position:absolute;display:flex;flex-direction:column;width:300px"><div style="flex-basis:50%;height:20px"></div><div style="height:20px"></div></div></div>))
      expect_parity('<div style="display:flex;width:400px;flex-basis:50%"><div style="flex-basis:inherit;flex-grow:0">x</div><div>y</div></div>')
      # …while a percentage inside a math function is not a fraction of the main size (500 would be; this is 300)
      expect_parity('<div style="display:flex;width:1000px"><div style="flex-basis:min(50%, 300px);flex-shrink:0">x</div><div>y</div></div>')
    end
  end
end
