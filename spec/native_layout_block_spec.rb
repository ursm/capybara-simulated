# frozen_string_literal: true
# Native layout L1 (block flow) — geometry shadow-parity: the native pass's border-boxes must equal the
# JS layout's `_lb` on a pure block-flow page (explicit heights / no inline text / no float / no
# abspos — the cases L1 models). Validates the native block algorithm against the JS oracle before it
# becomes authoritative. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout L1 block-flow parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  # The pass root defaults to `<body>`; naming a SELECTOR runs the pass over that subtree instead, which is how
  # a containing block ABOVE the root — the case a viewport-origin page cannot exercise — gets tested.
  def parity(session, root = nil)
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    return session.evaluate_script('globalThis.__csimLayoutShadowRun()') unless root
    session.evaluate_script(%{globalThis.__csimLayoutShadowRun(document.querySelector(#{root.inspect}))})
  end

  it 'matches on stacked blocks with explicit heights' do
    session = simulated_session(page(<<~HTML))
      <div style="height:50px"></div>
      <div style="height:30px"></div>
      <div style="height:auto"><div style="height:20px"></div><div style="height:25px"></div></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['compared']).to be >= 5
  end

  it 'matches with margins, padding, borders, and box-sizing (margin collapsing)' do
    session = simulated_session(page(<<~HTML))
      <div style="height:40px;margin:10px 0;padding:5px;border:2px solid #000"></div>
      <div style="box-sizing:border-box;width:200px;height:60px;padding:8px;border:3px solid #000">
        <div style="height:20px;margin-left:15px"></div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches complex collapsing: adjacent margins, closed edges, empty block, nesting' do
    session = simulated_session(page(<<~HTML))
      <div style="margin-bottom:30px;height:20px"></div>
      <div style="margin-top:10px;height:20px"></div>
      <div style="margin:15px 0"></div>
      <div style="padding-top:1px;margin-top:25px">
        <div style="margin-top:40px;height:20px"></div>
      </div>
      <div style="margin-top:12px">
        <div style="margin-top:8px;height:20px"></div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches declared-zero-height and wrapped collapse-through' do
    session = simulated_session(page(<<~HTML))
      <div style="height:40px;margin-bottom:12px"></div>
      <div style="height:0;margin:18px 0"></div>
      <div style="height:25px;margin-top:6px"></div>
      <div style="margin:22px 0"><div style="margin:0"></div></div>
      <div style="height:15px;margin-top:9px"></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a BFC wrapper keeping its child margin inside (no collapse-through the BFC)' do
    # overflow:hidden establishes a block formatting context, so the inner div's margin-top does NOT
    # collapse out of the wrapper (§8.3.1) — the child sits 30px down inside a 40px-tall wrapper.
    session = simulated_session(page(<<~HTML))
      <div style="overflow:hidden;margin-top:20px">
        <div style="margin-top:30px;height:10px"></div>
      </div>
      <div style="height:15px"></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches percentage and clamped widths' do
    session = simulated_session(page(<<~HTML))
      <div style="width:60%;height:30px"></div>
      <div style="width:50%;max-width:120px;height:20px"></div>
      <div style="width:100px;min-width:300px;height:20px"></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches box-sizing:border-box whose border+padding exceed the declared size (border box floored at its edges)' do
    session = simulated_session(page(<<~HTML))
      <div style="box-sizing:border-box;width:100px;height:20px;border:10px solid;padding:5px">x</div>
      <div style="box-sizing:border-box;width:15px;height:60px;border:10px solid;padding:5px"></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches an over-constrained (left AND right) position:relative child under rtl (§9.4.3: right wins)' do
    session = simulated_session(page(<<~HTML))
      <div style="width:300px;direction:rtl">
        <div style="position:relative;left:10px;right:40px;width:100px;height:20px">a</div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches an rtl block: children start at the inline-start = right edge (r1)' do
    # A narrow fixed-width child sits at content_right - width - margin_right; an auto-width child fills and
    # lands back at content-left; an overflowing child hangs off the LEFT; a nested rtl block reverses too.
    session = simulated_session(page(<<~HTML))
      <div style="width:300px;direction:rtl">
        <div style="width:100px;height:20px;margin-right:20px"></div>
        <div style="height:20px"></div>
        <div style="width:200px;height:30px"><div style="width:80px;height:10px"></div></div>
      </div>
      <div style="width:100px;direction:rtl"><div style="width:300px;height:20px"></div></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  # An out-of-flow (absolute / fixed) child is removed from flow and REPLAYED at the oracle's resolved box
  # (§4.1): native lays out its subtree and positions it by its displacement from the block's border box,
  # neither sizing nor shifting the in-flow siblings. A `sticky` child, an abspos flex/table container, and an
  # abspos subtree native can't lay out still decline.
  def expect_parity(body)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  def expect_bail(body)
    session = simulated_session(page(body)); session.visit '/'
    expect(parity(session)).to include('ok' => false)
  end

  # …and refused by the WALK in particular ('unsupported subtree'), not discovered mid-measure in Rust
  # ('native declined', which throws the whole pass away rather than this one subtree).
  def expect_walk_declines(body)
    session = simulated_session(page(body)); session.visit '/'
    expect(parity(session)).to include('ok' => false, 'reason' => 'unsupported subtree')
  end

  it 'matches an absolute child positioned by insets in a relative parent' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="height:20px">flow</div><div style="position:absolute;top:10px;left:20px;width:50px;height:30px">a</div></div>')
  end
  it 'matches an absolute child whose width comes from left+right insets' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;left:10px;right:40px;top:5px;height:25px">a</div></div>')
  end
  it 'matches an auto-positioned absolute child at its static position' do
    expect_parity('<div style="position:relative;width:300px"><div style="height:20px">x</div><div style="position:absolute;width:60px;height:20px">a</div></div>')
  end
  it 'matches a fixed child, and two absolute children around in-flow content' do
    expect_parity('<div style="width:300px;height:100px"><div style="position:fixed;top:5px;left:5px;width:40px;height:40px">f</div><div style="height:20px">flow</div></div>')
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="height:30px">a</div><div style="position:absolute;top:0;right:0;width:40px;height:40px">b</div><div style="position:absolute;bottom:0;left:0;width:30px;height:30px">c</div><div style="height:20px">d</div></div>')
  end
  it 'matches an absolute child that carries its own block subtree and margins' do
    expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:10px;left:10px;width:100px;height:60px"><div style="height:20px;margin:5px">c</div></div></div>')
  end

  # ANONYMOUS BLOCKS (§9.2.1.1): a block with BOTH inline and block children wraps each maximal run of
  # consecutive inline content in an anonymous block box. Native emits an anonymous text-block record (nid = -1,
  # not compared) per group, interleaved with the real block children in document order, and Rust block flow
  # stacks them — so the block children land where the anonymous blocks' heights push them.
  it 'matches inline text then a block then inline text (two anonymous blocks around a block)' do
    expect_parity('<div style="width:300px">some inline text<div style="height:30px">block</div>more inline text after</div>')
  end
  it 'matches a block, inline text, a block (an anonymous block between two blocks)' do
    expect_parity('<div style="width:300px"><div style="height:20px">A</div>middle inline<div style="height:20px">B</div></div>')
  end
  it 'matches leading and trailing inline runs around blocks' do
    expect_parity('<div style="width:300px">lead<div style="height:20px">x</div>trail</div>')
  end
  it 'matches inline ELEMENTS mixed with blocks (bold/italic in the anonymous runs)' do
    expect_parity('<div style="width:300px">text <b>bold</b> here<div style="height:20px">block</div>after <i>it</i></div>')
  end
  it 'matches a WRAPPING inline run stacked with a block' do
    expect_parity('<div style="width:120px">this inline text wraps across multiple lines here<div style="height:20px">block</div>and more text wrapping too</div>')
  end
  it 'matches a block child with margins between anonymous inline blocks' do
    expect_parity('<div style="width:300px">text before<div style="height:20px;margin:10px 0">block</div>text after</div>')
  end
  it 'matches adjacent block children with collapsing margins amid inline runs' do
    expect_parity('<div style="width:300px">t<div style="height:20px;margin-bottom:8px">B1</div><div style="height:20px;margin-top:12px">B2</div>t2</div>')
  end
  it 'matches a NESTED mixed block (a mixed block inside an anonymous-block sibling chain)' do
    expect_parity('<div style="width:300px">outer<div style="width:200px">inner text<div style="height:15px">deep</div>inner tail</div>outer tail</div>')
  end
  it 'collapses whitespace-only inline content between blocks (no anonymous block)' do
    expect_parity('<div style="width:300px"><div style="height:20px">a</div>   <div style="height:20px">b</div></div>')
  end

  # DECLINES: a float or an out-of-flow child in the mix, or a preserve white-space, are deferred.
  it 'declines a float in a mixed block' do
    expect_bail('<div style="width:300px;overflow:hidden">text<div style="float:left;width:50px;height:20px"></div><div style="height:20px">block</div>more</div>')
  end
  it 'declines an absolutely-positioned child in a mixed block' do
    expect_bail('<div style="position:relative;width:300px">text<div style="position:absolute;top:5px;width:20px;height:20px"></div><div style="height:20px">block</div>more</div>')
  end
  it 'declines a preserve white-space mixed block' do
    expect_bail('<div style="width:300px;white-space:pre">text<div style="height:20px">block</div>more</div>')
  end
  # Whitespace-only direct text between a preserve block's block children is line content (the oracle lays out
  # a line box for it), which a plain block-container record drops — decline (review finding, Phase 2b).
  it 'declines a preserve block container holding whitespace-only text beside its block children' do
    expect_bail(%(<div style="width:300px;white-space:pre-wrap"><div style="height:5px"></div>\n    <div style="height:5px"></div></div>))
    expect_bail(%(<div style="width:300px;white-space:pre">    <div style="height:5px"></div></div>))
  end

  # A text node holding only a no-break space (or another non-CSS space) is CONTENT: it makes a line box the
  # oracle counts, so the walk must not drop it as white space (`String#trim` strips U+00A0).
  it 'matches a block whose only text is a no-break space' do
    expect_parity('<div style="width:300px"><div>&nbsp;</div><div style="height:10px"></div></div>')
  end

  # An intrinsic-size KEYWORD (`min-content` / `max-content` / `fit-content`) sizes a box from its OWN CONTENT,
  # which native measures itself (`block_child_width` asks `intrinsic_widths` for the same figures the oracle's
  # `intrinsicWidths` gives it, each carrying the percentage part of the box's own edges back — a
  # `width: max-content; padding: 0 10%` box around "hello there" is 147.97 in Chrome, not the 67.97 the
  # contribution alone gives). `fit-content` is the room, clamped between the two.
  describe 'an intrinsic-size keyword width sizes a block from its content' do
    it 'lays out min-content, max-content and fit-content' do
      expect_parity('<div style="width:400px"><div style="width:max-content">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="width:min-content">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="width:fit-content">aa bb</div></div>')
      expect_parity('<div style="width:40px"><div style="width:fit-content">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="width:max-content;padding:0 10%">hello there</div></div>')
      expect_parity('<div style="width:400px"><div style="box-sizing:border-box;width:max-content;padding:0 10px;border-left:3px solid">aa bb</div></div>')
      # …and the min/max clamp, the auto-margin centring and rtl all still act on the width it produces
      expect_parity('<div style="width:400px"><div style="width:min-content;min-width:120px">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="width:max-content;max-width:30px">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="width:max-content;margin:0 auto">aa bb</div></div>')
      expect_parity('<div style="width:400px;direction:rtl"><div style="width:max-content">aa bb</div></div>')
    end
    # A KEYWORD box pins its own contribution to one figure (CSS Sizing 3 §5): a `min-content` box asks for the
    # same width whatever room it is offered, so both of an ancestor's figures see that one number. Native
    # ignored the keyword when MEASURING (only when sizing), so a keyword box inside anything measured — a
    # nested keyword, a cell, a flex or grid item, an atomic — was measured unpinned.
    it 'pins its own contribution to the figure the keyword names' do
      %w[max-content min-content fit-content].each do |outer|
        expect_parity(%(<div style="width:400px"><div style="width:#{outer}"><div style="width:min-content">aa bb cc</div></div></div>))
        expect_parity(%(<div style="width:400px"><div style="width:#{outer}"><div style="width:max-content">aa bb cc</div></div></div>))
      end
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0"><div style="width:min-content">aa bb</div></td></tr></table>')
      expect_parity('<div style="display:flex;width:400px"><div><div style="width:min-content">aa bb</div></div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:min-content;width:400px"><div><div style="width:max-content">aa bb</div></div></div>')
      expect_parity('<div style="width:400px"><span style="display:inline-block"><div style="width:min-content">aa bb</div></span></div>')
    end
    # …and it is walked as a MEASURED subtree, like the other route whose width comes from its own content (a
    # vertical writing mode): native has to MEASURE such a box, so what it cannot measure must be refused by the
    # WALK — where the caller can still fall back — and not discovered mid-measure in Rust, which throws the
    # whole pass away. A measure-only gap (native's intrinsic has no `text-indent`) is refused here too.
    it 'refuses in the walk what it would have to measure and cannot' do
      expect_walk_declines('<div style="width:400px"><div style="width:max-content;text-indent:30px">aa bb</div></div>')
      expect_walk_declines('<div style="width:400px"><div style="width:max-content"><span style="display:inline-block"><div style="position:sticky;top:0">s</div></span></div></div>')
      expect_walk_declines('<div style="width:400px"><table><tr><td><div style="width:max-content"><div style="display:grid;grid-template-columns:40px"><div>g</div></div></div></td></tr></table></div>')
    end
    # A keyword on any of the OTHER five size properties is not a width native has to find: the oracle resolves
    # a keyword `height` to `auto` and a keyword min/max to no clamp at all, which the record already says.
    # (That the two engines AGREE there is the contract; that the oracle then differs from Chrome — which
    # clamps `max-width: min-content` to 16 where this leaves 400 — is a conformance gap of its own, written up
    # at `clampToMinMax` in layout.js.)
    it 'lays out a keyword height, min-width and max-width as the oracle resolves them' do
      expect_parity('<div style="width:400px"><div style="height:max-content">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="min-width:max-content">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="max-width:min-content">aa bb</div></div>')
      expect_parity('<div style="width:400px"><div style="max-height:min-content;height:50px">aa bb</div></div>')
    end
    # …and every OTHER sizing path keeps its own basis, so a keyword width declines there: a flex or grid item
    # (sized by its line / track), an out-of-flow box (by its insets), a table cell (by its column), a replaced
    # element (by its intrinsic size — an inline one is pushed as an atomic instead of declining the pass).
    it 'declines a keyword width a different sizing path owns' do
      # …the pass ROOT (sized from the width the harness hands in — native would fill its containing block and
      # report the box as laid out), an out-of-flow box (sized from its insets) and a grid item (from its
      # track). A replaced element is sized by its intrinsic size and declines the same way.
      expect_walk_declines('<div style="display:grid;grid-template-columns:auto;width:400px"><div style="width:max-content">aa bb</div></div>')
      expect_walk_declines('<div style="position:relative;width:400px"><div style="position:absolute;width:max-content">aa bb</div></div>')
      session = simulated_session(page('<div id="r" style="width:max-content">aa bb cc</div>')); session.visit '/'
      expect(parity(session, '#r')).to include('ok' => false, 'reason' => 'unsupported subtree')
      # …and the vertical writing mode's root, which has no inline size to fill either (the same hole)
      session = simulated_session(page('<div id="r" style="writing-mode:vertical-lr;height:100px">aa bb cc</div>')); session.visit '/'
      expect(parity(session, '#r')).to include('ok' => false, 'reason' => 'unsupported subtree')
    end
    # …while a FLEX ITEM and a TABLE CELL carry one natively: their sizing paths ask for the box's intrinsic
    # figures, which the pin has already answered. (A `<td style="width:min-content">` is 16 wide in both
    # engines where Chrome's auto-table algorithm gives the column its max-content, 52.41 — an oracle gap of
    # its own, untouched by this.)
    # A CSS-WIDE keyword resolves to whatever it stands for BEFORE the intrinsic-keyword test, so `width:
    # inherit` under a keyword parent IS a keyword width — and the cheap pre-test that keeps the question off
    # the hot path has to let it through, or the walk marks a box measured that native then measures without
    # the obligations measuring carries (it laid out a `text-indent`ed one at the wrong width, and threw a
    # whole pass away on a sticky child).
    it 'sees a keyword width arriving through inherit' do
      expect_walk_declines('<div style="display:flex;width:400px"><div style="width:min-content"><div style="width:inherit;text-indent:30px">aa bb cc</div></div></div>')
      expect_walk_declines('<table style="border-spacing:0"><tr><td style="padding:0;width:min-content"><div style="width:inherit;text-indent:30px">aa bb cc</div></td></tr></table>')
      expect_walk_declines('<div style="display:flex;width:400px"><div style="width:min-content"><div style="width:inherit"><span style="display:inline-block"><div style="position:sticky;top:0">s</div></span></div></div></div>')
      # …and one with nothing to refuse lays out, the inherited keyword measured like any other
      expect_parity('<div style="width:400px"><div style="width:min-content"><div style="width:inherit">aa bb cc</div></div></div>')
      expect_parity('<div style="width:400px"><span style="width:min-content"><span style="display:inline-block;width:inherit">bb cc</span></span></div>')
    end
    it 'carries a keyword width on a flex item and a table cell' do
      %w[min-content max-content fit-content].each do |kw|
        expect_parity(%(<div style="display:flex;width:400px"><div style="width:#{kw}">aa bb cc</div><div>x</div></div>))
        expect_parity(%(<div style="display:flex;width:60px"><div style="width:#{kw};flex-shrink:1">aa bb cc</div><div>x</div></div>))
        expect_parity(%(<div style="display:flex;flex-direction:column;width:400px;height:200px"><div style="width:#{kw}">aa bb cc</div></div>))
        expect_parity(%(<table style="border-spacing:0"><tr><td style="padding:0;width:#{kw}">aa bb cc</td><td style="padding:0">xx</td></tr></table>))
        expect_parity(%(<table style="border-spacing:0;table-layout:fixed;width:300px"><tr><td style="padding:0;width:#{kw}">aa bb cc</td><td style="padding:0">xx</td></tr></table>))
      end
    end
  end

  # ── Out-of-flow boxes positioned natively ─────────────────────────────────────────────────────────────
  # An absolute / fixed box whose containing block is a record of the pass is sized and placed by native
  # (`place_out_of_flow`, the oracle's placeAbsolute): insets against the CB's padding box, both insets on an
  # axis stretching an auto size (less margins, an auto margin taking the slack), one or none leaving an auto
  # width to shrink to fit and an auto height to its content, the static position where an axis has no inset —
  # the flow cursor in block flow (the content's right edge in rtl), a flex container's alignment, a grid's
  # content origin. A CB that is not a record of the pass — the viewport, an ancestor above it, an inline box —
  # hands over its RECTANGLE instead (rec[92..95]); what still replays is an in-pass CB with percentage edges, or
  # a shrink-to-fit width native cannot measure.
  def expect_native_oof(body, count = 1, root: nil)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session, root)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeOutOfFlow']).to be >= count, "the out-of-flow box was replayed, not placed natively: #{r.inspect}"
  end

  # …and the fallback: the pass still succeeds with the oracle's box REPLAYED over the container's origin.
  def expect_replayed_oof(body)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeOutOfFlow']).to eq(0), "expected the oracle's box to be replayed: #{r.inspect}"
  end

  describe 'native out-of-flow positioning' do
    let(:cb) { 'position:relative;width:400px;height:200px' }

    it 'places by insets, stretches between two, and shares the slack out to auto margins' do
      expect_native_oof(%(<div style="#{cb}"><div style="height:30px">a</div><div style="position:absolute;top:0;right:0;width:40px;height:40px">b</div><div style="position:absolute;bottom:0;left:0;width:30px;height:30px">c</div><div style="height:20px">d</div></div>), 2)
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;inset:0;margin:10px">stretched m</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;left:0;right:0;width:100px;margin:0 auto;height:20px">centred</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:0;bottom:0;height:50px;margin:auto 0;width:20px">v centred</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;left:20px;margin-left:30px;width:20px;height:20px">m</div><div style="position:absolute;right:10px;margin-right:7px;width:20px;height:20px">r</div></div>), 2)
    end
    it 'shrinks an auto width to fit the room, lays an auto height out from the content, anchors a bottom' do
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:10px">shrink to fit text</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:300px">a long piece of text that must wrap in the room left</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;bottom:10px">bottom anchored auto height<br>two lines</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:0;bottom:0"><div style="height:50%">half</div></div></div>))
    end
    it 'measures the containing block as its padding box, and nests containing blocks' do
      expect_native_oof(%(<div style="#{cb};padding:15px;border:3px solid"><div style="position:absolute;top:0;left:0;width:10px;height:10px"></div><div style="position:absolute;bottom:0;right:0;width:10px;height:10px"></div><div style="position:absolute;inset:0"></div></div>), 3)
      expect_native_oof(%(<div style="#{cb}"><div style="position:relative;padding:10px;margin-top:20px"><div style="position:absolute;top:0;right:0;width:10px;height:10px"></div><div style="height:30px">inner cb</div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;inset:0"><div style="position:absolute;bottom:5px;right:5px;width:10px;height:10px"></div></div></div>), 2)
    end
    it 'takes the static position from the flow cursor (before an open margin), the content edge in rtl' do
      expect_native_oof(%(<div style="#{cb}"><div style="height:20px">x</div><div style="position:absolute;width:60px;height:20px">a</div></div>))
      expect_native_oof(%(<div style="#{cb}"><div><div style="height:20px">nested</div><div style="position:absolute;top:5px;width:10px;height:10px"></div><div style="height:20px">after</div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="margin-top:20px;height:20px">m</div><div style="position:absolute;width:10px;height:10px"></div><div style="margin-top:30px;height:20px">n</div></div>))
      expect_native_oof(%(<div style="#{cb};direction:rtl"><div style="position:absolute;width:60px;height:20px">rtl static</div></div>))
    end
    it 'aligns a flex container\'s out-of-flow child as the line\'s sole item, and a grid\'s at the content origin' do
      expect_native_oof(%(<div style="#{cb}"><div style="display:flex;justify-content:center;align-items:center;height:100px"><div style="position:absolute;width:30px;height:20px">fs</div><div style="width:50px;height:20px"></div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="display:flex;justify-content:space-around;align-items:flex-end;height:100px;padding:5px"><div style="position:absolute;width:30px;height:20px;margin:4px">fs</div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="display:flex;flex-direction:column;justify-content:flex-end;height:100px"><div style="position:absolute;width:30px;height:20px;align-self:center">fs</div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="display:flex;flex-direction:row-reverse;height:100px"><div style="position:absolute;width:30px;height:20px">fs</div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="display:grid;grid-template-columns:100px 100px;padding:8px"><div style="height:20px">a</div><div style="position:absolute;width:30px;height:30px">p</div></div></div>))
    end
    it 'sizes a replaced or flex out-of-flow box, and one with min/max and box-sizing' do
      expect_native_oof(%(<div style="#{cb}"><img style="position:absolute;bottom:0;right:0"><input style="position:absolute;left:0;bottom:0"></div>), 2)
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:10px;width:120px"><div style="display:flex"><div style="flex:1">a</div><div>b</div></div></div></div>))
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:10px;min-width:100px;max-height:15px"><div style="height:50px"></div></div><div style="position:absolute;top:50px;box-sizing:border-box;width:50px;padding:10px;height:30px"></div></div>), 2)
      expect_native_oof(%(<div style="#{cb}"><div style="position:absolute;top:50%;left:50%;width:50%;height:25%"></div></div>))
    end
    # Review findings, oracle side (native was the spec-shaped one): a flex container's auto-height out-of-flow
    # child is aligned once it HAS its height, not as a 0-tall box; an rtl column mirrors the cross axis natively;
    # a table cell's vertical-align shift moves its content, not a box anchored to the cell's padding box; a %
    # margin of a flex container's out-of-flow child resolves against the containing block.
    it 'aligns an auto-height out-of-flow flex child by its laid-out height' do
      expect_native_oof('<div style="display:flex;position:relative;width:400px;height:100px;align-items:center"><div style="position:absolute;left:10px">row auto height</div></div>')
      expect_native_oof('<div style="display:flex;position:relative;width:400px;height:100px;align-items:flex-end"><div style="position:absolute;left:10px">row auto height</div></div>')
      expect_native_oof('<div style="display:flex;flex-direction:column;position:relative;width:400px;height:100px;justify-content:flex-end"><div style="position:absolute;left:10px"><div style="height:30px"></div></div></div>')
    end
    it 'mirrors the cross axis of an rtl column for its out-of-flow child' do
      expect_native_oof('<div style="display:flex;flex-direction:column;direction:rtl;position:relative;width:400px;height:100px"><div style="position:absolute;width:30px;height:20px">fs</div></div>')
      expect_native_oof('<div style="display:flex;flex-direction:column;direction:rtl;position:relative;width:400px;height:100px;align-items:flex-end"><div style="position:absolute;width:30px;height:20px;margin:0 5px 0 9px">fs</div></div>')
    end
    it 'keeps a box anchored to a table cell where the cell\'s vertical-align moves only the content' do
      expect_native_oof('<table style="border-spacing:0"><tr><td style="height:100px;width:100px;vertical-align:bottom;position:relative"><div style="height:10px">a</div><div style="position:absolute;top:0;left:0;width:10px;height:10px"></div></td></tr></table>')
      expect_native_oof('<table style="border-spacing:0"><tr><td style="height:50px;width:100px;position:relative;border:3px solid"><div style="height:10px">a</div><div style="position:absolute;top:0;left:0;width:10px;height:10px"></div><div style="position:absolute;width:10px;height:10px"></div></td></tr></table>', 2)
    end
    it 'resolves a % margin of a flex container\'s out-of-flow child against the containing block' do
      expect_native_oof('<div style="display:flex;position:relative;width:400px;padding:50px;height:100px"><div style="position:absolute;margin-left:10%;width:20px;height:20px"></div></div>')
      expect_native_oof('<div style="display:flex;position:relative;width:400px;padding:50px;height:100px;justify-content:center"><div style="position:absolute;margin-left:10%;width:20px;height:20px"></div></div>')
    end
    it 'places both an in-pass and a viewport containing block, and replays what it cannot lay out' do
      # …the `fixed` box included: its containing block is the viewport, whose rectangle rides its record
      session = simulated_session(page('<div style="width:400px"><div style="position:relative;height:100px"><div style="position:absolute;top:10px;left:10px;width:20px;height:20px"></div></div><div style="position:fixed;top:5px;left:5px;width:40px;height:40px"></div></div>')); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 2)
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px;display:grid;grid-template-columns:100px 1fr"><div style="height:10px">a</div><div style="height:20px">b</div></div></div>))); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 0)
    end
  end

  # A block whose own BLOCK axis is the horizontal one (a vertical `writing-mode`) does not fill its containing
  # block: its auto width is a BLOCK size, so the oracle takes it from the box's own content. Native used to
  # fill it, which the harness admitted — a silent 400 where the oracle and Chrome agree on the content's own
  # width. The oracle's model of it is an INLINE-axis shrink-to-fit (max-content clamped to the room), which
  # coincides with Chrome for a single block child; Chrome sums a vertical block's children along the block
  # axis, and rotates the flow, neither of which the oracle does. Parity is what these specs pin.
  describe 'a vertical writing mode shrink-to-fits its width' do
    it 'sizes an auto-width vertical block from its content' do
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-rl"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr;padding:0 10%"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr;margin:0 30px"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr"><div style="width:500px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr;min-width:200px"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr;max-width:20px"><div style="width:40px;height:20px"></div></div></div>')
    end
    it 'leaves a declared width alone, and a horizontal block filling' do
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr;width:50px;height:100px"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px"><div><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="writing-mode:vertical-lr;width:400px;height:200px"><div style="width:40px;height:20px"></div></div>')
    end
    # The shrink-to-fit is a real min/max-content pair, so what fits in the room decides the width — and the
    # mode INHERITS, so a plain child of a vertical block shrink-to-fits as well.
    it 'lets the available room decide, through an inherited writing mode and around its own float' do
      expect_parity('<div style="width:60px"><div style="writing-mode:vertical-lr">hello there everyone</div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr"><div><div style="width:40px;height:20px"></div></div></div></div>')
      expect_parity('<div style="width:400px"><div style="writing-mode:vertical-lr;overflow:hidden"><div style="float:left;width:40px;height:20px"></div></div></div>')
    end
    # Native ASKS such a child's intrinsic widths, so a child it cannot measure has to be refused by the WALK —
    # discovered in Rust it would fail the whole pass instead of this one subtree.
    it 'declines a vertical block holding content native cannot measure' do
      expect_walk_declines('<div style="width:400px"><div style="writing-mode:vertical-lr"><div style="display:grid;grid-template-columns:40px"><div></div></div></div></div>')
      expect_walk_declines('<div style="width:400px"><div style="writing-mode:vertical-lr"><select><option>a</option></select></div></div>')
    end
    # …which is also why such a child is walked as a MEASURED subtree: an atomic inline whose own box would be
    # PUSHED is not in the run stream native measures from, so the walk has to decline where it would otherwise
    # hand Rust a subtree it cannot re-measure. Every shape here lays out natively without the writing mode.
    it 'declines a vertical block whose atomic inline is pushed, not laid out natively' do
      [
        'a <span style="display:inline-block;width:max-content">bb</span>',
        'a <span style="display:inline-block;width:min-content">bb cc</span>',
        'a <span style="display:inline-block;width:fit-content">t<div>x</div></span>',
        'a <span style="display:inline-block"><div style="position:sticky;top:0">s</div></span>',
        'a <span style="display:inline-block"><div style="float:left;width:9px;height:4px"></div>t</span>',
        'a<br>b <span style="display:inline-block;width:max-content">bb</span>'
      ].each do |inner|
        expect_walk_declines(%{<div style="width:400px"><div style="writing-mode:vertical-lr">#{inner}</div></div>})
      end
      # …and through a GRID item, whose subtree is measured for the track sizes
      expect_walk_declines('<div style="display:grid;grid-template-columns:200px;width:400px"><div><div style="writing-mode:vertical-lr">a <span style="display:inline-block;width:max-content">bb</span></div></div></div>')
      # …and the same content in a HORIZONTAL block lays out, the atomic pushed rather than the pass declined.
      expect_parity('<div style="width:400px"><div>a <span style="display:inline-block;width:max-content">bb</span></div></div>')
    end
    # `direction` runs the INLINE axis, which in a vertical mode is the vertical one: an rtl vertical block's
    # children still start at the LEFT content edge, where an rtl HORIZONTAL block's start at the right. Its
    # lines and their atomics, and an out-of-flow child's static corner, stay at the left with them.
    it 'keeps an rtl vertical block placing its children from the left' do
      expect_parity('<div style="width:400px;direction:rtl;writing-mode:vertical-lr"><div style="width:40px;height:20px"></div></div>')
      expect_parity('<div style="width:400px;direction:rtl;writing-mode:vertical-lr"><div style="width:40px;height:20px"></div><div style="width:60px;height:10px"></div></div>')
      expect_parity('<div style="width:400px;direction:rtl;writing-mode:sideways-lr"><div style="width:40px;height:20px"></div></div>')
      expect_parity('<div style="width:400px;direction:rtl"><div style="writing-mode:vertical-lr"><div style="width:40px;height:20px"></div></div></div>')
      expect_parity('<div style="width:400px;direction:rtl"><div style="width:40px;height:20px"></div></div>')
      expect_parity('<div style="width:400px;direction:rtl;writing-mode:vertical-lr">a <span style="display:inline-block;width:20px;height:10px"></span></div>')
      expect_parity('<div style="width:400px;direction:rtl;writing-mode:vertical-lr;position:relative"><div style="position:absolute;width:20px;height:10px"></div></div>')
    end
    # …while what `direction` does key on its own is the MIRROR of a table's columns: the oracle's table path
    # reads `flowSides(table).rtl` alone and mirrors along the PHYSICAL horizontal axis, because it never runs
    # a table sideways (Chrome reverses the columns down its vertical inline axis instead — the oracle's gap to
    # close, not native's). Native reproduces the oracle, so the mirror must not be paired with the axis here.
    it 'still mirrors the columns of an rtl table in a vertical writing mode' do
      expect_parity('<div style="width:400px;direction:rtl;writing-mode:vertical-lr"><table><tr><td>a</td><td>bb</td></tr></table></div>')
      expect_parity('<div style="width:400px;direction:rtl"><table><tr><td>a</td><td>bb</td></tr></table></div>')
    end
  end

  # A containing block is a RECTANGLE wherever it lives. One that is a record of the pass hands native its own
  # box; one OUTSIDE the pass — the viewport of a `fixed` box, an ancestor above the pass root, a
  # relatively-positioned inline — used to make the whole box replay the oracle's resolved geometry. Now the
  # oracle's `containingBlockFor` rectangle rides the record (rec[92..95]) and native sizes and places the box
  # from it exactly as it does for an in-pass containing block. `expect_native_oof` is what pins that: parity
  # alone would pass on the replay too.
  describe 'an out-of-flow box whose containing block is outside the pass' do
    it 'places a fixed box against the viewport itself' do
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:fixed;top:10px;left:20px;width:50px;height:30px">f</div><div style="height:20px">flow</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:fixed;top:0;right:0;width:40px;height:40px">f</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:fixed;bottom:5px;right:5px;width:30px;height:30px">br</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:fixed;inset:0">stretched</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:fixed;left:0;right:0;height:20px;margin:0 auto;width:100px">centred</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:fixed;top:10%;left:25%;width:10%;height:5%">pct</div></div>')
    end
    it 'places an absolute box against the initial containing block' do
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:absolute;top:10px;left:10px;width:50px;height:20px">a</div><div style="height:30px">flow</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:absolute;left:0;right:0;top:0;height:25px">stretch</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:absolute;width:60px;height:20px">staticpos</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:absolute;top:50%;left:50%;width:50px;height:20px">half</div></div>')
      # …its auto width shrink-to-fitting against that rectangle, measured natively
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:absolute;left:30px">shrink to fit me</div></div>')
      expect_native_oof('<div style="width:400px;height:200px"><div style="position:absolute;left:30px"><div style="width:80px;height:10px"></div></div></div>')
    end
    # A containing block AWAY from the origin, above the pass root: the rectangle has to carry its position and
    # its padding box, not just its size — every viewport-rooted shape above would pass on a (0,0) rect.
    it 'places against a containing block above the pass root' do
      outer = 'position:relative;margin:30px 0 0 40px;border:5px solid;padding:10px;width:300px;height:200px'
      expect_native_oof(%{<div style="#{outer}"><div id="sub" style="height:50px"><div style="position:absolute;bottom:0;right:0;width:20px;height:10px"></div></div></div>}, root: '#sub')
      expect_native_oof(%{<div style="#{outer}"><div id="sub" style="height:50px"><div style="position:absolute;top:50%;left:50%;width:20px;height:10px"></div></div></div>}, root: '#sub')
      # …and one that is not the viewport and not a record either: a transformed ancestor contains a FIXED box
      expect_native_oof(%{<div style="transform:translate(10px,20px);border:3px solid;width:300px;height:200px"><div id="sub" style="height:50px"><div style="position:fixed;top:10px;left:30px;width:20px;height:10px"></div></div></div>}, root: '#sub')
    end
    # …the one containing block that is INSIDE the pass and still has no record of its own: a relatively
    # positioned inline, whose rectangle is the oracle's line layout (a pushed input, finer than the old replay).
    it 'places against a relatively positioned inline' do
      expect_native_oof('<div style="width:400px">t <span style="position:relative">a<span style="display:inline-block;width:30px;height:10px"><span style="position:absolute;top:1px;left:2px;width:20px;height:10px"></span></span></span></div>')
    end
    # …and one at its STATIC position inside an inline-block inside an inline box, which is the shape that
    # showed the oracle holding a stale static position: the atomic is laid out at the line's provisional y and
    # the baseline settle moves it afterwards, so the held position has to move with it (Chrome puts the box at
    # the atomic's own content origin, y = 30 on a 48px line, not at the block's top).
    it 'places one at its static position inside an atomic inline' do
      expect_native_oof('<div style="width:400px;font-size:48px">Big <span>x<span style="display:inline-block;font-size:12px;width:60px;height:14px"><div style="position:absolute;width:10px;height:10px"></div></span></span></div>')
      expect_native_oof('<div style="width:300px">t <span>a<span style="display:inline-block;width:30px;height:10px"><div style="position:fixed;width:5px;height:5px"></div></span></span></div>')
      expect_native_oof('<div style="width:300px">t <span style="position:relative">a<span style="display:inline-block;width:30px;height:10px"><div style="position:absolute;width:5px;height:5px"></div></span></span></div>')
    end
    # …and where native cannot measure such a box's shrink-to-fit content, the oracle's box is still replayed
    # rather than the pass being declined.
    it 'replays one whose content native cannot measure' do
      expect_replayed_oof(%{<div style="width:400px;height:200px"><div style="position:absolute;left:30px">a <span style="display:inline-block;width:max-content">bb</span></div></div>})
    end
    # The walk marshals the containing block the PLACEMENT resolved (`_lb.cbEl`), never its own re-derivation:
    # `containingBlockElementFor` skips an ancestor whose box did not exist yet when the placement ran, so a
    # positioned `<html>` reads as the viewport there and as the root here. Reading the stamp is what keeps the
    # record and the geometry it is marshalling from being about two different boxes.
    it 'measures against the containing block the placement resolved, not a fresh one' do
      expect_native_oof('<style>html{position:relative}</style><div style="height:200px"><div style="position:absolute;bottom:0;left:0;width:40px;height:20px"></div></div>')
      expect_native_oof('<style>html{position:relative;padding:20px;height:400px}</style><div style="height:200px"><div style="position:absolute;top:50%;left:0;width:40px;height:20px"></div></div>')
      expect_native_oof('<style>html{transform:translateZ(0)}</style><div style="height:2000px"><div style="position:fixed;bottom:0;width:40px;height:20px"></div></div>')
      expect_native_oof('<style>html{filter:invert(1)}</style><div style="height:2000px"><div style="position:fixed;bottom:0;width:40px;height:20px"></div></div>')
    end
  end

  # An out-of-flow box is in NO ancestor's intrinsic contribution: a contribution skips an out-of-flow child
  # outright, and the box is in no run stream. So walking one LEAVES the measured region — whatever native
  # cannot MEASURE inside it is nobody's problem, because nobody measures it. Before this, the flag was
  # inherited and a pushed atomic inline inside an absolute box declined the whole pass.
  describe 'an out-of-flow box leaves the measured region' do
    pushed_atomic = 'a <span style="display:inline-block;width:max-content">bb</span>'
    it 'lays out an absolute box whose content native cannot measure, inside a subtree it does measure' do
      # …its box replayed, because its containing block is outside the pass — and the same as a `fixed` box
      expect_replayed_oof(%{<div style="width:400px"><div style="writing-mode:vertical-lr"><div style="position:absolute">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      expect_replayed_oof(%{<div style="width:400px"><div style="writing-mode:vertical-lr"><div style="position:fixed;top:0;left:0">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      # …and sized and placed by NATIVE itself, from both insets, from a declared width, or from a percentage
      # one (whose figure `used_width` takes from the record, so no intrinsic measure is asked at all)
      expect_native_oof(%{<div style="width:400px"><div style="writing-mode:vertical-lr;position:relative"><div style="position:absolute;left:0;right:0">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      expect_native_oof(%{<div style="width:400px"><div style="writing-mode:vertical-lr;position:relative"><div style="position:absolute;width:60px">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      expect_native_oof(%{<div style="width:400px"><div style="writing-mode:vertical-lr;position:relative"><div style="position:absolute;width:50%">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      expect_native_oof(%{<div style="width:400px;position:relative"><div style="position:absolute;width:calc(50% + 10px)">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div>})
    end
    # …and the other routes walked measured reach it too: an atomic inline, a flex item, a table cell, a grid
    # item. (Through a pure BLOCK child, because a text block holding an out-of-flow child declines outright.)
    it 'lays one out inside every other measured route' do
      oof = %{<div style="width:30px"><div style="position:absolute;width:60px">#{pushed_atomic}</div></div>}
      expect_native_oof(%{<div style="width:400px">x <span style="display:inline-block;position:relative">#{oof}</span></div>})
      expect_native_oof(%{<div style="width:400px;display:flex"><div style="position:relative">#{oof}</div></div>})
      expect_native_oof(%{<table style="border-spacing:0"><tr><td style="padding:0;position:relative">#{oof}</td></tr></table>})
      expect_native_oof(%{<div style="display:grid;grid-template-columns:auto;width:400px"><div style="position:relative">#{oof}</div></div>})
    end
    # An out-of-flow box whose OWN width IS a shrink-to-fit needs an intrinsic measure of its content, so where
    # native cannot measure that content the box keeps the oracle's box — the pass is not declined for it. WHICH
    # it is, the WALK decides: a subtree it refuses under the measuring obligation is rolled back and the box is
    # replayed, so content the predicate cannot judge (a `text-indent`ed atomic, a sticky child) lands here too.
    it 'replays a shrink-to-fit box whose own content native cannot measure' do
      expect_replayed_oof(%{<div style="width:400px;position:relative"><div style="writing-mode:vertical-lr"><div style="position:absolute;left:0">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      expect_replayed_oof(%{<div style="width:400px;position:relative"><div style="writing-mode:vertical-lr"><div style="position:absolute">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      [
        '<span style="display:inline-block;width:fit-content">t<div>x</div></span>',
        '<span style="display:inline-block"><div style="position:sticky;top:0">s</div></span>',
        '<span style="display:inline-block;width:max-content">bb</span>'
      ].each do |inner|
        expect_replayed_oof(%{<div style="width:400px;position:relative"><div style="position:absolute;left:0">a #{inner}</div><p>x</p></div>})
      end
      # …while one it CAN measure is still sized and placed natively
      expect_native_oof(%{<div style="width:400px;position:relative"><div style="position:absolute;left:0">a <span style="display:inline-block">ok</span></div><p>x</p></div>})
    end
  end

  # A `<td>` whose content native cannot lay out itself pushes its own width CONTRIBUTION (rec[84..85]) and the
  # table is laid out around it. That needs `nlIntrinsicMeasurable` to answer what the walk will actually DO:
  # while it ignored the walk's own refusal of an intrinsic-size keyword, such an inline-block in a cell was
  # called measurable, the cell was walked measured, and the atomic inside then declined the whole table.
  describe 'a cell whose content native cannot lay out pushes its contribution' do
    it 'lays out a table around a cell holding a keyword-sized inline-block' do
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0">a <span style="display:inline-block;width:max-content">bb</span></td><td style="padding:0">cc</td></tr></table>})
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0">a <span style="display:inline-block;width:max-content">bb</span></td></tr></table>})
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0;width:50px">a <span style="display:inline-block;width:max-content">bb</span></td></tr></table>})
      expect_parity(%{<div style="display:table;border-spacing:0"><div style="display:table-row"><div style="display:table-cell">a <span style="display:inline-block;width:max-content">bb</span></div></div></div>})
    end
  end

  # A box that establishes an INDEPENDENT FORMATTING CONTEXT does all three things at once: it owns its floats,
  # it avoids its parent's, and its children's margins stay inside it. `contain: layout|paint|content|strict`
  # and a multi-column box are such contexts (css-contain-2 §2.1, css-multicol-1 §2) — this engine read them as
  # margin-only, which made the walk decline them AND left the engine contradicting itself: `subtreeHasFloat`
  # believed a `contain` box held its floats while the layout let them escape, and the escaped float then ate a
  # later sibling's clearance margin (Chrome puts that sibling at 80, the oracle answered 50).
  describe 'a box that establishes its own formatting context' do
    it 'keeps a child margin inside contain and multicol' do
      %w[layout paint content].each do |kind|
        expect_parity(%(<div style="width:400px"><div style="contain:#{kind}"><div style="margin-top:30px;height:10px"></div></div><div style="height:5px"></div></div>))
      end
      expect_parity('<div style="width:400px"><div style="contain:strict;height:40px"><div style="margin-top:30px;height:10px"></div></div><div style="height:5px"></div></div>')
      expect_parity('<div style="width:400px"><div style="column-count:2"><div style="margin-top:30px;height:10px"></div></div><div style="height:5px"></div></div>')
      expect_parity('<div style="width:400px"><div style="column-width:100px"><div style="margin-top:30px;height:10px"></div></div><div style="height:5px"></div></div>')
      # …its own margins collapse with its neighbours' as any block's do, and an EMPTY one does not collapse
      # through (a BFC root never does)
      expect_parity('<div style="width:400px"><div style="contain:layout;margin-top:20px"><div style="margin-top:30px;height:10px"></div></div></div>')
      expect_parity('<div style="width:400px"><div style="contain:layout;margin:20px 0"></div><div style="margin-top:30px;height:10px"></div></div>')
      expect_parity('<div style="width:400px"><div style="contain:paint;margin-bottom:20px"><div style="margin-bottom:30px;height:10px"></div></div><div style="height:5px"></div></div>')
    end
    # …and it OWNS the floats inside it, which is the half this engine used to get wrong: the box is as tall as
    # its float, and a later `clear` sibling clears past the float's bottom rather than past nothing.
    it 'owns a float inside it, and its height' do
      expect_parity('<div style="width:400px"><div style="contain:layout"><div style="float:left;width:50px;height:50px"></div></div><div style="height:5px"></div></div>')
      expect_parity('<div style="width:400px"><div style="contain:layout"><div style="float:left;width:50px;height:50px"></div></div><div style="clear:left;margin-top:30px;height:5px"></div></div>')
      expect_parity('<div style="width:400px"><div style="column-count:2"><div style="float:left;width:50px;height:50px"></div></div><div style="height:5px"></div></div>')
    end
  end

  # A first child that COLLAPSES THROUGH an open top edge leaves its run in the PARENT's top margin — and only
  # there. Native also left it pushing the next sibling, counting it twice: `<div style="margin:20px 0">` then
  # `<div style="margin:15px 0">` put the second box at 40 where Chrome and the oracle say 20, and the block's
  # own height grew with it. The next sibling is still the FIRST whose top margin joins the parent's, which is
  # what the oracle's `topOnly` loop does by construction.
  it 'hoists a collapse-through first child once, not twice' do
    expect_parity('<div style="width:400px"><div style="margin:20px 0"></div><div style="margin:15px 0"></div><div style="height:5px"></div></div>')
    expect_parity('<div style="width:400px"><div style="margin:20px 0"></div><div style="margin-top:15px;height:5px"></div></div>')
    expect_parity('<div style="width:400px"><div style="margin:20px 0"></div><div style="margin:10px 0"></div><div style="margin:30px 0"></div><div style="height:5px"></div></div>')
    # …a closed top edge keeps the run inside, where it pushes the next sibling as any margin does
    expect_parity('<div style="width:400px;padding-top:1px"><div style="margin:20px 0"></div><div style="margin:15px 0"></div><div style="height:5px"></div></div>')
    expect_parity('<div style="width:400px"><div style="margin:20px 0;height:5px"></div><div style="margin:15px 0"></div><div style="height:5px"></div></div>')
  end

  # …and where such a run comes to a NEGATIVE number the flow ends ABOVE the content top, which floors the
  # CONTENT height at zero and leaves the box's own padding taking its room: a `padding-top: 1px` wrapper is
  # 1 tall (Chrome-measured), where flooring the BORDER box instead made native answer 0.
  it 'floors the content height, not the border box, under a negative collapse-through run' do
    expect_parity('<div style="width:400px;padding-top:1px"><div style="margin-top:-30px;margin-bottom:10px"></div><div style="height:5px"></div></div>')
    expect_parity('<div style="width:400px;padding-top:1px;padding-bottom:2px"><div style="margin-top:-30px;margin-bottom:10px"></div><div style="height:5px"></div></div>')
    expect_parity('<div style="width:400px;border-top:3px solid"><div style="margin-top:-30px;margin-bottom:10px"></div><div style="height:5px"></div></div>')
    expect_parity('<div style="width:400px;padding-top:1px"><div style="margin-top:-40px"></div></div>')
    # …and with an OPEN top edge the run leaves the box entirely, which is zero tall either way
    expect_parity('<div style="width:400px"><div style="margin-top:-30px;margin-bottom:10px"></div><div style="height:5px"></div></div>')
  end

  # Whether a height separates two margins is decided by the DECLARATION, and a CSS-wide keyword is not one:
  # `height: inherit` is the parent's height (80, and no collapse-through), `initial` / `unset` / `revert`
  # stand for `auto`. Native reads that decision off rec[25]/rec[26], so the oracle taking `inherit` for auto
  # showed up here as a MISMATCH — native and Chrome said 80, the oracle 0.
  it 'reads a CSS-wide height keyword as the value it stands for' do
    expect_parity('<div style="width:400px;height:80px"><div style="height:inherit"></div></div>')
    expect_parity('<div style="width:400px;height:80px"><div style="min-height:inherit"></div></div>')
    expect_parity('<div style="width:400px"><div style="height:inherit"><div style="margin:20px 0"></div></div><div style="height:5px"></div></div>')
    %w[initial unset revert].each do |kw|
      expect_parity(%(<div style="width:400px;height:80px"><div style="height:#{kw}"><div style="margin:20px 0"></div></div></div>))
    end
  end

  # §8.3.1's BOTTOM rule wants an AUTO height where the collapse-THROUGH rule wants "auto or zero": a
  # `height: 0` box collapses through and still keeps its last child's bottom margin in. Native had that
  # right from its own structure (it only propagates a bottom margin out of an auto-height box) while the
  # oracle read one rule for both, so this was a MISMATCH rather than a decline — rec[65] bit 14 carries the
  # bottom rule's own answer now.
  it 'keeps a last child bottom margin inside a box with a declared height' do
    %w[0 0px 1px auto min-content max-content fit-content].each do |h|
      expect_parity(%(<div style="width:400px;overflow:hidden"><div style="height:#{h}">) +
                    '<div style="margin-bottom:12px;height:5px"></div></div></div>')
    end
    # …the same box still hands its child's TOP margin up, and still collapses through when it is empty
    expect_parity('<div style="width:400px;overflow:hidden"><div style="height:0">' \
                  '<div style="margin-top:12px;height:5px"></div></div></div>')
    expect_parity('<div style="width:400px"><div style="margin:20px 0"><div style="height:0"></div></div>' \
                  '<div style="height:5px"></div></div>')
    # …and the USED height is what answers: a percentage against an INDEFINITE block is auto and lets the
    # margin out, against a definite one it is a height and keeps it in.
    %w[0% 50% 100% calc(50%)].each do |h|
      expect_parity(%(<div style="width:400px;overflow:hidden"><div style="height:#{h}">) +
                    '<div style="margin-bottom:12px;height:5px"></div></div></div>')
      expect_parity(%(<div style="width:400px;overflow:hidden;height:40px"><div style="height:#{h}">) +
                    '<div style="margin-bottom:12px;height:5px"></div></div></div>')
      # …and where it shows: the SIBLING after the box, which the kept-in margin must not move
      expect_parity(%(<div style="width:400px;height:60px"><div style="height:#{h}">) +
                    '<div style="margin-bottom:12px;height:5px"></div></div><div style="height:5px"></div></div>')
    end
  end

  # CSS 2.1 §10.3.3: the width a block does not take goes to whichever horizontal margins are `auto` — both,
  # and the box is centred; one, and it is pushed to the other side. `margin: 0 auto` is how half the pages on
  # the web centre their shell, so until native did it, none of them laid out natively at all.
  describe 'auto horizontal margins place a block in its containing block' do
    it 'centres a block with both margins auto, and pushes one with a single auto' do
      expect_parity('<div style="width:400px"><div style="width:100px;height:10px;margin:0 auto"></div></div>')
      expect_parity('<div style="width:400px"><div style="width:100px;height:10px;margin-left:auto"></div></div>')
      expect_parity('<div style="width:400px"><div style="width:100px;height:10px;margin-right:auto"></div></div>')
      expect_parity('<div style="width:400px"><div style="width:100px;height:10px;margin:0 auto 0 20px"></div></div>')
      # …and a text block, whose lines are laid out around the placement
      expect_parity('<div style="width:400px"><div style="width:100px;margin:0 auto">text that wraps here</div></div>')
    end
    # An AUTO width leaves nothing over (§10.3.3 resolves the margins to 0 first), and an over-constrained box
    # balances on its TRAILING margin — Chrome puts `width:600px; margin:0 auto` in 400px flush at x=0.
    it 'leaves an auto-width box alone and hangs an over-constrained one off the leading edge' do
      expect_parity('<div style="width:400px"><div style="height:10px;margin:0 auto"></div></div>')
      expect_parity('<div style="width:400px"><div style="width:600px;height:10px;margin:0 auto"></div></div>')
      expect_parity('<div style="width:400px"><div style="width:600px;height:10px;margin-left:auto"></div></div>')
    end
    # …on the FLOW's own axis: an `rtl` containing block balances on `margin-left`, so the same over-constrained
    # box hangs 200px off the LEFT (Chrome: x = -200).
    it 'balances on the leading margin of the flow, which rtl reverses' do
      expect_parity('<div style="width:400px;direction:rtl"><div style="width:100px;height:10px;margin:0 auto"></div></div>')
      expect_parity('<div style="width:400px;direction:rtl"><div style="width:600px;height:10px;margin:0 auto"></div></div>')
      expect_parity('<div style="width:400px;direction:rtl"><div style="width:100px;height:10px;margin-left:auto"></div></div>')
    end
    # A FLOAT computes its auto margins to ZERO instead (§10.3.5), and an atomic inline is placed on its line
    # by the line box, not by its margins — both must keep laying out the way they did.
    it 'gives a float and an atomic inline no slack' do
      expect_parity('<div style="overflow:hidden;width:400px"><div style="float:left;width:100px;height:10px;margin:0 auto"></div></div>')
      expect_parity('<div style="width:400px">t <span style="display:inline-block;width:50px;height:10px;margin:0 auto"></span> u</div>')
      expect_parity('<div style="width:400px"><span style="display:inline-block;width:200px"><div style="width:50px;height:10px;margin:0 auto"></div></span></div>')
    end
    # The block flow places a child in FOUR places — the ordinary one, a text block, a box that establishes a
    # BFC beside a float, and one CLEARED past the floats — and §10.3.3 belongs to all of them. Native shared
    # the rule between three and left the cleared one placing by hand (Chrome centres it at 150, native had it
    # at 0): a review found it, because no spec here had ever put an auto margin in a float context.
    it 'places a cleared, a BFC and a text-block child by the same rule' do
      float = '<div style="float:left;width:50px;height:20px"></div>'
      expect_parity(%{<div style="overflow:hidden;width:400px">#{float}<div style="clear:left;width:100px;height:10px;margin:0 auto"></div></div>})
      expect_parity(%{<div style="overflow:hidden;width:400px">#{float}<div style="clear:left;width:100px;height:10px;margin-left:auto"></div></div>})
      expect_parity(%{<div align="center" style="overflow:hidden;width:400px">#{float}<div style="clear:left;width:100px;height:10px"></div></div>})
      expect_parity(%{<div style="overflow:hidden;width:400px">#{float}<div style="overflow:hidden;width:100px;height:10px;margin:0 auto"></div></div>})
      expect_parity(%{<div style="overflow:hidden;width:400px">#{float}<div style="width:100px;margin:0 auto">text</div></div>})
    end
    # HTML's legacy alignment moves a narrower block-level DESCENDANT the same way `margin: auto` would —
    # `<center>` and the `align` attribute, still all over old app markup. Native laid these out at the start
    # edge and only the parity harness saw it (the walk had no gate for them at all).
    it 'moves a block the way <center> and an align attribute do' do
      expect_parity('<center><div style="width:100px;height:10px"></div></center>')
      expect_parity('<div align="center" style="width:400px"><div style="width:100px;height:10px"></div></div>')
      expect_parity('<div align="right" style="width:400px"><div style="width:100px;height:10px"></div></div>')
      expect_parity('<div align="left" style="width:400px;direction:rtl"><div style="width:100px;height:10px"></div></div>')
      expect_parity('<div align="center" style="width:400px;direction:rtl"><div style="width:100px;height:10px"></div></div>')
      # …and the two combinations that move NOTHING, because the box already starts at that end
      expect_parity('<div align="right" style="width:400px;direction:rtl"><div style="width:100px;height:10px"></div></div>')
      expect_parity('<div align="left" style="width:400px"><div style="width:100px;height:10px"></div></div>')
      # …a VERTICAL-only auto margin distributes nothing across, so the legacy shift still applies through it
      # (Chrome: 150. The oracle read any auto margin as "this box distributes" and left it at 0.)
      expect_parity('<div align="center" style="width:400px"><div style="width:100px;height:10px;margin-top:auto"></div></div>')
      expect_parity('<div align="center" style="width:400px"><div style="width:100px;height:10px;margin-bottom:auto"></div></div>')
      # …and an auto margin wins over it: the box distributes, and the legacy shift is not applied on top.
      expect_parity('<div align="center" style="width:400px"><div style="width:100px;height:10px;margin-left:auto"></div></div>')
      # …it reaches a DESCENDANT, not just a child (the attribute is inherited down the flow).
      expect_parity('<div align="center" style="width:400px"><div><div style="width:100px;height:10px"></div></div></div>')
    end
  end

  # A BORDER box is never smaller than the border and padding inside it, and that floor comes AFTER the
  # min/max clamp (`usedSize`): a `max-width` below the box's own edges clamps the width under them and the
  # floor lifts it back (Chrome gives `box-sizing: border-box; padding: 0 10px; max-width: 5px` a width of 20).
  describe "a border box's edges floor its width after the min/max clamp" do
    it 'floors a width a max-width clamped below the box edges' do
      expect_parity('<div style="width:400px"><div style="box-sizing:border-box;padding:0 10px;max-width:5px">x</div></div>')
      expect_parity('<div style="width:400px"><div style="box-sizing:border-box;padding:40px;max-width:30px">x</div></div>')
      expect_parity('<div style="width:400px"><div style="box-sizing:border-box;border:3px solid;padding:0 10px;max-width:8px;min-width:4px">x</div></div>')
      expect_parity('<div style="width:400px"><div style="box-sizing:border-box;padding:0 10px;width:100px;max-width:5px">x</div></div>')
      expect_parity('<div style="width:400px"><div style="box-sizing:border-box;padding:0 10px;max-width:5px;writing-mode:vertical-lr"><div style="width:40px;height:20px"></div></div></div>')
    end
  end
end
