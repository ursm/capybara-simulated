# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The engine assigns slottables and signals slots where the tree and the attributes change (dom.rs `slot_steps`), and
# notifies mutation observers each in its turn (mutation-observer.js `deliverMutations`). Every expectation here is
# Chrome's (measured 2026-10-11).
RSpec.describe 'slot change signals and mutation observer turns' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=t></div>']] }) }

  # An observer's records are taken as its turn comes: one an earlier callback queued for it is its, and one an earlier
  # callback took the records of, or disconnected, is not called back (DOM "notify mutation observers" step 5).
  it 'takes each observer\'s records in its turn' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const t = document.getElementById('t'), log = [];
      let n = 0;
      const a = new MutationObserver((r) => { log.push('A' + r.length); if (n++ === 0) t.setAttribute('y', '1'); });
      const b = new MutationObserver((r) => { log.push('B' + r.map((x) => x.attributeName).join('+')); });
      const c = new MutationObserver((r) => { log.push('C' + r.length); });
      const d = new MutationObserver((r) => { log.push('D' + r.length); c.disconnect(); });
      for (const m of [a, b, c, d]) m.observe(t, {attributes: true});
      t.setAttribute('x', '1');
      setTimeout(() => {
        log.push('|');
        const e = new MutationObserver((r) => { log.push('E' + r.length); f.disconnect(); g.takeRecords(); });
        const f = new MutationObserver((r) => { log.push('F' + r.length); });
        const g = new MutationObserver((r) => { log.push('G' + r.length); });
        for (const m of [e, f, g]) m.observe(t, {attributes: true});
        t.setAttribute('z', '1');
        setTimeout(() => done(log), 0);
      }, 0);
    JS
    expect(got).to eq(%w[A1 Bx+y C2 D2 A1 | A1 Bz D1 E1])
  end

  # A clone's slots are assigned as its tree is built, and their slotchange is notified at the next checkpoint — not at
  # some later, unrelated one.
  it 'signals a cloned shadow tree\'s slots at the next checkpoint' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const log = [];
      const h = document.body.appendChild(document.createElement('div'));
      h.innerHTML = '<i>x</i>';
      h.attachShadow({mode: 'open', clonable: true}).innerHTML = '<slot></slot>';
      setTimeout(() => {
        const copy = document.importNode(h, true);
        const slot = copy.shadowRoot.firstChild;
        slot.addEventListener('slotchange', () => log.push('slotchange'));
        log.push('assigned ' + slot.assignedNodes().length);
        setTimeout(() => { log.push('later'); done(log); }, 0);
      }, 0);
    JS
    expect(got).to eq(['assigned 1', 'slotchange', 'later'])
  end

  # A slot showing its fallback content signals itself as its children change, and only itself: an enclosing slot
  # showing it sees the bubbled event (DOM insert step 7.5).
  it 'signals the slot whose fallback content changed, and no enclosing one' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const log = [];
      const t = document.getElementById('t');
      const sr = t.attachShadow({mode: 'open'});
      sr.innerHTML = '<slot id=outer name=nope><slot id=inner name=nope2>fb</slot></slot>';
      const outer = sr.getElementById('outer'), inner = sr.getElementById('inner');
      for (const s of [outer, inner]) s.addEventListener('slotchange', (e) => log.push(s.id + '@' + e.target.id));
      setTimeout(() => {
        inner.append('more');
        setTimeout(() => done(log), 0);
      }, 0);
    JS
    expect(got).to eq(['inner@inner', 'outer@inner'])
  end

  # A slottable's `slot` changed: the slot it left signals before the one that takes it.
  it 'signals the slot a slottable left before the one it moved to' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const log = [];
      const t = document.getElementById('t');
      const x = t.appendChild(document.createElement('span'));
      x.slot = 'd';
      const sr = t.attachShadow({mode: 'open'});
      sr.innerHTML = '<slot name=a></slot><slot name=d></slot>';
      for (const s of sr.querySelectorAll('slot')) s.addEventListener('slotchange', () => log.push(s.name));
      setTimeout(() => {
        log.length = 0;   // (…the first assignment's `d`)
        x.slot = 'a';
        setTimeout(() => done(log), 0);
      }, 0);
    JS
    expect(got).to eq(%w[d a])
  end

  # A host adopted into a frame's document is the frame's: the frame's tree writes assign its slots.
  it 'assigns the slots of a host adopted into a frame' do
    html = %(<!DOCTYPE html><meta charset=utf-8><iframe id=f srcdoc='<!DOCTYPE html><meta charset=utf-8><div id=d></div>'></iframe>)
    frame_session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    frame_session.visit '/'
    got = frame_session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.getElementById('f');
      const run = () => {
        const fd = f.contentDocument;
        const h = document.createElement('div');
        h.attachShadow({mode: 'open'}).innerHTML = '<slot></slot>';
        fd.getElementById('d').appendChild(h);
        const c = h.appendChild(fd.createElement('i'));
        done([h.shadowRoot.firstChild.assignedNodes().length, c.assignedSlot === h.shadowRoot.firstChild]);
      };
      if (f.contentDocument && f.contentDocument.getElementById('d')) run(); else f.onload = run;
    JS
    expect(got).to eq([1, true])
  end
end
