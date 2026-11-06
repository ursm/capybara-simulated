# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Each document of the page is a new environment (HTML "create and initialize a Document object": a new environment
# settings object, its id a new unique one) — the page's realm is reused across its documents, its client id is not: the
# id the navigation reserved, which a controlling service worker sees as `event.resultingClientId`, is the one the
# document it commits is then (`e.source.id`, `clients.get`), and the document it replaced is no client any more —
# `clients.get` of its id finds none, `clients.matchAll()` lists it no more, and a message posted to it is delivered to
# none. (Service Workers "Handle Fetch": the request's reserved client; "Handle Service Worker Client Unload".)
RSpec.describe "the page's service-worker client" do
  let(:worker) {
    <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      const resulting = {}, got = {};
      self.addEventListener('fetch', e => {
        if (e.request.mode !== 'navigate') return;
        const path = new URL(e.request.url).pathname;
        resulting[path] = e.resultingClientId;
        // (…the reserved client, which `get` waits on until the document commits, or the navigation makes none)
        e.waitUntil(self.clients.get(e.resultingClientId).then(c => { got[path] = c ? c.url : null; }));
      });
      self.addEventListener('message', e => {
        // (…the id its own global holds a lock by)
        if (e.data.lock) {
          e.waitUntil(navigator.locks.request('sw', () => navigator.locks.query()).then(q => e.source.postMessage({held: q.held.map(l => l.clientId)})));
          return;
        }
        e.waitUntil((async () => {
          const old = e.data.old;
          const gone = old ? await self.clients.get(old) : null;
          if (old) {
            const stale = await self.clients.get(old);
            if (stale) stale.postMessage('to the old document');
          }
          const all = await self.clients.matchAll({includeUncontrolled: true});
          e.source.postMessage({
            id: e.source.id, resulting, got, ids: all.map(c => c.id), oldFound: gone !== undefined && gone !== null
          });
        })());
      });
    JS
  }
  let(:app) {
    sw = worker
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/none' then [204, {}, []]
        else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
        end
      }
    }.to_app
  }

  # (…what the worker says of the asking document, `old` the id of a document before it)
  def ask(session, old = nil)
    session.execute_script(<<~JS)
      globalThis.__report = null;
      globalThis.__heard = [];
      navigator.serviceWorker.onmessage = e => {
        if (typeof e.data === 'string') globalThis.__heard.push(e.data); else globalThis.__report = e.data;
      };
      navigator.serviceWorker.ready.then(r => r.active.postMessage({old: #{old.to_json}}));
    JS
    poll_until { session.evaluate_script('globalThis.__report') }
  end

  it 'is a new one for each document, the one its navigation reserved, the last one gone' do
    session = simulated_session(app)
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js').then(r => navigator.serviceWorker.ready)")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    first = ask(session)

    session.visit '/b'
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    second = ask(session, first['id'])

    expect(second['id']).not_to eq(first['id'])
    expect(second['resulting']['/b']).to eq(second['id'])
    expect(second['ids']).to include(second['id'])
    expect(second['ids']).not_to include(first['id'])
    expect(second['oldFound']).to be(false)
    expect(session.evaluate_script('globalThis.__heard')).to eq([])

    # (…a reload too: the same URL, a new document)
    session.refresh
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    third = ask(session, second['id'])
    expect(third['id']).not_to eq(second['id'])
    expect(third['ids']).not_to include(second['id'])
    expect(third['resulting']['/b']).to eq(third['id'])
  end

  # (…`clients.get(event.resultingClientId)` in the navigation's fetch handler waits for the document — Service Workers
  # §4.4.1: until the client is execution ready, or discarded — none for a navigation that makes no document)
  it "is what clients.get of the navigation's resultingClientId resolves to, once its document commits" do
    session = simulated_session(app)
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js').then(r => navigator.serviceWorker.ready)")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    session.visit '/b'
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    expect(poll_until { ask(session)['got']['/b'] }).to eq('http://www.example.com/b')

    session.execute_script("location.href = '/none'")
    report = poll_until { r = ask(session); r['got'].key?('/none') && r }
    expect([report['got']['/none'], session.current_path]).to eq([nil, '/b'])
    expect(report['ids']).to eq([report['id']])
  end

  # (…and a service worker's global an environment of its own, its id its own — not the page's, nor the realm-numbered
  # key of the window, which names the page's realm)
  it "is not a service worker's own id" do
    session = simulated_session(app)
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    page = ask(session)['id']
    session.execute_script(<<~JS)
      globalThis.__held = null;
      navigator.serviceWorker.onmessage = e => { if (e.data.held) globalThis.__held = e.data.held; };
      navigator.serviceWorker.ready.then(r => r.active.postMessage({lock: true}));
    JS
    held = poll_until { session.evaluate_script('globalThis.__held') }
    expect(held.size).to eq(1)
    expect(held.first).not_to eq(page)
    expect(held.first).not_to match(/\Aclient-\d+\z/)
  end
end
