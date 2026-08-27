require 'spec_helper'
require_relative 'support/session_teardown'

# `direction` has one source of truth: it INHERITS, it honours the `dir` attribute, and a CSS
# declaration beats the attribute. All three are the property's definition, and the driver used to
# answer them from two different places — `getComputedStyle(el).direction` walked the DOM's `dir`
# attributes only (so a CSS `direction: rtl` never reached a descendant), while every logical
# property read went through the flow resolution that gets it right. Two answers, one question.
RSpec.describe 'direction' do
  def page_with(body)
    session = simulated_session(->(_env) {
      # The charset is load-bearing here, not decoration: `dir=auto` resolves from the first STRONG
      # character, so a page whose Hebrew arrives as mojibake has no strong RTL character in it and
      # resolves `ltr` — a green-looking test that proves nothing.
      [200, {'content-type' => 'text/html; charset=utf-8'},
       [%(<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>#{body}</body></html>)]]
    })
    session.visit '/'
    session
  end

  def direction_of(session, id)
    session.evaluate_script("getComputedStyle(document.getElementById('#{id}')).direction")
  end

  it 'inherits a CSS declaration to a child' do
    s = page_with('<div style="direction: rtl"><span id=x>y</span></div>')
    expect(direction_of(s, 'x')).to eq('rtl')
  end

  it 'inherits a CSS declaration to a grandchild' do
    s = page_with('<div style="direction: rtl"><div><span id=x>y</span></div></div>')
    expect(direction_of(s, 'x')).to eq('rtl')
  end

  it 'inherits the dir attribute' do
    s = page_with('<div dir="rtl"><div><span id=x>y</span></div></div>')
    expect(direction_of(s, 'x')).to eq('rtl')
  end

  it 'lets a CSS declaration beat the dir attribute on the same element' do
    s = page_with('<div dir="rtl" style="direction: ltr"><span id=x>y</span></div>')
    expect(direction_of(s, 'x')).to eq('ltr')
  end

  it 'lets a nearer declaration win over a further one' do
    s = page_with('<div style="direction: rtl"><div style="direction: ltr"><span id=x>y</span></div></div>')
    expect(direction_of(s, 'x')).to eq('ltr')
  end

  # The bug this file exists for is not "direction is wrong" — it is that `direction` and the
  # logical properties DISAGREE about the same element. So every case below asserts both halves
  # together: getting one right while mirroring the other is the failure mode, and it has happened
  # in both directions at different times.
  def flow_of(session, id)
    session.evaluate_script(<<~JS)
      (() => { const s = getComputedStyle(document.getElementById('#{id}'));
        return [s.direction, s.marginRight, s.marginLeft]; })()
    JS
  end

  # `inline-start` is the RIGHT edge in rtl, so a 30px inline-start margin lands on margin-right.
  RTL_FLOW = ['rtl', '30px', '0px'].freeze
  LTR_FLOW = ['ltr', '0px', '30px'].freeze

  M = 'margin-inline-start: 30px'.freeze

  {
    'a CSS declaration on an ancestor'  => %(<div style="direction: rtl"><i id=x style="#{M}">y</i></div>),
    'a dir attribute on an ancestor'    => %(<div dir="rtl"><i id=x style="#{M}">y</i></div>),
    'dir=auto over RTL text'            => %(<div dir="auto" id=x style="#{M}">שלום</div>),
    'a bare <bdi> over RTL text'        => %(<bdi id=x style="#{M}">שלום</bdi>),
    'a child of a <bdi>'                => %(<bdi>שלום<i id=x style="#{M}">y</i></bdi>),
    'direction:inherit over a dir attr' => %(<div dir="rtl"><i id=x dir="ltr" style="direction: inherit; #{M}">y</i></div>),
    'an invalid value, which drops'     => %(<div style="direction: rtl"><i id=x style="direction: sideways; #{M}">y</i></div>),
    'direction:revert over a dir attr'  => %(<div dir="rtl"><i id=x style="direction: revert; #{M}">y</i></div>)
  }.each do |name, markup|
    it "is rtl on both halves for #{name}" do
      expect(flow_of(page_with(markup), 'x')).to eq(RTL_FLOW)
    end
  end

  {
    'dir=auto over LTR text'         => %(<div dir="auto" id=x style="#{M}">hello</div>),
    'a CSS declaration beating dir'  => %(<div dir="rtl" style="direction: ltr"><i id=x style="#{M}">y</i></div>),
    'direction:initial under an rtl' => %(<div style="direction: rtl"><i id=x style="direction: initial; #{M}">y</i></div>)
  }.each do |name, markup|
    it "is ltr on both halves for #{name}" do
      expect(flow_of(page_with(markup), 'x')).to eq(LTR_FLOW)
    end
  end

  # CSS inherits through the FLAT tree, so a shadow-tree element takes its flow from the HOST and
  # slotted content from the SLOT's ancestors — including into a CLOSED root, which an
  # `assignedSlot`-based walk cannot see at all.
  it 'reaches inside a shadow tree from the host' do
    s = page_with('<div id=host style="direction: rtl"></div>')
    s.execute_script(%(document.getElementById('host').attachShadow({mode: 'open'}).innerHTML =
      '<i id=x style="margin-inline-start: 30px">y</i>';))
    expect(s.evaluate_script(<<~JS)).to eq(RTL_FLOW)
      (() => { const s = getComputedStyle(document.getElementById('host').shadowRoot.getElementById('x'));
        return [s.direction, s.marginRight, s.marginLeft]; })()
    JS
  end

  it 'reaches slotted content through a CLOSED root' do
    s = page_with('<div id=host><i id=x style="margin-inline-start: 30px">y</i></div>')
    s.execute_script(%(document.getElementById('host').attachShadow({mode: 'closed'}).innerHTML =
      '<div style="direction: rtl"><slot></slot></div>';))
    expect(flow_of(s, 'x')).to eq(RTL_FLOW)
  end

  it 'agrees with the logical properties it feeds' do
    s = page_with('<div style="direction: rtl"><div id=x style="margin-inline-start: 30px">y</div></div>')
    expect(direction_of(s, 'x')).to eq('rtl')
    # inline-start is the RIGHT edge in rtl, so the physical margin lands on margin-right.
    expect(s.evaluate_script("getComputedStyle(document.getElementById('x')).marginRight")).to eq('30px')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('x')).marginLeft")).to eq('0px')
  end

  # CSS inherits through the FLAT tree, so slotted content takes its direction from the slot's
  # ancestors rather than from the light-DOM parent it is written under. Chrome-verified both ways.
  it 'inherits through the slot, not the light-DOM parent' do
    s = page_with('<div id=host style="direction: rtl"><span id=light>L</span></div>')
    s.execute_script(<<~JS)
      document.getElementById('host').attachShadow({mode: 'open'}).innerHTML =
        '<div style="direction: ltr"><slot></slot></div>';
    JS
    expect(direction_of(s, 'light')).to eq('ltr')
  end

  it 'takes an rtl slot ancestor even under an ltr host' do
    s = page_with('<div id=host><span id=light>L</span></div>')
    s.execute_script(<<~JS)
      document.getElementById('host').attachShadow({mode: 'open'}).innerHTML =
        '<div style="direction: rtl"><slot></slot></div>';
    JS
    expect(direction_of(s, 'light')).to eq('rtl')
  end
end
