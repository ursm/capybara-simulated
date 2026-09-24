# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A box's INTRINSIC widths — what it wants before anyone says how much room it gets — decide a
# table cell, a float, a flex item, an inline-block and `width: min-content` / `max-content`.
# They were measured one node at a time, from zero, and summed: a two-line `<pre>` wanted both
# its lines together, a tab in a `<b>` sat at the first stop instead of the pen's, a word an
# inline box cut ("ab<b>cd</b>") counted as two words, and an inline-block was sized from a text
# estimate patched afterwards, which lost the right padding of one holding a block child.
#
# One walk over the inline content with a pen now, the way the flow lays a line (Chrome-measured,
# 18 + 5 cases at 16px monospace, all matched): the widest LINE is the max-content width, the
# widest unbreakable run — across inline boundaries — the min-content width, a preserved newline
# or a `<br>` ends a line wherever it sits, a tab advances from the pen, and every atomic inline
# is shrink-to-fit.
#
# Every width is a formula over runs measured on the same page.
RSpec.describe 'intrinsic widths' do
  def page(body, css = '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { margin: 0; font: 16px monospace }
          pre { margin: 0; font: 16px monospace; display: inline-block }
          #{css}
        </style></head><body>#{body}<span id="__w" style="white-space:pre"></span></body></html>
      HTML
    })
    session.visit '/'
    session
  end

  # `[width, height]` of `#t`, and a measurer for runs in the page's font.
  def measure(body, css = '')
    s = page(body, css)
    r = s.evaluate_script("(function () { var r = document.getElementById('t').getBoundingClientRect(); return [r.width, r.height]; })()")
    w = ->(text) { s.evaluate_script("(function () { var p = document.getElementById('__w'); p.textContent = #{text.to_json}; return p.getBoundingClientRect().width; })()") }
    [r, w]
  end

  it 'wants the wider line of a two-line pre, not both' do
    (width, _), w = measure("<pre id=t>abcd\nef</pre>")
    expect(width).to be_within(0.01).of(w.call('abcd'))
  end

  it 'ends a line at a <br> inside a pre' do
    (width, _), w = measure('<pre id=t>ab<br>cdef</pre>')
    expect(width).to be_within(0.01).of(w.call('cdef'))
  end

  it 'carries the pen across an inline box for a tab' do
    (width, _), w = measure("<pre id=t>ab<b>\tc</b>d</pre>")
    expect(width).to be_within(0.01).of(8 * w.call(' ') + w.call('cd'))
  end

  it 'measures a tab inside a bigger inline at the block\'s stop' do
    (width, _), w = measure("<pre id=t><span style=\"font-size:32px\">ab\t</span>cd</pre>")
    expect(width).to be_within(0.01).of(8 * w.call(' ') + w.call('cd'))
  end

  it 'counts an inline box\'s padding into the pen' do
    (width, _), w = measure("<pre id=t>ab<span style=\"padding-left:30px\">\tX</span></pre>")
    expect(width).to be_within(0.01).of(8 * w.call(' ') + w.call('X'))
  end

  it 'lets an inline-block advance the pen before a tab' do
    (width, _), w = measure("<pre id=t>ab<span style=\"display:inline-block;width:100px\"></span>\tX</pre>")
    expect(width).to be_within(0.01).of(16 * w.call(' ') + w.call('X'))    # 100 + "ab" passes the first stop
  end

  it 'keeps a pre run\'s trailing spaces as content' do
    (width, _), w = measure('<pre id=t>ab   </pre>')
    expect(width).to be_within(0.01).of(w.call('ab   '))
  end

  it 'takes the longest word of a pre-wrap block as its min-content' do
    (width, _), w = measure("<pre id=t style=\"white-space:pre-wrap;width:min-content\">aaaa bbbb   cc\ndddddd</pre>")
    expect(width).to be_within(0.01).of(w.call('dddddd'))
  end

  it 'takes the widest line of a pre-wrap block as its max-content' do
    (width, _), w = measure("<pre id=t style=\"white-space:pre-wrap;width:max-content\">aaaa bbbb\ncc</pre>")
    expect(width).to be_within(0.01).of(w.call('aaaa bbbb'))
  end

  it 'collapses spaces but keeps newlines under pre-line' do
    (width, _), w = measure("<pre id=t style=\"white-space:pre-line\">aaaa   bbbb\ncc</pre>")
    expect(width).to be_within(0.01).of(w.call('aaaa bbbb'))
  end

  it 'sizes a table cell from the pre it holds' do
    (width, _), w = measure("<table style=\"border-spacing:0\"><tr><td id=t style=\"padding:5px\"><pre style=\"display:block\">ab\t<span>X</span></pre></td></tr></table>")
    expect(width).to be_within(0.01).of(10 + 8 * w.call(' ') + w.call('X'))
  end

  it 'sizes a float from the wider line' do
    (width, _), w = measure("<pre id=t style=\"display:block;float:left\">abcdef\nab</pre>")
    expect(width).to be_within(0.01).of(w.call('abcdef'))
  end

  # ── width keywords on a block ──
  it 'honours width: max-content on a block' do
    (width, _), w = measure('<div id=t style="width:max-content">aa bb</div>')
    expect(width).to be_within(0.01).of(w.call('aa bb'))
  end

  it 'honours width: min-content on a block' do
    (width, height), w = measure('<div id=t style="width:min-content">aa bb</div>')
    expect(width).to be_within(0.01).of(w.call('bb'))
    expect(height).to be_within(0.01).of(2 * measure('<div id=t>aa</div>')[0][1])   # two lines
  end

  it 'honours width: max-content on a block pre' do
    (width, _), w = measure("<pre id=t style=\"display:block;width:max-content\">abcdef\nab</pre>")
    expect(width).to be_within(0.01).of(w.call('abcdef'))
  end

  it 'joins the words an inline box cuts for min-content' do
    (width, _), w = measure('<div id=t style="width:min-content">a ab<b>cd</b> b</div>')
    expect(width).to be_within(0.01).of(w.call('abcd'))
  end

  # ── what the review round measured ──
  it 'counts a replaced element into a cell' do
    width = measure('<table style="border-spacing:0;width:100px"><tr><td id=t style="padding:0"><img width=40 height=40></td><td style="padding:0">aaaa bbbb cccc dddd eeee</td></tr></table>')[0][0]
    expect(width).to eq(40)
  end

  it 'takes a wide character as its own unbreakable unit' do
    (width, _), w = measure('<div id=t style="width:min-content">日本語テキスト</div>')
    expect(width).to be_within(0.01).of(w.call('日'))
  end

  it 'breaks a word at a <wbr>' do
    (width, _), w = measure('<div id=t style="width:min-content">aaaa<wbr>bbbb</div>')
    expect(width).to be_within(0.01).of(w.call('aaaa'))
  end

  it 'keeps a no-break space as content' do
    (width, _), w = measure('<span id=t style="display:inline-block">aa&nbsp;</span>')
    expect(width).to be_within(0.01).of(w.call("aa\u00A0"))
  end

  it 'walks through a display: contents box' do
    (width, _), w = measure('<span id=t style="display:inline-block;white-space:nowrap">a <span style="display:contents">bb cc</span> d</span>')
    expect(width).to be_within(0.01).of(w.call('a bb cc d'))
  end

  it 'joins the spaces of a nowrap run into one unit' do
    (width, _), w = measure('<table style="border-spacing:0;width:30px"><tr><td id=t style="padding:0">a <span style="white-space:nowrap">bb cc</span> d</td></tr></table>')
    expect(width).to be_within(0.01).of(w.call('bb cc'))
  end

  it 'puts an atomic inline\'s margins on the line' do
    (width, _), w = measure('<span id=t style="display:inline-block">a<span style="display:inline-block;width:20px;margin:0 7px"></span>b</span>')
    expect(width).to be_within(0.01).of(w.call('ab') + 34)
  end

  it 'indents the first line of both figures' do
    (width, _), w = measure('<div id=t style="width:max-content;text-indent:30px">aa bb</div>')
    expect(width).to be_within(0.01).of(30 + w.call('aa bb'))
    hidden = measure('<span id=t style="display:inline-block;padding:0 5px;text-indent:-9999px">Label</span>')[0][0]
    expect(hidden).to eq(10)
  end

  # …and it is TAKEN by the first thing that occupies the line — a word, an atomic, an inline box, a `<br>`, a
  # `<wbr>` — never by a line nothing occupies. Every number here is Chrome's (16px default face), and these read
  # the ORACLE's geometry only; the native engine's parity on the same shapes is held by the native_layout specs
  # (an empty inline box taking the indent is a shape native's measure REFUSES — its record has no box to take it).
  describe 'the first-line text-indent goes to the line\'s first occupant' do
    it 'gives it to the first word, not to a collapsible space before it' do
      (width, _), w = measure('<div id=t style="width:min-content;text-indent:40px"> aa bbbb</div>')
      expect(width).to be_within(0.01).of(40 + w.call('aa'))
    end
    it 'gives it to a <br>, a <wbr> and an empty inline box alike' do
      expect(measure('<span id=t style="display:inline-block;text-indent:40px"><br>t</span>')[0][0]).to be_within(0.01).of(40)
      expect(measure('<div id=t style="width:min-content;text-indent:40px"><wbr>aa bbbb</div>')[0][0]).to be_within(0.01).of(40)
      expect(measure('<span id=t style="display:inline-block;text-indent:40px"><b></b><div style="height:3px"></div>t</span>')[0][0]).to be_within(0.01).of(40)
      expect(measure('<span id=t style="display:inline-block;text-indent:40px"><b style="padding-left:10px"></b><div style="height:3px"></div>t</span>')[0][0]).to be_within(0.01).of(50)
    end
    # …and a line nothing lands on carries none: a block-level child ends it without placing it, and an empty
    # box never opens one (Chrome measures both at what follows, not at the indent).
    it 'drops it where no line is occupied' do
      (width, _), w = measure('<span id=t style="display:inline-block;text-indent:40px"><div style="height:3px"></div>t</span>')
      expect(width).to be_within(0.01).of(w.call('t'))
      expect(measure('<span id=t style="display:inline-block;text-indent:40px"></span>')[0][0]).to eq(0)
      # …which is what an EMPTY CELL under an inherited indent wants too — 0, where it measured the indent and
      # took the whole table 20px wide with it. (Its sibling, which does hold text, keeps the indent: Chrome
      # gives that one 20 + its text.)
      empty_cell = measure('<table style="text-indent:20px;border-spacing:0"><tr><td id=t style="height:4px;padding:0"></td><td style="padding:0">c</td></tr></table>')[0][0]
      expect(empty_cell).to eq(0)
    end
    # `each-line` starts every line after a FORCED break indented, so the widest line of `aa<br>bbbb` is the
    # SECOND one (Chrome: 72, where indenting only the first said 54.2).
    # …and a PRESERVED segment occupies its line as much as a word does, an empty one included (a leading
    # newline makes a real first line: Chrome 40).
    it 'gives it to a preserved segment' do
      (width, _), w = measure('<span id=t style="display:inline-block;white-space:pre;text-indent:40px">aa</span>')
      expect(width).to be_within(0.01).of(40 + w.call('aa'))
      expect(measure(%(<span id=t style="display:inline-block;white-space:pre;text-indent:40px">\naa</span>))[0][0]).to be_within(0.01).of(40)
    end
    it 'indents again after a forced break under each-line' do
      (each_line, _), w = measure('<span id=t style="display:inline-block;text-indent:40px each-line">aa<br>bbbb</span>')
      expect(each_line).to be_within(0.01).of(40 + w.call('bbbb'))      # the SECOND line is the widest
      first_only = measure('<span id=t style="display:inline-block;text-indent:40px">aa<br>bbbb</span>')[0][0]
      expect(first_only).to be_within(0.01).of(40 + w.call('aa'))
      hanging = measure('<span id=t style="display:inline-block;text-indent:40px each-line hanging">aa<br>bbbb</span>')[0][0]
      expect(hanging).to be_within(0.01).of(w.call('bbbb'))
    end
    # `hanging` indents every line BUT the first, in the measure as in the flow — so the widest line of
    # `aa<br>bbbb` is the indented second one (Chrome 72). Re-arming only for `each-line` shrink-wrapped the box
    # to 32 and let its own second line overflow it.
    it 'indents every line but the first under hanging' do
      (width, _), w = measure('<span id=t style="display:inline-block;text-indent:40px hanging">aa<br>bbbb</span>')
      expect(width).to be_within(0.01).of(40 + w.call('bbbb'))
      after_block = measure('<span id=t style="display:inline-block;text-indent:40px hanging">a<div></div>bbbb</span>')[0][0]
      expect(after_block).to be_within(0.01).of(40 + w.call('bbbb'))
    end
  end

  it 'gives every break-spaces space its width and a break after it' do
    (width, _), w = measure('<div id=t style="width:min-content;white-space:break-spaces">aa   bb</div>')
    expect(width).to be_within(0.01).of(w.call('aa '))
  end

  it 'lets a block child\'s negative margin narrow the box' do
    width = measure('<span id=t style="display:inline-block"><div style="width:100px;margin-right:-50px;height:5px"></div></span>')[0][0]
    expect(width).to eq(50)
  end

  it 'collapses the space after an empty inline box, padded or not' do
    (width, _), w = measure('<div id=t style="width:max-content"><span style="padding-left:5px"></span> aa</div>')
    expect(width).to be_within(0.01).of(5 + w.call('aa'))
  end

  # ── every atomic inline is shrink-to-fit ──
  it 'keeps the right padding of an inline-block around a block child' do
    width = measure('<div><div id=t style="display:inline-block;border:2px solid;padding:1px 6px"><div style="width:80px;height:10px"></div></div></div>')[0][0]
    expect(width).to eq(96)
  end

  it 'sizes an inline-block from its widest line once it wraps' do
    (width, height), w = measure('<div style="width:60px"><span id=t style="display:inline-block">abcdefghij kl</span></div>')
    expect(width).to be_within(0.01).of(w.call('abcdefghij'))              # the min-content wins over the room
    expect(height).to be_within(0.01).of(2 * measure('<div id=t>a</div>')[0][1])
  end

  it 'fills the room an inline-block\'s content overflows' do
    width = measure('<div style="width:100px"><span id=t style="display:inline-block">aaaa bbbb cccc</span></div>')[0][0]
    expect(width).to eq(100)
  end
end
