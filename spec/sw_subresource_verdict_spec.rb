# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A subresource a controlling service worker answers uses the answer where Fetch allows it and its consumer takes its
# status — the engine's one verdict (fetch_rules.rs `sw_subresource_usable`): a `<link rel=prefetch>` loads whatever
# the status (HTML: a success where it is no network error — Chrome errs on a 404), an `<audio>` errs on a 404 and on
# an answer of no media data (a 304), and plays a 200.
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
        else if (u.pathname === '/scope/swerr.js') e.respondWith(Response.error());
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

  it 'loads a prefetch whatever its status, and errors an audio a 404 or an empty 304 answers' do
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
      'prefetch-missing' => 'load',
      'prefetch-found'   => 'load',
      'audio-missing'    => 'error',
      'audio-found'      => 'canplaythrough',
      'audio-unmodified' => 'error'
    )
  end

  # A script a service worker answers with a network error (`Response.error()`) fails, and files its Resource Timing
  # entry as any network error does (Fetch's response handover; Chrome 155: `/swerr.js`, status 0) — an inserted
  # script's and the parser's alike.
  it "files a Resource Timing entry for a script a worker answers with a network error" do
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
          const d = f.contentDocument;
          const s = d.createElement('script');
          s.onerror = () => {
            const entries = f.contentWindow.performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/swerr.js'));
            globalThis.__seen = entries.map((e) => e.initiatorType + ':' + e.responseStatus);
          };
          s.src = '/scope/swerr.js';
          d.head.appendChild(s);
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__seen') }).to eq(['script:0'])
  end
end
