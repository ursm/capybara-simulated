# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# NodeList and RadioNodeList, generated from their IDL: legacy platform objects — no Arrays — whose indices a Proxy
# answers, read-only, off the nodes in their slots: a node's `childNodes` (the same list each time, as live as its
# children), a static `querySelectorAll` answer, a live `getElementsByName` one, and a form's RadioNodeList with its
# radio group's `value`. Their `length` and `item`, and the value iterator's members (%Array.prototype%'s), are the
# prototype's.
RSpec.describe 'NodeList bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8">
        <ul id="u"><li>a</li><li>b</li></ul>
        <form id="f"><input type="radio" name="r" value="x"><input type="radio" name="r" value="y" checked></form>
      HTML
    }
  }

  it 'is what its IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        'use strict';
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const children = u.childNodes, found = u.querySelectorAll('li'), named = document.getElementsByName('r');
        const radios = f.elements.r;
        const before = children.length;
        u.appendChild(document.createElement('li'));
        const out = [
          err(() => new NodeList()), Array.isArray(children), children === u.childNodes, children.length - before,
          found.length, children instanceof NodeList, Object.getPrototypeOf(NodeList.prototype) === Object.prototype,
          'map' in children, NodeList.prototype.forEach === Array.prototype.forEach, children.item(99), children[99],
          err(() => { children[0] = null; }), Object.keys(found), named.length, radios instanceof RadioNodeList, radios.value
        ];
        radios.value = 'x';
        out.push(f.elements[0].checked, named instanceof RadioNodeList, Object.prototype.toString.call(radios));
        return out;
      })()
    JS
    expect(out).to eq([
      'TypeError', false, true, 1, 2, true, true, false, true, nil, nil, 'TypeError', %w[0 1], 2, true, 'y',
      true, false, '[object RadioNodeList]'
    ])
  end
end
