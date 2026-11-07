# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What the bindings keep of an object is no property a page can see: a browser's platform object has no own property
# (`JSON.stringify(new Text('a'))` is `{}`), and its interface object and prototype hold the IDL members alone. A node's
# identity — its type, its arena slot, the object a script holds of it, an element's name and attribute store — is
# private fields (node-identity.js), and so is what a page's change of a prototype cannot reach.
RSpec.describe 'internal members' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><form id=f></form><select id=s></select><iframe id=fr srcdoc="<p>x"></iframe>']] }) }

  before { session.visit '/' }

  def outcome(js)
    session.evaluate_script(<<~JS)
      (() => {
        try { return #{js}; } catch (e) { return e.constructor.name + ': ' + e.message; }
      })()
    JS
  end

  it 'gives a node no own property' do
    expect(outcome("JSON.stringify(new Text('a'))")).to eq('{}')
    expect(outcome("[new Text('a'), new Comment('a'), new DocumentFragment(), document.createElement('div'), document.createAttribute('a')].map((n) => Object.getOwnPropertyNames(n).length)")).to eq([0, 0, 0, 0, 0])
    expect(outcome("Object.getOwnPropertyNames(document.getElementById('f')).concat(Object.getOwnPropertyNames(document.getElementById('s')))")).to eq([])
    expect(outcome("(() => { const keys = []; for (const k in document.createElement('p')) if (k[0] === '_') keys.push(k); return keys; })()")).to eq([])
  end

  # (…its type the one its constructor gave it, whatever prototype `new.target` hands it — Chrome's and Firefox's)
  it "keeps a node's type and name its constructor's" do
    expect(outcome("(() => { const x = Reflect.construct(Text, ['x'], Comment); return [x.nodeType, x.nodeName]; })()")).to eq([3, '#text'])
    expect(outcome("(() => { const x = Reflect.construct(Text, ['x'], CDATASection); return [x.nodeType, x.nodeName]; })()")).to eq([3, '#text'])
    expect(outcome("(() => { const x = Reflect.construct(Text, ['x'], Object); return Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get.call(x); })()")).to eq(3)
    expect(outcome("(() => { const x = Reflect.construct(Text, ['x'], Attr); document.body.appendChild(x); return [x.nodeName, document.body.lastChild === x]; })()")).to eq(['#text', true])
  end

  # `instanceof` an element interface is ECMAScript's own, by the prototype chain an element is born with (Chrome's and
  # Firefox's, 2026-11-07): an object inheriting from an element is an instance, an element given another interface's
  # prototype is that one's alone, and another realm's element is none of this realm's.
  it 'answers instanceof by the prototype chain' do
    expect(outcome("(() => { const o = Object.create(document.createElement('div')); return [o instanceof HTMLDivElement, o instanceof HTMLElement, o instanceof Element]; })()")).to eq([true, true, true])
    expect(outcome("(() => { const s = document.createElement('span'); Object.setPrototypeOf(s, HTMLDivElement.prototype); return [s instanceof HTMLSpanElement, s instanceof HTMLDivElement]; })()")).to eq([false, true])
    expect(outcome("(() => { const b = document.getElementById('fr').contentDocument.body; return [b instanceof HTMLElement, b instanceof Element, b instanceof Node]; })()")).to eq([false, false, false])
  end

  # (…a tree accessor's `this` the engine checks, from the node's handle: what is no node's object, a number too — which
  # the engine is otherwise handed the realm's document's slot as — is a TypeError)
  it "refuses Node's tree accessors what is no node" do
    expect(outcome(<<~JS)).to eq(['TypeError'] * 5 + ['html', 'null'])
      (() => {
        const get = (name) => Object.getOwnPropertyDescriptor(Node.prototype, name).get;
        const of = (name, self) => { try { const v = get(name).call(self); return v === null ? 'null' : v.nodeName; } catch (e) { return e.constructor.name; } };
        return [of('firstChild', 5), of('parentNode', 0), of('textContent', 1), of('nextSibling', {}), of('firstChild', Object.create(document.body)),
          of('firstChild', document), of('parentNode', document)];
      })()
    JS
  end

  # (…and an object inheriting from a node is no EventTarget: its members' `this` is checked, Web IDL's TypeError)
  it "refuses EventTarget's members an object inheriting from a node" do
    expect(outcome("Object.create(document.body).dispatchEvent(new Event('x'))")).to eq('TypeError: Illegal invocation')
    expect(outcome("Object.create(document.body).addEventListener('x', () => {})")).to eq('TypeError: Illegal invocation')
  end

  # The bindings reach none of their own steps through a prototype a page can change: a page's member of a form's
  # interface is overridden by the control it names ([LegacyOverrideBuiltIns]), whatever its name — the driver's own
  # `_`-prefixed members took precedence over such a control until they were functions — and a legacy factory's element
  # is made with its prototype's chain cut (Chrome's and Firefox's, 2026-11-08: `['control', true, 'x.mp3', 'auto']`).
  it "reaches none of its own steps through a prototype" do
    expect(outcome(<<~JS)).to eq(['control', true, 'x.mp3', 'auto'])
      (() => {
        const r = [];
        const f = document.getElementById('f'), i = document.createElement('input');
        i.name = '_x';
        f.append(i);
        HTMLFormElement.prototype._x = 'proto';
        r.push(f._x === i ? 'control' : String(f._x));
        Object.setPrototypeOf(HTMLAudioElement.prototype, null);
        const a = new Audio('x.mp3');
        r.push(Object.getPrototypeOf(a) === HTMLAudioElement.prototype, Element.prototype.getAttribute.call(a, 'src'), Element.prototype.getAttribute.call(a, 'preload'));
        return r;
      })()
    JS
  end

  # A custom element "create an element" constructs synchronously has the prefix it was created with — its arena node's
  # too, which its serialization, clone and namespace lookup read.
  it "gives a custom element constructed synchronously its prefix" do
    expect(outcome(<<~JS)).to eq(['p', 'P:X-FOO', 'p', '<p:x-foo xmlns:p="http://www.w3.org/1999/xhtml"></p:x-foo>', 'p', 'q', 'q'])
      (() => {
        customElements.define('x-foo', class extends HTMLElement {});
        const e = document.createElementNS('http://www.w3.org/1999/xhtml', 'p:x-foo');
        customElements.define('q-form', class extends HTMLFormElement {}, { extends: 'form' });
        const f = document.createElementNS('http://www.w3.org/1999/xhtml', 'q:form', { is: 'q-form' });
        return [e.prefix, e.tagName, e.lookupPrefix('http://www.w3.org/1999/xhtml'), new XMLSerializer().serializeToString(e),
          e.cloneNode().prefix, f.prefix, f.cloneNode().prefix];
      })()
    JS
  end

  # Every `_` name a page can see — on an interface object, its prototype, or an instance made here (own, for…in or
  # JSON: support/internal_names_probe.js) — and every brand keyed by a symbol of the agent's registry, which a page can
  # make and forge (`@csim:Name` for `Symbol.for('csim.Name')`), is one of these: the campaign's worklist, which only
  # shrinks. A name that is no longer visible comes off it, as an allowlisted WPT subtest that starts passing does.
  let(:still_visible) {
    %w[
      @csim:EventTarget
    ]
  }

  it 'shows a page no internal name but the ones still to go' do
    found = session.evaluate_script(File.read(File.join(__dir__, 'support', 'internal_names_probe.js')))
    names = found.map {|entry| entry.split(/[ .]/).last }.uniq.sort
    newly = names - still_visible
    expect(newly).to eq([]), "newly visible: #{found.select {|entry| newly.include?(entry.split(/[ .]/).last) }.first(20)}"
    expect(still_visible - names).to eq([])
  end
end
