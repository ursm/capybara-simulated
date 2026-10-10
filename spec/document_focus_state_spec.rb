# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The document's focused and hovered elements are internal state, not properties a page can name: an `<img name>` is a
# named property of the document (HTML §3.1.6), and one named after the slot the focus lives in answered for it — before
# the first focus, `document.activeElement` was the IMG. It is the body, as in any browser.
RSpec.describe 'document focus state' do
  it 'is not answered by a named element' do
    app = ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><img name="_activeElement"><img name="_hoverElement">']] }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('document.activeElement.tagName')).to eq('BODY')
    expect(s.evaluate_script('document.querySelectorAll(":hover").length')).to eq(0)
  end

  # The focused element leaves the document's focus whichever way it leaves the document — a replacement, `innerHTML`,
  # `textContent`, `outerHTML` as much as a removal — and one in a shadow tree with its host: it had stayed `:focus`
  # (Chrome 155: every line `true/false`, and `false/false`).
  it 'is let go by an element that leaves the document any way' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const out = [];
        for (const how of ['innerHTML', 'textContent', 'replaceChildren', 'outerHTML', 'replaceWith', 'remove']) {
          const d = document.body.appendChild(document.createElement('div'));
          const i = d.appendChild(document.createElement('input'));
          i.focus();
          if (how === 'innerHTML') d.innerHTML = '';
          else if (how === 'textContent') d.textContent = '';
          else if (how === 'replaceChildren') d.replaceChildren();
          else if (how === 'outerHTML') i.outerHTML = '<b></b>';
          else if (how === 'replaceWith') i.replaceWith(document.createElement('b'));
          else i.remove();
          out.push(how + ':' + (document.activeElement === document.body) + '/' + i.matches(':focus'));
          d.remove();
        }
        const h = document.body.appendChild(document.createElement('div'));
        const si = h.attachShadow({mode: 'open'}).appendChild(document.createElement('input'));
        si.focus();
        document.body.innerHTML = '';
        out.push('shadow:' + si.matches(':focus') + '/' + h.matches(':focus'));
        return out;
      })()
    JS
    expect(got).to eq(%w[innerHTML textContent replaceChildren outerHTML replaceWith remove].map {|how| "#{how}:true/false" } + ['shadow:false/false'])
  end
end
