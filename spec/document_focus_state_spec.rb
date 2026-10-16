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

  # DocumentOrShadowRoot's activeElement (HTML §6.6.4): the focused element retargeted against the root, none where that
  # is in another tree, and — nothing focused — a document's body element, else its document element (the spec's step
  # 6: a document with no body answers its root, where the body alone answered null).
  it 'retargets the focus against the root, and falls back to the body, then the document element' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const outer = document.body.appendChild(document.createElement('div'));
        const outerRoot = outer.attachShadow({mode: 'open'});
        const inner = outerRoot.appendChild(document.createElement('div'));
        const innerRoot = inner.attachShadow({mode: 'open'});
        const input = innerRoot.appendChild(document.createElement('input'));
        const other = document.body.appendChild(document.createElement('div')).attachShadow({mode: 'open'});
        input.focus();
        const out = [document.activeElement === outer, outerRoot.activeElement === inner, innerRoot.activeElement === input,
                     other.activeElement];
        input.blur();
        out.push(document.activeElement === document.body, outerRoot.activeElement);
        document.body.remove();
        out.push(document.activeElement === document.documentElement);
        const parsed = new DOMParser().parseFromString('<p>', 'text/html');
        out.push(parsed.activeElement === parsed.body);
        return out;
      })()
    JS
    expect(got).to eq([true, true, true, nil, true, nil, true, true])
  end

end
