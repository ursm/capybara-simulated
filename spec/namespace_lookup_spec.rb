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
end
