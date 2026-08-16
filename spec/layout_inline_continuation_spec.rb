# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Inline continuation. A `display: inline` box is not a rectangle waiting to be filled:
# the line breaks INSIDE it, and what a browser reports for it is the union of the
# pieces it broke into. Before this it was laid out as one box on one line — so a
# `<span>` wrapping a paragraph of text measured one line tall, its text never wrapped,
# and the block around it came out at HALF Chrome's height. Since a paragraph's markup
# is `<p>…<a>…</a>…</p>`, that was most real text on a page.
#
# Every expectation is Chrome 137-measured (headless, 1024x768) and written as a formula
# over widths measured in the page itself, so it holds whatever face fontconfig serves.
# One thing here is NOT modelled: baseline alignment. Chrome sits an inline box's
# fragment on the line's baseline (its `<span>` around a 60px image starts 46px down the
# line); ours sits at the line's top. The SIZES below are Chrome's; that offset is not.
RSpec.describe 'inline continuation' do
  include LayoutMeasure

  # The headline case: the line breaks inside the `<span>`, and both the span and the
  # block around it are two lines tall rather than one.
  it 'wraps the text inside an inline box and reports the union of its fragments' do
    text = 'wrap wrap wrap wrap'
    body = %(<div id="d" style="width:100px"><span id="s">#{text}</span></div>) \
           '<div id="one"><span id="frag">x</span></div>'
    boxes, w, line = measure(body, ['#d', '#s', '#frag'], probes: ['wrap wrap', 'wrap wrap wrap'])
    d, s, frag = boxes
    expect(w['wrap wrap']).to be <= 100                # …so two words share a line
    expect(w['wrap wrap wrap']).to be > 100            # …and the third starts the next
    expect(d[3]).to eq(line * 2)                       # Chrome: the block is 36 tall
    # A fragment is as tall as the font's CONTENT box, which is SHORTER than the line
    # box the gap makes: the union of two of them is one line plus one fragment.
    expect(s[3]).to eq(line + frag[3])                 # Chrome: 35, of an 18px line
    expect(s[2]).to be_within(0.05).of(w['wrap wrap']) # the widest fragment
  end

  # …and its TOP edge is the first line its content REACHED, not the line it opened on. A
  # box that opens at the end of a line whose remaining room is too small for its first word
  # has its whole content on the next one, and Chrome reports only that line.
  it 'starts at the first line its content reached, not the one it opened on' do
    body = '<div id="d" style="width:100px">wrap wrap <span id="s">wrapwrap</span></div>' \
           '<div id="one"><span id="frag">x</span></div>'
    boxes, w, line = measure(body, ['#s', '#frag'], probes: ['wrap wrap', 'wrap wrap wrapwrap'])
    s, frag = boxes
    expect(w['wrap wrap']).to be <= 100                # the span opens at the end of line 1…
    expect(w['wrap wrap wrapwrap']).to be > 100        # …and none of it fits there
    expect(s[1]).to eq(line)                           # Chrome: [0, 18, 69.36, 17]
    expect(s[3]).to eq(frag[3])
  end

  # The width above is the fix for the space AT the break: it advances the line like any
  # other, but a break eats it, so it is not part of what the box covers. Counting it made
  # every wrapped inline exactly one space too wide.
  it 'ends a fragment at the last glyph, not at the space that broke the line' do
    body = '<div id="d" style="width:100px"><span id="s">wrap wrap wrap</span></div>'
    boxes, w = measure(body, ['#s'], probes: ['wrap wrap', 'wrap wrap '])
    expect(w['wrap wrap ']).to be > w['wrap wrap']
    expect(boxes[0][2]).to be_within(0.05).of(w['wrap wrap'])
  end

  # …but only a BREAK eats it. A space that ends the box with content still to come on the
  # same line is ordinary content, and the box covers it.
  it 'keeps a trailing space that content on the same line followed' do
    body = '<div id="d" style="width:300px"><span id="s">aaa </span>bbb</div>'
    boxes, w = measure(body, ['#s'], probes: ['aaa', 'aaa '])
    expect(boxes[0][2]).to be_within(0.05).of(w['aaa '])   # Chrome: 31.14, not 26.7
  end

  # A box that OPENS mid-line reaches the left edge on every line after the first, so its
  # rect starts at the block's content edge — left of where the box itself began.
  it 'starts at the left edge once its content has wrapped past the first line' do
    body = '<div id="d" style="width:100px">lead <span id="s">wrap wrap wrap</span></div>'
    boxes, w, line = measure(body, ['#s'], probes: ['lead '])
    s = boxes[0]
    expect(w['lead ']).to be > 0                       # the span starts here on line 1…
    expect(s[0]).to eq(0)                              # …and at 0 on line 2. Chrome: x = 0
    expect(s[1]).to eq(0)                              # its first fragment is on line 1
    expect(s[3]).to be > line                          # …and it spans both
  end

  # Nested inlines each fragment on their own: the inner one is not swallowed by the outer.
  it 'fragments a nested inline box independently of the one around it' do
    body = '<div id="d" style="width:100px"><span id="o">wrap <span id="i">wrap wrap</span></span></div>'
    boxes, w, line = measure(body, ['#o', '#i'], probes: ['wrap wrap'])
    o, i = boxes
    # Chrome: both are [0, 0, 73.81, 35] — the inner one opens on line 1 after "wrap " and
    # finishes line 2, so its union reaches the left edge too.
    expect(o[2]).to be_within(0.05).of(w['wrap wrap'])
    expect(i[2]).to be_within(0.05).of(w['wrap wrap'])
    expect(i[0]).to eq(0)
    expect([o[3], i[3]]).to all(be > line)
  end

  # A `<br>` inside an inline box breaks the line it is on, which is the box's own line.
  it 'breaks the line at a <br> inside an inline box' do
    body = '<div id="d" style="width:200px"><span id="s">one<br>two</span></div>'
    boxes, w, line = measure(body, ['#d', '#s'], probes: %w[one two])
    d, s = boxes
    expect(d[3]).to eq(line * 2)                       # Chrome: 36
    expect(s[2]).to be_within(0.05).of([w['one'], w['two']].max)
  end

  # Padding and border grow an inline box's BORDER box without growing the line it sits
  # on: it overflows the line rather than stretching it.
  it 'overflows its line with padding rather than stretching it' do
    body = '<div id="d" style="width:200px"><span id="s" style="padding:5px">pad</span></div>' \
           '<div id="one"><span id="frag">pad</span></div>'
    boxes, w, line = measure(body, ['#d', '#s', '#frag'], probes: ['pad'])
    d, s, frag = boxes
    expect(d[3]).to eq(line)                           # Chrome: still one 18px line
    expect(s[1]).to eq(d[1] - 5)                       # …which the box starts 5px above
    expect(s[3]).to eq(frag[3] + 10)                   # Chrome: 27
    expect(s[2]).to be_within(0.05).of(w['pad'] + 10)
  end

  # An inline box holding an ATOMIC one is still as tall as its own font — only the LINE
  # grows to the thing on it. (The box we used to report covered the image, which put a
  # `<span>`-wrapped image in an editor 43px taller than Chrome's.)
  it 'is as tall as its font around an atomic box, and lets the line take the height' do
    body = '<div id="d" style="width:200px"><span id="s">' \
           '<span style="display:inline-block;width:20px;height:60px"></span></span></div>' \
           '<div id="one"><span id="frag">x</span></div>'
    boxes, = measure(body, ['#d', '#s', '#frag'])
    d, s, frag = boxes
    expect(d[3]).to eq(60)                             # Chrome: the line is the image's
    expect(s[3]).to eq(frag[3])                        # Chrome: 17, the font's content box
    expect(s[2]).to eq(20)
  end

  # `position: relative` moves the box AND its content, without moving anything else on
  # the line. The content is placed BEFORE the offset can be applied to it, so it has to
  # be carried over afterwards — laying the box out as one rectangle used to do that for
  # free, by laying its children out inside the shifted box.
  it 'carries its relative offset onto the content it has already placed' do
    body = '<div id="d" style="width:300px">before ' \
           '<span id="s" style="position:relative;left:20px;top:5px">shifted <b id="b">bold</b></span> after</div>'
    boxes, w = measure(body, ['#s', '#b'], probes: ['before ', 'shifted '])
    s, b = boxes
    expect(s[0]).to be_within(0.05).of(w['before '] + 20)   # Chrome: 69.8
    expect(s[1]).to eq(5)
    expect(b[0]).to be_within(0.05).of(s[0] + w['shifted '])  # Chrome: 121.4, moved WITH it
    expect(b[1]).to eq(5)
  end

  # The union is what the box REPORTS, but not what it covers: the end of the line it opened
  # on and the start of the line it finished on belong to whatever else is there. A browser
  # hit-tests the PIECES, and reports one client rect per piece.
  it 'hit-tests its fragments rather than their union' do
    body = '<div id="d" style="width:320px"><a id="first" href="#">Dashboard</a> ' \
           '<a id="second" href="#">Settings and preferences for the account</a></div>'
    boxes, _w, _line, session = measure(body, ['#first', '#second'])
    first, second = boxes
    expect(second[0]).to eq(0)                         # the union reaches back over `first`…
    expect(second[1]).to eq(first[1])
    x, y = first[0] + first[2] / 2, first[1] + first[3] / 2
    expect(session.evaluate_script("(document.elementFromPoint(#{x}, #{y}) || {}).id")).to eq('first')
  end

  it 'reports one client rect per line it broke over' do
    body = '<div id="d" style="width:300px">start <a id="s" href="#">a link long enough to wrap ' \
           'onto a second line here</a> tail</div>'
    _boxes, _w, _line, session = measure(body, ['#s'])
    m = JSON.parse(session.evaluate_script(<<~JS))
      (function () {
        var el = document.querySelector('#s');
        return JSON.stringify({
          rects: [].map.call(el.getClientRects(), function (r) { return [r.x, r.y]; }),
          offsetLeft: el.offsetLeft
        });
      })()
    JS
    expect(m['rects'].size).to eq(2)                   # Chrome: 2 rects, offsetLeft 36
    expect(m['rects'][0][1]).to be < m['rects'][1][1]
    # …measured from the FIRST piece, and rounded to an integer the way `offset*` is (Chrome
    # reports 36 for a rect that starts at 35.5625).
    expect(m['offsetLeft']).to be_within(0.5).of(m['rects'][0][0])
  end

  # The pieces are also what a POINTER aims at. WebDriver measures its in-view centre point on
  # the element's FIRST client rect, and for a link that wrapped, the centre of its BOUNDING box
  # is the paragraph text between its two lines — a click there gives page script coordinates
  # that hit-test to the paragraph.
  it 'aims a click at the first fragment rather than at the middle of the union' do
    body = '<div id="d" style="width:420px">Lorem ipsum dolor sit ' \
           '<a id="a" href="#">a link that is long enough to wrap over two lines here</a> tail.</div>'
    _boxes, _w, _line, session = measure(body, ['#a'])
    session.execute_script(<<~JS)
      window.__hit = null;
      document.addEventListener('click', function (e) {
        var el = document.elementFromPoint(e.clientX, e.clientY);
        window.__hit = el ? el.id || el.tagName : null;
      }, true);
    JS
    session.find(:css, '#a').click
    expect(session.evaluate_script('window.__hit')).to eq('a')
  end

  # …and nothing at all once the element stops being rendered. A fragmented inline never goes
  # through the box path, so the pieces it left behind have to be gated on the way out — a page
  # that probes `getClientRects().length` (jQuery `:visible`) would otherwise read a hidden
  # panel's links as visible.
  it 'has no client rects once it is no longer rendered' do
    body = '<div id="d" style="width:200px">Hi <a id="a" href="#">a link that also wraps across two lines</a></div>'
    _boxes, _w, _line, session = measure(body, ['#a'])
    expect(session.evaluate_script("document.querySelector('#a').getClientRects().length")).to eq(2)
    session.execute_script("document.querySelector('#d').style.display = 'none'")
    expect(session.evaluate_script("document.querySelector('#a').getClientRects().length")).to eq(0)
    expect(session.evaluate_script("document.querySelector('#a').offsetLeft")).to eq(0)
  end

  # White space collapses across the whole inline formatting context, not per text node: the
  # space before a `<span>` and one at the start of its text are ONE space. Pretty-printed markup
  # produces that pair on every indented line.
  it 'collapses a space against one already on the line' do
    body = '<div id="d" style="width:400px">Hello <span id="s"> world</span></div>'
    boxes, w = measure(body, ['#s'], probes: ['world'])
    expect(boxes[0][2]).to be_within(0.05).of(w['world'])   # Chrome: 38.23, not 42.68
  end

  # CSS 2.1 §10.1: the containing block a fragmented inline establishes runs from its FIRST
  # piece, so a dropdown hung off a link that wraps opens under where the link starts — not at
  # the union's left edge, which is the block's own.
  it 'establishes a containing block from its first fragment' do
    body = '<div id="d" style="width:400px">a <span id="s" style="position:relative">' \
           'a relative span whose text wraps over two lines of its own' \
           '<i id="tip" style="position:absolute;top:100%;left:0;width:20px;height:8px"></i></span></div>'
    boxes, w = measure(body, ['#s', '#tip'], probes: ['a '])
    s, tip = boxes
    expect(s[0]).to eq(0)                              # the union starts at the block's edge…
    expect(tip[0]).to be_within(0.05).of(w['a '])      # …the containing block at the first piece
    expect(tip[1]).to eq(s[1] + s[3])                  # `top: 100%` of that box. Chrome: 71
  end

  # An inline box with nothing in it generates no line box at all — Chrome reports an
  # empty rect for it and gives the block around it a height of 0.
  it 'generates no line box for an empty inline' do
    boxes, = measure('<div id="d"><span id="s"></span></div>', ['#d', '#s'])
    expect(boxes[0][3]).to eq(0)
    expect(boxes[1][2, 2]).to eq([0, 0])
  end

  # …but one that SHARES a line with content sits on that line box, zero-wide and as tall as
  # the font. `<span class="icon"></span>label` is everywhere, and a page that probes it with
  # `getClientRects().length` (jQuery's `:visible`) must not read it as absent.
  it 'gives an empty inline a fragment on a line that exists' do
    body = '<div id="d"><span id="s"></span>label</div><div id="one"><span id="frag">x</span></div>'
    boxes, = measure(body, ['#s', '#frag'])
    s, frag = boxes
    expect(s[2]).to eq(0)                              # Chrome: [0, 0, 0, 17], one client rect
    expect(s[3]).to eq(frag[3])
  end

  # `white-space: nowrap` forbids breaking INSIDE a run, not the break opportunity BEFORE it.
  # Laid out as one atomic box this came for free; placed as text it has to be kept.
  it 'moves an unbreakable inline to the next line whole' do
    body = '<div id="d" style="width:100px">a <span id="s" style="white-space:nowrap">wrap wrap wrap</span></div>'
    boxes, w, line = measure(body, ['#d', '#s'], probes: ['wrap wrap wrap'])
    d, s = boxes
    expect(w['wrap wrap wrap']).to be > 100            # it fits on no line…
    expect(d[3]).to eq(line * 2)                       # …so it takes one of its own. Chrome: 36
    expect(s[0]).to eq(0)
    expect(s[1]).to eq(line)
    expect(s[2]).to be_within(0.05).of(w['wrap wrap wrap'])  # …and overflows it, unbroken
  end

  # An out-of-flow box inside an inline is positioned against that inline once it HAS a box —
  # and from where it would have sat in flow, which mid-line is the line cursor. Placed during
  # the walk it found no box on its containing block at all, and answered from the viewport.
  it 'positions an absolute child against the inline box around it' do
    body = '<div id="d" style="width:400px">stat <span id="s" style="position:relative">anch' \
           '<span id="a" style="position:absolute;width:10px;height:10px"></span></span></div>'
    boxes, w = measure(body, ['#s', '#a'], probes: ['stat ', 'anch'])
    s, a = boxes
    expect(s[0]).to be_within(0.05).of(w['stat '])
    expect(a[0]).to be_within(0.05).of(w['stat '] + w['anch'])   # Chrome: 64.94
    expect(a[1]).to eq(s[1])
  end

  # An `inline-block` is ATOMIC: it takes one rectangle on one line whatever its content
  # does inside it, which is the line that continuation must not be applied to.
  it 'keeps an atomic inline-block on one line' do
    body = '<div id="d" style="width:200px">lead ' \
           '<span id="s" style="display:inline-block;width:80px">wrap wrap wrap</span></div>'
    boxes, w, line = measure(body, ['#s'], probes: ['lead '])
    s = boxes[0]
    expect(s[0]).to be_within(0.05).of(w['lead '])     # it stays where it was placed…
    expect(s[2]).to eq(80)                             # …at its own declared width…
    expect(s[3]).to be > line                          # …and wraps INSIDE itself
  end
end
