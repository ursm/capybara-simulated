# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/layout_measure'

# Flex MAIN-AXIS sizing, both ways round. A row already resolved its widths together; a column
# fell through to block flow, which stacks items correctly and sizes them not at all — a `flex: 1`
# pane was as tall as the words in it. Avo's sidebar is the shape that made it matter: its scroll
# area should be 887 (960 less the 73px profile row) and came out 960, which pushed the profile
# past the bottom of the sidebar, and `stimulus-use`'s `useClickOutside` — `onlyVisible: true` —
# then never closed the dropdown.
#
# Every figure below is a Chrome 151 measurement of the same markup (headless, 1024x768), taken in
# a 600px-wide container so the arithmetic in each expectation is visible.
RSpec.describe 'flex sizing' do
  include LayoutMeasure

  # Lay out one flex container and report `[x, y, width, height]` per item, with the container's
  # own box last — auto heights are half of what these examples are about.
  def flex(container, items, probes: [])
    body = <<~HTML
      <div id="c" style="width:600px;display:flex;#{container}">
        #{items.each_with_index.map {|item, i| %(<div id="i#{i}" style="#{item}">item#{i}</div>) }.join}
      </div>
    HTML
    ids = (0...items.length).map {|i| "#i#{i}" } + ['#c']
    boxes, text, line = measure(body, ids, probes: probes)
    [boxes.map {|b| b.map {|n| n.round(2) } }, text, line]
  end

  def heights(container, items) = flex(container, items).first.map {|b| b[3] }
  def tops(container, items)    = flex(container, items).first.map {|b| b[1] }

  describe 'a column' do
    it 'gives a grower what the fixed items leave' do
      # Chrome: 73 + 327 in a 400px column — the Avo sidebar.
      expect(heights('flex-direction:column;height:400px', ['height:73px', 'flex:1'])).to eq([73, 327, 400])
      # `flex: <n>` bases at 0%, so the WHOLE column is shared by the grow factors, not just what
      # is left over: 1 and 2 in 300px are 100 and 200.
      expect(heights('flex-direction:column;height:300px', ['flex:1', 'flex:2'])).to eq([100, 200, 300])
    end

    it 'takes space back from items that overflow it' do
      # Two 300px items in a 200px column shrink together (Chrome: 100 each), never past the
      # content each of them needs — a line of text is 18 tall, and a 20px column leaves both at
      # 18 rather than 10.
      expect(heights('flex-direction:column;height:200px', ['height:300px', 'height:300px'])).to eq([100, 100, 200])
      expect(heights('flex-direction:column;height:20px', ['', ''])).to eq([18, 18, 20])
      # `min-height: 0` is the page saying it means it, and then they do shrink.
      expect(heights('flex-direction:column;height:20px', ['min-height:0', 'min-height:0'])).to eq([10, 10, 20])
      # An item that cannot shrink keeps its size and its sibling gives up the whole deficit.
      expect(heights('flex-direction:column;height:100px', ['height:80px;flex-shrink:0', 'height:80px']))
        .to eq([80, 20, 100])
    end

    it 'reads flex-basis as a height, and a clamp frees the space it did not take' do
      # A basis is a CONTENT size unless `box-sizing` says otherwise, and a percentage one resolves
      # against the column's own main size: 120 and 30% of 300.
      expect(heights('flex-direction:column;height:300px', ['flex:0 0 120px', 'flex:0 0 30%'])).to eq([120, 90, 300])
      expect(heights('flex-direction:column;height:300px', ['flex:0 0 120px;padding:10px'])).to eq([140, 300])
      # §9.7: an item frozen at its `max-height` hands what it did not take back to the line, so
      # the other grower gets 220 — not the 150 an even split gives.
      expect(heights('flex-direction:column;height:300px', ['flex:1;max-height:80px', 'flex:1'])).to eq([80, 220, 300])
    end

    it 'floors an item at its content, capped by a height the page declared' do
      # `min-height: auto` on a flex item is its content — a `flex-basis: 0` item is still as tall
      # as the line it holds, even in a column with no height to hand out.
      expect(heights('flex-direction:column', ['flex:1 1 0px'])).to eq([18, 18])
      # …but a declared height caps that minimum (CSS Flexbox §4.5), so three lines in a 20px item
      # overflow it exactly as they do in block flow.
      expect(heights('flex-direction:column;height:300px', ['height:20px', 'flex:1'])).to eq([20, 280, 300])
    end

    it 'decides which way it flexes from the sizes the clamps leave, not from the bases' do
      # A `flex: 1` pane bases at 0 and is still floored at its content, so a 900px pane beside a
      # 50px header in a 300px column makes that line SHRINK: Chrome takes the header down to the
      # 18 its own text needs and leaves the pane at 900, overflowing the column.
      body = <<~HTML
        <div id="c" style="width:600px;display:flex;flex-direction:column;height:300px">
          <div id="head" style="height:50px">head</div>
          <div id="pane" style="flex:1"><div style="height:900px">tall</div></div>
        </div>
      HTML
      boxes, = measure(body, ['#head', '#pane', '#c'])
      expect(boxes.map {|b| b[3] }).to eq([18, 900, 300])
      # …and the column reports the overflow as what it scrolls.
      expect(boxes[2][3]).to eq(300)
    end

    it 'gives a SCROLLING item no automatic minimum at all' do
      # §4.5: a scroll container's automatic minimum is zero, which is what lets an
      # `overflow-y: auto` pane take the height its column hands it rather than the height of
      # everything inside it — Chrome makes it 227 of a 300px column beside a 73px row, where the
      # same pane with visible overflow holds all 900 and pushes its sibling out.
      pane = '<div style="height:900px">tall</div>'
      body = <<~HTML
        <div id="c" style="width:600px;display:flex;flex-direction:column;height:300px">
          <div id="scrolls" style="flex:1;overflow-y:auto">#{pane}</div>
          <div id="profile" style="height:73px">profile</div>
        </div>
      HTML
      boxes, = measure(body, ['#scrolls', '#profile'])
      expect(boxes.map {|b| [b[1], b[3]] }).to eq([[0, 227], [227, 73]])
      boxes, = measure(body.sub('overflow-y:auto', ''), ['#scrolls', '#profile'])
      expect(boxes.map {|b| [b[1], b[3]] }).to eq([[0, 900], [900, 18]])
    end

    it 'sizes itself from its items, and from the floor a min-height puts under them' do
      # An auto-height column is what its items consume — including a last item's bottom margin.
      expect(heights('flex-direction:column', ['height:40px', ''])).to eq([40, 18, 58])
      expect(heights('flex-direction:column', ['height:30px;margin-bottom:25px'])).to eq([30, 55])
      # A `min-height` makes the main size definite, so the grower divides THAT rather than
      # collapsing to its content (`min-h-screen` on a page shell is the idiom).
      expect(heights('flex-direction:column;min-height:200px', ['height:40px', 'flex:1'])).to eq([40, 160, 200])
      # With no definite height there is no free space either way — nothing grows into it and
      # nothing is squeezed out of it, whatever the items' factors say.
      expect(heights('flex-direction:column', ['flex:1 1 0', 'height:40px;min-height:0'])).to eq([18, 40, 58])
    end

    it 'never collapses the margins between its items' do
      # 30 and 20 adjoining make 50 in a flex column, where block flow collapses them to 30 — and
      # both come out of what the grower is left.
      expect(tops('flex-direction:column;height:400px',
                  ['height:50px;margin-bottom:30px', 'height:50px;margin-top:20px', 'flex:1']))
        .to eq([0, 100, 150, 0])
      expect(heights('flex-direction:column;height:400px',
                     ['height:50px;margin-bottom:30px', 'height:50px;margin-top:20px', 'flex:1']))
        .to eq([50, 50, 250, 400])
    end

    it 'spaces its items by the ROW gap' do
      # `gap: 20px` between three items takes 40 off what the grower gets.
      boxes, = flex('flex-direction:column;height:300px;gap:20px', ['height:50px', 'flex:1', 'height:30px'])
      expect(boxes.map {|b| [b[1], b[3]] }).to eq([[0, 50], [70, 180], [270, 30], [0, 300]])
    end

    it 'runs backwards for column-reverse' do
      # The main-START is the BOTTOM edge: the first item sits against it and the free space is
      # left at the top (Chrome: 250 and 190 in a 300px column).
      expect(tops('flex-direction:column-reverse;height:300px', ['height:50px', 'height:60px']))
        .to eq([250, 190, 0])
    end
  end

  describe 'the free space a column does not hand to its items' do
    it 'goes to auto margins before justify-content sees it' do
      expect(tops('flex-direction:column;height:200px', ['height:40px', 'height:40px;margin-top:auto']))
        .to eq([0, 160, 0])
    end

    it 'reports what an auto margin resolved to, not `auto`' do
      # One geometry: the box sits 160 down because its `margin-top: auto` took the 160 of free
      # space, so that is what `getComputedStyle` has to say it is (Chrome: `120px` for the same
      # shape with a 40px sibling above it).
      body = <<~HTML
        <div id="c" style="width:600px;display:flex;flex-direction:column;height:200px">
          <div style="height:40px">a</div>
          <div id="pushed" style="height:40px;margin-top:auto">b</div>
        </div>
      HTML
      _, _, _, session = measure(body, ['#pushed'])
      expect(session.evaluate_script("getComputedStyle(document.getElementById('pushed')).marginTop"))
        .to eq('120px')
    end

    it 'is placed by justify-content' do
      expect(tops('flex-direction:column;height:200px;justify-content:center', ['height:40px'])).to eq([80, 0])
      expect(tops('flex-direction:column;height:200px;justify-content:space-between', ['height:40px', 'height:40px']))
        .to eq([0, 160, 0])
    end
  end

  describe "a column's cross axis" do
    it 'stretches an auto width and shrink-wraps an aligned item' do
      boxes, text = flex('flex-direction:column;height:100px', ['', 'width:100px', 'align-self:flex-start'],
                         probes: ['item2'])
      expect(boxes.map {|b| b[2] }).to eq([600, 100, text['item2'].round(2), 600])
    end

    it 'aligns rather than stretches when align-items says so' do
      boxes, text = flex('flex-direction:column;height:80px;align-items:center', ['', 'align-self:flex-end'],
                         probes: ['item0', 'item1'])
      expect(boxes[0][0]).to be_within(0.02).of(((600 - text['item0']) / 2).round(2))
      expect(boxes[1][0]).to be_within(0.02).of((600 - text['item1']).round(2))
    end

    it 'centres an item whose cross margins are auto' do
      boxes, = flex('flex-direction:column;height:60px', ['width:100px;margin-left:auto;margin-right:auto'])
      expect(boxes[0][0]).to eq(250)
    end

    it 'resolves a percentage height inside a flexed item against what the item was given' do
      body = <<~HTML
        <div id="c" style="width:600px;display:flex;flex-direction:column;height:300px">
          <div id="i0" style="flex:1"><div id="half" style="height:50%">half</div></div>
        </div>
      HTML
      boxes, = measure(body, ['#i0', '#half'])
      expect(boxes.map {|b| b[3] }).to eq([300, 150])
    end
  end

  describe 'the flexible-length resolution itself' do
    it 'hands out only that fraction when the factors add up to less than one' do
      # §9.7.4: `flex: 0.5` takes HALF the room it is offered, not all of it (Chrome: 200 of a
      # 400px row), and two items sharing 0.5 get 80 and 120 rather than 160 and 240.
      expect(flex('width:400px', ['flex:0.5 1 0']).first.map {|b| b[2] }).to eq([200, 400])
      expect(flex('width:400px', ['flex:0.2 1 0', 'flex:0.3 1 0']).first.map {|b| b[2] }).to eq([80, 120, 400])
      expect(flex('width:400px', ['flex:0.5 1 100px']).first.map {|b| b[2] }).to eq([250, 400])
      # …and the same on the way back: a 200px basis in a 100px row with `flex-shrink: 0.25`
      # gives up a quarter of the deficit, landing at 175.
      expect(flex('width:100px', ['flex:0 0.25 200px']).first.map {|b| b[2] }).to eq([175, 100])
    end

    it 'weights the shrink by the item CONTENT box, not by its padding too' do
      # §9.7.4's scaled shrink factor is `flex-shrink x inner base size`: a 100px basis wearing
      # 100px of padding gives up the same as a bare one, so Chrome lands them at 150 and 50.
      boxes, = flex('width:200px', ['flex:0 1 100px;padding:0 50px;min-width:0', 'flex:0 1 100px;min-width:0'])
      expect(boxes.map {|b| b[2] }).to eq([150, 50, 200])
    end

    it 'treats a negative factor as the invalid declaration it is' do
      # `flex-shrink: -1` is not a shrink factor of zero — the declaration is dropped and the
      # initial 1 applies, so a 200px item still shrinks into a 100px row.
      expect(flex('width:100px', ['flex-shrink:-1;width:200px']).first.map {|b| b[2] }).to eq([100, 100])
    end

    it 'reads flex-basis: content past a declared size' do
      boxes, text = flex('', ['flex-basis:content;width:400px'], probes: ['item0'])
      expect(boxes[0][2]).to be_within(0.01).of(text['item0'])
    end

    it 'places the items by order, not by document order' do
      boxes, = flex('', ['order:2;width:50px', 'order:1;width:60px'])
      expect(boxes.map {|b| b[0] }).to eq([60, 0, 0])
      boxes, = flex('flex-direction:column;height:100px', ['order:2;height:20px', 'order:1;height:30px'])
      expect(boxes.map {|b| b[1] }).to eq([30, 0, 0])
    end
  end

  describe 'a line that overflows' do
    it 'is still placed by justify-content, off both edges' do
      # The default overflow alignment is UNSAFE: two 150px items in a 200px centred row start at
      # -50 in Chrome, not at 0.
      expect(flex('width:200px;justify-content:center', ['flex:0 0 150px', 'flex:0 0 150px']).first.map {|b| b[0] })
        .to eq([-50, 100, 0])
      expect(flex('width:200px;justify-content:flex-end', ['flex:0 0 150px', 'flex:0 0 150px']).first.map {|b| b[0] })
        .to eq([-100, 50, 0])
    end

    it 'aligns an item taller than its line off both edges too' do
      boxes, = flex('height:20px;align-items:center', ['height:100px;width:10px'])
      expect(boxes[0][1]).to eq(-40)
      boxes, = flex('height:20px;align-items:flex-end', ['height:100px;width:10px'])
      expect(boxes[0][1]).to eq(-80)
    end

    it 'keeps a definite cross size as the LINE, so a stretched item is squeezed to it' do
      # Chrome gives the item the row's 40 and lets its five lines overflow — where taking the
      # tallest item as the line said 90 and put every aligned sibling low with it.
      body = '<div id="c" style="width:400px;display:flex;height:40px">' \
             '<div id="i0">one<br>two<br>three<br>four<br>five</div></div>'
      boxes, = measure(body, ['#i0'])
      expect(boxes[0][3]).to eq(40)
      # …and its max-content is the WIDEST of those lines, not their sum: a `<br>` ends the line
      # even when nothing is wrapping (Chrome: the width of "three", not of all five words).
      boxes, text = measure(body.sub('height:40px', ''), ['#i0'], probes: %w[three])
      expect(boxes[0][2]).to be_within(0.01).of(text['three'])
    end
  end

  describe 'a row' do
    it 'counts each item as a whole box, padding included' do
      # Two padded growers fill the row rather than overflowing it by their padding (Chrome: 300
      # each in 600, not 340), and a content-sized item counts its padding ONCE.
      expect(flex('', ['flex:1;padding:20px', 'flex:1;padding:20px']).first.map {|b| b[2] })
        .to eq([300, 300, 600])
      boxes, text = flex('', ['padding:20px', 'flex:1'], probes: ['item0'])
      expect(boxes[0][2]).to be_within(0.02).of((text['item0'] + 40).round(2))
    end

    it 'takes gaps and margins out of the main axis' do
      expect(flex('gap:40px', ['flex:1', 'flex:1']).first.map {|b| b[2] }).to eq([280, 280, 600])
      boxes, = flex('', ['width:100px;margin-right:30px', 'flex:1'])
      expect(boxes.map {|b| [b[0], b[2]] }).to eq([[0, 100], [130, 470], [0, 600]])
    end

    it 'lets its items overflow rather than squeeze below their content' do
      # Two `flex: 1` items holding one long word each: their automatic minimums (min-content) sum
      # to more than the row, so Chrome sizes each to its own word — 128.94 + 102.28 in a 200px row
      # — instead of 100 and 100.
      body = <<~HTML
        <div id="c" style="width:200px;display:flex">
          <div id="i0" style="flex:1">Supercalifragilistic</div>
          <div id="i1" style="flex:1">Expialidocious</div>
        </div>
      HTML
      boxes, text = measure(body, ['#i0', '#i1'], probes: %w[Supercalifragilistic Expialidocious])
      expect(boxes[0][2]).to be_within(0.01).of(text['Supercalifragilistic'])
      expect(boxes[1][2]).to be_within(0.01).of(text['Expialidocious'])
      # `min-width: 0` is the page waiving that minimum, and then they do share the row.
      body = body.gsub('flex:1', 'flex:1;min-width:0')
      boxes, = measure(body, ['#i0', '#i1'])
      expect(boxes.map {|b| b[2] }).to eq([100, 100])
    end

    it 'squeezes a SCROLLING item past its content, and only that one' do
      # The row half of the same rule: the `overflow: hidden` item gives up its content minimum
      # (Chrome: 97.72) while its `visible` sibling holds on to 102.28.
      body = <<~HTML
        <div id="c" style="width:200px;display:flex">
          <div id="i0" style="flex:1;overflow:hidden">Supercalifragilistic</div>
          <div id="i1" style="flex:1">Expialidocious</div>
        </div>
      HTML
      boxes, text = measure(body, ['#i0', '#i1'], probes: %w[Expialidocious])
      expect(boxes[1][2]).to be_within(0.01).of(text['Expialidocious'])
      expect(boxes[0][2]).to be_within(0.01).of(200 - text['Expialidocious'])
    end

    it 'frees the space a max-width capped item did not take' do
      expect(flex('', ['flex:1;max-width:100px', 'flex:1']).first.map {|b| b[2] }).to eq([100, 500, 600])
    end

    it 'places what is left by justify-content, or by an auto margin' do
      expect(flex('justify-content:space-between', ['width:100px', 'width:100px']).first.map {|b| b[0] })
        .to eq([0, 500, 0])
      expect(flex('justify-content:center', ['width:100px']).first.map {|b| b[0] }).to eq([250, 0])
      expect(flex('', ['width:80px', 'width:80px;margin-left:auto']).first.map {|b| b[0] }).to eq([0, 520, 0])
    end

    it 'lets an auto cross margin take the line, as the column does across' do
      # Chrome, in a 100px row: `margin-top: auto` on a 20px item puts it at 80, both margins auto
      # centre it at 40 — and each reports the length it resolved to.
      boxes, = flex('height:100px', ['width:50px;height:20px;margin-top:auto',
                                     'width:50px;height:20px;margin-top:auto;margin-bottom:auto'])
      expect(boxes.map {|b| b[1] }).to eq([80, 40, 0])
    end

    it 'aligns its items on the cross axis' do
      # A row is as tall as its tallest item, and `align-items` decides where the shorter ones sit
      # in it: centred is 21 down a 60px row, `flex-end` 42.
      boxes, = flex('height:60px;align-items:center', ['', 'align-self:flex-end'])
      expect(boxes.map {|b| b[1] }).to eq([21, 42, 0])
    end
  end
end
