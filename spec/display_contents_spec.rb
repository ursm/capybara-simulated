# `display: contents` generates NO BOX: the element is replaced, for layout, by its children (CSS Display 3
# §3.1). CLAUDE.md listed it for a long time as a *rendering* subsystem this driver deliberately does not
# model, beside glyph shaping — and `layout.js` has modelled it in four places all along:
#
#   `isBlockLevelChild`       looks THROUGH one to decide whether its children are block-level
#   `placeInlineChild`        puts its inline content on the line in place, so it can neither start nor end one
#   `contentIntrinsicWidths`  walks its children as that line's, for an intrinsic measure
#   `generatesBox`            gives it no box at all, so it can neither float nor establish a context
#
# The figures here are Chrome's, measured headless on this machine, and they are in the file rather than in a
# commit message on purpose: the ruling that used to exclude this was retired on a measurement, and a
# measurement nothing re-runs is exactly the "memory of a measurement" the scope list is meant to replace.
#
# Sub-pixel differences are the glyph advance, not the layout: Chrome reports 96.02 where the driver reports
# 96.00 for the same two monospace characters, and that gap is `font_resolution_fontconfig`'s, shared by every
# text shape in the suite. Hence `be_within`.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'display: contents' do
  def page(body)
    Rack::Builder.new {
      run ->(_env) {
        [200, {'content-type' => 'text/html; charset=utf-8'},
         [%(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)]]
      }
    }.to_app
  end

  def rect(body, selector = '#t')
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script(%(JSON.parse(JSON.stringify(document.querySelector('#{selector}').getBoundingClientRect()))))
  end

  # x, y, width, height — Chrome's, for the marked element.
  {
    'puts its inline content on the line in place' =>
      ['<div style="width:400px;font:16px monospace">x<span style="display:contents">aaaa bbbb</span><i id="t" style="display:inline-block;width:4px;height:4px"></i>y</div>',
       [96.02, 13, 4, 4]],
    'hands a block child through to the flow' =>
      ['<div style="width:400px"><span style="display:contents"><div id="t" style="height:10px">b</div></span><div style="height:5px"></div></div>',
       [0, 0, 400, 10]],
    'hands TWO block children through, stacked' =>
      ['<div style="width:400px"><span style="display:contents"><div style="height:10px">a</div><div id="t" style="height:12px">b</div></span></div>',
       [0, 10, 400, 12]],
    "makes its children the flex container's items" =>
      ['<div style="display:flex;width:400px"><span style="display:contents"><div id="t" style="width:30px;height:10px"></div><div style="width:40px;height:10px"></div></span></div>',
       [0, 0, 30, 10]],
    "makes its children the grid's items" =>
      ['<div style="display:grid;grid-template-columns:50px 60px;width:400px"><span style="display:contents"><div id="t" style="height:10px">a</div><div style="height:10px">b</div></span></div>',
       [0, 0, 50, 10]],
    # …a box-less element contributes no edges: its own padding, border and margin are dropped entirely.
    'drops its own padding' =>
      ['<div style="width:400px;font:16px monospace">x<span style="display:contents;padding:0 20px">aaaa</span><i id="t" style="display:inline-block;width:4px;height:4px"></i></div>',
       [48.02, 13, 4, 4]],
    'nests' =>
      ['<div style="width:400px;font:16px monospace">x<span style="display:contents"><span style="display:contents">aaaa</span></span><i id="t" style="display:inline-block;width:4px;height:4px"></i></div>',
       [48.02, 13, 4, 4]],
    'hands a float through to the context outside it' =>
      ['<div style="width:400px;overflow:hidden"><span style="display:contents"><div style="float:left;width:30px;height:20px"></div></span><div id="t" style="height:5px"></div></div>',
       [0, 0, 400, 5]],
    'is walked through by an intrinsic measure' =>
      ['<div style="width:max-content;font:16px monospace"><span style="display:contents">aaaa bbbb</span><i id="t" style="display:inline-block;width:4px;height:4px"></i></div>',
       [86.41, 13, 4, 4]],
    'hands a table row through to the table' =>
      ['<table style="border-spacing:0"><span style="display:contents"><tr><td style="padding:0" id="t">a</td></tr></span></table>',
       [0, 0, 7.109375, 18]]
  }.each do |name, (body, chrome)|
    it name do
      r = rect(body)
      %w[x y width height].each_with_index do |k, i|
        expect(r[k]).to be_within(0.05).of(chrome[i]), "#{k}: #{r.inspect} vs Chrome #{chrome.inspect}"
      end
    end
  end

  # …and the one place it is WRONG, kept here with its Chrome figure rather than only in an allowlist line,
  # because a bug with a written-down cause is a backlog item and an unexplained allowlist entry is not.
  # `css/cssom/getComputedStyle-pseudo.html` in the WPT allowlist is this subtest.
  #
  # THE CAUSE IS THE WHOLE FAMILY, not the border case it was first written as. A box-less element still
  # resolves a USED WIDTH of its own here, and the pseudo's percentage resolves against that rather than
  # against the parent's content box — so every declaration that would have changed a real box's width
  # changes this basis, including two that could not possibly contribute edges to one. Pinning only the
  # border case would let a fix that stops counting borders, and leaves the phantom box, turn this green
  # with `padding` and `width` still wrong.
  {
    'border: 10px solid red'             => '40px',   # 100 − 20
    'padding: 0 10px'                    => '40px',   # …the same, through padding
    'margin: 0 10px'                     => '40px',   # …and through a MARGIN, which is no box's edge at all
    'border: 10px solid red; width:60px' => '30px',   # …a declared width REPLACES the basis: 50% of 60
    'width: 60px'                        => '30px'
  }.each do |decl, ours|
    it "RESOLVES a percentage pseudo against a phantom box (#{decl}) — known, allowlisted" do
      body = <<~HTML
        <style>
          #box { width: 100px }
          #c { display: contents; #{decl} }
          #c::before { content: "x"; width: 50%; display: block }
        </style>
        <div id="box"><div id="c">c</div></div>
      HTML
      session = simulated_session(page(body))
      session.visit '/'
      got = session.evaluate_script(%(getComputedStyle(document.getElementById('c'), '::before').width))
      # …Chrome answers 50px for all five: the basis is `#box`'s content box, whatever `#c` declares.
      # When these start failing, the allowlist line comes off with them.
      expect(got).to eq(ours)
    end
  end
  # …and the control, which is right today and says the basis IS the parent's when nothing perturbs it.
  it 'resolves a percentage pseudo correctly when the contents element declares nothing' do
    body = <<~HTML
      <style>
        #box { width: 100px }
        #c { display: contents }
        #c::before { content: "x"; width: 50%; display: block }
      </style>
      <div id="box"><div id="c">c</div></div>
    HTML
    session = simulated_session(page(body))
    session.visit '/'
    expect(session.evaluate_script(%(getComputedStyle(document.getElementById('c'), '::before').width))).to eq('50px')
  end
end
