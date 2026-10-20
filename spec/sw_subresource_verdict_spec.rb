# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A subresource a controlling service worker answers uses the answer only where Fetch allows it and it is an ok one (or
# an opaque one, a no-cors answer of status 0) — the engine's one verdict (fetch_rules.rs `sw_subresource_usable`) for
# a `<link rel=prefetch>` and an `<audio>` alike: a 404 errors them, a 200 loads them, and a 304 — no ok status, which
# a media resource's verification refuses — errors an audio too.
RSpec.describe 'Service Worker subresource verdict' do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname === '/scope/missing') e.respondWith(new Response('no', {status: 404}));
        else if (u.pathname === '/scope/found') e.respondWith(new Response('yes'));
        else if (u.pathname === '/scope/unmodified') e.respondWith(new Response(null, {status: 304}));
      });
    JS
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>in-scope</body></html>']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'errors a prefetch and an audio a 404 answers, loads them on a 200, and errors an audio a 304 answers' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__seen = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const d = f.contentDocument, seen = {};
          const watch = (el, key, events) => {
            for (const type of events) el.addEventListener(type, () => { seen[key] ??= type; if (Object.keys(seen).length === 5) globalThis.__seen = seen; });
          };
          for (const path of ['missing', 'found']) {
            const link = d.createElement('link');
            link.rel = 'prefetch';
            watch(link, 'prefetch-' + path, ['load', 'error']);
            link.href = '/scope/' + path;
            d.head.appendChild(link);
            const audio = d.createElement('audio');
            watch(audio, 'audio-' + path, ['canplaythrough', 'error']);
            audio.src = '/scope/' + path;
            d.body.appendChild(audio);
          }
          const audio = d.createElement('audio');
          watch(audio, 'audio-unmodified', ['canplaythrough', 'error']);
          audio.src = '/scope/unmodified';
          d.body.appendChild(audio);
        };
        document.body.appendChild(f);
      });
    JS
    seen = poll_until { session.evaluate_script('globalThis.__seen') }
    expect(seen).to eq(
      'prefetch-missing' => 'error',
      'prefetch-found'   => 'load',
      'audio-missing'    => 'error',
      'audio-found'      => 'canplaythrough',
      'audio-unmodified' => 'error'
    )
  end
end
