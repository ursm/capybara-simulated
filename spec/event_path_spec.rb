# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An event's path through shadow trees is the engine's (event_path.rs): a slotted node's next its slot, a shadow root's
# its host unless the event is not composed, the target retargeted for each listener as the path crosses into a lighter
# tree, and the relatedTarget against each node — in a document (the nodes answered as themselves) or not (by their paths,
# from the target's tree or the relatedTarget's). Each expectation below is Chrome's.
RSpec.describe 'the event path through shadow trees' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/' }

  it 'retargets, slots and prunes as Chrome does, in a document or not' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const nm = (n) => n === window ? 'window' : n.nodeType === 11 ? 'SR' : n.id || n.localName;
        const make = () => {
          const h = document.createElement('div');
          h.id = 'host';
          const sr = h.attachShadow({mode: 'open'});
          sr.innerHTML = '<p id=inner><slot id=s></slot></p>';
          h.appendChild(document.createElement('span')).id = 'light';
          return [h, sr];
        };
        const run = (target, init, at) => {
          const seen = [];
          const ev = new MouseEvent('mouseover', Object.assign({bubbles: true}, init));
          for (const n of at) n.addEventListener('mouseover', (e) => seen.push(nm(e.currentTarget) + ':' + nm(e.target) + (e.relatedTarget ? '/' + nm(e.relatedTarget) : '')));
          target.dispatchEvent(ev);
          return seen.join(' ') + ' | ' + ev.composedPath().map(nm).join();
        };
        const [h1, sr1] = make();
        const [h2, sr2] = make();
        const [h3, sr3] = make();
        document.body.append(h3);
        return [
          run(sr1.getElementById('inner'), {composed: false}, [sr1.getElementById('inner'), sr1, h1]),
          run(h1.firstChild, {composed: true}, [h1.firstChild, sr1.getElementById('s'), sr1, h1]),
          run(sr1.getElementById('inner'), {composed: true, relatedTarget: sr2.getElementById('inner')}, [sr1.getElementById('inner'), h1]),
          run(sr3.getElementById('inner'), {composed: true, relatedTarget: window}, [h3, document.body])
        ];
      })()
    JS
    expect(got).to eq([
      'inner:inner SR:inner | ',
      'light:light s:light SR:light host:light | ',
      'inner:inner/host host:host/host | ',
      'host:host/window body:host/window | '
    ])
  end
end
