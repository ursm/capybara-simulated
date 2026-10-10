require 'capybara/simulated'
require_relative 'support/session_teardown'

# MutationObserver and MutationRecord as their IDL makes them: an observer's options converted as a
# MutationObserverInit, its target a Node, an `attributeFilter` naming attributes of no namespace alone (DOM "queue a
# mutation record"), and a record's nodes a NodeList, the same one each time it is asked for; the observers a change
# interests as DOM tells them — a removed node's subtree observed until the next checkpoint (transient registered
# observers), the old value where any registration asks for it, none from a shadow tree — each handed a record of its own.
RSpec.describe 'MutationObserver bindings' do
  let(:app) { ->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><div id=d></div>']] } }
  let(:session) { simulated_session(app) }

  it 'converts, filters and hands over records as the IDL says' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], d = document.getElementById('d');
      const errs = [() => new MutationObserver({}), () => new MutationObserver(() => {}).observe(null, { childList: true }),
                    () => new MutationRecord()].map((f) => { try { f(); return 'ok'; } catch (e) { return e.name; } });
      const mo = new MutationObserver((records) => {
        const r = records[0];
        done([errs, records.map((x) => [x.type, x.attributeName]), r.addedNodes instanceof NodeList, r.addedNodes === r.addedNodes,
              Object.hasOwn(r, 'type'), r instanceof MutationRecord]);
      });
      mo.observe(d, { attributeFilter: ['a'] });
      d.setAttributeNS('urn:x', 'a', '1');
      d.setAttributeNS(null, 'a', '2');
    JS
    expect(got).to eq([
      ['TypeError', 'TypeError', 'TypeError'],
      [['attributes', 'a']],
      true, true, false, true
    ])
  end

  # (…a doctype `createDocument` takes appended to the new document as any node is: removed from its old one first, its
  # observers told)
  it "tells the old document's observers of a doctype createDocument takes" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], dt = document.implementation.createDocumentType('x', '', '');
      const holder = document.implementation.createHTMLDocument('');
      holder.replaceChild(dt, holder.doctype);
      new MutationObserver((records) => done([records.length, records[0].removedNodes[0] === dt, dt.ownerDocument === made, made.doctype === dt]))
        .observe(holder, { childList: true });
      const made = document.implementation.createDocument(null, 'r', dt);
    JS
    expect(got).to eq([1, true, true, true])
  end

  # Chrome and Firefox 2026-10-10: the same four answers, but for `same`, false in Firefox — and in DOM, which makes "a
  # new MutationRecord" for each observer (Chrome shares one).
  it 'tells the observers a change interests as DOM says' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      document.body.insertAdjacentHTML('beforeend', '<div id=p><div id=c><span id=g></span></div></div><div id=host></div>');
      const c = document.getElementById('c'), g = document.getElementById('g'), host = document.getElementById('host');
      const removed = [], merged = [], shared = [], shadow = [];
      new MutationObserver((rs) => rs.forEach((r) => removed.push(`${r.target.id}:${r.attributeName}`)))
        .observe(p, { subtree: true, attributes: true });
      p.removeChild(c);
      c.setAttribute('a', '1');
      g.setAttribute('b', '1');
      const mo = new MutationObserver((rs) => rs.forEach((r) => merged.push(r.oldValue)));
      mo.observe(document.body, { subtree: true, attributes: true });
      mo.observe(host, { attributes: true, attributeOldValue: true });
      host.setAttribute('x', 'old');
      host.setAttribute('x', 'new');
      for (let i = 0; i < 2; i++) new MutationObserver((rs) => shared.push(rs[0])).observe(host, { attributes: true });
      host.setAttribute('y', '1');
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = '<b></b>';
      new MutationObserver((rs) => shadow.push(rs.length)).observe(document, { subtree: true, attributes: true, attributeFilter: ['z'] });
      sr.firstChild.setAttribute('z', '1');
      setTimeout(() => {
        c.setAttribute('late', '1');
        setTimeout(() => done([removed, merged, shared.length, shared[0] === shared[1], shadow]), 0);
      }, 0);
    JS
    expect(got).to eq([['c:a', 'g:b'], [nil, 'old', nil], 2, false, []])
  end

  # (…an observer's records are its own realm's to queue, whichever realm's script made the change: Chrome
  # 2026-10-10, `a:fs.x` / `c:fs` and `a:q.x`)
  it 'tells an observer of another realm of the changes this one makes' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], seen = [];
      const f = document.createElement('iframe');
      f.srcdoc = '<p id=fs></p>';
      f.onload = () => {
        const w = f.contentWindow, fs = w.document.getElementById('fs');
        new MutationObserver((rs) => rs.forEach((r) => seen.push(`main ${r.type} ${r.target.id || r.target.nodeName}`)))
          .observe(fs, { attributes: true, childList: true });
        new w.MutationObserver((rs) => rs.forEach((r) => seen.push(`frame ${r.type} ${r.target.id}`)))
          .observe(document.getElementById('d'), { attributes: true });
        fs.setAttribute('x', '1');
        fs.append(document.createElement('b'));
        w.eval("parent.document.getElementById('d').setAttribute('x', '1')");
        setTimeout(() => done(seen.sort()), 0);
      };
      document.body.append(f);
    JS
    expect(got).to eq(['frame attributes d', 'main attributes fs', 'main childList fs'])
  end
end
