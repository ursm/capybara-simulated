# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The native author cascade (csim_native cascade.rs) answers an element's winning declaration of every property its
# STATIC rules declare in one pass, and hands the rest back for the JS cascade to match per read. What an element
# computes must not depend on which half picked the winner: every shape here — importance, layers (whose order flips
# under `!important`), specificity and source ties, each terminal-key bucket, combinators the ancestor bloom filter
# pre-rejects, a dynamic and a `:has()` rule on the same property as a static one, the inline origin — is read with
# the native cascade on and again with it off, and must read the same.
RSpec.describe 'native cascade answer' do
  CASCADE_ANSWER_PAGE = <<~HTML
    <!DOCTYPE html>
    <style>
      @layer base, theme;
      @layer theme { .l { width: 11px } .li { width: 12px !important } }
      @layer base  { .l { width: 21px; height: 5px } .li { width: 22px !important } }
      .l { height: 7px }
      #a { margin-left: 1px } .c1 { margin-left: 2px } div { margin-left: 3px }
      .c1.c2 { padding-top: 4px } .c2.c1 { padding-top: 5px }
      .imp { padding-left: 1px !important } #b.imp { padding-left: 9px }
      [data-k] { border-top: 3px solid } [data-k="x"] { border-top-width: 4px }
      :root { font-size: 17px } * { outline-width: 2px }
      #outer .deep { color: rgb(1, 2, 3) } .nomatch .deep { color: rgb(9, 9, 9) }
      section > .kid { margin-top: 6px } h2 + .sib { margin-top: 7px } h2 ~ .sib2 { margin-top: 8px }
      :is(.wrap) .inner { margin-bottom: 9px } :where(#outer) .inner { margin-bottom: 1px }
      .hov { width: 30px } .hov:hover { width: 31px }
      .has { width: 40px } .has:has(> i) { width: 41px }
      .inl { width: 50px } .inl2 { width: 60px !important }
      svg rect[viewBox] { margin-left: 6px }
    </style>
    <div id="outer"><div class="wrap"><p class="deep inner" id="d">d</p></div></div>
    <div class="l" id="l">l</div><div class="li" id="li">li</div>
    <div id="a" class="c1 c2">a</div>
    <div id="b" class="imp">b</div>
    <div data-k="x" id="k">k</div>
    <section><span class="kid" id="kid">kid</span><h2>h</h2><span class="sib sib2" id="sib">s</span></section>
    <div class="hov" id="hov">h</div>
    <div class="has" id="has"><i></i></div>
    <div class="inl" id="inl" style="width: 55px">i</div><div class="inl2" id="inl2" style="width: 65px">i</div>
    <svg><rect id="r" viewBox="0 0 1 1"></rect></svg>
  HTML

  CASCADE_ANSWER_PROPS = %w[width height margin-left margin-top margin-bottom padding-top padding-left border-top-width outline-width color font-size].freeze

  def read_all(session)
    session.evaluate_script(<<~JS)
      (() => {
        const out = {};
        for (const el of document.querySelectorAll('[id]')) {
          const cs = getComputedStyle(el);
          out[el.id] = #{CASCADE_ANSWER_PROPS.to_json}.map((p) => cs.getPropertyValue(p));
        }
        return JSON.stringify(out);
      })()
    JS
  end

  # A tag bucket is keyed on the LOWERCASED name, as the JS index keys it — an SVG element keeps its camelCase
  # `localName`, and asking for `foreignObject` found no bucket, so none of its rules applied. Chrome-measured.
  it 'finds the tag bucket of a camelCase element' do
    html = <<~HTML
      <!DOCTYPE html>
      <style>foreignObject { margin-left: 7px } svg > linearGradient { margin-top: 4px } clipPath:hover, clipPath { padding-left: 2px }</style>
      <svg id="s"></svg>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        for (const [n, id] of [['foreignObject', 'f'], ['linearGradient', 'g'], ['clipPath', 'c']]) {
          const e = document.createElementNS('http://www.w3.org/2000/svg', n);
          e.id = id;
          document.getElementById('s').appendChild(e);
        }
        const g = (id, p) => getComputedStyle(document.getElementById(id))[p];
        return [g('f', 'marginLeft'), g('g', 'marginTop'), g('c', 'paddingLeft')];
      })()
    JS
    expect(got).to eq(%w[7px 4px 2px])
  end

  # The answer holds the element's inline declarations too, kept under its context — which any write to its own
  # attributes moves, the style attribute and a CSSOM `style` write included.
  it 'sees an inline style written after the answer was kept' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [CASCADE_ANSWER_PAGE]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const el = document.getElementById('inl'), out = [];
        const w = () => out.push(getComputedStyle(el).width);
        w();
        el.style.width = '57px'; w();
        el.setAttribute('style', 'width: 58px !important'); w();
        el.removeAttribute('style'); w();
        return out;
      })()
    JS
    expect(got).to eq(%w[55px 57px 58px 50px])
  end
end
