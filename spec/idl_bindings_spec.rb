# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The bindings generated from the interfaces' Web IDL (script/gen_bindings.mjs): what IDL says of an interface — its
# interface object, the brand check of `this`, its argument counts and conversions, its constants — rather than what any
# one interface does. Every expectation is Chrome's (154.0.8037.92).
RSpec.describe 'IDL bindings' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=a class=x><b></b></div>']] }) }

  before { session.visit '/' }

  def outcome(js)
    session.evaluate_script(<<~JS)
      (() => {
        try { return #{js}; } catch (e) { return e.constructor.name + ': ' + e.message; }
      })()
    JS
  end

  it 'makes an interface object only the platform constructs' do
    expect(outcome('new DOMTokenList()')).to eq("TypeError: Failed to construct 'DOMTokenList': Illegal constructor")
    expect(outcome('new TreeWalker()')).to eq("TypeError: Failed to construct 'TreeWalker': Illegal constructor")
    expect(outcome('[DOMTokenList.length, TreeWalker.length, NodeIterator.length]')).to eq([0, 0, 0])
  end

  it "checks an operation's and an attribute's `this`" do
    expect(outcome('DOMTokenList.prototype.contains.call({}, "x")')).to start_with('TypeError: ')
    expect(outcome('TreeWalker.prototype.nextNode.call({})')).to start_with('TypeError: ')
    expect(outcome('Object.getOwnPropertyDescriptor(NodeIterator.prototype, "root").get.call({})')).to start_with('TypeError: ')
  end

  # (…before it counts the arguments, as Web IDL orders it — and an object that inherits from one is no object of the
  # interface)
  it "checks `this` first, and only the object's own" do
    expect(outcome('DOMTokenList.prototype.contains.call({})')).to eq('TypeError: Illegal invocation')
    expect(outcome('Object.create(document.getElementById("a").classList).length')).to start_with('TypeError: ')
  end

  # Web IDL §3.9: a legacy platform object with an indexed getter and no setter refuses to define, set or (while
  # supported) delete an array index property, and to be made non-extensible. Chrome reports `Reflect.set` and
  # `Reflect.defineProperty` of an index as done (true) where the spec returns false; it sets nothing either way.
  it "keeps a legacy platform object's indices the getter's" do
    got = outcome(<<~JS)
      (() => {
        const l = document.getElementById('a').classList;
        l[5] = 'q';
        const strict = (() => { 'use strict'; try { l[0] = 'q'; return 'set'; } catch (e) { return e.constructor.name; } })();
        return [
          Object.keys(l), l[0], strict, Reflect.set(l, '5', 'q'), Reflect.defineProperty(l, '0', {value: 'zz'}),
          Reflect.deleteProperty(l, '0'), Reflect.deleteProperty(l, '9'), Reflect.preventExtensions(l),
          Reflect.defineProperty(l, 'foo', {value: 1}) && l.foo
        ];
      })()
    JS
    expect(got).to eq([['0'], 'x', 'TypeError', false, false, false, true, false, 1])
  end

  it 'gives an operation the length of its required arguments, and takes an optional undefined as not passed' do
    expect(outcome('[DOMTokenList.prototype.toggle.length, DOMTokenList.prototype.add.length, DOMTokenList.prototype.replace.length]')).to eq([1, 0, 2])
    expect(outcome('(() => { const l = document.getElementById("a").classList; return [l.toggle("x", undefined), l.value]; })()')).to eq([false, ''])
    expect(outcome('document.getElementById("a").classList.contains()')).to eq("TypeError: Failed to execute 'contains' on 'DOMTokenList': 1 argument required, but only 0 present.")
  end

  it 'makes the members enumerable and the class string a data property' do
    expect(outcome('Object.keys(DOMTokenList.prototype).includes("toggle") && Object.keys(TreeWalker.prototype).includes("currentNode")')).to be(true)
    expect(outcome('typeof Object.getOwnPropertyDescriptor(TreeWalker.prototype, Symbol.toStringTag).value')).to eq('string')
    expect(outcome('Object.prototype.toString.call(document.createNodeIterator(document))')).to eq('[object NodeIterator]')
  end

  it "converts to an interface type, and to a callback interface's object" do
    expect(outcome('(() => { const w = document.createTreeWalker(document.body); w.currentNode = {}; })()')).to eq("TypeError: Failed to set the 'currentNode' property on 'TreeWalker': Failed to convert value to 'Node'.")
    expect(outcome('document.createTreeWalker(document.body, -1, 5)')).to eq("TypeError: Failed to execute 'createTreeWalker' on 'Document': parameter 3 is not of type 'Object'.")
    expect(outcome('document.createTreeWalker()')).to eq("TypeError: Failed to execute 'createTreeWalker' on 'Document': 1 argument required, but only 0 present.")
    expect(outcome('document.createTreeWalker(document.body) instanceof TreeWalker')).to be(true)
  end

  # An interface whose objects a hand-written class makes has its members generated onto that class's prototype —
  # CharacterData, Text and Comment, with the ChildNode / NonDocumentTypeChildNode / Slottable mixins they include.
  it "installs an interface's members on the class that makes its objects" do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.message; } };
        return [
          Object.getOwnPropertyDescriptor(CharacterData.prototype, 'appendData').enumerable,
          Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data').enumerable,
          thrown(() => Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data').get.call(document.body)),
          thrown(() => Text.prototype.splitText.call(document.createComment('ab'), 1)),
          [CharacterData.length, Text.length, Comment.length, CharacterData.prototype.substringData.length, CharacterData.prototype.before.length],
          Object.keys(CharacterData.prototype[Symbol.unscopables]).sort(),
          Object.getPrototypeOf(CharacterData.prototype[Symbol.unscopables])
        ];
      })()
    JS
    expect(got).to eq([true, true, 'Illegal invocation', 'Illegal invocation', [0, 0, 0, 2, 0], %w[after before remove replaceWith], nil])
  end

  # (…and only an interface that includes a mixin has its members: a Document is no ChildNode)
  it "puts a mixin's members on the interfaces that include it alone" do
    got = outcome(<<~JS)
      (() => {
        const dt = document.implementation.createDocumentType('html', 'p', 's');
        return [
          'before' in document, 'previousElementSibling' in document, 'remove' in document.createDocumentFragment(),
          'append' in document.createTextNode(''), 'innerHTML' in document.createDocumentFragment(),
          'remove' in dt, 'before' in document.body, ['name', 'publicId', 'systemId'].some((k) => Object.hasOwn(dt, k)),
          [dt.name, dt.publicId, dt.systemId]
        ];
      })()
    JS
    expect(got).to eq([false, false, false, false, false, true, true, false, %w[html p s]])
  end

  # (…what tells an installed interface's objects apart is the node itself — its own type, fixed when it was made — not
  # what it inherits; and an interface with no constructor of its own makes none for a script)
  it "checks an installed member's `this` by the node's own fixed type, and constructs only what IDL lets a script" do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.message; } };
        const x = document.createTextNode('z');
        x.nodeType = 1;
        const p = document.createElement('p');
        p.append(Object.create(document.createElement('b')));
        const xml = document.implementation.createDocument(null, 'r', null);
        const cdata = xml.documentElement.appendChild(xml.createCDATASection('ab'));
        return [
          [x.nodeType, x.data],
          thrown(() => Object.create(document.createTextNode('abc')).data),
          p.firstChild.nodeName,
          thrown(() => new CharacterData('x')), thrown(() => new DocumentType('x')),
          thrown(() => new ProcessingInstruction('x', 'y')), thrown(() => new CDATASection('x')),
          Object.prototype.toString.call(cdata), Object.prototype.toString.call(cdata.splitText(1)),
          xml.createProcessingInstruction('x', 'y').sheet
        ];
      })()
    JS
    expect(got).to eq([
      [3, 'z'], 'Illegal invocation', '#text',
      "Failed to construct 'CharacterData': Illegal constructor", "Failed to construct 'DocumentType': Illegal constructor",
      "Failed to construct 'ProcessingInstruction': Illegal constructor", "Failed to construct 'CDATASection': Illegal constructor",
      '[object CDATASection]', '[object CDATASection]', nil
    ])
  end

  # (…`nodeType` is Node.prototype's accessor, as IDL has it — so a form's named control overrides it, the form's own
  # steps reading the node's type it was made with)
  it "keeps a node's type out of a script's reach, and a form's named control above it" do
    got = outcome(<<~JS)
      (() => {
        const form = document.body.appendChild(document.createElement('form'));
        const input = form.appendChild(document.createElement('input'));
        input.name = 'nodeType';
        form.appendChild(document.createElement('b'));
        return [
          Object.hasOwn(document.body, 'nodeType'), typeof Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get,
          form.nodeType === input, form.children.length, form.contains(input)
        ];
      })()
    JS
    expect(got).to eq([false, 'function', true, 2, true])
  end

  it 'marks only the [Unscopable] members of each interface' do
    got = outcome('[Document, DocumentFragment, Element].map((i) => Object.keys(i.prototype[Symbol.unscopables]).sort())')
    expect(got).to eq([
      %w[append prepend replaceChildren],
      %w[append prepend replaceChildren],
      %w[after append before prepend remove replaceChildren replaceWith slot]
    ])
  end

  it "converts an installed member's arguments as IDL says" do
    got = outcome(<<~JS)
      (() => {
        const p = document.createElement('p');
        const t = p.appendChild(document.createTextNode('t'));
        t.before('s', document.createComment('c'));
        const n = document.createTextNode('a');
        n.data = null;
        let few;
        try { n.substringData(1); } catch (e) { few = e.message; }
        return [[...p.childNodes].map((c) => c.nodeName + ':' + c.data), n.data, few];
      })()
    JS
    expect(got).to eq([['#text:s', '#comment:c', '#text:t'], '', "Failed to execute 'substringData' on 'CharacterData': 2 arguments required, but only 1 present."])
  end

  it "makes a callback interface's object a function with its constants but no constructor" do
    expect(outcome('[typeof NodeFilter, "prototype" in NodeFilter, NodeFilter.name, NodeFilter.length]')).to eq(['function', false, 'NodeFilter', 0])
    expect(outcome('new NodeFilter()')).to eq('TypeError: NodeFilter is not a constructor')
    expect(outcome('NodeFilter()')).to eq('TypeError: Illegal constructor')
    expect(outcome('(() => { const d = Object.getOwnPropertyDescriptor(NodeFilter, "SHOW_ALL"); return [d.value, d.writable, d.enumerable, d.configurable]; })()')).to eq([4_294_967_295, false, true, false])
  end

  # Web IDL "call a user object's operation": a callable filter is called with no `this`, any other object's
  # `acceptNode` got afresh for each node, and called on it; the result is an `unsigned short`.
  it "calls a callback interface's operation on a user object" do
    got = outcome(<<~JS)
      (() => {
        let self = 'unset';
        document.createTreeWalker(document.body, -1, function () { 'use strict'; self = this; return 1; }).firstChild();
        let gets = 0;
        const w = document.createTreeWalker(document.body, -1, { get acceptNode() { gets++; return () => 1; } });
        w.nextNode(); w.nextNode();
        const wrapped = document.createTreeWalker(document.body, -1, () => 0x10001).firstChild();
        return [self === undefined, gets, wrapped && wrapped.id];
      })()
    JS
    expect(got).to eq([true, 2, 'a'])
  end
end
