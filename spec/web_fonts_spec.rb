# frozen_string_literal: true

require 'capybara/simulated'
require 'zlib'
require_relative 'support/session_teardown'
require_relative 'support/js_engine'

# Web fonts: a family the document declares an `@font-face` for is FETCHED the first time text
# needs it (Chrome loads a web font on first use) and measured with the downloaded file's own
# advances — Ahem's every glyph is one em wide, so `abcd` at 20px is 80px, whatever face
# fontconfig would substitute. The fetch is a `css` Resource Timing entry, and `document.fonts`
# is the CSS Font Loading set: one `FontFace` per `@font-face` rule with its status, `ready`,
# `check()` / `load()`, and a loading cycle's `loadingdone` / `loadingerror` events. A WOFF file
# is unwrapped on the host; a WOFF2 one has no decoder there, so it is fetched and the text
# measured with the fallback family.
RSpec.describe 'web fonts' do
  AHEM = File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))

  # Ahem wrapped as a WOFF (1.0): the SFNT tables zlib-compressed one by one.
  def woff_of(sfnt)
    num = sfnt[4, 2].unpack1('n')
    tables = (0...num).map {|i|
      tag, csum, off, len = sfnt[12 + i * 16, 16].unpack('a4NNN')
      data = sfnt[off, len]
      comp = Zlib::Deflate.deflate(data)
      [tag, csum, comp.bytesize < data.bytesize ? comp : data, data.bytesize]
    }
    offset = 44 + num * 20
    dir = +''
    body = +''
    tables.each do |tag, csum, data, orig|
      dir << [tag, offset + body.bytesize, data.bytesize, orig, csum].pack('a4NNNN')
      body << data << ("\0" * ((4 - data.bytesize % 4) % 4))
    end
    total = 12 + num * 16 + tables.sum {|_, _, _, orig| orig + (4 - orig % 4) % 4 }
    (['wOFF', sfnt[0, 4], offset + body.bytesize, num, 0, total, 1, 0, 0, 0, 0, 0, 0].pack('a4a4NnnNnnNNNNN') + dir + body).b
  end

  def app
    ->(env) {
      case env['PATH_INFO']
      when '/ahem.ttf'  then [200, {'content-type' => 'font/ttf'}, [AHEM]]
      when '/ahem.woff' then [200, {'content-type' => 'font/woff'}, [woff_of(AHEM)]]
      when '/missing.ttf' then [404, {'content-type' => 'text/plain'}, ['no']]
      when '/css/rel.css' then [200, {'content-type' => 'text/css'}, ['@font-face { font-family: Rel; src: url(ahem.ttf); }']]
      when '/css/ahem.ttf' then [200, {'content-type' => 'font/ttf'}, [AHEM]]
      when '/css/imp.css' then [200, {'content-type' => 'text/css'}, ['@font-face { font-family: Imp; src: url("ahem.ttf"); }']]
      when '/cyc-a.css' then [200, {'content-type' => 'text/css'}, ['@import url(/cyc-b.css); @font-face { font-family: CycA; src: url(/ahem.ttf); }']]
      when '/cyc-b.css' then [200, {'content-type' => 'text/css'}, ['@import url(/cyc-a.css); @font-face { font-family: CycB; src: url(/ahem.ttf); }']]
      when '/nested.html'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><html><head>
            <link rel="stylesheet" href="/css/rel.css">
            <style>
              body { margin: 0; font: 20px monospace }
              @import url("/css/imp.css");
              @media screen { @font-face { font-family: InMedia; src: url("/ahem.ttf"); } }
              @supports (display: block) { @font-face { font-family: InSupports; src: url("/ahem.ttf"); } }
              @font-face { font-family: Bold; src: url("/ahem.ttf"); font-weight: bold; }
              @font-face { font-family: Bold; src: url("/missing.ttf"); font-weight: normal; }
            </style>
            <style media="print">@font-face { font-family: Print; src: url("/ahem.ttf"); }</style>
            <link rel="alternate stylesheet" title="alt" href="/css/imp.css">
          </head><body>
            <span id="rel" style="font-family: Rel">abcd</span>
            <span id="imp" style="font-family: Imp">abcd</span>
            <span id="media" style="font-family: InMedia">abcd</span>
            <span id="sup" style="font-family: InSupports">abcd</span>
            <span id="print" style="font-family: Print">abcd</span>
            <span id="bold" style="font-family: Bold; font-weight: bold">abcd</span>
            <span id="regular" style="font-family: Bold">abcd</span>
          </body></html>
        HTML
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><html><head><style>
            body { margin: 0; font: 20px monospace }
            @font-face { font-family: MyAhem; src: url("/ahem.ttf") format("truetype"); }
            @font-face { font-family: WoffAhem; src: url("/ahem.woff") format("woff"); }
            @font-face { font-family: TwoSrc; src: url("/ahem.woff2") format("woff2"), url("/ahem.ttf") format("truetype"); }
            @font-face { font-family: OnlyWoff2; src: url("/ahem.woff2") format("woff2"); }
            @font-face { font-family: Gone; src: url("/missing.ttf"); }
          </style></head><body>
            <span id="t" style="font-family: MyAhem">abcd</span>
            <span id="w" style="font-family: WoffAhem">abcd</span>
            <span id="two" style="font-family: TwoSrc">abcd</span>
            <span id="m" style="font-family: monospace">abcd</span>
          </body></html>
        HTML
      end
    }
  end

  def session(path = '/')
    s = simulated_session(app)
    s.visit "http://www.example.com#{path}"
    s
  end

  def width(s, id)
    s.evaluate_script("document.getElementById(#{id.to_json}).getBoundingClientRect().width")
  end

  it 'measures text with the downloaded face' do
    s = session
    expect(width(s, 't')).to eq(80)                                        # four one-em glyphs at 20px
    expect(width(s, 'm')).not_to eq(80)
  end

  it 'unwraps a WOFF face on the host' do
    s = session
    expect(width(s, 'w')).to eq(80)
  end

  it 'takes the first src the host can read, skipping a WOFF2 one' do
    s = session
    expect(width(s, 'two')).to eq(80)
    names = s.evaluate_script("performance.getEntriesByType('resource').filter(function (e) { return e.initiatorType === 'css'; }).map(function (e) { return e.name.split('/').pop(); })")
    expect(names).to include('ahem.ttf')
    expect(names).not_to include('ahem.woff2')
  end

  it 'records the fetch as a css Resource Timing entry, once per face' do
    s = session
    s.execute_script("var e = document.createElement('span'); e.style.fontFamily = 'MyAhem'; e.textContent = 'again'; document.body.appendChild(e); e.getBoundingClientRect();")
    entries = s.evaluate_script("performance.getEntriesByType('resource').filter(function (e) { return e.name.slice(-9) === '/ahem.ttf'; }).map(function (e) { return [e.initiatorType, e.responseStatus, e.encodedBodySize]; })")
    expect(entries).to eq([['css', 200, AHEM.bytesize]])
  end

  it 'exposes the CSS-connected faces on document.fonts with their status' do
    s = session
    faces = s.evaluate_script("Array.from(document.fonts).map(function (f) { return [f.family, f.status]; })")
    expect(faces).to include(['MyAhem', 'loaded'], ['WoffAhem', 'loaded'], ['Gone', 'unloaded'])
    expect(s.evaluate_script("[document.fonts.size, document.fonts.check('12px MyAhem'), document.fonts.check('12px Gone'), document.fonts.check('12px monospace')]")).to eq([5, true, false, true])
    expect(s.evaluate_script("Object.prototype.toString.call(document.fonts)")).to eq('[object FontFaceSet]')
  end

  it 'loads a face on demand through load() and rejects one that fails' do
    s = session
    s.execute_script(<<~JS)
      window.__l = [];
      document.fonts.load('16px Gone').then(function (fs) { __l.push(['gone', fs.length]); }, function (e) { __l.push(['gone', e.name]); });
      var f = new FontFace('Late', 'url(/ahem.ttf)');
      __l.push(['late before', f.status]);
      document.fonts.add(f);
      f.load().then(function (x) { __l.push(['late', x.status, document.fonts.check('10px Late')]); });
    JS
    expect(s.evaluate_script('__l')).to match_array([['late before', 'unloaded'], ['gone', 'NetworkError'], ['late', 'loaded', true]])
    expect(s.evaluate_script("Array.from(document.fonts).filter(function (f) { return f.family === 'Gone'; })[0].status")).to eq('error')
  end

  it 'runs a loading cycle with loadingdone and loadingerror events and settles ready after it' do
    s = session
    s.execute_script(<<~JS)
      window.__ev = []; window.__err = [];
      document.fonts.addEventListener('loading', function () { __ev.push('loading'); });
      document.fonts.addEventListener('loadingdone', function (e) { __ev.push('done'); });
      document.fonts.addEventListener('loadingerror', function (e) { __err.push.apply(__err, e.fontfaces.map(function (f) { return f.family; })); });
      var el = document.createElement('span'); el.style.fontFamily = 'Gone'; el.textContent = 'x'; document.body.appendChild(el);
      document.fonts.ready.then(function (set) { __ev.push('ready:' + set.status); });
    JS
    ev = s.evaluate_script('__ev')
    expect(ev.first).to eq('loading')                                    # a fetch opens a cycle
    expect(ev).to include('done')                                        # and closes it
    expect(ev.last).to eq('ready:loaded')                                # ready settles after
    expect(s.evaluate_script('__err')).to eq(['Gone'])                   # the 404 face errors
    faces = s.evaluate_script("Array.from(document.fonts).filter(function (f) { return ['MyAhem', 'WoffAhem', 'TwoSrc'].indexOf(f.family) !== -1; }).map(function (f) { return f.status; })")
    expect(faces).to eq(%w[loaded loaded loaded])                        # the working faces are in
  end

  it 'measures a face script added to the set' do
    s = session
    s.execute_script("document.fonts.add(new FontFace('Added', 'url(/ahem.ttf)')); var el = document.createElement('span'); el.id = 'added'; el.style.fontFamily = 'Added'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'added')).to eq(80)
  end

  # ── which rules apply, and against what base ──
  it 'resolves a src against the stylesheet that declares it' do
    s = session('/nested.html')
    expect(width(s, 'rel')).to eq(80)
    names = s.evaluate_script("performance.getEntriesByType('resource').filter(function (e) { return e.initiatorType === 'css'; }).map(function (e) { return e.name.replace('http://www.example.com', ''); })")
    expect(names).to include('/css/ahem.ttf')
  end

  it 'sees faces inside @import, @media and @supports, and not those of a print or alternate sheet' do
    s = session('/nested.html')
    expect([width(s, 'imp'), width(s, 'media'), width(s, 'sup')]).to eq([80, 80, 80])
    expect(width(s, 'print')).not_to eq(80)
    families = s.evaluate_script("Array.from(document.fonts).map(function (f) { return f.family; })")
    expect(families).to include('Rel', 'Imp', 'InMedia', 'InSupports')
    expect(families).not_to include('Print')
    expect(families.count('Imp')).to eq(1)                                # the alternate sheet's copy is off
  end

  it 'picks the face by weight' do
    s = session('/nested.html')
    expect(width(s, 'bold')).to eq(80)
    expect(width(s, 'regular')).not_to eq(80)                                 # the normal-weight face 404s
  end

  it 'does not loop on an @import cycle' do
    s = session
    s.execute_script("var st = document.createElement('style'); st.textContent = '@import url(/cyc-a.css);'; document.head.appendChild(st); var el = document.createElement('span'); el.id = 'cyc'; el.style.fontFamily = 'CycA'; el.textContent = 'ab'; document.body.appendChild(el);")
    expect(width(s, 'cyc')).to eq(40)
    fetches = s.evaluate_script("performance.getEntriesByType('resource').filter(function (e) { return /cyc-[ab].css/.test(e.name); }).length")
    expect(fetches).to be <= 2                                                # each imported sheet once, no runaway
  end

  it 'shares one temp file across identical buffer faces' do
    s = session
    s.execute_script("fetch('/ahem.ttf').then(function (r) { return r.arrayBuffer(); }).then(function (buf) { for (var i = 0; i < 50; i++) new FontFace('B' + i, buf); window.__done = 1; });")
    expect(s.evaluate_script('window.__done')).to eq(1)                       # 50 buffer faces, no fd blow-up (content-addressed)
  end

  it 'follows insertRule and deleteRule on an existing sheet' do
    s = session
    s.execute_script("var el = document.createElement('span'); el.id = 'ins'; el.style.fontFamily = 'Inserted'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'ins')).not_to eq(80)
    s.execute_script("document.styleSheets[0].insertRule('@font-face { font-family: Inserted; src: url(/ahem.ttf); }', 0)")
    expect(width(s, 'ins')).to eq(80)
    s.execute_script("document.styleSheets[0].deleteRule(0)")
    expect(width(s, 'ins')).not_to eq(80)
  end

  it 'lays text out again when a face is added to the set and loaded' do
    s = session
    s.execute_script("var el = document.createElement('span'); el.id = 'late'; el.style.fontFamily = 'Late'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'late')).not_to eq(80)
    s.execute_script("var f = new FontFace('Late', 'url(/ahem.ttf)'); document.fonts.add(f); window.__ld = f.load();")
    expect(width(s, 'late')).to eq(80)
  end

  it 'fails a cross-origin face the server does not share' do
    s = session
    s.execute_script("var st = document.createElement('style'); st.textContent = '@font-face { font-family: Xo; src: url(http://other.example.com/ahem.ttf); }'; document.head.appendChild(st); var el = document.createElement('span'); el.id = 'xo'; el.style.fontFamily = 'Xo'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'xo')).not_to eq(80)
    expect(s.evaluate_script("Array.from(document.fonts).filter(function (f) { return f.family === 'Xo'; })[0].status")).to eq('error')
  end

  it 'loads a WOFF2 face without measuring with it' do
    s = session
    s.execute_script("var el = document.createElement('span'); el.id = 'w2'; el.style.fontFamily = 'OnlyWoff2'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'w2')).not_to eq(80)
    expect(s.evaluate_script("Array.from(document.fonts).filter(function (f) { return f.family === 'OnlyWoff2'; })[0].status")).to eq('loaded')
  end

  it 'rejects a font shorthand it cannot parse' do
    s = session
    expect(s.evaluate_script("['12px inherit', 'MyAhem', '', '12px', 'var(--x) MyAhem', '12px initial'].map(function (f) { try { document.fonts.check(f); return 'ok'; } catch (e) { return e.name; } })")).to eq(%w[SyntaxError] * 6)
    s.execute_script("window.__r = null; document.fonts.load('12px inherit').then(function () { __r = 'ok'; }, function (e) { __r = e.name; });")
    expect(s.evaluate_script('__r')).to eq('SyntaxError')
    expect(s.evaluate_script("[document.fonts.check('bold 16px MyAhem'), document.fonts.check('12px/1.5 \"MyAhem\", monospace')]")).to eq([true, true])
  end

  it 'builds a face from a buffer and measures with it' do
    s = session
    s.execute_script(<<~JS)
      window.__b = [];
      fetch('/ahem.ttf').then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        var f = new FontFace('Buf', buf); document.fonts.add(f);
        return f.loaded.then(function () { __b.push(f.status); var el = document.createElement('span'); el.id = 'buf'; el.style.fontFamily = 'Buf'; el.textContent = 'abcd'; document.body.appendChild(el); });
      });
      var bad = new FontFace('Bad', new ArrayBuffer(10)); bad.loaded.catch(function (e) { __b.push(e.name); });
    JS
    expect(s.evaluate_script('__b')).to match_array(%w[loaded SyntaxError])
    expect(width(s, 'buf')).to eq(80)
  end

  # ── the worker scope ──
  it 'exposes self.fonts in a worker and rejects a css-wide keyword as a DOMException' do
    skip 'worker microtask delivery under the rspec poll needs the V8 engine' unless CsimEngine.v8?
    s = session
    # The worker checks `instanceof DOMException` itself and reports a string.
    s.execute_script(<<~JS)
      window.__w = [];
      var blob = new Blob(["self.postMessage(typeof self.fonts); self.fonts.load('inherit').then(function () { self.postMessage('ok'); }, function (e) { self.postMessage((e instanceof DOMException ? 'DOMException:' : typeof e + ':') + (e && e.name)); });"]);
      var w = new Worker(URL.createObjectURL(blob));
      w.onmessage = function (m) { __w.push(m.data); };
    JS
    Timeout.timeout(5) { sleep 0.05 until s.evaluate_script('window.__w.length >= 2') }
    expect(s.evaluate_script('window.__w')).to eq(['object', 'DOMException:SyntaxError'])
  end

  it 'clones a DOMException a worker posts back as a real DOMException' do
    s = session
    s.execute_script(<<~JS)
      window.__d = null;
      var blob = new Blob(["self.postMessage(new DOMException('boom', 'DataCloneError'));"]);
      var w = new Worker(URL.createObjectURL(blob));
      w.onmessage = function (m) { __d = [m.data instanceof DOMException, m.data.name, m.data.message]; };
    JS
    Timeout.timeout(5) { sleep 0.05 until s.evaluate_script('window.__d') }
    expect(s.evaluate_script('window.__d')).to eq([true, 'DataCloneError', 'boom'])
  end

  it 'picks up an @font-face a later stylesheet declares' do
    s = session
    s.execute_script("var st = document.createElement('style'); st.textContent = '@font-face { font-family: Later; src: url(/ahem.ttf); }'; document.head.appendChild(st); var el = document.createElement('span'); el.id = 'later'; el.style.fontFamily = 'Later'; el.textContent = 'ab'; document.body.appendChild(el);")
    expect(width(s, 'later')).to eq(40)
  end
end
