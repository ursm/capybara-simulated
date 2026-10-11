# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/garbage'

# A NodeIterator's state is the engine's (node_iterators.rs), which runs every removal's pre-removing steps on it, and
# its handle is held by the iterator alone: one a script dropped goes with it, while one it holds keeps its reference —
# a node held by nothing else — and keeps being moved.
RSpec.describe 'NodeIterator registry' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=r><p id=a>1</p><p id=b>2</p><p id=c>3</p></div>']] }) }

  it 'lets go of the iterators a script dropped and keeps moving the one it holds' do
    session.visit '/'
    session.execute_script(<<~JS)
      const r = document.getElementById('r');
      for (let i = 0; i < 2000; i++) document.createNodeIterator(r).nextNode();
      window.__it = document.createNodeIterator(r, NodeFilter.SHOW_ELEMENT);
      __it.nextNode(); __it.nextNode();   // r, then a: the reference is #a, the pointer after it
    JS
    collect_garbage(session) { session.evaluate_script('__dom.iteratorsLive()') <= 1 }
    got = session.evaluate_script(<<~JS)
      (() => {
        const live = __dom.iteratorsLive();
        document.getElementById('a').remove();
        return [live, __it.referenceNode.id, __it.pointerBeforeReferenceNode, __it.nextNode().id];
      })()
    JS
    expect(got).to eq([1, 'r', false, 'b'])
  end

  # Its reference is always in its root's tree, which the root its slots hold keeps, edge by edge — so a reference held
  # by nothing else is the same object after a collection.
  it 'keeps its reference alive and itself, whatever else holds it' do
    session.visit '/'
    session.execute_script(<<~JS)
      const frag = document.createElement('div');
      frag.innerHTML = '<span><i></i></span>';
      window.__it = document.createNodeIterator(frag.firstChild.firstChild);
      __it.nextNode();
      frag.firstChild.firstChild.marker = 'kept';
    JS
    collect_garbage(session)
    expect(session.evaluate_script('[__it.referenceNode.localName, __it.referenceNode.marker]')).to eq(%w[i kept])
  end
end
