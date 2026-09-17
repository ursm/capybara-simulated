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
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # The pass root defaults to `<body>`; naming a SELECTOR runs the pass over that subtree instead, which is how
  # a containing block ABOVE the root — the case a viewport-origin page cannot exercise — gets tested.
  def parity(session, root = nil)
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    return session.evaluate_script('globalThis.__csimLayoutShadowRun()') unless root
    session.evaluate_script(%{globalThis.__csimLayoutShadowRun(document.querySelector(#{root.inspect}))})
  end

  # The BODY with its own margin and padding. Every other example here — and every sweep and corpus page — says
  # `margin: 0` on the body, which is exactly how the native pass taking the body's margins off TWICE went
  # unseen while being a mismatch on nearly every real page: the oracle handed the body's OWN width as the
  # root's containing block (a `layoutElement` call with no `cbW` defaults to the box's width), and native
  # subtracted the margins from it again — 992 where the oracle and Chrome say 1008 under the UA's 8px. The
  # same missing `cbW` resolved the body's percentage padding against the body's width: `padding: 0 10%` in an
  # 800px viewport put the content at 96 where Chrome puts it at 100. And the body kept a sizing path of its
  # own — declared width, and a margin read that fell back to 8px for whatever it could not resolve — so
  # `margin: 0 auto` was 1008 wide where native and Chrome say 1024, and `max-width` / `min-width` were
  # ignored. It is sized like any block in flow now.
  it 'lays out the body against the root, under the UA margin and its own' do
    ['', ' style="margin:20px"', ' style="margin:20px;padding:0 10%"', ' style="margin:0 5%"',
     ' style="margin:0 auto"', ' style="max-width:600px;margin:0 auto"', ' style="margin:0 5%;max-width:500px"',
     ' style="min-width:1200px"', ' style="margin-left:auto"'].each do |attr|
      html = %(<!doctype html><html><head><meta charset="utf-8"></head><body#{attr}><div id="d" style="margin:0 7px">x</div><p>p</p></body></html>)
      session = simulated_session(Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app)
      session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true), "#{attr}: harness bailed: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "#{attr}: mismatch: #{r.inspect}"
    end
    # …and the percentage padding resolves against the viewport-wide root, as Chrome's does
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:20px;padding:0 10%"><div id="d">x</div></body></html>)
    session = simulated_session(Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app)
    session.current_window.resize_to(800, 600)
    session.visit '/'
    expect(session.evaluate_script("(() => { const r = document.getElementById('d').getBoundingClientRect(); return [r.x, r.width]; })()"))
      .to eq([100, 600])
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
  # neither sizing nor shifting the in-flow siblings. An abspos TABLE container and an
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

  # A FLOAT in the mix joins the anonymous group it is written in, as a marker on that group's lines — on the line
  # it interrupts, or where the group's first line starts — and one in a group that collapses to nothing (white
  # space and floats between two blocks) goes where that line would have started, as a float child of the block.
  # (A float native never placed has no record to compare, so those shapes put an atomic on the line after it.)
  it 'matches a float in a mixed block' do
    expect_parity('<div style="width:300px;overflow:hidden">text<div style="float:left;width:50px;height:20px"></div><div style="height:20px">block</div>more</div>')
    expect_parity('<div style="width:300px">text <span style="float:right;width:50px;height:30px"></span>more<p>b</p>after</div>')
    expect_parity('<div style="width:300px"><p>a</p><span>x <span style="float:left;width:40%;height:15px"></span>y</span><p>b</p></div>')
    expect_parity('<div style="width:300px"><p style="margin:10px 0">a</p> <div style="float:left;width:50px;height:30px"></div> <p style="margin:10px 0"><i style="display:inline-block;width:5px;height:5px"></i>b</p>tail</div>')
    expect_parity('<div style="width:300px"><p>a</p> <span style="position:relative;left:6px"><span style="float:left;width:20px;height:20px"></span></span> <p><i style="display:inline-block;width:5px;height:5px"></i>b</p></div>')
    # …its percentages against the MIXED block, not the anonymous group it sits in (Chrome: 100 tall, 100 wide)
    expect_parity('<div style="width:300px;height:200px"><p style="margin:0">a</p>x<span style="float:left;width:20px;height:50%"></span>y</div>')
    expect_parity('<div style="writing-mode:vertical-lr;height:300px;width:200px"><p style="margin:0">a</p>x<span style="float:left;width:50%;height:20px;margin-left:10%"></span>y</div>')
  end

  # DECLINES: an out-of-flow child in the mix, or a preserve white-space, are deferred.
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
      expect_walk_declines('<div style="width:400px"><div style="width:max-content"><span style="display:inline-block"><span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">c</span></span></span></span></div></div>')
      expect_walk_declines('<div style="width:400px"><table><tr><td><div style="width:max-content"><div style="display:grid;grid-template-columns:40px"><span>g</span><span>h</span></div></div></td></tr></table></div>')
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
    # whole pass away on a subtree it cannot measure).
    it 'sees a keyword width arriving through inherit' do
      expect_walk_declines('<div style="display:flex;width:400px"><div style="width:min-content"><div style="width:inherit;text-indent:30px">aa bb cc</div></div></div>')
      expect_walk_declines('<table style="border-spacing:0"><tr><td style="padding:0;width:min-content"><div style="width:inherit;text-indent:30px">aa bb cc</div></td></tr></table>')
      expect_walk_declines('<div style="display:flex;width:400px"><div style="width:min-content"><div style="width:inherit"><span style="display:inline-block"><span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">c</span></span></span></span></div></div></div>')
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
    expect(r['compared']).to be > 0, "nothing was compared: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeOutOfFlow']).to be >= count, "the out-of-flow box was replayed, not placed natively: #{r.inspect}"
  end

  # …and the fallback: the pass still succeeds with the oracle's box REPLAYED over the container's origin.
  def expect_replayed_oof(body)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['compared']).to be > 0, "nothing was compared: #{r.inspect}"
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
    # An ALIGNED static position computed from the CONTAINER's box — a flex container's, which knows nothing
    # about the relative inlines the container sits in — takes their §9.4.3 offset; one that hands an axis back
    # off the static position (an rtl corner's block axis) must not, or it lands twice. Both go through
    # `placeAbsolute`'s deferred path, so one wrapper decides it for both: the corner answers `null` for the
    # axis it does not speak for. (Measured in Chrome: y = 25, which is the answer this pins.)
    it 'shifts a flex container\'s aligned static position by the relative inlines around it' do
      session = simulated_session(page('<div style="width:200px;font:16px monospace"><span style="position:relative;top:10px">a<span style="display:inline-block"><div style="display:flex;width:50px;height:20px;align-items:flex-end"><i style="position:absolute;width:5px;height:5px"></i></div></span></span></div>'))
      session.visit '/'
      expect(parity(session)).to include('ok' => true, 'mismatches' => 0)
    end
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
      # …and an abspos GRID is native's own now: its shrink-to-fit width is an intrinsic measure, which native
      # answers for a grid whose items are blocks (as a block, which is what the oracle does with one). One
      # holding INLINE-LEVEL content still replays — there the oracle walks a pen the records cannot reproduce.
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px;display:grid;grid-template-columns:100px 1fr"><div style="height:10px">a</div><div style="height:20px">b</div></div></div>))); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 1)
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px;display:grid;grid-template-columns:100px 1fr"><span>a</span><span>b</span></div></div>))); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 0)
    end

    # ── The static position ON A LINE ───────────────────────────────────────────────────────────────────
    # An out-of-flow child of a TEXT block is not content the flow skips: where the flow had REACHED it is a
    # position on a line — the inline offset, the line's alignment applied, and that line's top. It rides the
    # run stream as a marker (RUN_OOF) that neither sizes nor shifts the line, and the line layout settles it
    # at the same close that settles the line's atomic inlines.
    describe 'a static position taken off a line' do
      let(:tb) { 'position:relative;width:200px;font:16px monospace' }
      let(:mark) { '<div style="position:absolute;width:10px;height:10px"></div>' }

      it 'reads the inline offset, the line it fell on, and the line\'s alignment' do
        expect_native_oof(%(<div style="#{tb}">hello #{mark}</div>))
        expect_native_oof(%(<div style="#{tb}">a long stretch of words that must wrap onto a second line #{mark} tail</div>))
        expect_native_oof(%(<div style="#{tb}">one<br>#{mark}two</div>))
        expect_native_oof(%(<div style="#{tb};text-align:right">hello #{mark}</div>))
        expect_native_oof(%(<div style="#{tb};text-align:center">hello #{mark} tail</div>))
        expect_native_oof(%(<div style="#{tb}">#{mark}hello</div>))
      end
      # The collapsed space before it is part of where the flow has reached — it is only PEEKED, so the word
      # after may still wrap away from it — and an rtl flow reads no cursor at all: its corner is the content's
      # right edge less the box, wherever the line's text sits (`staticCornerFor`).
      it 'counts the collapsed space it interrupts, and takes the content edge in rtl' do
        expect_native_oof(%(<div style="#{tb}">hello #{mark}world</div>))
        expect_native_oof(%(<div style="#{tb}">hello#{mark}world</div>))
        expect_native_oof(%(<div style="#{tb};direction:rtl">hello #{mark}</div>))
        expect_native_oof(%(<div style="#{tb};direction:rtl;text-align:center">a long stretch of words that must wrap onto a second line #{mark}</div>))
      end
      # An inline box around it moves the reading: its `position: relative` offset moves the content the
      # position is read off (§9.4.3), and its OPENING EDGE is not placed until the box's first content is, so
      # a marker written before that content waits for the edge — on whatever line the edge turns out to land.
      it 'moves with a relative inline and waits for an unplaced opening edge' do
        expect_native_oof(%(<div style="#{tb}"><span style="position:relative;left:6px">x #{mark} y</span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="position:relative;left:6px;top:3px"><span style="position:relative;left:4px">x #{mark}</span></span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="padding-left:9px">#{mark}x</span></div>))
        expect_native_oof(%(<div style="#{tb}">lead <span style="margin-left:9px;border-left:4px solid">#{mark}x</span></div>))
        expect_native_oof(%(<div style="#{tb}">a long stretch of words that must wrap onto a second line <span style="padding-left:9px"><span style="padding-left:5px">#{mark}x</span></span></div>))
      end
      # A block whose only line content is out of flow holds nothing to open a line WITH — but the line the flow
      # never opened is still where those boxes sit, and it starts at the indent and in the band a float leaves.
      # (Nothing closes it, so no alignment moves them, and the block is still an empty one.)
      it 'gives a block whose only line content is out of flow the line that never opened' do
        expect_native_oof(%(<div style="#{tb};text-indent:12px"><span>   #{mark}   </span></div>))
        expect_native_oof(%(<div style="#{tb};text-align:right"><span>   #{mark}   </span></div>))
        expect_native_oof(%(<div style="#{tb};text-indent:12px"><span>#{mark}</span>x</div>))
        expect_native_oof(%(<div style="#{tb};direction:rtl"><span>   #{mark}   </span></div>))
      end
      # …and a box the walk REPLAYS gets no marker at all: its record already carries the oracle's own position
      # off this container's origin, so a static position settled over it would be applied twice (measured: a
      # `text-indent` block holding a shrink-to-fit abspos put it at 22 where the oracle says 11, 0x0 instead of
      # its box — found by a 4000-case fuzz, and the walk's own gate is what routes it here).
      it 'leaves a replayed box to the oracle\'s own position' do
        expect_replayed_oof(%(<div style="#{tb};text-indent:11px"><div style="position:absolute">shrink to fit</div>mar</div>))
        expect_replayed_oof(%(<div style="#{tb};text-indent:11px">lead <div style="position:absolute">shrink to fit</div> tail</div>))
      end
      # `justify` widens the spaces between the words, and native holds no per-space positions — the offset it
      # would record is not the one the oracle reads off its placed spaces, so the block declines. Asked of the
      # RUN STREAM, not of the block's direct children: a marker one `<span>` deep is on the same line.
      it 'declines a justified line, however deep the marker sits' do
        expect_walk_declines(%(<div style="#{tb};text-align:justify">a long stretch of words that must wrap onto a second line #{mark} tail</div>))
        expect_walk_declines(%(<div style="#{tb};text-align:justify">a long stretch of words that must wrap onto a second line <span>#{mark}</span> tail here</div>))
        expect_walk_declines(%(<div style="#{tb};text-align:justify">a long stretch of <span>words that #{mark} must</span> wrap onto a second line tail here</div>))
      end
      # ── Review findings (adversarial round, 2026-09-15): each was a SILENT WRONG ANSWER ────────────────
      # A line the flow never put anything on is not aligned: `alignLine` runs only for a line that was
      # PLACED, so a `<br>` closing a marker-only line leaves the marker at the start edge.
      it 'does not align a line that holds nothing but a marker' do
        expect_native_oof(%(<div style="#{tb};text-align:right">#{mark}<br>x</div>))
        expect_native_oof(%(<div style="#{tb};text-align:center">a<br>#{mark}<br>b</div>))
        expect_native_oof(%(<div style="#{tb};white-space:pre;text-align:right">#{mark}
x</div>))
        # …inside a natively laid-out atomic too, whose own line is aligned in its own width
        expect_native_oof(%(<div style="position:relative;width:300px">x <span style="display:inline-block;width:100px;text-align:right">#{mark}<br>y</span> z</div>))
      end
      # The edge a marker waits for is the one belonging to the inline it sits DIRECTLY in
      # (`openInlines[openInlines.length - 1]`) — a plain inner inline waits for nothing, however edged the
      # boxes around it are, and an inline whose only edge is on the END side has no opening edge to wait for.
      it 'waits only on its own inline\'s opening edge' do
        expect_native_oof(%(<div style="position:relative;width:400px"><span style="padding-left:12px"><span>#{mark} Menu</span></span></div>))
        expect_native_oof(%(<div style="#{tb}">lead <span style="padding-left:9px"><span style="padding-right:5px">#{mark} x</span></span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="padding-left:12px"><span>Menu #{mark}</span></span></div>))
      end
      # A marker's y is frozen where it was recorded: a line whose first word does not fit the band DROPS
      # below the float afterwards, and the box the flow had already passed does not go down with it.
      it 'keeps the line it was on when that line drops below a float' do
        expect_native_oof(%(<div style="position:relative;width:100px"><div style="float:left;width:80px;height:20px"></div><div style="font:16px monospace">#{mark} aaaaaaaaaa</div></div>))
      end
      # Round 2. What a WAITING marker settles to is the cursor it STOOD at plus its own inline's opening edge
      # — the oracle's `line.minX + from.ce.left`. Not the cursor at settle time: an inline that opens AFTER it
      # puts its edge past the marker, and a collapsed space after it is the oracle's next placement, not this
      # one. (A collapsed space BEFORE it counts: the oracle places such a space where it meets it.)
      it 'settles a waiting marker at its own inline\'s content edge, not at whatever the cursor reached' do
        expect_native_oof(%(<div style="#{tb}">A<span style="padding-left:6px">#{mark}<span style="padding-left:4px">x</span></span></div>))
        expect_native_oof(%(<div style="#{tb}">A<span style="padding-left:6px">#{mark}<b style="margin-left:9px">x</b></span></div>))
        expect_native_oof(%(<div style="#{tb}">AA<span style="padding-left:6px">#{mark} x</span></div>))
        expect_native_oof(%(<div style="#{tb}">AA <span style="padding-left:6px">#{mark}<span style="padding-left:4px">x</span></span></div>))
      end
      # A forced break and a preserved space both PLACE the open edges first (`flushOpenEdges` inside
      # `placeOnLine`, and before `forceBreak`), which both settles a marker waiting on one and makes the line
      # a PLACED one — so the line's alignment moves it. Under `pre-line` only a run with real content reaches
      # that path: a newline alone in its text node takes the collapsed branch, and the walk keeps such a node
      # in a run of its own so the two stay distinguishable.
      it 'settles a waiting marker at a preserved space and at a forced newline' do
        pre = 'position:relative;width:200px;font:16px monospace;white-space:pre'
        expect_native_oof(%(<div style="#{pre}">A<span style="padding-left:6px">#{mark}\nx</span></div>))
        expect_native_oof(%(<div style="#{pre};text-align:right">A<span style="padding-left:6px">#{mark}\nx</span></div>))
        expect_native_oof(%(<div style="#{pre}">A<span style="padding-left:6px">#{mark}  x</span></div>))
        expect_native_oof(%(<div style="#{pre}-wrap">AA<span style="padding-left:6px">#{mark} x</span></div>))
        expect_native_oof(%(<div style="#{pre}-line">A<span style="padding-left:6px">#{mark}\nx</span></div>))
        expect_native_oof(%(<div style="#{pre}-line">a much longer stretch of ordinary words that will wrap <span style="padding-left:6px">#{mark}\n<span>y</span></span> tail</div>))
      end
      # Round 3. A waiting marker's cursor is measured from the BAND, which a float drop moves under it: a
      # line too narrow for its first word goes down, WITHOUT closing, into the wider band it lands in.
      it 'follows the band when its line drops below a float while it waits' do
        expect_native_oof(%(<div style="position:relative;width:100px"><div style="float:left;width:80px;height:20px"></div><div style="font:16px monospace"><span style="padding-left:9px">#{mark}aaaaaaaaaa</span></div></div>))
        expect_native_oof(%(<div style="position:relative;width:100px;text-align:right"><div style="float:left;width:80px;height:20px"></div><div style="font:16px monospace"><span style="padding-left:9px">#{mark}aa</span></div></div>))
      end
      # A COLLAPSED space inside the marker's own inline puts that inline's edge down where the oracle places
      # the space — so a marker written after it is waiting on nothing, and keeps its own inline's relative
      # offset. And edges that CANCEL (a negative margin outside a padding) are never placed at all, because
      # the flush is asked of their sum: the fragment then starts where its content does.
      it 'is not waiting once a collapsed space has put the edge down, and not fooled by cancelling edges' do
        expect_native_oof(%(<div style="#{tb}">zz<span style="padding-left:9px;position:relative;left:2px"> #{mark}a</span></div>))
        expect_native_oof(%(<div style="#{tb}">zz<span style="padding-left:9px;position:relative;top:3px"> #{mark}a</span></div>))
        expect_native_oof(%(<div style="#{tb};direction:rtl">zz<span style="padding-left:9px;position:relative;top:3px"> #{mark}a</span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="margin-left:-6px"><span style="padding-left:6px">#{mark}aa</span></span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="margin-left:-6px"><span style="padding-left:7px">#{mark}aa</span></span></div>))
        # …and an edge that cancels is never placed AT ALL, so nothing in that inline is ever waiting: a
        # marker written AFTER its content reads the cursor, where holding it back would have put it at the
        # fragment's start (measured in Chrome: 38.41, which is the cursor).
        expect_native_oof(%(<div style="#{tb}"><span style="margin-left:-6px"><span style="padding-left:6px">word#{mark}more</span></span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="margin-left:-6px"><span style="padding-left:6px">word #{mark}more</span></span></div>))
      end
      # What a held-back marker reads is where its fragment OPENED, which is not the fragment's leftmost
      # extent: content further along the line can reach further left than the box's own start (Chrome 6).
      it 'reads where its fragment opened, not how far left the fragment reaches' do
        expect_native_oof(%(<div style="#{tb}"><span style="padding-left:6px">#{mark}alpha<span style="margin-left:-90px">beta</span></span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="margin-left:6px"><span style="padding-left:6px">#{mark}alpha<span style="margin-left:-5px">beta</span></span></span></div>))
        expect_native_oof(%(<div style="#{tb}"><span style="padding-left:6px">#{mark}alpha<span style="margin-left:-9px">beta</span></span></div>))
      end
      # An rtl corner is the container's, so the alignment never moves it and the cursor never reaches it —
      # but its BLOCK axis is the static position like any other, relative inlines included.
      it 'moves an rtl corner in the block axis only' do
        expect_native_oof(%(<div style="#{tb};direction:rtl"><span style="position:relative;top:3px;left:4px">#{mark} x</span></div>))
        expect_native_oof(%(<div style="#{tb};direction:rtl"><span style="position:relative;top:3px;padding-left:9px">#{mark} x</span></div>))
        expect_native_oof(%(<div style="#{tb};direction:rtl"><span style="position:relative;top:5px"><span style="position:relative;top:2px">x #{mark}</span></span></div>))
      end
    end

    # …and in BLOCK flow the same cursor is a LINE cursor: it starts in the band a float leaves at that y, and
    # it carries the block's first-line indent until an in-flow child spends it.
    describe 'a static position taken off the block-flow cursor' do
      let(:mark) { '<div style="position:absolute;width:10px;height:10px"></div>' }

      it 'starts at the unspent indent and in the float\'s band' do
        expect_native_oof(%(<div style="position:relative;width:200px;text-indent:12px">#{mark}<div style="height:10px">b</div></div>))
        expect_native_oof(%(<div style="position:relative;width:200px;text-indent:12px;padding-left:9px">#{mark}<div style="height:10px">b</div></div>))
        expect_native_oof(%(<div style="position:relative;width:200px;text-indent:12px"><div style="height:10px">b</div>#{mark}</div>))
        expect_native_oof(%(<div style="position:relative;width:200px"><div style="float:left;width:30px;height:60px"></div>#{mark}<div style="height:10px">b</div></div>))
        expect_native_oof(%(<div style="position:relative;width:200px"><div style="float:left;width:30px;height:60px"></div><div style="height:10px">b</div>#{mark}</div>))
        expect_native_oof(%(<div style="position:relative;width:200px;text-indent:12px"><div style="float:left;width:30px;height:60px"></div>#{mark}<div style="height:10px">b</div></div>))
        expect_native_oof(%(<div style="position:relative;width:200px"><div style="float:left;width:30px;height:10px"></div><div style="height:30px">b</div>#{mark}</div>))
      end
      # …a block holding NOTHING but out-of-flow children included: it lays out no lines, so it reads the same
      # cursor, at the same indent and in the same band.
      # The band is the one a LINE BOX meets, not a hairline at the cursor: a float that starts a few px below
      # it (after a collapsed margin, or a second float that dropped past the first) still shortens that line.
      it 'asks the band over a line box, not at the cursor' do
        expect_native_oof(%(<div style="position:relative;width:100px;line-height:40px"><div style="height:10px;margin-bottom:15px">b</div><div style="float:left;width:30px;height:5px"></div>#{mark}</div>))
        expect_native_oof(%(<div style="position:relative;width:100px"><div style="float:right;width:60px;height:5px"></div><div style="float:left;width:60px;height:30px"></div>#{mark}</div>))
      end
      it 'reads it in a block whose only children are out of flow' do
        expect_native_oof(%(<div style="position:relative;width:200px;text-indent:12px">#{mark}</div>))
        expect_native_oof(%(<div style="position:relative;width:200px;text-indent:12px;padding-left:7px;border-left:3px solid">#{mark}#{mark}</div>), 2)
        expect_native_oof(%(<div style="position:relative;width:200px"><div style="float:left;width:30px;height:20px"></div>#{mark}</div>))
      end
      it 'leaves an rtl flow reading the content edge, whatever the band' do
        expect_native_oof(%(<div style="position:relative;width:200px;direction:rtl;text-indent:12px"><div style="float:left;width:30px;height:60px"></div>#{mark}<div style="height:10px">b</div></div>))
      end
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
      expect_walk_declines('<div style="width:400px"><div style="writing-mode:vertical-lr"><div style="display:grid;grid-template-columns:40px"><span>g</span><span>h</span></div></div></div>')
      expect_walk_declines('<div style="width:400px"><div style="writing-mode:vertical-lr"><span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">c</span></span></span></div></div>')
    end
    # …which is also why such a child is walked as a MEASURED subtree: an atomic inline whose own box would be
    # PUSHED is not in the run stream native measures from, so the walk has to decline where it would otherwise
    # hand Rust a subtree it cannot re-measure. Every shape here lays out natively without the writing mode.
    it 'declines a vertical block whose atomic inline is pushed, not laid out natively' do
      # A SUBSET of `WalkRefusals::ATOMIC`, deliberately: that list is what the atomic ROUTE refuses, and
      # this is a different route — a vertical block measures its own width, so what it declines is what it
      # cannot MEASURE, which is not the same set (the shared list's whitespace-only and table-cell atomics
      # are measurable here). Written out rather than filtered, so a reader sees the shapes.
      [
        'a <span style="display:inline-table"><span style="display:table-cell">bb</span></span>',
        'a <span style="display:inline-block"><span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">c</span></span></span></span>',
        'a <span style="display:inline-block"><div style="float:left;position:relative;width:9px;height:4px"></div>t</span>',
        'a<br>b <span style="display:inline-table"><span style="display:table-cell">bb</span></span>'
      ].each do |inner|
        expect_walk_declines(%{<div style="width:400px"><div style="writing-mode:vertical-lr">#{inner}</div></div>})
      end
      # …and through a GRID item, whose subtree is measured for the track sizes
      expect_walk_declines('<div style="display:grid;grid-template-columns:200px;width:400px"><div><div style="writing-mode:vertical-lr">a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></div></div></div>')
      # …and the same content in a HORIZONTAL block lays out, the atomic pushed rather than the pass declined.
      expect_parity('<div style="width:400px"><div>a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></div></div>')
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
      expect_replayed_oof(%{<div style="width:400px;height:200px"><div style="position:absolute;left:30px">a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></div></div>})
    end
    # The ROOT element is never an out-of-flow box's containing block, in either engine: the oracle assigns its box at
    # the end of the pass, so a first layout could not see it and every later one saw last pass's — the walk, which
    # finds the block without the oracle's boxes, took it for the viewport on the first pass and the oracle then
    # disagreed on every relayout. SHARED divergence: Chrome positions against a positioned `<html>`'s box. Each shape
    # is laid out TWICE, a mutation between.
    it 'places against the viewport, not a positioned root, on every pass' do
      [
        '<style>html{position:relative}</style><div id="p" style="height:200px"><div style="position:absolute;bottom:0;left:0;width:40px;height:20px"></div></div>',
        '<style>html{position:relative;padding:20px;height:400px}</style><div id="p" style="height:200px"><div style="position:absolute;top:50%;left:0;width:40px;height:20px"></div></div>',
        '<style>html{transform:translateZ(0)}</style><div id="p" style="height:2000px"><div style="position:fixed;bottom:0;width:40px;height:20px"></div></div>',
        '<style>html{filter:invert(1)}</style><div id="p" style="height:2000px"><div style="position:fixed;bottom:0;width:40px;height:20px"></div></div>'
      ].each do |body|
        session = simulated_session(page(body)); session.visit '/'
        first = parity(session)
        expect(first).to include('ok' => true, 'mismatches' => 0), "#{body}: #{first.inspect}"
        expect(first['nativeOutOfFlow']).to be >= 1, "#{body}: #{first.inspect}"
        session.execute_script("document.getElementById('p').appendChild(document.createElement('span'))")
        again = parity(session)
        expect(again).to include('ok' => true, 'mismatches' => 0), "#{body} (second pass): #{again.inspect}"
      end
    end
  end

  # An out-of-flow box is in NO ancestor's intrinsic contribution: a contribution skips an out-of-flow child
  # outright, and the box is in no run stream. So walking one LEAVES the measured region — whatever native
  # cannot MEASURE inside it is nobody's problem, because nobody measures it. Before this, the flag was
  # inherited and a pushed atomic inline inside an absolute box declined the whole pass.
  describe 'an out-of-flow box leaves the measured region' do
    pushed_atomic = 'a <span style="display:inline-table"><span style="display:table-cell">bb</span></span>'
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
    # replayed, so content the predicate cannot judge (a `text-indent`ed atomic, an inline-flex) lands here too.
    it 'replays a shrink-to-fit box whose own content native cannot measure' do
      expect_replayed_oof(%{<div style="width:400px;position:relative"><div style="writing-mode:vertical-lr"><div style="position:absolute;left:0">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      expect_replayed_oof(%{<div style="width:400px;position:relative"><div style="writing-mode:vertical-lr"><div style="position:absolute">#{pushed_atomic}</div><div style="width:9px;height:4px"></div></div></div>})
      # …again a subset, for the same reason: this route REPLAYS what it cannot measure rather than declining,
      # and the shared list's other entries are measurable here.
      [
        '<span style="display:inline-block"><span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">c</span></span></span></span>',
        '<span style="display:inline-table"><span style="display:table-cell">bb</span></span>'
      ].each do |inner|
        expect_replayed_oof(%{<div style="width:400px;position:relative"><div style="position:absolute;left:0">a #{inner}</div><p>x</p></div>})
      end
      # …while one it CAN measure is still sized and placed natively
      expect_native_oof(%{<div style="width:400px;position:relative"><div style="position:absolute;left:0">a <span style="display:inline-block">ok</span></div><p>x</p></div>})
    end
  end

  # A `<td>` whose content native cannot lay out itself pushes its own width CONTRIBUTION (rec[84..85]) and the
  # table is laid out around it. That needs `nlIntrinsicMeasurable` to answer what the walk will actually DO:
  # while it ignored the walk's own refusal of an intrinsic-size keyword (native's own since), such an
  # inline-block in a cell was called measurable, the cell was walked measured, and the atomic inside then
  # declined the whole table. A pushed inline-table stands in for it now.
  describe 'a cell whose content native cannot lay out pushes its contribution' do
    it 'lays out a table around a cell holding an atomic native does not lay out' do
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0">a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></td><td style="padding:0">cc</td></tr></table>})
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0">a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></td></tr></table>})
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0;width:50px">a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></td></tr></table>})
      expect_parity(%{<div style="display:table;border-spacing:0"><div style="display:table-row"><div style="display:table-cell">a <span style="display:inline-table"><span style="display:table-cell">bb</span></span></div></div></div>})
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

  # `position: sticky` is IN FLOW, and its box is where a STATIC one's would be — not a relative one's. The
  # oracle never puts the scroll-driven shift into `_lb`: `stickyDelta` is read by `scrollShift` and the
  # `offsetTop` reader, so the shift lives entirely in the READ path and the layout knows nothing of it. Five
  # NINE separate gates refused sticky as "a scroll-driven shift native doesn't model", which mistook where
  # that shift is applied; native needed no new rule at all, only to stop refusing. (`nlSupported`,
  # `nlFlexSupported`, `nlTableSupported`, `nlGridSupported`, `nlAtomicMeasurable`, the atomic and flex-item
  # arms of `nlGatherRuns`, the block-child arm, and the float arm — the last of which a sticky float needed.)
  describe 'a sticky box lays out where a static one would' do
    it 'takes a sticky box in every context that refused one' do
      expect_parity('<div style="width:400px;height:200px;overflow:auto"><div style="height:50px"></div><div style="position:sticky;top:0;width:60px;height:20px"></div><div style="height:300px"></div></div>')
      expect_parity('<div style="display:flex;width:400px"><div style="position:sticky;top:0;width:60px;height:20px"></div><div style="width:40px;height:30px"></div></div>')
      expect_parity('<div style="display:grid;grid-template-columns:100px auto;width:400px"><div style="position:sticky;top:0;height:20px"></div><div>x</div></div>')
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0"><div style="position:sticky;top:0">s</div></td><td style="padding:0">b</td></tr></table>')
      expect_parity('<div style="width:400px">aaa <span style="position:sticky;top:0;display:inline-block;width:20px;height:10px"></span> bbb</div>')
    end
    # …a FLOAT too: a sticky float is a float, and its box needs nothing a static one's does not. (A RELATIVE
    # float still declines — that one carries an offset native would have to apply.)
    it 'takes a sticky float, and still refuses a relative one' do
      expect_parity('<div style="width:400px"><div style="position:sticky;top:0;float:left;width:40px;height:10px"></div><div>text beside it</div></div>')
      expect_parity('<div style="width:400px;height:200px;overflow:auto"><div style="height:50px"></div><div style="position:sticky;top:0;float:left;width:40px;height:10px"></div></div>')
      expect_walk_declines('<div style="width:400px"><div style="position:relative;top:5px;float:left;width:40px;height:10px"></div><div>text</div></div>')
    end
    # …and the insets it is given change nothing about the box, whichever way they point.
    it 'ignores the insets, which are the read path' do
      ['top:0', 'top:10px', 'bottom:0', 'left:0;top:0', 'top:-5px', 'bottom:20px;right:10px'].each do |inset|
        expect_parity(%(<div style="width:400px;height:200px;overflow:auto"><div style="height:50px"></div><div style="position:sticky;#{inset};width:60px;height:20px"></div><div style="height:300px"></div></div>))
      end
    end
  end

  # PERCENTAGE SIZES on an in-flow child of a block or flex container resolve natively, against the box the
  # parent lays the child out in (`Input::with_percent_sizes` at the parent's measure): its content width, and its
  # content height where that is definite (a flex column's main size). The walk resolved every one against the
  # ORACLE's stamps (`_lbCbW` / `_lbCbH`), and every page read them.
  describe 'percentage sizes' do
    def no_oracle(body)
      session = simulated_session(page(body)); session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
    end

    it 'resolves them against the parent native lays the box out in' do
      [
        '<div style="width:300px;height:200px"><div style="width:50%;height:50%">c</div></div>',
        '<div style="width:300px;height:180px;padding:10px 20px;box-sizing:border-box;border:3px solid"><div style="width:30%;height:40%;padding:5px">c</div></div>',
        '<div style="width:300px"><div style="height:50%;max-width:20%">auto parent: the height is auto</div></div>',
        '<div style="display:flex;width:300px;height:150px"><div style="width:30%;height:40%"></div><div style="width:20px;height:20px"></div></div>',
        '<div style="display:flex;flex-direction:column;width:300px;height:150px"><div style="height:50%;min-width:70%"></div></div>',
        '<div style="width:300px;height:200px"><div style="float:left;width:25%;height:10%">f</div><div style="height:20px"></div></div>',
        '<div style="width:300px;height:200px">t <span style="display:inline-block;width:40%;min-height:30%">ib</span></div>',
        '<div style="width:300px;height:200px"><div style="width:50%;height:50%"><div style="height:50%;width:50%">nested</div></div></div>'
      ].each do |body|
        expect_parity(body)
        r = no_oracle(body)
        expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
      end
    end

    # …and the MARGINS and PADDING, against the containing block's width on every side: the walk sends each edge's
    # length and percentage parts apart and the parent adds them up.
    it 'resolves percentage margins and padding against the parent native lays the box out in' do
      [
        '<div style="width:400px"><div style="margin:5%;padding:10% 2%">block</div></div>',
        '<div style="width:137px;padding:0 9px"><div style="margin-left:20%;margin-right:auto;width:40%">auto beside</div></div>',
        '<div style="width:400px"><div style="padding:calc(5% + 3px);padding-inline-start:15%;margin-inline-end:10%">logical, calc</div></div>',
        # …a math function that bends, and a padding that goes negative and is clamped, above the probe bases
        '<div style="width:2400px"><div style="padding:min(5%, 100px)">min</div><div style="padding:calc(10px - 0.5%)">clamped</div></div>',
        # …an atomic on its text block's lines, and vertical margins collapsing through a parent
        '<div style="width:400px">text <span style="display:inline-block;padding:5% 10%">ib</span> after</div>',
        '<div style="width:300px"><div style="margin-top:10%"><div style="margin-top:5%">collapse</div></div></div>',
        '<div style="display:flex;width:420px"><div style="box-sizing:border-box;width:60%;padding:0 10%">item</div><div style="width:30px;height:10px"></div></div>',
        '<div style="width:260px"><div style="float:left;margin:-5% 0 0 -3%">f</div></div>'
      ].each do |body|
        expect_parity(body)
        r = no_oracle(body)
        expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
      end
    end
    # A text indent's percentage is of the block's CONTENT width, which the walk still takes off the oracle's box — so
    # the padding it subtracts is the one the oracle resolved, not the length part a percentage padding leaves on the
    # record (80 where 64 is right, with `padding: 0 10%` and `text-indent: 20%` in a 400px block).
    it 'measures a text indent against the content width the oracle padded' do
      # (the words fill the first line to within the 16px the wrong basis would take off it)
      expect_parity(%(<div style="width:400px"><div style="padding:0 10%;text-indent:20%">#{(['ab'] * 27).join(' ')} cccccc</div></div>))
    end
    # The ORACLE's basis was `content.height || null`: a definite 0 read as none, and an IMPOSED height (a grid row,
    # both insets) not yet clamped by the box's own max-height. Chrome and native: a definite 0 is 0 (the embed
    # wrapper's child is its content's height, not 0 — its percentage height resolves to 0), and the clamp comes
    # first (`height: 50%` under a 100px row capped at 50 is 25).
    it 'resolves against a definite zero, and against an imposed height clamped' do
      expect_parity('<div style="width:300px;height:0"><div style="height:50%">x</div></div>')
      expect_parity('<div style="display:grid;grid-auto-rows:100px;width:300px"><div style="max-height:50px"><div style="height:50%">x</div></div></div>')
      expect_parity('<div style="position:relative;width:300px;height:200px"><div style="position:absolute;top:0;bottom:0;max-height:100px;width:200px"><div style="height:50%">x</div></div></div>')
      session = simulated_session(page('<div style="display:grid;grid-auto-rows:100px;width:300px"><div style="max-height:50px"><div id="t" style="height:50%">x</div></div></div>'))
      session.visit '/'
      expect(session.evaluate_script("document.getElementById('t').getBoundingClientRect().height")).to eq(25)
    end
    # A flex item whose box is PUSHED (the inline-table inside it) keeps its min/max-height — the floor a flex
    # container item two-phases its auto height against — and a percentage one went over as a fraction the push then
    # cleared: the item recomputed its height from content with no floor (40 where the oracle's is 128). The push
    # resolves it against the oracle's basis instead, as the border-box figure the rest of the push keeps.
    it 'resolves a pushed item\'s percentage clamp in the push' do
      table = '<span style="display:inline-table"><span style="display:table-cell">c</span></span>'
      expect_parity(%(<div style="display:flex;height:180px;align-items:flex-start"><div style="display:flex;align-items:center;min-height:60%;padding:10px 0"><div>t #{table}</div><div style="height:20px;width:10px"></div></div></div>))
    end
    # A box laid out twice under two different HEIGHT bases — a flex item measured with an auto height, then
    # stretched to its line — resolves a percentage min-height against the second. The oracle reused the first
    # layout (it checked the width basis only) and kept the unfloored 18 where Chrome and native give 96.
    it 'lays a percentage min-height out again once its height basis changes' do
      expect_parity('<div style="display:flex;height:160px;width:400px"><div style="flex:1"><div style="min-height:60%">c</div></div></div>')
      session = simulated_session(page('<div style="display:flex;height:160px;width:400px"><div style="flex:1"><div id="t" style="min-height:60%">c</div></div></div>'))
      session.visit '/'
      expect(session.evaluate_script("document.getElementById('t').getBoundingClientRect().height")).to eq(96)
    end
  end
end
