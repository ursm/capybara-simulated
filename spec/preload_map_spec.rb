# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

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
      when '/s.css' then served << 's.css'; [200, {'content-type' => 'text/css'}, ['p { color: red }']]
      when '/imp.css' then served << 'imp.css'; [200, {'content-type' => 'text/css'}, ['p { color: green }']]
      when '/d.json' then served << "d.json?#{env['QUERY_STRING']}"; [200, {'content-type' => 'application/json'}, ['{"a":1}']]
      when '/a.js' then served << 'a.js'; [200, {'content-type' => 'text/javascript'}, ['window.ran = (window.ran || 0) + 1']]
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

  # A style sheet's and a classic script's request take theirs too — the sheet's every reader (its load, the cascade,
  # `.sheet`) the one response. Chrome: `[1, "rgb(255, 0, 0)"]`, one request each, the preloads' entries alone.
  it 'hands a preloaded style sheet and script to their consumers, one request each' do
    page = '<!DOCTYPE html><meta charset=utf-8><link rel=preload as=style href="/s.css"><link rel=preload as=script href="/a.js"><body><p>p</p>'
    served = []
    s = simulated_session(preload_app(served, page)).tap {|session| session.visit '/' }
    s.execute_script(<<~'JS')
      window.loaded = [];
      const sheet = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/s.css' });
      sheet.onload = () => loaded.push('sheet');
      const script = Object.assign(document.createElement('script'), { src: '/a.js' });
      script.onload = () => loaded.push('script');
      document.head.append(sheet, script);
    JS
    expect(poll_until { s.evaluate_script('loaded.length === 2') }).to be true
    expect(s.evaluate_script("[window.ran, getComputedStyle(document.querySelector('p')).color, document.styleSheets.length]")).to eq([1, 'rgb(255, 0, 0)', 1])
    expect(served).to eq(['s.css', 'a.js'])
    expect(s.evaluate_script("performance.getEntriesByType('resource').map((e) => e.name.split('/').pop() + ':' + e.initiatorType)")).to eq([
      's.css:link', 'a.js:link'
    ])
  end

  # The response as it came, its bytes: a style sheet's and a script's in an encoding other than UTF-8, or behind a
  # byte-order mark, decode and verify as their consumers' own fetch would have them. Chrome: "é" for both, the BOM'd
  # script run under its integrity.
  it 'hands a consumer the bytes the preload had, not their text' do
    bom = "\xEF\xBB\xBFwindow.bom = 1".b
    digest = "sha256-#{Digest::SHA256.base64digest(bom)}"
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <link rel=preload as=script href="/latin.js"><link rel=preload as=style href="/latin.css">
      <link rel=preload as=script href="/bom.js" integrity="#{digest}"><body><p>p</p>
    HTML
    app = lambda {|env|
      case env['PATH_INFO']
      when '/latin.js' then [200, {'content-type' => 'text/javascript; charset=windows-1252'}, ["window.x = '\xE9'".b]]
      when '/latin.css' then [200, {'content-type' => 'text/css; charset=windows-1252'}, ["p::before { content: '\xE9' }".b]]
      when '/bom.js' then [200, {'content-type' => 'text/javascript'}, [bom]]
      else [200, {'content-type' => 'text/html'}, [page]]
      end
    }
    s = simulated_session(app).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      window.loaded = [];
      for (const [tag, attrs] of [['script', { src: '/latin.js' }], ['link', { rel: 'stylesheet', href: '/latin.css' }],
                                  ['script', { src: '/bom.js', integrity: '#{digest}' }]]) {
        const el = Object.assign(document.createElement(tag), attrs);
        el.onload = () => loaded.push(tag);
        el.onerror = () => loaded.push(tag + ':error');
        document.head.append(el);
      }
    JS
    expect(poll_until { s.evaluate_script('loaded.length === 3') }).to be true
    expect(s.evaluate_script("[window.x, getComputedStyle(document.querySelector('p'), '::before').content, window.bom, loaded.includes('script:error')]")).to eq([
      'é', '"é"', 1, false
    ])
  end

  # A preload's entry is in its document's map from the moment its fetch is planned: a consumer the parser makes before
  # the preload's load task has run takes it too, running its fetch then — an image, a script, a CSS image, an `@import`.
  # Chrome: one request each, the preloads' entries alone.
  it 'hands a preload to a consumer that comes before its load task' do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <link rel=preload as=image href="/i.png?early"><link rel=preload as=script href="/a.js">
      <link rel=preload as=style href="/imp.css"><style>@import url(/imp.css);</style>
      <style>.bg { background-image: url(/i.png?bg); width: 10px; height: 10px }</style>
      <link rel=preload as=image href="/i.png?bg">
      <body><p>p</p><img src="/i.png?early"><div class=bg></div><script src="/a.js"></script>
    HTML
    served = []
    s = simulated_session(preload_app(served, page)).tap {|session| session.visit '/' }
    expect(poll_until { s.evaluate_script('document.images[0].complete && window.ran === 1') }).to be true
    expect(s.evaluate_script("[document.images[0].naturalWidth > 0, getComputedStyle(document.querySelector('p')).color]")).to eq([true, 'rgb(0, 128, 0)'])
    expect(served.sort).to eq(['a.js', 'i.png?bg', 'i.png?early', 'imp.css'])
    expect(s.evaluate_script("performance.getEntriesByType('resource').map((e) => e.name.split('/').pop() + ':' + e.initiatorType).sort()")).to eq([
      'a.js:link', 'i.png?bg:link', 'i.png?early:link', 'imp.css:link'
    ])
  end

  # A preload link's plan changed before its load task ran — its `crossorigin` set as it is inserted — is fetched once,
  # by its latest plan, and fires one `load`. Chrome: `["load"]`, one request.
  it 'fires one load for a preload whose request changed before its task ran' do
    served = []
    s = simulated_session(preload_app(served, '<!DOCTYPE html><meta charset=utf-8><body>')).tap {|session| session.visit '/' }
    s.execute_script(<<~'JS')
      window.events = [];
      const link = Object.assign(document.createElement('link'), { rel: 'preload', as: 'image', href: '/i.png?co' });
      link.onload = () => events.push('load');
      link.onerror = () => events.push('error');
      document.head.append(link);
      link.crossOrigin = 'anonymous';
    JS
    s.evaluate_script('new Promise((resolve) => setTimeout(resolve, 100))')
    expect([s.evaluate_script('events'), served]).to eq([['load'], ['i.png?co']])
  end

  # A `fetch()` takes a preload of `as=fetch` its request matches — a CORS one of credentials same-origin, the preload's
  # `crossorigin` — and one of another mode none. Chrome: `[{"a":1}, {"a":1}]`, the `crossorigin` one requested once,
  # the other twice, a `fetch` entry for it alone.
  it 'hands a fetch() the as=fetch preload its request matches' do
    page = '<!DOCTYPE html><meta charset=utf-8><link rel=preload as=fetch href="/d.json?cors" crossorigin><link rel=preload as=fetch href="/d.json?nocors"><body>'
    served = []
    s = simulated_session(preload_app(served, page)).tap {|session| session.visit '/' }
    got = s.evaluate_async_script(<<~'JS')
      const done = arguments[0];
      (async () => {
        const taken = await fetch('/d.json?cors');
        return [taken.statusText, await taken.json(), await (await fetch('/d.json?nocors')).json()];
      })().then(done);
    JS
    expect(got).to eq(['OK', {'a' => 1}, {'a' => 1}])
    expect(served.sort).to eq(['d.json?cors', 'd.json?nocors', 'd.json?nocors'])
    expect(s.evaluate_script("performance.getEntriesByType('resource').map((e) => e.name.split('/').pop() + ':' + e.initiatorType).sort()")).to eq([
      'd.json?cors:link', 'd.json?nocors:fetch', 'd.json?nocors:link'
    ])
  end

  # …an XHR alike — a CORS request of its `withCredentials`' credentials mode — but none of credentials open() gave
  # (its URL's userinfo then: a URL no preload is of). Chrome: one request for the preload and the plain XHR.
  it 'hands an XHR the as=fetch preload its request matches' do
    page = '<!DOCTYPE html><meta charset=utf-8><link rel=preload as=fetch href="/d.json?xhr" crossorigin><body>'
    served = []
    s = simulated_session(preload_app(served, page)).tap {|session| session.visit '/' }
    xhr = lambda {|*credentials|
      s.evaluate_async_script(<<~JS)
        const done = arguments[0];
        const x = new XMLHttpRequest();
        x.open('GET', '/d.json?xhr', true#{credentials.map {|c| ", '#{c}'" }.join});
        x.onload = () => done([x.status, x.responseText]);
        x.send();
      JS
    }
    expect(xhr.('user', 'pass')).to eq([200, '{"a":1}'])
    expect(served).to eq(['d.json?xhr', 'd.json?xhr'])
    expect(xhr.()).to eq([200, '{"a":1}'])
    expect(served).to eq(['d.json?xhr', 'd.json?xhr'])
    expect(s.evaluate_script("performance.getEntriesByType('resource').map((e) => e.name.split('/').pop() + ':' + e.initiatorType)")).to eq([
      'd.json?xhr:link', 'd.json?xhr:xmlhttprequest'
    ])
  end

  # A video's poster and a default track — fetched for their Resource Timing entries — take theirs too, a track's by its
  # video's `crossorigin` (a CORS request, as the preload's `crossorigin` makes its: one with none is a same-origin
  # request, which no preload's no-cors one matches). (Chrome loads a track only when its mode shows; the poster's case
  # is the image's.)
  it "hands a poster and a track the preloads of them" do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><link rel=preload as=image href="/i.png?poster"><link rel=preload as=track href="/t.vtt" crossorigin>
      <body><script>setTimeout(() => {
        const v = document.createElement('video');
        v.poster = '/i.png?poster';
        v.crossOrigin = 'anonymous';
        v.innerHTML = '<track default src="/t.vtt">';
        document.body.append(v);
      }, 200)</script>
    HTML
    served = []
    app = preload_app(served, page)
    s = simulated_session(->(env) { env['PATH_INFO'] == '/t.vtt' ? (served << 't.vtt'; [200, {'content-type' => 'text/vtt'}, ["WEBVTT\n"]]) : app.call(env) }).tap {|session| session.visit '/' }
    s.evaluate_script('new Promise((resolve) => setTimeout(resolve, 400))')
    expect(served.sort).to eq(['i.png?poster', 't.vtt'])
    expect(s.evaluate_script("performance.getEntriesByType('resource').map((e) => e.name.split('/').pop() + ':' + e.initiatorType).sort()")).to eq([
      'i.png?poster:link', 't.vtt:link'
    ])
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
        if (!['/i.png', '/s.css', '/a.js'].includes(url.pathname)) return;
        seen.push(e.request.destination + url.search);
        if (url.pathname === '/i.png') e.respondWith(fetch('/i.png?from-worker'));
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
    every_host_local do   # Service Workers are modeled only in a universal-server context
      s = simulated_session(preload_app(served, page, worker)).tap {|session| session.visit '/' }
      expect(poll_until { s.evaluate_script("navigator.serviceWorker.controller?.state === 'activated'") }).to be true
      s.execute_script(<<~'JS')
        window.preloads = 0;
        for (const [as, href] of [['image', '/i.png?pre'], ['style', '/s.css'], ['script', '/a.js']]) {
          const link = Object.assign(document.createElement('link'), { rel: 'preload', as, href });
          link.onload = () => { window.preloads++; };
          document.head.append(link);
        }
      JS
      expect(poll_until { s.evaluate_script('preloads === 3') }).to be true
      s.execute_script(<<~'JS')
        window.img = Object.assign(new Image(), { src: '/i.png?pre' });
        document.body.append(img);
        document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/s.css' }));
        document.head.append(Object.assign(document.createElement('script'), { src: '/a.js' }));
      JS
      expect(poll_until { s.evaluate_script('img.complete && window.ran === 1') }).to be true
      s.execute_script("navigator.serviceWorker.controller.postMessage('seen')")
      expect([poll_until { s.evaluate_script('window.seen') }, s.evaluate_script('img.naturalWidth > 0'), served]).to eq([
        ['image?pre', 'style', 'script'], true, ['i.png?from-worker', 's.css', 'a.js']
      ])
    end
  end
end
