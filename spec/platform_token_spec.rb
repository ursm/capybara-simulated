require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# What the platform passes its own constructions of an interface with no constructor is out of a page's reach: an interface
# object's [[Prototype]] is a page's to change, and a `super(…)` through it would hand the page's function what `super` was
# given. As an event interface's, an interface's class is flat: chained to the one it inherits by its [[Prototype]]s alone, so
# nothing of a page's in that chain is called, with the token or at all, and `new` works whatever is put there — Chrome's and
# Firefox's `Object.setPrototypeOf(X, null); new X` do. (A node's chain, whose objects a `super()` makes natively, stays as it
# was: nothing of it passes the token.)
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
