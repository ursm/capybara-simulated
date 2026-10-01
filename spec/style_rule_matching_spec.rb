# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A style sheet rule's selector is matched in the mode of the element's document — in an XML one (an XHTML page) no
# type selector or attribute name folds ASCII case, `@namespace` or not — and with no `:scope` bound to the element
# styled: outside `@scope`, `:scope` in a sheet is the document's root, so in a shadow tree it matches nothing.
# Chrome-measured: `<div>` 1008px wide, 18px high in both.
RSpec.describe 'style rule matching' do
  XHTML_PAGE = <<~XHTML
    <?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><style>
    @namespace h url(http://www.w3.org/1999/xhtml);
    h|DIV { width: 50px } DIV.c { width: 70px } [TITLE] { height: 9px }
    </style></head><body><div class="c" id="d" title="t">x</div></body></html>
  XHTML

  it 'folds no case in an XHTML document' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'application/xhtml+xml'}, [XHTML_PAGE]] })
    s.visit '/'
    got = s.evaluate_script("(() => { const cs = getComputedStyle(document.getElementById('d')); return [cs.width, cs.height]; })()")
    expect(got).to eq(%w[1008px 18px])
  end

  it 'binds no :scope to an element of a shadow tree' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><div id="host"></div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~'JS')
      (() => {
        const root = document.getElementById('host').attachShadow({mode: 'open'});
        root.innerHTML = '<style>:scope { width: 15px } .s2:scope { height: 7px }</style><p class="s2">a</p>';
        const cs = getComputedStyle(root.querySelector('p'));
        return [cs.width, cs.height];
      })()
    JS
    expect(got).to eq(%w[1008px 18px])
  end
end
