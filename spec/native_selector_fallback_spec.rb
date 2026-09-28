# frozen_string_literal: true

# The native selector engine must NEVER silently answer a selector whose truth depends on
# live element state it can't see (`:valid`, `:lang()`, `:target`, `:defined`, a pseudo-element,
# …) — a structural-only match would return a wrong SUBSET. (The states the arena DOES carry —
# `:checked`, `:focus`, `:hover`, `:disabled`, `:required`, … — are answered; element_state_native_spec.) Instead it
# flags such a selector at parse time and reports it as a fallback so the caller runs the JS
# css-select engine. This spec pins that contract:
#
#   * queryIds returns an ARRAY (and the right id set) for selectors it can answer natively;
#   * `undefined` for a live-state selector (defer to css-select) — even when real elements
#     match, so we prove native declines rather than returning [];
#   * `null` for an invalid selector (a SyntaxError).

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# Asks the production arena — the one every node joins at construction — so what native answers is what it answers
# for the cascade.
RSpec.describe 'native selector engine: JS fallback for live-state selectors' do
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

  # Classify one selector: 'FALLBACK' / 'INVALID' / 'MATCHED-parity:N' / 'MATCHED-MISMATCH …'.
  # For a natively-matched selector it also checks the id set equals css-select's, so "native
  # handled it" always means "native handled it correctly".
  CLASSIFY_JS = <<~JS
    (function (sel) {
      const r = __dom.queryIds(document._nid, sel, false);
      if (r === undefined) return 'FALLBACK';
      if (r === null) return 'INVALID';
      const css = Array.from(document.querySelectorAll(sel)).map(e => e._nid);
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
    # Guard the premise: css-select DOES see the empty required field as invalid, so a structural-only
    # native answer would be a wrong subset ([]). Native must decline, not guess.
    expect(session.evaluate_script("document.querySelectorAll('input:invalid').length")).to eq(1)

    [
      ':invalid',
      '.tb:invalid',
      ':not(:invalid)',
      ':is(a, :invalid)',
      ':defined',
      ':target',
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
        const nat = (__dom.queryIds(feed._nid, sel, false) || []).slice().sort((a, b) => a - b);
        const css = Array.from(feed.querySelectorAll(sel)).map(e => e._nid).sort((a, b) => a - b);
        return JSON.stringify(nat) === JSON.stringify(css) ? ('OK:' + nat.length) : ('MISMATCH nat=' + JSON.stringify(nat) + ' css=' + JSON.stringify(css));
      })();
    JS
    # `:scope > .card` selects the ONE direct-child article.card of .feed — proving `:scope` bound to
    # .feed. A root-bound `:scope` (the bug) would match <html> and return [] (OK:0 would never hold).
    expect(result).to eq('OK:1')
  end
end
