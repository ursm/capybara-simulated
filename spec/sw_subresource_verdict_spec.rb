# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A subresource a controlling service worker answers uses the answer where Fetch allows it and its consumer takes its
# status — the engine's one verdict (subresource_judge.rs `judge`): a `<link rel=prefetch>` loads whatever the status,
# the worker's or the network's it lets the request through to (HTML: a success where it is no network error — Chrome
# errs on a 404), an `<audio>` errs on a 404 and on an answer of no media data (a 304), and plays a 200.
RSpec.describe 'Service Worker subresource verdict' do
  include PollUntil

  let(:hits) { [] }
  let(:referers) { {} }
  let(:app) {
    hits = self.hits
    referers = self.referers
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname === '/scope/missing') e.respondWith(new Response('no', {status: 404}));
        else if (u.pathname === '/scope/found') e.respondWith(new Response('yes'));
        else if (u.pathname === '/scope/unmodified') e.respondWith(new Response(null, {status: 304}));
        else if (u.pathname === '/scope/swerr.js' || u.pathname === '/scope/swerr.png') e.respondWith(Response.error());
        else if (u.pathname === '/scope/refused.css') e.respondWith(new Response('p { color: red }', {status: 404}));
        else if (u.pathname === '/scope/away.mp3') e.respondWith(fetch('http://other.test/a.mp3', {mode: 'no-cors'}));
        else if (u.pathname.startsWith('/scope/away-')) e.respondWith(fetch('http://other.test/' + u.pathname.slice(12), {mode: 'no-cors'}));
        else if (u.pathname.startsWith('/scope/hint')) e.respondWith(fetch('/log?' + u.pathname.slice(7) + '=' + e.request.mode).then(() => new Response('')));
        else if (u.pathname === '/scope/moved.css') e.respondWith(fetch('/other/x.css'));
        else if (u.pathname === '/scope/two.css') e.respondWith(fetch('/log?two=' + e.request.mode + ',' + (e.request.integrity || 'none')).then(() => new Response('p {}', {headers: {'content-type': 'text/css'}})));
        else if (u.pathname === '/scope/mod.css') e.respondWith(fetch('/log?mod').then(() => new Response('p {}', {headers: {'content-type': 'text/css'}})));
        else if (u.pathname.startsWith('/scope/rp-')) e.respondWith(fetch('/log?' + u.pathname.slice(10) + '=' + e.request.referrerPolicy + ',' + (e.request.referrer || 'none')).then(() => new Response('')));
      });
    JS
    Rack::Builder.new {
      run lambda {|env|
        hits << (env['PATH_INFO'] == '/log' ? "/log?#{env['QUERY_STRING']}" : env['PATH_INFO'])
        referers[env['PATH_INFO']] = env['HTTP_REFERER']
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>in-scope</body></html>']]
        when '/scope/parsed.html' then [200, {'content-type' => 'text/html'}, ['<html><body><script src="/scope/swerr.js"></script></body></html>']]
        when '/other/x.css' then [200, {'content-type' => 'text/css'}, ['@import "y.css";']]
        when '/other/y.css' then [200, {'content-type' => 'text/css'}, ['p {}']]
        when '/scope/refused.css' then [200, {'content-type' => 'text/css'}, ['p { color: red }']]
        when '/ran.js' then [200, {'content-type' => 'text/javascript'}, ['parent.__ran.push("ran")']]
        when '/sheet.css' then [200, {'content-type' => 'text/css'}, ['p { color: red }']]
        when '/a.mp3' then [200, {'content-type' => 'audio/mpeg'}, [File.binread(File.expand_path('wpt/media/sound_5.mp3', __dir__))]]
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
            for (const type of events) el.addEventListener(type, () => { seen[key] ??= type; if (Object.keys(seen).length === 6) globalThis.__seen = seen; });
          };
          const through = d.createElement('link');
          through.rel = 'prefetch';
          watch(through, 'prefetch-through', ['load', 'error']);
          through.href = '/scope/absent';
          d.head.appendChild(through);
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
      'prefetch-through' => 'load',
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
        const entries = (w) => w.performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/swerr.js')).map((e) => e.initiatorType + ':' + e.responseStatus);
        const parsed = document.createElement('iframe');
        parsed.src = '/scope/parsed.html';
        parsed.onload = () => {
          const fromParser = entries(parsed.contentWindow);
          const f = document.createElement('iframe');
          f.src = '/scope/page.html';
          f.onload = () => {
            const d = f.contentDocument;
            const s = d.createElement('script');
            s.onerror = () => { globalThis.__seen = [fromParser, entries(f.contentWindow)]; };
            s.src = '/scope/swerr.js';
            d.head.appendChild(s);
          };
          document.body.appendChild(f);
        };
        document.body.appendChild(parsed);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__seen') }).to eq([['script:0'], ['script:0']])
  end
  # …and each answer a worker gives is its request's entry's response, as the network's would be: a sheet's content type
  # its answer's, a refused sheet's status the answer's, a CSS image's network error an entry of its times, an opaque
  # font answer's sizes hidden.
  it "files the entry of a worker's answer as its response's" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__seen = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = async () => {
          const d = f.contentDocument, W = f.contentWindow;
          d.head.insertAdjacentHTML('beforeend', '<link rel=stylesheet href=/scope/two.css><link rel=stylesheet href=/scope/refused.css>' +
                                                 '<style>@font-face{font-family:A;src:url(/scope/away-f.woff2)} #i{background-image:url(/scope/swerr.png)}</style>');
          d.body.insertAdjacentHTML('beforeend', '<div id=i style="width:9px;height:9px"></div>');
          await W.document.fonts.load('16px A').catch(() => {});
          const find = (path) => W.performance.getEntriesByType('resource').find((e) => e.name.endsWith(path));
          const poll = () => {
            const [two, refused, image, font] = ['/two.css', '/refused.css', '/swerr.png', '/away-f.woff2'].map(find);
            if (!(two && refused && image && font)) return setTimeout(poll, 20);
            globalThis.__seen = [two.contentType, refused.responseStatus, image.responseStatus, font.encodedBodySize];
          };
          poll();
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__seen') }).to eq(['text/css', 404, 0, 0])
  end

  # A style sheet a worker refuses (an answer of a status no sheet loads with) is no sheet: `.sheet` none of the network's
  # rules, and the network never asked for it — the cascade's and the getter's one answer. And a response is judged by
  # the mode its request was made in: an audio whose `crossorigin` is set while its no-cors request is in flight takes
  # the opaque answer a no-cors request may.
  it "takes a worker's answer as its request was made" do
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
          const link = d.createElement('link');
          link.rel = 'stylesheet';
          link.onerror = () => { seen.sheet = link.sheet ? link.sheet.cssRules.length : null; };
          link.href = '/scope/refused.css';
          d.head.appendChild(link);
          const audio = d.createElement('audio');
          for (const type of ['canplaythrough', 'error']) audio.addEventListener(type, () => { seen.audio ??= type; });
          audio.src = '/scope/away.mp3';
          d.body.appendChild(audio);
          setTimeout(() => { audio.crossOrigin = 'anonymous'; }, 0);
          const done = () => (seen.sheet !== undefined && seen.audio ? (globalThis.__seen = seen) : setTimeout(done, 10));
          done();
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__seen') }).to eq('sheet' => 0, 'audio' => 'canplaythrough')
    expect(hits).not_to include('/scope/refused.css')
  end
  # A classic script a worker answers with an opaque response runs where the response it hides is an ok one — HTML
  # "fetch a classic script" takes the response's unsafe response — and fails where that is a 404; a style sheet alike,
  # as the network's of another origin is judged by its real status.
  it 'runs an opaque script by the status it hides, and applies a sheet so' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__seen = null;
      globalThis.__ran = [];
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const d = f.contentDocument, seen = {};
          for (const name of ['ran.js', 'gone.js', 'sheet.css', 'gone.css']) {
            const css = name.endsWith('.css');
            const s = d.createElement(css ? 'link' : 'script');
            s.onload = () => { seen[name] = 'load'; if (Object.keys(seen).length === 4) globalThis.__seen = seen; };
            s.onerror = () => { seen[name] = 'error'; if (Object.keys(seen).length === 4) globalThis.__seen = seen; };
            if (css) { s.rel = 'stylesheet'; s.href = '/scope/away-' + name; } else { s.src = '/scope/away-' + name; }
            d.head.appendChild(s);
          }
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__seen') }).to eq('ran.js' => 'load', 'gone.js' => 'error', 'sheet.css' => 'load', 'gone.css' => 'error')
    expect(session.evaluate_script('__ran')).to eq(%w[ran])
  end
  # A prefetch's request is a link request (HTML "create a link request"), a potential-CORS one by its `crossorigin`:
  # the worker sees a CORS one for a link that has the attribute, a no-cors one for one that has none.
  it "hands the worker a prefetch's request as its crossorigin makes it" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const d = f.contentDocument;
          for (const [name, cors] of [['hint-plain', false], ['hint-cors', true]]) {
            const link = d.createElement('link');
            link.rel = 'prefetch';
            if (cors) link.crossOrigin = 'anonymous';
            link.href = '/scope/' + name;
            d.head.appendChild(link);
          }
        };
        document.body.appendChild(f);
      });
    JS
    # (…the page stepped as the driver asks it)
    expect(poll_until { session.evaluate_script('1') && (logged = hits.grep(%r{\A/log\?})).size == 2 && logged.sort }).to eq(%w[/log?hint-cors=cors /log?hint-plain=no-cors])
  end
  # …and as it is referred: under its element's `referrerpolicy` — an image's (a fetch event), a script's and a module
  # script's (the synchronous one) alike — its worker's `event.request` the policy and the referrer it is made with; an
  # audio, which has no such attribute, under its document's.
  it "hands the worker a request under its element's referrer policy" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const d = f.contentDocument;
          const img = d.createElement('img');
          img.referrerPolicy = 'no-referrer';
          img.src = '/scope/rp-img';
          d.body.appendChild(img);
          const script = d.createElement('script');
          script.referrerPolicy = 'no-referrer';
          script.src = '/scope/rp-script';
          d.head.appendChild(script);
          const module = d.createElement('script');
          module.type = 'module';
          module.referrerPolicy = 'no-referrer';
          module.src = '/scope/rp-module';
          d.head.appendChild(module);
          const audio = d.createElement('audio');
          audio.setAttribute('referrerpolicy', 'no-referrer');
          audio.src = '/scope/rp-audio';
          d.body.appendChild(audio);
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('1') && (logged = hits.grep(%r{\A/log\?(img|script|module|audio)=})).size == 4 && logged.sort }).to eq(
      %w[/log?audio=strict-origin-when-cross-origin,http://www.example.com/scope/page.html /log?img=no-referrer,none /log?module=no-referrer,none /log?script=no-referrer,none]
    )
  end
  # A CSS module script a document fetched before a worker controlled it is asked of the worker once one does: the
  # module map keeps responses, not that none answered (a worker that `clients.claim()`s takes the next fetch).
  it 'asks a worker that claimed the document for a CSS module fetched before it did' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.src = '/scope/page.html';
      f.onload = () => {
        const adopt = () => f.contentDocument.body.appendChild(f.contentDocument.createElement('div'))
          .setHTMLUnsafe('<div><template shadowrootmode=open shadowrootadoptedstylesheets="/scope/mod.css"><p>x</p></template></div>');
        adopt();
        navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
          const w = reg.installing || reg.waiting || reg.active;
          await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
          const claimed = () => (f.contentWindow.navigator.serviceWorker.controller ? adopt() : setTimeout(claimed, 10));
          claimed();
        });
      };
      document.body.appendChild(f);
    JS
    expect(poll_until { session.evaluate_script('1') && hits.include?('/log?mod') }).to be(true)
  end
  # …a style sheet request its link's own: two links of one URL — one `crossorigin` and of an `integrity`, one neither —
  # two requests, two fetch events, each of its link's mode and integrity (one dispatch per request however many
  # consumers read it: the cascade, `.sheet`, its load task).
  it "hands the worker each link's own sheet request" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const d = f.contentDocument;
          for (const cors of [true, false]) {
            const link = d.createElement('link');
            link.rel = 'stylesheet';
            if (cors) { link.crossOrigin = 'anonymous'; link.integrity = 'sha256-x'; }
            link.href = '/scope/two.css';
            d.head.appendChild(link);
            void link.sheet;
          }
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('1') && (logged = hits.grep(%r{\A/log\?two=})).size >= 2 && logged.sort }).to eq(%w[/log?two=cors,sha256-x /log?two=no-cors,none])
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(hits.grep(%r{\A/log\?two=}).size).to eq(2)
  end
  # …and a sheet a worker answered with another URL's response (`fetch()` of it) is at that URL: its `@import`s resolve
  # against it and are referred by it (Chrome, measured: `/scope/moved.css` answered with `/other/x.css`'s response
  # fetches `/other/y.css`, referred by `/other/x.css`).
  it "makes a worker's answer's sheet at the URL of the response it answered with" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const link = f.contentDocument.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/scope/moved.css';
          f.contentDocument.head.appendChild(link);
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('1') && hits.include?('/other/y.css') }).to be(true)
    expect(referers['/other/y.css']).to eq('http://www.example.com/other/x.css')
  end
end

