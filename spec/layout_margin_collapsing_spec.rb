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

  # `[y, height]` of each selector inside a 300px block. `host:` puts that shadow-root markup on the block —
  # the body is SLOTTED content then, inheriting through the flat tree rather than through the DOM parent —
  # and gives the block a height of its own, so that taking the host's instead of the slot's is visible.
  def boxes_for(body, selectors, host: nil, host_style: 'height:10px', wrapper_height: nil)
    shadow = host ? %(<script>document.getElementById('cb').attachShadow({mode: 'open'}).innerHTML = #{host.to_json}</script>) : ''
    style = "width:300px#{host ? ";#{host_style}" : ''}#{wrapper_height ? ";height:#{wrapper_height}" : ''}"
    boxes, = measure(%(<div id="cb" style="#{style}">#{body}</div>#{shadow}), selectors)
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

  # A run of collapse-through children can come to a NEGATIVE number, which leaves the flow ABOVE the
  # content top — and what floors at zero then is the CONTENT height, not the border box: the padding is
  # still there. Chrome: a `padding-top: 1px` block over `margin: -30px 0 10px` and a 5px box is 1 tall, with
  # the children at -29 and -19 (its own padding-box top is still 0).
  it 'floors the content height under a negative run, keeping the padding' do
    boxes = boxes_for('<div id="w" style="padding-top:1px"><div id="e" style="margin-top:-30px;margin-bottom:10px"></div>' \
                      '<div id="n" style="height:5px"></div></div>', ['#w', '#e', '#n'])
    expect(boxes[0]).to eq([0, 1])
    expect(boxes[1]).to eq([-29, 0])
    expect(boxes[2]).to eq([-19, 5])
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

  # WHICH float makes a `clear` a margin separator is answered STRUCTURALLY — is there a float earlier in the
  # box's formatting context — because a margin is wanted before any float is placed. Chrome asks it two ways
  # (measured, 153, ~80 shapes): a float placed while the box's OWN parent was laid out separates whatever its
  # geometry, while an INHERITED one separates only where it reaches below the box. Reading the second like
  # the first is a bounded gap this engine keeps on purpose, because the structural answer is the one both
  # engines can give the same: a `clear: left; margin-top: 20px` first child of a wrapper that starts below a
  # 30px float is at 40 here where Chrome says 60. Making it geometric means making the HOIST geometric, and
  # `marginInfo` runs before a single float is placed.
  it 'asks structurally whether a clear separates a margin' do
    above = '<div style="float:left;width:100px;height:30px"></div><div style="height:40px"></div>' \
            '<div id="w"><div id="c" style="clear:left;margin-top:20px;height:5px"></div></div>'
    expect(boxes_for(above, ['#w', '#c'])).to eq([[40, 5], [40, 5]])   # Chrome: 60 / 60

    # …and where the inherited float DOES reach below the box, structural and geometric agree — the box is on
    # the clearance line and its margin is spent, which is Chrome's answer too.
    below = '<div style="float:left;width:100px;height:61px"></div><div style="height:40px"></div>' \
            '<div id="w"><div id="c" style="clear:left;margin-top:20px;height:5px"></div></div>'
    expect(boxes_for(below, ['#w', '#c']).last).to eq([61, 5])
  end

  # …and the clearance line REPLACES the margin rather than adding to it, even where the margin alone would
  # have put the box lower: Chrome 153 puts a `clear: left; margin-top: 20px` first child at the 5px float's
  # bottom, not at 20, and the wrapper it is in stays where it was rather than taking the margin out.
  it 'spends a cleared box margin on the clearance line' do
    %w[60 5].each do |h|
      boxes = boxes_for(%(<div id="w"><div style="float:left;width:100px;height:#{h}px"></div>) +
                        '<div id="c" style="clear:left;margin-top:20px;height:10px"></div></div>', ['#w', '#c'])
      expect([h, boxes[0]]).to eq([h, [0, h.to_i + 10]])
      expect([h, boxes[1]]).to eq([h, [h.to_i, 10]])
    end
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

  # A CSS-WIDE keyword is no height of its own either — it has to be resolved to the one it stands for first.
  # `inherit` IS the parent's, so an `inherit` child of an 80px block is 80 tall and keeps the margins around
  # it apart; `initial` / `unset` / `revert` stand for `auto` and collapse through like any empty box. Reading
  # the keyword literally made all four auto, which left the `inherit` box 0 tall where Chrome says 80.
  it 'resolves a CSS-wide keyword before asking whether a height separates margins' do
    tall = boxes_for('<div id="w" style="height:80px"><div id="e" style="height:inherit"></div></div>', ['#w', '#e'])
    expect(tall[1]).to eq([0, 80])

    %w[initial unset revert].each do |kw|
      y = boxes_for(%(<p id="a">a</p><div id="e" style="height:#{kw}"></div><p id="b">b</p>), ['#a', '#e', '#b']).map(&:first)
      expect([kw, y]).to eq([kw, [16, 50, 50]])
    end

    # …and it is the FLAT tree it inherits through, as everything else in the cascade does: slotted content
    # takes the SLOT's height, not the host's. Chrome puts the `inherit` box at 0 tall here, where taking the
    # host's `height: 10px` left it 10 and pushed the paragraph after it to 76.
    slotted = boxes_for('<p id="a">a</p><div id="e" style="height:inherit"></div><p id="b">b</p>', ['#e', '#b'],
                        host: '<slot style="display:block;height:0"></slot>')
    expect(slotted[0]).to eq([50, 0])
    expect(slotted[1][0]).to eq(50)

    # …and the other hop the flat tree knows: an element at the top of a SHADOW tree inherits from the HOST.
    # Its DOM parent is the shadow root, which is no element at all, so that walk found nothing and fell back
    # to the initial value — Chrome gives the `padding-top: inherit` div the host's 30px, putting the slotted
    # box at 60 and making the host 65 tall.
    hosted = boxes_for('<div id="e" style="height:5px"></div>', ['#cb', '#e'],
                       host: '<div style="padding-top:inherit"><slot></slot></div>', host_style: 'padding-top:30px')
    expect(hosted[0]).to eq([0, 65])
    expect(hosted[1][0]).to eq(60)
  end

  # §8.3.1's BOTTOM rule is not the collapse-THROUGH rule, and the difference is a `height: 0` box: nothing
  # separates its own two margins, so it collapses through — but its last child's bottom margin does NOT come
  # out of it. Chrome 153: a `height: 0` box holding a `margin-bottom: 12px` child is 0 tall and so is the
  # block around it, where letting the margin escape made that block 12. Reading one rule for both was a
  # MISMATCH the native engine got right and this one did not.
  it 'keeps a last child bottom margin inside a box with a declared height' do
    %w[0 0px 1px].each do |h|
      (wrap,) = boxes_for(%(<div id="w" style="overflow:hidden"><div style="height:#{h}">) +
                          '<div id="c" style="margin-bottom:12px;height:5px"></div></div></div>', ['#w', '#c'])
      expect([h, wrap]).to eq([h, [0, h == '1px' ? 1 : 0]])
    end
    # …and an AUTO height, or an intrinsic keyword, still lets it out: the block comes to 5 + 12.
    %w[auto min-content max-content fit-content].each do |h|
      (wrap,) = boxes_for(%(<div id="w" style="overflow:hidden"><div style="height:#{h}">) +
                          '<div id="c" style="margin-bottom:12px;height:5px"></div></div></div>', ['#w', '#c'])
      expect([h, wrap]).to eq([h, [0, 17]])
    end
    # …the TOP rule has no height clause at all, so the same box still hands its child's top margin up.
    (top,) = boxes_for('<div id="w" style="overflow:hidden"><div style="height:0">' \
                       '<div id="c" style="margin-top:12px;height:5px"></div></div></div>', ['#w', '#c'])
    expect(top).to eq([0, 12])
  end

  # …and it is the USED height that decides, not the declaration: a PERCENTAGE against an indefinite
  # containing block IS auto (§10.5), so `height: 0%` and `height: 100%` under an auto-height parent both let
  # the margin out where a declared `0` keeps it in — and the same percentage against a DEFINITE block is a
  # real height and keeps it in. All four Chrome 153-measured.
  it 'reads the used height, so a percentage against an indefinite block is auto' do
    %w[0% 100%].each do |h|
      (wrap, box) = boxes_for(%(<div id="w" style="overflow:hidden"><div id="p" style="height:#{h}">) +
                              '<div style="margin-bottom:12px;height:5px"></div></div></div>', ['#w', '#p'])
      expect([h, wrap, box]).to eq([h, [0, 17], [0, 5]])
    end

    definite = boxes_for('<div id="w" style="overflow:hidden;height:40px"><div id="p" style="height:0%">' \
                         '<div style="margin-bottom:12px;height:5px"></div></div></div>', ['#w', '#p'])
    expect(definite).to eq([[0, 40], [0, 0]])

    # …asked of the box's own SIBLING, which is where the answer actually shows: the margin the box keeps
    # inside it does not move what comes after. The basis has to travel with the question for this to hold —
    # read off a stamp `usedSize` writes later, the memoised answer said `auto` and the sibling moved 12px on
    # the first pass and not on the second.
    [['50%', 30], ['0%', 0], ['100%', 60], ['calc(50%)', 30], ['30px', 30]].each do |h, y|
      sib = boxes_for(%(<div id="p" style="height:#{h}"><div style="margin-bottom:12px;height:5px"></div></div>) +
                      '<div id="s" style="height:5px"></div>', ['#s'], wrapper_height: '60px')
      expect([h, sib.first.first]).to eq([h, y])
    end
    # …and `calc(0px)`, which is a length however it is written
    zero = boxes_for('<div id="w" style="overflow:hidden"><div id="p" style="height:calc(0px)">' \
                     '<div style="margin-bottom:12px;height:5px"></div></div></div>', ['#w', '#p'])
    expect(zero).to eq([[0, 0], [0, 0]])
  end

  # KNOWN DIVERGENCE: the same rule's `min-height` half, which this engine does not model at all. Chrome 153
  # gives the bottom margin to the box only while `min-height` does NOT raise it above its content: a
  # `min-height: 5px` box over a 5px child with a 12px bottom margin is 5 tall and the block around it 17,
  # while `min-height: 6px` makes it 6 and the block 6 — the margin reaches NEITHER, consumed by the clamp.
  # Both engines let it escape either way, so the shadow harness cannot see this; fixing it means deciding
  # the margin's fate AFTER the min clamp, in both.
  it 'does not model the min-height half of the bottom rule' do
    [['5px', 17], ['6px', 18], ['20px', 32]].each do |mh, outer|
      (wrap,) = boxes_for(%(<div id="w" style="overflow:hidden"><div style="min-height:#{mh}">) +
                          '<div id="c" style="margin-bottom:12px;height:5px"></div></div></div>', ['#w', '#c'])
      expect([mh, wrap]).to eq([mh, [0, outer]])   # Chrome: 17, 6, 20
    end
  end

  # An intrinsic height keyword is no height at all for this purpose.
  it 'collapses through a box sized by its own content' do
    y = boxes_for('<p id="a">a</p><div id="e" style="height:min-content"></div><p id="b">b</p>',
                  ['#a', '#e', '#b']).map(&:first)
    expect(y).to eq([16, 50, 50])
  end

end
