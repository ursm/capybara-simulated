# frozen_string_literal: true

require 'capybara/simulated'
require 'vips'
require_relative 'support/session_teardown'

# `text-align` never moved a line: every line started at the block's content edge whatever the
# block declared, and an rtl block's lines started at the left. A line is lined up when it CLOSES —
# the free space after its content is what `right` and `center` shift it by, what `justify` spreads
# over the collapsible spaces of a WRAPPED line, and an rtl block lines up `right` by default.
#
# The rules, Chrome-measured on 300px blocks at 16px monospace (76 cases in four batteries, then
# the reviewers' 90 — all matched but the backlog below):
#   - right / end / rtl-start: x = right edge - content width; center: half the free space
#   - the whole line moves together — atomic inlines, inline-blocks, a preserved trailing space,
#     the first line's `text-indent`, the static position of an out-of-flow box on the line, and
#     an empty inline's cursor
#   - a line WIDER than the block stays at the start edge in ltr and hangs off the LEFT in rtl
#   - `justify` widens each space of a line that wrapped (a preserved double space twice); the last
#     line, and one a `<br>` ends, are start-aligned; an inline box spanning a gap widens with it
#   - a collapsible trailing space hangs; a preserved one hangs at a soft wrap only
#   - `text-indent` narrows the first line from the START edge (the right one in rtl); `hanging`
#     inverts the choice, `each-line` re-indents after a forced break; the line after a block
#     child takes none
#   - HTML's `align` attribute and `<center>` are the `-webkit-` values Chrome computes, and they
#     move the block-level descendants too
# Backlog (Chrome-measured, not modelled): the spaces INSIDE a `white-space: pre` / `nowrap` run
# on a justified line, `text-align-last`, and the static position of an out-of-flow box in an rtl
# block (`staticCornerFor` ignores the cursor).
#
# Every x here is a FORMULA over widths measured on the same page — the block's width and the run's
# own — never a figure: the run's width is the face's, and the face is the machine's.
RSpec.describe "text-align lines a block's lines up" do
  def page(body, css = '', body_attrs = '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { margin: 0; font: 16px monospace }
          span { white-space: pre }
          .w { width: 300px }
          #{css}
        </style></head><body #{body_attrs}>#{body}</body></html>
      HTML
    })
    session.visit '/'
    session
  end

  RECTS_JS = <<~JS
    (function () {
      var out = {};
      document.querySelectorAll('[id]').forEach(function (el) {
        var r = el.getBoundingClientRect();
        out[el.id] = [r.x, r.y, r.width, r.height];
      });
      return out;
    })()
  JS

  def rects(session) = session.evaluate_script(RECTS_JS)
  def lay(body, css = '', body_attrs = '') = rects(page(body, css, body_attrs))

  # `[x, width]` of a box — the two figures every formula is about.
  def xw(r, id) = [r[id][0], r[id][2]]

  it 'starts a left-aligned line at the content edge' do
    r = lay('<div class=w style="text-align:left"><span id=t>abcd</span></div>')
    expect(r['t'][0]).to eq(0)
  end

  it 'ends a right-aligned line at the content edge' do
    x, w = xw(lay('<div class=w style="text-align:right"><span id=t>abcd</span></div>'), 't')
    expect(x).to be_within(0.01).of(300 - w)
  end

  it 'centres a line in the free space' do
    x, w = xw(lay('<div class=w style="text-align:center"><span id=t>abcd</span></div>'), 't')
    expect(x).to be_within(0.01).of((300 - w) / 2)
  end

  it 'reads end as right and start as left in an ltr block' do
    r = lay('<div class=w style="text-align:end"><span id=e>abcd</span></div><div class=w style="text-align:start"><span id=s>abcd</span></div>')
    expect(r['e'][0]).to be_within(0.01).of(300 - r['e'][2])
    expect(r['s'][0]).to eq(0)
  end

  # ── direction ──
  it 'starts an rtl line at the right' do
    r = lay('<div class=w style="direction:rtl"><span id=d>abcd</span></div>' \
            '<div class=w style="direction:rtl;text-align:start"><span id=s>abcd</span></div>')
    expect(r['d'][0]).to be_within(0.01).of(300 - r['d'][2])
    expect(r['s'][0]).to be_within(0.01).of(300 - r['s'][2])
  end

  it 'turns left, end and center in an rtl block' do
    r = lay('<div class=w style="direction:rtl;text-align:left"><span id=l>abcd</span></div>' \
            '<div class=w style="direction:rtl;text-align:end"><span id=e>abcd</span></div>' \
            '<div class=w style="direction:rtl;text-align:center"><span id=c>abcd</span></div>')
    expect(r['l'][0]).to eq(0)
    expect(r['e'][0]).to eq(0)
    expect(r['c'][0]).to be_within(0.01).of((300 - r['c'][2]) / 2)
  end

  # ── the whole line moves ──
  it 'moves every box on the line by the same shift' do
    r = lay('<div class=w style="text-align:right"><span id=all><span id=h>abcd</span> <span id=i>ef</span></span></div>')
    expect(r['h'][0]).to be_within(0.01).of(300 - r['all'][2])
    expect(r['i'][0] + r['i'][2]).to be_within(0.01).of(300)
  end

  it 'counts a preserved trailing space as content' do
    x, w = xw(lay('<div class=w style="text-align:center"><span id=t>abcd </span></div>'), 't')
    expect(x).to be_within(0.01).of((300 - w) / 2)
  end

  it 'moves an atomic inline with the text beside it' do
    r = lay('<div class=w style="text-align:right"><img id=m width=40 height=10 style="vertical-align:top"><span id=n>ab</span></div>')
    expect(r['n'][0]).to be_within(0.01).of(300 - r['n'][2])
    expect(r['m'][0]).to be_within(0.01).of(300 - r['n'][2] - 40)
  end

  it 'moves an inline-block, and lines its own content up inside it' do
    r = lay('<div class=w style="text-align:right"><span id=b style="display:inline-block;width:100px"><span id=t>ab</span></span></div>')
    expect(r['b'][0]).to eq(200)
    expect(r['t'][0]).to be_within(0.01).of(300 - r['t'][2])          # inherited into the inline-block
  end

  it 'leaves a shrink-to-fit inline-block nothing to centre in' do
    r = lay('<div class=w><span style="display:inline-block;text-align:center"><span id=t>ab</span></span></div>')
    expect(r['t'][0]).to eq(0)
  end

  it 'lines every forced line up, not only the first' do
    r = lay('<div class=w style="text-align:right">aaaa<br><span id=t>bb</span><br><span id=u>cccccc</span></div>')
    expect(r['t'][0]).to be_within(0.01).of(300 - r['t'][2])
    expect(r['u'][0]).to be_within(0.01).of(300 - r['u'][2])
  end

  it 'lines a wrapped line up against the band a float leaves' do
    r = lay('<div class=w style="text-align:right"><span style="float:left;width:100px;height:10px"></span><span id=t>ab</span></div>')
    expect(r['t'][0]).to be_within(0.01).of(300 - r['t'][2])
  end

  it 'lines up against the content edge, inside the padding' do
    x, w = xw(lay('<div class=w style="text-align:right;padding-left:30px;padding-right:20px"><span id=t>abcd</span></div>'), 't')
    expect(x).to be_within(0.01).of(300 + 30 - w)                      # 330 is the right content edge
  end

  it "keeps a relative inline's own offset on top of the shift" do
    x, w = xw(lay('<div class=w style="text-align:right"><span id=t style="position:relative;left:10px">ab</span></div>'), 't')
    expect(x).to be_within(0.01).of(300 - w + 10)
  end

  it "counts an inline box's padding as line content" do
    x, w = xw(lay('<div class=w style="text-align:right"><span style="padding:0 10px"><span id=t>ab</span></span></div>'), 't')
    expect(x).to be_within(0.01).of(300 - 10 - w)
  end

  # ── overflow ──
  it 'keeps an overflowing ltr line at the start edge' do
    r = lay('<div style="width:20px;text-align:right"><span id=t>abcd</span></div><div style="width:20px;text-align:center"><span id=c>abcd</span></div>')
    expect(r['t'][0]).to eq(0)
    expect(r['c'][0]).to eq(0)
  end

  it 'hangs an overflowing rtl line off the left' do
    r = lay('<div style="width:20px;direction:rtl"><span id=t>abcd</span></div><div style="width:20px;direction:rtl;text-align:center"><span id=c>abcd</span></div>')
    expect(r['t'][0]).to be_within(0.01).of(20 - r['t'][2])
    expect(r['c'][0]).to be_within(0.01).of(20 - r['c'][2])
  end

  # ── preserved white space ──
  it 'hangs the preserved spaces at a soft wrap' do
    # "aaaa bbbb" fits, its trailing spaces hang past the edge, and "cccc" wraps.
    fits = (lay('<div><span id=t>aaaa bbbb</span></div>')['t'][2] + 1).ceil
    r = lay("<div style=\"width:#{fits}px;text-align:right;white-space:pre-wrap\">aaaa <span id=b>bbbb</span>   <span id=c>cccc</span></div>")
    expect(r['b'][0] + r['b'][2]).to be_within(0.01).of(fits)
    expect(r['c'][0]).to be_within(0.01).of(fits - r['c'][2])
  end

  it 'keeps the preserved spaces before a forced break as content' do
    r = lay('<div class=w style="text-align:right;white-space:pre-wrap"><span id=t>aaaa</span><span id=s>  </span><br>x</div>')
    expect(r['t'][0]).to be_within(0.01).of(300 - r['t'][2] - r['s'][2])
  end

  it 'lets a last line of preserved spaces overflow at the start edge' do
    r = lay("<div class=w style=\"text-align:right;white-space:pre-wrap\"><span id=t>aaaa</span>#{' ' * 40}</div>")
    expect(r['t'][0]).to eq(0)
  end

  # ── text-indent ──
  it 'indents the first line, and lines the indent up as content' do
    x, w = xw(lay('<div class=w style="text-align:center;text-indent:40px"><span id=t>abcd</span></div>'), 't')
    expect(x).to be_within(0.01).of(40 + (260 - w) / 2)
  end

  it 'indents only the first line' do
    r = lay('<div class=w style="text-indent:40px"><span id=f>a</span><br><span id=t>b</span></div>')
    expect(r['f'][0]).to eq(40)
    expect(r['t'][0]).to eq(0)
  end

  it 'resolves a percentage indent against the block' do
    r = lay('<div class=w style="text-indent:10%"><span id=t>ab</span></div>')
    expect(r['t'][0]).to eq(30)
  end

  it 'takes a negative indent' do
    x, w = xw(lay('<div class=w style="text-align:center;text-indent:-20px"><span id=t>ab</span></div>'), 't')
    expect(x).to be_within(0.01).of((300 - w) / 2 - 10)
  end

  it 'places the indent at the start edge of an rtl block' do
    x, w = xw(lay('<div class=w style="direction:rtl;text-indent:40px"><span id=t>ab</span></div>'), 't')
    expect(x).to be_within(0.01).of(300 - 40 - w)
  end

  it 'lets an rtl indent push an overflowing line further left' do
    x, w = xw(lay('<div style="width:20px;direction:rtl;text-indent:10px"><span id=t>abcd</span></div>'), 't')
    expect(x).to be_within(0.01).of(20 - 10 - w)
  end

  it 'inverts the choice of line under hanging' do
    r = lay('<div class=w style="text-indent:40px hanging"><span id=f>a</span><br><span id=t>b</span></div>')
    expect(r['f'][0]).to eq(0)
    expect(r['t'][0]).to eq(40)
  end

  it 're-indents after a forced break under each-line, and not after a wrap' do
    # Room for the indent and "aaaa bbbb" on the first line; "cccc" wraps, then a <br>.
    fits = (lay('<div><span id=t>aaaa bbbb</span></div>')['t'][2] + 1).ceil + 20
    r = lay("<div style=\"width:#{fits}px;text-indent:20px each-line;white-space:normal\">aaaa <span id=b>bbbb</span> <span id=c>cccc</span><br><span id=d>dddd</span></div>")
    expect(r['c'][0]).to eq(0)                                           # the wrapped line
    expect(r['d'][0]).to eq(20)                                          # the line after the <br>
  end

  # An indented empty line is still empty: the block child that follows starts at the top, and the
  # collapsible space before the first word is still at a line start.
  it 'adds no line before a block child' do
    control  = lay('<div id=c class=w><div><span>a</span></div></div>')['c'][3]
    indented = lay('<div id=c class=w style="text-indent:40px"><div><span>a</span></div></div>')['c'][3]
    expect(indented).to eq(control)
  end

  it 'drops the collapsible space before the first word of an indented line' do
    r = lay('<div class=w style="text-indent:40px;white-space:normal"> <span id=t>ab</span></div>')
    expect(r['t'][0]).to eq(40)
  end

  it 'does not indent the line after a block child' do
    r = lay('<div class=w style="text-indent:40px"><div>a</div><span id=t>b</span></div>')
    expect(r['t'][0]).to eq(0)
  end

  # ── justify ──
  # A block just wide enough for "aa bb cc", so "aa bb cc dd" wraps before "dd": the first line is
  # justified over its two gaps, the last line is not. Against the same markup left-aligned.
  def justified(css = '')
    fits = (lay('<div><span id=t>aa bb cc</span></div>')['t'][2] + 1).ceil
    box  = ->(align) { "<div style=\"width:#{fits}px;text-align:#{align};white-space:normal\">aa <span id=b>bb</span> <span id=c>cc</span> <span id=d>dd</span></div>" }
    [fits, lay(box.call('left'), css), lay(box.call('justify'), css)]
  end

  it "spreads a wrapped line's free space over its gaps" do
    fits, left, just = justified
    free = fits - (left['c'][0] + left['c'][2])
    expect(just['b'][0]).to be_within(0.01).of(left['b'][0] + free / 2)
    expect(just['c'][0]).to be_within(0.01).of(left['c'][0] + free)
  end

  it 'leaves the last line alone' do
    _, left, just = justified
    expect(just['d'][0]).to eq(left['d'][0])
  end

  it 'widens an inline box that spans a gap' do
    fits = (lay('<div><span id=t>aa bb cc</span></div>')['t'][2] + 1).ceil
    box  = ->(align) { "<div style=\"width:#{fits}px;text-align:#{align};white-space:normal\">aa <span id=b style=\"white-space:normal\">bb cc</span> dd</div>" }
    left = lay(box.call('left'))
    just = lay(box.call('justify'))
    free = fits - (left['b'][0] + left['b'][2])
    expect(just['b'][0]).to be_within(0.01).of(left['b'][0] + free / 2)      # one gap before it…
    expect(just['b'][2]).to be_within(0.01).of(left['b'][2] + free / 2)      # …and one inside it
  end

  it 'counts each preserved space as a gap' do
    fits = (lay('<div><span id=t>aa  bb cc</span></div>')['t'][2] + 1).ceil
    box  = ->(align) { "<div style=\"width:#{fits}px;text-align:#{align};white-space:pre-wrap\">aa  <span id=b>bb</span> <span id=c>cc</span> dd</div>" }
    left = lay(box.call('left'))
    just = lay(box.call('justify'))
    # "aa  bb cc " fits (the trailing space hangs), "dd" wraps: three gaps, two of them in the
    # double space before `bb`.
    free = fits - (left['c'][0] + left['c'][2])
    expect(just['b'][0]).to be_within(0.01).of(left['b'][0] + free * 2 / 3)
    expect(just['c'][0]).to be_within(0.01).of(left['c'][0] + free)
  end

  # A run placed WHOLE — `white-space: pre` / `nowrap` — keeps its spaces inside, and Chrome widens
  # each of them like any other gap: the run itself grows, and what follows moves by its gaps too.
  it 'widens the spaces inside a nowrap run' do
    fits = (lay('<div><span id=t>aa bb cc</span></div>')['t'][2] + 1).ceil
    box  = ->(align) { "<div style=\"width:#{fits}px;text-align:#{align};white-space:normal\">aa <span id=b style=\"white-space:nowrap\">bb cc</span> dd</div>" }
    left = lay(box.call('left'))
    just = lay(box.call('justify'))
    free = fits - (left['b'][0] + left['b'][2])
    expect(just['b'][0]).to be_within(0.01).of(left['b'][0] + free / 2)
    expect(just['b'][2]).to be_within(0.01).of(left['b'][2] + free / 2)
  end

  it 'widens the spaces inside a pre run, a double space twice' do
    fits = (lay('<div><span id=t>aa  bb cc</span></div>')['t'][2] + 1).ceil
    box  = ->(align) { "<div style=\"width:#{fits}px;text-align:#{align};white-space:normal\"><span id=b>aa  bb</span> <span id=c>cc</span> dd</div>" }
    left = lay(box.call('left'))
    just = lay(box.call('justify'))
    free = fits - (left['c'][0] + left['c'][2])                          # three gaps, two in the run
    expect(just['b'][2]).to be_within(0.01).of(left['b'][2] + free * 2 / 3)
    expect(just['c'][0]).to be_within(0.01).of(left['c'][0] + free)
  end

  it 'start-aligns the lines it leaves alone in an rtl block' do
    r = lay('<div class=w style="direction:rtl;text-align:justify;white-space:normal">aa <span id=b>bb</span><br>cc</div>')
    expect(r['b'][0]).to be_within(0.01).of(300 - r['b'][2])
  end

  it 'leaves a line a <br> ends alone' do
    r = lay('<div class=w style="text-align:justify;white-space:normal">aa <span id=b>bb</span><br>cc</div>')
    expect(r['b'][0]).to be_within(0.01).of(lay('<div class=w>aa <span id=b>bb</span></div>')['b'][0])
  end

  # ── where the value comes from ──
  it 'inherits into a nested block' do
    x, w = xw(lay('<div class=w style="text-align:right"><div><span id=t>ab</span></div></div>'), 't')
    expect(x).to be_within(0.01).of(300 - w)
  end

  it 'reads a stylesheet rule' do
    x, w = xw(lay('<div class="w r"><span id=t>ab</span></div>', '.r { text-align: right }'), 't')
    expect(x).to be_within(0.01).of(300 - w)
  end

  it 'reads an inline declaration on the body' do
    x, w = xw(lay('<div class=w><span id=t>ab</span></div>', '', 'style="text-align:right"'), 't')
    expect(x).to be_within(0.01).of(300 - w)
  end

  it 'centres a table header cell' do
    r = lay('<table style="border-spacing:0"><tr><th style="width:100px;padding:0"><span id=t>ab</span></th></tr></table>')
    expect(r['t'][0]).to be_within(0.01).of((100 - r['t'][2]) / 2)
  end

  it 'centres a block inside a table header cell' do
    r = lay('<table style="border-spacing:0"><tr><th style="width:100px;padding:0"><div><span id=t>ab</span></div></th></tr></table>')
    expect(r['t'][0]).to be_within(0.01).of((100 - r['t'][2]) / 2)
  end

  it 'centres a block inside a button' do
    r = lay('<button style="width:200px;padding:0;border:0"><div><span id=t>ab</span></div></button>')
    expect(r['t'][0]).to be_within(0.01).of((200 - r['t'][2]) / 2)
  end

  it 'centres text and block children inside <center>' do
    r = lay('<center class=w><span id=t>ab</span><div id=b style="width:100px">x</div></center>')
    expect(r['t'][0]).to be_within(0.01).of((300 - r['t'][2]) / 2)
    expect(r['b'][0]).to eq(100)
  end

  it 'reads the align attribute of a block' do
    r = lay('<div class=w align=right><span id=t>ab</span><div id=b style="width:100px">x</div></div>')
    expect(r['t'][0]).to be_within(0.01).of(300 - r['t'][2])
    expect(r['b'][0]).to eq(200)
  end

  it 'reads the align attribute of a cell, over the UA centring of a header' do
    r = lay('<table style="border-spacing:0"><tr><td align=center style="width:100px;padding:0"><span id=t>ab</span></td>' \
            '<th align=left style="width:100px;padding:0"><span id=u>ab</span></th></tr></table>')
    expect(r['t'][0]).to be_within(0.01).of((100 - r['t'][2]) / 2)
    expect(r['u'][0]).to eq(100)
  end

  it 'follows an align attribute set after load' do
    s = page('<div id=b class=w><span id=t>ab</span></div>')
    s.execute_script("document.getElementById('b').setAttribute('align', 'right')")
    x, w = xw(rects(s), 't')
    expect(x).to be_within(0.01).of(300 - w)
  end

  it 'matches a list item to its parent' do
    x, w = xw(lay('<ul class=w style="text-align:right;padding:0;list-style:none"><li><span id=t>ab</span></li></ul>'), 't')
    expect(x).to be_within(0.01).of(300 - w)
  end

  it 'does nothing on an inline' do
    r = lay('<div class=w><span style="text-align:right"><span id=t>ab</span></span></div>')
    expect(r['t'][0]).to eq(0)
  end

  it 'follows a change of the declaration' do
    s = page('<div id=b class=w><span id=t>ab</span></div>')
    s.execute_script("document.getElementById('b').style.textAlign = 'right'")
    x, w = xw(rects(s), 't')
    expect(x).to be_within(0.01).of(300 - w)
    s.execute_script("document.getElementById('b').style.textAlign = ''")
    expect(rects(s)['t'][0]).to eq(0)
  end

  it 'moves an empty inline box with the line it opened on' do
    r = lay('<div class=w style="text-align:right"><span id=e></span><span id=t>abcd</span></div>')
    expect(r['e'][0]).to be_within(0.01).of(300 - r['t'][2])
  end

  # ── out-of-flow boxes on the line ──
  it 'gives an out-of-flow box the static position of the aligned line' do
    r = lay('<div class=w style="text-align:right"><span id=a style="position:absolute">x</span><span id=t>abcd</span></div>')
    expect(r['a'][0]).to be_within(0.01).of(300 - r['t'][2])
  end

  it 'places the static position after the content before it' do
    r = lay('<div class=w style="text-align:center"><span id=t>ab</span><span id=a style="position:absolute">x</span></div>')
    expect(r['a'][0]).to be_within(0.01).of((300 - r['t'][2]) / 2 + r['t'][2])
  end

  it 'moves a box placed on the spot as well as one held back' do
    # A containing block with a height of its own places the box at once, before the line closes.
    r = lay('<div class=w style="position:relative;height:30px;text-align:right"><span id=a style="position:absolute">x</span><span id=t>abcd</span></div>')
    expect(r['a'][0]).to be_within(0.01).of(300 - r['t'][2])
  end

  it 'leaves an inset-anchored box where its inset puts it' do
    r = lay('<div class=w style="text-align:right;position:relative"><span id=a style="position:absolute;right:0">x</span>ab</div>')
    expect(r['a'][0]).to be_within(0.01).of(300 - r['a'][2])
  end

  # ── the geometry is the one the rest reads ──
  it 'hit-tests the text where it was lined up' do
    s = page('<div class=w style="text-align:right"><span id=t>abcd</span></div>')
    x, w = xw(rects(s), 't')
    expect(s.evaluate_script("document.elementFromPoint(#{x + w / 2}, 5).id")).to eq('t')
    expect(s.evaluate_script('document.elementFromPoint(5, 5).id')).not_to eq('t')
  end

  it 'paints the words inside a justified pre run at their widened positions' do
    fits = (lay('<div><span id=t>aa bb cc</span></div>')['t'][2] + 1).ceil
    box  = ->(align) { "<div style=\"width:#{fits}px;text-align:#{align};white-space:normal\"><span id=b>aa bb</span> cc dd</div>" }
    s = page(box.call('left') + box.call('justify'))
    r = s.evaluate_script(<<~JS)
      (function () {
        var out = [];
        document.querySelectorAll('#b').forEach(function (el) { var q = el.getBoundingClientRect(); out.push([q.x, q.width, Math.floor(q.top), Math.ceil(q.bottom)]); });
        return out;
      })()
    JS
    path = File.join(Dir.tmpdir, "csim-tj-#{Process.pid}.png")
    begin
      s.driver.save_screenshot(path)
      img = Vips::Image.new_from_file(path)
      raw = img.write_to_memory
      bands = img.bands
      # The right edge of the ink in each run's own band: "bb" ends where the run ends.
      ink_right = lambda do |(_x, _w, y0, y1)|
        (0...img.width).select {|x| (y0...y1).any? {|y| raw.byteslice(((y * img.width) + x) * bands, 3).bytes[0] < 128 } }.max
      end
      shift = ink_right.call(r[1]) - ink_right.call(r[0])
      expect(shift).to be_within(1.5).of(r[1][1] - r[0][1])              # by the run's widening
    ensure
      File.delete(path) if File.exist?(path)
    end
  end

  it 'paints the glyphs where the line was lined up' do
    s = page('<div class=w><span id=u>abcd</span></div><div class=w style="text-align:right"><span id=t>abcd</span></div>')
    r = rects(s)
    band = ->(id) { [r[id][1].floor, (r[id][1] + r[id][3]).ceil] }
    path = File.join(Dir.tmpdir, "csim-ta-#{Process.pid}.png")
    begin
      s.driver.save_screenshot(path)
      img = Vips::Image.new_from_file(path)
      raw = img.write_to_memory
      bands = img.bands
      ink_left = lambda do |(y0, y1)|
        (0...img.width).find {|x| (y0...y1).any? {|y| raw.byteslice(((y * img.width) + x) * bands, 3).bytes[0] < 128 } }
      end
      shift = ink_left.call(band.call('t')) - ink_left.call(band.call('u'))
      expect(shift).to be_within(1.5).of(300 - r['t'][2])              # ± antialiasing
    ensure
      File.delete(path) if File.exist?(path)
    end
  end
end
