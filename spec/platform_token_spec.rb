require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# What the platform passes its own constructions of an interface with no constructor is out of a page's reach: an interface
# object's [[Prototype]] is a page's to change, and a `super(…)` through it would hand the page's function what `super` was
# given. As an event interface's, an interface's class is flat: chained to the one it inherits by its [[Prototype]]s alone, so
# nothing of a page's in that chain is called, with the token or at all, and `new` works whatever is put there — Chrome's and
# Firefox's `Object.setPrototypeOf(X, null); new X` do. A node's too: `extends` has it inherit, no constructor of it calls `super`.
RSpec.describe 'the platform\'s token for its own constructions' do
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/data' then [200, {'content-type' => 'text/plain'}, ['hello']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><style>@media all { a { color: red } } @font-face { font-family: f } @keyframes k { from { top: 0 } } @import url(/data);</style><p id="p" style="animation: k 1s">x</p>']]
      end
    }
  }
  let(:session) { simulated_session(app) }
  after { session.reset_session! }

  # Every interface object of the window has a page's function for its [[Prototype]]: what it is called with kept, and any
  # symbol among that is what a page must never have.
  let(:spy_on_every_interface) {
    <<~JS
      window.leaked = [];
      window.called = [];
      for (const name of Object.getOwnPropertyNames(window)) {
        if (!/^[A-Z]/.test(name)) continue;
        const d = Object.getOwnPropertyDescriptor(window, name);
        const X = d && d.value;
        // (…an interface object: the realm's own builtins' chains are the language's)
        if (typeof X !== 'function' || !X.prototype || !/^class\\b/.test(Function.prototype.toString.call(X))) continue;
        if (Object.getPrototypeOf(X) === Function.prototype) continue;
        Object.setPrototypeOf(X, function () {
          called.push(name);
          for (const a of arguments) if (typeof a === 'symbol') leaked.push([name, a.toString()]);
          return {};
        });
      }
    JS
  }

  it 'never reaches a function a page put in an interface\'s prototype chain', :every_host_local do
    session.visit('https://a.test/')
    session.execute_script(spy_on_every_interface)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        performance.mark('m');
        performance.measure('n');
        await (await fetch('/data')).text();
        performance.getEntriesByType('resource');
        new PerformanceMark('page');
        const x = new XMLHttpRequest(); x.open('GET', '/data', false); x.send(); x.upload;
        for (const r of document.styleSheets[0].cssRules) r.cssText;
        document.styleSheets[0].cssRules[0].cssRules;
        document.getElementById('p').style.color;
        getComputedStyle(document.getElementById('p')).color;
        document.getElementById('p').getAnimations();
        document.timeline;
        new DocumentTimeline();
        new KeyframeEffect(null, []);
        new File(['x'], 'n');
        new DOMRect(); new DOMPoint(); new DOMMatrix();
        new AbortController().signal;
        new Worker('data:text/javascript,0').terminate();
        await new Promise((resolve) => {
          const open = indexedDB.open('spy');
          open.onupgradeneeded = () => open.result.createObjectStore('s');
          open.onsuccess = () => {
            const store = open.result.transaction('s', 'readwrite').objectStore('s');
            store.put(1, 1);
            store.openCursor().onsuccess = (e) => { open.result.close(); resolve(); };
          };
        });
        document.createRange();
        new StaticRange({startContainer: document, startOffset: 0, endContainer: document, endOffset: 0});
        document.getElementById('p').getClientRects();
      })().catch((e) => { window.threw = String(e); }).then(done);
    JS
    expect(session.evaluate_script('window.threw')).to be_nil
    expect(session.evaluate_script('leaked')).to eq([])
  end

  # (…of the interfaces that had a `super(PLATFORM, …)`, or forwarded their arguments to one, through a function given back)
  it 'makes each interface\'s object whatever its [[Prototype]] is', :every_host_local do
    session.visit('https://a.test/')
    made = session.evaluate_script(<<~JS)
      [
        ['XMLHttpRequest', () => new XMLHttpRequest()],
        ['PerformanceMark', () => new PerformanceMark('x')],
        ['KeyframeEffect', () => new KeyframeEffect(null, [])],
        ['DocumentTimeline', () => new DocumentTimeline()],
        ['File', () => new File([], 'x')],
        ['DOMPoint', () => new DOMPoint()],
        ['DOMRect', () => new DOMRect()],
        ['DOMMatrix', () => new DOMMatrix()],
        ['AbortController', () => new AbortController()],
        ['MessageChannel', () => new MessageChannel()],
        ['FileReader', () => new FileReader()],
        ['BroadcastChannel', () => new BroadcastChannel('x')]
      ].map(([name, make]) => {
        const X = window[name];
        Object.setPrototypeOf(X, null);
        try {
          const object = make();
          return object instanceof X ? 'ok' : `${name}: not an instance`;
        } catch (e) {
          return `${name}: ${e}`;
        }
      });
    JS
    expect(made.uniq).to eq(['ok'])
  end

  it 'leaves `new X` of an interface with no constructor an illegal one, whatever a page\'s token', :every_host_local do
    session.visit('https://a.test/')
    illegal = session.evaluate_script(<<~JS)
      ['Storage', 'Window', 'History', 'IDBKeyRange', 'PerformanceEntry', 'PerformanceMeasure', 'CSSRule', 'CSSMediaRule', 'IDBRequest', 'XMLHttpRequestUpload', 'XMLHttpRequestEventTarget'].filter((name) => {
        try {
          new window[name](Symbol('platform'));
          return true;
        } catch (e) {
          return !(e instanceof TypeError);
        }
      });
    JS
    expect(illegal).to eq([])
  end

  # Web IDL's constructor steps: its arguments converted, then the object made, reading NewTarget's `prototype` once ("Let
  # <constructor, values> be the result of passing S and args to the overload resolution algorithm. Let object be the result of
  # internally creating a new object implementing I, with realm and NewTarget."). No `super`, so nothing of a page's is called.
  it 'converts its arguments, then reads NewTarget\'s `prototype`, once', :every_host_local do
    session.visit('https://a.test/')
    got = session.evaluate_script(<<~JS)
      Object.entries({
        DOMException: (arg) => [arg, 'NotFoundError'],
        QuotaExceededError: (arg) => [arg],
        Event: (arg) => [arg],
        MouseEvent: (arg) => [arg],
        PerformanceMark: (arg) => [arg],
        DOMPoint: (arg) => [arg],
        DOMRect: (arg) => [arg],
        File: (arg) => [[], arg],
        Touch: (arg) => [{ identifier: 1, target: document, get clientX() { log.push('arg'); return 0; } }],
        BroadcastChannel: (arg) => [arg],
        WebSocket: (arg) => [`ws://a.test/${String(arg)}`],
        EventSource: (arg) => [arg],
        Worker: (arg) => [arg],
        Blob: (arg) => [[arg]],
        Request: (arg) => [arg],
        Response: (arg) => [arg],
        URL: (arg) => [arg, 'http://a.test/'],
        URLSearchParams: (arg) => [[[arg, 'v']]],
        Headers: () => [[[{ toString() { log.push('arg'); return 'x'; } }, 'v']]],
        TextDecoder: (arg) => ['utf-8', { get fatal() { log.push('arg'); return false; } }],
        DOMPointReadOnly: (arg) => [arg],
        DOMRectReadOnly: (arg) => [arg],
        DOMQuad: (arg) => [{ get x() { log.push('arg'); return 0; } }],
        MutationObserver: (arg) => [() => { log.push('no'); }],
        KeyframeEffect: (arg) => [null, [], { get duration() { log.push('arg'); return 1; } }],
        Animation: (arg) => [null, document.timeline],
        Text: (arg) => [arg],
        Comment: (arg) => [arg],
        ProcessingInstruction: () => [{ toString() { log.push('arg'); return 'x'; } }, 'd'],
        Option: (arg) => [arg],
        Image: (arg) => [arg],
        Audio: (arg) => [arg]
      }).map(([name, make]) => {
        window.log = [];
        function NewTarget() {}
        NewTarget.prototype = window[name].prototype;
        const target = new Proxy(NewTarget, { get(t, p, r) { if (p === 'prototype') log.push('proto'); return Reflect.get(t, p, r); } });
        const arg = { toString() { log.push('arg'); return '/x'; } };
        const spy = () => { log.push('spy'); };
        const before = Object.getPrototypeOf(window[name]);
        Object.setPrototypeOf(window[name], spy);
        try {
          const made = Reflect.construct(window[name], make(arg), target);
          if (!(made instanceof window[name])) log.push('no instance');
        } catch (e) {
          log.push(String(e));
        }
        Object.setPrototypeOf(window[name], before);
        return [name, log.join('>').replace(/^(arg>)+/, 'arg>')];
      });
    JS
    # (…MutationObserver's and Animation's arguments no user code: its `prototype` read once)
    expect(got.to_h.reject {|name, _| %w[MutationObserver Animation].include?(name) }.values.uniq).to eq(['arg>proto'])
    expect(got.to_h.values_at('MutationObserver', 'Animation')).to eq(%w[proto proto])
  end

  # (…the interfaces of a node's chain, with what a page does that makes an object of each: Chrome and Firefox make them all)
  [
    ['null', 'null'],
    ['a function', 'function () { window.called.push(arguments.length); return {}; }']
  ].each do |what, parent|
    it "makes a node's object with #{what} as its interface's [[Prototype]]", :every_host_local do
      session.visit('https://a.test/')
      session.execute_script(<<~JS)
        window.called = [];
        const chain = ['EventTarget', 'Node', 'CharacterData', 'Text', 'CDATASection', 'Comment', 'ProcessingInstruction', 'Attr', 'DocumentType',
          'Element', 'HTMLElement', 'HTMLMediaElement', 'HTMLAudioElement', 'HTMLDivElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLUnknownElement',
          'SVGElement', 'MathMLElement', 'DocumentFragment', 'ShadowRoot', 'Document', 'XMLDocument', 'AbstractRange', 'Range', 'NodeList', 'RadioNodeList'];
        class Custom extends HTMLElement {}
        customElements.define('x-custom', Custom);
        for (const name of chain) Object.setPrototypeOf(window[name], #{parent});
      JS
      got = session.evaluate_script(<<~JS)
        (() => {
          const form = document.createElement('form');
          form.innerHTML = '<input type=radio name=r><input type=radio name=r>';
          const xml = () => document.implementation.createDocument(null, null);
          return Object.fromEntries(Object.entries({
            createDocument: () => Object.prototype.toString.call(xml()),
            createHTMLDocument: () => document.implementation.createHTMLDocument('t').title,
            newDocument: () => new Document().nodeType,
            cloneNode: () => document.getElementById('p').cloneNode(true).textContent,
            cloneDocument: () => xml().cloneNode(true).nodeType,
            createElement: () => document.createElement('div').localName,
            createElementNS: () => document.createElementNS('http://www.w3.org/2000/svg', 'g').localName,
            unknown: () => document.createElement('nope').localName,
            innerHTML: () => { const d = document.createElement('div'); d.innerHTML = '<b>x</b>y<!--z-->'; return d.childNodes.length; },
            audio: () => new Audio().localName,
            shadow: () => document.createElement('div').attachShadow({mode: 'open'}).nodeType,
            radio: () => form.elements.namedItem('r').length,
            text: () => new Text('t').data,
            comment: () => new Comment('c').data,
            fragment: () => new DocumentFragment().nodeType,
            cdata: () => xml().createCDATASection('c').nodeType,
            processingInstruction: () => new ProcessingInstruction('p', 'd').target,
            attribute: () => document.createAttribute('a').name,
            doctype: () => document.implementation.createDocumentType('d', '', '').name,
            range: () => new Range().collapsed,
            custom: () => document.createElement('x-custom').localName,
            newCustom: () => new (customElements.get('x-custom'))().localName
          }).map(([name, make]) => { try { return [name, make()]; } catch (e) { return [name, String(e)]; } }));
        })()
      JS
      expect(got).to eq(
        'createDocument'        => '[object XMLDocument]',
        'createHTMLDocument'    => 't',
        'newDocument'           => 9,
        'cloneNode'             => 'x',
        'cloneDocument'         => 9,
        'createElement'         => 'div',
        'createElementNS'       => 'g',
        'unknown'               => 'nope',
        'innerHTML'             => 3,
        'audio'                 => 'audio',
        'shadow'                => 11,
        'radio'                 => 2,
        'text'                  => 't',
        'comment'               => 'c',
        'fragment'              => 11,
        'cdata'                 => 4,
        'processingInstruction' => 'p',
        'attribute'             => 'a',
        'doctype'               => 'd',
        'range'                 => true,
        'custom'                => 'x-custom',
        'newCustom'             => 'x-custom'
      )
      expect(session.evaluate_script('window.called')).to eq([])
    end
  end

  # Web IDL's constructor steps: "If I was not declared with a constructor operation, then throw a TypeError." Whatever NewTarget is.
  it 'has no constructor of an interface with none make an object for a subclass', :every_host_local do
    session.visit('https://a.test/')
    got = session.evaluate_script(<<~JS)
      ['Node', 'CharacterData', 'AbstractRange', 'StyleSheet', 'CSSStyleDeclaration', 'HTMLCollection', 'NodeList', 'Lock', 'History'].filter((name) => {
        function Other() {}
        try {
          Reflect.construct(window[name], [], Other);
          return true;
        } catch (e) {
          return !(e instanceof TypeError);
        }
      })
    JS
    expect(got).to eq([])
  end

  it 'answers a class without `new` and with another NewTarget as a class does', :every_host_local do
    session.visit('https://a.test/')
    expect(session.evaluate_script(<<~JS)).to eq([true, true, true, true, 0, 'Event', 'XMLHttpRequest', 1, 'DOMPoint'])
      (() => {
        const threw = (f) => { try { f(); return false; } catch (e) { return e instanceof TypeError; } };
        function Other() {}
        return [
          threw(() => Event('x')),
          threw(() => XMLHttpRequest()),
          Object.getPrototypeOf(Reflect.construct(DOMPoint, [], Other)) === Other.prototype,
          Object.getPrototypeOf(Reflect.construct(Event, ['x'], Other)) === Other.prototype,
          XMLHttpRequest.length,
          Event.name,
          XMLHttpRequest.name,
          Event.length,
          DOMPoint.name
        ];
      })()
    JS
  end

  # (…a function made Object's by no one: a page's Object swapped out reaches no construction)
  it 'makes its object whatever a page has put at `Object`', :every_host_local do
    session.visit('https://a.test/')
    session.execute_script('window.Object = function () { throw new Error("page"); };')
    expect(session.evaluate_script("[new Event('x').type, new DOMPoint(1).x, new XMLHttpRequest() instanceof EventTarget]")).to eq(['x', 1, true])
  end

  it 'keeps a page\'s subclass of a flat interface a subclass', :every_host_local do
    session.visit('https://a.test/')
    expect(session.evaluate_script(<<~JS)).to eq([true, true, true, true, 'x', true])
      (() => {
        class MyXhr extends XMLHttpRequest { constructor() { super(); this.mine = true; } }
        class MyMark extends PerformanceMark {}
        const x = new MyXhr();
        const m = new MyMark('x');
        return [x instanceof XMLHttpRequest, x instanceof EventTarget, x.mine, typeof x.open === 'function', m.name, m instanceof PerformanceEntry];
      })()
    JS
  end

  it 'has a member\'s write to an object of the platform meet no setter of a page\'s', :every_host_local do
    session.visit('https://a.test/')
    session.execute_script(<<~JS)
      window.seen = [];
      for (const name of ['owner', 'name', 'PerformanceEntry', 'XMLHttpRequest', 'state', 'realm', 'Blob', 'size', 'x', 'width']) {
        Object.defineProperty(Object.prototype, name, { set(v) { seen.push(name); }, get() { return 'page'; }, configurable: true });
      }
    JS
    expect(session.evaluate_script(<<~JS)).to eq([[], 'x', 1, 0, true])
      (() => {
        const mark = new PerformanceMark('x');
        const blob = new Blob(['x']);
        const rect = new DOMRect();
        const x = new XMLHttpRequest();
        return [seen, mark.name, blob.size, rect.x, x instanceof XMLHttpRequest];
      })()
    JS
  end
end
