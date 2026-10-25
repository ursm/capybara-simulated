require 'capybara/simulated'
require_relative 'support/session_teardown'

# Range's tree-building members as DOM and DOM Parsing say. createContextualFragment parses in the context of its start
# node — a Text's parent element (a `<table>`'s text: `<tr>` makes a tbody, Chrome 155 and Firefox `TBODY`), an HTML
# document's `html` element as a body, an XML document's by the XML parser. surroundContents empties its new parent by "replace all with null within
# newParent": ONE mutation record of both children — where Chrome 155 and Firefox both record each removal (2 records);
# the spec's step is explicit.
RSpec.describe 'Range fragments' do
  it 'parses in the start node’s context and empties the new parent at once' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.body.appendChild(document.createElement('table'));
        const r = document.createRange();
        r.setStart(t.appendChild(document.createTextNode('a')), 0);
        const inTable = r.createContextualFragment('<tr><td>x</td></tr>').firstChild.nodeName;
        const r2 = document.createRange();
        r2.setStart(document.documentElement, 0);
        const inRoot = r2.createContextualFragment('<p>y</p>').firstChild.nodeName;
        const p = document.body.appendChild(document.createElement('p'));
        p.append('a', 'b');
        const mo = new MutationObserver(() => {});
        mo.observe(p, {childList: true});
        const r3 = document.createRange();
        r3.selectNodeContents(document.body.appendChild(document.createElement('i')));
        r3.surroundContents(p);
        return [inTable, inRoot, mo.takeRecords().map((x) => x.removedNodes.length)];
      })()
    JS
    expect(got).to eq(['TBODY', 'P', [2]])
  end

  # …and in an XML document by the XML fragment parsing algorithm (Chrome): a `<p>` of the root's default namespace, not
  # wrapped as an HTML `html`'s would be; markup that is not well-formed a SyntaxError.
  it 'parses an XML document’s by the XML parser' do
    xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><div id="d"/></body></html>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'application/xhtml+xml'}, [xhtml]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      [[document.documentElement, '<p>x</p>'], [document.getElementById('d'), '<p>x'], [document.getElementById('d'), '<svg/>']].map(([node, markup]) => {
        const r = document.createRange();
        r.selectNodeContents(node);
        try { return [...r.createContextualFragment(markup).childNodes].map((n) => `${n.nodeName} ${n.namespaceURI}`); } catch (e) { return e.name; }
      })
    JS
    expect(got).to eq([['p http://www.w3.org/1999/xhtml'], 'SyntaxError', ['svg http://www.w3.org/1999/xhtml']])
  end
end
