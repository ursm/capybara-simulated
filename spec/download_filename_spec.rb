# frozen_string_literal: true

require 'capybara/simulated'
require 'tmpdir'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# A download is saved under the filename its Content-Disposition gives (RFC 6266 §4.3, downloads.rs `filename`):
# `filename*`'s ext-value (RFC 8187, its charset's bytes percent-encoded) over `filename`, whose raw UTF-8 bytes are
# UTF-8 (Chrome) — they had been read each byte a code point (`café` saved as `cafÃ©`), `filename*` not decoded — and no
# directory of it — a `<a download>`'s too, whose header a Rack app tagged UTF-8 but whose bytes are none; one that names
# none — no header, or one of no filename — under its `download` value (HTML "download the hyperlink": the proposed
# filename where the response gives none), else its URL's last path segment.
RSpec.describe 'a download' do
  # (…a `data:` URL's its own bytes, decoded — no request made of it — under its `download` value)
  it 'saves a data: link under its download value' do
    requests = []
    s = simulated_session(lambda {|env|
      requests << env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><a href="data:text/csv,a%2Cb" download="x.csv">d</a>']]
    })
    s.visit '/'
    s.click_link 'd'
    expect([File.binread(File.join(@dir, 'x.csv')), requests]).to eq(['a,b', ['/']])
  end

  around do |example|
    Dir.mktmpdir do |dir|
      prev = ENV['CSIM_DOWNLOADS_DIR']
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      @dir = dir
      example.run
    ensure
      ENV['CSIM_DOWNLOADS_DIR'] = prev
    end
  end

  it "is saved under the name its Content-Disposition gives" do
    dispositions = {
      '/ext'  => %q{attachment; filename*=UTF-8''%C3%A9t%C3%A9.csv; filename="fallback.csv"},
      '/raw'  => "attachment; filename=\"caf\xC3\xA9.txt\"".b,
      '/path' => 'attachment; filename="../../escape.txt"',
      '/nul'  => %q{attachment; filename*=UTF-8''a%00b.txt; filename="plain.txt"},
      '/bad'  => "attachment; filename=\"bad\xE9.txt\"".dup.force_encoding('UTF-8'),
      '/att'  => 'attachment'
    }
    app = lambda {|env|
      next [200, {'content-type' => 'text/plain', 'content-disposition' => dispositions[env['PATH_INFO']]}, ['x']] if dispositions.key?(env['PATH_INFO'])
      # (…and one whose body the wire cut short is no download at all: Chrome fails it)
      next [200, {'content-type' => 'text/plain', 'content-disposition' => 'attachment; filename="cut.txt"', 'content-length' => '50'}, ['x']] if env['PATH_INFO'] == '/cut'
      next [200, {'content-type' => 'text/plain'}, ['x']] if env['PATH_INFO'].start_with?('/plain/')
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><a href="/ext">e</a><a href="/raw">r</a><a href="/path">p</a><a href="/nul">n</a><a href="/cut">c</a><a href="/bad" download>b</a>' \
                                               '<a href="/plain/x" download="mine.txt">h</a><a href="/plain/rep.csv" download>u</a>' \
                                               '<a href="/att" download="named.txt">a</a>']]
    }
    s = simulated_session(app)
    %w[e r p n c b h u a].each do |link|
      s.visit '/'
      s.click_link link
    end
    expect(Dir.children(@dir).sort).to eq(%w[badé.txt café.txt escape.txt mine.txt named.txt plain.txt rep.csv été.csv].sort)
  end

  # A navigation whose response downloads makes no document, so the window stays at the one it has: its URL, and its
  # session history, whose reload reloads that document (Chrome, measured: /a, /dl, then /a again) — for a form's POST
  # as for a GET.
  it 'leaves the window at its document, its URL and history, when a navigation downloads' do
    hits = []
    s = simulated_session(lambda {|env|
      hits << "#{env['REQUEST_METHOD']} #{env['PATH_INFO']}"
      next [200, {'content-type' => 'text/plain', 'content-disposition' => 'attachment; filename="d.txt"'}, ['x']] if env['PATH_INFO'] == '/dl'
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><form id=fm method=post action="/dl"></form>']]
    })
    s.visit '/a'
    hits.clear
    s.execute_script("location.href = '/dl'")
    s.evaluate_script('1')
    expect(s.current_path).to eq('/a')
    s.refresh
    s.execute_script("fm.submit()")
    s.evaluate_script('1')
    expect(s.current_path).to eq('/a')
    s.refresh
    expect(hits).to eq(['GET /dl', 'GET /a', 'POST /dl', 'GET /a'])
  end

  # …and one of no Content-Disposition nor `download` value under the last path segment of its response's URL — the one
  # its redirects led to (HTML "get the suggested filename": "Let filename be the … last path segment of response's
  # URL") — another origin's opaque response's too.
  it "is saved under its response's URL's name, where a redirect led it" do
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/page' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><a href="https://b.test/dl" download>other</a><a href="/dl" download>own</a>']]
      when '/dl'   then [302, {'location' => "/files/report-#{req.host[0]}.csv"}, ['']]
      else [200, {'content-type' => 'text/csv'}, ['a,b']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'https://a.test/page'
    s.click_link 'own'
    s.click_link 'other'
    expect(Dir.children(@dir).sort).to eq(%w[report-a.csv report-b.csv])
  end

  # (…a Content-Disposition of the `inline` type, or of none, no download for the filename it names: Chrome 156 and
  # Firefox 159 render `inline; filename=x.txt` and `filename=y.txt`, and download `foo; filename=z.txt` — RFC 6266
  # §4.2's unknown type, handled as `attachment`)
  it 'is no response whose disposition is inline, whatever filename it names' do
    s = simulated_session(lambda {|env|
      cd = {'/inline' => 'inline; filename=x.txt', '/bare' => 'filename=y.txt', '/foo' => 'foo; filename=z.txt'}[env['PATH_INFO']]
      next [200, {'content-type' => 'text/plain', 'content-disposition' => cd}, ["at #{env['PATH_INFO']}"]] if cd

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>start</title>']]
    })
    s.visit '/'
    s.visit '/inline'
    s.visit '/bare'
    s.visit '/foo'
    expect([s.current_path, s.text, Dir.children(@dir)]).to eq(['/bare', 'at /bare', ['z.txt']])
  end

  # (…a `blob:` link's as any other's: its `download` value a file's name alone — never a path out of the directory — and
  # none at all from a frame sandboxed without `allow-downloads`)
  it "names a blob: link's download as any other's, and refuses a sandboxed frame's" do
    s = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/' then '<iframe sandbox="allow-scripts" src="/framed"></iframe>'
             else ''
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    link = <<~JS
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['x'], {type: 'text/plain'}));
      a.download = '../escaped.txt';
      document.body.append(a);
      a.click();
    JS
    s.visit '/'
    s.within_frame(0) { s.execute_script(link) }
    s.evaluate_script('1')
    expect(Dir.children(@dir)).to eq([])
    s.execute_script(link)
    s.evaluate_script('1')
    expect([Dir.children(@dir), File.exist?(File.join(@dir, '..', 'escaped.txt'))]).to eq([['escaped.txt'], false])
  end

  # (…a navigation's response of a MIME type no document is made of a download with no Content-Disposition too, the page
  # staying at its document: HTML "loading a document" — Chrome and Firefox save `application/octet-stream` and
  # `application/zip`; mime.rs `makes_document`)
  it 'is a response of a type that makes no document' do
    s = simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/bin/blob.bin' then [200, {'content-type' => 'application/octet-stream'}, ['bytes']]
      when '/text.txt' then [200, {'content-type' => 'text/plain'}, ['text']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><title>page</title><a href="/bin/blob.bin">b</a><a href="/text.txt">t</a>']]
      end
    })
    s.visit '/'
    s.click_link 'b'
    expect([s.title, Dir.children(@dir), File.read(File.join(@dir, 'blob.bin'))]).to eq(['page', ['blob.bin'], 'bytes'])
    s.click_link 't'
    expect(s).to have_text('text')
  end
end
