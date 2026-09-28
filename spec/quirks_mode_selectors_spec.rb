# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# In a quirks-mode document a class or id selector matches ASCII case-insensitively (Selectors 4 §6.6 / §6.7, HTML
# "quirks mode"); an attribute selector does not. Every matcher ignored the mode — the cascade (both halves), the
# native matcher and css-select — so a no-doctype page's `.Foo` never styled `class="foo"`. The mode is the
# element's DOCUMENT's: a DOMParser document without a doctype is quirks under a no-quirks page. Chrome-measured.
RSpec.describe 'quirks mode selectors' do
  def session(html)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  it 'matches classes and ids case-insensitively in a quirks-mode document' do
    s = session(<<~HTML)
      <html><head><style>.Foo { margin-left: 5px } #ID { margin-top: 3px } [class~=Foo] { padding-left: 2px } .Wrap .kid { padding-top: 4px }</style></head>
      <body><div class="foo" id="id">x</div><div class="wrap"><span class="kid" id="k">k</span></div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('id'), cs = getComputedStyle(d);
        return [document.compatMode, cs.marginLeft, cs.marginTop, cs.paddingLeft,
                getComputedStyle(document.getElementById('k')).paddingTop,
                document.querySelectorAll('.FOO').length, d.matches('#Id'), document.getElementsByClassName('FOO').length];
      })()
    JS
    expect(got).to eq(['BackCompat', '5px', '3px', '0px', '4px', 1, true, 1])
  end

  it "asks the element's own document" do
    s = session('<!DOCTYPE html><p class="foo" id="p">p</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = new DOMParser().parseFromString('<p class="foo" id="q">q</p>', 'text/html');
        return [document.compatMode, document.querySelectorAll('.FOO').length, d.compatMode, d.querySelectorAll('.FOO').length,
                d.getElementById('q').matches('#Q')];
      })()
    JS
    expect(got).to eq(['CSS1Compat', 0, 'BackCompat', 1, true])
  end

  # The folding is ASCII only: `.ä` does not match `class="Ä"`, and U+212A KELVIN SIGN is not `k` — on every surface,
  # the generated-content index included, and after the load (a context bump makes the native cascade answer again).
  # A scope root adopted into a no-quirks document is matched in ITS mode. Chrome-measured.
  it 'folds ASCII only, on every surface, in the mode of the current document' do
    s = session(<<~HTML)
      <html><head><meta charset="utf-8"><style>.Foo::before { content: 'XXXXXXXX' } span { display: inline-block }
      .Ä { cursor: pointer } .\\212A { cursor: move } #Ö { caret-color: red }</style></head>
      <body><span class="Foo" id="f"></span><div class="Ä" id="Ö">a</div><div class="&#x212A;" id="k">k</div><p id="p" class="foo">p</p></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const r = [document.getElementById('f').offsetWidth > 0];
        const a = document.getElementById('Ö'), k = document.getElementById('k');
        a.setAttribute('data-z', '1'); k.setAttribute('data-z', '1');
        r.push(getComputedStyle(a).cursor, getComputedStyle(k).cursor, getComputedStyle(a).caretColor);
        r.push(document.querySelectorAll('.ä').length, a.matches('.ä'), a.closest('.ä'), a.matches('#ö'));
        const p = document.getElementById('p');
        r.push(p.matches(':scope.FOO'));
        const d = document.implementation.createHTMLDocument('');
        d.adoptNode(p); d.body.appendChild(p);
        r.push(p.matches(':scope.FOO'), p.matches('.FOO'));
        return r;
      })()
    JS
    expect(got).to eq([true, 'pointer', 'move', 'rgb(255, 0, 0)', 0, false, nil, false, true, false, false])
  end
end
