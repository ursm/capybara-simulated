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
  # pre / pre-wrap / pre-line are now modelled (WS_MODE code in rec[53]; the Rust tokenizer preserves whitespace
  # for pre/pre-wrap, soft-wraps for normal/pre-wrap/pre-line, and breaks on a newline for all three pre modes).
  it 'matches pre (preserves whitespace + newlines, no soft-wrap)' do
    expect_parity("<div style=\"width:200px;white-space:pre\">preserved   spaces\n    indented line\nthird</div>")
  end
  it 'matches pre with a long line that does NOT soft-wrap (overflows)' do
    expect_parity('<div style="width:60px;white-space:pre">a very long line that will not wrap in pre mode</div>')
  end
  it 'matches pre with blank lines (consecutive newlines each make a line)' do
    expect_parity("<div style=\"width:200px;white-space:pre\">a\n\n\nb</div>")
  end
  it 'matches pre-wrap (preserves whitespace, soft-wraps, breaks on newline)' do
    expect_parity("<div style=\"width:80px;white-space:pre-wrap\">word word word word word word\n    indented</div>")
  end
  it 'matches pre-wrap preserving leading indentation (code-editor shape)' do
    expect_parity('<div style="width:300px;white-space:pre-wrap"><span>  </span><span style="font-weight:bold">def</span> <span>foo</span></div>')
  end
  it 'matches pre-line (collapses spaces, soft-wraps, breaks on newline)' do
    expect_parity("<div style=\"width:80px;white-space:pre-line\">a    b\nword word word word word</div>")
  end
  it 'matches pre-line blank lines (newlines preserved, spaces collapsed)' do
    expect_parity("<div style=\"width:200px;white-space:pre-line\">a\n\nb</div>")
  end
  it 'declines pre with a TAB (tab stops not modelled)' do
    expect_bail("<div style=\"width:200px;white-space:pre\">a\tb</div>")
  end
  # A blank/whitespace pre line INSIDE an inline element (the CodeMirror blank-line shape) is ordinary content —
  # it lays out through the text path (its line box gives the block height, which propagates normally).
  it 'matches a pre-wrap blank line wrapped in a span (CodeMirror blank-line shape)' do
    expect_parity('<div style="width:200px;white-space:pre-wrap"><span> </span></div>')
  end
  it 'matches a pre-wrap line with real content and whitespace between spans' do
    expect_parity('<div style="width:400px;white-space:pre-wrap"><span>  </span><span>def</span> <span>foo</span></div>')
  end
  # An ENTIRELY-whitespace preserve block whose whitespace is DIRECT text (no wrapping element, no real content)
  # declines: the oracle gives it a line box the parent's height does not pick up (block 22 / body 0), a quirk
  # native's block flow can't reproduce.
  it 'declines an entirely-whitespace pre block (direct text — non-propagating line box)' do
    expect_bail('<div style="width:200px;white-space:pre">     </div>')
  end
  it 'declines an entirely-newline pre-wrap block (direct text)' do
    expect_bail("<div style=\"width:200px;white-space:pre-wrap\">\n\n</div>")
  end
  # A whitespace-only EDGED (padded / bordered) inline stays declined even under preserve — the edged-inline gate
  # keys on REAL glyph content, not preserved whitespace (a padded inline's line-box height is fiddly). A padded
  # inline with real content, and an edgeless whitespace span, both lay out fine.
  it 'declines a whitespace-only padded inline in a pre block' do
    expect_bail('<div style="width:200px;white-space:pre">a<b style="padding:0 5px"> </b>b</div>')
  end
end
