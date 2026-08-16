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

  # The width above is the fix for the space AT the break: it advances the line like any
  # other, but a break eats it, so it is not part of what the box covers. Counting it made
  # every wrapped inline exactly one space too wide.
  it 'ends a fragment at the last glyph, not at the space that broke the line' do
    body = '<div id="d" style="width:100px"><span id="s">wrap wrap wrap</span></div>'
    boxes, w = measure(body, ['#s'], probes: ['wrap wrap', 'wrap wrap '])
    expect(w['wrap wrap ']).to be > w['wrap wrap']
    expect(boxes[0][2]).to be_within(0.05).of(w['wrap wrap'])
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
    # Chrome: both are [0, 72, 73.8, 35] — the inner one opens on line 1 after "wrap "
    # and finishes line 2, so its union reaches the left edge too.
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

  # An inline box with nothing in it generates no line box at all — Chrome reports an
  # empty rect for it and gives the block around it a height of 0.
  it 'generates no line box for an empty inline' do
    boxes, = measure('<div id="d"><span id="s"></span></div>', ['#d', '#s'])
    expect(boxes[0][3]).to eq(0)
    expect(boxes[1][2, 2]).to eq([0, 0])
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
