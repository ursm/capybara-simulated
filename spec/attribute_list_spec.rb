# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element's attribute list is the engine's (attributes.rs): an attribute found by its qualified name — lowercased for
# an HTML element in an HTML document only — or by its namespace and local name, two of one qualified name kept apart,
# and every change handled there — its record queued, an input's type change moving the value into the `value`
# attribute behind the type's own record (DOM §4.9, HTML §4.10.5's "input type change" steps). Chrome agrees with every
# figure but one: its dataset setter writes the first attribute of the qualified name, a namespaced `data-q` included,
# where HTML's "set an attribute value" names the one in no namespace; and its `setAttributeNode` of an Attr of another
# prefix keeps the old one's qualified name, where DOM's "replace an attribute" puts the new one in its place (Firefox).
RSpec.describe 'an element’s attribute list' do
  it 'finds, keeps apart and records attributes as the DOM says' do
    session = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><div id=d></div><input id=i>']]
    }).tap {|s| s.visit '/' }
    got = session.evaluate_script(<<~'JS')
      (() => {
        const out = {};
        const d = document.getElementById('d'), i = document.getElementById('i');
        d.setAttribute('ABC', '1');
        const xml = document.implementation.createDocument(null, 'r');
        const p = xml.createElementNS('http://www.w3.org/1999/xhtml', 'p');
        p.setAttribute('ABC', '1');
        out.case = [d.getAttributeNames().slice(1), p.getAttributeNames(), p.getAttribute('abc'), p.hasAttribute('ABC')];
        d.setAttribute('x', 'plain');
        d.setAttributeNS('urn:a', 'x', 'spaced');
        d.setAttributeNS('urn:b', 'b:x', 'prefixed');
        out.apart = [d.getAttribute('x'), d.getAttributeNS('urn:a', 'x'), d.getAttribute('b:x'), d.getAttributeNames(),
                     [...d.attributes].map((a) => [a.namespaceURI, a.prefix, a.localName, a.value].join('|'))];
        d.removeAttribute('x');
        out.after = [d.getAttribute('x'), d.getAttributeNS(null, 'x'), d.getAttributeNames()];
        d.setAttributeNS('urn:a', 'data-q', 'n');
        d.dataset.q = 'plain';
        out.dataset = [d.dataset.q, d.getAttributeNS('urn:a', 'data-q'), Object.keys(d.dataset)];
        const j = document.createElement('input');
        j.setAttributeNS('urn:x', 'type', 'checkbox');
        out.spacedType = [j.type, j.getAttribute('type')];
        const seen = [];
        const mo = new MutationObserver(() => {});
        mo.observe(i, {attributes: true, attributeOldValue: true});
        i.value = 'typed';
        i.type = 'checkbox';
        for (const r of mo.takeRecords()) seen.push(r.attributeName + ':' + r.oldValue);
        out.typeChange = [seen, i.getAttribute('value'), i.value];
        i.type = 'text';
        out.back = [i.value, i.selectionStart];
        const e = document.createElement('div');
        e.setAttributeNS('urn:x', 'p:a', '1');
        const bound = document.createAttributeNS('urn:x', 'q:a');
        bound.value = '2';
        const replaced = e.setAttributeNode(bound);
        out.bind = [e.getAttributeNames(), e.outerHTML, e.getAttribute('p:a'), e.getAttributeNode('q:a') === bound, replaced.name, replaced.value];
        let threw = '';
        try { d.setAttribute('a b', '1'); } catch (e) { threw = e.name; }
        try { d.setAttributeNS(null, 'p:q', '1'); } catch (e) { threw += ',' + e.name; }
        out.errors = threw;
        return out;
      })()
    JS
    expect(got).to eq(
      'case'       => [['abc'], ['ABC'], nil, true],
      'apart'      => [
        'plain', 'spaced', 'prefixed', ['id', 'abc', 'x', 'x', 'b:x'],
        ['||id|d', '||abc|1', '||x|plain', 'urn:a||x|spaced', 'urn:b|b|x|prefixed']
      ],
      'after'      => ['spaced', nil, ['id', 'abc', 'x', 'b:x']],
      'dataset'    => ['plain', 'n', ['q']],
      'spacedType' => ['text', 'checkbox'],
      'typeChange' => [['type:null', 'value:null'], 'typed', 'typed'],
      'back'       => ['typed', 0],
      'bind'       => [['q:a'], '<div q:a="2"></div>', nil, true, 'p:a', '1'],
      'errors'     => 'InvalidCharacterError,NamespaceError'
    )
  end
end
