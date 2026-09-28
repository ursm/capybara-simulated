# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The arena mirrors every node, so what it costs to keep it has to grow with the CHANGE, not with the tree: each
# example counts what crosses into the arena for a change that used to re-send everything it touched.
RSpec.describe 'native arena upkeep' do
  let(:session) {
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><div id="h"></div>']] })
  }

  before { session.visit '/' }

  # Wraps the named `__dom` ops to total what they are handed — `units(args)` per call — around `code`.
  def crossed(ops, code, units: 'a => 1')
    session.evaluate_script(<<~JS)
      (() => {
        const d = __dom, saved = {}, units = #{units};
        let total = 0;
        for (const n of #{ops.to_json}) { saved[n] = d[n]; d[n] = (...a) => { total += units(a); return saved[n](...a); }; }
        try { #{code}; } finally { Object.assign(d, saved); }
        return total;
      })()
    JS
  end

  it 'sends a coalesced text only the chunks appended to it' do
    text = 'a ' * 10_000
    chars = crossed(%w[setData appendData createNode], "document.getElementById('h').innerHTML = '<pre>#{text}</pre>'",
                    units: 'a => typeof a[1] === "string" ? a[1].length : 0')
    expect(chars).to be <= 2 * text.length
    expect(chars).to be >= text.length
  end

  it 'sends appendData only what it appends' do
    chars = crossed(%w[setData appendData], "const t = document.createTextNode(''); for (let i = 0; i < 5000; i++) t.appendData('ab')",
                    units: 'a => a[1].length')
    expect(chars).to eq(10_000)
  end

  it 'applies a single append without relisting the parent' do
    listed = crossed(%w[syncChildren insertChild], <<~JS, units: 'a => Array.isArray(a[1]) ? a[1].length : 1')
      const ul = document.createElement('ul');
      for (let i = 0; i < 2000; i++) { ul.appendChild(document.createElement('li')); ul.appendChild(document.createTextNode(' ')); }
      document.getElementById('h').appendChild(ul);
    JS
    expect(listed).to be <= 4001
  end

  it 'holds character data exactly, a lone surrogate included' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = document.body.appendChild(document.createTextNode('a\\uD800b'));
        t.appendData('\\uDC00');
        return __dom.inspectNode(t._nid)[2] === 'a\\uD800b\\uDC00';
      })()
    JS
    expect(got).to be true
  end

  # A node registered afresh — moved into another realm's tree — frees the slot it leaves, however often it moves.
  it 'frees the slot a node leaves when it moves between realms' do
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.srcdoc = '<div id="home"><p id="mv"><b>x</b>t</p></div>';
      document.body.appendChild(f);
    JS
    session.within_frame(0) { session.find('#mv') }
    live = session.evaluate_script(<<~JS)
      (() => {
        const fd = document.querySelector('iframe').contentDocument, p = fd.getElementById('mv'), seen = [];
        for (let i = 0; i < 10; i++) {
          document.body.appendChild(p); seen.push([p._nidArena.dom, p._nid]);
          fd.getElementById('home').appendChild(p); seen.push([p._nidArena.dom, p._nid]);
        }
        seen.pop();   // where it is now
        return seen.filter(([d, nid]) => d.inspectNode(nid) !== null).length;
      })()
    JS
    expect(live).to eq(0)
  end
end
