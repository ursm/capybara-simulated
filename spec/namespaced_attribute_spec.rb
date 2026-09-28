# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A namespaced attribute is a different attribute from the one in no namespace with its local name, and a lookup by
# QUALIFIED name finds the first attribute, in attribute-list order, that has it (DOM "get an attribute by name"): an
# unprefixed `urn:x` `foo` is `getAttributeNode('foo')` / `attributes.getNamedItem('foo')` as much as `getAttribute`,
# and a namespaced `align` set before a plain one is the one `getAttribute('align')` reads. Chrome-measured (the second
# shape is WPT dom/nodes/attributes.html "First set attribute is returned with mapped attribute set later").
RSpec.describe 'namespaced attributes' do
  it 'finds the first attribute with a qualified name, whatever its namespace' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><div id="d">d</div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        d.setAttributeNS('urn:x', 'foo', '1');
        const node = d.getAttributeNode('foo'), named = d.attributes.getNamedItem('foo');
        const r = [node && node.namespaceURI, node && node.value, named && named.value];
        d.attributes.removeNamedItem('foo');
        r.push(d.hasAttribute('foo'));
        const el = document.createElement('div');
        el.setAttributeNS('xx', 'align', 'right');
        el.setAttributeNS('', 'align', 'left');
        r.push(el.getAttribute('align'), el.getAttributeNS(null, 'align'));
        return r;
      })()
    JS
    expect(got).to eq(['urn:x', '1', '1', false, 'right', 'left'])
  end

  # Setting an attribute that exists changes its VALUE only (DOM "set an attribute value"): its prefix stays, so an
  # unprefixed XLink `href` set again as `xlink:href` is still one attribute named `href`. Chrome-measured.
  it 'keeps an existing attribute its prefix' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><p>x</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const X = 'http://www.w3.org/1999/xlink', a = document.createElementNS('http://www.w3.org/2000/svg', 'a');
        a.setAttributeNS(X, 'href', 'u1');
        a.setAttributeNS(X, 'xlink:href', 'u2');
        return [a.attributes[0].name, a.attributes[0].prefix, a.getAttributeNS(X, 'href'), a.attributes.length];
      })()
    JS
    expect(got).to eq(['href', nil, 'u2', 1])
  end
end
