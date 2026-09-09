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

  it 'declines an rtl flow, keeps ltr' do
    expect(native?('<div dir="rtl">hello world</div>')).to be false
    expect(native?('<div dir="ltr">hello world</div>')).to be true
  end

  it 'declines text-indent, keeps a plain block' do
    expect(native?('<div style="width:200px;text-indent:20px">wrap some words here please</div>')).to be false
    expect(native?('<div style="width:200px">wrap some words here please</div>')).to be true
  end

  it 'declines inline vertical-align (sup), keeps a plain inline' do
    expect(native?('<div>text <sup>x</sup> more text here</div>')).to be false
    expect(native?('<div>text <span>x</span> more text here</div>')).to be true
  end

  it 'declines a hyphen/dash break opportunity, keeps unhyphenated text' do
    expect(native?('<div style="width:90px">well-known example text</div>')).to be false
    expect(native?('<div style="width:90px">well known example text</div>')).to be true
  end

  it 'declines overflow-wrap in-word breaking, keeps normal wrapping' do
    expect(native?('<div style="width:50px;overflow-wrap:break-word">supercalifragilistic</div>')).to be false
    expect(native?('<div style="width:200px">normal wrapping words here</div>')).to be true
  end
end
