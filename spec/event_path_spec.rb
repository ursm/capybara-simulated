# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An event's path through shadow trees is the engine's (event_path.rs): a slotted node's next its slot, a shadow root's
# its host unless the event is not composed, the target retargeted for each listener as the path crosses into a lighter
# tree, and the relatedTarget against each node — in a document or not. Each expectation below is Chrome's.
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

  # A path across a shadow root is the flat tree's, retargeted, whichever realm's script dispatches: one with no shadow
  # tree of its own, dispatching at a node in a frame's shadow tree, took the plain parent chain (the host's listeners
  # saw the button, not the host) — or stopped at the shadow root. Chrome 155: "#document-fragment:btn host:host
  # BODY:host".
  it "retargets across a frame's shadow root, whichever realm dispatches" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.body.appendChild(document.createElement('iframe'));
      f.onload = () => {
        const fd = f.contentDocument;
        const host = fd.body.appendChild(fd.createElement('div'));
        host.id = 'host';
        const root = host.attachShadow({mode: 'open'});
        const btn = root.appendChild(fd.createElement('button'));
        btn.id = 'btn';
        const log = [];
        const note = (e) => log.push((e.currentTarget.id || e.currentTarget.nodeName) + ':' + e.target.id);
        for (const t of [host, fd.body, root]) t.addEventListener('zz', note);
        EventTarget.prototype.dispatchEvent.call(btn, new Event('zz', {bubbles: true, composed: true}));
        done(log.join(' '));
      };
      f.srcdoc = '<!doctype html><body>';
    JS
    expect(got).to eq('#document-fragment:btn host:host BODY:host')
  end
end
