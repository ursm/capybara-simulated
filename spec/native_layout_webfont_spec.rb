# frozen_string_literal: true
# Native layout — WEB FONT (@font-face) text, geometry shadow-parity. Native declined text whose font had no
# fontations handle (system fonts only); now an @font-face family resolves to the SAME decoded SFNT file the
# oracle measures advances from (the host's font_file_for), so native (skrifa) and the oracle read identical
# hmtx advances and a web-font text block lays out rather than bailing. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout web-font parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
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
          [200, {'content-type' => 'text/html'}, [html]]
        end
      }
    end.to_app
  end

  def run_shadow(body, **opts)
    session = simulated_session(page(body, **opts))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def expect_parity(body, **opts)
    r = run_shadow(body, **opts)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a single-line text block in a TTF web font' do
    expect_parity('<div style="width:400px;font:20px AhemTest">XXXX xxxx</div>')
  end
  it 'matches a WRAPPING text block in a TTF web font (advances drive the wrap)' do
    expect_parity('<div style="width:120px;font:20px AhemTest">XX xx word wrap onto more lines here now ok</div>')
  end
  it 'matches a text block in a WOFF2 web font (host Brotli-decodes it to the same SFNT)' do
    expect_parity('<div style="width:120px;font:20px AhemTest">XX xx word wrap onto more lines here now ok</div>', font: FONT_WOFF2, ct: 'font/woff2', ext: 'woff2')
  end
  it 'matches a web font alongside inline spans in the same family' do
    expect_parity('<div style="width:300px;font:16px AhemTest">a <b>bold</b> and <span>more</span> text</div>')
  end

  # A face that ALSO lists a local() source: the oracle prefers an installed local font over the download, so
  # native (which would register the url font) must decline rather than risk measuring the wrong font.
  it 'declines a face carrying a local() source alongside url()' do
    r = run_shadow('<div style="width:120px;font:20px MixFont">aa bb cc dd ee ff gg</div>',
                   face: "@font-face{font-family:'MixFont';src:local('Arial'),url('/f.ttf')}")
    expect(r).to include('ok' => false)
  end

  # The native handle memo must invalidate when an @font-face is ADDED at runtime — otherwise native stays on
  # the stale system fallback while the oracle switches to the web font.
  it 'invalidates the native font handle when an @font-face is added at runtime' do
    session = simulated_session(page('<div style="width:120px;font:20px DynFont">aa bb cc dd ee ff gg</div>',
                                     face: '/* no DynFont face yet */'))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    r1 = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(r1).to include('ok' => true), "harness bailed pre-add: #{r1.inspect}"
    expect(r1['mismatches']).to eq(0), "mismatch pre-add: #{r1.inspect}"

    session.evaluate_script(<<~JS)
      const s = document.createElement('style');
      s.textContent = "@font-face{font-family:'DynFont';src:url('/f.ttf')}";
      document.head.appendChild(s);
      document.body.offsetHeight;
    JS
    r2 = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(r2).to include('ok' => true), "harness bailed post-add: #{r2.inspect}"
    expect(r2['mismatches']).to eq(0), "mismatch post-add (stale native font handle?): #{r2.inspect}"
  end
end
