# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTMLCollection, HTMLOptionsCollection and HTMLFormControlsCollection, generated from their IDL: live legacy platform
# objects, their indices and names a Proxy answers and everything else their prototypes' — a page's own `length` getter
# on the prototype included. An options collection takes an option at an index and its select's `length`, `add`,
# `remove` and `selectedIndex`; a form's controls answer a name more than one has with the same live RadioNodeList.
RSpec.describe 'HTMLCollection bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8">
        <select id="s"><option>a</option><option id="o2">b</option></select>
        <form id="f"><input name="r" type="radio" value="x"><input name="r" type="radio" value="y"><input name="t"></form>
      HTML
    }
  }

  it 'is what their IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        'use strict';
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const options = s.options, elements = f.elements, all = document.getElementsByTagName('option');
        const out = [
          err(() => new HTMLCollection()), Array.isArray(all), all.length, all.o2 === all[1], err(() => { all.o2 = 1; }),
          err(() => { all[0] = null; }), err(() => options.remove()), elements.r === elements.r, elements.r instanceof RadioNodeList,
          elements.namedItem('t') === elements.t, elements.namedItem('nope'), Object.keys(all)
        ];
        options[3] = document.createElement('option');
        out.push(options.length, err(() => { options[0] = document.createElement('div'); }));
        options.length = 1;
        options.add(document.createElement('option'), 0);
        options.selectedIndex = 1;
        out.push(s.options.length, s.value, s.selectedIndex);
        const length = Object.getOwnPropertyDescriptor(HTMLCollection.prototype, 'length');
        Object.defineProperty(HTMLCollection.prototype, 'length', { get() { return 42; }, configurable: true });
        out.push(all.length);
        Object.defineProperty(HTMLCollection.prototype, 'length', length);
        return out;
      })()
    JS
    expect(out).to eq([
      'TypeError', false, 2, true, 'TypeError', 'TypeError', 'TypeError', true, true, true, nil, %w[0 1],
      4, 'TypeError', 2, 'a', 1, 42
    ])
  end
end
