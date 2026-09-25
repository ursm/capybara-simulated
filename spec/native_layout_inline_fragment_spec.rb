# frozen_string_literal: true

# An inline box's FRAGMENTS — one rect per line its content reached, which is what `getClientRects` answers and
# what a relative inline hands an out-of-flow descendant as its containing block. Native lays them out beside the
# oracle's `settleInlineBoxes` (`fragsCompared` / `fragMismatches` off `__csimLayoutShadowRun`), and a box's own
# record says nothing about them: an EMPTY `<span>` is a zero-width box either way, and whether it has a height,
# and where, is a fragment question. So each shape here asserts the fragment parity AND Chrome's rects for `#m`.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'

RSpec.describe 'native layout inline box fragments', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  RECTS = "Array.from(document.getElementById('m').getClientRects()).map(r => [r.x, r.y, r.width, r.height])"

  # The pass's fragment verdict and `#m`'s client rects, off one page.
  def fragments(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      [session.evaluate_script('globalThis.__csimLayoutShadowRun()'), session.evaluate_script(RECTS)]
    end
  end

  def rects_near?(got, want)
    got.size == want.size && got.zip(want).all? {|g, w| g.zip(w).all? {|a, b| (a - b).abs <= 0.05 } }
  end

  # `chrome:` where both engines give Chrome's rects; `shared:` + `shared_chrome:` where both give another —
  # checked Chrome FIRST, so the day one moves onto Chrome's figure the failure says "a fix", not "a regression".
  def expect_fragments(body, chrome: nil, shared: nil, shared_chrome: nil)
    raise ArgumentError, 'shared needs shared_chrome' if !shared.nil? && shared_chrome.nil?

    r, rects = fragments(body)
    expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
    expect(r['fragsCompared']).to be > 0, "#{body}: no fragment was compared: #{r.inspect}"
    expect(r['fragMismatches']).to eq(0), "#{body}: #{r['fragSample'].inspect}"
    expect_no_dropped_records(r, body)
    expect(rects_near?(rects, chrome)).to be(true), "#{body}: #m #{rects.inspect}, Chrome #{chrome.inspect}" unless chrome.nil?
    return if shared.nil?

    expect(rects_near?(shared, shared_chrome)).to be(false), "#{body}: shared and Chrome agree — pass it as `chrome:`"
    expect(rects_near?(rects, shared_chrome)).to(
      be(false),
      "#{body}: #m #{rects.inspect} now AGREES with Chrome — a fix, not a regression: pin it as `chrome:`"
    )
    expect(rects_near?(rects, shared)).to be(true), "#{body}: #m #{rects.inspect}; both engines say #{shared.inspect}, Chrome #{shared_chrome.inspect}"
  end

  it 'lays out an edged box and an edge-only one on their line' do
    expect_fragments(
      '<div style="font:16px monospace;width:400px">aa <span id="m" style="padding:0 5px;border-left:2px solid">bb</span> cc</div>',
      chrome: [[28.8125, 0, 31.203125, 22]]
    )
    expect_fragments(
      '<div style="font:16px monospace;width:400px">aa <span id="m" style="padding-left:6px"></span> cc</div>',
      chrome: [[28.8125, 0, 6, 22]]
    )
    # …percentage edges resolved against the block's content width — by native itself, from the fractions the inline
    # table carries (the walk used to resolve them against the oracle's basis) — and one per line where it wraps,
    # the opening edge on the first and the closing one on the last.
    expect_fragments(
      '<div style="font:16px monospace;width:60px">x <span id="m" style="padding:0 3px">aaaa bbbb cc</span> d</div>',
      chrome: [[0, 22, 41.40625, 22], [0, 44, 38.40625, 22], [0, 66, 22.203125, 22]]
    )
    body = '<div style="font:16px monospace;width:200px">aa <span id="m" style="padding:5% 10%;margin-left:-2%">bb cc dd ee ff gg</span> hh</div>'
    expect_fragments(body, chrome: [[24.8125, -10, 154.40625, 42], [0, 12, 39.203125, 42]])
    r = with_simulated_session(page(body)) do |session|
      session.visit '/'
      session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
    end
    expect(r).to include('ok' => true, 'mismatches' => 0)
    expect(r['oracleReads'].keys).to eq(['nlShadowRun the pass root origin and width (handed over)'])
  end

  # An EMPTY box takes a fragment only where there is a line box to take it on, and the line is the one it OPENED
  # on — which a `<br>` or a preserved newline makes a line box even with nothing on it. Both engines asked the
  # line the box CLOSED on (the next one, or none at all) and gave all three of these no height.
  # …and edges written as COMPARISON functions, which the inline table carries as pairs between their bounds since
  # 2026-09-25 — the opening edge's margin and padding clamping apart, a `calc()` padding floored at 0 (3 - 5 here) —
  # where the walk used to resolve them against the oracle's basis. Chrome's rects, and no oracle read.
  it 'lays out an inline box whose edges are clamped percentages' do
    {
      '<div style="font:16px monospace;width:300px">aa <span id="m" style="padding:0 clamp(4px, 5%, 20px)">bb</span> cc</div>'                   => [[28.8125, 0, 49.2031, 22]],
      '<div style="font:16px monospace;width:120px">aa <span id="m" style="margin-left:max(5%, 10px);border-left:2px solid">bb</span> cc</div>' => [[38.8125, 0, 21.2031, 22]],
      '<div style="font:16px monospace;width:30px">x <span id="m" style="padding-right:calc(10% - 5px);border-right:2px solid">bb</span> c</div>' => [[0, 22, 21.2031, 22]]
    }.each do |body, chrome|
      expect_fragments(body, chrome: chrome)
      reads = with_simulated_session(page(body)) do |session|
        session.visit '/'
        session.evaluate_script('document.body.offsetHeight')
        session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')['oracleReads'].keys
      end
      expect(reads.grep_v(/\(handed over\)\z/)).to be_empty, "#{body}: #{reads.inspect}"
    end
  end
  # …and a RELATIVE inline box's percentage offsets, which travel as the chain `nlChainRel` sums (a length, a fraction
  # of the block's width, of its height where definite, and the figure where it is not) and native resolves against the
  # block laying the line out — for the box's own fragments and for an atomic in it — where the walk resolved them
  # against the oracle's stamps until 2026-09-25. A `top: 20%` of an indefinite height is `auto`, so `bottom` is used.
  # …and a COMPARISON function's share as a program per axis beside them (`xm` / `ym`, a `right` one negated) since
  # 2026-09-26 — two nested boxes' summed, a `top` one `auto` against an indefinite height as a percentage is. Chrome's
  # rects, and no oracle read.
  it 'offsets a relative inline box by percentages of the block it is laid out in' do
    {
      '<div style="width:300px;height:200px;font:16px monospace">aa <span id="m" style="position:relative;left:max(10%, 5px);top:min(10%, 3px)">bb</span></div>' => [[58.8125, 3, 19.2031, 22]],
      '<div style="width:300px;height:200px;font:16px monospace">aa <span style="position:relative;left:max(10%, 5px);top:min(10%, 3px)">bb <span id="m" style="display:inline-block;width:4px;height:4px"></span></span></div>' => [[87.625, 16, 4, 4]],
      '<div style="width:300px;font:16px monospace">aa <span style="position:relative;right:max(5%, 2px);top:min(10%, 3px)">bb <span id="m" style="display:inline-block;width:4px;height:4px"></span></span></div>' => [[42.625, 13, 4, 4]],
      '<div style="width:300px;height:200px;font:16px monospace">aa <span style="position:relative;left:min(10%, 20px)"><span style="position:relative;right:max(5%, 2px)">bb <span id="m" style="display:inline-block;width:4px;height:4px"></span></span></span></div>' => [[62.625, 13, 4, 4]],
      '<div style="font:16px monospace;width:300px;height:120px">aa <span id="m" style="position:relative;left:10%;top:20%">bb</span> cc</div>' => [[58.8125, 24, 19.2031, 22]],
      '<div style="font:16px monospace;width:300px">aa <span id="m" style="position:relative;top:20%;bottom:6px">bb</span> cc</div>'           => [[28.8125, -6, 19.2031, 22]],
      '<div style="font:16px monospace;width:300px;height:120px">aa <span style="position:relative;left:10%;top:10%">bb <span id="m" style="display:inline-block;width:30px;height:12px;position:relative;left:10%"></span></span></div>' => [[117.625, 17, 30, 12]]
    }.each do |body, chrome|
      expect_fragments(body, chrome: chrome)
      reads = with_simulated_session(page(body)) do |session|
        session.visit '/'
        session.evaluate_script('document.body.offsetHeight')
        session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')['oracleReads'].keys
      end
      expect(reads.grep_v(/\(handed over\)\z/)).to be_empty, "#{body}: #{reads.inspect}"
    end
    # …an out-of-flow box in the chain moves by it too (SHARED: its static position is after the space before it in
    # both engines, 57.6 + 30, where Chrome's is before it, 48.02 + 30 — without the chain as well)
    expect_fragments(
      '<div style="width:300px;height:200px;font:16px monospace">aa <span style="position:relative;left:max(10%, 5px);bottom:clamp(1px, 5%, 4px)">bb <i id="m" style="position:absolute;width:2px;height:2px"></i></span></div>',
      shared: [[87.6, -4, 2, 2]], shared_chrome: [[78.0156, -4, 2, 2]]
    )
  end
  # A SOFT hyphen breaks the line where the next piece does not fit and shows a hyphen there — natively since
  # 2026-09-26 (`take_break!`), where the walk declined every one before. The piece goes plain where the next one fits,
  # takes the hyphen where that leaves room for it, and where neither fits the line ends at the soft hyphen before it,
  # whose hyphen shows after all ("aa" / "bb" in 39px); a fresh line takes the hyphen even where it overflows; the
  # hyphen is the bare `-` advance, no letter-spacing after it; min-content counts it. SHARED: Chrome gives the hyphen
  # a client rect of its own, both engines fold it into the box's line.
  it 'breaks at a soft hyphen and shows the hyphen there' do
    {
      '<div style="font:16px monospace;width:39px"><span id="m">aa&shy;bb&shy;cc</span></div>'                     => [[[0, 0, 28.8, 22], [0, 22, 38.4, 22]], [[0, 0, 19.2031, 22], [19.2031, 0, 9.6094, 22], [0, 22, 38.4063, 22]]],
      '<div style="font:16px monospace;width:60px"><span id="m">aaaabbb&shy;cc</span></div>'                       => [[[0, 0, 76.8, 22], [0, 22, 19.2, 22]], [[0, 0, 67.2031, 22], [67.2031, 0, 9.6094, 22], [0, 22, 19.2031, 22]]],
      '<div style="font:16px monospace;width:50px;letter-spacing:2px"><span id="m">aaaa&shy;bbbb</span></div>'      => [[[0, 0, 56, 22], [0, 22, 46.4, 22]], [[0, 0, 46.4063, 22], [46.4063, 0, 9.6094, 22], [0, 22, 46.4063, 22]]],
      '<div style="font:16px monospace;width:min-content"><span id="m">aa&shy;bbbb</span></div>'                   => [[[0, 0, 28.8, 22], [0, 22, 38.4, 22]], [[0, 0, 19.2031, 22], [19.2031, 0, 9.6094, 22], [0, 22, 38.4063, 22]]]
    }.each do |body, (shared, chrome)|
      expect_fragments(body, shared: shared, shared_chrome: chrome)
    end
  end
  # …and one that ENDS its text node leaves the opportunity, hyphen and all, to whatever comes next (the oracle's
  # `barrier.shy`, native's `PendingHyphen` — declined by the walk until 2026-09-26): the next run's first unit breaks
  # there and the hyphen shows on the line it ends, in the boxes that were open at the piece — a `<b>` closed since
  # still takes it, an `<i>` opened since takes nothing on that line, and an opening edge still pending waits for the
  # fresh line. An atomic breaks there too; a space in between replaces it, and no hyphen shows. SHARED: Chrome gives
  # the hyphen a rect of its own, both engines fold it into the box's line — and puts it INSIDE a closing padding,
  # where both engines put it after (the same total).
  it 'carries a soft hyphen that ends its text node to the next run' do
    expect_fragments('<div style="font:16px monospace;width:39px">aa&shy;<span id="m">bb&shy;cc</span></div>', chrome: [[0, 22, 38.4063, 22]])
    expect_fragments('<div style="font:16px monospace;width:60px"><b>aaaa&shy;</b><i id="m">bbbb</i></div>', chrome: [[0, 22, 38.4063, 22]])
    expect_fragments('<div style="font:16px monospace;width:30px"><span id="m">aa&shy;</span><span> bb</span></div>', chrome: [[0, 0, 19.2031, 22]])
    expect_fragments('<div style="font:16px monospace;width:60px">aaaa&shy;<span id="m" style="padding-left:5px">bb</span></div>', chrome: [[0, 22, 24.2031, 22]])
    expect_fragments('<div style="font:16px monospace;width:60px"><span id="m" style="padding-right:4px">aaaa&shy;</span>bbbb</div>', chrome: [[0, 0, 52.0156, 22]])
    {
      '<div style="font:16px monospace;width:60px"><b id="m">aaaa&shy;</b><i>bbbb</i></div>'                                                          => [[0, 0, 38.4063, 22], [38.4063, 0, 9.6094, 22]],
      '<div style="font:16px monospace;width:50px"><span id="m">aaaa&shy;</span><span style="display:inline-block;width:30px">x</span></div>' => [[0, 0, 38.4063, 22], [38.4063, 0, 9.6094, 22]]
    }.each do |body, chrome|
      expect_fragments(body, shared: [[0, 0, 48, 22]], shared_chrome: chrome)
    end
    # SHARED: min-content. Chrome takes the opportunity there (48.02, `aaaa-` / `bb`); the oracle's `addUnit` counts
    # the hyphen as a candidate but opens no opportunity after a node's LAST piece, so `bb` joins the word, and
    # native measures what the oracle measures.
    expect_fragments(
      '<div id="m" style="font:16px monospace;width:min-content">aaaa&shy;<span>bb</span></div>',
      shared: [[0, 0, 57.6, 22]], shared_chrome: [[0, 0, 48.0156, 44]]
    )
  end

  it 'gives an empty box the line it opened on, a forced break making that a line' do
    expect_fragments('<div style="font:16px monospace;width:400px"><span id="m"></span><br></div>', chrome: [[0, 0, 0, 22]])
    expect_fragments('<div style="font:16px monospace;width:400px">x<span id="m"><br></span></div>', chrome: [[9.609375, 0, 0, 22]])
    expect_fragments(
      '<div style="font:16px monospace;width:400px;white-space:pre-line">x<span id="m">&#10;</span></div>',
      chrome: [[9.609375, 0, 0, 22]]
    )
    # …and a line that never became one still gives it none (Chrome: 0 tall before a block) — not even the answer
    # of a line that closes AFTER the block child, which the oracle's `breakLine` left it waiting for (22, the
    # height of the padded box's line below).
    expect_fragments('<div style="font:16px monospace;width:400px"><span id="m"></span><div>b</div></div>', chrome: [[0, 0, 0, 0]])
    expect_fragments(
      '<div style="font:16px monospace;width:400px"><span id="m"></span><div>b</div><span style="padding-left:4px"></span></div>',
      chrome: [[0, 0, 0, 0]]
    )
  end

  # An empty box opens PAST the block margin still open above it, as any placement is: read at the bare cursor it
  # sat inside a `margin-bottom: 10px` (y 22 where Chrome says 32).
  it 'opens an empty box past the margin still open above it' do
    expect_fragments(
      '<div style="font:16px monospace;width:400px"><div style="margin-bottom:10px">a</div>' \
      '<span id="m"></span><span style="padding-left:4px"></span></div>',
      chrome: [[0, 32, 0, 22]]
    )
  end

  # …and at the start of the float band THERE: a float placed past that margin is beside the line the box lands on,
  # not beside the cursor before the margin, whose band the oracle read (0 where native and Chrome say 25).
  it 'opens an empty box beside a float placed past the margin still open above it' do
    float = '<div style="margin-bottom:30px">p</div><i style="float:left;width:25px;height:30px"></i><span id="m"></span>x'
    expect_fragments(%(<div style="font:16px monospace;width:90px">#{float}</div>), chrome: [[25, 52, 0, 22]])
    expect_fragments(%(<div style="font:16px monospace;width:90px;text-align:center">#{float}</div>), chrome: [[52.6875, 52, 0, 22]])
  end

  # A `<wbr>` is an empty inline box of its own to the oracle, and its fragment takes its OWN relative offset as well
  # as the chain's (native had only the chain's: 9.6 where the oracle says 14.6 — Chrome gives a `<wbr>` no client rect
  # at all, a shared divergence). It has NO EDGES, whatever it declares — Chrome has no box to put them on, so
  # `aa<wbr style="padding-left:20px;…">bb` is 38.41 wide there — where the oracle's flow placed them (71.4) and its
  # measure did not, and native refused one; both engines place none since 2026-09-26. One that is not `display:
  # inline` is no inline box: an inline-block `<wbr>` is an atomic.
  it 'lays a <wbr> out as the inline box it is' do
    expect_fragments('<div style="font:16px monospace;width:100px">a<wbr id="m" style="position:relative;left:5px;top:3px">b</div>')
    {
      '<div style="font:16px monospace;width:300px">aa<wbr style="padding-left:20px;margin-right:10px;border-left:3px solid">bb<span id="m" style="display:inline-block;width:4px;height:4px"></span></div>' => [[38.4063, 13, 4, 4]],
      '<div style="font:16px monospace;width:max-content">aa<wbr style="padding-left:10%;margin-right:10px">bb<span id="m" style="display:inline-block;width:4px;height:4px"></span></div>' => [[38.4063, 13, 4, 4]]
    }.each do |body, chrome|
      expect_fragments(body, chrome: chrome)
    end
    r, = fragments('<div style="font:16px monospace;width:100px">aaaa <wbr id="m" style="display:inline-block">bbbb</div>')
    expect(r).to include('ok' => true, 'mismatches' => 0)
    expect(r['nativeAtomics']).to be > 0, r.inspect
  end

  # The space before a `pre-line` newline is a collapsible one the oracle PLACES on the line the newline ends, and
  # the break eats: a box holding it has a line record there, and hangs from that line's baseline. Native dropped
  # the space outright, so the box fell back to where it opened — the line's top.
  it 'hangs an empty box holding the space before a pre-line newline from its baseline' do
    expect_fragments(
      '<div style="font:16px monospace;width:400px;line-height:0;white-space:pre-line">x<span id="m"> &#10; </span></div>',
      chrome: [[9.609375, -11, 0, 22]]
    )
    # …where one with no placement at all still sits at the line's TOP in both engines (Chrome hangs it from the
    # baseline too).
    expect_fragments(
      '<div style="font:16px monospace;width:400px;line-height:0">x<span id="m"></span></div>',
      shared: [[9.6, 0, 0, 22]], shared_chrome: [[9.609375, -11, 0, 22]]
    )
  end

  # A U+00A0 a word ENDS in is a justification gap only once something follows it on the line — the oracle holds it
  # back like any trailing separator (`tailGaps`). Native counted it at once, so a line that wrapped right after it
  # spread its whole free width over its own end and moved what stood past the space: 45 where the oracle and
  # Chrome say 28.8 — for an out-of-flow marker's box, not only a fragment.
  it 'holds back a justification gap a word ends in' do
    expect_fragments(
      '<div style="font:16px monospace;width:45px;text-align:justify">aa&nbsp;<span id="m"></span>bb q</div>',
      chrome: [[28.8125, 0, 0, 22]]
    )
    body = '<div style="position:relative;font:16px monospace;width:45px;text-align:justify">aa&nbsp;' \
           '<i id="m" style="position:absolute;width:2px;height:2px"></i>bb q</div>'
    r, rects = fragments(body)
    expect(r).to include('ok' => true, 'mismatches' => 0)
    expect(rects_near?(rects, [[28.8125, 0, 2, 2]])).to be(true), "#m #{rects.inspect}"
  end

  # A relatively positioned INLINE is the containing block of an out-of-flow box inside it (CSS 2.1 §10.1): its
  # padding box runs from the FIRST fragment's top-left to the LAST one's bottom-right — not their union — and native
  # takes it from the fragments it lays the inline out as, where the walk used to hand over the oracle's rectangle.
  {
    'a wrapping inline, both insets on each axis' =>
      ['<div style="position:relative;width:90px;font:16px monospace">aaaa <span style="position:relative;border:2px solid;padding:0 4px">' \
       'bb cc dd ee<i id="m" style="position:absolute;top:1px;left:2px;right:3px;bottom:4px"></i></span> ff</div>',
       [52.015625, 1, 25.796875, 39]],
    'percentage sizes and insets, a relative offset, a centred line' =>
      ['<div style="position:relative;width:220px;font:16px monospace;text-align:center">aaaa <span style="position:relative;left:3px;top:1px;padding-left:6px">' \
       'bb <i id="m" style="position:absolute;width:50%;height:50%;top:10%;left:25%"></i>cc</span> dd</div>',
       [109.09375, 3.1875, 27, 11]],
    'from inside an inline-block' =>
      ['<div style="position:relative;width:220px;font:16px monospace">aa <span style="position:relative">b <span style="display:inline-block;width:40px">' \
       'c <i id="m" style="position:absolute;bottom:100%;left:0;right:0;height:4px"></i>d</span> e</span> f</div>',
       [28.8125, -4, 78.40625, 4]]
  }.each do |what, (body, chrome)|
    it "places an out-of-flow box against a relative inline's fragments: #{what}" do
      r, = fragments(body)
      expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
      expect(r['nativeOutOfFlow']).to be > 0, "#{body}: the box was not placed natively: #{r.inspect}"
      expect_no_dropped_records(r, body)
      rect = with_simulated_session(page(body)) do |session|
        session.visit '/'
        session.evaluate_script("(r => [r.x, r.y, r.width, r.height])(document.getElementById('m').getBoundingClientRect())")
      end
      expect(rects_near?([rect], [chrome])).to be(true), "#{body}: #m #{rect.inspect}, Chrome #{chrome.inspect}"
    end
  end

  # Both engines break after a U+00A0 at an inline boundary, which is no break opportunity (UAX #14: NBSP is GL);
  # Chrome keeps `aa&nbsp;bb` on one line and overflows.
  it 'breaks after a no-break space at an inline boundary (shared)' do
    expect_fragments(
      '<div style="font:16px monospace;width:45px"><b>aa&nbsp;</b><b id="m">bb</b></div>',
      shared: [[0, 22, 19.2, 22]], shared_chrome: [[28.8125, 0, 19.203125, 22]]
    )
  end

  # A piece's end and the gap after it are the same pen, and have to be read as the same SUM: native read the end
  # as `at + w` and the gap as `band_l + line_x`, one ULP apart, and a piece ending exactly where the next gap began
  # counted that gap as one before its end — a whole extra share of the spread.
  it 'reads a piece ending at a justification gap as ending before it' do
    expect_fragments(
      '<div style="font:16px monospace;width:100px;text-align:justify;text-indent:8px">x<span id="m" style="white-space:pre"> </span>' \
      '<span style="margin-right:-12px"> </span>bbbb bbbb end</div>',
      chrome: [[17.609375, 0, 27.984375, 22]]
    )
  end
end
