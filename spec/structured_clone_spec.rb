require 'capybara/simulated'
require_relative 'support/session_teardown'

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

  it 'checks a transfer list before and after serializing, and moves nothing it refuses' do
    session.visit '/'
    out = probe(<<~JS)
      const memory = new WebAssembly.Memory({ initial: 1 }), kept = new ArrayBuffer(4), late = new ArrayBuffer(4);
      const fake = { [Symbol.toStringTag]: 'ArrayBuffer' };
      return {
        wasm:     [err(() => structuredClone(memory.buffer, { transfer: [memory.buffer] })), memory.buffer.detached],
        fake:     [err(() => structuredClone(1, { transfer: [kept, fake] })), kept.detached],
        detached: err(() => structuredClone({ get x() { structuredClone(late, { transfer: [late] }); return 1; } }, { transfer: [late] }))
      };
    JS
    expect(out).to eq('wasm' => ['DataCloneError', false], 'fake' => ['DataCloneError', false], 'detached' => 'DataCloneError')
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
end
