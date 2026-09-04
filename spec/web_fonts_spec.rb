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
# is unwrapped on the host, a WOFF2 one Brotli-decoded, and either measures with the face's own
# advances.
RSpec.describe 'web fonts' do
  AHEM = File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))

  # Ahem encoded as a WOFF2 (Brotli), generated once from Ahem.ttf with `woff2_compress`.
  AHEM_WOFF2 = File.binread(File.expand_path('fixtures/fonts/Ahem.woff2', __dir__))

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
      when '/ahem.woff2' then [200, {'content-type' => 'font/woff2'}, [AHEM_WOFF2]]
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
            @font-face { font-family: Overridden; src: url("/ahem.ttf"); ascent-override: 100%; descent-override: 100%; line-gap-override: 100%; }
            @font-face { font-family: Doubled; src: url("/ahem.ttf"); size-adjust: 200%; }
            @font-face { font-family: Combined; src: url("/ahem.ttf"); size-adjust: 200%; ascent-override: 100%; }
            @font-face { font-family: Scoped; src: url("/ahem.ttf"); size-adjust: 200%; unicode-range: U+41-5A; }
            @font-face { font-family: ScopedBase; src: url("/ahem.ttf"); }
            @font-face { font-family: Low; src: url("/ahem.ttf"); unicode-range: U+61-7A; }
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

  it 'takes the first supported src — a WOFF2 ahead of a TrueType one' do
    s = session
    expect(width(s, 'two')).to eq(80)                                      # the WOFF2 Ahem, decoded
    names = s.evaluate_script("performance.getEntriesByType('resource').filter(function (e) { return e.initiatorType === 'css'; }).map(function (e) { return e.name.split('/').pop(); })")
    expect(names).to include('ahem.woff2')                                 # the WOFF2 src was the one fetched
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
    expect(s.evaluate_script("[document.fonts.size, document.fonts.check('12px MyAhem'), document.fonts.check('12px Gone'), document.fonts.check('12px monospace')]")).to eq([11, true, false, true])
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

  it 'measures with a WOFF2 face, Brotli-decoded on the host' do
    s = session
    s.execute_script("var el = document.createElement('span'); el.id = 'w2'; el.style.fontFamily = 'OnlyWoff2'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'w2')).to eq(80)                                       # four one-em Ahem glyphs at 20px
    expect(s.evaluate_script("Array.from(document.fonts).filter(function (f) { return f.family === 'OnlyWoff2'; })[0].status")).to eq('loaded')
  end

  it 'decodes a WOFF2 body regardless of its string encoding' do
    # The container is parsed with a byte cursor but sliced with String#[] (character-based), so a
    # font body that reached the host tagged UTF-8 would misalign without a binary coercion.
    browser = Capybara::Simulated::Browser.allocate
    binary  = browser.woff_to_sfnt(AHEM_WOFF2)
    tagged  = browser.woff_to_sfnt(AHEM_WOFF2.dup.force_encoding('UTF-8'))
    expect(binary).to be_a(String)
    expect(tagged).to eq(binary)
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

  # ── metric descriptors reach layout ──
  it 'drives the line box height from the metric override descriptors' do
    s = session
    s.execute_script("var o = document.createElement('div'); o.id = 'o'; o.style.cssText = 'font: 20px Overridden'; o.textContent = 'X'; document.body.appendChild(o);")
    expect(s.evaluate_script("document.getElementById('o').getBoundingClientRect().height")).to eq(60)   # ascent+descent+gap = 3em at 20px
    expect(width(s, 't')).to eq(80)                                          # the same face without overrides measures 1em/glyph
  end

  it 'scales the advances by size-adjust' do
    s = session
    s.execute_script("var d = document.createElement('span'); d.id = 'd'; d.style.cssText = 'font: 20px Doubled'; d.textContent = 'XX'; document.body.appendChild(d); var p = document.createElement('span'); p.id = 'p'; p.style.cssText = 'font: 20px MyAhem'; p.textContent = 'XX'; document.body.appendChild(p);")
    dw = s.evaluate_script("document.getElementById('d').getBoundingClientRect().width")
    pw = s.evaluate_script("document.getElementById('p').getBoundingClientRect().width")
    expect(dw).to eq(2 * pw)                                                  # size-adjust: 200% doubles the run width
  end

  it 'scales a metric override by size-adjust' do
    # The fallback-matching recipe sets size-adjust AND the overrides together, so size-adjust
    # scales the RESOLVED metric: a 100% ascent override under size-adjust: 200% is 2em, not 1em.
    # Chrome (Ahem, 20px): 100% * 200% ascent + intrinsic 0.2 * 200% descent = 40 + 8 = 48px.
    s = session
    s.execute_script("var c = document.createElement('div'); c.id = 'c'; c.style.cssText = 'font: 20px Combined'; c.textContent = 'X'; document.body.appendChild(c);")
    expect(s.evaluate_script("document.getElementById('c').getBoundingClientRect().height")).to eq(48)
  end

  it 'selects a face per character by unicode-range' do
    # The stack is a size-adjust:200% face scoped to U+41-5A (uppercase) over a universal family.
    # In "AbCd" the A and C double (40px each at 20px), the lowercase fall through to `ScopedBase`
    # (20px) — a run split across faces, as Chrome renders the size-adjust reftest.
    s = session
    s.execute_script("var e = document.createElement('div'); e.id = 'sc'; e.style.cssText = 'display: inline-block; font: 20px Scoped, ScopedBase'; e.textContent = 'AbCd'; document.body.appendChild(e);")
    expect(s.evaluate_script("document.getElementById('sc').getBoundingClientRect().width")).to eq(120)   # 40 + 20 + 40 + 20
  end

  it 'sends a character outside every range to the system font, not the restricted face' do
    # `Scoped` alone covers only U+41-5A. Its uppercase glyphs double (size-adjust: 200%), but a
    # lowercase letter no face covers must fall to the system font — NOT be measured through the
    # scoped face's doubled table (a Chrome-faithful last resort, so size-adjust can't leak out).
    s = session
    s.execute_script("var mk = function (t) { var e = document.createElement('span'); e.style.cssText = 'display: inline-block; font: 20px Scoped'; e.textContent = t; document.body.appendChild(e); return e.getBoundingClientRect().width; }; window.__wUp = mk('AB'); window.__wMix = mk('Ab');")
    expect(s.evaluate_script('window.__wUp')).to eq(80)                     # A and B both covered → 40 + 40
    expect(s.evaluate_script('window.__wMix')).to be < 80                   # b uncovered → system font, not the doubled face
  end

  it 'grows the line box to a taller non-primary face' do
    # Stack `Low, Scoped`: the lowercase `a` takes `Low` (the 20px primary), the uppercase `B` the
    # A–Z-scoped size-adjust:200% `Scoped` (40px) — which is NOT the primary. The line box must
    # still grow to the 40px face, as Chrome raises a line for its tallest glyph.
    s = session
    s.execute_script("var e = document.createElement('div'); e.id = 'np'; e.style.cssText = 'display: inline-block; font: 20px Low, Scoped'; e.textContent = 'aB'; document.body.appendChild(e);")
    r = s.evaluate_script("var b = document.getElementById('np').getBoundingClientRect(); [b.width, b.height]")
    expect(r).to eq([60, 40])                                              # a(20) + B(40) wide; line box 40 tall
  end

  it 'fits both the deepest ascent and the deepest descent when they come from different faces' do
    # Two scoped faces with ASYMMETRIC overrides: `A` is all ascent (2em up, 0 down) for U+41, `B`
    # all descent (0 up, 3em down) for U+42. In "AB" the line must fit A's 40px ascent AND B's 60px
    # descent — 100px — not collapse to one face's box (folding a combined height would clip B).
    doc = <<~HTML
      <!DOCTYPE html><html><head><style>
        body { margin: 0 }
        @font-face { font-family: AscOnly;  src: url(/ahem.ttf); ascent-override: 200%; descent-override: 0%;   unicode-range: U+41 }
        @font-face { font-family: DescOnly; src: url(/ahem.ttf); ascent-override: 0%;   descent-override: 300%; unicode-range: U+42 }
      </style></head><body><div id="ab" style="display: inline-block; font: 20px AscOnly, DescOnly">AB</div></body></html>
    HTML
    a = ->(env) { env['PATH_INFO'] == '/ahem.ttf' ? [200, {'content-type' => 'font/ttf'}, [AHEM]] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(a)
    s.visit 'http://www.example.com/'
    expect(s.evaluate_script("document.getElementById('ab').getBoundingClientRect().height")).to eq(100)
  end

  # ── descriptors ──
  it 'validates a FontFace override / size-adjust descriptor on set and in the constructor' do
    s = session
    out = s.evaluate_script(<<~JS)
      (function () {
        var r = {};
        var f = new FontFace('D', 'url(/ahem.ttf)', { ascentOverride: '90%', sizeAdjust: '150%' });
        r.round = [f.ascentOverride, f.descentOverride, f.sizeAdjust, f.lineGapOverride];
        r.defaults = (function () { var g = new FontFace('E', 'url(/ahem.ttf)'); return [g.ascentOverride, g.sizeAdjust, g.display]; })();
        r.setThrows = ['10px', '-5%', 'x'].map(function (v) { try { f.ascentOverride = v; return 'ok'; } catch (e) { return e.name; } });
        f.ascentOverride = '25%'; r.setOk = f.ascentOverride;
        return r;
      })()
    JS
    expect(out['round']).to eq(['90%', 'normal', '150%', 'normal'])
    expect(out['defaults']).to eq(['normal', '100%', 'auto'])
    expect(out['setThrows']).to eq(%w[SyntaxError SyntaxError SyntaxError])
    expect(out['setOk']).to eq('25%')
  end

  it 'normalizes a descriptor value and accepts calc()' do
    s = session
    out = s.evaluate_script(<<~JS)
      (function () {
        var f = new FontFace('N', 'url(/ahem.ttf)');
        var norm = ['  90% ', '+50%', '.5%', '-0%', 'NORMAL', '50.0%'].map(function (v) { f.ascentOverride = v; return f.ascentOverride; });
        f.sizeAdjust = 'calc(50%)'; f.display = 'BLOCK';
        return { norm: norm, calc: f.sizeAdjust, display: f.display, keys: Object.keys(f), json: JSON.stringify(f) };
      })()
    JS
    expect(out['norm']).to eq(['90%', '50%', '0.5%', '0%', 'normal', '50%'])
    expect(out['calc']).to eq('calc(50%)')
    expect(out['display']).to eq('block')
    expect(out['keys']).to eq([])                                             # no internal slots leak
    expect(out['json']).to eq('{}')
  end

  it 'errors a face built with an invalid descriptor at construction, rejecting loaded without load()' do
    s = session
    # Chrome errors it synchronously: status 'error' at once, the bad value discarded, and
    # `loaded` already rejected whether or not `load()` is called.
    s.execute_script("window.__r = []; window.__st = null; window.__av = null; var f = new FontFace('Bad', 'url(/ahem.ttf)', { ascentOverride: '-50%' }); __st = f.status; __av = f.ascentOverride; f.loaded.then(function () { __r.push('ok'); }, function (e) { __r.push(e.name); });")
    expect(s.evaluate_script('window.__st')).to eq('error')
    expect(s.evaluate_script('window.__av')).to eq('normal')                  # the invalid value is discarded
    Timeout.timeout(5) { sleep 0.05 until s.evaluate_script('window.__r.length >= 1') }
    expect(s.evaluate_script('window.__r')).to eq(['SyntaxError'])            # loaded rejected, no load() call
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

  it 'loads a face on demand inside a worker' do
    skip 'worker microtask delivery under the rspec poll needs the V8 engine' unless CsimEngine.v8?
    s = session
    s.execute_script(<<~JS)
      window.__w = null;
      var blob = new Blob(["var f = new FontFace('W', 'url(/ahem.ttf)'); self.fonts.add(f); f.load().then(function (x) { self.postMessage('loaded:' + x.status); }, function (e) { self.postMessage('rej:' + e.name); });"]);
      var w = new Worker(URL.createObjectURL(blob));
      w.onmessage = function (m) { __w = m.data; };
    JS
    Timeout.timeout(5) { sleep 0.05 until s.evaluate_script('window.__w') }
    expect(s.evaluate_script('window.__w')).to eq('loaded:loaded')            # the fetch settles the face
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

  it 'clones an Error subtype a worker posts back, by its name, with stack and cause' do
    s = session
    s.execute_script(<<~JS)
      window.__e = null;
      var blob = new Blob(["var e = new TypeError('t'); e.stack = 'SX'; e.cause = {c: 1}; self.postMessage(e); var r = new Error('x'); r.name = 'RangeError'; self.postMessage(r);"]);
      var w = new Worker(URL.createObjectURL(blob));
      window.__all = [];
      w.onmessage = function (m) { __all.push([m.data instanceof TypeError, m.data.constructor.name, m.data.stack, m.data.cause && m.data.cause.c]); };
    JS
    Timeout.timeout(5) { sleep 0.05 until s.evaluate_script('window.__all.length >= 2') }
    all = s.evaluate_script('window.__all')
    expect(all[0]).to eq([true, 'TypeError', 'SX', 1])                        # subtype by name, stack + cause kept
    expect(all[1][1]).to eq('RangeError')                                     # a standard .name selects the subtype
  end

  it 'picks up an @font-face a later stylesheet declares' do
    s = session
    s.execute_script("var st = document.createElement('style'); st.textContent = '@font-face { font-family: Later; src: url(/ahem.ttf); }'; document.head.appendChild(st); var el = document.createElement('span'); el.id = 'later'; el.style.fontFamily = 'Later'; el.textContent = 'ab'; document.body.appendChild(el);")
    expect(width(s, 'later')).to eq(40)
  end
end
