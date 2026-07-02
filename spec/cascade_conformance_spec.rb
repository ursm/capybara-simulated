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

    # An inline `!important` outranks a stylesheet `!important` (same author
    # origin + importance → inline's higher specificity wins). This is the
    # contract Capybara's `attach_file ..., make_visible: true` relies on to
    # un-hide a `display: none !important` file input.
    { name: 'inline !important beats rule !important',
      css:  '.c { display: none !important }',
      body: '<div class="c" id="t" style="display: block !important">x</div>',
      expect: { 't' => true } },

    # The `hidden` attribute is the UA rule `[hidden] { display: none }` — the
    # lowest-priority display:none, so any author `display` overrides it
    # (Chromium-confirmed: `<div hidden style="display:block">` is visible).
    { name: '[hidden] attribute hides',
      css:  '',
      body: '<div id="t" hidden>x</div>',
      expect: { 't' => false } },

    { name: 'inline display overrides [hidden]',
      css:  '',
      body: '<div id="t" hidden style="display: block">x</div>',
      expect: { 't' => true } },

    { name: 'stylesheet display overrides [hidden]',
      css:  '#t { display: block }',
      body: '<div id="t" hidden>x</div>',
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
      expect: { 't' => false } },

    # css-select matching edge cases (stress the matcher swap)
    { name: 'escaped class selector (Tailwind-style)',
      css:  '.lg\\:flex { display: none }',
      body: '<div class="lg:flex" id="t">x</div>',
      expect: { 't' => false } },

    { name: 'attribute value operator',
      css:  '[data-state="open"] { display: none }',
      body: '<div data-state="open" id="t">x</div><div data-state="closed" id="t2">y</div>',
      expect: { 't' => false, 't2' => true } },

    { name: ':has() relational',
      css:  '.card:has(.badge) { display: none }',
      body: '<div class="card" id="t"><span class="badge">b</span></div>' \
            '<div class="card" id="t2"><span>plain</span></div>',
      expect: { 't' => false, 't2' => true } },

    { name: ':nth-child positional',
      css:  'li:nth-child(2) { display: none }',
      body: '<ul><li id="t1">1</li><li id="t2">2</li><li id="t3">3</li></ul>',
      expect: { 't1' => true, 't2' => false, 't3' => true } },

    { name: ':not(compound) with tag',
      css:  'div:not(.keep) { display: none }',
      body: '<div id="t">x</div><div class="keep" id="t2">y</div>',
      expect: { 't' => false, 't2' => true } },

    # :nth-child carries a B-component (0,1,1) — it must BEAT a bare tag (0,0,1)
    # when both set display. (Regression guard: undercounting :nth-child to
    # (0,0,1) would tie and let source order pick the wrong winner.)
    { name: ':nth-child specificity beats tag',
      css:  'li:nth-child(2) { display: none } li { display: block }',
      body: '<ul><li id="t1">1</li><li id="t2">2</li><li id="t3">3</li></ul>',
      expect: { 't1' => true, 't2' => false, 't3' => true } },

    # :target (CSS-only reveal via the URL fragment). css-select lacks :target
    # natively; ported into userPseudos.
    { name: ':target reveal',
      css:  '.panel { display: none } .panel:target { display: block }',
      body: '<div class="panel" id="p1">a</div><div class="panel" id="p2">b</div>',
      hash: '#p1',
      expect: { 'p1' => true, 'p2' => false } },

    # @layer cascade (all Chromium-cross-checked):
    { name: '@layer rule applies (layered alone)',
      css:  '@layer a { .x { display: none } }',
      body: '<div class="x" id="t">x</div>',
      expect: { 't' => false } },

    { name: '@layer: unlayered beats layered (normal)',
      css:  '@layer a { .y { display: none } } .y { display: block }',
      body: '<div class="y" id="t">y</div>',
      expect: { 't' => true } },

    { name: '@layer: later-declared layer wins (normal)',
      css:  '@layer o1, o2; @layer o1 { .z { display: none } } @layer o2 { .z { display: block } }',
      body: '<div class="z" id="t">z</div>',
      expect: { 't' => true } },

    { name: '@layer: !important inverts — earlier layer wins',
      css:  '@layer i1, i2; @layer i1 { .w { display: none !important } } @layer i2 { .w { display: block !important } }',
      body: '<div class="w" id="t">w</div>',
      expect: { 't' => false } },

    { name: '@layer: parent direct content beats its sublayer',
      css:  '@layer outer { .n { display: none } @layer inner { .n { display: block } } }',
      body: '<div class="n" id="t">n</div>',
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
      session.visit("/#{idx}#{c[:hash]}")
      c[:expect].each do |id, want|
        got = session.find("##{id}", visible: :all).visible?
        expect(got).to eq(want), "##{id}: expected visible?=#{want}, got #{got} (#{c[:name]})"
      end
    end
  end
end

# A style change made through the CSSOM / DOM at RUNTIME must feed the cascade, so
# Capybara's visibility reflects it after the change settles — the paths real apps
# use for dynamic styling (a theme switcher mutating a live `<style>`, a Lit-style
# `document.adoptedStyleSheets` assignment, appending a fresh `<style>`).
RSpec.describe 'dynamic CSSOM visibility propagation' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        html = '<!doctype html><html><head><style id="s"></style></head>' \
               '<body><p class="foo" id="t">hi</p></body></html>'
        [200, {'content-type' => 'text/html'}, [html]]
      }
    }
  }

  let(:session) { Capybara::Session.new(:simulated, app) }

  def visible_after(session, script)
    session.visit('/')
    session.execute_script(script)
    session.find('#t', visible: :all).visible?
  end

  it 'applies a fresh <style> appended at runtime' do
    expect(visible_after(session, "const e = document.createElement('style'); e.textContent = '.foo { display: none }'; document.head.appendChild(e)")).to be false
  end

  it 'applies textContent set on an existing connected <style>' do
    expect(visible_after(session, "document.getElementById('s').textContent = '.foo { display: none }'")).to be false
  end

  it 'applies styleElement.sheet.insertRule (CSS-in-JS speedy path)' do
    expect(visible_after(session, "document.getElementById('s').sheet.insertRule('.foo { display: none }', 0)")).to be false
  end

  it 'discards CSSOM insertRule edits when the <style> text is replaced' do
    session.visit('/')
    session.execute_script("document.getElementById('s').sheet.insertRule('.foo { display: none }', 0)")
    expect(session.find('#t', visible: :all).visible?).to be false
    # Replacing the element text rebuilds the sheet (browser behaviour), dropping the
    # inserted rule → the element is visible again.
    session.execute_script("document.getElementById('s').textContent = '.foo { color: red }'")
    expect(session.find('#t').visible?).to be true
  end

  it 'applies document.adoptedStyleSheets' do
    expect(visible_after(session, "const c = new CSSStyleSheet(); c.replaceSync('.foo { display: none }'); document.adoptedStyleSheets = [c]")).to be false
  end

  it 're-shows when the injected rule is later removed' do
    session.visit('/')
    session.execute_script("document.getElementById('s').textContent = '.foo { display: none }'")
    expect(session.find('#t', visible: :all).visible?).to be false
    session.execute_script("document.getElementById('s').textContent = ''")
    expect(session.find('#t').visible?).to be true
  end

  # A constructed sheet already adopted into a shadow root, then mutated at runtime
  # (Lit component re-theming): the shadow scope must recompute and see the new rules.
  it 'applies a runtime CSSOM mutation to a shadow-root-adopted sheet' do
    session.visit('/')
    session.execute_script(<<~JS)
      const host = document.createElement('div');
      host.id = 'host';
      document.body.appendChild(host);
      const sr = host.attachShadow({mode: 'open'});
      sr.innerHTML = '<p class="foo" id="st">shadow</p>';
      const sheet = new CSSStyleSheet();
      sr.adoptedStyleSheets = [sheet];
      window.__sheet = sheet;
    JS
    session.execute_script("window.__sheet.replaceSync('.foo { display: none }')")
    display = session.evaluate_script("getComputedStyle(document.getElementById('host').shadowRoot.getElementById('st')).display")
    expect(display).to eq('none')
  end
end
