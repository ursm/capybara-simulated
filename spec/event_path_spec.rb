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

  # stopPropagation() in a window listener stops the targets after the window, not the window's other listeners —
  # stopImmediatePropagation() does (DOM "inner invoke"). Chrome 155: "w1,w2 | a".
  it "runs a window's other listeners after one stops propagation" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><button id=b>x</button>']] })
    s.visit '/'
    expect(s.evaluate_script(<<~JS)).to eq('w1,w2 | a')
      (() => {
        const log = [], log2 = [];
        window.addEventListener('click', (e) => { log.push('w1'); e.stopPropagation(); }, true);
        window.addEventListener('click', () => log.push('w2'), true);
        document.addEventListener('click', () => log.push('d'), true);
        document.getElementById('b').click();
        window.addEventListener('foo', (e) => { log2.push('a'); e.stopImmediatePropagation(); }, true);
        window.addEventListener('foo', () => log2.push('b'), true);
        document.getElementById('b').dispatchEvent(new Event('foo', {bubbles: true}));
        return log.join(',') + ' | ' + log2.join(',');
      })()
    JS
  end

  # DOM dispatch as the standard has it (whatwg/dom 369654b7), where Chrome 155 and Firefox depart from it each its own
  # way: a target that is no node retargets the relatedTarget against itself, out of the shadow tree (Chrome keeps the
  # shadow root, Firefox nulls both); a dispatch whose target is its own retargeted relatedTarget invokes nothing and
  # sets no target, `clearTargets` false, the relatedTarget kept (Chrome likewise; Firefox nulls it).
  it 'retargets a flat target\'s relatedTarget, and sets no target where the dispatch is skipped' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const host = document.createElement('div');
        const shadow = host.attachShadow({mode: 'closed'});
        const nm = (x) => x === null ? 'null' : x === host ? 'host' : x === shadow ? 'shadow' : x === window ? 'window' : 'other';
        const out = [];
        for (const target of [new EventTarget(), window, host]) {
          let ran = false;
          target.addEventListener('demo', () => ran = true);
          const e = new FocusEvent('demo', {relatedTarget: shadow});
          target.dispatchEvent(e);
          out.push([ran, nm(e.target), nm(e.relatedTarget)].join(' '));
        }
        return out;
      })()
    JS
    expect(got).to eq(['true other host', 'true window host', 'false null shadow'])
  end

  # A click's activation target is found along the path it is dispatched on (DOM dispatch sets it only from the items
  # appended): none where the dispatch is skipped, nor past where the path is pruned. Chrome 155 likewise.
  it 'activates nothing a click skipped or pruned never reaches' do
    got = session.evaluate_script(<<~JS)
      (() => {
        document.body.innerHTML = '<a href="#jumped"><div id=h></div></a><label><div id=h2></div><input type=checkbox id=cb></label>';
        const sh = document.getElementById('h').attachShadow({mode: 'open'});
        sh.innerHTML = '<span id=in></span>';
        const sh2 = document.getElementById('h2').attachShadow({mode: 'open'});
        sh2.innerHTML = '<span id=in2></span>';
        const click = (target, init) => target.dispatchEvent(new MouseEvent('click', Object.assign({bubbles: true}, init)));
        click(document.getElementById('h'), {relatedTarget: sh.getElementById('in')});
        click(document.getElementById('h2'), {relatedTarget: sh2.getElementById('in2')});
        click(sh.getElementById('in'), {composed: true, relatedTarget: document.getElementById('h')});
        return [location.hash, document.getElementById('cb').checked];
      })()
    JS
    expect(got).to eq(['', false])
  end

  # composedPath() is the path the dispatch took, fixed as it began — a listener moving a node changes nothing of it.
  it "reads composedPath() off the dispatch's path, wherever a listener moved a node" do
    got = session.evaluate_script(<<~JS)
      (() => {
        document.body.innerHTML = '<section><div></div></section>';
        const div = document.querySelector('div');
        let seen;
        div.addEventListener('x', () => document.body.appendChild(div));
        div.addEventListener('x', (e) => { seen = e.composedPath().map((n) => n === window ? 'window' : n.nodeName).join(); });
        div.dispatchEvent(new Event('x', {bubbles: true}));
        return seen;
      })()
    JS
    expect(got).to eq('DIV,SECTION,BODY,HTML,#document,window')
  end

  # A relatedTarget in a shadow tree another realm made — whose hosts this realm, shadow-free, never counted — is
  # retargeted all the same: a listener, and the event after, see its host.
  it "retargets a relatedTarget in another realm's shadow tree" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe srcdoc="<div id=fh></div><script>document.getElementById(\'fh\').attachShadow({mode: \'open\'}).innerHTML = \'<i></i>\'</script>"></iframe>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const run = () => {
        const fdoc = frames[0].document;
        const fh = fdoc.getElementById('fh');
        let seen;
        document.body.addEventListener('x', (e) => { seen = e.relatedTarget === fh; });
        const e = new FocusEvent('x', {relatedTarget: fh.shadowRoot.firstChild});
        document.body.dispatchEvent(e);
        done([seen, e.relatedTarget === fh]);
      };
      frames[0].document.readyState === 'complete' && frames[0].document.getElementById('fh') ? run() : document.querySelector('iframe').onload = run;
    JS
    expect(got).to eq([true, true])
  end

  # A node slotted into a label inside a shadow tree is in that label as the click's path climbs — the flat tree's —
  # and clicking it clicks the label's control (HTML "click in a label"; Chrome 155 alike).
  it 'clicks the control of a label a clicked node is slotted into' do
    got = session.evaluate_script(<<~JS)
      (() => {
        document.body.innerHTML = '<div id=ih><span id=is>t</span></div>';
        document.getElementById('ih').attachShadow({mode: 'open'}).innerHTML = '<label><slot></slot><input type=checkbox id=ic></label>';
        document.getElementById('is').click();
        return document.getElementById('ih').shadowRoot.getElementById('ic').checked;
      })()
    JS
    expect(got).to be(true)
  end
end
