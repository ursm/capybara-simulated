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
  PAGE = <<~HTML
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

  PROPS = %w[width height margin-left margin-top margin-bottom padding-top padding-left border-top-width outline-width color font-size].freeze

  def read_all(session)
    session.evaluate_script(<<~JS)
      (() => {
        const out = {};
        for (const el of document.querySelectorAll('[id]')) {
          const cs = getComputedStyle(el);
          out[el.id] = #{PROPS.to_json}.map((p) => cs.getPropertyValue(p));
        }
        return JSON.stringify(out);
      })()
    JS
  end

  it 'reads what the JS cascade reads' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [PAGE]] })
    s.visit '/'
    s.evaluate_script('__csimCascadeTimingStats(true)')
    native = read_all(s)
    expect(s.evaluate_script('__csimCascadeTimingStats().cascNatAnswers')).to be > 10
    # Off: a rule-set change re-resolves the authority, and the new empty sheet moves nothing.
    s.execute_script(<<~JS)
      globalThis.__csimNativeCascadeAuthoritative = false;
      document.head.appendChild(document.createElement('style'));
    JS
    s.evaluate_script('__csimCascadeTimingStats(true)')
    js = read_all(s)
    expect(s.evaluate_script('__csimCascadeTimingStats().cascNatAnswers')).to eq(0)
    expect(JSON.parse(native)).to eq(JSON.parse(js))
    # …and the values the shapes exist for, so both halves agreeing on a wrong answer shows too.
    got = JSON.parse(native).transform_values {|v| PROPS.zip(v).to_h }
    expect(got['l'].values_at('width', 'height')).to eq(%w[11px 7px])
    expect(got['li']['width']).to eq('22px')
    expect(got['a'].values_at('margin-left', 'padding-top')).to eq(%w[1px 5px])
    expect(got['b']['padding-left']).to eq('1px')
    expect(got['k']['border-top-width']).to eq('4px')
    expect(got['d'].values_at('color', 'margin-bottom', 'font-size')).to eq(['rgb(1, 2, 3)', '9px', '17px'])
    expect(got['kid']['margin-top']).to eq('6px')
    expect(got['sib']['margin-top']).to eq('8px')
    expect(got['hov']['width']).to eq('30px')
    expect(got['has']['width']).to eq('41px')
    expect(got['inl']['width']).to eq('55px')
    expect(got['inl2']['width']).to eq('60px')
    expect(got['r']['margin-left']).to eq('6px')
  end
end
