# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'
require_relative 'support/https_app_host'

# A fetch()'s and an XMLHttpRequest's request as Fetch takes it — the engine's one description of it (fetch_request.rs),
# whichever leg answers it — and the steps around the legs: fetch()'s abort steps, main fetch's refusal of a blob: URL of
# another origin, a service worker's view of the request, and the network leg after a worker's redirects. (Chrome's and
# Firefox's figures measured 2026-11-08, probe pages in ~/.local/share/csim-bench/r18/probe.)
RSpec.describe 'a fetch() or XHR request', :every_host_local, :https do
  include PollUntil

  let(:worker) {
    <<~JS
      const seen = [];
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        const u = new URL(e.request.url);
        if (u.pathname === '/seen') return e.respondWith(new Response(JSON.stringify(seen)));
        if (u.pathname === '/answer') return e.respondWith(new Response('answered'));
        if (u.pathname === '/away') return e.respondWith(Response.redirect('https://b.example.com/end', 302));
        if (u.pathname !== '/echo') return;
        const r = e.request;
        seen.push([u.search, r.mode, r.credentials, r.referrer, r.referrerPolicy, r.headers.get('accept'), r.headers.has('accept-language')]);
      });
    JS
  }
  let(:log) { [] }
  let(:app) {
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><meta name=referrer content=origin><body>
      <script>
        window.controlled = () => navigator.serviceWorker.controller ? Promise.resolve() : navigator.serviceWorker.register('/sw.js').then(() =>
          new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })));
        window.xhr = (url, setup) => new Promise((res) => {
          const x = new XMLHttpRequest();
          x.open('GET', url);
          if (setup) setup(x);
          x.onload = () => res(['load', x.status, x.responseURL, x.responseText]);
          x.onerror = () => res(['error']);
          x.send();
        });
        window.tryFetch = (url, init) => fetch(url, init).then((r) => r.text().then((t) => [r.type, r.status, r.redirected, r.url, t]), (e) => ['error', e.name]);
      </script>
    HTML
    worker_js = worker
    seen = log
    lambda {|env|
      host, path = env['SERVER_NAME'], env['PATH_INFO']
      seen << [env['REQUEST_METHOD'], env['QUERY_STRING']] if path == '/cors'
      case path
      when '/cors'
        cors = {'access-control-allow-origin' => 'https://www.example.com', 'access-control-allow-methods' => 'POST'}
        cors.delete('access-control-allow-methods') if env['QUERY_STRING'].include?('noacam')
        [200, {'content-type' => 'text/plain', **cors}, ['cors']]
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker_js]]
      when '/echo' then [200, {'content-type' => 'text/plain'}, ['echo']]
      when '/end'
        [200, {'content-type' => 'text/plain', 'access-control-allow-origin' => 'https://www.example.com'}, ["end at #{host}"]]
      when '/frame' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><script>parent.postMessage(URL.createObjectURL(new Blob(['other'])), '*')</script>"]]
      else [200, {'content-type' => 'text/html'}, [page]]
      end
    }
  }

  # Fetch "fetch(input, init)": the request's signal, which follows the one given (a dependent signal), runs the abort
  # steps as it aborts — the promise rejected then, after the given signal's own `abort` listeners and before a
  # microtask queued after `abort()` — whichever leg is answering it; where the queued task answered it before, a
  # rejection after every microtask of the turn.
  it 'rejects as its signal aborts, whichever leg answers it' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const order = async (url) => {
        const log = [];
        const c = new AbortController();
        fetch(url, { signal: c.signal }).then(() => log.push('resolved'), (e) => log.push('rejected ' + e.name));
        c.signal.addEventListener('abort', () => { log.push('abort event'); Promise.resolve().then(() => log.push('micro in listener')); });
        c.abort();
        log.push('after abort()');
        Promise.resolve().then(() => log.push('micro after abort'));
        setTimeout(() => log.push('timeout 0'), 0);
        await new Promise((r) => setTimeout(r, 50));
        return log;
      };
      (async () => {
        const out = [await order('/echo'), await order('data:,x'), await order(URL.createObjectURL(new Blob(['b'])))];
        await controlled();
        out.push(await order('/echo?sw'));
        window.got = out;
      })();
    JS
    browsers = ['abort event', 'after abort()', 'micro in listener', 'rejected AbortError', 'micro after abort', 'timeout 0']
    expect(poll_until { s.evaluate_script('window.got') }).to eq([browsers] * 4)
  end

  # …and its abort steps cancel a stream body still being read to the wire, with the abort's reason.
  it 'cancels a stream body it is still reading as it aborts' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const c = new AbortController();
      const cancelled = new Promise((res) => {
        const body = new ReadableStream({ cancel: res });
        fetch('/echo', { method: 'POST', body, duplex: 'half', signal: c.signal }).catch((e) => e);
      });
      c.abort('foo abort');
      cancelled.then((reason) => { window.got = reason; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq('foo abort')
  end

  # Main fetch scheme-fetches a blob: URL of the request's origin as it is and refuses one of another — a no-cors
  # request's opaquely, which "obtain a blob object" refuses then too, as it is of another storage key. A sandboxed
  # frame's `blob:null/…` URL is of ITS opaque origin, which no other document has: the page's request of it a network
  # error in every mode, the frame's own a basic response (Chrome and Firefox alike); a frame of another origin's too.
  it "refuses a blob URL another origin made, a sandboxed frame's too" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const madeBy = (frame) => new Promise((res) => addEventListener('message', function on(e) {
        if (e.source === frame.contentWindow) { removeEventListener('message', on); res(e.data); }
      }));
      const every = async (url) => [
        await tryFetch(url, { mode: 'cors' }), await tryFetch(url, { mode: 'no-cors' }), await tryFetch(url, { mode: 'same-origin' }), await xhr(url)
      ];
      (async () => {
        const away = document.createElement('iframe');
        const awayUrl = madeBy(away);
        away.src = 'https://b.example.com/frame';
        document.body.append(away);
        const sandboxed = document.createElement('iframe');
        sandboxed.sandbox = 'allow-scripts';
        const sandboxedUrl = madeBy(sandboxed);
        sandboxed.srcdoc = `<script>
          const url = URL.createObjectURL(new Blob(['sandboxed']));
          fetch(url).then((r) => r.text().then((t) => parent.postMessage([url, r.type, t], '*')));
        <\\/script>`;
        document.body.append(sandboxed);
        const [opaque, ownType, ownText] = await sandboxedUrl;
        window.got = [await every(await awayUrl), opaque.slice(0, 10), [ownType, ownText], await every(opaque)];
      })();
    JS
    refused = [['error', 'TypeError']] * 3 + [['error']]
    expect(poll_until { s.evaluate_script('window.got') }).to eq([refused, 'blob:null/', %w[basic sandboxed], refused])
  end

  # A service worker's fetch event sees the request main fetch made: its default `Accept` and `Accept-Language` (Fetch
  # "fetch" steps 12-13 — Firefox shows the worker both; Chrome adds the second past it), its referrer policy its
  # document's where it names none and its referrer under it — an XHR's as a fetch()'s, its credentials mode its
  # `withCredentials`'.
  it 'reaches a service worker as main fetch made it, an XHR as a fetch()' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      controlled().then(async () => {
        await fetch('/echo?f');
        await xhr('/echo?x');
        await xhr('/echo?xc', (x) => { x.withCredentials = true; });
        window.got = await (await fetch('/seen')).json();
      });
    JS
    seen = ->(q, credentials) { [q, 'cors', credentials, 'https://www.example.com/', 'origin', '*/*', true] }
    expect(poll_until { s.evaluate_script('window.got') }).to eq([seen['?f', 'same-origin'], seen['?x', 'same-origin'], seen['?xc', 'include']])
  end

  # A worker's redirect to another origin it then falls through on leaves the network leg a request whose URL list has
  # been there: a no-cors fetch's response opaque, a cors one's a CORS response, redirected, at the URL it ended at — and
  # an XHR's too.
  it "answers a worker's redirect then fall-through as the request's URL list has it" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      controlled().then(async () => {
        window.got = [
          await tryFetch('/away', { mode: 'no-cors' }), await tryFetch('/away'), await xhr('/away')
        ];
      });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(
      [
        ['opaque', 0, false, '', ''],
        ['cors', 200, true, 'https://b.example.com/end', 'end at b.example.com'],
        ['load', 200, 'https://b.example.com/end', 'end at b.example.com']
      ]
    )
  end

  # An abort after the response resolved errors its body (Fetch "abort the fetch() call" step 4): a read begun before
  # the abort rejects with the abort's reason, as `r.text(); c.abort()` does in Chrome and Firefox — and a read the
  # response finished first stands.
  it 'errors a response body its fetch aborted after it resolved' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      (async () => {
        const c = new AbortController();
        const r = await fetch('/echo', { signal: c.signal });
        const t = r.text();
        c.abort();
        const c2 = new AbortController();
        const r2 = await fetch('/echo', { signal: c2.signal });
        const read = await r2.text();
        c2.abort();
        window.got = [await t.then((x) => 'text ' + x, (e) => e.name), read];
      })();
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(%w[AbortError echo])
  end

  # A removed frame's document is no longer fully active: a fetch() of its realm a network error at once (its fetch
  # group terminated — a TypeError in Chrome and Firefox), never a promise left pending on a task that will not run; an
  # XHR's open() an InvalidStateError (XHR open() step 1 — Chrome throws a NetworkError at send() and Firefox fires
  # `error`: the spec's text kept).
  it "settles a removed frame's fetch and refuses its XHR's open()" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const i = document.createElement('iframe');
      i.src = '/frame-page';
      i.onload = async () => {
        const w = i.contentWindow, F = w.fetch, XHR = w.XMLHttpRequest;
        i.remove();
        const fetched = await Promise.race([F.call(w, '/echo').then(() => 'resolved', (e) => e.name), new Promise((r) => setTimeout(() => r('pending'), 500))]);
        let opened;
        try { new XHR().open('GET', '/echo'); opened = 'opened'; } catch (e) { opened = e.name; }
        window.got = [fetched, opened];
      };
      document.body.append(i);
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(%w[TypeError InvalidStateError])
  end

  # XHR send(): an upload object with a listener sets the request's use-CORS-preflight flag — a preflight before a
  # request to another origin however simple it is; without one, a simple request goes alone.
  it "preflights an XHR to another origin whose upload is listened to" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const post = (q, listen) => new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('POST', 'https://b.example.com/cors?' + q);
        if (listen) x.upload.onprogress = () => {};
        x.onloadend = () => res(x.status);
        x.send('b');
      });
      post('listened', true).then(() => post('unheard', false)).then((status) => { window.got = status; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(200)
    expect(log).to eq([%w[OPTIONS listened], %w[POST listened], %w[POST unheard]])
  end

  # A page's own Array.prototype and Set.prototype methods are none of a fetch's or an XHR's steps: replaced by ones that
  # throw, every request still goes and answers.
  it "goes whatever a page did to Array.prototype and Set.prototype" do
    s = simulated_session(app)
    s.visit '/'
    # (…the page's methods put back before the script answers: the driver's own reads of an answer are no fetch's steps)
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const evil = () => { throw new Error('evil'); };
      const names = ['indexOf', 'push', 'splice', 'map', 'slice', 'forEach'];
      const saved = names.map((m) => Array.prototype[m]);
      const iterator = Array.prototype[Symbol.iterator], add = Set.prototype.add, del = Set.prototype.delete;
      const restore = () => {
        for (let i = 0; i < names.length; i++) Array.prototype[names[i]] = saved[i];
        Array.prototype[Symbol.iterator] = iterator;
        Set.prototype.add = add;
        Set.prototype.delete = del;
      };
      for (let i = 0; i < names.length; i++) Array.prototype[names[i]] = evil;
      Array.prototype[Symbol.iterator] = evil;
      Set.prototype.add = evil;
      Set.prototype.delete = evil;
      (async () => {
        const out = [];
        const c = new AbortController();
        out[0] = await fetch('/echo', { signal: c.signal }).then((r) => r.text(), (e) => e.message);
        out[1] = await fetch('/echo', { method: 'POST', body: 'x', headers: { 'x-a': 'b' } }).then((r) => r.headers.get('content-type'), (e) => e.message);
        const p = fetch('/echo', { signal: c.signal });
        c.abort();
        out[2] = await p.then(() => 'resolved', (e) => e.name);
        out[3] = await new Promise((res) => {
          const x = new XMLHttpRequest();
          x.open('GET', '/echo');
          x.setRequestHeader('x-a', 'b');
          x.onload = () => res(x.responseText + ' ' + x.getResponseHeader('content-type'));
          x.onerror = () => res('error');
          x.send();
        });
        return out;
      })().then((out) => { restore(); done(out); }, (e) => { restore(); done('threw ' + e.message); });
    JS
    expect(got).to eq(['echo', 'text/plain', 'AbortError', 'echo text/plain'])
  end

  # Fetch "CORS-preflight fetch" step 7.4: a forced preflight (the use-CORS-preflight flag) answered with no
  # Access-Control-Allow-Methods grants the request's method — cached, as in Chrome and Firefox: one preflight for two.
  it "caches a forced preflight that names no methods as its request's method" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const post = () => new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('POST', 'https://b.example.com/cors?noacam');
        x.upload.onprogress = () => {};
        x.onloadend = () => res(x.status);
        x.send('b');
      });
      post().then(post).then((status) => { window.got = status; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(200)
    expect(log).to eq([%w[OPTIONS noacam], %w[POST noacam], %w[POST noacam]])
  end

  # A fetched response's body is handed over on tasks as Fetch's steps queue its chunks: its read settles after a task
  # its reader's turn queued, whether or not its fetch was given a signal (the microtasks queued with it before it) — and
  # an abort before then, at once, a microtask, two or a task later, errors it, a pending reader's read too. A Response
  # a script made reads at once. (Chrome's and Firefox's figures, rvfx probe cb.html.)
  it "hands a fetched response's body over on tasks, an abort before then erroring it" do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const st = (p) => p.then(() => 'ok', (e) => e.name);
      const get = async (signal = true) => {
        const c = new AbortController();
        return [await fetch('/echo', signal ? { signal: c.signal } : {}), c];
      };
      const beforeTask = (p) => new Promise((res) => {
        p.then(() => res('read first'));
        setTimeout(() => res('task first'), 0);
      });
      (async () => {
        const out = {};
        { const [r, c] = await get(); const t = r.text(); c.abort(); out.sync = await st(t); }
        { const [r, c] = await get(); const t = r.text(); queueMicrotask(() => c.abort()); out.micro = await st(t); }
        { const [r, c] = await get(); const t = r.text(); Promise.resolve().then(() => 0).then(() => c.abort()); out.twoTicks = await st(t); }
        { const [r, c] = await get(); const t = r.text(); setTimeout(() => c.abort(), 0); out.task = await st(t); }
        { const [r, c] = await get(); const p = r.body.getReader().read(); c.abort(); out.reader = await st(p); }
        { const [r] = await get(true); out.signal = await beforeTask(r.text()); }
        { const [r] = await get(false); out.noSignal = await beforeTask(r.json().catch(() => 0)); }
        out.made = await beforeTask(new Response('x').text());
        { const [r] = await get(true); const log = []; r.text().then(() => log.push('text')); Promise.resolve().then(() => log.push('m1')); queueMicrotask(() => log.push('m2')); await new Promise((r2) => setTimeout(r2, 10)); out.order = log.join(); }
        return out;
      })().then(done, (e) => done('threw ' + e));
    JS
    expect(got).to eq(
      'sync' => 'AbortError', 'micro' => 'AbortError', 'twoTicks' => 'AbortError', 'task' => 'AbortError',
      'reader' => 'AbortError', 'signal' => 'task first', 'noSignal' => 'task first', 'made' => 'read first',
      'order' => 'm1,m2,text'
    )
  end

  # …and a page's Map methods none of a service worker's answer's way back to its fetch either.
  it "answers through a service worker whatever a page did to Map.prototype" do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      controlled().then(async () => {
        const out = {};
        for (const m of ['get', 'set', 'delete', 'has']) {
          const saved = Map.prototype[m];
          Map.prototype[m] = () => { throw new Error('evil'); };
          out[m] = await fetch('/answer').then((r) => r.text(), (e) => e.message);
          Map.prototype[m] = saved;
        }
        done(out);
      });
    JS
    expect(got).to eq('get' => 'answered', 'set' => 'answered', 'delete' => 'answered', 'has' => 'answered')
  end
end
