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

  # ── every atomic inline is shrink-to-fit ──
  it 'keeps the right padding of an inline-block around a block child' do
    (width, _), = measure('<div><div id=t style="display:inline-block;border:2px solid;padding:1px 6px"><div style="width:80px;height:10px"></div></div></div>')
    expect(width).to eq(96)
  end

  it 'sizes an inline-block from its widest line once it wraps' do
    (width, height), w = measure('<div style="width:60px"><span id=t style="display:inline-block">abcdefghij kl</span></div>')
    expect(width).to be_within(0.01).of(w.call('abcdefghij'))              # the min-content wins over the room
    expect(height).to be_within(0.01).of(2 * measure('<div id=t>a</div>')[0][1])
  end

  it 'fills the room an inline-block\'s content overflows' do
    (width, _), = measure('<div style="width:100px"><span id=t style="display:inline-block">aaaa bbbb cccc</span></div>')
    expect(width).to eq(100)
  end
end
