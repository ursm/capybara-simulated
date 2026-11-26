# frozen_string_literal: true

require 'capybara/simulated'
require 'securerandom'
require_relative 'support/session_teardown'

# A web font as CSS Font Loading loads it: its download begun the first time text needs the face (or a script asks),
# made in parallel — its server's time on the virtual clock — and landing as a task. Until then the text is laid out with
# the fallback (CSS Fonts 4 §4.9: whatever the `font-display`, a block period's text is invisible, not unmeasured), after
# it with the face — where it came within the face's block and swap periods. The document's `load` waits for it, and
# the FontFaceSet goes through its cycle: `loading` a task after layout began the load, `ready` pending until the
# document is completely loaded and nothing loads. Every figure here is Chrome's and Firefox's (csim-bench font7 probes).
RSpec.describe 'web fonts loading in parallel' do

  # (…Ahem's every glyph is one em wide: `abcd` at 20px is 80px with the face, something else with the fallback)
  def app
    ->(env) {
      if (m = env['PATH_INFO'].match(%r{\A/slow/(\d+)/(\w+)\.ttf\z}))
        sleep(m[1].to_i / 1000.0)
        next m[2] == 'ahem' ? [200, {'content-type' => 'font/ttf'}, [ahem]] : [404, {}, ['no']]
      end
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]]
    }
  end

  def ahem
    @ahem ||= File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))
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
    {
      # A script reads the text as it is parsed: the fallback, the face's download begun; the set `loading` a task later.
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
    expect(inline).to match(/\Ainline:(\d+):loaded:loading:false\z/)
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

  it 'keeps a script face loading until its download lands' do
    s = visit('/script.html')
    first = log(s).first
    expect(first).to match(/\Aload\(\):loading:loading:\d+\z/)
    expect(first[/\d+\z/].to_i).not_to eq(80)
    expect(log(s)).to include(at('loaded', 300, 80))
  end
end
