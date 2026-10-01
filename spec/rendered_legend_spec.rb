# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A fieldset's RENDERED LEGEND (HTML §15.3.13) is the first child BOX of the fieldset's box that is a `<legend>`, neither
# floated nor absolutely positioned — a shrink-to-fit block. Boxes, not DOM children: each shape below was decided on
# the DOM tree, in both engines, and laid the legend out 300px wide (or, for the box-less fieldset, shrank it). Parity
# between the walks cannot see an error they share, so the figures are Chrome's (Firefox agrees on the first).
RSpec.describe 'the rendered legend' do
  it "is the first legend BOX of the fieldset's box" do
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
  end

  # …and which one it is follows its siblings: hiding the first legend makes the second the rendered one, and
  # showing it again takes that back. Neither write touches the second legend, whose box both engines reused —
  # 300px where Chrome shrinks it to 55.6, and the other way round.
  it 'follows a change to an earlier legend' do
    html = <<~HTML
      <!DOCTYPE html><html><head><style>body { margin: 8px; font: 16px sans-serif } fieldset { width: 300px; margin: 0; padding: 0 10px; border: 2px solid } .n { display: none }</style></head><body>
      <fieldset><legend id="a">first</legend><legend id="b">second</legend></fieldset>
      </body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    width = "Math.round(document.getElementById('b').getBoundingClientRect().width * 10) / 10"
    expect(s.evaluate_script(width)).to eq(300)
    s.execute_script("document.getElementById('a').classList.add('n')")
    expect(s.evaluate_script(width)).to eq(55.6)
    s.execute_script("document.getElementById('a').classList.remove('n')")
    expect(s.evaluate_script(width)).to eq(300)
    # …and a WRAPPER around the first one: `display: contents` hands its legend to the fieldset's box, and a block
    # takes it back, with no write to either legend.
    s.execute_script(<<~JS)
      const w = document.createElement('div');
      document.getElementById('a').before(w);
      w.append(document.getElementById('a'));
      w.id = 'w';
    JS
    expect(s.evaluate_script(width)).to eq(55.6)
    s.execute_script("document.getElementById('w').style.display = 'contents'")
    expect(s.evaluate_script(width)).to eq(300)
    s.execute_script("document.getElementById('w').style.display = 'block'")
    expect(s.evaluate_script(width)).to eq(55.6)
  end
end
