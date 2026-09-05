# frozen_string_literal: true

require 'capybara/simulated'
require 'timeout'
require 'zlib'
require_relative 'support/session_teardown'
require_relative 'support/js_engine'
require_relative 'support/poll_until'

# Resource Timing Level 2: every resource a document fetches is a `PerformanceResourceTiming`
# entry — scripts, stylesheets, `@import`s, images, frames, fetch / XHR / beacon — that the page
# reads back through `performance.getEntriesByType('resource')` or a `PerformanceObserver`. The
# driver recorded none, so a page's `<link>` load handler that asserted an entry threw and never
# removed its link (`CSSStyleSheet-constructable.html`), and every perf-monitoring library saw
# an empty timeline.
#
# The model: the driver's fetches are synchronous in-process calls, so the network milestones
# are the fetch's start and end (a reused connection: DNS and connect take no time), the sizes
# are the body on the wire and decoded, `transferSize` the spec's body-plus-300 estimate, 0 for
# a cache hit. A cross-origin response exposes its timings only through `Timing-Allow-Origin`,
# and an opaque (no-cors) one neither its status nor its type. The entry is named by the
# REQUEST URL (Fetch's "mark resource timing"), a redirect keeps that name and sets
# `redirectStart`; a network error is an entry with nothing but its times.
RSpec.describe 'resource timing' do
  GZIPPED = Zlib.gzip('var gz = 1;')

  def app
    ->(env) {
      host = env['HTTP_HOST'].to_s
      case env['PATH_INFO']
      when '/a.js'     then [200, {'content-type' => 'application/x-javascript'}, ['window.__a = 1;']]
      when '/b.js'     then [200, {'content-type' => 'text/javascript'}, ['window.__b = 1;']]
      when '/a.css'    then [200, {'content-type' => 'text/css', 'server-timing' => 'db;dur=12.5;desc="query", cache'}, ['@import url("/i.css"); p { color: red }']]
      when '/i.css'    then [200, {'content-type' => 'text/css'}, ['b { color: blue }']]
      when '/d.json'   then [200, {'content-type' => 'application/json; charset=utf-8'}, ['{"a":1}']]
      when '/gz.js'    then [200, {'content-type' => 'text/javascript', 'content-encoding' => 'gzip'}, [GZIPPED]]
      when '/gz-cached.js' then [200, {'content-type' => 'text/javascript', 'content-encoding' => 'gzip', 'cache-control' => 'max-age=600'}, [GZIPPED]]
      when '/cached'   then [200, {'content-type' => 'text/plain', 'cache-control' => 'max-age=600'}, ['cached body']]
      when '/redir'    then [302, {'location' => '/d.json'}, ['']]
      when '/i.png'    then [200, {'content-type' => 'image/png'}, [File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)]]
      when '/f.html'   then [200, {'content-type' => 'text/html'}, ['<p>frame</p>']]
      when '/hash.html' then [200, {'content-type' => 'text/html'}, ['<script>parent.__hashes = (parent.__hashes || []).concat([location.hash]); if (parent.__hashes.length < 2) setTimeout(function () { location.hash = "check"; location.reload(); }, 0);</script>']]
      when '/missing', '/missing.js' then [404, {'content-type' => 'text/plain'}, ['no']]
      when '/xo'       then [200, {'content-type' => 'text/plain', 'access-control-allow-origin' => '*'}, ['cross origin']]
      when '/xo-tao'   then [200, {'content-type' => 'text/plain', 'access-control-allow-origin' => '*', 'timing-allow-origin' => '*'}, ['cross origin with tao']]
      when '/beacon'   then [204, {}, ['']]
      else
        body = host.start_with?('other.') ? '<p>other</p>' : <<~HTML
          <!DOCTYPE html><html><head><link rel="stylesheet" href="/a.css"><script src="/a.js"></script></head>
          <body><img id="img" src="/i.png"><iframe id="fr" src="/f.html"></iframe></body></html>
        HTML
        [200, {'content-type' => 'text/html'}, [body]]
      end
    }
  end

  def session
    s = simulated_session(app)
    s.visit 'http://www.example.com/'
    s
  end

  # The entries whose name ENDS with `filter` (a path, or a host and path).
  def entries(s, filter = nil)
    s.evaluate_script(<<~JS)
      performance.getEntriesByType('resource').filter(function (e) { return #{filter ? "e.name.slice(-#{filter.length}) === #{filter.to_json}" : 'true'}; }).map(function (e) { return e.toJSON(); })
    JS
  end

  # Wait for an image the page just added: its bytes arrive on a host thread.
  def await_images(s)
    Timeout.timeout(5) { sleep 0.05 until s.evaluate_script('Array.from(document.images).every(function (i) { return i.complete; })') }
  end

  def entry(s, filter)
    list = entries(s, filter)
    expect(list.length).to eq(1), "expected one entry for #{filter}, got #{list.map {|e| e['name'] }}"
    list.first
  end

  it 'records one entry per resource the document loaded, by initiator' do
    s = session
    by_name = entries(s).to_h {|e| [e['name'].sub('http://www.example.com', ''), e['initiatorType']] }
    expect(by_name).to include('/a.css' => 'link', '/i.css' => 'css', '/a.js' => 'script', '/i.png' => 'img')
    expect(by_name).to include('/f.html' => 'iframe') if CsimEngine.v8?      # a frame document is a fetch of its own realm
    imported = entry(s, '/i.css')                                             # an @import is a real fetch, recorded once
    expect(imported['responseStatus']).to eq(200)
    expect(imported['contentType']).to eq('text/css')
    s.execute_script("document.head.appendChild(document.createElement('style')).textContent = 'i { color: red }'")
    expect(entries(s, '/i.css').length).to eq(1)
    expect(entries(s).map {|e| e['entryType'] }.uniq).to eq(['resource'])
  end

  it 'records fetch, XMLHttpRequest and sendBeacon entries' do
    s = session
    s.execute_script("fetch('/d.json'); var x = new XMLHttpRequest(); x.open('GET', '/b.js', false); x.send(); navigator.sendBeacon('/beacon', 'x');")
    expect(entry(s, '/d.json')['initiatorType']).to eq('fetch')
    expect(entry(s, '/b.js')['initiatorType']).to eq('xmlhttprequest')
    expect(entry(s, '/beacon')['initiatorType']).to eq('beacon')
  end

  it 'reports the milestones of a synchronous in-process fetch as one instant' do
    s = session
    s.execute_script("fetch('/d.json')")
    e = entry(s, '/d.json')
    expect(e['fetchStart']).to eq(e['startTime'])
    expect(e['startTime']).to be > 0
    %w[domainLookupStart domainLookupEnd connectStart connectEnd requestStart responseStart].each do |k|
      expect(e[k]).to eq(e['fetchStart']), k
    end
    expect(e['responseEnd']).to be >= e['responseStart']
    expect(e['duration']).to eq(e['responseEnd'] - e['startTime'])
    expect(e['nextHopProtocol']).to eq('http/1.1')
    expect(e['secureConnectionStart']).to eq(0)
    expect(e['workerStart']).to eq(0)
  end

  it 'sizes the entry from the body and the spec\'s header estimate' do
    s = session
    s.execute_script("fetch('/d.json')")
    e = entry(s, '/d.json')
    expect(e['encodedBodySize']).to eq(7)
    expect(e['decodedBodySize']).to eq(7)
    expect(e['transferSize']).to eq(307)
    expect(e['responseStatus']).to eq(200)
  end

  it 'reports the decoded and wire sizes of a content-encoded body' do
    s = session
    s.execute_script("fetch('/gz.js')")
    e = entry(s, '/gz.js')
    expect(e['contentEncoding']).to eq('gzip')
    expect(e['encodedBodySize']).to eq(GZIPPED.bytesize)
    expect(e['decodedBodySize']).to eq('var gz = 1;'.bytesize)
  end

  it 'minimizes the content type and parses Server-Timing' do
    s = session
    expect(entry(s, '/a.js')['contentType']).to eq('text/javascript')      # application/x-javascript, minimized
    css = entry(s, '/a.css')
    expect(css['contentType']).to eq('text/css')
    expect(css['serverTiming']).to eq([{'name' => 'db', 'duration' => 12.5, 'description' => 'query'}, {'name' => 'cache', 'duration' => 0, 'description' => ''}])
    s.execute_script("fetch('/d.json')")
    expect(entry(s, '/d.json')['contentType']).to eq('application/json')
  end

  it 'names a redirected fetch by its request URL and marks the redirect' do
    s = session
    s.execute_script("fetch('/redir')")
    e = entry(s, '/redir')
    expect(e['redirectStart']).to eq(e['startTime'])
    expect(e['redirectEnd']).to be >= e['redirectStart']
    expect(e['responseStatus']).to eq(200)
    expect(entries(s, '/d.json')).to be_empty
  end

  it 'records a network error as an entry with nothing but its times' do
    s = session
    s.execute_script("fetch('http://unreachable.invalid/x').catch(function () {}); var x = new XMLHttpRequest(); x.open('GET', '/missing', false); x.send();")
    e = entry(s, 'unreachable.invalid/x')
    expect(e['responseStatus']).to eq(0)
    expect(e['transferSize']).to eq(0)
    expect(e['domainLookupStart']).to eq(0)
    expect(e['fetchStart']).to eq(e['startTime'])
    expect(entry(s, '/missing')['responseStatus']).to eq(404)          # a 404 is a response, not a network error
    s.execute_script("var sc = document.createElement('script'); sc.src = '/missing.js'; document.head.appendChild(sc);")
    expect(entry(s, '/missing.js')['responseStatus']).to eq(404)
  end

  it 'records nothing for a navigation the document submits into a frame' do
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?
    s = session
    s.execute_script("var f = document.createElement('form'); f.target = 'fr'; f.action = '/f.html?posted'; document.body.appendChild(f); f.submit();")
    expect(entries(s).map {|e| e['initiatorType'] }).not_to include('fetch')
  end

  it 'hides a cross-origin response\'s timings without Timing-Allow-Origin and exposes them with it' do
    s = session
    s.execute_script("fetch('http://other.example.com/xo'); fetch('http://other.example.com/xo-tao');")
    plain = entry(s, '/xo')
    expect(plain['responseStatus']).to eq(200)                           # a CORS response shows its status…
    expect(plain['contentType']).to eq('text/plain')
    expect(plain['domainLookupStart']).to eq(0)                          # …but not its timings or sizes
    expect(plain['transferSize']).to eq(0)
    expect(plain['nextHopProtocol']).to eq('')
    tao = entry(s, '/xo-tao')
    expect(tao['domainLookupStart']).to eq(tao['fetchStart'])
    expect(tao['encodedBodySize']).to eq('cross origin with tao'.bytesize)
    expect(tao['nextHopProtocol']).to eq('http/1.1')
  end

  it 'exposes neither status nor type of an opaque cross-origin image' do
    s = session
    s.execute_script("var i = new Image(); i.src = 'http://other.example.com/i.png'; document.body.appendChild(i);")
    await_images(s)
    e = entry(s, 'other.example.com/i.png')
    expect(e['responseStatus']).to eq(0)
    expect(e['contentType']).to eq('')
    expect(e['encodedBodySize']).to eq(0)
  end

  it 'serves a repeated fetch from the HTTP cache with no transfer' do
    s = session
    s.execute_script("fetch('/cached').then(function () { return fetch('/cached'); })")
    first, second = entries(s, '/cached')
    expect(first['deliveryType']).to eq('')
    expect(first['transferSize']).to eq('cached body'.bytesize + 300)
    expect(second['deliveryType']).to eq('cache')
    expect(second['transferSize']).to eq(0)
    expect(second['encodedBodySize']).to eq('cached body'.bytesize)
  end

  it 'keeps the wire size of a content-encoded body across a cache hit' do
    s = session
    s.execute_script("fetch('/gz-cached.js').then(function () { return fetch('/gz-cached.js'); })")
    _, second = entries(s, '/gz-cached.js')
    expect(second['deliveryType']).to eq('cache')
    expect(second['encodedBodySize']).to eq(GZIPPED.bytesize)
    expect(second['decodedBodySize']).to eq('var gz = 1;'.bytesize)
  end

  it 'gives an image the document already holds no second entry' do
    s = session
    s.execute_script("var i = new Image(); i.src = '/i.png'; document.body.appendChild(i);")
    await_images(s)
    expect(entries(s, '/i.png').length).to eq(1)
  end

  it 'records no entry for a data: URL' do
    s = session
    s.execute_script("fetch('data:text/plain,hi'); var i = new Image(); i.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; document.body.appendChild(i);")
    expect(entries(s).select {|e| e['name'].start_with?('data:') }).to be_empty
  end

  # ── the buffer ──
  it 'holds 250 entries by default and drops the overflow after resourcetimingbufferfull' do
    s = session
    s.execute_script(<<~JS)
      window.__full = 0;
      performance.addEventListener('resourcetimingbufferfull', function () { __full++; });
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(2);
      for (var i = 0; i < 4; i++) { var x = new XMLHttpRequest(); x.open('GET', '/b.js?' + i, false); x.send(); }
    JS
    expect(s.evaluate_script('__full')).to eq(1)
    expect(s.evaluate_script("performance.getEntriesByType('resource').map(function (e) { return e.name.slice(-1); })")).to eq(%w[0 1])
  end

  it 'lets the handler make room by clearing or growing the buffer' do
    s = session
    s.execute_script(<<~JS)
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(1);
      performance.onresourcetimingbufferfull = function () { performance.setResourceTimingBufferSize(3); };
      for (var i = 0; i < 3; i++) { var x = new XMLHttpRequest(); x.open('GET', '/b.js?' + i, false); x.send(); }
    JS
    expect(s.evaluate_script("performance.getEntriesByType('resource').map(function (e) { return e.name.slice(-1); })")).to eq(%w[0 1 2])
  end

  it 'fires no event when the buffer is grown before the overflow task runs' do
    s = session
    s.execute_script(<<~JS)
      window.__full = 0;
      performance.addEventListener('resourcetimingbufferfull', function () { __full++; });
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(1);
      for (var i = 0; i < 3; i++) { var x = new XMLHttpRequest(); x.open('GET', '/b.js?' + i, false); x.send(); }
      performance.setResourceTimingBufferSize(3);
    JS
    expect(s.evaluate_script('__full')).to eq(0)
    expect(s.evaluate_script("performance.getEntriesByType('resource').length")).to eq(3)
  end

  # ── observers ──
  it 'delivers entries to a PerformanceObserver, buffered ones on request' do
    s = session
    s.execute_script(<<~JS)
      window.__seen = []; window.__buffered = [];
      new PerformanceObserver(function (list) { __seen.push.apply(__seen, list.getEntriesByType('resource').map(function (e) { return e.name.slice(-5); })); }).observe({ entryTypes: ['resource', 'mark'] });
      new PerformanceObserver(function (list) { __buffered.push(list.getEntries().length); }).observe({ type: 'resource', buffered: true });
      fetch('/d.json');
    JS
    expect(s.evaluate_script('__seen')).to eq(['.json'])
    s.execute_script("new PerformanceObserver(function () {}).observe({ entryTypes: ['resource'], buffered: true })")   # ignored, not an error
    expect(s.evaluate_script('__buffered[0]')).to be >= 4                # everything the page loaded, replayed
    expect(s.evaluate_script('PerformanceObserver.supportedEntryTypes')).to include('resource')
  end

  # ── the interfaces ──
  it 'exposes the entry classes and a Performance interface with its methods on the prototype' do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true, true, true, true])
      (function () {
        var e = performance.getEntriesByType('resource')[0], m = performance.mark('m');
        return [e instanceof PerformanceResourceTiming, e instanceof PerformanceEntry, m instanceof PerformanceMark,
                Object.getPrototypeOf(performance) === Performance.prototype, Performance.prototype.hasOwnProperty('getEntriesByName'),
                typeof e.toJSON().serverTiming === 'object'];
      })()
    JS
  end

  it 'gives an image a decode() that follows its load' do
    s = session
    s.execute_script("window.__d = []; document.getElementById('img').decode().then(function () { __d.push('ok'); }); var i = new Image(); i.src = '/missing'; document.body.appendChild(i); i.decode().then(function () { __d.push('ok2'); }, function (e) { __d.push(e.name); });")
    await_images(s)
    expect(s.evaluate_script('__d')).to eq(%w[ok EncodingError])
  end

  # ── frames (per-frame realms: the V8 engine) ──
  it 'navigates an iframe again when its src is set to the same URL, with a second entry' do
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?
    s = session
    s.execute_script("window.__loads = 0; var f = document.getElementById('fr'); f.addEventListener('load', function () { __loads++; }); f.src = f.src;")
    expect(s.evaluate_script('__loads')).to eq(1)
    expect(entries(s, '/f.html').length).to eq(2)
  end

  it 'keeps the document\'s current URL when a frame reloads itself' do
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?
    s = session
    s.execute_script("var f = document.createElement('iframe'); f.src = '/hash.html'; document.body.appendChild(f);")
    expect(s.evaluate_script('window.__hashes')).to eq(['', '#check'])
  end

  it 'records css entries for background-image, cursor, and list-style-image' do
    # A browser fetches a CSS-embedded image when a rendered element uses it, at the rendering
    # update — even with no script — and files a `css` Resource Timing entry.
    png = File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)
    doc = <<~HTML
      <!DOCTYPE html><html><head><style>
        #bg { background-image: url("/css.png?id=bg"); width: 10px; height: 10px }
        #cur { cursor: url("/css.png?id=cursor"), pointer }
        ul { list-style-image: url("/css.png?id=list") }
      </style></head><body>
        <div id="bg"></div>
        <div id="cur">hover</div>
        <ul><li>item</li></ul>
      </body></html>
    HTML
    a = ->(env) { env['PATH_INFO'].start_with?('/css.png') ? [200, {'content-type' => 'image/png'}, [png]] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(a)
    s.visit 'http://www.example.com/'
    names = poll_until do
      ns = s.evaluate_script("performance.getEntriesByType('resource').filter(function (e) { return e.initiatorType === 'css'; }).map(function (e) { return e.name.split('/').pop(); })")
      ns.length >= 3 ? ns : nil
    end
    expect(names).to include('css.png?id=bg', 'css.png?id=cursor', 'css.png?id=list')
  end

  it 'records timing entries for media and plugin resources with the right initiator' do
    # The driver does not play media, but a browser fetches a media / plugin element's resource and
    # files its entry — 'video' / 'audio' for the media (poster, src or <source>), 'track' for a
    # showing <track>, 'embed' / 'object' for the plugin resource.
    png = File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)
    doc = <<~HTML
      <!DOCTYPE html><html><body>
        <video poster="/m.png?id=poster"><source src="/m.mp4?id=vsrc" type="video/mp4"><track default src="/m.vtt?id=track"></video>
        <audio src="/m.aud?id=asrc"></audio>
        <embed src="/m.dat?id=embed">
        <object type="image/png" data="/m.png?id=object"></object>
      </body></html>
    HTML
    a = ->(env) { env['PATH_INFO'].start_with?('/m.') ? [200, {'content-type' => 'application/octet-stream'}, [env['PATH_INFO'].end_with?('.png') || env['PATH_INFO'].include?('.png') ? png : 'x']] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(a)
    s.visit 'http://www.example.com/'
    got = poll_until do
      m = s.evaluate_script("performance.getEntriesByType('resource').map(function (e) { return [e.name.split('/').pop(), e.initiatorType]; })")
      m.length >= 6 ? m : nil
    end
    expect(got).to include(
      ['m.png?id=poster', 'video'], ['m.mp4?id=vsrc', 'video'], ['m.vtt?id=track', 'track'],
      ['m.aud?id=asrc', 'audio'], ['m.dat?id=embed', 'embed'], ['m.png?id=object', 'object']
    )
  end

  it 'records an <input type=image> as \'input\' and an EventSource as \'other\'' do
    # Both record on connection (the image-button load path and the EventSource constructor),
    # without waiting on the rendering update. `<body background>` ('body') records at the
    # rendering update — covered by the WPT `initiator-type/{misc,input}` gate.
    png = File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)
    doc = <<~HTML
      <!DOCTYPE html><html><body>
        <input type="image" src="/x.png?id=input">
        <script>new EventSource('/x.sse?id=es');</script>
      </body></html>
    HTML
    a = ->(env) { env['PATH_INFO'].start_with?('/x.') ? [200, {'content-type' => 'image/png'}, [png]] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(a)
    s.visit 'http://www.example.com/'
    got = poll_until do
      m = s.evaluate_script("performance.getEntriesByType('resource').map(function (e) { return [e.name.split('/').pop(), e.initiatorType]; })")
      m.length >= 2 ? m : nil
    end
    expect(got).to include(['x.png?id=input', 'input'], ['x.sse?id=es', 'other'])
  end
end
