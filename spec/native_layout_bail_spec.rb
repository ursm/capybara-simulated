# frozen_string_literal: true
# Native layout — bail coverage. The native engine is only correct if the shadow harness DECLINES to JS
# (`ok:false`) for every input it cannot reproduce; a silently-native wrong answer is the dangerous class.
# Each case is an A/B: the feature-carrying input must bail, and a sibling WITHOUT the feature must stay
# native (`ok:true`) — so the bail is proven specific to the feature, not an unrelated decline. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'

RSpec.describe 'native layout bail coverage', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    # The charset is declared: served without one, a fixture's UTF-8 bytes decode as windows-1252 and the
    # example tests mojibake instead of what it reads as (this file's `\u65E5\u672C\u8A9E` fixture was really
    # testing an em dash, and passed for the wrong reason).
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  # Whether the shadow harness laid the page out natively (true) or declined to JS (false).
  def native?(body)
    shadow(body)['ok']
  end

  # …and laid it out to the SAME boxes. `ok` alone is what a DECLINE is asserted with; a shape that flips the
  # other way — one this engine has just learned — has to say its geometry agrees, or the example passes on a
  # native pass that is natively wrong.
  def parity?(body)
    r = shadow(body)
    r['ok'] && r['mismatches'].zero?
  end

  def shadow(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  it 'lays out a horizontal auto margin (centring) and a fixed margin alike' do
    # §10.3.3 centring is native's own now (`block_child_x`); it used to be the walk's most common decline, and
    # a page centring its shell with `margin: 0 auto` laid out nothing natively at all.
    expect(native?('<div style="width:100px;margin:0 auto">x</div>')).to be true
    expect(native?('<div style="width:100px;margin:0 20px">x</div>')).to be true
  end

  it 'lays out an rtl block natively (r1: its block children start at the inline-start = right edge)' do
    # A text block is direction-agnostic in the box the shadow compares (rtl only moves glyphs within it).
    expect(native?('<div dir="rtl">hello world</div>')).to be true
    expect(native?('<div dir="ltr">hello world</div>')).to be true
    # An rtl block that ESTABLISHES the float context routes its TEXT children around the float natively — a
    # narrower one sits at the inline-start = right, mirroring the no-float placement.
    expect(parity?('<div dir="rtl" style="display:flow-root;width:300px"><div style="float:right;width:50px;height:20px"></div><div style="width:100px;height:20px">x</div></div>')).to be true
    # A float whose context is a HIGHER ancestor (this div starts none) is threaded up to it now, and the
    # plain sibling beside it keeps its full width at the inline-start = right edge — Chrome puts it at 200
    # whichever side the float takes.
    expect(parity?('<div dir="rtl" style="width:300px"><div style="float:left;width:50px;height:20px"></div><div style="width:100px;height:20px"></div></div>')).to be true
    # A sibling child that ESTABLISHES its own BFC (flow-root/overflow) keeps its whole border box clear of the
    # float (the media-object shift): native places it in the band the float leaves, narrowed to it, both ways
    # round. (The plain-block sibling above, whose box may overlap the float, also stays native.)
    expect(parity?('<div dir="rtl" style="display:flow-root;width:300px"><div style="float:right;width:50px;height:20px"></div><div style="display:flow-root;width:120px;height:20px">x</div></div>')).to be true
    expect(parity?('<div dir="ltr" style="display:flow-root;width:300px"><div style="float:left;width:50px;height:20px"></div><div style="display:flow-root;width:120px;height:20px">x</div></div>')).to be true
  end

  it 'lays out an inline vertical-align natively (its runs ride the shift, growing the line)' do
    # A baseline shift (sub / super / length / %) offsets the element's runs; native threads the shift into the
    # run stream. (A sub/sup GLUED to a word with no space is a mixed-font word, a separate pre-existing decline.)
    expect(native?('<div>text <sup>x</sup> more text here</div>')).to be true
    expect(native?('<div>text <span style="vertical-align:sub">y</span> more text here</div>')).to be true
    expect(native?('<div>text <span>x</span> more text here</div>')).to be true
    # …and middle / text-top / text-bottom, which place the element against the parent's font, ride it too: the
    # shift is the distance that moves the box's own baseline there (declined until 2026-09-24).
    expect(native?('<div>text <span style="vertical-align:middle">m</span> more</div>')).to be true
  end

  # A HYPHEN or dash is a break opportunity native takes itself now (parity in the text spec); a SOFT one is
  # not — where its opportunity is taken the flow draws a hyphen the text never held, changing both the line's
  # width and the painter's runs.
  it 'declines a soft hyphen, keeps a hard one' do
    expect(parity?('<div style="width:90px">well-known example text</div>')).to be true
    expect(parity?('<div style="width:90px">well known example text</div>')).to be true
    expect(native?(%(<div style="width:90px">well\u00ADknown example text</div>))).to be false
  end

  it 'lays out Latin in-word breaking natively, hyphens included' do
    # overflow-wrap / word-break break a Latin word between characters natively (parity in the text spec)…
    expect(parity?('<div style="width:50px;overflow-wrap:break-word">supercalifragilistic</div>')).to be true
    # …and a hyphenated one breaks at its hyphens first, under either mode.
    expect(parity?('<div style="width:50px;overflow-wrap:break-word">super-cali-fragilistic</div>')).to be true
    expect(parity?('<div style="width:50px;word-break:break-all">super-cali-fragilistic</div>')).to be true
  end
end
