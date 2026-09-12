# frozen_string_literal: true
# Native layout — bail coverage. The native engine is only correct if the shadow harness DECLINES to JS
# (`ok:false`) for every input it cannot reproduce; a silently-native wrong answer is the dangerous class.
# Each case is an A/B: the feature-carrying input must bail, and a sibling WITHOUT the feature must stay
# native (`ok:true`) — so the bail is proven specific to the feature, not an unrelated decline. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout bail coverage', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  # Whether the shadow harness laid the page out natively (true) or declined to JS (false).
  def native?(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')['ok']
  end

  it 'declines a horizontal auto margin (centring), keeps a fixed margin' do
    expect(native?('<div style="width:100px;margin:0 auto">x</div>')).to be false
    expect(native?('<div style="width:100px;margin:0 20px">x</div>')).to be true
  end

  it 'lays out an rtl block natively (r1: its block children start at the inline-start = right edge)' do
    # A text block is direction-agnostic in the box the shadow compares (rtl only moves glyphs within it).
    expect(native?('<div dir="rtl">hello world</div>')).to be true
    expect(native?('<div dir="ltr">hello world</div>')).to be true
    # An rtl block that ESTABLISHES the float context routes its TEXT children around the float natively — a
    # narrower one sits at the inline-start = right, mirroring the no-float placement.
    expect(native?('<div dir="rtl" style="display:flow-root;width:300px"><div style="float:right;width:50px;height:20px"></div><div style="width:100px;height:20px">x</div></div>')).to be true
    # A float whose context is a HIGHER ancestor (this div doesn't start one) still declines — for that reason,
    # not the direction; a horizontal auto margin under rtl also declines.
    expect(native?('<div dir="rtl" style="width:300px"><div style="float:left;width:50px;height:20px"></div><div style="width:100px;height:20px"></div></div>')).to be false
    # A sibling child that ESTABLISHES its own BFC (flow-root/overflow) keeps its whole border box clear of the
    # float (the media-object shift): native places it in the band the float leaves, narrowed to it, both ways
    # round. (The plain-block sibling above, whose box may overlap the float, also stays native.)
    expect(native?('<div dir="rtl" style="display:flow-root;width:300px"><div style="float:right;width:50px;height:20px"></div><div style="display:flow-root;width:120px;height:20px">x</div></div>')).to be true
    expect(native?('<div dir="ltr" style="display:flow-root;width:300px"><div style="float:left;width:50px;height:20px"></div><div style="display:flow-root;width:120px;height:20px">x</div></div>')).to be true
  end

  it 'declines text-indent, keeps a plain block' do
    expect(native?('<div style="width:200px;text-indent:20px">wrap some words here please</div>')).to be false
    expect(native?('<div style="width:200px">wrap some words here please</div>')).to be true
  end

  it 'lays out an inline vertical-align SHIFT (sup) natively (its runs ride the shift, growing the line)' do
    # A baseline shift (sub / super / length / %) offsets the element's runs; native threads the shift into the
    # run stream. (A sub/sup GLUED to a word with no space is a mixed-font word, a separate pre-existing decline.)
    expect(native?('<div>text <sup>x</sup> more text here</div>')).to be true
    expect(native?('<div>text <span style="vertical-align:sub">y</span> more text here</div>')).to be true
    expect(native?('<div>text <span>x</span> more text here</div>')).to be true
    # middle / text-top / text-bottom place the element against a box — still declined.
    expect(native?('<div>text <span style="vertical-align:middle">m</span> more</div>')).to be false
  end

  it 'declines a hyphen/dash break opportunity, keeps unhyphenated text' do
    expect(native?('<div style="width:90px">well-known example text</div>')).to be false
    expect(native?('<div style="width:90px">well known example text</div>')).to be true
  end

  it 'lays out Latin in-word breaking natively, declines the hyphen/CJK cases it cannot reproduce' do
    # overflow-wrap / word-break break a Latin word between characters natively (parity in the text spec)…
    expect(native?('<div style="width:50px;overflow-wrap:break-word">supercalifragilistic</div>')).to be true
    # …but a hyphen is still a break opportunity the native breaker does not model, and a wide/CJK character
    # breaks between characters in a way it declines — both bail even under break-word / break-all.
    expect(native?('<div style="width:50px;overflow-wrap:break-word">super-cali-fragilistic</div>')).to be false
    expect(native?('<div style="width:50px;word-break:break-all">日本語のテキストです</div>')).to be false
  end
end
