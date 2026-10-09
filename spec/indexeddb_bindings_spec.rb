# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# IndexedDB, generated from its IDL: every object a page holds — a factory, a connection, a transaction, a store, an
# index, a cursor, a request, a key range — is made by the platform alone, its state in slots, and a database's
# names come back as a DOMStringList. The engine behind them runs each transaction's requests a task apart, reverts
# what an aborted one wrote, and answers each realm's member on its own realm's objects.
RSpec.describe 'IndexedDB bindings' do
  let(:app) {
    lambda {|env|
      if env['PATH_INFO'] == '/worker.js'
        [200, {'content-type' => 'text/javascript'}, ['postMessage(1); postMessage(2);']]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><p>idb</p><iframe srcdoc="<p>frame</p>"></iframe>']]
      end
    }
  }

  def probe(session, script)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        'use strict';
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const settled = (request) => new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const open = (name, upgrade) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => upgrade(request.result);
          return settled(request);
        };
        #{script}
      })().then(done, (e) => done(`${e.name}: ${e.message}`));
    JS
  end

  it 'is what its IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const db = await open('shape', (db) => db.createObjectStore('books', { keyPath: 'id' }).createIndex('by_title', 'title'));
      const tx = db.transaction('books'), store = tx.objectStore('books');
      return {
        illegal:     [IDBDatabase, IDBTransaction, IDBObjectStore, IDBIndex, IDBRequest, IDBFactory].map((I) => err(() => new I())),
        factory:     indexedDB instanceof IDBFactory,
        ownKeys:     [db, tx, store, store.index('by_title')].map((o) => Reflect.ownKeys(o).length),
        className:   Object.prototype.toString.call(store),
        names:       db.objectStoreNames instanceof DOMStringList,
        same:        tx.objectStore('books') === store,
        storeNames:  [db.objectStoreNames.length, db.objectStoreNames.item(0), db.objectStoreNames.contains('books')],
        indexNames:  [...store.indexNames],
        range:       [IDBKeyRange.bound(1, 3, true).lowerOpen, err(() => IDBKeyRange.bound(3, 1))]
      };
    JS
    expect(out).to eq(
      'illegal'    => %w[TypeError TypeError TypeError TypeError TypeError TypeError],
      'factory'    => true,
      'ownKeys'    => [0, 0, 0, 0],
      'className'  => '[object IDBObjectStore]',
      'names'      => true,
      'same'       => true,
      'storeNames' => [1, 'books', true],
      'indexNames' => ['by_title'],
      'range'      => [true, 'DataError']
    )
  end

  it 'writes, reads back through an index and a cursor, and reverts an aborted transaction' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const db = await open('books', (db) => {
        db.createObjectStore('books', { keyPath: 'id', autoIncrement: true }).createIndex('by_author', 'author');
      });
      const write = db.transaction('books', 'readwrite');
      const keys = await Promise.all([
        settled(write.objectStore('books').add({ title: 'Kokoro', author: 'Soseki' })),
        settled(write.objectStore('books').add({ title: 'Botchan', author: 'Soseki' })),
        settled(write.objectStore('books').add({ title: 'Rashomon', author: 'Akutagawa' }))
      ]);
      const read = db.transaction('books').objectStore('books');
      const bySoseki = await settled(read.index('by_author').getAll('Soseki'));
      const titles = [];
      await new Promise((resolve) => {
        read.openCursor(null, 'prev').onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return resolve();
          titles.push(cursor.value.title);
          cursor.continue();
        };
      });
      const aborted = db.transaction('books', 'readwrite');
      aborted.objectStore('books').clear();
      const abort = new Promise((resolve) => aborted.onabort = resolve);
      aborted.abort();
      await abort;
      const after = await settled(db.transaction('books').objectStore('books').count());
      return { keys, bySoseki: bySoseki.map((b) => b.title), titles, after, error: err(() => aborted.objectStore('books')) };
    JS
    expect(out).to eq(
      'keys'     => [1, 2, 3],
      'bySoseki' => %w[Kokoro Botchan],
      'titles'   => %w[Rashomon Botchan Kokoro],
      'after'    => 3,
      'error'    => 'InvalidStateError'
    )
  end

  it 'ends a transaction a script the host ran made, with the script' do
    session = simulated_session(app)
    session.visit '/'
    probe(session, <<~JS)
      window.db = await open('host', (db) => db.createObjectStore('s'));
      const tx = db.transaction('s', 'readwrite');
      [1, 2, 3].forEach((n) => tx.objectStore('s').put(n, n));
      await new Promise((resolve) => tx.oncomplete = resolve);
    JS
    session.execute_script(<<~JS)
      window.tx = db.transaction('s', 'readwrite');
      setTimeout(() => { try { tx.objectStore('s').put(4, 4); window.late = 'none'; } catch (e) { window.late = e.name; } });
    JS
    walked = session.evaluate_async_script(<<~JS)
      const done = arguments[0], keys = [];
      const request = db.transaction('s').objectStore('s').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return done(keys);
        keys.push(cursor.key);
        cursor.continue();
      };
      request.transaction.onabort = () => done('aborted');
    JS
    expect([session.evaluate_script('window.late'), walked]).to eq(['TransactionInactiveError', [1, 2, 3]])
  end

  it "ends a transaction another realm's connection made with the task that made it" do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const request = frames[0].indexedDB.open('framed', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('s');
      const db = await settled(request);
      const tick = () => new Promise((resolve) => setTimeout(resolve));
      let tx;
      await new Promise((resolve) => setTimeout(() => { tx = db.transaction('s', 'readwrite'); resolve(); }));
      await tick();
      return err(() => tx.objectStore('s').put(1, 1));
    JS
    expect(out).to eq('TransactionInactiveError')
  end

  it 'ends a transaction made in one message task before the next' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const db = await open('messages', (db) => db.createObjectStore('s'));
      let tx;
      return new Promise((resolve) => {
        new Worker('/worker.js').onmessage = (e) => {
          if (e.data === 1) tx = db.transaction('s', 'readwrite');
          else resolve(err(() => tx.objectStore('s').put(1, 1)));
        };
      });
    JS
    expect(out).to eq('TransactionInactiveError')
  end

  it "leaves a script's microtasks to its end while it builds a frame" do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        const log = [];
        Promise.resolve().then(() => log.push('micro'));
        const frame = document.createElement('iframe');
        frame.srcdoc = '<p>x';
        document.body.append(frame);
        frame.contentWindow;
        log.push('sync');
        return log;
      })()
    JS
    expect(out).to eq(['sync'])
  end

  it "returns a script's value as the script left it, its microtasks after" do
    session = simulated_session(app)
    session.visit '/'
    expect(session.evaluate_script('(() => { const a = [1]; Promise.resolve().then(() => a.push(2)); return a; })()')).to eq([1])
  end

  it 'takes a commit a listener made, and runs a target’s capture listeners first' do
    session = simulated_session(app)
    session.visit '/'
    out = probe(session, <<~JS)
      const db = await open('commit', (db) => db.createObjectStore('s'));
      const tx = db.transaction('s', 'readwrite');
      tx.objectStore('s').add(1, 1);
      // (…an error no listener canceled, on a transaction the listener committed: it completes)
      tx.objectStore('s').add(2, 1).onerror = () => tx.commit();
      const outcome = await new Promise((resolve) => { tx.oncomplete = () => resolve('complete'); tx.onabort = () => resolve('abort'); });
      const target = new EventTarget(), order = [];
      target.addEventListener('x', () => order.push('bubble'));
      target.addEventListener('x', () => order.push('capture'), true);
      target.dispatchEvent(new Event('x'));
      return { outcome, order };
    JS
    expect(out).to eq('outcome' => 'complete', 'order' => %w[capture bubble])
  end

  it 'runs a step’s worth of a chain of tasks at one instant, however many turns it takes' do
    session = simulated_session(app)
    session.visit '/'
    probe(session, <<~JS)
      const db = await open('spin', (db) => db.createObjectStore('s'));
      const tx = db.transaction('s');
      window.spins = 0;
      (function spin() { tx.objectStore('s').get(0).onsuccess = () => { window.spins++; spin(); }; })();
    JS
    # (…read clock-free: an evaluation steps the event loop first, its own tasks counted with the frame's)
    before = session.driver.peek_script('window.spins')
    session.driver.run_event_loop_frame(16)
    # (…a step's worth at the frame's instant — not one per turn, 512 of them — and another as its clock advances)
    spins = session.driver.peek_script('window.spins') - before
    expect(spins).to be_between(1, 2 * Capybara::Simulated::Browser::RUN_LOOP_MAX_ITER)
  end
end
