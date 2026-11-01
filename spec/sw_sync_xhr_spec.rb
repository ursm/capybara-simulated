# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# Handle Fetch applies to a controlled client's every request, a synchronous one's too: Fetch's "HTTP fetch" asks the
# service worker whatever the caller waits on — XHR's synchronous flag only makes `send()` wait for the response. So a
# controlled page's sync XHR and a controlled dedicated worker's are its service worker's to answer, as their async XHR,
# fetch() and importScripts() are. Firefox answers all of them from the worker; Chrome all but the page's sync XHR
# (measured 2026-11-02, Chrome 156 / Firefox 159) — a Blink departure from Fetch, which the spec outranks.
# (…service workers are modeled only in a universal-server context)
RSpec.describe 'a controlled client’s synchronous XHR', :every_host_local do
  include PollUntil

  let(:app) {
    sw = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        const tag = new URL(e.request.url).searchParams.get('tag');
        if (!tag) return;
        if (tag === 'imp') return e.respondWith(new Response('self.imp = "sw"', { headers: { 'content-type': 'text/javascript' } }));
        if (tag === 'stream-error') {
          return e.respondWith(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([104])); c.error(new Error('x')); } })));
        }
        if (tag === 'redirect') return e.respondWith(Response.redirect('/data.txt?tag=after', 302));
        if (tag === 'net') return;
        if (tag === 'slow') {
          setTimeout(() => self.clients.get(e.clientId).then((c) => c.postMessage('from-sw')), 100);
          return e.respondWith(new Promise((res) => setTimeout(() => res(new Response('sw-slow')), Number(new URL(e.request.url).searchParams.get('ms')))));
        }
        e.respondWith(new Response(`sw:${tag}:${e.request.mode}:${e.clientId ? 'client' : 'none'}`));
      });
    JS
    worker = <<~JS
      function xhr(url, async) {
        return new Promise((res) => {
          const x = new XMLHttpRequest();
          x.open('GET', url, async);
          if (async) { x.onload = () => res(x.responseText); x.onerror = () => res('error'); x.send(); return; }
          try { x.send(); res(x.responseText); } catch (e) { res(e.name); }
        });
      }
      (async () => {
        const out = [];
        out.push(await xhr('/data.txt?tag=w-sync', false));
        out.push(await xhr('/data.txt?tag=w-async', true));
        out.push(await fetch('/data.txt?tag=w-fetch').then((r) => r.text()));
        importScripts('/imp.js?tag=imp');
        out.push(self.imp);
        out.push(await xhr('/data.txt?tag=redirect', false));
        out.push(await xhr('/data.txt?tag=net', false));
        out.push(await xhr('/data.txt?tag=stream-error', false));
        postMessage(out);
      })();
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js'     then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/worker.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/imp.js'    then [200, {'content-type' => 'text/javascript'}, ['self.imp = "network"']]
      when '/data.txt'  then [200, {'content-type' => 'text/plain'}, ['network']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  def controlled_session
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.controlled = false;
      navigator.serviceWorker.register('/sw.js').then(() => {
        if (navigator.serviceWorker.controller) window.controlled = true;
        else navigator.serviceWorker.addEventListener('controllerchange', () => { window.controlled = true; });
      });
    JS
    poll_until { session.evaluate_script('window.controlled') }
    session
  end

  it 'is answered by the service worker from a page' do
    session = controlled_session
    got = session.evaluate_script(<<~JS)
      ['sync', 'redirect', 'net', 'stream-error'].map((tag) => {
        const x = new XMLHttpRequest();
        x.open('GET', `/data.txt?tag=${tag}`, false);
        try { x.send(); } catch (e) { return e.name; }
        return `${x.responseText}${x.responseURL.endsWith('tag=after') ? ' (redirected)' : ''}`;
      })
    JS
    expect(got).to eq(['sw:sync:cors:client', 'sw:after:cors:client (redirected)', 'network', 'NetworkError'])
  end

  # Synchronous for the script that sent it, not a turn of the event loop: the page's microtasks, and a message the worker
  # posted while it answered, run after the script that called send() — and the answer is waited for however long the
  # worker takes, the request never made again on the network behind it.
  it "runs nothing of the page's inside send(), and waits out a slow answer" do
    session = controlled_session
    session.execute_script(<<~JS)
      window.log = [];
      navigator.serviceWorker.onmessage = (e) => log.push(`message ${e.data}`);
      Promise.resolve().then(() => log.push('microtask'));
      for (const ms of [300, 1500]) {
        const x = new XMLHttpRequest();
        x.open('GET', `/data.txt?tag=slow&ms=${ms}`, false);
        x.send();
        log.push(x.responseText);
      }
    JS
    expect(poll_until { l = session.evaluate_script('log'); l.size == 5 && l }).to eq(['sw-slow', 'sw-slow', 'microtask', 'message from-sw', 'message from-sw'])
  end

  it 'is answered by the service worker from a dedicated worker, as its other requests are' do
    session = controlled_session
    session.execute_script(<<~JS)
      window.got = null;
      new Worker('/worker.js').onmessage = (e) => { window.got = e.data; };
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq(
      [
        'sw:w-sync:cors:client',
        'sw:w-async:cors:client',
        'sw:w-fetch:cors:client',
        'sw',
        'sw:after:cors:client',
        'network',
        'NetworkError'
      ]
    )
  end
end
