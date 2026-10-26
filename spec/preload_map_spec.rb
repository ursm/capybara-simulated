# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A document's map of preloaded resources (HTML `rel=preload`, preload_map.rs): a preload's response is kept for the
# first fetch that matches it — its URL, destination, mode and credentials mode — which takes it before any service
# worker or network ("consume a preloaded resource", run by Fetch's "fetch"), filing no Resource Timing entry of its own.
# The preload itself is a fetch like any other: a controlling service worker's to answer. Chrome: one request for a
# preload and its consumer, and one entry, the preload's (`link`).
RSpec.describe 'map of preloaded resources' do
  PRELOAD_PNG  = File.binread(File.expand_path('wpt/resource-timing/resources/blue.png', __dir__))
  PRELOAD_FONT = File.binread(File.expand_path('wpt/fonts/CanvasTest.ttf', __dir__))

  def preload_app(served, page, worker = nil)
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/i.png' then served << "i.png?#{env['QUERY_STRING']}"; [200, {'content-type' => 'image/png'}, [PRELOAD_PNG]]
      when '/f.ttf' then served << 'f.ttf'; [200, {'content-type' => 'font/ttf', 'access-control-allow-origin' => '*'}, [PRELOAD_FONT]]
      else [200, {'content-type' => 'text/html'}, [page]]
      end
    }
  end

  def entries(s)
    s.evaluate_script("performance.getEntriesByType('resource').filter((e) => /i\\.png|f\\.ttf/.test(e.name)).map((e) => e.name.split('/').pop() + ':' + e.initiatorType)")
  end

  it 'hands a preloaded image and font to their consumers, one request each' do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <link rel=preload as=image href="/i.png?pre">
      <link rel=preload as=font href="/f.ttf" crossorigin>
      <style>@font-face { font-family: F; src: url(/f.ttf) }</style><body>
    HTML
    served = []
    s = simulated_session(preload_app(served, page)).tap {|session| session.visit '/' }
    s.execute_script(<<~'JS')
      window.img = new Image();
      img.src = '/i.png?pre';
      document.body.append(img);
      document.fonts.load('16px F').then((faces) => { window.faces = faces.length; });
    JS
    expect(poll_until { s.evaluate_script('img.complete && window.faces !== undefined') }).to be true
    expect(s.evaluate_script('[img.naturalWidth > 0, faces]')).to eq([true, 1])
    expect(served).to eq(['i.png?pre', 'f.ttf'])
    expect(entries(s)).to eq(['i.png?pre:link', 'f.ttf:link'])
  end

  # …one consumer alone: a request of another mode (a `crossorigin` image) takes none and fetches; the first that
  # matches takes it; the next fetches again.
  it 'hands a preload to the first consumer that matches it alone' do
    page = '<!DOCTYPE html><meta charset=utf-8><link rel=preload as=image href="/i.png?pre"><body>'
    served = []
    s = simulated_session(preload_app(served, page)).tap {|session| session.visit '/' }
    s.execute_script(<<~'JS')
      window.cors = Object.assign(new Image(), { crossOrigin: 'anonymous', src: '/i.png?pre' });
    JS
    expect(poll_until { s.evaluate_script('cors.complete') }).to be true
    s.execute_script("window.plain = Object.assign(new Image(), { src: '/i.png?pre' })")
    expect(poll_until { s.evaluate_script('plain.complete') }).to be true
    s.execute_script("window.again = Object.assign(new Image(), { src: '/i.png?pre' })")
    expect(poll_until { s.evaluate_script('again.complete') }).to be true
    expect(served).to eq(['i.png?pre', 'i.png?pre', 'i.png?pre'])
  end

  it 'fetches a preload through the controlling service worker, its consumer reaching it no more' do
    worker = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      const seen = [];
      self.addEventListener('fetch', (e) => {
        const url = new URL(e.request.url);
        if (url.pathname !== '/i.png') return;
        seen.push(e.request.destination + url.search);
        e.respondWith(fetch('/i.png?from-worker'));
      });
      self.onmessage = (e) => e.source.postMessage(seen.slice());
    JS
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body><script>
        navigator.serviceWorker.addEventListener('message', (e) => { window.seen = e.data; });
        navigator.serviceWorker.register('/sw.js');
        setInterval(() => {}, 50);
      </script>
    HTML
    served = []
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    begin
      s = simulated_session(preload_app(served, page, worker)).tap {|session| session.visit '/' }
      expect(poll_until { s.evaluate_script('!!navigator.serviceWorker.controller') }).to be true
      s.execute_script(<<~'JS')
        const link = Object.assign(document.createElement('link'), { rel: 'preload', as: 'image', href: '/i.png?pre' });
        link.onload = () => {
          window.img = Object.assign(new Image(), { src: '/i.png?pre' });
          document.body.append(img);
        };
        document.head.append(link);
      JS
      expect(poll_until { s.evaluate_script('window.img && img.complete') }).to be true
      s.execute_script("navigator.serviceWorker.controller.postMessage('seen')")
      expect([poll_until { s.evaluate_script('window.seen') }, s.evaluate_script('img.naturalWidth > 0'), served]).to eq([
        ['image?pre'], true, ['i.png?from-worker']
      ])
    ensure
      ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
    end
  end
end
