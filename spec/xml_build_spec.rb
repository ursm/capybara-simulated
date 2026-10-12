# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An XML parse is built by the engine (xml_parse.rs `xmlBuild`): a DOMParser's document and an XML document's fragment
# parse — every node in its document, namespaces and prefixes as the scope declares them, processing instructions,
# CDATA sections and a doctype as nodes, an XHTML `<template>`'s children its contents, an inline handler and a lone
# surrogate in an attribute value kept; the bindings' steps run after for the elements that have them.
RSpec.describe 'XML build' do
  let(:session) {
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] }).tap {|s| s.visit '/' }
  }

  it "builds a DOMParser's XML document" do
    got = session.evaluate_script(<<~'JS')
      (() => {
        const doc = new DOMParser().parseFromString(
          '<!DOCTYPE r SYSTEM "r.dtd"><?pi data?><r xmlns="urn:r" xmlns:x="urn:x"><x:e x:a="1" b="\uD800"><![CDATA[c<d]]></x:e>' +
          '<template xmlns="http://www.w3.org/1999/xhtml"><p>in</p></template>' +
          '<button xmlns="http://www.w3.org/1999/xhtml" onclick="window.hit = 1">b</button></r>', 'application/xml');
        const e = doc.documentElement.firstChild, t = doc.querySelector('template'), a = e.attributes[0];
        doc.querySelector('button').click();
        return [
          doc.doctype.systemId, doc.childNodes[1].nodeType, doc.childNodes[1].target, doc.documentElement.namespaceURI,
          e.namespaceURI, e.prefix, e.localName, a.namespaceURI, a.prefix, e.getAttribute('b') === '\uD800',
          e.firstChild.nodeType, e.firstChild.data, t.childNodes.length, t.content.firstChild.localName,
          t.content.firstChild.ownerDocument !== doc, e.ownerDocument === doc, window.hit
        ];
      })()
    JS
    expect(got).to eq(['r.dtd', 7, 'pi', 'urn:r', 'urn:x', 'x', 'e', 'urn:x', 'x', true, 4, 'c<d', 0, 'p', true, true, 1])
  end

  it "builds an XML document's fragment, its scripts not run, and refuses one not well-formed" do
    got = session.evaluate_script(<<~'JS')
      (() => {
        const doc = new DOMParser().parseFromString('<r xmlns:x="urn:x"><c/></r>', 'application/xml');
        const c = doc.documentElement.firstChild;
        c.innerHTML = '<x:i/>text<script xmlns="http://www.w3.org/1999/xhtml">window.ran = 1</script>';
        document.body.appendChild(document.adoptNode(c));
        let error = null;
        try { doc.documentElement.innerHTML = '<a>'; } catch (e) { error = e.name; }
        return [c.firstChild.namespaceURI, c.childNodes[1].data, window.ran === undefined, error];
      })()
    JS
    expect(got).to eq(['urn:x', 'text', true, 'SyntaxError'])
  end
end
