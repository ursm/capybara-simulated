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
# What still DECLINES to JS is what `nlFlexSupported` (layout.js) refuses.
# A REPLACED item (svg / img / input …) is now replayed as a leaf box (see native_layout_replaced_spec).
# Each bail is an A/B: the feature-carrying input declines, a sibling without it stays native. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'
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
  def run_shadow(body, opts = '{}')
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      session.evaluate_script("globalThis.__csimLayoutShadowRun(undefined, #{opts})")
    end
  end

  # A child that generates NO BOX is no flex ITEM: a `<link>` or `<meta>` written in the body is
  # `display: none` from the UA STYLESHEET, which is neither an author rule (so the hide cascade never saw it)
  # nor one of the tags the visibility walk knows by name. The oracle laid one out as an item — the item after
  # it moved 100px — and `visible?` said true of it. The UA's own display is part of the hide cascade now, so
  # `boxlessChild` is the one question every child list asks. Chrome figures; native was already right.
  it 'makes no flex item of a child that generates no box' do
    [
      ['<link rel="stylesheet">',                              7.109375],
      ['<meta name="x">',                                      7.109375],
      # …and the ones that already worked, kept as the controls that say WHICH half was missing: `<style>` is a
      # tag the visibility walk knows, and the other two are author rules the hide cascade always resolved.
      ['<style>.q{}</style>',                                  7.109375],
      ['<div hidden style="width:40px;height:40px"></div>',    7.109375],
      ['<div style="display:none;width:40px"></div>',          7.109375]
    ].each do |boxless, chrome_x|
      body = %(<div style="width:300px"><div style="display:flex"><div>a</div>#{boxless}<div id="g">b</div></div></div>)
      with_simulated_session(page(body)) do |session|
        session.visit '/'
        session.evaluate_script('document.body.offsetHeight')
        expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0), body
        x = session.evaluate_script("document.getElementById('g').getBoundingClientRect().x")
        expect(x).to be_within(0.01).of(chrome_x), "#{body}: #{x}, Chrome #{chrome_x}"
      end
    end
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect_no_dropped_records(r, body)
  end

  # Parity, AND the row's item widths were resolved by the native engine (`flex_row_sizes`), not pushed —
  # `nativeFlexRows` counts the flex rows that took that path.
  # A wrap COLUMN whose stretching item holds `mid` (the block whose used width is the percentage's basis)
  # holding `pct`. The second item is a fixed box, which is what makes the container's pushed path
  # unrecoverable — so where the pre-filter refuses, the whole walk declines and names itself.
  def wrap_col_pct(mid, pct)
    %(<div style="display:flex;flex-direction:column;width:300px;flex-wrap:wrap"><div><div style="#{mid}">) +
      %(<div style="#{pct}">some rather longer words here to measure</div></div></div>) +
      %(<div style="width:30px;height:20px"></div></div>)
  end

  def expect_native_flex(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect_no_dropped_records(r, body)
    expect(r['nativeFlexRows']).to be >= 1, "the row's item widths were pushed, not native: #{r.inspect}"
  end

  # …and a marked descendant's X, for an example whose figure is a position rather than a size.
  def marked_box_x(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script("document.getElementById('m').getBoundingClientRect().x")
    end
  end

  # …and one MARKED descendant's, for an example whose figure is inside an item rather than the item itself.
  def marked_box(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script("(function () { var r = document.getElementById('m').getBoundingClientRect();
                                 return [r.width, r.height]; })()")
    end
  end

  # Every item's box relative to its container, for an example that has to say WHERE the boxes landed and
  # not only that the two engines agree about it. The container is the body's first element, or the one marked
  # `id="c"` where that is nested.
  def item_boxes(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script(<<~JS)
        (function () {
          var c = document.getElementById('c') || document.body.firstElementChild, o = c.getBoundingClientRect();
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

  # SHARED with Chrome: both engines align an AUTO-height row's items in its CONTENT cross and let the min-height
  # grow the box around them; Chrome clamps the container's cross size first (css-flexbox §9.4 step 15) and
  # centres them in the 100 (35 and 25, where both engines say 10 and 0).
  it 'matches a row whose min-height grows the cross the items align in (the app-shell min-height)' do
    body = '<div style="display:flex;align-items:center;min-height:100px;width:400px"><div style="width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div>'
    expect_parity(body)
    a, b = item_boxes(body)
    expect_shared_gap(a[1], shared: 10, chrome: 35, what: "#{body}: the first item's y")
    expect_shared_gap(b[1], shared: 0, chrome: 25, what: "#{body}: the second item's y")
  end

  # A DEFINITE height is clamped before the content is laid out in it — and the oracle handed a column item back its
  # AUTO layout whenever the imposed number equalled it, including one its own max-height had just CUT to that
  # number: its lines stayed aligned in the 55 they came to (y 35 and 0 against Chrome's 25 and -10), and the walk
  # declined every such container rather than read the oracle's box to find out (`rv8g3`, 234 declines).
  it 'lays a clamped column item out again at the height it was cut to' do
    body = '<div style="display:flex;flex-direction:column;height:120px"><div id="c" style="display:flex;flex-wrap:wrap-reverse;width:70px;max-height:45px">' \
           '<div style="width:30px;height:20px"></div><div style="width:45px;height:35px"></div></div></div>'
    expect_parity(body)
    expect(item_boxes(body)).to eq([[0, 25, 30, 20], [0, -10, 45, 35]])   # Chrome
  end
  # …and a percentage height inside an item a min-height floored resolves against the floor (Chrome 45), in both
  # engines: native imposes the height there too rather than laying the item out at auto again.
  it 'resolves a percentage height against the floor a column item\'s min-height raised it to' do
    body = '<div style="display:flex;flex-direction:column;width:300px;height:150px"><div style="min-height:60%">' \
           '<div id="m" style="height:50%;width:50%">nested</div></div><div style="height:20px"></div></div>'
    expect_parity(body)
    expect(marked_box(body)).to eq([150, 45])   # Chrome
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
  # A box the FLOW made definite (a stretch) whose clamp BINDS: the stretched size is clamped FIRST and the items
  # are aligned in what is left (css-flexbox §9.4 step 11). These used to DECLINE — the oracle aligned them in the
  # pre-clamp stretch and cut the box around them afterwards (50 and 10), which native, holding only the clamped
  # box, could not reproduce; it now clamps before it lays the content out, and both engines give Chrome's figure.
  it 'aligns the items of a cross-stretched flex row in the stretch its max-height clamped' do
    body = '<div style="display:flex;height:120px;align-items:stretch;width:400px"><div id="c" style="display:flex;max-height:80px;align-items:center">' \
           '<div style="width:50px;height:20px"></div></div></div>'
    expect_parity(body)
    expect(first_item_box(body)).to eq([0, 30, 50, 20])   # Chrome
  end
  it 'aligns the items of a cross-stretched flex row in the stretch its min-height floored' do
    body = '<div style="display:flex;height:40px;align-items:stretch;width:400px"><div id="c" style="display:flex;min-height:120px;align-items:center">' \
           '<div style="width:50px;height:20px"></div></div></div>'
    expect_parity(body)
    expect(first_item_box(body)).to eq([0, 50, 50, 20])   # Chrome
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

  # …and the static corner it aligns in is the one the placement is HANDED, not the content box read when the
  # container was laid out: an inline-flex is dropped onto its line's baseline after that, and the box inside it
  # goes down with it (Chrome: y 34, where the captured origin left it at the container's pre-drop 20).
  it 'aligns an absolute flex child in the corner the container ended up at' do
    body = '<div style="position:relative;margin:20px 0 15px"><span style="display:inline-flex"><div id="t" style="position:absolute;width:10px;height:10px"></div></span></div>'
    expect_parity(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      expect(session.evaluate_script("(b => [b.x, b.y])(document.getElementById('t').getBoundingClientRect())")).to eq([0, 34])
    end
  end

  # An item that ends up LARGER than the main size it was assigned — a table, which is never smaller than its own
  # content — is what the line distributes around: the free space `justify-content` shares, the far edge a
  # reversed axis measures from, and where its neighbours start (Chrome: the table at 53.57 in a centred 300px
  # row, and at y 146 in a 200px `column-reverse`).
  it 'distributes a flex line around an item that grew past its main size' do
    [
      ['<div style="display:flex;justify-content:center;width:300px"><table id="t" style="flex:0 0 60px;min-width:0;border-spacing:2px"><caption style="white-space:nowrap">caption text that is wide</caption><tr><td>x</td></tr></table><div style="width:40px;height:20px">y</div></div>', 'x', 53.57],
      ['<div style="display:flex;flex-direction:column-reverse;width:300px;height:200px"><table id="t" style="flex:0 0 10px;min-height:0;border-spacing:2px"><caption>cap</caption><tr><td style="height:30px">x</td></tr></table><div style="width:40px;height:20px">y</div></div>', 'y', 146]
    ].each do |body, axis, at|
      expect_parity(body)
      with_simulated_session(page(body)) do |session|
        session.visit '/'
        expect(session.evaluate_script("document.getElementById('t').getBoundingClientRect().#{axis}")).to be_within(0.02).of(at), body
      end
    end
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
  # An abspos flex container is SELF-SIZED, and its binding min-height is the auto-height case: both engines align
  # its items in the CONTENT cross and grow the box around them (0), where Chrome clamps first and centres them in
  # the 80 (25) — the same shared gap as an in-flow auto-height row. (It used to decline, when the walk read the
  # oracle's box to tell a binding clamp from one that did not bind.)
  it 'aligns an abspos flex row whose min-height binds as an auto-height row (shared)' do
    body = '<div style="position:relative;width:300px;height:200px"><div id="c" style="position:absolute;top:0;left:0;display:flex;align-items:center;min-height:80px">' \
           '<div style="width:40px;height:30px"></div></div></div>'
    expect_parity(body)
    expect_shared_gap(first_item_box(body)[1], shared: 0, chrome: 25, what: "#{body}: the item's y")
  end
  # …but BETWEEN two insets its height is definite — the span — and the clamp comes before anything is laid out in it
  # or an auto margin splits what it leaves (CSS 2.1 §10.6.4 / §10.7). The oracle aligned the items in the unclamped
  # span and cut the box afterwards (85 and 10, where native and Chrome say 25 and 50), and gave an auto margin
  # nothing to take (0 where native and Chrome say 60).
  it 'aligns an abspos flex row between two insets in the height its max-height clamped' do
    body = '<div style="position:relative;width:300px;height:200px"><div id="c" style="position:absolute;top:0;bottom:0;left:0;display:flex;align-items:center;max-height:80px">' \
           '<div style="width:40px;height:30px"></div></div></div>'
    expect_parity(body)
    expect(first_item_box(body)).to eq([0, 25, 40, 30])   # Chrome
  end
  it 'aligns an abspos flex row between two insets in the height its min-height floored' do
    body = '<div style="position:relative;width:300px;height:40px"><div id="c" style="position:absolute;top:0;bottom:0;left:0;display:flex;align-items:flex-end;min-height:80px">' \
           '<div style="width:40px;height:30px"></div></div></div>'
    expect_parity(body)
    expect(first_item_box(body)).to eq([0, 50, 40, 30])   # Chrome
  end
  it 'centres an abspos box between two insets by auto margins around the height its max-height clamped' do
    body = '<div id="c" style="position:relative;width:300px;height:200px"><div style="position:absolute;top:0;bottom:0;left:0;width:50px;max-height:80px;margin:auto 0"></div></div>'
    expect_parity(body)
    expect(first_item_box(body)).to eq([0, 60, 50, 80])   # Chrome
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
  # A PUSHED multi-line container whose lines mix a stretching item and a fixed one: `align-content: stretch` grew
  # each line from its NATURAL cross, and a stretched box already holds its share, so the lines cannot be rebuilt
  # from the final boxes — the walk refused the pushed path for it (`flex-item-pushed-cross-unrecoverable`, 1,363
  # sweep declines). Each pushed item carries its line's natural cross now (rec[128]). (The HALF-EMPTY inline-table in
  # the item — `WalkRefusals::UNMEASURABLE`'s shape, content the measure refuses — is what keeps the container off
  # native sizing, onto the pushed path: a plain percentage inside an inline box did until the walk learned to send it,
  # a two-operand `min()` until native learned to clamp one, a three-operand one until a comparison became a program,
  # and one inside a `calc()` until a sum of them did, all 2026-09-26.) Chrome's boxes.
  it 'places a pushed wrap container whose lines mix stretching and fixed items' do
    body = '<div style="display:flex;flex-wrap:wrap;width:150px;height:100px;font:16px monospace"><div><div style="height:100%">some rather longer ' \
           'words <b>bold <table style="display:inline-table"><colgroup><col style="width:20px"></colgroup></table> tail</b> more</div></div>' \
           '<div style="width:30px;height:20px"></div></div>'
    expect(run_shadow(body)).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
    chrome = [[0, 0, 150, 88], [0, 88, 30, 20]]
    item_boxes(body).zip(chrome).each do |got, want|
      got.zip(want).each {|g, w| expect(g).to be_within(0.05).of(w) }
    end
  end
  # …and it carries its line's INDEX too (rec[129]): the pushed boxes are the FINAL sizes, and a column whose
  # max-height breaks its lines breaks them on the HYPOTHETICAL ones — here a half-empty inline-table in the first item
  # is what pushes the container (an absolute box's percentage did until native placed those itself, a two-operand
  # `max()` until native clamped one, and a three-operand one and one inside a `calc()` until native evaluated
  # programs), and the lines are [a b] [c]. Chrome's boxes.
  it 'breaks a pushed wrapping column into the lines the oracle broke it into' do
    body = '<div style="display:flex;flex-direction:column;flex-wrap:wrap;max-height:50px;width:200px"><div style="width:20px;height:20px">' \
           '<table style="display:inline-table"><colgroup><col style="width:20px"></colgroup></table></div><div style="width:20px;height:20px"></div><div style="width:20px;height:20px"></div></div>'
    expect(run_shadow(body)).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
    expect(item_boxes(body)).to eq([[0, 0, 20, 20], [0, 20, 20, 20], [100, 0, 20, 20]])
  end
  # A WRAPPING auto-height column with a max-height breaks its lines against that capacity, and each line's main
  # extent is its OWN — the cap where its items overrun it, else its content — with the box the TALLEST line: 30
  # here, where one extent for every line made native's box the capacity (40). It declined until 2026-09-24.
  it 'places a wrapping auto-height column whose max-height breaks its lines, the box its tallest line' do
    body = '<div style="display:flex;flex-direction:column;flex-wrap:wrap;max-height:40px;width:300px"><div style="width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>'
    expect_native_flex(body)
    expect(item_boxes(body)).to eq([[0, 0, 80, 30], [150, 0, 80, 30]])   # Chrome
    body = '<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:100px;max-height:50px"><div style="width:20px;height:20px"></div><div style="width:20px;height:20px"></div><div style="width:20px;height:20px"></div></div>'
    expect_native_flex(body)
    expect(item_boxes(body)).to eq([[0, 0, 20, 20], [0, 20, 20, 20], [50, 0, 20, 20]])   # Chrome: two lines of 40 and 20, the box 40
  end
  # …and so is one whose auto height reaches it as a PUSHED flex item's (the sibling's percentage-height absolute
  # box keeps the row off native sizing, so the column's record carries the oracle's FINAL height and
  # `item_auto_height` says it was auto) — native read that height as declared and gave every line one extent
  # until a review found it (867 of 2,000 of its shapes).
  # SHARED with Chrome's rule, not only this shape: Chrome justifies EVERY line within the box (the tallest line,
  # 40), so the short line's third item sits at 20, where both engines justify it within its own 20 and leave it at 0.
  it 'justifies the lines of a wrapping max-height column that is itself a pushed flex item' do
    body = '<div style="display:flex;align-items:flex-start;width:300px"><div id="c" style="display:flex;flex-direction:column;flex-wrap:wrap;' \
           'max-height:50px;width:200px;justify-content:flex-end"><div style="width:20px;height:20px"></div><div style="width:20px;height:20px"></div>' \
           '<div style="width:20px;height:20px"></div></div><div style="width:10px;height:10px"><div style="position:absolute;height:10%;width:2px"></div></div></div>'
    expect_native_flex(body)
    a, b, c = item_boxes(body)
    expect([a, b]).to eq([[0, 0, 20, 20], [0, 20, 20, 20]])   # Chrome
    expect(c.values_at(0, 2, 3)).to eq([100, 20, 20])
    expect_shared_gap(c[1], shared: 0, chrome: 20, what: "#{body}: c's y")
  end
  # …and so is one the oracle laid out with no DEFINITE height at all — a wrapping column inside a definite-height
  # column, pushed (its items' `min()` widths keep it off native sizing): the record carries its final box, which
  # native took for a declared height every line justified within (the third item at 10, the oracle 0). Only a
  # definite content height is one extent for every line. SHARED with Chrome's justify-in-the-box, which says 10.
  it 'justifies each line of a pushed wrapping column with no definite height on its own' do
    item = '<div style="width:30px;height:20px"><div style="width:min(50%,10px);height:2px"></div></div>'
    body = '<div style="display:flex;flex-direction:column;height:120px"><div id="c" style="display:flex;flex-direction:column;flex-wrap:wrap;' \
           "width:70px;max-height:45px;justify-content:center\">#{item * 3}</div></div>"
    expect(run_shadow(body)).to include('ok' => true, 'mismatches' => 0)
    a, b, c = item_boxes(body)
    expect([a, b]).to eq([[0, 0, 30, 20], [0, 20, 30, 20]])   # Chrome
    expect_shared_gap(c[1], shared: 0, chrome: 10, what: "#{body}: the third item's y")
  end
  # A min-height ABOVE the max-height wins (CSS 2 §10.7): the column has room for all three, one line of 60.
  it 'lets a min-height above the max-height set the capacity a wrapping column breaks against' do
    body = '<div style="display:flex;flex-direction:column;flex-wrap:wrap;max-height:30px;min-height:60px;width:200px"><div style="width:20px;height:20px"></div>' \
           '<div style="width:20px;height:20px"></div><div style="width:20px;height:20px"></div></div>'
    expect_native_flex(body)
    expect(item_boxes(body)).to eq([[0, 0, 20, 20], [0, 20, 20, 20], [0, 40, 20, 20]])   # Chrome
    body = '<div style="display:flex;flex-direction:column;flex-wrap:wrap;max-height:30px;min-height:60px;width:200px;justify-content:flex-end">' \
           '<div style="width:20px;height:20px"></div><div style="width:20px;height:20px"></div></div>'
    expect_native_flex(body)
    expect(item_boxes(body)).to eq([[0, 20, 20, 20], [0, 40, 20, 20]])   # Chrome
  end
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
  # The CONTAINER being floated is a different question from an ITEM being floated, and it declined until the
  # gate refusing it was found to have no reason (see the grid spec's twin). Its auto width is §10.3.5
  # shrink-to-fit; what has to be right beside it is the BAND, which only a box on the line beside the float
  # and a block after it can show.
  it 'lays out a floated flex container natively' do
    expect_parity('<div style="width:400px"><div style="float:left;display:flex"><div style="width:35px;height:12px"></div><div style="width:25px;height:20px"></div></div>text beside it <span style="display:inline-block;width:3px;height:3px"></span></div>')
    expect_parity('<div style="width:400px"><div style="float:right;display:flex;flex-direction:column">some floated container text</div><div style="height:9px"></div></div>')
    expect_parity('<div style="width:400px"><div style="float:left;display:inline-flex;flex-wrap:wrap;max-width:60px"><div style="width:35px;height:12px"></div><div style="width:35px;height:12px"></div></div><div style="clear:both;height:9px"></div></div>')
  end
  it('matches a floated flex item (float ignored — laid out as an ordinary item)') { expect_parity('<div style="display:flex;width:400px"><div style="float:left;width:80px;height:30px"></div><div style="width:80px;height:40px"></div></div>') }
  it('matches a floated flex item with align-items:center (float ignored)') { expect_parity('<div style="display:flex;align-items:center;width:400px;height:100px"><div style="float:left;width:80px;height:30px"></div><div style="width:80px;height:50px"></div></div>') }
  it('matches a floated flex item with flex-grow (float ignored, grows to fill)') { expect_parity('<div style="display:flex;width:400px"><div style="float:left;flex:1;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('matches a nested wrap-reverse flex item') { expect_parity('<div style="display:flex;width:400px"><div style="display:flex;flex-wrap:wrap-reverse;width:80px;height:30px"></div><div style="width:80px;height:30px"></div></div>') }
  it('matches a flex container with min-height AND percentage vertical padding') { expect_parity('<div style="width:400px"><div style="display:flex;flex-direction:column;min-height:100px;padding-top:10%;width:100px"><div style="width:80px;height:30px"></div></div></div>') }
  it 'lays out a cross-stretched column its max-height clamped, against the clamped room' do
    body = '<div style="display:flex;height:300px;width:400px"><div id="c" style="display:flex;flex-direction:column;max-height:100px;row-gap:20%;width:100px">' \
           '<div style="height:20px"></div><div style="height:30px"></div></div></div>'
    expect_parity(body)
    expect(item_boxes(body)).to eq([[0, 0, 100, 20], [0, 40, 100, 30]])   # Chrome
  end
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
    # A descendant declaring a percentage kept the item on the pushed path until 2026-09-19: the records carried
    # those percentages resolved against the item's FINAL size, where native measures it at a provisional one.
    # Native resolves them itself now (`with_percent_sizes`, against the box it is laying the child out in,
    # afresh on every measure), so the item is sized natively — measured over a 2,548-shape sweep on the gate's
    # own axes (declines 516 -> 468, and the `pctsize` sweep's oracle reads 73 -> none).
    it 'sizes an item whose subtree declares a plain percentage natively' do
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div style="height:50%">pct</div></div><div style="flex:1 1 auto">plain</div></div>))
      expect_native_flex('<div style="display:flex;width:400px"><div><div style="height:150%">pct</div></div><div style="height:40px;width:50px"></div></div>')
      expect_native_flex(%(<div style="display:flex;width:400px"><div><div style="padding:0 10%">pct</div></div><div style="width:30px"></div></div>))
      expect_native_flex(%(<div style="#{col};width:400px"><div><div style="width:50%;min-height:20%">pct</div></div></div>))
      # …and one inside a LINEAR `calc()` since 2026-09-22: the record carries it as the pair `px + frac x basis`
      # (rec[100..105] beside rec[119..124]) and native resolves it at the basis it has, exactly as it does a
      # plain one. It fell back until then — for want of a constant term to send, not for want of a basis.
      # The ITEM's box is asserted beside the parity, and against CHROME, because parity alone would be green
      # if native and the oracle agreed on a wrong figure: this increment put new arithmetic on the native
      # side, and `nativeFlexRows >= 1` only says which path ran.
      calc_row = '<div style="display:flex;width:400px"><div><div id="m" style="height:calc(50% + 2px)">pct</div></div><div style="height:40px;width:50px"></div></div>'
      expect_native_flex(calc_row)
      expect(marked_box(calc_row)).to eq([19.546875, 22])   # Chrome 153
      calc_col = %(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div id="m" style="height:calc(50% + 2px)">pct</div></div><div style="flex:1 1 auto">plain</div></div>)
      expect_native_flex(calc_col)
      expect(marked_box(calc_col)).to eq([300, 52])         # Chrome 153
    end
    # …and it FALLS BACK for a percentage the walk still resolves, which is what the narrowed test names: one under a
    # TABLE part a route reaches — a VERTICAL table's cell here, whose inline size the walk resolves against the
    # oracle's table — where the record's parent is not the box the percentage resolves against, so the figure was
    # resolved against the item's FINAL size and native measures at a provisional one. (An OUT-OF-FLOW box's is
    # native's since 2026-09-25: it is placed against its containing block once every size is final. And a math
    # function is no longer one at all: every `min()` / `max()` / `clamp()` over lines, nested, crossing or inside a
    # `calc()` sum, travels as a program since 2026-09-26.)
    # Dropping the test put 15 wrong boxes into a 2,268-case math-function sweep, 28 into a 1,200-case route sweep
    # and 36 into a 960-case inline sweep, all 0 at the parent commit.
    # A LINEAR `calc()` left this list on 2026-09-22 and is in the arm above; the figure that used to be cited
    # here (`height: calc(50% + 2px)` in a wrapping row, 55.5 against Chrome's 58) is now 22, Chrome's own.
    it 'falls back for a percentage the walk resolves, not for one native does' do
      route = %(<div style="#{col};flex-wrap:wrap;height:200px;font:16px monospace"><div style="align-self:flex-start">) +
              '<table style="writing-mode:vertical-rl"><tr><td style="min-width:40%">aa</td><td>bb</td></tr></table></div><div style="width:30px;height:20px"></div></div>'
      expect(run_shadow(route)).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0)
      # …where a comparison inside a `calc()` sum — scaled and subtracted too — is native's as the rest are
      [%(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div style="min-height:calc(100% - 2 * min(25%, 40px))">pct</div></div><div style="flex:1 1 auto">plain</div></div>),
       '<div style="display:flex;width:400px"><div><div style="min-height:calc(min(50%, calc(10% + 40px), 80px) / 2 + 5px)">pct</div></div><div style="height:40px;width:50px"></div></div>'].each do |body|
        expect_native_flex(body)
      end
      # …where a comparison function over affine operands is native's: the size travels as its PROGRAM and native
      # evaluates it at whichever basis it measures at — two lines that cross beside a constant included, which fell
      # back until 2026-09-26. Chrome's box for the row; the column is 60 in both engines — the oracle's figure when it
      # was pushed, too — and 60.39 in Chrome, whose flexed item comes out ~1px taller around the same min-height.
      row3 = '<div style="display:flex;width:400px"><div><div id="m" style="min-height:min(50%, calc(10% + 40px), 80px)">pct</div></div><div style="height:40px;width:50px"></div></div>'
      expect_native_flex(row3)
      expect(marked_box(row3)).to eq([19.546875, 20])   # Chrome
      col3 = %(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div id="m" style="min-height:max(10px, 50%, calc(40% + 20px))">pct</div></div><div style="flex:1 1 auto">plain</div></div>)
      expect_native_flex(col3)
      expect_shared_gap(marked_box(col3)[1], shared: 60, chrome: 60.390625, what: col3)
      row = '<div style="display:flex;width:400px"><div><div id="m" style="min-height:min(50%,80px)">pct</div></div><div style="height:40px;width:50px"></div></div>'
      expect_native_flex(row)
      expect(marked_box(row)).to eq([19.546875, 20])
      column = %(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div id="m" style="min-height:clamp(10px,50%,80px)">pct</div></div><div style="flex:1 1 auto">plain</div></div>)
      expect_native_flex(column)
      expect(marked_box(column)).to eq([300, 50])
      # …and one with a constant beside two percentage lines, where one line always wins: `max(10%, 5%, 1px)` is `10%`
      # floored at 1 — it took a line and DROPPED the constant once (a gap 0.5 wide where CSS says 1), and was declined
      # after that until the walk learned to drop the losing line instead. Two lines that CROSS beside a constant were
      # no clamp of one and declined until 2026-09-26, and one inside a `calc()` sum too; a program is all of them.
      # Chrome's figures.
      gap = '<div style="display:flex;column-gap:max(10%, 5%, 1px);width:5px"><div style="width:1px;height:10px"></div><div style="width:1px;height:10px"></div></div>'
      expect_native_flex(gap)
      expect(item_boxes(gap)[1][0]).to eq(2)   # Chrome
      crossing = gap.sub('max(10%, 5%, 1px)', 'max(10%, calc(5% + 3px), 1px)')
      expect_native_flex(crossing)
      expect(item_boxes(crossing)[1][0]).to be_within(0.01).of(4.125)   # Chrome: a 3.25 gap, both items shrunk
      in_calc = gap.sub('max(10%, 5%, 1px)', 'calc(max(10%, calc(5% + 3px), 1px) + 0px)')
      expect_native_flex(in_calc)
      expect(item_boxes(in_calc)[1][0]).to be_within(0.01).of(4.125)   # Chrome
      expect_native_flex('<div style="position:relative;display:flex;width:400px"><div><div style="position:absolute;height:50%;width:10px"></div>pct</div>' \
                         '<div style="height:40px;width:50px"></div></div>')
      # …and neither is a NON-linear one on it, nor any percentage UNDER it: the whole subtree is laid out there.
      # Chrome: the absolute box 30 x 10, and 100 x 18 around its child.
      [
        '<div style="position:relative;display:flex;flex-direction:column;width:400px"><div><div style="position:absolute;top:0;width:min(50%, 30px);height:10px"></div>pct</div>' \
        '<div style="height:40px;width:50px"></div></div>',
        '<div style="position:relative;display:flex;width:400px"><div><div style="position:absolute;top:0;width:100px"><div style="height:min(50%, 80px)">x</div></div>pct</div>' \
        '<div style="height:40px;width:50px"></div></div>'
      ].each do |body|
        expect_native_flex(body)
      end
    end

    # An atomic written through a `display: contents` wrapper inside a MIXED block, whose record hangs under the
    # anonymous group: the route is asked by BOX (`layoutParent`), where `flatTreeParent` stopped at the wrapper
    # (119 against 102). Its percentage HEIGHT fell back while the group's auto height was its basis; native hands the
    # group's content the mixed block's own basis now (`NL_FLAG_ANON_GROUP`), so the item is sized natively. Chrome's
    # boxes.
    it 'sizes an item holding an atomic through `contents` in a mixed block natively' do
      {
        %(<div style="#{col};height:120px"><div style="flex:1"><div style="height:100%">lead<p>para</p><span style="display:contents"><span id="m" style="display:inline-block;width:20px;height:50%">a</span></span></div></div><div>z</div></div>) => [20, 51],
        %(<div style="#{col};height:120px"><div style="flex:1"><div style="height:100%"><p>para</p><b>b <span style="display:contents"><img id="m" style="width:12px;height:50%"></span></b></div></div><div>z</div></div>) => [12, 51]
      }.each do |body, size|
        expect_native_flex(body)
        expect(marked_box(body)).to eq(size)
      end
    end
    # …and an inline BOX's percentage EDGE no longer falls back, at any depth: it has no record, but its fractions ride
    # the inline table and native resolves them against the content width of the block laying the line out — the
    # item's natural one when it measures a wrapping column's item, its final one when it lays it out, which is what
    # the oracle's `placeInlineBox` reads too. It fell back while the walk resolved the edge against the oracle's
    # FINAL width for both (54 tall in native, 36 in the oracle and Chrome).
    it 'measures an item holding an inline box\'s percentage edge natively' do
      wrap = 'display:flex;flex-direction:column;flex-wrap:wrap;height:60px'
      [%(<div style="#{wrap}"><div>bold <i style="padding-left:20%">inl</i> tail words</div><div style="height:40px">z</div><div style="width:170px;height:30px"></div></div>),
       %(<div style="#{wrap}"><div><b>bold <i style="padding-left:20%">inl</i> tail</b> words</div><div style="height:40px">z</div><div style="width:170px;height:30px"></div></div>)].each do |body|
        expect_native_flex(body)
        expect(first_item_box(body)[3]).to eq(36)   # Chrome
      end
    end

    # …and the INLINE route is no longer one of them: an ATOMIC written inside an inline box hangs under the text
    # block of the block around it, which is its containing block too (an inline box is none), so where that block
    # is the record's parent — not a mixed block's anonymous group — its percentage travels as a fraction like a
    # direct child's. Until 2026-09-24 the walk resolved it against the oracle's box, and the item holding it fell
    # back to the pushed path: 152 of 200 sampled `flexpctinline` shapes broke with the oracle hidden, none now.
    # Chrome: the span is 50 tall in a 100px stretched row, 20 in the 40px line an auto one gets.
    it 'sizes an item holding an atomic whose percentage sits inside an inline box natively' do
      {
        '<div style="display:flex;width:400px;height:100px">' => 50,
        '<div style="display:flex;width:400px">'              => 20
      }.each do |open, h|
        body = %(#{open}<div><div style="height:100%">words <b>b <span id="m" style="display:inline-block;height:50%;width:20px"></span></b></div></div><div style="height:40px;width:50px"></div></div>)
        expect_native_flex(body)
        expect(laid_out_rect(body)[3]).to eq(h)
        r = run_shadow(body, '{noOracle: true}')
        expect(r).to include('ok' => true, 'mismatches' => 0)
        expect(r['oracleReads'].to_h.keys.grep(/\A(cbH|walkRecord|pushBorderBox) /)).to eq([]), r.inspect
      end
    end

    # …and the GRID route is no longer one of them. A grid item's containing block is its GRID AREA — its
    # TRACK across, its ROW down — which native did not have: it resolved a grid item's percentages against the
    # GRID's content box, so the walk resolved them instead, against the size the ORACLE's final layout gave
    # the item, and a flex item holding such a grid FELL BACK to the pushed path (it never declined — the old
    # assertion here was `nativeFlexRows => 0`, which is the fallback, not a refusal). Native resolves them per
    # track now, so the fraction travels and the item is sized natively.
    # The BASIS itself is the grid spec's business and is asserted there against Chrome
    # (`native_layout_grid_spec`, "resolves a grid item's percentages against its GRID AREA"); what these say
    # is only that the flex path stopped falling back.
    it 'sizes an item holding a grid whose own item declares a percentage natively' do
      expect_native_flex('<div style="display:flex;width:400px"><div><div style="display:grid;height:100%"><div style="height:50%">pct</div></div></div><div style="height:40px;width:50px"></div></div>')
      expect_native_flex(%(<div style="#{col};height:200px"><div style="flex:1 1 auto"><div style="display:grid;height:100%"><div style="height:50%">pct</div></div></div><div style="flex:1 1 auto">plain</div></div>))
      expect_native_flex('<div style="display:flex;width:400px"><div><div style="display:grid;grid-template-columns:100px 1fr"><div style="padding-left:50%">a</div><div>b</div></div></div><div style="height:40px;width:50px"></div></div>')
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
    # …and a WRAP column's STRETCHING item is measured at its shrink-to-fit width and then RE-STRETCHED, so the
    # BASIS of any percentage in its subtree moves between the measure and the final layout. That used to
    # refuse EVERY such item — "it makes no difference who resolved it" — and it is a CONFORMANCE worry, not a
    # parity one: both engines measure at the same provisional width, so both are wrong together and the
    # harness sees nothing. Six shapes of a 2,548-case sweep did break, and they were the grid-area
    # containing block (7f9919e8), not this.
    it 'takes a wrap column\'s stretching item natively even when its subtree declares a percentage' do
      [%(<div style="#{col};flex-wrap:wrap"><div><div style="padding-top:50%">x</div></div></div>),
       %(<div style="#{col};flex-wrap:wrap"><div><div style="width:50%">some text words here to wrap</div></div><div>two</div></div>)].each do |body|
        expect_native_flex(body)
      end
      # …and the same container with the item NOT stretching was native before and stays native
      expect_native_flex(%(<div style="#{col};flex-wrap:wrap"><div style="align-self:flex-start"><div style="width:50%">some text words here to wrap</div></div><div>two</div></div>))
    end
    # …and it no longer matters WHO resolved the percentage, which is what that half of the rule was about.
    # The refusal that used to stand here — a wrap column's stretching item, refused for any percentage in
    # its subtree — was there because the ORACLE's margin basis was a PREDICTION: `marginBasis` answered
    # `cbW − the box's own edges` on the rule that a block fills its containing block, and a box in a
    # vertical writing mode, one sized by an intrinsic keyword and one under a min/max clamp do not. Native
    # resolved the same percentage against the width the box actually got, so each was a parity break, and
    # the refusal existed to keep them out of the comparison (a DECLINE, never a right answer).
    # `marginBasis` derives the width `layoutBlock` derives now, so all of it is native. What each arm asserts
    # is PARITY — `expect_native_flex` says the two engines agree and that the item was sized natively — and
    # parity is blind to a shared error, so the Chrome column belongs here too. Measured 153, this shape, the
    # mid box's width and the percentage margin it gives:
    #   (plain)  300 / 30      max-width:100px  100 / 10      min-width:600px       600 / 60
    #   fit-content 300 / 30   width:120px      120 / 12      width:50%             150 / 15
    #   min-inline-size:600px  600 / 60
    #   writing-mode:vertical-rl  Chrome 36 wide / margin 30.23; BOTH ENGINES 268.34 wide / margin 26.83 —
    #     here the BOX diverges too, and by more than the margin does, because this mid box holds TEXT and
    #     this engine lays none of it vertically. It is the one divergence this increment leaves standing,
    #     it is SHARED, so none of these arms can see it, and `layout_margin_collapsing_spec`'s vertical arm
    #     is where it is written down — over a shape with no text, where the boxes agree at 80x200 and only
    #     the AXIS the percentage asks differs. The same rule, two different amounts of it.
    # (`fit-content` is 300 here and 80 in that spec, and that is the keyword doing exactly what it says: the
    # room on offer is NARROWER than max-content here — the text wants more than 300 — and WIDER there,
    # where the content is one 80px box in a 300px block.)
    {
      'a vertical writing mode' => 'writing-mode:vertical-rl',
      'a max-width clamp'       => 'max-width:100px',
      'a min-width clamp'       => 'min-width:600px',
      'an intrinsic keyword'    => 'width:fit-content',
      'a logical clamp'         => 'min-inline-size:600px',
      'a declared length'       => 'width:120px',
      'a declared percentage'   => 'width:50%',
      'a plain block'           => ''
    }.each do |name, mid|
      it "takes a wrap column's stretching item over a box sized by #{name}" do
        expect_native_flex(wrap_col_pct(mid, 'margin:10% 0'))
      end
    end
    # …and a percentage inside an ATOMIC inline (whose children's records hang under it, so native has their basis)
    # or on a table's CAPTION (which `measure_table` resolves): `nlWalkResolvesPct` called both the walk's until
    # 2026-09-25, "broader than the hazard on purpose", and pushed every flex container above one — ~60 of the 279
    # pushes the census counted, with no shape to show a hazard once they were lifted.
    it 'sizes a wrap column natively over a percentage inside an inline-block or on a caption' do
      expect_native_flex(%(<div style="display:flex;flex-direction:column;width:300px;height:150px;flex-wrap:wrap"><div style="align-self:flex-start"><div style="display:inline-block"><div style="width:50%">some rather longer words here to measure</div></div></div><div style="width:30px;height:20px"></div></div>))
      expect_native_flex(%(<div style="display:flex;flex-direction:column;width:300px;height:150px;flex-wrap:wrap"><div style="align-self:flex-start"><div style="display:inline-block"><div style="min-height:50%;padding:0 10%">some rather longer words here to measure</div></div></div><div style="width:30px;height:20px"></div></div>))
      expect_native_flex('<div style="display:flex;width:300px"><table style="border-spacing:2px"><caption style="height:50%">a caption that wraps over several words here</caption><tr><td>a</td><td>bb cc</td></tr></table><div>y</div></div>')
    end
    # …and a table PART's percentage native resolves itself: a cell's `width` (its column's), `padding` (the table's,
    # `measure_table`), `height` (no basis) and a row's `height` (its minimum) — every table part was the walk's until
    # 2026-09-25 and pushed the container around it — and its `min-width` / `max-width`, which reach nothing, since
    # 2026-09-26.
    # …and a BLOCK inside a `display: inline` box, which both engines lay out as an atomic holding it: the block's record
    # hangs under that atomic, whose basis native has — the route pushed its container "as the conservative answer"
    # until 2026-09-25, `display: contents` between them or not.
    it 'sizes natively over a percentage on a block inside an inline box' do
      expect_native_flex('<div style="display:flex;width:300px;height:100px"><div><div style="height:100%">words <b>b <span style="display:contents"><div style="height:50%">blk</div></span></b></div></div><div style="width:30px;height:40px"></div></div>')
      expect_native_flex(%(<div style="#{col};height:120px"><div style="flex:1"><div style="height:100%">words <b>b <div style="padding-left:20%;width:50%">blk</div></b></div></div><div>z</div></div>))
    end
    it 'sizes a column natively over a table whose parts declare percentages native resolves' do
      ['width:40%', 'padding:0 10%', 'height:50%', 'min-width:30%', 'max-width:20%', 'width:calc(40% + 10px)'].each do |decl|
        expect_native_flex(%(<div style="#{col};height:200px;font:16px monospace"><table style="border-spacing:2px"><tr><td style="#{decl}">aa bb</td><td>cc</td></tr></table><div style="width:40px">y</div></div>))
      end
      expect_native_flex(%(<div style="#{col};height:200px;font:16px monospace"><table style="border-spacing:2px"><tr style="height:50%"><td>aa</td></tr><tr><td>bb</td></tr></table><div>y</div></div>))
      # (…a wrap column's stretched and shrink-to-fit items, a 80% table and a clamped padding among them — the review's)
      expect_native_flex('<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:300px;height:200px;font:16px monospace"><div><table style="width:80%"><tr><td style="padding:0 10%">aa bb cc</td><td>dd</td></tr></table></div><div style="width:30px;height:20px"></div></div>')
      expect_native_flex('<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:300px;height:200px;font:16px monospace"><div style="align-self:flex-start"><table><tr><td style="padding:0 clamp(2px, 8%, 20px)">aa bb</td><td>cc</td></tr></table></div><div style="width:30px;height:20px"></div></div>')
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
    # A grid ITEM is measurable — both engines answer for it with the grid algorithm — so a grid baseline item
    # takes the NATIVE path, one holding a contiguous run of TEXT included: `gridItems` wraps the run in the
    # anonymous ITEM box CSS Grid §4 asks for, and the run's own BASELINE is what the line then hangs from
    # (`baselineCandidates` reads that list for a grid, not the raw children — measured, an `inline-grid`
    # around bare text put the marker beside it at y 18 where Chrome says 13). It pushed until 2026-09-22.
    it 'keeps parity for a nested grid baseline item' do
      [
        '<div>g1</div><div style="font-size:24px">g2</div>',
        'g1<div style="font-size:24px">g2</div>'
      ].each do |items|
        r = run_shadow(%(<div style="#{base}"><div style="display:grid;grid-template-columns:1fr 1fr">#{items}</div><div style="font-size:32px">BIG</div></div>))
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 1), "#{items}: #{r.inspect}"
      end
      # …and an item whose own measure native lacks a rule for still pushes, so the counter is not always 1.
      # (`white-space: break-spaces` was this shape until 2026-09-23, when its measure went native.)
      # (Whatever flex containers the fixture holds lay out natively whatever the row around them does — it held two
      # while it was the percentage-gap shape, and holds none today — so the row's own contribution is what the count
      # shows BEYOND the fixture's.)
      own = run_shadow(%(<div style="width:400px">#{WalkRefusals::UNMEASURABLE}</div>))['nativeFlexRows']
      r = run_shadow(%(<div style="#{base}"><div style="display:grid;grid-template-columns:1fr min-content"><div>g1</div><div>#{WalkRefusals::UNMEASURABLE}</div></div><div style="font-size:32px">BIG</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => own), r.inspect
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
    # …and one holding a `vertical-align` shift or an atomic inline, which fell back to the pushed path — and read
    # the ORACLE's baseline — as a "baseline hazard" until 2026-09-24, when a sweep built on those shapes showed
    # native's own lines giving the same baseline. Chrome puts the plain item beside them at y 4.33 and 16.
    it 'sizes a baseline item holding a vertical-align or an atomic inline natively' do
      {
        %(<div style="#{base}"><div>text <sup>sup</sup> more</div><div id="m">x</div></div>)                                                    => 4.33,
        %(<div style="#{base}"><div>text <span style="display:inline-block;height:30px;width:10px"></span> more</div><div id="m">x</div></div>) => 16
      }.each do |body, y|
        expect_native_flex(body)
        expect(laid_out_rect(body)[1]).to be_within(0.01).of(y)
        # …off its OWN lines: rec[42], the oracle's baseline ascent, is written for a pushed item only
        r = run_shadow(body, '{noOracle: true}')
        expect(r).to include('ok' => true, 'mismatches' => 0)
        expect(r['oracleReads'].to_h.keys.grep(/baseline/i)).to eq([]), r.inspect
      end
    end
  end
  # The push census counts each container the PASS pushes, once: a flex container inside a cell that is measured, rolled
  # back and walked again as a pushed contribution is one container, not two — a rollback takes its count with it, as
  # it takes every other stream.
  it 'counts a pushed flex container once when an attempt around it is rolled back' do
    r = run_shadow('<table style="font:16px monospace"><tr><td><div style="display:flex"><div>x<table style="display:inline-table"><colgroup><col style="width:20px"></colgroup></table></div></div><span style="display:inline-block"><div style="display:table-row">aa bb</div></span></td></tr></table>')
    expect(r).to include('ok' => true, 'mismatches' => 0), r.inspect
    expect(r['pushedFlexWhy']).to eq('item-not-measurable' => 1)
  end
  # Native sizing is a promise about every item at once, and the WALK decides whether it holds: where it declines
  # one item's subtree the whole set is rolled back and re-emitted with the oracle's boxes pushed. Each shape
  # here holds content the walk refuses for a reason `nlFlexPushWhy`'s predicate does not model, and under
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
    # A `calc()` GAP was a silent ZERO in both engines: `lengthOrFraction` knew a bare length and a bare
    # percentage and nothing else — `lengthPx`'s three regexes match no `calc(` at all — so `gap: calc(…)`
    # fell through to `GAP_NONE` and the row packed its items edge to edge. Parity was green for it and always
    # would have been, the record carrying 0 and native agreeing, which is why these assert CHROME's number.
    # The `1rem` spelling was broken TOO and is no control: the hole was `lengthPx`'s, not the percentage's.
    # `10%` is the control — its own arm was always there.
    it 'opens a calc() gap, percentage or not' do
      {
        'calc(10% + 2px)'  => 92,     # 50 + (40 + 2)
        'calc(1rem + 2px)' => 68,     # 50 + 18
        '10%'              => 90
      }.each do |gap, chrome_x|
        body = %(<div style="display:flex;width:400px;gap:#{gap}"><div style="width:50px;height:10px"></div>) +
               %(<div id="m" style="width:50px;height:10px"></div></div>)
        expect_parity(body)
        x = marked_box_x(body)
        expect(x).to be_within(0.01).of(chrome_x), "gap:#{gap}: #m at #{x}, Chrome #{chrome_x}"
      end
      # …and the GRID's own gap, which reads the same `gapSpec`.
      grid = '<div style="display:grid;width:400px;grid-template-columns:50px 50px;gap:calc(10% + 2px)">' \
             '<div style="height:10px"></div><div id="m" style="height:10px"></div></div>'
      expect_parity(grid)
      expect(marked_box_x(grid)).to be_within(0.01).of(92)
    end
    # …and a COMPARISON function over ONE affine operand with constant bounds is `clamp(lo, px + frac x basis,
    # hi)` — a form the record carries (the bounds beside the pair) and native evaluates, so it takes the
    # native path like the rest. It was a silent ZERO before, and a decline for one build in between.
    # FLEX and GRID both, because the grid's gaps travel in a different array (`gridsAll`'s header) and the
    # bounds had to be added there separately: wiring only the flex pair left the grid 20px out with a
    # mismatch, which is what said the two are not one path.
    it 'evaluates a min() / clamp() gap natively, flex and grid' do
      {
        'min(10%, 20px)'        => 70,
        'clamp(5px, 10%, 12px)' => 62
      }.each do |gap, chrome_x|
        [%(<div style="display:flex;width:400px;gap:#{gap}"><div style="width:50px;height:10px"></div>) +
           %(<div id="m" style="width:50px;height:10px"></div></div>),
         %(<div style="display:grid;width:400px;grid-template-columns:50px 50px;gap:#{gap}">) +
           %(<div style="height:10px"></div><div id="m" style="height:10px"></div></div>)].each do |body|
          expect_parity(body)
          x = marked_box_x(body)
          expect(x).to be_within(0.01).of(chrome_x), "gap:#{gap}: #m at #{x}, Chrome #{chrome_x}"
        end
      end
    end
    # …and a gap capped by ANOTHER LINE goes native too, because the bounds are affine as well: `min(10%, 20%)`
    # is `10%` held under `20%`. It was the case that forced the generalisation — a bound that is a constant
    # covers `min(10%, 20px)` and nothing more, and the form left over was a silent ZERO in both engines
    # (a 400px row packed edge to edge) and then a decline. What is left for the oracle alone is a NESTED
    # comparison, which is what `gap-not-linear` names now.
    it 'evaluates a gap capped by another percentage natively' do
      body = '<div style="display:flex;width:400px;gap:min(10%, 20%)"><div style="width:50px;height:10px"></div>' \
             '<div id="m" style="width:50px;height:10px"></div></div>'
      expect_parity(body)
      expect(marked_box_x(body)).to be_within(0.01).of(90)   # Chrome 153: a 40px gap
    end
    # ORACLE: a gap whose BOUND is the percentage and whose value is not — `max(10px, 30%)`, the length floored at a
    # line — is asked at the basis too: `axisGap` passed it only where the value had a fraction, so the floor resolved
    # at 0 and the gap opened 10 where native and Chrome open 30% of the row.
    # WALK: a PUSHED baseline item's ascent is its margin box's, on the basis its percentage margins resolve against
    # — read at none (the edges the walk reads for the item's auto margins), a `margin-top: 10%` item lost its margin
    # from the ascent native hangs it by, 55 where the oracle and Chrome say 40. (The half-empty inline-table in it —
    # content the measure refuses — is what pushes the items.)
    # A STRETCHED row item's size is definite (§9.8), so a percentage height under it resolves against it even where
    # the stretch comes to the height the item measured — both engines laid it out again only where the two differed,
    # and a `height: 10%` child stayed 0 (Chrome 2.19, overflowing the 22px item). Native reached 2.2 only where a `vw`
    # margin rounded the room 4e-15 off the measure. The row twin of 2c7fd42c's column rule; Chrome's figures.
    it 'resolves a percentage height against a stretched row item that came to its own height' do
      [
        '<div style="display:flex;width:300px;font:16px monospace"><div>aa bb cc dd<div id="m" style="height:10%"></div></div><div>z</div></div>',
        '<div style="display:flex;width:300px;font:16px monospace"><div><p style="margin:0">aa bb</p><div id="m" style="height:10%"></div></div><div>z</div></div>',
        '<div style="display:flex;width:300px;font:16px monospace"><div style="margin:max(2vw, 5%) 0">aa bb cc dd<div id="m" style="height:min(10%, 20%, 30px)"></div></div><div>z</div></div>'
      ].each do |body|
        expect_native_flex(body)
        expect(marked_box(body)[1]).to be_within(0.02).of(2.188), body   # Chrome
      end
    end
    it 'hangs a pushed baseline item by the ascent of its percentage-margined box' do
      body = '<div id="c" style="display:flex;align-items:baseline;width:400px;height:200px;font:16px monospace">' \
             '<div style="margin-top:10%">a<table style="display:inline-table"><colgroup><col style="width:20px"></colgroup></table></div><div style="font-size:30px">b</div></div>'
      expect_parity(body)
      expect(first_item_box(body)[1]).to eq(40)   # Chrome
    end
    it 'resolves a gap whose bound is the percentage against the basis' do
      ['display:flex', 'display:grid;grid-template-columns:auto 1fr'].each do |disp|
        body = %(<div style="#{disp};width:400px;column-gap:max(10px, 30%)"><div style="width:50px;height:10px"></div>) +
               %(<div id="m" style="width:50px;height:10px"></div></div>)
        expect_parity(body)
        expect(marked_box_x(body)).to be_within(0.01).of(170), disp   # Chrome
      end
    end
    # BOTH: a min/max-height a push resolves on the walk side (a flex item whose subtree the oracle lays out) is its
    # PROGRAM's figure — resolved as the bare pair, `min(calc(200px - 50%), 60px)` in a 120px column floored the item
    # at 140 in native, where the oracle and Chrome say 60 — and a push takes the program off the record with the pair.
    it 'resolves a pushed item\'s clamped min-height by its program' do
      body = '<div id="c" style="display:flex;flex-direction:column;height:120px"><div style="min-height:min(calc(200px - 50%), 60px)">' \
             'a<div style="max-width:30%"></div></div></div>'
      expect_parity(body)
      expect(first_item_box(body)[3]).to eq(60)   # Chrome
    end
    # BOTH: a size resolved as a comparison function (a program native evaluates, the oracle's own before 2026-09-26) is
    # never below zero, as `usedSize` floors it — and the oracle's flex clamp reads a NEGATIVE maximum as zero, not as none.
    # `min(10%, calc(20% - 100px), calc(100% - 400px))` is -100 in 300px: native, handed that, gave a 2px-bordered box a
    # border box of 0; and the oracle left a `max-width: calc(10% - 100px)` item at its 12px of content. Chrome: 4, both.
    it 'floors a negative size at zero in both engines' do
      block = '<div id="c" style="width:300px"><div style="width:min(10%, calc(20% - 100px), calc(100% - 400px));border:2px solid">x</div></div>'
      expect_parity(block)
      expect(first_item_box(block)[2]).to eq(4)   # Chrome
      ['max-width:calc(10% - 100px)', 'max-width:min(10%, calc(20% - 100px), calc(100% - 400px))'].each do |max|
        item = %(<div id="c" style="width:300px;display:flex"><div style="#{max};border:2px solid">x</div></div>)
        expect_parity(item)
        expect(first_item_box(item)[2]).to eq(4), max   # Chrome
      end
    end
    # …and a DECLARED `normal` longhand is a gap of none, which stops at the longhand instead of falling
    # through to the shorthand: `gap: 20px; column-gap: normal` opened 20px where Chrome opens nothing.
    it 'lets a normal longhand cancel the shorthand gap' do
      ['display:flex', 'display:grid;grid-template-columns:50px 50px'].each do |disp|
        body = %(<div style="#{disp};width:400px;gap:20px;column-gap:normal"><div style="width:50px;height:10px"></div>) +
               %(<div id="m" style="width:50px;height:10px"></div></div>)
        expect_parity(body)
        expect(marked_box_x(body)).to eq(50), disp
      end
    end

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
    # …and resolves a LINEAR `calc()` basis itself: the constant term rides beside the fraction (rec[63] next to
    # rec[97]) since 2026-09-25, where the record had no slot for it and the walk resolved the whole basis against
    # the oracle's box — and a COMPARISON one as its program (`NL_REC_BASIS_MATH`) since 2026-09-26. Chrome: 70 wide in
    # a 300px row, 50 tall in a 200px column; 90 for `max(30%, 10px)` and for three operands whose lines cross, 30 tall
    # for a `clamp()` in the column.
    it 'resolves a linear calc() basis natively, with no oracle box read' do
      {
        '<div style="display:flex;width:300px"><div id="m" style="flex-basis:calc(20% + 10px);flex-shrink:0">a</div><div>b</div></div>'                                      => [2, 70],
        '<div style="display:flex;flex-direction:column;width:300px;height:200px"><div id="m" style="flex-basis:calc(20% + 10px);flex-shrink:0">a</div><div>b</div></div>' => [3, 50],
        '<div style="display:flex;width:300px"><div id="m" style="flex-basis:max(30%, 10px);flex-shrink:0">a</div><div>b</div></div>'                                        => [2, 90],
        '<div style="display:flex;width:300px"><div id="m" style="flex-basis:min(40%, calc(20% + 30px), 100px);flex-shrink:0">a</div><div>b</div></div>'                      => [2, 90],
        '<div style="display:flex;flex-direction:column;width:300px;height:200px"><div id="m" style="flex-basis:clamp(10px, 20%, 30px);flex-shrink:0">a</div><div>b</div></div>' => [3, 30]
      }.each do |body, (index, size)|
        expect_native_flex(body)
        expect(laid_out_rect(body)[index]).to eq(size)
        r = run_shadow(body, '{noOracle: true}')
        expect(r).to include('ok' => true, 'mismatches' => 0)
        expect(r['oracleReads'].to_h.keys.grep_v(/\(handed over\)\z/)).to be_empty, r.inspect
      end
    end
    # …where three bases part from Chrome in BOTH engines alike (the review of 34298827), pinned: a negative linear
    # basis is not floored at zero (the grown item 100 wide, Chrome 135); a column with only a `min-height` resolves
    # a percentage basis against it (30, Chrome 18 — its main size is indefinite there); and a column stretched to
    # its GRID row is not definite for one (18, Chrome 80).
    it 'resolves three percentage bases as the oracle does, where Chrome does not' do
      {
        '<div style="display:flex;width:300px"><div id="m" style="flex-basis:calc(10% - 100px);flex-grow:1;min-width:0">a</div>' \
        '<div style="flex:none;width:30px"></div><div style="flex:1 1 0px;min-width:0">b</div></div>'                                  => [2, 100, 135],
        '<div style="display:flex;flex-direction:column;width:200px;min-height:150px"><div id="m" style="flex-basis:20%">a</div></div>' => [3, 30, 18],
        '<div style="display:grid;grid-template-rows:100px;width:200px"><div style="display:flex;flex-direction:column">' \
        '<div id="m" style="flex-basis:80%">a</div></div></div>'                                                                        => [3, 18, 80]
      }.each do |body, (index, shared, chrome)|
        expect_parity(body)
        expect_shared_gap(laid_out_rect(body)[index], shared: shared, chrome: chrome, what: "#{body}: #m rect[#{index}]")
      end
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

  # A FLEXED item's size is definite (css-flexbox §9.8), so a percentage height inside it resolves against that size.
  # The oracle reused the item's measuring layout — where the same percentage read an indefinite basis as nothing —
  # whenever the flexed size came to the same number, and was right only where a `position: fixed` descendant happened
  # to refuse the reuse; native mirrored the reuse. Both engines lay such an item out again now, and give Chrome's boxes.
  it 'resolves a percentage height inside a flexed column item against its flexed size' do
    img = '<span id="m" style="display:inline-block;width:5px;height:40%"></span>'
    [%(<div style="display:flex;flex-direction:column;height:180px"><div>t#{img}<div>b</div></div></div>),
     %(<div style="display:flex;flex-direction:column;height:180px"><div>t#{img}<div>b</div><i style="position:fixed"></i></div></div>)].each do |body|
      expect_parity(body)
      expect(marked_box(body)).to eq([5, 14.4])   # Chrome 14.39
    end
    body = '<div style="display:flex;flex-direction:column;height:300px"><div><div id="m" style="height:50%">x</div></div></div>'
    expect_parity(body)
    expect(marked_box(body)[1]).to eq(9)          # Chrome
    body = '<span style="display:inline-flex;flex-direction:column;height:50px;justify-content:flex-end;width:80px">' \
           '<div><div id="m" style="position:relative;top:10%;height:10%">bb bb bb bb cc</div></div></span>'
    expect_parity(body)
    expect(marked_box(body)[1]).to be_within(0.05).of(3.59)   # Chrome
  end
end