# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Floats (CSS 2.1 §9.5) were laid out as ordinary blocks: a floated image stacked above the
# paragraph it belongs beside, two floats meant to sit side by side stacked, and `clear` did
# nothing. A float is taken out of the flow, shifted as far to one side as it fits, and it is the
# LINES around it that are shortened — the blocks holding them are not.
#
# Figures measured in Chrome 151.0.7922.169. The text ones are derived from the measured probes,
# because which face fontconfig serves decides them; everything else is a figure in its own right.
RSpec.describe 'floats' do
  include LayoutMeasure

  # The boxes named by `selectors` inside a 300px block.
  def floated(body, selectors, probes: ['one two three four five six seven eight'])
    boxes, text, line = measure(%(<div id="cb" style="width:300px">#{body}</div>), selectors, probes: probes)
    [boxes.map {|b| b.map {|n| n.round(2) } }, text, line]
  end

  it 'puts two floats side by side, and wraps the third to the next band' do
    boxes, = floated(<<~HTML, ['#a', '#b', '#c'])
      <div id="a" style="float:left;width:100px;height:50px"></div>
      <div id="b" style="float:left;width:100px;height:50px"></div>
      <div id="c" style="float:left;width:150px;height:20px"></div>
    HTML
    expect(boxes[0][0, 2]).to eq([0, 0])
    expect(boxes[1][0, 2]).to eq([100, 0])
    # 150 doesn't fit beside 200, so it drops below the shallowest float in the way.
    expect(boxes[2][0, 2]).to eq([0, 50])
  end

  it 'floats to the right against the far edge' do
    boxes, = floated(<<~HTML, ['#a', '#b'])
      <div id="a" style="float:right;width:80px;height:20px"></div>
      <div id="b" style="float:right;width:40px;height:20px"></div>
    HTML
    expect(boxes[0][0]).to eq(220)
    expect(boxes[1][0]).to eq(180)
  end

  # The block keeps its full width — it is the LINES inside it that are shortened, which is what
  # makes text wrap around a floated image instead of starting below it.
  it 'shortens the lines beside a float, not the block' do
    boxes, text, line = floated(<<~HTML, ['#p', '#f'])
      <div id="f" style="float:left;width:100px;height:60px"></div>
      <p id="p" style="margin:0">one two three four five six seven eight</p>
    HTML
    expect(boxes[0][0, 3]).to eq([0, 0, 300])
    expect(boxes[1][0, 2]).to eq([0, 0])
    # The words take one line more than they would with the whole 300 to themselves.
    beside = (text['one two three four five six seven eight'] / 200.0).ceil
    expect(boxes[0][3]).to be > line
    expect(boxes[0][3]).to eq(beside * line)
  end

  # …and a line that cannot fit even its first word in what is left drops below the float.
  it 'drops a line that cannot fit beside the float' do
    boxes, _text, line = floated(<<~HTML, ['#p', '#f'])
      <div id="f" style="float:left;width:250px;height:30px"></div>
      <p id="p" style="margin:0">averyveryverylongword</p>
    HTML
    expect(boxes[1][2]).to eq(250)
    expect(boxes[0][3]).to eq(30 + line)
  end

  it 'clears past the floats a box names' do
    boxes, = floated(<<~HTML, ['#a', '#b', '#c'])
      <div id="a" style="float:left;width:40px;height:40px"></div>
      <div id="b" style="float:left;clear:left;width:30px;height:10px"></div>
      <div id="c" style="clear:both;height:5px"></div>
    HTML
    expect(boxes[1][0, 2]).to eq([0, 40])
    expect(boxes[2][1]).to eq(50)
  end

  # A box that starts its own formatting context contains the floats inside it — which is what
  # `overflow: hidden` on a wrapper full of floats is for — and does not overlap the ones outside.
  it 'contains the floats inside a formatting context of its own' do
    boxes, = floated(<<~HTML, ['#w', '#f'])
      <div id="w" style="overflow:hidden"><div id="f" style="float:left;width:30px;height:60px"></div></div>
    HTML
    expect(boxes[0][3]).to eq(60)
    expect(boxes[1][3]).to eq(60)
  end

  it 'places a box with its own formatting context in the band the floats leave' do
    boxes, = floated(<<~HTML, ['#f', '#w'])
      <div id="f" style="float:right;width:80px;height:20px"></div>
      <div id="w" style="overflow:hidden;height:10px"></div>
    HTML
    expect(boxes[1][0, 3]).to eq([0, 0, 220])
  end

  # …and which boxes those are is ONE question: `contain: layout|paint|content|strict`, a multi-column box
  # and `display: flow-root` establish a formatting context as surely as `overflow: hidden` does
  # (css-contain-2 §2.1, css-multicol-1 §2). This engine answered only the margin half for the first two, so
  # their floats escaped — and an escaped float then ate the clearance margin of the box below (Chrome puts
  # it at 80, this answered 50). Chrome 153-measured in the 300px block. (`contain: strict` and
  # `contain: size` are left to the box-model spec's size-containment tripwire: size containment is not
  # modelled here, and it moves both figures.)
  it 'contains its floats and takes the band for every kind of formatting context' do
    ['overflow:hidden', 'display:flow-root', 'contain:layout', 'contain:paint', 'contain:content'].each do |style|
      boxes, = floated(<<~HTML, ['#w', '#n'])
        <div id="w" style="#{style}"><div style="float:left;width:50px;height:50px"></div></div>
        <div id="n" style="clear:left;margin-top:30px;height:5px"></div>
      HTML
      expect([style, boxes[0][3]]).to eq([style, 50])   # the owner's auto height grew to its float
      expect([style, boxes[1][1]]).to eq([style, 80])   # …which the box below then cleared, margin and all

      # …and beside a float OUTSIDE it, such a box takes the band rather than the full width.
      beside, = floated(<<~HTML, ['#b'])
        <div style="float:left;width:80px;height:30px"></div>
        <div id="b" style="#{style};height:10px"></div>
      HTML
      expect([style, beside[0][0, 3]]).to eq([style, [80, 0, 220]])
    end
  end

  # Multicol is such a context too — but Chrome also COLUMNISES, which this engine does not model: it
  # balances the 50px float into two 25px columns and puts the cleared box at 55, where one column puts it
  # at 80. What is pinned here is the containment; the column layout is backlog.
  it 'contains a multicol float, in the one column it lays out' do
    boxes, = floated(<<~HTML, ['#w', '#n'])
      <div id="w" style="column-count:2"><div style="float:left;width:50px;height:50px"></div></div>
      <div id="n" style="clear:left;margin-top:30px;height:5px"></div>
    HTML
    expect(boxes[0][3]).to eq(50)   # Chrome: 25, over two balanced columns
    expect(boxes[1][1]).to eq(80)   # Chrome: 55

    # …and `column-width: inherit` under a real one is a multicol box too: it holds its child's margin in
    # (30 down inside a 40-tall box), where Chrome columnises the same content into a 20-tall pair.
    inherited, = floated('<div style="column-width:100px"><div id="w" style="column-width:inherit">' \
                         '<div id="p" style="margin-top:30px;height:10px"></div></div></div>', ['#w', '#p'])
    expect(inherited[0][3]).to eq(40)   # Chrome: 20
    expect(inherited[1][1]).to eq(30)   # Chrome: 0, in the second column
  end

  # What the predicate reads is CASCADED text, so a CSS-WIDE keyword arrives verbatim and has to be resolved
  # to the value it stands for. `contain` and `column-*` are non-inherited and no UA rule declares them, so
  # `initial` / `unset` / `revert` are the initial value — no context, and the float inside escapes — while
  # `inherit` IS the parent's, which taking it literally got backwards in both directions. Chrome 153-measured.
  it 'resolves a CSS-wide keyword rather than reading it as a value' do
    %w[initial unset revert].each do |kw|
      boxes, = floated(<<~HTML, ['#w', '#n'])
        <div id="w" style="column-count:#{kw}"><div style="float:left;width:50px;height:50px"></div></div>
        <div id="n" style="height:5px"></div>
      HTML
      expect([kw, boxes[0][3]]).to eq([kw, 0])   # no context of its own, so the float escaped it…
      expect([kw, boxes[1][1]]).to eq([kw, 0])   # …and the next box sits beside it rather than below
    end

    # …and `inherit` takes the parent's declaration: a `column-count: 1` parent makes it a multicol box, which
    # holds its child's margin in (40 tall, the child 30 down inside it).
    cols, = floated('<div style="column-count:1"><div id="w" style="column-count:inherit">' \
                    '<div id="p" style="margin-top:30px;height:10px"></div></div></div>', ['#w', '#p'])
    expect(cols[0][1, 3]).to eq([0, 300, 40])
    expect(cols[1][1]).to eq(30)

    # …the same for `contain`, whose float it holds in and whose clearance the box below then takes — and
    # `contain: initial|unset|revert` is `none`, so that float escapes as it would with no declaration at all.
    held, = floated('<div style="contain:layout"><div id="w" style="contain:inherit">' \
                    '<div style="float:left;width:50px;height:50px"></div></div>' \
                    '<div id="n" style="clear:left;margin-top:30px;height:5px"></div></div>', ['#w', '#n'])
    expect(held[0][3]).to eq(50)
    expect(held[1][1]).to eq(80)

    %w[initial unset revert].each do |kw|
      boxes, = floated(<<~HTML, ['#w', '#n'])
        <div id="w" style="contain:#{kw}"><div style="float:left;width:50px;height:50px"></div></div>
        <div id="n" style="height:5px"></div>
      HTML
      expect([kw, boxes[0][3]]).to eq([kw, 0])
      expect([kw, boxes[1][1]]).to eq([kw, 0])
    end

    # …a chain of them keeps climbing — two `inherit` boxes under a `contain: layout` are both contexts, so
    # the float stays in and the box below sits at the float's bottom.
    chain, = floated('<div style="contain:layout"><div style="contain:inherit"><div id="w" style="contain:inherit">' \
                     '<div style="float:left;width:50px;height:50px"></div></div></div>' \
                     '<div id="n" style="height:5px"></div></div>', ['#w', '#n'])
    expect(chain[0][3]).to eq(50)
    expect(chain[1][1]).to eq(50)

    # …and the walk up stops at the first ancestor that declares something of its own: a `contain: initial`
    # between the `inherit` and the `contain: layout` is `none`, so the float escapes all three boxes.
    stopped, = floated('<div style="contain:layout"><div style="contain:initial"><div id="w" style="contain:inherit">' \
                       '<div style="float:left;width:50px;height:50px"></div></div></div>' \
                       '<div id="n" style="height:5px"></div></div>', ['#w', '#n'])
    expect(stopped[0][3]).to eq(0)
    expect(stopped[1][1]).to eq(0)

    # …`column-width` is read the same way, and an `inherit` whose ancestors declare nothing is nothing.
    bare, = floated('<div id="w" style="column-width:inherit"><div id="p" style="margin-top:30px;height:10px"></div></div>',
                    ['#w', '#p'])
    expect(bare[0][1]).to eq(30)     # no context: the child's margin came out through it
    expect(bare[1][1]).to eq(30)
  end

  # `display: contents` generates no box at all, so it establishes nothing whatever it declares — containment
  # applies to a box and this element has none (css-contain-2 §2.1), and a multicol box with no box is no
  # box. Chrome 153: the float inside one escapes to the block around it exactly as it would without the
  # declaration, and a child's margin collapses straight out through it.
  it 'establishes nothing on a box-less display:contents element' do
    boxes, = floated(<<~HTML, ['#f', '#n'])
      <div style="display:contents;contain:layout"><div id="f" style="float:left;width:50px;height:50px"></div></div>
      <div id="n" style="height:5px"></div>
    HTML
    expect(boxes[0][0, 2]).to eq([0, 0])
    expect(boxes[1][1]).to eq(0)     # the float escaped: the block below starts beside it, not under it

    margin, = floated('<div style="display:contents;column-count:2"><div id="p" style="margin-top:30px;height:10px"></div></div>',
                      ['#cb', '#p'])
    expect(margin[0][1]).to eq(30)   # …and the margin came out through it, moving the 300px block itself
    expect(margin[1][1]).to eq(30)
  end

  # A float's CONTAINING BLOCK is its own parent — that is where it is placed, inside that parent's content
  # box — while the CONTEXT it is recorded in, whose lines it shortens and whose `clear` it answers, is the
  # nearest ancestor that establishes one. The two come apart in the shape half the web is built from:
  # `.row > .col { float: left }`, where the row is a plain block. Chrome 153-measured in the 300px block.
  it 'places a float in its own parent but records it in the context above' do
    boxes, = floated(<<~HTML, ['#w', '#f', '#n'])
      <div id="w" style="margin-left:40px;width:200px"><div id="f" style="float:right;width:50px;height:50px"></div></div>
      <div id="n" style="clear:right;height:5px"></div>
    HTML
    expect(boxes[0][3]).to eq(0)      # the wrapper is empty: the float neither fills it nor grows it
    expect(boxes[1][0]).to eq(190)    # …placed against the WRAPPER's right content edge (40 + 200 − 50)
    expect(boxes[2][1]).to eq(50)     # …and cleared by a box two levels up, so the context above holds it
  end

  # §9.4.3 is a PAINT-time shift: it changes no other box's layout, so a float inside a
  # `position: relative; top: 10px` wrapper excludes at its UNSHIFTED rectangle even though the float itself
  # is painted 10 lower. A relatively positioned block is therefore laid out where the flow put it and MOVED
  # afterwards (`shiftSubtree`, the same lay-out-then-move an inline box's relative children take); laying
  # its subtree out at the shifted origin baked the offset into everything the subtree recorded in an
  # ancestor's coordinates, and the float rectangle above all. All three figures are Chrome's.
  it 'excludes a float at its unshifted rectangle under a relative ancestor' do
    boxes, = floated(<<~HTML, ['#cb', '#f', '#n'])
      <div style="position:relative;top:10px"><div id="f" style="float:left;width:50px;height:50px"></div></div>
      <div id="n" style="clear:left;height:5px"></div>
    HTML
    expect(boxes[0][3]).to eq(55)    # the owner wraps the float's own 50 + the cleared box's 5
    expect(boxes[1][1]).to eq(10)    # …the float itself IS painted at the shift
    expect(boxes[2][1]).to eq(50)    # …and what clears it does so at 50, where the float would have been
  end

  # KNOWN DIVERGENCES, both of them the SHRINK-TO-FIT route rather than floats as such — pinned here because
  # a float is where a page meets them. A float with an intrinsic RATIO and no intrinsic size (a
  # `viewBox`-only `<svg>`) asks `intrinsicWidths` for a figure a replaced box does not have, and collapses to
  # nothing: Chrome 153 gives it 400x300 in a 400px block, this engine 0x0 — where the same `<svg>` as an
  # ordinary block child is 400x300 here too, so it is the route and not the box. And a float in a VERTICAL
  # writing mode shrinks to fit along the wrong axis: Chrome makes it 18 wide and 67.97 tall, this engine
  # 67.97 by 18.
  it 'collapses a ratio-only float and mis-axes a vertical one (Chrome does not)' do
    ratio, = floated('<svg id="s" style="float:left" viewBox="0 0 4 3"></svg>', ['#s'])
    expect(ratio.first[2, 2]).to eq([0, 0])              # Chrome: 400 x 300

    vertical, text = floated('<div id="v" style="float:left;writing-mode:vertical-rl">hello there</div>', ['#v'],
                             probes: ['hello there'])
    # Chrome has these the other way round: 18 wide (one line box) and as tall as the text is long.
    expect(vertical.first[2]).to be_within(0.02).of(text['hello there'])
    expect(vertical.first[3]).to eq(18)
  end

  # WHERE a float goes needs its HEIGHT: one too tall for the gap another float leaves drops past it
  # (§9.5.1). An AUTO height is not known until the float's own subtree is laid out, and searching the band
  # with a zero-height box squeezed this one into the 12px gap beside the right float — Chrome 153 drops it
  # below both, at 36.
  it 'drops an auto-height float past the floats it cannot fit beside' do
    boxes, = floated(<<~HTML, ['#a', '#b', '#c'])
      <div id="a" style="float:right;width:90px;height:12px"></div>
      <div id="b" style="float:left;width:300px;height:24px"></div>
      <div id="c" style="float:left;width:19px">sib</div>
    HTML
    expect(boxes[0][0, 2]).to eq([210, 0])
    expect(boxes[1][0, 2]).to eq([0, 12])
    expect(boxes[2][0, 2]).to eq([0, 36])

    # …and a DECLARED height went the same way already, which is what makes this the auto one's bug alone.
    declared, = floated(<<~HTML, ['#c'])
      <div style="float:right;width:90px;height:12px"></div>
      <div style="float:left;width:300px;height:24px"></div>
      <div id="c" style="float:left;width:19px;height:18px">sib</div>
    HTML
    expect(declared[0][0, 2]).to eq([0, 36])
  end

  # An ordinary block, by contrast, keeps the whole width and lets the float overlap it.
  it 'leaves an ordinary block its full width beside a float' do
    boxes, = floated(<<~HTML, ['#f', '#w'])
      <div id="f" style="float:right;width:80px;height:20px"></div>
      <div id="w" style="height:10px"></div>
    HTML
    expect(boxes[1][0, 3]).to eq([0, 0, 300])
  end

  # CSS Display §2.7: a float is BLOCKIFIED, so a floated `<span>` is a block box with a width and
  # a height — not a word on the line — and its computed `display` says so.
  it 'blockifies a floated inline' do
    boxes, _text, _line = floated('<span id="s" style="float:left;width:60px;height:20px"></span>after', ['#s'])
    expect(boxes[0][0, 4]).to eq([0, 0, 60, 20])

    session = measure('<span id="s" style="float:left"></span>', ['#s'])[3]
    expect(session.evaluate_script("getComputedStyle(document.getElementById('s')).display")).to eq('block')
  end

  # Its own margins are part of what the lines route around, and they never collapse (§8.3.1).
  it 'routes the lines around the float margin box' do
    boxes, = floated(<<~HTML, ['#w', '#f'])
      <div id="w" style="overflow:hidden"><div id="f" style="float:left;width:60px;height:20px;margin:10px"></div></div>
    HTML
    expect(boxes[1][0, 2]).to eq([10, 10])
    expect(boxes[0][3]).to eq(40)
  end

  # A float's auto width shrinks to fit, exactly as a table's does.
  it 'shrinks a float with no width to its content' do
    boxes, text, = measure('<div id="cb" style="width:300px"><div id="w" style="overflow:hidden">' \
                           '<div id="f" style="float:left">one two</div></div></div>',
                           ['#f'], probes: ['one two'])
    expect(boxes[0][2]).to be_within(0.5).of(text['one two'])
  end
  # A float written INSIDE an inline box belongs to the block's band, not to that box's line — and
  # the inline box goes on fragmenting around it (Chrome keeps the paragraph one 18px line).
  it 'hoists a float out of the inline box it was written in' do
    boxes, _text, line = floated('<p id="p" style="margin:0">hello <span>world ' \
                                 '<b id="f" style="float:left;width:80px;height:40px"></b> more</span> text</p>',
                                 ['#p', '#f'])
    expect(boxes[1][0, 4]).to eq([0, 0, 80, 40])
    expect(boxes[0][3]).to eq(line)
  end

  # …and an atomic inline too narrow for what the float leaves drops below it rather than
  # overflowing, the same rule the words follow.
  it 'drops an atomic inline that cannot fit beside the float' do
    boxes, = floated('<div id="f" style="float:left;width:250px;height:40px"></div>' \
                     '<div><span id="i" style="display:inline-block;width:100px;height:10px"></span></div>',
                     ['#i'])
    # Below the float and back at the content edge — where on its line it sits is the baseline's
    # business, so only the band is asserted here.
    expect(boxes[0][0]).to eq(0)
    expect(boxes[0][1]).to be >= 40
  end

  # §9.7: `float` computes to `none` on an out-of-flow box — it is POSITIONED, not floated, and it
  # shortens no lines at all.
  it 'does not float an absolutely positioned box' do
    body = '<div id="f" style="float:left;position:absolute;top:50px;left:60px;width:100px;height:20px"></div>' \
           '<p id="p" style="margin:0">one two three four five six seven eight</p>'
    boxes, _text, line, session = measure(%(<div style="width:300px;position:relative">#{body}</div>), ['#f', '#p'])
    expect(boxes[0][0, 2]).to eq([60, 50])
    expect(boxes[1][3]).to eq(line)
    expect(session.evaluate_script("getComputedStyle(document.getElementById('f')).float")).to eq('none')
  end

  # The ROOT contains the floats in it even though `<body>` does not.
  it 'grows the root element to hold a float' do
    _boxes, _text, line, session = measure('<div style="float:left;width:50px;height:2000px"></div>x', ['body'])
    expect(session.evaluate_script('document.documentElement.getBoundingClientRect().height')).to eq(2000)
    # …where the body is as tall as its own lines: it does not establish a formatting context, so
    # the float overflows it (this page has the measure helper's probe line in it as well).
    expect(session.evaluate_script('document.body.getBoundingClientRect().height')).to eq(line * 2)
  end

  # CSS Display §2.7 blockifies a LAYOUT-INTERNAL box too: a floated `table-cell` is a block, where
  # a `display: table` box is block-level already and keeps its own keyword.
  it 'blockifies a floated layout-internal box' do
    session = measure('<div id="c" style="display:table-cell;float:left;width:20px;height:10px"></div>' \
                      '<div id="t" style="display:table;float:left;width:20px;height:10px"></div>', ['#c'])[3]
    expect(session.evaluate_script("getComputedStyle(document.getElementById('c')).display")).to eq('block')
    expect(session.evaluate_script("getComputedStyle(document.getElementById('t')).display")).to eq('table')
  end

  # A SHRINK-TO-FIT box's own used width carries its percentage padding, where an intrinsic CONTRIBUTION leaves it
  # out (a percentage resolves against nothing in an intrinsic measure). Chrome measured in a 400px block: a
  # `float: left; padding: 0 10%` box around "hello there" is 147.97 — its 67.97 of text and padding-less box plus
  # the 80 its padding comes to — and an `inline-block` or an out-of-flow box the same.
  it 'gives a shrink-to-fit box its percentage padding' do
    %w[float:left display:inline-block position:absolute].each do |style|
      body = %(<div id="c" style="width:400px;position:relative"><div id="b" style="#{style};padding:0 10%">hello there</div></div>)
      boxes, text = measure(body, ['#c', '#b'], probes: ['hello there'])
      expect(boxes[1][2]).to be_within(0.02).of(text['hello there'] + 80), style
    end
  end
end
