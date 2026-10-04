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

  # A query answers from the arena, and its nodes are the objects their handles hold: the very ones a script holds — a
  # `<form>` and a document through their Proxies — whatever the query, wherever in the tree.
  it "hands a query's nodes back as the objects a script holds" do
    s = page('<form id=f><fieldset><input id=i></fieldset></form><div id=d></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const f = document.forms[0], i = document.getElementById('i');
        i.expando = 'kept';
        const one = (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return [
          document.querySelector('form') === f,
          document.querySelectorAll('form, input')[0] === f,
          i.closest('form') === f,
          one('//form') === f,
          one('/') === document,
          one('//input/@id').ownerElement === i,
          document.querySelector('#d ~ *, input').expando
        ];
      })()
    JS
    expect(got).to eq([true, true, true, true, true, true, 'kept'])
  end

  # The tree a node owns outside its children — a host's shadow root, a template's contents — is an edge of its handle,
  # and the owned tree's root has its owner for a parent: what the handle edges say, the arena says (verify mode's check,
  # asked here of each node directly), however the tree came to be owned — parsed, attached, given contents anew.
  it "links a shadow root and a template's contents to their owners' handles" do
    s = page('<template id=t><p>x</p></template><div id=h></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t'), h = document.getElementById('h');
        const sr = h.attachShadow({mode: 'open'});
        sr.innerHTML = '<b>s</b>';
        const made = document.createElement('template');
        made.innerHTML = '<i>m</i>';
        document.body.append(made);
        const nodes = [t, t.content, t.content.firstChild, h, sr, sr.firstChild, made, made.content, made.content.firstChild];
        return nodes.map((n) => __dom.handleEdgesMismatch(n._nid) ?? null);
      })()
    JS
    expect(got).to eq([nil] * 9)
  end

  # A `::before` is no node of its own: its box's slot belongs to its element, and goes with it.
  it "frees a generated box's slot with its element's" do
    s = page('<style>.g::before { content: "x" }</style><div id=g class=g>g</div>')
    s.execute_script(<<~JS)
      const g = document.getElementById('g');
      g.getBoundingClientRect();   // (…laid out: the box is made as it renders)
      window.__box = g._pseudoNodes.before._nid;
      window.__live = __dom.inspectNode(__box) != null;
      g.remove();
    JS
    s.evaluate_script('0')
    runtime = s.driver.browser.instance_variable_get(:@runtime)
    2.times { runtime.ctx.low_memory_notification }
    expect(s.evaluate_script('(document.createElement("i"), [__live, __dom.inspectNode(__box) == null])')).to eq([true, true])
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

  # Every realm makes a skeleton of its own: a frame's `<body>` moved into the document is named apart from the
  # document's own, which keeps its handle — across the move and back out.
  it "keeps the document's body named apart from a frame's body moved into it" do
    pages = {'/' => '<!DOCTYPE html><meta charset=utf-8><body><button id=b0>main</button><div id=out></div><iframe id=f src="/f"></iframe>',
             '/f' => '<!DOCTYPE html><meta charset=utf-8><body><p>frame text</p>'}
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
    s.visit '/'
    body = s.find(:css, 'body')
    s.execute_script("document.getElementById('out').appendChild(document.getElementById('f').contentWindow.document.body)")
    expect(body.all(:css, 'button').size).to eq(1)
    s.execute_script("document.getElementById('out').textContent = ''")
    expect(body.text).to eq('main')
  end
end
