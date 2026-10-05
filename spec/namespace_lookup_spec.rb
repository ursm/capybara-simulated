# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The namespace lookups are the engine's (namespaces.rs): an element's own namespace and prefix, and the `xmlns`
# attributes declaring one, up through its ancestor elements — from a text node's parent, a document's element, an Attr's
# element. Each expectation below is Chrome's.
RSpec.describe 'namespace lookups' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div xmlns:foo="urn:foo">x</div>']] }) }

  before { session.visit '/' }

  it 'finds the declarations a node is under' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const div = document.querySelector('div');
        const doc = new DOMParser().parseFromString('<r xmlns="urn:r" xmlns:a="urn:a"><a:c xmlns:b="urn:b"><d xmlns=""/></a:c></r>', 'application/xml');
        const c = doc.documentElement.firstChild, d = c.firstChild;
        return [
          div.firstChild.lookupNamespaceURI(null), div.lookupNamespaceURI('foo'), div.firstChild.lookupNamespaceURI('xml'),
          d.lookupNamespaceURI('b'), d.lookupNamespaceURI(null), d.isDefaultNamespace(''), d.lookupPrefix('urn:a'),
          c.getAttributeNode('xmlns:b').lookupNamespaceURI('a'), doc.lookupPrefix('urn:a'), doc.doctype, document.doctype.lookupNamespaceURI('xml')
        ];
      })()
    JS
    expect(got).to eq(['http://www.w3.org/1999/xhtml', nil, 'http://www.w3.org/XML/1998/namespace', 'urn:b', nil, true, 'a', 'urn:a', 'a', nil, nil])
  end

  # A namespace or a prefix may carry a lone surrogate, which the arena's UTF-8 names lose: it is compared as UTF-16.
  it 'compares names exactly' do
    got = session.evaluate_script(<<~'JS')
      (() => {
        const units = (v) => v == null ? null : [...v].map((c) => c.charCodeAt(0));
        const e = document.createElementNS('urn:a', '\uD800:e');
        const f = document.createElementNS('urn:\uDC00', 'f');
        f.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:\uD801', 'urn:\uD802');
        return [
          e.lookupNamespaceURI('\uFFFD'), units(e.lookupPrefix('urn:a')), f.isDefaultNamespace('urn:\uFFFD'), f.isDefaultNamespace('urn:\uDC00'),
          units(f.lookupNamespaceURI('\uD801')), units(f.lookupPrefix('urn:\uD802')), f.lookupPrefix('urn:\uFFFD')
        ];
      })()
    JS
    expect(got).to eq([nil, [0xD800], false, true, [117, 114, 110, 58, 0xD802], [0xD801], nil])
  end

  it 'takes its argument as required' do
    got = session.evaluate_script(<<~JS)
      ['lookupNamespaceURI', 'lookupPrefix', 'isDefaultNamespace', 'compareDocumentPosition'].map((m) => {
        try { document.body[m](); return 'ok'; } catch (e) { return e.name; }
      })
    JS
    expect(got).to eq(%w[TypeError TypeError TypeError TypeError])
  end
end
