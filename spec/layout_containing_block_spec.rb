# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Which box an out-of-flow one is positioned against. Two rules were missing, and both are what a
# page's own JS reads back through `getComputedStyle`: a transformed (or filtered, or contained)
# ancestor is the containing block for the FIXED boxes inside it, not just the absolute ones — and
# a STICKY box's insets are measured against its scrollport rather than against the block that
# holds it. With neither, a fixed dropdown inside a transformed panel resolved its `10%` against
# the viewport.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'containing blocks' do
  def page(markup)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head>
             <body style="margin:0;font:16px Arial">#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  def insets(session, id)
    session.evaluate_script(<<~JS)
      (cs => [cs.top, cs.left])(getComputedStyle(document.getElementById(#{id.inspect})))
    JS
  end

  # A transform takes a fixed box off the viewport: its percentages resolve against the transformed
  # element's PADDING box, exactly as an absolute box's do against its positioned ancestor.
  it 'gives a fixed box the transformed ancestor as its containing block' do
    s = page('<div style="transform:scale(1);position:absolute;width:600px;height:300px;padding:10px">' \
             '<div id="f" style="position:fixed;top:10%;left:10%;width:20px;height:10px"></div></div>')
    expect(insets(s, 'f')).to eq(['32px', '62px'])    # 10% of the 320x620 padding box
  end

  # …and so do the other things that contain: a filter, `contain`, a `will-change` naming one of
  # them — whatever the ancestor's own `position` is.
  it 'contains out-of-flow boxes for every containing property' do
    filtered = page('<div style="filter:blur(0);width:400px;height:200px;margin-top:400px">' \
                    '<div id="a" style="position:absolute;top:50%;left:25%;width:20px;height:10px"></div></div>')
    expect(insets(filtered, 'a')).to eq(['100px', '100px'])

    contained = page('<div style="contain:layout;width:400px;height:200px">' \
                     '<div id="a" style="position:absolute;top:50%;width:20px;height:10px"></div></div>')
    expect(insets(contained, 'a')).to eq(['100px', '0px'])

    willed = page('<div style="will-change:transform;width:400px;height:200px">' \
                  '<div id="a" style="position:fixed;top:25%;width:20px;height:10px"></div></div>')
    expect(insets(willed, 'a')).to eq(['50px', '0px'])
  end

  # A sticky box's insets are the scrollport's, not its parent block's: `top: 10%` inside a 100px
  # block in a 200px scroll container is 20px.
  it 'measures a sticky inset against the scrollport' do
    s = page('<div style="overflow:hidden;width:400px;height:200px"><div style="height:100px">' \
             '<div id="s" style="position:sticky;top:10%">s</div></div></div>')
    expect(insets(s, 's')).to eq(['20px', 'auto'])
  end

  # …and the things that only LOOK like they contain do not: a property set to `none`, one
  # `will-change` doesn't name (`transform-origin` is not `transform`), a `contain` value that
  # contains something else, and a transform on a box that isn't transformable at all — a
  # non-replaced inline. Every one of these resolves against the positioned ancestor above it.
  it 'leaves out-of-flow boxes to the positioned ancestor otherwise' do
    inner = ->(style) {
      page(%(<div style="position:relative;width:400px;height:200px">
               <div style="#{style};width:100px;height:50px">
                 <div id="a" style="position:absolute;top:50%;left:25%;width:5px;height:5px"></div>
               </div></div>))
    }
    ['transform:none;filter:none', 'contain:size', 'will-change:opacity',
     'will-change:transform-origin', 'will-change:contain-intrinsic-size'].each do |style|
      expect(insets(inner.call(style), 'a')).to eq(['100px', '100px']), style
    end

    span = page('<div style="position:relative;width:400px;height:200px">' \
                '<span style="transform:scale(2)"><div id="a" style="position:absolute;top:50%;left:25%;' \
                'width:5px;height:5px"></div></span></div>')
    expect(insets(span, 'a')).to eq(['100px', '100px'])
  end

  # A fixed box with a containing block of its own is, for everything but its cascaded value, an
  # absolute one: it SCROLLS with that block, and the page can still hit-test it where it moved to.
  it 'scrolls a contained fixed box with its containing block' do
    s = page('<div style="height:3000px"><div style="height:100px"></div>' \
             '<div style="transform:translateX(0);width:300px;height:50px">' \
             '<div id="f" style="position:fixed;top:10px;left:10px;width:20px;height:20px"></div>' \
             '</div></div>')
    at = -> {
      s.evaluate_script(<<~JS)
        (r => Math.round(r.x) + ',' + Math.round(r.y))(document.getElementById('f').getBoundingClientRect())
      JS
    }
    expect(at.call).to eq('10,110')
    s.execute_script('scrollTo(0, 100)')
    expect(at.call).to eq('10,10')
    expect(s.evaluate_script("document.elementFromPoint(15, 15) === document.getElementById('f')")).to be true
  end

  # A sticky box with no SCROLLER over it measures against the viewport — the page is always one,
  # and `overflow: clip` is not (it clips and forbids scrolling, so the box sticks within whatever
  # scrolls around it). A scroller's own scrollport is its CONTENT box, padding and border excluded.
  it 'measures a sticky inset against the nearest scroller, else the viewport' do
    tenth = ->(s) { "#{(s.evaluate_script('innerHeight') * 0.1).round(4)}px" }

    clipped = page('<div style="overflow:clip;width:400px;height:100px">' \
                   '<div id="s" style="position:sticky;top:10%">s</div></div>')
    expect(insets(clipped, 's')).to eq([tenth.call(clipped), 'auto'])

    plain = page('<div style="height:2000px"><div id="s" style="position:sticky;top:10%">s</div></div>')
    expect(insets(plain, 's')).to eq([tenth.call(plain), 'auto'])

    padded = page('<div style="overflow:auto;width:400px;height:200px;padding:20px;border:5px solid">' \
                  '<div style="height:400px"><div id="s" style="position:sticky;top:10%">s</div>' \
                  '</div></div>')
    expect(insets(padded, 's')).to eq(['20px', 'auto'])
  end

  # An `rtl` block starts its children at the RIGHT edge — and an out-of-flow box's static position
  # follows the same flow on the INLINE axis only: it is still as far down the block as the flow had
  # reached, which overriding both axes lost.
  it 'starts an rtl block at the inline-start edge' do
    s = page('<div style="direction:rtl;width:400px"><div id="b" style="width:120px;height:10px"></div>' \
             '<div id="a" style="position:absolute;width:30px;height:10px"></div></div>')
    at = ->(id) {
      s.evaluate_script(<<~JS)
        (r => [Math.round(r.x), Math.round(r.y)])(document.getElementById(#{id.inspect}).getBoundingClientRect())
      JS
    }
    expect(at.call('b')).to eq([280, 0])
    expect(at.call('a')).to eq([370, 10])
  end

  # §10.3.3 balances an over-constrained block on the margin at its inline END — `margin-right` in
  # an `ltr` containing block, `margin-left` in an `rtl` one. So a block too wide for an `rtl`
  # container hangs off its LEFT edge, and one narrower than it still starts at the right.
  it 'balances an rtl block on its own inline axis' do
    x = ->(style) {
      s = page(%(<div style="direction:rtl;width:400px">
                   <div id="a" style="height:10px;#{style}"></div></div>))
      s.evaluate_script("Math.round(document.getElementById('a').getBoundingClientRect().x)")
    }
    expect(x.call('width:500px;margin:0 auto')).to eq(-100)
    expect(x.call('width:200px;margin:0 auto')).to eq(100)
    expect(x.call('width:200px;margin-left:auto;margin-right:20px')).to eq(180)
    expect(x.call('width:500px;margin-left:10px;margin-right:20px')).to eq(-120)
  end

  # A `display: contents` element generates NO box: it is nobody's containing block, it cannot
  # float, it establishes no formatting context — its children belong to the flow around it, and
  # margins collapse straight through it.
  it 'lays a display:contents wrapper out as no box at all' do
    s = page('<div style="width:400px"><div style="display:contents">' \
             '<div id="f" style="float:left;width:100px;height:40px"></div>' \
             '<div id="t" style="height:20px"></div></div></div>' \
             '<div style="width:400px"><div id="m1" style="height:10px;margin-bottom:40px"></div>' \
             '<div style="display:contents"><div id="m2" style="height:10px;margin-top:20px"></div>' \
             '</div></div>')
    box = ->(id) {
      s.evaluate_script(<<~JS)
        (r => [Math.round(r.y), Math.round(r.width)])(document.getElementById(#{id.inspect}).getBoundingClientRect())
      JS
    }
    expect(box.call('f')).to eq([0, 100])       # the float is the CHILD's, not the wrapper's
    expect(box.call('t')).to eq([0, 400])       # …and a sibling block runs under it, full width
    expect(box.call('m1')).to eq([20, 400])     # …so the block after it starts at the float's SIDE
    expect(box.call('m2')).to eq([70, 400])     # 20 + 10 + max(40, 20), collapsed through
  end

  # …and it reports no geometry of its own, which is what a page reads back. `<slot>` is
  # `display: contents`, so this is every web component's slot.
  it 'reports no box for a display:contents element' do
    s = page('<div style="width:400px"><div id="c" style="display:contents">' \
             '<div style="height:20px"></div></div></div>')
    expect(s.evaluate_script(<<~JS)).to eq([0, 0, 0, 0, nil])
      (e => [e.getClientRects().length, e.getBoundingClientRect().width,
             e.offsetWidth, e.offsetHeight, e.offsetParent])(document.getElementById('c'))
    JS
  end
end
