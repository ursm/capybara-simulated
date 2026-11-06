# frozen_string_literal: true

require 'capybara/simulated'
require 'tmpdir'
require_relative 'support/session_teardown'

# This user agent views PDFs inline: "PDF viewer supported" is implementation-defined (HTML §8.9.1.6), and Chrome and
# Firefox both have it — `navigator.pdfViewerEnabled` true, HTML's fixed plugin and MIME type lists. A PDF navigation
# makes its viewer's document — HTML "create a document for inline content that doesn't have a DOM": an empty
# `text/html` document at the PDF's URL, of a new opaque origin (Chrome reports `application/pdf` as its contentType; the
# spec's text is explicit) — and saves no file.
RSpec.describe 'the PDF viewer' do
  let(:session) do
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/f.pdf' then [200, {'content-type' => 'application/pdf', 'content-security-policy' => "script-src 'none'"}, ["%PDF-1.4\n"]]
      when '/sniffed' then [200, {}, ["%PDF-1.4\n"]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><title>start</title><a id=pdf href="/f.pdf" target=_blank>pdf</a><iframe src="/f.pdf"></iframe>']]
      end
    })
  end

  around do |example|
    Dir.mktmpdir do |dir|
      @downloads = dir
      prev = ENV['CSIM_DOWNLOADS_DIR']
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      example.run
    ensure
      ENV['CSIM_DOWNLOADS_DIR'] = prev
    end
  end

  it 'lists the PDF viewer plugins and MIME types, by index and by name' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const p = navigator.plugins, m = navigator.mimeTypes;
        return [
          navigator.pdfViewerEnabled, p.length, [...p].map((x) => x.name), p['Chrome PDF Viewer'] === p[1],
          p.namedItem('PDF Viewer') === p[0], Object.keys(p), Object.getOwnPropertyNames(p).length, 'WebKit built-in PDF' in p,
          m.length, m['text/pdf'] === m[1], m[0].enabledPlugin === p[0], p[2][0] === m[0], p[3]['application/pdf'] === m[0],
          [m[0].type, m[0].description, m[0].suffixes, p[0].filename], (() => { p['PDF Viewer'] = 1; return p['PDF Viewer'] === p[0]; })()
        ];
      })()
    JS
    expect(got).to eq([
      true, 5, ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'], true,
      true, %w[0 1 2 3 4], 10, true,
      2, true, true, true, true,
      ['application/pdf', 'Portable Document Format', 'pdf', 'internal-pdf-viewer'], true
    ])
  end

  it "makes a PDF's viewer document at its URL in a pop-up, a frame and the page" do
    session.visit '/'
    popup = session.window_opened_by { session.find('#pdf').click }
    session.within_window(popup) do
      expect(session.current_url).to eq('http://www.example.com/f.pdf')
      expect(session.evaluate_script('[document.contentType, origin, document.body ? document.body.childNodes.length : -1]')).to eq(['text/html', 'null', 0])
    end
    expect(session.evaluate_script("(() => { try { return frames[0].location.href } catch (e) { return e.name } })()")).to eq('SecurityError')
    session.visit '/sniffed'
    expect([session.current_url, session.evaluate_script('document.contentType'), session.response_headers['Content-Type']]).to eq(['http://www.example.com/sniffed', 'text/html', nil])
    expect(Dir.children(@downloads)).to eq([])
  end
end
