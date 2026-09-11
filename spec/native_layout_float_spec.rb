# frozen_string_literal: true
# Native layout — floats (§9.5), geometry shadow-parity. Slice c1: a float whose parent establishes the
# block formatting context (overflow:hidden / flow-root) is placed in the band (left/right, dropping when
# it doesn't fit) and CONTAINED by the owner's auto height. Cases the engine can't reproduce yet
# (auto-width shrink-to-fit, position:relative, coexisting in-flow content) must DECLINE to JS — an A/B
# per bail proves the guard is specific. V8 only.
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

  it 'declines a contain/multicol BFC (margin barrier native cannot key), keeps a plain block' do
    expect(run_shadow('<div style="contain:layout"><p style="margin-top:30px">hi there</p></div>')['ok']).to be false
    expect(run_shadow('<div style="column-count:2"><p style="margin-top:30px">hi there</p></div>')['ok']).to be false
    expect(run_shadow('<div><p style="margin-top:30px">hi there</p></div>')['ok']).to be true
  end

  it 'declines a partial clear that leaves a float overlapping, clears the matching side' do
    # clear:left with only a RIGHT float still overlaps it → defer; clear:right clears past it → native.
    expect(run_shadow('<div style="overflow:hidden;width:300px"><div style="float:right;width:80px;height:60px"></div><div style="clear:left;height:20px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden;width:300px"><div style="float:right;width:80px;height:60px"></div><div style="clear:right;height:20px"></div></div>')['ok']).to be true
  end

  # A/B bails — the feature-carrying input declines; a sibling without it stays native.
  it 'declines a float whose parent does not establish a BFC, keeps a BFC parent' do
    expect(run_shadow('<div><div style="float:left;width:50px;height:50px"></div></div>')['ok']).to be false
    expect(run_shadow('<div style="overflow:hidden"><div style="float:left;width:50px;height:50px"></div></div>')['ok']).to be true
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
