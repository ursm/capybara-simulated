# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An image a controlling service worker answers loads from its response's bytes — a network response passed on, and one
# whose body is a stream the worker made (its chunks drained, then decoded) — its request carrying an image's `Accept`.
RSpec.describe 'a service worker image' do
  include PollUntil

  png = File.binread(File.expand_path('wpt/common/square.png', __dir__))
  worker = <<~JS
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (e) => {
      const path = new URL(e.request.url).pathname;
      if (path.endsWith('/streamed.png')) {
        e.respondWith(fetch('/real.png').then((r) => r.arrayBuffer()).then((b) => new Response(new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(b)); c.close(); }
        }), {headers: {'content-type': 'image/png'}})));
      } else if (path.endsWith('/buffered.png')) {
        e.respondWith(fetch('/real.png'));
      } else if (path.endsWith('/accept.css')) {
        // (…a style sheet only where its request — the synchronous channel's — carries a sheet's Accept)
        const accept = e.request.headers.get('accept');
        e.respondWith(accept === 'text/css,*/*;q=0.1' ? new Response('#t { color: rgb(1, 2, 3) }', {headers: {'content-type': 'text/css'}}) : new Response(accept, {status: 400}));
      } else if (path.endsWith('/accept.png')) {
        // (…the image only where its request carries an image's Accept: Fetch "fetch" step 12)
        const accept = e.request.headers.get('accept');
        e.respondWith(accept === 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' ? fetch('/real.png') : new Response(accept, {status: 400}));
      }
    });
  JS
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js'    then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/real.png' then [200, {'content-type' => 'image/png'}, [png]]
      when '/scope/s.svg' then [200, {'content-type' => 'image/svg+xml'}, ['<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" width="5" height="5"/></svg>']]
      when '/scope/use.html'
        page = <<~HTML
          <!doctype html><meta charset="utf-8"><svg><use href="/scope/s.svg#r"/></svg>
          <script>setTimeout(() => document.body.append(Object.assign(new Image(), {src: '/scope/s.svg'})), 300)</script>
        HTML
        [200, {'content-type' => 'text/html'}, [page]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  # (…every host served in-process, which a service worker's job is scheduled under alone: browser.rb `sw_schedule_job`'s
  # `all_hosts_local?`)
  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  # …and an image and an SVG `<use>` of the same URL are two resources of two types — two requests, two entries — not the
  # one the page's memory cache served the second (Blink keys its memory cache by type): an image after a use of its URL
  # times its own
  it 'times an image and a use of its URL apart' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => {
          if (w.state === 'activated') return res();
          w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
        });
        location.href = '/scope/use.html';
      });
    JS
    expect(poll_until { (session.evaluate_script('location.pathname') rescue nil) == '/scope/use.html' }).to be(true)
    got = poll_until { session.evaluate_script("performance.getEntriesByType('resource').filter((e) => /s\\.svg/.test(e.name)).map((e) => e.initiatorType).sort().join()").then {|v| v.include?(',') && v } }
    expect(got).to eq('img,other')
  end

  it 'loads from a response passed on and from a stream the worker made' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.got = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => {
          if (w.state === 'activated') return res();
          w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
        });
        const frame = document.body.appendChild(document.createElement('iframe'));
        frame.src = '/scope/page.html';
        frame.onload = async () => {
          const doc = frame.contentDocument, out = {};
          for (const name of ['buffered', 'streamed', 'accept']) {
            out[name] = await new Promise((res) => {
              const img = doc.createElement('img');
              img.onload = () => res('load ' + img.naturalWidth);
              img.onerror = () => res('error');
              img.src = '/scope/' + name + '.png';
              doc.body.appendChild(img);
            });
          }
          window.got = out;
        };
      });
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq('buffered' => 'load 100', 'streamed' => 'load 100', 'accept' => 'load 100')
  end

  # …and so does a style sheet's, which the worker answers synchronously: a sheet's.
  it "hands the worker a style sheet's request with a sheet's Accept" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.got = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => {
          if (w.state === 'activated') return res();
          w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
        });
        const frame = document.body.appendChild(document.createElement('iframe'));
        frame.src = '/scope/page.html';
        frame.onload = () => {
          const doc = frame.contentDocument, p = doc.body.appendChild(doc.createElement('p'));
          p.id = 't';
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/scope/accept.css';
          link.onload = () => { window.got = frame.contentWindow.getComputedStyle(p).color; };
          link.onerror = () => { window.got = 'error'; };
          doc.head.appendChild(link);
        };
      });
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq('rgb(1, 2, 3)')
  end
end
