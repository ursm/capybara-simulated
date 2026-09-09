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
