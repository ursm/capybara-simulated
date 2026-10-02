# frozen_string_literal: true
# Native layout L2 (inline/text): a text-containing block's lines — greedy line breaking over the advances
# measured in-process via fontations, in every `white-space` mode — held to each shape's golden, and to
# Chrome's figures where a shape states them.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/layout_golden'
# …and the enumerator the Unicode drift check asks the engine with.
require_relative 'support/unicode_classes'

RSpec.describe 'native layout L2 text-block' do
  # The charset is declared because the CJK shapes below are UTF-8 in this file's own source: served without
  # it they would decode as windows-1252 and the specs would be testing mojibake rather than Japanese.
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
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

  # Where the marker `#m` sits, which is how a shape says what it is about. A golden holds a shape to the
  # answer it was recorded with, right or wrong, so a rule read out of Chrome has to have the Chrome NUMBER
  # asserted too, which is what the `chrome_x` argument of `expect_layout` below is for.
  def marker_x(session)
    session.evaluate_script("document.querySelector('#m').getBoundingClientRect().x")
  end

  # …and WHICH LINE it landed on, for a rule about a forced break: `x` says nothing there, since a break
  # moves the marker down rather than across.
  def marker_y(session)
    session.evaluate_script("document.querySelector('#m').getBoundingClientRect().y")
  end

  # Within 0.05px throughout: the layout measures from the font file's own advances, so it lands a hair off
  # Chrome's rounding — 9.6 against 9.609375 per monospace character.
  def expect_near(got, chrome, body, axis)
    expect(got).to be_within(0.05).of(chrome), "#{body}: #m at #{axis} #{got}, Chrome #{chrome}"
  end

  # …and its sibling for a figure the layout gives where Chrome gives another. `chrome_x` stays what
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
    expect(got).not_to(
      be_within(0.05).of(chrome),
      "#{body}: #m at #{axis} #{got} now AGREES with Chrome — a fix, not a regression: assert it as `chrome_#{axis}`"
    )
    expect(got).to(
      be_within(0.05).of(shared),
      "#{body}: #m at #{axis} #{got}; the layout gives #{shared}, Chrome #{chrome}"
    )
  end

  # `chrome_x` stays POSITIONAL because most call sites in this file spell it that way and it reads well at
  # each of them (`expect_layout(body, 6, chrome_y: 0)`); the pairs below are keyword because each only ever
  # appears together.
  def expect_layout(
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

    # Chrome FIRST: the day a shared figure moves onto Chrome's, the failure has to say that, not that the
    # golden moved.
    unless [chrome_x, chrome_y, shared_x, shared_y].all?(&:nil?)
      with_page(body) do |session|
        expect_near(marker_x(session), chrome_x, body, 'x') unless chrome_x.nil?
        expect_near(marker_y(session), chrome_y, body, 'y') unless chrome_y.nil?
        expect_shared(marker_x(session), shared_x, shared_x_chrome, body, 'x') unless shared_x.nil?
        expect_shared(marker_y(session), shared_y, shared_y_chrome, body, 'y') unless shared_y.nil?
      end
    end
    expect_layout_golden(body)
  end

  # `vertical-align` on an INLINE BOX places the text it owns against the PARENT's font (`middle`: half an
  # x-height above the baseline; `text-top` / `text-bottom`: the parent's ascent / descent), and the walk
  # (`inline_ascent`) hands the line layout that as the shift the box's own baseline moves by. It declined as
  # `inline-box-relative-valign` until 2026-09-24 (the whole
  # `vahang` sweep, 480). Chrome's figures, where they agree.
  {
    'middle, a small box in a big parent'           => ['<div style="font:30px monospace;width:300px">a<span id="m" style="vertical-align:middle;font-size:10px">x</span>c</div>', 16.953125],
    'middle, its own line-height'                   => ['<div style="font:16px/40px monospace;width:300px">a<span id="m" style="vertical-align:middle;font-size:10px;line-height:12px">x</span>c</div>', 14.71875],
    'text-top'                                      => ['<div style="font:30px monospace;width:300px">a<span id="m" style="vertical-align:text-top;font-size:10px">x</span>c</div>', 0],
    'text-bottom'                                   => ['<div style="font:30px monospace;width:300px">a<span id="m" style="vertical-align:text-bottom;font-size:10px">x</span>c</div>', 27],
    '-webkit-baseline-middle'                       => ['<div style="font:30px monospace;width:300px">a<span id="m" style="vertical-align:-webkit-baseline-middle;font-size:10px">x</span>c</div>', 25],
    'a box of a bigger font, which grows the line'  => ['<div style="font:16px monospace;width:300px">a<span id="m" style="vertical-align:middle;font-size:30px">x</span>c</div>', 0]
  }.each do |name, (body, chrome_y)|
    it "aligns an inline box's own text by vertical-align: #{name}" do
      expect_layout(body, chrome_y: chrome_y)
    end
  end
  # …and text whose STYLE comes from a box-less `display: contents` element inside the aligned box rides the BOX's
  # baseline, as the box's own text does: Chrome moves it with the box, 15. Both JS engines measured it
  # from that element's own baseline instead — one height whatever its font, 1.712 — until 2026-09-30.
  it "aligns a display:contents element's text inside an aligned inline box on the box's baseline" do
    body = '<div style="width:300px;font:16px monospace">a<span id="m" style="vertical-align:middle"><em style="display:contents;font-size:30px">x</em></span>c</div>'
    expect_layout(body, chrome_y: 15)
  end
  # SHARED, all three from one rule — only the text a box OWNS moves, and only by a font figure:
  # `top` / `bottom` leave the text on the baseline where Chrome puts it at the line's top / bottom; text in an
  # inline NESTED inside an aligned box stays where it was (`inline_parent_shift` hands down a SHIFT only), where
  # Chrome moves it with its box; and a box with a line-height of its own lands a pixel off.
  {
    'top'                                  => ['<div style="font:16px/40px monospace;width:300px">a<span id="m" style="vertical-align:top;font-size:10px;line-height:12px">x</span>c</div>', 15, -1],
    'bottom'                               => ['<div style="font:16px/40px monospace;width:300px">a<span id="m" style="vertical-align:bottom;font-size:10px;line-height:12px">x</span>c</div>', 15, 27],
    'a nested inline'                      => ['<div style="font:16px monospace;width:300px">a<span style="vertical-align:middle;font-size:30px">x<b id="m" style="font-size:10px">b</b></span>c</div>', 13.788, 21],
    'text-top with its own line-height'    => ['<div style="font:16px/40px monospace;width:300px">a<span id="m" style="vertical-align:text-top;font-size:10px;line-height:12px">x</span>c</div>', 9, 8]
  }.each do |name, (body, shared, chrome)|
    it "aligns an inline box's own text by vertical-align: #{name} (shared)" do
      expect_layout(body, shared_y: shared, shared_y_chrome: chrome)
    end
  end

  # `break-spaces` lays a LINE out exactly as `pre-wrap` does — the line layout asks whether the mode preserves
  # and whether it wraps, and both answer the same for the two — and parts from it only in the INTRINSIC measure, where
  # every preserved space is content that never hangs and carries a break after it. So the LINE layout reads it
  # as `pre-wrap`, and `text_intrinsic`'s mode table measures it by its own rule (since 2026-09-23; the measure
  # was refused before, the disagreement fenced off where it lives rather than a whole mode refused for it).
  # It was refused outright before 2026-09-22, and not by name: `WS_MODE` simply had no entry, so the walk
  # declined without naming itself and the shape landed in `unsupported subtree` — 1,230 of the 1,782 that
  # reason covered, found only by censusing which of the walk's 155 refusal sites had fired.
  # KNOWN DIVERGENCE: `break-spaces` also breaks AFTER EVERY SPACE and lets none of them hang, so Chrome 153
  # carries two of them onto the second line and puts the marker at 57.609375 where native puts it at 38.4 — the
  # answer `pre-wrap` gives. That is what "lays a line out as pre-wrap" costs; the arm asserts native's answer and
  # names Chrome's beside it.
  it 'lays a break-spaces line out as pre-wrap, which is all native distinguishes' do
    bs = '<div style="width:80px;font:16px monospace;white-space:break-spaces">aaaa      bbbb' \
         '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>'
    # …through `shared_x`, not `chrome_x`: 38.4 is what native says and Chrome 153 says 57.609375.
    expect_layout(bs, shared_x: 38.4, shared_x_chrome: 57.609375, chrome_y: 35)
    # …and it really is `pre-wrap`'s answer and not a coincidence: the same shape in `pre-wrap` is the same x,
    # and THERE it is Chrome's own, so it goes through `chrome_x`.
    expect_layout(bs.sub('break-spaces', 'pre-wrap'), 38.40625, chrome_y: 35)
  end

  # …and THAT arm pins nothing about native, which is worth stating because it took an A/B to find out. The
  # only native code this increment changes is `line_layout`'s mode table gaining 5 as a PRESERVING mode, and
  # the shape above cannot see it: at 80px the collapsed reading (`aaaa bbbb`, 86.4) overflows and wraps at
  # its one space, so preserve and collapse put the marker on the same line at the same x. Dropping 5 from the
  # table left all 136 examples in this file green — a fourth vacuous guard, caught before it shipped.
  # This is the shape that sees it. At 120px the preserved reading (14 chars, 134.4) does not fit and the
  # collapsed one (9 chars, 86.4) does, so the BLOCK is two lines or one — and the block's height moves every
  # box after it and every box around it. With 5 dropped from the table the page was 26 tall against 48:
  # five boxes off, `<html>` included.
  # Chrome AGREES here (the marker's y is 44 in both), so this one is a plain `chrome_y` — the divergence
  # the arm above records needs the spaces to fall at a wrap, and here they do not.
  it 'preserves a break-spaces run, which decides the line COUNT and so the block height' do
    bs = '<div style="width:120px;font:16px monospace;white-space:break-spaces">aaaa      bbbb</div>' \
         '<div id="m" style="height:4px"></div>'
    expect_layout(bs, 0, chrome_y: 44)
    # …and the collapsing control, so the example cannot pass by 120px being wide enough for either reading:
    # the same text under `normal` IS one line, and the marker sits at 22.
    expect_layout(bs.sub('break-spaces', 'normal'), 0, chrome_y: 22)
  end
  # …and the INTRINSIC half is the one with a rule of its own: the min-content of `aa   bb` is the width of
  # `aa ` where a `pre-wrap` measure gives `aa` — 28.8 against 19.2 — and native carries that rule since
  # 2026-09-23: every preserved space is CONTENT that joins the word, never
  # hangs, and takes its break opportunity AFTER it, where a `pre-wrap` space opens one BEFORE and hangs off
  # the end. So the min-content of `aa   bb` is `aa ` wide and a `pre-wrap` one is `aa`.
  # Measured the hard way: aliasing the mode to `pre-wrap` outright passes the whole 8,640-case `wsonly` sweep
  # with no mismatch, because not one of its shapes asks for a min-content. These arms are that missing shape.
  # …asked at FOUR gates, because the mode is inherited but it can also be declared on a `<span>`, on one
  # inside that, or on a box-less `display: contents` element, and the block gate sees none of those. All four
  # are measured by the one rule in `text_intrinsic`'s `modes` table.
  # Chrome's figures throughout, and BOTH are asserted: the box is 28.8125 wide against `pre-wrap`'s
  # 19.203125, and the marker after `bb` sits at 19.203125 where `pre-wrap` puts it at 0 — because the extra
  # space `break-spaces` keeps on the first line is the whole difference, and it shows in both.
  # (Its `y` is NOT asserted: Chrome puts the marker on a third line at 57 and native puts it on a second
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
        expect_layout(body, chrome_mx)
        with_page(body) do |session|
          w = session.evaluate_script("document.querySelector('div').getBoundingClientRect().width")
          expect_near(w, chrome_w, body, 'width')
        end
      end
    end
  end

  # …and the SPACING column, which is the one this example did not have when the measure shipped. A preserved
  # space is a SPACED advance like every other piece on the line. Measured with UNSPACED advances — a pen
  # carrying `letter-spacing` / `word-spacing` only so a TAB picks the right stop — it came out 3px per space
  # short of Chrome. Chrome's figures, measured 2026-09-23:
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
      expect_layout(body)
      with_page(body) do |session|
        expect_near(session.evaluate_script("document.querySelector('div').getBoundingClientRect().width"), chrome_w, body, 'width')
      end
    end
    tab = %(<div style="width:max-content;font:16px monospace;white-space:break-spaces;letter-spacing:3px;tab-size:20px">a &#9;b</div>)
    expect_layout(tab)
    with_page(tab) do |session|
      expect_near(session.evaluate_script("document.querySelector('div').getBoundingClientRect().width"), 52.609375, tab, 'width')
    end
  end

  # `pre-line` COLLAPSES SPACES and KEEPS NEWLINES — two independent axes — and the node-level gate that
  # decides whether a whitespace-only text node reaches the breaker at all asked only whether the mode
  # PRESERVES, which `pre-line` does not. So a node holding nothing but a newline took the collapsing arm,
  # where it is at most the one inline-block gap, and its forced break went missing: the box after it stayed
  # on the first line where Chrome puts it on the second.
  #
  # BOTH arms, or the fix reads as "route every whitespace-only node through the breaker". The second arm is
  # asked through MARGIN COLLAPSING, because that is one of the four places the question is put (does this
  # block separate the margins around it) and it makes the difference page-visible rather than a walk-internal
  # reason string:
  # a block whose only content is a space is an empty one the margins around it collapse through, and one
  # holding a newline has a line box that stops them. 42px apart, and both figures are Chrome's.
  it 'breaks at a newline that is the whole of a pre-line text node, and not at spaces that are' do
    marker = '<b id="m" style="display:inline-block;width:4px;height:4px"></b>'
    line   = 'width:400px;font:16px monospace;white-space:pre-line'
    expect_layout(%(<div style="#{line}"><span>\n</span>#{marker}</div>), chrome_y: 35)

    collapse = lambda {|ws|
      %(<div style="width:400px;font:16px monospace"><p style="margin:20px 0">a</p>) +
        %(<div style="white-space:pre-line"><span>#{ws}</span></div>) +
        %(<p id="m" style="margin:30px 0">b</p></div>)
    }
    expect_layout(collapse.(' '), chrome_y: 72)
    expect_layout(collapse.("\n"), chrome_y: 114)
  end

  # …and the shape this is really about, which nothing in the repo had: PRETTY-PRINTED markup. A source
  # newline between two block children of a `pre-line` block is a whitespace-only text node, so it makes a
  # line of its own — three of them here, and the block is 110 tall where the layout used to say 44, which
  # only a Chrome figure could catch.
  # It cost a decline until 2026-09-24 (`white-space-only-block`); those whitespace lines are a mixed block's
  # anonymous groups now, which native lays out as it does any other.
  it 'gives a pre-line block a line per source newline between its block children' do
    pretty = %(<div style="width:400px;font:16px monospace;white-space:pre-line">\n) +
             %(  <div>a</div>\n  <div id="m">b</div>\n</div>)
    expect_layout(pretty, chrome_y: 66)
  end

  # …and `break-spaces`, whose whitespace-only block used to be an EMPTY one to native: its preserved white
  # space is content, so the block is a text block of that one line (22 tall, as in Chrome) since 2026-09-24.
  # A plain list, not `%W[…]`: that splits on whitespace, so `%W[\n  ]` is the ONE-element array `["\n"]` and
  # the space case — half of what this example is about, and as wrong as the newline was — was silently
  # never run.
  ["\n", ' '].each do |ws|
    it "lays out a break-spaces block whose only content is #{ws.inspect}" do
      body = %(<div id="w" style="width:400px;font:16px monospace;white-space:break-spaces">#{ws}</div>)
      expect_layout(body)
      with_page(body) do |session|
        expect(session.evaluate_script("document.getElementById('w').getBoundingClientRect().height")).to eq(22)
      end
    end
  end

  # …and the edges of the inline the break happens INSIDE go onto the line it ends, not onto the next one.
  # A marker waiting on an opening edge (an out-of-flow child records where the flow had reached, and an
  # unplaced edge means the flow has not said yet) settles when that edge lands, so an edge that landed a
  # line late took the marker with it — 22px down, on a line it was written above. The flush is unconditional,
  # a whitespace-only run's break included, and this is the shape that says so.
  it 'flushes an inline opening edge onto the line a pre-line newline ends' do
    # Concatenated, never a heredoc: under `pre-line` a heredoc's own newlines are forced breaks, so the
    # shape would quietly become a different one — and might still pass.
    body = %(<div style="position:relative;width:400px;font:16px monospace;white-space:pre-line">) +
           %(<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>\n) +
           %(<span>y</span></span> tail</div>)
    expect_layout(body, 6, chrome_y: 0)
  end

  # AN INLINE BOX THAT NOTHING LANDED INSIDE still shows its edges, where it opened: Chrome gives a lone
  # padded empty `<span>` a 10x27 box on its line. Two boxes read it — the one AFTER the empty inline, and an
  # out-of-flow child of it, which records where the flow had reached and so waits for that edge to land.
  #
  # The walk once refused the whole family (`edged-inline-without-content`) for a DIFFERENT divergence, and
  # that one is real and still here — an empty inline's own font box does not grow the line
  # (`a<span style="padding-left:6px;font-size:40px"></span>` puts the next box at y 13 where Chrome says 39).
  # The refusal was never a guard for it: the same error shows with NO edge at all
  # (`a<span style="font-size:40px"></span>`, never declined). It is a shared divergence, recorded, not fixed.
  # Opening the family does make more SHARED divergences reachable, all of them pre-existing and none of them
  # about an empty inline: the largest is rtl, where a padded inline puts the next box at 396 here
  # and at 390 (or 380.39 after text) in Chrome — with or without content in it, so it is the rtl line-order
  # family and not this one. Recorded in `rtl_line_items_laid_out_ltr`, not fixed here.
  # The refusal is gone, so the `edged` sweep went from 1,200 declines to none.
  #
  # Every figure is Chrome's, and native agrees with it: an opening edge is an opening edge whether it is
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
      expect_layout(%(<div style="width:400px;font:16px monospace">#{inner}) +
                    %(<b#{marker} style="display:inline-block;width:4px;height:4px"></b></div>), chrome_x)
    end
  end

  # …and a pair of edges that CANCELS, which is the only shape that tells the two flushes apart: a placement
  # asks the SUM of the pending edges and places nothing when they come to zero (`flush_open_edges!`), a box's
  # CLOSE places every pending one outright (`flush_each_open_edge!`). Folded into one macro under the sum
  # guard, a cancelling pair stayed pending and the OUTER close flushed an unbalanced sum — the next box
  # landed at -6 or +6 where Chrome says 0. No sweep could see it: `edged.txt` has
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
      expect_layout(%(<div style="width:400px;font:16px monospace">#{inner}) +
                    %(<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>), chrome_x)
    end
  end

  # …and the same pair around a FORCED BREAK, which is the other direct flush: a preserved newline places
  # every pending edge outright, so both go down on the line the break ends and the close finds nothing
  # pending. Behind the sum guard neither went down there, and both did at the close — one line too many.
  it 'places both edges of a cancelling pair at a preserved newline' do
    expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">) +
                  %(<span style="margin-left:-6px"><span style="padding-left:6px">\n</span></span></div>) +
                  %(<b id="m" style="display:inline-block;width:4px;height:4px"></b>), chrome_y: 32)
  end

  # A NON-WRAPPING block container is one unbreakable token whatever it holds — its measure ends with `min = max`
  # for a `nowrap` / `pre` box — so a `nowrap` block holding text and a block child is MEASURED, where the walk
  # once declined every shrink-to-fit asker around it (216 `wsonly`
  # shapes, and the specs' stand-in unmeasurable shape until then). These two guard that lift: the text here is an anonymous
  # group that pins ITSELF, so the container's own pin changes nothing (the shapes it does change follow).
  {
    'at its max-content'  => ['', 48.015625, 13],
    'squeezed to its min' => [';width:10px', 0, 40]
  }.each do |name, (outer, chrome_x, chrome_y)|
    it "measures a non-wrapping block holding a block child: #{name}" do
      expect_layout(
        %(<div style="font:16px monospace#{outer}"><div style="float:left;white-space:nowrap">aa bb<div style="width:5px;height:5px"></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        chrome_x,
        chrome_y: chrome_y
      )
    end
  end
  # …and its FLOATS pinned with it, which Chrome does not do: `white-space` is about inline content, and two floats
  # in a `nowrap` float still stack in a 10px block (Chrome 40 wide; native 70). Shared, recorded.
  it 'pins a non-wrapping block\'s floats to one line (shared)' do
    expect_layout(
      '<div style="font:16px monospace;width:10px"><div style="float:left;white-space:nowrap"><div style="float:left;width:30px;height:5px"></div>' \
      '<div style="float:left;width:40px;height:5px"></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        18,
      shared_y_chrome: 23
    )
  end
  # …and where the container's pin DOES change something, the layout's rule is not Chrome's, which pins only
  # inline content: a child that declares a wrapping mode of its own keeps its min-content there (the block
  # 57.6 wide, the marker below its three lines; native one 259.2-wide line), and an EMPTY inline beside
  # floats — the empty-content record, which carried no mode at all until the review of 2b98ec5b (40 then,
  # 70 now) — pins them too. Shared, recorded.
  it 'pins a non-wrapping container over a child with its own wrapping mode (shared)' do
    expect_layout(
      '<div style="font:16px monospace"><div style="width:min-content"><div style="white-space:nowrap">' \
      '<p style="margin:0;white-space:normal">a normal child under nowrap</p></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        35,
      shared_y_chrome: 123
    )
  end
  it 'pins a non-wrapping block of an empty inline and floats (shared)' do
    expect_layout(
      '<div style="font:16px monospace"><div style="width:min-content"><div style="white-space:nowrap"><span></span>' \
      '<div style="float:left;width:30px;height:5px"></div><div style="float:left;width:40px;height:5px"></div></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      shared_x:        70,
      shared_x_chrome: 40
    )
  end
  # An empty inline box TAKES a first-line indent in Chrome (77 at max-content beside two floats), and native's
  # record of such a block used to have nothing to take it with (70), so the measure refused it and a box around
  # it declined. The box is a zero OPEN / CLOSE pair in the run stream now and the block a TEXT block (an inline
  # box occupies a line), so native measures it: a float around it is 77 wide, the marker beside it
  # (Chrome 77). The same holds for a `<wbr>`, which takes the indent and is no content to the walk, and an
  # out-of-flow child inside the inline, which the walk makes a marker (the review of 5a1ab0e1: both measured 70
  # behind a gate that counted them as content). Under `max-content` the floats reach the marker's line instead.
  it 'measures an indented block of an empty inline and floats' do
    floats = '<span></span><div style="float:left;width:30px;height:5px"></div><div style="float:left;width:40px;height:5px"></div>'
    expect_layout(
      %(<div style="font:16px monospace"><div style="width:max-content"><div style="text-indent:7px">#{floats}</div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
      70,
      chrome_y: 13
    )
  end
  {
    'an empty inline'                    => '<span></span>',
    'a <wbr>'                            => '<span></span><wbr>',
    'an out-of-flow child in the inline' => '<span><b style="position:absolute">z</b></span>',
    'an inline around a float'           => '<span><div style="float:left;width:1px;height:5px"></div></span>'
  }.each do |name, head|
    it "measures an indented block of #{name} and floats at the pinned width" do
      floats = '<div style="float:left;width:30px;height:5px"></div><div style="float:left;width:40px;height:5px"></div>'
      expect_layout(
        %(<div style="font:16px monospace"><div style="float:left"><div style="text-indent:7px">#{head}#{floats}</div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        name == 'an inline around a float' ? 78 : 77,
        chrome_y: 13
      )
    end
  end
  # …and past a BLOCK child the indent re-arms as a non-first line's, so under `hanging` an empty inline after
  # one takes it (Chrome: 7 wide) — an anonymous GROUP of nothing but that box is kept as a text
  # block for it, where it used to collapse and leave native 5. It lays no line out, so its margins adjoin and a
  # block child's margin still collapses through it (anon[26], which no group needed while every kept one had a line).
  it 'measures a hanging-indented block of a block child and an empty inline' do
    expect_layout(
      %(<div style="font:16px monospace"><div style="float:left"><div style="text-indent:7px hanging"><div style="width:5px;height:5px"></div><span></span></div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
      7,
      chrome_y: 13
    )
  end
  # …and the box is asked per GROUP, not per block: in a mixed block each run of inline content between block
  # children is a record of its own, so text in another group gives an empty-inline group nothing (Chrome 50;
  # native 9.6 while the group collapsed — the review of d1cf5fd0 found 567 such shapes).
  it 'measures a mixed block whose empty-inline group takes the indent, text elsewhere' do
    expect_layout(
      %(<div style="font:16px monospace"><div style="float:left"><div style="text-indent:50px"><span></span><div style="width:5px;height:5px"></div>a</div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
      50,
      chrome_y: 13
    )
  end
  # …and an inline box that HOLDS content takes it where it OPENS too, which is not where its content is when a
  # forced break comes first: a `pre-line` newline opening the box ends the indented line, and the measure has
  # taken the indent already (50 under 50px, as in Chrome). Native met no box there — an edgeless inline
  # emitted no run — and said 19.2, the width of `aa`; every inline box is an OPEN / CLOSE pair now.
  {
    '<span>&#10;aa</span> under pre-line'                   => ['<div style="float:left;white-space:pre-line;text-indent:50px"><span>&#10;aa</span></div>', 50],
    'a float, then a pre-line newline, in an inline' => ['<div style="float:left;text-indent:30px"><span><i style="float:left;width:5px;height:5px"></i><span style="white-space:pre-line">&#10;aa</span></span></div>', 35]
  }.each do |name, (block, chrome_x)|
    it "takes the indent at an inline box's open before a forced break: #{name}" do
      expect_layout(%(<div style="font:16px monospace">#{block}<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>), chrome_x)
    end
  end
  # A kept group of an EMPTY inline holding only white space is zero-height and lets a margin through, as the group
  # that collapsed did: the child's 50px top margin still collapses with the 20px paragraph margin above it
  # (Chrome: the block at 92, 50 below the paragraph's 42).
  it 'collapses a margin through a kept empty-inline group' do
    expect_layout(
      '<div style="width:200px;font:16px monospace"><p style="margin:20px 0">a</p><div><span> </span><div id="m" style="margin-top:50px;width:5px;height:5px"></div></div><p style="margin:30px 0">b</p></div>',
      chrome_y: 92
    )
  end
  # SHARED: a `<wbr>` beside a float makes a LINE in Chrome (22 tall, so the marker after the block sits on the
  # line below it, y 35), and a line of nothing here (13).
  it 'makes no line of a <wbr> beside a float (shared)' do
    expect_layout(
      '<div style="font:16px monospace;width:max-content"><div style="text-indent:7px"><wbr><div style="float:left;width:30px;height:5px"></div></div>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      shared_y:        13,
      shared_y_chrome: 35
    )
  end
  # A collapsible space at a LINE START is deleted, and no break opportunity with it (CSS Text 3 §4.1.2): the
  # layout made one there, "harmless while the word is empty" — which an inline box's edges, or the indent an
  # empty one took, make false. So the min-content cut them off the word after (19.2 for a padded empty inline).
  # Chrome keeps them together: 39.61 and 24.20, and so does native now.
  {
    'the indent an empty inline takes' => ['<td style="padding:0;text-indent:30px"><span></span> a</td>', 39.609375],
    'an empty inline\'s opening edge'  => ['<td style="padding:0"><span style="padding-left:5px"></span> aa</td>', 24.203125]
  }.each do |name, (cell, chrome_x)|
    it "keeps #{name} on the word after a line-start space" do
      expect_layout(
        %(<table style="font:16px monospace;width:10px;border-spacing:0"><tr>#{cell}<td id="m" style="padding:0">t</td></tr></table>),
        chrome_x,
        chrome_y: 0
      )
    end
  end
  # A MIXED block's anonymous group past a block child starts on a line that is not the block's first, so it takes
  # no first-line indent — in the layout (its record's `spent` bit) and now in the MEASURE, which ignored the bit
  # and indented the group anyway (59 where Chrome says 48). That was the whole of what the walk's
  # `measured-subtree-under-text-indent` refusal was guarding in its 1,458 declines; it is gone.
  it 'measures a mixed block\'s group past a block child without the first-line indent' do
    expect_layout(
      '<div style="font:16px monospace"><div style="float:left;text-indent:11px"><div style="height:6px">B</div>aa bb<div style="height:6px">C</div></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      48.015625,
      chrome_y: 13
    )
  end
  # …and a LONE `<wbr>` opens a line box in Chrome (the block 22 tall around its two floats) and not here
  # (5): shared, recorded.
  it 'opens no line for a lone <wbr> (shared)' do
    expect_layout(
      '<div style="font:16px monospace"><div style="text-indent:7px"><wbr><div style="float:left;width:30px;height:5px"></div>' \
      '<div style="float:left;width:40px;height:5px"></div></div><div style="clear:both"><b id="m" style="display:inline-block;width:4px;height:4px"></b></div></div>',
      0,
      shared_y:        18,
      shared_y_chrome: 35
    )
  end
  # …and a PRESERVED one — a CR or an FF under `pre` / `pre-wrap` / `break-spaces` — is text that is not there: zero
  # wide, no break opportunity, no justification gap, and a node of nothing else no content (Chrome). The walk declined
  # both until 2026-09-25. Chrome's marker positions:
  # `aa&#13;bb` one unbroken 38.4 line at min-content (so is `aa&#12;bb`), a box flush after a lone CR, an FF-only
  # `pre` block 0 tall.
  it 'lays out a preserved CR / FF as nothing' do
    expect_layout('<div style="font:16px monospace;width:10px"><div style="float:left;white-space:pre-wrap">aa&#13;bb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 35)
    expect_layout('<div style="font:16px monospace;width:10px"><div style="float:left;white-space:pre-wrap">aa&#12;bb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 35)
    expect_layout('<div style="font:16px monospace;width:300px"><div style="white-space:pre"><span style="display:inline-block;width:6px;height:6px"></span>&#13;<b id="m" style="display:inline-block;width:4px;height:4px"></b></div></div>', 6, chrome_y: 13)
    expect_layout('<div style="font:16px monospace"><div style="white-space:pre">&#12;</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 13)
  end
  # A CR is a collapsible space under a collapsing mode (CSS Text 3 §4.1.1), and native lays it out as one;
  # only the MEASURE refused it — native's intrinsic walk and the gate asking it with `preserved` regardless of the
  # element's mode — so every shrink-to-fit asker around `aa&#13;bb` declined. It breaks there at min-content.
  it 'measures a CR under a collapsing white-space as a space' do
    expect_layout('<div style="font:16px monospace;width:10px"><div style="float:left">aa&#13;bb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 57)
  end
  # …and FF with it, which is wrong for FF: CSS Text 3 makes only CR a space, and Chrome draws FF as
  # a glyph with no break opportunity (`aa&#12;bb` one 48-wide line there; native breaks it at min-content).
  it 'collapses FF as a space too (shared)' do
    expect_layout(
      '<div style="font:16px monospace"><div style="width:min-content">aa&#12;bb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      shared_y:        57,
      shared_y_chrome: 35
    )
  end

  # AN EDGE IS NOT CONTENT A BREAK MAY LEAVE BEHIND. Two questions about a line are kept apart —
  # `line_placed` (anything went down on it, an edge included) and `line_has_content` (something a break may
  # leave behind) — and every break-before test asks the second. Asked as one flag, an opening edge alone on a
  # line counted as content and a box too narrow for edge + atomic broke BEFORE the atomic, where Chrome keeps
  # it beside the edge and overflows, as long as nothing OFFERS a break there (with a `<wbr>` between them
  # Chrome takes it; native does not, a shared gap pinned below).
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
      expect_layout(%(#{head}<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>), 6, chrome_y: 13)
    end
  end
  it 'breaks before an atomic when what fills the line is CONTENT (the control)' do
    expect_layout(
      '<div style="width:6px;font:16px monospace"><b style="display:inline-block;width:6px;height:4px"></b>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      chrome_y: 35
    )
  end
  # …and a line holding nothing but EDGES is still at its START: a collapsible space there is deleted (CSS Text 3
  # §4.1.2), as Chrome deletes it, and `aaaa` fits beside the edges — one line, the marker at 52.41. The layout
  # asked "is anything PLACED" (`line_placed` — an edge is), kept the space, and wrapped at it (38.4); it asks "is
  # anything that is CONTENT placed" now (`line_has_content`), the question its MEASURE asks since it stopped
  # making a line-start space a break opportunity — the two answering differently sized a min-content box
  # narrower than its own lines (22 tall where Chrome is, 44 then).
  it 'deletes a space behind edges alone on the line' do
    expect_layout(
      '<div style="width:60px;font:16px monospace"><span style="margin-left:9px"><span style="padding-right:5px"></span> aaaa</span>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      52.40625,
      chrome_y: 13
    )
  end
  # …and the MEASURE and the layout agree on it: a min-content box around a space behind a NEGATIVE edge is sized
  # to the word (28.4) and holds it on one line, the marker after the box at 35 as in Chrome — where, measuring
  # the space deleted and laying it out kept, the layout put the word on a second line (57).
  it 'fits the word a min-content box was measured for, behind a negative edge and a line-start space' do
    expect_layout(
      '<div style="font:16px monospace"><div style="width:min-content"><b style="margin-right:-10px"></b> <span>aaaa</span></div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      chrome_y: 35
    )
  end
  # …and beside a FLOAT such a line is still EMPTY of content: Chrome keeps the edge on it and sends a word that
  # does not fit the float's band below the float, at its left (x 0). The float-drop tests asked "is anything
  # PLACED" — the edge is — and left the word overflowing beside the float (35); they close the edge-only line
  # and drop the next now, measuring the fit from where the pen stands (a negative edge's word still fits).
  # With the space or without it: the break at a kept space used to move the word by accident.
  {
    'a space after the edge' => ' ',
    'no space'               => ''
  }.each do |name, gap|
    it "sends the word below a float past an edge-only line: #{name}" do
      expect_layout(
        %(<div style="font:16px monospace"><div style="width:60px"><div style="float:left;width:30px;height:30px"></div>) +
        %(<span style="padding-left:5px"></span>#{gap}<span id="m">aaaa</span> bb</div></div>),
        0,
        chrome_y: 30
      )
    end
  end
  # …and so a NON-WRAPPING run after such a space wraps once, to the second line, as in Chrome, where the layout
  # used to reach the third by breaking at the space it had kept. (The space the flow does place — after real
  # content — is content from the moment it goes down, not when a word consumes it: a non-wrapping run's pre-pass
  # asks in between, which the review's `edgeline_*` sweep found.)
  it 'wraps a non-wrapping run after a space behind an edge alone on the line' do
    expect_layout(
      '<div style="width:30px;font:16px monospace"><span style="padding-left:6px"></span> ' \
      '<span style="white-space:nowrap">aaaa</span><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>',
      0,
      chrome_y: 35
    )
  end
  # …while a space the flow NEVER placed is no content at all, however it is carried: a non-wrapping
  # white-space run at a line start collapses away and leaves only its hard barrier behind (a zero-width
  # pending space), and when a later edge put the line down and a `<wbr>` made it breakable, counting that
  # phantom as content broke before the atomic.
  # Chrome breaks at the `<wbr>` in both this shape and the one after it, and native keeps the atomic
  # beside the edge: an opportunity after an edge-only line is one native does not take. Shared, recorded.
  {
    'a collapsed non-wrapping space, then an edge'  =>
      '<span style="padding-right:6px"><span style="white-space:nowrap"> </span></span><wbr>',
    'an opening edge alone'                         =>
      '<span style="padding-left:6px"></span><wbr>'
  }.each do |name, head|
    it "keeps an atomic beside an edge-only line across a <wbr>: #{name}" do
      expect_layout(
        %(<div style="width:6px;font:16px monospace">#{head}<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        shared_y:        13,
        shared_y_chrome: 35
      )
    end
  end
  # A CLOSING edge whose two halves cancel still LANDS: `padding-right` and `margin-right` are two edges, so
  # the line exists and the block around it is one line tall — 22, as in Chrome, which puts the marker after
  # it at 35. Judging the inline edgeless by the halves' SUM, the walk emitted no edge runs at all, so the
  # layout saw no line and gave the block no height (the marker at 13). (A `<br>` after it does
  # not show this: native's break closes a strut line of its own either way.)
  it 'puts the line down for a closing edge whose halves cancel' do
    expect_layout(
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
      expect_layout(
        %(<div style="width:100px;font:16px monospace">a<span style="#{style}">x<br>y</span>b) +
        %(<b id="m" style="display:inline-block;width:4px;height:4px"></b></div>),
        chrome_x,
        chrome_y: 35
      )
    end
  end
  # A forced break INSIDE an inline's edges: a `<br>` puts every opening edge still pending down on the line
  # it ends and breaks, and the box's CLOSE lands on the line the break opens. Native declined every
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
      expect_layout(%(<div style="width:400px;font:16px monospace">x #{inline}#{marker} y</div>), chrome_x, chrome_y: 35)
    end
  end
  # …and one native gets wrong: Chrome keeps a CLOSING edge on the line a `<br>` ENDS when the break
  # is the last thing in the inline — the marker after it at 0 — where native carries it to the next line
  # (two fragments, the second only the edge). Shared, recorded: it declined until the refusal above went,
  # so no instrument could see it. With anything after the break, even an empty inline, Chrome moves the
  # close down too and agrees.
  {
    'a margin'                         => '<b style="margin:0 5px"><br></b>',
    'padding, after text on the line'  => '<b style="padding-right:5px">t<br></b>'
  }.each do |name, inline|
    it "carries a closing edge past a <br> that ends the inline: #{name}" do
      expect_layout(
        %(<div style="width:400px;font:16px monospace">x #{inline}<i id="m" style="display:inline-block;width:4px;height:4px"></i> y</div>),
        chrome_y:        35,
        shared_x:        5,
        shared_x_chrome: 0
      )
    end
  end

  # …and the READING of such a marker, which had no guard at all because the only instrument that caught it
  # was an out-of-repo sweep. An out-of-flow child of an inline records where the flow had reached INSIDE that
  # box, and settles against the box's own fragment once the layout knows where that is. Two things could open
  # that fragment's line before the box's opening edge had landed on it — an inner box's CLOSING edge, and a
  # placement whose pending sum the edge had been cancelled out of — and the reading then took the line's
  # start for the content start: 0 where Chrome says 6.
  #
  # Both are fixed in the READING, not by putting the edge down earlier. Placing it earlier is what the
  # waiting exists to prevent (an edge on a line its content then leaves is stranded, and the block loses a
  # line — measured below), and it was tried: flushing for a closing edge, and flushing whatever the sum had
  # cancelled, each fixed one of these and cost that.
  # So the marker records what it can see AT THE TIME — the cursor it stands at, plus the edges then
  # waiting. Deriving it later from the fragment's start instead is right
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
    # …and an opening MARGIN, which lives outside the box and so is in neither its start nor its content-left
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
      expect_layout(%(<div style="position:relative;width:400px;font:16px monospace#{outer}">#{inner}</div>),
                    chrome_x)
    end
  end

  # …and the line the marker follows when its inline WRAPS is the one the opening edge landed on, which is
  # not the fragment's first: an inner box's closing edge can open one before that. Asserted as the `y`,
  # because that is what the lookup decides — the `x` here is 6 against Chrome's 11, which
  # is the same content-edge re-derivation one branch over and is recorded, not fixed (only a Chrome check
  # sees it at all).
  it 'follows its inline to the line the opening edge landed on' do
    expect_layout(%(<div style="position:relative;width:60px;font:16px monospace">aaaa aaaa ) +
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
    expect_layout(body, 0, chrome_y: 57)
  end

  it 'matches a single-line text block' do
    expect_layout('<div>Hello world</div>')
  end

  it 'matches a multi-line wrapping text block' do
    text = 'The quick brown fox jumps over the lazy dog and then keeps on running well past the edge of the box.'
    expect_layout(%(<div style="width:150px">#{text}</div>))
  end

  it 'matches nested block containers of text blocks' do
    expect_layout(<<~HTML)
      <div>
        <div style="width:120px">first paragraph of words that wraps onto multiple lines here</div>
        <div style="width:300px">second paragraph on probably one line</div>
      </div>
    HTML
  end

  it 'matches text with same-font inline elements (a / span) folded in' do
    text = 'Some words with <a href="#">a link here</a> and a <span>span too</span> that keep wrapping onward.'
    expect_layout(%(<div style="width:160px">#{text}</div>))
  end

  it 'matches text with different-font inline runs (bold / em)' do
    text = 'plain words then <b>some bold words</b> then <em>emphasised ones</em> and plain again onward.'
    expect_layout(%(<div style="width:170px">#{text}</div>))
  end

  # A mixed-font word — one glued across a run boundary with NO space between, because a plain (edgeless)
  # inline emits no OPEN/CLOSE run to separate the fonts: `foo<b>bar</b>baz`, `H<sub>2</sub>O`. It is ONE
  # unbreakable unit: the fonts differ but there is no line-break opportunity between the segments, so its
  # width is the sum of the per-font advances and the whole unit wraps together (its tail never spills).
  it 'matches a bold run glued mid-word' do
    expect_layout('<div style="width:300px">foo<b>bar</b>baz</div>')
  end
  it 'matches a subscript glued mid-word (H2O)' do
    expect_layout('<div style="width:300px">H<sub>2</sub>O and a longer <sub>subscripted</sub>word wrapping onward here past the edge</div>')
  end
  it 'matches a font-size change glued mid-word growing the line box' do
    expect_layout('<div style="width:300px">a<span style="font-size:24px">B</span>c then more plain words wrapping onward past the box edge here</div>')
  end
  it 'matches a three-font glued word' do
    expect_layout('<div style="width:400px">a<b>b</b><i>c</i>d and then several more plain words that wrap onward past the edge</div>')
  end
  # The glued unit is unbreakable; when its LEADING segment doesn't fit the line it wraps as one.
  it 'matches a glued mixed-font unit wrapping as one at the box edge' do
    expect_layout('<div style="width:70px">xxxxx yyyy<b>yyyy</b>yyyy and zzz</div>')
  end
  it 'matches a glued mixed-font prefix followed by a real space and more words' do
    expect_layout('<div style="width:120px">pre<b>fix</b>ed words then more that keep wrapping onward past the edge here</div>')
  end
  # The over-break guard: the glued unit's LEADING segment (`xx`) fits the current line but the WHOLE unit
  # (`xx` + the long bold tail) does not. The greedy breaker commits the unit to the line on the
  # leading segment alone and lets the tail OVERFLOW — a mid-word run boundary is never a break opportunity —
  # so this is ONE line. Fit-testing the whole unit instead would wrap it to a second line (a silent-wrong).
  it 'matches a glued unit whose leading segment fits but whose tail overflows the line (no extra break)' do
    expect_layout('<div style="width:120px">x xx<b>xxxxxxxxxxxxxxxx</b></div>')
  end
  it 'matches a subscript tail overflowing after a fitting leading segment' do
    expect_layout('<div style="width:90px">word H<sub>2222222222222</sub></div>')
  end

  # In-word breaking (overflow-wrap / word-break): a word WIDER than the band breaks between characters.
  # `break_unit_len` cuts it into per-character units and `line_layout` fills greedily (wrap_mode on the run).
  # break-word / anywhere move the over-long word to a FRESH line first; break-all fills the line it is on. A
  # word that FITS the band still wraps as a whole (no in-word break).
  it 'matches overflow-wrap:break-word breaking a long unbroken word' do
    expect_layout('<div style="width:120px; overflow-wrap:break-word">see thisisaverylongunbrokenwordthatmustbreak here</div>')
  end
  it 'matches word-break:break-all filling each line' do
    expect_layout('<div style="width:120px; word-break:break-all">The quick brown fox jumps over the lazy dog repeatedly.</div>')
  end
  it 'matches overflow-wrap:anywhere breaking a long word' do
    expect_layout('<div style="width:100px; overflow-wrap:anywhere">prefix supercalifragilisticexpialidocious suffix</div>')
  end
  it 'matches word-wrap:break-word (the legacy spelling) on a long URL' do
    expect_layout('<div style="width:140px; word-wrap:break-word">Visit https://example.com/a/very/long/path/that/keeps/going/onward for details</div>')
  end
  # freshLine: break-word puts the whole word on its own line, THEN breaks it there (a leading short word
  # stays above); break-all has no fresh line and fills the current line — the counts differ, so this pins it.
  it 'matches break-word starting the over-long word on a fresh line' do
    expect_layout('<div style="width:110px; overflow-wrap:break-word">a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c</div>')
  end
  it 'matches break-all with no fresh line for the over-long word' do
    expect_layout('<div style="width:110px; word-break:break-all">a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c</div>')
  end
  # A break-anywhere word that FITS the band is atomic — it soft-wraps as a whole, no in-word split.
  it 'matches a break-word word that fits the band wrapping whole' do
    expect_layout('<div style="width:200px; overflow-wrap:break-word">alpha bravo charlie delta echo foxtrot golf hotel india</div>')
  end
  # The mode is per-run and inherits: only the break-all span breaks inside; the plain span does not.
  it 'matches a break-all span beside a plain span (per-run mode)' do
    expect_layout('<div style="width:130px"><span style="word-break:break-all">antidisestablishmentarianism</span> <span>and thennnnnnnnnnnnnnnnnnnn</span></div>')
  end
  it 'matches break-word inherited from an ancestor onto a nested span' do
    expect_layout('<div style="width:120px; overflow-wrap:break-word">lead <span>nestedsuperlongunbreakableword</span> tail</div>')
  end
  # white-space:nowrap suppresses ALL soft-wrapping, in-word breaking included — one line even with break-all.
  it 'matches nowrap + break-all staying on one line' do
    expect_layout('<div style="width:80px; white-space:nowrap; word-break:break-all">unbreakablelongwordonasingleline plus more</div>')
  end
  # pre-wrap preserves whitespace and still soft-wraps, so a long word breaks inside under break-word too.
  it 'matches pre-wrap + break-word breaking a long word' do
    expect_layout("<div style=\"width:120px; white-space:pre-wrap; overflow-wrap:break-word\">line one\nthisisaverylongwordunderprewrap end</div>")
  end
  # break-word on a nested block element inside a wider container: the run fills the nested block's own width.
  it 'matches break-word on a nested block element' do
    expect_layout('<div style="width:180px"><p style="overflow-wrap:break-word">areallylongunbreakableurlwordhere followed by ordinary words wrapping past edge</p></div>')
  end

  # <wbr> is a zero-width soft-wrap opportunity: it separates the runs it sits between (so they do not merge
  # into one glued word) and lets the next word break before it. This holds at white-space:normal too — the
  # native breaker ignored <wbr> entirely before, merging the flanking text and mis-breaking it.
  it 'matches a <wbr> break opportunity in a long token (normal wrapping)' do
    expect_layout('<div style="width:70px">aaaaaaaaaa<wbr>bbbbbbbbbb</div>')
  end
  it 'matches a <wbr> across a font boundary' do
    expect_layout('<div style="width:70px">aaaaaaaaaa<wbr><b>bbbbbbbbbb</b></div>')
  end
  it 'matches multiple <wbr> break points in a URL' do
    expect_layout('<div style="width:80px">https://<wbr>example<wbr>.com<wbr>/very<wbr>/long<wbr>/path/onward</div>')
  end
  it 'matches a <wbr> inside a break-word block (the over-long-token case)' do
    expect_layout('<div style="width:70px; overflow-wrap:break-word">aaaaaaaaaa<wbr>bbbbbbbbbbbbbbbbbbbb</div>')
  end
  it 'matches a <wbr> just after a real space (space width preserved)' do
    expect_layout('<div style="width:70px">aaaa <wbr>bbbbbbbbbbbb</div>')
  end
  # A <wbr> immediately BEFORE a collapsible space must not swallow that space's advance — the space still
  # separates the words (width tuned so `aaaabbbb` fits one line but `aaaa bbbb` does not).
  it 'matches a <wbr> immediately before a collapsible space' do
    expect_layout('<div style="width:61px">aaaa<wbr> bbbb</div>')
  end
  it 'matches a <wbr> suppressed under white-space:nowrap' do
    expect_layout('<div style="width:60px; white-space:nowrap">aaaaaaaa<wbr>bbbbbbbb ccc</div>')
  end

  it 'matches a larger-font inline run growing the line height' do
    expect_layout(%(<div style="width:300px">small text <span style="font-size:28px">BIG</span> small again</div>))
  end

  it 'matches a fixed line-height with mixed font metrics (ascent/descent line box)' do
    # A LENGTH line-height does not scale per run, so the taller 28px run's ascent grows the line box
    # past the 40px line-height — max(ascent)+max(descent), not max(line-height). Diverges unless native
    # composes the line box from per-run ascent/descent.
    expect_layout(%(<div style="width:400px;line-height:40px">small text <span style="font-size:28px">BIG</span> more small text</div>))
  end

  it 'matches <br> hard breaks (mid, trailing, leading, doubled)' do
    [
      'line one<br>line two',
      'only line<br>',
      '<br>after a leading break',
      'a<br><br>b with a blank line between',
      'first<br>second<br>third',
    ].each do |body|
      expect_layout(%(<div style="width:400px">#{body}</div>))
    end
  end

  it 'matches an edged inline element (padding/border/margin) affecting wrap' do
    text = 'some words then <span style="padding:0 10px;border:1px solid #000;margin:0 6px">a boxed span</span> and more words that wrap onward here.'
    expect_layout(%(<div style="width:200px">#{text}</div>))
  end

  it 'matches a text block with padding, border, and margins' do
    text = 'Some words wrapping inside a padded bordered box to check content width and stacked height.'
    expect_layout(%(<div style="width:180px;margin:12px 0;padding:6px;border:2px solid #000">#{text}</div><div style="height:10px"></div>))
  end

  # An EDGED inline grows the line to its own FONT box where a closing edge LANDS: an edge placement grows the
  # line like any other. A CLOSE that only advanced the pen made the walk decline every edged inline whose
  # content area exceeds its line-height (`edged-inline-font-exceeds-line-height`), and where the inline holds
  # no text of its own — so that the close is all that could grow the line — the layout missed it outright: an
  # empty `font-size:30px` span makes a 16px line 41 tall in Chrome, and it was 22 here; a `super` one raises
  # it by the shift. The CLOSE run carries the box now.
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
      expect_layout(%(#{head}<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>), chrome_x, chrome_y: chrome_y)
    end
  end
  # …and an OPENING edge grows nothing past the strut, which with text in the inline
  # at a tiny line-height is what Chrome does too.
  it 'grows nothing for an opening edge with text in the inline' do
    expect_layout(
      '<div style="width:200px;font:16px monospace;line-height:8px">a<span style="border-left:2px solid">x</span>b' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>',
      30.828125,
      chrome_y: 6
    )
  end
  # Where native keeps a rule Chrome does not. What Chrome grows the line to for an inline is its
  # LINE-HEIGHT box (§10.8.1, the metrics its own text uses), where the layout's close grows it to the font's
  # CONTENT box and its opening edge grows nothing. The two boxes coincide at `line-height: normal` on a font
  # with no line gap — monospace here, which is why the shapes above agree with Chrome — and nowhere else: at a
  # line-height below the font box Chrome keeps the line there (the marker at 6; native 13 — the case the
  # refusal was written about, whose comment said 22 was MEASURED: it was read with a `font` shorthand after the
  # `line-height`, which resets it to `normal`), an opening edge grows an empty larger-font inline's line in
  # Chrome (28; native 13), and a serif or sans face's line gap makes a `normal` line a pixel or three
  # taller in Chrome than the content box (an empty 60px span: 69 against 67). ONE rule, recorded, not fixed.
  {
    'a close at a tiny line-height, padding' =>
      ['<div style="width:200px;font:16px monospace;line-height:8px">a<span style="padding:0 5px">x</span>b', 38.828125, 13, 6],
    'a close at a tiny line-height, border'  =>
      ['<div style="width:200px;font:16px monospace;line-height:8px">a<span style="border-right:2px solid">x</span>b', 30.828125, 13, 6],
    'an empty larger-font OPENING edge'      =>
      ['<div style="width:100px;font:16px monospace"><span style="font-size:30px;padding-left:5px"></span>', 5, 13, 28]
  }.each do |name, (head, chrome_x, shared_y, chrome_y)|
    it "grows the line by the font-box edge rule, not Chrome's line-height rule (shared): #{name}" do
      expect_layout(%(#{head}<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>), chrome_x, shared_y: shared_y, shared_y_chrome: chrome_y)
    end
  end
  # Two more the refusal was hiding — it declined every edged inline at a line-height below its font box, and
  # no sweep ran at one (the `line-height: 0` / `8px` variants of every sweep do now, 452k cases).
  # A non-wrapping space collapsed at a line start leaves a zero-width placeholder for its barrier, and its
  # metrics were ZERO — a height, where they have to be `-Infinity`, no metrics at all: the line's descent is
  # negative at such a line-height, so a word taking the placeholder on a line an edge had started grew it
  # (the block 10 tall where Chrome says 8). The marker reads the
  # block's height from BELOW it: one on the line would grow the line itself and hide the difference.
  it 'grows nothing for a collapsed non-wrapping space after an edge at a tiny line-height' do
    expect_layout(
      '<div style="font:16px monospace"><div style="width:100px;line-height:8px">' \
      '<span style="padding-left:5px;white-space:nowrap"> </span>b</div>' \
      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>',
      0,
      chrome_y: 21
    )
  end
  # Lines are told apart by COUNT, not by their y: at `line-height: 0` every line has the same one, so a marker
  # held for an inline's opening edge would take the edge landing on a LATER line for its own and settle at the
  # cursor it stood at on the earlier one (x 54 where Chrome says 6).
  it 'tells zero-tall lines apart when settling a marker held for an opening edge' do
    expect_layout(
      '<div style="position:relative;width:60px;font:16px monospace;line-height:0">aaaa aaaa ' \
      '<span style="padding-left:6px"><i id="m" style="position:absolute;width:5px;height:5px"></i>z</span></div>',
      6,
      chrome_y: 0
    )
  end
  # A marker held for an opening edge INSIDE an inline-block that itself sits in an edged inline: the held
  # record is the inline-block's, and the inline-block's settle resolves it — the block around it has no
  # record of it and would fall back to the cursor it was held at ((34.8, 22) where Chrome says (10, 44)).
  it 'settles a marker held inside an inline-block inside an edged inline' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace">aaaa aaaa <span style="padding-left:6px">' \
      '<span style="display:inline-block;width:50px">bb <span style="padding-left:4px"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span></span> t</div>',
      10,
      chrome_y: 44
    )
  end
  # …and a box held with an open inline follows the atomic it sits in when that atomic is MOVED after its own
  # layout — a flex item centred on its cross axis, a table cell's `vertical-align` — as Chrome has it, rather
  # than staying where the flow had been (y 0). Even a plain `<span>` around the atomic holds it.
  {
    'a flex item centred on its cross axis' =>
      '<span style="display:inline-flex;width:100px;height:50px;align-items:center"><div><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</div><div style="height:40px">k</div></span>',
    'a table cell aligned to its middle'    =>
      '<span style="display:inline-table"><span style="display:table-cell;height:50px;vertical-align:middle"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span>'
  }.each do |name, atom|
    it "moves a held marker with its atomic: #{name}" do
      expect_layout(%(<div style="position:relative;width:200px;font:16px monospace">aaaa <span>#{atom}</span> t</div>), 48.015625, chrome_y: 14)
    end
  end
  # …and a REUSED subtree put back where it now belongs carries such a marker to where Chrome has it, in a flex
  # item laid out twice (measured, then stretched) too: 60.6 after one mutation, where it was once 57.6. Only
  # after a mutation, so the spec makes one.
  it 'places a held marker in a twice-laid-out flex item where Chrome does after a mutation' do
    body = '<div id="o" style="position:relative;width:220px;font:16px monospace">aaaa <span style="position:relative;left:3px">' \
           '<span style="display:inline-flex;width:100px"><div style="height:40px">Q</div>' \
           '<div><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</div></span></span> t</div>'
    expect_layout(body)
    with_page(body) do |session|
      session.evaluate_script('document.body.offsetHeight')
      session.evaluate_script("document.getElementById('o').setAttribute('data-x', '1')")
      expect_near(marker_x(session), 60.625, body, 'x')
    end
  end
  # …and the same shift reaches an out-of-flow child placed directly in an inline-flex inside an edged inline,
  # whose static position is ALIGNED (centred) off the atomic's box: it moves with the line's alignment (Chrome
  # 85.5), not left where the atomic stood before it (82.5).
  it 'moves an aligned static position with the atomic around it' do
    expect_layout(
      '<div style="position:relative;width:120px;font:16px monospace;text-align:center">aaaa <span style="padding-left:6px">' \
      '<span style="display:inline-flex;width:60px;height:30px;justify-content:center;align-items:center"><i id="m" style="position:absolute;width:3px;height:3px"></i>k</span></span> tt uu vv</div>',
      85.5,
      chrome_y: 13.5
    )
  end
  # …and what native still does differently from Chrome there, recorded. In an rtl block with LTR text the
  # figure is BIDI — Chrome reorders the trailing ` t` (the inline-block lands at 50 where native puts it at
  # 30.8) and puts the marker before the LTR run `cc` at 80.8, two divergences that nearly cancel — which is the
  # excluded subsystem, not a box rule. And a held box does not follow a `position: relative` inline it waits
  # in (22; Chrome 24 — the same without the inline-block around it; where an rtl CORNER decides x, the offset
  # does reach it, natively and in Chrome).
  it 'places a held marker in an rtl inline-block by native\'s bidi-less order (shared)' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace;direction:rtl"><span style="padding-left:6px">' \
      '<span style="display:inline-block;width:50px">bb <span style="padding-left:4px"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span></span> t</div>',
      chrome_y:        22,
      shared_x:        77.8,
      shared_x_chrome: 80.796875
    )
  end
  it 'leaves a held marker where it was held, not where its relative inline moves (shared)' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace"><span style="padding-left:6px">' \
      '<span style="display:inline-block;width:50px">bb <span style="padding-left:4px;position:relative;top:2px"><i id="m" style="position:absolute;width:3px;height:3px"></i>cc</span></span></span> t</div>',
      10,
      shared_y:        22,
      shared_y_chrome: 24
    )
  end
  # A held marker is aligned by where it STANDS, past the edges still waiting: at the bare cursor, a NEGATIVE
  # opening margin left it past the tab gap the `pre` run then put down before it, and the justify spread
  # moved it by that gap (48, where Chrome says 34.4). The last of the family the review's
  # justify / held-marker sweeps parked (`justhang`, `placedspace`, `brflush` are permanent again).
  it 'aligns a held marker by where it stands past a negative opening margin' do
    expect_layout(
      %(<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa<span style="margin-left:-4px"><i id="m" style="position:absolute;width:2px;height:2px"></i>) +
      %(<span style="white-space:pre">\tb</span></span> end</div>),
      34.40625,
      chrome_y: 0
    )
  end
  # …but by COORDINATE, which is only right for the gaps that come AFTER the marker in flow order: a negative
  # edge that reaches back over ordinary gaps BEFORE it leaves those uncounted, where Chrome widens them and
  # moves the marker (native 77.4; Chrome 80.797). Counting a held marker's gaps in FLOW order, as an
  # atomic's are, matches Chrome on both; that is a conformance change of its own, recorded rather than made
  # during the port.
  it 'counts a held marker\'s gaps by coordinate past a negative edge (shared)' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify">a a a a <span style="margin-left:-9.6px"><i id="m" style="position:absolute;width:3px;height:3px"></i>ww</span> t uu vv</div>',
      shared_x:        77.4,
      shared_x_chrome: 80.796875
    )
  end
  # A JUSTIFIED line that wraps right after `aaaa ` and an inline's closing margin: the space is still the
  # line's trailing white space — an edge moves the pen without ending the hang — so nothing is spread over
  # it. Cut at the pen less the hang, which the margin pushed past the space, the gaps took the whole free
  # space into it (the marker at 105.6, past the line); they are cut where the hang BEGAN (48). Chrome
  # carries the empty span and its marker to the next line with the word glued to them (0, 44) where native
  # leaves them at the end of this one — shared, recorded.
  it 'spreads nothing over a trailing space an inline\'s closing edge follows on a justified line' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa aaaa aaaa ' \
      '<span style="margin-right:4px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span>bbbbbbbb</div>',
      shared_x:        48,
      shared_x_chrome: 0
    )
  end
  # …and the rest of that family, found by the review's held-marker and justify sweeps, all older than this
  # work. Each figure is Chrome's.
  {
    # A collapsed space still pending at an edge goes down where the flow met it, not AFTER the edge — its
    # advance and its gap: placed after, a marker inside the inline, past the space, was not moved by the
    # spread (48).
    'a pending space goes down before the closing edge after it' =>
      ['<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa <span style="margin-right:30px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span>b end</div>', 60.390625, 0],
    # An empty inline's edge goes down past the block margin still open above it: without it the line sat
    # INSIDE the previous block's bottom margin (22).
    'an edge-only line after a block margin'                      =>
      ['<div style="position:relative;width:100px;font:16px monospace"><p style="margin:0 0 20px">x</p><span style="padding-left:6px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span> t</div>', 6, 42],
    # …and a margin that carries the line past a float left it the float's band (56).
    'an edge-only line a margin carries past a float'              =>
      ['<div style="position:relative;width:100px;font:16px monospace;line-height:0"><div style="float:left;width:50px;height:10px"></div>' \
       '<p style="margin:0 0 20px">x</p><span style="padding-left:6px"><i id="m" style="position:absolute;width:2px;height:2px"></i></span> t</div>', 6, 20],
    # A wrapping run's PRESERVED spaces do not turn the separator a `pre` run ended in into a gap: they are
    # trailing white space, and Chrome spreads nothing over any of it (a gap put the marker at 100).
    'a pre run\'s separator before trailing preserved spaces'      =>
      ['<div style="position:relative;width:100px;font:16px monospace;text-align:justify;white-space:pre-wrap">aaaa<span style="white-space:pre"> </span>' \
       '<span><i id="m" style="position:absolute;width:2px;height:2px"></i></span>  bbbb bbbb end</div>', 48.015625, 0]
  }.each do |name, (body, chrome_x, chrome_y)|
    it "places a marker where Chrome does: #{name}" do
      expect_layout(body, chrome_x, chrome_y: chrome_y)
    end
  end
  # …and one that placement makes a SHARED divergence: a negative closing margin pulls the line's end back past
  # the real gap before it, and a line that ends in content (the atomic) has no hang to cut its gaps at by
  # order, so they are cut by coordinate and nothing is spread (24; Chrome 96). Putting the space down AFTER
  # the edge agreed with Chrome here, by accident. Recorded.
  it 'spreads nothing when a negative closing margin pulls the line end back past a gap (shared)' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify">aaaa <span style="margin-right:-24px"> </span>' \
      '<b id="m" style="display:inline-block;width:4px;height:4px"></b>bbbbbbbb end</div>',
      shared_x:        24,
      shared_x_chrome: 96
    )
  end
  # A non-wrapping run that cannot fit breaks the line FIRST, and the collapsed space still pending goes down
  # with it as a hang, which ends the run of PRESERVED spaces before it. Dropped instead, it left those hanging,
  # and they aligned the wrapped line as if they still hung off its end (28.8 here, 96 with a tab; Chrome
  # 19.2 / 23.2).
  {
    'a preserved space' => ['xxxxxxx ', 19.2],
    'a preserved tab'   => ["xxxxxxx\t", 23.2]
  }.each do |name, (prewrap, chrome_x)|
    it "ends a preserved hang with the space a non-wrapping run's early break drops: #{name}" do
      expect_layout(
        %(<div style="position:relative;width:100px;font:16px monospace;text-align:right"><b id="m" style="display:inline-block;width:4px;height:4px"></b>) +
        %(<span style="white-space:pre-wrap">#{prewrap}</span> <span style="white-space:pre">aa</span></div>),
        chrome_x
      )
    end
  end
  # A `pre` run placed WHOLE is content, so the separators the `pre` run before it ENDED in become gaps there,
  # and not only behind a real collapsed space. The layout still has an older gap from Chrome on this line
  # (43.2; Chrome 57.59).
  it 'turns a pre run\'s trailing separators into gaps where the next pre run is placed' do
    expect_layout(
      '<div style="position:relative;width:100px;font:16px monospace;text-align:justify"><span style="white-space:pre">  </span><b id="m" style="display:inline-block;width:4px;height:4px"></b>' \
      '<span style="white-space:pre"> </span><span style="white-space:pre"> </span> <span style="white-space:pre-wrap">  </span>bbbbbbbbbb end</div>',
      shared_x:        43.2,
      shared_x_chrome: 57.59375
    )
  end

  # A run that does not wrap is placed WHOLE, and the separators its body ENDS in are held back until something
  # follows them on the line — a collapsed space inside the body, and a no-break space, included. Counted at
  # once, they made a line wrapping right after such a run spread its free width over its own end.
  it 'holds back the justification gaps a non-wrapping run ends in' do
    marker = '<i id="m" style="position:absolute;width:2px;height:2px"></i>'
    expect_layout(
      %(<div style="position:relative;font:16px monospace;width:30px;text-align:justify"><span>y<span style="white-space:nowrap"> &nbsp;#{marker}</span>&nbsp;</span></div>),
      28.8125,
      chrome_y: 0
    )
    expect_layout(
      %(<div style="position:relative;font:16px monospace;width:45px;text-align:justify"><span style="white-space:nowrap">?&#10;&nbsp;#{marker}</span>dd</div>),
      28.8125,
      chrome_y: 0
    )
    # …and a `pre` run's, where Chrome spreads the line after all (80) and native holds the gaps back (57.6).
    expect_layout(
      %(<div style="position:relative;font:16px monospace;width:80px;text-align:justify"><span style="white-space:pre">ccc &nbsp; #{marker}</span> x-</div>),
      shared_x:        57.6,
      shared_x_chrome: 80
    )
  end

  # A marker HELD for an inline's opening edge on a line nothing has been placed on moves with that line's start
  # when a float after it moves the band — the edge has not gone down, so where the flow reaches inside the inline
  # is wherever the line now starts (Chrome 26; the cursor read before the float is 1).
  it 'moves a held marker with the band a float moves on an empty line' do
    expect_layout(
      '<div style="position:relative;font:16px monospace;width:100px"><span style="border-left:1px solid"><i id="m" style="position:absolute;width:3px;height:3px"></i>' \
      '<i style="float:left;width:25px;height:10px"></i></span></div>',
      26,
      chrome_y: 0
    )
  end

  # A marker HELD for its inline's opening edge, where a later inline's opening edge CANCELS the pending sum (a
  # negative margin against a padding): the placement after it commits the line to both edges all the same, at no
  # width, and the marker stands there — before a space whose word wraps away (7 on the first line), or at the start
  # of the line a word or an atomic wraps to, past the edges it waited on (-1 and 2). Not off the fragment's first
  # line, as if the edges had never landed (0 on the next line).
  it 'places a marker held for an edge a later edge cancels where the placement after it commits the line' do
    m = '<i id="m" style="position:absolute"></i>'
    expect_layout(%(<div style="width:8px">b<span style="margin-left:-1px">#{m}<span style="padding-left:1px"> d</span></span></div>), 7, chrome_y: 0)
    expect_layout(%(<div style="width:30px">bbb <span style="margin-left:-1px">#{m}<span style="padding-left:1px">dddd</span></span></div>), -1, chrome_y: 18)
    expect_layout(%(<div style="width:30px">b<span style="padding-left:2px">#{m}<span style="margin-left:-2px"><b style="display:inline-block;width:30px;height:5px"></b></span></span></div>), 2, chrome_y: 18)
    # …and the same with percentages, in the MEASURED column a `min-content` grid track lays it out in.
    expect_layout(
      %(<div style="display:grid;grid-template-columns:min-content 1fr"><div>b<span style="margin-left:-10%">#{m}) +
        %(<span style="padding-left:10%"> d</span></span></div></div>),
      7.2,
      chrome_y: 0
    )
  end

  # A marker's justification shift counts the gaps before the FLOW's x — which a `position: relative`
  # inline around it does not move, since that offset is applied at paint time. Counted with the offset, a
  # `left: 3px` inline gave a marker glued to `ee` the gap right after `ee` too (64.2).
  it 'counts a marker\'s justification gaps before a relative inline\'s offset' do
    expect_layout(
      '<div style="position:relative;width:90px;font:16px monospace;text-align:justify"><span style="position:relative;left:3px">' \
      'aa bb cc dd ee<i id="m" style="position:absolute;width:3px;height:3px"></i> ff gg hh</span> tt uu</div>',
      57.59375,
      chrome_y: 22
    )
  end

  # A `vertical-align` baseline SHIFT (sub / super / length / %) on an inline element offsets its whole content —
  # its runs ride the shift, growing the line box the block's height reflects. Native threads the accumulated
  # shift through the run stream. (`middle` / `text-top` / `text-bottom`, which place against a box, still decline.)
  ['<sup>x</sup>', '<sub>x</sub>', '<span style="vertical-align:super">x</span>',
   '<span style="vertical-align:sub">x</span>', '<span style="vertical-align:6px">x</span>',
   '<span style="vertical-align:-4px">x</span>', '<span style="vertical-align:40%">x</span>'].each do |el|
    it "matches an inline vertical-align shift #{el[0, 30]}" do
      expect_layout(%(<div style="width:300px">text before #{el} and after text</div>))
    end
  end
  it 'matches nested vertical-align shifts (a sub inside a sup accumulate)' do
    expect_layout('<div style="width:300px">base <sup>up <sub>back down</sub> up</sup> base</div>')
  end
  it 'matches a shifted inline wrapping across lines' do
    expect_layout('<div style="width:120px">word word <span style="vertical-align:super">up</span> word word word word</div>')
  end
  # A shifted element raises only its DIRECTLY-owned text; a NESTED inline child stays on the baseline, so the
  # line box does not grow — the common `<sup><a>1</a></sup>` footnote-link.
  it 'matches a superscript wrapping a link (nested text stays on the baseline)' do
    expect_layout('<div style="width:300px">footnote <sup><a href="#">1</a></sup> here</div>')
  end
  it 'matches a shift whose text is inside a nested span (no line growth)' do
    expect_layout('<div style="width:300px">a <span style="vertical-align:super"><span>text</span></span> b</div>')
  end
  it 'matches a shift wrapping bold nested content (no line growth)' do
    expect_layout('<div style="width:300px">a <sup><b>1</b></sup> b</div>')
  end
  # A whitespace-only inline in a larger font is a fragment on the line it sits on and grows the line box
  # (Chrome: 47 for `a<span style="font-size:40px"> </span>b` in a 16px block); native never grew a line for a
  # placed collapsed space (review finding). It grows it only where the space stays — a space the wrap drops
  # grows nothing, where Chrome grows a line for ANY inline fragment on it (CSS 2.1 §10.8: an empty inline, a
  # dropped space, a <br> inside a larger inline). That is a gap tracked as a backlog item; these cases pin the
  # golden, not Chrome.
  it 'grows a line for a placed whitespace-only inline of a larger font (not for a space the wrap drops)' do
    expect_layout('<div style="width:300px"><div>a<span style="font-size:40px"> </span>b</div></div>')
    expect_layout('<div style="width:300px"><div>a <span style="font-size:40px"> </span> b</div></div>')
    expect_layout('<div style="width:60px"><div>aaaa<span style="font-size:40px"> </span>bbbb cccc</div></div>')
    expect_layout('<div style="width:300px"><div><span style="font-size:40px"> </span>a</div></div>')
    expect_layout('<div style="width:300px;white-space:pre"><div>a<span style="font-size:40px"> </span>b</div></div>')
    expect_layout('<div style="width:60px;white-space:pre-wrap"><div>aaaa<span style="font-size:40px"> </span>bbbb</div></div>')
    expect_layout('<div style="width:60px"><div>aaaa<span style="font-size:40px"> </span><span style="display:inline-block;width:30px;height:5px"></span></div></div>')
  end

  # A WIDE character — CJK, fullwidth, Hangul — is its own break unit, which is what makes a Japanese paragraph
  # wrap at all: it has no spaces to break at. Native cuts those units (`break_unit_len`: a wide character
  # alone, a maximal non-wide run otherwise), in the flow and in the min-content measure alike. Until this,
  # such a run reached Rust, `measure_run` answered None and the whole PASS was discarded.
  describe 'wide characters break between themselves' do
    it 'wraps a CJK run between characters, and measures its min-content as one' do
      expect_layout('<div style="width:100px">日本語のテキストです</div>')
      expect_layout('<div style="width:100px">これは長い日本語の文章で折り返しが必要になります</div>')
      expect_layout('<div style="width:400px">日本語</div>')
      expect_layout('<div style="width:100px">mixed 日本語 and ascii text here</div>')
      expect_layout('<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>日本語のテキスト</div><div>x</div></div>')
      expect_layout('<table style="border-spacing:0"><tr><td style="padding:0">日本語のテキスト</td><td style="padding:0">bb</td></tr></table>')
    end
    # A wide character is an opportunity on BOTH sides, across a run boundary too — two text nodes, or a
    # `<span>` between them, are one word to the flow otherwise. An astral emoji is NOT one (`is_wide_char`
    # is BMP-only), and a ZWJ sequence must not be split into per-surrogate units.
    it 'breaks beside a wide character across a run boundary, and not around an astral one' do
      expect_layout('<div style="width:60px">日本語<span>abcdefghijkl</span></div>')
      expect_layout('<div style="width:60px"><span>日本語</span>abcdefghijkl</div>')
      expect_layout('<div style="width:60px">abc<span>defghijkl</span></div>')
      expect_layout('<div style="width:100px">aaaaaaaaaaaa&#x1F600;bbbbbbbbbbbb</div>')
      expect_layout('<div style="display:inline-block"><span>&#x1F468;&#x200D;&#x1F469;&#x200D;&#x1F467;</span></div>')
    end
    # The opportunity a wide character leaves has to cross a RUN boundary: the walk merges only same-font runs,
    # so a plain `<b>` around a Japanese word — or a padded inline, or a different size — splits them, and
    # without carrying the opportunity native glued what Chrome breaks. Both directions: a run ENDING wide, and
    # a word STARTING wide.
    it 'breaks beside a wide character across a font, weight or padding boundary' do
      expect_layout('<div style="width:60px">abcdefghij<b>日本語</b>klmnopqrst</div>')
      expect_layout('<div style="width:60px"><b style="padding-right:4px">日本語</b>abcdefghij</div>')
      expect_layout('<div style="width:60px">日本語<span style="font-size:24px">abcdefghijkl</span></div>')
      expect_layout('<div style="width:60px">abcdefgh<span style="font-size:24px">日</span>ijklmnop</div>')
      expect_layout('<div style="width:60px">abc<span style="font-size:24px">日本語</span>def</div>')
      expect_layout('<div style="width:60px">日本語<span style="font-size:24px">日本語</span>日本語</div>')
      expect_layout('<table style="border-spacing:0"><tr><td style="padding:0;width:60px">日本語<span style="font-size:24px">abcdefghijkl</span></td></tr></table>')
      # …and the MIN-CONTENT of a word whose wide character is not at its edge: only the wide unit is an
      # opportunity there (`own`), so the Latin run before it stays glued to the run before THAT — bracketing
      # every unit closed the word early and measured 42.63 where it is 59.53, and lost a padded
      # inline's 20px edge outright.
      ['<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>%s</div><div>x</div></div>'].each do |wrap|
        expect_layout(format(wrap, 'abcdef<b>gh日</b>'))
        expect_layout(format(wrap, '<b>日ab</b>cdefgh'))
        expect_layout(format(wrap, '<span style="padding-left:20px">abcd日</span>'))
        expect_layout(format(wrap, 'abcdef日'))
      end
      # …and the ASCII shapes it must not move: a mid-word run boundary is still no opportunity
      expect_layout('<div style="width:60px">abcdefghij<b>klm</b>nopqrst</div>')
      expect_layout('<div style="width:60px">abc<span style="font-size:24px">def</span>ghi</div>')
    end
    # …and per-character breaking is the OWNER's mode: one CJK character in a paragraph must not stop its Latin
    # words from breaking, nor route them through the unspaced measure that drops their letter-spacing.
    it 'keeps break-all over the Latin words of a mixed paragraph' do
      expect_layout('<div style="display:flex;width:50px"><div style="word-break:break-all">&#x65E5; abcdefghijklmnop</div></div>')
      expect_layout('<div style="display:flex;width:50px"><div style="word-break:break-all"><span>&#x65E5;</span> abcdefghijklmnop</div></div>')
      expect_layout('<div style="display:inline-block;letter-spacing:4px"><span>&#x65E5; abcdefgh</span></div>')
      # …while a word that DOES hold one still breaks per code point under that mode (`own = perChar || wide`),
      # tail included — grouping the Latin tail back into one unit measured 58.63 where it is 50.
      expect_layout('<div style="display:flex;width:50px"><div style="word-break:break-all">&#x65E5;abcdefgh</div></div>')
    end
    # A COLLAPSED tab is measured by nobody — the whitespace run never reaches `measure_run` — so tab-indented
    # markup lays out natively whatever the mode. (A PRESERVED one is native's too now: see the tab-stop
    # describe below. A FORM FEED still declines — `declines a preserved form feed …` covers that.)
    it 'lays out tab-indented markup' do
      expect_layout("<div style=\"width:400px\">\n\t<span>hello</span>\n</div>")
    end
    it 'keeps the wrap modes and spacing over a CJK run' do
      expect_layout('<div style="width:60px;word-break:break-all">日本語のテキスト</div>')
      expect_layout('<div style="width:60px;overflow-wrap:anywhere">日本語のテキスト</div>')
      expect_layout('<div style="width:60px;white-space:nowrap">日本語のテキスト</div>')
      expect_layout('<div style="width:60px;white-space:pre-wrap">日本語の テキスト</div>')
      expect_layout('<div style="width:60px;letter-spacing:2px">日本語のテキスト</div>')
    end
    # A HYPHEN or dash is a break opportunity (`hyphen_breaks_after`): the word is cut into PIECES, each
    # keeping its hyphen, and the pieces are what the line fits. (A SOFT one is an opportunity too, where the
    # flow draws a hyphen the text never held: see the soft-hyphen shapes below.)
    it 'breaks a hyphenated word at its hyphens' do
      expect_layout('<div style="width:90px">well-known example text</div>')
      expect_layout('<div style="width:300px">a hyphenated word that fits stays whole: well-known</div>')
      expect_layout('<div style="width:60px">xxxx --no-cache</div>')     # after EACH hyphen of a double one
      expect_layout('<div style="width:60px">12-34-56-78-90</div>')      # …between digits too
      expect_layout('<div style="width:60px">-leading trailing-</div>')  # …one that OPENS a word; none after a trailing one
      expect_layout('<div style="width:60px">xx -55 -aa</div>')          # …and none before the digit a hyphen signs
    end
    it 'breaks on both sides of an em dash, never at a non-breaking hyphen' do
      expect_layout('<div style="width:60px">foo—bar</div>')
      expect_layout('<div style="width:60px">foo–bar</div>')
      expect_layout('<div style="width:60px">foo&#x2012;bar</div>')
      expect_layout('<div style="width:60px">foo&#x2011;bar</div>')
      expect_layout('<div style="width:60px">foo/bar</div>')
    end
    # The PIECE is what the in-word modes ask their fit question of — a per-character break is offered only to a
    # piece too wide for the band, not to the whole word — so `super-cali-fragilistic` breaks at its hyphens and
    # only the piece that still overflows breaks between characters. Cutting the word per character instead laid
    # it out in three lines against Chrome's four.
    it 'cuts inside a hyphen piece only where that piece alone overflows' do
      %w[overflow-wrap:break-word overflow-wrap:anywhere word-break:break-all].each do |mode|
        expect_layout(%(<div style="width:50px;#{mode}">super-cali-fragilistic</div>))
        expect_layout(%(<div style="width:100px;#{mode}"><span>aaaaaaaaaaaa-bbbbbbbbbbbbbb</span></div>))
        expect_layout(%(<div style="width:120px;#{mode}">up-to-date info</div>))   # every piece fits: no cut at all
      end
      # …and `overflow-wrap` moves the piece it must cut to a fresh line where `word-break: break-all` fills the
      # line it is on — a difference the piece loop has to make per PIECE, not once per word.
      expect_layout('<div style="width:90px;overflow-wrap:break-word">see-alsoooooooooooooooo</div>')
      expect_layout('<div style="width:90px;word-break:break-all">see-alsoooooooooooooooo</div>')
    end
    # min-content takes the pieces and nothing finer: a piece is measured whole however the mode would cut it
    # in the flow.
    it 'measures a hyphenated word as its widest piece' do
      ['', 'word-break:break-all', 'overflow-wrap:break-word'].each do |mode|
        expect_layout(%(<div style="width:min-content;#{mode}">well-known example</div>))
        expect_layout(%(<div style="width:max-content;#{mode}">well-known example</div>))
        expect_layout(%(<div style="display:grid;grid-template-columns:min-content auto;width:400px;#{mode}"><div>e-mail-address</div><div>x</div></div>))
      end
    end
    # A run that ENDS in a dash leaves the opportunity behind for the next run to take (`ends_with_break`) —
    # the hyphen of `well<b>-</b>known` is a run of its own, so the break after it
    # is the only one that word has. Reading it as a WIDE character's rule alone left native a line short on
    # every such shape, silently: nothing declined.
    it 'breaks after a dash a run ends with' do
      expect_layout('<div style="width:70px">well<b>-</b>known example</div>')
      expect_layout('<div style="width:70px">well-<b>known</b> example</div>')
      expect_layout('<div style="width:70px">trailing-<span style="padding:0 4px">piece</span></div>')
      expect_layout('<div style="width:70px">x<b>&#x2014;</b>y longer text</div>')
      expect_layout('<div style="width:70px">well<b>x</b>known example</div>')   # …and a letter leaves none
    end
    # …and a run BOUNDARY inside a word is not a token boundary: a word is whatever the text spells, however
    # many nodes spell it. The walk merges adjacent same-font text into one run, so the hyphen piece would run
    # PAST the node it ends at — `well-known` + `Z` one piece, where the two nodes are two tokens. The merge
    # stops at a glued join for that reason.
    it 'lays out a word spelled by more than one text node' do
      expect_layout('<div style="width:100px">well-known<span>Z</span></div>')
      expect_layout('<div style="width:100px">well-<span>known</span></div>')
      expect_layout('<div style="width:100px">aa<span>-</span>bb longer text here</div>')
      expect_layout('<div style="width:min-content">well-<span>known</span></div>')
      expect_layout('<div style="width:min-content">aa<span>-</span>bb</div>')
      expect_layout('<div style="width:100px">xx abcd<span>efghijklmn</span> yy</div>')   # …hyphen or not
    end
    # A collapsed space before a word the wrap then BREAKS grows nothing: the space's own metrics belong to the
    # line it stays on, and the unit loop has to apply them after that break test, not before it.
    it 'gives the line the space of a larger font only where the space stays' do
      expect_layout('<div style="width:30px">q<span style="font-size:40px"> </span>well-known</div>')
      expect_layout('<div style="width:30px">q<span style="font-size:40px"> </span>&#x65E5;&#x672C;&#x8A9E;</div>')
      expect_layout('<div style="width:24px;word-break:break-all">q<span style="font-size:40px"> </span>aaaa</div>')
      expect_layout('<div style="width:300px">q<span style="font-size:40px"> </span>well-known</div>')  # …and where it does stay
    end
    # A run ending in a space character that is NOT css white space — a thin space, an ideographic space — leaves an
    # opportunity too (`ends_with_break`), and none of them reaches native as a space run of its own; one ending in a
    # NO-BREAK space (U+00A0, U+2007, U+202F, U+FEFF) or a U+000B leaves none (Chrome: the guard in
    # rust_walk_coverage_spec).
    it 'breaks after the space characters a run ends with, and after no no-break space' do
      %w[000B 00A0 2007 2009 200A 2028 2029 202F 205F 1680 2000 2003 FEFF].each do |cp|
        expect_layout(%(<div style="width:80px">xx ab&\#x#{cp};<b>kgkgkgkg</b></div>))
      end
    end
    # The regex's `\p{L}` / `\p{N}` are asked of CODE POINTS: an astral letter after a hyphen is one, and
    # reading its lone surrogate instead lost the break.
    it 'breaks after a hyphen an astral letter follows' do
      expect_layout('<div style="width:70px">ab-&#x1D518;&#x1D52B;-cd more</div>')
      expect_layout('<div style="width:70px">ab-&#x1D7D8;&#x1D7D9; more</div>')
      expect_layout('<div style="width:70px">ab-&#x1F600; more</div>')           # …and an emoji is neither
    end
    # …and they are the REGEX's classes, not Rust's `is_alphanumeric`: a combining mark is Alphabetic and no
    # letter, an enclosed one (U+24B6) is So and no letter, and reading either as one moved the boxes.
    it 'reads a combining or enclosed character after a hyphen as no letter' do
      # …and A7F1 / 0C5C, which Rust std calls letters and this V8 does not: asking `char::is_alphabetic`
      # rather than `\p{L}` itself made the answer depend on the rustc the extension was built with.
      %w[093E 0903 064E 05B8 0345 0E31 17BB 24B6 2160 0301 00AA 2070 A7F1 0C5C].each do |cp|
        expect_layout(%(<div style="width:30px">q abab-&\#x#{cp};cdcd more</div>))
        # …and min-content, where the piece the break would make is the measure itself — the word-OPENING
        # hyphen's class (`\p{L}` alone) shows up nowhere else.
        expect_layout(%(<div style="width:min-content">abab-&\#x#{cp};cdcdcdcd</div>))
        expect_layout(%(<div style="width:min-content">-&\#x#{cp};cdcdcdcdcdcd</div>))
      end
    end
    # A hyphen inside a word that also holds a WIDE character: the pieces come first, and a piece bearing one
    # then breaks at it — the two cuts compose.
    it 'composes hyphen pieces with wide-character units' do
      expect_layout('<div style="width:60px">mix-&#x65E5;&#x672C;-ed</div>')
      expect_layout('<div style="width:60px;word-break:break-all">mix-&#x65E5;&#x672C;-ed</div>')
      expect_layout('<div style="width:min-content">mix-&#x65E5;&#x672C;-ed</div>')
    end
    # …and the same undecidable arm took down every OTHER character at or above U+0300, because whether one is a
    # combining mark is the question `zero_width` could not answer. It answers it from `\p{M}` now (`unicode.rs`).
    it 'measures a space, a dash, an emoji and a combining mark' do
      expect_layout('<div style="width:400px">a&#x2003;b</div>')
      expect_layout('<div style="width:400px">a&#x2002;b</div>')
      expect_layout('<div style="width:400px">a&#x3000;b</div>')
      expect_layout('<div style="width:400px">a&#x00B7;b</div>')
      expect_layout('<div style="width:400px">caf&#x00E9; na&#x00EF;ve</div>')
      expect_layout('<div style="width:400px">&#x0301;a</div>')
      expect_layout('<div style="width:400px">&#x2764;&#xFE0F;</div>')
      expect_layout('<div style="width:400px">&#x1F600;&#x1F601;</div>')
    end


    # A RUN of soft hyphens is ONE opportunity, as in Chrome — cut after the first, the second became a zero-wide
    # piece of its own that decided the hyphen against nothing (`aaa&shy;&shy;&shy;bbbb` in 35px: 66 tall, where
    # Chrome says 44). The marker positions are Chrome's.
    it 'breaks a run of soft hyphens as one opportunity' do
      expect_layout('<div style="font:16px monospace"><div style="width:35px">aaa&shy;&shy;&shy;bbbb</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 57)
      expect_layout('<div style="font:16px monospace"><div style="width:25px;text-indent:13px hanging">aa&shy;&shy;bb cc</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 79)
      expect_layout('<div style="font:16px monospace"><div style="width:49px"><span style="hyphens:none">aa&shy;&shy;bb cc</span> aa&shy;&shy;bb cc</div><b id="m" style="display:inline-block;width:4px;height:4px"></b></div>', 0, chrome_y: 101)
    end
    # …and the hyphen a break shows at a soft hyphen that ENDS its node is an EDGE (`take_break!` places it as one):
    # not content, so the NBSP before it stays a held separator and not a gap the justified line widens — an
    # out-of-flow box between the two counts no gap (flushed as one, it moved the box 10.8 right).
    # SHARED: Chrome puts that box past the hyphen, at 19.22; native puts it where the flow stood, before it.
    it 'shows the hyphen of a node-ending soft hyphen as an edge, no gap before it' do
      expect_layout(
        '<div style="position:relative;font:16px monospace;width:30px;text-align:justify">bb &nbsp;&shy;<i id="m" style="position:absolute;width:2px;height:2px"></i>ccc</div>',
        chrome_y: 22, shared_x: 9.6, shared_x_chrome: 19.2188
      )
    end
    # …and a node of NOTHING but soft hyphens under `hyphens: none` is no content once the gather strips them, yet
    # still makes its line (Chrome: 18 tall); and a ZWJ under a per-character wrap measures with the characters
    # around it, its advance carried from the one before it (Chrome: 15.11 wide).
    it 'lays out a node of soft hyphens that hyphens: none empties, and a per-character ZWJ' do
      {
        '<div style="width:200px"><div id="m" style="hyphens:none">&shy;</div>x</div>' => [200, 18],
        '<div id="m" style="width:max-content;word-break:break-all">a&#x200D;b</div>' => [15.109375, 18]
      }.each do |body, (chrome_w, chrome_h)|
        expect_layout_golden(body)
        with_page(body) do |session|
          box = session.evaluate_script("(r => [r.width, r.height])(document.querySelector('#m').getBoundingClientRect())")
          expect_near(box[0], chrome_w, body, 'width')
          expect_near(box[1], chrome_h, body, 'height')
        end
      end
    end
    # …and a preserved CR / FF node that is a block's ONLY text, under a text indent. GAP: Chrome lets it TAKE the
    # indent where it is measured — a CR-only `pre` float with `text-indent: 20px` is 20 wide, 0 tall — but the block
    # reads as empty to the walk, which measures it 0 wide.
    it 'measures a block whose only text is a preserved CR under a text indent' do
      ['<div style="width:300px"><div id="m" style="float:left;white-space:pre;text-indent:20px">&#13;</div>x</div>',
       '<div style="width:300px"><div id="m" style="float:left;white-space:break-spaces;text-indent:20px">&#12;</div>x</div>',
       '<div style="width:300px"><div id="m" style="float:left;text-indent:20px"><span style="display:contents;white-space:pre">&#13;</span></div>x</div>'].each do |body|
        with_page(body) do |session|
          width = session.evaluate_script("document.querySelector('#m').getBoundingClientRect().width")
          expect(width).not_to be_within(0.05).of(20), "#{body}: #m now AGREES with Chrome (20 wide) — a fix: assert Chrome's figure"
          expect(width).to eq(0), "#{body}: #m #{width} wide; the layout says 0, Chrome 20"
        end
        expect_layout_golden(body)
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
    expect_layout('<div style="width:200px;font:16px monospace"><span style="margin-left:-12px">x y </span><span id="m" style="display:inline-block;width:10px;height:10px"></span></div>', 26.41)
    expect_layout('<div style="width:300px">aaa <span style="float:left;width:50px;height:20px"></span>bbb <span id="m" style="display:inline-block;width:10px;height:5px"></span></div>')
    # …and a text node that OPENS on that space, whose leading space the run's own collapse decides (Chrome 16)
    expect_layout('<div style="width:300px"><span style="margin-left:-10px"><span style="display:inline-block;width:10px;height:5px"></span></span> y <span id="m" style="display:inline-block;width:5px;height:5px"></span></div>', 16)
    expect_layout('<div style="width:300px"><span style="display:inline-block;width:50px;height:5px"></span><span style="float:left;width:50px;height:20px"></span> bbb <span id="m" style="display:inline-block;width:5px;height:5px"></span></div>')
  end

  it 'clears the floats a <br> names before the next line' do
    floats = '<div style="float:left;width:100px;height:40px"></div><div style="float:right;width:60px;height:70px"></div>'

    # The ATTRIBUTE maps only the four physical spellings (`BR_CLEAR_HINTS`), `all` being HTML4 for `both`;
    # `clear` reaches the flow-relative sides through CSS only, so those go through a declaration.
    ['clear="left"', 'clear="right"', 'clear="both"', 'clear="all"',
     'style="clear:inline-start"', 'style="clear:inline-end"'].each do |clear|
      expect_layout(%(<div style="display:flow-root;width:300px">#{floats}<div>aa<br #{clear}>bb</div></div>))
      # …and a flow-relative side resolves against the CONTAINING BLOCK's direction — so in rtl these two
      # are the other float, and the physical four are unmoved
      expect_layout(%(<div style="display:flow-root;width:300px;direction:rtl">#{floats}<div>aa<br #{clear}>bb</div></div>))
    end
    # …the block's direction, not the `<br>`'s own: an rtl inline around it changes nothing
    expect_layout(%(<div style="display:flow-root;width:300px">#{floats}<div>aa<span style="direction:rtl"><br style="clear:inline-start"></span>bb</div></div>))
    # …with nothing to clear it is an ordinary break, and a plain `<br>` beside floats is one too
    expect_layout('<div style="width:300px">aa<br clear="both">bb</div>')
    expect_layout(%(<div style="display:flow-root;width:300px">#{floats}<div>aa<br>bb</div></div>))
    # …and a `<br>` is CONTENT whether or not it clears: an inline-block holding only one is a line tall,
    # not empty (measured — losing that made it 0 and moved the box 14px up its line).
    expect_layout('<div style="width:400px">text <span style="display:inline-block"><br></span> x</div>')
    expect_layout('<div style="width:400px">text <span style="display:inline-block"><br clear="left"></span> x</div>')
  end

  # `text-indent` narrows the line it is on from the START edge — the right one in rtl — rather than moving a
  # cursor inside it, so an indented empty line is still empty. Which lines take it: the first, or with
  # `hanging` every line BUT the first, and with `each-line` the first after every forced break as well. It was
  # the walk's most common decline after auto margins, and it is on BOTH figures the intrinsic measure returns.
  describe 'text-indent narrows the lines it is on' do
    it 'indents the first line, and wraps around the narrower line' do
      expect_layout('<div style="width:200px;text-indent:40px">one two three four five six seven eight</div>')
      expect_layout('<div style="width:200px;text-indent:40px"><span style="display:inline-block;width:10px;height:10px"></span> tail</div>')
      expect_layout('<div style="width:200px;text-indent:-30px">one two three four five six seven eight</div>')
      # …a PERCENTAGE against the block's own CONTENT width, not its border box
      expect_layout('<div style="width:200px;padding:0 20px;border-left:10px solid;text-indent:20%">one two three four five six</div>')
      # …and a LINEAR `calc()` of one. The indent reader split its value on white space and `parseFloat`'d the
      # pieces, so `calc(10% + 1px)` arrived as `calc(10%` / `+` / `1px)` and the last of them was read as an
      # indent of ONE PIXEL, which only a Chrome figure could catch: Chrome 153 puts the marker at 60.203125
      # where that gave 20.2. The 10% shape beside it is the control the bug left passing.
      expect_layout('<div style="width:400px;font:16px monospace;text-indent:calc(10% + 1px)">hi' \
                    '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 60.203125)
      expect_layout('<div style="width:400px;font:16px monospace;text-indent:10%">hi' \
                    '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 59.203125)
    end
    # …and a COMPARISON function over ONE affine operand with constant bounds is `clamp(lo, px + frac x basis,
    # hi)`, which the record carries (rec[129]/130 beside rec[96]/118) and native evaluates — so it takes the
    # native path like a plain percentage.
    # It was wrong for one build, and the way it got there is worth the line: the reader answered `null` for
    # "not linear" as well as for "no indent", the record writer dropped a null, and native laid the block out
    # at indent 0 where Chrome indents 30. Before that it was right by accident — the reader could not parse a
    # math function at all and `parseFloat`'d `30px)` out of `min(50%, 30px)`.
    it 'evaluates a min() / clamp() text-indent natively' do
      ['min(50%, 30px)', 'clamp(5px,50%,30px)'].each do |indent|
        expect_layout(%(<div style="width:400px;font:16px monospace;text-indent:#{indent}">hi) +
                      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', 49.203125)
      end
    end
    # …and one capped by ANOTHER LINE goes native too: `min(10%, 20%)` is `10%` held under `20%` — and since 2026-09-26
    # any comparison of lines, as a program native evaluates: two that cross beside a constant (50 of 400), a nested one
    # (20). Only a comparison inside a `calc()` is left out. Chrome's figures.
    it 'evaluates a text-indent capped by another percentage natively' do
      {
        'min(10%, 20%)'                             => 59.203125,
        'min(20%, calc(5% + 30px), 60px)'           => 69.203125,
        'max(0px, min(10%, calc(100px - 20%)))'     => 39.203125
      }.each do |indent, x|
        expect_layout(%(<div style="width:400px;font:16px monospace;text-indent:#{indent}">hi) +
                      '<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>', x)
      end
    end
    it 'indents every line but the first under hanging, and after a forced break under each-line' do
      expect_layout('<div style="width:200px;text-indent:40px hanging"><span style="display:inline-block;width:10px;height:10px"></span> one two three four five six seven</div>')
      expect_layout('<div style="width:200px;text-indent:40px each-line">x<br><span style="display:inline-block;width:10px;height:10px"></span> two</div>')
      expect_layout('<div style="width:200px;text-indent:40px">x<br><span style="display:inline-block;width:10px;height:10px"></span> two</div>')
    end
    # In a MIXED block the indent is the BLOCK's, not each anonymous group's: only "is this the block's first
    # line" is one-shot — the first group that places a line takes it, and a block-level child spends whatever
    # no line took (Chrome puts the span after the inner block at x=0, not at 40). The PER-LINE rules go on
    # applying in every later group, which is what these wrapping cases pin: writing the indent to the first
    # group alone left a later group's `hanging` lines flush (native 77 where Chrome says 113).
    it 'gives a mixed block its indent once, and a block child spends it' do
      expect_layout('<div style="width:200px;text-indent:40px">text <div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      expect_layout('<div style="width:200px;text-indent:40px"><div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      expect_layout('<div style="width:200px;text-indent:40px">  <div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      # …and the LINE COUNT of a group after the block child, where the per-line rules actually show
      words = 'aa bb cc dd ee ff gg hh ii jj kk ll mm nn'
      expect_layout(%(<div style="width:100px;text-indent:40px hanging">x<div style="height:5px"></div>#{words}</div>))
      expect_layout(%(<div style="width:100px;text-indent:40px each-line">x<div style="height:5px"></div>q<br>#{words}</div>))
      expect_layout(%(<div style="width:100px;text-indent:40px">x<div style="height:5px"></div>#{words}</div>))
      expect_layout(%(<div style="width:100px;text-indent:-20px">#{words}</div>))
    end
    # …and it is on the first line of BOTH intrinsic figures, where a PERCENTAGE resolves against nothing —
    # which is what leaves the `text-indent: -9999px` hidden-label idiom its padding.
    it 'measures an indented block natively, on the route the plain one takes' do
      # Each pair is the same shape with and without the indent: `text_intrinsic` takes the indent as the line
      # layout does — the first occupant of each line takes it, a forced break re-arms it under `hanging` /
      # `each-line` — from the length on the record (a `%` resolves against nothing in an intrinsic measure,
      # CSS Sizing 3).
      ['<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div style="%s">aa bb</div><div>x</div></div>',
       '<div style="display:grid;grid-template-columns:max-content auto;width:400px"><div style="%s">aa bb</div><div>x</div></div>',
       '<div style="width:400px">a <span style="display:inline-block;%s">bb cc</span></div>'].each do |shape|
        ['text-indent:20px', 'text-indent:20%', 'text-indent:-20px', 'text-indent:20px hanging',
         'text-indent:20px each-line', ''].each do |indent|
          expect_layout(format(shape, indent))
        end
      end
      # …a `<td>` measures its own contribution too.
      expect_layout('<table style="border-spacing:0"><tr><td style="padding:0;text-indent:20px">aa bb</td><td style="padding:0">cc</td></tr></table>')
      expect_layout('<div style="display:inline-block;padding:0 5px;text-indent:-9999px">Label</div>')
      expect_layout('<div style="display:flex;width:400px"><div style="text-indent:30px">aa bb</div></div>')
    end
    # A line's room for content is its band LESS the indent, and the band it drops to has to hold both: a 70px
    # inline-block under a 60px indent beside a 200px float of 300 clears the float (Chrome), where the layout
    # used to keep it beside — and a NEGATIVE indent keeps a line beside a float it would otherwise clear.
    it 'fits a line beside a float on the indented width' do
      float = '<div style="float:left;width:200px;height:40px"></div>'
      wide  = '<div style="float:left;width:250px;height:40px"></div>'
      ib    = '<span style="display:inline-block;width:70px;height:10px"></span>'
      expect_layout(%(<div style="display:flow-root;width:300px">#{float}<div style="text-indent:60px">#{ib}</div></div>))
      expect_layout(%(<div style="display:flow-root;width:300px">#{wide}<div style="text-indent:-30px">#{ib}</div></div>))
      expect_layout(%(<div style="display:flow-root;width:300px">#{wide}<div style="text-indent:-9999px">wwwwwwwwww</div></div>))
      expect_layout(%(<div style="display:flow-root;width:300px">#{float}<div>#{ib}</div></div>))
    end
  end

  # ── `white-space` is the RUN's, not the block's ────────────────────────────────────────────────────────
  # An inline may declare its own, and each of the three behaviours the property controls is then asked of the
  # run it is about: whether THIS text's spaces are real advances, whether a break may fall at THIS space,
  # whether THIS newline forces one. The run stream carries the mode (`Run::ws_mode`) and two runs of different
  # modes never merge into one — the block's own mode decides nothing for them.
  describe 'an inline carrying its own white-space' do
    it 'lays out a WRAPPING inline whatever the block declares' do
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:normal">bbb ccc</span> ddd</div>')
      expect_layout('<div style="width:80px;font:16px monospace">aaa <span style="white-space:pre-wrap">b  c</span> ddd</div>')
      expect_layout(%(<div style="width:200px;font:16px monospace">aaa <span style="white-space:pre-line">b
c</span> ddd</div>))
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre">aaa <span style="white-space:pre-wrap">b  c</span> ddd</div>')
    end
    # …and one whose own mode never wraps is measured under it too: what its line does about it is the
    # unbreakable-token rule below.
    it 'lays out a NON-wrapping inline inside a line that cannot break' do
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:pre">b  c</span> ddd</div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre">aaa <span style="white-space:nowrap">bbb ccc</span></div>')
    end
    # A space belongs to the run that WROTE it, and so does the break opportunity behind it: a non-wrapping
    # run's trailing space leaves a HARD barrier after it, and everything that consumes the space
    # — the next word, the next atomic — has to honour that rather than ask its own mode. A space also REPLACES
    # whatever opportunity the text before it left (a hyphen, a wide character).
    it 'keeps the break opportunity with the space that queued it' do
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:normal">bbbbbbbb ccc</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa <span style="white-space:normal"><span style="display:inline-block;width:60px;height:9px"></span></span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa- <span style="white-space:normal">bbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">一二三 <span style="white-space:normal">bbbbbb</span></div>')
      # …and without the space the opportunity is the hyphen's again
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa-<span style="white-space:normal">bbbb</span></div>')
    end
    # A PRESERVED space is a placement like any other: it puts the collapsed space waiting from an earlier run
    # down first, and it hangs in a counter of its own — `hang` and `hang_pre` are mutually exclusive, and the
    # preserved ones hang only on a line that WRAPPED.
    it 'places a waiting collapsed space before a preserved one, and hangs the two apart' do
      expect_layout('<div style="width:400px;font:16px monospace">aaa <span style="white-space:pre-wrap"> </span><span style="display:inline-block;width:20px;height:10px"></span></div>')
      expect_layout('<div style="width:400px;font:16px monospace">aaa <span style="white-space:pre-wrap">  </span>bbb<span style="display:inline-block;width:20px;height:10px"></span></div>')
      expect_layout('<div style="width:200px;font:16px monospace;text-align:right"><span style="display:inline-block;width:20px;height:10px"></span>aaa<span style="white-space:pre-wrap">   </span> wwwwwwwwwwwwwwwwwwww</div>')
      # …and a COLLAPSING whitespace-only run between two preserving ones is a space, not a no-op: the
      # zero-width opportunity a preserved space leaves behind must not stand in for it.
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre-wrap">aaa <span style="white-space:normal">  </span> ddd</div>')
    end
    # A PRESERVED space leaves a barrier behind it too — `null` where its run wraps, HARD where it does not.
    # A `pre` run leaving none at all let a hyphen, a wide character or an atomic on the far side of it open a
    # line that should stay whole. And a wrapping run that STARTS with white space rescues the opportunity of
    # the space already waiting, which is how a `nowrap` block's space still opens a line for the inline after it.
    it 'leaves the right barrier behind a preserved space, and rescues one for a leading space' do
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre">aaaa- </span><span style="white-space:normal">bbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre">aaaa- <span style="white-space:normal">bbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre">一二三 <span style="white-space:normal">bbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre">aaaa </span><span style="white-space:normal"><span style="display:inline-block;width:60px;height:9px"></span></span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:normal"> bbbbbbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:pre-line"> bbbbbbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">一二三 <span style="white-space:normal"> bbb</span> ddd</div>')
      # …while a space that TAKES the slot from a zero-width marker answers for itself, not for the marker
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre-wrap">a </span><span style="white-space:nowrap"> </span><span style="white-space:normal">bbbbbbbb</span></div>')
      # …and the preserved hang ends where a collapsed space is placed among them
      expect_layout('<div style="width:80px;font:16px monospace;text-align:right"><span style="display:inline-block;width:20px;height:9px"></span><span style="white-space:pre-wrap">a </span><span> </span><span style="white-space:pre-wrap"> </span>cccccccc</div>')
    end
    # The INTRINSIC measure asks the same questions through a content-sized box — a float, a vertical writing
    # mode, a `min-content` / `max-content` width, a flex item — where `pin` ("this box never wraps, so its
    # min-content IS its max-content") is the BLOCK's property however its runs are written.
    it 'measures a mixed-mode box through every content-sized route' do
      inner = 'aaa <span style="white-space:normal">bbb ccc</span> ddd'
      # …a newline inside a preserved run included: each newline-SEGMENT is its own placement, so a segment
      # after one starts over and a run that OPENS with a newline drops the space waiting for it.
      expect_layout(%(<div style="width:max-content;font:16px monospace;white-space:nowrap"><span style="white-space:pre">a
b</span><span style="white-space:normal"> c</span></div>))
      expect_layout(%(<div style="width:max-content;font:16px monospace;white-space:nowrap">一二三 <span style="white-space:pre-wrap">
  </span></div>))
      expect_layout(%(<div style="width:min-content;font:16px monospace;white-space:nowrap">#{inner}</div>))
      expect_layout(%(<div style="width:max-content;font:16px monospace;white-space:nowrap">#{inner}</div>))
      expect_layout(%(<div style="width:400px;display:flow-root"><div style="float:left;font:16px monospace;white-space:nowrap">#{inner}</div></div>))
      expect_layout(%(<div style="width:400px"><div style="writing-mode:vertical-lr;font:16px monospace;white-space:nowrap">#{inner}</div></div>))
      expect_layout(%(<div style="display:flex;width:400px"><div style="font:16px monospace;white-space:nowrap">#{inner}</div><div>x</div></div>))
      expect_layout(%(<div style="width:max-content;font:16px monospace">aaa <span style="white-space:pre-wrap">  </span></div>))
      expect_layout(%(<div style="width:max-content;font:16px monospace"><span style="white-space:pre-wrap">  </span> aaa bbb</div>))
    end
    # A mode change at DEPTH 2 is threaded the same way at every gate — the flow's and the intrinsic
    # predicate's — so a subtree that changes mode twice measures as well as it lays out.
    it 'threads a depth-2 mode change through the flow and the intrinsic measure alike' do
      inner = 'aa <span style="white-space:normal">bb <span style="white-space:pre-wrap">cc  dd</span></span> ee'
      expect_layout(%(<div style="width:120px;font:16px monospace">#{inner}</div>))
      expect_layout(%(<div style="width:120px;font:16px monospace;white-space:pre-line">#{inner}</div>))
      expect_layout(%(<div style="width:max-content;font:16px monospace">#{inner}</div>))
      expect_layout(%(<div style="width:400px;display:flow-root"><div style="float:left;font:16px monospace">#{inner}</div></div>))
      expect_layout(%(<div style="width:400px"><div style="writing-mode:vertical-lr;font:16px monospace">aa <span style="white-space:nowrap">bb <span style="white-space:pre">cc  dd</span></span> ee</div></div>))
    end
    # An opportunity belongs to what PRECEDES the box, not to the box: a space or a `<wbr>` from a wrapping run
    # opens the line before an atomic even inside a `nowrap` block, and a non-wrapping run's space closes it
    # even inside a wrapping one. One `barrier`, which every space overwrites — an atomic's and a `<wbr>`'s
    # included, and which a `<wbr>` then overwrites back. And a `pre` run's preserved spaces are CONTENT on
    # the line, never hanging off its end.
    it 'reads the opportunity before an atomic off what precedes it' do
      ib = 'display:inline-block;width:60px;height:9px'
      expect_layout(%(<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:normal">aaaa </span><span style="#{ib}"></span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="display:inline-block;width:20px;height:9px"></span> <span style="white-space:normal">bbbbbbbb</span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace;white-space:nowrap">aa<wbr> <span style="white-space:normal">bbbbbbbb</span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace;text-align:right;white-space:pre"><span style="display:inline-block;width:10px;height:9px"></span>a   <wbr><span style="white-space:normal">bbbbbbbbbb</span></div>))
      expect_layout(%(<div style="width:120px;font:16px monospace;text-align:right;white-space:nowrap"><span style="display:inline-block;width:10px;height:9px"></span>a<span style="white-space:pre-wrap">  </span><span style="white-space:pre"> </span><wbr><span style="white-space:normal">bbbbbbbbbbbb</span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre">aaaa </span><wbr><span style="#{ib}"></span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace;white-space:nowrap">aaaa <wbr><span style="#{ib}"></span></div>))
    end
    # A space that COLLAPSES AWAY against one already on the line decides nothing: it cannot take back the
    # opportunity the space before it gave. Source indentation between two inline elements is exactly this
    # shape, and a `nowrap` block's own newline between them was cancelling a wrapping inline's break.
    it 'lets a space that collapses away leave the opportunity alone' do
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:normal">aaaa </span><span style="white-space:nowrap"> </span><span style="white-space:normal">bbbbbbbb</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aa<em style="white-space:normal">xyz </em> <em style="white-space:normal">aaaaaaaa</em></div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:pre-line">aaaa </span><span style="white-space:nowrap"> </span><span style="white-space:normal">bbbbbbbb</span></div>')
    end
    # A run that does NOT soft-wrap is ONE unbreakable token: the line decides BEFORE it whether the whole of
    # it fits, never word by word (the collapsed run less a trailing collapsible space goes down in a single
    # placement). The unit is the run and never more — a token is per text NODE, so a `<b>` inside the span is a
    # second run with a second decision — and under a preserving mode it is the
    # first newline-SEGMENT, since a newline after it breaks the line regardless. This is
    # `<p>… <span class="text-nowrap">…</span> …</p>`, the commonest mixed-mode markup there is.
    it 'fits a non-wrapping inline as one unbreakable token' do
      expect_layout('<div style="width:80px;font:16px monospace">aaa <span style="white-space:nowrap">bbb ccc</span> ddd</div>')
      expect_layout('<div style="width:80px;font:16px monospace">aaa <span style="white-space:pre">b  c</span> ddd</div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre-line">aaa <span style="white-space:nowrap">bbb ccc</span></div>')
      # …the unit stops at the run boundary: a `<b>` inside the span decides for itself
      expect_layout('<div style="width:80px;font:16px monospace">aaa <span style="white-space:nowrap">bbb <b>cccccc</b></span> ddd</div>')
      # …a preserved newline ends the unit, and the segment after it starts a line of its own
      expect_layout(%(<div style="width:80px;font:16px monospace">aaa <span style="white-space:pre">bbbbbb
cc</span> ddd</div>))
      # …a LEADING one is inside it, unless the line is EMPTY or already ends in a real hanging space — and that
      # is asked BEFORE the break, so a space kept goes down with the unit on the fresh line. Each of these needs a
      # comparable box AFTER the span, or the 9.6px it is about moves no box.
      expect_layout('<div style="width:80px;font:16px monospace">aa-<span style="white-space:nowrap"> bbbbb</span><span style="display:inline-block;width:10px;height:9px"></span></div>')
      expect_layout('<div style="width:80px;font:16px monospace">aa <span style="white-space:nowrap"> bbbbb</span><span style="display:inline-block;width:10px;height:9px"></span></div>')
      expect_layout('<div style="width:100px;font:16px monospace">x <span style="display:inline-block;width:20px;height:10px"></span><span style="white-space:nowrap"> aaa bbb</span> zz</div>')
      expect_layout('<div style="width:160px;font:16px monospace"><div style="float:left;width:90px;height:60px"></div><div><span style="white-space:nowrap"> aaa bbb</span></div></div>')
      # …and the token ends at the text NODE, which the walk's run merge must not erase: two nodes either side of
      # a nested inline are two tokens with two decisions, and the same FONT on both is what hid it.
      expect_layout('<div style="width:80px;font:16px monospace">zz <span style="white-space:nowrap">pp <span style="white-space:nowrap">aa</span> qq</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace">zz <span style="white-space:pre">pp <span style="white-space:pre">aa</span> qq</span></div>')
      # …a body that is non-empty but zero-advance still asks the question
      expect_layout(%(<div style="width:80px;font:16px monospace">aaaaaaaaaa-<span style="white-space:nowrap">\u200B</span></div>))
      # …and a line too narrow for the whole unit DROPS below the float rather than overlapping it — after a
      # break the unit itself took, and for EVERY newline segment of a preserved run, not only the first
      expect_layout('<div style="overflow:hidden;width:150px;font:16px monospace"><div style="float:left;width:100px;height:40px"></div><div><span style="white-space:nowrap">aaa bbb</span></div></div>')
      expect_layout('<div style="width:120px;font:16px monospace"><div style="float:left;width:60px;height:60px"></div><div>xxxx <span style="white-space:nowrap">a bbbbbbbb</span></div></div>')
      expect_layout(%(<div style="width:100px;font:16px monospace"><div style="float:left;width:60px;height:60px"></div><div><span style="white-space:pre">a
bbbbbbbbbb</span></div></div>))
      # …and an ATOMIC asks the same question for its break AND its drop, which is one question
      expect_layout('<div style="width:120px;font:16px monospace"><div style="float:left;width:60px;height:60px"></div><div style="white-space:nowrap"><span style="display:inline-block;width:80px;height:20px"></span></div></div>')
      # …and it does NOT drop where a non-wrapping run's space left a hard barrier — which it does even at a
      # LINE START, where the space itself collapses away and only the barrier survives.
      expect_layout('<div style="width:150px;font:16px monospace"><div style="float:right;width:130px;height:10px"></div><div style="width:40px;white-space:nowrap"> <span style="display:inline-block;width:70px;height:6px"></span></div></div>')
      expect_layout('<div style="width:150px;font:16px monospace"><div style="float:left;width:56px;height:10px"></div><div style="width:40px;white-space:nowrap"> <span style="display:inline-block;width:70px;height:6px"></span></div></div>')
      # …and a leading space the unit KEPT is placed on the line the unit landed on, so it cannot make that
      # line look occupied before the float drop has been asked
      expect_layout('<div style="width:150px;font:16px monospace"><div style="float:left;width:70px;height:30px"></div><div style="width:120px">q-<span style="white-space:nowrap"> eeeeedddd</span></div></div>')
      # …the INTRINSIC route too, where a non-wrapping run inside a WRAPPING box is newly reachable
      expect_layout('<div style="width:min-content;font:16px monospace">aaa <span style="white-space:nowrap">bbb ccc</span> ddd</div>')
      expect_layout('<div style="width:400px;display:flow-root"><div style="float:left;font:16px monospace">aaa <span style="white-space:nowrap">bbb ccc</span> ddd</div></div>')
      # …and a trailing collapsible space hangs OUTSIDE the unit, so it is no part of what has to fit
      expect_layout('<div style="width:80px;font:16px monospace">aa <span style="white-space:nowrap">bbbbb </span>cc</div>')
      # …and an ATOMIC inside such an inline is not part of the token: its own `white-space` forbids breaks
      # INSIDE it, never the opportunity before it, so the BLOCK decides whether the line may break there.
      expect_layout('<div style="width:60px;font:16px monospace;text-indent:9px">aaa<span style="white-space:nowrap"><span style="display:inline-block;width:30px;height:9px"></span>bb</span> ddd</div>')
      expect_layout('<div style="width:60px;font:16px monospace;text-indent:9px">aaa<span style="white-space:pre"><span style="display:inline-block;width:30px;height:9px"></span>bb</span> ddd eee fff</div>')
      # …while a line that cannot break anyway decides nothing, whatever the inline says
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap">aaa <span style="white-space:pre">b  c</span> ddd</div>')
      expect_layout('<div style="width:80px;font:16px monospace;white-space:pre">aaa <span style="white-space:nowrap">bbb ccc</span></div>')
    end
    # …and at a LINE START the barrier is ALL that survives. The space it came from collapsed away, so it
    # carries no width and no line-box metrics of its own: a whitespace-only run in a font taller than the
    # line's would otherwise grow a line box with nothing of that height on it. It survives only as
    # far as the next run, too — a WRAPPING one replaces it with the ordinary opportunity its own leading space
    # queues, which is what still lets the line drop past a float.
    it 'leaves a line-start barrier that carries nothing, and lets a wrapping run replace it' do
      expect_layout('<div style="width:80px;font:16px monospace;white-space:nowrap"><span style="white-space:nowrap;font-size:40px"> </span><span style="white-space:pre"> b</span></div>')
      expect_layout('<div style="width:80px;font:16px monospace"><span style="white-space:nowrap;font-size:40px"> </span><span style="white-space:pre"> b</span></div>')
      expect_layout('<div style="width:150px;font:16px monospace"><div style="float:left;width:56px;height:10px"></div><div style="width:40px;white-space:nowrap"> <span style="white-space:normal"> </span><span style="display:inline-block;width:70px;height:6px"></span></div></div>')
      expect_layout('<div style="width:150px;font:16px monospace"><div style="float:left;width:56px;height:10px"></div><div style="width:40px"><span style="white-space:nowrap"> </span><span style="white-space:normal"> </span><span style="display:inline-block;width:70px;height:6px"></span></div></div>')
    end
  end

  # A TAB is the one character whose advance is not a width: it is the gap from where the pen stands to the
  # next stop, stops sitting every `tab-size` from the BLOCK's content edge. So every one of these asks the
  # same rule a different way — what precedes the tab on the line, which element's `tab-size` is read, and
  # what the block's space advance is worth — and each was measured in Chrome (`--headless --dump-dom`)
  # before it was written down, because a golden holding a tab stop Chrome does not have is the failure it
  # cannot catch by itself.
  describe 'a preserved tab advances to the next stop' do
    # Two things every shape here does. It puts an inline-BLOCK where the tab lands, never a bare `<span>`:
    # an inline box with no edges emitted no OPEN / CLOSE run and so had no native box at all, which meant
    # nothing compared where it sat (measured — with a bare span these examples passed with the half-space
    # rule deleted outright). And it gives that marker `id="m"`, so `expect_layout` can assert the CHROME number as
    # well as the golden: every stop rule here was read out of Chrome.
    it 'stops every tab-size from the block content edge, wherever the pen is' do
      # One 16px monospace space is 9.6, so the default 8 stops every 76.8 — and nine characters of text put
      # the pen past the first stop into the second.
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">aaaaaaaaa\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 153.609375)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 153.609375)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
    end
    # …and the stop is the TAB's own element's, resolved against the BLOCK's space: an inner `tab-size` wins
    # for the tabs inside it while the block still decides what one unit of it is worth — a 16px span's tab
    # in a 32px block stops every 8 x 19.2, and the block's letter-spacing is part of its space advance.
    it 'reads tab-size from the element the tab is in, counted in the block space' do
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:4">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 38.40625)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t<span style="tab-size:4">b\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 115.203125)
      # …and the same under `pre-wrap`, which is the mode that can MERGE two adjacent text nodes into one run
      # (a non-wrapping one never does). Two stops in one run would be one stop, so the stop pair is part of
      # what makes two runs the same — measured: without it in `same_font` this shape breaks.
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre-wrap">a\t<span style="tab-size:4">b\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 115.203125)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;letter-spacing:2px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 92.8125)
      expect_layout(%(<div style="width:400px;font:32px monospace;white-space:pre"><span style="font-size:16px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 153.609375)
    end
    # …and a `tab-size` that is neither a number nor a length is no `tab-size` at all: the property keeps its
    # initial 8, exactly as an undeclared one does. Read through `parseFloat` these were 2 (`2px 3px`), 4
    # (`4e`) and 0 (`auto`) — and a zero MEANS something now (the letter-spacing grid below), so an
    # unparseable value read as one is a wrong answer rather than a missing one.
    it 'keeps the initial 8 for a tab-size that does not parse' do
      # (`4.` and `20.px` among them: CSS tokenizes a trailing bare dot as a number plus a delim, so the
      # declaration is invalid — where `parseFloat` and a looser regex both read them as 4 and 20.)
      ['auto', 'normal', 'none', 'red', '2px 3px', '4e', '4.', '20.px', '4.e1'].each do |ts|
        expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:#{ts}">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
      end
      # …while the ones that DO parse keep their own answer, units and all
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:2em">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 32)
      # (a `px` length, whose stop width is the length itself — where a bare number would be 20 spaces)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:20px">aaa\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 40)
    end
    # …a LENGTH `tab-size` brings the half-space rule with it: a stop nearer than half the block's space is
    # skipped for the one after (Blink's `Font::TabWidth`).
    it 'skips a stop less than half a space away' do
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:20px">aa\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 40)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:20px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 20)
    end
    # …and a `tab-size` of 0 puts the stops a LETTER-SPACING apart instead of turning them off. With no
    # letter-spacing, a NEGATIVE one, or a `word-spacing` instead, there is no stop to reach and the tab
    # advances nothing — the marker sits at the pen. The layout read this as a flat letter-spacing advance
    # until 2026-09-16; the numbers below are the measurements that say otherwise.
    it 'puts the stops a letter-spacing apart at tab-size 0' do
      {'0.5px' => 11, '1px' => 12, '2px' => 14, '3px' => 18, '6px' => 24, '10px' => 30}.each do |ls, x|
        expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;letter-spacing:#{ls}">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), x)
      end
      {'letter-spacing:0' => 9.609375, 'letter-spacing:-1px' => 8.609375, 'letter-spacing:-3px' => 6.609375, 'word-spacing:5px' => 9.609375}.each do |none, x|
        expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;#{none}">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), x)
      end
      # …and it is the BLOCK's letter-spacing, like every other half of a tab stop. One on the INLINE the tab
      # sits in buys it no stop (9.61, the pen unmoved), and one on the block gives it stops the inline cannot
      # cancel (30) — while the pen still carries whatever spacing the runs before it had (16.61 / 24).
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0">a<span style="letter-spacing:10px">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 9.609375)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;letter-spacing:10px">a<span style="letter-spacing:0">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 30)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0"><span style="letter-spacing:7px">a</span><span style="letter-spacing:10px">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 16.609375)
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;tab-size:0;letter-spacing:4px"><span style="letter-spacing:7px">a</span><span style="letter-spacing:10px">\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></span></div>), 24)
    end
    # …and a tabbed run that overflows only breaks where the line MAY break: re-measured from the next line's
    # start, such a run used to move there with no opportunity to move it at.
    # The golden, not a Chrome number, and deliberately. The shapes as written ARE
    # Chrome's answer (it keeps the first on ONE line, div 80x22, the span at 38.41 overflowing), but a
    # comparable box cannot be added to read that off: an inline with no edges has no native box, and an
    # inline-BLOCK inside the span brings the recorded atomic-break divergence with it (Chrome keeps the
    # marker on line 1 at 86.42, native moves it to line 2 — `outer_wraps_gates_on_the_block`), which
    # would make this example about that instead.
    it 'breaks a tabbed run before it only where an opportunity stands' do
      expect_layout(%(<div style="width:80px;font:16px monospace">xxxx<span style="white-space:pre">a\tb</span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace">xxxx <span style="white-space:pre">a\tb</span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace">xxxx<wbr><span style="white-space:pre">a\tb</span></div>))
      expect_layout(%(<div style="width:80px;font:16px monospace">xxxx<span style="display:inline-block;width:10px;height:9px"></span><span style="white-space:pre">a\tb</span></div>))
    end
    # …and where that opportunity is a SOFT HYPHEN the break draws the hyphen, which is the difference between
    # `take_break!` and a plain forced one: the hyphen is 9.6px of the first line, and a centred line without
    # it sits 4.8 off. (Declined until 2026-09-26.)
    it 'draws the hyphen when the opportunity it breaks at is a soft one' do
      # (`%()`, never `'…'`: a single-quoted `\t` is a backslash and a `t`, and the whole tab branch is gated
      # on the run HOLDING one — measured, the shape without a real tab is satisfied by the ordinary
      # break path and passes with this fix reverted.)
      [['<span id="m" style="display:inline-block;width:10px;height:9px"></span>xx&shy;', %(<span style="white-space:pre">aaa\tbbb</span>), 30.59375],
       ['<span id="m" style="display:inline-block;width:10px;height:9px"></span>xx&shy;xx&shy;', %(<span style="white-space:pre">aaa\tbbb</span>), 20.984375],
       ['<span id="m" style="display:inline-block;width:10px;height:9px"></span>xx&shy;', %(<span style="padding-left:4px;white-space:pre">aaa\tbbb</span>), 30.59375]].each do |lead, tail, x|
        expect_layout(%(<div style="width:100px;font:16px monospace;text-align:center">#{lead}#{tail}</div>), x)
      end
    end
    # …and the pen a tab measures from is the BLOCK's content edge, which is what makes an INTRINSIC width
    # (Chrome: max-content 96.015625 for `a\tbb`, min-content 19.203125) and a line inside a float band come
    # out right — the band and the indent move the PEN, the stops stay where the block put them.
    it 'measures from the content edge through an intrinsic width, an indent and a float band' do
      expect_layout(%(<div style="width:max-content;font:16px monospace;white-space:pre">a\tbb</div>))
      expect_layout(%(<div style="width:min-content;font:16px monospace;white-space:pre-wrap">aa\tbb cc</div>))
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre;text-indent:20px">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div>), 76.8125)
      expect_layout(%(<div style="width:400px;font:16px monospace"><div style="float:left;width:50px;height:40px"></div><div style="white-space:pre">a\t<span id="m" style="display:inline-block;width:10px;height:9px"></span></div></div>), 76.8125)
      # …and the band moving AFTER the run was measured is the same question asked late: `drop_below_floats!` drops an
      # empty line below a float, and a tabbed run measured at the old band came out 90 where Chrome says
      # 86.42 (stops from the content edge, reached from the line's own start).
      expect_layout(%(<div style="width:200px;font:16px monospace"><div style="float:left;width:150px;height:30px"></div><div><span style="white-space:pre">a\tb</span><span id="m" style="display:inline-block;width:10px;height:9px"></span></div></div>), 86.421875)
    end
    # …and it is a placement like any other: it carries the line box it lands on, ends the preserved hang
    # before it, and a `pre-wrap` line may wrap after it.
    it 'places like a preserved space on the line it lands on' do
      expect_layout(%(<div style="width:120px;font:16px monospace;white-space:pre-wrap">aa\tbbbb cccc dddd</div>))
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">a\t<span style="display:inline-block;width:10px;height:40px"></span></div>))
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre-wrap">aa \t<span style="display:inline-block;width:10px;height:9px"></span></div>))
      expect_layout(%(<div style="width:400px;font:16px monospace;white-space:pre">a\tb\ncc\t<span style="display:inline-block;width:10px;height:9px"></span></div>))
    end
  end

end

RSpec.describe 'native text unicode classes' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font:16px monospace">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # The classes native answers `\p{L}` / `\p{N}` / `\p{M}` from come from regex-syntax — the regex itself,
  # parsed rather than reimplemented (`unicode.rs`). But regex-syntax bakes in a UCD snapshot of
  # its own and the engine has another, on separate release trains (Ruby's and Rust std's are two more: rustc
  # 1.98 calls 4662 code points letters that this V8 does not, and answering from IT moved boxes). So ask the
  # engine for the whole class and compare every range: an upgrade of either side reds this instead of drifting
  # silently. One crossing of the code space costs ~0.02s — and sampling the boundaries was actively wrong
  # here, because probes taken from the table under test vanish with the range they came from (the old check
  # missed a DELETED range 60% of the time: `\p{L}` could lose `A-Z` and stay green).
  describe 'the Unicode classes native\'s regexes match' do
    UnicodeClasses::CLASSES.each do |klass|
      it "answers \\p{#{klass}} the way V8 does" do
        require 'capybara/simulated/v8_runtime'   # …which is what defines the module below
        engine = with_simulated_session(page('<div>x</div>')) {|s|
          s.visit '/'
          UnicodeClasses.ranges_of(s, klass)
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
            \\p{#{klass}} differs between regex-syntax and the V8 engine
            (#{native.size} ranges vs #{engine.size}), first at index #{at}:
              regex-syntax: #{hex.call(native[at, 3].to_a)}
              V8:           #{hex.call(engine[at, 3].to_a)}
              only regex-syntax has: #{hex.call((native - engine).first(5))}
              only V8 has: #{hex.call((engine - native).first(5))}
            If the ENGINE carries the extra ranges it moved to a newer Unicode first, and there is no local
            fix: native lays those code points out differently from V8's own regex until regex-syntax ships a
            matching snapshot. If REGEX-SYNTAX carries them, a `cargo update` moved it — revert Cargo.lock.
          MSG
        }
      end
    end
  end
end
