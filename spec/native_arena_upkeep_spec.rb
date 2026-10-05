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

  # The arena is the isolate's: a node moved into another realm's tree keeps its slot, however often it moves, and is
  # that realm's from then on — the realm it came from reloading its page frees nothing of it.
  it 'keeps a node in its slot as it moves between realms, and in the realm it joined' do
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.srcdoc = '<div id="home"><p id="mv"><b>x</b>t</p></div>';
      document.body.appendChild(f);
    JS
    session.within_frame(0) { session.find('#mv') }
    got = session.evaluate_script(<<~JS)
      (() => {
        const fd = document.querySelector('iframe').contentDocument, p = fd.getElementById('mv'), nids = new Set();
        for (let i = 0; i < 10; i++) {
          document.body.appendChild(p); nids.add(p._nid);
          fd.getElementById('home').appendChild(p); nids.add(p._nid);
        }
        document.body.appendChild(p);
        window.__mv = p;
        return [nids.size, nids.has(p._nid)];
      })()
    JS
    expect(got).to eq([1, true])
    session.execute_script("document.querySelector('iframe').srcdoc = '<p>reloaded</p>'")
    session.within_frame(0) { session.find('p', text: 'reloaded') }
    expect(session.evaluate_script("[__dom.inspectNode(__mv._nid) !== null, document.querySelector('#mv b') === __mv.firstChild]")).to eq([true, true])
    expect(session.find(:css, '#mv').text).to eq('xt')
  end
end
