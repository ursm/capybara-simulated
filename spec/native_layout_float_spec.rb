# frozen_string_literal: true
# Native layout — floats (§9.5), geometry shadow-parity. A float is placed in the band its own parent's
# content box leaves (left/right, dropping when it doesn't fit) and is CONTAINED by the auto height of the
# box that establishes the context — which is the nearest ancestor that does, however many plain blocks lie
# between: native shifts the rectangle up through each of them. Cases the engine can't reproduce yet
# (auto-width shrink-to-fit, position:relative, a relatively SHIFTED ancestor, coexisting in-flow content)
# must DECLINE to JS — an A/B per bail proves the guard is specific. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout float parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def run_shadow(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a BFC owner containing a left float (clearfix)' do
    expect_parity('<div style="overflow:hidden"><div style="float:left;width:80px;height:120px"></div></div>')
  end

  it 'matches a right float against the right edge' do
    expect_parity('<div style="overflow:hidden;width:300px"><div style="float:right;width:80px;height:50px"></div></div>')
  end

  it 'matches two left floats where the second drops below the first' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:200px">
        <div style="float:left;width:120px;height:40px"></div>
        <div style="float:left;width:120px;height:30px"></div>
      </div>
    HTML
  end

  it 'matches a left + right float pair sitting side by side' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="float:left;width:80px;height:60px"></div>
        <div style="float:right;width:80px;height:40px"></div>
      </div>
    HTML
  end

  it 'matches an in-flow block BEFORE a float (float sits below it)' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="height:20px"></div>
        <div style="float:left;width:80px;height:60px"></div>
      </div>
    HTML
  end

  it 'matches text (in a sibling block) wrapping around a left float' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:400px">
        <div style="float:left;width:120px;height:60px"></div>
        <div>The quick brown fox jumps over the lazy dog and then keeps on running well past the float and onto full width lines below it right here.</div>
      </div>
    HTML
  end

  it 'matches text wrapping around a right float' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:400px">
        <div style="float:right;width:120px;height:60px"></div>
        <div>The quick brown fox jumps over the lazy dog and then keeps on running well past the float and onto full width lines below it right here.</div>
      </div>
    HTML
  end

  # The media object (§9.5): a sibling that ESTABLISHES its own BFC (overflow / flow-root) does not overlap the
  # float — its whole border box sits in the band the float leaves, narrowed to it, so the two read as columns.
  it 'matches a BFC sibling shrinking into the band beside a left float' do
    expect_parity('<div style="display:flow-root;width:300px"><div style="float:left;width:80px;height:40px"></div><div style="overflow:hidden;height:30px">x</div></div>')
  end

  it 'matches a BFC sibling beside a right float, and under rtl' do
    expect_parity('<div style="display:flow-root;width:300px"><div style="float:right;width:80px;height:40px"></div><div style="overflow:hidden;height:30px">x</div></div>')
    expect_parity('<div dir="rtl" style="display:flow-root;width:300px"><div style="float:right;width:80px;height:40px"></div><div style="overflow:hidden;height:30px">x</div></div>')
  end

  it 'matches a declared-width BFC sibling that keeps its size in the band' do
    expect_parity('<div style="display:flow-root;width:300px"><div style="float:left;width:80px;height:40px"></div><div style="overflow:hidden;width:100px;height:30px"></div></div>')
  end

  it 'matches a BFC sibling too wide for the band dropping below the float' do
    expect_parity('<div style="display:flow-root;width:300px"><div style="float:left;width:80px;height:40px"></div><div style="overflow:hidden;width:280px;height:30px"></div></div>')
  end

  it 'matches a flow-root TEXT sibling avoiding the float with its box (not routing its lines)' do
    expect_parity('<div style="display:flow-root;width:300px"><div style="float:left;width:80px;height:40px"></div><div style="display:flow-root;width:100px;height:30px">x</div></div>')
  end

  it 'matches a line dropping below a wide float its first word cannot clear' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:400px">
        <div style="float:left;width:360px;height:50px"></div>
        <div>Supercalifragilisticexpialidocious wordsmith wander</div>
      </div>
    HTML
  end

  it 'matches a shorter float where lower lines regain full width' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="float:left;width:100px;height:20px"></div>
        <div>alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau</div>
      </div>
    HTML
  end

  it 'matches a clear:left block dropping below a left float' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="float:left;width:100px;height:60px"></div>
        <div style="clear:left;height:20px"></div>
      </div>
    HTML
  end

  it 'matches clear:both below a left + right float pair' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="float:left;width:80px;height:60px"></div>
        <div style="float:right;width:80px;height:40px"></div>
        <div style="clear:both;height:20px"></div>
      </div>
    HTML
  end

  it 'matches a cleared text block laying out full width below the float' do
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="float:left;width:100px;height:60px"></div>
        <div style="clear:left">now on full width lines below the float because it was cleared here</div>
      </div>
    HTML
  end

  it 'matches a cleared block whose descendant margin collapses through its open top' do
    # The inner p's margin-top collapses through the cleared div's open top edge, so the div's collapsing
    # top margin is 60 (not its own 0) — it must sit at 60 (past the 30px float), not at 30.
    expect_parity(<<~HTML)
      <div style="overflow:hidden;width:300px">
        <div style="float:left;width:80px;height:30px"></div>
        <div style="clear:left"><p style="margin-top:60px;height:20px"></p></div>
      </div>
    HTML
  end

  it 'declines a collapse-through cleared box, keeps a non-empty cleared box' do
    expect(run_shadow('<div style="overflow:hidden;width:300px"><div style="float:left;width:80px;height:30px"></div><div style="clear:both;margin-top:10px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden;width:300px"><div style="float:left;width:80px;height:30px"></div><div style="clear:both;height:10px"></div></div>')['ok']).to be true
  end

  # `contain` and multicol establish a formatting context of their own (css-contain-2 §2.1, css-multicol-1 §2):
  # they hold their children's margins in AND own the floats inside them. This engine answered only the first
  # half, which the walk then declined; both halves are native now.
  it 'keeps a contain/multicol formatting context natively' do
    expect(run_shadow('<div style="contain:layout"><p style="margin-top:30px">hi there</p></div>')).to include('ok' => true, 'mismatches' => 0)
    expect(run_shadow('<div style="column-count:2"><p style="margin-top:30px">hi there</p></div>')).to include('ok' => true, 'mismatches' => 0)
    expect(run_shadow('<div><p style="margin-top:30px">hi there</p></div>')).to include('ok' => true, 'mismatches' => 0)
    expect(run_shadow('<div style="width:300px"><div style="contain:layout"><div style="float:left;width:9px;height:4px"></div></div></div>')).to include('ok' => true, 'mismatches' => 0)
  end

  it 'declines a partial clear that leaves a float overlapping, clears the matching side' do
    # clear:left with only a RIGHT float still overlaps it → defer; clear:right clears past it → native.
    expect(run_shadow('<div style="overflow:hidden;width:300px"><div style="float:right;width:80px;height:60px"></div><div style="clear:left;height:20px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden;width:300px"><div style="float:right;width:80px;height:60px"></div><div style="clear:right;height:20px"></div></div>')['ok']).to be true
  end

  # A float's CONTAINING BLOCK is its own parent; the CONTEXT it is recorded in is the nearest ancestor that
  # establishes one, however many plain blocks lie between (§9.5). Native lays the float out in its parent's
  # frame and shifts the rectangle up through each of them, so the everyday `.row > .col { float: left }` —
  # the single biggest decline class in the shape corpus, 123 of 360 — lays out natively.
  it 'threads a float up through the plain blocks between it and the context that owns it' do
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:100px;height:30px"></div>' \
                  '<div style="float:left;width:100px;height:40px"></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:50px;height:20px"></div></div>' \
                  '<div>hello there world</div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:50px;height:50px"></div></div>' \
                  '<div style="clear:left;height:5px"></div></div>')
    # …and the float is placed in ITS OWN parent's content box, not the owner's: a narrower wrapper holds it in.
    expect_parity('<div style="width:300px;overflow:hidden"><div style="margin-left:40px;width:200px">' \
                  '<div style="float:right;width:50px;height:50px"></div></div>' \
                  '<div style="clear:right;height:5px"></div></div>')
  end

  # Every hop the rectangle is shifted by: a wrapper's padding and border (the float sits at its CONTENT
  # origin), its margin and whatever the flow above it came to (the wrapper's own y), and two wrappers rather
  # than one. The owner contains the lot, which is what its height says.
  it 'shifts the escaped rectangle by every frame between the float and the owner' do
    expect_parity('<div style="width:300px;overflow:hidden"><div style="padding-left:10px"><div style="padding-left:20px">' \
                  '<div style="float:left;width:50px;height:50px"></div></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="padding:10px 20px"><div style="float:left;width:50px;height:50px"></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="border:5px solid"><div style="float:left;width:50px;height:50px"></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="margin:20px 0"><div style="float:left;width:50px;height:50px"></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="height:10px"></div><div><div style="float:left;width:50px;height:50px"></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div>text before<div style="height:5px"></div></div><div><div style="float:left;width:50px;height:50px"></div></div></div>')
    # …an rtl owner puts a NARROWER wrapper at its right content edge, so the hop is 200 wide (a full-width
    # wrapper would sit at 0 in either direction and prove nothing).
    expect_parity('<div style="width:300px;overflow:hidden;direction:rtl"><div style="width:100px">' \
                  '<div style="float:left;width:50px;height:50px"></div></div></div>')
  end

  # A CLEARED child is measured before it is placed (its clearance needs its own collapsed top margin), in a
  # context of its own — and what it leaves there has to be shifted in like any other child's. Dropped, a
  # float inside a cleared box vanished from the context: the next `clear` sibling cleared past nothing and
  # the owner's height stopped short (native 115 where Chrome and the oracle say 155).
  it 'keeps the floats that escape a cleared child' do
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:100px"></div>' \
                  '<div style="clear:left;height:10px"><div style="float:left;width:50px;height:50px"></div></div>' \
                  '<div style="clear:left;height:5px"></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:100px"></div>' \
                  '<div style="clear:left;padding-top:10px"><div style="float:left;width:50px;height:50px"></div></div>' \
                  '<div style="clear:left;height:5px"></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:right;width:100px;height:100px"></div>' \
                  '<div style="clear:right;height:10px"><div style="float:right;width:50px;height:50px"></div></div>' \
                  '<div style="clear:right;height:5px"></div></div>')
  end

  # A cleared FIRST child under an open top edge: §8.3.1 excludes a box with clearance from collapsing into
  # its parent, and the clearance line REPLACES its top margin rather than adding to it. Both halves were
  # wrong the moment the walk let a float sit beside a plain wrapper (this arm had been dead code): the margin
  # moved the wrapper AND positioned the child, so a `clear: left; margin-top: 20px` first child after a 5px
  # float landed at 25 where Chrome puts it at 5.
  it 'gives a cleared first child the clearance line, not its collapsed margin' do
    %w[60px 5px].each do |h|
      expect_parity(%(<div style="width:300px;overflow:hidden"><div><div style="float:left;width:100px;height:#{h}"></div>) +
                    '<div style="clear:left;margin-top:20px;height:10px"></div></div></div>')
    end
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:100px;height:60px"></div>' \
                  '<div style="clear:left;margin-top:-20px;height:10px"></div></div></div>')
    # …the margin it folds through from its own first descendant goes the same way
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:100px;height:60px"></div>' \
                  '<div style="clear:left"><div style="margin-top:20px;height:10px"></div></div></div></div>')
    # …a float lifted ABOVE the wrapper's content top clears to nothing, so the box stays at the top
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;margin-top:-40px;width:100px;height:20px"></div>' \
                  '<div style="clear:left;margin-top:20px;height:10px"></div></div></div>')
    # …and with the float inside it, the cleared child both takes its clearance and hands the float on
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:100px;height:60px"></div>' \
                  '<div style="clear:left;margin-top:20px;height:10px"><div style="float:left;width:50px;height:50px"></div></div>' \
                  '<div style="clear:left;height:5px"></div></div></div>')
  end

  # A/B bail — a cleared box that COLLAPSES THROUGH is placed by a different rule (§8.3.1: its own
  # above-margin sits ON TOP of the clearance line and it does not advance the flow), which is also what makes
  # the fresh context on that arm sound: nothing is placed, so nothing escapes unshifted. The ORACLE is wrong
  # on this shape too — it puts the through box at 80 after a 60px float where Chrome says 60, adding the
  # margin to the clearance line instead of spending it — so the decline is "neither engine is ready", not
  # "the oracle is the reference".
  it 'declines a cleared child that collapses through, keeps one with a height' do
    through = '<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:60px"></div>' \
              '<div style="clear:left;margin:20px 0"></div></div>'
    expect(run_shadow(through)['ok']).to be false
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:60px"></div>' \
                  '<div style="clear:left;margin:20px 0;height:1px"></div></div>')
  end

  # A/B bail — and the one case where it is the ORACLE that is wrong. It lays a `position: relative` box's
  # subtree out at the SHIFTED origin, so the float rectangle it records carries the ancestor's offset; §9.4.3
  # is a paint-time shift that changes no other box's layout, and native (which applies the offset after the
  # flow) agrees with Chrome: the `clear` box below is at 50, where the oracle says 60. Declined rather than
  # left to mismatch. A relative ancestor with NO offset — the everyday one, a positioning context for an
  # abspos descendant — stays native, and so does a shift on the box that OWNS the context, which moves with
  # its own floats.
  it 'declines a float under a relatively SHIFTED ancestor, keeps an unshifted one' do
    shifted = '<div style="width:300px;overflow:hidden"><div style="position:relative;top:10px">' \
              '<div style="float:left;width:50px;height:50px"></div></div><div style="clear:left;height:5px"></div></div>'
    expect(run_shadow(shifted)['ok']).to be false
    expect_parity('<div style="width:300px;overflow:hidden"><div style="position:relative">' \
                  '<div style="float:left;width:50px;height:50px"></div></div><div style="clear:left;height:5px"></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden;position:relative;top:10px"><div>' \
                  '<div style="float:left;width:50px;height:50px"></div></div><div style="clear:left;height:5px"></div></div>')
  end

  it 'declines an auto-width (shrink-to-fit) float, keeps an explicit width' do
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;height:50px">hi</div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:40px;height:50px">hi</div></div>')['ok']).to be true
  end

  it 'declines a position:relative float, keeps a static one' do
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;position:relative;width:50px;height:50px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div></div>')['ok']).to be true
  end

  it 'declines in-flow content AFTER a float (needs narrowing/clearance), keeps float-only' do
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div>text after</div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div><div style="height:20px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div></div>')['ok']).to be true
  end
end
