# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The rule index files each rule under its subject's key — class / id / tag / attribute name /
# `:root` / universal — and, within a bucket, by the first ancestor identifier the rule requires;
# the candidate walk only visits what the element's own identifiers and ancestor chain select.
# Each case here pins a bucket kind that used to fall into the universal bucket (visited for
# every element) and must keep applying exactly where it applies.
RSpec.describe 'rule index' do
  def session_for(css, body)
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><html><head><style>#{css}</style></head><body>#{body}</body></html>"]]
    }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  it 'applies :root rules to the document element and through var() to descendants' do
    s = session_for(':root { --w: 123px; padding-left: 7px } #t { width: var(--w) }', '<div id="t">x</div>')
    got = s.evaluate_script("[getComputedStyle(document.documentElement).paddingLeft, document.getElementById('t').getBoundingClientRect().width]")
    expect(got).to eq(['7px', 123])
  end

  it 'applies attribute-only subjects to the elements that carry the attribute' do
    # Four attribute-bucket shapes: a plain `[type=…]`, a `data-*` presence selector written in
    # UPPERCASE in the sheet (the bucket key is lowercased), a substring match on `class` (an attr
    # bucket under `class`, not the class bucket), and a prefix match on `id`.
    css = '[type=checkbox] { width: 40px; height: 40px } [DATA-wide] { width: 300px } ' \
          '[class^="btn-"] { width: 111px } [id^="pre-"] { height: 44px } div { height: 20px }'
    body = '<input type="checkbox" id="c"><div data-wide id="w">w</div><div class="btn-primary" id="b">b</div>' \
           '<div id="pre-fix">p</div><div id="plain">p</div>'
    s = session_for(css, body)
    got = s.evaluate_script("['c','w','b','pre-fix','plain'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.width, r.height]; })")
    expect(got[0]).to eq([40, 40])
    expect(got[1][0]).to eq(300)
    expect(got[2][0]).to eq(111)
    expect(got[3][1]).to eq(44)
    expect(got[4][1]).to eq(20)
  end

  it 'leaves a namespaced attribute subject on the universal walk' do
    # `[*|data-q]` is matched by LOCAL name across namespaces — no attribute-name bucket can stand
    # for it, so it must keep being considered for every element. (A prefixed `[xlink|href]` under
    # `@namespace` is a pre-existing matcher gap, unrelated to the index.)
    css = '[*|data-q] { width: 66px } div { width: 20px }'
    s = session_for(css, '<div id="d" data-q="1">x</div>')
    expect(s.evaluate_script("document.getElementById('d').getBoundingClientRect().width")).to eq(66)
  end

  it 'matches a case-preserved attribute name on an SVG element' do
    css = '[viewBox] { width: 77px; height: 77px; display: block }'
    s = session_for(css, '<svg id="v" viewBox="0 0 10 10"></svg>')
    expect(s.evaluate_script("document.getElementById('v').getBoundingClientRect().width")).to eq(77)
  end

  it 'keeps pseudo-element subjects off the element cascade' do
    css = '#t::before { width: 500px; display: block } #t:after { height: 500px } #t { width: 20px; height: 20px }'
    s = session_for(css, '<div id="t">x</div>')
    got = s.evaluate_script("(() => { const r = document.getElementById('t').getBoundingClientRect(); return [r.width, r.height]; })()")
    expect(got).to eq([20, 20])
  end

  it 'applies ancestor-keyed rules where the ancestor is present and skips them where it is not' do
    # `#in` has both ancestors; `#out` has `.row` (the group is visited and the rule rejected by the
    # full ancestor filter); `#far` has neither (the whole `.panel` group is skipped).
    css = '.panel .row>* { height: 50px } .other { height: 10px }'
    body = '<div class="panel"><div class="row"><div id="in">a</div></div></div>' \
           '<div class="row"><div id="out" class="other">b</div></div><div id="far" class="other">c</div>'
    s = session_for(css, body)
    got = s.evaluate_script("['in','out','far'].map(id => document.getElementById(id).getBoundingClientRect().height)")
    expect(got).to eq([50, 10, 10])
  end

  # A dynamic rule in a SKIPPED ancestor group is not considered at all — no taint — so the read
  # is cached. That is sound only because the ancestor gaining the identifier moves the element's
  # context epoch (the memo key): the rule must then be visited and the focus flip applied.
  it 'keeps a skipped dynamic rule live once its ancestor identifier arrives' do
    css = '.c { height: 20px } .on .c:focus { height: 99px }'
    s = session_for(css, '<div id="host"><div class="c" id="c" tabindex="0">x</div></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = document.getElementById('c');
        const before = c.getBoundingClientRect().height;      // group skipped: no `.on` ancestor
        document.getElementById('host').className = 'on';
        c.focus();
        return [before, c.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([20, 99])
  end
end
