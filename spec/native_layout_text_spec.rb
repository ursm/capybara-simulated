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
end
