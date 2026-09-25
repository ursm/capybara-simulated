# frozen_string_literal: true
# Native layout, block flow — geometry shadow-parity: the native pass's border-boxes must equal the JS
# layout's `_lb`. It started as L1's invariant, "a pure block-flow page — explicit heights, no inline
# text, no float, no abspos", and that is no longer what the file says: floats, abspos, inline runs,
# atomics and mixed blocks all have examples below, because each was ported in turn and its parity
# belongs beside the block one. What is still true, and is the actual contract, is the PASS: a shape
# either lays out natively and agrees with the oracle everywhere, or it declines and the whole pass is
# discarded — there is no third answer, and the examples that assert a DECLINE are asserting that
# second one on purpose. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'
require_relative 'support/walk_refusals'

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
  # A `<link>` or `<meta>` written in the BODY is `display: none` from the UA stylesheet — no box, and nothing
  # in the flow. It was neither an author rule (the hide cascade resolves those) nor one of the tags the
  # visibility walk knows by name, so BOTH engines flowed it: it separated two margins that should have
  # collapsed through it, and ended a line the text should have carried on. The UA's own display is part of the
  # hide cascade now. Chrome figures — the two engines agreeing here said nothing, since they agreed while both
  # were wrong.
  it 'flows nothing for a child the UA stylesheet hides' do
    [
      ['<div style="height:10px;margin-bottom:20px">a</div><link rel="stylesheet"><div id="g" style="height:10px;margin-top:30px">b</div>', [40, 10]],
      ['<div style="height:10px;margin-bottom:20px">a</div><meta name="x"><div id="g" style="height:10px;margin-top:30px">b</div>',        [40, 10]],
      # …and the same shape with nothing between the two blocks, which is what the margins collapse to
      ['<div style="height:10px;margin-bottom:20px">a</div><div id="g" style="height:10px;margin-top:30px">b</div>',                       [40, 10]]
    ].each do |body, chrome_box|
      session = simulated_session(page(%(<div style="width:300px">#{body}</div>)))
      session.visit '/'
      expect(parity(session)).to include('ok' => true, 'mismatches' => 0), body
      box = session.evaluate_script("(b => [b.y, b.height])(document.getElementById('g').getBoundingClientRect())")
      expect(box).to eq(chrome_box), "#{body}: #{box.inspect}, Chrome #{chrome_box.inspect}"
    end
    # …and it is no line breaker either: `aaa<meta>bbb` is ONE line of 18, not two of it.
    session = simulated_session(page(%(<div style="width:300px" id="g">aaa<meta name="x">bbb</div>)))
    session.visit '/'
    expect(parity(session)).to include('ok' => true, 'mismatches' => 0)
    expect(session.evaluate_script("document.getElementById('g').getBoundingClientRect().height")).to eq(18)
  end

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
      expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
  end

  # A display with no arm of its own — `-webkit-box`, `-webkit-inline-box`, `ruby`, `math`, `flow`, an orphan
  # `table-column` — is laid out by the oracle's block flow as a plain block (`layoutElementInner`'s fallthrough),
  # and the walk takes it as one since 2026-09-25 (it declined, `block-level-box-unplaceable`). Chrome does
  # otherwise for the WebKit pair, and both engines share it: the line-clamp idiom clamps three lines to two (44,
  # where both say 66), and `-webkit-inline-box` is inline-level (x 28.8 on the first line, where both put it at 0
  # on the next).
  it 'lays out a display with no arm of its own as the block the oracle makes it' do
    clamp = '<div style="width:300px;font:16px monospace"><div id="m" style="display:-webkit-box;-webkit-line-clamp:2;' \
            '-webkit-box-orient:vertical;overflow:hidden">aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv ww xx yy zz</div></div>'
    inline = '<div style="width:300px;font:16px monospace">aa <span id="m" style="display:-webkit-inline-box">x</span> bb</div>'
    [clamp, inline].each {|body| expect_parity(body) }
    expect_shared_gap(laid_out_rect(clamp)[3], shared: 66, chrome: 44, what: "#{clamp}: #m height")
    expect_shared_gap(laid_out_rect(inline)[0], shared: 0, chrome: 28.81, what: "#{inline}: #m x")
    %w[ruby math flow table-column].each do |display|
      expect_parity(%(<div style="width:200px;font:16px monospace">lead <div style="display:#{display};padding:0 5%">aa bb</div> tail</div>))
    end
  end

  # A PERCENTAGE relative inset goes over as its `px + frac` pair and native resolves it against the containing
  # block it lays the box out in — the oracle's box was the basis until 2026-09-24. Both engines and Chrome: 30/20
  # in a 300x200 block; a `top: 10%` of an INDEFINITE height resolves to nothing and `bottom: 4px` is used (-4) —
  # and so does a `top: 0%` or a `calc(0% + 5px)`, whose fraction is zero but which is a percentage all the same
  # (-10, -3; native read a zero fraction as "no percentage" and said 0 and 5); an over-constrained pair keeps the
  # rtl flow's `right` (-15); a linear `calc()` on an atomic, 60.99 / -5 (Chrome 61: the text before it is 28 wide
  # there, 27.99 here). …and a COMPARISON function travels as its clamped pair (2026-09-25; resolved against the
  # oracle's basis before): `max(5%, 30px)` 30, an rtl `right: min(5%, 30px)` -15, a `top: clamp(5px, 10%, 12px)` 12
  # of 200, `bottom: max(10px, 20%)` -40, a `top: max(10px, 20%)` of an INDEFINITE height nothing, and a `right`
  # whose bounds CROSS negated after its clamp (-40: `clamp()`'s minimum wins, then the sign) — Chrome's figures.
  it 'resolves a percentage relative inset natively, against the box native lays the parent out as' do
    {
      '<div style="width:300px;height:200px"><div id="m" style="position:relative;left:10%;top:10%;height:20px">b</div></div>'                                   => [30, 20],
      '<div style="width:300px"><div id="m" style="position:relative;top:10%;bottom:4px;height:20px">b</div></div>'                                              => [0, -4],
      '<div style="width:300px"><div id="m" style="position:relative;top:0%;bottom:10px;height:20px">b</div></div>'                                              => [0, -10],
      '<div style="width:300px"><div id="m" style="position:relative;top:calc(0% + 5px);bottom:3px;height:20px">b</div></div>'                                   => [0, -3],
      '<div style="width:300px;direction:rtl"><div id="m" style="position:relative;left:10%;right:5%;height:20px">b</div></div>'                                 => [-15, 0],
      '<div style="width:300px;height:100px">text <span id="m" style="display:inline-block;position:relative;left:calc(10% + 3px);top:-5%">ib</span> more</div>' => [60.99, -5],
      '<div style="width:300px"><div id="m" style="position:relative;left:max(5%, 30px);height:20px">b</div></div>'                                              => [30, 0],
      '<div style="width:300px;direction:rtl"><div id="m" style="position:relative;right:min(5%, 30px);height:20px">b</div></div>'                               => [-15, 0],
      '<div style="width:300px;height:200px"><div id="m" style="position:relative;top:clamp(5px, 10%, 12px);height:20px">b</div></div>'                         => [0, 12],
      '<div style="width:300px;height:200px"><div id="m" style="position:relative;bottom:max(10px, 20%);height:20px">b</div></div>'                              => [0, -40],
      '<div style="width:300px"><div id="m" style="position:relative;top:max(10px, 20%);height:20px">b</div></div>'                                             => [0, 0],
      '<div style="width:300px"><div id="m" style="position:relative;right:clamp(40px, 10%, 20px);height:20px">b</div></div>'                                    => [-40, 0]
    }.each do |body, (x, y)|
      session = simulated_session(page(body))
      session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0), r.inspect
      got = laid_out_rect(body)
      expect(got[0]).to be_within(0.01).of(x)
      expect(got[1]).to be_within(0.01).of(y)
      oracle_free = session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      expect(oracle_free).to include('ok' => true, 'mismatches' => 0)
      expect(oracle_free['oracleReads'].to_h.keys.grep_v(/\(handed over\)\z/)).to be_empty, oracle_free.inspect
    end
  end

  # …and a CAPTION's, whose offset resolves against its TABLE's height as the table stands when the caption is
  # placed — declared (10 of 100), stretched by a flex line (15 of 150) or its grid row (8 of 80) — while its own
  # percentage height resolves against nothing. Both engines lost that basis (0) until 2026-09-25; Chrome's figures.
  it 'resolves a relative caption\'s percentage inset against its table\'s height' do
    row = '<div style="display:table-row"><div style="display:table-cell">d</div></div>'
    caption = '<div id="m" style="display:table-caption;position:relative;top:10%">cap</div>'
    {
      %(<div style="width:300px"><div style="display:table;width:100%;height:100px">#{caption}#{row}</div></div>)                                                                 => 10,
      %(<div style="width:300px;height:150px;display:flex"><div style="display:table;width:100%">#{caption}#{row}</div><div>x</div></div>)                                        => 15,
      %(<div style="width:300px;display:grid;grid-template-columns:100px 1fr;grid-auto-rows:80px"><div style="display:table;width:100%">#{caption}#{row}</div><div>x</div></div>) => 8
    }.each do |body, y|
      expect_parity(body)
      expect(laid_out_rect(body)[1]).to eq(y)
    end
    # …the table's BORDER box, as the oracle hands it (11.6 of the 116 a content-box `height: 100px` table with
    # 5px padding and a 3px border comes to); Chrome's is its CONTENT box after its min/max (8.39 of that
    # table, 12 of `height: 40px; min-height: 120px`, where both say 4). Shared.
    {
      'height:100px;padding:5px;border:3px solid' => [11.6, 8.39],
      'height:40px;min-height:120px'              => [4, 12]
    }.each do |table, (shared, chrome)|
      wrap = ->(cap) { %(<div style="width:300px"><div style="display:table;width:100%;#{table}">#{cap}#{row}</div></div>) }
      body = wrap.(caption)
      expect_parity(body)
      offset = laid_out_rect(body)[1] - laid_out_rect(wrap.(caption.sub('top:10%', 'top:0')))[1]
      expect_shared_gap(offset, shared: shared, chrome: chrome, what: "#{body}: #m's offset")
    end
  end

  # …and in a table that is a FLEX ITEM, which the walk refused until 2026-09-25 (the offset was resolved against the
  # oracle's stamp): natively laid out, the table's height as `layCaption` sees it is native's too — declared (10) or
  # the stretch (15). Where the flex container is PUSHED, the push hands native the wrapper's 118, and it settles the
  # caption's offset itself against the oracle's basis — 11.8 where the oracle and Chrome say 10. Chrome's boxes.
  it 'resolves a flex-item table\'s caption offset against the table\'s height, pushed or not' do
    {
      '<div style="display:flex;width:300px;height:150px;align-items:start"><table style="width:200px;height:100px"><caption id="m" style="position:relative;top:10%">cap</caption><tr><td style="height:40px">d</td></tr></table><div>y</div></div>'             => 10,
      '<div style="display:flex;width:300px;height:150px"><table style="width:200px;min-height:120px"><caption id="m" style="position:relative;top:10%">cap</caption><tr><td style="height:40px">d</td></tr></table><div>y</div></div>'                               => 15,
      '<div style="display:flex;width:300px;height:150px;align-items:start"><table style="width:200px;height:100px"><caption id="m" style="position:relative;top:10%;height:50%">cap</caption><tr><td style="height:40px">d</td></tr></table><div>y</div></div>' => 10
    }.each do |body, y|
      expect_parity(body)
      expect(laid_out_rect(body)[1]).to eq(y), body
    end
  end

  # …but only a caption a TABLE lays out: an ORPHAN one is the oracle's plain block, whose offset resolves against
  # its parent like any block's — where the walk has to fall back (a flex item's child, a `max()`), it read the
  # table stamp `layCaption` never wrote and said 0 where the oracle says 20 / 12 / 20. Chrome wraps an orphan in
  # an anonymous table of auto height and says 0; both engines share the block.
  it 'resolves an orphan caption\'s fallback offset against its parent, as the block the oracle lays it out as' do
    {
      '<div style="display:flex;width:300px;height:200px"><div style="width:100px"><div id="m" style="display:table-caption;position:relative;top:10%">cap</div></div></div>' => 20,
      '<div style="display:grid;width:300px;grid-auto-rows:120px"><div><div id="m" style="display:table-caption;position:relative;top:10%">cap</div></div></div>'          => 12,
      '<div style="width:300px;height:200px"><div id="m" style="display:table-caption;position:relative;top:max(10%, 4px)">cap</div></div>'                            => 20
    }.each do |body, y|
      expect_parity(body)
      expect_shared_gap(laid_out_rect(body)[1], shared: y, chrome: 0, what: "#{body}: #m y")
    end
  end

  # A size is never negative, and only a math function can make one: `width: calc(10% - 100px)` in a 300px block is
  # a zero content box (its padding still around it, 10 wide), a negative `max-width` caps the box at nothing
  # rather than being ignored, and a negative height is 0. The oracle kept the negative figure (-70, -60, 300 for
  # the `max-width`) until 2026-09-25, where native and Chrome said 0; both engines and Chrome agree now.
  it 'floors a negative calc() size at zero' do
    {
      'width:calc(10% - 100px);height:10px'                => [0, 10],
      'width:calc(10% - 100px);padding:0 5px;height:10px'  => [10, 10],
      'max-width:calc(10% - 100px);height:10px'            => [0, 10],
      'min-width:calc(10% - 100px);width:50px;height:10px' => [50, 10]
    }.each do |style, size|
      body = %(<div style="width:300px"><div id="m" style="#{style}"></div></div>)
      expect_parity(body)
      expect(laid_out_rect(body)[2, 2]).to eq(size)
    end
    body = '<div style="width:300px;height:100px"><div id="m" style="height:calc(10% - 100px)">x</div></div>'
    expect_parity(body)
    expect(laid_out_rect(body)[3]).to eq(0)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r)
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
    expect_no_dropped_records(r, body)
  end

  def expect_bail(body)
    session = simulated_session(page(body)); session.visit '/'
    expect(parity(session)).to include('ok' => false)
  end

  # ── WHY a pass declined ─────────────────────────────────────────────────────────────────────────────
  # The walk's refusal sites reported ONE string for all of them, so no census could name a gate without
  # rewriting `layout.js` first — which is how `atomic-valign-line` stayed invisible while costing 5,120
  # shapes. A refusal that names itself latches into `nlDeclineWhy` (first writer wins: the walk aborts at
  # the refusal that stopped it), and the pass reports that instead of the generic string. The source spells
  # 26 distinct gate names today (`float-in-inline` is easy to miscount: it is written as a fallback beside
  # the latch, not as an `nlNo`); of 17,481 declines across the sweeps (2026-09-20) 552 still answer
  # `unsupported subtree`, and 192 answer `native declined`, which is RUST's own single string — the same
  # one-string-for-everything hole on the other side of the boundary, and a porting job of its own.
  #
  # A REPORTED reason is not a census — a shape blocked by several gates names only the first it reached.
  # That is the SET census's question, not this string's.
  describe 'the reason a pass declines' do
    # One flex container the walk refuses — an ORPHAN `display: table-row` holding content, which the oracle MEASURES
    # with its pen and LAYS OUT as a flex row (see `nlFlexSupported`) — in three roles below: a block's child, a
    # mixed block's FLOATED child, and the later decline a rolled-back attempt must not be blamed for. One shape, so
    # the three cannot drift into testing different gates. (It was a wrapping auto-height column with a max-height
    # until 2026-09-24, when native learned to size that one's lines.)
    UNSUPPORTED_FLEX = '<div style="display:table-row">aa bb</div>'

    # The load-bearing half is the ROLLBACK. Several routes try a subtree and fall back: a table cell that
    # cannot be measured is re-walked as a boundary, and the pass goes on. A reason latched inside such an
    # attempt must not survive it, or it names a decline that happened somewhere else entirely — the one
    # failure mode a latch has, and the one nothing else would catch.
    it 'forgets a refusal inside an attempt that was rolled back' do
      # An ATOMIC whose subtree declines is the reachable case: `atomic.lay` walks it through `walkAttempt`,
      # the refusal inside names itself, the attempt is rolled back and the box is PUSHED — and the pass
      # goes on to succeed. The reason must not survive that. (A table cell re-walked as a boundary is the
      # other rollback route and does NOT reach this: `nlIntrinsicMeasurable` refuses it as a pre-filter, so
      # no attempt is made and nothing is latched. The first version of this example used one and passed
      # with the restore deleted.)
      atomic      = WalkRefusals::POSITIONED
      prefiltered = '<span style="display:inline-block;word-break:break-all">a&zwj;b</span>'
      measured    = ->(inner) { %(<div style="width:400px;overflow:hidden"><div style="float:left">t #{inner} a</div></div>) }

      # …and FIRST the two properties the rest of this depends on, because `ok: true, nativeAtomics: 0` holds
      # for an atomic that was never ATTEMPTED as well as for one attempted and rolled back, and only the
      # second exercises the restore.
      #
      #   (i) the attempt is MADE. In a MEASURED context there is no push to fall back on, so the pass ends
      #       on the atomic and the two routes separate: an attempted-and-declined atomic reports the gate
      #       INSIDE it, while one `nlIntrinsicMeasurable` pre-filtered is never walked and reports the
      #       pre-filter. Both arms, or "it was attempted" is not what is being said.
      expect(parity(session_for(measured.(atomic)))['reason']).to eq('block-level-box-unplaceable')
      expect(parity(session_for(measured.(prefiltered)))['reason']).to eq('shrink-to-fit-child-unmeasurable')
      #   (ii) …and that is the SAME name the gate answers to with no atomic around it at all. A DECLINED
      #        atomic ends the pass, so its subtree's reason is re-latched over the rollback that erased it
      #        (`nlRolledBackWhy`); without that the whole family answers `atomic-subtree-declined`, which is
      #        one string for many gates — the hole this latch exists to close, one level down.
      #        A SECOND gate through the same route, because one name proves the carry and two prove it is
      #        the gate's and not the route's. (This one used to be the counter-example here — it answered
      #        `atomic-subtree-declined`, its gate being one of the ~130 that stay anonymous — until naming
      #        that gate turned this line red and gained the census a line, which is what it is for.)
      expect(parity(session_for(%(<div style="width:400px">#{WalkRefusals::POSITIONED_INNER}</div>))))
        .to include('ok' => false, 'reason' => 'block-level-box-unplaceable')
      expect(parity(session_for(measured.(WalkRefusals::ORPHAN_ROW)))['reason']).to eq('flex-container-unsupported')
      expect(parity(session_for(%(<div style="width:400px">text #{atomic} after</div>))))
        .to include('ok' => true, 'nativeAtomics' => 0)
      # …the same rolled-back attempt, then a LATER decline in a SIBLING block. Sibling, not the same block:
      # a block classifies all its children BEFORE walking any of them, so a flex child in the same box
      # refuses first and the atomic is never reached — which is how the second version of this example
      # passed with the restore deleted too.
      expect(parity(session_for(%(<div style="width:400px"><div>text #{atomic} after</div><div>#{UNSUPPORTED_FLEX}</div></div>)))['reason'])
        .to eq('flex-container-unsupported')
    end
    # …and forgets it again before the NEXT pass. The latch is module-level state and `nlShadowRun` clears
    # it per run; nothing else in the suite would notice if that stopped, because every other example here
    # runs ONE pass per session — and a page NAVIGATION rebuilds the realm, which is the route every census
    # script takes (`session.visit` per case), so the tooling this change exists to feed cannot see it
    # either. Two passes in one realm is the only shape that can, and the element-rooted mode is how to ask
    # for them.
    it 'forgets the previous pass before the next one' do
      session = session_for(
        %(<div id="flex" style="width:400px">#{UNSUPPORTED_FLEX}</div>) +
        %(<div id="atomic" style="width:400px;overflow:hidden"><div style="float:left">t #{WalkRefusals::POSITIONED} a</div></div>) +
        %(<div id="fine" style="width:400px"><div style="height:10px">x</div></div>)
      )
      # BOTH orders. First-writer-wins means a stale latch beats the real refusal, so a single order passes
      # whenever the value left over happens to be the one wanted — and which one that is depends on the
      # order the roots were asked in, which is the whole bug.
      asked = ->(order) { order.map {|sel| parity(session, sel).values_at('ok', 'reason') } }
      expect(asked.(%w[#flex #atomic #fine])).to eq([
        [false, 'flex-container-unsupported'],
        [false, 'block-level-box-unplaceable'],
        [true, nil]
      ])
      expect(asked.(%w[#atomic #flex #fine])).to eq([
        [false, 'block-level-box-unplaceable'],
        [false, 'flex-container-unsupported'],
        [true, nil]
      ])
      # …and `#fine`'s `nil` is the key being ABSENT — a passing result carries no `reason` at all — not a
      # latch seen clear, so it reads the same with the reset deleted and proves nothing on its own. What
      # that row is for is this: two declines before it corrupt no pass that then succeeds.
      expect(parity(session, '#fine')).to include('ok' => true, 'mismatches' => 0)
    end
    it 'names the gate that stopped it' do
      # Pairs, not a hash: the same reason is asserted twice on purpose, through two different routes.
      [
        ['flex-container-unsupported',        %(<div style="width:400px">#{UNSUPPORTED_FLEX}</div>)],
        ['text-not-measurable',               '<div style="width:400px">a&shy;<b>b</b></div>'],
        # …and the last one again through a MIXED block's anonymous group, which is the other propagation
        # route — its reason has to outlive the `emitAttempt` the group is built inside. (The pair was
        # `inline-box-relative-valign`, then `block-level-box-in-inline-content`, until both went native on
        # 2026-09-24; a node-ending soft hyphen is refused by the gather on both routes alike — a preserved CR was,
        # until 2026-09-25.)
        ['text-not-measurable',               '<div style="width:400px"><p>a</p>x&shy;<b>y</b><p>b</p></div>'],
        # …and a FLOAT in a mixed block's inline run, which is the third: the float hook walks its subtree
        # DIRECTLY, so the gate inside names itself while the group's `emitAttempt` is still open and about
        # to erase it. Read at the hook site or the whole family answers `float-in-inline`. Nothing else in
        # the repo declines this way — reverting that read leaves every other layout spec green.
        ['flex-container-unsupported',        %(<div style="width:400px"><p>a</p>text <div style="float:left;width:30px">#{UNSUPPORTED_FLEX}</div> more<p>b</p></div>)],
        # …and a DECLINED atomic in a MIXED block that is itself being MEASURED, which is the fourth and the
        # one the group's `emitAttempt` reaches: `atomic.lay` re-latches the gate over its own rollback, and
        # the group's rollback then erases THAT — so the reason survives only on the object the hook returns.
        # A plain measured block (no `<p>` siblings) reads the re-latch instead and passes either way, which
        # is why this needs its own row rather than a `<p>`-less one.
        ['block-level-box-unplaceable',       %(<div style="width:400px;overflow:hidden"><div style="float:left"><p>a</p>text #{WalkRefusals::POSITIONED} more<p>b</p></div></div>)]
      ].each do |reason, body|
        expect_walk_declines(body, reason)
      end
    end
  end

  def session_for(body)
    session = simulated_session(page(body))
    session.visit '/'
    session
  end

  # Not the walk's: everything decided BEFORE it starts (no `__dom`, no root box, a root display native does
  # not lay out, a float hanging above the pass root), everything found AFTER it succeeded while the run
  # stream is marshalled, and everything Rust discovers mid-measure ('native declined', which throws the
  # whole pass away rather than this one subtree). This list is the other half of what
  # `reason == 'unsupported subtree'` used to say. That string was the walk's ONLY answer, so asserting it
  # ruled all of these out for free and said nothing else; now that reasons are specific the exclusion has
  # to be written down — and written WHOLE, since a caller pinning a reason that is on neither side of the
  # line would be claiming "the walk refused" about a pass whose walk did not refuse.
  NOT_THE_WALKS = [
    'no __dom',
    'no root box',
    'root unsupported',
    'float above the pass root',
    'run-without-white-space',            # …marshalling, after `walk` has already returned true
    'run-without-tab-stop',
    'native declined'                     # …Rust's, mid-measure
  ].freeze

  # …and the reason is REQUIRED, because an example whose only claim is `ok: false` passes for any decline
  # at all — including one that moved to a completely different gate when the shape drifted. Two callers
  # still pass `'unsupported subtree'`: that is the generic bucket, named out loud, and the day something on
  # their way latches a reason this goes red and the census gains a line. That is the point of it.
  def expect_walk_declines(body, reason)
    r = parity(session_for(body))
    expect(r['ok']).to be(false), "not declined: #{body}"
    expect(NOT_THE_WALKS).not_to include(r['reason']), r.inspect
    expect(r['reason']).to eq(reason), r.inspect
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
  # …and so does an EMPTY inline box with no horizontal edges: a line of nothing else is zero-height (§9.4.2) and
  # separates no margins, so the `<p>`'s margin still leaves its parent (Chrome: div at 15, 18 tall; after a padded
  # span it makes an 18px line and stays inside). The oracle read any inline element as a line.
  it 'hoists a margin past an empty inline box, not past a padded one' do
    [
      ['<div id="t" style="width:300px"><span></span><p style="margin:15px 0">b</p></div>', [15, 18]],
      ['<div id="t" style="width:300px"><span><span></span></span><p style="margin:15px 0">b</p></div>', [15, 18]],
      ['<div id="t" style="width:300px"><span></span></div><p>after</p>', [16, 0]],
      ['<div id="t" style="width:300px"><span style="padding-left:5px"></span><p style="margin:15px 0">b</p></div>', [0, 51]],
      # …a PERCENTAGE edge is an edge too, and PRESERVED white space is a line
      ['<div id="t" style="width:300px"><span style="padding-left:10%"></span><p style="margin:15px 0">b</p></div>', [0, 51]],
      ['<div id="t" style="width:300px;white-space:pre-wrap">  <p style="margin:15px 0">b</p></div>', [0, 51]],
      # …and a block whose inline content is only such a box around an out-of-flow child: native's text block holds
      # no line, so it collapses through like an empty block (Chrome: 0 tall, its margins joined), beside a float too
      ['<div id="t" style="position:relative;width:200px;margin:20px 0 15px"><span><div style="position:absolute;width:10px;height:10px"></div></span></div><div style="height:12px">after</div>', [20, 0]],
      ['<div style="overflow:hidden"><div style="float:left;width:30px;height:30px"></div><div id="t" style="position:relative;margin:20px 0"><span><div style="position:absolute;width:10px;height:10px"></div></span></div><p style="margin:15px 0"><i style="display:inline-block;width:4px;height:4px"></i>b</p></div>', [20, 0]]
    ].each do |body, (y, h)|
      session = simulated_session(page(body))
      session.visit '/'
      expect(session.evaluate_script("(b => [b.y, b.height])(document.getElementById('t').getBoundingClientRect())")).to eq([y, h]), body
      r = parity(session)
      expect(r['mismatches']).to eq(0), "#{body}: #{r.inspect}" if r['ok']
      expect_no_dropped_records(r, body)
    end
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

  # An OUT-OF-FLOW child of a mixed block is inline-level content of the anonymous group it sits in, so it
  # takes the same hook a text block's does: its record is emitted where the runs reach it and the marker
  # carries the index. It used to decline the whole pass (`abspos-in-mixed-block`, 1,393 shapes).
  #
  # Where the two engines agree with each other and NOT with Chrome, which the harness cannot see: an
  # out-of-flow box is BLOCKIFIED (§9.7), so its static position is the one a block-level box would have had
  # — the containing block's content edge, below the line it interrupts. Both engines give it the INLINE
  # cursor instead: `text<div abspos></div>` is at x 23.99 / y 0 here and at 0 / 18 in Chrome. Both engines
  # also drop the box's OWN margins there (§10.6.4's static position is the margin edge — Chrome puts a
  # `margin-top: 7px; margin-left: 3px` box at 3/57 against our 0/50; the INSET path applies them), and both
  # put it in the band a float leaves where Chrome, blockifying, does not. Shared and pre-existing, all of
  # it, so it is recorded rather than fixed during the port — and it is why these assert PARITY.
  # The one figure below that IS Chrome's is the one both engines had wrong, where parity says nothing.
  it 'places an absolutely-positioned child of a mixed block' do
    expect_parity('<div style="position:relative;width:300px">text<div style="position:absolute;top:5px;width:20px;height:20px"></div><div style="height:20px">block</div>more</div>')
    expect_parity('<div style="position:relative;width:300px">text<div style="position:absolute;width:20px;height:20px"></div><div style="height:20px">block</div>more</div>')
    expect_parity('<div style="position:relative;width:400px"><p>a</p>text<div style="position:absolute;width:5px;height:5px"></div><p>b</p></div>')
    # …one BEFORE any inline content in its group, where the static position is the group's own top — and the
    # preceding block's collapsed margin decides it. CHROME's figure, because BOTH engines had this wrong
    # (50 against 34) and a parity assertion would have passed on the pair of them: an out-of-flow box does
    # not end the block-margin adjacency, but its static position is where it WOULD have sat in flow, and a
    # box in flow there sits past the margin. Held for a PLAIN block too — the same rule, the other path.
    [
      '<div style="width:200px;position:relative"><p>block</p><div id="g" style="position:absolute;width:10px;height:10px"></div> aaa bbb<p>tail</p></div>',
      '<div style="width:200px;position:relative"><p>block</p><div id="g" style="position:absolute;width:10px;height:10px"></div><p>tail</p></div>'
    ].each do |body|
      session = simulated_session(page(body))
      session.visit '/'
      expect(parity(session)).to include('ok' => true, 'mismatches' => 0), body
      y = session.evaluate_script("document.getElementById('g').getBoundingClientRect().y")
      expect(y).to eq(50), "#{body}: #{y}, Chrome 50"
    end
    # …and a REPLAYED one, which carries the oracle's own displacement rather than a static position. That
    # displacement is measured against the MIXED BLOCK (`c._lb − el._lb`), so its record's parent has to be
    # the block's and not the anonymous group's, or native adds the group's origin on top of it. A containing
    # block with PERCENTAGE edges is what forces the replay — native re-derives a padding box from the
    # record's borders and cannot, so the oracle's rectangle rides instead.
    expect_parity('<div style="position:relative;padding:10%;width:300px"><p>a</p>text<div style="position:absolute;top:5px;left:5px;width:20px;height:20px"></div><p>b</p></div>')
  end

  # …and where the group it sits in holds nothing a line is made of. The box's static position is the line that
  # group never opened, and the ORACLE gives that line things a block record cannot carry: the group's
  # `text-indent` where the box opens one (11) and a float band (80, which both engines and Chrome agree on).
  # Emitting it against the block gets the container's cursor and neither.
  #
  # So such a group is KEPT — a text block of no line, as a block of its own with only an out-of-flow child already
  # was — whatever the block's alignment. Until 2026-09-24 only a left-aligned or rtl one was: the oracle left the
  # box in `lineStatics` until SOME later line closed, and moved it by that line's alignment (80.8 in a centred
  # 200px block, the centring of a `text` line after the next block child, where the same box with nothing after it
  # stayed at 0), so a centred or right-aligned block declined (`oof-in-collapsed-group`, 1,316 of the sweeps). An
  # empty line moves nothing that waits on it now, in `breakLine` as in a text block of no line. Chrome agrees for a
  # block-level box — x 0 below — and centres an INLINE-level one (150 in a 300px block): it tells the two apart by
  # the display the box had before it was blockified, which neither engine asks yet (the cascade still has it).
  # Shared, and pinned.
  #
  # THE REFUSAL WAS LIFTED ON 2026-09-23 AND PUT BACK THE SAME DAY, and what that cost is why a REPLAYED box keeps
  # the group too. An audit re-measured it, read "342 shapes lay out, 0 mismatch" and called the gate stale. The
  # rollback that precedes it had already spliced those records off the stream and nothing re-emits them, so
  # lifting it placed no box: it DROPPED 372 of them and reported `ok: true, mismatches: 0`. Three sweeps and the
  # parity spec that replaced this one all read clean, because a record that is not there compares as nothing.
  # `droppedRecords` exists now (see `spec/support/shadow_parity.rb`), and `expect_parity` asks it.
  #
  # A group has no content for five reasons, not one — `hasContent` is set by text, content whitespace, a `<br>`,
  # an atomic or an edged inline's close — so BOTH the everyday routes are here: whitespace around the box,
  # and the box ALONE after the last block, which is where a positioned dropdown or tooltip is written.
  it 'keeps the group an out-of-flow child of a mixed block sits in, whatever its alignment' do
    {
      '<div style="position:relative;width:300px;ALIGN"><p>a</p> <div id="m" style="position:absolute;width:20px;height:20px"></div> <p>b</p>text<p>c</p></div>' => [0, 50],
      '<div style="position:relative;width:300px;ALIGN"><p>a</p>text<p>b</p><div id="m" style="position:absolute;width:20px;height:20px"></div></div>'          => [0, 118]
    }.each do |body, xy|
      ['', 'text-align:center', 'text-align:right', 'text-align:justify'].each do |align|
        expect_parity(body.sub('ALIGN', align))
        expect(laid_out_rect(body.sub('ALIGN', align)).first(2)).to eq(xy)
      end
      expect_parity(body.sub('ALIGN', 'direction:rtl'))
    end
    # …the pass's own containing block with a PERCENTAGE edge, which native cannot re-derive, so the box is
    # REPLAYED — no marker in the group, and the group kept all the same.
    expect_parity('<div style="width:300px"><div style="position:relative;padding:10%;text-align:center"><p>a</p> ' \
                  '<div style="position:absolute;width:2px;height:2px"></div> <p>b</p>text</div></div>')
    span = '<div style="position:relative;width:300px;text-align:center"><p>a</p> <span id="m" style="position:absolute;width:20px;height:20px"></span> <p>b</p>text<p>c</p></div>'
    expect_parity(span)
    expect_shared_gap(laid_out_rect(span)[0], shared: 0, chrome: 150, what: "#{span}: #m x")
  end
  # …where Chrome agrees on the plain line (x 0, below the block before it) and a float band (20), and both engines
  # share two gaps with it: a `hanging` indent re-arms past a block child in both (12, Chrome 0), and a plain one
  # does not (0, Chrome 50 — it indents the first line of every anonymous block). Each block holds TEXT, or it is
  # no mixed block and its out-of-flow child goes down the plain block path, which never needed the kept group.
  it 'places the box where the group never opened a line' do
    pos = lambda {|body|
      session = simulated_session(page(%(<div style="position:relative;width:200px;font:16px monospace">#{body}</div>))); session.visit '/'
      expect(parity(session)).to include('ok' => true, 'mismatches' => 0)
      session.evaluate_script("(() => { const r = document.getElementById('m').getBoundingClientRect(); return [r.x, r.y]; })()")
    }
    oof = '<i id="m" style="position:absolute;width:5px;height:5px"></i>'
    expect(pos.(%(<div><div style="height:6px"></div> #{oof} <div style="height:6px"></div>t</div>))).to eq([0, 6])
    expect(pos.(%(<div><div style="float:left;width:20px;height:7px"></div>#{oof}<div style="height:6px"></div>t</div>))).to eq([20, 0])
    x, = pos.(%(<div style="text-indent:12px hanging"><div style="height:6px"></div>#{oof}<div style="height:6px"></div>t</div>))
    expect_shared_gap(x, shared: 12, chrome: 0, what: 'hanging indent past a block child')
    x, = pos.(%(<div style="text-indent:50px">a<div style="width:5px;height:5px"></div>#{oof}</div>))
    expect_shared_gap(x, shared: 0, chrome: 50, what: 'plain indent past a block child')
  end

  # A PRESERVING white-space in a mixed block declined until 2026-09-23 too, on the scope the gate states for
  # itself — and its note said opening it wanted "a mixed block of REAL text beside the preserved spaces to
  # measure, which no sweep holds today". That was the whole of it: the shapes were never built, so the
  # refusal was never re-asked. `sweeps/genmixws.rb` builds them now (2,160 cases), and with the refusal
  # lifted all 900 lay out with nothing diverging. What still declines is a mode native has NO CODE for,
  # which fails closed.
  it 'matches a preserve white-space mixed block' do
    ['pre', 'pre-wrap', 'break-spaces', 'pre-line'].each do |mode|
      expect_parity(%(<div style="width:300px;font:16px monospace;white-space:#{mode}">text<div style="height:20px">block</div>more   here</div>))
      expect_parity(%(<div style="width:300px;font:16px monospace;white-space:#{mode};text-indent:11px"><div>a</div>aa\tbb<div style="height:6px">b</div></div>))
    end
    # …and NOTHING declines here any more. The guard that is left is a DRIFT check between cascade.js's
    # `WS_VALUES` and layout.js's `WS_MODE`, and it is unreachable by construction: `ownWhiteSpace` answers
    # null for a value outside the first list — a vendor `-moz-pre-wrap` included, which then INHERITS — so
    # `whiteSpaceOf` can only ever hand this a member of both. The LAYOUT is what is asserted here; this
    # engine's `getComputedStyle` reports `-moz-pre-wrap` where Chrome reports `normal`, and that is a
    # cascade divergence with no business being pinned by a layout spec.
    expect_parity('<div style="width:300px;white-space:-moz-pre-wrap">text<div style="height:20px">block</div>more</div>')
  end
  # Whitespace-only direct text between a preserve block's block children is line content (the oracle lays out
  # a line box for it), which a plain block-container record would drop — so it is a MIXED block's anonymous
  # group, as the same white space beside a word always was. It declined as `white-space-only-block` until
  # 2026-09-24 (review finding, Phase 2b). Chrome: 54 and 27 tall.
  it 'lays out a preserve block container holding whitespace-only text beside its block children' do
    {
      %(<div id="m" style="width:300px;font:16px monospace;white-space:pre-wrap"><div style="height:5px"></div>\n    <div style="height:5px"></div></div>) => 54,
      %(<div id="m" style="width:300px;font:16px monospace;white-space:pre">    <div style="height:5px"></div></div>)                             => 27
    }.each do |body, chrome_h|
      expect_parity(body)
      session = session_for(body)
      expect(session.evaluate_script("document.getElementById('m').getBoundingClientRect().height")).to eq(chrome_h)
    end
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
      expect_parity('<div style="width:400px"><div style="width:max-content;text-indent:30px">aa bb</div></div>')
      expect_walk_declines(%(<div style="width:400px"><div style="width:max-content"><span style="display:inline-block">#{WalkRefusals::POSITIONED}</span></div></div>), 'block-level-box-unplaceable')
      expect_walk_declines(%(<div style="width:400px"><table><tr><td><div style="width:max-content"><div>#{WalkRefusals::UNMEASURABLE}</div></div></td></tr></table></div>), 'shrink-to-fit-child-unmeasurable')
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
    # …and every OTHER sizing path keeps its own basis, so a keyword width declines there: a replaced element (by
    # its intrinsic size — an inline one is pushed as an atomic instead of declining the pass). A GRID item and an
    # OUT-OF-FLOW box came off this list on 2026-09-24: `measure_grid` measures the one against its area
    # (native_layout_grid_spec), `place_out_of_flow` the other against the room its insets leave — and does not
    # stretch it between them, a keyword width being no `auto` (Chrome: 105.61 between `left:10px; right:20px`,
    # and a `min-content` one centred by auto margins at 140.39).
    it 'measures an out-of-flow box with a keyword width against the room its insets leave' do
      {
        '<div id="m" style="position:absolute;left:10px;right:20px;width:max-content">aa bb cc dd</div>'                => [10, 105.609375],
        '<div id="m" style="position:absolute;left:0;right:0;margin:0 auto;width:min-content">aa bb cc dd</div>'         => [140.390625, 19.203125],
        # …and the room between two insets is what they leave LESS the box's margins, as it is for an auto width
        '<div id="m" style="position:absolute;left:10px;right:20px;margin:0 30px;width:fit-content">aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp</div>' => [40, 210]
      }.each do |box, (x, w)|
        body = %(<div style="width:300px;position:relative;font:16px monospace">#{box}</div>)
        expect_parity(body)
        got = session_for(body).evaluate_script("(r => [r.x, r.width])(document.getElementById('m').getBoundingClientRect())")
        expect(got[0]).to be_within(0.05).of(x)
        expect(got[1]).to be_within(0.05).of(w)
      end
    end
    # …and the box is a MEASURED subtree between two insets too — a keyword is no `auto` to fill them — so content
    # native could lay out but not measure makes the WALK replay the oracle's box instead of failing the pass.
    it 'replays a keyword-width out-of-flow box it could not measure' do
      %w[left:0;right:0 left:0].each do |insets|
        expect_parity(%(<div style="width:300px;position:relative"><div style="position:absolute;#{insets};width:fit-content">#{WalkRefusals::UNMEASURABLE}</div></div>))
      end
    end
    it 'declines a keyword width a different sizing path owns' do
      # …the pass ROOT (sized from the width the harness hands in — native would fill its containing block and
      # report the box as laid out). A replaced element is sized by its intrinsic size and declines the same way.
      session = simulated_session(page('<div id="r" style="width:max-content">aa bb cc</div>')); session.visit '/'
      expect(parity(session, '#r')).to include('ok' => false, 'reason' => 'unsupported subtree')
      # …and the vertical writing mode's root, which has no inline size to fill either. It is the SAME hole, and
      # the root guard in `nlShadowRun` (`nlRootAutoWidthIsNotItsRoom`) now names it rather than leaving it to
      # be discovered mid-walk: a root's auto width has to be the room the harness hands over, which a vertical
      # writing mode's is not — nor a `<button>`'s, an atomic inline's or a flex item's.
      session = simulated_session(page('<div id="r" style="writing-mode:vertical-lr;height:100px">aa bb cc</div>')); session.visit '/'
      expect(parity(session, '#r')).to include('ok' => false, 'reason' => 'root unsupported')
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
      expect_parity('<div style="display:flex;width:400px"><div style="width:min-content"><div style="width:inherit;text-indent:30px">aa bb cc</div></div></div>')
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0;width:min-content"><div style="width:inherit;text-indent:30px">aa bb cc</div></td></tr></table>')
      expect_walk_declines(%(<div style="display:flex;width:400px"><div style="width:min-content"><div style="width:inherit"><span style="display:inline-block">#{WalkRefusals::POSITIONED}</span></div></div></div>), 'block-level-box-unplaceable')
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
    expect_no_dropped_records(r, body)
    expect(r['nativeOutOfFlow']).to be >= count, "the out-of-flow box was replayed, not placed natively: #{r.inspect}"
  end

  # …and the fallback: the pass still succeeds with the oracle's box REPLAYED over the container's origin.
  def expect_replayed_oof(body)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['compared']).to be > 0, "nothing was compared: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect_no_dropped_records(r, body)
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
      # …and an abspos GRID is native's own now: its shrink-to-fit width is an intrinsic measure, which both
      # engines answer with the grid algorithm — one holding a contiguous run of TEXT included, since
      # `gridItems` wraps the run in the anonymous ITEM box §4 asks for (it replayed until 2026-09-22).
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px;display:grid;grid-template-columns:100px 1fr"><div style="height:10px">a</div><div style="height:20px">b</div></div></div>))); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 1)
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px;display:grid;grid-template-columns:100px 1fr">a<div>b</div></div></div>))); session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 1)
      # …and one whose shrink-to-fit native still cannot measure DOES replay, so the counter above is not
      # simply always 1. `white-space: break-spaces` was this shape until 2026-09-23, when its measure went
      # native; `WalkRefusals::UNMEASURABLE` is where the cause lives now.
      session = simulated_session(page(%(<div style="#{cb}"><div style="position:absolute;top:10px;left:20px">#{WalkRefusals::UNMEASURABLE}</div></div>))); session.visit '/'
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
        # (a shrink-to-fit box whose own content native cannot measure — an indented one is measured natively now)
        unmeasurable = WalkRefusals::POSITIONED
        expect_replayed_oof(%(<div style="#{tb};text-indent:11px"><div style="position:absolute">#{unmeasurable}</div>mar</div>))
        expect_replayed_oof(%(<div style="#{tb};text-indent:11px">lead <div style="position:absolute">#{unmeasurable}</div> tail</div>))
        # …and the indented ones the measure now reaches lay out natively, the static position taken off the line
        expect_parity(%(<div style="#{tb};text-indent:11px"><div style="position:absolute">shrink to fit</div>mar</div>))
      end
      # `justify` widens the spaces between the words, and native spreads them itself (`line_gaps`): a box whose
      # static position comes off a justified line takes the offset that line's own gaps give it — where the walk
      # first declined the subtree and then replayed the oracle's box. However deep the box sits: a `<span>`'s
      # content is that line's.
      it 'takes a static position off a justified line' do
        expect_native_oof(%(<div style="#{tb};text-align:justify">a long stretch of words that must wrap onto a second line #{mark} tail</div>))
        expect_native_oof(%(<div style="#{tb};text-align:justify">a long stretch of words that must wrap onto a second line <span>#{mark}</span> tail here</div>))
        expect_native_oof(%(<div style="#{tb};text-align:justify">a long stretch of <span>words that #{mark} must</span> wrap onto a second line tail here</div>))
        expect_native_oof(%(<div style="#{tb};text-align:justify;direction:rtl">a long stretch of words that must wrap onto a second line #{mark} tail</div>))
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
    # …but an ANONYMOUS block box does not. A mixed block's group is created by the flow, inherits the
    # parent's `writing-mode` like any anonymous box, and the vertical arm therefore used to shrink-to-fit
    # it — after which a `text-align: center` had nothing to centre in and the atomic sat at 28.8 where the
    # oracle put it at 145.5. 400 of the 4,032 shapes in `sweeps/genvwmmix.rb`, which is the cross of a
    # writing mode with a MIXED BLOCK, and which no generator here had: `vflex`/`vflex2` cross a writing mode
    # with FLEX and `wsmixed` crosses a mixed block with white-space, so the anonymous group — where a line's
    # alignment and indent actually live — was never under a writing mode at all.
    #
    # All THREE figures are pinned, because neither engine is Chrome here and that is the point: this
    # reproduces the ORACLE deliberately. Chrome lays vertical text out (`x` 262.5, `y` 28.81 — the atomic
    # advances DOWN the line and the lines stack right-to-left); neither engine does, so both keep the atomic
    # at a horizontal `y` and move it along `x`. Making native spec-correct on its own would be a parity break,
    # and the pair is what the campaign holds. Real vertical inline layout is its own project.
    it "gives a mixed block's anonymous group the parent width, not a shrink-to-fit (Chrome: 262.5 / 28.81)" do
      atomic = '<span id="m" style="display:inline-block;width:9px;height:4px"></span>'
      mixed  = %(<div style="height:120px"><div style="font:16px monospace;width:300px;writing-mode:vertical-rl;text-align:center"><div style="height:6px">B</div>aa #{atomic} bb</div></div>)
      # …the same shape WITHOUT the block child, so the group is not anonymous: both engines already agreed
      # there, which is what said the anonymity was the axis and not the writing mode.
      plain  = %(<div style="height:120px"><div style="font:16px monospace;width:300px;writing-mode:vertical-rl;text-align:center">aa #{atomic} bb</div></div>)
      # …and the horizontal twin, where all three engines agree.
      horiz  = %(<div style="height:120px"><div style="font:16px monospace;width:300px;text-align:center"><div style="height:6px">B</div>aa #{atomic} bb</div></div>)
      # …both axes pinned, and a tripwire on BOTH: `y` is where real vertical inline layout would show up first
      # (Chrome advances the atomic DOWN the line, so it reads 28.81 where both engines read a horizontal 19),
      # and a tripwire that guards only `x` would let that land unnoticed.
      {
        mixed => [[145.5, 19], [262.5, 28.81]],
        plain => [[145.5, 13], [284.5, 28.81]],
        horiz => [[145.5, 19], [145.5, 19]]
      }.each do |body, (shared, chrome)|
        expect_parity(body)
        session = simulated_session(page(body))
        session.visit '/'
        got = session.evaluate_script("(() => { const b = document.getElementById('m').getBoundingClientRect(); return [+b.x.toFixed(2), +b.y.toFixed(2)]; })()")
        %w[x y].each_with_index do |axis, i|
          expect_shared_gap(got[i], shared: shared[i], chrome: chrome[i], what: "#{body}: #{axis}")
        end
      end
    end

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
      expect_walk_declines(%(<div style="width:400px"><div style="writing-mode:vertical-lr"><div>#{WalkRefusals::UNMEASURABLE}</div></div></div>), 'shrink-to-fit-child-unmeasurable')
      expect_walk_declines(%(<div style="width:400px"><div style="writing-mode:vertical-lr">#{WalkRefusals::POSITIONED}</div></div>), 'block-level-box-unplaceable')
    end
    # …which is also why such a child is walked as a MEASURED subtree: an atomic inline whose own box would be
    # PUSHED is not in the run stream native measures from, so the walk has to decline where it would otherwise
    # hand Rust a subtree it cannot re-measure. Every shape here lays out natively without the writing mode.
    it 'declines a vertical block whose atomic inline is pushed, not laid out natively' do
      # One entry of `WalkRefusals::ATOMIC`, deliberately, where it stands on a line three ways: that list is what
      # the atomic ROUTE refuses, and this is a different route — a vertical block measures its own width, so what
      # it declines is what it cannot MEASURE, under the name of the gate inside. Written out rather than
      # filtered, so a reader sees the shapes.
      [
        %(a #{WalkRefusals::POSITIONED}),
        %(a <span style="display:inline-block">#{WalkRefusals::POSITIONED}</span>),
        %(a<br>b #{WalkRefusals::POSITIONED})
      ].each do |inner|
        expect_walk_declines(%{<div style="width:400px"><div style="writing-mode:vertical-lr">#{inner}</div></div>}, 'block-level-box-unplaceable')
      end
      # …and through a GRID item, whose subtree is measured for the track sizes
      expect_walk_declines(%(<div style="display:grid;grid-template-columns:200px;width:400px"><div><div style="writing-mode:vertical-lr">a #{WalkRefusals::POSITIONED}</div></div></div>), 'block-level-box-unplaceable')
      # …and the same content in a HORIZONTAL block lays out, the atomic pushed rather than the pass declined.
      expect_parity(%(<div style="width:400px"><div>a #{WalkRefusals::POSITIONED}</div></div>))
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
      expect_replayed_oof(%{<div style="width:400px;height:200px"><div style="position:absolute;left:30px">a #{WalkRefusals::POSITIONED}</div></div>})
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
    pushed_atomic = %(a #{WalkRefusals::POSITIONED})
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
      # and the shared list's whitespace-only atomic is measurable here.
      [
        %(<span style="display:inline-block">#{WalkRefusals::POSITIONED}</span>),
        WalkRefusals::POSITIONED
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
  # declined the whole table. A pushed atomic (an inline-block the walk refuses inside) stands in for it now.
  describe 'a cell whose content native cannot lay out pushes its contribution' do
    it 'lays out a table around a cell holding an atomic native does not lay out' do
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0">a #{WalkRefusals::POSITIONED}</td><td style="padding:0">cc</td></tr></table>})
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0">a #{WalkRefusals::POSITIONED}</td></tr></table>})
      expect_parity(%{<table style="border-spacing:0"><tr><td style="padding:0;width:50px">a #{WalkRefusals::POSITIONED}</td></tr></table>})
      expect_parity(%{<div style="display:table;border-spacing:0"><div style="display:table-row"><div style="display:table-cell">a #{WalkRefusals::POSITIONED}</div></div></div>})
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
    # …a FLOAT too: a sticky float is a float, and its box needs nothing a static one's does not.
    it 'takes a sticky float' do
      expect_parity('<div style="width:400px"><div style="position:sticky;top:0;float:left;width:40px;height:10px"></div><div>text beside it</div></div>')
      expect_parity('<div style="width:400px;height:200px;overflow:auto"><div style="height:50px"></div><div style="position:sticky;top:0;float:left;width:40px;height:10px"></div></div>')
    end
  end

  # …and a RELATIVELY SHIFTED float, which declined in all three of the walk's float positions until
  # 2026-09-20 on the argument that it "carries an offset native would have to apply". Native applies one to
  # every other box the same way — `rec[39..40]`, added in `place` after the flow — and what makes it right
  # for a float is that §9.4.3 is a PAINT-time shift: the box moves and the RECTANGLE the formatting context
  # excludes at does not. That separation already existed for an ancestor's shift (the `relfloat` sweep is
  # about exactly that); the float's OWN offset went through the same field and nothing had to change.
  #
  # So every example pins BOTH halves: the float's box carries the offset, and a following box that routes
  # around the band or CLEARS it stands where the unshifted rectangle puts it.
  describe 'a relatively shifted float' do
    # …and every shape here has to make the BAND observable, which is not automatic and is where a first
    # version of this example went wrong: the parity compare looks at element BOXES, so a band that moved with
    # the box shows up only where some compared box reads it. A `clear` below a flow cursor that has already
    # passed the float reads nothing, and a purely HORIZONTAL shift moves only line content, which is not a
    # box at all. What works is a VERTICAL component on the float's own offset plus either an `overflow:hidden`
    # owner (whose height is `floats_bottom`) or a `clear` the flow has not already passed. Measured against an
    # engine deliberately broken to move the band with the box: 8 of the first 10 shapes caught nothing.
    it 'moves the box and not the band, in each position the walk gates' do
      # a block-level float, an auto-width one, and a percentage offset
      expect_parity('<div style="width:400px;overflow:hidden"><div style="position:relative;left:12px;top:-7px;float:left;width:40px;height:50px"></div><div>text beside it</div><div style="clear:left;height:5px"></div></div>')
      expect_parity('<div style="width:400px;overflow:hidden"><div style="position:relative;left:-18px;top:6px;float:left">a b c</div><div>one two three four five six</div></div>')
      expect_parity('<div style="width:400px;height:120px;overflow:hidden"><div style="position:relative;top:25%;float:right;width:40px;height:10px"></div><div>text</div><div style="clear:both;height:5px"></div></div>')
      # …written in INLINE content, which is a second gate (`nlGatherRuns`'s float hook)
      expect_parity('<div style="width:200px;overflow:hidden">aaa <div style="position:relative;left:9px;top:6px;float:left;width:50px;height:20px"></div>bbb ccc ddd eee fff ggg</div>')
      expect_parity('<div style="width:200px">aaa <div style="position:relative;left:9px;top:6px;float:left;width:50px;height:20px"></div>bbb ccc<div style="clear:left;height:5px"></div></div>')
      # …and in a MIXED block, which is a third (the anonymous group's own hook)
      expect_parity('<div style="width:200px;overflow:hidden"><p>a</p>text <span style="position:relative;top:8px;left:-6px;float:left;width:50px;height:30px"></span>more text<p style="clear:left">b</p></div>')
    end
    # …while an ancestor's shift and the float's own compose, each through its own record.
    it 'composes with an ancestor shift' do
      expect_parity('<div style="width:400px;overflow:hidden"><div style="position:relative;top:10px;left:20px"><div style="position:relative;left:12px;top:9px;float:left;width:40px;height:50px"></div></div><div style="clear:left;height:5px"></div></div>')
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
    # A flex item whose box is PUSHED (the atomic inside it) keeps its min/max-height — the floor a flex
    # container item two-phases its auto height against — and a percentage one went over as a fraction the push then
    # cleared: the item recomputed its height from content with no floor (40 where the oracle's is 128). The push
    # resolves it against the oracle's basis instead, as the border-box figure the rest of the push keeps.
    it 'resolves a pushed item\'s percentage clamp in the push' do
      expect_parity(%(<div style="display:flex;height:180px;align-items:flex-start"><div style="display:flex;align-items:center;min-height:60%;padding:10px 0"><div>t #{WalkRefusals::POSITIONED}</div><div style="height:20px;width:10px"></div></div></div>))
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

  # A margin or padding written as a comparison function over affine operands — `max(10%, 12px)`, `clamp(4px, 5%,
  # 30px)`, a bare calc-sum argument (`clamp(0px, 10% - 20px, 40px)`) — travels as its clamped pair
  # (`nlClampedEdgeParts`, rec[168..199]) and native resolves it against the box's own basis; the walk resolved it
  # against the oracle's. Chrome's box.
  it 'resolves a margin and a padding written as comparison functions natively' do
    body = '<div style="width:300px"><div id="m" style="margin-top:max(10%, 12px);padding:clamp(4px, 5%, 30px) clamp(0px, 10% - 20px, 40px);' \
           'border:2px solid">x</div></div>'
    expect_parity(body)
    expect(laid_out_rect(body)).to eq([0, 30, 300, 52])
  end
end