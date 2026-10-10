# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "ask for a reset" (validity.rs `ask_for_reset`): an insertion into a select runs the selectedness setting
# algorithm with a just-inserted selected option winning over the incumbent — the last of the select's LIST OF OPTIONS
# an inserted node holds. One in a datalist or a nested optgroup is in no list, and one under a wrapper element is.
# Each expectation is Chrome's and Firefox's.
RSpec.describe 'a select asked for a reset' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  it 'lets the last selected option of its list an insertion holds win' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const mk = (html) => { const s = document.createElement('select'); s.innerHTML = html; document.body.appendChild(s); return s; };
        const el = (tag, html) => { const e = document.createElement(tag); e.innerHTML = html; return e; };
        const wrapped = mk('<option selected>A</option>');
        wrapped.prepend(el('div', '<option selected>B</option>'));
        const listed = mk('<option selected>Z</option>');
        listed.prepend(el('optgroup', '<option selected>A</option><datalist><option selected>X</option></datalist>'));
        const nested = mk('<option selected>Z</option>');
        const g = el('optgroup', '<option selected>A</option>');
        g.appendChild(el('optgroup', '')).appendChild(el('option', 'N')).setAttribute('selected', '');
        nested.prepend(g);
        return [wrapped, listed, nested].map((s) => s.value);
      })()
    JS
    expect(got).to eq(%w[B A A])
  end
end
