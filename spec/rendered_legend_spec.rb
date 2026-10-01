# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A fieldset's RENDERED LEGEND (HTML §15.3.13) is the first child BOX of the fieldset's box that is a `<legend>`, neither
# floated nor absolutely positioned — a shrink-to-fit block. Boxes, not DOM children: each shape below was decided on
# the DOM tree, in both engines, and laid the legend out 300px wide (or, for the box-less fieldset, shrank it). Parity
# between the walks cannot see an error they share, so the figures are Chrome's (Firefox agrees on the first).
RSpec.describe 'the rendered legend' do
  %w[0 1].each do |stylo|
    it "is the first legend BOX of the fieldset's box#{stylo == '1' ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = <<~HTML
        <!DOCTYPE html><html><head><style>body { margin: 0; font: 16px sans-serif } .w { width: 300px }</style></head><body>
        <div class="w"><fieldset><legend style="display: none">gone</legend><legend id="a">abc</legend></fieldset></div>
        <div class="w"><fieldset><legend style="display: contents">zz</legend><legend id="b">abc</legend></fieldset></div>
        <div class="w"><fieldset><div style="display: contents"><legend id="c">abc</legend></div></fieldset></div>
        <div class="w" id="h"><template shadowrootmode="open"><fieldset><slot></slot></fieldset></template><legend id="d">abc</legend></div>
        <div class="w"><fieldset style="display: contents"><legend id="e">abc</legend></fieldset></div>
        </body></html>
      HTML
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        ['a', 'b', 'c', 'd', 'e'].map((id) => {
          const el = document.getElementById(id);
          return [Math.round(el.getBoundingClientRect().width * 100) / 100, getComputedStyle(el).width];
        })
      JS
      expect(got).to eq([
        [29.8, '25.7969px'],   # the first legend generates no box, so the second is the rendered one
        [29.8, '25.7969px'],   # …nor does a `display: contents` one
        [29.8, '25.7969px'],   # a `display: contents` wrapper's legend is a child box of the fieldset's
        [29.8, '25.7969px'],   # …and so is a slotted one
        [300, '296px']         # a fieldset with no box has no rendered legend: a plain block
      ])
    ensure
      ENV['CSIM_STYLO'] = saved
    end
  end
end
