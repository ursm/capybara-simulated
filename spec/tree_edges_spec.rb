# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A parent's children are written in one place (tree.js), which empties a parent in place: `childNodes` is the same live
# list for the node's whole life ([SameObject]), so one a script holds sees what replacing all the children leaves —
# `textContent`, `innerHTML`, `replaceChildren` and `document.open` alike — where it used to be orphaned with the old
# children in it. Chrome: true for each.
RSpec.describe 'tree edges' do
  it 'keeps childNodes the same live list across replacing all the children' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><div id=d><b>1</b><i>2</i></div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        const kids = d.childNodes;
        const out = [];
        d.textContent = 'x';
        out.push(kids === d.childNodes && kids.length === 1 && kids[0].data === 'x');
        d.innerHTML = '<p>a</p><p>b</p>';
        out.push(kids === d.childNodes && kids.length === 2);
        d.replaceChildren(document.createElement('span'));
        out.push(kids === d.childNodes && kids.length === 1 && kids[0].localName === 'span');
        return out;
      })()
    JS
    expect(got).to eq([true, true, true])
  end
end
