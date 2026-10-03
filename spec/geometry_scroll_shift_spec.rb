# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Where the page's scrolling carries a box (ext/csim_native/src/geometry.rs): the scroll offsets around it, and how far
# a `position: sticky` box among them has stuck — read off the boxes the layout left in the arena, with the clip and
# scroll-container facts the walk decided when it laid each box out.
#
# Every figure is Chrome 153-measured on this machine (`--window-size=1024,855`, a 1024x768 viewport), and Firefox
# agrees. A box's WIDTH inside a scroller is left out: that is the scrollbar's to decide (Chrome 285, Firefox 288 of
# 300), and this driver draws none.
RSpec.describe 'the scroll shift' do
  def page(markup)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head>
             <body style="margin:0;font:16px Arial">#{markup}<div style="height:3000px"></div></body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # `[x, y, height]` of the element's client rect.
  def rect(session, id)
    session.evaluate_script(<<~JS)
      (b => [b.x, b.y, b.height].map(v => Math.round(v * 100) / 100))(document.getElementById(#{id.inspect}).getBoundingClientRect())
    JS
  end

  SCROLLER = '<div id="sc" style="overflow:auto;width:300px;height:200px;border:10px solid;padding:20px">' \
             '<div style="height:100px"></div><div id="st" style="position:sticky;top:5px;height:30px">sticky</div>' \
             '<div style="height:600px"></div></div>'

  # A sticky box sticks inside its scroller's scrollport — the padding box inset by the padding, 30px in — and its
  # `offsetTop` moves with it, as its client rect does.
  it 'sticks a sticky box inside the scrollport' do
    s = page(SCROLLER)
    s.execute_script("document.getElementById('sc').scrollTop = 250")
    expect(rect(s, 'st')).to eq([30, 35, 30])
    expect(s.evaluate_script("document.getElementById('st').offsetTop")).to eq(285)
    # …and the document's scroll carries the scroller and what sticks in it alike.
    s.execute_script('window.scrollTo(0, 40)')
    expect(rect(s, 'st')).to eq([30, -5, 30])
  end

  # A sticky table header holds for the whole TABLE, not just its own row.
  it 'sticks a header cell for its whole table' do
    s = page('<div id="sc" style="overflow:auto;width:300px;height:150px"><table style="border-collapse:collapse">' \
             '<thead><tr><th id="th" style="position:sticky;top:0;height:20px">h</th></tr></thead>' \
             '<tbody><tr><td style="height:400px">x</td></tr></tbody></table></div>')
    s.execute_script("document.getElementById('sc').scrollTop = 100")
    expect(rect(s, 'th')[1]).to eq(0)
  end

  # A `display: contents` parent generates no box: the sticky box's containing block is the box around it.
  it 'sticks a sticky box through a box-less parent' do
    s = page('<div id="sc" style="overflow:auto;width:300px;height:150px"><div style="height:50px"></div>' \
             '<div style="display:contents"><div id="dc" style="position:sticky;top:0;height:20px">dc</div></div>' \
             '<div style="height:400px"></div></div>')
    s.execute_script("document.getElementById('sc').scrollTop = 120")
    expect(rect(s, 'dc')).to eq([0, 0, 20])
  end

  # A scroller moves only what it CONTAINS, which an absolutely positioned box placed against a block outside it is not
  # — the scroll carries it up its containing-block chain, past the scroller, as the clip does. (Chrome: 4 and 4, the
  # positioned control's 4 - 150; the document's scroll moves them all.)
  it 'leaves an absolute box whose containing block is outside the scroller where it is' do
    s = page('<div id="sc" style="overflow:auto;height:100px"><div style="height:1000px">' \
             '<i id="abs" style="position:absolute;top:4px;width:40px;height:40px"></i></div></div>' \
             '<div id="sc2" style="overflow:auto;height:100px;position:relative"><div style="height:1000px">' \
             '<i id="abs2" style="position:absolute;top:4px;width:40px;height:40px"></i></div></div>')
    s.execute_script("document.getElementById('sc').scrollTop = 150; document.getElementById('sc2').scrollTop = 150")
    expect([rect(s, 'abs')[1], rect(s, 'abs2')[1]]).to eq([4, 100 + 4 - 150])
    s.execute_script('window.scrollTo(0, 40)')
    expect(rect(s, 'abs')[1]).to eq(-36)
  end

  # `overflow` applies to no inline box: a shifted child of an `overflow: hidden` span is still there to hit.
  it 'clips nothing at an inline box' do
    s = page('<span style="overflow:hidden">abc<b id="inner" style="position:relative;left:300px">far</b></span>')
    expect(s.evaluate_script(<<~JS)).to eq('inner')
      (b => document.elementFromPoint(b.x + 5, b.y + 5).id)(document.getElementById('inner').getBoundingClientRect())
    JS
  end
end
