require 'capybara/simulated'
require_relative 'support/session_teardown'

# MutationObserver and MutationRecord as their IDL makes them: an observer's options converted as a
# MutationObserverInit, its target a Node, an `attributeFilter` naming attributes of no namespace alone (DOM "queue a
# mutation record"), and a record's nodes a NodeList, the same one each time it is asked for.
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
end
