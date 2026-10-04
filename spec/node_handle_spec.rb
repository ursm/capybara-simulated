# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A node's object is a wrapper of a handle on V8's C++ heap (node_handle.rs): when V8 collects the object it collects the
# handle, and the node's arena slot is freed — at the next node the page makes. That holds for a subtree a script builds
# detached and drops, whichever way it built it: one whose children came by `appendChild` was kept alive by the handle
# table Ruby names nodes by, which registered every inserted node, in a document or not. That table now holds what is in
# the document, shadow trees included — a shadow root attached while its host was detached (a custom element's
# constructor) is reachable from Ruby, and one removed with its host lets the host go — and its ids are each realm's own.
RSpec.describe 'node handles' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><p id=keep>k</p>']] } }

  it 'frees the slots of nodes V8 collected, and keeps those of nodes a page holds' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.__nids = {};
      const make = {
        text:     () => document.createTextNode('x'),
        element:  () => document.createElement('div'),
        appended: () => { const e = document.createElement('div'); e.appendChild(document.createElement('b')); return e; },
        fragment: () => { const f = document.createDocumentFragment(); f.appendChild(document.createTextNode('x')); return f; },
      };
      for (const kind in make) {
        __nids[kind] = [];
        for (let i = 0; i < 500; i++) { const n = make[kind](); if (i % 50 === 0) __nids[kind].push(n._nid); }
      }
      window.__kept = document.getElementById('keep');
    JS
    s.evaluate_script('0')   # (…the script's task over: what it left for the settle is let go)
    runtime = s.driver.browser.instance_variable_get(:@runtime)
    2.times { runtime.ctx.low_memory_notification }
    got = s.evaluate_script(<<~JS)
      (() => {
        document.createElement('span');   // (…which frees what was collected)
        const freed = {};
        for (const kind in __nids) freed[kind] = __nids[kind].filter((nid) => __dom.inspectNode(nid) == null).length;
        return [freed, __dom.inspectNode(__kept._nid) != null];
      })()
    JS
    expect(got).to eq([{'text' => 10, 'element' => 10, 'appended' => 10, 'fragment' => 10}, true])
  end

  def page(html)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{html}"]] })
    s.visit '/'
    s
  end

  it 'reaches into a shadow tree its host was given before it was in the document' do
    s = page(<<~HTML)
      <div id=out></div>
      <script>
        customElements.define('my-el', class extends HTMLElement {
          constructor() { super(); this.attachShadow({mode: 'open'}).innerHTML = '<button id=inner>Hi</button>'; }
        });
        document.body.appendChild(document.createElement('my-el'));
        const h = document.createElement('div'); h.id = 'h';
        const b = h.attachShadow({mode: 'open'}).appendChild(document.createElement('button'));
        b.textContent = 'Go';
        b.onclick = () => { document.getElementById('out').textContent = 'clicked'; };
        document.body.appendChild(h);
      </script>
    HTML
    expect(s.find(:css, 'my-el').shadow_root.find(:css, '#inner').text).to eq('Hi')
    s.evaluate_script("document.getElementById('h').shadowRoot.querySelector('button')").click
    expect(s.find(:css, '#out').text).to eq('clicked')
    # (…and the focused element in one is its host, as `document.activeElement` is in Chrome)
    s.execute_script("document.getElementById('h').shadowRoot.querySelector('button').focus()")
    expect(s.active_element[:id]).to eq('h')
  end

  it 'lets a removed shadow host go with its shadow tree' do
    s = page('<div id=h></div>')
    s.execute_script(<<~JS)
      const h = document.getElementById('h');
      h.attachShadow({mode: 'open'}).innerHTML = '<p>shadow</p>';
      window.__nid = h._nid;
      h.remove();
    JS
    s.evaluate_script('0')
    runtime = s.driver.browser.instance_variable_get(:@runtime)
    2.times { runtime.ctx.low_memory_notification }
    expect(s.evaluate_script('(document.createElement("i"), __dom.inspectNode(__nid) == null)')).to be(true)
  end

  it "names a node a frame made, adopted into the document, apart from the document's own" do
    s = page('<button id=before>before</button><iframe></iframe>')
    before = s.find(:css, '#before')
    s.execute_script(<<~JS)
      const frameDoc = document.querySelector('iframe').contentDocument;
      for (let i = 0; i < 200; i++) {
        const x = frameDoc.createElement('span');
        x.id = 'adopted' + i;
        x.style.display = 'none';
        document.body.appendChild(x);
      }
    JS
    expect([before[:id], before.visible?]).to eq(['before', true])
  end
end
