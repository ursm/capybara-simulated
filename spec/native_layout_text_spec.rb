# frozen_string_literal: true
# Native layout L2 (inline/text) — geometry shadow-parity: a text-containing block's native height
# (greedy line count × line-height, measured in-process via fontations) must equal the JS layout's `_lb`
# on pure-text blocks (single font, every `white-space` mode). Validates the native line breaker + text-block
# height against the JS oracle. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'
# …and the enumerator the Unicode drift check asks the engine with.
require_relative 'support/unicode_classes'

RSpec.describe 'native layout L2 text-block parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  # The charset is declared because the CJK shapes below are UTF-8 in this file's own source: served without
  # it they would decode as windows-1252 and the specs would be testing mojibake rather than Japanese.
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  def parity(session)
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  # ONE session per body, DISPOSED at the end of the block rather than at the end of the example: an example
  # that lays out ten shapes would otherwise hold ten V8 isolates at once (measured: 473 MB against 213 MB
  # for a two-shape one, ~26 MB apiece), which is the shape of leak that has run this suite out of memory
  # before — see spec/support/session_teardown.rb, whose `with_simulated_session` exists for exactly this.
  def with_page(body)
    with_simulated_session(page(body)) do |session|
      session.visit '/'
      yield session
    end
  end

  def shadow(body)
    with_page(body) {|session| parity(session) }
  end

  # Where the marker `#m` sits, which is how a shape says what it is about. Parity is blind to a rule both
  # engines get wrong the SAME way — the harness only ever asks whether they AGREE — so a rule read out of
  # Chrome rather than out of the oracle has to have the Chrome NUMBER asserted too, which is what the
  # `chrome_x` argument of `expect_parity` / `expect_declined_x` below is for.
  def marker_x(session)
    session.evaluate_script("document.querySelector('#m').getBoundingClientRect().x")
  end

  # …and WHICH LINE it landed on, for a rule about a forced break: `x` says nothing there, since a break
  # moves the marker down rather than across.
  def marker_y(session)
    session.evaluate_script("document.querySelector('#m').getBoundingClientRect().y")
  end

  # Within 0.05px throughout: the engines measure from the font file's own advances, so they land a hair off
  # Chrome's rounding — 9.6 against 9.609375 per monospace character.
  def expect_near(got, chrome, body, axis)
    expect(got).to be_within(0.05).of(chrome), "#{body}: #m at #{axis} #{got}, Chrome #{chrome}"
  end

  # …and its sibling for a figure the two engines AGREE on where Chrome gives another. `chrome_x` stays what
  # it says it is — a number read out of Chrome — so a shared divergence gets a slot of its own rather than
  # being smuggled through that one, which would put a wrong number in the failure message and make a future
  # conformance FIX read as a regression. Chrome's own figure is named in the message instead.
  # The two must actually DIFFER: passing the same number twice means the shape was never a divergence and
  # belongs in `chrome_x`, and nothing else would ever say so — `chrome` is otherwise read only when the
  # example is already failing, which is the one moment nobody is checking it.
  def expect_shared(got, shared, chrome, body, axis)
    expect(shared).not_to(
      be_within(0.05).of(chrome),
      "#{body}: shared #{shared} and Chrome #{chrome} agree — assert it as `chrome_#{axis}`, not as shared"
    )
    expect(got).to(
      be_within(0.05).of(shared),
      "#{body}: #m at #{axis} #{got}; both engines say #{shared}, Chrome says #{chrome}"
    )
  end

  # `chrome_x` stays POSITIONAL because 294 call sites in this file spell it that way and it reads well at
  # each of them (`expect_parity(body, 6, chrome_y: 0)`); the pairs below are keyword because each only ever
  # appears together.
  def expect_parity(
    body,
    chrome_x = nil,
    chrome_y:        nil,
    shared_x:        nil,
    shared_x_chrome: nil,
    shared_y:        nil,
    shared_y_chrome: nil
  )
    # A shared divergence is only RECORDED if the number it diverges from is written down beside it, so the
    # pair cannot be half-given.
    raise ArgumentError, 'shared_x needs shared_x_chrome' if !shared_x.nil? && shared_x_chrome.nil?
    raise ArgumentError, 'shared_y needs shared_y_chrome' if !shared_y.nil? && shared_y_chrome.nil?

    with_page(body) do |session|
      r = parity(session)
      expect(r).to include('ok' => true), "harness bailed: #{body}: #{r.inspect}"
      expect(r['compared']).to be > 0, "nothing was compared: #{body}: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "mismatch: #{body}: #{r.inspect}"
      expect_no_dropped_records(r, body)
      expect_near(marker_x(session), chrome_x, body, 'x') unless chrome_x.nil?
      expect_near(marker_y(session), chrome_y, body, 'y') unless chrome_y.nil?
      expect_shared(marker_x(session), shared_x, shared_x_chrome, body, 'x') unless shared_x.nil?
      expect_shared(marker_y(session), shared_y, shared_y_chrome, body, 'y') unless shared_y.nil?
    end
  end

  # …and for a rule the walk DECLINES by design, where there is no parity to assert at all and the oracle is
  # the only engine that answers. It still checks the decline, so a shape that quietly became native stops
  # being tested here and says so rather than passing on.
  def expect_declined_x(body, chrome_x, native_body, reason: 'text-not-measurable', chrome_y: nil)
    with_page(body) do |session|
      expect(parity(session)).to include('ok' => false, 'reason' => reason), "not declined: #{body}"
      expect_near(marker_x(session), chrome_x, body, 'x') unless chrome_x.nil?
      expect_near(marker_y(session), chrome_y, body, 'y') unless chrome_y.nil?
    end
    # …and the decline is the thing the shape is ABOUT, not something else that crept in: the same shape
    # without it goes native. Without this the example stays green while it silently stops covering the rule
    # (a new walk gate anywhere in the shape would decline it just as well).
    expect_parity(native_body)
  end

  # `break-spaces` lays a LINE out exactly as `pre-wrap` does — `placeTextRun` asks `PRESERVING_WS` and
  # `modeWraps`, and both answer the same for the two — and parts from it only in the INTRINSIC measure, where
  # every preserved space is content that never hangs and carries a break after it. So the LINE layout reads it
  # as `pre-wrap`, and `text_intrinsic`'s mode table measures it by its own rule (since 2026-09-23; the measure
  # was refused before, the disagreement fenced off where it lives rather than a whole mode refused for it).
  # It was refused outright before 2026-09-22, and not by name: `WS_MODE` simply had no entry, so the walk
  # declined without naming itself and the shape landed in `unsupported subtree` — 1,230 of the 1,782 that
  # reason covered, found only by censusing which of the walk's 155 refusal sites had fired.
  # KNOWN DIVERGENCE, both engines: `break-spaces` also breaks AFTER EVERY SPACE and lets none of them hang,
  # so Chrome 153 carries two of them onto the second line and puts the marker at 57.609375 where both engines
  # put it at 38.4 — the answer `pre-wrap` gives. That is what "lays a line out as pre-wrap" costs, and it is
  # SHARED, so the harness sees nothing; the arm asserts the shared answer and names Chrome's beside it.
  it 'lays a break-spaces line out as pre-wrap, which is all either engine distinguishes' do
    bs = '<div style="width:80px;font:16px monospace;white-space:break-spaces">aaaa      bbbb' \
         '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>'
    # …through `shared_x`, not `chrome_x`: 38.4 is what both engines say and Chrome 153 says 57.609375.
    expect_parity(bs, shared_x: 38.4, shared_x_chrome: 57.609375, chrome_y: 35)
    # …and it really is `pre-wrap`'s answer and not a coincidence: the same shape in `pre-wrap` is the same x,
    # and THERE it is Chrome's own, so it goes through `chrome_x`.
    expect_parity(bs.sub('break-spaces', 'pre-wrap'), 38.40625, chrome_y: 35)
  end

  # …and THAT arm pins nothing about native, which is worth stating because it took an A/B to find out. The
  # only native code this increment changes is `line_layout`'s mode table gaining 5 as a PRESERVING mode, and
  # the shape above cannot see it: at 80px the collapsed reading (`aaaa bbbb`, 86.4) overflows and wraps at
  # its one space, so preserve and collapse put the marker on the same line at the same x. Dropping 5 from the
  # table left all 136 examples in this file green — a fourth vacuous guard, caught before it shipped.
  # This is the shape that sees it. At 120px the preserved reading (14 chars, 134.4) does not fit and the
  # collapsed one (9 chars, 86.4) does, so the BLOCK is two lines or one — and the block's height is a box
  # the harness compares, where the marker on a line inside it is not. With 5 dropped from the table native
  # makes the page 26 tall against the oracle's 48: five mismatches, `<html>` included.
  # Chrome AGREES here (the marker's y is 44 in all three), so this one is a plain `chrome_y` — the divergence
  # the arm above records needs the spaces to fall at a wrap, and here they do not.
  it 'preserves a break-spaces run, which decides the line COUNT and so the block height' do
    bs = '<div style="width:120px;font:16px monospace;white-space:break-spaces">aaaa      bbbb</div>' \
         '<div id="m" style="height:4px"></div>'
    expect_parity(bs, 0, chrome_y: 44)
    # …and the collapsing control, so the example cannot pass by 120px being wide enough for either reading:
    # the same text under `normal` IS one line, and the marker sits at 22.
    expect_parity(bs.sub('break-spaces', 'normal'), 0, chrome_y: 22)
  end
  # …and the INTRINSIC half is what declines. `contentIntrinsicWidths` makes the min-content of `aa   bb` the
  # width of `aa ` where a `pre-wrap` measure gives `aa` — 28.8 against 19.2 — and native has only the second
  # rule, and native carries it since 2026-09-23: every preserved space is CONTENT that joins the word, never
  # hangs, and takes its break opportunity AFTER it, where a `pre-wrap` space opens one BEFORE and hangs off
  # the end. So the min-content of `aa   bb` is `aa ` wide and a `pre-wrap` one is `aa`.
  # Measured the hard way: aliasing the mode to `pre-wrap` outright passes the whole 8,640-case `wsonly` sweep
  # with no mismatch, because not one of its shapes asks for a min-content. These arms are that missing shape.
  # …asked at FOUR gates, because the mode is inherited but it can also be declared on a `<span>`, on one
  # inside that, or on a box-less `display: contents` element, and the block gate sees none of those. All four
  # went native together — the gate is one CODE SET (`NL_INTRINSIC_WS_CODES`) and `text_intrinsic`'s `modes`
  # table is its twin, so they could only move as a pair.
  # Chrome's figures throughout, and BOTH are asserted: the box is 28.8125 wide against `pre-wrap`'s
  # 19.203125, and the marker after `bb` sits at 19.203125 where `pre-wrap` puts it at 0 — because the extra
  # space `break-spaces` keeps on the first line is the whole difference, and it shows in both.
  # (Its `y` is NOT asserted: Chrome puts the marker on a third line at 57 and both engines put it on a second
  # at 35, the shared line-rule divergence the arm above names. One refusal, one of the two halves — and this
  # increment closed the measure half only.)
  it 'measures a break-spaces box by its own min-content rule (Chrome: 28.8125, where pre-wrap gives 19.2)' do
    {
      '<div style="width:min-content;font:16px monospace;white-space:MODE">aa   bb' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>' => :block,
      '<div style="width:min-content;font:16px monospace">aa' \
      '<span style="white-space:MODE">   </span>bb' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>' => :inline,
      '<div style="width:min-content;font:16px monospace">aa' \
      '<span><span style="white-space:MODE">   </span></span>bb' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>' => :nested_inline,
      '<div style="width:min-content;font:16px monospace">aa' \
      '<span style="display:contents;white-space:MODE">   </span>bb' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>' => :boxless
    }.each_key do |template|
      {'break-spaces' => [28.8125, 19.203125], 'pre-wrap' => [19.203125, 0]}.each do |mode, (chrome_w, chrome_mx)|
        body = template.sub('MODE', mode)
        expect_parity(body, chrome_mx)
        with_page(body) do |session|
          w = session.evaluate_script("document.querySelector('div').getBoundingClientRect().width")
          expect_near(w, chrome_w, body, 'width')
        end
      end
    end
  end

  # …and the SPACING column, which is the one this example did not have when the measure shipped. A preserved
  # space is a SPACED advance like every other piece on the line, and the oracle's own arm measured it with
  # `charAdvances` — unspaced by contract, its internal pen carrying `letter-spacing` / `word-spacing` only so
  # a TAB picks the right stop. Nothing added them back, so the oracle was 3px per space short of native and
  # of Chrome. Chrome's figures, measured 2026-09-23:
  #   plain 28.8125 · letter-spacing:3px 37.8125 · word-spacing:5px 33.8125 · letter-spacing:-1px 25.8125
  # …and the TAB is the shape that says the two pens are the same number: `a<space><tab>b` at
  # `letter-spacing: 3px; tab-size: 20px` is 52.609375, where an unspaced line pen reaches 49.6.
  it 'measures a break-spaces space SPACED, and lands a tab after one on the same stop (Chrome: 37.8125)' do
    {
      '' => 28.8125,
      'letter-spacing:3px' => 37.8125,
      'word-spacing:5px' => 33.8125,
      'letter-spacing:-1px' => 25.8125
    }.each do |spacing, chrome_w|
      body = %(<div style="width:min-content;font:16px monospace;white-space:break-spaces;#{spacing}">aa   bb</div>)
      expect_parity(body)
      with_page(body) do |session|
        expect_near(session.evaluate_script("document.querySelector('div').getBoundingClientRect().width"), chrome_w, body, 'width')
      end
    end
    tab = %(<div style="width:max-content;font:16px monospace;white-space:break-spaces;letter-spacing:3px;tab-size:20px">a &#9;b</div>)
    expect_parity(tab)
    with_page(tab) do |session|
      expect_near(session.evaluate_script("document.querySelector('div').getBoundingClientRect().width"), 52.609375, tab, 'width')
    end
  end

  # `pre-line` COLLAPSES SPACES and KEEPS NEWLINES — two independent axes — and the node-level gate that
  # decides whether a whitespace-only text node reaches the breaker at all asked only whether the mode
  # PRESERVES, which `pre-line` does not. So a node holding nothing but a newline took the collapsing arm,
  # where it is at most the one inline-block gap, and its forced break went missing: the oracle left the box
  # after it on the first line where Chrome and native put it on the second. Native had recorded the
  # divergence at its own break site rather than bending to it, so opening this closed both halves.
  #
  # BOTH arms, or the fix reads as "route every whitespace-only node through the breaker". The second arm is
  # asked through MARGIN COLLAPSING, because that is one of the four places the question is put
  # (`separatesMargins`) and it makes the difference page-visible rather than a walk-internal reason string:
  # a block whose only content is a space is an empty one the margins around it collapse through, and one
  # holding a newline has a line box that stops them. 42px apart, and both figures are Chrome's.
  it 'breaks at a newline that is the whole of a pre-line text node, and not at spaces that are' do
    marker = '<b id="m" style="display:inline-block;width:4px;height:4px"></b>'
    line   = 'width:400px;font:16px monospace;white-space:pre-line'
    expect_parity(%(<div style="#{line}"><span>\n</span>#{marker}</div>), chrome_y: 35)

    collapse = lambda {|ws|
      %(<div style="width:400px;font:16px monospace"><p style="margin:20px 0">a</p>) +
        %(<div style="white-space:pre-line"><span>#{ws}</span></div>) +
        %(<p id="m" style="margin:30px 0">b</p></div>)
    }
    expect_parity(collapse.(' '), chrome_y: 72)
    expect_parity(collapse.("\n"), chrome_y: 114)
  end

  # …and the shape this is really about, which nothing in the repo had: PRETTY-PRINTED markup. A source
  # newline between two block children of a `pre-line` block is a whitespace-only text node, so it makes a
  # line of its own — three of them here, and the block is 110 tall where both engines used to say 44. They
  # AGREED on 44, which is why no parity sweep could see it; only Chrome could.
  # It costs a decline: those anonymous whitespace lines are not something native models, so the walk now
  # refuses the shape instead of laying it out wrongly.
  it 'gives a pre-line block a line per source newline between its block children' do
    pretty = %(<div style="width:400px;font:16px monospace;white-space:pre-line">\n) +
             %(  <div>a</div>\n  <div id="m">b</div>\n</div>)
    plain  = %(<div style="width:400px;font:16px monospace;white-space:pre-line"><div>a</div><div id="m">b</div></div>)
    expect_declined_x(pretty, nil, plain, reason: 'white-space-only-block', chrome_y: 66)
  end

  # …and `break-spaces`, whose whitespace-only block used to be an EMPTY one to native and a 22px-tall one to
  # the oracle — 3 mismatches on a shape the unified definition now refuses outright, since `PRESERVING_WS`
  # holds it and the classifier asks the same question the oracle's placement does. (The CLASSIFIER is what
  # fires here, not the mode gate: a break-spaces block WITH content used to decline as `unsupported subtree`,
  # the mode having no `WS_MODE` code at all, and since 2026-09-22 it has one and only its MEASURE declines.
  # These two shapes never reach either.)
  # A plain list, not `%W[…]`: that splits on whitespace, so `%W[\n  ]` is the ONE-element array `["\n"]` and
  # the space case — half of what this example is about, and a mismatch at HEAD exactly like the newline —
  # was silently never run.
  ["\n", ' '].each do |ws|
    it "refuses a break-spaces block whose only content is #{ws.inspect}, rather than mismatching on it" do
      # …and the control is the SAME whitespace under a mode that collapses it, which is what isolates the
      # mode rather than the shape: that one goes native.
      expect_declined_x(%(<div style="width:400px;font:16px monospace;white-space:break-spaces">#{ws}</div>),
                        nil,
                        %(<div style="width:400px;font:16px monospace">#{ws}</div>),
                        reason: 'white-space-only-block')
    end
  end

  # …and the edges of the inline the break happens INSIDE go onto the line it ends, not onto the next one.
  # A marker waiting on an opening edge (an out-of-flow child records where the flow had reached, and an
  # unplaced edge means the flow has not said yet) settles when that edge lands, so an edge that landed a
  # line late took the marker with it — 22px down, on a line it was written above. Native skipped the flush
  # for a whitespace-only run because the ORACLE never reached its break at all; with the oracle fixed the
  # flush is unconditional, and this is the shape that says so.
  it 'flushes an inline opening edge onto the line a pre-line newline ends' do
    # Concatenated, never a heredoc: under `pre-line` a heredoc's own newlines are forced breaks, so the
    # shape would quietly become a different one — and might still pass.
    body = %(<div style="position:relative;width:400px;font:16px monospace;white-space:pre-line">) +
           %(<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>\n) +
           %(<span>y</span></span> tail</div>)
    expect_parity(body, 6, chrome_y: 0)
  end

  # AN INLINE BOX THAT NOTHING LANDED INSIDE still shows its edges, where it opened. The oracle flushes the
  # whole open stack at the close of any box whose own opening edge is still pending ("Chrome gives a lone
  # padded empty `<span>` a 10x27 box on its line"); native dropped it, under a comment claiming that matched
  # JS. It never did. Two boxes read the difference — the one AFTER the empty inline, and an out-of-flow child
  # of it, which records where the flow had reached and so waits for that edge to land.
  #
  # Neither was visible: the walk refused the whole family (`edged-inline-without-content`). It refused it for
  # a DIFFERENT divergence, and that one is real and still here — an empty inline's own font box does not grow
  # the line in either engine (`a<span style="padding-left:6px;font-size:40px"></span>` puts the next box at
  # y 13 where Chrome says 39). What the gate never was is a guard for it: the same error shows with NO edge
  # at all (`a<span style="font-size:40px"></span>`, never declined), and both engines share it, so parity
  # could not see it either way. A shared divergence is recorded, not fixed, during the port, so this was not
  # a trade the decline could win: it hid two native parity breaks and a third in the ORACLE (a closing edge
  # placed before the box around it had opened) to leave that one exactly where it was.
  # Opening the family does make more SHARED divergences reachable, all of them pre-existing and none of them
  # about an empty inline: the largest is rtl, where a padded inline puts the next box at 396 in both engines
  # and at 390 (or 380.39 after text) in Chrome — with or without content in it, so it is the rtl line-order
  # family and not this one. Recorded in `rtl_line_items_laid_out_ltr`, not fixed here.
  # The refusal is gone, so the `edged` sweep went from 1,200 declines to none.
  #
  # Every figure is Chrome's, and the engines agree with it: an opening edge is an opening edge whether it is
  # padding, a border or a margin, whether the box sits at the line's start or after text, and however the
  # inlines nest. A `padding-right` is no opening edge and moves nothing — the arm that says this is about
  # what OPENS a box and not about having any edge at all.
  {
    'an out-of-flow child reads the cursor past the edge'  =>
      ['<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i></span>', 6],
    'a box after a wholly empty padded inline'             =>
      ['<span style="padding-left:6px"></span>', 6],
    'a border is an opening edge too'                      =>
      ['<span style="border-left:3px solid"><i id="m" style="position:absolute;width:5px;height:5px"></i></span>', 3],
    '…and a margin, which is outside the box'              =>
      ['<span style="margin-left:9px"><i id="m" style="position:absolute;width:5px;height:5px"></i></span>', 9],
    'after text, from where the text left the pen'         =>
      ['A<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i></span>', 15.609375],
    'nested inlines flush outermost first'                 =>
      ['<span style="padding-left:6px"><span style="padding-left:2px"><i id="m" style="position:absolute;width:5px;height:5px"></i></span></span>', 8],
    'a CLOSING edge opens nothing, so it moves nothing'    =>
      ['<span style="padding-right:5px"><i id="m" style="position:absolute;width:5px;height:5px"></i></span>', 0],
    'white space inside is still nothing landing'          =>
      ['<span style="padding-left:6px"> </span>', 6]
  }.each do |name, (inner, chrome_x)|
    it "places an empty inline's opening edge: #{name}" do
      # …the marker is the `<i>` where the shape has one, and the box AFTER the inline where it does not.
      marker = inner.include?('id="m"') ? '' : ' id="m"'
      expect_parity(%(<div style="width:400px;font:16px monospace">#{inner}) +
                    %(<b#{marker} style="display:inline-block;width:4px;height:4px"></b></div>), chrome_x)
    end
  end

  # …and a pair of edges that CANCELS, which is the only shape that tells the two flushes apart. The oracle
  # has both: `placeOnLine` asks the SUM of the pending edges and places nothing when they come to zero, a
  # box's CLOSE asks that box's OWN edge and then places every pending one. Native folded them into one macro
  # with the sum guard, so a cancelling pair stayed pending and the OUTER close flushed an unbalanced sum —
  # the next box landed at -6 or +6 where Chrome and the oracle say 0. No sweep could see it: `edged.txt` has
  # no negative inline margin in any of its 8,640 shapes (`genedgeopen.rb` now sweeps that axis).
  {
    'the outer margin cancels the inner padding' =>
      ['<span style="margin-left:-6px"><span style="padding-left:6px"></span></span>', 0],
    '…and the other way round'                   =>
      ['<span style="padding-left:6px"><span style="margin-left:-6px"></span></span>', 0],
    'after text, so the pen is not at the origin' =>
      ['A<span style="margin-left:-6px"><span style="padding-left:6px"></span></span>', 9.609375],
    # …a different property and a different magnitude, so the arithmetic is not what is being pinned
    'a border against a margin, at another magnitude' =>
      ['<span style="margin-left:-3px"><span style="border-left:3px solid"></span></span>', 0]
  }.each do |name, (inner, chrome_x)|
    it "places both edges of a cancelling pair: #{name}" do
      expect_parity(%(<div style="width:400px;font:16px monospace">#{inner}) +
                    %(<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>), chrome_x)
    end
  end

  # …and the same pair around a FORCED BREAK, which is the other direct flush: the oracle calls
  # `flushOpenEdges()` outright at a preserved newline (`i > 0`), so both edges go down on the line the break
  # ends and the close finds nothing pending. Behind the sum guard native placed neither, then placed both at
  # the close — one line too many.
  it 'places both edges of a cancelling pair at a preserved newline' do
    expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">) +
                  %(<span style="margin-left:-6px"><span style="padding-left:6px">\n</span></span></div>) +
                  %(<b id="m" style="display:inline-block;width:4px;height:4px"></b>), chrome_y: 32)
  end

  # A NON-WRAPPING block container is one unbreakable token whatever it holds — the oracle ends its measure with
  # `min = max` for a `nowrap` / `pre` box — and native pins it the same way now, so a `nowrap` block holding text
  # and a block child is MEASURED where the walk declined every shrink-to-fit asker around it (216 `wsonly`
  # shapes, and `WalkRefusals::UNMEASURABLE` until now). These two guard that lift: the text here is an anonymous
  # group that pins ITSELF, so the container's own pin changes nothing (the shapes it does change follow).
  {
    'at its max-content'  => ['', 48.015625, 13],
    'squeezed to its min' => [';width:10px', 0, 40]
  }.each do |name, (outer, chrome_x, chrome_y)|
    it "measures a non-wrapping block holding a block child: #{name}" do
      expect_parity(
        %(<div style="font:16px monospace#{outer}"><div style="float:left;white-space:nowrap">aa bb<div style="width:5px;height:5px"></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        chrome_x,
        chrome_y: chrome_y
      )
    end
  end
  # …and its FLOATS pinned with it, which Chrome does not do: `white-space` is about inline content, and two floats
  # in a `nowrap` float still stack in a 10px block (Chrome 40 wide; both engines 70). Shared, recorded.
  it 'pins a non-wrapping block\'s floats to one line (shared)' do
    expect_parity(
      '<div style="font:16px monospace;width:10px"><div style="float:left;white-space:nowrap"><div style="float:left;width:30px;height:5px"></div>' \
      '<div style="float:left;width:40px;height:5px"></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        18,
      shared_y_chrome: 23
    )
  end
  # …and where the container's pin DOES change something, it is the oracle's rule and not Chrome's, which pins
  # only inline content: a child that declares a wrapping mode of its own keeps its min-content there (the block
  # 57.6 wide, the marker below its three lines; both engines one 259.2-wide line), and an EMPTY inline beside
  # floats — the empty-content record, which carried no mode at all until the review of 2b98ec5b (40 where the
  # oracle pinned 70) — pins them too. Shared, recorded.
  it 'pins a non-wrapping container over a child with its own wrapping mode (shared)' do
    expect_parity(
      '<div style="font:16px monospace"><div style="width:min-content"><div style="white-space:nowrap">' \
      '<p style="margin:0;white-space:normal">a normal child under nowrap</p></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        35,
      shared_y_chrome: 123
    )
  end
  it 'pins a non-wrapping block of an empty inline and floats (shared)' do
    expect_parity(
      '<div style="font:16px monospace"><div style="width:min-content"><div style="white-space:nowrap"><span></span>' \
      '<div style="float:left;width:30px;height:5px"></div><div style="float:left;width:40px;height:5px"></div></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      shared_x:        70,
      shared_x_chrome: 40
    )
  end
  # An empty inline box TAKES a first-line indent in the oracle (and Chrome: 77 at max-content), where native's
  # empty-content record has nothing to take it with (70) — so the measure refuses such a block, and the
  # `max-content` box around it, which has no fallback, declines; the same block with no indent is native.
  it 'refuses to measure an indented block of an empty inline and floats' do
    floats = '<span></span><div style="float:left;width:30px;height:5px"></div><div style="float:left;width:40px;height:5px"></div>'
    expect_declined_x(
      %(<div style="font:16px monospace"><div style="width:max-content"><div style="text-indent:7px">#{floats}</div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
      70,
      %(<div style="font:16px monospace"><div style="width:max-content"><div>#{floats}</div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
      reason:   'shrink-to-fit-child-unmeasurable',
      chrome_y: 13
    )
  end
  # A CR is a collapsible space under a collapsing mode (CSS Text 3 §4.1.1), and both engines lay it out as one;
  # only the MEASURE refused it — native's intrinsic walk and the gate asking it with `preserved` regardless of the
  # element's mode — so every shrink-to-fit asker around `aa&#13;bb` declined. It breaks there at min-content.
  it 'measures a CR under a collapsing white-space as a space' do
    expect_parity('<div style="font:16px monospace;width:10px"><div style="float:left">aa&#13;bb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 57)
  end
  # …and FF with it in both engines, which is wrong for FF: CSS Text 3 makes only CR a space, and Chrome draws FF as
  # a glyph with no break opportunity (`aa&#12;bb` one 48-wide line there; both engines break it at min-content).
  it 'collapses FF as a space too (shared)' do
    expect_parity(
      '<div style="font:16px monospace"><div style="width:min-content">aa&#12;bb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        57,
      shared_y_chrome: 35
    )
  end

  # AN EDGE IS NOT CONTENT A BREAK MAY LEAVE BEHIND. The oracle keeps two questions about a line apart —
  # `linePlaced` (anything went down on it, an edge included) and `lineHasContent` (something a break may
  # leave behind) — and every break-before test asks the second. Native asked one flag for both, so an opening
  # edge alone on a line counted as content and a box too narrow for edge + atomic broke BEFORE the atomic,
  # where the oracle keeps it beside the edge and overflows — and so does Chrome, as long as nothing OFFERS a
  # break there (with a `<wbr>` between them Chrome takes it; both engines do not, a shared gap pinned below).
  # The walk hid it behind the measure gate's `!hasReal` arm, which refused a whitespace-only edged inline as
  # `shrink-to-fit-child-unmeasurable` (~850 sweep declines): a min-content box is exactly as narrow as the
  # edge, so it was the only place the line got this tight. The control is the same line with an ATOMIC
  # where the edge is, which does break (Chrome y 35).
  {
    'an empty edged inline on a line only as wide as its edge'     =>
      '<div style="width:6px;font:16px monospace"><span style="padding-left:6px"></span>',
    '…holding white space, which collapses away'                   =>
      '<div style="width:6px;font:16px monospace"><span style="padding-left:6px">   </span>',
    '…at min-content, the shape the measure gate used to refuse'   =>
      '<div style="width:min-content;font:16px monospace"><span style="padding-left:6px">   </span>'
  }.each do |name, head|
    it "keeps an atomic beside an opening edge alone on its line: #{name}" do
      expect_parity(%(#{head}<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>), 6, chrome_y: 13)
    end
  end
  it 'breaks before an atomic when what fills the line is CONTENT (the control)' do
    expect_parity(
      '<div style="width:6px;font:16px monospace"><b style="display:inline-block;width:6px;height:4px"></b>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      chrome_y: 35
    )
  end
  # …and a collapsible space the flow PLACES is content, where an edge is not: once native stopped counting
  # the edges, the space after them had to count in their place (the oracle places it through `placeOnLine`,
  # which sets `lineHasContent` for anything but an edge), or ` aaaa` stopped wrapping here. What the two
  # engines share is that the space is placed at all: they call the line started once an edge is on it
  # (`collapseRun`'s `!linePlaced`), where Chrome still sees a line START, collapses the space, and fits
  # `aaaa` beside the edges — one line, the marker at 52.41, where both engines wrap and put it at 38.4.
  it 'wraps text after a space placed behind edges alone on the line' do
    expect_parity(
      '<div style="width:60px;font:16px monospace"><span style="margin-left:9px"><span style="padding-right:5px"></span> aaaa</span>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      shared_x:        38.4,
      shared_x_chrome: 52.40625
    )
  end
  # …and the space is content from the moment it is PLACED, not from when a word consumes it: a
  # NON-WRAPPING run asks its whole-run pre-pass whether the line holds content before any word arrives, and
  # with the edges no longer answering yes, a space still only queued said no — `aaaa` stayed on a 30px line
  # the oracle wraps it off (found by the review's 57,600-shape sweep, `edgeline_*`). Chrome wraps it too, but
  # to the second line where both engines reach the third: the collapsed space again, which Chrome drops at
  # what it still calls the line's start.
  it 'wraps a non-wrapping run after a space placed behind an edge alone on the line' do
    expect_parity(
      '<div style="width:30px;font:16px monospace"><span style="padding-left:6px"></span> ' \
      '<span style="white-space:nowrap">aaaa</span><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        57,
      shared_y_chrome: 35
    )
  end
  # …while a space the flow NEVER placed is no content at all, however it is carried: a non-wrapping
  # white-space run at a line start collapses away and leaves only its hard barrier behind (a zero-width
  # pending space), and when a later edge put the line down and a `<wbr>` made it breakable, native counted
  # that phantom as content and broke before the atomic where the oracle keeps it.
  # Chrome breaks at the `<wbr>` in both this shape and the one after it, and both engines keep the atomic
  # beside the edge: an opportunity after an edge-only line is one neither engine takes. Shared, recorded.
  {
    'a collapsed non-wrapping space, then an edge'  =>
      '<span style="padding-right:6px"><span style="white-space:nowrap"> </span></span><wbr>',
    'an opening edge alone'                         =>
      '<span style="padding-left:6px"></span><wbr>'
  }.each do |name, head|
    it "keeps an atomic beside an edge-only line across a <wbr>: #{name}" do
      expect_parity(
        %(<div style="width:6px;font:16px monospace">#{head}<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        shared_y:        13,
        shared_y_chrome: 35
      )
    end
  end
  # A CLOSING edge whose two halves cancel still LANDS: the oracle places `padding-right` and `margin-right`
  # as two edges, so the line exists and the block around it is one line tall — 22, as in Chrome, which puts
  # the marker after it at 35. The walk judged the inline edgeless by the halves' SUM and emitted no edge runs
  # at all, so native saw no line and gave the block no height (the marker at 13). (A `<br>` after it does
  # not show this: native's break closes a strut line of its own either way.)
  it 'puts the line down for a closing edge whose halves cancel' do
    expect_parity(
      '<div style="font:16px monospace"><div style="width:100px"><span style="padding-right:5px;margin-right:-5px"></span></div>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      chrome_y: 35
    )
  end
  # …and a `<br>` inside an inline whose only edge is its CLOSE: the close lands on the line the break opened.
  # The walk refused every edged inline holding a `<br>` until 2026-09-23 (see the break specs below),
  # and emitting edge runs for a cancelling close pair had put 360 more such shapes behind that refusal.
  {
    'a closing edge alone'           => ['padding-right:5px', 24.21875],
    'a closing pair that cancels'    => ['padding-right:5px;margin-right:-5px', 19.21875]
  }.each do |name, (style, chrome_x)|
    it "breaks at a <br> inside an inline with no opening edge: #{name}" do
      expect_parity(
        %(<div style="width:100px;font:16px monospace">a<span style="#{style}">x<br>y</span>b) +
        %(<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        chrome_x,
        chrome_y: 35
      )
    end
  end
  # A forced break INSIDE an inline's edges: the oracle's `<br>` puts every opening edge still pending down on
  # the line it ends and breaks, and the box's CLOSE lands on the line the break opens. Native declined every
  # such shape (`br-in-edged-inline`, and its `RUN_BR` arm) as a fragment it could not place; it takes the same
  # two steps as its preserved-newline arm now. The marker sits right after the inline, so its x is the
  # second line's content plus the closing edge.
  {
    'a padded inline'                                 => ['<b style="padding:0 5px">t<br>u</b>', 14.609375],
    'a bordered inline, whose edge is all OPENING'    => ['<b style="border-left:2px solid">t<br>u</b>', 9.609375],
    'an opening edge the break puts down on its line' => ['<b style="padding-left:20px"><br><i id="m" style="display:inline-block;width:4px;height:4px"></i></b>', 0]
  }.each do |name, (inline, chrome_x)|
    it "breaks inside #{name}" do
      marker = inline.include?('id="m"') ? '' : '<i id="m" style="display:inline-block;width:4px;height:4px"></i>'
      expect_parity(%(<div style="width:400px;font:16px monospace">x #{inline}#{marker} y</div>), chrome_x, chrome_y: 35)
    end
  end
  # …and one both engines get wrong alike: Chrome keeps a CLOSING edge on the line a `<br>` ENDS when the break
  # is the last thing in the inline — the marker after it at 0 — where both engines carry it to the next line
  # (the oracle's two fragments, the second only the edge). Shared, recorded: it declined until the refusal
  # above went, so no instrument could see it. With anything after the break, even an empty inline, Chrome
  # moves the close down too and all three agree.
  {
    'a margin'                         => '<b style="margin:0 5px"><br></b>',
    'padding, after text on the line'  => '<b style="padding-right:5px">t<br></b>'
  }.each do |name, inline|
    it "carries a closing edge past a <br> that ends the inline: #{name}" do
      expect_parity(
        %(<div style="width:400px;font:16px monospace">x #{inline}<i id="m" style="display:inline-block;width:4px;height:4px"></i> y</div>),
        chrome_y:        35,
        shared_x:        5,
        shared_x_chrome: 0
      )
    end
  end

  # …and the ORACLE's half, which had no guard at all because the only instrument that caught it was an
  # out-of-repo sweep. An out-of-flow child of an inline records where the flow had reached INSIDE that box,
  # and settles against the box's own fragment once the layout knows where that is. Two things could open
  # that fragment's line before the box's opening edge had landed on it — an inner box's CLOSING edge, and a
  # placement whose `if (pending)` sum the edge had been cancelled out of — and the reading then took the
  # line's start for the content start: 0 where Chrome and native say 6.
  #
  # Both are fixed in the READING, not by putting the edge down earlier. Placing it earlier is what the
  # waiting exists to prevent (an edge on a line its content then leaves is stranded, and the block loses a
  # line — measured below), and it was tried: flushing for a closing edge, and flushing whatever the sum had
  # cancelled, each fixed one of these and cost that.
  # So the marker records what it can see AT THE TIME — the cursor it stands at, plus the edges then waiting
  # — which is what native has always recorded. Deriving it later from the fragment's start instead is right
  # only while nothing else has gone down inside the box on that line, and an inner box's closing edge is
  # something else; it can come before the marker as easily as after it.
  {
    "an inner box whose only edge is a CLOSING one" =>
      ['<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>' \
       '<span style="padding-right:5px"></span></span>', 6],
    "…and one whose OPENING margin cancels the outer's edge" =>
      ['<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>' \
       '<span style="margin-left:-6px">x</span></span>', 6],
    'the same, through a border' =>
      ['<span style="border-left:3px solid"><i id="m" style="position:absolute;width:5px;height:5px"></i>' \
       '<span style="margin-left:-3px">x</span></span>', 3],
    # …a sibling margin that does NOT cancel: this one was green before the fix too (the sum stayed non-zero,
    # so the old guard let it through), and it is no longer only a control — it fails on a wrong `edges`
    # term like every other arm here.
    'a sibling margin that does not cancel' =>
      ['<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>' \
       '<span style="margin-left:-2px">x</span></span>', 6],
    # …and an opening MARGIN, which lives outside the box and so is in neither `startX` nor `ce.left`
    'the outer edge is a margin, not padding' =>
      ['<span style="margin-left:9px"><i id="m" style="position:absolute;width:5px;height:5px"></i>' \
       '<span style="padding-right:5px"></span></span>', 9],
    # …and the MIRROR of the first two, which is what says the reading is a cursor and not the fragment's
    # start: the inner box closes BEFORE the marker, so 5px of it are already spent when the marker is
    # written, and every arm above has the marker first.
    'the inner box closes before the marker' =>
      ['<span style="padding-left:6px"><span style="padding-right:5px"></span>' \
       '<i id="m" style="position:absolute;width:5px;height:5px"></i>aaaa</span>', 11],
    'the same, with the outer edge a margin' =>
      ['<span style="margin-left:9px"><span style="padding-right:5px"></span>' \
       '<i id="m" style="position:absolute;width:5px;height:5px"></i>aaaa</span>', 14],
    # …and a cursor is a PRE-ALIGNMENT quantity where the fragment start it replaced was shifted at line
    # end, so it rides the same list every other static does.
    'a centred line moves the cursor it was read at' =>
      ['<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>' \
       'aaaa</span>', 183.796875, ';text-align:center']
  }.each do |name, (inner, chrome_x, outer)|
    it "reads a marker against the edge of the box it is in: #{name}" do
      expect_parity(%(<div style="position:relative;width:400px;font:16px monospace#{outer}">#{inner}</div>),
                    chrome_x)
    end
  end

  # …and the line the marker follows when its inline WRAPS is the one the opening edge landed on, which is
  # not the fragment's first: an inner box's closing edge can open one before that. Asserted as the `y`,
  # because that is what the lookup decides — the `x` here is 6 in both engines against Chrome's 11, which
  # is the same content-edge re-derivation one branch over and is recorded, not fixed (both engines share
  # it, so only a Chrome check sees it at all).
  it 'follows its inline to the line the opening edge landed on' do
    expect_parity(%(<div style="position:relative;width:60px;font:16px monospace">aaaa aaaa ) +
                  %(<span style="padding-left:6px"><span style="padding-right:5px"></span>) +
                  %(<i id="m" style="position:absolute;width:5px;height:5px"></i>aaaa</span></div>), chrome_y: 44)
  end

  # …and the edge stays WAITING, which is what the reading was fixed instead of. An inline's opening edge is
  # not placed when the box opens: its first word may not fit, and an edge already down would be stranded on
  # a line the content then leaves, taking that line's height with it. Flushing it for an inner box's closing
  # edge did exactly that — this block lost a line (44 against Chrome's 66).
  it 'leaves an opening edge waiting when the content after it wraps away' do
    body = %(<div style="width:80px;font:16px monospace">aaaa ) +
           %(<span style="padding-left:20px"><span style="padding-right:5px"></span>bbbbbb</span>) +
           %(<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>)
    expect_parity(body, 0, chrome_y: 57)
  end

  it 'matches a single-line text block' do
    expect_parity('<div>Hello world</div>')
  end

  it 'matches a multi-line wrapping text block' do
    text = 'The quick brown fox jumps over the lazy dog and then keeps on running well past the edge of the box.'
    expect_parity(%(<div style="width:150px">#{text}</div>))
  end

  it 'matches nested block containers of text blocks' do
    expect_parity(<<~HTML)
      <div>
        <div style="width:120px">first paragraph of words that wraps onto multiple lines here</div>
        <div style="width:300px">second paragraph on probably one line</div>
      </div>
    HTML
  end

  it 'matches text with same-font inline elements (a / span) folded in' do
    text = 'Some words with <a href="#">a link here</a> and a <span>span too</span> that keep wrapping onward.'
    expect_parity(%(<div style="width:160px">#{text}</div>))
  end

  it 'matches text with different-font inline runs (bold / em)' do
    text = 'plain words then <b>some bold words</b> then <em>emphasised ones</em> and plain again onward.'
    expect_parity(%(<div style="width:170px">#{text}</div>))
  end

  # A mixed-font word — one glued across a run boundary with NO space between, because a plain (edgeless)
  # inline emits no OPEN/CLOSE run to separate the fonts: `foo<b>bar</b>baz`, `H<sub>2</sub>O`. It is ONE
  # unbreakable unit: the fonts differ but there is no line-break opportunity between the segments, so its
  # width is the sum of the per-font advances and the whole unit wraps together (its tail never spills).
  it 'matches a bold run glued mid-word' do
    expect_parity('<div style="width:300px">foo<b>bar</b>baz</div>')
  end
  it 'matches a subscript glued mid-word (H2O)' do
    expect_parity('<div style="width:300px">H<sub>2</sub>O and a longer <sub>subscripted</sub>word wrapping onward here past the edge</div>')
  end
  it 'matches a font-size change glued mid-word growing the line box' do
    expect_parity('<div style="width:300px">a<span style="font-size:24px">B</span>c then more plain words wrapping onward past the box edge here</div>')
  end
  it 'matches a three-font glued word' do
    expect_parity('<div style="width:400px">a<b>b</b><i>c</i>d and then several more plain words that wrap onward past the edge</div>')
  end
  # The glued unit is unbreakable; when its LEADING segment doesn't fit the line it wraps as one.
  it 'matches a glued mixed-font unit wrapping as one at the box edge' do
    expect_parity('<div style="width:70px">xxxxx yyyy<b>yyyy</b>yyyy and zzz</div>')
  end
  it 'matches a glued mixed-font prefix followed by a real space and more words' do
    expect_parity('<div style="width:120px">pre<b>fix</b>ed words then more that keep wrapping onward past the edge here</div>')
  end
  # The over-break guard: the glued unit's LEADING segment (`xx`) fits the current line but the WHOLE unit
  # (`xx` + the long bold tail) does not. The oracle's greedy breaker commits the unit to the line on the
  # leading segment alone and lets the tail OVERFLOW — a mid-word run boundary is never a break opportunity —
  # so this is ONE line. Fit-testing the whole unit instead would wrap it to a second line (a silent-wrong).
  it 'matches a glued unit whose leading segment fits but whose tail overflows the line (no extra break)' do
    expect_parity('<div style="width:120px">x xx<b>xxxxxxxxxxxxxxxx</b></div>')
  end
  it 'matches a subscript tail overflowing after a fitting leading segment' do
    expect_parity('<div style="width:90px">word H<sub>2222222222222</sub></div>')
  end

  # In-word breaking (overflow-wrap / word-break): a word WIDER than the band breaks between characters. The
  # oracle's charUnits emits one unit per code point and the flow fills greedily; native reproduces that in
  # line_layout (wrap_mode on the run). break-word / anywhere move the over-long word to a FRESH line first;
  # break-all fills the line it is on. A word that FITS the band still wraps as a whole (no in-word break).
  it 'matches overflow-wrap:break-word breaking a long unbroken word' do
    expect_parity('<div style="width:120px; overflow-wrap:break-word">see thisisaverylongunbrokenwordthatmustbreak here</div>')
  end
  it 'matches word-break:break-all filling each line' do
    expect_parity('<div style="width:120px; word-break:break-all">The quick brown fox jumps over the lazy dog repeatedly.</div>')
  end
  it 'matches overflow-wrap:anywhere breaking a long word' do
    expect_parity('<div style="width:100px; overflow-wrap:anywhere">prefix supercalifragilisticexpialidocious suffix</div>')
  end
  it 'matches word-wrap:break-word (the legacy spelling) on a long URL' do
    expect_parity('<div style="width:140px; word-wrap:break-word">Visit https://example.com/a/very/long/path/that/keeps/going/onward for details</div>')
  end
  # freshLine: break-word puts the whole word on its own line, THEN breaks it there (a leading short word
  # stays above); break-all has no fresh line and fills the current line — the counts differ, so this pins it.
  it 'matches break-word starting the over-long word on a fresh line' do
    expect_parity('<div style="width:110px; overflow-wrap:break-word">a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c</div>')
  end
  it 'matches break-all with no fresh line for the over-long word' do
    expect_parity('<div style="width:110px; word-break:break-all">a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c</div>')
  end
  # A break-anywhere word that FITS the band is atomic — it soft-wraps as a whole, no in-word split.
  it 'matches a break-word word that fits the band wrapping whole' do
    expect_parity('<div style="width:200px; overflow-wrap:break-word">alpha bravo charlie delta echo foxtrot golf hotel india</div>')
  end
  # The mode is per-run and inherits: only the break-all span breaks inside; the plain span does not.
  it 'matches a break-all span beside a plain span (per-run mode)' do
    expect_parity('<div style="width:130px"><span style="word-break:break-all">antidisestablishmentarianism</span> <span>and thennnnnnnnnnnnnnnnnnnn</span></div>')
  end
  it 'matches break-word inherited from an ancestor onto a nested span' do
    expect_parity('<div style="width:120px; overflow-wrap:break-word">lead <span>nestedsuperlongunbreakableword</span> tail</div>')
  end
  # white-space:nowrap suppresses ALL soft-wrapping, in-word breaking included — one line even with break-all.
  it 'matches nowrap + break-all staying on one line' do
    expect_parity('<div style="width:80px; white-space:nowrap; word-break:break-all">unbreakablelongwordonasingleline plus more</div>')
  end
  # pre-wrap preserves whitespace and still soft-wraps, so a long word breaks inside under break-word too.
  it 'matches pre-wrap + break-word breaking a long word' do
    expect_parity("<div style=\"width:120px; white-space:pre-wrap; overflow-wrap:break-word\">line one\nthisisaverylongwordunderprewrap end</div>")
  end
  # break-word on a nested block element inside a wider container: the run fills the nested block's own width.
  it 'matches break-word on a nested block element' do
    expect_parity('<div style="width:180px"><p style="overflow-wrap:break-word">areallylongunbreakableurlwordhere followed by ordinary words wrapping past edge</p></div>')
  end

  # <wbr> is a zero-width soft-wrap opportunity: it separates the runs it sits between (so they do not merge
  # into one glued word) and lets the next word break before it. This holds at white-space:normal too — the
  # native breaker ignored <wbr> entirely before, merging the flanking text and mis-breaking it.
  it 'matches a <wbr> break opportunity in a long token (normal wrapping)' do
    expect_parity('<div style="width:70px">aaaaaaaaaa<wbr>bbbbbbbbbb</div>')
  end
  it 'matches a <wbr> across a font boundary' do
    expect_parity('<div style="width:70px">aaaaaaaaaa<wbr><b>bbbbbbbbbb</b></div>')
  end
  it 'matches multiple <wbr> break points in a URL' do
    expect_parity('<div style="width:80px">https://<wbr>example<wbr>.com<wbr>/very<wbr>/long<wbr>/path/onward</div>')
  end
  it 'matches a <wbr> inside a break-word block (the over-long-token case)' do
    expect_parity('<div style="width:70px; overflow-wrap:break-word">aaaaaaaaaa<wbr>bbbbbbbbbbbbbbbbbbbb</div>')
  end
  it 'matches a <wbr> just after a real space (space width preserved)' do
    expect_parity('<div style="width:70px">aaaa <wbr>bbbbbbbbbbbb</div>')
  end
  # A <wbr> immediately BEFORE a collapsible space must not swallow that space's advance — the space still
  # separates the words (width tuned so `aaaabbbb` fits one line but `aaaa bbbb` does not).
  it 'matches a <wbr> immediately before a collapsible space' do
    expect_parity('<div style="width:61px">aaaa<wbr> bbbb</div>')
  end
  it 'matches a <wbr> suppressed under white-space:nowrap' do
    expect_parity('<div style="width:60px; white-space:nowrap">aaaaaaaa<wbr>bbbbbbbb ccc</div>')
  end

  it 'matches a larger-font inline run growing the line height' do
    expect_parity(%(<div style="width:300px">small text <span style="font-size:28px">BIG</span> small again</div>))
  end

  it 'matches a fixed line-height with mixed font metrics (ascent/descent line box)' do
    # A LENGTH line-height does not scale per run, so the taller 28px run's ascent grows the line box
    # past the 40px line-height — max(ascent)+max(descent), not max(line-height). Diverges unless native
    # composes the line box from per-run ascent/descent.
    expect_parity(%(<div style="width:400px;line-height:40px">small text <span style="font-size:28px">BIG</span> more small text</div>))
  end

  it 'matches <br> hard breaks (mid, trailing, leading, doubled)' do
    [
      'line one<br>line two',
      'only line<br>',
      '<br>after a leading break',
      'a<br><br>b with a blank line between',
      'first<br>second<br>third',
    ].each do |body|
      expect_parity(%(<div style="width:400px">#{body}</div>))
    end
  end

  it 'matches an edged inline element (padding/border/margin) affecting wrap' do
    text = 'some words then <span style="padding:0 10px;border:1px solid #000;margin:0 6px">a boxed span</span> and more words that wrap onward here.'
    expect_parity(%(<div style="width:200px">#{text}</div>))
  end

  it 'matches a text block with padding, border, and margins' do
    text = 'Some words wrapping inside a padded bordered box to check content width and stacked height.'
    expect_parity(%(<div style="width:180px;margin:12px 0;padding:6px;border:2px solid #000">#{text}</div><div style="height:10px"></div>))
  end

  # An EDGED inline grows the line to its own FONT box where a closing edge LANDS: the oracle places each
  # closing half through `placeOnLine(…, ownH, …, inlineAscent)` — an edge placement grows the line like any
  # other. Native's CLOSE only advanced the pen, so the walk declined every edged inline whose content area
  # exceeds its line-height (`edged-inline-font-exceeds-line-height`), and where the inline holds no text of
  # its own — so that the close is all that could grow the line — native missed it outright: an empty
  # `font-size:30px` span makes a 16px line 41 tall in Chrome and the oracle, 22 in native; a `super` one
  # raises it by the shift. The CLOSE run carries the box now.
  # …and the space hanging at the line's end is banked by the same placement: the taller space in a 24px
  # `<em>` keeps the line it ends tall even after the wrap drops it (Chrome 99; native was 11 short).
  {
    'an empty inline in a larger font'      =>
      ['<div style="width:100px;font:16px monospace"><span style="font-size:30px;padding-right:5px"></span>', 5, 28],
    'an empty raised inline'                =>
      ['<div style="width:100px;font:16px monospace">a<span style="vertical-align:super;padding-right:5px"></span>', 14.609375, 19.328125],
    'a taller hanging space the wrap drops' =>
      ['<div style="width:60px;font:16px monospace"><b style="padding-right:3px">aaaa-bbbb<em style="font-size:24px"> </em></b>cccccccc', 0, 90]
  }.each do |name, (head, chrome_x, chrome_y)|
    it "grows the line to an edged inline's font box where its close lands: #{name}" do
      expect_parity(%(#{head}<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>), chrome_x, chrome_y: chrome_y)
    end
  end
  # …and an OPENING edge grows nothing (`flushOpenEdges` only seeds the strut), which with text in the inline
  # at a tiny line-height is what Chrome does too.
  it 'grows nothing for an opening edge with text in the inline' do
    expect_parity(
      '<div style="width:200px;font:16px monospace;line-height:8px">a<span style="border-left:2px solid">x</span>b' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>',
      30.828125,
      chrome_y: 6
    )
  end
  # Where the two engines share a rule Chrome does not. What Chrome grows the line to for an inline is its
  # LINE-HEIGHT box (§10.8.1, the metrics its own text uses), where the oracle's close grows it to the font's
  # CONTENT box and its opening edge grows nothing. The two boxes coincide at `line-height: normal` on a font
  # with no line gap — monospace here, which is why the shapes above agree with Chrome — and nowhere else: at a
  # line-height below the font box Chrome keeps the line there (the marker at 6; both engines 13 — the case the
  # refusal was written about, whose comment said 22 was MEASURED: it was read with a `font` shorthand after the
  # `line-height`, which resets it to `normal`), an opening edge grows an empty larger-font inline's line in
  # Chrome (28; both engines 13), and a serif or sans face's line gap makes a `normal` line a pixel or three
  # taller in Chrome than the content box (an empty 60px span: 69 against 67). ONE rule, recorded, not fixed.
  {
    'a close at a tiny line-height, padding' =>
      ['<div style="width:200px;font:16px monospace;line-height:8px">a<span style="padding:0 5px">x</span>b', 38.828125, 13, 6],
    'a close at a tiny line-height, border'  =>
      ['<div style="width:200px;font:16px monospace;line-height:8px">a<span style="border-right:2px solid">x</span>b', 30.828125, 13, 6],
    'an empty larger-font OPENING edge'      =>
      ['<div style="width:100px;font:16px monospace"><span style="font-size:30px;padding-left:5px"></span>', 5, 13, 28]
  }.each do |name, (head, chrome_x, shared_y, chrome_y)|
    it "grows the line by the oracle's edge rule, not Chrome's (shared): #{name}" do
      expect_parity(%(#{head}<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>), chrome_x, shared_y: shared_y, shared_y_chrome: chrome_y)
    end
  end
  # Two more the refusal was hiding — it declined every edged inline at a line-height below its font box, and
  # no sweep ran at one (the `line-height: 0` / `8px` variants of every sweep do now, 452k cases).
  # NATIVE: a non-wrapping space collapsed at a line start leaves a zero-width placeholder for its barrier, and
  # its metrics were ZERO — a height, where the oracle's `lineHangAsc` uses `-Infinity` for exactly this
  # reason: the line's descent is negative at such a line-height, so a word taking the placeholder on a line
  # an edge had started grew it (the block 10 tall where Chrome and the oracle say 8). The marker reads the
  # block's height from BELOW it: one on the line would grow the line itself and hide the difference.
  it 'grows nothing for a collapsed non-wrapping space after an edge at a tiny line-height' do
    expect_parity(
      '<div style="font:16px monospace"><div style="width:100px;line-height:8px">' \
      '<span style="padding-left:5px;white-space:nowrap"> </span>b</div>' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>',
      0,
      chrome_y: 21
    )
  end
  # ORACLE: it told its lines apart by their y, and at `line-height: 0` every line has the same one — so a
  # marker held for an inline's opening edge took the edge landing on a LATER line for its own and settled at
  # the cursor it stood at on the earlier one (x 54 where native and Chrome say 6). Lines are counted now.
  it 'tells zero-tall lines apart when settling a marker held for an opening edge' do
    expect_parity(
      '<div style="position:relative;width:60px;font:16px monospace;line-height:0">aaaa aaaa ' \
      '<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>z</span></div>',
      6,
      chrome_y: 0
    )
  end
  # A marker held for an opening edge INSIDE an inline-block that itself sits in an edged inline: the held
  # record is the inline-block's, but `placeAbsolute` parks the entry with the OUTERMOST open inline, in the
  # block around it — whose settle had no record of it and fell back to the cursor it was held at. The ORACLE
  # was wrong ((34.8, 22) against native's and Chrome's (10, 44)); the inline-block's settle resolves it now.
  # 6,700 of the 10,000 `nestedheld` shapes mismatched, rtl ones by the corner the atomic's shift left behind.
  it 'settles a marker held inside an inline-block inside an edged inline' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace">aaaa aaaa <span style="padding-left:6px">' \
      '<span style="display:inline-block;width:50px">bb <span style="padding-left:4px"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span></span> t</div>',
      10,
      chrome_y: 44
    )
  end
  # …and a box parked with an open inline follows the atomic it sits in when that atomic is MOVED after its own
  # layout — a flex item centred on its cross axis, a table cell's `vertical-align` — as native and Chrome have
  # it: the entry sits in a list, which no `shiftSubtree` reached (`PARKED` is swept now), so the oracle left
  # the marker where the flow had been (y 0). Even a plain `<span>` around the atomic parks it. The same sweep
  # puts a reused subtree's parked boxes back after a mutation (`parkedmove` under CSIM_SWEEP_INCREMENTAL).
  {
    'a flex item centred on its cross axis' =>
      '<span style="display:inline-flex;width:100px;height:50px;align-items:center"><div><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</div><div style="height:40px">k</div></span>',
    'a table cell aligned to its middle'    =>
      '<span style="display:inline-table"><span style="display:table-cell;height:50px;vertical-align:middle"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span>'
  }.each do |name, atom|
    it "moves a parked marker with its atomic: #{name}" do
      expect_parity(%(<div style="position:relative;width:200px;font:16px monospace">aaaa <span>#{atom}</span> t</div>), 48.015625, chrome_y: 14)
    end
  end
  # …and the ROOT of a shift is not moved by it: `reuseSubtree` putting a reused marker back where it now belongs
  # shifts that marker's stale box, and a flex item laid out twice (measured, then stretched) parks its marker
  # twice — so placing the first entry moved the SECOND by the reuse delta (57.6 after one mutation where native
  # and Chrome say 60.6). Only after a mutation, so the spec makes one.
  it 'leaves a parked marker\'s own entry alone when its reused box is put back' do
    body = '<div id="o" style="position:relative;width:220px;font:16px monospace">aaaa <span style="position:relative;left:3px">' \
           '<span style="display:inline-flex;width:100px"><div style="height:40px">Q</div>' \
           '<div><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</div></span></span> t</div>'
    with_page(body) do |session|
      expect(parity(session)).to include('ok' => true, 'mismatches' => 0)
      session.evaluate_script("document.getElementById('o').setAttribute('data-x', '1')")
      r = parity(session)
      expect(r).to include('ok' => true, 'mismatches' => 0), r.inspect
      expect_no_dropped_records(r, body)
      expect_near(marker_x(session), 60.625, body, 'x')
    end
  end
  # …and the same shift now reaches an out-of-flow child placed directly in an inline-flex inside an edged
  # inline, whose static position is ALIGNED (centred) off the atomic's box: the oracle left it where the atomic
  # stood before the line's alignment moved it (x 82.5; native and Chrome 85.5).
  it 'moves an aligned static position with the atomic around it' do
    expect_parity(
      '<div style="position:relative;width:120px;font:16px monospace;text-align:center">aaaa <span style="padding-left:6px">' \
      '<span style="display:inline-flex;width:60px;height:30px;justify-content:center;align-items:center"><i id="m" style="position:absolute;width:3px;height:3px"></i>k</span></span> tt uu vv</div>',
      85.5,
      chrome_y: 13.5
    )
  end
  # …and what both engines still do differently from Chrome there, recorded. In an rtl block with LTR text the
  # figure is BIDI — Chrome reorders the trailing ` t` (the inline-block lands at 50 where both engines put it at
  # 30.8) and puts the marker before the LTR run `cc` at 80.8, two divergences that nearly cancel — which is the
  # excluded subsystem, not a box rule. And a held box does not follow a `position: relative` inline it waits
  # in (22; Chrome 24 — the same without the inline-block around it; where an rtl CORNER decides x, the offset
  # does reach it, in both engines and in Chrome).
  it 'places a held marker in an rtl inline-block by the engines\' bidi-less order (shared)' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace;direction:rtl"><span style="padding-left:6px">' \
      '<span style="display:inline-block;width:50px">bb <span style="padding-left:4px"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span></span> t</div>',
      chrome_y:        22,
      shared_x:        77.8,
      shared_x_chrome: 80.796875
    )
  end
  it 'leaves a held marker where it was held, not where its relative inline moves (shared)' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace"><span style="padding-left:6px">' \
      '<span style="display:inline-block;width:50px">bb <span style="padding-left:4px;position:relative;top:2px"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span></span> t</div>',
      10,
      shared_y:        22,
      shared_y_chrome: 24
    )
  end
  # A held marker is aligned by where it STANDS, past the edges still waiting: at the bare cursor, a NEGATIVE
  # opening margin left it past the tab gap the `pre` run then put down before it, and the justify spread
  # moved it by that gap (the ORACLE's 48; native and Chrome 34.4). The last of the family the review's
  # justify / held-marker sweeps parked (`justhang`, `placedspace`, `brflush` are permanent again).
  it 'aligns a held marker by where it stands past a negative opening margin' do
    expect_parity(
      %(<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa<span style="margin-left:-4px"><i id="m" style="position:absolute;width:2px;height:2px"></i>) +
      %(<span style="white-space:pre">\tb</span></span> end</div>),
      34.40625,
      chrome_y: 0
    )
  end
  # …but by COORDINATE, which is only right for the gaps that come AFTER the marker in flow order: a negative
  # edge that reaches back over ordinary gaps BEFORE it leaves those uncounted, where Chrome widens them and
  # moves the marker (both engines 77.4; Chrome 80.797 — the oracle had it before the change above). Counting
  # a held marker's gaps in FLOW order, as an atomic's are (`gapsBefore`), matches Chrome on both; that is a
  # conformance change for both engines, recorded rather than made during the port.
  it 'counts a held marker\'s gaps by coordinate past a negative edge (shared)' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify">a a a a <span style="margin-left:-9.6px"><i id="m" style="position:absolute;width:3px;height:3px"></i>ww</span> t uu vv</div>',
      shared_x:        77.4,
      shared_x_chrome: 80.796875
    )
  end
  # A JUSTIFIED line that wraps right after `aaaa ` and an inline's closing margin: the space is still the
  # line's trailing white space — an edge moves the pen without ending the hang — so nothing is spread over
  # it. The oracle cut its gaps at `lineX - trailingHang`, which the margin pushed past the space, and spread
  # the whole free space into it (the marker at 105.6, past the line; native 48). It cuts where the hang
  # BEGAN now. Chrome carries the empty span and its marker to the next line with the word glued to them
  # (0, 44) where both engines leave them at the end of this one — shared, recorded.
  it 'spreads nothing over a trailing space an inline\'s closing edge follows on a justified line' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa aaaa aaaa ' \
      '<span style="margin-right:4px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span>bbbbbbbb</div>',
      shared_x:        48,
      shared_x_chrome: 0
    )
  end
  # …and the rest of that family, found by the review's held-marker and justify sweeps, all older than this
  # work. Each figure is Chrome's; the engines had split on each.
  {
    # NATIVE placed a collapsed space still pending at an edge AFTER the edge — its advance and its gap — where
    # the oracle placed it where it met it: a marker inside the inline, past the space, was not moved by the
    # spread (48).
    'a pending space goes down before the closing edge after it' =>
      ['<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa <span style="margin-right:30px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span>b end</div>', 60.390625, 0],
    # The ORACLE put an empty inline's edge down without the block margin still open above it, so the line
    # sat INSIDE the previous block's bottom margin (22).
    'an edge-only line after a block margin'                      =>
      ['<div style="position:relative;width:100px;font:16px monospace"><p style="margin:0 0 20px">x</p><span style="padding-left:6px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span> t</div>', 6, 42],
    # …and a margin that carries the line past a float left it the float's band (56).
    'an edge-only line a margin carries past a float'              =>
      ['<div style="position:relative;width:100px;font:16px monospace;line-height:0"><div style="float:left;width:50px;height:10px"></div>' \
       '<p style="margin:0 0 20px">x</p><span style="padding-left:6px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span> t</div>', 6, 20],
    # The ORACLE let a wrapping run's PRESERVED spaces turn the separator a `pre` run ended in into a gap: they
    # are trailing white space, and Chrome spreads nothing over any of it (100).
    'a pre run\'s separator before trailing preserved spaces'      =>
      ['<div style="position:relative;width:100px;font:16px monospace;text-align:justify;white-space:pre-wrap">aaaa<span style="white-space:pre"> </span>' \
       '<span><i id="m" style="position:absolute;width:2px;height:2px"></i></span>  bbbb bbbb end</div>', 48.015625, 0]
  }.each do |name, (body, chrome_x, chrome_y)|
    it "places a marker where Chrome does: #{name}" do
      expect_parity(body, chrome_x, chrome_y: chrome_y)
    end
  end
  # …and one the engines now SHARE: a negative closing margin pulls the line's end back past the real gap
  # before it, and a line that ends in content (the atomic) has no hang to cut its gaps at by order, so both
  # cut by coordinate and spread nothing (24; Chrome 96). Native used to agree with Chrome by accident — it
  # put the space down AFTER the edge — which is the placement fixed above. Recorded.
  it 'spreads nothing when a negative closing margin pulls the line end back past a gap (shared)' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa <span style="margin-right:-24px"> </span>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b>bbbbbbbb end</div>',
      shared_x:        24,
      shared_x_chrome: 96
    )
  end
  # NATIVE, older: a non-wrapping run that cannot fit breaks the line FIRST, and dropped the collapsed space
  # still pending with it — where the oracle had placed it as a hang, which ends the run of PRESERVED spaces
  # before it. Kept hanging, those aligned the wrapped line as if they still hung off its end (28.8 here, 96
  # with a tab; the oracle and Chrome 19.2 / 23.2).
  {
    'a preserved space' => ['xxxxxxx ', 19.2],
    'a preserved tab'   => ["xxxxxxx\t", 23.2]
  }.each do |name, (prewrap, chrome_x)|
    it "ends a preserved hang with the space a non-wrapping run's early break drops: #{name}" do
      expect_parity(
        %(<div style="position:relative;width:100px;font:16px monospace;text-align:right"><b id="m" style="display:inline-block;width:4px;height:4px"></b>) +
        %(<span style="white-space:pre-wrap">#{prewrap}</span> <span style="white-space:pre">aa</span></div>),
        chrome_x
      )
    end
  end
  # NATIVE: a `pre` run placed WHOLE is content, so the separators the `pre` run before it ENDED in become gaps
  # there — the oracle's `placeOnLine` flushes the tail it follows; native flushed it only behind a real
  # collapsed space. Both engines still share an older gap with Chrome on this line (43.2; Chrome 57.59).
  it 'turns a pre run\'s trailing separators into gaps where the next pre run is placed' do
    expect_parity(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify"><span style="white-space:pre">  </span><b id="m" style="display:inline-block;width:4px;height:4px"></b>' \
      '<span style="white-space:pre"> </span><span style="white-space:pre"> </span> <span style="white-space:pre-wrap">  </span>bbbbbbbbbb end</div>',
      shared_x:        43.2,
      shared_x_chrome: 57.59375
    )
  end

  # A `vertical-align` baseline SHIFT (sub / super / length / %) on an inline element offsets its whole content —
  # its runs ride the shift, growing the line box the block's height reflects. Native threads the accumulated
  # shift through the run stream. (`middle` / `text-top` / `text-bottom`, which place against a box, still decline.)
  ['<sup>x</sup>', '<sub>x</sub>', '<span style="vertical-align:super">x</span>',
   '<span style="vertical-align:sub">x</span>', '<span style="vertical-align:6px">x</span>',
   '<span style="vertical-align:-4px">x</span>', '<span style="vertical-align:40%">x</span>'].each do |el|
    it "matches an inline vertical-align shift #{el[0, 30]}" do
      expect_parity(%(<div style="width:300px">text before #{el} and after text</div>))
    end
  end
  it 'matches nested vertical-align shifts (a sub inside a sup accumulate)' do
    expect_parity('<div style="width:300px">base <sup>up <sub>back down</sub> up</sup> base</div>')
  end
  it 'matches a shifted inline wrapping across lines' do
    expect_parity('<div style="width:120px">word word <span style="vertical-align:super">up</span> word word word word</div>')
  end
  # A shifted element raises only its DIRECTLY-owned text; a NESTED inline child stays on the baseline (the
  # oracle does not raise it), so the line box does not grow — the common `<sup><a>1</a></sup>` footnote-link.
  it 'matches a superscript wrapping a link (nested text stays on the baseline)' do
    expect_parity('<div style="width:300px">footnote <sup><a href="#">1</a></sup> here</div>')
  end
  it 'matches a shift whose text is inside a nested span (no line growth)' do
    expect_parity('<div style="width:300px">a <span style="vertical-align:super"><span>text</span></span> b</div>')
  end
  it 'matches a shift wrapping bold nested content (no line growth)' do
    expect_parity('<div style="width:300px">a <sup><b>1</b></sup> b</div>')
  end
  # A whitespace-only inline in a larger font is a fragment on the line it sits on and grows the line box
  # (Chrome: 47 for `a<span style="font-size:40px"> </span>b` in a 16px block); native never grew a line for a
  # placed collapsed space (review finding). The ORACLE grows it only where the space stays — a space the wrap
  # drops grows nothing there, where Chrome grows a line for ANY inline fragment on it (CSS 2.1 §10.8: an empty
  # inline, a dropped space, a <br> inside a larger inline). That is a shared gap of both engines, kept in
  # parity here and tracked as a backlog item; these cases pin the parity, not Chrome.
  it 'grows a line for a placed whitespace-only inline of a larger font (the oracle: not for a space the wrap drops)' do
    expect_parity('<div style="width:300px"><div>a<span style="font-size:40px"> </span>b</div></div>')
    expect_parity('<div style="width:300px"><div>a <span style="font-size:40px"> </span> b</div></div>')
    expect_parity('<div style="width:60px"><div>aaaa<span style="font-size:40px"> </span>bbbb cccc</div></div>')
    expect_parity('<div style="width:300px"><div><span style="font-size:40px"> </span>a</div></div>')
    expect_parity('<div style="width:300px;white-space:pre"><div>a<span style="font-size:40px"> </span>b</div></div>')
    expect_parity('<div style="width:60px;white-space:pre-wrap"><div>aaaa<span style="font-size:40px"> </span>bbbb</div></div>')
    expect_parity('<div style="width:60px"><div>aaaa<span style="font-size:40px"> </span><span style="display:inline-block;width:30px;height:5px"></span></div></div>')
  end

  # A WIDE character — CJK, fullwidth, Hangul — is its own break unit, which is what makes a Japanese paragraph
  # wrap at all: it has no spaces to break at. Native cuts the same units the oracle's `charUnits` does
  # (`break_unit_len`: a wide character alone, a maximal non-wide run otherwise), in the flow and in the
  # min-content measure alike. Until this, such a run reached Rust, `measure_run` answered None and the whole
  # PASS was discarded — so every Japanese page fell back to the oracle entirely.
  describe 'wide characters break between themselves' do
    it 'wraps a CJK run between characters, and measures its min-content as one' do
      expect_parity('<div style="width:100px">日本語のテキストです</div>')
      expect_parity('<div style="width:100px">これは長い日本語の文章で折り返しが必要になります</div>')
      expect_parity('<div style="width:400px">日本語</div>')
      expect_parity('<div style="width:100px">mixed 日本語 and ascii text here</div>')
      expect_parity('<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>日本語のテキスト</div><div>x</div></div>')
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0">日本語のテキスト</td><td style="padding:0">bb</td></tr></table>')
    end
    # A wide character is an opportunity on BOTH sides, across a run boundary too — two text nodes, or a
    # `<span>` between them, are one word to the flow otherwise. An astral emoji is NOT one (the oracle's
    # `isWideChar` is BMP-only), and a ZWJ sequence must not be split into per-surrogate units.
    it 'breaks beside a wide character across a run boundary, and not around an astral one' do
      expect_parity('<div style="width:60px">日本語<span>abcdefghijkl</span></div>')
      expect_parity('<div style="width:60px"><span>日本語</span>abcdefghijkl</div>')
      expect_parity('<div style="width:60px">abc<span>defghijkl</span></div>')
      expect_parity('<div style="width:100px">aaaaaaaaaaaa&#x1F600;bbbbbbbbbbbb</div>')
      expect_parity('<div style="display:inline-block"><span>&#x1F468;&#x200D;&#x1F469;&#x200D;&#x1F467;</span></div>')
    end
    # The opportunity a wide character leaves has to cross a RUN boundary, because that is where the two
    # engines can disagree: native merges only same-font runs, so a plain `<b>` around a Japanese word — or a
    # padded inline, or a different size — splits them, and without carrying the opportunity native glued what
    # the oracle (and Chrome) break. Both directions: a run ENDING wide, and a word STARTING wide.
    it 'breaks beside a wide character across a font, weight or padding boundary' do
      expect_parity('<div style="width:60px">abcdefghij<b>日本語</b>klmnopqrst</div>')
      expect_parity('<div style="width:60px"><b style="padding-right:4px">日本語</b>abcdefghij</div>')
      expect_parity('<div style="width:60px">日本語<span style="font-size:24px">abcdefghijkl</span></div>')
      expect_parity('<div style="width:60px">abcdefgh<span style="font-size:24px">日</span>ijklmnop</div>')
      expect_parity('<div style="width:60px">abc<span style="font-size:24px">日本語</span>def</div>')
      expect_parity('<div style="width:60px">日本語<span style="font-size:24px">日本語</span>日本語</div>')
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0;width:60px">日本語<span style="font-size:24px">abcdefghijkl</span></td></tr></table>')
      # …and the MIN-CONTENT of a word whose wide character is not at its edge: only the wide unit is an
      # opportunity there (`own`), so the Latin run before it stays glued to the run before THAT — bracketing
      # every unit closed the word early and measured 42.63 where the oracle says 59.53, and lost a padded
      # inline's 20px edge outright.
      ['<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>%s</div><div>x</div></div>'].each do |wrap|
        expect_parity(format(wrap, 'abcdef<b>gh日</b>'))
        expect_parity(format(wrap, '<b>日ab</b>cdefgh'))
        expect_parity(format(wrap, '<span style="padding-left:20px">abcd日</span>'))
        expect_parity(format(wrap, 'abcdef日'))
      end
      # …and the ASCII shapes it must not move: a mid-word run boundary is still no opportunity
      expect_parity('<div style="width:60px">abcdefghij<b>klm</b>nopqrst</div>')
      expect_parity('<div style="width:60px">abc<span style="font-size:24px">def</span>ghi</div>')
    end
    # …and per-character breaking is the OWNER's mode: one CJK character in a paragraph must not stop its Latin
    # words from breaking, nor route them through the unspaced measure that drops their letter-spacing.
    it 'keeps break-all over the Latin words of a mixed paragraph' do
      expect_parity('<div style="display:flex;width:50px"><div style="word-break:break-all">&#x65E5; abcdefghijklmnop</div></div>')
      expect_parity('<div style="display:flex;width:50px"><div style="word-break:break-all"><span>&#x65E5;</span> abcdefghijklmnop</div></div>')
      expect_parity('<div style="display:inline-block;letter-spacing:4px"><span>&#x65E5; abcdefgh</span></div>')
      # …while a word that DOES hold one still breaks per code point under that mode (`own = perChar || wide`),
      # tail included — grouping the Latin tail back into one unit measured 58.63 against the oracle's 50.
      expect_parity('<div style="display:flex;width:50px"><div style="word-break:break-all">&#x65E5;abcdefgh</div></div>')
    end
    # A COLLAPSED tab is measured by nobody — the whitespace run never reaches `measure_run` — so tab-indented
    # markup lays out natively whatever the mode. (A PRESERVED one is native's too now: see the tab-stop
    # describe below. A FORM FEED still declines — `declines a preserved form feed …` covers that.)
    it 'lays out tab-indented markup' do
      expect_parity("<div style=\"width:400px\">\n\t<span>hello</span>\n</div>")
    end
    it 'keeps the wrap modes and spacing over a CJK run' do
      expect_parity('<div style="width:60px;word-break:break-all">日本語のテキスト</div>')
      expect_parity('<div style="width:60px;overflow-wrap:anywhere">日本語のテキスト</div>')
      expect_parity('<div style="width:60px;white-space:nowrap">日本語のテキスト</div>')
      expect_parity('<div style="width:60px;white-space:pre-wrap">日本語の テキスト</div>')
      expect_parity('<div style="width:60px;letter-spacing:2px">日本語のテキスト</div>')
    end
    # A HYPHEN or dash is a break opportunity of native's own now (`hyphen_breaks_after`, the oracle's
    # `HYPHEN_BREAK_RE`): the word is cut into PIECES, each keeping its hyphen, and the pieces are what the
    # line fits. Only a SOFT one still declines — the flow draws a hyphen the text never held.
    it 'breaks a hyphenated word at its hyphens' do
      expect_parity('<div style="width:90px">well-known example text</div>')
      expect_parity('<div style="width:300px">a hyphenated word that fits stays whole: well-known</div>')
      expect_parity('<div style="width:60px">xxxx --no-cache</div>')     # after EACH hyphen of a double one
      expect_parity('<div style="width:60px">12-34-56-78-90</div>')      # …between digits too
      expect_parity('<div style="width:60px">-leading trailing-</div>')  # …one that OPENS a word; none after a trailing one
      expect_parity('<div style="width:60px">xx -55 -aa</div>')          # …and none before the digit a hyphen signs
    end
    it 'breaks on both sides of an em dash, never at a non-breaking hyphen' do
      expect_parity('<div style="width:60px">foo—bar</div>')
      expect_parity('<div style="width:60px">foo–bar</div>')
      expect_parity('<div style="width:60px">foo&#x2012;bar</div>')
      expect_parity('<div style="width:60px">foo&#x2011;bar</div>')
      expect_parity('<div style="width:60px">foo/bar</div>')
    end
    # The PIECE is what the in-word modes ask their fit question of — a per-character break is offered only to a
    # piece too wide for the band, not to the whole word — so `super-cali-fragilistic` breaks at its hyphens and
    # only the piece that still overflows breaks between characters. Cutting the word per character instead laid
    # it out in three lines against the oracle's and Chrome's four.
    it 'cuts inside a hyphen piece only where that piece alone overflows' do
      %w[overflow-wrap:break-word overflow-wrap:anywhere word-break:break-all].each do |mode|
        expect_parity(%(<div style="width:50px;#{mode}">super-cali-fragilistic</div>))
        expect_parity(%(<div style="width:100px;#{mode}"><span>aaaaaaaaaaaa-bbbbbbbbbbbbbb</span></div>))
        expect_parity(%(<div style="width:120px;#{mode}">up-to-date info</div>))   # every piece fits: no cut at all
      end
      # …and `overflow-wrap` moves the piece it must cut to a fresh line where `word-break: break-all` fills the
      # line it is on — a difference the piece loop has to make per PIECE, not once per word.
      expect_parity('<div style="width:90px;overflow-wrap:break-word">see-alsoooooooooooooooo</div>')
      expect_parity('<div style="width:90px;word-break:break-all">see-alsoooooooooooooooo</div>')
    end
    # min-content takes the pieces and nothing finer: the oracle's `addUnit` returns on its hyphen branch, so a
    # piece is measured whole however the mode would cut it in the flow.
    it 'measures a hyphenated word as its widest piece' do
      ['', 'word-break:break-all', 'overflow-wrap:break-word'].each do |mode|
        expect_parity(%(<div style="width:min-content;#{mode}">well-known example</div>))
        expect_parity(%(<div style="width:max-content;#{mode}">well-known example</div>))
        expect_parity(%(<div style="display:grid;grid-template-columns:min-content auto;width:400px;#{mode}"><div>e-mail-address</div><div>x</div></div>))
      end
    end
    # A run that ENDS in a dash leaves the opportunity behind for the next run to take (`ends_with_break`, the
    # oracle's `endsWithBreak`) — the hyphen of `well<b>-</b>known` is a run of its own, so the break after it
    # is the only one that word has. Reading it as a WIDE character's rule alone left native a line short on
    # every such shape, silently: nothing declined.
    it 'breaks after a dash a run ends with' do
      expect_parity('<div style="width:70px">well<b>-</b>known example</div>')
      expect_parity('<div style="width:70px">well-<b>known</b> example</div>')
      expect_parity('<div style="width:70px">trailing-<span style="padding:0 4px">piece</span></div>')
      expect_parity('<div style="width:70px">x<b>&#x2014;</b>y longer text</div>')
      expect_parity('<div style="width:70px">well<b>x</b>known example</div>')   # …and a letter leaves none
    end
    # …and a run BOUNDARY inside a word is not a token boundary: a word is whatever the text spells, however
    # many nodes spell it. The walk merges adjacent same-font text into one run, so the hyphen piece would run
    # PAST the node the oracle stops at — `well-known` + `Z` is one word to native and two tokens to the
    # oracle. The merge stops at a glued join for that reason.
    it 'agrees on a word spelled by more than one text node' do
      expect_parity('<div style="width:100px">well-known<span>Z</span></div>')
      expect_parity('<div style="width:100px">well-<span>known</span></div>')
      expect_parity('<div style="width:100px">aa<span>-</span>bb longer text here</div>')
      expect_parity('<div style="width:min-content">well-<span>known</span></div>')
      expect_parity('<div style="width:min-content">aa<span>-</span>bb</div>')
      expect_parity('<div style="width:100px">xx abcd<span>efghijklmn</span> yy</div>')   # …hyphen or not
    end
    # A collapsed space before a word the wrap then BREAKS grows nothing: the space's own metrics belong to the
    # line it stays on, and the unit loop has to apply them after that break test, not before it.
    it 'gives the line the space of a larger font only where the space stays' do
      expect_parity('<div style="width:30px">q<span style="font-size:40px"> </span>well-known</div>')
      expect_parity('<div style="width:30px">q<span style="font-size:40px"> </span>&#x65E5;&#x672C;&#x8A9E;</div>')
      expect_parity('<div style="width:24px;word-break:break-all">q<span style="font-size:40px"> </span>aaaa</div>')
      expect_parity('<div style="width:300px">q<span style="font-size:40px"> </span>well-known</div>')  # …and where it does stay
    end
    # A run ending in a JS `\s` that is NOT css white space — an NBSP, a thin space, a BOM — leaves an
    # opportunity too (`BREAK_AFTER_RE`), and none of them reaches native as a space run of its own.
    it 'breaks after a non-collapsing space a run ends with' do
      %w[000B 00A0 2007 2009 200A 2028 2029 202F 205F 1680 2000 2003 FEFF].each do |cp|
        expect_parity(%(<div style="width:80px">xx ab&\#x#{cp};<b>kgkgkgkg</b></div>))
      end
    end
    # The regex's `\p{L}` / `\p{N}` are asked of CODE POINTS: an astral letter after a hyphen is one, and
    # reading its lone surrogate instead lost the break.
    it 'breaks after a hyphen an astral letter follows' do
      expect_parity('<div style="width:70px">ab-&#x1D518;&#x1D52B;-cd more</div>')
      expect_parity('<div style="width:70px">ab-&#x1D7D8;&#x1D7D9; more</div>')
      expect_parity('<div style="width:70px">ab-&#x1F600; more</div>')           # …and an emoji is neither
    end
    # …and they are the REGEX's classes, not Rust's `is_alphanumeric`: a combining mark is Alphabetic and no
    # letter, an enclosed one (U+24B6) is So and no letter, and reading either as one moved the boxes.
    it 'reads a combining or enclosed character after a hyphen as no letter' do
      # …and A7F1 / 0C5C, which Rust std calls letters and this V8 does not: asking `char::is_alphabetic`
      # rather than `\p{L}` itself made the answer depend on the rustc the extension was built with.
      %w[093E 0903 064E 05B8 0345 0E31 17BB 24B6 2160 0301 00AA 2070 A7F1 0C5C].each do |cp|
        expect_parity(%(<div style="width:30px">q abab-&\#x#{cp};cdcd more</div>))
        # …and min-content, where the piece the break would make is the measure itself — the word-OPENING
        # hyphen's class (`\p{L}` alone) shows up nowhere else.
        expect_parity(%(<div style="width:min-content">abab-&\#x#{cp};cdcdcdcd</div>))
        expect_parity(%(<div style="width:min-content">-&\#x#{cp};cdcdcdcdcdcd</div>))
      end
    end
    # A hyphen inside a word that also holds a WIDE character: the pieces come first, and a piece bearing one
    # then breaks at it — the two cuts compose, as `breakUnits` composes them.
    it 'composes hyphen pieces with wide-character units' do
      expect_parity('<div style="width:60px">mix-&#x65E5;&#x672C;-ed</div>')
      expect_parity('<div style="width:60px;word-break:break-all">mix-&#x65E5;&#x672C;-ed</div>')
      expect_parity('<div style="width:min-content">mix-&#x65E5;&#x672C;-ed</div>')
    end
    # …and the same undecidable arm took down every OTHER character at or above U+0300, because whether one is a
    # combining mark is the question `zero_width` could not answer. It answers it from `\p{M}` now (`unicode.rs`).
    it 'measures a space, a dash, an emoji and a combining mark' do
      expect_parity('<div style="width:400px">a&#x2003;b</div>')
      expect_parity('<div style="width:400px">a&#x2002;b</div>')
      expect_parity('<div style="width:400px">a&#x3000;b</div>')
      expect_parity('<div style="width:400px">a&#x00B7;b</div>')
      expect_parity('<div style="width:400px">caf&#x00E9; na&#x00EF;ve</div>')
      expect_parity('<div style="width:400px">&#x0301;a</div>')
      expect_parity('<div style="width:400px">&#x2764;&#xFE0F;</div>')
      expect_parity('<div style="width:400px">&#x1F600;&#x1F601;</div>')
    end


    # What native still cannot measure is refused by the WALK, not discovered in Rust: a preserved FORM FEED,
    # and a ZWJ under a per-character wrap (where the oracle's advance carries the previous character). (A CR
    # cannot be tested from markup at all — the HTML parser normalizes every one in the input stream to a
    # newline, so no parsed text node ever holds one.)
    it 'declines a preserved form feed and a per-character ZWJ in the walk' do
      ["<div style=\"width:400px;white-space:pre\">a\fb</div>",
       '<div style="width:400px;word-break:break-all">a&#x200D;b</div>'].each do |body|
        expect(shadow(body)).to include('ok' => false, 'reason' => 'text-not-measurable'), body
      end
    end
  end
  # A `<br clear>` CLEARS the floats before the next line — HTML's pre-CSS way of ending a float band, and
  # still the mapping the rendering section gives the attribute. The break moves the flow past the bottom of
  # every float on the named side and re-takes the band; native does that itself now (the side rides the BR
  # run, resolved through the containing block's direction, because `clear: inline-start` is a question about
  # THAT and the line layout has no direction to ask).
  # A collapsed space is dropped only at the START of a line — where nothing has been PLACED on it yet — and not
  # wherever the pen happens to stand at or behind the line's left edge: a negative inline margin puts it there
  # mid-line (Chrome keeps the space, 26.41), and so does a float placed beside a line that already holds a word.
  it 'keeps a space the pen reaches at the line start mid-line' do
    expect_parity('<div style="width:200px;font:16px monospace"><span style="margin-left:-12px">x y </span><span id="m" style="display:inline-block;width:10px;height:10px"></span></div>', 26.41)
    expect_parity('<div style="width:300px">aaa <span style="float:left;width:50px;height:20px"></span>bbb <span id="m" style="display:inline-block;width:10px;height:5px"></span></div>')
    # …and a text node that OPENS on that space, whose leading space the run's own collapse decides (Chrome 16)
    expect_parity('<div style="width:300px"><span style="margin-left:-10px"><span style="display:inline-block;width:10px;height:5px"></span></span> y <span id="m" style="display:inline-block;width:5px;height:5px"></span></div>', 16)
    expect_parity('<div style="width:300px"><span style="display:inline-block;width:50px;height:5px"></span><span style="float:left;width:50px;height:20px"></span> bbb <span id="m" style="display:inline-block;width:5px;height:5px"></span></div>')
  end

  it 'clears the floats a <br> names before the next line' do
    floats = '<div style="float:left;width:100px;height:40px"></div><div style="float:right;width:60px;height:70px"></div>'

    # The ATTRIBUTE maps only the four physical spellings (`BR_CLEAR_HINTS`), `all` being HTML4 for `both`;
    # `clear` reaches the flow-relative sides through CSS only, so those go through a declaration.
    ['clear="left"', 'clear="right"', 'clear="both"', 'clear="all"',
     'style="clear:inline-start"', 'style="clear:inline-end"'].each do |clear|
      expect_parity(%(<div style="display:flow-root;width:300px">#{floats}<div>aa<br #{clear}>bb</div></div>))
      # …and a flow-relative side resolves against the CONTAINING BLOCK's direction — so in rtl these two
      # are the other float, and the physical four are unmoved
      expect_parity(%(<div style="display:flow-root;width:300px;direction:rtl">#{floats}<div>aa<br #{clear}>bb</div></div>))
    end
    # …the block's direction, not the `<br>`'s own: an rtl inline around it changes nothing
    expect_parity(%(<div style="display:flow-root;width:300px">#{floats}<div>aa<span style="direction:rtl"><br style="clear:inline-start"></span>bb</div></div>))
    # …with nothing to clear it is an ordinary break, and a plain `<br>` beside floats is one too
    expect_parity('<div style="width:300px">aa<br clear="both">bb</div>')
    expect_parity(%(<div style="display:flow-root;width:300px">#{floats}<div>aa<br>bb</div></div>))
    # …and a `<br>` is CONTENT whether or not it clears: an inline-block holding only one is a line tall,
    # not empty (measured — losing that made it 0 and moved the box 14px up its line).
    expect_parity('<div style="width:400px">text <span style="display:inline-block"><br></span> x</div>')
    expect_parity('<div style="width:400px">text <span style="display:inline-block"><br clear="left"></span> x</div>')
  end

  # `text-indent` narrows the line it is on from the START edge — the right one in rtl — rather than moving a
  # cursor inside it, so an indented empty line is still empty. Which lines take it: the first, or with
  # `hanging` every line BUT the first, and with `each-line` the first after every forced break as well. It was
  # the walk's most common decline after auto margins, and it is on BOTH figures the intrinsic measure returns.
  describe 'text-indent narrows the lines it is on' do
    it 'indents the first line, and wraps around the narrower line' do
      expect_parity('<div style="width:200px;text-indent:40px">one two three four five six seven eight</div>')
      expect_parity('<div style="width:200px;text-indent:40px"><span style="display:inline-block;width:10px;height:10px"></span> tail</div>')
      expect_parity('<div style="width:200px;text-indent:-30px">one two three four five six seven eight</div>')
      # …a PERCENTAGE against the block's own CONTENT width, not its border box
      expect_parity('<div style="width:200px;padding:0 20px;border-left:10px solid;text-indent:20%">one two three four five six</div>')
      # …and a LINEAR `calc()` of one. `textIndentOf` split its value on white space and `parseFloat`'d the
      # pieces, so `calc(10% + 1px)` arrived as `calc(10%` / `+` / `1px)` and the last of them was read as an
      # indent of ONE PIXEL — in both engines, so no sweep could ever say so. Chrome 153 puts the marker at
      # 60.203125 where that gave 20.2, and `shared_x` cannot cover it: the two engines agreed on 20.2 and
      # both were wrong. The 10% shape beside it is the control the bug left passing.
      expect_parity('<div style="width:400px;font:16px monospace;text-indent:calc(10% + 1px)">hi' \
                    '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 60.203125)
      expect_parity('<div style="width:400px;font:16px monospace;text-indent:10%">hi' \
                    '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 59.203125)
    end
    # …and a COMPARISON function over ONE affine operand with constant bounds is `clamp(lo, px + frac x basis,
    # hi)`, which the record carries (rec[129]/130 beside rec[96]/118) and native evaluates — so it takes the
    # native path like a plain percentage.
    # It was a MISMATCH for one build, and the way it got there is worth the line: the reader answered `null`
    # for "not linear" as well as for "no indent", `nlWriteIndent` drops a null, and native laid the block out
    # at indent 0 while the oracle indented 30. Before that both engines were right by accident — the reader
    # could not parse a math function at all and `parseFloat`'d `30px)` out of `min(50%, 30px)`.
    it 'evaluates a min() / clamp() text-indent natively' do
      ['min(50%, 30px)', 'clamp(5px,50%,30px)'].each do |indent|
        expect_parity(%(<div style="width:400px;font:16px monospace;text-indent:#{indent}">hi) +
                      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 49.203125)
      end
    end
    # …and one capped by ANOTHER LINE goes native too, since the bounds are affine as well: `min(10%, 20%)` is
    # `10%` held under `20%`. Only a NESTED comparison is left for the oracle alone.
    it 'evaluates a text-indent capped by another percentage natively' do
      expect_parity('<div style="width:400px;font:16px monospace;text-indent:min(10%, 20%)">hi' \
                    '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 59.203125)
    end
    it 'indents every line but the first under hanging, and after a forced break under each-line' do
      expect_parity('<div style="width:200px;text-indent:40px hanging"><span style="display:inline-block;width:10px;height:10px"></span> one two three four five six seven</div>')
      expect_parity('<div style="width:200px;text-indent:40px each-line">x<br><span style="display:inline-block;width:10px;height:10px"></span> two</div>')
      expect_parity('<div style="width:200px;text-indent:40px">x<br><span style="display:inline-block;width:10px;height:10px"></span> two</div>')
    end
    # In a MIXED block the indent is the BLOCK's, not each anonymous group's: only "is this the block's first
    # line" is one-shot — the first group that places a line takes it, and a block-level child spends whatever
    # no line took (Chrome puts the span after the inner block at x=0, not at 40). The PER-LINE rules go on
    # applying in every later group, which is what these wrapping cases pin: writing the indent to the first
    # group alone left a later group's `hanging` lines flush (native 77 where Chrome says 113).
    it 'gives a mixed block its indent once, and a block child spends it' do
      expect_parity('<div style="width:200px;text-indent:40px">text <div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      expect_parity('<div style="width:200px;text-indent:40px"><div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      expect_parity('<div style="width:200px;text-indent:40px">  <div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      # …and the LINE COUNT of a group after the block child, where the per-line rules actually show
      words = 'aa bb cc dd ee ff gg hh ii jj kk ll mm nn'
      expect_parity(%(<div style="width:100px;text-indent:40px hanging">x<div style="height:5px"></div>#{words}</div>))
      expect_parity(%(<div style="width:100px;text-indent:40px each-line">x<div style="height:5px"></div>q<br>#{words}</div>))
      expect_parity(%(<div style="width:100px;text-indent:40px">x<div style="height:5px"></div>#{words}</div>))
      expect_parity(%(<div style="width:100px;text-indent:-20px">#{words}</div>))
    end
    # …and it is on the first line of BOTH intrinsic figures, where a PERCENTAGE resolves against nothing —
    # which is what leaves the `text-indent: -9999px` hidden-label idiom its padding.
    # …but an INTRINSIC measure of an indented block stays with the oracle. What Chrome's min-content does with
    # an indent is a real break pass at zero available width — a break at an ITEM boundary always taken, one
    # inside a text item taken only on overflow — where this engine's measure is an accumulator that agrees only
    # when the first line opens with a plain word. Four review rounds of near-miss rules came out of trying to
    # mirror it (an empty inline, a `<wbr>`, a leading space, a negative indent and a soft hyphen each broke a
    # different one), so a MEASURED indented block declines and its caller takes the fallback it already has.
    it 'measures an indented block natively, on the route the plain one takes' do
      # Each pair is the same shape with and without the indent, and BOTH go down the native route: `text_intrinsic`
      # takes the indent the way the oracle's own walk does — the first occupant of each line takes it, a forced
      # break re-arms it under `hanging` / `each-line` — from the length on the record (a `%` resolves against
      # nothing in an intrinsic measure, CSS Sizing 3).
      [['<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div style="%s">aa bb</div><div>x</div></div>', 'nativeIntrinsicGrids'],
       ['<div style="display:grid;grid-template-columns:max-content auto;width:400px"><div style="%s">aa bb</div><div>x</div></div>', 'nativeIntrinsicGrids'],
       ['<div style="width:400px">a <span style="display:inline-block;%s">bb cc</span></div>', 'nativeAtomics']].each do |shape, key|
        ['text-indent:20px', 'text-indent:20%', 'text-indent:-20px', 'text-indent:20px hanging',
         'text-indent:20px each-line', ''].each do |indent|
          r = shadow(format(shape, indent))
          expect(r).to include('ok' => true, 'mismatches' => 0), "#{shape} / #{indent}"
          expect(r[key]).to be > 0, "#{key} under #{indent.inspect}: #{r.inspect}"
        end
      end
      # …a `<td>` measures its own contribution too, where it used to push the oracle's.
      cell = shadow('<table style="border-spacing:0"><tr><td style="padding:0;text-indent:20px">aa bb</td><td style="padding:0">cc</td></tr></table>')
      expect(cell).to include('ok' => true, 'mismatches' => 0, 'pushedContributions' => 0)
      expect_parity('<div style="display:inline-block;padding:0 5px;text-indent:-9999px">Label</div>')
      expect_parity('<div style="display:flex;width:400px"><div style="text-indent:30px">aa bb</div></div>')
    end
    # A line's room for content is its band LESS the indent, and the band it drops to has to hold both: a 70px
    # inline-block under a 60px indent beside a 200px float of 300 clears the float (Chrome), where both engines
    # used to keep it beside — and a NEGATIVE indent keeps a line beside a float it would otherwise clear.
    it 'fits a line beside a float on the indented width' do
      float = '<div style="float:left;width:200px;height:40px"></div>'
      wide  = '<div style="float:left;width:250px;height:40px"></div>'
      ib    = '<span style="display:inline-block;width:70px;height:10px"></span>'
      expect_parity(%(<div style="display:flow-root;width:300px">#{float}<div style="text-indent:60px">#{ib}</div></div>))
      expect_parity(%(<div style="display:flow-root;width:300px">#{wide}<div style="text-indent:-30px">#{ib}</div></div>))
      expect_parity(%(<div style="display:flow-root;width:300px">#{wide}<div style="text-indent:-9999px">wwwwwwwwww</div></div>))
      expect_parity(%(<div style="display:flow-root;width:300px">#{float}<div>#{ib}</div></div>))
    end
  end

  # ── `white-space` is the RUN's, not the block's ────────────────────────────────────────────────────────
  # An inline may declare its own, and each of the three behaviours the property controls is then asked of the
  # run it is about: whether THIS text's spaces are real advances, whether a break may fall at THIS space,
  # whether THIS newline forces one. The run stream carries the mode (`Run::ws_mode`) and two runs of different
  # modes never merge into one — the block's own mode decides nothing for them.
  describe 'an inline carrying its own white-space' do
    it 'lays out a WRAPPING inline whatever the block declares' do
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:normal">bbb ccc</span> ddd</div>')
      expect_parity('<div style="width:80px;font:16px monospace">aaa <span style="white-space:pre-wrap">b  c</span> ddd</div>')
      expect_parity(%(<div style="width:200px;font:16px monospace">aaa <span style="white-space:pre-line">b
c</span> ddd</div>))
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre">aaa <span style="white-space:pre-wrap">b  c</span> ddd</div>')
    end
    # …and one whose own mode never wraps is measured under it too: what its line does about it is the
    # unbreakable-token rule below.
    it 'lays out a NON-wrapping inline inside a line that cannot break' do
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:pre">b  c</span> ddd</div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre">aaa <span style="white-space:nowrap">bbb ccc</span></div>')
    end
    # A space belongs to the run that WROTE it, and so does the break opportunity behind it: the oracle leaves
    # a `barrier` of `'hard'` after a non-wrapping run's trailing space, and everything that consumes the space
    # — the next word, the next atomic — has to honour that rather than ask its own mode. A space also REPLACES
    # whatever opportunity the text before it left (a hyphen, a wide character).
    it 'keeps the break opportunity with the space that queued it' do
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:normal">bbbbbbbb ccc</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa <span style="white-space:normal"><span style="display:inline-block;width:60px;height:9px"></span></span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa- <span style="white-space:normal">bbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">一二三 <span style="white-space:normal">bbbbbb</span></div>')
      # …and without the space the opportunity is the hyphen's again
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa-<span style="white-space:normal">bbbb</span></div>')
    end
    # A PRESERVED space is a placement like any other: it puts the collapsed space waiting from an earlier run
    # down first, and it hangs in a counter of its own — the oracle keeps `trailingHang` and `trailingPreserved`
    # mutually exclusive and hangs the preserved ones only on a line that WRAPPED.
    it 'places a waiting collapsed space before a preserved one, and hangs the two apart' do
      expect_parity('<div style="width:400px;font:16px monospace">aaa <span style="white-space:pre-wrap"> </span><span style="display:inline-block;width:20px;height:10px"></span></div>')
      expect_parity('<div style="width:400px;font:16px monospace">aaa <span style="white-space:pre-wrap">  </span>bbb<span style="display:inline-block;width:20px;height:10px"></span></div>')
      expect_parity('<div style="width:200px;font:16px monospace;text-align:right"><span style="display:inline-block;width:20px;height:10px"></span>aaa<span style="white-space:pre-wrap">   </span> wwwwwwwwwwwwwwwwwwww</div>')
      # …and a COLLAPSING whitespace-only run between two preserving ones is a space, not a no-op: the
      # zero-width opportunity a preserved space leaves behind must not stand in for it.
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre-wrap">aaa <span style="white-space:normal">  </span> ddd</div>')
    end
    # A PRESERVED space leaves a barrier behind it too — `null` where its run wraps, HARD where it does not.
    # A `pre` run leaving none at all let a hyphen, a wide character or an atomic on the far side of it open a
    # line the oracle keeps whole. And a wrapping run that STARTS with white space rescues the opportunity of
    # the space already waiting, which is how a `nowrap` block's space still opens a line for the inline after it.
    it 'leaves the right barrier behind a preserved space, and rescues one for a leading space' do
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre">aaaa- </span><span style="white-space:normal">bbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre">aaaa- <span style="white-space:normal">bbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre">一二三 <span style="white-space:normal">bbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre">aaaa </span><span style="white-space:normal"><span style="display:inline-block;width:60px;height:9px"></span></span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:normal"> bbbbbbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:pre-line"> bbbbbbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">一二三 <span style="white-space:normal"> bbb</span> ddd</div>')
      # …while a space that TAKES the slot from a zero-width marker answers for itself, not for the marker
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre-wrap">a </span><span style="white-space:nowrap"> </span><span style="white-space:normal">bbbbbbbb</span></div>')
      # …and the preserved hang ends where a collapsed space is placed among them
      expect_parity('<div style="width:80px;font:16px monospace;text-align:right"><span style="display:inline-block;width:20px;height:9px"></span><span style="white-space:pre-wrap">a </span><span> </span><span style="white-space:pre-wrap"> </span>cccccccc</div>')
    end
    # The INTRINSIC measure asks the same questions through a content-sized box — a float, a vertical writing
    # mode, a `min-content` / `max-content` width, a flex item — where `pin` ("this box never wraps, so its
    # min-content IS its max-content") is the BLOCK's property however its runs are written.
    it 'measures a mixed-mode box through every content-sized route' do
      inner = 'aaa <span style="white-space:normal">bbb ccc</span> ddd'
      # …a newline inside a preserved run included: each newline-SEGMENT is its own placement, so a segment
      # after one starts over and a run that OPENS with a newline drops the space waiting for it.
      expect_parity(%(<div style="width:max-content;font:16px monospace;white-space:nowrap"><span style="white-space:pre">a
b</span><span style="white-space:normal"> c</span></div>))
      expect_parity(%(<div style="width:max-content;font:16px monospace;white-space:nowrap">一二三 <span style="white-space:pre-wrap">
  </span></div>))
      expect_parity(%(<div style="width:min-content;font:16px monospace;white-space:nowrap">#{inner}</div>))
      expect_parity(%(<div style="width:max-content;font:16px monospace;white-space:nowrap">#{inner}</div>))
      expect_parity(%(<div style="width:400px;display:flow-root"><div style="float:left;font:16px monospace;white-space:nowrap">#{inner}</div></div>))
      expect_parity(%(<div style="width:400px"><div style="writing-mode:vertical-lr;font:16px monospace;white-space:nowrap">#{inner}</div></div>))
      expect_parity(%(<div style="display:flex;width:400px"><div style="font:16px monospace;white-space:nowrap">#{inner}</div><div>x</div></div>))
      expect_parity(%(<div style="width:max-content;font:16px monospace">aaa <span style="white-space:pre-wrap">  </span></div>))
      expect_parity(%(<div style="width:max-content;font:16px monospace"><span style="white-space:pre-wrap">  </span> aaa bbb</div>))
    end
    # A mode change at DEPTH 2 is threaded the same way at every gate — the flow's and the intrinsic
    # predicate's — so a subtree that changes mode twice measures as well as it lays out.
    it 'threads a depth-2 mode change through the flow and the intrinsic measure alike' do
      inner = 'aa <span style="white-space:normal">bb <span style="white-space:pre-wrap">cc  dd</span></span> ee'
      expect_parity(%(<div style="width:120px;font:16px monospace">#{inner}</div>))
      expect_parity(%(<div style="width:120px;font:16px monospace;white-space:pre-line">#{inner}</div>))
      expect_parity(%(<div style="width:max-content;font:16px monospace">#{inner}</div>))
      expect_parity(%(<div style="width:400px;display:flow-root"><div style="float:left;font:16px monospace">#{inner}</div></div>))
      expect_parity(%(<div style="width:400px"><div style="writing-mode:vertical-lr;font:16px monospace">aa <span style="white-space:nowrap">bb <span style="white-space:pre">cc  dd</span></span> ee</div></div>))
    end
    # An opportunity belongs to what PRECEDES the box, not to the box: a space or a `<wbr>` from a wrapping run
    # opens the line before an atomic even inside a `nowrap` block, and a non-wrapping run's space closes it
    # even inside a wrapping one. One `barrier`, which every space overwrites — an atomic's and a `<wbr>`'s
    # included, and which a `<wbr>` then overwrites back. And a `pre` run's preserved spaces are CONTENT on
    # the line, never hanging off its end.
    it 'reads the opportunity before an atomic off what precedes it' do
      ib = 'display:inline-block;width:60px;height:9px'
      expect_parity(%(<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:normal">aaaa </span><span style="#{ib}"></span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="display:inline-block;width:20px;height:9px"></span> <span style="white-space:normal">bbbbbbbb</span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace;white-space:nowrap">aa<wbr> <span style="white-space:normal">bbbbbbbb</span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace;text-align:right;white-space:pre"><span style="display:inline-block;width:10px;height:9px"></span>a   <wbr><span style="white-space:normal">bbbbbbbbbb</span></div>))
      expect_parity(%(<div style="width:120px;font:16px monospace;text-align:right;white-space:nowrap"><span style="display:inline-block;width:10px;height:9px"></span>a<span style="white-space:pre-wrap">  </span><span style="white-space:pre"> </span><wbr><span style="white-space:normal">bbbbbbbbbbbb</span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre">aaaa </span><wbr><span style="#{ib}"></span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa <wbr><span style="#{ib}"></span></div>))
    end
    # A space that COLLAPSES AWAY against one already on the line decides nothing: it cannot take back the
    # opportunity the space before it gave. Source indentation between two inline elements is exactly this
    # shape, and a `nowrap` block's own newline between them was cancelling a wrapping inline's break.
    it 'lets a space that collapses away leave the opportunity alone' do
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:normal">aaaa </span><span style="white-space:nowrap"> </span><span style="white-space:normal">bbbbbbbb</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aa<em style="white-space:normal">xyz </em> <em style="white-space:normal">aaaaaaaa</em></div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre-line">aaaa </span><span style="white-space:nowrap"> </span><span style="white-space:normal">bbbbbbbb</span></div>')
    end
    # A run that does NOT soft-wrap is ONE unbreakable token: the line decides BEFORE it whether the whole of
    # it fits, never word by word (the oracle places `collapseRun(…)` less a trailing collapsible space in a
    # single `placeOnLine`). The unit is the run and never more — the oracle tokenises per text NODE, so a
    # `<b>` inside the span is a second run with a second decision — and under a preserving mode it is the
    # first newline-SEGMENT, since a newline after it breaks the line regardless. This is
    # `<p>… <span class="text-nowrap">…</span> …</p>`, the commonest mixed-mode markup there is.
    it 'fits a non-wrapping inline as one unbreakable token' do
      expect_parity('<div style="width:80px;font:16px monospace">aaa <span style="white-space:nowrap">bbb ccc</span> ddd</div>')
      expect_parity('<div style="width:80px;font:16px monospace">aaa <span style="white-space:pre">b  c</span> ddd</div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre-line">aaa <span style="white-space:nowrap">bbb ccc</span></div>')
      # …the unit stops at the run boundary: a `<b>` inside the span decides for itself
      expect_parity('<div style="width:80px;font:16px monospace">aaa <span style="white-space:nowrap">bbb <b>cccccc</b></span> ddd</div>')
      # …a preserved newline ends the unit, and the segment after it starts a line of its own
      expect_parity(%(<div style="width:80px;font:16px monospace">aaa <span style="white-space:pre">bbbbbb
cc</span> ddd</div>))
      # …a LEADING one is inside it, unless the line is EMPTY or already ends in a real hanging space (the
      # oracle's `collapseRun(…, lineX === lineLeft || lineEndsWithSpace)`) — and the oracle asks that BEFORE
      # it breaks, so a space it kept goes down with the unit on the fresh line. Each of these needs a
      # comparable box AFTER the span, or the 9.6px it is about moves nothing the harness looks at.
      expect_parity('<div style="width:80px;font:16px monospace">aa-<span style="white-space:nowrap"> bbbbb</span><span style="display:inline-block;width:10px;height:9px"></span></div>')
      expect_parity('<div style="width:80px;font:16px monospace">aa <span style="white-space:nowrap"> bbbbb</span><span style="display:inline-block;width:10px;height:9px"></span></div>')
      expect_parity('<div style="width:100px;font:16px monospace">x <span style="display:inline-block;width:20px;height:10px"></span><span style="white-space:nowrap"> aaa bbb</span> zz</div>')
      expect_parity('<div style="width:160px;font:16px monospace"><div style="float:left;width:90px;height:60px"></div><div><span style="white-space:nowrap"> aaa bbb</span></div></div>')
      # …and the token ends at the text NODE, which `appendText` must not merge away: two nodes either side of
      # a nested inline are two tokens with two decisions, and the same FONT on both is what hid it.
      expect_parity('<div style="width:80px;font:16px monospace">zz <span style="white-space:nowrap">pp <span style="white-space:nowrap">aa</span> qq</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace">zz <span style="white-space:pre">pp <span style="white-space:pre">aa</span> qq</span></div>')
      # …a body that is non-empty but zero-advance still asks the question
      expect_parity(%(<div style="width:80px;font:16px monospace">aaaaaaaaaa-<span style="white-space:nowrap">\u200B</span></div>))
      # …and a line too narrow for the whole unit DROPS below the float rather than overlapping it — after a
      # break the unit itself took, and for EVERY newline segment of a preserved run, not only the first
      expect_parity('<div style="overflow:hidden;width:150px;font:16px monospace"><div style="float:left;width:100px;height:40px"></div><div><span style="white-space:nowrap">aaa bbb</span></div></div>')
      expect_parity('<div style="width:120px;font:16px monospace"><div style="float:left;width:60px;height:60px"></div><div>xxxx <span style="white-space:nowrap">a bbbbbbbb</span></div></div>')
      expect_parity(%(<div style="width:100px;font:16px monospace"><div style="float:left;width:60px;height:60px"></div><div><span style="white-space:pre">a
bbbbbbbbbb</span></div></div>))
      # …and an ATOMIC asks the same question for its break AND its drop, which is one question in the oracle
      expect_parity('<div style="width:120px;font:16px monospace"><div style="float:left;width:60px;height:60px"></div><div style="white-space:nowrap"><span style="display:inline-block;width:80px;height:20px"></span></div></div>')
      # …and it does NOT drop where a non-wrapping run's space left a hard barrier — which it does even at a
      # LINE START, where the space itself collapses away and only the barrier survives.
      expect_parity('<div style="width:150px;font:16px monospace"><div style="float:right;width:130px;height:10px"></div><div style="width:40px;white-space:nowrap"> <span style="display:inline-block;width:70px;height:6px"></span></div></div>')
      expect_parity('<div style="width:150px;font:16px monospace"><div style="float:left;width:56px;height:10px"></div><div style="width:40px;white-space:nowrap"> <span style="display:inline-block;width:70px;height:6px"></span></div></div>')
      # …and a leading space the unit KEPT is placed on the line the unit landed on, so it cannot make that
      # line look occupied before the float drop has been asked
      expect_parity('<div style="width:150px;font:16px monospace"><div style="float:left;width:70px;height:30px"></div><div style="width:120px">q-<span style="white-space:nowrap"> eeeeedddd</span></div></div>')
      # …the INTRINSIC route too, where a non-wrapping run inside a WRAPPING box is newly reachable
      expect_parity('<div style="width:min-content;font:16px monospace">aaa <span style="white-space:nowrap">bbb ccc</span> ddd</div>')
      expect_parity('<div style="width:400px;display:flow-root"><div style="float:left;font:16px monospace">aaa <span style="white-space:nowrap">bbb ccc</span> ddd</div></div>')
      # …and a trailing collapsible space hangs OUTSIDE the unit, so it is no part of what has to fit
      expect_parity('<div style="width:80px;font:16px monospace">aa <span style="white-space:nowrap">bbbbb </span>cc</div>')
      # …and an ATOMIC inside such an inline is not part of the token: its own `white-space` forbids breaks
      # INSIDE it, never the opportunity before it, so the BLOCK decides whether the line may break there.
      expect_parity('<div style="width:60px;font:16px monospace;text-indent:9px">aaa<span style="white-space:nowrap"><span style="display:inline-block;width:30px;height:9px"></span>bb</span> ddd</div>')
      expect_parity('<div style="width:60px;font:16px monospace;text-indent:9px">aaa<span style="white-space:pre"><span style="display:inline-block;width:30px;height:9px"></span>bb</span> ddd eee fff</div>')
      # …while a line that cannot break anyway decides nothing, whatever the inline says
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:pre">b  c</span> ddd</div>')
      expect_parity('<div style="width:80px;font:16px monospace;white-space:pre">aaa <span style="white-space:nowrap">bbb ccc</span></div>')
    end
    # …and at a LINE START the barrier is ALL that survives. The space it came from collapsed away, so it
    # carries no width and no line-box metrics of its own: a whitespace-only run in a font taller than the
    # line's would otherwise grow a line box the oracle was never handed anything to grow. It survives only as
    # far as the next run, too — a WRAPPING one replaces it with the ordinary opportunity its own leading space
    # queues, which is what still lets the line drop past a float.
    it 'leaves a line-start barrier that carries nothing, and lets a wrapping run replace it' do
      expect_parity('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:nowrap;font-size:40px"> </span><span style="white-space:pre"> b</span></div>')
      expect_parity('<div style="width:80px;font:16px monospace"><span style="white-space:nowrap;font-size:40px"> </span><span style="white-space:pre"> b</span></div>')
      expect_parity('<div style="width:150px;font:16px monospace"><div style="float:left;width:56px;height:10px"></div><div style="width:40px;white-space:nowrap"> <span style="white-space:normal"> </span><span style="display:inline-block;width:70px;height:6px"></span></div></div>')
      expect_parity('<div style="width:150px;font:16px monospace"><div style="float:left;width:56px;height:10px"></div><div style="width:40px"><span style="white-space:nowrap"> </span><span style="white-space:normal"> </span><span style="display:inline-block;width:70px;height:6px"></span></div></div>')
    end
  end

  # A TAB is the one character whose advance is not a width: it is the gap from where the pen stands to the
  # next stop, stops sitting every `tab-size` from the BLOCK's content edge. So every one of these asks the
  # same rule a different way — what precedes the tab on the line, which element's `tab-size` is read, and
  # what the block's space advance is worth — and each was measured in Chrome (`--headless --dump-dom`)
  # before it was written down, because the two engines agreeing on a tab stop neither of them has is the
  # failure this cannot catch by itself.
  describe 'a preserved tab advances to the next stop' do
    # Two things every shape here does. It puts an inline-BLOCK where the tab lands, never a bare `<span>`:
    # an inline box with no edges emits no OPEN / CLOSE run and so has no native box at all, which means the
    # harness never compares where it sits (measured — with a bare span these examples pass with the
    # half-space rule deleted outright). And it gives that marker `id="m"`, so `expect_x` can assert the
    # CHROME number as well as the agreement: every stop rule here was read out of Chrome rather than out of
    # the oracle, and where a fix touched both engines parity cannot see it at all.
    it 'stops every tab-size from the block content edge, wherever the pen is' do
      # One 16px monospace space is 9.6, so the default 8 stops every 76.8 — and nine characters of text put
      # the pen past the first stop into the second.
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">aaaaaaaaa\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 153.609375)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 153.609375)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
    end
    # …and the stop is the TAB's own element's, resolved against the BLOCK's space: an inner `tab-size` wins
    # for the tabs inside it while the block still decides what one unit of it is worth — a 16px span's tab
    # in a 32px block stops every 8 x 19.2, and the block's letter-spacing is part of its space advance.
    it 'reads tab-size from the element the tab is in, counted in the block space' do
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:4">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 38.40625)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t<span style="tab-size:4">b\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 115.203125)
      # …and the same under `pre-wrap`, which is the mode that can MERGE two adjacent text nodes into one run
      # (a non-wrapping one never does). Two stops in one run would be one stop, so the stop pair is part of
      # what makes two runs the same — measured: without it in `nlSameFi` this shape mismatches.
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre-wrap">a\t<span style="tab-size:4">b\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 115.203125)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;letter-spacing:2px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 92.8125)
      expect_parity(%(<div style="width:400px;font:32px monospace;white-space:pre"><span style="font-size:16px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 153.609375)
    end
    # …and a `tab-size` that is neither a number nor a length is no `tab-size` at all: the property keeps its
    # initial 8, exactly as an undeclared one does. Read through `parseFloat` these were 2 (`2px 3px`), 4
    # (`4e`) and 0 (`auto`) — and a zero MEANS something now (the letter-spacing grid below), so an
    # unparseable value read as one is a wrong answer rather than a missing one.
    it 'keeps the initial 8 for a tab-size that does not parse' do
      # (`4.` and `20.px` among them: CSS tokenizes a trailing bare dot as a number plus a delim, so the
      # declaration is invalid — where `parseFloat` and a looser regex both read them as 4 and 20.)
      ['auto', 'normal', 'none', 'red', '2px 3px', '4e', '4.', '20.px', '4.e1'].each do |ts|
        expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:#{ts}">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
      end
      # …while the ones that DO parse keep their own answer, units and all
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:2em">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 32)
      # (a `px` length, whose stop width is the length itself — where a bare number would be 20 spaces)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:20px">aaa\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 40)
    end
    # …a LENGTH `tab-size` brings the half-space rule with it: a stop nearer than half the block's space is
    # skipped for the one after (Blink's `Font::TabWidth`).
    it 'skips a stop less than half a space away' do
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:20px">aa\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 40)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:20px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 20)
    end
    # …and a `tab-size` of 0 puts the stops a LETTER-SPACING apart instead of turning them off. With no
    # letter-spacing, a NEGATIVE one, or a `word-spacing` instead, there is no stop to reach and the tab
    # advances nothing — the marker sits at the pen. Both engines read this as a flat letter-spacing advance
    # until 2026-09-16; the numbers below are the measurements that say otherwise.
    it 'puts the stops a letter-spacing apart at tab-size 0' do
      {'0.5px' => 11, '1px' => 12, '2px' => 14, '3px' => 18, '6px' => 24, '10px' => 30}.each do |ls, x|
        expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;letter-spacing:#{ls}">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), x)
      end
      {'letter-spacing:0' => 9.609375, 'letter-spacing:-1px' => 8.609375, 'letter-spacing:-3px' => 6.609375, 'word-spacing:5px' => 9.609375}.each do |none, x|
        expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;#{none}">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), x)
      end
      # …and it is the BLOCK's letter-spacing, like every other half of a tab stop. One on the INLINE the tab
      # sits in buys it no stop (9.61, the pen unmoved), and one on the block gives it stops the inline cannot
      # cancel (30) — while the pen still carries whatever spacing the runs before it had (16.61 / 24).
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0">a<span style="letter-spacing:10px">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 9.609375)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;letter-spacing:10px">a<span style="letter-spacing:0">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 30)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0"><span style="letter-spacing:7px">a</span><span style="letter-spacing:10px">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 16.609375)
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;letter-spacing:4px"><span style="letter-spacing:7px">a</span><span style="letter-spacing:10px">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 24)
    end
    # …and a tabbed run that overflows only breaks where the line MAY break: the oracle re-measures such a run
    # from the next line's start, and used to move it there with no opportunity to move it at.
    # Parity, not a Chrome number, and deliberately: NATIVE never had this branch, so the two engines
    # disagreed until the guard landed — measured, removing it reds this example. The shapes as written ARE
    # Chrome's answer (it keeps the first on ONE line, div 80x22, the span at 38.41 overflowing), but a
    # comparable box cannot be added to read that off: an inline with no edges has no native box, and an
    # inline-BLOCK inside the span brings the recorded atomic-break divergence with it (Chrome keeps the
    # marker on line 1 at 86.42, both engines move it to line 2 — `outer_wraps_gates_on_the_block`), which
    # would make this example about that instead.
    it 'breaks a tabbed run before it only where an opportunity stands' do
      expect_parity(%(<div style="width:80px;font:16px monospace">xxxx<span style="white-space:pre">a\tb</span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace">xxxx <span style="white-space:pre">a\tb</span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace">xxxx<wbr><span style="white-space:pre">a\tb</span></div>))
      expect_parity(%(<div style="width:80px;font:16px monospace">xxxx<span style="display:inline-block;width:10px;height:9px"></span><span style="white-space:pre">a\tb</span></div>))
    end
    # …and where that opportunity is a SOFT HYPHEN the break draws the hyphen, which is the difference between
    # the oracle's `takeBreak` and a plain forced one: the hyphen is 9.6px of the first line, and a centred
    # line without it sits 4.8 off. Native declines a soft hyphen outright, so there is no parity to assert
    # here — the oracle is the only engine that answers and Chrome is the only check on it.
    it 'draws the hyphen when the opportunity it breaks at is a soft one' do
      # (`%()`, never `'…'`: a single-quoted `\t` is a backslash and a `t`, and the oracle's whole tab branch
      # is gated on the run HOLDING one — measured, the shape without a real tab is satisfied by the ordinary
      # break path and passes with this fix reverted.)
      [['<span id="m" style="display:inline-block;width:10px;height:9px"></span>xx&shy;', %(<span style="white-space:pre">aaa\tbbb</span>), 30.59375],
       ['<span id="m" style="display:inline-block;width:10px;height:9px"></span>xx&shy;xx&shy;', %(<span style="white-space:pre">aaa\tbbb</span>), 20.984375],
       ['<span id="m" style="display:inline-block;width:10px;height:9px"></span>xx&shy;', %(<span style="padding-left:4px;white-space:pre">aaa\tbbb</span>), 30.59375]].each do |lead, tail, x|
        head = %(<div style="width:100px;font:16px monospace;text-align:center">)
        expect_declined_x(%(#{head}#{lead}#{tail}</div>), x, %(#{head}#{lead.gsub('&shy;', ' ')}#{tail}</div>))
      end
    end
    # …and the pen a tab measures from is the BLOCK's content edge, which is what makes an INTRINSIC width
    # (Chrome: max-content 96.015625 for `a\tbb`, min-content 19.203125) and a line inside a float band come
    # out right — the band and the indent move the PEN, the stops stay where the block put them.
    it 'measures from the content edge through an intrinsic width, an indent and a float band' do
      expect_parity(%(<div style="width:max-content;font:16px monospace;white-space:pre">a\tbb</div>))
      expect_parity(%(<div style="width:min-content;font:16px monospace;white-space:pre-wrap">aa\tbb cc</div>))
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre;text-indent:20px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
      expect_parity(%(<div style="width:400px;font:16px monospace"><div style="float:left;width:50px;height:40px"></div><div style="white-space:pre">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div></div>), 76.8125)
      # …and the band moving AFTER the run was measured is the same question asked late: `retakeBand` drops an
      # empty line below a float, and a tabbed run measured at the old band came out 90 where Chrome says
      # 86.42 (stops from the content edge, reached from the line's own start).
      expect_parity(%(<div style="width:200px;font:16px monospace"><div style="float:left;width:150px;height:30px"></div><div><span style="white-space:pre">a\tb</span><span id="m" style="display:inline-block;width:10px;height:9px"></span></div></div>), 86.421875)
    end
    # …and it is a placement like any other: it carries the line box it lands on, ends the preserved hang
    # before it, and a `pre-wrap` line may wrap after it.
    it 'places like a preserved space on the line it lands on' do
      expect_parity(%(<div style="width:120px;font:16px monospace;white-space:pre-wrap">aa\tbbbb cccc dddd</div>))
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t<span style="display:inline-block;width:10px;height:40px"></span></div>))
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre-wrap">aa \t<span style="display:inline-block;width:10px;height:9px"></span></div>))
      expect_parity(%(<div style="width:400px;font:16px monospace;white-space:pre">a\tb\ncc\t<span style="display:inline-block;width:10px;height:9px"></span></div>))
    end
  end

end

RSpec.describe 'native text valign decline', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font:16px monospace">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  def expect_bail(body)
    session = simulated_session(page(body)); session.visit '/'
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => false)
  end

  it('declines vertical-align:middle on an inline element') { expect_bail('<div style="width:300px">text <span style="vertical-align:middle">m</span> here</div>') }
  it('declines vertical-align:text-top on an inline element') { expect_bail('<div style="width:300px">text <span style="vertical-align:text-top">t</span> here</div>') }

  # The classes native answers `\p{L}` / `\p{N}` / `\p{M}` from come from regex-syntax — the same regex the
  # ORACLE writes, parsed rather than reimplemented (`unicode.rs`). But regex-syntax bakes in a UCD snapshot of
  # its own and the engine has another, on separate release trains (Ruby's and Rust std's are two more: rustc
  # 1.98 calls 4662 code points letters that this V8 does not, and answering from IT moved boxes). So ask the
  # engine for the whole class and compare every range: an upgrade of either side reds this instead of drifting
  # silently. One crossing of the code space costs ~0.02s — and sampling the boundaries was actively wrong
  # here, because probes taken from the table under test vanish with the range they came from (the old check
  # missed a DELETED range 60% of the time: `\p{L}` could lose `A-Z` and stay green).
  describe 'the Unicode classes the oracle asks a regex for' do
    UnicodeClasses::CLASSES.each do |klass|
      it "answers \\p{#{klass}} the way the oracle's own engine does" do
        require 'capybara/simulated/v8_runtime'   # …which is what defines the module below (v8-only, as is this)
        engine, name = with_simulated_session(page('<div>x</div>')) {|s|
          s.visit '/'
          [UnicodeClasses.ranges_of(s, klass), s.driver.js_engine]
        }
        native = Capybara::Simulated::Native.unicode_class_ranges(klass)
        # RSpec elides a 677-element array identically on both sides, so the difference has to be spelled out:
        # the FIRST position they disagree at (which a set difference would hide for a duplicate or a
        # reordering), and then which side is carrying ranges the other has not — because that decides the
        # remedy, and it is not otherwise guessable.
        expect(native).to eq(engine), lambda {
          at = native.each_index.find {|i| native[i] != engine[i] } || [native.size, engine.size].min
          hex = ->(rs) { rs.map {|lo, hi| lo == hi ? format('U+%04X', lo) : format('U+%04X-%04X', lo, hi) }.join(' ') }
          <<~MSG
            \\p{#{klass}} differs between regex-syntax and the #{name} engine the oracle asks
            (#{native.size} ranges vs #{engine.size}), first at index #{at}:
              regex-syntax: #{hex.call(native[at, 3].to_a)}
              #{name}:#{' ' * [13 - name.length, 1].max}#{hex.call(engine[at, 3].to_a)}
              only regex-syntax has: #{hex.call((native - engine).first(5))}
              only #{name} has: #{hex.call((engine - native).first(5))}
            If the ENGINE carries the extra ranges it moved to a newer Unicode first, and there is no local
            fix: native lays those code points out differently from the oracle until regex-syntax ships a
            matching snapshot. If REGEX-SYNTAX carries them, a `cargo update` moved it — revert Cargo.lock.
          MSG
        }
      end
    end
  end
end
