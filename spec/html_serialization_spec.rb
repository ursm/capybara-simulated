# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML serialization is the arena's (serialize.rs): `innerHTML` of a processing instruction, a CDATA section, the
# namespaced attributes of a foreign element, a template's contents and an `is` value — as HTML §13.3 writes each.
# Chrome agrees on all but the processing instruction, which it closes `?>`; the spec's `>` is written.
RSpec.describe 'HTML serialization' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>x</body>']] } }

  it 'writes each kind of node as HTML says' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (function () {
        var d = document.createElement('div');
        d.appendChild(document.createProcessingInstruction('x', 'y z'));
        var xml = new DOMParser().parseFromString('<r><![CDATA[a<b&c]]></r>', 'application/xml');
        d.appendChild(document.importNode(xml.documentElement.firstChild, true));
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttributeNS('http://www.w3.org/1999/xlink', 'foo:href', '#a');
        svg.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'en');
        svg.setAttributeNS('urn:x', 'p:q', '1');
        d.appendChild(svg);
        var t = document.createElement('template'); t.innerHTML = '<b>t</b>'; d.appendChild(t);
        d.appendChild(document.createElement('div', {is: 'x-y'}));
        return d.innerHTML;
      })()
    JS
    expect(got).to eq('<?x y z>a&lt;b&amp;c<svg xlink:href="#a" xml:lang="en" p:q="1"></svg><template><b>t</b></template><div is="x-y"></div>')
  end

  it "keeps a template's contents when it is copied into another document's realm" do
    a = ->(env) {
      body = env['PATH_INFO'] == '/frame' ? '<!DOCTYPE html><body><template id="ft"><i>fi</i></template></body>' : '<!DOCTYPE html><body><iframe src="/frame"></iframe></body>'
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(a)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (function () {
        var fd = document.querySelector('iframe').contentDocument;
        var t = document.createElement('template'); t.innerHTML = '<b>x</b>';
        fd.body.appendChild(t.cloneNode(true));
        return [document.importNode(fd.getElementById('ft'), true).outerHTML, fd.body.lastChild.outerHTML];
      })()
    JS
    expect(got).to eq(['<template id="ft"><i>fi</i></template>', '<template><b>x</b></template>'])
  end

  it 'serializes a tree of any depth, and keeps a lone surrogate in an is value or a doctype identifier' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~'JS')
      (function () {
        var root = document.createElement('div'), cur = root;
        for (var i = 0; i < 30000; i++) { var d = document.createElement('div'); cur.appendChild(d); cur = d; }
        return [root.innerHTML.length, new XMLSerializer().serializeToString(root).length,
                document.createElement('div', {is: 'x\ud800'}).outerHTML === '<div is="x\ud800"></div>',
                new XMLSerializer().serializeToString(document.implementation.createDocumentType('a', 'p\ud800', 's')) === '<!DOCTYPE a PUBLIC "p\ud800" "s">'];
      })()
    JS
    expect(got).to eq([330_000, 330_048, true, true])
  end
end
