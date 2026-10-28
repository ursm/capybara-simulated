require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# The structured clone (HTML §2.7), V8's own serializer (clone.rs) with the bindings saying what each platform object
# serializes to: the JavaScript values with their cycles and shared references; a DOMException — any realm's — made
# this realm's again with its name and message (a QuotaExceededError with its quota); a platform object that is not
# [Serializable], a DataCloneError; a transfer list's ArrayBuffers and ports moved; and a FileList — the one
# [Serializable] legacy platform object — made natively (legacy.rs), since V8's serializer takes no Proxy.
RSpec.describe 'Structured clone of platform objects' do
  let(:app) {
    lambda do |env|
      case env['PATH_INFO']
      when '/echo.js'
        [200, {'content-type' => 'text/javascript'}, ["onmessage = (e) => postMessage([e.data, new QuotaExceededError('wq', { quota: 3, requested: 4 })]);"]]
      when '/refuse.js'
        [200, {'content-type' => 'text/javascript'}, ['try { structuredClone(() => 1); } catch (e) { postMessage(e.message); }']]
      when '/popup'
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><script>window.got = []; onmessage = (e) => got.push(e.data.byteLength);</script>']]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x<iframe srcdoc="y"></iframe>']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'serializes a DOMException and refuses what is not serializable' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const c = structuredClone(new DOMException('m', 'AbortError'));
        const f = structuredClone(new frames[0].DOMException('n', 'NotFoundError'));
        const q = structuredClone(new QuotaExceededError('q', { quota: 5 }));
        const refused = [location, document.body.classList, new AbortController()]
          .map((v) => { try { structuredClone(v); return 'cloned'; } catch (e) { return e.name; } });
        return [[c instanceof DOMException, c.name, c.message, c.code], [f instanceof DOMException, f.code],
                [q instanceof QuotaExceededError, q.quota], refused];
      })()
    JS
    expect(got).to eq([[true, 'AbortError', 'm', 20], [true, 8], [true, 5], %w[DataCloneError DataCloneError DataCloneError]])
  end

  it "carries a DOMException and an Error of any realm to a worker and back as the clone does" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], w = new Worker('/echo.js');
      w.onmessage = (e) => {
        const [[f, t, q], back] = e.data;
        done([[f instanceof DOMException, f.name, f.message, f.code], [t instanceof TypeError, t.message],
              [q instanceof QuotaExceededError, q.quota, q.requested], [back instanceof QuotaExceededError, back.quota, back.requested]]);
      };
      w.postMessage([new frames[0].DOMException('fm', 'NotFoundError'), new frames[0].TypeError('t'),
                     new QuotaExceededError('qm', { quota: 5, requested: 6 })]);
    JS
    expect(got).to eq([[true, 'NotFoundError', 'fm', 8], [true, 't'], [true, 5, 6], [true, 3, 4]])
  end

  def probe(script)
    session.evaluate_script("(() => { 'use strict'; const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } }; #{script} })()")
  end

  it 'keeps cycles and shared references, and takes a platform object by what it is' do
    session.visit '/'
    out = probe(<<~JS)
      const shared = { n: 1 }, cyclic = { shared, again: shared };
      cyclic.self = cyclic;
      const copy = structuredClone(cyclic);
      class Point { constructor() { this.x = 1; } }
      const values = structuredClone([new DOMRect(1, 2, 3, 4), new Map([[1, 'a']]), new Point()]);
      return {
        cycle:  copy.self === copy,
        shared: copy.shared === copy.again && copy.shared !== shared,
        rect:   [values[0] instanceof DOMRect, values[0].width],
        map:    values[1].get(1),
        plain:  Object.getPrototypeOf(values[2]) === Object.prototype,
        event:  err(() => structuredClone(new Event('x'))),
        node:   err(() => structuredClone(document.body)),
        fn:     err(() => structuredClone(() => 1))
      };
    JS
    expect(out).to eq(
      'cycle'  => true,
      'shared' => true,
      'rect'   => [true, 3],
      'map'    => 'a',
      'plain'  => true,
      'event'  => 'DataCloneError',
      'node'   => 'DataCloneError',
      'fn'     => 'DataCloneError'
    )
  end

  it 'transfers an ArrayBuffer and a MessagePort' do
    session.visit '/'
    out = probe(<<~JS)
      const buffer = new Uint8Array([1, 2, 3]).buffer, { port1 } = new MessageChannel();
      const copy = structuredClone({ view: new Uint8Array(buffer, 1), port: port1 }, { transfer: [buffer, port1] });
      return {
        detached: buffer.detached,
        view:     Array.from(copy.view),
        port:     copy.port instanceof MessagePort && copy.port !== port1,
        twice:    err(() => structuredClone(1, { transfer: [copy.port, copy.port] }))
      };
    JS
    expect(out).to eq('detached' => true, 'view' => [2, 3], 'port' => true, 'twice' => 'DataCloneError')
  end

  it 'makes a FileList a legacy platform object, and clones its files' do
    session.visit '/'
    out = probe(<<~JS)
      const transfer = new DataTransfer();
      transfer.items.add(new File(['one'], 'a.txt', { type: 'text/plain' }));
      const files = transfer.files, copy = structuredClone(files), own = Object.getOwnPropertyDescriptor(files, '0');
      return {
        own:        [own.writable, own.enumerable, own.configurable],
        keys:       Object.keys(files),
        has:        [0 in files, 1 in files],
        past:       files[1],
        delete:     err(() => { delete files[0]; }),
        deletePast: delete files[1],
        set:        err(() => { files[0] = null; }),
        define:     err(() => Object.defineProperty(files, '1', { value: 1 })),
        list:       copy instanceof FileList && copy !== files,
        file:       [copy[0] instanceof File, copy[0].name, copy.length]
      };
    JS
    expect(out).to eq(
      'own'        => [false, true, true],
      'keys'       => ['0'],
      'has'        => [true, false],
      'past'       => nil,
      'delete'     => 'TypeError',
      'deletePast' => true,
      'set'        => 'TypeError',
      'define'     => 'TypeError',
      'list'       => true,
      'file'       => [true, 'a.txt', 1]
    )
  end

  # (…a WebAssembly.Memory's buffer, which cannot be detached, DetachArrayBuffer's TypeError as the transfer reaches it —
  # after the value is serialized, those before it in the list moved: HTML StructuredSerializeWithTransfer; Chrome 156
  # the same; WPT wasm/serialization/arraybuffer/transfer.window.js)
  it 'checks a transfer list before and after serializing, and moves nothing it refuses' do
    session.visit '/'
    out = probe(<<~JS)
      const memory = new WebAssembly.Memory({ initial: 1 }), kept = new ArrayBuffer(4), late = new ArrayBuffer(4);
      const before = new ArrayBuffer(8), after = new ArrayBuffer(8);
      const fake = { [Symbol.toStringTag]: 'ArrayBuffer' };
      let ran = false;
      return {
        wasm:     [err(() => structuredClone(memory.buffer, { transfer: [memory.buffer] })), memory.buffer.detached],
        order:    [err(() => structuredClone({ get x() { ran = true; return 1; } }, { transfer: [before, memory.buffer, after] })),
                   ran, before.detached, after.detached],
        first:    err(() => structuredClone(() => 1, { transfer: [memory.buffer] })),
        fake:     [err(() => structuredClone(1, { transfer: [kept, fake] })), kept.detached],
        detached: err(() => structuredClone({ get x() { structuredClone(late, { transfer: [late] }); return 1; } }, { transfer: [late] }))
      };
    JS
    expect(out).to eq(
      'wasm'     => ['TypeError', false],
      'order'    => ['TypeError', true, true, false],
      'first'    => 'DataCloneError',
      'fake'     => ['DataCloneError', false],
      'detached' => 'DataCloneError'
    )
  end

  it "keeps a FileList's files the Files the value holds, and builds its descriptors as data" do
    session.visit '/'
    out = probe(<<~JS)
      const transfer = new DataTransfer();
      transfer.items.add(new File(['one'], 'a.txt'));
      const files = transfer.files, [list, file] = structuredClone([files, files[0]]);
      let called = 0;
      Object.defineProperty(Object.prototype, 'enumerable', { set() { called++; }, configurable: true });
      const own = Object.getOwnPropertyDescriptor(files, '0');
      delete Object.prototype.enumerable;
      return { same: list[0] === file, enumerable: own.enumerable, called };
    JS
    expect(out).to eq('same' => true, 'enumerable' => true, 'called' => 0)
  end

  it "clones a page's object whatever class string it claims, and reads a frame's message back in the frame" do
    session.visit '/'
    session.evaluate_script('new Promise((resolve) => (frames[0].document.readyState === "complete" ? resolve() : frames[0].onload = resolve))')
    out = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      class Spoof { get [Symbol.toStringTag]() { return 'Window'; } }
      const spoofed = structuredClone(new Spoof());
      createImageBitmap(new ImageData(1, 1)).then((bitmap) => {
        const stream = new ReadableStream({ start(c) { c.enqueue('chunk'); c.close(); } });
        frames[0].onmessage = (e) => e.data.stream.getReader().read().then(({ value }) => done({
          spoof:  Object.getPrototypeOf(spoofed) === Object.prototype,
          realm:  e.data instanceof frames[0].Object,
          bitmap: [e.data.bitmap instanceof frames[0].ImageBitmap, e.data.bitmap.width, bitmap.width],
          stream: [e.data.stream instanceof frames[0].ReadableStream, value, stream.locked]
        }));
        frames[0].postMessage({ n: 1, bitmap, stream }, '*', [bitmap, stream]);
      });
    JS
    expect(out).to eq('spoof' => true, 'realm' => true, 'bitmap' => [true, 1, 0], 'stream' => [true, 'chunk', true])
  end

  it "carries a value's Maps, Dates, cycles and shared references to a worker and back, its buffers moved" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], w = new Worker('/echo.js');
      const shared = { n: 1 }, value = { map: new Map([['k', shared]]), at: new Date(5), shared, big: 2n ** 64n };
      value.self = value;
      const buffer = new Uint8Array([1, 2, 3]).buffer;
      w.onmessage = (e) => {
        const [back] = e.data;
        done({
          map:      back.map instanceof Map && back.map.get('k') === back.shared,
          date:     back.at instanceof Date && back.at.getTime(),
          cycle:    back.self === back,
          big:      String(back.big),
          buffer:   Array.from(new Uint8Array(back.buffer)),
          detached: buffer.detached
        });
      };
      value.buffer = buffer;
      w.postMessage(value, [buffer]);
    JS
    expect(got).to eq('map' => true, 'date' => 5, 'cycle' => true, 'big' => '18446744073709551616', 'buffer' => [1, 2, 3], 'detached' => true)
  end

  it "carries a large message to another window, and refuses in a worker in Chrome's words" do
    session.visit '/'
    refused = session.evaluate_async_script("new Worker('/refuse.js').onmessage = (e) => arguments[0](e.data);")
    session.execute_script("window.popup = window.open('/popup');")
    session.switch_to_window(session.windows.last)
    session.evaluate_script('window.got')
    session.switch_to_window(session.windows.first)
    session.execute_script("popup.postMessage(new Uint8Array(100000), '*'); popup.postMessage(new Uint8Array(10), '*');")
    session.switch_to_window(session.windows.last)
    got = session.evaluate_script('window.got')
    expect([got, refused]).to eq([[100_000, 10], "Failed to execute 'structuredClone' on 'WorkerGlobalScope': () => 1 could not be cloned."])
  end

  # The WebAssembly JS API's serialization steps: a WebAssembly.Module shares its compiled module — the same module
  # read back, in any realm of the agent — but serialized for storage (an IndexedDB record) it is a DataCloneError.
  it 'shares a WebAssembly.Module, and refuses one for storage' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
        const m = new WebAssembly.Module(bytes);
        const c = structuredClone({m}).m;
        const f = new frames[0].Function('v', 'return structuredClone(v)')(m);
        return [c instanceof WebAssembly.Module, c !== m, WebAssembly.Module.exports(c).length,
                f instanceof frames[0].WebAssembly.Module];
      })()
    JS
    expect(got).to eq([true, true, 0, true])
    stored = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const open = indexedDB.open('wasm');
      open.onupgradeneeded = () => open.result.createObjectStore('s');
      open.onsuccess = () => {
        const store = open.result.transaction('s', 'readwrite').objectStore('s');
        try { store.put(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), 1); done('stored'); } catch (e) { done(e.name); }
      };
    JS
    expect(stored).to eq('DataCloneError')
  end

  # …and in Chrome's words, as each operation reports it.
  it 'refuses a WebAssembly.Module for storage in the words of the operation' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      const words = [];
      try { history.pushState(m, '') } catch (e) { words.push(e.message) }
      const open = indexedDB.open('wasm-words');
      open.onupgradeneeded = () => open.result.createObjectStore('s');
      open.onsuccess = () => {
        const store = open.result.transaction('s', 'readwrite').objectStore('s');
        try { store.put(m, 1) } catch (e) { words.push(e.message) }
        done(words);
      };
    JS
    expect(got).to eq([
      "Failed to execute 'pushState' on 'History': A WebAssembly.Module can not be serialized for storage.",
      "Failed to execute 'put' on 'IDBObjectStore': A WebAssembly.Module can not be serialized for storage."
    ])
  end

  # The WebAssembly JS API's deserialization steps: a module is read back in the agent cluster it was serialized in
  # alone — a frame of another site's, or of an opaque origin, gets a `messageerror` (Chrome: 127.0.0.1 → localhost, and
  # a sandboxed frame), one of the same site the module, its origin another or not.
  it "posts a WebAssembly.Module to a frame of the agent cluster alone" do
    frames_app = lambda do |env|
      case env['PATH_INFO']
      when '/child'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><script>
            addEventListener('message', (e) => parent.postMessage('message ' + (e.data instanceof WebAssembly.Module), '*'));
            addEventListener('messageerror', (e) => parent.postMessage('messageerror ' + e.data, '*'));
          </script>
        HTML
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><script>window.got = []; addEventListener('message', (e) => got.push(e.data));</script>
          <iframe id="same" src="/child"></iframe><iframe id="sibling" src="http://other.example.com/child"></iframe>
          <iframe id="other" src="http://www.other.test/child"></iframe>
          <iframe id="opaque" sandbox="allow-scripts" src="/child"></iframe>
        HTML
      end
    end
    s = simulated_session(frames_app)
    s.visit '/'
    s.execute_script(<<~JS)
      const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      for (const id of ['same', 'sibling', 'other', 'opaque']) document.getElementById(id).contentWindow.postMessage(m, '*');
    JS
    poll_until { s.evaluate_script('got.length') == 4 }

    expect(s.evaluate_script('got').sort).to eq(['message true', 'message true', 'messageerror null', 'messageerror null'])
  end

  # …keyed by ORIGIN in a cross-origin isolated group (HTML "obtain a similar-origin window agent"): a same-site frame of
  # another origin is another agent cluster there.
  it 'keys the agent cluster by origin in a cross-origin isolated page' do
    isolated = {
      'cross-origin-opener-policy'   => 'same-origin',
      'cross-origin-embedder-policy' => 'require-corp',
      'cross-origin-resource-policy' => 'cross-origin'
    }
    coi_app = lambda do |env|
      case env['PATH_INFO']
      when '/child'
        [200, {'content-type' => 'text/html', **isolated}, [<<~HTML]]
          <!doctype html><script>
            addEventListener('message', (e) => parent.postMessage('message ' + (e.data instanceof WebAssembly.Module), '*'));
            addEventListener('messageerror', () => parent.postMessage('messageerror', '*'));
          </script>
        HTML
      else
        [200, {'content-type' => 'text/html', **isolated}, [<<~HTML]]
          <!doctype html><script>window.got = []; addEventListener('message', (e) => got.push(e.data));</script>
          <iframe id="same" src="/child"></iframe><iframe id="sibling" src="http://other.example.com/child"></iframe>
        HTML
      end
    end
    s = simulated_session(coi_app)
    s.visit '/'
    expect(s.evaluate_script('crossOriginIsolated')).to be(true)
    s.execute_script(<<~JS)
      const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      for (const id of ['same', 'sibling']) document.getElementById(id).contentWindow.postMessage(m, '*');
    JS
    poll_until { s.evaluate_script('got.length') == 2 }

    expect(s.evaluate_script('got').sort).to eq(['message true', 'messageerror'])
  end

  # …in its browsing context group alone (HTML keeps an agent cluster map per group): a pop-up opened with an opener
  # shares the page's, one opened `noopener` is a group of its own — its BroadcastChannel gets a `messageerror`.
  it 'shares a WebAssembly.Module with a pop-up of its browsing context group alone' do
    popup_app = lambda do |env|
      case env['PATH_INFO']
      when '/popup'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><script>
            const report = new BroadcastChannel('report'), wasm = new BroadcastChannel('wasm');
            const who = location.search.slice(1);
            wasm.onmessage = (e) => report.postMessage(who + ' message ' + (e.data instanceof WebAssembly.Module));
            wasm.onmessageerror = () => report.postMessage(who + ' messageerror');
            report.postMessage(who + ' ready');
          </script>
        HTML
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><script>window.got = []; new BroadcastChannel("report").onmessage = (e) => got.push(e.data);</script>']]
      end
    end
    s = simulated_session(popup_app)
    s.visit '/'
    s.execute_script("window.open('/popup?opener'); window.open('/popup?noopener', '', 'noopener')")
    poll_until { s.evaluate_script('got.length') == 2 }
    s.execute_script("new BroadcastChannel('wasm').postMessage(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])))")
    # (…each pop-up's event loop run as its window is: a background window's turns are the driver's to take)
    poll_until do
      s.windows.each {|w| s.within_window(w) { s.evaluate_script('1') } }
      s.evaluate_script('got.length') == 4
    end

    expect(s.evaluate_script('got').sort).to eq(['noopener messageerror', 'noopener ready', 'opener message true', 'opener ready'])
  end

  # …and over a MessagePort whose other end a frame of another site holds, read back in THAT frame's realm (Chrome:
  # "port messageerror").
  it 'posts a WebAssembly.Module over a port to the agent cluster of the realm holding its other end' do
    port_app = lambda do |env|
      case env['PATH_INFO']
      when '/child'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><script>
            onmessage = (e) => {
              const port = e.ports[0];
              port.onmessage = (m) => parent.postMessage('port message ' + (m.data instanceof WebAssembly.Module), '*');
              port.onmessageerror = (m) => parent.postMessage('port messageerror ' + m.data, '*');
              parent.postMessage('port ready', '*');
            };
          </script>
        HTML
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><script>window.got = []; addEventListener('message', (e) => got.push(e.data));</script>
          <iframe id="same" src="/child"></iframe><iframe id="other" src="http://www.other.test/child"></iframe>
        HTML
      end
    end
    s = simulated_session(port_app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.channels = {};
      for (const id of ['same', 'other']) {
        channels[id] = new MessageChannel();
        document.getElementById(id).contentWindow.postMessage('take', '*', [channels[id].port2]);
      }
    JS
    poll_until { s.evaluate_script('got.length') == 2 }
    s.execute_script(<<~JS)
      const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      for (const id of ['same', 'other']) channels[id].port1.postMessage(m);
    JS
    poll_until { s.evaluate_script('got.length') == 4 }

    expect(s.evaluate_script('got').sort).to eq(['port message true', 'port messageerror null', 'port ready', 'port ready'])
    # (…one posted BEFORE the port went to the frame too: it is read as its task runs, by the realm holding the port then
    # — Chrome: "port messageerror")
    s.execute_script(<<~JS)
      got.length = 0;
      const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      for (const id of ['same', 'other']) {
        const channel = new MessageChannel();
        channel.port1.postMessage(m);
        document.getElementById(id).contentWindow.postMessage('take', '*', [channel.port2]);
      }
    JS
    poll_until { s.evaluate_script('got.length') == 4 }

    expect(s.evaluate_script('got').sort).to eq(['port message true', 'port messageerror null', 'port ready', 'port ready'])
  end

  # …and to another isolate by its compiled module's token (clone.rs `MODULES`): a dedicated worker, of its owner's
  # agent cluster, reads it back and posts it home; a shared worker, an agent cluster of its own, gets a `messageerror`
  # (WPT wasm/serialization/module window-sharedworker-failure).
  it 'carries a WebAssembly.Module to a dedicated worker and back, and not to a shared one' do
    worker_app = lambda do |env|
      case env['PATH_INFO']
      when '/shared.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          onconnect = (e) => {
            const port = e.ports[0];
            port.onmessage = () => port.postMessage('message');
            port.onmessageerror = () => port.postMessage('messageerror');
          };
        JS
      else app.call(env)
      end
    end
    s = simulated_session(worker_app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = [];
      const m = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      const w = new Worker('/echo.js');
      w.onmessage = (e) => got.push('dedicated ' + (e.data[0].m instanceof WebAssembly.Module && e.data[0].m !== m));
      w.postMessage({m});
      const shared = new SharedWorker('/shared.js');
      shared.port.onmessage = (e) => got.push('shared ' + e.data);
      shared.port.postMessage({m});
    JS
    poll_until { s.evaluate_script('got.length') == 2 }

    expect(s.evaluate_script('got').sort).to eq(['dedicated true', 'shared messageerror'])
  end
end
