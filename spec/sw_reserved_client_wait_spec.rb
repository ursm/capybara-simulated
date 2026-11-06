# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A navigation fetch handler that waits on `clients.get(event.resultingClientId)` — Service Workers §4.4.1: until the
# reserved client is execution ready, after the response — keeps its own response whichever way it makes it: at once,
# from the network through a transform (a POST sent once), off a timer, from the cache. Only a real deadlock — the
# response itself waiting on that get, the worker able to do nothing more — is broken, as Firefox 159 has it: the get
# resolved early to the reserved client (Chrome 156 never loads such a document), the worker's own response then made,
# its request sent once (workers.js `__csim_swBreakSelfWait`).
RSpec.describe "a navigation fetch handler waiting on its reserved client's get" do
  HEAD_HTML = "<!doctype html><meta charset=utf-8><script>globalThis.__got=[];navigator.serviceWorker.onmessage=e=>__got.push(e.data)</script>"

  def worker(mode)
    <<~JS
      const HEAD = #{HEAD_HTML.to_json};
      const page = (text) => new Response(HEAD + '<p>' + text, {headers: {'content-type': 'text/html'}});
      self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open('c').then(c => c.put('/cached', page('from cache')))); });
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        if (e.request.mode !== 'navigate' || new URL(e.request.url).pathname === '/a') return;
        const got = self.clients.get(e.resultingClientId);
        e.waitUntil(got.then(c => c && c.postMessage('hello ' + c.url)));
        const mode = #{mode.to_json};
        if (mode === 'sync') e.respondWith(page('sw-sync'));
        if (mode === 'fetch') e.respondWith(fetch(e.request).then(r => r.text()).then(t => new Response(t.replace('net', 'sw-transformed'), {headers: {'content-type': 'text/html'}})));
        if (mode === 'timer') e.respondWith(new Promise(r => setTimeout(() => r(page('sw-timer')), 30)));
        if (mode === 'cache') e.respondWith(caches.match('/cached'));
        if (mode === 'deadlock') e.respondWith(got.then(() => fetch(e.request)).then(r => r.text()).then(t => new Response(t.replace('net', 'sw-after-get'), {headers: {'content-type': 'text/html'}})));
      });
    JS
  end

  def navigate(mode, post: false)
    hits = Hash.new(0)
    sw = worker(mode)
    session = simulated_session(lambda {|env|
      hits["#{env['REQUEST_METHOD']} #{env['PATH_INFO']}"] += 1
      next [200, {'content-type' => 'text/javascript'}, [sw]] if env['PATH_INFO'] == '/sw.js'

      [200, {'content-type' => 'text/html'}, ["#{HEAD_HTML}<p>net #{env['PATH_INFO']}"]]
    })
    session.visit '/a'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
    hits.clear
    if post
      session.execute_script("document.body.insertAdjacentHTML('beforeend', '<form id=f method=post action=/b><input name=q value=1></form>'); document.getElementById('f').submit()")
      poll_until { session.current_path == '/b' }
    else
      session.visit '/b'
    end
    got = poll_until { v = session.evaluate_script('globalThis.__got'); v&.any? && v }
    [session.find('p').text, got, hits.to_h]
  end

  HELLO = ['hello http://www.example.com/b'].freeze
  {
    'sync'     => ['sw-sync', HELLO, {}],
    'fetch'    => ['sw-transformed /b', HELLO, {'GET /b' => 1}],
    'timer'    => ['sw-timer', HELLO, {}],
    'cache'    => ['from cache', HELLO, {}],
    # (…the deadlock broken as Firefox 159 has it: the get resolved early to the reserved client, a window client at
    # about:blank, whose message reaches the document once it commits — the worker's own response, its request sent once)
    'deadlock' => ['sw-after-get /b', ['hello about:blank'], {'GET /b' => 1}]
  }.each do |mode, (body, got, hits)|
    it "answers a #{mode} handler's navigation with #{body.inspect}" do
      expect(navigate(mode)).to eq([body, got, hits])
    end
  end

  it 'sends a POST it answers through a transform once' do
    expect(navigate('fetch', post: true)).to eq(['sw-transformed /b', ['hello http://www.example.com/b'], {'POST /b' => 1}])
  end

  # (…and one it deadlocks on, its own fetch the one request)
  it 'sends a POST it deadlocks on once' do
    expect(navigate('deadlock', post: true)).to eq(['sw-after-get /b', ['hello about:blank'], {'POST /b' => 1}])
  end
end
