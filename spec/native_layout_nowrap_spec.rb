# frozen_string_literal: true
# Native layout — white-space:nowrap text, geometry shadow-parity. `nowrap` collapses whitespace exactly like
# `normal` but NEVER soft-wraps: the line grows past the content width; only a <br> breaks it. The block's
# height is one strut (or one per <br>). pre / pre-wrap / pre-line (which PRESERVE whitespace) still decline.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout nowrap parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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

  it 'matches nowrap text that would have wrapped (stays one line, overflows)' do
    expect_parity('<div style="width:80px;white-space:nowrap">some words that would wrap when normal</div>')
  end
  it 'matches a normal-width nowrap block (no wrapping needed)' do
    expect_parity('<div style="width:400px;white-space:nowrap">short line</div>')
  end
  it 'matches nowrap with a <br> forcing the only break' do
    expect_parity('<div style="width:60px;white-space:nowrap">first long line<br>second long line here</div>')
  end
  it 'matches nowrap inherited to inline children (spans keep it)' do
    expect_parity('<div style="width:70px;white-space:nowrap">a <span>bunch of words</span> here now</div>')
  end
  it 'matches nowrap with a taller inline run growing the line box' do
    expect_parity('<div style="width:60px;white-space:nowrap;font-size:12px">tiny <span style="font-size:28px">BIG</span> words</div>')
  end
  it 'matches a nowrap sibling beside a normal-wrapping block' do
    expect_parity('<div style="width:100px"><div style="white-space:nowrap">no wrapping here at all</div><div>this one wraps normally onto lines</div></div>')
  end

  # A nowrap line is NOT shortened by / dropped below a float — it overlaps the float on one line (the oracle
  # does no float handling for a nowrap block). Regression guard for review finding 1.
  it 'matches a nowrap line beside a float too wide for the residual band (no drop, overlaps)' do
    expect_parity('<div style="overflow:hidden;width:400px"><div style="float:left;width:360px;height:50px"></div><div style="white-space:nowrap">Supercalifragilistic wordsmith wander</div></div>')
  end

  it 'declines a child that OVERRIDES the block white-space (per-run wrap difference)' do
    expect_bail('<div style="width:80px">wraps here <span style="white-space:nowrap">but this span does not</span> more</div>')
  end
  it 'declines pre (preserves whitespace)' do
    expect_bail('<div style="width:200px;white-space:pre">preserved   spaces</div>')
  end
end
