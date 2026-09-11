# frozen_string_literal: true
# Native layout — INLINE ATOMIC replay (slice 1: inline REPLACED elements — svg / img / an inline control),
# geometry shadow-parity. An atomic inline is a single box on a line: the oracle resolved its box (`_lb`) and
# baseline (`atomicInlineAscent`), and native replays those as a RUN_ATOMIC — the margin-box width is its
# advance, its ascent (+ descent) grow the line box. Its own box is not compared (like every inline fragment
# in a text block); what's validated is the text block's line-broken HEIGHT. Still declines: inline-block /
# inline-flex atomics (deferred), and a non-baseline vertical-align (sub / sup / top). V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout inline-atomic parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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

  it 'matches an inline svg between words on one line' do
    expect_parity('<div style="width:300px">ab <svg width="20" height="16"></svg> cd</div>')
  end
  it 'matches an inline svg TALLER than the text (grows the line box)' do
    expect_parity('<div style="width:300px;font-size:12px">x <svg width="30" height="40"></svg> y</div>')
  end
  it 'matches an inline svg SHORTER than the text (line box unchanged)' do
    expect_parity('<div style="width:300px;font-size:20px">x <svg width="8" height="6"></svg> y</div>')
  end
  it 'matches an img that forces a line wrap' do
    expect_parity('<div style="width:70px">aa <img width="40" height="10"> bb cc</div>')
  end
  it 'matches an inline svg with horizontal margins (advance includes them)' do
    expect_parity('<div style="width:300px">a <svg width="20" height="20" style="margin:0 8px"></svg> b</div>')
  end
  it 'matches two icons and text on a line' do
    expect_parity('<div style="width:300px">go <svg width="16" height="16"></svg> <img width="16" height="16"> now</div>')
  end
  it 'matches an icon at the very start of the block' do
    expect_parity('<div style="width:300px"><svg width="24" height="24"></svg> label</div>')
  end
  it 'matches an explicitly display:inline svg control-shaped box among words' do
    expect_parity('<div style="width:400px">name <svg width="90" height="22"></svg> ok</div>')
  end
  it 'matches an icon glued to a word (no space between)' do
    expect_parity('<div style="width:300px">price<svg width="12" height="12"></svg></div>')
  end

  # An atomic is a break opportunity on BOTH sides even with NO whitespace: a glued atomic/word that overflows
  # must still wrap (regression guards for review Finding 1).
  it 'matches a glued atomic AFTER a word that overflows (breaks before the atomic)' do
    expect_parity('<div style="width:60px">aaaaaaaa<svg width="40" height="10"></svg></div>')
  end
  it 'matches a glued word AFTER an atomic that overflows (breaks before the word)' do
    expect_parity('<div style="width:60px"><svg width="40" height="10"></svg>aaaaaaaa</div>')
  end
  it 'matches an atomic between two glued words that overflow' do
    expect_parity('<div style="width:90px">aaaa<img width="40" height="10">bbbbbbbb</div>')
  end
  # An atomic's margin-top rides its ASCENT, not its descent (regression guard for review Finding 2).
  it 'matches an atomic with a large margin-top on a tall-line block' do
    expect_parity('<div style="width:300px;font:16px/40px monospace">x<svg width="6" height="6" style="margin-top:20px"></svg> y</div>')
  end
  it 'matches an atomic with a small margin-top among normal text' do
    expect_parity('<div style="width:300px;font-size:16px">x<img width="1" height="1" style="margin-top:5px"> y</div>')
  end
  it 'matches an atomic with an asymmetric top/bottom margin' do
    expect_parity('<div style="width:300px;font-size:14px">a <svg width="10" height="10" style="margin:9px 0 3px"></svg> b</div>')
  end

  it 'declines a super-aligned atomic (non-baseline vertical-align)' do
    expect_bail('<div style="width:300px">x <svg width="10" height="10" style="vertical-align:super"></svg> y</div>')
  end
  it 'declines an inline-block atomic (deferred)' do
    expect_bail('<div style="width:300px">x <span style="display:inline-block;width:20px;height:20px"></span> y</div>')
  end
  it 'declines a default (inline-block) form control in text (deferred)' do
    expect_bail('<div style="width:400px">name <input type="text" style="width:90px;height:22px"> ok</div>')
  end
end
