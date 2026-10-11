# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/garbage'

# The DOM's mutations update every live range (DOM §5.5) — the engine keeps their boundary points (ranges.rs) — and a
# range is held by its object alone: one a script dropped goes with it, where a strong set kept every range ever made
# for the page's life — each walked, ancestor by ancestor, on every removal. A range the page still holds keeps being
# updated.
RSpec.describe 'live range registry' do
  it 'lets go of the ranges a script dropped and keeps updating the ones it holds' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><p id=p>a<b>b</b>c</p>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const p = document.getElementById('p');
      for (let i = 0; i < 5000; i++) { const r = document.createRange(); r.selectNodeContents(p); }
      window.__held = document.createRange();
      __held.setStart(p, 2);
    JS
    collect_garbage(s) { s.evaluate_script('__dom.rangesLive()') <= 1 }
    got = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p');
        p.removeChild(p.firstChild);
        return [__dom.rangesLive(), __held.startOffset];
      })()
    JS
    expect(got).to eq([1, 1])
  end

  # A range's handle traces its boundary containers (ranges.rs), so a range in a cycle with them — a node holding the
  # range, the range holding the node — goes when nothing else holds either; and the containers it hands out are the
  # objects a script holds, a document's Proxy too, wherever a mutation moved a boundary.
  it 'lets a range go with the nodes it is in a cycle with, and hands its containers out as themselves' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><p id=p>ab</p>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      for (let i = 0; i < 100; i++) {
        const d = document.createElement('div'), t = d.appendChild(document.createTextNode('xy'));
        d.range = document.createRange();
        d.range.setStart(t, 1);
      }
    JS
    collect_garbage(s) { s.evaluate_script('__dom.rangesLive()').zero? }
    got = s.evaluate_script(<<~JS)
      (() => {
        const live = __dom.rangesLive();
        const p = document.getElementById('p'), t = p.firstChild, r = document.createRange();
        const fresh = r.startContainer === document;
        r.setStart(t, 2);
        t.splitText(1);                  // the boundary, past the split point, moves into the new node
        const split = r.startContainer === p.lastChild && r.startOffset === 1;
        p.removeChild(p.lastChild);      // …and out to its parent
        return [live, fresh, split, r.startContainer === p, r.startOffset];
      })()
    JS
    expect(got).to eq([0, true, true, true, 1])
  end
end
