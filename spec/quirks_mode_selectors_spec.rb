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
end
