# frozen_string_literal: true
# Native layout — WEB FONT (@font-face) text, held to recorded goldens. Native declined text whose font had no
# fontations handle (system fonts only); now an @font-face family resolves to the decoded SFNT file the host
# hands it (font_file_for), so native (skrifa) reads that face's own hmtx advances and a web-font text block lays
# out rather than bailing.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/layout_golden'

RSpec.describe 'native layout web-font' do
  FONT_TTF   = File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))
  FONT_WOFF2 = File.binread(File.expand_path('fixtures/fonts/Ahem.woff2', __dir__))

  def page(body, font: FONT_TTF, ct: 'font/ttf', ext: 'ttf', face: "@font-face{font-family:'AhemTest';src:url('/f.#{ext}')}")
    html = <<~HTML
      <!doctype html><html><head>
      <style>#{face}</style>
      </head><body style="margin:0">#{body}</body></html>
    HTML
    Rack::Builder.new do
      run ->(env) {
        if env['PATH_INFO'] == "/f.#{ext}"
          [200, {'content-type' => ct, 'access-control-allow-origin' => '*'}, [font]]
        else
          [200, {'content-type' => 'text/html; charset=utf-8'}, [html]]
        end
      }
    end.to_app
  end

  def expect_layout(body, **opts)
    # (…the font options named by key and a digest of each value: `Hash#inspect` changed in Ruby 3.4, and a value holds
    # a whole font file.)
    variant = opts.empty? ? nil : opts.sort.map {|k, v| "#{k}=#{Digest::SHA256.hexdigest(v.to_s)[0, 12]}" }.join(',')
    expect_layout_golden(body, app: page(body, **opts), variant:)
  end

  it 'matches a single-line text block in a TTF web font' do
    expect_layout('<div style="width:400px;font:20px AhemTest">XXXX xxxx</div>')
  end
  it 'matches a WRAPPING text block in a TTF web font (advances drive the wrap)' do
    expect_layout('<div style="width:120px;font:20px AhemTest">XX xx word wrap onto more lines here now ok</div>')
  end
  it 'matches a text block in a WOFF2 web font (host Brotli-decodes it to the same SFNT)' do
    expect_layout('<div style="width:120px;font:20px AhemTest">XX xx word wrap onto more lines here now ok</div>', font: FONT_WOFF2, ct: 'font/woff2', ext: 'woff2')
  end
  it 'matches a web font alongside inline spans in the same family' do
    expect_layout('<div style="width:300px;font:16px AhemTest">a <b>bold</b> and <span>more</span> text</div>')
  end

  # A face that ALSO lists a local() source prefers a font INSTALLED under that name to the download, so native
  # registers the installed file where one is (`__csim_localFontFile`), the url's where none is. It declined outright until 2026-09-26, which was every text block on
  # every Mastodon page (`src: local("Roboto"), url(…)`).
  it 'measures a face carrying a local() source with the installed file, or the download' do
    # …no such font here: the download, Ahem's 20px squares
    body = '<div style="width:400px;font:20px MixFont"><span id="m">XXXX</span></div>'
    face = "@font-face{font-family:'MixFont';src:local('No Such Font Anywhere'),url('/f.ttf')}"
    expect_layout(body, face: face)
    session = simulated_session(page(body, face: face))
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('m').getBoundingClientRect().width")).to eq(80)
    # …and whatever this machine has installed under a common name
    expect_layout('<div style="width:120px;font:20px MixFont">aa bb cc dd ee ff gg</div>',
                  face: "@font-face{font-family:'MixFont';src:local('Arial'),local('Noto Sans'),url('/f.ttf')}")
  end

  # The native handle memo must invalidate when an @font-face is ADDED at runtime — otherwise native stays on
  # the stale system fallback the text was first measured in. With the face, the text is Ahem's 20px squares, wrapped
  # into four lines of the 120px block.
  it 'invalidates the native font handle when an @font-face is added at runtime' do
    session = simulated_session(page('<div style="width:120px;font:20px DynFont"><span id="m">aa bb cc dd ee ff gg</span></div>',
                                     face: '/* no DynFont face yet */'))
    session.visit '/'
    lines = "[...document.getElementById('m').getClientRects()].map((r) => [r.x, r.y, r.width, r.height])"
    ahem  = [[0, 0, 100, 20], [0, 20, 100, 20], [0, 40, 100, 20], [0, 60, 40, 20]]
    expect(session.evaluate_script(lines)).not_to eq(ahem)

    session.evaluate_script(<<~JS)
      const s = document.createElement('style');
      s.textContent = "@font-face{font-family:'DynFont';src:url('/f.ttf')}";
      document.head.appendChild(s);
      document.body.offsetHeight;
    JS
    expect(session.evaluate_script(lines)).to eq(ahem), 'a stale native font handle?'
    expect(session.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end
end
