# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTMLCollection, HTMLOptionsCollection and HTMLFormControlsCollection, generated from their IDL: live legacy platform
# objects, their indices and names a Proxy answers and everything else their prototypes' — a page's own `length` getter
# on the prototype included. An options collection takes an option (or null, or undefined, which is null) at an index
# and its select's `length`, `add`, `remove` and `selectedIndex`; a form's controls answer a name more than one has with
# the same live RadioNodeList.
RSpec.describe 'HTMLCollection bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8">
        <style>input:checked + span { display: none }</style>
        <select id="s"><option>a</option><option id="o2">b</option></select>
        <form id="f"><input name="r" type="radio" value="x"><span>X</span><input name="r" type="radio" value="y" checked><span>Y</span><input name="t"></form>
      HTML
    }
  }

  def probe(session, script)
    session.evaluate_script("(() => { 'use strict'; const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } }; #{script} })()")
  end

  it 'is what their IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const elements = f.elements, all = document.getElementsByTagName('option');
      return {
        illegal:    err(() => new HTMLCollection()),
        array:      Array.isArray(all),
        length:     all.length,
        named:      all.o2 === all[1],
        namedWrite: err(() => { all.o2 = 1; }),
        indexWrite: err(() => { all[0] = null; }),
        remove:     err(() => s.options.remove()),
        radios:     [elements.r === elements.r, elements.r instanceof RadioNodeList, elements.namedItem('r') === elements.r],
        namedItem:  [elements.namedItem('t') === elements.t, elements.namedItem('nope')],
        keys:       Object.keys(all),
        inherited:  Reflect.set(Object.create(all), 9, 1)
      };
    JS
    expect(out).to eq(
      'illegal'    => 'TypeError',
      'array'      => false,
      'length'     => 2,
      'named'      => true,
      'namedWrite' => 'TypeError',
      'indexWrite' => 'TypeError',
      'remove'     => 'TypeError',
      'radios'     => [true, true, true],
      'namedItem'  => [true, nil],
      'keys'       => %w[0 1],
      'inherited'  => true
    )
  end

  it "writes an options collection through its select" do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const options = s.options;
      options[3] = document.createElement('option');
      const grown = options.length;
      const wrongType = err(() => { options[0] = document.createElement('div'); });
      options[3] = undefined;
      const unset = options.length;
      options.length = 1;
      options.add(document.createElement('option'), 0);
      options.selectedIndex = 1;
      return { grown, wrongType, unset, length: s.options.length, value: s.value, selectedIndex: s.selectedIndex };
    JS
    expect(out).to eq('grown' => 4, 'wrongType' => 'TypeError', 'unset' => 3, 'length' => 2, 'value' => 'a', 'selectedIndex' => 1)
  end

  it 'reads its length through the prototype a page may replace' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const all = document.getElementsByTagName('option'), length = Object.getOwnPropertyDescriptor(HTMLCollection.prototype, 'length');
      Object.defineProperty(HTMLCollection.prototype, 'length', { get() { return 42; }, configurable: true });
      const replaced = all.length;
      Object.defineProperty(HTMLCollection.prototype, 'length', length);
      return replaced;
    JS
    expect(out).to eq(42)
  end

  it 'shows a radio group checked through its RadioNodeList' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script("f.elements.r.value = 'x'")
    expect(session.find(:css, '#f').text).to eq('Y')
  end
end
