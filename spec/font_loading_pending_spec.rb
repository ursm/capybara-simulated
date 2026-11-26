# frozen_string_literal: true

require 'capybara/simulated'
require 'securerandom'
require_relative 'support/session_teardown'

# A web font as CSS Font Loading loads it: its download begun the first time text needs the face (or a script asks),
# made in parallel — its server's time on the virtual clock — and landing as a task. Until then the text is laid out with
# the fallback (CSS Fonts 4 §4.9: whatever the `font-display`, a block period's text is invisible, not unmeasured), after
# it with the face — where it came within the face's block and swap periods. The document's `load` waits for it, and
# the FontFaceSet goes through its cycle: `loading` as layout begins the load, `ready` pending until the document is
# completely loaded and nothing loads. Every figure here is Chrome's and Firefox's (csim-bench font7 probes).
RSpec.describe 'web fonts loading in parallel' do

  # (…Ahem's every glyph is one em wide: `abcd` at 20px is 80px with the face, something else with the fallback)
  def app
    ->(env) {
      if (m = env['PATH_INFO'].match(%r{\A/slow/(\d+)/(\w+)\.ttf\z}))
        requested << m[2]
        sleep(m[1].to_i / 1000.0)
        next m[2] == 'ahem' ? [200, {'content-type' => 'font/ttf'}, [ahem]] : [404, {}, ['no']]
      end
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]]
    }
  end

  def ahem
    @ahem ||= File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))
  end

  # (…the fonts the server was asked for, by name)
  def requested
    @requested ||= []
  end

  def head
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.L = [];
        var t = function () { return Math.round(performance.now() / 50) * 50; };
        var w = function () { return document.getElementById('s').getBoundingClientRect().width; };
        addEventListener('DOMContentLoaded', function () { L.push('dcl@' + t()); });
        addEventListener('load', function () { L.push('load@' + t() + ':' + w() + ':' + document.fonts.status); });
      </script>
    HTML
  end

  # (…each page's its own URL: the host keeps a font it fetched for the process, which another visit's then has at once)
  def font(ms, name = 'ahem')
    "/slow/#{ms}/#{name}.ttf?#{SecureRandom.hex(4)}"
  end

  def face(ms, name: 'ahem', display: nil)
    display &&= "; font-display: #{display}"
    %(<style>@font-face { font-family: A; src: url(#{font(ms, name)})#{display} }</style><span id="s" style="font: 20px A, monospace">abcd</span>)
  end

  def pages
    shared = font(300)
    {
      # A script reads the text as it is parsed: the fallback, the face's download begun, the set `loading` with it (Chrome
      # and Firefox, csim-bench rv `r12`).
      '/read.html' => head + face(300) + <<~HTML,
        <script>
          L.push('inline:' + w() + ':' + document.fonts.status + ':' + Array.from(document.fonts)[0].status + ':' + document.fonts.check('20px A'));
          setTimeout(function () { L.push('task:' + document.fonts.status); }, 0);
          document.fonts.ready.then(function () { L.push('ready@' + t() + ':' + w()); });
          document.fonts.onloadingdone = function (e) { L.push('loadingdone:' + e.fontfaces.length); };
        </script>
      HTML
      # No script reads anything: the document's load waits for the face its text uses all the same.
      '/quiet.html' => head + face(300),
      # …and for none its text does not use.
      '/unused.html' => head + %(<style>@font-face { font-family: A; src: url(#{font(300)}) }</style><span id="s">abcd</span>),
      '/failed.html' => head + face(300, name: 'missing') + <<~HTML,
        <script>document.fonts.onloadingerror = function (e) { L.push('loadingerror:' + e.fontfaces[0].status); };</script>
      HTML
      '/optional.html' => head + face(300, display: 'optional'),
      '/fallback.html' => head + face(3500, display: 'fallback'),
      '/swap.html' => head + face(3500, display: 'swap'),
      # `ready` is pending while the document loads, whether or not a face does.
      '/ready.html' => head + <<~HTML,
        <span id="s">abcd</span><script>document.fonts.ready.then(function () { L.push('ready'); });</script>
      HTML
      # Two faces of one family split by `unicode-range`: the one covering none of the text is never downloaded.
      '/ranges.html' => head + <<~HTML,
        <style>
          @font-face { font-family: A; src: url(#{font(300)}); unicode-range: U+0-7F }
          @font-face { font-family: A; src: url(#{font(300, 'han')}); unicode-range: U+4E00-4FFF }
        </style><span id="s" style="font: 20px A, monospace">abcd</span>
      HTML
      # `stop()` while the face downloads: its download cancelled, the face failed a task later, the set loaded.
      '/stop.html' => head + face(1000) + <<~HTML,
        <script>
          w();
          document.fonts.ready.then(function () { L.push('ready:' + Array.from(document.fonts)[0].status); });
          document.fonts.onloadingerror = function (e) { L.push('loadingerror:' + e.fontfaces.length); };
          setTimeout(function () {
            window.stop();
            L.push('stopped:' + Array.from(document.fonts)[0].status);
          }, 100);
        </script>
      HTML
      # A `fallback` face whose first source fails after 2 s and whose second comes 1.5 s later: past 3.1 s of the face's
      # load, though its own download took 1.5 s.
      '/second.html' => head + %(<style>@font-face { font-family: A; src: url(#{font(2000, 'missing')}), url(#{font(1500)}); font-display: fallback }</style><span id="s" style="font: 20px A, monospace">abcd</span>),
      # Two families whose faces name one URL, the text using one: the other face is no load of its own, `unloaded` (Chrome
      # and Firefox, csim-bench rv `sh1nob`) — until text uses it, which the one download answers (`sh1txt`).
      '/shared.html' => head + <<~HTML,
        <style>@font-face { font-family: A; src: url(/slow/300/ahem.ttf?shared) } @font-face { font-family: B; src: url(/slow/300/ahem.ttf?shared) }</style>
        <span id="s" style="font: 20px A, monospace">abcd</span>
        <script>document.fonts.onloadingdone = function (e) { L.push('loadingdone:' + e.fontfaces.length); };</script>
      HTML
      # A face nothing uses whose fallback source is the used face's URL: not loaded as that download lands, and the load
      # waits for none of its own (Chrome and Firefox, csim-bench rv `r1`).
      '/unused-source.html' => head + %(<style>@font-face { font-family: A; src: url(#{shared}) } @font-face { font-family: B; src: url(#{font(1500, 'missing')}), url(#{shared}) }</style><span id="s" style="font: 20px A, monospace">abcd</span>),
      # A face whose download `stop()` cancelled, and a FontFace of its URL later: a download of its own, which loads
      # (Chrome and Firefox, csim-bench rv `r18`).
      '/stop-again.html' => head + <<~HTML,
        <title>stopping</title><style>@font-face { font-family: A; src: url(#{shared}) }</style><span id="s" style="font: 20px A, monospace">abcd</span>
        <script>
          w();
          window.stop();
          setTimeout(function () {
            var done = function (what) { L.push('later:' + what); document.title = 'done'; };
            new FontFace('N', 'url(#{shared})').load().then(function (f) { done(f.status); }, function (e) { done(e.name); });
          }, 800);
        </script>
      HTML
      # A canvas measuring a character a `unicode-range` face covers begins that face's load (Firefox, csim-bench rv `u2c`).
      '/canvas.html' => head + <<~HTML,
        <style>@font-face { font-family: U; src: url(#{font(300, 'han')}); unicode-range: U+4E00-4FFF }</style><span id="s">abcd</span>
        <script>
          var c = document.createElement('canvas').getContext('2d');
          c.font = '20px U';
          L.push('before:' + Array.from(document.fonts)[0].status);
          c.measureText('\u4e00');
          L.push('measured:' + Array.from(document.fonts)[0].status);
        </script>
      HTML
      # A page whose `pagehide` measures a `unicode-range` face's character, and the next page's unused face: no load of
      # the first page's asks reaches the second's list (csim-bench rv `wanted.rb`).
      '/leaving.html' => <<~HTML,
        <!DOCTYPE html><meta charset="utf-8"><style>@font-face { font-family: U; src: url(#{font(0)}); unicode-range: U+0-FF } @font-face { font-family: U; src: url(#{font(0)}); unicode-range: U+400-4FF }</style>
        <span style="font-family: U">ii</span><a href="/arriving.html">go</a>
        <script>addEventListener('pagehide', function () { var c = document.createElement('canvas').getContext('2d'); c.font = '20px U'; c.measureText('\u0434'); });</script>
      HTML
      '/arriving.html' => head + %(<style>@font-face { font-family: A; src: url(#{font(0)}) } @font-face { font-family: Q; src: url(#{font(1500)}) }</style><span id="s" style="font: 20px A, monospace">abcd</span>),
      # A preloaded face: the preload's response taken, the face's load completes as a task all the same.
      '/preload.html' => head + <<~HTML,
        <link rel="preload" as="font" crossorigin href="/slow/0/ahem.ttf?p"><style>@font-face { font-family: A; src: url(/slow/0/ahem.ttf?p) }</style>
        <span id="s" style="font: 20px A, monospace">abcd</span>
        <script>
          L.push('inline:' + Array.from(document.fonts)[0].status);
          setTimeout(function () { L.push('task:' + w() + ':' + Array.from(document.fonts)[0].status); }, 50);
        </script>
      HTML
      # A script's FontFace `load()`: `loading` until its download lands.
      '/script.html' => head + <<~HTML
        <span id="s" style="font: 20px B, monospace">abcd</span><script>
          var f = new FontFace('B', 'url(#{font(300)})');
          document.fonts.add(f);
          f.load().then(function () { L.push('loaded@' + t() + ':' + w()); });
          L.push('load():' + f.status + ':' + document.fonts.status + ':' + w());
        </script>
      HTML
    }
  end

  def visit(path)
    s = Capybara::Session.new(:simulated, app)
    s.visit "http://www.example.com#{path}"
    s
  end

  def log(s)
    s.evaluate_script('L')
  end

  # `event@T:width…` at `ms` on the clock — a little past it under load, the server's sleep overshooting — measured `width`
  # (any but the face's 80 for `:fallback`).
  def at(event, ms, width)
    times = (ms..ms + 200).step(50).to_a.join('|')
    width = width == :fallback ? '(?!80:)\\d+(?:\\.\\d+)?' : width.to_s
    /\A#{event}@(?:#{times}):#{width}/
  end

  it 'lays text out with the fallback while the face downloads, and with the face once it is in' do
    s = visit('/read.html')
    inline, task = log(s).values_at(0, 2)
    expect(inline).to match(/\Ainline:(\d+):loading:loading:false\z/)
    expect(inline[/\d+/].to_i).not_to eq(80)
    expect(task).to eq('task:loading')
    expect(log(s)).to include(at('load', 300, 80), at('ready', 300, 80), 'loadingdone:1')
  end

  it 'fires the document\'s load once the face its text uses is in' do
    s = visit('/quiet.html')
    expect(log(s)).to match(['dcl@0', at('load', 300, '80:loading')])
    expect(s.evaluate_script('document.fonts.status')).to eq('loaded')
    expect(log(visit('/unused.html'))).to match(['dcl@0', start_with('load@0:')])
  end

  it 'lays a face that failed out with the fallback, and reports it' do
    s = visit('/failed.html')
    expect(log(s)).to include(at('load', 300, :fallback), 'loadingerror:error')
  end

  it 'keeps the fallback where the face came in past its font-display periods' do
    expect(log(visit('/optional.html')).last).to match(at('load', 300, :fallback))
    expect(log(visit('/fallback.html')).last).to match(at('load', 3500, :fallback))
    expect(log(visit('/swap.html')).last).to match(at('load', 3500, 80))
  end

  it 'holds ready pending until the document is completely loaded' do
    expect(log(visit('/ready.html'))).to match(['dcl@0', end_with(':loaded'), 'ready'])
  end

  it 'downloads no face whose unicode-range covers none of the text' do
    s = visit('/ranges.html')
    expect(log(s).last).to match(at('load', 300, 80))
    expect(s.evaluate_script("Array.from(document.fonts).map(function (f) { return f.status; })")).to eq(%w[loaded unloaded])
    expect(requested).to eq(['ahem'])
  end

  it 'fails a face whose download the document\'s stop() cancelled, a task later' do
    s = visit('/stop.html')
    expect(log(s)).to include('stopped:loading', 'ready:error', 'loadingerror:1')
    expect(s.evaluate_script("document.fonts.status")).to eq('loaded')
    expect(s.evaluate_script('w()')).not_to eq(80)
  end

  it 'times a face\'s font-display periods from its load\'s beginning, its earlier sources\' downloads counted in' do
    expect(log(visit('/second.html')).last).to match(at('load', 3500, :fallback))
  end

  it 'loads no face that names the URL another face downloaded until text uses it' do
    s = visit('/shared.html')
    statuses = "Array.from(document.fonts).map(function (f) { return f.status; })"
    expect(log(s)).to include('loadingdone:1')
    expect(s.evaluate_script(statuses)).to eq(%w[loaded unloaded])
    expect(s.evaluate_script("document.fonts.check('20px B')")).to be(false)
    s.execute_script("var b = document.createElement('span'); b.style.font = '20px B'; b.textContent = 'x'; document.body.appendChild(b); b.offsetWidth;")
    s.evaluate_async_script('document.fonts.ready.then(function () { arguments[0](); }.bind(null, arguments[0]))')
    expect(s.evaluate_script(statuses)).to eq(%w[loaded loaded])
    expect(requested).to eq(['ahem'])
  end

  it 'starts no download of an unused face as another face\'s download of its URL lands' do
    s = visit('/unused-source.html')
    expect(log(s).last).to match(at('load', 300, 80))
    expect(s.evaluate_script("Array.from(document.fonts).map(function (f) { return f.status; })")).to eq(%w[loaded unloaded])
    expect(requested).to eq(['ahem'])
  end

  it 'downloads a URL a stop() cancelled again for a later load' do
    s = visit('/stop-again.html')
    expect(s).to have_title('done')
    expect(log(s)).to include('later:loaded')
  end

  it 'begins a unicode-range face\'s load as a canvas measures a character it covers' do
    expect(log(visit('/canvas.html'))).to start_with('before:unloaded', 'measured:loading')
  end

  it 'loads none of the faces a page that went asked for in the next page\'s list' do
    s = visit('/leaving.html')
    s.click_link 'go'
    expect(log(s).last).to match(at('load', 0, '80'))
    expect(s.evaluate_script("Array.from(document.fonts).map(function (f) { return f.status; })")).to eq(%w[loaded unloaded])
  end

  it 'completes a preloaded face\'s load as a task' do
    expect(log(visit('/preload.html'))).to include('inline:loading', 'task:80:loaded')
  end

  it 'keeps a script face loading until its download lands' do
    s = visit('/script.html')
    first = log(s).first
    expect(first).to match(/\Aload\(\):loading:loading:\d+\z/)
    expect(first[/\d+\z/].to_i).not_to eq(80)
    expect(log(s)).to include(at('loaded', 300, 80))
  end
end
