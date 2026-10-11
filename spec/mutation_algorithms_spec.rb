# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# DOM §4.2.3's mutation algorithms are one change of a parent's children (dom-nodes.js `changeChildren`), whose order
# these hold, each against headless Chrome: what replace all adopts after it removes, which steps a change that changes
# nothing runs, where an insertion's insertion steps and its scripts fall, and when a connected element upgrades.
RSpec.describe 'DOM mutation algorithms' do
  def run(body, script)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]] })
    s.visit '/'
    s.evaluate_script(script)
  end

  # "replace all" removes every child before its insertion adopts the node — one record, and the removed children
  # disconnected before the node connects. Chrome: ["+[b] -[a,b] prev=null next=null"], ["disc a", "disc b", "conn b"].
  it 'removes the children before replace all adopts the node' do
    got = run('<div id=p></div>', <<~JS)
      (() => {
        const log = [];
        customElements.define('x-r', class extends HTMLElement {
          connectedCallback() { log.push('conn ' + this.id); }
          disconnectedCallback() { log.push('disc ' + this.id); }
        });
        const p = document.getElementById('p');
        const a = p.appendChild(document.createElement('x-r')), b = p.appendChild(document.createElement('x-r'));
        a.id = 'a'; b.id = 'b';
        log.length = 0;
        const mo = new MutationObserver(() => {});
        mo.observe(p, { childList: true });
        p.replaceChildren(b);
        const ids = (list) => Array.from(list, (n) => n.id).join(',');
        const records = mo.takeRecords().map((r) => `+[${ids(r.addedNodes)}] -[${ids(r.removedNodes)}] prev=${r.previousSibling && r.previousSibling.id} next=${r.nextSibling && r.nextSibling.id}`);
        return [records, log];
      })()
    JS
    expect(got).to eq([['+[b] -[a,b] prev=null next=null'], ['disc a', 'disc b', 'conn b']])
  end

  # Replace all with nothing of an empty script changes nothing, and runs none of its children changed steps — a script
  # that was not prepared stays so (an external one would run on a later task). Chrome: false.
  it 'runs no children changed steps for a replace all that changes nothing' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const s = document.createElement('script');
      s.type = 'text/x';
      s.src = 'data:text/javascript,window.ran=true';
      document.body.appendChild(s);
      s.removeAttribute('type');
      s.replaceChildren();
      s.textContent = '';
    JS
    expect(s.evaluate_script('window.ran === true')).to be(false)
  end

  # An insertion's insertion steps — a details element's name group closing it — run before the scripts it inserts.
  # Chrome: false.
  it 'runs the insertion steps before an inserted script' do
    got = run('<details name=g open></details>', <<~JS)
      (() => {
        const f = document.createDocumentFragment();
        const d = f.appendChild(document.createElement('details'));
        d.name = 'g'; d.open = true; d.id = 'd1';
        f.appendChild(document.createElement('script')).text = 'window.seen = document.getElementById("d1").open';
        document.body.append(f);
        return window.seen;
      })()
    JS
    expect(got).to be(false)
  end

  # Connecting an element whose definition is there enqueues its upgrade (HTML "try to upgrade an element"), which runs
  # as the call returns — after the element it replaces is disconnected. Chrome: ["disc old", "ctor", "conn new"].
  it 'enqueues the upgrade of an element it connects' do
    got = run('<div id=p></div>', <<~JS)
      (() => {
        const log = [];
        customElements.define('x-e', class extends HTMLElement {
          constructor() { super(); log.push('ctor'); }
          connectedCallback() { log.push('conn ' + this.id); }
          disconnectedCallback() { log.push('disc ' + this.id); }
        });
        const p = document.getElementById('p');
        p.appendChild(document.createElement('x-e')).id = 'old';
        const fresh = document.implementation.createHTMLDocument('').createElement('x-e');
        fresh.id = 'new';
        log.length = 0;
        p.replaceChildren(fresh);
        return log;
      })()
    JS
    expect(got).to eq(['disc old', 'ctor', 'conn new'])
  end

  # A removal from a non-dirty textarea clamps its text entry cursor to the text left, which the insertion after it does
  # not restore: replacing its text leaves it at 0. Chrome: ["append:3,6", "remove:2,2", "replace:0,0", "data:1,2"].
  it "clamps a textarea's cursor where a replacement removes its text" do
    got = run('<textarea id=t>abcdefgh</textarea>', <<~JS)
      (() => {
        const t = document.getElementById('t'), out = [];
        const r = (label) => out.push(label + ':' + t.selectionStart + ',' + t.selectionEnd);
        t.setSelectionRange(3, 6); t.appendChild(document.createTextNode('XY')); r('append');
        t.setSelectionRange(3, 6); t.firstChild.remove(); r('remove');
        t.setSelectionRange(1, 2); t.replaceChild(document.createTextNode('qqqqqq'), t.firstChild); r('replace');
        t.setSelectionRange(1, 2); t.firstChild.data = 'zzzzzzzz'; r('data');
        return out;
      })()
    JS
    expect(got).to eq(%w[append:3,6 remove:2,2 replace:0,0 data:1,2])
  end

  # splitText inserts its new node as an insertion does: a connected script not yet started is prepared by it. Chrome: true.
  it "runs a script's children changed steps for the node splitText inserts" do
    got = run('<div id=p></div>', <<~JS)
      (() => {
        const s = document.createElement('script');
        s.type = 'text/x';
        s.appendChild(document.createTextNode('window.split = true;'));
        document.getElementById('p').appendChild(s);
        s.removeAttribute('type');
        s.firstChild.splitText(7);
        return window.split === true;
      })()
    JS
    expect(got).to be(true)
  end

  # A definition observes attributes by their code units: a name with a lone surrogate matches only itself. Chrome: [].
  it 'observes an attribute by its code units' do
    got = run('', <<~JS)
      (() => {
        const log = [];
        customElements.define('x-s', class extends HTMLElement {
          static get observedAttributes() { return ['\\uD800a']; }
          attributeChangedCallback(n) { log.push(n); }
        });
        document.createElement('x-s').setAttribute('\\uFFFDa', '1');
        return log;
      })()
    JS
    expect(got).to eq([])
  end

  # A fragment parse's custom elements are upgraded as it makes them (HTML "create an element" enqueues the upgrade), so
  # ahead of the children the setter removes: a disconnectedCallback sees the new element upgraded. Chrome:
  # ["ctor new", "conn new", "disc old new=true"].
  it "upgrades a fragment parse's elements before it disconnects the children it replaces" do
    got = run('<div id=p></div>', <<~JS)
      (() => {
        const log = [];
        class X extends HTMLElement {
          constructor() { super(); log.push('ctor ' + this.getAttribute('id')); }
          connectedCallback() { log.push('conn ' + this.id); }
          disconnectedCallback() { log.push('disc ' + this.id + ' new=' + (document.getElementById('new') instanceof X)); }
        }
        customElements.define('x-f', X);
        const p = document.getElementById('p');
        p.innerHTML = '<x-f id=old></x-f>';
        log.length = 0;
        p.innerHTML = '<x-f id=new></x-f>';
        return log;
      })()
    JS
    expect(got).to eq(['ctor new', 'conn new', 'disc old new=true'])
  end

  # insertAdjacentHTML inserts the fragment it parsed: one insertion, one record — and its custom elements upgraded
  # where the element is not connected. Chrome: [1, true].
  it 'inserts what insertAdjacentHTML parsed as one fragment' do
    got = run('<div id=p></div>', <<~JS)
      (() => {
        customElements.define('x-g', class extends HTMLElement {});
        const p = document.getElementById('p');
        const mo = new MutationObserver(() => {});
        mo.observe(p, { childList: true });
        p.insertAdjacentHTML('beforeend', '<i>a</i><b>b</b>');
        const detached = document.createElement('div');
        detached.insertAdjacentHTML('beforeend', '<x-g></x-g>');
        return [mo.takeRecords().length, detached.firstChild instanceof customElements.get('x-g')];
      })()
    JS
    expect(got).to eq([1, true])
  end
end
