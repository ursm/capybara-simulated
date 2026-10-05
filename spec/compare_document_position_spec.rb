# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Where one node is against another is the engine's (traversal.rs), over node trees: a shadow root is the root of its
# own, so a host and what its shadow tree holds are in no one tree — nor are a template and its contents — and an Attr
# goes as its element and its place in that element's attribute list. Each expectation below is Chrome's.
RSpec.describe 'compareDocumentPosition' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=a x=1 y=2><p id=p><b>t</b></p></div><template id=t><u></u></template>']] }) }

  before { session.visit '/' }

  it 'answers over node trees, and for attributes' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a'), p = document.getElementById('p'), t = document.getElementById('t');
        const host = document.body.appendChild(document.createElement('section'));
        const sr = host.attachShadow({mode: 'open'});
        const em = sr.appendChild(document.createElement('em'));
        const x = a.getAttributeNode('x'), y = a.getAttributeNode('y');
        // (…in no one tree: disconnected, implementation-specific, and one direction each way)
        const apart = (m, n) => [m.compareDocumentPosition(n) & 0x21, (m.compareDocumentPosition(n) | n.compareDocumentPosition(m)) & 6];
        return [
          apart(host, em), em.compareDocumentPosition(sr), apart(t, t.content.firstChild),
          x.compareDocumentPosition(y), y.compareDocumentPosition(x), a.compareDocumentPosition(x), x.compareDocumentPosition(a),
          x.compareDocumentPosition(p), p.compareDocumentPosition(x), apart(document.createAttribute('l'), document.createAttribute('m'))
        ];
      })()
    JS
    expect(got).to eq([[33, 6], 10, [33, 6], 36, 34, 20, 10, 4, 2, [33, 6]])
  end
end
