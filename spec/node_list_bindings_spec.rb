# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# NodeList and RadioNodeList, generated from their IDL: legacy platform objects — no Arrays — whose indices a Proxy
# answers, read-only, off the nodes in their slots: a node's `childNodes` (the same list each time, as live as its
# children), a static `querySelectorAll` answer, a live `getElementsByName` one, and a form's RadioNodeList with its
# radio group's `value`. Their `length` and `item`, and the value iterator's members (%Array.prototype%'s), are the
# prototype's; an index past the end is no property of theirs, so the prototype chain answers it.
RSpec.describe 'NodeList bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8">
        <ul id="u"><li>a</li><li>b</li></ul>
        <form id="f"><input type="radio" name="r" value="x"><input type="radio" name="r" checked></form>
        <iframe id="i" srcdoc="<p>one</p><p>two</p>"></iframe>
      HTML
    }
  }

  def probe(session, script)
    session.evaluate_script("(() => { 'use strict'; const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } }; #{script} })()")
  end

  it 'is what its IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const children = u.childNodes, found = u.querySelectorAll('li');
      const before = children.length;
      u.appendChild(document.createElement('li'));
      return {
        illegal:      err(() => new NodeList()),
        array:        Array.isArray(children),
        same:         children === u.childNodes,
        live:         children.length - before,
        static:       found.length,
        prototype:    Object.getPrototypeOf(NodeList.prototype) === Object.prototype,
        map:          'map' in children,
        forEach:      NodeList.prototype.forEach === Array.prototype.forEach,
        pastTheEnd:   [children.item(99), children[99]],
        readOnly:     err(() => { children[0] = null; }),
        keys:         Object.keys(found),
        className:    Object.prototype.toString.call(children)
      };
    JS
    expect(out).to eq(
      'illegal'    => 'TypeError',
      'array'      => false,
      'same'       => true,
      'live'       => 1,
      'static'     => 2,
      'prototype'  => true,
      'map'        => false,
      'forEach'    => true,
      'pastTheEnd' => [nil, nil],
      'readOnly'   => 'TypeError',
      'keys'       => %w[0 1],
      'className'  => '[object NodeList]'
    )
  end

  it 'leaves an index past the end to the prototype chain' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      Array.prototype[7] = 'array';
      NodeList.prototype[9] = 'list';
      const children = u.childNodes;
      return { item: children.item(7), own: Object.getOwnPropertyDescriptor(children, '7'), inherited: [children[9], 9 in children] };
    JS
    expect(out).to eq('item' => nil, 'own' => nil, 'inherited' => ['list', true])
  end

  it 'keeps a live one live and a radio group answering its value' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const named = document.getElementsByName('r'), radios = f.elements.r;
      const out = { radios: radios instanceof RadioNodeList, value: radios.value };
      radios.value = 'x';
      const extra = f.appendChild(document.createElement('input'));
      extra.name = 'r';
      return Object.assign(out, { checked: f.elements[0].checked, named: named.length, grown: radios.length });
    JS
    expect(out).to eq('radios' => true, 'value' => 'on', 'checked' => true, 'named' => 3, 'grown' => 3)
  end

  it "marshals another realm's NodeList to Ruby" do
    session = simulated_session(app)
    session.visit '/'
    session.evaluate_script('new Promise((resolve) => (i.contentDocument.readyState === "complete" ? resolve() : i.onload = resolve))')
    expect(session.evaluate_script('i.contentDocument.body.childNodes').size).to eq(2)
  end
end
