# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Margin collapsing (CSS 2.1 §8.3.1). The adjacent-sibling half was always here; what was missing
# is what a box's own margins do with its CHILDREN's — which is most of the rule, and which every
# page's block geometry depends on: a `<div><p>text</p></div>` is as tall as the paragraph, and the
# paragraph's margin belongs to the div.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'margin collapsing' do
  include LayoutMeasure

  # `[y, height]` of each selector inside a 300px block.
  def boxes_for(body, selectors)
    boxes, = measure(%(<div style="width:300px">#{body}</div>), selectors)
    boxes.map {|b| [b[1].round(2), b[3].round(2)] }
  end

  # The margin of a first child is the PARENT's: it moves the parent, and the parent is as tall as
  # the child alone.
  it 'collapses a first child margin out of its parent' do
    (wrap, para) = boxes_for('<div id="w"><p id="p">x</p></div>', ['#w', '#p'])
    expect(wrap).to eq(para)
    expect(wrap[0]).to eq(16)
    expect(wrap[1]).to eq(18)
  end

  # …and anything BETWEEN the two margins stops it: a border, a padding, a formatting context of
  # the parent's own. (A top border keeps the top margin in; the bottom one still escapes, which is
  # why these are 35 tall and not 51.)
  it 'keeps the margin in when something separates them' do
    %w[border-top:1px\ solid padding-top:1px].each do |style|
      (wrap,) = boxes_for(%(<div id="w" style="#{style}"><p id="p">x</p></div>), ['#w', '#p'])
      expect(wrap[1]).to eq(35)
    end
    # A formatting context of its own keeps BOTH margins in — the everyday `overflow: hidden`.
    (bfc,) = boxes_for('<div id="w" style="overflow:hidden"><p id="p">x</p></div>', ['#w', '#p'])
    expect(bfc[1]).to eq(50)
  end

  # An empty block COLLAPSES THROUGH: its own two margins join the run around it rather than adding
  # to it, and its zero-height box sits where that run has reached.
  it 'collapses through an empty block' do
    y = boxes_for('<p id="a">a</p><div id="e"></div><p id="b">b</p>', ['#a', '#e', '#b']).map(&:first)
    expect(y).to eq([16, 50, 50])

    wide = boxes_for('<p id="a">a</p><div id="e" style="margin:20px 0"></div><p id="b">b</p>', ['#a', '#e', '#b'])
    # …and the run is the widest margin in it, not their sum.
    expect(wide.map(&:first)).to eq([16, 54, 54])
  end

  # The collapse travels ACROSS boxes: two divs each holding a paragraph are one margin apart, not
  # two — the paragraphs' own margins are what meet.
  it 'collapses across parents' do
    y = boxes_for('<div id="w1"><p>x</p></div><div id="w2"><p>y</p></div>', ['#w1', '#w2']).map(&:first)
    expect(y).to eq([16, 50])
  end

  # Content on a LINE separates the margins either side of it.
  it 'stops at a line box' do
    (wrap, para) = boxes_for('<div id="w"><span>inline</span><p id="p">after</p></div>', ['#w', '#p'])
    expect(wrap[1]).to eq(52)                        # 18 line + 16 margin + 18 paragraph
    expect(para[0] - wrap[0]).to eq(34)
  end

  # Negative margins collapse as max(positives) + min(negatives).
  it 'collapses a negative margin against a positive one' do
    y = boxes_for('<p id="a" style="margin-bottom:30px">a</p><p id="b" style="margin-top:-10px">b</p>',
                  ['#a', '#b']).map(&:first)
    expect(y[1] - y[0]).to eq(38)                    # 18 + (30 - 10)
  end

  # `<body>` establishes no formatting context either, so the page's own content starts where the
  # first margin puts it.
  it 'collapses the body margin with its first child' do
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body style="margin:0"><p id="p">x</p></body></html>']]
    })
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('p').getBoundingClientRect().y")).to eq(16)
    expect(session.evaluate_script('document.body.getBoundingClientRect().y')).to eq(16)
  end
  # A run is `max(positives) + min(negatives)` over the WHOLE set, which folding pairwise gets
  # wrong: 20, -30, 20 is -10, where folding left to right says +10.
  it 'collapses a run of three margins as a set' do
    y = boxes_for('<p id="a" style="margin-bottom:20px">a</p><div style="margin-top:-30px"></div>' \
                  '<p id="b" style="margin-top:20px">b</p>', ['#a', '#b']).map(&:first)
    expect(y).to eq([16, 24])

    nested = boxes_for('<div style="margin-top:20px"><div style="margin-top:-30px">' \
                       '<p id="p" style="margin-top:20px">x</p></div></div>', ['#p']).map(&:first)
    expect(nested).to eq([-10])
  end

  # A percentage margin resolves against the CONTAINING BLOCK's width — the box's own, not whatever
  # the walk started from.
  it 'resolves a percentage margin against its own containing block' do
    y = boxes_for('<div style="width:200px"><p id="p" style="margin-top:10%">x</p></div>', ['#p']).map(&:first)
    expect(y).to eq([20])

    padded = boxes_for('<div style="width:400px;padding:0 50px"><p id="p" style="margin-top:10%">x</p></div>',
                       ['#p']).map(&:first)
    expect(padded).to eq([40])                       # 10% of the 400px CONTENT box
  end

  # A box that collapses through sits where the margins ABOVE it have reached, not at the end of
  # the whole run.
  it 'places a collapsed-through box after the margins above it' do
    y = boxes_for('<p id="a">a</p><div id="e" style="margin-top:5px;margin-bottom:40px"></div><p id="b">b</p>',
                  ['#a', '#e', '#b']).map(&:first)
    expect(y).to eq([16, 50, 74])                    # the 5px joins the run above it, the 40 the one below
  end

  # CLEARANCE is a separator: a first child that has to clear a float keeps its margin to itself.
  it 'stops collapsing at a box that takes clearance' do
    boxes = boxes_for('<div style="float:left;width:20px;height:60px"></div>' \
                      '<div id="w"><p id="p" style="clear:left">x</p></div>', ['#w', '#p'])
    expect(boxes[0]).to eq([0, 78])                  # the p's margin stayed inside
    expect(boxes[1][0]).to eq(60)                    # …and it cleared the float

    # …and without a float to clear, `clear` changes nothing at all.
    plain = boxes_for('<div id="w"><p id="p" style="clear:left">x</p></div>', ['#w', '#p'])
    expect(plain[0]).to eq([16, 18])
  end

  # `contain` and multicol establish a formatting context as surely as `overflow` does.
  it 'keeps the margin in for every kind of formatting context' do
    ['contain:layout', 'contain:paint', 'display:flow-root', 'column-count:2'].each do |style|
      (wrap,) = boxes_for(%(<div id="w" style="#{style}"><p id="p">x</p></div>), ['#w', '#p'])
      expect([style, wrap[0], wrap[1]]).to eq([style, 0, 50])
    end
  end

  # The bottom margin travels through a last child that collapses through, too.
  it 'hands a margin up through a collapsed-through last child' do
    y = boxes_for('<div id="w"><p>x</p><div><div style="margin:30px 0"></div></div></div><p id="n">n</p>',
                  ['#w', '#n']).map(&:first)
    expect(y).to eq([16, 64])
  end

  # An intrinsic height keyword is no height at all for this purpose.
  it 'collapses through a box sized by its own content' do
    y = boxes_for('<p id="a">a</p><div id="e" style="height:min-content"></div><p id="b">b</p>',
                  ['#a', '#e', '#b']).map(&:first)
    expect(y).to eq([16, 50, 50])
  end

end
