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
    boxes, _text, line = measure(body, ['#d', '#s', '#frag'])
    d, s, frag = boxes
    # The box hangs from the line's baseline — an empty `inline-block`'s own baseline is its bottom
    # edge — so the fragment around it sits its own ascent above that, and the line is the box's 60
    # plus what the strut still leaves below the baseline. (Re-measured in Chrome 151 when the line
    # box learnt where its baseline is: 64 and a fragment at 46, where this example was written
    # with 60 and a fragment at 0.)
    ascent = 60 - s[1]
    expect(d[3]).to eq(60 + (line - ascent))
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

  # An inline box's own padding, border and margin advance the line without being TEXT, so they
  # take no part in white-space collapsing either — and an unbreakable run placed whole still
  # ends the line in a space when it ends in one.
  it 'collapses across an inline box that contributes edges rather than text' do
    body = '<div style="width:400px"><span id="nw" style="white-space:nowrap">Hello </span> world</div>' \
           '<div style="width:400px">Hello <b id="pb" style="padding-left:5px"></b> world</div>' \
           '<div style="width:400px"><span id="plain">Hello </span> world</div>'
    boxes, w = measure(body, ['#nw', '#pb', '#plain'], probes: ['Hello world', 'Hello '])
    nw, pb, plain = boxes
    expect(nw[2]).to be_within(0.05).of(w['Hello '])
    # An edge is not content, so it does not rescue a space the break is about to eat either.
    expect(plain[2]).to be_within(0.05).of(w['Hello '])
    # One space between the two words on every line, whatever sits between them.
    expect(pb[0] + pb[2] + (w['Hello world'] - w['Hello '])).to be_within(0.05).of(w['Hello world'] + 5)
  end

  # A PRESERVED trailing space is not collapsible, so it collapses with nothing: the space
  # after a `white-space: pre` box survives (CSS Text 3 §4.1.1).
  it 'does not collapse a space against a preserved one' do
    body = '<div id="d" style="width:400px">A<span style="white-space:pre">a </span>' \
           '<span id="s"> b</span>Z</div>'
    boxes, w = measure(body, ['#s'], probes: [' b'])
    expect(boxes[0][2]).to be_within(0.05).of(w[' b'])   # Chrome: 13.34, the space kept
  end

  # An inline whose only content is a space the break then ate keeps a fragment on the line it
  # reached — the line box is there, it is just empty.
  it 'keeps a zero-width fragment on the line a break emptied' do
    body = '<div id="d" style="width:120px">Hello<span id="s"> </span>wwwwwwwwwwwwwwwwwwww</div>' \
           '<div id="one"><span id="frag">x</span></div>'
    boxes, = measure(body, ['#s', '#frag'])
    s, frag = boxes
    expect(s[2]).to eq(0)                              # Chrome: [36.47, 0, 0, 17]
    expect(s[3]).to eq(frag[3])
  end

  # The pointer is aimed at the element's first rect CLIPPED to the viewport, which is only an
  # answer once the element is in it: WebDriver scrolls first and measures after. Measuring first
  # clipped an off-screen rect down to nothing and aimed the click at the viewport's corner — a
  # link below the fold then took a click its own handler never saw.
  it 'aims a click at an element that is out of view after scrolling it in' do
    body = '<div style="height:2000px"></div>' \
           '<div id="d" style="width:420px">Lorem ipsum dolor sit ' \
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

  # An out-of-flow box waits for the inline around it to have geometry — and the wait belongs
  # to the BLOCK that opened that inline, not to whichever block finishes first. A sibling laid
  # out in between used to release it early, against a containing block that still had none.
  it 'holds an absolute child until the inline that contains it has settled, whatever follows' do
    body = '<nav id="d"><span id="s" style="position:relative">Menu' \
           '<div id="a" style="position:absolute;top:100%;left:0;width:120px;height:40px">item</div></span>' \
           '<div id="after">rest of page</div></nav>'
    boxes, = measure(body, ['#s', '#a', '#after'])
    s, a, after = boxes
    expect(a[1]).to eq(s[1] + s[3])                    # Chrome: 17, `top: 100%` of the span
    expect(after[1]).to be > a[1]                      # …and the sibling block is unaffected
  end

  # It also keeps the paint order it had in the tree: laying it out last would put it above the
  # boxes that follow it, and the topmost box is what a click lands on.
  it 'keeps a deferred absolute child below the boxes that follow it' do
    body = '<div id="d" style="position:relative"><span>t' \
           '<b id="first" style="position:absolute;left:0;top:0;width:100px;height:100px"></b></span>' \
           '<i id="second" style="position:absolute;left:0;top:0;width:100px;height:100px"></i></div>'
    boxes, _w, _line, session = measure(body, ['#second'])
    x, y = boxes[0][0] + 50, boxes[0][1] + 50
    expect(session.evaluate_script("(document.elementFromPoint(#{x}, #{y}) || {}).id")).to eq('second')
  end

  # A line whose only content was a space the break ate leaves no fragment behind. Written
  # across source lines — the way markup is formatted — the box would otherwise report an empty
  # rect parked at the end of the line above, and a union that spans both.
  it 'leaves no fragment on a line the break emptied' do
    body = %(<div id="d" style="width:300px"><i style="display:inline-block;width:280px"></i>) +
           %(<a id="s" href="#">
  wordone wordtwo
</a></div>)
    boxes, w, _line, session = measure(body, ['#s'], probes: ['wordone wordtwo'])
    expect(session.evaluate_script("document.querySelector('#s').getClientRects().length")).to eq(1)
    expect(boxes[0][2]).to be_within(0.05).of(w['wordone wordtwo'])   # Chrome: 125.41, one line
  end

  # …and its whole SUBTREE keeps that slot. Numbering only the box left its children painting
  # above the boxes that follow it, so a click on one of those landed inside the dropdown.
  # (…including when it holds a positioned element of its own, which is every real dropdown: the
  # paint chain compares where each positioned box sits, not just how deep it is.)
  it 'keeps the content of a deferred absolute child below those boxes too' do
    body = '<div id="d" style="width:400px;position:relative">Menu<span>x' \
           '<div id="first" style="position:absolute;left:50px;top:50px;width:200px;height:100px">' \
           '<div style="position:relative;height:100px"></div></div></span>' \
           '<div id="second" style="position:absolute;left:100px;top:80px;width:200px;height:100px"></div></div>'
    _boxes, _w, _line, session = measure(body, ['#second'])
    expect(session.evaluate_script('(document.elementFromPoint(150, 120) || {}).id')).to eq('second')
  end

  # A percentage inset resolves against the containing block's USED size, which an auto-height
  # box only knows once its own content is laid out. Placed during the child loop, the dropdown
  # every nav bar has resolved `top: 100%` against 0 and opened ON its trigger.
  it 'resolves a percentage inset against a containing block that back-filled its height' do
    body = '<div id="d"><span id="s" style="display:inline-block;position:relative">Menu' \
           '<div id="dd" style="position:absolute;top:100%;left:0;width:150px">Dashboard</div></span></div>'
    boxes, w = measure(body, ['#s', '#dd'], probes: ['Menu'])
    s, dd = boxes
    expect(dd[1]).to eq(s[1] + s[3])                   # Chrome: 18, under the trigger
    # …and the trigger is as wide as its own word: an out-of-flow box is not part of what its
    # parent wraps (counting the menu made the nav item 200px too wide).
    expect(s[2]).to be_within(0.05).of(w['Menu'])
  end

  # A box's own edges open it on the line its CONTENT starts on. Placed when the box opens —
  # before its first word is measured — the opening edge was stranded on the line above when
  # that word didn't fit, fabricating a fragment there: the union then spanned both lines and
  # its centre, which is where a click is aimed, fell in the gap between them.
  it 'carries its opening edge down to the line its content starts on' do
    body = '<div id="d" style="width:100px">wrap wrap <a id="pad" href="#" style="padding:0 5px">wrapwrap</a></div>' \
           '<div id="e" style="width:100px">wrap wrap <a id="mar" href="#" style="margin-left:5px">wrapwrap</a></div>' \
           '<div id="one"><span id="frag">x</span></div>'
    boxes, w, line, session = measure(body, ['#pad', '#mar', '#frag'], probes: ['wrapwrap'])
    pad, mar, frag = boxes
    expect(pad[1]).to eq(line)                         # Chrome: [0, 18, 79.36, 17] — ONE line
    expect(pad[3]).to eq(frag[3])
    expect(pad[2]).to be_within(0.05).of(w['wrapwrap'] + 10)
    expect(mar[0]).to eq(5)                            # …and a margin comes down with it
    expect(session.evaluate_script("document.querySelector('#pad').getClientRects().length")).to eq(1)
    x, y = pad[0] + pad[2] / 2, pad[1] + pad[3] / 2
    expect(session.evaluate_script("(document.elementFromPoint(#{x}, #{y}) || {}).id")).to eq('pad')
  end

  # A box the page declared as `height: 0` is not one whose height is still to be filled — an
  # absolute child of it resolves `top: 100%` against 0, and the box itself stays 0.
  it 'does not wait on a containing block that declared a zero height' do
    body = '<div id="d" style="position:relative;height:0;width:300px">Hello content' \
           '<div id="a" style="position:absolute;top:100%;left:0;width:50px;height:20px"></div></div>'
    boxes, = measure(body, ['#d', '#a'])
    d, a = boxes
    expect(d[3]).to eq(0)                              # Chrome: the declared height stands
    expect(a[1]).to eq(d[1])                           # …so `top: 100%` is 0
  end

  # A box held back for its containing block is still part of what that block wraps: a tall
  # dropdown extends the document's scroll range, which is what `scroll_to` and in-view checks
  # read.
  it 'counts a deferred absolute child in the scroll extent of what it waited for' do
    body = '<nav id="d" style="position:relative;width:200px">Menu<span>x' \
           '<div id="a" style="position:absolute;top:100%;left:0;width:400px;height:2000px"></div></span></nav>'
    _boxes, _w, _line, session = measure(body, ['#d'])
    expect(session.evaluate_script("document.querySelector('#d').scrollHeight")).to eq(2018)
    expect(session.evaluate_script('document.documentElement.scrollHeight')).to be >= 2018
  end

  # …because it is not placed until then. A `<br>` or a preserved newline is a break opportunity
  # AFTER the edge, so the fragment it opened stays where it is; an overflow break has nothing to
  # break at, and the edge goes down with the content it was waiting for.
  it 'places an opening edge only where its content lands' do
    body = '<div id="a" style="width:100px">wrap wrap ' \
           '<span id="out" style="padding-left:10px"><span id="in" style="padding-left:20px">wrapwrap</span></span></div>' \
           '<div id="b" style="width:200px">a<span id="br" style="padding-left:20px"><br>b</span></div>' \
           '<div id="c" style="width:60px"><span style="padding-left:10px">aaaaaaaaaa</span></div><div id="after">x</div>'
    boxes, w, line, session = measure(body, ['#out', '#in', '#br', '#c', '#after'], probes: ['wrapwrap'])
    out, inn, br, c, after = boxes
    expect(out[0]).to eq(0)                            # Chrome: [0, 18, 99.36, 17]
    expect(inn[0]).to eq(10)                           # …and the inner box after its own padding
    expect(out[2]).to be_within(0.05).of(w['wrapwrap'] + 30)
    expect(inn[2]).to be_within(0.05).of(w['wrapwrap'] + 20)
    expect(session.evaluate_script("document.querySelector('#br').getClientRects().length")).to eq(2)
    # A padded box at the START of a line has nothing to break at, so its own padding must not
    # break the line and leave an empty one behind.
    expect(c[3]).to eq(line)                           # Chrome: 18, not 35
    expect(after[1]).to eq(c[1] + c[3])
  end

  # A `z-index` inside a positioned box that has none of its own competes at the level ABOVE it:
  # `position: relative` alone does not establish a stacking context. One that DOES clamps its
  # content to its own level, `z-index: 0` and `auto` paint in the same layer (tree order decides),
  # and a negative z-index puts content behind its own ancestor.
  it 'paints by stacking context rather than by depth' do
    body = '<div id="z1" style="position:relative;height:60px">' \
           '<div style="position:absolute;left:0;top:0;z-index:0;width:200px;height:60px">' \
           '<div id="inside" style="width:200px;height:60px"></div></div>' \
           '<div id="over" style="position:absolute;left:0;top:0;width:200px;height:60px"></div></div>' \
           '<div id="z2" style="position:relative;height:60px">' \
           '<div id="first" style="position:absolute;left:0;top:0;width:200px;height:60px"></div>' \
           '<div id="last" style="position:absolute;left:0;top:0;z-index:0;width:200px;height:60px"></div></div>' \
           '<div id="z3" style="position:relative;height:60px"><div id="par" style="width:200px;height:60px">' \
           '<div style="position:relative;z-index:-1;width:200px;height:60px"></div></div></div>'
    boxes, _w, _line, session = measure(body, ['#z1', '#z2', '#z3'])
    hit = ->(box) { session.evaluate_script("(document.elementFromPoint(#{box[0] + 100}, #{box[1] + 30}) || {}).id") }
    expect(hit[boxes[0]]).to eq('over')                # a z-index:0 context does not lift its content
    expect(hit[boxes[1]]).to eq('last')                # z-index:0 and auto are one layer, in order
    expect(hit[boxes[2]]).to eq('par')                 # …and a negative one goes behind its parent
  end

  it 'lets a z-index escape a positioned box that establishes no stacking context' do
    body = '<div id="d" style="position:relative">' \
           '<div id="first" style="position:absolute;left:0;top:0;width:300px;height:120px">' \
           '<div id="inner" style="position:relative;z-index:10;height:40px"></div></div>' \
           '<div id="second" style="position:absolute;left:0;top:0;width:300px;height:200px"></div></div>'
    boxes, _w, _line, session = measure(body, ['#second'])
    x, y = boxes[0][0] + 100, boxes[0][1] + 20
    expect(session.evaluate_script("(document.elementFromPoint(#{x}, #{y}) || {}).id")).to eq('inner')
  end

  # An edge waiting to be placed takes no line height with it either: the line it did not open on
  # keeps the block's own, whatever the box's font size.
  it 'leaves the line it did not open on at the block line height' do
    body = '<div id="d" style="width:100px">word <span id="s" style="font-size:40px;padding-left:20px">bbbb</span></div>'
    boxes, _w, line = measure(body, ['#d', '#s'])
    d, s = boxes
    expect(s[1]).to eq(line)                           # Chrome: div 63, span y 18
    expect(d[3]).to eq(line + s[3] + 1)                # …the 40px line under an 18px one
  end

  # …and an empty box shows them where it opened, on an ordinary line box.
  it 'shows the edges of a box that never got any content' do
    body = '<div id="d" style="width:200px"><span id="s" style="padding:5px"></span></div>'
    boxes, _w, line = measure(body, ['#d', '#s'])
    d, s = boxes
    expect(s[2]).to eq(10)                             # Chrome: [0, -5, 10, 27] on an 18px line
    expect(d[3]).to eq(line)
  end

  # An out-of-flow child of a box that has not opened yet is positioned from where that box turns
  # out to open, not from the cursor it was reached at.
  it 'positions an absolute child from where its inline box opens' do
    body = '<div id="d" style="width:100px;position:relative">word <span style="padding-left:10px">' \
           '<i id="a" style="position:absolute;width:5px;height:5px"></i>bbbbbbbb</span></div>'
    boxes, _w, line = measure(body, ['#a'])
    expect(boxes[0][0]).to eq(10)                      # Chrome: [10, 18] — the second line, past
    expect(boxes[0][1]).to eq(line)                    # …the padding the box opened with
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
