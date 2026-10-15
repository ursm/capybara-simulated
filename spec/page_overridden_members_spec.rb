require 'capybara/simulated'
require_relative 'support/session_teardown'

# What the platform does is the engine's, not the page's: a page may redefine a member of an interface prototype (a
# polyfill, a test double, an analytics shim), and the platform's own algorithms — serializing, parsing, focusing,
# showing a popover — go on reading the node's own state, never the member the page replaced. In Chrome a throwing
# `Node.prototype.ownerDocument` breaks none of these.
RSpec.describe 'members a page overrides' do
  it "leaves the platform's own reads of a node's document alone" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="i"><div id="p" popover>p</div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        Object.defineProperty(Node.prototype, 'ownerDocument', { get() { throw new Error('page getter'); }, configurable: true });
        const d = document.createElement('div');
        d.innerHTML = '<b>x</b><i>y</i>';
        const html = d.innerHTML;
        d.insertAdjacentHTML('beforeend', '<u>z</u>');
        document.body.append(d);
        document.getElementById('i').focus();
        const focused = document.activeElement.id;
        document.getElementById('p').showPopover();
        const open = document.getElementById('p').matches(':popover-open');
        return [html, d.outerHTML, focused, open];
      })()
    JS
    expect(got).to eq(['<b>x</b><i>y</i>', '<div><b>x</b><i>y</i><u>z</u></div>', 'i', true])
  end
end
