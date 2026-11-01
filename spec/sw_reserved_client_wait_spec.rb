# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A navigation fetch handler that waits on `clients.get(event.resultingClientId)` — Service Workers §4.4.1: until the
# reserved client is execution ready, after the response — keeps its own response whichever way it makes it: at once,
# from the network through a transform (a POST sent once), off a timer, from the cache. Only a real deadlock — the
# response itself waiting on that get, the worker able to do nothing more — is answered from the network
# (workers.js `__csim_swBreakSelfWait`): Chrome 156 never loads such a document, Firefox 159 resolves the get early.
RSpec.describe "a navigation fetch handler waiting on its reserved client's get", :every_host_local do
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
        if (mode === 'deadlock') e.respondWith(got.then(() => fetch(e.request)));
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

  {
    'sync'     => ['sw-sync', {}],
    'fetch'    => ['sw-transformed /b', {'GET /b' => 1}],
    'timer'    => ['sw-timer', {}],
    'cache'    => ['from cache', {}],
    # (…the network's answer the host's request, and the worker's own request after it — its handler going on as its get
    # resolves to the committed document — a second: the cost of answering what Chrome never answers)
    'deadlock' => ['net /b', {'GET /b' => 2}]
  }.each do |mode, (body, hits)|
    it "answers a #{mode} handler's navigation with #{body.inspect}" do
      expect(navigate(mode)).to eq([body, ['hello http://www.example.com/b'], hits])
    end
  end

  it 'sends a POST it answers through a transform once' do
    expect(navigate('fetch', post: true)).to eq(['sw-transformed /b', ['hello http://www.example.com/b'], {'POST /b' => 1}])
  end

  # (…and one it deadlocks on from the network, which its handler then sends again itself)
  it 'answers a POST it deadlocks on from the network' do
    expect(navigate('deadlock', post: true)).to eq(['net /b', ['hello http://www.example.com/b'], {'POST /b' => 2}])
  end
end
