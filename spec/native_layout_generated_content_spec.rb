# frozen_string_literal: true
# Native layout — GENERATED CONTENT as a BOX, held to recorded goldens. `::before` / `::after` are nodes the
# flow lays out like any other (`flatTreeChildren` puts them first and last), but they are no part of the DOM
# and had no arena node — and the walk read every box back by `_nid` (`boxOf`), so nine separate walk gates
# refused any pseudo that had to BE a box: a flex item, a grid item, a float, an out-of-flow box, a table row
# or cell, an atomic inline. `makePseudoNode` registers one now, the first time the pseudo actually renders,
# and the gates pass untouched.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/layout_golden'

RSpec.describe 'native layout generated content' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # No DOM API answers for a pseudo's own box, so each shape puts it where it moves a box that IS read — a
  # sibling, the line after it, the container it sizes — and the golden holds that box where the pseudo put it.
  def expect_layout(body) = expect_layout_golden(body)

  # One per GATE that refused a pseudo.
  it 'lays out a generated box in every context that refused one' do
    css = '<style>.p::before{content:"x";%s}</style>'
    [
      # a block child, and an ATOMIC INLINE on a line
      [format(css, 'display:block;width:20px;height:10px'), '<div style="width:400px"><div class="p"></div></div>'],
      [format(css, 'display:inline-block;width:20px;height:10px'), '<div style="width:400px">text <span class="p"></span> after</div>'],
      # a FLEX item, both axes, and a GRID item — the pseudo is on the CONTAINER, which is what makes it an
      # item at all; one inside an item is inline content of it and no box.
      [format(css, 'width:20px;height:10px'), '<div class="p" style="display:flex;width:400px"><div style="width:30px;height:10px"></div></div>'],
      [format(css, 'width:20px;height:10px'), '<div class="p" style="display:flex;flex-direction:column;width:400px"><div style="width:30px;height:10px"></div></div>'],
      [format(css, 'width:20px;height:10px'), '<div class="p" style="display:grid;grid-template-columns:100px auto;width:400px"><div>x</div></div>'],
      # a FLOAT, the text beside it routed round it, and an OUT-OF-FLOW box (which moves nothing: see below)
      [format(css, 'float:left;width:20px;height:10px'), '<div style="width:400px"><div class="p">beside</div></div>'],
      [format(css, 'float:left;width:20px;height:10px'), '<div style="width:400px"><div class="p"></div></div>'],
      [format(css, 'position:absolute;width:20px;height:10px'), '<div style="width:400px;position:relative"><div class="p"></div></div>'],
      # a TABLE CELL, on the row
      [format(css, 'display:table-cell;width:20px;height:10px'), '<table style="border-spacing:0"><tr class="p"><td style="padding:0">a</td></tr></table>']
    ].each {|style, body| expect_layout(style + body) }
  end

  # …an out-of-flow pseudo moves no other box, so it is found by hit-testing: the point it covers answers its
  # originating element, where without the pseudo it answers the container.
  it 'hit-tests an out-of-flow generated box' do
    session = simulated_session(page('<style>.p::before{content:"x";position:absolute;left:30px;top:5px;width:20px;height:10px}</style>' \
                                     '<div id="c" style="width:400px;height:40px;position:relative"><div id="p" class="p"></div></div>'))
    session.visit '/'
    expect(session.evaluate_script('document.elementFromPoint(35, 10).id')).to eq('p')
    expect(session.evaluate_script('document.elementFromPoint(60, 10).id')).to eq('c')
  end

  # …and `::after` is the same box at the other end of the children.
  it 'lays out an ::after the same way' do
    expect_layout('<style>.p::after{content:"y";display:block;width:15px;height:8px}</style>' \
                  '<div style="width:max-content"><div class="p"><div style="width:30px;height:10px"></div></div></div>')
  end

  # …the arena node is a box holder, not a DOM node. Nothing queries it, and nothing but the layout reads it — so
  # a page that generates nothing allocates none at all, which is what keeps `getComputedStyle(el, '::before')` on
  # an ordinary page from filling the arena with boxes that can never exist.
  it 'allocates no arena node for a pseudo that renders nothing' do
    session = simulated_session(page('<div id="d" style="width:400px">x</div>'))
    session.visit '/'
    nid = session.evaluate_script(<<~JS)
      (function () {
        globalThis.getComputedStyle(document.getElementById('d'), '::before').color;
        const slot = document.getElementById('d')._pseudoNodes;
        return slot && slot.before ? (slot.before._nid == null ? -1 : slot.before._nid) : -2;
      })()
    JS
    expect(nid).to be < 0, "a pseudo that renders nothing took an arena slot: #{nid}"
  end
end
