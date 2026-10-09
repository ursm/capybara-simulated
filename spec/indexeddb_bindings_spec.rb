# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# IndexedDB, generated from its IDL: every object a page holds — a factory, a connection, a transaction, a store, an
# index, a cursor, a request, a key range — is made by the platform alone, its state in slots, and a database's
# names come back as a DOMStringList. The engine behind them runs each transaction's requests a task apart, reverts
# what an aborted one wrote, and answers each realm's member on its own realm's objects.
RSpec.describe 'IndexedDB bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><p>idb</p>']]
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
