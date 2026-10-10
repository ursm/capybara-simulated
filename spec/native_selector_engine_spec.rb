# frozen_string_literal: true

# The native selector engine (selector.rs) answers every selector there is — there is no other engine to hand one to:
# `query` returns the elements a selector matches, and `null` for one it does not parse (a SyntaxError).

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# Asks the production arena — the one every node joins at construction — so what native answers is what it answers
# for querySelector and the cascade alike. Every selector is native: a structural one, element state, a pseudo-element
# (none matches), a shadow-tree one, a namespaced attribute; one it does not parse is null (the caller's SyntaxError).
RSpec.describe 'native selector engine' do
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

  # How many elements `sel` matches natively in the document — or 'INVALID'.
  def count(sel)
    session.evaluate_script(<<~JS)
      (() => {
        const answer = __dom.query(document._nid, #{sel.to_json}, false);
        return answer === null ? 'INVALID' : answer.length;
      })()
    JS
  end

  before do
    session.visit '/'
  end

  it 'answers every kind of selector' do
    expected = {
      '.cb'                        => 3,
      'article.card'               => 1,
      'a[href]'                    => 1,
      '.card .title'               => 1,
      'input:not([type=checkbox])' => 1,
      'article:last-child'         => 1,
      'input:first-of-type'        => 1,
      'h2.title:only-child'        => 1,
      '.feed :nth-child(2)'        => 2,
      '.card:nth-of-type(2)'       => 0,
      'a:link'                     => 1,
      'a:any-link'                 => 1,
      'input:dir(ltr)'             => 4,
      'p::before'                  => 0,
      '[*|href]'                   => 1,
      'a[*|href]'                  => 1,
      ':is(input, [*|href])'       => 5,
      ':host'                      => 0,
      '::slotted(span)'            => 0,
      ':fullscreen'                => 0
    }
    expect(expected.keys.to_h {|sel| [sel, count(sel)] }).to eq(expected)
  end

  it 'reports an invalid selector as null (SyntaxError)' do
    expect(count(':')).to eq('INVALID')
    expect(count('@nope')).to eq('INVALID')
    expect(count('p:no-such-class')).to eq('INVALID')
  end

  # `:scope` is a tree-structural crate built-in — but it must resolve to the QUERY root, not the arena root. An
  # element-scoped query is the only place this diverges (a document-scoped query has query-root == arena-root).
  it 'binds :scope to the query root in an element-scoped query, not the arena root' do
    # `:scope > .card` selects the ONE direct-child article.card of .feed; a root-bound `:scope` would match nothing.
    expect(session.evaluate_script("document.querySelector('.feed').querySelectorAll(':scope > .card').length")).to eq(1)
  end
end
