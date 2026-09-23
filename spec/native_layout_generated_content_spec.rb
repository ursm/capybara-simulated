# frozen_string_literal: true
# Native layout — GENERATED CONTENT as a BOX, geometry shadow-parity. `::before` / `::after` are nodes the
# flow lays out like any other (`flatTreeChildren` puts them first and last), but they are no part of the DOM
# and had no arena node — and the harness reads every box back by `_nid` (`boxOf`), so nine separate walk
# gates refused any pseudo that had to BE a box: a flex item, a grid item, a float, an out-of-flow box, a
# table row or cell, an atomic inline. `makePseudoNode` registers one now, the first time the pseudo actually
# renders, and the gates pass untouched. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'

RSpec.describe 'native layout generated-content parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # Parity AND the pseudo was one of the boxes COMPARED. Asserting `ok` and `mismatches` alone cannot fail:
  # the same page with its `content` rule removed is `ok: true, mismatches: 0` too, with `compared` merely one
  # lower. So a shape whose pseudo silently stopped being a box would pass a spec that only asked those two
  # while proving nothing — measured, with `content: none` or a `display: none` on the pseudo this file is
  # GREEN without the line below and RED with it. (A `counter()` is not that trap: it renders nothing today
  # but still makes an empty box, so the count holds.) `boxes` is how many boxes native answered for.
  def expect_pseudo_compared(body, boxes)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    r = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(r).to include('ok' => true), "harness bailed: #{body}: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{body}: #{r.inspect}"
    expect_no_dropped_records(r, body)
    expect(r['compared']).to eq(boxes), "the pseudo was not a compared box: #{body}: #{r.inspect}"

  end

  # One per GATE that refused a pseudo. The counts are body + the shape's own elements + the pseudo; each was
  # read off the harness and each drops by one if the pseudo stops being a box.
  it 'lays out a generated box in every context that refused one' do
    css = '<style>.p::before{content:"x";%s}</style>'
    {
      # a block child, and an ATOMIC INLINE on a line (three, not four: the <span> carrying the pseudo is an
      # inline with no edges, so it has no box of its own)
      [format(css, 'display:block;width:20px;height:10px'), '<div style="width:400px"><div class="p"></div></div>'] => 4,
      [format(css, 'display:inline-block;width:20px;height:10px'), '<div style="width:400px">text <span class="p"></span> after</div>'] => 3,
      # a FLEX item, both axes, and a GRID item — the pseudo is on the CONTAINER, which is what makes it an
      # item at all; one inside an item is inline content of it and no box.
      [format(css, 'width:20px;height:10px'), '<div class="p" style="display:flex;width:400px"><div style="width:30px;height:10px"></div></div>'] => 4,
      [format(css, 'width:20px;height:10px'), '<div class="p" style="display:flex;flex-direction:column;width:400px"><div style="width:30px;height:10px"></div></div>'] => 4,
      [format(css, 'width:20px;height:10px'), '<div class="p" style="display:grid;grid-template-columns:100px auto;width:400px"><div>x</div></div>'] => 4,
      # a FLOAT, and an OUT-OF-FLOW box
      [format(css, 'float:left;width:20px;height:10px'), '<div style="width:400px"><div class="p"></div></div>'] => 4,
      [format(css, 'position:absolute;width:20px;height:10px'), '<div style="width:400px;position:relative"><div class="p"></div></div>'] => 4,
      # a TABLE CELL, on the row
      [format(css, 'display:table-cell;width:20px;height:10px'), '<table style="border-spacing:0"><tr class="p"><td style="padding:0">a</td></tr></table>'] => 6
    }.each {|(style, body), boxes| expect_pseudo_compared(style + body, boxes) }
  end

  # …and `::after` is the same box at the other end of the children.
  it 'lays out an ::after the same way' do
    expect_pseudo_compared('<style>.p::after{content:"y";display:block;width:15px;height:8px}</style>' \
                           '<div style="width:max-content"><div class="p"><div style="width:30px;height:10px"></div></div></div>', 5)
  end

  # …the box is the ORACLE's box: the arena node is a box holder, not a DOM node. Nothing queries it, and
  # nothing but the layout reads it — so a page that generates nothing allocates none at all, which is what
  # keeps `getComputedStyle(el, '::before')` on an ordinary page from filling the arena with boxes that can
  # never exist.
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
