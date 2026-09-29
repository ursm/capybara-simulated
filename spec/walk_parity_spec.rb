# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The Rust walk (`walk.rs`) held against the JS one (CSIM_WALK_PARITY): after each layout pass of the page's own, the
# Rust walk builds the same pass from the style engine's values and native compares the two record by record. These
# pin the instrument itself — that it compares, that a shape it takes comes out the same, and that one it has not been
# taught is declined by name rather than compared wrong.
RSpec.describe 'walk parity' do
  around do |example|
    saved = ENV.values_at('CSIM_STYLO', 'CSIM_WALK_PARITY')
    ENV['CSIM_STYLO'] = '1'
    ENV['CSIM_WALK_PARITY'] = '1'
    example.run
  ensure
    ENV['CSIM_STYLO'], ENV['CSIM_WALK_PARITY'] = saved
  end

  def parity(body, css = '')
    html = <<~HTML
      <!DOCTYPE html><html><head><style>body { margin: 8px; font: 16px sans-serif } #{css}</style></head>
      <body>#{body}</body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')
    s.evaluate_script('__csimWalkParityStats()')
  end

  def expect_clean(stats)
    expect(stats['compared']).to be_positive
    expect(stats).to include('clean' => stats['compared'], 'shape' => 0)
    expect(stats['samples']).to eq([])
  end

  it 'builds the records the JS walk sends for blocks and their text' do
    expect_clean(parity(<<~HTML, '.box { padding: 4px 10px; border: 2px solid; margin: 12px auto; width: 300px } p { line-height: 1.5 }'))
      <div class="box">Some text that wraps across several lines in a box three hundred pixels wide.</div>
      <p>A paragraph</p>
      <pre>pre-
      formatted</pre>
      <div style="height: 0; margin-bottom: 20px"></div>
      <div style="overflow: hidden; min-height: 30px; text-align: center; text-indent: 12px">clip</div>
    HTML
  end

  # A border width computes to a length whatever the style (css-backgrounds-3): the style engine keeps the 7px of a
  # `none` side, and the box draws — and lays out — no border there.
  it 'lays out a none border as no border, whatever width it computes to' do
    expect_clean(parity('<div style="border-width: 7px; border-left-style: solid">x</div>'))
  end

  # A percentage travels as its pair, or as the program a comparison makes of it, for native to resolve at the basis
  # it has; the ROOT's is resolved against the viewport, which native is handed nothing for. The programs are compared
  # by what they come to: the two walks write the same value in different shapes.
  it 'builds percentages, calc() and comparisons as the pairs and programs the JS walk sends' do
    expect_clean(parity(<<~HTML, 'html { padding: 1% 2px }'))
      <div style="width: 50%; height: 30%; padding: 2% 1% 0 calc(10% - 5px); margin: 0 5% 0 auto">
        <div style="width: calc(100% - 2rem); max-width: min(80%, 400px); min-height: clamp(10px, 5%, 40px)">x</div>
        <div style="padding: max(10px, 2%) 0; margin-left: min(5%, 20px); text-indent: 10%">y</div>
      </div>
    HTML
  end

  it 'declines by name what it has not been taught' do
    stats = parity('<div style="float: left">x</div>')
    expect(stats['compared']).to eq(0)
    expect(stats['declined']).to include('float' => be_positive)
  end
end
