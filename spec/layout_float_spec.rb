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
  def floated(body, selectors)
    boxes, text, line = measure(%(<div id="cb" style="width:300px">#{body}</div>), selectors,
                                probes: ['one two three four five six seven eight'])
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

end
