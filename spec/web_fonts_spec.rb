# frozen_string_literal: true

require 'capybara/simulated'
require 'zlib'
require_relative 'support/session_teardown'

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

  def session
    s = simulated_session(app)
    s.visit 'http://www.example.com/'
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
      window.__ev = [];
      document.fonts.addEventListener('loading', function () { __ev.push('loading'); });
      document.fonts.addEventListener('loadingdone', function (e) { __ev.push(['done', e.fontfaces.map(function (f) { return f.family; })]); });
      document.fonts.addEventListener('loadingerror', function (e) { __ev.push(['error', e.fontfaces.map(function (f) { return f.family; })]); });
      var el = document.createElement('span'); el.style.fontFamily = 'Gone'; el.textContent = 'x'; document.body.appendChild(el);
      document.fonts.ready.then(function (set) { __ev.push(['ready', set.status]); });
    JS
    # The first layout loads every face the page's text needs in one cycle — the two that work
    # and the one that fails — and `ready` settles after its events.
    ev = s.evaluate_script('__ev')
    expect(ev.length).to eq(4)
    expect(ev[0]).to eq('loading')
    expect(ev[1][0]).to eq('done')
    expect(ev[1][1]).to match_array(%w[MyAhem WoffAhem TwoSrc])                 # settled in fetch order
    expect(ev[2..]).to eq([['error', ['Gone']], ['ready', 'loaded']])
  end

  it 'measures a face script added to the set' do
    s = session
    s.execute_script("document.fonts.add(new FontFace('Added', 'url(/ahem.ttf)')); var el = document.createElement('span'); el.id = 'added'; el.style.fontFamily = 'Added'; el.textContent = 'abcd'; document.body.appendChild(el);")
    expect(width(s, 'added')).to eq(80)
  end

  it 'picks up an @font-face a later stylesheet declares' do
    s = session
    s.execute_script("var st = document.createElement('style'); st.textContent = '@font-face { font-family: Later; src: url(/ahem.ttf); }'; document.head.appendChild(st); var el = document.createElement('span'); el.id = 'later'; el.style.fontFamily = 'Later'; el.textContent = 'ab'; document.body.appendChild(el);")
    expect(width(s, 'later')).to eq(40)
  end
end
