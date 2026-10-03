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

  # …and a descendant that starts or stops CLIPPING changes it with no box moving at all: what the clip is is kept
  # under the box's stamp across passes (`clipsContent`), so a class that changes nothing but `overflow` has to reach it.
  # Chrome: 310 (the grandchild's overflow, not extended by the end padding), 170, 310.
  it 'follows a descendant that starts and stops clipping' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               body { margin: 0; font: 16px Arial }
               #s { overflow: scroll; width: 100px; height: 100px; padding: 10px }
               #w { height: 150px } .clip { overflow: hidden }
             </style></head><body><div id="s"><div id="w"><div style="height:300px"></div></div></div></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const s = document.getElementById('s'), w = document.getElementById('w'), r = [s.scrollHeight];
        w.classList.add('clip'); r.push(s.scrollHeight); w.classList.remove('clip'); r.push(s.scrollHeight);
        return r;
      })()
    JS
    expect(got).to eq([310, 170, 310])
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

  # A table CAPTION sits at the table's BORDER box, OUTSIDE the border+padding (§17.4 wrapper box), so a caption
  # wider or taller than the grid OVERFLOWS the table's padding box (the scrollport) even though its edge only
  # reaches the border box. scrollWidth / scrollHeight count it — the border-box-seeded union alone could not,
  # since the caption's edge coincides with the seed. (Caption heights are comfortably above the text line so the
  # figures don't depend on which face fontconfig serves; each is Chrome-measured on this machine.)
  def table_scroll(table_style, caption_style)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>body { margin: 0; font: 16px Arial }</style>
             </head><body><table id="t" style="#{table_style}"><caption style="#{caption_style}">W</caption>
             <tr><td style="width:40px;height:20px;padding:0">a</td></tr></table></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    session.evaluate_script("(function () { var t = document.getElementById('t'); return [t.scrollWidth, t.scrollHeight]; })()")
  end

  # The caption (width 300) reaches the border-box right at x=300; the padding box starts at clientLeft=10, so the
  # region is 300-10=290 wide — past the 80px grid padding box. scrollHeight is the grid, the caption sits above it.
  it 'counts a wide top caption overflowing the table padding box' do
    expect(table_scroll('width:100px;border:10px solid;border-spacing:0', 'width:300px;height:30px')).to eq([290, 50])
  end

  # A caption NARROWER than the table does not extend the region past the grid's own padding box (80 wide).
  it 'leaves scrollWidth at the padding box for a narrow caption' do
    expect(table_scroll('width:100px;border:10px solid;border-spacing:0', 'width:40px;height:30px')).to eq([80, 50])
  end

  # A bottom caption sits below the table's bottom border, overflowing the padding box downward: the region runs
  # from clientTop=10 to the caption bottom (70), i.e. 60 tall — and 290 wide for the same reason as above.
  it 'counts a bottom caption overflowing the table padding box downward' do
    expect(table_scroll('width:100px;border:10px solid;border-spacing:0;caption-side:bottom', 'width:300px;height:30px')).to eq([290, 60])
  end

  # A border-collapse table's scroll region runs to its BORDER-box far corner, not the padding box: Chrome reports
  # scrollWidth == clientWidth - clientLeft and scrollHeight == clientHeight - clientTop, i.e. only the TOP-LEFT
  # outer-half border is the scrollport origin — the FAR outer-half border stays inside the region (a separate
  # table, by contrast, reports the padding box on both axes). Each figure is Chrome-measured on this machine.
  def plain_table_scroll(table_style, inner)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>body { margin: 0; font: 16px Arial }</style>
             </head><body><table id="t" style="#{table_style}">#{inner}</table></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    session.evaluate_script("(function () { var t = document.getElementById('t'); return [t.scrollWidth, t.scrollHeight]; })()")
  end

  # border:10 collapse over a 100x40 border box: clientLeft/Top = the 5px outer half, so 100-5 / 40-5.
  # …and an ANONYMOUS box overflows like any other, which is a question about the ENUMERATION and not about
  # the region: CSS Grid §4 wraps a grid's contiguous run of bare text in an anonymous block container item,
  # and the raw child list yields the TEXT NODE, which has no box. Skipped here, the scroller reports itself
  # UNSCROLLABLE — no mismatch, no decline and no crash, the third of the four invisible failures that the
  # `display: contents` phantom box taught. Measured with the raw list: `scrollWidth` 60 against Chrome's 200.
  it 'sees an anonymous grid item that overflows the scroller' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
               <div id="s" style="overflow:auto;width:60px;height:40px">
                 <div style="display:grid;grid-template-columns:200px">wide bare text here</div>
               </div></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('s').scrollWidth")).to eq(200)
  end

  it 'runs a collapse table scroll region to its border-box far corner' do
    expect(plain_table_scroll('width:100px;border:10px solid;border-collapse:collapse',
                              '<tr><td style="width:40px;height:20px;padding:0">a</td></tr>')).to eq([95, 35])
  end

  # A separate table with the same nominal border stops at the padding box (100-20 / 40-20) — the contrast.
  it 'stops a separate table scroll region at the padding box' do
    expect(plain_table_scroll('width:100px;border:10px solid;border-spacing:0',
                              '<tr><td style="width:40px;height:20px;padding:0">a</td></tr>')).to eq([80, 20])
  end

  # Asymmetric collapse borders (top 6 / right 20 / bottom 2 / left 4): the outer halves are 3/10/1/2, so the
  # near-edge origin is left 2 / top 3 and the far edge is the border box — 100-2 wide, 28-3 tall.
  it 'uses each outer-half border on its own edge for an asymmetric collapse table' do
    expect(plain_table_scroll('width:100px;border-style:solid;border-width:6px 20px 2px 4px;border-collapse:collapse',
                              '<tr><td style="width:40px;height:20px;padding:0">a</td></tr>')).to eq([98, 25])
  end

  # The region is stamped when something READS it, not after every pass — so a box one pass MOVED and the next left
  # alone still reaches its scroller from where it went: the first pass grows `#a` and pushes `#b` down (`#b` itself
  # unchanged), the second touches only a box outside, and only then is the region asked. (Chrome: 100, 140.)
  it 'follows a box two passes back when nothing read the region between them' do
    html = %(<!DOCTYPE html><html><head><style>body { margin: 0 } #s { overflow: auto; width: 100px; height: 100px }
               #a { height: 10px } #b { height: 80px } #o { height: 10px }</style></head>
             <body><div id="s"><div id="a"></div><div id="b"></div></div><div id="o"></div></body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const sc = document.getElementById('s'), out = [sc.scrollHeight];
        document.getElementById('a').style.height = '60px';
        document.body.offsetHeight;
        document.getElementById('o').style.height = '20px';
        document.body.offsetHeight;
        out.push(sc.scrollHeight);
        return out;
      })()
    JS
    expect(got).to eq([100, 140])
  end

  # …and an element with NO box has no region at all, whatever a pass left it: not rendered, detached, or
  # `display: contents`. (Chrome: 100, then 0 every time.)
  it 'reports no region for an element without a box' do
    html = '<!DOCTYPE html><body><div id="d" style="width:100px;height:10px"></div>' \
           '<div id="c" style="display:contents"><i>x</i></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d'), out = [d.scrollWidth];
        d.style.width = '300px'; document.body.offsetHeight;
        d.style.display = 'none'; document.body.offsetHeight;
        out.push(d.scrollWidth, d.scrollHeight);
        d.style.display = ''; d.remove();
        out.push(d.scrollWidth, document.getElementById('c').scrollWidth);
        return out;
      })()
    JS
    expect(got).to eq([100, 0, 0, 0, 0])
  end
  # The LINE BOXES are scrollable overflow too (§2.2: the content a box lays out includes its text), each line to the
  # far end of what it holds — a `nowrap` line past its scroller, a long word past an `overflow: hidden` box, wherever
  # `text-align` put the line — and nothing behind the scroll origin, which `direction: rtl` moves to the right.
  # (Chrome / Firefox: 275 / 275 / 188 wide; `f` 227x36 in Chrome; an `overflow: visible` box reports the plain
  # union, 306x30. The heights here are the client box: neither browser's horizontal scrollbar is drawn here.)
  it 'reaches as far as the lines of text in it' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               body { margin: 0; font: 16px Arial } .s { overflow: auto; width: 100px; height: 50px; white-space: nowrap }
             </style></head><body>
             <div id="b" class="s">lorem ipsum dolor sit amet consectetur</div>
             <div id="c" class="s" style="direction:rtl">lorem ipsum dolor sit amet consectetur</div>
             <div id="e" class="s" style="text-align:center">lorem ipsum dolor sit amet</div>
             <div id="f" style="overflow:hidden;width:100px;height:30px">supercalifragilisticexpialidocious word</div>
             <div id="g" style="width:100px;height:30px;white-space:nowrap">visible overflow is not scrollable for this box</div>
             </body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['b', 'c', 'e', 'f', 'g'].map((id) => { const e = document.getElementById(id); return [e.scrollWidth, e.scrollHeight]; })
    JS
    expect(got).to eq([[275, 50], [275, 50], [188, 50], [227, 36], [306, 30]])
  end

  # …and an element's scroll offsets are clamped to the region, as the document's are: `scrollLeft = 99999` lands at
  # `scrollWidth - clientWidth`, and an rtl scroller, scrolling from its right, takes offsets from `-max` to 0 (CSSOM
  # View §6). (Firefox: 175, -175, 0. Chrome: 175, -174, 1 — fractional advances under its rounding.)
  it 'clamps an element scroller to its region, from whichever edge it scrolls from' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               body { margin: 0; font: 16px Arial } .s { overflow: auto; width: 100px; height: 50px; white-space: nowrap }
             </style></head><body>
             <div id="b" class="s">lorem ipsum dolor sit amet consectetur</div>
             <div id="c" class="s" style="direction:rtl">lorem ipsum dolor sit amet consectetur</div>
             </body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const b = document.getElementById('b'), c = document.getElementById('c'), out = [];
        b.scrollLeft = 99999; out.push(b.scrollLeft);
        c.scrollLeft = -99999; out.push(c.scrollLeft);
        c.scrollLeft = 50; out.push(c.scrollLeft);
        return out;
      })()
    JS
    expect(got).to eq([175, -175, 0])
  end
  # A form control's SHOWN text is laid out in its box (walk.rs `control_text`), so it is the control's overflow as any
  # line is: a textarea's lines past its height, a field's value past its width — and the offsets clamp to it. A FIELD's
  # placeholder is the exception: the field clips it and scrolls to none of it, where a textarea's scrolls like its
  # value. (Chrome: 100x80 / 40, 123 / 73, 50 / 0, 100x80 / 40. Heights are left out for the fields: their box does not
  # follow their font yet, 15 where Chrome's 16px Arial is 18.)
  it 'reaches as far as the text a control shows' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               .c { font: 16px Arial; padding: 0; border: 0; overflow: hidden }
               textarea.c { width: 100px; height: 40px; line-height: 20px }
               input.c { width: 50px }
             </style></head><body style="margin:0">
             <textarea id="t" class="c">a\nb\nc\nd</textarea>
             <input id="i" class="c" value="a long value here"><input id="p" class="c" placeholder="a long placeholder here">
             <textarea id="tp" class="c" placeholder="a\nb\rc\r\nd"></textarea>
             </body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['t', 'i', 'p', 'tp'].map((id) => {
        const e = document.getElementById(id);
        e.scrollTop = 999; e.scrollLeft = 999;
        return id[0] === 't' ? [e.scrollWidth, e.scrollHeight, e.scrollTop] : [e.scrollWidth, e.scrollLeft];
      })
    JS
    expect(got).to eq([[100, 80, 40], [123, 73], [50, 0], [100, 80, 40]])
  end
  # A layout re-clamps every offset to the range its box has now, as a browser's does: a scroller whose content shrank
  # reads at its new end at once, a textarea whose value got shorter at its top. A box that is only HIDDEN reads 0, as
  # anything with no box does, and keeps its offset for when it is shown again; one taken out of the tree loses it.
  # (Chrome: 50, 0, 0, 300, 0.)
  it 'clamps the offsets again to what a layout leaves' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
             <div id="s" style="overflow:auto;width:100px;height:100px"><div id="c" style="height:500px"></div></div>
             <textarea id="t" style="font:16px Arial;line-height:20px;height:40px;padding:0;border:0;overflow:hidden">a\nb\nc\nd\ne</textarea>
             <div id="h" style="overflow:auto;width:100px;height:100px"><div style="height:500px"></div></div>
             <div id="r" style="overflow:auto;width:100px;height:100px"><div style="height:500px"></div></div>
             </body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const s = document.getElementById('s'), t = document.getElementById('t'), h = document.getElementById('h'), r = document.getElementById('r');
        s.scrollTop = 300; t.scrollTop = 60; h.scrollTop = 300; r.scrollTop = 300;
        document.getElementById('c').style.height = '150px';
        t.value = 'a';
        h.style.display = 'none'; const hidden = h.scrollTop; h.style.display = '';
        r.remove(); document.body.appendChild(r);
        return [s.scrollTop, t.scrollTop, hidden, h.scrollTop, r.scrollTop];
      })()
    JS
    expect(got).to eq([50, 0, 0, 300, 0])
  end
  # What a `transform` draws a scroller as is no part of its client box or of the range it scrolls: a 100px scroller
  # under `scale(0.5)` still scrolls 300 - 100. (Chrome: 200, 300, 100; the range was 250 against the drawn 50.)
  it 'leaves a transformed scroller its client box and range as laid out' do
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
             <div id="s" style="overflow:auto;width:100px;height:100px;transform:scale(0.5);transform-origin:0 0">
             <div style="height:300px"></div></div></body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => { const s = document.getElementById('s'); s.scrollTop = 9999; return [s.scrollTop, s.scrollHeight, s.clientHeight]; })()
    JS
    expect(got).to eq([200, 300, 100])
  end
end
