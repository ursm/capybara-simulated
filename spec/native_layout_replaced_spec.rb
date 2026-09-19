# frozen_string_literal: true
# Native layout — REPLACED LEAF sizing, geometry shadow-parity. A replaced element (svg / img / canvas /
# input / …) lays out no CSS-box children of its own; its INTRINSIC size is data the walk hands native (a
# decoded image's natural size, a control's chrome, an svg's viewBox), and native sizes the box from it as
# the oracle's `usedSize` does (`replaced_box`: declared sizes win, an intrinsic ratio derives the other axis,
# min/max clamp through the ratio, a border box floors at its edges). Handled as a BLOCK-LEVEL child, a FLEX
# ITEM (row and column, sized natively) and a GRID ITEM. A control that lays out CSS boxes of its own is a
# leaf like any other — the oracle never sizes it by stacking them — EXCEPT a LIST BOX showing rows, which is
# a block container whose box is the control's and whose rows native stacks itself. Still DECLINES: an INLINE
# replaced element (an atomic inline in a text line), and a list box as a GRID ITEM. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout replaced-leaf parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # `opts` is the second argument of `__csimLayoutShadowRun`, as JS source: `{noOracle: true}` runs the same
  # pass with every oracle layout stamp hidden, which is the only way to tell a box native LAID OUT from one
  # it replayed off the oracle (a replayed box is parity-clean by construction).
  def run_shadow(body, opts = '{}')
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script("globalThis.__csimLayoutShadowRun(undefined, #{opts})")
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  def expect_bail(body)
    expect(run_shadow(body)).to include('ok' => false)
  end

  # …rooted at `#t` rather than at the body: the pass root is sized from the width the harness hands it, which
  # is a rule of its own and the only way to reach it.
  def run_rooted(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script(%(globalThis.__csimLayoutShadowRun(document.getElementById('t'), {})))
  end

  # The page-visible width of the first element matching `selector` — for the one case where parity is not the
  # question, because both engines agree on a figure Chrome does not share.
  def rendered_width(body, selector)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script(%(document.querySelector('#{selector}').getBoundingClientRect().width))
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
  # A control that lays out its OWN content (a display:block <select> whose options carry _lb) IS a leaf all the
  # same: the oracle takes its border box from its intrinsic (one-row) size, never by stacking those options, so
  # native pushes that box and emits no subtree — the options are inside a leaf, not children of the flow.
  it 'pushes a display:block <select> that lays out its options (sized by intrinsic, not child flow)' do
    expect_parity('<div style="width:300px"><select style="display:block"><option>aaaa</option><option>bb</option></select></div>')
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
    # A `<button>` is as wide as its CONTENT wants, whatever room it is given -- HTML's button layout IS the
    # shrink-to-fit algorithm. Native sizes it from its own content now, as it already did for an intrinsic-size
    # keyword and a vertical writing mode; a block-level one used to fill its container and be refused.
    it 'shrink-wraps a block-level button to its content' do
      expect_parity('<div style="width:400px"><button style="display:block">a long button label</button><div style="height:10px"></div></div>')
      expect_parity('<div style="width:50px"><button style="display:block">a long button label</button></div>')
      expect_parity('<div style="width:400px"><button style="display:block;box-sizing:border-box;padding:6px">ab</button></div>')
      expect_parity('<div style="width:400px"><button style="display:block;max-width:40px">a long button label</button></div>')
    end
    # …and it is walked as a MEASURED subtree, like every other box native sizes from its own content. Plain
    # text is no test of that: native measures it right either way. What proves the contract is content with
    # a measure-only gap in it, which must DECLINE rather than answer — a `text-indent` (native's
    # `text_intrinsic` has none), a grid holding an anonymous item. Without the contract these were 30px
    # narrow, and one in a `<td>` took the whole table's columns with it (258 mismatches in a 12,393-case
    # sweep).
    it 'walks a shrink-wrapping button as a measured subtree' do
      # …an indented one included now that `text_intrinsic` takes the indent; a measure-only gap that REMAINS
      # (a grid whose own TEXT is an anonymous item neither engine gives a record) still declines.
      ['<div style="width:400px"><button style="display:block;text-indent:30px">Hi</button></div>',
       '<div style="width:400px"><button style="display:block"><div style="text-indent:40px">Hi</div></button></div>',
       '<table style="border-spacing:0"><tr><td style="padding:0"><button style="display:block;text-indent:30px">Click me</button></td><td style="padding:0">b</td></tr></table>'].each do |body|
        expect_parity(body)
      end
      expect_bail('<div style="width:400px"><button style="display:block"><div style="display:grid">aa bb<div>cc</div></div></button></div>')
    end
    # …while the shrink-wrap decides nothing for a button whose width another algorithm owns, and native was
    # always right about those: a flex or grid ITEM, an out-of-flow box, a float, a declared or keyword width.
    # Refusing them cost 447 shapes of a 4,860-case sweep nothing but coverage.
    it 'lays out a button whose width another algorithm owns' do
      ['<div style="width:900px"><button style="display:flex;width:200px">Click</button></div>',
       '<div style="width:900px;position:relative"><button style="position:absolute;left:0;display:grid">Click</button></div>',
       '<div style="width:900px"><button style="float:left">Click</button></div>',
       '<div style="display:flex;width:900px"><button style="display:grid">Click</button></div>',
       '<div style="width:900px"><button style="display:flex;width:min-content">Click</button></div>'].each do |body|
        expect_parity(body)
      end
    end
    # …and a button that is ITSELF a flex or grid container takes the SAME route: `block_child_width` routes
    # any auto-width button through the content-sized path, and `intrinsic_widths` dispatches to the flex /
    # grid algorithm from there, so the container's own sizing is what answers. The gate that refused these
    # was written beside the block-flow shrink-wrap, before the percentage and intrinsic work that made the
    # flex and grid arms answer for their own box; it outlived its cause and cost 924 shapes of a 12,393-case
    # sweep (declines 2997 -> 2073, oracle-free 6904 -> 9302 — it read `_lbCbW` of every box it judged).
    # Chrome-measured: 124.94 in 400px of room, 60 in 60px (the room, its label wrapped to three lines — the
    # button's own min-content is 53.05), 112.17 with a `10%` padding, 26.38 for an `inline-flex` on a line.
    it 'sizes a button that is itself a flex or grid container from its own content' do
      ['<div style="width:400px"><button style="display:flex"><span>a long button label</span></button></div>',
       '<div style="width:400px"><button style="display:grid"><span>a long button label</span></button></div>',
       '<div style="width:60px"><button style="display:flex"><span>a long button label</span></button></div>',
       '<div style="width:60px"><button style="display:grid"><span>a long button label</span></button></div>',
       '<div style="width:400px"><button style="display:flex;padding:0 10%"><span>label</span></button></div>',
       '<div style="width:400px"><button style="display:flex;box-sizing:border-box;max-width:40px"><span>label</span></button></div>'].each do |body|
        expect_parity(body)
      end
      # …and BARE text in one, which is the commonest markup of all (`class="flex items-center"`) and the case
      # these shapes wrap in a `<span>` to keep out of the way: a flex container's ANONYMOUS item contributes
      # nothing, so the button is its own edges wide — 16 against Chrome's 46.39. Both engines agree, so this
      # is parity-clean and no sweep can see it; it is the flex twin of the grid anonymous-item gap, and it is
      # native's answer to give once the oracle is deleted. Pinned here so the day it is fixed, it is fixed in
      # both engines at once.
      bare = '<div style="width:400px"><button style="display:flex">Save</button></div>'
      expect_parity(bare)
      expect(rendered_width(bare, 'button')).to eq(16)
    end
    # …an `inline-flex` / `inline-grid` one included: as an ATOMIC INLINE it was pushed with the oracle's box
    # (the same gate answers `nlAtomicNative`), and it is laid out and placed on the line natively now.
    it 'lays out an inline-flex or inline-grid button on a line' do
      ['<div style="width:400px">before<button style="display:inline-flex"><span>hi</span></button>after</div>',
       '<div style="width:400px">before<button style="display:inline-grid"><span>hi</span></button>after</div>',
       '<div style="width:400px">before<button style="display:inline-flex;vertical-align:super"><span>hi</span></button>after</div>',
       '<div style="width:60px">before<button style="display:inline-flex"><span>a long button label</span></button>after</div>',
       '<div style="width:60px">before<button style="display:inline-grid"><span>a long button label</span></button>after</div>'].each do |body|
        expect_parity(body)
        # …and it is LAID OUT, not replayed: a pushed atomic carries the oracle's box, which parity cannot tell
        # from a native one. The whole read set is the one figure the harness HANDS the pass.
        r = run_shadow(body, '{noOracle: true}')
        expect(r).to include('ok' => true, 'mismatches' => 0, 'oracleWrites' => 0), r.inspect
        expect(r['oracleReads'].keys).to eq(['nlShadowRun the pass root origin and width (handed over)']), body
      end
    end
    # …and NOT as the pass ROOT. The one thing native assumes about the root is that its box is the containing
    # width the harness hands over — what an in-flow BLOCK-LEVEL box's auto width is, and nothing else's, since
    # the parent loop that applies every other rule is not there for a box with no parent in the pass. A
    # `<button>` at `display: flow-root` / `table` already came out 400 wide against the oracle's 124.98 before
    # any of this; the flex and grid cases joined them when the gate that refused those containers went. So the
    # guard asks the question once, for every box whose auto width is not its room.
    it 'refuses a pass root whose auto width is not the room it is handed' do
      # a `<button>` — HTML's button layout is shrink-to-fit at every display it can carry
      ['display:flex', 'display:grid', 'display:flow-root', 'display:table', 'display:block'].each do |display|
        body = %(<div style="width:400px"><button id="t" style="#{display}"><span>a long button label</span></button></div>)
        expect(run_rooted(body)).to include('ok' => false, 'reason' => 'root unsupported'), body
      end
      # …an ATOMIC inline, whose width is its line's shrink-to-fit (400 against the oracle's 19.55), and a FLEX
      # ITEM, whose width is the flex algorithm's (400 against 74.64, and 400 against 350 under `flex: 1`).
      ['<div style="width:400px"><span id="t" style="display:inline-flex"><span>lab</span></span></div>',
       '<div style="width:400px"><span id="t" style="display:inline-grid"><span>lab</span></span></div>',
       '<div style="display:flex;width:400px"><div id="t">a long label</div><div style="width:50px;height:5px"></div></div>',
       '<div style="display:flex;width:400px"><div id="t" style="flex:1">a long label</div><div style="width:50px;height:5px"></div></div>'].each do |body|
        expect(run_rooted(body)).to include('ok' => false, 'reason' => 'root unsupported'), body
      end
      # …while a declared width (a length, a percentage, a `calc()`) is the box's own, a plain container was
      # never the question, and a GRID item's containing width IS its track — so the room handed over is
      # already the right answer there, which is why it is the one item kind left in.
      ['<div style="width:400px"><button id="t" style="display:flex;width:200px"><span>lab</span></button></div>',
       '<div style="width:400px"><button id="t" style="display:flex;width:50%"><span>lab</span></button></div>',
       '<div style="width:400px"><span id="t" style="display:inline-flex;width:200px"><span>lab</span></span></div>',
       '<div style="width:400px"><div id="t" style="width:calc(50% - 10px)">ab</div></div>',
       '<div style="width:400px"><div id="t" style="min-width:600px">ab</div></div>',
       '<div style="width:400px"><div id="t" style="display:flex"><span>lab</span></div></div>',
       '<div style="width:400px"><table id="t"><tr><td>a long label</td></tr></table></div>',
       '<div style="display:grid;grid-template-columns:350px;width:400px"><div id="t" style="justify-self:start">a long label</div></div>'].each do |body|
        expect(run_rooted(body)).to include('ok' => true, 'mismatches' => 0), body
      end
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

    # A `<select>` stacking its `<option>`s used to decline WHOLE, on the argument that the oracle sizes it from
    # those boxes. It does not — a dropdown's options have no box in Chrome at all, and the oracle takes the
    # control's border box from its INTRINSIC size — so a DROPDOWN is a leaf like any other replaced element,
    # pushed and emitted without a subtree. A LIST BOX showing rows is a block container instead (below). That
    # was 18 shapes of the frozen corpus's 174 declines, freed outright — and, unnamed until a sweep found it,
    # 72 shapes that were laid out WRONG: a `<select style="display:flex">` with options reached the flex gate
    # before the replaced one and had its options flexed as items.
    describe 'a control that lays out boxes of its own' do
      it 'pushes a dropdown as a leaf box, and lays a list box out as a container' do
        # nodes: the leaf ones emit no subtree, the list boxes emit their rows.
        {'<select style="display:block"><option>a</option><option>bbbb</option></select>' => 4,
         '<select style="display:block"></select>'                                        => 4,
         '<textarea style="display:block;height:30px">hello</textarea>'                    => 4,
         '<select size="3" style="display:block"><option>a</option><option>b</option></select>'  => 6,
         '<select multiple style="display:block"><option>a</option></select>'              => 5}.each do |control, nodes|
          body = %(<div style="width:300px">#{control}<div style="height:10px"></div></div>)
          expect_parity(body)
          expect(run_shadow(body)['nodes']).to eq(nodes), body
        end
      end

      # A LIST BOX showing rows is the one control whose inner boxes are read for something — a BASELINE, which
      # `boxBaselineOffset` takes off its rows as any block's. Native stacks those rows ITSELF now (the box is
      # the control's, the content is ordinary block children), so every context that reads such a baseline
      # gets a real one instead of a rule about what to refuse. The rows are compared boxes too, which a
      # pushed-whole control's never were.
      it "stacks a list box's rows itself, and reads its baselines off them" do
        listbox = '<select multiple><option>a</option><option>bbbb</option></select>'
        empty   = '<select multiple></select>'
        ['baseline', 'last baseline'].each do |align|
          expect_parity(%(<div style="display:flex;align-items:#{align};width:400px"><div style="font-size:32px">BIG</div>#{listbox}</div>))
          expect_parity(%(<div style="display:flex;align-items:#{align};width:400px"><div style="font-size:32px">BIG</div><div>#{listbox}</div></div>))
          # …an EMPTY one has no rows and stays a leaf, its baseline the chrome's (`controlBaseline`).
          expect_parity(%(<div style="display:flex;align-items:#{align};width:400px"><div style="font-size:32px">BIG</div>#{empty}</div>))
        end
        expect_parity(%(<table style="width:300px"><tr><td style="vertical-align:baseline;font-size:32px">BIG</td><td style="vertical-align:baseline">#{listbox}</td></tr></table>))
        expect_parity(%(<div style="width:400px">text <span style="display:inline-block">#{listbox}</span> after</div>))
        # …and the rows do not depend on the UA sheet's `overflow: scroll` surviving: declaring it away used to
        # take the baseline scan down a different branch and nothing refused the difference.
        ['overflow:visible', 'overflow:clip', 'overflow:hidden'].each do |ov|
          expect_parity(%(<div style="width:400px">text <span style="display:inline-block"><select size="3" style="display:block;#{ov}"><option>a</option><option>bbbb</option></select></span> after</div>))
        end
        # The rows themselves are laid out where the oracle puts them (a `size=3` select's four options at
        # y = 1 / 16 / 31 / 46), which is what makes them compared boxes at all.
        expect_parity('<div style="width:400px"><select size="3" style="display:block"><option>a</option><option>bbbb</option><option>c</option><option>d</option></select></div>')
      end

      # …and its BOX is native's own now: the control's intrinsic data rides the record (`lays_out_children`) and
      # native applies this element's width / height / min / max and box-sizing to it (`replaced_box`), where the
      # walk used to pin the box the oracle had already resolved. Every declaration that reshapes a control's box.
      it 'derives a list box box from the intrinsic data, not the oracle box' do
        rows = '<option>a</option><option>bbbb</option>'
        ['', 'width:120px', 'height:60px', 'width:120px;height:60px', 'min-width:200px', 'max-width:30px',
         'min-height:90px', 'max-height:20px', 'width:50%', 'padding:6px 4px;border:3px solid',
         'box-sizing:border-box;width:120px;height:60px;padding:6px;border:2px solid',
         'box-sizing:content-box;width:50%;padding:6px;border:3px solid', 'width:50%;min-width:180px',
         'width:50%;max-width:40px', 'margin:5px 7px'].each do |style|
          expect_parity(%(<div style="width:400px"><select multiple size="3" style="display:block;#{style}">#{rows}</select></div>))
          expect_parity(%(<div style="width:400px">t <span style="display:inline-block"><select multiple size="3" style="display:block;#{style}">#{rows}</select></span> u</div>))
          # …and in a wrapper measured TWICE (a stretched flex line re-lays its items out): the control's box is
          # derived from the record's declarations each time, never from the figures a previous measure produced.
          expect_parity(%(<div style="display:flex;width:400px;height:150px;align-items:stretch"><div style="width:200px">) +
                        %(<select multiple size="3" style="display:block;#{style}">#{rows}</select></div><div style="width:40px">y</div></div>))
        end
        # A replaced box keeps its INTRINSIC height between block-axis insets — §10.6.5 ignores `bottom` for one —
        # which native stretched to the inset height (the list box 150 tall where the oracle says 53).
        ['<select multiple size="3" style="position:absolute;top:10px;left:20px;right:30px;bottom:40px;display:block">' + rows + '</select>',
         '<input style="position:absolute;top:0;bottom:0">',
         '<textarea style="position:absolute;top:0;bottom:0"></textarea>',
         '<img style="position:absolute;top:0;bottom:0;width:10px;height:10px">'].each do |box|
          expect_parity(%(<div style="width:400px;height:200px;position:relative">#{box}</div>))
        end
        # …and the same control in the layouts that size their children themselves
        expect_parity(%(<div style="display:flex;width:400px"><select multiple size="3" style="flex:1">#{rows}</select><div style="width:40px">y</div></div>))
        expect_parity(%(<table style="width:300px"><tr><td><select multiple size="3">#{rows}</select></td><td>b</td></tr></table>))
        # …the two that still decline: an intrinsic-size KEYWORD width on a replaced box (its width is its own
        # size), and a list box as a GRID item.
        [%(<select multiple size="3" style="display:block;width:max-content">#{rows}</select>),
         %(<div style="display:grid;grid-template-columns:150px 1fr;width:400px"><select multiple size="3">#{rows}</select><div>y</div></div>)].each do |body|
          expect(run_shadow(%(<div style="width:400px">#{body}</div>))).to include('ok' => false), body
        end
      end
    end
  end
end
