require_relative 'spec_helper'
require 'capybara/dsl'

# CSS-cascade visibility conformance battery.
#
# capybara-simulated resolves `display` / `visibility` through a real cascade
# (cascade.js). This spec pins that resolution against real-browser behaviour
# for the cases the cascade's parsing / specificity / matching must get right —
# specificity ordering (incl. `:is`/`:where`/`:not`), `!important`, inline-vs-
# rule, `@media`, CSS nesting, `visibility` inheritance, and combinators.
#
# Expected values are spec-correct and cross-checked against Chromium
# (`el.checkVisibility({visibilityProperty:true})`). This is the safety net for
# the dual-CSS-engine consolidation (swapping the hand-rolled selector matcher /
# specificity for css-select + css-tree): the matcher/specificity source may
# change, but these verdicts must not.
RSpec.describe 'CSS cascade visibility conformance' do
  # Each case: a <style> block + body; `expect` maps element id => visible?
  CASES = [
    { name: 'id beats class (specificity)',
      css:  '#x { display: block } .c { display: none }',
      body: '<div id="x" class="c">x</div>',
      expect: { 'x' => true } },

    { name: 'class beats tag (specificity)',
      css:  'div { display: none } .c { display: block }',
      body: '<div class="c" id="t">x</div>',
      expect: { 't' => true } },

    { name: 'attr vs class equal specificity → source order',
      css:  '[data-x] { display: none } .c { display: block }',
      body: '<div data-x class="c" id="t">x</div>',
      expect: { 't' => true } },

    { name: ':is() takes max inner specificity',
      css:  ':is(#a, .b) { display: none } .c.d { display: block }',
      body: '<div id="a" class="c d">x</div>',
      expect: { 'a' => false } },           # :is(#a)=1,0,0 beats .c.d=0,2,0 → none

    { name: ':where() contributes zero specificity',
      css:  ':where(#a) { display: none } div { display: block }',
      body: '<div id="a">x</div>',
      expect: { 'a' => true } },            # :where=0,0,0 loses to div=0,0,1

    { name: ':not() specificity + match',
      css:  ':not(.x) { display: none }',
      body: '<p id="t">x</p>',
      expect: { 't' => false } },           # matches (no .x) → none

    { name: '!important rule beats inline',
      css:  '.c { display: none !important }',
      body: '<div class="c" id="t" style="display: block">x</div>',
      expect: { 't' => false } },

    { name: 'inline beats rule at equal importance',
      css:  '.c { display: none }',
      body: '<div class="c" id="t" style="display: block">x</div>',
      expect: { 't' => true } },

    { name: '@media matching applies',
      css:  '@media (min-width: 1px) { #t { display: none } }',
      body: '<div id="t">x</div>',
      expect: { 't' => false } },

    { name: '@media non-matching ignored',
      css:  '@media (min-width: 99999px) { #t { display: none } }',
      body: '<div id="t">x</div>',
      expect: { 't' => true } },

    { name: 'nesting: bare child',
      css:  '.p { color: red; .c { display: none } }',
      body: '<div class="p"><span class="c" id="t">x</span></div>',
      expect: { 't' => false } },

    { name: 'nesting: &-compound',
      css:  '.p { &.self { display: none } }',
      body: '<div class="p self" id="t">x</div>',
      expect: { 't' => false } },

    { name: 'nesting: combinator child only',
      css:  '.p { > .c { display: none } }',
      body: '<div class="p"><span class="c" id="direct">x</span>' \
            '<div><span class="c" id="grand">y</span></div></div>',
      expect: { 'direct' => false, 'grand' => true } },

    { name: 'visibility inherits',
      css:  '.p { visibility: hidden }',
      body: '<div class="p"><span id="t">x</span></div>',
      expect: { 't' => false } },

    # `visibility` inherits, but a descendant's `visibility: visible` re-shows it
    # under a `visibility: hidden` ancestor (Chromium-confirmed). Resolved by
    # visibilityHidden's nearest-explicit-ancestor walk, separate from the
    # unconditional display-side ancestor walk.
    { name: 'visibility child overrides parent hidden',
      css:  '.p { visibility: hidden } .v { visibility: visible }',
      body: '<div class="p"><span class="v" id="t">x</span></div>',
      expect: { 't' => true } },

    { name: 'descendant combinator',
      css:  '.a .b { display: none }',
      body: '<div class="a"><span class="b" id="t">x</span></div>',
      expect: { 't' => false } },

    { name: 'child combinator does not match grandchild',
      css:  '.a > .b { display: none }',
      body: '<div class="a"><div><span class="b" id="t">x</span></div></div>',
      expect: { 't' => true } },

    { name: 'attribute presence selector',
      css:  '[data-hide] { display: none }',
      body: '<div data-hide id="t">x</div>',
      expect: { 't' => false } }
  ].freeze

  let(:app) {
    cases = CASES
    Rack::Builder.new {
      run lambda {|env|
        idx = Rack::Request.new(env).path_info.delete_prefix('/').to_i
        c   = cases[idx]
        html = "<!doctype html><html><head><style>#{c[:css]}</style></head>" \
               "<body>#{c[:body]}</body></html>"
        [200, {'content-type' => 'text/html'}, [html]]
      }
    }
  }

  let(:session) { Capybara::Session.new(:simulated, app) }

  CASES.each_with_index do |c, idx|
    it "matches real-browser visibility: #{c[:name]}" do
      pending(c[:pending]) if c[:pending]
      session.visit("/#{idx}")
      c[:expect].each do |id, want|
        got = session.find("##{id}", visible: :all).visible?
        expect(got).to eq(want), "##{id}: expected visible?=#{want}, got #{got} (#{c[:name]})"
      end
    end
  end
end
