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
        if (u.pathname === '/away') return e.respondWith(Response.redirect('https://b.example.com/end', 302));
        if (u.pathname !== '/echo') return;
        const r = e.request;
        seen.push([u.search, r.mode, r.credentials, r.referrer, r.referrerPolicy, r.headers.get('accept'), r.headers.has('accept-language')]);
      });
    JS
  }
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
    lambda {|env|
      host, path = env['SERVER_NAME'], env['PATH_INFO']
      case path
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
end
