# frozen_string_literal: true
# Native layout L2 (inline/text) — geometry shadow-parity: a text-containing block's native height
# (greedy line count × line-height, measured in-process via fontations) must equal the JS layout's `_lb`
# on pure-text blocks (single font, white-space:normal). Validates the native line breaker + text-block
# height against the JS oracle. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout L2 text-block parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def parity(session)
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def expect_parity(body)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a single-line text block' do
    session = simulated_session(page('<div>Hello world</div>'))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a multi-line wrapping text block' do
    text = 'The quick brown fox jumps over the lazy dog and then keeps on running well past the edge of the box.'
    session = simulated_session(page(%(<div style="width:150px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches nested block containers of text blocks' do
    session = simulated_session(page(<<~HTML))
      <div>
        <div style="width:120px">first paragraph of words that wraps onto multiple lines here</div>
        <div style="width:300px">second paragraph on probably one line</div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches text with same-font inline elements (a / span) folded in' do
    text = 'Some words with <a href="#">a link here</a> and a <span>span too</span> that keep wrapping onward.'
    session = simulated_session(page(%(<div style="width:160px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches text with different-font inline runs (bold / em)' do
    text = 'plain words then <b>some bold words</b> then <em>emphasised ones</em> and plain again onward.'
    session = simulated_session(page(%(<div style="width:170px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a larger-font inline run growing the line height' do
    session = simulated_session(page(%(<div style="width:300px">small text <span style="font-size:28px">BIG</span> small again</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a fixed line-height with mixed font metrics (ascent/descent line box)' do
    # A LENGTH line-height does not scale per run, so the taller 28px run's ascent grows the line box
    # past the 40px line-height — max(ascent)+max(descent), not max(line-height). Diverges unless native
    # composes the line box from per-run ascent/descent.
    session = simulated_session(page(%(<div style="width:400px;line-height:40px">small text <span style="font-size:28px">BIG</span> more small text</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches <br> hard breaks (mid, trailing, leading, doubled)' do
    [
      'line one<br>line two',
      'only line<br>',
      '<br>after a leading break',
      'a<br><br>b with a blank line between',
      'first<br>second<br>third',
    ].each do |body|
      session = simulated_session(page(%(<div style="width:400px">#{body}</div>)))
      session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true), "harness bailed on #{body.inspect}: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "mismatch on #{body.inspect}: #{r.inspect}"
    end
  end

  it 'matches an edged inline element (padding/border/margin) affecting wrap' do
    text = 'some words then <span style="padding:0 10px;border:1px solid #000;margin:0 6px">a boxed span</span> and more words that wrap onward here.'
    session = simulated_session(page(%(<div style="width:200px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a text block with padding, border, and margins' do
    text = 'Some words wrapping inside a padded bordered box to check content width and stacked height.'
    session = simulated_session(page(%(<div style="width:180px;margin:12px 0;padding:6px;border:2px solid #000">#{text}</div><div style="height:10px"></div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  # An EDGED (horizontal padding / border / margin) inline whose font CONTENT-AREA exceeds the line-height grows
  # the block to that content-area box — the oracle makes `a<span style="padding:0 5px">x</span>` in an 8px
  # line-height 22 tall (the font box), where a NON-edged span stays at the line-height. Native's line box uses
  # the strut line-height and would under-size it, so it declines this until it grows an edged inline's line box
  # to its content area. A tiny line-height forces the trigger on any host (font-independent). A non-edged span
  # in the same block stays native.
  it 'declines an edged inline whose content-area exceeds the line-height' do
    session = simulated_session(page('<div style="line-height:8px;width:200px">a<span style="padding:0 5px">x</span>b</div>'))
    session.visit '/'
    expect(parity(session)).to include('ok' => false)
  end
  it 'declines a bordered inline whose content-area exceeds the line-height' do
    session = simulated_session(page('<div style="line-height:8px;width:200px">a<span style="border-left:2px solid">x</span>b</div>'))
    session.visit '/'
    expect(parity(session)).to include('ok' => false)
  end

  # A `vertical-align` baseline SHIFT (sub / super / length / %) on an inline element offsets its whole content —
  # its runs ride the shift, growing the line box the block's height reflects. Native threads the accumulated
  # shift through the run stream. (`middle` / `text-top` / `text-bottom`, which place against a box, still decline.)
  ['<sup>x</sup>', '<sub>x</sub>', '<span style="vertical-align:super">x</span>',
   '<span style="vertical-align:sub">x</span>', '<span style="vertical-align:6px">x</span>',
   '<span style="vertical-align:-4px">x</span>', '<span style="vertical-align:40%">x</span>'].each do |el|
    it "matches an inline vertical-align shift #{el[0, 30]}" do
      expect_parity(%(<div style="width:300px">text before #{el} and after text</div>))
    end
  end
  it 'matches nested vertical-align shifts (a sub inside a sup accumulate)' do
    expect_parity('<div style="width:300px">base <sup>up <sub>back down</sub> up</sup> base</div>')
  end
  it 'matches a shifted inline wrapping across lines' do
    expect_parity('<div style="width:120px">word word <span style="vertical-align:super">up</span> word word word word</div>')
  end
  # A shifted element raises only its DIRECTLY-owned text; a NESTED inline child stays on the baseline (the
  # oracle does not raise it), so the line box does not grow — the common `<sup><a>1</a></sup>` footnote-link.
  it 'matches a superscript wrapping a link (nested text stays on the baseline)' do
    expect_parity('<div style="width:300px">footnote <sup><a href="#">1</a></sup> here</div>')
  end
  it 'matches a shift whose text is inside a nested span (no line growth)' do
    expect_parity('<div style="width:300px">a <span style="vertical-align:super"><span>text</span></span> b</div>')
  end
  it 'matches a shift wrapping bold nested content (no line growth)' do
    expect_parity('<div style="width:300px">a <sup><b>1</b></sup> b</div>')
  end
end

RSpec.describe 'native text valign decline', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0;font:16px monospace\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def expect_bail(body)
    session = simulated_session(page(body)); session.visit '/'
    r = session.evaluate_script('document.body.offsetHeight')
    expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => false)
  end

  it('declines vertical-align:middle on an inline element') { expect_bail('<div style="width:300px">text <span style="vertical-align:middle">m</span> here</div>') }
  it('declines vertical-align:text-top on an inline element') { expect_bail('<div style="width:300px">text <span style="vertical-align:text-top">t</span> here</div>') }
end
