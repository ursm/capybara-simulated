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

  # (…the filter may set the walker's current node: "traverse children" stops at it as it stands)
  it "stops a walker's children at its current node as the filter set it" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r');
        const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, (n) => {
          if (n.id === 'a') w.currentNode = n;
          return n.id === 'c' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        });
        return [w.firstChild(), w.currentNode.id];
      })()
    JS
    expect(got).to eq([nil, 'a'])
  end

  # (…every removal moves an iterator — a node's, its children's at once, a replacement's — and within its root; the
  # node following a removal need not be one `whatToShow` shows)
  it 'moves an iterator over every kind of removal, within its root' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r');
        const name = (n) => n.nodeType === 1 ? n.id : n.nodeType === 3 ? n.data : n.nodeName;
        const at = (it) => name(it.referenceNode) + '/' + it.pointerBeforeReferenceNode;
        document.body.appendChild(document.createElement('span')).id = 's';
        const it = document.createNodeIterator(r, NodeFilter.SHOW_ELEMENT);
        it.nextNode(); it.nextNode(); it.nextNode(); it.previousNode();
        const a = document.getElementById('a');
        a.remove();
        const out = [at(it), it.nextNode() && name(it.referenceNode)];
        r.innerHTML = '<p id=x>1<b id=y>2</b></p>';
        const it2 = document.createNodeIterator(r, NodeFilter.SHOW_ALL);
        while (it2.nextNode() && it2.referenceNode.id !== 'y');
        document.getElementById('x').innerHTML = 'z';
        out.push(at(it2));
        return out;
      })()
    JS
    expect(got).to eq(['#comment/true', 'c', 'x/false'])
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

# A filter of the page's runs over a frame's document too (it was refused as no longer runnable: the frame's realm looked
# for the page's among its own child realms).
RSpec.describe 'traversal filters across frames' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe srcdoc="<p>x<b>y</b>"></iframe>']] }) }

  before { session.visit '/' }

  it "runs the page's filter over a frame's document" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const fd = document.querySelector('iframe').contentDocument, seen = [];
        const w = fd.createTreeWalker(fd.body, NodeFilter.SHOW_ALL, (n) => { seen.push(n.nodeName); return NodeFilter.FILTER_ACCEPT; });
        while (w.nextNode());
        return seen.join();
      })()
    JS
    expect(got).to eq('P,#text,B,#text')
  end
end
