# frozen_string_literal: true

# The native selector engine must NEVER silently answer a selector whose truth depends on
# live element state it can't see (`:hover`, `:checked`, `:focus`, `:required`, `:lang()`,
# a pseudo-element, …) — a structural-only match would return a wrong SUBSET. Instead it
# flags such a selector at parse time and reports it as a fallback so the caller runs the JS
# css-select engine. This spec pins that contract:
#
#   * queryIds returns an ARRAY (and the right id set) for selectors it can answer natively;
#   * `undefined` for a live-state selector (defer to css-select) — even when real elements
#     match, so we prove native declines rather than returning [];
#   * `null` for an invalid selector (a SyntaxError).
#
# V8 only (needs the native __dom arena + css-select). Run:
#   CSIM_JS_ENGINE=v8 bundle exec rspec spec/native_selector_fallback_spec.rb

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# Hand-drives the isolate arena (resetArena + importNode) then reads DOCUMENT elements, so it needs the
# production cascade to NOT own the arena: with native matching on by default, cascade builds+syncs that
# same arena and swaps each element's `_attrs` to the native attrsView (store flip), which this spec's
# resetArena would then wipe. Run it only under the kill switch (CSIM_NO_NATIVE_CASCADE), where the arena
# is free and `_attrs` stays a plain JS object. The queryIds fallback contract is exercised in production
# by the default matching path (and covered by WPT) regardless.
RSpec.describe 'native selector engine: JS fallback for live-state selectors',
  if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' && ENV['CSIM_NO_NATIVE_CASCADE'] do
  let(:app) {
    html = <<~HTML
      <!doctype html>
      <html><head><title>fallback</title></head><body>
        <div class="feed">
          <a class="link" href="/a">A</a>
          <a class="nolink">B</a>
          <form>
            <input type="checkbox" class="cb" id="c1">
            <input type="checkbox" class="cb" id="c2">
            <input type="checkbox" class="cb" id="c3">
            <input type="text" class="tb" required>
            <button class="btn" type="button">Go</button>
          </form>
          <article class="card"><h2 class="title">T</h2></article>
        </div>
      </body></html>
    HTML
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  }

  let(:session) { simulated_session(app) }

  # Build the native arena from the parsed document, stamping each element with its nativeId so
  # css-select results can be compared by id. Returns nothing; sets globalThis.__abRoot.
  BUILD_JS = <<~JS
    (function () {
      __dom.resetArena();
      function walk(el, parentNid) {
        const attrs = [];
        for (const n of el.getAttributeNames()) attrs.push(n, el.getAttribute(n));
        const hasNonElementChild = el.childNodes.length > el.children.length;
        const ns = el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? '' : (el.namespaceURI || '');
        const nid = __dom.importNode(el.tagName, el.localName, ns, hasNonElementChild, parentNid, attrs);
        el.__nid = nid;
        for (const kid of el.children) walk(kid, nid);
        return nid;
      }
      globalThis.__abRoot = walk(document.documentElement, -1);
    })();
  JS

  # Classify one selector: 'FALLBACK' / 'INVALID' / 'MATCHED-parity:N' / 'MATCHED-MISMATCH …'.
  # For a natively-matched selector it also checks the id set equals css-select's, so "native
  # handled it" always means "native handled it correctly".
  CLASSIFY_JS = <<~JS
    (function (sel) {
      const r = __dom.queryIds(globalThis.__abRoot, sel);
      if (r === undefined) return 'FALLBACK';
      if (r === null) return 'INVALID';
      const css = Array.from(document.querySelectorAll(sel)).map(e => e.__nid);
      const a = r.slice().sort((x, y) => x - y);
      const b = css.slice().sort((x, y) => x - y);
      const same = a.length === b.length && a.every((v, i) => v === b[i]);
      return same ? ('MATCHED-parity:' + a.length) : ('MATCHED-MISMATCH nat=' + a.length + ' css=' + b.length);
    })
  JS

  def classify(sel)
    session.evaluate_script("(#{CLASSIFY_JS})(#{sel.to_json})")
  end

  before do
    session.visit '/'
    session.evaluate_script(BUILD_JS)
    # Two checkboxes are actually checked — live state css-select sees but the arena can't.
    session.evaluate_script("document.getElementById('c1').checked = true; document.getElementById('c2').checked = true;")
  end

  it 'answers structural selectors natively, and correctly' do
    [
      '.cb',
      'article.card',
      'a[href]',
      '.card .title',
      'input:not([type=checkbox])',

      # Tree-structural pseudo-classes are the crate's built-ins, NOT non-TS pseudos, so they
      # must stay native — over-falling-back on these would gut the optimization on the exact
      # selectors apps use most. (`:root` is native too but isn't tested here: it matches the
      # arena's own root element, which descendant-scoped querySelectorAll excludes — a
      # query-scoping concern for the store-migration integration, not fallback.)
      'article:last-child',
      'input:first-of-type',
      'h2.title:only-child',
      '.feed :nth-child(2)',
      '.card:nth-of-type(2)'
    ].each do |sel|
      expect(classify(sel)).to start_with('MATCHED-parity:'), "selector #{sel.inspect} should be native+correct"
    end
  end

  it 'answers :link / :any-link natively (structural, a/area/link with href)' do
    expect(classify('a:link')).to start_with('MATCHED-parity:')
    expect(classify('a:any-link')).to start_with('MATCHED-parity:')
  end

  it 'defers a live-state selector to css-select even when elements really match' do
    # Guard the premise: css-select DOES see the two checked boxes, so a structural-only native
    # answer would be a wrong subset ([]). Native must decline, not guess.
    expect(session.evaluate_script("document.querySelectorAll(':checked').length")).to eq(2)

    [
      ':checked',
      '.cb:checked',
      ':not(:checked)',
      ':is(a, :checked)',
      ':focus',
      'input:required',
      ':hover',
      ':lang(en)',
      'p::before'
    ].each do |sel|
      expect(classify(sel)).to eq('FALLBACK'), "selector #{sel.inspect} must defer to css-select"
    end
  end

  it 'reports an invalid selector as null (SyntaxError), distinct from a fallback' do
    expect(classify(':')).to eq('INVALID')
    expect(classify('@nope')).to eq('INVALID')
  end

  # `:scope` is a tree-structural crate built-in (never routes through the fallback flag), so it's
  # answered natively — but it must resolve to the QUERY root, not the arena root. An element-scoped
  # query is the only place this diverges (a document-scoped query has query-root == arena-root), so
  # it's tested here explicitly.
  it 'binds :scope to the query root in an element-scoped query, not the arena root' do
    result = session.evaluate_script(<<~JS)
      (function () {
        const feed = document.querySelector('.feed');
        const sel = ':scope > .card';
        const nat = (__dom.queryIds(feed.__nid, sel) || []).slice().sort((a, b) => a - b);
        const css = Array.from(feed.querySelectorAll(sel)).map(e => e.__nid).sort((a, b) => a - b);
        return JSON.stringify(nat) === JSON.stringify(css) ? ('OK:' + nat.length) : ('MISMATCH nat=' + JSON.stringify(nat) + ' css=' + JSON.stringify(css));
      })();
    JS
    # `:scope > .card` selects the ONE direct-child article.card of .feed — proving `:scope` bound to
    # .feed. A root-bound `:scope` (the bug) would match <html> and return [] (OK:0 would never hold).
    expect(result).to eq('OK:1')
  end
end
