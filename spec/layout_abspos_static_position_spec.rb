# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSS Flexbox §4.1: an absolutely-positioned child of a flex container takes no part in the flex
# layout, but its STATIC POSITION — where it lands when its insets are `auto` — is where it would
# sit if it were the SOLE flex item of the line: the container's `justify-content` along the main
# axis, its own `align-self` (else the container's `align-items`) across it. A dropdown anchored
# inside a centred toolbar opens under the centre, not at the toolbar's left edge.
#
# Every figure here is a Chrome 151 measurement of the same markup, read the way WPT's own layout
# oracle reads it — `offsetLeft` / `offsetTop`, which are measured from the offsetParent's PADDING
# edge (a container with a 1px border reports 2, not 3, for a box at its content origin).
RSpec.describe 'the static position of an abspos flex child' do
  # The WPT shape: a 16x10 content box wearing `padding: 1px 2px; border: 1px`, holding one 8x6
  # absolutely positioned child — so the free space is 8 across and 4 down.
  def offsets(container, child = '')
    body = <<~HTML
      <div id="c" style="display:flex;position:relative;padding:1px 2px;border:1px solid;
                         height:10px;width:16px;#{container}">
        <div id="a" style="position:absolute;height:6px;width:8px;#{child}"></div>
      </div>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<body style="margin:0">#{body}</body>)]] })
    s.visit '/'
    s.evaluate_script("(e => [e.offsetLeft, e.offsetTop])(document.getElementById('a'))")
  end

  it 'places it by justify-content along the main axis' do
    expect(offsets('')).to                              eq([2, 1])   # the content origin
    expect(offsets('justify-content:center')).to        eq([6, 1])
    expect(offsets('justify-content:flex-end')).to      eq([10, 1])
    expect(offsets('justify-content:end')).to           eq([10, 1])
    expect(offsets('justify-content:right')).to         eq([10, 1])
    # A distribution keyword with ONE item is its fallback alignment: `space-between` packs at the
    # start, `space-around` and `space-evenly` centre.
    expect(offsets('justify-content:space-between')).to eq([2, 1])
    expect(offsets('justify-content:space-around')).to  eq([6, 1])
    expect(offsets('justify-content:space-evenly')).to  eq([6, 1])
    # …and `normal` / `stretch` are the start edge.
    expect(offsets('justify-content:normal')).to        eq([2, 1])
    expect(offsets('justify-content:stretch')).to       eq([2, 1])
  end

  it 'places it by align-self across the cross axis' do
    expect(offsets('align-items:center')).to        eq([2, 3])
    expect(offsets('align-items:flex-end')).to      eq([2, 5])
    expect(offsets('', 'align-self:center')).to     eq([2, 3])
    expect(offsets('align-items:center', 'align-self:flex-start')).to eq([2, 1])
    # `baseline` is the start edge for a single-line box; `last baseline` is the far one.
    expect(offsets('', 'align-self:baseline')).to      eq([2, 1])
    expect(offsets('', 'align-self:last baseline')).to eq([2, 5])
  end

  it 'lets it hang off the edges when the container is smaller than it' do
    # A 4x2 content box holding the same 8x6 child: the free space is negative, and Chrome places
    # it anyway — `center` at 0, `end` at -2. A DISTRIBUTION keyword still falls back to its
    # alignment here, which an in-flow line does not do (that packs at the start).
    small = 'height:2px;width:4px;'
    expect(offsets("#{small}justify-content:center")).to        eq([0, 1])
    expect(offsets("#{small}justify-content:end")).to           eq([-2, 1])
    expect(offsets("#{small}justify-content:space-around")).to  eq([0, 1])
    expect(offsets("#{small}justify-content:space-evenly")).to  eq([0, 1])
    expect(offsets("#{small}justify-content:space-between")).to eq([2, 1])
    # …and the cross axis hangs off too when it is asked to centre.
    expect(offsets("#{small}align-items:center")).to            eq([2, -1])
  end

  it 'reads the main axis of a COLUMN down the page' do
    col = 'flex-flow:column;'
    expect(offsets("#{col}justify-content:center")).to   eq([2, 3])
    expect(offsets("#{col}justify-content:flex-end")).to eq([2, 5])
    expect(offsets("#{col}align-items:center")).to       eq([6, 1])
    # `left` / `right` name the INLINE axis, which a column's main axis is not — so there they are
    # the start edge, not the end one.
    expect(offsets("#{col}justify-content:right")).to    eq([2, 1])
    expect(offsets("#{col}justify-content:left")).to     eq([2, 1])
  end

  it 'runs the other way for a reversed container' do
    expect(offsets('flex-flow:row-reverse')).to                        eq([10, 1])
    expect(offsets('flex-flow:row-reverse;justify-content:flex-end')).to eq([2, 1])
    # …but `right` is PHYSICAL: it stays the physical right edge whichever way the line runs.
    expect(offsets('flex-flow:row-reverse;justify-content:right')).to  eq([10, 1])
  end
end
