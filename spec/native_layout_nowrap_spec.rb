# frozen_string_literal: true
# Native layout — white-space:nowrap text, geometry shadow-parity. `nowrap` collapses whitespace exactly like
# `normal` but NEVER soft-wraps: the line grows past the content width; only a <br> breaks it. The block's
# height is one strut (or one per <br>). A preserving block lays out whatever it holds — its WHOLE content
# white space included (a text block of those lines, since 2026-09-24), edged inlines holding nothing too.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'

RSpec.describe 'native layout nowrap parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # …yielding the session, so a caller that wants to read the laid-out page as well does not build a second
  # one: two V8 isolates per example is how this suite has run out of memory before.
  def run_shadow(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    r = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    block_given? ? yield(r, session) : r
  end

  # `chrome_x` is the page-visible x of `#m`, for a rule both engines were free to get wrong together while
  # the walk declined the shape: parity says nothing about a shape neither engine ever laid out.
  def expect_parity(body, chrome_x = nil)
    run_shadow(body) do |r, session|
      expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
      expect(r['compared']).to be > 0, "nothing was compared: #{body}: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
      expect_no_dropped_records(r, body)
      next if chrome_x.nil?

      x = session.evaluate_script("document.querySelector('#m').getBoundingClientRect().x")
      expect(x).to be_within(0.05).of(chrome_x), "#{body}: #m at x #{x}, Chrome #{chrome_x}"
    end
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

  # A child that OVERRIDES the block's `white-space` used to decline: native had one mode per block. Every run
  # now carries its owner's, and a run that does not soft-wrap is fitted as the one unbreakable token it is —
  # so the span moves to the next line whole rather than placing its first word and overflowing the rest.
  it 'lays out a child that OVERRIDES the block white-space' do
    expect_parity('<div style="width:80px">wraps here <span style="white-space:nowrap">but this span does not</span> more</div>')
    expect_parity('<div style="width:80px;white-space:nowrap">no wrapping <span style="white-space:normal">but this span does</span> more</div>')
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
  # A preserved TAB advances to the block's next stop — native's own since it tracks the pen from the content
  # edge (`Run::tab_px`); see the tab-stop describe in native_layout_text_spec for the rule.
  it 'matches pre with a TAB' do
    expect_parity("<div style=\"width:200px;white-space:pre\">a\tb</div>")
  end
  # A blank/whitespace pre line INSIDE an inline element (the CodeMirror blank-line shape) is ordinary content —
  # it lays out through the text path (its line box gives the block height, which propagates normally).
  it 'matches a pre-wrap blank line wrapped in a span (CodeMirror blank-line shape)' do
    expect_parity('<div style="width:200px;white-space:pre-wrap"><span> </span></div>')
  end
  it 'matches a pre-wrap line with real content and whitespace between spans' do
    expect_parity('<div style="width:400px;white-space:pre-wrap"><span>  </span><span>def</span> <span>foo</span></div>')
  end
  # An ENTIRELY-whitespace preserve block whose whitespace is DIRECT text is a text block of those lines (22 and
  # 44 tall, as in Chrome). It declined as `white-space-only-block` until 2026-09-24, on a note that the oracle's
  # line box did not reach the parent's height (block 22 / body 0) — which no sweep of it reproduces.
  it 'lays out an entirely-whitespace pre block (direct text)' do
    expect_parity('<div style="width:200px;white-space:pre">     </div>')
  end
  it 'lays out an entirely-newline pre-wrap block (direct text)' do
    expect_parity("<div style=\"width:200px;white-space:pre-wrap\">\n\n</div>")
  end
  # A whitespace-only EDGED (padded / bordered) inline used to decline here too, on a gate that keyed on REAL
  # glyph content and gave "a padded inline's line-box height is fiddly" as its reason. That was not the
  # reason: what native actually got wrong was the OPENING EDGE of an inline nothing landed inside, which it
  # dropped at the close where the oracle flushes it. Fixed, the gate is gone and the family lays out — and
  # since both engines were free to be wrong together behind a decline, the figures are Chrome's rather than
  # the oracle's. The marker is the box after the inline, which is what an unplaced edge would move.
  # …the mode is a parameter of the SHAPE, never read back out of the example's name: renaming an arm would
  # otherwise change what it lays out and say nothing about it.
  {
    'whitespace inside a padded inline' => ['pre',      '<b style="padding:0 5px"> </b>', 38.828125],
    'nothing at all inside it'          => ['pre',      '<b style="padding:0 5px"></b>', 29.21875],
    '…and real content, as before'      => ['pre',      '<b style="padding:0 5px">x</b>', 38.828125],
    'a border under pre-wrap'           => ['pre-wrap', '<b style="border-left:3px solid"> </b>', 31.828125]
  }.each do |name, (mode, inner, chrome_x)|
    it "lays out a whitespace-only edged inline in a preserve block: #{name}" do
      body = %(<div style="width:200px;font:16px monospace;white-space:#{mode}">a#{inner}b) +
             %(<i id="m" style="display:inline-block;width:4px;height:4px"></i></div>)
      expect_parity(body, chrome_x)
    end
  end
end
