require 'capybara/simulated'
require_relative 'support/session_teardown'

# A resolved-value declaration lists every longhand, then every custom property the element has a computed value for:
# its own (a rule's or its `style` attribute's), the ones it inherits, and a registered one's initial value (resolved.rs
# `custom_property_count`). Measured in Chrome 155 and Firefox on the page below: both list exactly --a --b --c --reg
# --regi --root --z after the longhands, on the div and on the span inside it, each in an order of its own (hash
# order), so the examples compare the set.
RSpec.describe 'the custom properties a computed style lists' do
  let(:page) do
    <<~HTML
      <!DOCTYPE html>
      <style>
        @property --reg { syntax: "<length>"; inherits: false; initial-value: 3px; }
        @property --regi { syntax: "<color>"; inherits: true; initial-value: red; }
        :root { --root: 1; }
        div { --b: 2; --z: x; --a: y; }
        div::before { content: ''; --p: 1; }
      </style>
      <div id="d" style="--c: 3"><span id="s"></span></div>
    HTML
  end

  def visit_page
    doc = page
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [doc]] })
    s.visit '/'
    s
  end

  it 'lists its own, the inherited and the registered ones after the longhands' do
    s = visit_page
    custom = s.evaluate_script(<<~JS)
      ['d', 's'].map((id) => {
        const names = [...getComputedStyle(document.getElementById(id))];
        const first = names.findIndex((n) => n.startsWith('--'));
        return [names.slice(first).every((n) => n.startsWith('--')), names.slice(first).sort()];
      })
    JS
    expect(custom).to eq([[true, %w[--a --b --c --reg --regi --root --z]]] * 2)
  end

  it 'answers the same names by index, by item() and through length' do
    s = visit_page
    expect(s.evaluate_script(<<~JS)).to eq([true, '', ''])
      (() => {
        const cs = getComputedStyle(document.getElementById('d'));
        const indexed = [];
        for (let i = 0; i < cs.length; i++) indexed.push(cs[i]);
        return [indexed.join() === [...cs].join() && indexed.every((n, i) => cs.item(i) === n), cs[cs.length], cs.item(cs.length)];
      })()
    JS
  end

  it "lists a pseudo-element's own" do
    s = visit_page
    expect(s.evaluate_script(<<~JS)).to eq(%w[--a --b --c --p --reg --regi --root --z])
      [...getComputedStyle(document.getElementById('d'), '::before')].filter((n) => n.startsWith('--')).sort()
    JS
  end

  it 'lists none for an element the engine does not style' do
    s = visit_page
    expect(s.evaluate_script(<<~JS)).to eq([0, 0, ''])
      (() => {
        const d = document.getElementById('d'), cs = getComputedStyle(d);
        d.remove();
        return [cs.length, [...cs].length, cs[0]];
      })()
    JS
  end
end
