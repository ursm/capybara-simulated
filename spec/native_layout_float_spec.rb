# frozen_string_literal: true
# Native layout — floats (§9.5), geometry shadow-parity. A float is placed in the band its own parent's
# content box leaves (left/right, dropping when it doesn't fit), sized from its own content where its width
# is `auto` (§10.3.5), and CONTAINED by the auto height of the box that establishes the context — which is
# the nearest ancestor that does, however many plain blocks lie between: native shifts the rectangle up
# through each of them. Cases the engine can't reproduce yet (position:relative, a relatively SHIFTED
# ancestor, a float whose content native cannot measure) must DECLINE to JS — an A/B per bail proves the
# guard is specific. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/walk_refusals'

RSpec.describe 'native layout float parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
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

  # §9.4.3 is a PAINT-time shift: it changes no other box's layout, so the rectangle the enclosing formatting
  # context excludes at is the float's UNSHIFTED one even though the float is painted at the shift. Native
  # applies the offset after the flow (rec[39..40]) and was always right; the ORACLE laid a relative block's
  # subtree out at the shifted origin, so the rectangle it recorded carried the ancestor's offset and the
  # `clear` box below came out at 60 where Chrome says 50. This shape was DECLINED for exactly as long as
  # that was true. The oracle lays out then moves now (`shiftSubtree`, as it already did for an inline box's
  # relative children) and the whole family is native.
  it 'excludes a float at its unshifted rectangle under a relative ancestor' do
    shell = '<div style="width:300px;overflow:hidden">'
    float = '<div style="float:left;width:50px;height:50px"></div>'
    clear = '<div style="clear:left;height:5px"></div>'
    ['position:relative;top:10px', 'position:relative;left:20px', 'position:relative;top:-8px',
     'position:relative'].each do |shift|
      expect_parity(%(#{shell}<div style="#{shift}">#{float}</div>#{clear}</div>))
      # …however many plain blocks lie between the shift and the float, and nested shifts too
      expect_parity(%(#{shell}<div style="#{shift}"><div>#{float}</div></div>#{clear}</div>))
      expect_parity(%(#{shell}<div style="#{shift}"><div style="position:relative;top:5px">#{float}</div></div>#{clear}</div>))
    end
    # …and a shift on the box that OWNS the context, which moves with its own floats and never diverged
    expect_parity(%(<div style="width:300px;overflow:hidden;position:relative;top:10px"><div>#{float}</div>#{clear}</div>))
  end

  # §10.3.5: a float's AUTO width SHRINKS TO FIT where a block's fills — its min-content widened to the room
  # its containing block leaves it, capped at its max-content. Native measures that from the float's own
  # content like every other content-sized box; the walk marks the float a MEASURED subtree so a shape native
  # cannot measure declines in the walk rather than mid-pass.
  it 'shrinks an auto-width float to fit its own content' do
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left">hi there</div></div>')
    # …capped at the room, so a long run wraps inside the float rather than overflowing it
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left">one two three four five ' \
                  'six seven eight nine ten eleven twelve</div></div>')
    # …its own edges ride the width — a PERCENTAGE one is the interesting half, since an intrinsic
    # contribution resolves it against nothing and the used width has to put it back (`pctEdgesX`).
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;padding:0 10px;border:2px solid">hi</div></div>')
    expect_parity('<div style="width:400px;overflow:hidden"><div style="float:left;padding:0 10%">hello there</div></div>')
    expect_parity('<div style="width:400px;overflow:hidden"><div style="float:left;margin:0 5%;padding:0 10%">hello there</div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:right;margin:0 20px">hi there</div></div>')
    # …and its own min/max clamp the result, as they do a declared width — where `box-sizing` finally shows,
    # because the border-box floor is applied AFTER the clamp (a `max-width: 5px` border box is its own 20px
    # of padding wide, a content box 25).
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;max-width:30px">hi there</div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;min-width:200px">hi</div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;box-sizing:border-box;padding:0 10px;max-width:5px">hi</div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;padding:0 10px;max-width:5px">hi</div></div>')
    # …an intrinsic-size KEYWORD on a float is the same helper's other arm, not the fit-content one
    %w[min-content max-content fit-content].each do |kw|
      expect_parity(%(<div style="width:300px;overflow:hidden"><div style="float:left;width:#{kw}">bb cc</div></div>))
    end
    # …a box child, not text, sizes it just the same, and the flow around it still clears
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left"><div style="width:40px;height:10px"></div></div>' \
                  '<div style="clear:left;height:5px"></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left">hi</div><div>text beside the float</div></div>')
  end

  # …and a float whose content native cannot measure declines in the WALK — the same `nlIntrinsicMeasurable`
  # gate every other content-sized box goes through — rather than leaving Rust to fail the whole pass.
  it 'declines an auto-width float native cannot measure, keeps one it can' do
    WalkRefusals::ATOMIC.each do |inner|
      r = run_shadow(%(<div style="width:300px;overflow:hidden"><div style="float:left">#{inner}</div></div>))
      expect(r).to include('ok' => false), "#{inner}: #{r.inspect}"
      # …and the SAME content behind a declared width, which needs no measure: the refusal is width-driven,
      # not a refusal of the subtree itself.
      expect_parity(%(<div style="width:300px;overflow:hidden"><div style="float:left;width:200px">#{inner}</div></div>))
    end
  end

  it 'declines a position:relative float, keeps a static one' do
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;position:relative;width:50px;height:50px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div></div>')['ok']).to be true
  end

  # An ordinary BLOCK CONTAINER beside a float keeps its full width and OVERLAPS it (§9.5) — it is the LINES
  # inside it that route around the float, at whatever depth they sit. Native lays it out in this block's
  # context read in the child's own frame, which needs the child's origin, which needs its collapsed top
  # margin: so a child of a block whose context holds a float is measured once in an empty context for the
  # margin and again in the translated one. A first child under an open top edge sits at the content top
  # whatever its margin comes to, so it needs no such probe — and neither does any child of a block with no
  # float in its context, which is every block on a float-free page.
  it 'overlaps a plain block container with the float and routes the lines inside it' do
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:50px;height:50px"></div>' \
                  '<div style="height:20px"></div></div>')
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:left;width:100px;height:40px"></div>' \
                  '<div><div>one two three four five six seven eight nine</div></div></div>')
    # …and the band opens again below the float, mid-block
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:left;width:100px;height:20px"></div>' \
                  '<div><div>one two three four five six seven eight nine ten</div></div></div>')
    # …through two wrappers, a right float, and a wrapper whose own padding moves the frame
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:right;width:100px;height:40px"></div>' \
                  '<div><div><div>one two three four five six seven</div></div></div></div>')
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:left;width:100px;height:40px"></div>' \
                  '<div style="padding:5px 10px"><div>one two three four five six seven</div></div></div>')
    # …a BFC box nested inside the overlapping wrapper still avoids the float, in the wrapper's frame
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:left;width:100px;height:40px"></div>' \
                  '<div><div style="overflow:hidden;height:10px"></div></div></div>')
    # …and a second float-bearing wrapper places its float beside the first one's
    expect_parity('<div style="width:300px;overflow:hidden"><div><div style="float:left;width:50px;height:50px"></div></div>' \
                  '<div><div style="float:left;width:40px;height:20px"></div></div></div>')
    # …the sibling's own margin collapses through it as ever
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:50px;height:50px"></div>' \
                  '<div><div style="margin-top:30px;height:10px"></div></div></div>')
  end

  # …and a descendant PULLED ABOVE the block's own top by a negative margin meets floats the block's border
  # box never reaches, so which floats reach into a child is asked of the CONTEXT, not of the child's top: a
  # `margin-top:-40px` pull-up under a box that starts below the float laid its text out full width where
  # Chrome wraps it round.
  it 'routes a descendant pulled above its own block into the floats beside it' do
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:left;width:100px;height:40px"></div>' \
                  '<div style="height:51px"></div><div><div style="height:1px"></div>' \
                  '<div style="margin-top:-40px">one two three four five six seven eight</div></div></div>')
    # …the pull-up has to be a NON-FIRST descendant to test it: on the first child the negative margin folds
    # into the wrapper's own collapsed top, which the wrapper's position already carries.
    expect_parity('<div style="width:200px;overflow:hidden"><div style="float:left;width:100px;height:40px"></div>' \
                  '<div style="height:45px"></div><div><div style="height:1px"></div>' \
                  '<div><div style="margin-top:-30px">one two three four five six seven eight</div></div></div></div>')
  end

  # A box's margin must not DEPEND on the floats it is measured among, or the two measures the float paths
  # take disagree about where it goes: the translation was made at the first one's answer, and the second
  # one's is what places it. Whether a `clear` separates that margin from its parent's (§8.3.1) is therefore
  # answered STRUCTURALLY, off the record, exactly as the oracle answers it — a float earlier in the box's
  # formatting context, whether or not the measure that meets the box can see it. Derived from the floats in
  # hand instead, a cleared descendant contributed `{pos: 20, neg: -20}` to the float-free measure and
  # nothing to the float-aware one, which moved the box 10px and declined the page to keep it honest.
  it 'keeps a cleared descendant\'s margin the same in both measures' do
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:100px"></div>' \
                  '<div style="height:10px;margin-bottom:10px"></div>' \
                  '<div><div style="clear:left;margin-top:20px;height:5px"><div style="margin-top:-20px;height:1px"></div></div></div></div>')
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:100px"></div>' \
                  '<div style="height:10px;margin-bottom:10px"></div>' \
                  '<div><div style="clear:left;margin-top:20px;height:5px"><div style="height:1px"></div></div></div></div>')
    # …and the same shape with nothing cleared inside it
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:100px"></div>' \
                  '<div style="height:10px;margin-bottom:10px"></div>' \
                  '<div><div style="margin-top:20px;height:5px"><div style="margin-top:-20px;height:1px"></div></div></div></div>')
  end

  # A/B — a float ABOVE the pass root is one the pass never places, so nothing inside can be positioned
  # against it: a box that would CLEAR it took neither its margin nor the clearance (5 tall where the oracle
  # says 65), one that would AVOID it kept the full width, and the pass ROOT's own used width is the band the
  # float leaves (an `overflow: hidden` root beside a 100px float is 200 wide, and a pass that cannot see the
  # float says 300). The walk refuses such a pass rather than answer part of it.
  it 'refuses a sub-root pass under a float above its root' do
    above = '<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:100px"></div>' \
            '<div style="height:40px"></div>'
    [
      '<div id="w"><div style="clear:left;margin-top:20px;height:5px"></div></div>',
      '<div id="w"><div style="overflow:hidden;height:25px"></div></div>',
      '<div id="w" style="overflow:hidden"><div style="height:25px"></div></div>',
      '<div id="w"><div style="margin-top:20px;height:5px"></div></div>'
    ].each do |inner|
      session = simulated_session(page("#{above}#{inner}</div>"))
      session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      sub = session.evaluate_script("globalThis.__csimLayoutShadowRun(document.querySelector('#w'))")
      expect(sub).to include('ok' => false, 'reason' => 'float above the pass root'), "#{inner}: #{sub.inspect}"
      # …and the whole-document pass, which does place that float, lays the same page out natively
      expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0)
    end

    # …a pass whose root holds the float ITSELF places it, and lays out
    own = simulated_session(page('<div style="width:300px;overflow:hidden"><div style="height:40px"></div>' \
                                 '<div id="w"><div style="float:left;width:20px;height:10px"></div>' \
                                 '<div style="clear:left;height:5px"></div></div></div>'))
    own.visit '/'
    own.evaluate_script('document.body.offsetHeight')
    expect(own.evaluate_script("globalThis.__csimLayoutShadowRun(document.querySelector('#w'))"))
      .to include('ok' => true, 'mismatches' => 0)
  end

  # …the shapes that made the structural answer necessary: a cleared box whose float is one its own measure
  # never meets, because an ANCESTOR inherited it. Its margin is separated all the same, and the box lands on
  # the clearance line the floats in hand give it.
  it 'separates a cleared box from a float its own measure cannot see' do
    %w[30px 61px].each do |h|
      expect_parity(%(<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:#{h}"></div>) +
                    '<div style="height:40px"></div><div><div style="clear:left;margin-top:20px;height:5px"></div>' \
                    '<div style="height:3px"></div></div></div>')
    end
    expect_parity('<div style="width:300px;overflow:hidden"><div style="float:left;width:100px;height:30px"></div>' \
                  '<div style="height:40px;margin-bottom:10px"></div>' \
                  '<div><div style="clear:left;margin-top:-10px;height:5px"></div></div></div>')
  end

  # A float written in INLINE content — beside bare text, inside a `<span>`, mid-paragraph — is a marker in the run
  # stream: native places it where the flow reaches it (the top of the line it interrupts, beside the floats
  # already there) and the rest of that line, and every line after it, routes around it. The pen already on the
  # line does not move for a LEFT float placed beside it: both engines keep it where it stood, where Chrome moves
  # the placed content past the float (a shared divergence, recorded rather than fixed during the port).
  it 'matches a float written in inline content' do
    [
      '<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div>text after</div>',
      '<div style="width:300px"><span style="float:left">f</span>aaa bbb</div><p>after</p>',
      '<div style="width:300px">aaa <span style="float:right;width:250px;height:10px"></span>bbb ccc</div>',
      '<div style="width:300px">aaa <span>b<span style="float:left;width:30%;height:15px"></span>bb</span> ccc</div>',
      '<div style="width:300px">aaa <span style="float:left;width:50px;height:20px"></span>bbb <span style="display:inline-block;width:10px;height:5px"></span></div>',
      '<div style="width:300px">aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk <div style="float:left;width:60px;height:60px;margin:4px 6px">x</div>llll mmmm nnnn</div>',
      '<div style="width:300px;overflow:hidden">x<span style="float:left;height:80px">f</span></div><p>after</p>',
      '<div style="width:400px"><span style="display:inline-block">aa <span style="float:left">fl oat</span>bb</span></div>',
      '<table><tr><td>aa <span style="float:right;width:40px;height:10px"></span>bb</td></tr></table>',
      # …a float in a RELATIVE inline moves with the inline's content (Chrome: 10, 5), the block holding nothing
      # else included
      '<div style="width:400px">aa <span style="position:relative;left:10px;top:5px"><span style="float:left;width:20px;height:20px"></span>bb</span></div>',
      '<div><span style="position:relative;left:10px"><span style="float:left;width:20px;height:20px">x</span></span></div>',
      # …and an out-of-flow box waiting on an inline's opening edge steps back with the pen a left float moved
      '<div style="width:300px;position:relative">aa <span style="padding-left:10px"><span style="position:absolute">abs</span><span style="float:left;width:30px;height:20px"></span>bbb</span></div>'
    ].each {|body| expect_parity(body) }
  end

  # …and what it still declines, each beside the static float it keeps: a POSITIONED float (as a float child of a
  # block does), and an auto-width one native cannot measure.
  it 'declines an inline float native cannot place, keeps the plain one' do
    keep = '<div style="width:300px">aaa <span style="float:left;width:50px;height:20px"></span>bbb</div>'
    expect(run_shadow(keep)['ok']).to be true
    expect(run_shadow(keep.sub('float:left;', 'float:left;position:relative;'))['ok']).to be false
    expect(run_shadow(%(<div style="width:300px">aaa <span style="float:left">#{WalkRefusals::ATOMIC.last}</span>bbb</div>))['ok']).to be false
  end
end
