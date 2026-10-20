require 'capybara/simulated'
require_relative 'support/session_teardown'

# What the platform does is the engine's, not the page's: a page may redefine a member of an interface prototype (a
# polyfill, a test double, an analytics shim), and the platform's own algorithms — serializing, parsing, focusing,
# showing a popover — go on reading the node's own state, never the member the page replaced. In Chrome a throwing
# `Node.prototype.ownerDocument` breaks none of these.
RSpec.describe 'members a page overrides' do
  it "leaves the platform's own reads of a node's document alone" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="i"><div id="p" popover>p</div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        Object.defineProperty(Node.prototype, 'ownerDocument', { get() { throw new Error('page getter'); }, configurable: true });
        const d = document.createElement('div');
        d.innerHTML = '<b>x</b><i>y</i>';
        const html = d.innerHTML;
        d.insertAdjacentHTML('beforeend', '<u>z</u>');
        document.body.append(d);
        document.getElementById('i').focus();
        const focused = document.activeElement.id;
        document.getElementById('p').showPopover();
        const open = document.getElementById('p').matches(':popover-open');
        return [html, d.outerHTML, focused, open];
      })()
    JS
    expect(got).to eq(['<b>x</b><i>y</i>', '<div><b>x</b><i>y</i><u>z</u></div>', 'i', true])
  end

  # …and of the selection and its range: typing into an editing host, moving its caret and cutting go on where the
  # selection is, whatever a page made of `Selection.prototype.collapse` or a Range's boundary getters.
  it "types and moves the caret through the engine's selection, not its members" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><div id="ce" contenteditable></div>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const boom = () => { throw new Error('page member'); };
      for (const name of ['collapse', 'extend', 'setBaseAndExtent', 'getRangeAt']) Selection.prototype[name] = boom;
      for (const name of ['focusNode', 'isCollapsed', 'direction']) Object.defineProperty(Selection.prototype, name, { get: boom, configurable: true });
      for (const name of ['startContainer', 'startOffset', 'endContainer', 'endOffset', 'collapsed']) {
        Object.defineProperty(AbstractRange.prototype, name, { get: boom, configurable: true });
      }
    JS
    s.find('#ce').send_keys('ab', :left, 'c', :end, 'd')
    expect(s.evaluate_script('document.getElementById("ce").textContent')).to eq('acbd')
  end

  # …and a cut takes the selection's text from the engine — not the page's `toString` of a Selection or a Range, nor its
  # `activeElement` — and an `insertHTML` into a text control its markup's text, not through the page's `createElement`.
  it "cuts and inserts through the engine's text, not the page's members" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><div id="ce" contenteditable>hello</div><input id="i">']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const boom = () => { throw new Error('page member'); };
      Selection.prototype.toString = boom;
      Range.prototype.toString = boom;
      Object.defineProperty(Document.prototype, 'activeElement', { get: boom, configurable: true });
      Document.prototype.createElement = boom;
      const ce = document.getElementById('ce');
      ce.focus();
      getSelection().selectAllChildren(ce);
    JS
    s.find('#ce').send_keys([:control, 'x'])
    s.execute_script('document.getElementById("i").focus(); document.execCommand("insertHTML", false, "<b>x</b><!--c-->y")')
    expect(s.evaluate_script('[document.getElementById("ce").textContent, document.getElementById("i").value]')).to eq(['', 'xy'])
  end

  # …and a fetch reads its signal's state, not the page's `AbortSignal.prototype.aborted` / `reason`: one not aborted
  # fetches, one aborted rejects with its reason.
  it "reads a fetch's signal as the engine holds it" do
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/' ? '<!DOCTYPE html><meta charset="utf-8"><body>' : 'ok']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const boom = () => { throw new Error('page member'); };
      for (const name of ['aborted', 'reason']) Object.defineProperty(AbortSignal.prototype, name, { get: boom, configurable: true });
      const aborted = new AbortController();
      aborted.abort('why');
      Promise.all([
        fetch('/x', { signal: new AbortController().signal }).then((r) => r.text(), (e) => 'rejected ' + e),
        fetch('/x', { signal: aborted.signal }).then(() => 'fetched', (e) => 'rejected ' + e)
      ]).then(done);
    JS
    expect(got).to eq(['ok', 'rejected why'])
  end

  # …and the driver's active element is the document's, not the page's `Document.prototype.activeElement`.
  it "answers the driver's active element from the engine" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="i">']] })
    s.visit '/'
    s.execute_script(<<~JS)
      Object.defineProperty(Document.prototype, 'activeElement', { get() { throw new Error('page member'); }, configurable: true });
      document.getElementById('i').focus();
    JS
    expect(s.active_element[:id]).to eq('i')
  end

  # …and the keys the driver presses and the options it picks: Ctrl+A in a text field selects its text, an Arrow steps a
  # number field, `select` picks an option by its value — whatever a page made of `select()`, `value`, an option's
  # `value` (put back before the expectation reads them).
  it "presses keys and picks options through the engine's values" do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="t" value="abc"><input id="n" type="number" value="1">' \
        '<select id="s"><option>one</option><option value="2">two</option></select><p id="log"></p>']]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      const boom = () => { throw new Error('page member'); };
      window.saved = [
        [HTMLInputElement.prototype, 'select'], [HTMLInputElement.prototype, 'value'], [HTMLOptionElement.prototype, 'value']
      ].map(([proto, name]) => [proto, name, Object.getOwnPropertyDescriptor(proto, name)]);
      HTMLInputElement.prototype.select = boom;
      Object.defineProperty(HTMLInputElement.prototype, 'value', { get: boom, set: boom, configurable: true });
      Object.defineProperty(HTMLOptionElement.prototype, 'value', { get: boom, configurable: true });
      document.getElementById('n').addEventListener('change', () => document.getElementById('log').textContent += 'change');
    JS
    s.find('#t').send_keys([:control, 'a'], 'x')
    s.find('#n').send_keys(:up)
    s.find('#s').select('two')
    s.execute_script('for (const [proto, name, desc] of saved) Object.defineProperty(proto, name, desc)')
    expect(s.evaluate_script(<<~JS)).to eq(['x', '2', 'change', '2'])
      ['t', 'n', 'log', 's'].map((id) => { const el = document.getElementById(id); return el.id === 'log' ? el.textContent : el.value; })
    JS
  end

  # …and the tree's own reads: a node's text, its siblings, a frame's window, a document's window, `new Option(text)`,
  # the driver's page text — whatever a page made of `textContent`, `nextSibling`, `contentWindow`, `defaultView`,
  # `createElementNS`.
  it "reads the tree, a frame's window and a document's window through the engine" do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p id="p"><b>b</b></p><iframe name="f" srcdoc="x"></iframe>']]
    })
    s.visit '/'
    s.evaluate_script('frames[0].length')
    got = s.evaluate_script(<<~JS)
      (() => {
        const boom = { get() { throw new Error('page member'); }, configurable: true };
        for (const name of ['textContent', 'nextSibling', 'previousSibling', 'firstChild']) Object.defineProperty(Node.prototype, name, boom);
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', boom);
        Object.defineProperty(Document.prototype, 'defaultView', boom);
        Document.prototype.createElementNS = () => { throw new Error('page member'); };
        const b = document.querySelector('b');
        b.before('a');
        b.after('c');
        const p = document.getElementById('p'), before = p.innerHTML;
        p.insertBefore(b, b);
        p.replaceChild(b, b);
        b.replaceWith(document.createElement('u'));
        const o = new Option('opt');
        return [before, p.innerHTML, o.text, typeof frames[0], typeof window.f];
      })()
    JS
    expect(got).to eq(['a<b>b</b>c', 'a<u></u>c', 'opt', 'object', 'object'])
    expect(s.text).to eq('ac')
  end
  # …nor a style read, an animation's committed styles, the font set's layout flush or a modal dialog's close request:
  # `isConnected`, `setProperty`, `getBoundingClientRect`, `defaultPrevented` replaced, each goes on (Chrome: below).
  it "reads its own state where a page replaced isConnected, setProperty, getBoundingClientRect or defaultPrevented" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><div id="t">x</div><dialog id="d">dlg</dialog>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const out = [];
        let calls = 0;
        const rect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () { calls++; return rect.call(this); };
        [...document.fonts];
        out.push(calls);
        Element.prototype.getBoundingClientRect = rect;
        const setProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = () => {};
        const t = document.getElementById('t');
        const a = t.animate({opacity: [0.25, 0.25]}, {fill: 'forwards'});
        a.finish();
        a.commitStyles();
        CSSStyleDeclaration.prototype.setProperty = setProperty;
        out.push(t.style.opacity);
        const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected');
        Object.defineProperty(Node.prototype, 'isConnected', {get: () => false, configurable: true});
        out.push(getComputedStyle(document.body).display);
        Object.defineProperty(Node.prototype, 'isConnected', connected);
        return out;
      })()
    JS
    expect(got).to eq([0, '0.25', 'block'])
    s.execute_script(<<~JS)
      document.getElementById('d').showModal();
      Object.defineProperty(Event.prototype, 'defaultPrevented', {get: () => true, configurable: true});
    JS
    s.find(:css, '#d').send_keys(:escape)
    expect(s.evaluate_script("document.getElementById('d').open")).to be(false)
  end

  # …and `execCommand`'s alignment and colour: the text-align it gives the block and the style its span carries are the
  # engine's, whatever a page made of CSSStyleDeclaration's members.
  it "aligns and colours an editing host's text whatever a page made of CSSStyleDeclaration" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><div id="ce" contenteditable>hello</div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const boom = () => { throw new Error('page member'); };
        for (const name of ['textAlign', 'color', 'cssText']) {
          Object.defineProperty(CSSStyleDeclaration.prototype, name, { get: boom, set: boom, configurable: true });
        }
        CSSStyleDeclaration.prototype.setProperty = boom;
        const ce = document.getElementById('ce');
        ce.focus();
        getSelection().selectAllChildren(ce);
        document.execCommand('justifyCenter');
        getSelection().selectAllChildren(ce);
        document.execCommand('foreColor', false, 'red');
        return ce.innerHTML;
      })()
    JS
    expect(got).to include('text-align: center').and include('color: red')
  end

  # …and the platform's own microtasks and tasks — a MutationObserver's delivery, a frame's postMessage — are queued by
  # the realm's intrinsics, whatever a page (a polyfill, a fake-timer library) made of `Promise`, its `then`,
  # `queueMicrotask` or `setTimeout`.
  it 'delivers mutations and messages whatever a page made of Promise, queueMicrotask and setTimeout' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = [];
      const frame = document.createElement('iframe');
      document.body.append(frame);
      addEventListener('message', (e) => got.push('message:' + e.data));
      new MutationObserver((records) => got.push('mutations:' + records.length)).observe(document.body, { childList: true });
      const boom = () => { throw new Error('page member'); };
      Promise.prototype.then = boom;
      window.Promise = function () { throw new Error('page Promise'); };
      window.queueMicrotask = boom;
      window.setTimeout = boom;
      document.body.append(document.createElement('p'));
      frame.contentWindow.eval("parent.postMessage('hi', '*')");
    JS
    expect(s.evaluate_script('got')).to eq(['mutations:1', 'message:hi'])
  end

  # …nor what a page made of the realm's own promises: resolving one with a thenable reads no `constructor` off it, so a
  # page's getter there (a species hook) stops neither a microtask nor a mutation record.
  it "queues its microtasks whatever a page made of Promise.prototype.constructor" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = [];
      new MutationObserver(() => got.push('mutations')).observe(document.body, { childList: true });
      Object.defineProperty(Promise.prototype, 'constructor', { get() { throw new Error('page species'); } });
      queueMicrotask(() => got.push('microtask'));
      document.body.append(document.createElement('p'));
    JS
    expect(s.evaluate_script('got')).to eq(['microtask', 'mutations'])
  end

  # …the rejection a page left unhandled is reported likewise, and the one the getter was in place for blocks none after.
  it "reports unhandled rejections whatever a page made of Promise.prototype.constructor" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const got = [];
      addEventListener('unhandledrejection', (e) => { e.preventDefault(); got.push(e.reason); });
      const own = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
      Object.defineProperty(Promise.prototype, 'constructor', { configurable: true, get() { throw new Error('page species'); } });
      Promise.reject('r1');
      Object.defineProperty(Promise.prototype, 'constructor', own);
      setTimeout(() => {
        Promise.reject('r2');
        setTimeout(() => done(got), 10);
      }, 10);
    JS
    expect(got).to eq(%w[r1 r2])
  end

  # …and the promises the platform hands back are the realm's own, whatever a page (Zone.js) put in `Promise`.
  it "hands back the realm's own promises whatever a page put in Promise" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const Own = Promise;
        window.Promise = function () { throw new Error('page Promise'); };
        window.Promise.resolve = window.Promise.reject = window.Promise.all = () => { throw new Error('page Promise'); };
        const made = [
          fetch('/'), document.fonts.ready, new Image().decode(), navigator.permissions.query({ name: 'geolocation' }),
          navigator.mediaDevices.enumerateDevices(), navigator.serviceWorker.getRegistrations()
        ];
        for (const p of made) Own.prototype.then.call(p, undefined, () => {});
        return made.map((p) => p instanceof Own);
      })()
    JS
    expect(got).to eq([true] * 6)
  end

  # …and one it hands back later is the engine's to settle: a pending image's decode waits for its load, here one that
  # breaks, and rejects with the EncodingError of that, not with what the page's `Promise` threw.
  it "settles a pending image's decode whatever a page put in Promise" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const Own = Promise;
      const img = new Image();
      img.src = '/not-an-image';
      window.Promise = function () { throw new Error('page Promise'); };
      const decoded = img.decode();
      window.Promise = Own;
      decoded.then(() => done('resolved'), (e) => done(e.name));
    JS
    expect(got).to eq('EncodingError')
  end

  # …and what the platform reads off its own objects is theirs: a canvas's size, a parsed document's root namespace, a
  # Blob's size on an IndexedDB key path, and the report of a callback's exception, whatever a page put on the
  # prototypes or the global — Chrome reads none of these members.
  it "reads its canvases, documents and Blobs, and reports exceptions, whatever a page made of their members" do
    app = lambda {|env|
      if env['PATH_INFO'] == '/doc.xml'
        [200, {'content-type' => 'application/xml'}, ['<root xmlns="urn:x"/>']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const got = [];
      const boom = { get() { throw new Error('page member'); } };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 10;
      const ctx = canvas.getContext('2d');
      Object.defineProperty(HTMLCanvasElement.prototype, 'width', boom);
      Object.defineProperty(HTMLCanvasElement.prototype, 'height', boom);
      ctx.fillRect(0, 0, 10, 10);
      got.push(ctx.getImageData(5, 5, 1, 1).data[3]);
      Object.defineProperty(Element.prototype, 'namespaceURI', boom);
      Object.defineProperty(Blob.prototype, 'size', boom);
      window.reportError = () => got.push('page reportError');
      addEventListener('error', (e) => { e.preventDefault(); got.push('error:' + e.error.message); });
      setTimeout(() => { throw new Error('thrown'); }, 0);
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/doc.xml');
      xhr.onload = () => {
        got.push(xhr.responseXML !== null);
        const open = indexedDB.open('page-members');
        open.onupgradeneeded = () => open.result.createObjectStore('s', { keyPath: 'b.size' });
        open.onsuccess = () => {
          const store = open.result.transaction('s', 'readwrite').objectStore('s');
          const put = store.put({ b: new Blob(['abc']) });
          put.onsuccess = () => { got.push(put.result); done(got); };
          put.onerror = () => done(got.concat('put failed'));
        };
      };
      xhr.send();
    JS
    expect(got).to eq([255, 'error:thrown', true, 3])
  end

  # …a canvas drawn from, a screenshot's surface and a file's name and type likewise: a canvas shim (fingerprinting) that
  # wraps `getContext` or the size, or a page that replaced `createElement`, still gets its screenshot.
  it "draws, paints and names files whatever a page made of the canvas and file members" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p>x</p><input type=file id=f>']] })
    s.visit '/'
    s.find('#f').set(__FILE__)
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = document.createElement('canvas'), b = document.createElement('canvas');
        a.width = a.height = b.width = b.height = 10;
        a.getContext('2d').fillRect(0, 0, 10, 10);
        const bx = b.getContext('2d');
        const one = { configurable: true, get: () => 1, set() { throw new Error('page size'); } };
        Object.defineProperty(HTMLCanvasElement.prototype, 'width', one);
        Object.defineProperty(HTMLCanvasElement.prototype, 'height', one);
        HTMLCanvasElement.prototype.getContext = () => null;
        Document.prototype.createElement = () => null;
        Object.defineProperty(File.prototype, 'name', { get: () => 'PAGE' });
        Object.defineProperty(Blob.prototype, 'type', { get: () => 'page/type' });
        bx.drawImage(a, 0, 0);
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'own.txt', { type: 'text/plain' }));
        return [
          bx.getImageData(5, 5, 1, 1).data[3],
          __csimScreenshot(false) !== null,
          document.getElementById('f').value.endsWith('page_overridden_members_spec.rb'),
          dt.items[0].type
        ];
      })()
    JS
    expect(got).to eq([255, true, true, 'text/plain'])
  end

  # …and what it throws and fires is its own: a page (a core-js polyfill) that replaced DOMException, TypeError, Map or
  # ProgressEvent gets the platform's exceptions and events all the same.
  it "throws and fires its own exceptions and events whatever a page put in the globals" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const Own = { DOMException, TypeError };
      const page = function () { this.name = 'PAGE'; };
      window.DOMException = window.TypeError = window.ProgressEvent = window.Map = window.Set = page;
      const caught = (f) => { try { f(); return 'none'; } catch (e) { return e instanceof Own.DOMException ? e.name : e instanceof Own.TypeError ? 'TypeError' : e.name; } };
      const got = [
        caught(() => document.querySelector('!!')),
        caught(() => { const host = document.createElement('div'); host.attachShadow({ mode: 'open' }); host.attachShadow({ mode: 'open' }); }),
        caught(() => document.createElement('canvas').getContext('2d').createPattern(document.createElement('canvas'), 'nope')),
        caught(() => customElements.define('bad', class extends HTMLElement {})),
        caught(() => new DOMMatrix('garbage')),
        caught(() => performance.mark('navigationStart')),
        caught(() => getSelection().getRangeAt(5))
      ];
      const reader = new FileReader();
      reader.onloadend = (e) => { got.push(e.type, e.loaded); done(got); };
      reader.readAsText(new Blob(['abc']));
    JS
    expect(got).to eq(['SyntaxError', 'NotSupportedError', 'SyntaxError', 'SyntaxError', 'SyntaxError', 'SyntaxError', 'IndexSizeError', 'loadend', 3])
  end

  # …nor what a page put in HTMLElement, eval or console.error: custom-elements-es5-adapter's HTMLElement constructs
  # through the real one, a string timer handler is the platform's to compile, and the platform's report of an uncaught
  # exception is no call of a page's `console.error` (Chrome's goes to its devtools).
  it "defines elements, runs string timers and reports exceptions whatever a page put in HTMLElement, eval and console" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const Own = HTMLElement;
      window.HTMLElement = function HTMLElement() { return Reflect.construct(Own, [], this.constructor); };
      HTMLElement.prototype = Own.prototype;
      HTMLElement.prototype.constructor = HTMLElement;
      Object.setPrototypeOf(HTMLElement, Own);
      function MyEl() { return HTMLElement.call(this) || this; }
      MyEl.prototype = Object.create(HTMLElement.prototype, { constructor: { value: MyEl } });
      Object.setPrototypeOf(MyEl, HTMLElement);
      customElements.define('my-el', MyEl);
      const seen = [];
      window.eval = (code) => seen.push('page eval');
      console.error = () => seen.push('page console.error');
      addEventListener('error', (e) => e.preventDefault());
      setTimeout('window.ran = true', 0);
      setTimeout(() => { throw new Error('uncaught'); }, 0);
      setTimeout(() => done([document.createElement('my-el') instanceof MyEl, window.ran === true, seen]), 10);
    JS
    expect(got).to eq([true, true, []])
  end

  # …and a page's own later scripts run whatever it put in `eval`: Chrome compiles a classic script without calling it.
  it "runs a page's later scripts whatever it put in eval" do
    html = '<!DOCTYPE html><meta charset="utf-8"><body><script>window.seen = []; window.eval = (code) => seen.push(code);</script>' \
           '<script>window.ran = [1];</script><script>ran.push(2);</script>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s.execute_script("const el = document.createElement('script'); el.textContent = 'ran.push(3)'; document.body.append(el)")
    expect(s.evaluate_script('[window.ran, window.seen]')).to eq([[1, 2, 3], []])
  end

  # …and the platform's own clock, rects, matrices, text codecs and Blobs are its own: a page (a fake-timer library) that
  # replaced `Date.now` moves no `performance.now()`, and one that replaced DOMRect, DOMMatrix, TextDecoder or Blob gets
  # the platform's objects from the platform all the same.
  it "keeps its own clock, rects, matrices and codecs whatever a page made of the globals" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p id="p">x</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const Rect = DOMRect, Matrix = DOMMatrix;
        const before = performance.now();
        Date.now = () => 1e15;
        const boom = function () { throw new Error('page global'); };
        window.DOMRect = window.DOMMatrix = window.TextDecoder = window.TextEncoder = window.Blob = boom;
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.setTransform({ a: 2, d: 3 });
        return [
          performance.now() - before < 1e6,
          document.getElementById('p').getBoundingClientRect() instanceof Rect,
          ctx.getTransform() instanceof Matrix && ctx.getTransform().d === 3
        ];
      })()
    JS
    expect(got).to eq([true, true, true])
  end

  # …and of JSON and Date: a body's `json()`, `Response.json()`, a File's `lastModified` and an input's `valueAsDate`
  # are the platform's, whatever a page (a fake-timer library, a polyfill) put in those globals.
  it 'parses, serializes and dates its own values whatever a page put in JSON and Date' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><input id="d" type="date" value="2020-01-02">']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const kept = [JSON.parse, JSON.stringify, window.Date];
      JSON.parse = JSON.stringify = () => { throw new Error('page JSON'); };
      window.Date = function () { throw new Error('page Date'); };
      (async () => {
        const parsed = await new Response('{"a":1}').json();
        const made = await Response.json({b: 2}).text();
        const got = [parsed.a, made, typeof new File([], 'f').lastModified, d.valueAsDate.getUTCDate()];
        // (…the page's own put back for the teardown's checks, which are a page's scripts)
        [JSON.parse, JSON.stringify, window.Date] = kept;
        done(got);
      })().catch((e) => done(String(e)));
    JS
    expect(got).to eq([1, '{"b":2}', 'number', 2])
  end

  # …and of the driver's own scripts: `evaluate_script` compiles its code with the realm's JSON and eval as they began.
  it 'evaluates scripts whatever a page put in JSON.stringify and eval' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    s.execute_script('window.__kept = [JSON.stringify, window.eval]; JSON.stringify = () => "1"; window.eval = () => 2;')
    expect(s.evaluate_script('"x" + "y"')).to eq('xy')
    # (…the page's own put back for the teardown's checks, which are a page's scripts)
    s.execute_script('[JSON.stringify, window.eval] = window.__kept')
  end

  # …and of streams: a beacon refuses a stream body of any realm's — a frame's too — by its brand, not by an `instanceof`
  # of this realm's class.
  it "refuses a beacon a stream of another realm's is the body of" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], f = document.createElement('iframe');
      f.onload = () => {
        try { navigator.sendBeacon('/b', new f.contentWindow.ReadableStream()); done('none'); } catch (e) { done(e.name); }
      };
      f.src = '/frame';
      document.body.appendChild(f);
    JS
    expect(got).to eq('TypeError')
  end
end
