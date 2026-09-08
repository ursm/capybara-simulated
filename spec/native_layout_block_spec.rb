# frozen_string_literal: true
# Native layout L1 (block flow) — geometry shadow-parity: the native pass's border-boxes must equal the
# JS layout's `_lb` on a pure block-flow page (explicit heights / no inline text / no float / no
# abspos — the cases L1 models). Validates the native block algorithm against the JS oracle before it
# becomes authoritative. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout L1 block-flow parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def parity(session)
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  it 'matches on stacked blocks with explicit heights' do
    session = simulated_session(page(<<~HTML))
      <div style="height:50px"></div>
      <div style="height:30px"></div>
      <div style="height:auto"><div style="height:20px"></div><div style="height:25px"></div></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['compared']).to be >= 5
  end

  it 'matches with margins, padding, borders, and box-sizing (margin collapsing)' do
    session = simulated_session(page(<<~HTML))
      <div style="height:40px;margin:10px 0;padding:5px;border:2px solid #000"></div>
      <div style="box-sizing:border-box;width:200px;height:60px;padding:8px;border:3px solid #000">
        <div style="height:20px;margin-left:15px"></div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches complex collapsing: adjacent margins, closed edges, empty block, nesting' do
    session = simulated_session(page(<<~HTML))
      <div style="margin-bottom:30px;height:20px"></div>
      <div style="margin-top:10px;height:20px"></div>
      <div style="margin:15px 0"></div>
      <div style="padding-top:1px;margin-top:25px">
        <div style="margin-top:40px;height:20px"></div>
      </div>
      <div style="margin-top:12px">
        <div style="margin-top:8px;height:20px"></div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches percentage and clamped widths' do
    session = simulated_session(page(<<~HTML))
      <div style="width:60%;height:30px"></div>
      <div style="width:50%;max-width:120px;height:20px"></div>
      <div style="width:100px;min-width:300px;height:20px"></div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end
end
