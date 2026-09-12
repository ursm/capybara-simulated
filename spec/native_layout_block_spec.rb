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

  def parity(session)
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
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

  # An intrinsic-size KEYWORD (`min-content` / `max-content` / `fit-content`) sizes a box from its content; the
  # record can only carry `auto`, which would fill the containing block instead — so the walk declines it, on
  # a size and on a min/max alike. (A plain declared length keeps laying out natively.)
  it 'declines a block whose width is an intrinsic-size keyword' do
    expect_bail('<div style="width:min-content;height:10px">keyword width here</div>')
    expect_bail('<div style="width:600px"><div style="width:max-content;height:10px">keyword width here</div></div>')
    expect_bail('<div style="width:fit-content;height:10px">keyword width here</div>')
  end
  it 'declines a block whose min-width or max-width is an intrinsic-size keyword' do
    expect_bail('<div style="width:20px;min-width:max-content;height:10px">keyword width here</div>')
    expect_bail('<div style="max-width:min-content;height:10px">keyword width here</div>')
  end

  # ── Out-of-flow boxes positioned natively ─────────────────────────────────────────────────────────────
  # An absolute / fixed box whose containing block is a record of the pass is sized and placed by native
  # (`place_out_of_flow`, the oracle's placeAbsolute): insets against the CB's padding box, both insets on an
  # axis stretching an auto size (less margins, an auto margin taking the slack), one or none leaving an auto
  # width to shrink to fit and an auto height to its content, the static position where an axis has no inset —
  # the flow cursor in block flow (the content's right edge in rtl), a flex container's alignment, a grid's
  # content origin. A CB outside the pass (the viewport, an inline box) still replays the oracle's box.
  def expect_native_oof(body, count = 1)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeOutOfFlow']).to be >= count, "the out-of-flow box was replayed, not placed natively: #{r.inspect}"
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
    it 'replays a box whose containing block lies outside the pass, or whose shrink-to-fit width native cannot measure' do
      session = simulated_session(page('<div style="width:400px"><div style="position:relative;height:100px"><div style="position:absolute;top:10px;left:10px;width:20px;height:20px"></div></div><div style="position:fixed;top:5px;left:5px;width:40px;height:40px"></div></div>')); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 1)
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px;display:grid;grid-template-columns:100px 1fr"><div style="height:10px">a</div><div style="height:20px">b</div></div></div>))); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 0)
    end
  end
end
