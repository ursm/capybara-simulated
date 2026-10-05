# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a range contains — its common ancestor, the partially contained children of that, the contained ones between —
# is the engine's (ranges.rs `rangeContents`); cloning, extracting and deleting it act on that. Each expectation below
# is Chrome's.
RSpec.describe 'range contents' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=r><p id=a>abc<b>def</b>ghi</p><p id=c>jkl<i>mno</i></p>pqr</div>']] }) }

  before { session.visit '/' }

  it 'extracts across partially contained children, and collapses after the first' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r'), g = document.createRange();
        g.setStart(r.querySelector('b').firstChild, 1);
        g.setEnd(r.querySelector('i').firstChild, 2);
        const f = g.extractContents(), div = document.createElement('div');
        div.appendChild(f);
        return [div.innerHTML, r.innerHTML, g.startContainer === r && g.startOffset];
      })()
    JS
    expect(got).to eq(['<p id="a"><b>ef</b>ghi</p><p id="c">jkl<i>mn</i></p>', '<p id="a">abc<b>d</b></p><p id="c"><i>o</i></p>pqr', 1])
  end

  # (…the check comes before any change: the comment the range starts in is left whole)
  it 'refuses a doctype before it changes anything' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const d = new DOMParser().parseFromString('<!--abc--><!DOCTYPE html><html><body>x</body></html>', 'text/html');
        const g = d.createRange();
        g.setStart(d.firstChild, 1);
        g.setEnd(d, 2);
        let refused = null;
        try { g.extractContents(); } catch (e) { refused = e.name; }
        return [refused, d.firstChild.data];
      })()
    JS
    expect(got).to eq(['HierarchyRequestError', 'abc'])
  end
end
