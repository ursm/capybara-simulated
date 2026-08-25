# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSS Shadow Parts — the mirror image of `::slotted()`: a `::part()` rule lives in the OUTER tree
# and styles an element INSIDE the shadow tree its subject hosts. The vendored
# `css/css-shadow/part` WPT tree is the conformance bar; these pin the shapes an app hits and the
# two decisions that are easy to get backwards (the scoping boundary, and the CONTEXT cascade
# step). Chrome-checked where a figure is asserted.
RSpec.describe 'CSS shadow parts' do
  def page(head, body)
    html = "<!DOCTYPE html><html><head><style>#{head}</style></head><body>#{body}</body></html>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  it 'styles a part from the tree outside it, by every listed name' do
    # `::part(a b)` needs EVERY name, order irrelevant — a part list behaves like a class list.
    s = page(
      'x-a::part(tab active) { font-weight: 700 } x-a::part(tab) { letter-spacing: 3px }',
      '<x-a id="a"></x-a>'
    )
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('a').attachShadow({mode: 'open'});
        sr.innerHTML = '<div part="tab active"></div><div part="tab"></div>';
        return [...sr.querySelectorAll('div')].map(d => {
          const cs = getComputedStyle(d);
          return [cs.fontWeight, cs.letterSpacing];
        });
      })()
    JS
    expect(got).to eq([%w[700 3px], %w[400 3px]])
  end

  it 'stops at the tree boundary unless exportparts forwards the name' do
    # A part is visible to the DIRECT parent tree only. `exportparts="inner: outer"` carries it one
    # more level, under the new name — and the OLD name stops there.
    s = page(
      'x-outer::part(exposed) { letter-spacing: 4px } x-outer::part(box) { letter-spacing: 9px }',
      '<x-outer id="o"></x-outer>'
    )
    got = s.evaluate_script(<<~JS)
      (() => {
        const outer = document.getElementById('o').attachShadow({mode: 'open'});
        outer.innerHTML = '<x-mid id="m" exportparts="box: exposed"></x-mid>';
        const mid = outer.getElementById('m').attachShadow({mode: 'open'});
        mid.innerHTML = '<div part="box"></div>';
        return getComputedStyle(mid.querySelector('div')).letterSpacing;
      })()
    JS
    expect(got).to eq('4px')
  end

  it 'reaches its own tree through :host::part(), and follows the host selector' do
    s = page('', '<div id="host"></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const host = document.getElementById('host');
        host.attachShadow({mode: 'open'}).innerHTML =
          '<style>:host::part(p) { letter-spacing: 1px } :host(.tweak)::part(p) { letter-spacing: 2px }</style>' +
          '<div part="p"></div>';
        const part = host.shadowRoot.querySelector('[part]');
        const before = getComputedStyle(part).letterSpacing;
        host.classList.add('tweak');
        return [before, getComputedStyle(part).letterSpacing];
      })()
    JS
    expect(got).to eq(%w[1px 2px])
  end

  it 'sorts by CONTEXT before the style attribute: outer wins normal, inner wins important' do
    # css-cascade-5 puts context ABOVE the style attribute, which is why the first case is not the
    # usual "inline always wins". Both figures are what Chrome reports.
    s = page('#host::part(p) { color: rgb(0, 128, 0) } #imp::part(p) { color: rgb(0, 128, 0) !important }',
             '<div id="host"></div><div id="imp"></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const inline = document.getElementById('host');
        inline.attachShadow({mode: 'open'}).innerHTML = '<div part="p" style="color: rgb(255, 0, 0)"></div>';
        const imp = document.getElementById('imp');
        imp.attachShadow({mode: 'open'}).innerHTML =
          '<style>div { color: rgb(255, 0, 0) !important }</style><div part="p"></div>';
        return [getComputedStyle(inline.shadowRoot.querySelector('[part]')).color,
                getComputedStyle(imp.shadowRoot.querySelector('[part]')).color];
      })()
    JS
    #      outer NORMAL beats the inline style   inner IMPORTANT beats the outer important
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(255, 0, 0)'])
  end

  it 'reflects the part attribute as a token list' do
    s = page('', '<div id="host"></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('host').attachShadow({mode: 'open'});
        sr.innerHTML = '<div part="a b"></div>';
        const d = sr.querySelector('div');
        d.part.add('c');
        return [d.part.value, d.part.contains('b'), d.part.length, d.getAttribute('part')];
      })()
    JS
    expect(got).to eq(['a b c', true, 3, 'a b c'])
  end
end
