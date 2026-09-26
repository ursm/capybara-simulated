# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What `elementFromPoint` answers where boxes overlap: the one PAINTED on top, by CSS 2.1 appendix E. Inside a
# stacking context the block backgrounds paint first, then the floats, then the inline-level content, then the
# positioned boxes; a float, an atomic inline and a `z-index: auto` positioned box each paint as ONE unit, their
# positioned descendants excepted. Placement order is not paint order — a float placed before a block still covers
# it. Every answer below is Chrome's, read off this markup with `--headless --dump-dom` (each probe is 50px in and
# 25px down from the shape's top-left corner). A "was" names what the placement-order ranking said, which knew
# no phases and no stacking context but a positioned box's.
RSpec.describe 'paint order' do
  def hit(body)
    html = %(<!DOCTYPE html><html><head><style>body{margin:0} div,span{box-sizing:border-box}</style></head><body>#{body}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s.evaluate_script('(e => e && (e.id || e.tagName))(document.elementFromPoint(50, 25))')
  end

  it 'paints a float over the block backgrounds of its context' do
    expect(hit(<<~HTML)).to eq('float')   # was: block
      <div id="float" style="float:left;width:100px;height:100px"></div><div id="block" style="height:50px"></div>
    HTML
  end

  it 'paints an inline-level box over a float' do
    expect(hit(<<~HTML)).to eq('ib')      # was: float
      <div style="height:100px"><span id="ib" style="display:inline-block;width:80px;height:40px"></span></div>
      <div id="float" style="float:left;width:100px;height:100px;margin-top:-100px"></div>
    HTML
  end

  it 'paints what is inside an atomic inline with it, over a later float' do
    expect(hit(<<~HTML)).to eq('inner')
      <span style="display:inline-block;width:100px;height:100px;vertical-align:top"><div id="inner" style="height:100px"></div></span><div
        id="float" style="float:left;width:100px;height:100px;margin-left:-100px"></div>
    HTML
  end

  it 'paints what is inside a float with it, under a later float' do
    expect(hit(<<~HTML)).to eq('later')
      <div style="float:left;width:100px;height:100px"><div id="inner" style="height:100px"></div></div><div
        id="later" style="float:left;width:100px;height:100px;margin-left:-100px"></div>
    HTML
  end

  it 'lifts a positioned box out of the float it sits in' do
    expect(hit(<<~HTML)).to eq('rel')
      <div style="float:left;width:100px;height:100px"><div id="rel" style="position:relative;height:100px"></div></div><div
        id="later" style="float:left;width:100px;height:100px;margin-left:-100px"></div>
    HTML
  end

  it 'keeps a float over a block whose line runs beside it' do
    expect(hit(<<~HTML)).to eq('float')   # was: block — the line is shortened, so nothing of it is at the point
      <div id="float" style="float:left;width:100px;height:100px"></div><div id="block" style="height:100px"><span>xxxxxxxxxxxx</span></div>
    HTML
  end

  it 'paints a negative z-index child over the background of the context it belongs to' do
    expect(hit(<<~HTML)).to eq('neg')     # was: ctx
      <div id="ctx" style="position:relative;z-index:0;height:120px"><div id="neg" style="position:absolute;z-index:-1;width:100px;height:100px"></div></div>
    HTML
  end

  it 'paints a negative z-index child under a positioned parent that makes no context' do
    expect(hit(<<~HTML)).to eq('parent')
      <div id="parent" style="position:relative;height:120px"><div style="position:absolute;z-index:-1;width:100px;height:100px"></div></div>
    HTML
  end

  it 'paints flex items as inline-blocks, in the order their container placed them' do
    expect(hit(<<~HTML)).to eq('second')
      <div style="display:flex;width:300px"><div id="second" style="order:1;width:100px;height:100px"></div><div
        id="first" style="width:100px;height:100px;margin-right:-100px"></div></div>
    HTML
  end

  it 'makes a stacking context of a static flex item with a z-index' do
    expect(hit(<<~HTML)).to eq('raised')
      <div style="display:flex;width:300px"><div id="raised" style="z-index:1;width:100px;height:100px;margin-right:-100px"></div><div
        style="width:100px;height:100px;position:relative"></div></div>
    HTML
  end

  it 'makes a stacking context of a transform, an opacity and an isolation' do
    %w[transform:scale(1) opacity:0.5 isolation:isolate].each do |effect|
      expect(hit(<<~HTML)).to eq('neg'), effect
        <div id="ctx" style="#{effect};height:120px"><div id="neg" style="position:relative;z-index:-1;width:100px;height:100px"></div></div>
      HTML
    end
  end
end
