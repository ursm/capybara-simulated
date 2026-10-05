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

  # Node itself is installed: its members on Node.prototype as IDL has them (a kind's own steps answering where it
  # differs — a Document's ownerDocument, a shadow root's parentNode), its constants read-only, a dictionary converted.
  it "installs Node's members, constants and dictionary" do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.message; } };
        const host = document.body.appendChild(document.createElement('div'));
        const sr = host.attachShadow({mode: 'open'});
        const b = sr.appendChild(document.createElement('b'));
        const constant = Object.getOwnPropertyDescriptor(Node.prototype, 'ELEMENT_NODE');
        const attr = document.createAttribute('x');
        attr.nodeValue = null;
        return [
          thrown(() => Node.prototype.appendChild.call({}, b)),
          thrown(() => document.body.appendChild(5)),
          thrown(() => document.body.getRootNode(5)),
          [constant.value, constant.writable, constant.enumerable, constant.configurable],
          Object.getOwnPropertyDescriptor(Node.prototype, 'appendChild').enumerable,
          [Node.prototype.cloneNode.length, Node.prototype.insertBefore.length],
          [b.getRootNode() === sr, b.getRootNode({composed: true}) === document],
          [sr.parentNode, document.ownerDocument, attr.value]
        ];
      })()
    JS
    expect(got).to eq([
      'Illegal invocation',
      "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
      "Failed to execute 'getRootNode' on 'Node': The provided value is not of type 'GetRootNodeOptions'.",
      [1, false, true, false], true, [0, 2], [true, true], [nil, nil, '']
    ])
  end

  # (…and the driver's own steps call Node's internally, not the members a page sees: a form control named after one
  # shadows it on the form, and a page's replacement of one is the page's)
  it "runs Node's steps whatever a form's controls are named, and converts as Chrome says" do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.message; } };
        const f = document.body.appendChild(document.createElement('form'));
        f.innerHTML = '<input name=insertBefore><input name=appendChild><input name=contains><b id=x></b>';
        const x = f.querySelector('#x');
        x.before(document.createElement('i'));
        f.append('t');
        return [
          x.previousSibling.nodeName, f.lastChild.nodeName,
          thrown(() => document.importNode()), thrown(() => document.importNode({})), thrown(() => document.importNode(document)),
          thrown(() => { document.createElement('p').textContent = Symbol(); })
        ];
      })()
    JS
    expect(got).to eq([
      'I', '#text',
      "Failed to execute 'importNode' on 'Document': 1 argument required, but only 0 present.",
      "Failed to execute 'importNode' on 'Document': parameter 1 is not of type 'Node'.",
      "Failed to execute 'importNode' on 'Document': The node provided is a document, which may not be imported.",
      "Failed to set the 'textContent' property on 'Node': Cannot convert a Symbol value to a string"
    ])
  end

  # (…a clone's shadow tree upgraded as the clone is: once for a clone, never for an import into an inert document)
  it 'upgrades a cloned shadow tree with the clone' do
    got = outcome(<<~JS)
      (() => {
        let n = 0;
        customElements.define('x-counted', class extends HTMLElement { constructor() { super(); n++; } });
        const host = document.createElement('div');
        host.attachShadow({mode: 'open', clonable: true}).innerHTML = '<x-counted></x-counted>';
        n = 0;
        document.implementation.createHTMLDocument('').importNode(host, true);
        const imported = n;
        n = 0;
        host.cloneNode(true);
        return [imported, n];
      })()
    JS
    expect(got).to eq([0, 1])
  end

  it "installs Attr's members on the class that makes attributes" do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.message; } };
        const el = document.createElementNS('urn:x', 'p:e');
        el.setAttributeNS('urn:y', 'q:a', 'v');
        const a = el.getAttributeNodeNS('urn:y', 'a');
        a.value = 42;
        return [
          [a.name, a.localName, a.prefix, a.namespaceURI, a.nodeName, a.value, el.getAttributeNS('urn:y', 'a'), a.ownerElement === el, a.specified],
          thrown(() => new Attr()), thrown(() => Object.getOwnPropertyDescriptor(Attr.prototype, 'value').get.call(el)),
          Object.prototype.toString.call(a)
        ];
      })()
    JS
    expect(got).to eq([['q:a', 'a', 'q', 'urn:y', 'q:a', '42', '42', true, true], "Failed to construct 'Attr': Illegal constructor", 'Illegal invocation', '[object Attr]'])
  end

  it "converts an attribute node argument, and adopts one from another document" do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.name + ': ' + e.message; } };
        const el = document.createElement('p');
        const other = document.implementation.createHTMLDocument('').createAttribute('z');
        other.value = 'q';
        el.setAttributeNode(other);
        return [
          thrown(() => el.setAttributeNode({})), thrown(() => el.removeAttributeNode(document.createAttribute('q'))),
          thrown(() => document.adoptNode(document.implementation.createHTMLDocument(''))),
          [el.getAttribute('z'), other.ownerDocument === document], typeof document.createTextNode('x').getClientRects
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to execute 'setAttributeNode' on 'Element': parameter 1 is not of type 'Attr'.",
      "NotFoundError: Failed to execute 'removeAttributeNode' on 'Element': The node provided is owned by another element.",
      "NotSupportedError: Failed to execute 'adoptNode' on 'Document': The node provided is of type '#document', which may not be adopted.",
      ['q', true], 'undefined'
    ])
  end

  # An element's interface chain is a browser's: its tag's interface, the one that inherits (HTMLMediaElement for audio
  # and video), HTMLElement / SVGElement / MathMLElement by namespace, Element — each namespace interface's members its
  # own (Chrome 154).
  it "chains an element's interfaces as IDL does, each with its own members" do
    got = outcome(<<~JS)
      (() => {
        const chain = (e) => { const c = []; for (let p = Object.getPrototypeOf(e); p && p !== Node.prototype; p = Object.getPrototypeOf(p)) c.push(p); return c; };
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mi');
        const none = document.createElementNS('urn:x', 'foo');
        const is = (e, ...ifaces) => { const c = chain(e); return c.length === ifaces.length && ifaces.every((i, k) => c[k] === i.prototype); };
        return [
          is(document.createElement('div'), HTMLDivElement, HTMLElement, Element),
          is(document.createElement('video'), HTMLVideoElement, HTMLMediaElement, HTMLElement, Element),
          is(document.createElement('section'), HTMLElement, Element),
          is(document.createElement('foo'), HTMLUnknownElement, HTMLElement, Element),
          is(document.createElementNS('http://www.w3.org/1999/xhtml', 'DIV'), HTMLUnknownElement, HTMLElement, Element),
          is(svg, SVGElement, Element), is(math, MathMLElement, Element), is(none, Element),
          ['click', 'innerText', 'offsetWidth', 'focus', 'style', 'dataset'].map((k) => k in svg),
          ['focus', 'style', 'onclick'].map((k) => k in none),
          ['focus', 'click', 'innerText'].map((k) => Object.hasOwn(Element.prototype, k)),
          [Image.prototype === HTMLImageElement.prototype, Option.prototype === HTMLOptionElement.prototype]
        ];
      })()
    JS
    expect(got).to eq([
      true, true, true, true, true, true, true, true,
      [false, false, false, true, true, true], [false, false, false], [false, false, false], [true, true]
    ])
  end

  # (…a custom element whose constructor failed is HTMLUnknownElement — a customized built-in its built-in — and an
  # interface prototype's `constructor` and class string are its own data properties)
  it "makes a failed custom element of its interface, and names each prototype's interface" do
    got = outcome(<<~JS)
      (() => {
        const prev = window.onerror;
        window.onerror = () => true;
        customElements.define('x-failing', class extends HTMLElement { constructor() { super(); throw new Error('no'); } });
        customElements.define('x-failing-button', class extends HTMLButtonElement { constructor() { super(); throw new Error('no'); } }, {extends: 'button'});
        const bad = document.createElement('x-failing'), btn = document.createElement('button', {is: 'x-failing-button'});
        window.onerror = prev;
        return [
          [Object.prototype.toString.call(bad), typeof bad.style, Object.prototype.toString.call(btn), btn.type],
          [Object.hasOwn(HTMLMediaElement.prototype, 'play'), document.createElement('video').NETWORK_EMPTY],
          ['search', 'rb'].map((n) => Object.prototype.toString.call(document.createElement(n))),
          [typeof Object.getOwnPropertyDescriptor(Element.prototype, 'constructor').value,
           Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, Symbol.toStringTag).value]
        ];
      })()
    JS
    expect(got).to eq([
      ['[object HTMLUnknownElement]', 'object', '[object HTMLButtonElement]', 'submit'], [true, 0],
      ['[object HTMLElement]', '[object HTMLElement]'], %w[function HTMLDivElement]
    ])
  end

  # (…`new Audio()` is a legacy factory, its element's members its interface's; Document's handlers are Document's)
  it "makes Audio an audio element of its interface, and leaves Document's members off elements" do
    got = outcome(<<~JS)
      (() => {
        const a = new Audio('x.mp3');
        return [
          Audio.prototype === HTMLAudioElement.prototype, Object.getOwnPropertyNames(a).filter((k) => !k.startsWith('_')),
          [a.paused, a.currentTime, a.volume, a.muted, a.getAttribute('preload'), a.getAttribute('src')],
          ['getElementsByName' in document.body, 'onfreeze' in document.body, 'onfreeze' in document]
        ];
      })()
    JS
    expect(got).to eq([true, [], [true, 0, 1, false, 'auto', 'x.mp3'], [false, false, true]])
  end

  # (…Web IDL §3.7.2: only `new` calls one, its `prototype` fixed, the global property not enumerable; arguments converted)
  it 'makes Option, Image and Audio legacy factory functions' do
    got = outcome(<<~JS)
      (() => {
        const prototype = (F) => Object.getOwnPropertyDescriptor(F, 'prototype');
        const called = (F) => { try { F(); return 'called'; } catch (e) { return e.message; } };
        const option = new Option('t', 'v', true, false);
        return [
          [Option, Image, Audio].map((F) => [F.name, F.length, prototype(F).writable, prototype(F).configurable, Object.getOwnPropertyDescriptor(window, F.name).enumerable]),
          called(Audio),
          [new Image(null, 5).outerHTML, new Image().outerHTML, option.outerHTML, option.selected, new Audio(null).getAttribute('src')]
        ];
      })()
    JS
    expect(got).to eq([
      [['Option', 0, false, false, false], ['Image', 0, false, false, false], ['Audio', 0, false, false, false]],
      "Failed to construct 'Audio': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ['<img width="0" height="5">', '<img>', '<option value="v" selected="">t</option>', false, 'null']
    ])
  end

  # (…a media element with no media data: a double converted before the range is checked, a seek only remembered, a
  # change of `volume` or `muted` a `volumechange`; Chrome's answers)
  it "keeps an audio element's state as a media element with no media data" do
    got = outcome(<<~JS)
      (() => {
        const a = window.audio = new Audio();
        window.events = [];
        for (const type of ['volumechange', 'seeked']) a.addEventListener(type, () => events.push(type));
        const set = (k, v) => { try { a[k] = v; return a[k]; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          set('volume', NaN), set('volume', 2), set('currentTime', Infinity), set('currentTime', 3), set('volume', '0.5'),
          set('volume', 0.5), set('muted', true), set('muted', 1),
          [a.readyState, String(a.duration), a.error, a.canPlayType('video/webm')],
          (() => { try { Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused').get.call(document.body); } catch (e) { return e.message; } })()
        ];
      })()
    JS
    nonfinite = ->(member) { "TypeError: Failed to set the '#{member}' property on 'HTMLMediaElement': The provided double value is non-finite." }
    expect(got).to eq([
      nonfinite['volume'],
      "IndexSizeError: Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (2) is outside the range [0, 1].",
      nonfinite['currentTime'], 3, 0.5, 0.5, true, true,
      [0, 'NaN', nil, 'maybe'],
      'Illegal invocation'
    ])
    expect(session.evaluate_script('events')).to eq(%w[volumechange volumechange])
  end

  # (…HTMLMediaElement's members its own, a track's `readyState` HTMLTrackElement's: named as Chrome names them, each
  # checking its `this` — a promise rejected, not thrown; `canPlayType` Chrome's answers, audio's too)
  it "puts the media elements' members on their interfaces" do
    got = outcome(<<~JS)
      (() => {
        const own = (name) => [HTMLMediaElement, HTMLAudioElement, HTMLVideoElement, HTMLTrackElement, Element]
          .filter((I) => Object.hasOwn(I.prototype, name)).map((I) => I.name).join('+');
        const get = (I, name) => Object.getOwnPropertyDescriptor(I.prototype, name).get;
        const illegal = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
        window.played = HTMLMediaElement.prototype.play.call(document.body).catch((e) => e.message);
        return [
          ['readyState', 'paused', 'videoWidth'].map(own),
          [get(HTMLMediaElement, 'paused').name, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').set.name, HTMLMediaElement.prototype.play.name],
          illegal(() => get(HTMLTrackElement, 'readyState').call(new Audio())),
          illegal(() => get(HTMLMediaElement, 'readyState').call(document.createElement('track'))),
          [document.createElement('track').readyState, HTMLTrackElement.LOADED],
          [['autoplay', 'loop', 'controls', 'playsInline'].map(own), get(HTMLMediaElement, 'autoplay').name, 'loop' in document.body],
          illegal(() => get(HTMLMediaElement, 'controls').call(document.body)),
          ['audio/mpeg', 'audio/ogg', 'audio/ogg; codecs="opus"', 'audio/wave', 'video/webm'].map((t) => new Audio().canPlayType(t))
        ];
      })()
    JS
    expect(got).to eq([
      ['HTMLMediaElement+HTMLTrackElement', 'HTMLMediaElement', 'HTMLVideoElement'],
      ['get paused', 'set volume', 'play'],
      'Illegal invocation', 'Illegal invocation', [0, 2],
      [%w[HTMLMediaElement HTMLMediaElement HTMLMediaElement HTMLVideoElement], 'get autoplay', false],
      'Illegal invocation',
      %w[probably maybe probably] + ['', 'maybe']
    ])
    expect(session.evaluate_async_script('played.then(arguments[0])')).to eq("Failed to execute 'play' on 'HTMLMediaElement': Illegal invocation")
  end

  # (…the object NewTarget's: a subclass's prototype, the interface's where NewTarget's is no object)
  it "makes a legacy factory function's object NewTarget's" do
    got = outcome(<<~JS)
      (() => {
        class Thumb extends Image {}
        const odd = function () {};
        odd.prototype = 5;
        return [
          new Thumb() instanceof Thumb, new Thumb().localName,
          Object.getPrototypeOf(Reflect.construct(Image, [], Object)) === Object.prototype,
          Object.getPrototypeOf(Reflect.construct(Audio, [], odd)) === HTMLAudioElement.prototype
        ];
      })()
    JS
    expect(got).to eq([true, 'img', true, true])
  end

  # (…Element's members its IDL's: `this` checked, arguments counted and converted — a dictionary's members with
  # Chrome's messages, an enumeration's values — before its steps; Chrome's answers, measured)
  it "converts Element's arguments as its IDL says" do
    got = outcome(<<~JS)
      (() => {
        const div = document.getElementById('a');
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.constructor.name + ': ' + e.message; } };
        return [
          t(() => Element.prototype.getAttribute.call(document, 'x')),
          t(() => div.getAttribute()),
          t(() => document.createElement('div').attachShadow({ mode: 'x' })),
          t(() => document.createElement('div').attachShadow({})),
          t(() => document.createElement('div').attachShadow(5)),
          t(() => [div.toggleAttribute('q', undefined), div.hasAttribute('q')]),
          t(() => { div.ariaControlsElements = 5; }),
          t(() => { div.ariaControlsElements = [1]; }),
          t(() => div.insertAdjacentElement('beforeend', document.createTextNode('x'))),
          t(() => div.getHTML({ shadowRoots: 5 })),
          t(() => typeof div.animate([], { trigger: 5 })),
          [Object.getOwnPropertyDescriptor(Element.prototype, 'id').get.name, Element.prototype.getAttribute.length, Element.prototype.scroll.length]
        ];
      })()
    JS
    attach = "TypeError: Failed to execute 'attachShadow' on 'Element': "
    aria = "TypeError: Failed to set the 'ariaControlsElements' property on 'Element': "
    expect(got).to eq([
      'TypeError: Illegal invocation',
      "TypeError: Failed to execute 'getAttribute' on 'Element': 1 argument required, but only 0 present.",
      "#{attach}Failed to read the 'mode' property from 'ShadowRootInit': The provided value 'x' is not a valid enum value of type ShadowRootMode.",
      "#{attach}Failed to read the 'mode' property from 'ShadowRootInit': Required member is undefined.",
      "#{attach}The provided value is not of type 'ShadowRootInit'.",
      '[true,true]',
      "#{aria}The provided value cannot be converted to a sequence.",
      "#{aria}Failed to convert value to 'Element'.",
      "TypeError: Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.",
      "TypeError: Failed to execute 'getHTML' on 'Element': Failed to read the 'shadowRoots' property from 'GetHTMLOptions': The provided value cannot be converted to a sequence.",
      '"object"',
      ['get id', 1, 0]
    ])
  end

  # (…a scroll is a promise of its completion, and what its steps throw — `this`, a conversion — its rejection)
  it "makes Element's and the window's scrolls promises" do
    got = outcome(<<~JS)
      (() => {
        const div = document.getElementById('a');
        window.rejections = [];
        const promises = [div.scrollIntoView(), div.scrollTo(0, 0), div.scrollBy({}), div.scroll(), window.scrollTo(0, 0),
                          Element.prototype.scrollIntoView.call({}), div.scrollIntoView({ block: 'bogus' })];
        promises.slice(5).forEach((p) => p.catch((e) => rejections.push(e.message)));
        return promises.map((p) => p instanceof Promise);
      })()
    JS
    expect(got).to eq([true] * 7)
    expect(session.evaluate_script('rejections')).to eq([
      "Failed to execute 'scrollIntoView' on 'Element': Illegal invocation",
      "Failed to execute 'scrollIntoView' on 'Element': Failed to read the 'block' property from 'ScrollIntoViewOptions': The provided value 'bogus' is not a valid enum value of type ScrollLogicalPosition."
    ])
  end

  # (…a select's `remove()` and `remove(index)` its own; the fullscreen handlers Element's and Document's, IDL attributes
  # alone — a shadow root has none; a page's own `setAttribute` not what an attribute's steps call)
  it "gives a select its own remove, the fullscreen handlers their owners, the steps their own attribute writes" do
    got = outcome(<<~JS)
      (() => {
        const select = document.createElement('select');
        select.innerHTML = '<option>1<option>2<option>3';
        select.remove(0);
        select.remove('1');
        const div = document.getElementById('a');
        const removed = (() => { try { HTMLSelectElement.prototype.remove.call(div); } catch (e) { return e.message; } })();
        const input = document.createElement('input');
        input.value = 'kept';
        const own = Element.prototype.setAttribute;
        Element.prototype.setAttribute = () => { throw new Error('a page setAttribute'); };
        try { input.type = 'radio'; } finally { Element.prototype.setAttribute = own; }
        return [
          [HTMLSelectElement.prototype.remove.length, select.options.length, removed],
          ['onfullscreenchange' in div, 'onfullscreenchange' in document, 'onfullscreenchange' in document.createElement('div').attachShadow({ mode: 'open' }),
           Object.hasOwn(Element.prototype, 'onfullscreenchange')],
          input.getAttribute('value')
        ];
      })()
    JS
    expect(got).to eq([[0, 1, 'Illegal invocation'], [true, true, false, true], 'kept'])
  end

  # (…a number conversion's TypeError the member's, a Symbol's or a BigInt's included; an option removed by the
  # collection's own steps; the window's scrolls its own members, converting as IDL says; Chrome's answers)
  it "converts numbers, removes options and scrolls the window as Chrome does" do
    got = outcome(<<~JS)
      (() => {
        const div = document.getElementById('a');
        const select = document.createElement('select');
        select.innerHTML = '<option>1<option>2';
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        window.rejected = window.scroll(5).catch((e) => e.message);
        const own = HTMLSelectElement.prototype.remove;
        HTMLSelectElement.prototype.remove = () => { throw new Error('a page remove'); };
        try { select.options.remove(0); } finally { HTMLSelectElement.prototype.remove = own; }
        return [
          t(() => { div.scrollLeft = Symbol(); }),
          t(() => div.setPointerCapture(1n)),
          t(() => div.insertAdjacentText('x', 'y')),
          t(() => div.toggleAttribute('a b')),
          t(() => select.options.remove()),
          [select.options.length, window.scroll === window.scrollTo, [window.scroll.name, window.scrollBy.name, window.scroll.length]],
          ['audio/flac; codecs=""', 'video/mp4; codecs=""'].map((type) => new Audio().canPlayType(type))
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to set the 'scrollLeft' property on 'Element': Cannot convert a Symbol value to a number",
      "TypeError: Failed to execute 'setPointerCapture' on 'Element': Cannot convert a BigInt value to a number",
      "SyntaxError: Failed to execute 'insertAdjacentText' on 'Element': The value provided ('x') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.",
      "InvalidCharacterError: Failed to execute 'toggleAttribute' on 'Element': 'a b' is not a valid attribute name.",
      "TypeError: Failed to execute 'remove' on 'HTMLOptionsCollection': 1 argument required, but only 0 present.",
      [1, false, %w[scroll scrollBy] + [0]],
      %w[probably maybe]
    ])
    expect(session.evaluate_async_script('rejected.then(arguments[0])')).to eq("Failed to execute 'scroll' on 'Window': The provided value is not of type 'ScrollToOptions'.")
  end

  # (…Document's members its IDL's: `readyState` read-only, `location` [LegacyUnforgeable] — an own property of each
  # document — `designMode` an enumeration's, arguments converted, and Chrome's messages; Chrome's answers)
  it "installs Document's members as its IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const location = Object.getOwnPropertyDescriptor(document, 'location');
        const div = document.createElement('div');
        div.innerHTML = '<b>x</b>';
        return [
          t(() => { document.readyState = 'x'; return [document.readyState, Object.hasOwn(document, 'readyState')]; }),
          [location.configurable, location.enumerable, Object.hasOwn(Document.prototype, 'location')],
          t(() => { const modes = []; for (const m of ['ON', 'bogus', 'off']) { document.designMode = m; modes.push(document.designMode); } return modes; }),
          t(() => document.createElement('div', 'x-y').outerHTML),
          t(() => document.createElement('1a')),
          [document.importNode(div, null).innerHTML, document.importNode(div).innerHTML, typeof document.parentWindow],
          t(() => document.evaluate('//div', 5)),
          t(() => { document.body = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); }),
          t(() => document.createEvent('UİEvent')),
          t(() => document.createProcessingInstruction('x', '?>')),
          t(() => document.elementFromPoint(NaN, 0)),
          [Object.getOwnPropertyDescriptor(Document.prototype, 'title').get.name, Document.prototype.createElement.length, Document.prototype.evaluate.length]
        ];
      })()
    JS
    expect(got).to eq([
      '["complete",false]',
      [false, true, false],
      '["on","on","off"]',
      '"<div></div>"',
      "InvalidCharacterError: Failed to execute 'createElement' on 'Document': The tag name provided ('1a') is not a valid name.",
      ['<b>x</b>', '', 'undefined'],
      "TypeError: Failed to execute 'evaluate' on 'Document': parameter 2 is not of type 'Node'.",
      "TypeError: Failed to set the 'body' property on 'Document': Failed to convert value to 'HTMLElement'.",
      "NotSupportedError: Failed to execute 'createEvent' on 'Document': The provided event type ('UİEvent') is invalid.",
      "InvalidCharacterError: Failed to execute 'createProcessingInstruction' on 'Document': The data provided ('?>') contains '?>'.",
      "TypeError: Failed to execute 'elementFromPoint' on 'Document': The provided double value is non-finite.",
      ['get title', 1, 2]
    ])
  end

  # (…ShadowRoot's members its IDL's: `onslotchange` its one handler, getHTML's options and setHTMLUnsafe's markup
  # converted as Element's are, Chrome's legacy hit tests kept; Chrome's answers)
  it "installs ShadowRoot's members as its IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const root = document.getElementById('a').attachShadow({ mode: 'open' });
        return [
          ['onclick' in root, 'onslotchange' in root, Object.hasOwn(ShadowRoot.prototype, 'onslotchange')],
          t(() => root.getHTML(5)),
          t(() => { root.setHTMLUnsafe(null); return root.innerHTML; }),
          t(() => { root.innerHTML = null; return root.innerHTML; }),
          t(() => Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'host').get.call(document.createDocumentFragment())),
          [Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'mode').get.name, ShadowRoot.prototype.getHTML.length, ShadowRoot.prototype.setHTMLUnsafe.length],
          [typeof root.elementFromPoint, typeof root.getSelection],
          t(() => { root.fullscreenElement = 5; return root.fullscreenElement; })
        ];
      })()
    JS
    expect(got).to eq([
      [false, true, true],
      "TypeError: Failed to execute 'getHTML' on 'ShadowRoot': The provided value is not of type 'GetHTMLOptions'.",
      '"null"', '""', 'TypeError: Illegal invocation',
      ['get mode', 0, 1], %w[function function], 'null'
    ])
  end

  # (…[PutForwards] onto no object a TypeError, [LegacyLenientSetter]'s `this` checked, a sequence's two TypeErrors,
  # adopted sheets converted alike on a document and a shadow root, a nameless cookie its value alone, and no window
  # scroll recursing on a forged window; Chrome's answers — but for its 'HTMLDocument')
  it "converts and checks as Chrome does where the bindings forward, lean or adopt" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const root = document.getElementById('a').attachShadow({ mode: 'open' });
        const forged = {};
        forged.window = forged;
        forged.scrollTo = window.scrollTo;
        return [
          t(() => { document.implementation.createHTMLDocument('').location = 'x'; }),
          t(() => Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement').set.call({}, 1)),
          ['video/mp4; codecs=", avc1.42E01E"', 'video/webm; codecs="vp8, ,vorbis"'].map((type) => document.createElement('video').canPlayType(type)),
          forged.scrollTo(0, 1) instanceof Promise,
          t(() => { root.adoptedStyleSheets = null; }),
          t(() => { root.adoptedStyleSheets = { length: 0 }; }),
          t(() => { root.adoptedStyleSheets = new Set([new CSSStyleSheet()]); return root.adoptedStyleSheets.length; }),
          t(() => { document.adoptedStyleSheets[0] = 5; }),
          t(() => { document.cookie = null; return document.cookie.split('; ').includes('null'); })
        ];
      })()
    JS
    root = "TypeError: Failed to set the 'adoptedStyleSheets' property on 'ShadowRoot': "
    expect(got).to eq([
      "TypeError: Failed to set the 'location' property on 'Document': The attribute value is not an object",
      'TypeError: Illegal invocation', ['', ''], true,
      "#{root}The provided value cannot be converted to a sequence.",
      "#{root}The object must have a callable @@iterator property.",
      '1', "TypeError: Failed to convert value to 'CSSStyleSheet'.", 'true'
    ])
  end

  # (…EventTarget's members its IDL's: a callback no object a TypeError, the options' `signal` an AbortSignal, an event
  # an Event, `this` the window when there is none; each EventTarget its own class string, and the events the driver
  # fires real ones — a MediaQueryListEvent, an IDBVersionChangeEvent; Chrome's answers)
  it "installs EventTarget's members as its IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const target = new EventTarget();
        return [
          t(() => target.addEventListener('x', 5)),
          t(() => target.addEventListener('x', null, { signal: null })),
          t(() => target.dispatchEvent({ type: 'x' })),
          t(() => { const add = EventTarget.prototype.addEventListener; let n = 0; add('zzz', () => n++); window.dispatchEvent(new Event('zzz')); return n; }),
          t(() => EventTarget.prototype.addEventListener.call({}, 'x', () => {})),
          [new AbortController().signal, new XMLHttpRequest().upload, new FileReader(), matchMedia('(min-width: 1px)')].map((o) => Object.prototype.toString.call(o)),
          [new MediaQueryListEvent('change', { matches: true, media: 'x' }).matches, new IDBVersionChangeEvent('upgradeneeded', { oldVersion: 1, newVersion: 2 }).newVersion],
          [EventTarget.prototype.addEventListener.length, EventTarget.prototype.dispatchEvent.length],
          t(() => { const e = new EventTarget(); let r; e.addEventListener('x', (ev) => { try { e.dispatchEvent(ev); } catch (er) { r = er.name; } }); e.dispatchEvent(new Event('x')); return r; }),
          t(() => new EventTarget().dispatchEvent(document.createEvent('Event'))),
          t(() => { const a = new EventTarget(), b = new EventTarget(), ev = new Event('x'); let p; b.addEventListener('x', () => { p = ev.composedPath(); }); a.dispatchEvent(ev); b.dispatchEvent(ev); return [ev.target === b, p.length === 1 && p[0] === b, ev.composedPath().length, ev.eventPhase]; }),
          [Object.getOwnPropertyNames(EventTarget.prototype).filter((k) => k.startsWith('__')), '__csimEvent' in new Event('x')]
        ];
      })()
    JS
    add = "TypeError: Failed to execute 'addEventListener' on 'EventTarget': "
    expect(got).to eq([
      "#{add}parameter 2 is not of type 'Object'.",
      "#{add}Failed to read the 'signal' property from 'AddEventListenerOptions': Failed to convert value to 'AbortSignal'.",
      "TypeError: Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.",
      '1', 'TypeError: Illegal invocation',
      ['[object AbortSignal]', '[object XMLHttpRequestUpload]', '[object FileReader]', '[object MediaQueryList]'],
      [true, 2], [2, 1],
      '"InvalidStateError"',
      'InvalidStateError: The event is already being dispatched, or has not been initialized.',
      '[true,true,0,0]',
      [[], false]
    ])
  end

  it "installs HTMLElement's, SVGElement's and MathMLElement's members as their IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const foreign = document.createElementNS('urn:x', 'x');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const g = svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'g'));
        const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
        const div = document.createElement('div');
        return [
          ['onclick', 'focus', 'style', 'dataset', 'tabIndex', 'nonce'].map((k) => k in foreign),
          [typeof g.focus, 'click' in g, 'innerText' in g, typeof g.className, g.ownerSVGElement === svg, svg.ownerSVGElement, g.viewportElement === svg],
          [typeof math.focus, 'onclick' in math, 'click' in math],
          t(() => { div.contentEditable = 'bogus'; }),
          t(() => { div.setAttribute('hidden', 'UNTIL-FOUND'); div.setAttribute('popover', 'x'); return [div.hidden, div.popover]; }),
          t(() => { div.innerText = 'a\\nb\\r\\nc'; return div.innerHTML; }),
          t(() => { div.outerText = 'x'; }),
          t(() => { const p = document.createElement('p'); p.innerHTML = 'a<b></b>c'; p.firstChild.nextSibling.outerText = '1\\n2'; return [p.innerHTML, p.childNodes.length]; }),
          t(() => HTMLElement.prototype.focus.call(foreign)),
          ['onstorage' in document.body, 'onstorage' in div],
          [HTMLElement, SVGElement, MathMLElement].map((i) => Object.prototype.toString.call(i.prototype)),
          t(() => { const f = document.createElement('form'); f.setAttribute('autocorrect', 'off'); const i = f.appendChild(document.createElement('input')); const r = [i.autocorrect]; i.setAttribute('autocorrect', 'bogus'); r.push(i.autocorrect); return r; }),
          t(() => { window.__ran = []; foreign.setAttribute('onclick', '__ran.push(1)'); foreign.dispatchEvent(new Event('click')); div.setAttribute('onstorage', '__ran.push(2)'); div.dispatchEvent(new Event('storage')); return window.__ran; }),
          t(() => document.createElement('div').showPopover()),
          t(() => { const p = document.createElement('div'); p.popover = 'manual'; p.showPopover(); }),
          t(() => { const p = document.body.appendChild(document.createElement('div')); p.popover = 'manual'; p.addEventListener('beforetoggle', (e) => e.preventDefault()); p.showPopover(); const r = p.matches(':popover-open'); p.remove(); return r; }),
          Object.prototype.toString.call(div.dataset)
        ];
      })()
    JS
    expect(got).to eq([
      [false, false, false, false, false, false],
      ['function', false, false, 'object', true, nil, true],
      ['function', true, false],
      "SyntaxError: Failed to set the 'contentEditable' property on 'HTMLElement': The value provided ('bogus') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.",
      '["until-found","manual"]',
      '"a<br>b<br>c"',
      "NoModificationAllowedError: Failed to set the 'outerText' property on 'HTMLElement': The element has no parent.",
      '["a1<br>2c",3]',
      'TypeError: Illegal invocation',
      [true, false],
      ['[object HTMLElement]', '[object SVGElement]', '[object MathMLElement]'],
      '[false,true]',
      '[]',
      "NotSupportedError: Failed to execute 'showPopover' on 'HTMLElement': Not supported on elements that do not have a valid value for the 'popover' attribute.",
      "InvalidStateError: Failed to execute 'showPopover' on 'HTMLElement': Invalid on disconnected popover elements.",
      'false',
      '[object DOMStringMap]'
    ])
  end

  it "installs Window's members on the global as its IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const shape = (k) => { const d = Object.getOwnPropertyDescriptor(window, k); return d ? ('value' in d ? 'data' : 'accessor') + (d.enumerable ? '+e' : '') + (d.configurable ? '+c' : '') : 'none'; };
        return [
          ['document', 'window', 'location', 'top', 'self', 'innerWidth', 'onclick', 'onpopstate', 'setTimeout', 'crossOriginIsolated'].map(shape),
          t(() => { const r = []; window.onzz = null; window.onclick = () => r.push('handler'); addEventListener('click', () => r.push('listener')); dispatchEvent(new Event('click')); window.onclick = null; return r; }),
          t(() => { innerWidth = 5; const v = innerWidth; delete window.innerWidth; return v; }),
          t(() => { document.body.setAttribute('onpopstate', 'return 1'); const r = typeof window.onpopstate; document.body.removeAttribute('onpopstate'); return [r, window.onpopstate]; }),
          t(() => { let a; window.onerror = (m, s, l) => { a = [m, l]; return true; }; const ok = dispatchEvent(new ErrorEvent('error', { message: 'm', lineno: 3, cancelable: true })); window.onerror = null; return [a, ok]; }),
          t(() => { let e; addEventListener('zz', (ev) => { e = window.event === ev; }, { once: true }); dispatchEvent(new Event('zz')); return [e, window.event === undefined]; }),
          t(() => getComputedStyle(5)),
          t(() => Object.getOwnPropertyDescriptor(window, 'scrollY').get.call({})),
          t(() => [locationbar.visible, typeof external.AddSearchProvider, status, name, length, screenX, originAgentCluster]),
          t(() => ['ontouchstart' in window, 'ontouchstart' in document, 'ontouchstart' in document.body]),
          t(() => document.createEvent('TouchEvent')),
          t(() => { const r = []; addEventListener('error', (e) => r.push(e.error.message), { once: true }); window.onclick = () => { throw new Error('boom'); }; document.body.click(); window.onclick = null; return r; }),
          t(() => { const s = document.createElement('script'); s.textContent = 'var origin = "shadowed"'; document.head.appendChild(s); const f = document.body.appendChild(document.createElement('iframe')); f.srcdoc = '<p>x'; const r = [origin, f.contentDocument !== null]; f.remove(); return r; })
        ];
      })()
    JS
    expect(got).to eq([
      ['accessor+e', 'accessor+e', 'accessor+e', 'accessor+e', 'accessor+e+c', 'accessor+e+c', 'accessor+e+c', 'accessor+e+c', 'data+e+c', 'accessor+e+c'],
      '["handler","listener"]',
      '5',
      '["function",null]',
      '[["m",3],false]',
      '[true,true]',
      "TypeError: Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.",
      'TypeError: Illegal invocation',
      '[true,"function","","",0,0,false]',
      '[false,false,false]',
      "NotSupportedError: Failed to execute 'createEvent' on 'Document': The provided event type ('TouchEvent') is invalid.",
      '["boom"]',
      '["shadowed",true]'
    ])
  end

  it "installs Event's and CustomEvent's members as their IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          t(() => Object.getOwnPropertyNames(new Event('x')).filter((k) => !k.startsWith('_'))),
          t(() => { const d = Object.getOwnPropertyDescriptor(new Event('x'), 'isTrusted'); return [typeof d.get, d.configurable, d.enumerable]; }),
          t(() => ['type', 'target', 'bubbles', 'timeStamp', 'composedPath'].map((k) => Object.hasOwn(Event.prototype, k))),
          t(() => { const e = new Event('x', { bubbles: 1, cancelable: true }); e.preventDefault(); return [e.type, e.bubbles, e.cancelable, e.defaultPrevented, e.returnValue]; }),
          t(() => new Event()),
          t(() => new Event('x', 5)),
          t(() => { const e = new Event('x'); e.isTrusted = true; return e.isTrusted; }),
          t(() => Object.getOwnPropertyDescriptor(Event.prototype, 'type').get.call({})),
          t(() => { const c = new CustomEvent('c', { detail: 7 }); const d = document.createEvent('CustomEvent'); d.initCustomEvent('q', true, false, 8); return [c.detail, d.type, d.bubbles, d.detail]; }),
          t(() => { class Mine extends Event {} return [new MouseEvent('m'), new Event('e'), new CustomEvent('c'), new Mine('x')].map(String); }),
          // (…every event interface's prototype its own class string)
          t(() => Object.getOwnPropertyNames(window).filter((k) => /Event$/.test(k) && typeof window[k] === 'function' && window[k].prototype instanceof Event)
            .filter((k) => Object.prototype.toString.call(window[k].prototype) !== '[object ' + k + ']')),
          t(() => { const c = document.createEvent('CustomEvent'); c.initCustomEvent('q'); const s = document.createEvent('StorageEvent'); s.initStorageEvent('w'); return [c.type, s.type]; }),
          t(() => new Text(Symbol()))
        ];
      })()
    JS
    expect(got).to eq([
      '["isTrusted"]',
      '["function",false,true]',
      '[true,true,true,true,true]',
      '["x",true,true,true,false]',
      "TypeError: Failed to construct 'Event': 1 argument required, but only 0 present.",
      "TypeError: Failed to construct 'Event': The provided value is not of type 'EventInit'.",
      'false',
      'TypeError: Illegal invocation',
      '[7,"q",true,8]',
      '["[object MouseEvent]","[object Event]","[object CustomEvent]","[object Event]"]',
      '[]',
      '["q","w"]',
      "TypeError: Failed to construct 'Text': Cannot convert a Symbol value to a string"
    ])
  end

  it "installs the UI Events' members as their IDL says" do
    got = outcome(<<~JS)
      (() => {
        const t = (f) => { try { return JSON.stringify(f()) ?? 'undefined'; } catch (e) { return e.name + ': ' + e.message; } };
        const target = document.body.appendChild(document.createElement('div'));
        target.style.cssText = 'position:absolute;left:20px;top:30px;border:3px solid;width:50px;height:50px';
        return [
          t(() => [new MouseEvent('c').which, new MouseEvent('c', { button: 2 }).which, new KeyboardEvent('k', { keyCode: 65 }).which, new UIEvent('u', { which: 7 }).which]),
          t(() => { const m = new MouseEvent('m', { clientX: 5 }); return [m.pageX, m.offsetX, m.x]; }),
          t(() => { let r; target.addEventListener('click', (e) => { r = [e.offsetX, e.offsetY]; }, { once: true }); target.dispatchEvent(new MouseEvent('click', { clientX: 30, clientY: 40 })); return r; }),
          t(() => { const k = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }); return [k.key, k.getModifierState('Control'), k.getModifierState('CapsLock')]; }),
          t(() => new TextEvent('x')),
          t(() => { const e = document.createEvent('TextEvent'); e.initTextEvent('textInput', true, true, null, 'q'); return [e.type, e.data]; }),
          t(() => new FocusEvent('focus', { relatedTarget: 5 })),
          t(() => new UIEvent('x', { view: 5 })),
          t(() => { const m = document.createEvent('MouseEvents'); m.initMouseEvent('click', true, true, window, 2, 1, 2, 3, 4, true, false, false, false, 1, null); return [m.detail, m.clientX, m.ctrlKey, m.button]; }),
          t(() => ['momentum' in WheelEvent.prototype, 'sourceCapabilities' in UIEvent.prototype, Object.getOwnPropertyNames(new MouseEvent('m')).filter((k) => !k.startsWith('_'))]),
          t(() => [new KeyboardEvent('k', { modifierCapsLock: true }).getModifierState('CapsLock'), new MouseEvent('m', { ctrlKey: true }).getModifierState('Accel')]),
          t(() => { const p = new PointerEvent('p'), q = new PointerEvent('p', { tiltX: 45 }), r = new PointerEvent('p', { altitudeAngle: 0.5, azimuthAngle: 1 }); return [p.tiltX, p.tiltY, p.altitudeAngle, p.azimuthAngle, +q.altitudeAngle.toFixed(3), r.tiltX, r.tiltY]; }),
          t(() => new UIEvent('u', { sourceCapabilities: {} }).type),
          t(() => MouseEvent.prototype.clientX),
          t(() => { const e = new InputEvent('beforeinput', { targetRanges: [new StaticRange({ startContainer: target, startOffset: 0, endContainer: target, endOffset: 0 })] }); const before = e.getTargetRanges().length; target.dispatchEvent(e); return [before, e.getTargetRanges().length]; }),
          t(() => { const e = new FocusEvent('focus'); Object.defineProperty(e, 'relatedTarget', { value: target }); let reached = false; target.addEventListener('focus', () => { reached = true; }, { once: true }); target.dispatchEvent(e); return reached; })
        ];
      })()
    JS
    expect(got).to eq([
      '[1,3,65,0]',
      '[5,5,5]',
      '[7,7]',
      '["a",true,false]',
      "TypeError: Failed to construct 'TextEvent': Illegal constructor",
      '["textInput","q"]',
      "TypeError: Failed to construct 'FocusEvent': Failed to read the 'relatedTarget' property from 'FocusEventInit': Failed to convert value to 'EventTarget'.",
      "TypeError: Failed to construct 'UIEvent': Failed to read the 'view' property from 'UIEventInit': Failed to convert value to 'Window'.",
      '[2,3,true,1]',
      '[false,false,["isTrusted"]]',
      '[true,true]',
      '[0,0,1.5707963267948966,0,0.785,45,57]',
      '"u"',
      'TypeError: Illegal invocation',
      '[1,0]',
      'true'
    ])
  end

  # (…the document element among them, and a name compared as it is, not as a selector)
  it "finds a document's elements by name, its root too" do
    got = outcome(<<~JS)
      (() => {
        document.documentElement.setAttribute('name', 'x');
        document.getElementById('a').setAttribute('name', 'x');
        // (…a backslash, a quote and bracket, a newline: what a selector built of the name would misread)
        const names = ['a' + String.fromCharCode(92) + 'b', 'q"]', 'n' + String.fromCharCode(10) + 'l'];
        for (const n of names) document.body.append(Object.assign(document.createElement('span'), {title: n}));
        document.querySelectorAll('span').forEach((s) => s.setAttribute('name', s.title));
        return ['x', ...names].map((n) => [...document.getElementsByName(n)].map((e) => e.localName).join());
      })()
    JS
    expect(got).to eq(['html,div', 'span', 'span', 'span'])
  end

  # (…an attribute adopted is taken from its element first, and each member converting an Attr names itself)
  it 'adopts an attribute out of its element' do
    got = outcome(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.message; } };
        const el = document.createElement('p');
        el.setAttribute('z', '1');
        const a = el.getAttributeNode('z');
        const d2 = document.implementation.createHTMLDocument('');
        d2.adoptNode(a);
        return [a.ownerElement, el.hasAttribute('z'), a.ownerDocument === d2,
                thrown(() => document.body.setAttributeNodeNS()), thrown(() => document.body.attributes.setNamedItem({}))];
      })()
    JS
    expect(got).to eq([nil, false, true,
      "Failed to execute 'setAttributeNodeNS' on 'Element': 1 argument required, but only 0 present.",
      "Failed to execute 'setNamedItem' on 'NamedNodeMap': parameter 1 is not of type 'Attr'."])
  end

  it 'marks only the [Unscopable] members of each interface' do
    got = outcome('[Document, DocumentFragment, Element].map((i) => Object.keys(i.prototype[Symbol.unscopables]).sort())')
    expect(got).to eq([
      %w[append prepend replaceChildren],
      %w[append prepend replaceChildren],
      %w[after append before prepend remove replaceChildren replaceWith slot]
    ])
  end

  # (…and an Element's members are no other node's: they had been Node's)
  it "gives an element's members to elements alone" do
    got = outcome(<<~JS)
      (() => {
        const t = document.createTextNode(''), c = document.createComment('');
        return [
          ['focus' in t, 'click' in c, 'offsetWidth' in document, 'getBoundingClientRect' in document, 'innerText' in t],
          ['focus' in document.body, 'click' in document.body, 'offsetWidth' in document.body, 'innerText' in document.body]
        ];
      })()
    JS
    expect(got).to eq([[false, false, false, false, false], [true, true, true, true]])
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
