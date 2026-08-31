# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The scrollable overflow region (css-overflow-3 §3.1-3.2), which is what `scrollWidth` /
# `scrollHeight` report. Two rules decide it, and the driver had neither:
#
#   1. the content a box lays out ITSELF is extended by that box's END padding — a `padding: 10px`
#      scroller holding a 110px child scrolls 130, not 120;
#   2. what overflows the SCROLL ORIGIN is unreachable and reports nothing, and which physical edge
#      the origin is on follows `writing-mode` / `direction` — so the same leftwards overflow is
#      130 in an LTR block and 220 in an RTL one.
#
# Every figure is Chrome 151-measured on this machine. Chrome reserves a 15px classic scrollbar
# where we reserve none, so the cases here all OVERFLOW: the region is then wider than the box and
# the gutter cancels out of the answer (it moves the content and the client edge by the same 15).
RSpec.describe 'the scrollable overflow region' do
  # A `100x100` scroller with `padding: 10px` around `body`, and the pair it reports.
  def scroller(inner, style: '', probe: 's')
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               body { margin: 0; font: 16px Arial }
               #s { overflow: scroll; width: 100px; height: 100px; padding: 10px; #{style} }
               .i { width: 110px; height: 110px }
             </style></head><body><div id="s">#{inner}</div></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    session.evaluate_script("(function () { var s = document.getElementById('#{probe}');
                              return [s.scrollWidth, s.scrollHeight]; })()")
  end

  # §3.2: the region is the union of the box's padding box and its content, and the content half
  # reaches one END padding further — the padding is part of what scrolls past.
  it 'extends the content by the end padding' do
    expect(scroller('<div class="i"></div>')).to eq([130, 130])
  end

  # …the padding on the side the content actually runs out of, which need not be the same figure.
  it 'uses each end padding on its own axis' do
    expect(scroller('<div class="i"></div>', style: 'padding: 5px 10px 20px 40px')).to eq([160, 135])
  end

  # A descendant's MARGIN box is what the region unions, so the margin lands inside the padding.
  it 'counts the child margins inside it' do
    expect(scroller('<div class="i" style="margin:7px"></div>')).to eq([144, 144])
  end

  # Borders are not part of it: the region starts at the padding edge, so a bordered scroller whose
  # content fits reports the client box and every "is there more?" affordance stays off.
  it 'measures from the padding edge, not the border edge' do
    expect(scroller('<div class="i"></div>', style: 'border: 3px solid')).to eq([130, 130])
  end

  # Only the content the box lays out itself takes the padding. Overflow that PROPAGATED from
  # deeper down arrives at its own edge — a 10px-wide child holding a 160px grandchild is 170.
  it 'does not re-pad overflow propagated from a descendant' do
    expect(scroller('<div style="width:10px"><div style="width:160px;height:10px"></div></div>'))
      .to eq([170, 120])
  end

  # …nor an out-of-flow box, which the container never placed in flow at all.
  it 'does not pad an absolutely positioned descendant' do
    expect(scroller('<div style="position:absolute;left:10px;top:10px;width:110px;height:110px"></div>',
                    style: 'position: relative')).to eq([120, 120])
  end

  # A relatively-positioned child is BOTH: it extends the region from where it sits, while the
  # padding follows the flow position it moved from. `left: 5px` is still the unshifted edge plus
  # the padding; `left: 40px` has outrun it.
  it 'pads a relative child from its flow position and unions it from its shifted one' do
    expect(scroller('<div class="i" style="position:relative;left:5px"></div>')).to  eq([130, 130])
    expect(scroller('<div class="i" style="position:relative;left:40px"></div>')).to eq([160, 130])
    expect(scroller('<div class="i" style="position:relative;left:-30px"></div>')).to eq([130, 130])
  end

  # §3.1: content behind the SCROLL ORIGIN is unreachable, so overflow towards the start edge adds
  # nothing — a negative margin scrolls no further left in an LTR block.
  it 'reports nothing for overflow behind the scroll origin' do
    expect(scroller('<div class="i" style="margin-left:-30px"></div>')).to eq([120, 130])
  end

  # …and the origin is the edge the box lays content out FROM, so in an RTL block the same
  # leftwards overflow is reachable and the end padding is the left one.
  it 'scrolls the other way in an RTL block' do
    expect(scroller('<div style="width:200px;height:20px"></div>', style: 'direction: rtl'))
      .to eq([220, 120])
  end

  # A flex container's origin is its MAIN-START edge, so what a `row-reverse` row pushes off the
  # left is as reachable as what a plain row pushes off the right: Chrome reports 370 for both.
  it 'scrolls from the flex main-start edge in either direction' do
    items = '<div class="i" style="min-width:110px;min-height:110px"></div>' * 3
    expect(scroller(items, style: 'display:flex; gap:10px; align-items:start')).to eq([370, 130])
    expect(scroller(items, style: 'display:flex; gap:10px; align-items:start; flex-direction:row-reverse'))
      .to eq([370, 130])
  end

  # A clipping child scrolls its own content: what overflows IT is not scrollable content of
  # anything above it, so the ancestor reports only the child's own box.
  it 'stops at a clipping descendant' do
    expect(scroller('<div style="width:10px;overflow:hidden"><div style="width:160px;height:10px"></div></div>'))
      .to eq([120, 120])
  end

  # The floor is the client box, whatever the region does — a box whose content fits reports its
  # own padding box and never its border box.
  it 'floors at the client box' do
    expect(scroller('<div style="width:10px;height:10px"></div>')).to eq([120, 120])
  end

  # A box that CANNOT scroll reports the plain union of what is inside it: no child margins, no end
  # padding. Every rule above belongs to the scroll container, and `overflow: visible` is the far
  # more common case — Chrome measured on each pair.
  describe 'a box that cannot scroll' do
    def plain(inner, style: '')
      html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
                 body { margin: 0; font: 16px Arial }
                 #s { width: 100px; height: 20px; #{style} }
               </style></head><body><div id="s">#{inner}</div></body></html>)
      session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
      session.visit '/'
      session.evaluate_script("(function () { var s = document.getElementById('s');
                                return [s.scrollWidth, s.scrollHeight]; })()")
    end

    it 'takes no end padding' do
      expect(plain('<div style="height:40px"></div>', style: 'padding-bottom: 10px')).to eq([100, 40])
      expect(plain('<div style="height:40px"></div>', style: 'padding-bottom: 10px; overflow: hidden'))
        .to eq([100, 50])
    end

    it 'takes no child margins' do
      expect(plain('<div style="height:20px;margin-bottom:50px"></div>')).to eq([100, 20])
      expect(plain('<div style="height:20px;margin-bottom:50px"></div>', style: 'overflow: hidden'))
        .to eq([100, 70])
    end

    # `overflow: clip` clips but forbids scrolling, so it is not a scroll container and reports the
    # `visible` figures — while ONE non-visible axis makes the other `auto`, so an `overflow-x`
    # scroller pads both.
    it 'tells clip from hidden, and pads both axes of a one-axis scroller' do
      expect(plain('<div style="height:40px"></div>', style: 'padding-bottom: 10px; overflow: clip'))
        .to eq([100, 40])
      expect(plain('<div style="height:40px"></div>', style: 'padding-bottom: 10px; overflow-x: hidden'))
        .to eq([100, 50])
    end

    # …and `flex-direction` only moves the origin on a scroll container: the same row that overflows
    # 200px to the left reports 100 while it cannot scroll, and 300 once it can.
    it 'ignores flex-direction until it can scroll' do
      item = '<div style="width:300px;flex:none;height:10px"></div>'
      expect(plain(item, style: 'display:flex; flex-direction:row-reverse')).to eq([100, 20])
      expect(plain(item, style: 'display:flex; flex-direction:row-reverse; overflow:scroll')).to eq([300, 20])
    end

    # An RTL block flips the origin either way — `direction` is not the scroll container's business.
    it 'flips an RTL block whether or not it scrolls' do
      wide = '<div style="width:300px;height:10px"></div>'
      expect(plain(wide, style: 'direction: rtl')).to eq([300, 20])
      expect(plain(wide, style: 'direction: rtl; overflow: scroll')).to eq([300, 20])
    end
  end

  # Margins are unioned only where a box HAS a margin box: not on a table's internal boxes
  # (CSS 2.1 §17.5) and not on a `<br>`. Padding on a cell still counts, through the cell's own box.
  it 'ignores margins where margins do not apply' do
    table = '<table><tbody id="tb"><tr id="tr"><td id="td">x</td><td>y</td></tr></tbody></table>'
    expect(scroller(%(<style>#tr { margin-right: 400px }</style>#{table}), probe: 'tb')).to eq([22, 20])
    expect(scroller(%(<style>#td { margin-right: 400px }</style>#{table}), probe: 'tr')).to eq([22, 20])
    expect(scroller(%(<style>#td { padding-right: 400px }</style>#{table}), probe: 'tr')).to eq([421, 20])
    expect(scroller('<style>#b { margin-right: 400px }</style><div id="d" style="width:200px">a<br id="b">b</div>',
                    probe: 'd')).to eq([200, 36])
  end

  # `relativeOffset` is also the CSSOM side of `top` / `left`, and it is asked for STICKY boxes,
  # whose shift is never folded into the box at all. Only the caller that APPLIES a shift records
  # it — reading `getComputedStyle(...).top` must not change what the next pass measures.
  it 'is not disturbed by a computed-style read on a sticky child' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>body { margin: 0; font: 16px Arial }</style>
             </head><body><div style="display:flex">
               <div id="z" style="width:100px"></div>
               <div id="c" style="flex:1;overflow:scroll;height:100px;padding:10px">
                 <div id="k" style="position:sticky;top:40px;width:110px;height:110px"></div>
               </div></div></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq([130, 130])
      (function () {
        var c = document.getElementById('c'), before = c.scrollHeight;
        getComputedStyle(document.getElementById('k')).top;
        document.getElementById('z').style.width = '200px';
        return [before, c.scrollHeight];
      })()
    JS
  end
end
