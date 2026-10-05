# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A TreeWalker's and a NodeIterator's traversals are the engine's (traversal.rs), over node trees — a shadow root is the
# root of its own — calling the page's filter on each node `whatToShow` shows. Each expectation below is Chrome's and
# Firefox's, but the one marked: a removal of the reference's ancestor, the iterator before it, with nothing following it.
RSpec.describe 'traversal' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=r><p id=a>1<b id=b>2</b></p><!--c--><p id=c>3</p></div>']] }) }

  before { session.visit '/' }

  it 'walks node trees, rejecting and skipping as the filter says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r');
        const name = (n) => n.nodeType === 1 ? n.id : n.nodeType === 3 ? n.data : n.nodeName;
        const all = (w, m) => { const xs = []; let n; while ((n = w[m]())) xs.push(name(n)); return xs.join(); };
        const host = document.body.appendChild(document.createElement('div'));
        host.attachShadow({mode: 'open'}).innerHTML = '<em id=e>x</em>';
        const inShadow = document.createTreeWalker(document.body);
        inShadow.currentNode = host.shadowRoot.firstChild;
        const back = document.createTreeWalker(r);
        back.currentNode = r.lastChild;
        return [
          all(document.createTreeWalker(r, NodeFilter.SHOW_ALL, (n) => n.id === 'a' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT), 'nextNode'),
          all(document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, (n) => n.id === 'a' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT), 'nextNode'),
          all(back, 'previousNode'), all(inShadow, 'previousNode'),
          all(document.createNodeIterator(r, NodeFilter.SHOW_ALL, (n) => n.nodeType === 8 ? true : undefined), 'nextNode')
        ];
      })()
    JS
    expect(got).to eq(['#comment,c,3', 'b,c', '#comment,2,b,1,a,r', '#document-fragment', '#comment'])
  end

  # (…a traversal that climbs more steps than one number holds is told as an array of them)
  it 'climbs out of a deep tree' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r');
        let deep = r.appendChild(document.createElement('section'));
        for (let i = 0; i < 30; i++) deep = deep.appendChild(document.createElement('i'));
        r.appendChild(document.createElement('footer'));
        const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
        w.currentNode = deep;
        const next = w.nextNode().localName;
        const it = document.createNodeIterator(r, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = it.nextNode()) && n.localName !== 'footer');
        return [next, it.previousNode() === it.previousNode() ? 'same' : 'moved', it.referenceNode === deep];
      })()
    JS
    expect(got).to eq(['footer', 'moved', true])
  end

  it 'moves an iterator over a removal, while its filter runs as well' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r');
        const name = (n) => n.nodeType === 1 ? n.id : n.nodeType === 3 ? n.data : n.nodeName;
        const removing = document.createNodeIterator(r, NodeFilter.SHOW_ALL, (n) => { if (n.id === 'a') n.remove(); return NodeFilter.FILTER_ACCEPT; });
        const seen = []; let n;
        while ((n = removing.nextNode())) seen.push(name(n));
        // (…Firefox and the spec; Chrome keeps the iterator at `b`, before it)
        const d = document.createElement('div');
        d.innerHTML = '<a><b></b></a>';
        const it = document.createNodeIterator(d);
        it.nextNode(); it.nextNode(); it.nextNode(); it.previousNode();
        d.firstChild.remove();
        return [seen.join(), it.referenceNode.localName, it.pointerBeforeReferenceNode];
      })()
    JS
    expect(got).to eq(['r,a,#comment,c,3', 'div', false])
  end
end
