# frozen_string_literal: true
# Native layout — REPLACED LEAF replay, geometry shadow-parity. A replaced element (svg / img / canvas /
# input / …) whose box the oracle resolved from its intrinsic size + CSS, and which lays out no CSS-box
# children of its own, is replayed by native as a childless border box in flow — the same push-and-replay the
# out-of-flow path uses. Handled as a BLOCK-LEVEL child of a block and as a FLEX ITEM (a flex item is
# blockified, so its computed display doesn't matter). Still DECLINES: an INLINE replaced element (an atomic
# inline in a text line) and a control that lays out its own content (a child carries an `_lb`). V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout replaced-leaf parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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

  def expect_bail(body)
    expect(run_shadow(body)).to include('ok' => false)
  end

  # BLOCK-LEVEL replaced children of a block.
  it 'matches a block-level svg among block siblings' do
    expect_parity('<div style="width:300px"><div style="height:20px"></div><svg width="40" height="30" style="display:block"></svg><div style="height:15px"></div></div>')
  end
  it 'matches a block-level img with margins (flow positioning)' do
    expect_parity('<div style="width:300px"><img width="50" height="20" style="display:block;margin:12px 0 8px"><div style="height:10px"></div></div>')
  end
  it 'matches a block-level canvas' do
    expect_parity('<div style="width:300px"><canvas width="60" height="40" style="display:block"></canvas></div>')
  end
  it 'matches a block-level text input sized by CSS' do
    expect_parity('<div style="width:300px"><input type="text" style="display:block;width:120px;height:24px"></div>')
  end

  # Replaced elements as FLEX ITEMS (blockified — computed display doesn't matter).
  it 'matches a block-display svg flex item beside a plain item' do
    expect_parity('<div style="display:flex;gap:10px;width:400px"><svg width="24" height="24" style="display:block"></svg><div style="width:80px;height:24px"></div></div>')
  end
  it 'matches an INLINE-display svg flex item (blockified in the flex line)' do
    expect_parity('<div style="display:flex;align-items:center;width:400px"><svg width="24" height="24"></svg><div style="width:80px;height:40px"></div></div>')
  end
  it 'matches an img and an input as flex items with justify-content' do
    expect_parity('<div style="display:flex;justify-content:space-between;width:400px"><img width="30" height="30"><input type="text" style="width:100px;height:24px"></div>')
  end

  # A replaced element carrying explicit border+padding (its _lb is the border box; native replays it whole).
  it 'matches a bordered, padded block-level svg' do
    expect_parity('<div style="width:300px"><svg width="40" height="30" style="display:block;border:3px solid;padding:5px"></svg></div>')
  end

  # STILL DECLINES.
  it 'declines an INLINE svg in a block (atomic inline in a text line)' do
    expect_bail('<div style="width:300px">text <svg width="16" height="16"></svg> more</div>')
  end
  it 'declines an inline-block img in a block' do
    expect_bail('<div style="width:300px"><img width="20" height="20" style="display:inline-block"></div>')
  end
  # A control that lays out its OWN content (a display:block <select> whose options carry _lb) is NOT a leaf:
  # the oracle sizes it from its intrinsic (one-row) size, so native must decline rather than stack the options.
  it 'declines a display:block <select> that lays out its options (sized by intrinsic, not child flow)' do
    expect_bail('<div style="width:300px"><select style="display:block"><option>aaaa</option><option>bb</option></select></div>')
  end
end
