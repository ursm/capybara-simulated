# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Line breaking. Text used to wrap by ESTIMATE — the run's total width over the
# available width — which is right only when the words happen to pack perfectly. A
# `<br>` didn't break at all, a `white-space: nowrap` block wrapped anyway, the
# newline a `pre-wrap` block preserves was dropped, and a box too narrow to hold even
# one word took four lines where Chrome takes three.
#
# Now the flow breaks greedily, word by word, the way a browser does. Every
# expectation is Chrome 137-measured (headless, 1024x768) and written against
# widths measured in the page itself, so it holds whatever face fontconfig serves.
RSpec.describe 'line breaking' do
  include LayoutMeasure

  # The greedy rule itself: words go on the line while they fit, and the first one
  # that doesn't starts the next. A break EATS the space it happens at, so a word
  # that fits is not pushed down by its own trailing space — the bug that made a
  # 140px box take three lines where Chrome takes two.
  it 'fills each line with the words that fit and breaks at the first that does not' do
    text = 'wrapped text inside a narrow table cell'
    boxes, w, line = measure(%(<div id="d" style="width:140px">#{text}</div>), ['#d'],
                             probes: [text, 'wrapped text inside', 'wrapped text inside a'])
    expect(w['wrapped text inside']).to be <= 140      # …so it shares one line
    expect(w['wrapped text inside a']).to be > 140     # …and the next word starts another
    expect(boxes[0][3]).to eq(line * 2)                # Chrome: 36
  end

  it 'gives a word wider than the line a line of its own rather than counting area' do
    # Chrome: three words in a 30px box are three lines, each overflowing it — not
    # the four the total-width-over-available estimate produced.
    boxes, _w, line = measure('<div id="d" style="width:30px">The quick brown</div>', ['#d'])
    expect(boxes[0][3]).to eq(line * 3)
  end

  # U+00A0 is a character a line may NOT break at — and JS `\s` matches it, which is
  # the trap this has to step around: `10&nbsp;kg` must stay together.
  it 'never breaks at a no-break space' do
    boxes, _w, line = measure('<div id="d" style="width:100px">aaaa&nbsp;bbbb&nbsp;cccc&nbsp;dddd</div>', ['#d'])
    expect(boxes[0][3]).to eq(line)                    # Chrome: one line, overflowing
  end

  # `pre-line` collapses SPACES but keeps NEWLINES — two independent axes.
  it 'breaks at a newline a pre-line block keeps while still collapsing its spaces' do
    boxes, _w, line = measure(%(<div id="d" style="width:400px;white-space:pre-line">one\ntwo\nthree</div>), ['#d'])
    expect(boxes[0][3]).to eq(line * 3)                # Chrome: 54
  end

  # `<pre>` is the element built around preserved newlines, and its `white-space` is
  # a UA rule — read only the author cascade and the headline feature misses it.
  it 'preserves the newlines in a <pre> without an author rule' do
    # A leading newline right after `<pre>` is dropped by the parser, so this is two
    # lines — measured against a one-line `<pre>`, because a `<pre>`'s line height
    # comes from the UA's MONOSPACE font, which differs from box to box.
    boxes, = measure(%(<pre id="d" style="margin:0">\none\ntwo</pre><pre id="one" style="margin:0">one</pre>), ['#d', '#one'])
    expect(boxes[0][3]).to eq(boxes[1][3] * 2)         # Chrome: two lines, 44 with its monospace
  end

  # A word that cannot fit breaks mid-word only where the page asked for it.
  it 'breaks inside a word only for word-break / overflow-wrap' do
    long = 'Supercalifragilisticexpial'
    plain, _w, line = measure(%(<div id="d" style="width:80px">#{long}</div>), ['#d'])
    all,   = measure(%(<div id="d" style="width:80px;word-break:break-all">#{long}</div>), ['#d'])
    word,  = measure(%(<div id="d" style="width:80px;overflow-wrap:break-word">#{long}</div>), ['#d'])
    expect(plain[0][3]).to eq(line)                    # Chrome: one line, overflowing
    expect(all[0][3]).to eq(line * 3)                  # Chrome: three
    expect(word[0][3]).to eq(line * 3)
  end

  # CJK has no spaces at all: the break opportunity is between the characters, which
  # is the same classifier the advance table already uses. (The LINE HEIGHT of a CJK
  # run comes from the fallback font's metrics, which we don't model — Chrome's box
  # is 24 per line to our 18 — so this pins the line COUNT.)
  it 'breaks between wide characters' do
    boxes, _w, line = measure('<div id="d" style="width:100px">日本語のテキストは空白がありません</div>', ['#d'])
    expect(boxes[0][3]).to eq(line * 3)                # Chrome: three lines, of 24 each
  end

  it 'never breaks a nowrap block' do
    boxes, _w, line = measure('<div id="d" style="width:100px;white-space:nowrap">This text must not wrap at all</div>', ['#d'])
    expect(boxes[0][3]).to eq(line)
  end

  # `pre-wrap` keeps its newlines AND still wraps what is too long for the line.
  it 'breaks at a preserved newline and wraps the rest' do
    body = %(<div id="d" style="width:120px;white-space:pre-wrap">line one\nand a much longer second line</div>)
    boxes, _w, line = measure(body, ['#d'])
    expect(boxes[0][3]).to eq(line * 4)                # Chrome: 72
  end

  it 'ends the line at a <br>' do
    boxes, _w, line = measure('<div id="d" style="width:300px">before<br>after<br>third</div>', ['#d'])
    expect(boxes[0][3]).to eq(line * 3)                # Chrome: 54
  end

  # A wrapped line is what an auto-height block, and everything below it, is sized
  # from — the reason this is worth being exact about.
  it 'sizes the block, and the flow under it, from the lines it really took' do
    text = 'The quick brown fox jumps over the lazy dog and keeps on running'
    body = %(<div id="a" style="width:200px">#{text}</div><div id="after">after</div>)
    boxes, _w, line = measure(body, ['#a', '#after'], probes: [text])
    a, after = boxes
    expect(a[3]).to eq(line * 3)                       # Chrome: 54
    expect(after[1]).to eq(a[1] + a[3])
  end

  # Inline-level boxes wrap on the same lines the text does.
  it 'wraps a row of inline-blocks onto as many lines as they need' do
    body = '<div id="d" style="width:210px">' \
           '<span style="display:inline-block;width:90px;height:12px"></span>' \
           '<span style="display:inline-block;width:90px;height:12px"></span>' \
           '<span style="display:inline-block;width:90px;height:12px"></span></div>'
    boxes, _text, line = measure(body, ['#d'])
    # Two lines — and each is a LINE box, not the height of the 12px boxes on it: they hang from
    # its baseline and the block's own strut keeps it 18 tall (re-measured in Chrome 151: 36, with
    # the boxes at y=2, 2 and 20).
    expect(boxes[0][3]).to eq(line * 2)
  end

  # The same breaking inside a table cell, whose column width is what it wraps to.
  it 'wraps a table cell to its column' do
    body = '<table><tr><td id="c" style="width:140px">wrapped text inside a narrow table cell</td></tr></table>'
    boxes, _w, line = measure(body, ['#c'])
    expect(boxes[0][3]).to eq(line * 2 + 2)            # Chrome: 38, the 2 being the UA cell padding
  end
end
