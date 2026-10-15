require 'capybara/simulated'
require_relative 'support/session_teardown'

# document.execCommand acts in the editing host the selection is in — as queryCommandEnabled answers it — whatever has
# focus: a contenteditable's text selected with nothing focused, and a design-mode document's. Chrome 155 on this page:
# `[true, "<b>world</b>", true, true, "<b>hello</b>"]`, the body the active element.
RSpec.describe 'execCommand in the selection’s editing host' do
  it 'formats where the selection is, focused or not' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p id=p>hello</p><div contenteditable><p id=q>world</p></div>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const out = [];
        const q = document.getElementById('q').firstChild;
        getSelection().setBaseAndExtent(q, 0, q, 5);
        out.push(document.execCommand('bold'), document.getElementById('q').innerHTML);
        document.designMode = 'on';
        const p = document.getElementById('p').firstChild;
        getSelection().setBaseAndExtent(p, 0, p, 5);
        out.push(document.queryCommandEnabled('bold'), document.execCommand('bold'), document.getElementById('p').innerHTML);
        return out;
      })()
    JS
    expect(got).to eq([true, '<b>world</b>', true, true, '<b>hello</b>'])
  end
end
