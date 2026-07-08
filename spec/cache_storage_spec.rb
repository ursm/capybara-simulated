# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# Cache Storage API (`caches` / `Cache`) — the WindowOrWorkerGlobalScope surface backed by
# the Ruby-side origin-partitioned store. Exercises the CacheStorage lifecycle, put/match
# round-trips (including a binary body), request matching (ignoreSearch / Vary), delete,
# and add/addAll fetching a real Rack resource.
RSpec.describe 'Cache Storage API' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'       then [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
        when '/asset'  then [200, {'content-type' => 'text/plain'}, ['ASSET BODY']]
        when '/vary'   then [200, {'content-type' => 'text/plain', 'vary' => 'Accept'}, ['varied']]
        else                [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  # Run `js` (which must set globalThis.__r to a value or a promise) and return the parsed
  # result. Awaits a promise via a settle poll.
  def run_async(session, js)
    session.execute_script("globalThis.__done = false; Promise.resolve((async () => { #{js} })()).then(v => { globalThis.__r = v; globalThis.__done = true; }, e => { globalThis.__r = {__err: String(e && e.name || e)}; globalThis.__done = true; });")
    10.times do
      break if session.evaluate_script('globalThis.__done === true')
      sleep 0.02
    end
    JSON.parse(session.evaluate_script('JSON.stringify(globalThis.__r)'))
  end

  it 'exposes caches / Cache / CacheStorage globals' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      JSON.stringify({
        hasCaches:  'caches' in self,
        isStorage:  caches instanceof CacheStorage,
        hasCacheCtor: typeof Cache === 'function'
      })
    JS
    r = JSON.parse(out)
    expect(r['hasCaches']).to be true
    expect(r['isStorage']).to be true
    expect(r['hasCacheCtor']).to be true
  end

  it 'open/has/keys/delete track the cache set in creation order' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      await caches.open('v1');
      await caches.open('v2');
      const hasV1     = await caches.has('v1');
      const hasNope   = await caches.has('nope');
      const keys      = await caches.keys();
      const deleted   = await caches.delete('v1');
      const keysAfter = await caches.keys();
      const delAgain  = await caches.delete('v1');
      return {hasV1, hasNope, keys, deleted, keysAfter, delAgain};
    JS
    expect(r['hasV1']).to be true
    expect(r['hasNope']).to be false
    expect(r['keys']).to eq(%w[v1 v2])
    expect(r['deleted']).to be true
    expect(r['keysAfter']).to eq(%w[v2])
    expect(r['delAgain']).to be false
  end

  it 'put/match round-trips a Response with headers and status' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('c');
      await c.put('/thing', new Response('hello cache', {status: 201, statusText: 'Created', headers: {'X-Foo': 'bar'}}));
      const m = await c.match('/thing');
      return {
        found:  !!m,
        status: m.status,
        statusText: m.statusText,
        body:   await m.text(),
        foo:    m.headers.get('x-foo'),
        miss:   (await c.match('/absent')) === undefined
      };
    JS
    expect(r['found']).to be true
    expect(r['status']).to eq(201)
    expect(r['statusText']).to eq('Created')
    expect(r['body']).to eq('hello cache')
    expect(r['foo']).to eq('bar')
    expect(r['miss']).to be true
  end

  it 'preserves a binary body byte-for-byte through put/match' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
      const c = await caches.open('bin');
      await c.put('/blob', new Response(bytes));
      const m = await c.match('/blob');
      const back = new Uint8Array(await m.arrayBuffer());
      return {len: back.length, vals: Array.from(back)};
    JS
    expect(r['vals']).to eq([0, 1, 2, 250, 251, 255])
  end

  it 'match honours ignoreSearch and put replaces a same-key entry' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('q');
      await c.put('/p?a=1', new Response('first'));
      const exactMiss   = (await c.match('/p?a=2')) === undefined;
      const ignoreHit   = await (await c.match('/p?a=2', {ignoreSearch: true})).text();
      // put on the SAME url replaces the entry (not append)
      await c.put('/p?a=1', new Response('second'));
      const replaced    = await (await c.match('/p?a=1')).text();
      const keys        = (await c.keys()).map(r => new URL(r.url).pathname + new URL(r.url).search);
      return {exactMiss, ignoreHit, replaced, count: keys.length};
    JS
    expect(r['exactMiss']).to be true
    expect(r['ignoreHit']).to eq('first')
    expect(r['replaced']).to eq('second')
    expect(r['count']).to eq(1)
  end

  it 'matchAll with Vary distinguishes entries by the varied header' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('vary');
      await c.put(new Request('/v', {headers: {Accept: 'text/plain'}}), new Response('plain', {headers: {Vary: 'Accept'}}));
      await c.put(new Request('/v', {headers: {Accept: 'text/html'}}),  new Response('html',  {headers: {Vary: 'Accept'}}));
      const plain = await (await c.match(new Request('/v', {headers: {Accept: 'text/plain'}}))).text();
      const html  = await (await c.match(new Request('/v', {headers: {Accept: 'text/html'}}))).text();
      const all   = await c.matchAll('/v', {ignoreVary: true});
      return {plain, html, count: all.length};
    JS
    expect(r['plain']).to eq('plain')
    expect(r['html']).to eq('html')
    expect(r['count']).to eq(2)
  end

  it 'delete removes a matching entry and reports whether anything was removed' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('d');
      await c.put('/x', new Response('x'));
      const first  = await c.delete('/x');
      const second = await c.delete('/x');
      const gone   = (await c.match('/x')) === undefined;
      return {first, second, gone};
    JS
    expect(r['first']).to be true
    expect(r['second']).to be false
    expect(r['gone']).to be true
  end

  it 'rejects put for a non-GET request and a 206 response' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('e');
      const postErr = await c.put(new Request('/x', {method: 'POST'}), new Response('x')).then(() => 'ok', e => e.name);
      const partial = await c.put('/y', new Response('x', {status: 206})).then(() => 'ok', e => e.name);
      return {postErr, partial};
    JS
    expect(r['postErr']).to eq('TypeError')
    expect(r['partial']).to eq('TypeError')
  end

  it 'requires a request argument for match (Cache and CacheStorage)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('req');
      await c.put('/x', new Response('x'));
      const cacheMatchErr   = await c.match().then(() => 'ok', e => e.name);
      const cachesMatchErr  = await caches.match().then(() => 'ok', e => e.name);
      // matchAll / keys still allow a missing request (returns everything)
      const allCount        = (await c.matchAll()).length;
      return {cacheMatchErr, cachesMatchErr, allCount};
    JS
    expect(r['cacheMatchErr']).to eq('TypeError')
    expect(r['cachesMatchErr']).to eq('TypeError')
    expect(r['allCount']).to eq(1)
  end

  it 'preserves body-lessness and the redirected flag through the store' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('meta');
      await c.put('/nobody', new Response(null, {status: 200}));
      const m = await c.match('/nobody');
      return {bodyNull: m.body === null, text: await m.text()};
    JS
    expect(r['bodyNull']).to be true
    expect(r['text']).to eq('')
  end

  it 'add/addAll fetch and store real resources; caches.match spans caches' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    r = run_async(session, <<~JS)
      const c = await caches.open('added');
      await c.add('/asset');
      const stored = await (await c.match('/asset')).text();
      const viaCaches = await (await caches.match('/asset')).text();
      await c.addAll(['/asset', '/']);
      const keyCount = (await c.keys()).length;
      return {stored, viaCaches, keyCount};
    JS
    expect(r['stored']).to eq('ASSET BODY')
    expect(r['viaCaches']).to eq('ASSET BODY')
    expect(r['keyCount']).to eq(2)
  end
end
